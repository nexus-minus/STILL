"""The five material values a glTF file must carry, shared by export_map.py and bake_map.py.

Helper functions only, nothing runs at import, so both scripts can import it. export_map.py runs
its whole export at import time, so it cannot be imported from bake_map.py — the parts both need
live here.

Owner decision 2026-11-23: a field that is not in the file cannot be checked at tolerance 0, so the
pipeline writes all five material values for every material. Both scripts must do it, because
bake_map.py re-exports objects.glb after the bake and a plain re-export writes only the fields that
differ from the glTF default: measured on the test map, export_map added 29 fields to objects.glb,
the re-export dropped all 29 again, and the manifest still claimed every field was written. So the
rule is applied at the END of the pipeline, on the file that actually ships.

Defaults are the glTF 2.0 spec values (material.schema.json,
material.pbrMetallicRoughness.schema.json, the KHR_materials_emissive_strength README), NOT the
Blender Principled defaults — the difference is what the audit flags.
"""
import json
import struct

import bpy

GLTF_DEFAULTS = {
    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
    "metallicFactor": 1.0,
    "roughnessFactor": 1.0,
    "emissiveFactor": [0.0, 0.0, 0.0],
    "emissiveStrength": 1.0,
}

# field name in the file -> Blender input name
PRINCIPLED_INPUTS = {
    "baseColorFactor": "Base Color",
    "metallicFactor": "Metallic",
    "roughnessFactor": "Roughness",
    "emissiveFactor": "Emission Color",
    "emissiveStrength": "Emission Strength",
}


def glb_chunks(path):
    """A .glb split into (JSON document, BIN chunk). (None, None) for a file that is not a glb."""
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        if len(data) < 12 or data[:4] != b"glTF":
            return None, None
        clen, ctype = struct.unpack("<II", data[12:20])
        if ctype != 0x4E4F534A:  # 'JSON' chunk type
            return None, None
        return json.loads(data[20:20 + clen].decode("utf-8")), data[20 + clen:]
    except (OSError, ValueError, struct.error):
        return None, None


def glb_json(path):
    """Parse a .glb's JSON chunk — node/material structure survives Draco."""
    return glb_chunks(path)[0]


def authored_fields(mat):
    """The five material values as the author set them in the Principled BSDF, or None."""
    tree = getattr(mat, "node_tree", None)
    if tree is None:
        return None
    bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return None
    values = {}
    for field, input_name in PRINCIPLED_INPUTS.items():
        pin = bsdf.inputs.get(input_name)
        if pin is None:
            return None
        value = pin.default_value
        # Blender returns an IDPropertyArray for colour inputs and a plain float for the scalar
        # ones, so the shape has to be checked instead of assumed.
        values[field] = ([round(float(v), 6) for v in list(value)[:4]] if hasattr(value, "__len__")
                         else round(float(value), 6))
    return values


def write_material_fields(path):
    """Write every material field into the .glb, so a reader never has to assume one.

    Blender's exporter skips a field when it equals the glTF default. This writes the AUTHORED
    value for all five fields of every material, so the game renders the same picture — only the
    record changes. The BIN chunk and every accessor offset are copied unchanged; the JSON chunk is
    re-padded to the multiple of 4 the spec requires, and the extension is declared in
    extensionsUsed/Required.

    Returns (fields already present, fields this call added), so the caller can say what the file
    actually contains afterwards instead of what an earlier step wrote into it.
    """
    doc, bin_chunk = glb_chunks(path)
    if doc is None:
        return 0, 0
    present, added = 0, 0
    for mat in doc.get("materials", []):
        values = authored_fields(bpy.data.materials.get(mat.get("name") or ""))
        if values is None:
            continue
        pbr = mat.setdefault("pbrMetallicRoughness", {})
        for field in ("baseColorFactor", "metallicFactor", "roughnessFactor"):
            if pbr.get(field) is None:
                pbr[field] = values[field]
                added += 1
            else:
                present += 1
        if mat.get("emissiveFactor") is None:
            mat["emissiveFactor"] = values["emissiveFactor"]
            added += 1
        else:
            present += 1
        ext = mat.setdefault("extensions", {}).setdefault("KHR_materials_emissive_strength", {})
        if ext.get("emissiveStrength") is None:
            ext["emissiveStrength"] = values["emissiveStrength"]
            added += 1
        else:
            present += 1

    used = sorted(set(doc.get("extensionsUsed") or []) | {"KHR_materials_emissive_strength"})
    required = sorted(set(doc.get("extensionsRequired") or []) | {"KHR_materials_emissive_strength"})
    doc["extensionsUsed"], doc["extensionsRequired"] = used, required

    payload = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    payload += b" " * ((-len(payload)) % 4)          # the spec pads the JSON chunk to 4 bytes
    bin_chunk += b"\x00" * ((-len(bin_chunk)) % 4)
    with open(path, "wb") as fh:
        fh.write(b"glTF")
        fh.write(struct.pack("<II", 2, 12 + 8 + len(payload) + len(bin_chunk)))
        fh.write(struct.pack("<II", len(payload), 0x4E4F534A))  # 'JSON'
        fh.write(payload)
        fh.write(struct.pack("<II", len(bin_chunk), 0x004E4942))  # 'BIN\0'
        fh.write(bin_chunk)
    return present, added
