#!/usr/bin/env node
/**
 * Headless CPU reference for src/world/light-grid.ts.
 * Run: node --experimental-strip-types scripts/light-grid-check.mjs
 *
 * Scene: two closed rooms joined by a corridor with a doorway, one lamp island,
 * and one deliberately sparse island so the density warning path is exercised.
 * Bake values carry a smooth gradient inside each island, like a real bake — a
 * flat colour would make the SH test harder than reality.
 * No DOM, no GPU. This proves the maths (cell size from geometry, SH projection,
 * sampling in air, dirty flag). The picture on screen is still the owner's check
 * on real hardware (docs/test-checklist-de.md).
 *
 * Tolerances, declared BEFORE the numbers (the numbers cannot change them):
 *   cell size                     0.25 .. 4 m, derived from the bake density
 *   density warning               below 32 texels per metre (linear)
 *   rays per cell at load         512, chosen for how blocky dark rooms would look
 *   SH representation error (order 2, measured converged with 2048 rays so ray noise is
 *     out of the way):
 *     - relative: p95 <= 5 % on cells where light actually reaches the probe
 *       (truth >= 1 % of the brightest bake value); the worst cell is reported. A
 *       percentage of a near-zero value is not a measurement, so a cell sitting right at
 *       the light floor can show 30 % relative while its absolute error stays under 1 %.
 *       Owner decision 2026-11-23: assert the distribution, report the outlier.
 *     - absolute <= 6.5 % of the brightest bake value on every cell, dark ones included.
 *       6.5 % and not 5 % because irradiance is an integral over the hemisphere and can
 *       be up to pi x a single bake value: an absolute cap of 5 % already means about
 *       1.6 % relative on a cell at full brightness, which is stricter than the relative
 *       rule. 6.5 % is what the owner chose on 2026-11-22 as the absolute view.
 *   ray noise at the load count (512 rays per cell) is REPORTED, not asserted: one ray
 *     in a 512-ray cell moves a cell by roughly 2 % of the brightest value, so the settle
 *     window on screen has to average a few percent. Measured there: median about 3.5 %,
 *     p95 about 14 %. To be invisible at the display step (0.39 %) would need some 50000
 *     rays per cell, which is not a load-time budget — so the honest statement is: the
 *     grid is smooth, not display-exact.
 *   moving object in its own air cell: what order 2 can hold is asserted with the same
 *     rules as above (relative p95 <= 5 %, absolute <= 6.5 %). What the object actually
 *     reads is the 512-ray cell, so its extra error is ray noise: REPORTED, not asserted.
 *     The whole reading (representation + noise, own cell alone) keeps the declared
 *     relative line of 15 %. The shipped path adds the mild smoothing on top, and smoothing
 *     is a picture choice, so its effect on the reading is reported, not asserted.
 *   dirty flag                    marks exactly the cells whose rays see the change
 *   GPU mirror (the same maths the shader runs, checked here because no GPU runs here):
 *     - every checked cell must be found by the hash lookup, and the probe chain must
 *       stay inside the declared limit of 64 probes,
 *     - the slot evaluation must equal the reference for the same cell within f32
 *       rounding (1e-6 absolute),
 *     - the trilinear blend must be a weighted average: weights sum to 1, and the result
 *       must lie inside the range of the corner values it blends. Smoothing is a
 *       guarantee, not an accuracy claim, so the deviation from the single-cell value is
 *       reported separately, split into the two halves: ray noise (which averaging over
 *       8 corners reduces) and the smoothing bias (a neighbour's light is not this
 *       point's light). Blend strength is a picture choice for the owner, so it is swept
 *       and reported, not asserted. Owner chose 0.25 (mild) on 2026-11-23.
 *     - a corner the point cannot see never contributes (owner rule, 2026-11-23): light
 *       cannot come through a wall. Built once at load as a 27-bit mask per cell, so a
 *       pixel only reads a bit. The mask must be re-tested for cells marked dirty by a
 *       state change (an open door makes a pair visible that was blocked). Asserted: the
 *       mask must never allow a corner that a direct sight test at the point rejects.
 *       It may be stricter than the point test (that only costs smoothness), and the
 *       difference is reported.
 *     - the CPU reading path and the GPU mirror must give the same number within f32
 *       rounding (1e-6), because the shader follows the mirror.
 *   WGSL read path (src/render/rt.ts) — WebGPU cannot run on the machine that wrote it, so
 *     the check compares the SHADER TEXT with the functions it claims to mirror. Tolerances,
 *     declared before the numbers:
 *     - every number the grid block uses must be a value the reference module has as a
 *       literal or computes (tolerance 0 differ) — compared as VALUES, not text, because WGSL
 *       cannot call Math.PI and must write the number that expression produces; the blend
 *       strength must come from DEFAULT_BLEND rather than a number copied into the shader, so
 *       changing the module changes the picture;
 *     - the hash re-derived from the numbers in the shader source must land on the same slot
 *       as hashCellKey for 500 random keys (tolerance 0);
 *     - the neighbour-bit expression must equal neighbourBit() for all 27 offsets
 *       (tolerance 0), and the slot layout the shader reads must be the layout packLightGrid
 *       writes (tolerance 1e-6, f32 rounding);
 *     - the probe limit and the stride in the shader must be the declared 64 and 10 vec4;
 *     - no ternary operator in the grid block (this Tint build rejects '?').
 *     The picture itself cannot be verified here; it is checked on the owner's hardware
 *     (docs/test-checklist-de.md, test 7).
 *   file path (owner decision 2026-11-23: the grid is written ONCE at bake time by
 *     tools/write_lightgrid.mjs, the game only reads it — measured build cost is 18.9 s
 *     for this scene, which is a load screen, not a frame):
 *     - the reference measures the precision the file stores, so the bake values here are
 *       half-rounded first. Otherwise the tool could never produce the same numbers as the
 *       reference, and the measured error would be a precision accident.
 *     - the bytes the tool writes must be IDENTICAL to the reference packer's bytes
 *       (tolerance 0 differences), the header must carry the same metadata, and reading the
 *       file back must give the same table and the same lookup results (tolerance 0).
 *     - the scale the tool applies is the loader's scale (x pi). Asserted exact: a texel
 *       decoded through the tool equals the stored half value times pi.
 */
import {
  buildLightGrid, buildNeighbourVisibility, dirtyCellsFor, fillCell, hashCellKey, lastSampleDistance, lastSampleOwn, packLightGrid, projectCoefficients,
  referenceIrradiance, sampleIrradiance, sampleBlendIrradiance, shIrradiance, packedSlot, packedIrradiance, packedBlend, packedBlendIrradiance,
  DEFAULT_BLEND, SH_GRID_STRIDE_VEC4, SH_TERMS, LOBE, neighbourBit, shBasis, trace, toHalfBits, fromHalfBits, decodeHalfTexels, encodeLightGrid, decodeLightGrid, GRID_SCALE,
} from '../src/world/light-grid.ts';
import { buildGridFile } from '../tools/write_lightgrid.mjs';
import fs from 'node:fs';

const RES = 1024;
const TARGET = 4096; // texels per square metre = 64 texels per metre
const WARN = 32;     // texels per metre, linear
const SLOPE = 0.12;  // gradient inside an island, so the bake is smooth, not a hard step

