// ---------------------------------------------------------------------------
// People on the map, built from assets/models/Crowd/crowd.glb (apelab): one
// static scene of 7 standing people, each split into head/torso/legs meshes
// (plus a ground plane and a stray head). They're pulled apart by clustering
// meshes by position, re-centred on their feet, merged into one mesh each
// (one draw call per person instead of ~13), and cloned. The model faces +X.
//
// Two kinds:
//  - park regulars: strollers on the park's real footpaths, and groups
//    standing on the lawns;
//  - city walkers: a population kept around wherever you are (the rat, or the
//    map center), walking only along real sidewalks, footways and crosswalks
//    from city.js, which already has any stretch inside a building cut out.
//    At the end of a path they carry on along a connecting one, or turn
//    around at a dead end.
// No skeleton or animations, so walking is a step bob and a small sway.
//
// Talk: park groups hold conversations, everyone else says one-liners, and
// when Washington (the rat) comes by, people stop to greet him and point him
// to a real place to eat or an apartment building nearby, get scared, or chat.
//
// Requires map.js, actors.js, talk.js, city.js and rat.js to have run first.
// ---------------------------------------------------------------------------
const NPC_MODEL_URL = 'assets/models/Crowd/crowd.glb';
const NPC_HEIGHT_M = 2.6;            // a bit over life size so they read next to the (big) rat
const NPC_WALK_SPEED_MPS = 1.6;
const NPC_TURN_DEG_PER_SEC = 240;
const CITY_NPC_COUNT = 18;           // walkers kept around you
const CITY_NPC_SPAWN_M = [30, 250];  // how far from you new walkers appear
const CITY_NPC_DESPAWN_M = 320;
const NPC_ENCOUNTER_M = 10;          // how close the rat gets before someone reacts

const NPC_STROLL_ROUTES = [
  // West promenade along 16th St
  [[-77.036304, 38.922988], [-77.03628, 38.922595], [-77.03618, 38.922428], [-77.036152, 38.92222], [-77.036221, 38.922033], [-77.03616, 38.921741], [-77.036145, 38.921373], [-77.036207, 38.921372], [-77.036173, 38.920822]],
  // East walk, upper terrace
  [[-77.035427, 38.923075], [-77.035472, 38.922888], [-77.035414, 38.922621], [-77.035488, 38.922459], [-77.035478, 38.922239], [-77.035393, 38.922019], [-77.03541, 38.921593]],
  // Central walk
  [[-77.035578, 38.920822], [-77.035603, 38.922234]],
  // Cross path, then down the east side
  [[-77.036153, 38.921568], [-77.03541, 38.921593], [-77.035356, 38.920822]],
  // Lower terrace, south end
  [[-77.035049, 38.91949], [-77.03548, 38.919472], [-77.035607, 38.919393], [-77.035712, 38.91941], [-77.035775, 38.91946], [-77.036248, 38.91944], [-77.036288, 38.919409], [-77.036283, 38.919368]],
  // North edge along Euclid St
  [[-77.036174, 38.923048], [-77.035374, 38.923076]],
];

// Standing groups on the park lawns (spots checked clear of buildings and water).
const NPC_GROUPS = [
  { center: [-77.0359, 38.9220], size: 3 },
  { center: [-77.0357, 38.9228], size: 2 },
  { center: [-77.0352, 38.9201], size: 2 },
];

const METERS_PER_DEG_LAT = 111320;
const npcs = [];
const npcMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
let npcTemplates = [];
let npcNextTemplate = 0;
let npcNextMaintainAt = 0;
let npcCityFilled = false;
let npcNextChatAt = 0;
let npcNextEncounterAt = 0;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

// Bakes every mesh under `root` into one geometry in root's local space, with
// each part's material color stored per vertex.
function mergeIntoOneMesh(root) {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const position = [], normal = [], color = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld));
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal, c = o.material.color;
    for (let i = 0; i < p.count; i++) {
      position.push(p.getX(i), p.getY(i), p.getZ(i));
      normal.push(n.getX(i), n.getY(i), n.getZ(i));
      color.push(c.r, c.g, c.b);
    }
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  const mesh = new THREE.Mesh(merged, npcMaterial);
  mesh.frustumCulled = false;
  return mesh;
}

