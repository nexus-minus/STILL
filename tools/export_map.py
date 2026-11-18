"""Export every collection named Chunk_* to a Draco-compressed .glb + manifest.

Run via tools/export_map.sh:
    blender -b map.blend --python export_map.py -- --out /path/to/assets/map

Conventions: docs/blender-conventions.md
"""

import json
import os
import sys

import bpy
from mathutils import Vector


def parse_args():
    if "--" not in sys.argv:
        return {}
    args = sys.argv[sys.argv.index("--") + 1:]
    out = {}
    i = 0
    while i < len(args) - 1:
        if args[i] == "--out":
            out["out"] = args[i + 1]
            i += 2
        else:
            i += 1
    return out


def world_bounds(objects):
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    for obj in objects:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo.x, lo.y, lo.z = min(lo.x, world.x), min(lo.y, world.y), min(lo.z, world.z)
            hi.x, hi.y, hi.z = max(hi.x, world.x), max(hi.y, world.y), max(hi.z, world.z)
    return [list(lo), list(hi)]


def main():
    args = parse_args()
    out_dir = args.get("out", os.path.join(os.getcwd(), "assets", "map"))
    os.makedirs(out_dir, exist_ok=True)

    chunks = sorted(
        (c for c in bpy.data.collections if c.name.startswith("Chunk_")),
        key=lambda c: c.name,
    )
    if not chunks:
        print("export_map: no collections named Chunk_* found")
        return

    # Deselect everything, then select each chunk's objects in turn.
    bpy.ops.object.select_all(action="DESELECT")

    manifest = {"chunks": []}
    for coll in chunks:
        objects = list(coll.all_objects)
        if not objects:
            print(f"export_map: skipping empty collection {coll.name}")
            continue

        for obj in objects:
            obj.select_set(True)

        path = os.path.join(out_dir, f"{coll.name}.glb")
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_yup=True,
            export_materials="EXPORT",
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
        )
        size = os.path.getsize(path)
        print(f"export_map: {coll.name} -> {path} ({size // 1024} KB)")

        manifest["chunks"].append(
            {
                "name": coll.name,
                "file": f"{coll.name}.glb",
                "bounds": world_bounds(objects),
            }
        )

        for obj in objects:
            obj.select_set(False)

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"export_map: wrote {manifest_path} ({len(manifest['chunks'])} chunks)")


main()
