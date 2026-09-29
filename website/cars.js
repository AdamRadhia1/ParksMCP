// ---------------------------------------------------------------------------
// Cars — Kenney's Car Kit (CC0), from the "GLB format" folder: sedans, SUVs,
// taxis, vans, pickups, delivery trucks, and now and then a police car,
// garbage truck, ambulance or fire truck. All of a model's parts (body,
// wheels, doors…) share one texture, so each model is merged into a single
// mesh — one draw call per car. The models face +Z.
//
// Driving: cars only ever drive on real streets — city.js's road network,
// built from Mapbox Streets (alleys, driveways and tunnels left out). They
// keep to the right-hand lane, obey one-way streets, pick a street at every
// junction and round the corner as they turn. Like the walkers, a population
// is kept around you (the rat, or the map center), and busier roads get more
// of it.
//
// Traffic: speed comes from the Intelligent Driver Model — each car eases in
// behind whatever is ahead on its route (another car, a person, the rat) and
// stops at red lights, stop signs, and junctions where it has to give way.
// So cars queue at the lights, take turns at stop signs, back up behind a
// double-parked delivery truck, and never drive into anyone: people on
// crosswalks and anyone else in the road get waited for.
//
// Talk: drivers chat about DC (researched news, sports and neighborhood talk
// in dialogue.json — dated lines retire themselves), grumble about the street
// they're stuck on, and freak out when Washington runs by.
//
// Requires map.js, actors.js, talk.js, city.js, rat.js and npcs.js first.
// ---------------------------------------------------------------------------
const CAR_MODEL_DIR = 'GLB%20format/';
// Models, and how common each is on the road.
const CAR_MODELS = {
  sedan: 6, suv: 5, 'suv-luxury': 3, 'hatchback-sports': 2, 'sedan-sports': 2, taxi: 2.5, van: 2, truck: 2,
  delivery: 1.5, 'delivery-flat': 0.6, 'truck-flat': 0.5, police: 0.8, 'garbage-truck': 0.5, ambulance: 0.35, firetruck: 0.25,
};
const CAR_SCALE = 1.6;             // model units -> meters, in step with the (big) people and rat
const CAR_GROUND_LIFT_M = 0.08;
const CAR_COUNT = 44;              // cars kept around you
const CAR_SPAWN_M = [35, 240];     // how far from you new cars appear
const CAR_DESPAWN_M = 300;
const CAR_PLAN_AHEAD_M = 70;       // route kept planned this far ahead
const CAR_TURN_DEG_PER_SEC = 200;  // how fast the body can swing round
// Cruising speed by road class, m/s (DC limits: mostly 25 mph, 20 on side streets).
const CAR_ROAD_SPEED = {
  street_limited: 6, street: 8.5, tertiary: 10, secondary: 11, primary: 11.5, trunk: 15, motorway: 22,
  tertiary_link: 8, secondary_link: 9, primary_link: 9, trunk_link: 11, motorway_link: 13,
};
const CAR_ROAD_BUSY = [0.25, 1, 1.8, 2.8, 4, 4, 4]; // share of traffic by road rank
// Intelligent Driver Model
const CAR_ACCEL = 1.8;       // m/s²
const CAR_BRAKE = 2.8;       // comfortable braking, m/s²
const CAR_MAX_BRAKE = 9;
const CAR_HEADWAY_S = 1.1;
const CAR_MIN_GAP_M = 2.2;   // bumper to bumper when stopped
// Traffic lights: [seconds, north-south light, east-west light]
const CAR_SIGNAL_PHASES = [[18, 'green', 'red'], [3, 'yellow', 'red'], [2, 'red', 'red'], [16, 'red', 'green'], [3, 'red', 'yellow'], [2, 'red', 'red']];
const CAR_SIGNAL_CYCLE_S = CAR_SIGNAL_PHASES.reduce((sum, p) => sum + p[0], 0);
const CAR_DOUBLE_PARKERS = new Set(['delivery', 'delivery-flat', 'garbage-truck']);
const CAR_SHOCK_M = 16;      // how close the rat gets before a driver freaks out

const cars = [];
const carTemplates = [];
const carMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide });
let carNextId = 1;
let carNextMaintainAt = 0;
let carsFilled = false;
let carNextChatAt = 0;
let carNextShockAt = 0;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

// Bakes a car model's parts into one geometry, scaled to meters.
function carTemplate(scene, name, weight) {
  scene.updateMatrixWorld(true);
  const position = [], normal = [], uv = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (!carMaterial.map && o.material.map) {
      carMaterial.map = o.material.map;
      carMaterial.map.encoding = THREE.LinearEncoding; // show the palette as drawn, like the other models
      carMaterial.needsUpdate = true;
    }
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      position.push(p.getX(i) * CAR_SCALE, p.getY(i) * CAR_SCALE, p.getZ(i) * CAR_SCALE);
      normal.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  return { name, weight, geometry, length: b.max.z - b.min.z, width: b.max.x - b.min.x, height: b.max.y };
}

function carPickTemplate() {
  let r = Math.random() * carTemplates.reduce((sum, c) => sum + c.weight, 0);
  return carTemplates.find((c) => (r -= c.weight) <= 0) || carTemplates[0];
}

