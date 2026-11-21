"""Interactive worldwide catalog and station view."""

from datetime import UTC, datetime, timedelta
from urllib.parse import quote
from xml.etree.ElementTree import ParseError

import plotly.graph_objects as go
import streamlit as st

from .charts import street_map_layout
from .world import (
    Area, CITIES, SEARCH_LIMIT, around, countries, country_at, reporting_stations, search_events,
)

WORLDWIDE = "Worldwide"
COORDINATES = "Enter latitude and longitude"


@st.cache_data(ttl=600, max_entries=64, show_spinner=False)
def catalog_results(area, start, end, magnitude, largest_first):
    return search_events(area, start, end, magnitude, largest_first=largest_first)


@st.cache_data(ttl=3600, max_entries=64, show_spinner=False)
def station_results(event_id):
    return reporting_stations(event_id)


def station_name(report):
    return report.location.name if report.location and report.location.name else report.id


def station_country(report):
    if report.location:
        return country_at(report.location.latitude, report.location.longitude)
    return None


def _map(area, events, event, reports, selected_station, footprint):
    figure = go.Figure()
    other_events = [row for row in events if row != event]
    if other_events:
        figure.add_trace(go.Scattermap(
            lat=[row.latitude for row in other_events], lon=[row.longitude for row in other_events],
            customdata=[(row.place, row.magnitude, row.time.strftime("%Y-%m-%d %H:%M UTC")) for row in other_events],
            mode="markers", name="Earthquakes", marker={"size": 10, "color": "#b7521e", "opacity": 0.75},
            hovertemplate="%{customdata[0]}<br>M %{customdata[1]:.1f} · %{customdata[2]}<extra></extra>",
        ))
    for verified, name, color in (
        (True, "Stations · registry coordinates", "#1b7571"),
        (False, "Stations · estimated coordinates", "#657596"),
    ):
        stations = [
            row for row in reports if row.location and (row.source == "EarthScope station metadata") == verified
        ]
        if stations:
            figure.add_trace(go.Scattermap(
                lat=[row.location.latitude for row in stations],
                lon=[row.location.longitude for row in stations],
                customdata=[
                    (station_name(row), row.id, station_country(row) or "Country unavailable", row.source)
                    for row in stations
                ],
                mode="markers", name=name, marker={"size": 8, "color": color, "opacity": 0.82},
                hovertemplate="%{customdata[0]} · %{customdata[1]}<br>%{customdata[2]}<br>%{customdata[3]}<extra></extra>",
            ))
    if event:
        figure.add_trace(go.Scattermap(
            lat=[event.latitude], lon=[event.longitude], text=[event.place], mode="markers",
            name="Selected epicentre", marker={"size": 17, "color": "#b92d24"},
            hovertemplate="%{text}<extra></extra>",
        ))
    if selected_station and selected_station.location:
        location = selected_station.location
        figure.add_trace(go.Scattermap(
            lat=[location.latitude], lon=[location.longitude], text=[station_name(selected_station)],
            mode="markers", name="Selected station", marker={"size": 15, "color": "#164b8a"},
            hovertemplate="%{text}<extra></extra>",
        ))
    if event and footprint:
        camera = Area(15, event.longitude, 1.05)
    elif selected_station and selected_station.location:
        location = selected_station.location
        camera = Area(location.latitude, location.longitude, 7.0)
    elif event:
        camera = Area(event.latitude, event.longitude, 5.1)
    else:
        camera = area
    if not figure.data:
        figure.add_trace(go.Scattermap(
            lat=[camera.latitude], lon=[camera.longitude], marker={"opacity": 0},
            showlegend=False, hoverinfo="skip",
        ))
    # Keep the viewport when a form or table reruns with the same map subject.
    revision = "|".join(map(str, (area, event.id if event else "", selected_station.id if selected_station else "", footprint)))
    return street_map_layout(figure, camera.latitude, camera.longitude, camera.zoom, revision, height=560)


