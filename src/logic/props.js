// Dynamic props: knocked lamp posts, bins, cones fly and settle.
// Logic module: imports only balance, never three, never the DOM, never Math.random.
//
// A prop lives in one of three states (PROP_STATE). STATIC is the whole world at generation time:
// it never moves and collision.js treats it as an obstacle. The moment something hits it hard
// enough it becomes FLYING — a ballistic point with a tumble — and it is appended to gd.knockedList
// so the Board only has to rewrite the instance matrices of the handful of props that move.
// When it has stopped bouncing it becomes RESTING and eases over onto its side.
//
// Rotation convention (propsMesh.writeMatrix): Euler XYZ = Rx(pitch) * Ry(yaw) * Rz(roll), so the
// pitch rotation is applied LAST and is therefore about the WORLD X axis: +pitch tips the top of
// the prop toward +Z. Roll is about world Z: -roll tips the top toward +X. A knock splits its spin
// between the two so the prop always falls the way it was hit.
import { PROP_STATE } from '../balance.js';

const TWO_PI = Math.PI * 2;
const KNOCK_VEL = 0.8;          // fraction of the car's velocity a weightless prop would take
// Heavier street furniture takes less of the car's velocity with it: massRef/(massRef + propMass).
// A cone leaves at 0.77 of the car's speed, a bin 0.69, a bench 0.55, a lamp post 0.48, so the cone
// skitters away down the street and the bench mostly just topples where it stood. The upward kick
// below is deliberately NOT scaled — a lamp post that does not cartwheel is not worth hitting.
const KNOCK_MASS_REF = 90;
const UP_BASE = 3;              // m/s of lift even from a gentle nudge
const UP_PER_STRENGTH = 0.3;
const UP_MAX = 9;
const SPIN_BASE = 1.5;          // rad/s of tumble at zero strength
const SPIN_PER_STRENGTH = 0.15;
const SPIN_YAW = 0.35;          // yaw spin as a fraction of the tumble
const BOUNCE = -0.3;            // vertical restitution off the pavement
const GROUND_FRICTION = 0.5;    // horizontal and angular loss per ground contact
const REST_SPEED = 0.4;         // below this the prop has finished bouncing
const REST_ANGLE = 1.5;         // lying flat, radians off vertical
const REST_EASE = 6;            // per second, how fast it eases over onto its side

// ---------------------------------------------------------------- knock

// Launch prop i in the direction (vx, vz) — the velocity of whatever hit it. `strength` is the
// impact speed in m/s and drives both the lift and the tumble rate. Idempotent: a prop that has
// already left PROP_STATE.STATIC is not launched twice, so a car sitting on top of a knocked bin
// cannot spam the knock list.
export function knockProp(gd, b, i, vx, vz, strength) {
  if (gd.propState[i] !== PROP_STATE.STATIC) return;
  gd.propState[i] = PROP_STATE.FLYING;

  const k = KNOCK_VEL * KNOCK_MASS_REF / (KNOCK_MASS_REF + b.propMass[gd.propType[i]]);
  gd.propVX[i] = vx * k;
  gd.propVZ[i] = vz * k;
  let up = UP_BASE + strength * UP_PER_STRENGTH;
  if (up > UP_MAX) up = UP_MAX;
  gd.propVY[i] = up;

  // Topple away from the hit: the unit knock direction split into the pitch (world X) and roll
  // (world Z) axes. A hit straight down +Z is pure pitch, which is what lands the prop flat.
  const l = Math.sqrt(vx * vx + vz * vz);
  let fx = 0, fz = 1;
  if (l > 1e-4) { fx = vx / l; fz = vz / l; }
  const w = SPIN_BASE + strength * SPIN_PER_STRENGTH;
  gd.propAngPitch[i] = w * fz;
  gd.propAngRoll[i] = -w * fx;
  // A deterministic yaw spin (no gd.rand() here: knockProp runs inside collision resolution and
  // must not consume the world's random stream). Alternating by index is enough variety.
  gd.propAngYaw[i] = (i & 1) ? w * SPIN_YAW : -w * SPIN_YAW;

  if (gd.knockedCount < gd.knockedList.length) gd.knockedList[gd.knockedCount++] = i;
  if (gd.knockCount < b.maxKnocks) {
    const k = gd.knockCount++;
    gd.knockProp[k] = i;
    gd.knockStrength[k] = strength;
  }
}

// ---------------------------------------------------------------- per-tick

// Only the props in gd.knockedList move; everything else is scenery. Allocation-free.
export function updateProps(gd, b) {
  const dt = b.dt;
  const n = gd.knockedCount;
  if (n === 0) return;
  let ease = dt * REST_EASE;
  if (ease > 1) ease = 1;

  for (let k = 0; k < n; k++) {
    const i = gd.knockedList[k];
    const state = gd.propState[i];

    if (state === PROP_STATE.RESTING) {
      // Ease the (pitch, roll) pair to length REST_ANGLE along the ray it landed on, which keeps
      // the direction it fell in and needs no extra field to remember it.
      const p = gd.propPitch[i], r = gd.propRoll[i];
      const m = Math.sqrt(p * p + r * r);
      if (m > 1e-4) {
        const s = REST_ANGLE / m;
        gd.propPitch[i] = p + (p * s - p) * ease;
        gd.propRoll[i] = r + (r * s - r) * ease;
      }
      continue;
    }
    if (state !== PROP_STATE.FLYING) continue;

    let vy = gd.propVY[i] - b.gravity * dt;
    gd.propVY[i] = vy;
    gd.propX[i] += gd.propVX[i] * dt;
    gd.propZ[i] += gd.propVZ[i] * dt;
    let y = gd.propY[i] + vy * dt;
    gd.propPitch[i] += gd.propAngPitch[i] * dt;
    gd.propRoll[i] += gd.propAngRoll[i] * dt;
    gd.propYaw[i] += gd.propAngYaw[i] * dt;

    if (y > 0) { gd.propY[i] = y; continue; }

    // On the ground: bounce (a smaller one every time), scrub the slide and the spin.
    y = 0;
    if (vy < 0) {
      vy *= BOUNCE;
      gd.propVX[i] *= GROUND_FRICTION;
      gd.propVZ[i] *= GROUND_FRICTION;
      gd.propAngPitch[i] *= GROUND_FRICTION;
      gd.propAngRoll[i] *= GROUND_FRICTION;
      gd.propAngYaw[i] *= GROUND_FRICTION;
    }
    gd.propY[i] = y;
    gd.propVY[i] = vy;

    const vx = gd.propVX[i], vz = gd.propVZ[i];
    if (vx * vx + vy * vy + vz * vz >= REST_SPEED * REST_SPEED) continue;

    gd.propState[i] = PROP_STATE.RESTING;
    gd.propVX[i] = 0; gd.propVY[i] = 0; gd.propVZ[i] = 0;
    gd.propAngPitch[i] = 0; gd.propAngRoll[i] = 0; gd.propAngYaw[i] = 0;
    // Wrap first: several turns of tumble would otherwise ease back the long way round.
    let p = wrap(gd.propPitch[i]);
    const r = wrap(gd.propRoll[i]);
    if (p === 0 && r === 0) p = REST_ANGLE;      // it never turned at all — lay it down anyway
    gd.propPitch[i] = p;
    gd.propRoll[i] = r;
    gd.propYaw[i] = wrap(gd.propYaw[i]);
  }
}

function wrap(a) { return a - TWO_PI * Math.round(a / TWO_PI); }
