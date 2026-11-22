# Render pipeline

## Lighting reality check (2026-11-19)

The current `src/render/rt.ts` is a **custom real-time approximation**, not
Cycles and not a full path tracer: it traces one primary ray, NEE point-light
shadow rays, one noisy bounce, then temporally blends. It was mistakenly
turning each emissive mesh into several analytic point lights. The user's
2026-11-19 screenshot showed the expected failure mode: clipped white wash,
point-like hotspot, and non-Cycles falloff. Half-float storage is now used
(`rgba16float`, not `rgba8unorm`) so HDR radiance survives until AgX.

### Reference implementation added for A/B

Open **`/pathtrace.html`** (or `npm run dev`, then `/pathtrace.html`) to test
the same Blender `objects.glb` with the maintained
[`three-gpu-pathtracer`](https://github.com/gkjohnson/three-gpu-pathtracer)
WebGPU implementation:

- real `RectAreaLight` emitters instead of generated point-light samples
- multiple-importance sampling (MIS) to reduce area-light noise
- progressive path samples; the still image converges as the camera rests
- sample-count and render-scale controls

This is an *isolated experiment*, not the default game renderer. Upstream
`three-gpu-pathtracer` v0.0.28 supports rectangular area lights, MIS, and an
optional OIDN WebGPU denoiser, but explicitly warns its WebGPU API/BVH
dependencies are not yet stable. The game renderer stays in place while the
path-tracer is compared against the same scene.

### Denoising and page diagnostics

Why this page converges when still but is too noisy to play — and how
real-time path-traced games fix that (low spp + temporal reprojection + OIDN
with albedo/normal guides + upscaling + ReSTIR + baked static GI) — is written
up in [denoising.md](denoising.md), including what this repo already has vs
still needs.

`/pathtrace.html` diagnostic URL parameters (from `src/pathtrace-demo.ts`, all
optional):

| param | default | effect |
| --- | --- | --- |
| `?lscale=N` | 400 | multiplies every area light's intensity. The exported fixtures are physically dim (radiance ≈ 5 over ~0.19 m²), which AgX maps to pure black at exposure 1, so the page scales radiance by ×400 to make the comparison readable; the gain slider multiplies on top |
| `?env=N` | 0.35 | `scene.environmentIntensity` — the gradient world fill (also the environment's light contribution) |
| `?flip=1` | off | aims each area light's +Z at the room instead of -Z, to test which side the tracer's area-light normal actually emits |
| `?worker=1` | off | builds mesh BVHs in `GenerateMeshBVHWorker` workers (the game-sized async path); default builds synchronously to isolate worker-BVH bugs from lighting bugs |
| `?bg=green` | off | green background so missed camera rays are obvious — a green wall of background means the tracer's BVH never sees the map mesh |
| `?sun` | off | adds a diagnostic `DirectionalLight` at startup (same as the "Diagnostic sun" checkbox) |
| `?rtsoft=0` | soft on | deterministic face-center shadow ray (hard legacy look) instead of fixture-surface jittered soft shadows |
| `?rtnd=0..4` | 4 | spatial à-trous denoise iterations (0 = raw lighting only, for A/B) |
| `?vol=0\|off\|1\|on` | per tier | force the volumetric fog off/on (test + tuning override) |
| `?rtspec=0` | gloss on | disable the specular lobe (pre-gloss A/B baseline) |
| `?rtmat=1\|2` | off | material inspection views: raw albedo target / specular buffer (no bloom, no fog) |

### Recommended production split

For a walkable game, use:

1. **Static Cycles-baked indirect lighting/lightmaps** for the fixed map
   (sharp, noise-free, low GPU cost; lighting changes only when the map is
   rebuilt).
2. **Real-time shadowed lights / player shadow** for dynamic interaction.
3. **Optional progressive path tracing** as a high-end / still-camera mode,
   not the only lighting path—because path tracing resets accumulation while
   the player moves.

This is the reliable way to get a Cycles-like static environment, retain
dynamic interaction, and still support weak GPUs. A Godot switch does *not*
solve browser raytracing: the official Godot web export currently uses the
WebGL2 Compatibility renderer; Forward+/WebGPU features and SDFGI/VoxelGI
are unavailable on web.

### Current custom renderer limitations

- Emissive geometry **is** the light: one mesh-light entry per fixture
  (bbox center, local half-extents + orientation, power, cone) and one
  uniformly sampled point on the fixture's **box surface** per pixel per
  frame (front-face cosine only; temporal accumulation converges the jitter
  into a fixture-shaped penumbra). No point-light proxies — a fixture
  clipped into geometry still emits from its exposed faces. Static
  environment can still move to baked lightmaps for the potato tier.
- `rgba16float` fixes the earlier HDR clipping at1.0; it does not make the
  lighting physically based by itself.
- The temporal history is motion-reprojected since 2026-11-22 (`?reproj=0`
  restores the old hard reset): each pixel reads the texel its own world point
  held last frame, and a pixel whose projected texel belonged to a different
  surface (disocclusion) resets on its own instead of smearing. Needs real
  hardware to judge the ghosting — the reprojection itself is arithmetic, so it
  cannot be verified by measurement here.
- `rgba16float` buffers hold half-float (11 mantissa bits). That is enough for
  storage, but the eye still sees 8-bit output — hence the dither below.

Decisions locked in planning: **Three.js + custom WebGPU passes**, **hybrid
raytracing (traced shadows + 1–2 bounce GI)**, **volumetrics toggleable**,
**runs on weak GPUs at minimum settings**.

## Frame (target architecture — phase 1)

```
[1] raster G-buffer        cheap on any GPU; base image never needs RT
        ├ albedo (flat colors — no textures in this game)
        ├ normal + depth
        └ emissive mask      ← these pixels are the game's light sources
[2] RT lighting (compute)   quarter-res by default, temporal accumulation
        ├ 1 shadow ray/light → soft fixture-shaped shadows (mesh lights)
        └ 1-2 bounce rays    → emissive-lit indirect light (the glow-lighting)
[3] volumetrics (compute)   fog + light shafts at volumetricScale
        └ raymarch depth → density → shadow-ray per step → in-scatter
           (WebGPU RT path only; settings.volumetrics=false = zero cost)
[4] composite               denoised lighting × albedo + emissive,
        fog (beauty·T + S), bloom, ACES tonemap
```

WebGPU exposes no hardware RT API, so rays run in compute shaders against a
BVH. `three-mesh-bvh` provides `MeshBVHUniformStruct` + `BVHShaderGLSL`
(GPU upload + traversal helpers) — we don't write traversal from scratch.

## Quality tiers (`src/render/quality.ts`)

| tier     | backend | render scale | RT lighting        | bounces | volumetrics   |
| -------- | ------- | ------------ | ------------------ | ------- | ------------- |
| potato   | WebGL2  | 0.75         | off (screen-space) | 0       | off           |
| medium   | WebGPU  | 1.0          | quarter-res        | 1       | quarter-res   |
| high     | WebGPU  | 1.0          | half-res           | 2       | half-res      |
| ultra    | WebGPU  | 1.0          | full-res           | 2       | full-res      |

Note: high/ultra *request* `rtBounces: 2`, but the shader currently caps the
count at 1 (`bounceCount.value = settings.rtBounces >= 1 ? 1 : 0` in
`rt.ts`) — the second bounce is not yet wired.

- `T` cycles tiers in-game (kept as a dev shortcut; the settings menu is
  the primary control).
- Toggling any feature off removes the pass from the frame entirely —
  "turn volumetrics on/off" is a hard requirement, so off must cost nothing.

## Backend fallback

- `src/render/renderer.ts`: WebGPU → on any failure → same renderer with
  `forceWebGL: true`. The WebGL2 path is permanent (old Safari, weak laptops):
  forward rendering + screen-space approximations + optional cheap
  fragment-shader fog march.
- Feature detection, not UA sniffing: `settings.raytracedLighting` is ignored
  unless the WebGPU backend is active.

## Lighting model

Emissive geometry **is** the light. The traced bounce rays only ask "does this
ray hit an emissive surface?" — an extremely cheap query, which is why this
scales down to weak GPUs. Small analytic lights exist only for the fallback
path (see `test-room.ts`).

## Pass status

| pass                       | file                       | status                              |
| -------------------------- | -------------------------- | ----------------------------------- |
| forward + bloom            | `render/passes/post.ts`    | ✅ phase 0 (permanent fallback)     |
| **advanced raytraced path**| `render/rt.ts`             | ✅ phase 1a implemented — G-buffer MRT + compute lighting (traced shadows via NEE + 1 bounce) + composite/bloom; **WebGPU only**, graceful degrade everywhere else |
| volumetrics                | `render/passes/volumetrics.ts` | ✅ phase 1b — fog + light shafts (dispatched by `rt.ts`; off = zero cost) |
| chunk streaming            | `world/chunk-streaming.ts` | stub — phase 2                      |
| settings menu              | `ui/settings.ts`            | ✅ shipped (presets, overlays, binds)     |

### Phase 1a architecture (`render/rt.ts`)

- **compute** at `lightingScale` res: primary ray (`ndcToCameraRay` +
  `bvh_RaycastFirstHit`) → NEE over the emissive light list with
  `bvh_RaycastFirstHit` shadow rays (`sh.dist > 0.02` self-hit guard) → one cosine-hemisphere bounce, shaded at
  its hit → hemisphere ambient → storage texture.
  Mirrors the official three-mesh-bvh WebGPU path-tracing example exactly.
- **materials**: per-object albedo arrives via the raster pass (proven by
  probe); per-material **roughness** is baked into a float BVH vertex
  attribute (`prepareRoughness`) so the lighting ray samples gloss at the
  exact hit with zero extra fetches — GGX + Schlick (F0 = 0.04, Principled
  dielectric) + Schlick-GGX on the SAME shadow sample (specular costs ALU
  only, never an extra shadow ray), written to its own buffer with
  temporal/à-trous in lockstep, masked on emissive surfaces in the
  composite. `?rtspec=0` = pre-gloss baseline, `?rtmat=1|2` =
  albedo/specular inspection views, `?matroom` = demo scene.
- **raster MRT** `{ output, diffuse, emissive }` (3 attachments; the 4th
  `maxColorAttachments` slot stayed free — per-material specular lives in
  its own rgba16float buffer set because the composite multiplies the
  lighting buffer by albedo, which would tint a highlight by the wall).
- **composite**: `diffuse × lighting + emissive + specular + baked` selected
  against the beauty pass by a uniform flag (tier changes never rebuild
  the graph), then fog (`beauty·T + S`), then bloom. The baked lightmap
  term lives in its own buffer and is added *after* the albedo multiply
  (RGBM decoded once at load with the K=π scale, so static and dynamic
  share one brightness); debug: `?rtdebug=3` = realtime-dynamic-only,
  `?rtdebug=4` = the baked buffer, `?nolightmap` A/Bs the split.
- **lights**: emissive meshes in Blender → one mesh-light entry each
  (center, local half-extents + orientation quaternion, linear color, power,
  cone) in an **uncapped storage buffer** (5 vec4 slots/light, runtime
  `for (i < lightCount)` loop — no MAX_LIGHTS; a map exceeding
  `maxStorageBufferBindingSize` fails loudly instead of truncating;
  mechanism proven by `scripts/rt-storage-probe.mjs`). `setLights()` exists
  for future chunk-streamed rebuilds.
- **safety**: construction failure → standard path + on-screen notice;
  WGSL validation error → `uncapturederror` hook disables the path once;
  black frames → existing detector → forced-WebGL reload.

Verification split: local tests prove the GL paths + all safety nets (green);
WebGPU pixel output needs real hardware — it runs fine in this machine's
Chromium headful with `--enable-unsafe-webgpu` and a clean
`XDG_CONFIG_HOME` (that is how the rt-softshadow screenshots were taken;
headless Chromium still destroys the Dawn instance quickly, and Firefox
lacks WebGPU) — the boot line reports `rt=armed|off`, and any shader error
appears on screen and in the console.

### WGSL/TSL gotchas learned the hard way

- The `compute` function must be the FIRST function in the source — three
  parses the first fn for the entry signature.
- No `-> void` — Tint rejects it; use a value-returning call instead.
- Never apply unary minus to a swizzle (`-ray.direction` on a swizzle can
  produce NaN in TSL) — precompute the value.
- `target` is a WGSL reserved keyword: `var target` fails Tint validation.
  Name locals `lightPt` or similar.
- This Tint build rejects WGSL ternary `?:` ("invalid character found" at
  the `?`, probe-verified) — use `select(cond, a, b)`.

## Anti-banding + idle frame (added 2026-11-22)

Three pieces that only exist to make the picture read smooth, and each has an
A/B URL flag so the effect can be seen rather than believed:

| flag | default | what it turns off for the A/B |
| --- | --- | --- |
| `?dither=0` | dither on | the runtime blue-noise dither at the 8-bit step |
| `?reproj=0` | reprojection on | motion reprojection → the old hard reset on any camera move |
| `?settle=N` | 6 | how many frames may run after a change before the frame freezes; `0` = never freeze |
| `?idle=0` | freeze on | the idle freeze — dispatch runs on every frame |

### 1. Blue-noise dithering (`src/render/bluenoise.ts`)

The 64×64 void-and-cluster mask is generated by the same algorithm with the same
seed as `tools/bake_map.py`, so the bake and the runtime agree on one thing: the
mask breaks the 1/256 plateaus into short runs. Measured on the fixture bake
(1024², 48 samples, `--dither-ab`, so both numbers come from the SAME linear
values quantized two ways — otherwise Cycles' own noise would make the comparison
dishonest):

| | distinct levels | longest flat run | % of lit area in runs ≥ 8 px | 8×8 block error |
| --- | --- | --- | --- | --- |
| blue noise | 205 | 158 px | 36.5 % | mean 0.01 %, max 0.27 % |
| plain rounding | 207 | 290 px | 54.1 % | mean 0.00 %, max 0.18 % |

Honest reading of those numbers: dithering **cannot restore information** — the
plain rounding uses *more* levels and is *more* accurate, so dithering is not
"more correct". What it does is move the error from the plateau boundary (a
visible line) into a spatially even scatter, and the eye integrates over a few
texels, so the gradient reads smooth. The block-average error is the number that
separates "wrong" from "quantized". Higher texel density and 10-bit storage solve
the other problem (more information), which is why both are in the plan.

Where the dither must be applied: AFTER tone mapping and sRGB, at the moment the
value becomes 8-bit. On linear radiance a 1/255 offset is the wrong size, and the
tone curve stretches exactly the darks where banding shows. So the composite calls
`renderOutput()` itself and `pipeline.outputColorTransform = false`. Debug and
material views (`?rtdebug`, `?rtmat`) stay exact — the smoke scripts compare
canvas readbacks against buffer values. The mask is indexed by the DISPLAY pixel
(`screenCoordinate`), not by the lighting texel: a quarter-res buffer would give
every pixel inside one texel the same threshold and the banding would survive.

Effect on the measurement scripts (checked individually, not assumed):

- **Dither:** the readback scripts compare means, ranges, ranks or plateaus with
  tolerances of ≥ 2 LSB, and a dither offset is at most 0.5 LSB, so it cannot move a
  result. The black-frame detector thresholds at 8/255, which a ±0.5 LSB offset cannot
  cross. Debug/material views are gated off anyway, so `scripts/rt-mat-*` and
  `scripts/rt-bake-smoke` read exact values. No script needs `?dither=0`.
- **Idle freeze:** this one DOES change what the scripts measure, because a static
  scene stops dispatching after the settle window — the numbers would describe a
  settle-window average instead of the long-converged image the asserts were calibrated
  on, and `?vol=off` asserts like "dispatches === 0" could pass for the wrong reason.
  So every pixel-readback script pins `settle=0` in its boot URL
  (`rt-bake-smoke`, `rt-denoise-smoke`, `rt-mat-smoke`, `rt-mat-probe`, `rt-vol-smoke`,
  `rt-vol-explore`). `recovery-test` needs no flag: it tests the detector, which still
  reads the canvas on a frozen frame.

### 2. Dirty-flag scheduler + settle window

A frame is only traced when something that affects the picture changed: camera
pose, settings key, debug/material view, light gain, light list, buffer size, or
an explicit `markDirty()` call. After a change, `SETTLE_FRAMES` frames run so the
accumulation converges; from then on the dispatch is skipped and the composite
re-shows the existing buffers. That is free money on a laptop — and the picture is
not a single-sample frame: the frozen frame is the settle-window average.

Worth stating precisely, because it is the honest limit: `blendAlpha = 0.08` needs
roughly 1/0.08 ≈ 12 effective samples for the history to dominate, so after 6 frames
the image is *partially* converged. `?settle=N` is therefore the quality knob — raise
it for cleaner dark gradients and give up some of the frame budget, lower it to get the
freeze back. The agreed default of 6 is the window the owner said is acceptable, and
long corridors with soft light matter more than glossy floors.

Two details that make this safe:

- `rtFlag` must not be forced to 0 on a frozen frame: 0 means "show the raster
  beauty pass", which would replace the accumulated frame with an unlit one.
- `markDirty()` also resets history, because what the buffers hold was lit by the
  PREVIOUS state.

The composite still runs every frame — the canvas is not guaranteed to keep its
content, and the screenshot + black-frame paths read it back.

### 3. Motion reprojection (`?reproj=0` to compare)

Each pixel projects its own hit point with the PREVIOUS camera and reads the
history texel that point held last frame. The disocclusion test (stored view
depth vs. the depth this point would have had from last frame's pose) is what
prevents the ghosting TAA is known for: a texel that held a different surface is
not this surface's history, so that pixel starts fresh.

Why this matters more than the dither: the old code reset the whole frame on any
camera move, which is exactly why standing still looked clean and walking looked
noisy. Reprojection lets accumulation continue while walking, at the cost of one
matrix multiply and one texture read per pixel.

## Perf targets

- Low (potato): 60 fps on integrated GPUs, everything playable.
- Medium: 60 fps on a mid-range GPU.
- The gigantic map: per-chunk BVHs, frustum culling, instancing, worker BVH
  builds — never one world-sized BVH on the main thread.
