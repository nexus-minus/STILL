/**
 * Lightmap consumption smoke — headful Chromium WebGPU (+ Firefox for potato).
 *
 *   node scripts/rt-bake-smoke.mjs [http://localhost:5187]
 *
 * Proves backlog #9's renderer-consumption requirements, one page load per
 * phase (screenshots to /tmp/opencode/rt-bake/):
 *
 *   clip     — RGBM round-trip: decode lightmap.png independently, compare
 *              against the texture the GPU actually samples, and measure what
 *              the old plain sRGB-8 encode would have clipped (rule 2:
 *              "probe the brightest regions, report numbers").
 *   grid     — lightmap-sampled grid: for a screen grid, raycast → TEXCOORD_1
 *              → bilinear sample of the decoded bake, correlated (Spearman)
 *              with the rendered pixel. Proves orientation + gradients: the
 *              v-flipped control must correlate WORSE.
 *   nodouble — mutate a BAKED light ×50 → static pixels must NOT move (rule 1:
 *              no double-lighting), then add a DYNAMIC light → they must
 *              (the realtime layer is live on the same pixels).
 *   raw      — ?rtdebug=3: the raw lighting buffer starts near-black (it is
 *              realtime-DYNAMIC-only now) and changes within N frames of a
 *              dynamic light appearing (rule 3: runtime adaptation).
 *   potato   — Firefox headless: WebGL2 boot shows the baked layer ON and lit
 *              geometry, with a ?nolightmap A/B (what the lightmap contributes).
 *   dbg4     — screenshot of ?rtdebug=4 (the baked buffer itself).
 *
 * Hard asserts: no pageerrors / WebGPU errors, manifest carries the RGBM
 * contract, decode round-trip within 1%, HDR range survived (max > 1.5 —
 * plain sRGB-8 caps at 1.0), grid correlation + orientation, baked-light
 * mutation invisible, dynamic light visible within frames, potato lit.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5187';
const OUT = '/tmp/opencode/rt-bake';
const CHROME = '/usr/bin/chromium';
const XDG = '/tmp/opencode/chromium-xdg-clean';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);
const info = (msg) => console.log(`  ·    ${msg}`);
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

async function launch(browserType) {
  return puppeteer.launch(
    browserType === 'firefox'
      ? { browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true }
      : {
          executablePath: CHROME,
          headless: false,
          env: { ...process.env, XDG_CONFIG_HOME: XDG },
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,760'],
        },
  );
}

/** boot a page; asserts ready + clean console (shared by every phase) */
async function boot(browser, url, name, { expectRt = null } = {}) {
  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ }
  });
  // Pin the freeze off. These readback asserts were calibrated on a dispatch EVERY
  // frame; with the idle freeze a static scene stops dispatching after the settle
  // window, so a measurement would describe a settle-window average instead of the
  // converged values the thresholds expect. These scripts proof the shader, not the
  // scheduler (docs/render-pipeline.md → "Anti-banding + idle frame").
  const target = `${url}${url.includes('?') ? '&' : '?'}settle=0`;
  console.log(`\n== ${name}: ${target}`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    ready = await page.evaluate(() => window.__liminalReady === true).catch(() => false);
    if (!ready) await sleep(200);
  }
  if (!ready) { fail(`${name}: never reached __liminalReady`); await page.close(); return null; }
  const bootLine = logs.find((l) => l.includes('[liminal] up')) ?? '';
  console.log(`  boot: ${bootLine.split('\n')[0].slice(0, 150)}`);
  if (expectRt === 'armed' && !bootLine.includes('rt=armed')) {
    fail(`${name}: expected rt=armed, got ${bootLine.match(/rt=\S+/)?.[0] ?? 'no boot line'}`);
  }
  for (const l of logs.filter((l) => l.startsWith('[liminal][webgpu]'))) fail(`${name}: WebGPU error: ${l.slice(0, 160)}`);
  for (const e of errors) fail(`${name}: pageerror: ${e.slice(0, 160)}`);
  await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
  return { page, logs, bootLine };
}

