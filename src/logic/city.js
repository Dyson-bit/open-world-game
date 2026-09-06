// City generation: lane graph, blocks, buildings, props, parking spots, collision grid.
// Logic module: imports only balance, never three, never the DOM, never Math.random.
//
// generateCity() runs exactly once, from startGame(), so local temporaries are fine in here.
// The three query helpers below (nearestLanePoint / gridIndex / isOnRoad) are called from the
// tick and are strictly allocation-free.
import { BLOCK_TYPE, PROP_TYPE, PROP_STATE } from '../balance.js';

// ===========================================================================================
// Query helpers (hot path: no allocation, no closures)
// ===========================================================================================

// Signed distance from v to the nearest road centreline on that axis, or a huge number when v
// is past the outermost road. Centrelines are at -cityHalf + k*cell for k = 0..blocks.
function roadOffset(b, v, blocks) {
  const k = Math.round((v + b.cityHalf) / b.cell);
  if (k < 0 || k > blocks) return 1e9;
  return v - (-b.cityHalf + k * b.cell);
}

// True when (x, z) is on the tarmac: within half a road width of a centreline on either axis,
// and inside the outer road edge (cityHalf + roadW/2 = 223 m).
export function isOnRoad(b, x, z) {
  const half = b.cityHalf + b.roadW * 0.5;
  if (x < -half || x > half || z < -half || z > half) return false;
  const w = b.roadW * 0.5;
  if (Math.abs(roadOffset(b, x, b.blocksX)) <= w) return true;
  if (Math.abs(roadOffset(b, z, b.blocksZ)) <= w) return true;
  return false;
}

// Uniform collision-grid cell for a world point, or -1 when the point is off the grid.
export function gridIndex(b, x, z) {
  const cx = Math.floor((x - b.gridOrigin) / b.gridCellSize);
  const cz = Math.floor((z - b.gridOrigin) / b.gridCellSize);
  if (cx < 0 || cz < 0 || cx >= b.gridDim || cz >= b.gridDim) return -1;
  return cz * b.gridDim + cx;
}

// Nearest point on any lane segment to (x, z). Returns the lane index (-1 only if there are no
// lanes) and writes the distance along that lane, in metres, to gd.scratch[0].
export function nearestLanePoint(gd, b, x, z) {
  let best = -1, bestD = Infinity, bestT = 0;
  for (let l = 0; l < gd.laneCount; l++) {
    const dx = gd.laneDirX[l], dz = gd.laneDirZ[l], len = gd.laneLen[l];
    let t = (x - gd.laneX0[l]) * dx + (z - gd.laneZ0[l]) * dz;
    if (t < 0) t = 0; else if (t > len) t = len;
    const ex = gd.laneX0[l] + dx * t - x, ez = gd.laneZ0[l] + dz * t - z;
    const d = ex * ex + ez * ez;
    if (d < bestD) { bestD = d; best = l; bestT = t; }
  }
  gd.scratch[0] = bestT;
  return best;
}

// ===========================================================================================
// Seeded scalar helpers — every random number in this file comes from gd.rand()
// ===========================================================================================

function rr(gd, lo, hi) { return lo + gd.rand() * (hi - lo); }
function ri(gd, n) { const v = (gd.rand() * n) | 0; return v >= n ? n - 1 : v; }
function pick(gd, arr) { return arr[ri(gd, arr.length)]; }

// ===========================================================================================
// Array writers — plain functions, array + count, silently skip when a cap is reached
// ===========================================================================================

function addBox(gd, b, x, y, z, w, h, d, color) {
  if (gd.rbCount >= b.maxRenderBoxes) return -1;
  const i = gd.rbCount++;
  gd.rbX[i] = x; gd.rbY[i] = y; gd.rbZ[i] = z;
  gd.rbW[i] = w; gd.rbH[i] = h; gd.rbD[i] = d;
  gd.rbColor[i] = color; gd.rbYaw[i] = 0;
  return i;
}

function addWindowBand(gd, b, x, y, z, w, h, d) {
  if (gd.wbCount >= b.maxWindowBands) return -1;
  const i = gd.wbCount++;
  gd.wbX[i] = x; gd.wbY[i] = y; gd.wbZ[i] = z;
  gd.wbW[i] = w; gd.wbH[i] = h; gd.wbD[i] = d;
  return i;
}

