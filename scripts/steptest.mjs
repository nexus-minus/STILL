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
 *  10. coyote: walk off the 0.3 m ledge → jump 50 ms after leaving the
 *      ground still fires (COYOTE_MS grace)
 *  11. no-double-jump: mashing jump again on the next mid-air frame adds
 *      no second impulse (single jump per airtime)
 *  12. jump-buffer: press ~50 ms BEFORE landing a fall → the press sits
 *      inside the 100 ms window and fires on the landing frame
 *  13. stop: releasing sprint on the ground halts within ~0.2 s (brake)
 *  14/15. wall-glide: 30° press along a wall ≤ sprint cap, zero accel;
 *      into-wall position steady (no ~100 ms bounce)
 *  16. impact: head-on sprint crash stops dead, no bounce/jolt
 *  17/18. step-lips: 0.05/0.10/0.25 lips + thin nub climb within 2 frames
 *      at run speed, at their TRUE heights (no pop, no slide-down)
 *  19. ramp-climb: 50° walk-up mid-climb vy steady (no stutter)
 *  20. walk-off: stepping off the 50° ramp side always falls
 *  21. slide: idle on a 60° face slides off (unwalkable never held)
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

  /** per-frame trace: respawns, holds keys in-page, optional release of all
   *  keys at releaseAt ms, optional early resolve on a feet-height threshold,
   *  optional in-page jump at first ground contact on the flat. Columns:
   *  [t, feetX, feetY, feetZ, camY, grounded]. */
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
          let released = false;
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
            if (!released && opts.releaseAt != null && t >= opts.releaseAt) {
              released = true;
              for (const k of keys) document.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
            }
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

  // =========================================================================
  // Jump-feel suite: coyote time + jump input buffering (COYOTE_MS /
  // JUMP_BUFFER_MS in gameplay/controller.ts). Both runs respawn on the
  // 0.3 m ledge facing -z and walk straight off its north edge onto the
  // flat floor — the one walk-off path the suite already exercises.
  // =========================================================================

  // --- 10/11. coyote + no-double-jump -------------------------------------
  // Leave the ground, wait 50 ms (inside the 100 ms coyote window), press
  // jump → must fire and rise. Mash jump again on the NEXT frame while
  // still airborne: the real jump consumed the coyote window, so no second
  // impulse may ever appear (apex stays at a normal jump's height, the
  // descent stays monotonic, the landing gets no buffered jump either).
  const coy = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const g = window.__liminal;
        const c = g.controller;
        c.respawnAt(new g.THREE.Vector3(0, 0.3, -2.4));
        c.yaw = 0; // face -z: straight off the north edge of the ledge
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const press = () => {
          document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
          document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
        };
        const ev = {
          tLeave: -1, tPress: -1, pressY: 0, tPress2: -1,
          tJump: -1, peakY: -1, tPeak: -1, tLand: -1, maxAfterLand: -1,
        };
        const frames = []; // [t ms, feetY, grounded]
        let phase = 0;
        const t0 = performance.now();
        const tick = () => {
          const t = performance.now() - t0;
          const y = c.feet.y;
          const gr = c.grounded;
          frames.push([+t.toFixed(1), +y.toFixed(4), gr ? 1 : 0]);
          const i = frames.length - 1;
          if (phase === 0 && i > 2 && gr) {
            phase = 1; // standing on the ledge — armed
          } else if (phase === 1 && !gr) {
            ev.tLeave = t;
            ev.peakY = y;
            document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })); // keep drift off the pillar
            phase = 2;
          } else if (phase === 2 && t >= ev.tLeave + 50) {
            ev.tPress = t;
            ev.pressY = y;
            press();
            phase = 3;
          } else if (phase === 3) {
            if (t >= ev.tLeave + 66 && ev.tPress2 < 0) {
              ev.tPress2 = t;
              press(); // second mash, ~1 frame after the first, mid-air
            }
            if (ev.tJump < 0 && y > ev.pressY + 0.05) ev.tJump = t; // left the ground
            if (y > ev.peakY) {
              ev.peakY = y;
              ev.tPeak = t;
            }
            if (gr && t > ev.tLeave + 300) {
              ev.tLand = t;
              phase = 4;
            }
          } else if (phase === 4) {
            ev.maxAfterLand = Math.max(ev.maxAfterLand, y);
            if (t > ev.tLand + 300) {
              resolve({ ev, frames });
              return;
            }
          }
          if (t < 6000) requestAnimationFrame(tick);
          else resolve({ ev, frames });
        };
        requestAnimationFrame(tick);
      }),
  );
  const ce = coy.ev;
  const cf = coy.frames;
  // derived vertical velocity after the coyote press (m/s)
  let vyMax = -Infinity;
  for (let i = 1; i < cf.length; i++) {
    if (cf[i][0] < ce.tPress) continue;
    const dt = (cf[i][0] - cf[i - 1][0]) / 1000;
    if (dt > 0.001) vyMax = Math.max(vyMax, (cf[i][1] - cf[i - 1][1]) / dt);
  }
  if (!Number.isFinite(vyMax)) vyMax = 0;
  let rise = 0;
  if (ce.tJump >= 0) {
    for (const f of cf) if (f[0] >= ce.tJump) rise = Math.max(rise, f[1] - ce.pressY);
  }
  // apex → landing must only ever go DOWN: any upward step = 2nd impulse
  let maxStep = -Infinity;
  if (ce.tJump >= 0 && ce.tPeak >= 0 && ce.tLand > 0) {
    let prev = null;
    for (const f of cf) {
      if (f[0] < ce.tPeak) continue;
      if (f[0] > ce.tLand) break;
      if (prev != null) maxStep = Math.max(maxStep, f[1] - prev);
      prev = f[1];
    }
  }
  if (!Number.isFinite(maxStep)) maxStep = 0;
  console.log('coyote:', JSON.stringify({
    leave: +ce.tLeave.toFixed(0), press: +ce.tPress.toFixed(0), press2: +ce.tPress2.toFixed(0),
    jump: +ce.tJump.toFixed(0), peak: +ce.peakY.toFixed(3), land: +ce.tLand.toFixed(0),
    vyMax: +vyMax.toFixed(2), rise: +rise.toFixed(3), maxStep: +maxStep.toFixed(4),
    landingMax: +ce.maxAfterLand.toFixed(3),
  }));
  check(
    'coyote: jump 50 ms after walking off a ledge still fires (rises)',
    ce.tLeave >= 0 &&
      ce.tPress - ce.tLeave >= 35 && ce.tPress - ce.tLeave <= 95 &&
      ce.tJump >= 0 && ce.tJump - ce.tPress <= 60 &&
      // T1 jump-height update: impulse 4.0 m/s (JUMP_HEIGHT 0.5 m at g=16)
      // → apex rise 0.5 m minus one frame of pre-jump fall ≈ 0.49 m. The
      // window [0.4, 0.6] is NARROWER than the old ≥0.3 (5.0 m/s → 0.78 m):
      // logic conditions (timing windows, vy>0) unchanged.
      rise >= 0.4 && rise <= 0.6 && vyMax > 0,
    `leave→press=${(ce.tPress - ce.tLeave).toFixed(0)}ms press→jump=${(ce.tJump - ce.tPress).toFixed(0)}ms ` +
      `rise=${rise.toFixed(3)}m vy=${vyMax.toFixed(2)}m/s`,
  );
  check(
    'no-double-jump: second mid-air press after a coyote jump adds no impulse',
    ce.tJump >= 0 && ce.tLand > 0 &&
      ce.peakY < 1.2 && // normal apex ≈0.75 m (0.5 m hop); a 2nd impulse reaches ≈2.1 m
      maxStep <= 0.011 && // monotonic descent, apex → landing
      ce.maxAfterLand < 0.05, // press2's buffer expired before landing
    `peak=${ce.peakY.toFixed(3)}m maxStep=${maxStep.toFixed(4)}m landingMax=${ce.maxAfterLand.toFixed(3)}m`,
  );

  // --- 12. jump-buffer: press jump ~50 ms BEFORE landing a fall -----------
  // Fall from the platform (1.85 m) and press when ~0.30 m of fall remain
  // (~26–41 ms at this fall speed — inside JUMP_BUFFER_MS): the press must
  // NOT jump early, must NOT be dropped, and must fire on the landing frame.
  // Taller drop than the ledge on purpose: the ledge walk-off now ROLLS down
  // its edge corner, so airborne (and coyote expiry) starts late — from the
  // platform the coyote is long dead by y=0.30, a clean buffered-only fall.
  const buf = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const g = window.__liminal;
        const c = g.controller;
        c.respawnAt(new g.THREE.Vector3(4.9, 1.85, -4));
        c.yaw = -Math.PI / 2; // face +x: off the platform's east edge
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const ev = { tPress: -1, pressY: 0, tLand: -1, maxBeforeLand: -1, maxAfterLand: -1 };
        const frames = [];
        let phase = 0;
        const t0 = performance.now();
        const tick = () => {
          const t = performance.now() - t0;
          const y = c.feet.y;
          const gr = c.grounded;
          frames.push([+t.toFixed(1), +y.toFixed(4), gr ? 1 : 0]);
          const i = frames.length - 1;
          if (phase === 0 && i > 2 && gr) {
            phase = 1; // standing on the ledge — armed
          } else if (phase === 1 && !gr) {
            document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
            phase = 2;
          } else if (phase === 2 && !gr && y <= 0.3) {
            ev.tPress = t;
            ev.pressY = y;
            document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
            document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
            ev.maxBeforeLand = y;
            phase = 3;
          } else if (phase === 3) {
            ev.maxBeforeLand = Math.max(ev.maxBeforeLand, y); // an early jump shows here
            if (gr) {
              ev.tLand = t;
              phase = 4;
            }
          } else if (phase === 4) {
            ev.maxAfterLand = Math.max(ev.maxAfterLand, y);
            if (t > ev.tLand + 300) {
              resolve({ ev, frames });
              return;
            }
          }
          if (t < 6000) requestAnimationFrame(tick);
          else resolve({ ev, frames });
        };
        requestAnimationFrame(tick);
      }),
  );
  const be = buf.ev;
  const lead = be.tLand - be.tPress;
  console.log('jump-buffer:', JSON.stringify({
    press: +be.tPress.toFixed(0), land: +be.tLand.toFixed(0), lead: +lead.toFixed(0),
    pressY: +be.pressY.toFixed(3), maxBefore: +be.maxBeforeLand.toFixed(3),
    maxAfter: +be.maxAfterLand.toFixed(3),
  }));
  check(
    'jump-buffer: press ~50 ms before landing sits inside the 100 ms window',
    be.tPress >= 0 && be.tLand > be.tPress && lead >= 15 && lead <= 100,
    `press→land=${Number.isFinite(lead) ? lead.toFixed(0) : 'n/a'}ms`,
  );
  check(
    'jump-buffer: buffered jump fires on the landing frame (not earlier, not dropped)',
    be.tLand > 0 &&
      be.maxBeforeLand <= be.pressY + 0.01 &&
      be.maxAfterLand > 0.05,
    `maxBefore=${be.maxBeforeLand.toFixed(3)} (pressY=${be.pressY.toFixed(3)}) maxAfter=${be.maxAfterLand.toFixed(3)}m`,
  );

  // =========================================================================
  // Round-2 player-control suite (stop-on-no-input, wall contact, lips,
  // ramp smoothness, walk-off, unwalkable slide).
  // =========================================================================

  // --- 13. T2: releasing every key on the ground must BRAKE, not coast -----
  const t2r = await traceRun(['ShiftLeft', 'KeyW'], {
    spawn: [3, 0, 30], yaw: 0, ms: 2400, releaseAt: 1400,
  });
  const t2s = smooth(hSpeeds(t2r));
  const t2v0 = avgSpeedWin(t2r, t2s, 1350, 1450);
  const t2v40 = avgSpeedWin(t2r, t2s, 1420, 1470);
  const t2v200 = avgSpeedWin(t2r, t2s, 1580, 1680);
  console.log('stop:', JSON.stringify({
    v0: +t2v0.toFixed(2), v40: +t2v40.toFixed(2), v200: +t2v200.toFixed(2),
  }));
  check(
    'stop: releasing sprint on the ground halts within ~0.2 s (brake, no coast)',
    t2v0 > 4.0 && t2v40 > 1.5 && t2v200 < 1.0,
    `v@release=${t2v0.toFixed(2)} +40ms=${t2v40.toFixed(2)} +200ms=${t2v200.toFixed(2)} m/s`,
  );

  // --- 14/15. T3: 30° press into a wall — speed ≤ cap, no acceleration,
  // and the into-wall position rock-steady (no ~100 ms bounce) --------------
  const t3r = await traceRun(['ShiftLeft', 'KeyW'], {
    spawn: [-7, 0, 30], yaw: Math.PI + Math.PI / 3, ms: 3000,
  });
  const t3s = smooth(hSpeeds(t3r));
  const t3contact = t3r.find((f) => f[3] >= 31.4)?.[0] ?? -1;
  const t3early = avgSpeedWin(t3r, t3s, t3contact + 100, t3contact + 400);
  const t3late = avgSpeedWin(t3r, t3s, 2400, 2900);
  // sustained speed = max of 200 ms window means (a per-frame max is poisoned
  // by single-frame position artifacts; the sustained value is what "glides
  // really fast" means). Late-window strictness stays cap + 0.15.
  let t3maxSpd = 0;
  for (let w = t3contact + 300; w + 200 <= 2900; w += 100) {
    t3maxSpd = Math.max(t3maxSpd, avgSpeedWin(t3r, t3s, w, w + 200));
  }
  let t3into = 0;
  for (let i = 1; i < t3r.length; i++) {
    if (t3r[i][0] < t3contact + 400) continue;
    t3into = Math.max(t3into, Math.abs(t3r[i][3] - t3r[i - 1][3]));
  }
  console.log('glide:', JSON.stringify({
    contact: t3contact, early: +t3early.toFixed(2), late: +t3late.toFixed(2),
    maxSpd: +t3maxSpd.toFixed(2), into: +t3into.toFixed(4),
  }));
  check(
    'wall-glide: 30° press along a wall stays ≤ sprint cap with zero acceleration',
    t3contact > 0 && t3maxSpd <= 5.6 && t3late <= 5.55 && Math.abs(t3late - t3early) <= 0.3,
    `contact@${t3contact}ms early=${t3early.toFixed(2)} late=${t3late.toFixed(2)} sustainedMax=${t3maxSpd.toFixed(2)} (cap 5.4)`,
  );
  check(
    'wall-press: into-wall position steady while pressing (no ~100 ms bounce)',
    t3contact > 0 && t3into < 0.003,
    `max |Δz| per frame=${t3into.toFixed(4)} m`,
  );

  // --- 16. T4: head-on sprint crash is clean — no bounce, dead stop -------
  const t4r = await traceRun(['ShiftLeft', 'KeyW'], {
    spawn: [3, 0, 20], yaw: Math.PI, ms: 3200,
  });
  const t4imp = t4r.find((f) => f[3] >= 31.3)?.[0] ?? -1;
  const t4s = smooth(hSpeeds(t4r));
  const t4after = avgSpeedWin(t4r, t4s, t4imp + 300, t4imp + 800);
  let t4osc = 0;
  for (let i = 1; i < t4r.length; i++) {
    if (t4r[i][0] < t4imp + 500) continue;
    t4osc = Math.max(t4osc, Math.abs(t4r[i][3] - t4r[i - 1][3]));
  }
  console.log('impact:', JSON.stringify({
    impact: t4imp, vAfter: +t4after.toFixed(2), osc: +t4osc.toFixed(4),
  }));
  check(
    'impact: head-on sprint into a wall stops dead with no bounce/jolt',
    t4imp > 0 && t4after < 0.25 && t4osc < 0.004,
    `impact@${t4imp}ms vAfter=${t4after.toFixed(2)} into-osc=${t4osc.toFixed(4)} m`,
  );

  // --- 17/18. T5: run across the four lips — first-contact climbs at the
  //  TRUE heights (no full-stepUp pop, no slide-down) -----------------------
  const lipDefs = [
    { face: 1.8, h: 0.05, depth: 0.4 }, { face: 3.0, h: 0.1, depth: 0.4 },
    { face: 4.2, h: 0.25, depth: 0.4 }, { face: 5.5, h: 0.05, depth: 0.1 },
  ].map((l) => ({
    ...l,
    // physical first-touch: where the capsule sphere reaches the lip's top
    // edge — the real "contact frame" the climb must not lag behind
    touch: Math.sqrt(0.35 * 0.35 - (0.35 - l.h) * (0.35 - l.h)),
  }));
  const lipRun = await traceRun(['ShiftLeft', 'KeyW'], {
    spawn: [0.6, 0, 5], yaw: -Math.PI / 2, ms: 2600,
  });
  /** first frame the capsule physically reaches lip `li` (or the trace end) */
  const lipTouchI = (li) => {
    const l = lipDefs[li];
    for (let i = 1; i < lipRun.length; i++) if (lipRun[i][1] >= l.face - l.touch) return i;
    return lipRun.length;
  };
  const lipRes = lipDefs.map((lip, li) => {
    const ci = lipTouchI(li);
    let ki = -1;
    if (ci < lipRun.length) {
      for (let i = ci; i < lipRun.length; i++) {
        if (lipRun[i][2] >= lip.h - 0.015) { ki = i; break; }
      }
    }
    const nextCi = li < lipDefs.length - 1 ? lipTouchI(li + 1) : lipRun.length;
    let peak = -1;
    if (ci < lipRun.length) for (let i = ci; i < nextCi; i++) peak = Math.max(peak, lipRun[i][2]);
    // while the capsule axis is still over the lip (before its far edge) it
    // must stay ON the climbed height — a drop back = slide-down
    let minOnTop = Infinity;
    if (ki >= 0) {
      for (let i = ki; i < lipRun.length && lipRun[i][1] <= lip.face + lip.depth; i++) {
        minOnTop = Math.min(minOnTop, lipRun[i][2]);
      }
    }
    return {
      lip: lip.h, contactT: ci < lipRun.length ? +lipRun[ci][0].toFixed(0) : -1,
      lag: ci < lipRun.length && ki >= 0 ? ki - ci : -1,
      climbY: ki >= 0 ? +lipRun[ki][2].toFixed(3) : null,
      peak: +peak.toFixed(3), minOnTop: Number.isFinite(minOnTop) ? +minOnTop.toFixed(3) : null,
    };
  });
  console.log('lips:', JSON.stringify(lipRes));
  check(
    'step-lips: 0.05/0.10/0.25 lips + thin nub climb within 2 frames of contact (run speed)',
    lipRes.every((r) => r.contactT >= 0 && r.lag >= 0 && r.lag <= 2),
    lipRes.map((r) => `${r.lip}@${r.contactT}ms lag=${r.lag}`).join(' '),
  );
  check(
    'step-lips: climbs land at the true height — no full-step pop, no slide-down',
    lipRes.every((r) =>
      r.climbY != null &&
      r.climbY >= r.lip - 0.02 && r.climbY <= r.lip + 0.05 &&
      r.peak <= r.lip + 0.05 &&
      (r.minOnTop == null || r.minOnTop >= r.lip - 0.03),
    ),
    lipRes.map((r) => `${r.lip}: climb=${r.climbY} peak=${r.peak} onTop≥${r.minOnTop}`).join(' '),
  );

  // --- 19. T6: 50° ramp walk-up is smooth (mid-climb only: excludes the toe
  //  edge cases, the junction step and the walk-off fall at the end) --------
  const rcRun = await traceRun(['KeyW'], {
    spawn: [1.7, 0, -4], yaw: -Math.PI / 2, ms: 4200,
  });
  let rcMaxJerk = 0;
  let rcN = 0;
  let rcPrevY = null;
  let rcPrevT = null;
  let rcPrevVy = null;
  for (const f of rcRun) {
    // mid-climb only: x ≤ 4.5 excludes the walk-off-the-platform FALL, which
    // descends back through this y-band at x ≥ 6.5 later in the trace
    if (f[2] < 0.1 || f[2] > 1.65 || f[1] > 4.5) continue;
    if (rcPrevT != null && f[0] - rcPrevT > 4) {
      const dt = (f[0] - rcPrevT) / 1000;
      const vy = (f[2] - rcPrevY) / dt;
      if (rcPrevVy != null) rcMaxJerk = Math.max(rcMaxJerk, Math.abs(vy - rcPrevVy));
      rcPrevVy = vy;
      rcN++;
    }
    rcPrevY = f[2];
    rcPrevT = f[0];
  }
  console.log('ramp-climb:', JSON.stringify({ frames: rcN, maxJerk: +rcMaxJerk.toFixed(3) }));
  check(
    'ramp-climb: 50° walk-up mid-climb is smooth (vy steady, no stutter)',
    rcN > 20 && rcMaxJerk <= 0.5,
    `frames=${rcN} max|Δvy|=${rcMaxJerk.toFixed(3)} m/s`,
  );

  // --- 20. T7a: walking off a walkable (angled) surface must always fall --
  const woRun = await traceRun(['KeyW'], {
    spawn: [3.0, 0.85, -2.9], yaw: Math.PI, ms: 1600,
  });
  const woFallI = woRun.findIndex((f) => f[2] < 0.15);
  console.log('walk-off:', JSON.stringify({
    fallT: woFallI >= 0 ? +woRun[woFallI][0].toFixed(0) : -1,
    yEnd: +woRun[woRun.length - 1][2].toFixed(3),
  }));
  check(
    'walk-off: stepping off the 50° ramp side always falls (never held on the edge)',
    woFallI >= 0 && woRun[woFallI][0] <= 700 && woRun[woRun.length - 1][2] < 0.15,
    `fell@${woFallI >= 0 ? woRun[woFallI][0].toFixed(0) : 'never'}ms yEnd=${woRun[woRun.length - 1][2].toFixed(3)}`,
  );

  // --- 21. T7b: ≥50° faces slide — unwalkable never held -------------------
  const slRun = await traceRun([], { spawn: [7.0, 1.0, 0], yaw: 0, ms: 2500 });
  const slEnd = slRun[slRun.length - 1];
  console.log('slide-60:', JSON.stringify({
    y0: +slRun[0][2].toFixed(3), yEnd: +slEnd[2].toFixed(3), xEnd: +slEnd[1].toFixed(3),
  }));
  check(
    'slide: idle on a 60° face slides off — pin/sleep never hold unwalkable',
    slRun[0][2] > 0.5 && slEnd[2] < 0.25 && slEnd[1] < 6.5,
    `y ${slRun[0][2].toFixed(3)} -> ${slEnd[2].toFixed(3)}, xEnd=${slEnd[1].toFixed(3)}`,
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
