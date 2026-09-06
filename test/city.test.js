import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, BLOCK_TYPE, PROP_TYPE, PROP_STATE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { generateCity, nearestLanePoint, gridIndex, isOnRoad } from '../src/logic/city.js';

const b = balance;

function city(seed = 7) {
  const gd = {};
  allocateGameData(gd, b, seed);
  generateCity(gd, b);
  return gd;
}

// One city for the read-only assertions; a few tests build their own.
const gd = city(7);

// ---------------------------------------------------------------- lane graph

test('the lane graph has 288 lanes of 40 m between 81 nodes', () => {
  assert.equal(gd.nodeCount, b.nodeCount);
  assert.equal(gd.laneCount, b.laneCount);
  assert.equal(gd.laneCount, 288);
  for (let n = 0; n < gd.nodeCount; n++) {
    const i = n % 9, j = (n / 9) | 0;
    assert.equal(gd.nodeX[n], -b.cityHalf + i * b.cell);
    assert.equal(gd.nodeZ[n], -b.cityHalf + j * b.cell);
  }
  for (let l = 0; l < gd.laneCount; l++) {
    assert.ok(Math.abs(gd.laneLen[l] - 40) < 1e-3, `lane ${l} len ${gd.laneLen[l]}`);
    const dx = gd.laneX1[l] - gd.laneX0[l], dz = gd.laneZ1[l] - gd.laneZ0[l];
    const len = Math.hypot(dx, dz);
    assert.ok(Math.abs(len - 40) < 1e-3, `lane ${l} geometry len ${len}`);
    // direction is the unit vector of the segment
    assert.ok(Math.abs(gd.laneDirX[l] - dx / len) < 1e-5);
    assert.ok(Math.abs(gd.laneDirZ[l] - dz / len) < 1e-5);
    // axis aligned
    assert.ok(Math.abs(dx) < 1e-6 || Math.abs(dz) < 1e-6);
  }
});

test('lane endpoints sit one laneOffset right of the road centre and clear the intersection', () => {
  for (let l = 0; l < gd.laneCount; l++) {
    const from = gd.laneFrom[l], to = gd.laneTo[l];
    const dx = gd.laneDirX[l], dz = gd.laneDirZ[l];
    // right-hand traffic: the lane is offset to the right of travel, (-dz, dx) * laneOffset
    const ox = -dz * b.laneOffset, oz = dx * b.laneOffset;
    assert.ok(Math.abs(gd.laneX0[l] - (gd.nodeX[from] + ox + dx * b.roadW / 2)) < 1e-3, `lane ${l} x0`);
    assert.ok(Math.abs(gd.laneZ0[l] - (gd.nodeZ[from] + oz + dz * b.roadW / 2)) < 1e-3, `lane ${l} z0`);
    assert.ok(Math.abs(gd.laneX1[l] - (gd.nodeX[to] + ox - dx * b.roadW / 2)) < 1e-3, `lane ${l} x1`);
    assert.ok(Math.abs(gd.laneZ1[l] - (gd.nodeZ[to] + oz - dz * b.roadW / 2)) < 1e-3, `lane ${l} z1`);
  }
});

test('every lane reverses to the lane running the other way on the same road segment', () => {
  for (let l = 0; l < gd.laneCount; l++) {
    const r = gd.laneReverse[l];
    assert.ok(r >= 0 && r < gd.laneCount, `lane ${l} reverse ${r}`);
    assert.equal(gd.laneReverse[r], l);
    assert.notEqual(r, l);
    assert.equal(gd.laneFrom[r], gd.laneTo[l]);
    assert.equal(gd.laneTo[r], gd.laneFrom[l]);
    assert.ok(Math.abs(gd.laneDirX[r] + gd.laneDirX[l]) < 1e-6);
    assert.ok(Math.abs(gd.laneDirZ[r] + gd.laneDirZ[l]) < 1e-6);
  }
});

