/**
 * WORLD-WIDE LIGHT CELLS (lighting-plan step 6).
 *
 * A bake stores light per SURFACE position, so something that moves cannot be
 * baked — it visits many positions. This module stores light per SPACE instead:
 * a hash grid over the whole world, one order-2 spherical-harmonic (SH) probe
 * per cell. A moving object reads the cell it is in, so it gets the same light
 * as the wall next to it without any rays per frame.
 *
 * No room concept: cells are plain world voxels built from the geometry, nothing
 * is named, every cell behaves the same. Two kinds of cell, and both come from
 * geometry alone:
 *   - a SURFACE cell holds the surfaces inside it (a wall, a floor);
 *   - a SPACE cell is air that can see at least one surface, so a moving object
 *     standing in the middle of the room has a cell of its own.
 * A voxel inside solid material, or air that sees nothing, is never created.
 *
 * Pure on purpose (no DOM, no three): the same functions run headless in
 * `scripts/light-grid-check.mjs`, which is what proves the maths. The ray work
 * happens ONCE at load time, never per frame.
 */

/** 9 coefficients = SH order 2 (bands l = 0..2), per colour channel. */
export const SH_TERMS = 9;
export const SH_GRID_STRIDE_VEC4 = 10;

/** Cosine-lobe factor per band (Ramamoorthi): l = 0, 1, 2. */
/** Cosine-lobe factor per band. Exported so the check can compare the shader's literals as
 *  VALUES: WGSL cannot call Math.PI, so it must write the number these expressions produce. */
export const LOBE = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4];
export const BAND = [0, 1, 1, 1, 2, 2, 2, 2, 2];

/** Real orthonormal SH basis at a unit direction. */
export function shBasis(x: number, y: number, z: number, out: Float64Array): void {
  // c1 is sqrt(3/(4pi)) = 0.4886025119029199. The literal used to be 0.4886029218335914, which is
  // 1.7 ppm too large, so the basis was not exactly orthonormal (norm^2 of terms 1-3 was
  // 1.0000016780). Nothing visible on screen, but the check asserts the closed form, so the
  // literal is now the closed form. src/render/rt.ts carries the same number, and the executed
  // check compares shader literals against this module with tolerance 0 - both sides must move
  // together. c2 is sqrt(15/(4pi)) and was already exact.
  const c1 = 0.4886025119029199;
  const c2 = 1.0925484305920792;
  out[0] = 0.28209479177387814;
  out[1] = c1 * y;
  out[2] = c1 * z;
  out[3] = c1 * x;
  out[4] = c2 * x * y;
  out[5] = c2 * y * z;
  out[6] = 0.31539156525252005 * (3 * z * z - 1);
  out[7] = c2 * x * z;
  out[8] = 0.5462742152960396 * (x * x - y * y);
}

/** The same basis at an ARBITRARY direction, normalised first. A zero vector is not a
 *  direction, so it throws instead of quietly producing a zero basis. This is the direction
 *  form of shBasis: it takes a ray direction, not three components, so a caller that has a
 *  sampled direction does not have to unpack it. */
export function shBasisAtDirection(direction: number[], out: Float64Array): void {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) throw new RangeError('SH direction must be non-zero');
  shBasis(direction[0] / length, direction[1] / length, direction[2] / length, out);
}

/**
 * Value of the SH series in one direction, WITHOUT the cosine lobe: this is the directional
 *  field the coefficients describe (the light arriving FROM that direction), not the
 *  irradiance a surface receives. shIrradiance is the same sum with the LOBE factors.
 *  Kept as its own function on purpose, so the two quantities cannot be confused:
 *  a constant field comes out of here as itself, and through shIrradiance as pi times itself.
 *  No clamping — a truncated series can go slightly negative, and clamping would hide that.
 *  Coefficients are read in the layout projectCoefficients writes (channel-major).
 */
export function shValueAtDirection(coefs: Float64Array, direction: number[], out: Float64Array): void {
  if (coefs.length !== SH_TERMS * 3) throw new Error(`SH coefficient buffer must contain ${SH_TERMS * 3} values`);
  const basis = new Float64Array(SH_TERMS);
  shBasisAtDirection(direction, basis);
  for (let c = 0; c < 3; c++) {
    let e = 0;
    for (let i = 0; i < SH_TERMS; i++) e += coefs[c * SH_TERMS + i] * basis[i];
    out[c] = e;
  }
}

/** Irradiance for a surface normal from stored coefficients. */
export function shIrradiance(coefs: Float64Array, nx: number, ny: number, nz: number, out: Float64Array): void {
  // the basis needs its own array: out holds one value per colour channel, so it
  // cannot double as the 9-term basis it is evaluated with
  const basis = new Float64Array(SH_TERMS);
  shBasis(nx, ny, nz, basis);
  for (let c = 0; c < 3; c++) {
    let e = 0;
    for (let i = 0; i < SH_TERMS; i++) e += LOBE[BAND[i]] * coefs[c * SH_TERMS + i] * basis[i];
    out[c] = e;
  }
}

/** One geometry face: world-space vertices (9 floats) + its lightmap UVs (6 floats). */
export interface GridTriangle {
  verts: number[];
  uv: number[];
}

interface Metric {
  cx: number; cy: number; cz: number;
  nx: number; ny: number; nz: number;
  areaM2: number; areaTexel: number;
  uvu: number; uvv: number;
}

export interface LightCell {
  key: string;
  /** probe position: cell centre for air, pushed off the surface for a surface cell */
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
  /** triangles whose CENTRE is in this cell (the cell's own surfaces) */
  own: number[];
  kind: 'surface' | 'space';
  /** how many of the eight sight directions hit geometry (air cells), 0 for a surface */
  seenFrom: number;
  /** measured bake density, texels per square metre (0 for a space cell) */
  density: number;
  texels: number;
  areaM2: number;
}

