# Map chunks go here

Served as the site root by Vite (`publicDir: 'assets'`):

    assets/map/Chunk_room_a.glb  ->  /map/Chunk_room_a.glb
    assets/map/manifest.json     ->  /map/manifest.json

Produce them with `tools/export_map.sh your-map.blend`
(conventions: `docs/blender-conventions.md`).

Until phase 2 the game runs on the procedural test room instead —
this folder can stay empty.
