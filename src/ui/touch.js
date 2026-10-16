/**
 * touch.js - on-screen driving controls for phones and tablets.
 *
 * The keyboard-free way into the game:
 *   - a floating steering joystick: press anywhere on the left half of the
 *     screen and drag sideways; the ghost ring marks where the finger landed
 *     and the knob shows the deflection (dead zone + smoothstep response);
 *   - pedal / brake buttons on the bottom right that can be held, tapped
 *     (a quick tap keeps a short push alive) or pressed simultaneously with
 *     the stick - every pointer is tracked by id, so multi-touch works;
 *   - a column of momentary action buttons (camera, map, photo, pause, help,
 *     bell, time trial) that reuse `input.touchButton(action, down)`, which
 *     feeds the same `pressed(action)` path the keyboard uses.
 *
 * Everything is wired through the existing input API, so no gameplay module
 * needs to know the controls are on screen:
 *   input.setTouchAxes({ steer, throttle, brake })
 *   input.touchButton(action, down)
 *
 * The module is DOM-only and degrades to a null object when there is no
 * document (SSR / headless boot) or no usable input object.
 */

const STICK_RADIUS = 58;        // CSS px of knob travel
const STICK_DEADZONE = 0.14;    // fraction of the radius before steering starts
const TAP_MS = 220;             // press shorter than this counts as a tap
const TAP_LATCH_MS = 650;       // the tap keeps the pedal down this long
const AXIS_SMOOTH = 16;         // per-second damping of the steer axis

const ACTION_BUTTONS = [
  { action: 'camera', zh: '视角', en: 'CAMERA' },
  { action: 'map', zh: '地图', en: 'MAP' },
  { action: 'photo', zh: '拍照', en: 'PHOTO' },
  { action: 'pause', zh: '暂停', en: 'PAUSE' },
  // Secondary actions stay off the portrait pad (it would cover the HUD) and
  // appear in the landscape row, where there is room.
  { action: '__help', zh: '操作', en: 'HELP', more: true },
  { action: 'bell', zh: '车铃', en: 'BELL', more: true },
  { action: 'race', zh: '计时赛', en: 'TIME TRIAL', more: true },
];

const HINT_ZH = '左半屏滑动转向 · 右下按住加速';
const HINT_EN = 'Drag left to steer · hold right pad to pedal';

function createNullTouch() {
  const noop = () => {};
  return {
    root: null,
    visible: false,
    hasTouch: false,
    state: { steer: 0, throttle: 0, brake: 0, stickActive: false, actions: 0 },
    update: noop,
    setVisible: noop,
    destroy: noop,
  };
}

