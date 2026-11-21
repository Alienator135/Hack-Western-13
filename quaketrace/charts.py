"""Offline charts for the two QuakeTrace views."""

from datetime import datetime, timedelta

import numpy as np
import plotly.graph_objects as go

from .audit import AuditResult, THRESHOLD_S
from .data import BASELINE_EVENTS, EVALUATION_EVENTS, Fixture, WAVEFORM_STATION
from .replay import ReplayResult, project

GREEN = "#176d63"
ORANGE = "#ac471a"
INK = "#273556"
MUTED = "#687e77"


def street_map_layout(figure, latitude, longitude, zoom, revision, *, height=480):
    figure.update_layout(
        map={
            "style": "open-street-map",
            "center": {"lat": max(-83, min(83, latitude)), "lon": longitude},
            "zoom": zoom, "uirevision": revision,
        },
        height=height, margin={"l": 0, "r": 0, "t": 0, "b": 0},
        legend={"orientation": "h", "yanchor": "top", "y": 0.99, "bgcolor": "rgba(255,255,255,0.9)"},
    )
    return figure


def replay_street_map(fixture: Fixture, event_id: str, result: ReplayResult, revealed: bool):
    stations = [
        (station, location)
        for (event, station), location in fixture.stations.items() if event == event_id
    ]
    candidate = result.candidate
    figure = go.Figure(go.Scattermap(
        lat=[location.latitude for _, location in stations],
        lon=[location.longitude for _, location in stations],
        customdata=[(station, location.name) for station, location in stations],
        mode="markers", name="Stations",
        marker={
            "size": [14 if candidate and station == candidate.station_id else 9 for station, _ in stations],
            "color": [ORANGE if candidate and station == candidate.station_id else MUTED for station, _ in stations],
        },
        hovertemplate="%{customdata[1]}<br>%{customdata[0]} · United States<extra></extra>",
    ))
    estimates = []
    if result.all_stations:
        estimates.append((result.all_stations.location, "All stations", ORANGE, 17))
    if candidate:
        estimates.append((candidate.fit.location, "Suspect excluded", GREEN, 14))
    if revealed:
        estimates.append((fixture.events[event_id], "USGS reference", INK, 10))
    for location, label, color, size in estimates:
        figure.add_trace(go.Scattermap(
            lat=[location.latitude], lon=[location.longitude], mode="markers", name=label,
            marker={"color": color, "size": size}, hovertemplate="%{fullData.name}<extra></extra>",
        ))
    latitude = np.mean([location.latitude for _, location in stations])
    longitude = np.mean([location.longitude for _, location in stations])
    return street_map_layout(figure, latitude, longitude, 6.8, event_id)


def replay_map(fixture: Fixture, event_id: str, result: ReplayResult, revealed: bool):
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
        station: coords for (event, station), coords in fixture.stations.items() if event == event_id
    }
    scatter_data = [(station, *project(coords.latitude, coords.longitude)) for station, coords in stations.items()]
    station_ids, east, north = zip(*scatter_data)
    cities = (("New York City", 40.7128, -74.0060), ("Philadelphia", 39.9526, -75.1652))
    city_points = [project(latitude, longitude) for _, latitude, longitude in cities]
    fig.add_scatter(
        x=[point[0] for point in city_points], y=[point[1] for point in city_points],
        text=[name for name, _, _ in cities], mode="markers+text", textposition="bottom left",
        textfont={"color": INK, "size": 11}, marker={"color": INK, "size": 4},
        showlegend=False, hoverinfo="skip",
    )
    suspect = result.candidate.station_id if result.candidate else None
    fig.add_scatter(
        x=east, y=north, customdata=[(station, stations[station].name) for station in station_ids],
        name="Stations", mode="markers",
        marker={
            "size": [13 if station == suspect else 9 for station in station_ids],
            "color": [ORANGE if station == suspect else MUTED for station in station_ids],
            "symbol": "triangle-up", "line": {"color": "white", "width": 1},
        },
        hovertemplate="%{customdata[1]}<br>%{customdata[0]} · United States<extra></extra>",
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
        positions.append(marker(fixture.events[event_id], "USGS reference", "star", INK, 16))
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
