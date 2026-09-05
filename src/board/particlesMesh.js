// Instanced particle boxes, the explosion shock rings and the skid-mark mesh, all driven from the
// gd pools. Three draw calls for the entire effects layer.
//
//   - every particle except SHOCK is one instance of a unit box in a single InstancedMesh with
//     per-instance colour. Unlit (MeshBasicMaterial) on purpose: a flame that the sun can shade is
//     not a flame, and at golden hour a lit grey box on the shadow side of a car is invisible.
//   - SHOCK rings get their own small InstancedMesh of a flat RingGeometry, because a box scaled
//     flat does not read as a shock wave.
//   - skid marks are one pre-allocated BufferGeometry of maxSkids * 2 triangles, rewritten from
//     the ring buffer every frame (1024 quads is nothing) with a 4-component colour attribute so
//     each mark can fade out on its own as it ages.
//
// Allocation-free per frame: every three.js object it touches lives at module scope or in fx.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, Euler, InstancedMesh, Matrix4,
  Mesh, MeshBasicMaterial, Quaternion, RingGeometry, SRGBColorSpace, Vector3,
} from 'three';
import { PARTICLE } from '../balance.js';

// Module-scope scratch: updateParticles() never allocates.
const _m4 = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _dir = new Vector3();
const _zAxis = new Vector3(0, 0, 1);
const _col = new Color();
const _fog = new Color();
const _skidCol = new Color();

const VERTS_PER_SKID = 6;            // two triangles
const SKID_Y = 0.13;                 // just proud of the tarmac; polygonOffset does the rest
const SKID_FADE_START = 30;          // seconds before a mark starts to go
const SKID_FADE_LEN = 10;            // ...and how long it takes to disappear
const SKID_DARK = 0.35;              // see writeSkids: the unlit mark has to be pushed under the
                                     // lit road before it reads as rubber rather than paint
const SMOKE_FADE = 0.45;
const SMOKE_HAZE = 0.08;             // how far a dying particle drifts toward the fog colour
const DUST_HAZE = 0.45;             // fraction of life over which smoke shrinks away
const SPARK_STRETCH = 0.06;          // metres of streak per m/s of spark speed
const TUMBLE = 1.2;                  // radians per second of particle tumble

// Hot core: a young flame is near-white yellow, a dying one falls back to its own deep orange.
const FIRE_G = 0.95;
const FIRE_B = 0.55;

export function createParticles(view, gd, b) {
  // ---- boxes -------------------------------------------------------------
  const boxGeo = new BoxGeometry(1, 1, 1);
  const boxMat = new MeshBasicMaterial({
    vertexColors: false, transparent: true, opacity: 0.9, depthWrite: false,
  });
  const mesh = new InstancedMesh(boxGeo, boxMat, b.maxParticles);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.count = 0;
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < b.maxParticles; i++) mesh.setColorAt(i, _col);   // allocates instanceColor
  view.scene.add(mesh);

  // ---- shock rings -------------------------------------------------------
  const ringGeo = new RingGeometry(0.7, 1, 40);
  ringGeo.rotateX(-Math.PI / 2);                                       // lying flat, facing up
  const ringMat = new MeshBasicMaterial({
    transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide,
  });
  const ringCap = b.maxExplosions * 2;
  const rings = new InstancedMesh(ringGeo, ringMat, ringCap);
  rings.frustumCulled = false;
  rings.matrixAutoUpdate = false;
  rings.updateMatrix();
  rings.count = 0;
  for (let i = 0; i < ringCap; i++) rings.setColorAt(i, _col);
  view.scene.add(rings);

  // ---- skids -------------------------------------------------------------
  const skidVerts = b.maxSkids * VERTS_PER_SKID;
  const skidPos = new Float32Array(skidVerts * 3);
  const skidCol = new Float32Array(skidVerts * 4);                     // rgba: itemSize 4 gives
  const skidGeo = new BufferGeometry();                                // the shader vertex alphas
  skidGeo.setAttribute('position', new BufferAttribute(skidPos, 3));
  skidGeo.setAttribute('color', new BufferAttribute(skidCol, 4));
  skidGeo.setDrawRange(0, 0);
  const skidMat = new MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 1, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: DoubleSide,
  });
  const skids = new Mesh(skidGeo, skidMat);
  skids.frustumCulled = false;
  skids.position.y = SKID_Y;
  skids.renderOrder = -1;                                              // under the smoke, not over
  view.scene.add(skids);

  const fx = {
    mesh, boxGeo, boxMat,
    rings, ringGeo, ringMat, ringCap,
    skids, skidGeo, skidMat, skidPos, skidCol,
    lastSkidVerts: 0,
  };
  view.fx = fx;
  return fx;
}

