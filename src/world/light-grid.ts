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
const LOBE = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4];
const BAND = [0, 1, 1, 1, 2, 2, 2, 2, 2];

/** Real orthonormal SH basis at a unit direction. */
export function shBasis(x: number, y: number, z: number, out: Float64Array): void {
  const c1 = 0.4886029218335914;
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
}

const DEFAULTS: Required<LightGridOptions> = {
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

/** Hash a voxel key identically on the CPU packer and WGSL lookup. */
export function hashCellKey(ix: number, iy: number, iz: number, mask: number): number {
  let h = (Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return h & mask;
}

/** Open-addressed GPU table: one key/header vec4 plus nine RGB SH vec4s per slot. */
export function packLightGrid(grid: LightGrid): { data: Float32Array; slotCount: number; cellCount: number } {
  let slotCount = 16;
  while (slotCount < grid.cells.length * 2) slotCount <<= 1;
  const stride = SH_GRID_STRIDE_VEC4 * 4;
  const data = new Float32Array(slotCount * stride);
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const [ix, iy, iz] = grid.cells[ci].key.split(',').map(Number);
    let slot = hashCellKey(ix, iy, iz, slotCount - 1);
    while (data[slot * stride + 3] !== 0) slot = (slot + 1) & (slotCount - 1);
    const base = slot * stride;
    data[base] = ix; data[base + 1] = iy; data[base + 2] = iz; data[base + 3] = 1;
    for (let k = 0; k < SH_TERMS; k++) {
      const co = ci * 27 + k * 3;
      const to = base + 4 + k * 4;
      data[to] = grid.sh[co]; data[to + 1] = grid.sh[co + 1]; data[to + 2] = grid.sh[co + 2];
    }
  }
  return { data, slotCount, cellCount: grid.cells.length };
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
