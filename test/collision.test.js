// Task 7 — collision, impacts, knockable props. Pure Logic over gameData: cars are 2-D OBBs, the
// world is AABB colliders + circle props, and every meaningful hit becomes an impact event.
//
// The tests below drive the same three calls tick.js makes, in the same order:
//   integrateCars -> resolveCollisions -> updateProps
// resolveCollisions refreshes the car bounds itself, so tick.js does not call updateCarBounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, CAR_STATE, PROP_STATE, PROP_TYPE, IMPACT_KIND, SIDE } from '../src/balance.js';
import { allocateGameData, clearEvents } from '../src/gameData.js';
import { spawnCar } from '../src/logic/spawn.js';
import { generateCity, gridIndex } from '../src/logic/city.js';
import { integrateCars } from '../src/logic/vehicle.js';
import { updateCarBounds, resolveCollisions, pushOutCircle, pushImpact } from '../src/logic/collision.js';
import { updateProps } from '../src/logic/props.js';

const b = balance;
const CRUISER = b.carName.indexOf('CRUISER');
const BUS = b.carName.indexOf('BUS');

// ------------------------------------------------------------------ fixtures

// Nothing but the car pool: no colliders, no props, empty grids (allocateGameData zeroes them).
function empty() {
  const gd = {};
  allocateGameData(gd, b, 7);
  return gd;
}

// The real city. Props are parked in a non-STATIC state where a test wants only buildings.
function city() {
  const gd = {};
  allocateGameData(gd, b, 7);
  generateCity(gd, b);
  return gd;
}

// One static prop in an otherwise empty world, registered in its own collision-grid cell.
function withProp(type, x, z, scale) {
  const gd = empty();
  const i = gd.propCount++;
  gd.propType[i] = type;
  gd.propX[i] = x; gd.propY[i] = 0; gd.propZ[i] = z;
  gd.propYaw[i] = 0;
  gd.propScale[i] = scale === undefined ? 1 : scale;
  gd.propState[i] = PROP_STATE.STATIC;
  const c = gridIndex(b, x, z);
  gd.pGridStart[c] = 0; gd.pGridCount[c] = 1; gd.pGridItems[0] = i;
  return gd;
}

function drive(gd, i, vx, vz) {
  gd.carVX[i] = vx; gd.carVZ[i] = vz;
  const fx = Math.sin(gd.carYaw[i]), fz = Math.cos(gd.carYaw[i]);
  gd.carSpeedF[i] = vx * fx + vz * fz;
}

function speed(gd, i) { return Math.hypot(gd.carVX[i], gd.carVZ[i]); }

function steps(gd, n, clear) {
  for (let k = 0; k < n; k++) {
    gd.impTickStart = gd.impCount;
    gd.knockTickStart = gd.knockCount;
    integrateCars(gd, b);
    resolveCollisions(gd, b);
    updateProps(gd, b);
    if (clear) clearEvents(gd);
  }
}

// The tallest collider in the generated city is the plaza landmark tower.
function tallestCollider(gd) {
  let t = 0;
  for (let i = 1; i < gd.colCount; i++) if (gd.colH[i] > gd.colH[t]) t = i;
  return t;
}

function overlapsCollider(gd, car, c) {
  return gd.carMaxX[car] > gd.colMinX[c] && gd.carMinX[car] < gd.colMaxX[c] &&
         gd.carMaxZ[car] > gd.colMinZ[c] && gd.carMinZ[car] < gd.colMaxZ[c];
}

function carsOverlap(gd, i, j) {
  return gd.carMaxX[i] > gd.carMinX[j] && gd.carMinX[i] < gd.carMaxX[j] &&
         gd.carMaxZ[i] > gd.carMinZ[j] && gd.carMinZ[i] < gd.carMaxZ[j];
}

// ------------------------------------------------------------------ (a) car bounds

