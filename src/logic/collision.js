// Collision: car OBB bounds, car vs building/car/prop/bounds resolution, impact events.
// Logic module: imports only balance and sibling Logic, never three, never the DOM, never
// Math.random. Allocation-free: the only working storage is the module-scope Float32Arrays below.
//
// Everything here is 2-D. A car is an oriented box (carLen x carWid) around (carX, carZ) at carYaw;
// a building is an axis-aligned box; a prop is a circle. The three pairings all end the same way:
// find the minimum translation that separates the pair, move along it, reflect the velocity along
// it, and — when the closing speed was worth noticing — record an impact event that Task 9 turns
// into damage, sparks and camera shake and that the car renderer turns into a dent.
//
// Conventions (spec §3 / constraints): +X east, +Y up, +Z south; yaw θ has forward (sin θ, cos θ).
// Mesh-local is +Z front, +X left, so world->local is
//     lx = dx*cos θ - dz*sin θ        lz = dx*sin θ + dz*cos θ
// and local->world is
//     dx = lx*cos θ + lz*sin θ        dz = -lx*sin θ + lz*cos θ
// The mesh-local pair is exactly what carMesh dents, so pushImpact writes it verbatim.
//
// Sign convention for every normal in this file: n points FROM the obstacle TOWARD the car, so
// moving the car by +n*overlap always separates it and v·n < 0 always means "still closing".
import { CAR_STATE, PROP_STATE, IMPACT_KIND, SIDE } from '../balance.js';
import { knockProp } from './props.js';

const ITERATIONS = 2;            // full passes per tick — one is enough to separate, two to settle
const MOVING = 0.01;             // |vx|+|vz| below this and a car is not worth testing against the world
const TANGENT_DAMP = 0.985;      // the scrape along a wall
const YAW_DAMP_WORLD = 0.6;      // a wall stops you spinning
const YAW_DAMP_PROP = 0.8;
const PROP_RESTITUTION = 0.2;    // a tree is deader than a wall
const MIN_IMPACT = 1;            // m/s of closing speed below which a scrape is not an event
const KNOCK_MIN_SPEED = 1.5;     // slower than this and a car just noses a bin aside
const KNOCK_IMPACT_CAP = 4;      // a knock never reports more than this before the 0.5 scale
const MAX_SPEED_LOSS = 0.35;     // however heavy the prop, one hit never takes more than this
const BOUNDS_SPRING = 8;         // per second squared, per metre outside worldHalf
const BOUNDS_CLAMP = 6;          // metres past worldHalf where the soft spring becomes a wall
const SLEEP_SPEED = 0.05;        // a parked car this slow is put back to sleep
const CONTACT_EPS = 0.15;        // corners this close to the deepest one share the contact point
const SPIN_SCALE = 0.5;          // how much of a car-car impulse becomes yaw

// SAT axes for the pair currently being tested. Never live across a call, never allocated per tick.
const _ax = new Float32Array(4);
const _az = new Float32Array(4);
// Results of the last SAT: overlap and the normal, obstacle -> car.
const _mtv = new Float32Array(3);   // [overlap, nx, nz]

// ===========================================================================================
// Bounds
// ===========================================================================================

// Corners in mesh-local FL, FR, RR, RL order (+X left, +Z front) plus the enclosing AABB.
export function updateCarBounds(gd, b) {
  for (let i = 0; i < gd.carCount; i++) carBounds(gd, b, i);
}

