import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, PLAYER_MODE, CAR_STATE, PROP_STATE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { startGame, tick } from '../src/logic/tick.js';
import { spawnCar } from '../src/logic/spawn.js';

const b = balance;

function fresh(seed = 7) {
  const gd = {};
  allocateGameData(gd, b, seed);
  startGame(gd, b);
  return gd;
}

// A PIP parked `d` metres east of the player, holding a kerbside spot so we can watch the spot
// come free when it is stolen.
function parkNextToPlayer(gd, d = 2) {
  const i = spawnCar(gd, b, 0, b.carPaint[0], gd.playerX + d, gd.playerZ, 0, CAR_STATE.PARKED);
  const spot = 3;
  gd.carPark[i] = spot;
  gd.parkUsed[spot] = 1;
  return i;
}

function run(gd, n) { for (let k = 0; k < n; k++) tick(gd, b); }

// The tallest static collider is the landmark tower; every "inside a building" test uses it.
function tallestCollider(gd) {
  let t = -1, h = -1;
  for (let i = 0; i < gd.colCount; i++) if (gd.colH[i] > h) { h = gd.colH[i]; t = i; }
  return t;
}

// ------------------------------------------------------------------ on foot

test('holding forward walks the player the way the camera faces', () => {
  const gd = fresh();
  // T7: pushOutCircle now stops him at parked cars and street furniture too, and the pavement
  // north of the spawn has a BUS lying across it — he walks into its flank after 4 m. This test is
  // about camera-relative walking, so clear the street and let him have his one second of running.
  // (manageTraffic only ever spawns beyond respawnMinDist, so nothing comes back inside a second.)
  gd.carCount = 0;
  gd.propState.fill(PROP_STATE.RESTING);

  // the camera forward at the moment the walk starts — startGame parks it behind the player
  let cfx = gd.camLookX - gd.camX, cfz = gd.camLookZ - gd.camZ;
  const cl = Math.hypot(cfx, cfz);
  cfx /= cl; cfz /= cl;

  const x0 = gd.playerX, z0 = gd.playerZ;
  gd.input.forward = 1;
  run(gd, 60);

  const dx = gd.playerX - x0, dz = gd.playerZ - z0;
  const dist = Math.hypot(dx, dz);
  assert.ok(dist > 4, `walked only ${dist.toFixed(2)} m in one second`);
  // and it went where the camera was looking, not sideways
  assert.ok(dx * cfx + dz * cfz > 4, `moved ${dist.toFixed(2)} m but only ${(dx * cfx + dz * cfz).toFixed(2)} m forward`);
  assert.ok(gd.playerSpeed > 5, `playerSpeed ${gd.playerSpeed}`);
  assert.ok(gd.playerWalkPhase > 1, `walk phase ${gd.playerWalkPhase} never advanced`);
  assert.equal(gd.playerY, 0);
});

test('strafing left and right is camera-relative', () => {
  const gd = fresh();
  let cfx = gd.camLookX - gd.camX, cfz = gd.camLookZ - gd.camZ;
  const cl = Math.hypot(cfx, cfz);
  cfx /= cl; cfz /= cl;
  const rx = -cfz, rz = cfx;              // screen right = forward x up

  const x0 = gd.playerX, z0 = gd.playerZ;
  gd.input.right = 1;
  run(gd, 40);
  const dx = gd.playerX - x0, dz = gd.playerZ - z0;
  assert.ok(dx * rx + dz * rz > 2, 'D did not move the player to the camera\'s right');
});

test('the player is pushed out of a building he is standing inside', () => {
  const gd = fresh();
  const t = tallestCollider(gd);
  gd.playerX = (gd.colMinX[t] + gd.colMaxX[t]) * 0.5;
  gd.playerZ = (gd.colMinZ[t] + gd.colMaxZ[t]) * 0.5;
  gd.playerVX = 0; gd.playerVZ = 0;

  tick(gd, b);

  const inside = gd.playerX > gd.colMinX[t] && gd.playerX < gd.colMaxX[t] &&
    gd.playerZ > gd.colMinZ[t] && gd.playerZ < gd.colMaxZ[t];
  assert.ok(!inside, `player still inside the tower at ${gd.playerX.toFixed(2)}, ${gd.playerZ.toFixed(2)}`);
});

test('the player cannot walk into a building', () => {
  const gd = fresh();
  const t = tallestCollider(gd);
  // stand 3 m west of the tower's west face and walk east into it
  gd.playerX = gd.colMinX[t] - 3;
  gd.playerZ = (gd.colMinZ[t] + gd.colMaxZ[t]) * 0.5;
  gd.camX = gd.playerX - 6; gd.camY = 2.6; gd.camZ = gd.playerZ;
  gd.camLookX = gd.playerX; gd.camLookY = 1; gd.camLookZ = gd.playerZ;
  gd.camFree = 1;                      // hold the camera still so "forward" stays +X
  gd.input.forward = 1;
  run(gd, 120);
  assert.ok(gd.playerX <= gd.colMinX[t] - b.playerRadius + 1e-3,
    `walked to x=${gd.playerX.toFixed(2)}, wall at ${gd.colMinX[t]}`);
});

