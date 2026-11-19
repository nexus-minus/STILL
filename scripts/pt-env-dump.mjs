import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: false,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-webgpu','--window-size=1280,800'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto((process.env.PT_URL || 'http://localhost:5174/pathtrace.html') + '?env=20', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 8000));
  const dump = await page.evaluate(() => {
    const t = window.__pathtrace.tracer;
    const pt = t._pathTracer;
    const tex = t._environmentCache?.texture;
    return {
      envCacheType: tex?.constructor?.name,
      envIsColor: !!tex?.isColor,
      envData: tex?.image?.data ? Array.from(tex.image.data.slice(0, 8)) : null,
      envMapping: tex?.mapping,
      envIntensity: pt?.envInfo?.intensityNode?.value,
      sceneEnvIntensity: window.__pathtrace.scene.environmentIntensity,
      hasSetEnv: typeof pt?.setEnvironment,
      envVersion: tex?.version,
      envNeedsUpdate: tex?.needsUpdate,
    };
  });
  console.log(JSON.stringify(dump, null, 2));
} finally { await browser.close(); }
