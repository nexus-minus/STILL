# Render pipeline

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
        ├ 1 shadow ray       → correct, hard shadows ("the raytracing")
        └ 1-2 bounce rays    → emissive-lit indirect light (the glow-lighting)
[3] volumetrics (compute)   toggleable pass, quarter-res
        └ raymarch depth → density → shadow-ray per step → light shafts
[4] composite               upscale, bloom, ACES tonemap, grain/TAA
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

- `T` cycles tiers in-game (temporary until the settings menu, phase 1).
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
| volumetrics                | `render/passes/volumetrics.ts` | stub — phase 1b                 |
| chunk streaming            | `world/chunk-streaming.ts` | stub — phase 2                      |
| settings menu              | —                          | next: phase 1c                      |

### Phase 1a architecture (`render/rt.ts`)

- **compute** at `lightingScale` res: primary ray (`ndcToCameraRay` +
  `bvh_RaycastFirstHit`) → NEE over the emissive light list with
  `bvh_RaycastAnyHit` shadow rays → one cosine-hemisphere bounce, shaded at
  its hit → hemisphere ambient → storage texture.
  Mirrors the official three-mesh-bvh WebGPU path-tracing example exactly.
- **raster MRT** `{ output, diffuse, emissive }` (3 attachments,
  `maxColorAttachments: 4` requested) — flat albedo + HDR emissive.
- **composite**: `diffuse × lighting + emissive` selected against the beauty
  pass by a uniform flag (tier changes never rebuild the graph), then bloom.
- **lights**: emissive meshes in Blender (`L_*`) → light list (position,
  linear color, power), max 12, passed as individual uniform vec4 params.
- **safety**: construction failure → standard path + on-screen notice;
  WGSL validation error → `uncapturederror` hook disables the path once;
  black frames → existing detector → forced-WebGL reload.

Verification split: local tests prove the GL paths + all safety nets (green);
WebGPU pixel output needs real hardware (this machine's Chromium destroys its
Dawn instance in 4 ms and Firefox lacks WebGPU) — the boot line reports
`rt=armed|off`, and any shader error appears on screen and in the console.

## Perf targets

- Low (potato): 60 fps on integrated GPUs, everything playable.
- Medium: 60 fps on a mid-range GPU.
- The gigantic map: per-chunk BVHs, frustum culling, instancing, worker BVH
  builds — never one world-sized BVH on the main thread.
