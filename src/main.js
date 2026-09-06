// Game: owns balance + gameData, runs the fixed 60 Hz tick, drives the Board, exposes the debug API.
// There is exactly one requestAnimationFrame chain and it lives here.
import { balance, validate, BLOCK_TYPE, CAR_STATE } from './balance.js';
import { allocateGameData, clearEvents } from './gameData.js';
import { startGame, tick } from './logic/tick.js';
import { spawnCar, pickPaint } from './logic/spawn.js';
import { createRenderer, renderFrame } from './board/renderer.js';
import { buildCity } from './board/cityMesh.js';
import { createCars, updateCars } from './board/carMesh.js';
import { createCharacter, updateCharacter } from './board/charMesh.js';
import { buildProps, updateProps as updatePropsMesh } from './board/propsMesh.js';
import { createParticles, updateParticles as updateParticlesMesh } from './board/particlesMesh.js';
import { createHud, updateHud, showTitle } from './board/hud.js';
import { createAudio, updateAudio } from './board/audio.js';
import { attachInput } from './board/input.js';
import { installDebug } from './debug.js';

// ---------------------------------------------------------------- URL params
const params = new URLSearchParams(location.search);
// Last occurrence wins. tools/shot.mjs builds a base query (headless=1&autostart=1&seed=7) and
// appends whatever --url asked for, so `--url "&autostart=0"` has to override the base rather than
// be shadowed by it — which is what URLSearchParams.get, returning the *first* value, would do.
function param(name) {
  const all = params.getAll(name);
  return all.length ? all[all.length - 1] : null;
}
const seedParam = param('seed');
const seed = seedParam === null || seedParam === '' ? balance.seed : (Number(seedParam) | 0);
const autostart = param('autostart') === '1';
const headless = param('headless') === '1';
const nohud = param('nohud') === '1';
const camParam = param('cam') || 'none';
const lineup = param('lineup') === '1';

// ---------------------------------------------------------------- data
const b = balance;
validate(b);
const gd = {};
allocateGameData(gd, b, seed);
startGame(gd, b);
// ?lineup=1 — one of every car type in a row on the block north of the plaza, for the Board's
// car-model shot. Purely a debug view: they are spawned PARKED with no velocity, so nothing in
// Logic ever touches them again.
if (lineup) {
  for (let t = 0; t < b.carTypeCount; t++) {
    spawnCar(gd, b, t, pickPaint(gd, b, t), -24 + t * 8, 40, 0.6, CAR_STATE.PARKED);
  }
}

// ---------------------------------------------------------------- board
const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const view = createRenderer(canvas, gd, b, { headless });
buildCity(view, gd, b);
const props = buildProps(view, gd, b);
const cars = createCars(view, gd, b);
const character = createCharacter(view, gd, b);
const particles = createParticles(view, gd, b);
const hud = createHud(hudRoot, gd, b, { hidden: nohud });
const audio = createAudio(gd, b);
attachInput(canvas, gd, b, { onFirstGesture: firstGesture });

// ---------------------------------------------------------------- run state
let started = autostart;
let autoTick = !headless;          // headless waits for __game.setAutoTick(true) / step()
let acc = 0;                       // fixed-step accumulator
let titleAngle = 0;
let frameMs = 1000 / 60;           // EMA of frame time
let fps = 60;
let last = performance.now();
let firstFrameDone = false;
let readyResolve = null;
const ready = new Promise(function (res) { readyResolve = res; });

hideHud(nohud);
showTitle(hud, !started);
applyCamPreset(camParam);

installDebug({
  gd, b, ready, view,
  setAutoTick, step, render, hideHud, start,
  camPreset: applyCamPreset,
  getFps: function () { return fps; },
});

requestAnimationFrame(frame);

// ---------------------------------------------------------------- loop
function frame(now) {
  requestAnimationFrame(frame);
  consumeMute();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (dt < 0) dt = 0;
  frameMs += (dt * 1000 - frameMs) * 0.1;
  fps = frameMs > 0.0001 ? 1000 / frameMs : 0;

  // The title card's slow orbit, but only when nothing else has claimed the camera: ?cam=<preset>
  // without autostart=1 used to be applied once at startup and then overwritten every frame by
  // this. An explicit preset wins over the title orbit.
  if (!started && camParam === 'none') titleCamera(dt);

  if (autoTick && started) {
    acc += dt;
    let n = 0;
    while (acc >= b.dt && n < b.maxTicksPerFrame) { tick(gd, b); acc -= b.dt; n++; }
    if (acc > b.dt * b.maxTicksPerFrame) acc = 0;   // fell too far behind: drop the backlog
  }

  frameUpdate(dt);
}

