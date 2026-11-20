"""Bake a liminal .blend's static lighting into a lightmap PNG (Blender CLI).

    tools/bake_map.sh path/to/map.blend
    # = blender -b map.blend --python export_map.py --python bake_map.py -- \
    #     --out <dir> [--weld] [--samples 64] [--resolution 2048]

Runs in the SAME headless Blender run as the normal export (bake_map.sh
passes both --python flags): export_map.py writes the .glbs + manifest.json
first, then this script — without ever saving the .blend:

  1. adds a second UV layer ("LightMap") to every mesh that ships in
     objects.glb — generated with lightmap pack, UV1 never touched (verified)
  2. Cycles-bakes the scene's static lighting onto that layer — bake type
     Combined, so emissive fixtures bake bright (a glowing panel stays white,
     which is what the renderer wants)
  3. writes <out>/lightmap.png (sRGB-encoded, 8-bit)
  4. re-exports objects.glb so the second UV set ships as glTF TEXCOORD_1
  5. patches manifest.json with additive "lightmap" metadata

Scope: the lightmap serves objects.glb (the static world) — the only .glb
re-exported with TEXCOORD_1. The UV/pack/bake/re-export scopes stay identical
on purpose: the atlas must contain exactly what TEXCOORD_1 can reach. When
checkpoints/animated/playermodels gain meshes AND the renderer wants them
lightmapped, extend LIGHTMAP_COLLECTION and the re-export list together.
Animated avatars move, so baked static lighting doesn't apply to them
anyway (docs/backlog.md #9: static for static, realtime for dynamic).
"""

import json
import os
import sys
import time

import bpy
import numpy as np

LIGHTMAP_COLLECTION = "objects"
LIGHTMAP_UV = "LightMap"
# Bake margin in pixels: EXTEND fills this much empty space around every
# island with the island's own edge colour, so bilinear filtering at the
# island border can never pull in a neighbouring island (or black).
MARGIN_PX = 16
# Island spacing enforced by the follow-up pack: 2x the bake margin, so the
# two EXTEND fills meeting in a gap stop before they collide.
ISLAND_GAP_PX = 2 * MARGIN_PX
SAMPLES_DEFAULT = 64
RESOLUTION_DEFAULT = 2048


def positive_int(flag, raw):
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"bake_map: {flag} needs an integer, got {raw!r}")
    if value <= 0:
        raise SystemExit(f"bake_map: {flag} must be > 0, got {value}")
    return value


def parse_args():
    """Everything after the `--` separator (shared with export_map.py):
    --out <dir>, --samples N, --resolution N.

    --weld is export_map.py's: it already welded the meshes earlier in this
    same Blender process, so the bake sees the welded geometry for free.
    Unknown flags are skipped, mirroring export_map.parse_args.
    """
    if "--" not in sys.argv:
        return {"samples": SAMPLES_DEFAULT, "resolution": RESOLUTION_DEFAULT}
    args = sys.argv[sys.argv.index("--") + 1:]
    out = {"samples": SAMPLES_DEFAULT, "resolution": RESOLUTION_DEFAULT}
    i = 0
    while i < len(args):
        if args[i] == "--out" and i + 1 < len(args):
            out["out"] = args[i + 1]
            i += 2
        elif args[i] == "--samples" and i + 1 < len(args):
            out["samples"] = positive_int("--samples", args[i + 1])
            i += 2
        elif args[i] == "--resolution" and i + 1 < len(args):
            out["resolution"] = positive_int("--resolution", args[i + 1])
            i += 2
        else:
            i += 1
    return out


def select_only(objects):
    """Mirror of export_map.select_only — export_map.py can't be imported
    (it runs its whole export at import time)."""
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)


