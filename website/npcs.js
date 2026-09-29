// ---------------------------------------------------------------------------
// Park NPCs, built from assets/models/Crowd/crowd.glb (apelab). That file is
// one static scene of 7 standing people in a row, each split into separate
// head/torso/legs meshes, plus a ground plane and one stray head — so the
// people are pulled apart by clustering their meshes by position, re-centred
// on their feet, and cloned into individual characters. The model faces +X.
//
// No skeleton or animations, so walking is faked with a step bob and a small
// side-to-side sway. Strollers follow real park footpaths (Mapbox Streets v8
// footway geometry, simplified); the rest stand around in small groups.
//
// Requires map.js and actors.js to have run first.
// ---------------------------------------------------------------------------
const NPC_MODEL_URL = 'assets/models/Crowd/crowd.glb';
const NPC_HEIGHT_M = 2.6; // a bit over life size so they read next to the (big) rat
const NPC_WALK_SPEED_MPS = 1.6;
const NPC_TURN_DEG_PER_SEC = 240;

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

// Standing groups on the lawns (spots checked clear of buildings and water).
const NPC_GROUPS = [
  { center: [-77.0359, 38.9220], size: 3 },
  { center: [-77.0357, 38.9228], size: 2 },
  { center: [-77.0352, 38.9201], size: 2 },
];

const METERS_PER_DEG_LAT = 111320;
const npcs = [];

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
      const template = new THREE.Group();
      template.add(body);
      template.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
      return template;
    });
}

// Polyline in local meters with cumulative distances, for ping-pong walking.
function buildRoute(lngLats) {
  const pts = lngLats.map(([lng, lat]) => ({ lng, lat }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = actors.toLocal(pts[i - 1].lng, pts[i - 1].lat), b = actors.toLocal(pts[i].lng, pts[i].lat);
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return { pts, cum, length: cum[cum.length - 1] };
}

// Position + compass bearing at distance d along the route.
function routeAt(route, d) {
  let i = 1;
  while (i < route.cum.length - 1 && route.cum[i] < d) i++;
  const a = route.pts[i - 1], b = route.pts[i];
  const seg = route.cum[i] - route.cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (d - route.cum[i - 1]) / seg));
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const bearing = (Math.atan2((b.lng - a.lng) * cosLat, b.lat - a.lat) * 180) / Math.PI;
  return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t, bearing };
}

function spawnNpcs(templates) {
  let n = 0;
  const nextTemplate = () => templates[n++ % templates.length].clone(true);

  NPC_STROLL_ROUTES.forEach((lngLats, i) => {
    const route = buildRoute(lngLats);
    npcs.push({
      kind: 'stroll', obj: nextTemplate(), route,
      dist: route.length * ((i * 0.37) % 1), dir: i % 2 ? -1 : 1,
      speed: NPC_WALK_SPEED_MPS * (0.85 + ((i * 0.53) % 0.3)),
      phase: i * 1.7, facingDeg: 0, groundZ: 60, groundAt: -Infinity,
    });
  });

  NPC_GROUPS.forEach((g, gi) => {
    const radius = NPC_HEIGHT_M * 0.45;
    for (let k = 0; k < g.size; k++) {
      const a = (k / g.size) * Math.PI * 2 + gi;
      const lat = g.center[1] + (Math.cos(a) * radius) / METERS_PER_DEG_LAT;
      const lng = g.center[0] + (Math.sin(a) * radius) / (METERS_PER_DEG_LAT * Math.cos((g.center[1] * Math.PI) / 180));
      const faceCenter = ((a * 180) / Math.PI + 180) % 360; // turned in toward the group
      npcs.push({
        kind: 'stand', group: gi, obj: nextTemplate(), lng, lat,
        facingDeg: faceCenter, phase: gi * 2 + k * 1.3, groundZ: 60, groundAt: -Infinity,
      });
    }
  });

  npcs.forEach((npc) => actors.scene.add(npc.obj));
}

