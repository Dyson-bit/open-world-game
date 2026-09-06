#!/usr/bin/env node
// Scenario capture harness: plays the whole loop in headless Chrome, screenshots every beat and
// checks the invariants behind it.
//
//   node tools/capture.mjs [--assert] [--out captures] [--seed 7] [--w 1280 --h 720]
//
// It runs one page for the whole run — walk, steal, drive, crash, burn, explode, get thrown out,
// walk again, steal again — because that IS the game loop and a scenario that starts from a fresh
// page proves less. Every scenario appends to captures/report.json:
//
//   { name, ok, checks: [{ name, ok, detail }], state, shot, shots, fallback?, note? }
//
// `state` is __game.state() at the end of the scenario, `shot(s)` the PNG(s) it wrote, `fallback`
// the crutch it had to use (a teleport where it wanted to drive or walk) — a check that needed one
// still passes, but the report says so out loud. `note` is deliberate staging, not a crutch.
//
// The report also carries seed, viewport, three revision, puppeteer version, wall time, every
// console error and warning in full, and an overall `ok`. --assert exits 1 if that `ok` is false;
// without it the harness still writes the report and prints the table.
//
// Everything is driven through window.__game (src/debug.js) with the fixed-step step(n), never
// through wall-clock waits, so two runs of the same seed produce identical states: every check
// detail and every state snapshot in the report matches, and the last scenario, `perf`, is the one
// that deliberately runs on real time. The pixels are all but identical rather than identical —
// the page's own requestAnimationFrame loop keeps rendering between our steps, and the purely
// visual easing that rides on real frame time (HUD animations, mesh smoothing) lands a couple of
// hundred pixels out of 921,600 differently from one run to the next.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { balance, CAR_STATE, PLAYER_MODE } from '../src/balance.js';
import { startServer, launchBrowser, openGame, gameUrl, screenshot, checkHud, root } from './shot.mjs';

const require = createRequire(import.meta.url);
const B = balance;
const MIN_SHOT_BYTES = 30000;   // a 1280x720 PNG of a blank/flat frame is a few KB; a real one is 200 KB+

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const a = { assert: false, out: 'captures', seed: 7, w: 1280, h: 720 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--assert': a.assert = true; break;
      case '--out': a.out = need(k, v); i++; break;
      case '--seed': a.seed = int(k, need(k, v)); i++; break;
      case '--w': a.w = int(k, need(k, v)); i++; break;
      case '--h': a.h = int(k, need(k, v)); i++; break;
      default: throw new Error(`capture: unknown argument "${k}"`);
    }
  }
  return a;
}
function need(flag, v) { if (v === undefined) throw new Error(`capture: ${flag} needs a value`); return v; }
function int(flag, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`capture: ${flag} needs a number, got "${v}"`);
  return Math.round(n);
}

// ---------------------------------------------------------------- report bookkeeping
function scenario(report, name) {
  const sc = { name, ok: true, checks: [], state: null, shot: null, shots: [] };
  report.scenarios.push(sc);
  return sc;
}

function check(sc, name, ok, detail) {
  sc.checks.push({ name, ok: !!ok, detail: String(detail) });
  if (!ok) sc.ok = false;
  return !!ok;
}

const MODE_NAME = ['FOOT', 'IN_CAR', 'FLUNG', 'STUNNED'];
const STATE_NAME = ['PARKED', 'TRAFFIC', 'PLAYER', 'WRECK', 'BURNING', 'STOPPED'];
const modeName = (m) => MODE_NAME[m] || ('?' + m);