function addCollider(gd, b, minX, minZ, maxX, maxZ, h) {
  if (gd.colCount >= b.maxColliders) return -1;
  const i = gd.colCount++;
  gd.colMinX[i] = minX; gd.colMinZ[i] = minZ;
  gd.colMaxX[i] = maxX; gd.colMaxZ[i] = maxZ;
  gd.colH[i] = h;
  return i;
}

function addProp(gd, b, type, x, z, yaw, scale) {
  if (gd.propCount >= b.maxProps) return -1;
  const i = gd.propCount++;
  gd.propType[i] = type;
  gd.propX[i] = x; gd.propY[i] = 0; gd.propZ[i] = z;
  gd.propYaw[i] = yaw; gd.propScale[i] = scale;
  gd.propState[i] = PROP_STATE.STATIC;
  gd.propVX[i] = 0; gd.propVY[i] = 0; gd.propVZ[i] = 0;
  gd.propPitch[i] = 0; gd.propRoll[i] = 0;
  gd.propAngPitch[i] = 0; gd.propAngRoll[i] = 0; gd.propAngYaw[i] = 0;
  return i;
}

function addParkSpot(gd, b, x, z, yaw) {
  if (gd.parkCount >= b.maxParkSpots) return -1;
  const i = gd.parkCount++;
  gd.parkX[i] = x; gd.parkZ[i] = z; gd.parkYaw[i] = yaw; gd.parkUsed[i] = 0;
  return i;
}

// ===========================================================================================
// Lane graph
// ===========================================================================================

// One directed lane from node `from` to node `to`, offset laneOffset to the right of travel and
// trimmed by roadW/2 at each end so it starts and stops at the intersection edge.
function addLane(gd, b, from, to, dx, dz) {
  const l = gd.laneCount++;
  const ox = -dz * b.laneOffset, oz = dx * b.laneOffset;   // right of (dx,dz)
  const trim = b.roadW * 0.5;
  gd.laneX0[l] = gd.nodeX[from] + ox + dx * trim;
  gd.laneZ0[l] = gd.nodeZ[from] + oz + dz * trim;
  gd.laneX1[l] = gd.nodeX[to] + ox - dx * trim;
  gd.laneZ1[l] = gd.nodeZ[to] + oz - dz * trim;
  gd.laneDirX[l] = dx; gd.laneDirZ[l] = dz;
  gd.laneLen[l] = b.cell - b.roadW;
  gd.laneFrom[l] = from; gd.laneTo[l] = to;
  gd.laneReverse[l] = -1;
  return l;
}

function buildLaneGraph(gd, b) {
  const NX = b.blocksX + 1, NZ = b.blocksZ + 1;
  gd.nodeCount = NX * NZ;
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const n = j * NX + i;
      gd.nodeX[n] = -b.cityHalf + i * b.cell;
      gd.nodeZ[n] = -b.cityHalf + j * b.cell;
    }
  }

  // Fixed emission order so lane indices are stable: horizontal roads row by row (east then
  // west per segment), then vertical roads column by column (south then north).
  gd.laneCount = 0;
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < b.blocksX; i++) {
      const a = j * NX + i, c = j * NX + i + 1;
      const e = addLane(gd, b, a, c, 1, 0);
      const w = addLane(gd, b, c, a, -1, 0);
      gd.laneReverse[e] = w; gd.laneReverse[w] = e;
    }
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < b.blocksZ; j++) {
      const a = j * NX + i, c = (j + 1) * NX + i;
      const s = addLane(gd, b, a, c, 0, 1);
      const n = addLane(gd, b, c, a, 0, -1);
      gd.laneReverse[s] = n; gd.laneReverse[n] = s;
    }
  }

  // CSR of outgoing lanes per node: count, prefix-sum, fill.
  gd.nodeOutCount.fill(0);
  for (let l = 0; l < gd.laneCount; l++) gd.nodeOutCount[gd.laneFrom[l]]++;
  let acc = 0;
  for (let n = 0; n < gd.nodeCount; n++) {
    gd.nodeOutStart[n] = acc; acc += gd.nodeOutCount[n]; gd.nodeOutCount[n] = 0;
  }
  for (let l = 0; l < gd.laneCount; l++) {
    const f = gd.laneFrom[l];
    gd.nodeOutLanes[gd.nodeOutStart[f] + gd.nodeOutCount[f]] = l;
    gd.nodeOutCount[f]++;
  }
}

// ===========================================================================================
// Blocks
// ===========================================================================================