const ISLANDS = [
  { name: 'floorA', value: 0.80, area: 16 },
  { name: 'ceilA', value: 0.45, area: 16 },
  { name: 'wallA', value: 0.70, area: 36 },
  { name: 'doorwallA', value: 0.30, area: 10 },
  { name: 'lampA', value: 1.00, area: 1 },
  { name: 'corrFloor', value: 0.35, area: 3 },
  { name: 'corrCeil', value: 0.35, area: 3 },
  { name: 'corrWall', value: 0.30, area: 9 },
  { name: 'floorB', value: 0.18, area: 36, density: 1000 }, // deliberately sparse: 31.6 texels/m
  { name: 'ceilB', value: 0.20, area: 36 },
  { name: 'wallB', value: 0.12, area: 18 },
  { name: 'doorwallB', value: 0.10, area: 10 },
];
// the reference measure is a percentage, so the scale cancels out — as long as the
// denominator is the brightest value ON THE SAME SCALE as the values being compared.
const BRIGHTEST = Math.max(...ISLANDS.map((i) => i.value)) * GRID_SCALE;

// shelf-packed island rectangles, no overlap, each sized to its target density
const values = new Float64Array(RES * RES * 4);
const rects = {};
let x = 0, y = 0, rowHeight = 0;
for (const island of ISLANDS) {
  const density = island.density ?? TARGET;
  const side = Math.round(Math.sqrt(island.area * density));
  if (x + side > RES) { x = 0; y += rowHeight; rowHeight = 0; }
  rects[island.name] = [x, y, x + side, y + side];
  for (let v = y; v < y + side; v++) {
    for (let u = x; u < x + side; u++) {
      const t = island.value + SLOPE * ((u - x) / side) + SLOPE * ((v - y) / side);
      const i = (v * RES + u) * 4;
      values[i] = t; values[i + 1] = t; values[i + 2] = t;
    }
  }
  x += side; rowHeight = Math.max(rowHeight, side);
  if (y + rowHeight > RES) throw new Error('island layout exceeds the bake resolution');
}

// The bake FILE stores half-float, so the reference measures the precision the game reads —
// otherwise the file tool could never produce the same numbers as the reference. A half texel
// at these values is about 1e-3 absolute, so the percentages below can only move in the third
// decimal. Order matters: round to the stored precision FIRST, then apply the loader's scale
// (radiance x pi), because a scaled value is no longer exactly half-representable.
let halfShift = 0;
for (let i = 0; i < values.length; i++) {
  const h = fromHalfBits(toHalfBits(values[i]));
  if (h !== values[i]) halfShift++;
  values[i] = h;
}
// what a bake run hands the tool is BYTES, not doubles. Reading those bytes back is what the
// game uses, so the reference runs on the decoded values and the tool on the same ones.
const halfBytes = new Uint8Array(values.length * 2);
const halfView = new DataView(halfBytes.buffer);
for (let i = 0; i < values.length; i++) halfView.setUint16(i * 2, toHalfBits(values[i]), true);
const decoded = decodeHalfTexels(halfBytes, RES, GRID_SCALE);
let decodeDiff = 0;
for (let i = 0; i < values.length; i++) {
  if (decoded[i] !== values[i] * GRID_SCALE) decodeDiff++;
  values[i] = decoded[i];
}
console.log(`values stored as half-float: ${halfShift} of ${values.length} texels moved by the rounding ` +
  `(this is the file precision, not a maths error); decode applies the loader's scale exactly, ` +
  `${decodeDiff} texels differ (tolerance 0)`);

/** the island rectangle, as four ordered UV corners matching the quad's corner order */
const uvRect = (name) => {
  const [u0, v0, u1, v1] = rects[name];
  return [[u0 / RES, v0 / RES], [u1 / RES, v0 / RES], [u1 / RES, v1 / RES], [u0 / RES, v1 / RES]];
};

/**
 * One quad per island, as two triangles. The corner order decides the winding:
 * it must face the air side, otherwise the probe is pushed inside the wall and
 * every ray hits the back of the surface (export contract). UV corners follow the
 * same order, so a flip must flip both.
 */
function quad(name, p0, p1, p2, p3, expectedNormal, islandName) {
  const corners = uvRect(name);
  let order = [0, 1, 2, 3];
  const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
  const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  if (nx * expectedNormal[0] + ny * expectedNormal[1] + nz * expectedNormal[2] < 0) order = [0, 3, 2, 1];
  const pts = order.map((i) => [p0, p1, p2, p3][i]);
  const uv = order.map((i) => corners[i]);
  const tri = (a, b, c) => ({
    verts: [...pts[a], ...pts[b], ...pts[c]],
    uv: [...uv[a], ...uv[b], ...uv[c]],
    island: islandName,
  });
  return [tri(0, 1, 2), tri(0, 2, 3)];
}

const UP = [0, 1, 0], DOWN = [0, -1, 0];
const PX = [1, 0, 0], MX = [-1, 0, 0], PZ = [0, 0, 1], MZ = [0, 0, -1];

// room A: x 0..4, z 0..4, height 3. corridor: x 4..7, z 1.5..2.5. room B: x 7..13, z 0..6.
const tris = [
  ...quad('floorA', [0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4], UP, 'floorA'),
  ...quad('ceilA', [0, 3, 0], [0, 3, 4], [4, 3, 4], [4, 3, 0], DOWN, 'ceilA'),
  ...quad('lampA', [1.5, 2.95, 1.5], [2.5, 2.95, 1.5], [2.5, 2.95, 2.5], [1.5, 2.95, 2.5], DOWN, 'lampA'),
  ...quad('wallA', [0, 0, 0], [0, 0, 4], [0, 3, 4], [0, 3, 0], PX, 'wallA'),
  ...quad('wallA', [0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0], PZ, 'wallA'),
  ...quad('wallA', [0, 0, 4], [4, 0, 4], [4, 3, 4], [0, 3, 4], MZ, 'wallA'),
  ...quad('doorwallA', [4, 0, 0], [4, 0, 1.5], [4, 3, 1.5], [4, 3, 0], MX, 'doorwallA'),
  ...quad('doorwallA', [4, 0, 2.5], [4, 0, 4], [4, 3, 4], [4, 3, 2.5], MX, 'doorwallA'),
  ...quad('corrFloor', [4, 0, 1.5], [7, 0, 1.5], [7, 0, 2.5], [4, 0, 2.5], UP, 'corrFloor'),
  ...quad('corrCeil', [4, 3, 1.5], [4, 3, 2.5], [7, 3, 2.5], [7, 3, 1.5], DOWN, 'corrCeil'),
  ...quad('corrWall', [4, 0, 1.5], [7, 0, 1.5], [7, 3, 1.5], [4, 3, 1.5], PZ, 'corrWall'),
  ...quad('corrWall', [4, 0, 2.5], [7, 0, 2.5], [7, 3, 2.5], [4, 3, 2.5], MZ, 'corrWall'),
  ...quad('floorB', [7, 0, 0], [13, 0, 0], [13, 0, 6], [7, 0, 6], UP, 'floorB'),
  ...quad('ceilB', [7, 3, 0], [7, 3, 6], [13, 3, 6], [7, 3, 0], DOWN, 'ceilB'),
  ...quad('wallB', [13, 0, 0], [13, 0, 6], [13, 3, 6], [13, 3, 0], MX, 'wallB'),
  ...quad('doorwallB', [7, 0, 0], [7, 0, 1.5], [7, 3, 1.5], [7, 3, 0], PX, 'doorwallB'),
  ...quad('doorwallB', [7, 0, 2.5], [7, 0, 6], [7, 3, 6], [7, 3, 2.5], PX, 'doorwallB'),
];

const opts = { seed: 777, raysPerCell: 512 };
const t0 = performance.now();
const grid = buildLightGrid(tris, values, RES, opts);
const buildMs = performance.now() - t0;

