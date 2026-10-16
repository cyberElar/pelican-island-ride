/**
 * tools/dev/test-engine.mjs - headless dev test for src/core/engine.js.
 *
 *   cd pelican-island-ride && node tools/dev/test-engine.mjs
 *
 * There is no GPU in Node, so the test uses jsdom plus a minimal WebGL2 stub
 * (enough for three r186's WebGLRenderer to initialise) and a manual
 * requestAnimationFrame queue so frames can be pumped deterministically.
 *
 * Covers:
 *   - the absolute pixel budget: 4K + DPR 2 must be clamped, never 30 MP
 *   - renderer/composer pixel-ratio sync on resize
 *   - start/stop and the webglcontextlost -> restored round trip
 */

import * as THREE from 'three';
import { JSDOM, VirtualConsole } from 'jsdom';
import { PIXEL_BUDGET, QUALITY_PRESETS } from '../../src/core/settings.js';

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

function near(actual, expected, tol, label) {
  return ok(
    Math.abs(actual - expected) <= tol,
    `${label} (got ${actual}, expected ${expected} ±${tol})`
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
// jsdom + manual rAF + WebGL2 stub
// ---------------------------------------------------------------------------
const virtualConsole = new VirtualConsole();
const jsdomErrors = [];
virtualConsole.on('jsdomError', (err) => jsdomErrors.push(err));

const dom = new JSDOM(
  '<!doctype html><html lang="zh-CN"><body><canvas id="game-canvas"></canvas></body></html>',
  { pretendToBeVisual: true, url: 'http://localhost/index.html', virtualConsole }
);
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

const rafQueue = new Map();
let rafSeq = 0;
function requestFrame(fn) {
  rafSeq += 1;
  rafQueue.set(rafSeq, fn);
  return rafSeq;
}
function cancelFrame(id) { rafQueue.delete(id); }
globalThis.requestAnimationFrame = requestFrame;
globalThis.cancelAnimationFrame = cancelFrame;
window.requestAnimationFrame = requestFrame;
window.cancelAnimationFrame = cancelFrame;

/** Run every queued animation frame once. */
function pump(frames = 1) {
  for (let f = 0; f < frames; f++) {
    const batch = [...rafQueue.values()];
    rafQueue.clear();
    for (const fn of batch) fn(performance.now());
  }
  return rafQueue.size;
}

function setViewport(width, height, dpr) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true, writable: true });
}

/**
 * Minimal WebGL2 stub: any `gl.foo()` is a no-op, GL constants are stable
 * integers and getParameter() answers the handful of values three inspects.
 */
function makeGlStub(canvas) {
  const consts = new Map();
  const params = new Map();
  let nextConst = 1;
  const constOf = (name) => {
    if (!consts.has(name)) consts.set(name, nextConst++);
    return consts.get(name);
  };
  const setParam = (name, value) => params.set(constOf(name), value);
  setParam('VERSION', 'WebGL 2.0 (pelican-stub)');
  setParam('VENDOR', 'pelican-stub');
  setParam('RENDERER', 'pelican-stub');
  setParam('SHADING_LANGUAGE_VERSION', 'WebGL GLSL ES 3.00 (pelican-stub)');
  setParam('SCISSOR_BOX', [0, 0, 8, 8]);
  setParam('VIEWPORT', [0, 0, 8, 8]);
  setParam('SAMPLES', 0);
  setParam('MAX_TEXTURE_SIZE', 4096);
  setParam('MAX_CUBE_MAP_TEXTURE_SIZE', 4096);
  setParam('MAX_SAMPLES', 4);

  const gl = new Proxy({}, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in target) return target[prop];
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return constOf(prop);
      const fn = (...args) => {
        if (prop === 'getParameter') return params.has(args[0]) ? params.get(args[0]) : 16;
        if (prop === 'getExtension') return null;
        if (prop === 'getSupportedExtensions') return [];
        if (prop === 'checkFramebufferStatus') return constOf('FRAMEBUFFER_COMPLETE');
        if (prop === 'getShaderPrecisionFormat') return { rangeMin: 127, rangeMax: 127, precision: 23 };
        if (prop === 'getContextAttributes') {
          return {
            alpha: false, antialias: false, depth: true, stencil: false,
            premultipliedAlpha: true, preserveDrawingBuffer: false,
            powerPreference: 'default', failIfMajorPerformanceCaveat: false,
          };
        }
        if (prop === 'getProgramParameter' || prop === 'getShaderParameter') return true;
        if (prop === 'getProgramInfoLog' || prop === 'getShaderInfoLog') return '';
        if (prop.startsWith('create') || prop.startsWith('getUniform')) return {};
        if (prop === 'canvas') return canvas;
        return undefined;
      };
      target[prop] = fn;
      return fn;
    },
  });
  canvas.getContext = (type) => (type === 'webgl2' ? gl : null);
  return gl;
}

const canvas = window.document.getElementById('game-canvas');
makeGlStub(canvas);

setViewport(1280, 720, 1);

const { createEngine } = await import('../../src/core/engine.js');

// ---------------------------------------------------------------------------
section('1. sizes, DPR cap and the pixel budget');
// ---------------------------------------------------------------------------
const engine = createEngine(canvas, { quality: 'high' });

eq(engine.sizes.width, 1280, 'sizes.width follows window.innerWidth');
eq(engine.sizes.height, 720, 'sizes.height follows window.innerHeight');
eq(engine.sizes.pixelRatio, 1, 'pixelRatio = min(dpr, cap) on a normal display');
near(engine.sizes.scale, QUALITY_PRESETS.high.renderScale, 1e-9, 'sizes.scale follows the preset render scale');

