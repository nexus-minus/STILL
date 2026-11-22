/**
 * À-trous denoiser proof — headful Chromium WebGPU.
 *
 *   node scripts/rt-denoise-smoke.mjs [url] [label] [phase,...]
 *
 * Phases (each = one page load; screenshots + JSON to /tmp/opencode/rt-denoise/):
 *   noise      — flat-wall grid readback, STATIC (temporal converged) vs LIVE
 *                (camera oscillating so blendAlpha=1 every frame), plus the
 *                fixture-pool line profile and both screenshots. Proves (a)
 *                noise while moving and (c) static structure/checkerboard.
 *   edge-raw   — ?rtdebug=3: line of pixels across the strongest geometric
 *                silhouettes of the RAW lighting buffer (isolates the old
 *                depth-blind 5-tap cross, which lived in the composite)
 *   edge-comp  — same framing, normal composite: the user-visible edge profile
 *   testroom   — ?testroom boots rt=armed with zero pageerrors
 *
 * Numbers come from CANVAS PIXEL READS taken inside requestAnimationFrame —
 * the WebGPU canvas only holds a readable frame right after it is rendered
 * (an arbitrary-time drawImage yields an all-black buffer).
 *
 * Edge picks are ranked GEOMETRY-ONLY (raycast against the non-emissive scene
 * meshes — the same set the RT primary ray sees) and regions are picked by
 * geometry too, so before/after runs select identical targets; only the luma
 * values differ. Results land in <OUT>/<label>.json for diffing.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5181';
const LABEL = process.argv[3] ?? 'run';
const ONLY = process.argv[4]
  ? process.argv[4].split(',').map((s) => s.trim())
  : null;
const OUT = '/tmp/opencode/rt-denoise';
const CHROME = '/usr/bin/chromium';
const XDG = '/tmp/opencode/chromium-xdg-clean';
mkdirSync(OUT, { recursive: true });
mkdirSync(XDG, { recursive: true });

/** freecam framing (same as rt-softshadow-smoke's `frame` option) */
const SUNKEN = { pos: [0.93, 1.6, 1.2], look: [0.93, 0.1, 3.13] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  protocolTimeout: 300000, // a frame read can outlive a slow/hidden tab
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu'],
});

const results = { label: LABEL, base: BASE, phases: {} };
/** a frame read that times out means the document is dying — reuse the
 *  navigation error so `run()` retries the phase instead of hanging CDP */
const readFailed = (what) => {
  throw new Error(`Execution context was destroyed (frame read timed out: ${what})`);
};
/**
 * Run a phase, retrying if the page navigates mid-measure. Editing THIS
 * script makes vite full-reload the dev server's page, which destroys the
 * evaluate context — a retry re-boots and redoes the phase cleanly.
 */
const run = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/Execution context was destroyed|Target closed|closed/.test(msg)) throw e;
      console.log(`  ~ ${name}: page went away mid-run (${msg.slice(0, 60)}…) retry ${attempt + 1}/3`);
      await sleep(3000);
    }
  }
  fail(`${name}: gave up after repeated navigations`);
};

/** boot, dismiss overlays, assert rt=armed + clean console */
async function boot(url, name) {
  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('framenavigated', (f) => logs.push(`[nav] ${f.url()}`));
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.clear(); } catch { /* private mode */ }
  });
  // Pin the freeze off. These readback asserts were calibrated on a dispatch EVERY
  // frame; with the idle freeze a static scene stops dispatching after the settle
  // window, so a measurement would describe a settle-window average instead of the
  // converged values the thresholds expect. These scripts proof the shader, not the
  // scheduler (docs/render-pipeline.md → "Anti-banding + idle frame").
  const target = `${url}${url.includes('?') ? '&' : '?'}settle=0`;
  console.log(`\n== ${name}: ${target}`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let booted = false;
  for (let i = 0; i < 150 && !booted; i++) {
    booted = await page.evaluate(() => window.__liminalReady === true).catch(() => false);
    if (!booted) await sleep(200);
  }
  if (!booted) { fail(`${name}: never reached __liminalReady`); await page.close(); return null; }
  await page.bringToFront(); // a background tab gets its rAF throttled to 0

  const boots = logs.filter((l) => l.includes('[liminal] up'));
  const bootLine = boots[boots.length - 1] ?? '';
  console.log(`  boot: ${bootLine.split('\n')[0].slice(0, 140)}`);
  if (boots.length > 1) console.log(`  !! ${boots.length} boots — the page reloaded mid-run`);
  for (const l of logs.filter((l) => /\[nav\]|reload|black|recover|forcegl/i.test(l))) {
    console.log(`  note: ${l.slice(0, 170)}`);
  }
  if (bootLine.includes('rt=armed')) ok(`${name}: rt=armed`);
  else fail(`${name}: rt not armed (${bootLine.match(/rt=\S+/)?.[0] ?? 'no boot line'})`);
  for (const l of logs.filter((l) => l.startsWith('[liminal][webgpu]'))) {
    fail(`${name}: WebGPU error: ${l.slice(0, 160)}`);
  }
  for (const e of errors) fail(`${name}: pageerror: ${e.slice(0, 160)}`);
  return { page, logs, bootLine };
}