function parkAdjacent(gd, b, bi, bj) {
  if (bi > 0 && gd.blockType[bj * b.blocksX + bi - 1] === BLOCK_TYPE.PARK) return true;
  if (bi < b.blocksX - 1 && gd.blockType[bj * b.blocksX + bi + 1] === BLOCK_TYPE.PARK) return true;
  if (bj > 0 && gd.blockType[(bj - 1) * b.blocksX + bi] === BLOCK_TYPE.PARK) return true;
  if (bj < b.blocksZ - 1 && gd.blockType[(bj + 1) * b.blocksX + bi] === BLOCK_TYPE.PARK) return true;
  return false;
}

// Turn `want` blocks of the given ring into parks, never two orthogonally adjacent. Seeded
// rejection sampling with a deterministic in-order fallback so the count is always met.
function chooseParks(gd, b, ring, want) {
  let placed = 0;
  for (let guard = 0; guard < 400 && placed < want; guard++) {
    const bi = ri(gd, b.blocksX), bj = ri(gd, b.blocksZ);
    const k = bj * b.blocksX + bi;
    if (gd.blockRing[k] !== ring || gd.blockType[k] === BLOCK_TYPE.PARK) continue;
    if (parkAdjacent(gd, b, bi, bj)) continue;
    gd.blockType[k] = BLOCK_TYPE.PARK;
    placed++;
  }
  for (let k = 0; k < b.blockCount && placed < want; k++) {
    if (gd.blockRing[k] !== ring || gd.blockType[k] === BLOCK_TYPE.PARK) continue;
    if (parkAdjacent(gd, b, k % b.blocksX, (k / b.blocksX) | 0)) continue;
    gd.blockType[k] = BLOCK_TYPE.PARK;
    placed++;
  }
}

function buildBlocks(gd, b) {
  const halfI = (b.blocksX - 1) * 0.5, halfJ = (b.blocksZ - 1) * 0.5;
  gd.blockCount = b.blockCount;
  for (let bj = 0; bj < b.blocksZ; bj++) {
    for (let bi = 0; bi < b.blocksX; bi++) {
      const k = bj * b.blocksX + bi;
      gd.blockX[k] = -b.cityHalf + b.cell * 0.5 + bi * b.cell;
      gd.blockZ[k] = -b.cityHalf + b.cell * 0.5 + bj * b.cell;
      const ring = Math.max(Math.abs(bi - halfI), Math.abs(bj - halfJ)) - 0.5;
      gd.blockRing[k] = ring;
      gd.blockType[k] = ring === 0 ? BLOCK_TYPE.PLAZA
        : ring === 3 ? BLOCK_TYPE.LOWRISE : BLOCK_TYPE.BUILDINGS;
    }
  }
  chooseParks(gd, b, 2, 2);
  chooseParks(gd, b, 3, 3);
}

// ===========================================================================================
// Buildings
// ===========================================================================================

function paletteFor(b, ring) {
  if (ring === 1) return b.buildingPaint.downtown;
  if (ring === 2) return b.buildingPaint.midrise;
  return b.buildingPaint.lowrise;
}

// Window glazing for one building: one thin band per floor, floor pitch 3.2 m from y = 4.4.
// Bands that would straddle the step between the base box and the setback box are skipped.
//
// T12: the band was 1.1 m on a 3.2 m pitch — a third of every facade in near-black, which from
// street level reads as zebra tape rather than glass. 0.8 m keeps the same floor rhythm and leaves
// two thirds of the wall as paint; the lighter buildingPaint.window does the rest.
const WINDOW_BAND_H = 0.8;

function addBuildingWindows(gd, b, cx, cz, h1, w, d, topY, topW, topD) {
  for (let y = 4.4; y + 0.55 < topY; y += 3.2) {
    if (Math.abs(y - h1) < 0.9) continue;
    const above = y > h1;
    const bw = above ? topW : w, bd = above ? topD : d;
    addWindowBand(gd, b, cx, y, cz, bw + 0.12, WINDOW_BAND_H, bd + 0.12);
  }
}