def render_world():
    st.header("World explorer")
    st.caption("Find real earthquakes in the USGS catalog and see which stations contributed arrival readings.")
    regions = countries()
    area_name = st.selectbox(
        "Search area",
        [WORLDWIDE, COORDINATES, *sorted(CITIES), *sorted(regions)],
        key="world_area",
        help="Type a country or a listed city to filter the choices.",
    )
    today = datetime.now(UTC).date()
    start_default = today - timedelta(days=30)
    st.session_state.setdefault("world_query", (Area(), start_default, today, 4.5, False, WORLDWIDE))
    with st.form("world_search"):
        if area_name in CITIES or area_name == COORDINATES:
            location_columns = st.columns(3)
            if area_name == COORDINATES:
                latitude = location_columns[0].number_input("Latitude", -90.0, 90.0, 40.7, step=0.1)
                longitude = location_columns[1].number_input("Longitude", -180.0, 180.0, -74.0, step=0.1)
            else:
                latitude, longitude = CITIES[area_name]
            radius = location_columns[2].number_input("Radius (km)", 10, 5000, 500, step=50)
            area = around(latitude, longitude, radius)
        elif area_name == WORLDWIDE:
            area = Area()
        else:
            area = regions[area_name].area
        fields = st.columns(4)
        start = fields[0].date_input("From (UTC)", start_default)
        end = fields[1].date_input("Through (UTC)", today)
        magnitude = fields[2].number_input("Minimum magnitude", 0.0, 9.9, 4.5, step=0.1)
        order = fields[3].selectbox("Sort by", ("Most recent", "Largest magnitude"))
        if st.form_submit_button("Search earthquakes", type="primary"):
            if start <= end:
                if area_name == COORDINATES:
                    label = f"Within {radius:,} km of {latitude:.2f}°, {longitude:.2f}°"
                elif area_name in CITIES:
                    label = f"Within {radius:,} km of {area_name}"
                elif area_name == WORLDWIDE:
                    label = WORLDWIDE
                else:
                    label = f"In and near {area_name}"
                st.session_state.world_query = area, start, end, magnitude, order == "Largest magnitude", label
                st.session_state.pop("world_event", None)
            else:
                st.error("Choose an end date on or after the start date.")

    area, start, end, magnitude, largest_first, label = st.session_state.world_query
    search_failed = False
    with st.spinner("Loading earthquakes from USGS…"):
        try:
            events = catalog_results(area, start, end, magnitude, largest_first)
        except (OSError, ValueError, KeyError):
            st.warning("The USGS catalog is unavailable right now. Try the search again in a moment.")
            events = ()
            search_failed = True
    st.caption(f"{label} · {start:%Y-%m-%d} to {end:%Y-%m-%d} UTC · M {magnitude:.1f}+")
    if len(events) == SEARCH_LIMIT:
        order_description = "largest" if largest_first else "most recent"
        st.caption(f"Showing the {SEARCH_LIMIT} {order_description} matches. Narrow the dates or raise the minimum magnitude.")

    event = None
    station = None
    reports = ()
    footprint = False
    if events:
        event_index = {row.id: row for row in events}

        def event_label(event_id):
            row = event_index[event_id]
            return f"M {row.magnitude:.1f} · {row.place} · {row.time:%b %d, %Y}"

        event_id = st.selectbox(
            "Earthquake", list(event_index), index=None, placeholder="Choose a catalog earthquake",
            format_func=event_label, key="world_event",
        )
        event = event_index.get(event_id)
    elif not search_failed:
        st.info("No earthquakes to display for this search.")

    if event:
        country = country_at(event.latitude, event.longitude)
        st.subheader(event.place)
        st.caption(
            f"{country or 'Offshore or outside the bundled country boundaries'} · "
            f"{event.time:%Y-%m-%d %H:%M UTC} · M {event.magnitude:.1f} · {event.depth_km:.1f} km deep"
        )
        st.link_button("USGS event details", event.url)
        station_lookup_failed = False
        with st.spinner("Loading reporting stations…"):
            try:
                reports = station_results(event.id)
            except (OSError, ValueError, KeyError, ParseError):
                st.warning("The station records could not be loaded for this event.")
                station_lookup_failed = True
        if reports:
            by_station = {row.id: row for row in reports}
            control, other = st.columns([3, 1])
            station_id = control.selectbox(
                "Reporting station", list(by_station), index=None, placeholder="Choose a station to locate it",
                format_func=lambda station_id: (
                    f"{station_id} · {station_name(by_station[station_id])}"
                    if station_name(by_station[station_id]) != station_id else station_id
                ),
                key=f"world_station_{event.id}",
            )
            station = by_station.get(station_id)
            footprint = other.checkbox("Show worldwide station footprint", key="world_footprint")
        elif not station_lookup_failed:
            st.caption("No reporting stations are available from the published phase data for this earthquake.")

    st.plotly_chart(_map(area, events, event, reports, station, footprint), key="world_map", config={"scrollZoom": True})
    st.caption("Orange markers are earthquakes. Teal stations have registry coordinates. Grey station positions are estimates. [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)")

    if station:
        st.subheader(station_name(station))
        country = station_country(station)
        distance = f"{station.distance_km:,.0f} km from the epicentre" if station.distance_km is not None else ""
        st.write(" · ".join(part for part in (station.id, country, distance, station.source) if part))
        if station.location:
            st.caption(f"{station.location.latitude:.4f}° latitude, {station.location.longitude:.4f}° longitude")
        network = station.id.split(".", 1)[0]
        st.link_button("FDSN network record", f"https://www.fdsn.org/networks/detail/{quote(network, safe='')}/")
    if reports:
        mapped = sum(row.location is not None for row in reports)
        with st.expander(f"Station records · {len(reports)} reporting, {mapped} mapped", expanded=bool(station)):
            st.dataframe([
                {
                    "Station": row.id,
                    "Site name": row.location.name if row.location else "",
                    "Country": station_country(row) or "",
                    "Distance (km)": round(row.distance_km) if row.distance_km is not None else None,
                    "Reported phases": ", ".join(row.phases),
                    "Coordinates": row.source,
                }
                for row in reports
            ], hide_index=True, width="stretch")
