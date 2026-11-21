"""Shared parsing for USGS event products and EarthScope station metadata."""

from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode
from xml.etree import ElementTree

from .data import StationLocation

USGS_DETAIL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail"
EARTHSCOPE = "https://service.earthscope.org/fdsnws"


def product_url(detail: dict) -> str | None:
    products = detail["properties"]["products"].get("phase-data", [])
    available = [
        product for product in products
        if product.get("status") != "DELETE"
        and product.get("contents", {}).get("quakeml.xml", {}).get("url")
    ]
    if not available:
        return None
    preferred = max(
        available, key=lambda product: (product.get("preferredWeight", 0), product.get("updateTime", 0))
    )
    return preferred["contents"]["quakeml.xml"]["url"]


def preferred_origin(content: bytes):
    root = ElementTree.fromstring(content)
    event = root.find("./{*}eventParameters/{*}event")
    if event is None:
        raise ValueError("QuakeML is missing its event.")
    preferred = event.findtext("{*}preferredOriginID")
    origin = next(
        (node for node in event.findall("{*}origin") if node.get("publicID") == preferred), None
    )
    if not preferred or origin is None:
        raise ValueError("QuakeML is missing its preferred origin.")
    return event, origin


def _epoch(value: str) -> datetime:
    timestamp = datetime.fromisoformat(value)
    return timestamp if timestamp.tzinfo else timestamp.replace(tzinfo=UTC)


def station_metadata(
    event_time: datetime, station_ids: set[str], fetch,
) -> dict[str, StationLocation]:
    if not station_ids:
        return {}
    networks, names = zip(*(station.split(".", 1) for station in station_ids))
    query = urlencode({
        "net": ",".join(sorted(set(networks))), "sta": ",".join(sorted(set(names))),
        "starttime": event_time.isoformat(), "endtime": (event_time + timedelta(seconds=1)).isoformat(),
        "level": "station", "format": "text",
    })
    content = fetch(f"{EARTHSCOPE}/station/1/query?{query}").decode("utf-8")
    eligible: dict[str, tuple[datetime, StationLocation]] = {}
    for line in content.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        net, sta, latitude, longitude, _, name, start, end = line.split("|")
        station_id = f"{net}.{sta}"
        if station_id not in station_ids:
            continue
        begin = _epoch(start)
        if begin > event_time or (end and _epoch(end) <= event_time):
            continue
        if station_id not in eligible or begin > eligible[station_id][0]:
            eligible[station_id] = (begin, StationLocation(float(latitude), float(longitude), name))
    return {station: row[1] for station, row in eligible.items()}
