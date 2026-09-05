// Static city geometry: roads, sidewalks, markings merged into one vertex-coloured mesh;
// buildings and window bands as instanced boxes. Built once from gd, never per frame.
//
// Draw calls: 1 (road/sidewalk/markings) + 1 (buildings) + 1 (window bands).
//
// Height bands, chosen so that no two visible faces are ever coplanar and pointing the same way
// — that, not depth bias, is what keeps the markings free of z-fighting:
//   road slab      0.00 .. 0.10
//   markings       0.10 .. 0.12   (bottom face sits on the road top, but faces down: never drawn)
//   sidewalk       0.00 .. 0.15   (the 0.05 lip above the road is the kerb step)
// In plan the markings never overlap each other either: the centre dashes stay inside |cross| 0.075,
// the kerb lines live in 6.54..6.66, the crosswalk stripes reach 5.9 and the stop lines run 0.5..6.5.
import {
  BoxGeometry, Color, Float32BufferAttribute, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial,
  Quaternion, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BLOCK_TYPE } from '../balance.js';

// Module-scope scratch: this file allocates only while building, never afterwards.
const _m4 = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _axisY = new Vector3(0, 1, 0);
const _col = new Color();

const ROAD_H = 0.1;
const WALK_H = 0.15;
const MARK_Y = 0.11;
const MARK_H = 0.02;

// Sidewalk ring: the block interior is 40 m (±20 from the block centre) and the buildable lot area
// 34 m (±17), so the ring is the 3 m band between them. The outer edge is pushed 0.1 m into the
// road so the kerb face is never coplanar with the side of a park/plaza slab (which ends at ±20).
const WALK_OUT = 20.1;
const WALK_IN = 17;
const WALK_W = WALK_OUT - WALK_IN;          // 3.1
const WALK_C = (WALK_OUT + WALK_IN) * 0.5;  // 18.55

// Markings
const DASH_LEN = 2, DASH_W = 0.15, DASH_PITCH = 4, DASH_FIRST = 6;   // 8 dashes, 6 .. 34 m
const EDGE_OFF = 6.6, EDGE_W = 0.12;
const CROSS_OFF = 8.6, CROSS_DEPTH = 3.2, STRIPE_W = 0.6, STRIPE_PITCH = 2.8, STRIPE_N = 5;
const STOP_OFF = 10.6, STOP_LEN = 6, STOP_W = 0.4;

// ---------------------------------------------------------------- geometry helpers

// BoxGeometry lays out 24 vertices one face at a time: +X, -X, +Y, -Y, +Z, -Z. Colouring the +Y
// face on its own is what makes a kerb read as a step: pale top, darker vertical face.
function paintBox(g, topHex, sideHex) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  _col.setHex(sideHex);
  const sr = _col.r, sg = _col.g, sb = _col.b;
  _col.setHex(topHex);
  const tr = _col.r, tg = _col.g, tb = _col.b;
  for (let i = 0; i < n; i++) {
    const top = i >= 8 && i < 12;
    arr[i * 3] = top ? tr : sr;
    arr[i * 3 + 1] = top ? tg : sg;
    arr[i * 3 + 2] = top ? tb : sb;
  }
  g.setAttribute('color', new Float32BufferAttribute(arr, 3));
  return g;
}

function slab(parts, w, h, d, x, y, z, topHex, sideHex) {
  const g = new BoxGeometry(w, h, d);
  paintBox(g, topHex, sideHex === undefined ? topHex : sideHex);
  g.translate(x, y, z);
  parts.push(g);
}

// ---------------------------------------------------------------- tarmac

