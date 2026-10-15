/**
 * test-audio.mjs - headless dev test for src/core/audio.js.
 *
 * Two passes:
 *   1. no global AudioContext at all  -> everything must be a silent no-op and
 *      no call may throw (import, construction, init, update, sfx, setters).
 *   2. hand-written AudioContext stub -> the full graph must build, 200 frames
 *      of varying state must run, every sfx name must be safe, and the stub
 *      must report at least 3 created nodes.
 *
 * Run: cd work/pelican-island ; node tools/dev/test-audio.mjs
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const created = { nodes: 0 };

function makeParam(initial) {
  return {
    value: initial || 0,
    setTargetAtTime(value) { this.value = value; },
    setValueAtTime(value) { this.value = value; },
  };
}

/** The standard chainable stub node described in the task spec. */
function makeStubNode(kind) {
  created.nodes++;
  return {
    kind,
    connect() { return this; },
    disconnect() {},
    start() {},
    stop() {},
    gain: makeParam(0),
    frequency: makeParam(0),
    Q: { value: 0 },
    type: '',
    buffer: null,
    loop: false,
    playbackRate: { value: 1 },
    detune: { value: 0 },
    pan: { value: 0 },
  };
}

class StubAudioContext {
  constructor() {
    StubAudioContext.instances.push(this);
    this.destination = makeStubNode('destination');
    this.sampleRate = 48000;
    this.state = 'running';
    this._t = 0;
  }
  get currentTime() { return this._t; }
  resume() { return Promise.resolve(); }
  createGain() { return makeStubNode('gain'); }
  createOscillator() { return makeStubNode('oscillator'); }
  createBufferSource() { return makeStubNode('bufferSource'); }
  createBiquadFilter() { return makeStubNode('biquadFilter'); }
  createDelay() { return makeStubNode('delay'); }
  createDynamicsCompressor() { return makeStubNode('compressor'); }
  createStereoPanner() { return makeStubNode('stereoPanner'); }
  createWaveShaper() { return makeStubNode('waveShaper'); }
  createConvolver() { return makeStubNode('convolver'); }
  createBuffer(channels, length, sampleRate) {
    // Deliberately has no getChannelData, like a minimal hand-written stub.
    const node = makeStubNode('buffer');
    node.numberOfChannels = channels;
    node.length = length;
    node.sampleRate = sampleRate;
    return node;
  }
}
StubAudioContext.instances = [];

class MockBus {
  constructor() { this.map = new Map(); }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    const s = this.map.get(type);
    if (s) s.delete(fn);
  }
  emit(type, payload) {
    const s = this.map.get(type);
    if (s) for (const fn of s) fn(payload);
  }
}

const SURFACE_CYCLE = ['asphalt', 'gravel', 'grass', 'sand', 'dirt', 'water'];

const mockLayout = {
  seed: 20261014,
  heightAt(x, z) { return 24 + 18 * Math.sin(x * 0.004) + 12 * Math.cos(z * 0.005); },
  isWater(x, z) { return (x * x + z * z) > 2200 * 2200; },
  pois: {
    spawn: { id: 'spawn', position: { x: 0, y: 0, z: 0 }, radius: 20 },
    harbor: { id: 'harbor', position: { x: 20, y: 0, z: 0 }, radius: 40 },
    lighthouse: { id: 'lighthouse', position: { x: 320, y: 0, z: -60 }, radius: 30 },
    broken: { id: 'broken' }, // no position: the audio module must skip it
  },
};

/** A layout that throws from every query, to prove the guards hold. */
const hostileLayout = {
  heightAt() { throw new Error('heightAt exploded'); },
  isWater() { throw new Error('isWater exploded'); },
  pois: { harbor: null },
};