function smoothstep(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * @param {object} input  the object returned by createInput()
 * @param {object} ctx    optional { container, bus, window, document }
 */
export function createTouchControls(input, ctx = {}) {
  const env = ctx && typeof ctx === 'object' ? ctx : {};
  const container = env.container || null;
  const doc =
    env.document ||
    (container && container.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);
  const win =
    env.window ||
    (doc && doc.defaultView) ||
    (typeof window !== 'undefined' ? window : null);

  if (!doc || typeof doc.createElement !== 'function') return createNullTouch();
  if (!input || typeof input.setTouchAxes !== 'function') return createNullTouch();

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // ---------------------------------------------------------------- detection
  const mq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(pointer: coarse)') : null;
  const nav = win && win.navigator ? win.navigator : null;
  // `'ontouchstart' in window` is true on plenty of desktop browsers, so the
  // heuristics stay narrow and the first real touch pointer fills the gap.
  let touchDevice = !!((mq && mq.matches) || (nav && nav.maxTouchPoints > 0));
  /** Set once a real touch pointer is seen, even if the heuristics said mouse. */
  let touchSeen = false;
  let hostVisible = true;
  let destroyed = false;

  // -------------------------------------------------------------------- markup
  const root = el('div', 'pi-touch');
  root.id = 'pi-touch';
  root.setAttribute('data-testid', 'touch-controls');
  root.setAttribute('aria-hidden', 'false');
  // Hidden until the first update() confirms a ride is actually running, so
  // the pad never flashes on the title screen.
  root.classList.add('is-off');

  // Steering: an invisible full-height zone over the left half of the screen,
  // a ghost ring that follows the finger and the knob that shows deflection.
  const zone = el('div', 'pi-touch__zone');
  zone.id = 'pi-touch-zone';
  zone.setAttribute('data-testid', 'touch-steer-zone');
  const ring = el('div', 'pi-touch__ring');
  ring.id = 'pi-touch-ring';
  ring.setAttribute('aria-hidden', 'true');
  const stick = el('div', 'pi-touch__stick');
  stick.id = 'pi-touch-stick';
  stick.setAttribute('data-testid', 'touch-stick');
  stick.setAttribute('aria-hidden', 'true');
  const knob = el('div', 'pi-touch__knob');
  knob.id = 'pi-touch-knob';
  knob.setAttribute('data-testid', 'touch-knob');
  stick.appendChild(el('span', 'pi-touch__axis pi-touch__axis--l', '左'));
  stick.appendChild(el('span', 'pi-touch__axis pi-touch__axis--r', '右'));
  stick.appendChild(knob);
  zone.appendChild(ring);
  zone.appendChild(stick);
  root.appendChild(zone);

  // Pedal / brake
  const pad = el('div', 'pi-touch__pad');
  const brakeBtn = el('button', 'pi-touch__btn pi-touch__btn--brake');
  brakeBtn.type = 'button';
  brakeBtn.id = 'pi-touch-brake';
  brakeBtn.setAttribute('data-testid', 'touch-brake');
  brakeBtn.setAttribute('aria-label', '刹车 BRAKE');
  brakeBtn.appendChild(el('span', 'pi-touch__btn-zh', '刹车'));
  brakeBtn.appendChild(el('span', 'pi-touch__btn-en', 'BRAKE'));
  const goBtn = el('button', 'pi-touch__btn pi-touch__btn--go');
  goBtn.type = 'button';
  goBtn.id = 'pi-touch-throttle';
  goBtn.setAttribute('data-testid', 'touch-throttle');
  goBtn.setAttribute('aria-label', '加速 PEDAL');
  goBtn.appendChild(el('span', 'pi-touch__btn-zh', '加速'));
  goBtn.appendChild(el('span', 'pi-touch__btn-en', 'PEDAL'));
  pad.appendChild(brakeBtn);
  pad.appendChild(goBtn);
  root.appendChild(pad);

  // Momentary actions (camera / map / photo / pause / help / bell / race)
  const actions = el('div', 'pi-touch__actions');
  const actionNodes = new Map();
  for (const spec of ACTION_BUTTONS) {
    const btn = el('button', 'pi-touch__act');
    btn.type = 'button';
    if (spec.more) btn.className += ' pi-touch__act--more';
    btn.id = `pi-touch-act-${spec.action === '__help' ? 'help' : spec.action}`;
    btn.setAttribute('data-testid', `touch-act-${spec.action === '__help' ? 'help' : spec.action}`);
    btn.setAttribute('data-action', spec.action);
    btn.setAttribute('aria-label', `${spec.zh} ${spec.en}`);
    btn.appendChild(el('span', 'pi-touch__act-zh', spec.zh));
    actions.appendChild(btn);
    actionNodes.set(spec.action, btn);
  }
  root.appendChild(actions);

  const hint = el('div', 'pi-touch__hint', `${HINT_ZH} · ${HINT_EN}`);
  hint.id = 'pi-touch-hint';
  hint.setAttribute('data-testid', 'touch-hint');
  root.appendChild(hint);

  // ------------------------------------------------------------------ runtime
  let targetSteer = 0;
  let axisSteer = 0;
  let throttle = 0;
  let brake = 0;
  let stickPointer = null;
  let originX = 0;
  let originY = 0;
  let goPointer = null;
  let goDownAt = 0;
  let latchUntil = 0;
  let hintTimer = 0;
  let hintShown = false;
  let actionCount = 0;
  /** False while the host says the world is frozen (pause / photo / title). */
  let interactive = true;

  const now = () => (win && typeof win.performance?.now === 'function' ? win.performance.now() : Date.now());

  function pressGo(down) {
    if (down) {
      if (goPointer === null) goPointer = true;
      goDownAt = now();
      latchUntil = 0;
      goBtn.classList.add('is-down');
    } else {
      const heldMs = now() - goDownAt;
      goPointer = null;
      goBtn.classList.remove('is-down');
      // A quick tap still gives a short push so the bike gets moving.
      latchUntil = heldMs < TAP_MS ? now() + TAP_LATCH_MS : 0;
    }
  }

  function pressBrake(down) {
    brake = down ? 1 : 0;
    brakeBtn.classList.toggle('is-down', !!down);
  }

  function setStick(clientX, clientY) {
    const r = STICK_RADIUS;
    let vx = clientX - originX;
    let vy = clientY - originY;
    const dist = Math.hypot(vx, vy);
    if (dist > r) {
      vx = (vx / dist) * r;
      vy = (vy / dist) * r;
    }
    const nx = vx / r;
    const a = Math.abs(nx);
    targetSteer = a <= STICK_DEADZONE
      ? 0
      : Math.sign(nx) * smoothstep((a - STICK_DEADZONE) / (1 - STICK_DEADZONE));
    knob.style.transform = `translate(${vx.toFixed(1)}px, ${vy.toFixed(1)}px)`;
    stick.style.setProperty('--pi-touch-tilt', nx.toFixed(3));
  }

  function releaseStick() {
    stickPointer = null;
    targetSteer = 0;
    knob.style.transform = '';
    stick.style.removeProperty('--pi-touch-tilt');
    ring.classList.remove('is-on');
    stick.classList.remove('is-active');
  }

  function onZoneDown(e) {
    if (!shown()) return;
    // Paused, in photo mode or on the title screen the left half must stay
    // free: photo mode drags there to look around.
    if (!interactive) return;
    if (e.pointerType === 'mouse' && !touchDevice && !touchSeen) return;
    if (stickPointer !== null) return; // one steering finger at a time
    stickPointer = e.pointerId !== undefined ? e.pointerId : 1;
    originX = e.clientX || 0;
    originY = e.clientY || 0;
    ring.style.left = `${originX}px`;
    ring.style.top = `${originY}px`;
    ring.classList.add('is-on');
    stick.classList.add('is-active');
    if (typeof zone.setPointerCapture === 'function') {
      try { zone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (typeof e.preventDefault === 'function') e.preventDefault();
    setStick(originX, originY);
  }

  function onZoneMove(e) {
    if (stickPointer === null) return;
    if (!interactive) return;
    if (e.pointerId !== undefined && e.pointerId !== stickPointer) return;
    setStick(e.clientX || 0, e.clientY || 0);
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  function onZoneUp(e) {
    if (stickPointer === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== stickPointer) return;
    releaseStick();
  }

  /**
   * Safety net: some browsers retarget (or drop) the final pointerup when the
   * finger leaves the element, and a stuck steering axis is worse than a
   * redundant release. Any pointer ending anywhere releases the stick.
   */
  function onAnyPointerEnd() {
    if (stickPointer !== null) releaseStick();
  }

  function bindHoldButton(btn, onDown, onUp) {
    let pointerId = null;
    let keyDown = false;
    const down = (e) => {
      pointerId = e && e.pointerId !== undefined ? e.pointerId : 1;
      if (typeof btn.setPointerCapture === 'function') {
        try { btn.setPointerCapture(pointerId); } catch { /* ignore */ }
      }
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      onDown();
    };
    const up = (e) => {
      if (e && e.pointerId !== undefined && pointerId !== null && e.pointerId !== pointerId) return;
      pointerId = null;
      onUp();
    };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    // Keyboard / screen-reader parity: the buttons are real <button>s.
    btn.addEventListener('keydown', (e) => {
      if (keyDown) return;
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      keyDown = true;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      onDown();
    });
    btn.addEventListener('keyup', (e) => {
      if (!keyDown) return;
      keyDown = false;
      onUp();
    });
    btn.addEventListener('blur', () => {
      keyDown = false;
      if (pointerId === null) onUp();
    });
  }

  // Momentary actions reuse the keyboard "pressed once" path.
  function fireAction(action) {
    actionCount += 1;
    if (action === '__help') {
      const bus = env.bus;
      if (bus && typeof bus.emit === 'function') {
        try { bus.emit('ui:help', { source: 'touch' }); } catch { /* ignore */ }
      }
      return;
    }
    if (typeof input.touchButton !== 'function') return;
    input.touchButton(action, true);
    const release = () => input.touchButton(action, false);
    if (win && typeof win.setTimeout === 'function') win.setTimeout(release, 90);
    else release();
  }

  function bindActionButton(btn, action) {
    btn.addEventListener('pointerdown', (e) => {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      btn.classList.add('is-down');
      fireAction(action);
    });
    const up = () => btn.classList.remove('is-down');
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('click', (e) => {
      // Keyboard activation only: pointer presses already fired on pointerdown.
      if (e && e.detail === 0) fireAction(action);
    });
  }

  zone.addEventListener('pointerdown', onZoneDown);
  zone.addEventListener('pointermove', onZoneMove);
  zone.addEventListener('pointerup', onZoneUp);
  zone.addEventListener('pointercancel', onZoneUp);
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('pointerup', onAnyPointerEnd, true);
    win.addEventListener('pointercancel', onAnyPointerEnd, true);
  }
  bindHoldButton(goBtn, () => pressGo(true), () => pressGo(false));
  bindHoldButton(brakeBtn, () => pressBrake(true), () => pressBrake(false));
  for (const [action, btn] of actionNodes) bindActionButton(btn, action);

  // Reveal the pad as soon as a real touch happens, even if start-up
  // detection guessed "mouse" (hybrid laptops, Android desktops, ...).
  function onFirstTouch(e) {
    if (!e || e.pointerType !== 'touch') return;
    touchSeen = true;
    syncVisibility();
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pointerdown', onFirstTouch, true);
  }
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('pointerdown', onFirstTouch, true);
  }

  function shown() {
    return !destroyed && hostVisible && (touchDevice || touchSeen);
  }

  /** Host-driven visibility (main.js may hide the pad, e.g. for screenshots). */
  function setVisible(v) {
    hostVisible = v !== false;
    syncVisibility();
  }

  function syncVisibility() {
    const on = shown();
    root.classList.toggle('is-on', on);
    root.setAttribute('aria-hidden', on ? 'false' : 'true');
    // Lets the stylesheet move HUD chrome out of the pad's corners.
    try {
      const body = doc.body;
      if (body && body.classList) body.classList.toggle('pi-has-touch', on);
    } catch (err) {
      /* ignore */
    }
    if (!on) {
      releaseStick();
      pressBrake(false);
      latchUntil = 0;
      throttle = 0;
      axisSteer = 0;
      input.setTouchAxes({ steer: 0, throttle: 0, brake: 0 });
    } else if (!hintShown) {
      hintShown = true;
      root.classList.add('is-hinting');
      if (win && typeof win.setTimeout === 'function') {
        hintTimer = win.setTimeout(() => root.classList.remove('is-hinting'), 7000);
      }
    }
  }

  function update(dt, state) {
    if (destroyed) return;
    const step = typeof dt === 'number' && isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0.016;
    const s = state || {};
    const inactive = s.paused === true || s.photoMode === true || s.started === false || input.enabled === false;
    interactive = !inactive;
    root.classList.toggle('is-idle', !!inactive);
    root.classList.toggle('is-off', s.started === false);
    // Photo mode owns the whole frame (drag to look), so the stick and pedals
    // step aside and only the action buttons stay reachable.
    root.classList.toggle('is-photo', s.photoMode === true);
    if (inactive) {
      if (throttle !== 0 || brake !== 0 || axisSteer !== 0 || targetSteer !== 0) {
        throttle = 0;
        brake = 0;
        axisSteer = 0;
        targetSteer = 0;
        releaseStick();
        pressBrake(false);
        input.setTouchAxes({ steer: 0, throttle: 0, brake: 0 });
      }
      return;
    }
    if (!shown()) return;

    // pedal: button held, or the short latch from a quick tap
    if (goPointer !== null) throttle = 1;
    else if (latchUntil && now() < latchUntil) throttle = Math.max(0.35, 1 - (latchUntil - now()) / TAP_LATCH_MS * 0.65);
    else {
      throttle = 0;
      latchUntil = 0;
    }

    // Releasing snaps back faster than steering ramps up, so a quick flick
    // never leaves the bike leaning.
    const lambda = targetSteer === 0 ? AXIS_SMOOTH * 1.8 : AXIS_SMOOTH;
    const k = 1 - Math.exp(-lambda * step);
    axisSteer += (targetSteer - axisSteer) * k;
    if (Math.abs(axisSteer) < 0.002) axisSteer = 0;
    input.setTouchAxes({ steer: axisSteer, throttle, brake });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    releaseStick();
    input.setTouchAxes({ steer: 0, throttle: 0, brake: 0 });
    zone.removeEventListener('pointerdown', onZoneDown);
    zone.removeEventListener('pointermove', onZoneMove);
    zone.removeEventListener('pointerup', onZoneUp);
    zone.removeEventListener('pointercancel', onZoneUp);
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('pointerdown', onFirstTouch, true);
      win.removeEventListener('pointerup', onAnyPointerEnd, true);
      win.removeEventListener('pointercancel', onAnyPointerEnd, true);
    }
    if (hintTimer && win && typeof win.clearTimeout === 'function') win.clearTimeout(hintTimer);
    hintTimer = 0;
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  if (container && typeof container.appendChild === 'function') container.appendChild(root);
  syncVisibility();

  return {
    root,
    get visible() { return shown(); },
    get hasTouch() { return touchDevice || touchSeen; },
    get state() {
      return { steer: axisSteer, throttle, brake, stickActive: stickPointer !== null, actions: actionCount };
    },
    update,
    setVisible,
    destroy,
  };
}

export default createTouchControls;
