/**
 * menus.js - title / pause / settings / help / about screens for
 * "Pelican Island Ride" (提鹅鹏 · 单车环岛).
 *
 * Public API (see docs/SPEC.md §4.22):
 *   createMenus(ctx, opts) -> { root, show(screen), current, destroy(),
 *                               setLoadingProgress(p01, label) }
 *
 * opts.onStart(mode)          mode: 'ride' | 'free' | 'photo'
 * opts.onResume()             pause -> continue
 * opts.onSettingsChange(patch) { quality, musicVolume, sfxVolume, masterVolume,
 *                                muted, timeMode, language }
 * opts.onQuitToTitle()
 *
 * Everything is CSS/DOM: no images, no web fonts, no network. The title screen
 * is a layered paper-cut composition (gradient sky, sun disc, clip-path island
 * silhouettes) plus one thin SVG line-art vignette.
 */

import { clamp01 } from '../core/utils.js';

const TIP_MS = 4200;

const QUALITY_OPTIONS = [
  { value: 'low', zh: '低', en: 'LOW' },
  { value: 'medium', zh: '中', en: 'MEDIUM' },
  { value: 'high', zh: '高', en: 'HIGH' },
  { value: 'ultra', zh: '极高', en: 'ULTRA' },
];

const TIME_OPTIONS = [
  { value: 'dawn', zh: '黎明', en: 'DAWN' },
  { value: 'noon', zh: '正午', en: 'NOON' },
  { value: 'sunset', zh: '黄昏', en: 'SUNSET' },
  { value: 'night', zh: '夜晚', en: 'NIGHT' },
  { value: 'cycle', zh: '循环', en: 'CYCLE' },
];

const LANGUAGE_OPTIONS = [
  { value: 'zh', zh: '中文', en: 'CHINESE' },
  { value: 'en', zh: 'EN', en: 'ENGLISH' },
];

const VOLUME_ROWS = [
  { key: 'masterVolume', zh: '总音量', en: 'MASTER', testid: 'master' },
  { key: 'musicVolume', zh: '音乐', en: 'MUSIC', testid: 'music' },
  { key: 'sfxVolume', zh: '音效', en: 'SFX', testid: 'sfx' },
];

/** Camera shake amount (0 / low / medium / high). */
const SHAKE_OPTIONS = [
  { value: 'off', zh: '关', en: 'OFF' },
  { value: 'low', zh: '低', en: 'LOW' },
  { value: 'medium', zh: '中', en: 'MED' },
  { value: 'high', zh: '高', en: 'HIGH' },
];

const UI_SCALE_OPTIONS = [
  { value: '1', zh: '100%', en: 'NORMAL' },
  { value: '1.15', zh: '115%', en: 'LARGE' },
  { value: '1.3', zh: '130%', en: 'XL' },
];

