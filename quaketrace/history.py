"""Multi-year USGS arrival history for station clock health.

The bundled demo covers seven quakes. This module handles the larger history:
every north-east US earthquake with published phase data, and every P arrival
those solutions used. The same rows are loaded into Tiger Data, and the
monthly health view can run either in TimescaleDB or over the bundled file.
"""

from __future__ import annotations

import csv
import gzip
import io
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

from .data import DEFAULT_FIXTURES, utc
from .sources import preferred_origin

HISTORY_DIR = DEFAULT_FIXTURES / "history"
EVENTS_FILE = "events.csv"
PICKS_FILE = "picks.csv.gz"
REGION = {"minlatitude": 38.0, "maxlatitude": 45.5, "minlongitude": -80.0, "maxlongitude": -68.0}
# Events inside REGION belong to the north-east US history; everything else is "world".


def region_of(latitude: float, longitude: float) -> str:
    inside = (
        REGION["minlatitude"] <= latitude <= REGION["maxlatitude"]
        and REGION["minlongitude"] <= longitude <= REGION["maxlongitude"]
    )
    return "northeast" if inside else "world"


DEFAULT_START = "2018-01-01"
DEFAULT_END = "2026-01-01"
MIN_MAGNITUDE = 1.0
P_PHASES = ("P", "Pg", "Pn")
MAX_RESIDUAL_S = 10.0
THRESHOLD_S = 1.5
MIN_BUCKET_PICKS = 2
BASELINE_BUCKETS = 6

EVENT_FIELDS = ("event_id", "event_time", "latitude", "longitude", "depth_km", "magnitude", "place")
PICK_FIELDS = (
    "event_time", "event_id", "station_id", "location_code", "channel_code", "phase",
    "pick_time", "residual_s", "weight", "distance_deg", "azimuth_deg",
)


@dataclass(frozen=True)
class HistoryEvent:
    event_id: str
    event_time: datetime
    latitude: float
    longitude: float
    depth_km: float
    magnitude: float | None
    place: str


@dataclass(frozen=True)
class HistoryPick:
    event_time: datetime
    event_id: str
    station_id: str
    location_code: str
    channel_code: str
    phase: str
    pick_time: datetime
    residual_s: float
    weight: float
    distance_deg: float | None
    azimuth_deg: float | None


def _float(value: str | None) -> float | None:
    try:
        number = float(value) if value not in (None, "") else None
    except ValueError:
        return None
    return number if number is not None and math.isfinite(number) else None


def parse_event_picks(event_id: str, content: bytes, *, magnitude: float | None = None, place: str = ""):
    """Parse a USGS phase-data QuakeML into its origin and every arrival with a residual."""
    event, origin = preferred_origin(content)
    event_time = utc(origin.findtext("{*}time/{*}value", ""))
    record = HistoryEvent(
        event_id, event_time,
        float(origin.findtext("{*}latitude/{*}value", "")),
        float(origin.findtext("{*}longitude/{*}value", "")),
        (_float(origin.findtext("{*}depth/{*}value")) or 0.0) / 1000,
        magnitude, place,
    )
    picks = {pick.get("publicID"): pick for pick in event.findall("{*}pick")}
    best: dict[tuple[str, str], tuple[tuple, HistoryPick]] = {}
    for arrival in origin.findall("{*}arrival"):
        phase = arrival.findtext("{*}phase") or ""
        residual = _float(arrival.findtext("{*}timeResidual"))
        pick = picks.get(arrival.findtext("{*}pickID"))
        waveform = pick.find("{*}waveformID") if pick is not None else None
        if not phase or residual is None or waveform is None:
            continue
        network, station = waveform.get("networkCode"), waveform.get("stationCode")
        pick_time = pick.findtext("{*}time/{*}value")
        if not network or not station or not pick_time:
            continue
        weight = _float(arrival.findtext("{*}timeWeight")) or 0.0
        row = HistoryPick(
            event_time, event_id, f"{network}.{station}", waveform.get("locationCode") or "--",
            waveform.get("channelCode") or "", phase, utc(pick_time), residual, weight,
            _float(arrival.findtext("{*}distance")), _float(arrival.findtext("{*}azimuth")),
        )
        # One row per station and phase: the arrival the solution weighted most.
        key = (row.station_id, phase)
        priority = (-weight, row.pick_time, row.channel_code)
        if key not in best or priority < best[key][0]:
            best[key] = (priority, row)
    return record, sorted((row for _, row in best.values()), key=lambda row: (row.station_id, row.phase))


# ---------------------------------------------------------------- bundled files

def write_history(directory: Path, events: list[HistoryEvent], picks: list[HistoryPick]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / EVENTS_FILE).open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file, lineterminator="\n")
        writer.writerow(EVENT_FIELDS)
        for row in sorted(events, key=lambda event: (event.event_time, event.event_id)):
            writer.writerow((
                row.event_id, row.event_time.isoformat(), f"{row.latitude:.4f}", f"{row.longitude:.4f}",
                f"{row.depth_km:.3f}", "" if row.magnitude is None else f"{row.magnitude:.2f}", row.place,
            ))
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(PICK_FIELDS)
    for row in sorted(picks, key=lambda pick: (pick.event_time, pick.event_id, pick.station_id, pick.phase)):
        writer.writerow((
            row.event_time.isoformat(), row.event_id, row.station_id, row.location_code, row.channel_code,
            row.phase, row.pick_time.isoformat(), f"{row.residual_s:.3f}", f"{row.weight:.3f}",
            "" if row.distance_deg is None else f"{row.distance_deg:.4f}",
            "" if row.azimuth_deg is None else f"{row.azimuth_deg:.1f}",
        ))
    # mtime=0 keeps the archive byte-identical across rebuilds.
    with gzip.GzipFile(directory / PICKS_FILE, "wb", mtime=0) as file:
        file.write(buffer.getvalue().encode("utf-8"))


