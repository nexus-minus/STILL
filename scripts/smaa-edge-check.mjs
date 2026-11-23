/**
 * Headless proof that the SMAA pick changes the picture, and what MSAA can and
 * cannot do behind a fullscreen post pass.
 *
 *   node --experimental-strip-types scripts/smaa-edge-check.mjs [baseURL]
 *   CHROME must point at the Playwright Chromium binary; WebGPU only runs on
 *   http://localhost, so the dev server must be up before this runs.
 *   Loads scripts/smaa-edge-harness.html (a fixed 320x200 canvas, pixel ratio 1,
 *   exactly one triangle edge in the frame) and drives the real code path
 *   (QualityManager -> FramePipeline -> PostChain).
 *
 * Test geometry, declared before measuring: the edge is the line
 *     y = (5/8)x + 1/4          (drawing-buffer pixels, y up, 1 unit = 1 pixel)
 * No pixel centre can land on the line (8j+4 = 5i+2.5 has no integer solution), so
 * the single-sample reference is a closed form, not a screenshot fit. Tone mapping
 * and the sRGB encode are pinned to identity, and the page loads with ?dither=0, so
 * the readback is the raw value the graph wrote.
 *
 * Tolerances, declared BEFORE anything is measured and not loosened afterwards:
 *  (1) 'off' must equal the analytic single-sample reference byte-exact (tol 0).
 *  (2) 'msaa' behind a fullscreen post pass must be byte-identical to 'off' (tol 0)
 *      and that pass must run with sample count 1 (tol 0) — the measured form of
 *      "MSAA does nothing there". Written from that assumption BEFORE measuring; the
 *      result is reported against it as declared, not adjusted to fit the result.
 *  (3) SMAA may only touch pixels within 2.5 px of the edge; every farther pixel
 *      must be byte-identical to 'off' (tol 0).
 *  (4) SMAA must put a value strictly between background and foreground on >= 60 %
 *      of the band pixels AND its error against the analytic coverage (std dev of
 *      the luminance error over the band) must be >= 20 % below 'off'.
 *  (5) SMAA must cost 0 extra draw calls when AA is off (tol 0) and >= 3 fullscreen
 *      draws per frame when SMAA is picked.
 *  (6) MSAA on the direct path (no fullscreen pass) must show fractional coverage on
 *      >= 1 band pixel, and the sample count three runs must read 4.
 *  (7) Costs are reported as measured (median frame time incl. the readback that
 *      waits for the GPU, draw calls per frame, target memory) — no tolerance.
 *  (9) The sample count the settings menu SHOWS must equal the count the GPU RUNS
 *      (tol 0). Declared 2026-11-23 on the owner's order, before measuring.
 *
 * Owner decisions recorded here (2026-11-23):
 *  - Tolerances (4a) and (4b) stay FAIL as declared: SMAA covers the pixels the line
 *    actually crosses (4c: 96,2 % intermediate, 24,1 % better spread) but not the band,
 *    so SMAA is NOT presented as "proven better" for the high/ultra tiers. The high and
 *    ultra presets now default to SMAA because MSAA showed no gain behind the post pass
 *    (run C: 12,60 vs 11,80 ms/frame, 1,8 % worse spread) and costs 126,6 MB at 1080p.
 *  - ultra's msaaSamples is 4, not 8, because three clamps 8 to 4 (three.webgpu.js:39100,
 *    measured as run F) and the menu must not display a number the GPU never uses.
 *  - (6) stays a BLOCKER: the multisampled target cannot be read back headless.
 *
 * Band = pixels whose centre is <= 2 px from the edge line: the region an AA filter
 * is allowed to change.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const CHROME = process.env.CHROME;
const W = 320, H = 200;

// ---- tolerances (fixed before measuring) --------------------------------
const T_EXACT = 0;                     // (1)(2)(3): byte-exact equality
const T_BAND_INTERMEDIATE_MIN = 0.60;  // (4)
const T_SPREAD_IMPROVEMENT_MIN = 0.20; // (4)
const T_BAND_RADIUS_PX = 2.5;          // (3)
const T_DISPLAY_EXACT = 0;             // (9): menu number == the number the GPU runs
const T_SMAA_CALLS_MIN = 3;            // (5)
const T_FRACTIONAL_MIN = 1;            // (6)
const T_SAMPLES_WEBGPU = 4;            // (6)
const FRAMES_TIMED = 20;               // (7)

// ---- the analytic reference (closed form) -------------------------------
const lineY = (x, shift = 0) => (5 / 8) * x + 1 / 4 + shift;
/** the harness draws the quad BELOW the line, so the reference pixel is below too */
const inside = (i, j, shift = 0) => j + 0.5 < lineY(i + 0.5, shift);

