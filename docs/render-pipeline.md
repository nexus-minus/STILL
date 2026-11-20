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
- The temporal history currently resets on camera motion; it improves
  stationary screenshots, but is not a motion-reprojected denoiser.

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
- **composite**: `diffuse × lighting + emissive` selected against the beauty
  pass by a uniform flag (tier changes never rebuild the graph), then bloom.
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

## Perf targets

- Low (potato): 60 fps on integrated GPUs, everything playable.
- Medium: 60 fps on a mid-range GPU.
- The gigantic map: per-chunk BVHs, frustum culling, instancing, worker BVH
  builds — never one world-sized BVH on the main thread.
