import { createMapView } from "./map.js";
import { timelineChart, travelTimeChart, waveformChart } from "./charts.js";

// ---------------------------------------------------------------- helpers

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sign = (value, digits = 1) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
const short = (id) => (id || "").split(".").pop();
const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

const ARROW = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7 H11 M7.5 3.5 L11 7 L7.5 10.5" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LOCK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="#FFFFFF" stroke-width="1.6"/><path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7" fill="none" stroke="#FFFFFF" stroke-width="1.6"/></svg>';
const CHECK = '<svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------- state

const STEPS = [["quake", "Real quake"], ["tamper", "Tamper"], ["damage", "Damage"], ["investigate", "Investigate"], ["reveal", "Reveal"]];

const state = {
  overview: null,
  config: { googleMapsKey: "", googleMapId: "DEMO_MAP_ID" },
  wave: null,
  basemap: store.get("qt.basemap", "map"),
  dim: 30,
  replay: { step: "tamper", maxStep: 1, event: null, station: null, offset: 5, secret: false, clean: null, result: null, run: null },
  audit: { station: null, onset: null, offset: 3, result: null, inspected: null, ran: false },
  decisions: store.get("qt.decisions", []),
  maps: [],
};

function setStatus(kind, text) {
  const node = $("#status");
  node.innerHTML = `<span class="dot ${kind}"></span><span>${esc(text)}</span>`;
}

async function getJSON(path) {
  setStatus("busy", "Working");
  try {
    const response = await fetch(path);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || response.statusText);
    setStatus("", state.overview?.arrivalSource === "tiger" ? "Ready · Tiger Data" : "Ready");
    return body;
  } catch (error) {
    setStatus("error", "Offline");
    throw error;
  }
}

function eventById(id) { return state.overview.events.find((e) => e.id === id); }
function eventDate(id, withYear = false) {
  const e = eventById(id);
  if (!e) return "—";
  const d = new Date(e.time);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(withYear ? { year: "numeric" } : {}) });
}

function clearMaps() { state.maps.forEach((m) => m.destroy()); state.maps = []; }

function mountMap(selector, scene, { small = false } = {}) {
  const container = $(selector);
  if (!container) return null;
  const view = createMapView(container, {
    overview: state.overview, config: state.config, basemap: state.basemap, dim: state.dim, small,
    onBasemap(kind) { state.basemap = kind; store.set("qt.basemap", kind); const opts = $("#basemap-opts"); if (opts) opts.hidden = kind !== "satellite"; },
  });
  view.setScene(scene);
  state.maps.push(view);
  return view;
}

function render(html) {
  clearMaps();
  $("#view").innerHTML = html;
  document.querySelectorAll(".nav a").forEach((a) => a.setAttribute("aria-current", a.dataset.view === currentView() ? "page" : "false"));
}

function errorView(error) {
  render(`<div class="error-box"><strong>QuakeTrace could not load data.</strong> ${esc(error.message)}<br>Start the server from the repository root with <code>python server.py</code>, then reload.</div>`);
}

function currentView() { return location.hash.startsWith("#/audit") ? "audit" : "replay"; }

// ---------------------------------------------------------------- shared UI pieces

function stepper(active) {
  const index = STEPS.findIndex(([key]) => key === active);
  const items = STEPS.map(([key, label], i) => {
    const done = i < index || (key === "quake" && index >= 1);
    const current = key === active || (active === "quake" && key === "tamper");
    const reachable = i <= state.replay.maxStep && i !== 0;
    const inner = done
      ? `<span class="num">${CHECK}</span>${label}`
      : `<span class="num">${i + 1}</span>${label}`;
    const cls = done ? "done" : current ? "current" : "";
    const content = reachable && key !== active ? `<button type="button" data-step="${key}">${inner}</button>` : inner;
    return `${i ? '<li class="sep" aria-hidden="true"></li>' : ""}<li class="${cls}" ${current ? 'aria-current="step"' : ""}>${content}</li>`;
  });
  return `<ol class="steps" aria-label="Demo steps">${items.join("")}</ol>`;
}

function headline(title, subtitle, icon = "") {
  return `<div class="headline">${icon}<div><h1>${esc(title)}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div></div>`;
}

function divergingBars(rows, { digits = 1, hot = null } = {}) {
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.value)));
  const body = rows.map((r) => {
    const width = (Math.abs(r.value) / max) * 50;
    const isHot = hot && r.key === hot;
    return `<div class="bar-row ${isHot ? "hot" : ""}"><span>${esc(r.label)}</span><div class="track"><div class="mid"></div><div class="fill ${r.value >= 0 ? "pos" : "neg"} ${isHot ? "hot" : ""}" style="width:${width.toFixed(1)}%"></div></div><span>${sign(r.value, digits)}</span></div>`;
  }).join("");
  return `${body}<div class="bar-axis"><span>early</span><span>late</span></div>`;
}

function plainBars(rows, { unit = "", wide = false, digits = 2 } = {}) {
  const max = Math.max(...rows.map((r) => r.value), 1e-6);
  return rows.map((r) => `<div class="bar-row ${wide ? "wide" : ""} ${r.hot ? "hot" : ""}"><span>${esc(r.label)}</span><div class="track"><div class="fill from0 ${r.tone || ""}" style="width:${((r.value / max) * 100).toFixed(1)}%"></div></div><span>${r.value.toFixed(digits)}${unit}</span></div>`).join("");
}