/** exact area coverage of pixel (i,j) by the half-plane below the line.
 *  Coordinates scaled by 40 -> pixel corners AND line crossings are integers,
 *  half-plane test: 8V <= 5U + 80. Shoelace over the clipped polygon. */
/** `shift` moves the line up by that many pixels (used by the movement test). */
function coverageExact(i, j, shift = 0) {
  const add = 80 + 320 * shift;
  const below = (u, v) => 8 * v <= 5 * u + add;
  const corners = [[40 * i, 40 * j], [40 * (i + 1), 40 * j],
    [40 * (i + 1), 40 * (j + 1)], [40 * i, 40 * (j + 1)]];
  const poly = [];
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4];
    const fa = 5 * a[0] + add - 8 * a[1], fb = 5 * b[0] + add - 8 * b[1];
    if (fa >= 0) poly.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      poly.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  let area = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 1600;
}

// distance from the pixel centre to the line: |5x - 8y + 2| / sqrt(89)
const distToLine = (i, j, shift = 0) => Math.abs(5 * (i + 0.5) - 8 * (j + 0.5) + 2 + 8 * shift) / Math.sqrt(89);

// Readback row 0 is the TOP row of the image (WebGPU writes row 0 first), so picture
// row j maps to world row H-1-j. Without this the reference is vertically mirrored.
const REF_INSIDE = [], REF_COV = [], REF_BAND = [], REF_CROSSED = [];
const REF_INSIDE_S = [], REF_COV_S = [], REF_BAND_S = [], REF_CROSSED_S = [];
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const wr = H - 1 - j;
    const c = coverageExact(i, wr);
    REF_INSIDE.push(inside(i, wr) ? 1 : 0);
    REF_COV.push(c);
    REF_BAND.push(distToLine(i, wr) <= T_BAND_RADIUS_PX ? 1 : 0);
    // a pixel the line actually crosses: only there can an AA filter legitimately
    // show a value between background and foreground
    REF_CROSSED.push(c > 0 && c < 1 ? 1 : 0);

    // movement test: the line moved up by 1 pixel
    const cs = coverageExact(i, wr, 1);
    REF_INSIDE_S.push(inside(i, wr, 1) ? 1 : 0);
    REF_COV_S.push(cs);
    REF_BAND_S.push(distToLine(i, wr, 1) <= T_BAND_RADIUS_PX ? 1 : 0);
    REF_CROSSED_S.push(cs > 0 && cs < 1 ? 1 : 0);
  }
}

const REFS = { inside: REF_INSIDE, cov: REF_COV, band: REF_BAND, crossed: REF_CROSSED };
const REFS_SHIFT = { inside: REF_INSIDE_S, cov: REF_COV_S, band: REF_BAND_S, crossed: REF_CROSSED_S };

let failed = 0, checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

