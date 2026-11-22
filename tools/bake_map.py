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
  3. writes <out>/lightmap.bin (raw 16-bit half-float RGBA — the game file) and
     <out>/lightmap.png (8-bit preview for humans, and the report of what an
     8-bit screen gets); --bits 8 makes the PNG the game file again
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
# Blue-noise ordered dither for the 8-bit encode (docs/backlog.md #9, banding).
# Quantization is what makes banding: neighbouring texels land on the same
# value, and the eye reads the jump between two values as a stripe. Dithering
# spreads that jump over neighbouring texels, so the stripes become a fine,
# nearly invisible variation instead of a plateau. Blue noise (not white) is
# used because it has no low-frequency clumping — white noise looks like grain.
DITHER_SIZE = 64
DITHER_DEFAULT = True
BITS_DEFAULT = 16


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

    --dither / --no-dither  blue-noise ordered dither on the 8-bit encode (on
    by default; --no-dither exists for the A/B, see scripts/banding-check.mjs).

    --bits 16|8             storage precision. 16 (default) writes lightmap.bin as
    raw RGBA16F: relative precision everywhere, no range, nothing clips, no dither
    needed at storage. 8 keeps the RGBM PNG as the game file for the comparison.
    Either way lightmap.png is written: with 16-bit it is the preview for humans
    and the report of what an 8-bit screen gets.

    --weld is export_map.py's: it already welded the meshes earlier in this
    same Blender process, so the bake sees the welded geometry for free.
    Unknown flags are skipped, mirroring export_map.parse_args.
    """
    if "--" not in sys.argv:
        return {"samples": SAMPLES_DEFAULT, "resolution": RESOLUTION_DEFAULT,
                "dither": DITHER_DEFAULT, "dither_ab": False, "bits": BITS_DEFAULT}
    args = sys.argv[sys.argv.index("--") + 1:]
    out = {"samples": SAMPLES_DEFAULT, "resolution": RESOLUTION_DEFAULT,
           "dither": DITHER_DEFAULT, "dither_ab": False, "bits": BITS_DEFAULT}
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
        elif args[i] == "--no-dither":
            out["dither"] = False
            i += 1
        elif args[i] == "--dither":
            out["dither"] = True
            i += 1
        elif args[i] == "--dither-ab":
            out["dither_ab"] = True
            i += 1
        elif args[i] == "--bits" and i + 1 < len(args):
            bits = positive_int("--bits", args[i + 1])
            if bits not in (8, 16):
                raise SystemExit("bake_map: --bits must be 8 or 16")
            out["bits"] = bits
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
    Returns (number of texels claimed by more than one mesh, owner grid).
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
    # owner is returned as well: the fixture report below needs to know WHICH
    # mesh a texel belongs to, and this is the only place that already rasterizes
    # the islands (re-deriving it would mean a second UV pass).
    return int((owner >= 1000).sum()), owner


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
    """(mean, max, non-black fraction, rgb array) of the linear bake buffer."""
    buf = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(buf)
    rgb = buf.reshape(-1, 4)[:, :3]
    return float(rgb.mean()), float(rgb.max()), float((rgb.max(axis=1) > 0.001).mean()), rgb


# ---- AgX display reference (measurement only) -----------------------------
# Ported from three.js ToneMappingFunctions.js `agxToneMapping` — the same
# constants Blender's default AgX view transform uses (the game tonemaps with
# AgX, docs/backlog.md #9 rule 2). Lets the bake PRINT what the 8-bit encode
# costs in display terms instead of guessing. mat3(c0,c1,c2) is column-major:
# v @ C.T with rows [c0,c1,c2] reproduces M*v.
_SRGB_TO_REC2020 = np.array([
    [0.6274, 0.0691, 0.0164],
    [0.3293, 0.9195, 0.0880],
    [0.0433, 0.0113, 0.8956],
])
_REC2020_TO_SRGB = np.array([
    [1.6605, -0.1246, -0.0182],
    [-0.5876, 1.1329, -0.1006],
    [-0.0728, -0.0083, 1.1187],
])
_AGX_INSET = np.array([
    [0.856627153315983, 0.137318972929847, 0.11189821299995],
    [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
    [0.0482516061458583, 0.101439036467562, 0.811302368396859],
])
_AGX_OUTSET = np.array([
    [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
    [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
    [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
])


def agx_display(linear_rgb):
    """AgX-tonemapped + sRGB-encoded display values in [0,1] (exposure 1)."""
    x = np.maximum(np.asarray(linear_rgb, dtype=np.float64), 0.0) @ _SRGB_TO_REC2020.T
    x = np.maximum(x @ _AGX_INSET.T, 1e-10)
    x = np.log2(x)
    x = np.clip((x - (-12.47393)) / (4.026069 - (-12.47393)), 0.0, 1.0)
    x2, x4 = x * x, (x * x) * (x * x)
    x = (15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
         + 0.4298 * x2 + 0.1191 * x - 0.00232)
    x = np.maximum(x, 0.0) ** 2.2 @ _REC2020_TO_SRGB.T
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def clipping_report(rgb):
    """What the plain sRGB-8 encode loses (backlog #9 rule 2), printed every run.

    A linear value > 1.0 cannot survive an 8-bit [0,1] encode: it stores as
    pure white and the falloff around it flattens. The numbers: how many texels
    clip, how far above 1 they sit, and — the question the rule actually asks —
    whether AgX shows a difference between the clipped and the true value.
    """
    peak = rgb.max(axis=1)
    over = peak > 1.0
    n = int(over.sum())
    if n == 0:
        print("bake_map: clipping — 0 texels above linear 1.0, sRGB-8 loses nothing")
        return
    stops = float(np.log2(max(peak.max(), 1.0)))
    true_disp = agx_display(rgb[over])
    clip_disp = agx_display(np.clip(rgb[over], 0.0, 1.0))
    delta = np.abs(true_disp - clip_disp)
    print(
        f"bake_map: clipping — {n} texels ({100.0 * n / len(peak):.2f}%) above linear 1.0, "
        f"max {peak.max():.2f} ({stops:.1f} stops over) · under AgX the clipped value differs "
        f"from the true one by mean {delta.mean():.4f} / max {delta.max():.4f} display "
        f"(true {true_disp.mean():.3f} vs clipped {clip_disp.mean():.3f})"
    )


def blue_noise_mask(n=DITHER_SIZE, seed=1):
    """Void-and-cluster: an ordered-dither matrix whose thresholds are
    blue-noise distributed (evenly spaced, no clumping).

    Standard result in graphics: taking the ORDER in which void-and-cluster
    places pixels gives a matrix that dithers without low-frequency clumping —
    which is what makes the residual look like a smooth gradient instead of a
    pattern. Generated once per run (64², ~4k iterations), deterministic with a
    fixed seed so two runs produce the same PNG.
    """
    rng = np.random.default_rng(seed)
    yy, xx = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    order = np.zeros((n, n), dtype=np.int32)
    placed = np.zeros((n, n), dtype=bool)
    dist = np.full((n, n), np.inf)          # distance to the nearest placed pixel (torus)
    p = (int(rng.integers(n)), int(rng.integers(n)))
    for count in range(n * n):
        placed[p] = True
        order[p] = count
        dy = np.abs(yy - p[0]); dy = np.minimum(dy, n - dy)
        dx = np.abs(xx - p[1]); dx = np.minimum(dx, n - dx)
        dist = np.minimum(dist, np.sqrt(dy * dy + dx * dx))
        free = np.where(placed, -1.0, dist)
        p = np.unravel_index(int(np.argmax(free)), (n, n))
    return order / float(n * n)


def plateau_stats(display):
    """What the eye actually sees in a quantized image: flat plateaus.

    A plateau is a run of identical values in a row; a plateau plus a 1-LSB jump
    is one visible band. Quantization without dither produces long plateaus
    (the committed lightmap measured 70.9 % of its area inside runs >= 8 px,
    longest 1670 px). Dithering breaks the plateaus into short runs, so the same
    information reads as a smooth gradient.
    """
    if display.ndim == 3:
        luma = np.round(display[..., 0] * 0.2126 + display[..., 1] * 0.7152
                        + display[..., 2] * 0.0722).astype(np.int64)
    else:
        luma = display
    rows, cols = luma.shape
    # Only pixels that actually received light are measured: the atlas is ~42 %
    # black (unused islands + padding), and counting those as plateaus would make
    # every number look worse than the picture is.
    measured = luma > 4
    levels = int(len(np.unique(luma[measured]))) if measured.any() else 0
    longest = 0
    in_plateau = 0
    jumps = 0
    for y in range(rows):
        vals = luma[y]
        valid = measured[y]
        boundary = np.flatnonzero((vals[:-1] != vals[1:]) & valid[:-1] & valid[1:])
        edges = [0] + (boundary + 1).tolist() + [cols]
        for i in range(len(edges) - 1):
            n = int(valid[edges[i]:edges[i + 1]].sum())
            if n >= 8:
                in_plateau += n
            longest = max(longest, n)
        jumps += int(boundary.size)
    return {
        "levels": levels,
        "longest": int(longest),
        "plateau_pct": 100.0 * in_plateau / max(1, int(measured.sum())),
        "jumps": int(jumps),
    }


def fixture_report(owner, meshes, linear_rgb, resolution, em_names, grid=512, top=10):
    """Per-island brightness as the player sees it — printed every run.

    The atlas alone cannot answer "is this fixture too bright?": a PNG shows the
    whole scene averaged, and "a bright wall" is not the same question as "a bright
    fixture". Island ownership from the audit grid makes it answerable per object —
    the value stored for a texel IS what that surface receives.

    Fixtures and receiving surfaces are separated on purpose. A fixture island is
    EXPECTED to be bright (a Combined bake stores its own emission), so warning on
    it would be noise. What is actionable is a SURFACE island reading near white:
    that is the look the owner would want to change, by lowering that fixture's
    emission in the .blend.

    Honest limits:
      - a bright surface island means "this surface reads near white on screen", not
        necessarily "its own fixture is too strong" — light from other fixtures lands
        on it too, and a Combined bake stores outgoing radiance, albedo included.
      - only island INTERIOR cells are sampled (the margin repeats the edge colour and
        would fake a highlight).
      - the grid is a 512² sampling, so a small island owns few cells; those rows print
        their cell count and are not warned on.

    The threshold (mean display luma 0.70, max 0.985) is a stated measurement
    threshold, not a taste judgement — which value is "right" stays the author's call.
    """
    disp = agx_display(linear_rgb).reshape(resolution, resolution, 3)
    luma = disp[..., 0] * 0.2126 + disp[..., 1] * 0.7152 + disp[..., 2] * 0.0722
    rows = []
    for idx, obj in enumerate(meshes):
        cells = np.where(owner == idx)
        n = int(cells[0].size)
        if n == 0:
            continue
        # grid cell → atlas pixel. The audit raster used ys = grid-1-v*(grid-1), i.e.
        # row 0 is the TOP of the image, so row = grid-1-gy and col = gx, scaled up.
        row = np.round((grid - 1 - cells[0]) * (resolution - 1) / (grid - 1)).astype(int)
        col = np.round(cells[1] * (resolution - 1) / (grid - 1)).astype(int)
        vals = luma[row, col]
        rows.append((obj.name, obj.name in em_names, n, float(vals.mean()), float(vals.max())))
    if not rows:
        return
    rows.sort(key=lambda r: -r[3])
    print(f"bake_map: brightness report — brightest {min(top, len(rows))} of {len(rows)} islands "
          f"(AgX display luma, 0..1):")
    warned = 0
    for name, is_fixture, n, mean_l, max_l in rows[:top]:
        kind = "fixture" if is_fixture else "surface"
        flag = ""
        if not is_fixture and n >= 40 and (max_l >= 0.985 or mean_l >= 0.70):
            flag = "  <- reads near white"
            warned += 1
        print(f"  {name[:32]:<32} {kind:<7} {n:>5} px  mean {mean_l:.3f}  max {max_l:.3f}{flag}")
    if warned:
        print(f"bake_map: {warned} receiving surface(s) read near white. That is a measurement, not "
              "a verdict — if that is not the look you want, lower the emission in the .blend and "
              "re-bake.")


def save_lightmap_png(img, path, dither=True, dither_ab=False):
    """RGBM + sRGB encode: the linear bake's full HDR range in one 8-bit PNG.

    WHY (backlog #9 rule 2): plain sRGB-8 hard-clips every linear value above
    1.0 to white — the clipping_report above prints exactly how much this bake
    would lose (fixture pools flatten precisely where they are brightest).
    RGBM keeps the whole range at the same file size:

        rgb = srgb_encode( clamp(rgb_linear / m) )   per texel hue, in [0,1]
        a   = srgb_encode( m / RANGE )               per-texel max, SRGB-ENCODED
        decode: rgb_linear = srgb_decode(rgb) * srgb_decode(a) * RANGE

    WHY sRGB on BOTH channels: linear M quantizes to RANGE/255 = 0.026 here,
    which zeroes every wall/floor texel under that (this bake's rooms live at
    0.005-0.05 — measured: a linear-M first cut decoded 29.7 % of the texels
    the bake reported lit at 57.6 %). sRGB M bottoms out at RANGE*srgb(1/255)
    ≈ 0.002 with ~0.4 % relative error everywhere — shadows keep their step,
    highlights keep their falloff.

    Written by hand (zlib + struct): Blender's PNG save DROPS a fully-opaque
    alpha channel (measured — a byte image saves as color type 2), which would
    throw the M channel away. Row order matches Blender's own save, measured
    with the 2x2 probe: pixels[0] is bottom-left, so the file's first row is
    the TOP = Blender v=1 = glTF v0 — the game samples flipY=false (v=0 = top).

    Returns (file_size_bytes, range).
    """
    import struct
    import zlib

    buf = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(buf)
    w, h = img.size[0], img.size[1]
    rgb = np.clip(buf.reshape(-1, 4)[:, :3], 0.0, None)
    peak = rgb.max(axis=1)
    range_v = float(peak.max())
    if range_v <= 0.0:
        raise SystemExit("bake_map: bake produced a black image — nothing to encode")
    ratio = rgb / np.maximum(peak, 1e-20)[:, None]
    ratio[peak <= 0.0] = 0.0
    ratio = np.clip(ratio, 0.0, 1.0)
    srgb = lambda c: np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)
    enc = srgb(ratio)
    enc_m = srgb(np.clip(peak / range_v, 0.0, 1.0))

    # ---- quantization (this is where banding is created) ------------------
    # Plain rounding maps every value inside one 1/256 window to the same byte:
    # neighbouring texels in a smooth gradient share a byte, and the next byte
    # boundary becomes a visible stripe. Blue-noise ordered dithering decides the
    # byte per texel with a spatially even threshold, so the boundary is spread
    # over the gradient instead of concentrating in one line.
    def quantize(vals, mask):
        # Blender's pixel block is flat, so both sides are worked flat and the
        # image shape is restored at the end.
        q = np.asarray(vals, dtype=np.float64).ravel() * 255.0
        q = np.floor(q + mask.ravel()) if mask is not None else np.round(q)
        return np.clip(q, 0.0, 255.0).astype(np.uint8).reshape(h, w)

    def build(mask):
        out = np.empty((h, w, 4), dtype=np.uint8)
        for c in range(3):
            out[..., c] = quantize(enc.reshape(h, w, 3)[:, :, c], mask)
        # M channel sRGB-encoded too (see docstring: linear M floors dark texels
        # at RANGE/255 and blacks out the room)
        out[..., 3] = quantize(enc_m, mask)
        return out[::-1]  # pixels[] is bottom-up, PNG rows are top-down (probe-measured)

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    def encode_png(out):
        # filter 0 (None) per row — trivially re-readable by the self-audit below;
        # zlib still compresses the smooth lightmap well
        raw = b"".join(b"\x00" + out[y].tobytes() for y in range(h))
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b"")
        )

    def decode_png(png):
        """Decode the FILE back (not the buffer): the self-audit proves what a
        browser actually gets, including any mistake in the encode above."""
        ihdr_end = 8 + 4 + 4 + 13 + 4
        idat_len = struct.unpack(">I", png[ihdr_end:ihdr_end + 4])[0]
        raw = np.frombuffer(zlib.decompress(png[ihdr_end + 8:ihdr_end + 8 + idat_len]), dtype=np.uint8)
        rows = raw.reshape(h, 1 + w * 4)[:, 1:].reshape(h, w, 4)[::-1]  # file top-down -> pixels bottom-up
        lin = lambda b: np.where(b <= 0.04045, b / 12.92, ((b + 0.055) / 1.055) ** 2.4)
        dec = lin(rows[..., :3].astype(np.float64) / 255.0)
        m = lin(rows[..., 3:4].astype(np.float64) / 255.0)
        return rows, (dec * m * range_v).reshape(-1, 3)

    def report(rows, decoded, label):
        err = float(np.abs(decoded - rgb).max())
        st = plateau_stats(rows)
        # Why dithering can raise the per-pixel error and still look better: the
        # eye integrates over a few texels. If the LOCAL AVERAGE matches the true
        # value, the gradient reads smooth even though single texels are off.
        # This is the number that distinguishes "wrong" from "quantized".
        block = decoded.reshape(h, w, 3)
        br, bc = h // 8, w // 8
        blocks = block[:br * 8, :bc * 8].reshape(br, 8, bc, 8, 3).mean(axis=(1, 3))
        truth = rgb.reshape(h, w, 3)[:br * 8, :bc * 8].reshape(br, 8, bc, 8, 3).mean(axis=(1, 3))
        lit = truth.max(axis=2) > 1e-4
        berr = float(np.abs(blocks[lit] - truth[lit]).max()) if lit.any() else 0.0
        mean_berr = float(np.abs(blocks[lit] - truth[lit]).mean()) if lit.any() else 0.0
        print(
            f"bake_map: {label} · {st['levels']} distinct stored levels · "
            f"longest flat run {st['longest']} px · {st['plateau_pct']:.1f}% of the lit area "
            f"inside runs >= 8 px · {st['jumps']} value jumps · round-trip error "
            f"{err:.4f} ({100 * err / range_v:.2f}% of range) · 8x8 block error "
            f"mean {100 * mean_berr / range_v:.2f}% max {100 * berr / range_v:.2f}%"
        )
        if range_v > 1.0 and decoded.max() <= 1.0:
            raise SystemExit("bake_map: RGBM round-trip lost the >1.0 range — not shipping")
        if err > 0.05 * range_v:
            raise SystemExit(f"bake_map: RGBM round-trip error {err:.4f} too large — not shipping")

    def write(out, where):
        png = encode_png(out)
        with open(where, "wb") as fh:
            fh.write(png)
        return png

    mask = None
    if dither:
        m = blue_noise_mask()
        reps = (int(np.ceil(h / m.shape[0])), int(np.ceil(w / m.shape[1])))
        mask = np.tile(m, reps)[:h, :w]

    label = f"blue-noise dither {DITHER_SIZE}x{DITHER_SIZE}" if dither else "plain rounding (no dither)"
    png = write(build(mask), path)
    rows, decoded = decode_png(png)
    print(
        f"bake_map: RGBM self-audit — decoded max {decoded.max():.3f} vs linear {range_v:.3f}, "
        f"worst round-trip error {100 * float(np.abs(decoded - rgb).max()) / range_v:.2f}% of range"
    )
    report(rows, decoded, label)

    # --dither-ab: the SAME linear bake values quantized both ways, so the two
    # numbers describe only the quantization (a bake would differ run to run by
    # its own noise, which would make the comparison dishonest).
    if dither_ab:
        alt = path[:-4] + ("_plain.png" if dither else "_dither.png")
        png2 = write(build(None if dither else mask), alt)
        rows2, decoded2 = decode_png(png2)
        report(rows2, decoded2, "plain rounding (no dither)" if dither else f"blue-noise dither {DITHER_SIZE}x{DITHER_SIZE}")
        print(f"bake_map: A/B written — {path} vs {alt}")

    return len(png), range_v


def save_lightmap_bin(linear_rgb, resolution, path):
    """16-bit half-float texels: raw RGBA16F, no encode at all.

    WHY 16-bit beats RGBM-8 as STORAGE: half-float keeps RELATIVE precision. The
    lit walls of this bake live at 0.005-0.05 linear, where an 8-bit sRGB texel
    has about one display step of accuracy — that single step is exactly where the
    banding we measured comes from. A half-float texel has a relative step of
    2^-11 (~0.05 % of its own value, far under one display LSB at any brightness),
    so the stored file cannot produce a band the screen could show. No range, no
    clipping, no dither needed here: the only 8-bit step left is the DISPLAY, and
    that is where the runtime dither (src/render/bluenoise.ts) already applies.

    Stated honestly, the costs: the file is bigger (4 MB at 1024², 16 MB at 2048²),
    it is not viewable in an image viewer (the 8-bit PNG is kept as the preview and
    as the report of what the screen gets), and the loader must read raw bytes
    instead of an image. Row 0 is the TOP — same convention as the PNG and glTF v0,
    so nothing in the sampling path changes.
    """
    w = h = resolution
    vals = np.asarray(linear_rgb, dtype=np.float64).reshape(h, w, 3)
    rgba = np.zeros((h, w, 4), dtype=np.float16)
    rgba[..., :3] = vals.astype(np.float16)
    rgba[..., 3] = np.float16(1.0)
    data = rgba[::-1].tobytes()          # pixels[] is bottom-up, file row 0 is top
    with open(path, "wb") as fh:
        fh.write(data)

    # Audit reads the FILE back, not the buffer — same rule as the PNG self-audit.
    read = np.frombuffer(data, dtype=np.float16).astype(np.float64).reshape(h, w, 4)[::-1]
    dec = read[..., :3]
    peak = vals.max(axis=2)
    lit = peak > 1e-4
    # Half-float's smallest normal value is 6.1e-5; below it the format is subnormal
    # and a relative error is meaningless (those texels are black on screen anyway).
    # Measuring only at/above the floor is the honest number.
    rep = lit & (peak >= 6.1e-5)
    rel = np.abs(dec - vals) / np.maximum(vals, 1e-12)
    err = float(rel[rep].max()) if rep.any() else 0.0
    dark = rep & (peak < 0.05)
    print(
        f"bake_map: half-float self-audit — decoded max {dec.max():.4f} vs linear {vals.max():.4f} "
        f"(nothing clips) · worst relative error at representable values {100 * err:.4f}% · "
        f"dark lit area (<0.05) mean relative error "
        f"{100 * float(rel[dark].mean()) if dark.any() else 0.0:.4f}% · "
        f"{int((lit & ~rep).sum())} lit texels under half's floor 6.1e-5 (black on screen)"
    )
    # What an 8-bit display still sees: the file is exact, the screen is not. This
    # is why the runtime dither stays in the pipeline — measure the storage step in
    # display LSBs, which is the unit the eye actually resolves.
    print("bake_map: storage step in display LSBs (AgX, exposure 1):")
    for v in (0.002, 0.005, 0.02, 0.05, 0.2, 1.0, 4.0):
        ulp = float(np.nextafter(np.float16(v), np.float16(np.inf)) - np.float16(v))
        lsb = float((agx_display(np.array([v + ulp, 0.0, 0.0]))[0]
                     - agx_display(np.array([v, 0.0, 0.0]))[0]) * 255.0)
        print(f"bake_map:   linear {v:>6.3f} · half step {ulp:.6f} -> {lsb:.3f} display LSB "
              f"{'(display saturates above 1.0, so no band is possible here)' if v > 1.0 else '(8-bit sRGB puts a whole band here)'}")
    print("bake_map: so 16-bit removes banding at STORAGE; the screen's 8-bit step "
          "is still handled by the runtime dither (src/render/bluenoise.ts)")
    return len(data), err


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


def patch_manifest(out_dir, resolution, lm_range, bits=16):
    """Add the additive lightmap entry — the loader ignores unknown manifest
    fields today, so this is safe for every existing consumer (same JSON
    formatting as export_map.py so the diff is only the new block).

    `encoding` is the decode contract:
      "half" -> the file is raw RGBA16F, the loader reads it as bytes (no image
               decode, no range, nothing clips). `preview` names the 8-bit PNG.
      "rgbm" -> legacy 8-bit PNG: linear = srgbDecode(rgb) * srgbDecode(a) * range.
    `range` stays in the block as the measured maximum radiance (the bake report
    prints it), so a run can be compared against the report without re-baking."""
    path = os.path.join(out_dir, "manifest.json")
    with open(path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    manifest["lightmap"] = {
        "file": "lightmap.bin" if bits == 16 else "lightmap.png",
        "resolution": resolution,
        "uv": "TEXCOORD_1",
        "encoding": "half" if bits == 16 else "rgbm",
        "bits": bits,
        "preview": "lightmap.png",
        "range": round(lm_range, 6),
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"bake_map: manifest.json += lightmap ({manifest['lightmap']['file']}, {resolution}px, "
          f"TEXCOORD_1, {manifest['lightmap']['encoding']}, preview lightmap.png)")


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

    overlap, owner_grid = audit_uv_overlap(meshes)
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
    mean, max_v, nonzero, linear_rgb = buffer_stats(img)
    print(f"bake_map: baked in {duration:.1f}s — linear buffer mean {mean:.4f}, "
          f"max {max_v:.4f}, non-black {nonzero * 100:.1f}%")
    clipping_report(linear_rgb)
    # Emissive names come from the manifest export_map.py wrote earlier in THIS run —
    # the same source of truth as the .glb, so the fixture/surface split does not
    # re-implement the emission lookup.
    try:
        with open(os.path.join(out_dir, "manifest.json"), encoding="utf-8") as fh:
            em_names = {e["name"] for e in json.load(fh).get("emissive", {}).get("exported", [])}
    except (OSError, ValueError):
        em_names = set()
    fixture_report(owner_grid, meshes, linear_rgb, resolution, em_names)
    if max_v <= 0.0:
        raise SystemExit("bake_map: bake produced a black image — no light reached the baker")

    png_path = os.path.join(out_dir, "lightmap.png")
    if args["bits"] == 16:
        print("bake_map: the 8-bit report below describes what an UNDITHERED 8-bit display "
              "would show — the game file is the 16-bit one, and its storage step is below 1 "
              "display LSB, so banding here can only come from the screen, where the runtime "
              "dither already applies.")
    size, lm_range = save_lightmap_png(img, png_path, args["dither"], args["dither_ab"])
    role = "the game file" if args["bits"] == 8 else "the human preview + the report of what an 8-bit screen gets"
    print(f"bake_map: wrote {png_path} ({size // 1024} KB, RGBM sRGB 8-bit RGBA, range {lm_range:.3f}) — {role}")

    if args["bits"] == 16:
        bin_path = os.path.join(out_dir, "lightmap.bin")
        bin_size, _ = save_lightmap_bin(linear_rgb, resolution, bin_path)
        print(f"bake_map: wrote {bin_path} ({bin_size // 1024} KB, raw RGBA16F, row 0 = top) — the game file")

    unwire(added_nodes, temp_mats)
    bpy.data.images.remove(img)

    if not export_objects_glb(out_dir):
        raise SystemExit("bake_map: objects.glb re-export failed — not patching the manifest")
    verify_texcoord1(os.path.join(out_dir, "objects.glb"))
    patch_manifest(out_dir, resolution, lm_range, args["bits"])
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
