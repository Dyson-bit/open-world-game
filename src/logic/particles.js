// Particles and skid marks: spawn from events, integrate the pool, write the skid ring buffer.
// Logic module: imports only balance and sibling Logic, never three, never the DOM, never
// Math.random. Allocation-free: plain locals and index arithmetic, no objects, no closures.
//
// ONE pool. Every effect in the game — sparks off a wing mirror, the smoke pouring out of a dying
// engine, an explosion's fireball, the dust off a handbrake turn — is a row in the same parallel
// arrays, distinguished only by pType. Array + count with swap-remove: a dead particle is replaced
// by the last live one, so the live set is always [0, pCount) with no holes and no free list.
//
// Spawns are dropped silently when the pool is full, with one exception: an explosion is the most
// important thing that can happen on screen, so before it spawns it evicts smoke and dust (never
// sparks or debris, which are short-lived anyway) to make room for itself. Scanning from index 0
// takes the oldest survivors first, because swap-remove keeps long-lived particles drifting down.
//
// Rates are in particles per second and every one of them is a fraction of a particle per tick at
// 60 Hz, so each stream carries its remainder in a per-car accumulator (carSmokeAcc / carFireAcc /
// carDustAcc) and spawns while the accumulator is >= 1. That keeps emission frame-rate independent
// and, unlike "every N ticks", keeps a 6/s stream and a 40/s stream looking equally smooth.
//
// Conventions (spec §3): +X east, +Y up, +Z south; yaw θ has forward (sin θ, cos θ). Mesh-local is
// +X left, +Z front, so local -> world is dx = lx*cos θ + lz*sin θ, dz = -lx*sin θ + lz*cos θ.
import { PARTICLE, CAR_STATE, IMPACT_KIND } from '../balance.js';
import { isOnRoad } from './city.js';

// ---- impact debris ----
const IMPACT_SPARK_Y = 0.55;   // bumper height: where the contact point actually is
const IMPACT_DUST_Y = 0.2;
const IMPACT_DEBRIS_Y = 0.7;
const SPARK_MAX = 30;          // sparks per impact, at strength 15 and above
const SPARK_PER_STRENGTH = 2;
const SPARK_SPEED_MIN = 4;
const SPARK_SPEED_RANGE = 8;
const SPARK_SPREAD = 6;
const SPARK_UP = 3;
const DEBRIS_STRENGTH = 10;    // a hit this hard starts shedding panels and glass
const DEBRIS_COUNT = 6;
const GLASS_COUNT = 4;

// ---- per-car emitters (particles per second) ----
const SMOKE_RATE_LIGHT = 6;
const FIRE_RATE = 24;
const FIRE_LIFE = 0.45;
const SMOULDER_RATE = 3;
const DRIFT_DUST_RATE = 22;    // per rear wheel. The spec's 8 is one puff every eighth of a
                               // second per tyre, which reads as litter rather than tyre smoke.
const GRASS_DUST_RATE = 6;
// Where the plume comes out. Height is a fraction of the car's own height rather than a constant:
// a fixed 0.9 m bonnet line puts the whole fire INSIDE a 3 m bus, where the chase camera can never
// see it. Same reason the forward offset is capped — the nose of an 11 m bus is 5.5 m ahead of its
// centre and hidden behind its own roof from anywhere behind it.
const BONNET_H = 0.62;         // fraction of the car's height
const BONNET_LIFT = 0.2;
const BONNET_F = 0.55;         // fraction of the half-length, forward of the centre
const BONNET_F_MAX = 2.2;      // ...but never further forward than this
const SMOKE_RISE = 3;          // a burning car makes a column, not a puff
const SMOKE_DRAFT = 0.4;       // fraction of the car's velocity the plume leaves with
const DRIFT_MIN_SPEED = 4;
const GRASS_MIN_SPEED = 3;

// ---- explosion ----
const EXP_RESERVE = 150;       // slots an explosion clears for itself before it spawns
const EXP_FIRE = 40;
const EXP_SMOKE = 40;
const EXP_DEBRIS = 30;
const EXP_RAD_F = 0.22;        // fireball radius as a fraction of the wreck's length
const SHOCK_Y = 0.3;

// ---- skids ----
const SKID_WIDTH = 0.6;       // wider than a real contact patch: at 0.28 m a mark is four
                               // pixels of near-road-colour from the chase camera, i.e. invisible
