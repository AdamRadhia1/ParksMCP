mapboxgl.accessToken = window.MAPBOX_TOKEN;

// ---------------------------------------------------------------------------
// Park geography (approximate — stylized for this map, not surveyed GIS data)
// ---------------------------------------------------------------------------
const PARK_CENTER = [-77.0367, 38.9213];

const PARK_BOUNDS = {
  sw: [-77.0387, 38.9188],
  ne: [-77.0348, 38.9240]
};

const PARK_NORTH_LAT = 38.9231; // upper terrace / reflecting pool
const PARK_SOUTH_LAT = 38.9197; // lower terrace / Buchanan Memorial
const PARK_WEST_LNG = -77.0380;
const PARK_EAST_LNG = -77.0356;
const CHANNEL_WEST_LNG = -77.0372; // west edge of the fountain/cascade channel
const CHANNEL_EAST_LNG = -77.0362; // east edge of the fountain/cascade channel

const INITIAL_VIEW = {
  center: PARK_CENTER,
  zoom: 17.7,
  pitch: 62,
  bearing: -20
};

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  center: INITIAL_VIEW.center,
  zoom: INITIAL_VIEW.zoom,
  pitch: INITIAL_VIEW.pitch,
  bearing: INITIAL_VIEW.bearing,
  antialias: true
});

map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new mapboxgl.FullscreenControl({ container: document.body }), 'top-right');

// Mirrors the real local time of day onto Mapbox Standard's lighting preset.
function lightPresetForNow() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'dusk';
  return 'night';
}

map.on('style.load', () => {
  map.setConfigProperty('basemap', 'lightPreset', lightPresetForNow());
  map.setConfigProperty('basemap', 'showPointOfInterestLabels', true);
  // Standard's own 3D buildings use real footprints/heights plus modeled landmarks.
  map.setConfigProperty('basemap', 'show3dObjects', true);
  // Remove the distance haze / horizon glow, keeping the sky itself.
  map.setFog({ range: [10, 20], 'horizon-blend': 0 });

  if (!map.getSource('mapbox-dem')) {
    map.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14
    });
  }
  map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.4 });
});

// Re-checks the real clock periodically so lighting keeps drifting with the
// actual time of day across a long-running session, not just on load.
function refreshTimeOfDay() {
  map.setConfigProperty('basemap', 'lightPreset', lightPresetForNow());
}
setInterval(refreshTimeOfDay, 5 * 60 * 1000);

// queryTerrainElevation() returns null until the DEM tiles are actually
// decoded, which can happen a beat after 'idle' fires. Poll on the render
// loop until real elevations are available (capped, so a DEM failure can't
// hang scenery forever) before draping any of the custom layers onto it.
function whenTerrainReady(cb) {
  let attempts = 0;
  function check() {
    const e = map.queryTerrainElevation(PARK_CENTER, { exaggerated: true });
    attempts++;
    if ((e !== null && e !== undefined) || attempts > 300) { cb(); return; }
    requestAnimationFrame(check);
  }
  check();
}

map.once('idle', () => {
  whenTerrainReady(() => {
    addGrassLayer();
    addWaterLayer();
    addTreeLayer();
    addFountain();
    addLifeLayer();
  });
});

// ---------------------------------------------------------------------------
// Random fact pop-ups (source: nps.gov/rocr/learn/historyculture/meridian-hill-park.htm)
// ---------------------------------------------------------------------------
const facts = [
  'The park spans over 11 acres in northwest Washington, DC, along 16th Street between Euclid and W Streets NW.',
  'Meridian Hill Park is a National Historic Landmark.',
  'John Porter built a mansion here in 1819 and named it "Meridian Hill" after the original District of Columbia milestone marker.',
  'John Quincy Adams moved into the Meridian Hill mansion after leaving the White House in 1829.',
  'The U.S. government purchased the grounds in 1910 and transferred them to the Office of Public Buildings and Grounds.',
  'George Burnap designed a formal Italian Renaissance-style garden for the park in 1914.',
  "Horace Peaslee later revised Burnap's designs under the oversight of the Fine Arts Commission.",
  'New York landscape architects Vital, Brinckerhoff, and Geffert created the park\'s planting scheme.',
  'Construction began in 1914, but the park did not reach full formal status until 1936.',
  'The grounds were transferred to the National Park Service in 1933.',
  'The park pioneered the use of concrete aggregate: selected pebbles treated with wire brushing and acid washing.',
  'A new armillary sphere replica was installed in November 2024, replacing the original removed in the late 1970s.',
  'The Joan of Arc statue was restored in November 2024, including repairs to the spur and bridle.',
  'The cascading fountain reopened to visitors on May 14, 2026, after extensive repairs and rehabilitation.',
  'The park is open 5 am to midnight from May to October, and 5 am to 9 pm from November to April.'
];

const factEl = document.getElementById('fact-text');
let lastFact = -1;
let factTimer = null;

function showRandomFact() {
  let i;
  do { i = Math.floor(Math.random() * facts.length); } while (i === lastFact && facts.length > 1);
  lastFact = i;
  factEl.classList.add('fading');
  setTimeout(() => {
    factEl.textContent = facts[i];
    factEl.classList.remove('fading');
  }, 800);
}

function restartFactTimer() {
  clearInterval(factTimer);
  factTimer = setInterval(showRandomFact, 12000);
}

factEl.classList.add('fading');
factEl.textContent = facts[lastFact = Math.floor(Math.random() * facts.length)];
requestAnimationFrame(() => requestAnimationFrame(() => factEl.classList.remove('fading')));
document.getElementById('panel').addEventListener('click', () => {
  showRandomFact();
  restartFactTimer();
});
restartFactTimer();

document.getElementById('reset-view').addEventListener('click', () => {
  stopAutoRotate();
  stopDragRotate();
  map.flyTo({ ...INITIAL_VIEW, duration: 1200 });
});

let tilted = true;
document.getElementById('tilt-toggle').addEventListener('click', () => {
  tilted = !tilted;
  map.easeTo({ pitch: tilted ? 62 : 0, duration: 800 });
});

// ---------------------------------------------------------------------------
// Auto-rotate — slow cinematic spin around the current center, stoppable by
// the button, by manually dragging the map, or by entering walk mode.
// ---------------------------------------------------------------------------
const AUTO_ROTATE_DEG_PER_SEC = 6;
let autoRotateActive = false;
let autoRotateLastTime = 0;

function autoRotateStep(timestamp) {
  if (!autoRotateActive) return;
  const dt = Math.min(0.1, (timestamp - autoRotateLastTime) / 1000 || 0);
  autoRotateLastTime = timestamp;
  map.setBearing((map.getBearing() + AUTO_ROTATE_DEG_PER_SEC * dt) % 360);
  requestAnimationFrame(autoRotateStep);
}

