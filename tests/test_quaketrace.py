import hashlib
import json
import unittest
from dataclasses import replace

from quaketrace.audit import audit
from quaketrace.data import (
    AUDIT_STATIONS, BASELINE_EVENTS, DEFAULT_FIXTURES, EVALUATION_EVENTS, MAINSHOCK,
    WAVEFORM_STATION, load_fixture,
)
from quaketrace.replay import Reading, diagnose, distance_km
from scripts.fetch_fixtures import parse_quakeml, product_url

FIXTURE = load_fixture()


def demo_readings(station=None, offset=0):
    arrivals = [row for row in FIXTURE.arrivals if row.event_id == MAINSHOCK]
    origin = min(row.pick_time for row in arrivals)
    return tuple(
        Reading(
            row.station_id, FIXTURE.stations[(MAINSHOCK, row.station_id)],
            (row.pick_time - origin).total_seconds() + (offset if row.station_id == station else 0),
        )
        for row in arrivals
    )


class FixtureTests(unittest.TestCase):
    def test_fixture_integrity(self):
        manifest = json.loads((DEFAULT_FIXTURES / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(FIXTURE.events), 7)
        self.assertEqual(len(FIXTURE.waveform), 2500)
        self.assertEqual(len(FIXTURE.arrivals), 45)
        keys = {(row.event_id, row.station_id) for row in FIXTURE.arrivals}
        self.assertEqual(len(keys), 45)
        self.assertEqual(keys, FIXTURE.stations.keys())
        for name, expected in manifest["files"].items():
            self.assertEqual(hashlib.sha256((DEFAULT_FIXTURES / name).read_bytes()).hexdigest(), expected)

    def test_preferred_origin_phase_weight_and_pick_join(self):
        def arrival(pick, phase="Pg", weight=0.5):
            return f"""<arrival><pickID>{pick}</pickID><phase>{phase}</phase>
                <timeResidual>0.11</timeResidual><timeWeight>{weight}</timeWeight></arrival>"""

        def pick(name, seconds):
            return f"""<pick publicID="{name}"><time><value>2024-04-05T14:23:{seconds}Z</value></time>
                <waveformID networkCode="LD" stationCode="PAL" channelCode="HHZ"/></pick>"""

        xml = f"""<q:quakeml xmlns:q="urn:quakeml">
          <eventParameters xmlns="urn:bed"><event><preferredOriginID>preferred</preferredOriginID>
            <origin publicID="other">{arrival("unused", weight=1)}</origin>
            <origin publicID="preferred">
               <time><value>2024-04-05T14:23:20Z</value></time>
               <latitude><value>40.69</value></latitude>
               <longitude><value>-74.75</value></longitude>
               <depth><value>5000</value></depth>
               {arrival("winning", weight=0.8)}{arrival("later", weight=0.8)}
               {arrival("earlier", weight=0.7)}{arrival("unused", "Pn", 1)}
               {arrival("unused", weight=0)}{arrival("missing", weight=1)}
            </origin>
            {pick("winning", "33")}{pick("later", "34")}{pick("earlier", "32")}{pick("unused", "31")}
          </event></eventParameters>
        </q:quakeml>""".encode()
        event, rows = parse_quakeml(MAINSHOCK, xml, ("LD.PAL",))
        self.assertEqual(event["depth_km"], 5)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["pick_time"], "2024-04-05T14:23:33+00:00")
        self.assertEqual(rows[0]["location_code"], "--")
        with self.assertRaisesRegex(ValueError, "missing valid Pg arrivals"):
            parse_quakeml(MAINSHOCK, xml, ("LD.PAL", "LD.FOR"))

    def test_product_prefers_active_high_weight_then_update_time(self):
        def phase(url, weight, update, status="UPDATE"):
            return {
                "status": status, "preferredWeight": weight, "updateTime": update,
                "contents": {"quakeml.xml": {"url": url}},
            }

        detail = {"properties": {"products": {"phase-data": [
            phase("deleted", 100, 10, "DELETE"), phase("low", 1, 10),
            phase("old", 2, 10), phase("selected", 2, 11),
        ]}}}
        self.assertEqual(product_url(detail), "selected")