// One Board update. Reads gd.pCount particles and gd.skidCount segments; writes nothing back.
export function updateParticles(fx, view, gd, b) {
  _fog.setHex(b.colors.fog);
  writeParticles(fx, gd, b);
  writeSkids(fx, gd, b);
}

// ---------------------------------------------------------------- particles

function writeParticles(fx, gd, b) {
  const mesh = fx.mesh, rings = fx.rings;
  const n = gd.pCount;
  let boxes = 0, ringCount = 0;

  for (let i = 0; i < n; i++) {
    const type = gd.pType[i];
    const maxLife = gd.pMaxLife[i];
    const f = maxLife > 0 ? gd.pLife[i] / maxLife : 0;      // 1 fresh -> 0 dead
    let s = gd.pSize[i];
    const x = gd.pX[i], y = gd.pY[i], z = gd.pZ[i];

    if (type === PARTICLE.SHOCK) {
      if (ringCount >= fx.ringCap) continue;
      _pos.set(x, y, z);
      _quat.identity();
      _scl.set(s, 1, s);
      _m4.compose(_pos, _quat, _scl);
      rings.setMatrixAt(ringCount, _m4);
      _col.setRGB(gd.pR[i], gd.pG[i], gd.pB[i], SRGBColorSpace);
      _col.lerp(_fog, (1 - f) * 0.7);
      rings.setColorAt(ringCount, _col);
      ringCount++;
      continue;
    }

    // ---- colour ----
    if (type === PARTICLE.FIRE) {
      // hotter (and yellower) the younger it is, so a fireball has a white heart and orange edges
      const h = f * f;
      _col.setRGB(gd.pR[i],
        gd.pG[i] + (FIRE_G - gd.pG[i]) * h,
        gd.pB[i] + (FIRE_B - gd.pB[i]) * h * f, SRGBColorSpace);
    } else if (type === PARTICLE.SMOKE || type === PARTICLE.DUST) {
      // Smoke dissolves into the haze rather than blinking out. The lerp is TINY for smoke and
      // generous for dust because it happens in linear space: 20% of the way from near-black to a
      // sunset peach is already a mid brown, which turns a diesel fire into a dust storm.
      _col.setRGB(gd.pR[i], gd.pG[i], gd.pB[i], SRGBColorSpace);
      _col.lerp(_fog, (1 - f) * (type === PARTICLE.SMOKE ? SMOKE_HAZE : DUST_HAZE));
      if (f < SMOKE_FADE) s *= f / SMOKE_FADE;
    } else {
      _col.setRGB(gd.pR[i], gd.pG[i], gd.pB[i], SRGBColorSpace);
    }
    mesh.setColorAt(boxes, _col);

    // ---- pose ----
    if (type === PARTICLE.SPARK) {
      // a spark is a streak, not a cube: stretched along the way it is travelling
      const vx = gd.pVX[i], vy = gd.pVY[i], vz = gd.pVZ[i];
      const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (l > 1e-3) {
        _dir.set(vx / l, vy / l, vz / l);
        _quat.setFromUnitVectors(_zAxis, _dir);
      } else {
        _quat.identity();
      }
      _scl.set(s, s, s + l * SPARK_STRETCH);
    } else {
      // A slow tumble, seeded from the particle's own position so that swap-remove reshuffling
      // the pool never makes a surviving particle jump to a different angle.
      const a = x * 0.9 + z * 1.7 + (maxLife - gd.pLife[i]) * TUMBLE;
      _euler.set(a * 0.7, a, a * 0.4);
      _quat.setFromEuler(_euler);
      _scl.set(s, s, s);
    }
    _pos.set(x, y, z);
    _m4.compose(_pos, _quat, _scl);
    mesh.setMatrixAt(boxes, _m4);
    boxes++;
  }

  mesh.count = boxes;
  if (boxes > 0) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  rings.count = ringCount;
  if (ringCount > 0) {
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- skid marks

function writeSkids(fx, gd, b) {
  const n = gd.skidCount;
  const verts = n * VERTS_PER_SKID;
  if (n === 0) {
    if (fx.lastSkidVerts !== 0) { fx.skidGeo.setDrawRange(0, 0); fx.lastSkidVerts = 0; }
    return;
  }
  const pos = fx.skidPos, col = fx.skidCol;
  // b.colors.skid is authored as a plausible rubber grey, but this material is UNLIT: it draws at
  // its full value while the tarmac around it — a darker colour to begin with — is a Lambert
  // surface at a 24 degree sun, so the mark came out LIGHTER than the road it was meant to mark.
  // Scaling it down is what makes a skid read as a skid, in sun and in building shadow alike.
  _skidCol.setHex(b.colors.skid);
  _skidCol.multiplyScalar(SKID_DARK);
  const cr = _skidCol.r, cg = _skidCol.g, cb = _skidCol.b;

  for (let s = 0; s < n; s++) {
    const x0 = gd.skidX0[s], z0 = gd.skidZ0[s];
    const x1 = gd.skidX1[s], z1 = gd.skidZ1[s];
    const hw = gd.skidW[s] * 0.5;
    let dx = x1 - x0, dz = z1 - z0;
    const l = Math.sqrt(dx * dx + dz * dz);
    let px, pz;
    if (l > 1e-5) { px = -dz / l * hw; pz = dx / l * hw; } else { px = hw; pz = 0; }

    // two triangles: (A B C) (B D C) with A/B the near corners and C/D the far ones
    const ax = x0 + px, az = z0 + pz;
    const bx = x0 - px, bz = z0 - pz;
    const cx = x1 + px, cz = z1 + pz;
    const dxx = x1 - px, dz2 = z1 - pz;
    let o = s * VERTS_PER_SKID * 3;
    pos[o] = ax; pos[o + 1] = 0; pos[o + 2] = az;
    pos[o + 3] = bx; pos[o + 4] = 0; pos[o + 5] = bz;
    pos[o + 6] = cx; pos[o + 7] = 0; pos[o + 8] = cz;
    pos[o + 9] = bx; pos[o + 10] = 0; pos[o + 11] = bz;
    pos[o + 12] = dxx; pos[o + 13] = 0; pos[o + 14] = dz2;
    pos[o + 15] = cx; pos[o + 16] = 0; pos[o + 17] = cz;

    const age = gd.skidAge[s];
    let a = 1;
    if (age > SKID_FADE_START) {
      a = 1 - (age - SKID_FADE_START) / SKID_FADE_LEN;
      if (a < 0) a = 0;
    }
    o = s * VERTS_PER_SKID * 4;
    for (let v = 0; v < VERTS_PER_SKID; v++) {
      col[o] = cr; col[o + 1] = cg; col[o + 2] = cb; col[o + 3] = a;
      o += 4;
    }
  }

  fx.skidGeo.setDrawRange(0, verts);
  fx.skidGeo.attributes.position.needsUpdate = true;
  fx.skidGeo.attributes.color.needsUpdate = true;
  fx.lastSkidVerts = verts;
}
