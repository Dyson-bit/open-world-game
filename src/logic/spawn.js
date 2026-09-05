// Car spawning, parked-car placement, traffic population and recycling.
// Logic module: imports only balance (and city.js queries), never three, never the DOM,
// never Math.random.
//
// Identity is the slot index. Cars are never removed during play: a car that is too far away to
// matter is recycled in place — same slot, new type, paint and lane — which keeps carCount stable
// and lets the Board rebuild exactly the slots flagged in carDirty.
//
// gd.scratch use in this file: [0] is nearestLanePoint's output (city.js owns it),
// [2] = chosen lane, [3] = chosen distance along that lane.
import { CAR_STATE } from '../balance.js';
import { nearestLanePoint } from './city.js';

const TWO_PI = Math.PI * 2;
const CAR_GAP = 12;          // metres between two cars sharing a lane at spawn time
const LANE_END_MARGIN = 2;   // keep a spawned car off the very ends of its lane
const TRIES = 20;            // placement attempts before giving up on a car this scan
const RESPAWN_TRIES = 24;
const SCAN_TICKS = 30;       // the traffic manager only scans twice a second
const WRECK_RECYCLE_DIST = 300;
const POOL_SLACK = 10;       // recycle far wrecks once the pool is this close to full
const IN_VIEW_PENALTY = 500; // metres-equivalent cost of popping a car into the camera's view

// -------------------------------------------------------------------------------- spawning

// Takes the next free slot and resets every per-car field in it. Returns the index, or -1 when
// the pool is full. The caller owns anything else (lane, park spot, velocity).
export function spawnCar(gd, b, type, paint, x, z, yaw, state) {
  if (gd.carCount >= b.maxCars) return -1;
  const i = gd.carCount++;
  resetCar(gd, b, i, type, paint, x, z, yaw, state);
  return i;
}

// The shared body of spawnCar and respawnOnLane: a slot with nothing left over from its last life.
function resetCar(gd, b, i, type, paint, x, z, yaw, state) {
  gd.carType[i] = type;
  gd.carPaint[i] = paint;
  gd.carState[i] = state;
  gd.carPrevState[i] = state;
  gd.carX[i] = x; gd.carZ[i] = z;
  gd.carYaw[i] = yaw;
  gd.carVX[i] = 0; gd.carVZ[i] = 0;
  gd.carYawRate[i] = 0;
  gd.carSteer[i] = 0; gd.carSteerIn[i] = 0;
  gd.carThrottle[i] = 0;
  gd.carHandbrake[i] = 0;
  gd.carSpeedF[i] = 0; gd.carSlip[i] = 0;
  gd.carHealth[i] = 100;
  gd.carBurnTimer[i] = 0;
  gd.carSmoulder[i] = 0;
  gd.carDent[i * 4] = 0; gd.carDent[i * 4 + 1] = 0;
  gd.carDent[i * 4 + 2] = 0; gd.carDent[i * 4 + 3] = 0;
  gd.carLane[i] = -1;
  gd.carLaneT[i] = 0;
  gd.carNextLane[i] = -1;      // T8: no route decided yet
  gd.carAiTimer[i] = 0;
  gd.carAiWait[i] = 0;
  gd.carBrakeLight[i] = 0;
  gd.carVisPitch[i] = 0; gd.carVisRoll[i] = 0;
  gd.carWheelSpin[i] = 0;
  gd.carSmokeAcc[i] = 0;
  gd.carFireAcc[i] = 0;        // T9
  gd.carDustAcc[i] = 0;        // T9
  gd.carPark[i] = -1;
  gd.skidActive[i * 2] = 0; gd.skidActive[i * 2 + 1] = 0;
  gd.carDirty[i] = 1;          // the Board must build (or rebuild) this car's geometry
  gd.evtCarSpawned++;
}

// Weighted by carSpawnWeight: mostly small hatchbacks and cruisers, one bus in twenty-six.
export function pickType(gd, b) {
  let total = 0;
  for (let t = 0; t < b.carTypeCount; t++) total += b.carSpawnWeight[t];
  let r = gd.rand() * total;
  for (let t = 0; t < b.carTypeCount; t++) {
    r -= b.carSpawnWeight[t];
    if (r <= 0) return t;
  }
  return b.carTypeCount - 1;
}

// Cabs are always taxi yellow, buses come from their own livery set, everything else is a car.
export function pickPaint(gd, b, type) {
  const name = b.carName[type];
  if (name === 'CAB') return b.taxiPaint;
  const list = name === 'BUS' ? b.busPaint : b.carPaint;
  let k = (gd.rand() * list.length) | 0;
  if (k >= list.length) k = list.length - 1;
  return list[k];
}

// -------------------------------------------------------------------------------- parked cars