function addRoads(parts, b) {
  const seg = b.cell - b.roadW;          // 40 m of open road between two intersections
  const road = b.colors.road;
  for (let j = 0; j <= b.blocksZ; j++) {
    const zc = -b.cityHalf + j * b.cell;
    for (let i = 0; i < b.blocksX; i++) {
      const xc = -b.cityHalf + i * b.cell + b.cell * 0.5;
      slab(parts, seg, ROAD_H, b.roadW, xc, ROAD_H * 0.5, zc, road);
    }
  }
  for (let i = 0; i <= b.blocksX; i++) {
    const xc = -b.cityHalf + i * b.cell;
    for (let j = 0; j < b.blocksZ; j++) {
      const zc = -b.cityHalf + j * b.cell + b.cell * 0.5;
      slab(parts, b.roadW, ROAD_H, seg, xc, ROAD_H * 0.5, zc, road);
    }
  }
  for (let j = 0; j <= b.blocksZ; j++) {
    for (let i = 0; i <= b.blocksX; i++) {
      slab(parts, b.roadW, ROAD_H, b.roadW, -b.cityHalf + i * b.cell, ROAD_H * 0.5,
        -b.cityHalf + j * b.cell, road);
    }
  }
}

// ---------------------------------------------------------------- sidewalks

function addSidewalks(parts, gd, b) {
  const top = b.colors.sidewalk, side = b.colors.curb;
  const long = WALK_OUT * 2, shortSide = WALK_IN * 2;
  for (let k = 0; k < gd.blockCount; k++) {
    const bx = gd.blockX[k], bz = gd.blockZ[k], y = WALK_H * 0.5;
    slab(parts, long, WALK_H, WALK_W, bx, y, bz - WALK_C, top, side);
    slab(parts, long, WALK_H, WALK_W, bx, y, bz + WALK_C, top, side);
    slab(parts, WALK_W, WALK_H, shortSide, bx - WALK_C, y, bz, top, side);
    slab(parts, WALK_W, WALK_H, shortSide, bx + WALK_C, y, bz, top, side);

    // Parks and plazas bring their own slab; a built block would otherwise show the world's grass
    // between its buildings and its kerb, which reads as lawn in the middle of downtown. A darker
    // paved apron fills the 34 m lot area, one step below the pavement.
    const t = gd.blockType[k];
    if (t === BLOCK_TYPE.BUILDINGS || t === BLOCK_TYPE.LOWRISE) {
      slab(parts, shortSide, 0.06, shortSide, bx, 0.03, bz, b.colors.curb);
    }
  }
}

// ---------------------------------------------------------------- markings

// Centre dashes and kerb lines, per road segment. axis 0 = the road runs along x, axis 1 along z.
function addLines(parts, b) {
  const yellow = b.colors.roadLine, white = b.colors.roadWhite;
  const seg = b.cell - b.roadW;
  for (let axis = 0; axis < 2; axis++) {
    const roads = (axis === 0 ? b.blocksZ : b.blocksX) + 1;
    const segs = axis === 0 ? b.blocksX : b.blocksZ;
    for (let r = 0; r < roads; r++) {
      const c = -b.cityHalf + r * b.cell;
      for (let s = 0; s < segs; s++) {
        const a0 = -b.cityHalf + s * b.cell + b.roadW * 0.5;
        const mid = a0 + seg * 0.5;
        for (let t = DASH_FIRST; t < seg - 2; t += DASH_PITCH) {
          const a = a0 + t;
          if (axis === 0) slab(parts, DASH_LEN, MARK_H, DASH_W, a, MARK_Y, c, yellow);
          else slab(parts, DASH_W, MARK_H, DASH_LEN, c, MARK_Y, a, yellow);
        }
        for (let e = -1; e <= 1; e += 2) {
          if (axis === 0) slab(parts, seg, MARK_H, EDGE_W, mid, MARK_Y, c + e * EDGE_OFF, white);
          else slab(parts, EDGE_W, MARK_H, seg, c + e * EDGE_OFF, MARK_Y, mid, white);
        }
      }
    }
  }
}

