# QuakeTrace

QuakeTrace finds the seismic station whose clock is wrong. **Present** walks through it on the April 2024 Tewksbury, New Jersey earthquake: break one station's clock and watch the epicentre move, then watch QuakeTrace name the station. **Try any quake** lets judges do the same on any of 539+ real north-east US quakes, including new ones streamed in live. **Scale it up** runs the same idea over eight years of station history in Tiger Data.

Live demo: **https://quaketrace.vercel.app**

## Quick start (about 2 minutes)

You need **Python 3.12** and an internet connection for the first install. No database is required: the app runs fully offline from the bundled data, and Tiger Data is an optional upgrade (next section).

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

That's it. The history card will say **Bundled copy** until you connect Tiger Data.

## Tiger Data setup (about 5 minutes)

Connecting Tiger Data (TimescaleDB) makes **Scale it up** and **Try any quake** run live against eight years of station history in a hypertable. You only do steps 1–3 once per Tiger service; on any other machine, step 2 (the `.env` file) is all you need.

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

`health` runs the same query as the UI and should flag `LD.PAL`. In the browser, the history card now says **Live from Tiger Data** and shows the chunk count, compression ratio and query time.

### 5. Live updates (automatic)

While `server.py` runs with Tiger connected, it checks the live USGS catalog every 10 minutes and streams newly published quakes and their station picks into the hypertable. There are two feeds:

| Feed | Quakes | Roughly |
|---|---|---|
| `northeast` | North-east US, M1.0 and up | 1 a week |
| `world` | Everywhere, M4.5 and up | 10–15 a day |

The continuous aggregate is real-time, so new picks appear in **Every station's clock** on the next query. The history card has a **North-east US / Worldwide** switch and shows when the feed last checked and how many quakes streamed in during the last 24 hours. The first check after seeding catches up the north-east feed since the bundled history ends (December 2025) and the world feed's last 7 days.

Each check also rechecks a window before Tiger's newest quake (30 days north-east, 7 days world), because USGS often publishes phase data after a quake. Quakes are saved in batches of 40, newest first, so a long backfill keeps its progress. Runs are logged in `quaketrace.ingest_runs`.

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
| Change how often the server checks | `.venv/bin/python server.py --ingest-minutes 5` (or `QUAKETRACE_INGEST_MINUTES=5` in `.env`) |
| Turn it off | `.venv/bin/python server.py --ingest-minutes 0` |

If USGS is unreachable, the run is logged and the app keeps serving what Tiger already has.

### 6. Deploy to Vercel

The whole app runs on Vercel as one Python function: `server.py` exposes a WSGI `app` that serves both the page and the API. Vercel functions can't keep a background loop running, so the live ingest moves to the **Live ingest** GitHub Actions workflow (`.github/workflows/live-ingest.yml`), which runs `scripts/tiger_data.py ingest` every 15 minutes. Nothing runs on your computer.

1. **Vercel:** import the GitHub repo as a new project (no framework preset, build command or output directory needed; `vercel.json` and `.python-version` cover it). Under **Settings → Environment Variables**, add `QUAKETRACE_TIGER_DSN` with your Tiger connection string, then deploy.
2. **GitHub:** under **Settings → Secrets and variables → Actions**, add the same `QUAKETRACE_TIGER_DSN` as a repository secret. Open **Actions → Live ingest → Run workflow** once to check it works; after that it runs on its own.
3. **Locally**, run `server.py --ingest-minutes 0` from now on so your machine doesn't ingest too.

What stays private: the connection string lives only in Vercel's and GitHub's secret stores. `.env` is gitignored and excluded from the Vercel upload (`.vercelignore`) and the function bundle (`vercel.json`). The site only serves files from `web/`, API errors never include database details, and visitors can't write to Tiger.

