/**
 * test-landmarks.mjs - headless dev test for src/world/landmarks.js.
 *
 * Builds the real island (createLayout(20261014)) with a mock texture library
 * and a mock engine, then checks the createLandmarks() contract:
 *   - build time, stats.count, collider/emitter/parts shape
 *   - every set piece's ground anchor lines up with layout.heightAt (the sea
 *     arch and sea stacks anchor at water level instead)
 *   - the lighthouse beam sweeps in update(), the balloons bob
 *   - no NaN in matrices or geometry, 300 updates inside the frame budget
 *
 * Run: cd work/pelican-island ; node tools/dev/test-landmarks.mjs
 */

import assert from 'node:assert/strict';
import { createLayout } from '../../src/world/layout.js';
import { createLandmarks } from '../../src/world/landmarks.js';
import { QUALITY_PRESETS } from '../../src/core/settings.js';

// ---------------------------------------------------------------------------
// Mock texture library: no DOM, no canvas. Every surface factory returns
// { map, normalMap, roughnessMap, alphaMap }; TEX.canvas() yields a stub canvas
// whose 2D context swallows every draw call, and TEX.texture() a stub texture.
// ---------------------------------------------------------------------------

const SURFACE = { map: null, normalMap: null, roughnessMap: null, alphaMap: null };
const noop = () => {};

function stubContext2d() {
  return new Proxy({}, {
    get(target, key) {
      if (key === 'measureText') return () => ({ width: 120 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (key in target) return target[key];
      return noop;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

const stubCanvas = {
  width: 0,
  height: 0,
  getContext: () => stubContext2d(),
};

const textures = new Proxy({}, {
  get(_target, key) {
    if (key === 'canvas') {
      return (size) => {
        stubCanvas.width = size || 256;
        stubCanvas.height = size || 256;
        return stubCanvas;
      };
    }
    return () => SURFACE;
  },
});

const layout = createLayout(20261014);
const ctx = {
  engine: { preset: QUALITY_PRESETS.high, quality: 'high', renderer: null, scene: null },
  layout,
  textures,
  rng: null,
  quality: 'high',
  bus: null,
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const t0 = performance.now();
const landmarks = await createLandmarks(ctx);
const buildMs = performance.now() - t0;

assert.ok(landmarks && typeof landmarks === 'object', 'createLandmarks must return an object');
assert.ok(landmarks.group && landmarks.group.isObject3D, 'group must be a THREE.Group');
assert.equal(typeof landmarks.update, 'function', 'update() must be a function');
assert.ok(Array.isArray(landmarks.colliders), 'colliders must be an array');
assert.ok(Array.isArray(landmarks.emitters), 'emitters must be an array');
assert.ok(landmarks.parts && typeof landmarks.parts === 'object', 'parts must be an object');
assert.ok(landmarks.stats && typeof landmarks.stats === 'object', 'stats must be an object');
assert.ok(Array.isArray(landmarks.samples), 'samples must be an array (QA ground anchors)');
assert.ok(landmarks.group.parent === null, 'the module must not add its own group to a scene');

console.log(`--- landmarks built in ${buildMs.toFixed(1)} ms ---`);
assert.ok(buildMs < 6000, `build must stay under 6 s, took ${buildMs.toFixed(1)} ms`);

// stats -------------------------------------------------------------------
{
  const { count, tris } = landmarks.stats;
  console.log(`stats: count=${count} tris=${tris} meshes=${landmarks.stats.meshes} lines=${landmarks.stats.lines}`);
  assert.ok(Number.isFinite(count) && count >= 13, `stats.count must be >= 13, got ${count}`);
  assert.ok(Number.isFinite(tris) && tris > 5000, `stats.tris must be a real triangle count, got ${tris}`);
  assert.ok(landmarks.stats.meshes > 0, 'stats.meshes must be > 0');
}

// draw calls ---------------------------------------------------------------
{
  let draws = 0;
  landmarks.group.traverse((o) => {
    if (o.isMesh) {
      draws++;
      assert.ok(o.material, 'every mesh needs a material');
    } else if (o.isLine) {
      draws++;
    }
  });
  console.log(`draw calls: ${draws} (budget 200)`);
  assert.ok(draws < 200, `landmarks must stay under 200 draw calls, got ${draws}`);
}

// samples vs terrain -------------------------------------------------------
{
  assert.ok(
    landmarks.samples.length === landmarks.stats.count,
    `${landmarks.samples.length} ground anchors for ${landmarks.stats.count} set pieces`,
  );
  const seen = new Set();
  let worst = 0;
  let worstId = '';
  for (const s of landmarks.samples) {
    assert.ok(typeof s.id === 'string' && s.id.length > 0, 'sample.id must be a string');
    assert.ok(!seen.has(s.id), `duplicate sample id "${s.id}"`);
    seen.add(s.id);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z), `sample ${s.id} needs finite x/z`);
    assert.ok(Number.isFinite(s.baseY), `sample ${s.id} needs a finite baseY`);
    if (s.id === 'seaArch' || s.id === 'seaStacks') {
      assert.ok(Math.abs(s.baseY) <= 1, `${s.id} must sit at water level y=0, got ${s.baseY}`);
    } else {
      const err = Math.abs(s.baseY - layout.heightAt(s.x, s.z));
      if (err > worst) {
        worst = err;
        worstId = s.id;
      }
      assert.ok(
        err <= 1.5,
        `${s.id} base y ${s.baseY.toFixed(2)} is ${err.toFixed(2)} m off the terrain ` +
        `${layout.heightAt(s.x, s.z).toFixed(2)} at (${s.x.toFixed(0)}, ${s.z.toFixed(0)})`,
      );
    }
  }
  console.log(`ground anchors: ${landmarks.samples.length} checked, worst offset ${worst.toFixed(2)} m (${worstId})`);
  for (const s of landmarks.samples) {
    const terrain = layout.heightAt(s.x, s.z);
    console.log(
      `  ${s.id.padEnd(15)} (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) y=${s.y.toFixed(2)} ` +
      `baseY=${s.baseY.toFixed(2)} terrain=${terrain.toFixed(2)}`,
    );
  }
}

// colliders / emitters -----------------------------------------------------
{
  console.log(`colliders: ${landmarks.colliders.length} (contract < 200, design target < 80)`);
  assert.ok(landmarks.colliders.length < 200, `colliders must stay under 200, got ${landmarks.colliders.length}`);
  assert.ok(landmarks.colliders.length < 80, `colliders should stay under the 80-entry design budget`);
  for (const c of landmarks.colliders) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.r), 'colliders need finite x/z/r');
    assert.ok(c.r > 0, 'collider radius must be positive');
  }
  const mist = landmarks.emitters.filter((e) => e.type === 'mist');
  assert.ok(mist.length >= 1, 'at least one mist emitter is required by the particles hand-off');
  for (const e of landmarks.emitters) {
    assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z), 'emitters need finite x/y/z');
    assert.ok(Number.isFinite(e.rate) && e.rate > 0, 'emitters need a positive rate');
  }
  console.log(`emitters: ${JSON.stringify(landmarks.emitters)}`);
}

