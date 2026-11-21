# QuakeTrace

QuakeTrace replays seven recorded earthquakes from the Tewksbury, New Jersey sequence and shows how a simulated station clock error can move an estimated epicentre. Its station audit uses the same USGS events to estimate when a persistent timing discrepancy first appeared and which later events support it.

## Run locally

Use Python 3.12. On Windows from PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe server.py
```

On macOS or Linux:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

Open http://127.0.0.1:8000. `server.py` serves the web UI in `web/` and a JSON API backed by the `quaketrace` package, using only the Python standard library on top of the existing requirements. Use `--port` to change the port.

Installing dependencies requires internet access. After installation, Replay and Station Audit work offline using the committed fixture, including the waveform and state outlines. The earlier Streamlit app, which also has the World Explorer, still runs with `.venv/Scripts/python.exe -m streamlit run app.py`.

## Google Maps and Earth

Without a key the maps draw the bundled state outlines. With a Google Maps browser key, every map gets **Map**, **Satellite**, and **Earth 3D** buttons. Earth 3D uses Google's photorealistic 3D tiles and shows each station's ray to the estimated epicentre. Every map also has an **Open in Google Earth** link that needs no key.

1. In Google Cloud Console, enable **Maps JavaScript API** for Map and Satellite. Enable **Map Tiles API** for Earth 3D. [Get an API key](https://developers.google.com/maps/documentation/javascript/get-api-key) · [3D Maps](https://developers.google.com/maps/documentation/javascript/3d/overview)
2. Restrict the key to HTTP referrers such as `http://127.0.0.1:8000/*` and `http://localhost:8000/*`.
3. Either start the server with the key:

   ```powershell
   $env:GOOGLE_MAPS_API_KEY = Read-Host -MaskInput "Google Maps browser key"
   .venv/Scripts/python.exe server.py
   ```

   or select **About** in the app and paste the key. That copy stays in the browser's local storage. **Use offline map** there turns Google off again.

Markers use Google's `DEMO_MAP_ID`. Set `GOOGLE_MAPS_MAP_ID` to use your own cloud-styled map. If Google rejects the key or a library fails to load, the map falls back to the offline outlines and says why.

## Tiger Data

Tiger Data can supply the real arrival picks used by Replay and Station Audit. The seed command writes the 45 fixture arrivals to a TimescaleDB hypertable partitioned by earthquake time. The app queries the matching fixture revision by station and time. The source measurements stay intact when a judge applies a simulated delay. The bundled map and waveform remain available offline.