const SKID_MIN_SEG = 0.2;      // metres of travel before a new segment is appended. Without it a
                               // 60 Hz crawl would burn the 1024-segment ring in eight seconds and
                               // a stationary wheel would append zero-length (undrawable) quads.
const SKID_INSET = 0.15;       // how far inboard of the flank the tyre sits
const SKID_REAR_F = 0.6;       // ...as a fraction of the half-length, behind the centre

// ---- integration ----
const SMOKE_GROW = 0.7;        // metres per second of radius, linear
const DUST_GROW = 0.9;
const SHOCK_GROW = 37;         // 1 m -> 14 m over the ring's 0.35 s life
const SMOKE_BUOY = 0.6;
const SMOKE_DRAG = 0.96;       // horizontal only: the plume stalls where it was made and trails
const SMOKE_DRAG_Y = 0.995;    // ...but keeps climbing, which is what makes it read as a column
const FIRE_BUOY = 1.5;
const FIRE_DRAG = 0.97;
const FIRE_SWELL = 3;          // per second, while the flame is young...
const FIRE_SHRINK = 4;         // ...and how fast it collapses once it is half spent
const DUST_BUOY = 0.3;
const DUST_DRAG = 0.94;
const SPARK_DRAG = 0.92;
const SPARK_GRAVITY = 0.5;     // fraction of particleGravity: a spark is nearly weightless
const BOUNCE = -0.35;          // debris off the pavement
const BOUNCE_FRICTION = 0.55;
const FLOOR = 0.06;            // smoke and dust never sink into the road

// ---------------------------------------------------------------- the pool

// Append one particle. Returns its index, or -1 when the pool is full (the caller never cares:
// dropping the 4001st spark is invisible and checking for it everywhere is not).
export function spawnParticle(gd, b, type, x, y, z, vx, vy, vz, life, size, r, g, bl) {
  if (gd.pCount >= b.maxParticles) return -1;
  const i = gd.pCount++;
  gd.pX[i] = x; gd.pY[i] = y; gd.pZ[i] = z;
  gd.pVX[i] = vx; gd.pVY[i] = vy; gd.pVZ[i] = vz;
  gd.pLife[i] = life; gd.pMaxLife[i] = life;
  gd.pSize[i] = size;
  gd.pType[i] = type;
  gd.pR[i] = r; gd.pG[i] = g; gd.pB[i] = bl;
  return i;
}

function removeParticle(gd, i) {
  const last = --gd.pCount;
  if (i === last) return;
  gd.pX[i] = gd.pX[last]; gd.pY[i] = gd.pY[last]; gd.pZ[i] = gd.pZ[last];
  gd.pVX[i] = gd.pVX[last]; gd.pVY[i] = gd.pVY[last]; gd.pVZ[i] = gd.pVZ[last];
  gd.pLife[i] = gd.pLife[last]; gd.pMaxLife[i] = gd.pMaxLife[last];
  gd.pSize[i] = gd.pSize[last];
  gd.pType[i] = gd.pType[last];
  gd.pR[i] = gd.pR[last]; gd.pG[i] = gd.pG[last]; gd.pB[i] = gd.pB[last];
}

// Make room for n particles by evicting smoke and dust, oldest first. Anything else in the pool
// (sparks, debris, glass, a shock ring) is left alone: it is either short-lived or load-bearing.
function reserve(gd, b, n) {
  if (b.maxParticles - gd.pCount >= n) return;
  let killed = 0, i = 0;
  while (i < gd.pCount && killed < n) {
    const t = gd.pType[i];
    if (t === PARTICLE.SMOKE || t === PARTICLE.DUST) { removeParticle(gd, i); killed++; }
    else i++;
  }
}

// ---------------------------------------------------------------- per tick

export function updateParticles(gd, b) {
  spawnFromImpacts(gd, b);
  spawnFromCars(gd, b);
  spawnFromExplosions(gd, b);
  integrate(gd, b);
  ageSkids(gd, b);
}

// ---- impacts: the shower of sparks that sells a scrape --------------------

