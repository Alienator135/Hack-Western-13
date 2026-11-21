"""Serve the QuakeTrace web UI and its JSON API.

Run from the repository root:

    python server.py            # http://127.0.0.1:8000
    python server.py --port 9000

Set GOOGLE_MAPS_API_KEY to enable the Google Maps, satellite, and 3D Earth views.
Without it the UI uses the bundled state outlines and still works offline.
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
from functools import lru_cache
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from os import getenv
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from quaketrace import api
from quaketrace.data import MAINSHOCK, load_fixture

WEB_ROOT = Path(__file__).resolve().parent / "web"
GOOGLE_KEY_ENV = "GOOGLE_MAPS_API_KEY"
GOOGLE_MAP_ID_ENV = "GOOGLE_MAPS_MAP_ID"
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


def config_json() -> bytes:
    return json.dumps({
        "googleMapsKey": getenv(GOOGLE_KEY_ENV, ""),
        "googleMapId": getenv(GOOGLE_MAP_ID_ENV, "") or "DEMO_MAP_ID",
    }).encode()


def _offset(query: dict) -> float:
    raw = query.get("offset", ["0"])[0] or "0"
    value = float(raw)
    if value != value:  # NaN
        raise ValueError("Shift must be a number.")
    return round(value, 2)


def route(path: str, query: dict) -> bytes:
    if path == "/api/config":
        return config_json()
    if path == "/api/overview":
        return overview_json()
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


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    mimetypes.add_type("text/javascript", ".js")
    fixture()  # Fail fast if fixtures are missing.
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    source = fixture().arrival_source
    maps = "Google Maps enabled" if getenv(GOOGLE_KEY_ENV) else f"no {GOOGLE_KEY_ENV}, using offline map"
    print(f"QuakeTrace on http://{args.host}:{args.port} · arrivals: {source} · {maps}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
