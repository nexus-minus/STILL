# Denoising — how real games path-trace cleanly and instantly

Companion to [render-pipeline.md](render-pipeline.md). This answers the
question behind the A/B page (`/pathtrace.html`): **why does it converge
beautifully when the camera rests, but look too noisy to play?**

Short answer: real-time path-traced games never let a frame converge. They
spend a fixed, tiny sample budget per frame and spend the rest of the
pipeline — temporal reprojection, a neural denoiser, upscaling, light reuse,
and baked static GI — hiding the noise that budget leaves behind.

## 1. Why "just run more samples" doesn't work in a game

Monte Carlo path tracing converges as `1/√N`: halving the noise costs 4x the
samples. A still screenshot can afford that — the camera sits still and the
tracer accumulates for seconds. A game cannot, for three concrete reasons,
all of which are visible in this repo:

- **Every camera move invalidates the accumulated image.** A pixel's sample
  history belongs to the ray that produced it; move the camera and every ray
  changes. The page calls `tracer.updateCamera()` on each OrbitControls
  `change` event (`src/pathtrace-demo.ts`), and `WebGPUPathTracer.updateCamera()`
  ends in `reset()` — which discards the accumulated samples *and* aborts any
  in-flight denoised pass (`reset()` also calls `_denoiser?.reset()`). The
  page says it in its own status line: *"Path tracing resets when the camera
  moves; wait for the still image to converge."*
- **Frame time is a hard budget, not an average.** `renderSample()` is capped
  by an adaptive frame budget that keeps GPU time near `targetFrameTime` —
  the page sets 14 ms (library default 16 ms), and the budget scales up or
  down based on measured timestamps. Samples per second is therefore fixed by
  hardware. "Run 10x more samples" means 10x more wall-clock waiting before
  the image is trustworthy — during which the player has already moved and
  reset everything.
- **The library's own answer to movement is a preview, not an image.**
  `dynamicLowRes` is on in the page: right after a reset the tracer renders
  at a fraction of the resolution (`lowResScale`, adaptive, ~0.1 default) and
  cross-fades to full resolution over 250 ms once the average sample count
  reaches `minSamples` (default 1). That keeps motion responsive; it does not
  make the moving image clean. (The page's in-progress denoise fix bypasses
  this once a completed pass exists by pinning the preview/fade state across
  resets — see section 3.)

So a real-time tracer trades "converge eventually" for "few samples per
frame + every post-process trick below".

## 2. The real-time recipe

The stack shipped real-time path tracers use, in pipeline order. This is also
the direction for this project (see the production split in
[render-pipeline.md](render-pipeline.md)).

### 2.1 A fixed 1–8 samples per frame

The classic real-time budget is a handful of samples per pixel per frame.
This stage is *expected* to be unusably noisy — everything after it exists to
clean it up. Our tracer does this adaptively: `adaptiveFrameBudget` measures
GPU timestamps and keeps each `renderSample()` call near `targetFrameTime`,
so the per-frame sample count floats with resolution and hardware while the
frame cost stays bounded.

### 2.2 Temporal accumulation + reprojection

Reproject the previous frame's result into the current one (depth/motion
vectors), clamp the history against the current neighbourhood to reject stale
or ghosted samples, and accumulate only where the history is valid. Effective
samples-per-second while moving becomes `per-frame spp x history length`,
which is what turns 1–2 spp into an 8–32 spp look.

What we have: `src/render/rt.ts` accumulates into a history texture with
`blendAlpha = 0.08` while the camera is still, and switches to `1` (live
frame) on any motion or debug view — the code comment calls it *"reset
instead of reproject"*. Good for standing screenshots, useless while
walking. Backlog item 5 names the proper fix: temporal accumulation with
motion reprojection.

### 2.3 Neural / edge-aware denoising — OIDN with albedo + normal guides

Open Image Denoise (OIDN), the denoiser Blender ships, is what real-time
tracers run per frame on the GPU. Its key trick is **guides**: the first-hit
albedo (flat surface color, zero lighting noise) and first-hit normal are
fed alongside the noisy color, so the network can average away variance
without smearing geometry edges. The color-only model is measurably worse —
`OIDNDenoiser` notes its fallback "is blurrier but needs no auxiliary
buffers".

What we ship:

- `oidn-webgpu` — OIDN's WGSL kernels running on WebGPU, on the **same
  device** as the renderer (`initUNetFromURL(url, { device })`).