/** one option measured in the page. Returns small aggregates, not the pixels. */
const measure = (page, { mode, tier, usePost, rtSamples, label, refs, move, settleFrames = 1, readPath = 'rt' }) =>
  page.evaluate(async (cfg) => {
    const e = window.__edge;
    if (cfg.tier) e.quality.setTier(cfg.tier);
    // what a menu pick does in main.ts: quality -> applyQuality -> pipeline.setAA
    e.quality.setOverride('antialiasing', cfg.mode);
    e.pipeline.setAA(e.quality.settings.antialiasing, e.quality.settings.msaaSamples);
    e.pipeline.setGlowEnabled(cfg.usePost); // false = forward path, no fullscreen pass
    if (cfg.move !== undefined) e.move(cfg.move);
    e.resetContexts();  // the sample counts reported below belong to this run alone

    const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
    const color = [0.25, 0.5, 0.75];
    const colorLum = lum(...color);

    let last = null;
    for (let f = 0; f < cfg.settleFrames; f++) last = e.frame({ usePost: cfg.usePost, rtSamples: cfg.rtSamples });
    if (last.error) return { label: cfg.label, error: last.error };
    const smaaPasses = last.targets.filter((t) => /SMAANode/.test(t)).length;
    const px = cfg.readPath === 'resolved' ? await e.readResolved() : await e.read();

    const W = e.W, H = e.H;
    let exactOk = true, exactOutside = true, maxDelta = 0, maxDeltaOutside = 0, band = 0, changed = 0, interp = 0, fractional = 0, nonZero = 0;
    let sum = 0, sq = 0, maxErr = 0, crossed = 0, crossedInterp = 0, cSum = 0, cSq = 0;
    for (let k = 0; k < W * H; k++) {
      const p = k * 4, r = px[p], g = px[p + 1], b = px[p + 2];
      const ref = cfg.refInside[k] ? color : [0, 0, 0];
      const d = Math.max(Math.abs(r - ref[0]), Math.abs(g - ref[1]), Math.abs(b - ref[2]));
      if (d > 0) exactOk = false;
      if (d > maxDelta) maxDelta = d;
      const l = lum(r, g, b);
      if (l > 0) nonZero++;
      if (!cfg.refBand[k]) { if (d > 0) { exactOutside = false; if (d > maxDeltaOutside) maxDeltaOutside = d; } continue; }
      band++;
      if (d > 0) changed++;
      if (l > 0 && l < colorLum) interp++;
      if (d > 0 && l > 0 && l < colorLum) fractional++;
      const err = l - cfg.refCov[k] * colorLum;
      sum += err; sq += err * err;
      if (Math.abs(err) > maxErr) maxErr = Math.abs(err);
      if (cfg.refCrossed[k]) {
        crossed++;
        if (l > 0 && l < colorLum) crossedInterp++;
        cSum += err; cSq += err * err;
      }
    }
    const mean = sum / band;
    const spread = Math.sqrt(sq / band - mean * mean);
    const cMean = cSum / crossed;
    const cSpread = Math.sqrt(cSq / crossed - cMean * cMean);

    // timing: readback waits for the GPU, so this is real GPU+CPU work per frame
    const times = [], passCounts = [];
    for (let f = 0; f < cfg.frames; f++) {
      const t0 = performance.now();
      const r = e.frame({ usePost: cfg.usePost, rtSamples: cfg.rtSamples });
      const read = cfg.readPath === 'resolved' ? e.readResolved() : e.read();
      await read;
      times.push(performance.now() - t0);
      passCounts.push(r.targets.filter((t) => /SMAANode/.test(t)).length);
    }
    times.sort((a, b) => a - b);
    const passMedian = passCounts.sort((a, b) => a - b)[passCounts.length >> 1];

    return {
      label: cfg.label, mode: cfg.mode, usePost: cfg.usePost, rtSamples: cfg.rtSamples,
      state: e.state(), calls: last.calls, smaaPasses, passMedian, targets: last.targets,
      exactOk, exactOutside, maxDelta, maxDeltaOutside, band, changed, interp, fractional, nonZero, crossed, crossedInterp,
      spread, cSpread, maxErr,
      frameMsMedian: times[times.length >> 1], frameMsMax: times[times.length - 1],
      targetBytes: W * H * 16 * (cfg.rtSamples > 0 ? cfg.rtSamples : 1), // RGBA Float readback target
    };
  }, {
    mode, tier, usePost, rtSamples, label, move, settleFrames, readPath, frames: FRAMES_TIMED,
    refInside: refs.inside, refCov: refs.cov, refBand: refs.band, refCrossed: refs.crossed,
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!CHROME) { console.error('CHROME must point at the Playwright Chromium binary'); process.exit(1); }

console.log('tolerances (fixed before measuring):');
console.log(`  (1) 'off' must equal the analytic single-sample reference: tolerance ${T_EXACT}`);
console.log(`  (2) 'msaa' behind a fullscreen post pass: byte-identical to 'off' (tol ${T_EXACT}),`);
console.log(`      and the target it draws to must run single-sample (tol ${T_EXACT})`);
console.log(`  (3) SMAA may only change pixels within ${T_BAND_RADIUS_PX} px of the edge; the rest tol ${T_EXACT}`);
console.log(`  (4) SMAA band: >= ${T_BAND_INTERMEDIATE_MIN * 100} % intermediate values AND error spread >= ${T_SPREAD_IMPROVEMENT_MIN * 100} % below 'off'`);
console.log(`  (5) SMAA fullscreen passes per frame: 0 when AA is off, >= ${T_SMAA_CALLS_MIN} when SMAA is picked`);
console.log(`  (6) MSAA on the direct path: >= ${T_FRACTIONAL_MIN} fractional band pixel, sample count must read ${T_SAMPLES_WEBGPU}`);
console.log(`  (7) costs measured over ${FRAMES_TIMED} frames (frame time includes the readback that waits for the GPU); no tolerance`);
console.log(`  (9) the number the settings row shows must equal the number the GPU runs: tol ${T_DISPLAY_EXACT}`);
console.log('  owner 2026-11-23: (4a) and (4b) stay FAIL as declared, SMAA is not sold as proven better for high/ultra;');
console.log('  ultra asks 4 samples (not 8) because three clamps 8 to 4; (6) stays a BLOCKER.');
console.log(`  band = pixels whose centre is <= 2 px from the edge line; band size = ${REF_BAND.reduce((a, b) => a + b, 0)} pixels`);

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu', '--no-sandbox'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${BASE}/scripts/smaa-edge-harness.html?dither=0`, { waitUntil: 'domcontentloaded' });

let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  ready = await page.evaluate(() => window.__edgeReady === true);
  if (!ready) await sleep(500);
}

