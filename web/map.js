// Map views for QuakeTrace: MapLibre GL (street map, satellite, 3D globe with terrain),
// all free and keyless, plus an offline SVG fallback drawn from the bundled state outlines.

const SVG_NS = "http://www.w3.org/2000/svg";
const W = 800;
const KM_PER_DEG = 111.195;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- MapLibre loader

const MAPLIBRE = "https://unpkg.com/maplibre-gl@5.6.0/dist";
const STREET_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

let libPromise = null;
let libFailed = false;
const failureListeners = new Set();

export function mapsFailed() { return libFailed || (typeof navigator !== "undefined" && navigator.onLine === false); }
export function onMapsFailure(listener) { failureListeners.add(listener); return () => failureListeners.delete(listener); }

function failMaps(reason) {
  if (libFailed) return;
  libFailed = true;
  console.warn("Online maps unavailable:", reason);
  failureListeners.forEach((listener) => listener(reason));
}

export function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (libFailed) return Promise.reject(new Error("The online map library failed to load."));
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${MAPLIBRE}/maplibre-gl.css`;
    document.head.append(css);
    const script = document.createElement("script");
    script.src = `${MAPLIBRE}/maplibre-gl.js`;
    script.async = true;
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => { failMaps("The map library could not load (offline?)."); reject(new Error("MapLibre script failed.")); };
    document.head.append(script);
    setTimeout(() => { if (!window.maplibregl) { failMaps("Timed out loading the map library."); reject(new Error("Timeout")); } }, 12000);
  });
  return libPromise;
}

export function googleEarthUrl(lat, lon, rangeM = 160000) {
  return `https://earth.google.com/web/@${lat.toFixed(5)},${lon.toFixed(5)},0a,${Math.round(rangeM)}d,35y,0h,45t,0r`;
}

function imageryStyle(dim) {
  return {
    version: 8,
    sources: {
      imagery: {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      },
      places: {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
      },
    },
    layers: [
      { id: "paper", type: "background", paint: { "background-color": "#FFFFFF" } },
      { id: "imagery", type: "raster", source: "imagery", paint: { "raster-opacity": 1 - dim / 100 } },
      { id: "places", type: "raster", source: "places" },
    ],
  };
}

function bearingDeg(a, b) {
  const lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
  return Math.atan2((b.lon - a.lon) * Math.cos(lat0), b.lat - a.lat) * 180 / Math.PI;
}

// ---------------------------------------------------------------- shared geometry

function scenePoints(scene) {
  if (scene.fitTo?.length) return scene.fitTo;
  const points = [];
  (scene.stations || []).forEach((s) => points.push([s.lat, s.lon]));
  (scene.marks || []).forEach((m) => points.push([m.lat, m.lon]));
  (scene.extraBounds || []).forEach((p) => points.push(p));
  return points;
}

function boundsOf(points) {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) };
}

function centreOf(bounds) {
  return { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 };
}

function spanKm(bounds) {
  const lat0 = (bounds.south + bounds.north) / 2;
  const dx = (bounds.east - bounds.west) * KM_PER_DEG * Math.cos(lat0 * Math.PI / 180);
  const dy = (bounds.north - bounds.south) * KM_PER_DEG;
  return Math.hypot(dx, dy);
}

