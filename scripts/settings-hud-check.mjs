/**
 * Headless check for the AA selector + the HUD performance line.
 *
 *   node --experimental-strip-types scripts/settings-hud-check.mjs [baseURL]
 *   (default baseURL http://localhost:5173 — WebGPU only works on localhost, so
 *    the dev server must be running before this runs; CHROME must point at the
 *    "Google Chrome for Testing" binary)
 *
 * What it proves:
 *   (a) every AA stage (off / msaa / smaa) sets the right pipeline setting,
 *   (b) the AA default follows the tier detection — a weak machine gets SMAA,
 *   (c) an idle frame (frozen) triggers no GPU compute dispatch,
 *   (d) the HUD line shows fps and 'frozen'.
 *
 * Part 1 runs the pure logic in node (tier presets + pipeline state, no GPU).
 * Part 2 boots the game in headless Chromium and plays the selection through the
 * real DOM, then counts real GPU compute dispatches.
 *
 * Tolerances are declared BEFORE anything is measured and are not loosened
 * afterwards: a number that misses its tolerance is printed as measured.
 */
import puppeteer from 'puppeteer-core';
import { TIER_ORDER, TIER_PRESETS, detectTier, defaultAA, QualityManager } from '../src/render/quality.ts';
import { FramePipeline } from '../src/render/pipeline.ts';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ??
  '/Users/blackphoenix15/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

// ---- tolerances, declared before measuring (fixed — do not loosen later) ----
// (a) AA stage -> pipeline setting: exact match, tolerance 0.
const T_AA_EXACT = 0;
// (b) weak machine is emulated as cores=2, deviceMemory=2; the tier the detector
//     names must match exactly, and its AA default must be 'smaa'.
const T_TIER_EXACT = 0;
const WEAK = { cores: 2, memory: 2 };
// (c) an idle frame must trigger 0 GPU compute dispatches. Tolerance 0 per frame.
//     The non-idle baseline must show at least 1 dispatch per frame, otherwise
//     the idle measurement would be trivially zero and proves nothing.
const T_IDLE_DISPATCHES_PER_FRAME = 0;
const T_BASELINE_MIN_PER_FRAME = 1;
// (d) the HUD must say 'frozen' within this many ms after the last compute
//     dispatch (the HUD refreshes every 500 ms → three refresh windows allowed).
//     Measured from the timestamp of the last dispatch to the moment the HUD first
//     read 'frozen' — a real wall-clock latency, not a proxy.
const T_HUD_LATENCY_MS = 1500;
//     HUD fps vs an independent rAF counter must agree within this % — both count
//     the same animation loop, so a gap means the HUD is lying about a frame.
const T_FPS_AGREEMENT_PCT = 15;
// sampling windows
const IDLE_FRAMES = 30;
const HUD_POLL_MS = 200;
// (e) the idle claim only means something if the player really is not moving: the
//     per-frame camera position delta over the idle window must be 0. Measured, not
//     assumed — without it a "0 dispatches" result could be an accident.
const T_CAMERA_STILLNESS = 0;
// (f) the settle window is DOCUMENTED in src/render/rt.ts:1643 as 6 frames after a
//     change. Measured as the dispatch frames between the dirty event and the first
//     frame that dispatches nothing: 1 dirty frame + 6 settle frames = 7. A window of
//     1 means the frozen picture is a single-sample frame, not the averaged one.
const T_SETTLE_WINDOW_FRAMES = 6;

