// Camera: pure data — computes camX/Y/Z, camLookX/Y/Z, camFov from the player or player car.
// Logic module: imports only balance, never three, never the DOM, never Math.random.
//
// A chase camera is three separate lags, and keeping them separate is what makes it feel good:
//   - the POSITION springs toward a point behind the target, so hard cornering swings the camera
//     wide and it settles back in;
//   - the FORWARD it sits behind is remembered rather than read fresh, so reversing does not whip
//     it around to the bonnet and standing still on foot does not glue it to the player's back;
//   - the LOOK point leads the target by a speed-scaled look-ahead, so at 30 m/s you are looking at
//     the road you are about to be on, not the roof you are already on.
// Everything is written straight into gd. Board (renderer.js) adds camShake as noise at frame rate.
import { PLAYER_MODE, IMPACT_KIND } from '../balance.js';
import { gridIndex } from './city.js';

const TWO_PI = Math.PI * 2;
const ORBIT_PER_PIXEL = 0.005;
const PITCH_LIMIT = 0.5;
const FOOT_LOOK_AHEAD = 2;
const FOOT_FWD_EASE = 2.5;      // how fast the on-foot camera swings behind the walk direction
const LOOK_SPRING = 1.5;        // the aim is tighter than the body, so the subject stays centred
const FOV_EASE = 3;
const FOV_SPEED_FULL = 35;      // speed at which the FOV reaches camFovMax
const MODE_FAR_DIST = 1.7;
const MODE_FAR_HEIGHT = 1.6;
const REVERSE_HOLD = -2;        // below this forward speed the camera keeps its old forward
// balance's camCarDist / camCarHeight are the pose for a mid-size saloon; these scale it to the
// body actually being driven. Without them the bus (11 m long, 3 m tall) puts the camera four
// metres off its rear bumper with the lens level with its roof, and the road ahead is a wall of
// orange. Reference car is the CRUISER, so a CRUISER gets exactly the balance numbers.
const REF_LEN = 4.6;
const REF_HGT = 1.4;
const DIST_PER_LEN = 0.55;
const HEIGHT_PER_HGT = 0.9;
const MOVING = 1;               // target speed above which the orbit offsets decay
const SHAKE_PER_STRENGTH = 0.05;
const SHAKE_PER_IMPACT = 1.2;
const SHAKE_MAX = 1.2;
const BUILDING_CLEAR = 0.4;     // how far outside a wall the camera is parked
const BUILDING_LIFT = 1.5;      // and how far over the roof when the wall is too deep to escape
const BUILDING_DEEP = 4;
const CAR_LIFT = 1;             // T12: how far over a car's roof the camera is parked