function carBounds(gd, b, i) {
  const T = gd.carType[i];
  const hl = b.carLen[T] * 0.5, hw = b.carWid[T] * 0.5;
  const yaw = gd.carYaw[i];
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const x = gd.carX[i], z = gd.carZ[i];
  // local +X (left) in world is (cos, -sin); local +Z (front) is (sin, cos)
  const lx = cs * hw, lz = -sn * hw;
  const fx = sn * hl, fz = cs * hl;

  const k = i * 4;
  const x0 = x + lx + fx, z0 = z + lz + fz;   // FL
  const x1 = x - lx + fx, z1 = z - lz + fz;   // FR
  const x2 = x - lx - fx, z2 = z - lz - fz;   // RR
  const x3 = x + lx - fx, z3 = z + lz - fz;   // RL
  gd.carCX[k] = x0; gd.carCZ[k] = z0;
  gd.carCX[k + 1] = x1; gd.carCZ[k + 1] = z1;
  gd.carCX[k + 2] = x2; gd.carCZ[k + 2] = z2;
  gd.carCX[k + 3] = x3; gd.carCZ[k + 3] = z3;

  let minX = x0, maxX = x0, minZ = z0, maxZ = z0;
  if (x1 < minX) minX = x1; else if (x1 > maxX) maxX = x1;
  if (x2 < minX) minX = x2; else if (x2 > maxX) maxX = x2;
  if (x3 < minX) minX = x3; else if (x3 > maxX) maxX = x3;
  if (z1 < minZ) minZ = z1; else if (z1 > maxZ) maxZ = z1;
  if (z2 < minZ) minZ = z2; else if (z2 > maxZ) maxZ = z2;
  if (z3 < minZ) minZ = z3; else if (z3 > maxZ) maxZ = z3;
  gd.carMinX[i] = minX; gd.carMaxX[i] = maxX;
  gd.carMinZ[i] = minZ; gd.carMaxZ[i] = maxZ;
}

// ===========================================================================================
// Impacts
// ===========================================================================================

// One impact event. (x, z) is the world contact point, (nx, nz) the unit normal pointing from
// whatever was hit back at the car, `strength` the closing speed in m/s. Dropped silently when the
// frame's buffer is full — 96 impacts in one frame is already a pile-up nobody can hear.
export function pushImpact(gd, b, car, other, x, z, nx, nz, strength, kind) {
  const player = gd.playerCar;
  if (car === player || (kind === IMPACT_KIND.CAR && other === player)) {
    if (strength > gd.statBigImpact) gd.statBigImpact = strength;
  }
  if (gd.impCount >= b.maxImpacts) return;
  const k = gd.impCount++;

  gd.impCar[k] = car;
  gd.impOther[k] = other;
  gd.impX[k] = x; gd.impZ[k] = z;
  gd.impNX[k] = nx; gd.impNZ[k] = nz;
  gd.impStrength[k] = strength;
  gd.impKind[k] = kind;

  // Mesh-local contact point: +X left, +Z front. This is the point the car renderer dents.
  const yaw = gd.carYaw[car];
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const dx = x - gd.carX[car], dz = z - gd.carZ[car];
  const T = gd.carType[car];
  const hl = b.carLen[T] * 0.5, hw = b.carWid[T] * 0.5;
  // Clamped to the car's own footprint: a car-car contact point is the midpoint of two hulls and
  // can sit just off the body, and a dent has to land on the mesh to be a dent.
  let lx = dx * cs - dz * sn;
  let lz = dx * sn + dz * cs;
  if (lx < -hw) lx = -hw; else if (lx > hw) lx = hw;
  if (lz < -hl) lz = -hl; else if (lz > hl) lz = hl;
  gd.impLocalX[k] = lx;
  gd.impLocalZ[k] = lz;

  // Which panel took it: whichever local axis is further out as a fraction of its own half-extent.
  const alx = lx < 0 ? -lx : lx, alz = lz < 0 ? -lz : lz;
  const side = (alz / hl >= alx / hw) ? (lz > 0 ? SIDE.FRONT : SIDE.REAR)
                                      : (lx > 0 ? SIDE.LEFT : SIDE.RIGHT);
  const d = gd.carDent[car * 4 + side] + strength * b.dentPerStrength;
  gd.carDent[car * 4 + side] = d > 1 ? 1 : d;
}

// ===========================================================================================
// Car vs static building AABB
// ===========================================================================================

