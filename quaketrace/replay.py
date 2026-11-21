"""Fit Pg arrival times and diagnose a single suspect reading."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .data import StationLocation

LATITUDE_ORIGIN = 40.8
LONGITUDE_ORIGIN = -74.65
KM_PER_DEGREE = 111.195
KM_PER_LONGITUDE = KM_PER_DEGREE * np.cos(np.radians(LATITUDE_ORIGIN))
DEPTH_KM = 5
SPEED_KM_S = 6


def project(latitude, longitude):
    """Return east and north distances in kilometres on a local plane."""
    return (
        (longitude - LONGITUDE_ORIGIN) * KM_PER_LONGITUDE,
        (latitude - LATITUDE_ORIGIN) * KM_PER_DEGREE,
    )


def unproject(east: float, north: float) -> StationLocation:
    return StationLocation(
        LATITUDE_ORIGIN + north / KM_PER_DEGREE,
        LONGITUDE_ORIGIN + east / KM_PER_LONGITUDE,
    )


def distance_km(first: StationLocation, second: StationLocation) -> float:
    """Great-circle distance between two epicentres."""
    lat1, lat2 = np.radians([first.latitude, second.latitude])
    dlon = np.radians(second.longitude - first.longitude)
    haversine = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return float(2 * 6371.0088 * np.arcsin(np.sqrt(np.clip(haversine, 0, 1))))


@dataclass(frozen=True)
class Reading:
    station_id: str
    location: StationLocation
    time_s: float


@dataclass(frozen=True)
class Fit:
    location: StationLocation
    origin_s: float
    rms_s: float
    residuals_s: dict[str, float]
    at_boundary: bool


@dataclass(frozen=True)
class Candidate:
    station_id: str
    fit: Fit
    offset_s: float


@dataclass(frozen=True)
class ReplayResult:
    status: str
    all_stations: Fit | None = None
    candidate: Candidate | None = None


X_MIN, Y_MIN = project(40.0, -75.7)
X_MAX, Y_MAX = project(41.6, -73.6)


def _axis(low: float, high: float, step: float) -> np.ndarray:
    return np.append(np.arange(low, high, step), high)


def _points(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    xx, yy = np.meshgrid(x, y)
    return np.column_stack((xx.ravel(), yy.ravel()))


COARSE_GRID = _points(_axis(X_MIN, X_MAX, 2), _axis(Y_MIN, Y_MAX, 2))


def _best(points: np.ndarray, positions: np.ndarray, times: np.ndarray):
    differences = points[:, None, :] - positions[None, :, :]
    travel_times = np.sqrt(np.sum(differences ** 2, axis=2) + DEPTH_KM ** 2) / SPEED_KM_S
    implied_origins = times - travel_times
    origins = implied_origins.mean(axis=1)
    errors = implied_origins - origins[:, None]
    mse = np.mean(errors ** 2, axis=1)
    index = int(np.argmin(mse))
    return points[index], float(origins[index]), float(np.sqrt(mse[index])), errors[index]


def fit_location(readings: tuple[Reading, ...]) -> Fit:
    ids = [reading.station_id for reading in readings]
    if len(ids) < 4 or len(set(ids)) != len(ids):
        raise ValueError("Location fitting needs four or more distinct station readings.")
    positions = np.array([
        project(reading.location.latitude, reading.location.longitude) for reading in readings
    ])
    times = np.array([reading.time_s for reading in readings])
    if not np.all(np.isfinite(positions)) or not np.all(np.isfinite(times)):
        raise ValueError("Location fitting needs finite coordinates and pick times.")
    reference = float(times.min())
    centre, *_ = _best(COARSE_GRID, positions, times - reference)
    east, north = centre
    fine_grid = _points(
        _axis(max(X_MIN, east - 3), min(X_MAX, east + 3), 0.25),
        _axis(max(Y_MIN, north - 3), min(Y_MAX, north + 3), 0.25),
    )
    (east, north), origin, rms, errors = _best(
        np.vstack((fine_grid, centre)), positions, times - reference
    )
    boundary_distance = min(east - X_MIN, X_MAX - east, north - Y_MIN, Y_MAX - north)
    return Fit(
        unproject(east, north), origin + reference, rms,
        dict(zip(ids, map(float, errors), strict=True)), boundary_distance < 0.25,
    )


def diagnose(readings: tuple[Reading, ...]) -> ReplayResult:
    if len(readings) < 5:
        return ReplayResult("insufficient")
    full = fit_location(readings)
    if full.at_boundary:
        return ReplayResult("inconclusive", full)

    candidates = []
    for index, reading in enumerate(readings):
        fit = fit_location(readings[:index] + readings[index + 1:])
        x, y = project(fit.location.latitude, fit.location.longitude)
        sx, sy = project(reading.location.latitude, reading.location.longitude)
        predicted = fit.origin_s + np.sqrt((x - sx) ** 2 + (y - sy) ** 2 + DEPTH_KM ** 2) / SPEED_KM_S
        offset = float(reading.time_s - predicted)
        candidates.append(Candidate(reading.station_id, fit, offset))

    candidates.sort(key=lambda candidate: candidate.fit.rms_s)
    best = candidates[0]
    if best.fit.at_boundary or abs(best.offset_s) < 1.5 or best.fit.rms_s > 0.65 * full.rms_s:
        return ReplayResult("inconclusive", full)
    for other in candidates[1:]:
        if other.fit.rms_s - best.fit.rms_s >= 0.10:
            break
        if abs(other.offset_s) >= 1.5 and other.fit.rms_s <= 0.65 * full.rms_s:
            return ReplayResult("inconclusive", full)
    return ReplayResult("flagged", full, best)
