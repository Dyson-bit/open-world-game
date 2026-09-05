# Joyride — Technical Design Spec

Companion to `GDD.md` (what the game is). This document is how it is built.

## 1. Stack and constraints
- Browser, plain ES modules, no bundler. `index.html` + `<script type="module" src="src/main.js">`.
- three.js r185 vendored at `vendor/three.module.js` (+ `vendor/BufferGeometryUtils.js`),
  mapped via an importmap (`"three"` → `./vendor/three.module.js`).
- Must be served over HTTP (ES modules). `tools/serve.js` is a zero-dependency static server
  (`npm start`, port 8000, `PORT` env overrides).
- Data-Oriented Design throughout (see `~/.claude/skills/data-oriented-design/references/html-js.md`):
  Balance (config) / GameData (TypedArrays) / Logic (pure functions) / Board (three.js + DOM + input +
  audio) / Game (`src/main.js` loop). Logic never imports three or touches the DOM.
  **No allocation in the per-frame path.** Identity is an index. Array + count. Seeded RNG only.
- Headless capture harness with puppeteer (`tools/capture.mjs`) and node unit tests
  (`node --test test/`) for all logic modules.

## 2. Module layout
```
index.html
src/main.js              Game loop: owns balance + gd, fixed 60 Hz tick, drives Board, exposes debug API
src/balance.js           ALL tuning constants, palette, car type table, validate()
src/gameData.js          allocateGameData(gd, balance): every TypedArray, counts, flags
src/rng.js               mulberry32
src/logic/tick.js        tick(gd, b): orchestrates one fixed step in the order in §7
src/logic/city.js        generateCity(gd, b): roads, lane graph, lots, buildings, props, spawn points
src/logic/spawn.js       spawnCar(...), placeParkedCars, placeTraffic, recycleFarCars
src/logic/vehicle.js     car physics (integrate one car from its inputs)
src/logic/traffic.js     AI: lane following, car-ahead braking, intersection yield
src/logic/collision.js   car vs building AABB, car vs car, car vs prop, car vs bounds; writes impacts
src/logic/props.js       dynamic (knocked) prop simulation
src/logic/damage.js      health, burn timer, explosion, wreck, player fling
src/logic/player.js      on-foot movement, enter/exit, stun
src/logic/camera.js      camera target computation (pure data)
src/logic/particles.js   particle spawn (from events) + sim; skid mark ring buffer
src/board/renderer.js    WebGLRenderer, scene, sun+shadows, hemisphere, sky dome, fog, clouds, hills, water
src/board/cityMesh.js    static city geometry (merged + instanced) built once from gd
src/board/carMesh.js     per-car body geometry with vertex colours; wheels instanced; dents; wreck look; brake lights
src/board/charMesh.js    player character (boxes) + procedural walk / tumble
src/board/propsMesh.js   instanced props (static + dynamic share instances; matrices from gd)
src/board/particlesMesh.js  instanced particles + skid mark mesh
src/board/hud.js         DOM HUD + title card + prompts
src/board/input.js       keyboard/mouse → gd.input
src/board/audio.js       procedural WebAudio SFX from gd events
src/debug.js             window.__game API + URL params
tools/serve.js           static server
tools/capture.mjs        puppeteer scenarios → captures/*.png + captures/report.json
test/*.test.js           node:test unit tests for logic
```

## 3. World conventions
- three.js axes: **+X east, +Y up, +Z south**. Yaw is rotation about Y; a car with yaw θ has
  forward vector `(sin θ, 0, cos θ)`. (θ=0 faces +Z/south.) Right-hand vector of forward `(fx, fz)`
  is `(-fz, fx)`.
- Units: metres, seconds, m/s. Fixed logic step `b.dt = 1/60`.
- City: `b.blocksX = b.blocksZ = 8`, `b.cell = 54`, `b.roadW = 14`, `b.sidewalkW = 3`.
  Road centrelines at `x = -216 + i*54` for `i = 0..8` (same for z). Block interiors are 40 m
  squares; buildable lot area is 34 m after sidewalks. Lane centres are `±3.5` from road centre.
  Right-hand traffic.
- Soft boundary: `|x|,|z| > b.worldHalf (=256)` pushes the player/car back.
- South edge (`z > 216 + 7`): promenade then water (`z > 240`), a pier at x≈0. Other edges: grass
  then rolling hills at 300–500 m for silhouette; all of this is Board decoration except the
  water/promenade colliders which are just the boundary.

## 4. Balance and GameData are the contract
`src/balance.js` and `src/gameData.js` are written first and are the interface every task
codes against. Fields are named in those files; tasks may **add** fields (with a comment)
but never rename or repurpose. Car type table is parallel arrays in balance indexed by type id.

## 5. Systems

