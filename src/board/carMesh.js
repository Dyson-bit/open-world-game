// Per-car body geometry (vertex colours, dents, wreck look, brake lights) + instanced wheels.
//
// Draw calls: one Mesh per car slot (b.maxCars of them, all sharing ONE MeshLambertMaterial) plus
// ONE InstancedMesh holding every wheel in the world. A body is merged from box/wedge primitives
// with vertex colours and is rebuilt only when gd.carDirty[i] says the slot changed type, paint or
// state; dents then mutate that geometry's position and colour attributes in place. Nothing in the
// frame path allocates — the pose loop writes through the module-scope scratch objects below.
//
// Mesh-local axes (spec §3): +Z is the FRONT, +X is the LEFT flank, +Y is up. The mesh is placed
// with rotation.y = carYaw, which maps local +Z to world (sin yaw, cos yaw) and local +X to
// (cos yaw, -sin yaw) — the same "left is positive" frame collision writes impLocalX/impLocalZ in.
//
// Ride height: the wheel centre sits at y = wheelRadius so the tyre just kisses y = 0, and the
// body's underside sits at 0.9 * wheelRadius. Every type's lowest vertex is exactly that plane and
// its widest vertices are exactly ±carWid/2 (the mirrors), so the bounding box is the type's own
// footprint — the collision OBB and the thing you see are the same box.
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, Euler, Float32BufferAttribute,
  InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, Quaternion, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR_STATE } from '../balance.js';

// ---------------------------------------------------------------- constants

const CULL_DIST = 420;          // metres from the camera past which a car stops drawing
const CULL_DIST2 = CULL_DIST * CULL_DIST;
const PARKED_WHEEL_Y = -10;     // where a culled car's wheels go to wait

const BUMPER = 0x3a3f47;        // dark chrome — brighter chrome is kept for thin trim
const GRILLE = 0x23252b;
const BED = 0x3b3f47;           // pickup bed floor
const SILL = 0x2a2d33;
const GLASS_WRECK = 0x111111;
const BRAKE_HOT = 0xfff1c0;     // reverse lights
const WRECK_MIX = 0.95;         // T9: the mix happens in LINEAR space, where 0.7 of the way from
                                // a bright bus to charcoal still reads as rust rather than char
const DENT_DARKEN = 0.88;       // a dented panel loses 12% of its colour
const CENTRE_Y = 0.6;           // the body centre dents pull toward, and the impact plane's height
const GLASS_RECESS = 0.03;      // how far the glass band sits inside the paint, per side
const GLASS_EPS = 0.002;        // glass colour match tolerance when charring a wreck

const HEAD_W = 0.28, HEAD_H = 0.16, HEAD_T = 0.08;
const TAIL_W = 0.32, TAIL_H = 0.14, TAIL_T = 0.08;

// Module-scope scratch. updateCars() touches nothing else, so the frame path never allocates.
const _m4 = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');   // yaw (+ steer) first, then the wheel's spin about X
const _col = new Color();
const _col2 = new Color();
const WHITE = new Color(1, 1, 1);

// Where the current type wants its taillights. Set by the per-type builder, consumed by
// buildCarGeometry, which appends the taillight boxes LAST so their vertices are one contiguous
// run that brake lights can recolour without touching anything else.
let _tailX = 0, _tailY = 0, _tailZ = 0, _tailY2 = 0;

// ---------------------------------------------------------------- geometry primitives

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

function countVerts(parts) {
  let n = 0;
  for (let i = 0; i < parts.length; i++) n += parts[i].attributes.position.count;
  return n;
}

// A box whose top and bottom faces can be pulled inward independently on the front (+Z), the back
// (-Z) and both sides (±X). Every corner moves as a pure function of the signs of its own local
// coordinates, so two of these stacked with matching insets at the shared plane stay watertight —
// that is what lets a greenhouse be three separate bands and still look like one solid shape.
function taperBox(w, h, d, x, y, z, hex, fiT, biT, siT, fiB, biB, siB) {
  const src = new BoxGeometry(w, h, d);
  const geo = src.toNonIndexed();
  src.dispose();
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    const top = p[i + 1] > 0;
    const fi = top ? fiT : fiB, bi = top ? biT : biB, si = top ? siT : siB;
    if (p[i + 2] > 0) p[i + 2] -= fi; else p[i + 2] += bi;
    if (p[i] > 0) p[i] -= si; else p[i] += si;
  }
  geo.translate(x, y, z);
  return tint(geo, hex);
}