@dataclass(frozen=True)
class History:
    events: tuple[HistoryEvent, ...]
    picks: tuple[HistoryPick, ...]


def load_history(directory: Path = HISTORY_DIR) -> History:
    with (directory / EVENTS_FILE).open(encoding="utf-8", newline="") as file:
        events = tuple(
            HistoryEvent(
                row["event_id"], utc(row["event_time"]), float(row["latitude"]), float(row["longitude"]),
                float(row["depth_km"]), _float(row["magnitude"]), row["place"],
            )
            for row in csv.DictReader(file)
        )
    with gzip.open(directory / PICKS_FILE, "rt", encoding="utf-8", newline="") as file:
        picks = tuple(
            HistoryPick(
                utc(row["event_time"]), row["event_id"], row["station_id"], row["location_code"],
                row["channel_code"], row["phase"], utc(row["pick_time"]), float(row["residual_s"]),
                float(row["weight"]), _float(row["distance_deg"]), _float(row["azimuth_deg"]),
            )
            for row in csv.DictReader(file)
        )
    return History(events, picks)


def history_available(directory: Path = HISTORY_DIR) -> bool:
    return (directory / EVENTS_FILE).is_file() and (directory / PICKS_FILE).is_file()


# ---------------------------------------------------------------- monthly health

def month_start(moment: datetime) -> datetime:
    return datetime(moment.year, moment.month, 1, tzinfo=timezone.utc)


@dataclass(frozen=True)
class Bucket:
    month: datetime
    station_id: str
    picks: int
    mean_residual_s: float


def local_monthly_buckets(
    history: History, *, stations: list[str] | None = None,
    shifted_station: str | None = None, onset: datetime | None = None, offset_s: float = 0.0,
) -> list[Bucket]:
    """The Python twin of the Tiger query: monthly mean P residual per station."""
    sums: dict[tuple[datetime, str], list[float]] = {}
    wanted = set(stations) if stations else None
    for pick in history.picks:
        if pick.phase not in P_PHASES or abs(pick.residual_s) >= MAX_RESIDUAL_S:
            continue
        if wanted is not None and pick.station_id not in wanted:
            continue
        residual = pick.residual_s
        if offset_s and pick.station_id == shifted_station and onset and pick.event_time >= onset:
            residual += offset_s
        total = sums.setdefault((month_start(pick.event_time), pick.station_id), [0.0, 0])
        total[0] += residual
        total[1] += 1
    return [
        Bucket(month, station, int(count), total / count)
        for (month, station), (total, count) in sorted(sums.items())
    ]


def busiest_stations(history: History, limit: int) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for pick in history.picks:
        if pick.phase in P_PHASES and abs(pick.residual_s) < MAX_RESIDUAL_S:
            counts[pick.station_id] = counts.get(pick.station_id, 0) + 1
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]


@dataclass(frozen=True)
class StationHealth:
    station_id: str
    status: str  # clear | pending | flagged
    first_flag: datetime | None
    confirmed: datetime | None
    last_normal: datetime | None
    estimated_offset_s: float | None
    deviations: dict[datetime, float]  # month -> mean minus rolling baseline


def assess(series: list[Bucket]) -> StationHealth:
    """Flag two usable months in a row, same direction, at least 1.5 s from the prior baseline.

    The baseline is the median of the previous six usable months, so a real
    shift can be dated without knowing it in advance.
    """
    usable = [bucket for bucket in series if bucket.picks >= MIN_BUCKET_PICKS]
    station = series[0].station_id if series else ""
    deviations: dict[datetime, float] = {}
    history: list[float] = []
    run: list[tuple[datetime, float]] = []
    last_normal = None
    flagged = None
    settled = False  # the verdict is fixed; later months are still scored for display
    for bucket in usable:
        if len(history) >= 3:
            baseline = median(history[-BASELINE_BUCKETS:])
            deviation = bucket.mean_residual_s - baseline
            deviations[bucket.month] = deviation
            off = abs(deviation) >= THRESHOLD_S
            if settled:
                if not off:
                    history.append(bucket.mean_residual_s)
                continue
            if off:
                if run and (deviation > 0) != (run[-1][1] > 0):
                    if flagged is not None:
                        settled = True
                        continue
                    run = []
                run.append((bucket.month, deviation))
                if len(run) >= 2 and flagged is None:
                    flagged = list(run)
                # Keep shifted months out of the baseline.
                continue
            if flagged is not None:
                settled = True
                history.append(bucket.mean_residual_s)
                continue
            run.clear()
            last_normal = bucket.month
        history.append(bucket.mean_residual_s)
    if flagged:
        return StationHealth(
            station, "flagged", flagged[0][0], flagged[1][0], last_normal,
            median(value for _, value in run), deviations,
        )
    if run:
        return StationHealth(station, "pending", run[0][0], None, last_normal, None, deviations)
    return StationHealth(station, "clear", None, None, last_normal, None, deviations)