// Board update + render for one displayed frame. Events survive until the Board has seen them,
// so they are cleared here, after the render, never inside tick().
function frameUpdate(dtFrame) {
  updateCars(cars, view, gd, b, dtFrame);
  updateCharacter(character, view, gd, b, dtFrame);
  updatePropsMesh(props, view, gd, b);
  updateParticlesMesh(particles, view, gd, b);
  updateHud(hud, gd, b, dtFrame);
  updateAudio(audio, gd, b, dtFrame);
  renderFrame(view, gd, b, dtFrame);
  clearEvents(gd);
  gd.carDirty.fill(0);
  if (!firstFrameDone) { firstFrameDone = true; readyResolve(); }
}

// Title card: a slow orbit of the plaza until the player touches something.
function titleCamera(dt) {
  titleAngle += 0.08 * dt;
  gd.camFree = 1;
  gd.camX = Math.sin(titleAngle) * b.titleOrbitRadius;
  gd.camY = b.titleOrbitHeight;
  gd.camZ = Math.cos(titleAngle) * b.titleOrbitRadius;
  gd.camLookX = 0; gd.camLookY = 12; gd.camLookZ = 0;
  gd.camFov = b.camFovMin;
}

// The first click or keypress: start the audio context (which needs a gesture) and drop the title.
// The unlock hangs off the gesture, not off start(): autostart=1 makes start() a no-op, and start()
// is also reachable from the debug API with no gesture behind it, where unlocking would be pointless.
function firstGesture() {
  audio.unlock();
  start();
}

// M is an input edge, and Logic clears every edge at the end of the tick that runs after it — so
// the Board would never see it. main consumes it here instead, before any tick can eat it, and
// zeroes it so a held frame cannot toggle twice. Nothing in Logic reads input.mute.
function consumeMute() {
  if (!gd.input.mute) return;
  gd.input.mute = 0;
  audio.toggleMute();
}

function start() {
  if (started) return;
  started = true;
  gd.camFree = 0;
  gd.camInit = 0;     // the chase camera snaps on its next update instead of springing from the orbit
  acc = 0;
  showTitle(hud, false);
}

// ---------------------------------------------------------------- debug hooks
function setAutoTick(on) {
  autoTick = !!on;
  acc = 0;
  last = performance.now();
}

// n ticks then exactly one Board update + render, synchronously.
function step(n) {
  const count = n === undefined ? 1 : (n | 0);
  consumeMute();
  for (let i = 0; i < count; i++) tick(gd, b);
  frameUpdate(Math.max(count, 1) * b.dt);
}

function render() { frameUpdate(0); }

function hideHud(on) {
  if (hudRoot) hudRoot.classList.toggle('hud-hidden', !!on);
}

// Camera presets reachable from `?cam=<name>` and from tools/shot.mjs. Each parks the free camera
// (gd.camFree = 1) so Logic leaves it alone for the rest of the run.
function applyCamPreset(name) {
  if (!name || name === 'none') return;
  if (name === 'skyline') return setCam(-150, 70, 210, 0, 20, 0);
  if (name === 'street') return setCam(11, 2.2, 30, 0, 3, -40);
  if (name === 'lineup') return setCam(0, 5, 58, 0, 1, 40);
  if (name === 'closeup') return setCam(-20, 1.4, 46, -24, 0.8, 40);
  if (name === 'waterfront') return setCam(60, 12, 250, -40, 4, 215);
  if (name === 'plaza') return setCam(45, 25, 45, -10, 15, -10);
  if (name === 'park') {
    let k = -1;
    for (let i = 0; i < gd.blockCount; i++) {
      if (gd.blockType[i] === BLOCK_TYPE.PARK) { k = i; break; }
    }
    if (k < 0) { console.warn('joyride: cam preset "park" — no park block'); return; }
    const d = 40 * Math.SQRT1_2;      // 40 m away, to the south-east
    return setCam(gd.blockX[k] + d, 18, gd.blockZ[k] + d, gd.blockX[k], 2, gd.blockZ[k]);
  }
  console.warn('joyride: unknown cam preset "' + name + '"');
}

function setCam(x, y, z, lx, ly, lz) {
  gd.camFree = 1;
  gd.camX = x; gd.camY = y; gd.camZ = z;
  gd.camLookX = lx; gd.camLookY = ly; gd.camLookZ = lz;
  gd.camFov = b.camFovMin;
  gd.camShake = 0;
}