// A wedge: a box whose TOP face is shrunk. `frontTopInset` rakes a windscreen or a bonnet back,
// `backTopInset` does the same for a rear screen, `sideTopInset` rounds the shoulders in.
function slantBox(w, h, d, x, y, z, hex, frontTopInset, backTopInset, sideTopInset) {
  return taperBox(w, h, d, x, y, z, hex, frontTopInset, backTopInset, sideTopInset, 0, 0, 0);
}

function box(w, h, d, x, y, z, hex) {
  return taperBox(w, h, d, x, y, z, hex, 0, 0, 0, 0, 0, 0);
}

// z of the front (sign +1) or back (sign -1) face of a tapered body at height y — where a
// headlight, grille or badge has to sit to end up just proud of the paint instead of buried in it.
function faceZ(halfD, insetBot, insetTop, y0, y1, y, sign) {
  const f = (y - y0) / (y1 - y0);
  return sign * (halfD - (insetBot + (insetTop - insetBot) * f));
}

function shade(hex, f) {
  _col2.setHex(hex);
  if (f <= 1) _col2.multiplyScalar(f);
  else _col2.lerp(WHITE, f - 1);
  return _col2.getHex();
}

// ---------------------------------------------------------------- shared assemblies

// Belt / glass / roof: three stacked taperBoxes sharing one taper profile. The glass band is
// recessed GLASS_RECESS on every side, which leaves a real shadow groove around the windows
// instead of a flat decal, and the optional pillar is a full-profile slab standing 15 mm proud of
// the paint — together they are what makes the greenhouse read from a chase camera.
function greenhouse(parts, paint, glass, w, d, cz, y0, y1, fi, bi, si, beltT, roofT, pillarZ) {
  const H = y1 - y0;
  const f1 = beltT / H;
  const f2 = (H - roofT) / H;
  const gh = (f2 - f1) * H;
  const gy = y0 + beltT + gh * 0.5;
  const R = GLASS_RECESS;

  parts.push(slantBox(w, beltT, d, 0, y0 + beltT * 0.5, cz, paint, fi * f1, bi * f1, si * f1));
  parts.push(taperBox(w - 2 * R, gh, d - 2 * R, 0, gy, cz, glass,
    fi * f2, bi * f2, si * f2, fi * f1, bi * f1, si * f1));
  parts.push(taperBox(w, roofT, d, 0, y1 - roofT * 0.5, cz, paint,
    fi, bi, si, fi * f2, bi * f2, si * f2));
  if (pillarZ !== undefined) {
    parts.push(taperBox(w + 0.03, gh, 0.10, 0, gy, pillarZ, paint,
      0, 0, si * f2, 0, 0, si * f1));
  }
}

function bumpers(parts, w, h, t, y, z) {
  parts.push(box(w, h, t, 0, y, z, BUMPER));
  parts.push(box(w, h, t, 0, y, -z, BUMPER));
}

// A lens plus the dark bezel that sits just behind it. Without the bezel a cream headlight
// disappears into a white car and a dark-red taillight disappears into a red one; with it, every
// light reads as a light whatever the paint underneath is doing.
function lamps(parts, w, h, t, x, y, z, dir, hex) {
  for (let s = -1; s <= 1; s += 2) {
    parts.push(box(w + 0.10, h + 0.07, t * 0.7, s * x, y, z - dir * 0.02, GRILLE));
    parts.push(box(w, h, t, s * x, y, z, hex));
  }
}

function headlights(parts, x, y, z, hex) {
  lamps(parts, HEAD_W, HEAD_H, HEAD_T, x, y, z, 1, hex);
}

// A darker rocker panel along the bottom of each flank: it grounds the car and stops a saloon's
// side being one unbroken slab of colour.
function rockers(parts, x, y, d, hex) {
  for (let s = -1; s <= 1; s += 2) parts.push(box(0.05, 0.14, d, s * x, y, 0, hex));
}

function mirrors(parts, w, h, t, x, y, z, hex) {
  parts.push(box(w, h, t, x, y, z, hex));
  parts.push(box(w, h, t, -x, y, z, hex));
}

// A door shut line plus a handle, both flanks. Symmetric, so nothing here depends on which side
// is "left" — the asymmetric details (the bus doors) are placed explicitly at -X.
function doorLines(parts, x, y, z, h, hex) {
  for (let s = -1; s <= 1; s += 2) {
    parts.push(box(0.04, h, 0.05, s * x, y, z, hex));
    parts.push(box(0.05, 0.05, 0.18, s * x, y + 0.13, z + 0.30, hex));
  }
}

// ---------------------------------------------------------------- per-type bodies

