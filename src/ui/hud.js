/**
 * hud.js - in-game HUD for "Pelican Island Ride" (提鹅鹏 · 单车环岛).
 *
 * Pure DOM/CSS + one 2D canvas for the minimap. No images, no web fonts, no
 * network. Chinese-first typography with English accents.
 *
 * Public API (see docs/SPEC.md §4.22):
 *   createHUD(ctx, opts) -> {
 *     root, update(dt, state), destroy(),
 *     toast(title, sub), discovery(name, nameEn, sub),
 *     setLetterbox(on), setPhotoMode(on, info), setPaused(on),
 *     setLoading(on, progress01, label), setRace(info|null),
 *     flashDamage(), setCompassHeading(deg), toggleMinimap()
 *   }
 *
 * Extra helpers used by the game loop (kept small on purpose):
 *   togglePhotoGrid(), setMinimap(on), setCameraMode(mode), setDiscoveredTotal(n).
 *
 * `update()` is allocation-light: text is only rewritten when a value actually
 * changed and the minimap repaints at ~8 Hz instead of once per frame.
 */

import { clamp, clamp01 } from '../core/utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const MM_SIZE = 180; // minimap canvas, CSS px == backing store px
const MAX_TOASTS = 3;
const TOAST_MS = 3500;
const TOAST_OUT_MS = 420;
const DISCOVERY_MS = 4000;
const TIP_MS = 4200;
const TEXT_HZ = 0.08; // seconds between text refreshes
const MAP_HZ = 0.12; // seconds between minimap repaints

// Speedometer geometry -------------------------------------------------------
const SP = {
  cx: 110,
  cy: 100,
  rTrack: 74,
  rMajor: 66,
  rMinor: 69,
  rLabel: 58,
  a0: 240, // 0 km/h
  sweep: 240, // degrees, ends at -60 (mirror of a0)
  max: 45, // km/h
};

// Minimal i18n --------------------------------------------------------------
const STRINGS = {
  zh: {
    feathers: '羽毛',
    discovered: '已探索',
    map: '地图',
    mapPending: '地图数据未就绪',
    legendPoi: '地标',
    legendYou: '你',
    checkpoint: '检查点',
    time: '用时',
    best: '最佳',
    finish: '完成',
    record: '新纪录 / NEW RECORD',
    paused: '暂停',
    pausedSub: 'PAUSED',
    boot: '正在生成小岛…',
    photo: '摄影模式 PHOTO',
    gridLabel: '网格 F',
    camera: '相机',
    hint: '滚轮缩放 · 方向键移动 · F 切换网格 · P 退出',
    tips: [
      '提示：按 B 按铃',
      '提示：夜间路上有萤火虫',
      '提示：按住 Shift 冲刺',
      '提示：按 M 打开地图',
      '提示：黄昏时灯塔最亮',
      '提示：收集金色羽毛可以解锁纪念册',
    ],
  },
  en: {
    feathers: 'FEATHERS',
    discovered: 'DISCOVERED',
    map: 'MAP',
    mapPending: 'MAP DATA PENDING',
    legendPoi: 'POI',
    legendYou: 'YOU',
    checkpoint: 'CHECKPOINT',
    time: 'TIME',
    best: 'BEST',
    finish: 'FINISHED',
    record: 'NEW RECORD',
    paused: 'PAUSED',
    pausedSub: '已暂停',
    boot: 'BUILDING THE ISLAND…',
    photo: 'PHOTO MODE',
    gridLabel: 'GRID F',
    camera: 'CAMERA',
    hint: 'Scroll zoom · Arrows move · F grid · P exit',
    tips: [
      'TIP: press B for the bell',
      'TIP: fireflies light the road at night',
      'TIP: hold Shift to sprint',
      'TIP: press M for the map',
      'TIP: the lighthouse is brightest at dusk',
      'TIP: golden feathers fill the almanac',
    ],
  },
};

const CAMERA_MODES = {
  chase: { zh: '跟随', en: 'CHASE' },
  cinematic: { zh: '电影', en: 'CINEMATIC' },
  firstPerson: { zh: '第一人称', en: 'FIRST PERSON' },
  photo: { zh: '摄影', en: 'PHOTO' },
  tour: { zh: '巡游', en: 'TOUR' },
};

const POI_COLORS = {
  lighthouse: '#e0523f',
  harbor: '#1f6f78',
  village: '#1f6f78',
  windmill: '#c9a24a',
  mill: '#c9a24a',
  peak: '#8a8f96',
  cairn: '#8a8f96',
  ruins: '#8a8f96',
  chapel: '#e0523f',
  lakeIsland: '#4a9aa0',
  waterfall: '#4a9aa0',
};

const MAP_INK = '#22201c';
const MAP_TEAL = '#1f6f78';
const MAP_POPPY = '#e0523f';