/** Comfort defaults follow the OS "reduce motion" preference. */
function prefersReducedMotion(win) {
  try {
    const view = win || (typeof window !== 'undefined' ? window : null);
    if (!view || typeof view.matchMedia !== 'function') return false;
    return !!view.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
}

const TIPS = [
  '正在铺设环岛公路… COLLECTING GRAVEL',
  '正在种下松树林… PLANTING PINES',
  '正在放飞海鸥… SCATTERING GULLS',
  '提示：按 B 按铃 TIP: press B for the bell',
  '提示：夜间路上有萤火虫 TIP: fireflies at night',
  '正在调好夕阳的角度… AIMING THE SUNSET',
];

const KEY_ROWS = [
  ['W / ↑', '加速 PEDAL'],
  ['S / ↓', '后退 BRAKE'],
  ['A D / ← →', '转向 STEER'],
  ['空格 SPACE', '刹车 BRAKE HARD'],
  ['Shift', '冲刺 BOOST'],
  ['C', '切换相机 CAMERA'],
  ['P', '摄影模式 PHOTO MODE'],
  ['M', '地图 MINIMAP'],
  ['B', '车铃 BELL'],
  ['F', '取景网格 PHOTO GRID'],
  ['V', '摄影滤镜 PHOTO FILTER'],
  ['X', '导出照片 SAVE PHOTO'],
  ['T', '时间流转 TIME OF DAY'],
  ['R', '回到路面 RETURN TO ROAD'],
  ['N', '静音 MUTE'],
  ['Esc', '暂停 PAUSE'],
  ['Enter', '环岛计时赛 TIME TRIAL'],
];

/** Tolerant callback invocation - opts may be a bare object. */
function call(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch (err) {
    // A broken listener must never take the menu down.
  }
}

function asNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

function createNullMenus() {
  const noop = () => {};
  return {
    root: null,
    show: noop,
    destroy: noop,
    setLoadingProgress: noop,
    setLoading: noop,
    setSettings: noop,
    current: 'none',
    settings: {},
  };
}

// ---------------------------------------------------------------------------
// createMenus
// ---------------------------------------------------------------------------

export function createMenus(ctx = {}, opts = {}) {
  const env = ctx && typeof ctx === 'object' ? ctx : {};
  const options = opts && typeof opts === 'object' ? opts : {};
  const container = options.container || null;
  const doc =
    (container && container.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);

  if (!doc || typeof doc.createElement !== 'function') return createNullMenus();

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // -- state ----------------------------------------------------------------
  let destroyed = false;
  let currentScreen = 'none';
  let returnTo = 'title';
  const timers = new Set();
  let noteTimer = 0;

  const settings = {
    quality: 'high',
    masterVolume: 0.8,
    musicVolume: 0.55,
    sfxVolume: 0.85,
    muted: false,
    timeMode: 'sunset',
    language: 'zh',
    // Comfort / accessibility (see docs/research/fixes-mobile-a11y.md).
    reduceMotion: prefersReducedMotion(env.window),
    shakeIntensity: null,
    comfortFov: null,
    autoCinematic: null,
    uiScale: 1,
    captions: true,
  };
  // Unset comfort switches inherit the OS preference instead of a hard default.
  if (settings.shakeIntensity === null) settings.shakeIntensity = settings.reduceMotion ? 'off' : 'medium';
  if (settings.comfortFov === null) settings.comfortFov = settings.reduceMotion;
  if (settings.autoCinematic === null) settings.autoCinematic = !settings.reduceMotion;
  if (env.settings && typeof env.settings === 'object') {
    for (const k of Object.keys(settings)) {
      if (env.settings[k] !== undefined) settings[k] = env.settings[k];
    }
  }

  const root = doc.createElement('div');
  root.id = 'pi-menus';
  root.className = 'pi-menus';
  root.setAttribute('data-testid', 'menus-root');

  /** id -> element for the show()/current machinery. */
  const screens = {};

  // -- button factory -------------------------------------------------------
  function button(spec) {
    const classes = ['pi-btn'];
    if (spec.variant) classes.push(`pi-btn--${spec.variant}`);
    if (spec.inline) classes.push('pi-btn--inline');
    const btn = el('button', classes.join(' '));
    btn.type = 'button';
    btn.appendChild(el('span', 'pi-btn__zh', spec.zh));
    if (spec.en) btn.appendChild(el('span', 'pi-btn__en', spec.en));
    if (spec.testid) btn.setAttribute('data-testid', spec.testid);
    if (typeof spec.onClick === 'function') {
      btn.addEventListener('click', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        spec.onClick(ev);
      });
    }
    return btn;
  }

  function optionButton(group, option, onPick) {
    const btn = el('button', 'pi-option', option.zh);
    btn.type = 'button';
    btn.setAttribute('data-value', option.value);
    btn.setAttribute('data-testid', `${group}-${option.value}`);
    btn.setAttribute('aria-pressed', 'false');
    btn.title = option.en;
    btn.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      onPick(option.value);
    });
    return btn;
  }

  // -- settings plumbing ----------------------------------------------------
  function emitSettings(patch) {
    call(options.onSettingsChange, patch);
    // The HUD mirrors language from `settings:changed`; announcing here means
    // the chain works even when main.js only wires onSettingsChange.
    const bus = env.bus;
    if (bus && typeof bus.emit === 'function') {
      try {
        bus.emit('settings:changed', patch);
      } catch (err) {
        /* ignore */
      }
    }
  }

  function setSetting(patch, notify) {
    if (destroyed || !patch || typeof patch !== 'object') return;
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (settings[key] !== patch[key]) {
        settings[key] = patch[key];
        changed = true;
      } else if (!(key in settings)) {
        settings[key] = patch[key];
        changed = true;
      }
    }
    if (typeof patch.uiScale === 'number') applyUiScale(patch.uiScale);
    syncSettingsUI();
    if (notify !== false && changed) emitSettings(patch);
  }

  /** settings.uiScale -> the CSS variable the stylesheet multiplies. */
  function applyUiScale(v) {
    const n = asNum(v);
    if (n == null) return;
    try {
      const target = doc.documentElement;
      if (target && target.style && typeof target.style.setProperty === 'function') {
        target.style.setProperty('--pi-ui-scale', String(Math.max(0.85, Math.min(1.35, n))));
      }
    } catch (err) {
      /* ignore */
    }
  }

  const refs = {
    quality: null,
    time: null,
    language: null,
    shake: null,
    uiScale: null,
    toggles: {},
    muteBtn: null,
    note: null,
    volumes: {},
  };

  function setGroupValue(groupEl, value) {
    if (!groupEl) return;
    const kids = groupEl.children;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      const on = node.getAttribute('data-value') === value;
      node.classList.toggle('is-on', on);
      node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function syncSettingsUI() {
    setGroupValue(refs.quality, settings.quality);
    setGroupValue(refs.time, settings.timeMode);
    setGroupValue(refs.language, settings.language);
    setGroupValue(refs.shake, settings.shakeIntensity);
    setGroupValue(refs.uiScale, String(settings.uiScale));
    if (refs.toggles) {
      for (const key of Object.keys(refs.toggles)) {
        const entry = refs.toggles[key];
        if (!entry || !entry.btn) continue;
        const on = !!settings[key];
        entry.btn.classList.toggle('is-on', on);
        entry.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (entry.state) entry.state.textContent = on ? (entry.labels ? entry.labels.on : '开 ON') : (entry.labels ? entry.labels.off : '关 OFF');
      }
    }
    for (const row of VOLUME_ROWS) {
      const entry = refs.volumes[row.key];
      if (!entry) continue;
      const v = clamp01(asNum(settings[row.key]) ?? 0);
      if (entry.input) entry.input.value = String(v);
      if (entry.value) entry.value.textContent = `${Math.round(v * 100)}%`;
    }
    if (refs.muteBtn) {
      refs.muteBtn.classList.toggle('is-on', !!settings.muted);
      refs.muteBtn.setAttribute('aria-pressed', settings.muted ? 'true' : 'false');
      refs.muteBtn.textContent = settings.muted ? '已静音 MUTED' : '静音 MUTE';
    }
  }

  function flashNote(text) {
    const note = refs.note;
    if (!note) return;
    if (noteTimer) {
      clearTimeout(noteTimer);
      timers.delete(noteTimer);
      noteTimer = 0;
    }
    note.textContent = text;
    noteTimer = setTimeout(() => {
      timers.delete(noteTimer);
      noteTimer = 0;
      if (!destroyed) note.textContent = '设置自动保存 · SETTINGS SAVE AUTOMATICALLY';
    }, 1800);
    timers.add(noteTimer);
  }

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }

  function resetView() {
    const bus = env.bus;
    if (bus && typeof bus.emit === 'function') {
      try {
        // Documented bus event (docs/SPEC.md §5): main.js resets the camera.
        bus.emit('player:reset', {});
        flashNote('视角已重置 · VIEW RESET');
        return;
      } catch (err) {
        /* fall through to the callback */
      }
    }
    call(options.onSettingsChange, { resetView: true });
    flashNote('视角已重置 · VIEW RESET');
  }

  // -- sections -------------------------------------------------------------
  function section(zh, en, testid) {
    const node = el('section', 'pi-settings__section');
    if (testid) node.setAttribute('data-testid', testid);
    const head = el('div', 'pi-settings__head');
    head.appendChild(el('span', 'pi-settings__zh', zh));
    head.appendChild(el('span', 'pi-settings__en', en));
    node.appendChild(head);
    return node;
  }

  function row(labelZh, control) {
    const node = el('div', 'pi-settings__row');
    node.appendChild(el('span', 'pi-settings__label', labelZh));
    const wrap = el('div', 'pi-settings__control');
    wrap.appendChild(control);
    node.appendChild(wrap);
    return node;
  }

  function buildOptions(group, options_, testid, onPick) {
    const box = el('div', 'pi-options');
    if (testid) box.setAttribute('data-testid', testid);
    for (const opt of options_) box.appendChild(optionButton(group, opt, onPick));
    return box;
  }

  /**
   * On/off pill. Keeps the option look but shows the state in words so the
   * control does not rely on the highlighted style alone.
   */
  function toggleButton(spec) {
    const btn = el('button', 'pi-option pi-option--toggle');
    btn.type = 'button';
    if (spec.testid) btn.setAttribute('data-testid', spec.testid);
    btn.setAttribute('aria-pressed', 'false');
    const label = el('span', 'pi-option__zh', spec.zh);
    const state = el('span', 'pi-option__state', '关 OFF');
    btn.appendChild(label);
    btn.appendChild(state);
    btn.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      spec.onToggle();
    });
    return { btn, label, state, labels: spec.labels };
  }

  // -- title screen ---------------------------------------------------------
  function buildTitle() {
    const screen = el('div', 'pi-screen pi-screen--title');
    screen.id = 'pi-screen-title';
    screen.setAttribute('data-testid', 'screen-title');

    screen.appendChild(el('div', 'pi-title__sun'));
    screen.appendChild(el('div', 'pi-title__glare'));

    const islands = el('div', 'pi-title__islands');
    islands.appendChild(el('div', 'pi-isle pi-isle--far'));
    islands.appendChild(el('div', 'pi-isle pi-isle--mid'));
    islands.appendChild(el('div', 'pi-isle pi-isle--near'));
    screen.appendChild(islands);
    screen.appendChild(el('div', 'pi-title__lighthouse'));
    screen.appendChild(el('div', 'pi-title__horizon'));
    screen.appendChild(el('div', 'pi-title__reflection'));

    const content = el('div', 'pi-title__content');
    const left = el('div');

    const lockup = el('div', 'pi-title__lockup');
    const title = el('h1', 'pi-title__main', '提鹅鹏');
    title.id = 'pi-title-main';
    title.setAttribute('data-testid', 'title-main');
    const sub = el('p', 'pi-title__sub', '单车环岛');
    sub.id = 'pi-title-sub';
    sub.setAttribute('data-testid', 'title-sub');
    const en = el('p', 'pi-title__en', "A PELICAN'S ISLAND RIDE");
    en.id = 'pi-title-en';
    en.setAttribute('data-testid', 'title-en');
    lockup.appendChild(title);
    lockup.appendChild(sub);
    lockup.appendChild(en);
    left.appendChild(lockup);
    left.appendChild(el('div', 'pi-title__rule'));

    const buttons = el('div', 'pi-title__buttons');
    buttons.id = 'pi-title-buttons';
    buttons.setAttribute('data-testid', 'title-buttons');
    buttons.appendChild(
      button({
        zh: '开始骑行',
        en: 'START RIDE',
        variant: 'primary',
        testid: 'btn-start-ride',
        onClick: () => call(options.onStart, 'ride'),
      })
    );
    buttons.appendChild(
      button({
        zh: '自由环游',
        en: 'FREE RIDE',
        testid: 'btn-free-ride',
        onClick: () => call(options.onStart, 'free'),
      })
    );
    buttons.appendChild(
      button({
        zh: '摄影模式',
        en: 'PHOTO MODE',
        testid: 'btn-photo-mode',
        onClick: () => call(options.onStart, 'photo'),
      })
    );
    buttons.appendChild(
      button({
        zh: '设置',
        en: 'SETTINGS',
        testid: 'btn-title-settings',
        onClick: () => show('settings'),
      })
    );
    buttons.appendChild(
      button({
        zh: '关于与操作',
        en: 'ABOUT & CONTROLS',
        testid: 'btn-title-about',
        onClick: () => show('about'),
      })
    );
    left.appendChild(buttons);
    content.appendChild(left);

    const right = el('div', 'pi-title__right');
    const tagline = el('p', 'pi-title__tagline', '十七点十分，一只提鹅鹏骑上老单车，沿着环岛公路慢慢出发。');
    right.appendChild(tagline);

    const art = el('div', 'pi-title__art');
    art.id = 'pi-title-art';
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML = [
      '<svg class="pi-vignette" viewBox="0 0 400 150" role="presentation">',
      '<g class="pi-vignette__draw">',
      '<path d="M70 104 L150 60 L196 104 L70 104"></path>',
      '<path d="M196 104 L268 56 L300 104"></path>',
      '<path d="M150 60 L144 48"></path>',
      '<path d="M132 46 Q144 40 157 46"></path>',
      '<path d="M268 56 L276 38"></path>',
      '<path d="M262 36 Q278 27 292 39"></path>',
      '<ellipse cx="178" cy="34" rx="21" ry="14" transform="rotate(-6 178 34)"></ellipse>',
      '<path d="M160 28 Q178 19 196 28"></path>',
      '<path d="M192 26 Q206 8 221 14"></path>',
      '<circle cx="225" cy="15" r="8"></circle>',
      '<path d="M231 12 L266 20"></path>',
      '<path d="M231 20 Q250 32 264 22"></path>',
      '<path d="M172 46 L180 62 L196 62"></path>',
      '<path d="M157 26 Q141 20 129 27 Q141 31 155 35"></path>',
      '</g>',
      '<circle class="pi-vignette__wheel" cx="70" cy="104" r="30"></circle>',
      '<circle class="pi-vignette__wheel" cx="300" cy="104" r="30"></circle>',
      '<circle cx="196" cy="104" r="7"></circle>',
      '</svg>',
    ].join('');
    right.appendChild(art);
    content.appendChild(right);
    screen.appendChild(content);

    const hint = el('p', 'pi-title__hint', '按住 W 加速 · 空格 刹车 · C 切换相机 · P 摄影模式 · M 地图');
    hint.id = 'pi-title-hint';
    hint.setAttribute('data-testid', 'title-hint');
    screen.appendChild(hint);

    return screen;
  }

  // -- pause ---------------------------------------------------------------
  function buildPause() {
    const screen = el('div', 'pi-screen pi-screen--pause');
    screen.id = 'pi-screen-pause';
    screen.setAttribute('data-testid', 'screen-pause');
    const inner = el('div', 'pi-screen__inner');
    const card = el('div', 'pi-card');

    card.appendChild(el('div', 'pi-card__eyebrow', 'PAUSED'));
    card.appendChild(el('h2', 'pi-card__title', '暂停'));
    card.appendChild(el('p', 'pi-card__lead', '海风还在吹，单车停在路边。'));

    const actions = el('div', 'pi-card__actions');
    actions.appendChild(
      button({
        zh: '继续',
        en: 'RESUME',
        variant: 'primary',
        testid: 'btn-resume',
        onClick: () => call(options.onResume),
      })
    );
    actions.appendChild(
      button({ zh: '设置', en: 'SETTINGS', testid: 'btn-pause-settings', onClick: () => show('settings') })
    );
    actions.appendChild(
      button({
        zh: '回到标题',
        en: 'QUIT TO TITLE',
        variant: 'danger',
        testid: 'btn-quit-title',
        onClick: () => call(options.onQuitToTitle),
      })
    );
    card.appendChild(actions);

    const foot = el('div', 'pi-card__foot');
    foot.appendChild(el('span', 'pi-card__note', '按 Esc 或点按「继续」· ESC OR TAP TO RESUME'));
    card.appendChild(foot);

    inner.appendChild(card);
    screen.appendChild(inner);
    return screen;
  }

  // -- settings ------------------------------------------------------------
  function buildSettings() {
    const screen = el('div', 'pi-screen pi-screen--settings');
    screen.id = 'pi-screen-settings';
    screen.setAttribute('data-testid', 'screen-settings');
    const inner = el('div', 'pi-screen__inner');
    const card = el('div', 'pi-card pi-card--wide');

    card.appendChild(el('div', 'pi-card__eyebrow', 'SETTINGS'));
    card.appendChild(el('h2', 'pi-card__title', '设置'));

    const grid = el('div', 'pi-settings');

    // picture
    const pic = section('画面', 'PICTURE', 'settings-picture');
    refs.quality = buildOptions('quality', QUALITY_OPTIONS, 'quality-options', (v) =>
      setSetting({ quality: v })
    );
    pic.appendChild(row('画质', refs.quality));
    refs.time = buildOptions('time', TIME_OPTIONS, 'time-options', (v) =>
      setSetting({ timeMode: v })
    );
    pic.appendChild(row('时间', refs.time));
    grid.appendChild(pic);

    // sound
    const sound = section('声音', 'SOUND', 'settings-sound');
    for (const vol of VOLUME_ROWS) {
      const input = el('input', 'pi-range');
      input.type = 'range';
      input.min = '0';
      input.max = '1';
      input.step = '0.01';
      input.value = String(clamp01(asNum(settings[vol.key]) ?? 0));
      input.id = `pi-slider-${vol.testid}`;
      input.setAttribute('data-testid', `slider-${vol.testid}`);
      input.setAttribute('aria-label', vol.zh);
      const value = el('span', 'pi-settings__value', '');
      value.id = `pi-value-${vol.testid}`;
      value.setAttribute('data-testid', `value-${vol.testid}`);
      input.addEventListener(
        'input',
        () => {
          const v = clamp01(asNum(input.value) ?? 0);
          value.textContent = `${Math.round(v * 100)}%`;
          setSetting({ [vol.key]: v });
        },
        { passive: true }
      );
      refs.volumes[vol.key] = { input, value };
      const line = el('div', 'pi-settings__control');
      line.appendChild(input);
      line.appendChild(value);
      sound.appendChild(row(`${vol.zh} ${vol.en}`, line));
    }
    const muteBtn = el('button', 'pi-option', '静音 MUTE');
    muteBtn.type = 'button';
    muteBtn.id = 'pi-toggle-mute';
    muteBtn.setAttribute('data-testid', 'toggle-mute');
    muteBtn.setAttribute('aria-pressed', 'false');
    muteBtn.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      setSetting({ muted: !settings.muted });
    });
    refs.muteBtn = muteBtn;
    sound.appendChild(row('静音', muteBtn));
    grid.appendChild(sound);

    // language
    const lang = section('语言', 'LANGUAGE', 'settings-language');
    refs.language = buildOptions('lang', LANGUAGE_OPTIONS, 'language-options', (v) =>
      setSetting({ language: v })
    );
    lang.appendChild(row('界面语言', refs.language));
    grid.appendChild(lang);

    // comfort / accessibility
    const comfort = section('体验', 'COMFORT & ACCESS', 'settings-comfort');
    refs.shake = buildOptions('shake', SHAKE_OPTIONS, 'shake-options', (v) =>
      setSetting({ shakeIntensity: v })
    );
    comfort.appendChild(row('屏震强度', refs.shake));

    const fovToggle = toggleButton({
      zh: '舒适视角',
      testid: 'toggle-comfort-fov',
      labels: { on: '开 ON', off: '关 OFF' },
      onToggle: () => setSetting({ comfortFov: !settings.comfortFov }),
    });
    refs.toggles.comfortFov = fovToggle;
    comfort.appendChild(row('舒适视角', fovToggle.btn));

    const motionToggle = toggleButton({
      zh: '减少运动',
      testid: 'toggle-reduce-motion',
      labels: { on: '开 ON', off: '关 OFF' },
      onToggle: () => setSetting({ reduceMotion: !settings.reduceMotion }),
    });
    refs.toggles.reduceMotion = motionToggle;
    comfort.appendChild(row('减少运动', motionToggle.btn));

    const cineToggle = toggleButton({
      zh: '自动电影镜头',
      testid: 'toggle-auto-cinematic',
      labels: { on: '开 ON', off: '关 OFF' },
      onToggle: () => setSetting({ autoCinematic: !settings.autoCinematic }),
    });
    refs.toggles.autoCinematic = cineToggle;
    comfort.appendChild(row('自动镜头', cineToggle.btn));

    const captionToggle = toggleButton({
      zh: '字幕与音效提示',
      testid: 'toggle-captions',
      labels: { on: '开 ON', off: '关 OFF' },
      onToggle: () => setSetting({ captions: !settings.captions }),
    });
    refs.toggles.captions = captionToggle;
    comfort.appendChild(row('字幕/提示', captionToggle.btn));

    refs.uiScale = buildOptions('uiscale', UI_SCALE_OPTIONS, 'uiscale-options', (v) =>
      setSetting({ uiScale: asNum(v) ?? 1 })
    );
    comfort.appendChild(row('界面缩放', refs.uiScale));
    const comfortNote = el('p', 'pi-card__note', '减少运动默认跟随系统「减少动态效果」· FOLLOWS YOUR OS REDUCE-MOTION SETTING');
    comfort.appendChild(comfortNote);
    grid.appendChild(comfort);

    // other
    const other = section('其他', 'OTHER', 'settings-other');
    const resetBtn = button({
      zh: '重置视角',
      en: 'RESET VIEW · R',
      inline: true,
      testid: 'btn-reset-view',
      onClick: resetView,
    });
    other.appendChild(row('视角', resetBtn));
    const resetProgressBtn = button({
      zh: '重置进度',
      en: 'RESET PROGRESS',
      inline: true,
      testid: 'btn-reset-progress',
      onClick: () => {
        call(options.onResetProgress);
        flashNote('探索进度已重置 · PROGRESS RESET');
      },
    });
    other.appendChild(row('进度', resetProgressBtn));
    const noteLine = el('div', 'pi-settings__row');
    noteLine.appendChild(el('span', 'pi-settings__label', '存档'));
    const noteWrap = el('div', 'pi-settings__control pi-settings__control--split');
    noteWrap.appendChild(el('span', 'pi-settings__value', '本地'));
    noteWrap.appendChild(el('span', 'pi-card__note', '最佳成绩保存在本机 BEST TIME IS LOCAL'));
    noteLine.appendChild(noteWrap);
    other.appendChild(noteLine);
    grid.appendChild(other);

    card.appendChild(grid);

    const foot = el('div', 'pi-card__foot');
    const note = el('span', 'pi-card__note', '设置自动保存 · SETTINGS SAVE AUTOMATICALLY');
    note.id = 'pi-settings-note';
    refs.note = note;
    foot.appendChild(note);
    foot.appendChild(
      button({
        zh: '返回',
        en: 'BACK',
        inline: true,
        variant: 'ghost',
        testid: 'btn-settings-back',
        onClick: () => show(returnTo),
      })
    );
    card.appendChild(foot);

    inner.appendChild(card);
    screen.appendChild(inner);
    return screen;
  }

  // -- help ----------------------------------------------------------------
  function buildKeysCard(eyebrow, title, lead) {
    const card = el('div', 'pi-card pi-card--wide');
    card.appendChild(el('div', 'pi-card__eyebrow', eyebrow));
    card.appendChild(el('h2', 'pi-card__title', title));
    card.appendChild(el('p', 'pi-card__lead', lead));
    const list = el('ul', 'pi-keys');
    for (const [key, label] of KEY_ROWS) {
      const li = el('li', 'pi-keys__row');
      li.appendChild(el('span', 'pi-keys__k', key));
      li.appendChild(el('span', 'pi-keys__v', label));
      list.appendChild(li);
    }
    card.appendChild(list);
    const foot = el('div', 'pi-card__foot');
    foot.appendChild(el('span', 'pi-card__note', '手柄与触屏同样可用 · GAMEPAD & TOUCH SUPPORTED'));
    foot.appendChild(
      button({
        zh: '返回',
        en: 'BACK',
        inline: true,
        variant: 'ghost',
        testid: 'btn-help-back',
        onClick: () => show(returnTo),
      })
    );
    card.appendChild(foot);
    return card;
  }

  function buildAbout() {
    const screen = el('div', 'pi-screen pi-screen--about');
    screen.id = 'pi-screen-about';
    screen.setAttribute('data-testid', 'screen-about');
    const inner = el('div', 'pi-screen__inner');
    const card = buildKeysCard('ABOUT & CONTROLS', '提鹅鹏 · 单车环岛', 'A PELICAN\'S ISLAND RIDE');

    const body = el('div');
    body.setAttribute('data-testid', 'about-body');
    const lines = [
      '一座程序生成的小岛，一只提鹅鹏，一辆老式单车。没有加载的资源文件，地形、植被、天空与音乐全部在运行时生成。',
      '黄昏从十七点十分开始，昼夜会自己走完一圈。收集散落的金色羽毛，沿着环岛公路找齐地标，或者在计时赛里刷新自己的最佳成绩。',
      '按 Enter 在出生点开始环岛计时赛，按 M 打开地图，按 P 举起相机。',
    ];
    for (const line of lines) body.appendChild(el('p', 'pi-card__lead', line));
    card.insertBefore(body, card.querySelector('.pi-keys'));

    inner.appendChild(card);
    screen.appendChild(inner);
    return screen;
  }

  function buildHelp() {
    const screen = el('div', 'pi-screen pi-screen--help');
    screen.id = 'pi-screen-help';
    screen.setAttribute('data-testid', 'screen-help');
    const inner = el('div', 'pi-screen__inner');
    inner.appendChild(
      buildKeysCard('HELP', '操作', '键盘与手柄操作 · KEYBOARD & GAMEPAD CONTROLS')
    );
    screen.appendChild(inner);
    return screen;
  }

  // -- loading -------------------------------------------------------------
  const loadingEl = doc.createElement('div');
  loadingEl.id = 'pi-menu-loading';
  loadingEl.className = 'pi-menu-loading';
  loadingEl.setAttribute('data-testid', 'menu-loading');
  loadingEl.innerHTML = [
    '<svg class="pi-menu-loading__pelican" viewBox="0 0 118 56" role="presentation">',
    '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">',
    '<circle cx="12" cy="45" r="8"></circle>',
    '<circle cx="44" cy="45" r="8"></circle>',
    '<path d="M12 45 L28 31 L44 45 M28 31 L33 24"></path>',
    '<ellipse cx="32" cy="21" rx="17" ry="10"></ellipse>',
    '<path d="M44 15 Q56 4 68 10"></path>',
    '<circle cx="72" cy="10" r="6"></circle>',
    '<path d="M78 8 L104 15"></path>',
    '<path d="M78 15 Q92 24 105 16"></path>',
    '</g>',
    '</svg>',
    '<div class="pi-menu-loading__title" id="pi-menu-loading-title" data-testid="menu-loading-title">正在生成小岛…</div>',
    '<div class="pi-menu-loading__bar"><div class="pi-menu-loading__fill" id="pi-menu-loading-fill" data-testid="menu-loading-bar"></div></div>',
    '<div class="pi-menu-loading__label" id="pi-menu-loading-label" data-testid="menu-loading-label">生成地形</div>',
    '<div class="pi-menu-loading__tip" id="pi-menu-loading-tip" data-testid="menu-loading-tip">正在铺设环岛公路…</div>',
  ].join('');

  const loadingRefs = {
    fill: loadingEl.querySelector('#pi-menu-loading-fill'),
    label: loadingEl.querySelector('#pi-menu-loading-label'),
    tip: loadingEl.querySelector('#pi-menu-loading-tip'),
  };

  let loadingOn = false;
  let loadingProgress = 0;
  let tipIndex = 0;
  let tipTimer = 0;

  function rotateTip() {
    if (!loadingRefs.tip) return;
    tipIndex = (tipIndex + 1) % TIPS.length;
    loadingRefs.tip.textContent = TIPS[tipIndex];
  }

  function setLoadingProgress(p01, label) {
    if (destroyed) return;
    const p = clamp01(asNum(p01) ?? loadingProgress);
    loadingProgress = p;
    if (loadingRefs.fill) loadingRefs.fill.style.width = `${(p * 100).toFixed(1)}%`;
    if (label != null && loadingRefs.label) loadingRefs.label.textContent = String(label);
  }

  function setLoading(on, progress01, label) {
    if (destroyed) return;
    loadingOn = !!on;
    loadingEl.classList.toggle('is-on', loadingOn);
    if (progress01 != null) setLoadingProgress(progress01, label);
    else if (label != null && loadingRefs.label) loadingRefs.label.textContent = String(label);
    if (loadingOn) {
      if (!tipTimer) {
        tipTimer = setInterval(rotateTip, TIP_MS);
        timers.add(tipTimer);
      }
    } else if (tipTimer) {
      clearInterval(tipTimer);
      timers.delete(tipTimer);
      tipTimer = 0;
    }
  }

  // -- screen switching ----------------------------------------------------
  function build() {
    screens.title = buildTitle();
    screens.pause = buildPause();
    screens.settings = buildSettings();
    screens.help = buildHelp();
    screens.about = buildAbout();
    for (const name of Object.keys(screens)) root.appendChild(screens[name]);
    root.appendChild(loadingEl);
  }

  function focusables(node) {
    if (!node || typeof node.querySelectorAll !== 'function') return [];
    let list;
    try {
      list = node.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
    } catch (err) {
      return [];
    }
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function focusFirst() {
    const screen = screens[currentScreen];
    if (!screen) return;
    const list = focusables(screen);
    if (!list.length) return;
    // Prefer the currently selected control (e.g. the active quality) so the
    // focus ring never contradicts the highlighted value.
    let target = null;
    try {
      target = screen.querySelector('.pi-option.is-on');
    } catch (err) {
      target = null;
    }
    if (!target || list.indexOf(target) < 0) target = list[0];
    try {
      target.focus({ preventScroll: true });
    } catch (err) {
      try {
        target.focus();
      } catch (err2) {
        /* ignore */
      }
    }
  }

  function show(screen) {
    if (destroyed) return;
    const next = screens[screen] ? screen : 'none';
    const prev = currentScreen;
    if (prev === 'title' || prev === 'pause' || prev === 'none') returnTo = prev;
    currentScreen = next;
    for (const name of Object.keys(screens)) {
      screens[name].classList.toggle('is-active', name === next);
    }
    root.classList.toggle('is-visible', next !== 'none');
    if (next !== 'none' && next !== prev) focusFirst();
  }

  // -- input ---------------------------------------------------------------
  function onKeyDown(ev) {
    if (destroyed || currentScreen === 'none') return;
    const key = ev.key || '';
    if (key === 'Tab') {
      // Keep focus inside the open panel: Tab must not wander into the
      // browser chrome (or back into the canvas) while a menu owns the screen.
      const list = focusables(screens[currentScreen]);
      if (list.length < 2) return;
      const active = doc.activeElement;
      const index = list.indexOf(active);
      const step = ev.shiftKey ? -1 : 1;
      const nextIndex = index < 0 ? 0 : (index + step + list.length) % list.length;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      try {
        list[nextIndex].focus({ preventScroll: true });
      } catch (err) {
        list[nextIndex].focus();
      }
      return;
    }
    if (key === 'Escape' || key === 'Esc') {
      if (currentScreen === 'settings' || currentScreen === 'help' || currentScreen === 'about') {
        ev.preventDefault();
        show(returnTo);
      }
      return;
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' && key !== 'ArrowRight') {
      return;
    }
    const target = ev.target;
    if (target && typeof target.closest === 'function' && target.closest('input[type="range"]')) {
      return; // let the slider keep its arrow keys
    }
    const list = focusables(screens[currentScreen]);
    if (list.length < 2) return;
    let index = list.indexOf(target);
    if (index < 0) index = key === 'ArrowUp' || key === 'ArrowLeft' ? 0 : -1;
    const step = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
    const nextIndex = (index + step + list.length) % list.length;
    ev.preventDefault();
    try {
      list[nextIndex].focus({ preventScroll: true });
    } catch (err) {
      list[nextIndex].focus();
    }
  }

  // -- boot ----------------------------------------------------------------
  build();
  if (container && typeof container.appendChild === 'function') container.appendChild(root);
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('keydown', onKeyDown, { passive: false });
  }
  // The HUD help chip and the touch pad both ask for the controls panel.
  let offHelp = null;
  {
    const bus = env.bus;
    if (bus && typeof bus.on === 'function') {
      try {
        offHelp = bus.on('ui:help', () => {
          if (destroyed) return;
          if (currentScreen === 'none' || currentScreen === 'pause') show('help');
        });
      } catch (err) {
        offHelp = null;
      }
    }
  }
  syncSettingsUI();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimers();
    if (typeof offHelp === 'function') {
      try { offHelp(); } catch (err) { /* ignore */ }
      offHelp = null;
    }
    if (tipTimer) clearInterval(tipTimer);
    tipTimer = 0;
    if (typeof root.removeEventListener === 'function') root.removeEventListener('keydown', onKeyDown);
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  return {
    root,
    show,
    destroy,
    setLoadingProgress,
    setLoading,
    // notify=true so boot-time restore reaches the camera (motion comfort),
    // the HUD (captions / UI scale) and main.js in one hop.
    setSettings: (patch) => setSetting(patch, true),
    syncSettingsUI,
    get current() {
      return currentScreen;
    },
    get returnTo() {
      return returnTo;
    },
    get settings() {
      return settings;
    },
  };
}

export default createMenus;
