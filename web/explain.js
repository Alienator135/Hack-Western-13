// Explain mode: a presenter walkthrough of how QuakeTrace finds a lying clock.
// Each step has one sentence to say and one animation on the canvas.

import { ease, gridGeometry, haloText, heatImage, makeProjection, misfitColor, star, triangle } from "./lab.js";

const W = 800;
const MAP_H = 450;
const PANEL_Y = 462;
const H = 640;

// Local plane used by quaketrace/replay.py (project()).
const LAT0 = 40.8;
const LON0 = -74.65;
const KM_PER_DEG = 111.195;
const KM_PER_LON = KM_PER_DEG * Math.cos(LAT0 * Math.PI / 180);
const planeKm = (lat, lon) => [(lon - LON0) * KM_PER_LON, (lat - LAT0) * KM_PER_DEG];

const fmt = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const stagger = (t, i, n, span = 0.7) => clamp01((t - (i / Math.max(1, n)) * span) / (1 - span));

// ---------------------------------------------------------------- derived data

export function deriveStory({ lab, labEx, runs, replay }) {
  const { speedKmS: speed, depthKm: depth } = lab.model;
  const travel = (p, s) => {
    const [x, y] = planeKm(p.lat, p.lon);
    const [sx, sy] = planeKm(s.lat, s.lon);
    return { km: Math.hypot(x - sx, y - sy), tt: Math.sqrt((x - sx) ** 2 + (y - sy) ** 2 + depth ** 2) / speed };
  };
  const stations = [...lab.stations].sort((a, b) => a.predictedS - b.predictedS);
  const tRef = Math.min(...stations.map((s) => s.pickS));

  // A deliberately wrong candidate: a grid cell 20–45 km from the answer with a ~4 s score.
  const cols = lab.coarse.lons.length;
  let candidate = null;
  lab.coarse.rms.forEach((rms, i) => {
    const p = { lat: lab.coarse.lats[Math.floor(i / cols)], lon: lab.coarse.lons[i % cols] };
    const [x, y] = planeKm(p.lat, p.lon);
    const [fx, fy] = planeKm(lab.fit.lat, lab.fit.lon);
    const dist = Math.hypot(x - fx, y - fy);
    if (dist < 20 || dist > 45) return;
    const score = Math.abs(rms - 4);
    if (!candidate || score < candidate.score) candidate = { ...p, rms, index: i, score };
  });

  const rowsAt = (point, origins) => stations.map((s, i) => {
    const pick = s.pickS - tRef;
    const origin = origins ? origins[i] : pick - travel(point, s).tt;
    return { id: s.id, short: s.short, pick, origin, tt: pick - origin, km: point ? travel(point, s).km : s.epicentralKm, excluded: s.excluded };
  });
  const score = (rows) => {
    const used = rows.filter((r) => !r.excluded);
    const mean = used.reduce((a, r) => a + r.origin, 0) / used.length;
    return { mean, rms: Math.sqrt(used.reduce((a, r) => a + (r.origin - mean) ** 2, 0) / used.length) };
  };

  const candRows = rowsAt(candidate);
  if (candidate && Math.abs(score(candRows).rms - candidate.rms) > 0.02) {
    console.warn("Explain score differs from solver grid", score(candRows).rms, candidate.rms);
  }
  const nearest = candRows.reduce((a, r) => (r.km < a.km ? r : a));
  const bestRows = rowsAt(null, stations.map((s) => s.pickS - s.predictedS - tRef));
  const exStations = [...labEx.stations].sort((a, b) => a.predictedS - b.predictedS);
  const exRef = Math.min(...exStations.map((s) => s.pickS));
  const exRows = exStations.map((s) => ({ id: s.id, short: s.short, pick: s.pickS - exRef, origin: s.pickS - s.predictedS - exRef, excluded: s.excluded }));

  return {
    lab, labEx, runs, replay, stations, tRef, candidate, candRows, nearest,
    candScore: score(candRows), bestRows, bestScore: score(bestRows), exRows, exScore: score(exRows),
    culprit: replay.candidate, scenario: replay.scenario, speed, depth,
    runOrder: stations.map((s) => runs.runs.find((r) => r.station === s.id)).filter(Boolean),
  };
}

// ---------------------------------------------------------------- script

