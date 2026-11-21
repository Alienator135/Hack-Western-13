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
    def setUp(self):
        self.refreshed = MagicMock()

    def run_ingest(self, *, latest=NEWEST, known=(), get_catalog=None, get_event=None, feed="northeast",
                   backfill_days=None, min_magnitude=None):
        stored = {"added": []}

        @contextmanager
        def session(dsn, operation):
            yield MagicMock()

        def store_events(connection, added):
            stored["added"].extend(added)
            return len(added), sum(len(rows) for _, rows in added)

        def log_run(connection, **kwargs):
            stored.update(kwargs)

        with patch.multiple(
            tiger, session=session, ensure_live_schema=MagicMock(), latest_event_time=MagicMock(return_value=latest),
            known_event_ids=MagicMock(return_value=set(known)), store_events=store_events, log_run=log_run,
            refresh_months=self.refreshed,
            invalidate_overview=MagicMock(),
        ):
            summary = live.ingest(
                "dbname=test", now=NOW, feed=feed, backfill_days=backfill_days, min_magnitude=min_magnitude,
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
        self.refreshed.assert_called_once()
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

    def test_world_feed_starts_a_week_back_when_empty_and_backfill_overrides(self):
        windows = []

        def get_catalog(start, end, minimum):
            windows.append((start, minimum))
            return []

        self.run_ingest(latest=None, feed="world", get_catalog=get_catalog)
        self.run_ingest(latest=NEWEST, feed="world", backfill_days=365, get_catalog=get_catalog)
        self.assertEqual(windows, [("2026-11-14T18:00:00", 4.5), ("2025-11-21T18:00:00", 4.5)])

    def test_min_magnitude_overrides_the_feed_threshold(self):
        minimums = []
        self.run_ingest(feed="world", backfill_days=365, min_magnitude=5.5,
                        get_catalog=lambda start, end, minimum: minimums.append(minimum) or [])
        self.assertEqual(minimums, [5.5])

    def test_saves_in_batches(self):
        many = [feature(f"e{i}") for i in range(live.BATCH + 5)]
        summary, stored = self.run_ingest(get_catalog=lambda start, end, minimum: many)
        self.assertEqual(summary["newEvents"], live.BATCH + 5)
        self.assertEqual(stored["new_events"], live.BATCH + 5)


class RefreshMonthsTests(unittest.TestCase):
    def test_refreshes_whole_months_including_december(self):
        connection = MagicMock()
        tiger.refresh_months(connection, datetime(2025, 11, 21, 5, tzinfo=UTC), datetime(2025, 12, 3, tzinfo=UTC))
        self.assertEqual(
            connection.execute.call_args.args[1],
            (datetime(2025, 11, 1, tzinfo=UTC), datetime(2026, 1, 1, tzinfo=UTC)),
        )


class StoreEventsTests(unittest.TestCase):
    def test_counts_only_rows_the_database_inserted_and_tags_regions(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        # Event "a" is new (both picks insert in one batch), event "b" already exists.
        rowcounts = iter([1, 2, 0])
        type(cursor).rowcount = property(lambda self: next(rowcounts))
        tokyo = HistoryEvent("b", NOW, 35.7, 139.7, 10.0, 5.0, "Tokyo")
        events, picks = tiger.store_events(connection, [parsed("a"), (tokyo, parsed("b")[1])])
        self.assertEqual((events, picks), (1, 2))
        regions = [call.args[1][-1] for call in cursor.execute.call_args_list]
        self.assertEqual(regions, ["northeast", "world"])
        self.assertTrue(all(row[-1] == "northeast" for row in cursor.executemany.call_args.args[1]))


if __name__ == "__main__":
    unittest.main()


class CatalogWindowTests(unittest.TestCase):
    def test_long_ranges_split_into_yearly_requests(self):
        windows = live.catalog_windows("2018-01-01", "2026-11-21T18:00:00")
        self.assertEqual(len(windows), 9)
        self.assertEqual(windows[0][0], "2018-01-01T00:00:00")
        self.assertEqual(windows[-1][1], "2026-11-21T18:00:00")
        for (_, stop), (start, _) in zip(windows, windows[1:]):
            self.assertEqual(stop, start)

    def test_short_range_is_one_request(self):
        self.assertEqual(len(live.catalog_windows("2026-11-14T00:00:00", "2026-11-21T00:00:00")), 1)

    def test_catalog_merges_windows_and_drops_duplicates(self):
        pages = [
            {"features": [feature("a"), feature("b")]},
            {"features": [feature("b"), feature("c"), {"id": "d", "properties": {"types": ",origin,"}}]},
        ]
        with patch.object(live, "fetch", side_effect=[__import__("json").dumps(page).encode() for page in pages]) as fetch:
            rows = live.catalog("2024-01-01", "2025-06-01", 4.5, bounds=None)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual([row["id"] for row in rows], ["a", "b", "c"])
