// Probe WebGPU on localhost (secure context) with a few angle/backend flags.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { globSync } from 'node:fs';

const CHROME = globSync(`${process.env.HOME}/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/**/MacOS/Google Chrome for Testing`).at(-1);

const html = `<!doctype html><meta charset=utf-8><title>gpu probe</title><body>probe</body>`;
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
await new Promise((r) => server.listen(8099, r));

const runs = [
  ['plain', []],
  ['unsafe-webgpu', ['--enable-unsafe-webgpu']],
  ['unsafe-webgpu + angle metal', ['--enable-unsafe-webgpu', '--use-angle=metal']],
  ['unsafe-webgpu + swiftshader', ['--enable-unsafe-webgpu', '--enable-features=UseSwiftShader', '--disable-gpu']],
];

for (const [label, args] of runs) {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });
    const page = await browser.newPage();
    await page.goto(`http://localhost:8099`, { waitUntil: 'domcontentloaded' });
    const res = await page.evaluate(async () => {
      const out = { url: location.href, secure: window.isSecureContext, hasGpu: !!navigator.gpu };
      if (navigator.gpu) {
        const a = await navigator.gpu.requestAdapter();
        out.adapter = !!a;
        if (a) {
          out.backend = a.info ? JSON.stringify(a.info) : null;
          const d = await a.requestDevice();
          out.device = !!d;
          if (d) {
            const m = d.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' });
            out.parsed = true;
            const p = d.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
            out.pipeline = !!p;
          }
        }
      }
      return out;
    });
    console.log(label, JSON.stringify(res));
  } catch (e) {
    console.log(label, 'ERROR', String(e).slice(0, 200));
  } finally {
    if (browser) await browser.close();
  }
}
server.close();