// ------------------------------------------------------------------ enter / exit

test('an action edge next to a parked car steals it', () => {
  const gd = fresh();
  const i = parkNextToPlayer(gd, 2);
  const spot = gd.carPark[i];

  tick(gd, b);                                    // let the nearest-car scan run
  assert.equal(gd.nearestCar, i, 'the parked car two metres away is not the nearest');
  assert.ok(gd.nearestCarDist <= b.playerEnterDist, `nearestCarDist ${gd.nearestCarDist}`);

  gd.input.action = 1;
  tick(gd, b);

  assert.equal(gd.playerMode, PLAYER_MODE.IN_CAR);
  assert.equal(gd.playerCar, i);
  assert.equal(gd.carState[i], CAR_STATE.PLAYER);
  assert.equal(gd.carPrevState[i], CAR_STATE.PARKED);
  assert.equal(gd.carLane[i], -1);
  assert.equal(gd.statStolen, 1);
  assert.equal(gd.evtStolenCar, i);
  assert.equal(gd.carPark[i], -1);
  assert.equal(gd.parkUsed[spot], 0, 'the kerbside spot was not freed');
});

test('an action edge out of range steals nothing', () => {
  const gd = fresh();
  gd.playerX = 200; gd.playerZ = -200;            // far from every car
  gd.input.action = 1;
  tick(gd, b);
  assert.equal(gd.playerMode, PLAYER_MODE.FOOT);
  assert.equal(gd.nearestCar, -1);
  assert.equal(gd.statStolen, 0);
});

test('holding forward drives the stolen car more than ten metres', () => {
  const gd = fresh();
  // T12: parkNextToPlayer points the car south, into the plaza block the spawn sits on, and that
  // block is now planted (planters, extra benches, lamps and a reshuffled scatter of trees) — the
  // car meets a tree 8 m in. This test is about the car actually moving under throttle, so take
  // the street furniture out of its way, exactly as the walking test above does.
  gd.propState.fill(PROP_STATE.RESTING);
  const i = parkNextToPlayer(gd, 2);
  gd.input.action = 1;
  tick(gd, b);
  const x0 = gd.carX[i], z0 = gd.carZ[i];

  gd.input.forward = 1;
  run(gd, 120);

  const moved = Math.hypot(gd.carX[i] - x0, gd.carZ[i] - z0);
  assert.ok(moved > 10, `car only moved ${moved.toFixed(2)} m in two seconds`);
  // The player rides along. updatePlayer runs before integrateCars, so his copy of the position is
  // exactly one tick of car travel behind — never more.
  const lag = Math.abs(gd.carSpeedF[i]) * b.dt + 1e-3;
  assert.ok(Math.hypot(gd.playerX - gd.carX[i], gd.playerZ - gd.carZ[i]) < lag,
    `player is ${Math.hypot(gd.playerX - gd.carX[i], gd.playerZ - gd.carZ[i]).toFixed(3)} m off the car`);
  assert.equal(gd.playerY, 0);
  assert.ok(gd.statDistance > 10, `statDistance ${gd.statDistance}`);
  assert.ok(gd.statTopSpeed > 5, `statTopSpeed ${gd.statTopSpeed}`);
});

test('holding right rotates the heading toward the car right vector', () => {
  const gd = fresh();
  const i = parkNextToPlayer(gd, 2);
  gd.input.action = 1;
  tick(gd, b);

  gd.input.forward = 1;
  run(gd, 60);                                    // get rolling: steering needs forward speed

  const yaw0 = gd.carYaw[i];
  const rx = -Math.cos(yaw0), rz = Math.sin(yaw0);  // the car's right vector, spec §3

  gd.input.right = 1;
  run(gd, 60);

  const fx = Math.sin(gd.carYaw[i]), fz = Math.cos(gd.carYaw[i]);
  assert.ok(fx * rx + fz * rz > 0.1,
    `heading did not swing right: dot ${(fx * rx + fz * rz).toFixed(3)}, yaw ${yaw0} -> ${gd.carYaw[i]}`);
});

