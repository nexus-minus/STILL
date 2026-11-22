/** CPU-side order-2 real SH projection and sparse spatial-cell storage. */
export const SH_COEFFICIENTS = 9;
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

/** Replace samples inside a box and rebuild only cells touched by old/new points. */
export function updateSHGridRegion(grid, regionMin, regionMax, replacementSamples) {
  const inside = (p) => p.every((v, a) => v >= regionMin[a] && v <= regionMax[a]);
  const old = grid.sourceSamples;
  const affected = new Set();
  for (const s of old) if (inside(s.position)) affected.add(cellKey(...indices(s.position, grid)));
  for (const s of replacementSamples) if (inside(s.position)) affected.add(cellKey(...indices(s.position, grid)));
  const kept = old.filter((s) => !inside(s.position));
  const added = replacementSamples.filter((s) => inside(s.position));
  const next = buildSparseSHGrid([...kept, ...added], grid.cellSize, grid.origin);
  grid.sourceSamples = next.sourceSamples;
  grid.cells = next.cells;
  return { affectedCells: affected.size, cellsBefore: old.length, cellsAfter: grid.cells.size };
}
