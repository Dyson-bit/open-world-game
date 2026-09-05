// The fixed 1/60 s step. Orchestrates every other Logic module in the order of spec §7.
// Logic module: imports only balance (and its sibling Logic modules), never three, never the DOM,
// never Math.random. Allocation-free: no object literals, closures or `new` anywhere below.
import { PLAYER_MODE } from '../balance.js';
import { generateCity } from './city.js';
import { placeParkedCars, placeTraffic, manageTraffic } from './spawn.js';
import { updatePlayer } from './player.js';
import { updateTraffic } from './traffic.js';
import { integrateCars } from './vehicle.js';
import { resolveCollisions } from './collision.js';
import { updateProps } from './props.js';
import { updateDamage } from './damage.js';
import { updateParticles } from './particles.js';
import { updateCamera } from './camera.js';

// Build the world and put the player on the pavement at the spawn point.
// Called once after allocateGameData; never inside the frame path.
export function startGame(gd, b) {
  generateCity(gd, b);
  placeParkedCars(gd, b);
  placeTraffic(gd, b);

  gd.playerX = b.playerSpawnX;
  gd.playerY = 0;
  gd.playerZ = b.playerSpawnZ;
  gd.playerYaw = b.playerSpawnYaw;
  gd.playerVX = 0; gd.playerVY = 0; gd.playerVZ = 0;
  gd.playerMode = PLAYER_MODE.FOOT;
  gd.playerCar = -1;
  gd.playerLastCar = -1;
  gd.playerTimer = 0;
  gd.playerTumble = 0;
  gd.playerWalkPhase = 0;
  gd.playerSpeed = 0;
  gd.nearestCar = -1;
  gd.nearestCarDist = 0;

  gd.time = 0;
  gd.tick = 0;
  gd.camInit = 0;

  // The camera has never been placed, and the title card renders whole frames before the first
  // tick runs. Seed the chase pose behind the player so that very first frame already shows him
  // from behind; updateCamera then snaps to its own answer on tick 1 (camInit is still 0).
  {
    const fx = Math.sin(gd.playerYaw), fz = Math.cos(gd.playerYaw);
    gd.camFwdX = fx; gd.camFwdZ = fz;   // T6: the forward the chase camera sits behind
    gd.camX = gd.playerX - fx * b.camFootDist;
    gd.camY = gd.playerY + b.camFootHeight;
    gd.camZ = gd.playerZ - fz * b.camFootDist;
    gd.camLookX = gd.playerX;
    gd.camLookY = gd.playerY + 1;
    gd.camLookZ = gd.playerZ;
    gd.camFov = b.camFovMin;
    gd.camYawOffset = 0;
    gd.camPitchOffset = 0;
    gd.camShake = 0;
  }
}

// One fixed step. Events written here accumulate until main calls clearEvents() after the render,
// so each system reads only the slice it owns: [impTickStart, impCount) etc.
export function tick(gd, b) {
  // 1. mark where this tick's events start (the frame's earlier ticks keep theirs)
  gd.impTickStart = gd.impCount;
  gd.expTickStart = gd.expCount;
  gd.knockTickStart = gd.knockCount;

  // 2..10 — spec §7 order
  updatePlayer(gd, b);
  updateTraffic(gd, b);
  integrateCars(gd, b);
  // §7 step 5. resolveCollisions refreshes the car OBB corners and AABBs itself, first thing —
  // calling updateCarBounds here as well would do every car's trig twice for nothing.
  resolveCollisions(gd, b);
  updateProps(gd, b);
  updateDamage(gd, b);
  updateParticles(gd, b);
  manageTraffic(gd, b);
  updateCamera(gd, b);

  // 11. timers
  gd.time += b.dt;
  gd.tick++;

  // Edges are consumed by exactly one tick. Held keys stay — the Board clears those on keyup.
  const inp = gd.input;
  inp.action = 0;
  inp.camToggle = 0;
  inp.mute = 0;
  inp.orbitDX = 0;
  inp.orbitDY = 0;
  inp.zoom = 0;
}
