/**
 * Storage-buffer binding probe — proves the mechanism rt.ts uses for the
 * UNCAPPED light list: a `storage()` node in the `includes` array of a raw
 * `wgslFn` must emit its module-scope `var<storage>` declaration so the raw
 * WGSL can index it by name.
 *
 *   node scripts/rt-storage-probe.mjs [http://localhost:5177]
 *
 * Loads the game origin (vite resolves the probe module's bare `three/*`
 * imports), then runs scripts/rt-storage-probe-page.mjs in-page: builds a
 * tiny compute kernel, dispatches, reads the output buffer back and checks
 * the transform. PASS = storage-in-wgslFn path is viable for rt.ts.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5177';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: false,
  protocolTimeout: 120000,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu'],
});

try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(500);
  const result = await page.evaluate(async () => {
    try {
      const m = await import('/scripts/rt-storage-probe-page.mjs');
      return await m.runStorageProbe();
    } catch (e) {
      return { ok: false, error: String(e?.stack ?? e), stage: 'import' };
    }
  });
  console.log(JSON.stringify(result, null, 1));
  for (const l of logs.filter((l) => l.includes('webgpu') || l.includes('ERROR') || l.includes('error'))) {
    console.log(`  console: ${l.slice(0, 300)}`);
  }
  const pass = result.ok;
  console.log(`\n==== ${pass ? 'PASS' : 'FAIL'} — storage-in-wgslFn includes path ${pass ? 'works' : 'does NOT work'}`);
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
