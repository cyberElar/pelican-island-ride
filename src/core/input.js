/**
 * input.js - keyboard / gamepad / touch / pointer input.
 * `pressed()` returns true for one frame per key event; main.js must call
 * endFrame() at the very end of each update.
 */

import { clamp } from './utils.js';

const KEY_ACTIONS = {
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'brakeHard',
  ShiftLeft: 'boost', ShiftRight: 'boost',
  KeyC: 'camera',
  KeyP: 'photo',
  KeyM: 'map',
  KeyH: 'help',
  KeyT: 'time',
  KeyB: 'bell',
  KeyR: 'reset',
  KeyN: 'mute',
  KeyF: 'grid',
  KeyE: 'lookBack',
  KeyV: 'hud',
  Enter: 'race',
  Escape: 'pause',
  Digit1: 'ui1', Digit2: 'ui2', Digit3: 'ui3',
};

export function createInput(canvas) {
  const held = new Set();
  const pressedSet = new Set();
  const touchHeld = new Set();
  const touchAxes = { steer: 0, throttle: 0, brake: 0 };
  const pointerDelta = { dx: 0, dy: 0 };
  const axes = { steer: 0, throttle: 0, brake: 0 };
  const pointer = { x: 0, y: 0, dx: 0, dy: 0, down: false, wheel: 0 };
  let enabled = true;
  let dragging = false;

  /**
   * Hard reset of every input state. Used by disable/blur/gamepad loss so no
   * action (brakeHard from a gamepad, a stale touch axis, ...) can stay stuck.
   */
  function resetAll() {
    held.clear();
    pressedSet.clear();
    touchHeld.clear();
    touchAxes.steer = 0;
    touchAxes.throttle = 0;
    touchAxes.brake = 0;
    axes.steer = 0;
    axes.throttle = 0;
    axes.brake = 0;
    pointerDelta.dx = 0;
    pointerDelta.dy = 0;
    pointer.down = false;
    pointer.dx = 0;
    pointer.dy = 0;
    dragging = false;
  }

  function onKeyDown(e) {
    // A menu (or any other handler) that already consumed the key wins.
    if (e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const action = KEY_ACTIONS[e.code];
    if (action) {
      if (!held.has(action)) pressedSet.add(action);
      held.add(action);
      if (enabled && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
    }
  }
  function onKeyUp(e) {
    const action = KEY_ACTIONS[e.code];
    if (action) held.delete(action);
  }
  function onBlur() { resetAll(); }
  // Losing or gaining a pad invalidates whatever the pad reported last frame.
  function onGamepadChange() { resetAll(); }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('gamepadconnected', onGamepadChange);
  window.addEventListener('gamepaddisconnected', onGamepadChange);

  let lastClientX = 0;
  let lastClientY = 0;
  function onPointerMove(e) {
    const w = window.innerWidth, h = window.innerHeight;
    pointer.x = (e.clientX / w) * 2 - 1;
    pointer.y = (e.clientY / h) * 2 - 1;
    if (dragging) {
      // iOS Safari reports movementX/Y as 0 for touch pointers, so fall back
      // to the client-coordinate delta before giving up.
      let dx = e.movementX || 0;
      let dy = e.movementY || 0;
      if (!dx && !dy && e.pointerType !== 'mouse') {
        dx = e.clientX - lastClientX;
        dy = e.clientY - lastClientY;
      }
      pointerDelta.dx += dx;
      pointerDelta.dy += dy;
    }
    lastClientX = e.clientX;
    lastClientY = e.clientY;
  }
  function onPointerDown(e) {
    dragging = true;
    pointer.down = true;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    if (canvas.requestPointerLock && e.pointerType !== 'touch') {
      try { canvas.requestPointerLock?.(); } catch { /* ignore */ }
    }
  }
  function onPointerUp() { dragging = false; pointer.down = false; }
  function onWheel(e) { pointer.wheel += clamp(e.deltaY, -200, 200); }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: true });

  const input = {
    axes,
    pointer,
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (!enabled) resetAll(); },

    held(action) { return enabled && held.has(action); },
    pressed(action) { return enabled && pressedSet.has(action); },
    setTouchAxes(a) { if (a.steer !== undefined) touchAxes.steer = clamp(a.steer, -1, 1); if (a.throttle !== undefined) touchAxes.throttle = clamp(a.throttle, 0, 1); if (a.brake !== undefined) touchAxes.brake = clamp(a.brake, 0, 1); },
    touchButton(action, down) { if (down) { if (!touchHeld.has(action)) pressedSet.add(action); touchHeld.add(action); } else touchHeld.delete(action); },
    touchHeld(action) { return touchHeld.has(action); },

    consumePointerDelta() {
      const d = { dx: pointerDelta.dx, dy: pointerDelta.dy };
      pointerDelta.dx = 0; pointerDelta.dy = 0;
      return d;
    },

    update() {
      if (!enabled) { axes.steer = axes.throttle = axes.brake = 0; return; }
      let steer = (held.has('left') ? -1 : 0) + (held.has('right') ? 1 : 0);
      let throttle = held.has('throttle') ? 1 : 0;
      let brake = held.has('brake') ? 1 : 0;

      // Gamepad
      try {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        let sawPad = false;
        for (const pad of pads) {
          if (!pad || pad.connected === false) continue;
          sawPad = true;
          const ax = pad.axes[0] || 0;
          if (Math.abs(ax) > 0.12) steer += ax;
          const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
          const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
          throttle = Math.max(throttle, rt);
          brake = Math.max(brake, lt);
          if (pad.buttons[0] && pad.buttons[0].pressed) touchHeld.add('brakeHard');
          else touchHeld.delete('brakeHard');
          break;
        }
        // No usable pad this frame (unplugged / browser revoked access): the
        // pad-driven hard brake must not stay latched forever.
        if (!sawPad) touchHeld.delete('brakeHard');
      } catch { /* no gamepad support */ }

      steer += touchAxes.steer;
      throttle = Math.max(throttle, touchAxes.throttle);
      brake = Math.max(brake, touchAxes.brake);

      axes.steer = clamp(steer, -1, 1);
      axes.throttle = clamp(throttle, 0, 1);
      axes.brake = clamp(brake, 0, 1);
    },

    endFrame() {
      pressedSet.clear();
      pointer.wheel = 0;
    },

    dispose() {
      resetAll();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('gamepadconnected', onGamepadChange);
      window.removeEventListener('gamepaddisconnected', onGamepadChange);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };

  return input;
}
