"""Shared data model and offline fixture loader."""

from __future__ import annotations

import csv
import json
import logging
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from os import getenv
from pathlib import Path

MAINSHOCK = "us7000ma74"
BASELINE_EVENTS = (MAINSHOCK, "us7000maaw", "us7000mab9")
EVALUATION_EVENTS = ("us7000mb70", "us6000mub7", "us6000mvg6", "us6000n0ne")
AUDIT_STATIONS = ("PE.PSUB", "LD.NPNY", "LD.BRNY", "LD.FOR", "N4.L59A", "LD.PAL")
REPLAY_STATIONS = AUDIT_STATIONS + ("PE.PAPL", "N4.N58A", "N4.P61A")
WAVEFORM_STATION = "LD.PAL"
DEFAULT_FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
TIGER_DSN_ENV = "QUAKETRACE_TIGER_DSN"
logger = logging.getLogger(__name__)


def utc(value: str) -> datetime:
    timestamp = datetime.fromisoformat(value)
    if timestamp.tzinfo is None:
        raise ValueError(f"Timestamp lacks a UTC offset: {value}")
    return timestamp.astimezone(timezone.utc)


@dataclass(frozen=True)
class Event:
    id: str
    time: datetime
    latitude: float
    longitude: float
    depth_km: float


@dataclass(frozen=True)
class StationLocation:
    latitude: float
    longitude: float
    name: str = ""


@dataclass(frozen=True)
class Arrival:
    event_id: str
    station_id: str
    phase: str
    pick_time: datetime
    residual_s: float
    weight: float
    location_code: str
    channel_code: str


@dataclass(frozen=True)
class Fixture:
    events: dict[str, Event]
    stations: dict[tuple[str, str], StationLocation]
    arrivals: tuple[Arrival, ...]
    waveform: tuple[tuple[datetime, int], ...]
    outlines: dict
    arrival_source: str = "bundled"


def load_fixture(directory: Path = DEFAULT_FIXTURES, *, use_tiger: bool = True) -> Fixture:
    def read_json(name: str):
        return json.loads((directory / name).read_text(encoding="utf-8"))

    events = {
        row["id"]: Event(
            row["id"], utc(row["time"]), row["latitude"], row["longitude"], row["depth_km"]
        )
        for row in read_json("events.json")
    }
    stations = {
        (row["event_id"], row["station_id"]): StationLocation(
            row["latitude"], row["longitude"], row.get("name", "")
        )
        for row in read_json("stations.json")
    }
    arrivals = tuple(
        Arrival(
            row["event_id"], row["station_id"], row["phase"], utc(row["pick_time"]),
            row["residual_s"], row["weight"], row["location_code"], row["channel_code"],
        )
        for row in read_json("arrivals.json")
    )
    with (directory / "waveform.csv").open(encoding="utf-8", newline="") as file:
        waveform = tuple(
            (utc(row["time"]), int(row["counts"])) for row in csv.DictReader(file)
        )
    fixture = Fixture(events, stations, arrivals, waveform, read_json("outlines.geojson"))
    dsn = getenv(TIGER_DSN_ENV) if use_tiger and directory == DEFAULT_FIXTURES else None
    if not dsn:
        return fixture

    from .tiger import TigerDataError, read_demo_arrivals

    try:
        database_arrivals = read_demo_arrivals(dsn, fixture)
    except TigerDataError as error:
        logger.warning("Using bundled arrival data: %s", error)
        return fixture
    return replace(fixture, arrivals=database_arrivals, arrival_source="tiger")