function updateNpc(npc, dt, t) {
  let bob = 0, sway = 0, facing = npc.facingDeg;

  if (npc.kind === 'stroll') {
    npc.dist += npc.dir * npc.speed * dt;
    if (npc.dist > npc.route.length) { npc.dist = npc.route.length; npc.dir = -1; }
    if (npc.dist < 0) { npc.dist = 0; npc.dir = 1; }
    const at = routeAt(npc.route, npc.dist);
    npc.lng = at.lng; npc.lat = at.lat;
    const target = npc.dir > 0 ? at.bearing : at.bearing + 180;
    const diff = ((target - npc.facingDeg + 540) % 360) - 180;
    const maxTurn = NPC_TURN_DEG_PER_SEC * dt;
    npc.facingDeg += Math.max(-maxTurn, Math.min(maxTurn, diff));
    facing = npc.facingDeg;
    const step = t * 2 * Math.PI * 1.8 + npc.phase;
    bob = Math.abs(Math.sin(step)) * NPC_HEIGHT_M * 0.025;
    sway = Math.sin(step) * 0.05;
  } else {
    // Standing: small weight shifts and glances around.
    facing = npc.facingDeg + Math.sin(t * 0.6 + npc.phase) * 12;
    sway = Math.sin(t * 0.9 + npc.phase) * 0.02;
  }

  if (t - npc.groundAt > 0.4) {
    npc.groundZ = actorGroundHeight(npc.lng, npc.lat, npc.groundZ);
    npc.groundAt = t;
  }
  const { x, z } = actors.toLocal(npc.lng, npc.lat);
  npc.obj.position.set(x, npc.groundZ + bob, z);
  npc.obj.rotation.set(0, actors.yawForBearing(facing, '+x'), 0);
  npc.obj.children[0].rotation.x = sway; // rock side to side (model's x axis points forward)
}

// ---------------------------------------------------------------------------
// Talk bubbles. Dialogue lives in npc-lines.json (plus the site's own
// upcoming events and park facts) so it can be edited or regenerated without
// touching code. Standing groups hold short back-and-forth conversations,
// strollers say one-liners, and anyone the rat runs past reacts to it.
// Bubbles are HTML over the map, positioned from the NPC's head each frame.
// ---------------------------------------------------------------------------
const NPC_LINES_URL = 'npc-lines.json';
const NPC_MAX_BUBBLES = 3;
const NPC_MIN_ONSCREEN_PX = 14; // no bubbles for NPCs drawn smaller than this
const NPC_RAT_REACT_M = 14;
const npcTalk = { lines: null, queue: [], active: [], recent: [], nextChatAt: 0, layer: document.getElementById('npc-talk-layer') };

fetch(NPC_LINES_URL)
  .then((r) => r.json())
  .then((lines) => { npcTalk.lines = lines; })
  .catch((err) => console.error('NPC lines failed to load:', err));

function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Random pick that skips anything said recently, so lines don't repeat back to back.
function pickFresh(arr) {
  const fresh = arr.filter((x) => !npcTalk.recent.includes(x));
  const choice = pickOne(fresh.length ? fresh : arr);
  npcTalk.recent.push(choice);
  if (npcTalk.recent.length > 8) npcTalk.recent.shift();
  return choice;
}

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

