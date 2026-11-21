"""Serve the QuakeTrace web UI and its JSON API.

Run from the repository root:

    python server.py            # http://127.0.0.1:8000
    python server.py --port 9000

Map, satellite and 3D views use free, keyless MapLibre tiles in the browser.
Without internet the UI uses the bundled state outlines and still works offline.
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import re
import threading
import time
from functools import lru_cache
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from os import getenv
from pathlib import Path
from time import perf_counter
from urllib.parse import parse_qs, urlparse

from quaketrace import api
from quaketrace.data import MAINSHOCK, TIGER_DSN_ENV, load_fixture
from quaketrace.env import load_env

WEB_ROOT = Path(__file__).resolve().parent / "web"
logger = logging.getLogger("quaketrace.server")


@lru_cache(maxsize=1)
def fixture():
    return load_fixture()


@lru_cache(maxsize=1)
def overview_json() -> bytes:
    return json.dumps(api.overview(fixture())).encode()


@lru_cache(maxsize=1)
def waveform_json() -> bytes:
    return json.dumps(api.waveform(fixture())).encode()


@lru_cache(maxsize=256)
def replay_json(event_id: str, station: str | None, offset_s: float) -> bytes:
    return json.dumps(api.replay(fixture(), event_id, station, offset_s)).encode()


@lru_cache(maxsize=256)
def audit_json(station: str | None, onset: str | None, offset_s: float) -> bytes:
    return json.dumps(api.audit_view(fixture(), station, onset, offset_s)).encode()


@lru_cache(maxsize=128)
def lab_json(event_id: str, station: str | None, offset_s: float, exclude: str | None) -> bytes:
    return json.dumps(api.lab(fixture(), event_id, station, offset_s, exclude)).encode()


@lru_cache(maxsize=64)
def lab_runs_json(event_id: str, station: str | None, offset_s: float) -> bytes:
    return json.dumps(api.lab_runs(fixture(), event_id, station, offset_s)).encode()


def _offset(query: dict) -> float:
    raw = query.get("offset", ["0"])[0] or "0"
    value = float(raw)
    if value != value:  # NaN
        raise ValueError("Shift must be a number.")
    return round(value, 2)


BENCHMARK_FILE = Path(__file__).resolve().parent / "fixtures" / "benchmark.json"


@lru_cache(maxsize=1)
def benchmark_json() -> bytes:
    if not BENCHMARK_FILE.is_file():
        raise LookupError("Benchmark results are missing. Run scripts/run_benchmark.py.")
    return BENCHMARK_FILE.read_bytes()


def route(path: str, query: dict) -> bytes:
    if path == "/api/overview":
        return overview_json()
    if path == "/api/benchmark":
        return benchmark_json()
    if path == "/api/waveform":
        return waveform_json()
    if path == "/api/replay":
        offset = _offset(query)
        station = query.get("station", [None])[0] or None
        return replay_json(query.get("event", [MAINSHOCK])[0], station if offset else None, offset)
    if path in ("/api/lab", "/api/lab/runs"):
        offset = _offset(query)
        station = query.get("station", [None])[0] or None
        event_id = query.get("event", [MAINSHOCK])[0]
        if path == "/api/lab/runs":
            return lab_runs_json(event_id, station if offset else None, offset)
        return lab_json(event_id, station if offset else None, offset, query.get("exclude", [None])[0] or None)
    if path == "/api/audit":
        offset = _offset(query)
        station = query.get("station", [None])[0] or None
        onset = query.get("onset", [None])[0] or None
        return audit_json(station if offset else None, onset if offset else None, offset)
    if path == "/api/history":
        # Not cached: with Tiger Data connected, every call is a live query.
        offset = _offset(query)
        station = query.get("station", [None])[0] or None
        onset = query.get("onset", [None])[0] or None
        if onset and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", onset):
            raise ValueError("Onset must be a date like 2024-04-27.")
        region = query.get("region", ["northeast"])[0] or "northeast"
        return json.dumps(api.history_view(station, onset, offset, region)).encode()
    raise LookupError(path)


class Handler(BaseHTTPRequestHandler):
    server_version = "QuakeTrace/1.0"

    def log_message(self, format, *args):  # noqa: A002 - signature from BaseHTTPRequestHandler
        logger.info("%s %s", self.address_string(), format % args)

    def _send(self, status: HTTPStatus, body: bytes, content_type: str, *, cache: bool = False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=300" if cache else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: HTTPStatus, message: str):
        self._send(status, json.dumps({"error": message}).encode(), "application/json")

    def do_GET(self):  # noqa: N802 - http.server naming
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            try:
                body = route(parsed.path, parse_qs(parsed.query))
            except LookupError:
                return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint.")
            except ValueError as error:
                return self._error(HTTPStatus.BAD_REQUEST, str(error))
            except (OSError, KeyError) as error:
                logger.exception("Could not load fixtures")
                return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not load the demo fixtures: {error}")
            except Exception:  # noqa: BLE001 - keep the server up and report JSON
                logger.exception("Request failed: %s", self.path)
                return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "The server hit an unexpected error.")
            return self._send(HTTPStatus.OK, body, "application/json")
        self._static(parsed.path)

    def do_HEAD(self):  # noqa: N802 - http.server naming
        self.send_response(HTTPStatus.OK if urlparse(self.path).path in ("", "/") else HTTPStatus.NOT_FOUND)
        self.end_headers()

    def _static(self, path: str):
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_ROOT / relative).resolve()
        if WEB_ROOT not in target.parents or not target.is_file():
            return self._error(HTTPStatus.NOT_FOUND, "Not found.")
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type.endswith("javascript"):
            content_type += "; charset=utf-8"
        self._send(HTTPStatus.OK, target.read_bytes(), content_type)


def _warm_tiger():
    started = perf_counter()
    try:
        view = api.history_view()
    except Exception:  # noqa: BLE001 - warm-up is best effort
        logger.exception("Tiger Data warm-up failed")
        return
    logger.info("History source: %s (warm-up %.0f ms)", view.get("source"), (perf_counter() - started) * 1000)


INGEST_MINUTES_ENV = "QUAKETRACE_INGEST_MINUTES"
DEFAULT_INGEST_MINUTES = 10.0


def _live_ingest(minutes: float):
    """Poll USGS for newly published quakes and add them to Tiger Data, forever."""
    from quaketrace.live import FEEDS, ingest  # noqa: PLC0415
    from quaketrace.tiger import TigerDataError  # noqa: PLC0415

    while True:
        for feed in FEEDS:
            try:
                summary = ingest(getenv(TIGER_DSN_ENV), feed=feed)
                if summary["error"]:
                    logger.warning("Live ingest (%s): %s", feed, summary["error"])
                else:
                    logger.info(
                        "Live ingest (%s): checked %d USGS quakes, added %d quakes and %d picks",
                        feed, summary["checked"], summary["newEvents"], summary["newPicks"],
                    )
            except TigerDataError as error:
                logger.warning("Live ingest (%s): %s", feed, error)
            except Exception:  # noqa: BLE001 - keep the loop alive for the demo
                logger.exception("Live ingest (%s) failed", feed)
        time.sleep(minutes * 60)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--ingest-minutes", type=float, default=None,
        help=f"Check USGS for new quakes this often when Tiger Data is connected (0 disables; "
             f"default {INGEST_MINUTES_ENV} or {DEFAULT_INGEST_MINUTES:g})",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    load_env()  # project .env (gitignored), e.g. Tiger Cloud credentials
    mimetypes.add_type("text/javascript", ".js")
    fixture()  # Fail fast if fixtures are missing.
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    source = fixture().arrival_source
    print(f"QuakeTrace on http://{args.host}:{args.port} · arrivals: {source}", flush=True)
    if getenv(TIGER_DSN_ENV):
        # Open the shared Tiger connection now so the first click in front of judges is fast.
        threading.Thread(target=_warm_tiger, daemon=True).start()
        minutes = args.ingest_minutes
        if minutes is None:
            minutes = float(getenv(INGEST_MINUTES_ENV) or DEFAULT_INGEST_MINUTES)
        if minutes > 0:
            print(f"Live ingest: checking USGS for new quakes every {minutes:g} min", flush=True)
            threading.Thread(target=_live_ingest, args=(minutes,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
