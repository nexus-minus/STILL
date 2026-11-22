# Backlog — known issues, noted per developer request

_(surfaced during the raytracing bring-up; fixed after the shadow issue)_

## 1. Step-up feels like a teleport

**Vertical: DONE** (commit e621684) — physics snaps, the camera eases
over ~150 ms (τ 50 ms; steptest asserts 0.300 m lag at the climb frame
and < 0.01 m eye error 150 ms after). The user approved the animation
itself ("the animation itself is okay").

**Remaining — horizontal advance (measured 2026-11-21):** every accept
still advances ≥ radius+0.08 = **0.43 m in ONE frame** (measured
**+0.54 m** at walk speed 0.94 m/s at the 50°→platform junction) — the
body visibly hops forward even though the height is eased. Directions:
ease the horizontal component the same way (camera-damped offset along
the advance), or shorten the advance by measuring the obstacle width
first (the same measure-first approach the proportional-lift work used
for height). **User's call on feel.**

Original note (superseded by the above): the step-up works (see
`scripts/steptest.mjs`: approach → climb to exactly the ledge height →
ride → walk off) but it snapped the full height instantly —
lift/advance/drop read as a pop, not a smooth walk-up.

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

**QA pass 2026-11-21** (`scripts/controlprobe.mjs`, 33 checks): no
further jump bugs found across ledge-lip jumps, jump spam (40 presses),
mid-slope transitions, corner step-ups, freecam switches, respawns and
height transitions. Two REAL bugs found & fixed: (1) **phantom edge
contact at steep-ramp toes** → stuck-crawl limit-cycle (collision.ts:
reject contacts where the capsule centre is behind the face plane and
only the triangle boundary is reachable; regression `toe-slide`, zEnd
−1.44 → −4.58), (2) **jump buffer survived `respawnAt`** — stale intent
fired a jump at the fresh spawn (buffer now cleared there; regression
`respawn-buffer`). Additive-impulse numbers **updated post-retune**:
flat **0.467 m** / 50°-climb walk **0.783 m** / 50°-climb run **1.58 m**
(3.4× flat; pre-jump vy 3.245 m/s) — the earlier 1.12/0.78 predate the
jump-height change. Ceiling probes: N/A by design (ceilings excluded
from the collision BVH). Still the user's call: cap carried vy, or keep.

**Flaky step-lips assertion: RESOLVED (2026-11-21)** — root-caused
frame-by-frame (run-speed landing on the nub's leading edge → transient
edge-catch 0.09–0.103 before settling). The window now derives `h` from
a live BVH raycast and the pop limit from the live `stepUp`; the nub
face was corrected 5.5 → 5.55 (the old value sampled 5 cm early,
dragging the contact frame into the pre-landing tumble); and the new
window now **rejects** a full-step pop (the old `h+0.05` accidentally
admitted one on the 0.25 lip). Proof: probe 28/28 + 5 consecutive
steptest runs × 38 green.

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

**Status 2026-11-20: Blender-side SHIPPED** — `tools/bake_map.sh` runs one
headless Blender process: automatic UV2 (lightmap pack, all meshes into one
shared atlas, ≥32 px island gaps) → Cycles Combined bake (emissive panels
bake white) → `lightmap.png` + re-exported `objects.glb` with
`TEXCOORD_1` + additive manifest `lightmap` block. ~7 s total (5 s bake at
2048²/64 spp on GPU). Self-audits every run: UV1 untouched, zero overlapping
texels, TEXCOORD_1 verified, black bake = exit 1. `export_map.sh --bake`
flag added (default path byte-identical); stats/UV checkers in
`scripts/bake-stats.mjs` / `scripts/bake-glb-uv.mjs`; docs in
blender-conventions.md → "Baking". **Remaining: renderer consumption**
(NEED map-loader: load the PNG as `SRGBColorSpace`, sample `TEXCOORD_1`,
blend the baked static lighting under the realtime layer) — sequenced after
materials per the plan below.

**Renderer-consumption requirements (user, 2026-11-20) — must hold for
1:1 Cycles/realtime match without overexposure:**
1. When a lightmap is present, **exclude baked static lights from the
   realtime RT light buffer** — static lights must not be double-lit;
   realtime rays serve only animated/dynamic lights.
