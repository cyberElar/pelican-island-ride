/**
 * test-life.mjs - headless dev test for src/world/animals.js + particles.js.
 *
 * Builds the real island (createLayout(20261014)) with a mock texture library
 * (every surface factory returns null maps, TEX.canvas() yields a stub whose
 * getContext() returns null) and a mock engine, then:
 *
 *   - builds both modules and checks the exported contract
 *   - rides a 600 frame sweep around the island while the clock runs 0 -> 24
 *     and asserts no exceptions, no NaN and no position outside the world
 *   - checks the firefly day/night gate at hour 22, 3 and 12
 *   - fires every burst, registers runtime emitters mid-run and lets the
 *     emitter-fed pools settle
 *   - times 600 frames of both modules together against the 900 ms budget
 *
 * Run: cd work/pelican-island ; node tools/dev/test-life.mjs
 */

import * as THREE from 'three';
import { createLayout } from '../../src/world/layout.js';
import { createAnimals } from '../../src/world/animals.js';
import { createParticles } from '../../src/world/particles.js';
import { QUALITY_PRESETS } from '../../src/core/settings.js';

const SEED = 20261014;
const BUILD_BUDGET_MS = 5000;
const FRAME_BUDGET_MS = 900;
const FRAMES = 600;
const DT = 1 / 60;
const WORLD_LIMIT = 9000;
const PARKED_Y = -9999;

// ---------------------------------------------------------------------------
// Mocks - no DOM, no canvas, no renderer
// ---------------------------------------------------------------------------

const SURFACE = { map: null, normalMap: null, roughnessMap: null, alphaMap: null };
const textures = new Proxy({}, {
  get(_target, key) {
    if (typeof key !== 'string') return undefined;
    if (key === 'canvas') {
      return (size) => ({ width: size || 256, height: size || 256, getContext: () => null });
    }
    return () => SURFACE;
  },
});

const engine = {
  // deliberately a *subset* of the high preset: the modules may only rely on
  // the documented preset keys.
  preset: {
    shadows: QUALITY_PRESETS.high.shadows,
    foliageShadows: QUALITY_PRESETS.high.foliageShadows,
    animalScale: QUALITY_PRESETS.high.animalScale,
    particleScale: QUALITY_PRESETS.high.particleScale,
  },
  camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.2, 22000),
  bus: { on() { return () => {}; }, emit() {} },
  elapsed: 0,
};

const layout = createLayout(SEED);

const state = {
  t: 0,
  hour: 17.1,
  player: { position: new THREE.Vector3(0, 0, 0) },
  camera: { position: engine.camera.position },
  wind: { x: 0.7, z: 0.5, strength: 0.4, gust: 0 },
  sun: { dir: new THREE.Vector3(0.3, 0.5, 0.8) },
  weather: { rain: 0, cloudiness: 0.35, fogBoost: 0 },
  photoMode: false,
};

const ctx = {
  engine,
  layout,
  textures,
  rng: null,
  quality: 'high',
  bus: engine.bus,
  state,
};

const fail = (msg) => { throw new Error(msg); };

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const t0 = performance.now();
const animals = createAnimals(ctx);
const particles = createParticles(ctx);
const buildMs = performance.now() - t0;

console.log('--- life built ---');
console.log(`build            ${buildMs.toFixed(1)} ms (both modules, budget ${BUILD_BUDGET_MS} ms)`);
if (!(buildMs < BUILD_BUDGET_MS)) fail(`build too slow: ${buildMs.toFixed(1)} ms`);

for (const key of ['group', 'update', 'setQuality', 'stats']) {
  if (!(key in animals)) fail(`createAnimals() is missing "${key}"`);
}
for (const key of ['group', 'update', 'setQuality', 'stats', 'bursts', 'registerEmitter']) {
  if (!(key in particles)) fail(`createParticles() is missing "${key}"`);
}
for (const key of ['dust', 'waterSplash', 'leaves', 'sparkle', 'confetti', 'smokePuff']) {
  if (typeof particles.bursts[key] !== 'function') fail(`bursts.${key} is not a function`);
}
if (typeof animals.debug !== 'object' || typeof animals.debug.fireflyVisible !== 'number') {
  fail('animals.debug.fireflyVisible is not exposed');
}