export function updateCamera(gd, b) {
  if (gd.camFree) return;
  const dt = b.dt;
  const inp = gd.input;

  if (inp.camToggle) gd.camMode = gd.camMode === 0 ? 1 : 0;

  // ---- what we are chasing, and the forward we sit behind ----
  const inCar = gd.playerMode === PLAYER_MODE.IN_CAR && gd.playerCar >= 0;
  let tx, ty, tz, speed, dist, height, lookAhead;

  if (inCar) {
    const c = gd.playerCar;
    tx = gd.carX[c]; ty = 0; tz = gd.carZ[c];
    const vF = gd.carSpeedF[c];
    speed = vF < 0 ? -vF : vF;
    // Reversing keeps the last forward: the driver is looking where the car came from, and a
    // camera that spun to the boot at 2 m/s would make reverse unusable.
    if (vF > REVERSE_HOLD) {
      const yaw = gd.carYaw[c];
      gd.camFwdX = Math.sin(yaw);
      gd.camFwdZ = Math.cos(yaw);
    }
    const T = gd.carType[c];
    dist = b.camCarDist + b.camCarDistPerSpeed * speed + (b.carLen[T] - REF_LEN) * DIST_PER_LEN;
    height = b.camCarHeight + (b.carHgt[T] - REF_HGT) * HEIGHT_PER_HGT;
    lookAhead = b.camCarLookAhead + b.camCarLookAheadPerSpeed * speed;
  } else {
    tx = gd.playerX; ty = gd.playerY; tz = gd.playerZ;
    speed = gd.playerSpeed;
    // On foot the forward is wherever the camera already is relative to the player, so standing
    // still lets you look at him from wherever you dragged the camera to. It only creeps around
    // behind him while he is actually walking.
    let fx = tx - gd.camX, fz = tz - gd.camZ;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl > 1e-4) { fx /= fl; fz /= fl; } else { fx = gd.camFwdX; fz = gd.camFwdZ; }
    if (speed > 0.5) {
      let k = FOOT_FWD_EASE * dt;
      if (k > 1) k = 1;
      fx += (Math.sin(gd.playerYaw) - fx) * k;
      fz += (Math.cos(gd.playerYaw) - fz) * k;
      const l = Math.sqrt(fx * fx + fz * fz);
      if (l > 1e-4) { fx /= l; fz /= l; }
    }
    gd.camFwdX = fx;
    gd.camFwdZ = fz;
    dist = b.camFootDist;
    height = b.camFootHeight;
    lookAhead = FOOT_LOOK_AHEAD;
  }

  if (gd.camMode === 1) { dist *= MODE_FAR_DIST; height *= MODE_FAR_HEIGHT; }

  // ---- mouse orbit: yaw around the target, pitch up and over it, both let go once you move ----
  let yawOff = gd.camYawOffset + inp.orbitDX * ORBIT_PER_PIXEL;
  let pitchOff = gd.camPitchOffset + inp.orbitDY * ORBIT_PER_PIXEL;
  if (pitchOff > PITCH_LIMIT) pitchOff = PITCH_LIMIT;
  else if (pitchOff < -PITCH_LIMIT) pitchOff = -PITCH_LIMIT;
  if (speed > MOVING) {
    let k = b.camOrbitDecay * dt;
    if (k > 1) k = 1;
    yawOff -= yawOff * k;
    pitchOff -= pitchOff * k;
  }
  yawOff -= TWO_PI * Math.round(yawOff / TWO_PI);
  gd.camYawOffset = yawOff;
  gd.camPitchOffset = pitchOff;

  const cs = Math.cos(yawOff), sn = Math.sin(yawOff);
  const fwdX = gd.camFwdX * cs + gd.camFwdZ * sn;
  const fwdZ = -gd.camFwdX * sn + gd.camFwdZ * cs;
  const cp = Math.cos(pitchOff), sp = Math.sin(pitchOff);
  const flat = dist * cp;                     // pitch is a real orbit: closer in as it rises
  const up = height + dist * sp;

  // ---- spring the body, and the aim a little tighter ----
  const wantX = tx - fwdX * flat;
  const wantY = ty + up;
  const wantZ = tz - fwdZ * flat;
  const lookX = tx + fwdX * lookAhead;
  const lookY = ty + 1.2;
  const lookZ = tz + fwdZ * lookAhead;

  const snap = gd.camInit === 0;
  let k = snap ? 1 : b.camSpring * dt;
  if (k > 1) k = 1;
  let kl = snap ? 1 : b.camSpring * LOOK_SPRING * dt;
  if (kl > 1) kl = 1;

  gd.camX += (wantX - gd.camX) * k;
  gd.camY += (wantY - gd.camY) * k;
  gd.camZ += (wantZ - gd.camZ) * k;
  gd.camLookX += (lookX - gd.camLookX) * kl;
  gd.camLookY += (lookY - gd.camLookY) * kl;
  gd.camLookZ += (lookZ - gd.camLookZ) * kl;

  let sf = speed / FOV_SPEED_FULL;
  if (sf > 1) sf = 1; else if (sf < 0) sf = 0;
  const wantFov = b.camFovMin + (b.camFovMax - b.camFovMin) * sf;
  let kf = snap ? 1 : FOV_EASE * dt;
  if (kf > 1) kf = 1;
  gd.camFov += (wantFov - gd.camFov) * kf;

  gd.camInit = 1;

  fixInsideBuilding(gd, b);
  fixInsideCar(gd, b);

  // ---- shake: decay first, then this tick's hits, so a hit is always felt at full strength ----
  let decay = 1 - b.camShakeDecay * dt;
  if (decay < 0) decay = 0;
  gd.camShake *= decay;
  const pc = gd.playerCar;
  if (pc >= 0) {
    for (let e = gd.impTickStart; e < gd.impCount; e++) {
      if (gd.impCar[e] !== pc && !(gd.impKind[e] === IMPACT_KIND.CAR && gd.impOther[e] === pc)) continue;
      let s = gd.impStrength[e] * SHAKE_PER_STRENGTH;
      if (s > SHAKE_PER_IMPACT) s = SHAKE_PER_IMPACT;
      gd.camShake += s;
    }
    if (gd.camShake > SHAKE_MAX) gd.camShake = SHAKE_MAX;
  }
}

