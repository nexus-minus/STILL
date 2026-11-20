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
      // DEAD-LIGHT TEST: the old point path traces ONE shadow ray to the
      // fixture CENTRE. Reproduce it: stand on the floor (or under the
      // ceiling) near the fixture and raycast back at the centre through the
      // shadow soup. blocked = the centre sits inside/behind geometry = the
      // fixture emits NOTHING today. Also probe14 dirs from the centre: if
      // EVERY direction hits within ~0.3m the centre is buried in a slab.
      const DIRS = [
        [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
        [0.707,0,0.707],[-0.707,0,0.707],[0.707,0,-0.707],[-0.707,0,-0.707],
        [0.707,0.707,0],[-0.707,0.707,0],[0.707,-0.707,0],[-0.707,-0.707,0],
      ];
      let clearDirs = 0;
      let minClear = Infinity;
      for (const [x, y, z] of DIRS) {
        const d = probe(c, new THREE.Vector3(x, y, z).normalize(), 3.0);
        if (d >= 1.0) clearDirs++;
        if (d < minClear) minClear = d;
      }
      row.dirsClearOf1m = clearDirs;
      row.minClear = r2(minClear);
      // floor point under the fixture -> ray back to the centre (the NEE ray)
      if (down) {
        const from = down.point.clone().addScaledVector(new THREE.Vector3(0, 1, 0), 0.1);
        const toC = c.clone().sub(from);
        const distC = toC.length();
        toC.normalize();
        row.centerVisibleFromFloor = r2(probe(from, toC, distC)) >= distC - 1e-3;
        row.floorDistToCenter = r2(distC);
      }
      out.rows.push(row);
    }
    return out;
  }, CENTERS);
  // ---- TODAY'S light list + dead-light test --------------------------------
  // Re-runs loadWorld() for the ACTUAL post-nudge positions, then mimics the
  // old point-light NEE against the SHADOW soup (the exact geometry the RT
  // shadow rays use): every triangle centroid within 6m is a receiver; the
  // receiver -> centre shadow ray decides. reachableFraction ~ 0 = the centre
  // is buried and the fixture emits NOTHING today (the sunken emitter).
  const litRows = await page.evaluate(async () => {
    const M = await import('/src/world/map-loader.ts');
    const L = window.__liminal;
    const THREE = L.THREE;
    const world = await M.loadWorld();
    const shadow = [];
    L.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const em = mats.some((m) => m && m.emissive && (m.emissiveIntensity ?? 1) > 0
        && m.emissive.r + m.emissive.g + m.emissive.b > 0.01);
      if (!em) shadow.push(o);
    });
    const tris = M.buildShadowTriangles(shadow);
    // first-hit raycast over the triangle soup (no backface cull — matches
    // probeClearance); returns distance + point + WINDING-oriented normal
    const raycast = (ox, oy, oz, dx, dy, dz, maxD) => {
      let bestT = maxD, bx = 0, by = 0, bz = 0, nx = 0, ny = 0, nz = 0;
      for (let i = 0; i + 8 < tris.length; i += 9) {
        const ax = tris[i], ay = tris[i+1], az = tris[i+2];
        const e1x = tris[i+3]-ax, e1y = tris[i+4]-ay, e1z = tris[i+5]-az;
        const e2x = tris[i+6]-ax, e2y = tris[i+7]-ay, e2z = tris[i+8]-az;
        const hx = dy*e2z - dz*e2y, hy = dz*e2x - dx*e2z, hz = dx*e2y - dy*e2x;
        const det = e1x*hx + e1y*hy + e1z*hz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1/det;
        const sx = ox-ax, sy = oy-ay, sz = oz-az;
        const u = inv*(sx*hx + sy*hy + sz*hz);
        if (u < 0 || u > 1) continue;
        const qx = sy*e1z - sz*e1y, qy = sz*e1x - sx*e1z, qz = sx*e1y - sy*e1x;
        const v = inv*(dx*qx + dy*qy + dz*qz);
        if (v < 0 || u+v > 1) continue;
        const t = inv*(e2x*qx + e2y*qy + e2z*qz);
        if (t > 0.02 && t < bestT) {
          bestT = t; bx = ax + dx*t; by = ay + dy*t; bz = az + dz*t;
          nx = e1y*e2z - e1z*e2y; ny = e1z*e2x - e1x*e2z; nz = e1x*e2y - e1y*e2x;
        }
      }
      if (bestT >= maxD) return null;
      const len = Math.hypot(nx, ny, nz) || 1;
      return { t: bestT, x: bx, y: by, z: bz, nx: nx/len, ny: ny/len, nz: nz/len };
    };
    const r2 = (v) => +v.toFixed(3);
    // independent receivers: every shadow-soup triangle centroid within 6m.
    // Two fractions: reachable = shadow-clear only (two-sided normals — a
    // buried centre blocks EVERY ray regardless of winding = dead light);
    // lit = also requires the winding normal to face the centre.
    const cents = [];
    for (let i = 0; i + 8 < tris.length; i += 9) {
      const ax = tris[i], ay = tris[i+1], az = tris[i+2];
      const e1x = tris[i+3]-ax, e1y = tris[i+4]-ay, e1z = tris[i+5]-az;
      const e2x = tris[i+6]-ax, e2y = tris[i+7]-ay, e2z = tris[i+8]-az;
      let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      cents.push({
        x: (ax + tris[i+3] + tris[i+6]) / 3,
        y: (ay + tris[i+4] + tris[i+7]) / 3,
        z: (az + tris[i+5] + tris[i+8]) / 3,
        nx, ny, nz,
      });
    }
    const out = [];
    const DIRS = [
      [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
      [0.707,0,0.707],[-0.707,0,0.707],[0.707,0,-0.707],[-0.707,0,-0.707],
      [0.707,0.707,0],[-0.707,0.707,0],[0.707,-0.707,0],[-0.707,-0.707,0],
    ];
    // INSIDE/OUTSIDE evidence: shoot the6 axis directions from a point and
    // classify the first hit. From OPEN AIR every hit is ENTRY-like (its
    // outward normal faces back at the point: dot(n, dir) < 0). From INSIDE
    // solid every hit is EXIT-like (you hit the far side: dot(n, dir) > 0).
    // Mixed = ambiguous geometry (corner/edge).
    const insideEvidence = (cx, cy, cz) => {
      const rows = [];
      for (const d of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const hit = raycast(cx, cy, cz, d[0], d[1], d[2], 30);
        rows.push(hit
          ? { t: +hit.t.toFixed(3), exitLike: (hit.nx*d[0] + hit.ny*d[1] + hit.nz*d[2]) > 0 }
          : { t: null, exitLike: null }); // no hit = escaped = open toward that side
      }
      return rows;
    };
    for (const light of world.rtLights) {
      const [cx, cy, cz] = light.position;
      let tested = 0;
      let reach = 0;
      let lit = 0;
      let buried = 0;
      let clear1m = 0;
      for (const d of DIRS) {
        const hit = raycast(cx, cy, cz, d[0], d[1], d[2], 4);
        if (hit && hit.t < 0.5) buried++;
        if (!hit || hit.t >= 1.0) clear1m++;
      }
      for (const t of cents) {
        let tx = cx - t.x, ty = cy - t.y, tz = cz - t.z;
        const dist = Math.hypot(tx, ty, tz);
        if (dist < 0.15 || dist > 6) continue;
        tx /= dist; ty /= dist; tz /= dist;
        // receiver point: offset off the surface TOWARD the light
        const px = t.x + tx * 0.04, py = t.y + ty * 0.04, pz = t.z + tz * 0.04;
        tested++;
        const clear = M.probeClearance(tris, new THREE.Vector3(px, py, pz),
          new THREE.Vector3(tx, ty, tz), dist);
        const shadowed = clear < dist - 0.08 && clear > 0.02;
        if (!shadowed) {
          reach++;
          if (t.nx*tx + t.ny*ty + t.nz*tz > 0) lit++;
        }
      }
      out.push({
        position: light.position.map((v) => +v.toFixed(2)),
        power: +light.power.toFixed(3),
        halfSize: r2(light.halfSize),
        extents: light.extents ?? null,
        orientation: light.orientation ?? null,
        buriedDirs: buried,
        clearDirs1m: clear1m,
        inside6: insideEvidence(cx, cy, cz),
        receivers: tested,
        reachable: reach,
        reachableFraction: tested ? r2(reach / tested) : null,
        lit: lit,
        litFraction: tested ? r2(lit / tested) : null,
      });
    }
    // pre-nudge centre of fixture "light" for comparison (the nudge moved it
    // 0.27m down — is the ORIGINAL centre inside solid too?)
    out.push({
      position: [0.93, 0.15, 3.13],
      label: 'light PRE-nudge (nolightnudge position)',
      inside6: insideEvidence(0.93, 0.15, 3.13),
      buriedDirs: null,
      clearDirs1m: null,
      receivers: null,
      reachableFraction: null,
      litFraction: null,
    });

    // ---- replicate main.ts's SECOND nudge pass (analytic light placement,
    // src/main.ts lines ~154-186 — not owned by this session): it re-runs on
    // world.rtLights with halfSize-based probes and REPLACES light.position.
    // Which lights does it move under the new one-light-per-fixture data?
    const DIRS14 = [
      [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
      [0.707,0,0.707],[-0.707,0,0.707],[0.707,0,-0.707],[-0.707,0,-0.707],
      [0.707,0.707,0],[-0.707,0.707,0],[0.707,-0.707,0],[-0.707,-0.707,0],
    ];
    const mainPass = [];
    world.rtLights.forEach((light, idx) => {
      const center = new THREE.Vector3(...light.position);
      let blocked = 0;
      let bestDir = null;
      let bestClear = 0.6;
      for (const [x, y, z] of DIRS14) {
        const dir = new THREE.Vector3(x, y, z).normalize();
        const origin = center.clone().addScaledVector(dir, light.halfSize + 0.05);
        const hit = L.collision.raycast(origin, dir, 6);
        const clear = hit ? hit.distance : 6;
        if (clear < 0.8) blocked++;
        if (clear > bestClear) { bestClear = clear; bestDir = dir; }
      }
      const wouldMove = blocked >= 3 && bestDir;
      mainPass.push({
        idx,
        from: light.position.map((v) => +v.toFixed(2)),
        halfSize: +light.halfSize.toFixed(3),
        blocked,
        bestClear: +bestClear.toFixed(2),
        to: wouldMove
          ? center.clone().addScaledVector(bestDir, light.halfSize + 0.1).toArray().map((v) => +v.toFixed(2))
          : null,
      });
    });
    console.log('== main.ts analytic-placement pass (predicted) on the new light list');
    console.log(JSON.stringify(mainPass, null, 1));
    out.push({ label: 'main.ts analytic pass (predicted)', mainPass });

    return out;
  });
  console.log('== today lights (post-nudge) + NEE litFraction from real receivers');
  console.log(JSON.stringify(litRows, null, 1));

  console.log(JSON.stringify(rows, null, 1));
  if (errors.length) console.log('PAGEERRORS:', errors);
} finally {
  await browser.close();
}
