// Multi-year station clock health heatmap (stations × months), served from Tiger Data.

const LEFT = 112;
const TOP = 26;
const BOTTOM = 30;
const ROW = 20;

// Diverging: blue = early, neutral gray at zero, orange = late.
const EARLY = [31, 111, 235];
const LATE = [194, 65, 12];
const NEUTRAL = [235, 238, 242];
const LIMIT_S = 3;

export function deviationColor(value) {
  if (value === null || value === undefined) return "rgb(235,238,242)";
  const t = Math.min(1, Math.abs(value) / LIMIT_S);
  const pole = value >= 0 ? LATE : EARLY;
  const mix = NEUTRAL.map((v, k) => Math.round(v + (pole[k] - v) * t));
  return `rgb(${mix.join(",")})`;
}

export function historyLegend() {
  return `linear-gradient(90deg, rgb(${EARLY}), rgb(${NEUTRAL}) 50%, rgb(${LATE}))`;
}

export class HistoryChart {
  constructor(container, { onHover } = {}) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "history-canvas";
    this.canvas.setAttribute("role", "img");
    container.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.onHover = onHover;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.canvas.addEventListener("mousemove", (event) => this.pointer(event));
    this.canvas.addEventListener("mouseleave", () => { this.hover = null; this.onHover?.(null); this.draw(); });
  }

  destroy() { this.observer.disconnect(); this.canvas.remove(); }

  setData(view) {
    this.view = view;
    this.canvas.setAttribute("aria-label", `Monthly clock deviation for ${view.stations.length} stations, ${view.months.length} months`);
    this.resize();
  }

  resize() {
    if (!this.view) return;
    const width = this.canvas.parentElement.clientWidth;
    if (!width) return;
    const height = TOP + ROW * this.view.stations.length + BOTTOM;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.draw();
  }

  geometry() {
    const months = this.view.months.length;
    const cellW = (this.width - LEFT - 8) / Math.max(1, months);
    return { months, cellW };
  }

  pointer(event) {
    if (!this.view) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const { months, cellW } = this.geometry();
    const col = Math.floor((x - LEFT) / cellW);
    const row = Math.floor((y - TOP) / ROW);
    if (col < 0 || col >= months || row < 0 || row >= this.view.stations.length) {
      this.hover = null;
      this.onHover?.(null);
    } else {
      this.hover = { row, col };
      const s = this.view.stations[row];
      this.onHover?.({
        station: s, month: this.view.months[col], value: s.values[col], picks: s.counts[col], deviation: s.deviations[col],
        x, y, width: rect.width,
      });
    }
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const view = this.view;
    if (!view || !this.width) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const { months, cellW } = this.geometry();
    const scenario = view.scenario;
    // Year gridlines and labels
    ctx.font = "500 11px Inter, sans-serif";
    ctx.textAlign = "left";
    view.months.forEach((iso, i) => {
      const date = new Date(iso);
      if (date.getUTCMonth() !== 0 && i !== 0) return;
      const x = LEFT + i * cellW;
      ctx.fillStyle = "#5B6573";
      ctx.fillText(String(date.getUTCFullYear()), x + 2, TOP - 10);
      ctx.fillStyle = "#D0D5DC";
      ctx.fillRect(x, TOP - 4, 1, ROW * view.stations.length + 8);
    });
    // Onset marker for an injected shift
    if (scenario.station && scenario.onset) {
      const onset = scenario.onset.slice(0, 7);
      const col = view.months.findIndex((iso) => iso.slice(0, 7) === onset);
      if (col >= 0) {
        const x = LEFT + col * cellW;
        ctx.fillStyle = "#B03F00";
        ctx.fillRect(x, TOP - 4, 2, ROW * view.stations.length + 8);
        ctx.font = "600 11px Inter, sans-serif";
        ctx.textAlign = x > this.width - 140 ? "right" : "left";
        ctx.fillText(`shift injected ${scenario.onset}`, x + (ctx.textAlign === "right" ? -4 : 4), this.height - 10);
      }
    }
    view.stations.forEach((s, r) => {
      const y = TOP + r * ROW;
      const hot = s.status === "flagged";
      ctx.font = `${hot ? 600 : 400} 12px 'JetBrains Mono', monospace`;
      ctx.textAlign = "left";
      ctx.fillStyle = hot ? "#B03F00" : s.station === scenario.station ? "#0B57D0" : "#2B323C";
      ctx.fillText(s.short, 0, y + 14);
      ctx.font = "400 10px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#8A94A3";
      ctx.textAlign = "right";
      ctx.fillText(s.picks.toLocaleString(), LEFT - 8, y + 14);
      for (let c = 0; c < months; c += 1) {
        const x = LEFT + c * cellW;
        if (!s.counts[c]) {
          ctx.fillStyle = "#F6F7F9";
          ctx.fillRect(x, y + 2, Math.max(1, cellW - 1), ROW - 4);
          continue;
        }
        ctx.fillStyle = s.deviations[c] === null ? "#DADFE4" : deviationColor(s.deviations[c]);
        ctx.fillRect(x, y + 2, Math.max(1, cellW - 1), ROW - 4);
      }
      // Outline the flagged run
      if (hot && s.firstFlag) {
        const start = view.months.indexOf(s.firstFlag);
        const end = view.months.indexOf(s.confirmed);
        if (start >= 0) {
          ctx.strokeStyle = "#14181F";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(LEFT + start * cellW - 1, y + 1, (Math.max(end, start) - start + 1) * cellW + 1, ROW - 2);
        }
      }
    });
    if (this.hover) {
      const { row, col } = this.hover;
      ctx.strokeStyle = "#14181F";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(LEFT + col * cellW - 0.5, TOP + row * ROW + 1.5, cellW, ROW - 3);
    }
  }
}
