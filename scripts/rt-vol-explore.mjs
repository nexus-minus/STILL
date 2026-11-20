/**
 * Volumetrics framing explorer (phase 1b helper — not a pass/fail test).
 *
 *   node scripts/rt-vol-explore.mjs [http://localhost:5186]
 *
 * Boots once, tries a list of freecam framings, and for each takes a fog-ON
 * and a fog-OFF screenshot (live toggle via quality.setOverride) plus the
 * full-frame mean luminance of both. Screenshots land in
 * /tmp/opencode/rt-vol/explore-*.png for review — used to pick the corridor
 * framing that rt-vol-smoke.mjs asserts against.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5186';
const OUT = '/tmp/opencode/rt-vol';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: false,
  protocolTimeout: 300000,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,760'],
});

// framings: spawn corridor, the two fixture rooms from the softshadow smoke,
// plus stand-off views of light002/light003 (the deep map fixtures)
const FRAMINGS = [
  { name: 'spawn', pos: [-6.6, -7.6, -30.6], look: [-6.6, -7.6, -22] },
  { name: 'sunken', pos: [0.93, 1.6, 1.2], look: [0.93, 0.1, 3.13] },
  { name: 'strip', pos: [-14.3, -2.0, -51.24], look: [-12.13, -2.02, -51.24] },
  { name: 'l003', pos: [-0.31, -4.5, -4.5], look: [-0.31, -6.06, -12.58] },
  { name: 'l002', pos: [8.67, 6.6, -57.5], look: [8.67, 5.15, -67.55] },
  { name: 'deep', pos: [-6.6, -7.6, -30.6], look: [2, -7.0, -45] },
];

const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.setViewport({ width: 1280, height: 720 });
await page.evaluateOnNewDocument(() => {
  try { sessionStorage.clear(); } catch { /* private mode */ }
});
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
for (let i = 0; i < 150; i++) {
  if (await page.evaluate(() => window.__liminalReady === true).catch(() => false)) break;
  await sleep(200);
}
await page.bringToFront();

/** mean luminance of the whole frame, read right after a fresh rAF */
const meanLuma = () => page.evaluate(() => new Promise((res) => {
  let done = false;
  const to = setTimeout(() => { if (!done) { done = true; res(null); } }, 3000);
  requestAnimationFrame(() => {
    if (done) return;
    done = true;
    clearTimeout(to);
    const c = document.querySelector('canvas#game');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    res(sum / (d.length / 4));
  });
}));

const frame = (f) => page.evaluate((fr) => {
  const L = window.__liminal;
  if (!L.controller.freecam) L.controller.toggleFreecam();
  const [px, py, pz] = fr.pos;
  const [tx, ty, tz] = fr.look;
  L.camera.position.set(px, py, pz);
  const dx = tx - px, dy = ty - py, dz = tz - pz;
  L.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
}, f);
const hide = () => page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  const resume = [...document.querySelectorAll('button')].find(
    (b) => /^resume$/i.test((b.textContent ?? '').trim()));
  if (resume && resume.offsetParent !== null) resume.click();
  document.getElementById('overlay')?.classList.add('hidden');
});

for (const f of FRAMINGS) {
  await frame(f);
  await sleep(4200); // settle + temporal convergence (camera still → blend 0.08)
  await hide();
  await sleep(300);
  const on = await meanLuma();
  await page.screenshot({ path: `${OUT}/explore-${f.name}-on.png` });
  await page.evaluate(() => window.__liminal.quality.setOverride('volumetrics', false));
  await sleep(1600); // release + live frame
  await hide();
  const off = await meanLuma();
  await page.screenshot({ path: `${OUT}/explore-${f.name}-off.png` });
  await page.evaluate(() => window.__liminal.quality.setOverride('volumetrics', true));
  await sleep(900);
  const stats = await page.evaluate(() => window.__liminal.volStats);
  console.log(
    `${f.name.padEnd(7)} luma off=${off?.toFixed(2)} on=${on?.toFixed(2)} ` +
    `Δ=${on != null && off != null ? ((on - off) / off * 100).toFixed(1) : '?'}%  ` +
    `vol=${JSON.stringify(stats)}`,
  );
}

const errs = logs.filter((l) => /PAGEERROR|\[liminal\]\[webgpu\]/.test(l));
console.log(errs.length ? `ERRORS ${errs.length}:\n${errs.slice(0, 5).join('\n')}` : '0 pageerrors / WebGPU errors');
await browser.close();
