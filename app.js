'use strict';

// ---------- config ----------
const PADS = [
  { id: 'kick',  name: 'KICK',   file: 'samples/kick.wav' },
  { id: 'snare', name: 'SNARE',  file: 'samples/snare.wav' },
  { id: 'clap',  name: 'CLAP',   file: 'samples/clap.wav' },
  { id: 'hihat', name: 'HI-HAT', file: 'samples/hihat.wav' },
];
// Roll values in beats (1/1 = one beat).
const DIVS = [
  { label: '1/1',  beats: 1 },
  { label: '1/2',  beats: 1 / 2 },
  { label: '1/3',  beats: 1 / 3 },
  { label: '1/4',  beats: 1 / 4 },
  { label: '1/8',  beats: 1 / 8 },
  { label: '1/16', beats: 1 / 16 },
];
const BPM_MIN = 60, BPM_MAX = 200;
const LOOKAHEAD = 0.04;      // seconds scheduled ahead
const TICK_MS = 8;
const NUDGE_RATE = 0.04;     // phase shift per second while nudge is held (4%)
const NUDGE_STEP = 0.005;    // phase shift per nudge tap
const STORE_KEY = 'xpad-v1';

// ---------- state ----------
const state = {
  bpm: 128,
  volume: 0.875,             // 0.875 = 0 dB
  quantize: true,
  pads: PADS.map(() => ({ pitch: 0, decay: 1 })),
};
loadState();

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!s) return;
    if (typeof s.bpm === 'number') state.bpm = clamp(s.bpm, BPM_MIN, BPM_MAX);
    if (typeof s.volume === 'number') state.volume = clamp(s.volume, 0, 1);
    if (typeof s.quantize === 'boolean') state.quantize = s.quantize;
    if (Array.isArray(s.pads)) s.pads.forEach((p, i) => {
      if (!state.pads[i] || !p) return;
      if (typeof p.pitch === 'number') state.pads[i].pitch = clamp(p.pitch, -12, 12);
      if (typeof p.decay === 'number') state.pads[i].decay = clamp(p.decay, 0, 1);
    });
  } catch (e) { /* storage unavailable */ }
}

let saveTimer = 0;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }, 300);
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
const $ = (id) => document.getElementById(id);

// ---------- audio graph ----------
const AC = window.AudioContext || window.webkitAudioContext;
const ctx = new AC({ latencyHint: 'interactive' });
const master = ctx.createGain();
const limiter = ctx.createDynamicsCompressor();
limiter.threshold.value = -1;
limiter.knee.value = 0;
limiter.ratio.value = 20;
limiter.attack.value = 0.001;
limiter.release.value = 0.08;
master.connect(limiter).connect(ctx.destination);

function volumeDb(v) { return v <= 0 ? -Infinity : -42 + 48 * v; }
function applyVolume() {
  const db = volumeDb(state.volume);
  master.gain.setTargetAtTime(db === -Infinity ? 0 : Math.pow(10, db / 20), ctx.currentTime, 0.01);
}
applyVolume();

const buffers = [];
async function loadSamples() {
  await Promise.all(PADS.map(async (p, i) => {
    const res = await fetch(p.file);
    const data = await res.arrayBuffer();
    buffers[i] = await new Promise((ok, fail) => ctx.decodeAudioData(data, ok, fail));
  }));
}

// Context time of the sample that is reaching the speakers at performance time `perf`.
function heardAt(perf) {
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime > 0 && ts.performanceTime > 0) {
      const t = ts.contextTime + (perf - ts.performanceTime) / 1000;
      return clamp(t, ctx.currentTime - 0.5, ctx.currentTime);
    }
  }
  return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0) - (performance.now() - perf) / 1000;
}
const heardNow = () => heardAt(performance.now());

// ---------- voices ----------
const lastVoice = PADS.map(() => null);
const pending = PADS.map(() => []);   // voices not yet ended
const lastHit = PADS.map(() => -1);   // start time of last scheduled hit
const flashQueue = [];

function playVoice(i, t) {
  const buf = buffers[i];
  if (!buf) return;
  const p = state.pads[i];
  const rate = Math.pow(2, p.pitch / 12);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const env = ctx.createGain();
  const choke = ctx.createGain();
  src.connect(env).connect(choke).connect(master);

  const full = buf.duration / rate;
  let end = t + full;
  if (p.decay < 0.995) {
    const dur = 0.02 + p.decay * p.decay * full;
    env.gain.setValueAtTime(1, t);
    env.gain.setTargetAtTime(0, t + dur * 0.35, dur * 0.22);
    end = Math.min(end, t + dur * 1.6);
  }

  // Retrigger chokes the previous hit of the same pad, like the hardware.
  const prev = lastVoice[i];
  if (prev && prev.end > t) {
    prev.choke.gain.setValueAtTime(1, t);
    prev.choke.gain.linearRampToValueAtTime(0, t + 0.004);
    try { prev.src.stop(t + 0.005); } catch (e) { /* already stopped */ }
    prev.chokedAt = t;
  }

  src.start(t);
  src.stop(end + 0.01);
  const v = { src, choke, start: t, end, prev };
  src.onended = () => {
    const list = pending[i];
    const k = list.indexOf(v);
    if (k >= 0) list.splice(k, 1);
    v.prev = null;
    src.disconnect();
  };
  lastVoice[i] = v;
  pending[i].push(v);
  lastHit[i] = t;
  flashQueue.push({ pad: i, time: t });
}

