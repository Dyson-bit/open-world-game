// Renderer: WebGLRenderer, scene, golden-hour sun + shadows, hemisphere fill, gradient sky dome,
// fog, drifting clouds, a ring of hills and the bay to the south.
// Board module: three.js and the DOM live here. Everything the frame path needs is created once in
// createRenderer(); renderFrame() allocates nothing.
import {
  WebGLRenderer, Scene, PerspectiveCamera, Color, Fog, Object3D, Group, Mesh, Vector3,
  DirectionalLight, HemisphereLight,
  PlaneGeometry, SphereGeometry, IcosahedronGeometry,
  MeshLambertMaterial, ShaderMaterial, BackSide,
  SRGBColorSpace, NoToneMapping, PCFShadowMap,
} from 'three';
import { PLAYER_MODE } from '../balance.js';
import { mulberry32 } from '../rng.js';

// Direction from the world toward the sun (balance: elevation 24 deg, azimuth 235 deg).
const SUN_DIR_X = -0.75, SUN_DIR_Y = 0.41, SUN_DIR_Z = 0.52;
const SUN_LEN = Math.hypot(SUN_DIR_X, SUN_DIR_Y, SUN_DIR_Z);
const SUN_NX = SUN_DIR_X / SUN_LEN, SUN_NY = SUN_DIR_Y / SUN_LEN, SUN_NZ = SUN_DIR_Z / SUN_LEN;
const SUN_DIST = 260;

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunDir;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  // The horizon band has to stay narrow: a camera looking at the skyline only reaches dir.y ~= 0.35
  // at the top of the frame, so an exponent curve leaves the whole sky washed out peach. smoothstep
  // keeps the golden band in the bottom 10 degrees and is fully at the zenith colour by 25 deg.
  // The blend runs in an approximate gamma space (sqrt / square) — mixing a bright warm horizon
  // with a saturated blue in linear space desaturates everything in between.
  float t = smoothstep(0.02, 0.42, dir.y);
  vec3 col = mix(sqrt(horizon), sqrt(zenith), t);
  col *= col;
  col += vec3(1.0, 0.75, 0.45) * pow(max(dot(dir, sunDir), 0.0), 24.0) * 0.55;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export function createRenderer(canvas, gd, b, opts) {
  const headless = !!(opts && opts.headless);
  const w = window.innerWidth, h = window.innerHeight;

  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: headless });
  renderer.setPixelRatio(headless ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated in r185 (it warns and silently falls back to this anyway).
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.background = new Color(b.colors.skyHorizon);
  scene.fog = new Fog(b.colors.fog, b.sun.fogNear, b.sun.fogFar);

  const camera = new PerspectiveCamera(gd.camFov, w / h, 0.2, 2400);
  camera.position.set(gd.camX, gd.camY, gd.camZ);
  camera.lookAt(gd.camLookX, gd.camLookY, gd.camLookZ);

  // ---- sun ----------------------------------------------------------------
  const sun = new DirectionalLight(b.colors.sun, b.sun.intensity);
  sun.castShadow = true;
  const mapSize = headless ? b.sun.shadowMapHeadless : b.sun.shadowMap;
  sun.shadow.mapSize.set(mapSize, mapSize);
  const half = b.sun.shadowHalf;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 600;
  sun.shadow.camera.updateProjectionMatrix();
  // One shadow texel is 0.054 m at 4096 / 0.107 m headless, so a normal bias of a couple of texels
  // is enough to kill acne; the 0.4 this started at was wide enough to eat the self-shading of a
  // tree canopy and to detach small props from their own shadows.
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.15;
  sun.position.set(SUN_NX * SUN_DIST, SUN_NY * SUN_DIST, SUN_NZ * SUN_DIST);
  const sunTarget = new Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(sun);

  const hemi = new HemisphereLight(b.colors.hemiSky, b.colors.hemiGround, b.sun.hemiIntensity);
  scene.add(hemi);

  // ---- sky dome -----------------------------------------------------------
  const skyMat = new ShaderMaterial({
    uniforms: {
      zenith: { value: new Color(b.colors.skyZenith) },
      horizon: { value: new Color(b.colors.skyHorizon) },
      sunDir: { value: new Vector3(SUN_NX, SUN_NY, SUN_NZ) },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(900, 24, 12), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  // ---- ground -------------------------------------------------------------
  // Spec size, but pushed north so its south edge lands exactly on the waterline: the grass sits at
  // y = -0.05 and the bay at y = -0.4, so a plane centred on the origin would roof over the water.
  const ground = new Mesh(new PlaneGeometry(1600, 1600), new MeshLambertMaterial({ color: b.colors.grass }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.05, b.waterZ - 800);
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- hills (pure decoration, never gameplay) ----------------------------
  const rnd = mulberry32(99);
  const hillGeo = new IcosahedronGeometry(1, 1);
  const hillMatNear = new MeshLambertMaterial({ color: b.colors.hills, flatShading: true });
  const hillMatFar = new MeshLambertMaterial({ color: b.colors.hillsFar, flatShading: true });
  const hills = new Group();
  const HILLS = 28;
  for (let i = 0; i < HILLS; i++) {
    // theta = 0 is south (+Z); the arc |theta| < 40 deg is the bay, so start the fan at 40 deg
    const frac = (i + 0.1 + rnd() * 0.8) / HILLS;
    const theta = (40 + frac * 280) * Math.PI / 180;
    const radius = 420 + rnd() * 200;
    const m = new Mesh(hillGeo, (i & 1) ? hillMatFar : hillMatNear);
    m.position.set(Math.sin(theta) * radius, -8, Math.cos(theta) * radius);
    m.scale.set(60 + rnd() * 80, 18 + rnd() * 27, 60 + rnd() * 80);
    m.rotation.y = rnd() * Math.PI * 2;
    hills.add(m);
  }
  scene.add(hills);

  // ---- water --------------------------------------------------------------
  const water = new Mesh(new PlaneGeometry(1600, 700), new MeshLambertMaterial({ color: b.colors.water }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -0.4, b.waterZ + 350);
  // T12: the pier stands on the bay and cast its shadow into nothing, so it looked pasted on.
  water.receiveShadow = true;
  scene.add(water);

  const shore = new Mesh(new PlaneGeometry(1600, 6), new MeshLambertMaterial({ color: b.colors.waterDeep }));
  shore.rotation.x = -Math.PI / 2;
  // above the water's wave crest (-0.4 + 0.08) or the shoreline band vanishes for half of every cycle
  shore.position.set(0, -0.28, b.waterZ + 3);
  scene.add(shore);

  // ---- clouds -------------------------------------------------------------
  const cloudGeo = new SphereGeometry(1, 7, 5);
  // Clouds are lit almost entirely by their own emissive: a Lambert puff under a low sun is dark
  // on every face that is not pointing west, and with the hemisphere ground tint it reads as a
  // grey rock rather than as cloud. Emissive at 0.85 of the cloud colour floors the whole puff at
  // bright cream and leaves the sun and sky to add the last of the modelling on top.
  const cloudMat = new MeshLambertMaterial({
    color: b.colors.cloud, flatShading: true, fog: true,
    emissive: b.colors.cloud, emissiveIntensity: 0.85,
  });
  const clouds = new Group();
  for (let i = 0; i < 10; i++) {
    const puff = new Group();
    const n = 4 + Math.floor(rnd() * 4);   // 4..7
    for (let j = 0; j < n; j++) {
      const m = new Mesh(cloudGeo, cloudMat);
      m.position.set((rnd() - 0.5) * 44, (rnd() - 0.5) * 8, (rnd() - 0.5) * 26);
      m.scale.set(10 + rnd() * 16, 5 + rnd() * 4, 8 + rnd() * 8);
      m.rotation.y = rnd() * Math.PI * 2;
      puff.add(m);
    }
    puff.position.set((rnd() - 0.5) * 1200, 120 + rnd() * 50, (rnd() - 0.5) * 1200);
    clouds.add(puff);
  }
  scene.add(clouds);

  const view = {
    renderer, scene, camera, sun, sunTarget, hemi, sky, clouds, water, headless,
    // extras later tasks lean on
    ground, shore, hills,
    shadowTexel: (2 * half) / mapSize,   // shadow focus is snapped to this, to stop the map swimming
    t: 0,                                // seconds of wall-clock frame time, for cloud drift / waves / shake
    tmp: { v1: new Vector3(), v2: new Vector3(), v3: new Vector3() },
  };

  const onResize = function () {
    const nw = window.innerWidth, nh = window.innerHeight;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
  };
  window.addEventListener('resize', onResize);
  view.onResize = onResize;

  return view;
}

// One rendered frame. Allocation-free: only writes into objects created above.
export function renderFrame(view, gd, b, dtFrame) {
  view.t += dtFrame;
  const t = view.t;
  const camera = view.camera;

  let cx = gd.camX, cy = gd.camY, cz = gd.camZ;
  let lx = gd.camLookX, ly = gd.camLookY, lz = gd.camLookZ;
  if (gd.camFree === 0 && gd.camShake > 0) {
    const s = gd.camShake;
    cx += s * 0.35 * Math.sin(t * 37);
    cy += s * 0.30 * Math.sin(t * 51 + 1);
    cz += s * 0.35 * Math.sin(t * 43 + 2);
    lx += s * 0.18 * Math.sin(t * 61 + 3);
    ly += s * 0.18 * Math.sin(t * 57 + 4);
  }
  camera.position.set(cx, cy, cz);
  camera.lookAt(lx, ly, lz);
  if (Math.abs(camera.fov - gd.camFov) > 0.01) {
    camera.fov = gd.camFov;
    camera.updateProjectionMatrix();
  }

  // the sky dome rides with the camera so it never clips
  view.sky.position.set(cx, cy, cz);

  // shadow focus follows whatever the player is: snapped to a shadow texel so shadows don't swim.
  // With the free camera (debug / cam presets / title card) the player may be a city away from what
  // is on screen, so the focus goes to what the camera is looking at instead.
  let fx, fz;
  if (gd.camFree === 1) {
    fx = lx; fz = lz;
  } else if (gd.playerMode === PLAYER_MODE.IN_CAR && gd.playerCar >= 0) {
    fx = gd.carX[gd.playerCar]; fz = gd.carZ[gd.playerCar];
  } else {
    fx = gd.playerX; fz = gd.playerZ;
  }
  const q = view.shadowTexel;
  fx = Math.round(fx / q) * q;
  fz = Math.round(fz / q) * q;
  view.sunTarget.position.set(fx, 0, fz);
  view.sun.position.set(fx + SUN_NX * SUN_DIST, SUN_NY * SUN_DIST, fz + SUN_NZ * SUN_DIST);

  // clouds drift east and wrap
  const puffs = view.clouds.children;
  for (let i = 0; i < puffs.length; i++) {
    const p = puffs[i];
    p.position.x += 1.2 * dtFrame;
    if (p.position.x > 700) p.position.x -= 1400;
  }

  view.water.position.y = -0.4 + 0.08 * Math.sin(t * 0.8);

  view.renderer.render(view.scene, view.camera);
}
