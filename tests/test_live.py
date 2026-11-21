from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import unittest
from unittest.mock import MagicMock, patch

from quaketrace import live, tiger
from quaketrace.history import HistoryEvent, HistoryPick

NOW = datetime(2026, 11, 21, 18, 0, tzinfo=UTC)
NEWEST = datetime(2026, 11, 1, tzinfo=UTC)


def feature(event_id):
    return {"id": event_id, "properties": {"mag": 2.1, "place": "Somewhere, NJ", "types": ",phase-data,"}}


def parsed(event_id, picks=2):
    event = HistoryEvent(event_id, NOW - timedelta(days=1), 40.7, -74.7, 5.0, 2.1, "Somewhere, NJ")
    rows = [
        HistoryPick(event.event_time, event_id, f"LD.S{i}", "--", "HHZ", "Pg", event.event_time, 0.1, 1.0, 0.5, 90.0)
        for i in range(picks)
    ]
    return event, rows


class IngestTests(unittest.TestCase):
    def run_ingest(self, *, latest=NEWEST, known=(), get_catalog=None, get_event=None):
        stored = {}

        @contextmanager
        def session(dsn, operation):
            yield MagicMock()

        def store_live(connection, added, **kwargs):
            stored.update(added=added, **kwargs)
            return len(added), sum(len(rows) for _, rows in added)

        with patch.multiple(
            tiger, session=session, ensure_live_schema=MagicMock(), latest_event_time=MagicMock(return_value=latest),
            known_event_ids=MagicMock(return_value=set(known)), store_live=store_live,
            invalidate_overview=MagicMock(),
        ):
            summary = live.ingest(
                "dbname=test", now=NOW, lookback_days=30,
                get_catalog=get_catalog or (lambda start, end, minimum: [feature("a"), feature("b"), feature("c")]),
                get_event=get_event or (lambda item: parsed(item["id"])),
            )
        return summary, stored

    def test_adds_only_quakes_tiger_does_not_have(self):
        windows = []

        def get_catalog(start, end, minimum):
            windows.append((start, end))
            return [feature("a"), feature("b"), feature("c")]

        summary, stored = self.run_ingest(known={"b"}, get_catalog=get_catalog)
        self.assertEqual(windows, [("2026-10-02T00:00:00", "2026-11-21T18:00:00")])
        self.assertEqual([event.event_id for event, _ in stored["added"]], ["a", "c"])
        self.assertEqual((summary["checked"], summary["newEvents"], summary["newPicks"]), (3, 2, 4))
        self.assertIsNone(summary["error"])

    def test_skips_events_that_fail_or_have_no_picks(self):
        def get_event(item):
            if item["id"] == "a":
                raise OSError("timeout")
            return None if item["id"] == "b" else parsed(item["id"])

        summary, stored = self.run_ingest(get_event=get_event)
        self.assertEqual([event.event_id for event, _ in stored["added"]], ["c"])
        self.assertEqual(summary["skipped"], 1)

    def test_usgs_outage_is_logged_not_raised(self):
        def get_catalog(start, end, minimum):
            raise OSError("no route to host")

        summary, stored = self.run_ingest(get_catalog=get_catalog)
        self.assertEqual(stored["checked"], 0)
        self.assertIn("USGS catalog request failed", stored["error"])
        self.assertEqual(summary["newEvents"], 0)

    def test_requires_seeded_history(self):
        with self.assertRaises(tiger.TigerDataError):
            self.run_ingest(latest=None)


class StoreLiveTests(unittest.TestCase):
    def test_counts_only_rows_the_database_inserted(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        # Event "a" is new (both picks insert in one batch), event "b" already exists.
        rowcounts = iter([1, 2, 0])
        type(cursor).rowcount = property(lambda self: next(rowcounts))
        events, picks = tiger.store_live(
            connection, [parsed("a"), parsed("b")], window_start=NEWEST, window_end=NOW, checked=2,
        )
        self.assertEqual((events, picks), (1, 2))
        logged = connection.execute.call_args[0]
        self.assertIn("ingest_runs", logged[0])
        self.assertEqual(logged[1][2:5], (2, 1, 2))


if __name__ == "__main__":
    unittest.main()