/** force the start-screen/settings overlays shut (they re-pop during waits) */
async function hideOverlays(page) {
  await page.evaluate(() => {
    const hide = () => document.getElementById('overlay')?.classList.add('hidden');
    hide();
    const resume = [...document.querySelectorAll('button')].find(
      (b) => /^resume$/i.test((b.textContent ?? '').trim()),
    );
    if (resume && resume.offsetParent !== null) resume.click();
    hide();
  });
}

/**
 * frame → settle → install helpers, retrying if vite reloaded the page
 * mid-settle (editing this very script makes vite full-reload, which drops
 * both the freecam framing and window.__dn).
 */
async function prep(page, fr, ms = 4500) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // a reload mid-wait leaves the game still booting — wait it out first
    for (let i = 0; i < 60; i++) {
      const ready = await page.evaluate(() => window.__liminalReady === true).catch(() => false);
      if (ready) break;
      await sleep(200);
    }
    await frame(page, fr);
    await sleep(ms);
    await hideOverlays(page);
    await sleep(400);
    await installHelpers(page);
    const st = await page.evaluate((f) => {
      const c = window.__liminal.camera;
      const drift = Math.hypot(
        c.position.x - f.pos[0], c.position.y - f.pos[1], c.position.z - f.pos[2]);
      return { drift, hasDn: !!window.__dn };
    }, fr);
    if (st.hasDn && st.drift < 0.05) return;
    console.log(`  re-prep #${attempt + 1} (helpers=${st.hasDn} drift=${st.drift.toFixed(2)}m)`);
    ms = 3500;
  }
  fail('prep: could not hold the framing/helpers (page kept reloading?)');
}

/** in-page helpers: frame-timed canvas readback + the RT primary-ray mesh set */
async function installHelpers(page) {
  await page.evaluate(() => {
    const L = window.__liminal;
    const canvas = () => document.querySelector('canvas#game');
    const scale = () => canvas().width / window.innerWidth;
    const isEmissive = (o) => {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      return mats.some((m) => m && m.emissive && (m.emissiveIntensity ?? 1) > 0
        && m.emissive.r + m.emissive.g + m.emissive.b > 0.01);
    };
    // the RT primary ray sees the SHADOW mesh set (emissive fixtures are
    // excluded from the BVH) — mirror that so picks match the lighting buffer
    const shadowObjs = [];
    L.scene.traverse((o) => { if (o.isMesh && !isEmissive(o)) shadowObjs.push(o); });

    // ALL coordinates in this helper are CANVAS pixels (no CSS scaling) —
    // the raycast NDCs are derived from canvas px too, so they agree.
    //
    // The WebGPU canvas only holds a readable frame INSIDE the animation
    // frame (post-present reads come back blank), so every read runs on the
    // next rAF — and every read carries a timeout, because a navigating or
    // hidden document stops delivering rAF callbacks entirely.
    const nextFrame = (fn) => new Promise((res) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; res(null); } }, 3000);
      requestAnimationFrame(() => {
        if (done) return;
        done = true;
        clearTimeout(to);
        res(fn());
      });
    });

    /** luma (0..255) of a canvas-pixel rect, read right after a fresh frame */
    const readLuma = (x, y, w, h) => nextFrame(() => {
      const c = canvas();
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0);
      const d = g.getImageData(Math.round(x), Math.round(y),
        Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
      const out = new Float32Array(d.length / 4);
      for (let i = 0; i < out.length; i++) {
        out[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
      }
      // plain array: puppeteer serialises typed arrays as objects
      return Array.from(out);
    });

    /** coordinates of the brightest pixel (whole-frame scan stays in-page) */
    const brightest = () => nextFrame(() => {
      const c = canvas();
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let bi = 0, bv = -1;
      for (let i = 0; i < d.length; i += 4) {
        const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (v > bv) { bv = v; bi = i / 4; }
      }
      return { x: bi % c.width, y: (bi / c.width) | 0 };
    });

    const raycast = (nx, ny) => {
      const ray = new L.THREE.Raycaster();
      ray.setFromCamera(new L.THREE.Vector2(nx, ny), L.camera);
      const h = ray.intersectObjects(shadowObjs, false)[0] ?? null;
      if (h && h.face) h.worldNormal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      return h;
    };

    window.__dn = { readLuma, brightest, raycast, canvas, scale };
  });
}

