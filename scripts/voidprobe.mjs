/** Runs assets/voidprobe.html and prints its verdict lines. */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--use-webgpu-adapter=swiftshader',
  ],
});
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.goto(process.argv[2] ?? 'http://localhost:4173/voidprobe.html', { waitUntil: 'domcontentloaded' });
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const done = await page.evaluate(() => window.__vp?.done).catch(() => null);
    if (done) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const result = await page.evaluate(() => window.__vp).catch(() => null);
  console.log(JSON.stringify(result, null, 1));
  if (!result?.done) console.log('logs:', logs.slice(-5).join(' | '));
} finally {
  await browser.close();
}
