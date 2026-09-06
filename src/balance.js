// Balance: every tuning constant, table and palette. Set at author time, never modified at runtime.
// Colours are 0xRRGGBB numbers. Distances in metres, speeds in m/s, times in seconds.

export const CAR_STATE = { PARKED: 0, TRAFFIC: 1, PLAYER: 2, WRECK: 3, BURNING: 4, STOPPED: 5 };
export const PLAYER_MODE = { FOOT: 0, IN_CAR: 1, FLUNG: 2, STUNNED: 3 };
export const BLOCK_TYPE = { BUILDINGS: 0, PARK: 1, PLAZA: 2, LOWRISE: 3 };
export const PROP_TYPE = { TREE: 0, PINE: 1, PALM: 2, LAMP: 3, HYDRANT: 4, MAILBOX: 5, BIN: 6, BENCH: 7, CONE: 8, FOUNTAIN: 9 };
export const PROP_STATE = { STATIC: 0, FLYING: 1, RESTING: 2 };
export const PARTICLE = { SMOKE: 0, FIRE: 1, SPARK: 2, DEBRIS: 3, DUST: 4, SHOCK: 5, GLASS: 6 };
export const IMPACT_KIND = { WORLD: 0, CAR: 1, PROP: 2, BOUNDS: 3 };
export const SIDE = { FRONT: 0, REAR: 1, LEFT: 2, RIGHT: 3 };