test('lifting off the throttle brakes the engine', () => {
  const gd = fresh();
  const i = parkNextToPlayer(gd, 2);
  gd.input.action = 1;
  tick(gd, b);
  gd.input.forward = 1;
  run(gd, 90);
  const fast = gd.carSpeedF[i];
  assert.ok(fast > 5, `car never got going: ${fast}`);

  gd.input.forward = 0;
  tick(gd, b);
  assert.ok(gd.carThrottle[i] < 0, `coasting forward should hold a negative throttle, got ${gd.carThrottle[i]}`);
  run(gd, 240);
  assert.ok(gd.carSpeedF[i] < fast * 0.6, `coasted down to only ${gd.carSpeedF[i]} from ${fast}`);

  // below the dead band the engine lets go entirely rather than reversing the car
  gd.carSpeedF[i] = 0.2; gd.carVX[i] = 0; gd.carVZ[i] = 0;
  tick(gd, b);
  assert.equal(gd.carThrottle[i], 0);
});

test('an action edge in a car puts the player out at the left door', () => {
  const gd = fresh();
  const i = parkNextToPlayer(gd, 2);
  gd.input.action = 1;
  tick(gd, b);
  assert.equal(gd.playerMode, PLAYER_MODE.IN_CAR);

  gd.input.action = 1;
  tick(gd, b);

  assert.equal(gd.playerMode, PLAYER_MODE.FOOT);
  assert.equal(gd.playerCar, -1);
  assert.equal(gd.playerLastCar, i);
  assert.equal(gd.evtExitCar, i);
  assert.equal(gd.carState[i], CAR_STATE.PARKED);
  assert.equal(gd.carHandbrake[i], 1);
  assert.equal(gd.carThrottle[i], 0);
  assert.equal(gd.carSteerIn[i], 0);

  const yaw = gd.carYaw[i];
  const d = b.carWid[gd.carType[i]] * 0.5 + 0.9;
  const dx = gd.playerX - gd.carX[i], dz = gd.playerZ - gd.carZ[i];
  assert.ok(Math.abs(Math.hypot(dx, dz) - d) < 0.05, `stood ${Math.hypot(dx, dz).toFixed(3)} m out, wanted ${d}`);
  // and on the LEFT flank: world offset (cos yaw, -sin yaw)
  assert.ok(Math.abs(dx - Math.cos(yaw) * d) < 0.05, `door x offset ${dx}`);
  assert.ok(Math.abs(dz + Math.sin(yaw) * d) < 0.05, `door z offset ${dz}`);
});

test('a wrecked car keeps its state when the player gets out', () => {
  const gd = fresh();
  const i = parkNextToPlayer(gd, 2);
  gd.input.action = 1;
  tick(gd, b);
  gd.carHealth[i] = 0;
  gd.carState[i] = CAR_STATE.BURNING;
  gd.carBurnTimer[i] = b.burnTime;      // T9: a BURNING car with no timer left explodes at once
  gd.input.action = 1;
  tick(gd, b);
  assert.equal(gd.carState[i], CAR_STATE.BURNING);
  assert.equal(gd.carHandbrake[i], 0);
});

test('no car is ever left in the PLAYER state with nobody in it', () => {
  const gd = fresh();
  const i = parkNextToPlayer(gd, 2);
  gd.input.action = 1;
  tick(gd, b);
  gd.carHealth[i] = 0;                            // dead: exitCar parks it, then T9 sets it alight
  gd.input.action = 1;
  tick(gd, b);
  assert.equal(gd.playerCar, -1);
  assert.notEqual(gd.carState[i], CAR_STATE.PLAYER, 'nobody is driving it');
  // T9: updateDamage runs later in the same tick and starts the burn on the car exitCar parked.
  assert.equal(gd.carState[i], CAR_STATE.BURNING);
});

// ------------------------------------------------------------------ flung / stunned

test('a flung player lands, is stunned, then stands back up', () => {
  const gd = fresh();
  gd.playerMode = PLAYER_MODE.FLUNG;
  gd.playerY = 0.5;
  gd.playerVX = b.playerFlingSpeed; gd.playerVY = b.playerFlingUp; gd.playerVZ = 0;
  const x0 = gd.playerX;

  let landed = -1;
  for (let k = 0; k < 240 && landed < 0; k++) {
    tick(gd, b);
    if (gd.playerMode === PLAYER_MODE.STUNNED) landed = k;
  }
  assert.ok(landed > 0, 'the player never came down');
  assert.equal(gd.playerY, 0);
  assert.ok(gd.playerX - x0 > 3, `flung only ${(gd.playerX - x0).toFixed(2)} m`);
  assert.ok(gd.playerTumble > 1, `never tumbled: ${gd.playerTumble}`);
  assert.ok(Math.abs(gd.playerTimer - b.playerStunTime) < b.dt * 2, `stun timer ${gd.playerTimer}`);

  run(gd, Math.ceil(b.playerStunTime / b.dt) + 2);
  assert.equal(gd.playerMode, PLAYER_MODE.FOOT);
  assert.equal(gd.playerTimer, 0);
  assert.equal(gd.playerTumble, 0);
});
