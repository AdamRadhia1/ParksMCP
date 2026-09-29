// ---------------------------------------------------------------------------
// "How do I get here?" — geocoding + Mapbox Directions to the park. Every
// search draws the route on the map as a bold red path (with a dot where it
// starts and a red pin at the park), alongside the turn-by-turn text.
// Transit: Mapbox can't plan Metro/bus trips, so the full trip opens in
// Google Maps, and the map shows the walk from the best nearby Metro station.
// ---------------------------------------------------------------------------
// Park entrances; each route ends at whichever is closer to where you start.
const PARK_ENTRANCES = [
  [-77.0366, 38.9198], // south: 16th & W St NW
  [-77.0362, 38.9231], // north: 16th & Euclid St NW
];
// Metro stations within walking distance of the park, at the entrance
// nearest it (positions from Mapbox Streets' transit data): the Green Line
// east of the park, the Red Line west of it.
const PARK_METRO = [
  { name: 'Columbia Heights', line: 'Green', coords: [-77.03313, 38.92859] }, // west entrance, 14th & Irving
  { name: 'U Street', line: 'Green', coords: [-77.0292, 38.91683] },         // 13th St entrance
  { name: 'Dupont Circle', line: 'Red', coords: [-77.04474, 38.91101] },     // north entrance, Q St
  { name: 'Woodley Park', line: 'Red', coords: [-77.05235, 38.92447] },      // Connecticut & 24th St
];
const WALKABLE_M = 1609; // within a mile, transit directions are just the walk
const ROUTE_SOURCE = 'route';
const ROUTE_LAYERS = ['route-glow', 'route-casing', 'route-line'];
const ROUTE_COLOR = '#e3242b';
// Address suggestions come from the DC area only (DC, Northern Virginia,
// suburban Maryland, Baltimore) — otherwise "Union Station Washington" can
// turn up a street in Ohio first.
const DIR_SEARCH_BBOX = [-77.9, 38.5, -76.4, 39.45];

const dirInput = document.getElementById('dir-input');
const dirSuggestions = document.getElementById('dir-suggestions');
const dirResult = document.getElementById('dir-result');
const modeButtons = document.querySelectorAll('#dir-modes button');

let dirMode = 'walking';
let dirOrigin = null; // { coords: [lng, lat], label }
let dirRequest = 0;   // so a slow, older search can't overwrite a newer one
let routeMarkers = [];
let suggestTimer = null;

function formatDuration(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} hr ${min % 60} min`;
}

function formatDistance(m) {
  const mi = m / 1609.34;
  return mi < 0.1 ? `${Math.round(m * 3.281)} ft` : `${mi.toFixed(1)} mi`;
}

function nearestEntrance(from) {
  return PARK_ENTRANCES.reduce((best, e) => (cityMeters(from, e) < cityMeters(from, best) ? e : best));
}

function clearRoute() {
  ROUTE_LAYERS.forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
  if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);
  routeMarkers.forEach((m) => m.remove());
  routeMarkers = [];
}

// Screen space the route can be framed in: clear of the directions panel on
// the left and the events panel on the right (unless the screen's too small
// to leave room, as on phones).
function routePadding() {
  const canvas = map.getCanvas().getBoundingClientRect();
  const left = document.getElementById('directions').getBoundingClientRect();
  const right = document.getElementById('events-panel').getBoundingClientRect();
  const pad = { top: 90, bottom: 50, left: left.right - canvas.left + 30, right: canvas.right - right.left + 30 };
  if (canvas.width - pad.left - pad.right < 240) pad.left = pad.right = 40;
  return pad;
}

// The route as a bold red line — a soft red glow, a white edge and the red
// line on top, so it stands out anywhere on the map — plus a dot where it
// starts and a red pin at the park, framed between the panels.
function drawRoute(geometry, start, end) {
  clearRoute();
  if (ratModeActive) exitRatMode(); // otherwise the camera would snap straight back to the rat
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'Feature', geometry } });
  const width = (z12, z16, z19) => ['interpolate', ['exponential', 1.5], ['zoom'], 12, z12, 16, z16, 19, z19];
  const addLine = (id, paint) => map.addLayer({
    id, type: 'line', source: ROUTE_SOURCE, slot: 'middle',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-emissive-strength': 1, ...paint },
  });
  addLine('route-glow', { 'line-color': ROUTE_COLOR, 'line-width': width(14, 24, 40), 'line-opacity': 0.3, 'line-blur': 6 });
  addLine('route-casing', { 'line-color': '#ffffff', 'line-width': width(8, 12, 20) });
  addLine('route-line', { 'line-color': ROUTE_COLOR, 'line-width': width(4.5, 7, 12) });

  const dot = document.createElement('div');
  dot.className = 'route-start';
  routeMarkers.push(new mapboxgl.Marker({ element: dot }).setLngLat(start).addTo(map));
  routeMarkers.push(new mapboxgl.Marker({ color: ROUTE_COLOR }).setLngLat(end).addTo(map));

  const bounds = geometry.coordinates.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(start, start));
  map.fitBounds(bounds, { padding: routePadding(), pitch: 0, bearing: 0, maxZoom: 17.5, duration: 1400 });
}

async function fetchRoute(profile, from, to) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${from.join(',')};${to.join(',')}` +
    `?geometries=geojson&steps=true&overview=full&access_token=${mapboxgl.accessToken}`;
  const data = await (await fetch(url)).json();
  return data.routes && data.routes[0];
}

