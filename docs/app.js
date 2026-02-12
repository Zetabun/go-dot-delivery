/* ============================================================
  Go Dot Delivery – Hub Routing Prototype (Serverless)

  THIS BUILD IS SET UP TO:
  1) Run fully as static files (GitHub Pages / python http.server).
  2) Hide nodes/hubs from players. The "CPU dispatcher" chooses routes.
  3) Let vehicles follow REAL roads once you generate "real" polylines.

  ---------------------------------------------------------------
  DATA MODEL (for future you / future GPTs)
  ---------------------------------------------------------------
  LOCATIONS (player-facing)
    - depots, businesses, fuel stops, garages, services.
    - jobs are always location -> location.

  HUBS (internal routing nodes)
    - a smaller set of nodes forming a graph.
    - each location is assigned to its nearest hub (location.hubId).

  ROUTING
    - We route *between hubs* using A* (fast and scalable).
    - Then we STITCH polylines:
        location -> hub(location)
        hub -> hub -> hub ...
        hub(destination) -> destination

  "REAL ROADS" UPGRADE PATH
    - This prototype prefers:
        /data/edges.real.json                (hub edges with OSRM road polylines)
        /data/location_links.real.json       (location<->hub road polylines)
    - If those files don't exist yet, it falls back to:
        /data/edges.json                     (fake polylines)
        straight lines for location<->hub

  ---------------------------------------------------------------
  HOW TO GENERATE REAL FILES (offline, one-time)
  ---------------------------------------------------------------
  Use tools/precompute_real_routes.py (provided in the zip I sent).
  It queries a router to output edges.real.json + location_links.real.json.
============================================================ */

