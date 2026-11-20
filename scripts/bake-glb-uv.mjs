/**
 * Lightmap glb check: parse a .glb's JSON chunk (same header walk as
 * export_map.py glb_json) and verify every mesh primitive carries
 * TEXCOORD_0 (the authoring UV — must still be there) and TEXCOORD_1
 * (the lightmap layer the renderer samples).
 *
 *   node scripts/bake-glb-uv.mjs [path/to/objects.glb]
 *   (default assets/map/objects.glb)
 *
 * Exits 1 if TEXCOORD_0 or TEXCOORD_1 is missing anywhere.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'assets/map/objects.glb';
const buf = readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) {
  console.error(`error: not a GLB: ${file}`);
  process.exit(1);
}
let off = 12;
let json = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
  off += 8 + len;
}
if (!json) {
  console.error('error: no JSON chunk');
  process.exit(1);
}

const accessor = (idx) => (idx === undefined ? undefined : json.accessors?.[idx]);
const fmtRange = (acc) => {
  if (!acc || !acc.min || !acc.max) return '';
  return ` min[${acc.min.map((n) => Number(n).toFixed(3)).join(',')}]` +
    ` max[${acc.max.map((n) => Number(n).toFixed(3)).join(',')}]`;
};

const meshes = json.meshes ?? [];
let prims = 0;
let bad = 0;
console.log(`== ${file} — ${meshes.length} meshes, ${json.nodes?.length ?? 0} nodes`);
for (const m of meshes) {
  for (const p of m.primitives ?? []) {
    prims++;
    const attrs = p.attributes ?? {};
    const has0 = 'TEXCOORD_0' in attrs;
    const has1 = 'TEXCOORD_1' in attrs;
    const draco = p.extensions?.KHR_draco_mesh_compression ? ' [draco]' : '';
    if (!has0 || !has1) bad++;
    const t0 = accessor(attrs.TEXCOORD_0);
    const t1 = accessor(attrs.TEXCOORD_1);
    console.log(`  mesh "${m.name}"${draco}: ` +
      `TEXCOORD_0 ${has0 ? 'yes' : 'MISSING'}${fmtRange(t0)}  ` +
      `TEXCOORD_1 ${has1 ? 'yes' : 'MISSING'}${fmtRange(t1)}`);
  }
}
if (prims === 0) {
  console.log('  no mesh primitives in file — nothing to check');
  process.exit(1);
}
if (bad > 0) {
  console.log(`verdict: FAIL — ${bad}/${prims} primitives missing a UV set (lightmap contract broken)`);
  process.exit(1);
}
console.log(`verdict: OK — TEXCOORD_0 + TEXCOORD_1 on all ${prims} primitive(s)`);