// b.parkedCount cars in kerbside spots. The spot nearest the player spawn goes first so there is
// always something to steal within a few steps of where the game drops him; the rest are random
// unused spots.
export function placeParkedCars(gd, b) {
  if (gd.parkCount === 0) return;

  let first = 0, bestD = Infinity;
  for (let s = 0; s < gd.parkCount; s++) {
    if (gd.parkUsed[s]) continue;
    const dx = gd.parkX[s] - b.playerSpawnX, dz = gd.parkZ[s] - b.playerSpawnZ;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; first = s; }
  }

  for (let n = 0; n < b.parkedCount; n++) {
    let spot = -1;
    if (n === 0 && bestD < Infinity) {
      spot = first;
    } else {
      for (let a = 0; a < TRIES; a++) {
        let s = (gd.rand() * gd.parkCount) | 0;
        if (s >= gd.parkCount) s = gd.parkCount - 1;
        if (gd.parkUsed[s]) continue;
        spot = s;
        break;
      }
      if (spot < 0) {                       // unlucky run of taken spots: take the next free one
        for (let s = 0; s < gd.parkCount; s++) if (!gd.parkUsed[s]) { spot = s; break; }
      }
    }
    if (spot < 0) return;                   // no kerbside left at all

    const type = pickType(gd, b);
    const i = spawnCar(gd, b, type, pickPaint(gd, b, type), gd.parkX[spot], gd.parkZ[spot],
      gd.parkYaw[spot], CAR_STATE.PARKED);
    if (i < 0) return;                      // pool full
    gd.carHandbrake[i] = 1;
    gd.carPark[i] = spot;
    gd.parkUsed[spot] = 1;
  }
}

// -------------------------------------------------------------------------------- traffic

// True when no other car is already sitting within CAR_GAP metres of t on lane l (car `self` is
// ignored, so a car can be re-placed on the lane it is already on).
function laneSpaceFree(gd, lane, t, self) {
  for (let i = 0; i < gd.carCount; i++) {
    if (i === self || gd.carLane[i] !== lane) continue;
    const d = gd.carLaneT[i] - t;
    if (d < CAR_GAP && d > -CAR_GAP) return false;
  }
  return true;
}

// Drop car i onto lane l at t metres along it, facing the way the lane runs and already doing its
// cruise speed. The centre of the car sits exactly on the lane line.
function putOnLane(gd, b, i, l, t) {
  const dx = gd.laneDirX[l], dz = gd.laneDirZ[l];
  gd.carLane[i] = l;
  gd.carLaneT[i] = t;
  gd.carX[i] = gd.laneX0[l] + dx * t;
  gd.carZ[i] = gd.laneZ0[l] + dz * t;
  gd.carYaw[i] = Math.atan2(dx, dz);       // forward = (sin yaw, cos yaw) = the lane direction
  const cruise = b.carCruise[gd.carType[i]];
  gd.carVX[i] = dx * cruise;
  gd.carVZ[i] = dz * cruise;
  gd.carSpeedF[i] = cruise;
  gd.carSlip[i] = 0;
  gd.carYawRate[i] = 0;
  gd.carHandbrake[i] = 0;
}

// b.trafficCount cars scattered over the lane graph, none of them nose to tail.
export function placeTraffic(gd, b) {
  if (gd.laneCount === 0) return;
  for (let n = 0; n < b.trafficCount; n++) {
    let lane = -1, at = 0;
    for (let a = 0; a < TRIES; a++) {
      let l = (gd.rand() * gd.laneCount) | 0;
      if (l >= gd.laneCount) l = gd.laneCount - 1;
      const len = gd.laneLen[l];
      if (len <= LANE_END_MARGIN * 2) continue;
      const t = LANE_END_MARGIN + gd.rand() * (len - LANE_END_MARGIN * 2);
      // snap through the lane graph, exactly as a respawn does, so both paths agree
      const px = gd.laneX0[l] + gd.laneDirX[l] * t, pz = gd.laneZ0[l] + gd.laneDirZ[l] * t;
      const snapped = nearestLanePoint(gd, b, px, pz);
      if (snapped < 0) continue;
      const st = clampT(gd, snapped, gd.scratch[0]);
      if (!laneSpaceFree(gd, snapped, st, -1)) continue;
      lane = snapped; at = st;
      break;
    }
    if (lane < 0) continue;                 // this one could not find room; the manager tops up

    const type = pickType(gd, b);
    const i = spawnCar(gd, b, type, pickPaint(gd, b, type), 0, 0, 0, CAR_STATE.TRAFFIC);
    if (i < 0) return;                      // pool full
    putOnLane(gd, b, i, lane, at);
  }
}

function clampT(gd, lane, t) {
  const len = gd.laneLen[lane];
  const hi = len - LANE_END_MARGIN;
  if (t < LANE_END_MARGIN) return len > LANE_END_MARGIN * 2 ? LANE_END_MARGIN : len * 0.5;
  if (t > hi) return hi > LANE_END_MARGIN ? hi : len * 0.5;
  return t;
}

