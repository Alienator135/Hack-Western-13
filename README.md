# QuakeTrace

**Every earthquake location is worked out from clocks nobody checks. QuakeTrace finds the one that's lying.**

Live demo: **https://quaketrace.vercel.app**

Nobody can see where an earthquake starts. Seismologists locate it from the times its first wave reaches stations around it. If one station's clock is off by a few seconds, the computed epicentre quietly moves by kilometres, and standard locators work around the bad reading without saying which station was wrong. Timing faults are a documented, recurring problem in real seismic networks (see [Data and method](#data-and-method)).

QuakeTrace breaks a station's clock on real USGS data, then finds which station it was, by how much, and where the quake really was.

## What you can do

| Tab | What happens |
|---|---|
| **Present** | A 12-step walkthrough on the April 2024 M4.8 Tewksbury, New Jersey quake. A judge breaks one station's clock (or lets the app do it secretly), then watches the solver test 8,100 candidate epicentres, refine to 250 m, and refit without each station in turn until the lying one stands out. With LD.PAL shifted +5 s, it finds +4.96 s and the error against USGS drops from 9.3 km to 2.8 km. |
| **Try any quake** | The judge takes over. Pick any of about 610 real quakes: every north-east US quake since 2018 with 6+ stations within 150 km (including new ones streamed in live), plus 37 worldwide quakes recorded by dense local networks, such as Ridgecrest M7.1. Break any station's clock, or let the app pick secretly and guess before the reveal. QuakeTrace compares itself with an all-station fit and a standard outlier-weighted locator, and names the station it blames. |
| **Scale it up** | The same idea over eight years of station history in Tiger Data. Inject a clock shift into any station from any date, and Tiger Data finds the month it started, live, from a compressed hypertable. New USGS quakes stream in every 15 minutes. |

## Results

Benchmark on all **539** north-east US quakes from 2018–2025 with at least 6 stations within 1.5°. One random station gets a simulated clock error, and each method is scored by its distance from the USGS epicentre:

| Clock error | All stations | Standard (weighted) | QuakeTrace | Broken station named |
|---|---|---|---|---|
| none | 1.86 km | 1.95 km | 1.87 km | 8% false alarms |
| ±1 s | 2.56 km | 2.56 km | 2.58 km | 9% |
| ±2 s | 3.69 km | 2.51 km | 2.40 km | 59% |
| ±3 s | 4.97 km | 2.28 km | 2.16 km | **84%** |
| ±5 s | 8.09 km | 2.33 km | 2.08 km | **95%** |

Medians. Full results, including means and the share within 5 km, are in `fixtures/benchmark.json`.

The honest reading: against the all-station fit, QuakeTrace wins clearly. Against residual weighting, the location is close; QuakeTrace edges it on the median from ±2 s and on the mean at ±5 s (5.6 vs 6.6 km). The real difference is that QuakeTrace **names the broken station**, while weighting works around it silently. Below 2 s, a shifted clock hides inside normal pick scatter.

**Worldwide set:** 37 shallow quakes from dense networks (California, Nevada, Alaska, Puerto Rico, Taiwan) whose untouched readings fit the model within 0.5 s. Shifting every station of every quake in turn, QuakeTrace named it **65%** of the time at ±3 s and **81%** at ±5 s, with no false alarms. That's weaker than the north-east, where the model was tuned, and the app shows both sets of numbers.

## How it works

1. **Locate.** For every point on a 2 km grid (a fixed box around Tewksbury in Present; 300 × 300 km centred on the first station to report in Try any quake), predict when the P wave would reach each station: straight-line distance at 6 km/s from a 5 km deep source. Each station's arrival then implies a start time. The best point is the one where those start times agree most (lowest RMS). Refine on a 250 m grid around it.
2. **Leave one out.** Refit once without each station. If dropping one station makes the rest agree much better (its offset at least 1.5 s, RMS at most 0.65 of the full fit, and no near-tie with another station), that station is blamed, and its offset is the clock error.
3. **Over years.** For station history, each station's monthly mean P residual is compared with the median of its previous six active months. Two active months in a row at least 1.5 s off in the same direction flag a clock change, dated to the first of them.

