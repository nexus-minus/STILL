# Lighting plan (German — for the owner, so they can read and challenge it)

This is the agreed direction, based on the owner's decisions plus the external
AI review. It is a plan, not implemented code. Decisions that still need the
owner's call are marked **OPEN**.

## Core idea

Make the renderer **deterministic wherever nothing changes**, and use real rays
only for what genuinely changes.

- Static geometry: Cycles bake. The bake already contains soft, fixture-shaped
  area shadows — so static surfaces need **no shadow rays at all**, for free.
- Moving objects (player, entities, doors): irradiance probes (SH, order 2) from
  the same bake + shadow maps from the few dynamic lights.
- Atmosphere: analytic fog for the low tier, low-res volumetric for the high tier,
  per-room fog colour/density/exposure as authoring tools.
- Raytracing becomes an **optional ambience layer** (gated reflections, dynamic
  lights), not the foundation.
- Frame scheduler with a dirty flag: idle = no work; interaction = render; settle
  window = a few frames after a change, then freeze.

## Steps, in order

| # | step | who does it | how we test it | state |
|---|------|-------------|----------------|-------|
| 1 | Frame scheduler + dirty flag + settle window (4–6 frames, then freeze) | me | stand still, watch that FPS stops being spent; move, watch that the image does not change after the settle | ✅ `rt.ts` (`?settle=N`, `?idle=0`) |
| 2 | Blue-noise dithering on the bake sample and on the output | me (owner can learn the 3 lines) | dark flat corridor wall before/after: plateaus must disappear | ✅ bake encode + runtime composite (`?dither=0`) |
| 2b | Motion reprojection in the temporal blend | me | walk through a corridor: noise while walking vs. standing still; look for ghosting around corners | ✅ `rt.ts` (`?reproj=0`) — needs real hardware for the visual check |
| 3 | Higher-precision lightmap storage (RGBA16F or 10-bit) + island padding/dilation | me | `scripts/banding-check.mjs` before/after; memory measured | ✅ storage (`lightmap.bin`, 16-bit, 2026-11-22, measured by `scripts/lightmap-16bit-check.mjs`) — padding/dilation open |
| 4 | Bake type change: irradiance without colour contribution, so `albedo × irradiance` works in both paths | me (Blender side, headless) | test room: same wall, bake vs realtime, brightness must match |
| 5 | Density: per-area atlases instead of one world atlas. Target 64–128 texels/m on floors and important objects | **OPEN — see "room definition"** | measure texel density per atlas, look for seams at doorways |
| 6 | Irradiance probes (SH order 2) for moving objects | me | put a sphere next to a wall under a lamp, compare with the wall |
| 7 | Shadow maps for dynamic lights (budget: 1–2 lights, 1024², PCF) | me | flashlight in a baked corridor: shadow must appear, image must not double-light |
| 8 | Optional ray layer: reflections gated by roughness, dynamic mesh lights | me | `?rtspec=0` A/B |
| 9 | Per-room atmosphere values (fog density, colour, exposure, density target) as Blender custom properties | **owner (artistic)** | two rooms with different fog, walk through the doorway |

**Validation room (built first, before the big map):** two differently coloured
light sources, one static wall + floor, one moving door, one moving object, one
dynamic flashlight, and a doorway between two differently lit rooms. If that room
looks right and has no lighting discontinuity, the architecture is proven.

## What the bake can and cannot do (asked by the owner, 2026-11-22)

A bake is one photograph of light, taken once, per surface position. That is the
whole limit, and it is worth stating plainly:

- **Static geometry** — baked, zero per-frame cost. Done.
- **Something that moves** — cannot be baked, because it visits many positions and
  each position would need its own stored light. So we store light per **space**
  instead of per surface (the irradiance grid/probes): the moving object reads the
  light of the cell it is in. No rays per frame, no authoring work, and every cell
  behaves the same.
- **Something that changes state** (door open/closed, lamp on/off): only the states
  an author marks can be precomputed. Either a pre-baked variant per marked state,
  or a realtime overlay for the change. There is no "one bake per situation", and a
  browser cannot run Cycles at runtime — so "overwriting the bake" in-game means an
  overlay on top of it, not a re-bake.

That is why the plan is: bake for what never changes, grid for what moves, and rays
only for the few things that must react in the same frame.

## Decisions (owner, 2026-11-22)

1. **No room concept at all.** The world is not a floor plan of rooms — it has
   corridors, halls, caves, courtyards, outdoor areas, half-open spaces. A
   room-shaped lookup would fail everywhere the geometry is not a box. So the lookup
   is a **generic world-wide grid** (spatial hash / voxel cells over the whole map,
   built automatically from the geometry, density chosen per area), never a named
   room. Nothing is authored, and every cell behaves the same. Atmosphere values can
   still be per-area custom properties later, but they must not change how lighting
   behaves.
2. **Antialiasing: the player decides in the settings.** Implementation default: MSAA
   where the GPU can afford it, SMAA on weak GPUs, and "off" stays selectable.
3. **Storage: 16-bit half-float** (see `docs/blender-conventions.md` → "Baking").
   Measured: an 8-bit file is 1.55 display LSB off the 16-bit reference on average
   and off by ≥ 1 byte on 80.3 % of dark texels; the half-float step is under 1
   display LSB at every value, so the file itself cannot band. The dither stays at the
   display step, where the eye actually quantizes.
4. **Bake type: Combined for now** (fixtures stay white, which is what the renderer
   wants). Step 4 (irradiance without colour contribution) stays open until the
   validation room can compare both, because `albedo × irradiance` must agree in both
   paths.

## Open decisions

1. **Room definition — closed 2026-11-22: no rooms.** A world-shaped lookup (generic
   world-wide grid) instead of any room concept, because the world is not made of
   rooms. The grid is built automatically; nothing is authored.
2. **Soft shadows.** Baked area shadows (free, look right, but static) vs shadow
   maps for dynamic. For the player's light we need one real source — shadow map
   or the existing fixture-surface sampling.
3. **Antialiasing.** MSAA/SMAA instead of temporal accumulation. The current
   temporal pass is a denoiser with history, not classic TAA; ghosting risk around
   moving objects is real. Which does the owner prefer?