// SAT on 4 axes (world X, world Z, car left, car front). Writes [overlap, nx, nz] into _mtv with
// the normal signed from the box toward the car; returns 0 when the two are apart.
function satBox(gd, b, i, minX, minZ, maxX, maxZ) {
  if (gd.carMaxX[i] <= minX || gd.carMinX[i] >= maxX ||
      gd.carMaxZ[i] <= minZ || gd.carMinZ[i] >= maxZ) return 0;

  const yaw = gd.carYaw[i];
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  _ax[0] = 1; _az[0] = 0;
  _ax[1] = 0; _az[1] = 1;
  _ax[2] = cs; _az[2] = -sn;     // car left
  _ax[3] = sn; _az[3] = cs;      // car front

  const c = i * 4;
  let bestOv = Infinity, bnx = 0, bnz = 0;
  for (let a = 0; a < 4; a++) {
    const nx = _ax[a], nz = _az[a];

    let minA = Infinity, maxA = -Infinity;
    for (let k = 0; k < 4; k++) {
      const p = gd.carCX[c + k] * nx + gd.carCZ[c + k] * nz;
      if (p < minA) minA = p;
      if (p > maxA) maxA = p;
    }

    let minB, maxB;
    if (a === 0) { minB = minX; maxB = maxX; }
    else if (a === 1) { minB = minZ; maxB = maxZ; }
    else {
      const e0 = minX * nx + minZ * nz, e1 = maxX * nx + minZ * nz;
      const e2 = maxX * nx + maxZ * nz, e3 = minX * nx + maxZ * nz;
      minB = e0; maxB = e0;
      if (e1 < minB) minB = e1; else if (e1 > maxB) maxB = e1;
      if (e2 < minB) minB = e2; else if (e2 > maxB) maxB = e2;
      if (e3 < minB) minB = e3; else if (e3 > maxB) maxB = e3;
    }

    const ov = (maxA < maxB ? maxA : maxB) - (minA > minB ? minA : minB);
    if (ov <= 0) return 0;
    if (ov < bestOv) { bestOv = ov; bnx = nx; bnz = nz; }
  }

  // Sign it from the box's centre toward the car's.
  const bcx = (minX + maxX) * 0.5, bcz = (minZ + maxZ) * 0.5;
  if ((gd.carX[i] - bcx) * bnx + (gd.carZ[i] - bcz) * bnz < 0) { bnx = -bnx; bnz = -bnz; }
  _mtv[0] = bestOv; _mtv[1] = bnx; _mtv[2] = bnz;
  return 1;
}

// Returns 1 when the car moved (the caller must then refresh its bounds).
function carVsBox(gd, b, i, col) {
  if (!satBox(gd, b, i, gd.colMinX[col], gd.colMinZ[col], gd.colMaxX[col], gd.colMaxZ[col])) return 0;
  const ov = _mtv[0], nx = _mtv[1], nz = _mtv[2];

  // Contact point: the corner (or the midpoint of the two corners, on a flat hit) buried deepest
  // in the box, carried out with the car.
  const c = i * 4;
  let deep = Infinity;
  for (let k = 0; k < 4; k++) {
    const p = gd.carCX[c + k] * nx + gd.carCZ[c + k] * nz;
    if (p < deep) deep = p;
  }
  let sx = 0, sz = 0, n = 0;
  for (let k = 0; k < 4; k++) {
    const p = gd.carCX[c + k] * nx + gd.carCZ[c + k] * nz;
    if (p <= deep + CONTACT_EPS) { sx += gd.carCX[c + k]; sz += gd.carCZ[c + k]; n++; }
  }
  const px = sx / n + nx * ov, pz = sz / n + nz * ov;

  gd.carX[i] += nx * ov;
  gd.carZ[i] += nz * ov;

  const vx = gd.carVX[i], vz = gd.carVZ[i];
  const vN = vx * nx + vz * nz;
  let rx = vx, rz = vz;
  if (vN < 0) {
    const j = -vN * (1 + b.restitutionWorld);
    rx = vx + nx * j; rz = vz + nz * j;
  }
  // Scrub only the sliding half of what is left: a glancing blow costs speed, a square one does not
  // get damped twice.
  const rn = rx * nx + rz * nz;
  gd.carVX[i] = nx * rn + (rx - nx * rn) * TANGENT_DAMP;
  gd.carVZ[i] = nz * rn + (rz - nz * rn) * TANGENT_DAMP;
  gd.carYawRate[i] *= YAW_DAMP_WORLD;

  if (-vN > MIN_IMPACT) pushImpact(gd, b, i, col, px, pz, nx, nz, -vN, IMPACT_KIND.WORLD);
  return 1;
}

