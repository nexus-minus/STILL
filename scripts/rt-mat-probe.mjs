/**
 * Material-path INVESTIGATION probe — headful Chromium WebGPU.
 *
 *   node scripts/rt-mat-probe.mjs [http://localhost:5187] [phase,...]
 *
 * Answers (before any renderer change):
 *   mats     — dump every scene material (color / roughness / emissive) for
 *              the DEFAULT map and ?testroom: proves how glTF
 *              roughnessFactor/baseColorFactor arrive as three materials.
 *   albedo   — ?testroom: read canvas pixels of the floor / wall / desk,
 *              then mutate the carpet material's color to red at runtime and
 *              re-read. If the floor's pixels turn red, the raster MRT
 *              `diffuse` attachment already reaches the composite
 *              (diffuse × lighting + emissive) — i.e. per-object color works.
 *   emissive — final pixels of an emissive fixture before/after a roughness
 *              mutation on its material (fixture surfaces must not care).
 *
 * Numbers come from CANVAS PIXEL READS inside requestAnimationFrame (the
 * WebGPU canvas only holds a readable frame right after it is rendered).
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5187';
const ONLY = process.argv[3] ? process.argv[3].split(',').map((s) => s.trim()) : null;
const OUT = '/tmp/opencode/rt-mat';
const CHROME = '/usr/bin/chromium';
const XDG = '/tmp/opencode/chromium-xdg-clean';
mkdirSync(OUT, { recursive: true });
mkdirSync(XDG, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  protocolTimeout: 300000,
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,760'],
});

const run = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return;
  await fn();
};

async function boot(url, name) {
  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.clear(); } catch { /* private mode */ }
  });
  // Pin the freeze off. These readback asserts were calibrated on a dispatch EVERY
  // frame; with the idle freeze a static scene stops dispatching after the settle
  // window, so a measurement would describe a settle-window average instead of the
  // converged values the thresholds expect. The material views read here are exempt
  // from the dither by design, so no flag is needed for that. These scripts proof the
  // shader, not the scheduler (docs/render-pipeline.md → "Anti-banding + idle frame").
  const target = `${url}${url.includes('?') ? '&' : '?'}settle=0`;
  console.log(`\n== ${name}: ${target}`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let booted = false;
  for (let i = 0; i < 150 && !booted; i++) {
    booted = await page.evaluate(() => window.__liminalReady === true).catch(() => false);
    if (!booted) await sleep(200);
  }
  if (!booted) { fail(`${name}: never reached __liminalReady`); await page.close(); return null; }
  await page.bringToFront();
  const bootLine = logs.filter((l) => l.includes('[liminal] up')).pop() ?? '';
  console.log(`  boot: ${bootLine.split('\n')[0].slice(0, 140)}`);
  if (bootLine.includes('rt=armed')) ok(`${name}: rt=armed`);
  else fail(`${name}: rt not armed`);
  for (const l of logs.filter((l) => l.startsWith('[liminal][webgpu]'))) fail(`${name}: WebGPU error: ${l.slice(0, 160)}`);
  for (const e of errors) fail(`${name}: pageerror: ${e.slice(0, 160)}`);
  return { page, logs, bootLine };
}

async function hideOverlays(page) {
  await page.evaluate(() => {
    const hide = () => document.getElementById('overlay')?.classList.add('hidden');
    hide();
    const resume = [...document.querySelectorAll('button')].find(
      (b) => /^resume$/i.test((b.textContent ?? '').trim()));
    if (resume && resume.offsetParent !== null) resume.click();
    hide();
  });
}

/** freecam framing (same math as the other rt-* smokes) */
async function frame(page, f) {
  await page.evaluate((fr) => {
    const L = window.__liminal;
    if (!L.controller.freecam) L.controller.toggleFreecam();
    const [px, py, pz] = fr.pos;
    const [tx, ty, tz] = fr.look;
    L.camera.position.set(px, py, pz);
    const dx = tx - px, dy = ty - py, dz = tz - pz;
    L.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
  }, f);
}

/** install frame-timed canvas readback helpers */
async function installRead(page) {
  await page.evaluate(() => {
    const canvas = () => document.querySelector('canvas#game');
    const nextFrame = (fn) => new Promise((res) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; res(null); } }, 3000);
      requestAnimationFrame(() => {
        if (done) return;
        done = true; clearTimeout(t); res(fn());
      });
    });
    /** mean rgb of a canvas-pixel rect (canvas px, read right after a frame) */
    window.__mat = {
      rgb: (x, y, w, h) => nextFrame(() => {
        const c = canvas();
        const t = document.createElement('canvas');
        t.width = c.width; t.height = c.height;
        const g = t.getContext('2d', { willReadFrequently: true });
        g.drawImage(c, 0, 0);
        const d = g.getImageData(Math.round(x), Math.round(y),
          Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
        let r = 0, gg = 0, b = 0;
        const n = d.length / 4;
        for (let i = 0; i < n; i++) { r += d[4 * i]; gg += d[4 * i + 1]; b += d[4 * i + 2]; }
        return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
      }),
      canvas,
    };
  });
}

const fmt = (c) => (c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'null');

