"""Streamlit entry point for the offline QuakeTrace demonstration."""

from dataclasses import replace

import streamlit as st

from quaketrace.audit import audit
from quaketrace.charts import audit_chart, replay_map, replay_street_map, waveform_chart
from quaketrace.data import (
    AUDIT_STATIONS, BASELINE_EVENTS, EVALUATION_EVENTS, MAINSHOCK, WAVEFORM_STATION,
    load_fixture,
)
from quaketrace.explorer import render_world
from quaketrace.replay import Reading, diagnose, distance_km, fit_location

st.set_page_config(page_title="QuakeTrace", page_icon="〰️", layout="wide")


@st.cache_data
def fixture_data():
    return load_fixture()


@st.cache_data
def replay_solution(readings, station, offset):
    shifted = tuple(
        replace(reading, time_s=reading.time_s + offset)
        if reading.station_id == station else reading
        for reading in readings
    )
    return diagnose(shifted)


def replay_preset(event_id, station, offset):
    st.session_state.replay_event = event_id
    st.session_state.replay_station = station
    st.session_state.replay_offset = offset
    st.session_state.replay_scenario = (event_id, station, offset)
    st.session_state.replay_revealed = False


def audit_preset(station, onset, offset):
    st.session_state.audit_station = station
    st.session_state.audit_onset = onset
    st.session_state.audit_offset = offset
    st.session_state.audit_scenario = (station, onset, offset)
    st.session_state.audit_inspected = station


def event_date(fixture, event_id, *, with_time=False):
    if not event_id:
        return "—"
    return fixture.events[event_id].time.strftime("%b %d · %H:%M UTC" if with_time else "%b %d")


