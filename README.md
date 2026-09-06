# Joyride

Steal. Drive. Wreck. Repeat.

Joyride is a browser open-world driving sandbox. You start on foot in a small sunlit city at golden
hour, walk to any car on the street and take it, drive it through traffic as fast as it will go,
crash it into whatever is in the way, and get out before it explodes — then walk to the next one.
There is no menu, no score to chase and no way to lose: the whole game is the loop. It runs offline
from a static server, with no build step, no textures and no assets — three.js and about 6700 lines of
JavaScript in `src/`.

**Controls** — `W A S D` / arrows drive (throttle, brake/reverse, steer) and walk (camera relative),
`Space` handbrake, `E` (or `Enter`) enter/exit the nearest car, `C` cycles the chase camera,
`M` mutes, drag to look around, wheel to zoom.

## Running it

```sh
npm install                 # three + puppeteer
npm start                   # static server on http://localhost:8000/
npm test                    # unit tests, then the capture harness with --assert
npm run unit                # just the unit tests (node:test, no browser)
npm run capture             # the harness without --assert: writes captures/ and prints the table
```

`npm start` serves the repo as-is; there is nothing to build. Everything is ES modules loaded
straight from `src/`, with three.js vendored in `vendor/` behind an import map.

## Screenshots: `tools/shot.mjs`

One-shot screenshots for eyeballing a change:

```sh
node tools/shot.mjs                                   # 120 ticks, captures/shot.png
node tools/shot.mjs --url "&cam=skyline&nohud=1" --out captures/skyline.png
node tools/shot.mjs --script "ticks 30; enterNearestCar; input forward; ticks 150" --out captures/drive.png
```

Flags: `--url "&k=v"` (extra query params, appended after the harness base so they win),
`--out PATH`, `--ticks N`, `--w`/`--h`, `--freecam "x,y,z,lx,ly,lz"`, `--script "..."`.

It starts the server on a free port, opens the page in headless Chrome with SwiftShader, drives the
game, screenshots, checks the HUD elements are in the page, prints `__game.state()` and exits 1 on
any console error or missing HUD element.

The `--script` mini-language is `;`-separated commands, run in order, then one render:

| command | what it does |
|---|---|
| `ticks N` | run N fixed ticks |
| `input a b c` | hold these keys, release the rest (`forward back left right handbrake`) |
| `press action` | fire a one-tick edge (`action`, `camToggle`, `mute`) |
| `enterNearestCar` | steal the closest drivable car |
| `exitCar` | get out |
| `teleport x z yaw` | move the player (and his car, if he is in one) |
| `cam preset` | apply a camera preset |
| `setHealth H` | set the player car's health |

## The capture harness: `tools/capture.mjs`

```sh
node tools/capture.mjs [--assert] [--out captures] [--seed 7] [--w 1280 --h 720]
```

One headless page plays the whole loop — walk, steal, drive, crash, burn, explode, get thrown out,
walk again, steal again — then looks at the traffic, takes five postcards and measures a few seconds
of real-time frames. Each scenario writes `captures/NN-name.png` and a record in
`captures/report.json`. `--assert` exits 1 if anything failed; without it the run still writes the
report and prints the summary table.

The scenarios: `arrival`, `steal`, `drive`, `crash`, `wreck` (burning → explosion → wreck),
`steal-again`, `traffic`, `postcard-skyline/plaza/park/waterfront/street`, `perf`.

Everything is driven through `window.__game` in fixed steps, never wall-clock waits, so two runs of
the same seed produce identical states — every check detail and every `state` snapshot in the report
matches. `perf` is the one scenario that deliberately runs on real time, and its `fps`, `frames` and
tick count move with the machine. The pixels are all but identical rather than identical: the page's
own `requestAnimationFrame` loop keeps rendering between steps, so visual easing that rides on real
frame time (HUD animations, mesh smoothing) lands a couple of hundred pixels out of 921,600
differently from run to run.

### What `captures/report.json` contains

