// Arcade car physics: integrate every live car from its throttle/steer/handbrake inputs.
// Logic module: imports only balance, never three, never the DOM, never Math.random.
//
// One 2-D bicycle-ish model per car, one substep at the fixed 60 Hz tick. The velocity is kept in
// world space (carVX/carVZ) so collision can push it around; every step decomposes it into the
// car's own forward/right basis, applies engine, brake, drag and grip there, then recomposes.
//
// Conventions (spec §3): forward = (sin yaw, cos yaw), right = (-fz, fx) = forward x up.
// carSteerIn > 0 steers LEFT, which raises yaw and swings the nose toward the car's left.
import { CAR_STATE } from '../balance.js';

const TWO_PI = Math.PI * 2;
const VIS_CLAMP = 0.12;      // max visual body pitch / roll, radians

export function integrateCars(gd, b) {
  const dt = b.dt;
  for (let i = 0; i < gd.carCount; i++) integrateCar(gd, b, i, dt);
}

export function integrateCar(gd, b, i, dt) {
  const T = gd.carType[i];
  const state = gd.carState[i];
  const yaw = gd.carYaw[i];
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const rx = -fz, rz = fx;
  let vx = gd.carVX[i], vz = gd.carVZ[i];
  let vF = vx * fx + vz * fz;
  let vL = vx * rx + vz * rz;

  // A parked car nobody has touched is the common case (70 of them). Nothing to integrate — let
  // the visual state settle and get out before the trigonometry above pays for itself twice.
  if (state === CAR_STATE.PARKED && vx === 0 && vz === 0 && gd.carYawRate[i] === 0) {
    const kv = dt * 6 < 1 ? dt * 6 : 1;
    gd.carVisPitch[i] -= gd.carVisPitch[i] * kv;
    gd.carVisRoll[i] -= gd.carVisRoll[i] * kv;
    const ks0 = dt * 8 < 1 ? dt * 8 : 1;
    gd.carSteer[i] -= gd.carSteer[i] * ks0;
    gd.carSpeedF[i] = 0;
    gd.carSlip[i] = 0;
    gd.carBrakeLight[i] = 0;
    return;
  }

  // A wreck has no driver: dead engine, dead steering, and it drags itself to a halt. It still
  // moves when something shoves it.
  const wrecked = state === CAR_STATE.WRECK || state === CAR_STATE.BURNING;
  const throttle = wrecked ? 0 : gd.carThrottle[i];
  const steerIn = wrecked ? 0 : gd.carSteerIn[i];
  const handbrake = wrecked ? 0 : gd.carHandbrake[i];

  const maxSpeed = b.carMaxSpeed[T];
  const accel = b.carAccel[T];
  const brake = b.carBrake[T];

  // ---- steering: less lock the faster you go, eased so the wheels have weight ----
  let sf = (vF < 0 ? -vF : vF) / maxSpeed;
  if (sf > 1) sf = 1;
  const steerTarget = steerIn * b.carSteerMax[T] * (1 - 0.6 * sf);
  const ks = dt * 8 < 1 ? dt * 8 : 1;
  const steer = gd.carSteer[i] + (steerTarget - gd.carSteer[i]) * ks;
  gd.carSteer[i] = steer;

  // ---- engine and brakes, along the car's forward axis ----
  let aF = 0;
  if (throttle > 0 && vF >= -0.5) {
    const f = (vF > 0 ? vF : 0) / maxSpeed;          // power fades to nothing at top speed
    aF = throttle * accel * (1 - f * f);
  } else if (throttle < 0 && vF > 0.5) {
    aF = throttle * brake;                            // braking while rolling forward
  } else if (throttle < 0) {
    const f = (vF < 0 ? -vF : vF) / (0.35 * maxSpeed);
    let cap = 1 - f * f;                              // reverse tops out at 35% of max speed
    if (cap < 0) cap = 0;
    aF = throttle * accel * 0.5 * cap;
  } else if (throttle > 0) {
    aF = throttle * brake;                            // braking while rolling backward
  }

  // ---- handbrake: locks the rears, kills the last creep outright ----
  if (handbrake !== 0) {
    if (vF > 0.3) aF -= brake * 0.6;
    else if (vF < -0.3) aF += brake * 0.6;
    else vF = 0;
  }

  // ---- drag (always, including wrecks) ----
  aF -= vF * b.rollingDrag + (vF > 0 ? vF * vF : -(vF * vF)) * b.quadDrag;
  if (wrecked) aF -= vF * b.wreckDrag;
  vF += aF * dt;

  // ---- lateral grip: the tyres scrub sideways velocity away, unless they let go ----
  // T7: a wreck counts as permanently drifting. Without it the non-slipping branch below SNAPS
  // yawRate to the (always zero) bicycle target, so a car spun round by a crash stopped rotating
  // the instant it was written off. Drifting instead blends yawRate toward 0, so the wreck keeps
  // turning for a second and slides on its dead tyres.
  const slipping = wrecked || handbrake !== 0 || (vL < 0 ? -vL : vL) > b.slipThreshold;
  const grip = slipping ? b.carDriftGrip[T] : b.carGrip[T];
  let keep = 1 - grip * dt;
  if (keep < 0) keep = 0;
  vL *= keep;

  // ---- yaw: bicycle model, with rotational inertia once the back steps out ----
  const yawRateTarget = (vF / b.carWheelbase[T]) * Math.tan(steer);
  let yawRate;
  if (slipping) {
    const ky = dt * 3 < 1 ? dt * 3 : 1;
    yawRate = gd.carYawRate[i];
    yawRate += (yawRateTarget - yawRate) * ky;
  } else {
    yawRate = yawRateTarget;
  }
  gd.carYawRate[i] = yawRate;
  gd.carYaw[i] = yaw + yawRate * dt;

  // ---- recompose in the OLD basis, then move: the body rotates ahead of the velocity, which is
  // exactly where the slip angle (and next tick's grip work) comes from ----
  vx = vF * fx + vL * rx;
  vz = vF * fz + vL * rz;
  gd.carVX[i] = vx;
  gd.carVZ[i] = vz;
  gd.carX[i] += vx * dt;
  gd.carZ[i] += vz * dt;

  gd.carSpeedF[i] = vF;
  gd.carSlip[i] = vL < 0 ? -vL : vL;

  // wheel spin stays wrapped so it never loses float32 precision over a long session
  let spin = gd.carWheelSpin[i] + vF * dt / b.carWheelRadius[T];
  if (spin > TWO_PI) spin -= TWO_PI;
  else if (spin < -TWO_PI) spin += TWO_PI;
  gd.carWheelSpin[i] = spin;

  gd.carBrakeLight[i] = ((throttle < 0 && vF > 0.5) || handbrake !== 0) ? 1 : (vF < -0.3 ? 2 : 0);

  // ---- visual only: the body squats under power and leans out of a corner ----
  const kv = dt * 6 < 1 ? dt * 6 : 1;
  let p = gd.carVisPitch[i];
  p += (aF * -0.012 - p) * kv;
  if (p > VIS_CLAMP) p = VIS_CLAMP; else if (p < -VIS_CLAMP) p = -VIS_CLAMP;
  gd.carVisPitch[i] = p;
  let r = gd.carVisRoll[i];
  r += (-yawRate * vF * 0.02 - r) * kv;
  if (r > VIS_CLAMP) r = VIS_CLAMP; else if (r < -VIS_CLAMP) r = -VIS_CLAMP;
  gd.carVisRoll[i] = r;
}
