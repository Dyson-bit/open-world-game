// Props as instanced meshes, one per prop type; static and knocked props share the instance arrays.
//
// Every type is one merged, vertex-coloured geometry built once at load, drawn as a single
// InstancedMesh — 11 draw calls for the ~1500 props in the city (trees get two meshes so half of
// them can wear the second canopy green). A prop's instance never moves unless Task 7 knocks it
// over, and updateProps() then rewrites only the matrices in gd.knockedList, allocating nothing.
import {
  BoxGeometry, Color, ConeGeometry, CylinderGeometry, Euler, Float32BufferAttribute,
  IcosahedronGeometry, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PROP_TYPE } from '../balance.js';

// Module-scope scratch. updateProps() touches nothing else, so the frame path never allocates.
const _m4 = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');   // yaw first, then the topple pitch/roll
const _col = new Color();

// Mesh slots: 0/1 are the two tree canopies, then one per remaining type (PROP_TYPE + 1).
const SLOT_COUNT = 10 + 1;

function slotOf(type, index) {
  return type === PROP_TYPE.TREE ? (index & 1) : type + 1;
}

// ---------------------------------------------------------------- geometry helpers

// Flat colour on every vertex. Everything is made non-indexed first so that merging an
// IcosahedronGeometry (which has no index) with the boxes and cylinders (which do) is legal.
function tint(g, hex) {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  _col.setHex(hex);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new Float32BufferAttribute(arr, 3));
  return geo;
}

function merge(parts) {
  const g = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return g;
}

function trunkGeo(b) {
  const g = new CylinderGeometry(0.18, 0.28, 2.2, 7);
  g.translate(0, 1.1, 0);
  return tint(g, b.colors.trunk);
}

function treeGeo(b, canopyHex) {
  const canopy = new IcosahedronGeometry(1.9, 1);
  canopy.translate(0, 3.4, 0);
  return merge([trunkGeo(b), tint(canopy, canopyHex)]);
}

function pineGeo(b) {
  const cone = new ConeGeometry(1.6, 4.6, 7);
  cone.translate(0, 4.2, 0);
  return merge([trunkGeo(b), tint(cone, b.colors.pine)]);
}

// A palm leans: the trunk is built standing, then pivoted about its base, and the fronds are
// fanned around wherever the top ended up. Each frond is a flattened 4-sided cone rather than a
// box — a slab of a blade sticking out sideways reads as a TV aerial, a tapered drooping one
// reads as a palm. Two rings at different droops give the crown some depth.
function palmGeo(b) {
  const lean = 0.14;
  const trunk = new CylinderGeometry(0.15, 0.25, 6, 7);
  trunk.translate(0, 3, 0);
  trunk.rotateZ(lean);
  const cx = -Math.sin(lean) * 6, cy = Math.cos(lean) * 6;
  const parts = [tint(trunk, b.colors.trunk)];
  const crown = new IcosahedronGeometry(0.5, 0);
  crown.translate(cx, cy, 0);
  parts.push(tint(crown, b.colors.palm));
  for (let i = 0; i < 8; i++) {
    const yaw = i * Math.PI / 4;
    const droop = 0.20 + (i & 1) * 0.18;   // alternate ribs so the crown is not a flat disc
    // inner half, then an outer half hinged at its tip and drooped further: the arc is what makes
    // it read as a frond instead of a spike
    parts.push(blade(b, 0.6, 1.9, droop, 0, 0, yaw, cx, cy));
    parts.push(blade(b, 0.44, 1.9, droop + 0.6,
      -Math.sin(droop) * 1.9, Math.cos(droop) * 1.9, yaw, cx, cy));
  }
  return merge(parts);
}

// One flattened, tapered blade pointing away from the crown, drooped by `droop`, hinged at
// (0, oy, oz) in the crown's local frame and then swung round to `yaw`.
function blade(b, rad, len, droop, oy, oz, yaw, cx, cy) {
  const f = new ConeGeometry(rad, len, 4);
  f.rotateX(Math.PI / 2);                  // apex out along +z
  f.scale(1, 0.26, 1);                     // flatten into a blade
  f.translate(0, 0, len * 0.5);
  f.rotateX(droop);
  f.translate(0, oy, oz);
  f.rotateY(yaw);
  f.translate(cx, cy, 0);
  return tint(f, b.colors.palm);
}

function lampGeo(b) {
  const post = new CylinderGeometry(0.08, 0.12, 5.5, 6);
  post.translate(0, 2.75, 0);
  const arm = new BoxGeometry(1.4, 0.1, 0.1);
  arm.translate(0.7, 5.45, 0);
  const head = new BoxGeometry(0.5, 0.25, 0.35);
  head.translate(1.3, 5.28, 0);
  return merge([tint(post, b.colors.lamp), tint(arm, b.colors.lamp), tint(head, b.colors.lampHead)]);
}

function hydrantGeo(b) {
  const body = new CylinderGeometry(0.18, 0.2, 0.8, 8);
  body.translate(0, 0.4, 0);
  const cap = new SphereGeometry(0.19, 8, 5);
  cap.translate(0, 0.8, 0);
  const armL = new BoxGeometry(0.5, 0.14, 0.14);
  armL.translate(0, 0.55, 0);
  return merge([tint(body, b.colors.hydrant), tint(cap, b.colors.hydrant), tint(armL, b.colors.hydrant)]);
}

function mailboxGeo(b) {
  const boxG = new BoxGeometry(0.6, 1.2, 0.5);
  boxG.translate(0, 0.85, 0);
  const parts = [tint(boxG, b.colors.mailbox)];
  for (let s = -1; s <= 1; s += 2) {
    const leg = new BoxGeometry(0.08, 0.25, 0.08);
    leg.translate(s * 0.2, 0.125, 0);
    parts.push(tint(leg, b.colors.lamp));
  }
  return merge(parts);
}

