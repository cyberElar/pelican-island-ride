/**
 * _probe-longtasks.mjs - where does the boot time actually go?
 *
 * Loads the built game, records every PerformanceObserver long task, then
 * prints the boot stage table plus the longest blocking chunks, so the build
 * can be sliced where it matters.
 *
 * Usage: node tools/dev/_probe-longtasks.mjs [--quality high] [--root]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const quality = arg('quality', 'high');
const useRoot = process.argv.includes('--root') || !existsSync(path.join(root, 'dist', 'index.html'));
const entry = useRoot ? path.join(root, 'index.html') : path.join(root, 'dist', 'index.html');

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
const logs = [];
page.on('console', (m) => {
  const text = m.text();
  if (text.startsWith('[pelican]')) logs.push(text);
});
await page.addInitScript(() => {
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* longtask not supported */ }
});

const t0 = Date.now();
await page.goto(`${pathToFileURL(entry).href}?quality=${quality}&seed=20261014`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
const bootMs = Date.now() - t0;

const info = await page.evaluate(() => ({
  stages: window.__pelican.bootStages || null,
  tasks: window.__longTasks || [],
}));
const tasks = info.tasks.slice().sort((a, b) => b - a);
const sum = tasks.reduce((a, b) => a + b, 0);
console.log(`world ready in ${(bootMs / 1000).toFixed(1)}s (quality=${quality})`);
console.log(
  `long tasks: ${tasks.length}  max ${tasks[0] ?? 0} ms  sum ${sum} ms  ` +
    `>200ms: ${tasks.filter((d) => d > 200).length}  >1s: ${tasks.filter((d) => d > 1000).length}`
);
console.log('top chunks (ms):', tasks.slice(0, 12).join(', '));
console.log('boot stages:', JSON.stringify(info.stages));
if (logs.length) console.log('build log:\n  ' + logs.join('\n  '));
await browser.close();
