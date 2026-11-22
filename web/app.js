import { createMapView } from "./map.js";
import { timelineChart, travelTimeChart, waveformChart } from "./charts.js";
import { LabCanvas, LEGEND_TICKS, drawMiniHeat, legendGradient, misfitT } from "./lab.js";
import { ExplainStage, buildSteps, deriveStory } from "./explain.js";
import { HistoryChart, historyLegend } from "./history.js";
import { renderBenchmark } from "./benchmark.js";

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
  wave: null,
  basemap: store.get("qt.basemap", "map"),
  dim: 30,
  replay: { step: "tamper", maxStep: 1, event: null, station: null, offset: 5, secret: false, clean: null, result: null, run: null },
  audit: { station: null, onset: null, offset: 3, result: null, inspected: null, ran: false },
  decisions: store.get("qt.decisions", []),
  maps: [],
  benchmark: { data: null, shift: 3 },
  history: { view: null, station: "LD.PAL", onset: "2024-04-27", offset: 3, applied: false, scrollTo: false, region: "northeast" },
  explain: { event: null, station: null, offset: 5, secret: false, step: -1, base: null, story: null, steps: null },
  tryq: { list: null, event: null, station: null, offset: 3, applied: false, secret: false, revealed: false, filter: "", sort: "newest", region: "all", result: null },
  lab: { event: null, station: null, offset: 0, exclude: null, secret: false, mode: "search", data: null, runs: null, played: false },
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
    overview: state.overview, basemap: state.basemap, dim: state.dim, small,
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

