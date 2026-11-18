// DOM HUD: speed, car name, damage bar, counters, prompts, warnings and the title card.
// Board module: the DOM lives here.
//
// Every element is created once, in createHud. updateHud runs on the frame path, so it never calls
// createElement and never builds a string unless the value behind it actually changed — the `last`
// record holds what is currently on screen and is the only thing compared per frame.
import { CAR_STATE, PLAYER_MODE } from '../balance.js';

// which of the three centre-bottom lines is showing
const P_NONE = 0, P_STEAL = 1, P_EXIT = 2, P_WARN = 3, P_OUCH = 4;

const HINT = [
  ['WASD', 'DRIVE'],
  ['SPACE', 'HANDBRAKE'],
  ['E', 'ENTER/EXIT'],
  ['C', 'CAMERA'],
  ['M', 'SOUND'],
  ['DRAG', 'TO LOOK'],
];

const EXIT_SPEED = 2;      // m/s below which "E — GET OUT" appears
const HINT_FADE_DELAY = 12; // seconds after the first steal
const OUCH_TIME = 1;        // seconds "OUCH" stays up after being flung
const FLASH_DECAY = 2.2;    // impact flash opacity per second

export function createHud(root, gd, b, opts) {
  const hidden = !!(opts && opts.hidden);

  const hud = {
    root: root,
    flash: 0,        // current impact-flash opacity
    ouch: 0,         // seconds of "OUCH" left
    hintAt: -1,      // gd.time at which the controls hint fades (-1 = not armed)
    titleOn: false,
    // the values currently displayed; nothing is written to the DOM unless one of these moves
    last: {
      name: '', onFoot: -1, speed: -1, dmgPct: -1, dmgClass: '', dmgOff: -1,
      stolen: -1, wrecked: -1, prompt: -1, promptName: '', flash: -1, hintFaded: -1, mode: -1,
    },
  };

  if (!root) return hud;   // nothing to draw into (unit tests, headless smoke) — still a valid hud
  root.textContent = '';
  root.classList.toggle('hud-hidden', hidden);

  hud.flashEl = div('hud-flash', root);

  const game = div('hud-game', root);

  // ---- top-left: car name, big speed, damage bar
  const tl = div('hud-tl hud-panel', game);
  hud.nameEl = div('hud-carname hud-onfoot', tl);
  hud.nameEl.textContent = 'ON FOOT';
  const speedRow = div('hud-speed-row', tl);
  hud.speedRowEl = speedRow;
  hud.speedEl = span('hud-speed', speedRow);
  hud.speedEl.textContent = '0';
  span('hud-kmh', speedRow).textContent = 'KM/H';
  speedRow.hidden = true;                  // T12: the game opens on foot, and a man has no speedo
  hud.dmgEl = div('hud-dmg hud-off', tl);
  hud.dmgFillEl = span('hud-dmg-fill', hud.dmgEl);

// ---- top-right: counters and money
const tr = div('hud-tr', game);

hud.moneyEl = pill(tr, 'MONEY');
hud.moneyEl.textContent = '$0';

hud.stolenEl = pill(tr, 'STOLEN');
hud.wreckedEl = pill(tr, 'WRECKED');

  // ---- centre-bottom: warning / ouch / prompt (exactly one visible)
  const slot = div('hud-slot', game);
  hud.warnEl = div('hud-warn hud-panel', slot);
  hud.warnEl.textContent = 'GET OUT!';
  hud.warnEl.hidden = true;
  hud.ouchEl = div('hud-ouch hud-panel', slot);
  hud.ouchEl.textContent = 'OUCH';
  hud.ouchEl.hidden = true;
  hud.promptEl = div('hud-prompt hud-panel', slot);
  hud.promptEl.hidden = true;
  span('hud-key', hud.promptEl).textContent = 'E';
  span('hud-dash', hud.promptEl).textContent = '—';
  hud.promptTextEl = span('hud-prompt-text', hud.promptEl);

  // ---- bottom-left: controls hint
  hud.hintEl = div('hud-hint hud-panel', game);
  fillHint(hud.hintEl);

  // ---- title card (its own layer; the game HUD is hidden while it is up)
  hud.titleEl = div('hud-title', root);
  const block = div('hud-title-block', hud.titleEl);
 div('hud-title-name', block).textContent = 'OPEN WORLD';
div('hud-title-rule', block);
div('hud-title-sub', block).textContent = 'EXPLORE · DRIVE · DISCOVER';
  const foot = div('hud-title-foot', hud.titleEl);
  const start = div('hud-title-start hud-panel', foot);
  start.textContent = 'PULSA CUALQUIER TECLA PARA JUGAR';
  fillHint(div('hud-title-controls hud-panel', foot));
  hud.titleEl.hidden = true;

  return hud;
}