// Drop hits that were scheduled but have not started yet.
function cancelFuture(i) {
  const now = ctx.currentTime;
  const list = pending[i];
  let cancelled = false, restored = null;
  for (let k = list.length - 1; k >= 0; k--) {
    const v = list[k];
    if (v.start <= now) continue;
    try { v.src.stop(0); } catch (e) { /* ignore */ }
    v.src.disconnect();
    list.splice(k, 1);
    cancelled = true;
    restored = v.prev;
  }
  if (!cancelled) return;
  if (restored) {
    // Undo the choke a cancelled hit had scheduled on the voice before it.
    restored.choke.gain.cancelScheduledValues(0);
    restored.choke.gain.setValueAtTime(1, now);
    try { restored.src.stop(restored.end + 0.01); } catch (e) { /* ignore */ }
  }
  lastVoice[i] = restored;
  lastHit[i] = restored ? restored.start : -1;
  for (let k = flashQueue.length - 1; k >= 0; k--) {
    if (flashQueue[k].pad === i && flashQueue[k].time > now) flashQueue.splice(k, 1);
  }
}

// ---------- tempo grid ----------
let anchor = 0;  // context time (as heard) of a beat
const spb = () => 60 / state.bpm;
const stepSec = (d) => DIVS[d].beats * spb();
function gridNext(step, from) {
  return anchor + Math.ceil((from - anchor) / step - 1e-6) * step;
}

function setBpm(bpm) {
  bpm = Math.round(clamp(bpm, BPM_MIN, BPM_MAX) * 10) / 10;
  if (bpm === state.bpm) return;
  const now = heardNow();
  const pos = (now - anchor) / spb();
  state.bpm = bpm;
  anchor = now - pos * spb();
  renderBpm();
  saveState();
}

// ---------- rolls ----------
const rolls = PADS.map(() => null);  // { div, first }

function setRoll(i, d) {
  const cur = rolls[i];
  if (cur && cur.div === d) return;
  if (cur) cancelFuture(i);
  const now = ctx.currentTime + 0.003;
  const step = stepSec(d);
  const last = lastHit[i];
  let first;
  if (state.quantize) {
    first = gridNext(step, Math.max(now, last + step * 0.5));
    // A grid point that passed a moment ago still counts: fire right away.
    const prevGrid = first - step;
    if (!cur && now - prevGrid < 0.025 && last < prevGrid - step * 0.5) first = now;
  } else {
    first = Math.max(now, last + step);
  }
  rolls[i] = { div: d, first };
  tick();
}

function stopRoll(i) {
  if (!rolls[i]) return;
  rolls[i] = null;
  cancelFuture(i);
}

function tick() {
  const now = ctx.currentTime;
  const horizon = now + LOOKAHEAD;
  rolls.forEach((r, i) => {
    if (!r) return;
    const step = stepSec(r.div);
    for (let guard = 0; guard < 64; guard++) {
      let t;
      if (r.first != null) t = r.first;
      else if (state.quantize) t = gridNext(step, lastHit[i] + step * 0.5);
      else t = lastHit[i] + step;
      if (t < now) t = state.quantize ? gridNext(step, now) : now;
      if (t > horizon) break;
      r.first = null;
      playVoice(i, t);
    }
  });
}
setInterval(tick, TICK_MS);

// ---------- build UI ----------
const padEls = [];
const cellEls = [];

PADS.forEach((p, i) => {
  const ch = document.createElement('div');
  ch.className = 'channel';
  const kp = document.createElement('div');
  const kd = document.createElement('div');
  ch.append(kp, kd);
  $('channels').append(ch);
  makeKnob(kp, {
    label: 'PITCH', min: -12, max: 12, def: 0, bipolar: true,
    get: () => state.pads[i].pitch,
    set: (v) => { state.pads[i].pitch = Math.abs(v) < 0.15 ? 0 : Math.round(v * 10) / 10; },
    fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' st',
  });
  makeKnob(kd, {
    label: 'DECAY', min: 0, max: 1, def: 1,
    get: () => state.pads[i].decay,
    set: (v) => { state.pads[i].decay = v; },
    fmt: (v) => Math.round(v * 100) + '%',
  });

  const pad = document.createElement('div');
  pad.className = 'pad';
  pad.dataset.pad = i;
  pad.innerHTML = `<span class="pad-led"></span><span class="pad-name">${p.name}</span>`;
  $('pads').append(pad);
  padEls.push(pad);
});

