/**
 * Volumetrics (phase 1b) smoke test — headful Chromium WebGPU.
 *
 *   node scripts/rt-vol-smoke.mjs [http://localhost:5186] [phase,...]
 *
 * Phases (each = one page load; screenshots + JSON to /tmp/opencode/rt-vol/):
 *   off        — ?vol=off: the toggle-off path must dispatch NOTHING
 *                (volStats.dispatches stays 0 — the counter proves the pass
 *                is skipped, not just invisible) and hold no fog texture
 *                (1×1). Then a LIVE toggle on→off: dispatches start, then
 *                freeze and the texture shrinks back to 1×1.
 *   on         — ?vol=on in a corridor framing (distant light → fog halo):
 *                dispatches > 0, fog-sized texture, screenshots ON vs the
 *                off page's, full-frame mean luminance A/B (must not wash or
 *                darken the scene) + the haze ring around the emissive
 *                doorway (fixtures get hazed — brighter halo, same core).
 *   banding    — a RECEIVING flat wall that recedes in depth, fog on: the
 *                ON−OFF delta profile per row/column must be smooth (stripe
 *                energy = max |profile − smooth5| below threshold) with a
 *                measurable range (so the check is not vacuous).
 *   debug-raw  — ?rtdebug=3&vol=on: the raw-buffer diagnostic must stay raw
 *                — volStats.dispatches === 0 (the march is skipped for
 *                debug views) and the screenshot shows the untinted buffer.
 *   testroom   — ?testroom boots rt=armed with zero pageerrors/WebGPU errors
 *                (and fog runs there too).
 *
 * Hard asserts: rt=armed on every boot, zero pageerrors, zero
 * [liminal][webgpu] errors. Numbers come from CANVAS PIXEL READS taken
 * inside requestAnimationFrame (the WebGPU canvas only holds a readable
 * frame right after it is rendered).
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5186';
const ONLY = process.argv[3] ? process.argv[3].split(',').map((s) => s.trim()) : null;
const OUT = '/tmp/opencode/rt-vol';
const CHROME = '/usr/bin/chromium';
const XDG = '/tmp/opencode/chromium-xdg-clean';
mkdirSync(OUT, { recursive: true });
mkdirSync(XDG, { recursive: true });

/** corridor framing: eye height down the spawn hallway toward the far light */
const CORRIDOR = { pos: [-6.6, -7.6, -30.6], look: [-6.6, -7.6, -22.0] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  protocolTimeout: 300000,
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,760'],
});

const run = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await fn(); return; }
    catch (e) {
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
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.clear(); } catch { /* private mode */ }
  });
  console.log(`\n== ${name}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let booted = false;
  for (let i = 0; i < 150 && !booted; i++) {
    booted = await page.evaluate(() => window.__liminalReady === true).catch(() => false);
    if (!booted) await sleep(200);
  }
  if (!booted) { fail(`${name}: never reached __liminalReady`); await page.close(); return null; }
  await page.bringToFront();

  const boots = logs.filter((l) => l.includes('[liminal] up'));
  const bootLine = boots[boots.length - 1] ?? '';
  console.log(`  boot: ${bootLine.split('\n')[0].slice(0, 140)}`);
  if (bootLine.includes('rt=armed')) ok(`${name}: rt=armed`);
  else fail(`${name}: rt not armed (${bootLine.match(/rt=\S+/)?.[0] ?? 'no boot line'})`);
  for (const l of logs.filter((l) => l.startsWith('[liminal][webgpu]'))) {
    fail(`${name}: WebGPU error: ${l.slice(0, 160)}`);
  }
  for (const e of errors) fail(`${name}: pageerror: ${e.slice(0, 160)}`);
  return { page, logs, bootLine };
}

async function hideOverlays(page) {
  await page.evaluate(() => {
    const hide = () => document.getElementById('overlay')?.classList.add('hidden');
    hide();
    const resume = [...document.querySelectorAll('button')].find(
      (b) => /^resume$/i.test((b.textContent ?? '').trim()));
    if (resume && resume.offsetParent !== null) resume.click();
    hide();
  });
}

/** apply a freecam framing (controller.update early-returns without lock) */
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

/** frame → settle (temporal convergence) → hide overlays */
async function prep(page, f, ms = 5000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(() => window.__liminalReady === true).catch(() => false)) break;
      await sleep(200);
    }
    await frame(page, f);
    await sleep(ms);
    await hideOverlays(page);
    await sleep(400);
    const st = await page.evaluate((fr) => {
      const c = window.__liminal.camera;
      return Math.hypot(c.position.x - fr.pos[0], c.position.y - fr.pos[1], c.position.z - fr.pos[2]);
    }, f);
    if (st < 0.05) return;
    console.log(`  re-prep #${attempt + 1} (drift ${st.toFixed(2)}m)`);
    ms = 3500;
  }
  fail('prep: could not hold the framing (page kept reloading?)');
}