const oneToOne = engine.renderer.getDrawingBufferSize(new THREE.Vector2());
eq(oneToOne.x, 1280, 'drawing buffer width = css * scale * pixelRatio');
eq(oneToOne.y, 720, 'drawing buffer height = css * scale * pixelRatio');

// 4K panel at 200% scaling is the case that used to allocate 30+ MP targets.
setViewport(3840, 2160, 2);
window.dispatchEvent(new window.Event('resize'));
const scaled = engine.sizes;
const mp = scaled.width * scaled.height * scaled.scale * scaled.scale * scaled.pixelRatio * scaled.pixelRatio;
ok(scaled.pixelRatio < 2, `4K + DPR 2 lowers the effective pixel ratio (${scaled.pixelRatio.toFixed(3)})`);
ok(mp <= PIXEL_BUDGET * 1.02, `4K drawing buffer stays inside the pixel budget (${(mp / 1e6).toFixed(2)} MP)`);
near(scaled.width, 3840, 0, 'sizes.width tracks the new window');

const ultraEngine = createEngine(canvas, { quality: 'ultra' });
ok(
  ultraEngine.sizes.pixelRatio * ultraEngine.sizes.pixelRatio * ultraEngine.sizes.width * ultraEngine.sizes.height <= PIXEL_BUDGET * 1.02,
  'ultra preset is budget-clamped as well'
);
ok(
  ultraEngine.sizes.pixelRatio <= QUALITY_PRESETS.ultra.pixelRatioCap + 1e-9,
  `ultra pixel ratio respects its cap (${QUALITY_PRESETS.ultra.pixelRatioCap})`
);

// Back to a normal display for the lifecycle part.
setViewport(1024, 640, 1.5);
window.dispatchEvent(new window.Event('resize'));

// ---------------------------------------------------------------------------
section('2. post chain is wired and DPR-synced');
// ---------------------------------------------------------------------------
const postCalls = { setSize: 0, setPixelRatio: 0, render: 0, lastRatio: 0, lastW: 0, lastH: 0 };
const fakePost = {
  setSize(w, h) { postCalls.setSize++; postCalls.lastW = w; postCalls.lastH = h; },
  setPixelRatio(r) { postCalls.setPixelRatio++; postCalls.lastRatio = r; },
  render() { postCalls.render++; },
};
noThrow('engine.setPost(fake)', () => engine.setPost(fakePost));
ok(postCalls.setSize > 0, 'setPost() pushes the current size into the post chain');
near(postCalls.lastRatio, engine.sizes.pixelRatio, 1e-9, 'post pixel ratio matches the renderer');
near(postCalls.lastW, Math.round(engine.sizes.width * engine.sizes.scale), 0, 'post gets the logical (CSS * scale) width');

const rendersBefore = postCalls.render;
engine.render();
eq(postCalls.render, rendersBefore + 1, 'engine.render() delegates to post.render()');

const ratioBefore = postCalls.setPixelRatio;
setViewport(1600, 900, 2);
window.dispatchEvent(new window.Event('resize'));
// 1600x900 at DPR 2 is only 5.8 MP, so the budget does not bind here - the
// preset's own cap does. Both have to agree with the renderer.
const cappedRatio = Math.min(2, QUALITY_PRESETS.high.pixelRatioCap);
eq(engine.sizes.pixelRatio, cappedRatio, 'pixelRatio = min(dpr, preset cap) when the budget allows');
ok(postCalls.setPixelRatio > ratioBefore, 'resize re-syncs the composer pixel ratio (P2-5)');
near(postCalls.lastRatio, cappedRatio, 1e-9, 'composer pixel ratio follows the display');

// ---------------------------------------------------------------------------
section('3. start / stop and context loss round trip');
// ---------------------------------------------------------------------------
const events = { lost: 0, restored: 0, ticks: 0 };
engine.bus.on('context:lost', () => { events.lost++; });
engine.bus.on('context:restored', () => { events.restored++; });

engine.start(() => { events.ticks++; });
ok(engine.running, 'engine.start() marks the loop as running');
pump(3);
eq(events.ticks, 3, 'queued frames call the update function');
ok(!engine.contextLost, 'contextLost is false while the context is alive');

canvas.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true }));
eq(events.lost, 1, 'webglcontextlost emits context:lost on the bus');
eq(engine.running, false, 'a lost context stops the frame loop');
eq(engine.contextLost, true, 'engine.contextLost is set so callers can freeze timers');
const ticksAtLoss = events.ticks;
pump(3);
eq(events.ticks, ticksAtLoss, 'no frames run while the context is lost');

canvas.dispatchEvent(new window.Event('webglcontextrestored'));
eq(events.restored, 1, 'webglcontextrestored emits context:restored on the bus');
eq(engine.contextLost, false, 'contextLost is cleared on restore');
eq(engine.running, true, 'restoring the context restarts the loop');
pump(2);
eq(events.ticks, ticksAtLoss + 2, 'frames tick again after the restore');

engine.stop();
eq(engine.running, false, 'engine.stop() stops the loop');
const ticksAtStop = events.ticks;
pump(2);
eq(events.ticks, ticksAtStop, 'stopped engines do not tick');

// ---------------------------------------------------------------------------
section('4. stolen docs guard');
// ---------------------------------------------------------------------------
noThrow('engine.applySize() after a live resize is idempotent', () => {
  engine.applySize();
  engine.applySize();
});
ok(
  engine.sizes.pixelRatio > 0 && isFinite(engine.sizes.pixelRatio),
  'pixel ratio stays a positive finite number'
);

if (jsdomErrors.length) {
  console.log(`\njsdom reported ${jsdomErrors.length} handled warning(s), e.g. ${jsdomErrors[0].message}`);
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED CHECK(S):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nALL ENGINE TESTS PASSED');
}
