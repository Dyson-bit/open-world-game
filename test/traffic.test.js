// Task 8 — traffic AI: lane following, car-ahead braking, intersection yield, stun on impact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, CAR_STATE, BLOCK_TYPE, IMPACT_KIND } from '../src/balance.js';
import { allocateGameData, clearEvents } from '../src/gameData.js';
import { generateCity, isOnRoad } from '../src/logic/city.js';
import { spawnCar } from '../src/logic/spawn.js';
import { updateTraffic, reactToImpacts } from '../src/logic/traffic.js';
import { integrateCars } from '../src/logic/vehicle.js';
import { resolveCollisions } from '../src/logic/collision.js';
import { startGame, tick } from '../src/logic/tick.js';

const b = balance;
const CRUISER = b.carName.indexOf('CRUISER');

// A city with no population: every test below places exactly the cars it wants.
function city(seed = 7) {
  const gd = {};
  allocateGameData(gd, b, seed);
  generateCity(gd, b);
  return gd;
}

// spawn.js's putOnLane is private; this is the same placement, so a test car starts where the
// traffic manager would have put it.
function onLane(gd, l, t, speed, type = CRUISER) {
  const dx = gd.laneDirX[l], dz = gd.laneDirZ[l];
  const x = gd.laneX0[l] + dx * t, z = gd.laneZ0[l] + dz * t;
  const i = spawnCar(gd, b, type, 0xffffff, x, z, Math.atan2(dx, dz), CAR_STATE.TRAFFIC);
  gd.carLane[i] = l;
  gd.carLaneT[i] = t;
  gd.carVX[i] = dx * speed; gd.carVZ[i] = dz * speed;
  gd.carSpeedF[i] = speed;
  return i;
}

// One fixed step of just the AI + physics (no traffic manager, no camera): these tests want the
// cars they placed and nothing else. Same order as tick(): the AI drives, the world moves, then
// the AI reacts to what it ran into.
function step(gd, n, withCollision = false) {
  for (let k = 0; k < n; k++) {
    gd.impTickStart = gd.impCount;
    updateTraffic(gd, b);
    integrateCars(gd, b);
    if (withCollision) { resolveCollisions(gd, b); reactToImpacts(gd, b); }
    gd.tick++;
    gd.time += b.dt;
  }
}

// The first lane running east (+x) out of an interior node, so there is a full grid around it.
function eastLane(gd) {
  for (let l = 0; l < gd.laneCount; l++) {
    if (gd.laneDirX[l] === 1 && gd.laneDirZ[l] === 0) {
      const n = gd.laneFrom[l];
      // interior: keep away from the edges so every turn out of laneTo exists
      if (gd.nodeX[n] > -160 && gd.nodeX[n] < 160 && gd.nodeZ[n] > -160 && gd.nodeZ[n] < 160) return l;
    }
  }
  throw new Error('no interior east lane');
}

// -------------------------------------------------------------------- steering convention

test('a target to the left gives carSteerIn > 0 and the car actually turns left', () => {
  const gd = city();
  const l = eastLane(gd);
  const i = onLane(gd, l, 10, 8);
  // Face 0.3 rad to the right of the lane: the lane point ahead is now off the car's left.
  gd.carYaw[i] = Math.atan2(gd.laneDirX[l], gd.laneDirZ[l]) - 0.3;
  const yaw0 = gd.carYaw[i];

  updateTraffic(gd, b);
  assert.ok(gd.carSteerIn[i] > 0, `steerIn should be positive (left), got ${gd.carSteerIn[i]}`);

  step(gd, 12);
  assert.ok(gd.carYaw[i] > yaw0 + 0.02, `yaw should rise (turn left): ${yaw0} -> ${gd.carYaw[i]}`);
});

// -------------------------------------------------------------------- lane acquisition

