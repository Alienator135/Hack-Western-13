# QuakeTrace: Devpost submission draft

**Tagline:** Break one seismic station's clock, and QuakeTrace finds which one did it, across one quake or eight years of history.

## Inspiration

Earthquake locations come from arrival times at many stations. If one station's clock drifts by a few seconds, the computed epicentre moves by kilometres and nobody is told why. Timing faults are a known seismic data quality problem, but standard locators mostly down-weight the bad reading without saying which station was wrong. We wanted a tool that names the broken clock and shows its reasoning.

## What it does

- **Present:** a judge picks a station and a clock shift (or lets the app pick secretly). A 12-step walkthrough rebuilds the location from real USGS arrivals on the April 2024 M4.8 Tewksbury, New Jersey quake: grid search over 8,100 candidate epicentres, a 250 m refinement, then leave-one-out refits that expose the lying station. With LD.PAL shifted +5 s, QuakeTrace finds +4.96 s and the error against USGS drops from 9.3 km to 2.8 km.
- **Try any quake:** then the judge takes over. Pick any of 570+ real north-east US quakes since 2018, including ones USGS published this week that streamed in live through Tiger Data. Break any station's clock, or let the app break one secretly and guess before the reveal. QuakeTrace locates the quake three ways (every station, a standard outlier-weighted locator, and QuakeTrace) and names the station it blames. Tested on all 539 bundled quakes: it names the broken station 84% of the time at ±3 s and 95% at ±5 s.
- **Scale it up (Tiger Data):** the same idea over eight years. USGS station timing history lives in a TimescaleDB hypertable. Inject a shift into history and Tiger flags the month it started. New quakes (north-east US M1.0+, worldwide M4.5+) stream in as USGS publishes them, over 1.2 million P-wave picks so far.

## How we built it

- **Python** (standard-library HTTP server and WSGI app, NumPy) for the locator, the audit and the JSON API.
- **Tiger Data / TimescaleDB:** a `picks` hypertable with yearly chunks, columnstore compression on chunks older than 180 days, and a real-time `station_monthly` continuous aggregate. When a judge shifts a clock, the shift is applied in SQL against the raw hypertable.
- **USGS ComCat** QuakeML phase data, plus EarthScope station metadata and waveforms.
- **Vanilla JavaScript + MapLibre GL** with free OpenFreeMap, Esri imagery and terrain tiles, and canvas animations for the walkthrough and lab.
- **GitHub Actions** for tests and a scheduled live ingest; **Vercel** for hosting.

## Challenges we ran into

- USGS rate limits and late-published phase data: the ingest re-checks a lookback window, saves in batches and backs off on 429s.
- Regional networks report few picks per station, so compressing by station segment saved nothing. Ordering by station, phase and time inside batches fixed it.
- Keeping the demo independent of venue Wi-Fi: every view falls back to bundled data when Tiger Data or map tiles are unreachable.

## Accomplishments that we're proud of

- The demo uses real arrivals and the solver's real numbers, not illustrations.
- An honest benchmark against standard methods, including the cases where QuakeTrace does worse.
- A judge can break any clock and watch it get caught, live, in front of them.

## What we learned

How hypertables, compression and continuous aggregates fit together for time-series science data, and how much a single bad clock distorts a location.

## What's next

- Use more phases (S waves) and a layered velocity model.
- Run the audit continuously on the live feed and alert station operators.
- Compare with EarthScope MUSTANG timing-quality metrics.

## Built with

python, numpy, javascript, timescaledb, tiger-data, postgresql, psycopg, maplibre, usgs, github-actions, vercel

## Links

- GitHub: https://github.com/Alienator135/Hack-Western-13
- Live demo: https://quaketrace.vercel.app
