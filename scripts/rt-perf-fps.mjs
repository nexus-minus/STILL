/**
 * RT lighting FPS benchmark — headful Chromium WebGPU.
 *
 *   node scripts/rt-perf-fps.mjs [http://localhost:5177] [high,ultra] [vol-mode] [extra-query]
 *
 * vol-mode (phase 1b, optional 3rd arg): '' = tier default · 'off' forces
 * settings.volumetrics=false after the tier pick (the "toggle off must cost
 * nothing" A/B — must equal the pre-volumetrics baseline) · 'on' forces it
 * true. Each run also prints window.__liminal.volStats so the fog dispatch
 * count proves which side of the toggle was actually measured.
 * extra-query (optional 4th arg): appended to the boot URL — used for the
 * per-material gloss A/B (`rtspec=0` = specular branch skipped).
 *
 * For each tier: boots the game fresh (localStorage cleared so no persisted
 * tier/override leaks in), sets the tier via __liminal.quality, warms up
 * (BVH upload + shader compile), then counts rAF frames over a fixed
 * wall-clock window IN-PAGE (requestAnimationFrame ticks = rendered frames,
 * the same loop the HUD fps counts). The counter runs as a standalone rAF
 * chain on window.__rtFps and the NODE side polls it — an in-page promise
 * that resolves after N ms deadlocks when a single frame blocks longer than
 * the CDP protocol timeout (which is exactly what tier=ultra did on the old
 * code). Reports fps per tier plus the HUD's own #stats line as a
 * cross-check, and dumps the [map] load/nudge log lines so fixture verdicts
 * are visible in the same run.
 *
 * Run BEFORE and AFTER renderer changes for an A/B; there is deliberately no
 * legacy code path kept in rt.ts — the baseline is this script on the old code.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5177';
const TIERS = (process.argv[3] ?? 'high,ultra').split(',').map((s) => s.trim()).filter(Boolean);
const VOL = (process.argv[4] ?? '').trim(); // '' | 'off' | 'on'
// Optional 5th arg: extra URL query for the boot (e.g. rtspec=0) — the
// per-material specular A/B: same build, gloss branch skipped vs enabled.
const EXTRA = (process.argv[5] ?? '').trim();
const CHROME = '/usr/bin/chromium';
const XDG = '/tmp/opencode/chromium-xdg-clean';
const WARMUP_MS = 4000;
const WINDOW_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  protocolTimeout: 300000,
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,760'],
});

async function measure(tier) {
  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch { /* ignore */ }
  });
  console.log(`\n== tier=${tier}${EXTRA ? ` (${EXTRA})` : ''}`);
  await page.goto(`${BASE}/${EXTRA ? `?${EXTRA}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(() => window.__liminalReady === true).catch(() => false)) break;
    await sleep(200);
  }
  await page.bringToFront();
  await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
  const boot = logs.find((l) => l.includes('[liminal] up')) ?? '';
  console.log(`  boot: ${boot.split('\n')[0].slice(0, 140)}`);
  for (const l of logs.filter((l) => l.startsWith('[map]'))) console.log(`  ${l}`);
  for (const l of logs.filter((l) => l.startsWith('[liminal][webgpu]'))) console.log(`  WEBGPU-ERR ${l.slice(0, 160)}`);

  // switch tier after boot (T-key equivalent), then let everything settle.
  // The tier pick CLEARS overrides (that's what a preset means), so any
  // volumetrics mode must be applied AFTER setTier.
  await page.evaluate((t) => window.__liminal.quality.setTier(t), tier);
  if (VOL) {
    await page.evaluate(
      (v) => window.__liminal.quality.setOverride('volumetrics', v === 'on'),
      VOL,
    );
    console.log(`  volumetrics forced ${VOL}`);
  }
  await sleep(WARMUP_MS);
  // standalone frame counter: survives slow frames, polled from node
  await page.evaluate(() => {
    window.__rtFps = { frames: 0, t0: performance.now() };
    const tick = () => { window.__rtFps.frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  const samples = [];
  try {
    for (let s = 0; s < 2; s++) {
      const start = await page.evaluate(() => ({ n: window.__rtFps.frames, t: performance.now() }));
      const t0 = Date.now();
      let end = start;
      while (Date.now() - t0 < WINDOW_MS + 2500) {
        await sleep(500);
        end = await page.evaluate(() => ({ n: window.__rtFps.frames, t: performance.now() }));
        if (end.t - start.t >= WINDOW_MS) break;
      }
      const dt = (end.t - start.t) / 1000;
      const fps = dt > 0 ? +((end.n - start.n) / dt).toFixed(1) : 0;
      const hud = await page.evaluate(() => document.getElementById('stats')?.textContent ?? '').catch(() => '(main thread starved)');
      samples.push(fps);
      console.log(`  sample ${s + 1}: ${fps} fps (${end.n - start.n} frames / ${Math.round(dt * 1000)} ms)  hud="${hud.replace(/\n/g, ' | ')}"`);
    }
  } catch (e) {
    console.log(`  MEASURE-ERROR ${String(e).slice(0, 200)}`);
  }
  const vol = await page.evaluate(() => window.__liminal.volStats ?? null).catch(() => null);
  if (vol) console.log(`  volStats: ${JSON.stringify(vol)}`);
  for (const e of errors) console.log(`  PAGEERROR ${e.slice(0, 160)}`);
  await page.close();
  return { tier, samples, boot, vol };
}

const results = [];
for (const tier of TIERS) {
  try {
    results.push(await measure(tier));
  } catch (e) {
    console.log(`  TIER-ERROR ${tier}: ${String(e).slice(0, 200)}`);
    results.push({ tier, samples: [], boot: '' });
  }
}

await browser.close();
console.log(`\n==== summary (fps of the two samples per tier) — volumetrics mode="${VOL || 'tier default'}"`);
for (const r of results) {
  const fog = r.vol ? `  fog: ${r.vol.dispatches} dispatches ${r.vol.width}x${r.vol.height}` : '';
  console.log(`  ${r.tier}: ${r.samples.length ? r.samples.join(' / ') : 'FAILED'}${fog}`);
}
const armed = results.length > 0 && results.every((r) => r.boot.includes('rt=armed'));
console.log(`\n==== ${armed ? 'PASS' : 'FAIL'} — rt=armed on every boot`);
process.exitCode = armed ? 0 : 1;