**Limits.** The model is a local crustal one, so it needs stations within about 150 km of the quake. Most worldwide quakes are heard only by distant stations, whose waves curve through the mantle; locating those needs a global travel-time model, which is the next step. Deep quakes and regions the uniform model fits badly are excluded for the same reason.

## How it uses Tiger Data

- **`quaketrace.picks` hypertable:** every P arrival USGS used for north-east US quakes since 2018, plus worldwide M4.5+ quakes from the live feed. That's about 1.26 million picks from 12,000+ quakes. It uses yearly chunks, and chunks older than 180 days are compressed (columnstore, ordered by station, phase and time).
- **`quaketrace.station_monthly` continuous aggregate (real-time):** each station's monthly mean P residual, grouped by region. **Scale it up** reads it directly. When a judge breaks a clock in history, the same view is computed live from the raw hypertable, with the shift applied in SQL.
- **Live ingest:** a GitHub Actions workflow (`.github/workflows/live-ingest.yml`) asks USGS every 15 minutes for newly published quakes with phase data (north-east US M1.0+, worldwide M4.5+), stores them and their picks, and refreshes the affected aggregate months. Runs are logged in `quaketrace.ingest_runs`.
- **Try any quake** reads Tiger for every quake newer than the bundled history and for the worldwide quakes with nearby stations.
- **`quaketrace.arrivals`:** the 45 arrivals of the seven Tewksbury demo quakes used by Present.

If Tiger is unreachable, every view falls back to the bundled north-east data, so a demo never depends on venue Wi-Fi.

## Three-minute demo

The app opens on **Present**. Press **F** for full screen. **→ / Space** advances, **←** goes back and **R** replays a step. Presentation clickers that send Page Down / Page Up also work.

1. **The judge breaks a clock.** Hand over the laptop: they pick a station and a shift, or choose **Let the app pick secretly**.
2. **Walk through the 12 steps.** Each has one sentence to say and an animation: stations, one candidate point, distance, travel time, implied start times, the score, all 8,100 grid points, the 250 m refinement, the best point against USGS, leaving each station out, and the culprit.
3. **Reveal.** Injected against found shift, and the error against USGS with and without the suspect.
4. **Hand it over: Try any quake.** **Now try it on any real quake** opens the playground. Let a judge pick any quake (a live one from this week, or Ridgecrest under **Worldwide**), break a clock, or let the app pick secretly and have them guess before **Reveal the answer**.
5. **Scale it up with Tiger Data.** **Or scale it up** on the reveal carries the judge's shift into eight years of station history, and Tiger Data catches it with the hypertable, compression and query time on screen. Point at the live-feed note: Tiger keeps growing as USGS publishes new quakes, with no redeploy.

Open the site a few minutes before judging: the first request after a quiet spell can take a few seconds. Stay on the **Map** basemap; Satellite and Earth 3D load more slowly. The older Solver lab (`#/lab`) and Benchmark (`#/benchmark`) pages still work by URL for deeper questions.

| Scenario | Result on the committed fixture |
|---|---|
| Clean mainshock | All-station estimate 2.48 km from USGS, with no station flagged |
| `LD.PAL +5 s` | LD.PAL flagged at +4.96 s, with USGS error improving from 9.27 km to 2.79 km after exclusion |
| `LD.PAL −5 s` | LD.PAL flagged at −5.04 s |
| `LD.PAL +3 s` from April 27, 2024 (Scale it up) | Flagged from May 2024, confirmed June 2024, about +2.9 s |

## Run it locally (about 2 minutes)

You need **Python 3.12** and internet for the first install. No database is required: the app runs fully offline from the bundled data, and Tiger Data is an optional upgrade (next section).

**macOS / Linux**

```sh
git clone https://github.com/Alienator135/Hack-Western-13.git
cd Hack-Western-13
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/Alienator135/Hack-Western-13.git
cd Hack-Western-13
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe server.py
```

Open **http://127.0.0.1:8000**. Use `--port 8765` to pick another port. Stop the server with **Ctrl+C**.

Without Tiger Data, **Scale it up** says **Bundled copy** and **Try any quake** lists the 539 bundled north-east quakes.