if (grid.metrics.length !== grid.triangleVertices.length || grid.metrics.length === 0) {
  throw new Error('valid triangle geometry and lightmap metrics must share indices');
}
const surfaceCells = grid.cells.filter((c) => c.kind === 'surface');
const spaceCells = grid.cells.filter((c) => c.kind === 'space');

console.log(`scene: ${tris.length} triangles, ${ISLANDS.length} islands, bake ${RES}x${RES}, target ${TARGET} texels/m²`);
console.log(`cell size from geometry (nothing authored): ${grid.cellSize.toFixed(3)} m`);
console.log(`cells: ${surfaceCells.length} surface + ${spaceCells.length} space = ${grid.cells.length}`);
// the load-time cost, measured (not estimated): this is what a player waits for at load.
const t1 = performance.now();
const vis = buildNeighbourVisibility(grid);
const visMs = performance.now() - t1;
console.log(`load-time cost on this machine (JS, single thread): cells ${buildMs.toFixed(0)} ms, ` +
  `neighbour visibility ${visMs.toFixed(0)} ms`);
console.log(`neighbour visibility (one ray per pair, once at load): ${vis.blocked} of ${(grid.cells.length * 26).toLocaleString()} ` +
  `pairs blocked by geometry, ${vis.absent} positions with no cell (solid material or air that sees nothing)`);
const packed = packLightGrid(grid);
if (packed.cellCount !== grid.cells.length || packed.slotCount < grid.cells.length * 2) {
  throw new Error('GPU SH hash table has an unsafe load factor');
}
for (const cell of [grid.cells[0], grid.cells[Math.floor(grid.cells.length / 2)], grid.cells.at(-1)]) {
  const [ix, iy, iz] = cell.key.split(',').map(Number);
  const start = hashCellKey(ix, iy, iz, packed.slotCount - 1);
  let found = false;
  for (let probe = 0; probe < packed.slotCount; probe++) {
    const base = ((start + probe) & (packed.slotCount - 1)) * 40;
    if (packed.data[base + 3] === 0) break;
    if (packed.data[base] === ix && packed.data[base + 1] === iy && packed.data[base + 2] === iz) { found = true; break; }
  }
  if (!found) throw new Error(`GPU SH table lost voxel ${cell.key}`);
}
console.log(`GPU SH table: ${packed.slotCount} slots, ${packed.data.byteLength} bytes, ` +
  `${(grid.cells.length / packed.slotCount * 100).toFixed(1)} % load`);

const pct = (a, b) => Math.abs(a - b) / Math.max(1e-6, b) * 100;
const ofBrightest = (a, b) => Math.abs(a - b) / BRIGHTEST * 100;
const pctile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// 1) density per island + the warn path (only surface cells carry bake texels)
const warned = [];
console.log(`density per island (warn below ${WARN} texels/m):`);
for (const island of ISLANDS) {
  const cells = surfaceCells.filter((c) => tris[c.own[0]].island === island.name).map((c) => Math.sqrt(c.density));
  const min = Math.min(...cells);
  if (min < WARN) warned.push({ island: island.name, min });
  console.log(`  ${island.name}: ${min.toFixed(1)} texels/m${min < WARN ? '  WARN' : ''}`);
}

// 2) Two different things, and they must not be mixed:
//    a) REPRESENTATION error: what order-2 SH cannot show. Measured with a converged
//       ray set (2048 rays) on BOTH sides, so the ray noise is out of the way.
//    b) RAY NOISE: what one cell actually stores at the runtime count (128 rays),
//       compared with the converged truth. This is what the user should not see.
// An air cell has no normal — it is a point in space — so it is evaluated with the
// normal of an object standing there (UP); a surface cell uses its own surface normal.
// Every surface cell and 24 evenly spaced air cells are checked. This is a deterministic
// coverage sample of the full grid; checking 2048 rays in all 11k air cells takes
// several minutes without changing the asserted math. A relative error on a cell where almost no light arrives is meaningless (percent of
// a near-zero number), so the 5 % rule is applied only where light actually reaches
// the probe: truth >= 1 % of the brightest bake value. Dark cells are judged by the
// absolute rule. Nothing here is a weakened tolerance, it is the honest reading of
// "5 % of the light that arrives".
const LIGHT_FLOOR = BRIGHTEST * 0.01;
const CONVERGED = 2048;
const checkCells = [...surfaceCells];
const airStride = Math.max(1, Math.floor(spaceCells.length / 24));
for (let i = 0; i < spaceCells.length; i += airStride) checkCells.push(spaceCells[i]);
let worstRepRel = 0, worstRepRelCell = null, worstRepAbs = 0, worstRepAbsCell = null;
let worstNoiseAbs = 0, worstNoiseAbsCell = null;
let darkCells = 0, darkRelMax = 0;
const offenders = [];
const relLit = [], absAll = [], noiseLit = [], litCells = new Set();
// how the relative error depends on how much light actually arrives. Reported, not asserted,
// because a percentage of a near-zero value is not a measurement.
const REL_BANDS = [1, 5, 10, 25, 50];
const bandRel = Object.fromEntries(REL_BANDS.map((b) => [b, []]));
// the converged truth per checked cell, reused by the GPU mirror so the smoothing is
// judged against the same measurement, not against another noisy sample
const truthByCell = new Map();
for (const c of checkCells) {
  const ci = grid.cellOfKey.get(c.key);
  const skip = new Set(c.own);
  const n = c.kind === 'surface' ? [c.nx, c.ny, c.nz] : UP;
  const converged = new Float64Array(27);
  projectCoefficients(grid, values, c.px, c.py, c.pz, CONVERGED, opts.seed + ci, skip, converged);
  const truth = new Float64Array(3), rep = new Float64Array(3), stored = new Float64Array(3);
  referenceIrradiance(grid, values, c.px, c.py, c.pz, n[0], n[1], n[2], truth, { ...opts, raysPerCell: CONVERGED }, opts.seed + ci, skip);
  shIrradiance(converged, n[0], n[1], n[2], rep);
  shIrradiance(grid.sh.subarray(ci * 27, ci * 27 + 27), n[0], n[1], n[2], stored);
  const repRel = Math.max(pct(rep[0], truth[0]), pct(rep[1], truth[1]), pct(rep[2], truth[2]));
  const repAbs = Math.max(ofBrightest(rep[0], truth[0]), ofBrightest(rep[1], truth[1]), ofBrightest(rep[2], truth[2]));
  const noiseAbs = Math.max(ofBrightest(stored[0], truth[0]), ofBrightest(stored[1], truth[1]), ofBrightest(stored[2], truth[2]));
  const truthMax = Math.max(truth[0], truth[1], truth[2]);
  if (truthMax < LIGHT_FLOOR) {
    darkCells++;
    darkRelMax = Math.max(darkRelMax, repRel);
  } else {
    litCells.add(c.key);
    truthByCell.set(c.key, [truth[0], truth[1], truth[2]]);
    relLit.push(repRel);
    noiseLit.push(noiseAbs);
    for (const b of REL_BANDS) if (truthMax >= BRIGHTEST * b / 100) bandRel[b].push(repRel);
    if (repRel > worstRepRel) { worstRepRel = repRel; worstRepRelCell = c; }
  }
  absAll.push(repAbs);
  if (repAbs > worstRepAbs) { worstRepAbs = repAbs; worstRepAbsCell = c; }
  if (noiseAbs > worstNoiseAbs) { worstNoiseAbs = noiseAbs; worstNoiseAbsCell = c; }
  if (repAbs > 6.5) offenders.push(`${c.kind} ${c.key}: order-2 ${(n === UP ? 'UP' : 'surface normal')} ` +
    `reconstructs ${rep[0].toFixed(4)} where ${CONVERGED} rays measure ${truth[0].toFixed(4)}`);
}
console.log(`SH representation error (order 2, ${CONVERGED} rays, ${checkCells.length}/${grid.cells.length} stratified cells): ` +
  `absolute rule (tolerance 6.5 % of the brightest bake value), over all ${absAll.length} checked cells: ` +
  `median ${pctile(absAll, 0.5).toFixed(2)} p95 ${pctile(absAll, 0.95).toFixed(2)} p99 ${pctile(absAll, 0.99).toFixed(2)} worst ${worstRepAbs.toFixed(2)} % ` +
  `(${worstRepAbsCell.kind} cell ${worstRepAbsCell.key})`);
