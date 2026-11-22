# Blender → liminal: how to author your world

Your `.blend` is the source of truth. Export with one command (Blender 5.2 is
installed on this machine — or just hand over the `.blend` file and I run it):

```sh
tools/export_map.sh path/to/map.blend
# -> assets/map/objects.glb, animated.glb, playermodels.glb,
#    manifest.json (bounds + checkpoints[] + sound[] + skipped[]
#                   + emissive{} + skippedEmissive[])
tools/export_map.sh --weld path/to/map.blend   # merge seam vertices first — see "Seams" below
tools/bake_map.sh path/to/map.blend            # export + bake the lightmap — see "Baking" below
```

## Collections (exact names)

| collection     | goes to                          | contents |
| -------------- | -------------------------------- | -------- |
| `objects`      | `objects.glb`                    | all static world geometry |
| `checkpoints`  | `checkpoints.glb` + manifest     | clickable objects — **empties are fine** (position comes from JSON) |
| `animated`     | `animated.glb` (+animation)      | objects that have actions — clips are exported with the file |
| `sound`        | `manifest.json → sound[]`        | Speaker objects (no mesh needed) → positional audio sources |
| `playermodels` | `playermodels.glb`               | selectable avatars — one object (mesh/armature) per model |

Any other top-level collection is **skipped and listed** in
`manifest.json → skipped`, so stray organizer collections are safe.

## The rules that matter

1. **Scale: 1 unit = 1 meter.** Player capsule is 1.7 m tall. ~3.2 m ceilings
   feels right (already used everywhere in the game).
2. **Flat materials only** — Principled BSDF, base color, no textures,
   roughness ≈ 0.9–1.0. Exactly your simple-material approach.
3. **Emission is light — this is the big one.** Light sources are *meshes with
   Emission enabled* (Principled → Emission Color + Strength). Name them
   `L_<something>`. The game's raytracer treats them exactly like Cycles
   treats emission: rays hit the surface and pick up its light, with real
   shadows. **Do not use Blender lamp objects** — they don't export as game
   lights. Start around emission strength 8–20 for ceiling panels.

   Optional custom property on a light fixture:

   | property | meaning | default |
   | -------- | ------- | ------- |
   | `cone_deg` | one-way cone (e.g. `120`) — the fixture lights only a cone of that opening. **Use on lights clipped through walls so they don't light the outside world.** Aim: fixture **+Z after export** (= Blender **−Y**) into the room; wrong way = rotate the fixture 180°. | omni |
4. **AgX everywhere.** The game now renders with AgX tonemapping — the same
   view transform Blender 4/5 uses by default — so your viewport look
   (Material Preview or Rendered with emission) transfers closely. With rule 3
   the lighting math is the same idea Cycles uses, so the vibe carries over;
   expect softer/dirtier real-time GI rather than path-traced perfection.
5. **Modifiers are applied at export** (`export_apply`) — model freely, the
   game receives the final geometry.

## The emission audit (every export prints it)

The exporter finishes by scanning the **whole file** for materials with
emission strength > 0 and reporting all three states:

1. **What exported** — one line per fixture:

   ```
   export_map:   light.001  collection=objects  file=objects.glb  dims 0.77 x 4.79 x 2.00 m  strength 5  color (1.00, 1.00, 1.00)
   ```

   **Read the dimensions.** The game derives light behavior from the fixture's
   world-space bounds — a 4.8 m strip and a 0.4 m cube are treated
   differently, so check the numbers here rather than eyeballing the
   viewport. `manifest.json → emissive.exported[]` carries the same data
   (`name`, `collection`, `file`, `dimensions`, `strength`, `color`).

2. **What didn't** — loud, and the usual answer to "why doesn't my light
   light anything?":

   ```
   export_map: EXPORT WARNING: L_dead_strip has emission but was NOT exported — put it in the 'objects' collection (in skipped collection 'reference')
   ```

   The object glows in Blender but reached no `.glb`: it's in a skipped
   collection, in no collection at all, hidden, or not a mesh. The game never
   sees it, so it emits nothing. The same entries land in
   `manifest.json → skippedEmissive[]` as `{name, collection, reason}` so
   tooling can surface them.

3. **A count check** — the scene's exported emissive objects must equal the
   emissive meshes actually found inside `objects.glb`. A mismatch prints
   another `EXPORT WARNING` (and `manifest.json → emissive` records both
   counts as `objectsGlb` / `objectsGlbVerified`).

An audit failure never blocks the export: the `.glb`s are already written by
then, and the traceback prints with the manifest still saved.

## Seams and light leaks: `--weld` (off by default)

**Bright lines along mesh edges in-game usually mean unwelded seams** — two
faces that touch visually but whose vertices are split, so light/shadow rays
slip through the gap (see `docs/backlog.md` item 5). The exporter can close
them at export time:

```sh
tools/export_map.sh --weld path/to/map.blend
# export_map: --weld objects.glb: 366 -> 362 vertices (4 merged in 1 meshes, eps 0.001 m)
```

