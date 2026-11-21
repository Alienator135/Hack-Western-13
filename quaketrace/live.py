"""Keep Tiger Data current from the live USGS catalog.

Two feeds: every north-east US quake (M1.0+) and every quake worldwide (M4.5+).
Each run asks USGS for quakes with published phase data from a lookback window
before the newest quake Tiger already holds for that feed, up to now. Quakes
Tiger does not have yet are parsed and inserted into the hypertable in batches,
so a long backfill keeps its progress. The continuous aggregate is real-time,
so new picks show up in station health on the next query. The lookback catches
events whose phase data USGS publishes days after the quake.
"""

from __future__ import annotations

import json
import logging
import ssl
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from .history import MIN_MAGNITUDE, REGION, parse_event_picks
from .sources import USGS_DETAIL, product_url

logger = logging.getLogger(__name__)

CATALOG = "https://earthquake.usgs.gov/fdsnws/event/1/query"
HEADERS = {"User-Agent": "QuakeTrace/1.0 public-data history builder"}
MAX_EVENTS_PER_RUN = 300
FETCH_WORKERS = 4
BATCH = 40


@dataclass(frozen=True)
class Feed:
    name: str
    bounds: dict | None
    min_magnitude: float
    lookback_days: float
    first_days: float | None  # how far back to start when Tiger holds none of this feed yet


FEEDS = {
    "northeast": Feed("northeast", REGION, MIN_MAGNITUDE, 30, None),
    "world": Feed("world", None, 4.5, 7, 7),
}
LOOKBACK_DAYS = FEEDS["northeast"].lookback_days


def _tls_context() -> ssl.SSLContext:
    # python.org builds on macOS ship without root certificates; certifi supplies them.
    try:
        import certifi  # noqa: PLC0415
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


TLS = _tls_context()


def fetch(url: str, attempts: int = 7, timeout: float = 60) -> bytes:
    """GET a USGS URL, backing off on errors and honouring rate limits."""
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=timeout, context=TLS) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code == 404:
                raise
            if attempt == attempts - 1:
                raise
            delay = 1.5 * (attempt + 1)
            if isinstance(error, HTTPError) and error.code == 429:
                retry_after = error.headers.get("Retry-After", "")
                # USGS often sends no Retry-After; its limit resets after a minute or more.
                delay = float(retry_after) if retry_after.isdigit() else 30.0 * (attempt + 1)
            time.sleep(delay)
    raise RuntimeError("unreachable")


def catalog(start: str, end: str, minimum_magnitude: float, *, attempts: int = 7,
            bounds: dict | None = REGION) -> list[dict]:
    """Catalog features in the bounds (None: worldwide) and time window that have phase data."""
    query = urlencode({
        "format": "geojson", "eventtype": "earthquake", "orderby": "time-asc", "limit": 20000,
        "starttime": start, "endtime": end, "minmagnitude": minimum_magnitude, **(bounds or {}),
    })
    features = json.loads(fetch(f"{CATALOG}?{query}", attempts=attempts))["features"]
    return [row for row in features if "phase-data" in (row["properties"].get("types") or "")]


def phase_data_url(event_id: str, detail: dict) -> str | None:
    url = product_url(detail)
    if url:
        target = urlsplit(url)
        if target.scheme != "https" or target.netloc != "earthquake.usgs.gov":
            raise ValueError(f"{event_id}: unexpected phase-data host")
    return url


def load_event(feature: dict, *, attempts: int = 3):
    """Download and parse one catalog event; None when it has no usable phase data."""
    event_id = feature["id"]
    detail = json.loads(fetch(f"{USGS_DETAIL}/{event_id}.geojson", attempts=attempts, timeout=30))
    url = phase_data_url(event_id, detail)
    if not url:
        return None
    props = feature["properties"]
    return parse_event_picks(
        event_id, fetch(url, attempts=attempts, timeout=30),
        magnitude=props.get("mag"), place=props.get("place") or "",
    )