/** in-page helpers: frame-timed canvas reads */
async function installHelpers(page) {
  await page.evaluate(() => {
    const canvas = () => document.querySelector('canvas#game');
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
    /** mean luma (0..255) of a canvas-px rect, read right after a fresh frame */
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
      return Array.from(out);
    });
    /** full-frame mean luma */
    const meanLuma = () => nextFrame(() => {
      const c = canvas();
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4);
    });
    /** brightest pixel of a fresh frame (locates the emissive fixture) */
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
      return { x: bi % c.width, y: (bi / c.width) | 0, v: bv };
    });
    const raycast = (nx, ny) => {
      const L = window.__liminal;
      const ray = new L.THREE.Raycaster();
      ray.setFromCamera(new L.THREE.Vector2(nx, ny), L.camera);
      const mats = (o) => Array.isArray(o.material) ? o.material : [o.material];
      const shadowObjs = [];
      L.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (mats(o).some((m) => m && m.emissive && (m.emissiveIntensity ?? 1) > 0
          && m.emissive.r + m.emissive.g + m.emissive.b > 0.01)) return;
        shadowObjs.push(o);
      });
      return ray.intersectObjects(shadowObjs, false)[0] ?? null;
    };
    window.__vol = { readLuma, meanLuma, brightest, raycast, canvas };
  });
}

const volStats = (page) => page.evaluate(() => window.__liminal.volStats ?? null);
const setVol = (page, on) =>
  page.evaluate((v) => window.__liminal.quality.setOverride('volumetrics', v), on);

// ---------------------------------------------------------------------------
// off: ?vol=off must dispatch NOTHING (counter proof) + live toggle round trip
// ---------------------------------------------------------------------------
await run('off', async () => {
  const b = await boot(`${BASE}/?vol=off`, 'off');
  if (!b) return;
  const { page } = b;
  await frame(page, CORRIDOR);
  await sleep(4000); // several seconds of frames with the toggle off
  await hideOverlays(page);
  const s = await volStats(page);
  console.log(`  volStats: ${JSON.stringify(s)}`);
  if (s && s.dispatches === 0) ok('off: dispatches === 0 — the fog pass never ran');
  else fail(`off: expected 0 dispatches, got ${s?.dispatches}`);
  if (s && s.width === 1 && s.height === 1) ok('off: no fog texture allocated (1×1)');
  else fail(`off: fog texture sized while off (${s?.width}×${s?.height})`);
  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/off-corridor.png` });
  console.log(`  shot: ${OUT}/off-corridor.png`);

  // live toggle ON: dispatches must start and the texture must appear
  await setVol(page, true);
  await sleep(1800);
  const on = await volStats(page);
  if (on && on.dispatches > 0 && on.width > 1) {
    ok(`live toggle on: dispatches ${on.dispatches}, texture ${on.width}×${on.height}`);
  } else fail(`live toggle on: nothing happened (${JSON.stringify(on)})`);
  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/off-then-on.png` });

  // live toggle OFF again: dispatches freeze, texture released to 1×1
  await setVol(page, false);
  await sleep(600);
  const frozen = (await volStats(page))?.dispatches ?? -1;
  await sleep(1600);
  const s2 = await volStats(page);
  if (s2 && s2.dispatches === frozen && s2.width === 1) {
    ok(`live toggle off: dispatches frozen at ${frozen}, texture back to 1×1`);
  } else fail(`live toggle off: kept running (${JSON.stringify(s2)}, was ${frozen})`);
  await page.close();
});