/** 200-frame state script: speed up, brake hard, night, rain, water, boost. */
function makeState(i) {
  const dt = 1 / 60;
  let speed;
  let brake = 0;
  if (i < 60) {
    speed = Math.min(14, i * 0.25);
  } else if (i < 100) {
    speed = Math.max(0, 14 - (i - 60) * 0.35);
    brake = 1;
  } else {
    speed = 6 + Math.sin(i * 0.1) * 4;
  }
  const hour = i < 120 ? 17.1 : (i < 160 ? 21.5 : 3.0);
  const inWater = (i % 40) < 4;
  return {
    t: i * dt,
    dt,
    hour,
    paused: i > 180 && i < 185,
    photoMode: i > 150 && i < 156,
    quality: 'high',
    player: {
      position: { x: i * 1.5 - 120, y: 12 + Math.sin(i * 0.05) * 4, z: 2400 - i * 1.2 },
      velocity: { x: speed, y: 0, z: 0 },
      heading: Math.sin(i * 0.05),
      speed,
      brake,
      steer: Math.sin(i * 0.07) * 0.4,
      lean: Math.sin(i * 0.07) * 0.2,
      wheelSpin: i * 0.4,
      onRoad: i % 3 !== 0,
      surface: SURFACE_CYCLE[i % SURFACE_CYCLE.length],
      grounded: i % 17 !== 0,
      inWater,
      boost: i % 30 > 26,
      crash: false,
      distanceTravelled: i * 0.2,
    },
    camera: { position: { x: i * 1.5 - 126, y: 14, z: 2406 - i * 1.2 }, mode: 'chase', fov: 62 },
    feathers: { collected: 3, total: 40 },
    wind: { x: 0.7, z: 0.5, strength: 0.3 + 0.3 * Math.sin(i * 0.03), gust: 0 },
    weather: { rain: i < 150 ? 0 : Math.min(0.8, (i - 150) * 0.03), cloudiness: 0.4 },
  };
}

const HOSTILE_STATES = [
  undefined,
  null,
  {},
  { player: null },
  { player: { speed: NaN, position: { x: NaN, z: Infinity } } },
  { player: { speed: -9, surface: 'lava', inWater: 'yes', grounded: 0, boost: 'on' } },
  { player: { position: { x: 10, y: NaN, z: -10 }, speed: 12 }, hour: NaN, wind: { strength: Infinity } },
  { player: { position: null, brake: NaN }, camera: { position: { x: 5, z: 5 } } },
  { player: { position: { x: 0, z: 0 }, speed: 1000, brake: 99 }, weather: { rain: 5 }, hour: 99 },
];

const SFX_NAMES = [
  'bell', 'chime', 'ding',
  'pickup', 'feather',
  'discovery', 'discover', 'poi',
  'seagull', 'gull',
  'thunder', 'firework',
  'crash', 'thud', 'splash',
  'boost', 'whoosh', 'brake', 'squeal',
  'bird', 'chirp', 'owl',
];

let checks = 0;
function check(label, fn) {
  checks++;
  assert.doesNotThrow(fn, label);
}

// ---------------------------------------------------------------------------
// (1) No AudioContext in the environment: import + everything must be a no-op
// ---------------------------------------------------------------------------

delete globalThis.AudioContext;
delete globalThis.webkitAudioContext;
assert.equal(typeof globalThis.AudioContext, 'undefined', 'test precondition: no global AudioContext');

let createAudio = null;
await assert.doesNotReject(
  () => import(new URL('../../src/core/audio.js', import.meta.url)).then((m) => { createAudio = m.createAudio; }),
  'importing src/core/audio.js must not throw without an AudioContext',
);
assert.equal(typeof createAudio, 'function', 'createAudio must be exported');

check('createAudio() with no ctx', () => createAudio());
check('createAudio({}) with an empty ctx', () => createAudio({}));

const bus1 = new MockBus();
let audio = null;
check('createAudio(mock ctx)', () => { audio = createAudio({ bus: bus1, textures: {}, rng: null, quality: 'high' }); });
assert.ok(audio && typeof audio.init === 'function', 'must return the documented API');
assert.equal(typeof audio.update, 'function', 'update() missing');
assert.equal(typeof audio.sfx, 'function', 'sfx() missing');
assert.equal(typeof audio.setMasterVolume, 'function', 'setMasterVolume() missing');
assert.equal(typeof audio.setMusicVolume, 'function', 'setMusicVolume() missing');
assert.equal(typeof audio.setSfxVolume, 'function', 'setSfxVolume() missing');
assert.equal(typeof audio.setMuted, 'function', 'setMuted() missing');
assert.equal(typeof audio.setSurface, 'function', 'setSurface() missing');
assert.equal(typeof audio.setWind, 'function', 'setWind() missing');
assert.equal(typeof audio.setHour, 'function', 'setHour() missing');
assert.equal(audio.state.ready, false, 'state.ready must be false with no AudioContext');

