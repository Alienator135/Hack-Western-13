"""Download north-east US earthquake arrival history from USGS into fixtures/history.

Raw responses are cached under fixtures/raw/history (gitignored), so reruns only
fetch what is missing. The output is the compact bundle Tiger Data is seeded from.

    python scripts/fetch_history.py                     # 2018-2025, M1.0+
    python scripts/fetch_history.py --start 2024-01-01 --end 2025-01-01
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quaketrace.data import DEFAULT_FIXTURES
from quaketrace.history import (
    DEFAULT_END, DEFAULT_START, HISTORY_DIR, MIN_MAGNITUDE, REGION, parse_event_picks, write_history,
)
from quaketrace.sources import USGS_DETAIL, product_url

CATALOG = "https://earthquake.usgs.gov/fdsnws/event/1/query"
RAW_DIR = DEFAULT_FIXTURES / "raw" / "history"
HEADERS = {"User-Agent": "QuakeTrace/1.0 public-data history builder"}


def fetch(url: str, attempts: int = 7) -> bytes:
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=60) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code == 404:
                raise
            if attempt == attempts - 1:
                raise
            delay = 1.5 * (attempt + 1)
            if isinstance(error, HTTPError) and error.code == 429:
                # USGS rate limit: honour Retry-After, otherwise back off hard.
                retry_after = error.headers.get("Retry-After", "")
                delay = float(retry_after) if retry_after.isdigit() else 10.0 * (attempt + 1)
            time.sleep(delay)
    raise RuntimeError("unreachable")


def cached(path: Path, url: str) -> bytes:
    if path.is_file() and path.stat().st_size:
        return path.read_bytes()
    content = fetch(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_bytes(content)
    temporary.replace(path)
    return content


def catalog(start: str, end: str, minimum_magnitude: float) -> list[dict]:
    query = urlencode({
        "format": "geojson", "eventtype": "earthquake", "orderby": "time-asc", "limit": 20000,
        "starttime": start, "endtime": end, "minmagnitude": minimum_magnitude, **REGION,
    })
    features = json.loads(fetch(f"{CATALOG}?{query}"))["features"]
    return [row for row in features if "phase-data" in (row["properties"].get("types") or "")]


def load_event(feature: dict):
    event_id = feature["id"]
    detail = json.loads(cached(RAW_DIR / f"{event_id}.geojson", f"{USGS_DETAIL}/{event_id}.geojson"))
    url = product_url(detail)
    if not url:
        return None
    target = urlsplit(url)
    if target.scheme != "https" or target.netloc != "earthquake.usgs.gov":
        raise ValueError(f"{event_id}: unexpected phase-data host")
    content = cached(RAW_DIR / f"{event_id}.quakeml.xml", url)
    props = feature["properties"]
    return parse_event_picks(event_id, content, magnitude=props.get("mag"), place=props.get("place") or "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    parser.add_argument("--min-magnitude", type=float, default=MIN_MAGNITUDE)
    parser.add_argument("--output", type=Path, default=HISTORY_DIR)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()

    features = catalog(args.start, args.end, args.min_magnitude)
    print(f"{len(features)} catalog events with phase data, {args.start} to {args.end}", flush=True)
    events, picks, failures = [], [], []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(load_event, feature): feature["id"] for feature in features}
        for done, future in enumerate(as_completed(futures), 1):
            event_id = futures[future]
            try:
                result = future.result()
            except (OSError, ValueError, KeyError) as error:
                failures.append(f"{event_id}: {type(error).__name__}: {error}")
                continue
            if result is None:
                continue
            event, rows = result
            events.append(event)
            picks.extend(rows)
            if done % 50 == 0 or done == len(futures):
                print(f"  {done}/{len(futures)} events · {len(picks):,} picks", flush=True)
    write_history(args.output, events, picks)
    stations = len({row.station_id for row in picks})
    print(f"Wrote {len(events)} events, {len(picks):,} picks, {stations} stations to {args.output}")
    for failure in failures:
        print(f"skipped {failure}", file=sys.stderr)
    return 0 if events else 1


if __name__ == "__main__":
    sys.exit(main())
