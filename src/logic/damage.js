// Damage: impact damage, smoke/fire tiers, burn timers, explosions, wrecks, player fling.
// Logic module: imports only balance and sibling Logic, never three, never the DOM, never
// Math.random. Allocation-free: plain locals and index arithmetic, no objects, no closures.
//
// The life of a car is a three-state ladder and nothing ever climbs back up it:
//
//   alive  --health <= 0-->  BURNING (burnTime seconds)  --timer out-->  WRECK (smoulders, forever)
//
// Health only ever falls: an impact takes (strength - damageMinImpact) * damagePerMs, scaled by the
// type's fragility, so a COMET is written off by a hit a BUS shrugs off. The smoke and fire tiers
// (< smokeHealth, < fireHealth) are not states — particles.js reads carHealth directly.
//
// The explosion is the one place in Logic that reaches sideways into everything at once: it damages
// and shoves the cars in explosionRadius, knocks over the props in explosionKnockRadius and throws
// the player out of (or off his feet near) the blast. Everything it touches is driven by the same
// linear falloff f = 1 - d/R, so the edge of a blast is a nudge and the centre is the whole thing.
//
// Chain reactions fall out for free: a neighbour pushed to 0 health by the blast is picked up by
// the ordinary health check — this tick if it sits later in the array, next tick if earlier — and
// starts its own three-second countdown.
import { CAR_STATE, PLAYER_MODE, PROP_STATE, IMPACT_KIND } from '../balance.js';
import { knockProp } from './props.js';
import { exitCar } from './player.js';

const WRECK_VEL_KEEP = 0.3;    // the blast leaves a wreck with a fraction of its speed
const EXP_SPIN = 2;            // rad/s of yaw the blast adds to a car it catches
const KNOCK_STRENGTH = 22;     // knockProp strength at the centre of a blast (falls off with f)
const CAM_SHAKE = 1.2;         // the same cap camera.js uses for impacts
const CAM_SHAKE_RADIUS = 40;   // how far away an explosion can still be felt through the seat

export function updateDamage(gd, b) {
  const dt = b.dt;

  // ---- 1. this tick's impacts (the window tick() opened for us) ----
  for (let k = gd.impTickStart; k < gd.impCount; k++) {
    if (gd.impKind[k] === IMPACT_KIND.BOUNDS) continue;      // the soft world edge is not a wall
    const s = gd.impStrength[k];
    if (s <= b.damageMinImpact) continue;
    const c = gd.impCar[k];
    if (c < 0 || c >= gd.carCount) continue;
    if (gd.carState[c] === CAR_STATE.WRECK) continue;        // nothing left to break
    // A car-car hit gives the other car its own impact entry (collision pushes both), so there is
    // deliberately nothing here for impOther.
    let h = gd.carHealth[c] - (s - b.damageMinImpact) * b.damagePerMs * b.carFragility[gd.carType[c]];
    if (h < 0) h = 0;
    gd.carHealth[c] = h;
  }

  // ---- 2. the state ladder ----
  for (let i = 0; i < gd.carCount; i++) {
    const state = gd.carState[i];

    if (state === CAR_STATE.WRECK) {
      const sm = gd.carSmoulder[i];
      if (sm > 0) gd.carSmoulder[i] = sm > dt ? sm - dt : 0;
      continue;
    }

    if (state === CAR_STATE.BURNING) {
      const t = gd.carBurnTimer[i] - dt;
      gd.carBurnTimer[i] = t;
      if (t <= 0) explode(gd, b, i);
      continue;
    }

    if (gd.carHealth[i] <= 0) {
      // carPrevState remembers what it was doing when it died. enterCar already uses the field for
      // the same purpose, so a car the player was driving comes out of here as PLAYER — which is
      // exactly what the statWrecked rule below wants to know.
      gd.carPrevState[i] = state;
      gd.carState[i] = CAR_STATE.BURNING;
      gd.carBurnTimer[i] = b.burnTime;
    }
  }
}

// ---------------------------------------------------------------- the bang

