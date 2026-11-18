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

### checkpoints (client-side clickables)

Empties or meshes, with custom properties:

| property | meaning | default |
| -------- | ------- | ------- |
| `label`  | text shown to the player | object name |
| `kind`   | `respawn` (fast-travel point) or `interact` | `respawn` |
| `radius` | interaction sphere radius (m) | 1.2 |

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
                                checkpoints[], sound[], skipped[]
```
