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
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quaketrace.data import DEFAULT_FIXTURES
from quaketrace.history import DEFAULT_END, DEFAULT_START, HISTORY_DIR, MIN_MAGNITUDE, parse_event_picks, write_history
from quaketrace.live import catalog, fetch, phase_data_url
from quaketrace.sources import USGS_DETAIL

RAW_DIR = DEFAULT_FIXTURES / "raw" / "history"


def cached(path: Path, url: str) -> bytes:
    if path.is_file() and path.stat().st_size:
        return path.read_bytes()
    content = fetch(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_bytes(content)
    temporary.replace(path)
    return content


def load_event(feature: dict):
    event_id = feature["id"]
    detail = json.loads(cached(RAW_DIR / f"{event_id}.geojson", f"{USGS_DETAIL}/{event_id}.geojson"))
    url = phase_data_url(event_id, detail)
    if not url:
        return None
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