// One building on one lot: a stack of boxes, plus its ground band, roof clutter and glazing.
// Only the base box becomes a collider.
function addBuilding(gd, b, cx, cz, lotW, lotD, ring) {
  const inset = ring === 3 ? 2.5 : 1.5;
  const w = lotW - inset * 2, d = lotD - inset * 2;
  if (w < 3 || d < 3) return;

  const hMin = ring === 1 ? 18 : ring === 2 ? 9 : 5;
  const hMax = ring === 1 ? 48 : ring === 2 ? 20 : 10;
  const color = pick(gd, paletteFor(b, ring));
  const h1 = rr(gd, hMin, hMax);

  addBox(gd, b, cx, h1 * 0.5, cz, w, h1, d, color);
  addCollider(gd, b, cx - w * 0.5, cz - d * 0.5, cx + w * 0.5, cz + d * 0.5, h1);

  let topY = h1, topW = w, topD = d;
  if (gd.rand() < 0.4) {
    const e = rr(gd, 2, 4);
    const w2 = w - e, d2 = d - e;
    if (w2 > 2.5 && d2 > 2.5) {
      const h2 = h1 * rr(gd, 0.4, 0.7);
      addBox(gd, b, cx, h1 + h2 * 0.5, cz, w2, h2, d2, color);
      topY = h1 + h2; topW = w2; topD = d2;
    }
  }

  // ground-floor colour band
  if (gd.rand() < 0.45) {
    addBox(gd, b, cx, 1.8, cz, w + 0.3, 3.6, d + 0.3, pick(gd, b.buildingPaint.band));
  }

  // roof clutter: AC units and water tanks
  if (topY >= 9) {
    const n = 1 + ri(gd, 3);
    for (let k = 0; k < n; k++) {
      const tank = gd.rand() < 0.35;
      const pw = tank ? 1.6 : 1.5, ph = tank ? 2.4 : 1.2, pd = tank ? 1.6 : 1.5;
      const rx = Math.max(0, topW * 0.5 - pw * 0.5 - 0.3);
      const rz = Math.max(0, topD * 0.5 - pd * 0.5 - 0.3);
      addBox(gd, b, cx + rr(gd, -rx, rx), topY + ph * 0.5, cz + rr(gd, -rz, rz),
        pw, ph, pd, b.buildingPaint.roofProp);
    }
  }

  // towers get a crown slab and an antenna
  if (ring === 1 && h1 > 30) {
    addBox(gd, b, cx, topY + 0.5, cz, topW + 0.6, 1, topD + 0.6, color);
    const ah = rr(gd, 6, 12);
    addBox(gd, b, cx, topY + 1 + ah * 0.5, cz, 0.6, ah, 0.6, b.buildingPaint.roofProp);
    topY += 1;
  }

  if (topY >= 9 && gd.rand() < 0.65) addBuildingWindows(gd, b, cx, cz, h1, w, d, topY, topW, topD);
}

// Split a 34 m lot area into 1..9 lots and put a building on each.
function buildBuildingBlock(gd, b, k, ring) {
  const bx = gd.blockX[k], bz = gd.blockZ[k], lot = 34;
  let nx = 1, nz = 1;
  if (ring === 1) {
    if (gd.rand() < 0.6) { nx = 1; nz = 1; }
    else if (gd.rand() < 0.5) { nx = 2; nz = 1; }
    else { nx = 1; nz = 2; }
  } else if (ring === 2) {
    if (gd.rand() < 0.6) { nx = 2; nz = 2; }
    else if (gd.rand() < 0.5) { nx = 1; nz = 2; }
    else { nx = 2; nz = 1; }
  } else {
    if (gd.rand() < 0.5) { nx = 2; nz = 2; }
    else { nx = 3; nz = 3; }
  }
  const lw = lot / nx, ld = lot / nz;
  for (let jj = 0; jj < nz; jj++) {
    for (let ii = 0; ii < nx; ii++) {
      addBuilding(gd, b, bx - lot * 0.5 + (ii + 0.5) * lw, bz - lot * 0.5 + (jj + 0.5) * ld, lw, ld, ring);
    }
  }
}

// ===========================================================================================
// Parks, plazas, the landmark tower
// ===========================================================================================

// Trees scattered inside the 34 m lot area, at least 3 m apart and clear of the centrepiece
// (a square keep-out, so it also works for the square landmark tower footprint).
function scatterTrees(gd, b, bx, bz, first, count, spread, clearR) {
  let placed = 0;
  for (let guard = 0; guard < count * 40 && placed < count; guard++) {
    const px = bx + rr(gd, -spread, spread), pz = bz + rr(gd, -spread, spread);
    if (Math.abs(px - bx) < clearR && Math.abs(pz - bz) < clearR) continue;
    let ok = true;
    for (let q = first; q < gd.propCount; q++) {
      const dx = gd.propX[q] - px, dz = gd.propZ[q] - pz;
      if (dx * dx + dz * dz < 9) { ok = false; break; }
    }
    if (!ok) continue;
    const type = gd.rand() < 0.3 ? PROP_TYPE.PINE : PROP_TYPE.TREE;
    addProp(gd, b, type, px, pz, rr(gd, 0, 6.283185), rr(gd, 0.85, 1.35));
    placed++;
  }
}

