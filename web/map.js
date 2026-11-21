// Map views for QuakeTrace: Google Maps (map + satellite), Google 3D Earth, and an
// offline SVG fallback drawn from the bundled state outlines.

const SVG_NS = "http://www.w3.org/2000/svg";
const W = 800;
const KM_PER_DEG = 111.195;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- Google loader

let googlePromise = null;
let googleFailed = false;
const failureListeners = new Set();

export function googleMapsFailed() { return googleFailed; }
export function onGoogleFailure(listener) { failureListeners.add(listener); return () => failureListeners.delete(listener); }

function failGoogle(reason) {
  if (googleFailed) return;
  googleFailed = true;
  console.warn("Google Maps unavailable:", reason);
  failureListeners.forEach((listener) => listener(reason));
}

// Google calls this global when the key is rejected (bad key, referrer, or billing).
window.gm_authFailure = () => failGoogle("The Google Maps API key was rejected.");

export function loadGoogleMaps(key) {
  if (!key) return Promise.reject(new Error("No Google Maps API key."));
  if (googleFailed) return Promise.reject(new Error("Google Maps failed to load."));
  if (googlePromise) return googlePromise;
  googlePromise = new Promise((resolve, reject) => {
    const callback = "__quaketraceMapsReady";
    window[callback] = () => { delete window[callback]; resolve(window.google.maps); };
    const params = new URLSearchParams({ key, v: "beta", loading: "async", callback, libraries: "maps,marker" });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => { failGoogle("The Google Maps script could not load."); reject(new Error("Google Maps script failed.")); };
    document.head.append(script);
    setTimeout(() => { if (!window.google?.maps?.importLibrary) { failGoogle("Timed out loading Google Maps."); reject(new Error("Timeout")); } }, 15000);
  });
  return googlePromise;
}