test('every node has 2-4 outgoing lanes and the CSR covers every lane exactly once', () => {
  const seen = new Uint8Array(gd.laneCount);
  let total = 0;
  for (let n = 0; n < gd.nodeCount; n++) {
    const c = gd.nodeOutCount[n];
    assert.ok(c >= 2 && c <= 4, `node ${n} has ${c} outgoing lanes`);
    total += c;
    for (let k = 0; k < c; k++) {
      const l = gd.nodeOutLanes[gd.nodeOutStart[n] + k];
      assert.ok(l >= 0 && l < gd.laneCount);
      assert.equal(gd.laneFrom[l], n, `lane ${l} listed on node ${n} but starts at ${gd.laneFrom[l]}`);
      assert.equal(seen[l], 0, `lane ${l} listed twice`);
      seen[l] = 1;
    }
  }
  assert.equal(total, gd.laneCount);
  // corner nodes have 2, edge nodes 3, interior nodes 4
  for (let n = 0; n < gd.nodeCount; n++) {
    const i = n % 9, j = (n / 9) | 0;
    const edges = (i === 0 || i === 8 ? 1 : 0) + (j === 0 || j === 8 ? 1 : 0);
    assert.equal(gd.nodeOutCount[n], 4 - edges, `node ${i},${j}`);
  }
});

test('every lane has at least one continuation that is not its own reverse', () => {
  for (let l = 0; l < gd.laneCount; l++) {
    const to = gd.laneTo[l], rev = gd.laneReverse[l];
    let options = 0;
    for (let k = 0; k < gd.nodeOutCount[to]; k++) {
      if (gd.nodeOutLanes[gd.nodeOutStart[to] + k] !== rev) options++;
    }
    assert.ok(options >= 1, `lane ${l} dead-ends at node ${to}`);
  }
});

// ---------------------------------------------------------------- nearestLanePoint

test('nearestLanePoint finds the lane the point is standing on', () => {
  const l = nearestLanePoint(gd, b, 100, -212.5);
  assert.ok(l >= 0);
  assert.ok(Math.abs(gd.laneZ0[l] - (-212.5)) < 1e-3, `laneZ0 was ${gd.laneZ0[l]}`);
  assert.ok(Math.abs(gd.laneZ1[l] - (-212.5)) < 1e-3);
  // eastbound: travelling +x
  assert.ok(gd.laneDirX[l] > 0.9);
  // scratch[0] is metres along the lane, and the projected point is the query point
  const t = gd.scratch[0];
  assert.ok(t >= 0 && t <= gd.laneLen[l], `t was ${t}`);
  assert.ok(Math.abs(gd.laneX0[l] + gd.laneDirX[l] * t - 100) < 1e-3);
});

test('nearestLanePoint clamps to the ends of the nearest lane and always returns a lane', () => {
  // far outside the city, off the north-west corner
  const l = nearestLanePoint(gd, b, -400, -400);
  assert.ok(l >= 0 && l < gd.laneCount);
  const t = gd.scratch[0];
  assert.ok(t >= 0 && t <= gd.laneLen[l]);
  // the returned lane really is the closest one
  const px = gd.laneX0[l] + gd.laneDirX[l] * t, pz = gd.laneZ0[l] + gd.laneDirZ[l] * t;
  const best = (px + 400) * (px + 400) + (pz + 400) * (pz + 400);
  for (let k = 0; k < gd.laneCount; k++) {
    const dx = gd.laneX1[k] - gd.laneX0[k], dz = gd.laneZ1[k] - gd.laneZ0[k];
    const len2 = dx * dx + dz * dz;
    let u = ((-400 - gd.laneX0[k]) * dx + (-400 - gd.laneZ0[k]) * dz) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = gd.laneX0[k] + dx * u, qz = gd.laneZ0[k] + dz * u;
    const d2 = (qx + 400) * (qx + 400) + (qz + 400) * (qz + 400);
    assert.ok(d2 >= best - 1e-3, `lane ${k} is closer than the returned ${l}`);
  }
});

// ---------------------------------------------------------------- isOnRoad / gridIndex

