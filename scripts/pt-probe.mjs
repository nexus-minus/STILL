import puppeteer from 'puppeteer-core';
const url = process.env.PT_URL || 'http://localhost:4173/pathtrace.html';
const out = process.env.PT_OUT || 'screenshots/pt-probe.png';
const clicks = (process.env.PT_CLICKS || '').split(',').filter(Boolean);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: false,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-webgpu','--window-size=1280,800'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 8000));
  for (const sel of clicks) {
    await page.click(sel);
    console.log('clicked', sel, '->', await page.$eval('#status', e => e.textContent));
    await new Promise(r => setTimeout(r, 6000));
  }
  console.log('URL:', url, 'clicks:', clicks.join(','));
  console.log('status:', await page.$eval('#status', e => e.textContent).catch(() => 'n/a'));
  for (const l of logs.slice(-6)) console.log(l);
  await page.screenshot({ path: out });
} finally { await browser.close(); }
