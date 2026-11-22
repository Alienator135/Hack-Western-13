"""Benchmark: QuakeTrace against standard locators on hundreds of real quakes.

Every north-east US quake in the bundled history with enough nearby P readings
is relocated three ways, with and without a simulated clock error on one
random station:

* naive: least squares over every reading, equal weights.
* weighted: residual-weighted refits, as standard locators do. Readings that
  fit within 0.5 s keep full weight, readings off by 1.5 s or more get none,
  with a cosine taper between, iterated from the naive fit.
* quaketrace: the app's leave-one-out check. When it flags a station, that
  station is excluded; otherwise its answer is the naive fit.

Each estimate is scored by its distance from the USGS epicentre. The model and
flag rules are the app's own (6 km/s, 5 km depth, a 2 km grid refined to 250 m,
1.5 s offset, 0.65 RMS ratio, 0.10 s ambiguity margin). The grid is centred on
the first station to record each quake rather than on the fixed Tewksbury box,
so any north-east quake can be located without looking at the answer.

Station coordinates are not in the history bundle. Each reading records its
distance and azimuth from the USGS epicentre, so every station's position is
rebuilt from all of its readings and averaged.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import UTC, datetime
from statistics import mean, median

import numpy as np

from .data import StationLocation
from .history import History
from .replay import DEPTH_KM, KM_PER_DEGREE, SPEED_KM_S, distance_km

PHASES = ("P", "Pg")
MAX_DISTANCE_DEG = 1.5
MIN_STATIONS = 6
MAX_RESIDUAL_S = 10.0
HALF_WIDTH_KM = 150.0
COARSE_KM = 2.0
FINE_KM = 0.25
FINE_HALF_KM = 3.0
SHIFTS_S = (0.0, 1.0, 2.0, 3.0, 5.0)
SEED = 13
WEIGHT_FULL_S = 0.5
WEIGHT_ZERO_S = 1.5
WEIGHT_ITERATIONS = 4
# The app's diagnose() rules.
FLAG_OFFSET_S = 1.5
FLAG_RMS_RATIO = 0.65
AMBIGUITY_S = 0.10
METHODS = ("naive", "weighted", "quaketrace")


# ---------------------------------------------------------------- data

@dataclass(frozen=True)
class Quake:
    event_id: str
    time: datetime
    latitude: float
    longitude: float
    magnitude: float | None
    place: str
    station_ids: tuple[str, ...]
    stations: tuple[StationLocation, ...]
    times_s: np.ndarray  # pick time minus USGS origin time, per station


def _destination(latitude: float, longitude: float, distance_deg: float, azimuth_deg: float) -> tuple[float, float]:
    """Point reached travelling distance_deg along azimuth_deg on a sphere."""
    lat1, lon1 = math.radians(latitude), math.radians(longitude)
    delta, theta = math.radians(distance_deg), math.radians(azimuth_deg)
    lat2 = math.asin(math.sin(lat1) * math.cos(delta) + math.cos(lat1) * math.sin(delta) * math.cos(theta))
    lon2 = lon1 + math.atan2(
        math.sin(theta) * math.sin(delta) * math.cos(lat1), math.cos(delta) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), (math.degrees(lon2) + 540) % 360 - 180


def station_positions(history: History) -> dict[str, StationLocation]:
    """Each station's position, rebuilt from every reading's distance and azimuth and averaged."""
    events = {event.event_id: event for event in history.events}
    sums: dict[str, list[float]] = {}
    for pick in history.picks:
        event = events.get(pick.event_id)
        if event is None or pick.distance_deg is None or pick.azimuth_deg is None:
            continue
        lat, lon = _destination(event.latitude, event.longitude, pick.distance_deg, pick.azimuth_deg)
        total = sums.setdefault(pick.station_id, [0.0, 0.0, 0])
        total[0] += lat
        total[1] += lon
        total[2] += 1
    return {station: StationLocation(lat / n, lon / n) for station, (lat, lon, n) in sums.items()}


def benchmark_quakes(history: History, *, max_distance_deg: float = MAX_DISTANCE_DEG,
                     min_stations: int = MIN_STATIONS) -> list[Quake]:
    """Quakes with at least min_stations P readings within max_distance_deg, oldest first."""
    positions = station_positions(history)
    readings: dict[str, dict[str, object]] = {}
    for pick in history.picks:
        if (pick.phase not in PHASES or pick.distance_deg is None or pick.distance_deg > max_distance_deg
                or abs(pick.residual_s) >= MAX_RESIDUAL_S or pick.station_id not in positions):
            continue
        best = readings.setdefault(pick.event_id, {})
        # One reading per station: the earliest P.
        if pick.station_id not in best or pick.pick_time < best[pick.station_id].pick_time:
            best[pick.station_id] = pick
    quakes = []
    for event in sorted(history.events, key=lambda e: (e.event_time, e.event_id)):
        picks = readings.get(event.event_id, {})
        if len(picks) < min_stations:
            continue
        ids = tuple(sorted(picks))
        quakes.append(Quake(
            event.event_id, event.event_time, event.latitude, event.longitude, event.magnitude, event.place, ids,
            tuple(positions[station] for station in ids),
            np.array([(picks[station].pick_time - event.event_time).total_seconds() for station in ids]),
        ))
    return quakes


# ---------------------------------------------------------------- solver on a local grid

def _axis(half: float, step: float) -> np.ndarray:
    return np.arange(-half, half + step / 2, step)


COARSE_AXIS = _axis(HALF_WIDTH_KM, COARSE_KM)
COARSE_POINTS = np.column_stack([a.ravel() for a in np.meshgrid(COARSE_AXIS, COARSE_AXIS)])
FINE_AXIS = _axis(FINE_HALF_KM, FINE_KM)
FINE_OFFSETS = np.column_stack([a.ravel() for a in np.meshgrid(FINE_AXIS, FINE_AXIS)])


@dataclass(frozen=True)
class LocalFit:
    east: float
    north: float
    origin_s: float
    rms_s: float
    errors_s: np.ndarray
    at_boundary: bool


class LocalGrid:
    """A flat km grid centred on one quake's first-reporting station."""

    def __init__(self, quake: Quake):
        first = quake.stations[int(np.argmin(quake.times_s))]
        self.lat0, self.lon0 = first.latitude, first.longitude
        self.km_lon = KM_PER_DEGREE * math.cos(math.radians(self.lat0))
        self.positions = np.array([self.project(s.latitude, s.longitude) for s in quake.stations])
        self.coarse_tt = self._travel(COARSE_POINTS, self.positions)

    def project(self, latitude: float, longitude: float) -> tuple[float, float]:
        return (longitude - self.lon0) * self.km_lon, (latitude - self.lat0) * KM_PER_DEGREE

    def unproject(self, east: float, north: float) -> StationLocation:
        return StationLocation(self.lat0 + north / KM_PER_DEGREE, self.lon0 + east / self.km_lon)

    @staticmethod
    def _travel(points: np.ndarray, positions: np.ndarray) -> np.ndarray:
        differences = points[:, None, :] - positions[None, :, :]
        return np.sqrt(np.sum(differences ** 2, axis=2) + DEPTH_KM ** 2) / SPEED_KM_S

    @staticmethod
    def _best(travel: np.ndarray, times: np.ndarray, weights: np.ndarray):
        implied = times[None, :] - travel
        total = weights.sum()
        origins = (implied * weights).sum(axis=1) / total
        errors = implied - origins[:, None]
        mse = (errors ** 2 * weights).sum(axis=1) / total
        index = int(np.argmin(mse))
        return index, float(origins[index]), float(np.sqrt(mse[index])), errors[index]

    def coarse_without_each(self, times: np.ndarray) -> np.ndarray:
        """The best coarse cell for every refit that leaves out one station, in one pass.

        Equal weights, so dropping station i just removes its term from the
        running sums: one (cells x stations) array instead of one search per station.
        """
        implied = times[None, :] - self.coarse_tt
        n = len(times) - 1
        means = (implied.sum(axis=1)[:, None] - implied) / n
        mse = ((implied ** 2).sum(axis=1)[:, None] - implied ** 2) / n - means ** 2
        return np.argmin(mse, axis=0)

    def fits_without_each(self, times: np.ndarray) -> list[LocalFit]:
        """fit(times, keep=all but i) for every station i, sharing work between refits.

        Refits that pick the same coarse cell share one fine grid, and each
        refit's origin and misfit come from running sums minus station i's term.
        """
        n = len(times) - 1
        coarse = self.coarse_without_each(times)
        fits: list[LocalFit | None] = [None] * len(times)
        for cell in np.unique(coarse):
            members = np.flatnonzero(coarse == cell)
            fine = np.clip(COARSE_POINTS[cell] + FINE_OFFSETS, -HALF_WIDTH_KM, HALF_WIDTH_KM)
            implied = times[None, :] - self._travel(fine, self.positions)
            total, squares = implied.sum(axis=1), (implied ** 2).sum(axis=1)
            for i in members:
                origins = (total - implied[:, i]) / n
                mse = (squares - implied[:, i] ** 2) / n - origins ** 2
                best = int(np.argmin(mse))
                east, north = fine[best]
                origin = float(origins[best])
                travel = self._travel(np.array([[east, north]]), self.positions)[0]
                edge = HALF_WIDTH_KM - max(abs(east), abs(north))
                fits[i] = LocalFit(float(east), float(north), origin, float(np.sqrt(max(mse[best], 0.0))),
                                   times - origin - travel, edge < FINE_KM)
        return fits

    def fit(self, times: np.ndarray, keep: np.ndarray | None = None, weights: np.ndarray | None = None,
            coarse_index: int | None = None) -> LocalFit:
        """Coarse 2 km search, then 250 m around the best cell (the app's two passes)."""
        keep = np.ones(len(times), bool) if keep is None else keep
        w = np.ones(int(keep.sum())) if weights is None else weights[keep]
        t = times[keep]
        index = coarse_index if coarse_index is not None else self._best(self.coarse_tt[:, keep], t, w)[0]
        centre = COARSE_POINTS[index]
        fine = np.clip(centre + FINE_OFFSETS, -HALF_WIDTH_KM, HALF_WIDTH_KM)
        index, origin, rms, _ = self._best(self._travel(fine, self.positions[keep]), t, w)
        east, north = fine[index]
        # Residuals for every station, including any left out, at the chosen point.
        travel = self._travel(np.array([[east, north]]), self.positions)[0]
        errors = times - origin - travel
        edge = HALF_WIDTH_KM - max(abs(east), abs(north))
        return LocalFit(float(east), float(north), origin, rms, errors, edge < FINE_KM)