function details(sections) {
  return `<div class="details"><h2>DETAILS</h2>${sections.filter(Boolean).map((s) => `<details class="card" ${s.open ? "open" : ""} ${s.id ? `id="${s.id}"` : ""}><summary>${esc(s.title)}</summary>${s.body}</details>`).join("")}</div>`;
}

function download(name, href) {
  const a = document.createElement("a");
  a.href = href; a.download = name;
  document.body.append(a); a.click(); a.remove();
}

// ---------------------------------------------------------------- replay

function replayStations(result) {
  return result.stations.map((s) => ({ id: s.id, short: s.short, name: s.name, lat: s.lat, lon: s.lon, tone: "normal" }));
}

async function loadReplay() {
  const r = state.replay;
  const query = new URLSearchParams({ event: r.event, station: r.station || "", offset: String(r.offset) });
  r.result = await getJSON(`/api/replay?${query}`);
}

async function loadClean() {
  const r = state.replay;
  if (r.clean?.event.id === r.event) return;
  r.clean = await getJSON(`/api/replay?event=${encodeURIComponent(r.event)}&offset=0`);
}

async function goStep(step) {
  const r = state.replay;
  r.step = step;
  r.maxStep = Math.max(r.maxStep, STEPS.findIndex(([key]) => key === step));
  try {
    await loadClean();
    if (step === "tamper") renderTamper(); else renderStep(step);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) { errorView(error); }
}

function renderStep(step) {
  if (!state.replay.result) return renderTamper();
  if (step === "damage") renderDamage();
  else if (step === "investigate") renderInvestigate();
  else if (step === "reveal") renderReveal();
}

