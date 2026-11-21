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
