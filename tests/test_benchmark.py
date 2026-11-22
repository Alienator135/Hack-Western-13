from datetime import UTC, datetime
import json
import math
import unittest

import numpy as np

from quaketrace import benchmark as bm
from quaketrace.data import DEFAULT_FIXTURES, StationLocation
from quaketrace.history import load_history
from quaketrace.replay import DEPTH_KM, KM_PER_DEGREE, SPEED_KM_S, distance_km

EPICENTRE = (42.0, -73.0)
# Ring of stations 20-120 km from the epicentre.
OFFSETS_KM = [(30, 10), (-40, 25), (15, -50), (-20, -35), (70, 60), (-90, 5), (45, -95), (5, 110)]


def synthetic_quake() -> bm.Quake:
    lat0, lon0 = EPICENTRE
    km_lon = KM_PER_DEGREE * math.cos(math.radians(lat0))
    stations = tuple(StationLocation(lat0 + n / KM_PER_DEGREE, lon0 + e / km_lon) for e, n in OFFSETS_KM)
    times = np.array([math.sqrt(e * e + n * n + DEPTH_KM ** 2) / SPEED_KM_S for e, n in OFFSETS_KM])
    ids = tuple(f"XX.S{i}" for i in range(len(stations)))
    return bm.Quake("synthetic", datetime(2024, 1, 1, tzinfo=UTC), lat0, lon0, 3.0, "Test", ids, stations, times)


class BenchmarkTests(unittest.TestCase):
    def test_destination_travels_the_requested_distance_and_direction(self):
        lat, lon = bm._destination(42.0, -73.0, 1.0, 90.0)
        self.assertAlmostEqual(distance_km(StationLocation(42.0, -73.0), StationLocation(lat, lon)), KM_PER_DEGREE, delta=0.5)
        self.assertGreater(lon, -73.0)

    def test_clean_quake_is_located_by_every_method(self):
        quake = synthetic_quake()
        trial = bm.run_trial(quake, bm.LocalGrid(quake), 0.0, None)
        for method in bm.METHODS:
            self.assertLess(trial[method], 0.5, method)
        self.assertIsNone(trial["flagged"])

    def test_quaketrace_names_a_broken_clock_and_recovers_the_location(self):
        quake = synthetic_quake()
        trial = bm.run_trial(quake, bm.LocalGrid(quake), 5.0, 2)
        self.assertEqual(trial["flagged"], "XX.S2")
        self.assertGreater(trial["naive"], 3.0)
        self.assertLess(trial["quaketrace"], 0.5)
        self.assertLess(trial["quaketrace"], trial["naive"])

    def test_shared_leave_one_out_matches_separate_refits(self):
        quake = synthetic_quake()
        grid = bm.LocalGrid(quake)
        times = quake.times_s.copy()
        times[3] += 4.0
        shared = grid.fits_without_each(times)
        for index in range(len(times)):
            keep = np.ones(len(times), bool)
            keep[index] = False
            alone = grid.fit(times, keep)
            self.assertEqual((alone.east, alone.north), (shared[index].east, shared[index].north))
            self.assertAlmostEqual(alone.rms_s, shared[index].rms_s, places=9)
            self.assertAlmostEqual(alone.origin_s, shared[index].origin_s, places=9)

    def test_bundled_history_yields_hundreds_of_eligible_quakes(self):
        quakes = bm.benchmark_quakes(load_history())
        self.assertGreater(len(quakes), 500)
        self.assertTrue(all(len(q.station_ids) >= bm.MIN_STATIONS for q in quakes))

    def test_saved_results_match_the_page_contract(self):
        data = json.loads((DEFAULT_FIXTURES / "benchmark.json").read_text(encoding="utf-8"))
        self.assertEqual(list(data["summary"]), ["0", "1", "2", "3", "5"])
        for key, trials in data["trials"].items():
            self.assertEqual(len(trials), len(data["quakes"]), key)
        self.assertIn("falseFlags", data["summary"]["0"])
        self.assertIn("caught", data["summary"]["3"])


if __name__ == "__main__":
    unittest.main()
