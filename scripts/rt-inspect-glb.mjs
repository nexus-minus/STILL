/**
 * Read-only GLB inspector for the light-nudge work (map-loader.ts):
 * prints mesh/node names, per-primitive POSITION bounding boxes (accessor
 * min/max survive Draco), material emissives — so the outward-direction
 * heuristic can be tuned against the ACTUAL level instead of guesses.
 *
 *   node scripts/rt-inspect-glb.mjs [assets/map/objects.glb]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'assets/map/objects.glb';
const buf = readFileSync(file);
const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) throw new Error('not a GLB');
let off = 12;
let json = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
  off += 8 + len;
}
if (!json) throw new Error('no JSON chunk');

const fmt = (v) => (v ?? []).map((n) => Number(n).toFixed(2)).join('/');
console.log(`== ${file} — ${json.meshes?.length ?? 0} meshes, ${json.nodes?.length ?? 0} nodes, ${json.materials?.length ?? 0} materials`);

(json.materials ?? []).forEach((m, i) => {
  const em = m.emissiveFactor;
  const lit = em && (em[0] > 0 || em[1] > 0 || em[2] > 0);
  if (lit || /L_|light|emit/i.test(m.name ?? '')) {
    console.log(`  mat[${i}] "${m.name}" emissive=${fmt(em)} strength=${m.pbrMetallicRoughness?.emissiveFactor ?? '?'} doubleSided=${m.doubleSided ?? false}`);
  }
});

(json.meshes ?? []).forEach((m, i) => {
  console.log(`  mesh[${i}] "${m.name}" prims=${m.primitives.length}`);
  for (const p of m.primitives) {
    const pos = p.attributes?.POSITION;
    const acc = pos !== undefined ? json.accessors?.[pos] : undefined;
    const draco = p.extensions?.KHR_draco_mesh_compression ? ' [draco]' : '';
    const mat = p.material !== undefined ? json.materials?.[p.material]?.name : undefined;
    const count = acc?.count ?? '?';
    console.log(`    prim mat="${mat ?? 'none'}" verts=${count}${draco} min=${fmt(acc?.min)} max=${fmt(acc?.max)}`);
  }
});

const walk = (n, depth) => {
  const t = n.translation ?? [0, 0, 0];
  const s = n.scale ?? [1, 1, 1];
  // rotation matters for box-surface light sampling: a non-identity quaternion
  // means the world AABB half-extents are NOT the mesh's true half-extents
  const q = n.rotation;
  const rot = q && (Math.abs(q[0]) > 1e-6 || Math.abs(q[1]) > 1e-6 || Math.abs(q[2]) > 1e-6 || Math.abs(q[3] - 1) > 1e-6)
    ? ` q=${fmt(q)}` : ' q=identity';
  const mesh = n.mesh !== undefined ? json.meshes?.[n.mesh]?.name : undefined;
  console.log(`    ${'  '.repeat(depth)}node "${n.name ?? '?'}"${mesh ? ` -> mesh "${mesh}"` : ''} t=${fmt(t)} s=${fmt(s)}${rot}`);
  (n.children ?? []).forEach((c) => walk(json.nodes[c], depth + 1));
};
console.log('== node tree');
(json.scenes?.[json.scene ?? 0]?.nodes ?? []).forEach((c) => walk(json.nodes[c], 0));
