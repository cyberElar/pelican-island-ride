/**
 * weather.js - rain streaks and dawn mist banks. Density driven by
 * state.weather; everything is a pooled, allocation-free update.
 */

import * as THREE from 'three';
import { Rng, clamp01, lerp, TAU } from '../core/utils.js';

export function createWeather(ctx) {
  const { engine, layout, textures: TEX } = ctx;
  const group = new THREE.Group();
  group.name = 'weather';

  // ---------------------------------------------------------------------------
  // Rain: one LineSegments cloud around the camera
  // ---------------------------------------------------------------------------

  const DROPS = 900;
  const rainPos = new Float32Array(DROPS * 6);
  const rainSeed = new Float32Array(DROPS * 3);
  const rng = new Rng(`weather:${layout.seed}`);
  const RAIN_BOX = { x: 70, y: 46, z: 70 };

  for (let i = 0; i < DROPS; i++) {
    const x = rng.range(-RAIN_BOX.x, RAIN_BOX.x);
    const y = rng.range(0, RAIN_BOX.y);
    const z = rng.range(-RAIN_BOX.z, RAIN_BOX.z);
    rainSeed[i * 3] = x; rainSeed[i * 3 + 1] = y; rainSeed[i * 3 + 2] = z;
    rainPos[i * 6] = x; rainPos[i * 6 + 1] = y; rainPos[i * 6 + 2] = z;
    rainPos[i * 6 + 3] = x + 0.06; rainPos[i * 6 + 4] = y - 0.85; rainPos[i * 6 + 5] = z;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({
    color: 0xcfe2f2, transparent: true, opacity: 0.0, depthWrite: false, fog: true,
  });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.renderOrder = 900;
  group.add(rain);

  // ---------------------------------------------------------------------------
  // Mist banks (dawn) near the water
  // ---------------------------------------------------------------------------

  const mistTex = TEX.smokeSprite();
  const mistMat = new THREE.SpriteMaterial({
    map: mistTex, transparent: true, opacity: 0.0, depthWrite: false,
    color: 0xdce9f2, blending: THREE.NormalBlending, fog: true,
  });
  const mists = [];
  const MIST_COUNT = 26;
  for (let i = 0; i < MIST_COUNT; i++) {
    const angle = (i / MIST_COUNT) * TAU + rng.range(-0.1, 0.1);
    // walk outward until we find the shoreline
    let x = 0, z = 0, y = 0;
    const rc = layout.coastRadius(angle);
    const r = rc * rng.range(0.985, 1.06);
    x = Math.cos(angle) * r;
    z = Math.sin(angle) * r;
    y = Math.max(1.5, layout.heightAt(x, z) + rng.range(2, 7));
    const s = new THREE.Sprite(mistMat.clone());
    s.position.set(x, y, z);
    const scale = rng.range(55, 130);
    s.scale.set(scale, scale * rng.range(0.32, 0.5), 1);
    s.userData.baseOpacity = rng.range(0.16, 0.34);
    s.userData.phase = rng.range(0, TAU);
    group.add(s);
    mists.push(s);
  }

  let time = 0;

  function update(dt, state) {
    time += dt;
    const rainAmount = clamp01(state?.weather?.rain ?? 0);
    rainMat.opacity = rainAmount * 0.5;
    rain.visible = rainAmount > 0.01;

    if (rain.visible) {
      const cam = engine.camera.position;
      const windX = (state?.wind?.x ?? 0.3) * (state?.wind?.strength ?? 0.4) * 9;
      const windZ = (state?.wind?.z ?? 0.3) * (state?.wind?.strength ?? 0.4) * 9;
      const fall = 22 * (0.7 + rainAmount * 0.6);
      const pos = rainGeo.attributes.position.array;
      const cx = Math.round(cam.x / RAIN_BOX.x) * RAIN_BOX.x;
      const cz = Math.round(cam.z / RAIN_BOX.z) * RAIN_BOX.z;
      const top = cam.y + RAIN_BOX.y * 0.6;
      for (let i = 0; i < DROPS; i++) {
        const o = i * 6;
        let y = pos[o + 1] - fall * dt;
        let x = pos[o] + windX * dt;
        let z = pos[o + 2] + windZ * dt;
        if (y < cam.y - RAIN_BOX.y * 0.4) {
          y = top;
          const s = rng; // reuse deterministic rng for recycling
          x = cx + s.range(-RAIN_BOX.x, RAIN_BOX.x);
          z = cz + s.range(-RAIN_BOX.z, RAIN_BOX.z);
        }
        // wrap horizontally around the camera
        if (x - cx > RAIN_BOX.x) x -= RAIN_BOX.x * 2;
        else if (x - cx < -RAIN_BOX.x) x += RAIN_BOX.x * 2;
        if (z - cz > RAIN_BOX.z) z -= RAIN_BOX.z * 2;
        else if (z - cz < -RAIN_BOX.z) z += RAIN_BOX.z * 2;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        pos[o + 3] = x + windX * 0.02;
        pos[o + 4] = y - 0.9 - rainAmount * 0.5;
        pos[o + 5] = z + windZ * 0.02;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }

    // mist: strongest at dawn, fades through the morning
    const hour = state?.hour ?? 12;
    const dawn = Math.exp(-Math.pow((hour - 6.1) / 1.5, 2));
    const dusk = 0.35 * Math.exp(-Math.pow((hour - 19.6) / 1.6, 2));
    const magic = clamp01(dawn + dusk);
    for (const s of mists) {
      const sway = Math.sin(time * 0.08 + s.userData.phase) * 0.25 + 0.75;
      s.material.opacity = s.userData.baseOpacity * magic * sway;
      s.position.y += Math.sin(time * 0.13 + s.userData.phase) * dt * 0.12;
      s.visible = s.material.opacity > 0.01;
    }
    void lerp;
  }

  return {
    group,
    update,
    setRain(v) { if (ctx.engine?.bus) ctx.engine.bus.emit('weather:rain', { value: v }); },
  };
}
