"""Export a liminal .blend into the game's asset layout (Blender CLI).

    tools/export_map.sh path/to/map.blend
    # = blender -b map.blend --python tools/export_map.py -- --out <assets/map>

Collection scheme (see docs/blender-conventions.md):

    objects      -> objects.glb              static world geometry
    checkpoints  -> checkpoints.glb (if meshes) + manifest.checkpoints[]
    animated     -> animated.glb             objects with actions (+ animation)
    sound        -> manifest.sound[]         speaker objects -> 3D audio sources
    playermodels -> playermodels.glb         selectable avatars (one root each)

Any other top-level collection is listed in manifest.json under "skipped".
"""

import json
import os
import sys

import bpy

MESH_EXPORTS = [
    # (collection, output file, export animations)
    ("objects", "objects.glb", False),
    ("checkpoints", "checkpoints.glb", False),
    ("animated", "animated.glb", True),
    ("playermodels", "playermodels.glb", False),
]
KNOWN = {name for name, _, _ in MESH_EXPORTS} | {"sound"}


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


def world_position(obj):
    return [round(v, 5) for v in obj.matrix_world.translation]


def world_bounds(objects):
    from mathutils import Vector

    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    has = False
    for obj in objects:
        if not hasattr(obj, "bound_box"):
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo.x, lo.y, lo.z = min(lo.x, world.x), min(lo.y, world.y), min(lo.z, world.z)
            hi.x, hi.y, hi.z = max(hi.x, world.x), max(hi.y, world.y), max(hi.z, world.z)
            has = True
    return [list(lo), list(hi)] if has else None


def select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)


def export_glb(objects, path, animations):
    mesh_objects = [o for o in objects if o.type in {"MESH", "CURVE", "SURFACE", "FONT", "ARMATURE"}]
    if not mesh_objects:
        print(f"export_map: {os.path.basename(path)} skipped (no mesh objects)")
        return False, []
    select_only(mesh_objects)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_animations=animations,
    )
    size = os.path.getsize(path)
    print(f"export_map: {os.path.basename(path)} ({len(mesh_objects)} objects, {size // 1024} KB)")
    return True, mesh_objects


def export_sound(sound_collection):
    """Speakers carry no mesh — they become a JSON list of positional sources.

    Speaker convention: custom props file / loop / radius / volume (the Blender
    speaker datablock's own sound+volume are used as fallback).
    """
    sounds = []
    for obj in sound_collection.all_objects:
        file_prop = obj.get("file", "")
        data_sound = getattr(obj.data, "sound", None) if obj.type == "SPEAKER" else None
        file_path = file_prop or (data_sound.filepath if data_sound else "")
        sounds.append(
            {
                "name": obj.name,
                "position": world_position(obj),
                "file": os.path.basename(file_path.replace("//", "")) if file_path else "",
                "loop": bool(obj.get("loop", True)),
                "radius": float(obj.get("radius", 14)),
                "volume": float(obj.get("volume", getattr(obj.data, "volume", 1.0) if obj.type == "SPEAKER" else 1.0)),
            }
        )
    print(f"export_map: sound.json ({len(sounds)} sources)")
    return sounds


def export_checkpoint_info(checkpoint_collection):
    entries = []
    for obj in checkpoint_collection.all_objects:
        entries.append(
            {
                "name": obj.name,
                "position": world_position(obj),
                "label": str(obj.get("label", obj.name)),
                "kind": str(obj.get("kind", "respawn")),  # respawn | interact
                "radius": float(obj.get("radius", 1.2)),
            }
        )
    print(f"export_map: checkpoints.json ({len(entries)} checkpoints)")
    return entries


def main():
    args = parse_args()
    out_dir = args.get("out", os.path.join(os.getcwd(), "assets", "map"))
    os.makedirs(out_dir, exist_ok=True)

    manifest = {"collections": {}, "checkpoints": [], "sound": [], "skipped": []}
    bpy.ops.object.select_all(action="DESELECT")

    # ---- mesh collections -------------------------------------------------
    for cname, fname, animations in MESH_EXPORTS:
        coll = bpy.data.collections.get(cname)
        if coll is None:
            manifest["collections"][cname] = {"missing": True}
            print(f"export_map: collection '{cname}' not found (skipped)")
            continue
        objects = list(coll.all_objects)
        ok, exported = export_glb(objects, os.path.join(out_dir, fname), animations)
        manifest["collections"][cname] = {
            "file": fname if ok else None,
            "count": len(objects),
            "bounds": world_bounds(exported),
        }

    # ---- checkpoint + sound side channels ---------------------------------
    ck_coll = bpy.data.collections.get("checkpoints")
    if ck_coll is not None:
        manifest["checkpoints"] = export_checkpoint_info(ck_coll)

    snd_coll = bpy.data.collections.get("sound")
    if snd_coll is not None:
        manifest["sound"] = export_sound(snd_coll)

    # ---- anything else ------------------------------------------------------
    for coll in bpy.data.collections:
        if coll.name not in KNOWN:
            manifest["skipped"].append(coll.name)
            print(f"export_map: WARNING unknown top-level collection '{coll.name}' (not exported)")

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"export_map: wrote {manifest_path}")


main()
