"""TimescaleDB storage for observed arrival times and station histories."""

from __future__ import annotations

import hashlib
import json
import threading
import time
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


# ---------------------------------------------------------------- multi-year history

HISTORY_SCHEMA = (
    "CREATE EXTENSION IF NOT EXISTS timescaledb",
    "CREATE SCHEMA IF NOT EXISTS quaketrace",
    """
    CREATE TABLE IF NOT EXISTS quaketrace.events (
        event_id text PRIMARY KEY,
        event_time timestamptz NOT NULL,
        latitude double precision NOT NULL,
        longitude double precision NOT NULL,
        depth_km double precision NOT NULL,
        magnitude double precision,
        place text NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS events_time ON quaketrace.events (event_time DESC)",
    """
    CREATE TABLE IF NOT EXISTS quaketrace.picks (
        event_time timestamptz NOT NULL,
        event_id text NOT NULL,
        station_id text NOT NULL,
        location_code text NOT NULL,
        channel_code text NOT NULL,
        phase text NOT NULL,
        pick_time timestamptz NOT NULL,
        residual_s double precision NOT NULL,
        weight double precision NOT NULL,
        distance_deg double precision,
        azimuth_deg double precision,
        PRIMARY KEY (event_time, event_id, station_id, phase)
    )
    """,
    """
    SELECT create_hypertable(
        'quaketrace.picks', by_range('event_time', INTERVAL '1 year'), if_not_exists => TRUE
    )
    """,
    "CREATE INDEX IF NOT EXISTS picks_station_time ON quaketrace.picks (station_id, event_time DESC)",
)

# Regional networks report a few thousand picks a year spread over hundreds of
# stations, so segmenting by station leaves one or two rows per segment and
# compression gains nothing. Without segmentby, rows share 1,000-row batches
# ordered by station and time; per-batch min/max metadata still lets station
# filters skip batches.
COMPRESSION_SETTINGS = """
    ALTER TABLE quaketrace.picks SET (
        timescaledb.compress,
        timescaledb.compress_orderby = 'station_id, phase, event_time DESC'
    )
"""

REBUILD_HISTORY = (
    "DROP MATERIALIZED VIEW IF EXISTS quaketrace.station_monthly CASCADE",
    "DROP TABLE IF EXISTS quaketrace.picks CASCADE",
    "DROP TABLE IF EXISTS quaketrace.events CASCADE",
)

# Same filter as quaketrace.history.local_monthly_buckets.
P_FILTER = "phase IN ('P', 'Pg', 'Pn') AND abs(residual_s) < 10"

STATION_MONTHLY = f"""
    CREATE MATERIALIZED VIEW quaketrace.station_monthly
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
    SELECT time_bucket(INTERVAL '1 month', event_time) AS month,
           station_id,
           count(*) AS picks,
           avg(residual_s) AS mean_residual_s,
           stddev_samp(residual_s) AS spread_s
    FROM quaketrace.picks
    WHERE {P_FILTER}
    GROUP BY month, station_id
    WITH NO DATA
"""

COPY_PICKS = """
    COPY picks_load (event_time, event_id, station_id, location_code, channel_code, phase,
                     pick_time, residual_s, weight, distance_deg, azimuth_deg) FROM STDIN
"""

BUSIEST_STATIONS = """
    SELECT station_id, sum(picks)::bigint AS picks
    FROM quaketrace.station_monthly
    GROUP BY station_id
    ORDER BY picks DESC, station_id
    LIMIT %s
"""

MONTHLY_FROM_AGGREGATE = """
    SELECT month, station_id, picks, mean_residual_s
    FROM quaketrace.station_monthly
    WHERE station_id = ANY(%s)
    ORDER BY station_id, month
"""

MONTHLY_WITH_SHIFT = f"""
    SELECT time_bucket(INTERVAL '1 month', event_time) AS month,
           station_id,
           count(*) AS picks,
           avg(residual_s + CASE WHEN station_id = %(station)s AND event_time >= %(onset)s
                                 THEN %(offset)s ELSE 0 END) AS mean_residual_s
    FROM quaketrace.picks
    WHERE {P_FILTER} AND station_id = ANY(%(stations)s)
    GROUP BY month, station_id
    ORDER BY station_id, month
"""

HISTORY_TOTALS = """
    SELECT count(*), count(DISTINCT event_id), count(DISTINCT station_id), min(event_time), max(event_time)
    FROM quaketrace.picks
"""

CHUNK_COUNTS = """
    SELECT count(*), count(*) FILTER (WHERE is_compressed) FROM timescaledb_information.chunks
    WHERE hypertable_schema = 'quaketrace' AND hypertable_name = 'picks'
"""

# TimescaleDB renamed compression to "columnstore"; try the new name, then the old one.
COMPRESSION_SIZES = (
    "SELECT sum(before_compression_total_bytes), sum(after_compression_total_bytes) "
    "FROM hypertable_columnstore_stats('quaketrace.picks')",
    "SELECT sum(before_compression_total_bytes), sum(after_compression_total_bytes) "
    "FROM hypertable_compression_stats('quaketrace.picks')",
)


@contextmanager
def _autocommit(dsn: str, operation: str):
    with _connect(dsn, operation) as connection:
        connection.autocommit = True
        yield connection


def _first_row(connection, statements):
    for statement in statements:
        try:
            return connection.execute(statement).fetchone()
        except psycopg.Error:
            continue
    return None


def seed_history(dsn: str, events, picks, *, rebuild: bool = False) -> dict:
    """Load the history bundle, then compress old chunks and build the monthly aggregate.

    rebuild drops and recreates only the history objects (picks, events, and
    station_monthly) so new chunk and compression settings apply to every row.
    The demo table quaketrace.arrivals is never touched.
    """
    with _autocommit(dsn, "Tiger Data history seed") as connection:
        if rebuild:
            for statement in REBUILD_HISTORY:
                connection.execute(statement)
        for statement in HISTORY_SCHEMA:
            connection.execute(statement)
        with connection.transaction():
            connection.execute(
                "CREATE TEMP TABLE picks_load (LIKE quaketrace.picks INCLUDING DEFAULTS) ON COMMIT DROP"
            )
            with connection.cursor().copy(COPY_PICKS) as copy:
                for row in picks:
                    copy.write_row(astuple(row))
            inserted_picks = connection.execute(
                "INSERT INTO quaketrace.picks SELECT * FROM picks_load ON CONFLICT DO NOTHING"
            ).rowcount
            with connection.cursor() as cursor:
                cursor.executemany(
                    """
                    INSERT INTO quaketrace.events VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (event_id) DO UPDATE
                        SET magnitude = EXCLUDED.magnitude, place = EXCLUDED.place
                    """,
                    [astuple(event) for event in events],
                )
        enabled = connection.execute(
            """
            SELECT compression_enabled FROM timescaledb_information.hypertables
            WHERE hypertable_schema = 'quaketrace' AND hypertable_name = 'picks'
            """
        ).fetchone()
        if not (enabled and enabled[0]):
            connection.execute(COMPRESSION_SETTINGS)
        connection.execute(
            "SELECT add_compression_policy('quaketrace.picks', INTERVAL '180 days', if_not_exists => TRUE)"
        )
        compressed = connection.execute(
            """
            SELECT count(compress_chunk(chunk, if_not_compressed => TRUE))
            FROM show_chunks('quaketrace.picks', older_than => INTERVAL '180 days') AS chunk
            """
        ).fetchone()[0]
        exists = connection.execute(
            """
            SELECT 1 FROM timescaledb_information.continuous_aggregates
            WHERE view_schema = 'quaketrace' AND view_name = 'station_monthly'
            """
        ).fetchone()
        if not exists:
            connection.execute(STATION_MONTHLY)
            connection.execute(
                """
                SELECT add_continuous_aggregate_policy('quaketrace.station_monthly',
                    start_offset => INTERVAL '3 months', end_offset => INTERVAL '1 day',
                    schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)
                """
            )
        connection.execute("CALL refresh_continuous_aggregate('quaketrace.station_monthly', NULL, NULL)")
        stats = history_stats(connection)
    return {"inserted_picks": inserted_picks, "events": len(events), "compressed_chunks": compressed, **stats}


def history_stats(connection) -> dict:
    picks, events, stations, first, last = connection.execute(HISTORY_TOTALS).fetchone()
    chunks = _first_row(connection, (CHUNK_COUNTS,))
    sizes = _first_row(connection, COMPRESSION_SIZES)
    # Postgres returns these sums as numeric (Decimal); keep the payload JSON-safe.
    ratio = round(float(sizes[0]) / float(sizes[1]), 1) if sizes and sizes[0] and sizes[1] else None
    return {
        "picks": int(picks), "events": int(events), "stations": int(stations),
        "first": first.astimezone(timezone.utc).isoformat() if first else None,
        "last": last.astimezone(timezone.utc).isoformat() if last else None,
        "chunks": int(chunks[0]) if chunks else None,
        "compressedChunks": int(chunks[1]) if chunks else None,
        "compressionRatio": ratio,
    }


def history_buckets(
    dsn: str, *, limit: int, stations: list[str] | None = None,
    shifted_station: str | None = None, onset: datetime | None = None, offset_s: float = 0.0,
):
    """Monthly station residuals from Tiger Data.

    Reads the continuous aggregate normally. When a judge injects a clock shift
    into history it queries the raw hypertable, applying the shift in SQL.
    """
    from .history import Bucket  # noqa: PLC0415 - history imports nothing from here; keep it lazy

    def run(connection):
        overview = _cached_overview(connection, dsn, limit)
        busiest = overview["busiest"]
        names = list(dict.fromkeys(list(stations or []) + [station for station, _ in busiest]))
        if offset_s and shifted_station and onset:
            rows = connection.execute(MONTHLY_WITH_SHIFT, {
                "station": shifted_station, "onset": onset, "offset": offset_s, "stations": names,
            }).fetchall()
            source = "hypertable"
        else:
            rows = connection.execute(MONTHLY_FROM_AGGREGATE, (names,)).fetchall()
            source = "continuous aggregate"
        return busiest, names, rows, dict(overview["stats"]), source

    busiest, names, rows, stats, source = _with_shared_connection(dsn, "Tiger Data history query", run)
    buckets = [
        Bucket(month.astimezone(timezone.utc), station, int(picks), float(mean))
        for month, station, picks, mean in rows
    ]
    return busiest, names, buckets, stats, source


# ---------------------------------------------------------------- shared connection

# Opening a TLS connection to Tiger Cloud costs a few hundred milliseconds, far
# more than the queries. The web server keeps one autocommit connection open and
# requests take turns on it; a dropped connection is reopened once and retried.
_shared_lock = threading.Lock()
_shared: dict = {"connection": None, "dsn": None}
OVERVIEW_TTL_S = 60.0
_overview_cache: dict = {}


def _open_shared(dsn: str):
    connection = psycopg.connect(dsn, connect_timeout=3, autocommit=True)
    connection.execute("SET statement_timeout = '8s'")
    _shared.update(connection=connection, dsn=dsn)
    return connection


def _drop_shared():
    connection = _shared.get("connection")
    _shared.update(connection=None, dsn=None)
    if connection is not None:
        try:
            connection.close()
        except psycopg.Error:
            pass


def _with_shared_connection(dsn: str, operation: str, work):
    with _shared_lock:
        for attempt in range(2):
            try:
                connection = _shared["connection"]
                if connection is None or connection.closed or _shared["dsn"] != dsn:
                    _drop_shared()
                    connection = _open_shared(dsn)
                return work(connection)
            except psycopg.OperationalError:
                # Stale or dropped connection: reopen once, then give up.
                _drop_shared()
                if attempt:
                    raise TigerDataError(f"{operation} failed (OperationalError).") from None
            except psycopg.Error as error:
                raise TigerDataError(f"{operation} failed ({type(error).__name__}).") from None
    raise TigerDataError(f"{operation} failed.")


def _cached_overview(connection, dsn: str, limit: int) -> dict:
    """Busiest stations and table totals change only when data loads; cache them briefly."""
    key = (dsn, limit)
    cached = _overview_cache.get(key)
    if cached and time.monotonic() - cached["at"] < OVERVIEW_TTL_S:
        return cached
    busiest = [(row[0], int(row[1])) for row in connection.execute(BUSIEST_STATIONS, (limit,)).fetchall()]
    cached = {"at": time.monotonic(), "busiest": busiest, "stats": history_stats(connection)}
    _overview_cache[key] = cached
    return cached


def reset_shared_connection():
    """Close the shared connection and clear cached totals (after a reseed, and in tests)."""
    with _shared_lock:
        _drop_shared()
        _overview_cache.clear()
