# How this game works — plain English

For the project owner: every moving part, where problems come from, and what
to touch when. Companion to [render-pipeline.md](render-pipeline.md) (deep
dive) and [denoising.md](denoising.md) (noise deep dive).

## 1. Boot and backends

- Vite + TypeScript + Three.js (r187). Builds to static files — hostable on
  GitHub Pages with zero server code.
- **WebGPU** is the real path: custom compute shaders trace the rays.
- Any WebGPU failure falls back automatically to **WebGL2** (forward
  rendering + bloom, no traced rays) — feature detection, not device
  sniffing. Safety nets, in order: startup watchdog, `uncapturederror` hook
  (one WGSL error disables the traced path, never the game), black-frame
  detector (forces WebGL reload), on-screen notices for all of it.
- **Quality tiers**: potato (WebGL2, 0.75 scale) · medium (RT at
  quarter-res) · high (half-res) · ultra (full-res). Settings menu →
  Graphics picks the preset; overrides mark rows "custom".

## 2. One frame (WebGPU path)

```
[1] raster G-buffer      flat albedo color + emissive mask
                         (emissive mask = your glowing objects)
[2] RT lighting compute  per pixel, at tier resolution:
     primary ray   → BVH (three-mesh-bvh) → first hit, normal, distance
     shadow ray    → one random point on EACH light's box surface (NEE)
     bounce ray    → one bounce; a hit on emissive = indirect glow
     AO ray        → one short ray around the normal
     temporal      → blend with last frame (still = converges clean,
                     moving = live frame)
[3] denoise            edge-aware à-trous filter (kills motion noise AND
                         light bleeding across edges)
[4] fog (optional)     raymarched at volumetricScale over geomTex →
                         transmittance + light shafts; off = zero cost
[5] composite          diffuse × lighting + specular + emissive, then
                         fog (beauty·T + S) → bloom → AgX tone map
```

Debug views: `?rtdebug=1` uv gradient · `2` visibility (bright green = lit,
dark green = shadow, red = ray missed the map → a hole/seam) · `3` raw
lighting buffer.

## 3. Lights — your emissive geometry IS the source

- You place glowing objects in Blender with **Principled BSDF → Emission
  Color + Emission Strength**. The exporter's **emissive audit** lists every
  fixture (world dimensions, strength, color) and loudly warns about
  emissive objects that were NOT exported (wrong collection etc.).
- The loader creates **one mesh light per fixture** — no point-light
  proxies. Each frame each pixel picks a random point **on the fixture's
  box surface** (respecting its rotation) and casts one shadow ray to it:
  continuous fixture-shaped shadows, no dot trains, and an object clipped
  into the floor still lights the room from its exposed faces.
- **No cap**: all lights live in a GPU storage buffer (thousands fit;
  beyond the GPU limit it fails loudly instead of silently dropping).
- `lightGain` slider scales everything; light-distance culling is queued so
  far-away lights cost nothing per pixel.
- The `/pathtrace.html` page is a separate, true progressive path tracer
  (three-gpu-pathtracer) kept only as an A/B reference for lighting look —
  it is NOT the game renderer (see §8).

## 4. Movement

- Capsule physics with depenetration + substeps (no tunnelling).
- Slopes walkable up to **50°**; anything steeper is a wall. Step-up
  triggers only for >50° faces, fires on the contact frame, validates the
  destination (capsule fit + headroom + floor) so it can never push you
  through walls or out of the map. Camera eases over the step height
  (physics stays instant).
- **Momentum model**: smooth exponential speed cap (sprint), descents
  accelerate *past* the cap via tangential gravity, momentum carries
  through jumps (≥85% retained), excess speed decays over ~1–2 s instead
  of snapping. Jump impulse adds to current vertical velocity. No walk
  bob — the view is steady. No parkour: walk / sprint / jump / step-up
  only, tuned for slow exploration.
- Known/deferred: user-reported jump edge cases (see backlog).

## 5. World pipeline (your authoring loop)

```
Blender (collections: objects, checkpoints, animated, sound, playermodels)
   ↓  tools/export_map.sh path/to/map.blend   [--weld]
objects.glb + manifest.json  (+ emissive audit printed, skippedEmissive[])
   ↓  in-game loader
BVH build (once, at load — main thread today; worker + per-chunk is the
documented phase-2 target), light list, spawn probe, checkpoints, sound
```

- **You never split the map manually.** Chunking/culling is engine-side and
  automatic whenever it lands; your export command and collections never
  change. (详见 §7.)
- `--weld` (optional) merges coincident vertices to close light-leaking
  seams. `?rtdebug=2` shows seam holes as **red**.
- Blender rules live in [blender-conventions.md](blender-conventions.md).

## 6. UI, input, interaction contract

- Default screen: **game + crosshair dot, nothing else**. Optional overlays
  (key hints, toasts) are opt-in in Settings; coords/FPS are dev-only
  (`?dev=1`). Start screen is intentionally minimal.