export const balance = {
  seed: 7,
  dt: 1 / 60,
  maxTicksPerFrame: 4,

  // ---- city layout ----
  blocksX: 8,
  blocksZ: 8,
  cell: 54,          // road-centre to road-centre pitch
  roadW: 14,         // full road width (two lanes)
  laneOffset: 3.5,   // lane centre distance from road centre (right-hand traffic)
  sidewalkW: 3,
  curbH: 0.15,
  cityHalf: 216,     // blocksX * cell / 2 ; road centrelines at -216 + i*54, i=0..8
  worldHalf: 256,    // soft boundary
  waterZ: 240,       // water starts here (south)
  promenadeZ: 223,   // promenade strip between outer road and water
  nodeCount: 81,     // 9 x 9 intersections
  laneCount: 288,    // 2 dirs x 2 axes x 9 roads x 8 segments
  blockCount: 64,

  // ---- capacities (all arrays sized from these once) ----
  maxCars: 150,
  maxProps: 1600,
  maxRenderBoxes: 3200,
  maxWindowBands: 3000,
  maxColliders: 480,
  // raised T2: the §5.1 kerbside spacing (both sides of all 144 road segments, a spot every 7 m
  // from 12 m past each intersection = 5 per side) yields 1440 spots, which 800 could not hold.
  maxParkSpots: 1600,
  maxParticles: 4000,
  maxSkids: 1024,
  maxImpacts: 96,
  maxExplosions: 8,
  maxKnocks: 48,
  maxLots: 300,

  // ---- collision grid (static buildings and static props) ----
  gridOrigin: -256,
  gridCellSize: 32,
  gridDim: 16,             // 16 x 16 cells covering -256..256
  gridItemsCap: 4096,

  // ---- traffic / population ----
  trafficCount: 40,
  // T12: 70 parked cars over 144 road segments left the kerbs looking empty. 90 is the most the
  // pool allows — validate() wants trafficCount + parkedCount + 20 <= maxCars, and 40+90+20 = 150.
  parkedCount: 90,
  recycleDist: 260,
  respawnMinDist: 120,
  respawnMaxDist: 220,
  aiLookaheadMin: 4,
  aiLookaheadPerSpeed: 0.55,
  aiAheadBoxLen: 14,
  aiAheadBoxHalfW: 2.6,
  aiIntersectionWaitMax: 4,
  aiStunImpact: 6,
  aiStunMin: 5,
  aiStunMax: 10,
  aiCornerSpeed: 6,

  // ---- damage ----
  damageMinImpact: 3,      // m/s of normal impact speed before any damage
  damagePerMs: 4.5,        // health per m/s over the minimum (times type fragility)
  smokeHealth: 60,
  fireHealth: 30,
  burnTime: 3,
  explosionRadius: 8,
  explosionDamage: 40,
  explosionImpulse: 14,
  explosionKnockRadius: 10,
  explosionFlingRadius: 6,
  wreckSmoulderTime: 20,
  dentPerStrength: 1 / 20,

  // ---- player ----
  playerSpawnX: 11,          // added T1: where startGame drops the player (plaza-side pavement)
  playerSpawnZ: 11,          // added T1
  // Retuned T6. Facing +Z put the chase camera 6 m north of the spawn — which is the kerb of the
  // z=0 road, where a bus is always parked, so the opening frame of the game was the inside of a
  // bus. Facing north instead puts the camera on the open plaza behind him and the street, the
  // traffic and the downtown skyline in front.
  playerSpawnYaw: Math.PI,   // added T1: facing -Z (north), toward the street
  playerRadius: 0.4,
  playerSpeed: 6.5,
  playerAccel: 30,
  playerEnterDist: 3.2,
  playerStunTime: 1.5,
  playerFlingSpeed: 9,
  playerFlingUp: 5,
  gravity: 18,

  // ---- camera ----
  camCarDist: 9,
  camCarDistPerSpeed: 0.06,
  camCarHeight: 3.6,
  camCarLookAhead: 6,
  camCarLookAheadPerSpeed: 0.25,
  camFovMin: 60,
  camFovMax: 78,
  camFootDist: 6,
  camFootHeight: 2.6,
  camSpring: 6,
  camShakeDecay: 4,
  camOrbitDecay: 1.5,
  titleOrbitRadius: 70,      // added T1: title-card camera orbit around the plaza
  titleOrbitHeight: 38,      // added T1

  // ---- particles ----
  particleGravity: 9,
  smokeRate: 18,   // particles per second at heavy damage
  skidSlipThreshold: 3.5,

  // ---- car types (parallel arrays; index = type id) ----
  carTypeCount: 7,
  carName:        ['PIP', 'CRUISER', 'COMET', 'HAULER', 'BOXVAN', 'CAB', 'BUS'],
  carLen:         new Float32Array([3.6, 4.6, 4.3, 5.2, 5.0, 4.6, 11.0]),
  carWid:         new Float32Array([1.7, 1.85, 1.95, 2.0, 2.05, 1.85, 2.5]),
  carHgt:         new Float32Array([1.5, 1.4, 1.15, 1.8, 2.2, 1.45, 3.0]),
  carMass:        new Float32Array([900, 1300, 1150, 1900, 1800, 1300, 9000]),
  carMaxSpeed:    new Float32Array([24, 32, 44, 30, 26, 32, 20]),
  carAccel:       new Float32Array([7, 8, 13, 8, 6, 8, 3.5]),
  carBrake:       new Float32Array([14, 14, 16, 12, 12, 14, 8]),
  carGrip:        new Float32Array([8, 7, 9, 6, 6, 7, 5]),
  carDriftGrip:   new Float32Array([2.5, 2.2, 2.6, 2.0, 2.0, 2.2, 1.8]),
  carSteerMax:    new Float32Array([0.55, 0.5, 0.45, 0.48, 0.45, 0.5, 0.35]),
  carWheelbase:   new Float32Array([2.3, 2.8, 2.6, 3.2, 3.0, 2.8, 6.5]),
  carWheelRadius: new Float32Array([0.32, 0.34, 0.33, 0.4, 0.38, 0.34, 0.5]),
  carFragility:   new Float32Array([1.2, 1.0, 1.4, 0.8, 0.85, 1.0, 0.45]),
  carCruise:      new Float32Array([11, 12, 13, 11, 10, 12, 9]),
  carSpawnWeight: new Float32Array([3, 4, 1.5, 2, 2, 2.5, 0.6]),
  // physics shared
  // Retuned T4. The engine fades as accel*(1 - (v/maxSpeed)^2), so at 95% of maxSpeed a car only
  // has ~10% of its accel left to spend on drag. The original 0.9 / 0.008 cost 37 m/s^2 at 32 m/s
  // and pinned the CRUISER at 7.8 m/s — below its own carCruise, which validate() forbids as a
  // pairing and which no traffic car could ever reach. These values leave carMaxSpeed as the real
  // top speed (every type settles at 96-98% of it) and give a realistic ~0.4 m/s^2 coast-down.
  rollingDrag: 0.008,      // per second, linear
  quadDrag: 0.0002,        // per (m/s), quadratic
  slipThreshold: 6,        // lateral speed where grip drops to drift grip
  restitutionWorld: 0.25,
  restitutionCar: 0.3,
  wreckDrag: 3.0,

  // ---- prop types (parallel arrays; index = PROP_TYPE) ----
  propTypeCount: 10,
  propStatic: new Uint8Array([1, 1, 1, 0, 0, 0, 0, 0, 0, 1]),
  propRadius: new Float32Array([0.5, 0.45, 0.4, 0.25, 0.3, 0.3, 0.35, 0.9, 0.3, 3.2]),
  propMass:   new Float32Array([0, 0, 0, 60, 45, 35, 15, 40, 3, 0]),
  propHeight: new Float32Array([6, 7, 8, 5.5, 0.8, 1.2, 1.0, 0.9, 0.7, 2.5]),

  // ---- palettes ----
  carPaint: [
    0xe5473c, 0xf28a2e, 0xf5c542, 0x3ea86b, 0x2bb3a3, 0x3b7bd9,
    0x2d4a8a, 0x8a5bd6, 0xef7bb0, 0xf4f1ea, 0x2b2f38, 0xb8bec7, 0x7fd1e8, 0xd94f8a,
  ],
  taxiPaint: 0xf7c531,
  busPaint: [0x3b7bd9, 0xf28a2e, 0x2bb3a3, 0xe5473c],
  buildingPaint: {
    downtown: [0xd9e3ea, 0xb7c7d6, 0xf3e6cf, 0xe2b992, 0x7fa8c9, 0x9bb7c4, 0xf0d5b5, 0xc9d7e0],
    midrise:  [0xff8a7a, 0xf6a08a, 0xffc09a, 0xf8e8c8, 0xe8b84a, 0xa9c98d, 0x8fd3b6, 0x9ccbe8, 0xb8a6e0, 0xd0704f, 0xf2efe6, 0x58b0a8],
    lowrise:  [0xf8e8c8, 0xffc09a, 0xf2efe6, 0xfaf0dc, 0xffd6a5, 0xe6d5b8, 0xd8e8d0, 0xf5b5a0, 0xc8dff0],
    landmark: [0xf7f2e8, 0x6fa3d8],
    band:     [0x2f3b52, 0x8a3b2f, 0x2f6b5a, 0xc96a3a, 0x3e4a63, 0x6b3f7a],
    // T12: 0x2a3448 was near-black against pale downtown paint and read as tape, not glass.
    window:   0x35415a,
    roofProp: 0xa9a49a,
  },
  colors: {
    road: 0x4a4d5a, roadLine: 0xf2c14e, roadWhite: 0xf3efe4, sidewalk: 0xd9d0c0, curb: 0xc4b9a6,
    grass: 0x7fc65a, parkGrass: 0x6fbf4f, plaza: 0xe9d9c1, promenade: 0xe6cfa9, water: 0x3fa7d6,
    waterDeep: 0x2f8fc4, pier: 0x9c6b46, hills: 0x7fb069, hillsFar: 0x8fb98a,
    skyZenith: 0x4f8fd9, skyHorizon: 0xffd1a3, fog: 0xffd6b0, sun: 0xffdcae, hemiSky: 0xbcd6ff,
    hemiGround: 0xd9a26c, cloud: 0xfff6ec, trunk: 0x8a5a3c, canopy: 0x57b048, canopy2: 0x3f9d3a,
    pine: 0x2f8f5b, palm: 0x4aa84e, lamp: 0x3b3f4a, lampHead: 0xfff1c0, hydrant: 0xe0453a,
    mailbox: 0x3b62c9, bin: 0x4b6a3e, bench: 0xb56b3f, cone: 0xff7a1a, fountain: 0xd8d0c0,
    glass: 0x2a3d55, tyre: 0x23252b, hub: 0xb9bcc4, chrome: 0xd8dde3, headlight: 0xfff3c4,
    // T12: wreck was 0x2e2a28 — a warm grey that, lit by a 24 deg golden-hour sun, came back
    // brown rather than charred. 0x1e1b19 is the same hue two stops down and reads as burnt.
    taillight: 0x7a1414, taillightOn: 0xff3b2e, wreck: 0x1e1b19, skid: 0x2a2a2e,
    skin: 0xf1c27d, shirt: 0xe84a5f, pants: 0x2f4a7a, shoes: 0x2b2b2b, hair: 0x3b2a1e,
  },
  // T3: sun 2.4 / hemi 1.1 left cast shadows barely darker than lit tarmac — at 24 deg elevation a
  // horizontal surface only collects 0.41 of the sun, so the sky fill was over half the ground's
  // light. 3.0 / 1.0 keeps the same golden-hour hues, gives the long shadows real contrast and
  // still leaves shadowed tarmac readable rather than black.
  sun: { elevationDeg: 24, azimuthDeg: 235, intensity: 3.0, hemiIntensity: 1.0, shadowHalf: 110,
         shadowMap: 4096, shadowMapHeadless: 2048, fogNear: 220, fogFar: 720 },
};

