import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, PLAYER_MODE, CAR_STATE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { startGame, tick } from '../src/logic/tick.js';
import { updateCamera } from '../src/logic/camera.js';
import { enterCar } from '../src/logic/player.js';
import { spawnCar } from '../src/logic/spawn.js';

const b = balance;

function fresh(seed = 7) {
  const gd = {};
  allocateGameData(gd, b, seed);
  startGame(gd, b);
  return gd;
}

// Put the player in a car of `type` at the origin-ish, rolling forward at `speed` m/s. The camera
// tests drive updateCamera directly, so carSpeedF stays exactly what we set here.
function inCarAt(gd, speed, type = 1) {
  const i = spawnCar(gd, b, type, b.carPaint[0], 0, 0, 0, CAR_STATE.PARKED);
  enterCar(gd, b, i);
  gd.carSpeedF[i] = speed;
  gd.carVX[i] = 0; gd.carVZ[i] = speed;
  gd.playerX = 0; gd.playerZ = 0;
  return i;
}

function tallestCollider(gd) {
  let t = -1, h = -1;
  for (let k = 0; k < gd.colCount; k++) if (gd.colH[k] > h) { h = gd.colH[k]; t = k; }
  return t;
}

test('one tick puts the camera behind the player at the foot distance', () => {
  const gd = fresh();
  tick(gd, b);

  assert.equal(gd.camInit, 1, 'the first update must claim the snap');
  const dx = gd.camX - gd.playerX, dz = gd.camZ - gd.playerZ;
  const d = Math.hypot(dx, dz);
  assert.ok(Math.abs(d - b.camFootDist) < 0.4, `camera ${d.toFixed(2)} m out, wanted ${b.camFootDist}`);
  assert.ok(Math.abs(gd.camY - (gd.playerY + b.camFootHeight)) < 0.4, `camera at y=${gd.camY}`);

  // behind: the player's facing points away from the camera
  const fx = Math.sin(gd.playerYaw), fz = Math.cos(gd.playerYaw);
  assert.ok((-dx * fx - dz * fz) / d > 0.9, 'the camera is not behind the player');

  // and it is looking at him, not past him
  const lookD = Math.hypot(gd.camLookX - gd.playerX, gd.camLookZ - gd.playerZ);
  assert.ok(lookD < 3, `look point ${lookD.toFixed(2)} m from the player`);
  assert.ok(gd.camLookY > gd.playerY, 'the look point is on the floor');
  assert.equal(gd.camFov, b.camFovMin);
});

test('the free camera is left alone', () => {
  const gd = fresh();
  gd.camFree = 1;
  gd.camX = 100; gd.camY = 50; gd.camZ = -20;
  gd.camLookX = 1; gd.camLookY = 2; gd.camLookZ = 3;
  tick(gd, b);
  assert.equal(gd.camX, 100);
  assert.equal(gd.camY, 50);
  assert.equal(gd.camZ, -20);
  assert.equal(gd.camLookX, 1);
});

test('the field of view widens with speed', () => {
  const gd = fresh();
  inCarAt(gd, 20);
  gd.camInit = 1;                      // no snap: we want to see the ease actually get there
  gd.camFov = b.camFovMin;
  for (let k = 0; k < 60; k++) updateCamera(gd, b);
  assert.ok(gd.camFov > b.camFovMin + 5, `fov only reached ${gd.camFov.toFixed(2)}`);
  assert.ok(gd.camFov <= b.camFovMax + 1e-6, `fov overshot to ${gd.camFov}`);
});

test('the camera pulls back and looks further ahead at speed', () => {
  const gd = fresh();
  const i = inCarAt(gd, 0);
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  const slowD = Math.hypot(gd.camX - gd.carX[i], gd.camZ - gd.carZ[i]);
  const slowAhead = Math.hypot(gd.camLookX - gd.carX[i], gd.camLookZ - gd.carZ[i]);

  gd.carSpeedF[i] = 30; gd.carVZ[i] = 30;
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  const fastD = Math.hypot(gd.camX - gd.carX[i], gd.camZ - gd.carZ[i]);
  const fastAhead = Math.hypot(gd.camLookX - gd.carX[i], gd.camLookZ - gd.carZ[i]);

  assert.ok(Math.abs(slowD - b.camCarDist) < 0.3, `resting chase distance ${slowD.toFixed(2)}`);
  assert.ok(fastD > slowD + 1.5, `only pulled back from ${slowD.toFixed(2)} to ${fastD.toFixed(2)}`);
  assert.ok(fastAhead > slowAhead + 5, `look-ahead barely moved: ${slowAhead.toFixed(2)} -> ${fastAhead.toFixed(2)}`);
  // behind the car, not in front of it
  assert.ok(gd.camZ < gd.carZ[i], 'the camera got in front of a car driving +Z');
});