console.log(`  relative rule (tolerance p95 5 %), on the ${relLit.length} cells where light arrives: ` +
  `median ${pctile(relLit, 0.5).toFixed(2)} p95 ${pctile(relLit, 0.95).toFixed(2)} | worst reported ${worstRepRel.toFixed(2)} % ` +
  `(${worstRepRelCell.kind} cell ${worstRepRelCell.key}); ` +
  `${darkCells} near-dark cells judged by the absolute rule only (their worst relative ${darkRelMax.toFixed(1)} % is a percentage of a near-zero value, not a measurement)`);
for (const b of REL_BANDS) {
  const arr = bandRel[b];
  if (arr.length === 0) continue;
  console.log(`  relative error where at least ${b} % of the brightest light arrives (${arr.length} cells): ` +
    `median ${pctile(arr, 0.5).toFixed(2)} p95 ${pctile(arr, 0.95).toFixed(2)} worst ${Math.max(...arr).toFixed(2)} %`);
}
console.log(`  ray noise at the load count (${opts.raysPerCell} rays), on cells where light arrives: ` +
  `median ${pctile(noiseLit, 0.5).toFixed(2)} p95 ${pctile(noiseLit, 0.95).toFixed(2)} worst ${worstNoiseAbs.toFixed(2)} % ` +
  `of the brightest value (cell ${worstNoiseAbsCell.key}) — reported, not asserted`);
if (offenders.length) console.log('  cells over the representation tolerance: ' + offenders.slice(0, 12).join(' | '));

// 3) moving objects in air, read from the cell they are in
console.log('moving objects in their own cell vs direct integral at the same point:');
const errors = [];
for (const [label, p, n] of [
  ['player in room A under the lamp', [2.05, 1.55, 2.05], UP],
  ['player in room B', [10.1, 1.0, 3.1], UP],
  ['entity in the doorway', [5.55, 1.2, 2.05], UP],
  ['entity near wall A', [0.65, 1.2, 2.05], PX],
  ['moving door face in the doorway', [4.3, 1.2, 2.0], MX],
]) {
  const g = new Float64Array(3), r = new Float64Array(3), rep = new Float64Array(3), proj = new Float64Array(27);
  const ci = sampleIrradiance(grid, p[0], p[1], p[2], n[0], n[1], n[2], g);
  if (ci < 0) throw new Error(`${label}: no cell found, the air was not covered`);
  referenceIrradiance(grid, values, p[0], p[1], p[2], n[0], n[1], n[2], r, { ...opts, raysPerCell: CONVERGED }, opts.seed + ci);
  // the same rays projected with order 2 at the same point: pure representation error,
  // so the difference against `g` is what the load ray count adds on top (ray noise).
  projectCoefficients(grid, values, p[0], p[1], p[2], CONVERGED, opts.seed + ci, new Set(), proj);
  shIrradiance(proj, n[0], n[1], n[2], rep);
  const rel = Math.max(pct(g[0], r[0]), pct(g[1], r[1]), pct(g[2], r[2]));
  const abs = Math.max(ofBrightest(g[0], r[0]), ofBrightest(g[1], r[1]), ofBrightest(g[2], r[2]));
  const relRep = Math.max(pct(rep[0], r[0]), pct(rep[1], r[1]), pct(rep[2], r[2]));
  const absRep = Math.max(ofBrightest(rep[0], r[0]), ofBrightest(rep[1], r[1]), ofBrightest(rep[2], r[2]));
  const lit = Math.max(r[0], r[1], r[2]) >= LIGHT_FLOOR;
  const own = lastSampleOwn;
  const noise = Math.max(ofBrightest(g[0], rep[0]), ofBrightest(g[1], rep[1]), ofBrightest(g[2], rep[2]));
  // what the shipped path gives at this point: own cell + mild blend over the visible corners
  const b = new Float64Array(3);
  const bi = sampleBlendIrradiance(grid, p[0], p[1], p[2], n[0], n[1], n[2], b, DEFAULT_BLEND);
  const relB = Math.max(pct(b[0], r[0]), pct(b[1], r[1]), pct(b[2], r[2]));
  const absB = Math.max(ofBrightest(b[0], r[0]), ofBrightest(b[1], r[1]), ofBrightest(b[2], r[2]));
  errors.push({ label, rel, abs, relRep, absRep, noise, relB, absB, lit, own, dist: lastSampleDistance });
  console.log(`  ${label}: ${grid.cells[bi].kind} cell ${grid.cells[bi].key} ` +
    `(${own ? 'own voxel' : `nearest cell ${lastSampleDistance.toFixed(2)} m`}), ` +
    `representation ${relRep.toFixed(2)} % rel / ${absRep.toFixed(2)} % abs, + noise ${noise.toFixed(2)} % abs = ` +
    `own cell ${rel.toFixed(2)} % rel / ${abs.toFixed(2)} % abs; shipped path (mild blend) ` +
    `${relB.toFixed(2)} % rel / ${absB.toFixed(2)} % abs${lit ? '' : ' (near-dark)'}`);
}
console.log(`  noise alone on the ${errors.filter((e) => e.lit).length} lit points (reported, not asserted): ` +
  `worst ${Math.max(...errors.map((e) => e.noise)).toFixed(2)} % of the brightest value`);
const shippedAbs = errors.filter((e) => e.lit).map((e) => e.absB);
const shippedRel = errors.filter((e) => e.lit).map((e) => e.relB);
console.log(`  shipped path at those points (mild blend ${DEFAULT_BLEND}, gated by visibility): ` +
  `absolute median ${pctile(shippedAbs, 0.5).toFixed(2)} p95 ${pctile(shippedAbs, 0.95).toFixed(2)} ` +
  `worst ${Math.max(...shippedAbs).toFixed(2)} % | relative median ${pctile(shippedRel, 0.5).toFixed(2)} ` +
  `p95 ${pctile(shippedRel, 0.95).toFixed(2)} worst ${Math.max(...shippedRel).toFixed(2)} % — ` +
  `reported: this is representation + noise + the smoothing itself, so it is not the asserted rule`);

