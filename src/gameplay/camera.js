/**
 * camera.js - camera director with five modes:
 *   chase       spring-arm third person with speed FOV
 *   firstPerson handlebar view
 *   cinematic   auto director: idle orbit + POI flybys
 *   photo       free-fly photo mode (drives DOF through post)
 *   tour        title-screen spline flyover
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, angleDamp, lerp, TAU } from '../core/utils.js';

export function createCameraController(ctx) {
  const { engine, layout, input, bus } = ctx;
  const camera = engine.camera;
  const mode = { current: 'tour' };

  const chase = {
    pos: new THREE.Vector3(0, 60, 0),
    look: new THREE.Vector3(0, 0, 0),
    fov: 55,
  };

  const first = { fov: 68 };

  const cine = {
    phase: 'idle',
    timer: 0,
    angle: 0,
    radius: 46,
    target: new THREE.Vector3(),
    targetLook: new THREE.Vector3(),
    blend: 0,
  };

  const photo = {
    pos: new THREE.Vector3(),
    yaw: 0,
    pitch: -0.15,
    fov: 45,
    focusDist: 12,
    aperture: 0.55,
    filter: 0,
    speed: 8,
  };

  const tour = { t: 0.06, speed: 0.0035 };
  let tourCurve = null;
  let tourLookCurve = null;

  function buildTour() {
    // wide, cinematic orbit halfway up the island
    const pts = [];
    const look = [];
    const R = 2600;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.6;
      const r = R * (0.85 + 0.25 * Math.sin(i * 1.7));
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = layout.heightAt(x, z);
      pts.push(new THREE.Vector3(x, Math.max(120, y + 120 + 40 * Math.sin(i * 2.1)), z));
      const la = a + 0.9;
      const lr = 700 * (0.6 + 0.5 * Math.cos(i * 1.1));
      const lx = Math.cos(la) * lr;
      const lz = Math.sin(la) * lr;
      look.push(new THREE.Vector3(lx, Math.max(30, layout.heightAt(lx, lz) + 30), lz));
    }
    tourCurve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
    tourLookCurve = new THREE.CatmullRomCurve3(look, true, 'catmullrom', 0.5);
  }
  buildTour();

  const shakeState = { amount: 0, seed: Math.random() * 100 };
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  let lastCrash = 0;

  function setMode(m) {
    if (mode.current === m) return;
    mode.current = m;
    if (m === 'photo') {
      photo.pos.copy(camera.position);
      _e.setFromQuaternion(camera.quaternion, 'YXZ');
      photo.yaw = _e.y;
      photo.pitch = _e.x;
      photo.focusDist = 12;
    }
    bus.emit('camera:mode', { mode: m });
  }

  function addShake(amount) {
    shakeState.amount = Math.max(shakeState.amount, amount);
  }

  function aimAt(camPos, target, dt, lambda = 9) {
    _m.lookAt(camPos, target, camera.up);
    _q.setFromRotationMatrix(_m);
    camera.quaternion.slerp(_q, 1 - Math.exp(-lambda * dt));
  }

  /** Cinematic flyby around a point (used by discovery events). */
  function flyby(position, duration = 7, radius = 46) {
    cine.phase = 'flyby';
    cine.timer = duration;
    cine.target.copy(position);
    cine.radius = radius;
    // Start on the sunlit side so the establishing shot is not backlit.
    const sun = ctx.state?.sun?.dir;
    cine.angle = sun ? Math.atan2(sun.x, sun.z) + 1.15 : 0.8;
    cine.blend = 0;
    setMode('cinematic');
  }

  function update(dt, state) {
    const p = state.player;
    const speed = Math.abs(p.speed);

    // crash → shake
    if (p.crash > 0.55 && lastCrash <= 0.55) addShake(0.5);
    lastCrash = p.crash;

    // ---- mode switching ----
    if (mode.current === 'photo') {
      updatePhoto(dt);
    } else if (mode.current === 'tour') {
      updateTour(dt, state);
    } else if (mode.current === 'cinematic') {
      updateCinematic(dt, state);
    } else if (mode.current === 'firstPerson') {
      updateFirstPerson(dt, state);
    } else {
      updateChase(dt, state);
    }

    // ---- shake ----
    if (shakeState.amount > 0.0005) {
      const t = engine.elapsed * 43 + shakeState.seed;
      const a = shakeState.amount;
      _v.set(Math.sin(t * 1.7) * a, Math.sin(t * 2.3 + 1.1) * a * 0.7, Math.sin(t * 1.3 + 2.2) * a);
      camera.position.add(_v);
      shakeState.amount *= Math.exp(-3.4 * dt);
      if (p.crash <= 0) shakeState.amount = Math.max(0, shakeState.amount - dt * 0.35);
    }

    // keep the camera above the ground
    const minY = layout.heightAt(camera.position.x, camera.position.z) + 1.15;
    if (camera.position.y < minY) camera.position.y = lerp(camera.position.y, minY, 1 - Math.exp(-18 * dt));

    // write back to shared state
    state.camera.position.copy(camera.position);
    state.camera.quaternion.copy(camera.quaternion);
    state.camera.mode = mode.current;
    state.camera.fov = camera.fov;
    state.camera.compassHeading = ((p.heading * 180 / Math.PI) % 360 + 360) % 360;
    state.camera.photo = { ...photo, position: photo.pos };
    void speed;
  }

  function updateChase(dt, state) {
    const p = state.player;
    const speed = Math.abs(p.speed);
    const dist = 5.3 + speed * 0.14;
    const height = 2.25 + speed * 0.035;

    _v.set(
      p.position.x - Math.sin(p.heading) * dist,
      p.position.y + height,
      p.position.z - Math.cos(p.heading) * dist,
    );
    // lateral push opposite the lean for a dynamic feel
    const side = p.lean * 1.4;
    _v.x += Math.cos(p.heading) * side;
    _v.z += -Math.sin(p.heading) * side;

    const lambda = p.crash > 0 ? 14 : 5.5;
    chase.pos.x = damp(chase.pos.x, _v.x, lambda, dt);
    chase.pos.y = damp(chase.pos.y, _v.y, lambda * 1.1, dt);
    chase.pos.z = damp(chase.pos.z, _v.z, lambda, dt);

    const lookAhead = 5.0 + speed * 0.32;
    _v2.set(
      p.position.x + Math.sin(p.heading) * lookAhead,
      p.position.y + 1.35 + Math.sin(p.pitch) * 0.4,
      p.position.z + Math.cos(p.heading) * lookAhead,
    );
    chase.look.x = damp(chase.look.x, _v2.x, 8, dt);
    chase.look.y = damp(chase.look.y, _v2.y, 8, dt);
    chase.look.z = damp(chase.look.z, _v2.z, 8, dt);

    camera.position.copy(chase.pos);
    camera.up.set(0, 1, 0);
    aimAt(camera.position, chase.look, dt, 7);

    const fovTarget = 54 + clamp(speed, 0, 22) * 0.60 + (p.boost ? 3 : 0);
    chase.fov = damp(chase.fov, fovTarget, 3.2, dt);
    camera.fov = chase.fov;
    camera.updateProjectionMatrix();
  }

  function updateFirstPerson(dt, state) {
    const p = state.player;
    const bob = Math.sin(p.wheelSpin * 0.5) * 0.028 * clamp01(Math.abs(p.speed) / 8);
    _v.set(
      p.position.x + Math.sin(p.heading) * 0.35,
      p.position.y + 1.62 + bob,
      p.position.z + Math.cos(p.heading) * 0.35,
    );
    camera.position.copy(_v);
    _v2.set(
      p.position.x + Math.sin(p.heading) * 12,
      p.position.y + 1.35 + Math.sin(p.pitch) * 1.2,
      p.position.z + Math.cos(p.heading) * 12,
    );
    aimAt(camera.position, _v2, dt, 12);
    first.fov = damp(first.fov, 66 + clamp(Math.abs(p.speed), 0, 20) * 0.8, 3, dt);
    camera.fov = first.fov;
    camera.updateProjectionMatrix();
  }

  function updateCinematic(dt, state) {
    const p = state.player;
    cine.timer -= dt;
    if (cine.phase === 'flyby') {
      cine.angle += dt * 0.16;
      const r = cine.radius;
      const h = r * 0.42 + 5;
      _v.set(
        cine.target.x + Math.cos(cine.angle) * r,
        cine.target.y + h + Math.sin(cine.angle * 0.7) * (h * 0.18),
        cine.target.z + Math.sin(cine.angle) * r,
      );
      camera.position.lerp(_v, 1 - Math.exp(-1.6 * dt));
      _v2.set(cine.target.x, cine.target.y + r * 0.12, cine.target.z);
      aimAt(camera.position, _v2, dt, 3.5);
      if (cine.timer <= 0) cine.phase = 'idle';
    } else {
      // slow idle orbit around the rider
      cine.angle += dt * 0.06;
      const r = 14 + Math.sin(cine.angle * 0.5) * 3;
      _v.set(
        p.position.x + Math.cos(cine.angle) * r,
        p.position.y + 5.0 + Math.sin(cine.angle * 0.8) * 1.4,
        p.position.z + Math.sin(cine.angle) * r,
      );
      camera.position.lerp(_v, 1 - Math.exp(-1.2 * dt));
      _v2.set(p.position.x, p.position.y + 1.1, p.position.z);
      aimAt(camera.position, _v2, dt, 3);
    }
    camera.fov = damp(camera.fov, 40, 1.6, dt);
    camera.updateProjectionMatrix();
  }

  function updateTour(dt, state) {
    tour.t = (tour.t + dt * tour.speed) % 1;
    const pos = tourCurve.getPointAt(tour.t);
    const look = tourLookCurve.getPointAt(tour.t);
    camera.position.lerp(pos, 1 - Math.exp(-1.5 * dt));
    aimAt(camera.position, look, dt, 2.5);
    camera.fov = damp(camera.fov, 46, 1.2, dt);
    camera.updateProjectionMatrix();
    void state;
  }

  function updatePhoto(dt) {
    const ax = input.axes;
    const look = input.consumePointerDelta();
    photo.yaw -= look.dx * 0.0022;
    photo.pitch = clamp(photo.pitch - look.dy * 0.0022, -1.4, 1.4);
    const move = photo.speed * dt * (photo.fov / 45);
    const cy = Math.cos(photo.yaw), sy = Math.sin(photo.yaw);
    const forward = { x: -sy, z: -cy };
    const right = { x: cy, z: -sy };
    // WASD fly
    const dt2 = dt;
    let mx = 0, mz = 0, my = 0;
    if (input.held('throttle')) { mx += forward.x; mz += forward.z; }
    if (input.held('brake')) { mx -= forward.x; mz -= forward.z; }
    if (input.held('left')) { mx -= right.x; mz -= right.z; }
    if (input.held('right')) { mx += right.x; mz += right.z; }
    if (input.held('boost')) my += 1;
    if (input.held('brakeHard')) my -= 1;
    const len = Math.hypot(mx, mz) || 1;
    photo.pos.x += (mx / len) * move * (mx || mz ? 1 : 0);
    photo.pos.z += (mz / len) * move * (mx || mz ? 1 : 0);
    photo.pos.y += my * move * 0.8;
    photo.fov = clamp(photo.fov - input.pointer.wheel * 0.04, 18, 95);
    void dt2;
    void ax;

    camera.position.copy(photo.pos);
    _e.set(photo.pitch, photo.yaw, 0, 'YXZ');
    _m.makeRotationFromEuler(_e);
    camera.quaternion.setFromRotationMatrix(_m);
    camera.fov = photo.fov;
    camera.updateProjectionMatrix();
  }

  return {
    update,
    setMode,
    get mode() { return mode.current; },
    flyby,
    addShake,
    photo,
    tour,
    /** distance from the camera to the rider, used to focus photo mode */
    focusDistance(state) {
      return camera.position.distanceTo(state.player.position);
    },
    setTourProgress(t) { tour.t = t; },
    angleDamp,
  };
}