def _taper(residuals: np.ndarray) -> np.ndarray:
    size = np.abs(residuals)
    fraction = np.clip((size - WEIGHT_FULL_S) / (WEIGHT_ZERO_S - WEIGHT_FULL_S), 0, 1)
    return 0.5 * (1 + np.cos(np.pi * fraction))


def weighted_fit(grid: LocalGrid, times: np.ndarray, start: LocalFit) -> LocalFit:
    fit = start
    for _ in range(WEIGHT_ITERATIONS):
        weights = _taper(fit.errors_s)
        if np.count_nonzero(weights > 0.05) < 4:
            break
        fit = grid.fit(times, weights=weights)
    return fit


def leave_one_out(grid: LocalGrid, times: np.ndarray) -> list[tuple[float, int, LocalFit, float]]:
    """(rms, station index, fit, left-out station's error) for each refit without one station, best first."""
    candidates = [(fit.rms_s, index, fit, float(fit.errors_s[index]))
                  for index, fit in enumerate(grid.fits_without_each(times))]
    candidates.sort(key=lambda item: item[0])
    return candidates


def quaketrace_fit(grid: LocalGrid, times: np.ndarray, full: LocalFit,
                   candidates: list | None = None) -> tuple[LocalFit, int | None]:
    """The app's diagnose(): the leave-one-out refit when one station is clearly to blame."""
    if full.at_boundary:
        return full, None
    candidates = candidates if candidates is not None else leave_one_out(grid, times)
    rms, index, best, offset = candidates[0]
    if best.at_boundary or abs(offset) < FLAG_OFFSET_S or rms > FLAG_RMS_RATIO * full.rms_s:
        return full, None
    for other_rms, _, other, other_offset in candidates[1:]:
        if other_rms - rms >= AMBIGUITY_S:
            break
        if abs(other_offset) >= FLAG_OFFSET_S and other_rms <= FLAG_RMS_RATIO * full.rms_s:
            return full, None
    return best, index


