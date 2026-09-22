// ---------------------------------------------------------------------------
// First-person "walk the park" mode, built on Mapbox's Free Camera API.
// Relies on `map`, `PARK_BOUNDS`, `mapboxgl` from map.js (loaded first).
// ---------------------------------------------------------------------------
const WALK_EYE_HEIGHT = 1.7;   // meters
const WALK_SPEED = 3.2;        // meters/sec
const RUN_MULTIPLIER = 2.2;
const TURN_SPEED_DEG = 90;     // deg/sec, for arrow-key turning
const LOOK_SENSITIVITY = 0.15; // deg per pixel of drag
const METERS_PER_DEG_LAT = 111320;
const PARK_MARGIN_DEG = 0.0003;

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

const walkState = {
  active: false,
  lng: 0,
  lat: 0,
  yaw: 0,
  pitchLookDelta: 0,
  walkTarget: null,
  moveVector: null,
  dragMode: 'look',
  lastTime: 0,
  saved: null,
  smoothedAltitude: null,
  groundElev: null
};

const pressedKeys = new Set();
const walkHandlers = () => [
  map.dragPan, map.scrollZoom, map.dragRotate,
  map.touchZoomRotate, map.touchPitch, map.doubleClickZoom,
  map.keyboard, map.boxZoom
];

function metersPerDegLng(lat) {
  return METERS_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
}

function refreshGroundElevation() {
  walkState.groundElev = map.queryTerrainElevation([walkState.lng, walkState.lat], { exaggerated: true }) || 0;
}

function moveByMeters(dxEast, dyNorth) {
  const mLng = metersPerDegLng(walkState.lat);
  let newLat = walkState.lat + dyNorth / METERS_PER_DEG_LAT;
  let newLng = walkState.lng + dxEast / mLng;
  newLng = clamp(newLng, PARK_BOUNDS.sw[0] + PARK_MARGIN_DEG, PARK_BOUNDS.ne[0] - PARK_MARGIN_DEG);
  newLat = clamp(newLat, PARK_BOUNDS.sw[1] + PARK_MARGIN_DEG, PARK_BOUNDS.ne[1] - PARK_MARGIN_DEG);
  walkState.lng = newLng;
  walkState.lat = newLat;
  refreshGroundElevation();
}

function applyWalkCamera() {
  // Ground elevation is only re-queried on actual movement (see moveByMeters),
  // not every animation frame — querying it continuously while stationary was
  // the source of the persistent jitter, since even tiny per-call fluctuations
  // are very visible at 1.7m eye height.
  const targetAltitude = (walkState.groundElev || 0) + WALK_EYE_HEIGHT;

  walkState.smoothedAltitude = walkState.smoothedAltitude === null
    ? targetAltitude
    : lerp(walkState.smoothedAltitude, targetAltitude, 0.3);

  const camera = new mapboxgl.FreeCameraOptions();
  camera.position = mapboxgl.MercatorCoordinate.fromLngLat([walkState.lng, walkState.lat], walkState.smoothedAltitude);
  camera.setPitchBearing(90 + walkState.pitchLookDelta, walkState.yaw);
  map.setFreeCameraOptions(camera);
}

// lerp() is already defined globally in map.js (loaded before this file).

// Approximates "start from the nearest street" by snapping the entry point
// to the nearest edge of the park boundary (a park entrance), rather than
// dropping the walker in the middle of a lawn.
function nearestEntryPoint(lng, lat) {
  const mLng = metersPerDegLng(lat);
  const w = PARK_BOUNDS.sw[0] + PARK_MARGIN_DEG;
  const e = PARK_BOUNDS.ne[0] - PARK_MARGIN_DEG;
  const s = PARK_BOUNDS.sw[1] + PARK_MARGIN_DEG;
  const n = PARK_BOUNDS.ne[1] - PARK_MARGIN_DEG;
  const clampedLat = clamp(lat, s, n);
  const clampedLng = clamp(lng, w, e);

  const candidates = [
    { lng: w, lat: clampedLat, dist: Math.abs(lng - w) * mLng },
    { lng: e, lat: clampedLat, dist: Math.abs(lng - e) * mLng },
    { lng: clampedLng, lat: s, dist: Math.abs(lat - s) * METERS_PER_DEG_LAT },
    { lng: clampedLng, lat: n, dist: Math.abs(lat - n) * METERS_PER_DEG_LAT }
  ];
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0];
}

function flashFade() {
  const el = document.getElementById('walk-fade');
  el.style.transition = 'none';
  el.style.opacity = '1';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.5s ease';
      el.style.opacity = '0';
    });
  });
}

