/**
 * Feel e2e against the ?testroom scene:
 *   1. step-up: approach → climb the 0.3 m ledge → ride → walk off
 *   2. camera: the instant physics snap is EASED into the view (held back at
 *      the climb frame, back at eye height ~150 ms later)
 *   3. slope: standing still on the 30° ramp must not slide for 1.5 s, and
 *      walking down it with input must still work
 *   4. no-tunnel: press diagonally into the NE corner block — bounded inside
 *      the walls, step-up attempts run and none accept through geometry
 *   5. step-up-immediate: run into the 0.3 m ledge → climb within ~2 frames
 *      of contact, never dead-stopped for more than 1 frame before it
 *   6. no-step-on-slope: walking up the 30° and 50° ramps never kicks the
 *      camera (step-up never fires mid-slope) and feet track the surface
 *   7. walk-up-50: hold forward up the 50° ramp (walk AND run) → top with no
 *      jump, no stall, no slide back
 *   8. momentum: descend the 50° ramp over the sprint cap, jump at speed →
 *      horizontal speed carried mid-air and on landing, decays ~1–2 s
 *   9. no-bob: walking 2 s on flat ground → camera Y constant (no walk bob)
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

  // =========================================================================
  // Movement-overhaul regression suite (P1–P6). Phase order matters: the
  // controller only logs its first 4 step-up attempts per session, so the
  // no-tunnel check (which asserts those logs exist) runs first.
  // =========================================================================

  /** per-frame trace: respawns, holds keys in-page, optional early resolve
   *  on a feet-height threshold, optional in-page jump at first ground
   *  contact on the flat. Columns: [t, feetX, feetY, feetZ, camY, grounded]. */
  const traceRun = (keys, opts) =>
    page.evaluate(
      (keys, opts) =>
        new Promise((resolve) => {
          const g = window.__liminal;
          g.controller.respawnAt(new g.THREE.Vector3(opts.spawn[0], opts.spawn[1], opts.spawn[2]));
          g.controller.yaw = opts.yaw;
          for (const k of keys) document.dispatchEvent(new KeyboardEvent('keydown', { code: k }));
          const out = [];
          const t0 = performance.now();
          let jumped = false;
          const tick = () => {
            const t = performance.now() - t0;
            const c = g.controller;
            out.push([
              +t.toFixed(1),
              +c.feet.x.toFixed(4), +c.feet.y.toFixed(4), +c.feet.z.toFixed(4),
              +g.camera.position.y.toFixed(4),
              c.grounded ? 1 : 0,
            ]);
            const i = out.length - 1;
            if (opts.jumpAtFlat && !jumped && i > 5 && c.grounded && c.feet.y < 0.05) {
              jumped = true;
              document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
            }
            const early = opts.untilY != null && i > 5 && c.feet.y >= opts.untilY;
            if (t < opts.ms && !early) requestAnimationFrame(tick);
            else {
              for (const k of [...keys, 'Space'])
                document.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
              resolve(out);
            }
          };
          requestAnimationFrame(tick);
        }),
      keys,
      opts,
    );

  /** per-frame horizontal speed (m/s); dt-guarded against rAF hiccups */
  const hSpeeds = (s) =>
    s.slice(1).map((f, i) => {
      const dt = (f[0] - s[i][0]) / 1000;
      if (!(dt > 0.008)) return null;
      return Math.hypot(f[1] - s[i][1], f[3] - s[i][3]) / dt;
    });
  /** 3-sample moving average — kills single-frame integration artifacts */
  const smooth = (a) =>
    a.map((v, i) => {
      if (v == null) return null;
      const w = a.slice(Math.max(0, i - 1), i + 2).filter((x) => x != null);
      return w.reduce((p, c) => p + c, 0) / w.length;
    });
  /** mean smoothed speed over [t0,t1] ms — window beats point samples */
  const avgSpeedWin = (samples, speeds, t0, t1) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i][0] >= t0 && samples[i][0] <= t1 && speeds[i] != null) {
        sum += speeds[i];
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  };

  // --- 4. no-tunnel: scripted diagonal press into the NE corner block ------
  logs.length = 0;
  const tun = await traceRun(['ShiftLeft', 'KeyW'], {
    spawn: [6.9, 0.3, -7.0], yaw: -Math.PI / 4, ms: 3500,
  });
  let tunMaxX = -Infinity;
  let tunMinZ = Infinity;
  let tunMinY = Infinity;
  let tunNaN = false;
  for (const f of tun) {
    tunMaxX = Math.max(tunMaxX, f[1]);
    tunMinZ = Math.min(tunMinZ, f[3]);
    tunMinY = Math.min(tunMinY, f[2]);
    if (f.slice(1, 4).some((v) => !Number.isFinite(v))) tunNaN = true;
  }
  const tunAttempt = logs.some((l) => l.includes('[stepup] attempt'));
  const tunAccepted = logs.some((l) => l.includes('accepted=true'));
  console.log('tunnel:', JSON.stringify({ maxX: tunMaxX, minZ: tunMinZ, minY: tunMinY, attempt: tunAttempt }));
  check(
    'no-tunnel: corner press stays inside the walls (bounds, no NaN)',
    tunMaxX <= 7.47 && tunMinZ >= -7.47 && tunMinY > -0.05 && !tunNaN,
    `maxX=${tunMaxX} minZ=${tunMinZ} minY=${tunMinY}${tunNaN ? ' NaN!' : ''}`,
  );
  check(
    'no-tunnel: step-up attempts ran, none accepted into geometry',
    tunAttempt && !tunAccepted,
    `attemptLogged=${tunAttempt} acceptedAny=${tunAccepted}`,
  );

  // --- 5. step-up-immediate: run into the 0.3 m ledge ----------------------
  const led2 = await traceRun(['ShiftLeft', 'KeyW'], { spawn: [0, 0, 1.4], yaw: 0, ms: 2500 });
  let contactI = -1;
  let climbI = -1;
  for (let i = 1; i < led2.length; i++) {
    const dz = Math.abs(led2[i][3] - led2[i - 1][3]);
    if (contactI < 0 && led2[i][3] < 0.15 && dz < 0.05) contactI = i;
    if (climbI < 0 && led2[i][2] >= 0.25) climbI = i;
  }
  let still = 0;
  let maxStill = 0;
  for (let i = 1; i < (climbI < 0 ? led2.length : climbI); i++) {
    const d = Math.hypot(led2[i][1] - led2[i - 1][1], led2[i][3] - led2[i - 1][3]);
    const dy = Math.abs(led2[i][2] - led2[i - 1][2]);
    if (d < 0.004 && dy < 0.004) {
      still++;
      maxStill = Math.max(maxStill, still);
    } else still = 0;
  }
  console.log('immediate:', JSON.stringify({ contactI, climbI, maxStill }));
  check(
    'step-up-immediate: climb starts within ~2 frames of contact (run speed)',
    contactI >= 0 && climbI >= 0 && climbI - contactI <= 2,
    `contact=${contactI} climb=${climbI}`,
  );
  check(
    'step-up-immediate: never dead-stopped >1 frame before the climb',
    maxStill <= 1,
    `maxStillFrames=${maxStill}`,
  );

  // --- 6a. no-step-on-slope: walking up the 30° ramp -----------------------
  const tan30 = Math.tan(Math.PI / 6);
  const s30 = await traceRun(['KeyW'], { spawn: [-4.8, 0, 4], yaw: Math.PI / 2, ms: 2600 });
  // smoothness is judged over the CLIMB — the trace ends pressed against the
  // west wall where wall-on-ramp settling jitters a few cm (a wall-contact
  // boundary case, not slope walking; the camera-ease check covers the
  // whole trace incl. the press)
  let s30Wall = s30.length;
  for (let i = 1; i < s30.length; i++) {
    if (s30[i][1] <= -7.44) { s30Wall = i; break; }
  }
  let s30CamMax = 0;
  let s30MinDy = 0;
  let s30SurfMax = 0;
  for (let i = 0; i < s30Wall; i++) {
    const f = s30[i];
    if (i > 0) s30MinDy = Math.min(s30MinDy, f[2] - s30[i - 1][2]);
    if (f[1] < -5.55) {
      const surface = (-5.5 - f[1]) * tan30;
      s30SurfMax = Math.max(s30SurfMax, Math.abs(f[2] - surface));
    }
  }
  for (const f of s30) s30CamMax = Math.max(s30CamMax, Math.abs(f[4] - f[2] - 1.58));
  console.log('slope30:', JSON.stringify({ camMax: +s30CamMax.toFixed(4), minDy: +s30MinDy.toFixed(4), surfMax: +s30SurfMax.toFixed(4) }));
  check(
    'no-step-on-slope: 30° walk-up never kicks the camera (ease stays 0)',
    s30CamMax <= 0.015,
    `max |camY-offset|=${s30CamMax.toFixed(4)}`,
  );
  check(
    'no-step-on-slope: feet track the 30° ramp surface smoothly, no slide back',
    s30SurfMax <= 0.2 && s30MinDy >= -0.01,
    `surfaceErr=${s30SurfMax.toFixed(3)} minDy=${s30MinDy.toFixed(4)}`,
  );

  // --- 7. walk-up-50: hold forward up the 50° ramp, walk AND run -----------
  const walkUp50 = async (run, label) => {
    const keys = run ? ['ShiftLeft', 'KeyW'] : ['KeyW'];
    const tr = await traceRun(keys, {
      spawn: [1.7, 0, -4], yaw: -Math.PI / 2, ms: run ? 4000 : 5500, untilY: 1.75,
    });
    const reached = tr[tr.length - 1][2] >= 1.75;
    let minDy = 0;
    let maxStall = 0;
    let curStall = 0;
    let airborne = 0;
    let camMax = 0;
    for (let i = 1; i < tr.length; i++) {
      const f = tr[i];
      const p = tr[i - 1];
      const dy = f[2] - p[2];
      const dxy = Math.hypot(f[1] - p[1], f[3] - p[3]);
      minDy = Math.min(minDy, dy);
      if (dxy < 0.002 && dy < 0.002) {
        curStall++;
        maxStall = Math.max(maxStall, curStall);
      } else curStall = 0;
      if (f[5] === 0) airborne++;
      // camera check covers the SLOPE; the last frames include the legal
      // junction step onto the platform (its eased kick happens at the top)
      if (f[2] < 1.7) camMax = Math.max(camMax, Math.abs(f[4] - f[2] - 1.58));
    }
    console.log(`walk-up-50 ${label}:`, JSON.stringify({
      frames: tr.length, minDy: +minDy.toFixed(4), maxStall, airborne, camMax: +camMax.toFixed(4),
    }));
    check(
      `walk-up-50 (${label}): reaches the top — no jump, no stall, no slide back`,
      reached && minDy >= -0.01 && maxStall <= 4 && airborne <= 3,
      `reached=${reached} minDy=${minDy.toFixed(4)} maxStall=${maxStall} airborne=${airborne}`,
    );
    check(
      `no-step-on-slope: 50° ramp (${label}) never kicks the camera`,
      camMax <= 0.015,
      `max |camY-offset|=${camMax.toFixed(4)}`,
    );
  };
  await walkUp50(false, 'walk');
  await walkUp50(true, 'run');

  // --- 8. momentum: descend → over cap → jump carries → decays -------------
  const mo = await traceRun(['ShiftLeft', 'KeyW'], {
    spawn: [4.9, 1.85, -4], yaw: Math.PI / 2, ms: 5000, jumpAtFlat: true,
  });
  const moSpeeds = smooth(hSpeeds(mo));
  let flatI = -1;
  for (let i = 6; i < mo.length; i++) {
    if (mo[i][5] === 1 && mo[i][2] < 0.05) { flatI = i; break; }
  }
  let jumpI = -1;
  let landI = -1;
  if (flatI >= 0) {
    for (let i = flatI; i < mo.length; i++) if (mo[i][5] === 0) { jumpI = i; break; }
    for (let i = jumpI + 1; i < mo.length; i++) if (mo[i][5] === 1) { landI = i; break; }
  }
  let slopeMax = 0;
  for (let i = 1; i < (jumpI < 0 ? mo.length : jumpI); i++) {
    if (mo[i][2] > 0.3 && moSpeeds[i] != null) slopeMax = Math.max(slopeMax, moSpeeds[i]);
  }
  const sPre = jumpI > 0 ? Math.max(moSpeeds[Math.max(1, jumpI - 2)] ?? 0, moSpeeds[Math.max(1, jumpI - 1)] ?? 0) : 0;
  const sAir = jumpI > 0 && landI > 0 ? moSpeeds[Math.floor((jumpI + landI) / 2)] : 0;
  const sLand = landI > 0 ? moSpeeds[landI] : 0;
  const landT = landI > 0 ? mo[landI][0] : 0;
  const sAt035 = avgSpeedWin(mo, moSpeeds, landT + 250, landT + 450);
  const sAt05 = avgSpeedWin(mo, moSpeeds, landT + 550, landT + 750);
  const sAt22 = avgSpeedWin(mo, moSpeeds, landT + 2100, landT + 2400);
  console.log('momentum:', JSON.stringify({
    flatI, jumpI, landI,
    slopeMax: +slopeMax.toFixed(2), sPre: +sPre.toFixed(2), sAir: +sAir.toFixed(2), sLand: +sLand.toFixed(2),
    w035: +sAt035.toFixed(2), w055: +sAt05.toFixed(2), w22: +sAt22.toFixed(2),
  }));
  check(
    'momentum: descending the 50° ramp exceeds the sprint cap',
    slopeMax > 5.75,
    `peak smoothed speed=${slopeMax.toFixed(2)} (cap 5.4)`,
  );
  check(
    'momentum: jump carries horizontal speed mid-air and on landing',
    jumpI > 0 && landI > 0 && sAir >= sPre * 0.85 && sLand >= sPre * 0.8,
    `pre=${sPre.toFixed(2)} air=${sAir.toFixed(2)} land=${sLand.toFixed(2)}`,
  );
  check(
    'momentum: excess speed decays smoothly toward the cap (~1–2 s, not instant)',
    sAt035 > 5.55 && sAt05 > 5.55 && sAt05 <= sAt035 + 0.15 && sAt22 <= 5.55,
    `+0.35s=${sAt035.toFixed(2)} +0.65s=${sAt05.toFixed(2)} +2.2s=${sAt22.toFixed(2)}`,
  );

  // --- 9. no-bob: camera Y rock-steady while walking on flat ---------------
  const nb = await traceRun(['KeyW'], { spawn: [-3, 0, -5.5], yaw: Math.PI / 2, ms: 2100 });
  let nbMaxDelta = 0;
  let nbMin = Infinity;
  let nbMax = -Infinity;
  for (let i = 0; i < nb.length; i++) {
    const camY = nb[i][4];
    if (i > 0) nbMaxDelta = Math.max(nbMaxDelta, Math.abs(camY - nb[i - 1][4]));
    nbMin = Math.min(nbMin, camY);
    nbMax = Math.max(nbMax, camY);
  }
  console.log('no-bob:', JSON.stringify({ maxDelta: +nbMaxDelta.toFixed(5), range: +(nbMax - nbMin).toFixed(5) }));
  check(
    'no-bob: camera Y constant while walking 2 s (delta < 0.005)',
    nbMaxDelta < 0.005 && nbMax - nbMin < 0.01,
    `maxDelta=${nbMaxDelta.toFixed(5)} range=${(nbMax - nbMin).toFixed(5)}`,
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