function buildPark(gd, b, k) {
  const bx = gd.blockX[k], bz = gd.blockZ[k];
  addBox(gd, b, bx, 0.05, bz, 40, 0.1, 40, b.colors.parkGrass);
  const first = gd.propCount;
  addProp(gd, b, PROP_TYPE.FOUNTAIN, bx, bz, 0, 1);
  for (let s = 0; s < 4; s++) {
    const a = s * (Math.PI / 2);
    const ox = Math.sin(a) * 6, oz = Math.cos(a) * 6;
    addProp(gd, b, PROP_TYPE.BENCH, bx + ox, bz + oz, Math.atan2(-ox, -oz), 1);
  }
  scatterTrees(gd, b, bx, bz, first, 10 + ri(gd, 5), 15, 8);
}

// T12 plaza furniture. A ring-0 block was 40 m of bare pavement with four benches and four trees
// on it, and in the tower's shadow that reads as an unfinished slab. These fill it without
// touching the landmark's 18 m footprint (±9 m) or the fountain: a ring of planter boxes each
// with a tree standing on top, two more benches on the axis the diagonal four leave bare, and two
// lamps flanking the corner that faces the middle of the 2x2 plaza.
const BENCH_R = 15;
const PLANTER_R = 12.5;                 // clear of the tower, inside the benches
const PLANTER_W = 2.4, PLANTER_H = 0.6, PLANTER_D = 1.2;
const PLANTER_PAINT = 0xd0704f;         // terracotta, from the midrise palette
const PLAZA_LAMP_A = 16, PLAZA_LAMP_B = 8;

// Ring-0 blocks: a paved slab, benches, planters, lamps and trees; the fountain only on (4,4).
function buildPlaza(gd, b, k, bi, bj) {
  const bx = gd.blockX[k], bz = gd.blockZ[k];
  addBox(gd, b, bx, 0.06, bz, 40, 0.12, 40, b.colors.plaza);
  const first = gd.propCount;
  if (bi === 4 && bj === 4) addProp(gd, b, PROP_TYPE.FOUNTAIN, bx, bz, 0, 1);
  // benches on the diagonals, outside the landmark tower's 18 m footprint
  for (let s = 0; s < 4; s++) {
    const a = s * (Math.PI / 2) + Math.PI / 4;
    const ox = Math.sin(a) * BENCH_R, oz = Math.cos(a) * BENCH_R;
    addProp(gd, b, PROP_TYPE.BENCH, bx + ox, bz + oz, Math.atan2(-ox, -oz), 1);
  }
  for (let s = -1; s <= 1; s += 2) {                 // T12: two more, facing the centre
    const oz = s * BENCH_R;
    addProp(gd, b, PROP_TYPE.BENCH, bx, bz + oz, Math.atan2(0, -oz), 1);
  }

  // T12: 4-6 planters. The box is decoration; the tree standing on it is the collider, and its
  // propY lifts it onto the planter's lid.
  const planters = 4 + ri(gd, 3);
  for (let s = 0; s < planters; s++) {
    const a = s * (Math.PI * 2 / planters);
    const px = bx + Math.sin(a) * PLANTER_R, pz = bz + Math.cos(a) * PLANTER_R;
    const boxI = addBox(gd, b, px, PLANTER_H * 0.5, pz, PLANTER_W, PLANTER_H, PLANTER_D, PLANTER_PAINT);
    if (boxI >= 0) gd.rbYaw[boxI] = a;               // long axis tangential to the ring
    const tree = addProp(gd, b, PROP_TYPE.TREE, px, pz, rr(gd, 0, 6.283185), rr(gd, 0.7, 0.95));
    if (tree >= 0) gd.propY[tree] = PLANTER_H;
  }

  // T12: two lamps flanking the inner corner (the one facing the middle of the plaza group)
  const sx = bi === 3 ? 1 : -1, sz = bj === 3 ? 1 : -1;
  addProp(gd, b, PROP_TYPE.LAMP, bx + sx * PLAZA_LAMP_A, bz + sz * PLAZA_LAMP_B, 0, 1);
  addProp(gd, b, PROP_TYPE.LAMP, bx + sx * PLAZA_LAMP_B, bz + sz * PLAZA_LAMP_A, 0, 1);

  scatterTrees(gd, b, bx, bz, first, 4, 15, 9.5);
}