function renderTamper() {
  const r = state.replay;
  const clean = r.clean;
  const ev = eventById(r.event);
  const n = ev.stations.length;
  const date = eventDate(r.event, true);
  const what = ev.isMainshock ? `${date} M${ev.magnitude} earthquake in Tewksbury, NJ` : `${date} aftershock near Tewksbury, NJ`;
  const stationsSorted = [...clean.stations];
  if (!r.station || !ev.stations.includes(r.station)) r.station = ev.stations.includes(state.overview.waveformStation) ? state.overview.waveformStation : ev.stations[0];
  const waveHtml = ev.isMainshock && state.wave
    ? `<div style="flex:2 1 420px;min-width:0"><div class="mono c-muted" style="font-size:12px;margin-bottom:4px">${esc(state.wave.station)} · ${esc(state.wave.channel)}</div>${waveformChart(state.wave)}</div>`
    : '<div style="flex:2 1 420px;min-width:0" class="c-muted"><p style="font-size:13px">The bundled waveform covers LD.PAL during the mainshock.</p></div>';
  render(`
    ${stepper("tamper")}
    ${headline(`${n === 9 ? "Nine" : n === 6 ? "Six" : n} stations. One will lie.`, `Real USGS arrival times from the ${esc(what)}.`)}
    <div class="row">
      <section class="main-col card map-card"><div id="map-main"></div></section>
      <section class="side-col"><div class="card pad panel">
        <h2>Judge: break one clock</h2>
        <div class="field">
          <label for="ev">Earthquake</label>
          <select id="ev" class="select small">${state.overview.events.map((e) => `<option value="${e.id}" ${e.id === r.event ? "selected" : ""}>${esc(e.label)}${e.isMainshock ? " · mainshock" : ""}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label for="st">Station</label>
          <select id="st" class="select mono" ${r.secret ? "disabled" : ""}>${r.secret ? "<option>• • •</option>" : stationsSorted.map((s) => `<option value="${s.id}" ${s.id === r.station ? "selected" : ""}>${esc(s.id)}</option>`).join("")}</select>
        </div>
        <div class="field" style="gap:8px">
          <div class="range-head"><label for="sh">Clock shift</label><span class="shift-value" id="sh-value">${r.secret ? "• • •" : `${sign(r.offset)} s`}</span></div>
          <input id="sh" type="range" min="-10" max="10" step="0.5" value="${r.offset}" ${r.secret ? "disabled" : ""} aria-describedby="sh-value">
        </div>
        <button class="btn-primary" type="button" data-action="lock">${LOCK}Lock it in</button>
        <button class="btn-link" type="button" data-action="secret">Let the app pick secretly</button>
      </div></section>
    </div>
    ${details([
      { title: "Event facts and waveform", body: `<div class="det-body flex-wrap">
        <div class="facts">
          <div><div class="k">Event</div><div class="v"><a href="https://earthquake.usgs.gov/earthquakes/eventpage/${ev.id}" target="_blank" rel="noopener">${esc(ev.id)}</a></div></div>
          <div><div class="k">Origin time</div><div class="v">${new Date(ev.time).toISOString().slice(11, 19)} UTC</div></div>
          <div><div class="k">Magnitude</div><div class="v">${ev.magnitude ? `M${ev.magnitude}` : "—"}</div></div>
          <div><div class="k">Model</div><div class="v">${state.overview.model.speedKmS.toFixed(1)} km/s · ${state.overview.model.depthKm} km depth</div></div>
          <div><div class="k">Fit to USGS</div><div class="v">${clean.usgsKm.clean.toFixed(1)} km</div></div>
          <div><div class="k">Arrivals</div><div class="v">${state.overview.arrivalSource === "tiger" ? "Tiger Data" : "Bundled"}</div></div>
        </div>${waveHtml}</div>` },
      { title: `Arrivals used · ${n} stations`, body: `<div class="det-body scroll-x"><table class="table">
        <thead><tr><th>Station</th><th>Site</th><th>Phase</th><th class="r">Distance</th><th class="r">Arrival after origin</th></tr></thead>
        <tbody>${stationsSorted.map((s) => `<tr><td>${esc(s.id)}</td><td style="font-family:var(--sans)">${esc(s.name)}</td><td>Pg</td><td class="r">${s.distanceKm.toFixed(1)} km</td><td class="r">${s.arrivalS.toFixed(1)} s</td></tr>`).join("")}</tbody>
        </table><p class="note">Distance from the USGS epicentre · USGS Pg picks</p></div>` },
    ])}
  `);
  mountMap("#map-main", {
    stations: replayStations(clean),
    marks: [{ lat: clean.clean.lat, lon: clean.clean.lon, kind: "ring", label: "Estimated epicentre" }],
    zone: clean.clean.zone,
    aria: `Map of ${n} seismic stations around the estimated epicentre in central New Jersey`,
  });
}

function renderDamage() {
  const res = state.replay.result;
  const moved = res.movedKm;
  const changed = res.scenario.offsetS !== 0;
  const title = !changed ? "No clock was changed." : moved < 0.5 ? "The quake barely moved." : "One clock moved the quake.";
  const sub = !changed ? "Every station kept its real arrival time." : moved < 0.5 ? "This change shifted the estimate by less than a kilometre." : "The judge's change dragged the estimated epicentre off course.";
  const residuals = Object.entries(res.tampered.residualsS).map(([key, value]) => ({ key, label: short(key), value })).sort((a, b) => b.value - a.value);
  render(`
    ${stepper("damage")}
    ${headline(title, sub)}
    <div class="row">
      <section class="main-col card map-card"><div id="map-main"></div></section>
      <section class="side-col">
        <div class="card pad">
          <div class="stat-label">Epicentre moved</div>
          <div class="stat-big">${moved.toFixed(1)} km</div>
          <div class="legend-teal"><span></span>Teal = where the quake best fits</div>
        </div>
        <button class="btn-primary" type="button" data-step="investigate">Find the bad clock${ARROW}</button>
      </section>
    </div>
    ${details([
      { title: "How much each station disagrees", body: `<div class="det-body bars">${divergingBars(residuals)}<p class="note" style="font-family:var(--sans)">Residual in seconds at the new best-fit point</p></div>` },
      { title: "Fit statistics", body: `<div class="det-body grid3">
        <div><div class="c-muted">RMS misfit</div><div class="v">${res.clean.rmsS.toFixed(2)} → ${res.tampered.rmsS.toFixed(2)} s</div></div>
        <div><div class="c-muted">Best-fit zone</div><div class="v">${res.zoneRatio ? `${res.zoneRatio.toFixed(1)}× ${res.zoneRatio >= 1 ? "longer" : "shorter"}` : "—"}</div></div>
        <div><div class="c-muted">Grid</div><div class="v">${res.gridKm} km cells</div></div>
        <p class="note" style="grid-column:span 3;margin:0">Zone = cells within ${res.tampered.zone.marginS} s RMS of the best fit · length ${res.clean.zone.lengthKm} → ${res.tampered.zone.lengthKm} km</p></div>` },
      { title: "Basemap options", id: "basemap-opts-wrap", body: `<div class="det-body kv" style="grid-template-columns:auto 1fr">
        <span><strong>Map</strong> · Google Maps roadmap</span><span>Needs a Google Maps key and internet</span>
        <span><strong>Satellite</strong> · Google satellite imagery</span><span>Needs a Google Maps key and internet</span>
        <span><strong>Earth 3D</strong> · Google photorealistic 3D tiles</span><span>Also needs the Map Tiles API</span>
        <span><strong>Fallback</strong> · bundled state outlines</span><span>Used offline or if Google fails</span>
        <label for="dim" id="basemap-opts" ${state.basemap === "satellite" ? "" : "hidden"} style="display:contents"><span>Dim imagery</span><input id="dim" type="range" min="0" max="80" value="${state.dim}"></label>
        </div>` },
    ])}
  `);
  mountMap("#map-main", {
    stations: replayStations(res),
    marks: [
      { lat: res.clean.lat, lon: res.clean.lon, kind: "ring-gray", label: "before", labelUp: true },
      { lat: res.tampered.lat, lon: res.tampered.lon, kind: "ring", label: "now", labelLeft: true },
    ],
    links: moved >= 0.5 ? [{ a: { lat: res.clean.lat, lon: res.clean.lon }, b: { lat: res.tampered.lat, lon: res.tampered.lon }, color: "#1F6FEB", arrow: true, width: 2 }] : [],
    zone: res.tampered.zone,
    // Zoom to the fit so a few-kilometre move is visible; stations off-screen stay in the data.
    fitTo: [...res.tampered.zone.hull, [res.clean.lat, res.clean.lon], [res.tampered.lat, res.tampered.lon]],
    minSpanKm: 100,
    aria: "Map showing the best-fit zone and the estimated epicentre after one station's clock was changed",
  });
}

function renderInvestigate() {
  const r = state.replay;
  const res = r.result;
  const c = res.candidate;
  const n = res.stations.length;
  let title, sub;
  if (c) {
    const secs = Math.abs(c.offsetS);
    const rounded = secs >= 1.5 ? Math.round(secs) : secs.toFixed(1);
    title = `${short(c.station)}'s reading arrives ${rounded} second${rounded === 1 ? "" : "s"} ${c.offsetS >= 0 ? "late" : "early"}.`;
    sub = `Suspect: ${esc(c.station)} · estimated clock error ${sign(c.offsetS, 2)} s`;
  } else {
    title = "No single clock stands out.";
    sub = res.status === "insufficient" ? "At least five stations are needed to test each one." : "Leaving out any one station does not clear up the fit.";
  }
  const runs = [...res.runs];
  const runStation = r.run;
  const selected = runStation ? runs.find((run) => run.station === runStation) : null;
  const focusStation = selected ? selected.station : c?.station;
  const travelPoints = res.travel.points.map((p) => ({ ...p, short: short(p.station) }));
  const runsByDistance = [...res.stations].map((s) => s.id);
  const text = selected
    ? `Without ${esc(short(selected.station))}, the remaining stations misfit by ${selected.rmsS.toFixed(2)} s${c && selected.station === c.station ? " — the tightest fit." : "."}`
    : c ? `Without ${esc(short(c.station))}, the other ${n - 1} agree on one spot.` : "Every leave-one-out fit still disagrees.";
  render(`
    ${stepper("investigate")}
    ${headline(title, sub)}
    <div class="row">
      <section class="main-col card" style="padding:20px 24px">
        ${travelTimeChart(travelPoints, { suspect: c?.station, speed: state.overview.model.speedKmS })}
        <p class="note">Distance from the ${c ? `refit epicentre without ${esc(short(c.station))}` : "all-station estimate"} · ${state.overview.model.depthKm} km depth</p>
      </section>
      <section class="side-col">
        <div class="card" style="padding:12px">
          <div id="map-small"></div>
          <p style="margin:8px 4px 4px;font-size:13px;color:var(--ink-2)">${text}</p>
        </div>
        <button class="btn-primary" type="button" data-step="reveal">Reveal the answer${ARROW}</button>
      </section>
    </div>
    ${details([
      { title: "Fit without each station", body: `<div class="det-body bars">${plainBars(runs.map((run) => ({ label: short(run.station), value: run.rmsS, hot: c && run.station === c.station, tone: c && run.station === c.station ? "good" : "" })), { unit: " s" })}
        <p class="note" style="font-family:var(--sans)">RMS misfit of the remaining stations · all ${n} together ${res.tampered.rmsS.toFixed(2)} s</p></div>` },
      { title: `Step through the ${n} runs`, open: Boolean(runStation), body: `<div class="chips" role="group" aria-label="Leave-one-out runs">${runsByDistance.map((id) => `<button type="button" class="chip ${c && id === c.station ? "hot" : ""}" data-run="${id}" aria-pressed="${id === runStation}">${esc(short(id))}</button>`).join("")}</div>` },
    ])}
  `);
  const stations = replayStations(res).map((s) => ({ ...s, tone: s.id === focusStation ? "out" : "normal" }));
  const focus = stations.find((s) => s.id === focusStation);
  const estimate = selected || (c ? { lat: c.fit.lat, lon: c.fit.lon } : { lat: res.tampered.lat, lon: res.tampered.lon });
  mountMap("#map-small", {
    stations,
    outCircle: focus ? { lat: focus.lat, lon: focus.lon, label: `${focus.short} out` } : null,
    marks: [{ lat: estimate.lat, lon: estimate.lon, kind: "ring", size: 13 }],
    zone: selected ? null : c ? c.fit.zone : res.tampered.zone,
    showCities: false,
    aria: "Map with the suspect station left out and the refit estimate",
  }, { small: true });
}