// ---------------------------------------------------------------------------
// Geometry (local meters: x east, z south)
// ---------------------------------------------------------------------------
function carBearing(dx, dz) { return (Math.atan2(dx, -dz) * 180) / Math.PI; }
function carAngleDiff(from, to) { return ((to - from + 540) % 360) - 180; }

// Unit direction of the first (or last) stretch of a polyline at least
// minLen long.
function carDirAt(pts, fromEnd, minLen = 0.5) {
  const n = pts.length;
  for (let k = 1; k < n; k++) {
    const p = fromEnd ? pts[n - 1 - k] : pts[0], q = fromEnd ? pts[n - 1] : pts[k];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len >= minLen || k === n - 1) return len ? [(q[0] - p[0]) / len, (q[1] - p[1]) / len] : [0, -1];
  }
  return [0, -1];
}

function carPolyLength(pts) {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return sum;
}

// The part of a polyline beyond distance d along it.
function carPolyFrom(pts, d) {
  if (d <= 0) return pts;
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (sum + len > d) {
      const t = (d - sum) / len;
      return [[pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t], ...pts.slice(i)];
    }
    sum += len;
  }
  return pts.slice(-1);
}

// Lanes, as offsets (m) to the right of a road's center line in the
// direction of travel: one each way on most streets, two on the big ones;
// one-way streets drive down the middle.
function carLaneOffsets(edge) {
  if (edge.oneway) return edge.rank >= 3 ? [-1.7, 1.7] : [0];
  return edge.rank >= 4 ? [1.8, 5] : [2];
}

function carRoadHalfWidth(edge) { return [4, 5, 6, 7, 9, 10, 12][edge.rank]; }

// An edge's points in the direction of travel, shifted `off` m to the right.
function carLanePoints(edge, dir, off) {
  const src = dir > 0 ? edge.xz : edge.xz.slice().reverse();
  return src.map((p, i) => {
    if (!off) return [p[0], p[1]];
    const a = src[Math.max(0, i - 1)], b = src[Math.min(src.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] - ((b[1] - a[1]) / len) * off, p[1] + ((b[0] - a[0]) / len) * off];
  });
}

// Compass bearing of an edge leaving `node`.
function carDepartBearing(edge, node) {
  return carBearing(...carDirAt(edge.a === node ? edge.xz : edge.xz.slice().reverse(), false, 8));
}

// ---------------------------------------------------------------------------
// Routes: each car carries the path it's about to drive as a polyline
// (pts + cumulative distance), `pos` meters along it, and a list of legs —
// one per stretch of road, each ending at a junction.
// ---------------------------------------------------------------------------
function routePush(car, x, z) {
  const n = car.pts.length;
  if (n) {
    const d = Math.hypot(x - car.pts[n - 1][0], z - car.pts[n - 1][1]);
    if (d < 0.05) return;
    car.cum.push(car.cum[n - 1] + d);
  } else {
    car.cum.push(0);
  }
  car.pts.push([x, z]);
}

function routeEnd(car) { return car.cum[car.cum.length - 1]; }

// Cuts the route back to distance d.
function routeCut(car, d) {
  const { pts, cum } = car;
  if (d >= cum[cum.length - 1]) return;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
  pts.length = cum.length = i;
  routePush(car, x, z);
  car.seg = Math.min(car.seg, Math.max(0, pts.length - 2));
}

function routePointAt(car, d) {
  const { pts, cum } = car;
  let i = Math.max(0, car.seg - 8);
  while (i < pts.length - 2 && cum[i + 1] < d) i++;
  const t = Math.min(1, Math.max(0, (d - cum[i]) / (cum[i + 1] - cum[i] || 1)));
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
}

// Adds the next stretch of lane to the end of a car's route, rounding off
// the corner between them. Returns where the corner is and how sharp.
function carJoin(car, pts) {
  const L = routeEnd(car);
  const P = car.pts[car.pts.length - 1], Q = pts[0];
  const [ax, az] = carDirAt(car.pts, true), [bx, bz] = carDirAt(pts, false);
  const cross = ax * bz - az * bx, dot = ax * bx + az * bz;
  const turn = (Math.atan2(cross, dot) * 180) / Math.PI; // + right, - left
  const minD = car.pos + 0.5; // never re-plan the stretch the car is already on
  let from = 0, cornerAt = L;

  if (Math.abs(cross) < 0.2 && dot > 0) {
    // Straight on. If the lanes don't line up, drift across over a few meters.
    if (Math.hypot(Q[0] - P[0], Q[1] - P[1]) > 0.5) {
      routeCut(car, Math.max(minD, L - 5));
      from = Math.min(5, carPolyLength(pts) / 2);
    }
  } else if (Math.abs(cross) < 0.2) {
    // U-turn: swing round in a half circle to the other side of the road.
    const cx = (P[0] + Q[0]) / 2, cz = (P[1] + Q[1]) / 2;
    const r = Math.hypot(P[0] - cx, P[1] - cz);
    if (r > 0.3) {
      const ux = (P[0] - cx) / r, uz = (P[1] - cz) / r;
      for (let k = 1; k < 8; k++) {
        const th = (k / 8) * Math.PI;
        routePush(car, cx + (ux * Math.cos(th) + ax * Math.sin(th)) * r, cz + (uz * Math.cos(th) + az * Math.sin(th)) * r);
      }
    }
  } else {
    // A turn: meet where the two lanes' center lines cross, rounding it off.
    const qx = Q[0] - P[0], qz = Q[1] - P[1];
    const s = (qx * bz - qz * bx) / cross; // crossing point, m past the end of the old lane
    const u = (qx * az - qz * ax) / cross; // ...and m into the new one
    if (Math.abs(s) < 15 && Math.abs(u) < 15) {
      const X = [P[0] + ax * s, P[1] + az * s];
      const r = Math.max(0.5, Math.min(5, (L + Math.min(0, s) - minD) / 2, (carPolyLength(pts) - Math.max(0, u)) / 2));
      if (s - r < 0) routeCut(car, Math.max(minD, L + s - r));
      else routePush(car, P[0] + ax * (s - r), P[1] + az * (s - r));
      const S = car.pts[car.pts.length - 1], E = [X[0] + bx * r, X[1] + bz * r];
      cornerAt = routeEnd(car) + r;
      for (let k = 1; k <= 6; k++) {
        const t = k / 6, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
        routePush(car, a * S[0] + b * X[0] + c * E[0], a * S[1] + b * X[1] + c * E[1]);
      }
      from = u + r;
    }
  }
  carPolyFrom(pts, from).forEach(([x, z]) => routePush(car, x, z));
  return { cornerAt, turn };
}