// 4) dirty flag: the lamp island goes dark. The cells that must be marked are the
//    ones whose rays see it; recomputing only those must equal a full rebuild.
const lampTris = tris.map((t, i) => i).filter((i) => tris[i].island === 'lampA');
const marked = dirtyCellsFor(grid, lampTris);
// snapshot before the dirty test mutates anything: the FILE is the base state, because a
// state change only dirties cells afterwards. So the tool's output has to match the grid as
// it was built, not the grid after this test.
const baseBytes = encodeLightGrid(packed);
const baseValues = Float64Array.from(values);
const snapshot = Float64Array.from(grid.sh);
for (let v = rects.lampA[1]; v < rects.lampA[3]; v++) {
  for (let u = rects.lampA[0]; u < rects.lampA[2]; u++) {
    const i = (v * RES + u) * 4;
    values[i] = 0; values[i + 1] = 0; values[i + 2] = 0;
  }
}
for (const ci of marked) fillCell(grid, ci, values, opts, opts.seed);
let fullChanged = 0;
for (let ci = 0; ci < grid.cells.length; ci++) {
  for (let i = 0; i < 27; i++) {
    if (Math.abs(grid.sh[ci * 27 + i] - snapshot[ci * 27 + i]) > 1e-12) { fullChanged++; break; }
  }
}
const lampCell = marked[0];
console.log(`dirty flag: marked ${marked.length} cells, a full rebuild would have changed ${fullChanged}`);
console.log(`cell ${grid.cells[lampCell].key} irradiance ${(Math.PI * grid.sh[lampCell * 27]).toFixed(4)} ` +
  `(was ${(Math.PI * snapshot[lampCell * 27]).toFixed(4)})`);

// 5) GPU mirror: the hash lookup and the coefficient evaluation the shader runs,
//    plus the trilinear blend over the 8 corner voxels. Re-packed AFTER the dirty
//    update, so this also proves a dirtied cell reaches the table the GPU reads.
const PROBE_LIMIT = 64;
const table = packLightGrid(grid);
const chainOf = (ix, iy, iz) => {
  const start = hashCellKey(ix, iy, iz, table.slotCount - 1);
  const slot = packedSlot(table, ix, iy, iz, PROBE_LIMIT);
  if (slot < 0) return -1;
  let probes = 0;
  let cur = start;
  while (cur !== slot) { probes++; cur = (cur + 1) & (table.slotCount - 1); }
  return probes + 1;
};
const mirrorOut = new Float64Array(3), blendOut = new Float64Array(3), cornerOut = new Float64Array(3);
const ownOut = new Float64Array(3);
const sample = { ownSlot: -1, slots: [], weights: [], missing: 0, gated: 0 };
let lostCells = 0, maxChain = 0, evalErrMax = 0, outsideRange = 0, weightSumErr = 0;
const cornerCounts = [], singleErr = [], blendErr = [];
// blend strength sweep: 0 = own cell only, 1 = full trilinear. Reported so the picture
// decision can be made on numbers: softer picture, more spatial error.
const FACTORS = [0, 0.25, 0.5, 1];
const factorErr = Object.fromEntries(FACTORS.map((f) => [f, []]));
// The two halves of the blended value, measured separately:
//   noise  = what the 512-ray cell content adds. Averaging 8 corners averages that
//            noise away, so the blend should be SMOOTH here.
//   bias   = what the smoothing itself adds: the neighbour's light is not this point's
//            light. Converged coefficients per corner cell (the same rays as the truth),
//            so this half contains no ray noise at all.
const convCache = new Map();
const convergedCoeffs = (key) => {
  const cached = convCache.get(key);
  if (cached) return cached;
  const ci = grid.cellOfKey.get(key);
  const cell = grid.cells[ci];
  const co = new Float64Array(27);
  projectCoefficients(grid, values, cell.px, cell.py, cell.pz, CONVERGED, opts.seed + ci, new Set(cell.own), co);
  convCache.set(key, co);
  return co;
};
const keyOfSlot = (slot) => {
  const base = slot * SH_GRID_STRIDE_VEC4 * 4;
  return `${table.data[base]},${table.data[base + 1]},${table.data[base + 2]}`;
};
const cornerTruth = new Float64Array(3);
const blendNoise = [], blendBias = [], ownNoise = [];
const gatedCounts = [];
let cpuGpuAgree = 0, missedReading = 0, maskMismatch = 0, maskAllowsBlocked = 0, maskBlocksVisible = 0, cornersChecked = 0;
for (const c of checkCells) {
  const [ix, iy, iz] = c.key.split(',').map(Number);
  const slot = packedSlot(table, ix, iy, iz, PROBE_LIMIT);
  if (slot < 0) { lostCells++; continue; }
  maxChain = Math.max(maxChain, chainOf(ix, iy, iz));
  const n = c.kind === 'surface' ? [c.nx, c.ny, c.nz] : UP;
  if (Math.max(...n) > 0) {
    const ref = new Float64Array(3);
    shIrradiance(grid.sh.subarray(grid.cellOfKey.get(c.key) * 27, grid.cellOfKey.get(c.key) * 27 + 27), n[0], n[1], n[2], ref);
    packedIrradiance(table, slot, n, mirrorOut);
    evalErrMax = Math.max(evalErrMax, Math.max(Math.abs(mirrorOut[0] - ref[0]), Math.abs(mirrorOut[1] - ref[1]), Math.abs(mirrorOut[2] - ref[2])));
  }
  packedBlend(table, c.px, c.py, c.pz, grid.cellSize, sample, PROBE_LIMIT);
  let sum = 0;
  for (const w of sample.weights) sum += w;
  weightSumErr = Math.max(weightSumErr, Math.abs(sum - 1));
  cornerCounts.push(sample.slots.length);
  gatedCounts.push(sample.gated);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const s of sample.slots) {
    packedIrradiance(table, s, n, cornerOut);
    for (let ch = 0; ch < 3; ch++) { lo[ch] = Math.min(lo[ch], cornerOut[ch]); hi[ch] = Math.max(hi[ch], cornerOut[ch]); }
  }
  packedBlendIrradiance(table, sample, n, blendOut);
  for (let ch = 0; ch < 3; ch++) if (blendOut[ch] < lo[ch] - 1e-9 || blendOut[ch] > hi[ch] + 1e-9) outsideRange++;
  // the CPU reading path and the mirror must give the same number, because the shader
  // follows the mirror
  const cpu = new Float64Array(3);
  const cpuCell = sampleBlendIrradiance(grid, c.px, c.py, c.pz, n[0], n[1], n[2], cpu, DEFAULT_BLEND);
  let agree = 0;
  for (let ch = 0; ch < 3; ch++) agree = Math.max(agree, Math.abs(cpu[ch] - blendOut[ch]));
  cpuGpuAgree = Math.max(cpuGpuAgree, agree);
  if (cpuCell < 0) missedReading++;
  if (!litCells.has(c.key)) continue; // accuracy of a blend is meaningless on a near-dark cell
  packedIrradiance(table, slot, n, ownOut);
  const truth = truthByCell.get(c.key);
  let e1 = 0, e2 = 0;
  for (let ch = 0; ch < 3; ch++) {
    e1 = Math.max(e1, ofBrightest(ownOut[ch], truth[ch]));
    e2 = Math.max(e2, ofBrightest(blendOut[ch], truth[ch]));
  }
  singleErr.push(e1);
  blendErr.push(e2);
  // the same point, but every corner cell with converged rays: that is the blend without
  // any ray noise, so the difference to the table is noise and the difference to the truth
  // is what the smoothing itself introduces.
  const convBlend = [0, 0, 0];
  for (let i = 0; i < sample.slots.length; i++) {
    shIrradiance(convergedCoeffs(keyOfSlot(sample.slots[i])), n[0], n[1], n[2], cornerTruth);
    for (let ch = 0; ch < 3; ch++) convBlend[ch] += cornerTruth[ch] * sample.weights[i];
  }
  const ownConv = new Float64Array(3);
  shIrradiance(convergedCoeffs(c.key), n[0], n[1], n[2], ownConv);
  let bn = 0, bb = 0, on = 0;
  for (let ch = 0; ch < 3; ch++) {
    bn = Math.max(bn, ofBrightest(blendOut[ch], convBlend[ch]));
    bb = Math.max(bb, ofBrightest(convBlend[ch], truth[ch]));
    on = Math.max(on, ofBrightest(ownOut[ch], ownConv[ch]));
  }
  blendNoise.push(bn);
  blendBias.push(bb);
  ownNoise.push(on);
  // how much of the value comes from the neighbourhood. Reported, not asserted: a blend
  // is a smoothing choice, and smoothing moves a point away from its own true value.
  for (const f of FACTORS) {
    packedBlendIrradiance(table, sample, n, blendOut, f);
    let e = 0;
    for (let ch = 0; ch < 3; ch++) e = Math.max(e, ofBrightest(blendOut[ch], truth[ch]));
    factorErr[f].push(e);
  }
  // The mask is built between cell CENTRES, so at a point inside a cell it can differ from
  // looking straight at the corner. Checked here: the mask may be stricter than the direct
  // sight test (that only loses smoothness), but it must never allow a corner the point
  // cannot see — that would be light through a wall, and that is asserted.
  for (let i = 0; i < sample.slots.length; i++) {
    const keyB = keyOfSlot(sample.slots[i]);
    const cb = grid.cells[grid.cellOfKey.get(keyB)];
    const [bx, by, bz] = keyB.split(',').map(Number);
    const vx = cb.px - c.px, vy = cb.py - c.py, vz = cb.pz - c.pz;
    const len = Math.hypot(vx, vy, vz);
    if (len <= 1e-6) continue;
    const hit = trace(grid, c.px, c.py, c.pz, vx / len, vy / len, vz / len, len);
    const direct = hit < 0 || c.own.includes(hit);
    const bit = (grid.neighbourMask[grid.cellOfKey.get(c.key)] & (1 << neighbourBit(bx - ix, by - iy, bz - iz))) !== 0;
    cornersChecked++;
    if (direct === bit) continue;
    maskMismatch++;
    if (bit && !direct) maskAllowsBlocked++;
    if (!bit && direct) maskBlocksVisible++;
  }
}
console.log(`GPU mirror (${checkCells.length} cells, f32 table, ${table.slotCount} slots): ` +
  `lost ${lostCells}, worst probe chain ${maxChain} (limit ${PROBE_LIMIT}), ` +
  `evaluation vs reference ${evalErrMax.toExponential(1)} (tolerance 1e-6), ` +
  `weight sum error ${weightSumErr.toExponential(1)}, blend outside the corner range ${outsideRange}`);
