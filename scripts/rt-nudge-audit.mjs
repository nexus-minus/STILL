/**
 * Nudge audit: for EVERY fixture centre (before-nudge coordinates from the
 * [map] logs) re-runs the map-loader probes against the live scene geometry
 * and prints the evidence — nearest face, probes toward/away from it, floor
 * and ceiling found by the collision BVH (with normals) — so a human can
 * confirm each moved / not-moved decision was the right side of the wall.
 *
 *   node scripts/rt-nudge-audit.mjs [http://localhost:5177]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5177';
const XDG = '/tmp/opencode/chromium-xdg-clean';
mkdirSync(XDG, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// before-nudge centres straight from the [map] log lines
const CENTERS = [
  ['light', [0.93, 0.15, 3.13]],
  ['light001', [-12.21, -2.02, -51.24]],
  ['light002', [8.67, 5.15, -67.55]],
  ['light003', [-0.31, -6.06, -12.58]],
];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: false,
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?rtdebug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(() => window.__liminalReady === true).catch(() => false)) break;
    await sleep(200);
  }
  const rows = await page.evaluate(async (centers) => {
    const M = await import('/src/world/map-loader.ts');
    const L = window.__liminal;
    const THREE = L.THREE;
    // rebuild the shadow soup exactly like the loader does (non-emissive meshes)
    const shadow = [];
    L.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const emissive = mats.some((m) => m && m.emissive && (m.emissiveIntensity ?? 1) > 0
        && m.emissive.r + m.emissive.g + m.emissive.b > 0.01);
      if (!emissive) shadow.push(o);
    });
    const tris = M.buildShadowTriangles(shadow);
    const r2 = (v) => +v.toFixed(3);
    const probe = (o, d, cap) => r2(M.probeClearance(tris, o, d, cap));
    const out = { triCount: tris.length / 9, shadowMeshes: shadow.map((m) => m.name), rows: [] };
    for (const [name, xyz] of centers) {
      const c = new THREE.Vector3(...xyz);
      const nf = M.nearestFace(tris, c);
      const dir = nf ? nf.normal.clone() : null;
      const row = { name, center: xyz, faceDist: nf && r2(nf.dist), faceNormal: dir && [r2(dir.x), r2(dir.y), r2(dir.z)] };
      if (dir) {
        // outward probe (the loader's gate) + the opposite side + clearances
        // measured from the landing point — room side should stay open longer
        const ahead = c.clone().addScaledVector(dir, 0.27);
        const behind = c.clone().addScaledVector(dir, -0.27);
        row.probeOutward = probe(c, dir, 2.0);
        row.probeBack = probe(c, dir.clone().negate(), 2.0);
        row.clearAheadFromLanding = probe(ahead, dir, 3.0);
        row.clearBehindFromLanding = probe(behind, dir.clone().negate(), 3.0);
      }
      // floor/ceiling around the fixture (collision BVH, walkable normals)
      const down = L.collision.raycast(c, new THREE.Vector3(0, -1, 0), 30);
      const up = L.collision.raycast(c, new THREE.Vector3(0, 1, 0), 30);
      row.floor = down ? { y: r2(down.point.y), n: down.face ? [r2(down.face.normal.x), r2(down.face.normal.y), r2(down.face.normal.z)] : null } : null;
      row.ceiling = up ? { y: r2(up.point.y), n: up.face ? [r2(up.face.normal.x), r2(up.face.normal.y), r2(up.face.normal.z)] : null } : null;
      out.rows.push(row);
    }
    return out;
  }, CENTERS);
  console.log(JSON.stringify(rows, null, 1));
  if (errors.length) console.log('PAGEERRORS:', errors);
} finally {
  await browser.close();
}