/** apply a freecam framing (same math as rt-softshadow-smoke) */
async function frame(page, f) {
  await page.evaluate((fr) => {
    const L = window.__liminal;
    if (!L.controller.freecam) L.controller.toggleFreecam();
    const [px, py, pz] = fr.pos;
    const [tx, ty, tz] = fr.look;
    L.camera.position.set(px, py, pz);
    const dx = tx - px, dy = ty - py, dz = tz - pz;
    L.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
  }, f);
}

/** luma statistics of a region: spread, high-frequency energy, checkerboard */
const stats = (l, w, h) => {
  const n = w * h;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += l[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (l[i] - mean) ** 2;
  // high-frequency residual: distance from the 4-neighbour mean. A smooth
  // lighting gradient contributes ~0, per-pixel noise contributes its amplitude
  let hf = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      hf += Math.abs(l[i] - (l[i - 1] + l[i + 1] + l[i - w] + l[i + w]) / 4);
      cnt++;
    }
  }
  // checkerboard: energy at the (pi,pi) Nyquist corner — the artefact the
  // old raw buffer showed around embedded fixtures
  let cb = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) cb += ((x + y) & 1 ? 1 : -1) * (l[y * w + x] - mean);
  }
  return {
    mean: r1(mean),
    sd: r1(Math.sqrt(ss / n)),
    hf: r2(hf / cnt),
    cb: r2(Math.abs(cb) / n),
  };
};

