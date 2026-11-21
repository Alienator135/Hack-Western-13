"""Relocate every eligible north-east quake with three methods and save fixtures/benchmark.json.

    python scripts/run_benchmark.py

Uses only the bundled history, so the result is reproducible offline. The
Benchmark tab reads the saved file; rerun this after changing the solver.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quaketrace.benchmark import run_benchmark
from quaketrace.data import DEFAULT_FIXTURES
from quaketrace.history import load_history

OUTPUT = DEFAULT_FIXTURES / "benchmark.json"


def main() -> int:
    started = time.perf_counter()

    def progress(done, total):
        if done % 100 == 0 or done == total:
            print(f"  {done}/{total} quakes", flush=True)

    result = run_benchmark(load_history(), progress=progress)
    OUTPUT.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT} in {time.perf_counter() - started:.0f} s")
    for shift, summary in result["summary"].items():
        line = " · ".join(f"{m} {summary[m]['median']:.2f} km (mean {summary[m]['mean']:.2f})" for m in ("naive", "weighted", "quaketrace"))
        extra = f"caught {summary['caught']:.0%}" if "caught" in summary else f"false flags {summary['falseFlags']:.0%}"
        print(f"  ±{float(shift):g} s: {line} · {extra} · QT better {summary['quaketraceBetter']}, worse {summary['quaketraceWorse']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
