# QuakeTrace

QuakeTrace replays seven recorded earthquakes from the Tewksbury, New Jersey sequence and shows how a simulated station clock error can move an estimated epicentre. Its station audit uses the same USGS events to estimate when a persistent timing discrepancy first appeared and which later events support it.

## Run locally

Use Python 3.12. On Windows from PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m streamlit run app.py
```

On macOS or Linux:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m streamlit run app.py
```

Installing dependencies requires internet access. After installation, Replay and Station Audit work offline using the committed fixture, including the waveform and state outlines. World Explorer and the optional street map use live services without an account or API key.

## Explore elsewhere

Open **World explorer**, pick **Worldwide**, a country, a listed city, or your own latitude and longitude, then choose dates and a minimum magnitude. **Search earthquakes** retrieves up to 100 matches from USGS. Country searches cover the surrounding region, including offshore and neighbouring events. Choose an earthquake to see its location and the stations in its published arrival records, then choose a station to zoom to it. **Show worldwide station footprint** shows stations that detected the event from far away.

Station names and registry coordinates come from EarthScope where available. Estimated positions use the distance and bearing published with the USGS arrival and are labelled separately. Some catalog events have no publicly available arrival data. Use **Street map** in Replay to see geographic context for the seven bundled clock-shift scenarios. [USGS earthquake catalog](https://earthquake.usgs.gov/fdsnws/event/1/) · [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)

## Three-minute demo

1. **Replay.** Choose an earthquake, then select a station that recorded it. Set the arrival shift and select **Run replay**. **Mainshock example** applies `LD.PAL +5 s` to the April 5 mainshock. Inspect the suspected station and compare the two estimates. Select **Reveal scenario** to see the injected offset and the USGS comparison. The mainshock includes the LD.PAL waveform and pick markers.
2. **Audit.** Switch to **Station audit** and select **Example**. This applies `LD.PAL +3 s` starting April 27. Inspect the first suspicious event, the May 1 confirmation, and the May 24 supporting reading. The evidence table exposes the individual event deviations.
3. **Reset** either view to return to the recorded inputs.

| Scenario | Result on the committed fixture |
|---|---|
| Clean mainshock | All-station estimate 2.48 km from USGS, with no station flagged |
| `LD.PAL +5 s` | LD.PAL flagged at +4.96 s, with USGS error improving from 9.27 km to 2.79 km after exclusion |
| `LD.PAL −5 s` | LD.PAL flagged at −5.04 s |
| `LD.PAL +3 s` from April 27 | First suspicious on April 27, confirmed May 1, supported May 24, estimated shift +2.88 s |

## Project structure

| Path | Purpose |
|---|---|
| `app.py` | Streamlit controls and presentation |
| `quaketrace/` | Fixture loading, location fit, station audit, maps, and live catalog exploration |
| `scripts/fetch_fixtures.py` | Public source download, parsing, validation, and fixture generation |
| `fixtures/` | Seven event origins, 45 arrival and station-epoch records, waveform, local outlines, and provenance manifest |
| `tests/` | Fixture integrity, parser, solver, audit, and Streamlit interaction coverage |

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
