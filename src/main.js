/**
 * main.js - boot, staged world construction, the frame loop and all the
 * glue between gameplay, world modules, UI and audio.
 *
 * Integration contract: every module comes from registry.js as
 *   { group?, update(dt, state), setQuality?(level), colliders?, ... }
 */

// Named imports only: passing the whole namespace through `ctx` used to keep
// every three.js export (and its dead code) in the bundle.
import { Vector3, Quaternion, Color } from 'three';
import { createEngine } from './core/engine.js';
import { createTextureLibrary } from './core/textures.js';
import { createLayout } from './world/layout.js';
import { createInput } from './core/input.js';
import { createPost } from './fx/post.js';
import { createHUD } from './ui/hud.js';
import { createMenus } from './ui/menus.js';
import { createTouchControls } from './ui/touch.js';
import { worldModuleList } from './registry.js';
import { DISCOVERABLE } from './gameplay/events.js';
import { GAME, QUALITY_PRESETS, detectQuality } from './core/settings.js';
import { Rng, clamp01 } from './core/utils.js';

/**
 * Yield to the browser so the boot progress bar can repaint. Falls back to a
 * timer because some headless/background environments throttle rAF.
 */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 24);
});

const MODULE_LABELS = {
  sky: '绘制天空', terrain: '雕琢山脉与海岸', environment: '点亮阳光',
  ocean: '注入海水与湖泊', vegetation: '播种森林与草地', props: '建造海风村与港口',
  landmarks: '竖立灯塔与巨石', animals: '放飞海鸥与蝴蝶', particles: '扬起花粉与薄雾',
  weather: '调转风向与云层', camera: '校准镜头', controls: '调校单车', rider: '唤醒提鹅鹏',
  collectibles: '藏好金色羽毛', events: '编写岛屿故事', audio: '谱曲与浪声',
};

/**
 * Lightweight, dependency-free error strip. `index.html` ships the same
 * element id for errors that happen before this module even loads.
 */
function showErrorBar(message) {
  try {
    if (typeof document === 'undefined' || !document.body) return;
    let bar = document.getElementById('pi-error-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'pi-error-bar';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2000',
        'padding:8px 14px', 'background:rgba(122,28,28,0.92)', 'color:#ffe9d6',
        'font:12px/1.6 ui-monospace,Consolas,monospace', 'text-align:center',
        'pointer-events:none', 'white-space:pre-wrap', 'word-break:break-word',
      ].join(';');
      document.body.appendChild(bar);
    }
    bar.textContent = String(message).slice(0, 500);
  } catch { /* the error reporter must never throw */ }
}