console.log(
  'animals: ' +
  `total=${animals.stats.total} gulls=${animals.stats.gulls} ducks=${animals.stats.ducks} ` +
  `herons=${animals.stats.herons} rabbits=${animals.stats.rabbits} deer=${animals.stats.deer} ` +
  `crabs=${animals.stats.crabs} butterflies=${animals.stats.butterflies} bees=${animals.stats.bees} ` +
  `fireflies=${animals.stats.fireflies} fish=${animals.stats.fish} whales=${animals.stats.whales} dolphins=${animals.stats.dolphins}`
);
console.log(
  `particles: pool=${particles.stats.total} budget=${particles.stats.budget} ` +
  `families=${particles.stats.drawCalls} emitters=${particles.stats.emitters}`
);
console.log(`draw calls: animals=${animals.stats.drawCalls} particles=${particles.stats.drawCalls} animal tris=${animals.stats.triangles}`);

if (!(animals.stats.total >= 190)) fail(`animals.stats.total too low: ${animals.stats.total}`);
if (!(particles.stats.total >= 300)) fail(`particle pool too small: ${particles.stats.total}`);
if (particles.stats.drawCalls > 8) fail(`too many particle families: ${particles.stats.drawCalls}`);

// every part geometry has to stay inside the ~1200 triangle species budget
{
  let worst = 0;
  let worstName = '-';
  animals.group.traverse((obj) => {
    if (!obj.isInstancedMesh) return;
    const g = obj.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (tris > worst) { worst = tris; worstName = obj.name; }
    if (tris > 1200) fail(`${obj.name} uses ${tris} tris (species budget ~1200)`);
  });
  console.log(`heaviest animal part: ${worstName} at ${worst} tris`);
}

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