(async function main() {
  // ---------- UI ----------
  const fuelText = document.getElementById("fuelText");
  const durText = document.getElementById("durText");
  const fuelBar = document.getElementById("fuelBar");
  const durBar = document.getElementById("durBar");
  const jobText = document.getElementById("jobText");
  const logEl = document.getElementById("log");
  const startJobBtn = document.getElementById("startJobBtn");
  const refuelBtn = document.getElementById("refuelBtn");


  // ---------- HUD Status (non-intrusive) ----------
  // We inject a small status line into the HUD so you can immediately tell
  // whether the prototype is using REAL polylines or fallback data.
  // This avoids "is it working?" confusion when switching between datasets.
  const hud = document.querySelector(".hud");
  const statusEl = document.createElement("div");
  statusEl.id = "dataStatus";
  statusEl.style.cssText = "margin-top:6px;margin-bottom:8px;font-size:12px;opacity:.85";
  hud.insertBefore(statusEl, hud.children[1]); // insert after title row

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    const div = document.createElement("div");
    div.textContent = `[${t}] ${msg}`;
    logEl.prepend(div);
  }

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // ---------- Helpers ----------
  async function fetchJsonOrNull(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  // ---------- Load Data (prefer real, fallback to basic) ----------
  const locationsData = await (await fetch("./data/locations.json")).json();
  const hubsData = await (await fetch("./data/hubs.json")).json();

  const edgesReal = await fetchJsonOrNull("./data/edges.real.json");
  const edgesBase = edgesReal ?? await (await fetch("./data/edges.json")).json();

  const linksReal = await fetchJsonOrNull("./data/location_links.real.json");

  const locations = new Map(locationsData.locations.map(x => [x.id, x]));
  const hubs = new Map(hubsData.hubs.map(x => [x.id, x]));

  // Build adjacency list for the hub graph
  const adjacency = new Map(); // hubId -> array of {from,to,distance_m,duration_s,polyline}
  for (const h of hubs.keys()) adjacency.set(h, []);

  for (const e of edgesBase.edges) {
    if (!adjacency.has(e.from) || !adjacency.has(e.to)) {
      console.warn("Edge references unknown hub:", e);
      continue;
    }
    adjacency.get(e.from).push({ ...e, to: e.to });
    adjacency.get(e.to).push({
      from: e.to,
      to: e.from,
      distance_m: e.distance_m,
      duration_s: e.duration_s,
      polyline: [...e.polyline].reverse()
    });
  }

  // Location<->Hub link lookup (optional real-road links)
  // Key format: "FROM->TO" where FROM can be a locationId or hubId.
  const locLinkMap = new Map();
  if (linksReal?.links) {
    for (const link of linksReal.links) {
      locLinkMap.set(`${link.from}->${link.to}`, link);
      locLinkMap.set(`${link.to}->${link.from}`, {
        from: link.to,
        to: link.from,
        distance_m: link.distance_m,
        duration_s: link.duration_s,
        polyline: [...link.polyline].reverse()
      });
    }
    log("Loaded real location↔hub links (location_links.real.json).");
  } else {
    log("No location_links.real.json found — using straight-line location↔hub links for now.");
  }

  if (edgesReal) log("Loaded real hub edges (edges.real.json).");
  else log("No edges.real.json found — using edges.json fallback polylines for now.");


  // Update the HUD status line
  const edgesMode = edgesReal ? "REAL hub edges" : "FALLBACK hub edges";
  const linksMode = linksReal?.links ? "REAL loc↔hub links" : "STRAIGHT loc↔hub links";
  statusEl.textContent = `Data: ${edgesMode} • ${linksMode}`;


  // ---------- Map ----------
  const map = L.map("map").setView([52.4862, -1.8904], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);


  // ---------- Locked Region Mask (prototype gating) ----------
  // This greys-out the world outside your initial playable area.
  // Later you can unlock expansion by removing or enlarging this polygon.
  //
  // NOTE: Coordinates below are an approximate Birmingham bounding polygon.
  // You can tweak these corners to match the exact area you want available at launch.
  const playableBounds = [
    [52.402, -2.022], // SW
    [52.402, -1.740], // SE
    [52.585, -1.740], // NE
    [52.585, -2.022]  // NW
  ];

  // Create a "world" polygon with a hole (Leaflet polygon holes)
  const world = [
    [[90, -180],[90, 180],[-90, 180],[-90, -180]],  // outer ring (covers the world)
    playableBounds                                            // inner ring (hole = playable area)
  ];

  // Grey overlay outside playable area
  L.polygon(world, {
    stroke: false,
    fillColor: "#0b0f14",
    fillOpacity: 0.72,
    interactive: false
  }).addTo(map);

  // Optional: constrain panning a bit so you don't get lost
  map.setMaxBounds(L.latLngBounds(playableBounds));
  map.on("drag", () => map.panInsideBounds(map.getMaxBounds(), { animate: false }));


  // ---------- Marker helpers ----------
  const icon = (color) => L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:999px;background:${color};border:2px solid #000;box-shadow:0 2px 6px rgba(0,0,0,.45);transform:translate(-50%,-50%);"></div>`,
    iconSize: [14,14],
    iconAnchor: [7,7]
  });

  // Render locations (player-facing)
  for (const loc of locations.values()) {
    const color =
      loc.type === "depot" ? "#6bb7ff" :
      loc.type === "business" ? "#ff7ab6" :
      loc.type === "fuel" ? "#69ff9a" :
      loc.type === "garage" ? "#cfcfcf" :
      "#cfcfcf";

    L.marker([loc.lat, loc.lng], { icon: icon(color) })
      .addTo(map)
      .bindPopup(`<b>${loc.name}</b><br/>Type: ${loc.type}<br/>Hub: ${loc.hubId}`);
  }

  // ---------- Game State ----------
  const state = {
    vehicle: {
      pos: { lng: locations.get("DEPOT_BHAM").lng, lat: locations.get("DEPOT_BHAM").lat },
      // Track the last known POI the van is at (for leg planning / persistence)
      currentLocationId: "DEPOT_BHAM",
      fuel: 8, fuelMax: 100,   // low fuel on purpose (forces dispatcher to refuel)
      dur: 88, durMax: 100,
      speedMps: 12.5,
      fuelPerKm: 3.0,
      durPerKm: 0.8
    },
    currentLocId: "DEPOT_BHAM", // IMPORTANT: track where the van currently is (as a location id)
    job: {
      id: "JOB-0001",
      fromId: "DEPOT_BHAM",
      toId: "BIZ_OPACE",
      pay: 120,
      status: "AVAILABLE" // AVAILABLE, IN_PROGRESS, DONE
    },
    route: [],
    routeIndex: 0,
    mode: "IDLE", // IDLE, REFUELING, DELIVERING
    ui: { routeLine: null }
  };

  const vanMarker = L.marker([state.vehicle.pos.lat, state.vehicle.pos.lng], {
    icon: L.divIcon({
      className: "",
      html: `<div style="width:18px;height:18px;border-radius:6px;background:#ffd54a;border:2px solid #000;box-shadow:0 2px 6px rgba(0,0,0,.5);transform:translate(-50%,-50%);"></div>`,
      iconSize: [18,18],
      iconAnchor: [9,9]
    })
  }).addTo(map).bindPopup("<b>Van</b><br/>Auto-routed via hub graph.");

  // ---------- Persistence (so refresh doesn't reset progress) ----------
  // We store a small snapshot in localStorage. This is perfect for prototypes (GitHub Pages).
  // NOTE: We intentionally do NOT store the full datasets (hubs/edges). Only the game state.
  const STORAGE_KEY = "goDotDelivery_state_v1";

  function saveState() {
    try {
      const snapshot = {
        vehicle: {
          pos: state.vehicle.pos,
          fuel: state.vehicle.fuel,
          dur: state.vehicle.dur,
          currentLocationId: state.vehicle.currentLocationId
        },
        job: state.job,
        mode: state.mode,
        route: state.route,
        routeIndex: state.routeIndex
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Ignore storage errors (private browsing, etc.)
    }
  }
  
  // Save immediately when the user refreshes/closes the tab
window.addEventListener("beforeunload", () => {
  saveState();
});

// Save on pagehide as well (more reliable on some browsers, especially mobile/Safari)
window.addEventListener("pagehide", () => {
  saveState();
});

// Save if the tab becomes hidden (common on mobile / when switching tabs)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveState();
});


  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const snap = JSON.parse(raw);

      if (snap?.vehicle?.pos) state.vehicle.pos = snap.vehicle.pos;
      if (typeof snap?.vehicle?.fuel === "number") state.vehicle.fuel = snap.vehicle.fuel;
      if (typeof snap?.vehicle?.dur === "number") state.vehicle.dur = snap.vehicle.dur;
      if (typeof snap?.vehicle?.currentLocationId === "string") state.vehicle.currentLocationId = snap.vehicle.currentLocationId;

      if (snap?.job) state.job = snap.job;
      if (typeof snap?.mode === "string") state.mode = snap.mode;

      if (Array.isArray(snap?.route)) state.route = snap.route;
      if (typeof snap?.routeIndex === "number") state.routeIndex = snap.routeIndex;

      return true;
    } catch {
      return false;
    }
  }