1. In Tiger Console, create a development service with **TimescaleDB** enabled and copy its PostgreSQL connection string. [Create a Tiger Cloud service](https://www.tigerdata.com/docs/get-started/quickstart/create-service) · [Find the connection details](https://www.tigerdata.com/docs/integrate/find-connection-details)
2. From the repository root in PowerShell 7, install the updated dependencies and enter the connection string in a masked prompt:

   ```powershell
   .venv/Scripts/python.exe -m pip install -r requirements.txt
   $env:QUAKETRACE_TIGER_DSN = Read-Host -MaskInput "Tiger Data PostgreSQL connection string"
   .venv/Scripts/python.exe scripts/tiger_data.py seed
   .venv/Scripts/python.exe scripts/tiger_data.py verify
   .venv/Scripts/python.exe scripts/tiger_data.py history --station LD.PAL
   .venv/Scripts/python.exe server.py
   ```

3. Run `verify` for the demo check. It compares every cloud arrival with its bundled counterpart and runs the Palisades audit against the queried rows. `history` shows which weeks have station data and uses TimescaleDB's `time_bucket` to summarize event-centred timing residuals. [TimescaleDB time buckets](https://www.tigerdata.com/docs/reference/timescaledb/hyperfunctions/time-series-utilities/time_bucket)

The script reads the connection string from the current shell. Start the server in that same shell so it inherits the setting. The seed command can be rerun and inserts each revision only once. If the database is unavailable or the requested revision is missing rows, the app logs the reason and loads the bundled arrivals. The header shows **Ready · Tiger Data** when the cloud arrivals are in use, and **Station audit → Under the hood** names the active source.

## Explore elsewhere

In the Streamlit app, open **World explorer**, pick **Worldwide**, a country, a listed city, or your own latitude and longitude, then choose dates and a minimum magnitude. **Search earthquakes** retrieves up to 100 matches from USGS. Country searches cover the surrounding region, including offshore and neighbouring events. Choose an earthquake to see its location and the stations in its published arrival records, then choose a station to zoom to it. **Show worldwide station footprint** shows stations that detected the event from far away.

Station names and registry coordinates come from EarthScope where available. Estimated positions use the distance and bearing published with the USGS arrival and are labelled separately. Some catalog events have no publicly available arrival data. Use **Street map** in Replay to see geographic context for the seven bundled clock-shift scenarios. [USGS earthquake catalog](https://earthquake.usgs.gov/fdsnws/event/1/) · [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)

## Three-minute demo

1. **Real quake and tamper.** The map shows the nine stations that recorded the April 5 mainshock and QuakeTrace's own estimate. As the judge, choose a station and a clock shift, then select **Lock it in**. **Let the app pick secretly** chooses both without showing them.
2. **Damage.** See how far the estimated epicentre moved and how the teal best-fit zone stretched. **Details** shows each station's residual and the fit statistics.
3. **Investigate.** QuakeTrace refits without each station in turn. The arrival-time chart shows the suspect's reading against the expected 6 km/s line, and **Step through the runs** shows each refit on the map.
4. **Reveal.** Compare the injected and found shifts and the error against the USGS epicentre with and without the suspect. Export the result as PNG or CSV.
5. **Station audit.** **Check PAL across 7 quakes** carries the shift into the audit from April 27. The heatmap and finding show when the clock broke and which GPS log window to review. **Judge controls** runs any other scenario, and **Mark as suspect** or **Dismiss** records a decision in this browser.

| Scenario | Result on the committed fixture |
|---|---|
| Clean mainshock | All-station estimate 2.48 km from USGS, with no station flagged |
| `LD.PAL +5 s` | LD.PAL flagged at +4.96 s, with USGS error improving from 9.27 km to 2.79 km after exclusion |
| `LD.PAL −5 s` | LD.PAL flagged at −5.04 s |
| `LD.PAL +3 s` from April 27 | First suspicious on April 27, confirmed May 1, supported May 24, estimated shift +2.88 s |

## Project structure

| Path | Purpose |
|---|---|
| `server.py` | Standard-library web server for the UI and its JSON API |
| `web/` | The QuakeTrace UI: guided replay, station audit, and the Google Maps, Earth 3D, and offline map views |
| `quaketrace/api.py` | JSON payloads for the UI: fits, best-fit zones, leave-one-out runs, audit grid |
| `app.py` | Earlier Streamlit app, including World Explorer |
| `quaketrace/` | Fixture loading, location fit, station audit, maps, and live catalog exploration |
| `scripts/fetch_fixtures.py` | Public source download, parsing, validation, and fixture generation |
| `fixtures/` | Seven event origins, 45 arrival and station-epoch records, waveform, local outlines, and provenance manifest |
| `tests/` | Fixture integrity, parser, solver, audit, API and server, and Streamlit interaction coverage |

Run these from the repository root with the project environment active:

```sh
python -m unittest discover -s tests -v
python scripts/fetch_fixtures.py
```

The second command is for fixture maintainers and requires network access. It uses the current preferred USGS phase product for each event, so an upstream revision can change the fixture. Review the diff and rerun the tests before committing an update. Use `--output PATH` to regenerate into a separate directory for comparison.

## Data and method

- A **Pg pick** is a catalogued arrival timestamp for a crustal P wave. LD.PAL is the Palisades, New York station in the Lamont-Doherty network. HHZ is the vertical seismometer channel used in the waveform view. The simulation changes a copy of one pick or a station’s residual series in memory. [IASPEI seismic phases](https://www.isc.ac.uk/standards/phases/) · [FDSN channel codes](https://docs.fdsn.org/projects/source-identifiers/en/latest/channel-codes.html)
- Replay estimates an origin time and epicentre from relative arrival timing, assuming 5 km depth and 6 km/s wave speed. It reruns the fit once per omitted station and uses explicit fit improvement and ambiguity thresholds. Distances to USGS measure agreement with the catalog. Audit uses signed changes from a station baseline after removing each event’s median residual. Two consecutive same-direction deviations of 1.5 s or more confirm a pattern. The first suspicious timestamp is constrained by the events available for observation. Model mismatch and pick uncertainty can also cause timing disagreement.
- The fixture manifest lists the source URLs, retrieval times, and content hashes. Picks and origins come from USGS ComCat. Station metadata and waveform samples were accessed through the NSF National Geophysical Facility operated by EarthScope Consortium. The waveform is from the Lamont-Doherty Cooperative Seismographic Network. Map outlines are from Natural Earth. [USGS detail format](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson_detail.php) · [EarthScope citation guidance](https://www.earthscope.org/how-to-cite/) · [LD network metadata](https://www.fdsn.org/networks/detail/LD/) · [Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/)
- Timing discrepancies are an established seismic data quality problem. Existing research and monitoring tools include the Paradox Valley network reports, the global timing study by Yang, Song, and Ringler, and EarthScope MUSTANG. [Paradox Valley annual report](https://www.usbr.gov/uc/DocLibrary/Reports/Paradox/20210500-ParadoxValleySeismicNetwork-2020AnnualReport-508-WCAO.pdf) · [USGS timing study](https://pubs.usgs.gov/publication/70226473) · [EarthScope MUSTANG](https://service.earthscope.org/mustang/)
