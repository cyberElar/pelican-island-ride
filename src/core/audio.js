/**
 * audio.js - the complete soundtrack of "Pelican Island Ride", synthesized at
 * runtime with WebAudio. No audio files, no network, no external assets.
 *
 * createAudio(ctx) -> {
 *   init(), update(dt, state), sfx(name, opts),
 *   setMasterVolume(v), setMusicVolume(v), setSfxVolume(v), setMuted(b),
 *   setSurface(name), setWind(strength), setHour(hour), state: { ready }
 * }
 *
 * ctx = { engine, layout, textures, rng, quality, bus }
 *
 * Bus events consumed from ctx.bus:
 *   'sfx' {name, volume}, 'feather:collected', 'poi:discovered', 'rider:crash',
 *   'quality:changed', 'sfx:music:intensity'
 *
 * Contract notes:
 * - Headless safe: without a global AudioContext every entry point is a silent
 *   no-op and nothing ever throws (Node dev tests, SSR, blocked audio).
 * - update() is allocation-free in steady state: every looping voice is built
 *   once in init(); only sparse events (a bird call, a one-shot sfx) allocate
 *   short-lived nodes, which is inherent to WebAudio.
 * - Every AudioParam move goes through setTargetAtTime so nothing clicks.
 * - Audio owns a private RNG so sound never perturbs world generation.
 */

import { Rng, clamp, clamp01, lerp } from './utils.js';

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** Generative loop: D - Bm - G - A, 8 s per chord. */
const CHORDS = [
  { root: 146.83, third: 185.0, fifth: 220.0 }, // D major
  { root: 123.47, third: 146.83, fifth: 185.0 }, // B minor
  { root: 98.0, third: 123.47, fifth: 146.83 }, // G major
  { root: 110.0, third: 138.59, fifth: 164.81 }, // A major
];
const CHORD_SECONDS = 8;
const BEAT_SECONDS = 1;
const PLUCK_DELAY = 0.38;
const PLUCK_FEEDBACK = 0.35;

/** D major pentatonic over two octaves - the pluck palette. */
const PENTA = [293.66, 329.63, 369.99, 440.0, 493.88, 587.33, 659.25, 739.99, 880.0];

/** Three detuned saw voices per pad group (root, root, third). */
const PAD_VOICES = [
  { pick: 'root', detune: -7, level: 0.55 },
  { pick: 'root', detune: 7, level: 0.4 },
  { pick: 'third', detune: 4, level: 0.42 },
];

/** Tire-roll EQ: parallel branch gains plus filter corners per surface. */
const SURFACES = {
  asphalt: { bright: 1.0, mid: 0.28, dark: 0.1, crackle: 0.04, water: 0.0, hp: 300, lp: 7000, midF: 1200, crackleF: 9 },
  gravel: { bright: 0.34, mid: 1.0, dark: 0.3, crackle: 0.55, water: 0.0, hp: 240, lp: 4200, midF: 1200, crackleF: 16 },
  grass: { bright: 0.08, mid: 0.3, dark: 1.0, crackle: 0.06, water: 0.0, hp: 170, lp: 900, midF: 700, crackleF: 7 },
  sand: { bright: 0.04, mid: 0.22, dark: 0.85, crackle: 0.04, water: 0.0, hp: 150, lp: 600, midF: 620, crackleF: 6 },
  dirt: { bright: 0.18, mid: 0.68, dark: 0.66, crackle: 0.14, water: 0.0, hp: 200, lp: 1200, midF: 900, crackleF: 10 },
  water: { bright: 0.1, mid: 0.5, dark: 0.55, crackle: 0.05, water: 1.0, hp: 230, lp: 1500, midF: 900, crackleF: 8 },
};

/** sfx() aliases -> canonical voice. Unknown names are ignored. */
const SFX_ALIASES = {
  bell: 'bell',
  pickup: 'pickup', chime: 'pickup', ding: 'pickup', feather: 'pickup',
  discovery: 'discovery', discover: 'discovery', poi: 'discovery',
  seagull: 'seagull', gull: 'seagull',
  thunder: 'thunder',
  firework: 'firework',
  crash: 'crash', thud: 'crash',
  splash: 'splash',
  boost: 'boost', whoosh: 'boost',
  brake: 'brake', squeal: 'brake',
  bird: 'bird', chirp: 'bird',
  owl: 'owl',
};

const NO_OPTS = {};

// ---------------------------------------------------------------------------

