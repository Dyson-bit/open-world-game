// Task 7 — knockable props. A lamp post that gets hit leaves PROP_STATE.STATIC, flies, tumbles,
// lands and ends up lying on its side. Pure Logic over gameData; no city needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, PROP_STATE, PROP_TYPE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { knockProp, updateProps } from '../src/logic/props.js';

const b = balance;

// One prop at the origin, upright and static. No grid: knockProp is called directly.
function oneProp(type) {
  const gd = {};
  allocateGameData(gd, b, 7);
  const i = gd.propCount++;
  gd.propType[i] = type;
  gd.propX[i] = 0; gd.propY[i] = 0; gd.propZ[i] = 0;
  gd.propYaw[i] = 0; gd.propScale[i] = 1;
  gd.propState[i] = PROP_STATE.STATIC;
  return gd;
}

const secs = (s) => Math.round(s * 60);

function run(gd, n) { for (let k = 0; k < n; k++) updateProps(gd, b); }

test('(a) knockProp launches the prop, lists it and pushes a knock event', () => {
  const gd = oneProp(PROP_TYPE.LAMP);
  knockProp(gd, b, 0, 0, 10, 12);
  assert.equal(gd.propState[0], PROP_STATE.FLYING);
  assert.equal(gd.propVX[0], 0);
  // it leaves along the hit, never faster than 0.8 of what hit it (its own mass eats the rest)
  assert.ok(gd.propVZ[0] > 0 && gd.propVZ[0] <= 8.0001, `vz ${gd.propVZ[0]}, want 0 < vz <= 8`);
  assert.ok(Math.abs(gd.propVY[0] - (3 + 12 * 0.3)) < 1e-5, `vy ${gd.propVY[0]}`);
  assert.equal(gd.knockedCount, 1);
  assert.equal(gd.knockedList[0], 0);
  assert.equal(gd.knockCount, 1);
  assert.equal(gd.knockProp[0], 0);
  assert.equal(gd.knockStrength[0], 12);
  // it is spinning
  assert.ok(Math.abs(gd.propAngPitch[0]) > 0.5, 'no tumble');
});

test('(a1) a light prop leaves faster than a heavy one from the same hit', () => {
  const launch = (type) => {
    const gd = oneProp(type);
    knockProp(gd, b, 0, 0, 10, 12);
    return gd.propVZ[0];
  };
  const cone = launch(PROP_TYPE.CONE);
  const bench = launch(PROP_TYPE.BENCH);
  const lamp = launch(PROP_TYPE.LAMP);
  assert.ok(cone > bench, `cone ${cone} should outrun bench ${bench}`);
  assert.ok(bench > lamp, `bench ${bench} should outrun lamp ${lamp}`);
  // the vertical kick is the same for all of them: everything cartwheels
  assert.ok(lamp > 0, 'even a lamp post moves');
});

test('(a2) the upward kick is capped at 9 m/s however hard the hit', () => {
  const gd = oneProp(PROP_TYPE.CONE);
  knockProp(gd, b, 0, 30, 0, 40);
  assert.equal(gd.propVY[0], 9);
});

test('(a3) knocking an already-flying prop does nothing', () => {
  const gd = oneProp(PROP_TYPE.BIN);
  knockProp(gd, b, 0, 0, 8, 8);
  const vz = gd.propVZ[0];
  knockProp(gd, b, 0, 0, 40, 40);
  assert.equal(gd.propVZ[0], vz);
  assert.equal(gd.knockedCount, 1);
  assert.equal(gd.knockCount, 1);
});

test('(b) a knocked lamp rises, lands and settles on its side within 4 s', () => {
  const gd = oneProp(PROP_TYPE.LAMP);
  knockProp(gd, b, 0, 0, 9, 12);

  let peak = 0;
  for (let k = 0; k < secs(1.2); k++) {
    updateProps(gd, b);
    if (gd.propY[0] > peak) peak = gd.propY[0];
  }
  assert.ok(peak > 0.5, `the lamp only reached ${peak} m`);

  run(gd, secs(4) - secs(1.2));

  assert.equal(gd.propState[0], PROP_STATE.RESTING, 'still not at rest after 4 s');
  assert.equal(gd.propY[0], 0, `propY ${gd.propY[0]} should be back on the ground`);
  assert.equal(gd.propVX[0], 0);
  assert.equal(gd.propVY[0], 0);
  assert.equal(gd.propVZ[0], 0);
  const pitch = Math.abs(gd.propPitch[0]);
  assert.ok(Math.abs(pitch - 1.5) < 0.15, `pitch ${gd.propPitch[0]}, want near +/-1.5`);
  // knocked toward +Z, so the topple is all pitch and no roll
  assert.ok(Math.abs(gd.propRoll[0]) < 0.05, `roll ${gd.propRoll[0]} should be ~0`);
  // it travelled downrange
  assert.ok(gd.propZ[0] > 1, `the lamp only moved ${gd.propZ[0]} m`);
});

test('(b2) a prop knocked along +X topples that way instead', () => {
  const gd = oneProp(PROP_TYPE.LAMP);
  knockProp(gd, b, 0, 9, 0, 12);
  run(gd, secs(4));
  assert.equal(gd.propState[0], PROP_STATE.RESTING);
  assert.ok(gd.propX[0] > 1, `it should have flown along +X, ended at ${gd.propX[0]}`);
  // roll is the rotation about world Z: negative roll tips the top toward +X
  assert.ok(gd.propRoll[0] < -1.3, `roll ${gd.propRoll[0]}, want near -1.5`);
  assert.ok(Math.abs(gd.propPitch[0]) < 0.05, `pitch ${gd.propPitch[0]} should be ~0`);
});

test('(c) a resting prop stays put forever', () => {
  const gd = oneProp(PROP_TYPE.CONE);
  knockProp(gd, b, 0, 0, 6, 6);
  run(gd, secs(4));
  assert.equal(gd.propState[0], PROP_STATE.RESTING);
  const x = gd.propX[0], z = gd.propZ[0], p = gd.propPitch[0];
  run(gd, secs(10));
  assert.equal(gd.propX[0], x);
  assert.equal(gd.propZ[0], z);
  assert.ok(Math.abs(gd.propPitch[0] - p) < 1e-3);
  assert.equal(gd.propState[0], PROP_STATE.RESTING);
});

test('(d) updateProps does nothing at all when nothing has been knocked', () => {
  const gd = oneProp(PROP_TYPE.LAMP);
  run(gd, 120);
  assert.equal(gd.propState[0], PROP_STATE.STATIC);
  assert.equal(gd.propY[0], 0);
  assert.equal(gd.propPitch[0], 0);
});