### 5.1 City generation (`logic/city.js`)
Seeded. Produces, into gd:
- **Lane graph**: nodes = 9×9 intersections (`nodeX/nodeZ`), lanes = directed segments between
  adjacent nodes, one per direction, offset to the right (`laneX0,Z0,X1,Z1,laneLen,laneFrom,laneTo`),
  `nodeOutStart/nodeOutCount` into `nodeOutLanes`. 2 × 2 × 9 × 8 = 288 lanes.
- **Blocks**: 64. Type: `0 buildings, 1 park, 2 plaza (centre 2×2 area holds one landmark tower
  + plaza), 3 lowrise`. District from Chebyshev ring around centre.
- **Buildings**: each block splits into 1–4 lots. Each building = a stack of 1–3 boxes (render
  boxes: `rbX,rbY,rbZ,rbW,rbH,rbD,rbColor`) with the bottom box also emitted as a collider AABB
  (`colMinX,colMinZ,colMaxX,colMaxZ`). Extra render boxes for: ground-floor colour band, roof
  tanks/AC units, awnings, antenna on towers. Window bands: per floor, one thin dark box slightly
  wider than the wall (`wbX..` arrays) for ~60% of buildings; others get vertical pilaster strips
  or nothing (low-rise).
- **Parks**: grass slab, 8–14 trees, benches, a fountain (collider circle) in the middle.
- **Props** (`propType,propX,propZ,propYaw`): trees along sidewalks every ~12 m (static colliders,
  r=0.5), lamp posts at corners and mid-block (knockable), hydrants, mailboxes, bins, benches,
  cones near some corners (knockable). Nothing is placed on the road surface except cones at
  1–2 seeded spots.
- **Parking spots**: along curbs, parallel, every 7 m where no prop is within 2.5 m
  (`parkX,parkZ,parkYaw`).
- **Collision grid**: uniform grid of `b.gridCells` (cell 27 m) → lists of collider indices
  (`gridStart/gridCount` into `gridItems`), separately for building AABBs and static props,
  filled once at generation. Wide objects register in every overlapped cell.

### 5.2 Vehicle physics (`logic/vehicle.js`)
Arcade 2-D model per car, integrated at 60 Hz (one substep; simple enough to be stable):
- Inputs per car: `carThrottle ∈[-1,1]`, `carSteerIn ∈[-1,1]`, `carHandbrake ∈{0,1}`.
- Steer angle eases toward `steerIn * steerMax(type)` with a rate that shrinks at speed
  (`steerMax * (1 - 0.6 * speed/maxSpeed)`).
- Forward speed `vF = v·fwd`, lateral `vL = v·right`. Engine force = throttle × accel(type),
  scaled down near max speed. Braking when throttle opposes motion. Rolling drag + quadratic drag.
- Lateral grip: `vL *= (1 - grip*dt)` with grip reduced to `driftGrip` when handbrake is on or
  `|vL| > slipThreshold`; `carSlip = |vL|` feeds skids and squeal.
- Yaw rate = `vF / wheelbase * tan(steer)`, blended with an inertia term when drifting.
- Wrecked cars: no engine, heavy drag, can still be pushed.
- Visual only: `carVisPitch` (from ΔvF), `carVisRoll` (from lateral accel), `carWheelSpin += vF*dt/r`.

### 5.3 Collision and impacts (`logic/collision.js`)
- Cars are 2-D OBBs (`len × wid` from type). Corners computed into gd scratch arrays.
- Car vs building AABB: SAT on 4 axes (2 world, 2 car). Minimum-translation push-out; velocity
  reflected along normal with restitution 0.25 and tangential damping; `impact = |vN|`.
- Car vs car: OBB–OBB SAT; separate by inverse mass; exchange momentum along normal (restitution
  0.3). Both get impacts.
- Car vs prop: prop circle vs OBB (closest point). Static props (trees, fountain): push-out like a
  wall. Knockable props: the prop is launched (`props.js`), the car loses a little speed, small impact.
- Car vs bounds: soft spring push inside `worldHalf`.
- Player on foot vs buildings/cars/props: circle (r=0.4) push-out; no damage.
- Impacts above `b.damageMinImpact` (3 m/s) are recorded as events: `impCar, impX, impZ, impLocalX,
  impLocalZ, impStrength` (count ≤ 64/tick) and damage dealt = `(impact - min) * damagePerMs * typeFragility`.
- Dent tracking: `carDent[car*4 + side]` where side is chosen from the local impact point
  (0 front, 1 rear, 2 left, 3 right), accumulates strength/20 clamped to 1. Board uses the event
  (not the accumulator) to deform vertices near the local point.

### 5.4 Traffic AI (`logic/traffic.js`)
- Each traffic car holds `carLane`, `carLaneT` (metres along). Target point = lane point at
  `t + lookahead(speed)`; steer via pure pursuit; throttle toward `cruiseSpeed(type)`, reduced when
  approaching the lane end (intersection) and when turning.