// Splits the crowd scene into one template per person.
function buildNpcTemplates(scene) {
  let container = scene;
  while (container.children.length === 1 && container.children[0].children.length > 1) container = container.children[0];
  container.updateMatrixWorld(true);

  const parts = container.children
    .map((child) => {
      const box = new THREE.Box3().setFromObject(child);
      return { child, box, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2 };
    })
    .filter((p) => p.box.max.y - p.box.min.y > 0.2); // drop the flat ground plane

  // Single-linkage clustering on x/z: a person's head, torso, legs and hat
  // sit within a few tenths of a unit of each other; neighbours are ~1 apart.
  const clusters = [];
  parts.forEach((p) => {
    const touching = clusters.filter((c) => c.some((q) => Math.hypot(q.cx - p.cx, q.cz - p.cz) < 0.5));
    touching.forEach((c) => clusters.splice(clusters.indexOf(c), 1));
    clusters.push([p].concat(...touching));
  });

  return clusters
    .filter((c) => c.length >= 2) // a lone part is the stray floating head
    .map((c) => {
      const box = new THREE.Box3();
      c.forEach((p) => box.union(p.box));
      const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
      const body = new THREE.Group();
      c.forEach((p) => {
        p.child.position.set(-cx, -box.min.y, -cz); // feet centred on the origin
        body.add(p.child);
      });
      body.scale.setScalar(NPC_HEIGHT_M / (box.max.y - box.min.y));
      const merged = mergeIntoOneMesh(body);
      body.remove(...body.children);
      body.add(merged);
      const template = new THREE.Group();
      template.add(body);
      return template;
    });
}

// ---------------------------------------------------------------------------
// Paths and spawning
// ---------------------------------------------------------------------------

// Position + compass bearing (of the segment, in path order) at distance d.
function routeAt(line, d) {
  let i = 1;
  while (i < line.cum.length - 1 && line.cum[i] < d) i++;
  const a = line.pts[i - 1], b = line.pts[i];
  const seg = line.cum[i] - line.cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (d - line.cum[i - 1]) / seg));
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const bearing = (Math.atan2((b.lng - a.lng) * cosLat, b.lat - a.lat) * 180) / Math.PI;
  return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t, bearing };
}

function bearingFromTo(aLng, aLat, bLng, bLat) {
  const cosLat = Math.cos((aLat * Math.PI) / 180);
  return (Math.atan2((bLng - aLng) * cosLat, bLat - aLat) * 180) / Math.PI;
}

function makeNpc(fields) {
  const obj = npcTemplates[npcNextTemplate++ % npcTemplates.length].clone(true);
  actors.scene.add(obj);
  const npc = { obj, headHeight: NPC_HEIGHT_M + 0.35, groundZ: 60, groundAt: -Infinity, facingDeg: 0, phase: Math.random() * 10, ...fields };
  npcs.push(npc);
  return npc;
}

function removeNpc(index) {
  const npc = npcs[index];
  talk.cancel(npc);
  actors.scene.remove(npc.obj);
  npcs.splice(index, 1);
}

function spawnParkNpcs() {
  NPC_STROLL_ROUTES.forEach((coords, i) => {
    const line = cityMakeLine(coords);
    const dist = line.length * ((i * 0.37) % 1);
    makeNpc({ kind: 'stroll', line, dist, dir: i % 2 ? -1 : 1, speed: NPC_WALK_SPEED_MPS * (0.85 + ((i * 0.53) % 0.3)) });
  });

  NPC_GROUPS.forEach((g, gi) => {
    const radius = NPC_HEIGHT_M * 0.45;
    for (let k = 0; k < g.size; k++) {
      const a = (k / g.size) * Math.PI * 2 + gi;
      const lat = g.center[1] + (Math.cos(a) * radius) / METERS_PER_DEG_LAT;
      const lng = g.center[0] + (Math.sin(a) * radius) / (METERS_PER_DEG_LAT * Math.cos((g.center[1] * Math.PI) / 180));
      const faceCenter = ((a * 180) / Math.PI + 180) % 360; // turned in toward the group
      makeNpc({ kind: 'stand', group: gi, lng, lat, homeFacingDeg: faceCenter, facingDeg: faceCenter });
    }
  });
}

