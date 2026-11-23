#!/usr/bin/env bash
# Export a liminal .blend, bake static light, and write a half-float game file.
#
#   tools/bake_map.sh [--weld] [--samples N] [--resolution N] [--dither|--no-dither] path/to/map.blend
#
# One headless Blender run exports GLBs + manifest, bakes to lightmap.bin and
# preview PNG, re-exports TEXCOORD_1, and patches the manifest. A native
# Blender crash is retried in a fresh CPU-only process.
#
# --weld           merge coincident vertices first (same meaning as export_map.sh;
#                   the bake sees the welded meshes in the same run)
# --samples N      Cycles bake samples (default 64)
# --resolution N   lightmap.png size, square (default 2048)
# --dither         blue-noise ordered dither on the 8-bit encode (ON by default)
# --no-dither      plain rounding — only for the A/B, see scripts/banding-check.mjs
# --dither-ab      write both variants in one bake so the numbers compare fairly
#                  (same linear values, quantized two ways); writes a second PNG
# --bits 16|8      storage precision. 16 (default) writes lightmap.bin as raw
#                  RGBA16F: relative precision everywhere, no range, nothing
#                  clips, no dither needed at storage. 8 keeps the RGBM PNG as the
#                  game file (the comparison). lightmap.png is always written.
#
# Output: $OUT_DIR (default assets/map) — everything export_map.sh writes,
# plus lightmap.bin (game file), lightmap.png (preview + reports) and the
# manifest "lightmap" block.
# Set OUT_DIR to write somewhere else (handy for A/B bakes), BLENDER to use
# a non-default Blender binary. The .blend is NEVER saved (same rule as
# export_map.sh — exports are side-effect-free).
# Re-run after ANY map/light/material change — see docs/blender-conventions.md.
set -euo pipefail

BLENDER="${BLENDER:-blender}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

usage() { echo "usage: $0 [--weld] [--samples N] [--resolution N] [--dither|--no-dither] [--dither-ab] path/to/map.blend" >&2; }

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
    --dither)
      PY_ARGS+=(--dither)
      shift
      ;;
    --no-dither)
      PY_ARGS+=(--no-dither)
      shift
      ;;
    --dither-ab)
      PY_ARGS+=(--dither-ab)
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

# macOS Bash 3.2 errors on an empty array under `set -u`; keep output args in
# a non-empty array and append optional flags only when they exist.
BLENDER_ARGS=(--out "$OUT")
if [[ ${#PY_ARGS[@]} -gt 0 ]]; then BLENDER_ARGS+=("${PY_ARGS[@]}"); fi

run_blender() {
  "$BLENDER" -b "$BLEND" \
    --python "$SCRIPT_DIR/export_map.py" \
    --python "$SCRIPT_DIR/bake_map.py" \
    -- "${BLENDER_ARGS[@]}"
}

# Python exceptions are caught inside Blender; native GPU-driver crashes are
# not. Restart the complete pipeline on CPU after SIGSEGV so partial outputs
# get regenerated from the source .blend.
set +e
run_blender
STATUS=$?
set -e
if [[ "$STATUS" -eq 139 ]]; then
  echo "bake_map: Blender crashed (SIGSEGV); retrying the full export+bake on CPU" >&2
  set +e
  LIMINAL_BAKE_DEVICE=CPU run_blender
  STATUS=$?
  set -e
fi
if [[ "$STATUS" -ne 0 ]]; then
  echo "bake_map: Blender failed with exit code $STATUS; outputs may be incomplete — fix the Blender/driver error and run again" >&2
  exit "$STATUS"
fi

# ---- light-cell grid (the rays are cast ONCE, here, not at load) ----
# Measured on the reference scene: building 11.701 cells at 512 rays each takes 19.1 s,
# while the game reads the same grid from the file in 0.6 ms. 19 s is a load screen on a
# gaming machine and worse on a simple laptop, so it happens next to the bake.
# Without node the map simply has no grid file: the render path keeps its one-bounce ray for
# dynamic pixels, so this is a warning, not a failure.
if [[ -f "$OUT/gridsource.json" ]]; then
  if command -v node >/dev/null 2>&1; then
    node --experimental-strip-types "$SCRIPT_DIR/write_lightgrid.mjs" "$OUT"
  else
    echo "bake_map: node not found — grid file not written, dynamic pixels keep the one-bounce ray" >&2
  fi
fi