function stopAutoRotate() {
  autoRotateActive = false;
  document.getElementById('rotate-toggle').textContent = 'Auto-Rotate';
}

function startAutoRotate() {
  autoRotateActive = true;
  autoRotateLastTime = performance.now();
  document.getElementById('rotate-toggle').textContent = 'Stop Rotating';
  requestAnimationFrame(autoRotateStep);
}

document.getElementById('rotate-toggle').addEventListener('click', () => {
  if (autoRotateActive) stopAutoRotate(); else startAutoRotate();
});

map.on('dragstart', stopAutoRotate);
map.on('wheel', stopAutoRotate);

// ---------------------------------------------------------------------------
// Drag-to-rotate — an explicit toggle so a plain left-click drag spins the
// bearing/pitch (to look around at the DC skyline from the park) instead of
// panning. Normal Mapbox right-click-drag rotate still works either way.
// ---------------------------------------------------------------------------
const DRAG_ROTATE_SENSITIVITY = 0.3;
let dragRotateModeActive = false;
let dragRotateDragging = false;
let dragRotateLastX = 0;
let dragRotateLastY = 0;

function stopDragRotate() {
  dragRotateModeActive = false;
  dragRotateDragging = false;
  document.getElementById('drag-rotate-toggle').textContent = 'Drag: Pan';
  map.dragPan.enable();
}

function startDragRotate() {
  dragRotateModeActive = true;
  document.getElementById('drag-rotate-toggle').textContent = 'Drag: Rotate';
  map.dragPan.disable();
  stopAutoRotate();
}

document.getElementById('drag-rotate-toggle').addEventListener('click', () => {
  if (dragRotateModeActive) stopDragRotate(); else startDragRotate();
});

function dragRotatePointerDown(x, y) {
  if (!dragRotateModeActive) return;
  dragRotateDragging = true;
  dragRotateLastX = x;
  dragRotateLastY = y;
}

function dragRotatePointerMove(x, y) {
  if (!dragRotateModeActive || !dragRotateDragging) return;
  const dx = x - dragRotateLastX;
  const dy = y - dragRotateLastY;
  dragRotateLastX = x;
  dragRotateLastY = y;
  map.setBearing((map.getBearing() + dx * DRAG_ROTATE_SENSITIVITY + 360) % 360);
  map.setPitch(clampPitch(map.getPitch() - dy * DRAG_ROTATE_SENSITIVITY));
}

function clampPitch(p) { return Math.min(85, Math.max(0, p)); }

const mapContainerEl = document.getElementById('map');
mapContainerEl.addEventListener('mousedown', (e) => dragRotatePointerDown(e.clientX, e.clientY));
window.addEventListener('mousemove', (e) => dragRotatePointerMove(e.clientX, e.clientY));
window.addEventListener('mouseup', () => { dragRotateDragging = false; });

mapContainerEl.addEventListener('touchstart', (e) => {
  if (!dragRotateModeActive) return;
  const t = e.touches[0];
  dragRotatePointerDown(t.clientX, t.clientY);
}, { passive: true });

mapContainerEl.addEventListener('touchmove', (e) => {
  if (!dragRotateModeActive) return;
  e.preventDefault();
  const t = e.touches[0];
  dragRotatePointerMove(t.clientX, t.clientY);
}, { passive: false });

mapContainerEl.addEventListener('touchend', () => { dragRotateDragging = false; });

// ---------------------------------------------------------------------------
// Minimal column-major mat4 helpers (mirrors the pattern used in Mapbox's
// official "add a custom WebGL layer" examples).
// ---------------------------------------------------------------------------
function multiplyMat4(a, b) {
  const out = new Float64Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + j] * b[i * 4 + k];
      out[i * 4 + j] = sum;
    }
  }
  return out;
}

function translationMat4(tx, ty, tz) {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]);
}

function scaleMat4(sx, sy, sz) {
  return new Float64Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
}

// ---------------------------------------------------------------------------
// Shared geo -> local-meters projection, anchored at the park center so all
// vertex math stays in small, float32-safe numbers.
// ---------------------------------------------------------------------------
const origin = mapboxgl.MercatorCoordinate.fromLngLat(PARK_CENTER, 0);
const meterScale = origin.meterInMercatorCoordinateUnits();

function toLocalMeters(lng, lat) {
  const merc = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0);
  return [(merc.x - origin.x) / meterScale, (merc.y - origin.y) / meterScale];
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Builds a grid mesh over a lng/lat rectangle, draping each vertex onto the
// actual queried terrain elevation (matching the same exaggeration the
// basemap renders with) plus a small constant lift to avoid z-fighting.
function buildGrid(lngMin, lngMax, latMin, latMax, nx, ny, lift) {
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let j = 0; j <= ny; j++) {
    const lat = lerp(latMin, latMax, j / ny);
    for (let i = 0; i <= nx; i++) {
      const lng = lerp(lngMin, lngMax, i / nx);
      const [x, y] = toLocalMeters(lng, lat);
      const elev = (map.queryTerrainElevation([lng, lat], { exaggerated: true }) || 0) + lift;
      positions.push(x, y, elev);
      uvs.push(i / nx, j / ny);
    }
  }

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + (nx + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices)
  };
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function createProgram(gl, vsSource, fsSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
  }
  return program;
}

// ---------------------------------------------------------------------------
// Grass layer — stylized 3D lawn with a bump-mapped surface and a gentle
// wind sway, covering the two lawn areas flanking the central water channel.
// ---------------------------------------------------------------------------
const grassVertexSrc = `
  attribute vec3 a_position;
  attribute vec2 a_uv;
  uniform mat4 u_matrix;
  uniform float u_time;
  varying vec2 v_uv;
  varying float v_bump;
  void main() {
    float bump = sin(a_uv.x * 42.0) * cos(a_uv.y * 37.0) * 0.035;
    float sway = sin(u_time * 1.4 + a_uv.x * 18.0 + a_uv.y * 12.0) * 0.025;
    vec3 pos = a_position;
    pos.z += bump;
    pos.x += sway;
    v_uv = a_uv;
    v_bump = bump;
    gl_Position = u_matrix * vec4(pos, 1.0);
  }
`;

