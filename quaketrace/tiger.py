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
from .history import region_of

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
           region,
           count(*) AS picks,
           sum(residual_s) AS sum_residual_s,
           avg(residual_s) AS mean_residual_s,
           stddev_samp(residual_s) AS spread_s
    FROM quaketrace.picks
    WHERE {P_FILTER}
    GROUP BY month, station_id, region
    WITH NO DATA
"""

COPY_PICKS = """
    COPY picks_load (event_time, event_id, station_id, location_code, channel_code, phase,
                     pick_time, residual_s, weight, distance_deg, azimuth_deg) FROM STDIN
"""

BUSIEST_STATIONS = """
    SELECT station_id, sum(picks)::bigint AS picks
    FROM quaketrace.station_monthly
    WHERE region = ANY(%s)
    GROUP BY station_id
    ORDER BY picks DESC, station_id
    LIMIT %s
"""

MONTHLY_FROM_AGGREGATE = """
    SELECT month, station_id, sum(picks)::bigint, sum(sum_residual_s) / sum(picks)
    FROM quaketrace.station_monthly
    WHERE station_id = ANY(%s) AND region = ANY(%s)
    GROUP BY month, station_id
    ORDER BY station_id, month
"""

MONTHLY_WITH_SHIFT = f"""
    SELECT time_bucket(INTERVAL '1 month', event_time) AS month,
           station_id,
           count(*) AS picks,
           avg(residual_s + CASE WHEN station_id = %(station)s AND event_time >= %(onset)s
                                 THEN %(offset)s ELSE 0 END) AS mean_residual_s
    FROM quaketrace.picks
    WHERE {P_FILTER} AND station_id = ANY(%(stations)s) AND region = ANY(%(regions)s)
    GROUP BY month, station_id
    ORDER BY station_id, month
"""

HISTORY_TOTALS = """
    SELECT count(*), count(DISTINCT event_id), count(DISTINCT station_id), min(event_time), max(event_time)
    FROM quaketrace.picks
    WHERE region = ANY(%s)
"""

# The bundled history is all north-east US, so existing rows default to it.
REGION_COLUMNS = (
    "ALTER TABLE quaketrace.events ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'northeast'",
    "ALTER TABLE quaketrace.picks ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'northeast'",
)

MONTHLY_HAS_REGION = """
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quaketrace' AND table_name = 'station_monthly' AND column_name = 'region'
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
        for statement in HISTORY_SCHEMA + REGION_COLUMNS:
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
                    INSERT INTO quaketrace.events
                        (event_id, event_time, latitude, longitude, depth_km, magnitude, place)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
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
        ensure_station_monthly(connection, refresh=False)
        connection.execute("CALL refresh_continuous_aggregate('quaketrace.station_monthly', NULL, NULL)")
        stats = history_stats(connection, ALL_REGIONS)
    return {"inserted_picks": inserted_picks, "events": len(events), "compressed_chunks": compressed, **stats}


REGIONS = {"northeast": ("northeast",), "world": ("northeast", "world")}
ALL_REGIONS = REGIONS["world"]


def ensure_station_monthly(connection, *, refresh: bool = True) -> bool:
    """Create the monthly continuous aggregate, rebuilding an older one without regions.

    Returns True when it was (re)created. Call with autocommit on.
    """
    exists = connection.execute(
        """
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = 'quaketrace' AND view_name = 'station_monthly'
        """
    ).fetchone()
    if exists and connection.execute(MONTHLY_HAS_REGION).fetchone():
        return False
    if exists:
        connection.execute("DROP MATERIALIZED VIEW quaketrace.station_monthly")
    connection.execute(STATION_MONTHLY)
    connection.execute(
        """
        SELECT add_continuous_aggregate_policy('quaketrace.station_monthly',
            start_offset => INTERVAL '3 months', end_offset => INTERVAL '1 day',
            schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)
        """
    )
    if refresh:
        connection.execute("CALL refresh_continuous_aggregate('quaketrace.station_monthly', NULL, NULL)")
    invalidate_overview()
    return True


def history_stats(connection, regions=ALL_REGIONS) -> dict:
    picks, events, stations, first, last = connection.execute(HISTORY_TOTALS, (list(regions),)).fetchone()
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
        "live": live_status(connection),
    }