// Find somewhere to put a recycled car: a lane point respawnMinDist..respawnMaxDist from the
// player, preferably behind the camera so it never pops into view. Writes the lane to
// gd.scratch[2] and the distance along it to gd.scratch[3]; returns 1 on success, 0 if every
// candidate was blocked by another car.
//
// Candidates are scored rather than filtered, so a bad neighbourhood (the player standing far
// outside the city, say) still yields the closest workable lane point instead of nothing.
function pickRespawnPoint(gd, b, self, px, pz, cfx, cfz) {
  let bestL = -1, bestT = 0, bestScore = Infinity;
  let anyL = -1, anyT = 0, anyScore = Infinity;   // same, but ignoring the spacing rule
  const min = b.respawnMinDist, max = b.respawnMaxDist;
  for (let a = 0; a < RESPAWN_TRIES; a++) {
    const ang = gd.rand() * TWO_PI;
    const rad = min + gd.rand() * (max - min);
    const cx = px + Math.sin(ang) * rad, cz = pz + Math.cos(ang) * rad;
    const l = nearestLanePoint(gd, b, cx, cz);
    if (l < 0) return 0;                    // no lane graph at all
    const t = clampT(gd, l, gd.scratch[0]);

    const dx = gd.laneX0[l] + gd.laneDirX[l] * t - px;
    const dz = gd.laneZ0[l] + gd.laneDirZ[l] * t - pz;
    const d = Math.sqrt(dx * dx + dz * dz);
    let score = 0;
    if (d < min) score = min - d;
    else if (d > max) score = d - max;
    if (dx * cfx + dz * cfz >= 0.2) score += IN_VIEW_PENALTY;   // in front of the camera
    if (score < anyScore) { anyScore = score; anyL = l; anyT = t; }
    if (!laneSpaceFree(gd, l, t, self)) continue;
    if (score < bestScore) { bestScore = score; bestL = l; bestT = t; }
    if (score === 0) break;
  }
  // Crowding must never strand a car on the far side of the world: if every candidate had a
  // neighbour too close, take the best one anyway and let collision sort them out.
  if (bestL < 0) { bestL = anyL; bestT = anyT; }
  if (bestL < 0) return 0;
  gd.scratch[2] = bestL;
  gd.scratch[3] = bestT;
  return 1;
}

// Recycle car i: a fresh type, paint and lane somewhere the player is not looking. The slot keeps
// its index, so the Board just rebuilds it from carDirty.
export function respawnOnLane(gd, b, i) {
  if (gd.laneCount === 0) return 0;
  let cfx = gd.camLookX - gd.camX, cfz = gd.camLookZ - gd.camZ;
  const cl = Math.sqrt(cfx * cfx + cfz * cfz);
  if (cl > 1e-4) { cfx /= cl; cfz /= cl; } else { cfx = 0; cfz = 1; }

  if (!pickRespawnPoint(gd, b, i, gd.playerX, gd.playerZ, cfx, cfz)) return 0;
  const lane = gd.scratch[2] | 0, at = gd.scratch[3];

  const spot = gd.carPark[i];
  if (spot >= 0) gd.parkUsed[spot] = 0;     // a recycled car gives its kerbside spot back

  const type = pickType(gd, b);
  resetCar(gd, b, i, type, pickPaint(gd, b, type), 0, 0, 0, CAR_STATE.TRAFFIC);
  putOnLane(gd, b, i, lane, at);
  return 1;
}

// Called every tick, scans twice a second. Keeps b.trafficCount cars alive around the player and
// nothing allocated: everything below is index arithmetic over the car arrays.
export function manageTraffic(gd, b) {
  if (gd.tick % SCAN_TICKS !== 0) return;
  if (gd.laneCount === 0) return;

  const px = gd.playerX, pz = gd.playerZ;
  const recycle2 = b.recycleDist * b.recycleDist;
  const wreck2 = WRECK_RECYCLE_DIST * WRECK_RECYCLE_DIST;
  const poolTight = gd.carCount >= b.maxCars - POOL_SLACK;

  let live = 0;
  for (let i = 0; i < gd.carCount; i++) {
    const s = gd.carState[i];
    const traffic = s === CAR_STATE.TRAFFIC || s === CAR_STATE.STOPPED;
    if (!traffic && !(poolTight && s === CAR_STATE.WRECK)) continue;

    const dx = gd.carX[i] - px, dz = gd.carZ[i] - pz;
    const d2 = dx * dx + dz * dz;
    if (traffic) {
      if (d2 > recycle2) respawnOnLane(gd, b, i);
      live++;
    } else if (d2 > wreck2) {
      if (respawnOnLane(gd, b, i)) live++;
    }
  }

  // Top the population back up one car per scan — a slow trickle nobody sees arrive.
  if (live < b.trafficCount && gd.carCount < b.maxCars) {
    let cfx = gd.camLookX - gd.camX, cfz = gd.camLookZ - gd.camZ;
    const cl = Math.sqrt(cfx * cfx + cfz * cfz);
    if (cl > 1e-4) { cfx /= cl; cfz /= cl; } else { cfx = 0; cfz = 1; }
    if (pickRespawnPoint(gd, b, -1, px, pz, cfx, cfz)) {
      const lane = gd.scratch[2] | 0, at = gd.scratch[3];
      const type = pickType(gd, b);
      const i = spawnCar(gd, b, type, pickPaint(gd, b, type), 0, 0, 0, CAR_STATE.TRAFFIC);
      if (i >= 0) putOnLane(gd, b, i, lane, at);
    }
  }
}
