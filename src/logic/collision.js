// Collision: car OBB bounds, car vs building/car/prop/bounds resolution, impact events.
// Logic module: imports only balance, never three, never the DOM, never Math.random.

// stub, implemented in Task 4
export function updateCarBounds(gd, b) {}

// stub, implemented in Task 4
export function resolveCollisions(gd, b) {}

// stub, implemented in Task 4 — pushes a circle out of the static world; result in gd.scratch[0..1]
export function pushOutCircle(gd, b, x, z, r) { gd.scratch[0] = x; gd.scratch[1] = z; }
