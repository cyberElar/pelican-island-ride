/**
 * smoke-live.mjs - end-to-end check of a *deployed* build.
 *
 *   node tools/dev/smoke-live.mjs https://cyberelar.github.io/pelican-island-ride/
 *
 * Opens the URL in headless Edge, waits for the world to finish building,
 * rides for a few seconds, screenshots and fails on any console error.
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2];
if (!url) {
  console.error('usage: node tools/dev/smoke-live.mjs <url>');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.resolve(root, '../../work/pelican-smoke');
await mkdir(outDir, { recursive: true });

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
const requests = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => requests.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`));

console.log('[live] opening', url);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
console.log(`[live] world built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const assets = requests.filter((r) => /\.(js|css)$/.test(r));
console.log('[live] assets:', assets.join('  '));

await page.evaluate(() => window.__pelican.start('ride'));
await page.waitForTimeout(3500);
await page.screenshot({ path: path.join(outDir, 'live-pages.png') });

const state = await page.evaluate(() => ({
  mode: window.__pelican.state.camera.mode,
  modules: Object.keys(window.__pelican.modules).length,
  featherTotal: window.__pelican.state.feathers.total,
}));
console.log('[live] state:', JSON.stringify(state));

await browser.close();
if (errors.length) {
  console.error(`[live] ${errors.length} console error(s)`);
  for (const e of errors.slice(0, 8)) console.error('  ! ' + e);
  process.exit(1);
}
console.log('[live] DEPLOYED BUILD OK - no console errors');
