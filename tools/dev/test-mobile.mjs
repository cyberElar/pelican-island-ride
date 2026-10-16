/**
 * tools/dev/test-mobile.mjs - jsdom test for the phone/accessibility layer.
 *
 *   node tools/dev/test-mobile.mjs
 *
 * Covers:
 *   - createTouchControls() mounts on touch hardware and stays hidden on desktop
 *   - the pad is revealed by the first real touch pointer
 *   - dragging the stick writes input.setTouchAxes({ steer })  (dead zone,
 *     release-to-centre, no leakage while paused / in photo mode)
 *   - pedal + brake write throttle / brake, a short tap keeps a push alive
 *   - action buttons reuse input.touchButton() and the help button emits ui:help
 *   - destroy() unmounts, zeroes the axes and drops the window listener
 *   - styles.css ships the page baseline (no 8px body margin), safe-area vars,
 *     the landscape/portrait touch layout and the sr-only live-region helper
 *   - menus default the comfort switches from prefers-reduced-motion and emit
 *     settings:changed, HUD exposes progressbar / live regions / captions
 *   - camera.js honours reduceMotion / shakeIntensity / comfortFov
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createTouchControls } from '../../src/ui/touch.js';
import { createHUD } from '../../src/ui/hud.js';
import { createMenus } from '../../src/ui/menus.js';
import { createCameraController } from '../../src/gameplay/camera.js';
import { EventBus } from '../../src/core/utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

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

function near(actual, expected, tol, label) {
  return ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    `${label} (got ${actual}, expected ${expected} ±${tol})`
  );
}

function section(title) {
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeDom({ touch = true, reduceMotion = false } = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
     <body><div id="pi-app"></div></body></html>`,
    { pretendToBeVisual: true, virtualConsole }
  );
  const { window } = dom;
  const document = window.document;
  if (touch) {
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });
  }
  // jsdom's matchMedia never matches; make it answer like a real device.
  const media = (query) => ({
    matches: /coarse/.test(query) ? touch : /reduced-motion/.test(query) ? reduceMotion : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  window.matchMedia = media;
  return { dom, window, document };
}

/** Fake input object that records everything the pad writes. */
function makeInput() {
  const axesWrites = [];
  const buttons = [];
  return {
    axesWrites,
    buttons,
    enabled: true,
    setTouchAxes(a) {
      axesWrites.push({ ...a });
    },
    touchButton(action, down) {
      buttons.push({ action, down });
    },
    touchHeld() { return false; },
    lastAxes() { return axesWrites.length ? axesWrites[axesWrites.length - 1] : { steer: 0, throttle: 0, brake: 0 }; },
  };
}

function pointer(win, type, opts = {}) {
  const ev = new win.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.x || 0,
    clientY: opts.y || 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: opts.id === undefined ? 1 : opts.id });
  Object.defineProperty(ev, 'pointerType', { value: opts.pointerType || 'touch' });
  return ev;
}

// ---------------------------------------------------------------------------
section('1. touch pad mounts on touch hardware, not on desktop');
// ---------------------------------------------------------------------------
{
  const { window, document } = makeDom({ touch: true });
  const input = makeInput();
  const bus = new EventBus();
  const touch = createTouchControls(input, { container: document.getElementById('pi-app'), bus, window, document });
  ok(touch.root && touch.root.nodeType === 1, 'root is an element');
  eq(touch.root.parentNode, document.getElementById('pi-app'), 'root mounted into the container');
  eq(touch.hasTouch, true, 'hasTouch true when navigator.maxTouchPoints > 0');
  eq(touch.visible, true, 'pad is visible on a touch device');
  ok(touch.root.classList.contains('is-on'), 'root carries .is-on');
  ok(document.getElementById('pi-touch-stick'), '#pi-touch-stick exists');
  ok(document.getElementById('pi-touch-throttle'), '#pi-touch-throttle exists');
  ok(document.getElementById('pi-touch-brake'), '#pi-touch-brake exists');
  const actIds = ['camera', 'map', 'photo', 'pause', 'help', 'bell', 'race'];
  const missing = actIds.filter((a) => !document.querySelector(`[data-testid="touch-act-${a}"]`));
  eq(missing.length, 0, `seven action buttons exist (${actIds.join(', ')})`);
  const go = document.getElementById('pi-touch-throttle');
  eq(go.tagName, 'BUTTON', 'pedal is a native <button>');
  ok(go.getAttribute('aria-label').includes('加速'), 'pedal has an aria-label');
  touch.destroy();
}