function updateWalk(timestamp) {
  if (!walkState.active) return;
  const dt = Math.min(0.05, (timestamp - walkState.lastTime) / 1000 || 0);
  walkState.lastTime = timestamp;

  const speed = pressedKeys.has('shift') ? WALK_SPEED * RUN_MULTIPLIER : WALK_SPEED;

  let moveForward = 0;
  let moveStrafe = 0;
  if (pressedKeys.has('w') || pressedKeys.has('arrowup')) moveForward += 1;
  if (pressedKeys.has('s') || pressedKeys.has('arrowdown')) moveForward -= 1;
  if (pressedKeys.has('d')) moveStrafe += 1;
  if (pressedKeys.has('a')) moveStrafe -= 1;
  if (pressedKeys.has('arrowleft')) walkState.yaw = (walkState.yaw - TURN_SPEED_DEG * dt + 360) % 360;
  if (pressedKeys.has('arrowright')) walkState.yaw = (walkState.yaw + TURN_SPEED_DEG * dt) % 360;

  // Directional drag ("joystick") input, in [-1, 1] per axis, adds to the
  // keyboard input so partial pushes move at proportionally reduced speed.
  if (walkState.moveVector) {
    moveForward += -walkState.moveVector.y;
    moveStrafe += walkState.moveVector.x;
  }

  const inputMag = Math.hypot(moveForward, moveStrafe);
  if (inputMag > 0.02) {
    walkState.walkTarget = null;
    const bearingRad = walkState.yaw * Math.PI / 180;
    const fwdX = Math.sin(bearingRad), fwdY = Math.cos(bearingRad);
    const rightX = Math.cos(bearingRad), rightY = -Math.sin(bearingRad);
    const ux = moveForward / inputMag, uz = moveStrafe / inputMag;
    const nx = fwdX * ux + rightX * uz;
    const ny = fwdY * ux + rightY * uz;
    const dist = speed * dt * Math.min(inputMag, 1);
    moveByMeters(nx * dist, ny * dist);
  } else if (walkState.walkTarget) {
    const target = walkState.walkTarget;
    const mLng = metersPerDegLng(walkState.lat);
    const dx = (target.lng - walkState.lng) * mLng;
    const dy = (target.lat - walkState.lat) * METERS_PER_DEG_LAT;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.4) {
      walkState.walkTarget = null;
    } else {
      walkState.yaw = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      const step = Math.min(dist, speed * dt);
      moveByMeters((dx / dist) * step, (dy / dist) * step);
    }
  }

  applyWalkCamera();
  requestAnimationFrame(updateWalk);
}

function enterWalkMode() {
  map.stop(); // cancel any in-flight easing/inertia so it can't fight the free camera
  stopAutoRotate(); // aerial auto-rotate would fight the free camera's own bearing control
  stopDragRotate(); // same pointer events on #map would otherwise double-fire with walk's own

  const center = map.getCenter();
  walkState.saved = { center, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };

  const entry = nearestEntryPoint(center.lng, center.lat);
  walkState.lng = entry.lng;
  walkState.lat = entry.lat;
  refreshGroundElevation();

  const mLng = metersPerDegLng(entry.lat);
  const dxToCenter = (PARK_CENTER[0] - entry.lng) * mLng;
  const dyToCenter = (PARK_CENTER[1] - entry.lat) * METERS_PER_DEG_LAT;
  walkState.yaw = (Math.atan2(dxToCenter, dyToCenter) * 180 / Math.PI + 360) % 360;

  walkState.pitchLookDelta = 0;
  walkState.walkTarget = null;
  walkState.moveVector = null;
  walkState.smoothedAltitude = null;
  walkState.active = true;
  walkState.lastTime = performance.now();

  flashFade();
  walkHandlers().forEach((h) => h && h.disable());

  document.body.classList.add('walking');
  document.getElementById('walk-hint').style.display = 'block';
  document.getElementById('walk-toggle').textContent = 'Exit Walk (Esc)';

  requestAnimationFrame(updateWalk);
}

function exitWalkMode() {
  walkState.active = false;
  walkState.moveVector = null;
  pointerActive = false;
  hideJoystick();
  flashFade();
  walkHandlers().forEach((h) => h && h.enable());

  document.body.classList.remove('walking');
  document.getElementById('walk-hint').style.display = 'none';
  document.getElementById('walk-toggle').textContent = 'Walk Mode';

  if (walkState.saved) {
    map.easeTo({ ...walkState.saved, duration: 900 });
  }
}

document.getElementById('walk-toggle').addEventListener('click', () => {
  if (walkState.active) exitWalkMode(); else enterWalkMode();
});