def ensure_lightmap_uv(meshes):
    """Append the second UV layer; UV1 (index 0) is never modified.

    The glTF exporter maps UV layer index -> TEXCOORD_n by position in the
    stack (verified in io_scene_gltf2: tex_coord_max = len(uv_layers)), so
    LightMap must land at index 1 to ship as TEXCOORD_1 — the renderer
    contract. Loud warning if a mesh's stack makes that impossible.
    """
    created = 0
    for obj in meshes:
        me = obj.data
        if len(me.uv_layers) == 0:
            # contract: the lightmap must be TEXCOORD_1, so a mesh with no UVs
            # gets a placeholder UV1 first (nothing samples it today — the
            # game's materials are textureless)
            me.uv_layers.new(name="UVMap")
            print(f"bake_map: {obj.name} had no UV layers — created an empty 'UVMap' as UV1")
        if me.uv_layers.find(LIGHTMAP_UV) < 0:
            me.uv_layers.new(name=LIGHTMAP_UV)
            created += 1
        idx = me.uv_layers.find(LIGHTMAP_UV)
        me.uv_layers.active_index = idx  # the pack below writes the active layer
        if idx != 1:
            print(
                f"bake_map: EXPORT WARNING {obj.name}: '{LIGHTMAP_UV}' is UV layer {idx} "
                f"(glTF TEXCOORD_{idx}) but the renderer contract is TEXCOORD_1 — "
                f"delete the extra UV layer above UV1 in Blender"
            )
    print(f"bake_map: second UV layer '{LIGHTMAP_UV}' on {len(meshes)} mesh(es) ({created} new)")


def uv1_snapshot(meshes):
    """UV1 (layer 0) of every mesh as flat float arrays.

    Taken before packing and compared after: the whole lightmap feature is
    additive — the authoring UV must leave the bake byte-identical, so the
    run refuses to ship if it ever doesn't.
    """
    snap = {}
    for obj in meshes:
        me = obj.data
        arr = np.empty(len(me.loops) * 2, dtype=np.float32)
        me.uv_layers[0].data.foreach_get("uv", arr)
        snap[me.name] = arr
    return snap


