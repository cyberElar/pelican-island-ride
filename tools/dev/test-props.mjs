/**
 * Dev test for world/props.js - runs headless in Node.
 *
 * Uses the real island layout (createLayout(20261014)) plus a Proxy stand-in
 * for the texture library (no DOM / canvas in Node) and a mock engine carrying
 * QUALITY_PRESETS.high.
 *
 * Checks: build time, building count, terrain-anchored placement samples, NaN
 * freedom, collider sanity, animation cost and the day/night emissive switch.
 */

import { createProps } from '../../src/world/props.js';
import { createLayout } from '../../src/world/layout.js';
import { Rng, EventBus } from '../../src/core/utils.js';
import { QUALITY_PRESETS } from '../../src/core/settings.js';

const t00 = performance.now();
const layout = createLayout(20261014);
console.log(`--- layout built in ${(performance.now() - t00).toFixed(1)} ms ---`);

// --- mock texture library: every factory returns a surface-shaped object ----

const mockSurface = () => ({ map: null, normalMap: null, roughnessMap: null, alphaMap: null });
let texCalls = 0;
const TEX = new Proxy({}, {
  get(target, prop) {
    if (typeof prop === 'symbol' || prop === 'then') return undefined;
    if (!(prop in target)) {
      target[prop] = () => { texCalls++; return mockSurface(); };
    }
    return target[prop];
  },
});

const ctx = {
  engine: { preset: { ...QUALITY_PRESETS.high }, quality: 'high', renderer: null, scene: null },
  layout,
  textures: TEX,
  rng: new Rng(20261014),
  quality: 'high',
  bus: new EventBus(),
};

// --- build -----------------------------------------------------------------

const t0 = performance.now();
const props = await createProps(ctx);
const buildMs = performance.now() - t0;
const { group, update, colliders, chimneys, lamps, stats, samples } = props;

console.log('--- props built ---');
console.log(`build            ${buildMs.toFixed(0)} ms`);
console.log(`buildings        ${stats.buildings}  (village houses: ${stats.villageHouses})`);
console.log(`props            ${stats.props}`);
console.log(`draw calls       ${stats.drawCalls}`);
console.log(`triangles        ${stats.triangles}`);
console.log(`colliders        ${colliders.length}`);
console.log(`chimneys         ${chimneys.length}`);
console.log(`lamps            ${lamps.length}`);
console.log(`samples          ${samples.length}`);
console.log(`lamp posts       ${stats.lampPosts}   wall segs ${stats.wallSegments}   guardrail spans ${stats.guardrailSpans}`);
console.log(`texture calls    ${texCalls}`);

const fail = (msg) => { throw new Error(msg); };
if (!(buildMs < 8000)) fail(`props build too slow: ${buildMs.toFixed(0)} ms`);
if (stats.buildings < 25) fail(`expected >= 25 buildings, got ${stats.buildings}`);
if (!(colliders.length >= 50 && colliders.length <= 1500)) fail(`collider count out of range: ${colliders.length}`);
if (!(samples.length >= 40)) fail(`not enough placement samples: ${samples.length}`);
if (!lamps.length) fail('no lamps registered');
if (!chimneys.length) fail('no chimneys registered');

// --- matrices: no NaN anywhere in the hierarchy -----------------------------

group.updateMatrixWorld(true);
let nanMatrix = 0, meshCount = 0;
group.traverse((o) => {
  for (const m of [o.matrix, o.matrixWorld]) {
    for (let i = 0; i < 16; i++) if (!Number.isFinite(m.elements[i])) nanMatrix++;
  }
  if (o.isInstancedMesh) {
    const a = o.instanceMatrix.array;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) nanMatrix++;
    meshCount++;
  } else if (o.isMesh) {
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) nanMatrix++;
    meshCount++;
  }
});
console.log(`meshes           ${meshCount}`);
if (nanMatrix) fail(`found ${nanMatrix} non-finite matrix/vertex values`);

// --- placement: bases must sit on the terrain -------------------------------

{
  let worst = 0, worstAt = null;
  const step = Math.max(1, Math.floor(samples.length / 40));
  let checked = 0;
  for (let i = 0; i < samples.length && checked < 40; i += step) {
    const s = samples[i];
    checked++;
    const dy = Math.abs(s.y - layout.heightAt(s.x, s.z));
    if (dy > worst) { worst = dy; worstAt = s; }
  }
  console.log(`base offset      worst ${worst.toFixed(3)} m over ${checked} samples`);
  if (worst > 1.0) {
    fail(`a prop base is ${worst.toFixed(2)} m off the terrain at ` +
      `(${worstAt.x.toFixed(1)}, ${worstAt.y.toFixed(1)}, ${worstAt.z.toFixed(1)})`);
  }
}

// --- colliders --------------------------------------------------------------