function renderReveal() {
  const r = state.replay;
  const res = r.result;
  const c = res.candidate;
  const s = res.scenario.station;
  const o = res.scenario.offsetS;
  let title, ok;
  if (o && c && c.station === s) { title = `Caught it. The judge changed ${short(s)}.`; ok = true; }
  else if (!o && !c) { title = "Correct. No clock was changed."; ok = true; }
  else if (!o && c) { title = `False alarm. No clock was changed.`; ok = false; }
  else if (c) { title = `Wrong station. The judge changed ${short(s)}.`; ok = false; }
  else { title = `Missed it. The judge changed ${short(s)}.`; ok = false; }
  const sub = o && !c ? `A ${sign(o, 1)} s shift was too small to single out. Scored against the official USGS epicentre.` : "Scored against the official USGS epicentre.";
  const icon = ok
    ? '<svg width="44" height="44" viewBox="0 0 28 28" aria-hidden="true" style="flex:none"><circle cx="14" cy="14" r="13" fill="#E9F7EE"/><path d="M8 14.5 L12 18.5 L20 9.5" fill="none" stroke="#1A7F37" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="44" height="44" viewBox="0 0 28 28" aria-hidden="true" style="flex:none"><circle cx="14" cy="14" r="13" fill="#FFF6EE"/><path d="M14 7.5 V15.5 M14 19.5 V20" fill="none" stroke="#C2410C" stroke-width="2.6" stroke-linecap="round"/></svg>';
  const usgs = res.usgsKm;
  const ev = res.event;
  const auditable = s && state.overview.auditStations.includes(s);
  const distanceRows = [
    { label: "All stations", value: usgs.all, tone: "hot" },
    ...(c ? [{ label: `${short(c.station)} excluded`, value: usgs.excluded, tone: "good" }] : []),
    { label: "Clean data", value: usgs.clean },
  ];
  render(`
    ${stepper("reveal")}
    ${headline(title, sub, icon)}
    <div class="row">
      <section class="main-col card map-card"><div id="map-main"></div></section>
      <section class="side-col">
        <div class="card pad" style="display:flex;flex-direction:column;gap:20px">
          <div class="grid2">
            <div><div class="label">Injected</div><div class="stat-mid c-orange">${o ? `${sign(o, 2)} s` : "none"}</div>${s ? `<div class="mono c-muted" style="font-size:13px;margin-top:2px">${esc(s)}</div>` : ""}</div>
            <div><div class="label">Found</div><div class="stat-mid">${c ? `${sign(c.offsetS, 2)} s` : "—"}</div>${c ? `<div class="mono c-muted" style="font-size:13px;margin-top:2px">${esc(c.station)}</div>` : ""}</div>
          </div>
          <div class="divider"><div class="label">Error vs USGS</div><div class="stat-mid"><span class="c-orange">${usgs.all.toFixed(1)}</span>${c ? ` → <span class="c-blue">${usgs.excluded.toFixed(1)} km</span>` : " km"}</div></div>
        </div>
        ${auditable
          ? `<button class="btn-primary" type="button" data-action="to-audit">Check ${esc(short(s))} across 7 quakes${ARROW}</button>`
          : `<a class="btn-primary" href="#/audit">Open the station audit${ARROW}</a>`}
        <button class="btn-link" type="button" data-action="again">Try another clock</button>
      </section>
    </div>
    ${details([
      { title: "Distance breakdown", body: `<div class="det-body bars">${plainBars(distanceRows, { unit: " km", wide: true, digits: 1 })}</div>` },
      { title: "Export this result", body: `<div class="chips"><button class="btn-plain" type="button" data-action="png">Download PNG</button><button class="btn-plain" type="button" data-action="csv">Download CSV</button></div>` },
    ])}
  `);
  const stations = replayStations(res).map((st) => ({ ...st, tone: st.id === s ? "suspect" : "normal" }));
  const allMark = { lat: res.tampered.lat, lon: res.tampered.lon };
  const marks = [{ ...allMark, kind: "ring-dashed" }];
  const links = [{ a: allMark, b: { lat: ev.lat, lon: ev.lon }, color: "#E8590C", dashed: true, label: `${usgs.all.toFixed(1)} km`, labelColor: "#B03F00" }];
  if (c) {
    marks.push({ lat: c.fit.lat, lon: c.fit.lon, kind: "ring" });
    links.push({ a: { lat: c.fit.lat, lon: c.fit.lon }, b: { lat: ev.lat, lon: ev.lon }, color: "#1F6FEB", label: `${usgs.excluded.toFixed(1)} km`, labelColor: "#0B57D0", width: 2, labelSide: -1 });
  }
  marks.push({ lat: ev.lat, lon: ev.lon, kind: "star", label: "USGS" });
  state.revealMap = mountMap("#map-main", {
    stations, marks, links,
    fitTo: marks.map((m) => [m.lat, m.lon]),
    minSpanKm: 35,
    legend: ["dashed = all stations", c ? `solid = ${short(c.station)} excluded · star = USGS` : "star = USGS"],
    aria: "Map comparing both estimates to the official USGS epicentre",
  });
}

