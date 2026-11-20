#!/usr/bin/env bash
# Export a liminal .blend to the game's asset layout (Draco .glb + manifest).
#
#   tools/export_map.sh [--weld] [--bake] path/to/map.blend
#
# --weld   merge coincident vertices (0.001 m) before writing — closes seams
#            that leak light in-game. OFF by default: geometry is only changed
#            when you ask for it.
# --bake   after the export, also bake the static lighting into lightmap.png
#            (second UV layer + Cycles bake + manifest "lightmap" entry) —
#            hands the whole run to tools/bake_map.sh, see "Baking" in
#            docs/blender-conventions.md.
#
# Output: assets/map/*.glb + assets/map/manifest.json
# Set OUT_DIR to write somewhere else (handy for A/B exports), BLENDER to use
# a non-default Blender binary.
set -euo pipefail

BLENDER="${BLENDER:-blender}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

usage() { echo "usage: $0 [--weld] [--bake] path/to/map.blend" >&2; }

# --bake: hand the whole run to bake_map.sh (export + lightmap bake in one
# Blender process). Scanned before the parse loop so the bake-specific flags
# (--samples/--resolution) are re-parsed there, not rejected here.
BAKE_ARGS=()
BAKE=0
for a in "$@"; do
  if [[ "$a" == "--bake" ]]; then BAKE=1; else BAKE_ARGS+=("$a"); fi
done
if [[ "$BAKE" == 1 ]]; then
  exec "$SCRIPT_DIR/bake_map.sh" "${BAKE_ARGS[@]}"
fi

BLEND=""
PY_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --weld)
      PY_ARGS+=(--weld)
      shift
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

"$BLENDER" -b "$BLEND" --python "$SCRIPT_DIR/export_map.py" -- --out "$OUT" "${PY_ARGS[@]}"