// ---------------------------------------------------------------- the run
async function runScenarios(page, args, report) {
  let shotNo = 0;

  const st = () => page.evaluate(() => window.__game.state());
  const step = (n) => page.evaluate((k) => window.__game.step(k), n);
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const hold = (k) => page.evaluate((keys) => window.__game.setInput({
    forward: !!keys.forward, back: !!keys.back, left: !!keys.left, right: !!keys.right, handbrake: !!keys.handbrake,
  }), k || {});

  // The numbers state() does not carry: distance driven, accumulated dent (the honest, persistent
  // record that an impact happened — impact events themselves are cleared at the end of the frame
  // that renders them), how far the nearest car is, and where the player's car is in its burn.
  const peek = () => ev(() => {
    const g = window.__game, gd = g.gd, pc = gd.playerCar;
    let dent = 0;
    if (pc >= 0) for (let j = 0; j < 4; j++) dent += gd.carDent[pc * 4 + j];
    return {
      distance: Math.round(gd.statDistance * 10) / 10,
      dent: Math.round(dent * 1000) / 1000,
      nearestDist: Math.round(gd.nearestCarDist * 100) / 100,
      carState: pc >= 0 ? gd.carState[pc] : -1,
      burnTicks: pc >= 0 ? Math.round(gd.carBurnTimer[pc] / g.b.dt) : 0,
      playerX: Math.round(gd.playerX * 10) / 10,
      playerZ: Math.round(gd.playerZ * 10) / 10,
    };
  });

  async function shot(sc, name) {
    shotNo++;
    const rel = path.join(args.out, String(shotNo).padStart(2, '0') + '-' + name + '.png');
    const abs = await screenshot(page, rel);
    const bytes = fs.statSync(abs).size;
    sc.shots.push(rel);
    if (!sc.shot) sc.shot = rel;
    check(sc, `${path.basename(rel)} has content`, bytes > MIN_SHOT_BYTES, `${(bytes / 1024).toFixed(0)} KB`);
    return rel;
  }

  // Walk one chunk toward (tx,tz). On foot the stick is camera relative (logic/player.js), so the
  // harness does what a player does: work out which of the eight key combinations points closest to
  // where it wants to go, hold those keys, and let go of the rest.
  async function walkChunk(tx, tz, ticks) {
    await ev((t) => {
      const gd = window.__game.gd;
      let fx = gd.camLookX - gd.camX, fz = gd.camLookZ - gd.camZ;
      const fl = Math.sqrt(fx * fx + fz * fz);
      if (fl > 1e-4) { fx /= fl; fz /= fl; } else { fx = 0; fz = 1; }
      const rx = -fz, rz = fx;
      let dx = t[0] - gd.playerX, dz = t[1] - gd.playerZ;
      const dl = Math.sqrt(dx * dx + dz * dz);
      if (dl > 1e-4) { dx /= dl; dz /= dl; }
      const fwd = dx * fx + dz * fz, str = dx * rx + dz * rz;
      const T = 0.383;   // cos 67.5°: the eight-way split of the two sticks
      window.__game.setInput({ forward: fwd > T, back: fwd < -T, right: str > T, left: str < -T, handbrake: false });
    }, [tx, tz]);
    await step(ticks);
  }

  // ------------------------------------------------------------ 1. arrival
  const arrival = scenario(report, 'arrival');
  await step(30);
  let s = await st();
  check(arrival, 'player is on foot', s.playerMode === PLAYER_MODE.FOOT, `playerMode=${modeName(s.playerMode)}`);
  check(arrival, 'the city is populated', s.carCount >= B.trafficCount + B.parkedCount,
    `carCount=${s.carCount} >= trafficCount+parkedCount=${B.trafficCount + B.parkedCount}`);
  let walked = 0;
  await hold({ forward: true });
  do {
    await step(30); walked += 30; s = await st();
  } while (s.nearestCar < 0 && walked < 300);
  await hold({});
  let pk = await peek();
  check(arrival, 'a car is within reach after walking', s.nearestCar >= 0 && pk.nearestDist < 15,
    `nearestCar=${s.nearestCar} at ${pk.nearestDist} m after ${walked} ticks of forward`);
  const hud = await ev(checkHud, false);
  check(arrival, 'the HUD is built', hud.problems.length === 0, hud.problems.length ? hud.problems.join('; ') : hud.found.join(', '));
  await shot(arrival, 'arrival');
  arrival.state = s;

  // ------------------------------------------------------------ 2. steal
  const steal = scenario(report, 'steal');
  const firstCar = await ev(() => window.__game.enterNearestCar());
  await step(5);
  s = await st();
  const firstName = await ev(() => window.__game.b.carName[window.__game.gd.carType[window.__game.gd.playerCar]]);
  check(steal, 'player is in a car', s.playerMode === PLAYER_MODE.IN_CAR, `playerMode=${modeName(s.playerMode)}, car ${s.playerCar} (${firstName})`);
  check(steal, 'one car stolen', s.stolen === 1, `stolen=${s.stolen}`);
  check(steal, 'the stolen car is the one he walked to', s.playerCar === firstCar && firstCar >= 0, `playerCar=${s.playerCar}, enterNearestCar returned ${firstCar}`);
  await step(25);   // the chase camera swings from the pavement to behind the car; 5 ticks in it is
                    // still mid-swing and the frame is a lamp post. The checks above are the ones
                    // the brief asks for at 5 ticks; only the photograph waits.
  await shot(steal, 'steal');
  steal.state = s;

  // ------------------------------------------------------------ 3. drive
  // The car by the plaza is a BUS: 150 ticks of throttle is only 8.1 m/s and 10 m of road, so the
  // scenario holds the throttle in 30-tick chunks until it is genuinely up to speed (capped), and
  // the report says how long that took.
  const drive = scenario(report, 'drive');
  await hold({ forward: true });
  await step(150);
  let driveTicks = 150;
  s = await st(); pk = await peek();
  while (driveTicks < 450 && (s.speed <= 9 || pk.distance <= 25)) {
    await step(30); driveTicks += 30;
    s = await st(); pk = await peek();
  }
  check(drive, 'up to speed', s.speed > 8, `speed=${s.speed} m/s (${Math.round(s.speed * 3.6)} km/h) after ${driveTicks} ticks`);
  check(drive, 'ground covered', pk.distance > 20, `statDistance=${pk.distance} m`);
  check(drive, 'still driving the stolen car', s.playerCar === firstCar, `playerCar=${s.playerCar}`);
  await shot(drive, 'drive');
  drive.state = s;

  // ------------------------------------------------------------ 4. crash
  // Ten-tick chunks, not thirty: the screenshot has to land while the sparks and the dust from the
  // impact are still alive, and at 60 Hz thirty ticks is half a second too late.
  const crash = scenario(report, 'crash');
  let crashTicks = 0;
  s = await st();
  // Ten ticks at a time down an empty road, two when there is something within 25 m to hit: the
  // sparks and glass from an impact only live a fraction of a second, and the frame has to land
  // inside that. gap is the distance to the nearest other live car.
  while (crashTicks < 900 && s.health >= 100) {
    const gap = await ev(() => {
      const gd = window.__game.gd, c = gd.playerCar;
      let best = 1e9;
      for (let i = 0; i < gd.carCount; i++) {
        if (i === c || gd.carState[i] === 3) continue;
        const dx = gd.carX[i] - gd.carX[c], dz = gd.carZ[i] - gd.carZ[c];
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < best) best = d;
      }
      return best;
    });
    const n = gap < 25 ? 2 : 10;
    await step(n); crashTicks += n; s = await st();
  }
  if (s.health >= 100) {
    // Nothing hit in 900 ticks: put the bus on the avenue south of the plaza, pointed at the tower.
    const yaw = Math.atan2(-27 - 0, -27 - -80);
    await ev((y) => window.__game.teleport(0, -80, y), yaw);
    crash.fallback = 'the car hit nothing in 900 ticks, so it was teleported to (0,-80) facing the tower at (-27,-27) and driven into it';
    let extra = 0;
    while (extra < 300 && s.health >= 100) { await step(10); extra += 10; s = await st(); }
    crashTicks += extra;
  }
  pk = await peek();
  check(crash, 'the crash cost health', s.health < 100, `health=${s.health} after ${crashTicks} ticks of throttle`);
  check(crash, 'the body took the impact', pk.dent > 0, `accumulated dent=${pk.dent} (sum over the four sides)`);
  check(crash, 'the player is still in the car', s.playerMode === PLAYER_MODE.IN_CAR, `playerMode=${modeName(s.playerMode)}`);
  // The chase camera sits directly behind a 12 m bus, which hides the entire crash: the car it
  // rear-ended, the crumpled nose and the sparks are all on the far side of the roof. Three-quarter
  // view from the driver's side, level with the impact, while the particles are still alive.
  await ev(() => {
    const gd = window.__game.gd, c = gd.playerCar;
    const yaw = gd.carYaw[c];
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    window.__game.setFreeCamera(
      gd.carX[c] + lx * 11 + fx * 9, 4, gd.carZ[c] + lz * 11 + fz * 9,
      gd.carX[c] + fx * 4.5, 1.2, gd.carZ[c] + fz * 4.5);
  });
  await ev(() => window.__game.render());
  crash.note = 'the crash frame is a three-quarter view from the driver\'s side (setFreeCamera) — the chase camera is behind a 12 m bus and the whole impact happens on the far side of it';
  await shot(crash, 'crash');
  await ev(() => window.__game.clearFreeCamera());
  crash.state = s;

  // ------------------------------------------------------------ 5. wreck (burning → explosion → wreck)
  const wreck = scenario(report, 'wreck');
  await ev(() => window.__game.setHealth(window.__game.gd.playerCar, 1));
  await hold({ forward: true });
  let burnTicks = 0;
  s = await st();
  while (burnTicks < 600 && s.health > 0) { await step(5); burnTicks += 5; s = await st(); }
  if (s.health > 0) {
    const yaw = Math.atan2(-27 - 0, -27 - -80);
    await ev((y) => window.__game.teleport(0, -80, y), yaw);
    wreck.fallback = 'with 1 health left the car still hit nothing in 600 ticks, so it was teleported to (0,-80) facing the tower and driven into it';
    let extra = 0;
    while (extra < 300 && s.health > 0) { await step(5); extra += 5; s = await st(); }
    burnTicks += extra;
  }
  await hold({});
  pk = await peek();
  check(wreck, 'the car is burning', s.health <= 0 && pk.carState === CAR_STATE.BURNING,
    `health=${s.health}, carState=${STATE_NAME[pk.carState]} after ${burnTicks} ticks`);
  // burnTime is 3 s = 180 ticks. peek tells us exactly how many are left, so the burning frame is
  // 4 ticks before the blast and the explosion frame 7 after it, whatever chunk found the fire.
  const toBlast = pk.burnTicks;
  check(wreck, 'the burn is counting down', toBlast > 8 && toBlast <= Math.round(B.burnTime / B.dt),
    `${toBlast} ticks to the blast (burnTime=${B.burnTime}s = ${Math.round(B.burnTime / B.dt)} ticks)`);
  await step(toBlast - 4);
  await shot(wreck, 'burning');
  const preBlast = await st();
  // Seven ticks past the blast, not two: at +2 the fireball is still inside the wreck's silhouette
  // and the shock ring has not left the ground. At +7 both are unmistakable, and the fireball has
  // not yet swallowed the frame (it has by +12).
  await step(11);
  await shot(wreck, 'explosion');
  const blast = await st();
  check(wreck, 'it went off', blast.wrecked >= 1 && preBlast.wrecked === 0,
    `wrecked ${preBlast.wrecked} -> ${blast.wrecked} across the blast`);
  await step(120);
  s = await st();
  check(wreck, 'a wreck is left behind', s.wrecked >= 1, `wrecked=${s.wrecked}`);
  check(wreck, 'the player wrecked exactly one car', s.statWrecked === 1, `statWrecked=${s.statWrecked}`);
  check(wreck, 'the blast threw the player out',
    s.playerMode === PLAYER_MODE.FLUNG || s.playerMode === PLAYER_MODE.STUNNED || s.playerMode === PLAYER_MODE.FOOT,
    `playerMode=${modeName(s.playerMode)} (was IN_CAR)`);
  // Reverse angle: the chase camera is looking the way the blast threw him, i.e. away from the
  // wreck, so the frame that is supposed to show the wreck is framed to show it.
  await ev((c) => {
    const gd = window.__game.gd;
    let dx = gd.playerX - gd.carX[c], dz = gd.playerZ - gd.carZ[c];
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d; dz /= d;
    window.__game.setFreeCamera(gd.playerX + dx * 11, 4.5, gd.playerZ + dz * 11, gd.carX[c], 1.2, gd.carZ[c]);
  }, firstCar);
  await ev(() => window.__game.render());
  wreck.note = 'the wreck frame is a reverse angle (setFreeCamera behind the player, looking back at the wreck) — the chase camera faces the way he was thrown';
  await shot(wreck, 'wreck');
  await ev(() => window.__game.clearFreeCamera());
  wreck.state = s;

  // ------------------------------------------------------------ 6. steal-again
  const again = scenario(report, 'steal-again');
  let recover = 0;
  while (recover < 300 && s.playerMode !== PLAYER_MODE.FOOT) { await step(30); recover += 30; s = await st(); }
  check(again, 'back on his feet after the blast', s.playerMode === PLAYER_MODE.FOOT, `playerMode=${modeName(s.playerMode)} after ${recover} ticks`);
  // findCar: the first parked (so it stays put while he walks) car inside a growing radius.
  let target = -1, radius = 0;
  for (const R of [25, 50, 100, 200, 400]) {
    radius = R;
    target = await ev((r, parked) => window.__game.findCar((i, gd) => {
      if (gd.carState[i] !== parked) return false;
      const dx = gd.carX[i] - gd.playerX, dz = gd.carZ[i] - gd.playerZ;
      return dx * dx + dz * dz < r * r;
    }), R, CAR_STATE.PARKED);
    if (target >= 0) break;
  }
  const tpos = await ev((i) => {
    const gd = window.__game.gd;
    return [gd.carX[i], gd.carZ[i], Math.round(Math.sqrt((gd.carX[i] - gd.playerX) ** 2 + (gd.carZ[i] - gd.playerZ) ** 2) * 10) / 10];
  }, target);
  check(again, 'findCar found another car to steal', target >= 0 && target !== firstCar,
    `findCar -> car ${target}, parked, ${tpos[2]} m away (search radius ${radius} m)`);
  let walkTicks = 0;
  s = await st();
  while (walkTicks < 1200 && s.nearestCar < 0) {
    await walkChunk(tpos[0], tpos[1], 30);
    walkTicks += 30; s = await st();
  }
  await hold({});
  if (s.nearestCar < 0) {
    await ev((t) => window.__game.teleport(t[0] + 2.5, t[1], 0), tpos);
    await step(2);
    s = await st();
    again.fallback = `walking did not reach a car in 1200 ticks, so the player was teleported next to car ${target} at (${tpos[0].toFixed(1)}, ${tpos[1].toFixed(1)})`;
  }
  pk = await peek();
  check(again, 'a second car is within reach', s.nearestCar >= 0,
    `nearestCar=${s.nearestCar} at ${pk.nearestDist} m after ${walkTicks} ticks of walking towards car ${target} — whichever car comes within reach first is the one he takes, so a passing traffic car counts`);
  const secondCar = await ev(() => window.__game.enterNearestCar());
  await step(5);
  s = await st();
  const secondName = await ev(() => window.__game.b.carName[window.__game.gd.carType[window.__game.gd.playerCar]]);
  check(again, 'in a different car', s.playerCar >= 0 && s.playerCar !== firstCar,
    `playerCar=${s.playerCar} (${secondName}), first car was ${firstCar} (${firstName})`);
  check(again, 'two cars stolen', s.stolen === 2, `stolen=${s.stolen}`);
  check(again, 'the first car is still a wreck', s.wrecked >= 1 && secondCar !== firstCar, `wrecked=${s.wrecked}`);
  await step(25);   // as in `steal`: the checks are at 5 ticks, the photograph waits for the camera
  await shot(again, 'steal-again');
  again.state = s;

  // ------------------------------------------------------------ 7. traffic
  const traffic = scenario(report, 'traffic');
  await hold({});
  await ev(() => window.__game.camPreset('street'));
  await step(300);
  s = await st();
  const hurt = await ev((t) => {
    const gd = window.__game.gd;
    let n = 0;
    for (let i = 0; i < gd.carCount; i++) if (gd.carState[i] === t && gd.carHealth[i] < 100) n++;
    return n;
  }, CAR_STATE.TRAFFIC);
  check(traffic, 'traffic is still out there', s.traffic >= B.trafficCount - 5,
    `${s.traffic} cars in TRAFFIC (trafficCount=${B.trafficCount}, tolerance 5)`);
  check(traffic, 'traffic does not destroy itself', hurt <= 10, `${hurt} traffic cars below full health after 300 ticks`);
  // The `street` preset is a fixed kerbside camera and the traffic is wherever the traffic is, so
  // the frame it gives is usually an empty pavement. The shot is taken from a corner above the
  // busiest patch of traffic instead — the same free camera, aimed at the thing being asserted.
  const busiest = await ev((t) => {
    const gd = window.__game.gd;
    let best = -1, bestN = -1e9, bestCount = 0;
    for (let i = 0; i < gd.carCount; i++) {
      if (gd.carState[i] !== t) continue;
      let n = 0;
      for (let j = 0; j < gd.carCount; j++) {
        if (j === i || gd.carState[j] !== t) continue;
        const dx = gd.carX[j] - gd.carX[i], dz = gd.carZ[j] - gd.carZ[i];
        if (dx * dx + dz * dz < 60 * 60) n++;
      }
      // Ties go to the patch nearer the middle of the city: the outskirts are a green field with
      // one road across it, which is a poor picture of "traffic".
      const score = n - Math.sqrt(gd.carX[i] * gd.carX[i] + gd.carZ[i] * gd.carZ[i]) / 40;
      if (score > bestN) { bestN = score; best = i; bestCount = n; }
    }
    if (best < 0) return null;
    // Down the road the traffic is on, not across the block: a corner view from 20 m up is as
    // likely to be looking at the roof of an office as at the cars. A road is an open corridor,
    // so the camera sits behind the car along its own heading, like a helicopter over the street.
    const gx = gd.carX[best], gz = gd.carZ[best];
    const yaw = gd.carYaw[best];
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    window.__game.setFreeCamera(gx - fx * 26, 13, gz - fz * 26, gx + fx * 14, 0.5, gz + fz * 14);
    window.__game.render();
    return { car: best, neighbours: bestCount, x: Math.round(gx), z: Math.round(gz) };
  }, CAR_STATE.TRAFFIC);
  traffic.note = busiest
    ? `framed down the road the traffic is on, behind car ${busiest.car} at (${busiest.x}, ${busiest.z}) — the busiest patch, with ${busiest.neighbours} other traffic cars inside 60 m; the "street" preset is a fixed kerbside camera and the traffic is rarely in front of it`
    : 'no traffic car found to frame; the shot is the "street" preset';
  await shot(traffic, 'traffic');
  await ev(() => window.__game.clearFreeCamera());
  traffic.state = s;

  // ------------------------------------------------------------ 8. postcards
  await ev(() => window.__game.hideHud(true));
  for (const preset of ['skyline', 'plaza', 'park', 'waterfront']) {
    const pc = scenario(report, 'postcard-' + preset);
    await ev((p) => window.__game.camPreset(p), preset);
    await step(2);
    s = await st();
    const hidden = await ev(checkHud, true);
    check(pc, 'the HUD is out of the frame', hidden.problems.length === 0, hidden.problems.join('; ') || 'hud hidden');
    check(pc, 'the frame drew something', s.drawCalls > 20, `drawCalls=${s.drawCalls}`);
    await shot(pc, 'postcard-' + preset);
    pc.state = s;
  }
  await ev(() => window.__game.hideHud(false));

  // ------------------------------------------------------------ 9. gameplay postcard
  // The one postcard with the HUD in it. The `street` camera is a fixed kerbside view, so the car
  // is put on the road it looks down and driven towards the lens — postcards are staged, and the
  // report says so.
  const play = scenario(report, 'postcard-street');
  await ev(() => window.__game.camPreset('street'));
  await ev((off) => window.__game.teleport(-off, -6, 0), B.laneOffset);
  await hold({ forward: true });
  await step(110);
  // The preset's own vantage is 30 m back down the avenue, which makes the car a speck. Same idea
  // — a low kerbside camera watching the traffic go by — moved to the kerb the car is about to pass.
  await ev(() => {
    const gd = window.__game.gd, c = gd.playerCar;
    const yaw = gd.carYaw[c];
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    window.__game.setFreeCamera(
      gd.carX[c] + fx * 11 + rx * 5.5, 1.7, gd.carZ[c] + fz * 11 + rz * 5.5,
      gd.carX[c] + fx * 1, 0.95, gd.carZ[c] + fz * 1);
  });
  await ev(() => window.__game.render());
  s = await st();
  play.note = `the player's car is teleported into the lane the "street" preset watches (x=${-B.laneOffset}, z=-6) and driven down it; the camera is the same low kerbside vantage as the preset, moved to the kerb the car is passing`;
  check(play, 'the player is at the wheel', s.playerMode === PLAYER_MODE.IN_CAR, `playerMode=${modeName(s.playerMode)}, car ${s.playerCar} (${secondName})`);
  check(play, 'moving, with the HUD up', s.speed > 3, `speed=${s.speed} m/s (${Math.round(s.speed * 3.6)} km/h)`);
  const shown = await ev(checkHud, false);
  check(play, 'the HUD is in the frame', shown.problems.length === 0, shown.problems.join('; ') || shown.found.join(', '));
  await shot(play, 'postcard-street');
  play.state = s;

  // ------------------------------------------------------------ 10. perf
  // The only scenario that runs on real time. SwiftShader is a software rasteriser, so the fps here
  // is not a claim about a real GPU — it is reported, not asserted. What IS asserted is the scene's
  // draw-call budget and that no single frame hung.
  const perf = scenario(report, 'perf');
  await ev(() => window.__game.clearFreeCamera());
  await ev(() => {
    window.__perf = { max: 0, n: 0, last: performance.now() };
    const f = () => {
      const t = performance.now(), p = window.__perf;
      const d = t - p.last; p.last = t;
      if (p.n++ > 0 && d > p.max) p.max = d;
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const beforeTick = (await st()).tick;
  await ev(() => window.__game.setAutoTick(true));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 3000));
  const wallS = (Date.now() - t0) / 1000;
  const live = await st();
  const frames = await ev(() => ({ max: Math.round(window.__perf.max), n: window.__perf.n }));
  await ev(() => window.__game.setAutoTick(false));
  await step(1);
  s = await st();
  perf.fps = live.fps;
  perf.frames = frames.n;
  perf.maxFrameMs = frames.max;
  perf.autoTickSeconds = Math.round(wallS * 100) / 100;
  check(perf, 'draw calls are inside the budget', s.drawCalls > 0 && s.drawCalls < 400, `drawCalls=${s.drawCalls} (< 400)`);
  check(perf, 'no frame hung', frames.max < 2000, `slowest of ${frames.n} frames was ${frames.max} ms (< 2000)`);
  // Only the two assertions above decide whether `perf` passes. The rest is recorded for the
  // reader: on a software rasteriser neither the frame rate nor the number of ticks a wall-clock
  // second buys says anything about the machine a player would use.
  perf.checks.push({
    name: 'the loop ran itself (information only)', ok: true,
    detail: `${frames.n} frames and ${live.tick - beforeTick} ticks in ${perf.autoTickSeconds}s of autoTick (tick ${beforeTick} -> ${live.tick})`,
  });
  perf.checks.push({
    name: 'fps (information only — SwiftShader)', ok: true,
    detail: `${live.fps.toFixed(1)} fps over ${frames.n} frames of software rendering`,
  });
  await shot(perf, 'perf');
  perf.state = s;
}