// ===========================================================================================
// Car vs prop circle
// ===========================================================================================

// Returns 1 when the car moved. Static props (trees, the fountain) push back like a wall;
// everything else is launched and costs the car a slice of its speed.
function carVsProp(gd, b, i, p) {
  const type = gd.propType[p];
  const r = b.propRadius[type] * gd.propScale[p];
  const T = gd.carType[i];
  const hl = b.carLen[T] * 0.5, hw = b.carWid[T] * 0.5;

  const yaw = gd.carYaw[i];
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const dx = gd.propX[p] - gd.carX[i], dz = gd.propZ[p] - gd.carZ[i];
  const lx = dx * cs - dz * sn;
  const lz = dx * sn + dz * cs;

  const qx = lx < -hw ? -hw : (lx > hw ? hw : lx);
  const qz = lz < -hl ? -hl : (lz > hl ? hl : lz);
  const ex = lx - qx, ez = lz - qz;
  const d2 = ex * ex + ez * ez;
  if (d2 >= r * r) return 0;

  // Local normal, prop -> car, and how far the car has to move to clear the circle.
  let nlx, nlz, pd;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    nlx = -ex / d; nlz = -ez / d;
    pd = r - d;
  } else {
    // The prop centre is inside the car: shortest way out is through the nearest flank, and the
    // car goes the other way.
    const dL = hw - lx, dR = lx + hw, dF = hl - lz, dB = lz + hl;
    let m = dL; nlx = -1; nlz = 0;
    if (dR < m) { m = dR; nlx = 1; nlz = 0; }
    if (dF < m) { m = dF; nlx = 0; nlz = -1; }
    if (dB < m) { m = dB; nlx = 0; nlz = 1; }
    pd = m + r;
  }
  // local -> world
  const nx = nlx * cs + nlz * sn;
  const nz = -nlx * sn + nlz * cs;
  // contact = the closest point on the car's body, in world
  const cx = gd.carX[i] + qx * cs + qz * sn;
  const cz = gd.carZ[i] - qx * sn + qz * cs;

  const vx = gd.carVX[i], vz = gd.carVZ[i];

  if (b.propStatic[type]) {
    gd.carX[i] += nx * pd;
    gd.carZ[i] += nz * pd;
    const vN = vx * nx + vz * nz;
    if (vN < 0) {
      const j = -vN * (1 + PROP_RESTITUTION);
      gd.carVX[i] = vx + nx * j;
      gd.carVZ[i] = vz + nz * j;
    }
    gd.carYawRate[i] *= YAW_DAMP_PROP;
    // The contact point rides out with the car, or pushImpact would measure it against a centre
    // that has already moved and put the dent pd metres off the panel.
    if (-vN > MIN_IMPACT) {
      pushImpact(gd, b, i, p, cx + nx * pd, cz + nz * pd, nx, nz, -vN, IMPACT_KIND.PROP);
    }
    return 1;
  }

  const spd = Math.sqrt(vx * vx + vz * vz);
  if (spd <= KNOCK_MIN_SPEED) {
    // Too slow to launch it: nose it aside and carry on.
    gd.carX[i] += nx * pd;
    gd.carZ[i] += nz * pd;
    return 1;
  }

  knockProp(gd, b, p, vx, vz, spd);
  // Heavy street furniture bites, a cone does not, and a bus notices neither. propMass over half
  // the car's mass, capped: a lamp post costs a CRUISER 9% of its speed and a bus 1.3%.
  let loss = b.propMass[type] / (b.carMass[T] * 0.5);
  if (loss > MAX_SPEED_LOSS) loss = MAX_SPEED_LOSS;
  gd.carVX[i] = vx * (1 - loss);
  gd.carVZ[i] = vz * (1 - loss);
  const s = (spd < KNOCK_IMPACT_CAP ? spd : KNOCK_IMPACT_CAP) * 0.5;
  pushImpact(gd, b, i, p, cx, cz, nx, nz, s, IMPACT_KIND.PROP);
  return 0;                                   // the car did not move; its bounds are still good
}