function exportCSV() {
  const res = state.replay.result;
  const loo = Object.fromEntries(res.runs.map((run) => [run.station, run]));
  const lines = [["station", "site", "latitude", "longitude", "distance_km", "arrival_s", "tampered_arrival_s", "residual_s", "rms_without_s", "offset_without_s"].join(",")];
  for (const s of res.stations) {
    lines.push([s.id, `"${s.name.replace(/"/g, '""')}"`, s.lat, s.lon, s.distanceKm, s.arrivalS, s.tamperedArrivalS, res.tampered.residualsS[s.id], loo[s.id]?.rmsS ?? "", loo[s.id]?.offsetS ?? ""].join(","));
  }
  lines.push("");
  lines.push(`# event,${res.event.id}`);
  lines.push(`# injected,${res.scenario.station || "none"},${res.scenario.offsetS}`);
  lines.push(`# found,${res.candidate?.station || "none"},${res.candidate?.offsetS ?? ""}`);
  lines.push(`# usgs_error_km,all=${res.usgsKm.all},excluded=${res.usgsKm.excluded ?? ""},clean=${res.usgsKm.clean}`);
  download(`quaketrace-${res.event.id}.csv`, URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })));
}

// ---------------------------------------------------------------- audit

async function runAudit() {
  const a = state.audit;
  const query = new URLSearchParams({ station: a.station, onset: a.onset, offset: String(a.offset) });
  a.result = await getJSON(`/api/audit?${query}`);
  a.ran = true;
  const res = a.result;
  const flagged = res.stations.find((row) => row.status === "flagged");
  a.inspected = flagged?.station || (res.scenario.station || a.inspected || "LD.PAL");
}

