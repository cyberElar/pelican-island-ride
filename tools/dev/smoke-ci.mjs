/**
 * smoke-ci.mjs - browser-level smoke test for CI.
 *
 * Boots the published build from file:// in a real browser, drives one short
 * ride with real keyboard input, opens and closes the pause menu, and fails on
 * any console error, page error, network request or missing HUD update. The
 * module suites cover the maths; this one covers "the page still runs".
 *
 * Usage:
 *   node tools/dev/smoke-ci.mjs                 # dist/ build
 *   node tools/dev/smoke-ci.mjs --root          # the committed root bundle
 *   node tools/dev/smoke-ci.mjs --quality high
 *
 * Browser: $PELICAN_BROWSER, else $CHROME_PATH, else the usual Windows
 * Edge/Chrome paths, else Playwright's own chromium (CI installs it with
 * `npx playwright@1.64.0 install --with-deps chromium`).
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
const quality = arg('quality', 'low');
const seed = arg('seed', '20261014');
const useRoot = process.argv.includes('--root') || !existsSync(path.join(root, 'dist', 'index.html'));
const entry = useRoot ? path.join(root, 'index.html') : path.join(root, 'dist', 'index.html');

const SYSTEM_BROWSER = [
  process.env.PELICAN_BROWSER,
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));

// Software GL on the CI runners, the real GPU locally on Windows.
const glFlags = process.platform === 'win32'
  ? ['--use-angle=d3d11', '--enable-unsafe-swiftshader']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const launchOpts = {
  headless: true,
  args: [...glFlags, '--mute-audio', '--allow-file-access-from-files'],
};
if (SYSTEM_BROWSER) launchOpts.executablePath = SYSTEM_BROWSER;

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

// The ANGLE/D3D11 shader compiler emits this double-precision notice for the
// terrain shader on every run; it is not actionable and does not appear on the
// software-GL CI runners.
const IGNORED_WARNINGS = [/cannot be represented accurately in double precision/];
const consoleProblems = [];
const pageErrors = [];
const foreignRequests = [];
page.on('console', (m) => {
  const type = m.type();
  const text = m.text();
  if (type === 'error') consoleProblems.push(`error: ${text}`);
  else if (type === 'warning' && !IGNORED_WARNINGS.some((re) => re.test(text))) consoleProblems.push(`warning: ${text}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
page.on('request', (r) => {
  const url = r.url();
  if (!url.startsWith('file://') && !url.startsWith('data:') && !url.startsWith('blob:')) foreignRequests.push(url);
});

const t0 = Date.now();
await page.goto(`${pathToFileURL(entry).href}?quality=${quality}&seed=${seed}&debug=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
const bootMs = Date.now() - t0;
check('world builds and reaches ready', true, `${(bootMs / 1000).toFixed(1)}s (quality=${quality}, ${useRoot ? 'root' : 'dist'})`);

const boot = await page.evaluate(() => {
  const P = window.__pelican;
  return {
    moduleErrors: P.moduleErrors || [],
    stages: (P.bootStages || []).map((s) => s.name),
    webgl2: !!P.engine.renderer.getContext(),
  };
});
check('no module failed to build', boot.moduleErrors.length === 0, JSON.stringify(boot.moduleErrors));
check('all boot stages reported', boot.stages.includes('vegetation') && boot.stages.includes('ready'), boot.stages.join(','));
check('WebGL2 context is live', boot.webgl2);

await page.evaluate(() => window.__pelican.start('ride'));
await page.waitForTimeout(400);
// The overlay refreshes four times a second off the frame loop; poll instead
// of assuming it has painted by now.
await page
  .waitForFunction(() => /fps \d+/.test(window.__pelican.debugText() || ''), null, { timeout: 8000 })
  .catch(() => {});

const hudOnStart = await page.evaluate(() => ({
  tutorial: document.getElementById('pi-tutorial')?.classList.contains('is-on'),
  clock: document.getElementById('pi-clock-value')?.textContent,
  debug: window.__pelican.debugText(),
}));
check('first-run tutorial strip is shown', hudOnStart.tutorial === true);
check('debug overlay reports fps and calls', /fps \d+/.test(hudOnStart.debug) && /calls/.test(hudOnStart.debug), hudOnStart.debug.split('\n')[0]);

// --- real input: pedal for a moment -----------------------------------------
await page.keyboard.down('w');
await page.waitForTimeout(2500);
await page.keyboard.up('w');
const ride = await page.evaluate(() => ({
  speed: window.__pelican.state.player.speed,
  hudSpeed: document.getElementById('pi-speedo-value')?.textContent || '',
  tutorialStep: document.getElementById('pi-tutorial-step')?.textContent || '',
}));
check('pedalling moves the bike', Math.abs(ride.speed) > 2, `speed ${ride.speed.toFixed(1)} m/s`);
check('HUD speedometer follows', ride.hudSpeed.replace(/[^0-9]/g, '') !== '0' && ride.hudSpeed !== '', `"${ride.hudSpeed}"`);
check('tutorial advances after riding', ride.tutorialStep !== '1/3', `step ${ride.tutorialStep}`);

// --- pause menu round trip ---------------------------------------------------
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
const paused = await page.evaluate(() => ({
  paused: window.__pelican.state.paused,
  badge: document.querySelector('[data-testid="paused"]')?.classList.contains('is-on'),
}));
check('Escape pauses the game', paused.paused === true && paused.badge === true, JSON.stringify(paused));
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
const resumed = await page.evaluate(() => window.__pelican.state.paused);
check('Escape resumes the game', resumed === false);

// --- world content sanity ----------------------------------------------------
const world = await page.evaluate(() => {
  const P = window.__pelican;
  const veg = P.modules.vegetation?.stats || {};
  const lm = P.modules.landmarks?.stats || {};
  let meshes = 0;
  P.engine.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes++; });
  return { trees: veg.trees, grass: veg.grass, landmarks: lm.count, meshes, discoverable: P.state.discoverableTotal };
});
check('world content is populated', world.trees > 100 && world.grass > 1000 && world.meshes > 100,
  `trees ${world.trees}, grass ${world.grass}, meshes ${world.meshes}`);
check('discovery list matches the HUD contract', world.discoverable === 25, String(world.discoverable));

// --- no network, no console noise -------------------------------------------
check('no console errors or warnings', consoleProblems.length === 0, consoleProblems.slice(0, 3).join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('file:// contract: no external requests', foreignRequests.length === 0, foreignRequests.slice(0, 3).join(' | '));

await browser.close();
if (fails.length) {
  console.error(`\nsmoke: ${fails.length} check(s) failed`);
  process.exit(1);
}
console.log('\nsmoke: OK');