{
  const { window, document } = makeDom({ touch: false });
  const input = makeInput();
  const touch = createTouchControls(input, { container: document.getElementById('pi-app'), window, document });
  eq(touch.visible, false, 'desktop (no touch points, no coarse pointer) keeps the pad hidden');
  ok(!touch.root.classList.contains('is-on'), 'no .is-on on desktop');
  // …until a real touch pointer shows up (hybrid laptop / Android desktop).
  window.dispatchEvent(pointer(window, 'pointerdown', { x: 10, y: 10, pointerType: 'touch' }));
  eq(touch.visible, true, 'first touch pointer reveals the pad');
  touch.destroy();
}

// ---------------------------------------------------------------------------
section('2. steering stick writes axes');
// ---------------------------------------------------------------------------
{
  const { window, document } = makeDom({ touch: true });
  const input = makeInput();
  const touch = createTouchControls(input, { container: document.getElementById('pi-app'), window, document });
  touch.update(0.016, { started: true });
  const zone = document.getElementById('pi-touch-zone');
  const knob = document.getElementById('pi-touch-knob');

  zone.dispatchEvent(pointer(window, 'pointerdown', { x: 80, y: 500, id: 7 }));
  touch.update(0.05, { started: true });
  eq(input.lastAxes().steer, 0, 'press inside the dead zone steers nothing');
  eq(input.lastAxes().throttle, 0, 'press alone does not pedal');

  zone.dispatchEvent(pointer(window, 'pointermove', { x: 160, y: 500, id: 7 }));
  for (let i = 0; i < 12; i++) touch.update(0.05, { started: true });
  ok(input.lastAxes().steer > 0.5, `dragging right steers right (steer=${input.lastAxes().steer.toFixed(3)})`);
  ok(knob.style.transform.includes('translate'), 'knob follows the finger');

  zone.dispatchEvent(pointer(window, 'pointermove', { x: 20, y: 500, id: 7 }));
  for (let i = 0; i < 12; i++) touch.update(0.05, { started: true });
  ok(input.lastAxes().steer < -0.5, `dragging left steers left (steer=${input.lastAxes().steer.toFixed(3)})`);

  zone.dispatchEvent(pointer(window, 'pointerup', { x: 20, y: 500, id: 7 }));
  for (let i = 0; i < 20; i++) touch.update(0.05, { started: true });
  eq(input.lastAxes().steer, 0, 'releasing returns the axis to centre');
  eq(knob.style.transform, '', 'knob animation resets on release');

  // A second finger while the stick is held must not hijack the steering.
  zone.dispatchEvent(pointer(window, 'pointerdown', { x: 100, y: 500, id: 1 }));
  zone.dispatchEvent(pointer(window, 'pointerdown', { x: 300, y: 500, id: 2 }));
  zone.dispatchEvent(pointer(window, 'pointermove', { x: 170, y: 500, id: 1 }));
  for (let i = 0; i < 12; i++) touch.update(0.05, { started: true });
  const steered = input.lastAxes().steer;
  zone.dispatchEvent(pointer(window, 'pointermove', { x: 10, y: 500, id: 2 }));
  touch.update(0.05, { started: true });
  ok(input.lastAxes().steer >= steered - 0.02, 'a second pointer cannot steal the stick');
  touch.destroy();
}

