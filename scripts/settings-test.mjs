/**
 * Settings menu e2e: open via handle, verify rows, rebind a key through the
 * capture flow, move a slider, confirm persistence — then screenshot.
 *
 *   node scripts/settings-test.mjs   (needs preview on 4173)
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
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#set-binds .bind-row');
    rows[0].querySelector('button').click();
  });
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
