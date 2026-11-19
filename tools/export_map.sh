#!/usr/bin/env bash
# Export a liminal .blend to the game's asset layout (Draco .glb + manifest).
#
#   tools/export_map.sh [--weld] path/to/map.blend
#
# --weld   merge coincident vertices (0.001 m) before writing — closes seams
#            that leak light in-game. OFF by default: geometry is only changed
#            when you ask for it.
#
# Output: assets/map/*.glb + assets/map/manifest.json
# Set OUT_DIR to write somewhere else (handy for A/B exports), BLENDER to use
# a non-default Blender binary.
set -euo pipefail

BLENDER="${BLENDER:-blender}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

usage() { echo "usage: $0 [--weld] path/to/map.blend" >&2; }

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