// One approach to one intersection: a zebra crossing and the stop line behind it, in the lane that
// is driving toward the node. `a`: 0 north, 1 south, 2 west, 3 east.
function addCrossing(parts, b, xc, zc, a) {
  const white = b.colors.roadWhite;
  const sign = (a === 0 || a === 2) ? -1 : 1;
  const half = (STRIPE_N - 1) * 0.5;
  if (a < 2) {
    // the crossing lies on a road running along z; stripes run with the traffic
    const z = zc + sign * CROSS_OFF;
    for (let k = 0; k < STRIPE_N; k++) {
      slab(parts, STRIPE_W, MARK_H, CROSS_DEPTH, xc + (k - half) * STRIPE_PITCH, MARK_Y, z, white);
    }
    const dz = -sign;                                  // travel direction, toward the node
    slab(parts, STOP_LEN, MARK_H, STOP_W, xc - dz * b.laneOffset, MARK_Y, zc + sign * STOP_OFF, white);
  } else {
    const x = xc + sign * CROSS_OFF;
    for (let k = 0; k < STRIPE_N; k++) {
      slab(parts, CROSS_DEPTH, MARK_H, STRIPE_W, x, MARK_Y, zc + (k - half) * STRIPE_PITCH, white);
    }
    const dx = -sign;
    slab(parts, STOP_W, MARK_H, STOP_LEN, xc + sign * STOP_OFF, MARK_Y, zc + dx * b.laneOffset, white);
  }
}

function addCrossings(parts, b) {
  for (let j = 0; j <= b.blocksZ; j++) {
    for (let i = 0; i <= b.blocksX; i++) {
      const xc = -b.cityHalf + i * b.cell, zc = -b.cityHalf + j * b.cell;
      if (j > 0) addCrossing(parts, b, xc, zc, 0);
      if (j < b.blocksZ) addCrossing(parts, b, xc, zc, 1);
      if (i > 0) addCrossing(parts, b, xc, zc, 2);
      if (i < b.blocksX) addCrossing(parts, b, xc, zc, 3);
    }
  }
}

// ---------------------------------------------------------------- instanced boxes

// Every render box gd holds: buildings, setbacks, ground bands, roof clutter, the landmark and its
// bands, park / plaza / promenade slabs and the pier. One unit box, one matrix and colour each.
function buildBoxes(view, gd, b) {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial(), gd.rbCount);
  for (let i = 0; i < gd.rbCount; i++) {
    _pos.set(gd.rbX[i], gd.rbY[i], gd.rbZ[i]);
    _quat.setFromAxisAngle(_axisY, gd.rbYaw[i]);
    _scl.set(gd.rbW[i], gd.rbH[i], gd.rbD[i]);
    _m4.compose(_pos, _quat, _scl);
    mesh.setMatrixAt(i, _m4);
    _col.setHex(gd.rbColor[i]);
    mesh.setColorAt(i, _col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  view.scene.add(mesh);
  return mesh;
}

// Window bands: one flat box per floor, slightly proud of the facade, all in the same dark glass.
function buildWindows(view, gd, b) {
  const mat = new MeshLambertMaterial({ color: b.buildingPaint.window });
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, gd.wbCount);
  _quat.set(0, 0, 0, 1);
  for (let i = 0; i < gd.wbCount; i++) {
    _pos.set(gd.wbX[i], gd.wbY[i], gd.wbZ[i]);
    _scl.set(gd.wbW[i], gd.wbH[i], gd.wbD[i]);
    _m4.compose(_pos, _quat, _scl);
    mesh.setMatrixAt(i, _m4);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  view.scene.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------- entry point

export function buildCity(view, gd, b) {
  const parts = [];
  addRoads(parts, b);
  addSidewalks(parts, gd, b);
  addLines(parts, b);
  addCrossings(parts, b);

  const geo = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  const roads = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true }));
  roads.receiveShadow = true;
  roads.matrixAutoUpdate = false;
  roads.updateMatrix();
  view.scene.add(roads);

  view.city = {
    roads,
    buildings: buildBoxes(view, gd, b),
    windows: buildWindows(view, gd, b),
    roadPieces: parts.length,
  };
  return view.city;
}
