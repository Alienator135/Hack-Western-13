"""Seed Tiger Data and verify the demo's station audit against its local fixture."""

import argparse
from os import getenv
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import time

from quaketrace.api import history_view
from quaketrace.audit import audit
from quaketrace.env import load_env
from quaketrace.history import history_available, load_history
from quaketrace.live import BATCH, FEEDS, MAX_EVENTS_PER_RUN, ingest
from quaketrace.data import AUDIT_STATIONS, EVALUATION_EVENTS, TIGER_DSN_ENV, WAVEFORM_STATION, load_fixture
from quaketrace.tiger import (
    TigerDataError, read_demo_arrivals, seed_demo, seed_history, weekly_station_history,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed", help="Create the hypertable and load the bundled arrivals")
    commands.add_parser("verify", help="Compare Tiger Data results with the bundled dataset")
    history = commands.add_parser("history", help="Show weekly event-centred residuals")
    history.add_argument("--station", choices=AUDIT_STATIONS, default=WAVEFORM_STATION)
    seed_history_parser = commands.add_parser(
        "seed-history",
        help="Load fixtures/history (years of USGS picks) into a compressed hypertable with a monthly aggregate",
    )
    seed_history_parser.add_argument(
        "--rebuild", action="store_true",
        help="Drop and recreate quaketrace.picks, quaketrace.events and quaketrace.station_monthly first "
             "so the current chunk and compression settings apply. The demo arrivals table is kept.",
    )
    ingest_parser = commands.add_parser("ingest", help="Add quakes USGS published since Tiger's newest one")
    ingest_parser.add_argument("--feed", choices=(*FEEDS, "all"), default="all",
                               help="northeast (M1.0+), world (M4.5+), or both (default)")
    ingest_parser.add_argument("--lookback-days", type=float,
                               help="Recheck this many days before the newest quake (late phase data)")
    ingest_parser.add_argument("--backfill-days", type=float,
                               help="Load every quake from this many days ago, e.g. 365 for a year of world data")
    ingest_parser.add_argument("--min-magnitude", type=float,
                               help="Only load quakes at or above this magnitude, e.g. 5.5 for a lighter world backfill")
    ingest_parser.add_argument("--watch", type=float, metavar="MINUTES",
                               help="Keep running, checking USGS every MINUTES")
    health = commands.add_parser("health", help="Query monthly station clock health from Tiger Data")
    health.add_argument("--station", help="Inject a clock shift into this station's history")
    health.add_argument("--onset", help="Date the injected shift starts, e.g. 2024-04-27")
    health.add_argument("--offset", type=float, default=0.0, help="Injected shift in seconds")
    args = parser.parse_args()
    load_env()

    dsn = getenv(TIGER_DSN_ENV)
    if not dsn:
        parser.error(f"Set {TIGER_DSN_ENV} to the Tiger Data PostgreSQL connection string.")
    fixture = load_fixture(use_tiger=False)
    try:
        if args.command == "seed":
            inserted = seed_demo(dsn, fixture)
            print(f"Seeded {inserted} new arrivals for the {len(fixture.arrivals)}-arrival demo revision.")
        elif args.command == "verify":
            arrivals = read_demo_arrivals(dsn, fixture)
            if arrivals != fixture.arrivals:
                raise TigerDataError("Tiger Data arrivals differ from the bundled arrivals.")
            scenario = {
                "shifted_station": WAVEFORM_STATION, "onset_event": EVALUATION_EVENTS[1], "offset_s": 3.0,
            }
            result = audit(arrivals, **scenario)[WAVEFORM_STATION]
            if result.status != "flagged":
                raise TigerDataError("The reference Palisades audit did not flag a sustained shift.")
            print(f"Verified {len(arrivals)} arrivals from Tiger Data against the local fixture.")
            print(
                f"{WAVEFORM_STATION}: first suspicious {fixture.events[result.first_suspicious_event].time:%Y-%m-%d}, "
                f"confirmed {fixture.events[result.confirming_event].time:%Y-%m-%d}, "
                f"estimated offset {result.estimated_offset_s:+.2f} s."
            )
        elif args.command == "seed-history":
            if not history_available():
                raise TigerDataError("fixtures/history is missing. Run scripts/fetch_history.py first.")
            bundle = load_history()
            if args.rebuild:
                print("Rebuilding: dropping quaketrace.picks, quaketrace.events and quaketrace.station_monthly...")
            summary = seed_history(dsn, bundle.events, bundle.picks, rebuild=args.rebuild)
            print(
                f"Loaded {summary['inserted_picks']:,} new picks. Tiger now holds {summary['picks']:,} picks from "
                f"{summary['events']:,} quakes at {summary['stations']:,} stations "
                f"({summary['first'][:10]} to {summary['last'][:10]})."
            )
            ratio = f", {summary['compressionRatio']}x smaller" if summary.get("compressionRatio") else ""
            print(
                f"Hypertable chunks: {summary['chunks']} ({summary['compressedChunks']} compressed{ratio}). "
                "Continuous aggregate quaketrace.station_monthly refreshed."
            )
            if not args.rebuild and (summary.get("compressionRatio") or 0) < 1.5 and summary.get("compressedChunks"):
                print("Compression is barely saving space. Run seed-history --rebuild to apply the current settings.")
        elif args.command == "ingest":
            feeds = list(FEEDS) if args.feed == "all" else [args.feed]

            def progress(done, total, events, picks):
                if total > BATCH:
                    print(f"    {done:,}/{total:,} downloaded · {events:,} quakes, {picks:,} picks saved", flush=True)

            while True:
                for feed in feeds:
                    summary = ingest(
                        dsn, feed=feed, lookback_days=args.lookback_days, backfill_days=args.backfill_days,
                        max_events=None if args.backfill_days else MAX_EVENTS_PER_RUN, progress=progress,
                        min_magnitude=args.min_magnitude,
                    )
                    print(
                        f"{feed}: checked {summary['checked']:,} USGS quakes from {summary['windowStart'][:10]} to "
                        f"{summary['windowEnd'][:16]}Z · added {summary['newEvents']:,} quakes, {summary['newPicks']:,} picks.",
                        flush=True,
                    )
                    for event in summary["added"][-10:]:
                        magnitude = f"M{event['magnitude']:.1f}" if event["magnitude"] is not None else "M?"
                        print(f"  + {event['time'][:16]}Z {magnitude:<5} {event['place']}  ({event['id']})")
                    if len(summary["added"]) > 10:
                        print(f"  ... and {len(summary['added']) - 10:,} earlier")
                    if summary["error"]:
                        print(summary["error"], file=sys.stderr)
                if not args.watch:
                    break
                args.backfill_days = None
                time.sleep(args.watch * 60)
        elif args.command == "health":
            started = time.perf_counter()
            view = history_view(args.station, args.onset, args.offset)
            if view.get("source") != "tiger":
                raise TigerDataError(view.get("note") or "Tiger Data did not answer the history query.")
            print(
                f"{view['stats']['picks']:,} picks · {view['stats']['events']:,} quakes · from the {view['query']} "
                f"in {(time.perf_counter() - started) * 1000:.0f} ms"
            )
            for row in view["stations"]:
                detail = (
                    f"first off {row['firstFlag'][:7]}, confirmed {row['confirmed'][:7]}, {row['estimatedOffsetS']:+.2f} s"
                    if row["status"] == "flagged" else row["status"]
                )
                print(f"  {row['station']:<10} {row['picks']:>6,} picks  {detail}")
        else:
            print(f"{args.station} · median event-centred Pg residual by UTC week")
            for week, events, residual in weekly_station_history(dsn, fixture, args.station):
                print(f"{week:%Y-%m-%d}  {events:>2} event(s)  {residual:+.3f} s")
    except TigerDataError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