function scanAnimals(tag) {
  let checked = 0;
  animals.group.traverse((obj) => {
    if (obj.isInstancedMesh) {
      const arr = obj.instanceMatrix.array;
      const n = obj.count;
      for (let i = 0; i < n; i++) {
        const o = i * 16;
        const x = arr[o + 12], y = arr[o + 13], z = arr[o + 14];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          fail(`${tag}: NaN in ${obj.name} instance ${i}`);
        }
        if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) {
          fail(`${tag}: ${obj.name} instance ${i} outside the world (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
        }
        checked++;
      }
    } else if (obj.isPoints) {
      const arr = obj.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          fail(`${tag}: NaN in ${obj.name} point ${i / 3}`);
        }
        if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) {
          fail(`${tag}: ${obj.name} point ${i / 3} outside the world`);
        }
        checked++;
      }
    }
  });
  return checked;
}

function scanParticles(tag) {
  let checked = 0;
  let alive = 0;
  for (const points of particles.group.children) {
    if (!points.isPoints) continue;
    const attrs = points.geometry.attributes;
    const pos = attrs.position.array;
    const size = attrs.aSize.array;
    const alpha = attrs.aAlpha.array;
    const rot = attrs.aRot.array;
    const life = attrs.aLife.array;
    const tint = attrs.aTint.array;
    for (let i = 0; i < pos.length / 3; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      for (let k = 0; k < 3; k++) {
        if (!Number.isFinite(pos[i * 3 + k])) fail(`${tag}: NaN position in ${points.name}`);
      }
      if (!Number.isFinite(size[i]) || !Number.isFinite(alpha[i]) || !Number.isFinite(rot[i]) || !Number.isFinite(life[i])) {
        fail(`${tag}: NaN attribute in ${points.name} particle ${i}`);
      }
      for (let k = 0; k < 3; k++) {
        if (!Number.isFinite(tint[i * 3 + k])) fail(`${tag}: NaN tint in ${points.name}`);
      }
      if (y === PARKED_Y) {
        // dead particles are parked far below the world
        if (alpha[i] !== 0) fail(`${tag}: parked particle ${i} in ${points.name} has alpha ${alpha[i]}`);
      } else {
        alive++;
        if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) {
          fail(`${tag}: ${points.name} particle ${i} outside the world (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
        }
      }
      checked++;
    }
  }
  return { checked, alive };
}

// ---------------------------------------------------------------------------
// The ride: 600 frames, clock 0 -> 24, rider sweeping a circle
// ---------------------------------------------------------------------------

const RIDE_RADIUS = 1500;
const emitterX = layout.pois.village.position.x;
const emitterZ = layout.pois.village.position.z;
const emitterY = layout.heightAt(emitterX, emitterZ) + 8;

function placePlayer(frame) {
  const u = frame / FRAMES;
  const a = u * Math.PI * 2 * 1.5;
  const x = Math.cos(a) * RIDE_RADIUS;
  const z = Math.sin(a) * RIDE_RADIUS;
  const y = layout.heightAt(x, z) + 1.2;
  state.player.position.set(x, y, z);
  state.camera.position.set(x + 6, y + 3.2, z + 9);
  state.hour = (u * 24) % 24;
  return u;
}

let scanEvery = 25;
const rideStart = performance.now();
for (let i = 0; i < FRAMES; i++) {
  placePlayer(i);
  try {
    animals.update(DT, state);
    particles.update(DT, state);
  } catch (err) {
    fail(`update() threw at frame ${i} (hour ${state.hour.toFixed(2)}): ${err.message}`);
  }
  if (i === 100) {
    particles.registerEmitter(emitterX, emitterY, emitterZ, 'smoke', 1.4);
    particles.registerEmitter(emitterX + 40, emitterY, emitterZ + 20, 'fire', 1.0);
  }
  if (i === 150) {
    particles.registerEmitter(layout.pois.waterfall.position.x, layout.pois.waterfall.position.y, layout.pois.waterfall.position.z, 'mist', 1.2);
    if (particles.stats.emitters < 3) fail(`registerEmitter did not take: ${particles.stats.emitters}`);
  }
  if (i % scanEvery === 0) {
    scanAnimals(`frame ${i}`);
    scanParticles(`frame ${i}`);
  }
}
const rideMs = performance.now() - rideStart;
console.log(`ride: ${FRAMES} frames in ${rideMs.toFixed(1)} ms (${(rideMs / FRAMES).toFixed(2)} ms/frame)`);

// ---------------------------------------------------------------------------
// Positions / attributes after the ride
// ---------------------------------------------------------------------------

const animalSamples = scanAnimals('after ride');
const particleSamples = scanParticles('after ride');
console.log(`checked: ${animalSamples} animal instances, ${particleSamples.checked} particles (${particleSamples.alive} live)`);
if (particleSamples.alive <= 0) fail('no live particles after the ride');
if (!(animals.stats.active > 0)) fail('no active animals after the ride');

// ---------------------------------------------------------------------------
// Firefly gate: 22h and 3h on, 12h off
// ---------------------------------------------------------------------------

function firefliesAt(hour) {
  state.hour = hour;
  for (let i = 0; i < 4; i++) animals.update(DT, state);
  return animals.debug.fireflyVisible;
}

const ffNight = firefliesAt(22);
const ffDeep = firefliesAt(3);
const ffDay = firefliesAt(12);
console.log(`fireflies: 22h=${ffNight} 3h=${ffDeep} 12h=${ffDay}`);
if (!(ffNight > 0)) fail(`no fireflies visible at hour 22 (${ffNight})`);
if (!(ffDeep > 0)) fail(`no fireflies visible at hour 3 (${ffDeep})`);
if (ffDay !== 0) fail(`fireflies visible during the day: ${ffDay}`);

// ---------------------------------------------------------------------------
// Day bugs: butterflies + bees over the flower meadows
// ---------------------------------------------------------------------------

function standAt(x, z) {
  state.player.position.set(x, layout.heightAt(x, z) + 1.2, z);
  state.camera.position.set(x + 5, state.player.position.y + 3, z + 7);
}

function runFrames(n) {
  for (let i = 0; i < n; i++) {
    animals.update(DT, state);
    particles.update(DT, state);
  }
}

const anchor = animals.debug.butterflyAnchor;
standAt(anchor.x, anchor.z);
state.hour = 12;
runFrames(4);
const bugsDay = animals.debug.butterflyVisible + animals.debug.beeVisible;
state.hour = 23;
runFrames(4);
const bugsNight = animals.debug.butterflyVisible + animals.debug.beeVisible;
console.log(`meadow bugs: 12h=${bugsDay} 23h=${bugsNight}`);
if (!(bugsDay > 0)) fail(`no butterflies/bees visible in daylight (${bugsDay})`);
if (bugsNight !== 0) fail(`day bugs still flying at 23h (${bugsNight})`);

// ---------------------------------------------------------------------------
// Ambient families: west cliff spray, forest leaves, dawn lake mist
// ---------------------------------------------------------------------------

{
  const theta = Math.PI;                        // due west = the cliffs
  const r = layout.coastRadius(theta) - 45;
  const wx = Math.cos(theta) * r;
  const wz = Math.sin(theta) * r;
  standAt(wx, wz);
  state.hour = 17;
  state.wind.strength = 0.9;
  state.weather.rain = 0;
  const before = particles.stats.spray;
  runFrames(240);
  const spray = particles.stats.spray;
  console.log(`west cliff spray: ${before} -> ${spray} live`);
  if (!(spray > 0)) fail('no sea spray off the west cliffs in strong wind');
}

{
  const f = layout.pois.forest.position;
  standAt(f.x, f.z);
  state.wind.strength = 0.6;
  const before = particles.stats.leaf;
  runFrames(240);
  const leaf = particles.stats.leaf;
  console.log(`forest leaves: ${before} -> ${leaf} live`);
  if (!(leaf > 0)) fail('no falling leaves in the forest');
}

{
  standAt(layout.lake.center.x, layout.lake.center.z + 60);
  state.hour = 6.3;
  const before = particles.stats.smoke;
  runFrames(300);
  const smoke = particles.stats.smoke;
  console.log(`dawn lake mist: ${before} -> ${smoke} live smoke puffs`);
  if (!(smoke > before + 3)) fail('no lake mist at dawn');
}

if (particles.stats.alive > particles.stats.limit) {
  fail(`pool overflow: ${particles.stats.alive} live vs limit ${particles.stats.limit}`);
}

// ---------------------------------------------------------------------------
// Habitat sanity: ground species sit on the terrain, water species float
// ---------------------------------------------------------------------------

function meshByName(name) {
  let found = null;
  animals.group.traverse((o) => { if (o.name === name) found = o; });
  return found;
}

/** Positions of the instances that have actually been written at least once. */
function livePositions(name) {
  const mesh = meshByName(name);
  if (!mesh) fail(`missing mesh ${name}`);
  const arr = mesh.instanceMatrix.array;
  const out = [];
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 16;
    const used = Math.abs(arr[o]) + Math.abs(arr[o + 1]) + Math.abs(arr[o + 2]) +
      Math.abs(arr[o + 4]) + Math.abs(arr[o + 5]) + Math.abs(arr[o + 6]);
    if (used > 1e-5) out.push({ x: arr[o + 12], y: arr[o + 13], z: arr[o + 14] });
  }
  return out;
}