- It runs Blender's *merge by distance* (0.001 m — 1 mm, below any real
  feature size) on every mesh right before the `.glb` is written, and prints
  the vertex delta per file so you can see exactly what changed.
- **Off by default.** Without the flag your geometry is never touched; the
  exporter never saves the `.blend` either way — only the export differs.
- Welding happens on the source meshes, **before** modifiers are evaluated.
  If a modifier (mirror, array) recreates the seam, fix it in Blender
  instead: Edit Mode → Merge by Distance on the final geometry.
- **A/B it** by exporting both ways and swapping the winner into
  `assets/map` (the only place the game reads), checking seams with
  `?rtdebug=2` — ray misses (void/seam holes) are painted **red**:

  ```sh
  tools/export_map.sh assets/source/map.blend                                # plain
  OUT_DIR=/tmp/map-weld tools/export_map.sh --weld assets/source/map.blend   # welded
  cp /tmp/map-weld/objects.glb assets/map/objects.glb                        # try it
  ```

## Baking — the automatic lightmap (same philosophy as `--weld`)

`tools/bake_map.sh` is the export **plus** a Cycles bake of the scene's
static lighting, in one headless Blender run — you never open Blender for
it, and (like every export here) the `.blend` is never saved:

```sh
tools/bake_map.sh path/to/map.blend
# -> everything tools/export_map.sh writes, plus:
#    lightmap.png        Cycles Combined bake of the static lighting
#    objects.glb         re-exported with a second UV set (glTF TEXCOORD_1)
#    manifest.json       + additive "lightmap" {file, resolution, uv}
tools/bake_map.sh --samples 128 --resolution 4096 path/to/map.blend   # tune
tools/bake_map.sh --dither-ab path/to/map.blend  # writes BOTH variants in one bake
tools/export_map.sh --bake path/to/map.blend    # same thing (export + bake)
```

Dither flags (the anti-banding work, 2026-11-22):

- `--dither` — blue-noise ordered dither on the 8-bit encode. **ON by default**, so
  a normal run already has it.
- `--no-dither` — plain rounding, only for the comparison.
- `--dither-ab` — writes both variants from the SAME linear buffer in one run, so the
  two numbers are the same values quantized two ways (otherwise Cycles' own noise
  makes the comparison meaningless). Report: distinct levels, longest flat run, % of
  the lit area inside runs ≥ 8 px, 8×8 block-average error.

**Re-run it after ANY map/light/material change** — a moved wall, a new
fixture, a tweaked emission strength, a changed base color. The bake is cheap
(~6 s GPU at the default 2048²/64 samples on this machine), fully automatic,
and always consistent with the `.blend`, exactly like `--weld`: when in doubt,
re-bake. Never hand-edit `lightmap.png` or the lightmap UVs — the `.blend`
is the only source of truth.

What one run does:

1. **Second UV layer, generated for you.** Every exported mesh gets a
   `LightMap` UV layer packed by Blender's *lightmap pack* — all meshes share
   one atlas (smart UV project packs per object, which would make the meshes
   overwrite each other in the single shared image). Islands are spaced
   ≥32 px apart (2× the bake margin) so filtering can't bleed across them.
   **UV1 is never touched** — the run verifies it byte-for-byte and refuses
   to ship if packing ever changes it.
2. **Cycles Combined bake** of the scene's static lighting onto that layer.
   Combined (not Diffuse) is deliberate: emissive fixtures bake bright, so a
   glowing panel is white in the lightmap — which is what the renderer wants.
   Default 64 samples, 16 px margin, resolution 2048 (override with
   `--samples` / `--resolution`).
3. **`lightmap.png`** written next to the other outputs — **RGBM** (both
   channels sRGB-encoded: `rgb = srgb(linear/m)`, `alpha = srgb(m/range)`)
   because a plain 8-bit sRGB bake clipped 1.59 % of texels above 1.0 under
   AgX (measured: max radiance 6.6, display error up to 0.177) — RGBM keeps
   the full highlight range with a worst-case round-trip error of 0.77 %. The encode is dithered (blue noise — see the flags above): plain
    rounding puts the error on the plateau boundary, which is the line the eye reads as a
    band; dithering moves that error into an even scatter. It does NOT add information —
    plain rounding still measures slightly more accurate, and that is stated on purpose:
    dithering is a perceptual fix, not a correctness fix. Every run prints the banding
    report for the atlas: distinct luma levels, longest flat run, share of the lit area
    inside runs ≥ 8 px, and the 8×8 block-average error against the linear values (black
    is skipped — it has no gradient to band).

    Every run also prints a **brightness report per UV island**, so you can see which
    light is too strong without opening Blender:

    - **Fixture islands** (island mean ≥ 0.45 display luma) are listed as numbers only.
      Bright there is expected — that's the emitting surface itself, and Combined bake
      deliberately keeps it white.
    - **Receiving surfaces** warn when they read blown out: mean ≥ 0.70, or max ≥ 0.985,
      over at least 40 grid cells. Those are the surfaces a light is landing on, and a
      warning means "check this fixture's strength in Blender".

    It measures, it does not judge taste — it only names the island that sits in the
    clipped range. Like the audit, a warning never blocks the bake (the PNG is written by
    then). Islands are matched to their object through the bake's owner grid, so a bright
    lamp and a blown-out wall never get mixed up.
