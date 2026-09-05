// Task 4 — car spawning, kerbside parking, traffic population and recycling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, CAR_STATE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { generateCity, isOnRoad } from '../src/logic/city.js';
import { spawnCar, pickType, pickPaint, placeParkedCars, placeTraffic, manageTraffic } from '../src/logic/spawn.js';
import { startGame, tick } from '../src/logic/tick.js';

const b = balance;
const CRUISER = b.carName.indexOf('CRUISER');
const CAB = b.carName.indexOf('CAB');
const BUS = b.carName.indexOf('BUS');

function world(seed = 7) {
  const gd = {};
  allocateGameData(gd, b, seed);
  generateCity(gd, b);
  return gd;
}

function bare(seed = 7) {
  const gd = {};
  allocateGameData(gd, b, seed);
  return gd;
}

function countState(gd, s) {
  let n = 0;
  for (let i = 0; i < gd.carCount; i++) if (gd.carState[i] === s) n++;
  return n;
}

// ---------------------------------------------------------------------- spawnCar

test('spawnCar fills a slot, resets it and raises the rebuild flags', () => {
  const gd = bare();
  gd.carDirty[3] = 0;
  // dirty every field of slot 0 first, so we can see the reset
  gd.carVX[0] = 9; gd.carVZ[0] = 9; gd.carYawRate[0] = 3; gd.carSteer[0] = 0.4;
  gd.carSteerIn[0] = 1; gd.carThrottle[0] = -1; gd.carHandbrake[0] = 1;
  gd.carHealth[0] = 12; gd.carBurnTimer[0] = 2; gd.carSmoulder[0] = 5;
  gd.carDent[0] = 1; gd.carDent[1] = 1; gd.carDent[2] = 1; gd.carDent[3] = 1;
  gd.carLane[0] = 17; gd.carLaneT[0] = 8; gd.carPark[0] = 4;
  gd.carVisPitch[0] = 0.1; gd.carVisRoll[0] = -0.1; gd.carWheelSpin[0] = 33;
  gd.carBrakeLight[0] = 2; gd.carSmokeAcc[0] = 4; gd.carSlip[0] = 6; gd.carSpeedF[0] = 20;

  const i = spawnCar(gd, b, CRUISER, 0xff0000, 12, -34, 1.25, CAR_STATE.TRAFFIC);
  assert.equal(i, 0);
  assert.equal(gd.carCount, 1);
  assert.equal(gd.carType[0], CRUISER);
  assert.equal(gd.carPaint[0], 0xff0000);
  assert.equal(gd.carState[0], CAR_STATE.TRAFFIC);
  assert.equal(gd.carX[0], 12);
  assert.equal(gd.carZ[0], -34);
  assert.ok(Math.abs(gd.carYaw[0] - 1.25) < 1e-6);
  assert.equal(gd.carVX[0], 0); assert.equal(gd.carVZ[0], 0);
  assert.equal(gd.carYawRate[0], 0);
  assert.equal(gd.carSteer[0], 0); assert.equal(gd.carSteerIn[0], 0);
  assert.equal(gd.carThrottle[0], 0); assert.equal(gd.carHandbrake[0], 0);
  assert.equal(gd.carSpeedF[0], 0); assert.equal(gd.carSlip[0], 0);
  assert.equal(gd.carHealth[0], 100);
  assert.equal(gd.carBurnTimer[0], 0); assert.equal(gd.carSmoulder[0], 0);
  for (let s = 0; s < 4; s++) assert.equal(gd.carDent[s], 0);
  assert.equal(gd.carLane[0], -1); assert.equal(gd.carLaneT[0], 0);
  assert.equal(gd.carPark[0], -1);
  assert.equal(gd.carVisPitch[0], 0); assert.equal(gd.carVisRoll[0], 0);
  assert.equal(gd.carWheelSpin[0], 0); assert.equal(gd.carBrakeLight[0], 0);
  assert.equal(gd.carSmokeAcc[0], 0);
  assert.equal(gd.carDirty[0], 1, 'the Board must rebuild this slot');
  assert.equal(gd.evtCarSpawned, 1);
});

test('spawnCar returns -1 when the pool is full and leaves the count alone', () => {
  const gd = bare();
  for (let i = 0; i < b.maxCars; i++) {
    assert.equal(spawnCar(gd, b, CRUISER, 1, i, 0, 0, CAR_STATE.PARKED), i);
  }
  assert.equal(gd.carCount, b.maxCars);
  assert.equal(spawnCar(gd, b, CRUISER, 1, 0, 0, 0, CAR_STATE.PARKED), -1);
  assert.equal(gd.carCount, b.maxCars);
});

