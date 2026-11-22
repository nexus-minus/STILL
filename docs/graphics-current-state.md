# Graphics as it currently works (paste-ready summary for review)

German text so the owner can read it themselves; paste it into any AI for an
opinion. Measurements are from `scripts/bake-stats.mjs` and
`scripts/banding-check.mjs`.

## 1. Stack and hosting

- Vite + TypeScript + Three.js (r187), built to static files, hosted on GitHub
  Pages (`nexus-minus/STILL`). No server, no paid services.
- **WebGPU compute** is the real path. Browsers expose **no hardware ray
  tracing API**, so every ray is software traversal against a `three-mesh-bvh`
  BVH. Any WebGPU failure falls back to **WebGL2** (forward rendering + bloom,
  no rays) by feature detection. Safety nets: startup watchdog,
  `uncapturederror` hook, black-frame detector, on-screen notices.
- Quality tiers: potato (WebGL2, 0.75 scale, 0 rays) · medium (quarter-res RT) ·
  high (half-res) · ultra (full-res).

## 2. One frame (WebGPU path)

```
[1] raster G-buffer    albedo (flat colors, no textures) + normal/depth + emissive mask
[2] lighting compute   per pixel at lightingScale:
       primary ray → BVH first hit
       shadow ray  → one random point on each mesh light's box surface (NEE)
       bounce ray  → 1 bounce; hitting an emissive surface = indirect glow
       AO ray      → short ray around the normal
       temporal    → blend with last frame (still = converge, moving = live)
[3] denoise            edge-aware à-trous, guided by normal + depth (4 iterations)
[4] fog (optional)     raymarched, dithered steps, 12 m light range; off = zero cost
[5] composite          diffuse × lighting + emissive + specular + baked term,
                       then fog (beauty·T + S) → bloom → AgX tone map
```

## 3. Lighting split (this is the core design)

- **Emissive geometry is the light source** — glowing meshes with Principled
  Emission. No Blender lamp objects. One mesh-light entry per fixture
  (center, half-extents, orientation, color, power, optional `cone_deg`), in an
  uncapped GPU storage buffer.
- **Static lighting is baked** by Cycles (`tools/bake_map.sh`): automatic UV2
  lightmap pack into one shared atlas, Combined bake, stored as **RGBM** PNG,
  re-exported glTF with `TEXCOORD_1`, manifest pointer.
- **Realtime rays only for things that change** (dynamic lights, animated
  objects, players). A per-light `baked` flag stops static fixtures from being
  lit twice; dynamic geometry is classified by having no `TEXCOORD_1`.
- The baked term is added **after** the albedo multiply (a Combined bake already
  contains albedo), decoded CPU-side once at load with K = π, so static and
  realtime share one brightness scale. Potato receives the bake through the
  forward emissive slot.

## 4. Player controller

Capsule physics with depenetration + substeps, walkable slopes ≤ 50°, validated
step-up (can never push through walls), momentum model (speed cap, descents
accelerate past it, jumps retain ≥ 85 %), coyote time + 100 ms input buffering,
no camera bob. Behind an e2e probe suite (33 checks).

## 5. Owner requirements (these are decisions, not suggestions)

1. **Noise must be practically invisible.** Not "denoised to acceptable", but
   below what the eye sees.
2. **A finished frame is kept.** If nothing changes, the same frame is reused —
   no recomputation. So idle cost should be zero.
3. **It must look like Cycles** (soft indirect light, color bleeding, area
   shadows, AgX roll-off), but stay playable.
4. **60 fps on consumer/gaming GPUs, and simple laptops must not be excluded**
   (that is what the WebGL2 tier is for).
5. **No visible seam between baked and realtime.** The player must not be able
   to tell which pixels came from the bake.
6. Flat materials only, no textures; UI is nearly nothing; interactions change
   the world, not a message.
7. Map authoring stays one `.blend` file with collections; the exporter must
   never require manual work (chunking, UVs, baking are all automatic).

## 6. Known problems (measured)

**Banding in the bake** — `scripts/banding-check.mjs` on the current 2048² atlas:
- 70.9 % of the atlas sits inside flat plateaus ≥ 8 px wide, and a plateau plus a
  1-LSB jump is exactly what reads as a band.
- In the dark range (luma 5–32) only **15 distinct levels** exist over the dark
  pixels; the RGBM multiplier channel spends 42 % of the atlas on value 0 (unused
  islands + black).
- One shared atlas for a map of ~163 × 88 × 35 m gives roughly 10–20 texels per
  meter. Playable quality usually wants 64–128 texels/m, so the low resolution the
  owner sees is mostly a **texel-density** problem, not only a bit-depth one.

**Other open items:**
- Temporal history resets on camera motion (no motion reprojection yet).
- The second bounce is requested by high/ultra but capped at 1 in `rt.ts`.
- Light-distance culling exists for fog, not yet for the surface loop.
- Dynamic objects (entities, players) have no light probes, so they cannot match
  the baked look; they need a realtime light + a shadow term.
- Single world-sized BVH built on the main thread at load; automatic chunk
  streaming is phase 2.
- Reflections are decided as raytraced per-material (roughness-gated), not
  screen-space; not implemented yet.

## 7. What we want an opinion on

1. Is "freeze the frame when nothing changes" the right pattern for a slow
   exploration game, and how do games that must stay realtime handle it?
2. What is the cheapest way to get a banding-free bake: blue-noise dithering, 10/16-bit
   storage, or per-chunk lightmap atlases with streaming (or all three)?
3. How do we make baked and realtime indistinguishable — bake incoming irradiance
   without albedo, light probes for moving objects, a separate dynamic-shadow term,
   and a soft coverage blend? Is there a better approach?
4. Given no hardware RT in browsers: what ray budget per pixel is realistic for
   60 fps on a mid-range GPU while keeping noise invisible?
