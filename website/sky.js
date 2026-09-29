// ---------------------------------------------------------------------------
// Real-time sky. Works out where the sun actually is over the park at the
// visitor's own clock time (i.e. DC's sky at the time it is for them), and
// re-checks every minute to drive:
//  - Mapbox Standard's lighting preset (day / dawn / dusk / night), switched
//    at the sun's real altitude instead of fixed hours, so sunrise and sunset
//    land at the right time in every season;
//  - the sky's colors, blended smoothly through twilight. In Mapbox the sky
//    is painted by fog: `color` is the glow at the horizon, `high-color` the
//    lower sky, `space-color` the sky overhead;
//  - skyState, which actors.js uses to light the rat and NPCs to match.
// Fog range stays far out, so there's still no haze over the park itself.
//
// Requires map.js to have run first.
// ---------------------------------------------------------------------------
const SKY_LOCATION = { lat: 38.9214, lng: -77.0357 }; // Meridian Hill Park

const skyState = { altitude: 30, compassAzimuth: 180, morning: false }; // degrees

// ---- Sun position — formulas from SunCalc (Vladimir Agafonkin, BSD-2-Clause)
const SKY_RAD = Math.PI / 180;
const SKY_OBLIQUITY = SKY_RAD * 23.4397;

function sunPosition(date, lat, lng) {
  const d = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545; // days since J2000
  const M = SKY_RAD * (357.5291 + 0.98560028 * d); // solar mean anomaly
  const C = SKY_RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + SKY_RAD * 102.9372 + Math.PI; // ecliptic longitude
  const dec = Math.asin(Math.sin(SKY_OBLIQUITY) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(SKY_OBLIQUITY), Math.cos(L));
  const H = SKY_RAD * (280.16 + 360.9856235 * d) + SKY_RAD * lng - ra; // hour angle
  const phi = SKY_RAD * lat;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azimuthFromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return {
    altitude: altitude / SKY_RAD,
    compassAzimuth: (azimuthFromSouth / SKY_RAD + 180 + 360) % 360, // 0 = north, 90 = east
  };
}

// The instant when DC's wall clock reads what the visitor's clock reads now.
// For someone in DC this is just "now"; for anyone else it shows DC's sky at
// their own time of day.
function userClockAtPark(now) {
  const wall = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(wall)).forEach(({ type, value }) => { p[type] = +value; });
  const dcOffset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wall;
  return new Date(wall - dcOffset);
}

// ---- Sky colors by sun altitude, interpolated between these keyframes.
// [altitude°, horizon glow, lower sky, sky overhead, stars, horizon blend]
const SKY_KEYFRAMES = [
  [-18, '#1b1c2a', '#0d1430', '#03060f', 0.35, 0.10], // night: faint city glow at the horizon
  [-10, '#2f2c47', '#18244f', '#08112d', 0.20, 0.14], // nautical twilight
  [-4,  '#b3625a', '#4a497c', '#18234f', 0.05, 0.22], // civil twilight: red-orange band
  [0,   '#f0a067', '#8a7eb2', '#3a5898', 0.00, 0.24], // sunrise / sunset
  [6,   '#f4cfa0', '#93b5dd', '#4979c2', 0.00, 0.18], // golden hour
  [20,  '#dbe9f5', '#9cc2ea', '#4a86d4', 0.00, 0.13], // day
  [50,  '#e3eef8', '#a3c7ec', '#3f7fd0', 0.00, 0.12], // high sun
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  return `rgb(${ca.map((v, i) => Math.round(v + (cb[i] - v) * t)).join(', ')})`;
}

function skyFogFor(altitude) {
  const keys = SKY_KEYFRAMES;
  const alt = Math.min(keys[keys.length - 1][0], Math.max(keys[0][0], altitude));
  let i = 1;
  while (i < keys.length - 1 && keys[i][0] < alt) i++;
  const a = keys[i - 1], b = keys[i];
  const t = (alt - a[0]) / (b[0] - a[0]);
  return {
    range: [10, 20], // keep haze far beyond the park
    color: mixHex(a[1], b[1], t),
    'high-color': mixHex(a[2], b[2], t),
    'space-color': mixHex(a[3], b[3], t),
    'star-intensity': a[4] + (b[4] - a[4]) * t,
    'horizon-blend': a[5] + (b[5] - a[5]) * t,
  };
}

// ---- Apply
let skyReady = false;
let skyPreset = null;

function updateSky() {
  if (!skyReady) return;
  const sun = sunPosition(userClockAtPark(new Date()), SKY_LOCATION.lat, SKY_LOCATION.lng);
  skyState.altitude = sun.altitude;
  skyState.compassAzimuth = sun.compassAzimuth;
  skyState.morning = sun.compassAzimuth < 180;

  // Standard's "dawn" preset lights the city like the sun is already up, and
  // "dusk" is dim like evening twilight, so they're switched at different
  // points: dawn from just before sunrise until the sun is 10° up, dusk from
  // 5° up until it's 6° below the horizon.
  const alt = sun.altitude;
  const preset = skyState.morning
    ? (alt > 10 ? 'day' : alt > -2 ? 'dawn' : 'night')
    : (alt > 5 ? 'day' : alt > -6 ? 'dusk' : 'night');
  if (preset !== skyPreset) {
    map.setConfigProperty('basemap', 'lightPreset', preset);
    skyPreset = preset;
  }
  map.setFog(skyFogFor(alt));
}

map.on('style.load', () => {
  skyReady = true;
  skyPreset = null;
  updateSky();
});
setInterval(updateSky, 60 * 1000);