export function createAudio(ctx) {
  const bus = ctx && ctx.bus ? ctx.bus : null;
  const layout = ctx && ctx.layout ? ctx.layout : null;
  const rng = new Rng('audio');

  // ---- mixer state -------------------------------------------------------
  let masterVol = 0.8;
  let musicVol = 0.5;
  let sfxVol = 0.9;
  let muted = false;

  // ---- mirrored scene state (setters + update) ---------------------------
  let surface = 'asphalt';
  let windStrength = 0.4;
  let hour = 12;
  let qualityFactor = 1;

  // ---- frame scratch (keeps update() allocation-free) --------------------
  let fSpeed = 0;
  let fBrake = 0;
  let fBoost = 0;
  let fGrounded = true;
  let fInWater = false;
  let fPaused = false;
  let fPhoto = false;
  let fSurface = 'asphalt';
  let fRain = 0;
  let fHasPos = false;
  let fPx = 0;
  let fPy = 0;
  let fPz = 0;
  let fCamDist2 = 0;
  let fAlt = 0;
  let fShore = 0;
  let fNearPoi = false;
  let fEnterWater = false;
  let fLeaveWater = false;
  let fStartBoost = false;

  // ---- transitions / timers ---------------------------------------------
  let prevSpeed = 0;
  let prevInWater = false;
  let prevBoost = false;
  let brakeCool = 0;
  let boostCool = 0;
  let splashCool = 0;
  let poiTimer = 0;

  // ---- music clock -------------------------------------------------------
  let musicTime = 0;
  let chordIndex = -1;
  let activeGroup = 0;
  let beatTime = 0;
  let beatCount = 0;
  let pluckTimer = 2.5;
  let intensity = 0.35;
  let intensityBoost = 0;
  let appliedSurface = '';

  // ---- ambience timers ---------------------------------------------------
  let birdTimer = 2.5;
  let owlTimer = 35;
  let gullTimer = 22;
  let bellTimer = 45;

  // ---- audio graph handles (all null until init()) -----------------------
  let ac = null;
  let ready = false;
  let timeFallback = 0;

  let masterGain = null;
  let shaper = null;
  let comp = null;
  let musicBus = null;
  let sfxBus = null;
  let ambientBus = null;
  let bikeBus = null;
  let reverbGain = null;

  let windSrc = null;
  let windBp = null;
  let windGain = null;
  let windLfoGain = null;
  let waveSrc = null;
  let waveLp = null;
  let waveGain = null;
  let swellGain = null;
  let crickets = null;

  let rollSrc = null;
  let rollSum = null;
  let rollBrightHp = null;
  let rollBrightG = null;
  let rollMidBp = null;
  let rollMidG = null;
  let rollDarkLp = null;
  let rollDarkG = null;
  let rollCrackleBp = null;
  let rollCrackleG = null;
  let rollCrackleLfo = null;
  let rollCrackleDepth = null;
  let rollWaterBp = null;
  let rollWaterG = null;
  let chainSrc = null;
  let chainBp = null;
  let chainG = null;
  let chainOsc = null;
  let chainToneG = null;

  let padLp = null;
  let padGain = null;
  let padGroups = null;
  let pluckIn = null;
  let pluckDry = null;
  let pluckDelay = null;
  let pluckFb = null;
  let pluckWet = null;

  let whiteBuf = null;
  let pinkBuf = null;

  // =========================================================================
  // Param helpers - deliberately tolerant so a hand-written AudioContext stub
  // (or a partial implementation) can never make us throw.
  // =========================================================================

  function now() {
    if (ac) {
      try {
        const t = ac.currentTime;
        if (typeof t === 'number' && isFinite(t)) return t;
      } catch (_) { /* fall through to the fallback clock */ }
    }
    timeFallback += 0.016;
    return timeFallback;
  }

  function setParam(param, value, t) {
    if (!param) return;
    try {
      if (typeof param.setValueAtTime === 'function') {
        param.setValueAtTime(value, t);
        return;
      }
    } catch (_) { /* fall through */ }
    try { param.value = value; } catch (_) { /* ignore */ }
  }

  function rampParam(param, value, t, tau) {
    if (!param) return;
    try {
      if (typeof param.setTargetAtTime === 'function') {
        param.setTargetAtTime(value, t, tau > 0 ? tau : 0.01);
        return;
      }
    } catch (_) { /* fall through */ }
    try { param.value = value; } catch (_) { /* ignore */ }
  }

  /** Assign a scalar property / AudioParam that a stub may not implement. */
  function setProp(node, name, value) {
    try {
      if (!node) return;
      const p = node[name];
      if (p && typeof p === 'object') p.value = value;
      else if (p !== undefined && p !== null) node[name] = value;
    } catch (_) { /* ignore */ }
  }

  function makeGain(value) {
    const g = ac.createGain();
    setParam(g.gain, value == null ? 1 : value, now());
    return g;
  }

  function makeFilter(type, freq, q) {
    const f = ac.createBiquadFilter();
    f.type = type;
    setParam(f.frequency, freq, now());
    if (q != null) setProp(f, 'Q', q);
    return f;
  }

  function makeSource(buffer, rate) {
    const s = ac.createBufferSource();
    s.buffer = buffer || null;
    s.loop = true;
    if (rate != null) setProp(s, 'playbackRate', rate);
    return s;
  }

  function makeOsc(type, freq, t, dest) {
    const o = ac.createOscillator();
    o.type = type;
    setParam(o.frequency, freq, t);
    if (dest) o.connect(dest);
    o.start(t);
    return o;
  }

  /** Stereo panner feeding `dest`; falls back to `dest` when unavailable. */
  function makePanTo(dest, pan) {
    let p = null;
    try {
      p = ac.createStereoPanner();
      setProp(p, 'pan', clamp(typeof pan === 'number' ? pan : 0, -1, 1));
      p.connect(dest);
    } catch (_) { p = null; }
    return p || dest;
  }

  function connectAll(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) {
      try { nodes[i].connect(nodes[i + 1]); } catch (_) { /* ignore */ }
    }
  }

  function noiseBuffer(seconds, pink) {
    let buf = null;
    try {
      const sr = (typeof ac.sampleRate === 'number' && ac.sampleRate > 0) ? ac.sampleRate : 44100;
      const len = Math.max(64, Math.floor(sr * seconds));
      buf = ac.createBuffer(1, len, sr);
      if (buf && typeof buf.getChannelData === 'function') {
        const data = buf.getChannelData(0);
        if (data && data.length) {
          if (pink) {
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (let i = 0; i < data.length; i++) {
              const w = rng.float() * 2 - 1;
              b0 = 0.99886 * b0 + w * 0.0555179;
              b1 = 0.99332 * b1 + w * 0.0750759;
              b2 = 0.969 * b2 + w * 0.153852;
              b3 = 0.8665 * b3 + w * 0.3104856;
              b4 = 0.55 * b4 + w * 0.5329522;
              b5 = -0.7616 * b5 - w * 0.016898;
              data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
              b6 = w * 0.115926;
            }
          } else {
            for (let i = 0; i < data.length; i++) data[i] = rng.float() * 2 - 1;
          }
        }
      }
    } catch (_) { buf = null; }
    return buf;
  }

  function impulseBuffer(seconds) {
    try {
      const sr = (typeof ac.sampleRate === 'number' && ac.sampleRate > 0) ? ac.sampleRate : 44100;
      const len = Math.max(64, Math.floor(sr * seconds));
      const buf = ac.createBuffer(2, len, sr);
      if (buf && typeof buf.getChannelData === 'function') {
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          if (!d) continue;
          for (let i = 0; i < d.length; i++) {
            const k = 1 - i / d.length;
            d[i] = (rng.float() * 2 - 1) * k * k * k * 0.55;
          }
        }
      }
      return buf;
    } catch (_) { return null; }
  }

  /** Wrapper used by init(): a broken sub-graph must not sink the rest. */
  function attempt(fn) {
    try { fn(); } catch (_) { /* ignore */ }
  }

  // =========================================================================
  // Graph construction (init only)
  // =========================================================================

  function buildMaster() {
    masterGain = makeGain(masterVol);

    comp = ac.createDynamicsCompressor();
    setProp(comp, 'threshold', -12);
    setProp(comp, 'knee', 14);
    setProp(comp, 'ratio', 3);
    setProp(comp, 'attack', 0.012);
    setProp(comp, 'release', 0.32);

    // Transparent below 0.7, soft-limits above: safety net against stacking.
    shaper = ac.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a <= 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
      curve[i] = x < 0 ? -y : y;
    }
    shaper.curve = curve;
    try { shaper.oversample = '2x'; } catch (_) { /* ignore */ }

    connectAll(masterGain, shaper, comp);
    try { if (ac.destination) comp.connect(ac.destination); } catch (_) { /* ignore */ }

    musicBus = makeGain(musicVol);
    sfxBus = makeGain(sfxVol);
    ambientBus = makeGain(0.6);
    bikeBus = makeGain(1);
    connectAll(musicBus, masterGain);
    connectAll(sfxBus, masterGain);
    connectAll(ambientBus, masterGain);
    connectAll(bikeBus, sfxBus);
  }

  function buildReverb() {
    const conv = ac.createConvolver();
    const ir = impulseBuffer(1.7);
    if (ir) conv.buffer = ir;
    reverbGain = makeGain(0.16);
    const send = makeGain(0.5);
    connectAll(sfxBus, send, conv, reverbGain, masterGain);
  }

  function buildAmbient() {
    // Wind: bandpass noise with a slow gain breath and centre drift.
    windSrc = makeSource(whiteBuf);
    windBp = makeFilter('bandpass', 500, 0.7);
    windGain = makeGain(0.0001);
    connectAll(windSrc, windBp, windGain, ambientBus);

    const windLfo = makeOsc('sine', 0.06, 0, null);
    windLfoGain = makeGain(0); // depth follows the wind level (set in stepAmbient)
    connectAll(windLfo, windLfoGain, windGain.gain);
    const windDrift = makeOsc('triangle', 0.022, 0, null);
    const windDriftGain = makeGain(90);
    connectAll(windDrift, windDriftGain, windBp.frequency);

    // Ocean: lowpass noise with a slow 0.11 Hz swell.
    waveSrc = makeSource(pinkBuf);
    waveLp = makeFilter('lowpass', 400, 0.7);
    waveGain = makeGain(0.0001);
    connectAll(waveSrc, waveLp, waveGain, ambientBus);

    const swell = makeOsc('sine', 0.11, 0, null);
    swellGain = makeGain(0); // depth follows the wave level (set in stepAmbient)
    connectAll(swell, swellGain, waveGain.gain);
    const swellDrift = makeOsc('triangle', 0.05, 0, null);
    const swellDriftGain = makeGain(120);
    connectAll(swellDrift, swellDriftGain, waveLp.frequency);

    // Crickets / night insects: three voices, silent by day. Every modulator
    // depth is scaled to the voice level in stepAmbient, so a silent cricket
    // can never be modulated back into audibility.
    crickets = [];
    for (let i = 0; i < 3; i++) {
      const voice = {
        gain: makeGain(0.0001),
        tremDepth: makeGain(0),
        chirpDepth: makeGain(0),
        level: i === 1 ? 1 : 0.8,
      };
      const bp = makeFilter('bandpass', 3900 + i * 260, 5);
      const pan = makePanTo(ambientBus, i === 0 ? -0.65 : i === 1 ? 0 : 0.65);
      const tone = makeOsc('sine', 4150 + i * 300, 0, null);
      const trem = makeOsc('sine', 30 + i * 9, 0, null);
      const chirp = makeOsc('sine', 0.55 + i * 0.17, 0, null);
      connectAll(trem, voice.tremDepth, voice.gain.gain);
      connectAll(chirp, voice.chirpDepth, voice.gain.gain);
      connectAll(tone, bp, voice.gain, pan);
      crickets.push(voice);
    }

    if (windSrc) windSrc.start(0);
    if (waveSrc) waveSrc.start(0);
  }

  function buildBike() {
    rollSrc = makeSource(pinkBuf, 1);
    rollSum = makeGain(0.0001);
    connectAll(rollSum, bikeBus);

    // Bright branch: asphalt (hp 300 + lp 7k).
    rollBrightHp = makeFilter('highpass', 300, 0.7);
    const rollBrightLp = makeFilter('lowpass', 7000, 0.6);
    rollBrightG = makeGain(0.0001);
    connectAll(rollSrc, rollBrightHp, rollBrightLp, rollBrightG, rollSum);

    // Mid branch: gravel bandpass at 1.2k.
    rollMidBp = makeFilter('bandpass', 1200, 0.9);
    rollMidG = makeGain(0.0001);
    connectAll(rollSrc, rollMidBp, rollMidG, rollSum);

    // Dark branch: grass / sand / dirt lowpass.
    rollDarkLp = makeFilter('lowpass', 900, 0.8);
    rollDarkG = makeGain(0.0001);
    connectAll(rollSrc, rollDarkLp, rollDarkG, rollSum);

    // Crackle branch: rattle riding on top of gravel.
    rollCrackleBp = makeFilter('bandpass', 2400, 2.2);
    rollCrackleG = makeGain(0.0001);
    rollCrackleLfo = makeOsc('sawtooth', 12, 0, null);
    rollCrackleDepth = makeGain(0);
    connectAll(rollCrackleLfo, rollCrackleDepth, rollCrackleG.gain);
    connectAll(rollSrc, rollCrackleBp, rollCrackleG, rollSum);

    // Water branch: extra splash wash while riding through water.
    rollWaterBp = makeFilter('bandpass', 900, 0.7);
    rollWaterG = makeGain(0.0001);
    connectAll(rollSrc, rollWaterBp, rollWaterG, rollSum);

    // Chain whirr: filtered noise plus a faint 2x-speed tone.
    chainSrc = makeSource(pinkBuf, 1.4);
    chainBp = makeFilter('bandpass', 2200, 1.4);
    chainG = makeGain(0.0001);
    connectAll(chainSrc, chainBp, chainG, bikeBus);
    chainOsc = makeOsc('triangle', 30, 0, null);
    chainToneG = makeGain(0.0001);
    connectAll(chainOsc, chainToneG, bikeBus);

    if (rollSrc) rollSrc.start(0);
    if (chainSrc) chainSrc.start(0);
  }

  function buildMusic() {
    // Shared pad tone shaping with a slowly drifting lowpass.
    padLp = makeFilter('lowpass', 1250, 0.8);
    padGain = makeGain(0.0001);
    connectAll(padLp, padGain, musicBus);
    const padLfo = makeOsc('sine', 0.045, 0, null);
    const padLfoGain = makeGain(220);
    connectAll(padLfo, padLfoGain, padLp.frequency);

    // Two alternating pad groups so chord changes crossfade instead of glide.
    padGroups = [];
    for (let g = 0; g < 2; g++) {
      const group = { gain: makeGain(0.0001), voices: [] };
      connectAll(group.gain, padLp);
      for (let v = 0; v < PAD_VOICES.length; v++) {
        const spec = PAD_VOICES[v];
        const osc = ac.createOscillator();
        osc.type = 'sawtooth';
        setProp(osc, 'detune', spec.detune);
        setParam(osc.frequency, CHORDS[0].root, 0);
        const vg = makeGain(spec.level);
        connectAll(osc, vg, group.gain);
        osc.start(0);
        group.voices.push({ osc, pick: spec.pick });
      }
      padGroups.push(group);
    }

    // Pentatonic pluck arpeggio through a 0.38 s feedback delay.
    pluckIn = makeGain(1);
    pluckDry = makeGain(0.9);
    pluckWet = makeGain(0.5);
    pluckDelay = ac.createDelay(1.0);
    setProp(pluckDelay, 'delayTime', PLUCK_DELAY);
    pluckFb = makeGain(PLUCK_FEEDBACK);
    connectAll(pluckIn, pluckDry, musicBus);
    connectAll(pluckIn, pluckDelay);
    connectAll(pluckDelay, pluckWet, musicBus);
    connectAll(pluckDelay, pluckFb, pluckDelay);
  }

  // =========================================================================
  // One-shots
  // =========================================================================

  function outTo(dest, pan) {
    return makePanTo(dest, pan);
  }

  function bellSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const g = makeGain(0.0001);
    connectAll(g, out);
    const carrier = ac.createOscillator();
    carrier.type = 'sine';
    setParam(carrier.frequency, 1800, t);
    const mod = ac.createOscillator();
    mod.type = 'sine';
    setParam(mod.frequency, 1800 * 3.5, t);
    const modGain = makeGain(1800 * 3.5 * 0.5);
    rampParam(modGain.gain, 0, t + 0.004, 0.05);
    connectAll(mod, modGain, carrier.frequency);
    connectAll(carrier, g);
    setParam(g.gain, 0.0001, t);
    setParam(g.gain, 0.5 * vol, t + 0.002);
    rampParam(g.gain, 0.0001, t + 0.005, 0.13);
    carrier.start(t);
    mod.start(t);
    carrier.stop(t + 0.75);
    mod.stop(t + 0.75);
  }

  function pickupSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const notes = [1174.66, 1760.0];
    for (let i = 0; i < notes.length; i++) {
      const t0 = t + i * 0.085;
      const f = notes[i];
      const g = makeGain(0.0001);
      connectAll(g, out);
      const a = makeOsc('sine', f, t0, g);
      const b = makeOsc('sine', f * 1.05, t0, g);
      setProp(b, 'detune', 3);
      setParam(g.gain, 0.0001, t0);
      setParam(g.gain, 0.22 * vol, t0 + 0.004);
      rampParam(g.gain, 0.0001, t0 + 0.008, 0.19);
      a.stop(t0 + 0.8);
      b.stop(t0 + 0.8);
    }
  }

  function discoverySfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const chord = [293.66, 440.0, 587.33, 739.99];
    const pad = makeGain(0.0001);
    const lp = makeFilter('lowpass', 2100, 0.7);
    connectAll(pad, lp, out);
    for (let i = 0; i < chord.length; i++) {
      const o = ac.createOscillator();
      o.type = i < 2 ? 'sawtooth' : 'triangle';
      setProp(o, 'detune', i % 2 === 0 ? -6 : 6);
      setParam(o.frequency, chord[i], t);
      const vg = makeGain(i < 2 ? 0.22 : 0.3);
      connectAll(o, vg, pad);
      o.start(t);
      o.stop(t + 1.9);
    }
    setParam(pad.gain, 0.0001, t);
    rampParam(pad.gain, 0.34 * vol, t + 0.02, 0.22);
    rampParam(pad.gain, 0.0001, t + 0.85, 0.3);
    // Shimmer arpeggio riding on the swell.
    for (let i = 0; i < 6; i++) {
      const t0 = t + 0.08 + i * 0.1;
      const g = makeGain(0.0001);
      connectAll(g, out);
      const o = makeOsc('triangle', PENTA[4 + (i % 4)] * 2, t0, g);
      setParam(g.gain, 0.0001, t0);
      setParam(g.gain, 0.09 * vol, t0 + 0.006);
      rampParam(g.gain, 0.0001, t0 + 0.01, 0.1);
      o.stop(t0 + 0.8);
    }
  }

  function seagullSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const count = rng.chance(0.5) ? 4 : 3;
    let cursor = t;
    for (let i = 0; i < count; i++) {
      const t0 = cursor;
      const f0 = 1450 * (1 - i * 0.07);
      const g = makeGain(0.0001);
      const bp = makeFilter('bandpass', 1700, 1.3);
      connectAll(bp, g, out);
      const carrier = ac.createOscillator();
      carrier.type = 'sawtooth';
      setParam(carrier.frequency, f0, t0);
      rampParam(carrier.frequency, f0 * 0.95, t0 + 0.01, 0.02);
      rampParam(carrier.frequency, f0 * 0.55, t0 + 0.06, 0.05);
      const mod = ac.createOscillator();
      mod.type = 'sine';
      setParam(mod.frequency, f0 * 1.7, t0);
      const modGain = makeGain(f0 * 1.9);
      connectAll(mod, modGain, carrier.frequency);
      connectAll(carrier, bp);
      setParam(g.gain, 0.0001, t0);
      setParam(g.gain, 0.38 * vol, t0 + 0.012);
      rampParam(g.gain, 0.0001, t0 + 0.02, 0.05);
      carrier.start(t0);
      mod.start(t0);
      carrier.stop(t0 + 0.3);
      mod.stop(t0 + 0.3);
      cursor = t0 + rng.range(0.16, 0.3);
    }
  }

  function thunderSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    // Crack transient.
    const crack = makeGain(0.0001);
    const crackHp = makeFilter('highpass', 900, 0.7);
    connectAll(crackHp, crack, out);
    const src1 = makeSource(whiteBuf, 1);
    connectAll(src1, crackHp);
    setParam(crack.gain, 0.0001, t);
    setParam(crack.gain, 0.3 * vol, t + 0.004);
    rampParam(crack.gain, 0.0001, t + 0.01, 0.045);
    src1.start(t);
    src1.stop(t + 0.5);
    // Body: heavily lowpassed noise with a wandering corner.
    const body = makeGain(0.0001);
    const lp = makeFilter('lowpass', 220, 0.7);
    connectAll(lp, body, out);
    const src2 = makeSource(pinkBuf, 0.85);
    connectAll(src2, lp);
    const wander = makeOsc('sine', 0.55, t, null);
    const wanderGain = makeGain(80);
    connectAll(wander, wanderGain, lp.frequency);
    setParam(body.gain, 0.0001, t);
    rampParam(body.gain, 0.55 * vol, t + 0.03, 0.32);
    rampParam(body.gain, 0.0001, t + 0.9, 0.85);
    src2.start(t);
    src2.stop(t + 3.6);
    // Sub rumble.
    const rumble = makeGain(0.0001);
    connectAll(rumble, out);
    const sub = ac.createOscillator();
    sub.type = 'sine';
    setParam(sub.frequency, 46, t);
    rampParam(sub.frequency, 33, t + 0.1, 0.9);
    connectAll(sub, rumble);
    rampParam(rumble.gain, 0.22 * vol, t + 0.05, 0.3);
    rampParam(rumble.gain, 0.0001, t + 1.1, 0.8);
    sub.start(t);
    sub.stop(t + 3.4);
  }

  function fireworkSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    // Whistle rise.
    const wg = makeGain(0.0001);
    connectAll(wg, out);
    const whistle = ac.createOscillator();
    whistle.type = 'sine';
    setParam(whistle.frequency, 700, t);
    rampParam(whistle.frequency, 2350, t + 0.05, 0.3);
    connectAll(whistle, wg);
    setParam(wg.gain, 0.0001, t);
    rampParam(wg.gain, 0.12 * vol, t + 0.03, 0.25);
    rampParam(wg.gain, 0.0001, t + 0.72, 0.03);
    whistle.start(t);
    whistle.stop(t + 0.8);
    // Pop.
    const pop = makeGain(0.0001);
    const popLp = makeFilter('lowpass', 1100, 0.8);
    connectAll(popLp, pop, out);
    const src = makeSource(whiteBuf, 1.1);
    connectAll(src, popLp);
    setParam(pop.gain, 0.0001, t + 0.78);
    setParam(pop.gain, 0.55 * vol, t + 0.786);
    rampParam(pop.gain, 0.0001, t + 0.79, 0.05);
    src.start(t + 0.78);
    src.stop(t + 1.2);
    const thump = makeGain(0.0001);
    connectAll(thump, out);
    const boom = ac.createOscillator();
    boom.type = 'sine';
    setParam(boom.frequency, 95, t + 0.78);
    rampParam(boom.frequency, 48, t + 0.8, 0.09);
    connectAll(boom, thump);
    rampParam(thump.gain, 0.3 * vol, t + 0.782, 0.04);
    rampParam(thump.gain, 0.0001, t + 0.82, 0.12);
    boom.start(t + 0.78);
    boom.stop(t + 1.3);
    // Crackle tail.
    const cr = makeGain(0.0001);
    const crBp = makeFilter('bandpass', 3200, 0.9);
    connectAll(crBp, cr, out);
    const src2 = makeSource(whiteBuf, 1.3);
    connectAll(src2, crBp);
    const trem = makeOsc('square', 22, t + 0.8, null);
    const tremDepth = makeGain(0.18);
    connectAll(trem, tremDepth, cr.gain);
    setParam(cr.gain, 0.0001, t + 0.8);
    rampParam(cr.gain, 0.35 * vol, t + 0.82, 0.05);
    rampParam(cr.gain, 0.0001, t + 0.9, 0.28);
    src2.start(t + 0.8);
    src2.stop(t + 1.8);
    trem.stop(t + 1.8);
  }

  function crashSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const g = makeGain(0.0001);
    connectAll(g, out);
    const body = ac.createOscillator();
    body.type = 'sine';
    setParam(body.frequency, 120, t);
    rampParam(body.frequency, 40, t + 0.02, 0.075);
    connectAll(body, g);
    rampParam(g.gain, 0.55 * vol, t + 0.004, 0.03);
    rampParam(g.gain, 0.0001, t + 0.03, 0.14);
    body.start(t);
    body.stop(t + 0.7);
    const burst = makeGain(0.0001);
    const lp = makeFilter('lowpass', 420, 0.8);
    connectAll(lp, burst, out);
    const src = makeSource(pinkBuf, 0.9);
    connectAll(src, lp);
    setParam(burst.gain, 0.0001, t);
    setParam(burst.gain, 0.42 * vol, t + 0.003);
    rampParam(burst.gain, 0.0001, t + 0.008, 0.07);
    src.start(t);
    src.stop(t + 0.6);
    const tick = makeGain(0.0001);
    const bp = makeFilter('bandpass', 1900, 1.6);
    connectAll(bp, tick, out);
    const src2 = makeSource(whiteBuf, 1);
    connectAll(src2, bp);
    setParam(tick.gain, 0.0001, t);
    setParam(tick.gain, 0.16 * vol, t + 0.002);
    rampParam(tick.gain, 0.0001, t + 0.005, 0.03);
    src2.start(t);
    src2.stop(t + 0.25);
  }

  function splashSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const g = makeGain(0.0001);
    const bp = makeFilter('bandpass', 280, 0.9);
    connectAll(bp, g, out);
    const src = makeSource(whiteBuf, 1);
    connectAll(src, bp);
    setParam(bp.frequency, 280, t);
    rampParam(bp.frequency, 2200, t + 0.02, 0.085);
    setParam(g.gain, 0.0001, t);
    setParam(g.gain, 0.55 * vol, t + 0.006);
    rampParam(g.gain, 0.0001, t + 0.012, 0.085);
    src.start(t);
    src.stop(t + 0.5);
  }

  function boostSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const g = makeGain(0.0001);
    const bp = makeFilter('bandpass', 200, 0.8);
    connectAll(bp, g, out);
    const src = makeSource(whiteBuf, 1);
    connectAll(src, bp);
    setParam(bp.frequency, 220, t);
    rampParam(bp.frequency, 2600, t + 0.03, 0.1);
    rampParam(bp.frequency, 320, t + 0.5, 0.16);
    setParam(g.gain, 0.0001, t);
    rampParam(g.gain, 0.33 * vol, t + 0.02, 0.11);
    rampParam(g.gain, 0.0001, t + 0.65, 0.16);
    src.start(t);
    src.stop(t + 1.25);
    const air = makeGain(0.0001);
    connectAll(air, out);
    const tone = ac.createOscillator();
    tone.type = 'sine';
    setParam(tone.frequency, 180, t);
    rampParam(tone.frequency, 760, t + 0.1, 0.22);
    connectAll(tone, air);
    rampParam(air.gain, 0.05 * vol, t + 0.05, 0.16);
    rampParam(air.gain, 0.0001, t + 0.7, 0.18);
    tone.start(t);
    tone.stop(t + 1.2);
  }

  function brakeSfx(t, vol, pan) {
    const out = outTo(sfxBus, pan);
    const g = makeGain(0.0001);
    const bp = makeFilter('bandpass', 2600, 3);
    connectAll(bp, g, out);
    const src = makeSource(whiteBuf, 1);
    connectAll(src, bp);
    setParam(bp.frequency, 2900, t);
    rampParam(bp.frequency, 1850, t + 0.05, 0.1);
    setParam(g.gain, 0.0001, t);
    setParam(g.gain, 0.5 * vol, t + 0.02);
    rampParam(g.gain, 0.0001, t + 0.04, 0.16);
    src.start(t);
    src.stop(t + 0.55);
  }

  function birdSfx(t, vol, pan) {
    // FM chirp with a short up-and-down pitch contour, 2-4 syllables.
    const out = outTo(sfxBus, pan);
    const notes = rng.irange(2, 4);
    const base = rng.range(2200, 4200);
    for (let i = 0; i < notes; i++) {
      const t0 = t + i * rng.range(0.07, 0.16);
      const f0 = base * (1 + rng.range(-0.08, 0.08));
      const g = makeGain(0.0001);
      connectAll(g, out);
      const o = ac.createOscillator();
      o.type = 'sine';
      setParam(o.frequency, f0, t0);
      rampParam(o.frequency, f0 * rng.range(1.25, 1.7), t0 + 0.01, 0.025);
      rampParam(o.frequency, f0 * 0.82, t0 + 0.05, 0.03);
      const mod = ac.createOscillator();
      mod.type = 'sine';
      setParam(mod.frequency, f0 * 2.2, t0);
      const modGain = makeGain(f0 * 1.1);
      rampParam(modGain.gain, 0, t0 + 0.02, 0.05);
      connectAll(mod, modGain, o.frequency);
      connectAll(o, g);
      setParam(g.gain, 0.0001, t0);
      setParam(g.gain, 0.1 * vol, t0 + 0.006);
      rampParam(g.gain, 0.0001, t0 + 0.012, 0.035);
      o.start(t0);
      mod.start(t0);
      o.stop(t0 + 0.34);
      mod.stop(t0 + 0.34);
    }
  }

  function owlSfx(t, vol, pan) {
    const out = outTo(ambientBus, pan);
    for (let i = 0; i < 2; i++) {
      const t0 = t + i * 0.55;
      const g = makeGain(0.0001);
      const lp = makeFilter('lowpass', 700, 0.9);
      connectAll(lp, g, out);
      const o = ac.createOscillator();
      o.type = 'sine';
      setParam(o.frequency, 372, t0);
      rampParam(o.frequency, 318, t0 + 0.04, 0.13);
      connectAll(o, lp);
      setParam(g.gain, 0.0001, t0);
      rampParam(g.gain, 0.14 * vol, t0 + 0.06, 0.06);
      rampParam(g.gain, 0.0001, t0 + 0.2, 0.11);
      o.start(t0);
      o.stop(t0 + 0.62);
    }
  }

  function harbourBellSfx(t, vol) {
    const out = outTo(ambientBus, 0.25);
    for (let i = 0; i < 2; i++) {
      const t0 = t + i * 1.0;
      const g = makeGain(0.0001);
      const bp = makeFilter('bandpass', 900, 0.8);
      connectAll(bp, g, out);
      const carrier = ac.createOscillator();
      carrier.type = 'sine';
      setParam(carrier.frequency, 523, t0);
      const mod = ac.createOscillator();
      mod.type = 'sine';
      setParam(mod.frequency, 523 * 2.4, t0);
      const modGain = makeGain(523 * 2.4 * 0.6);
      rampParam(modGain.gain, 0, t0 + 0.02, 0.2);
      connectAll(mod, modGain, carrier.frequency);
      connectAll(carrier, bp);
      setParam(g.gain, 0.0001, t0);
      setParam(g.gain, 0.16 * vol, t0 + 0.005);
      rampParam(g.gain, 0.0001, t0 + 0.02, 0.9);
      carrier.start(t0);
      mod.start(t0);
      carrier.stop(t0 + 2.8);
      mod.stop(t0 + 2.8);
    }
  }

  function hatSfx(t, vol) {
    const out = outTo(sfxBus, 0.12);
    const g = makeGain(0.0001);
    const hp = makeFilter('highpass', 6500, 0.7);
    connectAll(hp, g, out);
    const src = makeSource(whiteBuf, 1.2);
    connectAll(src, hp);
    setParam(g.gain, 0.0001, t);
    setParam(g.gain, 0.022 * vol, t + 0.002);
    rampParam(g.gain, 0.0001, t + 0.005, 0.018);
    src.start(t);
    src.stop(t + 0.16);
  }

  function kickSfx(t, vol) {
    const out = outTo(sfxBus, 0);
    const g = makeGain(0.0001);
    connectAll(g, out);
    const o = ac.createOscillator();
    o.type = 'sine';
    setParam(o.frequency, 68, t);
    rampParam(o.frequency, 41, t + 0.015, 0.07);
    connectAll(o, g);
    rampParam(g.gain, 0.055 * vol, t + 0.004, 0.02);
    rampParam(g.gain, 0.0001, t + 0.02, 0.08);
    o.start(t);
    o.stop(t + 0.45);
  }

  function pluckSfx(t) {
    if (!pluckIn) return;
    const chord = CHORDS[chordIndex < 0 ? 0 : chordIndex];
    const f = rng.float() < 0.3
      ? chord.third * 4
      : PENTA[rng.irange(0, PENTA.length - 1)];
    const o = ac.createOscillator();
    o.type = 'triangle';
    setParam(o.frequency, f, t);
    setProp(o, 'detune', rng.range(-6, 6));
    const g = makeGain(0.0001);
    connectAll(o, g, pluckIn);
    setParam(g.gain, 0.0001, t);
    setParam(g.gain, 0.18 * (0.55 + 0.55 * intensity), t + 0.008);
    rampParam(g.gain, 0.0001, t + 0.02, 0.34);
    o.start(t);
    o.stop(t + 1.6);
    // A soft octave voice keeps the arpeggio airy.
    if (rng.chance(0.35)) {
      const o2 = ac.createOscillator();
      o2.type = 'triangle';
      setParam(o2.frequency, f * 2, t + 0.02);
      const g2 = makeGain(0.0001);
      connectAll(o2, g2, pluckIn);
      setParam(g2.gain, 0.0001, t + 0.02);
      setParam(g2.gain, 0.05, t + 0.026);
      rampParam(g2.gain, 0.0001, t + 0.04, 0.16);
      o2.start(t + 0.02);
      o2.stop(t + 1.2);
    }
  }

  // =========================================================================
  // Tone scheduling (called from update)
  // =========================================================================

  function startChord(index, t) {
    if (!padGroups) return;
    const chord = CHORDS[index];
    const next = 1 - activeGroup;
    const group = padGroups[next];
    for (let i = 0; i < group.voices.length; i++) {
      const voice = group.voices[i];
      const f = voice.pick === 'third' ? chord.third : chord.root;
      setParam(voice.osc.frequency, f, t);
    }
    // Crossfade: incoming group up, outgoing group down.
    rampParam(padGroups[activeGroup].gain.gain, 0.0001, t, 1.35);
    rampParam(group.gain.gain, 0.5, t, 1.35);
    activeGroup = next;
  }

  function applySurfaceGains(name, t) {
    const s = SURFACES[name] || SURFACES.asphalt;
    if (rollBrightG) rampParam(rollBrightG.gain, s.bright, t, 0.3);
    if (rollMidG) rampParam(rollMidG.gain, s.mid, t, 0.3);
    if (rollDarkG) rampParam(rollDarkG.gain, s.dark, t, 0.3);
    if (rollCrackleG) rampParam(rollCrackleG.gain, s.crackle, t, 0.3);
    // Rattle depth stays a fraction of the branch level so the gain can never
    // be modulated negative and re-open a silent branch.
    if (rollCrackleDepth) rampParam(rollCrackleDepth.gain, s.crackle * 0.5, t, 0.3);
    if (rollWaterG) rampParam(rollWaterG.gain, s.water, t, 0.3);
    if (rollBrightHp) rampParam(rollBrightHp.frequency, s.hp, t, 0.3);
    if (rollDarkLp) rampParam(rollDarkLp.frequency, s.lp, t, 0.3);
    if (rollMidBp) rampParam(rollMidBp.frequency, s.midF, t, 0.3);
    if (rollCrackleLfo) rampParam(rollCrackleLfo.frequency, s.crackleF, t, 0.3);
  }

  function dayFactor(h) {
    return clamp01((h - 5.4) / 1.6) * (1 - clamp01((h - 16.6) / 2.2));
  }

  function nightFactor(h) {
    return clamp01(clamp01((h - 18.2) / 1.6) + clamp01((5.4 - h) / 1.6));
  }

  function safeIsWater(x, z) {
    if (!layout || typeof layout.isWater !== 'function') return false;
    try {
      const w = layout.isWater(x, z);
      return w === true || (typeof w === 'number' && w > 0);
    } catch (_) { return false; }
  }

  function safeHeight(x, z) {
    if (!layout || typeof layout.heightAt !== 'function') return NaN;
    try {
      const h = layout.heightAt(x, z);
      return (typeof h === 'number' && isFinite(h)) ? h : NaN;
    } catch (_) { return NaN; }
  }

  // =========================================================================
  // Frame state extraction
  // =========================================================================

  function readFrame(dt, state) {
    const p = state && state.player ? state.player : null;
    const cam = state && state.camera ? state.camera : null;

    fSpeed = 0;
    fBoost = 0;
    fGrounded = true;
    fInWater = false;
    fSurface = surface;
    fHasPos = false;

    if (p) {
      if (typeof p.speed === 'number' && isFinite(p.speed)) fSpeed = Math.abs(p.speed);
      if (typeof p.boost === 'number' && isFinite(p.boost)) fBoost = clamp01(p.boost);
      else if (p.boost === true) fBoost = 1;
      if (p.grounded === false) fGrounded = false;
      if (p.inWater === true) fInWater = true;
      if (typeof p.surface === 'string' && SURFACES[p.surface]) fSurface = p.surface;
      const pos = p.position;
      if (pos && typeof pos.x === 'number' && typeof pos.z === 'number' && isFinite(pos.x) && isFinite(pos.z)) {
        fPx = pos.x;
        fPy = (typeof pos.y === 'number' && isFinite(pos.y)) ? pos.y : 0;
        fPz = pos.z;
        fHasPos = true;
      }
    }

    // Fall back to the camera when the player transform is unavailable.
    const cpos = cam ? cam.position : null;
    if (cpos && typeof cpos.x === 'number' && typeof cpos.z === 'number' && isFinite(cpos.x) && isFinite(cpos.z)) {
      if (fHasPos) {
        const dx = cpos.x - fPx;
        const dz = cpos.z - fPz;
        fCamDist2 = dx * dx + dz * dz;
      } else {
        fCamDist2 = 0;
        fPx = cpos.x;
        fPy = (typeof cpos.y === 'number' && isFinite(cpos.y)) ? cpos.y : 0;
        fPz = cpos.z;
        fHasPos = true;
      }
    } else {
      fCamDist2 = 0;
    }

    if (state) {
      if (typeof state.hour === 'number' && isFinite(state.hour)) hour = ((state.hour % 24) + 24) % 24;
      const wind = state.wind;
      if (wind && typeof wind.strength === 'number' && isFinite(wind.strength)) windStrength = clamp01(wind.strength);
      const weather = state.weather;
      if (weather && typeof weather.rain === 'number' && isFinite(weather.rain)) fRain = clamp01(weather.rain);
      fPaused = state.paused === true;
      fPhoto = state.photoMode === true;
    } else {
      fPaused = false;
      fPhoto = false;
    }

    // Brake estimate: explicit input when present, else measured deceleration.
    fBrake = 0;
    if (p) {
      if (typeof p.brake === 'number' && isFinite(p.brake)) fBrake = clamp01(p.brake);
      else fBrake = clamp01((prevSpeed - fSpeed) / (dt > 0 ? dt * 7 : 1));
    }

    fEnterWater = fInWater && !prevInWater;
    fLeaveWater = !fInWater && prevInWater;
    fStartBoost = fBoost > 0.25 && !prevBoost;
    prevInWater = fInWater;
    prevBoost = fBoost > 0.25;
    prevSpeed = fSpeed;

    // Terrain height under the rider (drives wind exposure + shore blend).
    let h = safeHeight(fPx, fPz);
    if (!isFinite(h)) h = fPy;
    fAlt = isFinite(h) ? clamp01(h / 220) : 0;

    // Shore proximity: a few cheap samples, once per update.
    let shore = 0;
    if (fHasPos && layout && typeof layout.isWater === 'function') {
      if (safeIsWater(fPx + 45, fPz)) shore += 0.16;
      if (safeIsWater(fPx - 45, fPz)) shore += 0.16;
      if (safeIsWater(fPx, fPz + 45)) shore += 0.16;
      if (safeIsWater(fPx, fPz - 45)) shore += 0.16;
      if (safeIsWater(fPx + 16, fPz)) shore += 0.12;
      if (safeIsWater(fPx, fPz - 16)) shore += 0.12;
      if (isFinite(h)) shore += clamp01((28 - h) / 28) * 0.42;
    }
    fShore = clamp01(shore);

    // Nearest discovery, resampled 2.5 times per second.
    poiTimer -= dt;
    if (poiTimer <= 0) {
      poiTimer = 0.4;
      fNearPoi = false;
      const pois = layout ? layout.pois : null;
      if (pois && fHasPos) {
        for (const id in pois) {
          const poi = pois[id];
          const pos = poi ? poi.position : null;
          if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') continue;
          const dx = pos.x - fPx;
          const dz = pos.z - fPz;
          if (dx * dx + dz * dz < 70 * 70) { fNearPoi = true; break; }
        }
      }
    }
  }

  // =========================================================================
  // Per-system update steps
  // =========================================================================

  function stepAmbient(dt) {
    const t = now();
    const day = dayFactor(hour);
    const night = nightFactor(hour);
    const busy = fPaused ? 0.7 : 1;

    // Wind ------------------------------------------------------------------
    const apparent = clamp01(fSpeed / 14) + fBoost * 0.35;
    const windLevel = Math.min(0.9, (0.035 + 0.3 * windStrength * (1 + 0.8 * fAlt) + 0.16 * fAlt + 0.12 * apparent) * busy);
    if (windGain) {
      rampParam(windGain.gain, windLevel, t, 0.7);
      if (windLfoGain) rampParam(windLfoGain.gain, windLevel * 0.35, t, 0.9);
    }
    if (windBp) rampParam(windBp.frequency, 380 + 260 * windStrength + 180 * fAlt, t, 1.2);
    if (windSrc) rampParam(windSrc.playbackRate, 0.75 + 0.5 * windStrength + 0.25 * apparent, t, 0.8);

    // Ocean -----------------------------------------------------------------
    const waveLevel = (0.03 + 0.42 * fShore) * (0.8 + 0.35 * (1 - fAlt)) * busy;
    if (waveGain) {
      rampParam(waveGain.gain, waveLevel, t, 0.9);
      if (swellGain) rampParam(swellGain.gain, waveLevel * 0.55, t, 0.9);
    }
    if (waveLp) rampParam(waveLp.frequency, 360 + 180 * fShore, t, 1.2);
    if (waveSrc) rampParam(waveSrc.playbackRate, 0.85 + 0.25 * fShore, t, 1.0);

    // Crickets / night insects ----------------------------------------------
    if (crickets) {
      const cricketLevel = night * 0.042 * qualityFactor * (1 - 0.75 * fRain) * busy;
      for (let i = 0; i < crickets.length; i++) {
        const voice = crickets[i];
        const level = cricketLevel * voice.level;
        rampParam(voice.gain.gain, level, t, 1.5);
        rampParam(voice.tremDepth.gain, level * 0.5, t, 1.5);
        rampParam(voice.chirpDepth.gain, level * 0.5, t, 1.5);
      }
    }

    // Forest birds (day) ----------------------------------------------------
    birdTimer -= dt;
    if (birdTimer <= 0) {
      const rate = day * (1 - clamp01(fRain * 1.2)) * qualityFactor * (fPaused ? 0.3 : 1);
      if (rate > 0.05 && rng.float() < 0.55 + 0.4 * rate) {
        birdSfx(t, 0.55 + 0.45 * rate, rng.range(-0.85, 0.85));
      }
      birdTimer = lerp(13, 3.2, rate) * rng.range(0.5, 1.5);
    }

    // Distant owl (night) ---------------------------------------------------
    owlTimer -= dt;
    if (owlTimer <= 0) {
      owlTimer = 55 + rng.range(0, 70);
      if (night > 0.6 && !fPaused && rng.chance(0.45)) owlSfx(t, 0.7, rng.range(-0.7, 0.7));
    }

    // Seagulls over the water ----------------------------------------------
    gullTimer -= dt;
    if (gullTimer <= 0) {
      gullTimer = 24 + rng.range(0, 40);
      if (day > 0.25 && fShore > 0.25 && !fPaused && rng.chance(0.5)) {
        seagullSfx(t + 0.2, 0.5 * clamp01(fShore + 0.3), rng.range(-0.9, 0.9));
      }
    }

    // Harbour bell, roughly every 45 s when close to the harbour ------------
    bellTimer -= dt;
    if (bellTimer <= 0) {
      bellTimer = 42 + rng.range(0, 12);
      const pois = layout ? layout.pois : null;
      const harbour = pois ? pois.harbor : null;
      const hp = harbour ? harbour.position : null;
      if (hp && typeof hp.x === 'number' && typeof hp.z === 'number' && fHasPos) {
        const dx = hp.x - fPx;
        const dz = hp.z - fPz;
        const d2 = dx * dx + dz * dz;
        if (d2 < 300 * 300) harbourBellSfx(t, 0.4 + 0.6 * (1 - Math.sqrt(d2) / 300));
      }
    }
  }

  function stepBike(dt) {
    const t = now();
    if (!rollSum) return;

    const speedFactor = clamp01(fSpeed / 12);
    const groundedF = fGrounded ? 1 : 0.3;
    const atten = 1 / (1 + fCamDist2 * 0.0016);
    const dim = fPaused ? 0.25 : 1;

    rampParam(rollSum.gain, 0.1 * speedFactor * groundedF * atten * dim, t, 0.15);
    if (rollSrc) rampParam(rollSrc.playbackRate, clamp(0.55 + fSpeed / 15, 0.5, 2.4), t, 0.12);
    if (rollBrightHp) rampParam(rollBrightHp.frequency, 190 + fSpeed * 22, t, 0.3);
    if (fSurface !== appliedSurface) {
      applySurfaceGains(fSurface, t);
      appliedSurface = fSurface;
    }

    const chainLevel = clamp01(fSpeed / 10) * atten * dim;
    if (chainG) rampParam(chainG.gain, 0.035 * chainLevel, t, 0.2);
    if (chainSrc) rampParam(chainSrc.playbackRate, clamp(0.7 + fSpeed / 12, 0.6, 2.2), t, 0.2);
    if (chainOsc) rampParam(chainOsc.frequency, 24 + fSpeed * 7, t, 0.2);
    if (chainToneG) rampParam(chainToneG.gain, 0.008 * chainLevel, t, 0.25);

    // Splashes: entering water, leaving water, and spray while wet.
    splashCool -= dt;
    if (fEnterWater) {
      splashSfx(t, 0.55 * clamp01(0.35 + fSpeed / 12), 0);
      splashCool = 0.45;
    } else if (fLeaveWater) {
      splashSfx(t, 0.28, 0);
      splashCool = 0.4;
    } else if (fInWater && fSpeed > 3 && splashCool <= 0 && rng.float() < dt * (0.2 + fSpeed * 0.06)) {
      splashSfx(t, 0.12 + 0.25 * clamp01(fSpeed / 12), rng.range(-0.2, 0.2));
      splashCool = 0.3;
    }

    // Hard braking squeal.
    brakeCool -= dt;
    if (brakeCool <= 0 && fSpeed > 6 && fBrake > 0.6 && fGrounded) {
      brakeSfx(t, 0.6 + 0.4 * clamp01((fSpeed - 6) / 8), rng.range(-0.2, 0.2));
      brakeCool = 0.5 + rng.range(0, 0.35);
    }

    // Boost whoosh on the rising edge.
    boostCool -= dt;
    if (fStartBoost && boostCool <= 0) {
      boostSfx(t, 1, 0);
      boostCool = 0.7;
    }
  }

  function stepMusic(dt) {
    const t = now();
    if (!padGain) return;

    // Intensity: 0.35 idle, 0.8 riding fast or near a discovery, 0.15 photo/pause.
    const fast = clamp01((fSpeed - 5) / 4); // 0.35 at a crawl, 0.8 from ~9 m/s
    const rise = Math.max(fast, fNearPoi ? 1 : 0, intensityBoost);
    let target = 0.35 + 0.45 * clamp01(rise);
    if (fPaused || fPhoto) target = 0.15;
    intensity += (target - intensity) * (1 - Math.exp(-1.8 * dt));
    intensity = clamp01(intensity);
    intensityBoost += (0 - intensityBoost) * (1 - Math.exp(-0.3 * dt));

    // Chord loop: an 8 s pad chord with a soft kick on every change.
    musicTime += dt;
    const ci = Math.floor(musicTime / CHORD_SECONDS) % CHORDS.length;
    if (ci !== chordIndex) {
      chordIndex = ci;
      startChord(ci, t);
      kickSfx(t, 0.6 + 0.6 * intensity);
    }
    rampParam(padGain.gain, (0.05 + 0.15 * intensity) * (fPhoto ? 0.9 : 1), t, 2.4);

    // Pluck density follows intensity.
    pluckTimer -= dt;
    if (pluckTimer <= 0) {
      if (!fPaused && rng.float() < 0.3 + 0.65 * intensity) pluckSfx(t);
      const mean = lerp(3.6, 1.0, clamp01((intensity - 0.3) / 0.5)) / Math.max(0.5, qualityFactor);
      pluckTimer = mean * rng.range(0.55, 1.5);
    }

    // Shaker every 2 beats.
    beatTime += dt;
    if (beatTime >= BEAT_SECONDS) {
      beatTime -= BEAT_SECONDS * Math.floor(beatTime / BEAT_SECONDS);
      beatCount = (beatCount + 1) % 64;
      if (beatCount % 2 === 0) hatSfx(t, 0.6 + 0.8 * intensity);
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  function resumeIfSuspended() {
    try {
      if (ac && ac.state === 'suspended' && typeof ac.resume === 'function') {
        const p = ac.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Page-visibility lifecycle: a hidden tab must not keep synthesising music
   * and waves in the background. The graph is kept intact, only the context
   * is suspended/resumed.
   */
  function suspend() {
    try {
      if (ac && ac.state === 'running' && typeof ac.suspend === 'function') {
        const p = ac.suspend();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }

  function resume() {
    resumeIfSuspended();
  }

  function init() {
    try {
      if (ready) {
        resumeIfSuspended();
        return;
      }
      const Ctor = (typeof globalThis !== 'undefined')
        ? (globalThis.AudioContext || globalThis.webkitAudioContext)
        : null;
      if (typeof Ctor !== 'function') {
        ac = null;
        ready = false;
        api.state.ready = false;
        return;
      }
      ac = new Ctor();
      if (!ac || typeof ac.createGain !== 'function' || typeof ac.createOscillator !== 'function') {
        ac = null;
        ready = false;
        api.state.ready = false;
        return;
      }
      timeFallback = 0;
      attempt(() => { whiteBuf = noiseBuffer(2, false); });
      attempt(() => { pinkBuf = noiseBuffer(2, true); });
      attempt(buildMaster);
      attempt(buildReverb);
      attempt(buildAmbient);
      attempt(buildBike);
      attempt(buildMusic);
      ready = !!(masterGain && musicBus && sfxBus && ambientBus);
      api.state.ready = ready;
      if (ready) {
        appliedSurface = ''; // force the first surface pass
        if (typeof ctx.quality === 'string') setQuality(ctx.quality);
        resumeIfSuspended();
      }
    } catch (_) {
      ready = false;
      api.state.ready = false;
    }
  }

  function update(dt, state) {
    if (!ready) return;
    // A suspended context does not advance its clock: stepping the graph now
    // would schedule audio in the past and drift the ambience timeline.
    if (ac && ac.state === 'suspended') return;
    const step = clamp((typeof dt === 'number' && isFinite(dt)) ? dt : 0.016, 0, 0.1);
    try { readFrame(step, state); } catch (_) { return; }
    try { stepAmbient(step); } catch (_) { /* never throw from the frame loop */ }
    try { stepBike(step); } catch (_) { /* ignore */ }
    try { stepMusic(step); } catch (_) { /* ignore */ }
  }

  function sfx(name, opts) {
    if (!ready || typeof name !== 'string') return;
    const canonical = SFX_ALIASES[name.toLowerCase()];
    if (!canonical) return;
    const o = opts || NO_OPTS;
    let vol = typeof o.volume === 'number' && isFinite(o.volume) ? o.volume : 1;
    const pan = typeof o.pan === 'number' && isFinite(o.pan) ? clamp(o.pan, -1, 1) : 0;
    const pitch = (typeof o.pitch === 'number' && isFinite(o.pitch) && o.pitch > 0) ? clamp(o.pitch, 0.25, 4) : 1;
    vol = clamp(vol, 0, 4);
    if (vol <= 0) return;
    const t = now();
    try {
      switch (canonical) {
        case 'bell': bellSfx(t, vol * pitch, pan); break;
        case 'pickup': pickupSfx(t, vol, pan); break;
        case 'discovery': discoverySfx(t, vol, pan); break;
        case 'seagull': seagullSfx(t, vol, pan); break;
        case 'thunder': thunderSfx(t, vol, pan); break;
        case 'firework': fireworkSfx(t, vol, pan); break;
        case 'crash': crashSfx(t, vol, pan); break;
        case 'splash': splashSfx(t, vol, pan); break;
        case 'boost': boostSfx(t, vol, pan); break;
        case 'brake': brakeSfx(t, vol, pan); break;
        case 'bird': birdSfx(t, vol, pan); break;
        case 'owl': owlSfx(t, vol, pan); break;
        default: break;
      }
    } catch (_) { /* a broken one-shot must never take the frame down */ }
  }

  function applyVolumes(tau) {
    if (!ready) return;
    const t = now();
    const k = tau == null ? 0.05 : tau;
    if (masterGain) rampParam(masterGain.gain, muted ? 0 : masterVol, t, k);
    if (musicBus) rampParam(musicBus.gain, musicVol, t, k);
    if (sfxBus) rampParam(sfxBus.gain, sfxVol, t, k);
  }

  function setMasterVolume(v) {
    try {
      if (typeof v !== 'number' || !isFinite(v)) return;
      masterVol = clamp01(v);
      applyVolumes(0.08);
    } catch (_) { /* ignore */ }
  }

  function setMusicVolume(v) {
    try {
      if (typeof v !== 'number' || !isFinite(v)) return;
      musicVol = clamp01(v);
      applyVolumes(0.08);
    } catch (_) { /* ignore */ }
  }

  function setSfxVolume(v) {
    try {
      if (typeof v !== 'number' || !isFinite(v)) return;
      sfxVol = clamp01(v);
      applyVolumes(0.08);
    } catch (_) { /* ignore */ }
  }

  function setMuted(b) {
    try {
      muted = b === true;
      applyVolumes(0.12);
    } catch (_) { /* ignore */ }
  }

  function setSurface(name) {
    try {
      if (typeof name !== 'string') return;
      const key = name.toLowerCase();
      if (SURFACES[key]) surface = key;
    } catch (_) { /* ignore */ }
  }

  function setWind(strength) {
    try {
      if (typeof strength !== 'number' || !isFinite(strength)) return;
      windStrength = clamp01(strength);
    } catch (_) { /* ignore */ }
  }

  function setHour(h) {
    try {
      if (typeof h !== 'number' || !isFinite(h)) return;
      hour = ((h % 24) + 24) % 24;
    } catch (_) { /* ignore */ }
  }

  function setMusicIntensity(v) {
    try {
      if (typeof v !== 'number' || !isFinite(v)) return;
      intensityBoost = clamp01(v);
    } catch (_) { /* ignore */ }
  }

  function setQuality(payload) {
    try {
      let q = payload;
      if (q && typeof q === 'object') q = q.quality || q.level || q.name || null;
      if (typeof q !== 'string') return;
      q = q.toLowerCase();
      qualityFactor = q === 'low' ? 0.45 : q === 'medium' ? 0.75 : 1;
      if (reverbGain) rampParam(reverbGain.gain, q === 'low' ? 0.05 : 0.16, now(), 0.4);
    } catch (_) { /* ignore */ }
  }

  const api = {
    state: { ready: false },
    init,
    suspend,
    resume,
    update,
    sfx,
    setMasterVolume,
    setMusicVolume,
    setSfxVolume,
    setMuted,
    setSurface,
    setWind,
    setHour,
  };

  if (bus && typeof bus.on === 'function') {
    try {
      bus.on('sfx', (e) => {
        if (!e) return;
        sfx(e.name, e);
      });
      bus.on('feather:collected', () => sfx('pickup', { volume: 1 }));
      bus.on('poi:discovered', () => sfx('discovery', { volume: 1 }));
      bus.on('rider:crash', () => {
        sfx('crash', { volume: 1 });
        if (fInWater) sfx('splash', { volume: 0.8 });
      });
      bus.on('quality:changed', (e) => setQuality(e));
      bus.on('sfx:music:intensity', (e) => {
        setMusicIntensity(typeof e === 'number' ? e : (e && e.intensity));
      });
    } catch (_) { /* a hostile bus must not break construction */ }
  }

  return api;
}