// Restore previous session (if any) so a refresh doesn't wipe progress.
  const restored = loadState();
  if (restored) {
    vanMarker.setLatLng([state.vehicle.pos.lat, state.vehicle.pos.lng]);
    log("Restored saved session from localStorage.");
    if (state.route && state.route.length >= 2 && state.routeIndex < state.route.length - 1) {
      drawRoute(state.route);
      log(`Continuing route after refresh (mode: ${state.mode}).`);
    }
  } else {
    log("No saved session found — starting fresh.");
  }

  // ---------- UI ----------
  function updateUI() {
    fuelText.textContent = `${Math.round(state.vehicle.fuel)} / ${state.vehicle.fuelMax}`;
    durText.textContent  = `${Math.round(state.vehicle.dur)} / ${state.vehicle.durMax}`;
    fuelBar.style.width = `${clamp(state.vehicle.fuel / state.vehicle.fuelMax * 100, 0, 100)}%`;
    durBar.style.width  = `${clamp(state.vehicle.dur / state.vehicle.durMax * 100, 0, 100)}%`;

    const j = state.job;
    const from = locations.get(j.fromId);
    const to = locations.get(j.toId);

    if (j.status === "AVAILABLE") {
      jobText.innerHTML = `<b>${j.id}</b> — ${from.name} → ${to.name}<br/>Pay: £${j.pay}<br/><i>Status: Available</i>`;
    } else if (j.status === "IN_PROGRESS") {
      jobText.innerHTML = `<b>${j.id}</b> — In progress<br/><i>Current: ${state.mode}</i>`;
    } else {
      jobText.innerHTML = `<b>${j.id}</b> — Completed ✅<br/>Earned: £${j.pay}`;
    }

    startJobBtn.disabled = !(j.status === "AVAILABLE" && state.mode === "IDLE");
    refuelBtn.disabled = !(state.mode === "IDLE");
  }


  // ---------- Geometry ----------
  function haversineMeters(aLng, aLat, bLng, bLat) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLng - aLng);
    const lat1 = toRad(aLat), lat2 = toRad(bLat);
    const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function polylineDistanceMeters(coords) {
    let total = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [aLng, aLat] = coords[i];
      const [bLng, bLat] = coords[i + 1];
      total += haversineMeters(aLng, aLat, bLng, bLat);
    }
    return total;
  }

  // ---------- HUB GRAPH PATHFINDING (A*) ----------
  function aStarHubPath(startHubId, goalHubId) {
    const h = (hubId) => {
      const p = hubs.get(hubId);
      const g = hubs.get(goalHubId);
      return haversineMeters(p.lng, p.lat, g.lng, g.lat);
    };

    const open = new Set([startHubId]);
    const cameFrom = new Map();
    const gScore = new Map([[startHubId, 0]]);
    const fScore = new Map([[startHubId, h(startHubId)]]);

    function lowestFScoreNode() {
      let best = null;
      let bestVal = Infinity;
      for (const n of open) {
        const v = fScore.get(n) ?? Infinity;
        if (v < bestVal) { bestVal = v; best = n; }
      }
      return best;
    }

    while (open.size > 0) {
      const current = lowestFScoreNode();
      if (!current) break;

      if (current === goalHubId) {
        const path = [current];
        let c = current;
        while (cameFrom.has(c)) {
          c = cameFrom.get(c);
          path.push(c);
        }
        path.reverse();
        return path;
      }

      open.delete(current);

      for (const edge of adjacency.get(current) || []) {
        const tentative = (gScore.get(current) ?? Infinity) + (edge.distance_m ?? 0);
        if (tentative < (gScore.get(edge.to) ?? Infinity)) {
          cameFrom.set(edge.to, current);
          gScore.set(edge.to, tentative);
          fScore.set(edge.to, tentative + h(edge.to));
          open.add(edge.to);
        }
      }
    }

    return null;
  }

  function buildPolylineFromHubPath(hubPath) {
    const coords = [];
    for (let i = 0; i < hubPath.length - 1; i++) {
      const a = hubPath[i];
      const b = hubPath[i + 1];
      const edge = (adjacency.get(a) || []).find(e => e.to === b);
      if (!edge) throw new Error(`Missing edge polyline for ${a} -> ${b}`);

      if (i === 0) coords.push(...edge.polyline);
      else coords.push(...edge.polyline.slice(1));
    }
    return coords;
  }

  // Location↔Hub polylines: real if available, else straight-line fallback.
  function locationToHubPolyline(locId) {
    const loc = locations.get(locId);
    const hub = hubs.get(loc.hubId);

    const key = `${locId}->${loc.hubId}`;
    const link = locLinkMap.get(key);

    return link?.polyline ?? [[loc.lng, loc.lat], [hub.lng, hub.lat]];
  }

  function hubToLocationPolyline(locId) {
    const loc = locations.get(locId);
    const hub = hubs.get(loc.hubId);

    const key = `${loc.hubId}->${locId}`;
    const link = locLinkMap.get(key);

    return link?.polyline ?? [[hub.lng, hub.lat], [loc.lng, loc.lat]];
  }

  // Build full polyline: Location -> hubs -> Location
  function planRouteBetweenLocations(fromLocId, toLocId) {
    const fromHub = locations.get(fromLocId).hubId;
    const toHub = locations.get(toLocId).hubId;

    const hubPath = aStarHubPath(fromHub, toHub);
    if (!hubPath) throw new Error(`No hub route found: ${fromHub} -> ${toHub}`);

    const lineA = locationToHubPolyline(fromLocId);
    const lineHub = buildPolylineFromHubPath(hubPath);
    const lineB = hubToLocationPolyline(toLocId);

    const stitched = [
      ...lineA,
      ...lineHub.slice(1),
      ...lineB.slice(1)
    ];

    if (stitched.length < 2) throw new Error("Planned route has too few points.");
    return stitched;
  }

  function drawRoute(routeLngLat) {
    const latlngs = routeLngLat.map(([lng, lat]) => [lat, lng]);
    if (state.ui.routeLine) map.removeLayer(state.ui.routeLine);
    state.ui.routeLine = L.polyline(latlngs, { weight: 5, opacity: 0.85 }).addTo(map);
  }

  // ---------- CPU DISPATCHER ----------
  function getFuelStations() {
    return [...locations.values()].filter(l => l.type === "fuel");
  }

  function pickBestFuelStop(fromLocId, toLocId) {
    // Simple scoring: smallest total hub-path distance (from -> fuel -> to).
    const fuelStops = getFuelStations();
    const fromHub = locations.get(fromLocId).hubId;
    const toHub = locations.get(toLocId).hubId;

    let best = null;
    let bestScore = Infinity;

    for (const fs of fuelStops) {
      const fsHub = fs.hubId;
      const p1 = aStarHubPath(fromHub, fsHub);
      const p2 = aStarHubPath(fsHub, toHub);
      if (!p1 || !p2) continue;

      const d1 = hubPathDistanceMeters(p1);
      const d2 = hubPathDistanceMeters(p2);
      const score = d1 + d2;

      if (score < bestScore) { bestScore = score; best = fs; }
    }
    return best;
  }

  function hubPathDistanceMeters(hubPath) {
    let total = 0;
    for (let i = 0; i < hubPath.length - 1; i++) {
      const a = hubPath[i], b = hubPath[i+1];
      const edge = (adjacency.get(a) || []).find(e => e.to === b);
      total += edge?.distance_m ?? 0;
    }
    // If the edges don't have distance_m (should), fallback to geometry.
    if (total === 0) {
      const poly = buildPolylineFromHubPath(hubPath);
      return polylineDistanceMeters(poly);
    }
    return total;
  }

  function estimateFuelNeeded(fromLocId, toLocId) {
    // Use geometry distance so it works for both real and fake polylines.
    const poly = planRouteBetweenLocations(fromLocId, toLocId);
    const km = polylineDistanceMeters(poly) / 1000;
    return km * state.vehicle.fuelPerKm;
  }

  function setRouteTo(targetLocId, mode) {
    state.mode = mode;
    state.nextLocId = targetLocId; // track where this leg ends
    state.route = planRouteBetweenLocations(state.currentLocId, targetLocId);
    state.routeIndex = 0;
    drawRoute(state.route);
    saveState();
  }

  function dispatchJob() {
    const j = state.job;
    const destination = j.toId;

    // If fuel too low to safely reach destination, insert a fuel stop first.
    const fuelNeeded = estimateFuelNeeded(state.currentLocId, destination);
    const buffer = 10;

    if (state.vehicle.fuel < fuelNeeded + buffer) {
      const fs = pickBestFuelStop(state.currentLocId, destination);
      if (!fs) throw new Error("No fuel stop reachable in current hub graph.");
      log(`Dispatcher: low fuel (${state.vehicle.fuel.toFixed(0)}). Detouring to "${fs.name}".`);
      setRouteTo(fs.id, "REFUELING");
      return;
    }

    log(`Dispatcher: routing to delivery "${locations.get(destination).name}".`);
    setRouteTo(destination, "DELIVERING");
  }

  // Manual override: send to fuel now (from current location)
  function sendToFuelNow() {
    const j = state.job;
    const fs = pickBestFuelStop(state.currentLocId, j.toId);
    if (!fs) throw new Error("No fuel stop reachable.");
    log(`Manual: routing to "${fs.name}".`);
    setRouteTo(fs.id, "REFUELING");
  }

  // ---------- Movement ----------
  function applyCosts(meters) {
    const km = meters / 1000;
    state.vehicle.fuel = clamp(state.vehicle.fuel - state.vehicle.fuelPerKm * km, 0, state.vehicle.fuelMax);
    state.vehicle.dur  = clamp(state.vehicle.dur  - state.vehicle.durPerKm  * km, 0, state.vehicle.durMax);
  }

  function clearRoute() {
    state.route = [];
    state.routeIndex = 0;
    state.nextLocId = null;
    if (state.ui.routeLine) { map.removeLayer(state.ui.routeLine); state.ui.routeLine = null; }
  }

  function arrive() {
    // Mark that we've reached the planned leg target.
    if (state.legTargetId) {
      state.vehicle.currentLocationId = state.legTargetId;
    }
    state.legTargetId = null;

    // When we finish the current route leg, we have arrived at nextLocId.
    if (state.nextLocId) state.currentLocId = state.nextLocId;

    if (state.mode === "REFUELING") {
      state.vehicle.fuel = state.vehicle.fuelMax;
      log(`Arrived at "${locations.get(state.currentLocId).name}". Fuel restored to full.`);
      clearRoute();
      state.mode = "IDLE";

      if (state.job.status === "IN_PROGRESS") {
        log("Dispatcher: continuing job after refuel...");
        dispatchJob();
      }
      return;
    }

    if (state.mode === "DELIVERING") {
      state.job.status = "DONE";
      log(`Delivered ✅ Earned £${state.job.pay}.`);
      clearRoute();
      state.mode = "IDLE";
      return;
    }

    // Fallback
    clearRoute();
    state.mode = "IDLE";
  }

  let lastTs = performance.now();

  let saveAccumulator = 0; // seconds

  function tick(ts) {
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;

    if (state.route.length >= 2 && state.routeIndex < state.route.length - 1) {
      let remaining = state.vehicle.speedMps * dt;

      while (remaining > 0 && state.routeIndex < state.route.length - 1) {
        const [aLng, aLat] = state.route[state.routeIndex];
        const [bLng, bLat] = state.route[state.routeIndex + 1];

        const seg = haversineMeters(aLng, aLat, bLng, bLat);
        if (seg < 0.3) { state.routeIndex++; continue; }

        if (remaining >= seg) {
          state.vehicle.pos = { lng: bLng, lat: bLat };
          state.routeIndex++;
          applyCosts(seg);
          remaining -= seg;
        } else {
          const t = remaining / seg;
          const newLng = aLng + (bLng - aLng) * t;
          const newLat = aLat + (bLat - aLat) * t;

          // CRITICAL: carry partial progress forward.
          // OSRM polylines can be long; if we don't "consume" part of the current segment,
          // the next animation frame would start from the same segment start again, making
          // the van appear stuck. By overwriting the current point with the interpolated
          // point, we advance along the polyline smoothly without needing extra state.
          state.vehicle.pos = { lng: newLng, lat: newLat };
          state.route[state.routeIndex] = [newLng, newLat];

          applyCosts(remaining);
          remaining = 0;
        }
      }

      vanMarker.setLatLng([state.vehicle.pos.lat, state.vehicle.pos.lng]);

      if (state.routeIndex >= state.route.length - 1) {
        arrive();
      }
    }

    updateUI();

    // Persist state roughly once per second while running.
    saveAccumulator += dt;
    if (saveAccumulator >= 1) {
      saveState();
      saveAccumulator = 0;
    }

    requestAnimationFrame(tick);
  }

  // ---------- Buttons ----------
  startJobBtn.addEventListener("click", () => {
    if (state.job.status !== "AVAILABLE" || state.mode !== "IDLE") return;
    state.job.status = "IN_PROGRESS";
    log(`Accepted ${state.job.id}. Dispatcher planning route...`);
    try {
      dispatchJob();
    } catch (e) {
      log(`Routing error: ${e.message}`);
      console.error(e);
    }
    updateUI();
  });

  refuelBtn.addEventListener("click", () => {
    if (state.mode !== "IDLE") return;
    try {
      sendToFuelNow();
    } catch (e) {
      log(`Routing error: ${e.message}`);
      console.error(e);
    }
    updateUI();
  });

  // Start
  log("Loaded. Click Start Job.");
  updateUI();
  requestAnimationFrame(tick);
})();