function visitRing(cx, cz, radius, n, frames) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    standAt(cx + Math.cos(a) * radius, cz + Math.sin(a) * radius);
    runFrames(frames);
  }
}

// ground dwellers: visit the road, the forest rim, the lake shore and the coast
const road = layout.pois.spawn.position;
visitRing(road.x, road.z, 220, 8, 3);
visitRing(layout.pois.forest.position.x, layout.pois.forest.position.z, layout.pois.forest.radius * 0.9, 8, 3);
visitRing(layout.lake.center.x, layout.lake.center.z, layout.lake.radius * 1.1, 8, 3);
for (let i = 0; i < 10; i++) {
  const theta = ((i + 0.5) / 10) * Math.PI * 2;
  const r = layout.coastRadius(theta) - 18;
  standAt(Math.cos(theta) * r, Math.sin(theta) * r);
  runFrames(3);
}

for (const name of ['animal:rabbits:0', 'animal:deer:0', 'animal:crabs:0', 'animal:herons:0']) {
  const pts = livePositions(name);
  if (!pts.length) fail(`${name} never came alive during the habitat sweep`);
  let worst = 0;
  for (const p of pts) {
    // hop arcs stay below ~0.5 m, crabs sink ~0.25 m
    worst = Math.max(worst, Math.abs(p.y - layout.heightAt(p.x, p.z)));
  }
  console.log(`${name}: ${pts.length} live, max terrain offset ${worst.toFixed(2)} m`);
  if (worst > 0.8) fail(`${name} is not touching the ground (${worst.toFixed(2)} m off)`);
}