// ---------------------------------------------------------------------------
// noise: flat wall, static vs live (+ fixture pool line)
// ---------------------------------------------------------------------------
await run('noise', async () => {
  const b = await boot(`${BASE}/`, 'noise');
  if (!b) return;
  const { page } = b;
  await prep(page, SUNKEN);

  // pick a flat, centre-most region — GEOMETRY ONLY (the luma guard only
  // rejects black/clipped rects), so before/after choose the identical one.
  // The whole map is ONE mesh, so "same object" proves nothing: flatness is
  // face-normal agreement + no depth step across the rect instead.
  const pick = await page.evaluate(() => {
    const c = window.__dn.canvas();
    const W = c.width, H = c.height;
    const R = 64;
    const cands = [];
    let tested = 0;
    for (let y = 48; y + R < H - 48; y += 40) {
      for (let x = 48; x + R < W - 48; x += 40) {
        const pts = [[x, y], [x + R, y], [x, y + R], [x + R, y + R], [x + R / 2, y + R / 2]];
        const hits = pts.map(([px, py]) => window.__dn.raycast((px / W) * 2 - 1, 1 - (py / H) * 2));
        if (hits.some((h) => h === null)) continue;
        tested++;
        const ds = hits.map((h) => h.distance);
        const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
        const spread = (Math.max(...ds) - Math.min(...ds)) / mean;
        if (spread > 0.12) continue;                       // depth step inside the rect
        const n0 = hits[0].face.normal;
        let worst = 0;
        for (const h of hits.slice(1)) {
          const n = h.face.normal;
          worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, n0.dot(n)))));
        }
        if (worst > (10 * Math.PI) / 180) continue;        // not one plane
        cands.push({ x, y, w: R, h: R, spread: +spread.toFixed(4), tilt: +(worst * 180 / Math.PI).toFixed(1),
          dist: +mean.toFixed(3),
          score: Math.abs(x + R / 2 - W / 2) + Math.abs(y + R / 2 - H / 2) });
      }
    }
    cands.sort((a, b2) => a.score - b2.score || a.y - b2.y || a.x - b2.x);
    return { total: cands.length, tested, cands: cands.slice(0, 8) };
  });
  console.log(`  region search: ${pick.tested} rects hit geometry, ${pick.total} are planar`);
  if (!pick.cands.length) fail('noise: no planar region in view');

  let region = null;
  for (const cand of pick.cands) {
    const l = await page.evaluate((r) => window.__dn.readLuma(r.x, r.y, r.w, r.h), cand);
    if (!l) readFailed('region-candidate');
    const mean = l.reduce((a, b) => a + b, 0) / l.length;
    console.log(`  candidate [${cand.x},${cand.y}] depth ${cand.dist}m spread ${(cand.spread * 100).toFixed(1)}% tilt ${cand.tilt}° luma ${r1(mean)}`);
    if (mean >= 12 && mean <= 215) { region = { ...cand, luma: r1(mean) }; break; }
  }
  if (!region) { fail('noise: no usable flat region'); await page.close(); return; }
  ok(`noise: flat ${region.w}x${region.h} region at [${region.x},${region.y}] on ONE surface ${region.dist}m away (depth spread ${(region.spread * 100).toFixed(1)}%)`);

  const readRegion = async () => {
    const l = await page.evaluate((r) => window.__dn.readLuma(r.x, r.y, r.w, r.h), region);
    if (!l) readFailed('region');
    return l;
  };
  const avgStats = async (n, gap) => {
    const acc = [];
    for (let i = 0; i < n; i++) { acc.push(stats(await readRegion(), region.w, region.h)); if (gap) await sleep(gap); }
    const m = (k) => r2(acc.reduce((a, s) => a + s[k], 0) / acc.length);
    return { mean: m('mean'), sd: m('sd'), hf: m('hf'), cb: m('cb') };
  };

  // --- static (temporal converged) ---
  const st = await avgStats(3, 250);
  console.log(`  STATIC   mean ${st.mean}  sd ${st.sd}  hf ${st.hf}  checker ${st.cb}`);
  const staticGrid = await readRegion();
  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/${LABEL}-noise-static.png` });

  // --- fixture pool structure (static, same framing, canvas px) ---
  // Noise metrics run on the raw samples; STRUCTURE runs on a 9x9 box-smoothed
  // copy so residual noise cannot masquerade as detail (or hide its loss).
  const pool = await page.evaluate(async () => {
    const b = await window.__dn.brightest();
    if (!b) return null;
    const R = 64, W = R * 2, H = R * 2;
    const x0 = Math.max(0, Math.min(1280 - W, b.x - R));
    const y0 = Math.max(0, Math.min(720 - H, b.y - R));
    const l = await window.__dn.readLuma(x0, y0, W, H);
    if (!l) return null;
    const n = W * H;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += l[i];
    const mean = sum / n;
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (l[i] - mean) ** 2;
    let hf = 0, cnt = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        hf += Math.abs(l[i] - (l[i - 1] + l[i + 1] + l[i - W] + l[i + W]) / 4);
        cnt++;
      }
    }
    let cb = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) cb += ((x + y) & 1 ? 1 : -1) * (l[y * W + x] - mean);
    }
    const sm = new Float64Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, k = 0;
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
            s += l[yy * W + xx]; k++;
          }
        }
        sm[y * W + x] = s / k;
      }
    }
    let gmax = 0, smss = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        gmax = Math.max(gmax, Math.abs(sm[i + 1] - sm[i - 1]) / 2, Math.abs(sm[i + W] - sm[i - W]) / 2);
      }
    }
    for (let i = 0; i < n; i++) smss += (sm[i] - mean) ** 2;
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;
    const line = await window.__dn.readLuma(Math.max(0, b.x - 100), b.y, 201, 1);
    return {
      core: [b.x, b.y], rect: [x0, y0, W, H],
      mean: r1(mean), sd: r1(Math.sqrt(ss / n)),
      hf: r2(hf / cnt), checker: r2(Math.abs(cb) / n),
      structSd: r1(Math.sqrt(smss / n)), structGrad: r2(gmax),
      line: line ? Array.from(line, Math.round) : null,
    };
  });
  if (!pool) readFailed('pool-structure');
  console.log(`  POOL     mean ${pool.mean} sd ${pool.sd} hf ${pool.hf} checker ${pool.checker} | struct(sd ${pool.structSd} grad ${pool.structGrad})`);

  // --- live: oscillate the camera so blendAlpha = 1 every frame ---
  await page.evaluate(() => {
    const L = window.__liminal;
    const cam = L.camera;
    // CONSTANT-SPEED triangle waves on x and z. A sine has zero-velocity
    // instants where |dx|+|dz| dips under dispatch's 0.003 "camera moved"
    // threshold — then blendAlpha drops to 0.08, the temporal history kicks
    // back in and the "live" sample would silently be a converged one.
    // |Δ| per tick is 2*amplitude/period for a triangle wave: 0.004 + 0.0026.
    window.__dnMotion = { on: true, base: cam.position.clone(), t: 0, minStep: 99, last: null };
    const tri = (t, period) => {
      const p = ((t % (2 * period)) + 2 * period) % (2 * period);
      return p < period ? (p / period) * 2 - 1 : 1 - ((p - period) / period) * 2;
    };
    const tick = () => {
      const m = window.__dnMotion;
      if (m.on) {
        m.t += 1;
        cam.position.x = m.base.x + 0.03 * tri(m.t, 15);
        cam.position.z = m.base.z + 0.025 * tri(m.t + 7, 19);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // measure the step the DISPATCH actually sees (position sampled where
    // advanced.dispatch reads it), not the one the oscillation intends —
    // anything else could hide a controller overwrite
    const origPipe = L.pipeline.render.bind(L.pipeline);
    L.pipeline.render = (a) => {
      const m = window.__dnMotion;
      if (m.last) {
        const step = Math.abs(cam.position.x - m.last.x) + Math.abs(cam.position.z - m.last.z);
        if (step > 0) m.minStep = Math.min(m.minStep, step);
      }
      m.last = { x: cam.position.x, z: cam.position.z };
      origPipe(a);
    };
  });
  await sleep(1600);
  const live = await avgStats(5, 200);
  const minStep = await page.evaluate(() => window.__dnMotion.minStep);
  console.log(`  LIVE     mean ${live.mean}  sd ${live.sd}  hf ${live.hf}  checker ${live.cb}`);
  console.log(`  motion   min camera step/frame ${minStep.toFixed(4)} (dispatch treats >0.003 as moving)`);
  if (minStep <= 0.003) fail(`noise: camera step ${minStep.toFixed(4)} <= 0.003 — temporal never reset, "live" is not live`);
  else ok(`noise: camera genuinely moving (min step ${minStep.toFixed(4)} > 0.003)`);
  // NOTE: live≈static is the SUCCESS state once the denoiser works, so this
  // is reported rather than asserted — sensitivity comes from the before/after
  // diff of the same numbers.
  console.log(`  compare  static hf ${st.hf} → live hf ${live.hf} (ratio ${r2(live.hf / Math.max(st.hf, 1e-6))})`);
  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/${LABEL}-noise-moving.png` });
  const liveGrid = await readRegion();
  await page.evaluate(() => { window.__dnMotion.on = false; });

  results.phases.noise = { region, static: st, live, minStep: +minStep.toFixed(4), pool, staticGrid, liveGrid };
  await page.close();
});