- `assets/weights/rt_hdr_alb_nrm_small.tza` (~641 KB) — per the oidn-webgpu
  README: HDR input, albedo + normal auxiliary inputs, "small" variant =
  "faster, lower quality", a deliberate pick for weak GPUs.
- Wired through the **"OIDN denoise" checkbox** in `pathtrace.html` →
  `new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: 'weights/...' })` →
  `tracer.setDenoiser(denoiser)`. Attaching it makes the tracer accumulate
  the auxiliary albedo/normal buffers (`setAccumulateAux(true)`) and restart
  the render; the pass then runs tiled across animation frames
  (`scheduling: 'animation-frame'`), with progress events forwarded to the
  page status line. The page-side snapshot guard (section 3) shadows the
  denoiser's `texture` getter so only completed passes are ever displayed.
- Guides are inspectable: `tracer.renderAuxBuffer('albedo' | 'normal')`.

The game side already produces most of what these guides need: the G-buffer
writes flat albedo (`diffuse`) and `emissive` via MRT, and the compute pass
already computes the primary-hit normal (preferring interpolated vertex
normals). A normal attachment fits in a slot — the renderer already requests
`maxColorAttachments: 4` and uses 3.

### 2.4 Upscaling (render scale)

Trace fewer pixels: more samples per pixel per millisecond *and* a cheaper
denoise pass, then upscale. The page's render-scale slider (0.2–1, default
0.5) lowers the traced resolution and the result is blitted to the canvas
with a manual bilinear sample (`RenderToScreenMaterial`). The game has the
same lever per tier (`renderScale`, `lightingScale`). Upstream also ships an
`FSRUpscaler` (a temporal upscaler) attachable via `tracer.setUpscaler(...)` —
not wired into the page today.

### 2.5 ReSTIR / reservoir reuse for direct lights

Direct lighting from many small lights is the noisiest term at low spp.
ReSTIR keeps per-pixel reservoirs of light samples, reused across pixels and
frames, so 1 spp of direct lighting looks converged. The installed
`three-gpu-pathtracer` has MIS and light sampling (the page runs
`multipleImportanceSampling = true`) but **no reservoir/ReSTIR code**. Our
game sidesteps most of this already: direct light is next-event estimation
against up to 12 analytic lights — deterministic light selection, no
light-sample variance. The residual game noise comes from the single bounce
sample, the jittered AO ray, and (as soft shadows land) the per-frame
visibility taps — all of which lean on the temporal accumulation to converge.

### 2.6 Baked static GI / lightmaps for the environment

Everything in a fixed map never moves, so its indirect lighting never
changes: bake it once (Cycles lightmaps, or offline accumulation of our own
tracer) and sample it at runtime — noise-free, zero per-frame cost, and it
works on the weakest tier. This is the documented production split in
[render-pipeline.md](render-pipeline.md) ("Recommended production split") and
backlog item 4. With the static environment baked, runtime tracing only has
to handle dynamic lights and player shadows — which is what keeps the
per-frame sample budget small enough for the rest of this recipe to work.

## 3. What this project already has vs what it still needs

### Component-by-component

| stage | game renderer (`src/render/rt.ts`) | comparison page (`/pathtrace.html`) |
| --- | --- | --- |
| primary rays / G-buffer | raster MRT `{output, diffuse, emissive}` + BVH primary ray in the lighting compute pass | BVH camera rays, `maxBounces = 4` |
| direct light | NEE over mesh lights — one point sampled on each fixture's box surface per pixel per frame (uncapped storage list), `?rtsoft=0` = deterministic face-center ray | rectangular area-light sampling + MIS |
| indirect | one bounce (the shader caps `rtBounces >= 1` at a single bounce), firefly clamp `0.6`, jittered 0.6 m AO ray + hemisphere ambient | up to 4 bounces, `clampIndirect = 3`, `filterGlossyFactor = 1` |
| temporal | history texture, `blendAlpha = 0.08` when still (now also in debug views); resets on motion, resize, and debug-mode change — **no reprojection** | full reset on camera move (`updateCamera()`), low-res preview while moving |
| spatial | à-trous edge-aware pass, strides 1/2/4/8, guided by per-pixel view normal + view depth (`geomTex`); runs after temporal, before composite; `?rtnd=0..4` limits it | none (the blit is a bilinear upscale) |
| denoiser | spatial à-trous (SVGF-lite); `?rtnd=0` disables | OIDN with albedo + normal guides — runs only after sampling settles; movement fix landed on the page |
| resolution | lighting buffer at `lightingScale` (0.25 on medium) | render-scale slider, default 0.5 |
| budget | every frame | adaptive frame budget, `targetFrameTime = 14` ms |