# ---------------------------------------------------------------- trials

def run_trial(quake: Quake, grid: LocalGrid, shift_s: float, station: int | None) -> dict:
    times = quake.times_s.copy()
    if station is not None:
        times[station] += shift_s
    truth = StationLocation(quake.latitude, quake.longitude)
    naive = grid.fit(times)
    weighted = weighted_fit(grid, times, naive)
    traced, flagged = quaketrace_fit(grid, times, naive)

    def error(fit: LocalFit) -> float:
        return round(distance_km(grid.unproject(fit.east, fit.north), truth), 2)

    return {
        "naive": error(naive), "weighted": error(weighted), "quaketrace": error(traced),
        "station": quake.station_ids[station] if station is not None else None,
        "flagged": quake.station_ids[flagged] if flagged is not None else None,
    }


def _summary(trials: list[dict], shifted: bool) -> dict:
    out = {"trials": len(trials)}
    for method in METHODS:
        values = [trial[method] for trial in trials]
        out[method] = {
            "median": round(median(values), 2), "mean": round(mean(values), 2),
            "within5": round(sum(v <= 5 for v in values) / len(values), 3),
        }
    flagged = [trial for trial in trials if trial["flagged"]]
    if shifted:
        out["caught"] = round(sum(t["flagged"] == t["station"] for t in trials) / len(trials), 3)
        out["wrongStation"] = round(sum(t["flagged"] not in (None, t["station"]) for t in trials) / len(trials), 3)
    else:
        out["falseFlags"] = round(len(flagged) / len(trials), 3)
    out["quaketraceBetter"] = sum(t["quaketrace"] < t["weighted"] - 0.5 for t in trials)
    out["quaketraceWorse"] = sum(t["quaketrace"] > t["weighted"] + 0.5 for t in trials)
    return out


