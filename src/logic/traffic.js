// Traffic AI: lane following, car-ahead braking, intersection yield, and the "shaken driver"
// reaction to being hit (reactToImpacts, which tick() calls after updateDamage rather than from
// updateTraffic — see the comment on it).
// Logic module: imports only balance and sibling Logic modules, never three, never the DOM,
// never Math.random. Allocation-free: plain locals and index arithmetic, no objects, no closures.
//
// A traffic car is a point running along a directed lane. It holds the lane it is on
// (carLane / carLaneT) and the lane it has already decided to take at the far end (carNextLane).
//
// Steering is pure pursuit: aim at the lane point `lookahead` metres ahead, or — once the
// lookahead runs off the end of this lane — at the start of the next one, which is what makes a
// car cut the corner smoothly instead of driving to the kerb and then turning. The aim error in
// car-local coordinates is atan2(lx, lz) with lx left-positive, and carSteerIn > 0 steers LEFT
// (vehicle.js), so the sign carries straight through.
//
// The throttle is a P controller onto one speed target that four things are allowed to pull down:
// the corner ahead, the car in front (both a closing-speed term and a stopping-distance term),
// the intersection ahead, and a hard "brake now" flag. Nothing ever clamps velocity — the AI only
// writes carThrottle / carSteerIn / carHandbrake, exactly like the player.
import { CAR_STATE, IMPACT_KIND } from '../balance.js';
import { nearestLanePoint } from './city.js';

const STEER_GAIN = 1.6;      // aim error (rad) -> steer input; full lock at 0.625 rad
const STRAIGHT_W = 3;        // weight of going straight on at a junction (a turn weighs 1)
// The lane lines cross 3.5 m from a junction centre and nothing here can steer a 3.5 m radius, so
// every right-hander is physically an overshoot — and the longer the wheelbase the wider it is
// (a HAULER needs 6.2 m, a BUS 17.8). Long vehicles therefore go straight on twice as often and
// take the corners they do turn slower, which is both what real ones do and where most of the
// remaining junction sideswipes were coming from.
const LONG_WHEELBASE = 3;    // metres of wheelbase that counts as a long vehicle
const LONG_STRAIGHT_W = 6;   // ...its weight for going straight on
const LONG_CORNER_SCALE = 0.7;  // ...and the fraction of aiCornerSpeed it takes a corner at
const COMMIT = 0.5;          // metres short of the lane end where the car takes the next lane
const OFF_LANE = 6;          // sideways metres off the lane line before it re-acquires
const CROSS_SLACK = 20;      // how far short of a lane's start a car may legitimately be (it is
                             // crossing the intersection that feeds it; lanes stop 7 m out)
const JUNCTION_LOOK = 0.5;   // fraction of the speed lookahead used inside a junction
const CORNER_LOOK = 12;      // start slowing this far before a corner
const CORNER_ALIGN = 0.98;   // cos of the heading error that counts as "out of the corner"
const REAR_KEEP = 5;         // keep watching a car this far behind our nose (still alongside)
const STOP_BOX = 5;          // anything this close in front: stand on the brakes
const FOLLOW_GAP = 2;        // bumper-to-bumper metres the AI wants to leave
const FOLLOW_DECEL = 4.5;    // m/s^2 the stopping-distance speed cap plans for
const REACTION = 0.35;       // seconds of headway the same cap keeps in hand
const CLOSING_GAIN = 0.6;    // fraction of the car's brake the closing reflex is allowed to use
const SAME_WAY = 0.7;        // cos of the heading difference that counts as "the same direction"
const YIELD_LOOK = 10;       // give-way zone: this far back from the lane end
const YIELD_DECEL = 5;       // m/s^2 the give-way speed cap plans for
const YIELD_STOP = 3;        // inside this many metres of the line, wait on the brakes
const NODE_HALF = 8;         // half-width of the intersection square
const MERGE_CLEAR = 10;      // metres of the next lane's mouth that must be empty to turn into it
const MERGE_BACK = 4;        // ...counted from a little before its start
const MERGE_SIDE = 4;        // and this far either side of its line
const SQUEEZE = 1.6;         // furthest sideways the AI will aim to pass a stationary car
const SQUEEZE_MIN = 1.2;     // ...and it only tries when the car is already this far to one side
const SIDE_CLEAR = 0.9;      // metres of air it wants between its flank and that car
const SIDE_WATCH = 3.6;      // it notices a car this far to one side (the ahead box is narrower)
const SIDE_MAX = 2;          // most the aim point may be pushed sideways to miss another car
const STILL2 = 0.25;         // (m/s)^2 below which another car counts as an obstacle, not traffic

