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

Every run ends with an emissive audit: the whole file is scanned for materials
with emission strength > 0 and each one is reported — exported fixtures with
their world-space dimensions (the loader sizes lights from them), unexported
ones with a loud EXPORT WARNING plus a manifest "skippedEmissive" entry, and a
count check against what actually landed in objects.glb.

Pass --weld to merge coincident vertices (0.001 m) before writing — off by
default so geometry is never changed unless the author asks for it.
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

# --weld: merge vertices closer than this before writing (Blender's
# "merge by distance"). 1 mm — closes authoring seams without touching any
# real feature. Only ever runs when the author passes --weld.
WELD_EPSILON = 0.001
_WELDED_MESHES = set()  # mesh datablock names already welded (linked objects share data)
_TOP_OF = None  # collection name -> top-level ancestor, built lazily by top_level_collections()


def parse_args():
    """Everything after the `--` separator: --out <dir> and optional --weld."""
    if "--" not in sys.argv:
        return {}
    args = sys.argv[sys.argv.index("--") + 1:]
    out = {"weld": False}
    i = 0
    while i < len(args):
        if args[i] == "--out" and i + 1 < len(args):
            out["out"] = args[i + 1]
            i += 2
        else:
            if args[i] == "--weld":
                out["weld"] = True
            i += 1
    return out


def world_position(obj):
    return [round(v, 5) for v in obj.matrix_world.translation]


def object_world_extents(obj):
    """World-space AABB of one object (bound-box corners through matrix_world)."""
    from mathutils import Vector

    if not hasattr(obj, "bound_box"):
        return None
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    for corner in obj.bound_box:
        world = obj.matrix_world @ Vector(corner)
        lo.x, lo.y, lo.z = min(lo.x, world.x), min(lo.y, world.y), min(lo.z, world.z)
        hi.x, hi.y, hi.z = max(hi.x, world.x), max(hi.y, world.y), max(hi.z, world.z)
    return lo, hi


def world_dimensions(obj):
    """World-space size (x, y, z) in meters — what the loader sees for a light."""
    extents = object_world_extents(obj)
    if extents is None:
        return None
    lo, hi = extents
    return [round(hi[i] - lo[i], 3) for i in range(3)]


def world_bounds(objects):
    from mathutils import Vector

    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    has = False
    for obj in objects:
        extents = object_world_extents(obj)
        if extents is None:
            continue
        o_lo, o_hi = extents
        lo.x, lo.y, lo.z = min(lo.x, o_lo.x), min(lo.y, o_lo.y), min(lo.z, o_lo.z)
        hi.x, hi.y, hi.z = max(hi.x, o_hi.x), max(hi.y, o_hi.y), max(hi.z, o_hi.z)
        has = True
    return [list(lo), list(hi)] if has else None


def select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)


def weld_meshes(mesh_objects):
    """Merge coincident vertices (bmesh remove_doubles) on the source meshes.

    Off by default: the .blend is never saved, but the exported .glb differs,
    so geometry only changes when the author opts in with --weld (light leaks
    through unwelded seams — docs/backlog.md #5). Runs BEFORE modifiers are
    evaluated at export, so a mirror/array can recreate the seam afterwards;
    those cases need a merge-by-distance in Blender on the final geometry.
    Returns (verts before, verts after, meshes merged, non-mesh objects seen).
    """
    import bmesh

    before_total = after_total = 0
    merged_meshes = 0
    non_mesh = 0
    for obj in mesh_objects:
        if obj.type != "MESH" or obj.data is None:
            non_mesh += 1
            continue
        data = obj.data
        if data.name in _WELDED_MESHES:
            continue
        _WELDED_MESHES.add(data.name)
        bm = bmesh.new()
        bm.from_mesh(data)
        before = len(bm.verts)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=WELD_EPSILON)
        after = len(bm.verts)
        if after != before:
            bm.to_mesh(data)
            data.update()
            merged_meshes += 1
        bm.free()
        before_total += before
        after_total += after
    return before_total, after_total, merged_meshes, non_mesh


