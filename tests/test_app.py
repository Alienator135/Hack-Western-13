import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest


class AppTests(unittest.TestCase):
    def test_replay_and_audit_controls(self):
        app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / "app.py"), default_timeout=20)
        app.run()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.get("plotly_chart")), 2)

        app.button(key="replay_example").click().run()
        self.assertFalse(app.exception)
        self.assertTrue(any("LD.PAL" in message.value for message in app.markdown))
        self.assertFalse(app.metric)
        app.button(key="replay_reveal").click().run()
        self.assertFalse(app.exception)
        self.assertEqual([metric.value for metric in app.metric[1:]], ["9.3 km", "2.8 km"])
        app.button(key="replay_reset").click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.metric)

        app.radio[0].set_value("Station audit").run()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.get("plotly_chart")), 1)
        app.button(key="audit_example").click().run()
        self.assertFalse(app.exception)
        self.assertEqual([metric.value for metric in app.metric], ["Apr 27", "May 01", "+2.88 s"])
        app.button(key="audit_reset").click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.metric)