{
  const n = layout.roadSamples.length / 3;
  const roadDist = (x, z) => {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = x - layout.roadSamples[i * 3];
      const dz = z - layout.roadSamples[i * 3 + 2];
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const poiList = layout.poiList;
  const poiDist = (x, z) => {
    let best = Infinity;
    for (const p of poiList) {
      const d = Math.hypot(x - p.position.x, z - p.position.z) - p.radius;
      if (d < best) best = d;
    }
    return best;
  };
  const spurDist = (x, z) => {
    let best = Infinity;
    for (const id of Object.keys(layout.spurs)) {
      const d = layout.spurs[id].distance(x, z);
      if (d < best) best = d;
    }
    return best;
  };

  let nan = 0, roadTagged = 0, roadTaggedFar = 0, sprawl = 0;
  // The 60 m rule is applied to every collider flagged `road` (road-side
  // furniture and fences). POI-anchored props - harbour boats, farm, camp,
  // mills, the chapel cottages - are legitimately far from the ring road, so
  // those must instead sit inside a POI zone or right beside a spur trail.
  for (const c of colliders) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.z) || !Number.isFinite(c.r)) { nan++; continue; }
    const rd = roadDist(c.x, c.z);
    if (c.road) {
      roadTagged++;
      if (!(rd <= 60)) roadTaggedFar++;
    }
    // every collider must belong to the road corridor, a POI, or a trail
    if (!(rd <= 60 || poiDist(c.x, c.z) <= 260 || spurDist(c.x, c.z) <= 30)) sprawl++;
  }
  console.log(`road colliders   ${roadTagged} (${roadTaggedFar} farther than 60 m)`);
  if (nan) fail(`${nan} colliders contain NaN`);
  if (roadTagged < 20) fail(`only ${roadTagged} colliders flagged as road-side`);
  if (roadTaggedFar) fail(`${roadTaggedFar} road-side colliders sit farther than 60 m from the road`);
  if (sprawl) fail(`${sprawl} colliders are unrelated to any road, POI or trail`);
}

// --- update(): 300 calls, animation cost and the night switch ---------------

{
  const night = { hour: 22, wind: { strength: 0.5, gust: 0.2 } };
  const noon = { hour: 12, wind: { strength: 0.5, gust: 0 } };

  // every registered lamp position must line up with a real instanced globe
  const globeMat = (lamps.find((l) => l.kind === 'lamp') || lamps[0]).material;
  let globeMesh = null;
  group.traverse((o) => { if (!globeMesh && o.isInstancedMesh && o.material === globeMat) globeMesh = o; });
  if (!globeMesh) fail('lamp globes are not instanced');
  const gArr = globeMesh.instanceMatrix.array;
  let worstLamp = 0;
  for (const l of lamps) {
    if (l.kind === 'window') continue;
    let best = Infinity;
    for (let i = 0; i < globeMesh.count; i++) {
      const o = i * 16;
      const d = Math.hypot(l.x - gArr[o + 12], l.y - gArr[o + 13], l.z - gArr[o + 14]);
      if (d < best) best = d;
    }
    if (best > worstLamp) worstLamp = best;
  }
  console.log(`lamp alignment   worst ${worstLamp.toFixed(3)} m`);
  if (worstLamp > 0.05) fail(`a registered lamp is ${worstLamp.toFixed(2)} m from its globe`);

  // the campfire must be registered as a typed emitter
  const fires = chimneys.filter((c) => c.type === 'fire');
  console.log(`fire emitters    ${fires.length} (rate ${fires.length ? fires[0].rate : '-'})`);
  if (fires.length !== 1) fail(`expected exactly one fire emitter, got ${fires.length}`);
  if (Math.abs(fires[0].rate - 0.6) > 1e-6) fail('campfire emitter rate should be 0.6');
  if (!chimneys.some((c) => !c.type)) fail('no chimney smoke emitters registered');

  const t1 = performance.now();
  for (let i = 0; i < 150; i++) update(1 / 60, night);
  const nightMs = performance.now() - t1;
  const mats = new Set();
  for (const l of lamps) if (l.material) mats.add(l.material);
  let lit = 0;
  for (const m of mats) if (m.emissiveIntensity > 1) lit++;
  console.log(`night            ${mats.size} emissive materials, ${lit} lit (${nightMs.toFixed(2)} ms / 150 calls)`);
  if (!(lit > 0)) fail('no emissive material was raised at night');

  const t2 = performance.now();
  for (let i = 0; i < 150; i++) update(1 / 60, noon);
  const noonMs = performance.now() - t2;
  let litNoon = 0;
  for (const m of mats) if (m.emissiveIntensity > 0) litNoon++;
  console.log(`noon             ${litNoon} lit (${noonMs.toFixed(2)} ms / 150 calls)`);
  if (litNoon) fail(`${litNoon} emissive materials still lit at noon`);

  const totalMs = nightMs + noonMs;
  console.log(`update cost      ${totalMs.toFixed(2)} ms for 300 calls`);
  if (totalMs > 300) fail(`update() too slow: ${totalMs.toFixed(1)} ms for 300 calls`);

  // sanity: animation actually moved something
  const spins = [];
  group.traverse((o) => { if (o.isGroup) spins.push(o); });
  let moved = false;
  for (const g of spins) if (Math.abs(g.rotation.x) > 1e-6 || Math.abs(g.rotation.z) > 1e-6) moved = true;
  if (!moved) fail('nothing animated after update()');
}

console.log('ALL PROPS TESTS PASSED');
