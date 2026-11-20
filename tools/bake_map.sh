#!/usr/bin/env bash
# Export a liminal .blend AND bake its static lighting into a lightmap PNG.
#
#   tools/bake_map.sh [--weld] [--samples N] [--resolution N] path/to/map.blend
#
# One headless Blender run does both steps: export_map.py writes the .glbs +
# manifest.json, then bake_map.py adds a second UV layer, Cycles-bakes the
# static lighting onto it, writes lightmap.png, re-exports objects.glb with
# TEXCOORD_1 and patches the manifest with the "lightmap" entry.
#
# --weld           merge coincident vertices first (same meaning as export_map.sh;
#                   the bake sees the welded meshes in the same run)
# --samples N      Cycles bake samples (default 64)
# --resolution N   lightmap.png size, square (default 2048)
#
# Output: $OUT_DIR (default assets/map) — everything export_map.sh writes,
# plus lightmap.png and the manifest "lightmap" block.
# Set OUT_DIR to write somewhere else (handy for A/B bakes), BLENDER to use
# a non-default Blender binary. The .blend is NEVER saved (same rule as
# export_map.sh — exports are side-effect-free).
# Re-run after ANY map/light/material change — see docs/blender-conventions.md.
set -euo pipefail

BLENDER="${BLENDER:-blender}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

usage() { echo "usage: $0 [--weld] [--samples N] [--resolution N] path/to/map.blend" >&2; }

BLEND=""
PY_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --weld)
      PY_ARGS+=(--weld)
      shift
      ;;
    --samples)
      [[ $# -ge 2 ]] || { echo "error: --samples needs a value" >&2; usage; exit 1; }
      PY_ARGS+=(--samples "$2")
      shift 2
      ;;
    --resolution)
      [[ $# -ge 2 ]] || { echo "error: --resolution needs a value" >&2; usage; exit 1; }
      PY_ARGS+=(--resolution "$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$BLEND" ]]; then
        echo "error: more than one .blend given" >&2
        usage
        exit 1
      fi
      BLEND="$1"
      shift
      ;;
  esac
done

if [[ -z "$BLEND" ]]; then
  usage
  exit 1
fi

if [[ ! -f "$BLEND" ]]; then
  echo "error: no such file: $BLEND" >&2
  exit 1
fi

OUT="${OUT_DIR:-$REPO_DIR/assets/map}"
mkdir -p "$OUT"

# ONE headless Blender run: export_map.py first (writes manifest.json, which
# bake_map.py then patches), bake_map.py second. Both scripts parse the same
# argv tail after `--`.
"$BLENDER" -b "$BLEND" \
  --python "$SCRIPT_DIR/export_map.py" \
  --python "$SCRIPT_DIR/bake_map.py" \
  -- --out "$OUT" "${PY_ARGS[@]}"