def render_replay(fixture):
    st.header("Earthquake replay")
    st.session_state.setdefault("replay_scenario", (MAINSHOCK, WAVEFORM_STATION, 0.0))
    st.session_state.setdefault("replay_revealed", False)
    stations_by_event = {
        event_id: tuple(row.station_id for row in fixture.arrivals if row.event_id == event_id)
        for event_id in fixture.events
    }
    event_ids = sorted(stations_by_event, key=lambda event_id: fixture.events[event_id].time)

    def event_label(event_id):
        name = "Tewksbury mainshock" if event_id == MAINSHOCK else event_id
        return f"{event_date(fixture, event_id, with_time=True)} · {name}"

    def change_event():
        event_id = st.session_state.replay_event
        station_ids = stations_by_event[event_id]
        station = WAVEFORM_STATION if WAVEFORM_STATION in station_ids else station_ids[0]
        replay_preset(event_id, station, 0.0)

    left, right = st.columns([1, 2.3], gap="large")
    with left:
        selected_event = st.session_state.replay_scenario[0]
        event_id = st.selectbox(
            "Earthquake", event_ids, index=event_ids.index(selected_event),
            format_func=event_label, key="replay_event", on_change=change_event,
        )
        station_ids = stations_by_event[event_id]
        st.caption(f"New Jersey, United States · {len(station_ids)} recorded Pg arrivals")
        with st.form("replay_inputs", clear_on_submit=True):
            station = st.selectbox(
                "Station to shift", station_ids, index=station_ids.index(st.session_state.replay_scenario[1]),
                format_func=lambda station_id: " · ".join(filter(None, (
                    station_id, fixture.stations[(event_id, station_id)].name,
                ))),
                key="replay_station",
            )
            offset = st.slider("Simulated arrival shift (s)", -5.0, 5.0, 0.0, step=0.25, key="replay_offset")
            if st.form_submit_button("Run replay", type="primary"):
                st.session_state.replay_scenario = event_id, station, offset
                st.session_state.replay_revealed = False
        controls = st.columns(2)
        controls[0].button(
            "Mainshock example", key="replay_example", on_click=replay_preset,
            args=(MAINSHOCK, WAVEFORM_STATION, 5.0),
        )
        controls[1].button(
            "Reset", key="replay_reset", on_click=replay_preset,
            args=(event_id, station, 0.0),
        )

    event_id, station, offset = st.session_state.replay_scenario
    event = fixture.events[event_id]
    arrivals = [row for row in fixture.arrivals if row.event_id == event_id]
    time_reference = min(row.pick_time for row in arrivals)
    readings = tuple(
        Reading(
            row.station_id, fixture.stations[(event_id, row.station_id)],
            (row.pick_time - time_reference).total_seconds(),
        )
        for row in arrivals
    )
    result = replay_solution(readings, station, offset)
    with left:
        st.subheader("Station evidence")
        if result.candidate:
            candidate = result.candidate
            st.markdown(f"**Suspected station: {candidate.station_id}**")
            st.write(f"Estimated offset: {candidate.offset_s:+.2f} s")
            st.caption(f"Timing fit RMS: {result.all_stations.rms_s:.2f} s → {candidate.fit.rms_s:.2f} s")
        elif result.status == "insufficient":
            st.info("At least five station readings are needed.")
        else:
            st.info("Inconclusive. The readings do not identify a single station.")
        if st.button("Reveal scenario", key="replay_reveal", disabled=st.session_state.replay_revealed):
            st.session_state.replay_revealed = True

        if st.session_state.replay_revealed:
            if offset:
                st.write(f"Simulated input: **{station} {offset:+.2f} s**")
            else:
                st.write("Simulated input: **clean arrivals**")

    revealed = st.session_state.replay_revealed
    with right:
        if revealed and result.all_stations:
            clean = fit_location(readings)
            shifted = result.all_stations.location
            metrics = st.columns(3)
            metrics[0].metric("Shift from clean estimate", f"{distance_km(clean.location, shifted):.1f} km")
            metrics[1].metric("All stations to USGS", f"{distance_km(shifted, event):.1f} km")
            if result.candidate:
                distance = distance_km(result.candidate.fit.location, event)
                metrics[2].metric("Suspect excluded to USGS", f"{distance:.1f} km")
        if st.toggle("Street map", key="replay_street_map", help="Show the OpenStreetMap basemap when online."):
            st.plotly_chart(
                replay_street_map(fixture, event_id, result, revealed), key="replay_map",
                config={"scrollZoom": True},
            )
            st.caption("[© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)")
        else:
            st.plotly_chart(replay_map(fixture, event_id, result, revealed), key="replay_map")
        with st.expander("Stations on this map"):
            st.dataframe([
                {
                    "Station": row.station_id,
                    "Site": fixture.stations[(event_id, row.station_id)].name,
                    "Country": "United States",
                    "Latitude": round(fixture.stations[(event_id, row.station_id)].latitude, 4),
                    "Longitude": round(fixture.stations[(event_id, row.station_id)].longitude, 4),
                }
                for row in arrivals
            ], hide_index=True, width="stretch")

    if event_id == MAINSHOCK:
        st.subheader("LD.PAL vertical waveform")
        wave_pick = next(row for row in arrivals if row.station_id == WAVEFORM_STATION)
        marker_shift = offset if revealed and station == WAVEFORM_STATION else None
        st.plotly_chart(
            waveform_chart(fixture, wave_pick.pick_time, marker_shift), key="waveform",
        )


