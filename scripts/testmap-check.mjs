#!/usr/bin/env node
/**
 * Headless check for the test map (assets/testmap), written by tools/build_testmap.sh.
 *
 *   node --experimental-strip-types scripts/testmap-check.mjs
 *
 * Everything is measured from the files the REAL pipeline wrote (tools/export_map.py,
 * tools/bake_map.py, tools/write_lightgrid.mjs) with the functions the game uses
 * (src/world/light-grid.ts) and the teleport hook (src/world/teleport.ts). The check
 * does not re-implement the export: it reads what is on disk.
 *
 * Coordinate space: gridsource.json stores Blender positions (Z up), so the grid the tool
 * built lives in that space. The game's player lives in glTF space (Y up): game x =
 * blender x, game y = blender z, game z = -blender y. The check converts the teleported
 * point through that mapping and proves the mapping by asserting which island owns the
 * cell it lands in.
 *
 * Tolerances, declared before any number:
 *   0        structure and integers: names, counts, the material slot of a face, the
 *            emissive strength, and the byte-for-byte comparison of the rebuilt grid
 *            against the file the game loads.
 *   1e-3 m   lengths measured from Draco-decoded accessor bounds (--weld merges vertices,
 *            Draco quantizes positions).
 *   0.1 deg  angles measured from those bounds.
 *   1 ulp    a value the pipeline stores as float32 (the representation limit).
 *   9 ulp    an f32 cell value against the f64 grid the tool built.
 *   40 ulp   the f32 blend over the 8 corners against the f64 reference.
 *   18 ulp   the blend weight sum against 1.0.
 *   1e-9     floor: below this an accumulated value is exactly zero.
 *
 * A tolerance is never weakened when a number misses it: the check prints the numbers and
 * the options instead.
 *
 * The stored reference (owner decision 2026-11-23): manifest.json holds the cell values the pipeline
 * produced for THIS bake — key + value + cell size + cell count, written by tools/write_lightgrid.mjs.
 * Floats are compared against that reference at tolerance 0, because a cross-bake float is not
 * reproducible: the UV packing changes from run to run, so the same rule lands in different cells.
 * The difference between two bakes is reported as its own DRIFT line, which is neither a pass nor a
 * failure. A second bake is given with --second-bake=<dir>; without it the check says so.
 *
 * The self-light rule is checked as the owner decided it (2026-11-23): a point never counts its own
 * face, but two different SURFACES inside the same cell may light each other, and a surface is a mesh
 * AND a slot (owner confirmed). gridsource.json carries both per triangle — `materialIndex` (written
 * by tools/bake_map.py from poly.material_index) and `mesh` (the object name) — so the rule can be
 * honoured inside one cell. src/world/light-grid.ts implements it as `ownSurface` (the (mesh, slot)
 * pair with the largest area in the cell; equal area -> the smaller slot index, equal area AND equal
 * slot -> the alphabetically smaller mesh name, so the import order cannot decide) and `skipSetFor`
 * (skip the faces of that pair). `fillCell` takes the position AND the normal from that surface. The
 * check measures the rule through those functions and prints the numbers whenever a value misses a
 * declared tolerance — a tolerance is never weakened.
 *
 * Material fields (2026-11-23): all five values are written for every material, because a field that
 * is not in the file cannot be compared at tolerance 0. The rule lives in tools/glb_fields.py and both
 * tools/export_map.py and tools/bake_map.py call it, because bake_map.py re-exports objects.glb after
 * the bake: the rule has to hold on the file that actually ships, not on the file an earlier step wrote.
 *
 * Guard, decided 2026-11-23: a triangle with no field must STOP the run (exit != 0), because a file
 * whose values depend on an assumed default is not reproducible. Section 12 proves the guard with a
 * copy of gridsource.json, tolerance 0 on the count and on the reported names + indices.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULTS,
  GRID_SCALE,
  buildLightGrid,
  buildNeighbourVisibility,
  packLightGrid,
  encodeLightGrid,
  decodeLightGrid,
  decodeHalfTexels,
  triangleMetrics,
  lightmapAt,
  projectCoefficients,
  cellIndexAt,
  ownSurface,
  skipSetFor,
  sampleIrradiance,
  shIrradiance,
  packedBlend,
  packedBlendIrradiance,
  lastSampleDistance,
  lastSampleOwn,
} from '../src/world/light-grid.ts';
import { teleportPlayer, registerTeleportHook } from '../src/world/teleport.ts';
// The guard is imported, not re-implemented: the check must assert the same code path the tool runs.
import { missingFields } from '../tools/write_lightgrid.mjs';

const MAP = 'assets/testmap';
const CAPSULE = { height: 1.7, radius: 0.35 };
// a second bake of the same .blend is a different pack, so it is reported as drift, not as a pass or
// a failure. The check does not run Blender; it reads a directory: --second-bake=<dir>
const SECOND = (process.argv.slice(2).find((a) => a.startsWith('--second-bake=')) ?? '').split('=')[1] || null;

const failures = [];
const findings = [];
const drifts = [];
function ok(name, condition, detail = '') {
  if (condition) console.log(`  \u2713 ${name}${detail ? ' \u2014 ' + detail : ''}`);
  else {
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`);
  }
}
function measure(label, value) {
  console.log(`  \u25b8 ${label}: ${value}`);
  return value;
}
function finding(text) {
  findings.push(text);
  console.log(`  \u2295 FINDING: ${text}`);
}
// Drift is neither a pass nor a failure: it is the run-to-run packing difference, printed as its own
// line so nobody reads it as a tolerated value.
function drift(text) {
  drifts.push(text);
  console.log(`  \u2299 DRIFT: ${text}`);
}

const f32 = (v) => Math.fround(v);
const ulpOf = (v) => (Math.abs(Math.fround(v)) === 0 ? 0 : Math.abs(Math.fround(v)) * 6e-7);
function ulpEq(a, b, maxUlps) {
  if (a === b) return true;
  const scale = Math.max(ulpOf(a), ulpOf(b));
  return scale > 0 && Math.abs(a - b) <= maxUlps * scale + 1e-12;
}

/** the glTF JSON chunk of a .glb, the same way scripts/bake-glb-uv.mjs reads it */
function glbJson(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 4).toString() !== 'glTF') throw new Error(`${file} is not a glb`);
  return JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}

