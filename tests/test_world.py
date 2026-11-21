import json
import unittest
from datetime import date
from urllib.parse import parse_qs, urlsplit

from quaketrace.world import around, countries, country_at, parse_station_reports, search_events


class WorldTests(unittest.TestCase):
    def test_catalog_search_includes_radius_full_end_day_and_ordering(self):
        def fetch(url):
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query["latitude"], ["35.0"])
            self.assertEqual(query["longitude"], ["139.0"])
            self.assertEqual(query["maxradiuskm"], ["500"])
            self.assertEqual(query["endtime"], ["2024-01-01T23:59:59.999"])
            self.assertEqual(query["orderby"], ["magnitude"])
            return json.dumps({"features": [
                {
                    "id": "sample", "geometry": {"coordinates": [137.27, 37.49, 10]},
                    "properties": {"place": "Noto Peninsula, Japan", "mag": 7.5, "time": 1704093000000},
                }
            ]}).encode()

        same_day = date(2024, 1, 1)
        event, = search_events(
            around(35.0, 139.0, 500), same_day, same_day, 4.5, largest_first=True, fetch=fetch,
        )
        self.assertEqual(event.place, "Noto Peninsula, Japan")
        self.assertEqual(event.latitude, 37.49)
        self.assertEqual(event.time.date(), same_day)

    def test_island_country_and_dateline_crossing_search_area(self):
        self.assertEqual(country_at(38.04, 138.257), "Japan")
        self.assertIsNone(country_at(0, -150))
        west, _, east, _ = countries()["Fiji"].area.bounds
        self.assertLess(east - west, 30)
        self.assertGreater(east, 180)

    def test_reporting_station_position_can_cross_the_dateline(self):
        content = b"""<quakeml xmlns="urn:quakeml"><eventParameters><event>
            <preferredOriginID>origin</preferredOriginID>
            <origin publicID="origin">
              <time><value>2024-01-01T07:10:00Z</value></time>
              <latitude><value>0</value></latitude><longitude><value>179</value></longitude>
              <arrival><pickID>a</pickID><phase>P</phase><distance>3</distance><azimuth>90</azimuth></arrival>
              <arrival><pickID>b</pickID><phase>S</phase></arrival>
            </origin>
            <pick publicID="a"><waveformID networkCode="IU" stationCode="TEST"/></pick>
            <pick publicID="b"><waveformID networkCode="IU" stationCode="TEST"/></pick>
        </event></eventParameters></quakeml>"""
        _, reports = parse_station_reports(content)
        station, = reports
        self.assertEqual(station.id, "IU.TEST")
        self.assertEqual(station.phases, ("P", "S"))
        self.assertAlmostEqual(station.location.latitude, 0)
        self.assertAlmostEqual(station.location.longitude, -178)
        self.assertIn("Estimated", station.source)
