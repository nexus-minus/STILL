/**
 * One-off diagnostic: which way is the camera actually looking and what does
 * it hit?  node scripts/diag.mjs  (needs the preview server running)
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://localhost:4173';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 50 && !logs.some((l) => l.includes('[liminal] up')); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const result = await page.evaluate(() => {
    const g = window.__liminal;
    const { THREE } = g;
    const cam = g.camera;
    const out = {
      camPos: cam.position.toArray().map((v) => +v.toFixed(2)),
      camRot: [cam.rotation.x, cam.rotation.y, cam.rotation.z].map((v) => +(v * 57.3).toFixed(1)),
      quat: cam.quaternion.toArray().map((v) => +v.toFixed(3)),
      fov: cam.fov,
      aspect: +cam.aspect.toFixed(3),
      near: cam.near,
      far: cam.far,
      matrixWorld: cam.matrixWorld.elements.map((v) => +v.toFixed(2)),
    };

    const dirs = {
      forward: [0, 0, -1],
      back: [0, 0, 1],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      down: [0, -1, 0],
      up: [0, 1, 0],
    };
    out.hits = {};
    for (const [name, d] of Object.entries(dirs)) {
      const hit = g.collision.raycast(cam.position, new THREE.Vector3(...d), 100);
      out.hits[name] = hit ? { dist: +hit.distance.toFixed(2), point: hit.point.toArray().map((v) => +v.toFixed(2)) } : null;
    }

    // count scene objects
    let meshes = 0;
    g.scene.traverse((o) => { if (o.isMesh) meshes++; });
    out.meshes = meshes;

    // where are the first few world matrices
    const sample = [];
    g.scene.traverse((o) => {
      if (o.isMesh && sample.length < 6) {
        const p = new THREE.Vector3();
        o.getWorldPosition(p);
        sample.push({ name: o.geometry.type, pos: p.toArray().map((v) => +v.toFixed(1)) });
      }
    });
    out.sampleMeshes = sample;
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
