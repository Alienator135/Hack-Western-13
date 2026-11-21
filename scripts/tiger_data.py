"""Seed Tiger Data and verify the demo's station audit against its local fixture."""

import argparse
from os import getenv
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quaketrace.audit import audit
from quaketrace.data import AUDIT_STATIONS, EVALUATION_EVENTS, TIGER_DSN_ENV, WAVEFORM_STATION, load_fixture
from quaketrace.tiger import TigerDataError, read_demo_arrivals, seed_demo, weekly_station_history


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed", help="Create the hypertable and load the bundled arrivals")
    commands.add_parser("verify", help="Compare Tiger Data results with the bundled dataset")
    history = commands.add_parser("history", help="Show weekly event-centred residuals")
    history.add_argument("--station", choices=AUDIT_STATIONS, default=WAVEFORM_STATION)
    args = parser.parse_args()

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
