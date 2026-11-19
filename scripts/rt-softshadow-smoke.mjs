/**
 * Soft-shadow + embedded-light-nudge smoke test — headful Chromium WebGPU.
 *
 *   node scripts/rt-softshadow-smoke.mjs [http://localhost:5177]
 *
 * Phases (each = one page load, screenshots to /tmp/opencode/rt-softshadow/):
 *   1. normal view   ?rtsoft=0   (legacy hard single-tap shadows)   -> before-normal
 *   2. normal view   (default)   (soft 3-tap shadows)               -> after-normal
 *   3. ?rtdebug=2&rtsoft=0  (visibility: red=miss/green=lit, hard)  -> before-vis
 *   4. ?rtdebug=2           (visibility, soft)                      -> after-vis
 *   5. ?rtdebug=3&rtsoft=0  (raw lighting buffer, hard)             -> before-raw
 *   6. ?rtdebug=3           (raw lighting, soft)                    -> after-raw
 *   7. freecam at the nudged fixture's slab, ?nolightnudge=1        -> lightpos-before
 *   8. freecam at the same slab, nudge on                           -> lightpos-after
 *
 * Hard asserts: no pageerrors, no [liminal][webgpu] errors, boot line says
 * rt=armed, [map] light-nudge lines exist, an in-page unit check of the
 * map-loader nudge math passes. Screenshots are reviewed by a human.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5177';
const OUT = '/tmp/opencode/rt-softshadow';
const CHROME = '/usr/bin/chromium';
const XDG = '/tmp/opencode/chromium-xdg-clean';
mkdirSync(OUT, { recursive: true });
mkdirSync(XDG, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,760'],
});

/** boot `url`; optionally aim at the nearest fixture or frame an exact view */
async function phase(url, name, { aim = true, frame = null } = {}) {
  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.clear(); } catch { /* private mode */ }
  });
  console.log(`\n== ${name}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  let booted = false;
  for (let i = 0; i < 150 && !booted; i++) {
    booted = await page.evaluate(() => window.__liminalReady === true).catch(() => false);
    if (!booted) await sleep(200);
  }
  if (!booted) { fail(`${name}: game never reached __liminalReady`); await page.close(); return null; }

  const bootLine = logs.find((l) => l.includes('[liminal] up')) ?? '';
  console.log(`  boot: ${bootLine.split('\n')[0].slice(0, 140)}`);
  // title overlay sits on top of the canvas — dismiss it (nothing re-shows it
  // while we hold no pointer lock / settings session)
  await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
  if (bootLine.includes('rt=armed')) ok(`${name}: rt=armed`);
  else fail(`${name}: rt not armed — backend fell back (${bootLine.match(/rt=\S+/)?.[0] ?? 'no boot line'})`);
  for (const l of logs.filter((l) => l.startsWith('[liminal][webgpu]'))) fail(`${name}: WebGPU error: ${l.slice(0, 160)}`);
  for (const e of errors) fail(`${name}: pageerror: ${e.slice(0, 160)}`);

  const nudgeLines = logs.filter((l) => l.startsWith('[map] light "'));
  if (nudgeLines.length && name === 'normal-hard') {
    for (const l of nudgeLines) console.log(`  ${l}`);
    if (nudgeLines.some((l) => l.includes(' -> '))) ok(`nudge moved ${nudgeLines.filter((l) => l.includes(' -> ')).length}/${nudgeLines.length} fixtures out of walls`);
    else fail('nudge: no fixture was moved (all reported clear/failed)');
  }

  let aimed = null;
  if (aim && !frame) {
    const found = await page.evaluate(() => {
      const L = window.__liminal;
      if (!L) return null;
      let target = null;
      let bestD = Infinity;
      L.scene.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const lit = mats.some((m) => m && m.emissive && (m.emissiveIntensity ?? 1) > 0
          && m.emissive.r + m.emissive.g + m.emissive.b > 0.01);
        if (!lit) return;
        const p = new L.THREE.Vector3();
        o.getWorldPosition(p);
        const d = p.distanceTo(L.camera.position);
        if (d < bestD) { bestD = d; target = p.clone(); }
      });
      if (!target) return null;
      // stand AT the fixture (physics settles us onto the floor below/pushes us
      // out of the wall), then look straight at it — closest view of its spill
      L.controller.respawnAt(new L.THREE.Vector3(target.x, target.y, target.z));
      return { x: +target.x.toFixed(2), y: +target.y.toFixed(2), z: +target.z.toFixed(2), dist: +bestD.toFixed(2) };
    });
    if (found) {
      await sleep(700); // let the teleport land and the camera sync to it
      aimed = await page.evaluate((t) => {
        const L = window.__liminal;
        const c = L.camera;
        const dx = t.x - c.position.x;
        const dy = t.y - c.position.y;
        const dz = t.z - c.position.z;
        L.controller.yaw = Math.atan2(-dx, -dz);
        L.controller.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        return t;
      }, found);
      console.log(`  aim: fixture ${JSON.stringify(aimed)} — waiting for settle + accumulation`);
    } else {
      console.log('  aim: no emissive mesh found (spawning view)');
    }
  }

  if (frame) {
    // freecam WITHOUT pointer lock: controller.update() early-returns when
    // freecam && !locked, so the camera transform set here is never overwritten
    await page.evaluate((f) => {
      const L = window.__liminal;
      if (!L.controller.freecam) L.controller.toggleFreecam();
      const [px, py, pz] = f.pos;
      const [tx, ty, tz] = f.look;
      L.camera.position.set(px, py, pz);
      const dx = tx - px;
      const dy = ty - py;
      const dz = tz - pz;
      L.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
    }, frame);
    console.log(`  frame: ${JSON.stringify(frame)}`);
  }

  await sleep(frame || aimed ? 5000 : 3500); // fall/settle (motion = live frames) then accumulate

  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  console.log(`  shot: ${file}`);
  await page.close();
  return { logs, nudgeLines };
}

const hard = await phase(`${BASE}/?rtsoft=0`, 'normal-hard');
const soft = await phase(`${BASE}/`, 'normal-soft');
await phase(`${BASE}/?rtdebug=2&rtsoft=0`, 'vis-hard');
await phase(`${BASE}/?rtdebug=2`, 'vis-soft');
await phase(`${BASE}/?rtdebug=3&rtsoft=0`, 'raw-hard');
await phase(`${BASE}/?rtdebug=3`, 'raw-soft');

// freecam close-up of the slab the ONE nudged fixture ("light" at
// 0.93/0.15/3.13) is embedded in — before = centre trapped above the slab
// (underside starved), after = centre walked 0.27m out of the wall below it
const SLAB = { pos: [0.93, -2.6, 0.4], look: [0.93, 0, 3.13] };
await phase(`${BASE}/?rtdebug=3&nolightnudge=1`, 'lightpos-before', { aim: false, frame: SLAB });
await phase(`${BASE}/?rtdebug=3`, 'lightpos-after', { aim: false, frame: SLAB });

// ---- in-page unit check of the nudge math (pure map-loader helpers) ----------
console.log('\n== unit check: map-loader nudge helpers (synthetic wall)');
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`${BASE}/?rtdebug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
for (let i = 0; i < 150; i++) {
  if (await page.evaluate(() => window.__liminalReady === true).catch(() => false)) break;
  await sleep(200);
}
const unit = await page.evaluate(async () => {
  const M = await import('/src/world/map-loader.ts');
  const THREE = window.__liminal.THREE;
  const out = {};
  try {
    // 6x6 wall in the XY plane at z=0, wound CCW seen from +z (room side)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -3, -3, 0, 3, -3, 0, 3, 3, 0,
      -3, -3, 0, 3, 3, 0, -3, 3, 0,
    ], 3));
    const wall = new THREE.Mesh(g);
    wall.updateMatrixWorld(true);
    const tris = M.buildShadowTriangles([wall]);
    out.triFloats = tris.length; // 2 tris * 9
    const bounds = new THREE.Box3(new THREE.Vector3(-4, -4, -4), new THREE.Vector3(4, 4, 4));

    // probe: both-face raycast must see the wall from EITHER side
    out.probeFromBehind = M.probeClearance(tris, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), 5);
    out.probeFromFront = M.probeClearance(tris, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), 5);
    out.probeOpen = M.probeClearance(tris, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), 5);

    // nearest face from behind the wall: distance 0.15, normal into the room (+z)
    const nf = M.nearestFace(tris, new THREE.Vector3(0.5, 0.5, -0.15));
    out.faceDist = nf && +nf.dist.toFixed(3);
    out.faceNormal = nf && [nf.normal.x, nf.normal.y, nf.normal.z].map((v) => +v.toFixed(3));

    // embedded centre (0.15 behind the surface) must walk out by >= one step
    const step = 0.27;
    const moved = M.nudgeEmbeddedLight(tris, bounds, new THREE.Vector3(0.5, 0.5, -0.15), step);
    out.moved = {
      status: moved.status,
      offset: moved.offset && [moved.offset.x, moved.offset.y, moved.offset.z].map((v) => +v.toFixed(3)),
      embed: +moved.embed.toFixed(3),
    };
    // open centre (1.5 into the room) must be left alone
    const clear = M.nudgeEmbeddedLight(tris, bounds, new THREE.Vector3(0.5, 0.5, 1.5), step);
    out.clear = { status: clear.status, offset: clear.offset };
    // no geometry at all -> nothing to nudge out of
    const empty = M.nudgeEmbeddedLight(new Float32Array(0), bounds, new THREE.Vector3(0, 0, 0), step);
    out.empty = { status: empty.status, offset: empty.offset };
    // authored cone direction wins over the face normal
    const cone = M.nudgeEmbeddedLight(tris, bounds, new THREE.Vector3(0.5, 0.5, -0.15), step, [0, 0, 1]);
    out.cone = { status: cone.status, dir: [cone.dir.x, cone.dir.y, cone.dir.z] };
  } catch (e) { out.error = String(e); }
  return out;
});
console.log('  ' + JSON.stringify(unit, null, 1).replace(/\n\s*/g, ' '));
const near = (a, b, eps = 1e-2) => Math.abs(a - b) <= eps;
if (unit.error) fail(`unit: threw ${unit.error}`);
if (unit.triFloats !== 18) fail(`unit: expected 18 floats (2 tris), got ${unit.triFloats}`);
if (!(near(unit.probeFromBehind, 1) && near(unit.probeFromFront, 1))) fail(`unit: both-face probe wrong (behind=${unit.probeFromBehind} front=${unit.probeFromFront})`);
if (!near(unit.probeOpen, 5)) fail(`unit: open probe wrong (${unit.probeOpen})`);
if (!near(unit.faceDist, 0.15) || !near(unit.faceNormal?.[2] ?? 0, 1)) fail(`unit: nearestFace wrong (dist=${unit.faceDist} n=${unit.faceNormal})`);
if (unit.moved?.status !== 'moved' || !(unit.moved?.offset?.[2] >= 0.27 - 1e-6)) fail(`unit: embedded centre not walked out (${JSON.stringify(unit.moved)})`);
if (unit.moved && unit.moved.embed > 0.16) fail(`unit: embed too large (${unit.moved.embed})`);
if (unit.clear?.status !== 'clear' || unit.clear?.offset !== null) fail(`unit: open centre should stay (${JSON.stringify(unit.clear)})`);
if (unit.empty?.status !== 'clear') fail(`unit: empty geometry case (${JSON.stringify(unit.empty)})`);
if (unit.cone?.status !== 'moved') fail(`unit: authored direction ignored (${JSON.stringify(unit.cone)})`);
for (const e of pageErrors) fail(`unit pageerror: ${e.slice(0, 160)}`);
if (!failures.length) ok('unit checks passed');
await page.close();

await browser.close();
console.log(`\n==== ${failures.length ? `FAILED (${failures.length})` : 'PASS'} — screenshots in ${OUT}/`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = failures.length ? 1 : 0;
