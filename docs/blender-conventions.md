# Blender → liminal: how to author your world

Your `.blend` is the source of truth. Export with one command (Blender 5.2 is
installed on this machine — or just hand over the `.blend` file and I run it):

```sh
tools/export_map.sh path/to/map.blend
# -> assets/map/objects.glb, animated.glb, playermodels.glb,
#    manifest.json (bounds + checkpoints[] + sound[] + skipped[])
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
4. **AgX everywhere.** The game now renders with AgX tonemapping — the same
   view transform Blender 4/5 uses by default — so your viewport look
   (Material Preview or Rendered with emission) transfers closely. With rule 3
   the lighting math is the same idea Cycles uses, so the vibe carries over;
   expect softer/dirtier real-time GI rather than path-traced perfection.
5. **Modifiers are applied at export** (`export_apply`) — model freely, the
   game receives the final geometry.

## Collection specifics

**checkpoints** — empties (or meshes) with custom properties:

| property | meaning | default |
| -------- | ------- | ------- |
| `label`  | text shown to the player | object name |
| `kind`   | `respawn` (fast-travel point) or `interact` | `respawn` |
| `radius` | interaction sphere radius (m) | 1.2 |

**animated** — just give objects actions while they're in this collection;
they export with animation and the game plays the clips (loader work lands
with phase 2/3).

**sound** — Speaker objects with custom properties:

| property | meaning | default |
| -------- | ------- | ------- |
| `file`   | audio filename, e.g. `hum_loop.ogg` | speaker's sound datablock |
| `loop`   | loop forever | `true` |
| `radius` | audible distance (m) | 14 |
| `volume` | gain | speaker volume |

Audio files go in `assets/audio/` and the game plays them as **3D positional
sound** (Web Audio panners follow the listener). The audio system itself is
scheduled next (with volumetrics).

**playermodels** — put each avatar in the collection; a selector UI comes
with the multiplayer work.

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
                                checkpoints[], sound[], skipped[]
```
