// Input: keyboard and mouse staged into gd.input. Handlers are attached once and only ever write
// raw intent — no gameplay runs here. Held keys are cleared on keyup/blur; edges are cleared by
// the tick that consumes them.
// Board module: the DOM lives here.

export function attachInput(canvas, gd, b, opts) {
  const inp = gd.input;
  const onFirstGesture = (opts && opts.onFirstGesture) || null;
  let gestured = false;
  let dragging = false;
  let lastX = 0, lastY = 0;

  function firstGesture() {
    if (gestured) return;
    gestured = true;
    if (onFirstGesture) onFirstGesture();
  }

  function onKeyDown(e) {
    firstGesture();
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': inp.forward = 1; e.preventDefault(); break;
      case 'KeyS': case 'ArrowDown': inp.back = 1; e.preventDefault(); break;
      case 'KeyA': case 'ArrowLeft': inp.left = 1; e.preventDefault(); break;
      case 'KeyD': case 'ArrowRight': inp.right = 1; e.preventDefault(); break;
      case 'Space': inp.handbrake = 1; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight':
  inp.run = 1;
  break;
      // edges: a held key must not re-fire them
      case 'KeyE': case 'Enter': if (!e.repeat) inp.action = 1; e.preventDefault(); break;
      case 'KeyC': if (!e.repeat) inp.camToggle = 1; break;
      case 'KeyM': if (!e.repeat) inp.mute = 1; break;
      default: break;
    }
  }

  function onKeyUp(e) {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': inp.forward = 0; break;
      case 'KeyS': case 'ArrowDown': inp.back = 0; break;
      case 'KeyA': case 'ArrowLeft': inp.left = 0; break;
      case 'KeyD': case 'ArrowRight': inp.right = 0; break;
      case 'Space': inp.handbrake = 0; break;
      case 'ShiftLeft': case 'ShiftRight':
  inp.run = 0;
  break;
      default: break;
    }
  }

  function clearHeld() {
  inp.forward = 0;
  inp.back = 0;
  inp.left = 0;
  inp.right = 0;
  inp.handbrake = 0;
  inp.run = 0;
}
  }

  function onPointerDown(e) {
    firstGesture();
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
  }

  function onPointerMove(e) {
    if (!dragging) return;
    inp.orbitDX += e.clientX - lastX;
    inp.orbitDY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
  }

  function onPointerUp() { dragging = false; }

  function onWheel(e) {
    inp.zoom += e.deltaY;
    e.preventDefault();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearHeld);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', preventDefault);

  return {
    detach() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearHeld);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', preventDefault);
    },
  };
}

function preventDefault(e) { e.preventDefault(); }