test('isOnRoad marks the road strips and nothing else', () => {
  assert.equal(isOnRoad(b, 0, 0), true);              // node at i=4,j=4
  assert.equal(isOnRoad(b, -216, 0), true);           // outer west road
  assert.equal(isOnRoad(b, 6.9, 100), true);          // just inside the x = 0 road
  assert.equal(isOnRoad(b, 7.1, 100), false);         // just outside it, mid-block in z
  assert.equal(isOnRoad(b, 27, 27), false);           // block centre
  assert.equal(isOnRoad(b, 0, 224), false);           // past the outer south road edge
  assert.equal(isOnRoad(b, 224, 0), false);
  assert.equal(isOnRoad(b, -223, 0), true);           // exactly the outer edge
  assert.equal(isOnRoad(b, 300, 300), false);
});

test('gridIndex maps world points into the uniform grid and rejects the outside', () => {
  assert.equal(gridIndex(b, -256, -256), 0);
  assert.equal(gridIndex(b, 0, 0), 8 * b.gridDim + 8);
  assert.equal(gridIndex(b, 255.9, 255.9), b.gridDim * b.gridDim - 1);
  assert.equal(gridIndex(b, -257, 0), -1);
  assert.equal(gridIndex(b, 0, 257), -1);
  assert.equal(gridIndex(b, 1e6, 1e6), -1);
});

// ---------------------------------------------------------------- blocks

test('blocks tile the city with the right rings and types', () => {
  assert.equal(gd.blockCount, b.blockCount);
  let plaza = 0, park = 0, lowrise = 0, buildings = 0;
  for (let bj = 0; bj < b.blocksZ; bj++) {
    for (let bi = 0; bi < b.blocksX; bi++) {
      const k = bj * b.blocksX + bi;
      assert.equal(gd.blockX[k], -b.cityHalf + 27 + bi * b.cell);
      assert.equal(gd.blockZ[k], -b.cityHalf + 27 + bj * b.cell);
      const ring = Math.max(Math.abs(bi - 3.5), Math.abs(bj - 3.5)) - 0.5;
      assert.equal(gd.blockRing[k], ring);
      const t = gd.blockType[k];
      if (ring === 0) assert.equal(t, BLOCK_TYPE.PLAZA);
      if (ring === 1) assert.equal(t, BLOCK_TYPE.BUILDINGS);
      if (ring === 2) assert.ok(t === BLOCK_TYPE.BUILDINGS || t === BLOCK_TYPE.PARK);
      if (ring === 3) assert.ok(t === BLOCK_TYPE.LOWRISE || t === BLOCK_TYPE.PARK);
      if (t === BLOCK_TYPE.PLAZA) plaza++;
      else if (t === BLOCK_TYPE.PARK) park++;
      else if (t === BLOCK_TYPE.LOWRISE) lowrise++;
      else buildings++;
    }
  }
  assert.equal(plaza, 4);
  assert.equal(park, 5);          // 2 in ring 2, 3 in ring 3
  assert.equal(buildings, 12 + 18);
  assert.equal(lowrise, 25);
});

test('no two parks are adjacent', () => {
  for (let bj = 0; bj < b.blocksZ; bj++) {
    for (let bi = 0; bi < b.blocksX; bi++) {
      if (gd.blockType[bj * b.blocksX + bi] !== BLOCK_TYPE.PARK) continue;
      if (bi > 0) assert.notEqual(gd.blockType[bj * b.blocksX + bi - 1], BLOCK_TYPE.PARK);
      if (bj > 0) assert.notEqual(gd.blockType[(bj - 1) * b.blocksX + bi], BLOCK_TYPE.PARK);
    }
  }
});

// ---------------------------------------------------------------- geometry vs the roads

