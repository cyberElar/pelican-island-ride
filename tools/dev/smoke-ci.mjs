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
 *   node tools/dev/smoke-ci.mjs --mobile        # emulated phone + touch pad
 *   node tools/dev/smoke-ci.mjs --throttle 20   # CPU-throttled (slow renderer)
 *
 * Browser: --browser chromium (default), firefox or webkit. For chromium,
 * $PELICAN_BROWSER, else $CHROME_PATH, else the usual Windows Edge/Chrome
 * paths, else Playwright's own chromium (CI installs it with
 * `npx playwright@1.64.0 install --with-deps chromium`).
 *
 * `--mobile` and `--throttle` use Chromium-only emulation/CDP. The desktop
 * checks are shared by all three browsers.
 */
import { chromium, firefox, webkit } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';
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
const mobile = process.argv.includes('--mobile');
const throttle = Number(arg('throttle', '1'));
const browserName = arg('browser', 'chromium');
const browserTypes = { chromium, firefox, webkit };
const browserType = browserTypes[browserName];
if (!browserType) {
  console.error(`smoke: unknown --browser "${browserName}" (use chromium, firefox or webkit)`);
  process.exit(2);
}
const isChromium = browserName === 'chromium';
if (mobile && !isChromium) {
  console.error('smoke: --mobile uses Chromium emulation and cannot run on ' + browserName);
  process.exit(2);
}
const useRoot = process.argv.includes('--root') || !existsSync(path.join(root, 'dist', 'index.html'));
const entry = useRoot ? path.join(root, 'index.html') : path.join(root, 'dist', 'index.html');
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

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

const launchOpts = isChromium
  ? {
    headless: true,
    args: [
      ...glFlags, '--mute-audio', '--allow-file-access-from-files',
      // containers give /dev/shm 64 MB, which chromium does not like
      ...(process.platform === 'win32' ? [] : ['--disable-dev-shm-usage']),
    ],
    ...(SYSTEM_BROWSER ? { executablePath: SYSTEM_BROWSER } : {}),
  }
  : { headless: true };

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const browser = await browserType.launch(launchOpts);
console.log(`browser: ${browser.version()} (${isChromium ? SYSTEM_BROWSER || 'playwright chromium' : browserName})${mobile ? ' · emulated phone' : ''}`);
const page = await browser.newPage(
  mobile
    ? {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    }
    : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }
);

// The software-GL CI runner renders this scene at ~1 fps, so every interaction
// below polls the game state instead of waiting on the clock. The throttle
// flag reproduces that slowness locally.
if (throttle > 1 && isChromium) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  console.log(`cpu throttled ${throttle}x (slow-renderer simulation)`);
} else if (throttle > 1) {
  console.log(`cpu throttle ignored on ${browserName} (CDP is Chromium-only)`);
}

// The ANGLE/D3D11 shader compiler emits this double-precision notice for the
// terrain shader on every run; it is not actionable and does not appear on the
// software-GL CI runners.
// Firefox also blocks local font access at file:// visibility level 3; the
// font stack falls back cleanly and the notice is browser-internal.
const IGNORED_WARNINGS = [
  /cannot be represented accurately in double precision/,
  /Request for font .* blocked at visibility level/,
];
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
    version: P.version,
    moduleErrors: P.moduleErrors || [],
    stages: (P.bootStages || []).map((s) => s.name),
    webgl2: !!P.engine.renderer.getContext(),
  };
});
check('debug API version matches package.json', boot.version === pkgVersion, `${boot.version} vs ${pkgVersion}`);
check('no module failed to build', boot.moduleErrors.length === 0, JSON.stringify(boot.moduleErrors));
check('all boot stages reported', boot.stages.includes('vegetation') && boot.stages.includes('ready'), boot.stages.join(','));
check('WebGL2 context is live', boot.webgl2);

await page.evaluate(() => window.__pelican.start('ride'));
await page.waitForTimeout(400);
// The overlay refreshes four times a second off the frame loop; poll instead
// of assuming it has painted by now.
// The software-GL CI runner runs the first frames after boot at ~1 fps, where
// 0.25 s of accumulated frame time takes several seconds of wall clock, so the
// window is generous.
await page
  .waitForFunction(() => /fps \d+/.test(window.__pelican.debugText() || ''), null, { timeout: 60000 })
  .catch(() => {});