test('(a) updateCarBounds writes 4 corners in FL, FR, RR, RL mesh-local order and a tight AABB', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x111111, 5, -3, 0, CAR_STATE.PARKED);
  updateCarBounds(gd, b);
  const hl = b.carLen[CRUISER] * 0.5, hw = b.carWid[CRUISER] * 0.5;
  // yaw 0: mesh-local +X (left) is world +X, mesh-local +Z (front) is world +Z
  const want = [
    [5 + hw, -3 + hl],   // FL
    [5 - hw, -3 + hl],   // FR
    [5 - hw, -3 - hl],   // RR
    [5 + hw, -3 - hl],   // RL
  ];
  for (let k = 0; k < 4; k++) {
    assert.ok(Math.abs(gd.carCX[i * 4 + k] - want[k][0]) < 1e-4, `corner ${k} x`);
    assert.ok(Math.abs(gd.carCZ[i * 4 + k] - want[k][1]) < 1e-4, `corner ${k} z`);
  }
  assert.ok(Math.abs(gd.carMinX[i] - (5 - hw)) < 1e-4);
  assert.ok(Math.abs(gd.carMaxX[i] - (5 + hw)) < 1e-4);
  assert.ok(Math.abs(gd.carMinZ[i] - (-3 - hl)) < 1e-4);
  assert.ok(Math.abs(gd.carMaxZ[i] - (-3 + hl)) < 1e-4);
});

test('(a2) a yawed car still gets a tight AABB around its 4 corners', () => {
  const gd = empty();
  const i = spawnCar(gd, b, BUS, 0x111111, 0, 0, 0.7, CAR_STATE.PARKED);
  updateCarBounds(gd, b);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < 4; k++) {
    const x = gd.carCX[i * 4 + k], z = gd.carCZ[i * 4 + k];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  assert.ok(Math.abs(gd.carMinX[i] - minX) < 1e-4);
  assert.ok(Math.abs(gd.carMaxX[i] - maxX) < 1e-4);
  assert.ok(Math.abs(gd.carMinZ[i] - minZ) < 1e-4);
  assert.ok(Math.abs(gd.carMaxZ[i] - maxZ) < 1e-4);
  // the corners really are the car's, not an axis-aligned box: the bus is 11 m long
  const d = Math.hypot(gd.carCX[i * 4] - gd.carCX[i * 4 + 3], gd.carCZ[i * 4] - gd.carCZ[i * 4 + 3]);
  assert.ok(Math.abs(d - b.carLen[BUS]) < 1e-3, `FL..RL edge was ${d}`);
});

// ------------------------------------------------------------------ (b) car vs building

test('(b) a car at 15 m/s into the tower stops outside it and logs a WORLD impact on its nose', () => {
  const gd = city();
  gd.propState.fill(PROP_STATE.RESTING);        // buildings only for this one
  const c = tallestCollider(gd);
  const cx = (gd.colMinX[c] + gd.colMaxX[c]) * 0.5;
  const i = spawnCar(gd, b, CRUISER, 0x222222, cx, gd.colMinZ[c] - 10, 0, CAR_STATE.PLAYER);
  drive(gd, i, 0, 15);

  steps(gd, 60);

  assert.ok(gd.impCount > 0, 'no impact was recorded');
  assert.equal(gd.impKind[0], IMPACT_KIND.WORLD, 'first impact should be a WORLD hit');
  assert.ok(gd.impStrength[0] > 8, `impact strength ${gd.impStrength[0]}, want > 8`);
  assert.ok(gd.impLocalZ[0] > 0, `impLocalZ ${gd.impLocalZ[0]} should be positive (nose)`);
  assert.ok(!overlapsCollider(gd, i, c), 'car ended up inside the tower');
  assert.equal(gd.impCar[0], i);
  // the front dent accumulator picked it up
  assert.ok(gd.carDent[i * 4 + SIDE.FRONT] > 0, 'front dent was not accumulated');
});

test('(b1) carSpeedF agrees with the velocity the collision left behind', () => {
  const gd = withProp(PROP_TYPE.TREE, 0, 6);
  const i = spawnCar(gd, b, CRUISER, 0x222222, 0, 0, 0, CAR_STATE.PLAYER);
  drive(gd, i, 0, 12);
  // stop the tick the tree bounces it, while vehicle.js's own carSpeedF is still the pre-hit 12
  for (let k = 0; k < 45; k++) {
    steps(gd, 1);
    if (gd.impCount > 0) break;
  }
  const fx = Math.sin(gd.carYaw[i]), fz = Math.cos(gd.carYaw[i]);
  const want = gd.carVX[i] * fx + gd.carVZ[i] * fz;
  assert.ok(Math.abs(gd.carSpeedF[i] - want) < 1e-4, `carSpeedF ${gd.carSpeedF[i]}, velocity says ${want}`);
  assert.ok(gd.carSpeedF[i] < 0, 'it bounced, so the forward speed should be negative');
});