export interface LightGridOptions {
  /** how many bake texels should sit behind one cell — the cell size comes from this */
  texelsPerCell?: number;
  /** sphere samples per cell (load time only) */
  raysPerCell?: number;
  /** warn when a cell's measured bake density falls below this (texels per metre) */
  minDensity?: number;
  minCellSize?: number;
  maxCellSize?: number;
  /** ray length per cell, in metres */
  maxRayDistance?: number;
  /** how many cells of air around a surface cell are considered for space cells */
  airReach?: number;
  /** deterministic seed so the CPU reference and the build use the same rays */
  seed?: number;
}

export interface LightGrid {
  cellSize: number;
  resolution: number;
  cells: LightCell[];
  /** 27 coefficients per cell (9 terms x 3 channels), in cell order */
  sh: Float64Array;
  /** cell index → 27 bits (self + 26 neighbours): which corners a point in this cell can
   *  see. Built once at load with one ray per pair, so a pixel only looks the bit up.
   *  A corner that is not set never contributes — that is the rule that light cannot come
   *  through a wall. */
  neighbourMask: Uint32Array;
  /** traversal hash: cell key → triangles whose bounding box overlaps that cell */
  buckets: Map<string, number[]>;
  /** cell key → cell index, in the order the cells were created */
  cellOfKey: Map<string, number>;
  /** cell index → which triangles its rays actually hit. That IS the dirty-flag
   *  set: when a bake value changes, only these cells can change, so they are the
   *  only cells a state change has to mark. */
  visible: number[][];
  metrics: Metric[];
  triangleVertices: number[][];
  /** what buildLightGrid was actually called with, kept on the grid so the packer and the
   *  file can write it down — a file without the seed and ray count is not reproducible */
  seed: number;
  raysPerCell: number;
}

/** exported so the file tool can fall back to the same numbers the check declares */
export const DEFAULTS: Required<LightGridOptions> = {
  texelsPerCell: 512,
  raysPerCell: 512, // load-time ray count, chosen for how blocky dark rooms look (owner, 2026-11-22)
  minDensity: 32,
  minCellSize: 0.25,
  maxCellSize: 4,
  maxRayDistance: 12,
  airReach: 6,
  seed: 12345,
};

/** eight fixed sight directions, one per octant — enough to tell air from solid */
const OCTANTS: number[][] = [
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1],
  [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
].map((d) => { const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l]; });

