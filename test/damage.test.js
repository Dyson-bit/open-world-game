// Task 9 — damage, burn timers, explosions, wrecks. Pure Logic over gameData: no city is
// generated, cars are spawned straight into slots and updateDamage is stepped by hand with the
// same event-window discipline tick() uses ([impTickStart, impCount) is this tick's slice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, CAR_STATE, PLAYER_MODE, PROP_STATE, PROP_TYPE, IMPACT_KIND } from '../src/balance.js';
import { allocateGameData, clearEvents } from '../src/gameData.js';
import { updateDamage } from '../src/logic/damage.js';
import { pushImpact } from '../src/logic/collision.js';
import { enterCar } from '../src/logic/player.js';
import { spawnCar } from '../src/logic/spawn.js';

const b = balance;
const CRUISER = 1;
const BURN_TICKS = Math.round(b.burnTime / b.dt);

function world() {
  const gd = {};
  allocateGameData(gd, b, 7);
  gd.playerX = 500; gd.playerZ = 500;      // out of every blast radius unless a test moves him
  return gd;
}

function beginTick(gd) {
  gd.impTickStart = gd.impCount;
  gd.expTickStart = gd.expCount;
  gd.knockTickStart = gd.knockCount;
}

// n quiet ticks: no new events, main's clearEvents after each frame.
function step(gd, n) {
  for (let k = 0; k < (n === undefined ? 1 : n); k++) {
    beginTick(gd);
    updateDamage(gd, b);
    clearEvents(gd);
  }
}

// One tick in which collision reported a hit on car c, exactly where resolveCollisions would.
function hitTick(gd, c, strength, kind) {
  beginTick(gd);
  pushImpact(gd, b, c, -1, gd.carX[c], gd.carZ[c] + 1, 0, 1, strength,
    kind === undefined ? IMPACT_KIND.WORLD : kind);
  updateDamage(gd, b);
  clearEvents(gd);
}

test('(a) an impact costs health scaled by the type fragility', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  hitTick(gd, c, 12);
  // CRUISER fragility 1.0: (12 - damageMinImpact) * damagePerMs
  assert.equal(Math.round(gd.carHealth[c] * 1000) / 1000, 100 - (12 - 3) * 4.5);
  assert.equal(gd.carState[c], CAR_STATE.TRAFFIC);
});

test('(a1) a gentle nudge below damageMinImpact costs nothing, and BOUNDS never damages', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  hitTick(gd, c, 2.5);
  assert.equal(gd.carHealth[c], 100);
  hitTick(gd, c, 20, IMPACT_KIND.BOUNDS);
  assert.equal(gd.carHealth[c], 100);
});

test('(a2) a fragile car loses more health from the same hit than a tough one', () => {
  const gd = world();
  const comet = spawnCar(gd, b, 2, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);    // fragility 1.4
  const bus = spawnCar(gd, b, 6, 0xffffff, 40, 0, 0, CAR_STATE.TRAFFIC);     // fragility 0.45
  beginTick(gd);
  pushImpact(gd, b, comet, -1, 0, 1, 0, 1, 12, IMPACT_KIND.WORLD);
  pushImpact(gd, b, bus, -1, 40, 1, 0, 1, 12, IMPACT_KIND.WORLD);
  updateDamage(gd, b);
  assert.ok(gd.carHealth[comet] < gd.carHealth[bus], 'the COMET should crumple first');
  assert.equal(Math.round(100 - gd.carHealth[bus]), Math.round((12 - 3) * 4.5 * 0.45));
});

test('(b) health reaching 0 starts the burn', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  gd.carHealth[c] = 1;
  hitTick(gd, c, 5);                   // (5-3)*4.5 = 9 damage
  assert.equal(gd.carHealth[c], 0);
  assert.equal(gd.carState[c], CAR_STATE.BURNING);
  assert.ok(Math.abs(gd.carBurnTimer[c] - b.burnTime) < 1e-4, `burnTimer ${gd.carBurnTimer[c]}`);
  assert.equal(gd.carPrevState[c], CAR_STATE.TRAFFIC);
});