test('a TRAFFIC car with no lane acquires the nearest one and pre-chooses the next', () => {
  const gd = city();
  const l = eastLane(gd);
  const t = 12;
  const x = gd.laneX0[l] + gd.laneDirX[l] * t, z = gd.laneZ0[l] + gd.laneDirZ[l] * t;
  const i = spawnCar(gd, b, CRUISER, 0xffffff, x, z, Math.atan2(gd.laneDirX[l], gd.laneDirZ[l]), CAR_STATE.TRAFFIC);
  assert.equal(gd.carLane[i], -1);
  assert.equal(gd.carNextLane[i], -1);

  updateTraffic(gd, b);
  assert.equal(gd.carLane[i], l);
  assert.ok(Math.abs(gd.carLaneT[i] - t) < 0.5, `laneT ${gd.carLaneT[i]} should be ~${t}`);
  assert.ok(gd.carNextLane[i] >= 0, 'next lane pre-chosen');
  assert.equal(gd.laneFrom[gd.carNextLane[i]], gd.laneTo[l]);
  assert.notEqual(gd.carNextLane[i], gd.laneReverse[l]);
});

// -------------------------------------------------------------------- lane hand-off

test('a car reaching the lane end takes a lane out of that node, never a U-turn', () => {
  const gd = city();
  const l0 = eastLane(gd);
  const i = onLane(gd, l0, 2, b.carCruise[CRUISER]);

  let changed = -1;
  for (let k = 0; k < 900 && changed < 0; k++) {
    step(gd, 1);
    if (gd.carLane[i] !== l0) changed = gd.carLane[i];
  }
  assert.ok(changed >= 0, 'the car never reached the end of its lane');
  assert.equal(gd.laneFrom[changed], gd.laneTo[l0], 'next lane must start at the node we reached');
  assert.notEqual(changed, gd.laneReverse[l0], 'no U-turn');
  assert.equal(gd.carLaneT[i], 0);
});

test('lane choice is deterministic for a seed and varies between seeds', () => {
  function drive(seed) {
    const gd = city(seed);
    const l0 = eastLane(gd);
    const i = onLane(gd, l0, 2, b.carCruise[CRUISER]);
    const out = [];
    let cur = l0;
    for (let k = 0; k < 3000 && out.length < 6; k++) {
      step(gd, 1);
      if (gd.carLane[i] !== cur) { cur = gd.carLane[i]; out.push(cur); }
    }
    return out.join(',');
  }
  assert.equal(drive(7), drive(7));
  assert.notEqual(drive(7), drive(99));
});

// -------------------------------------------------------------------- corners

test('a car slows toward aiCornerSpeed when its next lane is a turn', () => {
  const gd = city();
  const l0 = eastLane(gd);
  const i = onLane(gd, l0, 2, b.carCruise[CRUISER]);
  // Force a turn: aim the car at the first non-straight lane out of the node it is heading for.
  step(gd, 1);
  const to = gd.laneTo[l0], s = gd.nodeOutStart[to], n = gd.nodeOutCount[to];
  let turn = -1;
  for (let k = 0; k < n; k++) {
    const l = gd.nodeOutLanes[s + k];
    if (l === gd.laneReverse[l0]) continue;
    if (gd.laneDirX[l] !== gd.laneDirX[l0] || gd.laneDirZ[l] !== gd.laneDirZ[l0]) { turn = l; break; }
  }
  assert.ok(turn >= 0, 'the node has a turn');
  gd.carNextLane[i] = turn;

  let slowest = Infinity;
  for (let k = 0; k < 400; k++) {
    step(gd, 1);
    if (gd.carLane[i] !== l0) break;
    gd.carNextLane[i] = turn;                 // hold the choice while it approaches
    if (gd.carSpeedF[i] < slowest) slowest = gd.carSpeedF[i];
  }
  assert.ok(slowest < b.carCruise[CRUISER] - 2,
    `should have slowed for the corner, slowest ${slowest}`);
});

// -------------------------------------------------------------------- car ahead