def run_benchmark(history: History, *, shifts=SHIFTS_S, seed: int = SEED, progress=None) -> dict:
    """Relocate every eligible quake for each shift. One random station and sign per quake, fixed by seed."""
    quakes = benchmark_quakes(history)
    rng = random.Random(seed)
    picks = [(rng.randrange(len(q.station_ids)), rng.choice((-1, 1))) for q in quakes]
    key = lambda shift: f"{shift:g}"  # noqa: E731 - "3", matching JavaScript's String(3)
    trials: dict[str, list[dict]] = {key(shift): [] for shift in shifts}
    for number, (quake, (station, sign)) in enumerate(zip(quakes, picks, strict=True)):
        grid = LocalGrid(quake)
        for shift in shifts:
            trial = run_trial(quake, grid, sign * shift, station if shift else None)
            trial["quake"] = number
            trial["shiftS"] = sign * shift if shift else 0.0
            trials[key(shift)].append(trial)
        if progress:
            progress(number + 1, len(quakes))
    return {
        "generated": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "source": "Bundled north-east US history (USGS ComCat, 2018-2025)",
        "criteria": {
            "phases": list(PHASES), "maxDistanceDeg": MAX_DISTANCE_DEG, "minStations": MIN_STATIONS,
            "seed": seed, "weightFullS": WEIGHT_FULL_S, "weightZeroS": WEIGHT_ZERO_S,
        },
        "shifts": list(shifts),
        "quakes": [
            {
                "id": q.event_id, "time": q.time.isoformat(), "magnitude": q.magnitude, "place": q.place,
                "lat": q.latitude, "lon": q.longitude, "stations": len(q.station_ids),
            }
            for q in quakes
        ],
        "trials": trials,
        "summary": {key(shift): _summary(trials[key(shift)], bool(shift)) for shift in shifts},
    }
