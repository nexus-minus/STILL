/** CPU-side order-2 real SH projection and sparse spatial-cell storage. */
export const SH_COEFFICIENTS = 9;
export const SH_CELL_VEC4_STRIDE = 8;
const SH_Y00 = 0.282095;
const FOUR_PI = 4 * Math.PI;

export function shBasisOrder2(direction) {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) throw new RangeError('SH direction must be non-zero');
  const x = direction[0] / length, y = direction[1] / length, z = direction[2] / length;
  return [
    0.282095,
    0.488603 * y, 0.488603 * z, 0.488603 * x,
    1.092548 * x * y, 1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ];
}

/** Project a sampled directional RGB field into 9 real SH coefficients/channel. */
export function projectSHOrder2(directionalSamples) {
  if (directionalSamples.length < 9) throw new RangeError('order-2 SH needs at least 9 directional samples');
  const coefficients = new Float32Array(SH_COEFFICIENTS * 3);
  const weight = FOUR_PI / directionalSamples.length;
  for (const sample of directionalSamples) {
    const basis = shBasisOrder2(sample.direction);
    for (let k = 0; k < SH_COEFFICIENTS; k++) {
      for (let c = 0; c < 3; c++) coefficients[k * 3 + c] += sample.rgb[c] * basis[k] * weight;
    }
  }
  return coefficients;
}

export function evaluateSHOrder2(coefficients, direction) {
  if (coefficients.length !== SH_COEFFICIENTS * 3) throw new RangeError('SH coefficient buffer must contain 27 values');
  const basis = shBasisOrder2(direction);
  const rgb = [0, 0, 0];
  for (let k = 0; k < SH_COEFFICIENTS; k++) {
    for (let c = 0; c < 3; c++) rgb[c] += coefficients[k * 3 + c] * basis[k];
  }
  return rgb.map((value) => Math.max(0, value));
}

/** Exact direction-independent diffuse probe, encoded in the SH L0 coefficient. */
export function isotropicSH(rgb) {
  const coefficients = new Float32Array(27);
  for (let c = 0; c < 3; c++) coefficients[c] = rgb[c] / SH_Y00;
  return coefficients;
}

export function chooseCellSize(boundsMin, boundsMax, sampleCount, maxCells = 8192) {
  if (!(sampleCount > 0) || !(maxCells > 0)) throw new RangeError('grid needs samples and a positive cell budget');
  const volume = Math.max(0.001, (boundsMax[0] - boundsMin[0]) *
    (boundsMax[1] - boundsMin[1]) * (boundsMax[2] - boundsMin[2]));
  return Math.max(0.1, Math.cbrt(volume / maxCells));
}

export function cellKey(ix, iy, iz) {
  return `${ix},${iy},${iz}`;
}

function indices(position, grid) {
  return position.map((v, axis) => Math.floor((v - grid.origin[axis]) / grid.cellSize));
}

export function buildSparseSHGrid(samples, cellSize, origin = [0, 0, 0]) {
  if (!(cellSize > 0)) throw new RangeError('cell size must be positive');
  const grid = { cellSize, origin: [...origin], cells: new Map(), sourceSamples: samples };
  for (const sample of samples) {
    const [ix, iy, iz] = indices(sample.position, grid);
    const key = cellKey(ix, iy, iz);
    let cell = grid.cells.get(key);
    if (!cell) {
      cell = { index: [ix, iy, iz], coefficients: new Float32Array(27), count: 0 };
      grid.cells.set(key, cell);
    }
    for (let i = 0; i < 27; i++) cell.coefficients[i] += sample.coefficients[i];
    cell.count++;
  }
  for (const cell of grid.cells.values()) {
    for (let i = 0; i < 27; i++) cell.coefficients[i] /= cell.count;
  }
  return grid;
}

/** Nearest occupied spatial cell; null explicitly requests the caller's fallback. */
export function sampleSparseSHGrid(grid, position, direction) {
  const [ix, iy, iz] = indices(position, grid);
  const cell = grid.cells.get(cellKey(ix, iy, iz));
  return cell ? evaluateSHOrder2(cell.coefficients, direction) : null;
}

/** Pack sparse cells into a bounded dense storage buffer for direct GPU indexing. */
export function packSparseSHGrid(grid, boundsMin, boundsMax) {
  const dimensions = boundsMin.map((min, axis) =>
    Math.max(1, Math.ceil((boundsMax[axis] - min) / grid.cellSize)));
  const totalCells = dimensions[0] * dimensions[1] * dimensions[2];
  if (totalCells > 65536) throw new RangeError(`SH grid needs ${totalCells} dense cells (limit 65536)`);
  const data = new Float32Array(totalCells * SH_CELL_VEC4_STRIDE * 4);
  for (const cell of grid.cells.values()) {
    const [x, y, z] = cell.index;
    if (x < 0 || y < 0 || z < 0 || x >= dimensions[0] || y >= dimensions[1] || z >= dimensions[2]) continue;
    const flat = (z * dimensions[1] + y) * dimensions[0] + x;
    const base = flat * SH_CELL_VEC4_STRIDE * 4;
    data[base + SH_CELL_VEC4_STRIDE * 4 - 1] = 1; // occupied marker
    data.set(cell.coefficients, base);
  }
  return { origin: [...boundsMin], dimensions, cellSize: grid.cellSize, data, occupiedCells: grid.cells.size };
}

/** Replace samples inside a box and rebuild only cells touched by old/new points. */
export function updateSHGridRegion(grid, regionMin, regionMax, replacementSamples) {
  const inside = (p) => p.every((v, a) => v >= regionMin[a] && v <= regionMax[a]);
  const old = grid.sourceSamples;
  const cellsBefore = grid.cells.size;
  const affected = new Set();
  for (const s of old) if (inside(s.position)) affected.add(cellKey(...indices(s.position, grid)));
  for (const s of replacementSamples) if (inside(s.position)) affected.add(cellKey(...indices(s.position, grid)));
  const kept = old.filter((s) => !inside(s.position));
  const added = replacementSamples.filter((s) => inside(s.position));
  grid.sourceSamples = [...kept, ...added];
  // Rebuild only the cells reached by the changed region. Other cell objects
  // retain identity, which lets callers upload only dirty ranges.
  for (const key of affected) {
    const matches = grid.sourceSamples.filter((s) => cellKey(...indices(s.position, grid)) === key);
    if (matches.length === 0) {
      grid.cells.delete(key);
      continue;
    }
    const coefficients = new Float32Array(27);
    for (const sample of matches) for (let i = 0; i < 27; i++) coefficients[i] += sample.coefficients[i];
    for (let i = 0; i < 27; i++) coefficients[i] /= matches.length;
    grid.cells.set(key, { index: indices(matches[0].position, grid), coefficients, count: matches.length });
  }
  return { affectedCells: affected.size, cellsBefore, cellsAfter: grid.cells.size };
}
