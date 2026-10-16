/**
 * Live check for the first-run tutorial and the ?debug=1 overlay.
 *
 * Drives the real build: the strip must show step 1, advance on real W input,
 * advance again on B, finish on a feather event and remember completion across
 * a reload. Also asserts the debug overlay reports fps/calls.
 *
 * Usage: node tools/dev/_verify-onboarding.mjs
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(e.message));

const url = pathToFileURL(path.join(root, 'dist', 'index.html')).href;
const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else { fails.push(name); console.log(`FAIL ${name} ${extra}`); }
};

// --- pass 1: tutorial + debug overlay ------------------------------------
await page.goto(`${url}?quality=high&debug=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => window.__pelican.start('ride'));
await page.waitForTimeout(600);

const read = () => page.evaluate(() => ({
  on: document.getElementById('pi-tutorial').classList.contains('is-on'),
  step: document.getElementById('pi-tutorial-step').textContent,
  text: document.getElementById('pi-tutorial-text').textContent,
  debug: window.__pelican.debugText(),
}));

let s = await read();
check('tutorial strip visible on a fresh ride', s.on, JSON.stringify(s));
check('step 1 of 3 with throttle goal', s.step === '1/3' && s.text.includes('W'), JSON.stringify(s));
check('debug overlay reports fps + calls', /fps \d+/.test(s.debug) && /calls/.test(s.debug), s.debug);

await page.keyboard.down('w');
await page.waitForTimeout(2600);
await page.keyboard.up('w');
s = await read();
check('step advances after riding', s.step === '2/3' && s.text.includes('B'), JSON.stringify(s));

await page.keyboard.press('b');
await page.waitForTimeout(250);
s = await read();
check('step 3 asks for a feather', s.step === '3/3' && s.text.includes('羽毛'), JSON.stringify(s));

await page.evaluate(() => window.__pelican.ctx.bus.emit('feather:collected', { index: 0, total: 40 }));
await page.waitForTimeout(250);
s = await read();
check('strip hides once the tutorial completes', !s.on, JSON.stringify(s));
const stored = await page.evaluate(() => localStorage.getItem('pelicanIsland.tutorialDone'));
check('completion is stored', stored === '1', String(stored));

// --- pass 2: reload, tutorial must stay hidden ----------------------------
await page.goto(`${url}?quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => window.__pelican.start('ride'));
await page.waitForTimeout(600);
s = await read();
check('tutorial stays hidden on the next visit', !s.on, JSON.stringify(s));

console.log(problems.length ? `console errors: ${problems.length}\n  ${problems.slice(0, 4).join('\n  ')}` : 'console errors: 0');
await browser.close();
if (fails.length || problems.length) process.exit(1);
console.log('onboarding check: OK');
