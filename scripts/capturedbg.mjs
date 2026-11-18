import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: '/usr/bin/firefox',
  headless: true,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.goto('http://localhost:4173', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 60 && !logs.some((l) => l.includes('[liminal] up')); i++) await sleep(200);

  await page.evaluate(() => window.__liminal.settings.open());
  const afterClick = await page.evaluate(() => {
    const btn = document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button');
    const before = { text: btn.textContent, cls: btn.className };
    btn.click();
    return {
      before,
      after: { text: btn.textContent, cls: btn.className },
      perfNow: performance.now(),
    };
  });
  console.log('after synthetic click:', JSON.stringify(afterClick));

  await page.keyboard.press('KeyJ');
  await sleep(200);
  const afterKey = await page.evaluate(() => ({
    forward: window.__liminal.bindings.get('forward'),
    text: document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button').textContent,
    cls: document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button').className,
  }));
  console.log('after KeyJ:', JSON.stringify(afterKey));

  // try a REAL mouse click on the button (like a human)
  const box = await page.evaluate(() => {
    const r = document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await sleep(200);
  const afterRealClick = await page.evaluate(() => ({
    text: document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button').textContent,
    cls: document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button').className,
  }));
  console.log('after real click:', JSON.stringify(afterRealClick));

  await page.keyboard.press('KeyK');
  await sleep(200);
  const afterK = await page.evaluate(() => window.__liminal.bindings.get('forward'));
  console.log('forward after real-click+KeyK:', afterK);

  // right-mouse capture probe on row1 ("Move back")
  const box1 = await page.evaluate(() => {
    const r = document.querySelectorAll('#set-binds .bind-row')[1].querySelector('button').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box1.x, box1.y);
  await sleep(200);
  const captureState = await page.evaluate(() => ({
    capturing: !!document.querySelector('.bind-row button.capturing'),
    listenersProbe: typeof window.__mousedownProbe,
  }));
  console.log('capture active before right press:', JSON.stringify(captureState));

  await page.mouse.down({ button: 'right' });
  await sleep(100);
  const midState = await page.evaluate(() => ({
    back: window.__liminal.bindings.get('back'),
    capturing: !!document.querySelector('.bind-row button.capturing'),
    contextVisible: !!document.querySelector('#context-menu'),
  }));
  console.log('after right mousedown:', JSON.stringify(midState));
  await page.mouse.up({ button: 'right' });
  await sleep(200);
  const afterRight = await page.evaluate(() => ({
    back: window.__liminal.bindings.get('back'),
    label: document.querySelectorAll('#set-binds .bind-row')[1].querySelector('button').textContent,
  }));
  console.log('after right full click:', JSON.stringify(afterRight));
  console.log('logs:', logs.slice(-3).join(' | '));
} finally {
  await browser.close();
}