const hudOnStart = await page.evaluate(() => ({
  tutorial: document.getElementById('pi-tutorial')?.classList.contains('is-on'),
  clock: document.getElementById('pi-clock-value')?.textContent,
  debug: window.__pelican.debugText(),
}));
check('first-run tutorial strip is shown', hudOnStart.tutorial === true);
check('debug overlay reports fps and calls', /fps \d+/.test(hudOnStart.debug) && /calls/.test(hudOnStart.debug), hudOnStart.debug.split('\n')[0]);

// --- real input: pedal for a moment -----------------------------------------
const waitFor = (fn, timeout, label) =>
  page.waitForFunction(fn, null, { timeout })
    .then(() => true)
    .catch(() => {
      console.log(`  (timed out waiting for ${label})`);
      return false;
    });

if (mobile) {
  const pad = await page.evaluate(() => {
    const root = document.getElementById('pi-touch');
    const throttle = document.querySelector('[data-testid="touch-throttle"]');
    const zone = document.querySelector('[data-testid="touch-steer-zone"]');
    return {
      visible: !!root && root.classList.contains('is-on'),
      throttle: !!throttle,
      zone: !!zone,
      throttleBox: throttle ? throttle.getBoundingClientRect().toJSON() : null,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  check('virtual pad is visible on a phone', pad.visible && pad.throttle && pad.zone);
  check('layout does not overflow horizontally', pad.overflow <= 1, `${pad.overflow} px`);
  const box = pad.throttleBox;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await waitFor(() => Math.abs(window.__pelican.state.player.speed) > 6, 120000, 'the bike to reach 6 m/s');
  await page.mouse.up();
} else {
  await page.keyboard.down('w');
  await waitFor(() => Math.abs(window.__pelican.state.player.speed) > 6, 120000, 'the bike to reach 6 m/s');
  await page.keyboard.up('w');
}
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
const pausedOk = await waitFor(() => window.__pelican.state.paused === true, 30000, 'the pause state');
const paused = await page.evaluate(() => ({
  paused: window.__pelican.state.paused,
  badge: document.querySelector('[data-testid="paused"]')?.classList.contains('is-on'),
}));
check('Escape pauses the game', pausedOk && paused.paused === true && paused.badge === true, JSON.stringify(paused));
await page.keyboard.press('Escape');
const resumedOk = await waitFor(() => window.__pelican.state.paused === false, 30000, 'the resume');
check('Escape resumes the game', resumedOk);

// --- world content sanity ----------------------------------------------------
await page.evaluate(() => {
  const P = window.__pelican;
  const player = P.state.player;
  const base = P.layout.pois.balloons.position;
  window.__cage = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    window.__cage.push({ x: base.x + Math.cos(a) * 1.7, z: base.z + Math.sin(a) * 1.7, r: 1.3 });
  }
  player.position.set(base.x, P.layout.heightAt(base.x, base.z) + 0.05, base.z);
  player.heading = 0;
  player.speed = 0;
  P.ctx.colliders.push(...window.__cage);
  window.__unstuck = [];
  P.ctx.bus.on('player:unstuck', (e) => window.__unstuck.push((e && e.reason) || 'unknown'));
});
if (mobile) {
  // the on-screen pad owns the axes on a phone, so hold the real throttle chip
  const pad = await page.evaluate(() =>
    document.querySelector('[data-testid="touch-throttle"]').getBoundingClientRect().toJSON());
  await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
  await page.mouse.down();
  await waitFor(() => (window.__unstuck || []).length > 0, 240000, 'the stuck rescue');
  await page.mouse.up();
} else {
  await page.evaluate(() => window.__pelican.ctx.input.setTouchAxes({ throttle: 1 }));
  await waitFor(() => (window.__unstuck || []).length > 0, 240000, 'the stuck rescue');
  await page.evaluate(() => window.__pelican.ctx.input.setTouchAxes({ throttle: 0 }));
}
const stuck = await page.evaluate(() => {
  const P = window.__pelican;
  for (const c of window.__cage) {
    const i = P.ctx.colliders.indexOf(c);
    if (i >= 0) P.ctx.colliders.splice(i, 1);
  }
  const player = P.state.player;
  return {
    rescued: window.__unstuck.length,
    reason: window.__unstuck[0] || null,
    line: P.layout.roadDistance(player.position.x, player.position.z),
  };
});
check('a pinned rider is put back on the road', stuck.rescued >= 1 && stuck.line < 8,
  `rescued=${stuck.rescued} reason=${stuck.reason} roadDistance=${stuck.line.toFixed(1)} m`);

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