// ---------------------------------------------------------------------------
// edge: line of pixels across the strongest geometric silhouettes
// ---------------------------------------------------------------------------
async function edgePhase(name, url, fr) {
  const b = await boot(url, name);
  if (!b) return;
  const { page } = b;
  await prep(page, fr);

  const found = await page.evaluate(() => {
    // geometry-only ranking: the same edges are picked before and after.
    // Scans horizontal AND vertical lines — silhouettes come in both flavours.
    const cands = [];
    // a candidate is a DEPTH step or a NORMAL discontinuity — the two ways
    // light can cross a geometry edge. `solid` = both sides are real surface
    // (a void boundary can never show bleed: void pixels have zero diffuse).
    const addLine = (samples, axis) => {
      for (let k = 1; k < samples.length; k++) {
        const a = samples[k - 1], b = samples[k];
        const aV = !Number.isFinite(a.d), bV = !Number.isFinite(b.d);
        if (aV && bV) continue;
        const rel = aV || bV ? 1 : Math.abs(a.d - b.d) / Math.min(a.d, b.d);
        let ang = 90;
        if (!aV && !bV && a.n && b.n) {
          ang = Math.acos(Math.min(1, Math.max(-1, a.n.dot(b.n)))) * 180 / Math.PI;
        }
        if (rel < 0.05 && ang < 25) continue;
        cands.push({ axis, k, t: samples[k].t, solid: !aV && !bV,
          rel: +rel.toFixed(3), ang: Math.round(ang),
          score: +(rel + ang / 60).toFixed(3),
          d0: aV ? null : +a.d.toFixed(2), d1: bV ? null : +b.d.toFixed(2) });
      }
    };
    const HSTEPS = 161, VSTEPS = 121;
    for (let i = 0; i < 15; i++) {
      const ry = -0.7 + (1.4 * i) / 14;
      const s = [];
      for (let k = 0; k < HSTEPS; k++) {
        const h = window.__dn.raycast(-1 + (2 * k) / (HSTEPS - 1), ry);
        s.push({ t: ry, d: h ? h.distance : Infinity, n: h ? h.worldNormal : null });
      }
      addLine(s, 'h');
    }
    for (let i = 0; i < 13; i++) {
      const nx = -0.85 + (1.7 * i) / 12;
      const s = [];
      for (let k = 0; k < VSTEPS; k++) {
        const h = window.__dn.raycast(nx, 1 - (2 * k) / (VSTEPS - 1));
        s.push({ t: nx, d: h ? h.distance : Infinity, n: h ? h.worldNormal : null });
      }
      addLine(s, 'v');
    }
    // solid (both-sides-surface) edges first — those are where bleed shows;
    // then a geometry-only score, so before/after pick the SAME edges
    cands.sort((p, q) => (q.solid ? 1 : 0) - (p.solid ? 1 : 0)
      || q.score - p.score || p.axis.localeCompare(q.axis) || p.k - q.k);
    const picked = [];
    for (const t of cands) {
      if (picked.every((p) => p.axis !== t.axis || Math.abs(p.k - t.k) > 10
        || Math.abs(p.t - t.t) > 0.2)) picked.push(t);
      if (picked.length === 5) break;
    }
    return { total: cands.length, picked };
  });
  console.log(`  ${found.total} geometry edges; ranking:`);
  for (const p of found.picked) {
    console.log(`    ${p.axis}@${p.t.toFixed(2)} k${p.k} score ${p.score} rel ${p.rel} normalΔ ${p.ang}° ${p.solid ? 'solid' : 'void-edge'} depth ${p.d0 ?? 'void'}→${p.d1 ?? 'void'}`);
  }
  if (!found.picked.length) fail(`${name}: no geometry edge found in framing`);

  // read each edge's 41-px line, averaged over 6 frames (static → converged)
  const lines = await page.evaluate(async (picked) => {
    const c = window.__dn.canvas();
    const W = c.width, H = c.height;
    const N = 41, FRAMES = 6;
    const HSTEPS = 161, VSTEPS = 121;
    const out = [];
    for (const p of picked) {
      let x0, y0, dx, dy, col, row;
      if (p.axis === 'h') {
        row = Math.round(((1 - p.t) / 2) * H);
        col = Math.round(((p.k - 0.5) / (HSTEPS - 1)) * W);
        x0 = Math.max(0, Math.min(W - N, col - (N >> 1)));
        y0 = Math.max(0, Math.min(H - 1, row));
        dx = 1; dy = 0;
      } else {
        col = Math.round(((p.t + 1) / 2) * W);
        row = Math.round(((p.k - 0.5) / (VSTEPS - 1)) * H);
        x0 = Math.max(0, Math.min(W - 1, col));
        y0 = Math.max(0, Math.min(H - N, row - (N >> 1)));
        dx = 0; dy = 1;
      }
      let acc = null, len = 0;
      for (let f = 0; f < FRAMES; f++) {
        const d = await window.__dn.readLuma(x0, y0, dx ? N : 1, dy ? N : 1);
        if (!d) return null; // document going away
        if (!acc) { acc = new Float64Array(d.length); len = d.length; }
        for (let i = 0; i < len; i++) acc[i] += d[i];
      }
      // index of the edge inside the profile — clamping x0/y0 can push it
      // away from the middle, and every metric below is relative to it
      const ei = dx ? (col - x0) : (row - y0);
      out.push({ ...p, x: x0, y: y0, ei: Math.max(0, Math.min(len - 1, ei)),
        profile: Array.from(acc, (v) => Math.round(v / FRAMES)) });
    }
    return out;
  }, found.picked);

  if (!lines) readFailed('edge-profiles');
  const meanRange = (a, lo, hi) => {
    const l = Math.max(0, lo), h = Math.min(a.length, hi);
    if (h - l < 3) return null;
    let s = 0;
    for (let i = l; i < h; i++) s += a[i];
    return s / (h - l);
  };
  const edges = lines.map((e) => {
    const p = e.profile, L = p.length;
    const ei = Math.max(0, Math.min(L - 1, e.ei));
    // which side is dark — decided by the pixels right next to the edge
    const nearL = meanRange(p, ei - 6, ei);
    const nearR = meanRange(p, ei + 1, ei + 7);
    const plateL = meanRange(p, ei - 16, ei - 8);
    const plateR = meanRange(p, ei + 8, ei + 17);
    const lo2 = Math.min(...p), hi2 = Math.max(...p);
    if (nearL == null || nearR == null || hi2 - lo2 < 5) {
      return { axis: e.axis, t: e.t, x: e.x, y: e.y, ei, rel: e.rel, ang: e.ang,
        solid: e.solid, score: e.score, d0: e.d0, d1: e.d1,
        contrast: Math.round(hi2 - lo2), note: 'too little contrast', profile: p };
    }
    const darkLeft = nearL <= nearR;
    const dark = darkLeft ? nearL : nearR;
    const contrast = hi2 - lo2;
    // BLEED: the dark side lifted right at the edge vs the dark plateau away
    // from it. Positive = bright light crossed the geometry boundary.
    const plate = darkLeft ? plateL : plateR;
    const lift = plate == null ? null : r1(dark - plate);
    const thresh = lo2 + (hi2 - lo2) * 0.1;
    let width10 = 0;
    if (darkLeft) { for (let i = ei; i >= 0; i--) { if (p[i] <= thresh) break; width10++; } }
    else { for (let i = ei; i < L; i++) { if (p[i] <= thresh) break; width10++; } }
    return {
      axis: e.axis, t: e.t, x: e.x, y: e.y, ei, rel: e.rel, ang: e.ang,
      solid: e.solid, score: e.score, d0: e.d0, d1: e.d1,
      contrast: Math.round(contrast),
      lift,
      liftPct: contrast > 6 ? r1((lift / contrast) * 100) : null,
      width10, darkSide: darkLeft ? 'a' : 'b',
      profile: p,
    };
  });

  for (const e of edges) {
    console.log(`  ${e.axis} edge @${e.t.toFixed(2)} px[${e.x},${e.y}] ei ${e.ei}  depth ${e.d0 ?? 'void'}→${e.d1 ?? 'void'} rel ${e.rel} nΔ${e.ang}° ${e.solid ? 'solid' : 'void'}`);
    if (e.note) { console.log(`    ${e.note}`); continue; }
    console.log(`    contrast ${e.contrast} · dark-side lift ${e.lift} (${e.liftPct}% of step) · 10%-width ${e.width10}px · dark=${e.darkSide}`);
    console.log(`    [${e.profile.join(',')}]`);
  }
  results.phases[name] = { edges };
  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/${LABEL}-${name}.png` });
  await page.close();
}

// SLAB framing: a bright lit slab against the dark surround — the smoke's
// lightpos view — gives the strongest bright/dark geometry silhouettes
const SLAB = { pos: [0.93, -2.6, 0.4], look: [0.93, 0, 3.13] };
await run('edge-raw', () => edgePhase('edge-raw', `${BASE}/?rtdebug=3`, SLAB));
await run('edge-comp', () => edgePhase('edge-comp', `${BASE}/`, SLAB));

// ---------------------------------------------------------------------------
// testroom: ?testroom must boot rt=armed with zero pageerrors
// ---------------------------------------------------------------------------
await run('testroom', async () => {
  const b = await boot(`${BASE}/?testroom`, 'testroom');
  if (!b) return;
  const { page, logs } = b;
  await sleep(1500);
  const errs = logs.filter((l) => l.includes('PAGEERROR') || l.startsWith('[liminal][webgpu]'));
  if (errs.length) errs.forEach((e) => fail(`testroom: ${e.slice(0, 160)}`));
  else ok('testroom: zero pageerrors, zero WebGPU errors');
  results.phases.testroom = { rtArmed: b.bootLine.includes('rt=armed'), errors: errs.length };
  await page.close();
});

await browser.close();

writeFileSync(`${OUT}/${LABEL}.json`, JSON.stringify(results, null, 1));
console.log(`\n==== ${failures.length ? `FAILED (${failures.length})` : 'PASS'} — ${OUT}/${LABEL}.json + ${LABEL}-*.png`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = failures.length ? 1 : 0;
