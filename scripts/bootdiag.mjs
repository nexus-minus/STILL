import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: '/usr/bin/firefox',
  headless: true,
});
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', async (m) => {
    let line = `[${m.type()}] ${m.text()}`;
    if (m.type() === 'error' || m.type() === 'warn') {
      for (const arg of m.args()) {
        try {
          const v = await arg.evaluate((e) => (e && e.stack) ? e.stack : String(e));
          line += '\n   -> ' + v;
        } catch { /* opaque handle */ }
      }
    }
    logs.push(line);
  });
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));
  await page.goto(process.argv[2] ?? 'http://localhost:4173', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 6000));
  const state = await page.evaluate(() => ({
    fatal: document.getElementById('fatal')?.textContent ?? '(none)',
    hasHandle: !!window.__liminal,
    stage: window.__liminalStage ?? '?',
  }));
  console.log('--- state ---');
  console.log(JSON.stringify(state, null, 2));
  console.log('--- console ---');
  for (const l of logs.slice(-30)) console.log(l);
} finally {
  await browser.close();
}