function googleTransitLink(to) {
  const [lng, lat] = dirOrigin.coords;
  const a = document.createElement('a');
  a.href = 'https://www.google.com/maps/dir/?api=1&travelmode=transit' + `&origin=${lat},${lng}&destination=${to[1]},${to[0]}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Full trip by Metro/bus in Google Maps';
  return a;
}

// Summary + clear button, a note tying the text to the red line on the map,
// then the turn-by-turn steps.
function showRoute(route, summaryText, noteText, extra) {
  dirResult.textContent = '';
  const head = document.createElement('div');
  head.className = 'dir-head';
  const summary = document.createElement('div');
  summary.className = 'summary';
  summary.textContent = summaryText;
  const clear = document.createElement('button');
  clear.id = 'dir-clear';
  clear.textContent = 'Clear route';
  clear.addEventListener('click', resetDirections);
  head.append(summary, clear);
  const note = document.createElement('p');
  note.className = 'dir-note';
  note.textContent = noteText;
  const steps = document.createElement('ol');
  route.legs[0].steps.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.maneuver.instruction;
    steps.appendChild(li);
  });
  dirResult.append(head, note);
  if (extra) dirResult.append(extra);
  dirResult.append(steps);
}

async function getDirections() {
  if (!dirOrigin) return;
  const request = ++dirRequest;
  dirResult.textContent = 'Finding route…';
  try {
    if (dirMode === 'transit') {
      await getTransitDirections(request);
      return;
    }
    const entrance = nearestEntrance(dirOrigin.coords);
    const route = await fetchRoute(dirMode, dirOrigin.coords, entrance);
    if (request !== dirRequest) return;
    if (!route) {
      clearRoute();
      dirResult.textContent = 'No route found from that location.';
      return;
    }
    drawRoute(route.geometry, dirOrigin.coords, entrance);
    showRoute(route, `${formatDuration(route.duration)} · ${formatDistance(route.distance)}`, 'Your route is highlighted in red on the map.');
  } catch (e) {
    if (request === dirRequest) dirResult.textContent = 'Could not load directions. Please try again.';
  }
}

// Transit: the full Metro/bus trip opens in Google Maps, and the map shows
// the last part in red — the walk from the station that suits where you're
// coming from (Red Line from the west, Green Line from the east; of those,
// the quickest ride plus walk) — or just the walk, within a mile of the park.
async function getTransitDirections(request) {
  const from = dirOrigin.coords;
  const walkFromHere = cityMeters(from, PARK_CENTER) < WALKABLE_M;
  const line = from[0] < PARK_CENTER[0] ? 'Red' : 'Green';
  const minutes = (s) => cityMeters(from, s.coords) / 500 + cityMeters(s.coords, PARK_CENTER) / 80; // Metro ~30 km/h, walking ~4.8 km/h
  const station = PARK_METRO.filter((s) => s.line === line).reduce((best, s) => (minutes(s) < minutes(best) ? s : best));
  const start = walkFromHere ? from : station.coords;
  const entrance = nearestEntrance(start);
  const route = await fetchRoute('walking', start, entrance);
  if (request !== dirRequest) return;
  if (!route) {
    clearRoute();
    dirResult.textContent = '';
    dirResult.appendChild(googleTransitLink(entrance));
    return;
  }
  drawRoute(route.geometry, start, entrance);
  const walk = `${formatDuration(route.duration)} walk · ${formatDistance(route.distance)}`;
  if (walkFromHere) {
    showRoute(route, walk, "You're close enough to walk. Your route is highlighted in red on the map.");
  } else {
    const link = document.createElement('p');
    link.appendChild(googleTransitLink(entrance));
    showRoute(route, walk + ' from the Metro',
      `Take the ${station.line} Line to ${station.name}. The walk from the station to the park is highlighted in red on the map. Buses also run along 16th St, right past the park.`, link);
  }
}

function resetDirections() {
  dirRequest++;
  clearRoute();
  dirOrigin = null;
  dirInput.value = '';
  dirResult.textContent = '';
  map.flyTo({ ...INITIAL_VIEW, duration: 1200 });
}

function setOrigin(coords, label) {
  dirOrigin = { coords, label };
  dirInput.value = label;
  dirSuggestions.textContent = '';
  getDirections();
}

async function suggest(query) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?autocomplete=true&limit=5&proximity=${PARK_CENTER.join(',')}&country=us&bbox=${DIR_SEARCH_BBOX.join(',')}` +
    `&access_token=${mapboxgl.accessToken}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    dirSuggestions.textContent = '';
    (data.features || []).forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f.place_name;
      li.addEventListener('click', () => setOrigin(f.center, f.place_name));
      dirSuggestions.appendChild(li);
    });
  } catch (e) {
    dirSuggestions.textContent = '';
  }
}

dirInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = dirInput.value.trim();
  if (q.length < 3) { dirSuggestions.textContent = ''; return; }
  suggestTimer = setTimeout(() => suggest(q), 250);
});

dirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = dirSuggestions.querySelector('li');
    if (first) first.click();
  }
});

// Clicking anywhere on the map dismisses the search suggestions.
map.on('click', () => {
  clearTimeout(suggestTimer);
  dirSuggestions.textContent = '';
  dirInput.blur();
});

dirInput.addEventListener('focus', () => {
  const q = dirInput.value.trim();
  if (q.length >= 3 && !dirOrigin) suggest(q);
});

document.getElementById('dir-locate').addEventListener('click', () => {
  if (!navigator.geolocation) {
    dirResult.textContent = 'Location is not available in this browser.';
    return;
  }
  dirResult.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setOrigin([pos.coords.longitude, pos.coords.latitude], 'My current location'),
    () => { dirResult.textContent = 'Could not get your location. Try typing an address instead.'; }
  );
});

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    dirMode = btn.dataset.mode;
    getDirections();
  });
});