function logDecision(who, action) {
  state.decisions.unshift({ when: new Date().toISOString(), who, action });
  state.decisions = state.decisions.slice(0, 30);
  store.set("qt.decisions", state.decisions);
}

function when(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderAudit() {
  const a = state.audit;
  const res = a.result;
  const events = res.events;
  const flagged = res.stations.find((row) => row.status === "flagged");
  const pending = res.stations.find((row) => row.status === "pending");
  const first = events[0], last = events[events.length - 1];
  const sub = `${res.stations.length} stations · ${events.length} New Jersey quakes · ${eventDate(first.id)} – ${eventDate(last.id, true)}`;
  const title = flagged ? `${short(flagged.station)}'s clock broke around ${eventDate(flagged.firstSuspicious)}.`
    : pending ? `${short(pending.station)} might be drifting.`
      : "Every clock kept time.";
  const onsetCol = flagged ? events.findIndex((e) => e.id === flagged.firstSuspicious) : -1;
  const inspected = res.stations.find((row) => row.station === a.inspected) || flagged || res.stations[res.stations.length - 1];
  const heat = `<div class="heat"><div></div>${events.map((e, i) => `<div class="col-h ${i === onsetCol ? "onset" : ""}">${esc(e.label)}<small>${e.role === "baseline" ? "baseline" : "&nbsp;"}</small></div>`).join("")}
    ${res.stations.map((row) => {
      const hot = row.status === "flagged";
      return `<button type="button" class="row-h ${hot ? "hot" : ""}" data-inspect="${row.station}" aria-pressed="${row.station === inspected.station}" title="${esc(row.station)} · ${esc(row.status)}">${esc(row.short)}</button>${row.deviationsS.map((v, i) => {
        if (v === null) return '<div class="cell na">—</div>';
        const off = Math.abs(v) >= res.thresholdS;
        const isFirst = hot && events[i].id === row.firstSuspicious;
        return `<div class="cell ${off ? "off" : ""} ${isFirst ? "first" : ""}" title="${esc(row.station)} · ${esc(events[i].label)}${row.simulated[i] ? " · simulated shift" : ""}">${sign(v, 1).replace(/^[+−]0\.0$/, "0.0")}</div>`;
      }).join("")}`;
    }).join("")}</div>`;
  const scenarioNote = res.scenario.offsetS
    ? `Simulated: ${esc(res.scenario.station)} ${sign(res.scenario.offsetS, 1)} s from ${esc(eventDate(res.scenario.onset))} · other cells are published USGS residuals`
    : "Published USGS residuals, centred on each quake's median and each station's baseline";
  const finding = flagged ? `
    <section class="side-col card finding pad" style="gap:16px">
      <div class="kicker">FINDING</div>
      <div class="grid2">
        <div><div style="font-size:13px;color:#6B4A33">Station</div><div class="mono" style="font-size:24px;font-weight:500;margin-top:2px">${esc(flagged.station)}</div></div>
        <div><div style="font-size:13px;color:#6B4A33">Shift</div><div class="mono c-orange" style="font-size:24px;font-weight:500;margin-top:2px">${sign(flagged.estimatedOffsetS, 1)} s</div></div>
      </div>
      <div style="font-size:14px;line-height:1.5;color:var(--ink-2)">Review GPS logs from <strong>${esc(eventDate(flagged.lastNormal))} – ${esc(eventDate(flagged.firstSuspicious))}</strong>. Confirmed on ${esc(eventDate(flagged.confirming))}${flagged.supporting.length > 2 ? `, supported by ${flagged.supporting.slice(2).map((id) => esc(eventDate(id))).join(", ")}` : ""}.</div>
      <div class="grid2" style="gap:8px">
        <button class="btn-orange" type="button" data-decide="suspect">Mark as suspect</button>
        <button class="btn-outline" type="button" data-decide="dismiss">Dismiss</button>
      </div>
    </section>` : `
    <section class="side-col card pad" style="gap:16px">
      <div class="kicker calm">NO FINDING</div>
      <div style="font-size:14px;line-height:1.5;color:var(--ink-2)">${pending ? `${esc(pending.station)} was off on ${esc(eventDate(pending.firstSuspicious))}. One more quake off in the same direction will confirm it.` : `No station was off by ${res.thresholdS} s or more on two quakes in a row.`}</div>
      <button class="btn-plain" type="button" data-action="audit-example">Try the example · LD.PAL +3 s from Apr 27</button>
    </section>`;
  const log = [
    ...(a.ran ? [{ when: new Date().toISOString(), who: "QuakeTrace", action: flagged ? `Flagged ${flagged.station} · ${sign(flagged.estimatedOffsetS, 1)} s since ${eventDate(flagged.firstSuspicious)}` : "No station flagged" }] : []),
    ...state.decisions,
  ];
  render(`
    ${headline(title, esc(sub))}
    <div class="row">
      <section class="main-col card pad" style="display:flex;flex-direction:column;gap:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
          <h2 style="margin:0;font-size:15px;font-weight:600">Seconds off from each station's normal</h2>
          <div class="legend"><span><span class="sw"></span>Normal</span><span><span class="sw off"></span>Off by ${res.thresholdS} s or more</span></div>
        </div>
        <div class="scroll-x">${heat}</div>
        <p class="note" style="margin:0">${scenarioNote}</p>
      </section>
      ${finding}
    </div>
    ${details([
      { title: "Judge controls: break a clock", open: !res.scenario.offsetS, body: `<form class="audit-controls" id="audit-form">
        <div class="field"><label for="a1">Station</label><select id="a1" class="select small mono">${state.overview.auditStations.map((id) => `<option ${id === a.station ? "selected" : ""}>${esc(id)}</option>`).join("")}</select></div>
        <div class="field"><label for="a2">Starting from</label><select id="a2" class="select small">${state.overview.evaluationEvents.map((id) => `<option value="${id}" ${id === a.onset ? "selected" : ""}>${esc(eventDate(id))}</option>`).join("")}</select></div>
        <div class="field"><div class="range-head"><label for="a3">Offset</label><span class="mono c-orange" id="a3-value">${sign(a.offset)} s</span></div><input id="a3" type="range" min="-5" max="5" step="0.5" value="${a.offset}"></div>
        <div style="display:flex;gap:8px"><button class="btn-primary" type="submit" style="height:44px;font-size:14px">Run audit</button><button class="btn-plain" type="button" data-action="audit-reset">Reset</button></div>
      </form>` },
      { title: `${inspected.short} over time`, open: Boolean(flagged), body: `<div class="det-body">${timelineChart(events, inspected.deviationsS, { threshold: res.thresholdS, station: inspected.station, highlight: inspected.supporting })}
        <p class="note">Flag rule: 2 quakes in a row, same direction, at least ${res.thresholdS} s off · first 3 quakes set the baseline · click a station name to inspect it</p></div>` },
      { title: "Decision log", body: `<div class="det-body scroll-x"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead><tbody>
        ${log.length ? log.map((d) => `<tr><td>${esc(when(d.when))}</td><td style="font-family:var(--sans)">${esc(d.who)}</td><td style="font-family:var(--sans)">${esc(d.action)}</td></tr>`).join("") : '<tr><td colspan="3" style="font-family:var(--sans)" class="c-muted">No decisions yet</td></tr>'}
        </tbody></table><p class="note">Decisions are kept in this browser only${state.decisions.length ? ' · <button type="button" class="btn-link" style="padding:0;font-size:12px" data-action="clear-log">Clear log</button>' : ""}</p></div>` },
      { title: "Under the hood", body: `<div class="det-body kv">
        <span>arrivals</span><span>${res.arrivalSource === "tiger" ? "Tiger Data hypertable · by pick time" : "Bundled fixture · fixtures/arrivals.json (set QUAKETRACE_TIGER_DSN for Tiger Data)"}</span>
        <span>station_baseline</span><span>median of the first 3 quakes, after removing each quake's median residual</span>
        <span>decisions</span><span>this browser's local storage</span>
        <span>query time</span><span>${res.elapsedMs} ms</span>
      </div>` },
    ])}
  `);
}

async function showAudit() {
  const a = state.audit;
  a.station ||= "LD.PAL";
  a.onset ||= state.overview.evaluationEvents[1];
  try {
    if (!a.result) {
      const res = await getJSON("/api/audit?offset=0");
      a.result = res;
      a.inspected ||= "LD.PAL";
    }
    renderAudit();
  } catch (error) { errorView(error); }
}

// ---------------------------------------------------------------- events

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-step],[data-action],[data-run],[data-inspect],[data-decide]");
  if (!target || !$("#view").contains(target)) return;
  const r = state.replay;
  const a = state.audit;
  try {
    if (target.dataset.step) {
      await goStep(target.dataset.step);
    } else if (target.dataset.run) {
      r.run = r.run === target.dataset.run ? null : target.dataset.run;
      renderInvestigate();
    } else if (target.dataset.inspect) {
      a.inspected = target.dataset.inspect;
      renderAudit();
    } else if (target.dataset.decide) {
      const flagged = a.result.stations.find((row) => row.status === "flagged");
      logDecision("You", target.dataset.decide === "suspect"
        ? `Marked ${flagged.station} as suspect · ${sign(flagged.estimatedOffsetS, 1)} s since ${eventDate(flagged.firstSuspicious)}`
        : `Dismissed the ${flagged.station} finding`);
      renderAudit();
      $("#view details:nth-of-type(3)")?.setAttribute("open", "");
    } else {
      const action = target.dataset.action;
      if (action === "lock" || action === "secret") {
        if (action === "secret") {
          const ids = eventById(r.event).stations;
          r.station = ids[Math.floor(Math.random() * ids.length)];
          const magnitude = 3 + Math.floor(Math.random() * 7) * 0.5; // 3.0 … 6.0
          r.offset = Math.random() < 0.5 ? -magnitude : magnitude;
          r.secret = true;
        }
        target.disabled = true;
        r.run = null;
        await loadReplay();
        r.maxStep = 2;
        await goStep("damage");
      } else if (action === "again") {
        r.secret = false; r.result = null; r.run = null; r.maxStep = 1;
        await goStep("tamper");
      } else if (action === "to-audit") {
        const res = r.result;
        a.station = res.scenario.station;
        a.onset = state.overview.evaluationEvents[1];
        a.offset = Math.max(-5, Math.min(5, Math.round(res.scenario.offsetS * 2) / 2));
        await runAudit();
        location.hash = "#/audit";
      } else if (action === "audit-example") {
        Object.assign(a, { station: "LD.PAL", onset: state.overview.evaluationEvents[1], offset: 3 });
        logDecision("You", "Ran audit · LD.PAL +3.0 s from Apr 27");
        await runAudit();
        renderAudit();
      } else if (action === "audit-reset") {
        a.offset = 0;
        await runAudit();
        a.ran = false;
        renderAudit();
      } else if (action === "clear-log") {
        state.decisions = [];
        store.remove("qt.decisions");
        renderAudit();
      } else if (action === "png") {
        const url = await state.revealMap.toPNG();
        download(`quaketrace-${r.result.event.id}.png`, url);
      } else if (action === "csv") {
        exportCSV();
      }
    }
  } catch (error) {
    console.error(error);
    errorView(error);
  }
});

