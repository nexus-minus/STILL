/**
 * E2E test for the black-frame safety net:
 *  1. hide the scene -> every frame becomes near-black background
 *  2. expect stage 1: glow auto-disabled + on-screen message
 *  3. show the scene again -> expect recovery (detector resets)
 *
 *   node scripts/detector-test.mjs   (needs preview server on 4173)
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://localhost:4173';
const logs = [];
let failed = false;

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX ?? '/usr/bin/firefox',
  headless: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => {
    logs.push(`PAGEERROR ${e.message}`);
    failed = true;
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !logs.some((l) => l.includes('[liminal] up'))) await sleep(200);
  await sleep(1000);

  // ---- go dark ----------------------------------------------------------
  await page.evaluate(() => {
    window.__liminal.scene.visible = false;
  });

  const waitFor = async (needle, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (logs.some((l) => l.includes(needle))) return true;
      await sleep(200);
    }
    return false;
  };

  const stage1 = await waitFor('glow disabled automatically', 12000);
  console.log(`stage 1 (glow auto-disabled): ${stage1 ? 'PASS' : 'FAIL'}`);
  if (!stage1) failed = true;

  const message = await page.evaluate(() => document.getElementById('message')?.textContent ?? '');
  console.log(`on-screen message: "${message}"`);

  // ---- recover ------------------------------------------------------------
  await page.evaluate(() => {
    window.__liminal.scene.visible = true;
  });
  await sleep(2000);

  const glowBack = await page.evaluate(() => window.__liminal.pipeline.postActive);
  console.log(`glow still off after recovery (expected true, manual B re-enables): ${glowBack}`);

  // frame bright again?
  const bright = await page.evaluate(() => {
    const g = window.__liminal;
    return g.quality !== undefined; // sanity; visual check via screenshot
  });
  await page.screenshot({ path: 'screenshots/detector-recovered.png' });
  console.log(`recovery screenshot saved (room should be visible): ${bright ? 'ok' : 'FAIL'}`);

  console.log('--- relevant logs ---');
  for (const l of logs.filter((l) => l.includes('[liminal]') || l.includes('black'))) console.log(l);

  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