// Block (3,3): the one skyline landmark. 18 x 64 x 18, banded every 6.4 m, with an antenna.
function buildLandmark(gd, b, k) {
  const bx = gd.blockX[k], bz = gd.blockZ[k];
  const w = 18, h = 64;
  addBox(gd, b, bx, h * 0.5, bz, w, h, w, b.buildingPaint.landmark[0]);
  addCollider(gd, b, bx - w * 0.5, bz - w * 0.5, bx + w * 0.5, bz + w * 0.5, h);
  for (let y = 6.4; y < h - 2; y += 6.4) {
    addBox(gd, b, bx, y, bz, w + 0.12, 1.1, w + 0.12, b.buildingPaint.landmark[1]);
  }
  addBox(gd, b, bx, h + 0.5, bz, w + 1.2, 1, w + 1.2, b.buildingPaint.landmark[0]);
  addBox(gd, b, bx, h + 1 + 7, bz, 0.6, 14, 0.6, b.buildingPaint.roofProp);
}

// ===========================================================================================
// Sidewalk props
// ===========================================================================================

// Sidewalk centreline: 1.5 m in from the road edge, i.e. 18.5 m from the block centre.
const SIDEWALK_OFF = 18.5;
const CORNER_OFF = 18;      // lamps sit 2 m in from the block corner on both axes

// Module scratch for edgePoint: x, z, outward normal x, outward normal z. Allocated once at
// module load, never inside a function.
const edgeOut = new Float32Array(4);

// Map a position u along block edge `e` to world (x, z), and report the outward normal.
// e: 0 north (-z), 1 south (+z), 2 west (-x), 3 east (+x). Results land in edgeOut.
function edgePoint(bx, bz, e, u) {
  if (e === 0) { edgeOut[0] = bx + u; edgeOut[1] = bz - SIDEWALK_OFF; edgeOut[2] = 0; edgeOut[3] = -1; }
  else if (e === 1) { edgeOut[0] = bx + u; edgeOut[1] = bz + SIDEWALK_OFF; edgeOut[2] = 0; edgeOut[3] = 1; }
  else if (e === 2) { edgeOut[0] = bx - SIDEWALK_OFF; edgeOut[1] = bz + u; edgeOut[2] = -1; edgeOut[3] = 0; }
  else { edgeOut[0] = bx + SIDEWALK_OFF; edgeOut[1] = bz + u; edgeOut[2] = 1; edgeOut[3] = 0; }
}

function nearEdgeLamp(u) {
  return Math.abs(u) < 3 || Math.abs(u - CORNER_OFF) < 3 || Math.abs(u + CORNER_OFF) < 3;
}