export function validate(b) {
  const errs = [];
  if (b.blocksX * b.cell !== b.cityHalf * 2) errs.push('cityHalf must equal blocksX*cell/2');
  // city.js buildCones walks blocksX+1 on BOTH axes, so a non-square grid would silently lose or
  // duplicate a row of intersections rather than fail a length check.
  if (b.blocksX !== b.blocksZ) errs.push('city generation assumes a square grid');
  if ((b.blocksX + 1) * (b.blocksZ + 1) !== b.nodeCount) errs.push('nodeCount mismatch');
  if (2 * ((b.blocksX + 1) * b.blocksZ + (b.blocksZ + 1) * b.blocksX) !== b.laneCount) errs.push('laneCount mismatch');
  if (b.blocksX * b.blocksZ !== b.blockCount) errs.push('blockCount mismatch');
  if (b.gridOrigin + b.gridCellSize * b.gridDim < b.worldHalf) errs.push('grid does not cover worldHalf');
  if (b.trafficCount + b.parkedCount + 20 > b.maxCars) errs.push('maxCars too small for traffic+parked+wreck slack');
  const n = b.carTypeCount;
  for (const k of ['carName', 'carLen', 'carWid', 'carHgt', 'carMass', 'carMaxSpeed', 'carAccel', 'carBrake', 'carGrip',
    'carDriftGrip', 'carSteerMax', 'carWheelbase', 'carWheelRadius', 'carFragility', 'carCruise', 'carSpawnWeight']) {
    if (b[k].length !== n) errs.push(`${k} length != carTypeCount`);
  }
  for (let i = 0; i < n; i++) {
    if (b.carWheelbase[i] >= b.carLen[i]) errs.push(`car ${i} wheelbase >= length`);
    if (b.carMaxSpeed[i] <= b.carCruise[i]) errs.push(`car ${i} cruise >= max speed`);
  }
  const p = b.propTypeCount;
  for (const k of ['propStatic', 'propRadius', 'propMass', 'propHeight']) {
    if (b[k].length !== p) errs.push(`${k} length != propTypeCount`);
  }
  if (b.laneOffset * 2 >= b.roadW) errs.push('lanes wider than road');
  if (b.smokeHealth <= b.fireHealth) errs.push('smokeHealth must exceed fireHealth');
  if (errs.length) throw new Error('balance invalid:\n' + errs.join('\n'));
}