DIVS.forEach((d, k) => {
  const c = document.createElement('div');
  c.className = 'cell';
  c.dataset.cell = k;
  c.textContent = d.label;
  $('strip').append(c);
  cellEls.push(c);
});

makeKnob($('volume'), {
  label: 'VOLUME', min: 0, max: 1, def: 0.875,
  get: () => state.volume,
  set: (v) => { state.volume = v; applyVolume(); },
  fmt: (v) => {
    const db = volumeDb(v);
    return db === -Infinity ? '−∞ dB' : (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
  },
});

function makeKnob(host, o) {
  host.classList.add('knob');
  host.innerHTML = '<div class="knob-label"></div><div class="knob-body"><div class="knob-cap"><i class="knob-ptr"></i></div></div><div class="knob-val"></div>';
  host.querySelector('.knob-label').textContent = o.label;
  const body = host.querySelector('.knob-body');
  const cap = host.querySelector('.knob-cap');
  const out = host.querySelector('.knob-val');
  const range = o.max - o.min;

  function render() {
    const v = o.get();
    const f = (v - o.min) / range;
    cap.style.transform = `rotate(${-135 + 270 * f}deg)`;
    const a = 270 * f;
    const c = o.bipolar ? 135 : 0;
    body.style.setProperty('--s', Math.min(a, c) + 'deg');
    body.style.setProperty('--e', Math.max(a, c) + 'deg');
    out.textContent = o.fmt(v);
  }

  let drag = null, lastDown = 0;
  body.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    body.setPointerCapture(e.pointerId);
    if (e.timeStamp - lastDown < 300) {  // double tap resets
      o.set(o.def);
      render();
      saveState();
      drag = null;
      lastDown = 0;
      return;
    }
    lastDown = e.timeStamp;
    drag = { id: e.pointerId, y: e.clientY, v: o.get() };
  });
  body.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const v = clamp(drag.v + (drag.y - e.clientY) / 220 * range, o.min, o.max);
    o.set(v);
    render();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    saveState();
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
  render();
}

// ---------- pads + strip touch ----------
const pointers = new Map();  // pointerId -> { pad: index|null, cell: index|null }
let lastPad = 0;

function hitTest(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { pad: null, cell: null };
  const pad = el.closest('.pad');
  const cell = el.closest('.cell');
  return {
    pad: pad ? +pad.dataset.pad : null,
    cell: cell ? +cell.dataset.cell : null,
  };
}

function onSurfaceDown(e) {
  const h = hitTest(e.clientX, e.clientY);
  if (h.pad == null && h.cell == null) return;
  e.preventDefault();
  if (h.pad != null) {
    pointers.set(e.pointerId, { pad: h.pad, cell: null });
    lastPad = h.pad;
    playVoice(h.pad, ctx.currentTime);
  } else {
    pointers.set(e.pointerId, { pad: null, cell: h.cell });
  }
  recompute();
}
function onSurfaceMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const cell = hitTest(e.clientX, e.clientY).cell;
  if (cell === p.cell) return;
  p.cell = cell;
  recompute();
}
function onSurfaceUp(e) {
  if (!pointers.delete(e.pointerId)) return;
  recompute();
}
$('pads').addEventListener('pointerdown', onSurfaceDown);
$('strip').addEventListener('pointerdown', onSurfaceDown);
window.addEventListener('pointermove', onSurfaceMove);
window.addEventListener('pointerup', onSurfaceUp);
window.addEventListener('pointercancel', onSurfaceUp);

// A finger that started on a pad rolls that pad while it is over the strip.
// A finger that started on the strip rolls every held pad, or the last pad played.
function recompute() {
  const held = [...new Set([...pointers.values()].filter((p) => p.pad != null).map((p) => p.pad))];
  const desired = new Map();
  for (const p of pointers.values()) {
    if (p.cell == null) continue;
    if (p.pad != null) desired.set(p.pad, p.cell);
    else (held.length ? held : [lastPad]).forEach((i) => desired.set(i, p.cell));
  }
  PADS.forEach((_, i) => {
    if (desired.has(i)) setRoll(i, desired.get(i));
    else stopRoll(i);
  });

  const activeCells = new Set(desired.values());
  for (const p of pointers.values()) if (p.cell != null) activeCells.add(p.cell);
  cellEls.forEach((c, k) => c.classList.toggle('active', activeCells.has(k)));
  padEls.forEach((el, i) => {
    el.classList.toggle('held', held.includes(i));
    el.classList.toggle('rolling', !!rolls[i]);
    el.classList.toggle('selected', i === lastPad);
  });
}