def render_audit(fixture):
    st.header("Station audit")
    st.caption("Seven earthquakes · Six shared stations · April–May 2024")
    st.session_state.setdefault("audit_scenario", (WAVEFORM_STATION, EVALUATION_EVENTS[1], 0.0))
    st.session_state.setdefault("audit_inspected", WAVEFORM_STATION)
    left, right = st.columns([1, 2.3], gap="large")
    with left:
        with st.form("audit_inputs"):
            station = st.selectbox(
                "Station to shift", AUDIT_STATIONS, index=AUDIT_STATIONS.index(WAVEFORM_STATION),
                key="audit_station",
            )
            onset = st.selectbox(
                "First affected event", EVALUATION_EVENTS, index=1,
                format_func=lambda event_id: event_date(fixture, event_id, with_time=True), key="audit_onset",
            )
            offset = st.slider("Persistent shift (s)", -5.0, 5.0, 0.0, step=0.25, key="audit_offset")
            if st.form_submit_button("Run audit", type="primary"):
                st.session_state.audit_scenario = station, onset, offset
                st.session_state.audit_inspected = station
        controls = st.columns(2)
        controls[0].button(
            "Example", key="audit_example", on_click=audit_preset,
            args=(WAVEFORM_STATION, EVALUATION_EVENTS[1], 3.0),
        )
        controls[1].button(
            "Reset", key="audit_reset", on_click=audit_preset,
            args=(WAVEFORM_STATION, EVALUATION_EVENTS[1], 0.0),
        )

    station, onset, offset = st.session_state.audit_scenario
    results = audit(fixture.arrivals, shifted_station=station, onset_event=onset, offset_s=offset)
    with left:
        flagged = [result.station_id for result in results.values() if result.status == "flagged"]
        pending = [result.station_id for result in results.values() if result.status == "pending"]
        if flagged:
            st.warning(f"Persistent disagreement: {', '.join(flagged)}")
        elif pending:
            st.info(f"Awaiting confirmation: {', '.join(pending)}")
        else:
            st.info("No persistent timing disagreement found.")
        st.caption(
            f"Simulated input: {station} {offset:+.2f} s from {event_date(fixture, onset)}"
            if offset else "Input: published residuals"
        )

    with right:
        inspected = st.selectbox("Inspect a station", AUDIT_STATIONS, key="audit_inspected")
        result = results[inspected]
        if result.status == "insufficient":
            st.info("This station has incomplete baseline coverage.")
        if result.first_suspicious_event:
            metrics = st.columns(3)
            metrics[0].metric("First suspicious", event_date(fixture, result.first_suspicious_event))
            metrics[1].metric("Confirmed", event_date(fixture, result.confirming_event))
            estimate = f"{result.estimated_offset_s:+.2f} s" if result.estimated_offset_s is not None else "—"
            metrics[2].metric("Estimated shift", estimate)
            if result.last_normal_event:
                st.caption(f"Last observed normal: {event_date(fixture, result.last_normal_event, with_time=True)}")
        st.plotly_chart(audit_chart(fixture, result), key="audit_timeline")
        with st.expander("Arrival evidence"):
            st.dataframe([
                {
                    "Event (UTC)": event_date(fixture, event, with_time=True),
                    "USGS event ID": event,
                    "Role": "Baseline" if event in BASELINE_EVENTS else "Evaluation",
                    "Deviation (s)": (
                        round(result.deviations_s[event], 2) if result.deviations_s[event] is not None else None
                    ),
                    "Simulated input": bool(
                        offset and inspected == station and event in EVALUATION_EVENTS[EVALUATION_EVENTS.index(onset):]
                    ),
                }
                for event in BASELINE_EVENTS + EVALUATION_EVENTS
            ], hide_index=True, width="stretch")


st.title("QuakeTrace")
view = st.radio(
    "View", ("Earthquake replay", "Station audit", "World explorer"), horizontal=True,
    label_visibility="collapsed",
)
if view == "World explorer":
    render_world()
else:
    try:
        fixture = fixture_data()
    except (OSError, ValueError, KeyError) as error:
        st.error(f"Could not load the local demo fixtures. Restore the fixtures folder or rerun the fixture downloader. {error}")
        st.stop()
    if view == "Earthquake replay":
        render_replay(fixture)
    else:
        render_audit(fixture)
st.caption("Data: USGS ComCat and EarthScope / Lamont-Doherty. Map outlines: Natural Earth.")
