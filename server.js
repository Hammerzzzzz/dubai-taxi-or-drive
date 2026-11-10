// Dubai Taxi or Drive: a tiny server that serves the calculator and talks to Google Maps
// (Routes API + Places API) so the Google key never reaches the browser. No dependencies.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const DUBAI = { latitude: 25.2048, longitude: 55.2708 };

// ---- Salik gates. Approximate positions, refined at startup from Google Places when a key is set.
// `group`: gates in the same group are charged once per trip (Al Safa N/S, Al Mamzar N/S).
const GATES = [
  { id: "barsha",   name: "Al Barsha",              lat: 25.1150, lng: 55.1965, q: "Salik Al Barsha toll gate Sheikh Zayed Road" },
  { id: "safaN",    name: "Al Safa North",          lat: 25.1930, lng: 55.2615, q: "Salik Al Safa North toll gate", group: "safa" },
  { id: "safaS",    name: "Al Safa South",          lat: 25.1800, lng: 55.2450, q: "Salik Al Safa South toll gate", group: "safa" },
  { id: "garhoud",  name: "Al Garhoud Bridge",      lat: 25.2297, lng: 55.3290, q: "Salik Al Garhoud Bridge toll gate" },
  { id: "maktoum",  name: "Al Maktoum Bridge",      lat: 25.2425, lng: 55.3240, q: "Salik Al Maktoum Bridge toll gate" },
  { id: "airport",  name: "Airport Tunnel",         lat: 25.2310, lng: 55.3830, q: "Salik Airport Tunnel toll gate" },
  { id: "mamzarN",  name: "Al Mamzar North",        lat: 25.2930, lng: 55.3540, q: "Salik Al Mamzar North toll gate Al Ittihad Road", group: "mamzar" },
  { id: "mamzarS",  name: "Al Mamzar South",        lat: 25.2900, lng: 55.3520, q: "Salik Al Mamzar South toll gate Al Ittihad Road", group: "mamzar" },
  { id: "jebelali", name: "Jebel Ali",              lat: 25.0250, lng: 55.1000, q: "Salik Jebel Ali toll gate Sheikh Zayed Road" },
  { id: "bbc",      name: "Business Bay Crossing",  lat: 25.2264, lng: 55.3464, q: "Salik Business Bay Crossing toll gate Al Khail Road" },
];
// A route passing this close to a gate counts as going through it; wider when the position is only approximate
const radiusFor = g => (g.source || "").startsWith("Google") ? 150 : 400;

// ---- Geometry
function decodePolyline(str) {
  const pts = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}
function haversineM(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Distance from point p to segment ab, in metres (local flat projection is fine at this scale)
function segDistM(p, a, b) {
  const k = 111320, kx = k * Math.cos(p[0] * Math.PI / 180);
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * k, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * k;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function gatesOnRoute(points) {
  const hit = [];
  for (const g of GATES) {
    const p = [g.lat, g.lng];
    for (let i = 1; i < points.length; i++) {
      if (segDistM(p, points[i - 1], points[i]) <= radiusFor(g)) { hit.push({ g, at: i }); break; }
    }
  }
  hit.sort((x, y) => x.at - y.at);
  const seen = new Set(), out = [];
  for (const { g } of hit) {
    const key = g.group || g.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: g.id, name: g.group ? g.name.replace(/ (North|South)$/, "") : g.name });
  }
  return out;
}

// ---- Google calls
async function google(url, body, fieldMask) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, ...(fieldMask ? { "X-Goog-FieldMask": fieldMask } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    console.error("Google error", res.status, msg);
    const err = new Error(res.status === 403 ? "The Google Maps key was refused. Check the key and that Routes API and Places API (New) are enabled." : "Google Maps couldn't work out that route.");
    err.status = 502;
    throw err;
  }
  return data;
}

async function refineGates() {
  if (!KEY) return;
  for (const g of GATES) {
    try {
      const d = await google("https://places.googleapis.com/v1/places:searchText",
        { textQuery: g.q + " Dubai", locationBias: { circle: { center: { latitude: g.lat, longitude: g.lng }, radius: 5000 } }, maxResultCount: 3 },
        "places.displayName,places.location");
      const near = (d.places || [])
        .filter(p => /salik|toll/i.test(p.displayName?.text || ""))
        .map(p => ({ p, m: haversineM([g.lat, g.lng], [p.location.latitude, p.location.longitude]) }))
        .filter(x => x.m < 4000).sort((a, b) => a.m - b.m)[0];
      if (near) {
        g.lat = near.p.location.latitude; g.lng = near.p.location.longitude;
        g.source = `Google: ${near.p.displayName.text}`;
      } else g.source = "approximate";
    } catch { g.source = "approximate"; }
  }
  console.log("Salik gates:", GATES.map(g => `${g.name} ${g.lat.toFixed(4)},${g.lng.toFixed(4)} (${g.source})`).join(" | "));
}

