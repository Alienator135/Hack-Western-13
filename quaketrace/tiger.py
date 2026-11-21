"""TimescaleDB storage for observed arrival times and station histories."""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from dataclasses import astuple
from datetime import datetime, timezone

import psycopg

from .data import AUDIT_STATIONS, Arrival, Fixture

SCHEMA = (
    "CREATE EXTENSION IF NOT EXISTS timescaledb",
    "CREATE SCHEMA IF NOT EXISTS quaketrace",
    """
    CREATE TABLE IF NOT EXISTS quaketrace.arrivals (
        fixture_revision text NOT NULL,
        event_time timestamptz NOT NULL,
        event_id text NOT NULL,
        station_id text NOT NULL,
        phase text NOT NULL,
        pick_time timestamptz NOT NULL,
        residual_s double precision NOT NULL,
        weight double precision NOT NULL CHECK (weight > 0),
        location_code text NOT NULL,
        channel_code text NOT NULL,
        PRIMARY KEY (fixture_revision, event_time, event_id, station_id, phase)
    )
    """,
    """
    SELECT create_hypertable(
        'quaketrace.arrivals', by_range('event_time'), if_not_exists => TRUE
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS arrivals_station_time
        ON quaketrace.arrivals (fixture_revision, station_id, event_time DESC)
    """,
)

INSERT_ARRIVAL = """
    INSERT INTO quaketrace.arrivals (
        fixture_revision, event_time, event_id, station_id, phase, pick_time,
        residual_s, weight, location_code, channel_code
    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (fixture_revision, event_time, event_id, station_id, phase) DO NOTHING
"""

READ_ARRIVALS = """
    SELECT event_id, station_id, phase, pick_time, residual_s, weight, location_code, channel_code
    FROM quaketrace.arrivals
    WHERE fixture_revision = %s AND event_time BETWEEN %s AND %s
      AND station_id = ANY(%s)
    ORDER BY event_time, station_id, phase
"""

WEEKLY_HISTORY = """
    WITH arrivals_in_range AS (
        SELECT event_time, event_id, station_id, residual_s
        FROM quaketrace.arrivals
        WHERE fixture_revision = %s AND event_time BETWEEN %s AND %s
          AND station_id = ANY(%s) AND phase = 'Pg'
    ), event_centres AS (
        SELECT event_id, event_time,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY residual_s) AS median_s
        FROM arrivals_in_range
        GROUP BY event_id, event_time
        HAVING count(*) >= 4
    )
    SELECT time_bucket(INTERVAL '1 week', a.event_time) AS week_utc,
           count(*) AS events,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a.residual_s - c.median_s) AS median_residual_s
    FROM arrivals_in_range AS a
    JOIN event_centres AS c USING (event_id, event_time)
    WHERE a.station_id = %s
    GROUP BY week_utc
    ORDER BY week_utc
"""


class TigerDataError(RuntimeError):
    """A database error safe to show without exposing connection details."""


@contextmanager
def _connect(dsn: str, operation: str):
    try:
        with psycopg.connect(dsn, connect_timeout=3) as connection:
            yield connection
    except psycopg.Error as error:
        raise TigerDataError(f"{operation} failed ({type(error).__name__}).") from None


def _fixture_revision(fixture: Fixture) -> str:
    events = sorted((event.id, event.time.isoformat()) for event in fixture.events.values())
    arrivals = sorted((astuple(row) for row in fixture.arrivals), key=lambda row: row[:3])
    payload = json.dumps((events, arrivals), default=lambda value: value.isoformat(), separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _date_range(fixture: Fixture) -> tuple[datetime, datetime]:
    event_times = [event.time for event in fixture.events.values()]
    return min(event_times), max(event_times)


def _arrival_key(row: Arrival) -> tuple[str, str, str]:
    return row.event_id, row.station_id, row.phase


def seed_demo(dsn: str, fixture: Fixture) -> int:
    """Create the hypertable and insert one immutable fixture revision atomically."""
    revision = _fixture_revision(fixture)
    rows = [(revision, fixture.events[row.event_id].time, *astuple(row)) for row in fixture.arrivals]
    with _connect(dsn, "Tiger Data seed") as connection:
        for statement in SCHEMA:
            connection.execute(statement)
        with connection.cursor() as cursor:
            cursor.executemany(INSERT_ARRIVAL, rows)
            return cursor.rowcount


def read_demo_arrivals(dsn: str, fixture: Fixture) -> tuple[Arrival, ...]:
    """Load the fixture revision by station and time, preserving fixture draw order."""
    stations = sorted({row.station_id for row in fixture.arrivals})
    parameters = (_fixture_revision(fixture), *_date_range(fixture), stations)
    with _connect(dsn, "Tiger Data arrival query") as connection:
        connection.execute("SET LOCAL statement_timeout = '4s'")
        rows = connection.execute(READ_ARRIVALS, parameters).fetchall()
    arrivals = {
        row[:3]: Arrival(*row[:3], row[3].astimezone(timezone.utc), *row[4:]) for row in rows
    }
    expected = [_arrival_key(row) for row in fixture.arrivals]
    if len(rows) != len(expected) or arrivals.keys() != set(expected):
        raise TigerDataError("The arrival snapshot is incomplete. Run the Tiger Data seed command.")
    return tuple(arrivals[key] for key in expected)


def weekly_station_history(
    dsn: str, fixture: Fixture, station: str,
) -> list[tuple[datetime, int, float]]:
    """Summarize event-centred Pg residuals using TimescaleDB weekly buckets."""
    if station not in AUDIT_STATIONS:
        raise ValueError("Choose one of the shared audit stations.")
    parameters = (_fixture_revision(fixture), *_date_range(fixture), list(AUDIT_STATIONS), station)
    with _connect(dsn, "Tiger Data station history") as connection:
        connection.execute("SET LOCAL statement_timeout = '4s'")
        rows = connection.execute(WEEKLY_HISTORY, parameters).fetchall()
    return [(week.astimezone(timezone.utc), events, median) for week, events, median in rows]