/** plain world-voxel key: no room, no name, every cell is the same kind of cell */
function keyOf(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`;
}

/** Which corner of the 3x3x3 neighbourhood a offset is, as a bit index (self = bit 13). */
export function neighbourBit(dx: number, dy: number, dz: number): number {
  return (dx + 1) * 9 + (dy + 1) * 3 + (dz + 1);
}

/** Mild blend strength the shader uses (owner decision 2026-11-23): a quarter neighbourhood. */
export const DEFAULT_BLEND = 0.25;

/**
 * One ray per cell pair: which of the 27 corners (self + 26 neighbours) a point in this
 * cell can see. Built ONCE at load so a pixel only reads a bit instead of casting a ray.
 * A corner that is not in the table (solid material, or air that sees nothing) and a corner
 * that geometry blocks are both left out — that is the rule that light cannot come through
 * a wall. A surface cell never blocks itself, because the point stands on that surface.
 */
export function buildNeighbourVisibility(grid: LightGrid): { mask: Uint32Array; blocked: number; absent: number } {
  const mask = new Uint32Array(grid.cells.length);
  let blocked = 0, absent = 0;
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const c = grid.cells[ci];
    const [ix, iy, iz] = c.key.split(',').map(Number);
    let m = 1 << neighbourBit(0, 0, 0);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const ni = grid.cellOfKey.get(keyOf(ix + dx, iy + dy, iz + dz));
          if (ni === undefined) { absent++; continue; }
          const nb = grid.cells[ni];
          const vx = nb.px - c.px, vy = nb.py - c.py, vz = nb.pz - c.pz;
          const len = Math.hypot(vx, vy, vz);
          if (len <= 1e-6) continue;
          const hit = trace(grid, c.px, c.py, c.pz, vx / len, vy / len, vz / len, len);
          if (hit >= 0 && !c.own.includes(hit)) { blocked++; continue; }
          m |= 1 << neighbourBit(dx, dy, dz);
        }
      }
    }
    mask[ci] = m;
  }
  grid.neighbourMask = mask;
  return { mask, blocked, absent };
}

/** Hash a voxel key identically on the CPU packer and WGSL lookup. */
export function hashCellKey(ix: number, iy: number, iz: number, mask: number): number {
  let h = (Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return h & mask;
}

/** Open-addressed GPU table: one key/header vec4 plus nine RGB SH vec4s per slot. */
export interface PackedLightGrid {
  data: Float32Array;
  /** per slot: the 27 visibility bits of the cell in that slot. The shader reads this
   *  once for its own cell and then only checks bits — no ray per pixel. */
  neighbourMask: Uint32Array;
  slotCount: number;
  cellCount: number;
  /** metadata the file carries, because a grid is only reproducible if the numbers that
   *  built it are written down: cell size, bake resolution, ray count and seed. */
  cellSize: number;
  resolution: number;
  seed: number;
  raysPerCell: number;
  /** the blend strength the shipped picture uses, stored so a change is visible in the file */
  blend: number;
}

export function packLightGrid(grid: LightGrid): PackedLightGrid {
  let slotCount = 16;
  while (slotCount < grid.cells.length * 2) slotCount <<= 1;
  const stride = SH_GRID_STRIDE_VEC4 * 4;
  const data = new Float32Array(slotCount * stride);
  const neighbourMask = new Uint32Array(slotCount);
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const [ix, iy, iz] = grid.cells[ci].key.split(',').map(Number);
    let slot = hashCellKey(ix, iy, iz, slotCount - 1);
    while (data[slot * stride + 3] !== 0) slot = (slot + 1) & (slotCount - 1);
    const base = slot * stride;
    data[base] = ix; data[base + 1] = iy; data[base + 2] = iz; data[base + 3] = 1;
    neighbourMask[slot] = grid.neighbourMask[ci];
    for (let k = 0; k < SH_TERMS; k++) {
      // grid.sh is stored CHANNEL-MAJOR (channel * 9 + term), the GPU slot stores one
      // vec4 per term (rgb + pad). Reading it as term-major here would shuffle the
      // coefficients across the channels — that is what the mirror check caught.
      const to = base + 4 + k * 4;
      for (let c = 0; c < 3; c++) data[to + c] = grid.sh[ci * 27 + c * SH_TERMS + k];
    }
  }
  return {
    data, neighbourMask, slotCount, cellCount: grid.cells.length,
    cellSize: grid.cellSize, resolution: grid.resolution,
    seed: grid.seed, raysPerCell: grid.raysPerCell, blend: DEFAULT_BLEND,
  };
}

/**
 * Half-float bits, round-to-nearest-even. Node 22 has no DataView.getFloat16, so it is
 * implemented once here and shared by the reference and the file tool: they cannot
 * disagree about a texel value if they use the same conversion.
 */
export function toHalfBits(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 ? 0x8000 : 0;
  const a = Math.abs(value);
  if (a === 0) return sign;
  if (a >= 65520) return sign | 0x7c00;
  if (a < 2 ** -14) {
    // subnormal: one ulp is 2^-24
    const ulp = 2 ** -24;
    let q = Math.floor(a / ulp);
    const rem = a / ulp - q;
    if (rem > 0.5 || (rem === 0.5 && (q & 1))) q += 1;
    return sign | (q & 0x3ff);
  }
  let e = Math.floor(Math.log2(a));
  let q = Math.floor(a / 2 ** e * 1024);
  const rem = a / 2 ** e * 1024 - q;
  if (rem > 0.5 || (rem === 0.5 && (q & 1))) {
    q += 1;
    if (q === 1024) { q = 0; e += 1; }
  }
  if (e > 15) return sign | 0x7c00;
  if (e < -14) return sign | (q & 0x3ff);
  return sign | ((e + 15) << 10) | (q & 0x3ff);
}

export function fromHalfBits(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * (frac / 1024) * 2 ** -14;
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/**
 * The scale the game applies to a bake: physical Cycles radiance x pi, so static baked
 * light and realtime dynamic light sit on ONE scale (src/world/map-loader.ts). A grid file
 * must be built with the same scale, otherwise a cell and a texel disagree by pi.
 */
export const GRID_SCALE = Math.PI;

/** Raw RGBA16F bake bytes (little-endian, as the bake tool writes them) -> linear values. */
export function decodeHalfTexels(bytes: Uint8Array, resolution: number, scale = GRID_SCALE): Float64Array {
  const texels = resolution * resolution;
  if (bytes.length !== texels * 8) {
    throw new Error(`half lightmap is ${bytes.length} bytes, expected ${texels * 8} for ${resolution}x${resolution}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(texels * 4);
  for (let i = 0; i < texels * 4; i++) out[i] = fromHalfBits(view.getUint16(i * 2, true)) * scale;
  return out;
}

/**
 * The offline grid file (assets/map/lightgrid.bin). Header is 40 bytes, so the typed-array
 * views below stay aligned; magic + version + the numbers that produced the grid, then the
 * f32 slots and the u32 masks. Written by tools/write_lightgrid.mjs from THIS module, so the
 * bake run and scripts/light-grid-check.mjs cannot disagree about the numbers.
 */
export const GRID_FILE_MAGIC = 'LGSH';
export const GRID_FILE_VERSION = 1;
const GRID_FILE_HEADER = 40;

export function encodeLightGrid(packed: PackedLightGrid): Uint8Array {
  const stride = SH_GRID_STRIDE_VEC4 * 4;
  const bytes = new Uint8Array(GRID_FILE_HEADER + packed.slotCount * stride * 4 + packed.slotCount * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) bytes[i] = GRID_FILE_MAGIC.charCodeAt(i);
  view.setUint32(4, GRID_FILE_VERSION, true);
  view.setFloat64(8, packed.cellSize, true);
  view.setUint32(16, packed.resolution, true);
  view.setUint32(20, packed.slotCount, true);
  view.setUint32(24, packed.cellCount, true);
  view.setInt32(28, packed.seed, true);
  view.setUint32(32, packed.raysPerCell, true);
  view.setFloat32(36, packed.blend, true);
  new Float32Array(bytes.buffer, GRID_FILE_HEADER, packed.slotCount * stride).set(packed.data);
  new Uint32Array(bytes.buffer, GRID_FILE_HEADER + packed.slotCount * stride * 4, packed.slotCount)
    .set(packed.neighbourMask);
  return bytes;
}

/** Read the file back. A real COPY is required, not a view: a Node Buffer from
 *  readFileSync is often a slice of a shared pool, so `bytes.buffer` is not the file and a
 *  typed-array view at header + offset reads the wrong bytes. That is what the first CLI run
 *  caught (an empty table with a correct header). */
