from dataclasses import astuple
import unittest
from unittest.mock import patch

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

    def test_connection_errors_never_echo_credentials(self):
        with patch("quaketrace.tiger.psycopg.connect", side_effect=psycopg.OperationalError("secret")):
            with self.assertRaisesRegex(TigerDataError, r"arrival query failed \(OperationalError\)"):
                read_demo_arrivals("password=secret", self.fixture)
