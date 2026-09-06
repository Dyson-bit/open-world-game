#!/usr/bin/env node
// One-shot screenshot tool — and the shared browser plumbing tools/capture.mjs runs on.
//
//   node tools/shot.mjs [--url "?..."] [--out captures/shot.png] [--ticks 120] [--w 1280 --h 720]
//                       [--script "cmd;cmd;..."] [--freecam "x,y,z,lx,ly,lz"]
//
// Everything below the "shared helpers" banner is exported: startServer / launchBrowser /
// openGame / checkHud / gameUrl / parseScript / runCommand. capture.mjs imports them, so the two
// tools open the page the same way (same flags, same collectors) and only one of them owns that
// knowledge. main() runs only when this file is the entry point, never on import.
//
// Starts tools/serve.js on a free port, opens the page headless with SwiftShader, waits for
// __game.ready, drives the game through the debug API, screenshots, asserts the HUD is in the page,
// prints __game.state() as JSON and exits 1 if the page logged any error or the HUD is wrong.
//
// The HUD assertion stands in for the DOM unit test the plan skips: after the screenshot the page is
// asked for the elements the Board is supposed to have built. With nohud=1 only #hud is required,
// and it must actually be display:none.
//
// --script commands (unknown commands throw):
//   ticks N                 run N fixed ticks, then one frame
//   input a b c             set the held keys (any of: forward back left right handbrake); others clear
//   press action            fire a one-tick edge (action | camToggle | mute)
//   enterNearestCar         steal the closest drivable car
//   exitCar                 get out
//   teleport x z yaw        move the player (or his car)
//   cam preset              apply a named camera preset
//   setHealth H             set the player car's health
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from './serve.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HELD_KEYS = ['forward', 'back', 'left', 'right', 'handbrake'];
export const CHROME_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'];

function parseArgs(argv) {
  const a = { url: '', out: 'captures/shot.png', ticks: 120, w: 1280, h: 720, script: '', freecam: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--url': a.url = need(k, v); i++; break;
      case '--out': a.out = need(k, v); i++; break;
      case '--script': a.script = need(k, v); i++; break;
      case '--freecam': a.freecam = need(k, v); i++; break;
      case '--ticks': a.ticks = int(k, need(k, v)); i++; break;
      case '--w': a.w = int(k, need(k, v)); i++; break;
      case '--h': a.h = int(k, need(k, v)); i++; break;
      default: throw new Error(`shot: unknown argument "${k}"`);
    }
  }
  return a;
}

function need(flag, v) {
  if (v === undefined) throw new Error(`shot: ${flag} needs a value`);
  return v;
}

function int(flag, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`shot: ${flag} needs a number, got "${v}"`);
  return Math.round(n);
}

function num(v, where) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`shot: "${where}" needs numbers, got "${v}"`);
  return n;
}

function arity(args, n, where) {
  if (args.length !== n) throw new Error(`shot: "${where}" takes ${n} argument(s), got ${args.length}`);
}

export function parseScript(src) {
  const out = [];
  for (const raw of src.split(';')) {
    const s = raw.trim();
    if (!s) continue;
    const parts = s.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    switch (cmd) {
      case 'ticks':
        arity(args, 1, s);
        out.push({ cmd, n: Math.round(num(args[0], s)) });
        break;
      case 'input':
        for (const k of args) {
          if (!HELD_KEYS.includes(k)) throw new Error(`shot: "${s}" — unknown held key "${k}" (${HELD_KEYS.join(', ')})`);
        }
        out.push({ cmd, keys: args.slice() });
        break;
      case 'press':
        arity(args, 1, s);
        out.push({ cmd, name: args[0] });
        break;
      case 'enterNearestCar':
      case 'exitCar':
        arity(args, 0, s);
        out.push({ cmd });
        break;
      case 'teleport':
        arity(args, 3, s);
        out.push({ cmd, x: num(args[0], s), z: num(args[1], s), yaw: num(args[2], s) });
        break;
      case 'cam':
        arity(args, 1, s);
        out.push({ cmd, preset: args[0] });
        break;
      case 'setHealth':
        arity(args, 1, s);
        out.push({ cmd, h: num(args[0], s) });
        break;
      default:
        throw new Error(`shot: unknown script command "${cmd}" in "${s}"`);
    }
  }
  return out;
}

export async function runCommand(page, c) {
  switch (c.cmd) {
    case 'ticks':
      await page.evaluate((n) => window.__game.step(n), c.n);
      break;
    case 'input':
      await page.evaluate((keys, all) => {
        const obj = {};
        for (const k of all) obj[k] = keys.indexOf(k) >= 0;
        window.__game.setInput(obj);
      }, c.keys, HELD_KEYS);
      break;
    case 'press':
      await page.evaluate((n) => window.__game.press(n), c.name);
      break;
    case 'enterNearestCar':
      await page.evaluate(() => window.__game.enterNearestCar());
      break;
    case 'exitCar':
      await page.evaluate(() => window.__game.exitCar());
      break;
    case 'teleport':
      await page.evaluate((x, z, yaw) => window.__game.teleport(x, z, yaw), c.x, c.z, c.yaw);
      break;
    case 'cam':
      await page.evaluate((n) => {
        if (typeof window.__game.camPreset !== 'function') throw new Error('camPreset is not available');
        window.__game.camPreset(n);
      }, c.preset);
      break;
    case 'setHealth':
      await page.evaluate((h) => {
        const g = window.__game;
        if (g.gd.playerCar < 0) throw new Error('setHealth: the player is not in a car');
        g.setHealth(g.gd.playerCar, h);
      }, c.h);
      break;
    default:
      throw new Error(`shot: unhandled command "${c.cmd}"`);
  }
}