class ReplayTests(unittest.TestCase):
    def test_clean_mainshock(self):
        result = diagnose(demo_readings())
        self.assertIsNone(result.candidate)
        self.assertLess(distance_km(result.all_stations.location, FIXTURE.events[MAINSHOCK]), 4)

    def test_positive_and_negative_clock_errors(self):
        for offset in (5, -5):
            with self.subTest(offset=offset):
                result = diagnose(demo_readings(WAVEFORM_STATION, offset))
                self.assertEqual(result.status, "flagged")
                self.assertEqual(result.candidate.station_id, WAVEFORM_STATION)
                self.assertAlmostEqual(result.candidate.offset_s, offset, delta=0.5)
                catalog = FIXTURE.events[MAINSHOCK]
                self.assertLess(distance_km(result.candidate.fit.location, catalog), 4)
                if offset > 0:
                    self.assertGreater(distance_km(result.all_stations.location, catalog), 8)

    def test_missing_readings(self):
        readings = demo_readings(WAVEFORM_STATION, 5)
        self.assertEqual(diagnose(readings[:4]).status, "insufficient")
        self.assertEqual(diagnose(readings[:-1]).candidate.station_id, WAVEFORM_STATION)

    def test_competing_arrival_errors_abstain(self):
        readings = demo_readings()
        first, second, *others = readings
        result = diagnose((
            replace(first, time_s=first.time_s + 4),
            replace(second, time_s=second.time_s - 4),
            *others,
        ))
        self.assertEqual(result.status, "inconclusive")


class AuditTests(unittest.TestCase):
    def test_clean_events(self):
        results = audit(FIXTURE.arrivals)
        self.assertEqual(set(results), set(AUDIT_STATIONS))
        self.assertTrue(all(result.status == "clear" for result in results.values()))

    def test_persistent_signed_shifts(self):
        for shift in (3, -3):
            with self.subTest(shift=shift):
                results = audit(
                    FIXTURE.arrivals, shifted_station=WAVEFORM_STATION,
                    onset_event=EVALUATION_EVENTS[1], offset_s=shift,
                )
                result = results[WAVEFORM_STATION]
                self.assertEqual(result.first_suspicious_event, EVALUATION_EVENTS[1])
                self.assertEqual(result.confirming_event, EVALUATION_EVENTS[2])
                self.assertEqual(result.last_normal_event, EVALUATION_EVENTS[0])
                self.assertEqual(result.supporting_events, EVALUATION_EVENTS[1:])
                self.assertAlmostEqual(result.estimated_offset_s, shift, delta=0.4)
                self.assertEqual([station for station, row in results.items() if row.status == "flagged"],
                                 [WAVEFORM_STATION])

    def test_single_and_opposite_sign_readings_do_not_confirm(self):
        for offsets in ((3,), (3, -3)):
            with self.subTest(offsets=offsets):
                changes = dict(zip(EVALUATION_EVENTS[1:], offsets))
                rows = tuple(
                    replace(row, residual_s=row.residual_s + changes.get(row.event_id, 0))
                    if row.station_id == WAVEFORM_STATION else row for row in FIXTURE.arrivals
                )
                self.assertIsNone(audit(rows)[WAVEFORM_STATION].confirming_event)

    def test_gaps_and_last_event_can_leave_an_alert_pending(self):
        for gap in (False, True):
            with self.subTest(gap=gap):
                rows = tuple(
                    row for row in FIXTURE.arrivals
                    if not (gap and row.event_id == EVALUATION_EVENTS[2] and row.station_id == WAVEFORM_STATION)
                )
                onset = EVALUATION_EVENTS[1] if gap else EVALUATION_EVENTS[-1]
                result = audit(rows, shifted_station=WAVEFORM_STATION, onset_event=onset, offset_s=3)[WAVEFORM_STATION]
                self.assertEqual(result.status, "pending")
                self.assertIsNone(result.confirming_event)

    def test_incomplete_baseline(self):
        rows = tuple(
            row for row in FIXTURE.arrivals
            if (row.event_id, row.station_id) != (BASELINE_EVENTS[1], WAVEFORM_STATION)
        )
        self.assertEqual(audit(rows)[WAVEFORM_STATION].status, "insufficient")