/** what each tier's preset must name, and what each stage must produce */
const EXPECT = {
  potato: { aa: 'smaa', msaaSamples: 2 },
  medium: { aa: 'smaa', msaaSamples: 4 },
  high: { aa: 'msaa', msaaSamples: 4 },
  ultra: { aa: 'msaa', msaaSamples: 8 },
};
/** effective sample count per stage (SMAA is a post pass → no sample work) */
const EXPECT_SAMPLES = { off: 0, smaa: 0, msaa: null }; // null = the tier's own count

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
let failCount = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  if (!ok) { failed = true; failCount++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

console.log('tolerances:');
console.log(`  (a) AA setting: exact, tolerance ${T_AA_EXACT}`);
console.log(`  (b) weak machine cores=${WEAK.cores} memory=${WEAK.memory}: tier exact, tolerance ${T_TIER_EXACT}, default AA must be smaa`);
console.log(`  (c) compute dispatches on an idle frame: <= ${T_IDLE_DISPATCHES_PER_FRAME} per frame, baseline >= ${T_BASELINE_MIN_PER_FRAME}`);
console.log(`  (d) HUD 'frozen' within ${T_HUD_LATENCY_MS} ms of the last dispatch; fps agrees within ${T_FPS_AGREEMENT_PCT} %`);
console.log(`  (e) camera must stand still during the idle window: per-frame delta ${T_CAMERA_STILLNESS}`);
console.log(`  (f) settle window as documented in rt.ts:1643: >= 1 dirty frame + ${T_SETTLE_WINDOW_FRAMES} settle frames`);

// ============================================================================
// part 1 — pure logic (no GPU): tier presets, detection default, pipeline state
// ============================================================================
console.log('\n== part 1: logic (node, no GPU)');

// node has no deviceMemory; define the weak machine the check declares
try {
  Object.defineProperty(globalThis.navigator ?? {}, 'hardwareConcurrency', { get: () => WEAK.cores });
  Object.defineProperty(globalThis.navigator ?? {}, 'deviceMemory', { get: () => WEAK.memory });
} catch (e) {
  console.log(`  note: could not emulate navigator (${e.message})`);
}

let logicOk = true;
for (const tier of TIER_ORDER) {
  const gotMode = defaultAA(tier);
  const gotSamples = TIER_PRESETS[tier].msaaSamples;
  const exp = EXPECT[tier];
  const ok = gotMode === exp.aa && gotSamples === exp.msaaSamples;
  logicOk &&= ok;
  check(`tier ${tier}: default AA ${exp.aa}, msaa count ${exp.msaaSamples}`, ok, `got ${gotMode} / ${gotSamples}`);
}

// the weak machine is what the check declared: cores 2, memory 2
const weakTier = detectTier('webgpu');
check(
  `weak machine (cores ${WEAK.cores}, memory ${WEAK.memory}) detects ${weakTier} and defaults to ${EXPECT[weakTier].aa}`,
  defaultAA(weakTier) === 'smaa',
  `detectTier('webgpu') -> ${weakTier}, default AA ${defaultAA(weakTier)}`,
);

// pipeline state with a stand-in renderer that behaves like three's:
// `samples` is a read-only getter over the field setAA writes
const stub = { _samples: 4, get samples() { return this._samples; } };
const pipeline = new FramePipeline(stub);
for (const stage of ['off', 'msaa', 'smaa']) {
  const expected = stage === 'msaa' ? EXPECT.medium.msaaSamples : EXPECT_SAMPLES[stage];
  pipeline.setAA(stage, EXPECT.medium.msaaSamples);
  const ok =
    pipeline.aa === stage &&
    pipeline.aaSamples === expected &&
    pipeline.effectiveSamples === expected;
  check(`stage ${stage} -> pipeline setting ${expected} samples`, ok,
    `got aa=${pipeline.aa} requested=${pipeline.aaSamples} effective=${pipeline.effectiveSamples}`);
}

// ============================================================================
// part 2 — headless Chromium: the real DOM, the real GPU
// ============================================================================
console.log('\n== part 2: headless chromium (WebGPU, http://localhost)');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,720'],
});

