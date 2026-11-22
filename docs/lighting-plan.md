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
| 3 | Higher-precision lightmap storage (RGBA16F or 10-bit) + island padding/dilation | me | `scripts/banding-check.mjs` before/after; memory measured |
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

## Open decisions

1. **Room definition.** Automatic spatial grid (no authoring work) or a `rooms`
   collection the owner defines in Blender (needed for per-room fog/atmosphere)?
   Both can coexist: grid for atlases, `rooms` collection for atmosphere.
2. **Soft shadows.** Baked area shadows (free, look right, but static) vs shadow
   maps for dynamic. For the player's light we need one real source — shadow map
   or the existing fixture-surface sampling.
3. **Antialiasing.** MSAA/SMAA instead of temporal accumulation. The current
   temporal pass is a denoiser with history, not classic TAA; ghosting risk around
   moving objects is real. Which does the owner prefer?
