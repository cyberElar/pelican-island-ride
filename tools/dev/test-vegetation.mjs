/**
 * Dev test for world/vegetation.js - runs headless in Node.
 *
 * three.js core works without a DOM and createVegetation() never touches the
 * renderer, so the whole placement/instancing pipeline can be validated before
 * anything is drawn: build time, budgets, instance matrices, terrain contact
 * and the allocation-free update loop.
 *
 * Run: node tools/dev/test-vegetation.mjs
 */
import { createLayout } from '../../src/world/layout.js';
import { createVegetation } from '../../src/world/vegetation.js';
import { QUALITY_PRESETS } from '../../src/core/settings.js';
import { Rng } from '../../src/core/utils.js';

const SEED = 20261014;
const BUILD_BUDGET_MS = 6000;
const UPDATE_BUDGET_MS = 250;
const UPDATE_CALLS = 200;
const MATRIX_SAMPLES = 500;
const MIN_TREE_SPACING = 4;

// --- mocks ---------------------------------------------------------------

// Every TEX.* call returns the same stand-in surface record. Material setup
// only reads map/normalMap/roughnessMap/alphaMap, so null maps are fine.
const mockSurface = () => ({ map: null, normalMap: null, roughnessMap: null, alphaMap: null });
const textures = new Proxy({}, {
  get: (_target, key) => (typeof key === 'string' ? mockSurface() : undefined),
});

const engine = { preset: { ...QUALITY_PRESETS.high }, qualityLevel: 'high' };
const busEvents = [];
const bus = { on: (type) => { busEvents.push(type); return () => {}; }, emit: () => {} };

const layout = createLayout(SEED);

// --- build ---------------------------------------------------------------

const buildStart = performance.now();
const veg = createVegetation({
  engine,
  layout,
  textures,
  rng: new Rng('vegetation:test'),
  quality: 'high',
  bus,
});
const buildMs = performance.now() - buildStart;

console.log(`--- vegetation built in ${buildMs.toFixed(1)} ms (budget ${BUILD_BUDGET_MS} ms) ---`);
if (!(buildMs < BUILD_BUDGET_MS)) throw new Error(`vegetation build too slow: ${buildMs.toFixed(1)} ms`);

for (const key of ['group', 'update', 'setQuality', 'treeColliders', 'stats']) {
  if (!(key in veg)) throw new Error(`createVegetation() is missing "${key}"`);
}

const meshes = veg.group.children.filter((child) => child.isInstancedMesh);
if (meshes.length < 20) throw new Error(`too few instanced meshes: ${meshes.length}`);
if (busEvents.indexOf('quality:changed') < 0) throw new Error('quality:changed was not subscribed');

// --- budgets -------------------------------------------------------------

const { stats } = veg;
console.log(
  'counts: ' +
  `trees=${stats.trees} grass=${stats.grass} flowers=${stats.flowers} rocks=${stats.rocks} ` +
  `bushes=${stats.bushes} reeds=${stats.reeds} lilies=${stats.lilies} ` +
  `seaweed=${stats.seaweed} driftwood=${stats.driftwood} shells=${stats.shells}`
);
console.log(
  `chunks: grass=${stats.grassChunks} flowers=${stats.flowerChunks}  ` +
  `meshes=${meshes.length}  variants=${stats.variants}  colliders=${veg.treeColliders.length}`
);

if (!(stats.trees > 800)) throw new Error(`stats.trees too low: ${stats.trees}`);
if (!(stats.grass > 20000)) throw new Error(`stats.grass too low: ${stats.grass}`);
if (!(stats.flowers > 4000)) throw new Error(`stats.flowers too low: ${stats.flowers}`);
if (!(stats.rocks > 200)) throw new Error(`stats.rocks too low: ${stats.rocks}`);
if (!(stats.bushes > 200)) throw new Error(`stats.bushes too low: ${stats.bushes}`);
if (!(stats.reeds > 500)) throw new Error(`stats.reeds too low: ${stats.reeds}`);
if (stats.grassChunks < 12) throw new Error(`too few grass chunks: ${stats.grassChunks}`);
if (stats.grassChunks > 144) throw new Error(`too many grass chunks: ${stats.grassChunks}`);
if (veg.treeColliders.length > 600) throw new Error(`treeColliders over cap: ${veg.treeColliders.length}`);