// What a car arriving at the junction at the end of `leg` has to do there,
// and how far back from the junction's center it stops (clear of the
// crossing road and its crosswalk).
function carControl(leg) {
  const node = leg.node;
  if (node.edges.length < 3) return { control: null, clear: 0 }; // just a bend, or a join in the data
  const crossing = node.edges.filter((e) => e !== leg.edge && Math.abs(carAngleDiff(leg.arrive, carDepartBearing(e, node))) > 30);
  const clear = crossing.length ? Math.min(14, Math.max(...crossing.map(carRoadHalfWidth)) + 3.5) : 0;
  let control = 'priority';
  if (node.signal) control = 'signal';
  else if (node.stopAll || node.stopEdges.has(leg.edge)) control = 'stop';
  // No sign: side streets give way to bigger roads; equal roads take turns.
  else if (node.yieldEdges.has(leg.edge) || crossing.some((e) => e.rank >= leg.edge.rank)) control = 'yield';
  return { control, clear };
}

// Adds the next leg to a car's route: `edge` driven in direction `dir`,
// starting `along` meters in (for a brand-new car).
function carAddLeg(car, edge, dir, along = 0) {
  const lanes = carLaneOffsets(edge);
  const pts = carLanePoints(edge, dir, lanes[Math.min(car.lane, lanes.length - 1)]);
  const prev = car.legs[car.legs.length - 1];
  if (prev) {
    const { cornerAt, turn } = carJoin(car, pts);
    prev.turn = turn;
    prev.cornerAt = cornerAt;
    prev.cornerSpeed = Math.abs(turn) < 25 ? Infinity : Math.max(3.5, 12 - (Math.abs(turn) / 90) * 7.5);
  } else {
    carPolyFrom(pts, along).forEach(([x, z]) => routePush(car, x, z));
  }
  const leg = {
    edge, dir, node: dir > 0 ? edge.b : edge.a, nodeAt: routeEnd(car),
    arrive: carBearing(...carDirAt(pts, true, 6)),
    turn: 0, cornerAt: Infinity, cornerSpeed: Infinity,
    v0: CAR_ROAD_SPEED[edge.cls] * car.pace,
  };
  Object.assign(leg, carControl(leg));
  car.legs.push(leg);
}

// Picks the street to take at the junction the car's route ends at: mostly
// straight on, sometimes a turn, favoring bigger roads; never back the way
// it came unless it's a dead end.
function carExtend(car) {
  const last = car.legs[car.legs.length - 1];
  // The network is rebuilt as the map loads and you move, and a junction
  // can shift a few meters between builds: look it up in the latest one,
  // falling back to the one this leg was planned on.
  const options = [];
  [city.roadNodeNear(last.node.lng, last.node.lat, 8), last.node].forEach((node) => {
    if (!node || options.length) return;
    node.edges.forEach((e) => {
      if (e.a === e.b) return;
      const dirs = [];
      if (e.a === node) dirs.push(1);
      if (e.b === node && !e.oneway) dirs.push(-1);
      dirs.forEach((dir) => {
        const turn = carAngleDiff(last.arrive, carDepartBearing(e, node));
        if (Math.abs(turn) > 150) return;
        options.push({ e, dir, w: (Math.abs(turn) < 30 ? 4 : turn > 0 ? 1.4 : 1) * (1 + 0.4 * e.rank) });
      });
    });
  });
  if (options.length) {
    let r = Math.random() * options.reduce((sum, o) => sum + o.w, 0);
    const next = options.find((o) => (r -= o.w) <= 0) || options[options.length - 1];
    carAddLeg(car, next.e, next.dir);
  } else if (!last.edge.oneway) {
    // Dead end: turn around. Out of sight, it's most likely just the edge
    // of the loaded map, so the car's retired instead.
    if (!carPointOnScreen(car.x, car.z)) car.stranded = true;
    carAddLeg(car, last.edge, -last.dir);
  } else {
    // A one-way street that just ends (the edge of the loaded map): never
    // turn around into oncoming traffic — retire the car.
    car.stranded = car.retire = true;
  }
}