/** in-page counters: GPU compute dispatches + rAF frames + the HUD line */
const instrument = () => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch { /* private mode */ }
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 });

  // a real compute counter: every dispatchWorkgroups three sends is recorded
  window.__gpu = { dispatches: 0 };
  const proto = window.GPUComputePassEncoder?.prototype;
  if (proto) {
    const wrap = (name) => {
      const orig = proto[name];
      if (typeof orig !== 'function') return;
      proto[name] = function (...args) {
        window.__gpu.dispatches++;
        return orig.apply(this, args);
      };
    };
    wrap('dispatchWorkgroups');
    wrap('dispatchWorkgroupsIndirect');
  }
  window.__frames = 0;
  // per-frame record: the check must be able to tell a settle-window frame from a
  // frozen frame, so every animation frame stores its dispatch count + HUD text.
  window.__frameLog = [];
  const tick = () => {
    window.__frames++;
    window.__frameLog.push({
      t: performance.now(),
      d: window.__gpu.dispatches,
      hud: document.getElementById('perf')?.textContent ?? '',
      cam: window.__liminal ? window.__liminal.camera.position.toArray().map((v) => +v.toFixed(6)) : null,
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const readState = (page) =>
  page.evaluate(() => ({
    tier: window.__liminal.quality.tier,
    setting: window.__liminal.quality.settings.antialiasing,
    pipelineAA: window.__liminal.pipeline.aa,
    requested: window.__liminal.pipeline.aaSamples,
    effective: window.__liminal.pipeline.effectiveSamples,
    persisted: JSON.parse(localStorage.getItem('liminal.settings.v1') ?? '{}').aa,
    hudVisible: !document.getElementById('perf')?.classList.contains('hidden'),
    hud: document.getElementById('perf')?.textContent ?? '',
    dispatches: window.__gpu.dispatches,
    frames: window.__frames,
  }));

let browserOk = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.evaluateOnNewDocument(instrument);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });

  for (let i = 0; i < 100 && !(await page.evaluate(() => window.__liminalReady === true).catch(() => false)); i++) {
    await sleep(200);
  }
  if (!(await page.evaluate(() => window.__liminalReady === true).catch(() => false))) {
    check('the game boots in headless chromium', false, logs.join(' | ').slice(0, 300));
  } else {
    browserOk = true;

    // (b) live: the weak machine the check declared must land on the weak tier
    // and its AA default must be SMAA
    const boot = await readState(page);
    check(
      `boot on the declared weak machine: tier ${weakTier}, AA default smaa`,
      boot.tier === weakTier && boot.setting === 'smaa',
      `got tier=${boot.tier} aa=${boot.setting}`,
    );

    // (a) play every stage through the DOM for every tier
    for (const tier of TIER_ORDER) {
      await page.evaluate((t) => window.__liminal.quality.setTier(t), tier);
      for (const stage of ['off', 'msaa', 'smaa']) {
        await page.evaluate((m) => {
          const sel = document.getElementById('set-aa');
          sel.value = m;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, stage);
        await sleep(150); // the pipeline applies on the change event
        const got = await readState(page);
        const expected = stage === 'msaa' ? EXPECT[tier].msaaSamples : EXPECT_SAMPLES[stage];
        const ok =
          got.setting === stage &&
          got.pipelineAA === stage &&
          got.requested === expected &&
          got.effective === expected &&
          got.persisted === stage;
        check(`tier ${tier} + stage ${stage} -> ${expected} samples`, ok,
          `got setting=${got.setting} pipeline=${got.pipelineAA} requested=${got.requested} effective=${got.effective} persisted=${got.persisted}`);
      }
    }

    // (d) the HUD line: player-facing, on by default, must show fps + frozen
    check('HUD performance line is visible by default', boot.hudVisible === true);

    // (c) compute work. Headless has no player input, so a non-idle frame has to be
    // created on purpose: a settings change is a dirty event for the scheduler
    // (src/render/rt.ts:1728), and the frames of the settle window that follow it are
    // the frames that must run rays. Only after that can "an idle frame costs nothing"
    // mean anything — otherwise the baseline window is already frozen and a 0 is trivial.
    await page.evaluate(() => window.__liminal.quality.setTier('medium'));
    await page.evaluate(() => {
      window.__frameLog.length = 0;
      // rt.ts setLightGain() marks the frame dirty -> the next frame must run rays
      window.__liminal.quality.setOverride('lightGain', 1.2);
    });
    await sleep(1500); // the settle window plus one HUD refresh
    const baseLog = await page.evaluate(() => window.__frameLog);
    const deltas = [];
    for (let i = 1; i < baseLog.length; i++) deltas.push(baseLog[i].d - baseLog[i - 1].d);
    const freezeIdx = deltas.findIndex((x) => x === 0);
    if (freezeIdx < 1) {
      check(`baseline: a non-idle frame costs >= ${T_BASELINE_MIN_PER_FRAME} dispatch`, false,
        `no settle-window dispatch measured (${deltas.length} frames: [${deltas.join(', ')}])`);
    } else {
      const settle = deltas.slice(0, freezeIdx);
      const minSettle = Math.min(...settle);
      check(`baseline: every frame of the settle window costs >= ${T_BASELINE_MIN_PER_FRAME} dispatch`,
        minSettle >= T_BASELINE_MIN_PER_FRAME,
        `settle window ${settle.length} frames, min ${minSettle}, per frame [${settle.join(', ')}]`);
      check(`settle window is the documented ${T_SETTLE_WINDOW_FRAMES} settle frames (rt.ts:1643)`,
        settle.length >= 1 + T_SETTLE_WINDOW_FRAMES,
        `measured ${settle.length} dispatch frames, needs 1 dirty frame + ${T_SETTLE_WINDOW_FRAMES} settle frames`);

      // idle window: from the first frame that dispatched nothing. The camera being
      // still is the condition that makes the freeze legal, so it is measured too.
      let log = baseLog;
      for (let i = 0; i < 60 && log.length - freezeIdx < IDLE_FRAMES + 1; i++) {
        await sleep(HUD_POLL_MS);
        log = await page.evaluate(() => window.__frameLog);
      }
      const idle = log.slice(freezeIdx);
      const idleDeltas = [];
      for (let i = 1; i < idle.length; i++) idleDeltas.push(idle[i].d - idle[i - 1].d);
      const idleTotal = idleDeltas.reduce((a, b) => a + b, 0);
      const idlePerFrame = idleDeltas.length > 0 ? idleTotal / idleDeltas.length : 0;
      check(`idle frame costs <= ${T_IDLE_DISPATCHES_PER_FRAME} compute dispatches`,
        idlePerFrame <= T_IDLE_DISPATCHES_PER_FRAME,
        `${idlePerFrame.toFixed(2)} per frame (${idleTotal} dispatches / ${idleDeltas.length} frames)`);

      let maxCamDelta = 0;
      for (let i = 1; i < idle.length; i++) {
        if (!idle[i].cam || !idle[i - 1].cam) continue;
        const d = idle[i].cam.reduce((a, v, k) => a + Math.abs(v - idle[i - 1].cam[k]), 0);
        if (d > maxCamDelta) maxCamDelta = d;
      }
      check(`camera stands still during the idle window (tolerance ${T_CAMERA_STILLNESS})`,
        maxCamDelta <= T_CAMERA_STILLNESS, `max per-frame delta ${maxCamDelta}`);

      // the real wall-clock latency: the last frame that ran ray work -> the first
      // HUD reading that says 'frozen'. The HUD refreshes every 500 ms, so
      // T_HUD_LATENCY_MS is one refresh window plus a poll margin.
      const lastWorkFrame = baseLog[freezeIdx - 1];
      const hudAt = log.find((e) => /frozen/.test(e.hud) && e.t > lastWorkFrame.t);
      if (!hudAt) {
        check(`HUD reports 'frozen' after standing still`, false, `hud="${log.at(-1)?.hud ?? ''}"`);
      } else {
        const latencyMs = hudAt.t - lastWorkFrame.t;
        check(`HUD shows 'frozen' within ${T_HUD_LATENCY_MS} ms of the last ray work`,
          latencyMs <= T_HUD_LATENCY_MS,
          `measured ${latencyMs.toFixed(0)} ms (last work frame ${lastWorkFrame.t.toFixed(0)}, HUD read ${hudAt.t.toFixed(0)})`);
      }

      const hudText = log.at(-1)?.hud ?? '';
      const hudFps = Number((hudText.match(/(\d+)\s*fps/) ?? [])[1] ?? 0);
      check(`HUD line shows an fps number AND the word 'frozen'`,
        hudFps > 0 && /frozen/.test(hudText), `hud="${hudText}"`);

      const seconds = (idle.at(-1).t - idle[0].t) / 1000;
      const measuredFps = seconds > 0 ? idleDeltas.length / seconds : 0;
      const diffPct = measuredFps > 0 ? (Math.abs(hudFps - measuredFps) / measuredFps) * 100 : 100;
      check(`HUD fps agrees with the independent rAF counter within ${T_FPS_AGREEMENT_PCT} %`,
        diffPct <= T_FPS_AGREEMENT_PCT,
        `hud=${hudFps} measured=${measuredFps.toFixed(1)} diff=${diffPct.toFixed(1)} %`);
    }
  }
  await page.close();
} finally {
  await browser.close();
}

console.log(`\n==== summary: ${checks} checks, ${failCount} failed — tolerances fixed before measuring (logic ok=${logicOk}, live part ran=${browserOk})`);
if (failed) process.exitCode = 1;
