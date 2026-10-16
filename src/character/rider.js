/**
 * rider.js - the ridden hero: pelican + cruiser bicycle.
 *
 * createRider(ctx) -> { root, group, update(dt, state), parts, bounds }
 *
 * root origin = ground contact, midway between the two wheels, facing +Z.
 * `group` is the same object as `root` so the generic module loader (which
 * mounts `instance.group`) picks the rider up.
 *
 * gameplay/controls.js owns the physics and publishes it as state.player, so
 * update() mirrors state.player.position / heading onto root (heading 0 = +Z
 * forward, matching the controls convention). Everything the rider animates
 * lives in `leanGroup` (rotation.z = lean) and below, so the two never fight.
 *
 * update() reads state.player.{ speed, steer, lean, wheelSpin, grounded, crash,
 * boost, airTime } and drives the wheels, the crank, the gear-linked pedals, the
 * handlebar, the body lean/pitch, the pelican's pedalling IK and all secondary
 * motion (blink, bob, pouch jiggle, wing flutter, flag/streamer cloth).
 */

import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/utils.js';
import { createBicycle, BIKE_DIMS } from './bicycle.js';
import { createPelican, PELICAN_MOUNT } from './pelican.js';
import { mergeStaticChildren } from './merge-static.js';

export function createRider(ctx) {
  const root = new THREE.Group();
  root.name = 'rider';

  // The whole rig rolls inside this group so controls.js can keep owning
  // root.rotation for heading.
  const leanGroup = new THREE.Group();
  leanGroup.name = 'riderLean';
  root.add(leanGroup);

  const bicycle = createBicycle(ctx);
  bicycle.root.name = 'riderBicycle';
  leanGroup.add(bicycle.root);

  const pelicanMount = new THREE.Group();
  pelicanMount.name = 'riderPelicanMount';
  pelicanMount.position.set(PELICAN_MOUNT.x, PELICAN_MOUNT.y, PELICAN_MOUNT.z);
  leanGroup.add(pelicanMount);

  const pelican = createPelican(ctx, { mount: PELICAN_MOUNT });
  pelican.root.name = 'riderPelican';
  pelicanMount.add(pelican.root);

  const parts = {
    ...bicycle.parts,
    ...pelican.parts,
    leanGroup,
    bicycleRoot: bicycle.root,
    pelicanRoot: pelican.root,
    pelicanMount,
  };

  // Collapse the static meshes. The rig is ~170 meshes and each one costs a
  // draw call in the main pass *and* in the shadow pass; merging them per
  // parent+material keeps every animated joint intact (the merged mesh rides
  // along with its parent) and takes most of those calls away. Named parts
  // stay addressable, so nothing that pokes at `parts.*` breaks.
  parts.mergedStaticMeshes = mergeStaticChildren(root, [
    parts,
    parts.streamers,
  ]);

  // -------------------------------------------------------------------------
  // Pedal targets + pelican animation payload (allocated once)
  // -------------------------------------------------------------------------
  const pedalL = { x: 0, y: 0, z: 0 };
  const pedalR = { x: 0, y: 0, z: 0 };
  const anim = { t: 0, pulse: 0, lean: 0, pedalL, pedalR };

  const CRANK = BIKE_DIMS.crank;
  let time = 0;
  let pitch = 0;
  let bob = 0;

  const rootPos = root.position;

  function update(dt, state) {
    const player = state && state.player ? state.player : null;
    const speed = player && Number.isFinite(player.speed) ? player.speed : 0;
    const steer = player && Number.isFinite(player.steer) ? player.steer : 0;
    const lean = player && Number.isFinite(player.lean) ? player.lean : 0;
    const wheelSpin = player && Number.isFinite(player.wheelSpin) ? player.wheelSpin : 0;
    const crash = player ? clamp01(player.crash || 0) : 0;
    const airTime = player && Number.isFinite(player.airTime) ? player.airTime : 0;
    const airborne = player ? (player.grounded === false || airTime > 0.05) : false;

    time = state && Number.isFinite(state.t) ? state.t : time + dt;
    const speedNorm = clamp01(Math.abs(speed) / 7);

    // Follow the physics: controls.js writes state.player, nobody writes root.
    if (player && player.position) {
      rootPos.set(player.position.x, player.position.y, player.position.z);
      root.rotation.y = Number.isFinite(player.heading) ? player.heading : 0;
    }

    // --- body lean: rotation.z = lean (positive = leaning to the rider's right)
    // plus a pitch that lifts the nose off jumps and dips it on landing.
    const vy = player && player.velocity && Number.isFinite(player.velocity.y) ? player.velocity.y : 0;
    const targetPitch = airborne ? clamp(-vy * 0.06, -0.2, 0.3) : clamp(-vy * 0.02, -0.08, 0.12);
    pitch = damp(pitch, targetPitch, airborne ? 4 : 9, dt);
    leanGroup.rotation.z = lean;
    leanGroup.rotation.x = pitch;

    // Suspension: a short compression on crash landings, a faint pedal pump.
    const crankAngle = wheelSpin * CRANK.gearRatio;
    const targetBob = -crash * 0.03 - Math.abs(Math.sin(crankAngle)) * 0.0022 * speedNorm;
    bob = damp(bob, targetBob, 12, dt);
    leanGroup.position.y = bob;

    // --- pedal targets, converted into the pelican's local space ---
    const ca = Math.cos(crankAngle);
    const sa = Math.sin(crankAngle);
    const lift = CRANK.pedalLift;
    pedalL.x = CRANK.pedalHalfX - PELICAN_MOUNT.x;
    pedalL.y = CRANK.y + CRANK.arm * ca + lift - PELICAN_MOUNT.y;
    pedalL.z = CRANK.z + CRANK.arm * sa - PELICAN_MOUNT.z;
    pedalR.x = -CRANK.pedalHalfX - PELICAN_MOUNT.x;
    pedalR.y = CRANK.y - CRANK.arm * ca + lift - PELICAN_MOUNT.y;
    pedalR.z = CRANK.z - CRANK.arm * sa - PELICAN_MOUNT.z;

    anim.t = time;
    anim.pulse = clamp01(Math.abs(speed) / 4);
    anim.lean = lean;

    pelican.update(dt, state, anim);
    bicycle.update(dt, state, anim);

    // Contract: the rider sets the handlebar steering. The bicycle derives the
    // same value from state.player.steer, so both writes agree.
    const steerAngle = steer * BIKE_DIMS.steerRatio;
    parts.handlebar.rotation.y = steerAngle;
    parts.frontWheelGroup.rotation.y = steerAngle;
  }

  // -------------------------------------------------------------------------
  // Bounds (computed once, for camera/physics consumers)
  // -------------------------------------------------------------------------
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const bounds = {
    box,
    center,
    size,
    length: size.z,
    height: size.y,
    width: size.x,
    /** Horizontal radius for broad-phase tests / camera framing. */
    radius: Math.hypot(size.x, size.z) * 0.5,
    /** Distance from the ground origin to the top of the model. */
    top: box.max.y,
  };

  return { root, group: root, update, parts, bounds };
}