async function boot() {
  // Keep whatever the inline boot-time listeners already collected.
  const priorPelican = window.__pelican || {};
  window.__pelican = {
    ...priorPelican,
    ready: false,
    booting: true,
    moduleErrors: Array.isArray(priorPelican.moduleErrors) ? priorPelican.moduleErrors : [],
  };
  const progress = { stage: 'boot', i: 0, total: 0, label: '' };
  window.__pelicanProgress = progress;

  // Boot-stage stopwatch: printed once at the end and exposed on
  // __pelican.bootStages so screenshot runs can report where time goes.
  const bootStages = [];
  let lastMark = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  const mark = (name) => {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : lastMark;
    bootStages.push({ name, ms: Math.round(now - lastMark) });
    lastMark = now;
  };

  const params = new URLSearchParams(location.search);
  const seedParam = params.get('seed');
  const seed = seedParam ? (Number(seedParam) || GAME.defaultSeed) : GAME.defaultSeed;
  const qParam = params.get('quality');
  const quality = (qParam && QUALITY_PRESETS[qParam]) ? qParam : detectQuality();

  const canvas = document.getElementById('game-canvas');
  const uiRoot = document.getElementById('ui-root');
  const bootBar = document.getElementById('boot-bar');
  const bootLabel = document.getElementById('boot-label');
  const bootOverlay = document.getElementById('boot-overlay');

  const setProgress = (p01, label) => {
    if (bootBar) bootBar.style.width = `${Math.round(p01 * 100)}%`;
    if (bootLabel && label) bootLabel.textContent = label;
  };

  // ---------------------------------------------------------------- engine
  const engine = createEngine(canvas, { quality });
  const textures = createTextureLibrary(quality, engine.renderer);
  const layout = createLayout(seed);
  mark('setup');
  const bus = engine.bus;
  const input = createInput(canvas);

  const state = {
    t: 0,
    dt: 0,
    hour: GAME.defaultHour,
    dayLength: GAME.dayLengthSeconds,
    timeScale: 1,
    autoAdvanceTime: true,
    quality,
    started: false,
    paused: false,
    photoMode: false,
    muted: false,
    compassHeading: 0,
    player: {
      position: new Vector3(),
      velocity: new Vector3(),
      heading: 0,
      speed: 0,
      steer: 0,
      lean: 0,
      wheelSpin: 0,
      pitch: 0,
      slope: 0,
      onRoad: true,
      surface: 'asphalt',
      grounded: true,
      inWater: false,
      boost: false,
      boostStamina: 1,
      crash: 0,
      airTime: 0,
      distanceTravelled: 0,
      splashCooldown: 0,
      brake: 0,
    },
    camera: {
      position: new Vector3(),
      quaternion: new Quaternion(),
      mode: 'tour',
      fov: 55,
      compassHeading: 0,
      photo: null,
    },
    feathers: { collected: 0, total: GAME.featherCount },
    discovered: Object.create(null),
    race: { active: false, checkpoint: 0, time: 0, best: null, finished: false, countdown: 0 },
    wind: { x: 0.7, z: 0.5, strength: 0.35, gust: 0 },
    weather: { rain: 0, cloudiness: 0.35, fogBoost: 0 },
    sun: { dir: new Vector3(0.3, 0.5, 0.8), color: new Color('#fff4e2'), intensity: 3 },
    moon: { dir: new Vector3(-0.3, 0.5, -0.8), intensity: 0 },
    events: [],
  };

  const ctx = {
    engine, layout, textures, bus, state, input, quality,
    rng: new Rng(`root:${seed}`),
    colliders: [],
  };

  // ------------------------------------------------------------- minimap io
  const minimapRoad = [];
  {
    const s = layout.roadSamples;
    const n = s.length / 3;
    for (let i = 0; i < n; i += 5) minimapRoad.push({ x: s[i * 3], z: s[i * 3 + 2] });
  }
  // The minimap and the HUD denominator use exactly the list events.js can
  // actually discover (audit D2: 25 discoverable, not 28).
  const discoverableIds = new Set(DISCOVERABLE.map(([id]) => id));
  const minimapPoiBase = Object.values(layout.pois)
    .filter((p) => discoverableIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, x: p.position.x, z: p.position.z, type: p.type }));
  state.discoverableTotal = minimapPoiBase.length;
  function minimapData() {
    return {
      heightTexture: ctx.heightTexture || null,
      size: layout.WORLD_SIZE,
      road: minimapRoad,
      pois: minimapPoiBase.map((p) => ({ ...p, discovered: !!state.discovered[p.id] })),
      player: { x: state.player.position.x, z: state.player.position.z, heading: state.player.heading },
    };
  }

  // ------------------------------------------------------------------- UI
  let hud = { update() {}, toast() {}, discovery() {}, setLetterbox() {}, setPhotoMode() {}, setPaused() {}, setLoading() {}, setRace() {}, flashDamage() {}, setCompassHeading() {}, toggleMinimap() { return false; }, setCameraMode() {}, setDiscoveredTotal() {}, togglePhotoGrid() {}, destroy() {}, root: null };

  const menus = createMenus(ctx, {
    container: uiRoot,
    onStart,
    onResume,
    onSettingsChange,
    onQuitToTitle,
    onResetProgress: resetGameplayProgress,
  });

  hud = createHUD(ctx, { container: uiRoot, minimapData });
  hud.setDiscoveredTotal?.(minimapPoiBase.length);

  // Virtual pad for touch devices; it drives the same input API as the
  // keyboard and stays hidden everywhere else.
  const touch = createTouchControls(input, { container: uiRoot, bus, window, document });

  // -------------------------------------------------------- staged build
  const modules = {};
  const list = worldModuleList();
  const totalSteps = list.length + 1;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const label = MODULE_LABELS[entry.id] || entry.id;
    progress.stage = entry.id;
    progress.i = i;
    progress.total = totalSteps;
    progress.label = label;
    setProgress(i / totalSteps, `正在生成小岛 · ${label}`);
    await nextFrame();
    try {
      const instance = await entry.factory(ctx);
      mark(entry.id);
      modules[entry.id] = instance;
      ctx[entry.id] = instance;
      if (instance && instance.group) {
        if (entry.kind === 'sky') engine.skyGroup.add(instance.group);
        else engine.world.add(instance.group);
      }
      if (instance?.colliders?.length) ctx.colliders.push(...instance.colliders);
      if (instance?.treeColliders?.length) ctx.colliders.push(...instance.treeColliders);
      if (instance?.heightTexture && !ctx.heightTexture) ctx.heightTexture = instance.heightTexture;
    } catch (err) {
      console.error(`[pelican] module "${entry.id}" failed to build`, err);
      // The bus toast listener is not wired yet at this point, so report
      // straight to the DOM (and to CI through window.__pelican).
      window.__pelican.moduleErrors.push({ id: entry.id, message: String(err?.message || err) });
      hud.toast?.('模块加载失败', entry.id);
    }
  }

  if (window.__pelican.moduleErrors.length) {
    const failed = window.__pelican.moduleErrors.map((e) => e.id).join(', ');
    showErrorBar(`模块加载失败: ${failed} — 详见控制台 · MODULE BUILD FAILED`);
  }

  // late wiring: props/landmarks emitters feed the particle system
  // Defensive normalisation: three r186's WebGLShadowMap treats
  // `customDepthMaterial !== undefined` as "custom material present" and then
  // dereferences it, so a module that parks `null` there would crash the
  // shadow pass every frame.
  engine.world.traverse((o) => {
    if (o.customDepthMaterial === null) o.customDepthMaterial = undefined;
    if (o.customDistanceMaterial === null) o.customDistanceMaterial = undefined;
  });

  if (modules.particles?.registerEmitter) {
    for (const src of [modules.props, modules.landmarks]) {
      const emitters = [...(src?.chimneys || []), ...(src?.emitters || [])];
      for (const e of emitters) {
        try { modules.particles.registerEmitter(e.x, e.y, e.z, e.type || 'smoke', e.rate ?? 1); } catch { /* ignore */ }
      }
    }
    // camp fire + village chimney defaults even if props missed them
    const camp = layout.pois.camp?.position;
    if (camp) modules.particles.registerEmitter(camp.x, camp.y + 1.0, camp.z, 'fire', 1.0);
  }
  mark('wiring');

  setProgress((totalSteps - 1) / totalSteps, '正在生成小岛 · 装配镜头后期');
  progress.stage = 'post';
  await nextFrame();
  const post = createPost(engine, ctx);
  mark('post');
  ctx.post = post;
  const postRender = post.render.bind(post);
  post.render = (dt) => postRender(dt, state);
  engine.setPost(post);

  setProgress(1, '准备就绪');
  progress.stage = 'ready';
  mark('ready');
  console.log('[pelican] boot stages: ' + bootStages.map((s) => `${s.name}=${s.ms}ms`).join(' '));

  if (modules.controls?.spawn) modules.controls.spawn(state);
  engine.camera.position.copy(state.player.position).add(new Vector3(0, 40, -60));
  bus.emit('quality:changed', { level: quality });

  // ------------------------------------------------------------- helpers
  // The camera module owns its mode machine; keeping a second index here used
  // to desync after auto fly-bys and photo mode (audit D5).
  function setCamera(mode) {
    modules.camera?.setMode(mode);
  }

  // Photo-mode filters (audit D8): real grade presets, not just a label.
  const PHOTO_HINT = '滚轮变焦 · F 网格 · V 滤镜 · X 导出 · P 退出';
  const PHOTO_FILTERS = [
    { zh: '原片', en: 'ORIGINAL', grade: null },
    { zh: '海风胶片', en: 'SEA FILM', grade: { saturation: 1.06, contrast: 1.12, lift: 0.03, grain: 0.22, tint: [0.99, 1.0, 1.045] } },
    { zh: '金色时刻', en: 'GOLDEN HOUR', grade: { saturation: 1.26, contrast: 1.07, lift: 0.008, grain: 0.1, tint: [1.06, 1.0, 0.9] } },
    { zh: '银盐黑白', en: 'SILVER MONO', grade: { saturation: 0, contrast: 1.2, lift: 0.02, grain: 0.35, tint: [1, 1, 1] } },
  ];
  let photoFilterIndex = 0;

  function photoFilterLabel() {
    const f = PHOTO_FILTERS[photoFilterIndex];
    return `${f.zh} · ${f.en}`;
  }

  function applyPhotoFilter() {
    post.setPhotoFilter?.(state.photoMode ? PHOTO_FILTERS[photoFilterIndex].grade : null);
  }

  function cyclePhotoFilter(step = 1) {
    photoFilterIndex = (photoFilterIndex + step + PHOTO_FILTERS.length) % PHOTO_FILTERS.length;
    applyPhotoFilter();
    if (state.photoMode) {
      hud.setPhotoMode?.(true, {
        fov: modules.camera?.photo?.fov ?? 45,
        filterName: photoFilterLabel(),
        hint: PHOTO_HINT,
      });
      const f = PHOTO_FILTERS[photoFilterIndex];
      hud.toast?.(`滤镜 · ${f.zh}`, f.en);
    }
  }

  /** PNG export of the current frame (audit D8: photo mode never saved). */
  function exportPhoto() {
    try {
      // Re-render inside this task so the drawing buffer is readable even when
      // the canvas was created without preserveDrawingBuffer.
      try { engine.render?.(); } catch { /* fall through and try anyway */ }
      const canvas = (engine.renderer && engine.renderer.domElement) || document.getElementById('game-canvas');
      if (!canvas || typeof canvas.toBlob !== 'function') return;
      canvas.toBlob((blob) => {
        if (!blob) return;
        try {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `pelican-island-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          hud.toast?.('照片已导出', 'PHOTO SAVED');
          bus.emit('sfx', { name: 'pickup', volume: 0.8 });
        } catch (err) {
          console.error('[pelican] photo save failed', err);
        }
      }, 'image/png');
    } catch (err) {
      console.error('[pelican] photo export failed', err);
    }
  }

  function enterPhotoMode(on) {
    state.photoMode = !!on;
    if (state.photoMode) {
      modules.camera?.setMode('photo');
      post.setMode('photo');
      applyPhotoFilter();
      hud.setPhotoMode?.(true, {
        fov: modules.camera?.photo?.fov ?? 45,
        filterName: photoFilterLabel(),
        hint: PHOTO_HINT,
      });
      hud.setLetterbox?.(false);
    } else {
      post.setMode('ride');
      post.setPhotoFilter?.(null);
      hud.setPhotoMode?.(false, null);
      setCamera('chase');
    }
  }

  function togglePause(on) {
    const next = typeof on === 'boolean' ? on : !state.paused;
    state.paused = next;
    input.enabled = !next;
    if (next) menus.show('pause');
    else if (menus.current !== 'title') menus.show('none');
  }

  function applyTimeMode(mode) {
    const presets = { dawn: 5.5, noon: 12.4, sunset: 17.4, night: 22.2 };
    if (mode === 'cycle') {
      state.autoAdvanceTime = true;
    } else if (presets[mode] !== undefined) {
      state.autoAdvanceTime = false;
      state.hour = presets[mode];
      modules.camera?.setMode(state.photoMode ? 'photo' : modules.camera.mode);
    }
  }

  // ----------------------------------------------- first-run tutorial (C3)
  // Three contextual goals for a fresh save. Non-blocking: the strip simply
  // sits in the HUD column until each goal happens, and completion is
  // remembered per browser so returning riders never see it again.
  const TUTORIAL_KEY = 'pelicanIsland.tutorialDone';
  const TUTORIAL_STEPS = [
    { id: 'go', zh: '按住 W 加速出发', en: 'Hold W to set off' },
    { id: 'bell', zh: '按 B 摇一次车铃', en: 'Ring the bell once (B)' },
    { id: 'feather', zh: '沿路收集一根金色羽毛', en: 'Collect a golden feather' },
  ];
  let tutorialStep = -1;
  let tutorialDone = false;
  try { tutorialDone = localStorage.getItem(TUTORIAL_KEY) === '1'; } catch { /* ignore */ }

  function applyTutorialStep() {
    if (tutorialDone || tutorialStep < 0 || tutorialStep >= TUTORIAL_STEPS.length) {
      hud.setTutorial?.(null);
      return;
    }
    const step = TUTORIAL_STEPS[tutorialStep];
    hud.setTutorial?.({ zh: step.zh, en: step.en, index: tutorialStep + 1, total: TUTORIAL_STEPS.length });
  }

  function tutorialAdvance(id) {
    if (tutorialDone || tutorialStep < 0 || tutorialStep >= TUTORIAL_STEPS.length) return;
    if (TUTORIAL_STEPS[tutorialStep].id !== id) return;
    tutorialStep += 1;
    if (tutorialStep >= TUTORIAL_STEPS.length) {
      tutorialDone = true;
      try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch { /* ignore */ }
      hud.setTutorial?.(null);
      hud.toast?.('教学完成 · 自由骑行', 'TUTORIAL COMPLETE');
      return;
    }
    applyTutorialStep();
  }

  // --------------------------------------- debug overlay (?debug=1)
  // fps / frame time / draw calls / triangles / geometry + texture counts,
  // refreshed four times a second; also handy for headless perf probes.
  let debugEl = null;
  let debugAcc = 0;
  let debugFps = 0;
  if (params.get('debug') === '1') {
    debugEl = document.createElement('div');
    debugEl.id = 'pi-debug';
    debugEl.setAttribute('data-testid', 'debug-overlay');
    debugEl.style.cssText = [
      'position:fixed', 'left:10px', 'bottom:10px', 'z-index:1999',
      'padding:6px 10px', 'border-radius:6px',
      'background:rgba(10,14,24,0.72)', 'color:#cfe0ee',
      'font:11px/1.55 Consolas,ui-monospace,monospace',
      'white-space:pre', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(debugEl);
  }

  function updateDebugOverlay(dt) {
    if (!debugEl) return;
    const inst = 1 / Math.max(dt, 1e-4);
    debugFps = debugFps ? debugFps * 0.9 + inst * 0.1 : inst;
    debugAcc += dt;
    if (debugAcc < 0.25) return;
    debugAcc = 0;
    const info = engine.renderer && engine.renderer.info;
    const r = (info && info.render) || {};
    const mem = (info && info.memory) || {};
    let heap = '';
    if (typeof performance !== 'undefined' && performance.memory) {
      heap = `\nheap ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} / ${(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB`;
    }
    debugEl.textContent =
      `fps ${debugFps.toFixed(0)}   frame ${(dt * 1000).toFixed(1)} ms\n` +
      `calls ${r.calls != null ? r.calls : '-'}   tris ${r.triangles != null ? Math.round(r.triangles / 1000) + 'k' : '-'}\n` +
      `geo ${mem.geometries != null ? mem.geometries : '-'}   tex ${mem.textures != null ? mem.textures : '-'}   prog ${info && info.programs ? info.programs.length : '-'}` +
      heap;
  }

  function onStart(mode) {
    state.started = true;
    input.enabled = true; // quitting to title used to leave input locked (P0-3)
    menus.show('none');
    modules.audio?.init?.();
    if (mode === 'photo') {
      enterPhotoMode(true);
      modules.camera?.setMode('photo');
    } else {
      state.photoMode = false;
      modules.controls?.spawn?.(state);
      setCamera('chase');
      bus.emit('sfx', { name: 'discovery', volume: 0.6 });
      hud.toast?.('开始骑行', '按住 W 加速 · C 切换相机 · M 地图');
    }
    // First-run tutorial: resume (or hide) whenever a ride starts.
    if (mode !== 'photo') {
      if (!tutorialDone && tutorialStep < 0) tutorialStep = 0;
      applyTutorialStep();
    }
    void mode;
  }

  function onResume() {
    togglePause(false);
  }

  function onQuitToTitle() {
    state.started = false;
    state.paused = false;
    input.enabled = true;
    enterPhotoMode(false);
    modules.camera?.setMode('tour');
    menus.show('title');
    hud.setTutorial?.(null);
  }

  /** Settings > RESET PROGRESS: clear feathers and discoveries for this seed. */
  function resetGameplayProgress() {
    modules.events?.stopRace?.();
    modules.collectibles?.resetProgress?.();
    modules.events?.resetProgress?.();
    hud.update?.(0, state);
    hud.toast?.('探索进度已重置', 'Exploration progress reset');
  }

  const SETTINGS_KEY = 'pelicanIsland.settings';
  const SETTINGS_VERSION = 1;
  const TIME_MODES = ['dawn', 'noon', 'sunset', 'night', 'cycle'];
  const VOLUME_KEYS = ['masterVolume', 'musicVolume', 'sfxVolume'];

  /**
   * Field-by-field whitelist: anything unknown, mistyped or out of range is
   * dropped instead of silently accepted (see audit P2-9).
   */
  function sanitizeSettings(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.quality === 'string' && QUALITY_PRESETS[raw.quality]) out.quality = raw.quality;
    if (typeof raw.timeMode === 'string' && TIME_MODES.includes(raw.timeMode)) out.timeMode = raw.timeMode;
    if (raw.language === 'zh' || raw.language === 'en') out.language = raw.language;
    for (const key of VOLUME_KEYS) {
      const v = raw[key];
      if (typeof v === 'number' && isFinite(v)) out[key] = clamp01(v);
    }
    if (typeof raw.muted === 'boolean') out.muted = raw.muted;
    // Comfort / accessibility switches: without these the menu forgets every
    // toggle on reload (mobile a11y report, section 3).
    const SHAKE_LEVELS = ['off', 'low', 'medium', 'high'];
    if (typeof raw.shakeIntensity === 'string' && SHAKE_LEVELS.includes(raw.shakeIntensity)) out.shakeIntensity = raw.shakeIntensity;
    if (typeof raw.comfortFov === 'boolean') out.comfortFov = raw.comfortFov;
    if (typeof raw.reduceMotion === 'boolean') out.reduceMotion = raw.reduceMotion;
    if (typeof raw.autoCinematic === 'boolean') out.autoCinematic = raw.autoCinematic;
    if (typeof raw.captions === 'boolean') out.captions = raw.captions;
    if (typeof raw.uiScale === 'number' && isFinite(raw.uiScale)) {
      out.uiScale = Math.max(0.85, Math.min(1.35, raw.uiScale));
    }
    return out;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      // v1 stores { v, data }; the pre-v1 shape was a flat object.
      const body = (parsed.v === SETTINGS_VERSION && parsed.data && typeof parsed.data === 'object')
        ? parsed.data
        : parsed;
      const clean = sanitizeSettings(body);
      return Object.keys(clean).length ? clean : null;
    } catch { /* ignore */ }
    return null;
  }
  function saveSettings(patch) {
    try {
      const cur = loadSettings() || {};
      const data = sanitizeSettings({ ...cur, ...patch });
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ v: SETTINGS_VERSION, data }));
    } catch { /* ignore */ }
  }

  function onSettingsChange(patch) {
    if (!patch) return;
    if (patch.quality && QUALITY_PRESETS[patch.quality]) {
      state.quality = patch.quality;
      engine.setQuality(patch.quality);
      post.setQuality(patch.quality);
      for (const m of Object.values(modules)) m?.setQuality?.(patch.quality);
    }
    if (typeof patch.masterVolume === 'number') modules.audio?.setMasterVolume?.(patch.masterVolume);
    if (typeof patch.musicVolume === 'number') modules.audio?.setMusicVolume?.(patch.musicVolume);
    if (typeof patch.sfxVolume === 'number') modules.audio?.setSfxVolume?.(patch.sfxVolume);
    if (typeof patch.muted === 'boolean') {
      state.muted = patch.muted;
      modules.audio?.setMuted?.(patch.muted);
    }
    if (patch.timeMode) applyTimeMode(patch.timeMode);
    // Motion comfort reaches the camera directly as well (menus also
    // broadcasts `settings:changed`, which camera.js listens to).
    if (patch.shakeIntensity !== undefined || patch.comfortFov !== undefined
      || patch.reduceMotion !== undefined || patch.autoCinematic !== undefined) {
      modules.camera?.applyMotionSettings?.(patch);
    }
    saveSettings(patch);
  }

  // restore saved settings and mirror them into the menu UI
  {
    const saved = loadSettings();
    if (saved) {
      if (saved.quality && !qParam) {
        state.quality = saved.quality;
        engine.setQuality(saved.quality);
        post.setQuality(saved.quality);
        for (const m of Object.values(modules)) m?.setQuality?.(saved.quality);
      }
      if (saved.timeMode) {
        state._timePreset = saved.timeMode;
        applyTimeMode(saved.timeMode);
      }
      if (typeof saved.masterVolume === 'number') modules.audio?.setMasterVolume?.(saved.masterVolume);
      if (typeof saved.musicVolume === 'number') modules.audio?.setMusicVolume?.(saved.musicVolume);
      if (typeof saved.sfxVolume === 'number') modules.audio?.setSfxVolume?.(saved.sfxVolume);
      if (typeof saved.muted === 'boolean') {
        state.muted = saved.muted;
        modules.audio?.setMuted?.(saved.muted);
      }
      menus.setSettings?.(saved);
    }
  }

  // audio: unlock on the first user gesture no matter what
  const unlock = () => { modules.audio?.init?.(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // fade-in the title screen
  if (bootOverlay) {
    bootOverlay.classList.add('is-done');
    setTimeout(() => bootOverlay.remove(), 900);
  }
  menus.show('title');
  modules.camera?.setMode('tour');

  bus.on('sfx', () => { /* audio module listens to the bus itself */ });
  bus.on('ui:toast', (p) => hud.toast?.(p?.title ?? '', p?.sub ?? ''));
  bus.on('photo:filter', () => cyclePhotoFilter(1));
  bus.on('photo:save', () => exportPhoto());
  bus.on('feather:collected', () => tutorialAdvance('feather'));
  bus.on('poi:discovered', (p) => {
    if (p?.position) hud.setLetterbox?.(true);
  });
  bus.on('rider:crash', () => hud.flashDamage?.());
  // Finish presentation (audit P1): the director camera orbits the rider, the
  // letterbox holds the moment and confetti fires; real input hands control
  // straight back so the player is never locked in.
  const fmtTime = (t) => {
    const secs = Math.max(0, Number(t) || 0);
    const m = Math.floor(secs / 60);
    return m + ':' + (secs - m * 60).toFixed(1).padStart(4, '0');
  };
  let finishShow = 0;
  bus.on('race:finish', (p) => {
    const total = state.race.total || 0;
    hud.setRace?.({ checkpoint: total, total, time: p.time, best: p.best, finished: true, newRecord: p.record });
    finishShow = 7.5;
    hud.setLetterbox?.(true);
    const at = state.player.position;
    // Cut to a celebration angle near the rider; the director's idle orbit
    // takes over from there (without the cut it would spend ~3 s travelling
    // from wherever the camera happened to be, usually the tour spline).
    const fx = Math.sin(state.player.heading);
    const fz = Math.cos(state.player.heading);
    engine.camera.position.set(at.x - fx * 9 + fz * 7, at.y + 3.6, at.z - fz * 9 - fx * 7);
    modules.camera?.setMode('cinematic');
    const popConfetti = () => {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.6;
        modules.particles?.bursts?.confetti?.(at.x + Math.cos(a) * 1.4, at.y + 2.2 + i * 0.35, at.z + Math.sin(a) * 1.4);
      }
      modules.particles?.bursts?.sparkle?.(at.x, at.y + 1.6, at.z, 32);
    };
    popConfetti();
    setTimeout(popConfetti, 450);
    bus.emit('sfx', { name: 'firework', volume: 0.9 });
    if (p.record) hud.toast?.('新纪录 ' + fmtTime(p.time), 'NEW RECORD ' + fmtTime(p.time));
    else hud.toast?.('完赛 ' + fmtTime(p.time), 'FINISHED ' + fmtTime(p.time));
  });
  // "重置视角" in the settings menu emits this; the camera module's existing
  // reset capability is snapping back to the chase rig.
  bus.on('player:reset', () => {
    if (!state.started || state.photoMode) return;
    setCamera('chase');
  });

  // ------------------------------------------------ graphics context loss
  const CONTEXT_LOST_TEXT = '图形上下文丢失，正在恢复…';
  const CONTEXT_FAILED_TEXT = '图形上下文恢复失败，请刷新页面';
  let contextWatchdog = 0;
  let contextMsg = null;
  let contextBtn = null;

  function ensureContextOverlay() {
    try {
      if (typeof document === 'undefined' || !document.body) return null;
      const existing = document.getElementById('pi-context-overlay');
      if (existing) return existing;
      const overlay = document.createElement('div');
      overlay.id = 'pi-context-overlay';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:1500', 'display:grid', 'place-items:center',
        'background:rgba(7,10,18,0.88)', 'color:#f2e8d5', 'text-align:center', 'padding:24px',
        'font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",STSong,serif',
      ].join(';');
      const card = document.createElement('div');
      contextMsg = document.createElement('div');
      contextMsg.style.cssText = 'font-size:17px;letter-spacing:0.16em;line-height:1.8';
      const sub = document.createElement('div');
      sub.style.cssText = 'margin-top:12px;font-size:11px;letter-spacing:0.32em;opacity:0.55';
      sub.textContent = 'GRAPHICS CONTEXT';
      contextBtn = document.createElement('button');
      contextBtn.type = 'button';
      contextBtn.textContent = '刷新页面 · RELOAD';
      contextBtn.style.cssText = [
        'display:none', 'margin:22px auto 0', 'padding:10px 22px', 'cursor:pointer',
        'border:1px solid rgba(242,232,213,0.45)', 'background:transparent', 'color:#f2e8d5',
        'font-family:inherit', 'font-size:13px', 'letter-spacing:0.22em',
      ].join(';');
      contextBtn.addEventListener('click', () => { try { location.reload(); } catch { /* ignore */ } });
      card.appendChild(contextMsg);
      card.appendChild(sub);
      card.appendChild(contextBtn);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      return overlay;
    } catch {
      return null;
    }
  }

  function showContextOverlay(message, canReload) {
    const overlay = ensureContextOverlay();
    if (!overlay) return;
    if (contextMsg) contextMsg.textContent = message;
    if (contextBtn) contextBtn.style.display = canReload ? 'block' : 'none';
  }

  function hideContextOverlay() {
    try {
      const overlay = document.getElementById('pi-context-overlay');
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    } catch { /* ignore */ }
    contextMsg = null;
    contextBtn = null;
  }

  bus.on('context:lost', () => {
    // engine.js already stopped the frame loop; from here on it is about
    // telling the player what is happening and watching for the restore.
    showContextOverlay(CONTEXT_LOST_TEXT, false);
    hud.toast?.('图形上下文丢失，正在恢复…', 'Graphics context lost');
    if (contextWatchdog) clearTimeout(contextWatchdog);
    contextWatchdog = setTimeout(() => {
      contextWatchdog = 0;
      showContextOverlay(CONTEXT_FAILED_TEXT, true);
      hud.toast?.('恢复超时，请刷新页面', 'Please reload the page');
    }, 8000);
  });

  bus.on('context:restored', () => {
    if (contextWatchdog) {
      clearTimeout(contextWatchdog);
      contextWatchdog = 0;
    }
    hideContextOverlay();
    // three rebuilds GL objects lazily; the post chain just has to be
    // re-provisioned against the new context and the PMREM env refreshed.
    try {
      post.handleContextRestored?.();
    } catch (err) {
      console.error('[pelican] post restore failed', err);
    }
    try {
      engine.applySize();
    } catch (err) {
      console.error('[pelican] size restore failed', err);
    }
    try {
      modules.environment?.setHour?.(state.hour);
    } catch { /* env rebuild is best-effort */ }
    hud.toast?.('画面已恢复', 'Graphics restored');
  });

  // ------------------------------------------------- page visibility
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Hidden tab: stop rendering and silence the synth graph. Because the
      // loop stops, game time (and therefore the time-trial clock) pauses.
      engine.stop();
      modules.audio?.suspend?.();
    } else {
      modules.audio?.resume?.();
      // engine.start() resets the frame clock, so the first dt after being
      // away is one normal frame instead of a multi-second spike.
      if (!engine.contextLost) engine.start(loop);
    }
  });

  // ------------------------------------------------------------- the loop
  const ORDER = ['controls', 'rider', 'events', 'collectibles', 'animals', 'particles',
    'sky', 'environment', 'ocean', 'vegetation', 'props', 'landmarks', 'weather',
    'camera', 'hud', 'audio'];

  function handleActions() {
    const inMenu = menus.current !== 'none' && menus.current !== undefined;

    if (input.pressed('pause')) {
      if (state.started) togglePause(!state.paused);
      else if (inMenu) menus.show('title');
      return;
    }
    if (input.pressed('photo') && state.started && !state.paused) {
      enterPhotoMode(!state.photoMode);
    }
    if (!inMenu && !state.paused && !state.photoMode) {
      if (input.pressed('camera')) {
        modules.camera?.cycleMode?.();
      }
      if (input.pressed('map')) hud.toggleMinimap?.();
      if (input.pressed('reset')) modules.controls?.reset?.(state);
      if (input.pressed('bell')) {
        bus.emit('sfx', { name: 'bell' });
        tutorialAdvance('bell');
      }
      if (input.pressed('race')) modules.events?.startRace?.(state);
      if (input.pressed('mute')) {
        state.muted = !state.muted;
        modules.audio?.setMuted?.(state.muted);
        saveSettings({ muted: state.muted });
        menus.setSettings?.({ muted: state.muted });
        hud.toast?.(state.muted ? '已静音' : '声音开启', state.muted ? 'Muted' : 'Sound on');
      }
      if (input.pressed('time')) {
        const order = ['dawn', 'noon', 'sunset', 'night', 'cycle'];
        const cur = state._timePreset || 'cycle';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        state._timePreset = next;
        applyTimeMode(next);
        hud.toast?.('时间：' + ({ dawn: '黎明', noon: '正午', sunset: '黄昏', night: '夜晚', cycle: '自动循环' }[next]), 'Time of day');
      }
    } else if (state.photoMode) {
      if (input.pressed('grid')) hud.togglePhotoGrid?.();
      if (input.pressed('map')) hud.toggleMinimap?.();
      if (input.pressed('filter')) cyclePhotoFilter(1);
      if (input.pressed('export')) exportPhoto();
    }
  }

  function loop(dt) {
    try {
      state.dt = dt;
      state.t += dt;
      input.update();
      handleActions();

      const inMenu = menus.current !== 'none' && menus.current !== undefined;
      const frozen = state.paused;
      const worldFrozen = state.photoMode || frozen;
      // Title screen / menus / pre-start: the world stays alive but the rider
      // must not react to keys that are meant for menu navigation.
      const gameplayFrozen = inMenu || !state.started;
      state.timeScale = (state.autoAdvanceTime && !worldFrozen) ? 1 : 0;

      const heading = state.player.heading;
      state.compassHeading = Number.isFinite(heading) ? ((heading * 180 / Math.PI) % 360 + 360) % 360 : 0;

      if (!frozen) {
        for (const id of ORDER) {
          if (!modules[id]?.update) continue;
          if (gameplayFrozen && (id === 'controls' || id === 'events' || id === 'collectibles')) continue;
          if (worldFrozen && (id === 'controls' || id === 'rider' || id === 'events' || id === 'collectibles')) continue;
          try {
            modules[id].update(dt, state);
          } catch (err) {
            console.error(`[pelican] update failed in "${id}"`, err);
          }
        }
      }

      // The HUD is not a world module, so it never appeared in ORDER: it owns
      // the speedometer, clock, compass and minimap and has to tick every
      // frame, paused or not.
      try {
        hud.update?.(dt, state);
      } catch (err) {
        console.error('[pelican] hud update failed', err);
      }

      // Virtual pad: runs like the HUD even while paused so it can release
      // its axes and hide; it decides internally when input is welcome.
      try {
        touch.update?.(dt, state);
      } catch (err) {
        console.error('[pelican] touch update failed', err);
      }

      // Race finish: hold the presentation until the player takes over.
      if (finishShow > 0) {
        finishShow -= dt;
        const cancelled = input.pressed('camera');
        if (cancelled || input.axes.throttle > 0.25 || input.axes.brake > 0.25) finishShow = 0;
        if (finishShow > 0) {
          // events.js rewrites state.discoveryActive every frame, and the HUD
          // clears any externally set letterbox when it reads false - so the
          // finish moment re-asserts it here, after hud.update() has run.
          hud.setLetterbox?.(true);
        } else {
          hud.setLetterbox?.(false);
          if (!state.photoMode && !cancelled) setCamera('chase');
        }
      }

      // pedal input hint for audio
      state.player.brake = input.axes.brake ?? 0;

      // First-run tutorial: "set off" completes once the bike really moves.
      if (tutorialStep === 0 && state.started && !state.paused && Math.abs(state.player.speed) > 6) {
        tutorialAdvance('go');
      }

      updateDebugOverlay(dt);

      // photo-mode focus follows the rider
      if (state.photoMode && modules.camera) {
        const focus = modules.camera.focusDistance ? modules.camera.focusDistance(state) : 12;
        post.setPhoto({ focusDist: Math.max(1.2, focus) });
      }
    } catch (err) {
      // A frame that fails must never leave the pressed-key set dirty.
      console.error('[pelican] frame failed', err);
    } finally {
      input.endFrame();
    }
  }

  engine.start(loop);

  // ------------------------------------------------------------- debug api
  window.__pelican = {
    version: '1.0.0',
    seed,
    bootStages,
    engine,
    state,
    layout,
    modules,
    ctx,
    post,
    touch,
    ready: true,
    start: (mode = 'ride') => onStart(mode),
    setHour: (h) => { state.autoAdvanceTime = false; state.hour = h; },
    teleport: (x, z, heading = 0) => {
      state.player.position.set(x, layout.heightAt(x, z) + 0.1, z);
      state.player.heading = heading;
      state.player.speed = 0;
      modules.camera?.setMode?.('chase');
    },
    setCameraMode: (m) => modules.camera?.setMode?.(m),
    enterPhoto: (on) => enterPhotoMode(on),
    race: () => modules.events?.startRace?.(state),
    resetProgress: () => resetGameplayProgress(),
    cycleFilter: (step) => cyclePhotoFilter(step || 1),
    savePhoto: () => exportPhoto(),
    debugText: () => (debugEl ? debugEl.textContent : ''),
  };
}

boot().catch((err) => {
  console.error('[pelican] boot failed', err);
  const message = String(err?.message || err);
  const overlay = document.getElementById('boot-overlay');
  // Make sure the overlay is on screen again even if it had faded out.
  if (overlay) overlay.classList.remove('is-done');
  const el = document.getElementById('boot-label');
  if (el) el.textContent = `启动失败: ${message} · 请刷新页面；若持续失败请确认浏览器支持 WebGL2`;
  showErrorBar(`启动失败: ${message}`);
  window.__pelican = { ...(window.__pelican || {}), ready: false, booting: false, error: String(err?.stack || err) };
});
