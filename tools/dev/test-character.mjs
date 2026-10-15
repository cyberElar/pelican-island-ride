/**
 * Dev test for src/character/{pelican,bicycle,rider}.js.
 *
 * Runs headless in Node (three.js core needs no DOM as long as no canvas is
 * touched at construction). Builds the whole rider against a mock texture
 * library, reports triangle counts + bounding boxes, then exercises the update
 * loop: pedalling kinematics, crank/wheel coupling and the pouch jiggle.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

import { Rng } from '../../src/core/utils.js';
import { createPelican } from '../../src/character/pelican.js';
import { createBicycle, BIKE_DIMS } from '../../src/character/bicycle.js';
import { createRider } from '../../src/character/rider.js';

const here = dirname(fileURLToPath(import.meta.url));
const charDir = join(here, '..', '..', 'src', 'character');

// ---------------------------------------------------------------------------
// Mock ctx
// ---------------------------------------------------------------------------

const surface = () => ({ map: null, normalMap: null, roughnessMap: null });
const textures = new Proxy({}, { get: () => () => surface() });

const ctx = {
  engine: {},
  layout: null,
  textures,
  rng: new Rng(1),
  quality: 'high',
  bus: { on() {}, emit() {} },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countTriangles(object) {
  let tris = 0;
  object.traverse((o) => {
    const geo = o.geometry;
    if (!geo) return;
    const count = geo.index ? geo.index.count : geo.getAttribute('position').count;
    // InstancedMesh stores its instance count in `.count` (r186).
    const instances = o.isInstancedMesh ? o.count : 1;
    tris += (count / 3) * instances;
  });
  return Math.round(tris);
}

function meshCount(object) {
  let n = 0;
  object.traverse((o) => { if (o.isMesh || o.isInstancedMesh) n++; });
  return n;
}

function boxOf(object) {
  const box = new THREE.Box3().setFromObject(object);
  return {
    box,
    size: box.getSize(new THREE.Vector3()),
    min: box.min,
    max: box.max,
  };
}

const fmt = (v) => v.toFixed(3).padStart(7);
function printBox(label, object) {
  const { min, max, size } = boxOf(object);
  console.log(
    `${label.padEnd(9)} bbox x[${fmt(min.x)},${fmt(max.x)}]`
    + ` y[${fmt(min.y)},${fmt(max.y)}]`
    + ` z[${fmt(min.z)},${fmt(max.z)}]`
    + `  size ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m`,
  );
}

function makeState() {
  return {
    t: 0,
    dt: 0.016,
    hour: 17.1,
    dayLength: 900,
    timeScale: 1,
    quality: 'high',
    paused: false,
    photoMode: false,
    started: true,
    player: {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      heading: 0,
      speed: 0,
      lean: 0,
      steer: 0,
      wheelSpin: 0,
      onRoad: true,
      surface: 'asphalt',
      grounded: true,
      inWater: false,
      boost: 0,
      crash: 0,
      distanceTravelled: 0,
      airTime: 0,
    },
    camera: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), mode: 'chase', fov: 60 },
    feathers: { collected: 0, total: 40 },
    discovered: Object.create(null),
    race: { active: false, checkpoint: 0, time: 0, best: null },
    wind: { x: 0.7, z: 0.5, strength: 0.4, gust: 0 },
    weather: { rain: 0, cloudiness: 0.35, fogBoost: 0 },
    sun: { dir: new THREE.Vector3(0, 1, 0), color: new THREE.Color(0xffffff), intensity: 3 },
    moon: { dir: new THREE.Vector3(0, -1, 0), intensity: 0.2 },
    events: [],
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const t0 = performance.now();
const pelican = createPelican(ctx);
const bicycle = createBicycle(ctx);
const rider = createRider(ctx);
const buildMs = performance.now() - t0;

const pelicanTris = countTriangles(pelican.root);
const bicycleTris = countTriangles(bicycle.root);
const riderTris = countTriangles(rider.root);

console.log(`--- character built in ${buildMs.toFixed(1)} ms ---`);
console.log('');
console.log('triangle counts');
console.log(`  pelican        ${String(pelicanTris).padStart(6)} tris, ${String(meshCount(pelican.root)).padStart(3)} meshes`);
console.log(`  bicycle        ${String(bicycleTris).padStart(6)} tris, ${String(meshCount(bicycle.root)).padStart(3)} meshes`);
console.log(`  rider (total)  ${String(riderTris).padStart(6)} tris, ${String(meshCount(rider.root)).padStart(3)} meshes`);
console.log('');
console.log('bounding boxes (local space)');
printBox('pelican', pelican.root);
printBox('bicycle', bicycle.root);
printBox('rider', rider.root);
console.log('');
const b = rider.bounds;
console.log(`rider bounds: length ${b.length.toFixed(2)} m  height ${b.height.toFixed(2)} m`
  + `  width ${b.width.toFixed(2)} m  radius ${b.radius.toFixed(2)} m  top ${b.top.toFixed(2)} m`);
console.log('');

// --- budgets from the brief ---
assert.ok(pelicanTris >= 5500 && pelicanTris <= 12500,
  `pelican tri budget: expected ~6-12k, got ${pelicanTris}`);
assert.ok(bicycleTris >= 9500 && bicycleTris <= 16500,
  `bicycle tri budget: expected ~10-16k, got ${bicycleTris}`);
assert.ok(Math.abs(riderTris - (pelicanTris + bicycleTris)) < 50,
  'rider total should equal pelican + bicycle');

// --- silhouette sanity: length ~1.9 m, total height ~1.85 m ---
assert.ok(b.height > 1.75 && b.height < 1.95, `rider height ${b.height.toFixed(2)} m out of range`);
// Overall bbox includes the pennant trailing ~0.33 m behind the rear wheel.
assert.ok(b.length > 1.7 && b.length < 2.35, `rider length ${b.length.toFixed(2)} m out of range`);
{
  const coreLength = boxOf(rider.parts.frontFender).max.z - boxOf(rider.parts.rearWheelGroup).min.z;
  console.log(`vehicle length (front fender tip -> rear tyre): ${coreLength.toFixed(2)} m`);
  assert.ok(coreLength > 1.75 && coreLength < 1.98, `vehicle length ${coreLength.toFixed(2)} m out of range`);
}
{
  const torso = boxOf(pelican.parts.torso).size;
  const beak = boxOf(pelican.parts.upperBeak).size;
  const crown = boxOf(pelican.root).max.y;
  const standHeight = crown - boxOf(pelican.root).min.y;
  console.log(`pelican: torso ${torso.z.toFixed(2)} m long, upper beak ${beak.z.toFixed(2)} m,`
    + ` standing height ${standHeight.toFixed(2)} m`);
  assert.ok(torso.z > 0.9 && torso.z < 1.15, `torso length ${torso.z.toFixed(2)} m should be ~1.05 m`);
  assert.ok(beak.z > 0.55 && beak.z < 0.68, `beak length ${beak.z.toFixed(2)} m should be ~0.6 m`);
  assert.ok(standHeight > 1.5 && standHeight < 1.8, `pelican standing height ${standHeight.toFixed(2)} m`);
}

// --- required part names ---
for (const key of [
  'frontWheel', 'rearWheel', 'rearWheelGroup', 'frontWheelGroup', 'handlebar',
  'crank', 'pedals', 'flagMesh', 'headlamp', 'bellMesh', 'frameGroup',
  'pouch', 'wingL', 'wingR', 'footL', 'footR', 'beak', 'lids', 'neck', 'head',
]) {
  assert.ok(rider.parts[key], `rider.parts.${key} is missing`);
}
assert.equal(rider.parts.pedals.length, 2, 'expected two pedals');
assert.ok(typeof rider.parts.headlamp.material.emissiveIntensity === 'number',
  'parts.headlamp must expose an emissive material for the night pass');
assert.ok(rider.parts.flagMesh.isMesh && rider.parts.flagMesh.geometry.attributes.position.count === 77,
  'flagMesh should be a 10x6 plane (77 vertices) for vertex animation');
assert.equal(rider.group, rider.root, 'rider.group must alias rider.root for the module loader');

// ---------------------------------------------------------------------------
// update(): kinematics
// ---------------------------------------------------------------------------

const state = makeState();

let firstError = null;
try {
  rider.update(0.016, state);
} catch (err) {
  firstError = err;
}
assert.equal(firstError, null, `rider.update threw: ${firstError && firstError.stack}`);
console.log('update() #1 (speed 0, wheelSpin 0): ok');

const rear0 = rider.parts.rearWheelGroup.rotation.x;
const crank0 = rider.parts.crank.rotation.x;
const pouch0 = rider.parts.pouch.scale.y;
assert.ok(Math.abs(pouch0 - 1) < 1e-6, `pouch should rest at scale.y = 1 when parked, got ${pouch0}`);

state.t = 0.016;
state.player.speed = 6;
state.player.wheelSpin = 3.5;
state.player.steer = 0.25;
state.player.lean = 0.18;
state.player.position.set(0, 0, 12);

let secondError = null;
try {
  rider.update(0.016, state);
} catch (err) {
  secondError = err;
}
assert.equal(secondError, null, `rider.update threw: ${secondError && secondError.stack}`);
console.log('update() #2 (speed 6, wheelSpin 3.5): ok');

const rear1 = rider.parts.rearWheelGroup.rotation.x;
const crank1 = rider.parts.crank.rotation.x;
const pouch1 = rider.parts.pouch.scale.y;

assert.notEqual(rear1, rear0, 'rearWheelGroup rotation did not change with wheelSpin');
assert.notEqual(crank1, crank0, 'crank rotation did not change with wheelSpin');
assert.notEqual(pouch1, pouch0, 'pouch scale.y did not react to speed');
assert.ok(Math.abs(rear1 - 3.5) < 1e-9, 'rear wheel should spin exactly with state.player.wheelSpin');
assert.ok(Math.abs(crank1 - 3.5 * BIKE_DIMS.crank.gearRatio) < 1e-9,
  'crank should follow wheelSpin * gearRatio');
assert.equal(rider.parts.pedals[0].rotation.x, -crank1, 'pedal platforms must stay level');
assert.ok(Math.abs(rider.parts.handlebar.rotation.y - 0.25 * BIKE_DIMS.steerRatio) < 1e-9,
  'handlebar.rotation.y should be steer * 0.45');
assert.ok(Math.abs(rider.parts.leanGroup.rotation.z - 0.18) < 1e-9, 'leanGroup.rotation.z should equal lean');
assert.ok(rider.parts.frontWheel.rotation.x === rider.parts.rearWheelGroup.rotation.x,
  'front and rear wheels must spin together');
assert.ok(rider.root.position.distanceTo(state.player.position) < 1e-9,
  'rider.root must mirror state.player.position (controls owns the physics)');
assert.equal(rider.root.rotation.y, state.player.heading, 'rider.root.rotation.y must mirror the heading');

console.log(`wheelSpin 0 -> 3.5 : rearWheelGroup.rotation.x ${rear0.toFixed(4)} -> ${rear1.toFixed(4)}`);
console.log(`                     crank.rotation.x          ${crank0.toFixed(4)} -> ${crank1.toFixed(4)}`);
console.log(`                     pouch.scale.y             ${pouch0.toFixed(4)} -> ${pouch1.toFixed(4)}`);

// ---------------------------------------------------------------------------
// update(): feet stay on the pedals for a whole revolution
// ---------------------------------------------------------------------------

{
  const footWorld = new THREE.Vector3();
  const pedalWorld = new THREE.Vector3();
  const steps = 48;
  let worst = 0;
  let worstPhase = 0;
  const spinPerStep = (Math.PI * 2) / BIKE_DIMS.crank.gearRatio / steps;
  for (let i = 0; i < steps; i++) {
    state.t += 0.016;
    state.player.wheelSpin = spinPerStep * i;
    rider.update(0.016, state);
    for (const [foot, pedal] of [[rider.parts.footL, rider.parts.pedals[0]], [rider.parts.footR, rider.parts.pedals[1]]]) {
      foot.getWorldPosition(footWorld);
      pedal.getWorldPosition(pedalWorld);
      const d = footWorld.distanceTo(pedalWorld);
      if (d > worst) { worst = d; worstPhase = i; }
    }
  }
  console.log(`feet on pedals: worst ankle->pedal distance ${worst.toFixed(3)} m at step ${worstPhase}`);
  // The ankle rides pedalLift (0.06 m) above the pedal axle; IK may fall a
  // little short at the extremes of the stroke, which is invisible in motion.
  assert.ok(worst < 0.16, `feet drift off the pedals (${worst.toFixed(3)} m)`);
}

// ---------------------------------------------------------------------------
// update(): crash / boost / airborne paths must not throw
// ---------------------------------------------------------------------------

{
  const stress = makeState();
  const cases = [
    { speed: 0, lean: 0, steer: 0, grounded: true, crash: 0, boost: 0, airTime: 0 },
    { speed: 9.5, lean: -0.35, steer: 1, grounded: true, crash: 0, boost: 1, airTime: 0 },
    { speed: 4, lean: 0.2, steer: -1, grounded: false, crash: 0, boost: 0, airTime: 0.8 },
    { speed: 2, lean: 0, steer: 0, grounded: true, crash: 1, boost: 0, airTime: 0 },
  ];
  for (const c of cases) {
    for (let i = 0; i < 20; i++) {
      stress.t += 0.016;
      stress.player.speed = c.speed;
      stress.player.lean = c.lean;
      stress.player.steer = c.steer;
      stress.player.grounded = c.grounded;
      stress.player.crash = c.crash;
      stress.player.boost = c.boost;
      stress.player.airTime = c.airTime;
      stress.player.wheelSpin += 0.4;
      stress.player.velocity.y = c.grounded ? 0 : Math.sin(i * 0.3) * 3;
      rider.update(0.016, stress);
    }
  }
  console.log('stress pass (coast / boost / airborne / crash): ok');
}

// ---------------------------------------------------------------------------
// Static guard: update() must not allocate
// ---------------------------------------------------------------------------

for (const file of ['pelican.js', 'bicycle.js', 'rider.js']) {
  // Strip comments first so prose cannot trip the checks, then cut the exact
  // update() body out by matching braces.
  const src = readFileSync(join(charDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const start = src.indexOf('function update(');
  assert.ok(start > 0, `${file}: no update() found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const body = src.slice(open, end);
  assert.ok(body.length > 500, `${file}: update() body extraction failed`);
  assert.ok(!/new\s+THREE\./.test(body), `${file}: update() constructs a THREE object`);
  assert.ok(!/\.clone\(\)/.test(body), `${file}: update() clones`);
  assert.ok(!/computeVertexNormals/.test(body), `${file}: update() recomputes vertex normals`);
}
console.log('allocation guard (no new THREE.* / clone / computeVertexNormals in update): ok');

console.log('');
console.log('ALL CHARACTER TESTS PASSED');
