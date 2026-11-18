import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true });
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('http://localhost:4173', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 60 && !logs.some((l) => l.includes('[liminal] up')); i++) await new Promise(r => setTimeout(r, 200));
  const result = await page.evaluate(() => {
    const g = window.__liminal;
    const THREE = g.THREE;
    const probes = [];
    for (const [x, z] of [[0.8, -18], [0.8, -13], [10.3, -30.7], [0.8, -48], [19.9, -13]]) {
      const hit = g.collision.raycast(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0), 200);
      probes.push({ x, z, hitY: hit ? +hit.point.y.toFixed(1) : null });
    }
    return probes;
  });
  console.log(JSON.stringify(result, null, 1));
} finally { await browser.close(); }
