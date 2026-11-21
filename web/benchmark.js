// Benchmark tab: QuakeTrace vs standard locators on every eligible real north-east quake.

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const METHODS = [
  { key: "naive", label: "Naive fit", color: "#9AA4B2", about: "Least squares over every station, equal weights. Trusts every clock." },
  { key: "weighted", label: "Residual-weighted fit", color: "#1F6FEB", about: "What standard locators do: readings that don't fit lose weight (none beyond 1.5 s), refit four times." },
  { key: "quaketrace", label: "QuakeTrace", color: "#0B8A6C", about: "Leave-one-out: names the station to blame and refits without it; otherwise keeps the naive fit." },
];

const pct = (value) => `${Math.round(value * 100)}%`;
const km = (value) => `${value.toFixed(1)} km`;
const shiftLabel = (shift) => (Number(shift) ? `±${Number(shift)} s` : "No error");

function bars(summary) {
  const top = Math.max(...METHODS.map((m) => summary[m.key].median)) * 1.15;
  return METHODS.map((m) => {
    const s = summary[m.key];
    return `<div class="bm-bar">
      <div class="bm-bar-head"><span class="bm-swatch" style="background:${m.color}"></span><strong>${m.label}</strong><span class="mono bm-value">${km(s.median)}</span></div>
      <div class="bm-track"><div class="bm-fill" style="width:${(s.median / top) * 100}%;background:${m.color}"></div></div>
      <div class="note" style="margin-top:4px">${esc(m.about)} Mean ${km(s.mean)} · ${pct(s.within5)} within 5 km.</div>
    </div>`;
  }).join("");
}