console.log(`  smoothing on the ${blendErr.length} cells where light arrives: corners found per point median ${pctile(cornerCounts, 0.5)} (of 8), ` +
  `error against the converged truth at the same point — own cell alone median ${pctile(singleErr, 0.5).toFixed(2)} p95 ${pctile(singleErr, 0.95).toFixed(2)} ` +
  `worst ${Math.max(...singleErr).toFixed(2)} % | blended median ${pctile(blendErr, 0.5).toFixed(2)} p95 ${pctile(blendErr, 0.95).toFixed(2)} ` +
  `worst ${Math.max(...blendErr).toFixed(2)} % — reported, not asserted`);
for (const f of FACTORS) {
  const arr = factorErr[f];
  console.log(`  blend strength ${f}: median ${pctile(arr, 0.5).toFixed(2)} p95 ${pctile(arr, 0.95).toFixed(2)} ` +
    `worst ${Math.max(...arr).toFixed(2)} % of the brightest value`);
}
console.log(`  the same cells split into the two halves of the value (at the shipped strength ${DEFAULT_BLEND}): ` +
  `ray-noise part median ${pctile(blendNoise, 0.5).toFixed(2)} p95 ${pctile(blendNoise, 0.95).toFixed(2)} ` +
  `worst ${Math.max(...blendNoise).toFixed(2)} %, own cell alone median ${pctile(ownNoise, 0.5).toFixed(2)} ` +
  `p95 ${pctile(ownNoise, 0.95).toFixed(2)} worst ${Math.max(...ownNoise).toFixed(2)} % | ` +
  `smoothing bias median ${pctile(blendBias, 0.5).toFixed(2)} p95 ${pctile(blendBias, 0.95).toFixed(2)} ` +
  `worst ${Math.max(...blendBias).toFixed(2)} %`);
console.log(`  corner cells measured with converged rays: ${convCache.size}`);
console.log(`  corners the point cannot see (the load-time mask, checked points): median ${pctile(gatedCounts, 0.5)} of 8, ` +
  `p95 ${pctile(gatedCounts, 0.95)}, worst ${Math.max(...gatedCounts)}; points where all 8 corners count ` +
  `${gatedCounts.filter((g) => g === 0).length}/${gatedCounts.length}; CPU reading path and mirror agree within ` +
  `${cpuGpuAgree.toExponential(1)} (tolerance 1e-6), points that read nothing ${missedReading}`);
console.log(`  mask vs direct sight at these points (${cornersChecked} corners): ` +
  `mask allows a corner the point cannot see: ${maskAllowsBlocked} (tolerance 0), ` +
  `mask blocks a corner the point can see: ${maskBlocksVisible} (loses smoothness only), ` +
  `total differ ${maskMismatch}`);

// 5) file path — the tool's core function, called with the same inputs the reference ran on,
//    must produce exactly the table the check measured. Compared against the BASE state,
//    because the file is the base state: a state change dirties single cells afterwards, it
//    does not rewrite the file.
const scene = { resolution: RES, seed: opts.seed, raysPerCell: opts.raysPerCell, tris };
const t2 = performance.now();
const tool = buildGridFile(scene, baseValues);
const toolMs = performance.now() - t2;
const t3 = performance.now();
const readBack = decodeLightGrid(tool.bytes);
const decodeMs = performance.now() - t3;
// the disk trap, kept as an assert: a file arrives as a VIEW into a bigger buffer, so the
// decode must copy instead of pointing at the caller's buffer. Reading through a view is what
// the first CLI run got wrong (correct header, empty table).
const padded = new Uint8Array(64 + tool.bytes.length);
padded.set(tool.bytes, 64);
const fromView = decodeLightGrid(padded.subarray(64));
let viewDiff = 0;
for (let i = 0; i < readBack.data.length; i++) if (fromView.data[i] !== readBack.data[i]) viewDiff++;
for (let i = 0; i < readBack.neighbourMask.length; i++) if (fromView.neighbourMask[i] !== readBack.neighbourMask[i]) viewDiff++;
let byteDiff = 0;
const byteLenOk = tool.bytes.length === baseBytes.length;
if (byteLenOk) for (let i = 0; i < baseBytes.length; i++) if (tool.bytes[i] !== baseBytes[i]) byteDiff++;
const META = ['cellSize', 'resolution', 'seed', 'raysPerCell', 'blend', 'slotCount', 'cellCount'];
const metaDiff = META.filter((k) => readBack[k] !== packed[k]);
let slotDiff = 0, slotValueDiff = 0;
const refOut = new Float64Array(3), fileOut = new Float64Array(3);
for (const c of checkCells) {
  const [cx, cy, cz] = c.key.split(',').map(Number);
  const a = packedSlot(packed, cx, cy, cz, PROBE_LIMIT);
  const b = packedSlot(readBack, cx, cy, cz, PROBE_LIMIT);
  if (a !== b) { slotDiff++; continue; }
  packedIrradiance(packed, a, UP, refOut);
  packedIrradiance(readBack, b, UP, fileOut);
  for (let ch = 0; ch < 3; ch++) if (fileOut[ch] !== refOut[ch]) slotValueDiff++;
}
console.log(`file path (tolerance 0 differences, base state): bytes ${byteLenOk ? `identical length (${tool.bytes.length})` : `LENGTH DIFFERS ${tool.bytes.length} vs ${baseBytes.length}`}, ` +
  `bytes that differ ${byteDiff}, metadata ${metaDiff.length ? `differs: ${metaDiff.join(',')}` : 'identical'}, ` +
  `half decode ${decodeDiff} texels differ, lookups ${slotDiff} differ, slot values ${slotValueDiff} differ, ` +
  `reading through a buffer view ${viewDiff} differ`);
