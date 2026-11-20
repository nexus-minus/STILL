/**
 * Per-material colour + gloss proofs — headful Chromium WebGPU.
 *
 *   node scripts/rt-mat-smoke.mjs [http://localhost:5187] [phase,...]
 *
 * The scene is `?matroom` (map-loader adds it): two spheres under ONE mesh
 * fixture — smooth teal (roughness 0.1) vs matte orange (roughness 0.95) —
 * plus a cube carrying the real map's material (0.8 grey, roughness 0.9).
 * `?rtspec=0` is the pre-gloss baseline (specular branch skipped, diffuse
 * math untouched), so every before/after below is same-build A/B.
 *
 * Phases (each = one page load; screenshots + JSON to /tmp/opencode/rt-mat/):
 *   testroom  — ?testroom boots rt=armed, zero pageerrors/WebGPU errors
 *   albedo    — ?rtmat=1: the diffuse G-buffer readback. Proves what reaches
 *               the composite BEFORE lighting: per-material colours arrive
 *               (floor/walls/spheres/cube all distinct, hue-correct).
 *   gloss-off — ?rtspec=0 normal view: baseline grid (the "before" numbers)
 *   gloss-on  — normal view: same grid with per-material specular on
 *   fog       — fog ON (sacred toggle) with gloss: the highlight must still
 *               compose (beauty·T + S hazes gloss like everything else)
 *
 * Grid assertions (computed from the two grids):
 *   · smooth sphere PEAK luma rises clearly (the highlight)
 *   · matte sphere / floor / wall means move ≤ a few % (diffuse unchanged)
 *   · emissive fixture means move ≤ a few % (masked, not lit)
 *   · whole-frame mean luminance within a few %; clipped-white pixel count
 *     in diffuse-dominated regions does not explode (no blown pools)
 *
 * Numbers come from CANVAS PIXEL READS taken inside requestAnimationFrame —
 * the WebGPU canvas only holds a readable frame right after it is rendered.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5187';
const ONLY = process.argv[3] ? process.argv[3].split(',').map((s) => s.trim()) : null;
const OUT = '/tmp/opencode/rt-mat';
const CHROME = '/usr/bin/chromium';
const XDG = '/tmp/opencode/chromium-xdg-clean';
mkdirSync(OUT, { recursive: true });
mkdirSync(XDG, { recursive: true });

/** exact freecam framing of the material pair (fixed camera = fixed grids) */
const PAIR = { pos: [0, 1.5, 17.4], look: [0, 1.2, 21.3] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const results = { label: 'rt-mat', base: BASE, phases: {} };

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

/**
 * This is a HEADFUL window: physical keys (another tool, the person at the
 * machine) reach the page — a stray N flips the whole scene to wireframe and
 * a stray F hands the camera back to physics, which would silently poison a
 * grid read. Force the toggles back and verify the framing holds.
 */
async function sanitize(page, fr) {
  const st = await page.evaluate((f) => {
    const L = window.__liminal;
    let wire = 0;
    L.scene.traverse((o) => {
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m && m.wireframe) { m.wireframe = false; wire++; }
    });
    const c = L.camera.position;
    return {
      wire,
      freecam: !!L.controller.freecam,
      glow: !!L.pipeline.glowOn,
      drift: Math.hypot(c.x - f.pos[0], c.y - f.pos[1], c.z - f.pos[2]),
    };
  }, fr);
  if (st.wire) console.log(`  note: forced ${st.wire} wireframe material(s) back off (stray KeyN?)`);
  if (!st.freecam || st.drift > 0.05) {
    console.log(`  note: framing lost (freecam=${st.freecam} drift=${st.drift.toFixed(2)}m) — re-framing`);
    await frame(page, fr);
    await sleep(1500);
  }
  return st;
}