function lineChart(data, selected) {
  const W = 560, H = 240, L = 44, R = 16, T = 16, B = 34;
  const shifts = data.shifts;
  const values = shifts.flatMap((s) => METHODS.map((m) => data.summary[String(s)][m.key].median));
  const yMax = Math.ceil(Math.max(...values) + 1);
  const x = (i) => L + (i / (shifts.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const grid = Array.from({ length: yMax + 1 }, (_, v) => v).filter((v) => v % 2 === 0).map((v) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E3E6EB"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="bm-axis">${v}</text>`).join("");
  const sel = shifts.findIndex((s) => String(s) === String(selected));
  const lines = METHODS.map((m) => {
    const pts = shifts.map((s, i) => `${x(i)},${y(data.summary[String(s)][m.key].median)}`).join(" ");
    const dots = shifts.map((s, i) => `<circle cx="${x(i)}" cy="${y(data.summary[String(s)][m.key].median)}" r="${i === sel ? 5 : 3.5}" fill="${m.color}" stroke="#fff" stroke-width="1.5"/>`).join("");
    return `<polyline points="${pts}" fill="none" stroke="${m.color}" stroke-width="2.5" stroke-linejoin="round"/>${dots}`;
  }).join("");
  const ticks = shifts.map((s, i) => `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" class="bm-axis">${shiftLabel(s)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="bm-chart" role="img" aria-label="Median distance from USGS for each method as the clock error grows">
    <rect x="${x(sel) - 22}" y="${T}" width="44" height="${H - T - B}" fill="#F3F5F8"/>${grid}
    <text x="${L}" y="${T - 4}" class="bm-axis">km from USGS (median)</text>${lines}${ticks}</svg>`;
}

function cdfChart(trials) {
  const W = 560, H = 240, L = 44, R = 16, T = 16, B = 34, MAX = 15;
  const x = (v) => L + (Math.min(v, MAX) / MAX) * (W - L - R);
  const y = (f) => T + (1 - f) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(f)}" y2="${y(f)}" stroke="#E3E6EB"/><text x="${L - 8}" y="${y(f) + 4}" text-anchor="end" class="bm-axis">${f * 100}%</text>`).join("");
  const xt = [0, 5, 10, 15].map((v) => `<text x="${x(v)}" y="${H - 12}" text-anchor="${v === MAX ? "end" : v ? "middle" : "start"}" class="bm-axis">${v} km</text>`).join("");
  const lines = METHODS.map((m) => {
    const sorted = trials.map((t) => t[m.key]).sort((a, b) => a - b);
    const n = sorted.length;
    let path = `M${x(0)},${y(0)}`;
    const inside = sorted.filter((v) => v <= MAX);
    inside.forEach((v, i) => { path += ` L${x(v)},${y(i / n)} L${x(v)},${y((i + 1) / n)}`; });
    path += ` L${x(MAX)},${y(inside.length / n)}`;
    return `<path d="${path}" fill="none" stroke="${m.color}" stroke-width="2.2"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="bm-chart" role="img" aria-label="Share of quakes located within each distance of USGS">
    ${grid}<text x="${L}" y="${T - 4}" class="bm-axis">share of quakes within this distance of USGS</text>${lines}${xt}</svg>`;
}

function takeaway(data, shift) {
  const s = data.summary[String(shift)];
  const n = s.trials;
  if (!Number(shift)) {
    return `With no clock error, all three land a median <b>${km(s.naive.median)}</b> from USGS. QuakeTrace raised a false alarm on <b>${pct(s.falseFlags)}</b> of quakes, and its median moved by ${Math.abs(s.quaketrace.median - s.naive.median).toFixed(2)} km: safe to run on every quake.`;
  }
  const q = s.quaketrace, w = s.weighted, nv = s.naive;
  const vsNaive = `A ${shiftLabel(shift)} clock error drags the naive fit to <b>${km(nv.median)}</b>; QuakeTrace brings it back to <b>${km(q.median)}</b>.`;
  const vsWeighted = q.median < w.median - 0.05
    ? `It also beats the residual-weighted fit standard locators use (${km(w.median)} median)`
    : q.median > w.median + 0.05
      ? `The residual-weighted fit standard locators use does better here (${km(w.median)} median)`
      : `It matches the residual-weighted fit standard locators use (${km(w.median)} median)`;
  const mean = q.mean < w.mean - 0.05 ? `, and on the average (${km(q.mean)} vs ${km(w.mean)})` : q.mean > w.mean + 0.05 ? `, though not on the average (${km(q.mean)} vs ${km(w.mean)}), because when QuakeTrace can't name a station it keeps the naive fit` : "";
  return `${vsNaive} ${vsWeighted}${mean}. The difference that matters: QuakeTrace <b>named the broken station on ${pct(s.caught)}</b> of ${n} quakes. Weighting quietly works around a bad clock without ever saying which one, so the station keeps reporting wrong times.`;
}

function worseList(data, shift) {
  const trials = data.trials[String(shift)]
    .filter((t) => t.quaketrace > t.weighted + 0.5)
    .sort((a, b) => (b.quaketrace - b.weighted) - (a.quaketrace - a.weighted))
    .slice(0, 8);
  if (!trials.length) return `<p class="note">None: QuakeTrace was never more than 0.5 km worse than the weighted fit.</p>`;
  const rows = trials.map((t) => {
    const quake = data.quakes[t.quake];
    const date = new Date(quake.time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const why = t.flagged === null ? "no station flagged" : t.flagged === t.station ? "right station, weaker refit" : t.station ? `flagged ${esc(t.flagged)} instead` : `false alarm on ${esc(t.flagged)}`;
    return `<tr><td>${date}</td><td>${quake.magnitude !== null ? `M${quake.magnitude.toFixed(1)}` : ""} ${esc(quake.place)}</td><td class="mono">${quake.stations}</td>
      <td class="mono">${esc(t.station || "—")}</td><td>${why}</td><td class="mono">${t.weighted.toFixed(1)}</td><td class="mono">${t.quaketrace.toFixed(1)}</td></tr>`;
  }).join("");
  return `<div class="bm-table-wrap"><table class="bm-table"><thead><tr><th>Date</th><th>Quake</th><th>Stations</th><th>Broken clock</th><th>What happened</th><th>Weighted km</th><th>QuakeTrace km</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">${lossBreakdown(data, shift)}</p>`;
}

function lossBreakdown(data, shift) {
  const s = data.summary[String(shift)];
  const worse = data.trials[String(shift)].filter((t) => t.quaketrace > t.weighted + 0.5);
  const count = (test) => worse.filter(test).length;
  const parts = [
    [count((t) => t.flagged === null), "no station stood out, so QuakeTrace kept the naive fit"],
    [count((t) => t.flagged !== null && t.flagged === t.station), "it named the right station but the refit without it landed further off"],
    [count((t) => t.flagged !== null && t.flagged !== t.station), Number(shift) ? "it blamed the wrong station" : "a false alarm dropped a good station"],
  ].filter(([n]) => n).map(([n, text]) => `${n}: ${text}`);
  return `QuakeTrace was more than 0.5 km worse than the weighted fit on ${s.quaketraceWorse} quakes and better on ${s.quaketraceBetter}. Of the losses, ${parts.join("; ")}.`;
}

export function renderBenchmark(data, shift) {
  const s = data.summary[String(shift)];
  const shifted = Boolean(Number(shift));
  const first = data.quakes[0].time.slice(0, 4);
  const last = data.quakes[data.quakes.length - 1].time.slice(0, 4);
  return `
    <section class="bm">
      <div class="bm-head">
        <div>
          <div class="kicker" style="color:var(--blue-ink)">BENCHMARK · REAL USGS DATA</div>
          <h1 class="bm-title">Does it hold up on ${data.quakes.length} real quakes?</h1>
          <p class="c-muted bm-lede">Every north-east US quake from ${first}–${last} with at least ${data.criteria.minStations} stations within ${data.criteria.maxDistanceDeg}°. One random station gets a simulated clock error, each method relocates the quake from the real arrival times, and we measure how far it lands from the USGS epicentre.</p>
        </div>
      </div>
      <div class="seg bm-shifts" role="group" aria-label="Simulated clock error">
        ${data.shifts.map((v) => `<button type="button" data-action="bench-shift" data-shift="${v}" aria-pressed="${String(v) === String(shift)}">${shiftLabel(v)}</button>`).join("")}
      </div>
      <div class="bm-grid">
        <div class="card pad"><div class="stat-label">Distance from USGS, median of ${s.trials} quakes</div><div class="bm-bars">${bars(s)}</div></div>
        <div class="card pad bm-side">
          ${shifted
            ? `<div class="stat-label">Broken station named</div><div class="stat-big c-green">${pct(s.caught)}</div><p class="note">Wrong station blamed on ${pct(s.wrongStation)}. The rest: no station stood out clearly enough, so QuakeTrace said nothing.</p>`
            : `<div class="stat-label">False alarms</div><div class="stat-big">${pct(s.falseFlags)}</div><p class="note">Quakes where QuakeTrace blamed a station although every clock was fine.</p>`}
          <p class="bm-takeaway">${takeaway(data, shift)}</p>
        </div>
      </div>
      <div class="bm-grid two">
        <div class="card pad"><h3 class="bm-h3">As the clock error grows</h3>${lineChart(data, shift)}</div>
        <div class="card pad"><h3 class="bm-h3">How close, quake by quake · ${shiftLabel(shift)}</h3>${cdfChart(data.trials[String(shift)])}</div>
      </div>
      <div class="bm-legend">${METHODS.map((m) => `<span><span class="bm-swatch" style="background:${m.color}"></span>${m.label}</span>`).join("")}</div>
      <details class="card pad bm-details"><summary>Where QuakeTrace did worse than the weighted fit · ${shiftLabel(shift)}</summary>${worseList(data, shift)}</details>
      <details class="card pad bm-details"><summary>How the benchmark works</summary>
        <ul class="bm-method">
          <li><b>Data:</b> ${esc(data.source)}. P readings (${data.criteria.phases.join(", ")}) within ${data.criteria.maxDistanceDeg}° (about ${Math.round(data.criteria.maxDistanceDeg * 111)} km), earliest per station.</li>
          <li><b>Clock error:</b> one station per quake, chosen at random with a random sign (seed ${data.criteria.seed}), the same station at every error size.</li>
          <li><b>Model:</b> QuakeTrace's own: 6 km/s, 5 km depth, 2 km grid refined to 250 m, centred on the first station to record the quake (not on the answer).</li>
          <li><b>Truth:</b> the USGS catalog epicentre, which used every station's real, unshifted clock and a better earth model. The no-error column shows the model's own limit.</li>
          <li><b>Stations:</b> positions rebuilt from each reading's distance and direction from the epicentre, averaged over all readings.</li>
          <li>Regenerate with <code>python scripts/run_benchmark.py</code>. Generated ${esc(data.generated.slice(0, 10))}.</li>
        </ul>
      </details>
    </section>`;
}