// ---------------------------------------------------------------------------
// Small helpers (module scope, no allocations per call beyond the element)
// ---------------------------------------------------------------------------

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function asNum(v) {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

/** M:SS.d - the race clock format. */
function formatRaceTime(seconds) {
  let s = isNum(seconds) ? seconds : 0;
  if (s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const tenth = Math.floor((s * 10) % 10);
  return `${m}:${sec < 10 ? '0' : ''}${sec}.${tenth}`;
}

function formatClock(hour) {
  const h = isNum(hour) ? ((hour % 24) + 24) % 24 : 0;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
}

/** Coarse day phase key for the clock chip. */
function phaseOf(hour) {
  const h = isNum(hour) ? ((hour % 24) + 24) % 24 : 12;
  if (h < 5 || h >= 21) return 'night';
  if (h < 8) return 'dawn';
  if (h < 15) return 'day';
  if (h < 18.5) return 'golden';
  return 'dusk';
}

const PHASE_LABEL = {
  night: { zh: '夜晚', en: 'NIGHT' },
  dawn: { zh: '黎明', en: 'DAWN' },
  day: { zh: '白日', en: 'DAY' },
  golden: { zh: '午后', en: 'GOLDEN' },
  dusk: { zh: '黄昏', en: 'DUSK' },
};

/** Focal length in 35 mm terms from a vertical FOV (degrees). */
function focalFromFov(fov) {
  const f = isNum(fov) ? clamp(fov, 4, 120) : 50;
  const mm = 12 / Math.tan((f * DEG) / 2);
  return clamp(Math.round(mm), 8, 400);
}

/** Tolerant bus subscription: ctx may be a bare object. */
function listen(bus, type, fn) {
  if (!bus || typeof bus.on !== 'function') return () => {};
  try {
    const off = bus.on(type, fn);
    if (typeof off === 'function') return off;
  } catch (err) {
    return () => {};
  }
  return () => {
    try {
      if (typeof bus.off === 'function') bus.off(type, fn);
    } catch (err) {
      /* ignore */
    }
  };
}

/** No-op API used when there is no DOM at all (headless/SSR safety). */
function createNullHUD() {
  const noop = () => {};
  return {
    root: null,
    update: noop,
    destroy: noop,
    toast: noop,
    discovery: noop,
    setLetterbox: noop,
    setPhotoMode: noop,
    setPaused: noop,
    setLoading: noop,
    setRace: noop,
    flashDamage: noop,
    setCompassHeading: noop,
    toggleMinimap: noop,
    togglePhotoGrid: noop,
    setMinimap: noop,
    setCameraMode: noop,
    setDiscoveredTotal: noop,
    isMinimapOpen: () => false,
  };
}

// ---------------------------------------------------------------------------
// createHUD
// ---------------------------------------------------------------------------

export function createHUD(ctx = {}, opts = {}) {
  const env = ctx && typeof ctx === 'object' ? ctx : {};
  const options = opts && typeof opts === 'object' ? opts : {};
  const container = options.container || null;
  const doc =
    (container && container.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);

  if (!doc || typeof doc.createElement !== 'function') return createNullHUD();

  /** Element factory bound to the container's document. */
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // -- markup ---------------------------------------------------------------
  const root = doc.createElement('div');
  root.id = 'pi-hud';
  root.className = 'pi-hud';
  root.setAttribute('data-testid', 'hud-root');

  root.innerHTML = [
    '<div class="pi-letterbox" id="pi-letterbox" data-testid="letterbox">',
    '  <div class="pi-letterbox__bar pi-letterbox__bar--top"></div>',
    '  <div class="pi-letterbox__bar pi-letterbox__bar--bottom"></div>',
    '</div>',
    '<div class="pi-compass" id="pi-compass" data-testid="compass">',
    '  <div class="pi-compass__window">',
    '    <div class="pi-compass__shift" id="pi-compass-shift">',
    '      <div class="pi-compass__strip" id="pi-compass-strip" data-testid="compass-strip"></div>',
    '    </div>',
    '    <div class="pi-compass__marker"></div>',
    '  </div>',
    '  <div class="pi-compass__readout pi-num" id="pi-compass-readout" data-testid="compass-readout">000°</div>',
    '  <div class="pi-compass__count" id="pi-hud-discovered" data-testid="discovered-count">已探索 0</div>',
    '</div>',
    '<div class="pi-hud-corner pi-hud-corner--tl">',
    '  <div class="pi-chip pi-feather" id="pi-hud-feathers" data-testid="feathers">',
    '    <svg class="pi-feather__icon" viewBox="0 0 24 24" aria-hidden="true">',
    '      <ellipse cx="13.4" cy="9.2" rx="4.6" ry="7.2" transform="rotate(38 13.4 9.2)" fill="currentColor" opacity="0.92"></ellipse>',
    '      <path d="M9.6 15.4 4.4 20.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
    '    </svg>',
    '    <span class="pi-chip__value pi-num" id="pi-feather-count" data-testid="feather-count">0 / 40</span>',
    '    <span class="pi-chip__label" id="pi-feather-label">羽毛</span>',
    '  </div>',
    '  <div class="pi-chip pi-chip--quiet" id="pi-hud-clock" data-testid="clock">',
    '    <span class="pi-chip__value" id="pi-clock-value" data-testid="clock-value">17:10</span>',
    '    <span class="pi-chip__label" id="pi-clock-phase">黄昏</span>',
    '  </div>',
    '</div>',
    '<div class="pi-hud-corner pi-hud-corner--tr">',
    '  <div class="pi-minimap pi-panel" id="pi-minimap" data-testid="minimap">',
    '    <div class="pi-minimap__inner">',
    '      <div class="pi-minimap__head">',
    '        <span class="pi-minimap__title" id="pi-minimap-title">地图</span>',
    '        <span class="pi-minimap__count pi-num" id="pi-minimap-count" data-testid="minimap-count">0/0</span>',
    '      </div>',
    '      <canvas class="pi-minimap__canvas" id="pi-minimap-canvas" data-testid="minimap-canvas" width="180" height="180"></canvas>',
    '      <div class="pi-minimap__legend">',
    '        <span id="pi-minimap-legend-poi">地标</span>',
    '        <span id="pi-minimap-legend-you">你</span>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="pi-race pi-panel" id="pi-race" data-testid="race">',
    '    <div class="pi-race__row">',
    '      <span class="pi-race__key" id="pi-race-key-cp">检查点</span>',
    '      <span class="pi-race__val pi-num" id="pi-race-checkpoint" data-testid="race-checkpoint">0/0</span>',
    '    </div>',
    '    <div class="pi-race__row">',
    '      <span class="pi-race__key" id="pi-race-key-time">用时</span>',
    '      <span class="pi-race__val pi-race__val--time pi-num" id="pi-race-time" data-testid="race-time">0:00.0</span>',
    '    </div>',
    '    <div class="pi-race__row">',
    '      <span class="pi-race__key" id="pi-race-key-best">最佳</span>',
    '      <span class="pi-race__val pi-num" id="pi-race-best" data-testid="race-best">—</span>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div class="pi-hud-corner pi-hud-corner--bl">',
    '  <div class="pi-chip pi-chip--quiet" id="pi-hud-camera" data-testid="camera-mode">',
    '    <span class="pi-chip__label" id="pi-camera-label">相机</span>',
    '    <span class="pi-chip__value" id="pi-camera-value" data-testid="camera-mode-value">跟随</span>',
    '  </div>',
    '</div>',
    '<div class="pi-hud-corner pi-hud-corner--br">',
    '  <div class="pi-speedo" id="pi-speedo" data-testid="speedometer">',
    '    <svg class="pi-speedo__svg" id="pi-speedo-svg" viewBox="0 0 220 158" aria-hidden="true">',
    '      <path class="pi-speedo__track" id="pi-speedo-track"></path>',
    '      <path class="pi-speedo__fill" id="pi-speedo-arc" pathLength="100"></path>',
    '      <g id="pi-speedo-ticks"></g>',
    '      <g id="pi-speedo-labels"></g>',
    '      <g id="pi-speedo-needle" transform="rotate(240 110 100)">',
    '        <line class="pi-speedo__needle-tail" x1="110" y1="100" x2="110" y2="114"></line>',
    '        <line class="pi-speedo__needle" x1="110" y1="100" x2="110" y2="44"></line>',
    '      </g>',
    '      <circle class="pi-speedo__hub" cx="110" cy="100" r="4.6"></circle>',
    '    </svg>',
    '    <div class="pi-speedo__digital">',
    '      <span class="pi-speedo__value pi-num" id="pi-speedo-value" data-testid="speed-readout">0</span>',
    '      <span class="pi-speedo__unit" id="pi-speedo-unit">km/h</span>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div class="pi-race-banner pi-panel" id="pi-race-banner" data-testid="race-banner">',
    '  <h2 class="pi-race-banner__title" id="pi-race-banner-title">完成</h2>',
    '  <div class="pi-race-banner__time pi-num" id="pi-race-banner-time" data-testid="race-banner-time">0:00.0</div>',
    '  <div class="pi-race-banner__record" id="pi-race-record" data-testid="race-record">新纪录 / NEW RECORD</div>',
    '</div>',
    '<div class="pi-discovery pi-panel" id="pi-discovery" data-testid="discovery">',
    '  <h2 class="pi-discovery__name" id="pi-discovery-name" data-testid="discovery-name"></h2>',
    '  <p class="pi-discovery__en" id="pi-discovery-en" data-testid="discovery-en"></p>',
    '  <p class="pi-discovery__sub" id="pi-discovery-sub" data-testid="discovery-sub"></p>',
    '</div>',
    '<div class="pi-paused pi-panel" id="pi-paused" data-testid="paused">',
    '  <div class="pi-paused__title" id="pi-paused-title">暂停</div>',
    '  <div class="pi-paused__sub" id="pi-paused-sub">PAUSED</div>',
    '</div>',
    '<div class="pi-photo" id="pi-photo" data-testid="photo-overlay">',
    '  <div class="pi-photo__brackets" id="pi-photo-brackets">',
    '    <span class="pi-photo__bracket pi-photo__bracket--tl"></span>',
    '    <span class="pi-photo__bracket pi-photo__bracket--tr"></span>',
    '    <span class="pi-photo__bracket pi-photo__bracket--bl"></span>',
    '    <span class="pi-photo__bracket pi-photo__bracket--br"></span>',
    '  </div>',
    '  <div class="pi-photo__grid" id="pi-photo-grid" data-testid="photo-grid">',
    '    <span class="pi-photo__gridline pi-photo__gridline--v" style="left:33.333%"></span>',
    '    <span class="pi-photo__gridline pi-photo__gridline--v" style="left:66.666%"></span>',
    '    <span class="pi-photo__gridline pi-photo__gridline--h" style="top:33.333%"></span>',
    '    <span class="pi-photo__gridline pi-photo__gridline--h" style="top:66.666%"></span>',
    '  </div>',
    '  <div class="pi-photo__readout">',
    '    <div class="pi-photo__mode" id="pi-photo-mode">摄影模式 PHOTO</div>',
    '    <div class="pi-photo__focal"><span class="pi-num" id="pi-photo-focal" data-testid="photo-focal">35</span><small>MM</small></div>',
    '    <div class="pi-photo__filter" id="pi-photo-filter" data-testid="photo-filter">—</div>',
    '  </div>',
    '  <div class="pi-photo__hint" id="pi-photo-hint" data-testid="photo-hint">滚轮缩放 · 方向键移动 · F 切换网格 · P 退出</div>',
    '  <button type="button" class="pi-photo__gridchip is-on" id="pi-photo-gridchip" data-testid="photo-grid-toggle">网格 F</button>',
    '</div>',
    '<div class="pi-toasts" id="pi-toasts" data-testid="toasts"></div>',
    '<div class="pi-damage" id="pi-damage" data-testid="damage"></div>',
    '<div class="pi-loading" id="pi-loading" data-testid="loading">',
    '  <div class="pi-loading__brand">PELICAN ISLAND RIDE</div>',
    '  <div class="pi-loading__title" id="pi-loading-title" data-testid="loading-title">正在生成小岛…</div>',
    '  <div class="pi-loading__bar"><div class="pi-loading__fill" id="pi-loading-fill" data-testid="loading-bar"></div></div>',
    '  <div class="pi-loading__meta">',
    '    <span id="pi-loading-label" data-testid="loading-label">生成地形</span>',
    '    <span class="pi-num" id="pi-loading-pct" data-testid="loading-percent">0%</span>',
    '  </div>',
    '  <div class="pi-loading__tip" id="pi-loading-tip" data-testid="loading-tip">提示：按 B 按铃</div>',
    '</div>',
  ].join('\n');

  const E = {};
  const ids = [
    'pi-letterbox', 'pi-compass-shift', 'pi-compass-strip',
    'pi-compass-readout', 'pi-hud-discovered', 'pi-hud-feathers', 'pi-feather-count',
    'pi-feather-label', 'pi-clock-value', 'pi-clock-phase', 'pi-minimap',
    'pi-minimap-title', 'pi-minimap-count', 'pi-minimap-canvas', 'pi-minimap-legend-poi',
    'pi-minimap-legend-you', 'pi-race', 'pi-race-key-cp', 'pi-race-key-time',
    'pi-race-key-best', 'pi-race-checkpoint', 'pi-race-time', 'pi-race-best',
    'pi-camera-label', 'pi-camera-value', 'pi-speedo', 'pi-speedo-track',
    'pi-speedo-arc', 'pi-speedo-ticks', 'pi-speedo-labels', 'pi-speedo-needle',
    'pi-speedo-value', 'pi-race-banner', 'pi-race-banner-title',
    'pi-race-banner-time', 'pi-race-record', 'pi-discovery', 'pi-discovery-name',
    'pi-discovery-en', 'pi-discovery-sub', 'pi-paused', 'pi-paused-title',
    'pi-paused-sub', 'pi-photo', 'pi-photo-grid', 'pi-photo-mode', 'pi-photo-focal',
    'pi-photo-filter', 'pi-photo-hint', 'pi-photo-gridchip', 'pi-toasts', 'pi-damage',
    'pi-loading', 'pi-loading-fill', 'pi-loading-title', 'pi-loading-label', 'pi-loading-pct',
    'pi-loading-tip',
  ];
  for (const id of ids) E[id] = root.querySelector(`#${id}`);

  // -- state ----------------------------------------------------------------
  let destroyed = false;
  let accText = TEXT_HZ;
  let accMap = MAP_HZ;
  let accTip = 0;

  let heading = 0;
  let headingWritten = -1;
  let needleKmh = -1;
  let needleAngleWritten = -1;

  let language = env.settings && env.settings.language === 'en' ? 'en' : 'zh';
  let photoOn = false;
  let pausedOn = false;
  let loadingOn = false;
  let minimapOn = false;
  let photoGridOn = true;
  let raceOn = false;
  let raceRecord = false;
  let letterboxUser = false;
  let letterboxTemp = false;
  let loadingTipIndex = 0;
  let lastTipWrite = '';
  let camMode = 'chase';
  let poiCollected = 0;
  let poiTotal = 0;
  let discoveredFromState = false;
  let featherDone = 0;
  let featherTotal = 0;
  let lastText = { speed: '', feather: '', clock: '', phase: '', disc: '', raceTime: '', raceBest: '', raceCp: '', cam: '', mapCount: '' };
  let reliefCache = { tex: null, canvas: null };

  const timers = { discovery: 0, damage: 0 };
  const toastTimers = new Set();

  // -- SVG speedometer ------------------------------------------------------
  function polar(r, deg) {
    const a = deg * DEG;
    return [SP.cx + r * Math.sin(a), SP.cy - r * Math.cos(a)];
  }

  function arcPath(from, to, r) {
    const [x0, y0] = polar(r, from);
    const [x1, y1] = polar(r, to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  function angleFor(kmh) {
    return SP.a0 + (clamp(kmh, 0, SP.max) / SP.max) * SP.sweep;
  }

  function buildSpeedometer() {
    const track = E['pi-speedo-track'];
    const arc = E['pi-speedo-arc'];
    const ticks = E['pi-speedo-ticks'];
    const labels = E['pi-speedo-labels'];
    if (!track || !arc || !ticks || !labels) return;
    const end = SP.a0 + SP.sweep;
    track.setAttribute('d', arcPath(SP.a0, end, SP.rTrack));
    arc.setAttribute('d', arcPath(SP.a0, end, SP.rTrack));
    arc.setAttribute('stroke-dasharray', '0 100');

    for (let v = 3; v < SP.max; v += 3) {
      const major = v % 15 === 0;
      const a = angleFor(v);
      const [x0, y0] = polar(major ? SP.rMajor : SP.rMinor, a);
      const [x1, y1] = polar(SP.rTrack, a);
      const line = doc.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', major ? 'pi-speedo__tick pi-speedo__tick--major' : 'pi-speedo__tick');
      line.setAttribute('x1', x0.toFixed(2));
      line.setAttribute('y1', y0.toFixed(2));
      line.setAttribute('x2', x1.toFixed(2));
      line.setAttribute('y2', y1.toFixed(2));
      ticks.appendChild(line);
    }

    for (let v = 0; v <= SP.max; v += 15) {
      const a = angleFor(v);
      const [x, y] = polar(SP.rLabel, a);
      const text = doc.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'pi-speedo__label');
      text.setAttribute('x', x.toFixed(2));
      text.setAttribute('y', (y + 3).toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.textContent = String(v);
      labels.appendChild(text);
    }
  }

  function applyNeedle(kmh, force) {
    const target = angleFor(kmh);
    if (!force && Math.abs(target - needleAngleWritten) < 0.4) return;
    needleAngleWritten = target;
    if (E['pi-speedo-needle']) {
      E['pi-speedo-needle'].setAttribute('transform', `rotate(${target.toFixed(2)} ${SP.cx} ${SP.cy})`);
    }
    if (E['pi-speedo-arc']) {
      const p = clamp01(kmh / SP.max);
      E['pi-speedo-arc'].setAttribute('stroke-dasharray', `${(p * 100).toFixed(2)} 100`);
    }
    if (E['pi-speedo']) E['pi-speedo'].classList.toggle('is-fast', kmh >= 30);
  }

  // -- compass strip --------------------------------------------------------
  const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  const PX_PER_DEG = 3;

  function buildCompass() {
    const strip = E['pi-compass-strip'];
    if (!strip) return;
    const frag = doc.createDocumentFragment();
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let d = 0; d < 360; d += 5) {
        const tick = el('span');
        const cardinal = CARDINALS[d];
        const major = d % 45 === 0;
        tick.className = cardinal
          ? 'pi-ctick pi-ctick--cardinal'
          : major
            ? 'pi-ctick pi-ctick--mid'
            : 'pi-ctick pi-ctick--minor';
        tick.style.left = `${(cycle * 360 + d) * PX_PER_DEG}px`;
        if (cardinal) {
          const label = el('b', 'pi-ctick__label', cardinal);
          tick.appendChild(label);
        }
        frag.appendChild(tick);
      }
    }
    strip.appendChild(frag);
  }

  function applyCompass(force) {
    if (!force && Math.abs(heading - headingWritten) < 0.25 && headingWritten >= 0) return;
    headingWritten = heading;
    const shift = E['pi-compass-shift'];
    if (shift) {
      const offset = 540 + PX_PER_DEG * heading;
      shift.style.transform = `translateX(calc(-50% - ${offset.toFixed(1)}px))`;
    }
    if (E['pi-compass-readout']) {
      E['pi-compass-readout'].textContent = `${String(Math.round(heading) % 360).padStart(3, '0')}°`;
    }
  }

  // -- letterbox ------------------------------------------------------------
  function applyLetterbox() {
    const on = letterboxUser || letterboxTemp;
    if (E['pi-letterbox']) {
      E['pi-letterbox'].classList.toggle('is-on', on);
    }
    // The bars own the frame for a moment, so the chrome steps back.
    root.classList.toggle('has-letterbox', on && !photoOn);
  }

  // -- strings --------------------------------------------------------------
  function S() {
    return STRINGS[language] || STRINGS.zh;
  }

  function applyLanguage() {
    const s = S();
    if (E['pi-feather-label']) E['pi-feather-label'].textContent = s.feathers;
    if (E['pi-camera-label']) E['pi-camera-label'].textContent = s.camera;
    if (E['pi-minimap-title']) E['pi-minimap-title'].textContent = s.map;
    if (E['pi-minimap-legend-poi']) E['pi-minimap-legend-poi'].textContent = s.legendPoi;
    if (E['pi-minimap-legend-you']) E['pi-minimap-legend-you'].textContent = s.legendYou;
    if (E['pi-race-key-cp']) E['pi-race-key-cp'].textContent = s.checkpoint;
    if (E['pi-race-key-time']) E['pi-race-key-time'].textContent = s.time;
    if (E['pi-race-key-best']) E['pi-race-key-best'].textContent = s.best;
    if (E['pi-race-banner-title']) E['pi-race-banner-title'].textContent = s.finish;
    if (E['pi-race-record']) E['pi-race-record'].textContent = s.record;
    if (E['pi-paused-title']) E['pi-paused-title'].textContent = s.paused;
    if (E['pi-paused-sub']) E['pi-paused-sub'].textContent = s.pausedSub;
    if (E['pi-loading-title']) E['pi-loading-title'].textContent = s.boot;
    if (E['pi-photo-mode']) E['pi-photo-mode'].textContent = s.photo;
    if (E['pi-photo-gridchip']) E['pi-photo-gridchip'].textContent = s.gridLabel;
    if (E['pi-photo-hint']) E['pi-photo-hint'].textContent = s.hint;
    if (E['pi-camera-value']) applyCameraMode();
    if (E['pi-loading-tip']) {
      lastTipWrite = '';
      applyTip();
    }
    applyDiscoveredText();
    lastText.speed = '';
    lastText.feather = '';
    lastText.raceTime = '';
    lastText.raceBest = '';
  }

  function applyTip() {
    const s = S();
    const tip = s.tips[loadingTipIndex % s.tips.length] || '';
    if (!E['pi-loading-tip'] || tip === lastTipWrite) return;
    lastTipWrite = tip;
    E['pi-loading-tip'].textContent = tip;
    E['pi-loading-tip'].classList.remove('is-swap');
    void E['pi-loading-tip'].offsetWidth;
    E['pi-loading-tip'].classList.add('is-swap');
  }

  function applyCameraMode() {
    const entry = CAMERA_MODES[camMode] || CAMERA_MODES.chase;
    if (E['pi-camera-value']) E['pi-camera-value'].textContent = entry[language] || entry.zh;
  }

  function setText(key, el, value) {
    if (!el || lastText[key] === value) return;
    lastText[key] = value;
    el.textContent = value;
  }

  function discoveredCount(state) {
    const map = state && state.discovered;
    if (!map || typeof map !== 'object') return poiCollected;
    try {
      const n = Object.keys(map).length;
      // Once the game's own map has entries it is the source of truth; before
      // that the HUD trusts the poi:discovered events it has seen.
      if (n > 0) {
        discoveredFromState = true;
        return n;
      }
      if (discoveredFromState) return 0;
      return poiCollected;
    } catch (err) {
      return poiCollected;
    }
  }

  function applyDiscoveredText() {
    const s = S();
    const value = poiTotal > 0 ? `${s.discovered} ${poiCollected} / ${poiTotal}` : `${s.discovered} ${poiCollected}`;
    if (E['pi-hud-discovered'] && lastText.disc !== value) {
      lastText.disc = value;
      E['pi-hud-discovered'].textContent = value;
    }
    const short = poiTotal > 0 ? `${poiCollected}/${poiTotal}` : String(poiCollected);
    setText('mapCount', E['pi-minimap-count'], short);
  }

  // -- minimap --------------------------------------------------------------
  function readMapData() {
    if (typeof options.minimapData !== 'function') return null;
    try {
      const d = options.minimapData();
      return d && typeof d === 'object' ? d : null;
    } catch (err) {
      return null;
    }
  }

  /** Optional land relief from layout's height texture. Fails soft to null. */
  function buildRelief(tex, waterLevel01) {
    try {
      const img = tex && (tex.image || tex.source);
      const w = img ? img.width | 0 : 0;
      const h = img ? img.height | 0 : 0;
      const data = img ? img.data : null;
      if (!w || !h || !data || !doc.createElement) return null;
      const n = w * h;
      const chans = data.length === n * 4 ? 4 : data.length === n ? 1 : 0;
      if (!chans) return null;
      const canvas = doc.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c2d = canvas.getContext('2d');
      if (!c2d) return null;
      const frame = c2d.createImageData ? c2d.createImageData(w, h) : null;
      if (!frame || !frame.data) return null;
      const isFloat = typeof Float32Array !== 'undefined' && data instanceof Float32Array;
      const scale = isFloat ? 1 : 255;
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = data[i * chans] / scale;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const span = mx - mn > 1e-6 ? mx - mn : 1;
      // Float height fields are metres (water = 0); packed 8-bit data needs a
      // hint. `waterLevel01` in minimapData() overrides the 0.22 default.
      const rawWater = isFloat ? 0 : isNum(waterLevel01) ? clamp01(waterLevel01) : 0.22;
      const water = clamp01((rawWater - mn) / span);
      const out = frame.data;
      for (let i = 0; i < n; i++) {
        const v = data[i * chans] / scale;
        const tt = clamp01((v - mn) / span);
        let r;
        let g;
        let b;
        if (tt < water) {
          const k = water > 0 ? tt / water : 1;
          r = 88 + k * 44;
          g = 150 + k * 26;
          b = 158 + k * 22;
        } else {
          const k = water < 1 ? (tt - water) / (1 - water) : 1;
          r = 244 - k * 96;
          g = 235 - k * 98;
          b = 214 - k * 100;
        }
        const o = i * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 236;
      }
      c2d.putImageData(frame, 0, 0);
      return canvas;
    } catch (err) {
      return null;
    }
  }

  function ensureRelief(d) {
    const tex = d && d.heightTexture;
    if (!tex) {
      reliefCache = { tex: null, canvas: null };
      return null;
    }
    if (reliefCache.tex === tex) return reliefCache.canvas;
    reliefCache = { tex, canvas: buildRelief(tex, d.waterLevel01) };
    return reliefCache.canvas;
  }

  let mmCtx = null;
  let mmCtxTried = false;
  function minimapContext() {
    if (mmCtxTried) return mmCtx;
    mmCtxTried = true;
    const canvas = E['pi-minimap-canvas'];
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    try {
      mmCtx = canvas.getContext('2d') || null;
    } catch (err) {
      // jsdom (and locked-down browsers) can throw here.
      mmCtx = null;
    }
    return mmCtx;
  }

  function drawMinimap() {
    const c2d = minimapContext();
    if (!c2d) return;
    const d = readMapData();
    const world = d && isNum(d.size) && d.size > 0 ? d.size : 6000;
    const half = world / 2;
    const SZ = MM_SIZE;
    const px = (v) => ((v + half) / world) * SZ;

    c2d.clearRect(0, 0, SZ, SZ);
    c2d.fillStyle = '#eae0c9';
    c2d.fillRect(0, 0, SZ, SZ);

    const relief = ensureRelief(d);
    if (relief) {
      try {
        c2d.drawImage(relief, 0, 0, SZ, SZ);
      } catch (err) {
        /* ignore: relief is decorative */
      }
    }

    // 1 km grid
    c2d.strokeStyle = 'rgba(34,32,28,0.12)';
    c2d.lineWidth = 1;
    c2d.beginPath();
    for (let i = 1; i < 6; i++) {
      const g = Math.round((SZ / 6) * i) + 0.5;
      c2d.moveTo(g, 0);
      c2d.lineTo(g, SZ);
      c2d.moveTo(0, g);
      c2d.lineTo(SZ, g);
    }
    c2d.stroke();

    const road = d && d.road;
    const pois = d && d.pois;
    const player = d && d.player;

    if (road && road.length > 1) {
      c2d.beginPath();
      for (let i = 0; i < road.length; i++) {
        const p = road[i];
        if (!p) continue;
        const x = px(p.x);
        const y = px(p.z);
        if (i === 0) c2d.moveTo(x, y);
        else c2d.lineTo(x, y);
      }
      if (road.length > 2) c2d.closePath();
      c2d.lineJoin = 'round';
      c2d.strokeStyle = 'rgba(34,32,28,0.62)';
      c2d.lineWidth = 1.7;
      c2d.stroke();
      c2d.setLineDash([3, 3]);
      c2d.strokeStyle = 'rgba(247,241,228,0.55)';
      c2d.lineWidth = 0.8;
      c2d.stroke();
      c2d.setLineDash([]);
    }

    const found = new Set();
    const discoveredMap = env.state && env.state.discovered;
    if (discoveredMap && typeof discoveredMap === 'object') {
      try {
        for (const k of Object.keys(discoveredMap)) found.add(k);
      } catch (err) {
        /* ignore */
      }
    }

    if (pois && pois.length) {
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        if (!p) continue;
        const x = px(p.x);
        const y = px(p.z);
        const known = !!p.discovered || (p.id != null && found.has(p.id)) || (p.name != null && found.has(p.name));
        c2d.beginPath();
        c2d.arc(x, y, known ? 2.6 : 1.7, 0, TAU);
        if (known) {
          c2d.fillStyle = p.type && POI_COLORS[p.type] ? POI_COLORS[p.type] : MAP_TEAL;
          c2d.fill();
          c2d.strokeStyle = 'rgba(34,32,28,0.5)';
          c2d.lineWidth = 0.7;
          c2d.stroke();
        } else {
          c2d.strokeStyle = 'rgba(34,32,28,0.3)';
          c2d.lineWidth = 0.8;
          c2d.stroke();
        }
      }
    }

    if (player) {
      const x = px(isNum(player.x) ? player.x : 0);
      const y = px(isNum(player.z) ? player.z : 0);
      const rot = (isNum(player.heading) ? player.heading : heading) * DEG;
      c2d.save();
      c2d.translate(x, y);
      c2d.rotate(rot);
      c2d.beginPath();
      c2d.moveTo(0, -5.6);
      c2d.lineTo(3.6, 4.2);
      c2d.lineTo(0, 2.3);
      c2d.lineTo(-3.6, 4.2);
      c2d.closePath();
      c2d.fillStyle = MAP_POPPY;
      c2d.fill();
      c2d.strokeStyle = 'rgba(34,32,28,0.6)';
      c2d.lineWidth = 0.8;
      c2d.stroke();
      c2d.restore();
    }

    if (!road && !pois) {
      c2d.fillStyle = 'rgba(34,32,28,0.45)';
      c2d.font = '10px sans-serif';
      c2d.textAlign = 'center';
      c2d.fillText(S().mapPending, SZ / 2, SZ / 2 + 4);
    }

    c2d.strokeStyle = 'rgba(34,32,28,0.22)';
    c2d.lineWidth = 1;
    c2d.strokeRect(0.5, 0.5, SZ - 1, SZ - 1);
    c2d.fillStyle = 'rgba(34,32,28,0.6)';
    c2d.font = '9px sans-serif';
    c2d.textAlign = 'center';
    c2d.fillText('N', SZ / 2, 11);
  }

  // -- toasts ---------------------------------------------------------------
  function clearToastTimers() {
    for (const id of toastTimers) clearTimeout(id);
    toastTimers.clear();
  }

  function removeToast(node) {
    if (!node) return;
    const list = node._piTimers || [];
    for (const id of list) {
      clearTimeout(id);
      toastTimers.delete(id);
    }
    node._piTimers = [];
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function toast(title, sub) {
    const list = E['pi-toasts'];
    if (!list) return;
    const node = el('div', 'pi-toast');
    node.setAttribute('data-testid', 'toast');
    node.appendChild(el('div', 'pi-toast__title', title == null ? '' : String(title)));
    if (sub != null && sub !== '') node.appendChild(el('div', 'pi-toast__sub', String(sub)));
    node._piTimers = [];
    list.insertBefore(node, list.firstChild);

    while (list.children.length > MAX_TOASTS) removeToast(list.lastElementChild);

    const out = setTimeout(() => {
      toastTimers.delete(out);
      if (destroyed || !node.parentNode) return;
      node.classList.add('is-out');
      const gone = setTimeout(() => {
        toastTimers.delete(gone);
        removeToast(node);
      }, TOAST_OUT_MS);
      toastTimers.add(gone);
      node._piTimers.push(gone);
    }, TOAST_MS);
    toastTimers.add(out);
    node._piTimers.push(out);
  }

  // -- public API -----------------------------------------------------------
  function update(dt, state) {
    if (destroyed) return;
    const d = isNum(dt) ? dt : 0;

    const player = state && state.player ? state.player : null;
    const kmh = player && isNum(player.speed) ? Math.abs(player.speed) * 3.6 : 0;

    // needle: damped so a jittery speed value still reads smoothly
    const k = 1 - Math.exp(-14 * Math.max(0, Math.min(d, 0.1)));
    needleKmh = needleKmh < 0 ? kmh : needleKmh + (kmh - needleKmh) * k;
    applyNeedle(needleKmh, false);

    if (state && isNum(state.compassHeading) && Math.abs(state.compassHeading - heading) > 0.25) {
      setCompassHeading(state.compassHeading);
    }
    applyCompass(false);

    // mirror the game's own flags so the HUD cannot desync from state
    if (state && typeof state.photoMode === 'boolean' && state.photoMode !== photoOn) {
      setPhotoMode(state.photoMode, null);
    }
    if (state && typeof state.paused === 'boolean' && state.paused !== pausedOn) {
      setPaused(state.paused);
    }
    if (state && state.camera && typeof state.camera.mode === 'string' && state.camera.mode !== camMode) {
      setCameraMode(state.camera.mode);
    }
    if (state && state.feathers) {
      if (isNum(state.feathers.collected)) featherDone = state.feathers.collected;
      if (isNum(state.feathers.total)) featherTotal = state.feathers.total;
    }

    // text at ~12 Hz
    accText += d;
    if (accText >= TEXT_HZ) {
      accText = 0;
      if (player) {
        setText('speed', E['pi-speedo-value'], String(Math.round(kmh)));
      }
      setText('feather', E['pi-feather-count'], `${featherDone} / ${featherTotal || '—'}`);
      if (state && isNum(state.hour)) {
        setText('clock', E['pi-clock-value'], formatClock(state.hour));
        const phase = PHASE_LABEL[phaseOf(state.hour)] || PHASE_LABEL.day;
        setText('phase', E['pi-clock-phase'], phase[language] || phase.zh);
      }
      if (state) {
        if (poiTotal === 0) {
          const data = readMapData();
          if (data && Array.isArray(data.pois) && data.pois.length) {
            poiTotal = data.pois.length;
            applyDiscoveredText();
          }
        }
        const c = discoveredCount(state);
        if (c !== poiCollected) {
          poiCollected = c;
          applyDiscoveredText();
        }
        if (state.race && typeof state.race === 'object') {
          if (isNum(state.race.checkpoint)) {
            setText('raceCp', E['pi-race-checkpoint'], `${state.race.checkpoint}/${isNum(state.race.total) ? state.race.total : poiTotal}`);
          }
          if (isNum(state.race.time)) setText('raceTime', E['pi-race-time'], formatRaceTime(state.race.time));
          if (state.race.best === null || isNum(state.race.best)) {
            setText('raceBest', E['pi-race-best'], isNum(state.race.best) ? formatRaceTime(state.race.best) : '—');
          }
        }
      }
    }

    // minimap at ~8 Hz
    if (minimapOn) {
      accMap += d;
      if (accMap >= MAP_HZ) {
        accMap = 0;
        drawMinimap();
      }
    }

    // loading tips
    if (loadingOn) {
      accTip += d;
      if (accTip >= TIP_MS / 1000) {
        accTip = 0;
        loadingTipIndex = (loadingTipIndex + 1) % S().tips.length;
        applyTip();
      }
    }
  }

  function setCompassHeading(deg) {
    if (destroyed) return;
    if (!isNum(deg)) return;
    heading = ((deg % 360) + 360) % 360;
    applyCompass(true);
  }

  function setLetterbox(on) {
    if (destroyed) return;
    letterboxUser = !!on;
    applyLetterbox();
  }

  function discovery(name, nameEn, sub) {
    if (destroyed) return;
    if (E['pi-discovery-name']) E['pi-discovery-name'].textContent = name == null ? '' : String(name);
    if (E['pi-discovery-en']) E['pi-discovery-en'].textContent = nameEn == null ? '' : String(nameEn);
    const hasSub = sub != null && sub !== '';
    if (E['pi-discovery-sub']) {
      E['pi-discovery-sub'].textContent = hasSub ? String(sub) : '';
      E['pi-discovery-sub'].style.display = hasSub ? 'block' : 'none';
    }
    if (E['pi-discovery']) E['pi-discovery'].classList.add('is-on');
    letterboxTemp = true;
    applyLetterbox();
    clearTimeout(timers.discovery);
    timers.discovery = setTimeout(() => {
      if (destroyed) return;
      if (E['pi-discovery']) E['pi-discovery'].classList.remove('is-on');
      letterboxTemp = false;
      applyLetterbox();
    }, DISCOVERY_MS);
  }

  function setPhotoMode(on, info) {
    if (destroyed) return;
    photoOn = !!on;
    if (E['pi-photo']) E['pi-photo'].classList.toggle('is-on', photoOn);
    root.classList.toggle('is-photo', photoOn);
    applyLetterbox();
    if (!photoOn) return;
    if (info && isNum(info.fov) && E['pi-photo-focal']) {
      E['pi-photo-focal'].textContent = String(focalFromFov(info.fov));
    }
    if (info && info.filterName != null && E['pi-photo-filter']) {
      E['pi-photo-filter'].textContent = String(info.filterName);
    }
    if (info && info.hint != null) {
      if (E['pi-photo-hint']) E['pi-photo-hint'].textContent = String(info.hint);
    } else if (E['pi-photo-hint']) {
      E['pi-photo-hint'].textContent = S().hint;
    }
  }

  function togglePhotoGrid(on) {
    if (destroyed) return photoGridOn;
    photoGridOn = typeof on === 'boolean' ? on : !photoGridOn;
    if (E['pi-photo-grid']) E['pi-photo-grid'].classList.toggle('is-off', !photoGridOn);
    if (E['pi-photo-gridchip']) E['pi-photo-gridchip'].classList.toggle('is-on', photoGridOn);
    return photoGridOn;
  }

  function setPaused(on) {
    if (destroyed) return;
    pausedOn = !!on;
    if (E['pi-paused']) E['pi-paused'].classList.toggle('is-on', pausedOn);
    root.classList.toggle('is-paused', pausedOn);
  }

  function setLoading(on, progress01, label) {
    if (destroyed) return;
    const wasOn = loadingOn;
    loadingOn = !!on;
    if (E['pi-loading']) E['pi-loading'].classList.toggle('is-on', loadingOn);
    if (loadingOn && !wasOn) {
      loadingTipIndex = 0;
      accTip = 0;
      applyTip();
    }
    if (isNum(progress01)) {
      const p = clamp01(progress01);
      if (E['pi-loading-fill']) E['pi-loading-fill'].style.width = `${(p * 100).toFixed(1)}%`;
      setText('loadingPct', E['pi-loading-pct'], `${Math.round(p * 100)}%`);
    }
    if (label != null) setText('loadingLabel', E['pi-loading-label'], String(label));
  }

  function setRace(info) {
    if (destroyed) return;
    if (!info) {
      raceOn = false;
      if (E['pi-race']) E['pi-race'].classList.remove('is-on');
      if (E['pi-race-banner']) E['pi-race-banner'].classList.remove('is-on', 'is-record');
      return;
    }
    raceOn = true;
    if (E['pi-race']) E['pi-race'].classList.add('is-on');
    const total = isNum(info.total) ? info.total : poiTotal;
    const cp = isNum(info.checkpoint) ? info.checkpoint : 0;
    setText('raceCp', E['pi-race-checkpoint'], `${cp}/${total}`);
    if (isNum(info.time)) setText('raceTime', E['pi-race-time'], formatRaceTime(info.time));
    setText('raceBest', E['pi-race-best'], isNum(info.best) ? formatRaceTime(info.best) : '—');

    if (info.finished) {
      if (E['pi-race-banner-time'] && isNum(info.time)) {
        E['pi-race-banner-time'].textContent = formatRaceTime(info.time);
      }
      const beatBest =
        info.newRecord === true ||
        (isNum(info.time) && isNum(info.best) && info.time <= info.best + 1e-6);
      raceRecord = beatBest;
      if (E['pi-race-banner']) {
        E['pi-race-banner'].classList.add('is-on');
        E['pi-race-banner'].classList.toggle('is-record', beatBest);
      }
    } else if (E['pi-race-banner']) {
      E['pi-race-banner'].classList.remove('is-on', 'is-record');
    }
  }

  function flashDamage() {
    if (destroyed) return;
    const el = E['pi-damage'];
    if (!el) return;
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');
    clearTimeout(timers.damage);
    timers.damage = setTimeout(() => {
      if (!destroyed && el) el.classList.remove('is-on');
    }, 460);
  }

  function setMinimap(on) {
    if (destroyed) return;
    minimapOn = !!on;
    if (E['pi-minimap']) E['pi-minimap'].classList.toggle('is-on', minimapOn);
    if (minimapOn) {
      accMap = 0;
      drawMinimap();
    }
  }

  function toggleMinimap() {
    setMinimap(!minimapOn);
    return minimapOn;
  }

  function setCameraMode(mode) {
    if (destroyed) return;
    if (typeof mode !== 'string' || !CAMERA_MODES[mode]) return;
    camMode = mode;
    applyCameraMode();
  }

  function setDiscoveredTotal(n) {
    if (destroyed) return;
    if (isNum(n) && n >= 0) {
      poiTotal = n;
      applyDiscoveredText();
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const off of unsubs) {
      try {
        off();
      } catch (err) {
        /* ignore */
      }
    }
    unsubs.length = 0;
    clearTimeout(timers.discovery);
    clearTimeout(timers.damage);
    clearToastTimers();
    if (E['pi-toasts']) {
      while (E['pi-toasts'].firstChild) E['pi-toasts'].removeChild(E['pi-toasts'].firstChild);
    }
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  // -- wiring ---------------------------------------------------------------
  const unsubs = [];
  const bus = env.bus;

  unsubs.push(
    listen(bus, 'feather:collected', (p) => {
      if (destroyed) return;
      const c = asNum(p && (p.collected ?? p.count ?? p.index ?? p.n));
      const tt = asNum(p && (p.total ?? p.of));
      featherDone = c != null ? c : featherDone + 1;
      if (tt != null) featherTotal = tt;
      if (E['pi-hud-feathers']) {
        E['pi-hud-feathers'].classList.remove('is-pulse');
        void E['pi-hud-feathers'].offsetWidth;
        E['pi-hud-feathers'].classList.add('is-pulse');
      }
      setText('feather', E['pi-feather-count'], `${featherDone} / ${featherTotal || '—'}`);
    })
  );

  unsubs.push(
    listen(bus, 'poi:discovered', (p) => {
      if (destroyed) return;
      if (typeof p === 'string') {
        discovery(p, '', '');
        return;
      }
      if (!p || typeof p !== 'object') return;
      const name = p.name ?? p.label ?? p.title ?? p.id ?? '';
      const en = p.nameEn ?? p.labelEn ?? p.name_en ?? '';
      const sub = p.sub ?? p.blurb ?? p.description ?? p.text ?? '';
      discovery(name, en, sub);
      if (p.id != null && env.state && env.state.discovered) {
        env.state.discovered[p.id] = true;
      }
      poiCollected += 1;
      applyDiscoveredText();
    })
  );

  unsubs.push(
    listen(bus, 'race:start', (p) => {
      if (destroyed) return;
      setRace({
        checkpoint: 0,
        total: p && isNum(p.total) ? p.total : poiTotal,
        time: 0,
        best: p && isNum(p.best) ? p.best : null,
        finished: false,
      });
    })
  );

  unsubs.push(
    listen(bus, 'race:checkpoint', (p) => {
      if (destroyed) return;
      setRace({
        checkpoint: p && isNum(p.checkpoint) ? p.checkpoint : p && isNum(p.index) ? p.index : 0,
        total: p && isNum(p.total) ? p.total : poiTotal,
        time: p && isNum(p.time) ? p.time : 0,
        best: p && isNum(p.best) ? p.best : null,
        finished: false,
      });
    })
  );

  unsubs.push(
    listen(bus, 'race:finish', (p) => {
      if (destroyed) return;
      setRace({
        checkpoint: p && isNum(p.total) ? p.total : poiTotal,
        total: p && isNum(p.total) ? p.total : poiTotal,
        time: p && isNum(p.time) ? p.time : 0,
        best: p && isNum(p.best) ? p.best : null,
        finished: true,
        newRecord: !!(p && p.newRecord),
      });
    })
  );

  unsubs.push(listen(bus, 'rider:crash', () => flashDamage()));

  unsubs.push(
    listen(bus, 'camera:mode', (p) => {
      if (typeof p === 'string') setCameraMode(p);
      else if (p && typeof p.mode === 'string') setCameraMode(p.mode);
    })
  );

  unsubs.push(listen(bus, 'photo:enter', (p) => setPhotoMode(true, p || null)));
  unsubs.push(listen(bus, 'photo:exit', () => setPhotoMode(false, null)));

  unsubs.push(
    listen(bus, 'settings:changed', (p) => {
      if (!p || typeof p !== 'object') return;
      if (p.language === 'zh' || p.language === 'en') {
        if (p.language !== language) {
          language = p.language;
          applyLanguage();
        }
      }
    })
  );

  const onGridChip = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    togglePhotoGrid();
  };
  const gridChip = E['pi-photo-gridchip'];
  if (gridChip && typeof gridChip.addEventListener === 'function') {
    gridChip.addEventListener('click', onGridChip, { passive: true });
  }

  // -- mount ----------------------------------------------------------------
  buildCompass();
  buildSpeedometer();
  applyLanguage();
  applyNeedle(0, true);
  applyCompass(true);

  if (container && typeof container.appendChild === 'function') container.appendChild(root);

  return {
    root,
    update,
    destroy,
    toast,
    discovery,
    setLetterbox,
    setPhotoMode,
    setPaused,
    setLoading,
    setRace,
    flashDamage,
    setCompassHeading,
    toggleMinimap,
    togglePhotoGrid,
    setMinimap,
    setCameraMode,
    setDiscoveredTotal,
    isMinimapOpen: () => minimapOn,
    // read-only-ish views used by the dev harness
    get current() {
      return { photoOn, pausedOn, loadingOn, minimapOn, raceOn, raceRecord, photoGridOn, heading, camMode, language };
    },
  };
}

export default createHUD;