// Drops the stretch of route well behind the car.
function carTrimRoute(car) {
  const drop = car.seg - 2, off = car.cum[drop];
  car.pts.splice(0, drop);
  car.cum.splice(0, drop);
  for (let k = 0; k < car.cum.length; k++) car.cum[k] -= off;
  car.pos -= off;
  car.seg -= drop;
  if (car.parkAt !== undefined) car.parkAt -= off;
  car.legs.forEach((l) => { l.nodeAt -= off; l.cornerAt -= off; });
  car.legs = car.legs.filter((l, k) => l.nodeAt > car.pos - 40 || k === car.legs.length - 1);
}

// ---------------------------------------------------------------------------
// Traffic rules
// ---------------------------------------------------------------------------

// Light facing a car arriving on compass bearing `arrive`. North-south and
// east-west approaches alternate; each signal runs on its own offset.
function carSignal(node, arrive, t) {
  const axis = ((arrive % 180) + 180) % 180;
  const eastWest = axis > 45 && axis < 135;
  let u = (t + node.signal.seed * CAR_SIGNAL_CYCLE_S) % CAR_SIGNAL_CYCLE_S;
  for (const [dur, ns, ew] of CAR_SIGNAL_PHASES) {
    if (u < dur) return eastWest ? ew : ns;
    u -= dur;
  }
  return 'red';
}

// Can two cars cross the same junction at once? Yes if they came in on the
// same road in the same direction (one follows the other through), or from
// opposite sides with neither turning left across the other.
function carPathsCompatible(arriveA, turnA, arriveB, turnB) {
  const d = Math.abs(carAngleDiff(arriveA, arriveB));
  if (d < 35) return true;
  return d > 145 && turnA > -35 && turnB > -35;
}

// Whether the junction at the end of `leg` is free for this car: nobody
// whose path crosses its path is in it, or — when it has to give way —
// about to be, or waiting there first. Nor would the car be stuck in the
// middle of it behind a queue ("don't block the box").
function carJunctionClear(car, leg, t, giveWay) {
  const node = leg.node;
  const waited = t - (leg.waitSince || t);
  const lead = car.lead;
  if (lead && lead.who !== 'rat' && lead.speed < 1 && car.pos + car.halfLen + lead.gap < leg.nodeAt + leg.clear + car.halfLen * 2 + 1) return false;
  for (const o of cars) {
    if (o === car || Math.abs(o.x - node.x) > 70 || Math.abs(o.z - node.z) > 70) continue;
    const ol = o.legs.find((l) => Math.abs(l.node.x - node.x) < 3 && Math.abs(l.node.z - node.z) < 3);
    if (!ol || carPathsCompatible(leg.arrive, leg.turn, ol.arrive, ol.turn)) continue;
    const toNode = ol.nodeAt - o.pos, toLine = toNode - ol.clear - o.halfLen;
    const inside = toNode < ol.clear + o.halfLen + 1 && toNode > -(ol.clear + o.halfLen + 3);
    if (inside && (ol.cleared || toNode < ol.clear)) return false;
    // Already committed to crossing, and nearly there.
    if (ol.cleared && toLine > 0 && toLine < Math.max(o.speed, 1) * 3) return false;
    if (!giveWay || waited > 10) continue; // after 10 s of waiting, only what's actually in the way counts
    const hasPriority = ol.control === 'priority' || ol.control === 'signal' || ol.cleared;
    if (hasPriority && toLine > 0 && toLine / Math.max(o.speed, 0.5) < 3.5) return false;
    // At stop signs, whoever got there first goes first.
    if (!ol.cleared && ol.waitSince !== undefined && toLine < 3 && ol.waitSince < (leg.waitSince || t) - 0.1) return false;
  }
  return true;
}

// 'go' (committed to crossing), 'pass' (fine for now, look again next
// frame) or 'stop' at the junction at the end of `leg`.
function carMayGo(car, leg, toLine, t) {
  const brakeDist = (car.speed * car.speed) / (2 * CAR_BRAKE);
  switch (leg.control) {
    case 'signal': {
      const light = carSignal(leg.node, leg.arrive, t);
      if (light === 'red') return 'stop';
      if (light === 'yellow') return toLine < brakeDist ? 'go' : 'stop';
      if (toLine > brakeDist + 4) return 'pass';
      return carJunctionClear(car, leg, t, false) ? 'go' : 'stop';
    }
    case 'stop':
      if (leg.stoppedAt === undefined) {
        if (toLine < 3 && car.speed < 0.5) leg.stoppedAt = t;
        return 'stop';
      }
      return t - leg.stoppedAt > 1 && carJunctionClear(car, leg, t, true) ? 'go' : 'stop';
    case 'yield':
      if (toLine > 8) return 'pass';
      return carJunctionClear(car, leg, t, true) ? 'go' : 'stop';
    default:
      if (toLine > brakeDist + 6) return 'pass';
      return carJunctionClear(car, leg, t, false) ? 'go' : 'stop';
  }
}