const DRAG_MODES = ['look', 'move', 'rotate'];
const DRAG_MODE_LABELS = { look: 'Drag: Look', move: 'Drag: Move', rotate: 'Drag: Rotate' };
const dragModeToggle = document.getElementById('drag-mode-toggle');
dragModeToggle.addEventListener('click', () => {
  const next = DRAG_MODES[(DRAG_MODES.indexOf(walkState.dragMode) + 1) % DRAG_MODES.length];
  walkState.dragMode = next;
  dragModeToggle.textContent = DRAG_MODE_LABELS[next];
  walkState.moveVector = null;
  pointerActive = false;
  hideJoystick();
});

window.addEventListener('keydown', (e) => {
  if (!walkState.active) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { exitWalkMode(); return; }
  pressedKeys.add(k);
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => pressedKeys.delete(e.key.toLowerCase()));

// ---------------------------------------------------------------------------
// Pointer handling: drag to look around, a plain click/tap walks to that
// ground point. Shared between mouse and single-finger touch.
// ---------------------------------------------------------------------------
const mapEl = document.getElementById('map');
const JOYSTICK_RADIUS = 45;
let pointerActive = false;
let dragMoved = false;
let lastPointerX = 0;
let lastPointerY = 0;
let joystickOriginX = 0;
let joystickOriginY = 0;

function showJoystick(x, y) {
  const base = document.getElementById('joystick-base');
  const knob = document.getElementById('joystick-knob');
  base.style.left = `${x}px`;
  base.style.top = `${y}px`;
  base.style.display = 'block';
  knob.style.left = `${x}px`;
  knob.style.top = `${y}px`;
  knob.style.display = 'block';
}

function updateJoystickKnob(x, y) {
  const knob = document.getElementById('joystick-knob');
  knob.style.left = `${x}px`;
  knob.style.top = `${y}px`;
}

function hideJoystick() {
  document.getElementById('joystick-base').style.display = 'none';
  document.getElementById('joystick-knob').style.display = 'none';
}

function pointerDown(x, y) {
  if (!walkState.active) return;
  pointerActive = true;
  dragMoved = false;
  lastPointerX = x;
  lastPointerY = y;
  if (walkState.dragMode === 'move') {
    joystickOriginX = x;
    joystickOriginY = y;
    showJoystick(x, y);
  }
}

function pointerMove(x, y) {
  if (!walkState.active || !pointerActive) return;

  if (walkState.dragMode === 'move') {
    let dx = x - joystickOriginX;
    let dy = y - joystickOriginY;
    const mag = Math.hypot(dx, dy);
    if (mag > JOYSTICK_RADIUS) {
      dx = (dx / mag) * JOYSTICK_RADIUS;
      dy = (dy / mag) * JOYSTICK_RADIUS;
    }
    updateJoystickKnob(joystickOriginX + dx, joystickOriginY + dy);
    walkState.moveVector = { x: dx / JOYSTICK_RADIUS, y: dy / JOYSTICK_RADIUS };
    return;
  }

  // 'look' and 'rotate' both drag-turn the yaw; only 'look' also tilts pitch.
  const dx = x - lastPointerX;
  const dy = y - lastPointerY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
  if (dragMoved) {
    walkState.yaw = (walkState.yaw + dx * LOOK_SENSITIVITY + 360) % 360;
    if (walkState.dragMode === 'look') {
      walkState.pitchLookDelta = clamp(walkState.pitchLookDelta - dy * LOOK_SENSITIVITY, -70, 70);
    }
    walkState.walkTarget = null;
    lastPointerX = x;
    lastPointerY = y;
  }
}

function pointerUp(x, y) {
  if (!walkState.active) return;

  if (walkState.dragMode === 'move') {
    walkState.moveVector = null;
    hideJoystick();
    pointerActive = false;
    return;
  }

  if (pointerActive && !dragMoved) {
    const rect = mapEl.getBoundingClientRect();
    const lngLat = map.unproject([x - rect.left, y - rect.top]);
    walkState.walkTarget = { lng: lngLat.lng, lat: lngLat.lat };
  }
  pointerActive = false;
  dragMoved = false;
}

mapEl.addEventListener('mousedown', (e) => pointerDown(e.clientX, e.clientY));
window.addEventListener('mousemove', (e) => pointerMove(e.clientX, e.clientY));
window.addEventListener('mouseup', (e) => pointerUp(e.clientX, e.clientY));

mapEl.addEventListener('touchstart', (e) => {
  if (!walkState.active) return;
  const t = e.touches[0];
  pointerDown(t.clientX, t.clientY);
}, { passive: true });

mapEl.addEventListener('touchmove', (e) => {
  if (!walkState.active) return;
  e.preventDefault();
  const t = e.touches[0];
  pointerMove(t.clientX, t.clientY);
}, { passive: false });

mapEl.addEventListener('touchend', (e) => {
  if (!walkState.active) return;
  const t = e.changedTouches[0];
  pointerUp(t.clientX, t.clientY);
});