function releaseAll() {
  pointers.clear();
  recompute();
}

// ---------- tempo controls ----------
function renderBpm() { $('bpm').textContent = state.bpm.toFixed(1); }
renderBpm();

function holdButton(el, onDown, onUp) {
  let id = null;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    id = e.pointerId;
    el.classList.add('pressed');
    onDown(e);
  });
  const up = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    el.classList.remove('pressed');
    if (onUp) onUp(e);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function repeatButton(el, fn) {
  let t1 = 0, t2 = 0;
  holdButton(el, () => {
    fn();
    t1 = setTimeout(() => { t2 = setInterval(fn, 60); }, 400);
  }, () => { clearTimeout(t1); clearInterval(t2); });
}
repeatButton($('bpmDown'), () => setBpm(state.bpm - 0.1));
repeatButton($('bpmUp'), () => setBpm(state.bpm + 0.1));

let taps = [];
holdButton($('tap'), (e) => {
  const t = heardAt(e.timeStamp);
  if (taps.length && t - taps[taps.length - 1] > 2) taps = [];
  taps.push(t);
  if (taps.length > 8) taps.shift();
  const n = taps.length - 1;
  if (n >= 1) {
    const bpm = 60 * n / (taps[n] - taps[0]);
    if (bpm >= BPM_MIN && bpm <= BPM_MAX) {
      state.bpm = Math.round(bpm * 10) / 10;
      renderBpm();
      saveState();
    }
  }
  // Phase: average the taps against the new grid.
  const s = spb();
  let sum = 0;
  taps.forEach((tt, k) => { sum += tt - (k - n) * s; });
  anchor = sum / taps.length;
});

let nudgeDir = 0;
function nudge(el, dir) {
  holdButton(el, () => { anchor -= dir * NUDGE_STEP; nudgeDir = dir; }, () => { nudgeDir = 0; });
}
nudge($('nudgeFwd'), 1);
nudge($('nudgeBack'), -1);

function renderQuant() {
  const b = $('quant');
  b.textContent = state.quantize ? 'ON' : 'OFF';
  b.classList.toggle('on', state.quantize);
}
holdButton($('quant'), () => { state.quantize = !state.quantize; renderQuant(); saveState(); });
renderQuant();

// ---------- display loop ----------
const beatEls = [...$('beats').children];
let lastFrame = performance.now();
function frame(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (nudgeDir) anchor -= nudgeDir * dt * NUDGE_RATE;

  const h = heardNow();
  const pos = (h - anchor) / spb();
  const beat = ((Math.floor(pos) % 4) + 4) % 4;
  const frac = pos - Math.floor(pos);
  beatEls.forEach((el, k) => el.classList.toggle('on', k === beat));
  $('tap').classList.toggle('beat', frac < 0.15);

  for (let k = flashQueue.length - 1; k >= 0; k--) {
    if (flashQueue[k].time > h) continue;
    const el = padEls[flashQueue[k].pad];
    flashQueue.splice(k, 1);
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- power / lifecycle ----------
const power = $('power');
const powerBtn = $('powerBtn');
const powerMsg = $('powerMsg');
let wakeLock = null;
let silentEl = null;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* not allowed */ }
}

// Keeps Web Audio audible with the silent switch on, where audioSession is missing.
function silentLoop() {
  if (silentEl) return;
  const n = 8000, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const str = (o, s) => { for (let k = 0; k < s.length; k++) dv.setUint8(o + k, s.charCodeAt(k)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 2, true);
  silentEl = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  silentEl.loop = true;
  silentEl.setAttribute('playsinline', '');
  silentEl.play().catch(() => {});
}

async function powerOn() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    else silentLoop();
  } catch (e) { silentLoop(); }
  try { await ctx.resume(); } catch (e) { /* retry on next tap */ }
  if (ctx.state === 'running') {
    if (!anchor) anchor = heardNow();
    power.classList.add('hidden');
    requestWakeLock();
  }
}
powerBtn.addEventListener('click', powerOn);

function showPower(msg) {
  releaseAll();
  powerMsg.textContent = msg;
  power.classList.remove('hidden');
}

ctx.onstatechange = () => {
  if (ctx.state !== 'running' && document.visibilityState === 'visible' && buffers.length === PADS.length) {
    showPower('Audio en pausa. Toca para reanudar.');
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { releaseAll(); return; }
  if (ctx.state !== 'running') showPower('Audio en pausa. Toca para reanudar.');
  else requestWakeLock();
});
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

powerBtn.disabled = true;
loadSamples().then(() => {
  powerBtn.disabled = false;
  powerMsg.textContent = 'Toca ON para encender el audio';
}).catch((err) => {
  powerMsg.textContent = 'No se pudieron cargar los sonidos: ' + err.message;
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
recompute();