// PIP — the tall little hatchback. Two boxes: a stubby lower body and a cabin that eats 68% of the
// length and reaches the tail, with big insets all round so it reads as a rounded bubble.
function buildPip(parts, b, type, paint) {
  const c = b.colors;
  const hl = b.carLen[type] * 0.5, hw = b.carWid[type] * 0.5, hgt = b.carHgt[type];
  const yb = b.carWheelRadius[type] * 0.9;
  const belt = 0.88;
  const bw = b.carWid[type] - 0.12, hd = hl - 0.12;

  parts.push(taperBox(bw, belt - yb, hd * 2, 0, (yb + belt) * 0.5, 0, paint,
    0.22, 0.10, 0, 0.10, 0.05, 0.06));
  greenhouse(parts, paint, c.glass, 1.52, 2.46, -0.31, belt, hgt, 0.40, 0.34, 0.12, 0.07, 0.10, -0.20);

  bumpers(parts, bw - 0.06, 0.26, 0.28, 0.44, hl - 0.14);
  rockers(parts, 0.745, yb + 0.10, 2.30, shade(paint, 0.7));

  const zf = faceZ(hd, 0.10, 0.22, yb, belt, 0.76, 1);
  headlights(parts, 0.575, 0.76, zf + 0.03, c.headlight);
  parts.push(box(0.90, HEAD_H + 0.07, 0.06, 0, 0.76, zf + 0.01, GRILLE));
  mirrors(parts, 0.18, 0.09, 0.07, hw - 0.09, 0.93, 0.72, shade(paint, 0.75));
  doorLines(parts, 0.775, 0.60, -0.44, 0.46, shade(paint, 0.72));

  _tailX = 0.575; _tailY = 0.76; _tailZ = faceZ(hd, 0.05, 0.10, yb, belt, 0.76, -1) - 0.03; _tailY2 = 0;
}

// CRUISER / CAB — the three-box saloon: long bonnet, upright cabin, a boot deck with a lip. CAB is
// the same shell in taxi yellow with a roof sign and a checker band, so they share this builder.
function buildSedan(parts, b, type, paint, taxi) {
  const c = b.colors;
  const hl = b.carLen[type] * 0.5, hw = b.carWid[type] * 0.5, hgt = b.carHgt[type];
  const yb = b.carWheelRadius[type] * 0.9;
  const belt = 0.82;
  const bw = b.carWid[type] - 0.12, hd = hl - 0.14;

  parts.push(taperBox(bw, belt - yb, hd * 2, 0, (yb + belt) * 0.5, 0, paint,
    0.26, 0.16, 0, 0.14, 0.08, 0.07));
  greenhouse(parts, paint, c.glass, 1.66, 2.30, -0.20, belt, hgt, 0.44, 0.40, 0.10, 0.06, 0.09, -0.12);
  parts.push(box(1.60, 0.07, 0.85, 0, belt + 0.035, -1.72, paint));       // boot lid step

  bumpers(parts, bw - 0.06, 0.26, 0.30, 0.46, hl - 0.15);
  rockers(parts, 0.815, yb + 0.10, 2.80, shade(paint, 0.7));

  const zf = faceZ(hd, 0.14, 0.26, yb, belt, 0.72, 1);
  headlights(parts, 0.62, 0.72, zf + 0.03, c.headlight);
  parts.push(box(0.90, HEAD_H + 0.07, 0.06, 0, 0.72, zf + 0.01, GRILLE));
  mirrors(parts, 0.18, 0.09, 0.07, hw - 0.09, 0.87, 0.74, shade(paint, 0.75));
  for (let s = -1; s <= 1; s += 2) parts.push(box(0.04, 0.06, 3.30, s * 0.845, 0.60, -0.05, c.chrome));
  doorLines(parts, 0.845, 0.58, -0.30, 0.42, shade(paint, 0.72));

  if (taxi) {
    parts.push(box(0.70, 0.22, 0.30, 0, hgt + 0.11, 0.10, GRILLE));
    parts.push(box(0.56, 0.13, 0.32, 0, hgt + 0.11, 0.10, c.headlight));
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < 6; k++) {
        parts.push(box(0.05, 0.14, 0.28, s * 0.87, 0.70, -0.90 + k * 0.36,
          (k & 1) ? 0x1a1a1a : 0xf2efe6));
      }
    }
  }

  _tailX = 0.62; _tailY = 0.72; _tailZ = faceZ(hd, 0.08, 0.16, yb, belt, 0.72, -1) - 0.03; _tailY2 = 0;
}

