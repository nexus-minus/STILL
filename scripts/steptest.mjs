/**
 * Step-up e2e: spawn in the test room (which has a 0.3m ledge ahead at
 * z=-1.2), walk forward, assert the capsule CLIMBED it (feet rise ~0.3m) —
 * this exact scenario shipped broken twice, so it's automated now.
 *
 *   node scripts/steptest.mjs
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX ?? '/usr/bin/firefox',
  headless: true,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
};
let failed = false;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));

  await page.goto('http://localhost:4173/?testroom', { waitUntil: 'domcontentloaded', timeout: 20000 });
  for (let i = 0; i < 60 && !logs.some((l) => l.includes('[liminal] up')); i++) await sleep(200);
  await sleep(800);

  await page.evaluate(() => {
    window.__liminal.controller.forceActiveForTest = true;
  });

  const before = await page.evaluate(() => ({
    feet: window.__liminal.controller.feet.toArray().map((v) => +v.toFixed(3)),
    pos: window.__liminal.controller.position.toArray().map((v) => +v.toFixed(3)),
  }));
  console.log('start:', JSON.stringify(before));

  // walk forward (spawn faces the ledge), sampling feet.y continuously —
  // the player may climb and walk off the far edge before a single reading
  const samples = [];
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 17; i++) {
    await sleep(150);
    const y = await page.evaluate(() => window.__liminal.controller.feet.y);
    samples.push(+y.toFixed(3));
  }
  await page.keyboard.up('KeyW');
  await sleep(400);

  const after = await page.evaluate(() => ({
    feet: window.__liminal.controller.feet.toArray().map((v) => +v.toFixed(3)),
    grounded: window.__liminal.controller.grounded,
  }));
  console.log('samples:', JSON.stringify(samples));
  console.log('after:', JSON.stringify(after));

  const peakRise = Math.max(...samples) - before.feet[1];
  const movedForward = before.feet[2] - after.feet[2]; // spawn faces -z

  check('player moved toward the ledge', movedForward > 0.8, `z ${before.feet[2]} -> ${after.feet[2]}`);
  check(
    'climbed the 0.3m ledge at some point (peak rise 0.2..0.45)',
    peakRise >= 0.2 && peakRise <= 0.45,
    `peakRise=${peakRise.toFixed(3)}`,
  );
  check('player is grounded after climb', after.grounded === true);
  const nanLine = logs.find((l) => l.includes('[controller] NaN'));
  check('no NaN resets', !nanLine, nanLine ?? '');

  if (failed) {
    console.log('--- console tail ---');
    for (const l of logs.slice(-6)) console.log(l);
  }
  await page.screenshot({ path: 'screenshots/steptest.png' });
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