// ---------------------------------------------------------------------------
section('3. pedal, brake and the tap latch');
// ---------------------------------------------------------------------------
{
  const { window, document } = makeDom({ touch: true });
  const input = makeInput();
  const touch = createTouchControls(input, { container: document.getElementById('pi-app'), window, document });
  const go = document.getElementById('pi-touch-throttle');
  const brake = document.getElementById('pi-touch-brake');
  touch.update(0.016, { started: true });

  go.dispatchEvent(pointer(window, 'pointerdown', { x: 300, y: 600, id: 3 }));
  touch.update(0.05, { started: true });
  eq(input.lastAxes().throttle, 1, 'holding the pedal gives full throttle');
  ok(go.classList.contains('is-down'), 'pedal shows the pressed state');
  go.dispatchEvent(pointer(window, 'pointerup', { x: 300, y: 600, id: 3 }));
  touch.update(0.05, { started: true });
  ok(input.lastAxes().throttle > 0, 'a short tap keeps a push alive');
  await sleep(760);
  touch.update(0.05, { started: true });
  eq(input.lastAxes().throttle, 0, 'the tap latch decays back to zero');

  brake.dispatchEvent(pointer(window, 'pointerdown', { x: 200, y: 600, id: 4 }));
  touch.update(0.05, { started: true });
  eq(input.lastAxes().brake, 1, 'brake button brakes');
  brake.dispatchEvent(pointer(window, 'pointerup', { x: 200, y: 600, id: 4 }));
  touch.update(0.05, { started: true });
  eq(input.lastAxes().brake, 0, 'releasing the brake clears it');

  // pedal + steer together (multi-touch)
  go.dispatchEvent(pointer(window, 'pointerdown', { x: 300, y: 600, id: 5 }));
  const zone = document.getElementById('pi-touch-zone');
  zone.dispatchEvent(pointer(window, 'pointerdown', { x: 90, y: 520, id: 6 }));
  zone.dispatchEvent(pointer(window, 'pointermove', { x: 170, y: 520, id: 6 }));
  for (let i = 0; i < 10; i++) touch.update(0.05, { started: true });
  ok(input.lastAxes().throttle === 1 && input.lastAxes().steer > 0.4, 'pedal and steer work at the same time');
  touch.destroy();
}

// ---------------------------------------------------------------------------
section('4. action buttons, help, idle states, teardown');
// ---------------------------------------------------------------------------
{
  const { window, document } = makeDom({ touch: true });
  const input = makeInput();
  const bus = new EventBus();
  const touch = createTouchControls(input, { container: document.getElementById('pi-app'), bus, window, document });
  touch.update(0.016, { started: true });

  document.querySelector('[data-testid="touch-act-camera"]').dispatchEvent(pointer(window, 'pointerdown', { x: 340, y: 300, id: 9 }));
  ok(input.buttons.some((b) => b.action === 'camera' && b.down === true), 'camera button presses the camera action');
  await sleep(140);
  ok(input.buttons.some((b) => b.action === 'camera' && b.down === false), 'camera button releases the action');

  let helped = 0;
  bus.on('ui:help', () => { helped += 1; });
  document.querySelector('[data-testid="touch-act-help"]').dispatchEvent(pointer(window, 'pointerdown', { x: 340, y: 360, id: 10 }));
  eq(helped, 1, 'help button emits ui:help');

  touch.update(0.05, { paused: true, started: true });
  ok(touch.root.classList.contains('is-idle'), 'paused world marks the pad idle');
  eq(input.lastAxes().steer, 0, 'paused world zeroes the axes');
  touch.update(0.05, { photoMode: true, started: true });
  ok(touch.root.classList.contains('is-idle'), 'photo mode marks the pad idle (drag-look keeps the frame)');
  touch.update(0.05, { started: false });
  ok(touch.root.classList.contains('is-idle'), 'title screen marks the pad idle');
  ok(touch.root.classList.contains('is-off'), 'title screen hides the pad entirely (.is-off)');
  touch.update(0.05, { started: true });
  ok(!touch.root.classList.contains('is-idle'), 'riding clears the idle state');
  ok(document.body.classList.contains('pi-has-touch'), 'body gets .pi-has-touch so HUD corners can move');

  touch.setVisible(false);
  eq(touch.visible, false, 'setVisible(false) hides the pad');
  eq(input.lastAxes().steer, 0, 'hiding zeroes the axes');
  touch.setVisible(true);

  touch.destroy();
  eq(document.getElementById('pi-touch'), null, 'destroy() removes the pad from the DOM');
  eq(input.lastAxes().steer, 0, 'destroy() leaves the axes at zero');
  // The reveal listener must be gone: a later touch must not resurrect anything.
  window.dispatchEvent(pointer(window, 'pointerdown', { x: 5, y: 5, pointerType: 'touch' }));
  eq(touch.visible, false, 'destroy() drops the first-touch listener');
}