test('a traffic car brakes for a stopped car in its lane without hitting it', () => {
  const gd = city();
  const l = eastLane(gd);
  // A PARKED car sitting on the lane line, and a traffic car 8 m behind it.
  const dx = gd.laneDirX[l], dz = gd.laneDirZ[l];
  const stopped = spawnCar(gd, b, CRUISER, 0x222222,
    gd.laneX0[l] + dx * 22, gd.laneZ0[l] + dz * 22, Math.atan2(dx, dz), CAR_STATE.PARKED);
  gd.carHandbrake[stopped] = 1;
  const i = onLane(gd, l, 14, 5);

  let hits = 0;
  for (let k = 0; k < 300; k++) {
    step(gd, 1, true);
    for (let e = gd.impTickStart; e < gd.impCount; e++) {
      if (gd.impKind[e] === IMPACT_KIND.CAR) hits++;
    }
    clearEvents(gd);
  }
  assert.equal(hits, 0, 'must not touch the car it is following');
  assert.ok(gd.carSpeedF[i] < 1, `should have braked to a stop, speed ${gd.carSpeedF[i]}`);
  const gap = Math.hypot(gd.carX[stopped] - gd.carX[i], gd.carZ[stopped] - gd.carZ[i]);
  assert.ok(gap > b.carLen[CRUISER], `stopped clear of it, gap ${gap}`);
});

test('a traffic car at cruise stops in time for a blocked lane 25 m ahead', () => {
  const gd = city();
  const l = eastLane(gd);
  const dx = gd.laneDirX[l], dz = gd.laneDirZ[l];
  const stopped = spawnCar(gd, b, CRUISER, 0x222222,
    gd.laneX0[l] + dx * 30, gd.laneZ0[l] + dz * 30, Math.atan2(dx, dz), CAR_STATE.PARKED);
  gd.carHandbrake[stopped] = 1;
  const i = onLane(gd, l, 5, b.carCruise[CRUISER]);

  let hits = 0;
  for (let k = 0; k < 400; k++) {
    step(gd, 1, true);
    for (let e = gd.impTickStart; e < gd.impCount; e++) if (gd.impKind[e] === IMPACT_KIND.CAR) hits++;
    clearEvents(gd);
  }
  assert.equal(hits, 0);
  assert.ok(gd.carSpeedF[i] < 1, `speed ${gd.carSpeedF[i]}`);
});

test('a traffic car drives past a kerbside parked car instead of stopping dead', () => {
  const gd = city();
  const l = eastLane(gd);
  const dx = gd.laneDirX[l], dz = gd.laneDirZ[l];
  // Kerbside spots sit 5.4 m from the road centre, 1.9 m to the right of the lane line.
  const ox = -dz * 1.9, oz = dx * 1.9;
  spawnCar(gd, b, CRUISER, 0x222222,
    gd.laneX0[l] + dx * 20 + ox, gd.laneZ0[l] + dz * 20 + oz, Math.atan2(dx, dz), CAR_STATE.PARKED);
  const i = onLane(gd, l, 5, b.carCruise[CRUISER]);

  let hits = 0;
  for (let k = 0; k < 100; k++) {                // 100 ticks = ~20 m: past it, short of the corner
    step(gd, 1, true);
    for (let e = gd.impTickStart; e < gd.impCount; e++) if (gd.impKind[e] === IMPACT_KIND.CAR) hits++;
    clearEvents(gd);
  }
  assert.equal(hits, 0, 'no contact with the kerbside car');
  assert.ok(gd.carSpeedF[i] > 9, `should still be rolling, speed ${gd.carSpeedF[i]}`);
});

// -------------------------------------------------------------------- stun

