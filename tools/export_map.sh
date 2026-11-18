#!/usr/bin/env bash
# Export every Blender collection named Chunk_* to a Draco-compressed .glb.
#
#   tools/export_map.sh path/to/map.blend
#
# Output: assets/map/*.glb + assets/map/manifest.json
# Requires Blender on PATH (or set BLENDER=/path/to/blender).
set -euo pipefail

BLENDER="${BLENDER:-blender}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 path/to/map.blend" >&2
  exit 1
fi

BLEND="$1"
if [[ ! -f "$BLEND" ]]; then
  echo "error: no such file: $BLEND" >&2
  exit 1
fi

mkdir -p "$REPO_DIR/assets/map"

"$BLENDER" -b "$BLEND" --python "$SCRIPT_DIR/export_map.py" -- --out "$REPO_DIR/assets/map"