document.addEventListener("input", (event) => {
  const r = state.replay;
  if (event.target.id === "sh") {
    r.offset = Number(event.target.value);
    $("#sh-value").textContent = `${sign(r.offset)} s`;
  } else if (event.target.id === "a3") {
    state.audit.offset = Number(event.target.value);
    $("#a3-value").textContent = `${sign(state.audit.offset)} s`;
  } else if (event.target.id === "dim") {
    state.dim = Number(event.target.value);
  }
});

document.addEventListener("change", async (event) => {
  const r = state.replay;
  if (event.target.id === "ev") {
    r.event = event.target.value;
    r.station = null; r.secret = false; r.result = null; r.maxStep = 1;
    await goStep("tamper");
  } else if (event.target.id === "st") {
    r.station = event.target.value;
  } else if (event.target.id === "dim") {
    renderDamage();
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "audit-form") return;
  event.preventDefault();
  const a = state.audit;
  a.station = $("#a1").value;
  a.onset = $("#a2").value;
  a.offset = Number($("#a3").value);
  logDecision("You", `Ran audit · ${a.station} ${sign(a.offset)} s from ${eventDate(a.onset)} · 6 stations × 7 quakes`);
  try { await runAudit(); renderAudit(); } catch (error) { errorView(error); }
});