test('(b2) the impact normal points from the building back at the car', () => {
  const gd = city();
  gd.propState.fill(PROP_STATE.RESTING);
  const c = tallestCollider(gd);
  const cx = (gd.colMinX[c] + gd.colMaxX[c]) * 0.5;
  const i = spawnCar(gd, b, CRUISER, 0x222222, cx, gd.colMinZ[c] - 10, 0, CAR_STATE.PLAYER);
  drive(gd, i, 0, 15);
  steps(gd, 60);
  assert.ok(gd.impCount > 0);
  // driving +Z into a face whose outward side is -Z: the normal must have a negative Z
  assert.ok(gd.impNZ[0] < -0.5, `impNZ ${gd.impNZ[0]} should point back at the car (-Z)`);
  assert.ok(Math.abs(Math.hypot(gd.impNX[0], gd.impNZ[0]) - 1) < 1e-3, 'normal is not unit length');
});

// ------------------------------------------------------------------ (c) car vs car

test('(c) two cars driven head-on separate and both log CAR impacts of the same strength', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x333333, 0, 0, 0, CAR_STATE.PLAYER);
  const j = spawnCar(gd, b, CRUISER, 0x444444, 0, 12, Math.PI, CAR_STATE.PLAYER);
  drive(gd, i, 0, 10);
  drive(gd, j, 0, -10);

  steps(gd, 40);

  assert.ok(gd.impCount >= 2, `expected two impacts, got ${gd.impCount}`);
  assert.equal(gd.impKind[0], IMPACT_KIND.CAR);
  assert.equal(gd.impKind[1], IMPACT_KIND.CAR);
  assert.equal(gd.impCar[0], i); assert.equal(gd.impOther[0], j);
  assert.equal(gd.impCar[1], j); assert.equal(gd.impOther[1], i);
  const s0 = gd.impStrength[0], s1 = gd.impStrength[1];
  assert.ok(s0 > 15, `closing speed should be near 20, got ${s0}`);
  assert.ok(Math.abs(s0 - s1) <= s0 * 0.01, `strengths ${s0} and ${s1} differ by more than 1%`);
  // both hit nose-first
  assert.ok(gd.impLocalZ[0] > 0 && gd.impLocalZ[1] > 0, 'both should be front impacts');
  assert.ok(!carsOverlap(gd, i, j), 'cars are still overlapping');
});

test('(c2) a moving car shoves a parked one out of the way', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x333333, 0, 0, 0, CAR_STATE.PLAYER);
  const p = spawnCar(gd, b, CRUISER, 0x444444, 0, 10, 0, CAR_STATE.PARKED);
  drive(gd, i, 0, 14);

  steps(gd, 40);

  assert.ok(speed(gd, p) > 0.5, `parked car speed ${speed(gd, p)}, want > 0.5`);
  assert.ok(gd.carZ[p] > 10, 'the parked car should have been pushed forward');
  assert.equal(gd.carState[p], CAR_STATE.PARKED, 'being hit does not change its state');
  assert.ok(!carsOverlap(gd, i, p));
});

test('(c3) a bus shrugs off a hatchback: the light car takes the bigger velocity change', () => {
  const gd = empty();
  const PIP = b.carName.indexOf('PIP');
  const bus = spawnCar(gd, b, BUS, 0x333333, 0, 0, 0, CAR_STATE.PLAYER);
  const pip = spawnCar(gd, b, PIP, 0x444444, 0, 14, Math.PI, CAR_STATE.PLAYER);
  drive(gd, bus, 0, 12);
  drive(gd, pip, 0, -12);
  steps(gd, 40);
  assert.ok(gd.carVZ[bus] > 5, `bus should still be rolling forward, vz ${gd.carVZ[bus]}`);
  assert.ok(gd.carVZ[pip] > 0, `the hatchback should have been knocked backwards, vz ${gd.carVZ[pip]}`);
});

test('(c4) two exactly coincident cars separate without producing a NaN', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x333333, 5, 5, 0, CAR_STATE.PLAYER);
  const j = spawnCar(gd, b, CRUISER, 0x444444, 5, 5, 0, CAR_STATE.PLAYER);
  resolveCollisions(gd, b);      // no updateCarBounds: resolveCollisions must be self-sufficient
  for (const a of [i, j]) {
    assert.ok(Number.isFinite(gd.carX[a]) && Number.isFinite(gd.carZ[a]), 'position went NaN');
    assert.ok(Number.isFinite(gd.carVX[a]) && Number.isFinite(gd.carVZ[a]), 'velocity went NaN');
    assert.ok(Number.isFinite(gd.carYawRate[a]), 'yawRate went NaN');
  }
  const d = Math.hypot(gd.carX[i] - gd.carX[j], gd.carZ[i] - gd.carZ[j]);
  assert.ok(d > 0.5, `coincident cars did not separate (distance ${d})`);
});