// ===========================================================================================
// Car vs car
// ===========================================================================================

// SAT on the two cars' own axes. Writes _mtv with the normal signed from j toward i.
function satCars(gd, b, i, j) {
  if (gd.carMaxX[i] <= gd.carMinX[j] || gd.carMinX[i] >= gd.carMaxX[j] ||
      gd.carMaxZ[i] <= gd.carMinZ[j] || gd.carMinZ[i] >= gd.carMaxZ[j]) return 0;

  const yi = gd.carYaw[i], yj = gd.carYaw[j];
  const ci = Math.cos(yi), si = Math.sin(yi);
  const cj = Math.cos(yj), sj = Math.sin(yj);
  _ax[0] = ci; _az[0] = -si;
  _ax[1] = si; _az[1] = ci;
  _ax[2] = cj; _az[2] = -sj;
  _ax[3] = sj; _az[3] = cj;

  const ai = i * 4, aj = j * 4;
  let bestOv = Infinity, bnx = 0, bnz = 0;
  for (let a = 0; a < 4; a++) {
    const nx = _ax[a], nz = _az[a];
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (let k = 0; k < 4; k++) {
      const pa = gd.carCX[ai + k] * nx + gd.carCZ[ai + k] * nz;
      if (pa < minA) minA = pa;
      if (pa > maxA) maxA = pa;
      const pb = gd.carCX[aj + k] * nx + gd.carCZ[aj + k] * nz;
      if (pb < minB) minB = pb;
      if (pb > maxB) maxB = pb;
    }
    const ov = (maxA < maxB ? maxA : maxB) - (minA > minB ? minA : minB);
    if (ov <= 0) return 0;
    if (ov < bestOv) { bestOv = ov; bnx = nx; bnz = nz; }
  }

  const dx = gd.carX[i] - gd.carX[j], dz = gd.carZ[i] - gd.carZ[j];
  if (dx * dx + dz * dz < 1e-12) {
    // Exactly coincident: there is no "away from j" to point at, so pick a fixed axis rather than
    // divide by nothing and hand the rest of the tick a NaN.
    bnx = 1; bnz = 0;
  } else if (dx * bnx + dz * bnz < 0) {
    bnx = -bnx; bnz = -bnz;
  }
  _mtv[0] = bestOv; _mtv[1] = bnx; _mtv[2] = bnz;
  return 1;
}