function currentView() {
  if (location.hash.startsWith("#/try")) return "try";
  if (location.hash.startsWith("#/audit")) return "audit";
  if (location.hash.startsWith("#/replay")) return "replay";
  if (location.hash.startsWith("#/lab")) return "lab";
  if (location.hash.startsWith("#/benchmark")) return "benchmark";
  return "explain";
}

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
        <button class="btn-link" type="button" data-action="to-lab" style="padding-top:0;color:var(--muted)">How does it locate a quake? Open the solver lab</button>
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
        <button class="btn-link" type="button" data-action="to-lab">Watch the solver test every grid point</button>
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
        <span><strong>Map</strong> · OpenStreetMap via OpenFreeMap</span><span>Free, no key, needs internet</span>
        <span><strong>Satellite</strong> · Esri World Imagery</span><span>Free, no key, needs internet</span>
        <span><strong>Earth 3D</strong> · Globe with AWS open terrain</span><span>Free, no key, needs internet</span>
        <span><strong>Fallback</strong> · bundled state outlines</span><span>Used offline or if tiles fail</span>
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
        <button class="btn-link" type="button" data-action="to-lab">See all ${n} refits as heatmaps</button>
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
        <button class="btn-link" type="button" data-action="to-lab" style="padding-top:0">Open this scenario in the solver lab</button>
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
    </section>` : `
    <section class="side-col card pad" style="gap:16px">
      <div class="kicker calm">NO FINDING</div>
      <div style="font-size:14px;line-height:1.5;color:var(--ink-2)">${pending ? `${esc(pending.station)} was off on ${esc(eventDate(pending.firstSuspicious))}. One more quake off in the same direction will confirm it.` : `No station was off by ${res.thresholdS} s or more on two quakes in a row.`}</div>
      <button class="btn-plain" type="button" data-action="audit-example">Try the example · LD.PAL +3 s from Apr 27</button>
    </section>`;
  render(`
    ${historyCardHtml()}
    <div class="audit-zoom">
      <div class="kicker" style="color:var(--muted)">ZOOM IN · THE SEVEN TEWKSBURY QUAKES</div>
      <h2>${esc(title)}</h2>
      <p class="c-muted">${esc(sub)}</p>
    </div>
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
      { title: "Under the hood", body: `<div class="det-body kv">
        <span>arrivals</span><span>${res.arrivalSource === "tiger" ? "Tiger Data hypertable · by pick time" : "Bundled fixture · fixtures/arrivals.json (set QUAKETRACE_TIGER_DSN for Tiger Data)"}</span>
        <span>station_baseline</span><span>median of the first 3 quakes, after removing each quake's median residual</span>
        <span>query time</span><span>${res.elapsedMs} ms</span>
      </div>` },
    ])}
  `);
  mountHistory();
}

// ---------------------------------------------------------------- multi-year history (Tiger Data)

const monthLabel = (iso, opts = { month: "short", year: "numeric" }) => (iso ? new Date(iso).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" }) : "—");

function historyCardHtml() {
  const h = state.history;
  return `
    <section class="card pad history-card" id="history">
      <div class="history-head">
        <div>
          <div class="kicker" style="color:var(--blue-ink)">SCALE IT UP · TIGER DATA</div>
          <h2 id="history-title">Every station's clock, every quake since 2018</h2>
          <p class="c-muted">Each cell is one station's average P-wave timing error for a month, compared with its previous six active months. Orange runs late, blue runs early.</p>
        </div>
        <div class="history-source" id="history-source"></div>
      </div>
      <div class="history-stats" id="history-stats"><span class="c-muted">Loading history…</span></div>
      <form class="history-controls" id="history-form">
        <div class="field"><label for="h-st">Break a clock in history</label><select id="h-st" class="select small mono"></select></div>
        <div class="field"><label for="h-on">Starting</label><input id="h-on" class="select small" type="date" value="${esc(h.onset)}" min="2018-01-01" max="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><div class="range-head"><label for="h-off">Shift</label><span class="mono c-orange" id="h-off-value">${sign(h.offset)} s</span></div><input id="h-off" type="range" min="-5" max="5" step="0.5" value="${h.offset}"></div>
        <div style="display:flex;gap:8px;align-items:end"><button class="btn-primary" type="submit" style="height:40px;font-size:14px">Run on Tiger</button><button class="btn-plain" type="button" data-action="history-clear" style="height:40px">Clear</button></div>
      </form>
      <div class="history-result" id="history-result"></div>
      <div class="history-stage" id="history-stage"><div class="lab-tip" id="history-tip" hidden></div></div>
      <div class="history-foot">
        <div class="lab-legend"><div class="label">Monthly shift from normal (s)</div><div class="lab-ramp" style="background:${historyLegend()}"></div><div class="lab-ticks"><span style="left:0">−3 early</span><span style="left:50%">0</span><span style="left:100%">+3 late</span></div></div>
        <p class="note" style="margin:0">Flag rule: two active months in a row, same direction, at least 1.5 s from the median of the previous six. Grey = one pick that month, or not enough earlier months for a baseline. Blank = no quakes.</p>
      </div>
    </section>`;
}

async function loadHistory() {
  const h = state.history;
  // Always include the chosen station as a row; only apply the shift once the judge runs it.
  const params = new URLSearchParams(h.applied ? { station: h.station, onset: h.onset, offset: String(h.offset), region: h.region } : { station: h.station, region: h.region });
  h.view = await getJSON(`/api/history?${params}`);
}

async function mountHistory() {
  const h = state.history;
  try {
    if (!h.view) await loadHistory();
  } catch (error) {
    const stats = $("#history-stats");
    if (stats) stats.innerHTML = `<span class="c-orange">${esc(error.message)}</span>`;
    return;
  }
  fillHistory();
  if (h.scrollTo) {
    h.scrollTo = false;
    $("#history")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function timeAgo(iso) {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function fillHistory() {
  const h = state.history;
  const view = h.view;
  if (!$("#history")) return;
  if (!view.available) {
    $("#history-stats").innerHTML = `<span class="c-muted">${esc(view.note)}</span>`;
    return;
  }
  const s = view.stats;
  const tiger = view.source === "tiger";
  const live = tiger ? s.live : null;
  const liveNote = live
    ? `<span class="note" style="display:block;margin-top:2px">${live.error && live.lastRun !== live.lastSuccess
      ? `USGS feed unreachable, last good check ${timeAgo(live.lastSuccess)}`
      : `USGS feed checked ${timeAgo(live.lastRun)}`}</span>`
    : "";
  $("#history-source").innerHTML = tiger
    ? `<span class="status"><span class="dot"></span>Live from Tiger Data</span>${liveNote}`
    : `<span class="status"><span class="dot busy"></span>Bundled copy</span><span class="note" style="display:block;margin-top:2px">Set QUAKETRACE_TIGER_DSN to query Tiger live</span>`;
  const chips = [
    `<b>${s.picks.toLocaleString()}</b> P-wave picks`,
    `<b>${s.events.toLocaleString()}</b> quakes`,
    `<b>${s.stations.toLocaleString()}</b> stations`,
    `${monthLabel(s.first)} – ${monthLabel(s.last)}`,
    live ? `<b>+${(live.lastDay ?? 0).toLocaleString()}</b> quakes in the last 24 h · ${live.eventsAdded.toLocaleString()} streamed in live${live.latestAdded ? ` · newest ${live.latestAdded.magnitude !== null ? `M${live.latestAdded.magnitude.toFixed(1)} ` : ""}${esc(live.latestAdded.place || "")}, ${timeAgo(live.latestAdded.time)}` : ""}` : null,
    tiger && s.chunks ? `hypertable: <b>${s.chunks}</b> chunks, ${s.compressedChunks} compressed${s.compressionRatio ? ` (${s.compressionRatio}× smaller)` : ""}` : null,
    `${esc(view.query)} · <b>${view.elapsedMs} ms</b>`,
  ].filter(Boolean);
  if (tiger && state.worldStats) chips.push(`worldwide feed: <b>${state.worldStats.picks.toLocaleString()}</b> picks from <b>${state.worldStats.events.toLocaleString()}</b> M4.5+ quakes`);
  $("#history-stats").innerHTML = chips.map((chip) => `<span class="history-chip">${chip}</span>`).join("");
  if (tiger && !state.worldStats) {
    getJSON("/api/history?region=world").then((world) => {
      if (world.source !== "tiger") return;
      state.worldStats = world.stats;
      if (state.history.view === view && $("#history-stats")) fillHistory();
    }).catch(() => {});
  }
  $("#history-form button[type=submit]").textContent = tiger ? "Run on Tiger" : "Run on bundled copy";
  const select = $("#h-st");
  select.innerHTML = view.stations.map((row) => `<option value="${esc(row.station)}" ${row.station === h.station ? "selected" : ""}>${esc(row.station)}</option>`).join("");
  const flagged = view.stations.filter((row) => row.status === "flagged");
  const sc = view.scenario;
  let result;
  if (sc.station) {
    const hit = flagged.find((row) => row.station === sc.station);
    result = hit
      ? `<strong class="c-green">Caught.</strong> ${esc(hit.station)} flagged from <b>${monthLabel(hit.firstFlag)}</b>, confirmed ${monthLabel(hit.confirmed)}, about <b>${sign(hit.estimatedOffsetS)} s</b>. Last normal month: ${monthLabel(hit.lastNormal)}.`
      : `<strong>Not flagged.</strong> A ${sign(sc.offsetS)} s shift on ${esc(sc.station)} from ${esc(sc.onset)} did not hold for two active months. Try a larger shift or an earlier date.`;
    const others = flagged.filter((row) => row.station !== sc.station);
    if (others.length) result += ` Also flagged in the real data: ${others.map((row) => `${esc(row.short)} (${monthLabel(row.firstFlag)})`).join(", ")}.`;
  } else {
    result = flagged.length
      ? `<strong>In the real data</strong>, ${flagged.map((row) => `${esc(row.station)} drifted ${sign(row.estimatedOffsetS)} s from ${monthLabel(row.firstFlag)}`).join("; ")}.`
      : `<strong>Real data:</strong> no station shows a sustained timing shift across ${s.events.toLocaleString()} quakes. Break one above to see Tiger catch it.`;
  }
  if (view.note) result += `<br><span class="note">${esc(view.note)}</span>`;
  $("#history-result").innerHTML = result;
  const world = view.region === "world";
  $("#history-title").textContent = world
    ? "Every station's clock, north-east quakes plus every M4.5+ quake worldwide"
    : "Every station's clock, every quake since 2018";
  const stage = $("#history-stage");
  const tip = $("#history-tip");
  state.historyChart?.destroy();
  const chart = new HistoryChart(stage, {
    onHover(info) {
      if (!info) { tip.hidden = true; return; }
      const parts = [`<strong>${esc(info.station.station)}</strong> · ${monthLabel(info.month)}`];
      if (!info.picks) parts.push("No picks this month");
      else {
        parts.push(`${info.picks} pick${info.picks === 1 ? "" : "s"} · average residual ${sign(info.value, 2)} s`);
        parts.push(info.deviation === null ? "Not enough history for a baseline yet" : `${sign(info.deviation, 2)} s from normal`);
      }
      tip.innerHTML = parts.join("<br>");
      tip.hidden = false;
      tip.style.left = `${Math.max(8, Math.min(info.x + 14, info.width - 250))}px`;
      tip.style.top = `${info.y + 16}px`;
    },
  });
  chart.setData(view);
  state.historyChart = chart;
  state.maps.push(chart);
}

async function showAudit() {
  render(historyCardHtml());
  await mountHistory();
}

// ---------------------------------------------------------------- solver lab

const LAB_MODES = [["search", "Grid search"], ["heatmap", "Misfit heatmap"], ["waves", "Wavefronts"]];

function labQuery(extra = {}) {
  const l = state.lab;
  return new URLSearchParams({ event: l.event, station: l.offset ? l.station || "" : "", offset: String(l.offset), ...extra });
}

async function loadLab() {
  const l = state.lab;
  const key = labQuery().toString();
  const [data, runs] = await Promise.all([
    getJSON(`/api/lab?${labQuery({ exclude: l.exclude || "" })}`),
    l.runs && l.runsKey === key ? l.runs : getJSON(`/api/lab/runs?${key}`),
  ]);
  l.data = data;
  l.runs = runs;
  l.runsKey = key;
  l.played = false;
}

function labPhaseText(phase, lab) {
  const coarse = lab.coarse.rms.length, fine = lab.fine.rms.length;
  return {
    idle: "Ready to search.",
    coarse: `Coarse pass: testing a ${lab.coarse.stepKm} km grid of ${coarse.toLocaleString()} candidate epicentres. For each one, QuakeTrace predicts every station's arrival at ${lab.model.speedKmS} km/s and measures how badly the real picks disagree.`,
    zoom: "Coarse winner found. Zooming in on a 6 km square around it.",
    fine: `Fine pass: ${fine} candidates on a ${lab.fine.stepKm * 1000} m grid around the coarse winner.`,
    done: `Done. The lowest misfit, ${lab.fit.rmsS.toFixed(2)} s, is ${lab.usgsKm.toFixed(1)} km from the official USGS epicentre.`,
  }[phase];
}

