import json
import os
import unittest
from unittest import mock

from quaketrace import playground
from quaketrace.data import TIGER_DSN_ENV

import server


def offline():
    """Run against the bundled history only, with a fresh quake cache."""
    playground._cache.update(at=0.0, quakes=None, live=set(), source="bundled")
    return mock.patch.dict(os.environ, {TIGER_DSN_ENV: ""})


class PlaygroundTests(unittest.TestCase):
    def setUp(self):
        self.env = offline()
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(playground._cache.update, at=0.0, quakes=None)

    def well_recorded(self):
        return next(row for row in playground.quake_list()["quakes"] if row["stations"] >= 8)

    def test_lists_every_benchmark_quake_newest_first(self):
        listing = playground.quake_list()
        self.assertEqual(listing["source"], "bundled")
        times = [row["time"] for row in listing["quakes"]]
        self.assertEqual(times, sorted(times, reverse=True))
        self.assertEqual(len(times), listing["benchmark"]["quakes"])
        self.assertTrue(all(row["stations"] >= 6 and not row["live"] for row in listing["quakes"]))

    def test_untouched_quake_is_located_near_usgs(self):
        result = playground.try_quake(self.well_recorded()["id"], None, 0.0)
        self.assertIsNone(result["scenario"]["station"])
        self.assertLess(result["naive"]["usgsKm"], 15)
        self.assertFalse(any(row["shifted"] for row in result["stations"]))

    def test_a_large_shift_is_named_and_measured(self):
        quake = self.well_recorded()
        clean = playground.try_quake(quake["id"], None, 0.0)
        station = next(row["id"] for row in clean["stations"] if not row["first"])
        result = playground.try_quake(quake["id"], station, 8.0)
        self.assertEqual(result["scenario"], {"station": station, "offsetS": 8.0})
        self.assertEqual(result["quaketrace"]["flagged"], station)
        self.assertAlmostEqual(result["quaketrace"]["foundOffsetS"], 8.0, delta=1.5)
        self.assertLessEqual(result["quaketrace"]["usgsKm"], result["naive"]["usgsKm"])

    def test_rejects_unknown_quakes_and_stations(self):
        with self.assertRaises(ValueError):
            playground.try_quake("nope", None, 0.0)
        with self.assertRaises(ValueError):
            playground.try_quake(self.well_recorded()["id"], "XX.NONE", 3.0)

    def test_server_routes(self):
        status, body, _ = server.respond("/api/quakes")
        self.assertEqual(status, 200)
        quake = json.loads(body)["quakes"][0]["id"]
        status, body, _ = server.respond(f"/api/try?event={quake}&offset=0")
        self.assertEqual(status, 200)
        self.assertIn("quaketrace", json.loads(body))
        self.assertEqual(server.respond("/api/try?event=../x&offset=0")[0], 400)
        self.assertEqual(server.respond(f"/api/try?event={quake}&offset=0.3")[0], 400)
        self.assertEqual(server.cache_policy("/api/try", 200), server.CACHE_LIVE)


if __name__ == "__main__":
    unittest.main()
