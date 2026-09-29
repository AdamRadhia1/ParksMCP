// ---------------------------------------------------------------------------
// The player-controlled rat (Quaternius CC0 low-poly rat, 31-joint skeleton
// with real Run/Idle clips). Rendered through the shared three.js layer in
// actors.js.
//
// Controls are screen-relative: up/W runs away from the camera, down/S
// toward it, left/right across the screen. The camera never rotates in rat
// mode — it only pans when the rat leaves a central "dead zone", so the rat
// visibly runs around the screen instead of the whole map lurching on every
// keypress. Mapbox's own arrow-key map navigation is switched off in rat
// mode for the same reason (it was panning the view on every arrow press).
//
// Requires map.js and actors.js to have run first.
// ---------------------------------------------------------------------------

// Inside the real park (west lawn). map.js's PARK_CENTER is actually out on
// 16th St, which is why the rat used to start wedged against buildings.
const RAT_START = [-77.0360, 38.9216];
const RAT_SPEED_MPS = 10;
const RAT_TURN_DEG_PER_SEC = 720;
const RAT_METERS_PER_DEG_LAT = 111320;
function ratMetersPerDegLngAt(lat) { return RAT_METERS_PER_DEG_LAT * Math.cos(lat * Math.PI / 180); }

const ratState = {
  lng: RAT_START[0], lat: RAT_START[1],
  groundZ: 60,
  moving: false,
  facingDeg: 0,       // where the model currently points (smoothed)
  targetFacingDeg: 0, // where input wants it to point
};

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const RAT_CAM_ZOOM = 19;
const RAT_CAM_PITCH = 50;
// Screen-fraction box the rat can roam in before the camera pans. Kept
// inside the clear middle of the screen, away from the side panels.
const RAT_DEAD_ZONE = { left: 0.35, right: 0.65, top: 0.4, bottom: 0.72 };

function enterRatCam() {
  map.easeTo({
    center: [ratState.lng, ratState.lat],
    zoom: RAT_CAM_ZOOM,
    pitch: RAT_CAM_PITCH,
    duration: 900,
  });
}

function followRat() {
  if (map.isEasing()) return;
  const p = map.project([ratState.lng, ratState.lat]);
  const canvas = map.getCanvas();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  // Way off-screen (e.g. after Reset View) — just recenter on it.
  if (!Number.isFinite(p.x) || p.x < -w * 0.5 || p.x > w * 1.5 || p.y < -h * 0.5 || p.y > h * 1.5) {
    map.jumpTo({ center: [ratState.lng, ratState.lat] });
    return;
  }
  const l = w * RAT_DEAD_ZONE.left, r = w * RAT_DEAD_ZONE.right;
  const t = h * RAT_DEAD_ZONE.top, b = h * RAT_DEAD_ZONE.bottom;
  const dx = p.x < l ? p.x - l : p.x > r ? p.x - r : 0;
  const dy = p.y < t ? p.y - t : p.y > b ? p.y - b : 0;
  if (dx || dy) map.panBy([dx, dy], { duration: 0 });
}

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------
let ratModeActive = false;

function updateRatHint() {
  const hint = document.getElementById('rat-hint');
  if (!hint) return;
  hint.innerHTML = ratModeActive
    ? '<strong>You are the rat.</strong> Arrow keys or WASD to run. Esc to stop.'
    : '<strong>Rat parked.</strong> Use the map controls, or press "Rat" to take over.';
}

function exitRatMode() {
  if (!ratModeActive) return;
  ratModeActive = false;
  ratPressedKeys.clear();
  ratState.moving = false;
  setRatRunSound(false);
  map.keyboard.enable();
  talk.cancel(ratSpeaker);
  ratIntroUntil = 0;
  updateRatHint();
}

function enterRatMode() {
  if (ratModeActive) return;
  ratModeActive = true;
  initRatSound();
  map.keyboard.disable();
  // Face away from the camera, so the rat starts out seen from behind.
  ratState.targetFacingDeg = ratState.facingDeg = map.getBearing();
  updateRatHint();
  enterRatCam();
  if (!ratIntroduced) {
    ratIntroduced = true;
    ratIntroStartAt = performance.now() / 1000 + 1; // once the camera has swung in
  } else {
    ratNextChatterAt = performance.now() / 1000 + 8;
  }
}

document.getElementById('rat-mode-toggle')?.addEventListener('click', enterRatMode);

// ---------------------------------------------------------------------------
// Running sound — assets/runningrat.wav looped gaplessly through Web Audio
// (an <audio loop> element leaves an audible gap at each repeat). It plays
// continuously at zero volume and just fades in/out, so starting and
// stopping is instant. Created on the "Rat" click, since browsers only
// allow audio to start from a user gesture.
// ---------------------------------------------------------------------------
const RAT_SOUND_URL = 'assets/runningrat.wav';
const RAT_SOUND_VOLUME = 0.8;
const ratSound = { ctx: null, gain: null };

