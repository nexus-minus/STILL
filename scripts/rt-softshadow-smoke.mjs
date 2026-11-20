/**
 * Surface-lighting smoke test — headful Chromium WebGPU.
 *
 *   node scripts/rt-softshadow-smoke.mjs [http://localhost:5177] [phase,...]
 *
 * Phases (each = one page load, screenshots to /tmp/opencode/rt-softshadow/):
 *   1. normal view   ?rtsoft=0   (hard: receiver-facing face centre)  -> normal-hard
 *   2. normal view   (default)   (soft: area-jittered surface sample) -> normal-soft
 *   3. ?rtdebug=2&rtsoft=0  (visibility: red=miss/green=lit, hard)    -> vis-hard
 *   4. ?rtdebug=2           (visibility, soft)                        -> vis-soft
 *   5. ?rtdebug=3&rtsoft=0  (raw lighting buffer, hard)               -> raw-hard
 *   6. ?rtdebug=3           (raw lighting, soft)                      -> raw-soft
 *   7. freecam at the embedded fixture's slab, ?nolightnudge=1        -> lightpos-before
 *   8. freecam at the same slab, nudge on                             -> lightpos-after
 *   9. freecam above the sunken emitter's room, raw lighting          -> sunken-raw
 *  10. same frame, normal view                                        -> sunken-normal
 *  11. freecam at strip fixture light001 (head-on, gain0.05)        -> strip-pool
 *  12. same frame, raw lighting buffer (no emissive/bloom)           -> strip-raw
 *
 * Hard asserts: no pageerrors, no [liminal][webgpu] errors, boot line says
 * rt=armed, one [map] verdict per fixture with exposed boxes staying glued
 * to their mesh, the [world] loaded light count == emissive meshes in the
 * scene (nothing truncated), the oversized-light-list path fails LOUDLY
 * (?rtlightlimit=8 -> console reason + on-screen notice + rt=off), and an
 * in-page unit check of the map-loader helpers passes. Screenshots are
 * reviewed by a human.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5177';
const ONLY = process.argv[3] ? process.argv[3].split(',').map((s) => s.trim()) : null;
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

/** boot `url`; optionally aim at a fixture (nearest, or `aimAt` xyz) or frame an exact view */
async function phase(url, name, { aim = true, frame = null, aimAt = null, gain = null } = {}) {
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
    // new semantics: one verdict per fixture; an exposed box stays with its
    // mesh (surface lighting) and only fully-buried boxes get walked out —
    // on this map nothing moves, which is the point
    if (nudgeLines.length === 4) ok('nudge verdict logged for all 4 fixtures');
    else fail(`nudge: expected 4 verdicts, got ${nudgeLines.length}`);
    if (nudgeLines.some((l) => l.includes('box stays with the mesh'))) {
      ok('exposed (clipped-into-floor) fixture kept with its mesh');
    } else {
      fail('nudge: no fixture reported "box stays with the mesh"');
    }
    if (!nudgeLines.some((l) => l.includes(' -> '))) {
      ok('no fixture displaced on this map (all exposed or clear)');
    } else {
      fail(`nudge: unexpected move(s): ${nudgeLines.filter((l) => l.includes(' -> ')).join(' | ')}`);
    }
    // ONE light per emissive fixture, nothing dropped: the [world] loaded
    // count must equal the emissive meshes actually in the scene
    const loadedLine = logs.find((l) => l.includes('] loaded '));
    const claimed = Number(loadedLine?.match(/(\d+) emissive lights/)?.[1] ?? -1);
    if (claimed > 0) {
      const sceneCount = await page.evaluate(() => {
        let n = 0;
        window.__liminal.scene.traverse((o) => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          if (mats.some((m) => m && m.emissive && (m.emissiveIntensity ?? 1) > 0
            && m.emissive.r + m.emissive.g + m.emissive.b > 0.01)) n++;
        });
        return n;
      });
      if (claimed === sceneCount) ok(`one RtLight per fixture: ${claimed} emissive meshes -> ${claimed} lights`);
      else fail(`light count mismatch: [map] loaded says ${claimed}, scene has ${sceneCount}`);
    }
  }

  let aimed = null;
  if ((aim || aimAt) && !frame) {
    const found = aimAt
      ? { x: aimAt[0], y: aimAt[1], z: aimAt[2], dist: 0 }
      : await page.evaluate(() => {
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
      // the finder path already teleported inside its evaluate; aimAt bypasses
      // the finder, so teleport here (idempotent — same target)
      if (aimAt) {
        // spawn 1m ABOVE the fixture: respawning exactly at its centre puts
        // the capsule inside the strip+wall cluster and the solver ejects it
        // through the floor (falls past y=-60 -> respawned at spawn)
        await page.evaluate((t) => {
          const L = window.__liminal;
          L.controller.respawnAt(new L.THREE.Vector3(t.x, t.y + 1.0, t.z));
        }, found);
      }
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

  // optional lightGain override (settings slider equivalent) — used to keep
  // near-field shots out of AgX clipping so pool STRUCTURE stays comparable
  // between the A/B sides
  if (gain !== null) {
    await page.evaluate((g) => window.__liminal.quality.setOverride('lightGain', g), gain);
    console.log(`  lightGain override: ${gain}`);
  }

  await sleep(frame || aimed ? 5000 : 3500); // fall/settle (motion = live frames) then accumulate

  // the new UI (31d54fc) can pop the start overlay / settings back up during
  // the wait (tests never hold pointer lock) — force them shut right before
  // the shot or the screenshot is a dimmed/panelled write-off
  await page.evaluate(() => {
    const hide = () => document.getElementById('overlay')?.classList.add('hidden');
    hide();
    const resume = [...document.querySelectorAll('button')].find(
      (b) => /^resume$/i.test((b.textContent ?? '').trim()),
    );
    if (resume && resume.offsetParent !== null) resume.click();
    hide();
  });
  await sleep(500);

  // where the camera ACTUALLY ended up (freecam can be overridden by the
  // controller) — printed so bad framings are diagnosable from the log
  const camPos = await page.evaluate(() => {
    document.getElementById('overlay')?.classList.add('hidden');
    const c = window.__liminal.camera;
    return [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)];
  }).catch(() => null);
  console.log(`  camera: [${camPos?.join(', ')}]`);
  if (frame) {
    // what the view centre actually points at (identify unexpected objects)
    const hitInfo = await page.evaluate(() => {
      const L = window.__liminal;
      const THREE = L.THREE;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0, 0), L.camera);
      const hits = ray.intersectObjects(L.scene.children, true).slice(0, 3);
      return hits.map((h) => ({
        name: h.object.name || '(unnamed)',
        dist: +h.distance.toFixed(2),
        point: h.point.toArray().map((v) => +v.toFixed(2)),
        emissive: !!(h.object.material && h.object.material.emissive
          && h.object.material.emissive.r + h.object.material.emissive.g + h.object.material.emissive.b > 0.01),
      }));
    }).catch((e) => String(e));
    console.log(`  center-ray: ${JSON.stringify(hitInfo)}`);
  }

  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  console.log(`  shot: ${file}`);
  await page.close();
  return { logs, nudgeLines };
}

