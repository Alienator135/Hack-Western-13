// Small SVG charts matching the QuakeTrace draft.

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (value, digits = 1) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

function niceStep(span, target) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
}

export function waveformChart(wave, { shiftS = null } = {}) {
  const W = 520, H = 140, top = 18, bottom = 112;
  const x0 = 0, x1 = 30;
  const x = (t) => ((t - x0) / (x1 - x0)) * W;
  const mid = (top + bottom) / 2;
  const amp = (bottom - top) / 2 / wave.peak;
  const points = wave.trace.filter(([t]) => t >= x0 && t <= x1).map(([t, v]) => `${x(t).toFixed(1)},${(mid - v * amp).toFixed(1)}`).join(" ");
  const pick = x(wave.pickS);
  const ticks = [0, 5, 10, 15, 20, 25, 30].map((t) => `<text x="${Math.min(W - 14, Math.max(6, x(t))).toFixed(0)}" y="136">${t}${t === 30 ? " s" : ""}</text>`).join("");
  const shifted = shiftS ? `<line x1="${x(wave.pickS + shiftS).toFixed(1)}" y1="${top}" x2="${x(wave.pickS + shiftS).toFixed(1)}" y2="${bottom}" stroke="#E8590C" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${(x(wave.pickS + shiftS) + 6).toFixed(1)}" y="${bottom - 4}" font-family="Inter, sans-serif" font-size="11" fill="#B03F00">Tampered pick</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Waveform from station ${esc(wave.station)} with the Pg arrival marked at ${wave.pickS.toFixed(1)} seconds after origin">
    <line x1="${pick.toFixed(1)}" y1="${top}" x2="${pick.toFixed(1)}" y2="${bottom}" stroke="#1F6FEB" stroke-width="1.5" stroke-dasharray="4 3"/>
    <polyline fill="none" stroke="#4A5563" stroke-width="1" stroke-linejoin="round" points="${points}"/>
    <text x="${(pick + 6).toFixed(1)}" y="14" font-family="Inter, sans-serif" font-size="11" fill="#0B57D0">Pg arrival (USGS pick)</text>
    ${shifted}
    <line x1="0" y1="122" x2="${W}" y2="122" stroke="#E3E6EB"/>
    <g font-family="JetBrains Mono, monospace" font-size="10" fill="#5B6573" text-anchor="middle">${ticks}</g>
  </svg>`;
}

/**
 * Arrival time vs distance. points: [{station, short, distanceKm, timeS, predictedS}]
 */
