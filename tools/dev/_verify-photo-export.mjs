/**
 * Live check for photo mode: cycles the grade filters, captures the overlay,
 * and asserts that the PNG export really downloads a valid image.
 *
 * Usage: node tools/dev/_verify-photo-export.mjs
 */
import { chromium } from 'playwright-core';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const scratch = path.join(root, '.scratch');
await mkdir(scratch, { recursive: true });

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.error('No Edge/Chrome found.');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const entry = path.join(root, 'dist', 'index.html');
await page.goto(pathToFileURL(entry).href + '?quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
console.log('world ready');

await page.evaluate(() => {
  const P = window.__pelican;
  P.start('ride');
  P.setHour(17.4);
  const b = P.layout.pois.bridge.position;
  P.teleport(b.x - 30, b.z - 26, 0.7);
  P.enterPhoto(true);
});
await page.waitForTimeout(2600);

const readFilter = () => page.evaluate(() => document.getElementById('pi-photo-filter').textContent);
const filters = [await readFilter()];
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.__pelican.cycleFilter(1));
  await page.waitForTimeout(120);
  filters.push(await readFilter());
}
console.log('filters:', filters.join(' | '));

const shot = path.join(scratch, 'photo-filter-mono.png');
await page.screenshot({ path: shot });

const chips = await page.evaluate(() => ({
  cycle: !!document.querySelector('[data-testid="photo-filter-cycle"]'),
  save: !!document.querySelector('[data-testid="photo-save"]'),
  hint: document.getElementById('pi-photo-hint').textContent,
}));
console.log('chips:', JSON.stringify(chips));

const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
await page.evaluate(() => window.__pelican.savePhoto());
const download = await downloadPromise;
const out = path.join(scratch, 'photo-export-check.png');
await download.saveAs(out);
await page.waitForTimeout(400);

const toast = await page.evaluate(() => {
  const el = document.getElementById('pi-toasts');
  return el ? el.textContent : '';
});
const size = statSync(out).size;
console.log(`download: ${download.suggestedFilename()} -> ${Math.round(size / 1024)} KB`);
console.log(`toast: ${toast}`);
console.log(problems.length ? `console errors: ${problems.length}\n  ${problems.slice(0, 4).join('\n  ')}` : 'console errors: 0');
await browser.close();

if (!(size > 100 * 1024)) {
  console.error('export too small - PNG likely blank');
  process.exit(1);
}
if (problems.length) process.exit(1);
console.log('photo export check: OK');
