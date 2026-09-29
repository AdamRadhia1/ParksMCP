// ---------------------------------------------------------------------------
// City data around wherever the action is (the rat in rat mode, otherwise the
// map center), from Mapbox Streets v8 — the same data the basemap is drawn
// from, loaded through invisible layers so querySourceFeatures can read it
// (Standard's own layers sit inside a sealed style import):
//  - buildings: footprints, for the rat's collision and for cutting paths
//  - walkLines: sidewalks, footways, crosswalks, steps and pedestrian ways,
//    with any stretch that passes inside a building footprint cut out — the
//    only places NPCs walk
//  - food / apartments: named restaurants/cafes and apartment buildings, for
//    NPC suggestions and the rat's comments
//  - roads: the drivable street network for cars — junctions (nodes) joined
//    by stretches of road (edges), with one-way streets, and the traffic
//    signals and stop/yield signs from the same data attached to junctions
// Refreshed when the focus moves or new map tiles arrive.
//
// Requires map.js to have run first.
// ---------------------------------------------------------------------------
const CITY_SOURCE = 'city-data';
const CITY_RADIUS_M = 350;        // buildings + walk paths kept this far out
const CITY_ROAD_RADIUS_M = 450;   // drivable roads kept this far out
const CITY_PLACES_RADIUS_M = 800; // named places kept this far out
const CITY_REFRESH_MOVE_M = 60;
const CITY_MIN_ZOOM = 14.5;       // footpaths aren't in the tiles below this
const CITY_WALK_TYPES = new Set(['sidewalk', 'footway', 'crossing', 'steps', 'path', 'pedestrian']);
// Drivable road classes, ranked by size (bigger roads are busier and have
// the right of way at junctions without signs). Service roads — alleys,
// driveways, parking aisles — are left out.
const CITY_ROAD_RANK = {
  street_limited: 0, street: 1, tertiary: 2, secondary: 3, primary: 4, trunk: 5, motorway: 6,
  tertiary_link: 1, secondary_link: 2, primary_link: 2, trunk_link: 3, motorway_link: 3,
};
const CITY_ROAD_SNAP_M = 2;       // road ends closer than this are the same junction
const CITY_GRID_DEG = 0.0005;     // building index cell, roughly 45-55 m
const CITY_NODE_CELL_DEG = 0.0001; // junction index cell, roughly 9-11 m
const CITY_M_PER_DEG_LAT = 111320;

const city = {
  center: null,
  buildings: [],
  grid: new Map(),
  walkLines: [],
  roads: { nodes: [], edges: [], grid: new Map() },
  food: [],
  apartments: [],
  dirty: true,
  refreshedAt: -Infinity,

  focus() {
    return ratModeActive ? [ratState.lng, ratState.lat] : map.getCenter().toArray();
  },

  pointInBuilding(lng, lat) {
    const list = this.grid.get(cityCellKey(lng, lat));
    return !!list && list.some((b) =>
      lng >= b.bbox[0] && lng <= b.bbox[2] && lat >= b.bbox[1] && lat <= b.bbox[3] &&
      cityRingContains(b.rings[0], lng, lat) &&
      !b.rings.slice(1).some((hole) => cityRingContains(hole, lng, lat)) // courtyards
    );
  },

  walkLinesNear(lng, lat, meters) {
    const dLat = meters / CITY_M_PER_DEG_LAT, dLng = meters / (CITY_M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180));
    return this.walkLines.filter((l) => lng >= l.bbox[0] - dLng && lng <= l.bbox[2] + dLng && lat >= l.bbox[1] - dLat && lat <= l.bbox[3] + dLat);
  },

  // Closest point on a walk line: distance along it, and how far off it (m).
  nearestOnLine(line, lng, lat) {
    const cos = Math.cos(lat * Math.PI / 180);
    let best = { along: 0, off: Infinity };
    for (let i = 1; i < line.pts.length; i++) {
      const a = line.pts[i - 1], b = line.pts[i];
      const ax = (a.lng - lng) * CITY_M_PER_DEG_LAT * cos, ay = (a.lat - lat) * CITY_M_PER_DEG_LAT;
      const bx = (b.lng - lng) * CITY_M_PER_DEG_LAT * cos, by = (b.lat - lat) * CITY_M_PER_DEG_LAT;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      const off = Math.hypot(ax + dx * t, ay + dy * t);
      if (off < best.off) best = { along: line.cum[i - 1] + (line.cum[i] - line.cum[i - 1]) * t, off };
    }
    return best;
  },

  // Nearest `count` named places from `list` within maxM, closest first.
  placesNear(list, lng, lat, maxM, count) {
    return list
      .map((p) => ({ ...p, dist: cityMeters([lng, lat], [p.lng, p.lat]) }))
      .filter((p) => p.dist <= maxM)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, count);
  },

  // The road junction within maxM (up to ~8 m) of a point, or null.
  roadNodeNear(lng, lat, maxM) {
    return cityNearestNode(this.roads.grid, lng, lat, maxM);
  },
};