function labStatsHtml(lab) {
  return `
    <div class="stat-label">Candidate epicentres tested</div>
    <div class="stat-big" id="lab-tested">0</div>
    <div class="grid2" style="margin-top:16px">
      <div><div class="label">Best misfit so far</div><div class="stat-mid" style="font-size:24px" id="lab-best">—</div></div>
      <div><div class="label">Best fit to USGS</div><div class="stat-mid" style="font-size:24px" id="lab-usgs">—</div></div>
    </div>
    <p class="lab-phase" id="lab-phase">${esc(labPhaseText("idle", lab))}</p>`;
}

function labWavesHtml(lab) {
  const rows = lab.stations.map((s) => {
    const gap = s.pickS - s.predictedS;
    const out = s.excluded ? ' <span class="c-orange">out</span>' : "";
    return `<tr data-wave-row="${esc(s.id)}"><td>${esc(s.short)}${out}</td><td class="r">${s.predictedS.toFixed(1)}</td><td class="r">${s.pickS.toFixed(1)}</td><td class="r ${Math.abs(gap) >= 1.5 ? "c-orange" : ""}">${sign(gap, 2)}</td></tr>`;
  }).join("");
  return `
    <div class="stat-label">Seconds after the quake</div>
    <div class="stat-big" id="wave-t">0.0 s</div>
    <table class="table lab-wave-table">
      <thead><tr><th>Station</th><th class="r">Expected</th><th class="r">Recorded</th><th class="r">Gap</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Blue pulse: the model's P wave reaches the station. Orange pulse: the station's clock says it recorded the wave.</p>`;
}

function renderLab() {
  const l = state.lab;
  const lab = l.data;
  const runs = l.runs;
  const ev = eventById(l.event);
  const best = runs.runs[0];
  const secret = l.secret;
  const scenarioText = secret ? "Judge's secret shift" : l.offset ? `${l.station} shifted ${sign(l.offset)} s` : "Real arrivals, no shift";
  const sub = `${lab.pointsTested.toLocaleString()} candidate epicentres tested in ${lab.elapsedMs} ms · ${esc(ev.label)}${ev.isMainshock ? ` · M${ev.magnitude}` : ""} · ${esc(scenarioText)}${l.exclude ? ` · ${esc(short(l.exclude))} left out` : ""}`;
  const stations = lab.stations.map((s) => s.id);
  const ticks = LEGEND_TICKS.map((v) => `<span style="left:${(misfitT(v) * 100).toFixed(1)}%">${v}</span>`).join("");
  const stationOptions = secret ? "<option>• • •</option>" : stations.map((id) => `<option ${id === l.station ? "selected" : ""}>${esc(id)}</option>`).join("");
  render(`
    ${headline("Watch the solver find the quake.", sub)}
    <form class="card pad lab-controls" id="lab-form">
      <div class="field"><label for="lab-ev">Earthquake</label><select id="lab-ev" class="select small">${state.overview.events.map((e) => `<option value="${e.id}" ${e.id === l.event ? "selected" : ""}>${esc(e.label)}${e.isMainshock ? " · mainshock" : ""}</option>`).join("")}</select></div>
      <div class="field"><label for="lab-st">Shift a clock</label><select id="lab-st" class="select small mono" ${secret ? "disabled" : ""}>${stationOptions}</select></div>
      <div class="field"><div class="range-head"><label for="lab-sh">Shift</label><span class="mono c-orange" id="lab-sh-value">${secret ? "• • •" : `${sign(l.offset)} s`}</span></div><input id="lab-sh" type="range" min="-10" max="10" step="0.5" value="${secret ? 0 : l.offset}" ${secret ? "disabled" : ""}></div>
      <div class="field"><label for="lab-ex">Leave out</label><select id="lab-ex" class="select small mono"><option value="">Nobody · all ${stations.length}</option>${stations.map((id) => `<option value="${id}" ${id === l.exclude ? "selected" : ""}>${esc(id)}</option>`).join("")}</select></div>
      <div style="display:flex;gap:8px;align-items:end">
        <button class="btn-primary" type="submit" style="height:40px;font-size:14px">Run solver</button>
        ${secret ? '<button class="btn-plain" type="button" data-action="lab-unsecret" style="height:40px">Show secret</button>' : ""}
      </div>
    </form>
    <div class="row">
      <section class="main-col card map-card">
        <div class="lab-tabs" role="tablist" aria-label="Lab view">${LAB_MODES.map(([key, label]) => `<button type="button" role="tab" data-lab-mode="${key}" aria-selected="${key === l.mode}">${label}</button>`).join("")}</div>
        <div class="lab-stage" id="lab-stage"><div class="lab-tip" id="lab-tip" hidden></div></div>
        <div class="lab-bar">
          <div class="lab-buttons" id="lab-buttons"></div>
          <div class="lab-legend" aria-label="Misfit colour scale"><div class="label">RMS misfit (s) · dark = arrivals agree</div><div class="lab-ramp" style="background:${legendGradient()}"></div><div class="lab-ticks">${ticks}</div></div>
        </div>
      </section>
      <section class="side-col">
        <div class="card pad" id="lab-side"></div>
        <div class="card pad lab-how">
          <div class="kicker" style="color:var(--muted)">HOW IT WORKS</div>
          <ol>
            <li>Guess an epicentre on a grid across the search area.</li>
            <li>Predict when the P wave reaches each station from that guess (${lab.model.speedKmS} km/s, ${lab.model.depthKm} km deep).</li>
            <li>Compare with the recorded picks. After solving for the best origin time, the RMS of the disagreement is the misfit.</li>
            <li>Keep the lowest-misfit guess, then repeat on a finer grid around it.</li>
          </ol>
        </div>
      </section>
    </div>
    <section class="card pad">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:18px">Leave one out: ${runs.runs.length} refits</h2>
        <span class="c-muted" style="font-size:13px">Each map drops one station and searches again. A lying clock is the one whose removal makes the bowl deep and tight.</span>
      </div>
      <div class="multiples">
        <figure class="mini ${!l.exclude ? "active" : ""}" data-lab-exclude=""><canvas aria-label="Misfit map with all stations"></canvas><figcaption><span>All stations</span><span class="mono">${runs.all.fit.rmsS.toFixed(2)} s</span></figcaption></figure>
        ${runs.runs.map((run, i) => `<figure class="mini ${i === 0 ? "best" : ""} ${l.exclude === run.station ? "active" : ""}" data-lab-exclude="${esc(run.station)}"><canvas aria-label="Misfit map without ${esc(run.station)}"></canvas><figcaption><span>without ${esc(run.short)}</span><span class="mono">${run.fit.rmsS.toFixed(2)} s</span></figcaption></figure>`).join("")}
      </div>
      <p class="note">Number = best RMS misfit of the remaining stations. Click a map to load that refit above. Blue ring = best fit · star = USGS · orange = station left out.</p>
    </section>
    ${details([
      { title: "Arrival timing at the best fit", body: `<div class="det-body scroll-x"><table class="table"><thead><tr><th>Station</th><th>Site</th><th class="r">Distance</th><th class="r">Expected</th><th class="r">Recorded</th><th class="r">Gap</th></tr></thead><tbody>
        ${lab.stations.map((s) => `<tr><td>${esc(s.id)}</td><td style="font-family:var(--sans)">${esc(s.name)}</td><td class="r">${s.epicentralKm.toFixed(1)} km</td><td class="r">${s.predictedS.toFixed(2)} s</td><td class="r">${s.pickS.toFixed(2)} s</td><td class="r">${sign(s.pickS - s.predictedS, 2)} s${s.excluded ? " · left out" : ""}</td></tr>`).join("")}
      </tbody></table><p class="note">Times after the fitted origin time. Expected = straight-ray travel time at ${lab.model.speedKmS} km/s from ${lab.model.depthKm} km depth.</p></div>` },
      { title: "The search, in numbers", body: `<div class="det-body kv">
        <span>coarse grid</span><span>${lab.coarse.lats.length} × ${lab.coarse.lons.length} points every ${lab.coarse.stepKm} km</span>
        <span>fine grid</span><span>${lab.fine.lats.length} × ${lab.fine.lons.length} points every ${lab.fine.stepKm * 1000} m around the coarse winner</span>
        <span>misfit</span><span>RMS of (pick − travel time − origin), with origin = mean over stations</span>
        <span>search area</span><span>${lab.region.south.toFixed(2)}° to ${lab.region.north.toFixed(2)}° N, ${Math.abs(lab.region.west).toFixed(2)}° to ${Math.abs(lab.region.east).toFixed(2)}° W</span>
        <span>compute time</span><span>${lab.elapsedMs} ms for this view on the server</span>
      </div>` },
    ])}
  `);
  mountLab();
}

