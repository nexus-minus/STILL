#!/usr/bin/env node
/** CPU reference: two open areas joined by a corridor, one changing lamp, one moving actor. */
import {
  buildSparseSHGrid, chooseCellSize, evaluateSHOrder2, projectSHOrder2,
  sampleSparseSHGrid, updateSHGridRegion,
} from '../src/world/sh-grid.mjs';

const dirs = [];
for (let i = 0; i < 64; i++) {
  const y = 1 - 2 * (i + 0.5) / 64;
  const r = Math.sqrt(1 - y * y);
  const a = i * Math.PI * (3 - Math.sqrt(5));
  dirs.push([Math.cos(a) * r, y, Math.sin(a) * r]);
}
const environment = (lamp) => projectSHOrder2(dirs.map((direction) => {
  const toward = Math.max(0, direction[0]);
  return { direction, rgb: [0.08 + lamp * toward, 0.04 + lamp * toward * 0.5, 0.02 + lamp * toward * 0.2] };
}));

// Polygon centers represent surface samples in the two spaces and connecting hall.
const surfaces = [
  { name: 'west-room-wall', position: [-3, 1, 0] },
  { name: 'corridor-wall', position: [0, 1, 0] },
  { name: 'east-room-wall', position: [3, 1, 0] },
];
const baseCoeff = environment(0.6);
const samples = surfaces.map((surface) => ({ ...surface, coefficients: baseCoeff }));
const size = chooseCellSize([-4, 0, -2], [4, 3, 2], samples.length, 64);
const grid = buildSparseSHGrid(samples, size, [-4, 0, -2]);
const movingSpherePosition = [-3, 1, 0];
const wallReference = evaluateSHOrder2(baseCoeff, [0, 1, 0]);
const sphere = sampleSparseSHGrid(grid, movingSpherePosition, [0, 1, 0]);
if (!sphere) throw new Error('moving sphere missed its populated cell');
const maxError = Math.max(...sphere.map((v, i) => Math.abs(v - wallReference[i])));
console.log(`auto cell size: ${size.toFixed(3)} m; occupied cells: ${grid.cells.size}`);
console.log(`moving sphere vs adjacent wall max RGB error: ${maxError.toFixed(6)} (tolerance 1e-5)`);
if (maxError > 1e-5) throw new Error('sphere and wall do not share the same cell lighting');

const changed = updateSHGridRegion(grid, [-4, 0, -2], [-2, 2, 2], [
  { name: 'west-room-wall', position: [-3, 1, 0], coefficients: environment(1.2) },
]);
const westAfter = sampleSparseSHGrid(grid, movingSpherePosition, [0, 1, 0]);
const eastAfter = sampleSparseSHGrid(grid, [3, 1, 0], [0, 1, 0]);
const eastKey = `${Math.floor((3 + 4) / size)},${Math.floor(1 / size)},${Math.floor(2 / size)}`;
const eastCell = grid.cells.get(eastKey);
console.log(`marked state: affected ${changed.affectedCells} cell(s), occupied ${changed.cellsBefore} → ${changed.cellsAfter}`);
console.log(`west RGB change: ${(westAfter[0] - sphere[0]).toFixed(6)}; east cell RGB change: ${(eastAfter[0] - sphere[0]).toFixed(6)}`);
if (changed.affectedCells !== 1 || Math.abs(eastAfter[0] - sphere[0]) > 1e-5) {
  throw new Error('marked state updated cells outside its affected spatial region');
}
if (grid.cells.get(eastKey) !== eastCell) throw new Error('unaffected cell was rebuilt');
console.log('PASS SH grid CPU reference');