// ---------------------------------------------------------------------- pickType / pickPaint

test('pickType only returns real types and honours carSpawnWeight', () => {
  const gd = bare();
  const hist = new Int32Array(b.carTypeCount);
  for (let n = 0; n < 4000; n++) {
    const t = pickType(gd, b);
    assert.ok(t >= 0 && t < b.carTypeCount, `bad type ${t}`);
    hist[t]++;
  }
  for (let t = 0; t < b.carTypeCount; t++) assert.ok(hist[t] > 0, `${b.carName[t]} never spawned`);
  // CRUISER (weight 4) must clearly beat the BUS (weight 0.6)
  assert.ok(hist[CRUISER] > hist[BUS] * 3, `cruisers ${hist[CRUISER]} vs buses ${hist[BUS]}`);
  // and the shares should be near the weights
  let total = 0;
  for (let t = 0; t < b.carTypeCount; t++) total += b.carSpawnWeight[t];
  for (let t = 0; t < b.carTypeCount; t++) {
    const want = 4000 * b.carSpawnWeight[t] / total;
    assert.ok(Math.abs(hist[t] - want) < want * 0.3 + 20, `${b.carName[t]}: ${hist[t]} vs ~${want}`);
  }
});

test('pickPaint gives cabs the taxi colour and buses a bus colour', () => {
  const gd = bare();
  for (let n = 0; n < 60; n++) {
    assert.equal(pickPaint(gd, b, CAB), b.taxiPaint);
    assert.ok(b.busPaint.includes(pickPaint(gd, b, BUS)), 'bus paint must come from busPaint');
    assert.ok(b.carPaint.includes(pickPaint(gd, b, CRUISER)), 'car paint must come from carPaint');
  }
});

// ---------------------------------------------------------------------- parked cars

test('placeParkedCars uses exactly parkedCount kerbside spots, one of them by the player spawn', () => {
  const gd = world();
  placeParkedCars(gd, b);
  assert.equal(gd.carCount, b.parkedCount);
  let used = 0;
  for (let s = 0; s < gd.parkCount; s++) used += gd.parkUsed[s];
  assert.equal(used, b.parkedCount, 'parkUsed must mark exactly the taken spots');

  let near = 0;
  const seen = new Set();
  for (let i = 0; i < gd.carCount; i++) {
    assert.equal(gd.carState[i], CAR_STATE.PARKED);
    assert.equal(gd.carHandbrake[i], 1, 'parked cars keep the handbrake on');
    assert.equal(gd.carVX[i], 0); assert.equal(gd.carVZ[i], 0);
    assert.equal(gd.carLane[i], -1);
    const s = gd.carPark[i];
    assert.ok(s >= 0 && s < gd.parkCount, `car ${i} has park spot ${s}`);
    assert.equal(gd.parkUsed[s], 1);
    assert.ok(!seen.has(s), `spot ${s} was used twice`);
    seen.add(s);
    assert.equal(gd.carX[i], gd.parkX[s]);
    assert.equal(gd.carZ[i], gd.parkZ[s]);
    assert.equal(gd.carYaw[i], gd.parkYaw[s]);
    const dx = gd.carX[i] - b.playerSpawnX, dz = gd.carZ[i] - b.playerSpawnZ;
    if (dx * dx + dz * dz <= 15 * 15) near++;
  }
  assert.ok(near >= 1, 'the player must start next to a stealable car');
  assert.equal(seen.size, b.parkedCount);
});

test('the first parked car is the spot nearest the player spawn', () => {
  const gd = world();
  let best = -1, bestD = Infinity;
  for (let s = 0; s < gd.parkCount; s++) {
    const dx = gd.parkX[s] - b.playerSpawnX, dz = gd.parkZ[s] - b.playerSpawnZ;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = s; }
  }
  placeParkedCars(gd, b);
  assert.equal(gd.carPark[0], best, 'car 0 must take the nearest spot');
  assert.ok(bestD <= 15 * 15, `nearest spot is ${Math.sqrt(bestD)} m away`);
});

// ---------------------------------------------------------------------- traffic

