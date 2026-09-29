// ---------------------------------------------------------------------------
// Shared three.js scene for every 3D character on the map (the rat, the
// NPCs), drawn as ONE Mapbox custom layer with one renderer on Mapbox's GL
// context. Objects live in a local frame anchored at map.js's `origin`:
//   x = meters east, y = meters up, z = meters south
// so modules just set obj.position / obj.rotation.y in plain meters instead
// of each building its own Mercator matrix.
//
// Objects with layer 1 enabled (see markXray) also get an "x-ray" pass: the
// parts of them hidden behind buildings/terrain are drawn as a flat
// see-through silhouette, so they never fully vanish behind geometry.
//
// Requires map.js (map, origin, meterScale, toLocalMeters, whenTerrainReady)
// and three.js + GLTFLoader to be loaded first.
// ---------------------------------------------------------------------------
const actors = {
  scene: new THREE.Scene(),
  frameCallbacks: [],
  onFrame(fn) { this.frameCallbacks.push(fn); },

  // lng/lat -> local { x (east m), z (south m) }
  toLocal(lng, lat) {
    const [x, z] = toLocalMeters(lng, lat);
    return { x, z };
  },

  // three.js yaw for an object whose model faces `forward` ('+x' or '+z'),
  // so it points along compass bearing `bearingDeg` (0 = north, 90 = east).
  yawForBearing(bearingDeg, forward) {
    const b = (bearingDeg * Math.PI) / 180;
    return forward === '+x' ? Math.PI / 2 - b : Math.PI - b;
  },

  markXray(obj) {
    obj.traverse((o) => { if (o.isMesh) o.layers.enable(1); });
  },

  // Local point -> CSS pixel position on the map canvas, using this frame's
  // projection. null if it's behind the camera.
  projection: null,
  toScreen(x, y, z) {
    if (!this.projection) return null;
    const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(this.projection);
    if (v.w <= 0) return null;
    const canvas = map.getCanvas();
    return {
      x: ((v.x / v.w) * 0.5 + 0.5) * canvas.clientWidth,
      y: (0.5 - (v.y / v.w) * 0.5) * canvas.clientHeight,
    };
  },
};

const actorsSky = new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 0.95);
actors.scene.add(actorsSky);
const actorsSun = new THREE.DirectionalLight(0xffffff, 0.85);
actorsSun.position.set(0.4, 1, -0.3);
actors.scene.add(actorsSun);

// Match the characters' lighting to the real sun (skyState, from sky.js):
// dim at night, warm near sunrise/sunset, lit from where the sun actually is.
function syncActorLightsToSun() {
  const alt = skyState.altitude;
  const daylight = Math.min(1, Math.max(0, (alt + 6) / 20)); // 0 at -6°, 1 at 14°
  const warmth = alt > -6 && alt < 12 ? 1 - Math.abs(alt - 3) / 9 : 0; // strongest just above the horizon
  actorsSky.intensity = 0.3 + 0.65 * daylight;
  actorsSun.intensity = 0.12 + 0.75 * daylight;
  actorsSun.color.setRGB(1, 1 - 0.3 * warmth, 1 - 0.55 * warmth);
  if (alt > 0) {
    const az = (skyState.compassAzimuth * Math.PI) / 180, h = (alt * Math.PI) / 180;
    actorsSun.position.set(Math.sin(az) * Math.cos(h), Math.sin(h), -Math.cos(az) * Math.cos(h)); // x east, y up, z south
  } else {
    actorsSun.position.set(0.3, 1, 0.2); // soft overhead light (moon / street lamps)
  }
}

// Mapbox Terrain elevation (exaggerated, to match what's rendered) with a
// last-known-good fallback: queryTerrainElevation intermittently returns
// null/garbage for single points even after the DEM has loaded.
function actorGroundHeight(lng, lat, fallback) {
  const e = map.queryTerrainElevation([lng, lat], { exaggerated: true });
  return Number.isFinite(e) && e > -50 && e < 300 ? e : fallback;
}

const actorsXrayMaterial = new THREE.MeshBasicMaterial({
  color: 0xffd27a,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
  depthFunc: THREE.GreaterDepth,
  skinning: true,
});

function addActorsLayer() {
  map.addLayer({
    id: 'actors-3d',
    type: 'custom',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      this.camera = new THREE.Camera();
      this.renderer = new THREE.WebGLRenderer({ canvas: mapInstance.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
      this.lastTime = null;
    },

    render(gl, matrix) {
      const now = performance.now();
      const dt = this.lastTime === null ? 0 : Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;

      // Local meters -> Mercator: translate to origin, scale meters to
      // Mercator units (y flipped — Mercator y grows southward), rotate
      // three.js's Y-up into Mapbox's Z-up. Set before the frame callbacks so
      // anything they place on screen (NPC talk bubbles) uses this frame's view.
      this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix)
        .multiply(new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z))
        .multiply(new THREE.Matrix4().makeScale(meterScale, -meterScale, meterScale))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      actors.projection = this.camera.projectionMatrix;

      syncActorLightsToSun();
      actors.frameCallbacks.forEach((fn) => fn(dt, now));

      this.renderer.resetState();

      // X-ray pass first, while the depth buffer only holds Mapbox's own
      // geometry: GreaterDepth draws exactly the parts that are behind it.
      actors.scene.overrideMaterial = actorsXrayMaterial;
      this.camera.layers.set(1);
      this.renderer.render(actors.scene, this.camera);
      actors.scene.overrideMaterial = null;
      this.camera.layers.set(0);

      this.renderer.render(actors.scene, this.camera);
      map.triggerRepaint();
    },
  });
}

whenTerrainReady(addActorsLayer);