export function updateTraffic(gd, b) {
  const dt = b.dt;
  for (let i = 0; i < gd.carCount; i++) {
    const s = gd.carState[i];
    if (s === CAR_STATE.STOPPED) { holdStopped(gd, b, i, dt); continue; }
    if (s !== CAR_STATE.TRAFFIC) continue;
    driveCar(gd, b, i, dt);
  }
}

// ===========================================================================================
// Getting hit
// ===========================================================================================

// The AI's reaction to being hit. tick() calls this after updateDamage, because updateTraffic runs
// BEFORE resolveCollisions: at that point [impTickStart, impCount) is still empty and there is
// nothing to react to. One pass over this tick's impacts rather than a scan per car — a car-car
// impact is pushed twice (once from each side), but impKind CAR also names the other car, so
// either row stuns the pair.
export function reactToImpacts(gd, b) {
  for (let k = gd.impTickStart; k < gd.impCount; k++) {
    if (gd.impStrength[k] <= b.aiStunImpact) continue;
    stun(gd, b, gd.impCar[k]);
    if (gd.impKind[k] === IMPACT_KIND.CAR) stun(gd, b, gd.impOther[k]);
  }
}

// The driver is shaken: hands off the wheel, handbrake on, for aiStunMin..aiStunMax seconds.
function stun(gd, b, i) {
  if (i < 0 || i >= gd.carCount) return;
  const s = gd.carState[i];
  if (s !== CAR_STATE.TRAFFIC && s !== CAR_STATE.STOPPED) return;
  gd.carState[i] = CAR_STATE.STOPPED;
  gd.carAiTimer[i] = b.aiStunMin + gd.rand() * (b.aiStunMax - b.aiStunMin);
  gd.carAiWait[i] = 0;
  gd.carThrottle[i] = 0;
  gd.carSteerIn[i] = 0;
  gd.carHandbrake[i] = 1;
}

function holdStopped(gd, b, i, dt) {
  gd.carThrottle[i] = 0;
  gd.carSteerIn[i] = 0;
  gd.carHandbrake[i] = 1;
  const t = gd.carAiTimer[i] - dt;
  if (t > 0) { gd.carAiTimer[i] = t; return; }

  gd.carAiTimer[i] = 0;
  gd.carAiWait[i] = 0;
  gd.carHandbrake[i] = 0;
  gd.carState[i] = CAR_STATE.TRAFFIC;
  const yaw = gd.carYaw[i];
  acquireLane(gd, b, i, Math.sin(yaw), Math.cos(yaw));   // a spin may have left it anywhere
}

// ===========================================================================================
// The lane graph
// ===========================================================================================

// A long vehicle prefers to stay on the straight and slows more for the corners it does take.
function straightWeight(b, type) {
  return b.carWheelbase[type] >= LONG_WHEELBASE ? LONG_STRAIGHT_W : STRAIGHT_W;
}

function cornerSpeed(b, type) {
  return b.carWheelbase[type] >= LONG_WHEELBASE ? b.aiCornerSpeed * LONG_CORNER_SCALE : b.aiCornerSpeed;
}

// Snap car i onto the lane graph and pick its route out of the far end. nearestLanePoint answers
// with the closest lane whichever way it runs, so a car facing back down it takes the other side
// of the road instead of driving into the oncoming traffic.
function acquireLane(gd, b, i, fx, fz) {
  let l = nearestLanePoint(gd, b, gd.carX[i], gd.carZ[i]);
  if (l < 0) { gd.carLane[i] = -1; gd.carNextLane[i] = -1; return -1; }
  if (gd.laneDirX[l] * fx + gd.laneDirZ[l] * fz < 0 && gd.laneReverse[l] >= 0) l = gd.laneReverse[l];

  const len = gd.laneLen[l];
  let t = (gd.carX[i] - gd.laneX0[l]) * gd.laneDirX[l] + (gd.carZ[i] - gd.laneZ0[l]) * gd.laneDirZ[l];
  if (t < 0) t = 0; else if (t > len) t = len;
  gd.carLane[i] = l;
  gd.carLaneT[i] = t;
  gd.carNextLane[i] = chooseNextLane(gd, l, straightWeight(b, gd.carType[i]));
  return l;
}

