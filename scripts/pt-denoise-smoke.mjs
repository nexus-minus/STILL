import puppeteer from 'puppeteer-core';
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
  await page.goto('http://localhost:4173/pathtrace.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 8000));
  // gameplay config: 8 samples + neural denoise
  await page.evaluate(() => {
    const s = document.getElementById('samples');
    s.value = '8';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#denoise');
  console.log('denoise toggled:', await page.$eval('#status', e => e.textContent));
  // wait for 8 spp to settle + weight download + denoise pass
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const status = await page.$eval('#status', e => e.textContent);
    console.log(`t+${(i+1)*3}s:`, status);
    if (/denoised|error|failed/i.test(status)) break;
  }
  const state = await page.evaluate(() => {
    const t = window.__pathtrace.tracer;
    const d = t._denoiser;
    return { samples: t._lastSampleCounts, denoiser: !!d, complete: d?.complete, running: d?.running, failed: d?._failed };
  }).catch(e => ({ evalError: e.message }));
  console.log('STATE', JSON.stringify(state));
  for (const l of logs.slice(-8)) console.log(l);
  await page.screenshot({ path: 'screenshots/pt-denoised.png' });
} finally { await browser.close(); }