// COMET — the wedge. Very low and wide, a bonnet that is 40% of the car, a cabin shoved right back
// over the rear axle, a splitter under the nose and a wing on struts over the tail.
function buildComet(parts, b, type, paint) {
  const c = b.colors;
  const hl = b.carLen[type] * 0.5, hw = b.carWid[type] * 0.5, hgt = b.carHgt[type];
  const yb = b.carWheelRadius[type] * 0.9;
  const belt = 0.74;
  const bw = b.carWid[type] - 0.12, hd = hl - 0.02;

  parts.push(taperBox(bw, belt - yb, hd * 2, 0, (yb + belt) * 0.5, 0, paint,
    0.40, 0.12, 0, 0.10, 0.04, 0.10));
  greenhouse(parts, paint, c.glass, 1.60, 1.86, -0.52, belt, hgt, 0.52, 0.36, 0.17, 0.06, 0.06, -0.86);

  bumpers(parts, bw - 0.16, 0.22, 0.26, 0.42, hl - 0.13);
  parts.push(box(1.80, 0.06, 0.34, 0, 0.33, hl - 0.20, SILL));            // front splitter
  for (let s = -1; s <= 1; s += 2) parts.push(box(0.06, 0.10, 2.60, s * 0.93, 0.40, -0.10, SILL));

  parts.push(box(1.64, 0.07, 0.40, 0, 1.13, -1.80, paint));               // wing
  for (let s = -1; s <= 1; s += 2) parts.push(box(0.11, 0.36, 0.16, s * 0.62, 0.92, -1.80, SILL));

  const zf = faceZ(hd, 0.10, 0.40, yb, belt, 0.66, 1);
  headlights(parts, 0.62, 0.66, zf + 0.03, c.headlight);
  parts.push(box(0.90, HEAD_H + 0.07, 0.06, 0, 0.66, zf + 0.01, GRILLE));
  mirrors(parts, 0.18, 0.09, 0.07, hw - 0.09, 0.78, 0.30, SILL);

  _tailX = 0.62; _tailY = 0.62; _tailZ = faceZ(hd, 0.04, 0.12, yb, belt, 0.62, -1) - 0.03; _tailY2 = 0;
}

// HAULER — the pickup: a tall cab sat over the front axle and an open bed behind it, three thin
// walls and a floor, so the silhouette has a hole in it that nothing else in the set does.
function buildHauler(parts, b, type, paint) {
  const c = b.colors;
  const hl = b.carLen[type] * 0.5, hw = b.carWid[type] * 0.5, hgt = b.carHgt[type];
  const yb = b.carWheelRadius[type] * 0.9;
  const belt = 0.98;
  const bw = b.carWid[type] - 0.12, hd = hl - 0.14;

  parts.push(taperBox(bw, belt - yb, hd * 2, 0, (yb + belt) * 0.5, 0, paint,
    0.20, 0, 0, 0.10, 0, 0.06));
  greenhouse(parts, paint, c.glass, 1.80, 1.55, 0.62, belt, hgt, 0.30, 0.06, 0.06, 0.10, 0.11);

  parts.push(box(1.80, 0.08, 2.25, 0, belt + 0.04, -1.30, BED));          // bed floor
  for (let s = -1; s <= 1; s += 2) parts.push(box(0.14, 0.46, 2.25, s * 0.87, belt + 0.31, -1.30, paint));
  parts.push(box(bw, 0.46, 0.14, 0, belt + 0.31, -hd + 0.07, paint));     // tailgate

  bumpers(parts, bw - 0.06, 0.30, 0.30, 0.52, hl - 0.15);
  rockers(parts, 0.895, yb + 0.10, 3.20, shade(paint, 0.7));

  const zf = faceZ(hd, 0.10, 0.20, yb, belt, 0.86, 1);
  headlights(parts, 0.74, 0.86, zf + 0.03, c.headlight);
  parts.push(box(1.14, HEAD_H + 0.07, 0.06, 0, 0.86, zf + 0.01, GRILLE));
  mirrors(parts, 0.20, 0.16, 0.07, hw - 0.10, 1.30, 1.30, shade(paint, 0.72));
  doorLines(parts, 0.905, 0.70, 0.05, 0.50, shade(paint, 0.72));

  _tailX = 0.74; _tailY = belt + 0.22; _tailZ = -hd - 0.02; _tailY2 = 0;
}

