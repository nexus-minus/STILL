/**
 * Feel e2e against the ?testroom scene:
 *   1. step-up: approach → climb the 0.3 m ledge → ride → walk off
 *   2. camera: the instant physics snap is EASED into the view (held back at
 *      the climb frame, back at eye height ~150 ms later)
 *   3. slope: standing still on the 30° ramp must not slide for 1.5 s, and
 *      walking down it with input must still work
 *
 *   node scripts/steptest.mjs [url]
 *   (default url: http://localhost:4173/?testroom)
 */
import puppeteer from 'puppeteer-core';

// Accept a bare base URL: keep any query the caller supplied, otherwise
// default to the testroom scene (passing a plain host used to silently run
// the ledge checks against the real map).
const rawUrl = process.argv[2] ?? 'http://localhost:4173';
const url = rawUrl.includes('?') ? rawUrl : `${rawUrl.replace(/\/$/, '')}/?testroom`;

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

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  for (let i = 0; i < 60 && !logs.some((l) => l.includes('[liminal] up')); i++) await sleep(200);
  await sleep(800);

  await page.evaluate(() => {
    window.__liminal.controller.forceActiveForTest = true;
  });

  const before = await page.evaluate(() => {
    const g = window.__liminal;
    return {
      feet: g.controller.feet.toArray().map((v) => +v.toFixed(3)),
      pos: g.controller.position.toArray().map((v) => +v.toFixed(3)),
      // eye height while standing still: bob and step-ease offset are both 0
      eye: g.camera.position.y - g.controller.feet.y,
    };
  });
  console.log('start:', JSON.stringify(before));

  // walk forward (spawn faces the ledge), recording feet + camera EVERY frame —
  // a reading every 150 ms can miss both the climb and the camera lag
  await page.keyboard.down('KeyW');
  const trace = await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
          const g = window.__liminal;
          const t = performance.now() - t0;
          out.push([
            t,
            g.controller.feet.y,
            g.camera.position.y,
            g.controller.feet.z,
            g.controller.grounded ? 1 : 0,
          ]);
          if (t < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    2600,
  );
  await page.keyboard.up('KeyW');
  await sleep(400);

  const after = await page.evaluate(() => ({
    feet: window.__liminal.controller.feet.toArray().map((v) => +v.toFixed(3)),
    grounded: window.__liminal.controller.grounded,
  }));

  const peakRise = Math.max(...trace.map((s) => s[1])) - before.feet[1];
  const movedForward = before.feet[2] - after.feet[2]; // spawn faces -z

  // climb = first frame the feet are up on the 0.3 m platform
  const climbIdx = trace.findIndex((s) => s[1] >= before.feet[1] + 0.25);
  const climbLag = climbIdx >= 0 ? trace[climbIdx][2] - trace[climbIdx][1] - before.eye : NaN;
  const settle = climbIdx >= 0 ? trace.find((s) => s[0] >= trace[climbIdx][0] + 150) : undefined;
  const eyeErr = settle ? Math.abs(settle[2] - settle[1] - before.eye) : NaN;

  console.log('after:', JSON.stringify(after));
  console.log(
    `climb: idx=${climbIdx} t=${climbIdx >= 0 ? trace[climbIdx][0].toFixed(0) : '-'}ms ` +
      `lag=${Number.isFinite(climbLag) ? climbLag.toFixed(3) : '-'}m ` +
      `eyeErr@150ms=${Number.isFinite(eyeErr) ? eyeErr.toFixed(3) : '-'}m`,
  );

  check('player moved toward the ledge', movedForward > 0.8, `z ${before.feet[2]} -> ${after.feet[2]}`);
  check(
    'climbed the 0.3m ledge at some point (peak rise 0.2..0.45)',
    peakRise >= 0.2 && peakRise <= 0.45,
    `peakRise=${peakRise.toFixed(3)}`,
  );
  check('player is grounded after climb', after.grounded === true);
  const nanLine = logs.find((l) => l.includes('[controller] NaN'));
  check('no NaN resets', !nanLine, nanLine ?? '');

  // --- camera smoothing: view lags the physics snap, then catches up ------
  check(
    'camera eased the step-up (held back >=0.08m at the climb frame)',
    Number.isFinite(climbLag) && climbLag <= -0.08,
    `lag=${Number.isFinite(climbLag) ? climbLag.toFixed(3) : 'climb not detected'}m`,
  );
  check(
    'camera back at eye height 150ms after the climb (<0.1m)',
    Number.isFinite(eyeErr) && eyeErr < 0.1,
    `err=${Number.isFinite(eyeErr) ? eyeErr.toFixed(3) : 'n/a'}m`,
  );

  // --- slope: stand still on the 30° ramp, then walk down it with input ---
  // (ramp added by buildTestRoom: surface y=0.72 at (-6.75, 4), descends +x)
  await page.evaluate(() => {
    const g = window.__liminal;
    g.controller.respawnAt(new g.THREE.Vector3(-6.75, 0.78, 4));
  });
  await sleep(700); // settle onto the surface before measuring
  const rampA = await page.evaluate(() => ({
    feet: window.__liminal.controller.feet.toArray().map((v) => +v.toFixed(4)),
    grounded: window.__liminal.controller.grounded,
  }));
  await sleep(1500);
  const rampB = await page.evaluate(() => ({
    feet: window.__liminal.controller.feet.toArray().map((v) => +v.toFixed(4)),
    grounded: window.__liminal.controller.grounded,
  }));
  const slide = Math.hypot(
    rampB.feet[0] - rampA.feet[0],
    rampB.feet[1] - rampA.feet[1],
    rampB.feet[2] - rampA.feet[2],
  );
  console.log('ramp:', JSON.stringify({ a: rampA.feet, b: rampB.feet, slide: +slide.toFixed(4) }));

  check(
    'standing still on the 30deg ramp does not slide (1.5s)',
    slide < 0.05,
    `slide=${slide.toFixed(4)} m`,
  );
  check('player is grounded on the ramp', rampB.grounded === true);

  // D = +x at spawn yaw = straight down the ramp; input must still walk
  await page.keyboard.down('KeyD');
  await sleep(1000);
  await page.keyboard.up('KeyD');
  const rampC = await page.evaluate(() => ({
    feet: window.__liminal.controller.feet.toArray().map((v) => +v.toFixed(4)),
    grounded: window.__liminal.controller.grounded,
  }));
  console.log('ramp walk:', JSON.stringify(rampC));
  check(
    'walking down the ramp still works with input',
    rampC.feet[0] > rampB.feet[0] + 0.5 && rampC.feet[1] < rampB.feet[1] - 0.2,
    `x ${rampB.feet[0]} -> ${rampC.feet[0]}, y ${rampB.feet[1]} -> ${rampC.feet[1]}`,
  );

  if (failed) {
    console.log('--- console tail ---');
    for (const l of logs.slice(-6)) console.log(l);
  }
  await page.screenshot({ path: 'screenshots/steptest.png' });
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
