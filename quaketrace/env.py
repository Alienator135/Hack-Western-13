"""Load connection settings from a project .env file (gitignored).

Tiger Cloud's downloadable credentials file can be saved as .env in the
repository root. It defines TIMESCALE_SERVICE_URL and the standard PG*
variables; QuakeTrace reads QUAKETRACE_TIGER_DSN, so that is filled from
TIMESCALE_SERVICE_URL when not set. Variables already in the environment win.
"""

from __future__ import annotations

import os
from pathlib import Path

from .data import TIGER_DSN_ENV

PROJECT_ENV = Path(__file__).resolve().parent.parent / ".env"


def load_env(path: Path = PROJECT_ENV) -> list[str]:
    """Set variables from path that are not already set; return their names (never values)."""
    loaded = []
    if path.is_file():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            key, separator, value = line.partition("=")
            key = key.strip()
            if not separator or not key.isidentifier():
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            # Blank template lines (.env.example) must not set empty variables.
            if value and key not in os.environ:
                os.environ[key] = value
                loaded.append(key)
    if not os.environ.get(TIGER_DSN_ENV) and os.environ.get("TIMESCALE_SERVICE_URL"):
        os.environ[TIGER_DSN_ENV] = os.environ["TIMESCALE_SERVICE_URL"]
        loaded.append(TIGER_DSN_ENV)
    return loaded
