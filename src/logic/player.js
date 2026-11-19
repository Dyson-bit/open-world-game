// Player: on-foot movement, car enter/exit, stun and fling.
// Logic module: imports only balance, never three, never the DOM, never Math.random.
//
// Four modes (PLAYER_MODE), one branch each, and one thing they all share: the nearest-car scan,
// which the HUD reads for its "E to steal" prompt and FOOT reads for the enter edge.
//
// Conventions (spec §3): +X east, +Y up, +Z south; yaw θ has forward (sin θ, cos θ) and right
// (-cos θ, sin θ). On foot the input is CAMERA relative — W is "away from the camera", which is
// what every third-person game means by forward — so the stick is rotated by the camera's yaw
// before it becomes a velocity.
import { CAR_STATE, PLAYER_MODE } from '../balance.js';
import { pushOutCircle } from './collision.js';

const TWO_PI = Math.PI * 2;
const YAW_EASE = 14;        // how fast the body swings to face the walk direction, per second
const WALK_PHASE_RATE = 1.6;
const TUMBLE_RATE = 9;      // radians per second while flung
const ENGINE_BRAKE = -0.12; // throttle applied against the direction of travel when coasting
const COAST_DEADBAND = 0.5; // below this speed the engine lets go entirely

export function updatePlayer(gd, b) {
  const dt = b.dt;
  const inp = gd.input;

  scanNearestCar(gd, b);

  const mode = gd.playerMode;
  if (mode === PLAYER_MODE.FOOT) updateFoot(gd, b, inp, dt);
  else if (mode === PLAYER_MODE.IN_CAR) updateInCar(gd, b, inp, dt);
  else if (mode === PLAYER_MODE.FLUNG) updateFlung(gd, b, dt);
  else updateStunned(gd, b, dt);
}

// ---------------------------------------------------------------- nearest car

// Distance from the player to each car's body, approximated as centre distance minus a quarter of
// the car's length — close enough to the OBB edge for a prompt, and one sqrt per car. The player's
// own car never counts: while IN_CAR the player sits at its centre, so it would always win.
// nearestCarDist can go slightly negative when he is pressed against a long car; that is the honest
// answer and the HUD can round it.
function scanNearestCar(gd, b) {
  const px = gd.playerX, pz = gd.playerZ;
  const own = gd.playerCar;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < gd.carCount; i++) {
    const s = gd.carState[i];
    if (s === CAR_STATE.WRECK || s === CAR_STATE.BURNING || i === own) continue;
    const dx = gd.carX[i] - px, dz = gd.carZ[i] - pz;
    const d = Math.sqrt(dx * dx + dz * dz) - b.carLen[gd.carType[i]] * 0.25;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || bestD > b.playerEnterDist) {
    gd.nearestCar = -1;
    gd.nearestCarDist = best < 0 ? 0 : bestD;
  } else {
    gd.nearestCar = best;
    gd.nearestCarDist = bestD;
  }
}

// ---------------------------------------------------------------- on foot