const grassFragmentSrc = `
  precision mediump float;
  varying vec2 v_uv;
  varying float v_bump;
  uniform float u_time;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  void main() {
    float n = hash(floor(v_uv * 140.0));
    vec3 baseColor = mix(vec3(0.09, 0.29, 0.10), vec3(0.23, 0.48, 0.18), n);
    float shade = 0.55 + v_bump * 6.0;
    vec3 color = baseColor * shade;
    float gust = smoothstep(0.48, 0.5, fract((v_uv.x + v_uv.y) * 2.0 - u_time * 0.12));
    color += gust * 0.06;
    gl_FragColor = vec4(color, 1.0);
  }
`;

function addGrassLayer() {
  const west = buildGrid(PARK_WEST_LNG, CHANNEL_WEST_LNG, PARK_SOUTH_LAT, PARK_NORTH_LAT, 24, 48, 0.03);
  const east = buildGrid(CHANNEL_EAST_LNG, PARK_EAST_LNG, PARK_SOUTH_LAT, PARK_NORTH_LAT, 24, 48, 0.03);

  const layer = {
    id: 'park-grass',
    type: 'custom',
    slot: 'middle',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      this.program = createProgram(gl, grassVertexSrc, grassFragmentSrc);
      this.aPosition = gl.getAttribLocation(this.program, 'a_position');
      this.aUv = gl.getAttribLocation(this.program, 'a_uv');
      this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix');
      this.uTime = gl.getUniformLocation(this.program, 'u_time');

      this.meshes = [west, east].map((mesh) => {
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

        const uvBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);

        const idxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

        return { posBuffer, uvBuffer, idxBuffer, count: mesh.indices.length };
      });
    },

    render(gl, matrix) {
      const modelMatrix = translationMat4(origin.x, origin.y, 0);
      const finalMatrix = multiplyMat4(
        Array.from(matrix),
        multiplyMat4(modelMatrix, scaleMat4(meterScale, meterScale, meterScale))
      );

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uMatrix, false, new Float32Array(finalMatrix));
      gl.uniform1f(this.uTime, performance.now() / 1000);

      gl.enable(gl.DEPTH_TEST);

      this.meshes.forEach((mesh) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
        gl.enableVertexAttribArray(this.aPosition);
        gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
        gl.enableVertexAttribArray(this.aUv);
        gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuffer);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      });

      map.triggerRepaint();
    }
  };

  map.addLayer(layer);
}

// ---------------------------------------------------------------------------
// Water layer — animated shimmering surface for the reflecting pool and
// cascading fountain channel down the center of the park.
// ---------------------------------------------------------------------------
const waterVertexSrc = `
  attribute vec3 a_position;
  attribute vec2 a_uv;
  uniform mat4 u_matrix;
  uniform float u_time;
  varying vec2 v_uv;
  void main() {
    float ripple = sin(a_uv.y * 34.0 - u_time * 2.2) * 0.018
                  + sin(a_uv.x * 20.0 + u_time * 1.4) * 0.012;
    vec3 pos = a_position;
    pos.z += ripple + 0.05;
    gl_Position = u_matrix * vec4(pos, 1.0);
    v_uv = a_uv;
  }
`;

const waterFragmentSrc = `
  precision mediump float;
  varying vec2 v_uv;
  uniform float u_time;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  void main() {
    float flow = sin(v_uv.y * 42.0 - u_time * 2.6) * 0.5 + 0.5;
    vec3 deep = vec3(0.02, 0.15, 0.23);
    vec3 shallow = vec3(0.14, 0.53, 0.60);
    vec3 color = mix(deep, shallow, flow * 0.6 + 0.2);
    float sparkle = step(0.985, hash(floor(v_uv * 220.0 + u_time * 3.0)));
    color += sparkle * 0.85;
    gl_FragColor = vec4(color, 0.88);
  }
`;

function addWaterLayer() {
  const mesh = buildGrid(CHANNEL_WEST_LNG, CHANNEL_EAST_LNG, PARK_SOUTH_LAT, PARK_NORTH_LAT, 14, 48, 0.06);

  const layer = {
    id: 'park-water',
    type: 'custom',
    slot: 'top',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      this.program = createProgram(gl, waterVertexSrc, waterFragmentSrc);
      this.aPosition = gl.getAttribLocation(this.program, 'a_position');
      this.aUv = gl.getAttribLocation(this.program, 'a_uv');
      this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix');
      this.uTime = gl.getUniformLocation(this.program, 'u_time');

      this.posBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

      this.uvBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);

      this.idxBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

      this.count = mesh.indices.length;
    },

    render(gl, matrix) {
      const modelMatrix = translationMat4(origin.x, origin.y, 0);
      const finalMatrix = multiplyMat4(
        Array.from(matrix),
        multiplyMat4(modelMatrix, scaleMat4(meterScale, meterScale, meterScale))
      );

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uMatrix, false, new Float32Array(finalMatrix));
      gl.uniform1f(this.uTime, performance.now() / 1000);

      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.enableVertexAttribArray(this.aPosition);
      gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.enableVertexAttribArray(this.aUv);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuffer);
      gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);

      gl.disable(gl.BLEND);

      map.triggerRepaint();
    }
  };

  map.addLayer(layer);
}

// ---------------------------------------------------------------------------
// Tree layer — low-poly faceted trees (hex-cylinder trunks, hex-bipyramid
// canopy lobes) scattered across the two lawns, swaying gently in the wind.
// Built as one static, non-indexed triangle soup so each face keeps its own
// unshared vertices/normals for a flat-shaded, faceted "game" look.
// ---------------------------------------------------------------------------
function seededRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function subVec3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function crossVec3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function normalizeVec3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// Pushes one flat-shaded triangle (own normal, own material/seed/sway per
// vertex) into the shared arrays.
function pushTri(arrays, p0, p1, p2, material, seed, sway0, sway1, sway2) {
  const n = normalizeVec3(crossVec3(subVec3(p1, p0), subVec3(p2, p0)));
  const pts = [p0, p1, p2];
  const sways = [sway0, sway1, sway2];
  for (let k = 0; k < 3; k++) {
    arrays.positions.push(pts[k][0], pts[k][1], pts[k][2]);
    arrays.normals.push(n[0], n[1], n[2]);
    arrays.materials.push(material);
    arrays.seeds.push(seed);
    arrays.sways.push(sways[k]);
  }
}

// A ring of `sides` points around (cx, cy) at height cz and radius r.
function ring(cx, cy, cz, r, sides) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz]);
  }
  return pts;
}

// Tapered hex-cylinder trunk, side faces only (top/bottom hidden by canopy
// and grass respectively).
function buildTrunk(arrays, cx, cy, baseZ, height, baseR, topR, seed) {
  const sides = 6;
  const bottom = ring(cx, cy, baseZ, baseR, sides);
  const top = ring(cx, cy, baseZ + height, topR, sides);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    pushTri(arrays, bottom[i], bottom[j], top[i], 0.0, seed, 0, 0, 0.1);
    pushTri(arrays, top[i], bottom[j], top[j], 0.0, seed, 0.1, 0, 0.1);
  }
}