function spawnFromImpacts(gd, b) {
  for (let k = gd.impTickStart; k < gd.impCount; k++) {
    if (gd.impKind[k] === IMPACT_KIND.BOUNDS) continue;    // the soft world edge is invisible
    const s = gd.impStrength[k];
    const x = gd.impX[k], z = gd.impZ[k];
    const nx = gd.impNX[k], nz = gd.impNZ[k];

    let n = (s * SPARK_PER_STRENGTH) | 0;
    if (n > SPARK_MAX) n = SPARK_MAX;
    for (let i = 0; i < n; i++) {
      const sp = SPARK_SPEED_MIN + gd.rand() * SPARK_SPEED_RANGE;
      spawnParticle(gd, b, PARTICLE.SPARK,
        x, IMPACT_SPARK_Y + gd.rand() * 0.3, z,
        nx * sp + (gd.rand() - 0.5) * SPARK_SPREAD,
        gd.rand() * SPARK_UP,
        nz * sp + (gd.rand() - 0.5) * SPARK_SPREAD,
        0.25 + gd.rand() * 0.25, 0.08, 1, 0.85, 0.4);
    }

    const nd = n >> 1;
    for (let i = 0; i < nd; i++) {
      spawnParticle(gd, b, PARTICLE.DUST,
        x + (gd.rand() - 0.5) * 0.8, IMPACT_DUST_Y + gd.rand() * 0.3, z + (gd.rand() - 0.5) * 0.8,
        nx * 2 + (gd.rand() - 0.5) * 3, 0.5 + gd.rand(), nz * 2 + (gd.rand() - 0.5) * 3,
        0.8, 0.5, 0.72, 0.62, 0.5);
    }

    if (s <= DEBRIS_STRENGTH) continue;
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      spawnParticle(gd, b, PARTICLE.DEBRIS,
        x, IMPACT_DEBRIS_Y, z,
        nx * 3 + (gd.rand() - 0.5) * 7, 2 + gd.rand() * 4, nz * 3 + (gd.rand() - 0.5) * 7,
        1.5, 0.18, 0.22, 0.22, 0.24);
    }
    for (let i = 0; i < GLASS_COUNT; i++) {
      spawnParticle(gd, b, PARTICLE.GLASS,
        x, IMPACT_DEBRIS_Y + 0.4, z,
        nx * 2 + (gd.rand() - 0.5) * 6, 2 + gd.rand() * 4, nz * 2 + (gd.rand() - 0.5) * 6,
        1.5, 0.12, 0.7, 0.85, 0.95);
    }
  }
}

// ---- cars: the damage tiers, the wreck smoulder, tyre and grass dust ------