function cityMeters(a, b) {
  const cos = Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * CITY_M_PER_DEG_LAT * cos, (b[1] - a[1]) * CITY_M_PER_DEG_LAT);
}

function cityCellKey(lng, lat) {
  return Math.floor(lng / CITY_GRID_DEG) + ',' + Math.floor(lat / CITY_GRID_DEG);
}

function cityRingContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// [[lng, lat], ...] -> { pts: [{lng, lat}], cum: [meters], length, bbox }
function cityMakeLine(coords) {
  const pts = coords.map(([lng, lat]) => ({ lng, lat }));
  const cum = [0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  coords.forEach(([x, y], i) => {
    if (i > 0) cum.push(cum[i - 1] + cityMeters(coords[i - 1], coords[i]));
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  });
  return { pts, cum, length: cum[cum.length - 1], bbox: [minX, minY, maxX, maxY] };
}

// Samples a path every ~2.5 m and splits it wherever it passes inside a
// building, keeping the outside stretches that are long enough to walk.
function cityCutAroundBuildings(coords) {
  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2 && cityMakeLine(run).length >= 8) runs.push(run);
    run = [];
  };
  const visit = (pt) => { if (city.pointInBuilding(pt[0], pt[1])) flush(); else run.push(pt); };
  visit(coords[0]);
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const steps = Math.max(1, Math.ceil(cityMeters(a, b) / 2.5));
    for (let k = 1; k <= steps; k++) visit([a[0] + (b[0] - a[0]) * (k / steps), a[1] + (b[1] - a[1]) * (k / steps)]);
  }
  flush();
  return runs;
}

function cityPolygons(g) { return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
function cityLines(g) { return g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []; }

// ---------------------------------------------------------------------------
// Road network
// ---------------------------------------------------------------------------

// [w, s, e, n] of the map tile a queried feature came from. Tiles carry a
// margin of their neighbours' data, so a road crossing a tile edge shows up
// twice, overlapping, unless each copy is trimmed back to its own tile.
function cityTileBounds(f) {
  if (f._z === undefined) return null;
  const n = Math.pow(2, f._z);
  const lng = (x) => (x / n) * 360 - 180;
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lng(f._x), lat(f._y + 1), lng(f._x + 1), lat(f._y)];
}

// The parts of a line inside a [w, s, e, n] box (Liang-Barsky per segment).
function cityClipToBox(coords, [w, s, e, n]) {
  const runs = [];
  let run = null;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, inside = true;
    for (const [p, q] of [[-dx, x0 - w], [dx, e - x0], [-dy, y0 - s], [dy, n - y0]]) {
      if (p === 0) { if (q < 0) inside = false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) inside = false; else if (r > t0) t0 = r; }
      else if (r < t0) inside = false; else if (r < t1) t1 = r;
    }
    if (!inside) { run = null; continue; }
    if (!run || t0 > 0) { run = [[x0 + dx * t0, y0 + dy * t0]]; runs.push(run); }
    run.push([x0 + dx * t1, y0 + dy * t1]);
    if (t1 < 1) run = null;
  }
  return runs;
}

function cityNodeCell(lng, lat) {
  return Math.floor(lng / CITY_NODE_CELL_DEG) + ',' + Math.floor(lat / CITY_NODE_CELL_DEG);
}

function cityNearestNode(grid, lng, lat, maxM) {
  const gx = Math.floor(lng / CITY_NODE_CELL_DEG), gy = Math.floor(lat / CITY_NODE_CELL_DEG);
  let best = null, bestD = maxM;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      (grid.get(gx + i + ',' + (gy + j)) || []).forEach((node) => {
        const d = cityMeters([lng, lat], [node.lng, node.lat]);
        if (d <= bestD) { bestD = d; best = node; }
      });
    }
  }
  return best;
}