// Pushes one triangle with its own EXPLICIT per-vertex normals (rather than
// one flat face normal), so lit faces blend smoothly into their neighbors —
// this is what makes the foliage sphere below read as a round leafy blob
// instead of a faceted low-poly gem.
function pushSmoothTri(arrays, p0, p1, p2, n0, n1, n2, material, seed, sway0, sway1, sway2) {
  const pts = [p0, p1, p2];
  const norms = [n0, n1, n2];
  const sways = [sway0, sway1, sway2];
  for (let k = 0; k < 3; k++) {
    arrays.positions.push(pts[k][0], pts[k][1], pts[k][2]);
    arrays.normals.push(norms[k][0], norms[k][1], norms[k][2]);
    arrays.materials.push(material);
    arrays.seeds.push(seed);
    arrays.sways.push(sways[k]);
  }
}

// A smooth, rounded "leaf cluster" lobe — a lat/long ellipsoid with an
// analytic per-vertex normal at every point, giving soft gradient shading
// across the canopy instead of hard low-poly facets.
function buildFoliageLobe(arrays, cx, cy, cz, radiusXY, halfHeight, seed, swayBase) {
  const segments = 8;
  const rings = 5;
  const grid = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;
    const row = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.sin(phi) * Math.sin(theta);
      const nz = Math.cos(phi);
      const pos = [cx + nx * radiusXY, cy + ny * radiusXY, cz + nz * halfHeight];
      const norm = normalizeVec3([nx / radiusXY, ny / radiusXY, nz / halfHeight]);
      row.push({ pos, norm });
    }
    grid.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i], d = grid[j + 1][i + 1];
      pushSmoothTri(arrays, a.pos, b.pos, c.pos, a.norm, b.norm, c.norm, 1.0, seed, swayBase, swayBase, swayBase);
      pushSmoothTri(arrays, b.pos, d.pos, c.pos, b.norm, d.norm, c.norm, 1.0, seed, swayBase, swayBase, swayBase);
    }
  }
}

// A full, bushy crown: several overlapping foliage lobes clustered around
// the trunk top at slightly different heights/offsets, plus one larger
// central lobe tying the cluster together — reads as a dense leafy mass
// rather than a single clean diamond.
function buildTree(arrays, lng, lat, seedBase) {
  const [cx, cy] = toLocalMeters(lng, lat);
  const groundZ = (map.queryTerrainElevation([lng, lat], { exaggerated: true }) || 0) + 0.03;

  const s1 = seededRandom(seedBase);
  const s2 = seededRandom(seedBase + 17.3);

  const trunkHeight = 2.2 + s1 * 1.2;
  const trunkBaseR = 0.16 + s2 * 0.06;
  const trunkTopR = trunkBaseR * 0.55;
  buildTrunk(arrays, cx, cy, groundZ, trunkHeight, trunkBaseR, trunkTopR, seedBase);

  const canopyCenterZ = groundZ + trunkHeight * 0.95;
  const mainRadius = 1.7 + seededRandom(seedBase + 41.7) * 0.5;

  const lobeCount = 4;
  for (let i = 0; i < lobeCount; i++) {
    const ls = seedBase + 100 + i * 23.7;
    const angle = (i / lobeCount) * Math.PI * 2 + seededRandom(ls) * 1.4;
    const dist = mainRadius * (0.3 + seededRandom(ls + 3) * 0.24);
    const lobeR = mainRadius * (0.62 + seededRandom(ls + 6) * 0.3);
    const heightOffset = (seededRandom(ls + 9) - 0.3) * mainRadius * 0.5;
    buildFoliageLobe(
      arrays,
      cx + Math.cos(angle) * dist,
      cy + Math.sin(angle) * dist,
      canopyCenterZ + heightOffset,
      lobeR,
      lobeR * 0.85,
      ls + 1.0,
      0.5
    );
  }

  // Central lobe, a bit larger, fills the middle of the cluster.
  buildFoliageLobe(arrays, cx, cy, canopyCenterZ, mainRadius * 0.8, mainRadius * 0.7, seedBase + 5.0, 0.5);
}

// Jittered-grid scatter over a lng/lat rectangle so trees stay spaced out
// without an expensive collision-rejection loop.
function scatterTrees(arrays, lngMin, lngMax, latMin, latMax, cols, rows, density, seedStart) {
  let seed = seedStart;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      seed += 7.919;
      if (seededRandom(seed) > density) continue;
      const jx = (seededRandom(seed + 3.1) - 0.5) * 0.8;
      const jy = (seededRandom(seed + 6.2) - 0.5) * 0.8;
      const u = (c + 0.5 + jx) / cols;
      const v = (r + 0.5 + jy) / rows;
      const lng = lerp(lngMin, lngMax, u);
      const lat = lerp(latMin, latMax, v);
      buildTree(arrays, lng, lat, seed * 13.37);
    }
  }
}

const treeVertexSrc = `
  attribute vec3 a_position;
  attribute vec3 a_normal;
  attribute float a_material;
  attribute float a_seed;
  attribute float a_sway;
  uniform mat4 u_matrix;
  uniform float u_time;
  varying vec3 v_normal;
  varying float v_material;
  varying float v_seed;
  void main() {
    vec3 pos = a_position;
    float wind = sin(u_time * 1.1 + a_seed * 6.283) * 0.16 * a_sway;
    pos.x += wind;
    pos.y += wind * 0.5;
    v_normal = a_normal;
    v_material = a_material;
    v_seed = a_seed;
    gl_Position = u_matrix * vec4(pos, 1.0);
  }
`;

const treeFragmentSrc = `
  precision mediump float;
  varying vec3 v_normal;
  varying float v_material;
  varying float v_seed;
  uniform vec3 u_lightDir;
  float hash(float x) { return fract(sin(x) * 43758.5453123); }
  void main() {
    float diffuse = max(dot(normalize(v_normal), u_lightDir), 0.0);
    float light = 0.45 + diffuse * 0.55;

    vec3 trunkColor = mix(vec3(0.30, 0.20, 0.12), vec3(0.40, 0.28, 0.16), hash(v_seed));
    vec3 foliageA = vec3(0.14, 0.34, 0.13);
    vec3 foliageB = vec3(0.30, 0.52, 0.20);
    vec3 foliageColor = mix(foliageA, foliageB, hash(v_seed * 3.1 + 1.0));

    vec3 base = mix(trunkColor, foliageColor, step(0.5, v_material));
    gl_FragColor = vec4(base * light, 1.0);
  }
`;