def export_glb(objects, path, animations, weld=False):
    mesh_objects = [o for o in objects if o.type in {"MESH", "CURVE", "SURFACE", "FONT", "ARMATURE"}]
    if not mesh_objects:
        print(f"export_map: {os.path.basename(path)} skipped (no mesh objects)")
        return False, []
    if weld:
        before, after, merged, non_mesh = weld_meshes(mesh_objects)
        if after != before:
            print(
                f"export_map: --weld {os.path.basename(path)}: {before} -> {after} vertices "
                f"({before - after} merged in {merged} meshes, eps {WELD_EPSILON} m)"
            )
        else:
            print(f"export_map: --weld {os.path.basename(path)}: nothing to merge ({before} vertices, eps {WELD_EPSILON} m)")
        if non_mesh:
            print(f"export_map: --weld: {non_mesh} non-mesh objects (curves/fonts/armatures) left unwelded")
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


def material_emission(mat):
    """(rgb color, strength) if the material emits light, else None.

    Covers the two shapes emission takes in Blender: Principled BSDF's
    Emission Color + Strength inputs, and a standalone Emission node.
    """
    if mat is None:
        return None
    tree = getattr(mat, "node_tree", None)
    if tree is None:
        return None
    for node in tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            strength_in = node.inputs.get("Emission Strength")
            color_in = node.inputs.get("Emission Color")
        elif node.type == "EMISSION":
            strength_in = node.inputs.get("Strength")
            color_in = node.inputs.get("Color")
        else:
            continue
        if strength_in is None or color_in is None:
            continue
        strength = float(strength_in.default_value)
        if strength > 0:
            return [round(v, 3) for v in color_in.default_value[:3]], strength
    return None


def object_emission(obj):
    """The strongest emitting material on the object, or None."""
    best = None
    for slot in getattr(obj, "material_slots", []):
        em = material_emission(slot.material)
        if em and (best is None or em[1] > best[1]):
            best = em
    return best


def top_level_collections(obj):
    """Root-level collection names holding the object (walks out of sub-collections).

    Collection has no parent pointer, so the tree is walked from each scene's
    master collection (cached — one export scans the scene a few times).
    """
    global _TOP_OF
    if _TOP_OF is None:
        _TOP_OF = {}

        def walk(coll, top):
            _TOP_OF[coll.name] = top
            for child in coll.children:
                walk(child, top)

        for scene in bpy.data.scenes:
            # direct children of the master collection are tops themselves
            for child in scene.collection.children:
                walk(child, child.name)

    names = []
    for coll in obj.users_collection:
        top = _TOP_OF.get(coll.name, coll.name)
        if top not in names:
            names.append(top)
    return names


def skip_reason(obj):
    """Why an emissive object never reached a .glb (for the EXPORT WARNING)."""
    tops = top_level_collections(obj)
    if not tops:
        return "not in any collection"
    exported_colls = [name for name in tops if name in {n for n, _, _ in MESH_EXPORTS}]
    if exported_colls:
        if obj.hide_render or obj.hide_viewport:
            return f"hidden (viewport/render) in exported collection '{exported_colls[0]}'"
        return f"type '{obj.type}' does not export to a glb"
    if "sound" in tops:
        return "the 'sound' collection exports speaker positions only — no mesh to emit from"
    return f"in skipped collection '{tops[0]}'"


def glb_json(path):
    """Parse a .glb's JSON chunk — node/material structure survives Draco."""
    import struct

    try:
        with open(path, "rb") as fh:
            header = fh.read(12)
            if len(header) != 12 or header[:4] != b"glTF":
                return None
            clen, ctype = struct.unpack("<II", fh.read(8))
            if ctype != 0x4E4F534A:  # 'JSON' chunk type
                return None
            return json.loads(fh.read(clen).decode("utf-8"))
    except (OSError, ValueError, struct.error):
        return None


def glb_emissive_nodes(data):
    """Names of nodes in a parsed .glb whose material actually emits."""
    emitting = set()
    for i, mat in enumerate(data.get("materials", [])):
        factor = mat.get("emissiveFactor") or [0.0, 0.0, 0.0]
        ext = (mat.get("extensions") or {}).get("KHR_materials_emissive_strength") or {}
        strength = float(ext.get("emissiveStrength", 1.0))  # absent = glTF default 1
        if strength > 0 and any(v > 0 for v in factor):
            emitting.add(i)
    meshes = data.get("meshes", [])
    names = set()
    for node in data.get("nodes", []):
        mi = node.get("mesh")
        if mi is None or mi >= len(meshes):
            continue
        if node.get("name") and any(p.get("material") in emitting for p in meshes[mi].get("primitives", [])):
            names.add(node["name"])
    return names


