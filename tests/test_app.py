import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

from quaketrace.data import AUDIT_STATIONS, EVALUATION_EVENTS, MAINSHOCK, REPLAY_STATIONS, StationLocation
from quaketrace.world import CatalogEvent, StationReport


class AppTests(unittest.TestCase):
    def test_world_explorer_searches_regions_and_labels_reporting_stations(self):
        event = CatalogEvent(
            "us6000m0xl", "2024 Noto Peninsula, Japan Earthquake", 7.5,
            datetime(2024, 1, 1, 7, 10, tzinfo=UTC), 37.49, 137.27, 10.0,
        )
        station = StationReport(
            "JP.JSD", ("Pg",), 106.0, StationLocation(38.04, 138.257, "Sado"),
            "EarthScope station metadata",
        )
        with patch("quaketrace.explorer.catalog_results", return_value=(event,)) as catalog:
            with patch("quaketrace.explorer.station_results", return_value=(station,)):
                app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / "app.py"), default_timeout=20).run()
                app.radio[0].set_value("World explorer").run()
                self.assertFalse(app.exception)
                app.selectbox(key="world_area").select("Japan").run()
                next(button for button in app.button if button.label == "Search earthquakes").click().run()
                self.assertFalse(app.exception)
                self.assertIsNotNone(catalog.call_args.args[0].bounds)
                app.selectbox(key="world_event").select(event.id).run()
                self.assertFalse(app.exception)
                self.assertIn("JP.JSD · Sado", app.selectbox(key="world_station_us6000m0xl").options)
                app.selectbox(key="world_station_us6000m0xl").select(station.id).run()
                self.assertFalse(app.exception)
                self.assertTrue(any("Japan" in item.value and "JP.JSD" in item.value for item in app.markdown))
                self.assertEqual(len(app.get("plotly_chart")), 1)

    def test_replay_event_filters_station_choices_and_clears_reveal(self):
        app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / "app.py"), default_timeout=20).run()
        self.assertEqual(
            [name.split(" · ")[0] for name in app.selectbox(key="replay_station").options], list(REPLAY_STATIONS)
        )
        self.assertIn("Palisades, New York", " ".join(app.selectbox(key="replay_station").options))
        next(toggle for toggle in app.toggle if toggle.label == "Street map").set_value(True).run()
        self.assertFalse(app.exception)
        app.button(key="replay_example").click().run()
        app.button(key="replay_reveal").click().run()
        self.assertTrue(app.metric)

        event = EVALUATION_EVENTS[1]
        app.selectbox(key="replay_event").select(event).run()
        self.assertFalse(app.exception)
        self.assertEqual(
            [name.split(" · ")[0] for name in app.selectbox(key="replay_station").options], list(AUDIT_STATIONS)
        )
        self.assertEqual(len(app.get("plotly_chart")), 1)
        self.assertFalse(app.metric)

        app.selectbox(key="replay_station").select("LD.BRNY")
        app.slider(key="replay_offset").set_value(5.0)
        next(button for button in app.button if button.label == "Run replay").click().run()
        self.assertFalse(app.exception)
        self.assertEqual(app.session_state.replay_scenario, (event, "LD.BRNY", 5.0))
        app.button(key="replay_reveal").click().run()
        self.assertTrue(any("LD.BRNY +5.00 s" in message.value for message in app.markdown))

        app.button(key="replay_reset").click().run()
        self.assertEqual(app.session_state.replay_scenario[0], event)
        self.assertEqual(app.session_state.replay_scenario[2], 0.0)
        app.button(key="replay_example").click().run()
        self.assertFalse(app.exception)
        self.assertEqual(app.selectbox(key="replay_event").value, MAINSHOCK)
        self.assertEqual(len(app.get("plotly_chart")), 2)

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
