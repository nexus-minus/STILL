import * as THREE from 'three/webgpu';
import { fract, nodeObject, screenCoordinate, texture } from 'three/tsl';

/**
 * Blue-noise ordered dithering.
 *
 * WHERE BANDING COMES FROM: a smooth gradient is stored in 8-bit steps. Many
 * neighbouring texels fall inside the same step, so they get the same byte, and
 * the next byte boundary shows up as a line — a band. Dithering does not add
 * information; it decides the byte per texel with a spatially even threshold, so
 * the boundary is spread over the gradient instead of concentrating in one line.
 *
 * WHY BLUE NOISE AND NOT WHITE NOISE: white noise clumps, and clumps read as
 * grain (the thing the owner explicitly does not want). Blue noise is the
 * opposite: every threshold level is spread evenly over the tile, so the
 * residual looks like a smooth gradient at normal viewing distance.
 *
 * VOID-AND-CLUSTER: start with an empty grid, place the first dot, then
 * repeatedly place the dot that is FARTHEST from the dots already placed. The
 * placement order is the dither matrix: a texel rounds up when its value's
 * fractional part passes the threshold stored at its position. This is the same
 * algorithm tools/bake_map.py uses for the bake encode, with the same seed, so
 * the bake and the runtime dither agree.
 */
export const DITHER_SIZE = 64;

/** Deterministic LCG — two runs must produce the same mask (no Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Void-and-cluster threshold matrix, stored as bytes (0 = never round up,
 * 255 = always round up). 64² = 4096 placements, each scanning the grid.
 */
export function blueNoiseMask(n = DITHER_SIZE, seed = 1): Uint8Array {
  const cells = n * n;
  const rnd = lcg(seed);
  const dist = new Float32Array(cells).fill(Infinity);
  const placed = new Uint8Array(cells);
  const order = new Uint8Array(cells);

  let cur = Math.floor(rnd() * n) * n + Math.floor(rnd() * n);
  for (let count = 0; count < cells; count++) {
    placed[cur] = 1;
    order[cur] = Math.round((count / cells) * 255);
    const cy = Math.floor(cur / n);
    const cx = cur % n;
    for (let i = 0; i < cells; i++) {
      if (placed[i]) continue;
      const iy = Math.floor(i / n);
      const ix = i % n;
      // torus distance: the tile tiles on screen, so the edge wraps
      const dy = Math.min(Math.abs(iy - cy), n - Math.abs(iy - cy));
      const dx = Math.min(Math.abs(ix - cx), n - Math.abs(ix - cx));
      const d = Math.sqrt(dy * dy + dx * dx);
      if (d < dist[i]) dist[i] = d;
    }
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < cells; i++) {
      if (!placed[i] && dist[i] > bestD) {
        bestD = dist[i];
        best = i;
      }
    }
    cur = best;
  }
  return order;
}

/**
 * The mask as a GPU texture (nearest, tiling). Stored RGBA rather than single
 * channel: a red-only texture samples to a bare f32 in WGSL and the node type
 * depends on the backend, while an RGBA texture always samples to vec4 and `.r`
 * is a plain swizzle — one less thing that can differ between WebGPU and WebGL2.
 */
export function createBlueNoiseTexture(mask = blueNoiseMask()): THREE.DataTexture {
  const bytes = new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    bytes[i * 4] = bytes[i * 4 + 1] = bytes[i * 4 + 2] = bytes[i * 4 + 3] = mask[i];
  }
  const tex = new THREE.DataTexture(bytes, DITHER_SIZE, DITHER_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Threshold at the current pixel, as a float node in [0,1). `px` is the pixel
 * index as a float vec2: for integer coordinates `fract(px / 64)` maps a texel
 * inside the tiled 64² mask, which is `px mod 64` — so no integer modulo node
 * is needed. Y is not flipped: the dither pattern has no orientation, so a
 * mirrored mask tile reads identically.
 */
export function ditherAt(tex: THREE.Texture, px: THREE.Node<'vec2'>) {
  return nodeObject(texture(tex, fract(px.div(DITHER_SIZE)))).r;
}

/**
 * One display LSB in the value the framebuffer will round.
 *
 * The offset must be applied AFTER tone mapping and sRGB encoding — that is the
 * moment the value becomes 8-bit. Applying it to linear radiance would be the
 * wrong size (the tone curve squashes highlights and stretches darks, and darks
 * are exactly where banding shows). So the caller applies renderOutput() first,
 * then adds `(threshold - 0.5) / 255`: rounding(value + threshold - 0.5) is the
 * same decision as floor(value + threshold), which is ordered dithering.
 */
export const DITHER_LSB = 1 / 255;

/**
 * The per-pixel offset to add at the 8-bit step: (threshold - 0.5) / 255.
 *
 * `screenCoordinate` is used because it IS the display pixel index — three
 * updates it from the drawing-buffer size, so pixel ratio and render scale are
 * already accounted for. A quarter-res lighting texel must not decide the
 * threshold: every pixel over that texel would get the same value and the
 * banding would survive.
 */
export function ditherOffset(tex: THREE.Texture) {
  return ditherAt(tex, screenCoordinate.div(DITHER_SIZE)).sub(0.5).mul(DITHER_LSB);
}
