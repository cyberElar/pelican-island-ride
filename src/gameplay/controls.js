/**
 * controls.js - arcade bicycle physics. Writes directly into state.player.
 *
 * Steering convention: heading is a Y-rotation where forward = (sin h, 0, cos h).
 * Increasing heading turns LEFT, so the "right" key decreases it. Lean is
 * positive when turning right (matches rider.root.rotation.z).
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, wrapAngle } from '../core/utils.js';

const MAX_SPEED = 13.2;          // ~47 km/h
const MAX_SPEED_BOOST = 16.6;    // ~60 km/h
const ACCEL = 7.4;
const BRAKE = 11.5;
const WHEEL_RADIUS = 0.34;

const SURFACE = {
  asphalt: { roll: 0.55, maxMul: 1.0 },
  gravel: { roll: 1.30, maxMul: 0.94 },
  grass: { roll: 2.20, maxMul: 0.80 },
  sand: { roll: 3.60, maxMul: 0.62 },
  rock: { roll: 2.70, maxMul: 0.72 },
  water: { roll: 5.0, maxMul: 0.5 },
};

export function createControls(ctx) {
  const { layout, bus, input } = ctx;
  const colliders = ctx.colliders || [];

  const _fwd = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  let groundY = 0;
  const spurIds = Object.keys(layout.spurs);
  const crashEvent = { speed: 0 };
  const resetEvent = { position: _pos };
  const splashEvent = { name: "splash", volume: 0.8 };
  const rescueToast = { title: "落水了，已返回最近路面", sub: "Back on the road" };

  function surfaceAt(x, z) {
    if (layout.onRoad(x, z, 1.0)) return 'asphalt';
    for (const id of spurIds) {
      if (layout.spurs[id].distance(x, z) < layout.spurs[id].width + 1.0) return 'gravel';
    }
    const biome = layout.biomeAt(x, z);
    if (biome === 'beach') return 'sand';
    if (biome === 'rock' || biome === 'snow') return 'rock';
    if (biome === 'river' || biome === 'lake' || biome === 'ocean') return 'water';
    return 'grass';
  }

  function spawn(state) {
    const s = layout.pois.spawn;
    const p = state.player;
    // start a little *before* the gate so the first thing the player does is
    // ride through the arch (and the banner is never on top of the camera)
    const back = 13;
    const x = s.position.x - Math.sin(s.heading) * back;
    const z = s.position.z - Math.cos(s.heading) * back;
    p.position.set(x, layout.heightAt(x, z) + 0.05, z);
    p.heading = s.heading ?? 0;
    p.speed = 0;
    p.velocity.set(0, 0, 0);
    p.crash = 0;
    p.boostStamina = 1;
    p.wheelSpin = 0;
    p.distanceTravelled = 0;
    groundY = p.position.y;
  }

  function reset(state) {
    const p = state.player;
    const proj = layout.projectToRoad(p.position.x, p.position.z);
    if (proj) {
      p.position.set(proj.x, proj.y + 0.05, proj.z);
      p.heading = Math.atan2(proj.dirX, proj.dirZ);
    } else {
      spawn(state);
    }
    p.speed = 0;
    p.velocity.set(0, 0, 0);
    p.crash = 0;
    p.airTime = 0;
    p.inWater = false;
    p.grounded = true;
    groundY = p.position.y;
    resetEvent.position = p.position;
    bus.emit('player:reset', resetEvent);
  }

  function update(dt, state) {
    const p = state.player;
    const ax = input.axes;
    if (state.race?.active && state.race.countdown > 0) {
      p.speed = 0;
      p.velocity.set(0, 0, 0);
      p.boost = false;
      return;
    }
    if (layout.waterDepth(p.position.x, p.position.z) > 0.45 && !layout.onRoad(p.position.x, p.position.z, 1)) {
      bus.emit('sfx', splashEvent);
      ctx.ocean?.splash?.(p.position.x, p.position.z, 1);
      reset(state);
      bus.emit('ui:toast', rescueToast);

      return;
    }

    p.crash = Math.max(0, p.crash - dt);
    const crashed = p.crash > 0;

    const throttle = crashed ? 0 : ax.throttle;
    const brake = ax.brake;
    const steerInput = clamp(ax.steer, -1, 1);
    // `touchHeld` carries gamepad and on-screen buttons, `held` the keyboard.
    const wantBoost = !crashed && (input.held('boost') || input.touchHeld?.('boost'))
      && p.boostStamina > 0.02 && throttle > 0.05;
    p.boost = wantBoost;
    p.boostStamina = wantBoost
      ? clamp01(p.boostStamina - dt * 0.15)
      : clamp01(p.boostStamina + dt * 0.07);

    // --- surface / water ---
    const x0 = p.position.x, z0 = p.position.z;
    const surface = surfaceAt(x0, z0);
    p.surface = surface;
    const surf = SURFACE[surface] || SURFACE.grass;
    p.onRoad = surface === 'asphalt' || surface === 'gravel';

    const depth = layout.waterDepth(x0, z0);
    p.inWater = depth > 0.45;
    p.splashCooldown = Math.max(0, (p.splashCooldown || 0) - dt);
    if (p.inWater && p.splashCooldown <= 0 && Math.abs(p.speed) > 2) {
      p.splashCooldown = 0.55;
      splashEvent.volume = clamp01(depth * 0.35);
      bus.emit('sfx', splashEvent);
      if (ctx.ocean?.splash) ctx.ocean.splash(x0, z0, clamp01(depth * 0.3) + 0.4);
    }

    // --- longitudinal ---
    const maxSpeed = wantBoost ? MAX_SPEED_BOOST : MAX_SPEED;
    let a = 0;
    if (throttle > 0 && !p.inWater) {
      a += ACCEL * throttle * surf.maxMul * (1 - clamp01(Math.max(0, p.speed) / maxSpeed));
      if (wantBoost) a += 3.2;
    }
    if (brake > 0) a -= BRAKE * brake * (0.4 + 0.6 * surf.maxMul);

    const sgn = Math.sign(p.speed);
    a -= sgn * (surf.roll * 0.16 + 0.0068 * p.speed * p.speed);
    if (p.inWater) a -= sgn * 7.0 * clamp01(depth);
    if (input.held('brakeHard') || input.touchHeld?.('brakeHard')) a -= sgn * 9.0;

    _fwd.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    const hAhead = layout.heightAt(x0 + _fwd.x * 2.2, z0 + _fwd.z * 2.2);
    const hBehind = layout.heightAt(x0 - _fwd.x * 2.2, z0 - _fwd.z * 2.2);
    const slope = (hAhead - hBehind) / 4.4;
    a -= slope * 7.0;

    p.speed = clamp(p.speed + a * dt, -3.0, MAX_SPEED_BOOST + 9);
    if (Math.abs(p.speed) < 0.04 && throttle < 0.01 && brake < 0.01) p.speed = 0;

    // --- steering ---
    const authority = 2.5 / (1 + Math.abs(p.speed) * 0.20);
    const speedFactor = clamp01(Math.abs(p.speed) / 1.1);
    const reverseSign = p.speed < -0.05 ? -1 : 1;
    p.heading = wrapAngle(p.heading - steerInput * authority * speedFactor * reverseSign * dt);
    p.steer = damp(p.steer, steerInput, 9, dt);
    const leanTarget = steerInput * clamp01(Math.abs(p.speed) / 8.5) * 0.40;
    p.lean = damp(p.lean, crashed ? -0.5 : leanTarget, 6.5, dt);

    // --- integrate + collisions ---
    _fwd.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    _pos.copy(p.position).addScaledVector(_fwd, p.speed * dt);

    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.active === false) continue;
      const dx = _pos.x - c.x, dz = _pos.z - c.z;
      const rr = (c.r || 1) + 0.44;
      const d2 = dx * dx + dz * dz;
      const moveX = _pos.x - x0, moveZ = _pos.z - z0;
      const move2 = moveX * moveX + moveZ * moveZ;
      const along = move2 > 0 ? clamp(((c.x - x0) * moveX + (c.z - z0) * moveZ) / move2, 0, 1) : 0;
      const nearX = x0 + moveX * along - c.x, nearZ = z0 + moveZ * along - c.z;
      if (d2 < rr * rr || nearX * nearX + nearZ * nearZ < rr * rr) {
        if (d2 >= rr * rr) { _pos.x = x0; _pos.z = z0; }
        const hitX = _pos.x - c.x, hitZ = _pos.z - c.z;
        const d = Math.max(0.001, Math.hypot(hitX, hitZ));
        const nx = hitX / d, nz = hitZ / d;
        _pos.x = c.x + nx * rr;
        _pos.z = c.z + nz * rr;
        const impact = Math.abs(p.speed);
        if (impact > 4.2) {
          crashEvent.speed = p.speed;
          if (p.crash <= 0) bus.emit('rider:crash', crashEvent);
          p.crash = 0.85;
        }
        p.speed *= 0.32;
      }
    }

    // --- terrain follow with suspension + light airborne physics ---
    groundY = layout.heightAt(_pos.x, _pos.z);
    const dy = groundY - p.position.y;
    if (dy < -1.2 && Math.abs(p.speed) > 6.5 && p.airTime <= 0) {
      p.airTime = 0.001;
      p.velocity.y = 1.2;
    }
    p.position.x = _pos.x;
    p.position.z = _pos.z;
    if (p.airTime > 0) {
      p.airTime += dt;
      p.velocity.y -= 12.5 * dt;
      p.position.y += p.velocity.y * dt;
      if (p.position.y <= groundY) {
        p.position.y = groundY;
        if (p.velocity.y < -9 && p.crash <= 0) {
          crashEvent.speed = Math.abs(p.velocity.y);
          bus.emit('rider:crash', crashEvent);
          p.crash = 0.85;
          p.speed *= 0.32;
        }
        p.velocity.y = 0;
        p.airTime = 0;
      }
    } else {
      p.position.y = lerp(p.position.y, groundY, 1 - Math.exp(-17 * dt));
      p.velocity.y = 0;
    }

    p.slope = slope;
    p.pitch = damp(p.pitch, Math.atan2(-slope, 1) * 0.75, 7, dt);
    p.velocity.x = _fwd.x * p.speed;
    p.velocity.z = _fwd.z * p.speed;
    p.wheelSpin += (p.speed / WHEEL_RADIUS) * dt;
    p.distanceTravelled += Math.abs(p.speed) * dt;
  }

  return {
    update,
    spawn,
    reset,
    surfaceAt,
    colliders,
    constants: { MAX_SPEED, MAX_SPEED_BOOST, WHEEL_RADIUS },
  };
}