/** in-page frame-timed canvas readback helpers */
async function installRead(page) {
  await page.evaluate(() => {
    const canvas = () => document.querySelector('canvas#game');
    const nextFrame = (fn) => new Promise((res) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; res(null); } }, 3000);
      requestAnimationFrame(() => {
        if (done) return;
        done = true; clearTimeout(t); res(fn());
      });
    });
    const lumaOf = (d, i) => 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
    const grab = (x, y, w, h) => {
      const c = canvas();
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0);
      return g.getImageData(Math.round(x), Math.round(y),
        Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
    };
    /** luma array of a rect (plain array: puppeteer serialises typed arrays as objects) */
    const readRegion = (x, y, w, h) => nextFrame(() => {
      const d = grab(x, y, w, h);
      const out = new Float32Array(d.length / 4);
      for (let i = 0; i < out.length; i++) out[i] = lumaOf(d, i);
      return Array.from(out);
    });
    /** mean luma + clipped count over the WHOLE frame (scanned in-page) */
    const frameStats = () => nextFrame(() => {
      const c = canvas();
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0, clipped = 0;
      const n = c.width * c.height;
      for (let i = 0; i < n; i++) {
        const v = lumaOf(d, i);
        sum += v;
        if (v >= 250) clipped++;
      }
      return { mean: sum / n, clipped, pixels: n };
    });
    window.__mat = { readRegion, frameStats, canvas };
  });
}

/** grid regions in CANVAS px for the PAIR framing (fixed camera → fixed px) */
const REGIONS = {
  smoothSphere: { x: 788, y: 338, w: 204, h: 204 }, // teal, roughness 0.1
  roughSphere: { x: 286, y: 338, w: 204, h: 204 },  // orange, roughness 0.95
  greyCube: { x: 600, y: 360, w: 80, h: 70 },       // map material (0.9)
  floor: { x: 520, y: 570, w: 240, h: 100 },        // carpet (roughness 1)
  wall: { x: 560, y: 300, w: 160, h: 40 },          // back wall (0.95)
  fixture: { x: 560, y: 70, w: 160, h: 80 },        // emissive mesh fixture
  panel: { x: 430, y: 232, w: 60, h: 26 },          // emissive ceiling panel
};

const stats = (a) => {
  let sum = 0;
  for (const v of a) sum += v;
  const mean = sum / a.length;
  return { mean, peak: Math.max(...a) };
};

/** read every grid region on the current page (3 reads, averaged) */
async function readGrid(page) {
  const grid = {};
  for (const [name, r] of Object.entries(REGIONS)) {
    const acc = [];
    for (let k = 0; k < 3; k++) {
      const a = await page.evaluate((rr) => window.__mat.readRegion(rr.x, rr.y, rr.w, rr.h), r);
      if (!a) throw new Error(`region read timed out: ${name}`);
      acc.push(a);
    }
    const n = acc[0].length;
    const out = new Array(n).fill(0);
    for (const a of acc) for (let i = 0; i < n; i++) out[i] += a[i] / acc.length;
    grid[name] = { ...stats(out), arr: out };
  }
  return grid;
}

const pct = (on, off) => (off > 0 ? ((on - off) / off) * 100 : 0);

/**
 * Paired comparison of two grids read at IDENTICAL framing (the camera is set
 * programmatically, the scene is static): pixel i is the same surface point in
 * both runs, so the per-pixel DIFF is exactly what the specular added — far
 * more sensitive than comparing each run's own peak (which may sit on a
 * different pixel).
 */
const paired = (on, off) => {
  let sum = 0;
  let peakGain = -Infinity;
  let worst = 0;
  for (let i = 0; i < on.length; i++) {
    const d = on[i] - off[i];
    sum += d;
    if (d > peakGain) peakGain = d;
    if (d < worst) worst = d;
  }
  return { meanGain: sum / on.length, peakGain, worstGain: worst };
};

