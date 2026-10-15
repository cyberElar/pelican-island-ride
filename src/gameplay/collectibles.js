/**
 * collectibles.js - 40 golden feathers scattered along the ring road and
 * around the POIs. One InstancedMesh, animated and collected in place.
 */

import * as THREE from 'three';
import { Rng, clamp01, lerp, TAU } from '../core/utils.js';
import { GAME } from '../core/settings.js';

export function createCollectibles(ctx) {
  const { layout, bus } = ctx;
  const total = GAME.featherCount;
  const rng = new Rng(`feathers:${layout.seed}`);

  const group = new THREE.Group();
  group.name = 'feathers';

  // --- feather geometry: a slim extruded blade with a shaft ---
  const geo = (() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.24);
    shape.bezierCurveTo(0.13, -0.10, 0.11, 0.14, 0, 0.30);
    shape.bezierCurveTo(-0.11, 0.14, -0.13, -0.10, 0, -0.24);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1, steps: 1 });
    g.center();
    g.rotateZ(Math.PI * 0.12);
    g.scale(1.5, 1.5, 1.5);
    return g;
  })();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffd479,
    emissive: 0xffb347,
    emissiveIntensity: 0.85,
    metalness: 0.55,
    roughness: 0.28,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, total);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  group.add(mesh);

  // --- placement ---
  const list = [];
  const poiIds = ['village', 'harbor', 'lighthouse', 'windmill', 'lake', 'mill', 'bridge', 'waterfall',
    'orchard', 'vineyard', 'farm', 'camp', 'standingStones', 'treehouse', 'ruins', 'boardwalk',
    'balloons', 'peak', 'observatory', 'chapel', 'lakeside', 'pool', 'bench'];

  // 18 along the ring road, alternating sides
  for (let i = 0; i < 18; i++) {
    const t = (i / 18 + rng.range(-0.012, 0.012) + 1) % 1;
    const rp = layout.roadPoint(t, {});
    const side = i % 2 === 0 ? 1 : -1;
    const off = rng.range(3.4, 8.5) * side;
    const nx = -rp.dirZ, nz = rp.dirX;
    const x = rp.x + nx * off;
    const z = rp.z + nz * off;
    list.push({ x, y: layout.heightAt(x, z) + 1.0, z, collected: false, phase: rng.range(0, TAU) });
  }
  // 22 near POIs
  for (let i = 0; i < total - 18; i++) {
    const id = poiIds[i % poiIds.length];
    const poi = layout.pois[id];
    let spot = null;
    if (poi.type === 'water') {
      // lake: place on the lake islet or the deck; arch/sea keep them on land nearby
      if (id === 'lake') spot = layout.randomSpotNear('lakeside', 6, 26, rng, { poi: 0 });
      else spot = layout.randomSpotNear(id, poi.radius + 6, poi.radius + 40, rng, { poi: 0 });
    } else {
      spot = layout.randomSpotNear(id, Math.min(16, poi.radius * 0.3), Math.max(24, poi.radius * 0.85), rng, { poi: 0 });
    }
    if (!spot) spot = layout.randomSpot(rng, { poi: 0 }) || { x: 0, y: layout.heightAt(0, 0), z: 0 };
    list.push({ x: spot.x, y: spot.y + 1.0, z: spot.z, collected: false, phase: rng.range(0, TAU) });
  }

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _s = new THREE.Vector3();
  const _p = new THREE.Vector3();
  let time = 0;
  let collectedCount = 0;

  function writeInstance(i) {
    const f = list[i];
    if (f.collected) {
      _s.setScalar(0.0001);
      _p.set(0, -5000, 0);
      _e.set(0, 0, 0);
    } else {
      const bob = Math.sin(time * 1.7 + f.phase) * 0.22;
      _p.set(f.x, f.y + bob, f.z);
      _e.set(0.35 + Math.sin(time * 0.9 + f.phase) * 0.08, time * 1.1 + f.phase, Math.sin(time * 1.3 + f.phase) * 0.15);
      const pulse = 1 + Math.sin(time * 2.2 + f.phase) * 0.06;
      _s.setScalar(pulse);
    }
    _q.setFromEuler(_e);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }

  for (let i = 0; i < total; i++) writeInstance(i);
  mesh.instanceMatrix.needsUpdate = true;

  const _pv = new THREE.Vector3();
  let dirty = false;

  return {
    group,
    total,
    update(dt, state) {
      time += dt;
      const player = state.player.position;
      for (let i = 0; i < total; i++) {
        const f = list[i];
        if (!f.collected) {
          _pv.set(f.x, f.y, f.z);
          const d = _pv.distanceTo(player);
          if (d < 2.5) {
            f.collected = true;
            collectedCount++;
            state.feathers.collected = collectedCount;
            bus.emit('sfx', { name: 'pickup' });
            bus.emit('feather:collected', { index: i, total, collected: collectedCount });
            ctx.particles?.bursts?.sparkle?.(f.x, f.y, f.z, 14);
            dirty = true;
          }
        }
        writeInstance(i);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mat.emissiveIntensity = 0.7 + Math.sin(time * 2.4) * 0.25;
      void dirty;
      void clamp01;
      void lerp;
    },
    list,
    reset() {
      for (const f of list) f.collected = false;
      collectedCount = 0;
    },
  };
}
