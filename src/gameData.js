// GameData: every mutable runtime value, as parallel TypedArrays + counts + scalars.
// Allocated ONCE here, sized from balance. Only Logic modifies it (Board stages input into gd.input).
// Identity is an index. Array + count everywhere. Events accumulate across the ticks of one frame and
// are cleared by main via clearEvents() after the Board has consumed them.
import { mulberry32 } from './rng.js';

export function allocateGameData(gd, b, seed) {
  gd.rand = mulberry32(seed === undefined ? b.seed : seed);
  gd.seed = seed === undefined ? b.seed : seed;
  gd.time = 0;
  gd.tick = 0;

  // ---------------- input (staged by Board, consumed by Logic) ----------------
  gd.input = {
    forward: 0, back: 0, left: 0, right: 0, handbrake: 0,   // held (0/1)
    action: 0,                                               // edge: set by Board on keydown, cleared by Logic at tick end
    camToggle: 0, mute: 0,                                   // edges
    orbitDX: 0, orbitDY: 0,                                  // mouse drag delta this frame (pixels), cleared by Logic
    zoom: 0,                                                 // wheel delta, cleared by Logic
  };

  // ---------------- lane graph ----------------
  const N = b.nodeCount, L = b.laneCount;
  gd.nodeX = new Float32Array(N); gd.nodeZ = new Float32Array(N);
  gd.nodeOutStart = new Int32Array(N); gd.nodeOutCount = new Int32Array(N);
  gd.nodeOutLanes = new Int32Array(L);
  gd.laneX0 = new Float32Array(L); gd.laneZ0 = new Float32Array(L);
  gd.laneX1 = new Float32Array(L); gd.laneZ1 = new Float32Array(L);
  gd.laneDirX = new Float32Array(L); gd.laneDirZ = new Float32Array(L);
  gd.laneLen = new Float32Array(L);
  gd.laneFrom = new Int32Array(L); gd.laneTo = new Int32Array(L);
  gd.laneReverse = new Int32Array(L);
  gd.laneCount = 0; gd.nodeCount = 0;

  // ---------------- blocks / lots ----------------
  gd.blockType = new Uint8Array(b.blockCount);
  gd.blockX = new Float32Array(b.blockCount); gd.blockZ = new Float32Array(b.blockCount);
  gd.blockRing = new Uint8Array(b.blockCount);   // Chebyshev distance from centre (0 = centre 2x2)
  gd.blockCount = 0;

  // ---------------- render boxes (buildings, bands, roof props, landmarks) ----------------
  const RB = b.maxRenderBoxes;
  gd.rbX = new Float32Array(RB); gd.rbY = new Float32Array(RB); gd.rbZ = new Float32Array(RB);   // centre
  gd.rbW = new Float32Array(RB); gd.rbH = new Float32Array(RB); gd.rbD = new Float32Array(RB);   // full size
  gd.rbColor = new Uint32Array(RB);
  gd.rbYaw = new Float32Array(RB);                                                                // usually 0
  gd.rbCount = 0;
  const WB = b.maxWindowBands;
  gd.wbX = new Float32Array(WB); gd.wbY = new Float32Array(WB); gd.wbZ = new Float32Array(WB);
  gd.wbW = new Float32Array(WB); gd.wbH = new Float32Array(WB); gd.wbD = new Float32Array(WB);
  gd.wbCount = 0;

  // ---------------- static colliders (AABB) ----------------
  const C = b.maxColliders;
  gd.colMinX = new Float32Array(C); gd.colMinZ = new Float32Array(C);
  gd.colMaxX = new Float32Array(C); gd.colMaxZ = new Float32Array(C);
  gd.colH = new Float32Array(C);
  gd.colCount = 0;
  // uniform grid for colliders and static props
  const G = b.gridDim * b.gridDim;
  gd.cGridStart = new Int32Array(G); gd.cGridCount = new Int32Array(G); gd.cGridItems = new Int32Array(b.gridItemsCap);
  gd.pGridStart = new Int32Array(G); gd.pGridCount = new Int32Array(G); gd.pGridItems = new Int32Array(b.gridItemsCap);

  // ---------------- props ----------------
  const P = b.maxProps;
  gd.propType = new Uint8Array(P);
  gd.propX = new Float32Array(P); gd.propY = new Float32Array(P); gd.propZ = new Float32Array(P);
  gd.propYaw = new Float32Array(P);
  gd.propScale = new Float32Array(P);          // 1 = default; trees vary 0.8..1.4
  gd.propState = new Uint8Array(P);            // PROP_STATE
  gd.propVX = new Float32Array(P); gd.propVY = new Float32Array(P); gd.propVZ = new Float32Array(P);
  gd.propPitch = new Float32Array(P); gd.propRoll = new Float32Array(P);
  gd.propAngPitch = new Float32Array(P); gd.propAngRoll = new Float32Array(P); gd.propAngYaw = new Float32Array(P);
  gd.propCount = 0;
  gd.knockedList = new Int32Array(P); gd.knockedCount = 0;   // indices of props with state != STATIC (Board updates these)

  // ---------------- parking spots ----------------
  const PS = b.maxParkSpots;
  gd.parkX = new Float32Array(PS); gd.parkZ = new Float32Array(PS); gd.parkYaw = new Float32Array(PS);
  gd.parkUsed = new Uint8Array(PS);
  gd.parkCount = 0;

  // ---------------- cars ----------------
  const M = b.maxCars;
  gd.carType = new Uint8Array(M);
  gd.carPaint = new Uint32Array(M);            // 0xRRGGBB
  gd.carState = new Uint8Array(M);             // CAR_STATE
  gd.carPrevState = new Uint8Array(M);
  gd.carX = new Float32Array(M); gd.carZ = new Float32Array(M);
  gd.carYaw = new Float32Array(M);
  gd.carVX = new Float32Array(M); gd.carVZ = new Float32Array(M);
  gd.carYawRate = new Float32Array(M);
  gd.carSteer = new Float32Array(M);           // current steer angle (rad)
  gd.carSteerIn = new Float32Array(M);         // input -1..1
  gd.carThrottle = new Float32Array(M);        // input -1..1
  gd.carHandbrake = new Uint8Array(M);
  gd.carSpeedF = new Float32Array(M);          // forward speed (signed), written by vehicle
  gd.carSlip = new Float32Array(M);            // |lateral speed|, written by vehicle
  gd.carHealth = new Float32Array(M);
  gd.carBurnTimer = new Float32Array(M);
  gd.carSmoulder = new Float32Array(M);
  gd.carDent = new Float32Array(M * 4);        // SIDE-indexed accumulated dent 0..1
  gd.carLane = new Int32Array(M);              // AI lane index (-1 none)
  gd.carLaneT = new Float32Array(M);           // metres along lane
  gd.carAiTimer = new Float32Array(M);         // stun / wait timer
  gd.carAiWait = new Float32Array(M);          // intersection wait accumulator
  gd.carBrakeLight = new Uint8Array(M);        // 0 off 1 brake 2 reverse
  gd.carVisPitch = new Float32Array(M); gd.carVisRoll = new Float32Array(M);
  gd.carWheelSpin = new Float32Array(M);
  gd.carSmokeAcc = new Float32Array(M);
  gd.carPark = new Int32Array(M);              // park spot index if parked (-1 none)
  gd.carCount = 0;
  // scratch: OBB corners and AABB per car, filled by collision each tick
  gd.carCX = new Float32Array(M * 4); gd.carCZ = new Float32Array(M * 4);
  gd.carMinX = new Float32Array(M); gd.carMaxX = new Float32Array(M);
  gd.carMinZ = new Float32Array(M); gd.carMaxZ = new Float32Array(M);
  gd.scratch = new Float32Array(64);
  gd.scratchI = new Int32Array(64);

  // ---------------- player ----------------
  gd.playerX = 0; gd.playerY = 0; gd.playerZ = 0; gd.playerYaw = 0;
  gd.playerVX = 0; gd.playerVY = 0; gd.playerVZ = 0;
  gd.playerMode = 0;            // PLAYER_MODE
  gd.playerCar = -1;
  gd.playerLastCar = -1;
  gd.playerWalkPhase = 0;
  gd.playerSpeed = 0;
  gd.playerTimer = 0;           // stun / fling timer
  gd.playerTumble = 0;          // visual tumble angle while FLUNG
  gd.nearestCar = -1;           // car the player could steal (for HUD prompt), -1 none
  gd.nearestCarDist = 0;

  // ---------------- camera ----------------
  gd.camX = 0; gd.camY = 5; gd.camZ = 10;
  gd.camLookX = 0; gd.camLookY = 1; gd.camLookZ = 0;
  gd.camFov = 60;
  gd.camYawOffset = 0; gd.camPitchOffset = 0;
  gd.camShake = 0;
  // added T6: the forward the chase camera is currently sitting behind. Held (not recomputed) while
  // the car reverses, so backing up does not whip the camera around to the front; on foot it is the
  // eased camera forward carried between ticks.
  gd.camFwdX = 0; gd.camFwdZ = 1;
  gd.camInit = 0;               // 0 until the first update snaps the camera
  gd.camFree = 0;               // 1 = debug free camera (camX.. set externally, logic leaves them alone)
  gd.camMode = 0;               // 0 chase, 1 far chase (camToggle cycles)

  // ---------------- events (accumulate over a frame; main clears after render) ----------------
  const I = b.maxImpacts;
  gd.impCar = new Int32Array(I); gd.impOther = new Int32Array(I);
  gd.impX = new Float32Array(I); gd.impZ = new Float32Array(I);
  gd.impLocalX = new Float32Array(I); gd.impLocalZ = new Float32Array(I);
  gd.impNX = new Float32Array(I); gd.impNZ = new Float32Array(I);
  gd.impStrength = new Float32Array(I);
  gd.impKind = new Uint8Array(I);
  gd.impCount = 0; gd.impTickStart = 0;
  const E = b.maxExplosions;
  gd.expX = new Float32Array(E); gd.expZ = new Float32Array(E); gd.expStrength = new Float32Array(E);
  gd.expCar = new Int32Array(E);
  gd.expCount = 0; gd.expTickStart = 0;
  const K = b.maxKnocks;
  gd.knockProp = new Int32Array(K); gd.knockStrength = new Float32Array(K);
  gd.knockCount = 0; gd.knockTickStart = 0;
  gd.evtStolenCar = -1;         // car index stolen this frame (-1 none)
  gd.evtExitCar = -1;
  gd.evtCarSpawned = 0;         // count of car slots whose type/paint changed this frame (Board rebuilds)
  gd.carDirty = new Uint8Array(M); // 1 = Board must rebuild this car's geometry (type/paint/wreck changed)

  // ---------------- particles / skids ----------------
  const Q = b.maxParticles;
  gd.pX = new Float32Array(Q); gd.pY = new Float32Array(Q); gd.pZ = new Float32Array(Q);
  gd.pVX = new Float32Array(Q); gd.pVY = new Float32Array(Q); gd.pVZ = new Float32Array(Q);
  gd.pLife = new Float32Array(Q); gd.pMaxLife = new Float32Array(Q);
  gd.pSize = new Float32Array(Q);
  gd.pType = new Uint8Array(Q);
  gd.pR = new Float32Array(Q); gd.pG = new Float32Array(Q); gd.pB = new Float32Array(Q);
  gd.pCount = 0;
  const S = b.maxSkids;
  gd.skidX0 = new Float32Array(S); gd.skidZ0 = new Float32Array(S);
  gd.skidX1 = new Float32Array(S); gd.skidZ1 = new Float32Array(S);
  gd.skidW = new Float32Array(S); gd.skidAge = new Float32Array(S);
  gd.skidHead = 0; gd.skidCount = 0;
  gd.skidLastX = new Float32Array(M * 2); gd.skidLastZ = new Float32Array(M * 2); // last rear-wheel point per car (L,R)
  gd.skidActive = new Uint8Array(M * 2);

  // ---------------- stats ----------------
  gd.statStolen = 0; gd.statWrecked = 0; gd.statDistance = 0; gd.statTopSpeed = 0;
  gd.statBigImpact = 0;   // strongest impact this frame (HUD/audio/shake)
}

export function clearEvents(gd) {
  gd.impCount = 0; gd.impTickStart = 0;
  gd.expCount = 0; gd.expTickStart = 0;
  gd.knockCount = 0; gd.knockTickStart = 0;
  gd.evtStolenCar = -1; gd.evtExitCar = -1;
  gd.evtCarSpawned = 0;
  gd.statBigImpact = 0;
}