def history_buckets(
    dsn: str, *, limit: int, stations: list[str] | None = None,
    shifted_station: str | None = None, onset: datetime | None = None, offset_s: float = 0.0,
    region: str = "northeast",
):
    """Monthly station residuals from Tiger Data.

    Reads the continuous aggregate normally. When a judge injects a clock shift
    into history it queries the raw hypertable, applying the shift in SQL.
    """
    from .history import Bucket  # noqa: PLC0415 - history imports nothing from here; keep it lazy

    regions = list(REGIONS[region])

    def run(connection):
        overview = _cached_overview(connection, dsn, limit, regions)
        busiest = overview["busiest"]
        names = list(dict.fromkeys(list(stations or []) + [station for station, _ in busiest]))
        if offset_s and shifted_station and onset:
            rows = connection.execute(MONTHLY_WITH_SHIFT, {
                "station": shifted_station, "onset": onset, "offset": offset_s, "stations": names,
                "regions": regions,
            }).fetchall()
            source = "hypertable"
        else:
            rows = connection.execute(MONTHLY_FROM_AGGREGATE, (names, regions)).fetchall()
            source = "continuous aggregate"
        return busiest, names, rows, dict(overview["stats"]), source

    busiest, names, rows, stats, source = _with_shared_connection(dsn, "Tiger Data history query", run)
    buckets = [
        Bucket(month.astimezone(timezone.utc), station, int(picks), float(mean))
        for month, station, picks, mean in rows
    ]
    return busiest, names, buckets, stats, source


# ---------------------------------------------------------------- live ingest

# Quakes added by the live USGS ingest carry ingested_at; seeded ones leave it NULL.
LIVE_SCHEMA = (
    "ALTER TABLE quaketrace.events ADD COLUMN IF NOT EXISTS ingested_at timestamptz",
    """
    CREATE TABLE IF NOT EXISTS quaketrace.ingest_runs (
        run_at timestamptz NOT NULL DEFAULT now(),
        window_start timestamptz NOT NULL,
        window_end timestamptz NOT NULL,
        checked integer NOT NULL DEFAULT 0,
        new_events integer NOT NULL DEFAULT 0,
        new_picks integer NOT NULL DEFAULT 0,
        error text
    )
    """,
    "CREATE INDEX IF NOT EXISTS ingest_runs_time ON quaketrace.ingest_runs (run_at DESC)",
    "ALTER TABLE quaketrace.ingest_runs ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'northeast'",
    "CREATE INDEX IF NOT EXISTS events_region_time ON quaketrace.events (region, event_time DESC)",
)

LIVE_STATUS = """
    SELECT (SELECT max(run_at) FROM quaketrace.ingest_runs),
           (SELECT max(run_at) FROM quaketrace.ingest_runs WHERE error IS NULL),
           (SELECT error FROM quaketrace.ingest_runs ORDER BY run_at DESC LIMIT 1),
           (SELECT count(*) FROM quaketrace.events WHERE ingested_at IS NOT NULL),
           (SELECT coalesce(sum(new_picks), 0) FROM quaketrace.ingest_runs),
           (SELECT max(event_time) FROM quaketrace.events),
           (SELECT count(*) FROM quaketrace.events
             WHERE ingested_at IS NOT NULL AND event_time > now() - INTERVAL '24 hours')
"""

LATEST_LIVE_EVENT = """
    SELECT event_id, event_time, magnitude, place FROM quaketrace.events
    WHERE ingested_at IS NOT NULL ORDER BY event_time DESC LIMIT 1
"""


@contextmanager
def session(dsn: str, operation: str):
    """An autocommit connection whose database errors surface as TigerDataError."""
    with _autocommit(dsn, operation) as connection:
        try:
            yield connection
        except psycopg.Error as error:
            raise TigerDataError(f"{operation} failed ({type(error).__name__}).") from None


def ensure_live_schema(connection) -> None:
    for statement in REGION_COLUMNS + LIVE_SCHEMA:
        connection.execute(statement)
    ensure_station_monthly(connection)


def latest_event_time(connection, region: str = "northeast") -> datetime | None:
    row = connection.execute(
        "SELECT max(event_time) FROM quaketrace.events WHERE region = %s", (region,)
    ).fetchone()
    return row[0].astimezone(timezone.utc) if row and row[0] else None