// ---------------------------------------------------------------------------
// on: renders, corridor A/B luminance, emissive fixture hazed
// ---------------------------------------------------------------------------
const onLuma = { on: null, off: null, ringOn: null, ringOff: null };
await run('on', async () => {
  const b = await boot(`${BASE}/?vol=on`, 'on');
  if (!b) return;
  const { page } = b;
  await installHelpers(page);
  await prep(page, CORRIDOR, 5500); // still camera → temporal convergence
  const s = await volStats(page);
  console.log(`  volStats: ${JSON.stringify(s)}`);
  if (s && s.dispatches > 0 && s.width > 1) ok(`on: fog marching at ${s.width}×${s.height}`);
  else fail(`on: fog not running (${JSON.stringify(s)})`);

  onLuma.on = await page.evaluate(() => window.__vol.meanLuma());
  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/on-corridor.png` });
  console.log(`  shot: ${OUT}/on-corridor.png`);

  // flip the toggle OFF on the SAME page/framing for a like-for-like A/B.
  // The fixture box is located with fog OFF (unambiguous emissive core) and
  // then re-read with fog ON — same pixels both sides.
  await setVol(page, false);
  await sleep(2500);
  onLuma.off = await page.evaluate(() => window.__vol.meanLuma());
  const loc = await page.evaluate(() => window.__vol.brightest());
  const readBox = () => page.evaluate(async (b) => {
    const W = 128, H = 128;
    const c = window.__vol.canvas();
    const x0 = Math.max(0, Math.min(c.width - W, b.x - W / 2));
    const y0 = Math.max(0, Math.min(c.height - H, b.y - H / 2));
    const l = await window.__vol.readLuma(x0, y0, W, H);
    if (!l) return null;
    // core = the emissive fixture itself (≥85% of its peak), halo = the air
    // and surfaces around it: fog must lift the HALO (in-scatter) while the
    // core is veiled by the same transmittance — hazed, not bypassed
    let core = 0, coreN = 0, halo = 0, haloN = 0;
    for (const v of l) {
      if (v >= b.v * 0.85) { core += v; coreN++; }
      else if (v >= 4) { halo += v; haloN++; }
    }
    return {
      core: coreN ? core / coreN : null, coreN,
      halo: haloN ? halo / haloN : null, haloN,
    };
  }, loc);
  onLuma.boxOff = await readBox();
  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/on-then-off.png` });
  console.log(`  shot: ${OUT}/on-then-off.png`);

  await setVol(page, true);
  await sleep(2500);
  onLuma.boxOn = await readBox();

  const { on, off, boxOn, boxOff } = onLuma;
  if (on != null && off != null) {
    const pct = ((on - off) / off) * 100;
    console.log(`  luminance: off=${r1(off)} on=${r1(on)} (Δ ${r1(pct)}%)`);
    // subtle default: fog must not wash (>+25%) nor crush (<-15%) the frame
    if (pct > -15 && pct < 25) ok(`mean luminance shift ${r1(pct)}% — subtle, scene intact`);
    else fail(`mean luminance shift ${r1(pct)}% — outside [-15%, +25%]`);
  } else fail('on: could not read mean luminance');
  if (boxOn && boxOff && boxOn.halo != null && boxOff.halo != null) {
    console.log(
      `  fixture box @(${loc.x},${loc.y}): core ${r1(boxOff.core)}→${r1(boxOn.core)} ` +
      `(n=${boxOff.coreN}) · halo ${r1(boxOff.halo)}→${r1(boxOn.halo)} (n=${boxOff.haloN})`,
    );
    // the air around the emissive must brighten — that IS it getting hazed
    if (boxOn.halo > boxOff.halo) {
      ok(`emissive fixture hazed: halo ${r1(boxOff.halo)} → ${r1(boxOn.halo)} (core veiled ${r1(boxOff.core)} → ${r1(boxOn.core)})`);
    } else {
      fail(`fixture halo not brightened by fog (on ${r1(boxOn.halo)} vs off ${r1(boxOff.halo)})`);
    }
  } else fail('on: fixture halo read failed');
  await page.close();
});