// Returns 1 when either car moved.
function carVsCar(gd, b, i, j) {
  if (!satCars(gd, b, i, j)) return 0;
  const ov = _mtv[0], nx = _mtv[1], nz = _mtv[2];

  // Contact: halfway between i's deepest corner toward j and j's deepest corner toward i. Cheap,
  // and it lands on the panel that actually took the hit, which is what the dent needs.
  const ai = i * 4, aj = j * 4;
  let dpi = Infinity, pix = 0, piz = 0;
  let dpj = -Infinity, pjx = 0, pjz = 0;
  for (let k = 0; k < 4; k++) {
    const pa = gd.carCX[ai + k] * nx + gd.carCZ[ai + k] * nz;
    if (pa < dpi) { dpi = pa; pix = gd.carCX[ai + k]; piz = gd.carCZ[ai + k]; }
    const pb = gd.carCX[aj + k] * nx + gd.carCZ[aj + k] * nz;
    if (pb > dpj) { dpj = pb; pjx = gd.carCX[aj + k]; pjz = gd.carCZ[aj + k]; }
  }
  const cpx = (pix + pjx) * 0.5, cpz = (piz + pjz) * 0.5;

  const Ti = gd.carType[i], Tj = gd.carType[j];
  const mi = b.carMass[Ti], mj = b.carMass[Tj];
  const inv = 1 / (mi + mj);
  // The heavier car holds its ground: each moves the share of the overlap the OTHER one's mass buys.
  const si = ov * mj * inv, sj = ov * mi * inv;
  gd.carX[i] += nx * si; gd.carZ[i] += nz * si;
  gd.carX[j] -= nx * sj; gd.carZ[j] -= nz * sj;

  const vix = gd.carVX[i], viz = gd.carVZ[i];
  const vjx = gd.carVX[j], vjz = gd.carVZ[j];
  // n points j -> i, so i closing on j means (vi - vj)·n < 0.
  const vRel = (vix - vjx) * nx + (viz - vjz) * nz;
  if (vRel < 0) {
    const jn = -(1 + b.restitutionCar) * vRel / (1 / mi + 1 / mj);
    const jx = nx * jn, jz = nz * jn;
    gd.carVX[i] = vix + jx / mi; gd.carVZ[i] = viz + jz / mi;
    gd.carVX[j] = vjx - jx / mj; gd.carVZ[j] = vjz - jz / mj;

    // Torque about +Y is (r x F)_y = rz*Fx - rx*Fz. Divided by mass*hl*hw as a stand-in for the
    // moment of inertia, so a long car spins less than a short one from the same corner hit.
    const hli = b.carLen[Ti] * 0.5, hwi = b.carWid[Ti] * 0.5;
    const hlj = b.carLen[Tj] * 0.5, hwj = b.carWid[Tj] * 0.5;
    const rix = cpx - gd.carX[i], riz = cpz - gd.carZ[i];
    const rjx = cpx - gd.carX[j], rjz = cpz - gd.carZ[j];
    gd.carYawRate[i] += (riz * jx - rix * jz) / (mi * hli * hwi) * SPIN_SCALE;
    gd.carYawRate[j] -= (rjz * jx - rjx * jz) / (mj * hlj * hwj) * SPIN_SCALE;

    // Each car sees the contact point where its own body carried it, so the dent lands on the
    // panel that took the hit rather than pd metres behind it.
    const s = -vRel;
    pushImpact(gd, b, i, j, cpx + nx * si, cpz + nz * si, nx, nz, s, IMPACT_KIND.CAR);
    pushImpact(gd, b, j, i, cpx - nx * sj, cpz - nz * sj, -nx, -nz, s, IMPACT_KIND.CAR);
  }
  return 1;
}

// ===========================================================================================
// Bounds
// ===========================================================================================

// A soft spring outside worldHalf that turns into a wall BOUNDS_CLAMP metres further out. The
// boundary is invisible, so it never records an impact and never dents anything.
function resolveBounds(gd, b, i) {
  const h = b.worldHalf, dt = b.dt;
  const x = gd.carX[i], z = gd.carZ[i];
  if (x > h) {
    const e = x - h;
    gd.carVX[i] -= e * BOUNDS_SPRING * dt;
    if (e > BOUNDS_CLAMP) gd.carX[i] = h + BOUNDS_CLAMP;
  } else if (x < -h) {
    const e = -h - x;
    gd.carVX[i] += e * BOUNDS_SPRING * dt;
    if (e > BOUNDS_CLAMP) gd.carX[i] = -h - BOUNDS_CLAMP;
  }
  if (z > h) {
    const e = z - h;
    gd.carVZ[i] -= e * BOUNDS_SPRING * dt;
    if (e > BOUNDS_CLAMP) gd.carZ[i] = h + BOUNDS_CLAMP;
  } else if (z < -h) {
    const e = -h - z;
    gd.carVZ[i] += e * BOUNDS_SPRING * dt;
    if (e > BOUNDS_CLAMP) gd.carZ[i] = -h - BOUNDS_CLAMP;
  }
}

// ===========================================================================================
// The pass
// ===========================================================================================

