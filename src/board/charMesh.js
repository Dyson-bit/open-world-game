// The player character: a 12-box humanoid with a procedural walk cycle and a tumble when flung.
//
// Board module: reads gd, writes three.js objects, never the other way round. The walk is driven by
// gd.playerWalkPhase (Logic advances it with the player's speed) and NOT by frame time, so the
// legs stay in step with the ground however the frame rate wanders — and a paused game keeps the
// pose it had.
//
// Proportions are a chunky toy figure, not a stick: 1.8 m tall with a head a fifth of that, a
// square torso and thick limbs, so it reads at chase-camera distance where a realistic silhouette
// would vanish. Mesh-local axes (spec §3): +Z is the front, +X is the left flank, +Y is up.
//
// Rig: one Group per limb, pivoting at the shoulder / hip, so swinging a limb is one rotation.x on
// a node that already sits in the right place. The root's rotation order is YXZ so the flung tumble
// and the stunned sprawl happen in the character's own frame — he falls the way he was facing.
import { BoxGeometry, Group, Mesh, MeshLambertMaterial } from 'three';
import { PLAYER_MODE } from '../balance.js';

// ---- the skeleton, in metres above the ground ----
const HIP_Y = 0.82;             // top of the legs = bottom of the torso
const TORSO_H = 0.62;
const SHOULDER_Y = 1.38;        // a little below the torso's top
const HEAD_Y = 1.62;            // centre of a 0.36 cube whose chin rests on the shoulders
const LEG_LEN = 0.7;
const ARM_LEN = 0.6;
const HIP_X = 0.15;           // wide enough that the two legs read as two, not one blue trunk
const SHOULDER_X = 0.33;        // torso half-width 0.25 + arm half-width 0.08: flush to the flank

const SWING = 0.8;              // radians of limb swing at a full run
const BOB = 0.06;
const FULL_STRIDE_SPEED = 3;    // walk speed at which the swing and bob reach full size
const STUN_PITCH = -1.4;
const STUN_LIFT = 0.3;
const FLUNG_ARM = -1.9;         // arms thrown up over the head while airborne
const FLUNG_LEG = 0.55;

function box(w, h, d, mat, x, y, z) {
  const mesh = new Mesh(new BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

// A limb: a pivot Group at the joint, with the limb hanging below it, so rotation.x swings it.
function limb(px, py, len, w, d, limbMat, cuffMat, cuffH, cuffPad, foot) {
  const pivot = new Group();
  pivot.position.set(px, py, 0);
  pivot.add(box(w, len, d, limbMat, 0, -len * 0.5, 0));
  if (cuffMat) pivot.add(box(w + cuffPad, cuffH, d + cuffPad, cuffMat, 0, -cuffH * 0.5, 0));
  if (foot) pivot.add(box(0.22, 0.12, 0.32, foot, 0, -len - 0.06, 0.05));
  return pivot;
}

export function createCharacter(view, gd, b) {
  const c = b.colors;
  const skin = new MeshLambertMaterial({ color: c.skin });
  const shirt = new MeshLambertMaterial({ color: c.shirt });
  const pants = new MeshLambertMaterial({ color: c.pants });
  const shoes = new MeshLambertMaterial({ color: c.shoes });
  const hair = new MeshLambertMaterial({ color: c.hair });

  const root = new Group();
  root.rotation.order = 'YXZ';

  root.add(box(0.36, 0.36, 0.36, skin, 0, HEAD_Y, 0));
  root.add(box(0.38, 0.13, 0.38, hair, 0, HEAD_Y + 0.15, 0));            // cap of hair
  root.add(box(0.38, 0.20, 0.10, hair, 0, HEAD_Y + 0.02, -0.15));        // and down the back
  root.add(box(0.50, TORSO_H, 0.28, shirt, 0, HIP_Y + TORSO_H * 0.5, 0));
  root.add(box(0.52, 0.12, 0.30, pants, 0, HIP_Y + 0.02, 0));            // belt line

  const armL = limb(SHOULDER_X, SHOULDER_Y, ARM_LEN, 0.16, 0.16, skin, shirt, 0.26, 0.03, null);
  const armR = limb(-SHOULDER_X, SHOULDER_Y, ARM_LEN, 0.16, 0.16, skin, shirt, 0.26, 0.03, null);
  const legL = limb(HIP_X, HIP_Y, LEG_LEN, 0.20, 0.20, pants, null, 0, 0, shoes);
  const legR = limb(-HIP_X, HIP_Y, LEG_LEN, 0.20, 0.20, pants, null, 0, 0, shoes);
  root.add(armL); root.add(armR); root.add(legL); root.add(legR);

  view.scene.add(root);
  return { root, armL, armR, legL, legR };
}

// Allocation-free: every write below lands on an object built above.
export function updateCharacter(ch, view, gd, b, dtFrame) {
  const root = ch.root;
  const mode = gd.playerMode;

  if (mode === PLAYER_MODE.IN_CAR) { root.visible = false; return; }
  root.visible = true;

  root.position.x = gd.playerX;
  root.position.z = gd.playerZ;
  root.rotation.y = gd.playerYaw;

  if (mode === PLAYER_MODE.FOOT) {
    // How much of the stride is showing. The phase is frozen when he stands still, so scaling by
    // it here is what actually settles the limbs (and the bob) back to a neutral stand.
    let amt = gd.playerSpeed / FULL_STRIDE_SPEED;
    if (amt > 1) amt = 1;
    const s = Math.sin(gd.playerWalkPhase) * SWING * amt;
    ch.legL.rotation.x = s;
    ch.legR.rotation.x = -s;
    ch.armL.rotation.x = -s;                 // arms counter the leg on the same side
    ch.armR.rotation.x = s;
    const bob = Math.abs(Math.sin(gd.playerWalkPhase * 2)) * BOB * amt;
    root.position.y = gd.playerY + bob;
    root.rotation.x = 0;
  } else if (mode === PLAYER_MODE.FLUNG) {
    root.position.y = gd.playerY;
    root.rotation.x = gd.playerTumble;
    ch.armL.rotation.x = FLUNG_ARM;
    ch.armR.rotation.x = FLUNG_ARM;
    ch.legL.rotation.x = FLUNG_LEG;
    ch.legR.rotation.x = -FLUNG_LEG;
  } else {                                    // STUNNED: flat on his back, limbs splayed
    root.position.y = gd.playerY + STUN_LIFT;
    root.rotation.x = STUN_PITCH;
    ch.armL.rotation.x = FLUNG_ARM;
    ch.armR.rotation.x = FLUNG_ARM;
    ch.legL.rotation.x = 0.2;
    ch.legR.rotation.x = -0.2;
  }
}
