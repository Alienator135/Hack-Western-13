import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

from quaketrace.history import (
    Bucket, HistoryEvent, HistoryPick, assess, history_available, load_history, local_monthly_buckets,
    parse_event_picks, write_history,
)
from quaketrace.tiger import seed_history

QUAKEML = b"""<?xml version="1.0"?>
<q:quakeml xmlns:q="http://quakeml.org/xmlns/quakeml/1.2" xmlns="http://quakeml.org/xmlns/bed/1.2">
 <eventParameters>
  <event publicID="e1">
   <preferredOriginID>o1</preferredOriginID>
   <pick publicID="p1"><time><value>2024-04-27T10:00:12.5Z</value></time>
     <waveformID networkCode="LD" stationCode="PAL" locationCode="00" channelCode="HHZ"/></pick>
   <pick publicID="p2"><time><value>2024-04-27T10:00:12.9Z</value></time>
     <waveformID networkCode="LD" stationCode="PAL" locationCode="00" channelCode="HHN"/></pick>
   <pick publicID="p3"><time><value>2024-04-27T10:00:15.0Z</value></time>
     <waveformID networkCode="N4" stationCode="L59A" locationCode="" channelCode="HHZ"/></pick>
   <origin publicID="o1">
    <time><value>2024-04-27T10:00:00Z</value></time>
    <latitude><value>40.7</value></latitude><longitude><value>-74.7</value></longitude>
    <depth><value>5000</value></depth>
    <arrival><pickID>p1</pickID><phase>Pg</phase><timeResidual>0.2</timeResidual><timeWeight>1.1</timeWeight><distance>0.7</distance><azimuth>60</azimuth></arrival>
    <arrival><pickID>p2</pickID><phase>Pg</phase><timeResidual>0.6</timeResidual><timeWeight>0.4</timeWeight></arrival>
    <arrival><pickID>p3</pickID><phase>Pn</phase><timeResidual>-0.3</timeResidual><timeWeight>0</timeWeight></arrival>
    <arrival><pickID>missing</pickID><phase>Pg</phase><timeResidual>0.1</timeResidual></arrival>
   </origin>
  </event>
 </eventParameters>
</q:quakeml>"""


def pick(month: int, station: str, residual: float, day: int = 10) -> HistoryPick:
    time = datetime(2024, month, day, tzinfo=UTC)
    return HistoryPick(time, f"e{month}{day}{station}", station, "--", "HHZ", "Pg", time, residual, 1.0, None, None)