function npcPointOnScreen(lng, lat) {
  const { x, z } = actors.toLocal(lng, lat);
  const p = actors.toScreen(x, actorGroundHeight(lng, lat, 60) + NPC_HEIGHT_M / 2, z);
  const canvas = map.getCanvas();
  return !!p && p.x > -40 && p.x < canvas.clientWidth + 40 && p.y > -40 && p.y < canvas.clientHeight + 40;
}

// Drops a walker at a random spot on a random walk path near you (longer
// paths more likely). Returns false if no good spot turned up.
function spawnCityWalker(allowOnScreen) {
  const lines = city.walkLines.filter((l) => l.length >= 15);
  if (!lines.length) return false;
  const focus = city.focus();
  const total = lines.reduce((sum, l) => sum + l.length, 0);
  for (let attempt = 0; attempt < 12; attempt++) {
    let r = Math.random() * total, line = lines[lines.length - 1];
    for (const l of lines) { r -= l.length; if (r <= 0) { line = l; break; } }
    const dist = Math.random() * line.length;
    const at = routeAt(line, dist);
    const away = cityMeters(focus, [at.lng, at.lat]);
    if (away < CITY_NPC_SPAWN_M[0] || away > CITY_NPC_SPAWN_M[1]) continue;
    if (!allowOnScreen && npcPointOnScreen(at.lng, at.lat)) continue;
    const dir = Math.random() < 0.5 ? 1 : -1;
    makeNpc({
      kind: 'walk', line, dist, dir, lng: at.lng, lat: at.lat,
      speed: NPC_WALK_SPEED_MPS * (0.8 + Math.random() * 0.4),
      facingDeg: dir > 0 ? at.bearing : at.bearing + 180,
    });
    return true;
  }
  return false;
}

// Keeps CITY_NPC_COUNT walkers around you: drops ones left far behind and
// adds new ones — all at once the first time, then a few a second, placed
// just off screen where possible so nobody pops in right in front of you.
function maintainCityWalkers(t) {
  if (t < npcNextMaintainAt || !npcTemplates.length) return;
  npcNextMaintainAt = t + 1;
  const focus = city.focus();
  for (let i = npcs.length - 1; i >= 0; i--) {
    if (npcs[i].kind === 'walk' && cityMeters(focus, [npcs[i].lng, npcs[i].lat]) > CITY_NPC_DESPAWN_M) removeNpc(i);
  }
  if (!city.walkLines.length || map.getZoom() < 15) return; // too far out to see anyone anyway
  let walkers = npcs.filter((n) => n.kind === 'walk').length;
  const budget = npcCityFilled ? 3 : CITY_NPC_COUNT;
  for (let k = 0; k < budget && walkers < CITY_NPC_COUNT; k++) {
    if (!spawnCityWalker(!npcCityFilled || walkers < CITY_NPC_COUNT / 2)) break;
    walkers++;
  }
  if (walkers > 0) npcCityFilled = true;
}

// At the end of its path, a walker carries on along whichever connecting
// path (sidewalk, crosswalk, footway…) doesn't send it straight back the way
// it came; at a dead end it turns around.
function continueWalk(npc) {
  const endDist = npc.dist > npc.line.length ? npc.line.length : 0;
  const end = routeAt(npc.line, endDist);
  const heading = npc.dir > 0 ? end.bearing : end.bearing + 180;
  const options = [];
  city.walkLinesNear(end.lng, end.lat, 4).forEach((line) => {
    if (line === npc.line) return;
    const hit = city.nearestOnLine(line, end.lng, end.lat);
    if (hit.off > 4) return;
    [1, -1].forEach((dir) => {
      const room = dir > 0 ? line.length - hit.along : hit.along;
      if (room < 6) return;
      const ahead = routeAt(line, hit.along + dir * 3);
      const bearing = dir > 0 ? ahead.bearing : ahead.bearing + 180;
      if (Math.abs(((bearing - heading + 540) % 360) - 180) < 150) options.push({ line, along: hit.along, dir });
    });
  });
  if (options.length) {
    const next = talk.pick(options);
    npc.line = next.line;
    npc.dist = next.along;
    npc.dir = next.dir;
  } else {
    npc.dist = endDist;
    npc.dir = -npc.dir;
  }
}