function updateFoot(gd, b, inp, dt) {
  // The camera's yaw, not the player's: W walks away from the lens. camLook - cam is the look
  // direction; its XZ part is the screen's "into the picture".
  let fx = gd.camLookX - gd.camX, fz = gd.camLookZ - gd.camZ;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-4) { fx /= fl; fz /= fl; } else { fx = Math.sin(gd.playerYaw); fz = Math.cos(gd.playerYaw); }
  const rx = -fz, rz = fx;                       // screen right = forward x up

  const drive = inp.forward - inp.back;
  const strafe = inp.right - inp.left;
  let dx = fx * drive + rx * strafe;
  let dz = fz * drive + rz * strafe;
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-4) { dx /= dl; dz /= dl; } else { dx = 0; dz = 0; }

  // Accelerate toward the wanted velocity at playerAccel m/s^2 — a cap on the change, not a lerp,
  // so stopping is as brisk as starting and neither depends on the frame rate.
  const tvx = dx * b.playerSpeed, tvz = dz * b.playerSpeed;
  let ax = tvx - gd.playerVX, az = tvz - gd.playerVZ;
  const al = Math.sqrt(ax * ax + az * az);
  const step = b.playerAccel * dt;
  if (al > step) { const k = step / al; ax *= k; az *= k; }
  let vx = gd.playerVX + ax, vz = gd.playerVZ + az;

  const px = gd.playerX + vx * dt;
  const pz = gd.playerZ + vz * dt;

  // One pass over the static world: pushOutCircle (collision.js) does buildings, props and cars.
  pushOutCircle(gd, b, px, pz, b.playerRadius);
  const nx = gd.scratch[0], nz = gd.scratch[1];

  // Anything a wall gave back is velocity that was heading into the wall: drop that component so
  // the player slides along the face instead of grinding to a halt against it.
  const ox = nx - px, oz = nz - pz;
  const ol = Math.sqrt(ox * ox + oz * oz);
  if (ol > 1e-6) {
    const ux = ox / ol, uz = oz / ol;
    const into = vx * ux + vz * uz;
    if (into < 0) { vx -= ux * into; vz -= uz * into; }
  }

  gd.playerX = nx; gd.playerZ = nz; gd.playerY = 0;
  gd.playerVX = vx; gd.playerVZ = vz; gd.playerVY = 0;

  const sp = Math.sqrt(vx * vx + vz * vz);
  gd.playerSpeed = sp;
  if (sp > 0.5) {
    const want = Math.atan2(vx, vz);
    let d = want - gd.playerYaw;
    d -= TWO_PI * Math.round(d / TWO_PI);        // shortest way round
    let k = YAW_EASE * dt;
    if (k > 1) k = 1;
    let yaw = gd.playerYaw + d * k;
    yaw -= TWO_PI * Math.round(yaw / TWO_PI);    // wrapped, so a long session keeps its precision
    gd.playerYaw = yaw;
  }
  gd.playerWalkPhase += sp * dt * WALK_PHASE_RATE;
  if (gd.playerWalkPhase > TWO_PI * 1024) gd.playerWalkPhase -= TWO_PI * 1024;

  if (inp.action && gd.nearestCar >= 0) enterCar(gd, b, gd.nearestCar);
}

// ---------------------------------------------------------------- driving

function updateInCar(gd, b, inp, dt) {
  const c = gd.playerCar;
  if (c < 0) { gd.playerMode = PLAYER_MODE.FOOT; return; }

  gd.carSteerIn[c] = inp.left - inp.right;       // A steers LEFT, which raises yaw (spec §3)
  gd.carHandbrake[c] = inp.handbrake;
  const speedF = gd.carSpeedF[c];

  if (inp.forward || inp.back) {
    gd.carThrottle[c] = inp.forward - inp.back;
  } else {
    // Engine braking. T4 retuned rollingDrag/quadDrag right down so every type can actually reach
    // its carMaxSpeed, which left a coasting car rolling for an age. Lifting off now leans on the
    // engine: a small throttle against the direction of travel, released inside a dead band so it
    // can never drag the car backwards from a standstill.
    const a = speedF < 0 ? -speedF : speedF;
    gd.carThrottle[c] = a > COAST_DEADBAND ? (speedF > 0 ? ENGINE_BRAKE : -ENGINE_BRAKE) : 0;
  }

  // The player IS the car while he is in it: traffic management, the HUD and the shadow focus all
  // read playerX/playerZ, and none of them should have to know about playerCar.
  gd.playerX = gd.carX[c];
  gd.playerY = 0;
  gd.playerZ = gd.carZ[c];
  gd.playerYaw = gd.carYaw[c];
  const a = speedF < 0 ? -speedF : speedF;
  gd.playerSpeed = a;
  gd.statDistance += a * dt;

// Money rewards: $50 every 100 meters driven
gd.moneyDistance += a * dt;

if (gd.moneyDistance >= 100) {
  const rewards = Math.floor(gd.moneyDistance / 100);
  gd.money += rewards * 50;
  gd.moneyDistance -= rewards * 100;
}

if (a > gd.statTopSpeed) gd.statTopSpeed = a;

  if (inp.action) exitCar(gd, b);
}

// ---------------------------------------------------------------- flung / stunned

