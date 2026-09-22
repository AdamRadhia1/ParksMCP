// Events shown in the top-right panel.
// Keep this list in sync with events.json in the meridian-events-mcp folder.
// These three are SAMPLE events; replace them with real ones.
const events = [
  {
    name: 'Sunday Drum Circle',
    date: '2026-10-04',
    time: '3:00 PM',
    location: 'Upper terrace, Meridian Hill Park',
    description: 'A long-running community gathering of drummers and dancers.'
  },
  {
    name: 'Malcolm X Park Community Picnic',
    date: '2026-10-11',
    time: '12:00 PM',
    location: 'Lower lawn, Meridian Hill Park',
    description: 'Bring a blanket and food to share.'
  },
  {
    name: 'Fall Yoga in the Park',
    date: '2026-10-18',
    time: '9:00 AM',
    location: 'Near the fountain',
    description: 'Free outdoor yoga class, all levels.'
  }
];

const eventsListEl = document.getElementById('events-list');
const SHOW_MS = 5000; // how long each event stays before the next bubble appears

function upcomingEvents() {
  // Recomputed each cycle so past events drop off on their own.
  const todayStr = new Date().toISOString().slice(0, 10);
  return events
    .filter((e) => e.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildEventItem(e) {
  const li = document.createElement('li');
  const when = new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    li.appendChild(d);
  };
  add('ev-name', e.name);
  add('ev-when', `${when} · ${e.time}`);
  add('ev-where', e.location);
  add('ev-desc', e.description);
  return li;
}

let eventIndex = 0;   // which upcoming event is on screen
let cycleTimer = null;
let switching = false;

const countEl = document.getElementById('events-count');

function showEvent(index) {
  const list = upcomingEvents();
  const old = eventsListEl.firstElementChild;

  if (list.length === 0) {
    eventsListEl.textContent = 'No upcoming events right now.';
    countEl.textContent = '';
    return;
  }
  if (switching) return;

  eventIndex = ((index % list.length) + list.length) % list.length;

  const show = () => {
    const li = buildEventItem(list[eventIndex]);
    li.classList.add('bubble-in');
    eventsListEl.replaceChildren(li);
    countEl.textContent = `${eventIndex + 1} / ${list.length}`;
    switching = false;
  };

  if (old && old.tagName === 'LI') {
    switching = true;
    old.classList.remove('bubble-in');
    old.classList.add('bubble-out');
    setTimeout(show, 850);
  } else {
    show();
  }
}

function startCycle() {
  clearInterval(cycleTimer);
  cycleTimer = setInterval(() => showEvent(eventIndex + 1), SHOW_MS);
}

// Arrows: go back/forward, then restart the auto-cycle timer so the
// event the visitor picked stays up for a full interval.
document.getElementById('events-prev').addEventListener('click', () => {
  showEvent(eventIndex - 1);
  startCycle();
});
document.getElementById('events-next').addEventListener('click', () => {
  showEvent(eventIndex + 1);
  startCycle();
});

// Sit just below the map's navigation buttons (zoom, compass, fullscreen).
function placeEventsPanel() {
  const ctrl = document.querySelector('.mapboxgl-ctrl-top-right');
  if (!ctrl) return;
  const bottom = ctrl.getBoundingClientRect().bottom;
  if (bottom > 0) document.getElementById('events-panel').style.top = (bottom + 10) + 'px';
}
placeEventsPanel();
window.addEventListener('resize', placeEventsPanel);
window.addEventListener('load', placeEventsPanel);
setTimeout(placeEventsPanel, 500);

showEvent(0);
startCycle();
