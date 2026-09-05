import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, PLAYER_MODE } from '../src/balance.js';
import { allocateGameData } from '../src/gameData.js';
import { startGame, tick } from '../src/logic/tick.js';

function fresh(seed = 7) {
  const gd = {};
  allocateGameData(gd, balance, seed);
  startGame(gd, balance);
  return gd;
}

test('startGame places the player at the spawn point on foot', () => {
  const gd = fresh();
  assert.equal(gd.playerX, balance.playerSpawnX);
  assert.equal(gd.playerZ, balance.playerSpawnZ);
  assert.equal(gd.playerYaw, balance.playerSpawnYaw);
  assert.equal(gd.playerMode, PLAYER_MODE.FOOT);
  assert.equal(gd.playerCar, -1);
  assert.equal(gd.camInit, 0);
  assert.equal(gd.tick, 0);
  assert.equal(gd.time, 0);
});

test('startGame leaves a default camera behind the player', () => {
  const gd = fresh();
  // camera sits camFootDist behind the player, camFootHeight up, looking at the player's head
  const fx = Math.sin(gd.playerYaw), fz = Math.cos(gd.playerYaw);
  assert.ok(Math.abs(gd.camX - (gd.playerX - fx * balance.camFootDist)) < 1e-4);
  assert.ok(Math.abs(gd.camZ - (gd.playerZ - fz * balance.camFootDist)) < 1e-4);
  assert.ok(Math.abs(gd.camY - (gd.playerY + balance.camFootHeight)) < 1e-4);
  assert.ok(Math.abs(gd.camLookX - gd.playerX) < 1e-4);
  assert.ok(Math.abs(gd.camLookZ - gd.playerZ) < 1e-4);
  assert.ok(Math.abs(gd.camLookY - (gd.playerY + 1)) < 1e-4);
  // the camera must actually be somewhere other than the player, or the first frame is inside his head
  const dx = gd.camX - gd.playerX, dz = gd.camZ - gd.playerZ;
  assert.ok(dx * dx + dz * dz > 1);
});

test('120 ticks advance tick and time without throwing', () => {
  const gd = fresh();
  for (let i = 0; i < 120; i++) tick(gd, balance);
  assert.equal(gd.tick, 120);
  assert.ok(Math.abs(gd.time - 2) < 1e-3, `time was ${gd.time}`);
});

test('tick clears the input edges but keeps held keys', () => {
  const gd = fresh();
  const inp = gd.input;
  inp.forward = 1; inp.back = 1; inp.left = 1; inp.right = 1; inp.handbrake = 1;
  inp.action = 1; inp.camToggle = 1; inp.mute = 1;
  inp.orbitDX = 12; inp.orbitDY = -7; inp.zoom = 3;
  tick(gd, balance);
  assert.equal(inp.action, 0);
  assert.equal(inp.camToggle, 0);
  assert.equal(inp.mute, 0);
  assert.equal(inp.orbitDX, 0);
  assert.equal(inp.orbitDY, 0);
  assert.equal(inp.zoom, 0);
  // held keys are the Board's to clear, not the tick's
  assert.equal(inp.forward, 1);
  assert.equal(inp.back, 1);
  assert.equal(inp.left, 1);
  assert.equal(inp.right, 1);
  assert.equal(inp.handbrake, 1);
});

test('tick marks the start of this tick in the event buffers', () => {
  const gd = fresh();
  gd.impCount = 3; gd.expCount = 2; gd.knockCount = 5;
  tick(gd, balance);
  assert.equal(gd.impTickStart, 3);
  assert.equal(gd.expTickStart, 2);
  assert.equal(gd.knockTickStart, 5);
});

test('the tick is deterministic for a given seed', () => {
  const a = fresh(11), b2 = fresh(11);
  for (let i = 0; i < 60; i++) { tick(a, balance); tick(b2, balance); }
  assert.equal(a.playerX, b2.playerX);
  assert.equal(a.playerZ, b2.playerZ);
  assert.equal(a.carCount, b2.carCount);
  assert.equal(a.time, b2.time);
});
