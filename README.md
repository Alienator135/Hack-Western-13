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

To run against Tiger Data, put your connection settings in a `.env` file in the repository root (see `.env.example`, or save Tiger Cloud's downloaded credentials file as `.env`). It is gitignored and loaded at startup, so the same commands work on Windows and macOS. On macOS, for example:

```sh
cp ~/Downloads/tiger-cloud-quaketrace-credentials.env .env
.venv/bin/python scripts/tiger_data.py health --station LD.PAL --onset 2024-04-27 --offset 3
.venv/bin/python server.py
```

The Tiger service already holds the data once seeded, so a new machine only needs `.env`; run `seed` and `seed-history` again only for a new service.

Installing dependencies requires internet access. After installation, Replay and Station Audit work offline using the committed fixture, including the waveform and state outlines. The earlier Streamlit app, which also has the World Explorer, still runs with `.venv/Scripts/python.exe -m streamlit run app.py` (`.venv/bin/python` on macOS).

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

QuakeTrace keeps two things in Tiger Data (TimescaleDB):

- **Years of station timing history.** Every north-east US earthquake since 2018 with published USGS phase data, and every arrival those solutions used, in the `quaketrace.picks` hypertable. The hypertable uses yearly chunks; chunks older than 180 days are compressed (columnstore, ordered by station, phase and time), and the `quaketrace.station_monthly` continuous aggregate keeps each station's monthly mean P-wave residual up to date. **Station audit → Every station's clock** reads the aggregate. When a judge breaks a clock in history, the same view is computed live from the raw hypertable, with the shift applied in SQL.
- **The seven demo quakes.** The 45 bundled arrivals used by Replay and the seven-quake audit, in `quaketrace.arrivals`.

1. In Tiger Console, create a service with **TimescaleDB** enabled and copy its PostgreSQL connection string. [Create a Tiger Cloud service](https://www.tigerdata.com/docs/get-started/quickstart/create-service) · [Find the connection details](https://www.tigerdata.com/docs/integrate/find-connection-details)
2. From the repository root in PowerShell 7, enter the connection string in a masked prompt, load both datasets, and check them:

   ```powershell
   .venv/Scripts/python.exe -m pip install -r requirements.txt
   $env:QUAKETRACE_TIGER_DSN = Read-Host -MaskInput "Tiger Data PostgreSQL connection string"
   .venv/Scripts/python.exe scripts/tiger_data.py seed
   .venv/Scripts/python.exe scripts/tiger_data.py seed-history
   .venv/Scripts/python.exe scripts/tiger_data.py verify
   .venv/Scripts/python.exe scripts/tiger_data.py health --station LD.PAL --onset 2024-04-27 --offset 3
   .venv/Scripts/python.exe server.py
   ```

3. `seed-history` creates the schema, bulk-loads the picks with `COPY`, compresses old chunks, creates the continuous aggregate with a refresh policy, and prints the row, chunk, and compression totals. `health` runs the same query the UI uses and prints each station's status, so you can confirm Tiger flags the injected shift before presenting.

The simplest setup: save the credentials file Tiger Cloud lets you download as `.env` in the repository root. Git ignores it, and `server.py` and `scripts/tiger_data.py` load it at startup, using `TIMESCALE_SERVICE_URL` and the `PG*` variables in it. Variables already set in your shell take precedence. Otherwise, start the server in the same shell where you set the connection string. With Tiger connected, the history card says **Live from Tiger Data** and shows the hypertable's chunk count, compression ratio, and each query's time. Without it, or if Tiger is unreachable, the card says **Bundled copy** and computes the same view from `fixtures/history`, so the demo never depends on venue Wi-Fi. Both seed commands can be rerun; existing rows are skipped. `seed-history --rebuild` drops and recreates only the history objects (`picks`, `events`, `station_monthly`) and reloads them, which is needed after changing chunk or compression settings. It leaves the demo arrivals table alone.

The history bundle is built from USGS by `scripts/fetch_history.py`, which caches raw responses under `fixtures/raw/history` and backs off when USGS rate-limits. [TimescaleDB hypertables](https://www.tigerdata.com/docs/use-timescale/latest/hypertables/) · [Continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/) · [Compression](https://www.tigerdata.com/docs/use-timescale/latest/compression/)

## Explore elsewhere

In the Streamlit app, open **World explorer**, pick **Worldwide**, a country, a listed city, or your own latitude and longitude, then choose dates and a minimum magnitude. **Search earthquakes** retrieves up to 100 matches from USGS. Country searches cover the surrounding region, including offshore and neighbouring events. Choose an earthquake to see its location and the stations in its published arrival records, then choose a station to zoom to it. **Show worldwide station footprint** shows stations that detected the event from far away.

Station names and registry coordinates come from EarthScope where available. Estimated positions use the distance and bearing published with the USGS arrival and are labelled separately. Some catalog events have no publicly available arrival data. Use **Street map** in Replay to see geographic context for the seven bundled clock-shift scenarios. [USGS earthquake catalog](https://earthquake.usgs.gov/fdsnws/event/1/) · [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)

## Solver lab

Open **Solver lab** to show how QuakeTrace locates a quake. It draws the solver's real intermediate data, not an illustration.

- **Grid search** animates every candidate epicentre `fit_location` evaluates: 8,100 cells on a 2 km grid, coloured by misfit as they are tested, then 625 cells on a 250 m grid in a zoomed inset around the coarse winner.
- **Misfit heatmap** shows the whole surface with 0.5, 1, 2 and 4 s contours. Hover a cell to read the misfit if the quake had been there.
- **Wavefronts** plays the P wave spreading from the best fit. Each station pulses when the model says the wave arrives and again when its clock recorded it, so a shifted clock visibly fires late.
- **Leave one out** shows the nine refits as small multiples. The lying station is the one whose removal makes the bowl deep and tight. Click one to load it.

Pick a scenario at the top, or open the lab from any Replay step to carry the judge's scenario across. A secret scenario stays hidden until **Show secret**.

## Three-minute demo

The app opens on **Present**, a step-by-step walkthrough meant to be presented to judges. Press **F** for full screen and use **→ / Space** to advance, **←** to go back and **R** to replay a step's animation. Presentation clickers that send Page Down / Page Up also work.

1. **The judge breaks a clock.** Hand over the laptop: they pick a station and a shift, or select **Let the app pick secretly**.
2. **Walk through the 12 steps.** Each one has a sentence to say and an animation: stations and their arrival times, one candidate point, distance to a station, travel time at 6 km/s, the start time each station implies, the spread of start times as the point's score, scoring all 8,100 grid points, refining on a 250 m grid, the best point against USGS, leaving each station out in turn, and the culprit.
3. **Reveal.** Injected against found shift, and the error against USGS with and without the suspect.
4. **Close with the audit.** **When did PAL's clock break?** opens the station audit for the same station across seven quakes.
5. **Scale it up with Tiger Data.** **Scale it up: every quake since 2018** injects the judge's shift into years of real station history and shows Tiger Data catch it, with the query time on screen.

**Replay**, **Station audit** and **Solver lab** remain in the header for questions.

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
| `web/` | The QuakeTrace UI: presenter walkthrough, guided replay, station audit, solver lab, and the Google Maps, Earth 3D, and offline map views |
| `quaketrace/api.py` | JSON payloads for the UI: fits, best-fit zones, solver grid traces, leave-one-out surfaces, audit grid |
| `app.py` | Earlier Streamlit app, including World Explorer |
| `quaketrace/` | Fixture loading, location fit, station audit, multi-year history, Tiger Data storage, maps, and live catalog exploration |
| `scripts/fetch_history.py` | Downloads the multi-year USGS arrival history into `fixtures/history` |
| `scripts/tiger_data.py` | Seeds Tiger Data with the demo arrivals and the history, and queries station health |
| `scripts/fetch_fixtures.py` | Public source download, parsing, validation, and fixture generation |
| `fixtures/` | Seven event origins, 45 arrival and station-epoch records, waveform, local outlines, and provenance manifest. `fixtures/history` holds the multi-year history bundle |
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
