/**
 * Settings menu e2e: open via handle, verify rows, rebind a key through the
 * capture flow, move a slider, confirm persistence — plus modified-from-preset
 * badges, keybind conflict warnings and exposure save/restore — then screenshot.
 *
 *   node scripts/settings-test.mjs [baseURL]   (default: http://localhost:4173)
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://localhost:4173';
const logs = [];
let failed = false;

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX ?? '/usr/bin/firefox',
  headless: true,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed = true;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => {
    logs.push('PAGEERROR ' + e.message);
    failed = true;
  });

  /** human-like: real positioned click on a keybind row (moves the real mouse) */
  const clickRow = async (index) => {
    const box = await page.evaluate((i) => {
      const r = document.querySelectorAll('#set-binds .bind-row')[i].querySelector('button').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, index);
    await page.mouse.click(box.x, box.y);
  };

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  for (let i = 0; i < 60 && !logs.some((l) => l.includes('[liminal] up')); i++) await sleep(200);

  // open menu
  const opened = await page.evaluate(() => {
    const g = window.__liminal;
    if (!g?.settings) return false;
    g.settings.open();
    return g.settings.isOpen;
  });
  check('menu opens', opened);

  // structure
  const counts = await page.evaluate(() => ({
    binds: document.querySelectorAll('#set-binds .bind-row').length,
    preset: !!document.getElementById('set-preset'),
    scale: !!document.getElementById('set-scale'),
    rtDisabled: document.getElementById('set-rt')?.disabled ?? false,
  }));
  check(`11 keybind rows (got ${counts.binds})`, counts.binds === 11);
  check('preset selector present', counts.preset);
  check('render scale slider present', counts.scale);
  check('RT checkbox disabled on firefox (no webgpu)', counts.rtDisabled === true);

  await page.screenshot({ path: 'screenshots/settings.png' });

  // rebind flow: click "Move forward" button, press J
  await sleep(450); // clear the trailing-click guard from any earlier input
  await clickRow(0);
  await sleep(150);
  await page.keyboard.press('KeyJ');
  await sleep(200);
  const rebound = await page.evaluate(() => ({
    forward: window.__liminal.bindings.get('forward'),
    label: document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button').textContent,
    persisted: JSON.parse(localStorage.getItem('liminal.binds.v1') ?? '{}').forward,
  }));
  check(`rebind forward -> KeyJ (got ${rebound.forward})`, rebound.forward === 'KeyJ');
  check(`button shows J (got ${rebound.label})`, rebound.label === 'J');
  check('bind persisted', rebound.persisted === 'KeyJ');

  // slider: render scale -> override applied + persisted
  await page.evaluate(() => {
    const s = document.getElementById('set-scale');
    s.value = '0.6';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  const override = await page.evaluate(() => ({
    scale: window.__liminal.quality.settings.renderScale,
    presetShowsCustom: document.getElementById('set-preset').value,
    persisted: JSON.parse(localStorage.getItem('liminal.settings.v1') ?? '{}').renderScale,
  }));
  check(`renderScale override 0.6 (got ${override.scale})`, override.scale === 0.6);
  check(`preset shows "custom" (got ${override.presetShowsCustom})`, override.presetShowsCustom === '__custom');
  check('override persisted', override.persisted === 0.6);

  // picking a preset clears overrides
  await page.evaluate(() => {
    const p = document.getElementById('set-preset');
    p.value = 'high';
    p.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(150);
  const presetPick = await page.evaluate(() => ({
    tier: window.__liminal.quality.tier,
    scale: window.__liminal.quality.settings.renderScale,
  }));
  check(`preset high applied (got ${presetPick.tier})`, presetPick.tier === 'high');
  check(`preset cleared override (scale back to ${presetPick.scale})`, presetPick.scale === 1);

  // sensitivity applies live
  await page.evaluate(() => {
    const s = document.getElementById('set-sens');
    s.value = '0.5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const sens = await page.evaluate(() => window.__liminal.controller.sensitivityMultiplier);
  check(`sensitivity applied (got ${sens})`, sens === 0.5);

  // Esc during capture = unbind (bind to nothing)
  await sleep(450);
  await clickRow(0);
  await sleep(150);
  await page.keyboard.press('Escape');
  await sleep(150);
  const unbound = await page.evaluate(() => ({
    bind: window.__liminal.bindings.get('forward'),
    label: document.querySelectorAll('#set-binds .bind-row')[0].querySelector('button').textContent,
  }));
  check(`Esc unbinds forward (got "${unbound.bind}")`, unbound.bind === '');
  check(`label shows none (got "${unbound.label}")`, String(unbound.label).includes('none'));

  // mouse buttons are bindable
  await sleep(450);
  await clickRow(1); // real click also parks the mouse on the button
  await sleep(150);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await sleep(200);
  const mouseBind = await page.evaluate(() => ({
    bind: window.__liminal.bindings.get('back'),
    label: document.querySelectorAll('#set-binds .bind-row')[1].querySelector('button').textContent,
  }));
  check(`right mouse binds (got ${mouseBind.bind})`, mouseBind.bind === 'Mouse2');
  check(`label shows Right Mouse (got ${mouseBind.label})`, mouseBind.label === 'Right Mouse');

  // modified-from-preset badge: a slider deviating from the preset marks its row
  await page.evaluate(() => {
    const s = document.getElementById('set-scale');
    s.value = '0.6';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  const badgeOn = await page.evaluate(() => {
    const badge = document.getElementById('set-scale')?.closest('.row')?.querySelector('.mod');
    return {
      exists: !!badge,
      visible: badge ? !badge.hidden : false,
      visibleCount: [...document.querySelectorAll('#settings .row .mod')].filter((b) => !b.hidden).length,
    };
  });
  check('badge appears when slider deviates from preset', badgeOn.exists && badgeOn.visible);
  check(`only the touched row is marked (got ${badgeOn.visibleCount})`, badgeOn.visibleCount === 1);
  await page.screenshot({ path: 'screenshots/settings-badge.png' });

  // re-selecting the SAME preset must still reset (setTier early-returns on an
  // unchanged tier — settings.ts clears leftover overrides itself)
  await page.evaluate(() => {
    const p = document.getElementById('set-preset');
    p.value = 'high';
    p.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(150);
  const badgeOff = await page.evaluate(() => {
    const badge = document.getElementById('set-scale')?.closest('.row')?.querySelector('.mod');
    return { hidden: badge?.hidden, scale: window.__liminal.quality.settings.renderScale };
  });
  check(`preset re-select restores scale (got ${badgeOff.scale})`, badgeOff.scale === 1);
  check('badge clears on preset re-select', badgeOff.hidden === true);

  // keybind conflict: Jump -> A, which "Move left" already owns — must warn
  // (non-blocking, naming the other action) and swap, never double-bind
  await sleep(450); // clear the trailing-click guard from the mouse-bind above
  await clickRow(4); // Jump
  await sleep(150);
  await page.keyboard.press('KeyA');
  await sleep(200);
  const conflict = await page.evaluate(() => ({
    warn: document.querySelector('#settings .note.warn')?.textContent ?? '',
    warnHidden: document.querySelector('#settings .note.warn')?.hidden ?? true,
    jump: window.__liminal.bindings.get('jump'),
    left: window.__liminal.bindings.get('left'),
    open: window.__liminal.settings.isOpen,
  }));
  check(`conflict warning names the other action (got "${conflict.warn}")`,
    !conflict.warnHidden && conflict.warn.includes('Move left'));
  check(`conflict is non-blocking, menu stays open (got ${conflict.open})`, conflict.open === true);
  check(`conflicting key lands on the new action (got ${conflict.jump})`, conflict.jump === 'KeyA');
  check(`previous holder keeps a key via swap (left got ${conflict.left})`, conflict.left === 'Space');
  await page.screenshot({ path: 'screenshots/settings-conflict.png' });

  // exposure: applies live, persists, and is marked custom
  await page.evaluate(() => {
    const s = document.getElementById('set-exp');
    s.value = '2';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  const exp = await page.evaluate(() => {
    const badge = document.querySelector('#set-exp')?.closest('.row')?.querySelector('.mod');
    return {
      live: window.__liminal.renderer.toneMappingExposure,
      saved: JSON.parse(localStorage.getItem('liminal.settings.v1') ?? '{}').exposure,
      badgeShown: badge ? !badge.hidden : false,
      badgeExists: !!badge,
    };
  });
  check(`exposure applies live (got ${exp.live})`, exp.live === 2);
  check(`exposure persisted (got ${exp.saved})`, exp.saved === 2);
  check('exposure row marked custom', exp.badgeExists && exp.badgeShown);

  // reload: main.ts must restore exposure from storage
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  for (let i = 0; i < 60 && !(await page.evaluate(() => window.__liminalReady === true)); i++) {
    await sleep(200);
  }
  const restored = await page.evaluate(() => window.__liminal.renderer.toneMappingExposure);
  check(`exposure restored after reload (got ${restored})`, restored === 2);

  // reopened menu still marks the restored value; preset re-select resets it
  const reopened = await page.evaluate(() => {
    window.__liminal.settings.open();
    const badge = document.querySelector('#set-exp')?.closest('.row')?.querySelector('.mod');
    return badge ? !badge.hidden : false;
  });
  check('restored exposure keeps its badge', reopened === true);

  await page.evaluate(() => {
    const p = document.getElementById('set-preset');
    p.value = 'high'; // same tier as persisted — the stale-override path
    p.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(150);
  const expReset = await page.evaluate(() => {
    const badge = document.querySelector('#set-exp')?.closest('.row')?.querySelector('.mod');
    return {
      exposure: window.__liminal.renderer.toneMappingExposure,
      badgeShown: badge ? !badge.hidden : false,
      badgeExists: !!badge,
    };
  });
  check(`preset re-select restores neutral exposure (got ${expReset.exposure})`, expReset.exposure === 1);
  check('exposure badge cleared on preset re-select', expReset.badgeExists && !expReset.badgeShown);

  // close
  const closed = await page.evaluate(() => {
    window.__liminal.settings.close();
    return !window.__liminal.settings.isOpen;
  });
  check('menu closes', closed);

  const errors = logs.filter((l) => l.startsWith('PAGEERROR'));
  if (errors.length) console.log('errors:\n' + errors.join('\n'));

  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
