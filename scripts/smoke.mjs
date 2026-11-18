/**
 * Runtime smoke test: boots the built game in headless Chromium, waits for
 * the main loop to come up, screenshots what actually renders.
 *
 *   npm run build && npm run preview   # terminal 1
 *   npm run smoke                      # terminal 2   (WebGL2 fallback path)
 *   npm run smoke -- http://localhost:4173 screenshots/x.png   # custom
 *
 * Exit code 0 = no page errors and the renderer started.
 * FORCE_WEBGL=1 omits --enable-unsafe-webgpu (headless WebGPU is flaky
 * without a real GPU — test WebGPU manually in a real browser).
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://localhost:4173';
const OUT = process.argv[3] ?? 'screenshots/smoke.png';
// SMOKE_BROWSER=firefox -> test Firefox instead of Chromium
const USE_FIREFOX = process.env.SMOKE_BROWSER === 'firefox';
const CHROME = process.env.CHROME ?? '/usr/bin/chromium';
const FIREFOX = process.env.FIREFOX ?? '/usr/bin/firefox';
// FORCE_WEBGL=1 -> launch Chromium without WebGPU (fallback-path test)
const webgpuArgs = process.env.FORCE_WEBGL
  ? []
  : ['--enable-unsafe-webgpu'];

const logs = [];
const errors = [];

const browser = await puppeteer.launch(
  USE_FIREFOX
    ? {
        browser: 'firefox',
        executablePath: FIREFOX,
        headless: true,
      }
    : {
        executablePath: CHROME,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--enable-unsafe-swiftshader', // software WebGL2
          ...webgpuArgs, // try WebGPU even without a real GPU
          '--hide-scrollbars',
          '--window-size=1280,720',
        ],
      },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()} — ${req.failure()?.errorText}`));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // wait for main() to finish wiring the animation loop
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    if (logs.some((l) => l.includes('[liminal] up'))) {
      up = true;
      break;
    }
    await sleep(200);
  }

  await sleep(1200);

  // ---- diagnostics from inside the app --------------------------------
  const diag = await page.evaluate(() => {
    const g = window.__liminal;
    if (!g) return { error: 'no __liminal handle' };
    const p = g.camera.position;
    const c = g.controller.position;
    return {
      camera: [p.x, p.y, p.z].map((v) => +v.toFixed(2)),
      controller: [c.x, c.y, c.z].map((v) => +v.toFixed(2)),
      sceneChildren: g.scene.children.length,
      tier: g.quality.tier,
      bloom: g.quality.settings.bloom,
    };
  });
  console.log('--- diagnostics ---');
  console.log(JSON.stringify(diag));

  // ---- shot A: with bloom (as shipped) ---------------------------------
  await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
  await sleep(400);
  mkdirSync(OUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await page.screenshot({ path: OUT });

  // ---- shot B: bloom bypassed (isolate the post chain) -----------------
  await page.evaluate(() => {
    window.__liminal.quality.settings.bloom = false;
  });
  await sleep(400);
  const noPostOut = OUT.replace(/\.png$/, '-nopost.png');
  await page.screenshot({ path: noPostOut });

  // ---- shot C: walk forward for 1.5s, confirm movement + map marks ----
  await page.keyboard.down('KeyW');
  await sleep(1500);
  await page.keyboard.up('KeyW');
  await sleep(300);
  const moved = await page.evaluate(() => {
    const g = window.__liminal;
    return {
      controller: [g.controller.position.x, g.controller.position.y, g.controller.position.z].map((v) => +v.toFixed(2)),
      cells: document.getElementById('stats')?.textContent ?? '',
    };
  });
  const walkOut = OUT.replace(/\.png$/, '-walk.png');
  await page.screenshot({ path: walkOut });
  console.log('--- after walking forward ---');
  console.log(JSON.stringify(moved));

  const boot = logs.find((l) => l.includes('[liminal] up'));
  console.log('--- boot line ---');
  console.log(boot ?? 'MISSING: [liminal] up');
  console.log('--- errors ---');
  console.log(errors.length ? errors.join('\n') : '(none)');
  console.log(`screenshots: ${OUT}, ${noPostOut}, ${walkOut}`);

  if (!up || errors.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