// parts --------------------------------------------------------------------
{
  const parts = landmarks.parts;
  for (const key of ['beam', 'beamRotator', 'beamMat', 'banner', 'poolCenter', 'balloons', 'telescopeYoke']) {
    assert.ok(parts[key] !== undefined && parts[key] !== null, `parts.${key} must be exposed`);
  }
  assert.ok(parts.beam.isObject3D, 'parts.beam must be a mesh');
  assert.ok(parts.beamRotator.isObject3D, 'parts.beamRotator must be an object');
  assert.ok(parts.banner.isObject3D, 'parts.banner must be a mesh');
  assert.ok(parts.telescopeYoke.isObject3D, 'parts.telescopeYoke must be an object');
  assert.ok(Array.isArray(parts.balloons), 'parts.balloons must list the balloon groups');
  assert.equal(parts.balloons.length, 4, 'exactly four balloons: 2 tethered, 1 drifting, 1 grounded');
  for (const balloon of parts.balloons) {
    assert.ok(balloon.isObject3D, 'every balloons[] entry must be an Object3D');
  }
  assert.ok(parts.balloonsField.isObject3D, 'parts.balloonsField must be the meadow group');
  assert.ok(typeof parts.bridgeDeckTop === 'number', 'parts.bridgeDeckTop must be a number');
  const bridgeErr = Math.abs(parts.bridgeDeckTop - (layout.pois.bridge.position.y - 0.15));
  assert.ok(bridgeErr < 0.05, `bridge deck top must reach poi.y - 0.15 (off by ${bridgeErr.toFixed(3)})`);
  for (const key of ['x', 'y', 'z']) {
    assert.ok(Number.isFinite(parts.poolCenter[key]), `parts.poolCenter.${key} must be finite`);
  }
  assert.ok(
    Math.hypot(
      parts.poolCenter.x - layout.pois.pool.position.x,
      parts.poolCenter.z - layout.pois.pool.position.z,
    ) < 60,
    'parts.poolCenter must sit at the waterfall pool',
  );
  console.log(
    `parts: ${Object.keys(parts).length} refs; bridge deck top ${parts.bridgeDeckTop.toFixed(2)} m ` +
    `(poi ${layout.pois.bridge.position.y.toFixed(2)}); pool center ` +
    `(${parts.poolCenter.x.toFixed(0)}, ${parts.poolCenter.y.toFixed(1)}, ${parts.poolCenter.z.toFixed(0)})`,
  );
}