test('(c) the burn ends in an explosion that wrecks, damages, knocks and flings', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.PARKED);
  const other = spawnCar(gd, b, CRUISER, 0xffffff, 4, 0, 0, CAR_STATE.TRAFFIC);
  const p = gd.propCount++;            // a lamp post 5 m the other way
  gd.propType[p] = PROP_TYPE.LAMP;
  gd.propX[p] = -5; gd.propY[p] = 0; gd.propZ[p] = 0;
  gd.propScale[p] = 1; gd.propState[p] = PROP_STATE.STATIC;

  enterCar(gd, b, c);
  assert.equal(gd.playerMode, PLAYER_MODE.IN_CAR);
  const stolen = gd.statStolen;
  gd.carHealth[c] = 1;
  hitTick(gd, c, 5);
  assert.equal(gd.carState[c], CAR_STATE.BURNING);

  step(gd, BURN_TICKS - 1);
  assert.equal(gd.carState[c], CAR_STATE.BURNING, 'should still be counting down');

  // the tick the timer runs out (float32 rounding puts it within a tick of burnTime), with this
  // tick's event window still open so the explosion event can be inspected where Logic wrote it
  let extra = 0;
  while (gd.carState[c] === CAR_STATE.BURNING && extra < 4) {
    beginTick(gd);
    updateDamage(gd, b);
    extra++;
    if (gd.carState[c] === CAR_STATE.BURNING) clearEvents(gd);
  }
  assert.ok(extra <= 2, `took ${extra} ticks past burnTime to go off`);

  assert.equal(gd.carState[c], CAR_STATE.WRECK);
  assert.equal(gd.carDirty[c], 1, 'the Board must rebuild the charred body');
  assert.ok(Math.abs(gd.carSmoulder[c] - b.wreckSmoulderTime) < 1e-4);

  assert.equal(gd.expCount, gd.expTickStart + 1, 'one explosion, in this tick\'s window');
  assert.equal(gd.expCar[gd.expTickStart], c);
  assert.equal(gd.expX[gd.expTickStart], 0);
  assert.equal(gd.expZ[gd.expTickStart], 0);
  assert.ok(gd.expStrength[gd.expTickStart] > 0);

  // the neighbour 4 m away: half the radius, so half the damage and half the impulse
  assert.ok(100 - gd.carHealth[other] >= 20, `neighbour lost ${100 - gd.carHealth[other]}`);
  const sp = Math.hypot(gd.carVX[other], gd.carVZ[other]);
  assert.ok(sp > 3, `neighbour speed ${sp}`);
  assert.ok(gd.carVX[other] > 0, 'blown away from the blast, not toward it');
  assert.ok(Math.abs(gd.carYawRate[other]) >= 2, 'and spun');

  assert.equal(gd.propState[p], PROP_STATE.FLYING, 'the lamp post went over');

  // the player: out of the car, in the air, away from the blast
  assert.equal(gd.playerCar, -1);
  assert.equal(gd.playerMode, PLAYER_MODE.FLUNG);
  assert.ok(gd.playerVY > 0, `playerVY ${gd.playerVY}`);
  assert.ok(Math.hypot(gd.playerVX, gd.playerVZ) > 1, 'flung sideways too');
  assert.ok(gd.playerY > 0, 'lifted off the pavement so gravity has somewhere to work');
  assert.equal(gd.playerTumble, 0);
  assert.equal(gd.playerLastCar, c);
  assert.equal(gd.statStolen, stolen);
  assert.equal(gd.statWrecked, 1, 'the player was driving it');
});

test('(c1) a traffic car that explodes on its own does not count as the player wrecking it', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  gd.carHealth[c] = 0;
  step(gd, BURN_TICKS + 3);
  assert.equal(gd.carState[c], CAR_STATE.WRECK);
  assert.equal(gd.statWrecked, 0);
  assert.equal(gd.playerMode, PLAYER_MODE.FOOT, 'the player was nowhere near it');
});

test('(c2) a player on foot inside explosionFlingRadius is flung, outside it is not', () => {
  const near = world();
  {
    const c = spawnCar(near, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
    near.playerX = 3; near.playerZ = 0; near.playerMode = PLAYER_MODE.FOOT;
    near.carHealth[c] = 0;
    step(near, BURN_TICKS + 3);
    assert.equal(near.playerMode, PLAYER_MODE.FLUNG);
    assert.ok(near.playerVX > 0, 'blown east, away from the car');
    assert.ok(near.playerVY > 0);
  }
  const far = world();
  {
    const c = spawnCar(far, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
    far.playerX = b.explosionFlingRadius + 2; far.playerZ = 0; far.playerMode = PLAYER_MODE.FOOT;
    far.carHealth[c] = 0;
    step(far, BURN_TICKS + 3);
    assert.equal(far.playerMode, PLAYER_MODE.FOOT);
  }
});

test('(d) a wreck smoulders for wreckSmoulderTime and then stops', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  gd.carHealth[c] = 0;
  step(gd, BURN_TICKS + 3);
  assert.equal(gd.carState[c], CAR_STATE.WRECK);
  step(gd, 60);
  assert.ok(gd.carSmoulder[c] < b.wreckSmoulderTime, 'smoulder should be burning down');
  assert.ok(gd.carSmoulder[c] > 0);
  step(gd, Math.round(b.wreckSmoulderTime * 60));
  assert.equal(gd.carSmoulder[c], 0, 'and it never goes negative');
  assert.equal(gd.carState[c], CAR_STATE.WRECK, 'a wreck stays a wreck');
});

test('(e) a wreck takes no further damage and never explodes twice', () => {
  const gd = world();
  const c = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  gd.carHealth[c] = 0;
  step(gd, BURN_TICKS + 3);
  assert.equal(gd.carState[c], CAR_STATE.WRECK);
  hitTick(gd, c, 30);
  step(gd, 240);
  assert.equal(gd.expCount, 0, 'no second explosion');
  assert.equal(gd.carState[c], CAR_STATE.WRECK);
});

test('(f) a chain reaction: the blast writes off a neighbour, which burns and explodes in turn', () => {
  const gd = world();
  const a = spawnCar(gd, b, CRUISER, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  const c2 = spawnCar(gd, b, CRUISER, 0xffffff, 2, 0, 0, CAR_STATE.TRAFFIC);
  gd.carHealth[a] = 0;
  gd.carHealth[c2] = 20;              // 8 m radius at 2 m -> 30 damage, written off
  step(gd, BURN_TICKS + 3);
  assert.equal(gd.carState[a], CAR_STATE.WRECK);
  assert.equal(gd.carHealth[c2], 0);
  assert.equal(gd.carState[c2], CAR_STATE.BURNING, 'it catches through the normal health path');
  step(gd, BURN_TICKS + 3);
  assert.equal(gd.carState[c2], CAR_STATE.WRECK);
});