// Distance from the front bumper to where the car must stop for a light,
// a sign, or its turn at a junction — or Infinity.
function carStopLine(car, t) {
  for (const leg of car.legs) {
    if (!leg.control || leg.nodeAt < car.pos) continue;
    const toLine = leg.nodeAt - leg.clear - car.pos - car.halfLen;
    // Held up short of the line after being let through (say, behind a
    // queue): look again — the light may have changed.
    if (leg.cleared && car.speed < 0.5 && toLine > 1) leg.cleared = false;
    if (leg.cleared) continue;
    if (toLine > 60) return Infinity;
    const verdict = toLine < -1.5 ? 'go' : carMayGo(car, leg, toLine, t);
    if (verdict === 'go') { leg.cleared = true; continue; }
    if (verdict === 'pass') continue;
    if (leg.waitSince === undefined && toLine < 3) leg.waitSince = t;
    return Math.max(0, toLine);
  }
  return Infinity;
}

// Where a point is along the car's route ahead: the first stretch that
// passes within `tol` of it, or null.
function carProject(car, x, z, tol, reach) {
  const { pts, cum } = car;
  for (let i = car.seg; i < pts.length - 1 && cum[i] < reach; i++) {
    const [x0, z0] = pts[i], sx = pts[i + 1][0] - x0, sz = pts[i + 1][1] - z0;
    const len = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * sx + (z - z0) * sz) / (len * len)));
    if (Math.hypot(x - (x0 + sx * t), z - (z0 + sz * t)) > tol) continue;
    const along = cum[i] + len * t;
    if (along < car.pos - car.halfLen) continue; // behind the car
    return { along, dx: sx / len, dz: sz / len };
  }
  return null;
}

// If `o` is waiting on `car` — directly, or through a chain of cars each
// waiting on the next — the lowest id in that loop (not counting `car`);
// otherwise 0.
function carWaitLoopMin(o, car) {
  let min = o.id;
  for (let k = o, i = 0; k && k.id && i < 10; k = k.leader, i++) {
    min = Math.min(min, k.id);
    if (k.leader === car) return min;
  }
  return 0;
}

// The nearest thing in the car's way: another car, a person or the rat.
// { gap: m from bumper, speed: its speed along the route, who } or null.
function carLeader(car) {
  const reach = Math.min(routeEnd(car), car.pos + 60);
  let best = null;
  // minAlong: ignore hits closer than this along the route.
  const consider = (x, z, size, tol, speed, dirX, dirZ, who, minAlong = -Infinity) => {
    if (Math.abs(x - car.x) > 65 || Math.abs(z - car.z) > 65) return;
    const hit = carProject(car, x, z, tol, reach);
    if (!hit || hit.along < minAlong) return;
    const gap = hit.along - car.pos - car.halfLen - size;
    if (best && gap >= best.gap) return;
    best = { gap, speed: Math.max(0, speed * (dirX * hit.dx + dirZ * hit.dz)), who };
  };
  cars.forEach((o) => {
    // Only cars in front can be in the way. Cars all waiting on each other
    // in a loop: the lowest id goes first.
    if (o === car || (o.x - car.x) * car.dirX + (o.z - car.z) * car.dirZ <= 0) return;
    if (car.id < carWaitLoopMin(o, car)) return;
    // Where it is — plus where its nose is and where it'll be in a second,
    // if those are ahead of this car, so a car merging or turning in is
    // seen before it's already in the lane.
    const tol = car.halfWidth + o.halfWidth - 0.6, soon = Math.min(8, o.speed * 1.2), front = car.pos + car.halfLen;
    consider(o.x, o.z, o.halfLen, tol, o.speed, o.dirX, o.dirZ, o);
    consider(o.x + o.dirX * o.halfLen, o.z + o.dirZ * o.halfLen, 0, tol, o.speed, o.dirX, o.dirZ, o, front);
    if (soon > 1) consider(o.x + o.dirX * soon, o.z + o.dirZ * soon, o.halfLen, tol, o.speed, o.dirX, o.dirZ, o, front);
  });
  npcs.forEach((n) => {
    // People on a crosswalk get extra room: they're about to step out.
    const crossing = n.line && n.line.type === 'crossing';
    consider(n.obj.position.x, n.obj.position.z, 0.5, car.halfWidth + (crossing ? 1.3 : 0.5), 0, 0, 0, n);
  });
  const rat = actors.toLocal(ratState.lng, ratState.lat);
  consider(rat.x, rat.z, 1.5, car.halfWidth + 1.4, 0, 0, 0, 'rat');
  return best;
}

function carIdm(v, v0, gap, dv) {
  const free = 1 - Math.pow(v / Math.max(0.5, v0), 4);
  if (!(gap < Infinity)) return CAR_ACCEL * free;
  const want = CAR_MIN_GAP_M + Math.max(0, v * CAR_HEADWAY_S + (v * dv) / (2 * Math.sqrt(CAR_ACCEL * CAR_BRAKE)));
  return CAR_ACCEL * (free - Math.pow(want / Math.max(0.2, gap), 2));
}