// BOXVAN — one tall slab with a stubby bonnet. Glass only at the front (a deep raked screen and
// the two front side windows); the whole cargo box behind the B-pillar is blank painted panel.
function buildVan(parts, b, type, paint) {
  const c = b.colors;
  const hl = b.carLen[type] * 0.5, hw = b.carWid[type] * 0.5, hgt = b.carHgt[type];
  const yb = b.carWheelRadius[type] * 0.9;
  const belt = 1.06;
  const bw = b.carWid[type] - 0.12, hd = hl - 0.12;
  const dark = shade(paint, 0.72);

  parts.push(taperBox(bw, belt - yb, hd * 2, 0, (yb + belt) * 0.5, 0, paint,
    0.16, 0, 0, 0.06, 0, 0.07));
  parts.push(slantBox(bw, hgt - belt, 2.94, 0, (belt + hgt) * 0.5, -0.91, paint, 0, 0.04, 0.03));
  greenhouse(parts, paint, c.glass, bw, 1.24, 1.18, belt, hgt, 0.34, 0, 0.03, 0.30, 0.11);

  for (let s = -1; s <= 1; s += 2) {                                       // rear door leaves
    parts.push(box(0.86, 1.00, 0.05, s * 0.455, 1.60, -2.405, dark));
    parts.push(box(0.05, 0.08, 3.90, s * 0.965, 1.14, -0.42, dark));       // rub strip
  }

  bumpers(parts, bw - 0.12, 0.30, 0.28, 0.50, hl - 0.14);
  rockers(parts, 0.910, yb + 0.10, 3.00, shade(paint, 0.7));

  const zf = faceZ(hd, 0.06, 0.16, yb, belt, 0.90, 1);
  headlights(parts, 0.745, 0.90, zf + 0.03, c.headlight);
  parts.push(box(1.10, HEAD_H + 0.07, 0.06, 0, 0.90, zf + 0.01, GRILLE));
  mirrors(parts, 0.18, 0.20, 0.07, hw - 0.09, 1.55, 1.70, dark);

  _tailX = 0.75; _tailY = 1.20; _tailZ = -hd - 0.03; _tailY2 = 0;
}

// BUS — 11 m of flat slab with a lighter roof, a band of eight windows down each flank, a
// destination blind over the screen, and the passenger doors on the RIGHT of the vehicle, which in
// mesh-local terms (+X = left) is -X.
function buildBus(parts, b, type, paint) {
  const c = b.colors;
  const hl = b.carLen[type] * 0.5, hw = b.carWid[type] * 0.5, hgt = b.carHgt[type];
  const yb = b.carWheelRadius[type] * 0.9;
  const bw = b.carWid[type] - 0.12, hd = hl - 0.15;
  const skirtTop = 0.75, roofBase = hgt - 0.16;
  const dark = shade(paint, 0.6);

  parts.push(box(bw, skirtTop - yb, hd * 2, 0, (yb + skirtTop) * 0.5, 0, shade(paint, 0.78)));
  parts.push(slantBox(bw, roofBase - skirtTop, hd * 2, 0, (skirtTop + roofBase) * 0.5, 0, paint,
    0.10, 0.08, 0.02));
  parts.push(slantBox(2.34, 0.16, 10.50, 0, hgt - 0.08, 0, shade(paint, 1.45), 0.14, 0.12, 0.10));

  for (let s = -1; s <= 1; s += 2) {
    for (let k = 0; k < 8; k++) {
      parts.push(box(0.06, 0.78, 1.00, s * 1.175, 2.10, -4.325 + k * 1.15, c.glass));
    }
  }
  parts.push(box(2.15, 0.95, 0.06, 0, 2.15, 5.30, c.glass));               // windscreen
  parts.push(box(2.05, 0.75, 0.06, 0, 2.15, -5.30, c.glass));              // rear screen
  parts.push(box(1.60, 0.26, 0.06, 0, 2.68, 5.29, c.headlight));           // destination blind

  // doors, right-hand side = mesh -X, two leaves each
  for (let d = 0; d < 2; d++) {
    const dz = d === 0 ? 4.00 : -0.30;
    parts.push(box(0.06, 1.80, 0.44, -1.215, 1.65, dz - 0.235, dark));
    parts.push(box(0.06, 1.80, 0.44, -1.215, 1.65, dz + 0.235, dark));
  }

  bumpers(parts, 2.30, 0.34, 0.30, 0.63, hl - 0.15);
  headlights(parts, 0.85, 0.95, 5.36, c.headlight);
  parts.push(box(1.20, HEAD_H + 0.07, 0.06, 0, 0.95, 5.34, GRILLE));
  mirrors(parts, 0.16, 0.40, 0.07, hw - 0.08, 2.30, 5.05, dark);
  mirrors(parts, 0.16, 0.05, 0.05, 1.08, 2.48, 5.05, dark);

  _tailX = 0.85; _tailY = 0.95; _tailZ = -5.37; _tailY2 = 1.25;
}

