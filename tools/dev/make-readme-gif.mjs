/**
 * make-readme-gif.mjs - records the README's short loop.
 *
 * Rides through the start gate at golden hour and captures ~10 frames per
 * second with the compositor, so post-processing, tone mapping and the HUD are
 * all in the loop; writes screenshots/ride.gif.
 *
 * Needs the dev-only encoder packages (not saved to package.json):
 *   npm i --no-save gifenc pngjs
 *
 * Usage: node tools/dev/make-readme-gif.mjs [--seconds 5] [--fps 10] [--width 560]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// both are CommonJS packages, so destructure off the default export
import gifenc from 'gifenc';
import pngjs from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const { PNG } = pngjs;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const seconds = Number(arg('seconds', '5'));
const fps = Number(arg('fps', '10'));
const outWidth = Number(arg('width', '560'));
const colors = Number(arg('colors', '128'));
const quality = arg('quality', 'high');
const seed = arg('seed', '20261014');
const out = path.join(root, 'screenshots', 'ride.gif');

// capture at 2x the GIF width so the box downscale keeps some detail
const capWidth = outWidth * 2;
const capHeight = Math.round((capWidth * 9) / 16);

const EDGE = [
  process.env.PELICAN_BROWSER,
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => existsSync(p));
if (!EDGE) {
  console.error('No Edge/Chrome found.');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: capWidth, height: capHeight }, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));

await page.goto(`${pathToFileURL(path.join(root, 'index.html')).href}?quality=${quality}&seed=${seed}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });

// Exactly what a first-time player sees: the game stages the rider on the road
// a few metres before the start gate, so the loop opens on the arch.
await page.evaluate(() => {
  const P = window.__pelican;
  P.start('ride');
  P.setHour(17.05);
});
await page.waitForTimeout(1500);

const frames = Math.round(seconds * fps);
const delay = Math.round(1000 / fps);
const shots = [];
await page.keyboard.down('w');
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  shots.push(await page.screenshot({ type: 'png' }));
  const next = t0 + ((i + 1) * 1000) / fps;
  const wait = next - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
}
await page.keyboard.up('w');
await browser.close();
console.log(`captured ${shots.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// box-downscale 2x and drop the alpha channel (the HUD is opaque)
const w = outWidth;
const h = Math.round((w * 9) / 16);
const rgbaFrames = shots.map((buf) => {
  const png = PNG.sync.read(buf);
  const s = png.width / w;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const px = ((y * s + dy) * png.width + (x * s + dx)) * 4;
          r += png.data[px]; g += png.data[px + 1]; b += png.data[px + 2];
        }
      }
      const n = s * s;
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
});

// one global palette keeps the file small; the scene is a single continuous
// shot so 256 colours are plenty
const palette = quantize(rgbaFrames[Math.floor(rgbaFrames.length / 2)], colors);
const gif = GIFEncoder();
for (const frame of rgbaFrames) {
  gif.writeFrame(applyPalette(frame, palette), w, h, { palette, delay, repeat: 0 });
}
gif.finish();
const bytes = gif.bytes();
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, bytes);
console.log(`wrote ${path.relative(root, out)}  ${w}x${h}  ${frames} frames @ ${fps} fps  ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
if (problems.length) {
  console.error('page errors:', problems.slice(0, 3));
  process.exit(1);
}
