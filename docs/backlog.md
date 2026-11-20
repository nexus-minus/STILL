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

- **Noise** — spatial denoiser landed (à-trous, SVGF-lite, guided by view
  normal + depth; measured motion-noise penalty 2.29× → 1.05×, structure
  preserved within 1.3%); remaining = motion reprojection for the temporal
  pass (the original plan's "history buffer").
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

## 6. Jump / movement edge cases (user-reported 2026-11-20, DEFERRED)

User: "there are some bugs still in jumping and other parts" after the
momentum overhaul (e621684) — agreed to fix later, once repros exist.
Likely suspects when picking this up: the additive jump impulse
(`max(vy,0) + jumpSpeed`), airborne slope-stick, and jump-on-slope /
jump-into-ceiling interactions with the new momentum model.

Coyote/buffer session probed these (2026-11-20): jump standing on the
30° ramp ✓, jump mid-climb on the 50° ramp ✓, jump mash (8 presses /
3 s) → exactly the windowed count ✓ — no clear bug found. One recorded
observation: the additive impulse makes jumping WHILE climbing a 50°
ramp give ~+1.12 m instead of ~+0.78 m (the climb's vertical velocity
carries into the jump) — intentional per the code comment, but it makes
jump height feel inconsistent on slopes and may be part of the user's
perceived jump bugs. NOT changed (would alter approved feel) — needs the
user's call: cap the carried vy, or keep it.

## 7. Interaction feedback = world reacts only (design contract, 2026-11-20)

Toasts default OFF ("nearly nothing" UI), so **every E-interaction must
visibly change the world** (checkpoint color change, door opens, light
shifts). Authoring rule: an interaction whose only feedback was a message
needs a world reaction instead. No UI prompts, no toast dependency.

## 8. Auto-chunking + light culling (engine roadmap, 2026-11-20)

- **User will NEVER split the map manually** — chunking must be automatic
  (engine/exporter side) and invisible to the authoring workflow.
- Short term: **light-distance culling** — DONE for the fog loop
  (`LIGHT_RANGE` 12 m/step in `passes/volumetrics.ts`, shipped with phase
  1b); the surface lighting loop's per-pixel culling is still queued.
- When map size demands it: automatic spatial chunking at export (triangle
  binning, no manual collections), per-chunk BVHs, distance-based unload,
  per-chunk light lists via the existing `setLights()` hook. Until then a
  single BVH at load is fine (build time + memory are the only costs that
  grow; rays are short-range and raster is frustum-culled already).

## 9. Hybrid lighting: bake pipeline (advisor-reviewed 2026-11-20, planned)

Promotes item 4 to the full production split: **Cycles-baked static
lightmaps for all static fixtures + the realtime mesh-light layer for
anything dynamic** — static lighting becomes noise-free at 60 fps on any
laptop; dynamic lights keep interaction. The pipeline must stay automatic
for the author: lightmap UVs generated at export time (no manual UV
work), re-runnable whenever the map changes (same philosophy as `--weld`
and auto-chunking). Sequence: **after materials + fog** (a bake must
sample the final material response; rebake is cheap and re-runs on any
map change). The external advice to REPLACE the realtime loop entirely
was partially rejected: realtime stays for dynamic lights and as the
medium+ tier quality path; SSGI rejected for the main path (screen-space
cannot see light through doorways you can't see) — SSR tracked as
item 12.

## 10. Rapier physics — evaluation trigger (2026-11-20, deferred)

External advice: swap the custom capsule controller for Rapier
(`@dimforge/rapier3d-compat`). DEFERRED with reason: the custom
controller just reached user-approved "feels quite good" behind 23 green
e2e checks (50° slopes, instant validated step-up, momentum model,
anti-tunnel destination validation) — an engine swap now risks
regressing exactly that, and the review's complaints ("floaty", "stuck
on corners") describe the PRE-fix state. **Trigger to revisit:** a
jump/collision bug (item 6) that cannot be fixed inside our controller,
or collision edge cases multiplying. If triggered: keep the e2e suite as
the behavior spec (it drives keys and asserts world positions, so it
ports), and re-tune slope/step/momentum on Rapier's
KinematicCharacterController.

## 11. Multiplayer later: PeerJS (or PartyKit) (2026-11-20, deferred)

GitHub Pages hosts static files only — no game server, so multiplayer
needs a free external relay when it's built. Plan: **PeerJS** (WebRTC
peer-to-peer, free, static-hosting friendly — players connect directly)
as the default; **PartyKit** only if we later need server state
(persistence, matchmaking, voice infrastructure). `playermodels`
collection already exports; requirement already established: players go
through the SAME lighting path as everything else so they read correctly
from every viewer's perspective (potato = bake + dynamic lights). No code
now — engine-ready first.

## 12. Reflections: raytraced, not SSR (DECIDED 2026-11-20)

User: "screen space reflections have limitations and moments where they
do not look that great, especially at special angles" — agreed; same
objection as SSGI: screen-space lies (the reflected object must already
be on screen → holes at screen edges, smearing/vanishing at grazing
angles, corner artifacts — no denoiser can fix a *missing* reflection).
Decision: **per-material raytraced reflections** on the WebGPU path —

- one reflection ray per glossy pixel (**roughness gate** from the
  materials batch — only rough < ~0.5 pixels pay) against the existing
  BVH, at lighting resolution (quarter-res on medium);
- shade the hit **emissive-first** (glowing panels reflected in wet floors
  = the `vibe.png` look) + approximate diffuse, so the reflection shows
  your actual light sources;
- cleaned by temporal + the edge-aware denoise stack — noise IS
  denoisable, screen-space holes are not (the fundamental asymmetry);
- cost bounded: gated by roughness, and the mesh-light change left big
  headroom (ultra locked at 60 fps with4 shadow rays/pixel);
- Potato/WebGL2 tier: no reflections for now (or a planar floor pass
  later) — decide together with the bake work.

Slots into the queue **right after materials** (it consumes their
roughness). SSR permanently rejected for the main path.
