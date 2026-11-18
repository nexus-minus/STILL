# Blender → game conventions

The export script (`tools/export_map.sh`) and the loader (phase 2) both rely
on these rules. Follow them and the map just works.

## General

- **Scale:** 1 unit = 1 meter. Player capsule is 1.7 m tall, 0.35 m radius.
- **Ceilings:** ~3.2 m (already used by the test room).
- **Materials:** flat default colors only — base color, **no textures**, roughness
  0.9–1.0. Exactly the simple design in the brief.
- **Triangles:** aim ≤ 150k per chunk, ≤ ~5 MB after Draco. Box-heavy geometry
  compresses extremely well.

## Collections = chunks

- Every top-level collection named **`Chunk_<name>`** exports to its own
  `assets/map/Chunk_<name>.glb`.
- Keep each chunk a contiguous play area (~30–60 m). The loader streams by
  distance, so neighbors should connect across shared edges.
- **Leave objects in world coordinates** (don't move them to a per-chunk
  origin). Chunks then assemble with identity transforms — simplest possible
  stitching, and per-chunk BVHs stay in world space.
- Everything inside a chunk belongs to that collection (or its children).

## Lights: emission on meshes, not Blender lights

The renderer treats **emissive geometry as the actual light source** (rays hit
it and pick up its emission). Therefore:

- Light sources = **meshes with Emission enabled** (e.g. ceiling panels).
  Set Emission color + strength (start around 8–30; tune by eye).
- Name anything that glows **`L_<something>`** so tooling can spot it fast.
- Blender *light objects* (point/area) do **not** export as geometry —
  don't use them for anything the raytracing needs to see.
- The game ships with a WebGL2/potato fallback that approximates this
  (a few analytic lights), so also keep light placement regular
  (grid-ish) — it makes the fallback look right too.

## Custom properties (object level)

| Property   | Type   | Meaning                                                        |
| ---------- | ------ | -------------------------------------------------------------- |
| `respawn`  | string | Interactive respawn anchor/beacon. Value = label shown to player. |
| `lore`     | string | Proximity trigger for a story/rules fragment. Value = lore id (e.g. `RULE-004`). |
| `interact` | string | Generic interactable (door, switch). Value = kind.             |
| `noCollide`| any    | Present = visual only, excluded from collision.                |

## Naming conventions

| Prefix / pattern | Meaning                                   |
| ---------------- | ----------------------------------------- |
| `Chunk_<name>`   | collection → one .glb export              |
| `L_<name>`       | emissive light surface                    |
| `V_<name>`       | visual-only, no collision                 |

## Export (CLI)

```sh
tools/export_map.sh path/to/map.blend
# writes assets/map/*.glb + assets/map/manifest.json
```

Equivalent manual settings: glTF **Binary (.glb)**, +Y up, apply modifiers,
selected collections only, **Draco compression on** (level 6).

## Manifest

The script writes `manifest.json` (chunk names + world AABBs). The phase-2
streamer loads it first to decide what to fetch around the player.