// The 3x3 collision-grid cells around the car cover 96 m, which comfortably contains the longest
// car plus the widest building that can reach it.
function carVsWorld(gd, b, i) {
  const dim = b.gridDim, size = b.gridCellSize, o = b.gridOrigin;
  const cx0 = Math.floor((gd.carX[i] - o) / size);
  const cz0 = Math.floor((gd.carZ[i] - o) / size);
  for (let jz = -1; jz <= 1; jz++) {
    const cz = cz0 + jz;
    if (cz < 0 || cz >= dim) continue;
    for (let jx = -1; jx <= 1; jx++) {
      const cx = cx0 + jx;
      if (cx < 0 || cx >= dim) continue;
      const c = cz * dim + cx;

      let start = gd.cGridStart[c], n = gd.cGridCount[c];
      for (let k = 0; k < n; k++) {
        if (carVsBox(gd, b, i, gd.cGridItems[start + k])) carBounds(gd, b, i);
      }

      start = gd.pGridStart[c]; n = gd.pGridCount[c];
      for (let k = 0; k < n; k++) {
        const p = gd.pGridItems[start + k];
        if (gd.propState[p] !== PROP_STATE.STATIC) continue;
        if (carVsProp(gd, b, i, p)) carBounds(gd, b, i);
      }
    }
  }
}

// A car worth resolving this tick: one that is going somewhere, plus the player's, which is
// resolved even at a standstill so a teleport or a spawn can never leave him buried in geometry.
function awake(gd, i) {
  const vx = gd.carVX[i], vz = gd.carVZ[i];
  if ((vx < 0 ? -vx : vx) + (vz < 0 ? -vz : vz) > MOVING) return 1;
  return gd.carState[i] === CAR_STATE.PLAYER ? 1 : 0;
}

export function resolveCollisions(gd, b) {
  const n = gd.carCount;
  updateCarBounds(gd, b);

  for (let it = 0; it < ITERATIONS; it++) {
    // 1. every awake car against the static world
    for (let i = 0; i < n; i++) {
      if (awake(gd, i)) carVsWorld(gd, b, i);
    }

    // 2. car against car. Two cars that are both asleep cannot have just started overlapping,
    // so 70 parked cars cost one flag test each rather than 2415 AABB tests.
    for (let i = 0; i < n - 1; i++) {
      const ai = awake(gd, i);
      for (let j = i + 1; j < n; j++) {
        if (!ai && !awake(gd, j)) continue;
        if (carVsCar(gd, b, i, j)) { carBounds(gd, b, i); carBounds(gd, b, j); }
      }
    }

    // 3. the invisible edge of the world
    for (let i = 0; i < n; i++) resolveBounds(gd, b, i);
  }

  // 4. put parked cars back to sleep, so 70 of them cost nothing next tick, and refresh the
  // forward/lateral split — vehicle.js wrote it before any of this rearranged the velocity, and
  // the HUD, the camera and the skid marks all read it.
  for (let i = 0; i < n; i++) {
    let vx = gd.carVX[i], vz = gd.carVZ[i];
    if (gd.carState[i] === CAR_STATE.PARKED && vx * vx + vz * vz < SLEEP_SPEED * SLEEP_SPEED) {
      vx = 0; vz = 0;
      gd.carVX[i] = 0; gd.carVZ[i] = 0; gd.carYawRate[i] = 0;
    }
    const yaw = gd.carYaw[i];
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    gd.carSpeedF[i] = vx * fx + vz * fz;
    const vL = -vx * fz + vz * fx;
    gd.carSlip[i] = vL < 0 ? -vL : vL;
  }
}

// ===========================================================================================
// Circle vs the world — the player on foot
// ===========================================================================================