def pack_lightmap_uvs(meshes, resolution):
    """Pack every mesh's LightMap islands into ONE shared, bleed-safe layout.

    lightmap pack with PACK_IN_ONE is the point: all selected meshes share a
    single 0-1 atlas (one lightmap.png for the whole scene), and it works
    headless (background-mode operator, measured here). Smart UV project also
    happened to pack jointly when measured headless, but that is incidental
    to a texturing tool — PACK_IN_ONE states the one-shared-atlas requirement
    as its contract.

    The follow-up pack_islands pass enforces >= ISLAND_GAP_PX between ALL
    islands (lightmap pack alone left ~8 px gaps at 2048, less than the bake
    margin, which would let one island's EXTEND fill bleed into the next).
    """
    select_only(meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.lightmap_pack(
        PREF_CONTEXT="ALL_FACES",
        PREF_PACK_IN_ONE=True,
        PREF_NEW_UVLAYER=False,  # pack into the active LightMap layer, not a new one
    )
    bpy.ops.uv.pack_islands(
        margin=ISLAND_GAP_PX / resolution,  # UV units -> always ISLAND_GAP_PX px at this resolution
        margin_method="ADD",
        rotate=True,
        scale=True,
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def audit_uv_overlap(meshes, grid=512):
    """Coarse raster proof that no two meshes share lightmap texels.

    Overlapping UV2 islands mean one mesh's bake silently overwrites another's
    — corruption the PNG alone can hide, so check it every run.
    Returns the number of texels claimed by more than one mesh.
    """
    owner = np.full((grid, grid), -1, dtype=np.int16)
    for idx, obj in enumerate(meshes):
        me = obj.data
        layer = me.uv_layers.get(LIGHTMAP_UV)
        if layer is None:
            continue
        uvs = np.empty(len(me.loops) * 2, dtype=np.float32)
        layer.data.foreach_get("uv", uvs)
        uvs = uvs.reshape(-1, 2)
        mask = np.zeros((grid, grid), dtype=bool)
        for poly in me.polygons:
            li = list(poly.loop_indices)
            for k in range(1, len(li) - 1):
                pts = uvs[[li[0], li[k], li[k + 1]]] * (grid - 1)
                xs, ys = pts[:, 0], grid - 1 - pts[:, 1]
                x0 = max(int(np.floor(xs.min())), 0)
                x1 = min(int(np.ceil(xs.max())), grid - 1)
                y0 = max(int(np.floor(ys.min())), 0)
                y1 = min(int(np.ceil(ys.max())), grid - 1)
                if x1 < x0 or y1 < y0:
                    continue
                gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
                v0x, v0y = xs[1] - xs[0], ys[1] - ys[0]
                v1x, v1y = xs[2] - xs[0], ys[2] - ys[0]
                det = v0x * v1y - v1x * v0y
                if abs(det) < 1e-12:
                    continue  # degenerate UV triangle
                a = ((gx - xs[0]) * v1y - v1x * (gy - ys[0])) / det
                b = (v0x * (gy - ys[0]) - (gx - xs[0]) * v0y) / det
                mask[y0:y1 + 1, x0:x1 + 1] |= (a >= -1e-6) & (b >= -1e-6) & (a + b <= 1 + 1e-6)
        owner[mask & (owner == -1)] = idx
        owner[mask & (owner != -1) & (owner != idx)] = 1000
    return int((owner >= 1000).sum())


def wire_bake_targets(img, meshes):
    """Point every material on the bake targets at the shared bake image.

    Cycles bakes into each material's ACTIVE image texture node, so every
    material gets one (left unconnected — the destination node must not
    affect the shading being baked). Objects with no material at all get a
    temporary white material, otherwise their lightmap islands would bake
    black; it is removed again before the .glb re-export so the exported
    materials match a plain export exactly. Returns (added_nodes, temp_mats)
    for unwire().
    """
    added_nodes = []
    temp_mats = []
    seen = set()
    for obj in meshes:
        mats = [slot.material for slot in obj.material_slots if slot.material]
        if not mats:
            tmp = bpy.data.materials.new("bake_tmp_albedo")
            tmp.use_nodes = True
            obj.data.materials.append(tmp)
            temp_mats.append((obj, tmp))
            mats = [tmp]
        for mat in mats:
            if mat.name in seen:
                continue
            seen.add(mat.name)
            if mat.node_tree is None:
                print(f"bake_map: EXPORT WARNING material '{mat.name}' has no node tree — "
                      f"its islands will bake black")
                continue
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = img
            mat.node_tree.nodes.active = node
            added_nodes.append((mat.node_tree, node))
    return added_nodes, temp_mats


def unwire(added_nodes, temp_mats):
    """Remove everything wire_bake_targets added — the .glb re-export must see
    materials byte-identical to a plain export (only TEXCOORD_1 may differ)."""
    for tree, node in added_nodes:
        tree.nodes.remove(node)
    for obj, tmp in temp_mats:
        idx = obj.data.materials.find(tmp.name)
        if idx >= 0:
            obj.data.materials.pop(index=idx)
        bpy.data.materials.remove(tmp)


def pick_device():
    """GPU when Cycles has a compute device configured (this machine: RTX 5090
    via OptiX — a 2048/64 bake measured 6 s on GPU), CPU otherwise so the bake
    still works on machines without one (where it takes minutes)."""
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.get_devices()
        if any(dev.type != "CPU" and dev.use for dev in prefs.devices):
            return "GPU"
    except Exception:
        pass
    return "CPU"


def run_bake(meshes, samples, resolution):
    """Combined bake of the selected meshes into the shared LightMap layer.

    Returns (duration_seconds, buffer_stats). Combined (not Diffuse) is the
    contract: emissive surfaces bake to their emission — bright/white — which
    is exactly what the renderer wants a glowing panel to look like.
    """
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.device = pick_device()
    print(f"bake_map: Cycles {scene.cycles.device}, {samples} samples, "
          f"{resolution}x{resolution}, margin {MARGIN_PX}px")
    select_only(meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    t0 = time.time()
    try:
        bpy.ops.object.bake(
            type="COMBINED",
            margin=MARGIN_PX,
            margin_type="EXTEND",
            use_clear=True,
            uv_layer=LIGHTMAP_UV,
        )
    except Exception:
        if scene.cycles.device != "GPU":
            raise
        import traceback
        traceback.print_exc()
        print("bake_map: GPU bake failed — retrying on CPU")
        scene.cycles.device = "CPU"
        t0 = time.time()
        bpy.ops.object.bake(
            type="COMBINED",
            margin=MARGIN_PX,
            margin_type="EXTEND",
            use_clear=True,
            uv_layer=LIGHTMAP_UV,
        )
    return time.time() - t0


def buffer_stats(img):
    """(mean, max, non-black fraction) of the linear bake buffer, RGB only."""
    buf = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(buf)
    rgb = buf.reshape(-1, 4)[:, :3]
    return float(rgb.mean()), float(rgb.max()), float((rgb.max(axis=1) > 0.001).mean())


def save_lightmap_png(img, path):
    """Write the linear bake buffer as an sRGB-encoded 8-bit PNG.

    image.save() on a float image writes 16-bit (measured: 12.8 MB at 2048²)
    and browsers decode PNG down to 8-bit for WebGL anyway — so encode to
    sRGB here (the same transfer function Blender's own save() applies,
    verified against known values) and save a byte image raw. Emission above
    1.0 clamps to white, which is the wanted look for glowing panels.
    Returns the file size in bytes.
    """
    buf = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(buf)
    rgb = np.clip(buf.reshape(-1, 4)[:, :3], 0.0, 1.0)
    enc = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    out = bpy.data.images.new("lightmap_srgb", img.size[0], img.size[1])
    rgba = np.empty((enc.shape[0], 4), dtype=np.float32)
    rgba[:, :3] = enc
    rgba[:, 3] = 1.0
    out.pixels.foreach_set(np.ascontiguousarray(rgba).ravel())
    out.file_format = "PNG"
    out.save(filepath=path)
    size = os.path.getsize(path)
    bpy.data.images.remove(out)
    return size


def glb_json(path):
    """Parse a .glb's JSON chunk — copy of export_map.glb_json (that module
    runs its whole export at import time, so it can't be imported here)."""
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


def export_objects_glb(out_dir):
    """Re-export objects.glb with the LightMap layer present.

    The glTF call is a copy of export_map.export_glb for the objects
    collection (animations off) — kept in sync by hand because export_map.py
    can't be imported (see glb_json above). Only the selection differs from a
    plain export: UV2 is already on the meshes at this point.
    """
    coll = bpy.data.collections.get(LIGHTMAP_COLLECTION)
    if coll is None:
        print(f"bake_map: collection '{LIGHTMAP_COLLECTION}' not found — nothing to re-export")
        return False
    mesh_objects = [o for o in coll.all_objects
                    if o.type in {"MESH", "CURVE", "SURFACE", "FONT", "ARMATURE"}]
    if not mesh_objects:
        print("bake_map: objects.glb skipped (no mesh objects)")
        return False
    select_only(mesh_objects)
    path = os.path.join(out_dir, "objects.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_animations=False,
    )
    print(f"bake_map: re-exported objects.glb ({len(mesh_objects)} objects, "
          f"{os.path.getsize(path) // 1024} KB)")
    return True


def verify_texcoord1(path):
    """Loud check of the renderer contract: every primitive carries
    TEXCOORD_1. Refuses to ship (SystemExit) if it doesn't — a lightmap
    nobody can sample is worse than no lightmap."""
    data = glb_json(path)
    if data is None:
        raise SystemExit(f"bake_map: cannot parse {path} to verify TEXCOORD_1 — not shipping")
    prims = [p for m in data.get("meshes", []) for p in m.get("primitives", [])]
    if not prims:
        raise SystemExit("bake_map: objects.glb has no mesh primitives — not shipping")
    missing = [i for i, p in enumerate(prims) if "TEXCOORD_1" not in p.get("attributes", {})]
    if missing:
        raise SystemExit(
            f"bake_map: EXPORT WARNING TEXCOORD_1 missing from {len(missing)}/{len(prims)} "
            f"primitives — the glTF exporter did not ship the second UV set"
        )
    print(f"bake_map: objects.glb verified — TEXCOORD_1 on all {len(prims)} primitive(s)")


def patch_manifest(out_dir, resolution):
    """Add the additive lightmap entry — the loader ignores unknown manifest
    fields today, so this is safe for every existing consumer (same JSON
    formatting as export_map.py so the diff is only the new block)."""
    path = os.path.join(out_dir, "manifest.json")
    with open(path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    manifest["lightmap"] = {
        "file": "lightmap.png",
        "resolution": resolution,
        "uv": "TEXCOORD_1",
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"bake_map: manifest.json += lightmap (lightmap.png, {resolution}px, TEXCOORD_1)")


def run():
    args = parse_args()
    out_dir = args.get("out", os.path.join(os.getcwd(), "assets", "map"))
    samples = args["samples"]
    resolution = args["resolution"]

    # export_map.py ran first in this same Blender process — it owns the
    # manifest, and a missing one means this script was run without it.
    manifest_path = os.path.join(out_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise SystemExit(
            f"bake_map: {manifest_path} not found — run via tools/bake_map.sh "
            f"(the export step must run first, in the same Blender run)"
        )

    coll = bpy.data.collections.get(LIGHTMAP_COLLECTION)
    if coll is None:
        raise SystemExit(f"bake_map: collection '{LIGHTMAP_COLLECTION}' not found — nothing to bake")
    meshes = [o for o in coll.all_objects if o.type == "MESH" and o.data is not None]
    meshes = [o for o in meshes if len(o.data.polygons) > 0]
    if not meshes:
        raise SystemExit(f"bake_map: no mesh objects in '{LIGHTMAP_COLLECTION}' — nothing to bake")
    hidden = [o.name for o in meshes if o.hide_render]
    if hidden:
        print(f"bake_map: EXPORT WARNING hidden from render, their islands bake black: "
              f"{', '.join(hidden)}")

    ensure_lightmap_uv(meshes)
    before = uv1_snapshot(meshes)
    pack_lightmap_uvs(meshes, resolution)
    after = uv1_snapshot(meshes)
    changed = [n for n in before if not np.array_equal(before[n], after[n])]
    if changed:
        raise SystemExit(
            f"bake_map: EXPORT WARNING packing modified UV1 on: {', '.join(changed)} — "
            f"refusing to ship a lightmap that touches the authoring UV"
        )
    print(f"bake_map: UV1 verified untouched on {len(meshes)} mesh(es)")

    overlap = audit_uv_overlap(meshes)
    if overlap:
        raise SystemExit(
            f"bake_map: EXPORT WARNING {overlap} overlapping texels after packing — "
            f"islands from different meshes collide in the shared atlas"
        )
    print(f"bake_map: atlas audit — 0 overlapping texels across {len(meshes)} meshes "
          f"(512² sampling)")

    img = bpy.data.images.new("lightmap", resolution, resolution, float_buffer=True)
    added_nodes, temp_mats = wire_bake_targets(img, meshes)
    print(f"bake_map: wired {len(added_nodes)} material(s), {len(temp_mats)} temporary material(s)")

    duration = run_bake(meshes, samples, resolution)
    mean, max_v, nonzero = buffer_stats(img)
    print(f"bake_map: baked in {duration:.1f}s — linear buffer mean {mean:.4f}, "
          f"max {max_v:.4f}, non-black {nonzero * 100:.1f}%")
    if max_v <= 0.0:
        raise SystemExit("bake_map: bake produced a black image — no light reached the baker")

    png_path = os.path.join(out_dir, "lightmap.png")
    size = save_lightmap_png(img, png_path)
    print(f"bake_map: wrote {png_path} ({size // 1024} KB, sRGB-encoded 8-bit)")

    unwire(added_nodes, temp_mats)
    bpy.data.images.remove(img)

    if not export_objects_glb(out_dir):
        raise SystemExit("bake_map: objects.glb re-export failed — not patching the manifest")
    verify_texcoord1(os.path.join(out_dir, "objects.glb"))
    patch_manifest(out_dir, resolution)
    print("bake_map: done")


def main():
    try:
        run()
    except Exception:
        # Blender exits 0 even when a --python script raises (measured), so
        # failures must become exit 1 or bake_map.sh cannot fail loudly.
        import traceback

        traceback.print_exc()
        print("bake_map: FAILED — traceback above, no lightmap written", file=sys.stderr)
        sys.exit(1)


main()