export function buildSteps(d) {
  const ev = d.lab.event;
  const n = d.stations.length;
  const c = d.culprit;
  const cs = c ? c.station.split(".").pop() : null;
  const near = d.nearest;
  return [
    {
      key: "stations", ms: 2200,
      say: `These ${n} seismometers recorded the ${ev.magnitude ? `M${ev.magnitude} ` : ""}quake. Each one timestamps the moment the first wave reached it.`,
      note: "Times are seconds after the first station's reading. One of these clocks may now be lying.",
    },
    {
      key: "candidate", ms: 1300,
      say: "We don't know where the quake started, so we test candidate points. Here's one.",
      note: "This point is deliberately wrong so you can see what a bad guess looks like.",
    },
    {
      key: "distance", ms: 1500,
      say: `Measure the distance from this point to a station: ${near.km.toFixed(1)} km to ${near.short}.`,
      note: "Straight-line distance, plus the quake's 5 km depth.",
    },
    {
      key: "travel", ms: 2300,
      say: `P waves travel about ${d.speed} km/s, so the wave needs ${near.tt.toFixed(1)} s to reach ${near.short}.`,
      note: `${near.short} recorded it at ${near.pick.toFixed(1)} s, so from this station's view the quake started at ${near.origin.toFixed(1)} s.`,
    },
    {
      key: "all", ms: 2700,
      say: `Do the same for all ${n} stations: distance, travel time, and when each one says the quake started.`,
      note: "Each bar runs back from a station's recorded time by its travel time.",
    },
    {
      key: "origins", ms: 1500,
      say: "If this point were right, every bar would end at the same moment.",
      note: "They don't. Each station points to a different start time.",
    },
    {
      key: "score", ms: 1900,
      say: `The spread of those start times is the point's score: ${d.candScore.rms.toFixed(2)} s. Lower means the stations agree.`,
      note: "Formally: the RMS distance of each start time from their average.",
    },
    {
      key: "sweep", ms: 4800,
      say: `Now score every point on a 2 km grid: ${d.lab.coarse.rms.length.toLocaleString()} candidates. Dark teal means the stations agree.`,
      note: "This is exactly the grid QuakeTrace's solver searches.",
    },
    {
      key: "refine", ms: 2700,
      say: `Zoom in on the best area and repeat on a 250 m grid: ${d.lab.fine.rms.length} more points.`,
      note: `${d.lab.pointsTested.toLocaleString()} candidate epicentres tested in total.`,
    },
    {
      key: "best", ms: 1900,
      say: d.bestScore.rms > 1
        ? `The best point still scores ${d.lab.fit.rmsS.toFixed(2)} s and lands ${d.lab.usgsKm.toFixed(1)} km from the official USGS epicentre. Something doesn't fit.`
        : `The best point scores ${d.lab.fit.rmsS.toFixed(2)} s, ${d.lab.usgsKm.toFixed(1)} km from the official USGS epicentre. The stations agree.`,
      note: "Look at the bars: one station disagrees with the rest.",
    },
    {
      key: "loo", ms: 5600,
      say: `Is one clock lying? Leave each station out in turn and rerun the whole search: ${n} more searches.`,
      note: "If removing one station makes everyone else agree, that station is the suspect.",
    },
    {
      key: "culprit", ms: 2100,
      say: c
        ? `Without ${cs}, the other ${n - 1} agree to ${d.labEx.fit.rmsS.toFixed(2)} s and the epicentre lands ${d.labEx.usgsKm.toFixed(1)} km from USGS. ${cs}'s clock is off by ${fmt(c.offsetS, 2)} s.`
        : "No single station stands out. Leaving any one out does not make the rest agree, so QuakeTrace does not accuse anyone.",
      note: c ? "Next: reveal what the judge changed." : "Next: reveal what the judge changed.",
    },
  ];
}

// ---------------------------------------------------------------- stage