function mountLab() {
  const l = state.lab;
  const lab = l.data;
  const stage = $("#lab-stage");
  const tip = $("#lab-tip");
  const canvas = new LabCanvas(stage, state.overview, {
    onHover(info) {
      if (!info || (!info.cell && !info.station)) { tip.hidden = true; return; }
      let html = "";
      if (info.station) {
        const s = info.station;
        html = `<strong>${esc(s.id)}</strong> · ${esc(s.name)}<br>expected ${s.predictedS.toFixed(2)} s · recorded ${s.pickS.toFixed(2)} s`;
      } else if (info.cell && canvas.mode !== "waves") {
        html = `<strong>RMS ${info.cell.rms.toFixed(2)} s</strong><br>If the quake were here (${info.cell.lat.toFixed(3)}°, ${info.cell.lon.toFixed(3)}°), the arrivals would disagree by ${info.cell.rms.toFixed(2)} s on average.`;
      }
      if (!html) { tip.hidden = true; return; }
      tip.innerHTML = html;
      tip.hidden = false;
      tip.style.left = `${Math.max(8, Math.min(info.x + 14, info.width - 260))}px`;
      tip.style.top = `${info.y + 18}px`;
    },
    onTick(progress) {
      const tested = $("#lab-tested");
      if (!tested) return;
      tested.textContent = progress.tested.toLocaleString();
      $("#lab-best").textContent = progress.best ? `${progress.best.rms.toFixed(2)} s` : "—";
      $("#lab-usgs").textContent = progress.phase === "done" ? `${lab.usgsKm.toFixed(1)} km` : "—";
      $("#lab-phase").textContent = labPhaseText(progress.phase, lab);
    },
  });
  canvas.revealSuspect = !l.secret && Boolean(l.offset);
  canvas.setData(lab);
  state.labCanvas = canvas;
  state.maps.push(canvas); // destroyed with the view
  setLabMode(l.mode, { autoplay: !l.played });

  const ev = eventById(l.event);
  document.querySelectorAll(".mini").forEach((figure) => {
    const exclude = figure.dataset.labExclude;
    const surface = exclude ? l.runs.runs.find((run) => run.station === exclude) : l.runs.all;
    drawMiniHeat(figure.querySelector("canvas"), l.runs, surface, { stations: lab.stations, excluded: exclude || null, usgs: ev });
  });

}