- Keybinds: WASD move, mouse look, E interact, Space jump, Shift run,
  M map — rebindable in Settings (dev keys work but aren't listed).
- **Interaction contract: the world reacts, no UI feedback.** Toasts are
  off by default, so every E-interaction must visibly change the world
  (checkpoint changes color, door opens, light shifts). If you author an
  interaction whose only feedback was a message, give it a world reaction.

## 7. Performance model — where the frames go

Cost per lighting pixel ≈ 1 primary ray + (lights × 1 shadow ray) + 1
bounce + 1 AO ray, all against the BVH. So:

- **Resolution is the biggest lever** (that's what the tiers scale) — this
  is why medium = quarter-res and still looks right after denoising.
- **Lights are the second lever** — hence mesh-light sampling cut shadow
  rays 36→4/pixel (ultra went 43→60 fps), and light-distance culling is
  next.
- **Raster and BVH**: three.js already skips geometry outside the camera
  frustum for raster; rays only travel short distances (shadow → light,
  bounce 1, AO 0.6 m), so off-screen geometry barely participates. What
  *does* grow with map size: BVH build time + memory at load → that's what
  automatic chunking solves later (unload distant chunks, per-chunk BVHs,
  per-chunk light lists via the existing `setLights()` hook).

## 8. Why raytracing doesn't "just work" like other game engines

1. **Browsers expose no hardware raytracing.** Desktop engines (Unreal,
   Unity, DXR games) run rays on RT cores — dedicated silicon, orders of
   magnitude faster. In the browser, WebGPU gives us compute shaders, so
   the same math runs as software: real rays, but we must spend them
   carefully (quarter-res, few bounces, temporal reuse, denoising).
2. **The "clean 60fps" games are all cheating the same ways** we are
   adopting: baked static lighting, screen-space tricks for the low tier,
   denoisers on every frame, upscaling, light culling, probes. AAA RT games
   denoise every frame and render below native resolution too.
3. **Our own progressive path tracer** (`/pathtrace.html`, the library the
   advice below recommends) proves the point: gorgeous when still, grainy
   when moving — because progressive tracing resets on camera movement. It
   is kept as a lighting-reference tool, not as the game renderer, for
   exactly that reason (plus: its own docs call the WebGPU API unstable,
   and it can't integrate with our tier/G-buffer/fallback system).

In short: the *technology* is the same as other engines; the gap is
hardware RT (absent in browsers) and infrastructure we're actively
building (denoise now, baked GI next, chunking later). None of it requires
a different engine.

## 9. Research receipts — the pasted advice, checked against this repo

| Advice point | Status here |
| --- | --- |
| Three.js + static hosting (GitHub Pages) | ✅ built in — Vite → static files; a deploy workflow is the one missing piece (offer pending) |
| Use `three-gpu-pathtracer` for true path tracing | ✅ already integrated — as the `/pathtrace.html` A/B reference; deliberately not the game renderer (§8.3) |
| SSGI (`realism-effects`) for gameplay | ❌ not adopted: screen-space GI can only see pixels already on screen — it cannot light a room through a doorway you can't see, and leaks at screen edges. Our WebGL2 fallback tier is the "runs on any PC" path; an SSGI-style effect remains a possible potato-tier experiment, not the main path |
| WebGL path-tracing plugin | ❌ WebGL2 has no usable compute path — this is why WebGPU exists in the stack and WebGL2 gets the forward fallback |
| Bake static lights, RT only for dynamic | ✅ exactly the documented production plan (render-pipeline.md → "Recommended production split") |
| Simple geometry, clean colors | ✅ your aesthetic (`reference/`) and the flat-color G-buffer by design |
| Limit light distance/decay | 🔜 queued — light-distance culling in the shader |
| Grainy when moving / needs a strong GPU | ✅ diagnosed and planned: temporal + edge-aware denoise (in progress), tiered resolution, measured perf (ultra locked 60 fps after mesh lights) |
| "Don't write your own raytracer" | ✅ we didn't from scratch — three-mesh-bvh does BVH traversal; the custom part is the lighting integration around it (G-buffer, tiers, mesh lights, fallback) |

## 10. Roadmap to "engine ready"

- **Landed**: edge-aware denoiser; per-object color + Principled
  roughness gloss (per-vertex roughness in the BVH + specular buffer);
  volumetrics/fog phase 1b; coyote time + jump buffering; bake tooling
  (Blender side); GitHub Pages deploy (`.github/workflows/deploy.yml` +
  `docs/deploy.md`).
- **In flight**: fog floor-anchor fix (user bug: haze keyed to world y=0
  instead of the level floor).
- **Queued**: raytraced reflections (#12 — its roughness batch now
  exists); bake consumption with the user's two rules (#9: no
  double-lighting, RGBM/HDR if sRGB clips under AgX); surface-loop
  light-distance culling; jump-bug pass (#6, awaiting repros); automatic
  chunk streaming (#8). Deferred with recorded triggers: Rapier (#10),
  multiplayer via PeerJS (#11).
- **Yours**: build the level (export audit guards you), author materials
  with Principled emission/roughness, small optimizations.