// ---------------------------------------------------------------------------
section('5. styles.css ships the baseline + safe areas + touch layout');
// ---------------------------------------------------------------------------
{
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  ok(/html,\s*\nbody\s*\{[^}]*margin:\s*0/.test(css), 'html/body margin reset is present');
  ok(/html,\s*\nbody\s*\{[^}]*overflow:\s*hidden/.test(css), 'html/body do not scroll');
  ok(/#ui-root\s*\{[^}]*position:\s*fixed/.test(css), '#ui-root is fixed to the viewport');
  ok(/#game-canvas\s*\{[^}]*display:\s*block/.test(css), '#game-canvas is a block');
  ok(css.includes('touch-action: manipulation'), 'double-tap zoom is suppressed without disabling pinch-zoom');
  ok(css.includes('env(safe-area-inset-top'), 'safe-area insets are used');
  ok(css.includes('@media (orientation: landscape)'), 'landscape layout exists');
  ok(css.includes('@media (max-width: 480px)'), 'portrait phone layout exists');
  ok(css.includes('.pi-sr-only'), 'screen-reader-only helper exists');
  ok(css.includes('.pi-touch__stick') && css.includes('.pi-touch__btn'), 'touch pad styles exist');
  ok(css.includes('role') === false, 'no stray "role" text in CSS');
  ok(/\.pi-touch__btn\s*\{[^}]*width:\s*88px/.test(css), 'pedal button is 88px (>= 24px target size)');
  ok(css.includes('--pi-ui-scale'), 'UI scale variable is wired');
  ok(css.includes('prefers-reduced-motion'), 'prefers-reduced-motion still honoured');
  // The small labels must no longer use the decorative 45% ink.
  const smallLabel = /\.pi-chip__label\s*\{[^}]*\}/.exec(css);
  ok(!!smallLabel && /--pi-ink-mute/.test(smallLabel[0]), 'HUD chip label uses the readable ink token');
  ok(!!smallLabel && !/--pi-ink-45/.test(smallLabel[0]), 'HUD chip label no longer uses --pi-ink-45');
}

// ---------------------------------------------------------------------------
section('6. menus: comfort defaults, toggles, settings bus');
// ---------------------------------------------------------------------------
{
  const { window, document } = makeDom({ touch: true, reduceMotion: true });
  const bus = new EventBus();
  const seen = [];
  bus.on('settings:changed', (p) => seen.push(p));
  const menus = createMenus(
    { bus, window },
    {
      container: document.getElementById('pi-app'),
      onSettingsChange: () => {},
      onStart: () => {},
      onResume: () => {},
      onQuitToTitle: () => {},
    }
  );
  const s = menus.settings;
  eq(s.reduceMotion, true, 'reduceMotion defaults to the OS preference');
  eq(s.shakeIntensity, 'off', 'shakeIntensity defaults to off under reduce-motion');
  eq(s.comfortFov, true, 'comfortFov defaults to on under reduce-motion');
  eq(s.autoCinematic, false, 'autoCinematic defaults to off under reduce-motion');
  eq(s.uiScale, 1, 'uiScale defaults to 100%');
  eq(s.captions, true, 'captions default to on');

  ok(document.querySelector('[data-testid="shake-options"]'), 'shake option group exists');
  ok(document.querySelector('[data-testid="uiscale-options"]'), 'UI scale option group exists');
  const toggles = ['toggle-comfort-fov', 'toggle-reduce-motion', 'toggle-auto-cinematic', 'toggle-captions'];
  const missing = toggles.filter((t) => !document.querySelector(`[data-testid="${t}"]`));
  eq(missing.length, 0, `comfort toggles exist (${toggles.join(', ')})`);
  const motionToggle = document.querySelector('[data-testid="toggle-reduce-motion"]');
  eq(motionToggle.getAttribute('aria-pressed'), 'true', 'reduce-motion toggle reflects the default');
  ok(motionToggle.textContent.includes('开'), 'toggle shows its state in words');

  motionToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  eq(seen.length > 0, true, 'changing a setting emits settings:changed');
  const last = seen[seen.length - 1];
  eq(last.reduceMotion, false, 'the emitted patch carries the new value');

  document.querySelector('[data-testid="shake-high"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  eq(seen[seen.length - 1].shakeIntensity, 'high', 'shake strength is a per-setting patch');
  document.querySelector('[data-testid="uiscale-1.3"]') && document.querySelector('[data-testid="uiscale-1.3"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  ok(seen.some((p) => p.uiScale === 1.3), 'UI scale is emitted as a number');

  // setSettings() must reach the rest of the app (boot-time restore path).
  const before = seen.length;
  menus.setSettings({ captions: false, language: 'en' });
  ok(seen.length > before, 'menus.setSettings() emits settings:changed (boot restore reaches HUD/camera)');

  // Tab stays inside the open panel.
  menus.show('settings');
  const screen = document.getElementById('pi-screen-settings');
  const focusables = screen.querySelectorAll('button:not([disabled]), input:not([disabled])');
  ok(focusables.length > 2, `settings screen has focusables (${focusables.length})`);
  focusables[focusables.length - 1].focus();
  screen.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  eq(document.activeElement === focusables[0], true, 'Tab wraps to the first control (focus trap)');
  focusables[0].focus();
  screen.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  eq(document.activeElement === focusables[focusables.length - 1], true, 'Shift+Tab wraps to the last control');
  menus.destroy();
  eq(document.getElementById('pi-menus'), null, 'menus destroy removes the root');
}

// ---------------------------------------------------------------------------
section('7. HUD: live regions, progressbar, captions, marker shapes');
// ---------------------------------------------------------------------------
{
  const { window, document } = makeDom({ touch: true });
  const bus = new EventBus();
  const hud = createHUD(
    { bus },
    { container: document.getElementById('pi-app'), minimapData: () => ({ size: 6000, road: [], pois: [], player: null }) }
  );
  eq(document.getElementById('pi-feather-count').getAttribute('aria-live'), 'polite', 'feather count is a polite live region');
  eq(document.getElementById('pi-hud-discovered').getAttribute('aria-live'), 'polite', 'discovered count is a polite live region');
  eq(document.getElementById('pi-sr-status').getAttribute('aria-live'), 'polite', 'sr-only status region exists');
  eq(document.getElementById('pi-compass-strip').getAttribute('aria-hidden'), 'true', 'compass tick strip is hidden from screen readers');
  eq(document.getElementById('pi-race-time').getAttribute('role'), 'timer', 'race clock is a timer (not a chatty live region)');
  const bar = document.getElementById('pi-loading-bar');
  eq(bar.getAttribute('role'), 'progressbar', 'loading bar is a progressbar');
  hud.setLoading(true, 0.42, '生成地形');
  eq(bar.getAttribute('aria-valuenow'), '42', 'progressbar aria-valuenow follows progress');
  ok(bar.getAttribute('aria-valuetext').includes('生成地形'), 'progressbar valuetext carries the stage label');
  hud.setLoading(false);

  const helpBtn = document.getElementById('pi-hud-help');
  eq(helpBtn.tagName, 'BUTTON', 'HUD help chip is a native button');
  let helpRequests = 0;
  bus.on('ui:help', () => { helpRequests += 1; });
  helpBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  eq(helpRequests, 1, 'HUD help chip asks menus to open the controls panel');

  const caption = document.getElementById('pi-caption');
  bus.emit('sfx', { name: 'bell' });
  ok(caption.textContent.includes('BELL'), 'audio cue gets a text caption');
  ok(caption.classList.contains('is-on'), 'caption is visible while it lasts');
  hud.setCaptions(false);
  ok(!caption.classList.contains('is-on'), 'captions off hides the current line');
  bus.emit('sfx', { name: 'splash' });
  ok(!caption.classList.contains('is-on'), 'captions off suppresses new lines');
  hud.setCaptions(true);

  hud.setPaused(true);
  eq(document.getElementById('pi-hud').getAttribute('aria-hidden'), 'true', 'paused HUD leaves the accessibility tree');
  hud.setPaused(false);
  eq(document.getElementById('pi-hud').getAttribute('aria-hidden'), 'false', 'resumed HUD returns to the tree');

  document.getElementById('pi-minimap-canvas');
  hud.toggleMinimap();
  hud.update(0.2, { player: { speed: 6, heading: 1 }, hour: 18, feathers: { collected: 2, total: 40 }, discovered: {} });
  ok(true, 'HUD update runs with the marker-shape renderer');
  hud.destroy();
  eq(document.getElementById('pi-hud'), null, 'hud destroy removes the root');
}

// ---------------------------------------------------------------------------
section('8. camera honours reduceMotion / shakeIntensity / comfortFov');
// ---------------------------------------------------------------------------
{
  const THREE = await import('three');
  const makeCtx = (bus) => {
    const engine = { camera: new THREE.PerspectiveCamera(55, 1, 0.25, 2000), elapsed: 0 };
    const layout = { heightAt: () => 0 };
    const input = { axes: { steer: 0, throttle: 0, brake: 0 }, held: () => false, pointer: { wheel: 0 }, consumePointerDelta: () => ({ dx: 0, dy: 0 }) };
    return { engine, layout, input, bus };
  };
  const state = {
    player: {
      position: new THREE.Vector3(0, 0, 0), heading: 0, speed: 12, lean: 0, pitch: 0,
      crash: 0, wheelSpin: 0, boost: false,
    },
    camera: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), mode: 'chase', fov: 55, compassHeading: 0, photo: null },
    hour: 18,
  };

  // reduce motion: no shake, no fly-by, steady FOV
  {
    const bus = new EventBus();
    const cam = createCameraController(makeCtx(bus));
    cam.applyMotionSettings({ reduceMotion: true, comfortFov: true, autoCinematic: false, shakeIntensity: 'high' });
    eq(cam.motionSettings.shakeFactor, 0, 'reduceMotion forces the shake factor to 0');
    cam.setMode('chase');
    cam.update(0.016, state);
    const before = JSON.stringify(cam.motionSettings);
    cam.flyby(state.player.position, 7, 30);
    eq(cam.mode, 'chase', 'reduceMotion refuses the automatic fly-by');
    eq(JSON.stringify(cam.motionSettings), before, 'motion settings stay stable after a refused fly-by');
    cam.update(0.4, state); // let the chase rig settle
    cam.update(0.4, state);
    cam.update(0.4, state);
    cam.addShake(1.5);
    cam.update(0.05, state);
    const fovSamples = [state.camera.fov];
    for (let i = 0; i < 6; i++) {
      cam.update(0.05, state);
      fovSamples.push(state.camera.fov);
    }
    near(fovSamples[fovSamples.length - 1], fovSamples[0], 4.5, 'reduceMotion keeps the speed FOV nearly constant');
  }

  // default: high shake produces a visibly moving camera
  {
    const bus = new EventBus();
    const cam = createCameraController(makeCtx(bus));
    cam.applyMotionSettings({ reduceMotion: false, comfortFov: false, autoCinematic: true, shakeIntensity: 'high' });
    eq(cam.motionSettings.shakeFactor, 1, 'shakeIntensity "high" is a 1.0 multiplier');
    cam.setMode('chase');
    cam.update(0.016, state);
    cam.addShake(1);
    const positions = [];
    for (let i = 0; i < 8; i++) {
      cam.update(0.016, state);
      positions.push(state.camera.position.clone());
    }
    const spread = Math.max(...positions.map((p) => p.distanceTo(positions[0])));
    ok(spread > 0.001, `shake moves the camera (spread=${spread.toFixed(4)})`);
  }

  // settings arriving over the bus are applied live
  {
    const bus = new EventBus();
    const cam = createCameraController(makeCtx(bus));
    eq(cam.motionSettings.reduceMotion, false, 'motion defaults are neutral without a preference');
    bus.emit('settings:changed', { reduceMotion: true, shakeIntensity: 'off' });
    eq(cam.motionSettings.reduceMotion, true, 'settings:changed reaches the camera');
    eq(cam.motionSettings.shakeFactor, 0, 'live change disables shake immediately');
  }
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED CHECK(S):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nALL MOBILE TESTS PASSED');
}
assert.ok(true);