function npcOneLiner() {
  const L = npcTalk.lines;
  const r = Math.random();
  if (r < 0.1) {
    const next = upcomingEvents()[0];
    if (next) {
      const when = new Date(next.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      return `Are you going to ${next.name} on ${when}?`;
    }
  } else if (r < 0.18) {
    return 'Fun fact: ' + pickFresh(facts.filter((f) => f.length <= 130));
  } else if (r < 0.33) {
    return pickFresh(L.timeOfDay[npcTimeOfDay()]);
  } else if (r < 0.45) {
    return pickFresh(L.season[npcSeason()]);
  }
  return pickFresh(L.lines);
}

function npcTalkSeconds(text) {
  return Math.min(7, Math.max(3, 2.2 + text.length * 0.05));
}

// Where an NPC's head is on screen, or null if it's off screen or too small.
function npcHeadOnScreen(npc) {
  const { x, y, z } = npc.obj.position;
  const head = actors.toScreen(x, y + NPC_HEIGHT_M + 0.35, z);
  const feet = actors.toScreen(x, y, z);
  if (!head || !feet || feet.y - head.y < NPC_MIN_ONSCREEN_PX) return null;
  const canvas = map.getCanvas();
  if (head.x < 0 || head.x > canvas.clientWidth || head.y < 0 || feet.y > canvas.clientHeight) return null;
  return head;
}

function npcIsTalking(npc) {
  return npcTalk.active.some((b) => b.npc === npc) || npcTalk.queue.some((u) => u.npc === npc);
}

function npcShowBubble(npc, text, t, extraClass) {
  npcTalk.active.filter((b) => b.npc === npc).forEach(npcHideBubble);
  const el = document.createElement('div');
  el.className = 'npc-talk' + (extraClass ? ' ' + extraClass : '');
  el.textContent = text;
  npcTalk.layer.appendChild(el);
  npcTalk.active.push({ npc, el, until: t + npcTalkSeconds(text) });
  npc.lastSpokeAt = t;
}

function npcHideBubble(bubble) {
  npcTalk.active.splice(npcTalk.active.indexOf(bubble), 1);
  bubble.el.classList.add('leaving');
  setTimeout(() => bubble.el.remove(), 250);
}

function npcStartChatter(t) {
  const busy = npcTalk.active.length + npcTalk.queue.length;
  if (busy >= NPC_MAX_BUBBLES) return;
  const candidates = npcs.filter((n) => !npcIsTalking(n) && t - (n.lastSpokeAt || -Infinity) > 8 && npcHeadOnScreen(n));
  if (!candidates.length) return;
  const speaker = pickOne(candidates);
  const group = speaker.kind === 'stand' ? npcs.filter((n) => n.group === speaker.group && !npcIsTalking(n)) : [];

  if (group.length >= 2) {
    // A short conversation, alternating between the group's members.
    const start = group.indexOf(speaker);
    let at = t;
    pickFresh(npcTalk.lines.conversations).forEach((text, i) => {
      npcTalk.queue.push({ npc: group[(start + i) % group.length], text, at });
      at += npcTalkSeconds(text) - 0.4;
    });
  } else {
    npcTalk.queue.push({ npc: speaker, text: npcOneLiner(), at: t });
  }
}

function updateNpcTalk(t) {
  if (!npcTalk.lines) return;

  if (t >= npcTalk.nextChatAt) {
    npcStartChatter(t);
    npcTalk.nextChatAt = t + 2.5 + Math.random() * 3;
  }

  // Anyone the running rat passes close to reacts straight away.
  if (ratModeActive && ratState.moving) {
    const rat = actors.toLocal(ratState.lng, ratState.lat);
    npcs.forEach((npc) => {
      const near = Math.hypot(npc.obj.position.x - rat.x, npc.obj.position.z - rat.z) < NPC_RAT_REACT_M;
      if (near && t - (npc.lastReactAt || -Infinity) > 10) {
        npc.lastReactAt = t;
        npcTalk.queue = npcTalk.queue.filter((u) => u.npc !== npc);
        npcShowBubble(npc, pickFresh(npcTalk.lines.ratReactions), t, 'rat-react');
      }
    });
  }

  npcTalk.queue = npcTalk.queue.filter((u) => {
    if (u.at > t) return true;
    npcShowBubble(u.npc, u.text, t);
    return false;
  });

  npcTalk.active.slice().forEach((b) => { if (t > b.until) npcHideBubble(b); });

  // Place bubbles over heads, stacking any that would overlap (people in a
  // group stand close together, so their bubbles would otherwise pile up).
  const placed = [];
  npcTalk.active
    .map((b) => ({ b, head: npcHeadOnScreen(b.npc) }))
    .sort((p, q) => (q.head ? q.head.y : 0) - (p.head ? p.head.y : 0)) // lowest on screen first
    .forEach(({ b, head }) => {
      b.el.style.display = head ? '' : 'none';
      if (!head) return;
      const w = b.el.offsetWidth, h = b.el.offsetHeight + 6; // + speech tail
      let bottom = head.y;
      for (let moved = true; moved;) {
        moved = false;
        for (const p of placed) {
          const overlapX = head.x - w / 2 < p.right && head.x + w / 2 > p.left;
          if (overlapX && bottom > p.top && bottom - h < p.bottom) { bottom = p.top - 2; moved = true; }
        }
      }
      placed.push({ left: head.x - w / 2, right: head.x + w / 2, top: bottom - h, bottom });
      b.el.style.transform = `translate(${head.x}px, ${bottom}px) translate(-50%, -100%)`;
    });
}

new THREE.GLTFLoader().load(
  NPC_MODEL_URL,
  (gltf) => spawnNpcs(buildNpcTemplates(gltf.scene)),
  undefined,
  (err) => console.error('NPC crowd model failed to load:', err)
);

actors.onFrame((dt, now) => {
  const t = now / 1000;
  npcs.forEach((npc) => updateNpc(npc, dt, t));
  updateNpcTalk(t);
});