// ---------------------------------------------------------------- buildCarGeometry

// One merged, vertex-coloured BufferGeometry for a car of `type` painted `paint`. Non-indexed with
// per-face normals, so it flat-shades, dents cleanly and can be recoloured a vertex at a time.
// userData carries the taillight vertex run (for brake lights) and a pristine copy of the
// positions (for picking wreck dent centres off the body's own hull).
export function buildCarGeometry(type, paint, b) {
  const parts = [];
  const name = b.carName[type];
  _tailY2 = 0;
  if (name === 'PIP') buildPip(parts, b, type, paint);
  else if (name === 'CRUISER') buildSedan(parts, b, type, paint, false);
  else if (name === 'CAB') buildSedan(parts, b, type, paint, true);
  else if (name === 'COMET') buildComet(parts, b, type, paint);
  else if (name === 'HAULER') buildHauler(parts, b, type, paint);
  else if (name === 'BOXVAN') buildVan(parts, b, type, paint);
  else buildBus(parts, b, type, paint);

  // bezels first — they are paint-independent trim and must stay OUT of the brake-light run
  parts.push(box(TAIL_W + 0.10, TAIL_H + 0.07, TAIL_T * 0.7, _tailX, _tailY, _tailZ + 0.02, GRILLE));
  parts.push(box(TAIL_W + 0.10, TAIL_H + 0.07, TAIL_T * 0.7, -_tailX, _tailY, _tailZ + 0.02, GRILLE));
  if (_tailY2 > 0) {
    parts.push(box(TAIL_W + 0.10, TAIL_H + 0.07, TAIL_T * 0.7, _tailX, _tailY2, _tailZ + 0.02, GRILLE));
    parts.push(box(TAIL_W + 0.10, TAIL_H + 0.07, TAIL_T * 0.7, -_tailX, _tailY2, _tailZ + 0.02, GRILLE));
  }
  const tailStart = countVerts(parts);
  parts.push(box(TAIL_W, TAIL_H, TAIL_T, _tailX, _tailY, _tailZ, b.colors.taillight));
  parts.push(box(TAIL_W, TAIL_H, TAIL_T, -_tailX, _tailY, _tailZ, b.colors.taillight));
  if (_tailY2 > 0) {
    parts.push(box(TAIL_W, TAIL_H, TAIL_T, _tailX, _tailY2, _tailZ, b.colors.taillight));
    parts.push(box(TAIL_W, TAIL_H, TAIL_T, -_tailX, _tailY2, _tailZ, b.colors.taillight));
  }
  const tailCount = countVerts(parts) - tailStart;

  const geo = merge(parts);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.userData = {
    tailStart, tailCount,
    original: Float32Array.from(geo.attributes.position.array),
  };
  return geo;
}

// ---------------------------------------------------------------- wheels

// Radius 1, height 1, axle along local X, with a hub disc a hair wider than the tyre so the
// hubcap catches the light. Every wheel in the world is this one geometry, scaled per instance to
// (0.32, wheelRadius, wheelRadius).
function wheelGeometry(b) {
  const tyre = new CylinderGeometry(1, 1, 1, 12);
  tyre.rotateZ(Math.PI / 2);
  const hub = new CylinderGeometry(0.55, 0.55, 1.02, 12);
  hub.rotateZ(Math.PI / 2);
  return merge([tint(tyre, b.colors.tyre), tint(hub, b.colors.hub)]);
}

// ---------------------------------------------------------------- dents / wreck / brake lights

// The brief's deterministic per-vertex jitter: fract(sin(i * 12.9898) * 43758.5).
function hash1(i) {
  const s = Math.sin(i * 12.9898) * 43758.5;
  return s - Math.floor(s);
}