test('a hard hit shakes the driver: STOPPED for a while, then it drives again', () => {
  const gd = city();
  const l = eastLane(gd);
  const i = onLane(gd, l, 10, b.carCruise[CRUISER]);

  // fake this tick's impact
  gd.impTickStart = 0;
  gd.impCount = 1;
  gd.impCar[0] = i; gd.impOther[0] = 5;
  gd.impKind[0] = IMPACT_KIND.WORLD;
  gd.impStrength[0] = b.aiStunImpact + 4;

  reactToImpacts(gd, b);
  assert.equal(gd.carState[i], CAR_STATE.STOPPED);
  assert.ok(gd.carAiTimer[i] >= b.aiStunMin && gd.carAiTimer[i] <= b.aiStunMax,
    `stun ${gd.carAiTimer[i]} in [${b.aiStunMin}, ${b.aiStunMax}]`);
  assert.equal(gd.carHandbrake[i], 1);
  clearEvents(gd);

  // it holds still for at least aiStunMin
  step(gd, Math.round(b.aiStunMin * 60) - 10);
  assert.equal(gd.carState[i], CAR_STATE.STOPPED);
  assert.ok(Math.abs(gd.carSpeedF[i]) < 0.5, `should be sitting still, ${gd.carSpeedF[i]}`);

  step(gd, Math.round((b.aiStunMax - b.aiStunMin) * 60) + 40);
  assert.equal(gd.carState[i], CAR_STATE.TRAFFIC);
  assert.ok(gd.carLane[i] >= 0, 're-acquired a lane');
  step(gd, 120);
  assert.ok(gd.carSpeedF[i] > 3, `should be moving again, ${gd.carSpeedF[i]}`);
});

test('a car-kind impact stuns the other car too', () => {
  const gd = city();
  const l = eastLane(gd);
  const i = onLane(gd, l, 10, 8);
  const j = onLane(gd, l, 40, 8);
  gd.impTickStart = 0;
  gd.impCount = 1;
  gd.impCar[0] = j; gd.impOther[0] = i;
  gd.impKind[0] = IMPACT_KIND.CAR;
  gd.impStrength[0] = b.aiStunImpact + 1;
  reactToImpacts(gd, b);
  assert.equal(gd.carState[i], CAR_STATE.STOPPED);
  assert.equal(gd.carState[j], CAR_STATE.STOPPED);
});

test('a gentle nudge does not stun', () => {
  const gd = city();
  const l = eastLane(gd);
  const i = onLane(gd, l, 10, 8);
  gd.impTickStart = 0;
  gd.impCount = 1;
  gd.impCar[0] = i; gd.impOther[0] = -1;
  gd.impKind[0] = IMPACT_KIND.WORLD;
  gd.impStrength[0] = b.aiStunImpact - 0.5;
  reactToImpacts(gd, b);
  assert.equal(gd.carState[i], CAR_STATE.TRAFFIC);
});

// -------------------------------------------------------------------- 30 second soak