function spawnFromCars(gd, b) {
  const dt = b.dt;
  for (let c = 0; c < gd.carCount; c++) {
    const state = gd.carState[c];
    const health = gd.carHealth[c];
    const vx = gd.carVX[c], vz = gd.carVZ[c];
    const speed = Math.sqrt(vx * vx + vz * vz);

    // Most of the 110-odd cars in the city are undamaged and on tarmac, i.e. they emit nothing at
    // all. Decide that from four array reads before paying for any trigonometry.
    const smoking = state === CAR_STATE.WRECK ? gd.carSmoulder[c] > 0 : health < b.smokeHealth;
    const drifting = state !== CAR_STATE.WRECK &&
      gd.carSlip[c] > b.skidSlipThreshold && speed > DRIFT_MIN_SPEED;
    const offRoad = speed > GRASS_MIN_SPEED && !isOnRoad(b, gd.carX[c], gd.carZ[c]);
    if (!smoking && !drifting && !offRoad) {
      gd.carSmokeAcc[c] = 0;
      gd.carFireAcc[c] = 0;
      gd.carDustAcc[c] = 0;
      gd.skidActive[c * 2] = 0;
      gd.skidActive[c * 2 + 1] = 0;
      continue;
    }

    const T = gd.carType[c];
    const x = gd.carX[c], z = gd.carZ[c];
    const yaw = gd.carYaw[c];
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const hl = b.carLen[T] * 0.5, hw = b.carWid[T] * 0.5;

    // the bonnet vent, local (0, emitY, fwd)
    const emitY = b.carHgt[T] * BONNET_H + BONNET_LIFT;
    const fwd = hl * BONNET_F < BONNET_F_MAX ? hl * BONNET_F : BONNET_F_MAX;
    const bx = x + fwd * sn;
    const bz = z + fwd * cs;

    // -------- smoke and fire by tier --------
    if (state === CAR_STATE.WRECK) {
      if (gd.carSmoulder[c] > 0) {
        let acc = gd.carSmokeAcc[c] + SMOULDER_RATE * dt;
        while (acc >= 1) {
          acc -= 1;
          spawnParticle(gd, b, PARTICLE.SMOKE,
            bx + (gd.rand() - 0.5) * 0.6, emitY, bz + (gd.rand() - 0.5) * 0.6,
            (gd.rand() - 0.5) * 0.4, SMOKE_RISE * 0.7, (gd.rand() - 0.5) * 0.4,
            2.5, 0.3, 0.2, 0.19, 0.19);
        }
        gd.carSmokeAcc[c] = acc;
      } else {
        gd.carSmokeAcc[c] = 0;
      }
      gd.carFireAcc[c] = 0;
    } else if (health < b.fireHealth) {
      // black smoke and flames. A car actually BURNING doubles the fire and burns bigger.
      const burning = state === CAR_STATE.BURNING;
      let acc = gd.carSmokeAcc[c] + b.smokeRate * dt;
      while (acc >= 1) {
        acc -= 1;
        spawnParticle(gd, b, PARTICLE.SMOKE,
          bx + (gd.rand() - 0.5) * 1.1, emitY + gd.rand() * 0.5, bz + (gd.rand() - 0.5) * 1.1,
          vx * SMOKE_DRAFT + (gd.rand() - 0.5) * 1.8,
          SMOKE_RISE * (0.6 + gd.rand() * 0.9),
          vz * SMOKE_DRAFT + (gd.rand() - 0.5) * 1.8,
          2.4, 0.5, 0.11, 0.10, 0.10);
      }
      gd.carSmokeAcc[c] = acc;

      let facc = gd.carFireAcc[c] + FIRE_RATE * (burning ? 2 : 1) * dt;
      const fsize = burning ? 0.8 : 0.5;
      while (facc >= 1) {
        facc -= 1;
        spawnParticle(gd, b, PARTICLE.FIRE,
          bx + (gd.rand() - 0.5) * 0.9, emitY - 0.15 + gd.rand() * 0.4, bz + (gd.rand() - 0.5) * 0.9,
          vx * SMOKE_DRAFT + (gd.rand() - 0.5) * 1.6,
          3.5 + gd.rand() * 2,
          vz * SMOKE_DRAFT + (gd.rand() - 0.5) * 1.6,
          FIRE_LIFE, fsize * (0.7 + gd.rand() * 0.6), 1, 0.55, 0.1);
      }
      gd.carFireAcc[c] = facc;
    } else if (health < b.smokeHealth) {
      let acc = gd.carSmokeAcc[c] + SMOKE_RATE_LIGHT * dt;
      while (acc >= 1) {
        acc -= 1;
        spawnParticle(gd, b, PARTICLE.SMOKE,
          bx + (gd.rand() - 0.5) * 0.6, emitY, bz + (gd.rand() - 0.5) * 0.6,
          vx * SMOKE_DRAFT + (gd.rand() - 0.5) * 1.2,
          SMOKE_RISE * (0.5 + gd.rand() * 0.6),
          vz * SMOKE_DRAFT + (gd.rand() - 0.5) * 1.2,
          1.6, 0.35, 0.75, 0.75, 0.78);
      }
      gd.carSmokeAcc[c] = acc;
      gd.carFireAcc[c] = 0;
    } else {
      gd.carSmokeAcc[c] = 0;
      gd.carFireAcc[c] = 0;
    }

    // -------- tyres: drift dust + skid marks, grass dust --------
    let rate = 0;
    if (drifting) rate += DRIFT_DUST_RATE * 2;      // one stream per rear wheel
    if (offRoad) rate += GRASS_DUST_RATE;

    // rear contact patches, local (+-(hw - inset), -hl*SKID_REAR_F)
    const lx = hw - SKID_INSET, lz = -hl * SKID_REAR_F;
    const w0x = x + lx * cs + lz * sn, w0z = z - lx * sn + lz * cs;   // left
    const w1x = x - lx * cs + lz * sn, w1z = z + lx * sn + lz * cs;   // right

    if (rate > 0) {
      let acc = gd.carDustAcc[c] + rate * dt;
      const drift = drifting ? 1 : 0;
      while (acc >= 1) {
        acc -= 1;
        const right = (gd.rand() < 0.5) ? 1 : 0;
        const px = right ? w1x : w0x, pz = right ? w1z : w0z;
        if (drift) {
          spawnParticle(gd, b, PARTICLE.DUST,
            px + (gd.rand() - 0.5) * 0.4, 0.15, pz + (gd.rand() - 0.5) * 0.4,
            (gd.rand() - 0.5) * 1.5, 0.6 + gd.rand() * 0.8, (gd.rand() - 0.5) * 1.5,
            0.7, 0.6, 0.85, 0.78, 0.65);
        } else {
          spawnParticle(gd, b, PARTICLE.DUST,
            px + (gd.rand() - 0.5) * 0.5, 0.15, pz + (gd.rand() - 0.5) * 0.5,
            -vx * 0.15 + (gd.rand() - 0.5) * 1.2, 0.7 + gd.rand(), -vz * 0.15 + (gd.rand() - 0.5) * 1.2,
            0.9, 0.55, 0.78, 0.72, 0.55);
        }
      }
      gd.carDustAcc[c] = acc;
    } else {
      gd.carDustAcc[c] = 0;
    }

    if (drifting) {
      trackSkid(gd, b, c * 2, w0x, w0z);
      trackSkid(gd, b, c * 2 + 1, w1x, w1z);
    } else {
      gd.skidActive[c * 2] = 0;
      gd.skidActive[c * 2 + 1] = 0;
    }
  }
}

