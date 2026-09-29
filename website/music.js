// ---------------------------------------------------------------------------
// Background music: "DC Music.wav", a 35 s loop, played gaplessly through
// Web Audio (an <audio loop> element leaves an audible gap at each repeat).
// Browsers only let sound start once the visitor has interacted with the
// page, so it starts on the first click or key press; the "Music" button
// turns it off and on. Quiet enough that the rat's footsteps still come
// through, and paused while the tab is hidden.
// ---------------------------------------------------------------------------
const MUSIC_URL = 'DC%20Music.wav';
const MUSIC_VOLUME = 0.35;
const music = { ctx: null, gain: null, on: true, button: document.getElementById('music-toggle') };

async function startMusic() {
  if (music.ctx) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  music.ctx = ctx;
  music.gain = gain;
  try {
    const buffer = await ctx.decodeAudioData(await (await fetch(MUSIC_URL)).arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(gain);
    src.start();
    setMusicVolume();
  } catch (e) {
    console.error('Background music failed to load:', e);
  }
}

function setMusicVolume() {
  if (!music.gain) return;
  const t = music.ctx.currentTime;
  music.gain.gain.cancelScheduledValues(t);
  music.gain.gain.setTargetAtTime(music.on ? MUSIC_VOLUME : 0, t, 0.3);
}

function updateMusicButton() {
  if (music.button) music.button.textContent = music.on ? 'Music: On' : 'Music: Off';
}

// The first click or key press anywhere starts it (if it's on).
function musicFirstGesture() {
  window.removeEventListener('pointerdown', musicFirstGesture, true);
  window.removeEventListener('keydown', musicFirstGesture, true);
  if (music.on) startMusic();
}
window.addEventListener('pointerdown', musicFirstGesture, true);
window.addEventListener('keydown', musicFirstGesture, true);

music.button?.addEventListener('click', () => {
  music.on = !music.on;
  if (music.on) startMusic();
  if (music.ctx) music.ctx.resume();
  setMusicVolume();
  updateMusicButton();
});

document.addEventListener('visibilitychange', () => {
  if (!music.ctx) return;
  if (document.hidden) music.ctx.suspend();
  else music.ctx.resume();
});

updateMusicButton();