function addTreeLayer() {
  const arrays = { positions: [], normals: [], materials: [], seeds: [], sways: [] };

  // West and east lawns, inset from the water channel and the outer park
  // edge so trees don't crowd the fountain or spill onto the paths.
  scatterTrees(arrays, PARK_WEST_LNG + 0.00012, CHANNEL_WEST_LNG - 0.00008, PARK_SOUTH_LAT + 0.0004, PARK_NORTH_LAT - 0.0004, 5, 9, 0.55, 101);
  scatterTrees(arrays, CHANNEL_EAST_LNG + 0.00008, PARK_EAST_LNG - 0.00012, PARK_SOUTH_LAT + 0.0004, PARK_NORTH_LAT - 0.0004, 5, 9, 0.55, 907);

  const positions = new Float32Array(arrays.positions);
  const normals = new Float32Array(arrays.normals);
  const materials = new Float32Array(arrays.materials);
  const seeds = new Float32Array(arrays.seeds);
  const sways = new Float32Array(arrays.sways);
  const vertexCount = materials.length;

  const layer = {
    id: 'park-trees',
    type: 'custom',
    slot: 'middle',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      this.program = createProgram(gl, treeVertexSrc, treeFragmentSrc);
      this.aPosition = gl.getAttribLocation(this.program, 'a_position');
      this.aNormal = gl.getAttribLocation(this.program, 'a_normal');
      this.aMaterial = gl.getAttribLocation(this.program, 'a_material');
      this.aSeed = gl.getAttribLocation(this.program, 'a_seed');
      this.aSway = gl.getAttribLocation(this.program, 'a_sway');
      this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix');
      this.uTime = gl.getUniformLocation(this.program, 'u_time');
      this.uLightDir = gl.getUniformLocation(this.program, 'u_lightDir');

      this.posBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      this.normalBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

      this.materialBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.materialBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, materials, gl.STATIC_DRAW);

      this.seedBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);

      this.swayBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.swayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, sways, gl.STATIC_DRAW);
    },

    render(gl, matrix) {
      if (!vertexCount) return;
      const modelMatrix = translationMat4(origin.x, origin.y, 0);
      const finalMatrix = multiplyMat4(
        Array.from(matrix),
        multiplyMat4(modelMatrix, scaleMat4(meterScale, meterScale, meterScale))
      );

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uMatrix, false, new Float32Array(finalMatrix));
      gl.uniform1f(this.uTime, performance.now() / 1000);
      gl.uniform3f(this.uLightDir, 0.4, 0.35, 0.85);

      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.enableVertexAttribArray(this.aPosition);
      gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
      gl.enableVertexAttribArray(this.aNormal);
      gl.vertexAttribPointer(this.aNormal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.materialBuffer);
      gl.enableVertexAttribArray(this.aMaterial);
      gl.vertexAttribPointer(this.aMaterial, 1, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuffer);
      gl.enableVertexAttribArray(this.aSeed);
      gl.vertexAttribPointer(this.aSeed, 1, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.swayBuffer);
      gl.enableVertexAttribArray(this.aSway);
      gl.vertexAttribPointer(this.aSway, 1, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

      map.triggerRepaint();
    }
  };

  map.addLayer(layer);
}

// ---------------------------------------------------------------------------
// Fountain — a low stone rim around the reflecting-pool jet at the park's
// center, plus a looping particle spray that arcs up and falls back down.
// ---------------------------------------------------------------------------
const fountainBasinVertexSrc = `
  attribute vec3 a_position;
  attribute vec3 a_normal;
  uniform mat4 u_matrix;
  varying vec3 v_normal;
  void main() {
    v_normal = a_normal;
    gl_Position = u_matrix * vec4(a_position, 1.0);
  }
`;
const fountainBasinFragmentSrc = `
  precision mediump float;
  varying vec3 v_normal;
  uniform vec3 u_lightDir;
  void main() {
    float diffuse = max(dot(normalize(v_normal), u_lightDir), 0.0);
    float light = 0.5 + diffuse * 0.5;
    gl_FragColor = vec4(vec3(0.62, 0.60, 0.56) * light, 1.0);
  }
`;

const fountainSprayVertexSrc = `
  attribute float a_phase;
  attribute float a_angle;
  attribute float a_speedVar;
  uniform mat4 u_matrix;
  uniform float u_time;
  uniform vec3 u_origin;
  varying float v_alpha;
  void main() {
    float cycle = 1.7 + a_speedVar * 0.6;
    float t = fract((u_time + a_phase * cycle) / cycle);
    float height = 3.0 * (4.0 * t * (1.0 - t));
    float radius = 0.1 + t * 1.1;
    vec3 pos = u_origin + vec3(cos(a_angle) * radius, sin(a_angle) * radius, height + 0.15);
    v_alpha = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.72, 1.0, t));
    gl_Position = u_matrix * vec4(pos, 1.0);
    gl_PointSize = mix(7.0, 2.5, t);
  }
`;
const fountainSprayFragmentSrc = `
  precision mediump float;
  varying float v_alpha;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
    gl_FragColor = vec4(0.86, 0.95, 1.0, v_alpha * 0.9);
  }
`;