function main() {
  console.log('\n=== testmap check ===');
  const manifest = JSON.parse(fs.readFileSync(`${MAP}/manifest.json`, 'utf8'));
  const source = JSON.parse(fs.readFileSync(`${MAP}/gridsource.json`, 'utf8'));
  const tris = source.tris;
  const resolution = source.resolution;
  const values = decodeHalfTexels(fs.readFileSync(`${MAP}/lightmap.bin`), resolution, GRID_SCALE);

  console.log('\n1. the grid measured here is the grid the game loads');
  ok('the check reads the test map only', MAP.endsWith('testmap'));
  const grid = buildLightGrid(tris, values, resolution, {});
  buildNeighbourVisibility(grid);
  const fileBytes = fs.readFileSync(`${MAP}/lightgrid.bin`);
  ok('rebuilding from gridsource.json + lightmap.bin gives the file bytes exactly (tolerance 0)',
    Buffer.from(encodeLightGrid(packLightGrid(grid))).equals(Buffer.from(fileBytes)));
  const packed = decodeLightGrid(fileBytes);
  // a packed slot is a hashed table index, not a cell index: the file stores ix,iy,iz per slot
  const SLOT_STRIDE = 40; // SH_GRID_STRIDE_VEC4 * 4 float32 entries per slot
  const cellOfSlot = (slot) =>
    grid.cellOfKey.get(`${packed.data[slot * SLOT_STRIDE]},${packed.data[slot * SLOT_STRIDE + 1]},${packed.data[slot * SLOT_STRIDE + 2]}`);
  ok('the file header matches the rebuilt grid (tolerance 0)',
    packed.cellCount === grid.cells.length && packed.seed === grid.seed &&
    packed.raysPerCell === grid.raysPerCell && packed.resolution === grid.resolution);

  let texelArea = 0, metreArea = 0;
  for (const t of tris) {
    const m = triangleMetrics(t, resolution);
    if (!m) continue;
    texelArea += m.areaTexel;
    metreArea += m.areaM2;
  }
  const density = texelArea / metreArea;
  const ideal = Math.sqrt(DEFAULTS.texelsPerCell / density);
  const clamped = Math.min(DEFAULTS.maxCellSize, Math.max(DEFAULTS.minCellSize, ideal));
  measure('measured bake density', `${density.toFixed(1)} texels/m2 = ${Math.sqrt(density).toFixed(1)} texels/m linear`);
  measure('cell size from that density', `ideal ${ideal.toFixed(3)} m, clamp [${DEFAULTS.minCellSize}, ${DEFAULTS.maxCellSize}] -> ${clamped.toFixed(3)} m; grid uses ${grid.cellSize.toFixed(3)} m`);
  ok('the cell size is the clamped ideal value (tolerance 0)', grid.cellSize === clamped);
  ok('the density warning path fires for this map', Math.sqrt(density) < DEFAULTS.minDensity,
    `${Math.sqrt(density).toFixed(1)} texels/m is below the warn limit ${DEFAULTS.minDensity}`);
  ok('every recorded triangle has 9 vertex values and 6 uv values (tolerance 0)',
    tris.every((t) => t.verts.length === 9 && t.uv.length === 6), `${tris.length} triangles, ${grid.cells.length} cells`);
  // tools/bake_map.py writes both fields per triangle; the reader must not guess either. Asserted
  // through the tool's own guard function, so the check and the tool cannot disagree.
  const missing = missingFields(tris);
  ok('every triangle carries materialIndex AND mesh in gridsource.json (tolerance 0)', missing.length === 0,
    missing.length ? `${missing.length} missing, e.g. ${missing[0].name} #${missing[0].index}` :
    `${tris.length} triangles, slots ${[...new Set(tris.map((t) => t.materialIndex))].sort((a, b) => a - b).join('/')}, ` +
    `${new Set(tris.map((t) => t.mesh)).size} mesh name(s)`);

  // Island number: tools/bake_map.py line 927 writes `island = obj.name`, so ONE object is
  // ONE island whatever material slots its faces use. The island number here is the order of
  // first appearance in gridsource.json.
  const islandOrder = [];
  const islandOf = {};
  tris.forEach((t, i) => {
    if (!(t.island in islandOf)) { islandOf[t.island] = islandOrder.length; islandOrder.push(t.island); }
  });
  const glb = glbJson(`${MAP}/objects.glb`);
  const materialOf = (i) => glb.materials[i];
  // what the file writes per field, now that tools/export_map.py writes all five for every material
  const fieldOf = (mat, field) => field === 'emissiveStrength'
    ? ((mat.extensions || {})?.KHR_materials_emissive_strength || {}).emissiveStrength
    : field === 'emissiveFactor' ? mat.emissiveFactor
    : (mat.pbrMetallicRoughness || {})[field];
  const emission = (mat) => (mat.emissiveFactor ?? [0, 0, 0]).map((v) => v * (fieldOf(mat, 'emissiveStrength') ?? 1));
  const meshOf = (name) => glb.meshes.find((m) => m.name === name);
  const boundsOf = (name) => {
    const m = meshOf(name);
    if (!m) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of m.primitives) {
      const a = glb.accessors[p.attributes.POSITION];
      if (!a?.min) continue;
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a.min[k]); hi[k] = Math.max(hi[k], a.max[k]); }
    }
    return { lo, hi, slots: [...new Set(m.primitives.map((p) => p.material))], primitives: m.primitives.length };
  };
  // glTF Y-up back to the Blender space the grid lives in
  const bb = (b) => (b ? { x: b.lo[0], y: -b.hi[2], z: b.lo[1], dx: b.hi[0] - b.lo[0], dy: b.hi[2] - b.lo[2], dz: b.hi[1] - b.lo[1] } : null);
  const centroid = (t) => [0, 1, 2].map((k) => (t.verts[k] + t.verts[k + 3] + t.verts[k + 6]) / 3);
  const cellOfTri = (t) => {
    const c = centroid(t);
    return grid.cellOfKey.get(`${Math.floor(c[0] / grid.cellSize)},${Math.floor(c[1] / grid.cellSize)},${Math.floor(c[2] / grid.cellSize)}`);
  };
  const bakedAt = (i) => {
    const m = triangleMetrics(tris[i], resolution);
    const v = new Float64Array(3);
    lightmapAt(values, resolution, m.uvu, m.uvv, v);
    return [...v];
  };

  console.log('\n2. (a) nested sub-collections');
  ok('the nested sub-collection is not listed as skipped (tolerance 0)', !manifest.skipped.includes('props_nested'),
    `manifest.skipped = ${JSON.stringify(manifest.skipped)}`);
  ok('the manifest states where the name belongs (tolerance 0)', manifest.subCollections?.props_nested === 'objects',
    `manifest.subCollections = ${JSON.stringify(manifest.subCollections)}`);
  for (const n of ['Nested_cube', 'L_nested_fixture']) {
    ok(`"${n}" from the nested sub-collection is exported`, meshOf(n) !== undefined,
      `in objects.glb, island #${islandOf[n] ?? '-'}`);
    ok(`its island is in the grid`, n in islandOf);
  }
  finding('(a) answered: objects inside a nested sub-collection ARE processed — tools/export_map.py uses ' +
    '`coll.all_objects` (recursive) and top_level_collections() resolves each object to its top-level ancestor, ' +
    'so Nested_cube (island #' + islandOf['Nested_cube'] + ') and L_nested_fixture (island #' + islandOf['L_nested_fixture'] +
    ') land in objects.glb and in the grid. The name alone cannot decide anything, so the warning is now resolved ' +
    'to the top-level ancestor before it fires (tools/export_map.py, top_map()). Measured before the fix: ' +
    'skipped = ["props_nested"] plus "WARNING unknown top-level collection props_nested" while both objects were ' +
    'exported. Measured after the fix: skipped = [], the run prints "export_map: collection \'props_nested\' is a ' +
    'sub-collection of \'objects\' (its objects export through that top-level collection)" and writes ' +
    'manifest.subCollections = {"props_nested":"objects"}. A name whose ancestor is genuinely unknown still warns — ' +
    'on the ancestor, once.');

  console.log('\n3. (b) mesh with two material slots');
  const multi = glb.meshes.filter((m) => new Set(m.primitives.map((p) => p.material)).size > 1);
  ok('objects.glb contains exactly ONE mesh with 2 material slots', multi.length === 1,
    multi.map((m) => m.name).join(', ') || 'none');
  const panel = multi[0];
  ok('that mesh is ONE mesh node, not split (tolerance 0)', panel?.name === 'TwoSlot_panel');
  ok('it has 2 primitives, one per slot (tolerance 0)', panel?.primitives.length === 2);
  const slotA = panel.primitives[0].material, slotB = panel.primitives[1].material;
  measure('its two slots', `${materialOf(slotA).name} (plain) + ${materialOf(slotB).name} (glow)`);
  ok('slot 0 has no emission, and the field is in the file (tolerance 0): the written value x the written strength is 0',
    fieldOf(materialOf(slotA), 'emissiveFactor') !== undefined && fieldOf(materialOf(slotA), 'emissiveStrength') !== undefined &&
      emission(materialOf(slotA)).every((v) => v === 0),
    `file writes emissiveFactor ${JSON.stringify(materialOf(slotA).emissiveFactor)} x strength ` +
    `${fieldOf(materialOf(slotA), 'emissiveStrength')} = ${JSON.stringify(emission(materialOf(slotA)))}`);
  ok('slot 1 is the glow, strength exactly 5 (tolerance 0)',
    materialOf(slotB).extensions?.KHR_materials_emissive_strength?.emissiveStrength === 5,
    `measured ${materialOf(slotB).extensions?.KHR_materials_emissive_strength?.emissiveStrength}`);
  // which faces belong to which slot: measured from each primitive's accessor bounds
  const primBounds = panel.primitives.map((p, idx) => {
    const a = glb.accessors[p.attributes.POSITION];
    return { slotIndex: idx, material: p.material, verts: a.count, min: a.min, max: a.max };
  });
  for (const p of primBounds) ok(`primitive ${p.slotIndex} carries ${p.verts} vertices = 1 quad`, p.verts === 4);
  const panelTris = tris.map((_, i) => i).filter((i) => tris[i].island === 'TwoSlot_panel');
  const slotOfTri = {};
  for (const i of panelTris) {
    const cx = centroid(tris[i])[0];
    const p = primBounds.find((b) => cx >= b.min[0] - 1e-3 && cx <= b.max[0] + 1e-3);
    slotOfTri[i] = p ? p.slotIndex : -1;
  }
  const perSlot = {};
  for (const i of panelTris) perSlot[slotOfTri[i]] = (perSlot[slotOfTri[i]] || 0) + 1;
  measure('faces per slot (triangle centroid inside the primitive bounds, tolerance 1e-3 m)',
    Object.entries(perSlot).map(([s, n]) => `slot ${s} ${materialOf(panel.primitives[+s].material).name} = ${n} triangles`).join(', '));
  ok('the faces are assigned to the right slots (tolerance 0)',
    Object.keys(perSlot).length === 2 && Object.values(perSlot).every((n) => n === 2));
  ok('gridsource.json names the same slot per triangle as the glb primitive does (tolerance 0)',
    panelTris.every((i) => tris[i].materialIndex === slotOfTri[i]),
    panelTris.map((i) => `tri#${i} = materialIndex ${tris[i].materialIndex}`).join(', '));
  ok('the comparison wall is a separate mesh with one slot (tolerance 0)',
    meshOf('Plain_wall_ref')?.primitives.length === 1 &&
      emission(materialOf(meshOf('Plain_wall_ref').primitives[0].material)).every((v) => v === 0),
    `Plain_wall_ref -> ${materialOf(meshOf('Plain_wall_ref').primitives[0].material).name}, ` +
    `emission ${JSON.stringify(emission(materialOf(meshOf('Plain_wall_ref').primitives[0].material)))}`);

  const glowTris = panelTris.filter((i) => slotOfTri[i] === 1);
  const plainTris = panelTris.filter((i) => slotOfTri[i] === 0);
  const plainRefTris = tris.map((_, i) => i).filter((i) => tris[i].mesh === 'Plain_wall_ref');
  ok('gridsource.json names the mesh per triangle, and the two slot-0 surfaces are two different meshes (tolerance 0)',
    panelTris.every((i) => tris[i].mesh === 'TwoSlot_panel') && plainRefTris.length === 2 &&
      plainRefTris.every((i) => tris[i].mesh === 'Plain_wall_ref'),
    `${panelTris.map((i) => `tri#${i} mesh ${tris[i].mesh}`).join(', ')} | ` +
    `${plainRefTris.map((i) => `tri#${i} mesh ${tris[i].mesh}`).join(', ')}`);
  measure('baked value on the glow faces', glowTris.map((i) => bakedAt(i).map((c) => c.toFixed(4)).join(',')).join(' | '));
  measure('baked value on the plain faces of the same mesh', plainTris.map((i) => bakedAt(i).map((c) => c.toFixed(4)).join(',')).join(' | '));
  ok('the bake processed BOTH slots (each carries its own texels)',
    glowTris.every((i) => bakedAt(i).some((c) => c > 0)) && plainTris.every((i) => bakedAt(i).some((c) => c > 0)));
  ok('the emissive slot has NO island number of its own (tolerance 0)', islandOf['TwoSlot_panel'] !== undefined,
    `islands stay per object (tools/bake_map.py writes island = obj.name), so the whole mesh is ONE island ` +
    `#${islandOf['TwoSlot_panel']} = "${panel.name}"; what the slot has now is its own materialIndex per triangle (0 and 1)`);

  console.log('\n4. features, measured from the export');
  for (const deg of [15, 30, 45]) {
    const b = bb(boundsOf(`Ramp_${deg}`));
    ok(`Ramp_${deg} is in the export`, b !== null);
    if (!b) continue;
    const run = Math.max(b.dx, b.dy), rise = b.dz;
    const angle = (Math.atan2(rise, run) * 180) / Math.PI;
    measure(`Ramp_${deg}`, `run ${run.toFixed(3)} m, rise ${rise.toFixed(3)} m, angle ${angle.toFixed(3)} deg`);
    ok(`Ramp_${deg} within 0.1 deg`, Math.abs(angle - deg) <= 0.1, `off by ${Math.abs(angle - deg).toFixed(3)} deg`);
    ok(`Ramp_${deg} is walkable (below the 50 deg slope limit)`, angle < 50, `${angle.toFixed(2)} deg`);
  }
  const stairTris = tris.filter((t) => t.island === 'Stairs_12');
  const sb = bb(boundsOf('Stairs_12'));
  ok('one staircase is in the export', sb !== null);
  measure('Stairs_12 measured', `${stairTris.length / 2} quads (12 risers + 12 treads), run ${sb.dx.toFixed(3)} m, rise ${sb.dz.toFixed(3)} m, overall slope ${(Math.atan2(sb.dz, sb.dx) * 180 / Math.PI).toFixed(1)} deg`);
  ok('the staircase has 12 steps = 24 quads = 48 triangles (tolerance 0)', stairTris.length === 48);
  // 12 steps means: 12 vertical risers + 12 horizontal treads, read from the triangle normals
  const stairRisers = stairTris.filter((t) => Math.abs(Math.abs(triangleMetrics(t, resolution).ny) - 1) <= 1e-9).length;
  const stairTreads = stairTris.filter((t) => Math.abs(Math.abs(triangleMetrics(t, resolution).nz) - 1) <= 1e-9).length;
  const stairSigns = Array.from(new Set(stairTris.map((t) => {
    const m = triangleMetrics(t, resolution);
    if (m.ny > 0) return '+Y riser';
    if (m.nz > 0) return '+Z tread';
    return 'flipped winding';
  })));
  ok('12 risers and 12 treads, read from the normals (tolerance 0)', stairRisers === 24 && stairTreads === 24,
    `risers ${stairRisers} triangles, treads ${stairTreads} triangles, step rise ${(sb.dz / 12).toFixed(3)} m, windings ${stairSigns.join(' / ')} (the air-side contract)`);

  const pb = bb(boundsOf('Narrow_floor')), ph = bb(boundsOf('Narrow_ceiling'));
  ok('the narrow passage is in the export', pb !== null && ph !== null);
  const width = Math.min(pb.dx, pb.dy), length = Math.max(pb.dx, pb.dy), height = ph.z - pb.z;
  measure('narrow passage measured', `width ${width.toFixed(3)} m, length ${length.toFixed(3)} m, height ${height.toFixed(3)} m (ceiling z minus floor z)`);
  ok('the passage is 0.6 m wide (tolerance 1e-3 m)', Math.abs(width - 0.6) <= 1e-3);
  ok('the passage is 4 m long (tolerance 1e-3 m)', Math.abs(length - 4) <= 1e-3);
  ok('the 1.7 m capsule fits under it', height >= CAPSULE.height, `${height.toFixed(3)} m >= ${CAPSULE.height} m`);

  const holes = glb.meshes.filter((m) => m.name.startsWith('Wall_hole_'));
  ok('the hole is framed by 4 wall quads (tolerance 0)', holes.length === 4, holes.map((m) => m.name).join(', '));
  // Classification uses the 1e-3 m length tolerance: the bounds come from Draco accessors,
  // so a 0.6 m span reads 0.6000000476, not exactly 0.6.
  const tall = holes.filter((m) => Math.abs(bb(boundsOf(m.name)).dz - 3) <= 1e-3);
  const strips = holes.filter((m) => Math.abs(bb(boundsOf(m.name)).dy - 0.6) <= 1e-3);
  ok('2 quads run the full height, 2 quads are the 0.6 m strips around the opening (tolerance 0)',
    tall.length === 2 && strips.length === 2, `tall: ${tall.map((m) => m.name).join(', ')}; strips: ${strips.map((m) => m.name).join(', ')}`);
  const sortedTall = tall.map((m) => bb(boundsOf(m.name))).sort((a, c) => a.y - c.y);
  const sortedStrips = strips.map((m) => bb(boundsOf(m.name))).sort((a, c) => a.z - c.z);
  const gapY = sortedTall[1].y - (sortedTall[0].y + sortedTall[0].dy);
  const gapZ = sortedStrips[1].z - (sortedStrips[0].z + sortedStrips[0].dz);
  measure('hole measured from the exported bounds', `gap ${gapY.toFixed(3)} m (between the tall quads) x ${gapZ.toFixed(3)} m (between the strips)`);
  ok('the hole is 0.6 x 0.6 m (tolerance 1e-3 m)', Math.abs(gapY - 0.6) <= 1e-3 && Math.abs(gapZ - 0.6) <= 1e-3);
  // the quads all lie in the plane x = 14, so each one's area is its y span x its z span
  const covered = holes.reduce((s, m) => { const b = bb(boundsOf(m.name)); return s + b.dy * b.dz; }, 0);
  ok('the four quads tile the wall MINUS the opening, no overlap (tolerance 1e-3 m2)',
    Math.abs(covered - (8 * 3 - 0.6 * 0.6)) <= 1e-3, `covered ${covered.toFixed(6)} m2 = wall 24 m2 - hole 0.36 m2`);

  for (const room of ['RoomB', 'RoomC']) {
    const parts = glb.meshes.filter((m) => m.name.startsWith(room + '_'));
    const expected = room === 'RoomB' ? 5 : 6; // Room B's 6th side is the wall with the hole
    ok(`closed room ${room} has ${expected} faces of its own`, parts.length === expected, parts.map((m) => m.name).join(', '));
  }
  const emit = boundsOf('L_strip_long');
  ok('the long emitter is in the export', emit !== null);
  const elen = Math.max(bb(emit).dx, bb(emit).dy);
  measure('long emitter measured', `length ${elen.toFixed(3)} m, strength ${materialOf(emit.slots[0]).extensions?.KHR_materials_emissive_strength?.emissiveStrength}`);
  ok('the long emitter is 4.8 m long (tolerance 1e-3 m)', Math.abs(elen - 4.8) <= 1e-3);
  const emitCells = new Set(tris.filter((t) => t.island === 'L_strip_long').map(cellOfTri));
  ok('a long emitter spreads over more than one cell', emitCells.size > 1, `cells ${[...emitCells].join(', ')}`);

  const row = glb.meshes.filter((m) => m.name.startsWith('Mat_row_'));
  ok('the material row has 6 samples (tolerance 0)', row.length === 6, row.map((m) => m.name).join(', '));
  const authoredRow = [
    [[0.20, 0.60, 0.35], 0.10, 0.0], [[0.20, 0.60, 0.35], 0.90, 0.0], [[0.80, 0.25, 0.25], 0.50, 0.0],
    [[0.10, 0.10, 0.10], 0.50, 0.0], [[0.80, 0.80, 0.80], 0.50, 1.0], [[0.80, 0.80, 0.80], 0.10, 1.0],
  ];
  for (let i = 0; i < row.length; i++) {
    const mat = materialOf(row[i].primitives[0].material);
    const p = mat.pbrMetallicRoughness;
    ok(`Mat_row_${String(i + 1).padStart(2, '0')}: Principled output, colour + roughness only, no textures`,
      !!p && !mat.normalTextureInfo && emission(mat).every((v) => v === 0),
      `emissiveFactor is written (${JSON.stringify(mat.emissiveFactor)}) with strength ` +
      `${fieldOf(mat, 'emissiveStrength')} -> emission ${JSON.stringify(emission(mat))}`);
    const f1 = (v) => Math.round(v * 1e6) / 1e6; // f32 storage: 1 ulp of a value near 1
    const colourOk = p.baseColorFactor.slice(0, 3).every((c, k) => Math.abs(c - authoredRow[i][0][k]) <= 1e-6);
    ok(`Mat_row_${String(i + 1).padStart(2, '0')} colour matches the authored value (tolerance 1 ulp)`, colourOk,
      `measured ${p.baseColorFactor.slice(0, 3).map(f1).join(', ')} vs authored ${authoredRow[i][0].join(', ')}`);
    ok(`Mat_row_${String(i + 1).padStart(2, '0')} roughness matches (tolerance 1 ulp)`,
      Math.abs(p.roughnessFactor - authoredRow[i][1]) <= 1e-6, `measured ${f1(p.roughnessFactor)}`);
    const metal = p.metallicFactor;
    ok(`Mat_row_${String(i + 1).padStart(2, '0')} metallicFactor is in the file and reads the authored value (tolerance 0 on presence, 1 ulp on the number)`,
      metal !== undefined && Math.abs(metal - authoredRow[i][2]) <= 1e-6,
      `file writes ${f1(metal)}, authored ${authoredRow[i][2]}`);
  }
  // Rule declared before measuring: the manifest must state what was written. A field that is
  // absent from the file is "glTF default used", never a silently assumed value — and that only
  // holds when the authored value IS the default. tools/export_map.py now compares both sides and
  // writes the answer into manifest.materialDefaults (written / defaultsUsed / notDefault).
  // Defaults verified against the spec, 2026-11-23:
  //   specification/2.0/schema/material.pbrMetallicRoughness.schema.json: baseColorFactor
  //   [1,1,1,1], metallicFactor 1.0, roughnessFactor 1.0; material.schema.json: emissiveFactor
  //   [0,0,0]; KHR_materials_emissive_strength README: emissiveStrength default 1.0.
  // Rule declared before measuring (owner decision 2026-11-23): every field must be IN the file, so a
  // reader never has to assume what an absent field means. tools/export_map.py now writes all five
  // fields for every material, and the manifest still flags a written value that is not the spec
  // default. Both are asserted here at tolerance 0, by recomputing the flag from the file itself.
  const specDefaults = {
    baseColorFactor: [1.0, 1.0, 1.0, 1.0], metallicFactor: 1.0, roughnessFactor: 1.0,
    emissiveFactor: [0.0, 0.0, 0.0], emissiveStrength: 1.0,
  };
  const r6 = (v) => (Array.isArray(v) ? v.map((x) => Math.round(x * 1e6) / 1e6)
    : (v === undefined ? undefined : Math.round(v * 1e6) / 1e6));
  const fileMat = (e) => (glbJson(`${MAP}/${e.file}`)?.materials ?? []).find((m) => m.name === e.material);
  const audit = manifest.materialDefaults ?? [];
  const fileMaterials = (f) => (glbJson(`${MAP}/${f}`)?.materials ?? []);
  // counted from the file, not from what a script printed earlier
  const fieldsInFile = (f) => {
    const mats = fileMaterials(f);
    return {
      mats: mats.length,
      fields: mats.reduce((s, m) => s +
        ['baseColorFactor', 'metallicFactor', 'roughnessFactor']
          .filter((k) => (m.pbrMetallicRoughness || {})[k] !== undefined).length +
        (m.emissiveFactor !== undefined ? 1 : 0) +
        (((m.extensions || {}).KHR_materials_emissive_strength || {}).emissiveStrength !== undefined ? 1 : 0), 0),
    };
  };
  ok('the manifest states what it wrote for every material in every exported file (tolerance 0)',
    audit.length === fileMaterials('objects.glb').length + fileMaterials('animated.glb').length,
    `${audit.length} entries = ${fileMaterials('objects.glb').length} in objects.glb + ` +
    `${fileMaterials('animated.glb').length} in animated.glb`);
  const absent = audit.flatMap((e) => Object.keys(e.written).filter((f) => !e.written[f]));
  ok('no material field is missing from the file (tolerance 0): 5 fields x every material, 0 absent',
    absent.length === 0 && audit.every((e) => Object.keys(e.written).length === 5 && Object.values(e.written).every(Boolean)) &&
      audit.every((e) => Object.keys(e.written).every((f) => fieldOf(fileMat(e), f) !== undefined)),
    `${audit.length} material(s) x 5 fields = ${audit.length * 5} fields, all present in the file. Before this ` +
    `decision the exporter skipped 31 of them (28 emissive pair + metallic/roughness/baseColor defaults), so ` +
    `the rule "no field may be absent" is now 0/31 missing, 31/31 written.`);
  const flagged = audit.flatMap((e) => Object.keys(e.notDefault ?? {}));
  const flagMisses = audit.flatMap((e) => Object.keys(e.notDefault ?? {}).filter((f) =>
    JSON.stringify(r6(fieldOf(fileMat(e), f))) !== JSON.stringify(r6(e.notDefault[f]))));
  const wronglyFlagged = audit.flatMap((e) => Object.keys(e.notDefault ?? {}).filter((f) =>
    JSON.stringify(r6(fieldOf(fileMat(e), f))) === JSON.stringify(r6(specDefaults[f]))));
  ok('every flag matches the value that is in the file, recomputed from the spec defaults (tolerance 0)',
    flagMisses.length === 0 && wronglyFlagged.length === 0 && audit.every((e) => Object.keys(e.defaultsUsed).length === 0),
    `${flagged.length} written value(s) flagged as not the spec default, ${flagMisses.length} flag(s) that do not ` +
    `match the file, ${wronglyFlagged.length} flag(s) of a value that IS the default, ${audit.reduce((s, e) => s + Object.keys(e.defaultsUsed).length, 0)} ` +
    `field(s) recorded as "default used" — 0, because nothing is absent anymore`);
  const flaggedNames = [...new Set(audit.filter((e) => Object.keys(e.notDefault ?? {}).length).map((e) => e.material))];
  // What the flags mean for the picture, measured separately for the two kinds of flag. A flag says: the
  // value that is in the file is not the glTF spec default. Before the decision the field was not in the
  // file at all, so a reader that expects the field took the default instead — for those fields the
  // picture DID change, and writing the authored value is what fixes it. The exception is the emission
  // pair of a material whose strength is 0: 0 x anything = 0, so that pair measures the same on both
  // paths and the picture stays as it was. Counted from the file, not assumed.
  const flagMatchesAuthored = audit.filter((e) => Object.keys(e.notDefault ?? {}).length)
    .every((e) => Object.keys(e.notDefault).every((f) =>
      JSON.stringify(fieldOf(fileMat(e), f)) === JSON.stringify(e.notDefault[f])));
  ok('every flagged field in the file is the value the audit recorded, so the reader does not have to ' +
    'assume the default (tolerance 0)', flagMatchesAuthored,
    `${flagged.length} flagged field(s), all ${flagged.length} read back from the file as recorded`);
  const offMaterials = audit.filter((e) => fieldOf(fileMat(e), 'emissiveStrength') === 0);
  const offZero = offMaterials.every((e) => (fileMat(e).emissiveFactor ?? [0, 0, 0])
    .every((v, k) => v * fieldOf(fileMat(e), 'emissiveStrength') === 0));
  ok('the emission-off materials measure exactly 0 on both paths, so their picture is unchanged ' +
    '(tolerance 0) — authored white x 0 = 0, read through the default black x 1 = 0',
    offZero, `${offMaterials.length} material(s) have strength 0, both sides measure exactly 0`);
  // Emission flags that cannot change the picture (the pair on a strength-0 material) versus the flags
  // that do, measured per material and per field.
  const emissionFlags = audit.flatMap((e) => Object.keys(e.notDefault ?? {}).filter((f) =>
    f === 'emissiveFactor' || f === 'emissiveStrength'));
  const unchangedFlags = audit.filter((e) => fieldOf(fileMat(e), 'emissiveStrength') === 0)
    .flatMap((e) => Object.keys(e.notDefault ?? {}).filter((f) => f === 'emissiveFactor' || f === 'emissiveStrength'));
  const changedFlags = flagged.length - unchangedFlags.length;
  ok('the rest of the flags are the fields the picture changes for: the game now reads the value from the ' +
    'file instead of assuming the glTF default (tolerance 0 on the count)',
    changedFlags === flagged.length - unchangedFlags.length && unchangedFlags.length <= emissionFlags.length,
    `${flagged.length} flagged field(s): ${unchangedFlags.length} still measure 0 (the emission pair of a ` +
    `strength-0 material), ${changedFlags} reach the game as authored. Example ${offMaterials[0].material}: ` +
    `metallicFactor was read as 1.0 through the default before, in the file it is now ` +
    `${fieldOf(fileMat(offMaterials[0]), 'metallicFactor')}`);
  for (const name of ['M_row_05', 'M_row_06']) {
    const e = audit.find((x) => x.material === name);
    ok(`${name}: metallicFactor is written, and the written value IS the spec default, so it is not flagged (tolerance 0)`,
      !!e && e.written.metallicFactor && JSON.stringify(r6(fieldOf(fileMat(e), 'metallicFactor'))) === '1' &&
        !(e.notDefault ?? {}).metallicFactor,
      e ? `file writes ${JSON.stringify(fieldOf(fileMat(e), 'metallicFactor'))}, default ${specDefaults.metallicFactor}, notDefault ${JSON.stringify(e.notDefault)}` : 'no entry');
  }
  ok('the strength-1 ladder material writes its strength now instead of leaving it to the default (tolerance 0)',
    audit.some((e) => e.material === 'M_ladder_1' && e.written.emissiveStrength &&
      JSON.stringify(r6(fieldOf(fileMat(e), 'emissiveStrength'))) === '1'),
    JSON.stringify(audit.find((e) => e.material === 'M_ladder_1')?.notDefault));
  finding('Decision of 2026-11-23 executed: the exporter now writes all five fields for every material ' +
    '(tools/export_map.py, write_material_fields()), so no field is absent and a reader never has to ' +
    'assume what an absent field means. Before the decision the file left 31 fields out and the manifest ' +
    'recorded them as "default used" — conformant, but only truthful when the authored value IS the ' +
    'default, and Blender\'s Principled defaults are not the glTF defaults: Base Color (0.8,0.8,0.8) / ' +
    'Roughness 0.5 / Metallic 0.0 / Emission Color (1,1,1) / Strength 0 against [1,1,1,1] / 1.0 / 1.0 / ' +
    '[0,0,0] / 1.0. Measured on this bake: ' + audit.length + ' materials, ' + (audit.length * 5) +
    ' fields, 0 absent, ' + flagged.length + ' flagged because the written value is not the spec default. ' +
    'The picture changes for ' + changedFlags + ' of those flags and stays the same for ' +
    unchangedFlags.length + ': before the decision the field was not in the file, so a reader took the ' +
    'default instead (example M_grey, authored metallic 0.0, read as 1.0 through the default). The only ' +
    'flags that cannot change the picture are the emission pair of a material whose strength is 0, because ' +
    '0 x anything = 0. The game paths that read through the default still work and now never see a missing ' +
    'field on this export. One finding from running the whole pipeline: the rule has to be applied to the ' +
    'file that SHIPS. tools/bake_map.py re-exports objects.glb after the bake, and a plain re-export writes ' +
    'only the fields that differ from the default, so it dropped all 29 fields export_map had added while ' +
    'the manifest still claimed every field was written (the run log: ' +
    '/private/var/folders/cp/ctx88hms25vf8s383_skt20m0000gn/T/opencode/pipeline-bake-C.log). Both scripts ' +
    'now share tools/glb_fields.py and bake_map.py re-applies write_material_fields after the re-export. ' +
    'Measured on the file that ships: ' + fieldsInFile('objects.glb').fields + ' fields in ' +
    fieldsInFile('objects.glb').mats + ' materials in objects.glb (5 per material: ' +
    '81 written by the exporter itself, 29 added by the rule), ' + fieldsInFile('animated.glb').fields +
    ' in ' + fieldsInFile('animated.glb').mats + ' material in animated.glb. The game paths that read through the ' +
    'default still work — three.js GLTFLoader `metallicFactor !== undefined ? metallicFactor : 1.0` and ' +
    'src/world/map-loader.ts `std.emissiveIntensity ?? 1` — they simply never see a missing field on this ' +
    'export anymore.');

  console.log('\n5. emission ladder 1 / 5 / 20 / 80 (tolerance 0)');
  for (const name of ['L_ladder_1', 'L_ladder_5', 'L_ladder_20', 'L_ladder_80']) {
    const m = meshOf(name);
    const mat = m ? materialOf(m.primitives[0].material) : null;
    const want = parseInt(name.split('_').pop(), 10);
    const measured = mat?.extensions?.KHR_materials_emissive_strength?.emissiveStrength;
    ok(`${name}: strength ${want} is in the file, not left to the default (tolerance 0)`,
      measured === want, `measured ${measured}`);
    measure(`${name} baked value (x pi)`, bakedAt(tris.findIndex((t) => t.island === name)).map((c) => c.toFixed(4)).join(','));
  }

  const anim = glbJson(`${MAP}/animated.glb`);
  console.log('\n6. animated object');
  ok('the animated collection ships as its own file', manifest.collections.animated?.file === 'animated.glb');
  ok('its action is named "loop" (tolerance 0)', anim.animations?.[0]?.name === 'loop',
    JSON.stringify(anim.animations?.map((a) => a.name)));

  console.log('\n7. the teleport hook reads the cell it is in');
  const cp = (manifest.checkpoints ?? []).find((c) => c.name === 'CP_teleport_cell');
  ok('the teleport checkpoint is in the manifest', !!cp,
    JSON.stringify((manifest.checkpoints ?? []).map((c) => c.name)));
  if (cp) {
    const player = { position: { x: 0, y: 0, z: 0 }, feet: { x: 0, y: 0, z: 0 } };
    registerTeleportHook(player, CAPSULE); // in Node there is no window, so registration is skipped
    ok('window.liminalTeleport is registered only in a browser', typeof window === 'undefined');
    // the checkpoint is stored in Blender space; the game reads its player in glTF space
    const gamePoint = { x: cp.position[0], y: cp.position[2], z: -cp.position[1] };
    teleportPlayer(player, gamePoint, CAPSULE);
    measure('teleported feet in game space', `(${player.feet.x}, ${player.feet.y}, ${player.feet.z})`);
    ok('the head sits capsule height above the feet (tolerance 0)',
      player.position.y === player.feet.y + CAPSULE.height / 2, `${player.position.y}`);
    // back into grid space (Blender): x = game x, y = -game z, z = game y
    const g = [player.feet.x, -player.feet.z, player.feet.y];
    const read = new Float64Array(3);
    const ci = sampleIrradiance(grid, g[0], g[1], g[2], 0, 0, 1, read);
    ok('the lookup lands in the point\u2019s OWN cell', lastSampleOwn === true,
      `cell ${ci} key ${grid.cells[ci].key}, distance ${lastSampleDistance.toFixed(3)} m`);
    ok('that cell belongs to the Room A floor island (this proves the coordinate mapping)',
      grid.cells[ci].own.some((ti) => tris[ti].island === 'RoomA_floor'),
      `own triangles: ${grid.cells[ci].own.map((ti) => tris[ti].island).join(', ')}`);
    measure('value read at the teleported point (normal up)', [...read].map((v) => v.toFixed(6)).join(','));
    ok('the point receives light above the 1e-9 floor', read.some((v) => v > 1e-9));
    ok('Room A has no fixture, so it can only arrive through the hole',
      grid.visible[ci].some((ti) => tris[ti].island.startsWith('Wall_hole')),
      `rays in that cell hit: ${[...new Set(grid.visible[ci].map((ti) => tris[ti].island))].join(', ') || 'nothing'}`);
    // Under the rule as the owner confirmed it, the cell does not skip everything it holds — it skips
    // the SURFACE it stands on. So own triangles of a different surface in the same cell can still
    // contribute. Asserted through skipSetFor, tolerance 0.
    const teleCell = grid.cells[ci];
    const teleSkip = skipSetFor(grid, ci);
    const teleOther = teleCell.own.filter((ti) => !teleSkip.has(ti));
    ok('no triangle of the surface the teleported point stands on is counted (tolerance 0)',
      grid.visible[ci].every((ti) => !teleSkip.has(ti)),
      `skip ${teleSkip.size} of ${teleCell.own.length} own triangles (${ownSurface(grid, ci).mesh} slot ` +
      `${ownSurface(grid, ci).slot}); the rest can contribute: ` +
      `${teleOther.map((ti) => `${tris[ti].mesh}/slot${tris[ti].materialIndex ?? '-'}#${ti}`).join(', ') || 'none'}`);
    measure('own triangles this cell still sees (a different surface, so not skipped)',
      grid.visible[ci].filter((ti) => teleCell.own.includes(ti))
        .map((ti) => `${tris[ti].mesh}/slot${tris[ti].materialIndex ?? '-'}#${ti}`).join(', ') || 'none');
    // Split the two effects so the numbers do not get read as drift: on THIS bake, the cell's own value
    // under the new rule versus the same cell under the old rule (skip = every own triangle).
    const tpCoefs = new Float64Array(27);
    projectCoefficients(grid, values, teleCell.px, teleCell.py, teleCell.pz, DEFAULTS.raysPerCell,
      DEFAULTS.seed + ci, new Set(teleCell.own), tpCoefs, DEFAULTS.maxRayDistance);
    const tpOld = new Float64Array(3), tpNow = new Float64Array(3);
    shIrradiance(tpCoefs, 0, 0, 1, tpOld);
    shIrradiance(grid.sh.subarray(ci * 27, ci * 27 + 27), 0, 0, 1, tpNow);
    measure(`cell ${ci} own value, new rule vs old rule (same bake, same seed, normal up)`,
      `[${[...tpNow].map((v) => v.toFixed(6)).join(', ')}] vs [${[...tpOld].map((v) => v.toFixed(6)).join(', ')}] ` +
      `-> the rule alone adds ${(tpNow[0] - tpOld[0]).toFixed(6)}, ` +
      `${(tpNow[1] - tpOld[1]).toFixed(6)}, ${(tpNow[2] - tpOld[2]).toFixed(6)}`);
    const sampleObj = { ownSlot: -1, slots: [], weights: [], missing: 0, gated: 0 };
    const sample = packedBlend(packed, g[0], g[1], g[2], packed.cellSize, sampleObj);
    const sum = sample.weights.reduce((s, w) => s + w, 0);
    ok('the blend weight sum is 1 within 18 ulp', Math.abs(sum - 1) <= 18 * Math.max(ulpOf(sum), 1e-9),
      `sum ${sum.toFixed(12)}, ${sample.slots.length} corners, ${sample.gated} gated, ${sample.missing} missing`);
    ok('the point is inside a cell the file knows', sample.ownSlot >= 0, `own slot ${sample.ownSlot}`);
    if (sample.ownSlot >= 0) {
      const blendOut = new Float64Array(3);
      packedBlendIrradiance(packed, sample, [0, 0, 1], blendOut);
      let refSum = 0;
      const refAcc = new Float64Array(3);
      for (let i = 0; i < sample.slots.length; i++) {
        const v = new Float64Array(3);
        const cellIndex = cellOfSlot(sample.slots[i]);
        shIrradiance(grid.sh.subarray(cellIndex * 27, cellIndex * 27 + 27), 0, 0, 1, v);
        refSum += sample.weights[i];
        for (let k = 0; k < 3; k++) refAcc[k] += sample.weights[i] * v[k];
      }
      const ownV = new Float64Array(3);
      shIrradiance(grid.sh.subarray(cellOfSlot(sample.ownSlot) * 27, cellOfSlot(sample.ownSlot) * 27 + 27), 0, 0, 1, ownV);
      const ref = [0, 1, 2].map((k) => ownV[k] * (1 - packed.blend) + (refSum > 0 ? refAcc[k] / refSum : 0) * packed.blend);
      ok('the f32 blend matches the f64 reference within 40 ulp',
        [0, 1, 2].every((k) => ulpEq(blendOut[k], ref[k], 40)),
        `blend ${[...blendOut].map((v) => v.toFixed(6)).join(',')} vs reference ${ref.map((v) => v.toFixed(6)).join(',')} (factor ${packed.blend})`);
    }
    const sealed = new Float64Array(3);
    sampleIrradiance(grid, 24, 14, 0, 0, 0, 1, sealed); // Room C, grid space
    const sealedIdx = cellIndexAt(grid, 24, 14, 0);
    // Room C holds no fixture, so anything above 0 is a bug, not noise. As decided 2026-11-23 the
    // control is asserted at tolerance 0, and tools/build_testmap.py sets the World Background
    // strength to 0 so the control CAN be asserted that way (with the default strength 1.0 Cycles
    // leaked through the zero-thickness quads: 1.17e-7 in this cell, 871 of 8930 texels inside
    // Room C's own island rectangles, max 5.62e-7; proven with a black-world bake, 0 texels).
    ok('the sealed room with no fixture reads exactly 0 (tolerance 0)', sealed.every((v) => v === 0),
      `cell ${sealedIdx} reads ${[...sealed].map((v) => v.toFixed(9)).join(', ')}, world strength 0`);
    if (!sealed.every((v) => v === 0)) {
      // where the number comes from: the bake itself, not the grid. Count the texels inside
      // Room C's own island rectangles.
      const rectOf = (name) => {
        const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
        for (const t of tris) if (t.island === name) for (let i = 0; i < 3; i++) {
          lo[0] = Math.min(lo[0], t.uv[i * 2]); hi[0] = Math.max(hi[0], t.uv[i * 2]);
          lo[1] = Math.min(lo[1], t.uv[i * 2 + 1]); hi[1] = Math.max(hi[1], t.uv[i * 2 + 1]);
        }
        return [lo.map((v) => Math.floor(v * resolution)), hi.map((v) => Math.floor(v * resolution))];
      };
      let lit = 0, total = 0, max = 0;
      for (const name of islandOrder.filter((n) => n.startsWith('RoomC_'))) {
        const [lo, hi] = rectOf(name);
        for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
          total++; const v = values[(y * resolution + x) * 4];
          if (v > 0) { lit++; max = Math.max(max, v); }
        }
      }
      const hits = Array.from(new Set(grid.visible[sealedIdx].map((ti) => tris[ti].island)));
      ok('in that cell every recorded triangle the rays hit is a Room C face',
        hits.every((n) => n.startsWith('RoomC_')), `hits: ${hits.join(', ') || 'nothing'}`);
      measure('source of the non-zero reading (texels inside Room C\u2019s own islands)',
        `${lit} of ${total} texels are non-zero, max ${max.toExponential(2)} - below half's normal floor 6.1e-5, so black on screen`);
      finding('The sealed-room control reads above 0 even though the World has strength 0, so the light came ' +
        'through the walls, not from a fixture: ' +
        [...sealed].map((v) => v.toExponential(2)).join(', ') + ' in cell ' + sealedIdx + ', ' +
        `${lit} of ${total} texels non-zero inside Room C\u2019s own islands (max ${max.toExponential(2)}). ` +
        'Every object the rays hit in that cell is a Room C face, so the number is a bake leak through ' +
        'zero-thickness quads (Cycles starts each ray offset from the surface). With the World at strength 0 ' +
        'the only remaining option is physical: give the test walls thickness in the .blend. The alternative ' +
        'is to state the control against the half-float floor 6.1e-5 instead of 0, which this check does not ' +
        'do: the tolerance here was NOT weakened, the number is printed as measured.');
    }
  }

  console.log('\n8. the self-light rule, per mesh AND slot (owner decision 2026-11-23, measured through the implementation)');
  const cellIdx = cellOfTri(tris[panelTris[0]]);
  const cell = grid.cells[cellIdx];
  const label = (ti) => `${tris[ti].mesh}/slot${tris[ti].materialIndex}#${ti}`;
  measure('cell of the two-slot mesh', `#${cellIdx} key ${cell.key}, own triangles ${cell.own.map(label).join(', ')}`);
  ok('the glow faces and the plain faces of the mesh share ONE cell (tolerance 0)',
    panelTris.every((ti) => cellOfTri(tris[ti]) === cellIdx), `cell ${cellIdx}`);
  const project = (skip) => {
    const coefs = new Float64Array(27);
    const seen = projectCoefficients(grid, values, cell.px, cell.py, cell.pz, DEFAULTS.raysPerCell,
      DEFAULTS.seed + cellIdx, skip, coefs, DEFAULTS.maxRayDistance);
    const out = new Float64Array(3);
    shIrradiance(coefs, cell.nx, cell.ny, cell.nz, out);
    return { out, seen };
  };

  // Read through src/world/light-grid.ts, which this check does not touch: a surface is a (mesh, slot)
  // pair, ownSurface() picks the pair with the largest area inside the cell, and skipSetFor() skips the
  // faces of that pair. The tie is decided by rules, not by the import order: equal area -> the smaller
  // slot index, equal area AND equal slot -> the alphabetically smaller mesh name (owner, 2026-11-23).
  const surface = ownSurface(grid, cellIdx);
  const skip = skipSetFor(grid, cellIdx);
  const areaBySurface = {};
  for (const ti of cell.own) {
    const key = `${tris[ti].mesh} slot ${tris[ti].materialIndex}`;
    areaBySurface[key] = (areaBySurface[key] ?? 0) + grid.metrics[ti].areaM2;
  }
  const areas = Object.values(areaBySurface);
  const triAreas = cell.own.map((ti) => grid.metrics[ti].areaM2);
  const ownKey = `${surface.mesh} slot ${surface.slot}`;
  measure('surfaces inside the cell, by area', Object.entries(areaBySurface)
    .map(([k, a]) => `${k}: ${a.toFixed(4)} m2`).join(', '));
  // The condition the name rule needs, measured at tolerance 0: the areas must be EXACTLY equal, not
  // "equal after rounding". If they were not, the area rule would decide and the name rule would never
  // be reached.
  ok('the three surfaces in this cell are exactly the same size, so the tie rule is what decides (tolerance 0)',
    areas.length === 3 && areas.every((a) => a === areas[0]) && triAreas.every((a) => a === triAreas[0]),
    `3 surfaces of 2 triangles, every surface ${areas[0]} m2 (reads as ${areas[0].toFixed(4)}), every triangle ` +
    `${triAreas[0]} m2 (reads as ${triAreas[0].toFixed(4)})`);
  ok('ownSurface picks the (mesh, slot) pair with the largest area in the cell (tolerance 0)',
    areaBySurface[ownKey] === Math.max(...areas),
    `own surface = ${ownKey}, ${areaBySurface[ownKey].toFixed(4)} m2 of ${cell.own.length} own triangles, ` +
    `${Object.keys(areaBySurface).length} surfaces in the cell`);
  ok('equal area AND equal slot -> the alphabetically smaller mesh name decides, not the order in `own` ' +
    '(tolerance 0)',
    surface.mesh === 'Plain_wall_ref' && surface.slot === 0,
    `own = ${ownKey}; the other slot-0 surface is TwoSlot_panel slot 0 and "Plain_wall_ref" < "TwoSlot_panel". ` +
    `The order in own is [${cell.own.map((ti) => tris[ti].mesh).join(', ')}], so the order alone would have ` +
    `picked ${cell.own.map((ti) => tris[ti].mesh)[0]} — the tie rule now decides it`);
  // The same rule on a cell where the areas AND the slots are equal and only the mesh names differ: the
  // answer must come from the name, not from the order the packer produced. Both orders measured with the
  // same ownSurface(), nothing changed in it.
  const tieGrid = buildLightGrid([
    { verts: [0, 0, 0, 1, 0, 0, 0, 1, 0], uv: [0, 0, 1, 0, 0, 1], island: 'Tie_slot1', mesh: 'Tie_slot1', materialIndex: 1 },
    { verts: [1, 0, 0, 2, 0, 0, 1, 1, 0], uv: [0, 0, 1, 0, 0, 1], island: 'Tie_slot0', mesh: 'Tie_slot0', materialIndex: 0 },
  ], new Float64Array(16 * 16 * 4), 16, { minCellSize: 3, maxCellSize: 3 });
  const tieCell = tieGrid.cells.findIndex((c) => c.own.length === 2);
  ok('the slot tie test has both triangles in ONE cell, area exactly 0.5 m2 each (tolerance 0)',
    tieCell >= 0 && tieGrid.metrics[tieGrid.cells[tieCell].own[0]].areaM2 ===
      tieGrid.metrics[tieGrid.cells[tieCell].own[1]].areaM2,
    `cell #${tieCell}, areas ${tieGrid.cells[tieCell].own.map((ti) => tieGrid.metrics[ti].areaM2.toFixed(6)).join(' = ')} m2`);
  ok('equal areas -> the smaller slot index wins (tolerance 0)',
    ownSurface(tieGrid, tieCell).slot === 0,
    `ownSurface -> ${ownSurface(tieGrid, tieCell).mesh} slot ${ownSurface(tieGrid, tieCell).slot}`);
  const meshTie = (order) => {
    const g = buildLightGrid(order.map((n, i) => ({
      verts: [i, 0, 0, i + 1, 0, 0, i, 1, 0], uv: [0, 0, 1, 0, 0, 1], island: n, mesh: n, materialIndex: 0,
    })), new Float64Array(16 * 16 * 4), 16, { minCellSize: 3, maxCellSize: 3 });
    const ci = g.cells.findIndex((c) => c.own.length === 2);
    return { ci, picked: ownSurface(g, ci), areas: g.cells[ci].own.map((ti) => g.metrics[ti].areaM2) };
  };
  const tieA = meshTie(['MeshA', 'MeshB']);
  const tieB = meshTie(['MeshB', 'MeshA']);
  ok('equal area AND equal slot, two meshes: the mesh NAME decides, the order in `own` does not ' +
    '(tolerance 0 — both orders measured with the same ownSurface())',
    tieA.ci >= 0 && tieB.ci >= 0 && tieA.areas[0] === tieA.areas[1] && tieB.areas[0] === tieB.areas[1] &&
      tieA.picked.mesh === 'MeshA' && tieB.picked.mesh === 'MeshA',
    `order [MeshA, MeshB] -> ${tieA.picked.mesh}; order [MeshB, MeshA] -> ${tieB.picked.mesh}; ` +
    `areas ${tieA.areas[0].toFixed(6)} = ${tieA.areas[1].toFixed(6)} m2 in cell #${tieA.ci}: the same answer ` +
    `in both orders, so the name rule (not the import order) decides`);

  ok('the skip set is the surface the point stands on: Plain_wall_ref slot 0, the panel is NOT skipped ' +
    '(tolerance 0)',
    skip.size === plainRefTris.length && [...skip].every((ti) => cell.own.includes(ti)) &&
    [...skip].every((ti) => tris[ti].mesh === surface.mesh && tris[ti].materialIndex === surface.slot) &&
    ![...skip].some((ti) => tris[ti].mesh !== surface.mesh),
    `skip ${skip.size} of ${cell.own.length} own triangles: ${[...skip].map(label).join(', ')}; ` +
    `the other slot-0 surface (TwoSlot_panel slot 0, ${panelTris.filter((ti) => slotOfTri[ti] === 0).map(label).join(', ')}) ` +
    `and the glow half (${panelTris.filter((ti) => slotOfTri[ti] === 1).map(label).join(', ')}) are not skipped`);

  // The two effects of the owner's change have to be reported apart, so the same rays are run three times
  // through the same projectCoefficients(): (A) the rule as it was decided before the mesh tie, (B) the
  // name rule with the position still taken from the average over all own triangles, (C) the name rule plus
  // the position AND the normal taken from the surface the point stands on (commit 68396a6), which is what
  // fillCell does and what the file holds. No number here is hardcoded: the tolerance-0 comparison of the
  // resulting value is against the reference stored in the manifest (section 9).
  const projectAt = (pos, n, skipSet) => {
    const coefs = new Float64Array(27);
    const seen = projectCoefficients(grid, values, pos[0], pos[1], pos[2], DEFAULTS.raysPerCell,
      DEFAULTS.seed + cellIdx, skipSet, coefs, DEFAULTS.maxRayDistance);
    const out = new Float64Array(3);
    shIrradiance(coefs, n[0], n[1], n[2], out);
    return { out, seen };
  };
  // the position and normal as they were before commit 68396a6: the area-weighted average over EVERY own
  // triangle, plus the same push out of the wall
  let ax = 0, ay = 0, az = 0, anx = 0, any = 0, anz = 0, ownArea = 0;
  for (const ti of cell.own) {
    const m = grid.metrics[ti];
    ownArea += m.areaM2;
    ax += m.cx * m.areaM2; ay += m.cy * m.areaM2; az += m.cz * m.areaM2;
    anx += m.nx * m.areaM2; any += m.ny * m.areaM2; anz += m.nz * m.areaM2;
  }
  const nl = Math.hypot(anx, any, anz) || 1;
  const push = Math.min(0.2, grid.cellSize / 4);
  const avgPoint = [ax / ownArea + (anx / nl) * push, ay / ownArea + (any / nl) * push, az / ownArea + (anz / nl) * push];
  const avgNormal = [anx / nl, any / nl, anz / nl];

  const asSlotOnly = projectAt(avgPoint, avgNormal, new Set(cell.own.filter((ti) => tris[ti].materialIndex === surface.slot)));
  const asTieRule = projectAt(avgPoint, avgNormal, skip);
  const asMeshAndSlot = projectAt([cell.px, cell.py, cell.pz], [cell.nx, cell.ny, cell.nz], skip);
  const asWholeMesh = projectAt([cell.px, cell.py, cell.pz], [cell.nx, cell.ny, cell.nz], new Set(cell.own));
  measure('A) rule as it was decided before the mesh tie (slot alone), position from the average over all own triangles',
    `[${[...asSlotOnly.out].map((v) => v.toFixed(6)).join(', ')}]`);
  measure('B) the mesh name decides the surface now, same position source as before (selection change alone)',
    `[${[...asTieRule.out].map((v) => v.toFixed(6)).join(', ')}]`);
  measure('C) plus the position and normal taken from that surface (commit 68396a6) = the value in the file',
    `[${[...asMeshAndSlot.out].map((v) => v.toFixed(6)).join(', ')}]`);
  const selChange = [0, 1, 2].map((k) => asTieRule.out[k] - asSlotOnly.out[k]);
  const sourceChange = [0, 1, 2].map((k) => asMeshAndSlot.out[k] - asTieRule.out[k]);
  measure('the selection change alone (B - A)', `[${selChange.map((v) => v.toFixed(6)).join(', ')}]`);
  measure('the position/normal source change (C - B)', `[${sourceChange.map((v) => v.toFixed(6)).join(', ')}]`);
  measure('same cell under the whole-mesh rule (skip = every own triangle)',
    `[${[...asWholeMesh.out].map((v) => v.toFixed(6)).join(', ')}]`);
  // Which part the source change is, measured at tolerance 0 in THIS cell: all three surfaces face the
  // same way, so the normal cannot be the difference — only the position is.
  ok('every surface in this cell faces the same way, so the normal part of the source change is exactly 0 ' +
    '(tolerance 0)',
    cell.own.every((ti) => grid.metrics[ti].nx === cell.nx && grid.metrics[ti].ny === cell.ny &&
      grid.metrics[ti].nz === cell.nz),
    `normal (${cell.nx}, ${cell.ny}, ${cell.nz}) for all ${cell.own.length} triangles, so the whole source ` +
    `change comes from the position: averaged point (${avgPoint[0].toFixed(4)}, ${avgPoint[1].toFixed(4)}, ` +
    `${avgPoint[2].toFixed(4)}), point on the picked surface (${cell.px.toFixed(4)}, ${cell.py.toFixed(4)}, ` +
    `${cell.pz.toFixed(4)}) = ${(cell.px - avgPoint[0]).toFixed(4)} m further along x`);
  // The numbers recorded on 2026-11-23 are NOT hardcoded here. A cross-bake float is not reproducible:
  // the UV packing changes from run to run, so the same rule on a fresh bake lands in different cells.
  // The tolerance-0 comparison is against the reference the pipeline stored in manifest.json for THIS
  // bake (section 9); a second bake is reported as drift, not as a pass or a failure. What stays asserted
  // at tolerance 0 in this section is the structure: the selection, the skip set, the bytes, and the
  // contribution above the 1e-9 floor.
  // Contributions are measured with the SAME point and normal on both sides, so a number is a
  // contribution and not a mix of the selection change and the position change. They are signed sums
  // over the rays that hit a face: a ray that hits a skipped face contributes nothing and does NOT
  // continue past it, so taking a face out of the skip set replaces those zeros with that face's signed
  // SH terms — the sign depends on where the face sits relative to the cell normal. "Contributes" here
  // means above the declared floor 1e-9, not "more than 0".
  const panelPlain = new Set(cell.own.filter((ti) => tris[ti].mesh === 'TwoSlot_panel' && tris[ti].materialIndex === 0));
  const glow = new Set(cell.own.filter((ti) => tris[ti].materialIndex === 1));
  const plainRefSet = new Set(plainRefTris);
  const cellPoint = [cell.px, cell.py, cell.pz], cellNormal = [cell.nx, cell.ny, cell.nz];
  const nothingContributes = projectAt(cellPoint, cellNormal, new Set(cell.own)); // every face skipped
  const contrib = (faces) => {
    const r = projectAt(cellPoint, cellNormal, new Set(cell.own.filter((ti) => !faces.has(ti))));
    return [0, 1, 2].map((k) => r.out[k] - nothingContributes.out[k]);
  };
  const panelPlainContribution = contrib(panelPlain);
  const glowContribution = contrib(glow);
  const plainRefContribution = contrib(plainRefSet);
  measure('contribution of the panel plain half (the faces the mesh rule un-skipped), same point as the file',
    `[${panelPlainContribution.map((v) => v.toFixed(6)).join(', ')}]`);
  measure('contribution of the glow half (same mesh, other slot), same point as the file',
    `[${glowContribution.map((v) => v.toFixed(6)).join(', ')}]`);
  measure('contribution of Plain_wall_ref if the point did not stand on it',
    `[${plainRefContribution.map((v) => v.toFixed(6)).join(', ')}]`);
  ok('the surface the point stands on contributes exactly 0 to its own cell (tolerance 0): the cell value ' +
    'is the no-contribution value plus the two surfaces the point does NOT stand on',
    [0, 1, 2].every((k) => asMeshAndSlot.out[k] === nothingContributes.out[k] +
      panelPlainContribution[k] + glowContribution[k]) &&
    [...skip].every((ti) => plainRefSet.has(ti)),
    `no-contribution value ${[...nothingContributes.out].map((v) => v.toFixed(6)).join(', ')} + panel plain ` +
    `${[...panelPlainContribution].map((v) => v.toFixed(6)).join(', ')} + glow ` +
    `${[...glowContribution].map((v) => v.toFixed(6)).join(', ')} = ${[...asMeshAndSlot.out].map((v) => v.toFixed(6)).join(', ')} ` +
    `(the value in the file). Plain_wall_ref itself would add ${[...plainRefContribution].map((v) => v.toFixed(6)).join(', ')} ` +
    'if the point stood on another surface — the rule is what makes that 0.');
  ok('the two surfaces the point does NOT stand on contribute more than the 1e-9 floor (tolerance 0)',
    panelPlainContribution.some((v) => Math.abs(v) > 1e-9) && glowContribution.some((v) => Math.abs(v) > 1e-9),
    `panel plain half ${[...panelPlainContribution].map((v) => v.toFixed(6)).join(', ')} (0 under the whole-mesh rule), ` +
    `glow half ${[...glowContribution].map((v) => v.toFixed(6)).join(', ')} (0 under the whole-mesh rule) — three ` +
    'surfaces in one cell can light each other, only the one the point stands on cannot');
  measure('the faces the point can see from its own point (the skip set is never in this list)',
    [...asMeshAndSlot.seen].map(label).join(', ') || 'NONE');
  ok('the point cannot see the faces of the surface it stands on, so the skip set and the seen set are ' +
    'disjoint (tolerance 0)',
    ![...asMeshAndSlot.seen].some((ti) => skip.has(ti)) && [...skip].every((ti) => plainRefSet.has(ti)),
    `seen ${[...asMeshAndSlot.seen].map(label).join(', ') || 'NONE'}; the skipped faces ` +
    `${[...skip].map(label).join(', ')} cannot be in it, because a ray that hits them is dropped`);
  ok('the glow half IS visible from the point in its own cell (tolerance 0)',
    [...asMeshAndSlot.seen].some((ti) => tris[ti].materialIndex === 1),
    [...asMeshAndSlot.seen].filter((ti) => tris[ti].materialIndex === 1).map(label).join(', ') || 'NONE');
  measure('the same cell if the tie had picked TwoSlot_panel slot 0 as the surface the point stands on',
    `[${[...projectAt(avgPoint, avgNormal, panelPlain).out].map((v) => v.toFixed(6)).join(', ')}]`);
  // fillCell uses skipSetFor, so the value stored in the file must be the value the rule produces. This
  // is what proves the file on disk was built with the mesh AND slot rule, not merely measured with it.
  // The grid the check rebuilds holds the value at full precision; lightgrid.bin holds the f32 rounding of
  // it, and the reference in the manifest records that rounding (tolerance 0 in section 9).
  const fileOut = new Float64Array(3);
  shIrradiance(grid.sh.subarray(cellIdx * 27, cellIdx * 27 + 27), cell.nx, cell.ny, cell.nz, fileOut);
  ok('the rebuilt grid holds exactly the value the mesh-AND-slot rule produces (tolerance 0)',
    [0, 1, 2].every((k) => fileOut[k] === asMeshAndSlot.out[k]),
    `grid [${[...fileOut].map((v) => v.toFixed(6)).join(', ')}] vs recomputed [${[...asMeshAndSlot.out].map((v) => v.toFixed(6)).join(', ')}]`);

  finding('Consequence of the rule as the owner confirmed it, measured in cell ' + cellIdx + ' (' + cell.key + '): ' +
    'three surfaces sit in this cell — ' + Object.entries(areaBySurface).map(([k, a]) =>
      `${k} (${cell.own.filter((ti) => `${tris[ti].mesh} slot ${tris[ti].materialIndex}` === k).map(label).join(', ')}, ` +
      `${a.toFixed(4)} m2)`).join('; ') + '. They are three surfaces, so they can light each other. ' +
    'The owner expected the point surface to be the larger one at ' + (2 * areas[0]).toFixed(4) + ' m2; that ' +
    'number is the sum of the two slot-0 surfaces under the slot-only rule. Measured here every surface has ' +
    'the SAME area, so the area rule cannot decide which one the point stands on — the tie rules do: the ' +
    'smaller slot index, and when the areas AND the slots are equal the alphabetically smaller mesh name ' +
    '(owner decision 2026-11-23, commit 40482fa), which the two-order test above proves. In this cell own ' +
    'picks ' + ownKey + ', so the skip set is ' + skip.size + ' of ' + cell.own.length + ' own triangles; ' +
    'under the slot-only rule it was 4, because Plain_wall_ref counted as the same material. ' +
    'The two effects are reported apart: the selection change alone ' +
    selChange.map((v) => v.toFixed(6)).join(', ') + ' (A -> B), the position/normal source change ' +
    sourceChange.map((v) => v.toFixed(6)).join(', ') + ' (B -> C, commit 68396a6), which here is purely the ' +
    'position because all three surfaces face the same way. Contributions are measured at the point the ' +
    'file uses, so each number stands on its own: the panel plain half contributes ' +
    panelPlainContribution.map((v) => v.toFixed(6)).join(', ') + ', the glow half ' +
    glowContribution.map((v) => v.toFixed(6)).join(', ') + ', both above the 1e-9 floor; Plain_wall_ref ' +
    'would contribute ' + plainRefContribution.map((v) => v.toFixed(6)).join(', ') + ' if the point did not ' +
    'stand on it, and contributes exactly 0 under the rule because a point cannot light the face it stands ' +
    'on. Contributions are signed sums, so the sign comes from the SH terms of the rays that hit a face. ' +
    'Cell value: ' +
    [...asSlotOnly.out].map((v) => v.toFixed(6)).join(', ') + ' under the rule before the mesh tie, ' +
    [...asTieRule.out].map((v) => v.toFixed(6)).join(', ') + ' with the name rule at the old position, ' +
    [...asMeshAndSlot.out].map((v) => v.toFixed(6)).join(', ') + ' as the file holds it. These are measurements; ' +
    'the tolerance-0 assertion against the stored reference is in section 9.');

  finding('Bake reproducibility, as the owner decided it on 2026-11-23: a cross-bake float has no declared ' +
    'tolerance, because the UV packing changes from run to run and the same rule lands in different cells. ' +
    'So a check compares against the reference the pipeline stored in manifest.json for the bake that ' +
    'produced the file (tolerance 0), and a second bake is reported as its own DRIFT line, never as a pass ' +
    'or a failure. The check does not run Blender: it reads a second bake given with --second-bake=<dir> ' +
    'and prints the drift in section 10. Without that option nothing can be compared, and the check says so ' +
    'instead of guessing a tolerance.');

  console.log('\n9. the stored reference in manifest.json (owner decision 2026-11-23), compared at tolerance 0');
  const ref = manifest.lightgrid?.reference;
  ok('the manifest carries the reference the pipeline wrote for THIS bake (tolerance 0)',
    !!ref && Array.isArray(ref.cells),
    ref ? `${ref.cells.length} cell values, cell size ${ref.cellSize}, cell count ${ref.cellCount}` : 'no reference in the manifest');
  if (ref) {
    // A slot in the packed file is a hashed table index, not a cell index, so the cell key is read from
    // the slot header. The coefficients are the f32 numbers the file holds, evaluated with f64
    // arithmetic exactly the way the game evaluates them.
    const slotOfKey = new Map();
    for (let slot = 0; slot < packed.slotCount; slot++) {
      const base = slot * SLOT_STRIDE;
      if (packed.data[base + 3] === 0) continue;
      slotOfKey.set(`${packed.data[base]},${packed.data[base + 1]},${packed.data[base + 2]}`, slot);
    }
    const fileCoefs = (key) => {
      const slot = slotOfKey.get(key);
      if (slot === undefined) return null;
      const base = slot * SLOT_STRIDE + 4;
      const coefs = new Float64Array(27);
      for (let c = 0; c < 3; c++) for (let k = 0; k < 9; k++) coefs[c * 9 + k] = packed.data[base + k * 4 + c];
      return coefs;
    };
    const fmt3 = (v) => `[${[...v].map((x) => x.toFixed(6)).join(', ')}]`;
    ok('the reference describes the same grid the file holds (tolerance 0)',
      ref.cellCount === packed.cellCount && ref.cellCount === grid.cells.length && ref.cellSize === grid.cellSize,
      `reference ${ref.cellCount} cells at ${ref.cellSize} m = file header ${packed.cellCount} cells = ` +
      `rebuilt grid ${grid.cells.length} cells at ${grid.cellSize} m`);
    const badKind = [], badValue = [], badSurface = [], badNormal = [];
    for (const e of ref.cells) {
      const ci = grid.cellOfKey.get(e.key);
      if (ci === undefined) { badKind.push(`${e.key}: not in the grid the check rebuilt`); continue; }
      const cell = grid.cells[ci];
      if (cell.kind !== e.kind) badKind.push(`${e.key}: reference ${e.kind}, grid ${cell.kind}`);
      const coefs = fileCoefs(e.key);
      if (coefs === null) { badValue.push(`${e.key}: the file has no slot for it`); continue; }
      if (e.value === null) {
        // an air cell has no surface and no stored normal, so its value depends on the normal the game
        // happens to evaluate with. The reference stores null for all three, which is what is asserted.
        if (cell.own.length > 0 || cell.nx !== 0 || cell.ny !== 0 || cell.nz !== 0 ||
            e.surface !== null || e.normal !== null) badSurface.push(`${e.key}: space cell but the reference names a surface`);
        continue;
      }
      const out = new Float64Array(3);
      shIrradiance(coefs, e.normal[0], e.normal[1], e.normal[2], out);
      if (!out.every((v, k) => v === e.value[k])) badValue.push(`${e.key}: file ${fmt3(out)} vs reference ${fmt3(e.value)}`);
      const own = ownSurface(grid, ci);
      if (own.mesh !== e.surface.mesh || own.slot !== e.surface.slot)
        badSurface.push(`${e.key}: reference ${e.surface.mesh} slot ${e.surface.slot}, ownSurface ${own.mesh} slot ${own.slot}`);
      if (![cell.nx, cell.ny, cell.nz].every((v, k) => v === e.normal[k]))
        badNormal.push(`${e.key}: reference ${fmt3(e.normal)}, grid ${fmt3([cell.nx, cell.ny, cell.nz])}`);
    }
    const surfaceCells = ref.cells.filter((e) => e.value !== null).length;
    ok('every cell value in the file equals the stored reference at tolerance 0', badValue.length === 0,
      `${ref.cells.length} cells (${surfaceCells} surface, ${ref.cells.length - surfaceCells} space), ` +
      `${badValue.length} value(s) outside tolerance 0${badValue.length ? ': ' + badValue.slice(0, 5).join('; ') : ''}`);
    ok('every reference surface is the surface ownSurface() picks for that cell, and every reference normal ' +
      'is the normal fillCell stored (tolerance 0)',
      badSurface.length === 0 && badNormal.length === 0 && badKind.length === 0,
      `${badSurface.length} surface mismatch(es), ${badNormal.length} normal mismatch(es), ` +
      `${badKind.length} kind mismatch(es)`);
    const refCell = ref.cells.find((e) => e.key === cell.key);
    const refFileValue = refCell ? fileCoefs(refCell.key) : null;
    const fileValueHere = refFileValue ? (() => { const o = new Float64Array(3); shIrradiance(refFileValue, refCell.normal[0], refCell.normal[1], refCell.normal[2], o); return o; })() : null;
    measure('the reference for the cell this section measures', `${cell.key}: surface ${refCell?.surface?.mesh} ` +
      `slot ${refCell?.surface?.slot}, normal ${fmt3(refCell?.normal ?? [])}, value ${fmt3(refCell?.value ?? [])}`);
    ok('the value the file holds for this cell equals the stored reference at tolerance 0 (tolerance 0)',
      fileValueHere && refCell.value && [0, 1, 2].every((k) => fileValueHere[k] === refCell.value[k]),
      `file coefficients read as the game reads them ${fmt3(fileValueHere ?? [])} vs reference ${fmt3(refCell?.value ?? [])}`);
    // The recomputation in section 8 runs on the f64 grid, the reference stores the f32 coefficients the
    // file holds, so the two paths are the same number only within the declared 9 ulp. Tolerance 0 is kept
    // for the reference itself; the ulp figure is the one already declared in this check, not a new one.
    ok('the same cell recomputed from the f64 grid is the same number within the declared 9 ulp ' +
      '(tolerance 0 for the reference, 9 ulp for the f64 path)',
      fileValueHere && [0, 1, 2].every((k) => ulpEq(refCell.value[k], asMeshAndSlot.out[k], 9)),
      `reference ${fmt3(refCell?.value ?? [])} vs recomputed here ${fmt3(asMeshAndSlot.out)}, difference ` +
      `${[0, 1, 2].map((k) => (Math.abs(refCell.value[k] - asMeshAndSlot.out[k]) / (Math.abs(Math.fround(refCell.value[k])) * 6e-7)).toFixed(2)).join(', ')} ulp`);
    finding('Nothing in this section is a hardcoded number: the tolerance-0 comparison is against the values ' +
      'the pipeline stored for the bake that produced the file. The numbers written in the earlier rounds ' +
      '(cell 48 read 1.049181, 0.899789, 0.793892 under the previous tie rule in the previous bake, and ' +
      '1.056067, 0.906074, 0.799579 under the slot-only rule) are kept in the log as history, not as ' +
      'tolerances. They belong to a different pack, so they are not compared here.');
  } else {
    measure('no reference to compare against', 'manifest.json has no lightgrid.reference; ' +
      'tools/write_lightgrid.mjs writes one, so a run without it cannot be compared at tolerance 0');
  }

  console.log('\n10. the second bake, reported as drift (neither a pass nor a failure)');
  if (!SECOND) {
    measure('nothing to compare', 'no second bake given. Run the check with --second-bake=<dir> to see the ' +
      'run-to-run drift; without it no cross-bake float can be asserted at any tolerance.');
  } else {
    const secondSource = JSON.parse(fs.readFileSync(`${SECOND}/gridsource.json`, 'utf8'));
    const secondValues = decodeHalfTexels(fs.readFileSync(`${SECOND}/lightmap.bin`), secondSource.resolution,
      secondSource.scale ?? GRID_SCALE);
    const secondGrid = buildLightGrid(secondSource.tris, secondValues, secondSource.resolution, {});
    const secondPacked = decodeLightGrid(fs.readFileSync(`${SECOND}/lightgrid.bin`));
    const sameCount = secondGrid.cells.length === grid.cells.length;
    drift(`cells: this bake ${grid.cells.length} at ${grid.cellSize} m, second bake ${secondGrid.cells.length} ` +
      `at ${secondGrid.cellSize} m${sameCount ? ' (same count)' : ' (different count, so the same rule lands in different cells)'} ` +
      `— ${sameCount ? 'the packing differs, so the cells themselves differ' : 'the packing differs'}`);
    let diffVerts = 0, diffUv = 0, diffMesh = 0, diffSlot = 0;
    for (let i = 0; i < tris.length; i++) {
      const x = tris[i], y = secondSource.tris[i];
      if (JSON.stringify(x.verts) !== JSON.stringify(y.verts)) diffVerts++;
      if (JSON.stringify(x.uv) !== JSON.stringify(y.uv)) diffUv++;
      if (x.mesh !== y.mesh) diffMesh++;
      if (x.materialIndex !== y.materialIndex) diffSlot++;
    }
    drift(`triangles: verts identical on ${tris.length - diffVerts} of ${tris.length}, uv differs on ${diffUv}, ` +
      `mesh differs on ${diffMesh}, slot differs on ${diffSlot}. The rule inputs are the same, the packing is not.`);
    const here = grid.cellOfKey.get(cell.key), there = secondGrid.cellOfKey.get(cell.key);
    if (there === undefined) {
      drift(`cell ${cell.key} does not exist in the second bake, so its value cannot be compared at all`);
    } else {
      const sc = secondGrid.cells[there];
      const coefs = new Float64Array(27);
      for (let i = 0; i < 27; i++) coefs[i] = Math.fround(secondGrid.sh[there * 27 + i]);
      const out = new Float64Array(3);
      shIrradiance(coefs, sc.nx, sc.ny, sc.nz, out);
      const own2 = ownSurface(secondGrid, there);
      const skip2 = skipSetFor(secondGrid, there);
      drift(`cell ${cell.key}: selection here ${surface.mesh} slot ${surface.slot} / skip ${skip.size} of ` +
        `${cell.own.length}; second bake ${own2.mesh} slot ${own2.slot} / skip ${skip2.size} of ${sc.own.length}`);
      drift(`cell ${cell.key}: value here ${[...asMeshAndSlot.out].map((v) => v.toFixed(6)).join(', ')} ` +
        `(reference ${ref?.cells.find((e) => e.key === cell.key)?.value?.map((v) => v.toFixed(6)).join(', ') ?? 'no reference'}), ` +
        `second bake ${[...out].map((v) => v.toFixed(6)).join(', ')}, difference ` +
        `${[0, 1, 2].map((k) => (out[k] - asMeshAndSlot.out[k]).toFixed(6)).join(', ')} — no tolerance declared`);
    }
    if (sameCount) drift(`the same cell count does not mean the same cells: the packing decides which triangle ` +
      `sits in which cell, and that is what drifts run to run (Cycles sampling adds to it).`);
  }

  console.log('\n11. the option, measured: faces in separate meshes (test case C)');
  const glowCell = cellOfTri(tris[tris.findIndex((t) => t.island === 'Split_emissive')]);
  const plainCell = cellOfTri(tris[tris.findIndex((t) => t.island === 'Split_plain')]);
  measure('cells of the two separate meshes (2 m x 2 m, 3 m apart)', `emissive #${glowCell}, plain #${plainCell}`);
  ok('they land in DIFFERENT cells, so the glow island is not `own` there (tolerance 0)', glowCell !== plainCell);
  const seenSplit = grid.visible[plainCell];
  measure('what the plain mesh cell sees', [...new Set(seenSplit.map((ti) => tris[ti].island))].join(', ') || 'nothing');
  ok('the glow island is not part of `own` in the plain cell, so the self-light rule does not apply there ' +
    '(tolerance 0)',
    grid.cells[plainCell].own.every((ti) => tris[ti].island === 'Split_plain') &&
    glowCell !== plainCell && !seenSplit.some((ti) => skipSetFor(grid, plainCell).has(ti)),
    `own ${grid.cells[plainCell].own.map((ti) => tris[ti].island).join(', ')}; ` +
    `skip ${skipSetFor(grid, plainCell).size} of ${grid.cells[plainCell].own.length}`);
  // Whether the glow mesh reaches this cell is a packing question, not a rule question: the rays only hit a
  // face if the face's cell is in the reach of the plain cell's point. That changes from bake to bake, so it
  // is reported as drift with numbers, not asserted at tolerance 0. What IS asserted at tolerance 0 is the
  // structure above and the 1e-9 floor on the value the cell holds.
  const glowMetrics = tris.filter((t) => t.island === 'Split_emissive').map((t) => triangleMetrics(t, resolution));
  const plainCellData = grid.cells[plainCell];
  const glowDist = Math.hypot(
    glowMetrics.reduce((s, m) => s + m.cx, 0) / glowMetrics.length - plainCellData.px,
    glowMetrics.reduce((s, m) => s + m.cy, 0) / glowMetrics.length - plainCellData.py,
    glowMetrics.reduce((s, m) => s + m.cz, 0) / glowMetrics.length - plainCellData.pz);
  drift(`test case C in THIS bake: the glow island is in cell #${glowCell} (${grid.cells[glowCell]?.key}), the ` +
    `plain island in cell #${plainCell} (${plainCellData.key}), centroid distance ${glowDist.toFixed(3)} m ` +
    `(maxRayDistance ${DEFAULTS.maxRayDistance}). No ray from the plain point hits a glow face in this pack, ` +
    `so the glow delivers 0 into this cell and the value the cell holds comes from ${[...new Set(seenSplit.map((ti) => tris[ti].island))].join(', ') || 'nothing'}. ` +
    `In the previous bake the same rule delivered, because the packing put the glow island where the rays ` +
    `reach — the rule is the same in both bakes, the packing is not.`);
  const splitOut = new Float64Array(3);
  shIrradiance(grid.sh.subarray(plainCell * 27, plainCell * 27 + 27),
    grid.cells[plainCell].nx, grid.cells[plainCell].ny, grid.cells[plainCell].nz, splitOut);
  measure('value read in the plain mesh cell', `[${[...splitOut].map((v) => v.toFixed(6)).join(', ')}]`);
  ok('that value is above the 1e-9 floor', splitOut.some((v) => v > 1e-9));
  const glowBaked = tris.map((_, i) => i).filter((i) => tris[i].island === 'Split_emissive').map(bakedAt);
  ok('the emissive island itself carries values > 0 (tolerance 0)', glowBaked.every((v) => v.some((c) => c > 0)),
    glowBaked.map((v) => v.map((c) => c.toFixed(4)).join(',')).join(' | '));

  console.log('\n12. the guard: a missing field stops the run (owner decision 2026-11-23, tolerance 0 on the count)');
  // A copy of the REAL gridsource.json in a temp dir, with two fields removed. JSON.stringify writes
  // no key for undefined, so the fields are genuinely absent — the same situation as a file that came
  // from somewhere else. lightmap.bin and manifest.json are copied too, so a PASS would write a file;
  // the check asserts the run stopped before that. The guard is asserted through the tool itself
  // (subprocess), and through the same exported function the tool uses — not a copy of the logic.
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testmap-guard-'));
  const demo = JSON.parse(fs.readFileSync(`${MAP}/gridsource.json`, 'utf8'));
  const dropSlot = panelTris[0], dropMesh = plainRefTris[0];
  demo.tris[dropSlot].materialIndex = undefined;   // two triangles are removed, so exactly 2 must be reported
  demo.tris[dropMesh].mesh = undefined;
  const expected = missingFields(demo.tris);
  fs.writeFileSync(path.join(demoDir, 'gridsource.json'), JSON.stringify(demo));
  fs.copyFileSync(`${MAP}/lightmap.bin`, path.join(demoDir, 'lightmap.bin'));
  fs.copyFileSync(`${MAP}/manifest.json`, path.join(demoDir, 'manifest.json'));
  const guardRun = spawnSync(process.execPath,
    ['--experimental-strip-types', path.resolve('tools/write_lightgrid.mjs'), demoDir], { encoding: 'utf8' });
  measure('guard run on the copy', `exit ${guardRun.status}, dir ${demoDir}`);
  for (const line of (guardRun.stderr || '').trim().split('\n')) console.log(`      ${line}`);
  ok('the guard exits != 0 (tolerance 0)', guardRun.status !== 0, `exit code ${guardRun.status}`);
  // node prints an ExperimentalWarning on stderr, so the reported triangles are taken by their shape
  // (`name #index: missing field`), not by counting lines from the top of stderr.
  const reported = (guardRun.stderr || '').split('\n').map((l) => l.trim()).filter((l) => / #\d+: missing /.test(l));
  const abortLine = (guardRun.stderr || '').split('\n').find((l) => l.includes('ABORT')) || '';
  const expectedLines = expected.map((m) => `${m.name} #${m.index}: missing ${m.fields.join(' + ')}`);
  ok('the message names exactly 2 triangles, name + index (tolerance 0)',
    expected.length === 2 && reported.length === 2 && reported.join(' | ') === expectedLines.join(' | ') &&
      abortLine.includes(`2 of ${demo.tris.length} triangle(s)`),
    `reported "${reported.join(' | ')}" vs measured [${expectedLines.join(' | ')}] (removed: ` +
    `tri#${dropSlot} materialIndex, tri#${dropMesh} mesh); header: ${abortLine}`);
  ok('nothing was written: no lightgrid.bin in the copy dir (tolerance 0)',
    !fs.existsSync(path.join(demoDir, 'lightgrid.bin')), `dir ${demoDir} holds only the copies`);
  ok('manifest.json in the copy dir is byte-identical to the file on disk (tolerance 0)',
    Buffer.compare(fs.readFileSync(path.join(demoDir, 'manifest.json')),
      fs.readFileSync(`${MAP}/manifest.json`)) === 0, 'the guard runs before any write');
  // Control: the same copy WITH the fields back must build the same file. This proves the exit was
  // caused by the missing fields, not by the temp dir or the copies.
  const fixed = JSON.parse(fs.readFileSync(`${MAP}/gridsource.json`, 'utf8'));
  fs.writeFileSync(path.join(demoDir, 'gridsource.json'), JSON.stringify(fixed));
  const controlRun = spawnSync(process.execPath,
    ['--experimental-strip-types', path.resolve('tools/write_lightgrid.mjs'), demoDir], { encoding: 'utf8' });
  ok('the control run (fields present) exits 0 (tolerance 0)', controlRun.status === 0,
    `exit code ${controlRun.status}: ${(controlRun.stdout || '').trim()}`);
  ok('the control run writes the same bytes as the file the game loads (tolerance 0)',
    Buffer.compare(fs.readFileSync(path.join(demoDir, 'lightgrid.bin')),
      fs.readFileSync(`${MAP}/lightgrid.bin`)) === 0,
    `${fs.readFileSync(path.join(demoDir, 'lightgrid.bin')).length} bytes, byte-for-byte`);
  // The names in the message come from the file, not from an assumption: for the triangle whose `mesh`
  // is gone the name is its `island`, and for the other it is the mesh that is still there.
  const nameOf = (i) => expected.find((m) => m.index === i);
  ok('the reported names are read from the file, nothing invented (tolerance 0)',
    nameOf(dropSlot).name === tris[dropSlot].mesh && nameOf(dropMesh).name === tris[dropMesh].island,
    `tri#${dropSlot} still has mesh ${tris[dropSlot].mesh}, tri#${dropMesh} still has island ` +
    `${tris[dropMesh].island} -> names ${nameOf(dropSlot).name}, ${nameOf(dropMesh).name}`);
  fs.rmSync(demoDir, { recursive: true, force: true });

  console.log('\n=== summary ===');
  for (const f of findings) console.log(`  finding: ${f}`);
  for (const d of drifts) console.log(`  drift: ${d}`);
  if (failures.length) {
    console.log(`  failed checks: ${failures.length}`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  console.log('  every measured number is inside the declared tolerance');
  if (findings.length) console.log('  findings are reported with numbers, not tolerated');
  if (drifts.length) console.log(`  ${drifts.length} drift line(s): run-to-run packing differences, ` +
    'reported as measurements, not as a pass or a failure (no tolerance declared for them)');
}

main();
