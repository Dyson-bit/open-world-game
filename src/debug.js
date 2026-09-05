// Debug API: window.__game, used by tools/shot.mjs, tools/capture.mjs and by hand in the console.
// main.js builds the host object (gd, b, ready and the loop hooks) and calls installDebug; the
// data pokes live here. Allocating in this file is fine — nothing here runs in the frame path.
import { CAR_STATE, PLAYER_MODE } from './balance.js';
import { enterCar, exitCar as logicExitCar } from './logic/player.js';
import { spawnCar as logicSpawnCar } from './logic/spawn.js';

const NUMERIC_INPUTS = { orbitDX: 1, orbitDY: 1, zoom: 1 };

export function installDebug(api) {
  const gd = api.gd, b = api.b;

  api.state = function state() {
    let wrecked = 0, traffic = 0;
    for (let i = 0; i < gd.carCount; i++) {
      if (gd.carState[i] === CAR_STATE.WRECK) wrecked++;
      else if (gd.carState[i] === CAR_STATE.TRAFFIC) traffic++;
    }
    const pc = gd.playerCar;
    return {
      tick: gd.tick,
      time: round3(gd.time),
      fps: round3(api.getFps ? api.getFps() : 0),
      playerMode: gd.playerMode,
      playerCar: pc,
      playerX: round3(gd.playerX),
      playerZ: round3(gd.playerZ),
      carCount: gd.carCount,
      wrecked,
      traffic,
      stolen: gd.statStolen,
      statWrecked: gd.statWrecked,
      nearestCar: gd.nearestCar,
      health: pc >= 0 ? round3(gd.carHealth[pc]) : -1,
      speed: pc >= 0 ? round3(Math.abs(gd.carSpeedF[pc])) : 0,
    };
  };

  // Held keys persist until changed. `action: true` (or camToggle/mute) sets the one-tick edge.
  api.setInput = function setInput(obj) {
    if (!obj) return;
    const inp = gd.input;
    for (const k in obj) {
      if (!(k in inp)) throw new Error('setInput: unknown input "' + k + '"');
      inp[k] = NUMERIC_INPUTS[k] ? Number(obj[k]) : (obj[k] ? 1 : 0);
    }
  };

  api.press = function press(name) {
    const inp = gd.input;
    if (!(name in inp)) throw new Error('press: unknown input "' + name + '"');
    inp[name] = 1;
  };

  api.teleport = function teleport(x, z, yaw) {
    const y = yaw === undefined ? 0 : yaw;
    if (gd.playerMode === PLAYER_MODE.IN_CAR && gd.playerCar >= 0) {
      const i = gd.playerCar;
      gd.carX[i] = x; gd.carZ[i] = z; gd.carYaw[i] = y;
      gd.carVX[i] = 0; gd.carVZ[i] = 0;
      gd.carYawRate[i] = 0; gd.carSpeedF[i] = 0; gd.carSlip[i] = 0;
    }
    gd.playerX = x; gd.playerZ = z; gd.playerYaw = y;
    gd.playerVX = 0; gd.playerVY = 0; gd.playerVZ = 0;
    gd.camInit = 0;
  };

  // Nearest live, drivable car by centre distance — no range limit, this is a test hook.
  api.enterNearestCar = function enterNearestCar() {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < gd.carCount; i++) {
      const s = gd.carState[i];
      if (s === CAR_STATE.WRECK || s === CAR_STATE.BURNING) continue;
      const dx = gd.carX[i] - gd.playerX, dz = gd.carZ[i] - gd.playerZ;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) enterCar(gd, b, best);
    return best;
  };

  api.exitCar = function exitCar() { logicExitCar(gd, b); };

  api.spawnCar = function spawnCar(type, x, z, yaw) {
    const paint = b.carPaint[(gd.rand() * b.carPaint.length) | 0];
    return logicSpawnCar(gd, b, type, paint, x, z, yaw === undefined ? 0 : yaw, CAR_STATE.PARKED);
  };

  api.setHealth = function setHealth(i, h) {
    if (i < 0 || i >= gd.carHealth.length) throw new Error('setHealth: bad car index ' + i);
    gd.carHealth[i] = h;
  };

  api.setFreeCamera = function setFreeCamera(x, y, z, lx, ly, lz) {
    gd.camFree = 1;
    gd.camX = x; gd.camY = y; gd.camZ = z;
    gd.camLookX = lx; gd.camLookY = ly; gd.camLookZ = lz;
  };

  api.clearFreeCamera = function clearFreeCamera() {
    gd.camFree = 0;
    gd.camInit = 0;
  };

  window.__game = api;
  return api;
}

function round3(v) { return Math.round(v * 1000) / 1000; }
