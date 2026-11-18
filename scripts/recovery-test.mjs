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
  page.on('pageerror', () => {}); // the dying WebGPU stack throws on load — expected

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const firstBoot = await waitFor('up — backend=webgpu', 15000);
  console.log(`1. boots on webgpu: ${firstBoot ? 'PASS' : 'FAIL'}`);
  if (!firstBoot) failed = true;

  const stage2 = await waitFor('reloading into compatibility mode', 20000);
  console.log(`2. black detected -> auto-recovery scheduled: ${stage2 ? 'PASS' : 'FAIL'}`);
  if (!stage2) failed = true;

  const secondBoot = await waitFor('up — backend=webgl2', 25000);
  console.log(`3. reloaded into forced WebGL2: ${secondBoot ? 'PASS' : 'FAIL'}`);
  if (!secondBoot) failed = true;

  await sleep(1500);
  await page.screenshot({ path: 'screenshots/recovery.png' });

  const bootLines = logs.filter((l) => l.includes('[liminal] up'));
  console.log('--- boot lines ---');
  for (const l of bootLines) console.log(l);
  const diagLines = logs.filter((l) => l.includes('diagnostics') || l.includes('compatibility mode'));
  console.log('--- recovery logs ---');
  for (const l of diagLines) console.log(l);
  console.log('screenshot: screenshots/recovery.png (room should be visible)');

  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