- On lane end: choose next lane from `nodeOut` of `laneTo`, never the reverse lane, weighted straight
  > turn. If the car has drifted > 6 m from the lane it re-acquires the nearest lane point.
- Car ahead: scan all live cars; if any lies in the box (ahead 2–14 m, lateral < 2.6 m) and is slower,
  match its speed / stop. Intersection yield: before entering an intersection square, if another car
  occupies the square and is not behind us, wait (max 4 s then go).
- If an AI car is hit hard (`impact > 6`) it becomes `STOPPED` for 5–10 s (driver "shaken") then resumes.
- Traffic manager: keep `b.trafficCount` (40) cars in state TRAFFIC. Cars > 260 m from the player
  are recycled to a random lane point 120–220 m away that is outside the camera frustum cone.
  Parked cars are never recycled while within 120 m. Wrecks are recycled when > 300 m away and
  total car count is at cap.

### 5.5 Damage, fire, explosion (`logic/damage.js`)
- `carHealth` 0..100. States: `PARKED 0, TRAFFIC 1, PLAYER 2, WRECK 3, BURNING 4, STOPPED 5`.
- health < 60 → light grey smoke (particles from bonnet); < 30 → black smoke + flames.
- health ≤ 0 → BURNING: `carBurnTimer = 3 s`, HUD warning if player inside. At 0: explosion event
  (`expX, expZ, expStrength`), car → WRECK (charred, extra dents), cars within 8 m take 40 damage and
  a radial impulse, props within 10 m get knocked, if the player is inside or within 6 m on foot →
  `playerMode = FLUNG` with velocity away from the blast, then `STUNNED` 1.5 s, then on foot.
- WRECK cars are dark, smoulder lightly for 20 s, remain as heavy obstacles.

### 5.6 Player (`logic/player.js`) and camera (`logic/camera.js`)
- On foot: capsule circle r=0.4, speed 6.5 m/s, move direction = input rotated by camera yaw; yaw eases
  toward move direction; `playerWalkPhase` advances with speed.
- Enter: `input.action` edge, nearest non-wreck car within 3.2 m of the player (measured to its OBB
  edge) → `playerMode = IN_CAR`, `playerCar = i`, car state → PLAYER (previous state remembered for
  stats), `stats.stolen++`. Exit: action edge while IN_CAR → place player at the left door
  (`right * -(wid/2+0.8)`), car state → PARKED (or BURNING/WRECK if it was), car keeps rolling.
- Camera (pure data → `camX,Y,Z, camLookX,Y,Z, camFov`): chase spring behind the target. Car:
  distance 9 + 0.06*speed, height 3.6, look-ahead 6 + 0.25*speed, FOV 60→78 with speed. Foot: distance
  6, height 2.6. Mouse drag adds an orbit yaw offset that decays when moving. Screen shake: `camShake`
  decays, added as noise in Board. Camera never goes inside buildings: raycast-free approach — clamp
  camera position out of any building AABB it lands in (push to nearest face, plus lift).

### 5.7 Particles and skids (`logic/particles.js`)
- Single pool `b.maxParticles = 4000`, parallel arrays, types: SMOKE, FIRE, SPARK, DEBRIS, DUST, SHOCK.
  Spawned by: impacts (sparks + dust + debris scaled by strength), damaged cars (smoke/fire every N
  ticks by health tier), explosions (fireball + shock ring + debris), drifting (dust at rear wheels),
  driving on grass (dust).
- Skid marks: ring buffer `b.maxSkids = 1024` segments `skidX0,Z0,X1,Z1,skidW` written when
  `carSlip > threshold` per rear wheel.

## 6. Board (three.js)
- Renderer: antialias, `outputColorSpace = SRGBColorSpace`, `toneMapping = NoToneMapping`,
  shadows `PCFSoftShadowMap`. Pixel ratio capped at 2 (1 in headless).
- Light: sun `DirectionalLight` colour `#ffdcae` intensity ~2.4 from elevation 24°, azimuth from the
  west-south-west; shadow camera ortho ±110 m following the player (snapped to shadow texel size to
  avoid swimming), map 4096 (2048 headless), bias tuned. `HemisphereLight` sky `#bcd6ff` ground
  `#d9a26c` ~1.1. Materials: `MeshLambertMaterial` (vertex colours / instanceColor). No textures anywhere.
- Sky: inverted sphere with gradient shader (zenith `#4f8fd9` → horizon `#ffd1a3`, sun glow toward the
  sun). Fog `#ffd6b0` from 220 to 720 m. Clouds: ~10 flat-shaded clusters of spheres drifting at y≈130.
  Hills: ring of low cones/ellipsoids outside the city in muted green. Water: flat plane `#3fa7d6`
  with a slow vertex-wave shader or just a second lighter plane strip; a pier of boxes.