export function decodeLightGrid(bytes: Uint8Array): PackedLightGrid {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== GRID_FILE_MAGIC) throw new Error(`lightgrid file starts with "${magic}", expected ${GRID_FILE_MAGIC}`);
  const version = view.getUint32(4, true);
  if (version !== GRID_FILE_VERSION) throw new Error(`lightgrid file version ${version}, expected ${GRID_FILE_VERSION}`);
  const cellSize = view.getFloat64(8, true);
  const resolution = view.getUint32(16, true);
  const slotCount = view.getUint32(20, true);
  const cellCount = view.getUint32(24, true);
  const seed = view.getInt32(28, true);
  const raysPerCell = view.getUint32(32, true);
  const blend = view.getFloat32(36, true);
  const stride = SH_GRID_STRIDE_VEC4 * 4;
  const expected = GRID_FILE_HEADER + slotCount * stride * 4 + slotCount * 4;
  if (bytes.byteLength !== expected) {
    throw new Error(`lightgrid file is ${bytes.byteLength} bytes, expected ${expected}`);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes); // a real copy, so the views below start at the file, not at a shared pool
  return {
    data: new Float32Array(copy.buffer, GRID_FILE_HEADER, slotCount * stride),
    neighbourMask: new Uint32Array(copy.buffer, GRID_FILE_HEADER + slotCount * stride * 4, slotCount),
    slotCount, cellCount, cellSize, resolution, seed, raysPerCell, blend,
  };
}

/**
 * Voxel lookup exactly as the shader does it: hash the key, then walk the
 * open-addressed chain. Returns the slot, -1 when the voxel is not in the table
 * (an empty slot ends the chain — a missing voxel is NOT a wrong cell), and -2
 * when the probe limit is reached, which is the shader's stop condition instead
 * of an endless loop.
 */
export function packedSlot(packed: PackedLightGrid, ix: number, iy: number, iz: number, probeLimit = 64): number {
  const stride = SH_GRID_STRIDE_VEC4 * 4;
  const mask = packed.slotCount - 1;
  let slot = hashCellKey(ix, iy, iz, mask);
  for (let step = 0; step < probeLimit; step++) {
    const base = slot * stride;
    if (packed.data[base + 3] === 0) return -1;
    if (packed.data[base] === ix && packed.data[base + 1] === iy && packed.data[base + 2] === iz) return slot;
    slot = (slot + 1) & mask;
  }
  return -2;
}

/** Irradiance for a normal out of ONE slot, as the shader computes it. */
export function packedIrradiance(packed: PackedLightGrid, slot: number, n: number[], out: Float64Array): void {
  const basis = new Float64Array(SH_TERMS);
  shBasis(n[0], n[1], n[2], basis);
  const base = slot * SH_GRID_STRIDE_VEC4 * 4 + 4;
  for (let c = 0; c < 3; c++) {
    let e = 0;
    for (let k = 0; k < SH_TERMS; k++) e += LOBE[BAND[k]] * packed.data[base + k * 4 + c] * basis[k];
    out[c] = e;
  }
}

/** The 8 corner voxels around a point, with their trilinear weights. */
export interface BlendSample {
  /** slot of the voxel the point is in, -1 when it is not in the table */
  ownSlot: number;
  slots: number[];
  weights: number[];
  /** corners that are not in the table (solid or unlit air) */
  missing: number;
  /** corners in the table that this point cannot see (geometry in between) */
  gated: number;
}

/**
 * Trilinear blend over the 8 voxel corners, gated by the load-time neighbour visibility:
 * only corners the point can see contribute, so light cannot come through a wall.
 * Weights are renormalised over the corners that count, so a corner inside a wall does not
 * pull the value towards zero.
 */
export function packedBlend(packed: PackedLightGrid, x: number, y: number, z: number, cellSize: number, out: BlendSample, probeLimit = 64): BlendSample {
  const cs = cellSize;
  const ix = Math.floor(x / cs), iy = Math.floor(y / cs), iz = Math.floor(z / cs);
  const fx = x / cs - ix, fy = y / cs - iy, fz = z / cs - iz;
  out.ownSlot = packedSlot(packed, ix, iy, iz, probeLimit);
  out.slots = [];
  out.weights = [];
  out.missing = 0;
  out.gated = 0;
  const mask = out.ownSlot >= 0 ? packed.neighbourMask[out.ownSlot] : 0xffffffff;
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < 2; c++) {
        const slot = packedSlot(packed, ix + a, iy + b, iz + c, probeLimit);
        if (slot < 0) { out.missing++; continue; }
        if ((mask & (1 << neighbourBit(a, b, c))) === 0) { out.gated++; continue; }
        const wx = a === 0 ? 1 - fx : fx;
        const wy = b === 0 ? 1 - fy : fy;
        const wz = c === 0 ? 1 - fz : fz;
        out.slots.push(slot);
        out.weights.push(wx * wy * wz);
      }
    }
  }
  let sum = 0;
  for (const w of out.weights) sum += w;
  if (sum > 0) for (let i = 0; i < out.weights.length; i++) out.weights[i] /= sum;
  return out;
}

/**
 * Irradiance for a normal from the blended corners. `factor` is how much of the value
 * comes from the neighbourhood: 1 = pure trilinear blend (the soft picture), 0 = the
 * own cell alone (the accurate picture). The shader uses the same factor, so a change
 * here is a picture decision, not a maths change.
 */
export function packedBlendIrradiance(packed: PackedLightGrid, sample: BlendSample, n: number[], out: Float64Array, factor = DEFAULT_BLEND): void {
  const basis = new Float64Array(SH_TERMS);
  shBasis(n[0], n[1], n[2], basis);
  const single = new Float64Array(3);
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (let i = 0; i < sample.slots.length; i++) {
    packedIrradiance(packed, sample.slots[i], n, single);
    for (let c = 0; c < 3; c++) out[c] += single[c] * sample.weights[i];
  }
  if (factor === 1 || sample.ownSlot < 0) return;
  packedIrradiance(packed, sample.ownSlot, n, single);
  for (let c = 0; c < 3; c++) out[c] = single[c] * (1 - factor) + out[c] * factor;
}

