// Path-tracer denoise + camera-motion smoke test.
//
// Verifies the two fixes on /pathtrace.html:
//   1. NO WIPE — during a running OIDN pass the exposed denoiser.texture is
//      OUR frozen completed snapshot, never the partially-written
//      denoiser._texture (the top-to-bottom tile fill).
//   2. NOISE-FREE MOVEMENT — a simulated OrbitControls drag never exposes raw
//      noise after the first pass completed: during the drag, mid-pass, and
//      after settling the display shows a completed snapshot, and the pass
//      still reaches complete:true with the right status text.
//
// Screenshots: screenshots/pt-move-{dragging,midpass,settled}.png
// Usage: PT_URL=http://localhost:5174/pathtrace.html node scripts/pt-move-smoke.mjs
import puppeteer from 'puppeteer-core';

const url = process.env.PT_URL || 'http://localhost:5174/pathtrace.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: false,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,800'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));

  console.log('URL:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(
    () => /Ready/.test(document.getElementById('status')?.textContent ?? ''),
    { timeout: 30000, polling: 250 },
  );

  // gameplay settings: 8 spp + neural denoise
  await page.evaluate(() => {
    const s = document.getElementById('samples');
    s.value = '8';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#denoise');
  console.log('denoise toggled ->', await page.$eval('#status', (e) => e.textContent));

  // ---- (0) wait for the FIRST completed denoise pass -----------------------
  // all three: the pass flipping to complete, the frozen snapshot existing
  // (captured at the completion moment itself), and the 'complete' event
  // updating the status on the following frame
  await page.waitForFunction(
    () => window.__pathtrace?.tracer?._denoiser?.complete === true
      && window.__pathtrace.denoisedTexture() !== null
      && /denoised · clean image from low spp/.test(document.getElementById('status').textContent),
    { timeout: 90000, polling: 100 },
  );
  const first = await page.evaluate(() => {
    const t = window.__pathtrace;
    const d = t.tracer._denoiser;
    const snap = t.denoisedTexture();
    return { hasSnapshot: snap !== null, exposedIsSnapshot: snap !== null && d.texture === snap, status: document.getElementById('status').textContent, debug: t.denoiseDebug() };
  });
  check('first pass completed, snapshot exposed', first.hasSnapshot && first.exposedIsSnapshot, JSON.stringify(first.debug));
  check('first-pass status is "denoised · clean image from low spp"',
    /denoised · clean image from low spp/.test(first.status), JSON.stringify(first.status));

  // keep the snapshot reference IN-PAGE: puppeteer serializes evaluate return
  // values, so a texture object passed across the boundary is a plain copy
  await page.evaluate(() => {
    window.__snapBeforeDrag = window.__pathtrace.denoisedTexture();
  });

  // ---- (a) CAMERA DRAG: mouse down + move + up on the canvas ---------------
  // OrbitControls 'change' -> tracer.updateCamera() -> reset() every step.
  await page.mouse.move(820, 420);
  await page.mouse.down();
  for (const [x, y] of [[850, 410], [885, 400], [920, 388], [955, 376]]) {
    await page.mouse.move(x, y);
    await sleep(90);
  }
  const during = await page.evaluate(() => {
    const t = window.__pathtrace;
    const d = t.tracer._denoiser;
    const snap = t.denoisedTexture();
    return {
      exposedIsSnapshot: snap !== null && d.texture === snap && d.texture === window.__snapBeforeDrag,
      isInternalTexture: snap !== null && d.texture === d._texture,
      status: document.getElementById('status').textContent,
      debug: t.denoiseDebug(),
    };
  });
  check('during drag: exposed texture is the completed snapshot (no raw noise)',
    during.exposedIsSnapshot && !during.isInternalTexture, JSON.stringify(during.debug));
  await page.screenshot({ path: 'screenshots/pt-move-dragging.png' });
  console.log('screenshot: screenshots/pt-move-dragging.png, status:', JSON.stringify(during.status));
  await page.mouse.up();

  // ---- (b) MID-DENOISE-PASS: catch a running pass and FREEZE it -----------
  // The pass is aborted atomically with detection: oidn checks its 'active'
  // state before every progress/done callback, so after the abort the pass is
  // stuck mid-flight — running with a partially-written _texture that must
  // NOT be what's on screen. This makes the screenshot deterministic.
  let midpass = null;
  for (let attempt = 1; attempt <= 3 && midpass === null; attempt += 1) {
    const deadline = Date.now() + 25000;
    let nextLog = Date.now() + 3000;
    while (Date.now() < deadline) {
      const s = await page.evaluate(() => {
        const t = window.__pathtrace;
        const d = t.tracer._denoiser;
        if (!d || !d.running || !d._texture) return null;
        let frozen = false;
        if (typeof d._abort === 'function') {
          try { d._abort(); frozen = true; } catch { /* already settled */ }
        }
        const snap = t.denoisedTexture();
        return {
          frozen,
          complete: d.complete,
          running: d.running,
          exposedIsSnapshot: snap !== null && d.texture === snap && d.texture === window.__snapBeforeDrag,
          isInternalTexture: snap !== null && d.texture === d._texture,
          status: document.getElementById('status').textContent,
        };
      });
      if (s) { midpass = s; break; }
      if (Date.now() >= nextLog) {
        console.log('  waiting:', JSON.stringify(await page.evaluate(() => window.__pathtrace.denoiseDebug())));
        nextLog = Date.now() + 3000;
      }
      await sleep(25);
    }
    if (midpass === null) {
      console.log(`attempt ${attempt}: no running pass caught, nudging the camera…`);
      console.log('  debug:', JSON.stringify(await page.evaluate(() => window.__pathtrace.denoiseDebug())));
      await page.mouse.move(700, 300);
      await page.mouse.down();
      await page.mouse.move(740, 330, { steps: 4 });
      await page.mouse.up();
    }
  }
  check('caught and froze a running denoise pass', midpass !== null && midpass.frozen === true);
  if (midpass) {
    // frozen state: display must be the stale-but-complete snapshot, never
    // the partially-written denoiser._texture (the top-to-bottom wipe)
    await page.screenshot({ path: 'screenshots/pt-move-midpass.png' });
    console.log('screenshot: screenshots/pt-move-midpass.png, status:', JSON.stringify(midpass.status));
    check('mid-pass: exposed texture is our snapshot, NOT denoiser._texture',
      midpass.exposedIsSnapshot && !midpass.isInternalTexture, JSON.stringify(midpass));
    check('mid-pass: pass not yet complete', midpass.complete === false && midpass.running === true,
      JSON.stringify(midpass));
    let midStatus = midpass.status;
    if (!/denoising · \d+%/.test(midStatus)) {
      await sleep(250);
      midStatus = await page.$eval('#status', (e) => e.textContent);
    }
    check('mid-pass: status shows "denoising · N%"', /denoising · \d+%/.test(midStatus), JSON.stringify(midStatus));
    // release the frozen pass so a fresh one can run to completion
    await page.evaluate(() => { window.__pathtrace.tracer._denoiser.reset(); });
  }

  // ---- (c) SETTLE: pass reaches complete again with fresh result -----------
  await page.waitForFunction(
    () => window.__pathtrace?.tracer?._denoiser?.complete === true
      && /denoised · clean image from low spp/.test(document.getElementById('status').textContent),
    { timeout: 90000, polling: 100 },
  );
  const settled = await page.evaluate(() => {
    const t = window.__pathtrace;
    const d = t.tracer._denoiser;
    const snap = t.denoisedTexture();
    return {
      complete: d.complete,
      failed: d._failed === true,
      exposedIsSnapshot: d.texture === snap && snap !== null,
      isInternalTexture: snap !== null && d.texture === d._texture,
      status: document.getElementById('status').textContent,
    };
  });
  check('settled: pass reached complete:true', settled.complete === true, JSON.stringify(settled));
  check('settled: no denoiser failure', settled.failed === false);
  check('settled: exposed texture is the completed snapshot',
    settled.exposedIsSnapshot && !settled.isInternalTexture, JSON.stringify(settled));
  check('settled: status is "denoised · clean image from low spp"',
    /denoised · clean image from low spp/.test(settled.status), JSON.stringify(settled.status));
  await page.screenshot({ path: 'screenshots/pt-move-settled.png' });
  console.log('screenshot: screenshots/pt-move-settled.png, status:', JSON.stringify(settled.status));

  // ---- (d) denoise mode caps the slider, and turning it off restores it ----
  await page.evaluate(() => {
    const s = document.getElementById('samples');
    s.value = '64';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const capped = await page.evaluate(() => window.__pathtrace.tracer.maxSamples);
  check('denoise on: samples slider 64 is capped at 8', capped === 8, `maxSamples=${capped}`);
  await page.click('#denoise');
  const off = await page.evaluate(() => {
    const t = window.__pathtrace;
    return {
      status: document.getElementById('status').textContent,
      maxSamples: t.tracer.maxSamples,
      hasDenoiser: t.tracer._denoiser != null,
    };
  });
  check('denoise off: raw mode + slider maxSamples restored',
    off.status === 'Denoiser off — raw path tracing' && !off.hasDenoiser && off.maxSamples === 64,
    JSON.stringify(off));

  const errors = logs.filter((l) => /PAGEERROR|\[error\]/i.test(l));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  for (const l of logs.slice(-6)) console.log(l);
} finally {
  await browser.close();
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