function addFountain() {
  const fountainLng = (CHANNEL_WEST_LNG + CHANNEL_EAST_LNG) / 2;
  const fountainLat = (PARK_SOUTH_LAT + PARK_NORTH_LAT) / 2;
  const [fx, fy] = toLocalMeters(fountainLng, fountainLat);
  const groundZ = (map.queryTerrainElevation([fountainLng, fountainLat], { exaggerated: true }) || 0);

  // Basin rim: a short hex ring standing just above the water surface.
  const basinArrays = { positions: [], normals: [], materials: [], seeds: [], sways: [] };
  const sides = 10;
  const outerR = 3.2, innerR = 2.75, rimH = 0.22;
  const outerBottom = ring(fx, fy, groundZ, outerR, sides);
  const outerTop = ring(fx, fy, groundZ + rimH, outerR, sides);
  const innerBottom = ring(fx, fy, groundZ, innerR, sides);
  const innerTop = ring(fx, fy, groundZ + rimH, innerR, sides);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // Outer wall
    pushTri(basinArrays, outerBottom[i], outerBottom[j], outerTop[i], 0, 0, 0, 0, 0);
    pushTri(basinArrays, outerTop[i], outerBottom[j], outerTop[j], 0, 0, 0, 0, 0);
    // Top cap (flat ring surface visitors would see from above)
    pushTri(basinArrays, outerTop[i], outerTop[j], innerTop[i], 0, 0, 0, 0, 0);
    pushTri(basinArrays, innerTop[i], outerTop[j], innerTop[j], 0, 0, 0, 0, 0);
  }
  const basinPositions = new Float32Array(basinArrays.positions);
  const basinNormals = new Float32Array(basinArrays.normals);
  const basinCount = basinPositions.length / 3;

  // Spray particles: a ring of independently-phased points arcing up/out/down.
  const sprayCount = 260;
  const phases = new Float32Array(sprayCount);
  const angles = new Float32Array(sprayCount);
  const speedVars = new Float32Array(sprayCount);
  for (let i = 0; i < sprayCount; i++) {
    phases[i] = seededRandom(i * 3.7 + 12.0);
    angles[i] = seededRandom(i * 5.1 + 44.0) * Math.PI * 2;
    speedVars[i] = seededRandom(i * 9.3 + 77.0);
  }

  const layer = {
    id: 'park-fountain',
    type: 'custom',
    slot: 'top',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      this.basinProgram = createProgram(gl, fountainBasinVertexSrc, fountainBasinFragmentSrc);
      this.bPosition = gl.getAttribLocation(this.basinProgram, 'a_position');
      this.bNormal = gl.getAttribLocation(this.basinProgram, 'a_normal');
      this.bMatrix = gl.getUniformLocation(this.basinProgram, 'u_matrix');
      this.bLightDir = gl.getUniformLocation(this.basinProgram, 'u_lightDir');

      this.basinPosBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.basinPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, basinPositions, gl.STATIC_DRAW);

      this.basinNormalBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.basinNormalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, basinNormals, gl.STATIC_DRAW);

      this.sprayProgram = createProgram(gl, fountainSprayVertexSrc, fountainSprayFragmentSrc);
      this.sPhase = gl.getAttribLocation(this.sprayProgram, 'a_phase');
      this.sAngle = gl.getAttribLocation(this.sprayProgram, 'a_angle');
      this.sSpeedVar = gl.getAttribLocation(this.sprayProgram, 'a_speedVar');
      this.sMatrix = gl.getUniformLocation(this.sprayProgram, 'u_matrix');
      this.sTime = gl.getUniformLocation(this.sprayProgram, 'u_time');
      this.sOrigin = gl.getUniformLocation(this.sprayProgram, 'u_origin');

      this.phaseBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.phaseBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, phases, gl.STATIC_DRAW);

      this.angleBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.angleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, angles, gl.STATIC_DRAW);

      this.speedVarBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.speedVarBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, speedVars, gl.STATIC_DRAW);
    },

    render(gl, matrix) {
      const modelMatrix = translationMat4(origin.x, origin.y, 0);
      const finalMatrix = multiplyMat4(
        Array.from(matrix),
        multiplyMat4(modelMatrix, scaleMat4(meterScale, meterScale, meterScale))
      );
      const finalMatrixF32 = new Float32Array(finalMatrix);

      gl.enable(gl.DEPTH_TEST);

      // Basin
      gl.useProgram(this.basinProgram);
      gl.uniformMatrix4fv(this.bMatrix, false, finalMatrixF32);
      gl.uniform3f(this.bLightDir, 0.4, 0.35, 0.85);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.basinPosBuffer);
      gl.enableVertexAttribArray(this.bPosition);
      gl.vertexAttribPointer(this.bPosition, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.basinNormalBuffer);
      gl.enableVertexAttribArray(this.bNormal);
      gl.vertexAttribPointer(this.bNormal, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, basinCount);

      // Spray particles
      gl.useProgram(this.sprayProgram);
      gl.uniformMatrix4fv(this.sMatrix, false, finalMatrixF32);
      gl.uniform1f(this.sTime, performance.now() / 1000);
      gl.uniform3f(this.sOrigin, fx, fy, groundZ);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.phaseBuffer);
      gl.enableVertexAttribArray(this.sPhase);
      gl.vertexAttribPointer(this.sPhase, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.angleBuffer);
      gl.enableVertexAttribArray(this.sAngle);
      gl.vertexAttribPointer(this.sAngle, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.speedVarBuffer);
      gl.enableVertexAttribArray(this.sSpeedVar);
      gl.vertexAttribPointer(this.sSpeedVar, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, sprayCount);

      gl.depthMask(true);
      gl.disable(gl.BLEND);

      map.triggerRepaint();
    }
  };

  map.addLayer(layer);
}

// ---------------------------------------------------------------------------
// Life layer — a handful of low-poly people walking short park paths and
// cars driving 16th St NW, all animated purely in the vertex shader (each
// object's rigid local geometry is rotated/translated per-frame from a
// base point + direction vector + time-based phase, so nothing needs to be
// rebuilt on the CPU per frame).
// ---------------------------------------------------------------------------
function pushLifeTri(arrays, p0, p1, p2, material, seed, base, dir, phase, speed, kind, side) {
  const n = normalizeVec3(crossVec3(subVec3(p1, p0), subVec3(p2, p0)));
  const pts = [p0, p1, p2];
  for (let k = 0; k < 3; k++) {
    arrays.locals.push(pts[k][0], pts[k][1], pts[k][2]);
    arrays.normals.push(n[0], n[1], n[2]);
    arrays.materials.push(material);
    arrays.seeds.push(seed);
    arrays.bases.push(base[0], base[1]);
    arrays.dirs.push(dir[0], dir[1]);
    arrays.phases.push(phase);
    arrays.speeds.push(speed);
    arrays.kinds.push(kind);
    arrays.sides.push(side);
  }
}

function pushLifeBox(arrays, cx, cy, czBase, sx, sy, sz, material, seed, base, dir, phase, speed, kind, side) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = czBase, z1 = czBase + sz;
  const a = [x0, y0, z0], b = [x1, y0, z0], c = [x1, y1, z0], d = [x0, y1, z0];
  const e = [x0, y0, z1], f = [x1, y0, z1], g = [x1, y1, z1], h = [x0, y1, z1];
  const faces = [[e, f, g, h], [a, d, c, b], [a, b, f, e], [c, d, h, g], [b, c, g, f], [d, a, e, h]];
  faces.forEach(([p0, p1, p2, p3]) => {
    pushLifeTri(arrays, p0, p1, p2, material, seed, base, dir, phase, speed, kind, side || 0);
    pushLifeTri(arrays, p0, p2, p3, material, seed, base, dir, phase, speed, kind, side || 0);
  });
}

