"""Build the permanent testmap scene (Blender CLI, background mode).

    tools/build_testmap.sh
    # = blender -b --python tools/build_testmap.py -- --blend assets/source/testmap.blend
    #   then the REAL pipeline on that file (export_map.py + bake_map.py +
    #   write_lightgrid.mjs), writing assets/testmap/

This script only AUTHORS the scene and saves the .blend. It never exports and never
writes a manifest: the .glb and manifest.json come from tools/export_map.py and
tools/bake_map.py in the run that follows, so the testmap cannot grow a second copy
of the export rules and drift away from a real author's map.

What is inside (one object per feature, names the check reads):

    Room A  — no fixtures: ramps 15/30/45 deg, one staircase, a narrow passage, a
              material row. Its only light arrives through the hole in the wall.
    Room B  — closed room, sealed except the hole, one lamp inside, and the colour
              bleeding pair (a strong red wall facing a neutral grey wall).
    Room C  — fully sealed, no fixture: the control that must read zero, because
              light cannot come through a wall.
    Bay     — the emission ladder 1 / 5 / 20 / 80.
    long emitter (the shape the real map uses), and three test cases for the pipeline:
    A nested sub-collection inside 'objects', B one mesh with TWO material slots
    (plain + emissive 5, faces split by material) plus its plain comparison wall,
    C the same pair as two SEPARATE meshes so they land in different cells.
    One animated object in 'animated' with an action named 'loop'.

No automatic test path: the player walks normally, or the check stands him on the
checkpoint with src/world/teleport.ts.

Coordinate space: Blender (Z up). The export turns it into glTF Y-up, so the game's
Y is this file's Z. Every number below is Blender space.
"""

import math
import os
import sys

import bpy

RESOLUTION_DEFAULT = 512
SAMPLES_DEFAULT = 64
# The hole in the wall between Room A and Room B: 0.6 x 0.6 m at (y, z).
HOLE = (3.7, 4.3, 1.2, 1.8)
# The point the check teleports the player to (feet position, Blender space). Chosen so
# the point's own cell is the RoomA_floor island: a point on the floor of the room that
# has no fixture, so everything it reads must arrive through the hole in the wall.
TELEPORT = (4.5, 5.5, 0.0)


def parse_args():
    """Everything after the `--` separator, same style as export_map.parse_args:
    unknown flags are skipped, so one flag block serves build, export and bake."""
    out = {"blend": "assets/source/testmap.blend", "out": "assets/testmap",
           "resolution": RESOLUTION_DEFAULT, "samples": SAMPLES_DEFAULT, "weld": False}
    if "--" not in sys.argv:
        return out
    args = sys.argv[sys.argv.index("--") + 1:]
    i = 0
    while i < len(args):
        if args[i] in ("--blend", "--out", "--samples", "--resolution") and i + 1 < len(args):
            key = args[i].lstrip("-")
            out[key if key in out else "out"] = args[i + 1]
            i += 2
        elif args[i] == "--weld":
            out["weld"] = True
            i += 1
        else:
            i += 1
    return out


args = parse_args()

# ---- clean slate: a fresh background process inherits nothing ---------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for coll in list(bpy.data.collections):
    bpy.data.collections.remove(coll)
for mat in list(bpy.data.materials):
    bpy.data.materials.remove(mat)
for action in list(bpy.data.actions):
    bpy.data.actions.remove(action)


def make_collection(name, parent=None):
    coll = bpy.data.collections.new(name)
    if parent is None:
        bpy.context.scene.collection.children.link(coll)
    else:
        parent.children.link(coll)
    return coll


def link_only(obj, coll):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


