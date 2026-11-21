from dataclasses import astuple
import unittest
from unittest.mock import MagicMock, patch

import psycopg

from quaketrace.data import TIGER_DSN_ENV, load_fixture
from quaketrace.tiger import TigerDataError, read_demo_arrivals


class TigerDataTests(unittest.TestCase):
    def setUp(self):
        self.fixture = load_fixture(use_tiger=False)

    def test_loads_complete_database_snapshot_in_fixture_order(self):
        server_rows = [astuple(row) for row in reversed(self.fixture.arrivals)]
        with patch.dict("os.environ", {TIGER_DSN_ENV: "dbname=test"}):
            with patch("quaketrace.tiger.psycopg.connect") as connect:
                connection = connect.return_value.__enter__.return_value
                connection.execute.return_value.fetchall.return_value = server_rows
                loaded = load_fixture()
        self.assertEqual(loaded.arrival_source, "tiger")
        self.assertEqual(loaded.arrivals, self.fixture.arrivals)

    def test_incomplete_remote_snapshot_falls_back(self):
        with patch.dict("os.environ", {TIGER_DSN_ENV: "dbname=test"}):
            with patch("quaketrace.tiger.psycopg.connect") as connect:
                connection = connect.return_value.__enter__.return_value
                connection.execute.return_value.fetchall.return_value = [astuple(self.fixture.arrivals[0])]
                with self.assertLogs("quaketrace.data", "WARNING") as log:
                    loaded = load_fixture()
        self.assertEqual(loaded, self.fixture)
        self.assertIn("snapshot is incomplete", log.output[0])

    def test_history_queries_reuse_one_connection_and_reconnect_once(self):
        from datetime import UTC, datetime

        from quaketrace.tiger import history_buckets, reset_shared_connection

        def fake_connection(broken=False):
            connection = MagicMock()
            connection.closed = False

            def execute(statement, *args):
                if broken and "statement_timeout" not in statement:
                    raise psycopg.OperationalError("server closed the connection")
                result = MagicMock()
                if "GROUP BY month" in statement:
                    result.fetchall.return_value = [(datetime(2024, 5, 1, tzinfo=UTC), "LD.PAL", 3, 0.2)]
                elif "sum(picks)" in statement:
                    result.fetchall.return_value = [("LD.PAL", 179)]
                elif "count(DISTINCT" in statement:
                    result.fetchone.return_value = (1, 1, 1, datetime(2024, 5, 1, tzinfo=UTC), datetime(2024, 5, 1, tzinfo=UTC))
                elif "station_monthly" in statement:
                    result.fetchall.return_value = [(datetime(2024, 5, 1, tzinfo=UTC), "LD.PAL", 3, 0.2)]
                else:
                    result.fetchone.return_value = None
                return result

            connection.execute.side_effect = execute
            return connection

        reset_shared_connection()
        try:
            with patch("quaketrace.tiger.psycopg.connect", side_effect=[fake_connection()]) as connect:
                first = history_buckets("dbname=test", limit=5)
                second = history_buckets("dbname=test", limit=5)
            self.assertEqual(connect.call_count, 1)
            self.assertEqual(first[2][0].station_id, "LD.PAL")
            self.assertEqual(second[0], [("LD.PAL", 179)])

            reset_shared_connection()
            with patch(
                "quaketrace.tiger.psycopg.connect", side_effect=[fake_connection(broken=True), fake_connection()],
            ) as connect:
                recovered = history_buckets("dbname=test", limit=5)
            self.assertEqual(connect.call_count, 2)
            self.assertEqual(recovered[4], "continuous aggregate")
        finally:
            reset_shared_connection()

    def test_connection_errors_never_echo_credentials(self):
        with patch("quaketrace.tiger.psycopg.connect", side_effect=psycopg.OperationalError("secret")):
            with self.assertRaisesRegex(TigerDataError, r"arrival query failed \(OperationalError\)"):
                read_demo_arrivals("password=secret", self.fixture)
