"""JSON payloads for the QuakeTrace web UI."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from time import perf_counter

import numpy as np

from .audit import THRESHOLD_S, audit
from .data import (
    AUDIT_STATIONS, BASELINE_EVENTS, EVALUATION_EVENTS, MAINSHOCK, WAVEFORM_STATION, Fixture,
)
from .replay import (
    KM_PER_DEGREE, KM_PER_LONGITUDE, SPEED_KM_S, DEPTH_KM, Fit, Reading, diagnose, distance_km,
    fit_location, leave_one_out, misfit_surface, project, travel_time_s, unproject,
)

MAINSHOCK_MAGNITUDE = 4.8
ZONE_RADIUS_KM = 60
ZONE_STEP_KM = 1.0
ZONE_MARGIN_S = 1.0
MAX_SHIFT_S = 10.0
CITIES = (
    ("Newark", 40.7357, -74.1724),
    ("New York", 40.7128, -74.0060),
    ("Philadelphia", 39.9526, -75.1652),
    ("Trenton", 40.2206, -74.7597),
    ("Allentown", 40.6023, -75.4714),
)


def short_name(station_id: str) -> str:
    return station_id.split(".", 1)[-1]


def _round(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(float(value), digits)


def _date(fixture: Fixture, event_id: str | None, pattern: str = "%b %-d") -> str | None:
    if not event_id:
        return None
    moment: datetime = fixture.events[event_id].time
    # %-d is not portable; strip the zero manually.
    return moment.strftime(pattern.replace("%-d", str(moment.day)))


def event_ids(fixture: Fixture) -> list[str]:
    return sorted(fixture.events, key=lambda event_id: fixture.events[event_id].time)


def readings_for(fixture: Fixture, event_id: str) -> tuple[tuple[Reading, ...], datetime]:
    arrivals = [row for row in fixture.arrivals if row.event_id == event_id]
    reference = min(row.pick_time for row in arrivals)
    return tuple(
        Reading(row.station_id, fixture.stations[(event_id, row.station_id)],
                (row.pick_time - reference).total_seconds())
        for row in arrivals
    ), reference


def shift_readings(readings: tuple[Reading, ...], station: str | None, offset_s: float):
    return tuple(
        replace(reading, time_s=reading.time_s + offset_s) if reading.station_id == station else reading
        for reading in readings
    )


def _zone(readings: tuple[Reading, ...], fit: Fit) -> dict:
    """Misfit grid around a fit, as the teal best-fit zone."""
    east0, north0 = project(fit.location.latitude, fit.location.longitude)
    steps = np.arange(-ZONE_RADIUS_KM, ZONE_RADIUS_KM + ZONE_STEP_KM / 2, ZONE_STEP_KM)
    east, north = east0 + steps, north0 + steps
    surface = misfit_surface(readings, east, north)
    excess = surface - surface.min()
    inside = np.argwhere(excess <= ZONE_MARGIN_S)
    if len(inside):
        coords = np.column_stack((east[inside[:, 1]], north[inside[:, 0]]))
        centred = coords - coords.mean(axis=0)
        _, _, axes = np.linalg.svd(centred, full_matrices=False)
        along = centred @ axes[0]
        length = float(along.max() - along.min() + ZONE_STEP_KM)
        hull = [[_round(p.latitude, 5), _round(p.longitude, 5)]
                for p in (unproject(*coords[i]) for i in _convex_hull(coords))]
    else:
        length, hull = 0.0, []
    south_west = unproject(east[0] - ZONE_STEP_KM / 2, north[0] - ZONE_STEP_KM / 2)
    north_east = unproject(east[-1] + ZONE_STEP_KM / 2, north[-1] + ZONE_STEP_KM / 2)
    return {
        "bounds": {
            "south": _round(south_west.latitude, 5), "west": _round(south_west.longitude, 5),
            "north": _round(north_east.latitude, 5), "east": _round(north_east.longitude, 5),
        },
        "cols": len(east), "rows": len(north),
        # Row 0 is the southern edge.
        "excess": [round(float(value), 2) for value in excess.ravel()],
        "marginS": ZONE_MARGIN_S,
        "hull": hull,
        "lengthKm": round(length, 1),
    }


def _convex_hull(points: np.ndarray) -> list[int]:
    order = sorted(range(len(points)), key=lambda i: (points[i][0], points[i][1]))
    if len(order) < 3:
        return order

    def cross(o, a, b):
        return (points[a][0] - points[o][0]) * (points[b][1] - points[o][1]) - \
            (points[a][1] - points[o][1]) * (points[b][0] - points[o][0])

    lower, upper = [], []
    for i in order:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], i) <= 0:
            lower.pop()
        lower.append(i)
    for i in reversed(order):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], i) <= 0:
            upper.pop()
        upper.append(i)
    return lower[:-1] + upper[:-1]


def _fit_json(fit: Fit, readings: tuple[Reading, ...] | None = None) -> dict:
    payload = {
        "lat": _round(fit.location.latitude, 5),
        "lon": _round(fit.location.longitude, 5),
        "rmsS": _round(fit.rms_s),
        "residualsS": {station: _round(value) for station, value in fit.residuals_s.items()},
        "atBoundary": bool(fit.at_boundary),
    }
    if readings is not None:
        payload["zone"] = _zone(readings, fit)
    return payload


def overview(fixture: Fixture) -> dict:
    """Static fixture facts: events, stations, outlines, and reference cities."""
    events = []
    for event_id in event_ids(fixture):
        event = fixture.events[event_id]
        stations = [row.station_id for row in fixture.arrivals if row.event_id == event_id]
        events.append({
            "id": event_id,
            "time": event.time.isoformat(),
            "label": f"{_date(fixture, event_id, '%b %-d')} · {event.time:%H:%M} UTC",
            "lat": event.latitude, "lon": event.longitude, "depthKm": event.depth_km,
            "magnitude": MAINSHOCK_MAGNITUDE if event_id == MAINSHOCK else None,
            "isMainshock": event_id == MAINSHOCK,
            "stations": stations,
            "role": "baseline" if event_id in BASELINE_EVENTS else "evaluation",
        })
    return {
        "events": events,
        "mainshock": MAINSHOCK,
        "waveformStation": WAVEFORM_STATION,
        "auditStations": list(AUDIT_STATIONS),
        "evaluationEvents": list(EVALUATION_EVENTS),
        "baselineEvents": list(BASELINE_EVENTS),
        "thresholdS": THRESHOLD_S,
        "model": {"speedKmS": SPEED_KM_S, "depthKm": DEPTH_KM},
        "arrivalSource": fixture.arrival_source,
        "outlines": fixture.outlines,
        "cities": [{"name": name, "lat": lat, "lon": lon} for name, lat, lon in CITIES],
    }


def replay(fixture: Fixture, event_id: str, station: str | None, offset_s: float) -> dict:
    """Clean fit, tampered fit, leave-one-out investigation, and scoring for one scenario."""
    started = perf_counter()
    if event_id not in fixture.events:
        raise ValueError(f"Unknown event: {event_id}")
    if not -MAX_SHIFT_S <= offset_s <= MAX_SHIFT_S:
        raise ValueError(f"Shift must be within ±{MAX_SHIFT_S:g} s.")
    event = fixture.events[event_id]
    readings, reference = readings_for(fixture, event_id)
    ids = [reading.station_id for reading in readings]
    if offset_s and station not in ids:
        raise ValueError(f"{station} did not record {event_id}.")
    tampered_readings = shift_readings(readings, station, offset_s)

    clean = fit_location(readings)
    result = diagnose(tampered_readings)
    tampered = result.all_stations or fit_location(tampered_readings)
    candidate = result.candidate
    runs = leave_one_out(tampered_readings) if len(readings) >= 5 else []

    # Travel-time view: anchor to the refit without the suspect when one exists.
    anchor = candidate.fit if candidate else tampered
    origin_offset = (reference - event.time).total_seconds()
    travel = []
    for reading in tampered_readings:
        hypo = float(np.sqrt(distance_km(anchor.location, reading.location) ** 2 + DEPTH_KM ** 2))
        travel.append({
            "station": reading.station_id,
            "distanceKm": round(hypo, 2),
            "timeS": _round(reading.time_s - anchor.origin_s),
            "predictedS": _round(travel_time_s(anchor.location, reading.location)),
        })

    stations = []
    for reading, tampered_reading in zip(readings, tampered_readings, strict=True):
        location = reading.location
        stations.append({
            "id": reading.station_id,
            "short": short_name(reading.station_id),
            "name": location.name,
            "lat": location.latitude, "lon": location.longitude,
            "distanceKm": round(distance_km(location, event), 1),
            "arrivalS": _round(reading.time_s + origin_offset),
            "tamperedArrivalS": _round(tampered_reading.time_s + origin_offset),
        })
    stations.sort(key=lambda row: row["distanceKm"])

    clean_zone = _fit_json(clean, readings)
    tampered_zone = _fit_json(tampered, tampered_readings)
    payload = {
        "event": {
            "id": event_id, "time": event.time.isoformat(),
            "lat": event.latitude, "lon": event.longitude, "depthKm": event.depth_km,
            "magnitude": MAINSHOCK_MAGNITUDE if event_id == MAINSHOCK else None,
        },
        "scenario": {"station": station if offset_s else None, "offsetS": offset_s},
        "status": result.status,
        "stations": stations,
        "clean": clean_zone,
        "tampered": tampered_zone,
        "candidate": None,
        "runs": [
            {
                "station": run.station_id, "rmsS": _round(run.fit.rms_s), "offsetS": _round(run.offset_s),
                "lat": _round(run.fit.location.latitude, 5), "lon": _round(run.fit.location.longitude, 5),
            }
            for run in runs
        ],
        "travel": {"anchor": "candidate" if candidate else "all", "points": travel},
        "movedKm": round(distance_km(clean.location, tampered.location), 2),
        "zoneRatio": (
            round(tampered_zone["zone"]["lengthKm"] / clean_zone["zone"]["lengthKm"], 2)
            if clean_zone["zone"]["lengthKm"] else None
        ),
        "usgsKm": {
            "clean": round(distance_km(clean.location, event), 2),
            "all": round(distance_km(tampered.location, event), 2),
            "excluded": round(distance_km(candidate.fit.location, event), 2) if candidate else None,
        },
        "gridKm": ZONE_STEP_KM,
    }
    if candidate:
        payload["candidate"] = {
            "station": candidate.station_id,
            "offsetS": _round(candidate.offset_s),
            "fit": _fit_json(candidate.fit, tuple(r for r in tampered_readings if r.station_id != candidate.station_id)),
            "correct": bool(offset_s) and candidate.station_id == station,
        }
    payload["elapsedMs"] = round((perf_counter() - started) * 1000, 1)
    return payload


def waveform(fixture: Fixture, points: int = 700) -> dict:
    """Downsampled min/max envelope of the LD.PAL vertical trace, in seconds after origin."""
    event = fixture.events[MAINSHOCK]
    times = np.array([(moment - event.time).total_seconds() for moment, _ in fixture.waveform])
    counts = np.array([value for _, value in fixture.waveform], dtype=float)
    counts -= np.median(counts)
    buckets = np.array_split(np.arange(len(times)), max(1, points // 2))
    trace = []
    for bucket in buckets:
        if not len(bucket):
            continue
        lo, hi = bucket[np.argmin(counts[bucket])], bucket[np.argmax(counts[bucket])]
        for index in sorted((lo, hi)):
            trace.append([round(float(times[index]), 3), round(float(counts[index]), 1)])
    pick = next(row for row in fixture.arrivals if row.event_id == MAINSHOCK and row.station_id == WAVEFORM_STATION)
    channel = pick.channel_code or "HHZ"
    return {
        "station": WAVEFORM_STATION, "channel": channel,
        "pickS": round((pick.pick_time - event.time).total_seconds(), 3),
        "peak": float(np.max(np.abs(counts))) or 1.0,
        "trace": trace,
    }


def audit_view(fixture: Fixture, station: str | None, onset: str | None, offset_s: float) -> dict:
    started = perf_counter()
    if not -MAX_SHIFT_S <= offset_s <= MAX_SHIFT_S:
        raise ValueError(f"Shift must be within ±{MAX_SHIFT_S:g} s.")
    results = audit(fixture.arrivals, shifted_station=station, onset_event=onset, offset_s=offset_s)
    events = list(BASELINE_EVENTS + EVALUATION_EVENTS)
    shifted_events = set(EVALUATION_EVENTS[EVALUATION_EVENTS.index(onset):]) if offset_s and onset else set()
    rows = []
    for station_id in AUDIT_STATIONS:
        result = results[station_id]
        rows.append({
            "station": station_id, "short": short_name(station_id), "status": result.status,
            "baselineS": _round(result.baseline_s),
            "deviationsS": [_round(result.deviations_s[event], 2) for event in events],
            "supporting": list(result.supporting_events),
            "firstSuspicious": result.first_suspicious_event,
            "confirming": result.confirming_event,
            "lastNormal": result.last_normal_event,
            "estimatedOffsetS": _round(result.estimated_offset_s, 2),
            "simulated": [bool(offset_s) and station_id == station and event in shifted_events for event in events],
        })
    flagged = [row for row in rows if row["status"] == "flagged"]
    pending = [row for row in rows if row["status"] == "pending"]
    return {
        "events": [
            {"id": event, "label": _date(fixture, event), "time": fixture.events[event].time.isoformat(),
             "role": "baseline" if event in BASELINE_EVENTS else "evaluation"}
            for event in events
        ],
        "scenario": {"station": station if offset_s else None, "onset": onset if offset_s else None, "offsetS": offset_s},
        "stations": rows,
        "flagged": [row["station"] for row in flagged],
        "pending": [row["station"] for row in pending],
        "thresholdS": THRESHOLD_S,
        "arrivalSource": fixture.arrival_source,
        "elapsedMs": round((perf_counter() - started) * 1000, 1),
    }