/** deterministic PRNG so a reference run and the build see the same rays */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Uniform direction on the FULL sphere. SH coefficients are defined as full-sphere
 * integrals, so the projection must sample the full sphere; the cosine lobe (the
 * LOBE factors above) then produces the irradiance for any normal. Sampling only
 * half of the sphere would make the reconstruction wrong.
 */
export function sampleSphere(rand: () => number, out: Float64Array, index?: number, count?: number): void {
  // Stratified z plus a golden-angle azimuth is a deterministic low-discrepancy
  // sphere sequence. Pure random directions leave large gaps at practical ray
  // counts; the seed only jitters each equal-area band, not its coverage.
  const z = index === undefined || count === undefined
    ? rand() * 2 - 1
    : 1 - 2 * ((index + rand()) / count);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const a = index === undefined
    ? rand() * 2 * Math.PI
    : (index * 2.399963229728653 + rand() * 2 * Math.PI) % (2 * Math.PI);
  out[0] = r * Math.cos(a); out[1] = r * Math.sin(a); out[2] = z;
}

/** Prefix-stable low-discrepancy sphere sample: N rays are the first N of any larger run. */
function sampleSphereIndexed(seed: number, index: number, out: Float64Array): void {
  let n = index + 1;
  let vdc = 0, denom = 1;
  while (n > 0) { denom *= 2; vdc += (n % 2) / denom; n = Math.floor(n / 2); }
  const phase = ((seed >>> 0) * 0.6180339887498949) % 1;
  const z = 1 - 2 * ((vdc + phase) % 1);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const a = (index * 2.399963229728653 + phase * 2 * Math.PI) % (2 * Math.PI);
  out[0] = r * Math.cos(a); out[1] = r * Math.sin(a); out[2] = z;
}

export function triangleMetrics(tri: GridTriangle, resolution: number): Metric | null {
  const ax = tri.verts[0], ay = tri.verts[1], az = tri.verts[2];
  const e1x = tri.verts[3] - ax, e1y = tri.verts[4] - ay, e1z = tri.verts[5] - az;
  const e2x = tri.verts[6] - ax, e2y = tri.verts[7] - ay, e2z = tri.verts[8] - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return null;
  // uv is three (u, v) pairs in the same vertex order as verts; normalised, so the
  // texel area needs the bake resolution
  const u1x = tri.uv[2] - tri.uv[0], u1y = tri.uv[3] - tri.uv[1];
  const u2x = tri.uv[4] - tri.uv[0], u2y = tri.uv[5] - tri.uv[1];
  return {
    cx: (ax + tri.verts[3] + tri.verts[6]) / 3,
    cy: (ay + tri.verts[4] + tri.verts[7]) / 3,
    cz: (az + tri.verts[5] + tri.verts[8]) / 3,
    nx: nx / len, ny: ny / len, nz: nz / len,
    areaM2: len / 2,
    areaTexel: (Math.abs(u1x * u2y - u1y * u2x) / 2) * resolution * resolution,
    uvu: (tri.uv[0] + tri.uv[2] + tri.uv[4]) / 3,
    uvv: (tri.uv[1] + tri.uv[3] + tri.uv[5]) / 3,
  };
}

/** lightmap value at a UV point. Row 0 = top = the game's flipY=false convention. */
export function lightmapAt(values: Float64Array, resolution: number, uvu: number, uvv: number, out: Float64Array): void {
  const x = Math.min(resolution - 1, Math.max(0, Math.floor(uvu * resolution)));
  const y = Math.min(resolution - 1, Math.max(0, Math.floor(uvv * resolution)));
  const i = (y * resolution + x) * 4;
  out[0] = values[i]; out[1] = values[i + 1]; out[2] = values[i + 2];
}

/** nearest geometry hit along a ray, using the cell buckets as the acceleration structure */
export function trace(grid: LightGrid, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
  const cellSize = grid.cellSize;
  let bestT = maxDist;
  let bestTri = -1;
  let ix = Math.floor(ox / cellSize), iy = Math.floor(oy / cellSize), iz = Math.floor(oz / cellSize);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  // t per cell step, in the same units as the ray-triangle t (metres, unit direction)
  const stepx = Math.abs(dx) > 1e-9 ? cellSize / Math.abs(dx) : Infinity;
  const stepy = Math.abs(dy) > 1e-9 ? cellSize / Math.abs(dy) : Infinity;
  const stepz = Math.abs(dz) > 1e-9 ? cellSize / Math.abs(dz) : Infinity;
  let tx = stepx === Infinity ? Infinity : ((sx > 0 ? ix + 1 : ix) - ox / cellSize) * stepx;
  let ty = stepy === Infinity ? Infinity : ((sy > 0 ? iy + 1 : iy) - oy / cellSize) * stepy;
  let tz = stepz === Infinity ? Infinity : ((sz > 0 ? iz + 1 : iz) - oz / cellSize) * stepz;
  for (let guard = 0; guard < 4096; guard++) {
    const hits = grid.buckets.get(keyOf(ix, iy, iz));
    if (hits) {
      for (const ti of hits) {
        const t = rayTriangle(grid, ti, ox, oy, oz, dx, dy, dz);
        if (t > 1e-3 && t < bestT) { bestT = t; bestTri = ti; }
      }
    }
    const next = Math.min(tx, ty, tz);
    if (next > bestT || next > maxDist) break;
    if (next === tx) { ix += sx; tx += stepx; }
    else if (next === ty) { iy += sy; ty += stepy; }
    else { iz += sz; tz += stepz; }
  }
  return bestTri;
}