Free-tier notes: Vercel may take a second or two to answer the first request after a quiet spell, so open the site once before judging. If the Tiger trial ends, the site falls back to the bundled north-east history.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Card still says **Bundled copy** | `.env` is missing or not in the repository root, or the server was started before you created it. Restart `server.py`. |
| Connection or SSL error | Make sure the URL ends in `?sslmode=require` (or `PGSSLMODE=require` is set), and that the service shows as running in Tiger Console. |
| Password authentication failed | The service URL may not contain the password. Add `PGPASSWORD=...` to `.env`. |
| Wrong database used | Variables already set in your shell win over `.env`. Run `unset QUAKETRACE_TIGER_DSN TIMESCALE_SERVICE_URL` (or open a new terminal). |
| `ingest` says "no history yet" | Run `seed-history` first; the live feed continues from the newest quake already in Tiger. |
| "Compression is barely saving space" | Run `scripts/tiger_data.py seed-history --rebuild` to recreate only the history objects with current settings. |

If Tiger is unreachable at any point, the app falls back to the bundled copy automatically, so a demo never depends on venue Wi-Fi.

### Maps (free, no key)

The Map, Satellite and Earth 3D views use [MapLibre GL JS](https://maplibre.org/) with free, keyless tiles: OpenStreetMap data from [OpenFreeMap](https://openfreemap.org/), [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) for satellite, and open terrain from AWS for the 3D globe. They need internet. Offline, the app falls back to its built-in map drawn from the bundled outlines.

## What Tiger Data stores

- **Years of station timing history.** Every north-east US earthquake since 2018 with published USGS phase data, and every arrival those solutions used, in the `quaketrace.picks` hypertable. It uses yearly chunks; chunks older than 180 days are compressed (columnstore, ordered by station, phase and time), and the `quaketrace.station_monthly` continuous aggregate keeps each station's monthly mean P-wave residual up to date. **Scale it up** reads the aggregate. When a judge breaks a clock in history, the same view is computed live from the raw hypertable, with the shift applied in SQL.
- **Live quakes as USGS publishes them.** The server's live ingest adds each new north-east US quake (M1.0+) and each worldwide quake (M4.5+) with phase data to `quaketrace.events` (marked with `ingested_at`) and its picks to the same hypertable. Each row carries a `region` (`northeast` or `world`, from the quake's location), and `station_monthly` is grouped by region so the history card can show either view. Tiger holds the only complete, up-to-date record; the bundled CSVs (north-east only) are the seed for a new service and the offline backup.
- **The seven demo quakes.** The 45 bundled arrivals used by Present, in `quaketrace.arrivals`.