// One rear wheel's trail. The first slipping tick only plants the pen; every tick after it draws a
// segment from the last point to this one, once the wheel has actually travelled far enough.
function trackSkid(gd, b, s, x, z) {
  if (gd.skidActive[s] === 0) {
    gd.skidActive[s] = 1;
    gd.skidLastX[s] = x; gd.skidLastZ[s] = z;
    return;
  }
  const x0 = gd.skidLastX[s], z0 = gd.skidLastZ[s];
  const dx = x - x0, dz = z - z0;
  if (dx * dx + dz * dz < SKID_MIN_SEG * SKID_MIN_SEG) return;

  const k = gd.skidHead;
  gd.skidX0[k] = x0; gd.skidZ0[k] = z0;
  gd.skidX1[k] = x; gd.skidZ1[k] = z;
  gd.skidW[k] = SKID_WIDTH;
  gd.skidAge[k] = 0;
  gd.skidHead = (k + 1) % b.maxSkids;
  if (gd.skidCount < b.maxSkids) gd.skidCount++;

  gd.skidLastX[s] = x; gd.skidLastZ[s] = z;
}

// ---- explosions: the whole point of the game ------------------------------

function spawnFromExplosions(gd, b) {
  for (let k = gd.expTickStart; k < gd.expCount; k++) {
    const x = gd.expX[k], z = gd.expZ[k];
    reserve(gd, b, EXP_RESERVE);

    // The fireball is the size of what blew up. A point-source ball looks the same whether a hatch-
    // back or an 11 m bus went off, and on a bus the whole thing would spawn inside the bodywork
    // where nothing can see it — so the blast fills the vehicle's own footprint and height.
    const c = gd.expCar[k];
    let rad = 1.2, top = 1.8;
    if (c >= 0 && c < gd.carCount) {
      const T = gd.carType[c];
      rad = 0.5 + b.carLen[T] * EXP_RAD_F;
      top = b.carHgt[T] + 0.6;
    }

    // the shock ring first: one particle, and the pool must never be too full for it
    spawnParticle(gd, b, PARTICLE.SHOCK, x, SHOCK_Y, z, 0, 0, 0, 0.35, 1, 1, 0.9, 0.7);

    for (let i = 0; i < EXP_FIRE; i++) {
      const a = gd.rand() * Math.PI * 2;
      const r = gd.rand() * rad;
      const sp = 6 + gd.rand() * 8;
      spawnParticle(gd, b, PARTICLE.FIRE,
        x + Math.sin(a) * r, 0.4 + gd.rand() * top, z + Math.cos(a) * r,
        Math.sin(a) * sp, 2 + gd.rand() * 5, Math.cos(a) * sp,
        0.6, 1.4, 1, 0.55, 0.1);
    }
    // The smoke goes UP and out of the way rather than out with the fire: the fireball has to be
    // the bright thing at the centre, with the black column mushrooming above it.
    for (let i = 0; i < EXP_SMOKE; i++) {
      const a = gd.rand() * Math.PI * 2;
      const r = gd.rand() * rad * 0.7;
      const sp = gd.rand() * 2.5;
      spawnParticle(gd, b, PARTICLE.SMOKE,
        x + Math.sin(a) * r, 1 + gd.rand() * top, z + Math.cos(a) * r,
        Math.sin(a) * sp, 5 + gd.rand() * 5, Math.cos(a) * sp,
        2.5, 1.2, 0.11, 0.10, 0.10);
    }
    for (let i = 0; i < EXP_DEBRIS; i++) {
      const a = gd.rand() * Math.PI * 2;
      const sp = 8 + gd.rand() * 12;
      spawnParticle(gd, b, (i & 3) === 3 ? PARTICLE.GLASS : PARTICLE.DEBRIS,
        x + Math.sin(a) * rad * 0.5, 0.6 + gd.rand() * top, z + Math.cos(a) * rad * 0.5,
        Math.sin(a) * sp, 6 + gd.rand() * 8, Math.cos(a) * sp,
        2.5, (i & 3) === 3 ? 0.14 : 0.2, 0.22, 0.21, 0.22);
    }
  }
}