/**
 * Ray against one triangle, double-sided (a bake value is a surface property, so a
 * probe must see it from either side). Derived plainly: plane N = e1 x e2,
 * det = d·N, t = -f·N / det with f = origin - v0; then the hit point is projected
 * onto e1/e2 for the barycentric (u, w). Checked against the simple case: origin
 * (0,0,0), direction +Y, triangle at y=1 with e1 = +X and e2 = +Z gives t = 1.
 */
export function rayTriangle(grid: LightGrid, ti: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const tri = grid.triangleVertices[ti];
  const e1x = tri[3] - tri[0], e1y = tri[4] - tri[1], e1z = tri[5] - tri[2];
  const e2x = tri[6] - tri[0], e2y = tri[7] - tri[1], e2z = tri[8] - tri[2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const det = dx * nx + dy * ny + dz * nz;
  if (Math.abs(det) < 1e-12) return -1;
  const fx = ox - tri[0], fy = oy - tri[1], fz = oz - tri[2];
  const t = -(fx * nx + fy * ny + fz * nz) / det;
  if (t <= 0) return -1;
  const hx = ox + t * dx - tri[0], hy = oy + t * dy - tri[1], hz = oz + t * dz - tri[2];
  const a = e1x * e1x + e1y * e1y + e1z * e1z;
  const b = e1x * e2x + e1y * e2y + e1z * e2z;
  const c = e2x * e2x + e2y * e2y + e2z * e2z;
  const d1 = hx * e1x + hy * e1y + hz * e1z;
  const d2 = hx * e2x + hy * e2y + hz * e2z;
  const den = a * c - b * b;
  if (den <= 1e-12) return -1;
  const u = (d1 * c - d2 * b) / den;
  const w = (d2 * a - d1 * b) / den;
  if (u < -1e-9 || w < -1e-9 || u + w > 1 + 1e-9) return -1;
  return t;
}

/** cells whose recorded rays actually see the given triangles — exactly what a dirty flag must mark */
export function dirtyCellsFor(grid: LightGrid, changedTriangles: number[]): number[] {
  const changed = new Set(changedTriangles);
  const out: number[] = [];
  for (let ci = 0; ci < grid.cells.length; ci++) {
    for (const ti of grid.visible[ci]) {
      if (changed.has(ti)) { out.push(ci); break; }
    }
  }
  return out;
}

/**
 * Build the grid from geometry. Cell size comes from the bake's own texel density
 * (no authoring work): a dense area gets smaller cells, a sparse area larger ones.
 * Surface cells come from the triangles; space cells are the air voxels around them
 * that can see at least one surface.
 */
export function buildLightGrid(tris: GridTriangle[], values: Float64Array, resolution: number, opts: LightGridOptions = {}): LightGrid {
  const o = { ...DEFAULTS, ...opts };
  const grid: LightGrid = {
    cellSize: 0, resolution, cells: [], sh: new Float64Array(0),
    buckets: new Map(), cellOfKey: new Map(), visible: [], metrics: [], triangleVertices: [],
    neighbourMask: new Uint32Array(0), seed: o.seed, raysPerCell: o.raysPerCell,
  };

  let texelArea = 0, metreArea = 0;
  for (const tri of tris) {
    const m = triangleMetrics(tri, resolution);
    if (!m) continue;
    grid.metrics.push(m);
    grid.triangleVertices.push(tri.verts);
    texelArea += m.areaTexel;
    metreArea += m.areaM2;
  }
  if (metreArea <= 0 || texelArea <= 0) throw new Error('light grid needs geometry with UVs');

  const densityPerM2 = texelArea / metreArea;
  grid.cellSize = Math.min(o.maxCellSize, Math.max(o.minCellSize, Math.sqrt(o.texelsPerCell / densityPerM2)));

  // traversal buckets: every cell a triangle's bounding box overlaps, otherwise a
  // ray through a neighbouring cell never sees the triangle
  for (let i = 0; i < grid.metrics.length; i++) {
    const v = grid.triangleVertices[i];
    const lox = Math.min(v[0], v[3], v[6]), loy = Math.min(v[1], v[4], v[7]), loz = Math.min(v[2], v[5], v[8]);
    const hix = Math.max(v[0], v[3], v[6]), hiy = Math.max(v[1], v[4], v[7]), hiz = Math.max(v[2], v[5], v[8]);
    for (let ix = Math.floor(lox / grid.cellSize); ix <= Math.floor(hix / grid.cellSize); ix++) {
      for (let iy = Math.floor(loy / grid.cellSize); iy <= Math.floor(hiy / grid.cellSize); iy++) {
        for (let iz = Math.floor(loz / grid.cellSize); iz <= Math.floor(hiz / grid.cellSize); iz++) {
          const k = keyOf(ix, iy, iz);
          const b = grid.buckets.get(k);
          if (b) b.push(i);
          else grid.buckets.set(k, [i]);
        }
      }
    }
  }

  // surface cells: one per voxel that holds a surface, in triangle-centre order
  for (let i = 0; i < grid.metrics.length; i++) {
    const m = grid.metrics[i];
    const k = keyOf(Math.floor(m.cx / grid.cellSize), Math.floor(m.cy / grid.cellSize), Math.floor(m.cz / grid.cellSize));
    let ci = grid.cellOfKey.get(k);
    if (ci === undefined) {
      ci = grid.cells.length;
      grid.cellOfKey.set(k, ci);
      grid.cells.push({
        key: k, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 1,
        own: [], kind: 'surface', seenFrom: 0, density: 0, texels: 0, areaM2: 0,
      });
    }
    grid.cells[ci].own.push(i);
  }

  // space cells: air voxels near a surface cell that can actually see a surface.
  // A voxel inside solid material sees nothing, so it is not created.
  const surfaceCount = grid.cells.length;
  const cs = grid.cellSize;
  for (let ci = 0; ci < surfaceCount; ci++) {
    const c = grid.cells[ci];
    const [ix, iy, iz] = c.key.split(',').map(Number);
    for (let dx = -o.airReach; dx <= o.airReach; dx++) {
      for (let dy = -o.airReach; dy <= o.airReach; dy++) {
        for (let dz = -o.airReach; dz <= o.airReach; dz++) {
          const k = keyOf(ix + dx, iy + dy, iz + dz);
          if (grid.cellOfKey.has(k)) continue;
          // Only air that is enclosed becomes a cell: at least three of the eight
          // fixed sight directions must hit geometry. A voxel in the middle of a
          // room holds no triangle, so this is a sight test, not a bucket test.
          // Open sky, a street, or the space under a floor stays without a cell —
          // nothing can walk there, and its light is not the bake's business.
          const px = (ix + dx + 0.5) * cs, py = (iy + dy + 0.5) * cs, pz = (iz + dz + 0.5) * cs;
          let seen = 0;
          for (const d of OCTANTS) {
            if (trace(grid, px, py, pz, d[0], d[1], d[2], o.maxRayDistance) >= 0) seen++;
          }
          if (seen < 3) continue;
          // An air cell has NO surface normal: it is a point in space, so the SH it
          // stores is a full-sphere function and irradiance is evaluated with the
          // normal of whatever object stands there. The stored normal stays 0.
          grid.cellOfKey.set(k, grid.cells.length);
          grid.cells.push({
            key: k, px, py, pz, nx: 0, ny: 0, nz: 0,
            own: [], kind: 'space', density: 0, texels: 0, areaM2: 0, seenFrom: seen,
          });
        }
      }
    }
  }

  grid.sh = new Float64Array(grid.cells.length * 27);
  grid.visible = grid.cells.map(() => []);
  for (let ci = 0; ci < grid.cells.length; ci++) fillCell(grid, ci, values, o, o.seed);
  return grid;
}

/** One cell: a sphere (air) or hemisphere (surface) of rays projected onto SH. */
export function fillCell(grid: LightGrid, cellIndex: number, values: Float64Array, opts: LightGridOptions, seed: number): number {
  const o = { ...DEFAULTS, ...opts };
  const c = grid.cells[cellIndex];
  if (c.own.length === 0 && c.kind === 'surface') return 0;

  if (c.own.length > 0) {
    let cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0, area = 0, texels = 0;
    for (const ti of c.own) {
      const m = grid.metrics[ti];
      cx += m.cx * m.areaM2; cy += m.cy * m.areaM2; cz += m.cz * m.areaM2;
      ax += m.nx * m.areaM2; ay += m.ny * m.areaM2; az += m.nz * m.areaM2;
      area += m.areaM2; texels += m.areaTexel;
    }
    if (area <= 0) return 0;
    c.px = cx / area; c.py = cy / area; c.pz = cz / area;
    const nl = Math.hypot(ax, ay, az) || 1;
    // push the probe out of the wall it sits in, otherwise every ray hits itself
    const push = Math.min(0.2, grid.cellSize / 4);
    c.px += (ax / nl) * push; c.py += (ay / nl) * push; c.pz += (az / nl) * push;
    c.nx = ax / nl; c.ny = ay / nl; c.nz = az / nl;
    c.areaM2 = area; c.texels = Math.round(texels); c.density = texels / area;
  }

  const samples = Math.max(1, o.raysPerCell);
  // a surface must not count its own bake value as incoming light, so the triangles
  // this cell holds are skipped. The reference uses the same rule, which is why the
  // comparison measures pure SH representation error.
  const base = cellIndex * 27;
  const seen = projectCoefficients(grid, values, c.px, c.py, c.pz, samples, seed + cellIndex, new Set(c.own), grid.sh.subarray(base, base + 27), o.maxRayDistance);
  grid.visible[cellIndex] = [...seen];
  return 1;
}

/**
 * Low-discrepancy SH projection around a point: `samples` full-sphere rays, the bake
 * value at each hit projected onto the 9 terms. Returns the triangles the rays
 * actually hit — that set IS the visibility list the dirty flag needs.
 */
export function projectCoefficients(grid: LightGrid, values: Float64Array, x: number, y: number, z: number, samples: number, seed: number, skip: Set<number>, out: Float64Array, maxRayDistance = DEFAULTS.maxRayDistance): Set<number> {
  const dir = new Float64Array(3);
  const basis = new Float64Array(SH_TERMS);
  const value = new Float64Array(3);
  out.fill(0);
  const seen = new Set<number>();
  for (let s = 0; s < samples; s++) {
    sampleSphereIndexed(seed, s, dir);
    const ti = trace(grid, x, y, z, dir[0], dir[1], dir[2], maxRayDistance);
    if (ti < 0 || skip.has(ti)) continue;
    seen.add(ti);
    const m = grid.metrics[ti];
    lightmapAt(values, grid.resolution, m.uvu, m.uvv, value);
    shBasis(dir[0], dir[1], dir[2], basis);
    for (let cc = 0; cc < 3; cc++) {
      for (let i = 0; i < SH_TERMS; i++) out[cc * SH_TERMS + i] += value[cc] * basis[i];
    }
  }
  // Monte-Carlo over the full sphere: integral = 4π/N * sum. The cosine lobe in
  // shIrradiance then turns the coefficients into irradiance for any normal.
  const scale = (4 * Math.PI) / Math.max(1, samples);
  for (let i = 0; i < 27; i++) out[i] *= scale;
  return seen;
}

/** distance from a point to a cell probe, in metres */
export function distToCell(grid: LightGrid, cellIndex: number, x: number, y: number, z: number): number {
  const c = grid.cells[cellIndex];
  return Math.hypot(c.px - x, c.py - y, c.pz - z);
}

/** distance of the last sample to the cell it used, so the caller can judge the quantization */
export let lastSampleDistance = 0;
/** true when the last sample read the point's OWN voxel, not a neighbour */
export let lastSampleOwn = false;

/** cell index for a world point; the nearest cell that exists, up to `reach` cells away */
export function cellIndexAt(grid: LightGrid, x: number, y: number, z: number, reach = 6): number {
  const cs = grid.cellSize;
  const ix = Math.floor(x / cs), iy = Math.floor(y / cs), iz = Math.floor(z / cs);
  const own = grid.cellOfKey.get(keyOf(ix, iy, iz));
  if (own !== undefined) {
    lastSampleOwn = true;
    lastSampleDistance = distToCell(grid, own, x, y, z);
    return own;
  }
  lastSampleOwn = false;
  let best = -1, bestDist = Infinity;
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const ci = grid.cellOfKey.get(keyOf(ix + dx, iy + dy, iz + dz));
        if (ci === undefined) continue;
        const d = distToCell(grid, ci, x, y, z);
        if (d < bestDist) { bestDist = d; best = ci; }
      }
    }
  }
  lastSampleDistance = best < 0 ? -1 : bestDist;
  return best;
}