// ------------------------------------------------------------------ (d) car vs props

test('(d) a car at 12 m/s knocks a lamp post flying and barely slows down', () => {
  const gd = withProp(PROP_TYPE.LAMP, 0, 8);
  const i = spawnCar(gd, b, CRUISER, 0x555555, 0, 0, 0, CAR_STATE.PLAYER);
  drive(gd, i, 0, 12);

  steps(gd, 45);

  assert.equal(gd.propState[0], PROP_STATE.FLYING, 'the lamp should be flying');
  assert.equal(gd.knockCount, 1, `expected one knock event, got ${gd.knockCount}`);
  assert.equal(gd.knockProp[0], 0);
  assert.equal(gd.knockedCount, 1);
  assert.ok(speed(gd, i) > 8, `car speed ${speed(gd, i)}, want > 8`);
  // a knock is a light impact — never enough on its own to damage anything
  assert.ok(gd.impCount >= 1);
  assert.equal(gd.impKind[0], IMPACT_KIND.PROP);
  assert.ok(gd.impStrength[0] < b.damageMinImpact, `knock impact ${gd.impStrength[0]} must stay below damageMinImpact`);
});

test('(d2) a bus at 15 m/s through a lamp post loses almost nothing', () => {
  const gd = withProp(PROP_TYPE.LAMP, 0, 12);
  const i = spawnCar(gd, b, BUS, 0x555555, 0, 0, 0, CAR_STATE.PLAYER);
  drive(gd, i, 0, 15);
  steps(gd, 40);
  assert.equal(gd.propState[0], PROP_STATE.FLYING);
  assert.ok(speed(gd, i) > 14.5, `bus speed ${speed(gd, i)}, want > 14.5`);
});

test('(d3) a car into a tree stops dead and the tree stays put', () => {
  const gd = withProp(PROP_TYPE.TREE, 0, 6);
  const i = spawnCar(gd, b, CRUISER, 0x555555, 0, 0, 0, CAR_STATE.PLAYER);
  drive(gd, i, 0, 12);

  steps(gd, 45);

  assert.equal(gd.propState[0], PROP_STATE.STATIC, 'a tree is not knockable');
  assert.equal(gd.knockCount, 0);
  assert.ok(speed(gd, i) < 3, `car speed ${speed(gd, i)}, want < 3`);
  assert.ok(gd.impCount >= 1 && gd.impKind[0] === IMPACT_KIND.PROP, 'a tree hit is a PROP impact');
  assert.ok(gd.impStrength[0] > 8, `tree impact strength ${gd.impStrength[0]}`);
  // it never got past the trunk
  assert.ok(gd.carMaxZ[i] < 6, `car nose at ${gd.carMaxZ[i]} is past the tree at z = 6`);
});

test('(d4) a cone flies further than a bench for the same hit', () => {
  const run = (type) => {
    const gd = withProp(type, 0, 8);
    const i = spawnCar(gd, b, CRUISER, 0x555555, 0, 0, 0, CAR_STATE.PLAYER);
    drive(gd, i, 0, 10);
    steps(gd, 45);
    return { moved: gd.propZ[0] - 8, kept: speed(gd, i) };
  };
  const cone = run(PROP_TYPE.CONE);
  const bench = run(PROP_TYPE.BENCH);
  assert.ok(cone.moved > bench.moved, `cone moved ${cone.moved}, bench ${bench.moved}`);
  assert.ok(cone.kept > bench.kept, `a cone should cost less speed than a bench`);
});

// ------------------------------------------------------------------ (e) bounds

test('(e) a car past the world boundary is pushed back inside within 120 ticks', () => {
  const gd = empty();
  // facing -X, i.e. back toward the middle, so the spring works along the car's own axis
  const i = spawnCar(gd, b, CRUISER, 0x666666, b.worldHalf + 3, 0, -Math.PI / 2, CAR_STATE.PLAYER);
  const before = gd.impCount;
  steps(gd, 120);
  assert.ok(gd.carX[i] <= b.worldHalf, `car is still at x = ${gd.carX[i]}`);
  assert.equal(gd.impCount, before, 'the invisible boundary must never record an impact');
});

