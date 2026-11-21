# Real-time RT techniques — how shipped games do it, and what we adopt

Companion to [denoising.md](denoising.md) (the noise math and our buffers),
[render-pipeline.md](render-pipeline.md) (our frame), and
[how-it-works.md](how-it-works.md) (plain-English overview). This one is a
**decision document**: what other engines actually ship, what makes an image
read as "Cycles", and an ordered verdict per technique for *this* codebase.

Scope constraint that decides half the table: **browsers expose no hardware
raytracing API**. WebGPU gives us compute shaders, so every ray here is
software traversal of a `three-mesh-bvh` BVH. Anything that requires RT cores,
tensor cores, or vendor denoiser binaries (DLSS, OptiX, hardware ReSTIR) is
out of reach unless a WGSL/portable version exists. We render at
`lightingScale` (quarter-res on medium, half on high, full on ultra) with
`potato` = WebGL2 and zero rays.

---

## 1. How other games do it

### 1.1 Baked GI — the default for every non-next-gen title

| engine | what gets baked | per-frame cost | what it needs from you |
| --- | --- | --- | --- |
| Unreal (Lightmass / GPU Lightmass) | lightmaps + shadowmaps on UV2 | memory only — Epic's own comparison: precomputed GI's "performance costs are relative to the memory required to load and store the lightmap textures" ([Epic GI doc](https://dev.epicgames.com/documentation/unreal-engine/global-illumination-in-unreal-engine)) | lightmap UVs, static geometry/lights, a rebuild when the level changes |
| Unity (Progressive / Compute Light Baker) | lightmaps, light probes, Adaptive Probe Volumes | memory + a sample fetch; APV adds a streamed 3D probe structure sampled per pixel ([Unity 6 GI blog](https://unity.com/blog/engine-platform/new-ways-of-applying-global-illumination-in-unity-6)) | "Contribute GI" flags, probe density; Enlighten *realtime* GI is being deprecated after Unity 6 — Unity's own current docs point back toward baked/precomputed GI and probes |
| Unreal (bake speed) | same | GPU Lightmass needs a DXR GPU; one team measured 46 min CPU → 16 min GPU bake ([Unreal Fest 2022 talk](https://confpad.io/conferences/unreal-fest-2022/static-vs-dynamic-lighting)) | — |

Epic's framing of the whole trade ([UE5 Lumen tech blog](https://www.unrealengine.com/tech-blog/unreal-engine-5-goes-all-in-on-dynamic-global-illumination-with-lumen)):
for most of history GI *"had to be solved in an offline process called lightmap
baking, because it was too computationally expensive to be calculated in real
time"* — baked lighting is "very high quality, but completely static", dynamic
GI is "fully dynamic" but "can be significantly more expensive".

**Per frame vs cached:** bake runs once at authoring time. Runtime cost is a
texture fetch. This is why games on weak hardware (mobile, Switch, Quest) bake:
it is the only technique in this document that costs *literally nothing* per
frame and still delivers converged multi-bounce GI.

### 1.2 Lumen (Unreal 5) — the reference dynamic-GI stack

Lumen is not one technique, it is a pipeline of fallbacks
([Lumen technical details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine),
[UE5 Lumen tech blog](https://www.unrealengine.com/tech-blog/unreal-engine-5-goes-all-in-on-dynamic-global-illumination-with-lumen),
[SIGGRAPH 2022 Lumen slides](https://www.advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-Lumen-Wright%20et%20al.pdf)):

1. **Screen traces** first — cheap, fixes G-buffer/ray-scene mismatch near the camera.
2. **Software ray tracing** against mesh SDFs merged into a global distance
   field (sphere tracing, no RT hardware needed) — or hardware RT when present.
3. **Surface Cache** — offline-generated mesh "cards" (a UV-less parameterization
   of every mesh, ~12 cards per mesh by default), recaptured as the player moves,
   amortized over frames. Rays don't shade at the hit; they look up lighting in
   the cache. Multi-bounce GI comes from the cache reading *itself* with
   feedback — every update propagates one more bounce.
4. **Final Gather** — the first diffuse bounce, the one that matters most, gets
   dedicated treatment: GI is computed in a **screen-space radiance cache at
   downsampled resolution**, importance-sampled using *last frame's* lighting
   (Epic: guidance from history "gives the same quality as if we had traced four
   times more rays"), then filtered *inside the cache* rather than as a
   screen-space denoiser, then integrated with full-res material data.
5. **World-space radiance cache** for distant lighting (indoor rooms lit through
   a small window — the classic hard case).
6. Everything rides on **temporal upsampling** — Epic states Lumen "relies
   heavily on temporal upsampling with Unreal" rather than running GI at native
   resolution.

**Per frame vs cached:** cards and the SDF are offline/prebuilt; surface-cache
updates are amortized; radiance caches are temporally accumulated with capped
history (they cap accumulation at 4 frames to limit ghosting); only the final
gather rays are genuinely per-frame, and those are reused across pixels and
frames.

**Takeaway for us:** the shape of Lumen — *few rays, aggressively reused,
everything else cached* — is the same shape as our tier plan. Its specific
machinery (SDF, cards, probe atlases) is a lot of infrastructure; the pieces
portable to a WebGPU compute renderer are the radiance-cache idea (§3.3) and
history-guided importance sampling.

### 1.3 RTXGI / ReSTIR — sample reuse instead of more samples

- **ReSTIR DI** ([Bitterli et al. 2020](https://research.nvidia.com/sites/default/files/pubs/2020-07_Spatiotemporal-reservoir-resampling/ReSTIR.pdf)):
  each pixel keeps a fixed-size *reservoir* of light samples, reused from
  temporal and spatial neighbors. Equal error **6–60× faster** than prior
  methods; 3.4 million dynamic emissive triangles at ≤8 rays/pixel.
- **ReSTIR GI** ([Ouyang et al. 2021](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14378),
  [RTXGI docs](https://github.com/NVIDIA-RTX/RTXDI/blob/main/Doc/RestirGI.md)):
  same reservoir idea applied to *indirect* samples — **9.3×–166× MSE
  improvement at 1 spp**. The docs are explicit that you need an existing
  forward path tracer first (position/orientation/PDF/radiance of the secondary
  surface), and that it underperforms on low-roughness specular (use MIS against
  the raw input there).
- **ReSTIR PT** ([Lin et al. 2022](https://research.nvidia.com/labs/rtr/publication/lin2022generalized/)):
  reuses whole paths, so it also works on specular; 1 path per pixel with
  many-bounce diffuse and specular.
- **Shipped use:** Cyberpunk 2077 Ray Tracing Overdrive runs ReSTIR DI + GI with
  NRD denoising ([SIGGRAPH 2023 integration course](https://intro-to-restir.cwyman.org/presentations/2023ReSTIR_Course_Cyberpunk_2077_Integration.pdf)).
  Two lessons from that deck worth stealing regardless of adoption: *"ReSTIR
  and denoiser eat each other's lunch"* — better sampling means you can afford a
  weaker/cheaper denoiser, and a good denoiser lets you sample less; and start
  from an offline ground-truth accumulation to validate against before enabling
  any reuse (bias is easy to introduce silently).

**Per frame vs cached:** reservoirs *are* the cache — a few dozen bytes per
pixel, persisted across frames, no precomputation.

### 1.4 Full path tracers in games — and how they afford it

**Quake II RTX** ([NVIDIA path-tracing series](https://developer.nvidia.com/blog/path-tracing-quake-ii/),
[Q2RTX readme](https://github.com/NVIDIA/Q2RTX/blob/master/readme.md)):

- budget: **1 sample/pixel, 1 indirect bounce, 2 shadow rays** (their GDC deck
  states it flatly: "One path per pixel · One indirect bounce · Two shadow rays");
- lights: per-cluster **potentially-visible-set light lists** encoded with the
  mesh, a CDF over projected solid angle, then one stochastic pick — plus a
  coin-flip between static and dynamic light because only one shadow ray fits;
- denoiser: **A-SVGF** — temporal accumulation with motion-vector reprojection
  and adaptive history rejection, variance estimation, à-trous wavelet filter;
  a full denoise pass costs **~3.5 ms at 1440p**;
- hardware: RT cores give ~3× over software traversal on Turing and ~6× vs a
  1080 Ti (NVIDIA's frame breakdown video);
- stills: a **photo mode** disables denoising entirely and accumulates hundreds
  of frames — i.e. their "clean screenshot" is the same progressive behaviour as
  our comparison page;
- cost split: the second bounce alone was ~⅓ of the frame.

**Minecraft RTX** ([alain.xyz frame analysis](https://alain.xyz/blog/frame-analysis-minecraftrtx),
[NVIDIA GTC talk](https://developer.nvidia.com/blog/gtc-digital-crafting-a-real-time-path-tracer-for-minecraft-rtx/)):

- renders primary-ray data at **reduced resolution** (1484×835 buffers feeding a
  2560×1440 output) and reconstructs with **DLSS 2.0**;
- **three separate denoisers** — diffuse (customized SVGF, 6 small 3×3
  iterations, spherical-harmonic irradiance so normals ride in the light signal),
  specular (reprojects *what the reflection sees*, using a stored reflection
  distance, not the reflection itself), and a dedicated **shadow denoiser** with
  aggressive temporal rejection and an anisotropic kernel to keep contact
  shadows;
- **per-triangle irradiance cache** fed back into itself: each frame traces one
  bounce, but it reads last frame's cache, so *over time* you get many bounces;
- frame split ≈ **40% ray tracing, ≈ 45% denoising** (Digital Foundry's numbers,
  [quoted here](https://www.resetera.com/threads/df-minecraft-rtx-deep-dive-how-nvidia-delivered-a-game-changing-ray-tracing-upgrade/188328/)).

**What buys them the right to path-trace:** RT cores (unavailable to us), a
neural upscaler from a low internal resolution (we have tiers but no ML
upscaler), a denoiser budget of roughly *half the frame* (we spend four à-trous
dispatches), and progressive accumulation whenever the camera rests (we already
do this: `blendAlpha = 0.08` while still). The recipe is identical; only the
hardware differs.

### 1.5 Raster + RT hybrids, and browser-side work

- **Metro Exodus** ([Digital Foundry interview](https://www.digitalfoundry.net/articles/digitalfoundry-2019-metro-exodus-tech-interview)):
  "ultra" traces 1 ray/pixel, "high" traces **0.5 rpp in a checkerboard** with
  one denoise pass running on the checkerboard. Their engineer's honest notes:
  ray tracing and denoising cost *about the same* in most scenes; denoising cost
  scales **essentially quadratically** as you remove rays; and they went from
  three rays to one by rebuilding around "high quality denoising and temporal
  accumulation of ray data across multiple frames", ending with a dedicated
  denoising TAA.
- **Call of Duty: MW4 variable-rate ray tracing**
  ([SIGGRAPH 2026 advances](https://advances.realtimerendering.com/s2026/content/SIGGRAPH2026%20-%20Micha%C5%82%20Olejnik%20-%20Variable%20Rate%20Ray%20Tracing%20in%20COD%20MW4.pdf)):
  each pixel requests a *fractional* ray rate — supersample disoccluded pixels
  that lost temporal history, undersample converged pixels where variance is
  low, thresholded with a blue-noise texture, then a bucketed load-balancer
  forces the screen back to a fixed ray budget per frame. Their "quarter rate"
  mode is just probability 0.25 per pixel.
- **Browser-native (all WebGPU compute, no RT cores):**
  - `three-gpu-pathtracer` — the library behind our `/pathtrace.html`: progressive
    tracing, `OIDNDenoiser` (OIDN WGSL kernels), `FSRUpscaler`
    (`node_modules/three-gpu-pathtracer/src/webgpu/API.md`).
  - [pmndrs/denoiser](https://pmndrs.github.io/denoiser/) — OIDN in WGSL plus
    **AMD FidelityFX shadow and reflection denoisers ported to WGSL**, plus their
    own SVGF-family realtime denoisers (diffuse, specular, shadows, AO) written
    from published papers with provenance cited per shader. Their own caveat:
    validated on Apple GPUs only so far, API still experimental.
  - [hush](https://github.com/kanaworksai-hue/hush) — SVGF plus a tiny network
    that predicts *filter parameters* (not pixels), so unknown content degrades
    to a classic edge-aware filter.
  - [OIDN WebGPU](https://github.com/pissang/oidn-webgpu) — what we already vendored:
    HDR + albedo/normal weights, tiled execution, `_small`/`_large` variants.

---

## 2. What makes it look like Cycles

"Cycles look" is not a post-process. It is the **converged solution of the
rendering equation**, plus Blender's default display pipeline:

| ingredient | what it looks like | baked (Cycles bake) gives it free? | realtime must add |
| --- | --- | --- | --- |
| multi-bounce GI | light in corners, no black shadows, rooms lit through doorways | ✅ — a Cycles bake *is* converged path tracing, stored as texels | bounces, or a cache/probe approximation of them |
| color bleeding | red wall tints the floor next to it | ✅ (same integral) | comes with any real indirect term — our bounce does this already, our flat ambient does not |
| soft area shadows | penumbra widening with distance, fixture-shaped | ✅ (area emitters in the bake) | area-light NEE + temporal convergence — **we have this** |
| correct material response | Principled BSDF specular, fresnel, roughness | ✅ (the bake samples final materials) | per-material BRDF — **we have GGX/Schlick for direct light**; missing metallic/F0 and indirect specular (our bounce is diffuse-only, `specScale = 0`) |
| tone mapping | AgX highlight roll-off, saturated colors going to white like a camera | ✅ (Blender default view transform since 4.0 — [Blender 4.0 notes](https://developer.blender.org/docs/release_notes/4.0/color_management/)) | **we have AgX** (`src/main.ts`: `AgXToneMapping`, exposure slider) |
| denoising | clean at 1 sample | n/a — the bake never had variance | mandatory, every frame (§3.1) |
| reflections | fixtures mirrored in a wet floor | only via reflection probes | traced reflection rays (backlog #12) |

The honest summary: **baking hands you every static half of the Cycles look for
zero runtime cost**, including the parts real-time rendering has to fight for.
What baking cannot do is anything that changes: player shadows, moving objects,
lights toggling, dynamic bounce. That residual is exactly what a real-time
traced layer should cover — and it is cheap, because it is *direct* light plus
one shadow ray per light, which is what our NEE loop already computes.

Conversely, what realtime still has to add even *after* the bake lands:

1. dynamic direct light + shadows (have),
2. dynamic indirect (bounce, currently 1 and noise-limited),
3. specular/reflections (direct gloss have, reflections queued),
4. noise control that survives movement (partially have),
5. consistent exposure/tone (have).

---

## 3. The good-looking + low-cost toolkit

Every row: what it costs, what it needs from us, and whether it is viable in
**WebGPU-compute-only** against our tiers (potato = no rays, medium =
quarter-res, high = half, ultra = full). "Viable" here means: plain compute
shaders, no vendor SDK, no RT/tensor cores.

### 3.1 Denoisers

| technique | what it costs | what it needs | WebGPU-only? | verdict for our tiers |
| --- | --- | --- | --- | --- |
| **SVGF family** (temporal reprojection + variance-guided à-trous) | ~2–6 small passes at *lighting* resolution — this is what Minecraft spends ~45% of frame on and Quake II RTX does in 3.5 ms at 1440p | motion vectors, depth, normal, a moments/variance buffer, history-length tracking | ✅ pure compute — we already run 4 à-trous passes | the baseline; medium gets it at quarter-res for ~free, potato gets nothing (no rays to denoise) |
| **A-SVGF** (variance drives *filter strength* and history weight) | +1 moments buffer pass | same as SVGF + variance math | ✅ | the Quake II RTX upgrade path over plain SVGF; small diff on top of what we have |
| **OIDN** (neural, albedo+normal guides) | a full UNet pass over the frame — the comparison page already pays it, tiled across animation frames; ~641 KB weights download once | HDR + albedo + normal guides; our G-buffer has `diffuse`, the normal needs the free 4th MRT slot | ✅ (it *is* WebGPU — `oidn-webgpu` runs on our device) | viable on medium+; too slow to assume on potato-class iGPUs — must be measured, and it is a *still/settle* tool more than a per-frame tool at `_small` weights |
| **AMD FidelityFX shadow/reflection denoisers** (WGSL ports exist) | one temporal pass per effect at lighting res | motion vectors + history for that signal | ✅ (WGSL port already written by pmndrs/denoiser) | the cheapest credible upgrade for *specific* 1-spp signals (shadow visibility, reflection buffer) |
| **NRD / ReBLUR / SIGMA** ([NVIDIA](https://developer.nvidia.com/rtx/ray-tracing/rt-enoisers)) | tuned for 1–2 spp on hardware RT pipelines | HLSL→WGSL port of a large library, plus hit-distance buffers | partial — technically possible, practically a port project | overkill — we can adopt the *ideas* (separate shadow denoiser, recurrent blur) without the SDK |
| **ReSTIR-Denoise-style "sampling does the denoising"** | reservoir passes instead of filter passes | a working resampling loop | ✅ | see §3.5 — the value depends on whether our direct light is already low-variance (it is) |

Key asymmetry to remember (from the Cyberpunk integration deck): a **denoiser
cannot invent missing information** — it can only smooth noise that exists in
the input. Screen-space holes (SSGI/SSR) are unrecoverable; traced noise is
recoverable. That single fact is why every technique below trades in *traces*,
not in screen-space guesses.

### 3.2 Upscaling / reconstruction

| technique | what it costs | what it needs | WebGPU-only? | verdict |
| --- | --- | --- | --- | --- |
| **Render-scale (what we do today)** | zero — it *is* the cost saving | none | ✅ | already the biggest lever: `renderScale`/`lightingScale` per tier |
| **Temporal upsample (FSR-class)** | AMD's measured FSR 3.1 upscale: **0.3–1.6 ms at 1080p Quality, 0.5–2.0 ms at 1440p Quality** depending on GPU ([GPUOpen](https://gpuopen.com/fidelityfx-super-resolution-3/)) | sub-pixel jitter, per-pixel motion vectors, depth, reactive mask — **we have none of these yet** | partial — FSR 3 ships DX12/Vulkan; FSR 1/2-class EASU+RCAS shaders are portable, and `three-gpu-pathtracer` already exposes an `FSRUpscaler` that takes the `Upscaler` class from `@pmndrs/upscaler` (which runs FSR1 in WebGPU — a package we do **not** have installed yet) | worth it *after* motion vectors exist (they are the same infrastructure reprojection needs) |
| **ML upscalers (DLSS/XeSS/FSR4)** | — | tensor/Matrix cores | ❌ | never in a browser |
| **Checkerboard / half-res + reconstruct** | Metro's 0.5 rpp checkerboard; Minecraft's reduced buffers | a reconstruction filter + jitter | ✅ | our tiers already achieve the same *effect* by tracing at `lightingScale`; a proper reconstruct beats the current bilinear blit |
| **Photo-mode accumulation** (Quake II RTX) | seconds of stillness | our existing `blendAlpha = 0.08` history | ✅ | **already have it** — standing still converges |

### 3.3 Radiance caching / probes

| technique | what it costs | what it needs | WebGPU-only? | verdict |
| --- | --- | --- | --- | --- |
| **Baked lightmaps** (§1.1) | zero at runtime | UV2 + a bake (we have `tools/bake_map.sh`, ~7 s) | ✅ (it's just a texture) | **the big win, landing now** (backlog #9) — gives potato included |
| **Screen-space radiance cache** (Lumen's final gather) | one downsampled GI buffer, reprojected + filtered, then upsampled onto full-res shading | motion vectors, a half/quarter-res GI trace, temporal clamp | ✅ all compute | the natural upgrade for our quarter-res lighting buffer: *trace few rays at low res, accumulate in cache, integrate at full res* |
| **Irradiance cache fed back over time** (Minecraft's per-triangle cache) | one cache write per frame, reads last frame's value | a world-anchored cache (per-triangle or per-texel), temporal validity | ✅ | the cheapest way to get >1 effective bounce without tracing >1 bounce per frame |
| **Probe grids / APV-style** | memory + a bake; per-pixel probe fetch | probe placement (ours can ride the lightmap bake) | ✅ | a future option for *dynamic-object* lighting on the potato tier; not needed while the lightmap covers static surfaces |
| **Surface cache / mesh cards** (Lumen) | offline card generation + amortized recapture | per-mesh parameterization, atlas management | possible, but heavy infrastructure | never — our maps are static and already baked |

### 3.4 Light culling, RT LOD, shadow handling

| technique | what it costs | what it needs | WebGPU-only? | verdict |
| --- | --- | --- | --- | --- |
| **Light-distance culling** | one distance test per light per pixel before the shadow ray | the light list we already have | ✅ | **queued already** (backlog #8) — the fog pass already does it (`LIGHT_RANGE` 12 m) |
| **Per-cluster light PVS + CDF** (Quake II RTX) | precomputed per-cluster light lists, one stochastic pick per pixel instead of N lights | per-cluster preprocessing, spatial partition | ✅ | the right tool *if* maps ever ship hundreds of fixtures; our current maps run a handful of lights with NEE, so culling first, PVS later |
| **Clustered/forward+ light culling** ([Olsson et al. 2012](https://www.cse.chalmers.se/~uffe/clustered_shading_preprint.pdf)) | clustering + assignment passes (0.7–5.7 ms for 32 → 1M lights) | a raster deferred/forward+ shading loop | ✅ but wrong layer | **not our architecture** — it exists to bound *raster* shading over thousands of analytic lights; our cost is traced shadow rays, which culling addresses directly |
| **RT LOD / variable-rate rays** (COD MW4, §1.5) | bucket counters + a blue-noise threshold; saves rays in converged areas | temporal reprojection + variance first (it decides *where history is good*) | ✅ | later — blocked on motion reprojection |
| **Separate shadow signal + shadow denoiser** (Minecraft, SIGMA) | one extra buffer + one filter pass | a pure-visibility buffer (our `?rtdebug=2` signal is exactly this) | ✅ | good value: shadow noise behaves differently from lighting noise |
| **Ray-traced reflections** (backlog #12) | one reflection ray per glossy pixel, gated by roughness | materials batch (landed), roughness in BVH (landed) | ✅ | queued after materials, correctly |

### 3.5 Reservoir sampling (ReSTIR) — honest assessment

ReSTIR's win is *direct lighting from many lights* and *indirect at 1 spp*.
Our direct lighting is **NEE over a short mesh-light list with one deterministic
sample per light per pixel** — already near-zero light-selection variance, which
is exactly the variance ReSTIR removes. So **ReSTIR DI buys us almost nothing
today**; it becomes relevant only if a map ships hundreds of dynamic lights.

ReSTIR GI is the interesting one (it would raise a 1-bounce image toward
many-bounce quality at 1 spp), but RTXGI's own docs require an existing forward
path tracer with position/PDF/radiance of secondary surfaces, and shift mappings
are where bias gets introduced quietly. Our renderer is a G-buffer + one-bounce
approximation, not a general path tracer. **Effort: high. Value: real but
post-everything-else.** ReSTIR PT is further out still.

---

## 4. Audit of our engine against the survey

Everything below is verified against `src/render/rt.ts`, `src/render/quality.ts`,
`src/main.ts`, `src/pathtrace-demo.ts` and the docs named.

### 4.1 What we already have (honest list)

| area | status | evidence |
| --- | --- | --- |
| mesh-light NEE | ✅ one uniformly sampled point on each fixture's **box surface** per light per pixel per frame, area-weighted face pick, `faceWeight` for the light-side cosine, cone support, uncapped storage buffer | `shadowVis`, `directLight` in `rt.ts` |
| soft shadows | ✅ fixture-shaped penumbra converged by temporal accumulation; `?rtsoft=0` A/B | `shadowVis` box branch; backlog #5 |
| per-material specular | ✅ GGX + Schlick (F0 0.04 dielectric) + Schlick-GGX, roughness baked as a BVH vertex attribute, own buffer with temporal + à-trous in lockstep, `?rtspec=0`, `?rtmat=1\|2` | `specularLobe`, `prepareRoughness` |
| indirect | partial — **one** bounce (shader caps `bounceCount = settings.rtBounces >= 1 ? 1 : 0`, so high/ultra's `rtBounces: 2` is not wired), diffuse-only, firefly clamp 0.6; plus a flat hemisphere ambient × jittered AO ray (0.6 m) | `rt.ts` dispatch + kernel |
| temporal | partial — history blend `0.08` when still / `1` when moving or in debug — **reset, not reproject**; no motion vectors anywhere | `dispatch()` |
| spatial denoise | ✅ à-trous SVGF-lite, strides 1/2/4/8, view-normal + tangent-plane-depth edge stops, miss sentinel, `?rtnd=0..4`; **deliberately no luminance/variance term** (comment: luminance variance *is* the noise) | `denoise` kernel |
| neural denoise | ✅ on the **comparison page only** (OIDN albedo+normal, `DENOISE_MAX_SAMPLES = 8`, completed-pass snapshot); not on the game path | `src/pathtrace-demo.ts` |
| upscaling | partial — tier `renderScale`/`lightingScale` only; library `FSRUpscaler` exists but is not wired anywhere | `quality.ts`, `API.md` |
| tone mapping | ✅ AgX at exposure 1.0 + user exposure slider — Blender's default view transform | `src/main.ts` |
| fog/volumetrics | ✅ raymarched, toggleable, `LIGHT_RANGE` 12 m light culling, own temporal rule | `passes/volumetrics.ts` |
| tiers | ✅ potato = WebGL2/no rays (0.75 scale), medium = quarter, high = half, ultra = full | `quality.ts` |
| baked GI | 🔜 **Blender side shipped** (`tools/bake_map.sh`: UV2 → Cycles Combined bake → `lightmap.png` + `TEXCOORD_1` + manifest block, self-auditing); **renderer consumption not yet in `src/`** — no lightmap sampling exists in the game code today | `tools/`, `scripts/bake-stats.mjs`, backlog #9 |
| safety nets | ✅ loud failure on oversized light lists, `uncapturederror` → disable once, black-frame detector → forced WebGL reload | `rt.ts`, docs |

### 4.2 What's missing for the Cycles look

Ordered by how much of the gap each closes:

1. **Baked GI consumption** — everything static is currently lit by a 1-bounce
   real-time approximation plus a flat ambient constant. The bake exists; the
   renderer doesn't sample it yet (backlog #9, including the two user rules:
   no double-lighting, RGBM/HDR if sRGB clips under AgX).
2. **Motion reprojection** — while moving, `blendAlpha = 1`, so every moving
   frame is a raw 1-spp frame plus à-trous. This is the single biggest
   "not clean while playing" cause (backlog #5). Lumen/Quake/Minecraft all
   reproject; we reset.
3. **Second bounce** — `rtBounces: 2` on high/ultra is silently capped at 1.
   Cycles-like corners need ≥2, *or* the bake's multi-bounce replacing it.
4. **Indirect specular** — the bounce shades `specScale = 0`, so glossy surfaces
   get no reflected indirect light (only direct gloss + the queued reflection
   rays would fix this properly).
5. **Variance-guided filter strength** — our à-trous has geometry edge-stops but
   no variance signal, so it applies the same blur everywhere (deliberate, but
   it is exactly what A-SVGF/Minecraft's variance-driven iterations add).
6. **The flat ambient term** — `mix(0.012…, 0.028…, N.y)` × AO is not
   light-derived; it cannot color-bleed or respond to fixtures. The bake
   replaces it; until then it is the main "not Cycles" tell in dark corners.
7. **No reflections** (backlog #12), **no motion vectors** (blocks reprojection,
   upscaling, RT LOD), **no per-frame neural denoise on the game path**, **no
   temporal upsample** (we blit `lightingScale` up with a bilinear sample).

### 4.3 Rejected — recorded reasons, not relitigated

| rejected | reason already on record | new evidence since? |
| --- | --- | --- |
| **SSGI** | screen-space cannot see light through a doorway you can't see; leaks at screen edges — backlog #9, how-it-works §9 | none. Lumen's own doc confirms screen traces are only a *first* fallback layered over a world-space cache, never the whole answer |
| **SSR** | reflected object must already be on screen → holes, smearing at grazing angles, "no denoiser can fix a *missing* reflection" — backlog #12 (user's own observation); decision = per-material RT reflections | none |
| **Replacing the realtime loop entirely with the bake** | partially rejected in #9: realtime stays for dynamic lights and as the medium+ quality path | none |
| **WebGL2 path tracing** | no compute shaders, period — the WebGL2 path is permanent forward+raster | none |
| **Godot / engine switch** | the official Godot web export is WebGL2 Compatibility; Forward+/SDFGI unavailable on web — render-pipeline.md | none |
| **ML upscalers** | tensor cores only | confirmed: DLSS/FSR4/XeSS ML paths all require vendor matrix hardware |

---

## 5. Prioritized adoption plan

The bake-consumption hybrid (backlog #9) is **landing now** — it is the big
win and it is not on this list because it is already the plan. This table is
**what comes after**. Each row is sized to become one session.

| # | technique | expected quality gain | cost (runtime) | effort (dev) | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | **Motion reprojection + history clamp** (replace reset-on-motion; depth/normal reprojection with disocclusion rejection) | huge — turns "grainy while walking" into near-still quality; unblocks 4, 8, 9 | +1 copy + a compare pass at lighting res | medium (rework history blend in `rt.ts`, add motion vectors from the primary ray) | **next session** (backlog #5) |
| 2 | **Bake consumption** (sample `TEXCOORD_1`, exclude baked lights from the RT list, RGBM/HDR if AgX clips) | huge — converged multi-bounce GI everywhere, potato included | one texture fetch | medium (map-loader + composite + light-list split) | **in flight** (backlog #9) |
| 3 | **Wire the 2nd bounce** (or explicitly drop `rtBounces: 2` from high/ultra) | medium — deeper corners, real bounce count matches the tier table | ~1 extra bounce + NEE at the hit | small | **later** — cheap, grab it in the same session as #1 |
| 4 | **Variance-guided à-trous (A-SVGF moments)** | medium — sharper detail, less over-blur, adaptive strength | +1 moments pass | small-medium | **later** |
| 5 | **Light-distance culling in the surface loop** | perf headroom → spend it on 3/4 | negative (saves) | small | **later** (already queued, backlog #8) |
| 6 | **RT reflections, roughness-gated** (backlog #12) | high for materials — fixtures in wet floors is the `vibe.png` look | +1 ray on glossy pixels only | medium | **later** (after 2–3) |
| 7 | **Game-path OIDN** (weights already vendored, 4th MRT slot already requested) | high for stills/low motion; marginal while moving until #1 | a UNet pass — must be measured on medium | medium (wire denoiser + normal attachment + budget gate) | **later** |
| 8 | **Temporal upsample** (motion vectors from #1 → FSR1-class EASU/RCAS via `@pmndrs/upscaler`, or half-res+reconstruct) | medium — better image *and* headroom for more spp | 0.3–2 ms (AMD's FSR table) | medium | **later** (blocked on #1) |
| 9 | **Screen-space radiance cache for GI** (Lumen-style: trace GI at quarter res, reproject+filter in the cache, integrate at full res) | high — effective multi-bounce feel without extra rays | 1 low-res trace + 1 filter | high | **later** (only if #2/#3 still read flat) |
| 10 | **Dedicated shadow-visibility buffer + its own filter** (Minecraft/SIGMA approach; our `?rtdebug=2` signal already exists) | medium — cleaner contact shadows, less shadow flicker | +1 buffer + 1 pass | small-medium | **later** |
| 11 | **WGSL FidelityFX shadow/reflection denoisers** (pmndrs/denoiser ports) | medium — better 1-spp filtering than à-trous for those signals | 1 temporal pass per effect | medium (vendored dependency, Apple-GPU-only validation noted upstream) | **later / evaluate** |
| 12 | **Per-pixel fractional ray rate** (COD MW4: skip rays where history is converged) | perf only — more headroom for 3/4/6 | saves rays | high (needs #1 + variance + bucket balancing) | **later** |
| 13 | **Per-cluster light PVS + CDF** (Quake II RTX) | perf only, and only at scale | preprocessing | high | **never for now** — revisit when a map ships hundreds of fixtures |
| 14 | **ReSTIR DI** | low — NEE already has near-zero light-selection variance | small | high | **never** (revisit only if many dynamic lights) |
| 15 | **ReSTIR GI / ReSTIR PT** | high in theory (9–166× MSE at 1 spp) | reservoir buffers | very high (needs a real path tracer + shift mappings + bias validation) | **never** while the bake + 1-bounce path exists |
| 16 | **NRD/ReBLUR port** | marginal over rows 4/11 | — | very high (HLSL→WGSL library port) | **never** — adopt ideas, not the SDK |
| 17 | **Clustered light culling, ML upscalers, frame generation, surface-cache cards** | — | — | — | **never** (wrong architecture / needs vendor hardware / needs offline infra we don't need) |
| 18 | **SSGI / SSR / engine switch** | — | — | — | **never** (§4.3, already rejected with reasons) |

### How to read this

- Rows 1–3 are the "look like Cycles while playing" cluster: keep history
  through motion, bake the static multi-bounce, and make the bounce count real.
- Rows 4–8 are the "make it cheap enough to be good" cluster: each one buys
  either more samples or fewer artifacts per millisecond.
- Rows 9–12 are conditional: adopt only if, after 1–8, the image still reads
  flat or noisy in a way a screenshot comparison against `/pathtrace.html`
  (the Cycles-like reference) can demonstrate.
- Rows 13–18 are recorded so the next session doesn't re-research them.

---

## References

- [denoising.md](denoising.md) — why low spp is noisy; our temporal/à-trous/OIDN state
- [render-pipeline.md](render-pipeline.md) — frame architecture, tiers, production split
- [backlog.md](backlog.md) — #4 baked lighting, #5 noise/leaks, #8 culling/chunking, #9 bake pipeline, #12 reflections
- Epic: [UE5 Lumen tech blog](https://www.unrealengine.com/tech-blog/unreal-engine-5-goes-all-in-on-dynamic-global-illumination-with-lumen) · [Lumen technical details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine) · [SIGGRAPH 2022 Lumen](https://www.advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-Lumen-Wright%20et%20al.pdf) · [GI overview / Lightmass](https://dev.epicgames.com/documentation/unreal-engine/global-illumination-in-unreal-engine)
- Unity: [Unity 6 GI + APV](https://unity.com/blog/engine-platform/new-ways-of-applying-global-illumination-in-unity-6)
- ReSTIR: [DI paper](https://research.nvidia.com/sites/default/files/pubs/2020-07_Spatiotemporal-reservoir-resampling/ReSTIR.pdf) · [GI paper](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14378) · [RTXGI ReSTIR GI docs](https://github.com/NVIDIA-RTX/RTXDI/blob/main/Doc/RestirGI.md) · [Cyberpunk Overdrive integration](https://intro-to-restir.cwyman.org/presentations/2023ReSTIR_Course_Cyberpunk_2077_Integration.pdf)
- Full path tracing: [Quake II RTX series](https://developer.nvidia.com/blog/path-tracing-quake-ii/) · [Q2RTX readme](https://github.com/NVIDIA/Q2RTX/blob/master/readme.md) · [Minecraft RTX frame analysis](https://alain.xyz/blog/frame-analysis-minecraftrtx) · [Crafting a real-time path tracer for Minecraft RTX](https://developer.nvidia.com/blog/gtc-digital-crafting-a-real-time-path-tracer-for-minecraft-rtx/)
- Denoising: [Ray Tracing Denoising (A-SVGF, NRD, ReSTIR overview)](https://alain.xyz/blog/ray-tracing-denoising) · [NVIDIA RT enoisers](https://developer.nvidia.com/rtx/ray-tracing/rt-enoisers) · [Ray Tracing Gems denoising](https://developer.nvidia.com/blog/denoising-and-filtering-part-v-of-ray-tracing-gems/) · [oidn-webgpu](https://github.com/pissang/oidn-webgpu)
- Upscaling: [AMD FSR 3 (GPUOpen)](https://gpuopen.com/fidelityfx-super-resolution-3/) · [Temporal upscaling past/present/future](https://gpuopen.com/download/GDC-2023-Temporal-Upscaling.pdf)
- Culling / ray budgets: [Clustered Deferred and Forward Shading](https://www.cse.chalmers.se/~uffe/clustered_shading_preprint.pdf) · [Practical Clustered Shading](http://newq.net/dl/pub/SA2014Practical.pdf) · [COD MW4 variable-rate ray tracing](https://advances.realtimerendering.com/s2026/content/SIGGRAPH2026%20-%20Micha%C5%82%20Olejnik%20-%20Variable%20Rate%20Ray%20Tracing%20in%20COD%20MW4.pdf) · [Metro Exodus RT interview](https://www.digitalfoundry.net/articles/digitalfoundry-2019-metro-exodus-tech-interview)
- Browser: [pmndrs/denoiser](https://pmndrs.github.io/denoiser/) · [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) · [hush](https://github.com/kanaworksai-hue/hush)
- Color: [Blender 4.0 AgX default view transform](https://developer.blender.org/docs/release_notes/4.0/color_management/)