// Builds the drivable network from the 'road' features: junctions (nodes)
// wherever roads meet or end, joined by edges (a stretch of one road between
// two junctions, with its points in lng/lat and in local meters). Crossing
// streets meet at a point they share in the data; road ends within
// CITY_ROAD_SNAP_M of each other are joined, which also merges the copies of
// a road that come from overlapping tiles of different zoom levels. Signals
// and stop/yield signs are attached to the junction they belong to.
function cityBuildRoads(features, near) {
  const pieces = [], signals = [], stops = [], yields = [];
  features.forEach((f) => {
    const p = f.properties;
    if (f.geometry.type === 'Point') {
      const pt = f.geometry.coordinates;
      if (!near(pt[0], pt[1], CITY_ROAD_RADIUS_M)) return;
      if (p.class === 'traffic_signals') signals.push(pt);
      else if (p.class === 'stop_sign') stops.push(pt);
      else if (p.class === 'yield_sign') yields.push(pt);
      return;
    }
    if (!(p.class in CITY_ROAD_RANK) || p.structure === 'tunnel') return;
    const box = cityTileBounds(f);
    cityLines(f.geometry).forEach((coords) => {
      (box ? cityClipToBox(coords, box) : [coords]).forEach((c) => {
        if (c.length >= 2 && c.some(([x, y]) => near(x, y, CITY_ROAD_RADIUS_M))) pieces.push({ coords: c, p });
      });
    });
  });

  const key = ([x, y]) => x.toFixed(7) + ',' + y.toFixed(7);
  const uses = new Map(); // how many pieces pass through each point
  pieces.forEach(({ coords }) => new Set(coords.map(key)).forEach((k) => uses.set(k, (uses.get(k) || 0) + 1)));

  const nodes = [], grid = new Map(), edges = [];
  const nodeAt = ([lng, lat]) => {
    const found = cityNearestNode(grid, lng, lat, CITY_ROAD_SNAP_M);
    if (found) return found;
    const [x, z] = toLocalMeters(lng, lat);
    const node = { lng, lat, x, z, edges: [], signal: null, stopAll: false, stopEdges: new Set(), yieldEdges: new Set() };
    const cell = cityNodeCell(lng, lat);
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push(node);
    nodes.push(node);
    return node;
  };
  const addEdge = (coords, p) => {
    const a = nodeAt(coords[0]), b = nodeAt(coords[coords.length - 1]);
    const pts = coords.slice();
    pts[0] = [a.lng, a.lat];
    pts[pts.length - 1] = [b.lng, b.lat];
    const line = cityMakeLine(pts);
    if (line.length < 1 || (a === b && line.length < 10)) return;
    const oneway = p.oneway === 'true';
    const duplicate = a.edges.some((e) => Math.abs(e.length - line.length) < Math.max(3, line.length * 0.2) &&
      ((e.a === a && e.b === b) || (!oneway && !e.oneway && e.a === b && e.b === a)));
    if (duplicate) return;
    const edge = Object.assign(line, {
      a, b, oneway, cls: p.class, rank: CITY_ROAD_RANK[p.class], name: p.name || '',
      xz: pts.map(([lng, lat]) => toLocalMeters(lng, lat)),
    });
    a.edges.push(edge);
    if (b !== a) b.edges.push(edge);
    edges.push(edge);
  };
  pieces.forEach(({ coords, p }) => {
    let start = 0;
    for (let i = 1; i < coords.length; i++) {
      if (i === coords.length - 1 || uses.get(key(coords[i])) > 1) {
        addEdge(coords.slice(start, i + 1), p);
        start = i;
      }
    }
  });

  // Signs and signals sit either on the junction itself or on the approach
  // just before it — then they only apply to that approach.
  const junctions = nodes.filter((n) => n.edges.length >= 3);
  const nearestJunction = (pt, maxM) => {
    let best = null, bestD = maxM;
    junctions.forEach((n) => { const d = cityMeters(pt, [n.lng, n.lat]); if (d < bestD) { bestD = d; best = n; } });
    return best && { node: best, dist: bestD };
  };
  signals.forEach((pt) => {
    // Everything within 18 m shares the light: divided roads meet at a
    // cluster of junctions run by one signal.
    const seed = Math.abs(Math.sin(pt[0] * 12.9898 + pt[1] * 78.233) * 43758.5453) % 1;
    junctions.forEach((n) => {
      const d = cityMeters(pt, [n.lng, n.lat]);
      if (d < 18 && (!n.signal || d < n.signal.dist)) n.signal = { seed, dist: d };
    });
  });
  const attachSign = (pt, all, set) => {
    const hit = nearestJunction(pt, 25);
    if (!hit) return;
    if (hit.dist < 3) { all(hit.node); return; }
    let best = null, bestOff = 6;
    hit.node.edges.forEach((e) => { const { off } = city.nearestOnLine(e, pt[0], pt[1]); if (off < bestOff) { bestOff = off; best = e; } });
    if (best) set(hit.node).add(best);
  };
  stops.forEach((pt) => attachSign(pt, (n) => { n.stopAll = true; }, (n) => n.stopEdges));
  yields.forEach((pt) => attachSign(pt, (n) => n.edges.forEach((e) => n.yieldEdges.add(e)), (n) => n.yieldEdges));

  return { nodes, edges, grid };
}

