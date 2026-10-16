/**
 * engine.js - renderer / scene / camera / loop bootstrap.
 * Owns nothing game-specific: modules are attached by main.js.
 */

import * as THREE from 'three';
import { EventBus, clamp } from './utils.js';
import { QUALITY_PRESETS, GAME, PIXEL_BUDGET } from './settings.js';

export function createEngine(canvas, { quality = 'high' } = {}) {
  const preset = { ...(QUALITY_PRESETS[quality] || QUALITY_PRESETS.high) };
  // ?preserve=1 keeps the drawing buffer alive so headless screenshot tools
  // can capture the canvas reliably (harmless, tiny perf cost).
  let preserve = false;
  try {
    preserve = new URLSearchParams(window.location.search).has('preserve');
  } catch { /* ignore */ }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: preserve,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  renderer.shadowMap.enabled = preset.shadows;
  // r186 removed PCFSoftShadowMap; PCF + a soft radius is the closest match.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x0b1016, 1);
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xbfd6e4, preset.fogDensity);
  scene.matrixWorldAutoUpdate = true;

  const camera = new THREE.PerspectiveCamera(55, 1, 0.25, preset.viewDistance);
  camera.position.set(0, 60, 120);

  const world = new THREE.Group();
  world.name = 'world';
  scene.add(world);

  const skyGroup = new THREE.Group();
  skyGroup.name = 'sky';
  scene.add(skyGroup);

  const bus = new EventBus();
  // NOTE: THREE.Clock is deprecated in r186 - use a plain high-res timer.
  let lastTime = performance.now();

  const sizes = {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: 1,
    scale: preset.renderScale,
  };

  const resizeFns = [];
  let post = null;
  let running = false;
  let contextLost = false;
  let updateFn = null;
  let rafId = 0;
  let elapsed = 0;

  function applySize() {
    const w = Math.max(320, window.innerWidth);
    const h = Math.max(240, window.innerHeight);
    sizes.width = w;
    sizes.height = h;
    sizes.scale = preset.renderScale;
    // Absolute pixel budget: the drawing buffer (and every composer render
    // target) is w*scale × h*scale × pixelRatio, so clamp the effective pixel
    // ratio when the requested buffer would blow past PIXEL_BUDGET pixels.
    const budgetRatio = Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h * sizes.scale * sizes.scale));
    sizes.pixelRatio = Math.max(0.25, Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap, budgetRatio));
    const rw = Math.max(2, Math.round(w * sizes.scale));
    const rh = Math.max(2, Math.round(h * sizes.scale));
    renderer.setPixelRatio(sizes.pixelRatio);
    renderer.setSize(rw, rh, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Keep the composer's internal buffers on the same DPR as the renderer,
    // otherwise the intermediate targets drift after a monitor change.
    if (post && post.setPixelRatio) post.setPixelRatio(sizes.pixelRatio);
    if (post && post.setSize) post.setSize(rw, rh, w, h);
    for (const fn of resizeFns) fn(sizes, camera, renderer);
  }

  window.addEventListener('resize', applySize);
  window.addEventListener('orientationchange', () => setTimeout(applySize, 120));
  applySize();

  function setQuality(level) {
    const next = QUALITY_PRESETS[level];
    if (!next) return;
    Object.assign(preset, next);
    engine.qualityLevel = level;
    renderer.shadowMap.enabled = preset.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMappingExposure = 1.06;
    if (scene.fog) scene.fog.density = preset.fogDensity;
    camera.far = preset.viewDistance;
    camera.updateProjectionMatrix();
    applySize();
    bus.emit('quality:changed', { level });
  }

  function render() {
    if (post) post.render(elapsed);
    else renderer.render(scene, camera);
  }

  function frame() {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = clamp((now - lastTime) / 1000, 0, 0.1);
    lastTime = now;
    elapsed += dt;
    if (updateFn) updateFn(dt, elapsed);
    render();
  }

  const engine = {
    renderer,
    scene,
    camera,
    world,
    skyGroup,
    bus,
    sizes,
    preset,
    qualityLevel: quality,
    get elapsed() { return elapsed; },
    get running() { return running; },
    get contextLost() { return contextLost; },
    setQuality,
    setPost(p) {
      post = p;
      if (!post) return;
      if (post.setPixelRatio) post.setPixelRatio(sizes.pixelRatio);
      if (post.setSize) post.setSize(Math.round(sizes.width * sizes.scale), Math.round(sizes.height * sizes.scale), sizes.width, sizes.height);
    },
    get post() { return post; },
    onResize(fn) { resizeFns.push(fn); return () => { const i = resizeFns.indexOf(fn); if (i >= 0) resizeFns.splice(i, 1); }; },
    applySize,
    start(fn) {
      updateFn = fn;
      if (running) return;
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
    render,
  };

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    engine.stop();
    bus.emit('context:lost');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    bus.emit('context:restored');
    if (updateFn) engine.start(updateFn);
  });

  bus.emit('engine:ready', { preset: GAME });
  return engine;
}
