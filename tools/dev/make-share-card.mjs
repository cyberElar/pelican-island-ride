/**
 * Renders screenshots/og-cover.jpg (1200x630) for link previews
 * (og:image / twitter:image), composed from the game's own screenshots.
 *
 * Usage: node tools/dev/make-share-card.mjs [--art screenshots/ride.jpg]
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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

const artRel = arg('art', 'screenshots/ride.jpg').replace(/\\/g, '/');
const artPath = path.resolve(root, artRel);
if (!existsSync(artPath)) {
  console.error(`art not found: ${artPath}`);
  process.exit(2);
}

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.error('No Edge/Chrome found.');
  process.exit(2);
}

const scratch = path.join(root, '.scratch');
await mkdir(scratch, { recursive: true });
const htmlPath = path.join(scratch, 'og-card.html');

const artHref = path.relative(scratch, artPath).replace(/\\/g, '/');
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #0b1020; }
  .frame { position: relative; width: 1200px; height: 630px; }
  .art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .shade { position: absolute; inset: 0;
    background:
      linear-gradient(90deg, rgba(6,10,20,0.94) 0%, rgba(6,10,20,0.62) 40%, rgba(6,10,20,0.06) 74%),
      linear-gradient(0deg, rgba(6,10,20,0.72), rgba(6,10,20,0) 46%); }
  .copy { position: absolute; left: 76px; top: 104px; color: #f2e8d5;
    font-family: "Source Han Serif SC", "Noto Serif SC", "Songti SC", STSong, "SimSun", serif; }
  h1 { margin: 0; font-size: 76px; letter-spacing: 0.16em; font-weight: 600; }
  .sub { margin-top: 16px; font-size: 19px; letter-spacing: 0.52em; text-transform: uppercase;
    opacity: 0.74; font-family: Consolas, "Courier New", monospace; }
  .line { margin-top: 28px; width: 128px; height: 2px;
    background: linear-gradient(90deg, #e8b64c, rgba(242,232,213,0.9)); }
  ul { margin: 32px 0 0; padding: 0; list-style: none; font-size: 20px; line-height: 1.9;
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif; opacity: 0.94; }
  .tag { position: absolute; left: 76px; bottom: 54px; font-size: 15px; letter-spacing: 0.32em;
    color: #f2e8d5; opacity: 0.58; font-family: Consolas, "Courier New", monospace; }
</style></head>
<body><div class="frame">
  <img class="art" src="${artHref}" alt="">
  <div class="shade"></div>
  <div class="copy">
    <h1>提鹅鹏 · 单车环岛</h1>
    <div class="sub">A Pelican&rsquo;s Island Ride</div>
    <div class="line"></div>
    <ul>
      <li>6 km × 6 km 程序化小岛 · 11 km 环岛公路</li>
      <li>three.js 实时昼夜、天气、海面与电影级后期</li>
      <li>键盘 / 手柄 / 触屏 · 打开即玩，无需联网</li>
    </ul>
  </div>
  <div class="tag">THREE.JS · PROCEDURAL · SINGLE FILE</div>
</div></body></html>`;

await writeFile(htmlPath, html, 'utf8');

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--allow-file-access-from-files', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await page.waitForFunction(() => {
  const img = document.querySelector('img.art');
  return img && img.complete && img.naturalWidth > 0;
}, null, { timeout: 20000 });

const out = path.join(root, 'screenshots', 'og-cover.jpg');
await page.screenshot({ path: out, type: 'jpeg', quality: 84 });
await browser.close();

const { statSync } = await import('node:fs');
console.log(`wrote ${path.relative(root, out)} (${Math.round(statSync(out).size / 1024)} KB, art: ${artRel})`);
