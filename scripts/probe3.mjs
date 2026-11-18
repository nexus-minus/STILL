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
    const FRONT = THREE.FrontSide, DOUBLE = THREE.DoubleSide;
    const pts = [[0,0],[3,0],[-3,0],[0,3],[0,-3],[5,-5],[-5,-13],[0.8,-13],[10.3,-30.7],[0,-30]];
    return pts.map(([x, z]) => {
      const from = new THREE.Vector3(x, 25, z);
      const down = new THREE.Vector3(0, -1, 0);
      const front = g.collision.bvh.raycastFirst(new THREE.Ray(from, down), FRONT, 0, 300);
      const dbl = g.collision.bvh.raycastFirst(new THREE.Ray(from, down), DOUBLE, 0, 300);
      return { x, z, frontY: front ? +front.point.y.toFixed(1) : null, doubleY: dbl ? +dbl.point.y.toFixed(1) : null };
    });
  });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
