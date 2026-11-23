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
 *                      "uv": [u0,v0, u1,v1, u2,v2], "island": "wallA", "mesh": "wallA", "materialIndex": 0 } ]
 *   }
 * materialIndex is the slot the face uses in edit mode (glTF poly.material_index) and mesh is the
 * object it belongs to, both written per TRIANGLE, not per object: one mesh can carry two slots — a
 * plain wall plus a glowing patch on the same node — and the self-light rule excludes the surface the
 * point stands on, which is mesh AND slot, so the island name alone cannot decide that rule.
 *
 * A triangle that carries no field STOPS the run (exit 1, nothing written). Reason: a value that is
 * not in the file has to be assumed, and a file that depends on an assumption is not reproducible —
 * the same file can give different cells under a different assumption, and a rebuild that disagrees
 * with the file in the repo is exactly what this tool is supposed to prevent. The defaults (0, '')
 * stay in src/world/light-grid.ts only where they are DEFINED: a mesh that genuinely has one slot.
 * bake_map.py writes both fields for every triangle, so the guard should never fire on a file the
 * pipeline produced — if it fires, the file came from somewhere else.
 * The projection lives in src/world/light-grid.ts — the same module the reference check
 * (scripts/light-grid-check.mjs) uses. If the tool had its own copy in Python, the file
 * could drift away from the numbers that were actually measured.
 *
 * The tool also writes manifest.lightgrid.reference: the per-cell values it produced, with the cell
 * size and the cell count. A cross-bake float is not reproducible (the UV packing changes run to
 * run), so the numbers a check compares have to belong to the bake that produced the file. Owner
 * decision 2026-11-23: the reference lives in the manifest, not in the check, so the check compares
 * against the bake it reads and reports a second bake as drift, not as a pass or a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLightGrid, buildNeighbourVisibility, packLightGrid, encodeLightGrid, decodeHalfTexels, decodeLightGrid, DEFAULTS, GRID_SCALE, shIrradiance, ownSurface,
} from '../src/world/light-grid.ts';

/** Pure core: inputs in, file bytes out. No filesystem, so the check can call this exact
 *  function and compare the bytes against the grid it measured. Missing fields fall back to the
 *  defaults that are DEFINED in the module — a plain spread of `{ seed: undefined }` would overwrite
 *  the default with undefined, which is what the first CLI run caught — but the CLI does not write a
 *  file whose triangle values had to be guessed (see missingFields and the ABORT in the run block). */
export function buildGridFile(scene, values) {
  const opts = { seed: scene.seed ?? DEFAULTS.seed, raysPerCell: scene.raysPerCell ?? DEFAULTS.raysPerCell };
  const grid = buildLightGrid(scene.tris, values, scene.resolution, opts);
  buildNeighbourVisibility(grid);
  return { grid, bytes: encodeLightGrid(packLightGrid(grid)) };
}

/** Triangles whose values are not in the file, as { index, name, fields }. Exported so the check can
 *  assert the exact list, not just that some message appeared: the count is checked at tolerance 0. */
export function missingFields(tris) {
  return tris.map((t, i) => {
    const fields = ['materialIndex', 'mesh'].filter((f) => t[f] === undefined);
    return fields.length ? { index: i, name: t.mesh ?? t.island ?? 'unknown', fields } : null;
  }).filter(Boolean);
}

/** The cell values the check compares, written down with the numbers they belong to.
 *  A cross-bake float is not reproducible: the UV packing changes from run to run, so the same rule
 *  on a fresh bake lands in different cells. Owner decision 2026-11-23: the reference lives in
 *  manifest.json, per cell (key + value) plus the cell size and the cell count, so a comparison is
 *  always against the bake that produced the file at tolerance 0, and a second bake is reported as
 *  drift instead of as a pass or a failure.
 *  Values are stored as the FILE holds them: the f32 coefficients packLightGrid writes, evaluated
 *  with f64 arithmetic exactly the way the game evaluates them, so tolerance 0 is possible. Only a
 *  surface cell has a direction; an air cell has no normal, so its value depends on the normal the
 *  game happens to evaluate with and the reference stores null for it. */
export function cellReference(grid) {
  const cells = grid.cells.map((c, ci) => {
    const coefs = new Float64Array(27);
    for (let i = 0; i < 27; i++) coefs[i] = Math.fround(grid.sh[ci * 27 + i]);
    const entry = { key: c.key, kind: c.kind, surface: null, normal: null, value: null };
    if (c.own.length > 0) {
      const value = new Float64Array(3);
      shIrradiance(coefs, c.nx, c.ny, c.nz, value);
      entry.surface = ownSurface(grid, ci);
      entry.normal = [c.nx, c.ny, c.nz];
      entry.value = [...value];
    }
    return entry;
  });
  return { cellSize: grid.cellSize, cellCount: cells.length, cells };
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
  // Every triangle must carry the values the run needs. If one does not, its value can only be
  // assumed, and a file that depends on an assumption is not reproducible — so the run stops here,
  // BEFORE anything is written, and reports the triangles exactly (name + index). bake_map.py writes
  // both fields for every triangle, including a single-slot mesh where 0 would be the default, so a
  // file from the pipeline has nothing to assume.
  const missing = missingFields(scene.tris);
  if (missing.length) {
    console.error(
      `lightgrid.bin ABORT: ${missing.length} of ${scene.tris.length} triangle(s) carry no ` +
      `materialIndex/mesh, so their values would have to be guessed and the file is not ` +
      `reproducible. Nothing was written.`);
    for (const m of missing) console.error(`  ${m.name} #${m.index}: missing ${m.fields.join(' + ')}`);
    process.exit(1);
  }
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
    // the reference comes from the same grid the bytes were built from, so it describes THIS bake
    manifest.lightgrid.reference = cellReference(grid);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`manifest.json += lightgrid (${manifest.lightgrid.cells} cells, ` +
      `cell ${manifest.lightgrid.cellSize}, seed ${manifest.lightgrid.seed}, ${manifest.lightgrid.raysPerCell} rays), ` +
      `reference: ${manifest.lightgrid.reference.cells.length} cell values`);
  } else {
    console.log(`no manifest.json in ${dir} — the grid file is written, but the game will not look for it`);
  }
}
