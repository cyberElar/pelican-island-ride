/**
 * probe-module.mjs - builds ONE world module with the real layout and a mock
 * texture library, printing timing and basic sanity so a hang or a NaN storm
 * can be isolated outside the browser.
 *
 * Usage: node tools/dev/probe-module.mjs vegetation [seed]
 */

import * as THREE from 'three';
import { createLayout } from '../../src/world/layout.js';
import { QUALITY_PRESETS } from '../../src/core/settings.js';

const name = process.argv[2] || 'vegetation';
const seed = Number(process.argv[3]) || 20261014;

const mockSurface = () => ({ map: null, normalMap: null, roughnessMap: null, alphaMap: null, emissiveMap: null, color: null });
const textures = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return (size = 256) => ({ width: size, height: size, getContext: () => null });
    if (prop === 'noiseCanvas' || prop === 'spriteSize' || prop === 'texSize') return () => mockSurface();
    return () => mockSurface();
  },
});

const t0 = performance.now();
const layout = createLayout(seed);
console.log(`layout: ${(performance.now() - t0).toFixed(0)} ms`);

const engine = {
  preset: { ...QUALITY_PRESETS.high },
  qualityLevel: 'high',
  camera: new THREE.PerspectiveCamera(55, 16 / 9, 0.25, 18000),
  elapsed: 0,
  bus: { on() {}, off() {}, emit() {} },
};
engine.preset.terrainSegments = 160;   // keep the probe fast
engine.preset.heightTextureSize = 192;

const ctx = {
  engine,
  layout,
  textures,
  rng: null,
  quality: 'high',
  bus: engine.bus,
  THREE,
  heightTexture: new THREE.DataTexture(new Uint16Array(4), 2, 2, THREE.RedFormat, THREE.HalfFloatType),
};

const mod = await import(`../../src/world/${name}.js`);
const factoryName = Object.keys(mod).find((k) => k.startsWith('create'));
if (!factoryName) {
  console.error(`no create* export in ${name}.js (found: ${Object.keys(mod).join(', ')})`);
  process.exit(2);
}

const t1 = performance.now();
const instance = await mod[factoryName](ctx);
const buildMs = performance.now() - t1;
console.log(`build: ${buildMs.toFixed(0)} ms`);

let objs = 0, meshes = 0, instanced = 0, tris = 0;
if (instance?.group) {
  instance.group.traverse((o) => {
    objs++;
    if (o.isMesh) {
      meshes++;
      if (o.isInstancedMesh) instanced++;
      const g = o.geometry;
      if (g?.index) tris += (g.index.count / 3) * (o.isInstancedMesh ? o.count : 1);
      else if (g?.attributes?.position) tris += (g.attributes.position.count / 3) * (o.isInstancedMesh ? o.count : 1);
    }
  });
  console.log(`group: ${objs} objects, ${meshes} meshes (${instanced} instanced), ~${(tris / 1000).toFixed(0)}k tris`);
}

if (typeof instance?.update === 'function') {
  const state = {
    hour: 12,
    t: 0,
    wind: { x: 0.5, z: 0.5, strength: 0.4, gust: 0 },
    weather: { rain: 0, cloudiness: 0.3, fogBoost: 0 },
    player: { position: new THREE.Vector3(0, 40, 1600), speed: 8, heading: 0, surface: 'asphalt', inWater: false, boost: false, crash: 0, wheelSpin: 0, lean: 0, steer: 0, grounded: true, airTime: 0, pitch: 0 },
    camera: { position: new THREE.Vector3(0, 45, 1590), mode: 'chase' },
    sun: { dir: new THREE.Vector3(0.3, 0.5, 0.8), color: new THREE.Color('#fff4e2'), intensity: 3 },
    moon: { dir: new THREE.Vector3(-0.3, 0.5, -0.8), intensity: 0 },
  };
  const t2 = performance.now();
  for (let i = 0; i < 120; i++) {
    state.t += 1 / 60;
    state.hour = (12 + i * 0.05) % 24;
    state.player.position.x = Math.cos(i * 0.1) * 900;
    state.player.position.z = Math.sin(i * 0.1) * 900;
    state.camera.position.set(state.player.position.x, state.player.position.y + 4, state.player.position.z - 8);
    instance.update(1 / 60, state);
  }
  const updMs = performance.now() - t2;
  console.log(`update: 120 frames in ${updMs.toFixed(0)} ms (${(updMs / 120).toFixed(2)} ms/frame)`);
}

console.log(`${name}: PROBE OK`);
