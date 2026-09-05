// Task 9 — the particle pool and the skid ring buffer. Pure Logic over gameData; the Board is
// never involved. Event windows are driven by hand exactly as tick() drives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, CAR_STATE, PARTICLE, IMPACT_KIND } from '../src/balance.js';
import { allocateGameData, clearEvents } from '../src/gameData.js';
import { updateParticles, spawnParticle } from '../src/logic/particles.js';
import { pushImpact } from '../src/logic/collision.js';
import { integrateCars } from '../src/logic/vehicle.js';
import { spawnCar } from '../src/logic/spawn.js';

const b = balance;
const CRUISER = 1;
const COMET = 2;

function world() {
  const gd = {};
  allocateGameData(gd, b, 7);
  gd.playerX = 500; gd.playerZ = 500;
  return gd;
}

function beginTick(gd) {
  gd.impTickStart = gd.impCount;
  gd.expTickStart = gd.expCount;
  gd.knockTickStart = gd.knockCount;
}

function step(gd, n) {
  for (let k = 0; k < (n === undefined ? 1 : n); k++) {
    beginTick(gd);
    updateParticles(gd, b);
    clearEvents(gd);
  }
}

function countType(gd, type) {
  let n = 0;
  for (let i = 0; i < gd.pCount; i++) if (gd.pType[i] === type) n++;
  return n;
}

function boom(gd, x, z, car) {
  const k = gd.expCount++;
  gd.expX[k] = x; gd.expZ[k] = z; gd.expStrength[k] = 1; gd.expCar[k] = car;
}

test('(a) an impact throws sparks, dust, debris and glass', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  beginTick(gd);
  pushImpact(gd, b, c, -1, 0, 1.5, 0, 1, 12, IMPACT_KIND.WORLD);
  updateParticles(gd, b);
  assert.ok(gd.pCount > 10, `only ${gd.pCount} particles from a 12 m/s hit`);
  assert.ok(countType(gd, PARTICLE.SPARK) > 0, 'no sparks');
  assert.ok(countType(gd, PARTICLE.DUST) > 0, 'no dust');
  assert.ok(countType(gd, PARTICLE.DEBRIS) > 0, 'no debris from a heavy hit');
  assert.ok(countType(gd, PARTICLE.GLASS) > 0, 'no glass from a heavy hit');
  // sparks fly out along the impact normal
  let out = 0;
  for (let i = 0; i < gd.pCount; i++) if (gd.pType[i] === PARTICLE.SPARK && gd.pVZ[i] > 0) out++;
  assert.ok(out > 5, 'sparks should mostly spray along the normal');
});

test('(a1) a light scrape throws fewer particles than a heavy hit, and none below the floor', () => {
  const light = world();
  {
    const c = spawnCar(light, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
    beginTick(light);
    pushImpact(light, b, c, -1, 0, 1.5, 0, 1, 3, IMPACT_KIND.WORLD);
    updateParticles(light, b);
  }
  const heavy = world();
  {
    const c = spawnCar(heavy, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
    beginTick(heavy);
    pushImpact(heavy, b, c, -1, 0, 1.5, 0, 1, 20, IMPACT_KIND.WORLD);
    updateParticles(heavy, b);
  }
  assert.ok(light.pCount > 0, 'a scrape still sparks');
  assert.ok(heavy.pCount > light.pCount, `heavy ${heavy.pCount} vs light ${light.pCount}`);

  const bounds = world();
  {
    const c = spawnCar(bounds, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
    beginTick(bounds);
    pushImpact(bounds, b, c, -1, 0, 1.5, 0, 1, 20, IMPACT_KIND.BOUNDS);
    updateParticles(bounds, b);
    assert.equal(bounds.pCount, 0, 'the invisible world boundary must not spark');
  }
});

test('(b) a car at health 20 is on fire within a second, a healthy one is not', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  gd.carHealth[c] = 20;
  step(gd, 60);
  assert.ok(countType(gd, PARTICLE.FIRE) > 0, 'no flames on a car at health 20');
  assert.ok(countType(gd, PARTICLE.SMOKE) > 0, 'no smoke on a car at health 20');

  const ok = world();
  const c2 = spawnCar(ok, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  ok.carHealth[c2] = 100;
  step(ok, 60);
  assert.equal(ok.pCount, 0, 'an undamaged car emits nothing');
});

test('(b1) a car below smokeHealth smokes but does not burn', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  gd.carHealth[c] = 45;
  step(gd, 60);
  assert.ok(countType(gd, PARTICLE.SMOKE) > 0, 'a dinged car should smoke');
  assert.equal(countType(gd, PARTICLE.FIRE), 0, 'but not burn at health 45');
});

test('(b2) a smouldering wreck still trails smoke', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.WRECK);
  gd.carHealth[c] = 0;
  gd.carSmoulder[c] = b.wreckSmoulderTime;
  step(gd, 60);
  assert.ok(countType(gd, PARTICLE.SMOKE) > 0, 'a fresh wreck should smoulder');
  assert.equal(countType(gd, PARTICLE.FIRE), 0, 'but the flames are out');

  gd.carSmoulder[c] = 0;
  gd.pCount = 0;
  step(gd, 60);
  assert.equal(gd.pCount, 0, 'a cold wreck emits nothing');
});

