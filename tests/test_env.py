import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from quaketrace.data import TIGER_DSN_ENV
from quaketrace.env import load_env


class EnvTests(unittest.TestCase):
    def test_loads_tiger_credentials_without_overriding_the_shell(self):
        content = (
            "# Tiger Cloud credentials\n"
            "TIMESCALE_SERVICE_URL=postgres://tsdbadmin@example.test:5432/tsdb?sslmode=require\n"
            'PGPASSWORD="quoted value"\n'
            "export PGUSER=tsdbadmin\n"
            "PGHOST=from-file\n"
            "not a variable line\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(content, encoding="utf-8")
            with patch.dict(os.environ, {"PGHOST": "from-shell"}, clear=True):
                loaded = load_env(path)
                self.assertEqual(os.environ[TIGER_DSN_ENV], os.environ["TIMESCALE_SERVICE_URL"])
                self.assertEqual(os.environ["PGPASSWORD"], "quoted value")
                self.assertEqual(os.environ["PGUSER"], "tsdbadmin")
                self.assertEqual(os.environ["PGHOST"], "from-shell")
        self.assertNotIn("PGHOST", loaded)
        self.assertIn(TIGER_DSN_ENV, loaded)

    def test_missing_file_changes_nothing(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(load_env(Path("does-not-exist.env")), [])
            self.assertNotIn(TIGER_DSN_ENV, os.environ)


if __name__ == "__main__":
    unittest.main()