// True when (x, z) is closer than r to any prop added since index `first`. Used to stop street
// furniture landing inside a lamp post or a street tree on the same block.
function crowded(gd, first, x, z, r) {
  for (let p = first; p < gd.propCount; p++) {
    const dx = gd.propX[p] - x, dz = gd.propZ[p] - z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

function buildSidewalk(gd, b, k, bj) {
  const bx = gd.blockX[k], bz = gd.blockZ[k], ring = gd.blockRing[k];
  const first = gd.propCount;

  // lamps: four block corners, then one at the middle of each edge
  for (let s = 0; s < 4; s++) {
    const sx = (s & 1) ? CORNER_OFF : -CORNER_OFF;
    const sz = (s & 2) ? CORNER_OFF : -CORNER_OFF;
    addProp(gd, b, PROP_TYPE.LAMP, bx + sx, bz + sz, 0, 1);
  }
  for (let e = 0; e < 4; e++) {
    edgePoint(bx, bz, e, 0);
    addProp(gd, b, PROP_TYPE.LAMP, edgeOut[0], edgeOut[1], 0, 1);
  }

  for (let e = 0; e < 4; e++) {
    // street trees every 12 m, skipping anything that would crowd a lamp
    if (ring >= 2) {
      const palm = (e === 1 && bj === b.blocksZ - 1);   // the edge facing the south outer road
      for (let n = 0; n < 3; n++) {
        const u = -14 + n * 12 + rr(gd, -0.4, 0.4);
        if (nearEdgeLamp(u)) continue;
        edgePoint(bx, bz, e, u);
        addProp(gd, b, palm ? PROP_TYPE.PALM : PROP_TYPE.TREE,
          edgeOut[0], edgeOut[1], rr(gd, 0, 6.283185), rr(gd, 0.85, 1.35));
      }
    }
    // street furniture, all facing the road
    if (gd.rand() < 0.3) {
      edgePoint(bx, bz, e, rr(gd, -16, 16));
      if (!crowded(gd, first, edgeOut[0], edgeOut[1], 2)) {
        addProp(gd, b, PROP_TYPE.HYDRANT, edgeOut[0], edgeOut[1],
          Math.atan2(edgeOut[2], edgeOut[3]), 1);
      }
    }
    if (gd.rand() < 0.25) {
      edgePoint(bx, bz, e, rr(gd, -16, 16));
      if (!crowded(gd, first, edgeOut[0], edgeOut[1], 2)) {
        addProp(gd, b, PROP_TYPE.MAILBOX, edgeOut[0], edgeOut[1],
          Math.atan2(edgeOut[2], edgeOut[3]), 1);
      }
    }
    if (gd.rand() < 0.25) {
      edgePoint(bx, bz, e, rr(gd, -16, 16));
      if (!crowded(gd, first, edgeOut[0], edgeOut[1], 2)) {
        addProp(gd, b, PROP_TYPE.BIN, edgeOut[0], edgeOut[1],
          Math.atan2(edgeOut[2], edgeOut[3]), 1);
      }
    }
  }
}

// Six roadworks: three cones in a line just inside the kerb. The only props on the tarmac.
function buildCones(gd, b) {
  for (let c = 0; c < 6; c++) {
    const vertical = gd.rand() < 0.5;
    const road = ri(gd, b.blocksX + 1);
    const seg = ri(gd, vertical ? b.blocksZ : b.blocksX);
    const side = gd.rand() < 0.5 ? -1 : 1;
    const centre = -b.cityHalf + road * b.cell;
    const t = -b.cityHalf + seg * b.cell + rr(gd, 14, 38);
    const off = centre + side * 6;
    for (let n = 0; n < 3; n++) {
      const along = t + n * 1.6;
      if (vertical) addProp(gd, b, PROP_TYPE.CONE, off, along, 0, 1);
      else addProp(gd, b, PROP_TYPE.CONE, along, off, 0, 1);
    }
  }
}

// ===========================================================================================
// Waterfront (south edge): promenade slab, palms, benches, lamps and a pier
// ===========================================================================================

function buildWaterfront(gd, b) {
  const z0 = b.promenadeZ, z1 = b.waterZ;                 // 223 .. 240
  addBox(gd, b, 0, 0.06, (z0 + z1) * 0.5, b.worldHalf * 2, 0.12, z1 - z0, b.colors.promenade);
  for (let x = -252; x <= 252; x += 9) addProp(gd, b, PROP_TYPE.PALM, x, 232, rr(gd, 0, 6.283185), rr(gd, 0.85, 1.35));
  for (let x = -252; x <= 252; x += 18) addProp(gd, b, PROP_TYPE.BENCH, x, 226, 0, 1);   // yaw 0 = facing south
  for (let x = -243; x <= 252; x += 18) addProp(gd, b, PROP_TYPE.LAMP, x, 228.5, 0, 1);

  // pier: decoration only, the soft world boundary keeps cars off it
  addBox(gd, b, 0, 0.5, 260, 6, 0.4, 40, b.colors.pier);
  for (let n = 0; n < 4; n++) {
    const pz = 245 + n * 10;
    addBox(gd, b, -2.5, 1, pz, 0.5, 2, 0.5, b.colors.pier);
    addBox(gd, b, 2.5, 1, pz, 0.5, 2, 0.5, b.colors.pier);
  }
}

// ===========================================================================================
// Parking spots
// ===========================================================================================

const PARK_OFF = 5.4;        // car centre, in the outer 2.6 m of the lane
const CONE_CLEAR = 4;

function coneNear(gd, b, x, z) {
  for (let p = 0; p < gd.propCount; p++) {
    if (gd.propType[p] !== PROP_TYPE.CONE) continue;
    const dx = gd.propX[p] - x, dz = gd.propZ[p] - z;
    if (dx * dx + dz * dz < CONE_CLEAR * CONE_CLEAR) return true;
  }
  return false;
}

// Both sides of every road segment, every 7 m from 12 m past the intersection centre. The side
// offset +laneOffset travels in the + direction (right-hand traffic), so yaw follows it.
function buildParking(gd, b) {
  for (let axis = 0; axis < 2; axis++) {
    const roads = (axis === 0 ? b.blocksZ : b.blocksX) + 1;
    const segs = axis === 0 ? b.blocksX : b.blocksZ;
    for (let r = 0; r < roads; r++) {
      const centre = -b.cityHalf + r * b.cell;
      for (let s = 0; s < segs; s++) {
        const base = -b.cityHalf + s * b.cell;
        for (let t = 12; t <= b.cell - 12; t += 7) {
          const along = base + t;
          for (let side = -1; side <= 1; side += 2) {
            const off = centre + side * PARK_OFF;
            // axis 0 = road runs along x: the +z side drives +x; axis 1 = road runs along z:
            // the -x side drives +z.
            const x = axis === 0 ? along : off;
            const z = axis === 0 ? off : along;
            if (coneNear(gd, b, x, z)) continue;
            const yaw = axis === 0
              ? (side > 0 ? Math.PI / 2 : -Math.PI / 2)     // forward (+1,0) / (-1,0)
              : (side > 0 ? Math.PI : 0);                   // forward (0,-1) / (0,+1)
            addParkSpot(gd, b, x, z, yaw);
          }
        }
      }
    }
  }
}

// ===========================================================================================
// Collision grids (CSR, built once)
// ===========================================================================================

// Two passes over the same AABB list: count per cell, prefix-sum, then fill. An item whose cell
// span would overflow gridItemsCap is skipped identically in both passes.
function buildCellGrid(b, start, count, items, n, minX, minZ, maxX, maxZ) {
  const dim = b.gridDim, G = dim * dim, size = b.gridCellSize, o = b.gridOrigin;
  start.fill(0); count.fill(0);
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      let acc = 0;
      for (let c = 0; c < G; c++) { start[c] = acc; acc += count[c]; count[c] = 0; }
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      let x0 = Math.floor((minX[i] - o) / size), x1 = Math.floor((maxX[i] - o) / size);
      let z0 = Math.floor((minZ[i] - o) / size), z1 = Math.floor((maxZ[i] - o) / size);
      if (x1 < 0 || z1 < 0 || x0 >= dim || z0 >= dim) continue;
      if (x0 < 0) x0 = 0;
      if (z0 < 0) z0 = 0;
      if (x1 >= dim) x1 = dim - 1;
      if (z1 >= dim) z1 = dim - 1;
      const need = (x1 - x0 + 1) * (z1 - z0 + 1);
      if (total + need > b.gridItemsCap) continue;
      total += need;
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cz * dim + cx;
          if (pass === 0) count[c]++;
          else { items[start[c] + count[c]] = i; count[c]++; }
        }
      }
    }
  }
}