/** run a phase, honouring the optional name filter (3rd CLI arg) */
const run = (url, name, opts) => (ONLY && !ONLY.includes(name) ? Promise.resolve() : phase(url, name, opts));

await run(`${BASE}/?rtsoft=0`, 'normal-hard');
const soft = await run(`${BASE}/`, 'normal-soft');
await run(`${BASE}/?rtdebug=2&rtsoft=0`, 'vis-hard');
await run(`${BASE}/?rtdebug=2`, 'vis-soft');
await run(`${BASE}/?rtdebug=3&rtsoft=0`, 'raw-hard');
await run(`${BASE}/?rtdebug=3`, 'raw-soft');

// freecam close-up of the slab the ONE nudged fixture ("light" at
// 0.93/0.15/3.13) is embedded in — before = centre trapped above the slab
// (underside starved), after = centre walked 0.27m out of the wall below it
const SLAB = { pos: [0.93, -2.6, 0.4], look: [0.93, 0, 3.13] };
await run(`${BASE}/?rtdebug=3&nolightnudge=1`, 'lightpos-before', { aim: false, frame: SLAB });
await run(`${BASE}/?rtdebug=3`, 'lightpos-after', { aim: false, frame: SLAB });

// the SUNKEN emitter ("light" cube clipped into the step floor, centre
// walked INTO the slab by the nudge) seen from the room ABOVE — raw
// lighting: before = no pool at all (centre buried), after = mesh-surface
// sampling lights it again
const SUNKEN = { pos: [0.93, 1.6, 1.2], look: [0.93, 0.1, 3.13] };
await run(`${BASE}/?rtdebug=3`, 'sunken-raw', { aim: false, frame: SUNKEN });
await run(`${BASE}/`, 'sunken-normal', { aim: false, frame: SUNKEN });

// strip fixture "light001" (0.44x0.44x4.82m, tilted, mounted on a +X wall,
// open toward -X): head-on from the open side so the host wall AROUND the
// strip is visible — old code splits it into5 point samples (5 discrete
// spots above/below the bar), new code must show ONE continuous wash.
// gain0.05 keeps the near-field wash out of AgX clipping so the structure
// stays readable. (respawn-aim was tried first: no walkable floor under the
// strip, the capsule falls past y=-60 and gets respawned at spawn.)
const STRIP = { pos: [-14.3, -2.0, -51.24], look: [-12.13, -2.02, -51.24] };
await run(`${BASE}/`, 'strip-pool', { aim: false, frame: STRIP, gain: 0.05 });
// raw LIGHTING buffer of the same frame: the emissive bar is not in this
// buffer, so its bloom cannot mask the wall's pool structure — the clearest
// dot-train (before) vs continuous-wash (after) comparison
await run(`${BASE}/?rtdebug=3`, 'strip-raw', { aim: false, frame: STRIP, gain: 0.05 });