Connection settings are read from `QUAKETRACE_TIGER_DSN`, falling back to `TIMESCALE_SERVICE_URL`, plus the standard `PG*` variables. `seed-history --rebuild` drops and recreates only `picks`, `events` and `station_monthly`, and leaves the demo arrivals alone. The history bundle is built from USGS by `scripts/fetch_history.py`, which caches raw responses under `fixtures/raw/history` and backs off when USGS rate-limits. [Hypertables](https://www.tigerdata.com/docs/use-timescale/latest/hypertables/) · [Continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/) · [Compression](https://www.tigerdata.com/docs/use-timescale/latest/compression/)

## Try any quake

After Present, open **Try any quake** and let judges play. It lists every north-east US quake since 2018 with at least 6 P readings within 1.5° (539 from the bundled history, plus every newer one the live feed has streamed into Tiger Data, marked **live**). Pick one, pick a station and a shift (or **Let the app pick secretly**), and QuakeTrace locates the quake three ways:

- **All stations:** equal weights.
- **Standard:** residual weighting, as common locators do.
- **QuakeTrace:** leave-one-out; it names the station to blame and refits without it.

The map shows the USGS epicentre, both fits and the blamed station; **Refit without each station** shows why it was blamed. Results are honest: small shifts or far stations can blend in, and some untouched quakes already have a station whose real reading disagrees. The benchmark headline above the list says how often it works.

The model is a local crustal one (6 km/s, 5 km depth, stations within about 150 km). With Tiger Data connected, the list also includes worldwide quakes recorded by dense local networks (California, Nevada, Alaska, Puerto Rico and others), but only shallow ones (under 15 km) whose untouched readings fit the model within 0.5 s: about 37 quakes, including Ridgecrest M7.1. On those it names a broken clock 65% of the time at ±3 s and 81% at ±5 s, with no false alarms. Quakes heard only by distant stations need a global travel-time model and are out of scope. The locator is the benchmark's (`quaketrace/benchmark.py`): a 2 km grid centred on the first-reporting station, refined to 250 m, with station positions rebuilt from each reading's distance and azimuth. The API is `quaketrace/playground.py` (`/api/quakes`, `/api/try`).

## Benchmark

The benchmark backs the headline on **Try any quake**. It relocates all 539 north-east US quakes from 2018–2025 that have at least 6 stations within 1.5°, after giving one random station a simulated clock error, and measures how far each method lands from the USGS epicentre:

- **Naive fit:** every station, equal weights.
- **Residual-weighted fit:** what standard locators do. Readings that don't fit lose weight; none beyond 1.5 s.
- **QuakeTrace:** leave-one-out. It names the station to blame and refits without it.

| Clock error | Naive | Weighted | QuakeTrace | Broken station named |
|---|---|---|---|---|
| none | 1.86 km | 1.95 km | 1.87 km | 8% false alarms |
| ±1 s | 2.56 km | 2.56 km | 2.58 km | 9% |
| ±2 s | 3.69 km | 2.51 km | 2.40 km | 59% |
| ±3 s | 4.97 km | 2.28 km | 2.16 km | 84% |
| ±5 s | 8.09 km | 2.33 km | 2.08 km | 95% |

(Medians. The full results, including means and the share within 5 km, are in `fixtures/benchmark.json`.)

The honest reading: against the naive fit QuakeTrace wins clearly. Against residual weighting the location is close; QuakeTrace edges it on the median from ±2 s and on the mean at ±5 s (5.6 vs 6.6 km). The real difference is that QuakeTrace names the broken station (84% at ±3 s, 95% at ±5 s), while weighting works around it silently.

It uses the app's own model and flag rules on a grid centred on each quake's first-reporting station, with station positions rebuilt from each reading's distance and azimuth. Results are precomputed into `fixtures/benchmark.json` (about 40 s):

```sh
.venv/bin/python scripts/run_benchmark.py
```

## Three-minute demo

The app opens on **Present**, a step-by-step walkthrough meant to be presented to judges. Press **F** for full screen and use **→ / Space** to advance, **←** to go back and **R** to replay a step's animation. Presentation clickers that send Page Down / Page Up also work.

1. **The judge breaks a clock.** Hand over the laptop: they pick a station and a shift, or select **Let the app pick secretly**.
2. **Walk through the 12 steps.** Each one has a sentence to say and an animation: stations and their arrival times, one candidate point, distance to a station, travel time at 6 km/s, the start time each station implies, the spread of start times as the point's score, scoring all 8,100 grid points, refining on a 250 m grid, the best point against USGS, leaving each station out in turn, and the culprit.
3. **Reveal.** Injected against found shift, and the error against USGS with and without the suspect.
4. **Hand it over: Try any quake.** **Now try it on any real quake** opens the playground. Let a judge pick any quake (try a live one from this week), break a clock, or let the app pick secretly and have them guess before **Reveal**.
5. **Scale it up with Tiger Data.** **Scale it up** (or **Or scale it up** on the reveal, which carries the judge's shift) injects the judge's shift into eight years of real station history and shows Tiger Data catch it, with the hypertable, compression and query time on screen. Point at the live-feed chip: Tiger keeps growing as USGS publishes new quakes, with no redeploy.

The older Solver lab (`#/lab`) and Benchmark (`#/benchmark`) pages still work by URL for judges' questions, but are no longer in the menu.

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
| `web/` | The QuakeTrace UI: Present walkthrough, Try any quake, and Scale it up (the Tiger Data history) |
| `quaketrace/api.py` | JSON payloads for the UI: fits, best-fit zones, solver grid traces, leave-one-out surfaces, audit grid |
| `quaketrace/` | Fixture loading, location fit, station audit, multi-year history, and Tiger Data storage |
| `scripts/fetch_history.py` | Downloads the multi-year USGS arrival history into `fixtures/history` |
| `scripts/tiger_data.py` | Seeds Tiger Data with the demo arrivals and the history, and queries station health |
| `quaketrace/benchmark.py` | Local locator and benchmark: relocates every eligible north-east quake with three methods |
| `quaketrace/playground.py` | Try any quake: quake list (bundled plus live from Tiger) and one-quake relocation |
| `quaketrace/live.py` | Live USGS ingest into Tiger Data (north-east and worldwide feeds) |
| `scripts/run_benchmark.py` | Precomputes `fixtures/benchmark.json` for the Benchmark tab |
| `scripts/fetch_fixtures.py` | Public source download, parsing, validation, and fixture generation |
| `fixtures/` | Seven event origins, 45 arrival and station-epoch records, waveform, local outlines, and provenance manifest. `fixtures/history` holds the multi-year history bundle |
| `tests/` | Fixture integrity, parsers, solver, audit, history, Tiger Data, API and server |

Run these from the repository root with the project environment active:

```sh
python -m unittest discover -s tests -v
python scripts/fetch_fixtures.py
```

The second command is for fixture maintainers and requires network access. It uses the current preferred USGS phase product for each event, so an upstream revision can change the fixture. Review the diff and rerun the tests before committing an update. Use `--output PATH` to regenerate into a separate directory for comparison.

## Data and method

- A **Pg pick** is a catalogued arrival timestamp for a crustal P wave. LD.PAL is the Palisades, New York station in the Lamont-Doherty network. HHZ is the vertical seismometer channel used in the waveform view. The simulation changes a copy of one pick or a station’s residual series in memory. [IASPEI seismic phases](https://www.isc.ac.uk/standards/phases/) · [FDSN channel codes](https://docs.fdsn.org/projects/source-identifiers/en/latest/channel-codes.html)
- QuakeTrace estimates an origin time and epicentre from relative arrival timing, assuming 5 km depth and 6 km/s wave speed. It reruns the fit once per omitted station and uses explicit fit improvement and ambiguity thresholds. Distances to USGS measure agreement with the catalog. Audit uses signed changes from a station baseline after removing each event’s median residual. Two consecutive same-direction deviations of 1.5 s or more confirm a pattern. The first suspicious timestamp is constrained by the events available for observation. Model mismatch and pick uncertainty can also cause timing disagreement.
- The fixture manifest lists the source URLs, retrieval times, and content hashes. Picks and origins come from USGS ComCat. Station metadata and waveform samples were accessed through the NSF National Geophysical Facility operated by EarthScope Consortium. The waveform is from the Lamont-Doherty Cooperative Seismographic Network. Map outlines are from Natural Earth. [USGS detail format](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson_detail.php) · [EarthScope citation guidance](https://www.earthscope.org/how-to-cite/) · [LD network metadata](https://www.fdsn.org/networks/detail/LD/) · [Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/)
- Timing discrepancies are an established seismic data quality problem. Existing research and monitoring tools include the Paradox Valley network reports, the global timing study by Yang, Song, and Ringler, and EarthScope MUSTANG. [Paradox Valley annual report](https://www.usbr.gov/uc/DocLibrary/Reports/Paradox/20210500-ParadoxValleySeismicNetwork-2020AnnualReport-508-WCAO.pdf) · [USGS timing study](https://pubs.usgs.gov/publication/70226473) · [EarthScope MUSTANG](https://service.earthscope.org/mustang/)