function carAcceleration(car, t) {
  const v = car.speed;
  const leg = car.legs.find((l) => l.nodeAt > car.pos) || car.legs[car.legs.length - 1];
  let v0 = leg.v0;
  car.legs.forEach((l) => {
    // Slow for corners, and to a crawl coming up to a junction to give way at.
    if (l.cornerAt > car.pos - 3 && l.cornerAt - car.pos < 60) {
      v0 = Math.min(v0, Math.sqrt(l.cornerSpeed * l.cornerSpeed + 4 * Math.max(0, l.cornerAt - car.pos - 3)));
    }
    const toLine = l.nodeAt - l.clear - car.pos - car.halfLen;
    if (l.control === 'yield' && !l.cleared && toLine > 0 && toLine < 60) v0 = Math.min(v0, Math.sqrt(9 + 2 * CAR_BRAKE * toLine));
  });
  if (t < (car.gawkUntil || 0)) v0 = Math.min(v0, 3); // staring at the rat

  let acc = carIdm(v, v0, Infinity, 0);
  car.lead = carLeader(car);
  car.leader = car.lead ? car.lead.who : null;
  if (car.lead) acc = Math.min(acc, carIdm(v, v0, car.lead.gap, v - car.lead.speed));
  const stop = carStopLine(car, t);
  if (stop < Infinity) acc = Math.min(acc, carIdm(v, v0, stop + CAR_MIN_GAP_M, v));

  // Double-parked: pull up, sit there with the hazards on, then carry on.
  if (car.parkAt !== undefined) {
    const toSpot = car.parkAt - car.pos;
    if (car.parkedUntil === undefined && toSpot < 1 && v < 0.3) carStartParking(car, t);
    if (car.parkedUntil !== undefined && t > car.parkedUntil) car.parkAt = car.parkedUntil = undefined;
    else acc = Math.min(acc, carIdm(v, v0, Math.max(0, toSpot) + CAR_MIN_GAP_M, v));
  }
  return Math.max(-CAR_MAX_BRAKE, Math.min(CAR_ACCEL, acc));
}

// Delivery and garbage trucks now and then stop mid-block on a side street.
function carMaybeDoublePark(car, t) {
  if (!CAR_DOUBLE_PARKERS.has(car.model) || car.parkAt !== undefined || t < car.nextParkAt || car.speed < 3) return;
  const leg = car.legs.find((l) => l.nodeAt > car.pos);
  if (!leg || leg.edge.rank > 2 || leg.nodeAt - car.pos < 45) return;
  car.parkAt = car.pos + (car.speed * car.speed) / (2 * CAR_BRAKE) + 3;
  car.nextParkAt = t + 70 + Math.random() * 90;
}

function carStartParking(car, t) {
  car.parkedUntil = t + 8 + Math.random() * 10;
  if (talk.lines && talk.headOnScreen(car) && !talk.busy(car)) talk.say(car, talk.pickFresh(talk.lines.cars.doublePark), 0, 'car');
}

// ---------------------------------------------------------------------------
// Moving, spawning
// ---------------------------------------------------------------------------
function carMove(car, acc, dt) {
  car.speed = Math.max(0, car.speed + acc * dt);
  car.pos = Math.min(car.pos + car.speed * dt, routeEnd(car));
  car.stillFor = car.speed < 0.3 ? car.stillFor + dt : 0;
  const { pts, cum } = car;
  while (car.seg < pts.length - 2 && cum[car.seg + 1] <= car.pos) car.seg++;
  [car.x, car.z] = routePointAt(car, car.pos);
  // Heading from a little behind to a little ahead, so corners turn smoothly.
  const back = routePointAt(car, car.pos - 1.5), ahead = routePointAt(car, car.pos + 1.5);
  const dx = ahead[0] - back[0], dz = ahead[1] - back[1], len = Math.hypot(dx, dz);
  if (len > 0.1) { car.dirX = dx / len; car.dirZ = dz / len; }
  if (car.seg > 30) carTrimRoute(car);
}

function carRender(car, dt) {
  const [lng, lat] = actors.toLngLat(car.x, car.z);
  car.groundY = actorGroundHeight(lng, lat, car.groundY);
  const diff = carAngleDiff(car.facing, carBearing(car.dirX, car.dirZ));
  const maxTurn = CAR_TURN_DEG_PER_SEC * dt;
  car.facing += dt ? Math.max(-maxTurn, Math.min(maxTurn, diff)) : diff;
  car.obj.position.set(car.x, car.groundY + CAR_GROUND_LIFT_M, car.z);
  car.obj.rotation.y = actors.yawForBearing(car.facing, '+z');
}

function carPointOnScreen(x, z) {
  const [lng, lat] = actors.toLngLat(x, z);
  const p = actors.toScreen(x, actorGroundHeight(lng, lat, 60) + 1, z);
  const canvas = map.getCanvas();
  return !!p && p.x > -60 && p.x < canvas.clientWidth + 60 && p.y > -60 && p.y < canvas.clientHeight + 60;
}

function carCreate(edge, dir, lane, along) {
  const tpl = carPickTemplate();
  const obj = new THREE.Mesh(tpl.geometry, carMaterial);
  obj.frustumCulled = false;
  actors.scene.add(obj);
  const car = {
    id: carNextId++, model: tpl.name, obj, headHeight: tpl.height + 0.5,
    halfLen: tpl.length / 2, halfWidth: tpl.width / 2,
    pace: 0.9 + Math.random() * 0.18, lane,
    pts: [], cum: [], seg: 0, pos: 0, legs: [], speed: 0,
    x: 0, z: 0, dirX: 0, dirZ: -1, facing: 0, groundY: 60, stillFor: 0,
    nextParkAt: performance.now() / 1000 + 20 + Math.random() * 60,
  };
  carAddLeg(car, edge, dir, along);
  car.speed = car.legs[0].v0 * 0.8;
  carMove(car, 0, 0);
  carRender(car, 0);
  cars.push(car);
}

