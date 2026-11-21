import unittest
from wsgiref.util import setup_testing_defaults

import server


def call(path, method="GET"):
    environ = {}
    setup_testing_defaults(environ)
    route, _, query = path.partition("?")
    environ.update(PATH_INFO=route, QUERY_STRING=query, REQUEST_METHOD=method)
    seen = {}
    body = b"".join(server.app(environ, lambda status, headers: seen.update(status=status, headers=dict(headers))))
    return seen["status"], seen["headers"], body


class WsgiAppTests(unittest.TestCase):
    def test_serves_the_page_and_scripts(self):
        status, headers, body = call("/")
        self.assertEqual(status, "200 OK")
        self.assertIn(b"<html", body.lower())
        status, headers, _ = call("/app.js")
        self.assertEqual(headers["Content-Type"], "text/javascript; charset=utf-8")

    def test_never_serves_files_outside_web(self):
        for path in ("/../.env", "/../server.py", "/%2e%2e/.env", "/../fixtures/manifest.json"):
            self.assertEqual(call(path)[0], "404 Not Found", path)

    def test_unknown_endpoint_and_methods(self):
        self.assertEqual(call("/api/nope")[0], "404 Not Found")
        self.assertEqual(call("/", "POST")[0], "405 Method Not Allowed")
        status, _, body = call("/", "HEAD")
        self.assertEqual((status, body), ("200 OK", b""))

    def test_vercel_names(self):
        self.assertIs(server.application, server.app)


class ShiftAndCacheTests(unittest.TestCase):
    def test_only_slider_shifts_are_accepted(self):
        for raw, expected in (("0", 0.0), ("-0", 0.0), ("3", 3.0), ("-2.5", -2.5), ("10", 10.0)):
            self.assertEqual(server._offset({"offset": [raw]}), expected, raw)
        for raw in ("1.23", "10.5", "-11", "nan", "inf", "abc", "1e9"):
            with self.assertRaises(ValueError, msg=raw):
                server._offset({"offset": [raw]})
        status, headers, _ = call("/api/replay?offset=1.23")
        self.assertEqual((status, headers["Cache-Control"]), ("400 Bad Request", "no-store"))

    def test_cdn_cache_policy(self):
        self.assertIn("s-maxage=86400", call("/app.js")[1]["Cache-Control"])
        self.assertIn("s-maxage=60", server.cache_policy("/api/history", server.HTTPStatus.OK))
        self.assertIn("s-maxage=86400", server.cache_policy("/api/lab", server.HTTPStatus.OK))
        self.assertEqual(call("/api/nope")[1]["Cache-Control"], "no-store")
        self.assertEqual(call("/../.env")[1]["Cache-Control"], "no-store")

    def test_history_reuses_a_recent_query(self):
        server._history_cache.clear()
        calls = []
        original = server.api.history_view
        server.api.history_view = lambda *args: calls.append(args) or {"ok": True}
        try:
            first = server.history_json("LD.PAL", None, 0.0, "world")
            second = server.history_json("LD.PAL", None, 0.0, "world")
        finally:
            server.api.history_view = original
            server._history_cache.clear()
        self.assertEqual(first, second)
        self.assertEqual(len(calls), 1)