2. If the 8-bit sRGB `lightmap.png` clips bright highlights under AgX,
   **re-encode the bake as RGBM (or half-float HDR)** so fixtures keep
   smooth Cycles falloff instead of clipping white-hot.
3. **Runtime adaptation (user, 2026-11-21):** changing a light at
   runtime (lever/toggle, color, intensity, movement) must be visible
   within a frame via the realtime dynamic layer; permanent changes fold
   back into the bake offline (no runtime baking).

**Status 2026-11-21: consumption SHIPPED** — all three requirements
verified by `scripts/rt-bake-smoke.mjs` (16 asserts): (1) per-light
`baked` flag rides `le.w` and static pixels skip baked lights *before any
ray work* (baked×50 → 0/255 delta over 278 points; raw ambient < half of
realtime-static) — static pixels now cost **0 shadow rays** for the
fixtures; (2) clipping measured (max radiance 6.6, 1.59 % of texels over
1.0, AgX display error ≤0.177) → **RGBM re-encode** with both channels
sRGB-encoded (sRGB-M floor 0.002 vs linear-M's 0.026, which blacked out
whole rooms in the first attempt; round-trip worst error 0.77 %);
(3) runtime light change visible **within 3 frames** (raw Δ+62.7/255,
beauty Δ+116.2). Also shipped: **uv1-sentinel classification** for
dynamic geometry (no TEXCOORD_1 → full realtime light set + ambient;
covered → lightmap + dynamic lights only — players/animated
auto-classify when they land in the BVH); baked term in its **own buffer
added after the albedo multiply** (a Cycles Combined bake stores outgoing
radiance *with* albedo inside — never through `diffuse × lighting`);
potato receives it through the forward **emissive slot** (NOT
`material.lightMap`, which double-applies albedo and adds a 1/π error);
K=π applied once at decode (static+dynamic share one scale, calibrated
+10 % under AgX vs legacy); `?rtdebug=3` = realtime-dynamic-only,
`?rtdebug=4` = the baked buffer, `?nolightmap` A/Bs the split.

**Status 2026-11-22 (bake side, anti-banding):** the encode is dithered by default (blue
noise, 64×64 void-and-cluster, same algorithm and seed as the runtime mask — `--dither` /
`--no-dither` / `--dither-ab`, banding report printed every run). Measured on the fixture
bake (1024², 48 spp, `--dither-ab` so both numbers come from the SAME linear buffer
quantized two ways): dither 205 levels / longest flat run 158 px / 36.5 % of the lit area
inside runs ≥ 8 px / 8×8 block error mean 0.01 %; plain rounding 207 levels / 290 px /
54.1 % / 0.00 %. Plain rounding is **more** accurate — dithering only moves the error off
the plateau boundary, so it is a perceptual fix, and the docs say so rather than
overselling it. Two things still open here:

- **Bake type.** Combined stores outgoing radiance *with albedo inside*, so it cannot be
  reused as irradiance for moving objects (probes need `albedo × irradiance`). Changing
  the bake to irradiance / no-color-contribution is the cleaner model but changes what the
  static path multiplies — needs the user's call together with the probe work.
- **16-bit lightmaps.** A browser PNG decodes at 8-bit, so a 16-bit bake needs KTX2 or a
  binary RGBA16F file, not a PNG. Not worth it while dithering + texel density still solve
  the visible problem, and it would break the "just look at the PNG" workflow.

**Interactive/lever lights (design, not yet implemented):** a light
toggled at runtime cannot remove its own baked pool — the bake must
exclude it: Blender prop `dynamic=1` → `bake_map.py` zeroes that
fixture's emission during the Cycles bake (restores before re-export),
lists it in `manifest.lightmap.dynamic[]` → loader marks it
`baked:false` (full realtime layer + potato PointLight). Until then:
permanent changes fold into the offline rebake (~6 s).

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

**Roughness batch ready (materials landed 2026-11-20):** per-hit
`roughness` already rides the BVH vertex attributes
(`bvh_sampleTrianglePoint(...).roughness`), the specular buffer with
temporal/à-trous runs in lockstep with the lighting buffer, `?matroom`
provides the A/B scene (smooth vs matte spheres) and `?rtspec=0` is the
no-gloss baseline. Reflections consume exactly this roughness.

## 13. Dynamic actors: hand light + player shadows (user, 2026-11-21)