test('no static collider touches a road strip', () => {
  assert.ok(gd.colCount > 100, `only ${gd.colCount} colliders`);
  for (let c = 0; c < gd.colCount; c++) {
    const x0 = gd.colMinX[c], z0 = gd.colMinZ[c], x1 = gd.colMaxX[c], z1 = gd.colMaxZ[c];
    assert.ok(x1 > x0 && z1 > z0, `collider ${c} is inside out`);
    assert.ok(gd.colH[c] > 0);
    assert.equal(isOnRoad(b, x0, z0), false, `collider ${c} corner on road`);
    assert.equal(isOnRoad(b, x1, z0), false, `collider ${c} corner on road`);
    assert.equal(isOnRoad(b, x0, z1), false, `collider ${c} corner on road`);
    assert.equal(isOnRoad(b, x1, z1), false, `collider ${c} corner on road`);
    assert.equal(isOnRoad(b, (x0 + x1) / 2, (z0 + z1) / 2), false, `collider ${c} centre on road`);
  }
});

test('the plaza landmark tower has a collider over 60 m tall', () => {
  let tall = -1;
  for (let c = 0; c < gd.colCount; c++) if (gd.colH[c] >= 60) tall = c;
  assert.ok(tall >= 0, 'no collider 60 m or taller');
  assert.ok(Math.abs(gd.colMaxX[tall] - gd.colMinX[tall] - 18) < 1e-3);
  assert.ok(Math.abs(gd.colMaxZ[tall] - gd.colMinZ[tall] - 18) < 1e-3);
  // block (3,3), centre (-27, -27)
  assert.ok(Math.abs((gd.colMinX[tall] + gd.colMaxX[tall]) / 2 + 27) < 1e-3);
  assert.ok(Math.abs((gd.colMinZ[tall] + gd.colMaxZ[tall]) / 2 + 27) < 1e-3);
});

test('only cones stand on the road, and every prop is a real prop', () => {
  assert.ok(gd.propCount > 500, `only ${gd.propCount} props`);
  let cones = 0, lifted = 0;
  for (let p = 0; p < gd.propCount; p++) {
    const t = gd.propType[p];
    assert.ok(t >= 0 && t < b.propTypeCount, `prop ${p} type ${t}`);
    assert.equal(gd.propState[p], PROP_STATE.STATIC);
    // T12: every prop still stands on the ground except the plaza planter trees, which stand on
    // the 0.6 m lid of their planter box — the one deliberate use of propY at generation time.
    if (gd.propY[p] !== 0) {
      assert.equal(t, PROP_TYPE.TREE, `prop ${p} (type ${t}) is off the ground`);
      assert.ok(Math.abs(gd.propY[p] - 0.6) < 1e-6, `prop ${p} is at y=${gd.propY[p]}`);
      lifted++;
    }
    assert.ok(gd.propScale[p] > 0);
    if (t === PROP_TYPE.CONE) { cones++; continue; }
    assert.equal(isOnRoad(b, gd.propX[p], gd.propZ[p]), false,
      `prop ${p} (type ${t}) at ${gd.propX[p]},${gd.propZ[p]} is on a road`);
  }
  assert.equal(cones, 18, 'six cone clusters of three');
  // four plaza blocks, 4-6 planters each
  assert.ok(lifted >= 16 && lifted <= 24, `${lifted} planter trees`);
});

test('every parking spot is on a road, clear of the cones, and unused', () => {
  assert.ok(gd.parkCount > 200, `only ${gd.parkCount} parking spots`);
  for (let s = 0; s < gd.parkCount; s++) {
    assert.equal(isOnRoad(b, gd.parkX[s], gd.parkZ[s]), true,
      `spot ${s} at ${gd.parkX[s]},${gd.parkZ[s]} is off the road`);
    assert.equal(gd.parkUsed[s], 0);
    for (let p = 0; p < gd.propCount; p++) {
      if (gd.propType[p] !== PROP_TYPE.CONE) continue;
      const dx = gd.propX[p] - gd.parkX[s], dz = gd.propZ[p] - gd.parkZ[s];
      assert.ok(dx * dx + dz * dz >= 16 - 1e-6, `spot ${s} sits on a cone cluster`);
    }
  }
});

