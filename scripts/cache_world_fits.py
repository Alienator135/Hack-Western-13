"""Save each worldwide quake's untouched fit to fixtures/world_fits.json.

    python scripts/cache_world_fits.py

Needs Tiger Data (.env). Try any quake keeps only worldwide quakes whose
untouched readings fit the local model within 0.5 s; saving those fits means a
cold server skips several seconds of refitting. Rerun it now and then: quakes
added since are still fitted on the fly, just more slowly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quaketrace import benchmark as bm  # noqa: E402
from quaketrace import playground  # noqa: E402
from quaketrace.env import load_env  # noqa: E402


def main() -> None:
    load_env()
    _, _, source = playground.quakes()
    if source != "tiger":
        raise SystemExit("Tiger Data is not connected; set QUAKETRACE_TIGER_DSN in .env first.")
    fits = {
        event_id: [len(quake.station_ids), round(bm.LocalGrid(quake).fit(quake.times_s).rms_s, 4)]
        for event_id, quake in sorted(playground._cache["all_world"].items())
    }
    playground.WORLD_FITS_FILE.write_text(json.dumps(fits, separators=(",", ":")), encoding="utf-8")
    kept = sum(rms < playground.MAX_WORLD_RMS_S for _, rms in fits.values())
    print(f"Saved {len(fits)} worldwide fits to {playground.WORLD_FITS_FILE.name}; {kept} pass the 0.5 s rule.")


if __name__ == "__main__":
    main()