// True when the car has lost its lane: more than OFF_LANE sideways off the line, or stranded far
// short of a lane it never reached. A car that has just committed to the next lane is legitimately
// short of its start by up to ~15 m (the two 7 m trims plus the corner), hence CROSS_SLACK.
function offLane(gd, lane, x, z) {
  const dirX = gd.laneDirX[lane], dirZ = gd.laneDirZ[lane];
  const ex = x - gd.laneX0[lane], ez = z - gd.laneZ0[lane];
  const along = ex * dirX + ez * dirZ;
  if (along < 0) return ex * ex + ez * ez > CROSS_SLACK * CROSS_SLACK;
  const side = ez * dirX - ex * dirZ;               // metres right of the lane line
  return side > OFF_LANE || side < -OFF_LANE;
}

// A lane out of laneTo(lane), never the one straight back (no U-turns). Straight on outweighs a
// turn straightW:1. Every draw comes from gd.rand(), so a seed replays exactly.
function chooseNextLane(gd, lane, straightW) {
  const to = gd.laneTo[lane], rev = gd.laneReverse[lane];
  const dx = gd.laneDirX[lane], dz = gd.laneDirZ[lane];
  const s = gd.nodeOutStart[to], n = gd.nodeOutCount[to];

  let total = 0;
  for (let k = 0; k < n; k++) {
    const l = gd.nodeOutLanes[s + k];
    if (l === rev) continue;
    total += (gd.laneDirX[l] * dx + gd.laneDirZ[l] * dz > 0.5) ? straightW : 1;
  }
  if (total <= 0) return rev;                       // dead end: back the way we came is all there is

  let r = gd.rand() * total, last = rev;
  for (let k = 0; k < n; k++) {
    const l = gd.nodeOutLanes[s + k];
    if (l === rev) continue;
    last = l;
    r -= (gd.laneDirX[l] * dx + gd.laneDirZ[l] * dz > 0.5) ? straightW : 1;
    if (r <= 0) return l;
  }
  return last;                                      // float slop on the last bucket
}

// ===========================================================================================
// Driving
// ===========================================================================================