test('(c) an explosion is a fireball, a smoke column, debris and one shock ring', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.WRECK);
  beginTick(gd);
  boom(gd, 0, 0, c);
  updateParticles(gd, b);
  assert.ok(gd.pCount >= 100, `only ${gd.pCount} particles in an explosion`);
  assert.equal(countType(gd, PARTICLE.SHOCK), 1, 'exactly one shock ring');
  assert.ok(countType(gd, PARTICLE.FIRE) >= 30);
  assert.ok(countType(gd, PARTICLE.SMOKE) >= 30);
  assert.ok(countType(gd, PARTICLE.DEBRIS) >= 20);
});

test('(c1) an explosion clears room for itself when the pool is nearly full', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.WRECK);
  // fill the pool with long-lived smoke and dust
  while (gd.pCount < b.maxParticles) {
    spawnParticle(gd, b, (gd.pCount & 1) ? PARTICLE.SMOKE : PARTICLE.DUST,
      0, 1, 0, 0, 0, 0, 60, 0.5, 0.5, 0.5, 0.5);
  }
  assert.equal(gd.pCount, b.maxParticles, 'the pool should be full and refuse more');
  beginTick(gd);
  boom(gd, 0, 0, c);
  updateParticles(gd, b);
  assert.equal(countType(gd, PARTICLE.SHOCK), 1, 'the shock ring must still get a slot');
  assert.ok(countType(gd, PARTICLE.FIRE) >= 30, 'and so must the fireball');
  assert.ok(gd.pCount <= b.maxParticles, 'never over the cap');
});

test('(d) particles die: the pool empties once the sources stop', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  beginTick(gd);
  boom(gd, 0, 0, c);
  pushImpact(gd, b, c, -1, 0, 1.5, 0, 1, 18, IMPACT_KIND.WORLD);
  updateParticles(gd, b);
  clearEvents(gd);
  assert.ok(gd.pCount > 100);
  step(gd, 300);                       // 5 s of nothing happening
  assert.equal(gd.pCount, 0, `${gd.pCount} particles outlived their life`);
});

