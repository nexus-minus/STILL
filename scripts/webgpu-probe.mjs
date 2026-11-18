/**
 * Finds a STABLE headless-Chromium WebGPU configuration on this machine.
 * For each flag combo: boot the raw WebGPU probe page, confirm it draws,
 * wait 2s, confirm the device is still alive and frames still advance.
 *
 *   node scripts/webgpu-probe.mjs   (needs preview server on 4173)
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://localhost:4173/probe.html';
const CHROME = process.env.CHROME ?? '/usr/bin/chromium';
// The Arch chromium launcher reads ~/.config/chromium-flags.conf for EVERY
// launch (including puppeteer's) — isolate from the user's flags by pointing
// XDG_CONFIG_HOME at an empty dir (set USE_USER_FLAGS=1 to keep them).
const CLEAN_XDG = process.env.USE_USER_FLAGS !== '1';
const XDG_DIR = '/tmp/opencode/chromium-xdg-clean';
if (CLEAN_XDG) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(XDG_DIR, { recursive: true });
}
// HEADFUL=1 -> run with a real display (Wayland/X) instead of headless —
// headless compositing is suspected of never presenting WebGPU canvases.
const HEADFUL = process.env.HEADFUL === '1';
// FF_WEBGPU=1 -> run the probe in Firefox with WebGPU enabled via pref —
// Chromium 155 on this machine destroys its Dawn instance within 4ms
// regardless of flags, Firefox (wgpu-native) may be healthier.
const USE_FIREFOX_WEBGPU = process.env.FF_WEBGPU === '1';
if (USE_FIREFOX_WEBGPU) {
  const { writeFileSync, mkdirSync: mk } = await import('node:fs');
  mk('/tmp/opencode/ffprof', { recursive: true });
  writeFileSync(
    '/tmp/opencode/ffprof/user.js',
    [
      'user_pref("dom.webgpu.enabled", true);',
      'user_pref("gfx.webgpu.ignore-blocklist", true);',
      'user_pref("dom.webgpu.testing.assert-hardware-adapter", true);',
      'user_pref("webgl.force-enabled", true);',
      'user_pref("webgl.enable-webgl2", true);',
      'user_pref("media.hardware-video-decoding.enabled", false);',
    ].join('\n'),
  );
}

const CONFIGS = USE_FIREFOX_WEBGPU
  ? [{ name: 'firefox + dom.webgpu.enabled', args: [] }]
  : [
      { name: 'A: unsafe + ss-adapter + disable-gpu', args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--disable-gpu'] },
      { name: 'B: ss-adapter only (no unsafe)', args: ['--use-webgpu-adapter=swiftshader'] },
      { name: 'C: unsafe + ss-adapter', args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] },
      { name: 'D: ss-adapter + disable-gpu + disable-vulkan', args: ['--use-webgpu-adapter=swiftshader', '--disable-gpu', '--disable-vulkan', '--enable-unsafe-webgpu'] },
      { name: 'E: compat-adapter', args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=compat'] },
      { name: 'F: unsafe + WebGPUService features', args: ['--enable-unsafe-webgpu', '--enable-features=WebGPUService,Vulkan', '--use-webgpu-adapter=swiftshader'] },
    ];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stable = null;

for (const cfg of CONFIGS) {
  let browser;
  try {
    browser = USE_FIREFOX_WEBGPU
      ? await puppeteer.launch({
          browser: 'firefox',
          executablePath: process.env.FIREFOX ?? '/usr/bin/firefox',
          headless: !HEADFUL,
          userDataDir: '/tmp/opencode/ffprof',
          firefoxUserPrefs: {
            'dom.webgpu.enabled': true,
            'gfx.webgpu.ignore-blocklist': true,
          },
        })
      : await puppeteer.launch({
          executablePath: CHROME,
          headless: !HEADFUL,
          env: CLEAN_XDG ? { ...process.env, XDG_CONFIG_HOME: XDG_DIR } : process.env,
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--window-size=640,400', ...cfg.args],
        });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 400 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // wait until it's drawing
    let booted = false;
    const bootDeadline = Date.now() + 8000;
    while (Date.now() < bootDeadline) {
      const st = await page.evaluate(() => window.__probe?.stage ?? 'none').catch(() => 'none');
      if (typeof st === 'string' && st.startsWith('drawing#')) {
        booted = true;
        break;
      }
      if (st === 'error') break;
      await sleep(200);
    }

    if (booted) {
      await sleep(6500); // watch for ~6.5s: does the device survive?
      const info = await page.evaluate(() => {
        const p = window.__probe;
        return { stage: p.stage, frame: p.frame, log: p.out, timeline: window.__timeline ?? [], readback: p.readback, lostMs: p.lostMs };
      });
      const tl = info.timeline;
      const last = tl[tl.length - 1] ?? {};
      const alive = !String(info.stage).startsWith('LOST') && info.stage !== 'error';
      const stillDrawing = String(info.stage).startsWith('drawing#');
      const framesStillMoving = tl.length >= 2 && tl[tl.length - 1].frame > tl[tl.length - 2].frame;
      const presentation = (last.max ?? 0) >= 64;
      const readbackOk = typeof info.readback === 'string' && /^(\d+),(\d+),(\d+)/.test(info.readback)
        && Number(info.readback.split(',')[1]) > 100; // green triangle
      const pass = alive && stillDrawing && framesStillMoving && (presentation || readbackOk);
      console.log(`[${cfg.name}] => ${pass ? 'STABLE' : 'FAIL'} stage=${info.stage} presentation=${presentation} readback=${info.readback} lostMs=${info.lostMs ?? '—'}`);
      for (const e of [...tl.slice(0, 2), ...tl.slice(-3)]) console.log(`    t=${e.ms}ms frame=${e.frame} stage=${e.stage} max=${e.max}`);
      for (const l of info.log) console.log(`    ${l}`);
      if (errors.length) console.log(`    pageerrors: ${errors.slice(0, 3).join(' | ')}`);
      if (pass && !stable) stable = cfg;
    } else {
      const stage = await page.evaluate(() => JSON.stringify(window.__probe)).catch(() => '?');
      console.log(`[${cfg.name}] did NOT reach drawing stage — ${stage}`);
      if (USE_FIREFOX_WEBGPU) {
        // does this Firefox even have the WebGPU subsystem? ask about:support
        try {
          await page.goto('about:support', { waitUntil: 'domcontentloaded', timeout: 10000 });
          await sleep(1500);
          const text = await page.evaluate(() => document.body.innerText);
          const feat = text.split('\n').filter((l) => /webgpu/i.test(l)).slice(0, 6);
          console.log('    about:support WebGPU lines:');
          for (const l of feat) console.log('      ' + l.trim());
        } catch (e) {
          console.log('    about:support failed: ' + e.message);
        }
      }
    }
  } catch (err) {
    console.log(`[${cfg.name}] launch/goto failed: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
  if (stable) break; // first stable config wins
}

console.log(stable ? `\nSTABLE CONFIG: ${JSON.stringify(stable.args)}` : '\nNO STABLE CONFIG FOUND');
if (!stable) process.exitCode = 1;