function carRemove(i) {
  const car = cars[i];
  talk.cancel(car);
  actors.scene.remove(car.obj);
  cars.splice(i, 1);
}

// Drops a car into a lane somewhere near you (busier roads more likely),
// clear of other cars and people. Returns false if no good spot turned up.
function carSpawn(allowOnScreen) {
  const focus = city.focus(), f = actors.toLocal(focus[0], focus[1]);
  const edges = city.roads.edges.filter((e) => e.length >= 20 && e.xz.some(([x, z]) => Math.hypot(x - f.x, z - f.z) < CAR_SPAWN_M[1]));
  if (!edges.length) return false;
  const weights = edges.map((e) => e.length * CAR_ROAD_BUSY[e.rank]);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const rat = actors.toLocal(ratState.lng, ratState.lat);
  for (let attempt = 0; attempt < 30; attempt++) {
    let r = Math.random() * total, k = 0;
    while (k < edges.length - 1 && (r -= weights[k]) > 0) k++;
    const edge = edges[k];
    const dir = edge.oneway || Math.random() < 0.5 ? 1 : -1;
    const lane = Math.random() < 0.6 ? 0 : 1;
    const lanes = carLaneOffsets(edge);
    const along = 3 + Math.random() * (edge.length - 15);
    const [x, z] = carPolyFrom(carLanePoints(edge, dir, lanes[Math.min(lane, lanes.length - 1)]), along)[0];
    const away = Math.hypot(x - f.x, z - f.z);
    if (away < CAR_SPAWN_M[0] || away > CAR_SPAWN_M[1]) continue;
    if (!allowOnScreen && carPointOnScreen(x, z)) continue;
    if (cars.some((c) => Math.hypot(c.x - x, c.z - z) < 14)) continue;
    if (npcs.some((n) => Math.hypot(n.obj.position.x - x, n.obj.position.z - z) < 6)) continue;
    if (Math.hypot(rat.x - x, rat.z - z) < 12) continue;
    carCreate(edge, dir, lane, along);
    return true;
  }
  return false;
}

// Keeps CAR_COUNT cars around you: drops ones left far behind (or stuck at
// a dead end, out of sight) and adds new ones — all at once at first (until
// most are placed; the map may still be loading), then a few a second, just
// off screen where possible.
function carMaintain(t) {
  if (t < carNextMaintainAt) return;
  carNextMaintainAt = t + 1;
  const focus = city.focus(), f = actors.toLocal(focus[0], focus[1]);
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    const far = Math.hypot(c.x - f.x, c.z - f.z) > CAR_DESPAWN_M;
    if (far || c.retire || ((c.stranded || c.stillFor > 60) && !carPointOnScreen(c.x, c.z))) carRemove(i);
  }
  if (!carTemplates.length || !city.roads.edges.length || map.getZoom() < 15) return;
  let n = cars.length;
  const budget = carsFilled ? 4 : CAR_COUNT;
  for (let k = 0; k < budget && n < CAR_COUNT; k++) {
    if (carSpawn(!carsFilled || n < CAR_COUNT / 2)) n++;
  }
  if (n >= CAR_COUNT * 0.75) carsFilled = true;
}

// Whether a point is inside (or right up against) a car — for the rat,
// who can't run through them, and walkers, who wait for them. `except`:
// ignore cars that are themselves waiting on that person.
function carBlocksPoint(lng, lat, except) {
  const { x, z } = actors.toLocal(lng, lat);
  return cars.some((c) => {
    if (except && c.leader === except && c.speed < 0.5) return false;
    const dx = x - c.x, dz = z - c.z;
    if (Math.abs(dx) > 8 || Math.abs(dz) > 8) return false;
    const along = dx * c.dirX + dz * c.dirZ, side = dz * c.dirX - dx * c.dirZ;
    return Math.abs(along) < c.halfLen + 0.4 && Math.abs(side) < c.halfWidth + 0.4;
  });
}
ratBlockers.push((lng, lat) => carBlocksPoint(lng, lat));

// ---------------------------------------------------------------------------
// Talk
// ---------------------------------------------------------------------------
// The street a car is on, the way people say it: "16th St NW" -> "16th
// Street", "Cr Place NW" -> "Crescent Place".
const CAR_STREET_WORDS = {
  St: 'Street', Ave: 'Avenue', Rd: 'Road', Pl: 'Place', Dr: 'Drive', Blvd: 'Boulevard', Pkwy: 'Parkway',
  Cir: 'Circle', Ter: 'Terrace', Ct: 'Court', Cr: 'Crescent', Hwy: 'Highway', Ln: 'Lane', Sq: 'Square',
};
function carStreet(car) {
  const leg = car.legs.find((l) => l.nodeAt > car.pos) || car.legs[car.legs.length - 1];
  if (!leg || !leg.edge.name) return '';
  return leg.edge.name
    .replace(/\s+(NW|NE|SW|SE)$/, '')
    .split(' ')
    .map((w, i) => (w === 'St' && i === 0 ? 'Saint' : CAR_STREET_WORDS[w] || w))
    .join(' ');
}