- City: roads/sidewalks/curbs/markings/crosswalks merged into one vertex-coloured static mesh. Buildings
  → `InstancedMesh` of a unit box with per-instance colour; window bands → another instanced box;
  trees → two instanced meshes (trunk cylinder, canopy = icosahedron/cone by tree type); lamps, hydrants,
  benches, bins, mailboxes, cones → one instanced mesh per prop type. Dynamic props read their matrices
  from gd each frame (all props live in the same instance arrays; static ones simply never move).
- Cars: one `Mesh` per car slot (`b.maxCars`), geometry built by `buildCarGeometry(type, paintRGB)`
  from box/wedge primitives merged with vertex colours; body paint, dark glass, bumpers, headlights,
  taillights, grille, roof sign for taxi, bus windows. `originalPositions` kept for dents. Wheels:
  one `InstancedMesh` cylinder (`maxCars*4`), per-frame matrices from car pose + steer + spin.
  Dent on impact event: vertices within `1.2 + strength*0.05` m of the local impact point move toward
  the body centre by up to `0.35*min(1,strength/15)` with seeded noise; recompute normals. Wreck:
  vertex colours multiplied toward charcoal, glass to black, several random dents. Brake lights:
  taillight vertex colours swap between dark red and bright red when braking (only on change).
- Character: 6-box humanoid, walk cycle from `playerWalkPhase`, tumble when FLUNG, hidden while IN_CAR.
- HUD (DOM, updated only on change): speed + car name (top-left), damage bar, counters (top-right),
  centre prompt ("E — STEAL THE HAULER"), "GET OUT!" flashing warning, controls hint that fades after
  first drive, title card overlay with the game name and "click to start".
- Audio (WebAudio, started on first gesture): engine (two detuned saws through low-pass, pitch by
  speed/gear-ish), squeal (band-passed noise gated by `carSlip`), impact (noise burst + low sine
  thump scaled by strength), explosion, wind at speed, prop clatter. Mute with M.

## 7. Tick order (`logic/tick.js`)
1. clear per-tick event counts (impacts, explosions, spawn events)
2. `player.update` — reads `gd.input`; sets the player car's inputs or moves on foot; enter/exit
3. `traffic.update` — sets inputs for AI cars
4. `vehicle.integrate` — all live cars
5. `collision.resolve` — cars vs world, cars vs cars, cars vs props, player vs world; writes impacts
6. `props.update` — knocked props fly/settle
7. `damage.update` — applies impact damage, burn timers, explosions, fling
8. `particles.update` — spawn from events, integrate, skid marks
9. `spawn.manage` — recycle/top-up traffic
10. `camera.update`
11. stats / timers

Main loop: accumulate real time, run `tick` in fixed 1/60 s steps (max 4 per frame), then
`board.render(gd, b, alpha)`. Board reads events **after** tick and before the next tick clears them.

## 8. Debug API and harness
`window.__game` (from `src/debug.js`):
- `ready: Promise`, `gd`, `b`, `state()` → plain summary (player mode/pos/car, car counts, stats, fps)
- `setAutoTick(bool)`, `step(n)` runs n ticks then renders once, `render()`
- `setInput({forward, back, left, right, handbrake, action})` (persist until changed), `press('action')`
- `teleport(x, z, yaw)`, `enterNearestCar()`, `exitCar()`, `spawnCar(type, x, z, yaw)` → index,
  `setHealth(car, h)`, `findCar(pred)`
- `setFreeCamera(x,y,z, lx,ly,lz)` / `clearFreeCamera()`, `hideHud(bool)`
URL params: `seed`, `autostart=1`, `headless=1` (pixel ratio 1, shadow 2048, preserveDrawingBuffer,
autoTick off until `setAutoTick(true)`), `nohud=1`, `cam=<preset>`.

`tools/capture.mjs`: starts the server, launches headless Chrome (SwiftShader flags), runs scenarios
(arrival wide shot, steal, drive at speed, crash, wreck/explosion, second steal, postcards: skyline,
park, waterfront, plaza) and writes `captures/NN-name.png` + `captures/report.json` with assertions
(no console errors, health drops after crash, car wrecked, second car differs, frame time budget).
`npm test` = `node --test test/` then `node tools/capture.mjs --assert`.

## 9. Quality bar
The build is done when a hostile reviewer looking only at screenshots and the report would call it a
finished small game: a coherent, attractive city at golden hour with long shadows; cars that read at
a glance; crumple, smoke, fire and explosion clearly visible; HUD that looks designed; no z-fighting,
no floating props, no cars clipping through buildings, no console errors, 60 fps on a laptop GPU.