// Teal best-fit zone as a canvas image (row 0 is the southern edge).
const zoneCache = new WeakMap();
export function zoneImage(zone) {
  if (!zone) return null;
  if (zoneCache.has(zone)) return zoneCache.get(zone);
  const { cols, rows, excess, marginS } = zone;
  const small = document.createElement("canvas");
  small.width = cols; small.height = rows;
  const ctx = small.getContext("2d");
  const image = ctx.createImageData(cols, rows);
  const stops = [
    [0, [11, 138, 108, 0.62]],
    [0.3, [43, 191, 154, 0.42]],
    [0.65, [120, 214, 186, 0.26]],
    [1, [166, 233, 213, 0.0]],
  ];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const t = excess[r * cols + c] / marginS;
      let rgba = [0, 0, 0, 0];
      if (t <= 1) {
        for (let i = 1; i < stops.length; i += 1) {
          if (t <= stops[i][0]) {
            const [t0, a] = stops[i - 1];
            const [t1, b] = stops[i];
            const f = (t - t0) / (t1 - t0);
            rgba = a.map((v, k) => v + (b[k] - v) * f);
            break;
          }
        }
      }
      const o = ((rows - 1 - r) * cols + c) * 4;
      image.data[o] = rgba[0]; image.data[o + 1] = rgba[1]; image.data[o + 2] = rgba[2];
      image.data[o + 3] = Math.round(rgba[3] * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const big = document.createElement("canvas");
  big.width = cols * 4; big.height = rows * 4;
  const bctx = big.getContext("2d");
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(small, 0, 0, big.width, big.height);
  const url = big.toDataURL("image/png");
  zoneCache.set(zone, url);
  return url;
}

// ---------------------------------------------------------------- SVG fallback

class SvgMap {
  constructor(host, overview, { width = 800, height = 560 } = {}) {
    this.host = host;
    this.overview = overview;
    this.W = width;
    this.H = height;
    this.kind = "svg";
  }

  project(scene) {
    const W = this.W;
    const points = scenePoints(scene);
    const b = boundsOf(points);
    const lat0 = (b.south + b.north) / 2;
    const kx = KM_PER_DEG * Math.cos(lat0 * Math.PI / 180);
    const ky = KM_PER_DEG;
    const pad = 0.12;
    let wKm = (b.east - b.west) * kx;
    let hKm = (b.north - b.south) * ky;
    const cx = (b.east + b.west) / 2;
    const cy = (b.north + b.south) / 2;
    const minSpan = scene.minSpanKm || 30;
    wKm = Math.max(wKm, minSpan) * (1 + 2 * pad);
    hKm = Math.max(hKm, minSpan) * (1 + 2 * pad);
    const scale = Math.min(W / wKm, this.H / hKm); // px per km
    this.pxPerKm = scale;
    return (lat, lon) => [W / 2 + (lon - cx) * kx * scale, this.H / 2 - (lat - cy) * ky * scale];
  }

  render(scene) {
    const { W, H } = this;
    const p = this.project(scene);
    const parts = [];
    parts.push(`<defs>
      <marker id="qt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#1F6FEB" stroke-width="1.6"/></marker>
      <clipPath id="qt-clip"><rect width="${W}" height="${H}" rx="8"/></clipPath>
    </defs>`);
    parts.push(`<rect width="${W}" height="${H}" fill="#DCE9F3"/>`);
    parts.push('<g clip-path="url(#qt-clip)">');

    // Land outlines
    const labels = [];
    for (const feature of this.overview.outlines.features || []) {
      const geometry = feature.geometry;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      let d = "";
      let biggest = null;
      for (const polygon of polygons) {
        for (const ring of polygon) {
          d += ring.map(([lon, lat], i) => { const [x, y] = p(lat, lon); return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`; }).join("") + "Z";
        }
        if (!biggest || polygon[0].length > biggest.length) biggest = polygon[0];
      }
      parts.push(`<path d="${d}" fill="#F1F3EE" stroke="#B5BCC5" stroke-width="1.2" stroke-dasharray="6 4" fill-rule="evenodd"/>`);
      if (biggest) {
        const lon = biggest.reduce((s, c) => s + c[0], 0) / biggest.length;
        const lat = biggest.reduce((s, c) => s + c[1], 0) / biggest.length;
        const [x, y] = p(lat, lon);
        if (x > 40 && x < W - 40 && y > 40 && y < H - 30) labels.push(`<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" text-anchor="middle">${esc(feature.properties?.postal || "")}</text>`);
      }
    }
    parts.push(`<g font-family="Inter, sans-serif" font-size="30" font-weight="600" fill="#DADFE4">${labels.join("")}</g>`);

    // Zone
    if (scene.zone) {
      const z = scene.zone.bounds;
      const [x0, y0] = p(z.north, z.west);
      const [x1, y1] = p(z.south, z.east);
      parts.push(`<image href="${zoneImage(scene.zone)}" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" preserveAspectRatio="none"/>`);
    }

    // Cities
    if (scene.showCities !== false) {
      for (const city of this.overview.cities) {
        const [x, y] = p(city.lat, city.lon);
        if (x < 10 || x > W - 10 || y < 10 || y > H - 10) continue;
        const left = city.name === "Newark";
        parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#8A94A3"/><text x="${(x + (left ? -6 : 8)).toFixed(1)}" y="${(y + 14).toFixed(1)}" font-family="Inter, sans-serif" font-size="11" fill="#5B6573" text-anchor="${left ? "end" : "start"}">${esc(city.name)}</text>`);
      }
    }

    // Links
    for (const link of scene.links || []) {
      const [ax, ay] = p(link.a.lat, link.a.lon);
      const [bx, by] = p(link.b.lat, link.b.lon);
      const color = link.color || "#8A94A3";
      // Trim the ends so lines do not cross the markers.
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const trim = Math.min(14, len / 3);
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      parts.push(`<line x1="${(ax + ux * trim).toFixed(1)}" y1="${(ay + uy * trim).toFixed(1)}" x2="${(bx - ux * trim).toFixed(1)}" y2="${(by - uy * trim).toFixed(1)}" stroke="${color}" stroke-width="${link.width || 1.5}" ${link.dashed ? 'stroke-dasharray="4 3"' : ""} ${link.arrow ? 'marker-end="url(#qt-arrow)"' : ""}/>`);
      if (link.label) {
        const side = link.labelSide || 1;
        const mx = (ax + bx) / 2 + uy * 16 * side, my = (ay + by) / 2 - ux * 16 * side + 4;
        parts.push(`<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" font-family="JetBrains Mono, monospace" font-size="13" font-weight="500" fill="${link.labelColor || color}" stroke="#FFFFFF" stroke-width="3" style="paint-order: stroke" text-anchor="middle">${esc(link.label)}</text>`);
      }
    }

    // Stations
    for (const s of scene.stations || []) {
      const [x, y] = p(s.lat, s.lon);
      const fill = s.tone === "suspect" ? "#E8590C" : s.tone === "out" ? "#9AA4B2" : "#4A5563";
      parts.push(`<polygon points="${x},${y - 8} ${x - 8},${y + 7} ${x + 8},${y + 7}" fill="${fill}" stroke="#FFFFFF" stroke-width="1.5"><title>${esc(s.id)} · ${esc(s.name || "")}</title></polygon>`);
      parts.push(`<text x="${(x + 14).toFixed(1)}" y="${(y + 6).toFixed(1)}" font-family="JetBrains Mono, monospace" font-size="13" ${s.tone === "suspect" ? 'font-weight="500" fill="#B03F00"' : 'fill="#2B323C"'} stroke="#FFFFFF" stroke-width="3" style="paint-order: stroke">${esc(s.short)}</text>`);
    }

    // Out circle
    if (scene.outCircle) {
      const [x, y] = p(scene.outCircle.lat, scene.outCircle.lon);
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="24" fill="none" stroke="#E8590C" stroke-width="2.5" stroke-dasharray="5 4"/>`);
      const right = x < W - 170;
      parts.push(`<text x="${(right ? x + 32 : x - 32).toFixed(1)}" y="${(y + 8).toFixed(1)}" text-anchor="${right ? "start" : "end"}" font-family="JetBrains Mono, monospace" font-size="22" font-weight="500" fill="#B03F00" stroke="#FFFFFF" stroke-width="4" style="paint-order: stroke">${esc(scene.outCircle.label)}</text>`);
    }

    // Marks
    for (const m of scene.marks || []) {
      const [x, y] = p(m.lat, m.lon);
      if (m.kind === "star") {
        const pts = [];
        for (let i = 0; i < 10; i += 1) {
          const r = i % 2 ? 4.5 : 11;
          const a = -Math.PI / 2 + i * Math.PI / 5;
          pts.push(`${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`);
        }
        parts.push(`<polygon points="${pts.join(" ")}" fill="#14181F" stroke="#FFFFFF" stroke-width="1.5"/>`);
      } else {
        const color = m.kind === "ring-gray" ? "#8A94A3" : "#1F6FEB";
        const dash = m.kind === "ring-dashed" || m.kind === "ring-gray" ? 'stroke-dasharray="4 3"' : "";
        const r = m.size || 10;
        parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" ${dash}/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${color}"/>`);
      }
      if (m.label) {
        const color = m.kind === "ring-gray" ? "#5B6573" : m.kind === "star" ? "#14181F" : "#0B57D0";
        const dx = m.labelLeft ? -16 : 16;
        parts.push(`<text x="${(x + dx).toFixed(1)}" y="${(y + (m.labelUp ? -12 : 26)).toFixed(1)}" text-anchor="${m.labelLeft ? "end" : "start"}" font-family="Inter, sans-serif" font-size="${m.kind === "ring" ? 13 : 12}" font-weight="${m.kind === "ring" ? 600 : 400}" fill="${color}" stroke="#FFFFFF" stroke-width="3" style="paint-order: stroke">${esc(m.label)}</text>`);
      }
    }
    parts.push("</g>");

    // Legend and scale bar
    if (scene.legend) {
      parts.push(`<g font-family="Inter, sans-serif" font-size="11" fill="#5B6573">${scene.legend.map((line, i) => `<text x="24" y="${30 + i * 16}" stroke="#FFFFFF" stroke-width="3" style="paint-order: stroke">${esc(line)}</text>`).join("")}</g>`);
    }
    const barKm = this.pxPerKm * 20 > 120 ? 10 : this.pxPerKm * 20 < 25 ? 50 : 20;
    const barPx = barKm * this.pxPerKm;
    parts.push(`<g font-family="Inter, sans-serif" font-size="12" fill="#5B6573"><line x1="24" y1="${H - 30}" x2="${(24 + barPx).toFixed(1)}" y2="${H - 30}" stroke="#5B6573" stroke-width="2"/><text x="${(30 + barPx).toFixed(1)}" y="${H - 26}">${barKm} km</text></g>`);

    this.host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="${SVG_NS}" role="img" aria-label="${esc(scene.aria || "Map of seismic stations and estimated epicentres")}">${parts.join("")}</svg>`;
  }

  async toPNG() {
    const svg = this.host.querySelector("svg");
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = this.W * 2; canvas.height = this.H * 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  destroy() {}
}

// ---------------------------------------------------------------- MapLibre (map, satellite, earth)

function el(className, text) {
  const node = document.createElement("div");
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

class LibreMap {
  constructor(host, { kind = "map", dim = 0, small = false } = {}) {
    this.host = host;
    this.kind = kind;
    this.dim = dim;
    this.small = small;
    this.markers = [];
    this.layers = [];
    this.sources = [];
  }

  async init() {
    const lib = await loadMapLibre();
    this.lib = lib;
    const earth = this.kind === "earth";
    const map = new lib.Map({
      container: this.host,
      style: this.kind === "map" ? STREET_STYLE : imageryStyle(this.dim),
      center: [-74.6, 40.8], zoom: 7,
      pitch: earth ? 52 : 0, bearing: earth ? 8 : 0, maxPitch: 75,
      attributionControl: { compact: true },
      // Mouse wheel over the map zooms it. Touch screens keep two-finger panning
      // so a one-finger swipe still scrolls the page.
      cooperativeGestures: window.matchMedia?.("(pointer: coarse)").matches ?? false,
      dragRotate: earth, pitchWithRotate: earth, touchPitch: earth,
    });
    this.map = map;
    map.addControl(new lib.NavigationControl({ showCompass: earth, visualizePitch: earth }), "top-left");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The map tiles took too long to load.")), 12000);
      map.once("load", () => { clearTimeout(timer); resolve(); });
      map.once("error", (event) => { if (!map.loaded()) { clearTimeout(timer); reject(new Error(event?.error?.message || "The map style failed to load.")); } });
    });
    if (earth) {
      try { map.setProjection({ type: "globe" }); } catch { /* older builds */ }
      map.addSource("dem", { type: "raster-dem", tiles: [TERRAIN_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: "Terrain: Mapzen, AWS Open Data" });
      map.setTerrain({ source: "dem", exaggeration: 1.6 });
      try { map.setSky({ "sky-color": "#9CC7F0", "horizon-color": "#E8F0FE", "sky-horizon-blend": 0.6 }); } catch { /* optional */ }
    }
  }

  setDim(dim) {
    this.dim = dim;
    if (this.map && this.kind !== "map" && this.map.getLayer("imagery")) this.map.setPaintProperty("imagery", "raster-opacity", 1 - dim / 100);
  }

  clear() {
    this.markers.forEach((m) => m.remove());
    this.markers = [];
    if (!this.map) return;
    this.layers.forEach((id) => { if (this.map.getLayer(id)) this.map.removeLayer(id); });
    this.sources.forEach((id) => { if (this.map.getSource(id)) this.map.removeSource(id); });
    this.layers = [];
    this.sources = [];
  }

  marker(lat, lon, content, title, { anchor = "bottom", rotation = 0, rotate = false } = {}) {
    // MapLibre owns the outer element's transform, so the styled node goes inside a wrapper.
    const wrap = document.createElement("div");
    wrap.className = "ml-marker";
    if (title) wrap.title = title;
    wrap.append(content);
    const m = new this.lib.Marker({ element: wrap, anchor, rotation, rotationAlignment: rotate ? "map" : "viewport" })
      .setLngLat([lon, lat]).addTo(this.map);
    this.markers.push(m);
    return m;
  }

  addLayer(layer, source) {
    this.map.addSource(layer.id, source);
    this.sources.push(layer.id);
    this.map.addLayer({ ...layer, source: layer.id });
    this.layers.push(layer.id);
  }

  render(scene) {
    if (!this.map) return;
    this.clear();
    const earth = this.kind === "earth";
    if (scene.zone) {
      const { south, north, west, east } = scene.zone.bounds;
      this.addLayer(
        { id: "qt-zone", type: "raster", paint: { "raster-fade-duration": 0, "raster-opacity": 1 } },
        { type: "image", url: zoneImage(scene.zone), coordinates: [[west, north], [east, north], [east, south], [west, south]] },
      );
    }
    const line = (a, b, props) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } });
    const solid = [];
    const dashed = [];
    // In 3D, station-to-estimate rays show the geometry the fit uses.
    const focus = (scene.marks || []).find((m) => m.kind === "ring") || (scene.marks || [])[0];
    if (earth && focus) {
      for (const s of scene.stations || []) {
        const color = s.tone === "suspect" ? "#E8590C" : s.tone === "out" ? "#9AA4B2" : "#FFFFFF";
        solid.push(line(s, focus, { color, width: s.tone === "suspect" ? 4 : 2, opacity: s.tone === "suspect" ? 0.9 : 0.6 }));
      }
    }
    for (const link of scene.links || []) {
      const color = link.color || "#8A94A3";
      (link.dashed ? dashed : solid).push(line(link.a, link.b, { color, width: link.width || 2.5, opacity: 0.95 }));
      if (link.arrow) {
        const head = el("ml-arrow", "▲");
        head.style.color = color;
        this.marker(link.b.lat, link.b.lon, head, "", { anchor: "center", rotation: bearingDeg(link.a, link.b), rotate: true });
      }
      if (link.label) {
        const tag = el("gm-km", link.label);
        tag.style.color = link.labelColor || color;
        this.marker((link.a.lat + link.b.lat) / 2, (link.a.lon + link.b.lon) / 2, tag, link.label);
      }
    }
    const paint = { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"] };
    if (solid.length) this.addLayer({ id: "qt-lines", type: "line", layout: { "line-cap": "round" }, paint }, { type: "geojson", data: { type: "FeatureCollection", features: solid } });
    if (dashed.length) this.addLayer({ id: "qt-dashed", type: "line", paint: { ...paint, "line-dasharray": [1.5, 1.5] } }, { type: "geojson", data: { type: "FeatureCollection", features: dashed } });

    for (const s of scene.stations || []) {
      const wrap = el("gm-station");
      wrap.append(el(`gm-tri ${s.tone || ""}`), el(`gm-label ${s.tone === "suspect" ? "suspect" : ""}`, s.short));
      this.marker(s.lat, s.lon, wrap, `${s.id} · ${s.name || ""}`);
    }
    if (scene.outCircle) {
      const ring = el("gm-out");
      const tag = el("gm-label suspect", scene.outCircle.label);
      tag.style.cssText = "left:52px;top:10px;font-size:18px";
      ring.append(tag);
      this.marker(scene.outCircle.lat, scene.outCircle.lon, ring, scene.outCircle.label);
    }
    for (const m of scene.marks || []) {
      const node = m.kind === "star"
        ? el("gm-star", "★")
        : el(`gm-ring ${m.kind === "ring-dashed" ? "dashed" : ""} ${m.kind === "ring-gray" ? "gray dashed" : ""}`);
      if (m.label) {
        const tag = el(`gm-tag ${m.kind === "ring-gray" ? "gray" : ""}`, m.label);
        if (m.kind === "star") tag.style.cssText = "left:22px;top:0;color:#14181F;font-size:12px;font-weight:500";
        node.append(tag);
      }
      this.marker(m.lat, m.lon, node, m.label);
    }
    const b = boundsOf(scenePoints(scene));
    this.map.fitBounds([[b.west, b.south], [b.east, b.north]], {
      padding: this.small ? 32 : 56, duration: 0, maxZoom: 13,
      ...(earth ? { pitch: 52, bearing: 8 } : {}),
    });
  }

  destroy() { this.clear(); this.map?.remove(); this.map = null; }
}

// ---------------------------------------------------------------- Map view widget

const BASEMAPS = [["map", "Map"], ["satellite", "Satellite"], ["earth", "Earth 3D"]];

/**
 * Build a map card inside `container`.
 * options: { overview, basemap, dim, small, onBasemap(kind) }
 */
export function createMapView(container, options) {
  const { overview, small = false } = options;
  const online = !mapsFailed();
  const basemap = online ? options.basemap || "map" : "svg";
  container.innerHTML = `
    <div class="map-frame ${small ? "small" : ""}">
      <div class="map-host"></div>
      ${small ? "" : `<div class="basemap" role="group" aria-label="Basemap">${BASEMAPS.map(([key, label]) => `<button type="button" data-basemap="${key}" aria-pressed="${key === basemap}" ${online ? "" : 'disabled title="Needs internet"'}>${label}</button>`).join("")}</div>`}
      <div class="map-note" hidden></div>
      <a class="earth-link" target="_blank" rel="noopener" hidden>Open in Google Earth ↗</a>
    </div>`;
  const host = container.querySelector(".map-host");
  const note = container.querySelector(".map-note");
  const earthLink = container.querySelector(".earth-link");
  let provider = null;
  let scene = null;
  let disposed = false;

  const showNote = (html) => { note.innerHTML = html; note.hidden = !html; };

  async function build(kind) {
    provider?.destroy();
    host.innerHTML = "";
    showNote("");
    const size = small ? { width: 420, height: 315 } : { width: 800, height: 560 };
    if (kind !== "svg" && !mapsFailed()) {
      try {
        provider = new LibreMap(host, { kind, dim: options.dim || 0, small });
        await provider.init();
        if (disposed) { provider.destroy(); return; }
        if (scene) provider.render(scene);
        if (kind === "earth") showNote("Drag to pan, right-drag or Ctrl-drag to orbit, scroll to zoom.");
        return;
      } catch (error) {
        console.warn(error);
        provider?.destroy();
        host.innerHTML = "";
        showNote(`${esc(error.message)} Showing the offline map.`);
      }
    }
    provider = new SvgMap(host, overview, size);
    if (scene) provider.render(scene);
  }

  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-basemap]");
    if (button && !button.disabled) {
      container.querySelectorAll("[data-basemap]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      options.onBasemap?.(button.dataset.basemap);
      build(button.dataset.basemap);
    }
    if (event.target.closest("[data-connect]")) {
      event.preventDefault();
      document.getElementById("about-open")?.click();
    }
  });

  const unsubscribe = onMapsFailure((reason) => {
    if (disposed) return;
    showNote(`${esc(reason)} Showing the offline map.`);
    container.querySelectorAll("[data-basemap]").forEach((b) => { b.disabled = true; b.title = "Needs internet"; b.setAttribute("aria-pressed", "false"); });
    provider?.destroy();
    provider = new SvgMap(host, overview, small ? { width: 420, height: 315 } : {});
    if (scene) provider.render(scene);
  });

  const ready = build(basemap);

  return {
    async setScene(next) {
      scene = next;
      await ready;
      if (disposed) return;
      provider?.render(scene);
      const focus = (scene.marks || [])[0] || (scene.stations || [])[0];
      if (focus && !small) {
        earthLink.href = googleEarthUrl(focus.lat, focus.lon, Math.max(80000, spanKm(boundsOf(scenePoints(scene))) * 1000));
        earthLink.hidden = false;
      }
    },
    async toPNG() {
      // Online tiles are cross-origin; always export the offline rendering of the same scene.
      const tmp = document.createElement("div");
      const svgMap = new SvgMap(tmp, overview);
      svgMap.render(scene);
      return svgMap.toPNG();
    },
    setDim(dim) { options.dim = dim; provider?.setDim?.(dim); },
    destroy() { disposed = true; unsubscribe(); provider?.destroy(); },
  };
}