class HistoryTests(unittest.TestCase):
    def test_parses_every_arrival_keeping_the_heaviest_per_station_phase(self):
        event, picks = parse_event_picks("e1", QUAKEML, magnitude=2.1, place="NJ")
        self.assertEqual(event.depth_km, 5.0)
        self.assertEqual(event.magnitude, 2.1)
        self.assertEqual([(row.station_id, row.phase) for row in picks], [("LD.PAL", "Pg"), ("N4.L59A", "Pn")])
        pal = picks[0]
        self.assertEqual((pal.channel_code, pal.residual_s, pal.distance_deg), ("HHZ", 0.2, 0.7))
        self.assertEqual(picks[1].location_code, "--")
        self.assertEqual(picks[1].weight, 0.0)

    def test_bundle_round_trips(self):
        event, picks = parse_event_picks("e1", QUAKEML, magnitude=None, place="")
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            write_history(folder, [event], picks)
            self.assertTrue(history_available(folder))
            loaded = load_history(folder)
        self.assertEqual(loaded.events, (event,))
        self.assertEqual(loaded.picks, tuple(picks))

    def test_monthly_buckets_apply_an_injected_shift_from_its_onset(self):
        event = HistoryEvent("x", datetime(2024, 1, 1, tzinfo=UTC), 0, 0, 0, None, "")
        picks = [pick(3, "LD.PAL", 0.1), pick(4, "LD.PAL", 0.1, 1), pick(4, "LD.PAL", 0.3, 28), pick(4, "PE.PSUB", 0.0)]
        from quaketrace.history import History
        buckets = local_monthly_buckets(
            History((event,), tuple(picks)), shifted_station="LD.PAL",
            onset=datetime(2024, 4, 15, tzinfo=UTC), offset_s=3.0,
        )
        april = {b.station_id: b for b in buckets if b.month.month == 4}
        self.assertAlmostEqual(april["LD.PAL"].mean_residual_s, (0.1 + 3.3) / 2)
        self.assertEqual(april["LD.PAL"].picks, 2)
        self.assertAlmostEqual(april["PE.PSUB"].mean_residual_s, 0.0)
        march = [b for b in buckets if b.month.month == 3][0]
        self.assertAlmostEqual(march.mean_residual_s, 0.1)

    def test_assess_dates_a_sustained_shift_and_ignores_one_off_months(self):
        month = lambda m: datetime(2023 + (m - 1) // 12, (m - 1) % 12 + 1, 1, tzinfo=UTC)  # noqa: E731
        normal = [0.1, -0.2, 0.0, 0.2, -0.1, 0.1, 0.0]
        series = [Bucket(month(i + 1), "LD.PAL", 5, v) for i, v in enumerate(normal)]
        spike = series + [Bucket(month(8), "LD.PAL", 5, 2.5), Bucket(month(9), "LD.PAL", 5, 0.1)]
        self.assertEqual(assess(spike).status, "clear")
        shifted = series + [Bucket(month(8 + i), "LD.PAL", 5, 3.0 + 0.1 * i) for i in range(3)]
        health = assess(shifted)
        self.assertEqual(health.status, "flagged")
        self.assertEqual(health.first_flag, month(8))
        self.assertEqual(health.confirmed, month(9))
        self.assertEqual(health.last_normal, month(7))
        self.assertAlmostEqual(health.estimated_offset_s, 3.1, places=2)
        thin = series + [Bucket(month(8), "LD.PAL", 1, 3.0), Bucket(month(9), "LD.PAL", 1, 3.0)]
        self.assertEqual(assess(thin).status, "clear")

    def test_seed_history_loads_compresses_and_builds_the_aggregate(self):
        event, picks = parse_event_picks("e1", QUAKEML)
        with patch("quaketrace.tiger.psycopg.connect") as connect:
            connection = connect.return_value.__enter__.return_value
            cursor = connection.cursor.return_value
            copy = cursor.copy.return_value.__enter__.return_value
            results = {
                "compression_enabled": (False,), "count(compress_chunk": (2,), "continuous_aggregates": None,
                "count(*), count(DISTINCT": (2, 1, 2, datetime(2024, 4, 27, tzinfo=UTC), datetime(2024, 4, 27, tzinfo=UTC)),
                "timescaledb_information.chunks": (3, 2), "columnstore_stats": (1000, 250),
            }

            def execute(statement, *args):
                result = MagicMock()
                result.rowcount = 2
                result.fetchone.return_value = next((v for k, v in results.items() if k in statement), None)
                return result

            connection.execute.side_effect = execute
            summary = seed_history("dbname=test", [event], picks)
        self.assertEqual(copy.write_row.call_count, 2)
        statements = " ".join(str(call.args[0]) for call in connection.execute.call_args_list)
        for expected in (
            "create_hypertable", "timescaledb.compress_segmentby = 'station_id'", "add_compression_policy",
            "CREATE MATERIALIZED VIEW quaketrace.station_monthly", "timescaledb.continuous",
            "add_continuous_aggregate_policy", "refresh_continuous_aggregate",
        ):
            self.assertIn(expected, statements)
        self.assertEqual(summary["compressedChunks"], 2)
        self.assertEqual(summary["compressionRatio"], 4.0)
        self.assertEqual(summary["inserted_picks"], 2)


if __name__ == "__main__":
    unittest.main()
