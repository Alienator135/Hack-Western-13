"""Keep Tiger Data current from the live USGS catalog.

Each run asks USGS for north-east US earthquakes with published phase data from
a lookback window before the newest quake Tiger already holds, up to now. Quakes
Tiger does not have yet are parsed and inserted into the hypertable. The
continuous aggregate is real-time, so new picks show up in station health on
the next query. The lookback catches events whose phase data USGS publishes
days after the quake.
"""

from __future__ import annotations

import json
import logging
import ssl
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from .history import MIN_MAGNITUDE, REGION, parse_event_picks
from .sources import USGS_DETAIL, product_url

logger = logging.getLogger(__name__)

CATALOG = "https://earthquake.usgs.gov/fdsnws/event/1/query"
HEADERS = {"User-Agent": "QuakeTrace/1.0 public-data history builder"}
LOOKBACK_DAYS = 30
MAX_EVENTS_PER_RUN = 300
FETCH_WORKERS = 3


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
                delay = float(retry_after) if retry_after.isdigit() else 10.0 * (attempt + 1)
            time.sleep(delay)
    raise RuntimeError("unreachable")


def catalog(start: str, end: str, minimum_magnitude: float, *, attempts: int = 7) -> list[dict]:
    """Catalog features in the region and time window that have phase data."""
    query = urlencode({
        "format": "geojson", "eventtype": "earthquake", "orderby": "time-asc", "limit": 20000,
        "starttime": start, "endtime": end, "minmagnitude": minimum_magnitude, **REGION,
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
    dsn: str, *, lookback_days: float = LOOKBACK_DAYS, min_magnitude: float = MIN_MAGNITUDE,
    now: datetime | None = None, get_catalog=None, get_event=None, max_events: int = MAX_EVENTS_PER_RUN,
) -> dict:
    """Add quakes USGS has published since Tiger's newest one. Returns a run summary.

    Raises TigerDataError when Tiger is unreachable or not seeded. A USGS outage
    is recorded in quaketrace.ingest_runs and reported in the summary instead.
    """
    from . import tiger  # noqa: PLC0415 - keeps psycopg optional for offline use

    get_catalog = get_catalog or (lambda start, end, minimum: catalog(start, end, minimum, attempts=3))
    get_event = get_event or load_event
    now = now or datetime.now(UTC)
    # Short connections around the USGS downloads, so a slow catch-up never holds
    # an idle Tiger connection that could drop and lose the downloaded work.
    with tiger.session(dsn, "Tiger Data live ingest") as connection:
        tiger.ensure_live_schema(connection)
        latest = tiger.latest_event_time(connection)
    if latest is None:
        raise tiger.TigerDataError("Tiger Data has no history yet. Run scripts/tiger_data.py seed-history first.")
    start = min(latest, now) - timedelta(days=lookback_days)
    added, skipped, checked, error, features = [], 0, 0, None, []
    try:
        features = get_catalog(_usgs_time(start), _usgs_time(now), min_magnitude)
        checked = len(features)
    except (OSError, ValueError, KeyError) as problem:
        error = f"USGS catalog request failed ({type(problem).__name__})."
    if features:
        with tiger.session(dsn, "Tiger Data live ingest") as connection:
            known = tiger.known_event_ids(connection, [feature["id"] for feature in features])
        fresh = [feature for feature in features if feature["id"] not in known][:max_events]
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            futures = {pool.submit(get_event, feature): feature["id"] for feature in fresh}
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
    with tiger.session(dsn, "Tiger Data live ingest") as connection:
        new_events, new_picks = tiger.store_live(
            connection, added, window_start=start, window_end=now, checked=checked, error=error,
        )
    tiger.invalidate_overview()
    return {
        "windowStart": start.isoformat(), "windowEnd": now.isoformat(), "checked": checked,
        "newEvents": new_events, "newPicks": new_picks, "skipped": skipped, "error": error,
        "added": [
            {"id": event.event_id, "time": event.event_time.isoformat(), "magnitude": event.magnitude, "place": event.place}
            for event, _ in added
        ],
    }