// ---- integrate ------------------------------------------------------------

function integrate(gd, b) {
  const dt = b.dt;
  const g = b.particleGravity * dt;
  let i = 0;
  while (i < gd.pCount) {
    const life = gd.pLife[i] - dt;
    if (life <= 0) { removeParticle(gd, i); continue; }
    gd.pLife[i] = life;

    const type = gd.pType[i];
    let vx = gd.pVX[i], vy = gd.pVY[i], vz = gd.pVZ[i];
    let size = gd.pSize[i];

    if (type === PARTICLE.SMOKE) {
      vy += SMOKE_BUOY * dt;
      vx *= SMOKE_DRAG; vy *= SMOKE_DRAG_Y; vz *= SMOKE_DRAG;
      size += SMOKE_GROW * dt;
    } else if (type === PARTICLE.FIRE) {
      vy += FIRE_BUOY * dt;
      vx *= FIRE_DRAG; vy *= FIRE_DRAG; vz *= FIRE_DRAG;
      // a flame balloons out of the bodywork, then collapses as it burns out
      size *= 1 + (life > gd.pMaxLife[i] * 0.5 ? FIRE_SWELL : -FIRE_SHRINK) * dt;
    } else if (type === PARTICLE.DUST) {
      vy += DUST_BUOY * dt;
      vx *= DUST_DRAG; vy *= DUST_DRAG; vz *= DUST_DRAG;
      size += DUST_GROW * dt;
    } else if (type === PARTICLE.SPARK) {
      vy -= g * SPARK_GRAVITY;
      vx *= SPARK_DRAG; vy *= SPARK_DRAG; vz *= SPARK_DRAG;
    } else if (type === PARTICLE.SHOCK) {
      size += SHOCK_GROW * dt;
    } else {
      vy -= g;                                  // DEBRIS and GLASS are just lumps
    }

    let x = gd.pX[i] + vx * dt;
    let y = gd.pY[i] + vy * dt;
    let z = gd.pZ[i] + vz * dt;

    if (type === PARTICLE.DEBRIS || type === PARTICLE.GLASS || type === PARTICLE.SPARK) {
      if (y < 0.05) {
        y = 0.05;
        if (vy < 0) {
          vy *= BOUNCE;                          // one good bounce, then it skitters and settles
          vx *= BOUNCE_FRICTION; vz *= BOUNCE_FRICTION;
        }
      }
    } else if (type !== PARTICLE.SHOCK && y < FLOOR) {
      y = FLOOR;
      if (vy < 0) vy = 0;
    }

    gd.pVX[i] = vx; gd.pVY[i] = vy; gd.pVZ[i] = vz;
    gd.pX[i] = x; gd.pY[i] = y; gd.pZ[i] = z;
    gd.pSize[i] = size;
    i++;
  }
}

// Rubber fades. The Board reads skidAge and darkens the mark's alpha with it; nothing here has to
// remove a segment, because the ring buffer overwrites the oldest one on its own.
function ageSkids(gd, b) {
  const dt = b.dt;
  const n = gd.skidCount;
  for (let i = 0; i < n; i++) gd.skidAge[i] += dt;
}
