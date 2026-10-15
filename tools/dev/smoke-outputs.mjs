/**
 * smoke-outputs.mjs - final acceptance check on the *delivered* package:
 * opens outputs/pelican-island/index.html straight from file://, rides for a
 * few seconds and writes a screenshot. Fails on any console error.
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outputs = path.resolve(root, '../../outputs/pelican-island');
const shots = path.resolve(root, '../../work/pelican-smoke');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

if (!existsSync(path.join(outputs, 'index.html'))) {
  console.error('deliverable not found:', outputs);
  process.exit(2);
}
await mkdir(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = pathToFileURL(path.join(outputs, 'index.html')).href;
console.log('[smoke] opening', url);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
console.log(`[smoke] ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await page.evaluate(() => window.__pelican.start('ride'));
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(shots, 'deliverable.png') });

const stats = await page.evaluate(() => {
  const P = window.__pelican;
  const r = P.engine.renderer;
  return {
    seed: P.seed,
    hour: +P.state.hour.toFixed(2),
    mode: P.state.camera.mode,
    playerY: +P.state.player.position.y.toFixed(1),
    feathers: P.state.feathers.total,
    colliders: P.ctx.colliders.length,
    geometries: r.info.memory.geometries,
    textures: r.info.memory.textures,
    programs: r.info.programs?.length ?? 0,
    modules: Object.keys(P.modules).filter((k) => P.modules[k]).join(','),
  };
});
console.log('[smoke] state:', JSON.stringify(stats));

await browser.close();
if (errors.length) {
  console.error(`[smoke] ${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ! ' + e);
  process.exit(1);
}
console.log('[smoke] DELIVERABLE OK - no console errors');
