#!/usr/bin/env bash
# Build the test map with the real pipeline: author the scene, then export and
# bake with the same scripts that produce assets/map.
#
#   tools/build_testmap.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. author the test scene and save it as a .blend (the normal pipeline never
#    saves a file; this one must, so the map is permanent)
/Applications/Blender.app/Contents/MacOS/Blender -b --python tools/build_testmap.py

# 2. export + bake, exactly the way tools/bake_map.sh does it
/Applications/Blender.app/Contents/MacOS/Blender -b assets/source/testmap.blend \
  --python tools/export_map.py --python tools/bake_map.py -- \
  --out assets/testmap --resolution 512 --samples 64 --weld

# 3. grid from the baked texels, cell size derived from the texel density
# write_lightgrid.mjs takes the directory as a plain argument, not as --out
node --experimental-strip-types tools/write_lightgrid.mjs assets/testmap