// A second, integer-mixing hash for the wreck's dent placement. A closure-based PRNG would
// allocate, and this has to be callable from the frame path when a car dies.
function hash2(a, k) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Crush the panels within `r` of a local point toward the body centre. Returns how many vertices
// moved. Nothing here allocates: it walks the attribute arrays in place.
function applyDent(geo, lx, ly, lz, strength) {
  const pos = geo.attributes.position, colAttr = geo.attributes.color;
  const p = pos.array, cA = colAttr.array;
  const s = strength < 20 ? strength : 20;
  const r = 1.0 + s * 0.06;
  const depth = 0.4 * (strength < 15 ? strength / 15 : 1);
  const r2 = r * r;
  const n = pos.count;
  let touched = 0;
  for (let v = 0; v < n; v++) {
    const j = v * 3;
    const ox = p[j], oy = p[j + 1], oz = p[j + 2];
    const dx = ox - lx, dy = oy - ly, dz = oz - lz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const w = 1 - Math.sqrt(d2) / r;
    const amt = depth * w * (0.7 + 0.6 * hash1(v));
    let vx = -ox, vy = CENTRE_Y - oy, vz = -oz;
    const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (l < 1e-5) continue;
    vx /= l; vy /= l; vz /= l;
    let nx = ox + vx * amt, ny = oy + vy * amt, nz = oz + vz * amt;
    // never let a panel punch through to the other half of the car
    if (ox > 0) { if (nx < 0) nx = 0; } else if (ox < 0 && nx > 0) nx = 0;
    if (oz > 0) { if (nz < 0) nz = 0; } else if (oz < 0 && nz > 0) nz = 0;
    if (oy > CENTRE_Y) { if (ny < CENTRE_Y) ny = CENTRE_Y; } else if (oy < CENTRE_Y && ny > CENTRE_Y) ny = CENTRE_Y;
    p[j] = nx; p[j + 1] = ny; p[j + 2] = nz;
    cA[j] *= DENT_DARKEN; cA[j + 1] *= DENT_DARKEN; cA[j + 2] *= DENT_DARKEN;
    touched++;
  }
  if (touched === 0) return 0;
  pos.needsUpdate = true;
  colAttr.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return touched;
}

// Char: everything 70% of the way to b.colors.wreck, the glass to near-black, then six dents taken
// from the body's own hull so no two wrecks crumple the same way.
function applyWreck(geo, b, seed) {
  const colAttr = geo.attributes.color, cA = colAttr.array;
  const n = colAttr.count;
  _col.setHex(b.colors.wreck);
  const wr = _col.r, wg = _col.g, wb = _col.b;
  _col.setHex(b.colors.glass);
  const gr = _col.r, gg = _col.g, gb = _col.b;
  _col.setHex(GLASS_WRECK);
  const kr = _col.r, kg = _col.g, kb = _col.b;
  for (let v = 0; v < n; v++) {
    const j = v * 3;
    if (Math.abs(cA[j] - gr) < GLASS_EPS && Math.abs(cA[j + 1] - gg) < GLASS_EPS
      && Math.abs(cA[j + 2] - gb) < GLASS_EPS) {
      cA[j] = kr; cA[j + 1] = kg; cA[j + 2] = kb;
    } else {
      cA[j] += (wr - cA[j]) * WRECK_MIX;
      cA[j + 1] += (wg - cA[j + 1]) * WRECK_MIX;
      cA[j + 2] += (wb - cA[j + 2]) * WRECK_MIX;
    }
  }
  colAttr.needsUpdate = true;

  const orig = geo.userData.original;
  for (let k = 0; k < 6; k++) {
    let v = (hash2(seed, k) * n) | 0;
    if (v >= n) v = n - 1;
    const j = v * 3;
    applyDent(geo, orig[j], orig[j + 1], orig[j + 2], 12 + hash2(seed, k + 64) * 6);
  }
}

function setTailColour(geo, hex) {
  const colAttr = geo.attributes.color, a = colAttr.array;
  const start = geo.userData.tailStart, end = start + geo.userData.tailCount;
  _col.setHex(hex);
  for (let v = start; v < end; v++) {
    const j = v * 3;
    a[j] = _col.r; a[j + 1] = _col.g; a[j + 2] = _col.b;
  }
  colAttr.needsUpdate = true;
}

// ---------------------------------------------------------------- entry points

export function createCars(view, gd, b) {
  const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const meshes = new Array(b.maxCars);
  for (let i = 0; i < b.maxCars; i++) {
    const mesh = new Mesh(new BufferGeometry(), material);
    mesh.visible = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    view.scene.add(mesh);
    meshes[i] = mesh;
  }

  const wheels = new InstancedMesh(wheelGeometry(b), material, b.maxCars * 4);
  wheels.castShadow = true;
  wheels.receiveShadow = false;
  wheels.frustumCulled = false;
  _euler.set(0, 0, 0);
  _quat.setFromEuler(_euler);
  _scl.set(1, 1, 1);
  _pos.set(0, PARKED_WHEEL_Y, 0);
  _m4.compose(_pos, _quat, _scl);
  for (let k = 0; k < b.maxCars * 4; k++) wheels.setMatrixAt(k, _m4);
  wheels.instanceMatrix.needsUpdate = true;
  view.scene.add(wheels);

  const cars = {
    meshes, wheels, material,
    built: new Uint8Array(b.maxCars),
    hidden: new Uint8Array(b.maxCars),
    lastState: new Uint8Array(b.maxCars),
    lastBrake: new Uint8Array(b.maxCars),
  };
  cars.lastState.fill(255);
  cars.lastBrake.fill(255);
  cars.hidden.fill(1);
  view.cars = cars;
  return cars;
}

