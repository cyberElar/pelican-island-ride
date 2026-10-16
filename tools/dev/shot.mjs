/**
 * shot.mjs - the quick, trustworthy visual check.
 *
 * Opens the built game in headless Edge and takes a normal compositor
 * screenshot, so what you get is exactly what a player sees (post-processing,
 * tone mapping, HUD and all).
 *
 * Usage:
 *   node tools/dev/shot.mjs --out .scratch/a.png
 *   node tools/dev/shot.mjs --poi village --hour 16.9 --quality high --out .scratch/v.png
 *   node tools/dev/shot.mjs --player 120,-40,-2.1 --cam chase --no-ui --out .scratch/p.png
 *   node tools/dev/shot.mjs --fps --out .scratch/fps.png
 *
 * Flags:
 *   --poi <name>        teleport to a named POI (see layout.pois)
 *   --player x,z,yaw    teleport to an explicit spot
 *   --hour <0-24>       time of day
 *   --quality <tier>    low | medium | high | ultra (default: high)
 *   --seed <n>          island seed
 *   --cam <mode>        chase | free | cinematic | photo
 *   --size WxH          viewport (default 1600x900)
 *   --scale <n>         device pixel ratio (default 1)
 *   --touch             emulate a touch device (shows the virtual pad)
 *   --debug             append ?debug=1 (fps / draw-call overlay)
 *   --settle <ms>       wait after moving (default 2500)
 *   --no-ui             hide the HUD for a clean art reference
 *   --fps               sample 180 frames and report frame times
 *   --info              print the POI list with positions, then exit
 *   --eval <js>         run extra JS in the page with `P` bound to window.__pelican
 *   --root              use the repository-root build instead of dist/
 *   --out <file>        where to write the PNG
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const out = path.resolve(root, arg('out', '.scratch/shot.png'));
const quality = arg('quality', 'high');
const seed = arg('seed', '20261014');
const hour = Number(arg('hour', '17.1'));
const poi = arg('poi', '');
const playerArg = arg('player', '');
const cam = arg('cam', '');
const size = arg('size', '1600x900').split('x').map(Number);
const scale = Number(arg('scale', '1'));
const settle = Number(arg('settle', '2500'));
const useRoot = flag('root') || !existsSync(path.join(root, 'dist', 'index.html'));
const entry = useRoot ? path.join(root, 'index.html') : path.join(root, 'dist', 'index.html');
const evalCode = arg('eval', '');

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
const page = await browser.newPage({
  viewport: { width: size[0], height: size[1] },
  deviceScaleFactor: scale,
  hasTouch: flag('touch'),
});

const problems = [];
page.on('console', (m) => {
  const text = m.text();
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${text}`);
  else if (text.startsWith('[pelican]')) console.log(`  ${text}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const url = `${pathToFileURL(entry).href}?quality=${quality}&seed=${seed}${flag('debug') ? '&debug=1' : ''}`;
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
const bootMs = Date.now() - t0;
console.log(`world ready in ${(bootMs / 1000).toFixed(1)}s  (${useRoot ? 'root build' : 'dist build'}, quality=${quality}, seed=${seed})`);

if (flag('info')) {
  const info = await page.evaluate(() => {
    const P = window.__pelican;
    const out = {};
    for (const [id, poi] of Object.entries(P.layout.pois)) {
      const p = poi.position || poi;
      const h = typeof P.layout.heightAt === 'function' ? P.layout.heightAt(p.x, p.z) : null;
      out[id] = [Math.round(p.x), Math.round(p.z), Math.round(h ?? p.y ?? 0)];
    }
    return { pois: out, coastline: P.layout.coastRadius ? 'coastRadius(angle)' : null };
  });
  for (const [id, v] of Object.entries(info.pois)) console.log(`  ${id.padEnd(14)} x=${String(v[0]).padStart(6)} z=${String(v[1]).padStart(6)} groundY=${v[2]}`);
  await browser.close();
  process.exit(0);
}

if (evalCode) {
  await page.evaluate((code) => {
    const P = window.__pelican;
    // eslint-disable-next-line no-new-func
    new Function('P', code)(P);
  }, evalCode);
}

await page.evaluate(
  ({ poi, playerArg, hour, cam }) => {
    const P = window.__pelican;
    P.start('ride');
    if (Number.isFinite(hour)) P.setHour(hour);
    if (poi) {
      const target = P.layout.pois[poi];
      if (!target) throw new Error(`unknown poi '${poi}' (have: ${Object.keys(P.layout.pois).join(', ')})`);
      P.teleport(target.position.x, target.position.z, -2.0);
    }
    if (playerArg) {
      const [x, z, yaw] = playerArg.split(',').map(Number);
      P.teleport(x, z, Number.isFinite(yaw) ? yaw : 0);
    }
    if (cam === 'photo') setTimeout(() => P.enterPhoto(true), 500);
    else if (cam) setTimeout(() => P.setCameraMode(cam), 400);
  },
  { poi, playerArg, hour, cam }
);

if (flag('no-ui')) {
  await page.evaluate(() => {
    const ui = document.getElementById('ui-root');
    if (ui) ui.style.display = 'none';
  });
}

await page.waitForTimeout(settle);

if (flag('fps')) {
  const stats = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        const tick = (now) => {
          samples.push(now - last);
          last = now;
          if (samples.length < 180) requestAnimationFrame(tick);
          else {
            samples.sort((a, b) => a - b);
            const at = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
            const info = window.__pelican.engine.renderer.info;
            resolve({
              median: at(0.5),
              p95: at(0.95),
              worst: samples[samples.length - 1],
              calls: info.render.calls,
              triangles: info.render.triangles,
              programs: info.programs ? info.programs.length : null,
              geometries: info.memory.geometries,
              textures: info.memory.textures,
              pixels: window.__pelican.engine.renderer.domElement.width * window.__pelican.engine.renderer.domElement.height,
              dpr: window.devicePixelRatio,
            });
          }
        };
        requestAnimationFrame(tick);
      })
  );
  console.log(
    `frame  median ${stats.median.toFixed(1)}ms  p95 ${stats.p95.toFixed(1)}ms  worst ${stats.worst.toFixed(1)}ms  ` +
      `(${(1000 / stats.median).toFixed(0)} fps median)`
  );
  console.log(
    `render ${stats.calls} calls  ${(stats.triangles / 1e6).toFixed(2)}M tris  ${stats.programs} programs  ` +
      `${stats.geometries} geometries  ${stats.textures} textures  ${stats.pixels} px`
  );
}

await mkdir(path.dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log(`wrote ${path.relative(root, out)}`);

await browser.close();

if (problems.length) {
  console.error(`${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 10)) console.error('  ! ' + p);
  process.exit(1);
}