function updateNpc(npc, dt, t) {
  let bob = 0, sway = 0, targetFacing;

  if (t < (npc.pausedUntil || 0)) {
    // Stopped to deal with the rat: turn to face him.
    targetFacing = bearingFromTo(npc.lng, npc.lat, ratState.lng, ratState.lat);
  } else if (npc.kind === 'stand') {
    // Small weight shifts and glances around.
    targetFacing = npc.homeFacingDeg + Math.sin(t * 0.6 + npc.phase) * 12;
    sway = Math.sin(t * 0.9 + npc.phase) * 0.02;
  } else {
    // Wait for a car that's in the way (not one that's waiting on them) —
    // up to 8 s, in case it's stuck there.
    const next = routeAt(npc.line, npc.dist + npc.dir * 1.5);
    const blocked = typeof carBlocksPoint === 'function' && carBlocksPoint(next.lng, next.lat, npc);
    npc.waitedFor = blocked ? (npc.waitedFor || 0) + dt : 0;
    const walking = !blocked || npc.waitedFor > 8;
    if (walking) npc.dist += npc.dir * npc.speed * dt;
    if (npc.dist > npc.line.length || npc.dist < 0) {
      if (npc.kind === 'walk') continueWalk(npc);
      else { npc.dist = Math.min(npc.line.length, Math.max(0, npc.dist)); npc.dir = -npc.dir; }
    }
    const at = routeAt(npc.line, npc.dist);
    npc.lng = at.lng;
    npc.lat = at.lat;
    targetFacing = npc.dir > 0 ? at.bearing : at.bearing + 180;
    const step = t * 2 * Math.PI * 1.8 + npc.phase;
    if (walking) {
      bob = Math.abs(Math.sin(step)) * NPC_HEIGHT_M * 0.025;
      sway = Math.sin(step) * 0.05;
    }
  }

  const diff = ((targetFacing - npc.facingDeg + 540) % 360) - 180;
  const maxTurn = NPC_TURN_DEG_PER_SEC * dt;
  npc.facingDeg += Math.max(-maxTurn, Math.min(maxTurn, diff));

  if (t - npc.groundAt > 0.4) {
    npc.groundZ = actorGroundHeight(npc.lng, npc.lat, npc.groundZ);
    npc.groundAt = t;
  }
  const { x, z } = actors.toLocal(npc.lng, npc.lat);
  npc.obj.position.set(x, npc.groundZ + bob, z);
  npc.obj.rotation.set(0, actors.yawForBearing(npc.facingDeg, '+x'), 0);
  npc.obj.children[0].rotation.x = sway; // rock side to side (model's x axis points forward)
}

// ---------------------------------------------------------------------------
// Talk
// ---------------------------------------------------------------------------
function npcTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function npcSeason() {
  const m = new Date().getMonth();
  return m >= 2 && m <= 4 ? 'spring' : m >= 5 && m <= 7 ? 'summer' : m >= 8 && m <= 10 ? 'fall' : 'winter';
}

