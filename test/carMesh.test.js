// Task 5 — car body geometry, ride height, brake lights, wreck look and impact dents.
// three.js resolves in node from node_modules (r185, the same revision the browser importmap
// serves from vendor/), so the Board's geometry code is testable without a canvas: Scene, Mesh and
// InstancedMesh are plain objects until a WebGLRenderer touches them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Scene, PerspectiveCamera } from 'three';
import { balance, CAR_STATE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { spawnCar } from '../src/logic/spawn.js';
import { buildCarGeometry, createCars, updateCars } from '../src/board/carMesh.js';

const b = balance;
const PAINT = 0xff0000;

function view() {
  return { scene: new Scene(), camera: new PerspectiveCamera() };
}

// A world with no city in it: the car slots are all this test needs.
function bare(seed = 7) {
  const gd = {};
  allocateGameData(gd, b, seed);
  return gd;
}

test('every type builds a merged, vertex-coloured body', () => {
  for (let t = 0; t < b.carTypeCount; t++) {
    const g = buildCarGeometry(t, PAINT, b);
    const name = b.carName[t];
    assert.ok(g.attributes.position.count > 100, `${name}: only ${g.attributes.position.count} vertices`);
    assert.ok(g.attributes.color, `${name}: no colour attribute`);
    assert.equal(g.attributes.color.count, g.attributes.position.count, `${name}: colour/position mismatch`);
    assert.equal(g.index, null, `${name}: must stay non-indexed so it flat-shades and dents cleanly`);
    assert.ok(g.userData.tailCount > 0, `${name}: no taillight vertex range`);
    assert.ok(g.userData.tailStart + g.userData.tailCount <= g.attributes.position.count,
      `${name}: taillight range runs off the end`);
    assert.equal(g.userData.original.length, g.attributes.position.count * 3,
      `${name}: original positions not kept`);
  }
});

test('bodies match their balance footprint and sit on their wheels', () => {
  for (let t = 0; t < b.carTypeCount; t++) {
    const name = b.carName[t];
    const g = buildCarGeometry(t, PAINT, b);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    const len = bb.max.z - bb.min.z;
    const wid = bb.max.x - bb.min.x;
    assert.ok(Math.abs(len - b.carLen[t]) <= b.carLen[t] * 0.05,
      `${name}: length ${len.toFixed(3)} vs carLen ${b.carLen[t]}`);
    assert.ok(Math.abs(wid - b.carWid[t]) <= b.carWid[t] * 0.05,
      `${name}: width ${wid.toFixed(3)} vs carWid ${b.carWid[t]}`);

    // ride height: nothing hangs below 0.9 * wheelRadius, and that plane is the underside
    const ride = b.carWheelRadius[t] * 0.9;
    assert.ok(Math.abs(bb.min.y - ride) < 0.005,
      `${name}: underside at ${bb.min.y.toFixed(3)}, wanted ${ride.toFixed(3)}`);
    // roof reaches carHgt; only a taxi sign / roof box is allowed above it
    assert.ok(bb.max.y >= b.carHgt[t] * 0.98 && bb.max.y <= b.carHgt[t] * 1.2,
      `${name}: top at ${bb.max.y.toFixed(3)}, carHgt ${b.carHgt[t]}`);
    // the body is symmetric about the car's centreline
    assert.ok(Math.abs(bb.max.x + bb.min.x) < 0.01, `${name}: body is not centred on x`);
  }
});

test('createCars makes one hidden mesh per slot, one shared material and one wheel instance mesh', () => {
  const gd = bare();
  const v = view();
  const cars = createCars(v, gd, b);
  assert.equal(cars.meshes.length, b.maxCars);
  assert.equal(cars.wheels.count, b.maxCars * 4);
  for (let i = 0; i < b.maxCars; i++) {
    assert.equal(cars.meshes[i].visible, false);
    assert.equal(cars.meshes[i].castShadow, true);
    assert.equal(cars.meshes[i].material, cars.material, 'every car must share one material');
  }
  assert.equal(cars.wheels.material, cars.material, 'wheels share the body material');
  // maxCars bodies + 1 wheel mesh
  assert.equal(v.scene.children.length, b.maxCars + 1);
});

test('updateCars builds the dirty slots, poses them and parks the wheels of the rest', () => {
  const gd = bare();
  const v = view();
  gd.camX = 0; gd.camY = 5; gd.camZ = 10;
  const i = spawnCar(gd, b, 3, PAINT, 0, -4, 0.25, CAR_STATE.PARKED);
  assert.equal(i, 0);
  const cars = createCars(v, gd, b);
  updateCars(cars, v, gd, b, 1 / 60);

  const mesh = cars.meshes[0];
  assert.equal(mesh.visible, true);
  assert.ok(mesh.geometry.attributes.position.count > 100);
  assert.equal(mesh.position.x, 0);
  assert.equal(mesh.position.y, 0);
  assert.equal(mesh.position.z, -4);
  assert.ok(Math.abs(mesh.rotation.y - 0.25) < 1e-6);
  assert.equal(mesh.rotation.order, 'YXZ');

  // the four wheels of car 0 sit at y = wheelRadius; every unused slot stays underground
  const m = new Matrix4();
  for (let k = 0; k < 4; k++) {
    cars.wheels.getMatrixAt(k, m);
    assert.ok(Math.abs(m.elements[13] - b.carWheelRadius[3]) < 1e-5,
      `wheel ${k} at y ${m.elements[13]}`);
  }
  cars.wheels.getMatrixAt(4, m);
  assert.equal(m.elements[13], -10);

  // a car 500 m away stops drawing
  gd.carX[0] = 500;
  gd.carZ[0] = 500;
  updateCars(cars, v, gd, b, 1 / 60);
  assert.equal(mesh.visible, false);
  cars.wheels.getMatrixAt(0, m);
  assert.equal(m.elements[13], -10);
});

test('brake lights recolour only the taillight vertex run', () => {
  const gd = bare();
  const v = view();
  spawnCar(gd, b, 0, PAINT, 0, 0, 0, CAR_STATE.PARKED);
  const cars = createCars(v, gd, b);
  updateCars(cars, v, gd, b, 1 / 60);
  gd.carDirty.fill(0);

  const geo = cars.meshes[0].geometry;
  const { tailStart, tailCount } = geo.userData;
  const col = geo.attributes.color.array;
  const before = Float32Array.from(col);

  gd.carBrakeLight[0] = 1;
  updateCars(cars, v, gd, b, 1 / 60);

  let changed = 0;
  for (let vtx = 0; vtx < geo.attributes.color.count; vtx++) {
    const j = vtx * 3;
    const moved = col[j] !== before[j] || col[j + 1] !== before[j + 1] || col[j + 2] !== before[j + 2];
    if (moved) {
      changed++;
      assert.ok(vtx >= tailStart && vtx < tailStart + tailCount,
        `vertex ${vtx} changed colour but is outside the taillight range`);
    }
  }
  assert.equal(changed, tailCount);
  // brighter than the dark-red "off" colour
  assert.ok(col[tailStart * 3] > before[tailStart * 3]);
});

test('an impact dents the panels near it and never punches through the centre plane', () => {
  const gd = bare();
  const v = view();
  spawnCar(gd, b, 1, PAINT, 0, 0, 0, CAR_STATE.PARKED);
  const cars = createCars(v, gd, b);
  updateCars(cars, v, gd, b, 1 / 60);
  gd.carDirty.fill(0);

  const geo = cars.meshes[0].geometry;
  const pos = geo.attributes.position.array;
  const before = Float32Array.from(pos);
  const colBefore = Float32Array.from(geo.attributes.color.array);

  // a nose-on 12 m/s hit dead centre of the front bumper
  gd.impCar[0] = 0;
  gd.impLocalX[0] = 0;
  gd.impLocalZ[0] = b.carLen[1] * 0.5;
  gd.impStrength[0] = 12;
  gd.impCount = 1;
  updateCars(cars, v, gd, b, 1 / 60);

  let moved = 0;
  for (let vtx = 0; vtx < geo.attributes.position.count; vtx++) {
    const j = vtx * 3;
    if (pos[j] !== before[j] || pos[j + 1] !== before[j + 1] || pos[j + 2] !== before[j + 2]) moved++;
    // no vertex crosses the centre plane in x or z
    if (before[j] > 0) assert.ok(pos[j] >= 0, `vertex ${vtx} crossed x = 0`);
    if (before[j] < 0) assert.ok(pos[j] <= 0, `vertex ${vtx} crossed x = 0`);
    if (before[j + 2] > 0) assert.ok(pos[j + 2] >= 0, `vertex ${vtx} crossed z = 0`);
    if (before[j + 2] < 0) assert.ok(pos[j + 2] <= 0, `vertex ${vtx} crossed z = 0`);
  }
  assert.ok(moved >= 20, `only ${moved} vertices moved`);

  // dented panels darken, and the pristine copy is untouched so a wreck can still find the hull
  let darker = 0;
  const col = geo.attributes.color.array;
  for (let k = 0; k < col.length; k++) if (col[k] < colBefore[k] - 1e-6) darker++;
  assert.ok(darker > 0, 'dents must darken the paint');
  assert.deepEqual(geo.userData.original, before);
});

test('weak impacts are ignored', () => {
  const gd = bare();
  const v = view();
  spawnCar(gd, b, 2, PAINT, 0, 0, 0, CAR_STATE.PARKED);
  const cars = createCars(v, gd, b);
  updateCars(cars, v, gd, b, 1 / 60);
  gd.carDirty.fill(0);
  const geo = cars.meshes[0].geometry;
  const before = Float32Array.from(geo.attributes.position.array);

  gd.impCar[0] = 0;
  gd.impLocalX[0] = 0;
  gd.impLocalZ[0] = b.carLen[2] * 0.5;
  gd.impStrength[0] = 3.9;
  gd.impCount = 1;
  updateCars(cars, v, gd, b, 1 / 60);
  assert.deepEqual(geo.attributes.position.array, before);
});

test('a car that becomes a WRECK is charred and crumpled once', () => {
  const gd = bare();
  const v = view();
  spawnCar(gd, b, 1, 0xffffff, 0, 0, 0, CAR_STATE.TRAFFIC);
  const cars = createCars(v, gd, b);
  updateCars(cars, v, gd, b, 1 / 60);
  gd.carDirty.fill(0);

  const geo = cars.meshes[0].geometry;
  const col = geo.attributes.color.array;
  const pos = geo.attributes.position.array;
  const colBefore = Float32Array.from(col);
  const posBefore = Float32Array.from(pos);

  gd.carState[0] = CAR_STATE.WRECK;
  updateCars(cars, v, gd, b, 1 / 60);

  let darker = 0;
  for (let k = 0; k < col.length; k++) if (col[k] < colBefore[k] - 1e-4) darker++;
  assert.ok(darker > col.length * 0.8, `only ${darker}/${col.length} colour channels charred`);
  let moved = 0;
  for (let k = 0; k < pos.length; k++) if (pos[k] !== posBefore[k]) moved++;
  assert.ok(moved > 20, `wreck should crumple; ${moved} coordinates moved`);

  // idempotent: staying a wreck must not char it again
  const colAfter = Float32Array.from(col);
  updateCars(cars, v, gd, b, 1 / 60);
  assert.deepEqual(col, colAfter);
});

test('geometry is rebuilt only for the slots carDirty flags', () => {
  const gd = bare();
  const v = view();
  spawnCar(gd, b, 5, PAINT, 0, 0, 0, CAR_STATE.PARKED);
  const cars = createCars(v, gd, b);
  updateCars(cars, v, gd, b, 1 / 60);
  gd.carDirty.fill(0);
  const geo = cars.meshes[0].geometry;

  updateCars(cars, v, gd, b, 1 / 60);
  assert.equal(cars.meshes[0].geometry, geo, 'a clean slot must keep its geometry object');

  gd.carDirty[0] = 1;
  gd.carType[0] = 6;
  updateCars(cars, v, gd, b, 1 / 60);
  assert.notEqual(cars.meshes[0].geometry, geo, 'a dirty slot must be rebuilt');
});
