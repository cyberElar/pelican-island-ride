/**
 * main.js - boot, staged world construction, the frame loop and all the
 * glue between gameplay, world modules, UI and audio.
 *
 * Integration contract: every module comes from registry.js as
 *   { group?, update(dt, state), setQuality?(level), colliders?, ... }
 */

import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { createTextureLibrary } from './core/textures.js';
import { createLayout } from './world/layout.js';
import { createInput } from './core/input.js';
import { createPost } from './fx/post.js';
import { createHUD } from './ui/hud.js';
import { createMenus } from './ui/menus.js';
import { worldModuleList } from './registry.js';
import { GAME, QUALITY_PRESETS, detectQuality } from './core/settings.js';
import { Rng } from './core/utils.js';

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

async function boot() {
  window.__pelican = { ready: false, booting: true };
  const progress = { stage: 'boot', i: 0, total: 0, label: '' };
  window.__pelicanProgress = progress;

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
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
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
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
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
    sun: { dir: new THREE.Vector3(0.3, 0.5, 0.8), color: new THREE.Color('#fff4e2'), intensity: 3 },
    moon: { dir: new THREE.Vector3(-0.3, 0.5, -0.8), intensity: 0 },
    events: [],
  };

  const ctx = {
    engine, layout, textures, bus, state, input, quality,
    rng: new Rng(`root:${seed}`),
    colliders: [],
    THREE,
  };

  // ------------------------------------------------------------- minimap io
  const minimapRoad = [];
  {
    const s = layout.roadSamples;
    const n = s.length / 3;
    for (let i = 0; i < n; i += 5) minimapRoad.push({ x: s[i * 3], z: s[i * 3 + 2] });
  }
  const minimapPoiBase = Object.values(layout.pois)
    .filter((p) => p.id !== 'forest' && p.id !== 'pineForest' && p.id !== 'beach' && p.id !== 'beachEast')
    .map((p) => ({ id: p.id, name: p.name, x: p.position.x, z: p.position.z, type: p.type }));
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
  });

  hud = createHUD(ctx, { container: uiRoot, minimapData });
  hud.setDiscoveredTotal?.(minimapPoiBase.length);

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
      const instance = entry.factory(ctx);
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
      bus.emit('ui:toast', { title: '模块加载失败', sub: entry.id });
    }
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

  setProgress((totalSteps - 1) / totalSteps, '正在生成小岛 · 装配镜头后期');
  progress.stage = 'post';
  await nextFrame();
  const post = createPost(engine, ctx);
  ctx.post = post;
  const postRender = post.render.bind(post);
  post.render = (dt) => postRender(dt, state);
  engine.setPost(post);

  setProgress(1, '准备就绪');
  progress.stage = 'ready';

  if (modules.controls?.spawn) modules.controls.spawn(state);
  engine.camera.position.copy(state.player.position).add(new THREE.Vector3(0, 40, -60));
  bus.emit('quality:changed', { level: quality });

  // ------------------------------------------------------------- helpers
  const CAMERA_CYCLE = ['chase', 'firstPerson', 'cinematic'];
  let cameraCycleIndex = 0;

  function setCamera(mode) {
    cameraCycleIndex = Math.max(0, CAMERA_CYCLE.indexOf(mode));
    modules.camera?.setMode(mode);
  }

  function enterPhotoMode(on) {
    state.photoMode = !!on;
    if (state.photoMode) {
      modules.camera?.setMode('photo');
      post.setMode('photo');
      hud.setPhotoMode?.(true, { fov: modules.camera?.photo?.fov ?? 45, filterName: '海风胶片', hint: '滚轮 变焦 · F 网格 · P 退出' });
      hud.setLetterbox?.(false);
    } else {
      post.setMode('ride');
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

  function onStart(mode) {
    state.started = true;
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
    void mode;
  }

  function onResume() {
    togglePause(false);
  }

  function onQuitToTitle() {
    state.started = false;
    state.paused = false;
    enterPhotoMode(false);
    modules.camera?.setMode('tour');
    menus.show('title');
  }

  const SETTINGS_KEY = 'pelicanIsland.settings';
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
  }
  function saveSettings(patch) {
    try {
      const cur = loadSettings() || {};
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cur, ...patch }));
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
    saveSettings(patch);
  }

  // restore saved settings
  {
    const saved = loadSettings();
    if (saved) {
      if (saved.quality && QUALITY_PRESETS[saved.quality] && !qParam) {
        onSettingsChange({ quality: saved.quality });
      }
      if (saved.timeMode) applyTimeMode(saved.timeMode);
      if (typeof saved.masterVolume === 'number') modules.audio?.setMasterVolume?.(saved.masterVolume);
      if (typeof saved.musicVolume === 'number') modules.audio?.setMusicVolume?.(saved.musicVolume);
      if (typeof saved.sfxVolume === 'number') modules.audio?.setSfxVolume?.(saved.sfxVolume);
      if (typeof saved.muted === 'boolean') {
        state.muted = saved.muted;
        modules.audio?.setMuted?.(saved.muted);
      }
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
  bus.on('poi:discovered', (p) => {
    if (p?.position) hud.setLetterbox?.(true);
  });
  bus.on('rider:crash', () => hud.flashDamage?.());
  bus.on('race:finish', (p) => {
    hud.setRace?.({ checkpoint: 0, total: 8, time: p.time, best: p.best, finished: true, newRecord: p.record });
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
        cameraCycleIndex = (cameraCycleIndex + 1) % CAMERA_CYCLE.length;
        modules.camera?.setMode(CAMERA_CYCLE[cameraCycleIndex]);
      }
      if (input.pressed('map')) hud.toggleMinimap?.();
      if (input.pressed('reset')) modules.controls?.reset?.(state);
      if (input.pressed('bell')) bus.emit('sfx', { name: 'bell' });
      if (input.pressed('race')) modules.events?.startRace?.(state);
      if (input.pressed('mute')) {
        state.muted = !state.muted;
        modules.audio?.setMuted?.(state.muted);
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
    }
  }

  function loop(dt) {
    state.dt = dt;
    state.t += dt;
    input.update();
    handleActions();

    const frozen = state.paused;
    const worldFrozen = state.photoMode || frozen;
    state.timeScale = (state.autoAdvanceTime && !worldFrozen) ? 1 : 0;

    if (!frozen) {
      for (const id of ORDER) {
        if (!modules[id]?.update) continue;
        if (worldFrozen && (id === 'controls' || id === 'rider' || id === 'events' || id === 'collectibles')) continue;
        try {
          modules[id].update(dt, state);
        } catch (err) {
          console.error(`[pelican] update failed in "${id}"`, err);
        }
      }
    } else {
      modules.hud?.update?.(dt, state);
    }

    // pedal input hint for audio
    state.player.brake = input.axes.brake;

    // photo-mode focus follows the rider
    if (state.photoMode && modules.camera) {
      const focus = modules.camera.focusDistance ? modules.camera.focusDistance(state) : 12;
      post.setPhoto({ focusDist: Math.max(1.2, focus) });
    }

    input.endFrame();
  }

  engine.start(loop);

  // ------------------------------------------------------------- debug api
  window.__pelican = {
    version: '1.0.0',
    seed,
    engine,
    state,
    layout,
    modules,
    ctx,
    post,
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
  };
}

boot().catch((err) => {
  console.error('[pelican] boot failed', err);
  const el = document.getElementById('boot-label');
  if (el) el.textContent = `启动失败: ${err?.message || err}`;
  window.__pelican = { ready: false, error: String(err?.stack || err) };
});