def flat_material(name, color, roughness=0.9, metallic=0.0):
    """The authoring rule (docs/blender-conventions.md): Principled BSDF, base colour
    + roughness + metallic only, no textures."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def emissive_material(name, color, strength):
    mat = flat_material(name, color)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
    bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def add_mesh(name, verts, faces, materials, coll, uv_scale=1.0):
    """One mesh. `faces` are vertex-index loops; `quad` below guarantees the winding.

    Authoring UV: box projection, 1 UV unit = 1 m. The LightMap layer is added and
    packed by tools/bake_map.py — this layer (TEXCOORD_0) is never touched by the bake.
    """
    me = bpy.data.meshes.new(name)
    me.from_pydata([list(v) for v in verts], [], [list(f) for f in faces])
    for m in materials:
        me.materials.append(m)
    layer = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        n = poly.normal
        axis = max(range(3), key=lambda k: abs(n[k]))
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u, v = (co.y, co.z) if axis == 0 else (co.x, co.z) if axis == 1 else (co.x, co.y)
            layer.data[li].uv = (u * uv_scale, v * uv_scale)
    me.update()
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    return obj


def quad(name, corners, material, coll, air_normal):
    """One planar face. The corner order is flipped if needed so the winding faces the
    AIR side — the contract in docs/blender-conventions.md: a face turned into the wall
    makes its light cells read the back of the surface."""
    e1 = [corners[1][k] - corners[0][k] for k in range(3)]
    e2 = [corners[2][k] - corners[0][k] for k in range(3)]
    n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    if sum(n[k] * air_normal[k] for k in range(3)) < 0:
        corners = [corners[0], corners[3], corners[2], corners[1]]
    return add_mesh(name, corners, [list(range(4))], [material], coll)


objects = make_collection("objects")
nested = make_collection("props_nested", parent=objects)
animated = make_collection("animated")
checkpoints = make_collection("checkpoints")

GREY = flat_material("M_grey", (0.62, 0.62, 0.62))
UP, DOWN = (0, 0, 1), (0, 0, -1)
PX, MX, PY, MY = (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)

# ---- Room A: x 0..14, y 0..8, z 0..3, NO fixtures (its light comes through the hole)
quad("RoomA_floor", [(0, 0, 0), (14, 0, 0), (14, 8, 0), (0, 8, 0)], GREY, objects, UP)
quad("RoomA_ceiling", [(0, 8, 3), (14, 8, 3), (14, 0, 3), (0, 0, 3)], GREY, objects, DOWN)
quad("RoomA_wall_south", [(0, 0, 0), (0, 0, 3), (14, 0, 3), (14, 0, 0)], GREY, objects, PY)
# north wall in two parts: the gap at x 6..6.6 is the entrance to the narrow passage
quad("RoomA_wall_north_a", [(0, 8, 0), (0, 8, 3), (6, 8, 3), (6, 8, 0)], GREY, objects, MY)
quad("RoomA_wall_north_b", [(6.6, 8, 0), (6.6, 8, 3), (14, 8, 3), (14, 8, 0)], GREY, objects, MY)
quad("RoomA_wall_west", [(0, 0, 0), (0, 8, 0), (0, 8, 3), (0, 0, 3)], GREY, objects, PX)

# ---- the wall with the hole: x = 14, opening 0.6 x 0.6 at y 3.7..4.3, z 1.2..1.8
h0, h1, z0, z1 = HOLE
# Four quads that tile the wall MINUS the opening (no overlap, nothing else uncovered):
# left and right run the full height, below and above are the strips under and over the
# hole. Their areas add up to 8*3 - 0.6*0.6, which the check verifies.
quad("Wall_hole_left",  [(14, 0,  0), (14, h0, 0), (14, h0, 3), (14, 0,  3)], GREY, objects, MX)
quad("Wall_hole_right", [(14, h1, 0), (14, 8,  0), (14, 8,  3), (14, h1, 3)], GREY, objects, MX)
quad("Wall_hole_below", [(14, h0, 0), (14, h1, 0), (14, h1, z0), (14, h0, z0)], GREY, objects, MX)
quad("Wall_hole_above", [(14, h0, z1), (14, h1, z1), (14, h1, 3), (14, h0, 3)], GREY, objects, MX)

# ---- Room B: closed room, x 14..20, y 0..6, z 0..3. Sealed except the hole ----
quad("RoomB_floor", [(14, 0, 0), (20, 0, 0), (20, 6, 0), (14, 6, 0)], GREY, objects, UP)
quad("RoomB_ceiling", [(14, 6, 3), (20, 6, 3), (20, 0, 3), (14, 0, 3)], GREY, objects, DOWN)
quad("RoomB_wall_south", [(14, 0, 0), (14, 0, 3), (20, 0, 3), (20, 0, 0)], GREY, objects, PY)
quad("RoomB_wall_north", [(14, 6, 0), (14, 6, 3), (20, 6, 3), (20, 6, 0)], GREY, objects, MY)
quad("RoomB_wall_east", [(20, 0, 0), (20, 6, 0), (20, 6, 3), (20, 0, 3)], GREY, objects, MX)
quad("L_roomB_lamp", [(16.7, 3.0, 2.9), (17.3, 3.0, 2.9), (17.3, 3.0, 3.5), (16.7, 3.0, 3.5)],
     emissive_material("M_lamp", (1.0, 0.93, 0.80), 12.0), objects, MY)

# colour bleeding inside Room B: a strong red wall facing a neutral grey wall,
# 2 m apart. The grey island must show the red bounce — that is the measurement.
RED = flat_material("M_red", (0.85, 0.14, 0.11))
NEUTRAL = flat_material("M_neutral_grey", (0.50, 0.50, 0.50))
quad("Bleed_wall_red", [(15.0, 2.0, 0), (18.0, 2.0, 0), (18.0, 3, 0), (15.0, 3, 0)], RED, objects, PY)
quad("Bleed_wall_neutral", [(15.0, 4.0, 0), (18.0, 4.0, 0), (18.0, 4.0, 3), (15.0, 4.0, 3)],
     NEUTRAL, objects, MY)

# ---- Room C: fully sealed, no fixture. Its cells must read zero --------------
CX0, CX1, CY0, CY1 = 22, 26, 12, 16
quad("RoomC_floor", [(CX0, CY0, 0), (CX1, CY0, 0), (CX1, CY1, 0), (CX0, CY1, 0)], GREY, objects, UP)
quad("RoomC_ceiling", [(CX0, CY1, 3), (CX1, CY1, 3), (CX1, CY0, 3), (CX0, CY0, 3)], GREY, objects, DOWN)
quad("RoomC_wall_south", [(CX0, CY0, 0), (CX0, CY0, 3), (CX1, CY0, 3), (CX1, CY0, 0)], GREY, objects, PY)
quad("RoomC_wall_north", [(CX0, CY1, 0), (CX0, CY1, 3), (CX1, CY1, 3), (CX1, CY1, 0)], GREY, objects, MY)
quad("RoomC_wall_west", [(CX0, CY0, 0), (CX0, CY1, 0), (CX0, CY1, 3), (CX0, CY0, 3)], GREY, objects, PX)
quad("RoomC_wall_east", [(CX1, CY0, 0), (CX1, CY1, 0), (CX1, CY1, 3), (CX1, CY0, 3)], GREY, objects, MX)

# ---- emission ladder 1 / 5 / 20 / 80, in its own closed bay ------------------
BX0, BX1, BY0, BY1 = 28, 32, 12, 16
quad("Bay_floor", [(BX0, BY0, 0), (BX1, BY0, 0), (BX1, BY1, 0), (BX0, BY1, 0)], GREY, objects, UP)
quad("Bay_ceiling", [(BX0, BY1, 3), (BX1, BY1, 3), (BX1, BY0, 3), (BX0, BY0, 3)], GREY, objects, DOWN)
quad("Bay_wall_south", [(BX0, BY0, 0), (BX0, BY0, 3), (BX1, BY0, 3), (BX1, BY0, 0)], GREY, objects, PY)
quad("Bay_wall_north", [(BX0, BY1, 0), (BX0, BY1, 3), (BX1, BY1, 3), (BX1, BY1, 0)], GREY, objects, MY)
quad("Bay_wall_west", [(BX0, BY0, 0), (BX0, BY1, 0), (BX0, BY1, 3), (BX0, BY0, 3)], GREY, objects, PX)
quad("Bay_wall_east", [(BX1, BY0, 0), (BX1, BY1, 0), (BX1, BY1, 3), (BX1, BY0, 3)], GREY, objects, MX)
LADDER = [("L_ladder_1", 1.0), ("L_ladder_5", 5.0), ("L_ladder_20", 20.0), ("L_ladder_80", 80.0)]
for i, (name, strength) in enumerate(LADDER):
    x = BX0 + 0.6 + i * 0.8
    quad(name, [(x, BY0 + 1.5, 2.9), (x + 0.3, BY0 + 1.5, 2.9), (x + 0.3, BY0 + 1.5, 3.2),
                (x, BY0 + 1.5, 3.2)], emissive_material(f"M_ladder_{int(strength)}",
                (1.0, 0.95, 0.85), strength), objects, DOWN)

# ---- long emitter, the shape the real map uses (4.8 m strip, strength 8) -----
quad("L_strip_long", [(12.5, 6.4, 2.9), (17.3, 6.4, 2.9), (17.3, 6.4, 3.2), (12.5, 6.4, 3.2)],
     emissive_material("M_strip", (1.0, 0.95, 0.85), 8.0), objects, DOWN)

# ---- ramps: one face each, angle = atan(rise / run) -------------------------
def ramp(name, x0, angle_deg, run):
    rise = run * math.tan(math.radians(angle_deg))
    quad(name, [(x0, 1.0, 0), (x0 + run, 1.0, rise), (x0 + run, 2.0, rise), (x0, 2.0, 0)],
         GREY, objects, UP)

ramp("Ramp_15", 0.5, 15, 4.0)
ramp("Ramp_30", 5.5, 30, 3.0)
ramp("Ramp_45", 9.5, 45, 2.5)

# ---- staircase: 12 steps, rise 0.15 m, run 0.30 m ---------------------------
sv, sf = [], []
sx, sy = 1.0, 5.0
for i in range(12):
    za, zb = i * 0.15, (i + 1) * 0.15
    xa, xb = sx + i * 0.30, sx + (i + 1) * 0.30
    b = len(sv)
    sv += [(xa, sy, za), (xb, sy, za), (xb, sy, zb), (xa, sy, zb)]
    # corner order reversed so the riser faces the AIR side (+Y), the contract in
    # docs/blender-conventions.md; the plain 0-1-2-3 order would point it into the step
    sf.append([b, b + 3, b + 2, b + 1])          # riser, air side +Y
    sv += [(xa, sy, zb), (xb, sy, zb), (xb, sy + 1.0, zb), (xa, sy + 1.0, zb)]
    sf.append([b + 4, b + 5, b + 6, b + 7])      # tread, air side +Z

stairs = add_mesh("Stairs_12", sv, sf, [GREY], objects)
for poly in stairs.data.polygons:
    poly.material_index = 0

# ---- narrow passage: 0.6 m wide, 2.2 m high, 4 m long, open to Room A --------
nx0, nx1, ny0, ny1, nh = 6.0, 6.6, 8.0, 12.0, 2.2
quad("Narrow_floor", [(nx0, ny0, 0), (nx1, ny0, 0), (nx1, ny1, 0), (nx0, ny1, 0)], GREY, objects, UP)
quad("Narrow_ceiling", [(nx0, ny0, nh), (nx1, ny0, nh), (nx1, ny1, nh), (nx0, ny1, nh)], GREY, objects, DOWN)
quad("Narrow_wall_left", [(nx0, ny0, 0), (nx0, ny1, 0), (nx0, ny1, nh), (nx0, ny0, nh)], GREY, objects, PX)
quad("Narrow_wall_right", [(nx1, ny0, 0), (nx1, ny1, 0), (nx1, ny1, nh), (nx1, ny0, nh)], GREY, objects, MX)
quad("Narrow_end_wall", [(nx0, ny1, 0), (nx1, ny1, 0), (nx1, ny1, nh), (nx0, ny1, nh)], GREY, objects, MY)

# ---- material row: colour / roughness / metallic only -----------------------
ROW = [
    ((0.20, 0.60, 0.35), 0.10, 0.0),
    ((0.20, 0.60, 0.35), 0.90, 0.0),
    ((0.80, 0.25, 0.25), 0.50, 0.0),
    ((0.10, 0.10, 0.10), 0.50, 0.0),
    ((0.80, 0.80, 0.80), 0.50, 1.0),
    ((0.80, 0.80, 0.80), 0.10, 1.0),
]
for i, (color, rough, metal) in enumerate(ROW):
    x = 2.0 + i * 1.0
    quad(f"Mat_row_{i + 1:02d}", [(x, 6.0, 0.05), (x + 0.5, 6.0, 0.05),
                                  (x + 0.5, 6.0, 0.55), (x, 6.0, 0.55)],
         flat_material(f"M_row_{i + 1:02d}", color, rough, metal), objects, PY)

# ---- test case A: a NESTED collection inside 'objects' ----------------------
nx, ny = 12.0, 6.0
add_mesh("Nested_cube", [(nx, ny, 0.0), (nx + 0.4, ny, 0.0), (nx + 0.4, ny + 0.4, 0.0),
                         (nx, ny + 0.4, 0.0), (nx, ny, 0.4), (nx + 0.4, ny, 0.4),
                         (nx + 0.4, ny + 0.4, 0.4), (nx, ny + 0.4, 0.4)],
         [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
         [flat_material("M_nested", (0.45, 0.45, 0.55))], nested)
quad("L_nested_fixture", [(12.8, 6.6, 2.4), (13.1, 6.6, 2.4), (13.1, 6.6, 2.7), (13.1, 6.6, 2.7)],
     emissive_material("M_nested_light", (0.90, 0.90, 1.00), 3.0), nested, DOWN)

# ---- test case B: one mesh, TWO material slots (a plain face + an emissive face)
# Owner decision 2026-11-23: the second slot IS a light source for the world grid —
# "emission" and "glow" are the same thing. One mesh node, faces split by material in
# edit mode, emission 5. It stays ONE object, so the grid sees ONE island for it.
# Both faces sit in the SAME cell, and the plain comparison wall is in that cell too:
# that is what makes the self-light rule measurable (own faces are skipped, a different
# island in the same cell is not).
twoslot = add_mesh(
    "TwoSlot_panel",
    [(11.0, 7.0, 2.85), (11.5, 7.0, 2.85), (11.5, 7.0, 3.15), (11.0, 7.0, 3.15),
     (11.5, 7.0, 2.85), (12.0, 7.0, 2.85), (12.0, 7.0, 3.15), (11.5, 7.0, 3.15)],
    [[0, 1, 2, 3], [4, 5, 6, 7]],
    [flat_material("M_twoslot_plain", (0.50, 0.50, 0.50)),
     emissive_material("M_twoslot_emissive", (1.00, 0.90, 0.80), 5.0)],
    objects,
)
for idx in range(len(twoslot.data.polygons)):
    twoslot.data.polygons[idx].material_index = idx

# comparison wall: same size, same plain material, no emission, same cell as the panel
quad("Plain_wall_ref", [(12.0, 7.0, 2.85), (12.5, 7.0, 2.85), (12.5, 7.0, 3.15), (12.0, 7.0, 3.15)],
     flat_material("M_twoslot_plain", (0.50, 0.50, 0.50)), objects, MY)

# ---- test case C: the option the owner mentioned — faces in SEPARATE meshes ----------
# Two meshes of the same size, one plain, one emissive 5, 3 m apart so they land in
# DIFFERENT cells (the cell size here is about 2.5 m). There the emissive island is not
# `own`, so it can light the plain island's cell. 2 x 2 m, because a 0.5 x 0.5 m quad
# 3 m away subtends too little of the sphere for 512 rays to hit it at all — the first
# run measured zero hits on a small quad, which is ray noise, not the rule.
OX0, OY0 = 34.0, 12.0
quad("Split_emissive", [(OX0, OY0 + 2.0, 1.0), (OX0 + 2.0, OY0 + 2.0, 1.0),
                        (OX0 + 2.0, OY0 + 2.0, 3.0), (OX0, OY0 + 2.0, 3.0)],
     emissive_material("M_split_emissive", (1.00, 0.90, 0.80), 5.0), objects, PX)
quad("Split_plain", [(OX0 + 3.0, OY0 + 2.0, 1.0), (OX0 + 5.0, OY0 + 2.0, 1.0),
                     (OX0 + 5.0, OY0 + 2.0, 3.0), (OX0 + 3.0, OY0 + 2.0, 3.0)],
     flat_material("M_twoslot_plain", (0.50, 0.50, 0.50)), objects, MX)

# ---- animated: a moving object, the action must be named 'loop' -------------
bpy.ops.mesh.primitive_cube_add(size=0.4, location=(9.0, 3.5, 0.4))
runner = bpy.context.object
runner.name = "Animated_runner"
runner.data.materials.append(flat_material("M_runner", (0.60, 0.30, 0.30)))
link_only(runner, animated)

action = bpy.data.actions.new("loop")
runner.animation_data_create()
runner.animation_data.action = action
for frame, pos in ((1, (9.0, 3.5, 0.4)), (40, (12.0, 3.5, 0.4)), (80, (9.0, 3.5, 0.4))):
    runner.location = pos
    runner.keyframe_insert(data_path="location", frame=frame)

# ---- checkpoints: the teleport point (no automatic test path) ---------------
bpy.ops.object.empty_add(type="SPHERE", location=TELEPORT)
tp = bpy.context.object
tp.name = "CP_teleport_cell"
tp["label"] = "Teleport · own cell"
tp["kind"] = "respawn"
tp["radius"] = 1.0
link_only(tp, checkpoints)

bpy.ops.object.empty_add(type="SPHERE", location=(2.0, 4.0, 0.0))
sp = bpy.context.object
sp.name = "CP_spawn"
sp["label"] = "Spawn · Room A"
sp["kind"] = "spawn"
sp["radius"] = 1.0
link_only(sp, checkpoints)

# ---- the world: background strength 0 ---------------------------------------
# Room C is the control that must read exactly 0. Blender's default World has a Background with
# strength 1.0, and Cycles starts each ray with an offset from the surface, so a little of that
# light leaks through the zero-thickness quads: measured on 2026-11-23, 871 of 8930 texels inside
# Room C's own island rectangles were non-zero (max 5.62e-7). With strength 0 the control can be
# asserted at tolerance 0 — the room holds no fixture, so any number above 0 is a bug, not noise.
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0

blend_path = args["blend"]
os.makedirs(os.path.dirname(blend_path) or ".", exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=blend_path)
mesh_count = len([o for o in objects.all_objects if o.type == "MESH"])
print(f"build_testmap: {blend_path} — {mesh_count} mesh objects in 'objects' "
      f"({len(nested.all_objects)} of them in the nested sub-collection 'props_nested'), "
      f"1 in 'animated' (action '{runner.animation_data.action.name}'), "
      f"{len(checkpoints.all_objects)} checkpoints, teleport point {TELEPORT}")