function setLabMode(mode, { autoplay = false } = {}) {
  const l = state.lab;
  const canvas = state.labCanvas;
  const lab = l.data;
  l.mode = mode;
  document.querySelectorAll("[data-lab-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.labMode === mode)));
  const side = $("#lab-side");
  const buttons = $("#lab-buttons");
  if (mode === "search") {
    side.innerHTML = labStatsHtml(lab);
    buttons.innerHTML = '<button class="btn-plain" type="button" data-action="lab-play">▶ Run the search</button><button class="btn-plain" type="button" data-action="lab-skip">Skip to result</button>';
    if (autoplay) { l.played = true; canvas.playSearch(); } else canvas.playSearch({ instant: true });
  } else if (mode === "heatmap") {
    side.innerHTML = labStatsHtml(lab);
    canvas.setMode("heatmap");
    $("#lab-tested").textContent = lab.pointsTested.toLocaleString();
    $("#lab-best").textContent = `${lab.fit.rmsS.toFixed(2)} s`;
    $("#lab-usgs").textContent = `${lab.usgsKm.toFixed(1)} km`;
    $("#lab-phase").textContent = `Every tested point, coloured by misfit. Contours mark 0.5, 1, 2 and 4 s. Hover anywhere to read the misfit if the quake had been there.${lab.fit.rmsS > 1 ? ` Nowhere fits better than ${lab.fit.rmsS.toFixed(2)} s: at least one clock disagrees with the rest.` : ""}`;
    buttons.innerHTML = "";
  } else {
    side.innerHTML = labWavesHtml(lab);
    const end = canvas.waveEnd();
    buttons.innerHTML = `<button class="btn-plain" type="button" data-action="lab-waves">▶ Play</button><input type="range" id="wave-scrub" min="0" max="${end}" step="0.05" value="0" aria-label="Seconds after the quake">`;
    canvas.setWaveTime(0);
    updateWaveSide(0);
    if (autoplay) playWaves(0);
  }
}

function updateWaveSide(t) {
  const label = $("#wave-t");
  if (!label) return;
  label.textContent = `${t.toFixed(1)} s`;
  const scrub = $("#wave-scrub");
  if (scrub && document.activeElement !== scrub) scrub.value = String(t);
  for (const s of state.lab.data.stations) {
    const row = document.querySelector(`[data-wave-row="${CSS.escape(s.id)}"]`);
    if (!row) continue;
    row.classList.toggle("reached", t >= s.predictedS);
    row.classList.toggle("recorded", t >= s.pickS);
  }
}

function playWaves(from) {
  const canvas = state.labCanvas;
  const start = from >= canvas.waveEnd() ? 0 : from;
  canvas.playWaves(start, { speed: 3, onTime: (t) => updateWaveSide(t) });
}

async function showLab() {
  const l = state.lab;
  l.event ||= state.overview.mainshock;
  l.station ||= state.overview.waveformStation;
  try {
    if (!l.data) await loadLab();
    renderLab();
  } catch (error) { errorView(error); }
}

// ---------------------------------------------------------------- benchmark

async function showBenchmark() {
  const b = state.benchmark;
  try {
    b.data ||= await getJSON("/api/benchmark");
    render(renderBenchmark(b.data, b.shift));
  } catch (error) { errorView(error); }
}

// ---------------------------------------------------------------- explain (presenter walkthrough)

function explainQuery(extra = {}) {
  const x = state.explain;
  return new URLSearchParams({ event: x.event, station: x.offset ? x.station : "", offset: String(x.offset), ...extra });
}

async function loadExplain() {
  const x = state.explain;
  const q = explainQuery().toString();
  const [replay, lab, runs] = await Promise.all([
    getJSON(`/api/replay?${q}`), getJSON(`/api/lab?${q}`), getJSON(`/api/lab/runs?${q}`),
  ]);
  const suspect = replay.candidate?.station || runs.runs[0].station;
  const labEx = await getJSON(`/api/lab?${explainQuery({ exclude: suspect })}`);
  x.story = deriveStory({ lab, labEx, runs, replay });
  x.steps = buildSteps(x.story);
}

async function showExplain() {
  const x = state.explain;
  x.event ||= state.overview.mainshock;
  x.station ||= state.overview.waveformStation;
  try {
    if (!x.base) x.base = await getJSON(`/api/lab?event=${encodeURIComponent(x.event)}&offset=0`);
    renderExplain();
  } catch (error) { errorView(error); }
}

function renderExplain() {
  const x = state.explain;
  render(`
    <div class="explain">
      <section class="card explain-stage-card"><div id="explain-stage"></div></section>
      <aside class="card pad explain-side" id="explain-side"></aside>
    </div>
    <p class="explain-keys">→ or Space: next · ←: back · R: replay animation · F: full screen</p>
  `);
  const stage = new ExplainStage($("#explain-stage"), state.overview);
  state.explainStage = stage;
  state.maps.push(stage);
  if (x.story) stage.setStory(x.story, x.steps);
  else stage.setStations(x.base);
  explainGo(x.step, { animate: x.step >= 0 });
}

function explainSide() {
  const x = state.explain;
  const side = $("#explain-side");
  if (!side) return;
  const total = x.steps ? x.steps.length : 12;
  const dots = Array.from({ length: total + 2 }, (_, i) => `<span class="${i - 1 === x.step ? "on" : i - 1 < x.step ? "done" : ""}"></span>`).join("");
  if (x.step < 0) {
    const ev = eventById(x.event);
    const ids = ev.stations;
    side.innerHTML = `
      <div class="kicker">THE JUDGE'S TURN</div>
      <p class="explain-say">Break one station's clock. QuakeTrace has to find which one.</p>
      <div class="field"><label for="ex-st">Station</label><select id="ex-st" class="select mono" ${x.secret ? "disabled" : ""}>${x.secret ? "<option>• • •</option>" : ids.map((id) => `<option ${id === x.station ? "selected" : ""}>${esc(id)}</option>`).join("")}</select></div>
      <div class="field" style="gap:8px"><div class="range-head"><label for="ex-sh">Clock shift</label><span class="shift-value" id="ex-sh-value">${x.secret ? "• • •" : `${sign(x.offset)} s`}</span></div>
        <input id="ex-sh" type="range" min="-10" max="10" step="0.5" value="${x.secret ? 0 : x.offset}" ${x.secret ? "disabled" : ""}></div>
      <button class="btn-primary" type="button" data-action="ex-lock">${LOCK}Lock it in</button>
      <button class="btn-link" type="button" data-action="ex-secret">Let the app pick secretly</button>
      <div class="explain-dots" aria-hidden="true">${dots}</div>`;
    return;
  }
  if (x.step >= x.steps.length) {
    const d = x.story;
    const c = d.culprit;
    const s = d.scenario.station;
    const ok = (c && c.station === s) || (!c && !s);
    const title = ok ? (s ? `Caught it. The judge changed ${short(s)}.` : "Correct. No clock was changed.")
      : s ? `Missed. The judge changed ${short(s)}.` : "False alarm. No clock was changed.";
    side.innerHTML = `
      <div class="kicker ${ok ? "calm" : ""}">THE REVEAL</div>
      <p class="explain-say">${esc(title)}</p>
      <div class="grid2">
        <div><div class="label">Injected</div><div class="stat-mid c-orange">${s ? `${sign(d.scenario.offsetS, 2)} s` : "none"}</div><div class="mono c-muted" style="font-size:13px">${esc(s || "")}</div></div>
        <div><div class="label">Found</div><div class="stat-mid">${c ? `${sign(c.offsetS, 2)} s` : "—"}</div><div class="mono c-muted" style="font-size:13px">${esc(c?.station || "")}</div></div>
      </div>
      <div class="divider"><div class="label">Error vs USGS epicentre</div><div class="stat-mid"><span class="c-orange">${d.lab.usgsKm.toFixed(1)}</span>${c ? ` → <span class="c-blue">${d.labEx.usgsKm.toFixed(1)} km</span>` : " km"}</div></div>
      <a class="btn-primary" href="#/try">Now try it on any real quake${ARROW}</a>
      ${s ? '<button class="btn-link" type="button" data-action="ex-history" style="padding:4px 0">Or scale it up: this shift in 8 years of Tiger Data</button>' : '<a class="btn-link" href="#/audit" style="padding:4px 0">Or scale it up in Tiger Data</a>'}
      <div class="explain-nav"><button class="btn-plain" type="button" data-action="ex-back">← Back</button><button class="btn-plain" type="button" data-action="ex-restart">Start over</button></div>
      <div class="explain-dots" aria-hidden="true">${dots}</div>`;
    return;
  }
  const step = x.steps[x.step];
  side.innerHTML = `
    <div class="kicker" style="color:var(--blue-ink)">STEP ${x.step + 1} OF ${x.steps.length}</div>
    <p class="explain-say">${esc(step.say)}</p>
    <p class="explain-note">${esc(step.note)}</p>
    <div class="explain-nav">
      <button class="btn-plain" type="button" data-action="ex-back">← Back</button>
      <button class="btn-plain" type="button" data-action="ex-replay" title="Replay animation (R)">↻</button>
      <button class="btn-primary" type="button" data-action="ex-next">${x.step === x.steps.length - 1 ? "Reveal" : "Next"}${ARROW}</button>
    </div>
    <div class="explain-dots" aria-hidden="true">${dots}</div>`;
}

function explainGo(step, { animate = true } = {}) {
  const x = state.explain;
  const max = x.steps ? x.steps.length : -1;
  x.step = Math.max(-1, Math.min(max, step));
  const stage = state.explainStage;
  if (stage && x.step >= 0) stage.show(Math.min(x.step, max - 1), { animate: animate && x.step < max });
  else stage?.draw();
  explainSide();
}

async function explainLock(secret) {
  const x = state.explain;
  if (secret) {
    const ids = eventById(x.event).stations;
    x.station = ids[Math.floor(Math.random() * ids.length)];
    const magnitude = 3 + Math.floor(Math.random() * 7) * 0.5;
    x.offset = Math.random() < 0.5 ? -magnitude : magnitude;
    x.secret = true;
  } else {
    x.station = $("#ex-st").value;
    x.offset = Number($("#ex-sh").value);
  }
  document.querySelectorAll("#explain-side button").forEach((b) => { b.disabled = true; });
  await loadExplain();
  state.explainStage.setStory(x.story, x.steps);
  explainGo(0);
}

document.addEventListener("keydown", (event) => {
  if (currentView() !== "explain" || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest?.("input, select, textarea, dialog")) return;
  const x = state.explain;
  if (["ArrowRight", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    if (x.step >= 0) explainGo(x.step + 1);
  } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
    event.preventDefault();
    if (x.step >= 0) explainGo(x.step - 1);
  } else if (event.key === "r" || event.key === "R") {
    if (x.step >= 0) explainGo(x.step);
  } else if (event.key === "f" || event.key === "F") {
    toggleFullscreen();
  }
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// ---------------------------------------------------------------- try any quake

const TRY_SORTS = [["newest", "Newest"], ["largest", "Largest"], ["stations", "Most stations"]];
const TRY_REGIONS = [["all", "All"], ["northeast", "North-east US"], ["world", "Worldwide"]];

function tryQuakeRow(q) {
  const t = state.tryq;
  const date = new Date(q.time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `<button type="button" class="try-quake" data-quake="${esc(q.id)}" aria-pressed="${q.id === t.event}">
    <span class="mono try-mag">${q.magnitude !== null ? `M${q.magnitude.toFixed(1)}` : "M?"}</span>
    <span class="try-place">${esc(q.place || q.id)}${q.live ? ' <span class="try-live">live</span>' : ""}</span>
    <span class="try-meta">${date} · ${q.stations} stations</span>
  </button>`;
}

function tryFiltered() {
  const t = state.tryq;
  const needle = t.filter.trim().toLowerCase();
  const rows = t.list.quakes.filter((q) => (t.region === "all" || q.region === t.region)
    && (!needle || `${q.place} ${q.id} ${q.time.slice(0, 10)}`.toLowerCase().includes(needle)));
  if (t.sort === "largest") rows.sort((a, b) => (b.magnitude ?? -9) - (a.magnitude ?? -9));
  else if (t.sort === "stations") rows.sort((a, b) => b.stations - a.stations);
  return rows;
}

function tryListHtml() {
  const rows = tryFiltered();
  if (!rows.length) return '<p class="c-muted" style="margin:8px 4px">No quakes match.</p>';
  const shown = rows.slice(0, 150);
  return shown.map(tryQuakeRow).join("") + (rows.length > shown.length ? `<p class="note" style="margin:8px 4px">Showing 150 of ${rows.length}. Search to narrow it down.</p>` : "");
}

function tryVerdict(res) {
  const t = state.tryq;
  const sc = res.scenario;
  const qt = res.quaketrace;
  const f = qt.flagged;
  if (t.secret && !t.revealed) {
    return f
      ? { kicker: "QUAKETRACE'S ANSWER", calm: false, title: `${short(f)}'s clock is off by ${sign(qt.foundOffsetS)} s.`, body: "Is that the clock the app changed? Reveal to check." }
      : { kicker: "QUAKETRACE'S ANSWER", calm: true, title: "No station stands out.", body: "Either nothing was changed, or the change hides in the normal scatter. Reveal to check." };
  }
  if (sc.station && f === sc.station) return { kicker: "CAUGHT", calm: true, title: `Caught it. ${short(f)} was the changed clock.`, body: `Injected ${sign(sc.offsetS)} s, found ${sign(qt.foundOffsetS)} s.` };
  if (sc.station && f) return { kicker: "MISSED", calm: false, title: `Missed. It blamed ${short(f)}, not ${short(sc.station)}.`, body: `With this station layout, dropping ${short(f)} explains the misfit about as well. A few stations close together can make two clocks look alike.` };
  if (sc.station) return { kicker: "NOT CAUGHT", calm: false, title: `${short(sc.station)}'s ${sign(sc.offsetS)} s shift blended in.`, body: "Small shifts, or a station far from the others, can hide inside the normal scatter. Try a bigger shift or a station closer to the quake." };
  if (f) return { kicker: "REAL DATA", calm: false, title: `Untouched, but ${short(f)} already looks ${qt.foundOffsetS > 0 ? "late" : "early"}.`, body: `Its real USGS reading disagrees with the other stations by ${sign(qt.foundOffsetS)} s. That can be a bad pick or a real timing problem, so it is worth a look.` };
  return { kicker: "REAL DATA", calm: true, title: "Every clock agrees.", body: "Nothing changed and no station stands out. Now break one." };
}

function tryScene(res) {
  const t = state.tryq;
  const hidden = t.secret && !t.revealed;
  const qt = res.quaketrace;
  const f = qt.flagged;
  const stations = res.stations.map((s) => ({
    id: s.id, short: s.short, name: `${s.km} km from the quake`, lat: s.lat, lon: s.lon,
    tone: s.id === f ? "suspect" : !hidden && s.shifted ? "out" : "",
  }));
  const marks = [{ lat: res.event.lat, lon: res.event.lon, kind: "star", label: "USGS", labelUp: true }];
  marks.push({ lat: res.naive.lat, lon: res.naive.lon, kind: "ring-gray", label: `all stations · ${res.naive.usgsKm.toFixed(1)} km off`, labelLeft: true });
  if (f) marks.push({ lat: qt.lat, lon: qt.lon, kind: "ring", label: `QuakeTrace · ${qt.usgsKm.toFixed(1)} km off` });
  const flaggedStation = res.stations.find((s) => s.id === f);
  return {
    stations, marks, minSpanKm: 40,
    outCircle: flaggedStation ? { lat: flaggedStation.lat, lon: flaggedStation.lon, label: `${flaggedStation.short} ${sign(qt.foundOffsetS)} s` } : null,
  };
}

function renderTry() {
  const t = state.tryq;
  const res = t.result;
  const list = t.list;
  const b = list.benchmark;
  const live = list.quakes.filter((q) => q.live).length;
  const worldCount = list.quakes.filter((q) => q.region === "world").length;
  const wb = list.worldBenchmark;
  const ev = res.event;
  const hidden = t.secret && !t.revealed;
  const v = tryVerdict(res);
  const sc = res.scenario;
  const qt = res.quaketrace;
  const stationOptions = res.stations.map((s) => `<option value="${esc(s.id)}" ${s.id === t.station ? "selected" : ""}>${esc(s.id)} · ${s.km} km</option>`).join("");
  const looRows = [...res.stations].sort((a, c) => a.withoutRmsS - c.withoutRmsS).map((s) => ({
    label: s.short, value: s.withoutRmsS, hot: s.id === qt.flagged, tone: s.id === qt.flagged ? "good" : "",
  }));
  const distances = [
    { label: "All stations", value: res.naive.usgsKm },
    { label: "Standard", value: res.weighted.usgsKm },
    { label: "QuakeTrace", value: qt.usgsKm, tone: "good", hot: true },
  ];
  render(`
    ${headline("Now break a clock on any real quake.", `${(list.quakes.length - worldCount).toLocaleString()} north-east US quakes since 2018${worldCount ? ` and <b>${worldCount}</b> worldwide quakes from dense local networks (Ridgecrest M7.1 among them)` : ""}, all with at least 6 stations within 150 km${live ? ` · <b>${live}</b> streamed in live from Tiger Data` : ""}. Pick one, change one station's clock, and see if QuakeTrace names it.`)}
    ${b ? `<div class="history-stats try-proof">
      <span class="history-chip">North-east, tested on all <b>${b.quakes}</b>: names the broken station <b>${Math.round(b.caught3 * 100)}%</b> of the time at ±3 s, <b>${Math.round(b.caught5 * 100)}%</b> at ±5 s</span>
      <span class="history-chip">median error at ±3 s: <b>${b.quaketrace3Km.toFixed(1)} km</b> vs ${b.naive3Km.toFixed(1)} km using every station</span>
      <span class="history-chip">false alarms on untouched quakes: <b>${Math.round(b.falseFlags * 100)}%</b></span>
      ${worldCount && wb ? `<span class="history-chip">worldwide set: <b>${Math.round(wb.caught3 * 100)}%</b> at ±3 s, <b>${Math.round(wb.caught5 * 100)}%</b> at ±5 s</span>` : ""}
    </div>` : ""}
    <div class="row">
      <div class="main-col" style="display:flex;flex-direction:column;gap:16px">
        <section class="card pad try-picker">
          <div class="try-picker-head">
            <div class="kicker" style="color:var(--blue-ink)">1 · PICK A QUAKE</div>
            ${worldCount ? `<div class="seg" role="group" aria-label="Which quakes">${TRY_REGIONS.map(([key, label]) => `<button type="button" data-action="tq-region" data-region="${key}" aria-pressed="${t.region === key}">${label}</button>`).join("")}</div>` : ""}
            <div class="seg" role="group" aria-label="Sort quakes">${TRY_SORTS.map(([key, label]) => `<button type="button" data-action="tq-sort" data-sort="${key}" aria-pressed="${t.sort === key}">${label}</button>`).join("")}</div>
          </div>
          <div class="try-search"><input id="tq-search" class="select small" type="search" placeholder="Search a place, date or ID (e.g. New Jersey, 2024-04)" value="${esc(t.filter)}" aria-label="Search quakes"><button class="btn-plain" type="button" data-action="tq-random">Random quake</button></div>
          <div class="try-list" id="tq-list">${tryListHtml()}</div>
        </section>
        <section class="card map-card"><div id="try-map"></div></section>
        <section class="card pad">
          <h2 style="margin:0 0 4px;font-size:15px;font-weight:600">Refit without each station</h2>
          <p class="note" style="margin:0 0 12px">How much the other stations still disagree (RMS, seconds) when one is left out. If dropping one station makes the rest agree much better, that station is the one to blame.</p>
          <div class="bars">${plainBars(looRows, { unit: " s" })}</div>
        </section>
      </div>
      <div class="side-col">
        <section class="card pad" style="display:flex;flex-direction:column;gap:14px">
          <div class="kicker" style="color:var(--blue-ink)">2 · BREAK A CLOCK</div>
          <div>
            <div style="font-size:17px;font-weight:600">${ev.magnitude !== null ? `M${ev.magnitude.toFixed(1)} · ` : ""}${esc(ev.place || ev.id)}</div>
            <div class="c-muted" style="font-size:13px">${new Date(ev.time).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC · ${res.stations.length} stations${ev.live ? " · streamed in live" : ""}</div>
          </div>
          <div class="field"><label for="tq-st">Station</label><select id="tq-st" class="select small mono" ${hidden ? "disabled" : ""}>${hidden ? "<option>• • •</option>" : stationOptions}</select></div>
          <div class="field" style="gap:8px"><div class="range-head"><label for="tq-sh">Clock shift</label><span class="shift-value" id="tq-sh-value">${hidden ? "• • •" : `${sign(t.offset)} s`}</span></div>
            <input id="tq-sh" type="range" min="-10" max="10" step="0.5" value="${hidden ? 0 : t.offset}" ${hidden ? "disabled" : ""}></div>
          <button class="btn-primary" type="button" data-action="tq-run">${LOCK}Break it and locate</button>
          <div style="display:flex;justify-content:space-between;gap:8px">
            <button class="btn-link" type="button" data-action="tq-secret" style="padding:4px 0">Let the app pick secretly</button>
            <button class="btn-link" type="button" data-action="tq-clean" style="padding:4px 0;color:var(--muted)">Untouched</button>
          </div>
        </section>
        <section class="card pad ${v.calm ? "" : "finding"}" style="display:flex;flex-direction:column;gap:12px">
          <div class="kicker ${v.calm ? "calm" : ""}">${v.kicker}</div>
          <div style="font-size:20px;font-weight:600;line-height:1.3">${esc(v.title)}</div>
          <div style="font-size:14px;line-height:1.5;color:var(--ink-2)">${esc(v.body)}</div>
          ${hidden ? '<button class="btn-primary" type="button" data-action="tq-reveal">Reveal the answer</button>' : `
          ${sc.station ? `<div class="grid2">
            <div><div class="label">Injected</div><div class="stat-mid c-orange">${sign(sc.offsetS)} s</div><div class="mono c-muted" style="font-size:13px">${esc(sc.station)}</div></div>
            <div><div class="label">Found</div><div class="stat-mid">${qt.flagged ? `${sign(qt.foundOffsetS)} s` : "—"}</div><div class="mono c-muted" style="font-size:13px">${esc(qt.flagged || "")}</div></div>
          </div>` : ""}
          <div><div class="label" style="margin-bottom:6px">Distance from the USGS epicentre</div><div class="bars">${plainBars(distances, { unit: " km", digits: 1, wide: true })}</div>
          <p class="note">All stations: equal weights. Standard: down-weights readings that don't fit, as common locators do. QuakeTrace: drops the station it blames.</p></div>`}
        </section>
        <a class="btn-plain try-next" href="#/audit">Scale it up: every station's clock in Tiger Data →</a>
      </div>
    </div>
  `);
  mountMap("#try-map", tryScene(res));
  const listBox = $("#tq-list");
  const picked = listBox?.querySelector("[aria-pressed=true]");
  if (picked) listBox.scrollTop += picked.getBoundingClientRect().top - listBox.getBoundingClientRect().top - 8;
}

async function loadTry() {
  const t = state.tryq;
  const params = new URLSearchParams({ event: t.event, offset: String(t.applied ? t.offset : 0) });
  if (t.applied) params.set("station", t.station);
  t.result = await getJSON(`/api/try?${params}`);
}

function tryDefaultStation(res) {
  // The second-closest station that is not the grid's anchor: close enough to matter.
  const ordered = res.stations.filter((s) => !s.first);
  return (ordered[1] || ordered[0] || res.stations[0]).id;
}

async function trySelect(id) {
  const t = state.tryq;
  Object.assign(t, { event: id, applied: false, secret: false, revealed: false });
  await loadTry();
  t.station = tryDefaultStation(t.result);
  renderTry();
}

async function showTry() {
  const t = state.tryq;
  try {
    if (!t.list) t.list = await getJSON("/api/quakes");
    if (!t.event) {
      const pick = t.list.quakes.find((q) => q.stations >= 8) || t.list.quakes[0];
      await trySelect(pick.id);
      return;
    }
    if (!t.result) await loadTry();
    renderTry();
  } catch (error) { errorView(error); }
}

// ---------------------------------------------------------------- events

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-step],[data-action],[data-run],[data-inspect],[data-decide],[data-lab-mode],[data-lab-exclude],[data-quake]");
  if (!target || !$("#view").contains(target)) return;
  const r = state.replay;
  const a = state.audit;
  try {
    if (target.dataset.quake) {
      await trySelect(target.dataset.quake);
    } else if (target.dataset.labMode) {
      setLabMode(target.dataset.labMode, { autoplay: target.dataset.labMode === "waves" });
    } else if (target.dataset.labExclude !== undefined) {
      state.lab.exclude = target.dataset.labExclude || null;
      state.lab.mode = "heatmap";
      await loadLab();
      state.lab.played = true;
      renderLab();
      $("#lab-stage")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (target.dataset.step) {
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
      } else if (action === "ex-lock" || action === "ex-secret") {
        await explainLock(action === "ex-secret");
      } else if (action === "ex-next") {
        explainGo(state.explain.step + 1);
      } else if (action === "ex-back") {
        explainGo(state.explain.step - 1);
      } else if (action === "ex-replay") {
        explainGo(state.explain.step);
      } else if (action === "ex-restart") {
        Object.assign(state.explain, { story: null, steps: null, step: -1, secret: false });
        renderExplain();
      } else if (action === "ex-history") {
        const sc = state.explain.story.scenario;
        Object.assign(state.history, { station: sc.station, onset: "2024-04-27", offset: Math.max(-5, Math.min(5, Math.round(sc.offsetS * 2) / 2)), applied: true, view: null, scrollTo: true });
        location.hash = "#/audit";
      } else if (action === "tq-run") {
        const t = state.tryq;
        if (!t.secret || t.revealed) {
          t.station = $("#tq-st").value;
          t.offset = Number($("#tq-sh").value);
          t.secret = false;
        }
        Object.assign(t, { applied: true, revealed: false });
        target.disabled = true;
        await loadTry();
        renderTry();
      } else if (action === "tq-secret") {
        const t = state.tryq;
        const ids = t.result.stations.map((s) => s.id);
        const size = 3 + Math.floor(Math.random() * 5) * 0.5; // 3.0 … 5.0 s, the range the benchmark headline covers
        Object.assign(t, { station: ids[Math.floor(Math.random() * ids.length)], offset: Math.random() < 0.5 ? -size : size, applied: true, secret: true, revealed: false });
        await loadTry();
        renderTry();
      } else if (action === "tq-reveal") {
        state.tryq.revealed = true;
        renderTry();
      } else if (action === "tq-clean") {
        Object.assign(state.tryq, { applied: false, secret: false, revealed: false });
        await loadTry();
        renderTry();
      } else if (action === "tq-random") {
        const rows = tryFiltered();
        if (rows.length) await trySelect(rows[Math.floor(Math.random() * rows.length)].id);
      } else if (action === "tq-region") {
        state.tryq.region = target.dataset.region;
        document.querySelectorAll("[data-action=tq-region]").forEach((b) => b.setAttribute("aria-pressed", String(b === target)));
        $("#tq-list").innerHTML = tryListHtml();
        $("#tq-list").scrollTop = 0;
      } else if (action === "tq-sort") {
        state.tryq.sort = target.dataset.sort;
        document.querySelectorAll("[data-action=tq-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b === target)));
        $("#tq-list").innerHTML = tryListHtml();
        $("#tq-list").scrollTop = 0;
      } else if (action === "bench-shift") {
        state.benchmark.shift = Number(target.dataset.shift);
        await showBenchmark();
      } else if (action === "history-region") {
        state.history.region = target.dataset.region;
        state.history.view = null;
        document.querySelectorAll("[data-action=history-region]").forEach((b) => b.setAttribute("aria-pressed", String(b === target)));
        $("#history-stats").innerHTML = '<span class="c-muted">Loading history…</span>';
        await mountHistory();
      } else if (action === "history-clear") {
        Object.assign(state.history, { applied: false, view: null });
        await mountHistory();
      } else if (action === "ex-audit") {
        const sc = state.explain.story.scenario;
        Object.assign(a, { station: sc.station, onset: state.overview.evaluationEvents[1], offset: Math.max(-5, Math.min(5, Math.round(sc.offsetS * 2) / 2)) });
        await runAudit();
        location.hash = "#/audit";
      } else if (action === "lab-play") {
        state.labCanvas.playSearch({ force: true });
      } else if (action === "lab-skip") {
        state.labCanvas.playSearch({ instant: true });
      } else if (action === "lab-waves") {
        playWaves(state.labCanvas.waveT);
      } else if (action === "lab-unsecret") {
        state.lab.secret = false;
        renderLab();
      } else if (action === "to-lab") {
        const res = r.result || r.clean;
        Object.assign(state.lab, {
          event: r.event, station: res?.scenario.station || r.station, offset: res?.scenario.offsetS || 0,
          secret: r.secret && r.step !== "reveal", exclude: null, mode: "search", data: null,
        });
        location.hash = "#/lab";
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
    state.maps.forEach((m) => m.setDim?.(state.dim));
  } else if (event.target.id === "h-off") {
    $("#h-off-value").textContent = `${sign(Number(event.target.value))} s`;
  } else if (event.target.id === "tq-sh") {
    $("#tq-sh-value").textContent = `${sign(Number(event.target.value))} s`;
  } else if (event.target.id === "tq-search") {
    state.tryq.filter = event.target.value;
    $("#tq-list").innerHTML = tryListHtml();
  } else if (event.target.id === "ex-sh") {
    $("#ex-sh-value").textContent = `${sign(Number(event.target.value))} s`;
  } else if (event.target.id === "lab-sh") {
    $("#lab-sh-value").textContent = `${sign(Number(event.target.value))} s`;
  } else if (event.target.id === "wave-scrub") {
    const t = Number(event.target.value);
    state.labCanvas.setWaveTime(t);
    updateWaveSide(t);
  }
});

document.addEventListener("change", async (event) => {
  const r = state.replay;
  if (event.target.id === "ev") {
    r.event = event.target.value;
    r.station = null; r.secret = false; r.result = null; r.maxStep = 1;
    await goStep("tamper");
  } else if (event.target.id === "lab-ev") {
    const l = state.lab;
    const ids = eventById(event.target.value).stations;
    l.event = event.target.value;
    if (!ids.includes(l.station)) l.station = ids.includes(state.overview.waveformStation) ? state.overview.waveformStation : ids[0];
    if (!ids.includes(l.station)) l.offset = 0;
    l.exclude = null; l.secret = false; l.mode = "search";
    try { await loadLab(); renderLab(); } catch (error) { errorView(error); }
  } else if (event.target.id === "st") {
    r.station = event.target.value;
  } else if (event.target.id === "dim") {
    renderDamage();
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "history-form") {
    event.preventDefault();
    Object.assign(state.history, { station: $("#h-st").value, onset: $("#h-on").value, offset: Number($("#h-off").value), applied: true, view: null });
    if (!state.history.onset) return;
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try { await mountHistory(); } finally { button.disabled = false; }
    return;
  }
  if (event.target.id === "lab-form") {
    event.preventDefault();
    const l = state.lab;
    l.event = $("#lab-ev").value;
    if (!l.secret) {
      l.station = $("#lab-st").value;
      l.offset = Number($("#lab-sh").value);
    }
    l.exclude = $("#lab-ex").value || null;
    l.mode = "search";
    try { await loadLab(); renderLab(); } catch (error) { errorView(error); }
    return;
  }
  if (event.target.id !== "audit-form") return;
  event.preventDefault();
  const a = state.audit;
  a.station = $("#a1").value;
  a.onset = $("#a2").value;
  a.offset = Number($("#a3").value);
  logDecision("You", `Ran audit · ${a.station} ${sign(a.offset)} s from ${eventDate(a.onset)} · 6 stations × 7 quakes`);
  try { await runAudit(); renderAudit(); } catch (error) { errorView(error); }
});

// ---------------------------------------------------------------- About

function setupAbout() {
  $("#about-open").addEventListener("click", () => $("#about").showModal());
}

// ---------------------------------------------------------------- boot

async function route() {
  if (!state.overview) return;
  if (currentView() === "try") await showTry();
  else if (currentView() === "audit") await showAudit();
  else if (currentView() === "lab") await showLab();
  else if (currentView() === "benchmark") await showBenchmark();
  else if (currentView() === "explain") await showExplain();
  else await goStep(state.replay.result ? state.replay.step : "tamper");
}

async function boot() {
  setupAbout();
  try {
    const overview = await getJSON("/api/overview");
    state.overview = overview;
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
