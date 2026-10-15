/**
 * particles.js - everything that drifts, blows, sparkles or splashes.
 *
 * Six fixed pools drawn as one THREE.Points per family (six draw calls), each
 * with a small custom ShaderMaterial that does size attenuation, per-particle
 * size/alpha/rotation/life attributes and point-sprite rotation in the
 * fragment shader:
 *
 *   dust     pollen motes + the plume the rear wheel kicks up   (normal)
 *   smoke    chimneys, campfire smoke, waterfall + lake mist  (normal)
 *   leaf     falling leaves near the forests                  (normal)
 *   spray    sea spray off the west cliffs, water splashes    (normal)
 *   confetti confetti bursts                                  (normal)
 *   spark    sparkles, campfire embers                        (additive)
 *
 * Pool size is 1500 * preset.particleScale (min 300) split by family weights;
 * every particle that dies is parked at y = -9999 with alpha 0, and spawning
 * recycles it - update() never allocates.
 *
 * See docs/SPEC.md sections 4.13 / 6 for the frozen contracts.
 */

import * as THREE from 'three';
import { Rng, TAU, clamp, clamp01, lerp, smoothstep } from '../core/utils.js';
import { QUALITY_PRESETS } from '../core/settings.js';

// Distinct families and their slice of the pool.
const FAMILY_DEFS = [
  { id: 'dust', weight: 0.20, sprite: 'cloudSprite', blend: 'normal', color: 0xffe3bb, drag: 1.1, gravity: -0.25, wind: 0.28, grow: 1.7, lifeRamp: 1.0 },
  { id: 'smoke', weight: 0.20, sprite: 'smokeSprite', blend: 'normal', color: 0xd3d7dc, drag: 0.85, gravity: 0.06, wind: 0.34, grow: 2.6, lifeRamp: 0.8 },
  { id: 'leaf', weight: 0.12, sprite: 'leafSprite', blend: 'normal', color: 0xffffff, drag: 0.8, gravity: -1.5, wind: 0.75, grow: 1.0, lifeRamp: 1.0 },
  { id: 'spray', weight: 0.16, sprite: 'cloudSprite', blend: 'normal', color: 0xeff9fb, drag: 0.45, gravity: -4.6, wind: 0.12, grow: 1.35, lifeRamp: 1.0 },
  { id: 'confetti', weight: 0.10, sprite: 'confetti', blend: 'normal', color: 0xffffff, drag: 1.5, gravity: -2.3, wind: 0.4, grow: 1.0, lifeRamp: 1.0 },
  { id: 'spark', weight: 0.22, sprite: 'sparkSprite', blend: 'add', color: 0xffd27a, drag: 1.1, gravity: 0.35, wind: 0.05, grow: 1.0, lifeRamp: 0.55 },
];

/** Instance buffers are sized for the largest preset (ultra: 1.35). */
const MAX_PARTICLE_SCALE = 1.35;
const BASE_POOL = 1500;
const MIN_POOL = 300;
const MAX_EMITTERS = 128;
const PARKED_Y = -9999;

// ---------------------------------------------------------------------------
// Module scratch
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _col = new THREE.Color();

// ---------------------------------------------------------------------------
// Shader factory
// ---------------------------------------------------------------------------