check('headless init()', () => audio.init());
check('headless init() again (repeat safe)', () => audio.init());
check('headless update(0.016, fakeState)', () => audio.update(0.016, makeState(3)));
check('headless update() with no state', () => audio.update(0.016));
check("headless sfx('bell')", () => audio.sfx('bell'));
check("headless sfx('bell', {volume, pan, pitch})", () => audio.sfx('bell', { volume: 0.5, pan: -0.4, pitch: 1.5 }));
check("headless sfx('nope') unknown name", () => audio.sfx('nope'));
check('headless sfx(null)', () => audio.sfx(null));
check("headless setSurface('gravel')", () => audio.setSurface('gravel'));
check("headless setSurface('nonsense')", () => audio.setSurface('nonsense'));
check('headless setWind(0.5)', () => audio.setWind(0.5));
check('headless setHour(3)', () => audio.setHour(3));
check('headless setMuted(true)', () => audio.setMuted(true));
check('headless setMasterVolume(0.4)', () => audio.setMasterVolume(0.4));
check('headless setMusicVolume(0)', () => audio.setMusicVolume(0));
check('headless setSfxVolume(1)', () => audio.setSfxVolume(1));
check('headless volume clamping (NaN/-5/9)', () => {
  audio.setMasterVolume(NaN);
  audio.setMasterVolume(-5);
  audio.setMusicVolume(9);
  audio.setSfxVolume(Infinity);
});
check('headless bus emits', () => {
  bus1.emit('sfx', { name: 'bell', volume: 0.5 });
  bus1.emit('feather:collected', { total: 4 });
  bus1.emit('poi:discovered', { name: 'harbor' });
  bus1.emit('rider:crash', {});
  bus1.emit('quality:changed', { quality: 'low' });
  bus1.emit('sfx:music:intensity', 0.9);
});
assert.equal(audio.state.ready, false, 'state.ready must stay false in headless mode');

check('AudioContext constructor that throws', () => {
  class Exploding {
    constructor() { throw new Error('audio blocked'); }
  }
  globalThis.AudioContext = Exploding;
  const a = createAudio({ bus: new MockBus() });
  a.init();
  a.update(0.016, makeState(1));
  a.sfx('bell');
  assert.equal(a.state.ready, false, 'a throwing AudioContext must leave ready=false');
});
delete globalThis.AudioContext;

// ---------------------------------------------------------------------------
// (2) Stubbed AudioContext: full graph + 200 frames + every sfx name
// ---------------------------------------------------------------------------

globalThis.AudioContext = StubAudioContext;

const bus2 = new MockBus();
let audio2 = null;
check('createAudio(stub ctx)', () => {
  audio2 = createAudio({ bus: bus2, layout: mockLayout, textures: {}, rng: null, quality: 'high' });
});
check('init() with stub AudioContext', () => audio2.init());
assert.equal(audio2.state.ready, true, 'state.ready must be true with a working AudioContext');
check('init() again is idempotent', () => audio2.init());
assert.ok(created.nodes >= 3, `expected at least 3 created nodes, got ${created.nodes}`);

const stubCtx = StubAudioContext.instances[StubAudioContext.instances.length - 1];
assert.ok(stubCtx, 'stub context instance must exist');

let simTime = 0;
for (let i = 0; i < 200; i++) {
  const dt = 1 / 60;
  simTime += dt;
  stubCtx._t = simTime;
  const s = makeState(i);
  assert.doesNotThrow(() => audio2.update(dt, s), `update() threw on frame ${i}`);
  checks++;
  // Keep the documented setter surface live during the ride as well.
  if (i === 50) audio2.setSurface('water');
  if (i === 70) audio2.setWind(1);
  if (i === 90) audio2.setHour(22);
  if (i === 110) audio2.setMuted(true);
  if (i === 118) audio2.setMuted(false);
  if (i === 130) audio2.setMasterVolume(0.6);
  if (i === 140) audio2.setMusicVolume(0.35);
  if (i === 150) audio2.setSfxVolume(0.7);
}

