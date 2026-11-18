/**
 * E2E test for WebGPU black-screen auto-recovery (your Firefox/Chromium
 * scenario): headless Chromium HAS a WebGPU adapter but its WebGPU stack dies
 * (black frames) — exactly the failure mode we need the game to notice and
 * recover from on its own.
 *
 * Expected sequence:
 *   1. boot line with backend=webgpu
 *   2. ~7s later: "reloading into compatibility mode" (stage 2)
 *   3. page reloads (sessionStorage liminal.forcegl=1)
 *   4. boot line with backend=webgl2 + visible room
 *
 *   node scripts/recovery-test.mjs   (needs preview server on 4173)
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://localhost:4173';
const logs = [];
let failed = false;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--enable-unsafe-webgpu', // adapter exists, stack dies later — the scenario
    '--window-size=1280,720',
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (needle, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (logs.some((l) => l.includes(needle))) return true;
    await sleep(200);
  }
  return false;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const firstBoot = await waitFor('up — backend=webgpu', 15000);
  console.log(`1. boots on webgpu: ${firstBoot ? 'PASS' : 'FAIL'}`);
  if (!firstBoot) failed = true;

  // Wait for either the auto-recovery reload OR a visible (non-black) frame —
  // the invariant is "never stuck on a black screen", however it's achieved
  // (fallback lights can now make even a broken-compute path visible).
  const stage2 = await waitFor('reloading into compatibility mode', 14000);
  if (stage2) {
    const stage3 = await waitFor('up — backend=webgl2', 25000);
    console.log(`2. black -> auto-recovery fired: PASS`);
    console.log(`3. reloaded into forced WebGL2: ${stage3 ? 'PASS' : 'FAIL'}`);
    if (!stage3) failed = true;
  } else {
    await sleep(1500);
    const brightness = await page.evaluate(() => {
      const c = document.querySelector('canvas#game');
      const t = document.createElement('canvas');
      t.width = 32; t.height = 20;
      const x = t.getContext('2d');
      x.drawImage(c, 0, 0, 32, 20);
      const d = x.getImageData(0, 0, 32, 20).data;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
      return max;
    });
    const visible = brightness >= 8;
    console.log(`2. no recovery, screen visible (max=${brightness}): ${visible ? 'PASS' : 'FAIL'}`);
    console.log('3. (skipped — no reload happened)');
    if (!visible) failed = true;
  }

  await sleep(1500);
  await page.screenshot({ path: 'screenshots/recovery.png' });

  const bootLines = logs.filter((l) => l.includes('[liminal] up'));
  console.log('--- boot lines ---');
  for (const l of bootLines) console.log(l);
  const diagLines = logs.filter((l) => l.includes('diagnostics') || l.includes('compatibility mode'));
  console.log('--- recovery logs ---');
  for (const l of diagLines) console.log(l);
  const detectorLines = logs.filter(
    (l) => l.includes('glow') || l.includes('black frames') || l.includes('reloading') || l.includes('selfcheck'),
  );
  console.log('--- detector logs ---');
  for (const l of detectorLines) console.log(l);
  const pageErrors = logs.filter((l) => l.startsWith('PAGEERROR'));
  console.log('--- page errors ---');
  for (const l of pageErrors.slice(0, 3)) console.log(l);
  console.log('screenshot: screenshots/recovery.png (room should be visible)');

  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
