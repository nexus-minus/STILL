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

## Status of the "fix first" item

Shadow visibility is now part of `?rtdebug=2` (bright green = lit,
dark green = in shadow) — see `docs/render-pipeline.md`.