def known_event_ids(connection, event_ids: list[str]) -> set[str]:
    if not event_ids:
        return set()
    rows = connection.execute(
        "SELECT event_id FROM quaketrace.events WHERE event_id = ANY(%s)", (event_ids,)
    ).fetchall()
    return {row[0] for row in rows}


PICK_COLUMNS = (
    "event_time, event_id, station_id, location_code, channel_code, phase, "
    "pick_time, residual_s, weight, distance_deg, azimuth_deg, region"
)


def store_events(connection, added) -> tuple[int, int]:
    """Insert newly published quakes and their picks. Returns (events, picks) actually added."""
    new_events = new_picks = 0
    with connection.transaction():
        with connection.cursor() as cursor:
            for event, picks in added:
                region = region_of(event.latitude, event.longitude)
                cursor.execute(
                    """
                    INSERT INTO quaketrace.events
                        (event_id, event_time, latitude, longitude, depth_km, magnitude, place, region, ingested_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
                    ON CONFLICT (event_id) DO NOTHING
                    """,
                    (*astuple(event), region),
                )
                if cursor.rowcount != 1:
                    continue
                new_events += 1
                cursor.executemany(
                    f"""
                    INSERT INTO quaketrace.picks ({PICK_COLUMNS})
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    [(*astuple(pick), region) for pick in picks],
                )
                new_picks += max(cursor.rowcount, 0)
    return new_events, new_picks


def refresh_months(connection, first: datetime, last: datetime) -> None:
    """Re-materialize station_monthly for the months between first and last (inclusive).

    Real-time aggregation only covers rows newer than the last refresh, and the
    refresh policy only looks back three months, so rows inserted into older
    months (a backfill, or phase data USGS published late) need this.
    """
    start = datetime(first.year, first.month, 1, tzinfo=timezone.utc)
    end = datetime(last.year + (last.month == 12), last.month % 12 + 1, 1, tzinfo=timezone.utc)
    connection.execute("CALL refresh_continuous_aggregate('quaketrace.station_monthly', %s, %s)", (start, end))


def log_run(connection, *, region: str, window_start: datetime, window_end: datetime, checked: int,
            new_events: int, new_picks: int, error: str | None = None) -> None:
    connection.execute(
        """
        INSERT INTO quaketrace.ingest_runs
            (region, window_start, window_end, checked, new_events, new_picks, error)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (region, window_start, window_end, checked, new_events, new_picks, error),
    )


def _iso(moment) -> str | None:
    return moment.astimezone(timezone.utc).isoformat() if moment else None


def live_status(connection) -> dict | None:
    """When the live ingest last ran and what it has added; None before its first run."""
    row = _first_row(connection, (LIVE_STATUS,))
    if not row or row[0] is None:
        return None
    last_run, last_ok, error, events, picks, newest, last_day = row
    latest = _first_row(connection, (LATEST_LIVE_EVENT,))
    return {
        "lastRun": _iso(last_run), "lastSuccess": _iso(last_ok), "error": error,
        "eventsAdded": int(events), "picksAdded": int(picks), "newestQuake": _iso(newest),
        "lastDay": int(last_day),
        "latestAdded": {
            "id": latest[0], "time": _iso(latest[1]),
            "magnitude": float(latest[2]) if latest[2] is not None else None, "place": latest[3],
        } if latest else None,
    }


def invalidate_overview() -> None:
    """Drop cached totals so the next history query shows freshly ingested rows."""
    _overview_cache.clear()


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


def _cached_overview(connection, dsn: str, limit: int, regions: list[str]) -> dict:
    """Busiest stations and table totals change only when data loads; cache them briefly."""
    key = (dsn, limit, tuple(regions))
    cached = _overview_cache.get(key)
    if cached and time.monotonic() - cached["at"] < OVERVIEW_TTL_S:
        return cached
    busiest = [(row[0], int(row[1])) for row in connection.execute(BUSIEST_STATIONS, (regions, limit)).fetchall()]
    cached = {"at": time.monotonic(), "busiest": busiest, "stats": history_stats(connection, regions)}
    _overview_cache[key] = cached
    return cached


def reset_shared_connection():
    """Close the shared connection and clear cached totals (after a reseed, and in tests)."""
    with _shared_lock:
        _drop_shared()
        _overview_cache.clear()