// ---------------------------------------------------------------- About / Google Maps key

function setupAbout() {
  const dialog = $("#about");
  const stateText = () => {
    const local = store.get("qt.googleMapsKey", "");
    const offline = store.get("qt.offline", false);
    if (offline) return "Google Maps is turned off in this browser. The offline outline map is in use.";
    if (local) return "Connected with a key saved in this browser.";
    if (state.config.serverKey) return "Connected with the server's GOOGLE_MAPS_API_KEY.";
    return "Not connected. Paste a browser key to switch on Google Maps, satellite imagery and the 3D Earth view.";
  };
  $("#about-open").addEventListener("click", () => {
    $("#maps-state").textContent = stateText();
    $("#maps-key").value = "";
    dialog.showModal();
  });
  $("#maps-form").addEventListener("submit", (event) => {
    if (event.submitter?.value !== "save") return;
    const key = $("#maps-key").value.trim();
    if (key) store.set("qt.googleMapsKey", key);
    store.remove("qt.offline");
    location.reload();
  });
  $("#maps-clear").addEventListener("click", () => {
    store.remove("qt.googleMapsKey");
    store.set("qt.offline", true);
    location.reload();
  });
}

// ---------------------------------------------------------------- boot

async function route() {
  if (!state.overview) return;
  if (currentView() === "audit") await showAudit();
  else await goStep(state.replay.result ? state.replay.step : "tamper");
}

async function boot() {
  setupAbout();
  try {
    const [overview, config] = await Promise.all([getJSON("/api/overview"), getJSON("/api/config")]);
    state.overview = overview;
    const localKey = store.get("qt.googleMapsKey", "");
    const offline = store.get("qt.offline", false);
    state.config = {
      googleMapId: config.googleMapId,
      serverKey: Boolean(config.googleMapsKey),
      googleMapsKey: offline ? "" : localKey || config.googleMapsKey,
    };
    state.replay.event = overview.mainshock;
    state.wave = await getJSON("/api/waveform").catch(() => null);
    setStatus("", overview.arrivalSource === "tiger" ? "Ready · Tiger Data" : "Ready");
  } catch (error) {
    errorView(error);
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}

boot();