// ---------------------------------------------------------------- summary table
function printSummary(report) {
  const rows = report.scenarios.map((sc) => {
    const passed = sc.checks.filter((c) => c.ok).length;
    return [sc.ok ? 'ok  ' : 'FAIL', sc.name, `${passed}/${sc.checks.length}`, sc.shot || '-', sc.fallback ? 'fallback' : ''];
  });
  const w = [4, 0, 0, 0].slice();
  for (const r of rows) for (let i = 1; i < 4; i++) w[i] = Math.max(w[i] || 0, r[i].length);
  console.log('');
  console.log('  ' + ['', 'scenario'.padEnd(w[1]), 'checks'.padEnd(w[2]), 'screenshot'.padEnd(w[3])].join('  '));
  console.log('  ' + '-'.repeat(w[1] + w[2] + w[3] + 12));
  for (const r of rows) console.log('  ' + [r[0], r[1].padEnd(w[1]), r[2].padEnd(w[2]), r[3].padEnd(w[3]), r[4]].join('  '));
  for (const sc of report.scenarios) {
    if (sc.fallback) console.log(`  ! ${sc.name}: fallback — ${sc.fallback}`);
    for (const c of sc.checks) if (!c.ok) console.log(`  x ${sc.name} / ${c.name}: ${c.detail}`);
  }
  if (report.aborted) console.log(`  x aborted while ${report.aborted.stage}: ${report.aborted.message}`);
  for (const e of report.consoleErrors) console.log('  x console: ' + e);
  for (const wn of report.consoleWarnings) console.log('  ~ console: ' + wn);
  const okCount = report.scenarios.filter((s) => s.ok).length;
  const checks = report.scenarios.reduce((n, s) => n + s.checks.length, 0);
  console.log('');
  console.log(`capture: ${report.ok ? 'PASS' : 'FAIL'} — ${okCount}/${report.scenarios.length} scenarios, ${checks} checks, ` +
    `${report.consoleErrors.length} console errors, ${(report.wallMs / 1000).toFixed(1)}s wall`);
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const report = {
    ok: false,
    seed: args.seed,
    viewport: { w: args.w, h: args.h },
    three: 'unknown',
    puppeteer: require('puppeteer/package.json').version,
    node: process.version,
    startedAt: new Date(started).toISOString(),
    wallMs: 0,
    consoleErrors: [],
    consoleWarnings: [],
    scenarios: [],
  };

  // Everything the run needs — the directory, the server, the browser, the page and the scenarios
  // — is inside one try. A harness that dies before it writes its report tells a reviewer nothing,
  // so every failure lands in report.aborted and the report is written anyway, with whatever
  // scenarios did finish. `stage` names where it fell over when no scenario had started yet.
  let server = null, browser = null, fatal = null, stage = 'startup';
  try {
    fs.mkdirSync(path.resolve(root, args.out), { recursive: true });
    stage = 'starting the server';
    const started2 = await startServer();
    server = started2.server;
    const port = started2.port;
    stage = 'launching Chrome';
    browser = await launchBrowser();
    stage = 'opening the page';
    const url = gameUrl(port, '', args.seed);
    report.url = url.replace(`:${port}`, ':PORT');
    const { page } = await openGame(browser, url, {
      w: args.w, h: args.h, errors: report.consoleErrors, warnings: report.consoleWarnings,
    });
    stage = 'reading the three revision';
    // three writes its revision onto the canvas it renders into.
    report.three = await page.evaluate(() => document.querySelector('#game').dataset.engine || 'unknown');
    stage = 'running the scenarios';
    await runScenarios(page, args, report);
  } catch (err) {
    fatal = err && err.stack ? err.stack : String(err);
    const sc = report.scenarios.length ? report.scenarios[report.scenarios.length - 1] : null;
    if (sc && !sc.state) check(sc, 'scenario ran to the end', false, fatal.split('\n')[0]);
    report.aborted = {
      stage: sc && !sc.state ? `scenario "${sc.name}"` : stage,
      message: err && err.message ? err.message : String(err),
      stack: fatal,
    };
  } finally {
    // Never let teardown lose the report: a browser that failed to launch has nothing to close,
    // and a close that throws is not worth the run's findings.
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    try { if (server) server.close(); } catch (e) { /* ignore */ }
  }

  report.wallMs = Date.now() - started;
  report.ok = !fatal && report.consoleErrors.length === 0
    && report.scenarios.length > 0 && report.scenarios.every((s) => s.ok);
  const out = path.resolve(root, args.out, 'report.json');
  let wrote = true;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  } catch (err) {
    wrote = false;
    console.error('capture: could not write the report — ' + (err && err.message ? err.message : String(err)));
  }

  printSummary(report);
  if (fatal) console.error(fatal);
  if (wrote) console.log(`capture: wrote ${path.relative(root, out)}`);
  if ((!report.ok || !wrote) && args.assert) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