// Hostile / partial states must also survive once the graph is live.
for (const s of HOSTILE_STATES) {
  stubCtx._t += 0.016;
  assert.doesNotThrow(() => audio2.update(0.016, s), 'update() threw on a hostile state');
  checks++;
}

const nodesBeforeSfx = created.nodes;
for (const name of SFX_NAMES) {
  assert.doesNotThrow(() => audio2.sfx(name, { volume: 0.8, pan: -0.5, pitch: 1.2 }), `sfx(${name}) threw`);
  checks++;
}
check('sfx() with odd options', () => {
  audio2.sfx('bell');
  audio2.sfx('bell', {});
  audio2.sfx('bell', { volume: 0, pan: 99, pitch: 0 });
  audio2.sfx('bell', { volume: NaN, pan: NaN, pitch: NaN });
  audio2.sfx('bell', { volume: -3, pan: -99, pitch: -1 });
  audio2.sfx('', {});
  audio2.sfx(42, {});
});
assert.ok(created.nodes > nodesBeforeSfx, 'sfx() must create nodes on the stubbed context');

const nodesBeforeBus = created.nodes;
check('bus: sfx event', () => bus2.emit('sfx', { name: 'bell', volume: 0.7 }));
check('bus: feather:collected', () => bus2.emit('feather:collected', { total: 5 }));
check('bus: poi:discovered', () => bus2.emit('poi:discovered', { name: 'harbor' }));
check('bus: rider:crash', () => bus2.emit('rider:crash', {}));
check('bus: quality:changed', () => bus2.emit('quality:changed', { quality: 'low' }));
check('bus: sfx:music:intensity', () => bus2.emit('sfx:music:intensity', 0.95));
check('bus: unknown event', () => bus2.emit('something:else', 1));
assert.ok(created.nodes > nodesBeforeBus, 'bus events must reach the sfx layer');

// Low quality + night + rain should keep running without throwing.
stubCtx._t += 1;
check('update() after quality:changed(low)', () => {
  for (let i = 0; i < 40; i++) {
    stubCtx._t += 1 / 60;
    audio2.update(1 / 60, makeState(150 + i));
  }
});

// Long run (50 s of sim) parked next to the harbour at night: this is what
// reaches the slow ambience timers (harbour bell ~45 s, distant owl ~35 s).
check('long run: 50 s near the harbour at night', () => {
  const harbourState = makeState(0);
  harbourState.hour = 22.5;
  harbourState.player.speed = 0;
  harbourState.player.position = { x: 25, y: 4, z: 25 };
  harbourState.weather.rain = 0;
  for (let i = 0; i < 3000; i++) {
    stubCtx._t += 1 / 60;
    harbourState.t = i / 60;
    harbourState.player.speed = Math.sin(i * 0.01) * 2;
    audio2.update(1 / 60, harbourState);
  }
});

// A layout whose queries throw must not break anything either.
const audio3 = createAudio({ bus: new MockBus(), layout: hostileLayout, quality: 'medium' });
check('init() with a hostile layout', () => audio3.init());
const stub3 = StubAudioContext.instances[StubAudioContext.instances.length - 1];
check('update() with a hostile layout', () => {
  for (let i = 0; i < 30; i++) {
    stub3._t += 1 / 60;
    audio3.update(1 / 60, makeState(i));
  }
});
assert.equal(audio3.state.ready, true, 'a throwing layout must not disable audio');

// Ready but layout-less instance (the documented guard).
const audio4 = createAudio({ bus: new MockBus() });
check('init() with no layout', () => audio4.init());
const stub4 = StubAudioContext.instances[StubAudioContext.instances.length - 1];
check('update() with no layout', () => {
  for (let i = 0; i < 30; i++) {
    stub4._t += 1 / 60;
    audio4.update(1 / 60, makeState(i));
  }
});

delete globalThis.AudioContext;

console.log(`audio dev test: ${checks} checks, ${created.nodes} stub nodes created`);
console.log('ALL AUDIO TESTS PASSED');