// The species mix has to cover all six kinds.
const perSpecies = new Map();
for (const mesh of meshes) {
  if (mesh.userData.kind !== 'tree') continue;
  perSpecies.set(mesh.userData.species, (perSpecies.get(mesh.userData.species) || 0) + mesh.count);
}
const expectedSpecies = ['pine', 'oak', 'birch', 'palm', 'cypress', 'willow'];
for (const id of expectedSpecies) {
  const count = perSpecies.get(id) || 0;
  if (count < 50) throw new Error(`species "${id}" only has ${count} instances`);
}
console.log('species:', expectedSpecies.map((id) => `${id}=${perSpecies.get(id)}`).join(' '));

// --- instance matrices ---------------------------------------------------

const sampleRng = new Rng('vegetation:test:matrices');
let matricesChecked = 0;
let finiteProblem = null;
for (let i = 0; i < MATRIX_SAMPLES; i++) {
  const mesh = meshes[sampleRng.irange(0, meshes.length - 1)];
  if (!mesh.count) continue;
  const index = sampleRng.irange(0, mesh.count - 1);
  const array = mesh.instanceMatrix.array;
  for (let k = 0; k < 16; k++) {
    const value = array[index * 16 + k];
    if (!Number.isFinite(value)) {
      finiteProblem = `${mesh.name} instance ${index} element ${k} = ${value}`;
      break;
    }
  }
  if (finiteProblem) break;
  matricesChecked++;
}
if (finiteProblem) throw new Error(`non-finite instance matrix: ${finiteProblem}`);

let matricesTotal = 0;
for (const mesh of meshes) matricesTotal += mesh.count;
console.log(`matrices: ${matricesChecked} sampled of ${matricesTotal} instances, all finite`);

// --- trees sit on the terrain -------------------------------------------

{
  const meshSettings = { pine: 5, oak: 5, birch: 5, palm: 5, cypress: 5, willow: 5 };
  for (const id of expectedSpecies) {
    let best = null;
    let localBaseMin = Infinity;
    for (const mesh of meshes) {
      if (mesh.userData.kind !== 'tree' || mesh.userData.species !== id) continue;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      localBaseMin = Math.min(localBaseMin, mesh.geometry.boundingBox.min.y);

      // "5 m tall trunk sample": the instance whose scaled trunk height lands
      // closest to the 5 m test height.
      const array = mesh.instanceMatrix.array;
      const canonicalHeight = mesh.userData.height;
      for (let i = 0; i < mesh.count; i++) {
        const scaleY = Math.hypot(array[i * 16 + 4], array[i * 16 + 5], array[i * 16 + 6]);
        const treeHeight = canonicalHeight * scaleY;
        const score = Math.abs(treeHeight - meshSettings[id]);
        if (!best || score < best.score) {
          best = {
            score,
            x: array[i * 16 + 12],
            y: array[i * 16 + 13],
            z: array[i * 16 + 14],
            treeHeight,
            mesh: mesh.name,
          };
        }
      }
    }
    if (!best) throw new Error(`no ${id} instances to check`);
    if (Math.abs(localBaseMin) > 0.05) {
      throw new Error(`${id} trunk geometry is not based at local y=0 (min y ${localBaseMin})`);
    }
    const terrainY = layout.heightAt(best.x, best.z);
    const error = Math.abs(best.y - terrainY);
    console.log(
      `${id.padEnd(8)} 5 m trunk sample: base y ${best.y.toFixed(3)} vs terrain ${terrainY.toFixed(3)} ` +
      `-> error ${error.toFixed(3)} m (sample height ${best.treeHeight.toFixed(1)} m)`
    );
    if (!(error <= 0.5)) throw new Error(`${id} floats above the terrain by ${error.toFixed(3)} m`);
  }
}

// --- placement rules (sampled) -------------------------------------------

