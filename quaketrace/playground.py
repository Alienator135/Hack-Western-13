"""Try any quake: break one station's clock on any real north-east US quake.

Uses the benchmark's locator (a flat grid centred on the first-reporting
station, station positions rebuilt from each reading's distance and azimuth)
so it works on every quake with at least six P readings within 1.5 degrees:
the bundled 2018-2025 history plus, when Tiger Data is connected, every
north-east quake the live feed has added since.

The model is a crustal one (6 km/s, 5 km depth, stations within ~150 km), so
worldwide quakes recorded at teleseismic distances are out of scope.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import timezone
from functools import lru_cache
from os import getenv

import numpy as np

from . import benchmark as bm
from .data import DEFAULT_FIXTURES, TIGER_DSN_ENV, StationLocation
from .history import History, HistoryEvent, HistoryPick, load_history, region_of
from .replay import distance_km

logger = logging.getLogger(__name__)

LIVE_TTL_S = 600
_lock = threading.Lock()
_cache: dict = {"at": 0.0, "quakes": None, "live": set(), "source": "bundled", "world": set()}

LIVE_EVENTS = """
    SELECT event_id, event_time, latitude, longitude, depth_km, magnitude, place
    FROM quaketrace.events WHERE region = 'northeast' AND event_time > %s
"""
LIVE_PICKS = """
    SELECT event_time, event_id, station_id, location_code, channel_code, phase,
           pick_time, residual_s, weight, distance_deg, azimuth_deg
    FROM quaketrace.picks WHERE region = 'northeast' AND event_time > %s
"""
# Worldwide quakes only work when local stations recorded them, so fetch just the
# nearby P readings and the quakes they belong to (a few thousand rows).
WORLD_PICKS = f"""
    SELECT event_time, event_id, station_id, location_code, channel_code, phase,
           pick_time, residual_s, weight, distance_deg, azimuth_deg
    FROM quaketrace.picks
    WHERE region = 'world' AND distance_deg <= {bm.MAX_DISTANCE_DEG} AND phase IN ('P', 'Pg')
      AND abs(residual_s) < {bm.MAX_RESIDUAL_S}
"""
WORLD_EVENTS = f"""
    SELECT event_id, event_time, latitude, longitude, depth_km, magnitude, place
    FROM quaketrace.events
    WHERE region = 'world' AND event_id IN (
        SELECT event_id FROM quaketrace.picks
        WHERE region = 'world' AND distance_deg <= {bm.MAX_DISTANCE_DEG} AND phase IN ('P', 'Pg')
        GROUP BY event_id HAVING count(DISTINCT station_id) >= {bm.MIN_STATIONS}
    )
