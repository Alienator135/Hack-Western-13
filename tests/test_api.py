import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

import server
from quaketrace import api
from quaketrace.data import EVALUATION_EVENTS, MAINSHOCK, load_fixture


class ApiPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = load_fixture(use_tiger=False)

    def test_replay_payload_reproduces_the_mainshock_scenario(self):
        payload = api.replay(self.fixture, MAINSHOCK, "LD.PAL", 5.0)
        json.dumps(payload)  # Must be plain JSON.
        self.assertEqual(payload["status"], "flagged")
        self.assertEqual(payload["candidate"]["station"], "LD.PAL")
        self.assertTrue(payload["candidate"]["correct"])
        self.assertAlmostEqual(payload["candidate"]["offsetS"], 4.96, places=2)
        self.assertAlmostEqual(payload["usgsKm"]["all"], 9.27, places=2)
        self.assertAlmostEqual(payload["usgsKm"]["excluded"], 2.79, places=2)
        self.assertAlmostEqual(payload["usgsKm"]["clean"], 2.48, places=2)
        self.assertGreater(payload["movedKm"], 5)
        self.assertGreater(payload["zoneRatio"], 1)
        self.assertEqual(len(payload["runs"]), 9)
        self.assertEqual(payload["runs"][0]["station"], "LD.PAL")
        zone = payload["tampered"]["zone"]
        self.assertEqual(len(zone["excess"]), zone["cols"] * zone["rows"])
        self.assertGreaterEqual(len(zone["hull"]), 3)

    def test_clean_replay_has_no_candidate_and_no_movement(self):
        payload = api.replay(self.fixture, MAINSHOCK, None, 0.0)
        self.assertIsNone(payload["candidate"])
        self.assertIsNone(payload["scenario"]["station"])
        self.assertEqual(payload["movedKm"], 0)
        for station in payload["stations"]:
            self.assertEqual(station["arrivalS"], station["tamperedArrivalS"])

    def test_travel_points_mark_the_suspect_late_by_its_offset(self):
        payload = api.replay(self.fixture, MAINSHOCK, "LD.PAL", 5.0)
        point = next(p for p in payload["travel"]["points"] if p["station"] == "LD.PAL")
        self.assertAlmostEqual(point["timeS"] - point["predictedS"], payload["candidate"]["offsetS"], places=2)

    def test_replay_rejects_bad_inputs(self):
        with self.assertRaises(ValueError):
            api.replay(self.fixture, "nope", None, 0.0)
        with self.assertRaises(ValueError):
            api.replay(self.fixture, MAINSHOCK, "LD.PAL", 99.0)
        with self.assertRaises(ValueError):
            api.replay(self.fixture, "us6000mvg6", "PE.PAPL", 3.0)

    def test_audit_view_flags_the_example(self):
        payload = api.audit_view(self.fixture, "LD.PAL", EVALUATION_EVENTS[1], 3.0)
        self.assertEqual(payload["flagged"], ["LD.PAL"])
        pal = next(row for row in payload["stations"] if row["station"] == "LD.PAL")
        self.assertEqual(pal["firstSuspicious"], EVALUATION_EVENTS[1])
        self.assertEqual(pal["confirming"], EVALUATION_EVENTS[2])
        self.assertEqual(pal["lastNormal"], EVALUATION_EVENTS[0])
        self.assertAlmostEqual(pal["estimatedOffsetS"], 2.88, places=2)
        self.assertEqual(pal["simulated"], [False, False, False, False, True, True, True])

    def test_waveform_is_downsampled_with_pick(self):
        wave = api.waveform(self.fixture)
        self.assertLessEqual(len(wave["trace"]), 720)
        self.assertGreater(wave["pickS"], 5)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, path):
        with urlopen(self.base + path, timeout=30) as response:
            return response.status, response.headers.get("Content-Type"), response.read()

    def test_serves_the_page_and_api(self):
        status, content_type, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", content_type)
        self.assertIn(b"QuakeTrace", body)
        status, _, body = self.get(f"/api/replay?event={MAINSHOCK}&station=LD.PAL&offset=5")
        self.assertEqual(json.loads(body)["candidate"]["station"], "LD.PAL")
        status, _, body = self.get("/api/overview")
        self.assertEqual(len(json.loads(body)["events"]), 7)

    def test_config_exposes_the_maps_key_from_the_environment(self):
        with patch.dict("os.environ", {server.GOOGLE_KEY_ENV: "test-key"}):
            _, _, body = self.get("/api/config")
        self.assertEqual(json.loads(body)["googleMapsKey"], "test-key")

    def test_errors_are_json_and_paths_cannot_escape_web_root(self):
        for path, code in (("/api/replay?offset=abc", 400), ("/api/missing", 404), ("/..%2Fserver.py", 404)):
            with self.assertRaises(HTTPError) as caught:
                self.get(path)
            self.assertEqual(caught.exception.code, code)
            self.assertIn("error", json.loads(caught.exception.read()))


if __name__ == "__main__":
    unittest.main()
