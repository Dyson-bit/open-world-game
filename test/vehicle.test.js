// Task 4 — arcade car physics. Pure Logic over gameData: one car in an empty world, driven by
// carThrottle / carSteerIn / carHandbrake, integrated at the fixed 60 Hz step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, CAR_STATE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { spawnCar } from '../src/logic/spawn.js';
import { integrateCars } from '../src/logic/vehicle.js';

const b = balance;
const CRUISER = b.carName.indexOf('CRUISER');
const COMET = b.carName.indexOf('COMET');
const BUS = b.carName.indexOf('BUS');
const PIP = b.carName.indexOf('PIP');

// One car at the origin facing +Z (yaw 0), in an otherwise empty world.
function car(type, state) {
  const gd = {};
  allocateGameData(gd, b, 7);
  const i = spawnCar(gd, b, type, 0x123456, 0, 0, 0, state === undefined ? CAR_STATE.PLAYER : state);
  assert.equal(i, 0, 'first spawn must take slot 0');
  return gd;
}

// Put the car at v m/s along its own heading (what a collision or a spawn does).
function setSpeed(gd, i, v) {
  const fx = Math.sin(gd.carYaw[i]), fz = Math.cos(gd.carYaw[i]);
  gd.carVX[i] = fx * v; gd.carVZ[i] = fz * v; gd.carSpeedF[i] = v;
}

function ticks(gd, n) { for (let k = 0; k < n; k++) integrateCars(gd, b); }
const secs = (s) => Math.round(s * 60);

// ------------------------------------------------------------------ (a) acceleration

test('(a) a CRUISER at full throttle for 4 s passes 15 m/s and stays under its top speed', () => {
  const gd = car(CRUISER);
  gd.carThrottle[0] = 1;
  ticks(gd, secs(4));
  const v = gd.carSpeedF[0];
  assert.ok(v > 15, `vF after 4 s was ${v}, want > 15`);
  assert.ok(v < b.carMaxSpeed[CRUISER], `vF after 4 s was ${v}, want < ${b.carMaxSpeed[CRUISER]}`);
  // it went forward, not backward: yaw 0 means +Z
  assert.ok(gd.carZ[0] > 20, `travelled ${gd.carZ[0]} m`);
  assert.ok(Math.abs(gd.carX[0]) < 1e-6, `drifted sideways by ${gd.carX[0]}`);
});

// ------------------------------------------------------------------ (b) top speed

test('(b) 30 s of full throttle settles within 5% of carMaxSpeed', () => {
  const gd = car(CRUISER);
  gd.carThrottle[0] = 1;
  ticks(gd, secs(30));
  const v = gd.carSpeedF[0], max = b.carMaxSpeed[CRUISER];
  assert.ok(v > max * 0.95, `top speed ${v} is more than 5% below maxSpeed ${max}`);
  assert.ok(v <= max, `top speed ${v} exceeds maxSpeed ${max}`);
});

test('(b2) every car type reaches its own top speed band, and they stay ordered', () => {
  const tops = new Float32Array(b.carTypeCount);
  for (let t = 0; t < b.carTypeCount; t++) {
    const gd = car(t);
    gd.carThrottle[0] = 1;
    ticks(gd, secs(40));
    tops[t] = gd.carSpeedF[0];
    assert.ok(tops[t] > b.carMaxSpeed[t] * 0.95, `${b.carName[t]} topped out at ${tops[t]} of ${b.carMaxSpeed[t]}`);
    assert.ok(tops[t] > b.carCruise[t], `${b.carName[t]} cannot reach its own cruise speed`);
  }
  assert.ok(tops[COMET] > tops[CRUISER], 'the COMET must out-run the CRUISER');
  assert.ok(tops[CRUISER] > tops[BUS], 'the BUS must be the slowest thing on the road');
});

// ------------------------------------------------------------------ (c) braking

test('(c) full brake from 20 m/s stops the car inside 3 s', () => {
  const gd = car(CRUISER);
  setSpeed(gd, 0, 20);
  gd.carThrottle[0] = -1;
  let stopTick = -1;
  for (let k = 0; k < secs(3); k++) {
    integrateCars(gd, b);
    if (stopTick < 0 && gd.carSpeedF[0] < 0.5) stopTick = k + 1;
  }
  assert.ok(stopTick >= 0, `still doing ${gd.carSpeedF[0]} m/s after 3 s`);
  assert.ok(stopTick / 60 < 3, `took ${stopTick / 60} s to stop`);
});

test('(c2) the handbrake stops a rolling car and pins a parked one', () => {
  const gd = car(CRUISER);
  setSpeed(gd, 0, 15);
  gd.carHandbrake[0] = 1;
  ticks(gd, secs(4));
  assert.ok(Math.abs(gd.carSpeedF[0]) < 0.5, `handbraked car still at ${gd.carSpeedF[0]} m/s`);

  const p = car(CRUISER, CAR_STATE.PARKED);
  p.carHandbrake[0] = 1;
  ticks(p, 600);
  assert.equal(p.carX[0], 0);
  assert.equal(p.carZ[0], 0);
  assert.equal(p.carSpeedF[0], 0);
});