"""
# The locator assumes a 5 km deep quake in a uniform 6 km/s crust. Outside the
# north-east it only keeps quakes that model describes well: shallow, and with the
# untouched readings fitting within 0.5 s. Looser fits hide a broken clock.
MAX_WORLD_DEPTH_KM = 15.0
MAX_WORLD_RMS_S = 0.5
# Measured on the 37 worldwide quakes that passed these rules (Nov 2026), shifting
# every station of every quake by +/-3 s and +/-5 s: share where QuakeTrace named it.
WORLD_BENCHMARK = {"quakes": 37, "caught3": 0.65, "caught5": 0.81, "falseFlags": 0.0}
# Each worldwide quake's untouched fit, saved by scripts/cache_world_fits.py so a cold
# server does not refit dozens of quakes (seconds) before answering. Keyed by quake id
# with its station count; quakes missing or changed since are fitted on the fly.
WORLD_FITS_FILE = DEFAULT_FIXTURES / "world_fits.json"


@lru_cache(maxsize=1)
def _saved_world_fits() -> dict:
    try:
        return json.loads(WORLD_FITS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def world_fit_rms(quake: bm.Quake) -> float:
    """RMS of the untouched all-station fit, from the saved file when it still matches."""
    saved = _saved_world_fits().get(quake.event_id)
    if saved and saved[0] == len(quake.station_ids):
        return saved[1]
    return bm.LocalGrid(quake).fit(quake.times_s).rms_s


@lru_cache(maxsize=1)
def _bundled() -> History:
    return load_history()


def _live_rows(dsn: str, after) -> tuple[list[HistoryEvent], list[HistoryPick]]:
    from .tiger import _with_shared_connection  # noqa: PLC0415 - psycopg stays optional offline

    def run(connection):
        events = connection.execute(LIVE_EVENTS, (after,)).fetchall()
        picks = connection.execute(LIVE_PICKS, (after,)).fetchall()
        events += connection.execute(WORLD_EVENTS).fetchall()
        picks += connection.execute(WORLD_PICKS).fetchall()
        return events, picks

    events, picks = _with_shared_connection(dsn, "Tiger Data quake query", run)
    utc = timezone.utc
    return (
        [HistoryEvent(e[0], e[1].astimezone(utc), float(e[2]), float(e[3]), float(e[4]),
                      None if e[5] is None else float(e[5]), e[6] or "") for e in events],
        [HistoryPick(p[0].astimezone(utc), p[1], p[2], p[3], p[4], p[5], p[6].astimezone(utc), float(p[7]),
                     float(p[8]), None if p[9] is None else float(p[9]), None if p[10] is None else float(p[10]))
         for p in picks],
    )


def world_eligible(event: HistoryEvent) -> bool:
    """Worldwide quakes the local model handles: shallow ones (it assumes a 5 km depth)."""
    return event.depth_km < MAX_WORLD_DEPTH_KM


def quakes() -> tuple[dict[str, bm.Quake], set[str], str]:
    """Every eligible quake by id, the ids added since the bundled history ends, and the source label."""
    with _lock:
        if _cache["quakes"] is not None and time.monotonic() - _cache["at"] < LIVE_TTL_S:
            return _cache["quakes"], _cache["live"], _cache["source"]
    history = _bundled()
    live: set[str] = set()
    world: set[str] = set()
    source = "bundled"
    dsn = getenv(TIGER_DSN_ENV)
    if dsn:
        from .tiger import TigerDataError  # noqa: PLC0415
        last = max(event.event_time for event in history.events)
        try:
            events, picks = _live_rows(dsn, last)
            known = {event.event_id for event in history.events}
            events = [event for event in events if event.event_id not in known
                      and (region_of(event.latitude, event.longitude) == "northeast" or world_eligible(event))]
            world = {event.event_id for event in events if region_of(event.latitude, event.longitude) == "world"}
            live = {event.event_id for event in events if event.event_time > last}
            added = {event.event_id for event in events}
            history = History(history.events + tuple(events), history.picks + tuple(p for p in picks if p.event_id in added))
            source = "tiger"
        except TigerDataError as error:
            logger.warning("Try any quake: using the bundled history (%s)", error)
    found = {quake.event_id: quake for quake in bm.benchmark_quakes(history)}
    _cache["all_world"] = {event_id: found[event_id] for event_id in world & set(found)}
    for event_id in list(world & set(found)):
        quake = found[event_id]
        if world_fit_rms(quake) >= MAX_WORLD_RMS_S:
            del found[event_id]
    with _lock:
        _cache.update(at=time.monotonic(), quakes=found, live=live & set(found), source=source, world=world & set(found))
    return found, _cache["live"], source


def _benchmark_summary() -> dict | None:
    """Headline numbers from the precomputed benchmark (fixtures/benchmark.json)."""
    import json  # noqa: PLC0415

    from .data import DEFAULT_FIXTURES  # noqa: PLC0415
    path = DEFAULT_FIXTURES / "benchmark.json"
    if not path.is_file():
        return None
    summary = json.loads(path.read_text(encoding="utf-8"))["summary"]
    return {
        "quakes": summary["3"]["trials"],
        "caught3": summary["3"]["caught"], "caught5": summary["5"]["caught"],
        "falseFlags": summary["0"]["falseFlags"],
        "naive3Km": summary["3"]["naive"]["median"], "weighted3Km": summary["3"]["weighted"]["median"],
        "quaketrace3Km": summary["3"]["quaketrace"]["median"],
    }


def quake_list() -> dict:
    found, live, source = quakes()
    rows = sorted(found.values(), key=lambda q: q.time, reverse=True)
    return {
        "source": source,
        "benchmark": _benchmark_summary(),
        "worldBenchmark": WORLD_BENCHMARK,
        "quakes": [
            {"id": q.event_id, "time": q.time.isoformat(), "magnitude": q.magnitude, "place": q.place,
             "lat": round(q.latitude, 4), "lon": round(q.longitude, 4), "stations": len(q.station_ids),
             "live": q.event_id in live, "region": "world" if q.event_id in _cache["world"] else "northeast"}
            for q in rows
        ],
    }


def _point(grid: bm.LocalGrid, fit: bm.LocalFit, truth: StationLocation) -> dict:
    where = grid.unproject(fit.east, fit.north)
    return {"lat": round(where.latitude, 5), "lon": round(where.longitude, 5), "rmsS": round(fit.rms_s, 3),
            "usgsKm": round(distance_km(where, truth), 2)}


def try_quake(event_id: str, station: str | None, offset_s: float) -> dict:
    """Shift one station's clock on one quake, then locate it three ways and diagnose."""
    found, live, _ = quakes()
    quake = found.get(event_id)
    if quake is None:
        raise ValueError("Pick a quake from the list.")
    if offset_s and station not in quake.station_ids:
        raise ValueError(f"{station} did not record this quake.")
    index = quake.station_ids.index(station) if offset_s else None
    times = quake.times_s.copy()
    if index is not None:
        times[index] += offset_s
    grid = bm.LocalGrid(quake)
    truth = StationLocation(quake.latitude, quake.longitude)
    naive = grid.fit(times)
    weighted = bm.weighted_fit(grid, times, naive)
    candidates = bm.leave_one_out(grid, times)
    traced, flagged = bm.quaketrace_fit(grid, times, naive, candidates)
    loo = {quake.station_ids[i]: (rms, err) for rms, i, _, err in candidates}
    first = int(np.argmin(quake.times_s))
    stations = []
    for i, station_id in enumerate(quake.station_ids):
        where = quake.stations[i]
        stations.append({
            "id": station_id, "short": station_id.split(".", 1)[-1],
            "lat": round(where.latitude, 4), "lon": round(where.longitude, 4),
            "km": round(distance_km(where, truth), 1),
            "errorS": round(float(naive.errors_s[i]), 2),
            "withoutRmsS": round(loo[station_id][0], 3),
            "shifted": i == index, "first": i == first,
        })
    stations.sort(key=lambda row: row["km"])
    return {
        "event": {"id": quake.event_id, "time": quake.time.isoformat(), "magnitude": quake.magnitude,
                  "place": quake.place, "lat": quake.latitude, "lon": quake.longitude,
                  "live": quake.event_id in live,
                  "region": "world" if quake.event_id in _cache["world"] else "northeast"},
        "scenario": {"station": station if index is not None else None, "offsetS": offset_s if index is not None else 0.0},
        "stations": stations,
        "naive": _point(grid, naive, truth),
        "weighted": _point(grid, weighted, truth),
        "quaketrace": {
            **_point(grid, traced, truth),
            "flagged": quake.station_ids[flagged] if flagged is not None else None,
            "foundOffsetS": round(loo[quake.station_ids[flagged]][1], 2) if flagged is not None else None,
        },
        "model": {"speedKmS": bm.SPEED_KM_S, "depthKm": bm.DEPTH_KM, "gridKm": bm.COARSE_KM, "fineKm": bm.FINE_KM},
    }