// water dwellers
{
  standAt(layout.lake.center.x + 120, layout.lake.center.z);
  runFrames(20);
  const ducks = livePositions('animal:ducks:0').filter((p) => Math.abs(p.y - layout.lakeY) < 3);
  if (!ducks.length) fail('no ducks floating on the lake');
  for (const d of ducks) {
    if (layout.waterDepth(d.x, d.z) <= 0) fail(`duck at ${d.x.toFixed(0)},${d.z.toFixed(0)} is not on water`);
  }
  console.log(`ducks on the lake: ${ducks.length}`);
}

// the whale has to stay beyond r = 3000 offshore
{
  const w = livePositions('animal:whales:0')[0];
  if (!w) fail('whale was never updated');
  const r = Math.hypot(w.x, w.z);
  console.log(`whale: r=${r.toFixed(0)} m  y=${w.y.toFixed(1)}`);
  if (!(r > 3000)) fail(`whale is only ${r.toFixed(0)} m from the island`);
}

// dolphins in the east bay
{
  const p = layout.pois.beachEast.position;
  standAt(p.x, p.z);
  runFrames(30);
  const d = livePositions('animal:dolphins:0');
  if (!d.length) fail('no dolphins updated near the east bay');
  for (const q of d) {
    if (layout.waterDepth(q.x, q.z) <= 0.5) fail('dolphin is not in the water');
  }
  console.log(`dolphins leaping in the bay: ${d.length}`);
}

// gulls over the NE cliffs / harbour, 15-60 m up
{
  const lh = layout.pois.lighthouse.position;
  const hb = layout.pois.harbor.position;
  standAt(lh.x, lh.z);
  runFrames(20);
  const gulls = livePositions('animal:gulls:0');
  if (!gulls.length) fail('no gulls updated over the lighthouse cape');
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (const q of gulls) {
    const alt = q.y - Math.max(0, layout.heightAt(q.x, q.z));
    minAlt = Math.min(minAlt, alt);
    maxAlt = Math.max(maxAlt, alt);
    // two flocks exist: the lighthouse cape and the harbour
    const near = Math.min(Math.hypot(q.x - lh.x, q.z - lh.z), Math.hypot(q.x - hb.x, q.z - hb.z));
    if (near > 340) fail(`gull strayed ${near.toFixed(0)} m from both flocks`);
  }
  console.log(`gulls: ${gulls.length} live, altitude ${minAlt.toFixed(0)}..${maxAlt.toFixed(0)} m`);
  if (minAlt < 6 || maxAlt > 90) fail(`gull altitude out of range (${minAlt.toFixed(1)}..${maxAlt.toFixed(1)})`);
}

// jumping fish stay in the lake / river
{
  standAt(layout.lake.center.x, layout.lake.center.z);
  state.hour = 6.5;
  runFrames(60);
  const fish = livePositions('animal:fish:0');
  if (!fish.length) fail('no fish updated on the lake at dawn');
  for (const q of fish) {
    const inWater = layout.waterDepth(q.x, q.z) > 0 || layout.riverDistance(q.x, q.z) < 16;
    if (!inWater) fail(`fish out of water at ${q.x.toFixed(0)},${q.z.toFixed(0)}`);
  }
  console.log(`fish: ${fish.length} live on lake/river water`);
}

// butterflies and bees live over flowered meadows
{
  standAt(anchor.x, anchor.z);
  state.hour = 12;
  runFrames(20);
  const bugs = livePositions('animal:butterflies:0').concat(livePositions('animal:bees:0'));
  if (!bugs.length) fail('no day bugs updated on the meadow');
  let onMeadow = 0;
  for (const q of bugs) {
    const b = layout.biomeAt(q.x, q.z);
    if (b === 'meadow' || b === 'forest') onMeadow++;
  }
  console.log(`day bugs: ${bugs.length} live, ${onMeadow} over meadow/forest`);
  if (onMeadow < bugs.length * 0.6) fail('day bugs are not over the flowered meadows');
}

// ---------------------------------------------------------------------------
// Bursts - every entry point, then let them settle
// ---------------------------------------------------------------------------

const b = state.player.position;
particles.bursts.dust(b.x, b.y, b.z, 0.7, 0.5, 1.0);
particles.bursts.waterSplash(b.x, 0.2, b.z, 1.0);
particles.bursts.leaves(b.x, b.y + 1, b.z);
particles.bursts.sparkle(b.x, b.y + 1, b.z, 24);
particles.bursts.confetti(b.x, b.y + 1.5, b.z);
particles.bursts.smokePuff(b.x, b.y, b.z);
console.log(`bursts fired: ${particles.stats.bursts}, live particles: ${particles.stats.alive}`);
if (particles.stats.bursts < 6) fail(`burst counter did not advance: ${particles.stats.bursts}`);
if (!(particles.stats.alive > 0)) fail('bursts produced no particles');