// DC talk that's still current: dated lines drop out after their date.
function carGossip() {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  return talk.lines.cars.gossip
    .filter((g) => typeof g === 'string' || !g.until || g.until >= today)
    .map((g) => (typeof g === 'string' ? g : g.text));
}

function carLine(car) {
  const L = talk.lines.cars;
  const r = Math.random();
  if (car.stillFor > 2) {
    if (car.leader && car.leader.parkedUntil !== undefined) return talk.pickFresh(L.doubleParked);
    const street = carStreet(car);
    return street && r < 0.7 ? talk.fill(talk.pickFresh(L.traffic), street) : talk.pickFresh(L.stuck);
  }
  const special = L.byType[car.model];
  if (special && r < 0.3) return talk.pickFresh(special);
  return r < 0.7 ? talk.pickFresh(carGossip()) : talk.pickFresh(L.driving);
}

// Ambient chatter, sharing the 3-bubble budget with the people.
function carChatter(t) {
  if (talk.count() >= 3) return;
  const candidates = cars.filter((c) => !talk.busy(c) && t - (c.lastSpokeAt || -Infinity) > 20 && talk.headOnScreen(c));
  if (!candidates.length) return;
  const car = talk.pick(candidates);
  talk.say(car, carLine(car), 0, 'car');
}

// Washington vs. traffic: drivers stuck behind him in the road complain;
// otherwise the nearest driver who spots him freaks out and slows to stare,
// sometimes with another driver joining in, and he talks back.
function carRatEncounters(t) {
  if (!ratModeActive || t < ratIntroUntil || t < carNextShockAt) return;
  const L = talk.lines.cars;
  const retort = () => { if (Math.random() < 0.5 && !talk.busy(ratSpeaker)) talk.say(ratSpeaker, talk.pickFresh(talk.lines.rat.carRetort), 1.8, 'rat'); };

  const stuck = cars.find((c) => c.leader === 'rat' && c.stillFor > 2.5 && t - (c.lastHonkAt || -Infinity) > 25 && !talk.busy(c) && talk.headOnScreen(c));
  if (stuck) {
    stuck.lastHonkAt = t;
    carNextShockAt = t + 4;
    talk.say(stuck, talk.fill(talk.pickFresh(L.ratBlocking), carStreet(stuck) || 'the street'), 0, 'scared');
    retort();
    return;
  }

  const rat = actors.toLocal(ratState.lng, ratState.lat);
  let best = null, bestD = CAR_SHOCK_M;
  cars.forEach((c) => {
    const d = Math.hypot(c.x - rat.x, c.z - rat.z);
    if (d < bestD && t - (c.lastShockAt || -Infinity) > 45 && talk.headOnScreen(c)) { bestD = d; best = c; }
  });
  if (!best) return;
  carNextShockAt = t + 6;
  best.lastShockAt = t;
  best.gawkUntil = t + 3;
  talk.cancel(best);
  talk.say(best, talk.pickFresh(L.shocked), 0, 'scared');
  const other = cars.find((c) => c !== best && Math.hypot(c.x - rat.x, c.z - rat.z) < CAR_SHOCK_M * 1.6 && !talk.busy(c) && talk.headOnScreen(c));
  if (other && Math.random() < 0.4) {
    other.lastShockAt = t;
    talk.say(other, talk.pickFresh(L.bystander), 1.3, 'scared');
  }
  retort();
}

// Now and then a driver waiting at a crosswalk waves someone across.
function carYieldTalk(t) {
  const car = cars.find((c) => c.leader && c.leader.line && c.leader.line.type === 'crossing' && c.stillFor > 0.8 &&
    t - (c.lastYieldTalkAt || -Infinity) > 60 && !talk.busy(c) && !talk.busy(c.leader) && talk.headOnScreen(c));
  if (!car) return;
  car.lastYieldTalkAt = t;
  if (Math.random() > 0.35) return;
  talk.say(car, talk.pickFresh(talk.lines.cars.yieldToPeople), 0, 'car');
  talk.say(car.leader, talk.pickFresh(talk.lines.cars.peopleThanks), 1.4);
}

// ---------------------------------------------------------------------------
// Load + per frame
// ---------------------------------------------------------------------------
Object.entries(CAR_MODELS).forEach(([name, weight]) => {
  new THREE.GLTFLoader().load(
    CAR_MODEL_DIR + name + '.glb',
    (gltf) => carTemplates.push(carTemplate(gltf.scene, name, weight)),
    undefined,
    (err) => console.error(`Car model ${name} failed to load:`, err)
  );
});

actors.onFrame((dt, now) => {
  const t = now / 1000;
  carMaintain(t);
  cars.forEach((car) => {
    for (let k = 0; k < 4 && routeEnd(car) - car.pos < CAR_PLAN_AHEAD_M; k++) carExtend(car);
  });
  // Decide everyone's acceleration from where everyone is now, then move.
  const accs = cars.map((car) => carAcceleration(car, t));
  cars.forEach((car, i) => {
    carMove(car, accs[i], dt);
    carRender(car, dt);
    carMaybeDoublePark(car, t);
  });
  if (!talk.lines || !talk.lines.cars) return;
  if (t >= carNextChatAt) {
    carChatter(t);
    carNextChatAt = t + 4 + Math.random() * 4;
  }
  carRatEncounters(t);
  carYieldTalk(t);
});