if (!ready) {
  console.log('\nBLOCKED (not a result): the harness did not boot');
  for (const e of pageErrors) console.log(`  pageerror: ${e}`);
  await browser.close();
  process.exitCode = 1;
} else {
  const run = async (cfg) => {
    const r = await measure(page, { refs: REFS, ...cfg });
    if (r.error) console.log(`  ${r.label}: error in page -> ${r.error}`);
    return r;
  };
  const A = await run({ mode: 'off', usePost: true, rtSamples: 0, label: "A 'off' + post (reference frame)" });
  const B = await run({ mode: 'smaa', usePost: true, rtSamples: 0, label: "B 'smaa' + post" });
  const C = await run({ mode: 'msaa', usePost: true, rtSamples: 0, label: "C 'msaa' 4 + post" });
  const D = await run({ mode: 'off', usePost: true, rtSamples: 0, label: "D 'off' again after smaa (must cost nothing)" });
  // A multisampled target cannot be read directly (its resolve buffer stays empty
  // until something samples it), so the MSAA picture is read through a copy graph.
  const E = await run({ mode: 'msaa', usePost: false, rtSamples: 4, readPath: 'resolved', label: "E 'msaa' 4 direct, no fullscreen pass" });
  // F is ultra as it is now (the preset asks 4, because three clamps 8 to 4). The old
  // ultra preset asked 8; that measurement is recorded in the summary as history.
  const F = await run({ mode: 'msaa', tier: 'ultra', usePost: false, rtSamples: 4, readPath: 'resolved', label: "F 'msaa' ultra (asks 4 after the owner's change), direct" });
  // H exists to test tolerance (9) on a tier whose request is clamped: potato asks 2,
  // three runs 1. The readback is not the point here — the number the menu prints is.
  // P is the potato run. Named P, not H, because H is already the frame height (200)
  // and shadowing it made the memory line print an object.
  const P = await run({ mode: 'msaa', tier: 'potato', usePost: false, rtSamples: 2, readPath: 'resolved', label: "P 'msaa' potato (asks 2, runs 1), direct" });
  // (8) the movement test: the edge is moved 1 px up and three frames are rendered.
  //     If the passes run every frame, the picture must match the SHIFTED reference.
  const G = await measure(page, {
    mode: 'smaa', usePost: true, rtSamples: 0, move: 1, settleFrames: 3, refs: REFS_SHIFT,
    label: "G 'smaa' + post, edge moved 1 px (execution test)",
  });
  const runs = [A, B, C, D, E, F, G, P];

  console.log('\n== measured (tolerances as declared above)');
  check(`(1) 'off' equals the analytic single-sample reference`, A.exactOk,
    `maxDelta ${A.maxDelta}, changed pixels ${A.changed}`);
  check(`(2) 'msaa' behind the fullscreen post pass is byte-identical to 'off'`, C.exactOk,
    `maxDelta ${C.maxDelta}, changed ${C.changed}/${C.band}; post pass runs ${C.state.gpuSampleCount} sample, ` +
    `context sample counts [${C.state.contextSampleCounts.join(', ')}]`);
  check(`(3) SMAA only changed pixels inside the band`, B.exactOutside,
    `outside-band maxDelta ${B.maxDeltaOutside}, changed band pixels ${B.changed}/${B.band}`);
  const interpPct = B.interp / B.band;
  check(`(4a) SMAA puts intermediate values on >= ${T_BAND_INTERMEDIATE_MIN * 100} % of the band`,
    interpPct >= T_BAND_INTERMEDIATE_MIN, `${(interpPct * 100).toFixed(1)} % (${B.interp}/${B.band})`);
  const improvement = A.spread > 0 ? (A.spread - B.spread) / A.spread : 0;
  check(`(4b) SMAA edge error spread >= ${T_SPREAD_IMPROVEMENT_MIN * 100} % below 'off'`,
    improvement >= T_SPREAD_IMPROVEMENT_MIN, `off spread ${A.spread.toFixed(5)}, smaa spread ${B.spread.toFixed(5)}, improvement ${(improvement * 100).toFixed(1)} %`);
  // (4c) is the same metric restricted to the pixels the line really crosses - there
  // an AA filter can legitimately show a value between background and foreground.
  const crossedN = REFS.crossed.reduce((a, b) => a + b, 0);
  check(`(4c) SMAA shows intermediate values on >= ${T_BAND_INTERMEDIATE_MIN * 100} % of the crossed pixels`,
    B.crossedInterp / B.crossed >= T_BAND_INTERMEDIATE_MIN,
    `${(B.crossedInterp / B.crossed * 100).toFixed(1)} % (${B.crossedInterp}/${B.crossed}, crossed in frame ${crossedN})`);
  const cImp = A.cSpread > 0 ? (A.cSpread - B.cSpread) / A.cSpread : 0;
  check(`(4c) crossed-pixel error spread >= ${T_SPREAD_IMPROVEMENT_MIN * 100} % below 'off'`,
    cImp >= T_SPREAD_IMPROVEMENT_MIN, `off ${A.cSpread.toFixed(5)}, smaa ${B.cSpread.toFixed(5)}, ${(cImp * 100).toFixed(1)} %`);
  check(`(5) SMAA costs 0 fullscreen passes when AA is off`, A.smaaPasses === 0 && D.smaaPasses === 0,
    `off ${A.smaaPasses} passes/frame, off-after-smaa ${D.smaaPasses}`);
  // The hook counts renderer.setRenderTarget calls. Once three has built a cached
  // bundle for a graph it runs it without that call, so the settle-frame count is 0
  // for a run that never rebuilds; the per-frame median is the number that can be
  // compared with the tolerance.
  check(`(5) SMAA runs >= ${T_SMAA_CALLS_MIN} fullscreen passes when picked`, B.passMedian >= T_SMAA_CALLS_MIN,
    `${B.passMedian} passes/frame (median of ${FRAMES_TIMED}); the same run recorded ` +
    `${B.smaaPasses} targets in its settle frame -> the hook only sees the frames where three rebuilds the graph`);
  check(`(8) SMAA answers to a moved edge within 3 frames (so its passes really run per frame)`,
    G.exactOutside && G.crossedInterp > 0,
    `shifted reference: outside-band maxDelta ${G.maxDeltaOutside}, changed crossed pixels ${G.crossedInterp}/${G.crossed}, ` +
    `SMAA targets after the move: settle frame ${G.smaaPasses}, median over ${FRAMES_TIMED} frames ${G.passMedian}`);
  const blocked = [];
  if (E.nonZero === 0) {
    // The readback of a multisampled target stays empty in three's WebGPU backend
    // (copyTextureToBuffer reads the resolve buffer, which the backend does not fill
    // for this path), so the fractional-coverage test cannot be evaluated here.
    blocked.push(`(6) fractional coverage on the direct path: readback shows only zeros (${E.nonZero} non-zero pixels) -> cannot be measured headless`);
    console.log(`BLOCKED  (6) MSAA direct path fractional coverage: readback shows only 0 (${E.nonZero} non-zero pixels of ${W * H})`);
  } else {
    check(`(6) MSAA direct path shows fractional coverage`, E.fractional >= T_FRACTIONAL_MIN,
      `${E.fractional} fractional band pixels (${E.changed}/${E.band} changed), gpu sample count ${E.state.gpuSampleCount}`);
  }
  const geomSamples = (r) => Math.max(...r.state.contextSampleCounts);
  const geomRuns = (r) => Math.max(...r.state.contextRuns);
  check(`(6) MSAA sample count reads ${T_SAMPLES_WEBGPU} on the direct path`, geomRuns(E) === T_SAMPLES_WEBGPU,
    `geometry context runs ${geomRuns(E)} (its field holds the request ${geomSamples(E)}), ` +
    `contexts [${E.state.contextRuns.join(', ')}], pipeline getter reads ${E.state.effective}`);
  // (9) the number the settings row prints must be the number the GPU runs.
  // "what the GPU runs" is three's own effective count, read through
  // getSampleCountRenderContext (three.webgpu.js:39112 -> getSampleCount, line 39100:
  // `sampleCount >= 4 ? 4 : 1`). The render-context FIELD stores the REQUEST (potato asks 2,
  // so its field reads 2 while the GPU runs 1); the check prints both numbers.
  const displayOk = (r) =>
    r.state.menuShows === r.state.clamped &&
    (r.mode !== 'msaa' || geomRuns(r) === r.state.menuShows);
  check(`(9) menu shows the value the GPU runs (tol ${T_DISPLAY_EXACT})`,
    displayOk(C) && displayOk(E) && displayOk(F) && displayOk(P),
    `medium shows ${E.state.menuShows} runs ${geomRuns(E)}; ultra shows ${F.state.menuShows} runs ${geomRuns(F)}; ` +
    `potato shows ${P.state.menuShows} runs ${geomRuns(P)} (asks 2, three's clamp runs 1); ` +
    `first run of this check FAILed here because it compared the row with the raw context field (2) — ` +
    `tolerance unchanged, only the definition of "what the GPU runs" is now three's own function`);
  // (6b) as declared earlier measured the OLD ultra preset (asked 8, ran 4). The preset
  // now asks 4 on the owner's order, so that exact tolerance can no longer be measured
  // against the code — it is reported as changed, and the clamp itself is re-measured
  // through three's own function on two requests.
  check(`(6b) three's own clamp: ask 8 -> runs 4, ask 2 -> runs 1`,
    F.state.clampOfEight === 4 && P.state.clampOfTwo === 1,
    `getSampleCount(8) = ${F.state.clampOfEight}, getSampleCount(2) = ${P.state.clampOfTwo}; ` +
    `history: the old ultra preset asked 8 and ran 4, which is why the preset now asks 4`);

  console.log('\n== costs (measured, no tolerance)');
  for (const r of runs) {
    if (r.error) continue;
    console.log(
      `  ${r.label}: ${r.frameMsMedian.toFixed(2)} ms/frame (max ${r.frameMsMax.toFixed(2)}), ` +
      `${r.passMedian} SMAA targets/frame (median of ${FRAMES_TIMED}, settle frame ${r.smaaPasses}), ` +
      `target ${r.targetBytes} bytes, band quality spread ${r.spread.toFixed(5)}, ` +
      `intermediate ${r.interp}/${r.band}`,
    );
  }

  // SMAA memory is not a frame-time number: three's SMAANode allocates one fullscreen
  // RGBA HalfFloat target per pass (edges, weights, blend), so the cost is per texel.
  const memKB = (w, h) => (3 * w * h * 8 / 1024).toFixed(1);
  console.log('\n== SMAA target memory (analytic: 3 fullscreen RGBA16F targets, 8 bytes/texel)');
  console.log(`  test frame ${W}x${H}: ${memKB(W, H)} KB   at 1920x1080: ${memKB(1920, 1080)} KB   at 2560x1440: ${memKB(2560, 1440)} KB`);
  console.log(`  MSAA instead: samples x fullscreen RGBA16F -> 4x at 1080p = ${(1920 * 1080 * 16 * 4 / 1048576).toFixed(1)} MB, 8x = ${(1920 * 1080 * 16 * 8 / 1048576).toFixed(1)} MB`);

  if (blocked.length) {
    console.log('\n== blocked measurements (reported, not counted as pass or fail)');
    for (const b of blocked) console.log(`  ${b}`);
  }
  console.log(`\n==== summary: ${checks} checks, ${failed} failed`);
  await browser.close();
  if (failed) process.exitCode = 1;
}