export function updateHud(hud, gd, b, dtFrame) {
  if (!hud || !hud.root) return;
  const last = hud.last;

  const inCar = gd.playerMode === PLAYER_MODE.IN_CAR && gd.playerCar >= 0;
  const pc = gd.playerCar;

  // ---- car name + speed
  const onFoot = inCar ? 0 : 1;
  const name = inCar ? b.carName[gd.carType[pc]] : 'ON FOOT';
  if (name !== last.name) { hud.nameEl.textContent = name; last.name = name; }
  if (onFoot !== last.onFoot) {
    hud.nameEl.classList.toggle('hud-onfoot', onFoot === 1);
    // T12: a speedometer on a man is a category error — and while he is being flung across the
    // street it reads "ON FOOT / 32 KM/H". The whole row goes away when he is not driving.
    hud.speedRowEl.hidden = onFoot === 1;
    last.onFoot = onFoot;
  }

  if (inCar) {
    const kmh = Math.round(Math.abs(gd.carSpeedF[pc]) * 3.6);
    if (kmh !== last.speed) { hud.speedEl.textContent = kmh; last.speed = kmh; }
  }

  // ---- damage bar
  const dmgOff = inCar ? 0 : 1;
  let cls = last.dmgClass;
  if (inCar) {
    let h = gd.carHealth[pc];
    if (h < 0) h = 0; else if (h > 100) h = 100;
    const pct = Math.round(h);
    if (pct !== last.dmgPct) { hud.dmgFillEl.style.width = pct + '%'; last.dmgPct = pct; }
    cls = h > 60 ? '' : (h > 30 ? 'hud-dmg-warn' : 'hud-dmg-bad');
  }
  if (dmgOff !== last.dmgOff || cls !== last.dmgClass) {
    hud.dmgEl.className = dmgOff === 1 ? 'hud-dmg hud-off' : (cls ? 'hud-dmg ' + cls : 'hud-dmg');
    last.dmgOff = dmgOff;
    last.dmgClass = cls;
  }

  // ---- counters
  if (gd.statStolen !== last.stolen) { hud.stolenEl.textContent = gd.statStolen; last.stolen = gd.statStolen; }
  if (gd.statWrecked !== last.wrecked) { hud.wreckedEl.textContent = gd.statWrecked; last.wrecked = gd.statWrecked; }

  // ---- "OUCH" fires on the transition into FLUNG and runs on frame time. Decay first, so the
  // frame that starts it always shows it — even a long catch-up frame (or a debug step of many
  // ticks at once), which would otherwise spend the whole timer before it was ever drawn.
  if (hud.ouch > 0) { hud.ouch -= dtFrame; if (hud.ouch < 0) hud.ouch = 0; }
  if (gd.playerMode !== last.mode) {
    if (gd.playerMode === PLAYER_MODE.FLUNG) hud.ouch = OUCH_TIME;
    last.mode = gd.playerMode;
  }

  // ---- centre prompt: burning warning beats everything, then OUCH, then exit, then steal
  let prompt = P_NONE;
  let promptName = '';
  if (inCar && gd.carState[pc] === CAR_STATE.BURNING) prompt = P_WARN;
  else if (hud.ouch > 0) prompt = P_OUCH;
  else if (inCar) { if (Math.abs(gd.carSpeedF[pc]) < EXIT_SPEED) prompt = P_EXIT; }
  else if (gd.playerMode === PLAYER_MODE.FOOT && gd.nearestCar >= 0) {
    prompt = P_STEAL;
    promptName = b.carName[gd.carType[gd.nearestCar]];
  }

  if (prompt !== last.prompt) {
    hud.warnEl.hidden = prompt !== P_WARN;
    hud.ouchEl.hidden = prompt !== P_OUCH;
    hud.promptEl.hidden = prompt !== P_STEAL && prompt !== P_EXIT;
    hud.promptEl.classList.toggle('hud-dim', prompt === P_EXIT);
    if (prompt === P_EXIT) { hud.promptTextEl.textContent = 'GET OUT'; last.promptName = ''; }
    last.prompt = prompt;
  }
  if (prompt === P_STEAL && promptName !== last.promptName) {
    hud.promptTextEl.textContent = 'STEAL THE ' + promptName;
    last.promptName = promptName;
  }

  // ---- controls hint fades 12 s after the first steal
  if (hud.hintAt < 0 && gd.statStolen > 0) hud.hintAt = gd.time + HINT_FADE_DELAY;
  const faded = hud.hintAt >= 0 && gd.time >= hud.hintAt ? 1 : 0;
  if (faded !== last.hintFaded) { hud.hintEl.classList.toggle('hud-faded', faded === 1); last.hintFaded = faded; }

  // ---- impact flash: driven by the frame's strongest impact, decaying on frame time
  let f = hud.flash - dtFrame * FLASH_DECAY;
  if (f < 0) f = 0;
  if (gd.statBigImpact > 0) {
    const target = Math.min(0.35, gd.statBigImpact * 0.02);
    if (target > f) f = target;
  }
  hud.flash = f;
  const fq = Math.round(f * 100) / 100;
  if (fq !== last.flash) { hud.flashEl.style.opacity = fq; last.flash = fq; }
}

export function showTitle(hud, on) {
  if (!hud || !hud.root) return;
  const want = !!on;
  if (want === hud.titleOn) return;
  hud.titleOn = want;
  hud.titleEl.hidden = !want;
  hud.root.classList.toggle('hud-titled', want);
}

// ---------------------------------------------------------------- build helpers (create time only)

function div(cls, parent) {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function span(cls, parent) {
  const el = document.createElement('span');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function pill(parent, label) {
  const el = div('hud-pill hud-panel', parent);
  span('hud-pill-k', el).textContent = label;
  const v = span('hud-pill-v', el);
  v.textContent = '0';
  return v;
}

// "WASD drive · SPACE handbrake · ..." with the keys in the accent colour.
function fillHint(el) {
  for (let i = 0; i < HINT.length; i++) {
    if (i > 0) span('hud-hint-sep', el).textContent = ' · ';
    span('hud-hint-k', el).textContent = HINT[i][0];
    span('hud-hint-t', el).textContent = ' ' + HINT[i][1];
  }
}