function binGeo(b) {
  const g = new CylinderGeometry(0.3, 0.28, 1, 8);
  g.translate(0, 0.5, 0);
  return tint(g, b.colors.bin);
}

// Mesh-local +Z is the front, so the backrest goes behind the seat at -Z.
function benchGeo(b) {
  const seat = new BoxGeometry(1.8, 0.1, 0.5);
  seat.translate(0, 0.5, 0);
  const back = new BoxGeometry(1.8, 0.5, 0.08);
  back.translate(0, 0.78, -0.21);
  const parts = [tint(seat, b.colors.bench), tint(back, b.colors.bench)];
  for (let s = -1; s <= 1; s += 2) {
    const leg = new BoxGeometry(0.12, 0.5, 0.4);
    leg.translate(s * 0.75, 0.25, 0);
    parts.push(tint(leg, b.colors.lamp));
  }
  return merge(parts);
}

function coneGeo(b) {
  const c = new ConeGeometry(0.3, 0.7, 8);
  c.translate(0, 0.38, 0);
  const base = new BoxGeometry(0.55, 0.06, 0.55);
  base.translate(0, 0.03, 0);
  return merge([tint(c, b.colors.cone), tint(base, b.colors.cone)]);
}

function fountainGeo(b) {
  const basin = new CylinderGeometry(3.2, 3.2, 0.8, 16);
  basin.translate(0, 0.4, 0);
  const water = new CylinderGeometry(2.6, 2.6, 0.9, 16);
  water.translate(0, 0.3, 0);            // surface 0.05 m below the rim, so the basin still reads
  const column = new CylinderGeometry(0.4, 0.6, 2.4, 10);
  column.translate(0, 1.6, 0);
  return merge([
    tint(basin, b.colors.fountain), tint(water, b.colors.water), tint(column, b.colors.fountain),
  ]);
}

function geometryFor(slot, b) {
  switch (slot) {
    case 0: return treeGeo(b, b.colors.canopy);
    case 1: return treeGeo(b, b.colors.canopy2);
    case PROP_TYPE.PINE + 1: return pineGeo(b);
    case PROP_TYPE.PALM + 1: return palmGeo(b);
    case PROP_TYPE.LAMP + 1: return lampGeo(b);
    case PROP_TYPE.HYDRANT + 1: return hydrantGeo(b);
    case PROP_TYPE.MAILBOX + 1: return mailboxGeo(b);
    case PROP_TYPE.BIN + 1: return binGeo(b);
    case PROP_TYPE.BENCH + 1: return benchGeo(b);
    case PROP_TYPE.CONE + 1: return coneGeo(b);
    default: return fountainGeo(b);
  }
}

// ---------------------------------------------------------------- instance matrices

function writeMatrix(gd, p) {
  _pos.set(gd.propX[p], gd.propY[p], gd.propZ[p]);
  _euler.set(gd.propPitch[p], gd.propYaw[p], gd.propRoll[p]);
  _quat.setFromEuler(_euler);
  const s = gd.propScale[p];
  _scl.set(s, s, s);
  _m4.compose(_pos, _quat, _scl);
}

// ---------------------------------------------------------------- entry points

export function buildProps(view, gd, b) {
  const counts = new Int32Array(SLOT_COUNT);
  for (let p = 0; p < gd.propCount; p++) counts[slotOf(gd.propType[p], p)]++;

  const mat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const meshes = new Array(SLOT_COUNT);
  for (let s = 0; s < SLOT_COUNT; s++) {
    if (counts[s] === 0) { meshes[s] = null; continue; }
    const mesh = new InstancedMesh(geometryFor(s, b), mat, counts[s]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    view.scene.add(mesh);
    meshes[s] = mesh;
  }

  const props = {
    meshes,
    material: mat,
    meshOf: new Int32Array(b.maxProps),
    instanceIndexOf: new Int32Array(b.maxProps),
    dirty: new Uint8Array(SLOT_COUNT),
    counts,
  };

  const next = new Int32Array(SLOT_COUNT);
  for (let p = 0; p < gd.propCount; p++) {
    const s = slotOf(gd.propType[p], p);
    const i = next[s]++;
    props.meshOf[p] = s;
    props.instanceIndexOf[p] = i;
    writeMatrix(gd, p);
    meshes[s].setMatrixAt(i, _m4);
  }
  for (let s = 0; s < SLOT_COUNT; s++) if (meshes[s]) meshes[s].instanceMatrix.needsUpdate = true;

  view.props = props;
  return props;
}

// Only the props Logic has knocked out of PROP_STATE.STATIC move, and it lists them for us.
// Allocation-free: reuses the module scratch above and a preallocated dirty-flag array.
export function updateProps(props, view, gd, b) {
  const n = gd.knockedCount;
  if (n === 0) return;
  const meshes = props.meshes, dirty = props.dirty;
  for (let k = 0; k < n; k++) {
    const p = gd.knockedList[k];
    const s = props.meshOf[p];
    const mesh = meshes[s];
    if (mesh === null) continue;
    writeMatrix(gd, p);
    mesh.setMatrixAt(props.instanceIndexOf[p], _m4);
    dirty[s] = 1;
  }
  for (let s = 0; s < SLOT_COUNT; s++) {
    if (dirty[s] === 0) continue;
    meshes[s].instanceMatrix.needsUpdate = true;
    dirty[s] = 0;
  }
}