function makePointsMaterial(map, additive, colorHex, grow, lifeRamp) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map && map.isTexture ? map : null },
      uColor: { value: new THREE.Color(colorHex) },
      uScale: { value: 420 },
      uGrow: { value: grow },
      uLifeRamp: { value: lifeRamp },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      attribute float aRot;
      attribute float aLife;
      attribute vec3 aTint;
      uniform float uScale;
      uniform float uGrow;
      varying float vAlpha;
      varying float vRot;
      varying float vLife;
      varying vec3 vTint;
      void main() {
        vAlpha = aAlpha;
        vRot = aRot;
        vLife = aLife;
        vTint = aTint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = aSize * mix(1.0, uGrow, aLife);
        gl_PointSize = size * (uScale / max(1.0, -mv.z));
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uLifeRamp;
      varying float vAlpha;
      varying float vRot;
      varying float vLife;
      varying vec3 vTint;
      void main() {
        if (vAlpha < 0.004) discard;
        vec2 uv = gl_PointCoord - 0.5;
        float c = cos(vRot);
        float s = sin(vRot);
        uv = mat2(c, -s, s, c) * uv + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
        vec4 tex = texture2D(uMap, uv);
        float a = tex.a * vAlpha;
        if (a < 0.004) discard;
        vec3 tint = uColor * vTint * mix(vec3(1.0), vec3(uLifeRamp), vLife);
        gl_FragColor = vec4(tint * tex.rgb, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createParticles(ctx) {
  const layout = ctx.layout;
  const textures = ctx.textures || {};
  const engine = ctx.engine || null;
  const bus = ctx.bus || null;
  const qualityLevel = (engine && engine.qualityLevel) || ctx.quality || 'high';
  const preset = Object.assign({}, (engine && engine.preset) || QUALITY_PRESETS[qualityLevel] || QUALITY_PRESETS.high);
  const rng = new Rng('particles:' + layout.seed);

  const group = new THREE.Group();
  group.name = 'particles';

  const stats = {
    total: 0, alive: 0, emitters: 0, bursts: 0, drawCalls: 0,
    dust: 0, smoke: 0, leaf: 0, spray: 0, confetti: 0, spark: 0,
  };
  const debug = { hour: 12 };

  // -------------------------------------------------------------------------
  // Sprite maps
  // -------------------------------------------------------------------------

  const spriteOf = (name) => {
    if (typeof textures[name] !== 'function') return null;
    if (name === 'leafSprite') return textures.leafSprite('broadleaf', 321);
    return textures[name]();
  };

  /** Two-tone confetti chip, drawn on a throwaway canvas (null when headless). */
  const confettiMap = (() => {
    if (typeof textures.canvas !== 'function') return null;
    const canvas = textures.canvas(32);
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const c2d = canvas.getContext('2d');
    if (!c2d) return null;                        // no DOM / null 2D context
    c2d.clearRect(0, 0, 32, 32);
    c2d.fillStyle = '#e0523f';
    c2d.fillRect(0, 0, 32, 16);
    c2d.fillStyle = '#f2e8d5';
    c2d.fillRect(0, 16, 32, 16);
    if (typeof textures.texture !== 'function') return null;
    const tex = textures.texture(canvas, { wrap: THREE.ClampToEdgeWrapping, repeat: 1 });
    return tex && tex.isTexture ? tex : null;
  })();

  // -------------------------------------------------------------------------
  // Pools
  // -------------------------------------------------------------------------

  const capacityPool = Math.ceil(BASE_POOL * MAX_PARTICLE_SCALE);
  const families = [];
  const famById = {};

  for (const def of FAMILY_DEFS) {
    const cap = Math.max(16, Math.round(capacityPool * def.weight));
    const pos = new Float32Array(cap * 3);
    const vel = new Float32Array(cap * 3);
    const size0 = new Float32Array(cap);
    const size1 = new Float32Array(cap);
    const alpha0 = new Float32Array(cap);
    const life = new Float32Array(cap);
    const lifeMax = new Float32Array(cap);
    const spin = new Float32Array(cap);
    const tint = new Float32Array(cap * 3);
    for (let i = 0; i < cap; i++) {
      pos[i * 3 + 1] = PARKED_Y;
      tint[i * 3] = tint[i * 3 + 1] = tint[i * 3 + 2] = 1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(cap), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(cap), 1));
    geo.setAttribute('aRot', new THREE.BufferAttribute(new Float32Array(cap), 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(cap), 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    for (const key of ['position', 'aSize', 'aAlpha', 'aRot', 'aLife', 'aTint']) {
      geo.attributes[key].setUsage(THREE.DynamicDrawUsage);
    }

    const map = def.sprite === 'confetti' ? confettiMap : spriteOf(def.sprite);
    const mat = makePointsMaterial(map, def.blend === 'add', def.color, def.grow, def.lifeRamp);
    const points = new THREE.Points(geo, mat);
    points.name = `particles:${def.id}`;
    points.frustumCulled = false;               // the pool follows the camera
    group.add(points);

    const free = new Int32Array(cap);
    for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;   // pop order 0, 1, 2 ...
    const fam = {
      id: def.id, def, cap, limit: cap, alive: 0, free, freeTop: cap,
      points, geo, mat,
      pos, vel, size0, size1, alpha0, life, lifeMax, spin, tint,
    };
    families.push(fam);
    famById[def.id] = fam;
    stats[def.id] = 0;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  function spawn(fam, x, y, z, vx, vy, vz, sizeA, sizeB, lifeSeconds, alpha, rot0, rotSpeed, tintHex) {
    if (fam.freeTop <= 0 || fam.alive >= fam.limit) return -1;
    const i = fam.free[--fam.freeTop];
    fam.alive++;
    const i3 = i * 3;
    fam.pos[i3] = x; fam.pos[i3 + 1] = y; fam.pos[i3 + 2] = z;
    fam.vel[i3] = vx; fam.vel[i3 + 1] = vy; fam.vel[i3 + 2] = vz;
    fam.size0[i] = sizeA;
    fam.size1[i] = sizeB;
    fam.alpha0[i] = alpha;
    fam.life[i] = lifeSeconds;
    fam.lifeMax[i] = lifeSeconds;
    fam.spin[i] = rotSpeed;
    if (tintHex !== undefined) {
      _col.set(tintHex);
      fam.tint[i3] = _col.r; fam.tint[i3 + 1] = _col.g; fam.tint[i3 + 2] = _col.b;
    } else {
      fam.tint[i3] = 1; fam.tint[i3 + 1] = 1; fam.tint[i3 + 2] = 1;
    }
    // write the first frame immediately so a recycled slot never shows the
    // previous particle's position
    const aSize = fam.geo.attributes.aSize;
    const aAlpha = fam.geo.attributes.aAlpha;
    const aRot = fam.geo.attributes.aRot;
    const aLife = fam.geo.attributes.aLife;
    const aTint = fam.geo.attributes.aTint;
    aSize.array[i] = sizeA;
    aAlpha.array[i] = 0;
    aRot.array[i] = rot0;
    aLife.array[i] = 0;
    aTint.array[i3] = fam.tint[i3];
    aTint.array[i3 + 1] = fam.tint[i3 + 1];
    aTint.array[i3 + 2] = fam.tint[i3 + 2];
    return i;
  }

  function kill(fam, i) {
    const i3 = i * 3;
    fam.pos[i3 + 1] = PARKED_Y;
    fam.geo.attributes.position.array[i3 + 1] = PARKED_Y;
    fam.geo.attributes.aAlpha.array[i] = 0;
    fam.geo.attributes.aSize.array[i] = 0;
    fam.geo.attributes.aLife.array[i] = 0;
    fam.life[i] = 0;
    fam.free[fam.freeTop++] = i;
    fam.alive--;
  }

  // -------------------------------------------------------------------------
  // Ambient emitters - driven by hour, wind and where the player is
  // -------------------------------------------------------------------------

  let moteAcc = 0;
  let leafAcc = 0;
  let sprayAcc = 0;
  let mistAcc = 0;

  const emitters = [];

  function registerEmitter(x, y, z, type, rate) {
    if (emitters.length >= MAX_EMITTERS) return;
    if (!(typeof x === 'number' && typeof y === 'number' && typeof z === 'number')) return;
    emitters.push({
      x, y, z,
      type: type || 'smoke',
      rate: typeof rate === 'number' && rate > 0 ? Math.min(rate, 20) : 1,
      acc: 0,
    });
    stats.emitters = emitters.length;
  }

  /** True while the player is under the west forest / pinewood canopy. */
  function inForest(x, z, margin) {
    for (const id of ['forest', 'pineForest']) {
      const p = layout.pois[id];
      const dx = x - p.position.x, dz = z - p.position.z;
      const r = p.radius * (1 + margin);
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  function spawnMote(cx, cy, cz, windX, windZ) {
    const fam = famById.dust;
    const x = cx + rng.range(-26, 26);
    const y = cy + rng.range(-5, 12);
    const z = cz + rng.range(-26, 26);
    spawn(fam, x, y, z,
      windX * 0.35 + rng.range(-0.1, 0.1), rng.range(-0.05, 0.12), windZ * 0.35 + rng.range(-0.1, 0.1),
      rng.range(0.05, 0.12), rng.range(0.05, 0.12), rng.range(6, 14),
      rng.range(0.3, 0.65), rng.float() * TAU, rng.range(-0.4, 0.4));
  }

  function spawnLeaf(player, windX, windZ) {
    const fam = famById.leaf;
    const x = player.x + rng.range(-24, 24);
    const z = player.z + rng.range(-24, 24);
    const y = layout.heightAt(x, z) + rng.range(9, 20);
    spawn(fam, x, y, z,
      windX * (0.9 + rng.float()) + rng.range(-0.3, 0.3), rng.range(-0.35, 0.1), windZ * (0.9 + rng.float()) + rng.range(-0.3, 0.3),
      rng.range(0.16, 0.3), rng.range(0.16, 0.3), rng.range(6, 11),
      rng.range(0.7, 1.0), rng.float() * TAU, rng.range(-3.5, 3.5), '#8fbf5e');
  }

  function spawnSpray(player, windX, windZ) {
    const fam = famById.spray;
    const theta = Math.atan2(player.z, player.x) + rng.range(-0.05, 0.05);
    const r = layout.coastRadius(theta) + rng.range(-6, 10);
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const inward = 1 + rng.float() * 3.5 + Math.hypot(windX, windZ) * 3;
    spawn(fam, x, rng.range(0.4, 4), z,
      -Math.cos(theta) * inward + windX * 1.4, rng.range(2.4, 5.6), -Math.sin(theta) * inward + windZ * 1.4,
      rng.range(0.2, 0.55), rng.range(0.35, 0.9), rng.range(1.1, 2.6),
      rng.range(0.35, 0.7), rng.float() * TAU, rng.range(-1.5, 1.5));
  }

  function spawnMist(windX, windZ) {
    const fam = famById.smoke;
    const a = rng.float() * TAU;
    const r = Math.sqrt(rng.float()) * layout.lake.radius * 0.95;
    const x = layout.lake.center.x + Math.cos(a) * r;
    const z = layout.lake.center.z + Math.sin(a) * r;
    spawn(fam, x, layout.lakeY + rng.range(0.1, 1.4), z,
      windX * 0.5 + rng.range(-0.2, 0.2), rng.range(0.1, 0.4), windZ * 0.5 + rng.range(-0.2, 0.2),
      rng.range(3.5, 7.5), rng.range(9, 16), rng.range(5, 9),
      rng.range(0.07, 0.16), rng.float() * TAU, rng.range(-0.12, 0.12));
  }

  // -------------------------------------------------------------------------
  // Event bursts - called by gameplay code at any time
  // -------------------------------------------------------------------------

  function burstDust(x, y, z, dirX, dirZ, strength) {
    const fam = famById.dust;
    const s = clamp01(typeof strength === 'number' ? strength : 0.5);
    const count = 5 + Math.round(9 * s);
    const bx = typeof dirX === 'number' ? dirX : 0;
    const bz = typeof dirZ === 'number' ? dirZ : 0;
    for (let i = 0; i < count; i++) {
      const a = Math.atan2(bx, bz) + rng.range(-0.85, 0.85);
      const sp = (1.1 + rng.float() * 2.6) * (0.5 + s);
      spawn(fam, x + rng.range(-0.3, 0.3), y + rng.range(0, 0.4), z + rng.range(-0.3, 0.3),
        Math.sin(a) * sp, rng.range(0.5, 2.2), Math.cos(a) * sp,
        rng.range(0.22, 0.5), rng.range(0.7, 1.5), rng.range(0.5, 1.3),
        rng.range(0.35, 0.7), rng.float() * TAU, rng.range(-2, 2), '#d9c49a');
    }
    stats.bursts++;
  }

  function burstSplash(x, y, z, strength) {
    const fam = famById.spray;
    const s = clamp01(typeof strength === 'number' ? strength : 0.5);
    const count = 8 + Math.round(14 * s);
    for (let i = 0; i < count; i++) {
      const a = rng.float() * TAU;
      const out = rng.range(0.4, 2.2) * (0.6 + s);
      spawn(fam, x + Math.cos(a) * 0.2, y + 0.1, z + Math.sin(a) * 0.2,
        Math.cos(a) * out, rng.range(2.2, 5.2) * (0.6 + s), Math.sin(a) * out,
        rng.range(0.16, 0.5), rng.range(0.3, 1.1), rng.range(0.5, 1.5),
        rng.range(0.55, 0.95), rng.float() * TAU, rng.range(-2, 2));
    }
    stats.bursts++;
  }

  function burstLeaves(x, y, z) {
    const fam = famById.leaf;
    for (let i = 0; i < 14; i++) {
      const a = rng.float() * TAU;
      const sp = rng.range(0.6, 2.4);
      spawn(fam, x + rng.range(-0.4, 0.4), y + rng.range(0, 1), z + rng.range(-0.4, 0.4),
        Math.cos(a) * sp, rng.range(1.2, 3.4), Math.sin(a) * sp,
        rng.range(0.18, 0.3), rng.range(0.18, 0.3), rng.range(2.4, 4.6),
        rng.range(0.8, 1.0), rng.float() * TAU, rng.range(-5, 5),
        rng.pick(['#8fbf5e', '#c9b26a', '#6f9e4a']));
    }
    stats.bursts++;
  }

  function burstSparkle(x, y, z, count) {
    const fam = famById.spark;
    const n = clamp(Math.round(typeof count === 'number' ? count : 12), 1, 64);
    for (let i = 0; i < n; i++) {
      const a = rng.float() * TAU;
      const sp = rng.range(0.3, 1.8);
      spawn(fam, x + rng.range(-0.3, 0.3), y + rng.range(-0.2, 0.5), z + rng.range(-0.3, 0.3),
        Math.cos(a) * sp, rng.range(0.5, 2.3), Math.sin(a) * sp,
        rng.range(0.08, 0.22), rng.range(0.02, 0.08), rng.range(0.5, 1.3),
        rng.range(0.7, 1.0), rng.float() * TAU, rng.range(-4, 4));
    }
    stats.bursts++;
  }

  function burstConfetti(x, y, z) {
    const fam = famById.confetti;
    for (let i = 0; i < 20; i++) {
      const a = rng.float() * TAU;
      const sp = rng.range(0.8, 3.2);
      spawn(fam, x + rng.range(-0.5, 0.5), y + rng.range(0, 1.2), z + rng.range(-0.5, 0.5),
        Math.cos(a) * sp, rng.range(2.2, 4.6), Math.sin(a) * sp,
        rng.range(0.1, 0.2), rng.range(0.1, 0.2), rng.range(2.6, 4.4),
        1.0, rng.float() * TAU, rng.range(-8, 8),
        rng.pick(['#e0523f', '#f2e8d5', '#1f6f78', '#e8b64c', '#5b7fd4']));
    }
    stats.bursts++;
  }

  function burstSmoke(x, y, z) {
    const fam = famById.smoke;
    for (let i = 0; i < 6; i++) {
      spawn(fam, x + rng.range(-0.3, 0.3), y + rng.range(0, 0.3), z + rng.range(-0.3, 0.3),
        rng.range(-0.4, 0.4), rng.range(0.8, 1.6), rng.range(-0.4, 0.4),
        rng.range(0.5, 1.0), rng.range(2.2, 3.6), rng.range(2.5, 4.5),
        rng.range(0.3, 0.5), rng.float() * TAU, rng.range(-0.5, 0.5));
    }
    stats.bursts++;
  }

  // -------------------------------------------------------------------------
  // Emitter + ambient processing (allocation free)
  // -------------------------------------------------------------------------

  function processEmitters(dt, windX, windZ) {
    const smoke = famById.smoke;
    const spark = famById.spark;
    const scale = 1;
    for (let e = 0; e < emitters.length; e++) {
      const em = emitters[e];
      em.acc += em.rate * dt * scale;
      let n = em.acc >= 1 ? Math.min(4, Math.floor(em.acc)) : 0;
      em.acc -= n;
      while (n-- > 0) {
        if (em.type === 'fire') {
          // embers (additive) with a warm drift, plus the occasional smoke wisp
          spawn(spark, em.x + rng.range(-0.35, 0.35), em.y + rng.range(0, 0.4), em.z + rng.range(-0.35, 0.35),
            windX * 0.5 + rng.range(-0.5, 0.5), rng.range(1.4, 2.8), windZ * 0.5 + rng.range(-0.5, 0.5),
            rng.range(0.05, 0.14), rng.range(0.01, 0.05), rng.range(0.7, 1.6),
            rng.range(0.7, 1.0), rng.float() * TAU, rng.range(-6, 6), '#ff9d4a');
          if (rng.chance(0.35)) {
            spawn(smoke, em.x + rng.range(-0.2, 0.2), em.y + 0.5, em.z + rng.range(-0.2, 0.2),
              windX * 0.6 + rng.range(-0.2, 0.2), rng.range(0.6, 1.2), windZ * 0.6 + rng.range(-0.2, 0.2),
              rng.range(0.3, 0.7), rng.range(1.6, 2.8), rng.range(1.6, 3.2),
              rng.range(0.18, 0.34), rng.float() * TAU, rng.range(-0.4, 0.4), '#8a7f76');
          }
        } else if (em.type === 'mist') {
          spawn(smoke, em.x + rng.range(-1.2, 1.2), em.y + rng.range(0, 1.2), em.z + rng.range(-1.2, 1.2),
            windX * 0.4 + rng.range(-0.4, 0.4), rng.range(0.2, 0.7), windZ * 0.4 + rng.range(-0.4, 0.4),
            rng.range(2.5, 5.5), rng.range(7, 13), rng.range(3.5, 7),
            rng.range(0.08, 0.18), rng.float() * TAU, rng.range(-0.2, 0.2));
        } else {
          // chimney smoke - small, warm at the source and cooler as it climbs
          spawn(smoke, em.x + rng.range(-0.25, 0.25), em.y + rng.range(0, 0.25), em.z + rng.range(-0.25, 0.25),
            windX * 0.7 + rng.range(-0.25, 0.25), rng.range(0.7, 1.4), windZ * 0.7 + rng.range(-0.25, 0.25),
            rng.range(0.4, 0.8), rng.range(1.8, 3.2), rng.range(2.8, 5.2),
            rng.range(0.16, 0.3), rng.float() * TAU, rng.range(-0.5, 0.5), '#b8b2ac');
        }
      }
    }
  }

  function processAmbient(dt, player, camera, windX, windZ, windStrength, hour, rain, photoMode) {
    const scale = famScale;
    const camX = camera ? camera.x : player.x;
    const camZ = camera ? camera.z : player.z;
    const camY = camera ? camera.y : player.y + 4;

    // pollen / dust motes in sunlight (strongest 16-19h)
    let moteRate = 0;
    if (hour > 6 && hour < 20 && rain < 0.5) {
      const rise = smoothstep(6, 10, hour);
      const peak = 0.35 + 0.65 * smoothstep(14.5, 18, hour) * (1 - smoothstep(18.8, 20, hour));
      moteRate = (3 + 20 * peak) * rise * (1 - rain);
    }
    moteAcc += moteRate * scale * dt;
    let n = Math.min(6, Math.floor(moteAcc));
    moteAcc -= n;
    while (n-- > 0) spawnMote(camX, camY + (photoMode ? 3 : -1), camZ, windX, windZ);

    // falling leaves under the forest canopies
    let leafRate = 0;
    if (inForest(player.x, player.z, 0.05) && rain < 0.6) {
      leafRate = (2.5 + 5 * clamp01(windStrength)) * (1 - rain * 0.5);
    }
    leafAcc += leafRate * scale * dt;
    n = Math.min(4, Math.floor(leafAcc));
    leafAcc -= n;
    while (n-- > 0) spawnLeaf(player, windX, windZ);

    // sea spray off the west cliffs in strong wind
    const shore = layout.shoreDistance(player.x, player.z);
    let sprayRate = 0;
    if (windStrength > 0.42 && player.x < -500 && shore > -200 && shore < 30) {
      sprayRate = 30 * (windStrength - 0.4);
    }
    sprayAcc += sprayRate * scale * dt;
    n = Math.min(6, Math.floor(sprayAcc));
    sprayAcc -= n;
    while (n-- > 0) spawnSpray(player, windX, windZ);

    // lake mist at dawn (5-8h)
    let mistRate = 0;
    if (hour > 4.6 && hour < 8.4) {
      const dx = player.x - layout.lake.center.x;
      const dz = player.z - layout.lake.center.z;
      const d = Math.hypot(dx, dz);
      if (d < 520) mistRate = 7 * (1 - d / 620) * (1 - rain * 0.4);
    }
    mistAcc += mistRate * scale * dt;
    n = Math.min(4, Math.floor(mistAcc));
    mistAcc -= n;
    while (n-- > 0) spawnMist(windX, windZ);
  }

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------

  function updateFamily(fam, dt, windX, windZ) {
    const def = fam.def;
    const pos = fam.pos;
    const vel = fam.vel;
    const aPos = fam.geo.attributes.position.array;
    const aSize = fam.geo.attributes.aSize.array;
    const aAlpha = fam.geo.attributes.aAlpha.array;
    const aRot = fam.geo.attributes.aRot.array;
    const aLife = fam.geo.attributes.aLife.array;
    const dragF = clamp(1 - def.drag * dt, 0, 1);
    const windGain = def.wind;
    const gravity = def.gravity;

    for (let i = 0; i < fam.cap; i++) {
      let life = fam.life[i];
      if (life <= 0) continue;
      life -= dt;
      if (life <= 0) { kill(fam, i); continue; }
      fam.life[i] = life;

      const i3 = i * 3;
      let vx = vel[i3] * dragF + windX * windGain * dt;
      let vy = vel[i3 + 1] * dragF + gravity * dt;
      let vz = vel[i3 + 2] * dragF + windZ * windGain * dt;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;

      const x = pos[i3] + vx * dt;
      const y = pos[i3 + 1] + vy * dt;
      const z = pos[i3 + 2] + vz * dt;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      aPos[i3] = x; aPos[i3 + 1] = y; aPos[i3 + 2] = z;

      const t = 1 - life / fam.lifeMax[i];
      const env = smoothstep(0, 0.12, t) * (1 - smoothstep(0.5, 1, t));
      aSize[i] = lerp(fam.size0[i], fam.size1[i], t) * (env > 0 ? 1 : 0.001);
      aAlpha[i] = fam.alpha0[i] * env;
      aRot[i] += fam.spin[i] * dt;
      aLife[i] = t;
    }
    fam.points.visible = fam.alive > 0;
    if (fam.alive > 0) {
      fam.geo.attributes.position.needsUpdate = true;
      fam.geo.attributes.aSize.needsUpdate = true;
      fam.geo.attributes.aAlpha.needsUpdate = true;
      fam.geo.attributes.aRot.needsUpdate = true;
      fam.geo.attributes.aLife.needsUpdate = true;
      fam.geo.attributes.aTint.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Quality / pool scaling
  // -------------------------------------------------------------------------

  let famScale = 1;
  let pointScale = 420;

  function currentPool() {
    const raw = typeof preset.particleScale === 'number' && preset.particleScale > 0 ? preset.particleScale : 1;
    return Math.max(MIN_POOL, Math.round(BASE_POOL * raw));
  }

  function applyQuality() {
    const pool = currentPool();
    famScale = pool / BASE_POOL;
    let liveCap = 0;
    for (const fam of families) {
      fam.limit = Math.max(8, Math.round(pool * fam.def.weight));
      liveCap += fam.limit;
      // a family can never hold more live particles than its slice of the pool
      if (fam.alive > fam.limit) {
        for (let i = 0; i < fam.cap && fam.alive > fam.limit; i++) {
          if (fam.life[i] > 0) kill(fam, i);
        }
      }
    }
    stats.total = capacityPool;
    stats.budget = pool;
    stats.limit = liveCap;
    stats.drawCalls = group.children.length;
  }

  function setQuality(level) {
    const next = QUALITY_PRESETS[level];
    if (next) Object.assign(preset, next);
    applyQuality();
  }

  if (bus && typeof bus.on === 'function') {
    bus.on('quality:changed', (payload) => setQuality((payload && payload.level) || qualityLevel));
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  function update(dt, state) {
    let step = dt;
    if (!(step > 0)) step = 0;
    else if (step > 0.1) step = 0.1;
    if (step <= 0) return;

    const st = state || null;
    const player = (st && st.player && st.player.position) || _v.set(0, 0, 0);
    const camera = st && st.camera ? st.camera.position : null;
    const wind = st && st.wind;
    const windX = wind && typeof wind.x === 'number' ? wind.x : 0.7;
    const windZ = wind && typeof wind.z === 'number' ? wind.z : 0.5;
    const windStrength = wind && typeof wind.strength === 'number' ? wind.strength : 0.4;
    const hour = st && typeof st.hour === 'number' ? (((st.hour % 24) + 24) % 24) : 12;
    const rain = st && st.weather && typeof st.weather.rain === 'number' ? st.weather.rain : 0;
    debug.hour = hour;

    if (engine && engine.sizes) {
      const h = (engine.sizes.height || 720) * (engine.sizes.pixelRatio || 1);
      pointScale = h * 0.5;
    }

    // spawn first so a brand new particle is integrated in the same frame
    processEmitters(step, windX, windZ);
    processAmbient(step, player, camera, windX, windZ, windStrength, hour, rain, !!(st && st.photoMode));

    let alive = 0;
    for (const fam of families) {
      updateFamily(fam, step, windX, windZ);
      fam.mat.uniforms.uScale.value = pointScale;
      stats[fam.id] = fam.alive;
      alive += fam.alive;
    }
    stats.alive = alive;
  }

  applyQuality();
  for (const fam of families) fam.points.visible = false;

  return {
    group,
    update,
    setQuality,
    stats,
    debug,
    registerEmitter,
    bursts: {
      dust: burstDust,
      waterSplash: burstSplash,
      leaves: burstLeaves,
      sparkle: burstSparkle,
      confetti: burstConfetti,
      smokePuff: burstSmoke,
    },
  };
}
