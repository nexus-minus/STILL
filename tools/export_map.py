"""Export a liminal .blend into the game's asset layout (Blender CLI).

    tools/export_map.sh path/to/map.blend
    # = blender -b map.blend --python tools/export_map.py -- --out <assets/map>

Collection scheme (see docs/blender-conventions.md):

    objects      -> objects.glb              static world geometry
    checkpoints  -> checkpoints.glb (if meshes) + manifest.checkpoints[]
    animated     -> animated.glb             objects with actions (+ animation)
    sound        -> manifest.sound[]         speaker objects -> 3D audio sources
    playermodels -> playermodels.glb         selectable avatars (one root each)

Any other top-level collection is listed in manifest.json under "skipped". A sub-collection
is attributed to its top-level ancestor under "subCollections" — its objects export through
that ancestor, so a sub-collection name is never reported as a skipped collection.

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

# the material-field helpers are shared with bake_map.py, which re-exports objects.glb after the
# bake and must apply the same rule to the file that actually ships (see tools/glb_fields.py).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_fields import GLTF_DEFAULTS, PRINCIPLED_INPUTS, authored_fields, glb_chunks, glb_json, write_material_fields

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


def top_map():
    """collection name -> top-level ancestor. Collection has no parent pointer, so the
    tree is walked from each scene's master collection (cached — one export scans the
    scene a few times). Direct children of a master collection are tops themselves."""
    global _TOP_OF
    if _TOP_OF is None:
        _TOP_OF = {}

        def walk(coll, top):
            _TOP_OF[coll.name] = top
            for child in coll.children:
                walk(child, top)

        for scene in bpy.data.scenes:
            for child in scene.collection.children:
                walk(child, child.name)
    return _TOP_OF


def top_level_collections(obj):
    """Root-level collection names holding the object (walks out of sub-collections)."""
    names = []
    for coll in obj.users_collection:
        top = top_map().get(coll.name, coll.name)
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


# The glTF 2.0 material defaults, checked against the spec schema files (material.schema.json,
# material.pbrMetallicRoughness.schema.json, the KHR_materials_emissive_strength README).
GLTF_DEFAULTS = {
    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
    "metallicFactor": 1.0,
    "roughnessFactor": 1.0,
    "emissiveFactor": [0.0, 0.0, 0.0],
    "emissiveStrength": 1.0,
}

# field name in the file -> Blender Principled input name
PRINCIPLED_INPUTS = {
    "baseColorFactor": "Base Color",
    "metallicFactor": "Metallic",
    "roughnessFactor": "Roughness",
    "emissiveFactor": "Emission Color",
    "emissiveStrength": "Emission Strength",
}


# glb_json, glb_chunks, authored_fields, write_material_fields, GLTF_DEFAULTS and
# PRINCIPLED_INPUTS come from tools/glb_fields.py, so bake_map.py uses the same code path on the
# re-exported file instead of a copy.


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


def audit_material_defaults(exported_by_file, out_dir):
    """What the file actually says about each authored material value.

    Every field is now written by write_material_fields(), so `written` is true for all five fields
    of every material and no value can be assumed. The audit still compares both sides and writes
    the answer down: `notDefault` flags a value in the file that is NOT the spec default — Blender's
    Principled defaults are Emission Color (1,1,1) and Emission Strength 0, while the glTF defaults
    are emissiveFactor [0,0,0] and emissiveStrength 1.0, so an emission-off material is a real
    difference that has to be recorded. `defaultsUsed` only appears for a field the file does not
    write, and a field that is absent AND not equal to the default is a loud EXPORT WARNING, because
    that one really is lost.

    Defaults from the glTF 2.0 schema (GLTF_DEFAULTS) and the KHR_materials_emissive_strength README.
    Returns manifest["materialDefaults"].
    """
    defaults = GLTF_DEFAULTS
    entries = []
    lost = []
    for fname, objs in exported_by_file.items():
        data = glb_json(os.path.join(out_dir, fname))
        if data is None:
            continue
        for mat_json in data.get("materials", []):
            authored = authored_fields(bpy.data.materials.get(mat_json.get("name") or ""))
            if authored is None:
                continue
            entry = {"material": mat_json.get("name"), "file": fname, "written": {},
                     "defaultsUsed": {}, "notDefault": {}}
            for field in PRINCIPLED_INPUTS:
                written = (mat_json.get("pbrMetallicRoughness") or {}).get(field)
                if field == "emissiveStrength":
                    written = ((mat_json.get("extensions") or {}).get("KHR_materials_emissive_strength") or {}).get("emissiveStrength")
                elif field == "emissiveFactor":
                    written = mat_json.get("emissiveFactor")
                entry["written"][field] = written is not None
                default = defaults[field]
                same = ([round(v, 6) for v in default] if isinstance(default, list) else round(default, 6)) == (
                    authored[field] if isinstance(authored[field], list) else round(authored[field], 6))
                if written is None:
                    entry["defaultsUsed"][field] = default
                    if not same:
                        entry["notDefault"][field] = authored[field]
                        lost.append((mat_json.get("name"), field, authored[field], default))
                elif not same:
                    # the value is in the file, so nothing is hidden — but the file says something
                    # different from the spec default, and the reader must be told which.
                    entry["notDefault"][field] = written
            entries.append(entry)

    print(f"export_map: material defaults audit: {len(entries)} material(s), "
          f"{sum(len(e['defaultsUsed']) for e in entries)} field(s) not written (glTF default used), "
          f"{sum(len(e['notDefault']) for e in entries)} written value(s) flagged as not the default")
    for mat, field, authored, default in lost:
        print(f"export_map: EXPORT WARNING: material '{mat}' authored {field} = {authored} but the file "
              f"writes nothing, so a reader takes the glTF default {default} — that value is lost")
    return entries


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

    manifest = {"collections": {}, "checkpoints": [], "sound": [], "skipped": [],
                "subCollections": {}, "emissive": {}, "skippedEmissive": [], "materialDefaults": []}
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

    # ---- every material field must be IN the file ------------------------------------
    # Owner decision 2026-11-23: a field that is not in the file cannot be checked at tolerance 0,
    # so the exporter writes all five for every material. The values are the authored ones, so the
    # game renders exactly the same picture; only the record changes. bake_map.py re-exports
    # objects.glb after the bake, which writes only the fields that differ from the default, so the
    # same rule is applied there too — the audit below reads the file at this moment and can only be
    # truthful if the last write of the file keeps the fields.
    for fname in exported_by_file:
        path = os.path.join(out_dir, fname)
        if not os.path.exists(path):
            continue
        present, added = write_material_fields(path)
        print(f"export_map: {fname}: {present} field(s) already written, {added} added "
              f"({present + added} of {5 * len(glb_json(path).get('materials', []))} for "
              f"{len(glb_json(path).get('materials', []))} material(s))")

    # ---- checkpoint + sound side channels ---------------------------------
    ck_coll = bpy.data.collections.get("checkpoints")
    if ck_coll is not None:
        manifest["checkpoints"] = export_checkpoint_info(ck_coll)

    snd_coll = bpy.data.collections.get("sound")
    if snd_coll is not None:
        manifest["sound"] = export_sound(snd_coll)

    # ---- anything else ------------------------------------------------------
    # A sub-collection name cannot decide anything on its own: its objects are exported
    # through its TOP-LEVEL ancestor (all_objects is recursive, so geometry inside a
    # sub-collection of an exported collection does reach the .glb). So the warning is
    # resolved to the ancestor before it fires, and the attribution itself is written into
    # the manifest — a name that belongs to an exported ancestor is not a skipped collection.
    tops = top_map()
    subs = {}
    warned = []
    for coll in bpy.data.collections:
        top = tops.get(coll.name, coll.name)
        if coll.name != top:
            subs[coll.name] = top
            if top in KNOWN:
                print(f"export_map: collection '{coll.name}' is a sub-collection of '{top}' "
                      f"(its objects export through that top-level collection)")
                continue
        elif top in KNOWN:
            continue
        if top not in warned:
            warned.append(top)
            manifest["skipped"].append(top)
            print(f"export_map: WARNING unknown top-level collection '{top}' (not exported)")
    manifest["subCollections"] = subs

    # ---- emissive audit (whole file — catches glows that reached no .glb) ---
    # Guarded: the glbs are already written by now, so an audit bug must not
    # cost the author their export (traceback still prints loudly).
    try:
        manifest["emissive"], manifest["skippedEmissive"] = audit_emissive(exported_by_file, out_dir)
    except Exception:
        import traceback

        traceback.print_exc()
        print("export_map: EXPORT WARNING: emissive audit failed — manifest written without it")

    # ---- what the file wrote per material value ------------------------------
    # An absent field means "glTF default", not "lost value" — but only when the authored value
    # is that default. The audit compares both sides and writes the result into the manifest, so
    # the reader never has to assume anything about a field that is not in the file.
    try:
        manifest["materialDefaults"] = audit_material_defaults(exported_by_file, out_dir)
    except Exception:
        import traceback

        traceback.print_exc()
        print("export_map: material defaults audit failed — manifest written without it")

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"export_map: wrote {manifest_path}")


main()