/** read light for a moving object: the cell it is in, or the nearest one */
export function sampleIrradiance(grid: LightGrid, x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float64Array, reach = 6): number {
  const cellIndex = cellIndexAt(grid, x, y, z, reach);
  if (cellIndex < 0) { out[0] = 0; out[1] = 0; out[2] = 0; return -1; }
  const coefs = grid.sh.subarray(cellIndex * 27, cellIndex * 27 + 27);
  shIrradiance(coefs, nx, ny, nz, out);
  return cellIndex;
}

/**
 * The same reading as the shipped shader path: own cell plus the mild blend over the
 * visible corners. `factor` is the share of the neighbourhood (owner chose 0.25).
 * This is the value a pixel or a moving object actually gets, so the check compares it
 * against the truth at that point, and the difference has two named parts: the ray noise
 * of the cell content and the smoothing itself.
 */
export function sampleBlendIrradiance(grid: LightGrid, x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float64Array, factor = DEFAULT_BLEND): number {
  const cs = grid.cellSize;
  const ix = Math.floor(x / cs), iy = Math.floor(y / cs), iz = Math.floor(z / cs);
  const own = grid.cellOfKey.get(keyOf(ix, iy, iz));
  if (own === undefined) { out[0] = 0; out[1] = 0; out[2] = 0; return -1; }
  const fx = x / cs - ix, fy = y / cs - iy, fz = z / cs - iz;
  const mask = grid.neighbourMask[own];
  const basis = new Float64Array(SH_TERMS);
  shBasis(nx, ny, nz, basis);
  const single = new Float64Array(3);
  let sum = 0;
  out[0] = 0; out[1] = 0; out[2] = 0;
  const corners: number[] = [];
  const weights: number[] = [];
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < 2; c++) {
        const ci = grid.cellOfKey.get(keyOf(ix + a, iy + b, iz + c));
        if (ci === undefined) continue;
        if ((mask & (1 << neighbourBit(a, b, c))) === 0) continue;
        corners.push(ci);
        weights.push((a === 0 ? 1 - fx : fx) * (b === 0 ? 1 - fy : fy) * (c === 0 ? 1 - fz : fz));
        sum += weights[weights.length - 1];
      }
    }
  }
  for (let i = 0; i < corners.length; i++) {
    shIrradiance(grid.sh.subarray(corners[i] * 27, corners[i] * 27 + 27), nx, ny, nz, single);
    const w = weights[i] / sum;
    for (let ch = 0; ch < 3; ch++) out[ch] += single[ch] * w;
  }
  if (factor !== 1) {
    shIrradiance(grid.sh.subarray(own * 27, own * 27 + 27), nx, ny, nz, single);
    for (let ch = 0; ch < 3; ch++) out[ch] = single[ch] * (1 - factor) + out[ch] * factor;
  }
  return own;
}