def audit_emissive(exported_by_file, out_dir):
    """Report every emissive object in the whole .blend: exported or not.

    The game only lights what reaches a .glb, so an emissive object sitting in
    a skipped/hidden place is a silent "my light doesn't light anything" bug —
    this audit is the missing feedback. Returns (manifest["emissive"],
    manifest["skippedEmissive"]).
    """
    destination = {}
    for fname, objs in exported_by_file.items():
        for obj in objs:
            destination[obj.name] = fname

    emissive = []
    for obj in bpy.data.objects:
        em = object_emission(obj)
        if em:
            emissive.append((obj, em))

    exported_entries = []
    skipped_entries = []
    for obj, (color, strength) in emissive:
        coll = ", ".join(top_level_collections(obj))
        fname = destination.get(obj.name)
        if fname is None:
            skipped_entries.append(
                {"name": obj.name, "collection": coll, "reason": skip_reason(obj)}
            )
            continue
        dims = world_dimensions(obj)
        exported_entries.append(
            {
                "name": obj.name,
                "collection": coll,
                "file": fname,
                "dimensions": dims,
                "strength": round(strength, 3),
                "color": color,
            }
        )

    print(
        f"export_map: emissive audit: {len(emissive)} object(s) with emission in the scene"
        f" — {len(exported_entries)} exported, {len(skipped_entries)} NOT exported"
    )
    if exported_entries:
        print("export_map: exported emissives (world dims are what the loader sizes lights from):")
        for e in exported_entries:
            dims = e["dimensions"]
            dims_txt = " x ".join(f"{d:.2f}" for d in dims) + " m" if dims else "?"
            color_txt = "(" + ", ".join(f"{c:.2f}" for c in e["color"]) + ")"
            print(
                f"export_map:   {e['name']}  collection={e['collection'] or '?'}  file={e['file']}  "
                f"dims {dims_txt}  strength {e['strength']:g}  color {color_txt}"
            )
    for e in skipped_entries:
        print(
            f"export_map: EXPORT WARNING: {e['name']} has emission but was NOT exported"
            f" — put it in the 'objects' collection ({e['reason']})"
        )

    # count check: scene-side emissive objects vs emissive meshes inside objects.glb
    report = {"exported": exported_entries, "objectsGlb": 0, "objectsGlbVerified": None}
    expected = {e["name"] for e in exported_entries if e["file"] == "objects.glb"}
    report["objectsGlb"] = len(expected)
    data = glb_json(os.path.join(out_dir, "objects.glb"))
    if data is None:
        print("export_map: emissive audit: objects.glb not readable — count check skipped")
    else:
        found = glb_emissive_nodes(data)
        report["objectsGlbVerified"] = len(found)
        if found == expected:
            print(f"export_map: emissive audit: objects.glb contains {len(found)} emissive mesh(es) — count matches the scene")
        else:
            print(
                f"export_map: EXPORT WARNING: emissive count mismatch — scene exported {len(expected)}"
                f" {sorted(expected)} but objects.glb contains {len(found)} {sorted(found)}"
            )
    return report, skipped_entries


def main():
    args = parse_args()
    out_dir = args.get("out", os.path.join(os.getcwd(), "assets", "map"))
    os.makedirs(out_dir, exist_ok=True)

    manifest = {"collections": {}, "checkpoints": [], "sound": [], "skipped": [], "emissive": {}, "skippedEmissive": []}
    exported_by_file = {fname: [] for _, fname, _ in MESH_EXPORTS}
    bpy.ops.object.select_all(action="DESELECT")

    # ---- mesh collections -------------------------------------------------
    for cname, fname, animations in MESH_EXPORTS:
        coll = bpy.data.collections.get(cname)
        if coll is None:
            manifest["collections"][cname] = {"missing": True}
            print(f"export_map: collection '{cname}' not found (skipped)")
            continue
        objects = list(coll.all_objects)
        ok, exported = export_glb(objects, os.path.join(out_dir, fname), animations, weld=args.get("weld", False))
        exported_by_file[fname] = list(exported)
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

    # ---- emissive audit (whole file — catches glows that reached no .glb) ---
    # Guarded: the glbs are already written by now, so an audit bug must not
    # cost the author their export (traceback still prints loudly).
    try:
        manifest["emissive"], manifest["skippedEmissive"] = audit_emissive(exported_by_file, out_dir)
    except Exception:
        import traceback

        traceback.print_exc()
        print("export_map: EXPORT WARNING: emissive audit failed — manifest written without it")

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"export_map: wrote {manifest_path}")


main()