function driveCar(gd, b, i, dt) {
  const T = gd.carType[i];
  const x = gd.carX[i], z = gd.carZ[i];
  const yaw = gd.carYaw[i];
  const fx = Math.sin(yaw), fz = Math.cos(yaw);     // forward
  const gx = fz, gz = -fx;                          // left = (cos yaw, -sin yaw)
  const speed = gd.carSpeedF[i];
  const fwd = speed > 0 ? speed : 0;

  // ---- which lane are we on ----
  let lane = gd.carLane[i];
  if (lane < 0 || offLane(gd, lane, x, z)) lane = acquireLane(gd, b, i, fx, fz);
  if (lane < 0) {                                   // no lane graph at all
    gd.carThrottle[i] = 0; gd.carSteerIn[i] = 0; gd.carHandbrake[i] = 0;
    return;
  }

  let dirX = gd.laneDirX[lane], dirZ = gd.laneDirZ[lane];
  let len = gd.laneLen[lane];
  let along = (x - gd.laneX0[lane]) * dirX + (z - gd.laneZ0[lane]) * dirZ;

  const straightW = straightWeight(b, T);
  let next = gd.carNextLane[i];
  if (next < 0 || gd.laneFrom[next] !== gd.laneTo[lane]) {
    next = chooseNextLane(gd, lane, straightW);
    gd.carNextLane[i] = next;
  }

  // ---- run off the end: take the lane we already chose and pick the one after it ----
  if (along >= len - COMMIT && next >= 0) {
    lane = next;
    gd.carLane[i] = lane;
    gd.carAiWait[i] = 0;                            // through the junction: stop counting
    dirX = gd.laneDirX[lane]; dirZ = gd.laneDirZ[lane];
    len = gd.laneLen[lane];
    along = (x - gd.laneX0[lane]) * dirX + (z - gd.laneZ0[lane]) * dirZ;
    next = chooseNextLane(gd, lane, straightW);
    gd.carNextLane[i] = next;
  }

  const t = along < 0 ? 0 : (along > len ? len : along);
  gd.carLaneT[i] = t;

  // ---- the point to aim at ----
  // t is clamped, so a car still crossing a junction (along < 0) aims `lookahead` metres down the
  // lane it is heading for rather than at the bare start point: a target it is about to arrive at
  // carries no direction, and cars used to sail past the corner still facing the old way. Past the
  // end of this lane the lookahead carries on into the next one, which is what turns a corner into
  // an arc instead of a stop-and-swivel. Inside the junction it is also shortened (JUNCTION_LOOK),
  // because a long one there lets the car swing metres wide of the lane it is turning into — and
  // that wide arc is what sideswipes whatever is already on it.
  let tx, tz;
  const ta = t + b.aiLookaheadMin + b.aiLookaheadPerSpeed * fwd * (along < 0 ? JUNCTION_LOOK : 1);
  if (ta <= len || next < 0) {
    const c = ta > len ? len : ta;
    tx = gd.laneX0[lane] + dirX * c;
    tz = gd.laneZ0[lane] + dirZ * c;
  } else {
    const over = ta - len;
    tx = gd.laneX0[next] + gd.laneDirX[next] * over;
    tz = gd.laneZ0[next] + gd.laneDirZ[next] * over;
  }

  // ---- speed target: cruise, dropped for the corner we are entering or leaving ----
  let target = b.carCruise[T];
  const corner = cornerSpeed(b, T);
  if (along < 0) {
    if (dirX * fx + dirZ * fz < CORNER_ALIGN && target > corner) target = corner;
  } else if (next >= 0 && (gd.laneDirX[next] !== dirX || gd.laneDirZ[next] !== dirZ)
             && len - t < CORNER_LOOK && target > corner) {
    target = corner;
  }

  // ---- the car in front ----
  const hw = b.carWid[T] * 0.5, hl = b.carLen[T] * 0.5;
  const boxLen = b.aiAheadBoxLen + fwd * 0.6;
  let hard = 0, aim = 0, closeCap = 1;
  for (let j = 0; j < gd.carCount; j++) {
    if (j === i) continue;
    const ex = gd.carX[j] - x, ez = gd.carZ[j] - z;
    const oz = ex * fx + ez * fz;
    if (oz > boxLen || oz < -REAR_KEEP) continue;
    const ox = ex * gx + ez * gz;
    const ax = ox < 0 ? -ox : ox;
    if (ax >= SIDE_WATCH) continue;
    if (ax >= b.aiAheadBoxHalfW && oz > hl) continue;   // outside the ahead box and not alongside

    const Tj = gd.carType[j];
    const need = hw + b.carWid[Tj] * 0.5 + SIDE_CLEAR;
    if (ax >= need) continue;                       // it already misses our flank

    const jvx = gd.carVX[j], jvz = gd.carVZ[j];
    const shift = need - ax + 0.1;
    // Two cases where the answer is to move over rather than to brake, because braking does
    // nothing about a car that is beside you:
    //   - it IS beside us (a car merging out of a corner into an occupied lane, mostly);
    //   - it is a kerbside parked car. The lane line runs 1.9 m from the parking spots, so a car
    //     that stopped for those would never move again.
    const beside = oz < hl + b.carLen[Tj] * 0.5;
    if (shift <= SIDE_MAX
        && (beside || (jvx * jvx + jvz * jvz < STILL2 && ax > SQUEEZE_MIN && shift <= SQUEEZE))) {
      const sgn = ox <= 0 ? shift : -shift;
      if ((sgn < 0 ? -sgn : sgn) > (aim < 0 ? -aim : aim)) aim = sgn;
      continue;
    }
    if (oz <= 0) continue;                          // alongside or behind: nothing to brake for

    if (oz < STOP_BOX) { hard = 1; continue; }
    const theirF = jvx * fx + jvz * fz;             // their speed along OUR forward
    const gap = oz - hl - b.carLen[Tj] * 0.5 - FOLLOW_GAP;
    const plan = gap - fwd * REACTION;              // a tick of lag costs a metre at cruise
    const safe = theirF + (plan > 0 ? Math.sqrt(2 * FOLLOW_DECEL * plan) : 0);
    if (safe < target) target = safe;
    // On top of that, brake for the closing speed — but scaled by the room left, so it is a lift
    // of the throttle at twenty metres and a stamp on the pedal at two. (closing^2 / 2*gap is the
    // deceleration the gap actually demands; CLOSING_GAIN of the car's brake is what it will spend
    // on it.) A flat -closing*k instead makes every car stand on the brakes for a slower car far
    // ahead, and a road of those is a concertina.
    const closing = speed - theirF;
    if (closing > 0) {
      const room = gap > 0.1 ? gap : 0.1;
      const c = -(closing * closing) / (2 * room * b.carBrake[T] * CLOSING_GAIN);
      if (c < closeCap) closeCap = c;
    }
  }

  // ---- give way at the junction ahead ----
  if (along >= 0 && len - t < YIELD_LOOK) {
    // Impatience (aiIntersectionWaitMax) settles a priority dispute — it never licenses driving
    // into a junction somebody is still in. Without that split a car stuck in a queue banks up
    // four seconds of waiting and then barges out blind.
    const impatient = gd.carAiWait[i] > b.aiIntersectionWaitMax;
    const node = gd.laneTo[lane];
    const nx = gd.nodeX[node], nz = gd.nodeZ[node];
    // Turning left crosses the oncoming lane, so a left-turner also gives way to it. Going
    // straight or turning right, only crossing traffic matters — a car going our way is the
    // car-ahead rule's problem, and stopping for it would mean one car per junction at a time.
    const turnLeft = next >= 0 && (gd.laneDirX[next] * dirZ - gd.laneDirZ[next] * dirX) > 0;
    const myDX = x - nx, myDZ = z - nz;
    const myD2 = myDX * myDX + myDZ * myDZ;
    // The mouth of the lane we are turning into: driving into an occupied one is how a car ends up
    // grinding along the flank of another, which braking can do nothing about once it has happened.
    const nOK = next >= 0 ? 1 : 0;
    const nx0 = nOK ? gd.laneX0[next] : 0, nz0 = nOK ? gd.laneZ0[next] : 0;
    const ndx = nOK ? gd.laneDirX[next] : 0, ndz = nOK ? gd.laneDirZ[next] : 0;
    let busy = 0;
    for (let j = 0; j < gd.carCount; j++) {
      if (j === i) continue;
      const s = gd.carState[j];
      if (s !== CAR_STATE.TRAFFIC && s !== CAR_STATE.STOPPED && s !== CAR_STATE.PLAYER) continue;
      const jx = gd.carX[j], jz = gd.carZ[j];
      if (nOK) {
        const nt = (jx - nx0) * ndx + (jz - nz0) * ndz;
        if (nt > -MERGE_BACK && nt < MERGE_CLEAR) {
          let nsd = (jz - nz0) * ndx - (jx - nx0) * ndz;
          if (nsd < 0) nsd = -nsd;
          if (nsd < MERGE_SIDE) { busy = 1; break; }
        }
      }
      const jdx = jx - nx, jdz = jz - nz;
      let ax = jdx < 0 ? -jdx : jdx;
      let az = jdz < 0 ? -jdz : jdz;
      const inSquare = ax < NODE_HALF && az < NODE_HALF;
      const jd2 = jdx * jdx + jdz * jdz;
      // In the square, or on its way in and nearer to it than we are. The distance test is a
      // total order (index breaks the tie), so two cars can never each wait for the other.
      if (!inSquare) {
        if (impatient) continue;
        if (jd2 > (YIELD_LOOK + NODE_HALF) * (YIELD_LOOK + NODE_HALF)) continue;
        if (jd2 > myD2 || (jd2 === myD2 && j > i)) continue;
        const jyaw = gd.carYaw[j];
        if (-jdx * Math.sin(jyaw) - jdz * Math.cos(jyaw) <= 0) continue;   // heading away
      }
      if ((jx - x) * fx + (jz - z) * fz < 0) continue;   // already past us: it is leaving
      const jyaw = gd.carYaw[j];
      const dot = Math.sin(jyaw) * fx + Math.cos(jyaw) * fz;
      if (dot > SAME_WAY) continue;                       // going our way, not across us
      if (dot < -SAME_WAY && !turnLeft) continue;         // oncoming, and we are not cutting across
      busy = 1;
      break;
    }
    if (busy) {
      if (!impatient) gd.carAiWait[i] += dt;
      const room = len - t - 1;
      const cap = room > 0 ? Math.sqrt(2 * YIELD_DECEL * room) : 0;
      if (cap < target) target = cap;
      if (len - t < YIELD_STOP) hard = 1;
    } else {
      gd.carAiWait[i] = 0;
    }
  }

  // ---- inputs ----
  let throttle = (target - speed) * 0.5;
  if (throttle > closeCap) throttle = closeCap;
  if (hard) throttle = -1;
  else if (throttle > 1) throttle = 1;
  else if (throttle < -1) throttle = -1;
  gd.carThrottle[i] = throttle;
  gd.carHandbrake[i] = (hard === 1 && speed < 1) ? 1 : 0;

  const ex = tx - x, ez = tz - z;
  const lx = ex * gx + ez * gz + aim;
  const lz = ex * fx + ez * fz;
  let steer = Math.atan2(lx, lz) * STEER_GAIN;
  if (steer > 1) steer = 1; else if (steer < -1) steer = -1;
  gd.carSteerIn[i] = steer;
}
