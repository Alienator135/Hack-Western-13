"""Fetch the public sources and regenerate the offline demo fixture."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quaketrace.data import (
    AUDIT_STATIONS, BASELINE_EVENTS, DEFAULT_FIXTURES, EVALUATION_EVENTS, MAINSHOCK,
    REPLAY_STATIONS, WAVEFORM_STATION, utc,
)
from quaketrace.sources import EARTHSCOPE, USGS_DETAIL, preferred_origin, product_url, station_metadata

NATURAL_EARTH = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.1/geojson"
OUTLINE_URL = f"{NATURAL_EARTH}/ne_110m_admin_1_states_provinces.geojson"
COUNTRIES_URL = f"{NATURAL_EARTH}/ne_50m_admin_0_countries.geojson"
STATE_CODES = {"NJ", "NY", "PA", "CT", "DE", "MA", "MD", "RI"}


def parse_quakeml(event_id: str, content: bytes, station_ids: tuple[str, ...]):
    event, origin = preferred_origin(content)
    catalog = {
        "id": event_id,
        "time": utc(origin.findtext("{*}time/{*}value", "")).isoformat(),
        "latitude": float(origin.findtext("{*}latitude/{*}value", "")),
        "longitude": float(origin.findtext("{*}longitude/{*}value", "")),
        "depth_km": float(origin.findtext("{*}depth/{*}value", "")) / 1000,
    }
    picks = {pick.get("publicID"): pick for pick in event.findall("{*}pick")}
    selected = {}
    for arrival in origin.findall("{*}arrival"):
        if arrival.findtext("{*}phase") != "Pg":
            continue
        weight = float(arrival.findtext("{*}timeWeight") or 0)
        if not math.isfinite(weight) or weight <= 0:
            continue
        pick_id = arrival.findtext("{*}pickID")
        pick = picks.get(pick_id)
        channel = pick.find("{*}waveformID") if pick is not None else None
        if channel is None:
            continue
        station_id = f"{channel.get('networkCode')}.{channel.get('stationCode')}"
        if station_id not in station_ids:
            continue
        residual = float(arrival.findtext("{*}timeResidual") or "nan")
        if not math.isfinite(residual):
            continue
        timestamp = utc(pick.findtext("{*}time/{*}value", ""))
        row = {
            "event_id": event_id,
            "station_id": station_id,
            "phase": "Pg",
            "pick_time": timestamp.isoformat(),
            "residual_s": residual,
            "weight": weight,
            "location_code": channel.get("locationCode") or "--",
            "channel_code": channel.get("channelCode", ""),
        }
        priority = (-weight, timestamp, pick_id)
        if station_id not in selected or priority < selected[station_id][0]:
            selected[station_id] = (priority, row)

    missing = set(station_ids) - selected.keys()
    if missing:
        raise ValueError(f"{event_id}: missing valid Pg arrivals for {', '.join(sorted(missing))}")
    return catalog, [selected[station][1] for station in station_ids]


def station_locations(event: dict, station_ids: tuple[str, ...], fetch):
    eligible = station_metadata(utc(event["time"]), set(station_ids), fetch)
    missing = set(station_ids) - eligible.keys()
    if missing:
        raise ValueError(f"{event['id']}: missing station epochs for {', '.join(sorted(missing))}")
    return [
        {
            "event_id": event["id"], "station_id": station, "latitude": eligible[station].latitude,
            "longitude": eligible[station].longitude, "name": eligible[station].name,
        }
        for station in station_ids
    ]


def waveform_csv(pick: dict, fetch) -> str:
    network, station = pick["station_id"].split(".")
    query = urlencode({
        "net": network, "sta": station, "loc": pick["location_code"], "cha": pick["channel_code"],
        "starttime": "2024-04-05T14:23:25", "endtime": "2024-04-05T14:23:50", "format": "geocsv",
    })
    content = fetch(f"{EARTHSCOPE}/dataselect/1/query?{query}").decode("utf-8")
    lines = [line for line in content.splitlines() if line.strip() and not line.startswith("#")]
    rows = [
        (utc(row[0]), int(row[1]))
        for row in csv.reader(lines[1:], skipinitialspace=True)
    ]
    pick_time = utc(pick["pick_time"])
    if not rows or not rows[0][0] < pick_time < rows[-1][0]:
        raise ValueError("EarthScope waveform does not span the measured pick.")
    out = io.StringIO(newline="")
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(("time", "counts"))
    writer.writerows((time.isoformat(), sample) for time, sample in rows)
    return out.getvalue()


def fetch_fixtures(output: Path) -> None:
    sources = {}

    def fetch(url: str) -> bytes:
        request = Request(url, headers={"User-Agent": "QuakeTrace/1.0 public-data fixture builder"})
        with urlopen(request, timeout=25) as response:
            content = response.read()
            sources[url] = {
                "resolved_url": response.url,
                "retrieved_utc": datetime.now(UTC).isoformat(),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        return content

    events, stations, arrivals = [], [], []
    phase_sources = {}
    for event_id in BASELINE_EVENTS + EVALUATION_EVENTS:
        station_ids = REPLAY_STATIONS if event_id == MAINSHOCK else AUDIT_STATIONS
        detail = json.loads(fetch(f"{USGS_DETAIL}/{event_id}.geojson"))
        phase_source = product_url(detail)
        if not phase_source:
            raise ValueError(f"{event_id}: missing active USGS phase-data product")
        phase_sources[event_id] = phase_source
        origin, picks = parse_quakeml(event_id, fetch(phase_source), station_ids)
        events.append(origin)
        stations.extend(station_locations(origin, station_ids, fetch))
        arrivals.extend(picks)
        print(f"{event_id}: {len(picks)} Pg arrivals", flush=True)

    waveform_pick = next(
        row for row in arrivals if row["event_id"] == MAINSHOCK and row["station_id"] == WAVEFORM_STATION
    )
    waveform = waveform_csv(waveform_pick, fetch)
    state_shapes = json.loads(fetch(OUTLINE_URL))
    outlines = {"type": "FeatureCollection", "features": [
        {
            "type": "Feature",
            "properties": {"name": feature["properties"]["name"], "postal": feature["properties"]["postal"]},
            "geometry": feature["geometry"],
        }
        for feature in state_shapes["features"] if feature["properties"].get("postal") in STATE_CODES
    ]}
    if {feature["properties"]["postal"] for feature in outlines["features"]} != STATE_CODES:
        raise ValueError("Natural Earth is missing one or more regional outlines.")

    country_shapes = json.loads(fetch(COUNTRIES_URL))
    countries = {"type": "FeatureCollection", "features": [
        {
            "type": "Feature",
            "properties": {"name": feature["properties"]["ADMIN"]},
            "geometry": feature["geometry"],
        }
        for feature in country_shapes["features"]
    ]}
    files = {
        "events.json": json.dumps(events, indent=2) + "\n",
        "stations.json": json.dumps(stations, indent=2) + "\n",
        "arrivals.json": json.dumps(arrivals, indent=2) + "\n",
        "waveform.csv": waveform,
        "outlines.geojson": json.dumps(outlines, separators=(",", ":")) + "\n",
        "countries.geojson": json.dumps(countries, separators=(",", ":")) + "\n",
    }
    manifest = {
        "schema_version": 1, "phase_data_by_event": phase_sources, "sources": sources,
        "files": {name: hashlib.sha256(value.encode("utf-8")).hexdigest() for name, value in files.items()},
    }
    files["manifest.json"] = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".fetch-", dir=output) as temporary:
        staging = Path(temporary)
        for name, value in files.items():
            (staging / name).write_text(value, encoding="utf-8", newline="\n")
        for name in files:
            (staging / name).replace(output / name)
    print(f"Wrote {len(arrivals)} arrivals and {len(stations)} station epochs to {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_FIXTURES)
    fetch_fixtures(parser.parse_args().output)