{
  const step = (mesh) => Math.max(1, Math.floor(mesh.count / 80));
  const violations = { treeOnRoad: 0, treeInWater: 0, treeInPoi: 0, grassOnRoad: 0, grassInWater: 0 };
  const landmarkPois = layout.poiList.filter((p) => p.type !== 'region' && p.type !== 'spawn');

  for (const mesh of meshes) {
    const kind = mesh.userData.kind;
    if (kind !== 'tree' && kind !== 'grass') continue;
    const array = mesh.instanceMatrix.array;
    for (let i = 0; i < mesh.count; i += step(mesh)) {
      const x = array[i * 16 + 12];
      const z = array[i * 16 + 14];
      if (kind === 'tree') {
        if (layout.roadDistance(x, z) < layout.roadWidth * 0.5) violations.treeOnRoad++;
        if (layout.waterDepth(x, z) > 0.3) violations.treeInWater++;
        for (const poi of landmarkPois) {
          if (Math.hypot(x - poi.position.x, z - poi.position.z) < poi.radius * 0.98) {
            violations.treeInPoi++;
            break;
          }
        }
      } else {
        const biome = layout.biomeAt(x, z);
        if (biome === 'road') violations.grassOnRoad++;
        if (biome === 'lake' || biome === 'ocean' || biome === 'river') violations.grassInWater++;
      }
    }
  }
  console.log('placement rules sampled:', JSON.stringify(violations));
  for (const key of Object.keys(violations)) {
    if (violations[key] > 0) throw new Error(`${key}: ${violations[key]} violations`);
  }
}

// --- update loop ---------------------------------------------------------

{
  const camera = { position: { x: 0, y: 40, z: 0 } };
  const state = {
    t: 0,
    camera,
    player: { position: { x: 0, y: 0, z: 0 }, speed: 9 },
    wind: { x: 0.7, z: 0.5, strength: 0.4, gust: 0 },
  };
  const timeBefore = veg.sharedUniforms.time.value;
  const updateStart = performance.now();
  for (let i = 0; i < UPDATE_CALLS; i++) {
    state.t += 1 / 60;
    camera.position.x = Math.cos(i * 0.031) * 900;
    camera.position.y = 30 + 10 * Math.sin(i * 0.07);
    camera.position.z = Math.sin(i * 0.031) * 900;
    state.wind.strength = 0.3 + 0.3 * Math.sin(i * 0.05);
    state.wind.gust = 0.2 * Math.sin(i * 0.21);
    veg.update(1 / 60, state);
  }
  const updateMs = performance.now() - updateStart;
  console.log(
    `update: ${UPDATE_CALLS} calls with a moving camera in ${updateMs.toFixed(2)} ms ` +
    `(budget ${UPDATE_BUDGET_MS} ms)`
  );
  if (!(updateMs < UPDATE_BUDGET_MS)) throw new Error(`update loop too slow: ${updateMs.toFixed(2)} ms`);
  if (!(veg.sharedUniforms.time.value > timeBefore)) throw new Error('wind time uniform did not advance');
  if (!Number.isFinite(veg.sharedUniforms.windStrength.value)) throw new Error('wind strength went NaN');
}

// --- quality switch ------------------------------------------------------

{
  const highTrees = veg.stats.trees;
  const highGrass = veg.stats.grass;
  veg.setQuality('low');
  const lowTrees = veg.stats.trees;
  const lowGrass = veg.stats.grass;
  console.log(`quality: high trees=${highTrees} grass=${highGrass} -> low trees=${lowTrees} grass=${lowGrass}`);
  if (!(lowTrees < highTrees)) throw new Error('quality downshift did not reduce trees');
  if (!(lowGrass < highGrass)) throw new Error('quality downshift did not reduce grass');
  if (!(lowGrass > 15000)) throw new Error(`low preset grass budget too small: ${lowGrass}`);
  let leafShadowMeshes = 0;
  for (const mesh of veg.group.children) {
    if (mesh.castShadow && mesh.userData.shadowTier === 'trunkFoliage') leafShadowMeshes++;
  }
  if (leafShadowMeshes !== 0) throw new Error('low preset still lets tree foliage cast shadows');
  veg.setQuality('high');
  if (veg.stats.trees !== highTrees) throw new Error('quality restore did not restore tree counts');
}

console.log('ALL VEGETATION TESTS PASSED');