// One Board update for every live car. Allocation-free apart from the geometry rebuilds, which
// only happen for the slots gd.carDirty flags (a spawn, a recycle or a paint change).
export function updateCars(cars, view, gd, b, dtFrame) {
  const meshes = cars.meshes, wheels = cars.wheels;
  const camX = gd.camX, camY = gd.camY, camZ = gd.camZ;
  let wheelsDirty = 0;

  // ---- 1. rebuilds, wreck transitions and brake lights ----
  for (let i = 0; i < gd.carCount; i++) {
    const mesh = meshes[i];
    const state = gd.carState[i];
    if (gd.carDirty[i]) {
      mesh.geometry.dispose();
      mesh.geometry = buildCarGeometry(gd.carType[i], gd.carPaint[i], b);
      cars.built[i] = 1;
      cars.lastBrake[i] = 255;                        // fresh geometry: brake state unknown
      if (state === CAR_STATE.WRECK) applyWreck(mesh.geometry, b, i);
    } else if (cars.built[i] && state === CAR_STATE.WRECK && cars.lastState[i] !== CAR_STATE.WRECK) {
      applyWreck(mesh.geometry, b, i);
      cars.lastBrake[i] = 255;
    }
    cars.lastState[i] = state;

    if (!cars.built[i]) continue;
    const wrecked = state === CAR_STATE.WRECK || state === CAR_STATE.BURNING;
    const brake = wrecked ? 0 : gd.carBrakeLight[i];
    if (!wrecked && cars.lastBrake[i] !== brake) {
      setTailColour(mesh.geometry,
        brake === 1 ? b.colors.taillightOn : (brake === 2 ? BRAKE_HOT : b.colors.taillight));
      cars.lastBrake[i] = brake;
    }
  }

  // ---- 2. dents from this frame's impacts (Logic's events survive until after the render) ----
  for (let k = 0; k < gd.impCount; k++) {
    const s = gd.impStrength[k];
    if (s < 4) continue;
    const c = gd.impCar[k];
    if (c < 0 || c >= gd.carCount || !cars.built[c]) continue;
    applyDent(meshes[c].geometry, gd.impLocalX[k], CENTRE_Y, gd.impLocalZ[k], s);
  }

  // ---- 3. pose the bodies and their wheels ----
  for (let i = 0; i < gd.carCount; i++) {
    const mesh = meshes[i];
    if (!cars.built[i]) continue;
    const x = gd.carX[i], z = gd.carZ[i];
    const dx = x - camX, dz = z - camZ;
    if (dx * dx + camY * camY + dz * dz > CULL_DIST2) {
      if (cars.hidden[i]) continue;
      mesh.visible = false;
      cars.hidden[i] = 1;
      _euler.set(0, 0, 0);
      _quat.setFromEuler(_euler);
      _scl.set(1, 1, 1);
      _pos.set(0, PARKED_WHEEL_Y, 0);
      _m4.compose(_pos, _quat, _scl);
      for (let k = 0; k < 4; k++) wheels.setMatrixAt(i * 4 + k, _m4);
      wheelsDirty = 1;
      continue;
    }
    cars.hidden[i] = 0;
    mesh.visible = true;
    const yaw = gd.carYaw[i];
    mesh.position.set(x, 0, z);
    mesh.rotation.set(gd.carVisPitch[i], yaw, gd.carVisRoll[i], 'YXZ');

    const t = gd.carType[i];
    const wr = b.carWheelRadius[t];
    const ox = b.carWid[t] * 0.5 - 0.12;
    const oz = b.carWheelbase[t] * 0.5;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const spin = gd.carWheelSpin[i], steer = gd.carSteer[i];
    _scl.set(0.32, wr, wr);
    for (let k = 0; k < 4; k++) {
      const front = k < 2;
      const px = (k & 1) ? -ox : ox;
      const pz = front ? oz : -oz;
      _pos.set(x + px * cy + pz * sy, wr, z - px * sy + pz * cy);
      _euler.set(spin, front ? yaw + steer : yaw, 0);
      _quat.setFromEuler(_euler);
      _m4.compose(_pos, _quat, _scl);
      wheels.setMatrixAt(i * 4 + k, _m4);
    }
    wheelsDirty = 1;
  }

  if (wheelsDirty) wheels.instanceMatrix.needsUpdate = true;
}