console.log(`  what the game pays at load: reading ${tool.bytes.length} bytes ${decodeMs.toFixed(1)} ms, ` +
  `versus building the same grid ${buildMs.toFixed(0)} ms — the cost moved to the bake run (${toolMs.toFixed(0)} ms there)`);

// 6) WGSL mirror — the shader cannot be RUN here (no WebGPU on this machine), so the check
//    compares the shader TEXT against the functions it claims to mirror. The picture itself
//    is verified on the owner's hardware (docs/test-checklist-de.md, test 7).
const rtSrc = fs.readFileSync(new URL('../src/render/rt.ts', import.meta.url), 'utf8');
const lgSrc = fs.readFileSync(new URL('../src/world/light-grid.ts', import.meta.url), 'utf8');
const blockStart = rtSrc.indexOf('fn gridHash');
const block = rtSrc.slice(blockStart, rtSrc.indexOf('fn shadowFactor'));
// Values the reference module uses, compared as VALUES (not text): every number it writes
// (decimal or hex) plus the ones it computes. WGSL cannot call Math.PI, so the shader must
// write the number the module's expression produces — that is exactly what this compares.
// The declared rule numbers (probe limit, term count, slot layout, blend strength) are
// asserted on their own lines below, so they count as allowed here too.
const numeric = (text) => [...new Set([...text.matchAll(/(0x[0-9a-f]+|\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])))];
const moduleValues = new Set(numeric(lgSrc));
for (const v of LOBE) moduleValues.add(v);
for (const v of [PROBE_LIMIT, SH_TERMS, SH_GRID_STRIDE_VEC4, SH_GRID_STRIDE_VEC4 * 4, DEFAULT_BLEND]) moduleValues.add(v);
const shaderValues = numeric(block);
const foreign = shaderValues.filter((v) => !moduleValues.has(v));
const ternary = (block.match(/\?/g) ?? []).length;
// the hash re-derived from the shader's own numbers must land on the same slot as hashCellKey
const hashBody = block.slice(block.indexOf('fn gridHash'), block.indexOf('return h & hmask'));
const hmul = [...hashBody.matchAll(/\* (\d+)u/g)].map((m) => Number(m[1]));
const hshift = [...hashBody.matchAll(/>> (\d+)u/g)].map((m) => Number(m[1]));
const u32mul = (a, b) => Math.imul(a, b) >>> 0;
const wgslHash = (ix, iy, iz, mask) => {
  let h = (u32mul(ix, hmul[0]) ^ u32mul(iy, hmul[1]) ^ u32mul(iz, hmul[2])) >>> 0;
  h = (h ^ (h >>> hshift[0])) >>> 0; h = u32mul(h, hmul[3]);
  h = (h ^ (h >>> hshift[1])) >>> 0; h = u32mul(h, hmul[4]);
  h = (h ^ (h >>> hshift[2])) >>> 0;
  return h & mask;
};
let hashDiff = 0;
for (let n = 0; n < 500; n++) {
  const ix = ((u32mul(n + 1, 2654435761) % 400) | 0) - 200;
  const iy = ((u32mul(n + 7, 1582357219) % 400) | 0) - 200;
  const iz = ((u32mul(n + 13, 919353277) % 400) | 0) - 200;
  if (wgslHash(ix, iy, iz, packed.slotCount - 1) !== hashCellKey(ix, iy, iz, packed.slotCount - 1)) hashDiff++;
}
// neighbour bit: the shader's expression must equal neighbourBit() for all 27 offsets
const bitExpr = block.match(/\(\(a \+ (\d+)u\) \* (\d+)u \+ \(b \+ (\d+)u\) \* (\d+)u \+ \(c \+ (\d+)u\)\)/);
let bitDiff = 0;
if (bitExpr) {
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const bit = (a + Number(bitExpr[1])) * Number(bitExpr[2]) +
      (b + Number(bitExpr[3])) * Number(bitExpr[4]) + (c + Number(bitExpr[5]));
    if (bit !== neighbourBit(a, b, c)) bitDiff++;
  }
}
// slot layout the shader reads, read out of the source
const stride = Number(block.match(/bitcast<u32>\(slot\) \* (\d+)u/)[1]);
const header = Number(block.match(/slot\) \* \d+u \+ (\d+)u/)[1]);
const termStride = Number(block.match(/k \* (\d+)u/)[1]);
const channels = [...new Set([...block.matchAll(/base \+ k \* \d+u(?: \+ (\d+)u)?/g)].map((m) => (m[1] === undefined ? 0 : Number(m[1]))))].sort((x, y) => x - y);
const probeLimit = Number(block.match(/step < (\d+)u/)[1]);
const lobes = [...block.slice(block.indexOf('fn gridLobe'), block.indexOf('fn gridBasis')).matchAll(/\d+\.\d+/g)].map((m) => Number(m[0]));
const bandEnd = Number(block.match(/k < (\d+)u/)[1]);
// evaluate a slot through the numbers PARSED from the shader and compare with the reference
let mirrorMax = 0;
const mirrorBasis = new Float64Array(SH_TERMS);
const wgslOut = new Float64Array(3);
for (const c of checkCells) {
  const [cx, cy, cz] = c.key.split(',').map(Number);
  const slot = packedSlot(packed, cx, cy, cz, PROBE_LIMIT);
  if (slot < 0) continue;
  const n = c.kind === 'surface' ? [c.nx, c.ny, c.nz] : UP;
  if (Math.max(...n) === 0) continue;
  shBasis(n[0], n[1], n[2], mirrorBasis);
  packedIrradiance(packed, slot, n, refOut);
  const base = slot * stride + header;
  for (let ch = 0; ch < 3; ch++) {
    let e = 0;
    for (let k = 0; k < SH_TERMS; k++) {
      const lobe = k === 0 ? lobes[0] : k < bandEnd ? lobes[1] : lobes[2];
      e += lobe * packed.data[base + k * termStride + ch] * mirrorBasis[k];
    }
    wgslOut[ch] = e;
  }
  for (let ch = 0; ch < 3; ch++) mirrorMax = Math.max(mirrorMax, Math.abs(wgslOut[ch] - refOut[ch]));
}
const usesModuleBlend = rtSrc.includes('DEFAULT_BLEND') && !block.includes('0.25');
const gatesFromMask = block.includes('rt_gridmask.value[') && block.includes('select(');
const cellBranch = rtSrc.slice(rtSrc.indexOf('var cellStatic'), rtSrc.indexOf('fn gridHash'));
const readsGate = cellBranch.includes('gridBlendIrradiance(') && cellBranch.includes('skipBaked = 1.0');
console.log(`WGSL mirror (shader TEXT, WebGPU cannot run on this machine): ${shaderValues.length} numbers, ` +
  `${foreign.length} not a value the module has (tolerance 0)` +
  (foreign.length ? ` [${foreign.join(', ')}]` : '') + `, hash ${hashDiff} of 500 keys differ, ` +
  `bit formula ${bitDiff} of 27 offsets differ, layout ${stride} floats / header ${header} / term ${termStride} ` +
  `+ channels ${channels.join('')}, probe limit ${probeLimit}, ternary ${ternary}, ` +
  `blend from DEFAULT_BLEND ${usesModuleBlend}, gate reads the mask ${gatesFromMask}, ` +
  `dynamic branch uses it + sets skipBaked ${readsGate}, slot values ${mirrorMax.toExponential(1)} (tolerance 1e-6)`);