function explode(gd, b, c) {
  const x = gd.carX[c], z = gd.carZ[c];

  // The event the Board (fireball, shock ring, debris) and the audio both read this frame.
  if (gd.expCount < b.maxExplosions) {
    const k = gd.expCount++;
    gd.expX[k] = x; gd.expZ[k] = z;
    gd.expStrength[k] = 1;
    gd.expCar[k] = c;
  }

  // Count it before the player is thrown clear — the fling clears playerCar, and the rule is
  // "what the player wrecked", i.e. he stole it, was in it, or had been in it.
  if (gd.carPrevState[c] === CAR_STATE.PLAYER || c === gd.playerCar || c === gd.playerLastCar) {
    gd.statWrecked++;
  }

  // ---- the car itself: charred, still, and in everybody's way from now on ----
  // carPrevState is deliberately left alone: it still says what this car was doing when it died,
  // which is the only record that the player is the one who wrote it off.
  gd.carState[c] = CAR_STATE.WRECK;
  gd.carHealth[c] = 0;
  gd.carBurnTimer[c] = 0;
  gd.carSmoulder[c] = b.wreckSmoulderTime;
  gd.carDirty[c] = 1;                       // the Board rebuilds the body charred and crumpled
  gd.carVX[c] *= WRECK_VEL_KEEP;
  gd.carVZ[c] *= WRECK_VEL_KEEP;
  gd.carThrottle[c] = 0;
  gd.carSteerIn[c] = 0;
  gd.carHandbrake[c] = 0;
  gd.carLane[c] = -1;
  gd.carNextLane[c] = -1;
  gd.carBrakeLight[c] = 0;
  const spot = gd.carPark[c];
  if (spot >= 0) { gd.parkUsed[spot] = 0; gd.carPark[c] = -1; }

  // ---- every other live car in the radius ----
  const R = b.explosionRadius;
  for (let i = 0; i < gd.carCount; i++) {
    if (i === c || gd.carState[i] === CAR_STATE.WRECK) continue;
    let dx = gd.carX[i] - x, dz = gd.carZ[i] - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= R) continue;
    const f = 1 - d / R;
    if (d > 1e-4) { dx /= d; dz /= d; } else { dx = Math.sin(gd.carYaw[i]); dz = Math.cos(gd.carYaw[i]); }
    let h = gd.carHealth[i] - b.explosionDamage * f;
    if (h < 0) h = 0;
    gd.carHealth[i] = h;
    gd.carVX[i] += dx * b.explosionImpulse * f;
    gd.carVZ[i] += dz * b.explosionImpulse * f;
    gd.carYawRate[i] += (i & 1) ? EXP_SPIN : -EXP_SPIN;
  }

  // ---- street furniture ----
  const KR = b.explosionKnockRadius;
  for (let p = 0; p < gd.propCount; p++) {
    if (gd.propState[p] !== PROP_STATE.STATIC) continue;
    let dx = gd.propX[p] - x, dz = gd.propZ[p] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= KR * KR) continue;
    const d = Math.sqrt(d2);
    if (d > 1e-4) { dx /= d; dz /= d; } else { dx = 0; dz = 1; }
    const f = 1 - d / KR;
    const sp = b.explosionImpulse * f;
    knockProp(gd, b, p, dx * sp, dz * sp, KNOCK_STRENGTH * f);
  }

  // ---- the player ----
  const inside = gd.playerCar === c;
  let flung = inside ? 1 : 0;
  if (!flung && gd.playerMode === PLAYER_MODE.FOOT) {
    const dx = gd.playerX - x, dz = gd.playerZ - z;
    if (dx * dx + dz * dz < b.explosionFlingRadius * b.explosionFlingRadius) flung = 1;
  }
  if (flung) {
    // Out of the car first, so the car's own bookkeeping (state, handbrake, playerLastCar) is the
    // one exitCar does rather than a second copy of it here. It leaves him at the driver's door,
    // which is also a perfectly good direction to be thrown in.
    if (inside) exitCar(gd, b);
    let dx = gd.playerX - x, dz = gd.playerZ - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-3) { dx /= d; dz /= d; } else { dx = Math.sin(gd.carYaw[c]); dz = Math.cos(gd.carYaw[c]); }
    gd.playerMode = PLAYER_MODE.FLUNG;
    gd.playerVX = dx * b.playerFlingSpeed;
    gd.playerVZ = dz * b.playerFlingSpeed;
    gd.playerVY = b.playerFlingUp;
    gd.playerY = 0.2;                       // off the pavement, so gravity has somewhere to work
    gd.playerTumble = 0;
    gd.playerCar = -1;
    gd.playerSpeed = b.playerFlingSpeed;
  }

  // Felt through the seat wherever he is. camera.js decays camShake at the top of its own update,
  // which runs later this tick, so this is at most one frame of decay away from full strength.
  const px = gd.playerX - x, pz = gd.playerZ - z;
  const pd = Math.sqrt(px * px + pz * pz);
  if (pd < CAM_SHAKE_RADIUS) {
    const s = gd.camShake + CAM_SHAKE * (1 - pd / CAM_SHAKE_RADIUS);
    gd.camShake = s > CAM_SHAKE ? CAM_SHAKE : s;
  }
}