/**
 * Direct integral at a point — the ground truth the SH cells are compared against.
 * Full-sphere sampling with the cosine filter is the direct irradiance reference;
 * the same seed produces the same low-discrepancy ray order on both sides.
 * `skip` must match the cell's own rule, otherwise the reference counts a surface
 * that the cell is not allowed to see.
 */
export function referenceIrradiance(grid: LightGrid, values: Float64Array, x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float64Array, opts: LightGridOptions, seed: number, skip: Set<number> = new Set()): number {
  const o = { ...DEFAULTS, ...opts };
  const dir = new Float64Array(3);
  const value = new Float64Array(3);
  const acc = new Float64Array(3);
  const samples = Math.max(1, o.raysPerCell);
  for (let s = 0; s < samples; s++) {
    sampleSphereIndexed(seed, s, dir);
    const ti = trace(grid, x, y, z, dir[0], dir[1], dir[2], o.maxRayDistance);
    if (ti < 0 || skip.has(ti)) continue;
    const m = grid.metrics[ti];
    lightmapAt(values, grid.resolution, m.uvu, m.uvv, value);
    const cos = dir[0] * nx + dir[1] * ny + dir[2] * nz;
    if (cos <= 0) continue;
    for (let c = 0; c < 3; c++) acc[c] += value[c] * cos;
  }
  // Monte-Carlo over the domain we sample (the full sphere), so the scale is 4π/N.
  // The cosine indicator already restricts the sum to the hemisphere that matters.
  const scale = (4 * Math.PI) / samples;
  for (let c = 0; c < 3; c++) out[c] = acc[c] * scale;
  return samples;
}