// asserts, in the order the tolerances were declared
if (grid.cellSize < 0.25 || grid.cellSize > 4) throw new Error('cell size left its clamp');
if (warned.length === 0) throw new Error('density warning never fired — the sparse island was not measured');
if (warned.length !== 1 || warned[0].island !== 'floorB') throw new Error('density warning fired outside the deliberately sparse island');
if (spaceCells.length === 0) throw new Error('no air cells were built — a moving object would have nothing to read');
if (worstRepAbs > 6.5) throw new Error(`SH representation error ${worstRepAbs.toFixed(2)} % of the brightest bake value exceeds the declared 6.5 % absolute rule (applies to every cell, dark ones included)`);
if (pctile(relLit, 0.95) > 5) throw new Error(`SH representation error p95 ${pctile(relLit, 0.95).toFixed(2)} % relative exceeds the declared 5 % relative rule on cells where light arrives`);
if (errors.some((e) => !e.own)) throw new Error('a moving object had to read a far cell instead of its own');
const airRepRel = errors.filter((e) => e.lit).map((e) => e.relRep);
const airRepAbs = errors.filter((e) => e.lit).map((e) => e.absRep);
const airReadRel = errors.filter((e) => e.lit).map((e) => e.rel);
if (Math.max(...airRepAbs) > 6.5) throw new Error(`moving-object representation error ${Math.max(...airRepAbs).toFixed(2)} % of the brightest bake value exceeds the 6.5 % absolute rule`);
if (pctile(airRepRel, 0.95) > 5) throw new Error(`moving-object representation error p95 ${pctile(airRepRel, 0.95).toFixed(2)} % relative exceeds the 5 % relative rule`);
if (Math.max(...airReadRel) > 15) throw new Error(`worst whole reading (representation + noise) ${Math.max(...airReadRel).toFixed(2)} % relative exceeds the declared 15 % line`);
if (marked.length === 0) throw new Error('the dirty flag marked nothing for the lamp change');
if (marked.length !== fullChanged) throw new Error(`dirty flag marked ${marked.length}, the change actually affects ${fullChanged} cells`);
if (marked.length >= grid.cells.length) throw new Error('dirty flag marked the whole grid instead of the affected cells');
if (lostCells > 0) throw new Error(`GPU mirror lost ${lostCells} checked cells — the shader would read a neighbour or nothing`);
if (maxChain > PROBE_LIMIT) throw new Error(`GPU mirror probe chain ${maxChain} exceeds the declared limit of ${PROBE_LIMIT}`);
if (evalErrMax > 1e-6) throw new Error(`GPU mirror evaluation differs from the reference by ${evalErrMax.toExponential(1)}, above the declared f32 rounding tolerance 1e-6`);
if (weightSumErr > 1e-9) throw new Error(`trilinear blend weights sum to ${1 + weightSumErr}, not 1`);
if (outsideRange > 0) throw new Error(`trilinear blend produced ${outsideRange} values outside the range of the corners it blended`);
if (missedReading > 0) throw new Error(`gated blend left ${missedReading} points with no visible corner — the own cell should always count`);
if (cpuGpuAgree > 1e-6) throw new Error(`CPU reading path and GPU mirror differ by ${cpuGpuAgree.toExponential(1)}, above the f32 rounding tolerance 1e-6`);
if (vis.blocked === 0) throw new Error('neighbour visibility never blocked a corner — the through-wall rule is not exercised by this scene');
if (maskAllowsBlocked > 0) throw new Error(`load-time mask allowed ${maskAllowsBlocked} corners the point cannot see — that is light through a wall`);
if (!byteLenOk) throw new Error(`lightgrid file is ${tool.bytes.length} bytes, the reference packer writes ${baseBytes.length}`);
if (byteDiff > 0) throw new Error(`the tool wrote ${byteDiff} bytes that differ from the reference packer — the file would not be the thing that was measured`);
if (metaDiff.length) throw new Error(`lightgrid header lost the numbers that built it: ${metaDiff.join(', ')}`);
if (decodeDiff > 0) throw new Error(`half decode differs on ${decodeDiff} texels — the tool and the reference would disagree about a stored value`);
if (tool.grid.raysPerCell !== opts.raysPerCell || tool.grid.seed !== opts.seed) {
  throw new Error(`the tool built with ${tool.grid.raysPerCell} rays and seed ${tool.grid.seed}, the check declared ${opts.raysPerCell} and ${opts.seed}`);
}
if (slotDiff > 0) throw new Error(`reading the file back lost ${slotDiff} of the checked cells`);
if (slotValueDiff > 0) throw new Error(`reading the file back changed ${slotValueDiff} slot values — a byte-identical file cannot do that`);
if (viewDiff > 0) throw new Error(`decoding through a buffer view differs on ${viewDiff} entries — the decode must copy, not point at the caller's buffer`);
if (blockStart < 0 || !bitExpr) throw new Error('no light-cell read path in src/render/rt.ts for the check to mirror');
if (foreign.length) throw new Error(`the shader uses ${foreign.length} numbers the reference module does not have: ${foreign.join(', ')}`);
if (hashDiff) throw new Error(`the shader's hash lands on a different slot than the packer on ${hashDiff} of 500 keys — the picture would read the wrong cell`);
if (bitDiff) throw new Error(`the shader's neighbour bit differs from neighbourBit() on ${bitDiff} of 27 offsets`);
if (stride !== SH_GRID_STRIDE_VEC4 * 4 || header !== 4 || termStride !== 4) throw new Error(`the shader's slot layout (${stride} floats, header ${header}, term ${termStride}) is not the packer's (${SH_GRID_STRIDE_VEC4 * 4}, 4, 4)`);
if (channels.join(',') !== '0,1,2') throw new Error(`the shader reads channels ${channels.join(', ')} — the packer writes coefficients channel-major`);
if (probeLimit !== PROBE_LIMIT) throw new Error(`the shader's probe limit ${probeLimit} is not the declared ${PROBE_LIMIT}`);
if (ternary) throw new Error(`the grid block contains ${ternary} ternary operator(s) — this Tint build rejects '?'`);
if (!usesModuleBlend) throw new Error('the shader hardcodes a blend strength instead of taking DEFAULT_BLEND from the module, so a change there would not change the picture');
if (!gatesFromMask) throw new Error('the shader does not read the neighbour mask — a pixel would cast a ray per corner or ignore visibility');
if (!readsGate) throw new Error('the dynamic-pixel branch does not use the cell reading, or does not apply the no-double-lighting rule there');
if (mirrorMax > 1e-6) throw new Error(`the shader's evaluation path differs from the reference by ${mirrorMax.toExponential(1)}, above the f32 rounding tolerance 1e-6`);

console.log('PASS light-grid CPU reference (cell size from geometry, density warning, SH truncation, air cells, dirty flag, GPU mirror, file path, WGSL mirror)');
