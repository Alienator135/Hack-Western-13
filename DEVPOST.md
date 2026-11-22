# QuakeTrace: Devpost submission draft

**Tagline:** Every earthquake location is worked out from clocks nobody checks. QuakeTrace finds the one that's lying.

## Inspiration

Nobody can see where an earthquake starts. Seismologists locate it from the times its first wave reaches stations around it. If one station's clock drifts by a few seconds, the computed epicentre moves by kilometres and nobody is told why. Timing faults are a documented problem in real seismic networks, but standard locators mostly down-weight the bad reading without saying which station was wrong. We wanted a tool that names the broken clock and shows its reasoning.

## What it does

- **Present:** a judge breaks one station's clock (or lets the app do it secretly). A 12-step walkthrough rebuilds the location from real USGS arrivals on the April 2024 M4.8 Tewksbury, New Jersey quake: a grid search over 8,100 candidate epicentres, a 250 m refinement, then leave-one-out refits that expose the lying station. With LD.PAL shifted +5 s, QuakeTrace finds +4.96 s and the error against USGS drops from 9.3 km to 2.8 km.
- **Try any quake:** then the judge takes over. Pick any of about 610 real quakes: every north-east US quake since 2018 with 6+ stations within 150 km, including ones USGS published this week that streamed in live through Tiger Data, plus 37 worldwide quakes recorded by dense local networks, such as Ridgecrest M7.1. Break any station's clock, or let the app break one secretly and guess before the reveal. QuakeTrace compares itself with an all-station fit and a standard outlier-weighted locator, and names the station it blames.
- **Scale it up (Tiger Data):** the same idea over eight years. USGS station timing history lives in a TimescaleDB hypertable with a continuous aggregate. Inject a shift into any station's history and Tiger Data finds the month it started, with the shift applied in SQL. New quakes (north-east US M1.0+, worldwide M4.5+) stream in every 15 minutes: about 1.26 million P-wave picks so far.

## Results

- Benchmarked on all 539 north-east US quakes since 2018: QuakeTrace names a broken clock 84% of the time at ±3 s and 95% at ±5 s, with 8% false alarms on untouched quakes. Median location error at ±3 s is 2.2 km, against 5.0 km using every station.
- On the 37 worldwide quakes: 65% at ±3 s and 81% at ±5 s, with no false alarms.
- We show where it fails: shifts under 2 s hide in normal pick scatter, and quakes heard only by distant stations need a global travel-time model.

## How we built it

- **Python** (standard-library HTTP server and WSGI app, NumPy) for the locator, the leave-one-out diagnosis, the history audit and the JSON API. Leave-one-out refits share work through running sums, so a 300-station quake is diagnosed in about a second.
- **Tiger Data / TimescaleDB:** a `picks` hypertable with yearly chunks, columnstore compression on chunks older than 180 days, and a real-time `station_monthly` continuous aggregate grouped by region. When a judge shifts a clock in history, the shift is applied in SQL against the raw hypertable.
- **USGS ComCat** QuakeML phase data, plus EarthScope station metadata and waveforms.
- **Vanilla JavaScript + MapLibre GL** with free OpenFreeMap, Esri imagery and terrain tiles, and canvas animations for the walkthrough.
- **GitHub Actions** for tests and a scheduled live ingest every 15 minutes; **Vercel** for hosting.

## Challenges we ran into

- USGS rate limits and late-published phase data: the ingest rechecks a lookback window, saves in batches and backs off on 429s.
- Regional networks report few picks per station, so compressing by station segment saved nothing. Ordering by station, phase and time inside batches fixed it.
- Worldwide quakes: our local model only works when stations are close. We tested all 119 worldwide quakes with nearby stations and kept only the 37 the model fits well, instead of showing results we couldn't stand behind.
- Keeping the demo independent of venue Wi-Fi: every view falls back to bundled data when Tiger Data or map tiles are unreachable.

## Accomplishments that we're proud of

- The demo uses real arrivals and the solver's real numbers, not illustrations.
- An honest benchmark against standard methods, including the cases where QuakeTrace does worse.
- A judge can break any clock on any of 600+ real quakes and watch it get caught, live.

## What we learned

How hypertables, compression and continuous aggregates fit together for time-series science data, how much a single bad clock distorts a location, and where a simple physical model stops being trustworthy.

## What's next

- A global travel-time model, built from the 1.26 million picks already in Tiger Data, so every worldwide quake can be checked.
- S waves, depth and a layered velocity model.
- Run the audit continuously on the live feed and alert station operators.
- Compare with EarthScope MUSTANG timing-quality metrics.

## Built with

python, numpy, javascript, timescaledb, tiger-data, postgresql, psycopg, maplibre, usgs, github-actions, vercel

## Links

- GitHub: https://github.com/Alienator135/Hack-Western-13
- Live demo: https://quaketrace.vercel.app
