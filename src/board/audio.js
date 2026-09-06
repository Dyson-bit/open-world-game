// Procedural WebAudio: engine, tyre squeal, wind, impacts, prop clatter, explosions, door thunks.
// Board module: the Web Audio API lives here.
//
// Nothing is created until unlock() runs on the first user gesture — no AudioContext exists before
// then, so a headless page that never gets a gesture never trips the autoplay policy and never logs
// a warning. Everything after that is guarded: if the platform has no AudioContext, or the context
// refuses to start, audio disables itself silently and the game plays on.
//
// The continuous voices (engine, squeal, wind) are built once and never rebuilt; per-frame updates
// are AudioParam.setTargetAtTime calls, which allocate nothing. One-shot sources are created per
// event, which is fine — impacts and explosions are rare.
import { PLAYER_MODE } from '../balance.js';

const MASTER = 0.5;
const TAU = 0.05;          // setTargetAtTime constant: ~95% of the way there in 0.15 s
const NOISE_SECONDS = 2;

export function createAudio(gd, b) {
  const audio = {
    ctx: null,
    ok: false,        // true once the graph is built and usable
    muted: false,
    master: null,
    noise: null,
    // engine
    osc1: null, osc2: null, engFilter: null, engGain: null,
    // looped noise voices
    squealGain: null, windGain: null,
    unlock: unlock,
    toggleMute: toggleMute,
  };

  function unlock() {
    if (audio.ctx) { resume(); return; }
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext
      : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    if (!Ctor) return;                      // no Web Audio here: stay silent, never throw
    try {
      const ctx = new Ctor();
      build(audio, ctx);
      audio.ctx = ctx;
      audio.ok = true;
    } catch (err) {
      audio.ctx = null;
      audio.ok = false;
      return;
    }
    resume();
  }

  function resume() {
    const ctx = audio.ctx;
    if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(noop);
    } catch (err) { /* no device: stay silent */ }
  }

  function toggleMute() {
    audio.muted = !audio.muted;
    if (!audio.ok) return;
    try {
      audio.master.gain.setTargetAtTime(audio.muted ? 0 : MASTER, audio.ctx.currentTime, 0.02);
    } catch (err) { audio.ok = false; }
  }

  return audio;
}

export function updateAudio(audio, gd, b, dtFrame) {
  if (!audio || !audio.ok || audio.muted) return;
  try {
    frame(audio, gd, b);
  } catch (err) {
    audio.ok = false;   // something in the graph gave up; go quiet rather than throw every frame
  }
}

// ---------------------------------------------------------------- per-frame

function frame(audio, gd, b) {
  const ctx = audio.ctx;
  const t = ctx.currentTime;
  const pc = gd.playerCar;
  const inCar = gd.playerMode === PLAYER_MODE.IN_CAR && pc >= 0;

  let speed = 0, throttle = 0, slip = 0;
  let freq = 70, cutoff = 600, gain = 0;
  if (inCar) {
    const type = gd.carType[pc];
    speed = Math.abs(gd.carSpeedF[pc]);
    throttle = Math.abs(gd.carThrottle[pc]);
    slip = gd.carSlip[pc];
    // rpm wrapped into three "gears": the tone climbs, drops on the shift, climbs again.
    const rpm = 0.25 + speed / b.carMaxSpeed[type];
    const r3 = rpm * 3;
    const frac = r3 - Math.floor(r3);
    freq = 70 + frac * 160;
    cutoff = 600 + 1800 * throttle;
    gain = 0.12 + 0.18 * throttle;
  }

  audio.osc1.frequency.setTargetAtTime(freq, t, TAU);
  audio.osc2.frequency.setTargetAtTime(freq, t, TAU);
  audio.engFilter.frequency.setTargetAtTime(cutoff, t, TAU);
  audio.engGain.gain.setTargetAtTime(gain, t, TAU);

  let sq = (slip - b.skidSlipThreshold) / 6;
  if (sq < 0) sq = 0; else if (sq > 1) sq = 1;
  audio.squealGain.gain.setTargetAtTime(sq * 0.3, t, TAU);

  let wind = speed / 40;
  if (wind < 0) wind = 0; else if (wind > 0.25) wind = 0.25;
  audio.windGain.gain.setTargetAtTime(wind, t, TAU);

  // ---- events accumulated over this frame's ticks
  if (gd.statBigImpact > 2) impact(audio, t, gd.statBigImpact);
  if (gd.knockCount > 0) clatter(audio, t);
  if (gd.expCount > 0) explosion(audio, t);
  if (gd.evtStolenCar >= 0) thunk(audio, t, 0.35);
  if (gd.evtExitCar >= 0) thunk(audio, t, 0.2);
}