// A person is built at object-local origin (0,0), feet at groundZ, with the
// whole rigid body rotated/translated per-frame by the shader. Legs and arms
// carry a nonzero a_side so the shader can swing them fore/aft for a walk
// cycle (opposite-side limbs get opposite sign, like a natural gait).
function buildPerson(arrays, startLngLat, endLngLat, phase, speed, seed) {
  const [sx, sy] = toLocalMeters(startLngLat[0], startLngLat[1]);
  const [ex, ey] = toLocalMeters(endLngLat[0], endLngLat[1]);
  const midLng = (startLngLat[0] + endLngLat[0]) / 2;
  const midLat = (startLngLat[1] + endLngLat[1]) / 2;
  const groundZ = (map.queryTerrainElevation([midLng, midLat], { exaggerated: true }) || 0);
  const base = [sx, sy];
  const dir = [ex - sx, ey - sy];

  const legLen = 0.85, torsoLen = 0.55, armLen = 0.62, headSize = 0.24;
  const hipZ = groundZ, shoulderZ = groundZ + legLen + torsoLen;

  // Legs (pants) — swing fore/aft, opposite phase for a walking gait.
  pushLifeBox(arrays, 0, -0.11, hipZ, 0.15, 0.15, legLen, 2, seed, base, dir, phase, speed, 0, 0.12);
  pushLifeBox(arrays, 0, 0.11, hipZ, 0.15, 0.15, legLen, 2, seed, base, dir, phase, speed, 0, -0.12);
  // Torso (shirt)
  pushLifeBox(arrays, 0, 0, hipZ + legLen, 0.22, 0.40, torsoLen, 0, seed, base, dir, phase, speed, 0, 0);
  // Arms (skin) — swing opposite the same-side leg.
  pushLifeBox(arrays, 0, -0.26, shoulderZ - armLen, 0.12, 0.12, armLen, 1, seed, base, dir, phase, speed, 0, -0.15);
  pushLifeBox(arrays, 0, 0.26, shoulderZ - armLen, 0.12, 0.12, armLen, 1, seed, base, dir, phase, speed, 0, 0.15);
  // Head (skin)
  pushLifeBox(arrays, 0, 0, shoulderZ, 0.24, 0.24, headSize, 1, seed, base, dir, phase, speed, 0, 0);
}

function buildCar(arrays, startLngLat, endLngLat, phase, speed, seed) {
  const [sx, sy] = toLocalMeters(startLngLat[0], startLngLat[1]);
  const [ex, ey] = toLocalMeters(endLngLat[0], endLngLat[1]);
  const midLng = (startLngLat[0] + endLngLat[0]) / 2;
  const midLat = (startLngLat[1] + endLngLat[1]) / 2;
  const groundZ = (map.queryTerrainElevation([midLng, midLat], { exaggerated: true }) || 0);
  const base = [sx, sy];
  const dir = [ex - sx, ey - sy];

  const bodyLen = 2.0, bodyWidth = 0.95, bodyHeight = 0.5, bodyBaseZ = groundZ + 0.14;
  pushLifeBox(arrays, 0, 0, bodyBaseZ, bodyLen, bodyWidth, bodyHeight, 3, seed, base, dir, phase, speed, 1, 0);
  // Cabin/windows, set back slightly like a hood-and-cabin silhouette.
  pushLifeBox(arrays, -0.15, 0, bodyBaseZ + bodyHeight, 1.0, 0.82, 0.36, 4, seed, base, dir, phase, speed, 1, 0);
  // Wheels at the four corners, poking out slightly past the body sides.
  const wheelX = bodyLen / 2 - 0.35;
  const wheelY = bodyWidth / 2 + 0.06;
  [-wheelX, wheelX].forEach((wx) => {
    [-wheelY, wheelY].forEach((wy) => {
      pushLifeBox(arrays, wx, wy, groundZ, 0.34, 0.22, 0.32, 5, seed, base, dir, phase, speed, 1, 0);
    });
  });
}

const lifeVertexSrc = `
  attribute vec3 a_local;
  attribute vec3 a_normalLocal;
  attribute float a_material;
  attribute float a_seed;
  attribute vec2 a_base;
  attribute vec2 a_dir;
  attribute float a_phase;
  attribute float a_speed;
  attribute float a_kind;
  attribute float a_side;
  uniform mat4 u_matrix;
  uniform float u_time;
  varying vec3 v_normal;
  varying float v_material;
  varying float v_seed;
  void main() {
    float raw = fract(u_time * a_speed + a_phase);
    float t = raw < 0.5 ? raw * 2.0 : (1.0 - raw) * 2.0;
    float dirSign = raw < 0.5 ? 1.0 : -1.0;
    vec2 pos2 = a_base + a_dir * t;
    float yaw = atan(a_dir.y * dirSign, a_dir.x * dirSign);
    float c = cos(yaw), s = sin(yaw);

    float stepPhase = u_time * a_speed * 340.0 + a_phase * 10.0;
    float bob = a_kind < 0.5 ? abs(sin(stepPhase)) * 0.06 : 0.0;
    float swing = a_side * sin(stepPhase);

    vec3 localAdj = a_local;
    localAdj.x += swing;

    vec2 rotated = vec2(localAdj.x * c - localAdj.y * s, localAdj.x * s + localAdj.y * c);
    vec3 worldLocal = vec3(pos2 + rotated, localAdj.z + bob);
    vec3 normal = vec3(a_normalLocal.x * c - a_normalLocal.y * s, a_normalLocal.x * s + a_normalLocal.y * c, a_normalLocal.z);
    v_normal = normal;
    v_material = a_material;
    v_seed = a_seed;
    gl_Position = u_matrix * vec4(worldLocal, 1.0);
  }
`;

const lifeFragmentSrc = `
  precision mediump float;
  varying vec3 v_normal;
  varying float v_material;
  varying float v_seed;
  uniform vec3 u_lightDir;
  float hash(float x) { return fract(sin(x) * 43758.5453123); }
  void main() {
    float diffuse = max(dot(normalize(v_normal), u_lightDir), 0.0);
    float light = 0.45 + diffuse * 0.55;
    vec3 skin = vec3(0.76, 0.60, 0.48);
    vec3 shirt = mix(vec3(0.75, 0.15, 0.15), vec3(0.15, 0.35, 0.65), step(0.5, hash(v_seed)));
    vec3 pants = mix(vec3(0.10, 0.14, 0.28), vec3(0.22, 0.21, 0.20), step(0.5, hash(v_seed * 1.7)));
    vec3 carMix1 = mix(vec3(0.85, 0.85, 0.88), vec3(0.10, 0.10, 0.12), step(0.66, hash(v_seed * 2.0)));
    vec3 carColor = mix(vec3(0.78, 0.08, 0.08), carMix1, step(0.33, hash(v_seed * 2.0)));
    vec3 glass = vec3(0.05, 0.08, 0.11);
    vec3 wheel = vec3(0.04, 0.04, 0.04);

    vec3 base = shirt;
    if (v_material > 0.5 && v_material < 1.5) base = skin;
    else if (v_material > 1.5 && v_material < 2.5) base = pants;
    else if (v_material > 2.5 && v_material < 3.5) base = carColor;
    else if (v_material > 3.5 && v_material < 4.5) base = glass;
    else if (v_material > 4.5) base = wheel;
    gl_FragColor = vec4(base * light, 1.0);
  }
`;

