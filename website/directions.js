// ---------------------------------------------------------------------------
// "How do I get here?" — geocoding + Mapbox Directions to the park
// ---------------------------------------------------------------------------
const PARK_DESTINATION = [-77.0366, 38.9198]; // south entrance, 16th & W St NW
const ROUTE_SOURCE = 'route';
const ROUTE_LAYER = 'route-line';

const dirInput = document.getElementById('dir-input');
const dirSuggestions = document.getElementById('dir-suggestions');
const dirResult = document.getElementById('dir-result');
const modeButtons = document.querySelectorAll('#dir-modes button');

let dirMode = 'walking';
let dirOrigin = null; // { coords: [lng, lat], label }
let originMarker = null;
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

function clearRoute() {
  if (map.getLayer(ROUTE_LAYER)) map.removeLayer(ROUTE_LAYER);
  if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);
  if (originMarker) { originMarker.remove(); originMarker = null; }
}

function drawRoute(geometry) {
  clearRoute();
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'Feature', geometry } });
  map.addLayer({
    id: ROUTE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    slot: 'top',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#c99a3a', 'line-width': 6, 'line-emissive-strength': 1 }
  });
  originMarker = new mapboxgl.Marker({ color: '#c99a3a' }).setLngLat(dirOrigin.coords).addTo(map);

  const bounds = geometry.coordinates.reduce(
    (b, c) => b.extend(c),
    new mapboxgl.LngLatBounds(geometry.coordinates[0], geometry.coordinates[0])
  );
  map.fitBounds(bounds, { padding: { top: 120, bottom: 120, left: 380, right: 120 }, pitch: 0, bearing: 0, duration: 1400 });
}

function showTransitLink() {
  const [lng, lat] = dirOrigin.coords;
  const url = 'https://www.google.com/maps/dir/?api=1&travelmode=transit' +
    `&origin=${lat},${lng}&destination=${PARK_DESTINATION[1]},${PARK_DESTINATION[0]}`;
  clearRoute();
  dirResult.textContent = '';
  const p = document.createElement('p');
  p.textContent = 'Transit routes open in Google Maps. ';
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Get transit directions';
  p.appendChild(a);
  dirResult.appendChild(p);
}

async function getDirections() {
  if (!dirOrigin) return;
  if (dirMode === 'transit') return showTransitLink();

  dirResult.textContent = 'Finding route…';
  const coords = `${dirOrigin.coords.join(',')};${PARK_DESTINATION.join(',')}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/${dirMode}/${coords}` +
    `?geometries=geojson&steps=true&overview=full&access_token=${mapboxgl.accessToken}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) {
      dirResult.textContent = 'No route found from that location.';
      return;
    }
    drawRoute(route.geometry);

    dirResult.textContent = '';
    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.textContent = `${formatDuration(route.duration)} · ${formatDistance(route.distance)}`;
    const steps = document.createElement('ol');
    route.legs[0].steps.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = s.maneuver.instruction;
      steps.appendChild(li);
    });
    const clear = document.createElement('button');
    clear.id = 'dir-clear';
    clear.textContent = 'Clear route';
    clear.addEventListener('click', resetDirections);
    dirResult.append(summary, steps, clear);
  } catch (e) {
    dirResult.textContent = 'Could not load directions. Please try again.';
  }
}

function resetDirections() {
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
    `?autocomplete=true&limit=5&proximity=${PARK_CENTER.join(',')}&access_token=${mapboxgl.accessToken}`;
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