// ---------------------------------------------------------------------------
// testroom: the required ?testroom boot proof
// ---------------------------------------------------------------------------
await run('testroom', async () => {
  const b = await boot(`${BASE}/?testroom`, 'testroom');
  if (!b) return;
  await sleep(1500);
  const { page, logs } = b;
  const errs = logs.filter((l) => l.includes('PAGEERROR') || l.startsWith('[liminal][webgpu]'));
  if (errs.length) errs.forEach((e) => fail(`testroom: ${e.slice(0, 160)}`));
  else ok('testroom: zero pageerrors, zero WebGPU errors');
  await page.close();
});

// ---------------------------------------------------------------------------
// albedo: what reaches the composite BEFORE lighting (?rtmat=1)
// ---------------------------------------------------------------------------
await run('albedo', async () => {
  const b = await boot(`${BASE}/?matroom&rtmat=1&vol=off`, 'albedo');
  if (!b) return;
  const { page } = b;
  await installRead(page);
  await frame(page, PAIR);
  await sleep(3500);
  await hideOverlays(page);
  await sleep(400);
  await sanitize(page, PAIR);
  const grid = await readGrid(page);
  for (const [k, v] of Object.entries(grid)) {
    console.log(`  ${k.padEnd(14)} mean ${r1(v.mean)}  peak ${r1(v.peak)}`);
  }
  await page.screenshot({ path: `${OUT}/albedo-gbuffer.png` });
  // hue checks against the authored materials (post-AgX display values)
  const s = grid.smoothSphere.mean;
  const m = grid.roughSphere.mean;
  const g = grid.greyCube.mean;
  const floor = grid.floor.mean;
  if (s >= 40 && s <= 250) ok(`smooth sphere albedo readable (${r1(s)})`);
  else fail(`smooth sphere albedo unreadable (${r1(s)})`);
  if (m >= 40 && m <= 250) ok(`rough sphere albedo readable (${r1(m)})`);
  else fail(`rough sphere albedo unreadable (${r1(m)})`);
  if (g >= 60 && g <= 250) ok(`map-grey cube albedo readable (${r1(g)})`);
  else fail(`map-grey cube albedo unreadable (${r1(g)})`);
  if (floor >= 20 && floor <= 250) ok(`floor albedo readable (${r1(floor)})`);
  else fail(`floor albedo unreadable (${r1(floor)})`);
  // the two spheres must be DIFFERENT colours, not one shared grey
  const sep = Math.abs(s - m);
  if (sep > 10) ok(`sphere albedos differ by ${r1(sep)} luma (per-object colour reaches the G-buffer)`);
  else fail(`sphere albedos too close (${r1(sep)}) — one material?`);
  // hue: read the actual rgb to assert teal vs orange (luma alone can't)
  const rgb = await page.evaluate(async () => {
    const c = window.__mat.canvas();
    const read = (x, y) => new Promise((res) => {
      requestAnimationFrame(() => {
        const t = document.createElement('canvas');
        t.width = c.width; t.height = c.height;
        const g = t.getContext('2d', { willReadFrequently: true });
        g.drawImage(c, 0, 0);
        const d = g.getImageData(x, y, 40, 40).data;
        let r = 0, gg = 0, b = 0;
        const n = d.length / 4;
        for (let i = 0; i < n; i++) { r += d[4 * i]; gg += d[4 * i + 1]; b += d[4 * i + 2]; }
        res([r / n, gg / n, b / n]);
      });
      setTimeout(() => res(null), 3000);
    });
    return { smooth: await read(868, 410), rough: await read(370, 410) };
  });
  if (rgb.smooth && rgb.rough) {
    const [sr, sg, sb] = rgb.smooth;
    const [mr, mg, mb] = rgb.rough;
    console.log(`  sphere rgb — smooth [${rgb.smooth.map(r1)}] rough [${rgb.rough.map(r1)}]`);
    if (sg > sr && sb > sr) ok('smooth sphere albedo is TEAL (g,b > r)');
    else fail(`smooth sphere not teal: [${rgb.smooth.map(r1)}]`);
    if (mr > mg && mr > mb) ok('rough sphere albedo is ORANGE (r > g,b)');
    else fail(`rough sphere not orange: [${rgb.rough.map(r1)}]`);
  } else fail('sphere rgb read timed out');
  for (const k of Object.keys(grid)) delete grid[k].arr;
  results.phases.albedo = { grid, rgb };
  await page.close();
});

