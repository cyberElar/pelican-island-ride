/**
 * make-readme-shots.mjs - captures the README/GitHub screenshots as compact
 * JPEGs straight from the repository root build (which is the same thing
 * GitHub Pages serves, so this doubles as a pages smoke test).
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(root, 'screenshots');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const SHOTS = [
  { id: 'title', label: '标题界面', js: '', settle: 2800 },
  {
    id: 'ride',
    label: '骑行 · 黄金时刻',
    js: "P.start('ride'); P.setHour(16.4);",
    settle: 3400,
  },
  {
    id: 'sunset',
    label: '西崖落日',
    js: `
      P.start('ride'); P.setHour(18.3);
      const b = P.layout.pois.bench.position;
      P.teleport(b.x + 26, b.z + 20, -1.9);
    `,
    settle: 3200,
  },
  {
    id: 'night',
    label: '灯塔之夜',
    js: `
      P.start('ride'); P.setHour(22.3);
      const l = P.layout.pois.lighthouse.position;
      P.teleport(l.x - 42, l.z + 30, 0.6);
    `,
    settle: 3200,
  },
  {
    id: 'village',
    label: '海风村',
    js: `
      P.start('ride'); P.setHour(16.9);
      const v = P.layout.pois.village.position;
      P.teleport(v.x + 30, v.z + 22, -2.1);
    `,
    settle: 3000,
  },
  {
    id: 'photo',
    label: '摄影模式',
    js: `
      P.start('ride'); P.setHour(17.6);
      const b = P.layout.pois.bridge.position;
      P.teleport(b.x - 30, b.z - 26, 0.7);
      setTimeout(() => P.enterPhoto(true), 600);
    `,
    settle: 3400,
  },
];

if (!EDGE) {
  console.error('Edge not found');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// the repository root build == what GitHub Pages serves
await page.goto(pathToFileURL(path.join(root, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
console.log('[shots] world ready (root build)');

for (const shot of SHOTS) {
  if (shot.js) await page.evaluate((code) => new Function('P', code)(window.__pelican), shot.js);
  await page.waitForTimeout(shot.settle);
  const file = path.join(outDir, `${shot.id}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  console.log(`[shots] ${shot.id.padEnd(10)} ${shot.label}`);
}

await browser.close();
if (errors.length) {
  console.error(`[shots] ${errors.length} console error(s)`);
  for (const e of errors.slice(0, 6)) console.error('  ! ' + e);
  process.exit(1);
}
console.log('[shots] done, no console errors');
