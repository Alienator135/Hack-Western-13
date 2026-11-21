// Solver lab: watch QuakeTrace's grid search, misfit heatmap, and wavefronts.

const W = 800;
const H = 560;
const KM_PER_DEG = 111.195;
const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- colour

// One-hue sequential teal: dark = low misfit (good fit), pale = poor fit.
const RAMP = [
  [0.0, [8, 74, 61]],
  [0.18, [11, 138, 108]],
  [0.4, [43, 191, 154]],
  [0.68, [166, 233, 213]],
  [1.0, [238, 243, 238]],
];
export const MISFIT_MIN = 0.2;
export const MISFIT_MAX = 14;
export const misfitT = (rms) => Math.min(1, Math.max(0, Math.log(rms / MISFIT_MIN) / Math.log(MISFIT_MAX / MISFIT_MIN)));

export function rampColor(t) {
  for (let i = 1; i < RAMP.length; i += 1) {
    if (t <= RAMP[i][0]) {
      const [t0, a] = RAMP[i - 1];
      const [t1, b] = RAMP[i];
      const f = (t - t0) / (t1 - t0);
      return a.map((v, k) => Math.round(v + (b[k] - v) * f));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

export const misfitColor = (rms) => rampColor(misfitT(rms));

export function legendGradient() {
  return `linear-gradient(90deg, ${RAMP.map(([t, c]) => `rgb(${c.join(",")}) ${(t * 100).toFixed(0)}%`).join(", ")})`;
}

export const LEGEND_TICKS = [0.25, 0.5, 1, 2, 4, 8];

// ---------------------------------------------------------------- geometry

export function makeProjection(points, { pad = 0.07, w = W, h = H } = {}) {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const south = Math.min(...lats), north = Math.max(...lats), west = Math.min(...lons), east = Math.max(...lons);
  const lat0 = (south + north) / 2;
  const kx = KM_PER_DEG * Math.cos(lat0 * Math.PI / 180);
  const ky = KM_PER_DEG;
  const cx = (west + east) / 2, cy = (south + north) / 2;
  const wKm = (east - west) * kx * (1 + 2 * pad), hKm = (north - south) * ky * (1 + 2 * pad);
  const s = Math.min(w / wKm, h / hKm);
  const project = (lat, lon) => [w / 2 + (lon - cx) * kx * s, h / 2 - (lat - cy) * ky * s];
  project.unproject = (x, y) => [cy - (y - h / 2) / (ky * s), cx + (x - w / 2) / (kx * s)];
  project.pxPerKm = s;
  return project;
}

export function gridGeometry(pass) {
  const rows = pass.lats.length, cols = pass.lons.length;
  const dLat = pass.lats[1] - pass.lats[0];
  const dLon = pass.lons[1] - pass.lons[0];
  return {
    rows, cols, dLat, dLon,
    south: pass.lats[0] - dLat / 2, north: pass.lats[rows - 1] + dLat / 2,
    west: pass.lons[0] - dLon / 2, east: pass.lons[cols - 1] + dLon / 2,
  };
}

export function heatImage(pass, alpha = 230, toT = misfitT) {
  const g = gridGeometry(pass);
  const canvas = document.createElement("canvas");
  canvas.width = g.cols; canvas.height = g.rows;
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(g.cols, g.rows);
  pass.rms.forEach((rms, i) => {
    const r = Math.floor(i / g.cols), c = i % g.cols;
    const o = ((g.rows - 1 - r) * g.cols + c) * 4;
    const [cr, cg, cb] = rampColor(toT(rms));
    data.data[o] = cr; data.data[o + 1] = cg; data.data[o + 2] = cb; data.data[o + 3] = alpha;
  });
  return { canvas, ctx, data, g };
}

// Marching squares: segments in (row, col) index space for one level.
function contourSegments(pass, level) {
  const { rows, cols } = gridGeometry(pass);
  const v = (r, c) => pass.rms[r * cols + c];
  const segs = [];
  const lerp = (a, b) => (level - a) / (b - a);
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = v(r, c), b = v(r, c + 1), d = v(r + 1, c), e = v(r + 1, c + 1);
      const idx = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (e > level ? 4 : 0) | (d > level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const bottom = [r, c + lerp(a, b)];
      const right = [r + lerp(b, e), c + 1];
      const top = [r + 1, c + lerp(d, e)];
      const left = [r + lerp(a, d), c];
      const table = {
        1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[right, top]],
        5: [[left, top], [bottom, right]], 6: [[bottom, top]], 7: [[left, top]], 8: [[left, top]],
        9: [[bottom, top]], 10: [[left, bottom], [right, top]], 11: [[right, top]], 12: [[left, right]],
        13: [[bottom, right]], 14: [[left, bottom]],
      };
      segs.push(...table[idx]);
    }
  }
  return segs;
}

export function triangle(ctx, x, y, size, fill) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x - size, y + size * 0.85);
  ctx.lineTo(x + size, y + size * 0.85);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();
}