test('(e2) the boundary clamps a car that is flung far outside', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x666666, 0, b.worldHalf + 40, 0, CAR_STATE.PLAYER);
  steps(gd, 2);
  assert.ok(gd.carZ[i] <= b.worldHalf + 6.001, `car z ${gd.carZ[i]} was not clamped`);
});

// ------------------------------------------------------------------ (f) pushOutCircle

test('(f) pushOutCircle moves a point from inside a building to outside it', () => {
  const gd = city();
  const c = tallestCollider(gd);
  const cx = (gd.colMinX[c] + gd.colMaxX[c]) * 0.5;
  const cz = (gd.colMinZ[c] + gd.colMaxZ[c]) * 0.5;
  pushOutCircle(gd, b, cx, cz, b.playerRadius);
  const x = gd.scratch[0], z = gd.scratch[1];
  assert.ok(Number.isFinite(x) && Number.isFinite(z));
  const inside = x > gd.colMinX[c] && x < gd.colMaxX[c] && z > gd.colMinZ[c] && z < gd.colMaxZ[c];
  assert.ok(!inside, `point (${x}, ${z}) is still inside the collider`);
});

test('(f2) pushOutCircle leaves a point in the open street exactly where it is', () => {
  const gd = city();
  pushOutCircle(gd, b, 0, 0, b.playerRadius);
  assert.equal(gd.scratch[0], 0);
  assert.equal(gd.scratch[1], 0);
});

test('(f3) pushOutCircle pushes out of a car OBB', () => {
  const gd = empty();
  spawnCar(gd, b, BUS, 0x777777, 0, 0, 0, CAR_STATE.PARKED);
  pushOutCircle(gd, b, 0.2, 1, b.playerRadius);
  const x = gd.scratch[0], z = gd.scratch[1];
  const hw = b.carWid[BUS] * 0.5, hl = b.carLen[BUS] * 0.5;
  assert.ok(Math.abs(x) >= hw || Math.abs(z) >= hl, `point (${x}, ${z}) is still inside the bus`);
});

test('(f4) pushOutCircle pushes out of a static prop but ignores a knocked one', () => {
  const gd = withProp(PROP_TYPE.TREE, 4, 4);
  pushOutCircle(gd, b, 4.1, 4, b.playerRadius);
  const d = Math.hypot(gd.scratch[0] - 4, gd.scratch[1] - 4);
  assert.ok(d >= b.propRadius[PROP_TYPE.TREE] + b.playerRadius - 1e-4, `only pushed to ${d}`);

  gd.propState[0] = PROP_STATE.FLYING;
  pushOutCircle(gd, b, 4.1, 4, b.playerRadius);
  assert.ok(Math.abs(gd.scratch[0] - 4.1) < 1e-6, 'a flying prop should not push anything');
});

// ------------------------------------------------------------------ (g) pushImpact

test('(g) pushImpact writes the mesh-local contact point and picks the right side', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x888888, 0, 0, Math.PI / 2, CAR_STATE.PLAYER);
  // yaw pi/2: forward is +X, so the car's left flank faces +Z
  const hl = b.carLen[CRUISER] * 0.5;
  // a point 2.3 m dead ahead of the nose in world space is local (0, hl)
  pushImpact(gd, b, i, 3, hl, 0, -1, 0, 7, IMPACT_KIND.WORLD);
  assert.equal(gd.impCount, 1);
  assert.ok(Math.abs(gd.impLocalX[0]) < 1e-4, `impLocalX ${gd.impLocalX[0]}`);
  assert.ok(Math.abs(gd.impLocalZ[0] - hl) < 1e-4, `impLocalZ ${gd.impLocalZ[0]}`);
  assert.ok(Math.abs(gd.carDent[i * 4 + SIDE.FRONT] - 7 * b.dentPerStrength) < 1e-6);

  // mesh-local +X (left) is world (cos θ, -sin θ) = (0, -1) here, so the left flank faces -Z
  const hw = b.carWid[CRUISER] * 0.5;
  pushImpact(gd, b, i, 3, 0, -hw, 0, -1, 5, IMPACT_KIND.WORLD);
  assert.ok(Math.abs(gd.impLocalX[1] - hw) < 1e-4, `impLocalX ${gd.impLocalX[1]}`);
  assert.ok(Math.abs(gd.impLocalZ[1]) < 1e-4, `impLocalZ ${gd.impLocalZ[1]}`);
  assert.ok(gd.carDent[i * 4 + SIDE.LEFT] > 0, 'left dent was not accumulated');
});

