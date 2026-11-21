"""Worldwide USGS catalog search and reporting-station lookup."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen

from .data import DEFAULT_FIXTURES, StationLocation, utc
from .sources import USGS_DETAIL, preferred_origin, product_url, station_metadata

CATALOG_QUERY = "https://earthquake.usgs.gov/fdsnws/event/1/query"
SEARCH_LIMIT = 100
CITIES = {
    "Anchorage, United States": (61.2181, -149.9003),
    "Christchurch, New Zealand": (-43.5320, 172.6362),
    "Honolulu, United States": (21.3069, -157.8583),
    "Istanbul, Türkiye": (41.0082, 28.9784),
    "Jakarta, Indonesia": (-6.2088, 106.8456),
    "Lisbon, Portugal": (38.7223, -9.1393),
    "Lima, Peru": (-12.0464, -77.0428),
    "Manila, Philippines": (14.5995, 120.9842),
    "Mexico City, Mexico": (19.4326, -99.1332),
    "New York, United States": (40.7128, -74.0060),
    "Port-au-Prince, Haiti": (18.5944, -72.3074),
    "Reykjavík, Iceland": (64.1466, -21.9426),
    "San Francisco, United States": (37.7749, -122.4194),
    "Santiago, Chile": (-33.4489, -70.6693),
    "Taipei, Taiwan": (25.0330, 121.5654),
    "Tokyo, Japan": (35.6762, 139.6503),
    "Vancouver, Canada": (49.2827, -123.1207),
}


@dataclass(frozen=True)
class Area:
    latitude: float = 15.0
    longitude: float = 0.0
    zoom: float = 1.05
    bounds: tuple[float, float, float, float] | None = None
    radius_km: int | None = None


@dataclass(frozen=True)
class CatalogEvent:
    id: str
    place: str
    magnitude: float
    time: datetime
    latitude: float
    longitude: float
    depth_km: float

    @property
    def url(self) -> str:
        return f"https://earthquake.usgs.gov/earthquakes/eventpage/{quote(self.id, safe='')}/executive"


@dataclass(frozen=True)
class StationReport:
    id: str
    phases: tuple[str, ...]
    distance_km: float | None
    location: StationLocation | None
    source: str


@dataclass(frozen=True)
class Country:
    name: str
    shapes: tuple[tuple[tuple[float, float, float, float], list], ...]
    area: Area


def _longitude(degrees: float) -> float:
    return (degrees + 180) % 360 - 180


def _longitude_span(values: list[float]) -> tuple[float, float]:
    ordered = sorted(value % 360 for value in values)
    circular = ordered + [ordered[0] + 360]
    index = max(range(len(ordered)), key=lambda index: circular[index + 1] - circular[index])
    west = _longitude(circular[index + 1])
    return west, west + 360 - (circular[index + 1] - circular[index])


def around(latitude: float, longitude: float, radius_km: int) -> Area:
    zoom = max(1.05, min(10, math.log2(15000 / radius_km)))
    return Area(latitude, longitude, zoom, radius_km=radius_km)


@lru_cache(maxsize=1)
def countries() -> dict[str, Country]:
    content = json.loads((DEFAULT_FIXTURES / "countries.geojson").read_text(encoding="utf-8"))
    result = {}
    for feature in content["features"]:
        name = feature["properties"]["name"]
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        shapes = []
        all_longitudes = []
        for polygon in polygons:
            longitudes, latitudes = zip(*polygon[0])
            all_longitudes.extend(longitudes)
            shapes.append(((min(longitudes), min(latitudes), max(longitudes), max(latitudes)), polygon))
        south = min(bounds[1] for bounds, _ in shapes)
        north = max(bounds[3] for bounds, _ in shapes)
        if south < -89:
            # Antarctica spans all longitudes and has a degenerate longitude ring at the pole.
            west, east = -180, 180
        else:
            west, east = _longitude_span(all_longitudes)
        span = max(0.5, north - south, east - west)
        zoom = max(1.05, min(8, math.log2(210 / span)))
        cushion = min(3, (360 - (east - west)) / 2)
        area = Area(
            (south + north) / 2, _longitude((west + east) / 2), zoom,
            (west - cushion, max(-90, south - 3), east + cushion, min(90, north + 3)),
        )
        result[name] = Country(name, tuple(shapes), area)
    return result


def _inside_ring(longitude: float, latitude: float, ring: list) -> bool:
    inside = False
    last_x, last_y = ring[-1]
    for x, y in ring:
        if (y > latitude) != (last_y > latitude):
            if longitude < (last_x - x) * (latitude - y) / (last_y - y) + x:
                inside = not inside
        last_x, last_y = x, y
    return inside


@lru_cache(maxsize=4096)
def country_at(latitude: float, longitude: float) -> str | None:
    longitude = _longitude(longitude)
    for country in countries().values():
        for (west, south, east, north), rings in country.shapes:
            if west <= longitude <= east and south <= latitude <= north:
                if _inside_ring(longitude, latitude, rings[0]) and not any(
                    _inside_ring(longitude, latitude, ring) for ring in rings[1:]
                ):
                    return country.name
    return None


def fetch_bytes(url: str) -> bytes:
    headers = {"User-Agent": "QuakeTrace/1.0 (https://github.com/Alienator135/Hack-Western-13)"}
    with urlopen(Request(url, headers=headers), timeout=12) as response:
        content = response.read(8_000_001)
    if len(content) > 8_000_000:
        raise ValueError("The data service returned a response larger than 8 MB.")
    return content


def search_events(
    area: Area, start: date, end: date, minimum_magnitude: float, *, largest_first: bool = False, fetch=fetch_bytes,
) -> tuple[CatalogEvent, ...]:
    if start > end:
        raise ValueError("The start date must be before or equal to the end date.")
    parameters = {
        "format": "geojson", "eventtype": "earthquake", "orderby": "magnitude" if largest_first else "time",
        "starttime": start.isoformat(), "endtime": f"{end.isoformat()}T23:59:59.999",
        "minmagnitude": minimum_magnitude, "limit": SEARCH_LIMIT,
    }
    if area.radius_km is not None:
        parameters.update(latitude=area.latitude, longitude=area.longitude, maxradiuskm=area.radius_km)
    elif area.bounds:
        west, south, east, north = area.bounds
        parameters.update(minlongitude=west, minlatitude=south, maxlongitude=east, maxlatitude=north)

    content = json.loads(fetch(f"{CATALOG_QUERY}?{urlencode(parameters)}"))
    events = []
    for row in content["features"]:
        longitude, latitude, depth = row["geometry"]["coordinates"]
        props = row["properties"]
        events.append(CatalogEvent(
            row["id"], props["place"] or props["title"], props["mag"],
            datetime.fromtimestamp(props["time"] / 1000, UTC), latitude, longitude, depth,
        ))
    return tuple(events)


def _destination(latitude: float, longitude: float, degrees: float, bearing: float) -> StationLocation:
    lat, lon, distance, azimuth = map(math.radians, (latitude, longitude, degrees, bearing))
    sin_lat = math.sin(lat) * math.cos(distance) + math.cos(lat) * math.sin(distance) * math.cos(azimuth)
    target_lat = math.asin(max(-1.0, min(1.0, sin_lat)))
    target_lon = lon + math.atan2(
        math.sin(azimuth) * math.sin(distance) * math.cos(lat),
        math.cos(distance) - math.sin(lat) * math.sin(target_lat),
    )
    return StationLocation(math.degrees(target_lat), _longitude(math.degrees(target_lon)))


def parse_station_reports(content: bytes) -> tuple[datetime, tuple[StationReport, ...]]:
    event, origin = preferred_origin(content)
    event_time = utc(origin.findtext("{*}time/{*}value", ""))
    latitude = float(origin.findtext("{*}latitude/{*}value", ""))
    longitude = float(origin.findtext("{*}longitude/{*}value", ""))
    picks = {
        pick.get("publicID"): pick.find("{*}waveformID") for pick in event.findall("{*}pick")
    }
    phases: dict[str, set[str]] = {}
    geometry: dict[str, tuple[float, float | None]] = {}
    for arrival in origin.findall("{*}arrival"):
        waveform = picks.get(arrival.findtext("{*}pickID"))
        if waveform is None or not waveform.get("networkCode") or not waveform.get("stationCode"):
            continue
        station = f"{waveform.get('networkCode')}.{waveform.get('stationCode')}"
        labels = phases.setdefault(station, set())
        phase = arrival.findtext("{*}phase")
        if phase:
            labels.add(phase)
        distance = arrival.findtext("{*}distance")
        azimuth = arrival.findtext("{*}azimuth")
        if distance and (station not in geometry or (azimuth and geometry[station][1] is None)):
            geometry[station] = float(distance), float(azimuth) if azimuth else None

    reports = []
    for station, labels in phases.items():
        distance, azimuth = geometry.get(station, (None, None))
        location = (
            _destination(latitude, longitude, distance, azimuth)
            if distance is not None and azimuth is not None else None
        )
        distance_km = distance * math.pi / 180 * 6371.0088 if distance is not None else None
        source = "Estimated from USGS distance and bearing" if location else "Coordinates unavailable"
        reports.append(StationReport(station, tuple(sorted(labels)), distance_km, location, source))
    return event_time, tuple(
        sorted(reports, key=lambda row: (row.distance_km if row.distance_km is not None else math.inf, row.id))
    )


def reporting_stations(event_id: str, *, fetch=fetch_bytes) -> tuple[StationReport, ...]:
    detail = json.loads(fetch(f"{USGS_DETAIL}/{quote(event_id, safe='')}.geojson"))
    url = product_url(detail)
    if not url:
        return ()
    target = urlsplit(url)
    if target.scheme != "https" or target.netloc != "earthquake.usgs.gov":
        raise ValueError("USGS supplied an unsupported phase-data URL.")
    event_time, reports = parse_station_reports(fetch(url))
    try:
        # Keep the metadata query small on large earthquakes. The catalog distances
        # still locate many stations beyond this nearest group.
        metadata = station_metadata(event_time, {report.id for report in reports[:200]}, fetch)
    except (OSError, ValueError):
        metadata = {}
    return tuple(
        StationReport(row.id, row.phases, row.distance_km, metadata[row.id], "EarthScope station metadata")
        if row.id in metadata else row
        for row in reports
    )
