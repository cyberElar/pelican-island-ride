/**
 * tools/dev/test-ui.mjs - jsdom smoke test for the Pelican Island UI layer.
 *
 *   cd work/pelican-island && node tools/dev/test-ui.mjs
 *
 * Covers:
 *   - createHUD / createMenus mount with a bare `ctx` object
 *   - every public method runs without throwing (including the canvas path,
 *     which jsdom cannot implement - the HUD must degrade, not crash)
 *   - the data-testid contract the rest of the harness relies on
 *   - toast stacking caps at 3, the title screen renders the Chinese title
 *   - bus events drive the HUD
 *   - every element id is `pi-` prefixed and unique
 *   - styles.css parses and keeps the art-direction tokens
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHUD } from '../../src/ui/hud.js';
import { createMenus } from '../../src/ui/menus.js';
import { EventBus } from '../../src/core/utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let checks = 0;
const failures = [];

function ok(cond, label) {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${label}`);
    return true;
  }
  console.error(`  FAIL ${label}`);
  failures.push(label);
  return false;
}

function eq(actual, expected, label) {
  return ok(
    actual === expected,
    `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`
  );
}

function noThrow(label, fn) {
  try {
    fn();
    return ok(true, label);
  } catch (err) {
    ok(false, `${label} threw: ${err && err.stack ? err.stack : err}`);
    return false;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// DOM setup
// ---------------------------------------------------------------------------
const jsdomErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => jsdomErrors.push(err));

const dom = new JSDOM(
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
   <body><div id="pi-app"></div><div id="pi-app-b"></div><div id="pi-app-c"></div></body></html>`,
  { pretendToBeVisual: true, virtualConsole }
);
const { window } = dom;
const document = window.document;

const minimap = {
  size: 6000,
  road: [
    { x: -3000, z: 0 },
    { x: -1500, z: 1200 },
    { x: 0, z: 1600 },
    { x: 1400, z: 900 },
    { x: 2200, z: -400 },
    { x: 800, z: -1500 },
    { x: -1200, z: -1200 },
  ],
  pois: [
    { x: -900, z: 400, type: 'lighthouse', discovered: true },
    { x: 200, z: -800, type: 'village', discovered: false },
    { x: 1500, z: 500, type: 'harbor', discovered: false },
    { x: -1600, z: -900, type: 'peak', discovered: false },
  ],
  player: { x: 120, z: -260, heading: 35 },
  heightTexture: null,
};

const calls = { start: [], resume: 0, settings: [], quit: 0 };
const bus = new EventBus();

const stateMock = {
  hour: 17 + 10 / 60,
  paused: false,
  photoMode: false,
  player: { speed: 10, heading: 35 },
  camera: { mode: 'chase', fov: 58 },
  feathers: { collected: 12, total: 40 },
  discovered: {},
  race: { active: false, checkpoint: 0, time: 0, best: 78.2 },
  quality: 'high',
};

section('1. mount with a bare ctx object');
const hud = createHUD({}, { container: document.getElementById('pi-app'), minimapData: () => minimap });
const menus = createMenus(
  {},
  {
    container: document.getElementById('pi-app'),
    onStart: (mode) => calls.start.push(mode),
    onResume: () => {
      calls.resume += 1;
    },
    onSettingsChange: (patch) => calls.settings.push(patch),
    onQuitToTitle: () => {
      calls.quit += 1;
    },
  }
);

ok(hud.root && hud.root.nodeType === 1, 'hud.root is an HTMLElement');
ok(menus.root && menus.root.nodeType === 1, 'menus.root is an HTMLElement');
eq(hud.root.parentNode, document.getElementById('pi-app'), 'hud.root appended into opts.container');
eq(menus.root.parentNode, document.getElementById('pi-app'), 'menus.root appended into opts.container');
eq(menus.current, 'none', 'menus start on "none"');

section('2. update() reads state without throwing');
noThrow('hud.update(0.016, stateMock) x8', () => {
  for (let i = 0; i < 8; i++) hud.update(0.016, stateMock);
});
noThrow('hud.update() with no state', () => hud.update(0.016, undefined));
noThrow('hud.update(0.016, {}) with empty state', () => hud.update(0.016, {}));
eq(document.getElementById('pi-speedo-value').textContent, '36', 'speedometer reads 10 m/s as 36 km/h');
eq(document.querySelector('[data-testid="speed-readout"]').textContent, '36', 'digital readout is wired');
eq(document.getElementById('pi-feather-count').textContent, '12 / 40', 'feather counter reads state.feathers');
eq(document.getElementById('pi-clock-value').textContent, '17:10', 'clock reads state.hour');
ok(
  document.querySelector('[data-testid="discovered-count"]').textContent.includes('已探索'),
  'discovered counter is present'
);
ok(document.getElementById('pi-clock-phase').textContent.length > 0, 'clock phase label is filled');

section('3. toasts stack and cap at 3');
const toasts = document.querySelector('[data-testid="toasts"]');
eq(toasts.children.length, 0, 'toast list starts empty');
hud.toast('a', 'b');
ok(toasts.children.length > 0, 'toast count grows');
for (let i = 0; i < 6; i++) hud.toast(`t${i}`, `s${i}`);
eq(toasts.children.length, 3, 'toast count caps at 3');
ok(
  toasts.firstElementChild.getAttribute('data-testid') === 'toast',
  'toasts carry data-testid="toast"'
);
ok(
  toasts.firstElementChild.textContent.includes('t5'),
  'newest toast is rendered first (column-reverse stack)'
);

section('4. discovery / race / photo / pause / loading');
hud.discovery('灯塔', 'Lighthouse', 'A beam in the night');
eq(document.getElementById('pi-discovery-name').textContent, '灯塔', 'discovery() fills the Chinese name');
eq(document.getElementById('pi-discovery-en').textContent, 'Lighthouse', 'discovery() fills the English name');
eq(
  document.getElementById('pi-discovery-sub').textContent,
  'A beam in the night',
  'discovery() fills the sub line'
);
ok(document.querySelector('[data-testid="discovery"]').classList.contains('is-on'), 'discovery card shows');
ok(
  document.querySelector('[data-testid="letterbox"]').classList.contains('is-on'),
  'discovery slides the letterbox in'
);

hud.setRace({ checkpoint: 3, total: 12, time: 83.4, best: 78.2, finished: false });
ok(document.querySelector('[data-testid="race"]').classList.contains('is-on'), 'race panel shows');
eq(document.getElementById('pi-race-checkpoint').textContent, '3/12', 'race checkpoint n/total');
eq(document.getElementById('pi-race-time').textContent, '1:23.4', 'race time is M:SS.d');
eq(document.getElementById('pi-race-best').textContent, '1:18.2', 'race best time is formatted');
hud.setRace({ checkpoint: 12, total: 12, time: 78.2, best: 78.2, finished: true });
ok(document.querySelector('[data-testid="race-banner"]').classList.contains('is-on'), 'finish banner shows');
ok(
  document.querySelector('[data-testid="race-banner"]').classList.contains('is-record'),
  'finish banner flags a new record'
);
hud.setRace(null);
ok(!document.querySelector('[data-testid="race"]').classList.contains('is-on'), 'setRace(null) hides the panel');

hud.setPhotoMode(true, { fov: 50, filterName: '胶片' });
eq(document.getElementById('pi-photo-focal').textContent, '26', 'focal length from fov (50 -> 26 mm)');
eq(document.getElementById('pi-photo-filter').textContent, '胶片', 'filter name readout');
eq(
  document.getElementById('pi-photo-hint').textContent,
  '滚轮缩放 · 方向键移动 · F 网格 · V 滤镜 · X 导出 · P 退出',
  'photo-mode hint line'
);
ok(document.querySelector('[data-testid="photo-overlay"]').classList.contains('is-on'), 'photo overlay shows');
ok(document.getElementById('pi-hud').classList.contains('is-photo'), 'photo mode class on the HUD root');
ok(
  !document.querySelector('[data-testid="photo-grid"]').classList.contains('is-off'),
  'rule-of-thirds grid is on by default'
);
hud.togglePhotoGrid(false);
ok(
  document.querySelector('[data-testid="photo-grid"]').classList.contains('is-off'),
  'togglePhotoGrid(false) hides the grid'
);
hud.setPhotoMode(false, null);

hud.setPaused(true);
ok(document.getElementById('pi-hud').classList.contains('is-paused'), 'setPaused(true) fades the HUD');
ok(document.querySelector('[data-testid="paused"]').classList.contains('is-on'), 'paused badge shows');
hud.setPaused(false);

hud.setLoading(true, 0.4, '生成地形');
ok(document.querySelector('[data-testid="loading"]').classList.contains('is-on'), 'loading veil shows');
eq(
  Number.parseFloat(document.getElementById('pi-loading-fill').style.width),
  40,
  'loading bar width follows progress'
);
eq(document.getElementById('pi-loading-label').textContent, '生成地形', 'loading label follows progress');
ok(
  document.getElementById('pi-loading-title').textContent.includes('正在生成小岛'),
  'loading title is 「正在生成小岛…」'
);
ok(document.getElementById('pi-loading-tip').textContent.startsWith('提示：'), 'loading tip is a 提示 line');
hud.setLoading(false);
ok(!document.querySelector('[data-testid="loading"]').classList.contains('is-on'), 'loading veil hides');

section('5. compass + minimap');
hud.setCompassHeading(120);
eq(document.getElementById('pi-compass-readout').textContent, '120°', 'compass readout follows heading');
ok(
  document.getElementById('pi-compass-shift').style.transform.includes('900.0px'),
  'compass strip slides with the heading'
);
eq(
  document.getElementById('pi-compass-strip').children.length,
  216,
  'compass strip is prebuilt (3 cycles x 72 ticks)'
);
ok(document.getElementById('pi-compass-strip').textContent.includes('N'), 'compass strip labels the cardinals');

const canvas = document.querySelector('[data-testid="minimap-canvas"]');
eq(canvas.width, 180, 'minimap canvas is 180 wide');
eq(canvas.height, 180, 'minimap canvas is 180 tall');
noThrow('toggleMinimap() with jsdom (no 2D context)', () => hud.toggleMinimap());
ok(document.querySelector('[data-testid="minimap"]').classList.contains('is-on'), 'minimap becomes visible');
eq(hud.isMinimapOpen(), true, 'isMinimapOpen() reports true');
noThrow('hud.update() while the minimap is open', () => {
  for (let i = 0; i < 12; i++) hud.update(0.05, stateMock);
});
hud.toggleMinimap();
ok(!document.querySelector('[data-testid="minimap"]').classList.contains('is-on'), 'minimap toggles off again');

section('6. flashDamage');
noThrow('flashDamage()', () => hud.flashDamage());
ok(document.querySelector('[data-testid="damage"]').classList.contains('is-on'), 'damage vignette flashes');

section('7. menus: screens, buttons, settings');
menus.show('title');
const titleScreen = document.querySelector('[data-testid="screen-title"]');
ok(titleScreen.classList.contains('is-active'), 'show("title") activates the title screen');
eq(menus.current, 'title', 'menus.current is "title"');
ok(titleScreen.textContent.includes('提鹅鹏'), 'title screen shows the Chinese title');
ok(titleScreen.textContent.includes('单车环岛'), 'title screen shows the subtitle');
ok(titleScreen.textContent.includes("A PELICAN'S ISLAND RIDE"), 'title screen shows the English line');
ok(
  document.querySelector('[data-testid="title-hint"]').textContent.includes('按住 W 加速'),
  'title screen shows the control hint line'
);
eq(document.querySelector('[data-testid="title-main"]').textContent, '提鹅鹏', 'title-main text is the game title');
ok(document.querySelectorAll('.pi-btn').length >= 8, 'title + card buttons exist');

const click = (id) => {
  const node = document.querySelector(`[data-testid="${id}"]`);
  assert.ok(node, `missing element ${id}`);
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

click('btn-start-ride');
click('btn-free-ride');
click('btn-photo-mode');
eq(calls.start.join(','), 'ride,free,photo', 'onStart(mode) receives ride/free/photo');

menus.show('settings');
ok(document.querySelector('[data-testid="screen-settings"]').classList.contains('is-active'), 'settings screen shows');
eq(
  document.querySelectorAll('[data-testid="quality-options"] .pi-option').length,
  4,
  'four quality buttons exist'
);
click('quality-ultra');
eq(menus.settings.quality, 'ultra', 'quality button updates the settings object');
ok(
  calls.settings.some((p) => p && p.quality === 'ultra'),
  'onSettingsChange received { quality: "ultra" }'
);
click('time-night');
ok(
  calls.settings.some((p) => p && p.timeMode === 'night'),
  'time-of-day button emits a timeMode patch'
);

const master = document.querySelector('[data-testid="slider-master"]');
master.value = '0.5';
master.dispatchEvent(new window.Event('input', { bubbles: true }));
eq(master.value, '0.5', 'volume slider accepts input');
ok(
  calls.settings.some((p) => p && Math.abs(p.masterVolume - 0.5) < 1e-9),
  'slider emits a masterVolume patch'
);
eq(document.querySelector('[data-testid="value-master"]').textContent, '50%', 'slider value is shown next to it');

click('toggle-mute');
ok(calls.settings.some((p) => p && p.muted === true), 'mute toggle emits a muted patch');
click('toggle-mute');
click('lang-en');
ok(calls.settings.some((p) => p && p.language === 'en'), 'language buttons emit a language patch');
eq(menus.settings.language, 'en', 'language switch is stored');
click('lang-zh');
noThrow('reset view button', () => click('btn-reset-view'));
noThrow('settings back button', () => click('btn-settings-back'));
eq(menus.current, 'title', 'settings back returns to where we came from');

menus.show('pause');
ok(document.querySelector('[data-testid="screen-pause"]').classList.contains('is-active'), 'pause screen shows');
click('btn-resume');
eq(calls.resume, 1, 'onResume() fired');
click('btn-quit-title');
eq(calls.quit, 1, 'onQuitToTitle() fired');

menus.show('help');
ok(document.querySelector('[data-testid="screen-help"]').classList.contains('is-active'), 'help screen shows');
menus.show('about');
ok(document.querySelector('[data-testid="screen-about"]').classList.contains('is-active'), 'about screen shows');
noThrow('Escape closes a sub-screen (keyboard navigation)', () => {
  menus.root.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
noThrow('arrow keys move focus (keyboard navigation)', () => {
  menus.root.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  );
});

menus.setLoadingProgress(0.4, '生成地形');
eq(
  Number.parseFloat(document.getElementById('pi-menu-loading-fill').style.width),
  40,
  'menus loading bar follows progress'
);
eq(document.getElementById('pi-menu-loading-label').textContent, '生成地形', 'menus loading label follows progress');
noThrow('menus.setLoading(true)', () => menus.setLoading(true, 0.4, '生成地形'));
ok(document.querySelector('[data-testid="menu-loading"]').classList.contains('is-on'), 'menus loading panel shows');
noThrow('menus.setLoading(false)', () => menus.setLoading(false));

menus.show('none');
ok(
  !document.querySelector('[data-testid="screen-title"]').classList.contains('is-active'),
  'show("none") hides all screens'
);

section('8. bus events drive the HUD');
const hud2 = createHUD(
  { bus, state: { discovered: {} } },
  { container: document.getElementById('pi-app-b'), minimapData: () => minimap }
);
const hud2Doc = hud2.root;

bus.emit('feather:collected', { collected: 3, total: 40 });
eq(hud2Doc.querySelector('#pi-feather-count').textContent, '3 / 40', 'feather:collected updates the counter');
ok(hud2Doc.querySelector('#pi-hud-feathers').classList.contains('is-pulse'), 'feather:collected pulses the chip');

bus.emit('poi:discovered', { id: 'lighthouse', name: '灯塔', nameEn: 'Lighthouse', sub: 'A beam' });
eq(hud2Doc.querySelector('#pi-discovery-name').textContent, '灯塔', 'poi:discovered fills the name card');
ok(
  hud2Doc.querySelector('[data-testid="discovery"]').classList.contains('is-on'),
  'poi:discovered shows the letterboxed card'
);

bus.emit('race:start', { total: 12 });
ok(hud2Doc.querySelector('[data-testid="race"]').classList.contains('is-on'), 'race:start shows the race HUD');
bus.emit('race:checkpoint', { checkpoint: 4, total: 12, time: 42.5, best: null });
eq(hud2Doc.querySelector('#pi-race-checkpoint').textContent, '4/12', 'race:checkpoint updates n/total');
bus.emit('race:finish', { total: 12, time: 70.1, best: 78.2 });
ok(
  hud2Doc.querySelector('[data-testid="race-banner"]').classList.contains('is-on'),
  'race:finish shows the banner'
);
ok(
  hud2Doc.querySelector('[data-testid="race-banner"]').classList.contains('is-record'),
  'race:finish flags a new record when the time beats the best'
);

bus.emit('rider:crash', {});
ok(hud2Doc.querySelector('[data-testid="damage"]').classList.contains('is-on'), 'rider:crash flashes damage');
bus.emit('camera:mode', { mode: 'firstPerson' });
eq(hud2Doc.querySelector('#pi-camera-value').textContent, '第一人称', 'camera:mode updates the chip');
bus.emit('photo:enter', { fov: 35, filterName: '负片' });
ok(
  hud2Doc.querySelector('[data-testid="photo-overlay"]').classList.contains('is-on'),
  'photo:enter shows the overlay'
);
eq(hud2Doc.querySelector('#pi-photo-filter').textContent, '负片', 'photo:enter carries the filter name');
bus.emit('photo:exit', {});
ok(
  !hud2Doc.querySelector('[data-testid="photo-overlay"]').classList.contains('is-on'),
  'photo:exit hides the overlay'
);
bus.emit('settings:changed', { language: 'en' });
eq(hud2Doc.querySelector('#pi-feather-label').textContent, 'FEATHERS', 'settings:changed switches the HUD language');
ok(
  hud2Doc.querySelector('#pi-hud-discovered').textContent.startsWith('DISCOVERED'),
  'discovered label switches to EN'
);
hud2.destroy();
eq(document.getElementById('pi-app-b').children.length, 0, 'hud2.destroy() removes its root');

section('9. defence in depth');
const realGetContext = window.HTMLCanvasElement.prototype.getContext;
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  throw new Error('canvas disabled');
};
const hud3 = createHUD({}, { container: document.getElementById('pi-app-c'), minimapData: () => minimap });
noThrow('toggleMinimap() when getContext() throws', () => hud3.toggleMinimap());
noThrow('update() when getContext() throws', () => hud3.update(0.05, stateMock));
window.HTMLCanvasElement.prototype.getContext = realGetContext;
hud3.destroy();

const menus2 = createMenus(
  {},
  {
    container: document.getElementById('pi-app-c'),
    onStart: () => {
      throw new Error('listener blew up');
    },
    onSettingsChange: () => {
      throw new Error('listener blew up');
    },
  }
);
noThrow('a throwing onStart() callback is contained', () => {
  menus2.root
    .querySelector('[data-testid="btn-start-ride"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
});
noThrow('a throwing onSettingsChange() callback is contained', () => {
  menus2.root
    .querySelector('[data-testid="quality-low"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
});
menus2.destroy();
eq(document.getElementById('pi-app-c').children.length, 0, 'menus2.destroy() removes its root');
ok(menus2.current === 'none', 'destroyed menus keep answering current without throwing');

section('10. ids and the stylesheet');
const ids = Array.from(document.querySelectorAll('[id]')).map((n) => n.id);
const idSet = new Set(ids);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
const badPrefix = Array.from(idSet).filter((id) => !id.startsWith('pi-'));
ok(dupes.length === 0, `element ids are unique (${dupes.join(', ') || 'none duplicated'})`);
ok(badPrefix.length === 0, `element ids are pi- prefixed (${badPrefix.join(', ') || 'all good'})`);

const required = {
  hud: [
    'hud-root', 'letterbox', 'compass', 'compass-strip', 'compass-readout', 'discovered-count',
    'feathers', 'feather-count', 'clock', 'speedometer', 'speed-readout', 'camera-mode',
    'minimap', 'minimap-canvas', 'race', 'race-checkpoint', 'race-time', 'race-best',
    'race-banner', 'toasts', 'discovery', 'discovery-name', 'photo-overlay', 'photo-grid',
    'photo-focal', 'photo-filter', 'photo-hint', 'photo-grid-toggle', 'loading', 'loading-bar',
    'damage', 'paused',
  ],
  menus: [
    'menus-root', 'screen-title', 'title-main', 'title-sub', 'title-en', 'title-hint',
    'title-buttons', 'btn-start-ride', 'btn-free-ride', 'btn-photo-mode', 'btn-title-settings',
    'btn-title-about', 'screen-pause', 'btn-resume', 'btn-pause-settings', 'btn-quit-title',
    'screen-settings', 'quality-options', 'quality-low', 'quality-high', 'quality-ultra',
    'time-options', 'time-dawn', 'time-cycle', 'slider-master', 'slider-music', 'slider-sfx',
    'value-master', 'toggle-mute', 'language-options', 'lang-zh', 'lang-en', 'btn-reset-view',
    'btn-settings-back', 'screen-help', 'screen-about', 'menu-loading', 'menu-loading-bar',
    'menu-loading-label', 'menu-loading-tip',
  ],
};
let missing = 0;
for (const id of [...required.hud, ...required.menus]) {
  if (!document.querySelector(`[data-testid="${id}"]`)) {
    missing += 1;
    console.error(`  MISSING data-testid="${id}"`);
  }
}
eq(missing, 0, `${required.hud.length + required.menus.length} required data-testids exist`);

const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
ok(css.includes('#f7f1e4'), 'styles.css uses the cream paper token');
ok(css.includes('#22201c'), 'styles.css uses the ink token');
ok(css.includes('#1f6f78'), 'styles.css uses the teal token');
ok(css.includes('#e0523f'), 'styles.css uses the poppy token');
ok(css.includes('tabular-nums'), 'styles.css uses tabular numerals');
ok(css.includes('Noto Serif SC') && css.includes('Source Han Serif SC'), 'styles.css keeps the serif stack');
ok(css.includes('clip-path: polygon'), 'styles.css uses clip-path island silhouettes');
const purpleHexes = ['#8b5cf6', '#a855f7', '#7c3aed', '#6366f1', '#4f46e5', '#9333ea'];
ok(!/purple/i.test(css) && purpleHexes.every((h) => !css.includes(h)), 'styles.css has no purple accents');
ok(css.includes('prefers-reduced-motion'), 'styles.css honours prefers-reduced-motion');

let cssParsed = true;
try {
  const esbuild = await import('esbuild');
  await esbuild.transform(css, { loader: 'css' });
} catch (err) {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('  note esbuild is not installed - skipped the CSS parse check');
  } else {
    cssParsed = false;
    console.error(`  css parse error: ${err && err.message}`);
  }
}
ok(cssParsed, 'styles.css parses as CSS');

section('11. teardown');
noThrow('menus.destroy()', () => menus.destroy());
noThrow('hud.destroy()', () => hud.destroy());
eq(document.getElementById('pi-hud'), null, 'hud root removed from the DOM');
eq(document.getElementById('pi-menus'), null, 'menus root removed from the DOM');
noThrow('calling the API after destroy() is a no-op', () => {
  hud.toast('late', 'toast');
  hud.update(0.016, stateMock);
  hud.discovery('x', 'y', 'z');
  menus.show('title');
  menus.setLoadingProgress(1, 'done');
});

if (jsdomErrors.length) {
  console.log(`\njsdom reported ${jsdomErrors.length} handled warning(s), e.g. ${jsdomErrors[0].message}`);
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED CHECK(S):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nALL UI TESTS PASSED');
}