test('(e) a drifting car lays dust and skid marks behind its rear wheels', () => {
  const gd = world();
  const c = spawnCar(gd, b, COMET, 0xffffff, 0, 0, 0, CAR_STATE.PLAYER);
  gd.carVX[c] = 3; gd.carVZ[c] = 12;
  gd.carSpeedF[c] = 12; gd.carSlip[c] = b.skidSlipThreshold + 2;
  for (let k = 0; k < 30; k++) {
    beginTick(gd);
    gd.carX[c] += gd.carVX[c] * b.dt;
    gd.carZ[c] += gd.carVZ[c] * b.dt;
    updateParticles(gd, b);
    clearEvents(gd);
  }
  assert.ok(gd.skidCount > 0, 'no skid segments');
  assert.ok(countType(gd, PARTICLE.DUST) > 0, 'no tyre smoke');
  assert.equal(gd.skidActive[c * 2], 1);
  assert.equal(gd.skidActive[c * 2 + 1], 1);
  // segments trail behind the car (it drove north-ish along +Z, so the marks are south of it)
  for (let s = 0; s < gd.skidCount; s++) {
    assert.ok(gd.skidZ0[s] < gd.carZ[c], 'a skid mark should be behind the car');
    assert.ok(gd.skidW[s] > 0, 'a skid mark needs a width');
  }
  // ...and stop being extended once the tyres grip again
  gd.carSlip[c] = 0;
  const before = gd.skidCount;
  step(gd, 30);
  assert.equal(gd.skidCount, before, 'no new marks once the slide stops');
  assert.equal(gd.skidActive[c * 2], 0);
  assert.ok(gd.skidAge[0] > 0, 'existing marks age');
});

test('(e1) a real handbrake turn writes skid marks', () => {
  const gd = world();
  const c = spawnCar(gd, b, COMET, 0xffffff, 0, 0, 0, CAR_STATE.PLAYER);
  gd.carVZ[c] = 22; gd.carSpeedF[c] = 22;
  gd.carThrottle[c] = 1; gd.carSteerIn[c] = 1; gd.carHandbrake[c] = 1;
  for (let k = 0; k < 60; k++) {
    beginTick(gd);
    integrateCars(gd, b);
    updateParticles(gd, b);
    clearEvents(gd);
  }
  assert.ok(gd.carSlip[c] > b.skidSlipThreshold, `slip ${gd.carSlip[c]} — the car never broke away`);
  assert.ok(gd.skidCount > 0, 'a handbrake turn left no rubber');
});

test('(e2) the skid ring buffer wraps instead of growing', () => {
  const gd = world();
  const c = spawnCar(gd, b, COMET, 0xffffff, 0, 0, 0, CAR_STATE.PLAYER);
  gd.carVX[c] = 0; gd.carVZ[c] = 30;
  gd.carSpeedF[c] = 30; gd.carSlip[c] = b.skidSlipThreshold + 4;
  for (let k = 0; k < 4000; k++) {
    beginTick(gd);
    gd.carZ[c] += gd.carVZ[c] * b.dt;
    updateParticles(gd, b);
    clearEvents(gd);
  }
  assert.equal(gd.skidCount, b.maxSkids, 'the buffer should be full, not overflowing');
  assert.ok(gd.skidHead >= 0 && gd.skidHead < b.maxSkids, `skidHead ${gd.skidHead} out of range`);
});

test('(f) driving on the grass kicks up dust', () => {
  const gd = world();
  // (0, 0) is a road crossing; the middle of a block is not.
  const c = spawnCar(gd, b, CRUISER, 0xffffff, -216 + 27, -216 + 27, 0, CAR_STATE.PLAYER);
  gd.carVZ[c] = 10; gd.carSpeedF[c] = 10;
  step(gd, 30);
  const off = countType(gd, PARTICLE.DUST);
  assert.ok(off > 0, 'no dust off-road');

  const road = world();
  const c2 = spawnCar(road, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.PLAYER);
  road.carVZ[c2] = 10; road.carSpeedF[c2] = 10;
  step(road, 30);
  assert.equal(road.pCount, 0, 'a healthy car on tarmac emits nothing');
});

test('(g) spawnParticle drops silently when the pool is full', () => {
  const gd = world();
  while (gd.pCount < b.maxParticles) {
    spawnParticle(gd, b, PARTICLE.SPARK, 0, 1, 0, 0, 0, 0, 1, 0.1, 1, 1, 1);
  }
  const i = spawnParticle(gd, b, PARTICLE.SPARK, 0, 1, 0, 0, 0, 0, 1, 0.1, 1, 1, 1);
  assert.equal(i, -1);
  assert.equal(gd.pCount, b.maxParticles);
});