// ---------------------------------------------------------------------------
// banding: RECEIVING flat wall that recedes — ON−OFF delta must be smooth
// ---------------------------------------------------------------------------
await run('banding', async () => {
  const b = await boot(`${BASE}/?vol=on`, 'banding');
  if (!b) return;
  const { page } = b;
  await installHelpers(page);
  // frame the right-hand corridor wall obliquely so depth varies across it
  await prep(page, { pos: [-6.6, -7.6, -30.6], look: [-4.4, -7.4, -24.0] }, 5000);

  // geometry-only region pick: one planar surface, receding (depth spread
  // 3–40 %) so the fog gradient crosses it — a flat-on wall would make the
  // check vacuous (no gradient, no stripes possible)
  const pick = await page.evaluate(() => {
    const c = window.__vol.canvas();
    const W = c.width, H = c.height;
    const R = 64;
    const cands = [];
    for (let y = 48; y + R < H - 48; y += 32) {
      for (let x = 48; x + R < W - 48; x += 32) {
        const pts = [[x, y], [x + R, y], [x, y + R], [x + R, y + R], [x + R / 2, y + R / 2]];
        const hits = pts.map(([px, py]) => window.__vol.raycast((px / W) * 2 - 1, 1 - (py / H) * 2));
        if (hits.some((h) => h === null)) continue;
        const ds = hits.map((h) => h.distance);
        const mean = ds.reduce((a, b2) => a + b2, 0) / ds.length;
        const spread = (Math.max(...ds) - Math.min(...ds)) / mean;
        if (spread < 0.03 || spread > 0.4) continue; // needs a fog gradient
        const n0 = hits[0].face.normal;
        let worst = 0;
        for (const h of hits.slice(1)) {
          worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, n0.dot(h.face.normal)))));
        }
        if (worst > (10 * Math.PI) / 180) continue; // not one plane
        cands.push({ x, y, w: R, h: R, spread: +spread.toFixed(3), dist: +mean.toFixed(2),
          score: Math.abs(x + R / 2 - W / 2) + Math.abs(y + R / 2 - H / 2) });
      }
    }
    cands.sort((p, q) => p.score - q.score);
    return { total: cands.length, cands: cands.slice(0, 6) };
  });
  console.log(`  region search: ${pick.total} planar+receding rects`);
  if (!pick.cands.length) { fail('banding: no planar receding wall in view'); await page.close(); return; }

  let region = null;
  for (const cand of pick.cands) {
    const l = await page.evaluate((r) => window.__vol.readLuma(r.x, r.y, r.w, r.h), cand);
    if (!l) break;
    const mean = l.reduce((a, b2) => a + b2, 0) / l.length;
    if (mean >= 8 && mean <= 235) { region = { ...cand, luma: r1(mean) }; break; }
  }
  if (!region) { fail('banding: no usable (lit) region'); await page.close(); return; }
  ok(`banding: ${region.w}×${region.h} planar wall, depth spread ${(region.spread * 100).toFixed(0)}%, ${region.dist}m away`);
  const read = async () => {
    const l = await page.evaluate((r) => window.__vol.readLuma(r.x, r.y, r.w, r.h), region);
    if (!l) throw new Error('Execution context was destroyed (region read timed out)');
    return l;
  };

  // average several frames each side (kills residual lighting noise so the
  // metric sees FOG structure, not temporal speckle)
  const avg = async (n) => {
    const acc = new Float64Array(region.w * region.h);
    for (let i = 0; i < n; i++) {
      const l = await read();
      for (let k = 0; k < acc.length; k++) acc[k] += l[k];
      await sleep(120);
    }
    for (let k = 0; k < acc.length; k++) acc[k] /= n;
    return acc;
  };
  await setVol(page, true);
  await sleep(2200);
  const fogOn = await avg(6);
  await setVol(page, false);
  await sleep(2200);
  const fogOff = await avg(6);
  await setVol(page, true);
  await sleep(1500);

  // per-row and per-column means of the ON−OFF delta, then stripe energy:
  // max |profile − 5-tap-smooth(profile)| — a banded profile is plateaus +
  // jumps, which this measures directly (plain noise averages down in the
  // row/column means, banding does not)
  const W = region.w, H = region.h;
  const delta = new Float64Array(W * H);
  for (let i = 0; i < delta.length; i++) delta[i] = fogOn[i] - fogOff[i];
  const profile = (axis) => {
    const n = axis === 'x' ? W : H;
    const m = axis === 'x' ? H : W;
    const p = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += axis === 'x' ? delta[j * W + i] : delta[i * W + j];
      p[i] = s / m;
    }
    return p;
  };
  const smooth5 = (p) => {
    const out = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) {
      let s = 0, n = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j < 0 || j >= p.length) continue;
        s += p[j]; n++;
      }
      out[i] = s / n;
    }
    return out;
  };
  const metric = (p) => {
    const sm = smooth5(p);
    let stripe = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i++) {
      stripe = Math.max(stripe, Math.abs(p[i] - sm[i]));
      lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]);
    }
    return { stripe: r2(stripe), range: r2(hi - lo), profile: Array.from(p, r2) };
  };
  const mx = metric(profile('x'));
  const my = metric(profile('y'));
  console.log(`  delta profile x: range ${mx.range} stripe ${mx.stripe}  ${JSON.stringify(mx.profile)}`);
  console.log(`  delta profile y: range ${my.range} stripe ${my.stripe}  ${JSON.stringify(my.profile)}`);

  // non-vacuous: the fog must measurably vary across this receding wall
  // (measured Δ ≈ 1.2 luma on the picked region — 0.75 keeps headroom while
  // still requiring a real gradient to hunt stripes in)
  const range = Math.max(mx.range, my.range);
  if (range >= 0.75) ok(`fog gradient across the wall: Δ ${range} luma (check is meaningful)`);
  else fail(`fog delta range ${range} < 0.75 luma — banding check would be vacuous`);

  // no stripes: every varying axis smooth. Thresholds: 0.9 luma absolute
  // (measured converged noise ≈ 0.16 on this wall — 5× headroom) and half
  // the gradient — a 2-step contour across this delta would score ≥0.5.
  const bad = [];
  for (const [axis, m] of [['x', mx], ['y', my]]) {
    if (m.range < 1) continue; // axis with no gradient — nothing to band
    if (m.stripe > 0.9 || (m.range > 3 && m.stripe > 0.5 * m.range)) {
      bad.push(`${axis}: stripe ${m.stripe} over range ${m.range}`);
    }
  }
  if (bad.length) fail(`banding stripes detected — ${bad.join('; ')}`);
  else ok(`no stripe artifacts (stripe ≤ 0.9 luma and ≤ 50% of range on both axes)`);

  await hideOverlays(page);
  await page.screenshot({ path: `${OUT}/banding-wall.png` });
  console.log(`  shot: ${OUT}/banding-wall.png`);
  await page.close();
});