/** freecam frame like rt-softshadow's (holds without pointer lock) */
async function frameCam(page, fr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate((f) => {
      const L = window.__liminal;
      document.getElementById('overlay')?.classList.add('hidden');
      if (!L.controller.freecam) L.controller.toggleFreecam();
      const [px, py, pz] = f.pos, [tx, ty, tz] = f.look;
      L.camera.position.set(px, py, pz);
      const dx = tx - px, dy = ty - py, dz = tz - pz;
      L.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
    }, fr);
    await sleep(4500);
    await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
    const drift = await page.evaluate((f) => {
      const c = window.__liminal.camera.position;
      return Math.hypot(c.x - f.pos[0], c.y - f.pos[1], c.z - f.pos[2]);
    }, fr);
    if (drift < 0.05) return true;
  }
  fail('framing did not hold (camera drifted >0.05m)');
  return false;
}

/** frame-timed full-canvas luma mean (post-present drawImage reads blank) */
const canvasMean = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const c = document.querySelector('canvas#game');
          const off = document.createElement('canvas');
          off.width = 160;
          off.height = 90;
          const ctx = off.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(c, 0, 0, 160, 90);
          const d = ctx.getImageData(0, 0, 160, 90).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
          resolve(s / (d.length / 4));
        });
      }),
  );

const SUNKEN = { pos: [0.93, 1.6, 1.2], look: [0.93, 0.1, 3.13] };
// the raw-view discriminator frames the STRIP fixture (power 47.7 — the map's
// strongest): without the lightmap it floods the realtime buffer, so the
// lightmap-on measurement must be a small fraction of it
const STRIP = { pos: [-14.3, -2.0, -51.24], look: [-12.13, -2.02, -51.24] };