// ------------------------------------------------------------------ (d) steering

test('(d) steerIn = +1 at 10 m/s turns left (yaw increases) and curves the path', () => {
  const gd = car(CRUISER);
  setSpeed(gd, 0, 10);
  gd.carSteerIn[0] = 1;
  const yaw0 = gd.carYaw[0];
  // five samples 0.4 s apart -> four path segments
  const sx = new Float64Array(5), sz = new Float64Array(5);
  sx[0] = gd.carX[0]; sz[0] = gd.carZ[0];
  for (let s = 1; s < 5; s++) { ticks(gd, secs(0.4)); sx[s] = gd.carX[0]; sz[s] = gd.carZ[0]; }
  const dYaw = gd.carYaw[0] - yaw0;
  assert.ok(dYaw > 0.8, `yaw only changed by ${dYaw} rad in 2 s`);
  // forward = (sin yaw, cos yaw): a growing yaw swings the nose toward +X, i.e. the car's left.
  assert.ok(gd.carX[0] > 1, `car did not move toward +X: x = ${gd.carX[0]}`);
  // the path curves, and always the same way: each segment is rotated left of the one before it.
  // Left of a in the XZ plane (y up, right = forward x up) means ax*bz - az*bx < 0.
  for (let s = 0; s < 3; s++) {
    const ax = sx[s + 1] - sx[s], az = sz[s + 1] - sz[s];
    const bx = sx[s + 2] - sx[s + 1], bz = sz[s + 2] - sz[s + 1];
    const cross = ax * bz - az * bx;
    assert.ok(cross < 0, `segment ${s} does not bend left (cross ${cross})`);
  }
  // a circle of sane radius, not a pirouette
  const radius = 10 / (dYaw / 2);
  assert.ok(radius > 3 && radius < 20, `turning radius ${radius} m at 10 m/s`);
});

test('(d2) steerIn = -1 mirrors it', () => {
  const gd = car(CRUISER);
  setSpeed(gd, 0, 10);
  gd.carSteerIn[0] = -1;
  ticks(gd, secs(2));
  assert.ok(gd.carYaw[0] < -0.8, `yaw ${gd.carYaw[0]}`);
  assert.ok(gd.carX[0] < 0, `x ${gd.carX[0]}`);
});

test('(d3) steering authority drops at speed', () => {
  const slow = car(CRUISER); setSpeed(slow, 0, 5); slow.carSteerIn[0] = 1;
  const fast = car(CRUISER); setSpeed(fast, 0, 28); fast.carSteerIn[0] = 1;
  ticks(slow, secs(0.4)); ticks(fast, secs(0.4));
  assert.ok(slow.carSteer[0] > fast.carSteer[0] * 1.5,
    `steer angle must shrink with speed: ${slow.carSteer[0]} at 5 m/s vs ${fast.carSteer[0]} at 28 m/s`);
  assert.ok(fast.carSteer[0] > 0);
  assert.ok(slow.carSteer[0] < b.carSteerMax[CRUISER] + 1e-6, 'never past the mechanical lock');
});

// ------------------------------------------------------------------ (e) handbrake drift

test('(e) handbrake plus steering breaks traction: carSlip rises and the car keeps rotating', () => {
  const gd = car(CRUISER);
  setSpeed(gd, 0, 22);
  gd.carSteerIn[0] = 1;
  gd.carHandbrake[0] = 1;
  const yaw0 = gd.carYaw[0];
  ticks(gd, secs(0.75));
  assert.ok(gd.carSlip[0] > 3, `carSlip only ${gd.carSlip[0]}`);
  assert.ok(gd.carYaw[0] - yaw0 > 0.3, `yaw changed by ${gd.carYaw[0] - yaw0}`);
  assert.equal(gd.carBrakeLight[0], 1, 'the handbrake lights the brake lamps');
  // it keeps rotating after the first moment, it does not just snap and stop
  const yaw1 = gd.carYaw[0];
  ticks(gd, secs(0.25));
  assert.ok(gd.carYaw[0] - yaw1 > 0.05, 'the slide keeps the car rotating');

  // the same lock without the handbrake stays inside the grip envelope at a sane speed
  const grip = car(CRUISER);
  setSpeed(grip, 0, 10);
  grip.carSteerIn[0] = 1;
  ticks(grip, secs(0.75));
  assert.ok(grip.carSlip[0] < b.slipThreshold,
    `a gripping corner should not break traction: slip ${grip.carSlip[0]}`);
});

// ------------------------------------------------------------------ (f) wrecks