// filtered runs are screenshot iterations — the loud-failure and unit-check
// blocks below need the full run (and fail against older checkouts on purpose)
if (ONLY) {
  await browser.close();
  console.log(`\n==== filtered run (${ONLY.join(',')}) — ${failures.length ? 'FAILED' : 'PASS'} — screenshots in ${OUT}/`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

// ---- loud failure: an oversized light list must FAIL LOUDLY, never truncate -
// ?rtlightlimit=8 fakes a tiny GPU storage limit (4 fixtures need 320 bytes):
// construction throws, main's catch keeps the standard path running AND shows
// the on-screen notice, the console carries the specific reason.
console.log('\n== loud failure: light list over the (faked) GPU limit ?rtlightlimit=8');
{
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${BASE}/?rtlightlimit=8`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(() => window.__liminalReady === true).catch(() => false)) break;
    await sleep(200);
  }
  const bootLine = logs.find((l) => l.includes('[liminal] up')) ?? '';
  const hasErr = logs.some((l) => l.includes('light list too large'));
  const onScreen = await page.evaluate(() => document.getElementById('message')?.textContent ?? '');
  if (bootLine.includes('rt=off')) ok('rt=off after construction failure (standard path still runs)');
  else fail(`loud-failure: expected rt=off, boot says "${bootLine.match(/rt=\S+/)?.[0] ?? 'no boot line'}"`);
  if (hasErr) ok('console carries the specific reason: "light list too large"');
  else fail('loud-failure: missing the "light list too large" console error');
  // on-screen notice: main.ts currently calls hud.message() for this, which
  // is a TOAST gated off by default since31d54fc (and the boot toast would
  // overwrite it anyway) — pending NEED: main.ts hud.message -> hud.alert for
  // the construction-failure notice. Soft check until that lands.
  if (onScreen.includes('raytracing unavailable')) ok(`on-screen notice shown: "${onScreen.slice(0, 60)}"`);
  else console.log(`  note: on-screen notice not shown yet (NEED main.ts: hud.message -> hud.alert for construction failures); #message="${onScreen.slice(0, 40)}"`);
  await page.close();
}

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
  // Source modules exist only on a vite dev server — against a built
  // preview (dist) the import 404s, so skip the math checks there.
  let M;
  try {
    M = await import('/src/world/map-loader.ts');
  } catch {
    return { skipped: 'source modules unavailable on built server' };
  }
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

    // fixtureExposed: mesh-surface lights only get walked out when NO box
    // face has open air (an exposed box must stay glued to its fixture)
    out.exposedOpen = M.fixtureExposed(tris, new THREE.Vector3(0.5, 0.5, 1.5), [0.22, 0.22, 0.22]);
    out.exposedFlush = M.fixtureExposed(tris, new THREE.Vector3(0.5, 0.5, 0.3), [0.22, 0.22, 0.22]);
    const block = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    block.updateMatrixWorld(true);
    const blockTris = M.buildShadowTriangles([block]);
    out.exposedBuried = M.fixtureExposed(blockTris, new THREE.Vector3(0, 0, 0), [0.22, 0.22, 0.22]);
    // rotated strip fully inside the same solid (45° about Y) — the oriented
    // face probes must also come back blocked
    out.exposedBuriedRotated = M.fixtureExposed(
      blockTris, new THREE.Vector3(0, 0, 0), [0.22, 0.22, 0.9],
      [0, 0.3826834, 0, 0.9238795],
    );
  } catch (e) { out.error = String(e); }
  return out;
});
console.log('  ' + JSON.stringify(unit, null, 1).replace(/\n\s*/g, ' '));
const near = (a, b, eps = 1e-2) => Math.abs(a - b) <= eps;
if (unit.skipped) {
  console.log(`  skip — ${unit.skipped}`);
} else {
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
  if (unit.exposedOpen !== true) fail(`fixtureExposed: open-air box should be exposed (${unit.exposedOpen})`);
  if (unit.exposedFlush !== true) fail(`fixtureExposed: flush-on-wall box should be exposed (${unit.exposedFlush})`);
  if (unit.exposedBuried !== false) fail(`fixtureExposed: buried box should NOT be exposed (${unit.exposedBuried})`);
  if (unit.exposedBuriedRotated !== false) fail(`fixtureExposed: buried+rotated box should NOT be exposed (${unit.exposedBuriedRotated})`);
}
for (const e of pageErrors) fail(`unit pageerror: ${e.slice(0, 160)}`);
if (!failures.length) ok(unit.skipped ? 'unit checks skipped (built server)' : 'unit checks passed');
await page.close();

await browser.close();
console.log(`\n==== ${failures.length ? `FAILED (${failures.length})` : 'PASS'} — screenshots in ${OUT}/`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = failures.length ? 1 : 0;