// emissive-only night lighting --------------------------------------------
{
  let lights = 0;
  landmarks.group.traverse((o) => {
    if (o.isLight) lights++;
  });
  assert.equal(lights, 0, 'landmarks must not create real THREE lights (emissive only)');
}

// ---------------------------------------------------------------------------
// update(): beam sweep, balloon bob, night emissives
// ---------------------------------------------------------------------------

const dayState = { hour: 17.1, weather: { cloudiness: 0.3 }, wind: { strength: 0.4 } };
const nightState = { hour: 23.0, weather: { cloudiness: 0.2 }, wind: { strength: 0.5 } };

{
  landmarks.update(0.25, dayState);
  const before = landmarks.parts.beamRotator.rotation.y;
  landmarks.update(1.0, dayState);
  const after = landmarks.parts.beamRotator.rotation.y;
  assert.ok(Number.isFinite(after), 'beam rotation must stay finite');
  assert.ok(Math.abs(after - before) > 0.05, `the beam must rotate across update(1.0), moved ${(after - before).toFixed(4)}`);

  landmarks.update(0.016, dayState);
  assert.ok(landmarks.parts.beamMat.opacity === 0, `beam opacity must be 0 by day, got ${landmarks.parts.beamMat.opacity}`);
  landmarks.update(0.016, nightState);
  assert.ok(
    Math.abs(landmarks.parts.beamMat.opacity - 0.25) < 0.02,
    `beam opacity must be ~0.25 at night, got ${landmarks.parts.beamMat.opacity}`,
  );
  const beforeNight = landmarks.parts.beamRotator.rotation.y;
  landmarks.update(0.25, nightState);
  const nightStep = landmarks.parts.beamRotator.rotation.y - beforeNight;
  landmarks.update(0.25, dayState);
  const dayStep = landmarks.parts.beamRotator.rotation.y - beforeNight - nightStep;
  assert.ok(nightStep > dayStep, 'the beam must sweep faster at night than by day');
  console.log(
    `beam: day step ${dayStep.toFixed(3)} rad, night step ${nightStep.toFixed(3)} rad, ` +
    `opacity day/night ${0} / ${0.25}`,
  );
}

{
  // 60 updates of the balloon meadow: the tethered pair must bob.
  const minY = landmarks.parts.balloons.map((b) => b.position.y);
  const maxY = minY.slice();
  for (let i = 0; i < 60; i++) {
    landmarks.update(1 / 30, i % 2 === 0 ? dayState : nightState);
    for (let k = 0; k < landmarks.parts.balloons.length; k++) {
      const y = landmarks.parts.balloons[k].position.y;
      if (y < minY[k]) minY[k] = y;
      if (y > maxY[k]) maxY[k] = y;
    }
  }
  const spans = minY.map((lo, k) => maxY[k] - lo);
  const best = Math.max(...spans);
  assert.ok(spans.every((s) => Number.isFinite(s)), 'balloon heights must stay finite');
  assert.ok(best > 0.05, `balloons must change height across 60 updates, largest span ${best.toFixed(4)} m`);
  console.log(`balloons: y spans over 60 updates = [${spans.map((s) => s.toFixed(2)).join(', ')}] m`);
}