test('(f) a WRECK coasts to a halt within 5 s and ignores its inputs', () => {
  const gd = car(CRUISER, CAR_STATE.WRECK);
  setSpeed(gd, 0, 10);
  gd.carThrottle[0] = 1;      // dead engine: must be ignored
  gd.carSteerIn[0] = 1;       // dead steering
  ticks(gd, secs(5));
  assert.ok(Math.abs(gd.carSpeedF[0]) < 1, `wreck still at ${gd.carSpeedF[0]} m/s`);
  assert.ok(Math.abs(gd.carYaw[0]) < 1e-3, `wreck steered itself to yaw ${gd.carYaw[0]}`);
  // still pushable
  gd.carVX[0] = 6; gd.carVZ[0] = 0;
  ticks(gd, 6);
  assert.ok(gd.carX[0] > 0.2, 'a wreck must still move when shoved');
});

// ------------------------------------------------------------------ (g) robustness

test('(g) 600 ticks of seeded random input leave no NaN anywhere', () => {
  const gd = {};
  allocateGameData(gd, b, 99);
  const states = [CAR_STATE.PLAYER, CAR_STATE.TRAFFIC, CAR_STATE.WRECK, CAR_STATE.BURNING, CAR_STATE.STOPPED, CAR_STATE.PARKED];
  for (let t = 0; t < b.carTypeCount; t++) {
    spawnCar(gd, b, t, 0x808080, t * 20, 0, t * 0.7, states[t % states.length]);
  }
  const fields = ['carX', 'carZ', 'carYaw', 'carVX', 'carVZ', 'carYawRate', 'carSteer',
    'carSpeedF', 'carSlip', 'carVisPitch', 'carVisRoll', 'carWheelSpin'];
  for (let k = 0; k < 600; k++) {
    for (let i = 0; i < gd.carCount; i++) {
      gd.carThrottle[i] = gd.rand() * 2 - 1;
      gd.carSteerIn[i] = gd.rand() * 2 - 1;
      gd.carHandbrake[i] = gd.rand() < 0.2 ? 1 : 0;
    }
    integrateCars(gd, b);
    for (let i = 0; i < gd.carCount; i++) {
      for (const f of fields) {
        assert.ok(Number.isFinite(gd[f][i]), `${f}[${i}] = ${gd[f][i]} at tick ${k}`);
      }
    }
  }
  for (let i = 0; i < gd.carCount; i++) {
    assert.ok(Math.abs(gd.carVisPitch[i]) <= 0.12 + 1e-6, `visPitch ${gd.carVisPitch[i]}`);
    assert.ok(Math.abs(gd.carVisRoll[i]) <= 0.12 + 1e-6, `visRoll ${gd.carVisRoll[i]}`);
    assert.ok(Math.abs(gd.carWheelSpin[i]) < 100, `wheelSpin must stay wrapped, got ${gd.carWheelSpin[i]}`);
  }
});

// ------------------------------------------------------------------ reverse, lights, visuals

test('reverse is capped near 35% of top speed', () => {
  const gd = car(CRUISER);
  gd.carThrottle[0] = -1;
  ticks(gd, secs(20));
  const v = gd.carSpeedF[0], cap = 0.35 * b.carMaxSpeed[CRUISER];
  assert.ok(v < 0, `should be reversing, vF = ${v}`);
  assert.ok(Math.abs(v) < cap + 0.5, `reverse speed ${-v} exceeds the ${cap} cap`);
  assert.ok(Math.abs(v) > cap * 0.6, `reverse speed ${-v} nowhere near the ${cap} cap`);
  assert.equal(gd.carBrakeLight[0], 2, 'reversing shows the reverse lamps');
});

test('brake lights: off while cruising, on while braking', () => {
  const gd = car(CRUISER);
  setSpeed(gd, 0, 20);
  ticks(gd, 2);
  assert.equal(gd.carBrakeLight[0], 0);
  gd.carThrottle[0] = -1;
  ticks(gd, 2);
  assert.equal(gd.carBrakeLight[0], 1);
});

test('visual pitch leans back under power and the wheels spin forward', () => {
  const gd = car(PIP);
  gd.carThrottle[0] = 1;
  ticks(gd, secs(1));
  assert.ok(gd.carVisPitch[0] < 0, `visPitch ${gd.carVisPitch[0]} should be negative under acceleration`);
  assert.ok(gd.carWheelSpin[0] !== 0, 'wheels must turn');
});

test('integrateCars touches every live car and nothing past carCount', () => {
  const gd = {};
  allocateGameData(gd, b, 5);
  spawnCar(gd, b, CRUISER, 1, 0, 0, 0, CAR_STATE.PLAYER);
  spawnCar(gd, b, COMET, 2, 50, 0, 0, CAR_STATE.TRAFFIC);
  gd.carThrottle[0] = 1; gd.carThrottle[1] = 1;
  gd.carVX[2] = 99; gd.carVZ[2] = 99;      // a dead slot beyond carCount
  ticks(gd, 10);
  assert.ok(gd.carSpeedF[0] > 0 && gd.carSpeedF[1] > 0);
  assert.equal(gd.carSpeedF[2], 0, 'a slot past carCount must not be integrated');
});