async function initRatSound() {
  if (ratSound.ctx) { ratSound.ctx.resume(); return; }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  ratSound.ctx = ctx;
  ratSound.gain = gain;
  try {
    const data = await (await fetch(RAT_SOUND_URL)).arrayBuffer();
    const buffer = await ctx.decodeAudioData(data);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(gain);
    src.start();
  } catch (e) {
    console.error('Rat running sound failed to load:', e);
  }
}

function setRatRunSound(running) {
  if (!ratSound.gain) return;
  const t = ratSound.ctx.currentTime;
  ratSound.gain.gain.cancelScheduledValues(t);
  ratSound.gain.gain.setTargetAtTime(running ? RAT_SOUND_VOLUME : 0, t, 0.06);
}

// ---------------------------------------------------------------------------
// Collision: buildings (footprints from city.js), and anything else that
// adds itself to ratBlockers (cars.js adds the cars).
// ---------------------------------------------------------------------------
const RAT_NOSE_M = 2.8; // head is this far ahead of the rat's origin
const ratBlockers = [(lng, lat) => city.pointInBuilding(lng, lat)];

function ratBlockedAt(lng, lat) {
  return ratBlockers.some((blocks) => blocks(lng, lat));
}

// Moves the rat by (dEast, dNorth) meters unless that would put its body or
// nose inside a building or a car. If the full move is blocked, tries each
// axis on its own so the rat slides along walls instead of sticking to them.
// If it somehow already starts inside one, it's let out freely.
function ratTryMove(dEast, dNorth) {
  const mLng = ratMetersPerDegLngAt(ratState.lat);
  const startsInside = ratBlockedAt(ratState.lng, ratState.lat);
  const attempts = [[dEast, dNorth], [dEast, 0], [0, dNorth]];
  for (const [de, dn] of attempts) {
    if (!de && !dn) continue;
    const lng = ratState.lng + de / mLng;
    const lat = ratState.lat + dn / RAT_METERS_PER_DEG_LAT;
    const len = Math.hypot(de, dn);
    const noseLng = lng + (de / len) * RAT_NOSE_M / mLng;
    const noseLat = lat + (dn / len) * RAT_NOSE_M / RAT_METERS_PER_DEG_LAT;
    const blocked = !startsInside && (ratBlockedAt(lng, lat) || ratBlockedAt(noseLng, noseLat));
    if (!blocked) {
      ratState.lng = lng;
      ratState.lat = lat;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Input + movement loop
// ---------------------------------------------------------------------------
const ratPressedKeys = new Set();
const RAT_TYPING_TAGS = new Set(['INPUT', 'TEXTAREA']);
const RAT_ARROWS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

window.addEventListener('keydown', (e) => {
  if (RAT_TYPING_TAGS.has(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { exitRatMode(); return; }
  if (ratModeActive && RAT_ARROWS.has(k)) e.preventDefault();
  ratPressedKeys.add(k);
});
window.addEventListener('keyup', (e) => ratPressedKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => ratPressedKeys.clear());

function shortestAngleDiff(from, to) {
  return ((to - from + 540) % 360) - 180;
}

let ratLastTime = null;
function ratMoveLoop(now) {
  const dt = ratLastTime === null ? 0 : Math.min(0.1, (now - ratLastTime) / 1000);
  ratLastTime = now;

  let fwd = 0, right = 0;
  if (ratModeActive) {
    if (ratPressedKeys.has('w') || ratPressedKeys.has('arrowup')) fwd += 1;
    if (ratPressedKeys.has('s') || ratPressedKeys.has('arrowdown')) fwd -= 1;
    if (ratPressedKeys.has('d') || ratPressedKeys.has('arrowright')) right += 1;
    if (ratPressedKeys.has('a') || ratPressedKeys.has('arrowleft')) right -= 1;
  }

  let moved = false;
  if (fwd || right) {
    // Screen-relative: "up" is wherever the camera is currently looking.
    const cam = (map.getBearing() * Math.PI) / 180;
    let east = fwd * Math.sin(cam) + right * Math.cos(cam);
    let north = fwd * Math.cos(cam) - right * Math.sin(cam);
    const len = Math.hypot(east, north) || 1;
    east /= len; north /= len;
    ratState.targetFacingDeg = (Math.atan2(east, north) * 180) / Math.PI;
    const dist = RAT_SPEED_MPS * dt;
    moved = dist > 0 && ratTryMove(east * dist, north * dist);
  }
  if (moved !== ratState.moving) {
    ratState.moving = moved;
    setRatRunSound(moved);
  }

  const diff = shortestAngleDiff(ratState.facingDeg, ratState.targetFacingDeg);
  const maxTurn = RAT_TURN_DEG_PER_SEC * dt;
  ratState.facingDeg += Math.max(-maxTurn, Math.min(maxTurn, diff));

  ratState.groundZ = actorGroundHeight(ratState.lng, ratState.lat, ratState.groundZ);
  if (ratModeActive) {
    followRat();
    ratSpeak(now / 1000);
  }
  requestAnimationFrame(ratMoveLoop);
}

// ---------------------------------------------------------------------------
// Washington talks: introduces himself the first time you become the rat
// (once per visit), then comments on where you are — nearby food spots and
// apartment buildings from city.js, the park, or general rat wisdom. His
// back-and-forth with NPCs lives in npcs.js.
// ---------------------------------------------------------------------------
const RAT_PARK_BOUNDS = [-77.0364, 38.9192, -77.0348, 38.9233]; // Meridian Hill Park, from the map's park polygon
let ratIntroduced = false;
let ratIntroStartAt = null;
let ratIntroUntil = 0;   // NPC encounters and chatter wait until the intro is done
let ratNextChatterAt = 0;

function ratInPark() {
  const [w, s, e, n] = RAT_PARK_BOUNDS;
  return ratState.lng > w && ratState.lng < e && ratState.lat > s && ratState.lat < n;
}

function ratSpeak(t) {
  if (!talk.lines) return;
  const L = talk.lines.rat;

  if (ratIntroStartAt !== null) {
    if (t < ratIntroStartAt) return; // intro's about to start; nothing else first
    let delay = 0;
    L.intro.forEach((line) => {
      talk.say(ratSpeaker, line, delay, 'rat');
      delay += talk.secondsFor(line) + 0.2;
    });
    ratIntroStartAt = null;
    ratIntroUntil = t + delay;
    ratNextChatterAt = ratIntroUntil + 10;
    return;
  }

  if (t < ratIntroUntil || t < ratNextChatterAt || talk.busy(ratSpeaker)) return;
  ratNextChatterAt = t + 16 + Math.random() * 10;
  // Places he hasn't mentioned lately, so he doesn't keep naming the same one.
  const unmentioned = (places) => places.map((p) => p.name).filter((name) => !talk.recent.includes(name));
  const food = unmentioned(city.placesNear(city.food, ratState.lng, ratState.lat, 150, 3));
  const homes = unmentioned(city.placesNear(city.apartments, ratState.lng, ratState.lat, 120, 2));
  const r = Math.random();
  let line;
  if (food.length && r < 0.45) line = talk.fill(talk.pickFresh(L.nearFood), talk.pickFresh(food));
  else if (homes.length && r < 0.6) line = talk.fill(talk.pickFresh(L.nearApartment), talk.pickFresh(homes));
  else if (ratInPark() && r < 0.75) line = talk.pickFresh(L.inPark);
  else line = talk.pickFresh(L.chatter);
  talk.say(ratSpeaker, line, 0, 'rat');
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
const RAT_MODEL_URL = 'assets/models/QuaterniusRat/rat.glb';
const RAT_MODEL_SCALE = 1.5;
// Small lift so the low-hanging tail never sinks into the terrain surface
// (the queried elevation and the rendered terrain mesh don't match exactly).
const RAT_GROUND_LIFT_M = 0.3;
const RAT_RUN_ANIM_SPEED = 1.6; // run cycle sped up to match the faster run
const RAT_ANIM_NAMES = { idle: 'RatArmature|Rat_Idle', run: 'RatArmature|Rat_Run' };

const ratRoot = new THREE.Group();
ratRoot.scale.setScalar(RAT_MODEL_SCALE);
actors.scene.add(ratRoot);
// Washington's speech bubbles anchor just above his head, and always show.
const ratSpeaker = { obj: ratRoot, headHeight: 2.6, minPx: 0 };

const ratAnim = { mixer: null, actions: {}, current: null };

function playRatAnim(name) {
  const next = ratAnim.actions[name];
  if (!next || ratAnim.current === name) return;
  const prev = ratAnim.actions[ratAnim.current];
  next.reset().play();
  if (prev) prev.crossFadeTo(next, 0.15, false);
  ratAnim.current = name;
}

new THREE.GLTFLoader().load(
  RAT_MODEL_URL,
  (gltf) => {
    gltf.scene.traverse((o) => {
      // Skinned meshes are frustum-culled by their bind-pose bounds, which
      // don't follow the animated pose — parts like the tail can get culled
      // while still on screen.
      if (o.isMesh) o.frustumCulled = false;
    });
    ratRoot.add(gltf.scene);
    actors.markXray(ratRoot);
    ratAnim.mixer = new THREE.AnimationMixer(gltf.scene);
    gltf.animations.forEach((clip) => { ratAnim.actions[clip.name] = ratAnim.mixer.clipAction(clip); });
    const run = ratAnim.actions[RAT_ANIM_NAMES.run];
    if (run) run.timeScale = RAT_RUN_ANIM_SPEED;
    playRatAnim(RAT_ANIM_NAMES.idle);
  },
  undefined,
  (err) => console.error('Rat model failed to load:', err)
);

actors.onFrame((dt) => {
  if (ratAnim.mixer) {
    playRatAnim(ratState.moving ? RAT_ANIM_NAMES.run : RAT_ANIM_NAMES.idle);
    ratAnim.mixer.update(dt);
  }
  const { x, z } = actors.toLocal(ratState.lng, ratState.lat);
  ratRoot.position.set(x, ratState.groundZ + RAT_GROUND_LIFT_M, z);
  ratRoot.rotation.y = actors.yawForBearing(ratState.facingDeg, '+z'); // model's head is +Z (checked from its skeleton)
});

updateRatHint();

whenTerrainReady(() => requestAnimationFrame(ratMoveLoop));
