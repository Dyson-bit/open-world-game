import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, validate } from '../src/balance.js';
import { allocateGameData, clearEvents } from '../src/gameData.js';

test('balance validates', () => { validate(balance); });

test('gameData allocates typed arrays sized from balance', () => {
  const gd = {};
  allocateGameData(gd, balance, 3);
  assert.equal(gd.carX.length, balance.maxCars);
  assert.equal(gd.laneX0.length, balance.laneCount);
  assert.equal(gd.pX.length, balance.maxParticles);
  assert.ok(gd.rand() >= 0 && gd.rand() < 1);
  gd.impCount = 5; clearEvents(gd); assert.equal(gd.impCount, 0);
});

test('rng is deterministic per seed', () => {
  const a = {}, b2 = {};
  allocateGameData(a, balance, 42); allocateGameData(b2, balance, 42);
  for (let i = 0; i < 10; i++) assert.equal(a.rand(), b2.rand());
});