function cityRefresh(focus, now) {
  const cos = Math.cos(focus[1] * Math.PI / 180);
  const near = (x, y, meters) =>
    Math.abs(x - focus[0]) * CITY_M_PER_DEG_LAT * cos < meters && Math.abs(y - focus[1]) * CITY_M_PER_DEG_LAT < meters;

  const buildings = [];
  const grid = new Map();
  map.querySourceFeatures(CITY_SOURCE, { sourceLayer: 'building' }).forEach((f) => {
    if (f.properties.underground === 'true') return;
    cityPolygons(f.geometry).forEach((rings) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      rings[0].forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
      // Keep it if any part of its footprint's box is within range.
      const cx = Math.min(maxX, Math.max(minX, focus[0])), cy = Math.min(maxY, Math.max(minY, focus[1]));
      if (!near(cx, cy, CITY_RADIUS_M + 20)) return;
      const b = { bbox: [minX, minY, maxX, maxY], rings };
      buildings.push(b);
      for (let gx = Math.floor(minX / CITY_GRID_DEG); gx <= Math.floor(maxX / CITY_GRID_DEG); gx++) {
        for (let gy = Math.floor(minY / CITY_GRID_DEG); gy <= Math.floor(maxY / CITY_GRID_DEG); gy++) {
          const key = gx + ',' + gy;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(b);
        }
      }
    });
  });
  city.buildings = buildings;
  city.grid = grid;

  const walkLines = [];
  const roadFeatures = map.querySourceFeatures(CITY_SOURCE, { sourceLayer: 'road' });
  roadFeatures.forEach((f) => {
    const p = f.properties;
    if ((p.class !== 'path' && p.class !== 'pedestrian') || !CITY_WALK_TYPES.has(p.type) || p.structure === 'tunnel') return;
    cityLines(f.geometry).forEach((coords) => {
      if (!coords.some(([x, y]) => near(x, y, CITY_RADIUS_M))) return;
      // `type` tells crosswalks apart, where people step out into the road.
      cityCutAroundBuildings(coords).forEach((run) => walkLines.push(Object.assign(cityMakeLine(run), { type: p.type })));
    });
  });
  city.walkLines = walkLines;
  city.roads = cityBuildRoads(roadFeatures, near);

  const food = [], apartments = [], seen = new Set();
  map.querySourceFeatures(CITY_SOURCE, { sourceLayer: 'poi_label' }).forEach((f) => {
    const p = f.properties;
    if (!p.name || seen.has(p.name) || f.geometry.type !== 'Point') return;
    const [lng, lat] = f.geometry.coordinates;
    if (!near(lng, lat, CITY_PLACES_RADIUS_M)) return;
    if (p.class === 'food_and_drink' && !/bar|nightclub|pub/i.test(p.type)) food.push({ name: p.name, lng, lat });
    else if (p.class === 'place_like' && /^(apartments|residential)$/i.test(p.type)) apartments.push({ name: p.name, lng, lat });
    else return;
    seen.add(p.name);
  });
  city.food = food;
  city.apartments = apartments;

  city.center = focus;
  city.refreshedAt = now;
  city.dirty = false;
}

function cityTick() {
  if (map.getZoom() < CITY_MIN_ZOOM) return;
  const focus = city.focus();
  const now = performance.now();
  const moved = !city.center || cityMeters(city.center, focus) > CITY_REFRESH_MOVE_M;
  if ((moved || city.dirty) && now - city.refreshedAt > 1500) cityRefresh(focus, now);
}

whenTerrainReady(() => {
  map.addSource(CITY_SOURCE, { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
  map.addLayer({ id: 'city-buildings', type: 'fill', source: CITY_SOURCE, 'source-layer': 'building', paint: { 'fill-opacity': 0 } });
  map.addLayer({ id: 'city-paths', type: 'line', source: CITY_SOURCE, 'source-layer': 'road', paint: { 'line-opacity': 0 } });
  map.addLayer({ id: 'city-places', type: 'circle', source: CITY_SOURCE, 'source-layer': 'poi_label', paint: { 'circle-opacity': 0, 'circle-radius': 0 } });
  map.on('sourcedata', (e) => { if (e.sourceId === CITY_SOURCE && e.tile) city.dirty = true; });
  setInterval(cityTick, 400);
});