// ---------------------------------------------------------------------------
// gloss A/B: ?rtspec=0 (before) vs default (after), identical framing
// ---------------------------------------------------------------------------
async function glossPhase(name, url) {
  const b = await boot(url, name);
  if (!b) return;
  const { page } = b;
  await installRead(page);
  await frame(page, PAIR);
  await sleep(4500); // static camera → temporal + à-trous converge
  await hideOverlays(page);
  await sleep(400);
  const st1 = await sanitize(page, PAIR);
  const grid = await readGrid(page);
  // a stray key during the region reads would poison the frame stats
  await sanitize(page, PAIR);
  const fstats = await page.evaluate(() => window.__mat.frameStats());
  console.log(`  frame mean ${r1(fstats.mean)}  clipped≥250 ${fstats.clipped}`);
  for (const [k, v] of Object.entries(grid)) {
    console.log(`  ${k.padEnd(14)} mean ${r1(v.mean)}  peak ${r1(v.peak)}`);
  }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  results.phases[name] = { grid, frame: fstats, glow: st1.glow };
  await page.close();
}

await run('gloss-off', () => glossPhase('gloss-off', `${BASE}/?matroom&rtspec=0&vol=off`));
await run('gloss-on', () => glossPhase('gloss-on', `${BASE}/?matroom&vol=off`));

// assertions only when BOTH grids exist (filtered runs skip them)
if (!ONLY || (ONLY.includes('gloss-off') && ONLY.includes('gloss-on'))) {
  const off = results.phases['gloss-off'];
  const on = results.phases['gloss-on'];
  if (off && on) {
    console.log('\n== gloss A/B (?rtspec=0 → default), paired per-pixel diff');
    if (off.glow !== on.glow) {
      fail(`glow/bloom state differs between runs (off=${off.glow}, on=${on.glow}) — stray toggle?`);
    }
    const ab = {};
    for (const key of Object.keys(REGIONS)) {
      const p = paired(on.grid[key].arr, off.grid[key].arr);
      const base = off.grid[key].mean;
      ab[key] = {
        offMean: r1(base),
        onMean: r1(on.grid[key].mean),
        meanGain: r1(p.meanGain),
        meanGainPct: r2((p.meanGain / base) * 100),
        peakGain: r1(p.peakGain),
        worstGain: r1(p.worstGain),
      };
      console.log(
        `  ${key.padEnd(14)} mean ${ab[key].offMean} → ${ab[key].onMean}` +
          `  meanΔ ${p.meanGain >= 0 ? '+' : ''}${ab[key].meanGain} (${ab[key].meanGainPct}%)` +
          `  peakΔ +${ab[key].peakGain}  worstΔ ${ab[key].worstGain}`,
      );
    }
    // 1. the highlight: the smooth sphere must GAIN a clearly bright pixel.
    //    The threshold is a robust floor, not a pinned measurement: peakΔ is
    //    an AgX-COMPRESSED difference, so it shifts when upstream veil/fog
    //    changes brighten the A/B captures unequally (observed: 28.8 -> 21.6
    //    after the fog floor-anchor fix, with the highlight equally visible).
    //    Invariant = "clearly visible highlight" (~+12 luma is unmistakable
    //    on a ~160 background); current measurements sit near +22.
    if (ab.smoothSphere.peakGain >= 12 && ab.smoothSphere.meanGainPct >= 0.7) {
      ok(`smooth surface: clear specular highlight (peakΔ +${ab.smoothSphere.peakGain} luma, meanΔ ${ab.smoothSphere.meanGainPct}%)`);
    } else {
      fail(`smooth sphere highlight too weak (peakΔ +${ab.smoothSphere.peakGain}, meanΔ ${ab.smoothSphere.meanGainPct}%)`);
    }
    // 2. rough / diffuse-dominated regions must be ~unchanged
    for (const key of ['roughSphere', 'greyCube', 'floor', 'wall']) {
      if (Math.abs(ab[key].meanGainPct) <= 3) ok(`${key}: diffuse unchanged within noise (${ab[key].meanGainPct}%)`);
      else fail(`${key}: mean moved ${ab[key].meanGainPct}% (> 3%) — specular leaking into diffuse regions`);
    }
    // 3. emissive fixtures masked
    for (const key of ['fixture', 'panel']) {
      if (Math.abs(ab[key].meanGainPct) <= 3) ok(`${key}: emissive surface unaffected (${ab[key].meanGainPct}%)`);
      else fail(`${key}: emissive surface moved ${ab[key].meanGainPct}%`);
    }
    // 4. no energy blowout: frame mean within a few %, no clipped-white pools
    const fm = pct(on.frame.mean, off.frame.mean);
    console.log(`  frame mean ${r1(off.frame.mean)} → ${r1(on.frame.mean)} (${fm >= 0 ? '+' : ''}${r1(fm)}%)`);
    if (Math.abs(fm) <= 4) ok(`mean luminance within a few % (${r1(fm)}%)`);
    else fail(`frame mean moved ${r1(fm)}%`);
    const clipDelta = on.frame.clipped - off.frame.clipped;
    const clipPct = pct(on.frame.clipped, off.frame.clipped);
    console.log(`  clipped≥250 ${off.frame.clipped} → ${on.frame.clipped} (${clipDelta >= 0 ? '+' : ''}${clipDelta} px, ${r1(clipPct)}%)`);
    if (clipDelta <= Math.max(2000, off.frame.clipped * 0.25)) {
      ok(`no clipped-white explosion (+${clipDelta} px — highlight cores only)`);
    } else fail(`clipped-white pixels +${clipDelta} (blown pools?)`);
    results.phases.glossAB = ab;
    // drop the raw arrays (huge JSON) — the paired summary above keeps them
    for (const g of [off.grid, on.grid]) for (const k of Object.keys(g)) delete g[k].arr;
  } else if (!ONLY) {
    fail('gloss A/B: a phase did not run');
  }
}