export function travelTimeChart(points, { suspect = null, speed = 6 } = {}) {
  const W = 640, H = 320, L = 60, R = 600, T = 30, B = 260;
  const maxT = Math.max(30, Math.ceil(Math.max(...points.map((p) => Math.max(p.timeS, p.predictedS))) / 5) * 5 + 2);
  const maxD = Math.max(150, Math.ceil(Math.max(...points.map((p) => p.distanceKm)) / 50) * 50);
  const x = (t) => L + (t / maxT) * (R - L);
  const y = (d) => B - (d / maxD) * (B - T);
  const tStep = niceStep(maxT, 6);
  const dStep = niceStep(maxD, 4);
  const grid = [];
  const yLabels = [];
  for (let d = 0; d <= maxD + 0.01; d += dStep) {
    grid.push(`<line x1="${L}" y1="${y(d)}" x2="${R}" y2="${y(d)}"/>`);
    yLabels.push(`<text x="${L - 8}" y="${y(d) + 4}" text-anchor="end">${d}</text>`);
  }
  const xLabels = [];
  for (let t = 0; t <= maxT + 0.01; t += tStep) xLabels.push(`<text x="${x(t)}" y="280">${t}</text>`);
  // Expected line: t = sqrt(d² + depth²) / v; nearly straight, draw as polyline.
  const line = [];
  for (let d = 0; d <= maxD; d += maxD / 40) line.push(`${x(d / speed).toFixed(1)},${y(d).toFixed(1)}`);
  const dots = [];
  let suspectMarkup = "";
  for (const p of points) {
    if (suspect && p.station === suspect) {
      const px = x(p.timeS), py = y(p.distanceKm), ex = x(p.predictedS);
      const late = p.timeS >= p.predictedS;
      const gap = p.timeS - p.predictedS;
      const tx = late ? px + 14 : px - 14;
      suspectMarkup = `
        <circle cx="${ex.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="#FFFFFF" stroke="#E8590C" stroke-width="1.5" stroke-dasharray="2 2"/>
        <line x1="${(ex + (late ? 7 : -7)).toFixed(1)}" y1="${py.toFixed(1)}" x2="${(px + (late ? -8 : 8)).toFixed(1)}" y2="${py.toFixed(1)}" stroke="#E8590C" stroke-width="2"/>
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="8" fill="#E8590C" stroke="#FFFFFF" stroke-width="2"><title>${esc(p.station)} ${p.timeS.toFixed(2)} s</title></circle>
        <text x="${tx.toFixed(1)}" y="${(py + 5).toFixed(1)}" text-anchor="${late ? "start" : "end"}" font-family="JetBrains Mono, monospace" font-size="14" font-weight="500" fill="#B03F00" stroke="#FFFFFF" stroke-width="3" style="paint-order: stroke">${esc(p.short)} ${fmt(gap, 2)} s</text>
        <text x="${ex.toFixed(1)}" y="${(py + 26).toFixed(1)}" font-family="Inter, sans-serif" font-size="11" fill="#8A4A1E" text-anchor="middle">should be here</text>`;
    } else {
      dots.push(`<circle cx="${x(p.timeS).toFixed(1)}" cy="${y(p.distanceKm).toFixed(1)}" r="6"><title>${esc(p.station)} · ${p.distanceKm.toFixed(1)} km · ${p.timeS.toFixed(2)} s</title></circle>`);
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Arrival time against distance for each station, with the expected ${speed} km per second line">
    <g stroke="#EEF1F4" stroke-width="1">${grid.join("")}</g>
    <line x1="${L}" y1="${T}" x2="${L}" y2="${B}" stroke="#D0D5DC"/>
    <line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="#D0D5DC"/>
    <g font-family="JetBrains Mono, monospace" font-size="11" fill="#5B6573">${yLabels.join("")}</g>
    <text x="${L}" y="20" font-family="Inter, sans-serif" font-size="12" fill="#5B6573">Distance (km)</text>
    <g font-family="JetBrains Mono, monospace" font-size="11" fill="#5B6573" text-anchor="middle">${xLabels.join("")}</g>
    <text x="${(L + R) / 2}" y="304" font-family="Inter, sans-serif" font-size="12" fill="#5B6573" text-anchor="middle">Seconds after the quake started</text>
    <polyline points="${line.join(" ")}" fill="none" stroke="#1F6FEB" stroke-width="2" stroke-dasharray="7 5" opacity="0.6"/>
    <text x="${R - 4}" y="${T + 6}" font-family="Inter, sans-serif" font-size="12" font-weight="500" fill="#0B57D0" text-anchor="end">Expected at ${speed} km/s</text>
    <g fill="#4A5563">${dots.join("")}</g>
    ${suspectMarkup}
  </svg>`;
}

/** Deviation over events with the ±threshold band. */
export function timelineChart(events, deviations, { threshold = 1.5, station = "", highlight = [] } = {}) {
  const W = 640, H = 220, L = 48, R = 620, T = 20, B = 170;
  const values = deviations.filter((v) => v !== null);
  const lim = Math.max(threshold * 2, Math.ceil(Math.max(...values.map(Math.abs), 0) + 0.5));
  const x = (i) => L + (i / (events.length - 1)) * (R - L);
  const y = (v) => T + ((lim - v) / (2 * lim)) * (B - T);
  const pts = deviations.map((v, i) => (v === null ? null : [x(i), y(v)]));
  const path = pts.filter(Boolean).map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
  const ticks = [];
  for (let v = -lim; v <= lim + 0.01; v += lim / 2) ticks.push(`<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v, 1).replace("+0.0", "0").replace("−0.0", "0")}</text>`);
  const dots = pts.map((p, i) => {
    if (!p) return "";
    const off = Math.abs(deviations[i]) >= threshold;
    const hot = highlight.includes(events[i].id);
    return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${hot ? 7 : 5}" fill="${off ? "#C2410C" : "#4A5563"}" stroke="#FFFFFF" stroke-width="2"><title>${esc(events[i].label)} · ${fmt(deviations[i], 2)} s</title></circle>`;
  }).join("");
  const labels = events.map((e, i) => `<text x="${x(i).toFixed(1)}" y="${B + 20}" text-anchor="middle" ${highlight[0] === e.id ? 'fill="#B03F00" font-weight="600"' : ""}>${esc(e.label)}</text>`).join("");
  const baselineEnd = events.findIndex((e) => e.role !== "baseline");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:720px;height:auto;display:block" role="img" aria-label="${esc(station)} deviation from its normal across seven earthquakes">
    <rect x="${L}" y="${y(threshold)}" width="${R - L}" height="${y(-threshold) - y(threshold)}" fill="#F3F5F8"/>
    ${baselineEnd > 0 ? `<rect x="${L - 10}" y="${T}" width="${x(baselineEnd - 1) - L + 20}" height="${B - T}" fill="#E8F0FE" opacity="0.55"/><text x="${L - 4}" y="${T - 6}" font-family="Inter, sans-serif" font-size="11" fill="#0B57D0">Baseline</text>` : ""}
    <line x1="${L}" y1="${y(0)}" x2="${R}" y2="${y(0)}" stroke="#D0D5DC"/>
    <line x1="${L}" y1="${y(threshold)}" x2="${R}" y2="${y(threshold)}" stroke="#E8590C" stroke-dasharray="4 4" opacity="0.6"/>
    <line x1="${L}" y1="${y(-threshold)}" x2="${R}" y2="${y(-threshold)}" stroke="#E8590C" stroke-dasharray="4 4" opacity="0.6"/>
    <g font-family="JetBrains Mono, monospace" font-size="11" fill="#5B6573">${ticks.join("")}</g>
    <path d="${path}" fill="none" stroke="#8A94A3" stroke-width="1.5"/>
    ${dots}
    <g font-family="Inter, sans-serif" font-size="11" fill="#5B6573">${labels}</g>
    <text x="${R}" y="${T - 6}" font-family="Inter, sans-serif" font-size="11" fill="#5B6573" text-anchor="end">seconds off · band = ±${threshold} s</text>
  </svg>`;
}