// The one thing a chase camera must never do is render the inside of a wall. No raycast: the spring
// only ever puts the camera a few metres from the target, so it is enough to notice the frame it
// ends up inside a building footprint and shove it back out through the nearest face. Deep inside a
// big block there is no near face worth using, so it goes over the roof instead.
function fixInsideBuilding(gd, b) {
  const cell = gridIndex(b, gd.camX, gd.camZ);
  if (cell < 0) return;
  const start = gd.cGridStart[cell], n = gd.cGridCount[cell];
  for (let k = 0; k < n; k++) {
    const i = gd.cGridItems[start + k];
    if (gd.camY > gd.colH[i]) continue;                  // clear over the roof already
    const minX = gd.colMinX[i], maxX = gd.colMaxX[i];
    const minZ = gd.colMinZ[i], maxZ = gd.colMaxZ[i];
    if (gd.camX < minX || gd.camX > maxX || gd.camZ < minZ || gd.camZ > maxZ) continue;

    const dW = gd.camX - minX, dE = maxX - gd.camX;
    const dN = gd.camZ - minZ, dS = maxZ - gd.camZ;
    let m = dW, face = 0;
    if (dE < m) { m = dE; face = 1; }
    if (dN < m) { m = dN; face = 2; }
    if (dS < m) { m = dS; face = 3; }
    if (face === 0) gd.camX = minX - BUILDING_CLEAR;
    else if (face === 1) gd.camX = maxX + BUILDING_CLEAR;
    else if (face === 2) gd.camZ = minZ - BUILDING_CLEAR;
    else gd.camZ = maxZ + BUILDING_CLEAR;
    if (m > BUILDING_DEEP) {
      const lift = gd.colH[i] + BUILDING_LIFT;
      if (gd.camY < lift) gd.camY = lift;
    }
  }
}

// T12: the same problem, one storey down. Backing into a kerbside line, or being flung beside one,
// used to leave the camera inside a parked body — and inside a bus that is a full screen of paint.
// Cars move every tick, so shoving the camera sideways out of one would jitter; going over the roof
// is one comparison per car and always resolves. The AABB (refreshed by resolveCollisions earlier
// in the same tick) is enough: a camera inside the box but outside the OBB is already looking along
// the bodywork from a hand's breadth away.
function fixInsideCar(gd, b) {
  const x = gd.camX, z = gd.camZ;
  for (let i = 0; i < gd.carCount; i++) {
    if (x < gd.carMinX[i] || x > gd.carMaxX[i] || z < gd.carMinZ[i] || z > gd.carMaxZ[i]) continue;
    const h = b.carHgt[gd.carType[i]];
    if (gd.camY < h) gd.camY = h + CAR_LIFT;
  }
}