// ---------------------------------------------------------------------------
// fog: the sacred toggle ON — gloss must compose through beauty·T + S
// ---------------------------------------------------------------------------
await run('fog', async () => {
  const b = await boot(`${BASE}/?matroom`, 'fog');
  if (!b) return;
  const { page, logs } = b;
  await installRead(page);
  await frame(page, PAIR);
  await sleep(4500);
  await hideOverlays(page);
  await sleep(400);
  await sanitize(page, PAIR);
  const vol = await page.evaluate(() => window.__liminal.volStats ?? null);
  console.log(`  volStats: ${JSON.stringify(vol)}`);
  const grid = await readGrid(page);
  console.log(`  smooth sphere mean ${r1(grid.smoothSphere.mean)} peak ${r1(grid.smoothSphere.peak)} (fog on)`);
  await page.screenshot({ path: `${OUT}/fog-on.png` });
  if (vol && vol.dispatches > 0) ok(`fog ran (${vol.dispatches} dispatches) with gloss composited`);
  else fail(`fog did not run (${JSON.stringify(vol)})`);
  if (grid.smoothSphere.peak >= 60) ok('highlight survives the fog composite');
  else fail(`highlight vanished under fog (peak ${r1(grid.smoothSphere.peak)})`);
  for (const k of Object.keys(grid)) delete grid[k].arr;
  results.phases.fog = { grid, vol };
  await page.close();
});

await browser.close();
writeFileSync(`${OUT}/rt-mat.json`, JSON.stringify(results, null, 1));
console.log(`\n==== ${failures.length ? `FAILED (${failures.length})` : 'PASS'} — ${OUT}/rt-mat.json + *.png`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = failures.length ? 1 : 0;
