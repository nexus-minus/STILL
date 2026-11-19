/** Spawn sanity: pitch/yaw NaN? camera under the floor? both engines. */
import puppeteer from 'puppeteer-core';

const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'];

async function check(label, launchOpts) {
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 600 });
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto('http://localhost:4173', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !logs.some((l) => l.includes('[liminal] up')); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const diag = await page.evaluate(() => {
      const g = window.__liminal;
      const THREE = g.THREE;
      const c = g.controller;
      const cam = g.camera;
      const probe = (dir) => {
        const hit = g.collision.raycast(cam.position, new THREE.Vector3(...dir), 100);
        return hit ? { dist: +hit.distance.toFixed(2), y: +hit.point.y.toFixed(2) } : null;
      };
      return {
        pitch: c.pitch,
        yaw: c.yaw,
        camRot: [cam.rotation.x, cam.rotation.y, cam.rotation.z].map((v) => +v.toFixed(3)),
        camPos: cam.position.toArray().map((v) => +v.toFixed(2)),
        ctrlPos: c.position.toArray().map((v) => +v.toFixed(2)),
        finite: Number.isFinite(c.pitch) && Number.isFinite(c.yaw) && Number.isFinite(cam.position.y),
        down: probe([0, -1, 0]),
        up: probe([0, 1, 0]),
      };
    });
    console.log(`=== ${label} ===`);
    console.log(JSON.stringify(diag));
  } finally {
    await browser.close();
  }
}

await check('chromium (forced GL)', {
  executablePath: '/usr/bin/chromium',
  headless: true,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: [...CHROMIUM_ARGS],
});
await check('firefox', {
  browser: 'firefox',
  executablePath: '/usr/bin/firefox',
  headless: true,
});