for (let i = 0; i < 30; i++) {
  placePlayer(500 + i);
  animals.update(DT, state);
  particles.update(DT, state);
}
scanAnimals('after bursts');
scanParticles('after bursts');

// Emitters registered 100 frames apart must still be alive and puffing.
if (particles.stats.emitters !== 3) fail(`expected 3 emitters, got ${particles.stats.emitters}`);
{
  const before = particles.stats.smoke;
  state.hour = 19;
  for (let i = 0; i < 120; i++) particles.update(DT, state);
  console.log(`emitter-fed smoke particles: ${before} -> ${particles.stats.smoke}`);
  if (!(particles.stats.smoke > 0)) fail('runtime emitters produced no smoke');
}

// ---------------------------------------------------------------------------
// Timing: 600 frames of both modules together
// ---------------------------------------------------------------------------

const benchStart = performance.now();
for (let i = 0; i < FRAMES; i++) {
  placePlayer(i);
  animals.update(DT, state);
  particles.update(DT, state);
}
const benchMs = performance.now() - benchStart;
console.log(`budget: ${FRAMES} frames of animals+particles in ${benchMs.toFixed(1)} ms (${(benchMs / FRAMES).toFixed(3)} ms/frame, budget ${FRAME_BUDGET_MS} ms)`);
if (!(benchMs < FRAME_BUDGET_MS)) fail(`frame budget blown: ${benchMs.toFixed(1)} ms`);

// ---------------------------------------------------------------------------
// setQuality + a stateless update are allowed at any time
// ---------------------------------------------------------------------------

for (const level of ['low', 'medium', 'ultra', 'high']) {
  animals.setQuality(level);
  particles.setQuality(level);
  for (let i = 0; i < 10; i++) {
    animals.update(DT, state);
    particles.update(DT, state);
  }
  if (animals.stats.total < 1) fail(`animals vanished at quality ${level}`);
}
animals.setQuality('high');
particles.setQuality('high');

// the caps have to follow preset.animalScale / preset.particleScale
{
  const totals = {};
  const pools = {};
  for (const level of ['low', 'medium', 'high', 'ultra']) {
    animals.setQuality(level);
    particles.setQuality(level);
    totals[level] = animals.stats.total;
    pools[level] = particles.stats.budget;
  }
  console.log(
    `quality scale: animals low=${totals.low} medium=${totals.medium} high=${totals.high} ultra=${totals.ultra} | ` +
    `particle pool low=${pools.low} high=${pools.high} ultra=${pools.ultra}`
  );
  if (!(totals.low < totals.medium && totals.medium < totals.high)) fail('animal caps do not scale with the preset');
  if (!(totals.ultra >= totals.high)) fail('ultra carries fewer animals than high');
  if (!(pools.low >= 300 && pools.low < pools.high && pools.high < pools.ultra)) fail('particle pool does not scale');
  animals.setQuality('high');
  particles.setQuality('high');
}

animals.update(DT, undefined);
particles.update(DT, undefined);
animals.update(0, state);
particles.update(0, state);

// ---------------------------------------------------------------------------
// Final snapshot
// ---------------------------------------------------------------------------

state.hour = 22;
placePlayer(120);
for (let i = 0; i < 60; i++) {
  animals.update(DT, state);
  particles.update(DT, state);
}
const finalAnimals = scanAnimals('final');
const finalParticles = scanParticles('final');
console.log(
  `final: animals total=${animals.stats.total} active=${animals.stats.active} ` +
  `fireflies=${animals.debug.fireflyVisible} instances=${finalAnimals}`
);
console.log(
  `final: particles pool=${particles.stats.total} live=${particles.stats.alive} ` +
  `dust=${particles.stats.dust} smoke=${particles.stats.smoke} leaf=${particles.stats.leaf} ` +
  `spray=${particles.stats.spray} confetti=${particles.stats.confetti} spark=${particles.stats.spark}`
);
if (finalParticles.alive !== particles.stats.alive) fail('live particle count disagrees with the scan');

console.log('ALL LIFE TESTS PASSED');