function waypoint(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.placeId === "string" && /^[\w-]{10,300}$/.test(e.placeId)) return { placeId: e.placeId };
  if (Number.isFinite(e.lat) && Number.isFinite(e.lng) && Math.abs(e.lat) <= 90 && Math.abs(e.lng) <= 180)
    return { location: { latLng: { latitude: e.lat, longitude: e.lng } } };
  if (typeof e.address === "string" && e.address.trim().length >= 2) return { address: e.address.trim().slice(0, 200) };
  return null;
}

// ---- Small in-memory cache and per-IP rate limit, to keep the Google bill predictable
const cache = new Map();
function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { value, until: Date.now() + ms });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}
const hits = new Map();
function limited(ip, kind, max) {
  const k = ip + kind, now = Date.now(), win = 10 * 60e3;
  const arr = (hits.get(k) || []).filter(t => now - t < win);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}

async function routeHandler(body) {
  const origin = waypoint(body.from), destination = waypoint(body.to);
  if (!origin || !destination) { const e = new Error("Enter both a starting and a finishing point."); e.status = 400; throw e; }
  const req = { origin, destination, travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", regionCode: "AE", languageCode: "en" };
  const depart = body.departAt ? new Date(body.departAt) : null;
  if (depart && depart.getTime() > Date.now() && depart.getTime() < Date.now() + 14 * 864e5) req.departureTime = depart.toISOString();
  // Round departure to 15 minutes for caching
  const slot = req.departureTime ? Math.round(new Date(req.departureTime).getTime() / 9e5) : "now";
  const key = "r:" + JSON.stringify([origin, destination, slot]);
  return cached(key, 15 * 60e3, async () => {
    const d = await google("https://routes.googleapis.com/directions/v2:computeRoutes", req,
      "routes.distanceMeters,routes.duration,routes.staticDuration,routes.description,routes.polyline.encodedPolyline,routes.legs.startLocation,routes.legs.endLocation");
    const r = d.routes?.[0];
    if (!r) { const e = new Error("Google Maps found no driving route between those points."); e.status = 404; throw e; }
    const pts = decodePolyline(r.polyline.encodedPolyline);
    const leg = r.legs?.[0] || {};
    const sec = s => parseInt(String(s || "0").replace("s", ""), 10) || 0;
    return {
      distanceKm: Math.round(r.distanceMeters / 100) / 10,
      durationMin: Math.round(sec(r.duration) / 6) / 10,
      staticDurationMin: Math.round(sec(r.staticDuration || r.duration) / 6) / 10,
      description: r.description || "",
      gates: gatesOnRoute(pts),
      start: { lat: leg.startLocation?.latLng?.latitude ?? pts[0][0], lng: leg.startLocation?.latLng?.longitude ?? pts[0][1] },
      end: { lat: leg.endLocation?.latLng?.latitude ?? pts.at(-1)[0], lng: leg.endLocation?.latLng?.longitude ?? pts.at(-1)[1] },
      departAt: req.departureTime || null,
    };
  });
}

async function autocompleteHandler(q, session) {
  q = String(q || "").trim().slice(0, 120);
  if (q.length < 3) return { suggestions: [] };
  return cached("a:" + q.toLowerCase(), 60 * 60e3, async () => {
    const d = await google("https://places.googleapis.com/v1/places:autocomplete", {
      input: q, includedRegionCodes: ["ae"], languageCode: "en",
      locationBias: { circle: { center: DUBAI, radius: 50000 } },
      ...(session && /^[\w-]{8,64}$/.test(session) ? { sessionToken: session } : {}),
    });
    return {
      suggestions: (d.suggestions || []).filter(s => s.placePrediction).slice(0, 6)
        .map(s => ({ placeId: s.placePrediction.placeId, text: s.placePrediction.text?.text || "" })),
    };
  });
}

// ---- HTTP
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 10000) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { reject(Object.assign(new Error("Bad request"), { status: 400 })); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  try {
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, googleKey: !!KEY, gates: GATES.map(({ q, ...g }) => g) });
    if (url.pathname.startsWith("/api/") && !KEY) return send(res, 503, { error: "Google Maps isn't set up on the server yet." });
    if (url.pathname === "/api/route" && req.method === "POST") {
      if (limited(ip, "r", 60)) return send(res, 429, { error: "Too many route lookups. Wait a few minutes." });
      return send(res, 200, await routeHandler(await readBody(req)));
    }
    if (url.pathname === "/api/autocomplete" && req.method === "GET") {
      if (limited(ip, "a", 300)) return send(res, 429, { error: "Too many searches. Wait a few minutes." });
      return send(res, 200, await autocompleteHandler(url.searchParams.get("q"), url.searchParams.get("session")));
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    // Static files
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return send(res, 400, { error: "Bad path" });
    const file = await readFile(join(PUBLIC, path)).catch(() => null);
    if (!file) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "public, max-age=300" });
    res.end(file);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the server." });
  }
});

server.listen(PORT, () => {
  console.log(`Dubai Taxi or Drive on http://localhost:${PORT} (Google key ${KEY ? "set" : "MISSING"})`);
  refineGates();
});