// ---------------------------------------------------------------------------
// mats: what materials actually arrive as
// ---------------------------------------------------------------------------
await run('mats', async () => {
  for (const [label, url] of [
    ['map', `${BASE}/`],
    ['testroom', `${BASE}/?testroom`],
  ]) {
    const b = await boot(url, `mats-${label}`);
    if (!b) continue;
    const { page } = b;
    await sleep(800);
    const mats = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      window.__liminal.scene.traverse((o) => {
        if (!o.isMesh) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach((m, i) => {
          if (!m || seen.has(m)) return;
          seen.add(m);
          out.push({
            mesh: o.name || '(unnamed)',
            type: m.type,
            color: m.color ? '#' + m.color.getHexString() : null,
            roughness: m.roughness ?? null,
            metalness: m.metalness ?? null,
            emissive: m.emissive ? '#' + m.emissive.getHexString() : null,
            emissiveIntensity: m.emissiveIntensity ?? null,
            groups: o.geometry?.groups?.length ?? 0,
            multi: Array.isArray(o.material),
            matIndex: i,
          });
        });
      });
      return out;
    });
    for (const m of mats) console.log(`  ${JSON.stringify(m)}`);
    await page.close();
  }
});

// ---------------------------------------------------------------------------
// albedo: do per-material colors reach the composite?
// ---------------------------------------------------------------------------
await run('albedo', async () => {
  const b = await boot(`${BASE}/?testroom`, 'albedo');
  if (!b) return;
  const { page } = b;
  await installRead(page);
  // room A framing: floor + north wall + (later) a red mutation
  const FR = { pos: [0, 1.6, 4.5], look: [0, 1.2, -6] };
  await frame(page, FR);
  await sleep(4000);
  await hideOverlays(page);
  await sleep(400);
  // floor (carpet) vs wall vs pillar regions — canvas px for 1280x720
  const R = {
    floor: [560, 560, 160, 90],
    wall: [560, 120, 160, 90],
    pillar: [120, 300, 80, 120],
  };
  const before = {};
  for (const [k, [x, y, w, h]] of Object.entries(R)) {
    before[k] = await page.evaluate((a) => window.__mat.rgb(...a), [x, y, w, h]);
    console.log(`  before ${k.padEnd(6)} ${fmt(before[k])}`);
  }
  // MUTATION: carpet → pure red. If the composite's albedo path works, the
  // floor pixels must turn red (lighting is yellowish-white, so r >> g,b)
  await page.evaluate(() => {
    const L = window.__liminal;
    L.scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.color && m.color.getHexString() === 'a89a68') m.color.set(0xff0000);
    });
  });
  await sleep(1200);
  await hideOverlays(page);
  const after = {};
  for (const [k, [x, y, w, h]] of Object.entries(R)) {
    after[k] = await page.evaluate((a) => window.__mat.rgb(...a), [x, y, w, h]);
    console.log(`  after  ${k.padEnd(6)} ${fmt(after[k])}`);
  }
  await page.screenshot({ path: `${OUT}/albedo-red-floor.png` });
  const red = after.floor && after.floor[0] > after.floor[1] * 1.5 && after.floor[0] > after.floor[2] * 1.5;
  if (red) ok('floor pixels turned RED after the material color mutation → albedo reaches the composite');
  else fail(`floor did not turn red: before ${fmt(before.floor)} after ${fmt(after.floor)}`);
  const wallStable = after.wall && before.wall
    && Math.abs(after.wall[1] - before.wall[1]) <= 12;
  if (wallStable) ok(`wall pixels stable across the floor mutation (${fmt(before.wall)} → ${fmt(after.wall)})`);
  else console.log(`  note: wall moved ${fmt(before.wall)} → ${fmt(after.wall)} (lighting redist?)`);
  await page.close();
});

// ---------------------------------------------------------------------------
// pair: ?matroom framing screenshot (specular highlight visual check)
// ---------------------------------------------------------------------------
await run('pair', async () => {
  const b = await boot(`${BASE}/?matroom`, 'pair');
  if (!b) return;
  const { page } = b;
  await installRead(page);
  const FR = { pos: [0, 1.5, 17.4], look: [0, 1.2, 21.3] };
  await frame(page, FR);
  await sleep(4500);
  await hideOverlays(page);
  await sleep(400);
  await page.screenshot({ path: `${OUT}/pair-spec-on.png` });
  console.log(`  shot: ${OUT}/pair-spec-on.png`);
  // roughness values actually baked into the BVH attribute
  const baked = await page.evaluate(() => {
    const out = [];
    window.__liminal.scene.traverse((o) => {
      if (!o.isMesh) return;
      const a = o.geometry.getAttribute('roughness');
      if (a) out.push({ name: o.name || '(unnamed)', rough0: +a.getX(0).toFixed(3), count: a.count });
    });
    return out;
  });
  console.log(`  baked roughness: ${JSON.stringify(baked)}`);
  await page.close();
});

await browser.close();
console.log(`\n==== ${failures.length ? `FAILED (${failures.length})` : 'PASS'} — screenshots in ${OUT}/`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = failures.length ? 1 : 0;