// hostile / partial states must not throw ----------------------------------
for (const state of [undefined, null, {}, { hour: NaN }, { hour: Infinity }, { player: { speed: 12 } }]) {
  assert.doesNotThrow(() => landmarks.update(1 / 60, state), 'update() must survive partial states');
}
assert.doesNotThrow(() => landmarks.update(NaN, dayState), 'update(NaN) must be safe');
assert.doesNotThrow(() => landmarks.update(-1, dayState), 'update(negative) must be safe');
assert.doesNotThrow(() => landmarks.update(1e6, dayState), 'update(huge dt) must be safe');

// ---------------------------------------------------------------------------
// NaN + performance sweeps
// ---------------------------------------------------------------------------

{
  landmarks.update(1 / 60, dayState);
  landmarks.group.updateMatrixWorld(true);
  let sampled = 0;
  let bad = 0;
  landmarks.group.traverse((o) => {
    if (sampled >= 300) return;
    sampled++;
    const e = o.matrixWorld.elements;
    for (let i = 0; i < e.length; i++) if (!Number.isFinite(e[i])) bad++;
    if (!Number.isFinite(o.position.x) || !Number.isFinite(o.position.y) || !Number.isFinite(o.position.z)) bad++;
    if (!Number.isFinite(o.rotation.x) || !Number.isFinite(o.rotation.z)) bad++;
  });
  assert.equal(bad, 0, `${bad} non-finite transform values in ${sampled} sampled objects`);
  console.log(`matrices: ${sampled} objects sampled, 0 NaN`);

  // geometry sanity: no NaN vertices, valid bounding boxes
  let verts = 0;
  let badVerts = 0;
  landmarks.group.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    assert.ok(pos && pos.count > 0, 'every mesh needs vertices');
    for (let i = 0; i < pos.count; i++) {
      verts++;
      if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) badVerts++;
    }
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    assert.ok(
      Number.isFinite(b.min.x) && Number.isFinite(b.max.y) && Number.isFinite(b.max.z),
      'geometry bounding boxes must be finite',
    );
  });
  assert.equal(badVerts, 0, `${badVerts} non-finite vertices`);
  console.log(`geometry: ${verts} vertices scanned, 0 NaN`);
}

{
  const frames = 300;
  const t1 = performance.now();
  for (let i = 0; i < frames; i++) {
    landmarks.update(1 / 60, { hour: 17.1 + (i % 30) * 0.25 });
  }
  const ms = performance.now() - t1;
  console.log(`update: ${frames} frames in ${ms.toFixed(2)} ms (${(ms / frames * 1000).toFixed(1)} us/frame)`);
  assert.ok(ms < 250, `300 updates must stay under 250 ms, took ${ms.toFixed(1)} ms`);
}

// ---------------------------------------------------------------------------
// Determinism + a second quality level
// ---------------------------------------------------------------------------

{
  const again = await createLandmarks(ctx);
  assert.deepEqual(again.samples, landmarks.samples, 'the same seed must rebuild identical ground anchors');
  assert.deepEqual(again.colliders, landmarks.colliders, 'the same seed must rebuild identical colliders');
  assert.equal(again.stats.tris, landmarks.stats.tris, 'the same seed must rebuild the same triangle count');
  assert.deepEqual(again.emitters, landmarks.emitters, 'the same seed must rebuild identical emitters');
  console.log('determinism: rebuild matches samples/colliders/emitters/stats');
}

{
  const low = await createLandmarks({
    engine: { preset: QUALITY_PRESETS.low, quality: 'low' },
    layout,
    textures,
    rng: null,
    quality: 'low',
    bus: null,
  });
  let casters = 0;
  let meshes = 0;
  low.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    if (o.castShadow) casters++;
  });
  assert.equal(low.stats.count, landmarks.stats.count, 'every quality level builds the same set pieces');
  assert.ok(meshes > 0 && low.stats.tris > 5000, 'the low preset must still build real geometry');
  assert.equal(casters, 0, 'shadows must be off when the preset disables them');
  assert.doesNotThrow(() => low.update(1 / 60, { hour: 22.5 }), 'the low-quality build must animate');
  console.log(`quality: low build ok (pieces=${low.stats.count}, meshes=${meshes}, shadow casters=${casters})`);
}

console.log('ALL LANDMARKS TESTS PASSED');