// ---------------------------------------------------------------------------
// clip: RGBM round-trip + what plain sRGB-8 would have clipped (rule 2)
// ---------------------------------------------------------------------------
const browser = await launch('chrome');
{
  const b = await boot(browser, `${BASE}/?vol=off`, 'clip', { expectRt: 'armed' });
  if (b) {
    const { page, logs } = b;
    await sleep(1500);
    const out = await page.evaluate(async () => {
      const L = window.__liminal;
      const manifest = await fetch('map/manifest.json').then((r) => r.json());
      const lm = manifest.lightmap;
      const blob = await fetch(`map/${lm.file}`).then((r) => r.blob());
      const url = URL.createObjectURL(blob);
      const image = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error('png decode failed'));
        el.src = url;
      });
      const cv = document.createElement('canvas');
      cv.width = image.naturalWidth;
      cv.height = image.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const src = ctx.getImageData(0, 0, cv.width, cv.height).data;
      URL.revokeObjectURL(url);
      const lut = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const c = i / 255;
        lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
      // independent decode (mirrors the loader contract, not its code path)
      let pmax = 0, psum = 0, pOver1 = 0, pn = 0;
      for (let i = 0; i < src.length; i += 4) {
        const m = lut[src[i + 3]] * lm.range;
        const v = Math.max(lut[src[i]] * m, lut[src[i + 1]] * m, lut[src[i + 2]] * m);
        if (v > pmax) pmax = v;
        if (v > 1) pOver1++;
        psum += v;
        pn++;
      }
      // the texture the GPU samples — map-loader applies the renderer scale
      // (π, see its SCALE constant) on decode, so expect pngMax × π
      const SCALE = Math.PI;
      const data = L.world.lightmap.texture.image.data;
      const fromHalf = L.THREE.DataUtils.fromHalfFloat;
      let tmax = 0, tOver1 = 0;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.max(fromHalf(data[i]), fromHalf(data[i + 1]), fromHalf(data[i + 2]));
        if (v > tmax) tmax = v;
        if (v > 1) tOver1++;
      }
      return {
        manifest: { encoding: lm.encoding, range: lm.range, uv: lm.uv, res: lm.resolution },
        png: { max: pmax, mean: psum / pn, over1: pOver1, n: pn },
        texture: { max: tmax, over1: tOver1, expectedMax: pmax * SCALE },
      };
    });
    info(`manifest lightmap: ${JSON.stringify(out.manifest)}`);
    info(`PNG decode:   max ${r3(out.png.max)}  mean ${r3(out.png.mean)}  >1.0: ${out.png.over1} texels (${r1((100 * out.png.over1) / out.png.n)}%)`);
    info(`GPU texture:  max ${r3(out.texture.max)} (expect ${r3(out.texture.expectedMax)} = PNG × renderer π scale)  >1.0: ${out.texture.over1} texels`);
    if (out.manifest.encoding === 'rgbm' && out.manifest.range > 1) ok('manifest carries the RGBM contract (encoding + range > 1)');
    else fail(`manifest lightmap contract broken: ${JSON.stringify(out.manifest)}`);
    if (Math.abs(out.texture.max - out.texture.expectedMax) / out.texture.expectedMax < 0.01) {
      ok(`loader round-trip: GPU max ${r3(out.texture.max)} ≈ PNG max ${r3(out.png.max)} × π (<1%)`);
    } else {
      fail(`loader round-trip mismatch: GPU ${r3(out.texture.max)} vs expected ${r3(out.texture.expectedMax)}`);
    }
    if (out.png.max > 1.5) {
      ok(`HDR range survived: max ${r3(out.png.max)} (>1.0 — plain sRGB-8 would have clipped this to 1.0)`);
    } else {
      fail(`HDR range missing: max ${r3(out.png.max)} — RGBM did not preserve values > 1.0`);
    }
    if (out.png.over1 > 1000) {
      ok(`${out.png.over1} texels above 1.0 would have clipped under plain sRGB-8 (bake reported 1.59 %)`);
    } else {
      fail(`expected >1000 clipped texels, got ${out.png.over1}`);
    }
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// grid: rendered pixels vs the lightmap PNG's own gradients (+ v-flip control)
// ---------------------------------------------------------------------------
let gridPoints = [];
{
  const b = await boot(browser, `${BASE}/?vol=off`, 'grid', { expectRt: 'armed' });
  if (b) {
    const { page } = b;
    await frameCam(page, SUNKEN);
    await sleep(2500);
    gridPoints = await page.evaluate(() => {
      const L = window.__liminal;
      const THREE = L.THREE;
      const tex = L.world.lightmap.texture;
      const data = tex.image.data;
      const fromHalf = THREE.DataUtils.fromHalfFloat;
      const W = tex.image.width, H = tex.image.height;
      const sample = (u, v) => {
        const x = u * W - 0.5, y = v * H - 0.5;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const fx = x - x0, fy = y - y0;
        const at = (xx, yy) => {
          const cx = Math.min(W - 1, Math.max(0, xx)), cy = Math.min(H - 1, Math.max(0, yy));
          const i = (cy * W + cx) * 4;
          const r = fromHalf(data[i]), g = fromHalf(data[i + 1]), b2 = fromHalf(data[i + 2]);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
        };
        return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
          + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      };
      const ray = new THREE.Raycaster();
      const pts = [];
      for (let gy = -0.65; gy <= 0.55; gy += 0.1) {
        for (let gx = -0.85; gx <= 0.85; gx += 0.08) {
          ray.setFromCamera(new THREE.Vector2(gx, gy), L.camera);
          const hit = ray.intersectObjects(L.scene.children, true)[0];
          if (!hit?.face || !hit.uv1) continue;
          const mats = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
          const emissive = mats.some((m) => m && (m.emissiveIntensity ?? 0) > 0
            && m.emissive.r + m.emissive.g + m.emissive.b > 0.01);
          if (emissive) continue;
          const px = Math.round(((gx + 1) / 2) * 1279);
          const py = Math.round((1 - (gy + 1) / 2) * 719);
          pts.push({
            px, py,
            lm: sample(hit.uv1.x, hit.uv1.y),
            lmFlip: sample(hit.uv1.x, 1 - hit.uv1.y),
          });
        }
      }
      return pts;
    });
    // canvas lumas at those points (one frame-timed full readback)
    const lumas = await page.evaluate(
      (pts) =>
        new Promise((resolve) => {
          requestAnimationFrame(() => {
            const c = document.querySelector('canvas#game');
            const off = document.createElement('canvas');
            off.width = c.width;
            off.height = c.height;
            const ctx = off.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(c, 0, 0);
            const d = ctx.getImageData(0, 0, off.width, off.height).data;
            resolve(
              pts.map((p) => {
                const i = (p.py * off.width + p.px) * 4;
                return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              }),
            );
          });
        }),
      gridPoints,
    );
    const rows = gridPoints.map((p, i) => ({ ...p, canvas: lumas[i] }));
    // drop bloomed/fixture-adjacent pixels (their luma is emissive/bloom, not bake)
    const pts = rows.filter((p) => p.canvas < 245);
    const ranks = (a) => {
      const order = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
      const r = new Array(a.length);
      order.forEach(([v, i], rank) => { r[i] = rank; void v; });
      return r;
    };
    const spearman = (a, b2) => {
      const ra = ranks(a), rb = ranks(b2), n = a.length;
      const ma = ra.reduce((s, v) => s + v, 0) / n;
      const mb = rb.reduce((s, v) => s + v, 0) / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) {
        num += (ra[i] - ma) * (rb[i] - mb);
        da += (ra[i] - ma) ** 2;
        db += (rb[i] - mb) ** 2;
      }
      return num / Math.sqrt(da * db || 1);
    };
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const corr = spearman(pts.map((p) => p.canvas), pts.map((p) => p.lm));
    const corrFlip = spearman(pts.map((p) => p.canvas), pts.map((p) => p.lmFlip));
    info(`${pts.length} grid points — canvas mean ${r1(mean(pts.map((p) => p.canvas)))}, lightmap mean ${r3(mean(pts.map((p) => p.lm)))}`);
    info(`Spearman(canvas, lightmap) = ${r3(corr)}   v-flip control = ${r3(corrFlip)}`);
    if (pts.length < 80) fail(`grid: only ${pts.length} usable points`);
    if (corr > 0.5) ok(`rendered pixels track the lightmap's own gradients (ρ ${r3(corr)} > 0.5)`);
    else fail(`grid correlation too low: ρ ${r3(corr)} — rendered light does not match the bake`);
    if (corr > corrFlip + 0.1) ok(`orientation correct: unflipped ρ ${r3(corr)} beats v-flipped ρ ${r3(corrFlip)}`);
    else fail(`orientation suspect: flip control ${r3(corrFlip)} vs ${r3(corr)}`);
    await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
    await page.screenshot({ path: `${OUT}/grid-sunken.png` });

    // ---- nodouble (same page, same points) --------------------------------
    const readGrid = () =>
      page.evaluate(
        (pts) =>
          new Promise((resolve) => {
            requestAnimationFrame(() => {
              const c = document.querySelector('canvas#game');
              const off = document.createElement('canvas');
              off.width = c.width;
              off.height = c.height;
              const ctx = off.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(c, 0, 0);
              const d = ctx.getImageData(0, 0, off.width, off.height).data;
              resolve(
                pts.map((p) => {
                  const i = (p.py * off.width + p.px) * 4;
                  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                }),
              );
            });
          }),
        pts,
      );
    const L0 = await readGrid();
    // mutate a BAKED light ×50 — rule 1 says static pixels cannot notice
    await page.evaluate(() => {
      const L = window.__liminal;
      const next = L.world.rtLights.map((l) => ({ ...l }));
      next[0].power *= 50;
      L.setRtLights(next);
    });
    await sleep(1800);
    const L1 = await readGrid();
    const maxDelta = Math.max(...L0.map((v, i) => Math.abs(v - L1[i])));
    info(`baked light ×50 → max pixel delta ${r1(maxDelta)}/255 over ${L0.length} points`);
    if (maxDelta <= 2) ok('rule 1 (no double-lighting): a baked light ×50 moves static pixels by ≤2/255');
    else fail(`rule 1 VIOLATED: baked light ×50 moved static pixels by ${r1(maxDelta)}/255`);
    await page.screenshot({ path: `${OUT}/nodouble-after-mutation.png` });

    // same pixels, DYNAMIC light added — rule 3 + the realtime layer is live.
    // Placement: 2 m ahead of the camera + 1 m up — close enough to light the
    // visible surfaces from anywhere (3 m put it behind the strip wall).
    await page.evaluate(() => {
      const L = window.__liminal;
      const THREE = L.THREE;
      const cam = L.camera;
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      const p = cam.position.clone().addScaledVector(fwd, 2).add(new THREE.Vector3(0, 1, 0));
      const next = L.world.rtLights.map((l) => ({ ...l }));
      next.push({
        position: [p.x, p.y, p.z],
        color: [0.35, 0.6, 1.0],
        power: 25,
        halfSize: 0.4,
        extents: [0.4, 0.4, 0.4],
        baked: false,
      });
      L.setRtLights(next);
    });
    await sleep(1800);
    const L2 = await readGrid();
    const meanDelta = mean(L2.map((v, i) => v - L1[i]));
    info(`dynamic light added → mean pixel delta ${r1(meanDelta)}/255`);
    if (meanDelta > 3) ok(`dynamic light visible on the same pixels (mean +${r1(meanDelta)}/255)`);
    else fail(`dynamic light invisible: mean delta ${r1(meanDelta)}/255`);
    await page.screenshot({ path: `${OUT}/adapt-dynamic-on.png` });
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// raw: ?rtdebug=3 = realtime-DYNAMIC-only; adapts within N frames (rule 3)
// ---------------------------------------------------------------------------
{
  const b = await boot(browser, `${BASE}/?rtdebug=3&vol=off`, 'raw', { expectRt: 'armed' });
  if (b) {
    const { page } = b;
    await frameCam(page, STRIP);
    await sleep(2000);
    // install a per-frame luma sampler inside the game's own animation loop
    await page.evaluate(() => {
      const L = window.__liminal;
      window.__rawSamples = [];
      const orig = L.pipeline.render.bind(L.pipeline);
      L.pipeline.render = (a) => {
        orig(a);
        const c = document.querySelector('canvas#game');
        const off = document.createElement('canvas');
        off.width = 160;
        off.height = 90;
        const ctx = off.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(c, 0, 0, 160, 90);
        const d = ctx.getImageData(0, 0, 160, 90).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
        window.__rawSamples.push(s / (d.length / 4));
      };
    });
    await sleep(800);
    const before = await page.evaluate(() => window.__rawSamples.slice(-10).reduce((a, b2) => a + b2, 0) / 10);
    info(`raw lighting buffer with only ambient (no dynamic lights): mean ${r1(before)}/255`);
    await page.evaluate(() => {
      const L = window.__liminal;
      const THREE = L.THREE;
      const cam = L.camera;
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      const p = cam.position.clone().addScaledVector(fwd, 2).add(new THREE.Vector3(0, 1, 0));
      const next = L.world.rtLights.map((l) => ({ ...l }));
      next.push({
        position: [p.x, p.y, p.z],
        color: [0.4, 0.7, 1.0],
        power: 800,
        halfSize: 0.4,
        extents: [0.4, 0.4, 0.4],
        baked: false,
      });
      L.setRtLights(next);
      window.__rawMark = window.__rawSamples.length;
    });
    let framesToChange = null;
    for (let i = 0; i < 90; i++) {
      const s = await page.evaluate(() => {
        const tail = window.__rawSamples.slice(window.__rawMark);
        return { last: tail[tail.length - 1] ?? 0, count: tail.length };
      });
      if (s.last > before + 8) { framesToChange = s.count; break; }
      await sleep(50);
    }
    if (framesToChange !== null && framesToChange <= 30) {
      ok(`rule 3 (runtime adaptation): raw lighting buffer changed within ${framesToChange} frames of a dynamic light appearing`);
    } else if (framesToChange === null) {
      fail('raw lighting buffer never reacted to the dynamic light (90 polls)');
    } else {
      fail(`raw buffer took ${framesToChange} frames to react (>30)`);
    }
    const after = await page.evaluate(() => window.__rawSamples.slice(-10).reduce((a, b2) => a + b2, 0) / 10);
    info(`after the dynamic light: mean ${r1(after)}/255 (Δ ${r1(after - before)})`);
    if (after - before > 10) ok(`dynamic light moved the raw buffer by +${r1(after - before)}/255`);
    else fail(`dynamic light barely moved the raw buffer (+${r1(after - before)}/255)`);
    await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
    await page.screenshot({ path: `${OUT}/raw-dynamic-on.png` });
    await page.close();

    // the raw view's static side: with ?nolightmap the fixtures are NOT baked,
    // so they run realtime and MUST flood the same buffer — proving the
    // lightmap-on measurement above was dynamic-only (rule 1, raw view)
    const b2 = await boot(browser, `${BASE}/?rtdebug=3&vol=off&nolightmap`, 'raw-nolightmap', { expectRt: 'armed' });
    if (b2) {
      await frameCam(b2.page, STRIP);
      await sleep(2500);
      const staticRaw = await canvasMean(b2.page);
      info(`same view WITHOUT the lightmap (fixtures realtime): raw mean ${r1(staticRaw)}/255`);
      if (before < staticRaw * 0.5) {
        ok(`raw view is dynamic-only: ambient ${r1(before)} < half of the realtime-static ${r1(staticRaw)}`);
      } else {
        fail(`raw view not dynamic-only: ${r1(before)} vs realtime-static ${r1(staticRaw)}`);
      }
      await b2.page.close();
    }
  }
}

// ---------------------------------------------------------------------------
// dbg4: screenshot of the baked lightmap buffer (diagnostic view)
// ---------------------------------------------------------------------------
{
  const b = await boot(browser, `${BASE}/?vol=off&rtdebug=4`, 'dbg4', { expectRt: 'armed' });
  if (b) {
    const { page } = b;
    await frameCam(page, SUNKEN);
    await sleep(1500);
    await page.screenshot({ path: `${OUT}/baked-buffer.png` });
    info('screenshot: baked-buffer.png (?rtdebug=4 = the lightmap term)');
    await page.close();
  }
}
await browser.close();

// ---------------------------------------------------------------------------
// potato: Firefox headless — WebGL2 boots the baked forward layer, lit
// ---------------------------------------------------------------------------
{
  const browserF = await launch('firefox');
  const measurePotato = async (url, name) => {
    const b = await boot(browserF, url, name);
    if (!b) return null;
    const { page, logs, bootLine } = b;
    // sample INSIDE the game's own render loop (WebGL2 canvases read blank
    // outside the frame that drew them)
    await page.evaluate(() => {
      const L = window.__liminal;
      window.__potatoLuma = [];
      const orig = L.pipeline.render.bind(L.pipeline);
      L.pipeline.render = (a) => {
        orig(a);
        const c = document.querySelector('canvas#game');
        const off = document.createElement('canvas');
        off.width = 160;
        off.height = 90;
        const ctx = off.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(c, 0, 0, 160, 90);
        const d = ctx.getImageData(0, 0, 160, 90).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
        window.__potatoLuma.push(s / (d.length / 4));
      };
    });
    await sleep(2500);
    const mean = await page.evaluate(() => {
      const a = window.__potatoLuma.slice(-40);
      return a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    });
    await page.evaluate(() => document.getElementById('overlay')?.classList.add('hidden'));
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const hasLmLog = logs.some((l) => l.includes('[world] lightmap lightmap.png'));
    const forwardOn = logs.some((l) => l.includes('forward baked layer ON'));
    console.log(`  luma ${r1(mean)}/255  backend=${bootLine.match(/backend=\S+/)?.[0] ?? '?'}  lightmapLog=${hasLmLog} forwardOn=${forwardOn}`);
    await page.close();
    return { mean, bootLine, hasLmLog, forwardOn };
  };

  const lit = await measurePotato(`${BASE}/?forcegl=1&vol=off`, 'potato-baked');
  if (lit) {
    if (lit.bootLine.includes('backend=webgl2')) ok('potato: WebGL2 backend');
    else fail(`potato: expected backend=webgl2, got ${lit.bootLine.match(/backend=\S+/)?.[0]}`);
    if (lit.hasLmLog) ok('potato: lightmap decoded and handed to the forward path');
    else fail('potato: no [world] lightmap log');
    if (lit.forwardOn) ok('potato: forward baked layer ON');
    else fail('potato: forward baked layer never engaged');
    if (lit.mean > 15) ok(`potato: geometry lit (frame mean ${r1(lit.mean)}/255 > 15)`);
    else fail(`potato: frame mean ${r1(lit.mean)}/255 — geometry not lit`);

    const dark = await measurePotato(`${BASE}/?forcegl=1&vol=off&nolightmap`, 'potato-nolightmap');
    if (dark) {
      info(`A/B without the lightmap: mean ${r1(dark.mean)}/255 (legacy point-light fallback) vs ${r1(lit.mean)}/255 baked`);
      if (Math.abs(dark.mean - lit.mean) > 2) ok('A/B differs — the lightmap is what lights the baked path');
      else fail(`A/B identical (${r1(dark.mean)} vs ${r1(lit.mean)}) — lightmap has no visible effect on potato`);
    }
  }
  await browserF.close();
}

console.log(`\n==== ${failures.length ? `FAILED (${failures.length})` : 'PASS'} — screenshots in ${OUT}/`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = failures.length ? 1 : 0;