function updateFlung(gd, b, dt) {
  gd.playerVY -= b.gravity * dt;
  gd.playerX += gd.playerVX * dt;
  gd.playerY += gd.playerVY * dt;
  gd.playerZ += gd.playerVZ * dt;
  gd.playerTumble += TUMBLE_RATE * dt;
  gd.playerSpeed = Math.sqrt(gd.playerVX * gd.playerVX + gd.playerVZ * gd.playerVZ);
  if (gd.playerY <= 0) {
    gd.playerY = 0;
    gd.playerVX = 0; gd.playerVY = 0; gd.playerVZ = 0;
    gd.playerSpeed = 0;
    gd.playerMode = PLAYER_MODE.STUNNED;
    gd.playerTimer = b.playerStunTime;
  }
}

function updateStunned(gd, b, dt) {
  gd.playerSpeed = 0;
  gd.playerTimer -= dt;
  if (gd.playerTimer <= 0) {
    gd.playerTimer = 0;
    gd.playerTumble = 0;
    gd.playerMode = PLAYER_MODE.FOOT;
  }
}

// ---------------------------------------------------------------- enter / exit

// Also the debug hook's way in (window.__game.enterNearestCar), so it takes the car index rather
// than re-deciding which one, and tolerates a bad one.
export function enterCar(gd, b, i) {
  if (i < 0 || i >= gd.carCount) return;
  const s = gd.carState[i];
  if (s === CAR_STATE.WRECK || s === CAR_STATE.BURNING) return;

  gd.playerMode = PLAYER_MODE.IN_CAR;
  gd.playerCar = i;
  gd.carPrevState[i] = s;
  gd.carState[i] = CAR_STATE.PLAYER;
  gd.carLane[i] = -1;                            // it is nobody's traffic problem now
  const spot = gd.carPark[i];
  if (spot >= 0) { gd.parkUsed[spot] = 0; gd.carPark[i] = -1; }
  gd.carThrottle[i] = 0;
  gd.carSteerIn[i] = 0;
  gd.carHandbrake[i] = 0;                        // exitCar leaves it on; getting in releases it

  gd.playerX = gd.carX[i];
  gd.playerY = 0;
  gd.playerZ = gd.carZ[i];
  gd.playerYaw = gd.carYaw[i];
  gd.playerVX = 0; gd.playerVY = 0; gd.playerVZ = 0;
  gd.playerSpeed = 0;

  gd.statStolen++;
  gd.evtStolenCar = i;
}

export function exitCar(gd, b) {
  const i = gd.playerCar;
  if (i < 0) return;

  // Out of the LEFT door: mesh-local +X is the left flank, which is world (cos θ, -sin θ).
  const yaw = gd.carYaw[i];
  const d = b.carWid[gd.carType[i]] * 0.5 + 0.9;
  gd.playerX = gd.carX[i] + Math.cos(yaw) * d;
  gd.playerY = 0;
  gd.playerZ = gd.carZ[i] - Math.sin(yaw) * d;
  gd.playerYaw = yaw;
  gd.playerVX = gd.carVX[i] * 0.3;               // he keeps a little of the car's momentum
  gd.playerVY = 0;
  gd.playerVZ = gd.carVZ[i] * 0.3;
  gd.playerSpeed = Math.sqrt(gd.playerVX * gd.playerVX + gd.playerVZ * gd.playerVZ);
  gd.playerMode = PLAYER_MODE.FOOT;
  gd.playerCar = -1;
  gd.playerLastCar = i;

  // A wreck stays a wreck; anything else is parked where he left it, handbrake on. Testing the
  // state rather than the health is what guarantees no car is ever left in CAR_STATE.PLAYER with
  // nobody in it — a car whose health hit 0 this tick is still PLAYER here, and updateDamage
  // (which runs later in the same tick) is the thing that turns it into a wreck.
  const s = gd.carState[i];
  if (s === CAR_STATE.WRECK || s === CAR_STATE.BURNING) {
    gd.carHandbrake[i] = 0;
  } else {
    gd.carState[i] = CAR_STATE.PARKED;
    gd.carHandbrake[i] = 1;
  }
  gd.carThrottle[i] = 0;
  gd.carSteerIn[i] = 0;
  gd.evtExitCar = i;
}