function buildGrids(gd, b) {
  buildCellGrid(b, gd.cGridStart, gd.cGridCount, gd.cGridItems, gd.colCount,
    gd.colMinX, gd.colMinZ, gd.colMaxX, gd.colMaxZ);

  // Props are circles: expand each to its radius AABB. Generation runs once, so these four
  // scratch arrays are a legitimate local temporary.
  const n = gd.propCount;
  const minX = new Float32Array(n), minZ = new Float32Array(n);
  const maxX = new Float32Array(n), maxZ = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const r = b.propRadius[gd.propType[p]] * gd.propScale[p];
    minX[p] = gd.propX[p] - r; maxX[p] = gd.propX[p] + r;
    minZ[p] = gd.propZ[p] - r; maxZ[p] = gd.propZ[p] + r;
  }
  buildCellGrid(b, gd.pGridStart, gd.pGridCount, gd.pGridItems, n, minX, minZ, maxX, maxZ);
}

// ===========================================================================================
// Entry point
// ===========================================================================================

export function generateCity(gd, b) {
  gd.rbCount = 0; gd.wbCount = 0; gd.colCount = 0;
  gd.propCount = 0; gd.knockedCount = 0; gd.parkCount = 0;

  buildLaneGraph(gd, b);
  buildBlocks(gd, b);

  for (let bj = 0; bj < b.blocksZ; bj++) {
    for (let bi = 0; bi < b.blocksX; bi++) {
      const k = bj * b.blocksX + bi;
      const t = gd.blockType[k];
      if (t === BLOCK_TYPE.PARK) buildPark(gd, b, k);
      else if (t === BLOCK_TYPE.PLAZA) {
        buildPlaza(gd, b, k, bi, bj);
        if (bi === 3 && bj === 3) buildLandmark(gd, b, k);
      } else buildBuildingBlock(gd, b, k, gd.blockRing[k]);
    }
  }
  for (let bj = 0; bj < b.blocksZ; bj++) {
    for (let bi = 0; bi < b.blocksX; bi++) buildSidewalk(gd, b, bj * b.blocksX + bi, bj);
  }
  buildCones(gd, b);
  buildWaterfront(gd, b);
  buildParking(gd, b);
  buildGrids(gd, b);
}