// Pushes the circle (x, z, r) out of every building AABB in the surrounding 3x3 grid cells, out of
// every live car's OBB and out of every static prop, and writes the corrected centre to
// gd.scratch[0], gd.scratch[1]. Allocation-free; called once per tick while the player walks.
export function pushOutCircle(gd, b, x, z, r) {
  const dim = b.gridDim, size = b.gridCellSize, o = b.gridOrigin;
  const cx0 = Math.floor((x - o) / size);
  const cz0 = Math.floor((z - o) / size);
  const r2 = r * r;

  for (let jz = -1; jz <= 1; jz++) {
    const cz = cz0 + jz;
    if (cz < 0 || cz >= dim) continue;
    for (let jx = -1; jx <= 1; jx++) {
      const cx = cx0 + jx;
      if (cx < 0 || cx >= dim) continue;
      const c = cz * dim + cx;

      // --- buildings: closest point on the AABB
      let start = gd.cGridStart[c], n = gd.cGridCount[c];
      for (let k = 0; k < n; k++) {
        const i = gd.cGridItems[start + k];
        const minX = gd.colMinX[i], maxX = gd.colMaxX[i];
        const minZ = gd.colMinZ[i], maxZ = gd.colMaxZ[i];
        const qx = x < minX ? minX : (x > maxX ? maxX : x);
        const qz = z < minZ ? minZ : (z > maxZ ? maxZ : z);
        const dx = x - qx, dz = z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          const push = (r - d) / d;
          x += dx * push; z += dz * push;
        } else {
          // dead inside the box: out through the nearest face
          const dW = x - minX, dE = maxX - x, dN = z - minZ, dS = maxZ - z;
          let m = dW, face = 0;
          if (dE < m) { m = dE; face = 1; }
          if (dN < m) { m = dN; face = 2; }
          if (dS < m) { m = dS; face = 3; }
          if (face === 0) x = minX - r;
          else if (face === 1) x = maxX + r;
          else if (face === 2) z = minZ - r;
          else z = maxZ + r;
        }
      }

      // --- static props: circle vs circle
      start = gd.pGridStart[c]; n = gd.pGridCount[c];
      for (let k = 0; k < n; k++) {
        const p = gd.pGridItems[start + k];
        if (gd.propState[p] !== PROP_STATE.STATIC) continue;
        const pr = b.propRadius[gd.propType[p]] * gd.propScale[p] + r;
        const dx = x - gd.propX[p], dz = z - gd.propZ[p];
        const d2 = dx * dx + dz * dz;
        if (d2 >= pr * pr) continue;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          const push = (pr - d) / d;
          x += dx * push; z += dz * push;
        } else {
          x += pr;                             // exactly on the trunk: any direction will do
        }
      }
    }
  }

  // --- cars: closest point on the OBB, in the car's own frame
  for (let i = 0; i < gd.carCount; i++) {
    const T = gd.carType[i];
    const hl = b.carLen[T] * 0.5, hw = b.carWid[T] * 0.5;
    const dx = x - gd.carX[i], dz = z - gd.carZ[i];
    const reach = hl + r;
    if (dx * dx + dz * dz >= reach * reach) continue;

    const yaw = gd.carYaw[i];
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const lx = dx * cs - dz * sn;
    const lz = dx * sn + dz * cs;
    const qx = lx < -hw ? -hw : (lx > hw ? hw : lx);
    const qz = lz < -hl ? -hl : (lz > hl ? hl : lz);
    const ex = lx - qx, ez = lz - qz;
    const d2 = ex * ex + ez * ez;
    if (d2 >= r2) continue;

    let nlx, nlz, pd;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      nlx = ex / d; nlz = ez / d;
      pd = r - d;
    } else {
      const dL = hw - lx, dR = lx + hw, dF = hl - lz, dB = lz + hl;
      let m = dL; nlx = 1; nlz = 0;
      if (dR < m) { m = dR; nlx = -1; nlz = 0; }
      if (dF < m) { m = dF; nlx = 0; nlz = 1; }
      if (dB < m) { m = dB; nlx = 0; nlz = -1; }
      pd = m + r;
    }
    x += (nlx * cs + nlz * sn) * pd;
    z += (-nlx * sn + nlz * cs) * pd;
  }

  gd.scratch[0] = x;
  gd.scratch[1] = z;
}