// ---------------------------------------------------------------------------
// debug-raw: ?rtdebug=3 must stay raw with the toggle ON (fog skipped)
// ---------------------------------------------------------------------------
await run('debug-raw', async () => {
  const b = await boot(`${BASE}/?rtdebug=3&vol=on`, 'debug-raw');
  if (!b) return;
  const { page } = b;
  await frame(page, CORRIDOR);
  await sleep(3500);
  await hideOverlays(page);
  const s = await volStats(page);
  console.log(`  volStats: ${JSON.stringify(s)}`);
  if (s && s.dispatches === 0) ok('debug-raw: fog march skipped — raw buffer view stays raw');
  else fail(`debug-raw: fog dispatched in a debug view (${s?.dispatches})`);
  await page.screenshot({ path: `${OUT}/rtdebug3-raw.png` });
  console.log(`  shot: ${OUT}/rtdebug3-raw.png`);
  await page.close();
});

// ---------------------------------------------------------------------------
// testroom: ?testroom boots rt=armed with zero errors (fog runs there too)
// ---------------------------------------------------------------------------
await run('testroom', async () => {
  const b = await boot(`${BASE}/?testroom`, 'testroom');
  if (!b) return;
  const { page, logs } = b;
  await sleep(2500);
  const errs = logs.filter((l) => l.includes('PAGEERROR') || l.startsWith('[liminal][webgpu]'));
  if (errs.length) errs.forEach((e) => fail(`testroom: ${e.slice(0, 160)}`));
  else ok('testroom: zero pageerrors, zero WebGPU errors');
  const s = await volStats(page);
  if (s && s.dispatches > 0) ok(`testroom: fog runs too (${s.dispatches} dispatches, ${s.width}×${s.height})`);
  else fail(`testroom: fog not running (${JSON.stringify(s)})`);
  await page.close();
});

await browser.close();

const results = { label: 'rt-vol', base: BASE, corridor: CORRIDOR, onLuma, failures };
writeFileSync(`${OUT}/rt-vol.json`, JSON.stringify(results, null, 1));
console.log(`\n==== ${failures.length ? `FAILED (${failures.length})` : 'PASS'} — ${OUT}/rt-vol.json + *.png`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = failures.length ? 1 : 0;