Run the tests from the repository root:

```sh
python -m unittest discover -s tests -v
```

## Tiger Data setup (about 5 minutes)

You only do steps 1–3 once per Tiger service. On any other machine, step 2 (the `.env` file) is all you need.

### 1. Create a free Tiger Cloud service

1. Sign up at [tigerdata.com](https://www.tigerdata.com/) and open Tiger Console.
2. Create a new service with **TimescaleDB** enabled (the default). Any region and the smallest size are fine. [Create a service guide](https://www.tigerdata.com/docs/get-started/quickstart/create-service)
3. When the service is created, **download the credentials file** Tiger offers (a `.env`-style file with `TIMESCALE_SERVICE_URL` and `PG*` variables). If you missed it, copy the connection string from the service's **Connect** page instead. [Find your connection details](https://www.tigerdata.com/docs/integrate/find-connection-details)

### 2. Put the credentials in `.env`

Save the credentials as `.env` in the repository root. It is gitignored and loaded automatically by `server.py` and `scripts/tiger_data.py`.

**Option A: use the downloaded file (easiest)**

```sh
cp ~/Downloads/tiger-cloud-*-credentials.env .env
```

On Windows: `Copy-Item $HOME\Downloads\tiger-cloud-*-credentials.env .env`

**Option B: paste the connection string**

```sh
cp .env.example .env
```

Then open `.env` and fill in one line:

```sh
TIMESCALE_SERVICE_URL=postgres://tsdbadmin:<password>@<host>:<port>/tsdb?sslmode=require
```

### 3. Load the data (one time per service)

**macOS / Linux**

```sh
.venv/bin/python scripts/tiger_data.py seed
.venv/bin/python scripts/tiger_data.py seed-history
.venv/bin/python scripts/tiger_data.py verify
```

**Windows (PowerShell)**

```powershell
.venv/Scripts/python.exe scripts/tiger_data.py seed
.venv/Scripts/python.exe scripts/tiger_data.py seed-history
.venv/Scripts/python.exe scripts/tiger_data.py verify
```

| Command | What it does |
|---|---|
| `seed` | Creates the `quaketrace` schema and loads the 45 demo arrivals |
| `seed-history` | Loads ~18,500 historical picks with `COPY`, creates the hypertable, compression and the `station_monthly` continuous aggregate, then prints row, chunk and compression totals |
| `verify` | Checks that Tiger returns the same audit results as the bundled data |

Both seed commands are safe to rerun; existing rows are skipped.

### 4. Check it and start the app

```sh
.venv/bin/python scripts/tiger_data.py health --station LD.PAL --onset 2024-04-27 --offset 3
.venv/bin/python server.py
```

`health` runs the same query as the UI and should flag `LD.PAL`. In the browser, **Scale it up** now says **Live from Tiger Data** and shows the chunk count, compression ratio and query time.

### 5. Live updates

While `server.py` runs locally with Tiger connected, it also checks USGS every 10 minutes. In production the **Live ingest** GitHub Action does this every 15 minutes instead (see [Deploy](#deploy)). There are two feeds:

| Feed | Quakes | Roughly |
|---|---|---|
| `northeast` | North-east US, M1.0 and up | 1 a week |
| `world` | Everywhere, M4.5 and up | 10–15 a day |

The continuous aggregate is real-time, so new picks appear in **Scale it up** on the next query, and **Scale it up** shows when the feed last checked and how many quakes arrived in the last 24 hours. The first check after seeding catches up the north-east feed since the bundled history ends (December 2025) and the world feed's last 7 days.

Each check also rechecks a window before Tiger's newest quake (30 days north-east, 7 days world), because USGS often publishes phase data after a quake. Quakes are saved in batches of 40, newest first, so a long backfill keeps its progress. If USGS is unreachable, the run is logged and the app keeps serving what Tiger already has.

**Optional: worldwide history.** Run this once per Tiger service. It saves the newest quakes first, so you can stop it at any time; rerun it to continue and to retry any quakes it skipped. USGS rate-limits downloads, so pick the size to fit your time and storage:

| Backfill | Quakes | Picks | Time |
|---|---|---|---|
| M5.5+ since 2018 (fits a free trial) | about 3,700 | about 600,000 | about 1 hour |
| M4.5+, one year | about 7,800 | about 600,000 | about 3 hours |

```sh
.venv/bin/python scripts/tiger_data.py ingest --feed world --backfill-days 3247 --min-magnitude 5.5
.venv/bin/python scripts/tiger_data.py ingest --feed world --backfill-days 365
```

| To | Run |
|---|---|
| Ingest once by hand (both feeds) | `.venv/bin/python scripts/tiger_data.py ingest` |
| Ingest one feed | `.venv/bin/python scripts/tiger_data.py ingest --feed world` |
| Ingest every 5 minutes without the web server | `.venv/bin/python scripts/tiger_data.py ingest --watch 5` |
| Change how often the local server checks | `.venv/bin/python server.py --ingest-minutes 5` (or `QUAKETRACE_INGEST_MINUTES=5` in `.env`) |
| Turn the local check off | `.venv/bin/python server.py --ingest-minutes 0` |

### Troubleshooting

| Symptom | Fix |
|---|---|
| **Scale it up** still says **Bundled copy** | `.env` is missing or not in the repository root, or the server was started before you created it. Restart `server.py`. |
| Connection or SSL error | Make sure the URL ends in `?sslmode=require` (or `PGSSLMODE=require` is set), and that the service shows as running in Tiger Console. |
| Password authentication failed | The service URL may not contain the password. Add `PGPASSWORD=...` to `.env`. |
| Wrong database used | Variables already set in your shell win over `.env`. Run `unset QUAKETRACE_TIGER_DSN TIMESCALE_SERVICE_URL` (or open a new terminal). |
| `ingest` says "no history yet" | Run `seed-history` first; the live feed continues from the newest quake already in Tiger. |
| "Compression is barely saving space" | Run `scripts/tiger_data.py seed-history --rebuild` to recreate only the history objects with current settings. |

Connection settings are read from `QUAKETRACE_TIGER_DSN`, falling back to `TIMESCALE_SERVICE_URL`, plus the standard `PG*` variables. `seed-history --rebuild` drops and recreates only `picks`, `events` and `station_monthly`, and leaves the demo arrivals alone. [Hypertables](https://www.tigerdata.com/docs/use-timescale/latest/hypertables/) · [Continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/) · [Compression](https://www.tigerdata.com/docs/use-timescale/latest/compression/)

## Deploy

The whole app runs on Vercel as one Python function: `server.py` exposes a WSGI `app` that serves both the page and the API (`vercel.json` and `.python-version` configure it; no build step). Vercel functions can't keep a background loop running, so the live ingest runs from the **Live ingest** GitHub Actions workflow every 15 minutes.

1. **Vercel:** under the project's **Settings → Environment Variables**, add `QUAKETRACE_TIGER_DSN` with your Tiger connection string.
2. **Deploy:** from the repository root, run `vercel deploy --prod` with the [Vercel CLI](https://vercel.com/docs/cli) (`vercel link` once first). Alternatively, connect the GitHub repo under **Settings → Git** so every push to `main` deploys; that needs the repo owner to approve Vercel's GitHub app.
3. **GitHub:** under **Settings → Secrets and variables → Actions**, add the same `QUAKETRACE_TIGER_DSN` as a repository secret. Open **Actions → Live ingest → Run workflow** once to check it; after that it runs on its own.
4. **Locally**, run `server.py --ingest-minutes 0` if you don't want your machine to ingest too.

What stays private: the connection string lives only in `.env` (gitignored, and excluded from the Vercel upload by `.vercelignore` and from the function bundle by `vercel.json`) and in Vercel's and GitHub's secret stores. The site only serves files from `web/`, API errors never include database details, only the slider's 0.5 s shifts are accepted, and visitors can't write to Tiger.

### Maps (free, no key)

The Map, Satellite and Earth 3D views use [MapLibre GL JS](https://maplibre.org/) with free, keyless tiles: OpenStreetMap data from [OpenFreeMap](https://openfreemap.org/), [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) for satellite, and open terrain from AWS for the 3D globe. Scroll over a map to zoom it. Offline, the app falls back to a built-in map drawn from the bundled outlines.

## Project structure

| Path | Purpose |
|---|---|
| `server.py` | Standard-library web server and WSGI app for the UI and its JSON API |
| `web/` | The UI: Present walkthrough, Try any quake, and Scale it up |
| `quaketrace/api.py` | JSON payloads for Present and Scale it up: fits, best-fit zones, solver grid traces, leave-one-out surfaces, station history |
| `quaketrace/benchmark.py` | Local locator and benchmark: relocates every eligible quake with three methods |
| `quaketrace/playground.py` | Try any quake: the quake list (bundled, plus live and worldwide quakes from Tiger) and one-quake relocation |
| `quaketrace/history.py` | Multi-year history: USGS QuakeML parsing, monthly residuals and the clock-change rule |
| `quaketrace/tiger.py` | Tiger Data schema, seeding, queries and the shared connection |
| `quaketrace/live.py` | Live USGS ingest into Tiger Data (north-east and worldwide feeds) |
| `quaketrace/` (other) | Fixture loading, the Present solver (`replay.py`), the seven-quake audit and source parsers |
| `scripts/tiger_data.py` | Seeds Tiger Data, verifies it, runs the live ingest and queries station health |
| `scripts/fetch_history.py` | Downloads the multi-year USGS arrival history into `fixtures/history` |
| `scripts/run_benchmark.py` | Precomputes `fixtures/benchmark.json` (about 40 s) |
| `scripts/fetch_fixtures.py` | Downloads, validates and builds the seven-quake demo fixture |
| `fixtures/` | Seven event origins, 45 arrival and station-epoch records, waveform, local outlines and provenance manifest; `fixtures/history` holds the multi-year history bundle |
| `tests/` | Fixtures, parsers, solver, audit, history, benchmark, Try any quake, Tiger Data, API and server |

`python scripts/fetch_fixtures.py` is for fixture maintainers and needs network access. It uses the current preferred USGS phase product for each event, so an upstream revision can change the fixture; review the diff and rerun the tests before committing an update. Use `--output PATH` to regenerate into a separate directory for comparison.

## Data and method

- A **Pg pick** is a catalogued arrival timestamp for a crustal P wave. LD.PAL is the Palisades, New York station in the Lamont-Doherty network. HHZ is the vertical seismometer channel used in the waveform view. Every simulated clock error changes a copy of the data in memory or in the query; nothing stored is modified. [IASPEI seismic phases](https://www.isc.ac.uk/standards/phases/) · [FDSN channel codes](https://docs.fdsn.org/projects/source-identifiers/en/latest/channel-codes.html)
- QuakeTrace estimates an origin time and epicentre from relative arrival timing, assuming 5 km depth and 6 km/s wave speed, and reruns the fit once per omitted station with explicit fit-improvement and ambiguity thresholds. Distances to USGS measure agreement with the catalogue, not ground truth. Station positions in the history are rebuilt from each reading's published distance and azimuth. Model mismatch and pick uncertainty can also cause timing disagreement, which is why small shifts are hard to separate from noise.
- The fixture manifest lists source URLs, retrieval times and content hashes. Picks and origins come from USGS ComCat. Station metadata and waveform samples were accessed through the NSF National Geophysical Facility operated by EarthScope Consortium. The waveform is from the Lamont-Doherty Cooperative Seismographic Network. Map outlines are from Natural Earth. [USGS detail format](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson_detail.php) · [EarthScope citation guidance](https://www.earthscope.org/how-to-cite/) · [LD network metadata](https://www.fdsn.org/networks/detail/LD/) · [Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/)
- Timing discrepancies are an established seismic data quality problem. Existing research and monitoring tools include the Paradox Valley network reports, the global timing study by Yang, Song and Ringler, and EarthScope MUSTANG. [Paradox Valley annual report](https://www.usbr.gov/uc/DocLibrary/Reports/Paradox/20210500-ParadoxValleySeismicNetwork-2020AnnualReport-508-WCAO.pdf) · [USGS timing study](https://pubs.usgs.gov/publication/70226473) · [EarthScope MUSTANG](https://service.earthscope.org/mustang/)

## License

MIT. See [LICENSE](LICENSE).