def _usgs_time(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")


def ingest(
    dsn: str, *, feed: str = "northeast", lookback_days: float | None = None, backfill_days: float | None = None,
    now: datetime | None = None, get_catalog=None, get_event=None, max_events: int | None = MAX_EVENTS_PER_RUN,
    progress=None,
) -> dict:
    """Add quakes USGS has published since Tiger's newest one for this feed. Returns a run summary.

    backfill_days starts the window that many days before now instead (to load
    history). Raises TigerDataError when Tiger is unreachable, or when the
    north-east feed has no seeded history. A USGS outage is logged in
    quaketrace.ingest_runs and reported in the summary instead.
    """
    from . import tiger  # noqa: PLC0415 - keeps psycopg optional for offline use

    spec = FEEDS[feed]
    lookback = spec.lookback_days if lookback_days is None else lookback_days
    get_catalog = get_catalog or (
        lambda start, end, minimum: catalog(start, end, minimum, attempts=5, bounds=spec.bounds)
    )
    get_event = get_event or load_event
    now = now or datetime.now(UTC)
    # Short connections around the USGS downloads, so a slow catch-up never holds
    # an idle Tiger connection that could drop and lose the downloaded work.
    with tiger.session(dsn, "Tiger Data live ingest") as connection:
        tiger.ensure_live_schema(connection)
        latest = tiger.latest_event_time(connection, spec.name)
    if backfill_days is not None:
        start = now - timedelta(days=backfill_days)
    elif latest is not None:
        start = min(latest, now) - timedelta(days=lookback)
    elif spec.first_days is not None:
        start = now - timedelta(days=spec.first_days)
    else:
        raise tiger.TigerDataError("Tiger Data has no history yet. Run scripts/tiger_data.py seed-history first.")
    added_events, skipped, checked, error, features = [], 0, 0, None, []
    new_events = new_picks = 0
    try:
        features = get_catalog(_usgs_time(start), _usgs_time(now), spec.min_magnitude)
        checked = len(features)
    except (OSError, ValueError, KeyError) as problem:
        error = f"USGS catalog request failed ({type(problem).__name__})."
    if features:
        with tiger.session(dsn, "Tiger Data live ingest") as connection:
            known = tiger.known_event_ids(connection, [feature["id"] for feature in features])
        fresh = [feature for feature in features if feature["id"] not in known]
        # Newest first: recent months matter most, and a cut-short backfill still has them.
        fresh = fresh[::-1] if max_events is None else fresh[::-1][:max_events]
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            for offset in range(0, len(fresh), BATCH):
                batch = fresh[offset:offset + BATCH]
                futures = {pool.submit(get_event, feature): feature["id"] for feature in batch}
                added = []
                for future in as_completed(futures):
                    try:
                        result = future.result()
                    except (OSError, ValueError, KeyError) as problem:
                        logger.warning("Skipped %s: %s", futures[future], type(problem).__name__)
                        skipped += 1
                        continue
                    if result and result[1]:
                        added.append(result)
                added.sort(key=lambda item: (item[0].event_time, item[0].event_id))
                if added:
                    with tiger.session(dsn, "Tiger Data live ingest") as connection:
                        events, picks = tiger.store_events(connection, added)
                        if events:
                            tiger.refresh_months(connection, added[0][0].event_time, added[-1][0].event_time)
                    new_events += events
                    new_picks += picks
                    added_events.extend(event for event, _ in added)
                if progress:
                    progress(min(offset + BATCH, len(fresh)), len(fresh), new_events, new_picks)
    with tiger.session(dsn, "Tiger Data live ingest") as connection:
        tiger.log_run(
            connection, region=spec.name, window_start=start, window_end=now, checked=checked,
            new_events=new_events, new_picks=new_picks, error=error,
        )
    tiger.invalidate_overview()
    return {
        "feed": spec.name, "windowStart": start.isoformat(), "windowEnd": now.isoformat(), "checked": checked,
        "newEvents": new_events, "newPicks": new_picks, "skipped": skipped, "error": error,
        "added": [
            {"id": event.event_id, "time": event.event_time.isoformat(), "magnitude": event.magnitude, "place": event.place}
            for event in added_events
        ],
    }