// One 30 s run with the player standing in the plaza doing nothing. Returns what the soak is
// actually about: does the traffic stay on the road, stay under its cruise speed, avoid piling
// into itself, and keep moving.
function soak(seed) {
  const gd = {};
  allocateGameData(gd, b, seed);
  startGame(gd, b);

  let plaza = -1;
  for (let k = 0; k < gd.blockCount; k++) if (gd.blockType[k] === BLOCK_TYPE.PLAZA) { plaza = k; break; }
  assert.ok(plaza >= 0, 'the city has a plaza');
  gd.playerX = gd.blockX[plaza];
  gd.playerZ = gd.blockZ[plaza];

  // Two cars in contact are re-reported every tick they stay touching, and a scrape lasts half a
  // second, so raw events count one collision many times. Debounce per pair: one encounter counted
  // once, which is what "does not pile up" is actually asking about.
  const lastHit = new Map();
  const DEBOUNCE = 120;

  const r = {
    samples: 0, onRoad: 0, pairHits: 0, overSpeed: 0, worstSpeed: 0,
    stoppedSamples: 0, trafficSamples: 0, worstMoving: 1, worstMovingTick: -1,
  };

  for (let k = 0; k < 1800; k++) {
    tick(gd, b);
    for (let e = 0; e < gd.impCount; e++) {
      if (gd.impKind[e] !== IMPACT_KIND.CAR) continue;
      const a = gd.impCar[e], o = gd.impOther[e];
      if (a > o) continue;                                  // each pair collision is pushed twice
      if (gd.carState[a] !== CAR_STATE.TRAFFIC || gd.carState[o] !== CAR_STATE.TRAFFIC) continue;
      const key = a * 1000 + o;
      const prev = lastHit.get(key);
      lastHit.set(key, k);
      if (prev !== undefined && k - prev < DEBOUNCE) continue;
      r.pairHits++;
    }
    clearEvents(gd);

    if (k % 30 !== 0) continue;
    let live = 0, moving = 0;
    for (let i = 0; i < gd.carCount; i++) {
      const st = gd.carState[i];
      if (st === CAR_STATE.STOPPED) r.stoppedSamples++;
      if (st !== CAR_STATE.TRAFFIC) continue;
      live++;
      r.trafficSamples++;
      r.samples++;
      if (isOnRoad(b, gd.carX[i], gd.carZ[i])) r.onRoad++;
      const sp = Math.abs(gd.carSpeedF[i]);
      if (sp > 1) moving++;
      if (sp > r.worstSpeed) r.worstSpeed = sp;
      if (sp > b.carCruise[gd.carType[i]] + 1) r.overSpeed++;
    }
    // A jam shows up as a tick where most of the traffic is standing still, not as an average.
    if (live > 0 && moving / live < r.worstMoving) { r.worstMoving = moving / live; r.worstMovingTick = k; }
  }
  return r;
}

// Three seeds, because one city layout passing is not evidence that the AI does not pile up —
// the collision count is the sensitive number and it varies a lot with where the cars start.
test('30 s of traffic: stays on the road, stays under cruise, does not pile up or jam', () => {
  for (const seed of [7, 11, 23]) {
    const r = soak(seed);
    const at = ` (seed ${seed})`;

    assert.ok(r.samples > 1000, `should have sampled plenty of traffic, got ${r.samples}${at}`);

    const frac = r.onRoad / r.samples;
    assert.ok(frac >= 0.95, `traffic on the road ${(frac * 100).toFixed(1)}% of samples${at}`);

    assert.equal(r.overSpeed, 0,
      `no traffic car over cruise + 1 (worst ${r.worstSpeed.toFixed(2)})${at}`);

    assert.ok(r.pairHits <= 5, `traffic-on-traffic collisions ${r.pairHits} (max 5)${at}`);

    // no persistent jam: at every sampled tick most of the traffic is still rolling
    assert.ok(r.worstMoving >= 0.6,
      `only ${(r.worstMoving * 100).toFixed(1)}% of traffic moving at tick ${r.worstMovingTick}${at}`);

    // and the flow keeps moving: most cars are not sitting shaken
    assert.ok(r.stoppedSamples < r.trafficSamples * 0.25,
      `too many shaken cars: ${r.stoppedSamples} vs ${r.trafficSamples}${at}`);
  }
});

test('30 s of traffic keeps the population spread across the city', () => {
  const gd = {};
  allocateGameData(gd, b, 11);
  startGame(gd, b);
  for (let k = 0; k < 1800; k++) { tick(gd, b); clearEvents(gd); }

  // count distinct 54 m cells holding a traffic car: a jam would collapse this
  const seen = new Set();
  let n = 0;
  for (let i = 0; i < gd.carCount; i++) {
    if (gd.carState[i] !== CAR_STATE.TRAFFIC && gd.carState[i] !== CAR_STATE.STOPPED) continue;
    n++;
    seen.add(Math.round(gd.carX[i] / b.cell) * 100 + Math.round(gd.carZ[i] / b.cell));
  }
  assert.ok(n >= 30, `traffic population held up: ${n}`);
  assert.ok(seen.size >= n * 0.6, `cars spread out: ${seen.size} cells for ${n} cars`);
});
