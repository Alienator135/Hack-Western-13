"""Offline charts for the two QuakeTrace views."""

from datetime import datetime, timedelta

import numpy as np
import plotly.graph_objects as go

from .audit import AuditResult, THRESHOLD_S
from .data import BASELINE_EVENTS, EVALUATION_EVENTS, MAINSHOCK, Fixture, WAVEFORM_STATION
from .replay import ReplayResult, project

GREEN = "#176d63"
ORANGE = "#ac471a"
INK = "#273556"
MUTED = "#687e77"


def replay_map(fixture: Fixture, result: ReplayResult, revealed: bool):
    fig = go.Figure()
    for feature in fixture.outlines["features"]:
        geometry = feature["geometry"]
        polygons = geometry["coordinates"]
        if geometry["type"] == "Polygon":
            polygons = [polygons]
        for polygon in polygons:
            for ring in polygon:
                longitude, latitude = np.asarray(ring).T
                x, y = project(latitude, longitude)
                fig.add_scatter(
                    x=x, y=y, mode="lines", line={"color": "#b8c8bd", "width": 1},
                    hoverinfo="skip", showlegend=False,
                )

    stations = {
        station: coords for (event, station), coords in fixture.stations.items() if event == MAINSHOCK
    }
    scatter_data = [(station, *project(coords.latitude, coords.longitude)) for station, coords in stations.items()]
    station_ids, east, north = zip(*scatter_data)
    suspect = result.candidate.station_id if result.candidate else None
    fig.add_scatter(
        x=east, y=north, text=station_ids, name="Stations", mode="markers",
        marker={
            "size": [13 if station == suspect else 9 for station in station_ids],
            "color": [ORANGE if station == suspect else MUTED for station in station_ids],
            "symbol": "triangle-up", "line": {"color": "white", "width": 1},
        },
        hovertemplate="%{text}<extra></extra>",
    )

    def marker(location, label, symbol, color, size):
        x, y = project(location.latitude, location.longitude)
        fig.add_scatter(
            x=[x], y=[y], name=label, mode="markers",
            marker={"size": size, "symbol": symbol, "color": color, "line": {"color": "white", "width": 1}},
            hovertemplate="%{fullData.name}<extra></extra>",
        )
        return x, y

    positions = list(zip(east, north))
    if result.all_stations:
        positions.append(marker(result.all_stations.location, "All stations", "diamond", ORANGE, 15))
    if result.candidate:
        positions.append(marker(result.candidate.fit.location, "Suspect excluded", "circle", GREEN, 14))
    if revealed:
        positions.append(marker(fixture.events[MAINSHOCK], "USGS reference", "star", INK, 16))
    xs, ys = zip(*positions)
    fig.update_xaxes(title="East (km)", range=[min(xs) - 13, max(xs) + 13], zeroline=False)
    fig.update_yaxes(
        title="North (km)", range=[min(ys) - 13, max(ys) + 13], scaleanchor="x", scaleratio=1, zeroline=False,
    )
    fig.update_layout(
        height=480, margin={"l": 10, "r": 10, "t": 12, "b": 16},
        legend={"orientation": "h", "y": -0.17}, dragmode="pan",
    )
    return fig


def waveform_chart(fixture: Fixture, measured: datetime, simulated_shift_s: float | None):
    x, y = zip(*fixture.waveform)
    fig = go.Figure(go.Scatter(
        x=x, y=y, mode="lines", line={"color": INK, "width": 1}, name=f"{WAVEFORM_STATION} HHZ",
        hovertemplate="%{x|%H:%M:%S.%L} UTC · %{y} counts<extra></extra>",
    ))
    fig.add_vline(x=measured, line_color=GREEN, line_width=2)
    fig.add_annotation(x=measured, y=1, yref="paper", text="Catalog pick", showarrow=False, yshift=10)
    if simulated_shift_s:
        shifted_time = measured + timedelta(seconds=simulated_shift_s)
        fig.add_vline(x=shifted_time, line_color=ORANGE, line_width=2, line_dash="dash")
        fig.add_annotation(x=shifted_time, y=0.86, yref="paper", text="Simulated pick", showarrow=False, yshift=8)
    fig.update_xaxes(title="Time (UTC)", tickformat="%H:%M:%S")
    fig.update_yaxes(title="Recorded counts")
    fig.update_layout(height=280, margin={"l": 12, "r": 10, "t": 30, "b": 15})
    return fig


def audit_chart(fixture: Fixture, result: AuditResult):
    events = BASELINE_EVENTS + EVALUATION_EVENTS
    times = [fixture.events[event].time for event in events]
    deviations = [result.deviations_s[event] for event in events]
    colors = [
        ORANGE if event in result.supporting_events else GREEN if event in BASELINE_EVENTS else MUTED
        for event in events
    ]
    labels = [
        "Baseline" if event in BASELINE_EVENTS
        else "First suspicious" if event == result.first_suspicious_event
        else "Confirmation" if event == result.confirming_event
        else "Supporting" if event in result.supporting_events
        else "Last observed normal" if event == result.last_normal_event
        else "Evaluation"
        for event in events
    ]
    fig = go.Figure(go.Scatter(
        x=times, y=deviations, mode="lines+markers", text=labels, name="Deviation",
        line={"color": MUTED, "width": 1.5}, marker={"color": colors, "size": 12},
        hovertemplate="%{x|%b %d %H:%M} UTC<br>%{y:+.2f} s · %{text}<extra></extra>",
    ))
    for threshold in (-THRESHOLD_S, THRESHOLD_S):
        fig.add_hline(y=threshold, line_color=ORANGE, line_dash="dash")
    fig.add_hline(y=0, line_color=MUTED, line_width=1)
    for time, deviation in zip(times, deviations):
        if deviation is None:
            fig.add_annotation(x=time, y=0, text="Missing", showarrow=False, yshift=10)
    fig.update_xaxes(title="Event time (UTC)", tickformat="%b %d")
    fig.update_yaxes(title="Change from station baseline (s)")
    fig.update_layout(height=355, margin={"l": 12, "r": 10, "t": 12, "b": 15}, showlegend=False)
    return fig
