// ---------------------------------------------------------------------------
// Speech bubbles for anyone on the map — NPCs and the rat. A "speaker" is any
// object with `obj` (its THREE.Object3D, positioned at its feet) and
// `headHeight` (meters above its feet to anchor the bubble). All dialogue
// text lives in dialogue.json.
//
// Bubbles are HTML over the map, placed over each speaker's head after
// everyone has moved each frame, and stacked when they'd overlap (people in
// a group stand close together). A speaker's new line replaces its old one.
//
// Requires map.js and actors.js to have run first.
// ---------------------------------------------------------------------------
const TALK_MIN_ONSCREEN_PX = 14; // no bubbles for people drawn smaller than this

const talk = {
  lines: null, // dialogue.json, once loaded
  queue: [],
  active: [],
  recent: [],
  layer: document.getElementById('talk-layer'),

  now() { return performance.now() / 1000; },

  // Queue a line; `delay` in seconds. style: '' | 'scared' | 'rat'.
  say(speaker, text, delay = 0, style = '') {
    this.queue.push({ speaker, text, at: this.now() + delay, style });
  },

  busy(speaker) {
    return this.active.some((b) => b.speaker === speaker) || this.queue.some((u) => u.speaker === speaker);
  },

  count() { return this.active.length + this.queue.length; },

  cancel(speaker) {
    this.queue = this.queue.filter((u) => u.speaker !== speaker);
    this.active.filter((b) => b.speaker === speaker).forEach((b) => this.hide(b));
  },

  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },

  // Random pick that skips anything used recently, so lines don't repeat.
  pickFresh(arr) {
    const fresh = arr.filter((x) => !this.recent.includes(x));
    const choice = this.pick(fresh.length ? fresh : arr);
    this.recent.push(choice);
    if (this.recent.length > 30) this.recent.shift(); // a couple of minutes of talk
    return choice;
  },

  fill(template, place) { return template.replace('{place}', place); },

  // Where a speaker's head is on screen, or null if off screen / too small.
  headOnScreen(speaker) {
    const { x, y, z } = speaker.obj.position;
    const head = actors.toScreen(x, y + speaker.headHeight, z);
    const feet = actors.toScreen(x, y, z);
    if (!head || !feet) return null;
    const minPx = speaker.minPx !== undefined ? speaker.minPx : TALK_MIN_ONSCREEN_PX;
    if (feet.y - head.y < minPx) return null;
    const canvas = map.getCanvas();
    if (head.x < 0 || head.x > canvas.clientWidth || head.y < 0 || feet.y > canvas.clientHeight) return null;
    return head;
  },

  secondsFor(text) { return Math.min(7.5, Math.max(3, 2.2 + text.length * 0.05)); },

  show(speaker, text, style) {
    this.active.filter((b) => b.speaker === speaker).forEach((b) => this.hide(b));
    const el = document.createElement('div');
    el.className = 'talk' + (style ? ' ' + style : '');
    el.textContent = text;
    this.layer.appendChild(el);
    const t = this.now();
    this.active.push({ speaker, el, until: t + this.secondsFor(text) });
    speaker.lastSpokeAt = t;
  },

  hide(bubble) {
    const i = this.active.indexOf(bubble);
    if (i >= 0) this.active.splice(i, 1);
    bubble.el.classList.add('leaving');
    setTimeout(() => bubble.el.remove(), 250);
  },

  update() {
    const t = this.now();
    this.queue = this.queue.filter((u) => {
      if (u.at > t) return true;
      this.show(u.speaker, u.text, u.style);
      return false;
    });
    this.active.slice().forEach((b) => { if (t > b.until) this.hide(b); });

    // Place over heads, lowest on screen first, pushing overlapping bubbles up.
    const placed = [];
    this.active
      .map((b) => ({ b, head: this.headOnScreen(b.speaker) }))
      .sort((p, q) => (q.head ? q.head.y : 0) - (p.head ? p.head.y : 0))
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
  },
};

fetch('dialogue.json')
  .then((r) => r.json())
  .then((lines) => { talk.lines = lines; })
  .catch((err) => console.error('Dialogue failed to load:', err));

actors.onLateFrame(() => talk.update());