```jsonc
{
  "ok": true,                     // every scenario passed and the page logged no errors
  "seed": 7, "viewport": { "w": 1280, "h": 720 },
  "three": "three.js r185", "puppeteer": "25.10.0", "node": "v22...",
  "startedAt": "...", "wallMs": 42700,
  "consoleErrors": [], "consoleWarnings": [],   // full text of anything the page logged
  "scenarios": [{
    "name": "crash",
    "ok": true,
    "checks": [{ "name": "the crash cost health", "ok": true, "detail": "health=68.815 after 386 ticks of throttle" }],
    "state": { "tick": 0, "playerMode": 1, "playerCar": 0, "health": 68.8, "speed": 15.4, "drawCalls": 97, "...": "__game.state()" },
    "shot": "captures/04-crash.png",
    "shots": ["captures/04-crash.png"],
    "note": "why the frame is staged the way it is, when it is",
    "fallback": "the crutch a scenario had to use, when it needed one"
  }]
}
```

`fallback` is the honest field: if a scenario could not get there by driving or walking and had to
teleport, the check still passes but the report says so out loud — a run with no `fallback` key
anywhere did the whole loop by playing it. `note` is deliberate staging (a camera moved so the
frame shows the thing being asserted), not a crutch. `perf` adds `fps`, `frames`, `maxFrameMs` and
`autoTickSeconds`; its fps is reported, never asserted, because SwiftShader is a software
rasteriser and says nothing about a real GPU.

## The debug API: `window.__game`

Installed by `src/debug.js` for the tools above and for poking at the game in the console.

| member | what it does |
|---|---|
| `ready` | Promise, resolves after the first rendered frame |
| `gd`, `b` | the live GameData and Balance objects |
| `state()` | plain summary: tick, time, fps, playerMode, playerCar, position, carCount, wrecked, traffic, stolen, statWrecked, nearestCar, health, speed, drawCalls |
| `setAutoTick(on)` | let the rAF loop tick the world (off in `headless=1`) |
| `step(n)` | run n fixed ticks, then exactly one Board update + render |
| `render()` | re-render without ticking |
| `setInput({...})` | set held keys / edges (`forward back left right handbrake action camToggle mute`, `orbitDX orbitDY zoom`) |
| `press(name)` | fire a one-tick edge |
| `teleport(x, z, yaw)` | move the player, and his car with him |
| `enterNearestCar()` | steal the closest live car at any range, returns its index |
| `exitCar()` | get out |
| `spawnCar(type, x, z, yaw)` | spawn a parked car, returns its index |
| `findCar(pred)` | first car index with `pred(i, gd)` true, else -1 |
| `setHealth(car, h)` | set a car's health |
| `setFreeCamera(x,y,z, lx,ly,lz)` / `clearFreeCamera()` | park the camera / give it back to the game |
| `camPreset(name)` | `skyline street park waterfront plaza lineup closeup` |
| `hideHud(on)`, `start()` | hide the HUD for postcards; drop the title card |

### URL params

Last occurrence wins, so a param appended to the harness base overrides it.

| param | effect |
|---|---|
| `seed=N` | world seed (default 7) |
| `autostart=1` | skip the title card |
| `headless=1` | pixel ratio 1, `preserveDrawingBuffer`, and the world does not tick until `setAutoTick(true)` or `step()` |
| `nohud=1` | build the HUD but keep it hidden |
| `cam=NAME` | apply a camera preset at startup |
| `lineup=1` | spawn one of every car type in a row (for the car-model shot) |

## Project layout

Data-oriented: the data is TypedArrays in one object, the logic is pure functions over it, and the
renderer only reads. Nothing allocates per tick or per frame.

```
src/balance.js       every tuning constant, colour, car-type table + validate()
src/gameData.js      allocateGameData(gd, b, seed): every array, count and event buffer
src/rng.js           mulberry32 — the only randomness, seeded, never Math.random
src/logic/*.js       pure transforms over (gd, b): city, spawn, vehicle, traffic, collision,
                     props, damage, player, camera, particles, and tick.js which orders them
src/board/*.js       three.js and the DOM: renderer, city/car/character/prop/particle meshes,
                     HUD, input, audio — reads gd, never writes gameplay state
src/main.js          owns gd + balance, runs the fixed 60 Hz tick, drives the Board, installs debug
src/debug.js         window.__game
tools/serve.js       zero-dependency static server
tools/shot.mjs       one-shot screenshots + the shared puppeteer plumbing
tools/capture.mjs    the scenario harness
test/*.test.js       node:test unit tests for the Logic modules (no browser)
captures/            harness output — screenshots and report.json, not tracked in git
```

Logic modules import only `balance.js` and each other: never three.js, never the DOM, never
`Math.random`. That is what makes them testable in plain node, and what makes a run with a given
seed reproducible frame for frame.