function addLifeLayer() {
  const arrays = { locals: [], normals: [], materials: [], seeds: [], bases: [], dirs: [], phases: [], speeds: [], kinds: [], sides: [] };

  const peoplePaths = [
    [[PARK_WEST_LNG + 0.00028, PARK_SOUTH_LAT + 0.0006], [PARK_WEST_LNG + 0.00028, PARK_NORTH_LAT - 0.0006]],
    [[PARK_WEST_LNG + 0.00015, PARK_SOUTH_LAT + 0.0015], [CHANNEL_WEST_LNG - 0.00015, PARK_SOUTH_LAT + 0.0028]],
    [[PARK_EAST_LNG - 0.00028, PARK_SOUTH_LAT + 0.0006], [PARK_EAST_LNG - 0.00028, PARK_NORTH_LAT - 0.0006]],
    [[PARK_EAST_LNG - 0.00015, PARK_NORTH_LAT - 0.0015], [CHANNEL_EAST_LNG + 0.00015, PARK_NORTH_LAT - 0.0028]],
    [[CHANNEL_WEST_LNG - 0.00006, PARK_SOUTH_LAT + 0.0008], [CHANNEL_WEST_LNG - 0.00006, PARK_NORTH_LAT - 0.0008]]
  ];
  let seed = 3001;
  peoplePaths.forEach(([start, end]) => {
    [0.0, 0.5].forEach((phaseOffset) => {
      seed += 11.3;
      const speed = 0.028 + seededRandom(seed) * 0.01;
      buildPerson(arrays, start, end, phaseOffset + seededRandom(seed + 1) * 0.2, speed, seed);
    });
  });

  const roadLng = PARK_EAST_LNG + 0.00045;
  const lanes = [roadLng - 0.00004, roadLng + 0.00004];
  lanes.forEach((lng) => {
    [0.0, 0.33, 0.66].forEach((phaseOffset) => {
      seed += 17.7;
      const speed = 0.05 + seededRandom(seed) * 0.015;
      buildCar(
        arrays,
        [lng, PARK_SOUTH_LAT - 0.0015],
        [lng, PARK_NORTH_LAT + 0.0015],
        phaseOffset,
        speed,
        seed
      );
    });
  });

  const locals = new Float32Array(arrays.locals);
  const normals = new Float32Array(arrays.normals);
  const materials = new Float32Array(arrays.materials);
  const seeds = new Float32Array(arrays.seeds);
  const bases = new Float32Array(arrays.bases);
  const dirs = new Float32Array(arrays.dirs);
  const phases = new Float32Array(arrays.phases);
  const speeds = new Float32Array(arrays.speeds);
  const kinds = new Float32Array(arrays.kinds);
  const sides = new Float32Array(arrays.sides);
  const vertexCount = materials.length;

  const layer = {
    id: 'park-life',
    type: 'custom',
    slot: 'middle',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      this.program = createProgram(gl, lifeVertexSrc, lifeFragmentSrc);
      this.aLocal = gl.getAttribLocation(this.program, 'a_local');
      this.aNormalLocal = gl.getAttribLocation(this.program, 'a_normalLocal');
      this.aMaterial = gl.getAttribLocation(this.program, 'a_material');
      this.aSeed = gl.getAttribLocation(this.program, 'a_seed');
      this.aBase = gl.getAttribLocation(this.program, 'a_base');
      this.aDir = gl.getAttribLocation(this.program, 'a_dir');
      this.aPhase = gl.getAttribLocation(this.program, 'a_phase');
      this.aSpeed = gl.getAttribLocation(this.program, 'a_speed');
      this.aKind = gl.getAttribLocation(this.program, 'a_kind');
      this.aSide = gl.getAttribLocation(this.program, 'a_side');
      this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix');
      this.uTime = gl.getUniformLocation(this.program, 'u_time');
      this.uLightDir = gl.getUniformLocation(this.program, 'u_lightDir');

      const makeBuffer = (data) => {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return buf;
      };
      this.localBuffer = makeBuffer(locals);
      this.normalBuffer = makeBuffer(normals);
      this.materialBuffer = makeBuffer(materials);
      this.seedBuffer = makeBuffer(seeds);
      this.baseBuffer = makeBuffer(bases);
      this.dirBuffer = makeBuffer(dirs);
      this.phaseBuffer = makeBuffer(phases);
      this.speedBuffer = makeBuffer(speeds);
      this.kindBuffer = makeBuffer(kinds);
      this.sideBuffer = makeBuffer(sides);
    },

    render(gl, matrix) {
      if (!vertexCount) return;
      const modelMatrix = translationMat4(origin.x, origin.y, 0);
      const finalMatrix = multiplyMat4(
        Array.from(matrix),
        multiplyMat4(modelMatrix, scaleMat4(meterScale, meterScale, meterScale))
      );

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uMatrix, false, new Float32Array(finalMatrix));
      gl.uniform1f(this.uTime, performance.now() / 1000);
      gl.uniform3f(this.uLightDir, 0.4, 0.35, 0.85);

      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      const bind = (buffer, attr, size) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(attr);
        gl.vertexAttribPointer(attr, size, gl.FLOAT, false, 0, 0);
      };
      bind(this.localBuffer, this.aLocal, 3);
      bind(this.normalBuffer, this.aNormalLocal, 3);
      bind(this.materialBuffer, this.aMaterial, 1);
      bind(this.seedBuffer, this.aSeed, 1);
      bind(this.baseBuffer, this.aBase, 2);
      bind(this.dirBuffer, this.aDir, 2);
      bind(this.phaseBuffer, this.aPhase, 1);
      bind(this.speedBuffer, this.aSpeed, 1);
      bind(this.kindBuffer, this.aKind, 1);
      bind(this.sideBuffer, this.aSide, 1);

      gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

      map.triggerRepaint();
    }
  };

  map.addLayer(layer);
}