test('parking spots are parallel to the traffic on their side of the road', () => {
  for (let s = 0; s < gd.parkCount; s++) {
    const fx = Math.sin(gd.parkYaw[s]), fz = Math.cos(gd.parkYaw[s]);
    // axis aligned, unit length
    assert.ok(Math.abs(Math.hypot(fx, fz) - 1) < 1e-5);
    assert.ok(Math.abs(fx) < 1e-5 || Math.abs(fz) < 1e-5);
    // the spot is offset 5.4 m to the right of the road centre it belongs to
    const off = Math.abs(fx) > 0.5 ? gd.parkZ[s] : gd.parkX[s];
    const centre = -b.cityHalf + Math.round((off + b.cityHalf) / b.cell) * b.cell;
    const d = off - centre;
    const right = Math.abs(fx) > 0.5 ? fx * 5.4 : -fz * 5.4;   // (-dz, dx) * 5.4
    assert.ok(Math.abs(d - right) < 1e-3, `spot ${s} offset ${d} does not match yaw`);
  }
});

// ---------------------------------------------------------------- capacities

test('generation stays under every cap for seed 7', () => {
  assert.ok(gd.rbCount > 0 && gd.rbCount < b.maxRenderBoxes, `rbCount ${gd.rbCount}`);
  assert.ok(gd.wbCount > 0 && gd.wbCount < b.maxWindowBands, `wbCount ${gd.wbCount}`);
  assert.ok(gd.colCount > 0 && gd.colCount < b.maxColliders, `colCount ${gd.colCount}`);
  assert.ok(gd.propCount > 0 && gd.propCount < b.maxProps, `propCount ${gd.propCount}`);
  assert.ok(gd.parkCount > 0 && gd.parkCount < b.maxParkSpots, `parkCount ${gd.parkCount}`);
  let cItems = 0, pItems = 0;
  const G = b.gridDim * b.gridDim;
  for (let c = 0; c < G; c++) { cItems += gd.cGridCount[c]; pItems += gd.pGridCount[c]; }
  assert.ok(cItems > 0 && cItems < b.gridItemsCap, `cGrid items ${cItems}`);
  assert.ok(pItems > 0 && pItems < b.gridItemsCap, `pGrid items ${pItems}`);
});

test('render boxes and window bands have positive, sane extents', () => {
  for (let i = 0; i < gd.rbCount; i++) {
    assert.ok(gd.rbW[i] > 0 && gd.rbH[i] > 0 && gd.rbD[i] > 0, `render box ${i} is degenerate`);
    assert.ok(gd.rbColor[i] >= 0 && gd.rbColor[i] <= 0xffffff, `render box ${i} colour`);
    assert.ok(Math.abs(gd.rbX[i]) < 400 && Math.abs(gd.rbZ[i]) < 400, `render box ${i} is off-world`);
  }
  for (let i = 0; i < gd.wbCount; i++) {
    assert.ok(gd.wbW[i] > 0 && gd.wbH[i] > 0 && gd.wbD[i] > 0, `window band ${i} is degenerate`);
    assert.ok(gd.wbY[i] > 0);
  }
});

// ---------------------------------------------------------------- collision grid

test('the collider grid lists every collider in each cell it overlaps', () => {
  const G = b.gridDim * b.gridDim;
  const listed = new Int32Array(gd.colCount);
  for (let c = 0; c < G; c++) {
    for (let k = 0; k < gd.cGridCount[c]; k++) {
      const idx = gd.cGridItems[gd.cGridStart[c] + k];
      assert.ok(idx >= 0 && idx < gd.colCount);
      listed[idx]++;
      // the collider really does overlap this cell
      const cx = c % b.gridDim, cz = (c / b.gridDim) | 0;
      const x0 = b.gridOrigin + cx * b.gridCellSize, z0 = b.gridOrigin + cz * b.gridCellSize;
      assert.ok(gd.colMaxX[idx] >= x0 && gd.colMinX[idx] <= x0 + b.gridCellSize, `collider ${idx} not in cell ${c}`);
      assert.ok(gd.colMaxZ[idx] >= z0 && gd.colMinZ[idx] <= z0 + b.gridCellSize, `collider ${idx} not in cell ${c}`);
    }
  }
  for (let i = 0; i < gd.colCount; i++) assert.ok(listed[i] >= 1, `collider ${i} is in no grid cell`);
});

