"""Build a tiny .blend matching docs/blender-conventions.md for export testing.

    blender -b --python tools/make_fixture.py   (writes /tmp/opencode/liminal-fixture.blend)
"""

import os

import bpy

# clean slate
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for coll in list(bpy.data.collections):
    bpy.data.collections.remove(coll)
for mat in list(bpy.data.materials):
    bpy.data.materials.remove(mat)


def make_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def link_only(obj, coll):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


def flat_material(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    return mat


def emissive_material(name, color, strength):
    mat = flat_material(name, color)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
    bsdf.inputs["Emission Strength"].default_value = strength
    return mat


# ---- objects: floor + wall + emissive panel --------------------------------
objects = make_collection("objects")

bpy.ops.mesh.primitive_plane_add(size=10, location=(0, 0, 0))
floor = bpy.context.object
floor.name = "Floor"
floor.data.materials.append(flat_material("M_carpet", (0.55, 0.48, 0.3)))

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 2, 1.5))
wall = bpy.context.object
wall.name = "Wall"
wall.scale = (5, 0.2, 1.5)
wall.data.materials.append(flat_material("M_wall", (0.75, 0.7, 0.5)))

bpy.ops.mesh.primitive_plane_add(size=1.5, location=(0, 0, 3))
panel = bpy.context.object
panel.name = "L_ceiling_panel"
panel.rotation_euler = (3.14159, 0, 0)
panel.data.materials.append(emissive_material("M_panel", (1.0, 0.95, 0.86), 12.0))

for obj in (floor, wall, panel):
    link_only(obj, objects)

# ---- checkpoints: clickable ------------------------------------------------
checkpoints = make_collection("checkpoints")
bpy.ops.object.empty_add(type="SPHERE", location=(-3, -3, 1))
cp = bpy.context.object
cp.name = "CP_room_a"
cp["label"] = "Beacon · Room A"
cp["kind"] = "respawn"
cp["radius"] = 1.2
link_only(cp, checkpoints)

# ---- animated: a cube with an action ---------------------------------------
animated = make_collection("animated")
bpy.ops.mesh.primitive_cube_add(size=0.6, location=(3, 0, 1))
acube = bpy.context.object
acube.name = "DriftingCube"
acube.data.materials.append(flat_material("M_cube", (0.6, 0.3, 0.3)))
acube.location = (3, 0, 1)
acube.keyframe_insert(data_path="location", frame=1)
acube.location = (3, 0, 1.8)
acube.keyframe_insert(data_path="location", frame=40)
acube.location = (3, 0, 1)
acube.keyframe_insert(data_path="location", frame=80)
link_only(acube, animated)

# ---- sound: a speaker with conventions -------------------------------------
sound = make_collection("sound")
speaker_data = bpy.data.speakers.new("hum_data")
bpy.ops.object.speaker_add(location=(0, 1.5, 2.5))
spk = bpy.context.object
spk.name = "SFX_hum"
spk.data = speaker_data
spk["file"] = "hum_loop.ogg"
spk["loop"] = True
spk["radius"] = 14
link_only(spk, sound)

# ---- playermodels -----------------------------------------------------------
playermodels = make_collection("playermodels")
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.7, location=(20, 20, 0.85))
avatar = bpy.context.object
avatar.name = "Avatar_default"
avatar.data.materials.append(flat_material("M_avatar", (0.4, 0.45, 0.5)))
link_only(avatar, playermodels)

# ---- decoy: an unknown collection that must be reported as skipped ----------
others = make_collection("misc_ideas")
bpy.ops.mesh.primitive_cube_add(size=0.2, location=(5, 5, 0.1))
link_only(bpy.context.object, others)

out = "/tmp/opencode/liminal-fixture.blend"
bpy.ops.wm.save_as_mainfile(filepath=out)
print(f"fixture written: {os.path.getsize(out)} bytes")