- **Hand-held light** ("the player can theoretically hold a light in
  his hand"): a dynamic mesh-light entry that follows the player's hand
  per frame (a cheap position write into the storage light list) plus an
  emissive mesh visual on the player. It is dynamic by definition, so
  the realtime layer renders it and casts its shadows — this falls
  straight out of the bake split in #9. UX undecided: the user's keybind
  list is fixed (no light key in it), so always-on dim vs tied to
  interact vs a future toggle needs THEIR call before implementation.
- **Player shadows** (same message): other players must CAST shadows in
  the RT path — skinned/dynamic geometry needs a refit or an analytic
  stand-in in the BVH; combined with #11's rule (players share the
  lighting path so they read correctly from every viewer's perspective).

## 14. Anti-banding + idle frame (shipped 2026-11-22, visual check pending)

Three mechanisms, each with an A/B URL flag so the effect can be seen instead of
believed (full write-up in `docs/render-pipeline.md` → "Anti-banding + idle frame",
German test checklist in `docs/test-checklist-de.md`):

1. **Blue-noise dithering** at the 8-bit display step, applied AFTER tone mapping
   (`renderOutput()` in the composite, `outputColorTransform = false`), indexed by the
   display pixel (`screenCoordinate`, so pixel ratio and render scale are included).
   Debug and material views stay exact so the smoke readbacks remain valid.
2. **Dirty-flag scheduler + settle window** (`?settle=N`, `?idle=0`): a frame is traced
   only when something that affects the picture changed; after the settle window the
   dispatch is skipped and the composite re-shows the accumulated buffers. Honest limit: at
   `blendAlpha = 0.08` the history needs ~12 effective samples, so the frozen frame is the
   settle-window average, not full convergence — `?settle=N` is the quality knob. `rtFlag` is
   not forced to 0 on a frozen frame (0 = raster beauty pass, which would replace the
   accumulated frame with an unlit one). The HUD shows `· frozen` in the stats line —
   otherwise a frozen frame and a slow frame are indistinguishable on screen.
3. **Motion reprojection** (`?reproj=0` restores the old hard reset): each pixel reads
   the history texel its own world point held last frame, with a depth-based
   disocclusion check that keeps it from becoming TAA ghosting. This is the biggest
   noise win, because the old behaviour (reset the whole frame on any camera move) is
   exactly why standing still looked clean and walking looked noisy.

**What is verified vs. what is not:** typecheck green, bake-side measurements done
(numbers in #9 and render-pipeline.md). Nothing visual is verified — no WebGPU browser
on this machine — so the visual judgement needs the user's hardware. Reported so far:
banding confirmed to come from the bake; `?rtsoft=0` did not change the stripes the user
saw, and the stripes were dark green and aligned with emissive objects → most likely
baked coverage (UV island / margin), not geometry seams. The HUD `· frozen` marker and
the reprojection ghosting need a real look.

**Smoke scripts (checked individually, not assumed):** the dither cannot move their results —
they compare means, ranges, ranks or plateaus with tolerances of ≥ 2 LSB, a dither offset is at
most 0.5 LSB, and the debug/material views they read are exempt from the dither by design.
`recovery-test` thresholds at 8/255, which a ±0.5 LSB offset cannot cross. No script needs
`?dither=0`. The **freeze** does change what they measure (a static scene stops dispatching
after the settle window, so numbers would describe a settle-window average instead of the
long-converged image the asserts were calibrated on, and `?vol=off` asserts like
"dispatches === 0" could pass for the wrong reason). So the pixel-readback scripts pin
`settle=0` in their boot URL: `rt-bake-smoke`, `rt-denoise-smoke`, `rt-mat-smoke`,
`rt-mat-probe`, `rt-vol-smoke`, `rt-vol-explore`. `recovery-test` needs no flag.

**Possible next step:** the bake report could warn per fixture when a light clips or is
brighter than the display range allows — the user suspects some lights are too bright, and
a warning in the bake output is cheaper than hunting it visually.

**Open decisions (user's call, blocking the next build steps):**
- **Room definition:** automatic spatial grid (no author work, rooms are not theirs) vs
  an author-defined `rooms` collection in the `.blend` (matches the story, costs editor
  work).
- **Anti-aliasing:** MSAA (sharp edges, GPU cost) vs SMAA (post pass, kinder to weak
  GPUs). For long corridors with soft light, SMAA is the cheaper fit.