export function googleEarthUrl(lat, lon, rangeM = 160000) {
  return `https://earth.google.com/web/@${lat.toFixed(5)},${lon.toFixed(5)},0a,${Math.round(rangeM)}d,35y,0h,45t,0r`;
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

// ---------------------------------------------------------------- Google 2D

function el(className, text) {
  const node = document.createElement("div");
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

class GoogleMap2D {
  constructor(host, config, { satellite = false, dim = 0 } = {}) {
    this.host = host;
    this.config = config;
    this.satellite = satellite;
    this.dim = dim;
    this.overlays = [];
    this.kind = "google";
  }

  async init() {
    const maps = await loadGoogleMaps(this.config.googleMapsKey);
    const { Map, GroundOverlay, Polyline, Rectangle } = await maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await maps.importLibrary("marker");
    Object.assign(this, { Map, GroundOverlay, Polyline, Rectangle, AdvancedMarkerElement, maps });
    this.map = new Map(this.host, {
      center: { lat: 40.8, lng: -74.6 }, zoom: 8,
      mapId: this.config.googleMapId || "DEMO_MAP_ID",
      mapTypeId: this.satellite ? "hybrid" : "roadmap",
      disableDefaultUI: true, zoomControl: true, fullscreenControl: true,
      gestureHandling: "cooperative", clickableIcons: false, tilt: 0,
    });
  }

  clear() {
    this.overlays.forEach((o) => { if ("map" in o) o.map = null; if (o.setMap) o.setMap(null); });
    this.overlays = [];
  }

  marker(position, content, title, zIndex = 1) {
    const m = new this.AdvancedMarkerElement({ map: this.map, position, content, title: title || "", zIndex });
    this.overlays.push(m);
    return m;
  }

  render(scene) {
    if (!this.map) return;
    this.clear();
    const ll = (lat, lon) => ({ lat, lng: lon });
    if (this.satellite && this.dim > 0) {
      const dimmer = new this.Rectangle({
        map: this.map, bounds: { south: 30, north: 50, west: -90, east: -60 },
        fillColor: "#FFFFFF", fillOpacity: this.dim / 100, strokeWeight: 0, clickable: false, zIndex: 0,
      });
      this.overlays.push(dimmer);
    }
    if (scene.zone) {
      const zone = new this.GroundOverlay(zoneImage(scene.zone), scene.zone.bounds, { clickable: false });
      zone.setMap(this.map);
      this.overlays.push(zone);
    }
    for (const link of scene.links || []) {
      const color = link.color || "#8A94A3";
      const icons = [];
      if (link.dashed) icons.push({ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: color, scale: 2 }, offset: "0", repeat: "9px" });
      if (link.arrow) icons.push({ icon: { path: this.maps.SymbolPath.FORWARD_OPEN_ARROW, scale: 3, strokeColor: color, strokeOpacity: 1 }, offset: "100%" });
      const line = new this.Polyline({
        map: this.map, path: [ll(link.a.lat, link.a.lon), ll(link.b.lat, link.b.lon)],
        strokeColor: color, strokeOpacity: link.dashed ? 0 : 0.95, strokeWeight: link.width || 2.5, icons, clickable: false, zIndex: 2,
      });
      this.overlays.push(line);
      if (link.label) {
        const tag = el("gm-km", link.label);
        tag.style.color = link.labelColor || color;
        this.marker(ll((link.a.lat + link.b.lat) / 2, (link.a.lon + link.b.lon) / 2), tag, link.label, 3);
      }
    }
    for (const s of scene.stations || []) {
      const wrap = el("gm-station");
      wrap.append(el(`gm-tri ${s.tone || ""}`), el(`gm-label ${s.tone === "suspect" ? "suspect" : ""}`, s.short));
      this.marker(ll(s.lat, s.lon), wrap, `${s.id} · ${s.name || ""}`, 4);
    }
    if (scene.outCircle) {
      const ring = el("gm-out");
      const tag = el("gm-label suspect", scene.outCircle.label);
      tag.style.cssText = "left:52px;top:10px;font-size:18px";
      ring.append(tag);
      this.marker(ll(scene.outCircle.lat, scene.outCircle.lon), ring, scene.outCircle.label, 5);
    }
    for (const m of scene.marks || []) {
      let node;
      if (m.kind === "star") {
        node = el("gm-star", "★");
      } else {
        node = el(`gm-ring ${m.kind === "ring-dashed" ? "dashed" : ""} ${m.kind === "ring-gray" ? "gray dashed" : ""}`);
      }
      if (m.label) {
        const tag = el(`gm-tag ${m.kind === "ring-gray" ? "gray" : ""}`, m.label);
        if (m.kind === "star") tag.style.cssText = "left:22px;top:0;color:#14181F;font-size:12px;font-weight:500";
        node.append(tag);
      }
      this.marker(ll(m.lat, m.lon), node, m.label, 6);
    }
    const b = boundsOf(scenePoints(scene));
    this.map.fitBounds(b, 56);
  }

  destroy() { this.clear(); }
}

// ---------------------------------------------------------------- Google 3D Earth

class GoogleEarth3D {
  constructor(host, config) {
    this.host = host;
    this.config = config;
    this.kind = "earth";
  }

  async init() {
    const maps = await loadGoogleMaps(this.config.googleMapsKey);
    const lib = await maps.importLibrary("maps3d");
    if (!lib?.Map3DElement) throw new Error("The 3D Maps library is not available for this key.");
    this.lib = lib;
    try { this.PinElement = (await maps.importLibrary("marker")).PinElement; } catch { /* optional */ }
  }

  setPath(element, points) {
    try { element.path = points; } catch { /* older builds */ }
    if (!element.path || !element.path.length) {
      try { element.coordinates = points; } catch { /* ignore */ }
    }
  }

  pin(marker, background, glyph) {
    if (!this.PinElement) return;
    try {
      const pin = new this.PinElement({ background, borderColor: "#FFFFFF", glyphColor: "#FFFFFF", glyph: glyph || "", scale: 1 });
      marker.append(pin);
    } catch { /* some builds do not accept pins on 3D markers */ }
  }

  render(scene) {
    const { Map3DElement, Marker3DElement, Polyline3DElement, Polygon3DElement } = this.lib;
    const b = boundsOf(scenePoints(scene));
    const centre = centreOf(b);
    const range = Math.max(60000, spanKm(b) * 1000 * 1.25);
    this.range = range;
    this.host.innerHTML = "";
    const map = new Map3DElement({
      center: { ...centre, altitude: 0 }, range, tilt: 52, heading: 8, mode: "HYBRID",
    });
    this.map = map;
    this.host.append(map);
    const add = (child) => { try { map.append(child); } catch (error) { console.warn(error); } };

    if (scene.zone?.hull?.length > 2 && Polygon3DElement) {
      const polygon = new Polygon3DElement({
        fillColor: "rgba(43, 191, 154, 0.45)", strokeColor: "#0B8A6C", strokeWidth: 3,
        altitudeMode: "CLAMP_TO_GROUND", drawsOccludedSegments: true,
      });
      const ring = scene.zone.hull.map(([lat, lng]) => ({ lat, lng }));
      try { polygon.path = ring; } catch { /* older builds */ }
      if (!polygon.path || !polygon.path.length) { try { polygon.outerCoordinates = ring; } catch { /* ignore */ } }
      add(polygon);
    }

    // Station-to-estimate rays read well in 3D and show the geometry the fit uses.
    const focus = (scene.marks || []).find((m) => m.kind === "ring") || (scene.marks || [])[0];
    for (const s of scene.stations || []) {
      if (focus && Polyline3DElement) {
        const ray = new Polyline3DElement({
          strokeColor: s.tone === "suspect" ? "rgba(232, 89, 12, 0.9)" : s.tone === "out" ? "rgba(154, 164, 178, 0.6)" : "rgba(255, 255, 255, 0.55)",
          strokeWidth: s.tone === "suspect" ? 4 : 2, altitudeMode: "CLAMP_TO_GROUND", drawsOccludedSegments: true,
        });
        this.setPath(ray, [{ lat: s.lat, lng: s.lon }, { lat: focus.lat, lng: focus.lon }]);
        add(ray);
      }
      const marker = new Marker3DElement({
        position: { lat: s.lat, lng: s.lon, altitude: 1200 }, altitudeMode: "RELATIVE_TO_GROUND", extruded: true,
        label: s.short,
      });
      this.pin(marker, s.tone === "suspect" ? "#E8590C" : s.tone === "out" ? "#9AA4B2" : "#4A5563");
      add(marker);
    }
    for (const link of scene.links || []) {
      if (!Polyline3DElement) break;
      const line = new Polyline3DElement({
        strokeColor: link.color || "#FFFFFF", strokeWidth: 5, altitudeMode: "CLAMP_TO_GROUND", drawsOccludedSegments: true,
      });
      this.setPath(line, [{ lat: link.a.lat, lng: link.a.lon }, { lat: link.b.lat, lng: link.b.lon }]);
      add(line);
    }
    for (const m of scene.marks || []) {
      const marker = new Marker3DElement({
        position: { lat: m.lat, lng: m.lon, altitude: m.kind === "star" ? 4000 : 2500 }, altitudeMode: "RELATIVE_TO_GROUND", extruded: true,
        label: m.label || (m.kind === "star" ? "USGS" : ""),
      });
      this.pin(marker, m.kind === "star" ? "#14181F" : m.kind === "ring-gray" ? "#8A94A3" : "#1F6FEB", m.kind === "star" ? "★" : "");
      add(marker);
    }
  }

  destroy() { this.host.innerHTML = ""; }
}

// ---------------------------------------------------------------- Map view widget

const BASEMAPS = [["map", "Map"], ["satellite", "Satellite"], ["earth", "Earth 3D"]];

/**
 * Build a map card inside `container`.
 * options: { overview, config, basemap, dim, small, onBasemap(kind) }
 */
export function createMapView(container, options) {
  const { overview, config, small = false } = options;
  const hasGoogle = Boolean(config.googleMapsKey) && !googleMapsFailed();
  const basemap = hasGoogle ? options.basemap || "map" : "map";
  container.innerHTML = `
    <div class="map-frame ${small ? "small" : ""}">
      <div class="map-host"></div>
      ${small ? "" : `<div class="basemap" role="group" aria-label="Basemap">${BASEMAPS.map(([key, label]) => `<button type="button" data-basemap="${key}" aria-pressed="${key === basemap}" ${!hasGoogle && key !== "map" ? 'disabled title="Connect Google Maps in About to enable"' : ""}>${label}</button>`).join("")}</div>`}
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
    if (kind !== "svg" && hasGoogle && !googleMapsFailed()) {
      try {
        provider = kind === "earth"
          ? new GoogleEarth3D(host, config)
          : new GoogleMap2D(host, config, { satellite: kind === "satellite", dim: options.dim || 0 });
        await provider.init();
        if (disposed) return;
        if (scene) provider.render(scene);
        if (kind === "earth") showNote('Photorealistic 3D needs the <strong>Map Tiles API</strong> on your key. Drag to orbit, scroll to zoom.');
        return;
      } catch (error) {
        console.warn(error);
        showNote(`${esc(error.message)} Showing the offline map.`);
      }
    }
    provider = new SvgMap(host, overview, size);
    if (scene) provider.render(scene);
    if (!hasGoogle && !small) showNote('Offline map · <a href="#" data-connect>Connect Google Maps</a> for street, satellite and 3D Earth views');
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

  const unsubscribe = onGoogleFailure((reason) => {
    if (disposed) return;
    showNote(`${esc(reason)} Showing the offline map.`);
    container.querySelectorAll("[data-basemap]").forEach((b) => { b.disabled = b.dataset.basemap !== "map"; b.setAttribute("aria-pressed", String(b.dataset.basemap === "map")); });
    provider?.destroy();
    provider = new SvgMap(host, overview, small ? { width: 420, height: 315 } : {});
    if (scene) provider.render(scene);
  });

  const ready = build(hasGoogle ? basemap : "svg");

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
      // Google tiles cannot be exported; always export the offline rendering of the same scene.
      const tmp = document.createElement("div");
      const svgMap = new SvgMap(tmp, overview);
      svgMap.render(scene);
      return svgMap.toPNG();
    },
    destroy() { disposed = true; unsubscribe(); provider?.destroy(); },
  };
}