**Game renderer.** Phase 1a is a real traced pipeline (G-buffer, NEE shadow
rays, one bounce, temporal history) plus an à-trous spatial pass: noise is
suppressed by the temporal blend, the à-trous pass, and the firefly clamp.
Standing still converges to a clean image; moving is now near-still quality
(measured motion-noise penalty 2.29x → 1.05x). The residual noise sources are the single bounce
sample, the per-frame AO jitter, and the absence of history during motion —
backlog item 5 tracks this ("proper fix = temporal accumulation with motion
reprojection + a small denoiser"). Soft-shadow taps (also backlog item 5) are
being added in the working tree of `src/render/rt.ts`: 3 visibility taps
jittered over the fixture disc, deliberately per-frame decorrelated so the
temporal accumulation averages them into a penumbra.

**Comparison page.** A progressive tracer: converges when still, resets when
moved. The **library-level limitation is that the denoise runs only after
sampling settles** — `WebGPUPathTracer.renderSample()` only calls
`denoiser.update()` once *every* pixel has reached `maxSamples` (the library
comment says it outright: "the denoiser runs once the render stops, so an
uncapped render never denoises"), and any camera move ends in `reset()`,
which aborts a running pass (`reset()` calls `_denoiser?.reset()`). Stock
behaviour, therefore: while orbiting you get the raw noisy low-res preview,
and the OIDN pass only kicks in after you stop.

**Movement-time denoising (fix in progress in `src/pathtrace-demo.ts`).** The
design the page-side fix follows — and the reason a fix is needed at all:

- **Show only completed passes.** A denoise pass is either fully displayed or
  not displayed at all — never a half-written result. Stock OIDN output is
  tiled: the pass seeds its output with the raw color and copies tiles in as
  they finish, so the display wipes top-to-bottom. Fine as a one-shot reveal
  over an already-finished still; unacceptable as a per-frame source. The
  in-progress fix freezes each newly completed pass into a page-owned
  snapshot texture and shadows the denoiser's `texture` getter to return only
  that snapshot — until the first pass completes, the getter returns `null`
  and the raw accumulation is shown.
- **Denoise at low spp.** 1–8 samples per frame plus the albedo/normal
  guides is OIDN's designed operating point. In denoise mode the page caps
  `maxSamples` at 8 (`DENOISE_MAX_SAMPLES = 8`) so a fresh pass settles within
  frames of the camera stopping, instead of waiting for the slider's default
  64 — the smoke check `scripts/pt-denoise-smoke.mjs` exercises exactly this
  "8 samples + neural denoise" configuration.
- **Keep the clean frame on screen while the camera moves.** The library
  still aborts the in-flight pass on reset (no torn buffer is ever shown);
  the page preserves its preview/fade bookkeeping across resets in denoise
  mode so the last completed snapshot keeps displaying during a drag — a
  stale-but-clean frame beats raw noise — and the snapshot is replaced
  wholesale by the next completed pass.
- **Never let a pass outlive its input.** `OIDNDenoiser.reset()` aborts the
  running pass and drops its result whenever the image changes; any
  movement-time loop must keep that guarantee (plus a per-request guard so a
  false→true `complete` transition can never be missed or double-copied).
- **Drive passes explicitly when needed.** `OIDNDenoiser.denoise(color,
  albedo, normal)` is a public entry point, so a render loop can schedule
  passes itself instead of only through the settle gate inside
  `WebGPUPathTracer.renderSample()`.

At the time of writing this fix is uncommitted work in progress — verify the
behaviour on `/pathtrace.html` (toggle "OIDN denoise", orbit, stop) and the
smoke script before treating it as landed.

### What the game still needs

1. **Motion reprojection** so the temporal history survives camera movement
   (backlog item 5).
2. ~~A spatial/neural denoise pass~~ **DONE** — à-trous spatial pass landed
   (view normal + depth guides from the primary ray, `?rtnd` A/B knob);
   OIDN-on-settle also wired on the comparison page. Remaining polish:
   motion reprojection (item 1).
3. **Baked static GI** for the environment (backlog item 4) so the traced
   budget only has to cover dynamic light.
4. ~~Soft shadows~~ **DONE** — fixture-surface sampling replaced the disc
   taps entirely (one surface point per light per frame; temporal converges
   the jitter); A/B via `?rtsoft=0`.

## 4. If we adopt X, we get Y

| adopt | we get | next step |
| --- | --- | --- |
| Motion reprojection + history clamp (instead of reset-on-motion) | clean accumulation while walking | rework the history blend in `src/render/rt.ts`; tracked by backlog item 5 |
| OIDN pass on the game's lighting buffer (albedo = MRT `diffuse`, normal = primary BVH hit) | noise-free quarter-res lighting at 1 spp | weights already vendored; add a 4th MRT attachment for the normal (the 4th color-attachment slot is already requested); README phase 1b |
| Movement-time denoise loop on the comparison page (completed passes only, low spp) | clean frames while orbiting, not just after stopping | in progress in `src/pathtrace-demo.ts` — verify + land (design in section 3) |
| Baked static GI / lightmaps | Cycles-like base look at zero runtime cost, including potato tier | backlog item 4 + the "Recommended production split" in render-pipeline.md |
| Render scale + temporal upscaler (`FSRUpscaler`) | more spp per ms, cheaper denoise | page: attach via `tracer.setUpscaler()`; game: tier `renderScale` / `lightingScale` |
| Soft-shadow light sampling (jitter over the fixture) | soft penumbras instead of binary cut-offs | in progress in `src/render/rt.ts` (working tree) — verify + land; backlog item 5 |
| ReSTIR-style reservoir reuse | low-variance direct light at 1 spp | not present in `three-gpu-pathtracer` (MIS only) — future research item |

## 5. Honest limits

### The potato tier never traces

`src/render/quality.ts`: potato is `raytracedLighting: false` at
`renderScale: 0.75` — plain forward raster + bloom, no traced passes at all.
No traced lighting means no noise and nothing for a denoiser to fix, but also
none of the atmosphere. Baked GI (backlog item 4) is the only realistic route
to a Cycles-like look at this tier; the current interim is the analytic
point-light fallback plus bloom.

### The WebGL2 fallback cannot trace at all

- The lighting pass is a WebGPU **compute** shader writing storage textures.
  WebGL2 has no compute shaders, so `settings.raytracedLighting` is ignored
  unless the WebGPU backend is active (see "Backend fallback" in
  render-pipeline.md; feature detection, not UA sniffing; `?forcegl=1` forces
  this path).
- The comparison page refuses to start without `navigator.gpu`, and OIDN's
  model is a WebGPU compute graph. No WebGPU means no tracing and no neural
  denoiser — on that path there is nothing to denoise.
- What the fallback keeps: forward raster + bloom + screen-space
  approximations, plus (planned) baked lightmaps.

### Why baked GI is the reliable path to a Cycles-like look

- The "Cycles look" *is* converged multi-bounce GI. Baking delivers exactly
  that, once, offline, with no variance and no per-frame cost.
- Runtime path tracing has to pay for it every frame: low spp means noise
  (hence the whole recipe above), high spp means frame budget. On a 60 fps
  budget with weak GPUs, only baking removes the term entirely.
- Baking also closes the current approximation gap — analytic point lights
  versus real rectangular fixtures — because the bake can be done in Cycles
  itself with the actual emitters.
- What stays dynamic: player shadows, moving lights, camera-dependent
  effects — traced with NEE (cheap, low variance) over the baked base.

### Denoising is not free or perfect

- The `_small` OIDN weights trade quality for speed: expect slight blur or
  ghosting on thin geometry and high-frequency detail. Larger weights
  (`rt_hdr_calb_cnrm_large.tza`) exist if quality ever matters more than
  cost.
- First toggle downloads ~641 KB of weights; the pass itself runs tiled
  across frames, so a result appears progressively, not atomically.
- Guides must be correct: a denoiser fed wrong normals or albedo produces
  smeared edges — verify with `tracer.renderAuxBuffer()` before blaming the
  model.

## References

- [render-pipeline.md](render-pipeline.md) — production split, phase 1a
  architecture, `/pathtrace.html` diagnostics (URL parameters, radiance
  scale)
- [backlog.md](backlog.md) — item 4 (baked lighting for potato mode), item
  5 (noise, leaks, shadow cut-offs)
- `node_modules/three-gpu-pathtracer/src/webgpu/API.md` —
  `WebGPUPathTracer`, `OIDNDenoiser`, `FSRUpscaler`
- `node_modules/oidn-webgpu/README.md` — weight selection table (which `.tza`
  to serve for HDR/LDR and aux or not)
