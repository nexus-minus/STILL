# Backlog — known issues, noted per developer request

_(surfaced during the raytracing bring-up; fixed after the shadow issue)_

## 1. Step-up feels like a teleport

The step-up works (see `scripts/steptest.mjs`: approach → climb to exactly the
ledge height → ride → walk off) but it snaps the full height instantly —
lift/advance/drop reads as a pop, not a smooth walk-up.

**Directions to explore:** animate the vertical correction over ~100–150 ms
(camera-damped), or split the climb into two smaller corrections across
frames, or ease the camera Y toward the capsule Y with a short lerp so the
*view* smooths even if the physics snaps.

## 2. Sliding on walkable slopes (<50°)

Player still slides down surfaces that are under the 50° walkable limit.
The ground-stick snap exists but a ramp's tangential gravity component still
wins each frame.

**Directions to explore:** while grounded + no movement input, cancel the
velocity component along the slope tangent (project velocity onto the slope
plane every frame), or fully zero horizontal drift when standing still on a
walkable contact (slope normal from the ground-snap ray already gives us the
surface normal).

## 3. Residual wall-contact stutter (earlier report, partially fixed)

Projection + step-up removed most of it; small judder remains when pressing
diagonally into walls. Likely per-frame push/cancel equilibrium — explore
sleeping the into-wall velocity for a few frames while contact persists.

## 4. Baked lighting for potato mode (developer idea, liked)

Accumulate the raytraced lighting into a static texture (or bake from Blender)
so low-end machines get the *look* of traced light without interaction:
no player shadows, no per-frame cost — but the atmosphere. The current
fallback (analytic point lights + bloom) is the interim version. Design note:
keep the light list identical so bake and runtime paths agree visually.

## 5. Light quality issues (raytracing tuning, reported after wrap-fix)

- **Noise** — partially mitigated (5-tap smoothing of the lighting sample);
  proper fix = temporal accumulation with motion reprojection + a small
  denoiser (the original plan's "history buffer").
- **Leaks through surfaces, especially edges** — two causes: (a) the0.25 m
  self-surface shadow epsilon (needed for embedded fixtures) also skips real
  occluders closer than0.25 m; (b) plane-based levels have *seams* at mesh
  edges — shadow rays slip through unwelded gaps (authoring fix: weld/thicken
  walls, or we ship collision-proxy boxes for thin walls).
- **Hard cut-offs** — ~~binary shadow visibility = hard shadow edges~~
  **superseded**: mesh lights sample a jittered point on the fixture's box
  surface each frame (temporal accumulation converges a fixture-shaped
  penumbra); `?rtsoft=0` gives a deterministic face-center sample for A/B.
  Test-room point lights keep the disc jitter (1 tap).
- **Light position offset** — **done, exposure-gated**: the loader walks
  fully-buried fixture boxes out into the open; clipped/exposed boxes stay
  glued to their mesh (a box face is open — see `fixtureExposed()` in
  `map-loader.ts`) and emit from their exposed faces. The legacy analytic
  pass in main.ts now skips mesh lights (`light.extents`).

## Status of the "fix first" item

Shadow visibility is now part of `?rtdebug=2` (bright green = lit,
dark green = in shadow) — see `docs/render-pipeline.md`.