test('placeTraffic puts trafficCount cars on lanes, on the road, spaced out and rolling', () => {
  const gd = world();
  placeTraffic(gd, b);
  assert.equal(gd.carCount, b.trafficCount);
  for (let i = 0; i < gd.carCount; i++) {
    assert.equal(gd.carState[i], CAR_STATE.TRAFFIC);
    const l = gd.carLane[i];
    assert.ok(l >= 0 && l < gd.laneCount, `car ${i} lane ${l}`);
    const t = gd.carLaneT[i];
    assert.ok(t >= 0 && t <= gd.laneLen[l], `car ${i} laneT ${t} of ${gd.laneLen[l]}`);
    assert.ok(isOnRoad(b, gd.carX[i], gd.carZ[i]), `car ${i} at ${gd.carX[i]},${gd.carZ[i]} is off the road`);
    // sits on the lane line
    const lx = gd.laneX0[l] + gd.laneDirX[l] * t, lz = gd.laneZ0[l] + gd.laneDirZ[l] * t;
    assert.ok(Math.hypot(gd.carX[i] - lx, gd.carZ[i] - lz) < 1e-3, `car ${i} is off its lane line`);
    // faces along the lane and is already doing its cruise speed
    const fx = Math.sin(gd.carYaw[i]), fz = Math.cos(gd.carYaw[i]);
    assert.ok(Math.abs(fx - gd.laneDirX[l]) < 1e-5 && Math.abs(fz - gd.laneDirZ[l]) < 1e-5,
      `car ${i} does not face along its lane`);
    const cruise = b.carCruise[gd.carType[i]];
    assert.ok(Math.abs(Math.hypot(gd.carVX[i], gd.carVZ[i]) - cruise) < 1e-3, `car ${i} speed`);
    assert.equal(gd.carHandbrake[i], 0);
    assert.equal(gd.carPark[i], -1);
  }
  // no two cars nose to tail on the same lane
  for (let i = 0; i < gd.carCount; i++) {
    for (let j = i + 1; j < gd.carCount; j++) {
      if (gd.carLane[i] !== gd.carLane[j]) continue;
      assert.ok(Math.abs(gd.carLaneT[i] - gd.carLaneT[j]) >= 12,
        `cars ${i} and ${j} share lane ${gd.carLane[i]} only ${Math.abs(gd.carLaneT[i] - gd.carLaneT[j])} m apart`);
    }
  }
});

test('startGame populates both car populations without overflowing the pool', () => {
  const gd = bare();
  startGame(gd, b);
  assert.equal(gd.carCount, b.parkedCount + b.trafficCount);
  assert.ok(gd.carCount <= b.maxCars);
  assert.equal(countState(gd, CAR_STATE.PARKED), b.parkedCount);
  assert.equal(countState(gd, CAR_STATE.TRAFFIC), b.trafficCount);
  for (let i = 0; i < gd.carCount; i++) assert.equal(gd.carDirty[i], 1, `car ${i} must be built`);
  assert.equal(gd.evtCarSpawned, gd.carCount);
});

// ---------------------------------------------------------------------- recycling

test('manageTraffic recycles the traffic that the player drove away from', () => {
  const gd = bare();
  startGame(gd, b);
  // 400 m east of the spawn: every car in the city is now behind us
  gd.playerX = b.playerSpawnX + 400;
  gd.playerZ = b.playerSpawnZ;
  for (let k = 0; k < 60; k++) tick(gd, b);

  let checked = 0;
  for (let i = 0; i < gd.carCount; i++) {
    const s = gd.carState[i];
    if (s !== CAR_STATE.TRAFFIC && s !== CAR_STATE.STOPPED) continue;
    checked++;
    const dx = gd.carX[i] - gd.playerX, dz = gd.carZ[i] - gd.playerZ;
    const d = Math.hypot(dx, dz);
    assert.ok(d <= b.recycleDist + 60, `car ${i} is still ${d} m away`);
    const l = gd.carLane[i];
    assert.ok(l >= 0 && l < gd.laneCount, `recycled car ${i} lost its lane`);
    assert.ok(isOnRoad(b, gd.carX[i], gd.carZ[i]), `recycled car ${i} is off the road`);
    assert.equal(gd.carHealth[i], 100, `recycled car ${i} kept its damage`);
  }
  assert.equal(checked, b.trafficCount, 'the traffic population must hold');
});