test('the prop grid lists every prop in the cell it stands in', () => {
  const G = b.gridDim * b.gridDim;
  const listed = new Int32Array(gd.propCount);
  for (let c = 0; c < G; c++) {
    for (let k = 0; k < gd.pGridCount[c]; k++) {
      const idx = gd.pGridItems[gd.pGridStart[c] + k];
      assert.ok(idx >= 0 && idx < gd.propCount);
      listed[idx]++;
    }
  }
  for (let p = 0; p < gd.propCount; p++) {
    const c = gridIndex(b, gd.propX[p], gd.propZ[p]);
    if (c >= 0) assert.ok(listed[p] >= 1, `prop ${p} is in no grid cell`);
  }
});

test('grid CSR ranges are contiguous and in bounds', () => {
  const G = b.gridDim * b.gridDim;
  for (const [start, count, cap] of [[gd.cGridStart, gd.cGridCount, b.gridItemsCap],
                                     [gd.pGridStart, gd.pGridCount, b.gridItemsCap]]) {
    let expect = 0;
    for (let c = 0; c < G; c++) {
      assert.equal(start[c], expect, `cell ${c} start`);
      assert.ok(count[c] >= 0);
      expect += count[c];
      assert.ok(expect <= cap);
    }
  }
});

// ---------------------------------------------------------------- determinism

test('the same seed builds exactly the same city', () => {
  const a = city(7), c = city(7);
  for (const k of ['rbCount', 'wbCount', 'colCount', 'propCount', 'parkCount', 'laneCount', 'blockCount']) {
    assert.equal(a[k], c[k], k);
  }
  let sa = 0, sc = 0;
  for (let i = 0; i < a.rbCount; i++) { sa += a.rbX[i] + a.rbY[i] + a.rbZ[i] + a.rbH[i]; sc += c.rbX[i] + c.rbY[i] + c.rbZ[i] + c.rbH[i]; }
  assert.equal(sa, sc);
  let pa = 0, pc = 0;
  for (let i = 0; i < a.propCount; i++) { pa += a.propX[i] * 3 + a.propZ[i] + a.propType[i]; pc += c.propX[i] * 3 + c.propZ[i] + c.propType[i]; }
  assert.equal(pa, pc);
  for (let i = 0; i < a.colCount; i++) assert.equal(a.colMinX[i], c.colMinX[i]);
});

test('a different seed builds a different city', () => {
  const other = city(12345);
  assert.equal(other.laneCount, gd.laneCount);   // the road grid is fixed
  let same = true;
  for (let i = 0; i < Math.min(other.rbCount, gd.rbCount); i++) {
    if (other.rbH[i] !== gd.rbH[i]) { same = false; break; }
  }
  assert.ok(!same || other.rbCount !== gd.rbCount, 'seed 12345 produced the same buildings as seed 7');
});

test('other seeds also stay within every cap', () => {
  for (const s of [1, 2, 3, 42, 12345, 999999]) {
    const g = city(s);
    assert.ok(g.rbCount < b.maxRenderBoxes, `seed ${s} rbCount ${g.rbCount}`);
    assert.ok(g.wbCount < b.maxWindowBands, `seed ${s} wbCount ${g.wbCount}`);
    assert.ok(g.colCount < b.maxColliders, `seed ${s} colCount ${g.colCount}`);
    assert.ok(g.propCount < b.maxProps, `seed ${s} propCount ${g.propCount}`);
    assert.ok(g.parkCount < b.maxParkSpots, `seed ${s} parkCount ${g.parkCount}`);
  }
});
