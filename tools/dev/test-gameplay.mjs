import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as THREE from 'three';
import { createLayout } from '../../src/world/layout.js';
import { EventBus } from '../../src/core/utils.js';
import { createEvents } from '../../src/gameplay/events.js';
import { createCollectibles } from '../../src/gameplay/collectibles.js';
import { createControls } from '../../src/gameplay/controls.js';
import { createCameraController } from '../../src/gameplay/camera.js';
import { createHUD } from '../../src/ui/hud.js';

const dom = new JSDOM('<div id="app"></div>', { url: 'https://pelican.test', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
globalThis.localStorage = dom.window.localStorage;
const layout = createLayout(20261014);
function makeState() {
  return { started: true, paused: false, photoMode: false, hour: 17.1, timeScale: 0,
    weather: { rain: 0, cloudiness: .35 }, wind: {}, feathers: { collected: 0, total: 40 }, discovered: Object.create(null), race: {},
    player: { position: new THREE.Vector3(2800, 10, 2800), velocity: new THREE.Vector3(), speed: 0, heading: 0, crash: 0, boostStamina: 1, wheelSpin: 0, distanceTravelled: 0, airTime: 0, steer: 0, lean: 0, pitch: 0 },
    camera: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() } };
}
function fixture(extra = {}) {
  const state = makeState(), bus = new EventBus();
  const input = { axes: { throttle: 1, brake: 0, steer: 0 }, held: () => false, consumePointerDelta: () => ({ dx: 0, dy: 0 }), pointer: { wheel: 0 } };
  const ctx = { layout, state, bus, input, colliders: [], engine: { camera: new THREE.PerspectiveCamera(), elapsed: 0 }, ...extra };
  return { ctx, state, bus, input };
}
const f = fixture();
const events = createEvents(f.ctx);
const hud = createHUD({ bus: f.bus }, { container: dom.window.document.getElementById('app') });
hud.setDiscoveredTotal(28);
f.state.player.speed = 25;
events.update(.1, f.state); hud.update(.1, f.state);
assert.equal(Object.keys(f.state.discovered).length, 0);
assert.equal(events.discoverableTotal, 25);
assert.match(dom.window.document.getElementById('pi-hud-discovered').textContent, /0 \/ 25/);
assert.equal(f.state.discoverableTotal, events.discoverableTotal);
console.log('fresh progress: discovered keys=0, HUD=0 / 25');

let pickup = 0, discovery = 0, crash = 0;
// Match audio.js business-event subscriptions AND generic sfx route.
f.bus.on('feather:collected', () => pickup++);
f.bus.on('poi:discovered', () => discovery++);
f.bus.on('rider:crash', () => crash++);
f.bus.on('sfx', e => { if (e.name === 'pickup') pickup++; if (e.name === 'discovery') discovery++; if (e.name === 'crash') crash++; });
const feathers = createCollectibles(f.ctx);
const feather = feathers.list[0];
f.state.player.position.set(feather.x, feather.y, feather.z);
feathers.update(.01, f.state); feathers.update(.01, f.state);
assert.equal(pickup, 1);
f.state.player.position.copy(layout.pois.village.position);
events.update(.01, f.state); events.update(.01, f.state);
assert.equal(discovery, 1);
await Promise.resolve();
const restored = fixture();
const restoredFeathers = createCollectibles(restored.ctx), restoredEvents = createEvents(restored.ctx);
restoredEvents.update(.01, restored.state); restoredFeathers.update(.01, restored.state);
assert.equal(restored.state.feathers.collected, 1);
assert.deepEqual(Object.keys(restored.state.discovered), ['village']);
for (const x of restoredFeathers.list) assert.ok(layout.slopeAt(x.x, x.z) <= .6 && layout.waterDepth(x.x, x.z) <= .1);
restoredFeathers.resetProgress(); restoredEvents.resetProgress();
assert.equal(restored.state.feathers.collected, 0);
assert.equal(Object.keys(restored.state.discovered).length, 0);
localStorage.setItem(`pelicanIsland.feathers.${layout.seed}`, JSON.stringify({ v: 1, data: { indices: [0, 0, -1, 40, 1.5, '2'], collected: 40 }, evil: true }));
localStorage.setItem(`pelicanIsland.discovery.${layout.seed}`, JSON.stringify({ v: 1, data: { ids: ['village', 'spawn', '__proto__', 3], count: 25 } }));
const white = fixture(); createCollectibles(white.ctx).update(.01, white.state); createEvents(white.ctx).update(.01, white.state);
assert.equal(white.state.feathers.collected, 1);
assert.deepEqual(Object.keys(white.state.discovered), ['village']);
for (const key of [`pelicanIsland.feathers.${layout.seed}`, `pelicanIsland.discovery.${layout.seed}`]) localStorage.setItem(key, '{bad');
assert.doesNotThrow(() => { createCollectibles(fixture().ctx); createEvents(fixture().ctx); });
localStorage.clear();
console.log('storage: round trip, reset, invalid JSON, whitelist and duplicate IDs PASSED');

const complete = fixture();
const completeFeathers = createCollectibles(complete.ctx);
for (const item of completeFeathers.list) {
  complete.state.player.position.set(item.x, item.y, item.z);
  completeFeathers.update(.01, complete.state);
}
assert.equal(complete.state.feathers.collected, 40);
await Promise.resolve();
const allRestored = fixture();
createCollectibles(allRestored.ctx).update(.01, allRestored.state);
assert.equal(allRestored.state.feathers.collected, 40);
localStorage.clear();
console.log('all 40 feathers survive reload PASSED');

const r = fixture(), race = createEvents(r.ctx), controls = createControls(r.ctx);
race.startRace(r.state);
const start = r.state.player.position.clone();
for (let i = 0; i < 30; i++) { controls.update(.1, r.state); race.update(.1, r.state); }
assert.equal(r.state.player.position.distanceTo(start), 0);
assert.equal(r.state.race.checkpoint, 0);
assert.equal(r.state.player.speed, 0);
// An attacker jumping to the finish or every gate must never finish.
r.state.player.position.copy(start); race.update(.1, r.state);
for (const gate of [...race.gates.slice(1), race.gates[0]]) { r.state.player.position.set(gate.x, gate.y, gate.z); race.update(.05, r.state); }
assert.equal(r.state.race.finished, false);
assert.equal(r.state.race.checkpoint, 0);
// Even waiting after teleporting does not invent the missing travelled distance.
for (let i = 0; i < 20; i++) race.update(.05, r.state);
assert.equal(r.state.race.finished, false);
race.startRace(r.state);
for (let i = 0; i < 31; i++) race.update(.1, r.state);
const point = {};
for (let distance = 0; distance <= layout.roadLength + 2; distance += 1) {
  layout.roadPoint((distance / layout.roadLength) % 1, point);
  r.state.player.position.set(point.x, point.y, point.z);
  race.update(.05, r.state);
  if (r.state.race.finished) break;
}
assert.equal(r.state.race.finished, true);
assert.equal(r.state.race.active, false);
assert.equal(r.state.race.checkpoint, race.gates.length);
assert.ok(r.state.race.time > 400);
console.log(`race: teleport denied, ordered full lap PASSED (${race.gates.length} checkpoints, ${r.state.race.time.toFixed(2)}s)`);

const c = fixture({ layout: { ...layout, onRoad: () => true, heightAt: () => 10, waterDepth: () => 0 } });
c.ctx.colliders = [{ x: 0, z: 1.25, r: .3 }];
c.bus.on('rider:crash', () => crash++);
c.bus.on('sfx', e => { if (e.name === 'crash') crash++; });
c.state.player.position.set(0, 10, 0); c.state.player.speed = 25;
createControls(c.ctx).update(.1, c.state);
assert.equal(crash, 1);
assert.ok(c.state.player.position.z < 1);
const w = fixture(); w.state.player.position.set(2900, -5, 2900);
let rescued = 0; w.bus.on('player:reset', () => rescued++);
createControls(w.ctx).update(.1, w.state);
assert.equal(rescued, 1); assert.equal(w.state.player.speed, 0); assert.equal(w.state.player.airTime, 0);
console.log('audio: pickup=1 discovery=1 crash=1; swept collision and water rescue PASSED');

// --- recovery sweep: 20 edge points must never leave the rider stuck --------
{
  const H = layout.HALF;
  const points = [];
  for (const [x, z] of [[H - 3, H - 3], [-(H - 3), H - 3], [H - 3, -(H - 3)], [-(H - 3), -(H - 3)]]) {
    points.push({ x, z, kind: 'map-corner' });
  }
  for (const id of ['lake', 'pool', 'seaStacks']) {
    const p = layout.pois[id].position;
    points.push({ x: p.x, z: p.z, kind: `water:${id}` });
  }
  // cages: six colliders ringed around a land spot - the worst case for the
  // push-out, and exactly the "pinned, no progress" state the watchdog covers
  let cages = 0;
  for (let i = 0; i < 80 && cages < 13; i++) {
    const a = (i / 80) * Math.PI * 2;
    const cx = Math.cos(a) * 2000, cz = Math.sin(a) * 2000;
    if (layout.heightAt(cx, cz) < 2 || layout.waterDepth(cx, cz) > 0.05) continue;
    const cage = [];
    for (let k = 0; k < 6; k++) {
      const ka = (k / 6) * Math.PI * 2;
      cage.push({ x: cx + Math.cos(ka) * 1.7, z: cz + Math.sin(ka) * 1.7, r: 1.3 });
    }
    points.push({ x: cx, z: cz, kind: 'collider-cage', cage });
    cages++;
  }
  assert.ok(points.length >= 20, `the recovery sweep needs >= 20 points, built ${points.length}`);

  const summary = { rescued: 0, escaped: 0, byReason: {} };
  for (const point of points) {
    const fx = fixture();
    if (point.cage) fx.ctx.colliders.push(...point.cage);
    const controls = createControls(fx.ctx);
    const p = fx.state.player;
    p.position.set(point.x, layout.heightAt(point.x, point.z) + 0.05, point.z);
    p.heading = 0;
    p.speed = 0;
    const startX = p.position.x, startZ = p.position.z;
    let rescued = false, reason = null;
    fx.bus.on('player:unstuck', (e) => { rescued = true; reason = e && e.reason; });
    for (let i = 0; i < 360 && !rescued; i++) controls.update(1 / 60, fx.state); // 6 s, throttle held by the fixture
    const line = layout.roadDistance(p.position.x, p.position.z);
    const travelled = Math.hypot(p.position.x - startX, p.position.z - startZ);
    if (rescued) {
      summary.rescued++;
      summary.byReason[reason] = (summary.byReason[reason] || 0) + 1;
      assert.ok(line < 8, `${point.kind} rescue did not land on a road (${line.toFixed(1)} m away)`);
    } else {
      assert.ok(travelled > 10, `${point.kind} at ${point.x.toFixed(0)},${point.z.toFixed(0)} neither escaped (${travelled.toFixed(1)} m) nor was rescued`);
      summary.escaped++;
    }
  }
  console.log(`recovery sweep: ${points.length} points -> ${JSON.stringify(summary)} PASSED`);
}

const cam = createCameraController(f.ctx); cam.setMode('chase');
cam.cycleMode(); assert.equal(cam.mode, 'firstPerson'); cam.cycleMode(); assert.equal(cam.mode, 'cinematic'); cam.cycleMode(); assert.equal(cam.mode, 'chase');
cam.flyby(f.state.player.position, .01); cam.update(.02, f.state); assert.equal(cam.mode, 'chase');
cam.setMode('photo'); cam.setMode('chase'); cam.cycleMode(); assert.equal(cam.mode, 'firstPerson');
events.update(8, f.state); hud.update(.1, f.state);
await new Promise(resolve => setTimeout(resolve, 4300));
assert.equal(dom.window.document.getElementById('pi-letterbox').classList.contains('is-on'), false);
hud.destroy(); dom.window.close();
console.log('gameplay PASSED');