test('manageTraffic only scans every 30 ticks and never touches parked cars', () => {
  const gd = bare();
  startGame(gd, b);
  // remember where the parked cars are; they must not be recycled however far we go
  const px = Float32Array.from(gd.carX.subarray(0, gd.carCount));
  const pz = Float32Array.from(gd.carZ.subarray(0, gd.carCount));
  gd.playerX = -1000; gd.playerZ = -1000;

  // a tick that is not a multiple of 30 must move nothing
  gd.tick = 7;
  const before = Float32Array.from(gd.carX.subarray(0, gd.carCount));
  manageTraffic(gd, b);
  for (let i = 0; i < gd.carCount; i++) assert.equal(gd.carX[i], before[i], `car ${i} moved on tick 7`);

  gd.tick = 30;
  manageTraffic(gd, b);
  let moved = 0;
  for (let i = 0; i < gd.carCount; i++) {
    if (gd.carState[i] === CAR_STATE.PARKED) {
      assert.equal(gd.carX[i], px[i], `parked car ${i} was recycled`);
      assert.equal(gd.carZ[i], pz[i], `parked car ${i} was recycled`);
    } else if (gd.carX[i] !== before[i]) moved++;
  }
  assert.ok(moved > 0, 'the scan must recycle the stranded traffic');
});

test('manageTraffic tops the traffic back up to trafficCount', () => {
  const gd = bare();
  startGame(gd, b);
  let removed = 0;
  for (let i = 0; i < gd.carCount && removed < 3; i++) {
    if (gd.carState[i] === CAR_STATE.TRAFFIC) { gd.carState[i] = CAR_STATE.PARKED; removed++; }
  }
  assert.equal(countState(gd, CAR_STATE.TRAFFIC), b.trafficCount - 3);
  const count0 = gd.carCount;
  for (let k = 0; k < 150; k++) tick(gd, b);
  assert.equal(countState(gd, CAR_STATE.TRAFFIC), b.trafficCount, 'traffic must refill');
  assert.equal(gd.carCount, count0 + 3, 'exactly three new slots');
  assert.ok(gd.carCount <= b.maxCars);
});

test('manageTraffic recycles distant wrecks once the pool is nearly full', () => {
  const gd = bare();
  startGame(gd, b);
  // fill the pool to within 10 of the cap with junk, then strand a wreck
  while (gd.carCount < b.maxCars - 10) spawnCar(gd, b, CRUISER, 1, 0, 0, 0, CAR_STATE.PARKED);
  const w = spawnCar(gd, b, CRUISER, 1, -400, -400, 0, CAR_STATE.WRECK);
  gd.carHealth[w] = 0;
  gd.playerX = b.playerSpawnX; gd.playerZ = b.playerSpawnZ;
  gd.tick = 30;
  manageTraffic(gd, b);
  assert.equal(gd.carState[w], CAR_STATE.TRAFFIC, 'a far wreck must come back as traffic');
  assert.equal(gd.carHealth[w], 100);
  assert.ok(gd.carLane[w] >= 0);
  assert.equal(gd.carDirty[w], 1);
  const d = Math.hypot(gd.carX[w] - gd.playerX, gd.carZ[w] - gd.playerZ);
  assert.ok(d < b.respawnMaxDist + 40, `recycled wreck landed ${d} m away`);
});

// ---------------------------------------------------------------------- determinism

test('the same seed builds the same population, a different seed does not', () => {
  const a = bare(11), c = bare(11), d = bare(12);
  startGame(a, b); startGame(c, b); startGame(d, b);
  assert.equal(a.carCount, c.carCount);
  for (let i = 0; i < a.carCount; i++) {
    assert.equal(a.carType[i], c.carType[i], `car ${i} type`);
    assert.equal(a.carPaint[i], c.carPaint[i], `car ${i} paint`);
    assert.equal(a.carX[i], c.carX[i], `car ${i} x`);
    assert.equal(a.carZ[i], c.carZ[i], `car ${i} z`);
    assert.equal(a.carLane[i], c.carLane[i], `car ${i} lane`);
    assert.equal(a.carPark[i], c.carPark[i], `car ${i} park`);
  }
  let same = 0;
  for (let i = 0; i < a.carCount; i++) if (a.carX[i] === d.carX[i] && a.carZ[i] === d.carZ[i]) same++;
  assert.ok(same < a.carCount, 'seed 12 must not reproduce seed 11');

  // and the recycling stays deterministic too
  a.playerX = 300; a.playerZ = 300; c.playerX = 300; c.playerZ = 300;
  for (let k = 0; k < 90; k++) { tick(a, b); tick(c, b); }
  for (let i = 0; i < a.carCount; i++) {
    assert.equal(a.carX[i], c.carX[i], `car ${i} diverged`);
    assert.equal(a.carState[i], c.carState[i], `car ${i} state diverged`);
  }
});
