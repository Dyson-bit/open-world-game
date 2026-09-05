# JOYRIDE — Game Design Document

*Steal. Drive. Wreck. Repeat.*

## Core fantasy
You are dropped on foot into a small, sunlit, candy-colored city at golden hour. Every car
on the street is yours for the taking. You hop in, floor it through traffic, clip a lamp
post, spin out, plough into a bakery, watch the hood crumple and smoke, bail out before it
blows, and steal the next one. There is nothing else to do and nothing else is needed.

## Design pillars
1. **The loop is the game.** Walk → steal → drive → crash → wreck → get out → steal again.
   Every system exists to make one of those verbs feel better. Nothing else ships.
2. **Speed and consequence.** Cars are fast and twitchy enough to be fun to lose control of.
   Every impact is legible: a jolt, a dent, sparks, a noise, a damage bar that moves.
   Wrecking is a spectacle, never a punishment.
3. **A toy city, not a map.** Low-poly, flat-shaded, saturated. Buildings with exaggerated
   proportions, big long warm shadows, chunky cars with distinct silhouettes. Color and
   shape do all the work — no textures, no noise.
4. **Zero friction.** No menus beyond one title card. No failure state. No loading.
   Fall out of a burning car and you are already walking toward the next one.

## The loop in detail
| Verb | What the player does | What the game does |
|---|---|---|
| Walk | WASD relative to camera, ~6 m/s | Character bobs, camera trails behind |
| Steal | Walk to any car, press **E** | Prompt names the car ("E — steal the HAULER"); instant hop in; counter +1 |
| Drive | W/S throttle, A/D steer, Space handbrake | Arcade physics with drift, engine tone rising, FOV widening, skid marks |
| Crash | Hit anything | Screen shake, sparks, dent in the body where it hit, damage bar drops, props go flying |
| Wreck | Health hits zero | Fire + "GET OUT" warning, 3 s later explosion, charred wreck stays in the world |
| Get out | **E** at any time (or get thrown clear by the blast) | Player stumbles out; if caught in the blast: flung, brief stun, back on feet |

## The city
- 8 × 8 blocks on a 54 m pitch (~430 m square), two-lane roads, curbs, crosswalks.
- Districts by distance from centre: central plaza with a landmark tower → downtown
  tall blocks → mid-rise → low-rise suburbs with parks.
- South edge is a waterfront: promenade, pier, flat blue water. Other edges fade into
  low green hills under warm haze.
- Traffic: ~40 moving cars following lanes, ~70 parked at curbs. Any of them can be taken.

## Cars (7 types, distinct silhouettes and handling)
| Type | Silhouette | Handling |
|---|---|---|
| Pip (hatchback) | short, tall cabin | nimble, slow |
| Cruiser (sedan) | long, three-box | balanced |
| Comet (sports) | low, wide, wedge | fastest, grippy, fragile |
| Hauler (pickup) | cab + open bed | heavy, torquey |
| Boxvan (van) | tall single box | slow, heavy, sturdy |
| Cab (taxi) | sedan, yellow, roof sign | balanced |
| Bus | very long, tall | slow, very heavy, wrecks everything it touches |

## Feedback and feel
- Impact strength drives everything: shake amount, spark count, dent depth, audio thump,
  damage dealt.
- Smoke starts at 60% health, black smoke + fire below 30%, explosion at 0.
- Brake lights, wheel steer and spin, body roll in corners, pitch under braking.
- Procedural audio: engine, tire squeal, impacts, explosion, wind. **M** mutes.

## Explicitly out of scope
Missions, weapons, police, pedestrians, story, music, day/night cycle, multiplayer,
saving, mobile touch controls.