export class ExplainStage {
  constructor(container, overview) {
    this.overview = overview;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "explain-canvas";
    this.canvas.setAttribute("role", "img");
    container.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.step = -1;
    this.t = 1;
    this.raf = null;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas);
  }

  destroy() { cancelAnimationFrame(this.raf); this.observer.disconnect(); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.width * dpr * H / W);
    this.scale = this.canvas.width / W;
    this.draw();
  }

  setStations(lab) {
    // Map only (step 0, before the judge locks in).
    this.prepareMap(lab);
    this.d = null;
    this.step = -1;
    this.draw();
  }

  prepareMap(lab) {
    const points = [
      [lab.region.south, lab.region.west], [lab.region.north, lab.region.east],
      ...lab.stations.map((s) => [s.lat, s.lon]),
    ];
    this.P = makeProjection(points, { w: W, h: MAP_H, pad: 0.05 });
    this.land = new Path2D();
    for (const feature of this.overview.outlines.features || []) {
      const g = feature.geometry;
      for (const polygon of g.type === "Polygon" ? [g.coordinates] : g.coordinates) {
        for (const ring of polygon) {
          ring.forEach(([lon, lat], i) => { const [x, y] = this.P(lat, lon); this.land[i ? "lineTo" : "moveTo"](x, y); });
          this.land.closePath();
        }
      }
    }
    this.mapLab = lab;
  }

  setStory(d, steps) {
    this.d = d;
    this.steps = steps;
    this.prepareMap(d.lab);
    this.coarseHeat = heatImage(d.lab.coarse, 235);
    const fmin = Math.min(...d.lab.fine.rms), fmax = Math.max(...d.lab.fine.rms);
    this.fineHeat = heatImage(d.lab.fine, 255, (rms) => 0.6 * (rms - fmin) / Math.max(1e-6, fmax - fmin));
    this.exHeat = heatImage(d.labEx.coarse, 235);
    this.runHeats = new Map(d.runs.runs.map((run) => [run.station, heatImage({ lats: d.runs.lats, lons: d.runs.lons, rms: run.rms }, 235)]));
    [this.coarseHeat, this.exHeat, ...this.runHeats.values()].forEach((h) => h.ctx.putImageData(h.data, 0, 0));
  }

  show(step, { animate = true } = {}) {
    cancelAnimationFrame(this.raf);
    this.step = step;
    const ms = this.steps?.[step]?.ms || 1;
    if (!animate) { this.t = 1; this.draw(); return; }
    const start = performance.now();
    const frame = (now) => {
      this.t = clamp01((now - start) / ms);
      this.draw();
      if (this.t < 1) this.raf = requestAnimationFrame(frame);
    };
    this.t = 0;
    this.raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------ drawing

  draw() {
    const ctx = this.ctx;
    if (!this.scale || !this.mapLab) return;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Map
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, MAP_H);
    ctx.clip();
    ctx.fillStyle = "#DCE9F3";
    ctx.fillRect(0, 0, W, MAP_H);
    ctx.fillStyle = "#F1F3EE";
    ctx.fill(this.land, "evenodd");
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#B5BCC5";
    ctx.lineWidth = 1;
    ctx.stroke(this.land);
    ctx.setLineDash([]);
    const key = this.step >= 0 && this.steps ? this.steps[this.step].key : "judge";
    const t = this.t;
    this[`map_${key}`]?.(ctx, t);
    ctx.restore();
    // Panel
    ctx.fillStyle = "#F6F7F9";
    ctx.fillRect(0, PANEL_Y - 6, W, H - PANEL_Y + 6);
    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "#E3E6EB";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect?.(0.5, PANEL_Y + 0.5, W - 1, H - PANEL_Y - 1, 8);
    ctx.fill();
    ctx.stroke();
    this[`panel_${key}`]?.(ctx, t);
  }

  // ------------------------------------------------ map primitives

  stationsLayer(ctx, { appear = 1, highlight = null, out = null, labels = "short", dim = false } = {}) {
    const list = this.d ? this.d.stations : this.mapLab.stations;
    list.forEach((s, i) => {
      const a = this.d ? stagger(appear, i, list.length) : 1;
      if (a <= 0) return;
      const [x, y] = this.P(s.lat, s.lon);
      ctx.save();
      ctx.globalAlpha = (dim ? 0.55 : 1) * a;
      const isOut = out === s.id;
      triangle(ctx, x, y, 8 * (0.6 + 0.4 * ease(a)), isOut ? "#B5BCC5" : s.id === highlight ? "#E8590C" : "#4A5563");
      if (isOut) {
        ctx.strokeStyle = "#E8590C";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x - 10, y - 10); ctx.lineTo(x + 10, y + 10);
        ctx.moveTo(x + 10, y - 10); ctx.lineTo(x - 10, y + 10);
        ctx.stroke();
      }
      let label = s.short;
      if (labels === "times" && this.d) label = `${s.short}  ${(s.pickS - this.d.tRef).toFixed(1)} s`;
      haloText(ctx, label, x + 12, y + 5, { color: isOut || s.id === highlight ? "#B03F00" : "#2B323C", font: `${isOut || s.id === highlight ? 600 : 500} 12px 'JetBrains Mono', monospace` });
      ctx.restore();
    });
  }

  pointMark(ctx, p, { label = "", color = "#1F6FEB", r = 9, labelSide = 1, a = 1 } = {}) {
    const [x, y] = this.P(p.lat, p.lon);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (label) haloText(ctx, label, x + labelSide * (r + 6), y - r - 2, { font: "600 13px Inter, sans-serif", color, align: labelSide > 0 ? "left" : "right" });
    ctx.restore();
  }

  usgs(ctx, a = 1) {
    const ev = this.d.lab.event;
    const [x, y] = this.P(ev.lat, ev.lon);
    ctx.save();
    ctx.globalAlpha = a;
    star(ctx, x, y, 9);
    haloText(ctx, "USGS", x + 12, y + 16, { font: "600 11px Inter, sans-serif", color: "#14181F" });
    ctx.restore();
  }

  line(ctx, a, b, { t = 1, color = "#1F6FEB", width = 2, dash = null, label = "", labelColor = color } = {}) {
    const [x0, y0] = this.P(a.lat, a.lon);
    const [x1, y1] = this.P(b.lat, b.lon);
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
    if (label && t >= 1) {
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      haloText(ctx, label, (x0 + x1) / 2 + nx * 12, (y0 + y1) / 2 + ny * 12 + 4, { font: "600 12px 'JetBrains Mono', monospace", color: labelColor, align: "center" });
    }
    return [x, y];
  }

  // Zoomed callout in the top-left corner around a few close points.
  magnifier(ctx, points, grow, draw) {
    const bw = 330, bh = 230, bx = 16, by = 16;
    const lat = points.reduce((a, p) => a + p.lat, 0) / points.length;
    const lon = points.reduce((a, p) => a + p.lon, 0) / points.length;
    const local = makeProjection([...points.map((p) => [p.lat, p.lon]), [lat - 0.035, lon - 0.045], [lat + 0.035, lon + 0.045]], { w: bw, h: bh, pad: 0.22 });
    const [nLat, wLon] = local.unproject(0, 0);
    const [sLat, eLon] = local.unproject(bw, bh);
    const [ax0, ay0] = this.P(nLat, wLon);
    const [ax1, ay1] = this.P(sLat, eLon);
    const a = ease(grow);
    const x = ax0 + (bx - ax0) * a, y = ay0 + (by - ay0) * a;
    const w = (ax1 - ax0) + (bw - (ax1 - ax0)) * a, h = (ay1 - ay0) + (bh - (ay1 - ay0)) * a;
    ctx.save();
    ctx.strokeStyle = "#1F6FEB";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
    ctx.beginPath();
    ctx.moveTo(ax0, ay0); ctx.lineTo(x + w, y);
    ctx.moveTo(ax0, ay1); ctx.lineTo(x + w, y + h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#FFFFFF";
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 10;
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = "#F1F3EE";
    ctx.fillRect(x, y, w, h);
    if (a >= 1) {
      const main = this.P;
      this.P = (la, lo) => { const [px, py] = local(la, lo); return [px + bx, py + by]; };
      try { draw(); } finally { this.P = main; }
    }
    ctx.restore();
    ctx.strokeStyle = "#1F6FEB";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    if (a >= 1) haloText(ctx, "zoomed in", x + w - 8, y + h - 8, { font: "500 10px Inter, sans-serif", color: "#5B6573", align: "right" });
  }

  regionRect(pass) {
    const g = gridGeometry(pass);
    const [x0, y0] = this.P(g.north, g.west);
    const [x1, y1] = this.P(g.south, g.east);
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  heat(ctx, heat, pass, alpha = 1) {
    const r = this.regionRect(pass);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(heat.canvas, r.x0, r.y0, r.w, r.h);
    ctx.restore();
  }

  cellBox(ctx, p, pass, color) {
    const g = gridGeometry(pass);
    const [x0, y0] = this.P(p.lat + g.dLat / 2, p.lon - g.dLon / 2);
    const [x1, y1] = this.P(p.lat - g.dLat / 2, p.lon + g.dLon / 2);
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = "#14181F";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }

  // ------------------------------------------------ panel primitives

  panelTitle(ctx, text, right = "") {
    haloText(ctx, text, 16, PANEL_Y + 22, { font: "600 13px Inter, sans-serif", color: "#2B323C" });
    if (right) haloText(ctx, right, W - 16, PANEL_Y + 22, { font: "500 12px Inter, sans-serif", color: "#5B6573", align: "right" });
  }

  // One row per station: recorded time (dot) and a bar back to the implied start time.
  gantt(ctx, rows, { range, dots = 1, bars = () => 0, origins = 0, mean = null, meanT = 0, highlight = null, title = "", right = "" }) {
    this.panelTitle(ctx, title, right);
    const top = PANEL_Y + 36, bottom = H - 26, left = 70, rightX = W - 24;
    const rowH = (bottom - top) / rows.length;
    const [t0, t1] = range;
    const X = (v) => left + ((v - t0) / (t1 - t0)) * (rightX - left);
    // Axis
    ctx.save();
    ctx.strokeStyle = "#E3E6EB";
    ctx.lineWidth = 1;
    const step = (t1 - t0) > 40 ? 10 : 5;
    for (let v = Math.ceil(t0 / step) * step; v <= t1; v += step) {
      ctx.beginPath();
      ctx.moveTo(X(v), top - 4);
      ctx.lineTo(X(v), bottom);
      ctx.stroke();
      haloText(ctx, `${v}`, X(v), H - 10, { font: "400 10px 'JetBrains Mono', monospace", color: "#8A94A3", align: "center" });
    }
    haloText(ctx, "seconds", rightX, H - 10, { font: "400 10px Inter, sans-serif", color: "#8A94A3", align: "right" });
    if (mean !== null && meanT > 0) {
      ctx.strokeStyle = "#1F6FEB";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(mean), top - 6);
      ctx.lineTo(X(mean), top - 6 + (bottom - top + 6) * meanT);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    rows.forEach((r, i) => {
      const y = top + rowH * (i + 0.5);
      const hot = r.id === highlight;
      haloText(ctx, r.short, 14, y + 4, { font: `${hot ? 600 : 400} 11px 'JetBrains Mono', monospace`, color: hot ? "#B03F00" : r.excluded ? "#B5BCC5" : "#2B323C" });
      const a = stagger(dots, i, rows.length, 0.6);
      if (a <= 0) return;
      ctx.globalAlpha = r.excluded && !hot ? 0.35 : 1;
      // Bar from pick back to origin
      const b = bars(i);
      if (b > 0) {
        const x0 = X(r.pick), x1 = X(r.pick - (r.pick - r.origin) * ease(b));
        ctx.strokeStyle = hot ? "#E8590C" : "#9DBDF5";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        if (b >= 1) {
          const gap = mean !== null ? r.origin - mean : 0;
          const off = (hot || !r.excluded) && mean !== null && Math.abs(gap) >= 1;
          ctx.fillStyle = off ? "#E8590C" : "#1F6FEB";
          const size = origins > 0 ? 4 + 2 * origins : 4;
          ctx.fillRect(x1 - size / 2, y - size, size, size * 2);
          if (mean !== null && meanT >= 1 && (hot || !r.excluded) && Math.abs(gap) >= 0.3) {
            ctx.strokeStyle = off ? "#E8590C" : "#8A94A3";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(X(mean), y);
            ctx.stroke();
            if (off) haloText(ctx, `${fmt(gap)} s`, Math.max(x1, X(mean)) + 6, y + 4, { font: "600 10px 'JetBrains Mono', monospace", color: "#B03F00" });
          }
        }
      }
      // Recorded time
      ctx.beginPath();
      ctx.arc(X(r.pick), y, 4 * ease(a), 0, Math.PI * 2);
      ctx.fillStyle = "#4A5563";
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    ctx.restore();
    return X;
  }

  candRange() {
    const rows = this.d.candRows;
    return [Math.floor(Math.min(...rows.map((r) => r.origin)) - 2), Math.ceil(Math.max(...rows.map((r) => r.pick)) + 2)];
  }

  rowsRange(rows) {
    return [Math.floor(Math.min(...rows.map((r) => r.origin)) - 2), Math.ceil(Math.max(...rows.map((r) => r.pick)) + 2)];
  }

  // ------------------------------------------------ steps: map

  map_judge(ctx) { this.stationsLayer(ctx); }

  map_stations(ctx, t) { this.stationsLayer(ctx, { appear: t, labels: "times" }); }

  map_candidate(ctx, t) {
    this.stationsLayer(ctx);
    const [x, y] = this.P(this.d.candidate.lat, this.d.candidate.lon);
    if (t < 1) {
      ctx.beginPath();
      ctx.arc(x, y, 9 + 40 * (1 - ease(t)), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(31,111,235,${(1 - t) * 0.6})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    this.pointMark(ctx, this.d.candidate, { label: "candidate point", a: ease(t) });
  }

  map_distance(ctx, t) {
    const d = this.d;
    this.stationsLayer(ctx, { highlight: d.nearest.id });
    const s = d.stations.find((st) => st.id === d.nearest.id);
    this.line(ctx, d.candidate, s, { t: ease(t), label: `${d.nearest.km.toFixed(1)} km` });
    this.pointMark(ctx, d.candidate, { label: "candidate point" });
  }

  map_travel(ctx, t) {
    const d = this.d;
    this.stationsLayer(ctx, { highlight: d.nearest.id });
    const s = d.stations.find((st) => st.id === d.nearest.id);
    this.line(ctx, d.candidate, s, { color: "#9DBDF5", label: `${d.nearest.km.toFixed(1)} km ÷ ${d.speed} km/s = ${d.nearest.tt.toFixed(1)} s`, labelColor: "#0B57D0" });
    const pulse = clamp01(t / 0.75);
    const [x0, y0] = this.P(d.candidate.lat, d.candidate.lon);
    const [x1, y1] = this.P(s.lat, s.lon);
    const px = x0 + (x1 - x0) * pulse, py = y0 + (y1 - y0) * pulse;
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#1F6FEB";
    ctx.fill();
    haloText(ctx, `${(d.nearest.tt * pulse).toFixed(1)} s`, px + 10, py - 10, { font: "600 12px 'JetBrains Mono', monospace", color: "#0B57D0" });
    this.pointMark(ctx, d.candidate);
  }

  map_all(ctx, t) {
    const d = this.d;
    this.stationsLayer(ctx);
    d.stations.forEach((s, i) => {
      const row = d.candRows[i];
      const a = stagger(t, i, d.stations.length);
      if (a > 0) this.line(ctx, d.candidate, s, { t: ease(a), color: "#9DBDF5", width: 1.5, label: a >= 1 ? `${row.tt.toFixed(1)} s` : "", labelColor: "#0B57D0" });
    });
    this.pointMark(ctx, d.candidate);
  }

  map_origins(ctx) {
    const d = this.d;
    this.stationsLayer(ctx);
    d.stations.forEach((s) => this.line(ctx, d.candidate, s, { color: "rgba(157,189,245,0.5)", width: 1.2 }));
    this.pointMark(ctx, d.candidate);
  }

  map_score(ctx, t) {
    const d = this.d;
    this.stationsLayer(ctx);
    d.stations.forEach((s) => this.line(ctx, d.candidate, s, { color: "rgba(157,189,245,0.35)", width: 1 }));
    const [r, g, b] = misfitColor(d.candScore.rms);
    ctx.save();
    ctx.globalAlpha = ease(t);
    this.cellBox(ctx, d.candidate, d.lab.coarse, `rgb(${r},${g},${b})`);
    ctx.restore();
    const [x, y] = this.P(d.candidate.lat, d.candidate.lon);
    haloText(ctx, `score ${d.candScore.rms.toFixed(2)} s`, x + 14, y - 10, { font: "700 15px 'JetBrains Mono', monospace", color: "#14181F" });
  }

  map_sweep(ctx, t) {
    const d = this.d;
    const pass = d.lab.coarse;
    const heat = this.coarseHeat;
    const g = heat.g;
    const total = pass.rms.length;
    const done = Math.floor(total * t);
    // Progressive reveal of tested cells.
    const tmp = this.sweepCanvas ||= document.createElement("canvas");
    tmp.width = g.cols; tmp.height = g.rows;
    const tctx = tmp.getContext("2d");
    const rows = Math.floor(done / g.cols), partial = done % g.cols;
    if (rows) tctx.putImageData(heat.data, 0, 0, 0, g.rows - rows, g.cols, rows);
    if (partial) tctx.putImageData(heat.data, 0, 0, 0, g.rows - rows - 1, partial, 1);
    const r = this.regionRect(pass);
    ctx.save();
    ctx.imageSmoothingEnabled = t >= 1;
    ctx.drawImage(tmp, r.x0, r.y0, r.w, r.h);
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "#8A94A3";
    ctx.strokeRect(r.x0, r.y0, r.w, r.h);
    ctx.restore();
    if (done < total) {
      const row = Math.floor(done / g.cols), col = done % g.cols;
      const cw = r.w / g.cols, ch = r.h / g.rows;
      ctx.strokeStyle = "#1F6FEB";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x0 + col * cw - 1, r.y0 + (g.rows - 1 - row) * ch - 1, cw + 2, ch + 2);
    }
    this.stationsLayer(ctx, { dim: true });
    // Best so far
    let best = Infinity, bi = -1;
    for (let i = 0; i < done; i += 1) if (pass.rms[i] < best) { best = pass.rms[i]; bi = i; }
    this.sweepBest = { index: bi, rms: best, done, total };
    if (bi >= 0) {
      const p = { lat: pass.lats[Math.floor(bi / g.cols)], lon: pass.lons[bi % g.cols] };
      const [x, y] = this.P(p.lat, p.lon);
      ctx.save();
      ctx.strokeStyle = "#1F6FEB";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y);
      ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14);
      ctx.stroke();
      ctx.restore();
    }
  }

  map_refine(ctx, t) {
    const d = this.d;
    this.heat(ctx, this.coarseHeat, d.lab.coarse);
    this.stationsLayer(ctx, { dim: true });
    const fine = d.lab.fine;
    const g = gridGeometry(fine);
    const [fx0, fy0] = this.P(g.north, g.west);
    const [fx1, fy1] = this.P(g.south, g.east);
    const grow = ease(clamp01(t / 0.3));
    const size = 210, ix = 16, iy = 16;
    const bx = fx0 + (ix - fx0) * grow, by = fy0 + (iy - fy0) * grow;
    const bw = (fx1 - fx0) + (size - (fx1 - fx0)) * grow, bh = (fy1 - fy0) + (size - (fy1 - fy0)) * grow;
    ctx.save();
    ctx.strokeStyle = "#1F6FEB";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(fx0, fy0); ctx.lineTo(bx + bw, by);
    ctx.moveTo(fx0, fy1); ctx.lineTo(bx + bw, by + bh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeRect(fx0, fy0, fx1 - fx0, fy1 - fy0);
    ctx.fillStyle = "#FFFFFF";
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 10;
    ctx.fillRect(bx - 4, by - 4, bw + 8, bh + 8);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#F1F3EE";
    ctx.fillRect(bx, by, bw, bh);
    const heat = this.fineHeat;
    const hg = heat.g;
    const done = Math.floor(fine.rms.length * clamp01((t - 0.3) / 0.7));
    heat.ctx.clearRect(0, 0, hg.cols, hg.rows);
    const rows = Math.floor(done / hg.cols), partial = done % hg.cols;
    if (rows) heat.ctx.putImageData(heat.data, 0, 0, 0, hg.rows - rows, hg.cols, rows);
    if (partial) heat.ctx.putImageData(heat.data, 0, 0, 0, hg.rows - rows - 1, partial, 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(heat.canvas, bx, by, bw, bh);
    ctx.strokeStyle = "#1F6FEB";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);
    if (grow >= 1) haloText(ctx, `250 m grid · ${done}/${fine.rms.length}`, bx, by + bh + 16, { font: "600 11px Inter, sans-serif", color: "#0B57D0" });
    ctx.restore();
    this.refineDone = done;
  }

  map_best(ctx, t) {
    const d = this.d;
    this.heat(ctx, this.coarseHeat, d.lab.coarse);
    this.stationsLayer(ctx);
    const fit = d.lab.fit;
    this.pointMark(ctx, fit, { r: 6 });
    this.magnifier(ctx, [fit, d.lab.event], clamp01(t / 0.4), () => {
      this.heat(ctx, this.coarseHeat, d.lab.coarse, 0.9);
      this.line(ctx, fit, d.lab.event, { t: ease(clamp01((t - 0.4) / 0.6)), color: "#E8590C", dash: [4, 3], width: 2.5, label: `${d.lab.usgsKm.toFixed(1)} km`, labelColor: "#B03F00" });
      this.usgs(ctx);
      this.pointMark(ctx, fit, { label: `best fit · ${fit.rmsS.toFixed(2)} s` });
    });
  }

  map_loo(ctx, t) {
    const d = this.d;
    const n = d.runOrder.length;
    const i = Math.min(n - 1, Math.floor(t * n));
    const run = d.runOrder[i];
    this.loo = { i, run };
    this.heat(ctx, this.runHeats.get(run.station), { lats: d.runs.lats, lons: d.runs.lons, rms: run.rms });
    this.stationsLayer(ctx, { out: run.station });
    this.pointMark(ctx, run.fit, { label: `${run.fit.rmsS.toFixed(2)} s`, labelSide: -1 });
    haloText(ctx, `Search ${i + 1} of ${n}: without ${run.short}`, 16, 26, { font: "600 14px Inter, sans-serif", color: "#14181F" });
  }

  map_culprit(ctx, t) {
    const d = this.d;
    this.heat(ctx, this.exHeat, d.labEx.coarse);
    const out = d.labEx.scenario.exclude;
    this.stationsLayer(ctx, { out });
    const fit = d.labEx.fit;
    this.pointMark(ctx, fit, { r: 6 });
    this.magnifier(ctx, [fit, d.lab.event, d.lab.fit], clamp01(t / 0.4), () => {
      this.heat(ctx, this.exHeat, d.labEx.coarse, 0.9);
      const [ox, oy] = this.P(d.lab.fit.lat, d.lab.fit.lon);
      ctx.beginPath();
      ctx.arc(ox, oy, 8, 0, Math.PI * 2);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#2B323C";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      haloText(ctx, "all stations", ox, oy + 22, { font: "600 11px Inter, sans-serif", color: "#2B323C", align: "center" });
      this.line(ctx, fit, d.lab.event, { t: ease(clamp01((t - 0.4) / 0.6)), color: "#1F6FEB", width: 2.5, label: `${d.labEx.usgsKm.toFixed(1)} km`, labelColor: "#0B57D0" });
      this.usgs(ctx);
      this.pointMark(ctx, fit, { label: `without ${d.labEx.scenario.exclude.split(".").pop()}`, labelSide: -1 });
    });
    if (d.culprit) {
      const s = d.stations.find((st) => st.id === d.culprit.station);
      const [x, y] = this.P(s.lat, s.lon);
      const r = 18 + 6 * Math.sin(t * Math.PI * 3);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "#E8590C";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
      haloText(ctx, `${s.short} ${fmt(d.culprit.offsetS, 2)} s`, x + 24, y + 26, { font: "700 15px 'JetBrains Mono', monospace", color: "#B03F00" });
    }
  }

  // ------------------------------------------------ steps: panel

  panel_judge(ctx) {
    this.panelTitle(ctx, "Waiting for the judge to change one station's clock…");
  }

  panel_stations(ctx, t) {
    this.gantt(ctx, this.d.candRows, { range: this.candRange(), dots: t, title: "When each station recorded the first wave" });
  }

  panel_candidate(ctx) {
    this.gantt(ctx, this.d.candRows, { range: this.candRange(), title: "When each station recorded the first wave" });
  }

  panel_distance(ctx) {
    this.gantt(ctx, this.d.candRows, { range: this.candRange(), highlight: this.d.nearest.id, title: "When each station recorded the first wave" });
  }

  panel_travel(ctx, t) {
    const d = this.d;
    const idx = d.candRows.findIndex((r) => r.id === d.nearest.id);
    const b = clamp01((t - 0.55) / 0.45);
    this.gantt(ctx, d.candRows, {
      range: this.candRange(), highlight: d.nearest.id, bars: (i) => (i === idx ? b : 0),
      title: "Recorded time minus travel time = when the quake started", right: b >= 1 ? `${d.nearest.short}: started at ${d.nearest.origin.toFixed(1)} s` : "",
    });
  }

  panel_all(ctx, t) {
    const n = this.d.candRows.length;
    this.gantt(ctx, this.d.candRows, { range: this.candRange(), bars: (i) => stagger(t, i, n), title: "Recorded time minus travel time = when the quake started" });
  }

  panel_origins(ctx, t) {
    this.gantt(ctx, this.d.candRows, { range: this.candRange(), bars: () => 1, origins: ease(t), title: "Where each bar ends: each station's start time", right: "they should line up" });
  }

  panel_score(ctx, t) {
    const d = this.d;
    this.gantt(ctx, d.candRows, {
      range: this.candRange(), bars: () => 1, origins: 1, mean: d.candScore.mean, meanT: ease(t),
      title: "Spread of the start times = this point's score", right: t >= 1 ? `score ${d.candScore.rms.toFixed(2)} s` : "",
    });
  }

  panel_sweep(ctx) {
    const b = this.sweepBest || { done: 0, total: this.d.lab.coarse.rms.length, rms: Infinity };
    this.counterPanel(ctx, "Coarse search · 2 km grid", b.done, b.total, b.rms);
  }

  panel_refine(ctx) {
    const d = this.d;
    const done = this.refineDone || 0;
    let best = Math.min(...d.lab.coarse.rms);
    for (let i = 0; i < done; i += 1) best = Math.min(best, d.lab.fine.rms[i]);
    this.counterPanel(ctx, "Fine search · 250 m grid", d.lab.coarse.rms.length + done, d.lab.pointsTested - 1, best);
  }

  counterPanel(ctx, title, done, total, best) {
    this.panelTitle(ctx, title);
    haloText(ctx, done.toLocaleString(), 16, PANEL_Y + 86, { font: "500 48px 'JetBrains Mono', monospace", color: "#14181F" });
    haloText(ctx, `of ${total.toLocaleString()} points scored`, 16, PANEL_Y + 110, { font: "400 13px Inter, sans-serif", color: "#5B6573" });
    haloText(ctx, Number.isFinite(best) ? `${best.toFixed(2)} s` : "—", W - 16, PANEL_Y + 86, { font: "500 40px 'JetBrains Mono', monospace", color: "#0B57D0", align: "right" });
    haloText(ctx, "best score so far", W - 16, PANEL_Y + 110, { font: "400 13px Inter, sans-serif", color: "#5B6573", align: "right" });
    const y = PANEL_Y + 134, x0 = 16, x1 = W - 16;
    ctx.fillStyle = "#F0F2F5";
    ctx.fillRect(x0, y, x1 - x0, 8);
    ctx.fillStyle = "#1F6FEB";
    ctx.fillRect(x0, y, (x1 - x0) * Math.min(1, done / total), 8);
  }

  panel_best(ctx, t) {
    const d = this.d;
    const worst = d.bestRows.reduce((a, r) => (Math.abs(r.origin - d.bestScore.mean) > Math.abs(a.origin - d.bestScore.mean) ? r : a));
    this.gantt(ctx, d.bestRows, {
      range: this.rowsRange(d.bestRows), bars: () => 1, origins: 1, mean: d.bestScore.mean, meanT: ease(t),
      highlight: Math.abs(worst.origin - d.bestScore.mean) >= 1 ? worst.id : null,
      title: "Start times at the best point", right: `score ${d.lab.fit.rmsS.toFixed(2)} s`,
    });
  }

  panel_loo(ctx, t) {
    const d = this.d;
    const n = d.runOrder.length;
    const shown = Math.min(n, Math.floor(t * n) + 1);
    this.panelTitle(ctx, "Score of each search with one station left out", `all ${n} together: ${d.lab.fit.rmsS.toFixed(2)} s`);
    const top = PANEL_Y + 40, bottom = H - 30, left = 24, right = W - 24;
    const max = Math.max(d.lab.fit.rmsS, ...d.runOrder.map((r) => r.fit.rmsS));
    const colW = (right - left) / n;
    const bestRun = d.runs.runs[0];
    d.runOrder.forEach((run, i) => {
      const x = left + colW * i + colW * 0.2, w = colW * 0.6;
      haloText(ctx, run.short, x + w / 2, H - 12, { font: "400 11px 'JetBrains Mono', monospace", color: "#2B323C", align: "center" });
      if (i >= shown) return;
      const grow = i === shown - 1 && t < 1 ? ease(clamp01((t * n) % 1 * 1.6)) : 1;
      const h = (run.fit.rmsS / max) * (bottom - top) * grow;
      const isBest = t >= 1 && run.station === bestRun.station && d.culprit;
      ctx.fillStyle = isBest ? "#1F6FEB" : "#B5BCC5";
      ctx.beginPath();
      ctx.roundRect?.(x, bottom - h, w, h, [4, 4, 0, 0]);
      ctx.fill();
      haloText(ctx, run.fit.rmsS.toFixed(2), x + w / 2, bottom - h - 5, { font: `${isBest ? 700 : 400} 11px 'JetBrains Mono', monospace`, color: isBest ? "#0B57D0" : "#5B6573", align: "center" });
    });
  }

  panel_culprit(ctx, t) {
    const d = this.d;
    this.gantt(ctx, d.exRows, {
      range: this.rowsRange(d.exRows), bars: () => 1, origins: 1, mean: d.exScore.mean, meanT: ease(t),
      highlight: d.culprit?.station, title: d.culprit ? `Start times without ${d.culprit.station.split(".").pop()}` : "Start times at the best point",
      right: `score ${d.labEx.fit.rmsS.toFixed(2)} s`,
    });
  }
}