// ---------------------------------------------------------------- graph (built once)

function build(audio, ctx) {
  const master = ctx.createGain();
  master.gain.value = audio.muted ? 0 : MASTER;
  master.connect(ctx.destination);
  audio.master = master;

  // one white-noise buffer, shared by every noise voice and every one-shot
  const len = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const noise = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noise.getChannelData(0);
  let s = 22222;
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;   // deterministic, so the noise floor never varies
    data[i] = (s / 2147483648) - 1;
  }
  audio.noise = noise;

  // ---- engine: two detuned saws through a throttle-driven low-pass
  const engGain = ctx.createGain();
  engGain.gain.value = 0;
  engGain.connect(master);
  const engFilter = ctx.createBiquadFilter();
  engFilter.type = 'lowpass';
  engFilter.frequency.value = 600;
  engFilter.Q.value = 0.9;
  engFilter.connect(engGain);
  const osc1 = ctx.createOscillator();
  osc1.type = 'sawtooth';
  osc1.frequency.value = 70;
  osc1.detune.value = -7;
  osc1.connect(engFilter);
  const osc2 = ctx.createOscillator();
  osc2.type = 'sawtooth';
  osc2.frequency.value = 70;
  osc2.detune.value = 7;
  osc2.connect(engFilter);
  osc1.start();
  osc2.start();
  audio.osc1 = osc1; audio.osc2 = osc2; audio.engFilter = engFilter; audio.engGain = engGain;

  // ---- tyre squeal: looped noise through a narrow band-pass
  audio.squealGain = loopVoice(ctx, noise, master, 'bandpass', 900, 6);
  // ---- wind: looped noise through a low-pass
  audio.windGain = loopVoice(ctx, noise, master, 'lowpass', 400, 0.7);
}

function loopVoice(ctx, noise, master, type, freq, q) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(master);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  filter.connect(gain);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.connect(filter);
  src.start();
  return gain;
}

// ---------------------------------------------------------------- one-shots

// A noise burst through a filter, with an attack/decay gain envelope. `f1` sweeps the cutoff.
function burst(audio, t, dur, peak, type, f0, f1, q) {
  const ctx = audio.ctx;
  const src = ctx.createBufferSource();
  src.buffer = audio.noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(f1, t + dur);
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(peak, t + Math.min(0.02, dur * 0.2));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter); filter.connect(gain); gain.connect(audio.master);
  src.start(t, (t * 7.3) % 1);
  src.stop(t + dur);
  src.onended = disconnectChain;
  src._chain = gain;
  return src;
}

// A decaying sine: the low end of an impact or an explosion.
function boom(audio, t, freq, dur, peak) {
  const ctx = audio.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq * 1.6, t);
  osc.frequency.exponentialRampToValueAtTime(freq, t + dur * 0.6);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(peak, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain); gain.connect(audio.master);
  osc.start(t);
  osc.stop(t + dur);
  osc.onended = disconnectChain;
  osc._chain = gain;
}

function impact(audio, t, strength) {
  let p = strength / 15;
  if (p > 1) p = 1;
  burst(audio, t, 0.25, p, 'lowpass', 800, 800, 0.8);
  boom(audio, t, 55, 0.3, p * 0.7);
}

function clatter(audio, t) {
  burst(audio, t, 0.08, 0.2, 'highpass', 2000, 2000, 0.8);
}

function explosion(audio, t) {
  burst(audio, t, 1.2, 0.9, 'lowpass', 3000, 200, 0.7);
  boom(audio, t, 40, 0.8, 0.8);
}

function thunk(audio, t, peak) {
  burst(audio, t, 0.06, peak, 'lowpass', 400, 400, 0.9);
}

function disconnectChain() {
  try {
    this.disconnect();
    if (this._chain) this._chain.disconnect();
  } catch (err) { /* already torn down */ }
}

function noop() {}