test('(g1) the local contact point is clamped onto the car it dents', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x888888, 0, 0, 0, CAR_STATE.PLAYER);
  // a contact point 5 m off the nose and 3 m off the flank — the approximated midpoint of a
  // car-car pair can land there, and a dent outside the mesh is not a dent
  pushImpact(gd, b, i, 3, 3, 5, 0, -1, 9, IMPACT_KIND.CAR);
  assert.ok(Math.abs(gd.impLocalX[0]) <= b.carWid[CRUISER] * 0.5 + 1e-6, `impLocalX ${gd.impLocalX[0]}`);
  assert.ok(Math.abs(gd.impLocalZ[0]) <= b.carLen[CRUISER] * 0.5 + 1e-6, `impLocalZ ${gd.impLocalZ[0]}`);
  // the world point is untouched: sparks and sound still happen where the metal met
  assert.equal(gd.impX[0], 3);
  assert.equal(gd.impZ[0], 5);
});

test('(g2) dents saturate at 1 and statBigImpact only tracks the player car', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x888888, 0, 0, 0, CAR_STATE.PLAYER);
  const j = spawnCar(gd, b, CRUISER, 0x999999, 20, 0, 0, CAR_STATE.TRAFFIC);
  gd.playerCar = i;
  for (let k = 0; k < 40; k++) pushImpact(gd, b, i, -1, 0, 3, 0, -1, 6, IMPACT_KIND.WORLD);
  assert.equal(gd.carDent[i * 4 + SIDE.FRONT], 1);
  assert.equal(gd.statBigImpact, 6);

  gd.statBigImpact = 0;
  pushImpact(gd, b, j, -1, 20, 3, 0, -1, 9, IMPACT_KIND.WORLD);
  assert.equal(gd.statBigImpact, 0, 'another car hitting a wall is not the player being hit');
  // ...but the player being hit BY another car counts, whichever side of the pair it is
  pushImpact(gd, b, j, i, 20, 3, 0, -1, 11, IMPACT_KIND.CAR);
  assert.equal(gd.statBigImpact, 11);
});

test('(g3) impacts are dropped silently once the buffer is full', () => {
  const gd = empty();
  const i = spawnCar(gd, b, CRUISER, 0x888888, 0, 0, 0, CAR_STATE.PLAYER);
  for (let k = 0; k < b.maxImpacts + 25; k++) {
    pushImpact(gd, b, i, -1, 0, 2, 0, -1, 4, IMPACT_KIND.WORLD);
  }
  assert.equal(gd.impCount, b.maxImpacts);
});

// ------------------------------------------------------------------ (h) stability

test('(h) 30 cars with random inputs survive 600 ticks in the real city without a NaN', () => {
  const gd = city();
  for (let k = 0; k < 30; k++) {
    const x = -216 + (k % 9) * 54 + b.laneOffset;
    const z = -216 + ((k / 9) | 0) * 54;
    spawnCar(gd, b, k % b.carTypeCount, 0xaaaaaa, x, z, (k % 4) * Math.PI * 0.5, CAR_STATE.TRAFFIC);
  }
  for (let t = 0; t < 600; t++) {
    for (let i = 0; i < gd.carCount; i++) {
      gd.carThrottle[i] = gd.rand() * 2 - 0.6;
      gd.carSteerIn[i] = gd.rand() * 2 - 1;
      gd.carHandbrake[i] = gd.rand() < 0.05 ? 1 : 0;
    }
    steps(gd, 1, true);
  }
  for (let i = 0; i < gd.carCount; i++) {
    for (const a of ['carX', 'carZ', 'carYaw', 'carVX', 'carVZ', 'carYawRate', 'carSpeedF']) {
      assert.ok(Number.isFinite(gd[a][i]), `${a}[${i}] is ${gd[a][i]}`);
    }
    assert.ok(Math.abs(gd.carX[i]) <= b.worldHalf + 7, `car ${i} escaped to x ${gd.carX[i]}`);
    assert.ok(Math.abs(gd.carZ[i]) <= b.worldHalf + 7, `car ${i} escaped to z ${gd.carZ[i]}`);
  }
  for (let p = 0; p < gd.propCount; p++) {
    for (const a of ['propX', 'propY', 'propZ', 'propPitch', 'propRoll', 'propYaw']) {
      assert.ok(Number.isFinite(gd[a][p]), `${a}[${p}] is ${gd[a][p]}`);
    }
  }
  assert.ok(gd.knockedCount > 0, 'nothing at all got knocked over in 10 s of chaos');
});