// Runs in the page. `nohud` → only #hud is required, and it must be display:none.
export function checkHud(nohud) {
  const wanted = {
    hud: '#hud',
    panel: '#hud .hud-tl',
    carName: '#hud .hud-carname',
    speed: '#hud .hud-speed',
    damageBar: '#hud .hud-dmg .hud-dmg-fill',
    counters: '#hud .hud-tr .hud-pill-v',
    prompt: '#hud .hud-slot .hud-prompt',
    warning: '#hud .hud-warn',
    hint: '#hud .hud-hint',
    flash: '#hud .hud-flash',
    title: '#hud .hud-title',
    titleName: '#hud .hud-title-name',
  };
  const found = [];
  const problems = [];
  const root = document.querySelector('#hud');
  if (!root) {
    problems.push('#hud is not in the page');
    return { found, problems };
  }
  found.push('hud');
  if (nohud) {
    if (getComputedStyle(root).display !== 'none') problems.push('nohud=1 but #hud is still displayed');
    return { found, problems };
  }
  for (const key in wanted) {
    if (key === 'hud') continue;
    if (document.querySelector(wanted[key])) found.push(key);
    else problems.push(`missing ${key} ("${wanted[key]}")`);
  }
  return { found, problems };
}

// Same last-occurrence-wins rule main.js uses, so an override in --url is what gets read here too.
export function lastParam(fullUrl, name) {
  const all = new URL(fullUrl).searchParams.getAll(name);
  return all.length ? all[all.length - 1] : null;
}

// ---------------------------------------------------------------- shared helpers
// Used by main() below and imported by tools/capture.mjs. Nothing here writes to stdout.

// A server on a free loopback port. Returns { server, port }; close it with server.close().
export async function startServer() {
  const server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return { server, port: server.address().port };
}

export function launchBrowser() {
  return puppeteer.launch({ headless: true, args: CHROME_ARGS });
}

// The page URL: the harness base (headless + autostart + seed) plus whatever `extra` asks for.
// main.js reads the LAST occurrence of a param, so anything in `extra` overrides the base.
export function gameUrl(port, extra, seed) {
  let e = (extra || '').trim();
  while (e.startsWith('?') || e.startsWith('&')) e = e.slice(1);
  const s = seed === undefined ? 7 : seed;
  return `http://127.0.0.1:${port}/?headless=1&autostart=1&seed=${s}${e ? '&' + e : ''}`;
}

// Opens the game and waits for the first rendered frame. `errors` collects page errors, console
// errors and failed requests; `warnings` collects console.warn. Both arrays keep filling as the
// caller drives the page, so read them at the end of the run.
export async function openGame(browser, url, opts) {
  const o = opts || {};
  const errors = o.errors || [];
  const warnings = o.warnings || [];
  const page = await browser.newPage();
  await page.setViewport({ width: o.w || 1280, height: o.h || 720, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
    else if (m.type() === 'warning') warnings.push('console.warn: ' + m.text());
  });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!(window.__game && window.__game.ready), { timeout: 30000 });
  await page.evaluate(() => window.__game.ready);
  return { page, errors, warnings };
}

// Screenshot to a path relative to the repo root; makes the directory. Returns the absolute path.
export async function screenshot(page, outPath) {
  const out = path.isAbsolute(outPath) ? outPath : path.resolve(root, outPath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  return out;
}

// ---------------------------------------------------------------- the tool
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const script = args.script ? parseScript(args.script) : null;

  const { server, port } = await startServer();
  const browser = await launchBrowser();

  const errors = [];
  let state = null;
  try {
    const url = gameUrl(port, args.url, 7);
    const { page } = await openGame(browser, url, { w: args.w, h: args.h, errors });

    if (args.freecam) {
      const v = args.freecam.split(',').map(Number);
      if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) {
        throw new Error(`shot: --freecam needs "x,y,z,lx,ly,lz", got "${args.freecam}"`);
      }
      await page.evaluate((c) => window.__game.setFreeCamera(c[0], c[1], c[2], c[3], c[4], c[5]), v);
    }

    if (script) {
      for (const c of script) await runCommand(page, c);
      await page.evaluate(() => window.__game.render());
    } else {
      await page.evaluate((n) => window.__game.step(n), args.ticks);
    }

    const out = await screenshot(page, args.out);

    const noHud = lastParam(url, 'nohud') === '1';
    const hudCheck = await page.evaluate(checkHud, noHud);
    if (hudCheck.found.length) console.log(`shot: hud ok — ${hudCheck.found.join(', ')}`);
    for (const problem of hudCheck.problems) errors.push('hud: ' + problem);

    state = await page.evaluate(() => window.__game.state());
    console.log(`shot: wrote ${path.relative(root, out)} (${args.w}x${args.h})`);
  } finally {
    await browser.close();
    server.close();
    for (const e of errors) console.error(e);
  }

  if (state) console.log(JSON.stringify(state));
  if (errors.length) {
    console.error(`shot: ${errors.length} problem(s)`);
    process.exitCode = 1;
  }
}

// Only when this file is the entry point: importing it (capture.mjs does) must not take a shot.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