test('the camera keeps the last forward while reversing', () => {
  const gd = fresh();
  const i = inCarAt(gd, 6);
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  assert.ok(gd.camZ < gd.carZ[i]);

  gd.carSpeedF[i] = -8; gd.carVZ[i] = -8;        // hard reverse: the camera must not whip round
  for (let k = 0; k < 120; k++) updateCamera(gd, b);
  assert.ok(gd.camZ < gd.carZ[i], 'the camera flipped to the front of a reversing car');
  assert.ok(gd.camFwdZ > 0.9, `remembered forward ${gd.camFwdZ}`);
});

test('the far chase mode pulls the camera further out', () => {
  const gd = fresh();
  const i = inCarAt(gd, 0);
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  const near = Math.hypot(gd.camX - gd.carX[i], gd.camZ - gd.carZ[i]);

  gd.input.camToggle = 1;
  updateCamera(gd, b);
  gd.input.camToggle = 0;
  assert.equal(gd.camMode, 1);
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  const far = Math.hypot(gd.camX - gd.carX[i], gd.camZ - gd.carZ[i]);
  assert.ok(far > near * 1.4, `far mode only went ${near.toFixed(2)} -> ${far.toFixed(2)}`);
  assert.ok(gd.camY > b.camCarHeight * 1.4, `far mode height ${gd.camY.toFixed(2)}`);
});

test('a drag orbits the camera and the orbit decays once you move', () => {
  const gd = fresh();
  const i = inCarAt(gd, 0);
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  const z0 = gd.camZ;

  gd.input.orbitDX = 120;
  updateCamera(gd, b);
  gd.input.orbitDX = 0;
  assert.ok(Math.abs(gd.camYawOffset) > 0.5, `orbit offset ${gd.camYawOffset}`);
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  assert.ok(Math.abs(gd.camZ - z0) > 1, 'the drag never moved the camera');

  gd.carSpeedF[i] = 20; gd.carVZ[i] = 20;        // moving: the orbit lets go
  for (let k = 0; k < 300; k++) updateCamera(gd, b);
  assert.ok(Math.abs(gd.camYawOffset) < 0.1, `orbit offset stuck at ${gd.camYawOffset}`);
});

test('the camera is pushed out of a building it lands inside', () => {
  const gd = fresh();
  const t = tallestCollider(gd);
  tick(gd, b);                                   // consume the snap

  gd.camX = (gd.colMinX[t] + gd.colMaxX[t]) * 0.5;
  gd.camY = 3;
  gd.camZ = (gd.colMinZ[t] + gd.colMaxZ[t]) * 0.5;
  updateCamera(gd, b);

  const insideXZ = gd.camX > gd.colMinX[t] && gd.camX < gd.colMaxX[t] &&
    gd.camZ > gd.colMinZ[t] && gd.camZ < gd.colMaxZ[t];
  assert.ok(!insideXZ || gd.camY > gd.colH[t],
    `camera still buried at ${gd.camX.toFixed(2)}, ${gd.camY.toFixed(2)}, ${gd.camZ.toFixed(2)}`);
});

test('camera shake decays and only the player car shakes it', () => {
  const gd = fresh();
  const i = inCarAt(gd, 10);
  gd.camInit = 1;
  gd.camShake = 1;
  for (let k = 0; k < 60; k++) updateCamera(gd, b);
  assert.ok(gd.camShake < 0.05, `shake hung on at ${gd.camShake}`);

  // an impact on someone else's car is not the player's problem
  gd.impTickStart = 0; gd.impCount = 1;
  gd.impCar[0] = i + 1; gd.impOther[0] = -1; gd.impStrength[0] = 20;
  updateCamera(gd, b);
  assert.ok(gd.camShake < 0.05, `shook for another car's impact: ${gd.camShake}`);

  gd.impCar[0] = i;
  updateCamera(gd, b);
  assert.ok(gd.camShake > 0.5, `no shake from the player's own 20 m/s hit: ${gd.camShake}`);
  assert.ok(gd.camShake <= 1.2 + 1e-6);
});

test('the camera follows the player back out of the car', () => {
  const gd = fresh();
  const i = inCarAt(gd, 0);
  for (let k = 0; k < 200; k++) updateCamera(gd, b);
  gd.playerMode = PLAYER_MODE.FOOT;
  gd.playerCar = -1;
  gd.playerX = gd.carX[i] + 20; gd.playerZ = gd.carZ[i];
  for (let k = 0; k < 300; k++) updateCamera(gd, b);
  const d = Math.hypot(gd.camX - gd.playerX, gd.camZ - gd.playerZ);
  assert.ok(Math.abs(d - b.camFootDist) < 0.4, `camera settled ${d.toFixed(2)} m from the player on foot`);
});
