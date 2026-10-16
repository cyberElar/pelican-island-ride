/**
 * audit-env.mjs - what GPU/timer the headless run actually gets. Every frame
 * number in the audit report is only meaningful next to this.
 *
 * Usage: node tools/dev/audit-env.mjs [--quality high] [--browser edge|chrome]
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const quality = arg('quality', 'high');
const browserName = arg('browser', 'edge');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const exe = browserName === 'chrome' ? CHROME : EDGE;
if (!exe) { console.error('no browser'); process.exit(2); }

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--use-angle=d3d11',
    '--enable-unsafe-swiftshader',
    '--mute-audio',
    '--allow-file-access-from-files',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${pathToFileURL(path.join(dist, 'index.html')).href}?quality=${quality}&seed=20261014`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });

const info = await page.evaluate(() => {
  const P = window.__pelican;
  const renderer = P.engine.renderer;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') || gl.getExtension('EXT_disjoint_timer_query');
  const renderInfo = {
    glVersion: gl.getParameter(gl.VERSION),
    glRenderer: gl.getParameter(gl.RENDERER),
    glVendor: gl.getParameter(gl.VENDOR),
    unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    timerQuery: !!timer,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    rendererInfo: {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    },
    preset: { renderScale: P.engine.preset.renderScale, pixelRatioCap: P.engine.preset.pixelRatioCap, shadows: P.engine.preset.shadows },
    ua: navigator.userAgent,
  };
  return renderInfo;
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
