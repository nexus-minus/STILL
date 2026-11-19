import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/chromium',
  headless: process.env.HEADFUL !== '1',
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--window-size=1280,800'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`PAGEERROR ${e.message}`));
  await page.goto('http://localhost:4173/pathtrace-sanity.html', {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await new Promise((r) => setTimeout(r, 8000));
  console.log('status:', await page.$eval('#status', (el) => el.textContent));
  for (const line of logs.slice(-12)) console.log(line);
  await page.screenshot({ path: 'screenshots/pathtrace-sanity.png' });
} finally {
  await browser.close();
}