4. **`objects.glb` re-exported** so glTF carries the second UV set as
   **`TEXCOORD_1`**, and **`manifest.json`** gains the additive block:

   ```json
   "lightmap": { "file": "lightmap.png", "resolution": 2048, "uv": "TEXCOORD_1",
                 "encoding": "rgbm", "range": 6.598 }
   ```

   Additive keys — the loader ignores unknown manifest fields today.

### TEXCOORD_1 contract (for the renderer)

- `objects.glb` primitives now carry **two** UV sets: `TEXCOORD_0` is your
  original `UVMap` (byte-identical to a plain export — the bake proves it),
  `TEXCOORD_1` is the lightmap atlas.
- `manifest.json → lightmap` is the pointer: which PNG, its square
  resolution, which TEXCOORD indexes it, the `encoding` and the RGBM
  `range`. Decode **CPU-side once at load** — `m = srgb⁻¹(alpha) × range`,
  `linear = srgb⁻¹(rgb) × m` → a linear half-float texture — and sample it
  with `TEXCOORD_1`. The renderer applies its one brightness scale (K=π,
  matching the game's no-Lambert convention) during that decode, so static
  and realtime lighting share a single scale.
- The bake only covers static `objects` geometry (the lightmap's consumer);
  animated/playermodels keep a single UV set — they move, so baked static
  lighting doesn't apply to them (backlog #9: static for static, realtime
  for dynamic).

## Collection specifics

### checkpoints (client-side clickables)

Empties or meshes, with custom properties:

| property | meaning | default |
| -------- | ------- | ------- |
| `label`  | text shown to the player | object name |
| `kind`   | `respawn` (fast-travel point), `interact`, or **`spawn` (the fixed start position)** | `respawn` |
| `radius` | interaction sphere radius (m) | 1.2 |

**Always author a `kind = "spawn"` checkpoint** at your intended start point —
without it the game raycasts down from above the bounds centre and picks
*some* floor (on multi-level maps that may be a roof or a ledge).

**Checkpoint objects carry two materials:**

1. **`check_off`** — the material the object wears until activated
2. **`check_on`** — swapped in the moment the player clicks it

**Checkpoint animation:** if the object has an action named **`check_active`**,
it plays **once** when clicked and **never reverts** (no looping back).

**⚠ Client-side rule:** checkpoints are *personal state*. When another player
activates a checkpoint, it changes **only for them** — your copy keeps
`check_off` unless you clicked it yourself. (No network sync for these, ever.)

### animated — animation naming rules

| name pattern | behavior |
| ------------ | -------- |
| starts with `looping_` | plays automatically, loops forever (ambient machinery, flicker, …) |
| `check_active` | special: checkpoint click reaction (see above) |
| anything else | **proposal** (confirm/edit): plays **once when interacted with**; if you want another behavior category, invent a prefix (`interact_`, `proximity_`, …) and add it here |

All animation **rules live in this file — it is the contract** the loader
implements. When you add a prefix, write it here first.

### sound — 3D positional audio

**Yes — use Blender's Speaker object** for placement; it's exactly what the
pipeline expects (custom properties `file`, `loop`, `radius`, `volume`; see
table above). Speakers have no mesh, so they export as JSON positions only.

### playermodels — rigs and visibility

- One object (mesh + **rig/armature**) per model in the collection.
- Animation names follow the same naming rules; the rig's actions export with
  the model and drive it in-game.
- **Visibility rules (game-side):**
  - the model is visible **to other players** and **in mirrors**;
  - there is **no first-person body** — you never see your own model while
    playing (no arms/feet) — mirrors are the only self-view.
  - Selector UI comes with the multiplayer work.

### where the .blend lives

`assets/source/map.blend` (create the `source` folder). It gets exported via
`tools/export_map.sh assets/source/map.blend`. If it grows huge (>100 MB) we
switch it to Git LFS or keep it out of the repo — tell me the size and we'll
decide.

### which collections?

Those **five** are all you need (`objects`, `checkpoints`, `animated`,
`sound`, `playermodels`). Sub-collections *inside* them are fine (they export
with the parent). Other top-level collections are ignored but listed in
`manifest.json → skipped`, so organizational leftovers won't break anything.

## Size budget

Aim for `objects.glb` under ~15 MB (Draco-compressed) / ~800k triangles.
Beyond that we switch to spatial chunk streaming (phase 2) — tell me the
numbers and I'll wire it before it becomes a problem.

## Export output

```
assets/map/objects.glb          static geometry (Draco, +Y up, world coords)
assets/map/animated.glb         animated objects + clips
assets/map/playermodels.glb     avatars
assets/map/manifest.json        per-collection counts + world bounds,
                                checkpoints[], sound[], skipped[],
                                emissive{} (exported fixtures + counts),
                                skippedEmissive[] (glows that exported nothing),
                                lightmap{} (from tools/bake_map.sh only)
assets/map/lightmap.png         baked static lightmap (tools/bake_map.sh only)
```