export function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const rad = i % 2 ? r * 0.42 : r;
    const a = -Math.PI / 2 + i * Math.PI / 5;
    ctx[i ? "lineTo" : "moveTo"](x + rad * Math.cos(a), y + rad * Math.sin(a));
  }
  ctx.closePath();
  ctx.fillStyle = "#14181F";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();
}

export function haloText(ctx, text, x, y, { font = "500 12px 'JetBrains Mono', monospace", color = "#2B323C", align = "left" } = {}) {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export const ease = (t) => 1 - (1 - t) ** 3;

// ---------------------------------------------------------------- main canvas

export class LabCanvas {
  constructor(container, overview, { onHover, onTick } = {}) {
    this.overview = overview;
    this.onHover = onHover;
    this.onTick = onTick;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "lab-canvas";
    this.canvas.setAttribute("role", "img");
    container.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.mode = "search";
    this.sweep = { coarse: 0, fine: 0, phase: "idle", inset: 0, drop: 1 };
    this.waveT = 0;
    this.hover = null;
    this.raf = null;
    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(this.canvas);
    this.canvas.addEventListener("mousemove", (event) => this.pointer(event));
    this.canvas.addEventListener("mouseleave", () => { this.hover = null; this.onHover?.(null); this.draw(); });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.width * dpr * H / W);
    this.scale = this.canvas.width / W;
    this.draw();
  }

  setData(lab) {
    this.lab = lab;
    const points = [
      [lab.region.south, lab.region.west], [lab.region.north, lab.region.east],
      ...lab.stations.map((s) => [s.lat, s.lon]), [lab.event.lat, lab.event.lon],
    ];
    this.P = makeProjection(points);
    this.coarseHeat = heatImage(lab.coarse);
    // The fine pass spans well under a second of misfit, so give the inset its own stretch of the ramp.
    const fineMin = Math.min(...lab.fine.rms), fineMax = Math.max(...lab.fine.rms);
    this.fineRange = [fineMin, fineMax];
    this.fineHeat = heatImage(lab.fine, 255, (rms) => 0.6 * (rms - fineMin) / Math.max(1e-6, fineMax - fineMin));
    this.contours = [0.5, 1, 2, 4].map((level) => ({ level, segs: contourSegments(lab.coarse, level) }));
    this.land = this.buildLand();
    this.canvas.setAttribute("aria-label", `Misfit map: ${lab.pointsTested} candidate epicentres tested, best misfit ${lab.fit.rmsS.toFixed(2)} s`);
  }

  buildLand() {
    const path = new Path2D();
    for (const feature of this.overview.outlines.features || []) {
      const geometry = feature.geometry;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      for (const polygon of polygons) {
        for (const ring of polygon) {
          ring.forEach(([lon, lat], i) => { const [x, y] = this.P(lat, lon); path[i ? "lineTo" : "moveTo"](x, y); });
          path.closePath();
        }
      }
    }
    return path;
  }

  setMode(mode) {
    this.mode = mode;
    cancelAnimationFrame(this.raf);
    this.draw();
  }

  // ------------------------------------------------ animation

  // Autoplay respects reduced motion; an explicit click (force) always animates.
  playSearch({ instant = false, force = false } = {}) {
    cancelAnimationFrame(this.raf);
    this.mode = "search";
    const total = this.lab.coarse.rms.length;
    const fineTotal = this.lab.fine.rms.length;
    if (instant || (REDUCED_MOTION && !force)) {
      this.sweep = { coarse: total, fine: fineTotal, phase: "done", inset: 1, drop: 1 };
      this.draw();
      this.onTick?.(this.progress());
      return;
    }
    const coarseMs = 3600, pauseMs = 700, fineMs = 2000, dropMs = 700;
    const start = performance.now();
    const frame = (now) => {
      const t = now - start;
      if (t < coarseMs) {
        this.sweep = { coarse: Math.floor(total * (t / coarseMs)), fine: 0, phase: "coarse", inset: 0, drop: 0 };
      } else if (t < coarseMs + pauseMs) {
        this.sweep = { coarse: total, fine: 0, phase: "zoom", inset: ease((t - coarseMs) / pauseMs), drop: 0 };
      } else if (t < coarseMs + pauseMs + fineMs) {
        this.sweep = { coarse: total, fine: Math.floor(fineTotal * ((t - coarseMs - pauseMs) / fineMs)), phase: "fine", inset: 1, drop: 0 };
      } else if (t < coarseMs + pauseMs + fineMs + dropMs) {
        this.sweep = { coarse: total, fine: fineTotal, phase: "done", inset: 1, drop: ease((t - coarseMs - pauseMs - fineMs) / dropMs) };
      } else {
        this.sweep = { coarse: total, fine: fineTotal, phase: "done", inset: 1, drop: 1 };
        this.draw();
        this.onTick?.(this.progress());
        return;
      }
      this.draw();
      this.onTick?.(this.progress());
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  progress() {
    const { coarse, fine, phase } = this.sweep;
    const lab = this.lab;
    let bestIndex = -1, best = Infinity;
    for (let i = 0; i < coarse; i += 1) if (lab.coarse.rms[i] < best) { best = lab.coarse.rms[i]; bestIndex = i; }
    let bestPoint = null;
    if (bestIndex >= 0) {
      const cols = lab.coarse.lons.length;
      bestPoint = { lat: lab.coarse.lats[Math.floor(bestIndex / cols)], lon: lab.coarse.lons[bestIndex % cols], rms: best };
    }
    if (fine > 0) {
      const cols = lab.fine.lons.length;
      for (let i = 0; i < fine; i += 1) {
        if (lab.fine.rms[i] < best) { best = lab.fine.rms[i]; bestPoint = { lat: lab.fine.lats[Math.floor(i / cols)], lon: lab.fine.lons[i % cols], rms: best }; }
      }
    }
    if (phase === "done") bestPoint = { lat: lab.fit.lat, lon: lab.fit.lon, rms: lab.fit.rmsS };
    return { tested: coarse + fine + (phase === "done" ? 1 : 0), phase, best: bestPoint };
  }

  playWaves(fromT = 0, { speed = 3, onTime } = {}) {
    cancelAnimationFrame(this.raf);
    this.mode = "waves";
    const end = this.waveEnd();
    const start = performance.now();
    const frame = (now) => {
      this.waveT = Math.min(end, fromT + ((now - start) / 1000) * speed);
      this.draw();
      onTime?.(this.waveT, this.waveT >= end);
      if (this.waveT < end) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  pause() { cancelAnimationFrame(this.raf); }

  waveEnd() { return Math.ceil(Math.max(...this.lab.stations.map((s) => Math.max(s.pickS, s.predictedS))) + 2); }

  setWaveTime(t) { cancelAnimationFrame(this.raf); this.mode = "waves"; this.waveT = t; this.draw(); }

  // ------------------------------------------------ hover

  pointer(event) {
    if (!this.lab) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (W / rect.width);
    const y = (event.clientY - rect.top) * (H / rect.height);
    const [lat, lon] = this.P.unproject(x, y);
    const station = this.lab.stations.find((s) => { const [sx, sy] = this.P(s.lat, s.lon); return Math.hypot(sx - x, sy - y) < 12; });
    const g = gridGeometry(this.lab.coarse);
    let cell = null;
    if (lat >= g.south && lat <= g.north && lon >= g.west && lon <= g.east) {
      const r = Math.min(g.rows - 1, Math.max(0, Math.round((lat - this.lab.coarse.lats[0]) / g.dLat)));
      const c = Math.min(g.cols - 1, Math.max(0, Math.round((lon - this.lab.coarse.lons[0]) / g.dLon)));
      const index = r * g.cols + c;
      const revealed = this.mode !== "search" || index < this.sweep.coarse;
      if (revealed) cell = { r, c, lat: this.lab.coarse.lats[r], lon: this.lab.coarse.lons[c], rms: this.lab.coarse.rms[index] };
    }
    this.hover = cell ? { ...cell, x, y } : null;
    this.onHover?.({ cell, station, x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width });
    this.draw();
  }

  // ------------------------------------------------ drawing

  draw() {
    const ctx = this.ctx;
    if (!this.lab || !this.scale) return;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#DCE9F3";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#F1F3EE";
    ctx.fill(this.land, "evenodd");
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#B5BCC5";
    ctx.lineWidth = 1.1;
    ctx.stroke(this.land);
    ctx.restore();

    this.drawSearchArea();
    if (this.mode === "search") this.drawSweep();
    else this.drawHeat(this.mode === "waves" ? 0.55 : 1);
    if (this.mode === "heatmap") this.drawContours();
    if (this.mode === "waves") this.drawWaves();
    this.drawCities();
    this.drawStations();
    this.drawMarkers();
    if (this.mode === "search" && this.sweep.inset > 0) this.drawInset();
    if (this.hover && this.mode !== "waves") this.drawHover();
    this.drawScale();
  }

  regionRect(g = gridGeometry(this.lab.coarse)) {
    const [x0, y0] = this.P(g.north, g.west);
    const [x1, y1] = this.P(g.south, g.east);
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  drawSearchArea() {
    const ctx = this.ctx;
    const r = this.regionRect();
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "#8A94A3";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x0, r.y0, r.w, r.h);
    ctx.restore();
    haloText(ctx, "search area", r.x0 + 6, r.y0 - 6, { font: "400 11px Inter, sans-serif", color: "#5B6573" });
  }

  drawHeat(opacity) {
    const ctx = this.ctx;
    const r = this.regionRect();
    if (!this.heatPainted) {
      this.coarseHeat.ctx.putImageData(this.coarseHeat.data, 0, 0);
      this.heatPainted = true;
    }
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.coarseHeat.canvas, r.x0, r.y0, r.w, r.h);
    ctx.restore();
  }

  drawSweep() {
    const ctx = this.ctx;
    const { coarse } = this.sweep;
    const heat = this.coarseHeat;
    const g = heat.g;
    // Repaint the offscreen image with only the cells tested so far.
    heat.ctx.clearRect(0, 0, g.cols, g.rows);
    const fullRows = Math.floor(coarse / g.cols);
    const partial = coarse % g.cols;
    if (fullRows) heat.ctx.putImageData(heat.data, 0, 0, 0, g.rows - fullRows, g.cols, fullRows);
    if (partial) heat.ctx.putImageData(heat.data, 0, 0, 0, g.rows - fullRows - 1, partial, 1);
    this.heatPainted = false;
    const r = this.regionRect();
    ctx.save();
    ctx.imageSmoothingEnabled = this.sweep.phase === "done";
    ctx.globalAlpha = 0.95;
    ctx.drawImage(heat.canvas, r.x0, r.y0, r.w, r.h);
    ctx.restore();
    // Scan head
    if (this.sweep.phase === "coarse" && coarse < this.lab.coarse.rms.length) {
      const row = Math.floor(coarse / g.cols), col = coarse % g.cols;
      const cw = r.w / g.cols, ch = r.h / g.rows;
      const x = r.x0 + col * cw, y = r.y0 + (g.rows - 1 - row) * ch;
      ctx.fillStyle = "rgba(31, 111, 235, 0.12)";
      ctx.fillRect(r.x0, y, r.w, ch);
      ctx.strokeStyle = "#1F6FEB";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 1, y - 1, cw + 2, ch + 2);
    }
  }

  drawContours() {
    const ctx = this.ctx;
    const pass = this.lab.coarse;
    const g = gridGeometry(pass);
    const toXY = ([r, c]) => this.P(pass.lats[0] + r * g.dLat, pass.lons[0] + c * g.dLon);
    ctx.save();
    for (const { level, segs } of this.contours) {
      if (!segs.length) continue;
      ctx.beginPath();
      for (const [a, b] of segs) {
        const [x0, y0] = toXY(a);
        const [x1, y1] = toXY(b);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.strokeStyle = misfitT(level) < 0.45 ? "rgba(255,255,255,0.85)" : "rgba(20,24,31,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
      // Label the contour at its northern-most point.
      let top = null;
      for (const [a] of segs) { const p = toXY(a); if (!top || p[1] < top[1]) top = p; }
      if (top) haloText(ctx, `${level} s`, top[0] + 4, top[1] - 3, { font: "500 10px 'JetBrains Mono', monospace", color: "#2B323C" });
    }
    ctx.restore();
  }

  drawCities() {
    const ctx = this.ctx;
    for (const city of this.overview.cities) {
      const [x, y] = this.P(city.lat, city.lon);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#8A94A3";
      ctx.fill();
      haloText(ctx, city.name, x + 6, y + 13, { font: "400 11px Inter, sans-serif", color: "#5B6573" });
    }
  }

  drawStations() {
    const ctx = this.ctx;
    const suspect = this.lab.scenario.station;
    for (const s of this.lab.stations) {
      const [x, y] = this.P(s.lat, s.lon);
      const fill = s.excluded ? "#B5BCC5" : "#4A5563";
      triangle(ctx, x, y, 8, fill);
      if (s.excluded) {
        ctx.strokeStyle = "#E8590C";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9);
        ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9);
        ctx.stroke();
      }
      haloText(ctx, s.short + (s.excluded ? " out" : ""), x + 12, y + 5, { color: s.excluded ? "#B03F00" : s.id === suspect && this.revealSuspect ? "#B03F00" : "#2B323C" });
    }
  }

  drawMarkers() {
    const ctx = this.ctx;
    const lab = this.lab;
    const [ux, uy] = this.P(lab.event.lat, lab.event.lon);
    const showFinal = this.mode !== "search" || this.sweep.phase === "done";
    if (showFinal) {
      star(ctx, ux, uy, 9);
      haloText(ctx, "USGS", ux + 12, uy + 16, { font: "500 11px Inter, sans-serif", color: "#14181F" });
    }
    const progress = this.mode === "search" ? this.progress() : null;
    const point = this.mode === "search" ? progress.best : { lat: lab.fit.lat, lon: lab.fit.lon };
    if (!point) return;
    const [x, y] = this.P(point.lat, point.lon);
    const drop = this.mode === "search" ? this.sweep.drop : 1;
    ctx.save();
    if (this.mode === "search" && this.sweep.phase !== "done") {
      // Running best: crosshair that jumps as better cells are found.
      ctx.strokeStyle = "#1F6FEB";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y);
      ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16);
      ctx.stroke();
      ctx.setLineDash([]);
      haloText(ctx, `best so far ${point.rms.toFixed(2)} s`, x + 12, y - 10, { font: "600 12px Inter, sans-serif", color: "#0B57D0" });
    } else {
      const radius = 10 + (1 - drop) * 30;
      ctx.globalAlpha = 0.4 + 0.6 * drop;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = "#1F6FEB";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#1F6FEB";
      ctx.fill();
      ctx.globalAlpha = 1;
      if (drop >= 1) haloText(ctx, `best fit · ${lab.fit.rmsS.toFixed(2)} s`, x - 14, y - 14, { font: "600 13px Inter, sans-serif", color: "#0B57D0", align: "right" });
    }
    ctx.restore();
  }

  drawInset() {
    const ctx = this.ctx;
    const lab = this.lab;
    const t = this.sweep.inset;
    const fineGeo = gridGeometry(lab.fine);
    const [fx0, fy0] = this.P(fineGeo.north, fineGeo.west);
    const [fx1, fy1] = this.P(fineGeo.south, fineGeo.east);
    const size = 230;
    const ix = W - size - 18, iy = H - size - 44;
    // Grow from the fine area on the map into the inset.
    const bx = fx0 + (ix - fx0) * t, by = fy0 + (iy - fy0) * t;
    const bw = (fx1 - fx0) + (size - (fx1 - fx0)) * t, bh = (fy1 - fy0) + (size - (fy1 - fy0)) * t;
    ctx.save();
    ctx.strokeStyle = "#1F6FEB";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(fx0, fy1); ctx.lineTo(bx, by + bh);
    ctx.moveTo(fx1, fy0); ctx.lineTo(bx + bw, by);
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
    // Fine cells revealed so far.
    const heat = this.fineHeat;
    const g = heat.g;
    heat.ctx.clearRect(0, 0, g.cols, g.rows);
    const fullRows = Math.floor(this.sweep.fine / g.cols);
    const partial = this.sweep.fine % g.cols;
    if (fullRows) heat.ctx.putImageData(heat.data, 0, 0, 0, g.rows - fullRows, g.cols, fullRows);
    if (partial) heat.ctx.putImageData(heat.data, 0, 0, 0, g.rows - fullRows - 1, partial, 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(heat.canvas, bx, by, bw, bh);
    // Grid lines for the fine cells.
    if (t >= 1) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let c = 1; c < g.cols; c += 1) { const x = bx + (c / g.cols) * bw; ctx.moveTo(x, by); ctx.lineTo(x, by + bh); }
      for (let r = 1; r < g.rows; r += 1) { const y = by + (r / g.rows) * bh; ctx.moveTo(bx, y); ctx.lineTo(bx + bw, y); }
      ctx.stroke();
      // Best fine cell.
      let best = Infinity, bi = -1;
      for (let i = 0; i < this.sweep.fine; i += 1) if (lab.fine.rms[i] < best) { best = lab.fine.rms[i]; bi = i; }
      if (bi >= 0) {
        const r = Math.floor(bi / g.cols), c = bi % g.cols;
        const cw = bw / g.cols, ch = bh / g.rows;
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(bx + c * cw - 1, by + (g.rows - 1 - r) * ch - 1, cw + 2, ch + 2);
        ctx.strokeStyle = "#1F6FEB";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bx + c * cw - 1, by + (g.rows - 1 - r) * ch - 1, cw + 2, ch + 2);
      }
    }
    ctx.strokeStyle = "#1F6FEB";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);
    if (t >= 1) {
      haloText(ctx, `Fine pass · ${lab.fine.stepKm * 1000} m cells · ${this.sweep.fine}/${lab.fine.rms.length}`, bx, by - 8, { font: "600 11px Inter, sans-serif", color: "#0B57D0" });
      haloText(ctx, `inset colours stretched: ${this.fineRange[0].toFixed(2)}–${this.fineRange[1].toFixed(2)} s`, bx, by + bh + 16, { font: "400 10px Inter, sans-serif", color: "#5B6573" });
    }
    ctx.restore();
  }

  drawWaves() {
    const ctx = this.ctx;
    const lab = this.lab;
    const t = this.waveT;
    const v = lab.model.speedKmS, depth = lab.model.depthKm;
    const [ex, ey] = this.P(lab.fit.lat, lab.fit.lon);
    const radiusKm = Math.sqrt(Math.max(0, (v * t) ** 2 - depth ** 2));
    const radius = radiusKm * this.P.pxPerKm;
    ctx.save();
    if (radius > 0) {
      const gradient = ctx.createRadialGradient(ex, ey, Math.max(0, radius - 40), ex, ey, radius);
      gradient.addColorStop(0, "rgba(31,111,235,0)");
      gradient.addColorStop(1, "rgba(31,111,235,0.16)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(ex, ey, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1F6FEB";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      haloText(ctx, `P wave · ${t.toFixed(1)} s`, ex, Math.max(16, ey - radius - 8), { font: "600 12px Inter, sans-serif", color: "#0B57D0", align: "center" });
    }
    for (const s of lab.stations) {
      const [x, y] = this.P(s.lat, s.lon);
      const pulse = (eventT, color) => {
        const age = t - eventT;
        if (age < 0) return;
        if (age < 0.9) {
          ctx.beginPath();
          ctx.arc(x, y, 10 + age * 40, 0, Math.PI * 2);
          ctx.strokeStyle = color.replace("ALPHA", (1 - age / 0.9).toFixed(2));
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      };
      pulse(s.predictedS, "rgba(31,111,235,ALPHA)");
      pulse(s.pickS, "rgba(232,89,12,ALPHA)");
      const reached = t >= s.predictedS;
      const recorded = t >= s.pickS;
      const gap = s.pickS - s.predictedS;
      if (reached && !recorded) {
        haloText(ctx, `waiting ${(t - s.predictedS).toFixed(1)} s`, x + 12, y + 20, { font: "500 11px 'JetBrains Mono', monospace", color: "#B03F00" });
      } else if (recorded) {
        const big = Math.abs(gap) >= 1.5;
        haloText(ctx, `${gap >= 0 ? "+" : "−"}${Math.abs(gap).toFixed(2)} s`, x + 12, y + 20, { font: `${big ? 600 : 400} 11px 'JetBrains Mono', monospace`, color: big ? "#B03F00" : "#5B6573" });
      }
    }
    ctx.restore();
  }

  drawHover() {
    const ctx = this.ctx;
    const { lat, lon } = this.hover;
    const g = gridGeometry(this.lab.coarse);
    const [x0, y0] = this.P(lat + g.dLat / 2, lon - g.dLon / 2);
    const [x1, y1] = this.P(lat - g.dLat / 2, lon + g.dLon / 2);
    ctx.save();
    ctx.strokeStyle = "#14181F";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  drawScale() {
    const ctx = this.ctx;
    const km = 20;
    const px = km * this.P.pxPerKm;
    ctx.save();
    ctx.strokeStyle = "#5B6573";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(20, H - 22); ctx.lineTo(20 + px, H - 22);
    ctx.stroke();
    haloText(ctx, `${km} km`, 26 + px, H - 18, { font: "400 12px Inter, sans-serif", color: "#5B6573" });
    ctx.restore();
  }
}

// ---------------------------------------------------------------- small multiples

export function drawMiniHeat(canvas, runs, surface, { stations = [], excluded = null, usgs = null } = {}) {
  const size = 220;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pass = { lats: runs.lats, lons: runs.lons, rms: surface.rms };
  const g = gridGeometry(pass);
  const P = makeProjection([[g.south, g.west], [g.north, g.east]], { pad: 0, w: size, h: size });
  const { canvas: heat, ctx: hctx, data } = heatImage(pass, 255);
  hctx.putImageData(data, 0, 0);
  const [x0, y0] = P(g.north, g.west);
  const [x1, y1] = P(g.south, g.east);
  ctx.fillStyle = "#EEF3EE";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(heat, x0, y0, x1 - x0, y1 - y0);
  for (const s of stations) {
    const [x, y] = P(s.lat, s.lon);
    if (x < 0 || x > size || y < 0 || y > size) continue;
    const out = s.id === excluded;
    triangle(ctx, x, y, 5, out ? "#E8590C" : "#4A5563");
  }
  if (usgs) { const [ux, uy] = P(usgs.lat, usgs.lon); star(ctx, ux, uy, 6); }
  const [fx, fy] = P(surface.fit.lat, surface.fit.lon);
  ctx.beginPath();
  ctx.arc(fx, fy, 7, 0, Math.PI * 2);
  ctx.strokeStyle = "#1F6FEB";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(fx, fy, 2, 0, Math.PI * 2);
  ctx.fillStyle = "#1F6FEB";
  ctx.fill();
}