// Park regulars also talk about the park, its facts and the site's upcoming
// events; city walkers stick to city talk.
function npcOneLiner(npc) {
  const L = talk.lines;
  const inPark = npc.kind !== 'walk';
  const r = Math.random();
  if (inPark && r < 0.1) {
    const next = upcomingEvents()[0];
    if (next) {
      const when = new Date(next.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      return `Are you going to ${next.name} on ${when}?`;
    }
  }
  if (inPark && r < 0.18) return 'Fun fact: ' + talk.pickFresh(facts.filter((f) => f.length <= 130));
  if (r < 0.33) return talk.pickFresh(L.timeOfDay[npcTimeOfDay()]);
  if (r < 0.45) return talk.pickFresh(L.season[npcSeason()]);
  return talk.pickFresh(inPark && r < 0.75 ? L.park.lines : L.city.lines);
}

// Ambient chatter: at most 3 bubbles going at once, only from people big
// enough on screen to read.
function startChatter(t) {
  if (talk.count() >= 3) return;
  const candidates = npcs.filter((n) =>
    !talk.busy(n) && t - (n.lastSpokeAt || -Infinity) > 10 && t >= (n.pausedUntil || 0) && talk.headOnScreen(n));
  if (!candidates.length) return;
  const speaker = talk.pick(candidates);
  const group = speaker.kind === 'stand' ? npcs.filter((n) => n.group === speaker.group && !talk.busy(n)) : [];

  if (group.length >= 2) {
    // A short conversation, alternating between the group's members.
    const start = group.indexOf(speaker);
    let delay = 0;
    talk.pickFresh(talk.lines.park.conversations).forEach((text, i) => {
      talk.say(group[(start + i) % group.length], text, delay);
      delay += talk.secondsFor(text) - 0.4;
    });
  } else {
    talk.say(speaker, npcOneLiner(speaker));
  }
}

// Someone spots Washington. Half the time they know him and point him to a
// real place nearby — a food spot, or an apartment building ("highest rent,
// so there's more to eat"); otherwise they're scared (anyone close by joins
// in) or he starts the chat.
function runEncounter(npc, t, rat) {
  const L = talk.lines;
  const food = city.placesNear(city.food, ratState.lng, ratState.lat, 500, 4);
  const homes = city.placesNear(city.apartments, ratState.lng, ratState.lat, 450, 3);
  talk.cancel(npc);
  talk.cancel(ratSpeaker);
  npc.lastEncounterAt = t;
  const roll = Math.random();

  if (roll < 0.5 && (food.length || homes.length)) {
    const useHome = homes.length > 0 && (!food.length || Math.random() < 0.4);
    const place = talk.pickFresh((useHome ? homes : food).map((p) => p.name));
    const tip = talk.fill(talk.pickFresh(useHome ? L.people.suggestApartment : L.people.suggestFood), place);
    talk.say(npc, talk.pickFresh(L.people.greetRat));
    talk.say(ratSpeaker, talk.pickFresh(L.rat.askForFood), 1.8, 'rat');
    talk.say(npc, tip, 3.9);
    talk.say(ratSpeaker, talk.pickFresh(L.rat.thanks), 3.9 + talk.secondsFor(tip), 'rat');
    npc.pausedUntil = t + 3.9 + talk.secondsFor(tip);
  } else if (roll < 0.8) {
    const bystanders = npcs
      .filter((n) => n !== npc && Math.hypot(n.obj.position.x - rat.x, n.obj.position.z - rat.z) < NPC_ENCOUNTER_M * 1.5)
      .slice(0, 2);
    [npc, ...bystanders].forEach((n, i) => {
      talk.cancel(n);
      n.lastEncounterAt = t;
      n.pausedUntil = t + 2.5;
      talk.say(n, talk.pickFresh(L.people.scared), i * 0.4, 'scared');
    });
    if (Math.random() < 0.6) talk.say(ratSpeaker, talk.pickFresh(L.rat.retort), 1.8, 'rat');
  } else {
    talk.say(ratSpeaker, talk.pickFresh(L.rat.greet), 0, 'rat');
    talk.say(npc, talk.pickFresh(L.people.replyToGreet), 2);
    npc.pausedUntil = t + 4.5;
  }
}

function updateEncounters(t) {
  if (!ratModeActive || t < ratIntroUntil || t < npcNextEncounterAt) return;
  const rat = actors.toLocal(ratState.lng, ratState.lat);
  let nearest = null, best = NPC_ENCOUNTER_M;
  npcs.forEach((n) => {
    const d = Math.hypot(n.obj.position.x - rat.x, n.obj.position.z - rat.z);
    if (d < best && t - (n.lastEncounterAt || -Infinity) > 45) { best = d; nearest = n; }
  });
  if (!nearest) return;
  npcNextEncounterAt = t + 8;
  runEncounter(nearest, t, rat);
}

// ---------------------------------------------------------------------------
// Load + per frame
// ---------------------------------------------------------------------------
new THREE.GLTFLoader().load(
  NPC_MODEL_URL,
  (gltf) => {
    npcTemplates = buildNpcTemplates(gltf.scene);
    spawnParkNpcs();
  },
  undefined,
  (err) => console.error('NPC crowd model failed to load:', err)
);

actors.onFrame((dt, now) => {
  const t = now / 1000;
  maintainCityWalkers(t);
  npcs.forEach((npc) => updateNpc(npc, dt, t));
  if (!talk.lines) return;
  if (t >= npcNextChatAt) {
    startChatter(t);
    npcNextChatAt = t + 2.5 + Math.random() * 3;
  }
  updateEncounters(t);
});
