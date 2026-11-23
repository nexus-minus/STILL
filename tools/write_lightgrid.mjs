#!/usr/bin/env node
/**
 * Writes the light-cell grid file the game loads (assets/map/lightgrid.bin).
 *
 * WHY the game does not build the grid at load — measured, not estimated: filling the
 * reference scene's 11.701 cells at 512 rays per cell (6 million rays) takes 18.9 s in
 * single-threaded JS, and the neighbour-visibility pass another 144 ms. That is a load
 * screen on a gaming machine and several times worse on a simple laptop. So the rays are
 * cast ONCE here, next to the bake (which already takes about a minute), and the game only
 * reads the file: 5.2 MB for the reference scene, a few milliseconds.
 *
 * Run: node --experimental-strip-types tools/write_lightgrid.mjs [dir]
 * Reads <dir>/gridsource.json + <dir>/lightmap.bin, writes <dir>/lightgrid.bin.
 *
 * gridsource.json is written by tools/bake_map.py, because only Blender knows the island
 * layout. It carries NO maths, only the inputs:
 *   {
 *     "resolution": 1024,
 *     "seed": 12345, "raysPerCell": 512,   // recorded so a rebuild gives the SAME numbers
 *     "scale": 3.14159,                    // the loader's bake scale (radiance x pi)
 *     "triangles": [ { "verts": [x0,y0,z0, x1,y1,z1, x2,y2,z2],
 *                      "uv": [u0,v0, u1,v1, u2,v2], "island": "wallA" } ]
 *   }
 * The projection lives in src/world/light-grid.ts — the same module the reference check
 * (scripts/light-grid-check.mjs) uses. If the tool had its own copy in Python, the file
 * could drift away from the numbers that were actually measured.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLightGrid, buildNeighbourVisibility, packLightGrid, encodeLightGrid, decodeHalfTexels, decodeLightGrid, DEFAULTS, GRID_SCALE,
} from '../src/world/light-grid.ts';

/** Pure core: inputs in, file bytes out. No filesystem, so the check can call this exact
 *  function and compare the bytes against the grid it measured. Missing fields fall back to
 *  the module's defaults — a plain spread of `{ seed: undefined }` would overwrite the
 *  default with undefined, which is what the first CLI run caught. */
export function buildGridFile(scene, values) {
  const opts = { seed: scene.seed ?? DEFAULTS.seed, raysPerCell: scene.raysPerCell ?? DEFAULTS.raysPerCell };
  const grid = buildLightGrid(scene.tris, values, scene.resolution, opts);
  buildNeighbourVisibility(grid);
  return { grid, bytes: encodeLightGrid(packLightGrid(grid)) };
}

/** What the manifest records about the grid. Built from the DECODED header, not from the
 *  grid object, so the info block cannot disagree with the file it describes — the f32 blend
 *  and the f64 cell size are what the game actually reads back. */
export function lightgridManifest(decoded) {
  return {
    file: 'lightgrid.bin',
    cells: decoded.cellCount,
    // no rounding: JSON writes the number exactly as the header stored it, so the info block
    // is the same value the game reads from the file (tolerance 0 differences)
    cellSize: decoded.cellSize,
    resolution: decoded.resolution,
    seed: decoded.seed,
    raysPerCell: decoded.raysPerCell,
    blend: decoded.blend,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || 'assets/map';
  const scene = JSON.parse(fs.readFileSync(path.join(dir, 'gridsource.json'), 'utf8'));
  if (!Array.isArray(scene.tris) || !scene.resolution) throw new Error('gridsource.json needs resolution and tris');
  const scale = scene.scale ?? GRID_SCALE;
  const values = decodeHalfTexels(fs.readFileSync(path.join(dir, 'lightmap.bin')), scene.resolution, scale);
  const { grid, bytes } = buildGridFile(scene, values);
  fs.writeFileSync(path.join(dir, 'lightgrid.bin'), bytes);
  const surface = grid.cells.filter((c) => c.kind === 'surface').length;
  console.log(
    `lightgrid.bin: ${grid.cells.length} cells (${surface} surface + ${grid.cells.length - surface} space), ` +
    `cell ${grid.cellSize.toFixed(3)} m, ${bytes.length} bytes, ` +
    `seed ${grid.seed}, ${grid.raysPerCell} rays per cell, scale ${scale.toFixed(5)}`
  );
  // The manifest block is written HERE, from the numbers actually used, because the tool is
  // the only place that knows them (the defaults live in the module). Indent 2 matches
  // export_map.py/bake_map.py so the diff stays only the new block. The loader reads file +
  // the recorded numbers; a map without this block simply has no grid and keeps the bounce ray.
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.lightgrid = lightgridManifest(decodeLightGrid(bytes));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`manifest.json += lightgrid (${manifest.lightgrid.cells} cells, ` +
      `cell ${manifest.lightgrid.cellSize}, seed ${manifest.lightgrid.seed}, ${manifest.lightgrid.raysPerCell} rays)`);
  } else {
    console.log(`no manifest.json in ${dir} — the grid file is written, but the game will not look for it`);
  }
}
