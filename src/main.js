// Game: owns balance + gameData, runs the fixed 60 Hz tick, drives the Board, exposes the debug API.
// There is exactly one requestAnimationFrame chain and it lives here.
import { balance, validate } from './balance.js';
import { allocateGameData, clearEvents } from './gameData.js';
import { startGame, tick } from './logic/tick.js';
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
const seedParam = params.get('seed');
const seed = seedParam === null || seedParam === '' ? balance.seed : (Number(seedParam) | 0);
const autostart = params.get('autostart') === '1';
const headless = params.get('headless') === '1';
const nohud = params.get('nohud') === '1';
const camParam = params.get('cam') || 'none';

// ---------------------------------------------------------------- data
const b = balance;
validate(b);
const gd = {};
allocateGameData(gd, b, seed);
startGame(gd, b);

// ---------------------------------------------------------------- board
const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const view = createRenderer(canvas, gd, b, { headless });
buildCity(view, gd, b);
const props = buildProps(view, gd, b);
const cars = createCars(view, gd, b);
const character = createCharacter(view, gd, b);
const particles = createParticles(view, gd, b);
const hud = createHud(hudRoot, gd, b, { nohud });
const audio = createAudio(gd, b);
attachInput(canvas, gd, b, { onFirstGesture: start });

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
  gd, b, ready,
  setAutoTick, step, render, hideHud, start,
  camPreset: applyCamPreset,
  getFps: function () { return fps; },
});

requestAnimationFrame(frame);

// ---------------------------------------------------------------- loop
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (dt < 0) dt = 0;
  frameMs += (dt * 1000 - frameMs) * 0.1;
  fps = frameMs > 0.0001 ? 1000 / frameMs : 0;

  if (!started) titleCamera(dt);

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

function start() {
  if (started) return;
  started = true;
  gd.camFree = 0;
  gd.camInit = 0;     // the chase camera snaps on its next update instead of springing from the orbit
  acc = 0;
  audio.unlock();
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
  for (let i = 0; i < count; i++) tick(gd, b);
  frameUpdate(Math.max(count, 1) * b.dt);
}

function render() { frameUpdate(0); }

function hideHud(on) {
  if (hudRoot) hudRoot.classList.toggle('hud-hidden', !!on);
}

// Camera presets reachable from `?cam=<name>` and from tools/shot.mjs. Only `none` exists in Task 1.
function applyCamPreset(name) {
  if (!name || name === 'none') return;
  console.warn('joyride: unknown cam preset "' + name + '"');
}
