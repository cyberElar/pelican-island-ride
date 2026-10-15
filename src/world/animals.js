/**
 * animals.js - the island's wildlife.
 *
 * Every species is a small set of baked, vertex-coloured part geometries drawn
 * with one InstancedMesh per animated part: a twelve-bird gull flock costs
 * three draw calls, the whole module roughly thirty. update() writes instance
 * matrices only for the animals inside the species' active radius and never
 * allocates.
 *
 * Behaviour: gulls (flap & glide, landing), lake/river ducks (ripples, dives),
 * herons (head sway, rare hop), road rabbits (hops, flee), forest deer (graze,
 * freeze, trot), beach crabs (sideways scuttle, sand-sink), butterflies, bees,
 * fireflies, jumping fish, one offshore whale and three bay dolphins.
 *
 * Determinism: everything derives from new Rng('animals:' + layout.seed).
 *
 * See docs/SPEC.md sections 4.12 / 6 for the frozen contracts.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng, TAU, clamp, clamp01, lerp, damp, angleDamp, smootherstep } from '../core/utils.js';
import { QUALITY_PRESETS } from '../core/settings.js';

// ---------------------------------------------------------------------------
// Module scratch - update() must never allocate
// ---------------------------------------------------------------------------

const _rootM = new THREE.Matrix4();
const _partM = new THREE.Matrix4();
const _outM = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const _origin = new THREE.Vector3();
const _roadPt = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 1 };
const _spot = { x: 0, y: 0, z: 0 };

/** Preset animalScale span the instance buffers are sized for. */
const MAX_SCALE = 1.3;
const FIREFLY_BASE = 120;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const sphere = (r, w = 9, h = 7) => new THREE.SphereGeometry(r, w, h);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cone = (r, h, seg = 7) => new THREE.ConeGeometry(r, h, seg);
const cyl = (rt, rb, h, seg = 7) => new THREE.CylinderGeometry(rt, rb, h, seg);

/** Apply a { pos, rot, scale } transform to a geometry. */
function place(geo, p) {
  const rot = p.rot;
  _eul.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0, 'XYZ');
  _partM.makeRotationFromEuler(_eul);
  const sc = p.scale;
  _partM.scale(_scl.set(sc ? sc[0] : 1, sc ? sc[1] : 1, sc ? sc[2] : 1));
  const pos = p.pos;
  if (pos) _partM.setPosition(pos[0], pos[1], pos[2]);
  geo.applyMatrix4(_partM);
  return geo;
}

/** Flat per-vertex colour (THREE.Color converts sRGB hex to working space). */
function paint(geo, hex) {
  _col.set(hex);
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = _col.r;
    c[i * 3 + 1] = _col.g;
    c[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Bake a part list into one merged, vertex-coloured geometry. */
function bakeParts(parts) {
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const src = p.geo;
    const g = src.index ? src.toNonIndexed() : src.clone();
    if (g !== src) src.dispose();
    place(g, p);
    paint(g, p.color || '#ffffff');
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (g.attributes.tangent) g.deleteAttribute('tangent');
    list.push(g);
  }
  if (list.length === 1) return list[0];
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return merged;
}

/** Mirror a part list across x = 0 (wing halves). */
function mirrorParts(parts) {
  const out = [];
  for (const p of parts) {
    const q = { geo: p.geo.clone(), color: p.color };
    if (p.pos) q.pos = [-p.pos[0], p.pos[1], p.pos[2]];
    if (p.rot) q.rot = [p.rot[0], -p.rot[1], -p.rot[2]];
    if (p.scale) q.scale = [p.scale[0], p.scale[1], p.scale[2]];
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createAnimals(ctx) {
  const layout = ctx.layout;
  const textures = ctx.textures || {};
  const engine = ctx.engine || null;
  const bus = ctx.bus || null;
  const qualityLevel = (engine && engine.qualityLevel) || ctx.quality || 'high';
  const preset = Object.assign({}, (engine && engine.preset) || QUALITY_PRESETS[qualityLevel] || QUALITY_PRESETS.high);
  const rng = new Rng('animals:' + layout.seed);

  const pois = layout.pois;
  const LAKE = layout.lake;
  const LAKE_Y = layout.lakeY;

  const group = new THREE.Group();
  group.name = 'animals';

  const stats = { total: 0, active: 0, drawCalls: 0, triangles: 0 };
  const debug = {
    fireflyVisible: 0, butterflyVisible: 0, beeVisible: 0,
    night: false, hour: 12,
    /** First flower-meadow cluster - handy for tests and photo mode. */
    butterflyAnchor: { x: 0, y: 0, z: 0 },
  };
  const species = [];
  let time = 0;

  // -------------------------------------------------------------------------
  // Shared materials
  // -------------------------------------------------------------------------

  const animalMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0,
  });

  /** Tiny 2-colour alpha wing canvas for the butterflies (null when headless). */
  const wingTexture = (() => {
    const size = 64;
    if (typeof textures.canvas !== 'function') return null;
    const canvas = textures.canvas(size);
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const c2d = canvas.getContext('2d');
    if (!c2d) return null;                       // no DOM / null 2D context
    c2d.clearRect(0, 0, size, size);
    c2d.fillStyle = '#e8a33c';                   // fore wing
    c2d.beginPath();
    c2d.ellipse(size * 0.42, size * 0.34, size * 0.34, size * 0.26, -0.25, 0, TAU);
    c2d.fill();
    c2d.fillStyle = '#5b3a2a';                   // hind wing
    c2d.beginPath();
    c2d.ellipse(size * 0.5, size * 0.72, size * 0.28, size * 0.24, 0.2, 0, TAU);
    c2d.fill();
    c2d.strokeStyle = '#3a2c22';
    c2d.lineWidth = size * 0.05;
    c2d.stroke();
    if (typeof textures.texture !== 'function') return null;
    const tex = textures.texture(canvas, { wrap: THREE.ClampToEdgeWrapping, repeat: 1 });
    return tex && tex.isTexture ? tex : null;
  })();

  const wingMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: wingTexture, transparent: !!wingTexture,
    alphaTest: wingTexture ? 0.45 : 0, side: THREE.DoubleSide,
    roughness: 0.8, metalness: 0,
  });

  const rippleMat = new THREE.MeshBasicMaterial({
    color: 0xdff6f7, transparent: true, opacity: 0.3,
    depthWrite: false, side: THREE.DoubleSide,
  });

  // -------------------------------------------------------------------------
  // Species plumbing
  // -------------------------------------------------------------------------

  function addSpecies(id, def) {
    const capacity = Math.max(def.min || 1, Math.ceil(def.base * MAX_SCALE));
    // the record list is the real population cap: quality scales the count
    // down at low/medium and back up to this number at high/ultra
    const maxCount = Math.min(capacity, def.list.length || def.base);
    const sp = {
      id, base: def.base, min: def.min || 1, radius: def.radius, baseRadius: def.radius,
      capacity, maxCount, count: 0, near: 0,
      parts: def.parts, meshes: [], list: def.list, castShadow: !!def.castShadow,
    };
    for (let i = 0; i < def.parts.length; i++) {
      const mesh = new THREE.InstancedMesh(def.parts[i].geo, def.parts[i].mat || animalMat, capacity);
      mesh.name = `animal:${id}:${i}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;              // instances move every frame
      mesh.castShadow = sp.castShadow && !!preset.shadows;
      mesh.receiveShadow = false;
      mesh.count = 0;
      mesh.visible = false;
      group.add(mesh);
      sp.meshes.push(mesh);
    }
    species.push(sp);
    return sp;
  }

  function writeAtRoot(sp, part, i) {
    sp.meshes[part].setMatrixAt(i, _rootM);
  }

  function writePart(sp, part, i, px, py, pz, rx, ry, rz, sx, sy, sz) {
    _eul.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _quat.setFromEuler(_eul);
    _partM.compose(_v.set(px, py, pz), _quat, _scl.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz));
    _outM.multiplyMatrices(_rootM, _partM);
    sp.meshes[part].setMatrixAt(i, _outM);
  }

  function rootAt(x, y, z, yaw, pitch, roll, s) {
    _eul.set(pitch || 0, yaw || 0, roll || 0, 'YXZ');
    _quat.setFromEuler(_eul);
    const k = s === undefined ? 1 : s;
    _rootM.compose(_v.set(x, y, z), _quat, _scl.set(k, k, k));
  }

  // -------------------------------------------------------------------------
  // Placement helpers
  // -------------------------------------------------------------------------

  /** Random meadow point beside the ring road. */
  function meadowNearRoad(rng2, minD, maxD) {
    for (let i = 0; i < 60; i++) {
      const p = layout.roadPoint(rng2.float(), _roadPt);
      const side = i % 2 === 0 ? 1 : -1;
      const d = lerp(minD, maxD, rng2.float());
      const x = p.x - p.dirZ * d * side;
      const z = p.z + p.dirX * d * side;
      if (layout.biomeAt(x, z) !== 'meadow') continue;
      _spot.x = x; _spot.z = z; _spot.y = layout.heightAt(x, z);
      return true;
    }
    return false;
  }

  /** Random dry sand point on any beach (crabs). */
  function beachSpot(rng2) {
    for (let i = 0; i < 90; i++) {
      const theta = rng2.float() * TAU;
      const r = layout.coastRadius(theta) - rng2.range(3, 28);
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;
      if (layout.waterDepth(x, z) > 0.1) continue;
      const h = layout.heightAt(x, z);
      if (h < 0.6 || h > 7) continue;
      if (layout.biomeAt(x, z) !== 'beach') continue;
      _spot.x = x; _spot.z = z; _spot.y = h;
      return true;
    }
    return false;
  }

  /** Random gentle spot on the lake shore (herons). */
  function lakeShoreSpot(rng2) {
    // Two passes: a strict shoreline ring, then a relaxed one - the lake sits
    // on a hillside, so the exact rim height varies a lot around the basin.
    for (let pass = 0; pass < 2; pass++) {
      const maxH = pass === 0 ? LAKE_Y + 12 : LAKE_Y + 26;
      const maxSlope = pass === 0 ? 0.34 : 0.5;
      for (let i = 0; i < 90; i++) {
        const a = rng2.float() * TAU;
        const r = LAKE.radius * rng2.range(0.98, pass === 0 ? 1.2 : 1.4);
        const x = LAKE.center.x + Math.cos(a) * r;
        const z = LAKE.center.z + Math.sin(a) * r;
        if (layout.waterDepth(x, z) > 0) continue;
        const h = layout.heightAt(x, z);
        if (h < LAKE_Y - 1.0 || h > maxH) continue;
        if (layout.slopeAt(x, z) > maxSlope) continue;
        _spot.x = x; _spot.z = z; _spot.y = h;
        return true;
      }
    }
    return false;
  }

  /** Random spot on the west-forest rim (deer). */
  function forestEdgeSpot(rng2) {
    const f = pois.forest;
    for (let i = 0; i < 90; i++) {
      const a = rng2.float() * TAU;
      const r = f.radius * rng2.range(0.8, 1.0);
      const x = f.position.x + Math.cos(a) * r;
      const z = f.position.z + Math.sin(a) * r;
      if (layout.waterDepth(x, z) > 0) continue;
      if (layout.slopeAt(x, z) > 0.42) continue;
      const b = layout.biomeAt(x, z);
      if (b !== 'forest' && b !== 'meadow') continue;
      _spot.x = x; _spot.z = z; _spot.y = layout.heightAt(x, z);
      return true;
    }
    return false;
  }

  /** A point in water at least `depth` m deep, `spread` m from (x, z). */
  function waterSpot(rng2, x, z, spread, depth) {
    for (let i = 0; i < 60; i++) {
      const a = rng2.float() * TAU;
      const r = Math.sqrt(rng2.float()) * spread;
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      if (layout.waterDepth(sx, sz) < depth) continue;
      _spot.x = sx; _spot.z = sz; _spot.y = Math.max(0, layout.heightAt(sx, sz));
      return true;
    }
    _spot.x = x; _spot.z = z; _spot.y = 0;
    return false;
  }

  // -------------------------------------------------------------------------
  // Ripples - own little instanced ring field (never touches ocean.js)
  // -------------------------------------------------------------------------

  const RIPPLE_CAP = 56;
  const rippleGeo = new THREE.RingGeometry(0.72, 1.0, 14, 1);
  rippleGeo.rotateX(-Math.PI / 2);
  const rippleMesh = new THREE.InstancedMesh(rippleGeo, rippleMat, RIPPLE_CAP);
  rippleMesh.name = 'animal:ripples';
  rippleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rippleMesh.frustumCulled = false;
  rippleMesh.count = RIPPLE_CAP;
  group.add(rippleMesh);
  const ripples = [];
  for (let i = 0; i < RIPPLE_CAP; i++) ripples.push({ x: 0, y: -9999, z: 0, age: 9, life: 1, grow: 1, parked: false });
  let rippleCursor = 0;

  function triggerRipple(x, y, z, grow) {
    const r = ripples[rippleCursor];
    rippleCursor = (rippleCursor + 1) % RIPPLE_CAP;
    r.x = x; r.y = y; r.z = z;
    r.age = 0;
    r.life = 1.15;
    r.grow = grow;
    r.parked = false;
  }

  function updateRipples(dt) {
    for (let i = 0; i < RIPPLE_CAP; i++) {
      const r = ripples[i];
      if (r.parked) continue;
      r.age += dt;
      if (r.age >= r.life) {
        r.parked = true;
        _scl.set(0, 0, 0);
        _rootM.compose(_v.set(0, -999, 0), _quat.identity(), _scl);
        rippleMesh.setMatrixAt(i, _rootM);
        continue;
      }
      const t = r.age / r.life;
      const s = r.grow * (0.28 + t * 1.65) * (1 - 0.22 * t * t);
      rootAt(r.x, r.y, r.z, 0, 0, 0, s);
      rippleMesh.setMatrixAt(i, _rootM);
    }
    rippleMesh.instanceMatrix.needsUpdate = true;
  }

  // =========================================================================
  // SEAGULLS - flap-and-glide flocks around the NE cliffs, harbour, lighthouse
  // =========================================================================

  const gullHull = bakeParts([
    { geo: sphere(0.17, 10, 7), color: '#f5f1e8', pos: [0, 0.02, 0], scale: [1.55, 0.92, 1.0] },
    { geo: sphere(0.095, 8, 6), color: '#f7f4ec', pos: [0, 0.11, 0.21] },
    { geo: cone(0.035, 0.17, 6), color: '#f2a33c', pos: [0, 0.105, 0.36], rot: [Math.PI / 2, 0, 0] },
    { geo: cone(0.085, 0.24, 6), color: '#e2ded2', pos: [0, 0.015, -0.30], rot: [-Math.PI / 2, 0, 0], scale: [1, 1, 0.4] },
  ]);
  const gullWingParts = [
    { geo: box(0.30, 0.026, 0.17), color: '#f7f4ec', pos: [0.16, 0, 0] },
    { geo: box(0.28, 0.022, 0.12), color: '#4a4d52', pos: [0.44, 0, -0.01] },
  ];
  const gullWingRParts = mirrorParts(gullWingParts);
  const gullWingL = bakeParts(gullWingParts);
  const gullWingR = bakeParts(gullWingRParts);

  const gullPerches = [];
  {
    const lh = pois.lighthouse.position;
    gullPerches.push({ x: lh.x + 3.5, y: lh.y + 12, z: lh.z + 2.0 });
    gullPerches.push({ x: lh.x - 8, y: layout.heightAt(lh.x - 8, lh.z + 10) + 1.2, z: lh.z + 10 });
    const hb = pois.harbor.position;
    gullPerches.push({ x: hb.x + 6, y: layout.heightAt(hb.x + 6, hb.z + 9) + 1.8, z: hb.z + 9 });
    const vg = pois.village.position;
    gullPerches.push({ x: vg.x + 5, y: layout.heightAt(vg.x + 5, vg.z - 4) + 7.5, z: vg.z - 4 });
  }

  const gullList = [];
  {
    const flocks = [
      { x: pois.lighthouse.position.x - 40, z: pois.lighthouse.position.z + 70, rMin: 55, rMax: 150 },
      { x: pois.harbor.position.x - 25, z: pois.harbor.position.z + 45, rMin: 45, rMax: 125 },
    ];
    const count = Math.max(7, Math.ceil(12 * MAX_SCALE));
    const split = Math.round(count * (7 / 12));
    for (let i = 0; i < count; i++) {
      const f = flocks[i < split ? 0 : 1];
      const r = rng.range(f.rMin, f.rMax);
      const ang = rng.float() * TAU;
      gullList.push({
        cx: f.x, cz: f.z, r, ang,
        homeX: f.x, homeZ: f.z,
        angSpeed: rng.sign() * rng.range(0.045, 0.09),
        alt: rng.range(16, 56),
        phase: rng.float() * TAU,
        glidePhase: rng.float() * TAU,
        flapPhase: rng.float() * TAU,
        flapRate: rng.range(5.2, 7.0),
        scale: rng.range(0.92, 1.14),
        x: f.x + Math.cos(ang) * r, y: 40, z: f.z + Math.sin(ang) * r,
        py: 0, yaw: 0, pitch: 0, roll: 0,
        st: 0, timer: rng.range(25, 150), perch: rng.irange(0, gullPerches.length - 1),
        tx: 0, ty: 0, tz: 0, restT: 0,
      });
    }
  }

  const S = {};
  S.gull = addSpecies('gulls', {
    base: 12, radius: 520, castShadow: true, list: gullList,
    parts: [{ geo: gullHull }, { geo: gullWingL }, { geo: gullWingR }],
  });

  function updateGulls(dt, px, pz) {
    const sp = S.gull;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const g = gullList[i];
      const dx = g.x - px, dz = g.z - pz;
      if (dx * dx + dz * dz > sp.radius * sp.radius) continue;
      near++;
      let wing = 0.35;

      if (g.st === 0) {
        g.ang += g.angSpeed * dt;
        const nx = g.cx + Math.cos(g.ang) * g.r;
        const nz = g.cz + Math.sin(g.ang) * g.r;
        const ground = Math.max(0, layout.heightAt(nx, nz));
        const ty = ground + g.alt + Math.sin(time * 0.31 + g.phase) * 2.6;
        g.py = g.y;
        g.x = nx; g.z = nz;
        g.y = damp(g.y, ty, 0.75, dt);
        const sgn = g.angSpeed >= 0 ? 1 : -1;
        const targetYaw = Math.atan2(-Math.sin(g.ang) * sgn, Math.cos(g.ang) * sgn);
        g.yaw = angleDamp(g.yaw, targetYaw + Math.sin(time * 0.5 + g.phase) * 0.16, 2.6, dt);
        g.roll = angleDamp(g.roll, -0.52 * sgn + Math.sin(time * 0.8 + g.phase) * 0.1, 2.0, dt);
        g.pitch = damp(g.pitch, clamp((g.y - g.py) / Math.max(dt, 1e-3) * 0.035, -0.3, 0.3), 3.0, dt);
        const glide = 0.5 + 0.5 * Math.sin(time * 0.22 + g.glidePhase);
        const amp = 0.32 + 0.7 * clamp01(1 - glide);
        g.flapPhase += dt * g.flapRate;
        wing = Math.sin(g.flapPhase) * amp;
        g.timer -= dt;
        if (g.timer <= 0) {
          g.st = 1;
          g.perch = (g.perch + 1) % gullPerches.length;
          const p = gullPerches[g.perch];
          g.tx = p.x; g.ty = p.y; g.tz = p.z;
          g.timer = 20;
        }
      } else if (g.st === 1) {
        const p = gullPerches[g.perch];
        const dxp = p.x - g.x, dzp = p.z - g.z;
        const d = Math.hypot(dxp, dzp) || 1e-3;
        const step = Math.min(d, 7 * dt);
        g.x += (dxp / d) * step;
        g.z += (dzp / d) * step;
        g.y = damp(g.y, p.y + 0.35, 1.6, dt);
        g.yaw = angleDamp(g.yaw, Math.atan2(dxp, dzp), 3.2, dt);
        g.roll = angleDamp(g.roll, 0, 3, dt);
        g.pitch = angleDamp(g.pitch, -0.18, 3, dt);
        g.flapPhase += dt * g.flapRate * 0.75;
        wing = Math.sin(g.flapPhase) * 0.55 - 0.1;
        if (d < 1.4 && Math.abs(g.y - p.y) < 1.2) {
          g.st = 2;
          g.restT = 9 + 15 * (0.5 + 0.5 * Math.sin(i * 12.9898));
        }
      } else if (g.st === 2) {
        const p = gullPerches[g.perch];
        g.x = p.x; g.z = p.z;
        g.y = p.y + Math.sin(time * 1.1 + g.phase) * 0.03;
        g.roll = 0; g.pitch = 0;
        wing = 0.05 + Math.sin(time * 0.9 + g.phase) * 0.04;
        g.restT -= dt;
        if (g.restT <= 0) { g.st = 3; g.timer = 0; }
      } else {
        const p = gullPerches[g.perch];
        g.timer += dt;
        g.y += 4.2 * dt;
        g.flapPhase += dt * g.flapRate * 1.5;
        wing = Math.sin(g.flapPhase) * 0.85;
        g.x += Math.sin(g.yaw) * 2.2 * dt;
        g.z += Math.cos(g.yaw) * 2.2 * dt;
        g.pitch = angleDamp(g.pitch, 0.2, 2, dt);
        if (g.timer > 2.2 && g.y > p.y + 16) {
          g.st = 0;
          // take off again but stay anchored to the home flock area
          g.cx = lerp(g.homeX, p.x + rng.range(-40, 40), 0.35);
          g.cz = lerp(g.homeZ, p.z + rng.range(-40, 40), 0.35);
          g.r = rng.range(45, 130);
          g.ang = rng.float() * TAU;
          g.timer = rng.range(45, 150);
        }
      }

      rootAt(g.x, g.y, g.z, g.yaw, g.pitch, g.roll, g.scale);
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0.055, 0.055, 0.03, 0, 0, wing);
      writePart(sp, 2, i, -0.055, 0.055, 0.03, 0, 0, -wing, -1, 1, 1);
    }
    sp.meshes[0].instanceMatrix.needsUpdate = true;
    sp.meshes[1].instanceMatrix.needsUpdate = true;
    sp.meshes[2].instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // DUCKS - eight paddling the lake, two drifting down the river
  // =========================================================================

  const duckHull = bakeParts([
    { geo: sphere(0.15, 9, 6), color: '#3f5a4a', pos: [0, 0, 0], scale: [1.5, 0.9, 1.0] },
    { geo: cone(0.075, 0.22, 6), color: '#5d4a38', pos: [0, 0.03, -0.26], rot: [-Math.PI / 2, 0, 0], scale: [1, 1, 0.6] },
    { geo: box(0.34, 0.02, 0.14), color: '#5b6b62', pos: [0, 0.02, 0.06] },
  ]);
  const duckHeadParts = [
    { geo: cyl(0.045, 0.055, 0.13, 6), color: '#2f4a3d', pos: [0, 0.06, 0.01] },
    { geo: sphere(0.082, 8, 6), color: '#2f4a3d', pos: [0, 0.145, 0.01] },
    { geo: box(0.055, 0.03, 0.11), color: '#e8b64c', pos: [0, 0.125, 0.1] },
  ];
  const duckHead = bakeParts(duckHeadParts);

  const duckList = [];
  const riverLen = layout.riverCurve.getLength();
  {
    const total = Math.max(2, Math.ceil(10 * MAX_SCALE));
    const lakeCount = Math.max(1, Math.round(total * 0.8));   // 8 lake : 2 river
    const islet = pois.lakeIsland;
    for (let i = 0; i < lakeCount; i++) {
      const r = rng.range(18, 52);
      // fallback centre: open water on the far side of the islet
      let cx = LAKE.center.x + 60;
      let cz = LAKE.center.z - 60;
      // open water only: the circle must clear the lake islet and the shore
      for (let attempt = 0; attempt < 24; attempt++) {
        const a = rng.float() * TAU;
        const d = Math.sqrt(rng.float()) * 110;
        const tx = LAKE.center.x + Math.cos(a) * d;
        const tz = LAKE.center.z + Math.sin(a) * d;
        if (layout.waterDepth(tx, tz) < 1.2) continue;
        if (Math.hypot(tx - islet.position.x, tz - islet.position.z) < islet.radius + r + 14) continue;
        cx = tx; cz = tz;
        break;
      }
      duckList.push({
        kind: 0, cx, cz, r, ang: rng.float() * TAU,
        angSpeed: rng.sign() * rng.range(0.05, 0.12),
        bob: rng.float() * TAU,
        x: cx + Math.cos(rng.float() * TAU) * r, y: LAKE_Y, z: cz + Math.sin(rng.float() * TAU) * r,
        yaw: 0, scale: rng.range(0.9, 1.1),
        diveTimer: rng.range(8, 30), diving: false, diveT: 0,
        t: rng.range(0.55, 0.8), tDir: rng.chance(0.5) ? 1 : -1,
      });
    }
    for (let i = lakeCount; i < total; i++) {
      duckList.push({
        kind: 1, cx: 0, cz: 0, r: 0, ang: 0, angSpeed: 0,
        bob: rng.float() * TAU,
        x: 0, y: 0, z: 0, yaw: 0, scale: rng.range(0.9, 1.1),
        diveTimer: rng.range(10, 30), diving: false, diveT: 0,
        t: rng.range(0.35, 0.75), tDir: rng.chance(0.5) ? 1 : -1,
      });
    }
  }

  S.duck = addSpecies('ducks', {
    base: 10, radius: 300, list: duckList,
    parts: [{ geo: duckHull }, { geo: duckHead }],
  });

  /** Sample the river polyline at t in [0,1] into _spot (with water level). */
  function riverPoint(t, out) {
    const pts = layout.riverSamples;
    const n = pts.length / 2 - 1;
    const f = clamp01(t) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const u = f - i;
    out.x = lerp(pts[i * 2], pts[(i + 1) * 2], u);
    out.z = lerp(pts[i * 2 + 1], pts[(i + 1) * 2 + 1], u);
    out.y = layout.riverBedY(t) + 0.3;
    const dx = pts[(i + 1) * 2] - pts[i * 2];
    const dz = pts[(i + 1) * 2 + 1] - pts[i * 2 + 1];
    out.dirX = dx;
    out.dirZ = dz;
    return out;
  }

  function updateDucks(dt, px, pz) {
    const sp = S.duck;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const d = duckList[i];
      let wx = d.x, wz = d.z;
      if (d.kind === 1) {
        const p = riverPoint(d.t, _spot);
        wx = p.x; wz = p.z;
      }
      const dx = wx - px, dz = wz - pz;
      if (dx * dx + dz * dz > sp.radius * sp.radius) continue;
      near++;

      let pitch = 0;
      let dip = 0;
      if (d.kind === 0) {
        d.ang += d.angSpeed * dt;
        d.x = d.cx + Math.cos(d.ang) * d.r;
        d.z = d.cz + Math.sin(d.ang) * d.r;
        const sgn = d.angSpeed >= 0 ? 1 : -1;
        d.yaw = angleDamp(d.yaw, Math.atan2(-Math.sin(d.ang) * sgn, Math.cos(d.ang) * sgn) + Math.sin(time * 0.4 + d.bob) * 0.2, 2.2, dt);
        d.y = LAKE_Y;
      } else {
        const p = riverPoint(d.t, _spot);
        d.t += (d.tDir * 0.9 * dt) / riverLen;
        if (d.t > 0.88) { d.t = 0.88; d.tDir = -1; }
        if (d.t < 0.12) { d.t = 0.12; d.tDir = 1; }
        d.x = p.x;
        d.z = p.z;
        const dirYaw = Math.atan2(p.dirX * d.tDir, p.dirZ * d.tDir);
        d.yaw = angleDamp(d.yaw, dirYaw, 1.6, dt);
        d.y = p.y + Math.sin(time * 1.9 + d.bob) * 0.035;
      }
      d.y += Math.sin(time * 1.6 + d.bob) * 0.02;

      // dive cycle
      if (d.diving) {
        d.diveT += dt;
        const u = clamp01(d.diveT / 1.1);
        dip = -Math.sin(u * Math.PI) * 0.3;
        pitch = Math.sin(u * Math.PI) * 0.5;
        if (d.diveT > 2.6) {
          d.diving = false;
          d.diveTimer = 12 + 18 * (0.5 + 0.5 * Math.sin(i * 7.13));
          triggerRipple(d.x, (d.kind === 0 ? LAKE_Y : d.y) + 0.02, d.z, 1.5);
        }
      } else {
        d.diveTimer -= dt;
        if (d.diveTimer <= 0) {
          d.diving = true;
          d.diveT = 0;
          triggerRipple(d.x, (d.kind === 0 ? LAKE_Y : d.y) + 0.02, d.z, 1.9);
        }
      }

      rootAt(d.x, d.y + dip, d.z, d.yaw, pitch, Math.sin(time * 1.3 + d.bob) * 0.05, d.scale);
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0, 0.05, 0.15, pitch * 0.6 + Math.sin(time * 0.9 + d.bob) * 0.06, Math.sin(time * 0.5 + d.bob) * 0.25, 0);
    }
    sp.meshes[0].instanceMatrix.needsUpdate = true;
    sp.meshes[1].instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // HERONS - two statues on the lake shore that occasionally hop
  // =========================================================================

  const heronHull = bakeParts([
    { geo: sphere(0.16, 9, 6), color: '#8fa3ad', pos: [0, 0.62, 0], scale: [1.5, 0.95, 1.15] },
    { geo: cyl(0.016, 0.02, 0.5, 5), color: '#6b6f74', pos: [-0.05, 0.25, 0.02] },
    { geo: cyl(0.016, 0.02, 0.5, 5), color: '#6b6f74', pos: [0.05, 0.25, 0.02] },
    { geo: box(0.13, 0.02, 0.2), color: '#6b6f74', pos: [-0.05, 0.012, 0.06] },
    { geo: box(0.13, 0.02, 0.2), color: '#6b6f74', pos: [0.05, 0.012, 0.06] },
    { geo: cone(0.11, 0.3, 6), color: '#7e929c', pos: [0, 0.72, -0.24], rot: [-Math.PI / 2, 0, 0], scale: [1, 1, 0.5] },
  ]);
  const heronHeadParts = [
    { geo: cyl(0.028, 0.038, 0.34, 6), color: '#c9d4d8', pos: [0, 0.19, 0.03], rot: [-0.28, 0, 0] },
    { geo: sphere(0.062, 8, 6), color: '#c9d4d8', pos: [0, 0.36, 0.07] },
    { geo: cone(0.022, 0.22, 6), color: '#e8b64c', pos: [0, 0.35, 0.19], rot: [Math.PI / 2, 0, 0] },
    { geo: box(0.02, 0.09, 0.03), color: '#3a3f42', pos: [0, 0.43, 0.02] },
  ];
  const heronHead = bakeParts(heronHeadParts);
  const heronWingParts = [{ geo: box(0.4, 0.03, 0.22), color: '#9aa9b1', pos: [0.2, 0, -0.02] }];
  const heronWingRParts = mirrorParts(heronWingParts);
  const heronWingL = bakeParts(heronWingParts);
  const heronWingR = bakeParts(heronWingRParts);

  const heronList = [];
  {
    const count = Math.max(2, Math.ceil(2 * MAX_SCALE));
    for (let i = 0; i < count; i++) {
      const ok = lakeShoreSpot(rng);
      // never trust a blind fallback: it must at least stand on the terrain
      const x = ok ? _spot.x : LAKE.center.x + LAKE.radius * 1.1;
      const z = ok ? _spot.z : LAKE.center.z;
      const y = ok ? _spot.y : layout.heightAt(x, z);
      heronList.push({
        x, y, z, yaw: rng.float() * TAU,
        headPhase: rng.float() * TAU,
        st: 0, timer: rng.range(6, 18), hopT: 0, flapPhase: 0,
        dirX: 0, dirZ: 0, scale: rng.range(0.95, 1.12),
      });
    }
  }

  S.heron = addSpecies('herons', {
    base: 2, radius: 320, castShadow: true, list: heronList,
    parts: [{ geo: heronHull }, { geo: heronHead }, { geo: heronWingL }, { geo: heronWingR }],
  });

  function updateHerons(dt, px, pz) {
    const sp = S.heron;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const h = heronList[i];
      const dx = h.x - px, dz = h.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > sp.radius * sp.radius) continue;
      near++;

      const sdx = px - h.x, sdz = pz - h.z;
      const sd = Math.hypot(sdx, sdz);
      // Face the rider when it comes close (statues stare), otherwise sway.
      const wantYaw = sd < 40 ? Math.atan2(sdx, sdz) : h.yaw + Math.sin(time * 0.13 + h.headPhase) * 0.002;
      h.yaw = angleDamp(h.yaw, wantYaw, sd < 40 ? 1.2 : 0.25, dt);

      let y = h.y;
      let wing = 0.02 + Math.sin(time * 0.7 + h.headPhase) * 0.01;
      let headPitch = Math.sin(time * 0.55 + h.headPhase * 1.7) * 0.12;
      const headYaw = Math.sin(time * 0.9 + h.headPhase * 0.6) * 0.22;

      if (h.st === 0) {
        h.timer -= dt;
        if (h.timer <= 0) {
          h.st = 1;
          h.hopT = 0;
          h.dirX = Math.sin(h.yaw + rng.range(-0.5, 0.5));
          h.dirZ = Math.cos(h.yaw + rng.range(-0.5, 0.5));
        }
      } else {
        h.hopT += dt;
        const u = clamp01(h.hopT / 0.95);
        y = h.y + Math.sin(u * Math.PI) * 0.34;
        h.x += h.dirX * 0.55 * dt;
        h.z += h.dirZ * 0.55 * dt;
        h.flapPhase += dt * 3.2;
        wing = 0.18 + Math.sin(h.flapPhase) * 0.4;
        headPitch += 0.18;
        if (h.hopT > 1.6) {
          h.st = 0;
          h.y = layout.heightAt(h.x, h.z);
          h.timer = 12 + 16 * (0.5 + 0.5 * Math.sin(i * 5.31));
        }
      }

      rootAt(h.x, y, h.z, h.yaw, 0, 0, h.scale);
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0, 0.72, 0.06, headPitch, headYaw, 0);
      writePart(sp, 2, i, 0.06, 0.72, -0.05, 0, 0, wing);
      writePart(sp, 3, i, -0.06, 0.72, -0.05, 0, 0, -wing, -1, 1, 1);
    }
    for (const m of sp.meshes) m.instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // RABBITS - hoppers in the meadows beside the ring road
  // =========================================================================

  const rabbitHull = bakeParts([
    { geo: sphere(0.15, 9, 6), color: '#b3a08a', pos: [0, 0.14, 0], scale: [1.25, 1.0, 1.05] },
    { geo: sphere(0.09, 8, 6), color: '#bfae9a', pos: [0, 0.2, 0.15] },
    { geo: sphere(0.05, 6, 5), color: '#f2ece2', pos: [0, 0.1, -0.2] },
  ]);
  const rabbitEarParts = [{ geo: box(0.035, 0.17, 0.05), color: '#c2b09c', pos: [0, 0.085, 0] }];
  const rabbitEarRParts = mirrorParts(rabbitEarParts);
  const rabbitEarL = bakeParts(rabbitEarParts);
  const rabbitEarR = bakeParts(rabbitEarRParts);

  const rabbitList = [];
  const rabbitCount = Math.max(10, Math.ceil(10 * MAX_SCALE));
  for (let i = 0; i < rabbitCount; i++) {
    const ok = meadowNearRoad(rng, 12, 55);
    const x = ok ? _spot.x : rng.range(-1000, 1000);
    const z = ok ? _spot.z : rng.range(-1000, 1000);
    const y = ok ? _spot.y : layout.heightAt(x, z);
    rabbitList.push({
      x, y, z, homeX: x, homeZ: z,
      yaw: rng.float() * TAU, st: 0, timer: rng.range(0.8, 3.5),
      hopU: 0, hopDur: 0.45, hopLen: 0.8, hopH: 0.3,
      dirX: 0, dirZ: 1, earPhase: rng.float() * TAU, twitch: rng.float() * TAU,
      scale: rng.range(0.9, 1.15),
    });
  }

  S.rabbit = addSpecies('rabbits', {
    base: 10, radius: 320, list: rabbitList,
    parts: [{ geo: rabbitHull }, { geo: rabbitEarL }, { geo: rabbitEarR }],
  });

  const RABBIT_FLEE = 10;

  function updateRabbits(dt, px, pz) {
    const sp = S.rabbit;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const r = rabbitList[i];
      const dx = r.x - px, dz = r.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > sp.radius * sp.radius) continue;
      near++;

      const scared = d2 < RABBIT_FLEE * RABBIT_FLEE;
      if (scared && r.st === 0) {
        r.st = 1;
        r.timer = 3.2;
        r.hopDur = 0.26;
        r.hopLen = 1.5;
        r.hopH = 0.42;
      }

      let y = r.y;
      let sy = 1;
      if (r.st === 0) {
        r.timer -= dt;
        r.twitch += dt;
        if (r.timer <= 0) {
          r.st = 1;
          r.hopDur = 0.42 + 0.2 * (0.5 + 0.5 * Math.sin(i * 3.7));
          r.hopLen = 0.55 + 0.5 * (0.5 + 0.5 * Math.sin(i * 8.1));
          r.hopH = 0.26;
          const a = rng.float() * TAU;
          r.dirX = Math.sin(a); r.dirZ = Math.cos(a);
          r.timer = r.hopDur;
          r.hopU = 0;
        }
        r.y = damp(r.y, layout.heightAt(r.x, r.z), 3, dt);
      } else {
        r.hopU += dt;
        const u = clamp01(r.hopU / r.hopDur);
        const v = (r.hopH * Math.PI * Math.cos(u * Math.PI)) / r.hopDur;
        sy = clamp(1 + v * 0.45, 0.72, 1.5);
        y = layout.heightAt(r.x, r.z) + Math.sin(u * Math.PI) * r.hopH;
        r.x += r.dirX * (r.hopLen / r.hopDur) * dt;
        r.z += r.dirZ * (r.hopLen / r.hopDur) * dt;
        r.y = y;
        r.yaw = angleDamp(r.yaw, Math.atan2(r.dirX, r.dirZ), 6, dt);
        if (scared) {
          r.timer = Math.max(r.timer, 2.4);
          const ax = r.x - px, az = r.z - pz;
          const al = Math.hypot(ax, az) || 1;
          r.dirX = ax / al; r.dirZ = az / al;
        }
        r.timer -= dt;
        if (r.hopU >= r.hopDur) {
          if (scared || r.timer > 0) {
            r.hopU = 0;
            r.timer = scared ? 2.4 : r.timer;
          } else {
            r.st = 0;
            r.timer = 1.2 + 2.5 * (0.5 + 0.5 * Math.sin(i * 9.7));
            r.homeX = r.x; r.homeZ = r.z;
          }
        }
      }

      const twitch = Math.max(0, Math.sin(time * 7.5 + r.twitch)) * clamp01(Math.sin(time * 0.7 + r.earPhase) * 2);
      const earA = twitch * 0.09;
      const sxz = 1 / Math.sqrt(sy);
      rootAt(r.x, y, r.z, r.yaw, 0, 0, r.scale);
      if (Math.abs(sy - 1) > 0.001) {
        // squash & stretch around the ground contact point
        _rootM.scale(_scl.set(sxz, sy / r.scale, sxz));
        _rootM.setPosition(r.x, y, r.z);
      }
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0.045, 0.24, 0.12, earA, 0, 0.12 + earA * 0.5);
      writePart(sp, 2, i, -0.045, 0.24, 0.12, earA, 0, -0.12 - earA * 0.5);
    }
    for (const m of sp.meshes) m.instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // DEER - four browsers at the west forest edge
  // =========================================================================

  const deerHull = bakeParts([
    { geo: sphere(0.42, 10, 7), color: '#a87748', pos: [0, 1.0, 0], scale: [1.0, 0.95, 1.85] },
    { geo: sphere(0.26, 8, 6), color: '#9c6c3f', pos: [0, 1.16, -0.72] },
  ]);
  const deerNeckParts = [
    { geo: cyl(0.1, 0.13, 0.52, 6), color: '#b07f4c', pos: [0, 0.24, 0.05], rot: [-0.5, 0, 0] },
    { geo: sphere(0.14, 8, 6), color: '#b07f4c', pos: [0, 0.45, 0.24], scale: [0.85, 0.9, 1.3] },
    { geo: cone(0.035, 0.3, 5), color: '#c9b8a0', pos: [0.06, 0.62, 0.2], rot: [-0.6, 0, 0.5] },
    { geo: cone(0.035, 0.3, 5), color: '#c9b8a0', pos: [-0.06, 0.62, 0.2], rot: [-0.6, 0, -0.5] },
  ];
  const deerHead = bakeParts(deerNeckParts);
  const legPair = (z) => [
    { geo: box(0.09, 0.86, 0.1), color: '#8f6238', pos: [0.16, -0.43, z] },
    { geo: box(0.09, 0.86, 0.1), color: '#8f6238', pos: [-0.16, -0.43, z] },
  ];
  const deerLegsFront = bakeParts(legPair(0.52));
  const deerLegsHind = bakeParts(legPair(-0.5));

  const deerList = [];
  const deerCount = Math.max(4, Math.ceil(4 * MAX_SCALE));
  for (let i = 0; i < deerCount; i++) {
    const ok = forestEdgeSpot(rng);
    const x = ok ? _spot.x : pois.forest.position.x;
    const z = ok ? _spot.z : pois.forest.position.z;
    const y = ok ? _spot.y : layout.heightAt(x, z);
    deerList.push({
      x, y, z, yaw: rng.float() * TAU, ground: y,
      st: 0, timer: rng.range(4, 12), graze: rng.chance(0.6) ? 1 : 0, grazeT: rng.range(4, 9),
      headRot: 0.6, walkPhase: rng.float() * TAU,
      tgtX: x, tgtZ: z, tgtTimer: rng.range(6, 14),
      scale: rng.range(0.95, 1.1),
    });
  }

  S.deer = addSpecies('deer', {
    base: 4, radius: 420, castShadow: true, list: deerList,
    parts: [{ geo: deerHull }, { geo: deerHead }, { geo: deerLegsFront }, { geo: deerLegsHind }],
  });

  function updateDeer(dt, px, pz) {
    const sp = S.deer;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const d = deerList[i];
      const dx = d.x - px, dz = d.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > sp.radius * sp.radius) continue;
      near++;

      const sd = Math.sqrt(d2);
      if (sd < 12) d.st = 2;
      else if (sd < 25 && d.st !== 2) d.st = 1;
      else if (d.st === 1 && sd > 34) d.st = 0;

      let moveSpeed = 0;
      let headTarget = d.graze ? 1.0 : 0.35;

      if (d.st === 0) {
        d.tgtTimer -= dt;
        if (d.tgtTimer <= 0) {
          const a = rng.float() * TAU;
          const r = rng.range(15, 45);
          d.tgtX = d.x + Math.cos(a) * r;
          d.tgtZ = d.z + Math.sin(a) * r;
          d.tgtTimer = rng.range(8, 18);
        }
        const bx = d.tgtX - d.x, bz = d.tgtZ - d.z;
        const bd = Math.hypot(bx, bz);
        if (bd > 1.5) {
          moveSpeed = 0.75;
          d.yaw = angleDamp(d.yaw, Math.atan2(bx, bz), 1.4, dt);
        }
        d.grazeT -= dt;
        if (d.grazeT <= 0) {
          d.graze = d.graze ? 0 : 1;
          d.grazeT = d.graze ? 5 + 5 * (0.5 + 0.5 * Math.sin(i * 4.2)) : 4 + 4 * (0.5 + 0.5 * Math.sin(i * 2.9));
        }
        headTarget = d.graze ? 1.0 : 0.3;
      } else if (d.st === 1) {
        d.yaw = angleDamp(d.yaw, Math.atan2(dx, dz), 2.2, dt);
        headTarget = -0.1;
      } else {
        moveSpeed = 3.1;
        const ax = d.x - px, az = d.z - pz;
        const al = Math.hypot(ax, az) || 1;
        d.yaw = angleDamp(d.yaw, Math.atan2(ax / al, az / al), 2.6, dt);
        headTarget = -0.15;
        if (sd > 45) d.st = 0;
      }

      d.x += Math.sin(d.yaw) * moveSpeed * dt;
      d.z += Math.cos(d.yaw) * moveSpeed * dt;
      d.ground = layout.heightAt(d.x, d.z);
      d.y = d.ground;
      d.walkPhase += dt * (1.6 + moveSpeed * 1.6);
      d.headRot = damp(d.headRot, headTarget, 1.6, dt);

      const swing = (moveSpeed > 0.1 ? 0.34 : 0.03) * Math.sin(d.walkPhase);
      rootAt(d.x, d.y, d.z, d.yaw, 0, 0, d.scale);
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0, 1.32, 0.62, d.headRot, 0, 0);
      writePart(sp, 2, i, 0, 0.92, 0, swing, 0, 0);
      writePart(sp, 3, i, 0, 0.92, 0, -swing, 0, 0);
    }
    for (const m of sp.meshes) m.instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // CRABS - twelve beach scuttlers that dig in when the rider closes in
  // =========================================================================

  const crabHull = bakeParts([
    { geo: sphere(0.11, 8, 6), color: '#d1543c', pos: [0, 0.09, 0], scale: [1.25, 0.6, 0.95] },
    { geo: box(0.05, 0.02, 0.05), color: '#f2ece2', pos: [0.08, 0.03, 0.06] },
    { geo: box(0.05, 0.02, 0.05), color: '#f2ece2', pos: [-0.08, 0.03, 0.06] },
    { geo: box(0.05, 0.02, 0.05), color: '#f2ece2', pos: [0.08, 0.03, -0.06] },
    { geo: box(0.05, 0.02, 0.05), color: '#f2ece2', pos: [-0.08, 0.03, -0.06] },
    { geo: sphere(0.028, 6, 5), color: '#2b241f', pos: [0.04, 0.16, 0.09] },
    { geo: sphere(0.028, 6, 5), color: '#2b241f', pos: [-0.04, 0.16, 0.09] },
  ]);
  const crabClawParts = [
    { geo: box(0.03, 0.03, 0.12), color: '#c14a34', pos: [0, 0, 0.05] },
    { geo: box(0.07, 0.05, 0.09), color: '#e0603f', pos: [0, 0.005, 0.15] },
  ];
  const crabClawRParts = mirrorParts(crabClawParts);
  const crabClawL = bakeParts(crabClawParts);
  const crabClawR = bakeParts(crabClawRParts);

  const crabList = [];
  const crabCount = Math.max(12, Math.ceil(12 * MAX_SCALE));
  for (let i = 0; i < crabCount; i++) {
    const ok = beachSpot(rng);
    const x = ok ? _spot.x : -60;
    const z = ok ? _spot.z : 1900;
    const y = ok ? _spot.y : layout.heightAt(x, z);
    crabList.push({
      x, y, z, yaw: rng.float() * TAU, moveDir: rng.float() * TAU,
      st: 0, timer: rng.range(0.5, 2.5), burstT: 0, sink: 0, sinkTarget: 0,
      clawPhase: rng.float() * TAU, scale: rng.range(0.85, 1.2),
    });
  }

  S.crab = addSpecies('crabs', {
    base: 12, radius: 240, list: crabList,
    parts: [{ geo: crabHull }, { geo: crabClawL }, { geo: crabClawR }],
  });

  function updateCrabs(dt, px, pz) {
    const sp = S.crab;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const c = crabList[i];
      const dx = c.x - px, dz = c.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > sp.radius * sp.radius) continue;
      near++;

      const sd = Math.sqrt(d2);
      c.sinkTarget = sd < 6 ? 1 : sd > 11 ? 0 : c.sinkTarget;
      c.sink = damp(c.sink, c.sinkTarget, c.sinkTarget > 0 ? 3.2 : 1.4, dt);

      let moveSpeed = 0;
      if (c.sinkTarget === 0) {
        c.timer -= dt;
        if (c.st === 0) {
          if (c.timer <= 0) {
            c.st = 1;
            c.burstT = 0.7 + 1.4 * (0.5 + 0.5 * Math.sin(i * 6.3));
            const a = rng.float() * TAU;
            c.moveDir = a;
            c.timer = c.burstT;
          }
        } else {
          moveSpeed = 0.95;
          if (c.timer <= 0) {
            c.st = 0;
            c.timer = 0.6 + 2.2 * (0.5 + 0.5 * Math.sin(i * 3.1));
          }
        }
      }

      const mv = Math.sin(c.moveDir);
      const mvz = Math.cos(c.moveDir);
      c.x += mv * moveSpeed * dt;
      c.z += mvz * moveSpeed * dt;
      c.yaw = angleDamp(c.yaw, c.moveDir + Math.PI / 2, 5, dt);
      const ground = layout.heightAt(c.x, c.z);
      c.y = ground + 0.02 - c.sink * 0.24;

      c.clawPhase += dt * (moveSpeed > 0.1 ? 9 : 3.4);
      const wave = Math.sin(c.clawPhase) * (moveSpeed > 0.1 ? 0.12 : 0.42);
      const clawY = c.sink < 0.5 ? wave : 0.75;

      rootAt(c.x, c.y, c.z, c.yaw, 0, 0, c.scale);
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0.1, 0.07, 0.1, 0, clawY, 0);
      writePart(sp, 2, i, -0.1, 0.07, 0.1, 0, -clawY, 0, -1, 1, 1);
    }
    for (const m of sp.meshes) m.instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // BUTTERFLIES + BEES - day shift over the flowered meadows
  // =========================================================================

  const butterflyHull = bakeParts([
    { geo: sphere(0.014, 6, 5), color: '#3a2c22', pos: [0, 0, 0], scale: [0.6, 0.7, 2.4] },
    { geo: sphere(0.012, 6, 5), color: '#3a2c22', pos: [0, 0.01, 0.03] },
  ]);
  const butterflyWingParts = [
    { geo: box(0.05, 0.003, 0.055), color: '#ffffff', pos: [0.027, 0, 0.012] },
    { geo: box(0.034, 0.003, 0.036), color: '#f2ece2', pos: [0.02, -0.001, -0.03] },
  ];
  const butterflyWingRParts = mirrorParts(butterflyWingParts);
  const butterflyWingL = bakeParts(butterflyWingParts);
  const butterflyWingR = bakeParts(butterflyWingRParts);

  const beeHull = bakeParts([
    { geo: sphere(0.028, 7, 6), color: '#e8b64c', pos: [0, 0, 0], scale: [1.0, 0.9, 2.1] },
    { geo: box(0.052, 0.05, 0.02), color: '#2b241f', pos: [0, 0, 0.012] },
    { geo: box(0.046, 0.045, 0.018), color: '#2b241f', pos: [0, 0, -0.022] },
    { geo: box(0.1, 0.004, 0.03), color: '#dfe6ea', pos: [0.045, 0.012, 0.01], rot: [0, 0, -0.25] },
    { geo: box(0.1, 0.004, 0.03), color: '#dfe6ea', pos: [-0.045, 0.012, 0.01], rot: [0, 0, 0.25] },
  ]);

  const butterflyList = [];
  const beeList = [];
  {
    const clusters = [];
    for (let c = 0; c < 6; c++) {
      if (meadowNearRoad(rng, 10, 45)) clusters.push({ x: _spot.x, y: _spot.y, z: _spot.z });
      else clusters.push({ x: rng.range(-900, 900), y: layout.heightAt(0, 0), z: rng.range(-900, 900) });
    }
    debug.butterflyAnchor.x = clusters[0].x;
    debug.butterflyAnchor.y = clusters[0].y;
    debug.butterflyAnchor.z = clusters[0].z;
    const butterflyCount = Math.max(30, Math.ceil(30 * MAX_SCALE));
    for (let i = 0; i < butterflyCount; i++) {
      const c = clusters[i % clusters.length];
      butterflyList.push({
        ax: c.x + rng.range(-9, 9), az: c.z + rng.range(-9, 9),
        ay: layout.heightAt(c.x, c.z) + rng.range(0.4, 1.5),
        phase: rng.float() * TAU, flapPhase: rng.float() * TAU,
        flapRate: rng.range(9, 14),
        head: c.y, x: c.x, y: c.y + 0.8, z: c.z, yaw: 0,
        scale: rng.range(0.8, 1.25),
      });
    }
    const beeCount = Math.max(16, Math.ceil(16 * MAX_SCALE));
    for (let i = 0; i < beeCount; i++) {
      const c = clusters[i % clusters.length];
      const ang = rng.float() * TAU;
      const r = rng.range(0.5, 1.6);
      const cx = c.x + rng.range(-8, 8);
      const cz = c.z + rng.range(-8, 8);
      beeList.push({
        cx, cz, cy: layout.heightAt(cx, cz) + rng.range(0.6, 1.6),
        r, ang, angSpeed: rng.sign() * rng.range(2.4, 4.2),
        phase: rng.float() * TAU, x: cx, y: 0, z: cz, yaw: 0,
        scale: rng.range(0.85, 1.2),
      });
    }
  }

  S.butterfly = addSpecies('butterflies', {
    base: 30, radius: 150, list: butterflyList,
    parts: [
      { geo: butterflyHull },
      { geo: butterflyWingL, mat: wingMat },
      { geo: butterflyWingR, mat: wingMat },
    ],
  });
  S.bee = addSpecies('bees', { base: 16, radius: 150, list: beeList, parts: [{ geo: beeHull }] });

  function updateButterflies(dt, px, pz) {
    const sp = S.butterfly;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const b = butterflyList[i];
      const dx = b.x - px, dz = b.z - pz;
      if (dx * dx + dz * dz > sp.radius * sp.radius) continue;
      near++;
      const t = time;
      const ox = Math.sin(t * 0.9 + b.phase) * 1.7 + Math.sin(t * 2.35 + b.phase * 1.7) * 0.55;
      const oz = Math.cos(t * 1.05 + b.phase * 1.3) * 1.6 + Math.cos(t * 2.7 + b.phase) * 0.5;
      const oy = Math.sin(t * 2.1 + b.phase * 2.2) * 0.32 + Math.sin(t * 0.7 + b.phase) * 0.16;
      b.x = b.ax + ox;
      b.z = b.az + oz;
      b.y = b.ay + oy;
      const vx = Math.cos(t * 0.9 + b.phase) * 1.53 + Math.cos(t * 2.35 + b.phase * 1.7) * 1.29;
      const vz = -Math.sin(t * 1.05 + b.phase * 1.3) * 1.68 - Math.sin(t * 2.7 + b.phase) * 1.35;
      b.yaw = angleDamp(b.yaw, Math.atan2(vx, vz), 3, dt);
      b.flapPhase += dt * b.flapRate;
      const wing = Math.sin(b.flapPhase) * 0.95;
      rootAt(b.x, b.y, b.z, b.yaw, 0, 0, b.scale);
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0.006, 0.004, 0.004, 0, 0, wing);
      writePart(sp, 2, i, -0.006, 0.004, 0.004, 0, 0, -wing, -1, 1, 1);
    }
    for (const m of sp.meshes) m.instanceMatrix.needsUpdate = true;
    return near;
  }

  function updateBees(dt, px, pz) {
    const sp = S.bee;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const b = beeList[i];
      const dx = b.x - px, dz = b.z - pz;
      if (dx * dx + dz * dz > sp.radius * sp.radius) continue;
      near++;
      b.ang += b.angSpeed * dt;
      const nx = b.cx + Math.cos(b.ang) * b.r;
      const nz = b.cz + Math.sin(b.ang) * b.r;
      const ny = b.cy + Math.sin(time * 3.1 + b.phase) * 0.22;
      const sgn = b.angSpeed >= 0 ? 1 : -1;
      b.yaw = angleDamp(b.yaw, Math.atan2(-Math.sin(b.ang) * sgn, Math.cos(b.ang) * sgn), 6, dt);
      b.x = nx; b.y = ny; b.z = nz;
      rootAt(b.x, b.y, b.z, b.yaw, Math.sin(time * 6 + b.phase) * 0.12, 0, b.scale);
      writeAtRoot(sp, 0, i);
    }
    sp.meshes[0].instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // FIREFLIES - a night swarm that always drifts within 90 m of the player
  // =========================================================================

  const ffCap = Math.max(1, Math.ceil(FIREFLY_BASE * MAX_SCALE));
  const ffPos = new Float32Array(ffCap * 3);
  const ffPhase = new Float32Array(ffCap);
  const ffSize = new Float32Array(ffCap);
  const ffGeo = new THREE.BufferGeometry();
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3));
  ffGeo.setAttribute('aPhase', new THREE.BufferAttribute(ffPhase, 1));
  ffGeo.setAttribute('aSize', new THREE.BufferAttribute(ffSize, 1));
  ffGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);

  const sparkMap = typeof textures.sparkSprite === 'function' ? textures.sparkSprite() : null;
  const ffMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 420 },
      uMap: { value: sparkMap && sparkMap.isTexture ? sparkMap : null },
      uColor: { value: new THREE.Color(0xffe9a8) },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        float blink = sin(uTime * 2.0 + aPhase) * 0.5 + 0.5;
        vAlpha = clamp(blink * blink * blink * 1.7 - 0.2, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uScale / max(1.0, -mv.z) * (0.7 + 0.6 * vAlpha);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        if (vAlpha < 0.01) discard;
        vec4 tex = texture2D(uMap, gl_PointCoord);
        float a = tex.a * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * (tex.rgb + 0.55), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const fireflies = new THREE.Points(ffGeo, ffMat);
  fireflies.name = 'animal:fireflies';
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  group.add(fireflies);

  const ffList = [];
  for (let i = 0; i < ffCap; i++) {
    const a = rng.float() * TAU;
    const r = Math.sqrt(rng.float()) * 34;
    ffList.push({
      ox: Math.cos(a) * r, oy: rng.range(0.4, 4.2), oz: Math.sin(a) * r,
      drift: rng.float() * TAU, speed: rng.range(0.5, 1.4),
    });
    ffPhase[i] = rng.float() * TAU;
    ffSize[i] = rng.range(0.09, 0.2);
  }
  let ffCount = FIREFLY_BASE;
  let ffAx = 0, ffAy = 3, ffAz = 0;
  let ffInit = false;

  function updateFireflies(dt, px, pz, night, windX, windZ) {
    if (!night) {
      fireflies.visible = false;
      debug.fireflyVisible = 0;
      return 0;
    }
    fireflies.visible = true;
    if (!ffInit) { ffAx = px; ffAz = pz; ffInit = true; }
    const adx = ffAx - px, adz = ffAz - pz;
    if (adx * adx + adz * adz > 45 * 45) {
      // the swarm was left behind: it quietly reappears around the rider
      ffAx = px; ffAz = pz;
    } else {
      ffAx = damp(ffAx, px, 0.55, dt);
      ffAz = damp(ffAz, pz, 0.55, dt);
    }
    ffAy = damp(ffAy, layout.heightAt(ffAx, ffAz) + 2.4, 0.5, dt);

    ffMat.uniforms.uTime.value = time;
    ffMat.uniforms.uScale.value = pointScale;

    let vis = 0;
    for (let i = 0; i < ffCount; i++) {
      const f = ffList[i];
      f.ox += (windX * 0.35 + Math.sin(time * 0.33 + f.drift) * 0.25) * dt;
      f.oz += (windZ * 0.35 + Math.cos(time * 0.29 + f.drift) * 0.25) * dt;
      f.oy += Math.sin(time * 0.7 + f.drift) * 0.12 * dt;
      const d2 = f.ox * f.ox + f.oz * f.oz;
      if (d2 > 34 * 34) {                       // drift back into the cloud
        const k = 34 / Math.sqrt(d2);
        f.ox *= k; f.oz *= k;
      }
      const x = ffAx + f.ox;
      const y = ffAy + f.oy;
      const z = ffAz + f.oz;
      const ddx = x - px, ddz = z - pz;
      if (ddx * ddx + ddz * ddz > 90 * 90) continue;   // only within 90 m
      ffPos[vis * 3] = x;
      ffPos[vis * 3 + 1] = y;
      ffPos[vis * 3 + 2] = z;
      vis++;
    }
    ffGeo.attributes.position.needsUpdate = true;
    ffGeo.setDrawRange(0, vis);
    debug.fireflyVisible = vis;
    return vis;
  }

  // =========================================================================
  // FISH - dusk & dawn jumps in the lake and along the river
  // =========================================================================

  const fishHull = bakeParts([
    { geo: sphere(0.1, 8, 6), color: '#93b0c4', pos: [0, 0, 0], scale: [0.75, 0.85, 2.1] },
    { geo: cone(0.09, 0.16, 4), color: '#b9c9d6', pos: [0, 0, -0.24], rot: [-Math.PI / 2, 0, 0], scale: [1, 1, 0.35] },
    { geo: cone(0.06, 0.1, 4), color: '#7e9bb0', pos: [0, 0.09, 0.02], rot: [0, 0, 0], scale: [0.5, 1, 1] },
  ]);

  const fishList = [];
  const fishCount = Math.max(14, Math.ceil(14 * MAX_SCALE));
  for (let i = 0; i < fishCount; i++) {
    const lake = i < Math.round(fishCount * 0.5);
    let x = 0, z = 0, y = 0;
    if (lake) {
      waterSpot(rng, LAKE.center.x, LAKE.center.z, 130, 1.4);
      x = _spot.x; z = _spot.z; y = LAKE_Y;
    } else {
      const t = rng.range(0.1, 0.95);
      riverPoint(t, _spot);
      x = _spot.x; z = _spot.z; y = _spot.y;
    }
    fishList.push({
      lake, x0: x, z0: z, y0: y,
      dirX: 0, dirZ: 1, timer: rng.range(1, 14), st: 0, t: 0, dur: 0.95,
      x, y, z, yaw: 0, pitch: 0, scale: rng.range(0.85, 1.25),
    });
  }

  S.fish = addSpecies('fish', { base: 14, radius: 340, list: fishList, parts: [{ geo: fishHull }] });

  function updateFish(dt, px, pz, active) {
    const sp = S.fish;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const f = fishList[i];
      const dx = f.x - px, dz = f.z - pz;
      if (dx * dx + dz * dz > sp.radius * sp.radius) continue;
      near++;
      if (!active) {
        f.y = f.y0 - 0.3;
      } else if (f.st === 0) {
        f.timer -= dt;
        f.y = f.y0 - 0.3;
        if (f.timer <= 0) {
          f.st = 1;
          f.t = 0;
          f.dirX = Math.sin(rng.range(0, TAU));
          f.dirZ = Math.cos(rng.range(0, TAU));
          f.yaw = Math.atan2(f.dirX, f.dirZ);
          triggerRipple(f.x, f.y0 + 0.02, f.z, 1.2);
        }
      } else {
        f.t += dt;
        const u = clamp01(f.t / f.dur);
        const vv = (1.5 * Math.PI * Math.cos(u * Math.PI)) / f.dur;
        f.y = f.y0 + Math.sin(u * Math.PI) * 1.5;
        f.x += f.dirX * 1.6 * dt;
        f.z += f.dirZ * 1.6 * dt;
        f.pitch = Math.atan2(vv, 1.6) * 0.8;
        if (f.t >= f.dur) {
          f.st = 0;
          f.timer = 4 + 12 * (0.5 + 0.5 * Math.sin(i * 11.3));
          triggerRipple(f.x, f.y0 + 0.02, f.z, 1.7);
          // respawn somewhere near the home water
          if (f.lake) {
            waterSpot(rng, LAKE.center.x, LAKE.center.z, 130, 1.4);
            f.x = _spot.x; f.z = _spot.z; f.y0 = LAKE_Y;
          } else {
            riverPoint(rng.range(0.1, 0.95), _spot);
            f.x = _spot.x; f.z = _spot.z; f.y0 = _spot.y;
          }
          f.y = f.y0 - 0.3;
        }
      }
      rootAt(f.x, f.y, f.z, f.yaw, f.pitch, Math.sin(time * 2 + i) * 0.15, f.scale);
      writeAtRoot(sp, 0, i);
    }
    sp.meshes[0].instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // WHALE - one slow giant beyond r = 3000, spout and tail slap included
  // =========================================================================

  const whaleHull = bakeParts([
    { geo: sphere(4.0, 12, 9), color: '#4a5560', pos: [0, 0, 0], scale: [0.72, 0.62, 1.75] },
    { geo: sphere(2.1, 10, 7), color: '#525e6a', pos: [0, 0.1, 5.2], scale: [0.62, 0.5, 0.6] },
    { geo: box(3.0, 0.5, 2.0), color: '#dfe6ea', pos: [0, -1.85, 1.0], scale: [1, 1, 1] },
    { geo: box(1.4, 0.3, 2.2), color: '#44505c', pos: [3.0, -1.2, 1.4], rot: [0, 0, -0.25], scale: [1, 1, 1] },
    { geo: box(1.4, 0.3, 2.2), color: '#44505c', pos: [-3.0, -1.2, 1.4], rot: [0, 0, 0.25], scale: [1, 1, 1] },
  ]);
  const whaleTail = bakeParts([
    { geo: cyl(0.5, 0.9, 2.4, 7), color: '#44505c', pos: [0, 0, -1.0], rot: [Math.PI / 2, 0, 0] },
    { geo: box(4.4, 0.35, 1.5), color: '#3d4853', pos: [0, 0, -2.4], scale: [1, 1, 1] },
  ]);

  const whale = {
    cx: Math.cos(2.35) * 3220, cz: Math.sin(2.35) * 3220, r: 320,
    ang: 0, t: 0, x: 0, y: -9, z: 0, yaw: 0,
  };
  whale.x = whale.cx + whale.r;
  whale.z = whale.cz;

  S.whale = addSpecies('whales', {
    base: 1, radius: 1e9, list: [whale],
    parts: [{ geo: whaleHull }, { geo: whaleTail }],
  });

  const spoutMat = new THREE.SpriteMaterial({
    map: typeof textures.smokeSprite === 'function' ? textures.smokeSprite() : null,
    color: 0xe8f2f6, transparent: true, opacity: 0, depthWrite: false,
  });
  const spout = new THREE.Sprite(spoutMat);
  spout.name = 'animal:whaleSpout';
  spout.visible = false;
  group.add(spout);

  function updateWhale(dt) {
    const sp = S.whale;
    whale.ang += dt * 0.0068;
    whale.t += dt / 36;
    if (whale.t >= 1) whale.t -= 1;
    const u = whale.t;
    let y;
    if (u < 0.26) y = lerp(-9.5, -0.7, smootherstep(0, 0.26, u));
    else if (u < 0.56) y = -0.7 + Math.sin(((u - 0.26) / 0.3) * Math.PI) * 0.5;
    else if (u < 0.78) y = lerp(-0.5, -9.5, smootherstep(0, 0.22, u - 0.56));
    else y = -9.5;
    whale.x = whale.cx + Math.cos(whale.ang) * whale.r;
    whale.z = whale.cz + Math.sin(whale.ang) * whale.r;
    whale.y = y;
    const sgn = 1;
    whale.yaw = Math.atan2(-Math.sin(whale.ang) * sgn, Math.cos(whale.ang) * sgn);
    // tail slap during the dive
    const slap = u > 0.58 && u < 0.9 ? Math.sin((u - 0.58) * 26) * 0.7 : Math.sin(time * 0.5) * 0.06;
    rootAt(whale.x, whale.y, whale.z, whale.yaw, 0, 0, 1);
    writeAtRoot(sp, 0, 0);
    writePart(sp, 1, 0, 0, 0.1, -5.6, slap, 0, 0);
    // spout plume shortly after the blowhole clears the water
    const spoutPhase = clamp01((u - 0.27) / 0.12);
    if (u > 0.27 && u < 0.45) {
      spout.visible = true;
      const k = Math.sin(spoutPhase * Math.PI);
      spoutMat.opacity = k * 0.85;
      spout.scale.set(6 + k * 5, 7 + k * 8, 1);
      spout.position.set(whale.x, whale.y + 2.6 + k * 4.5, whale.z);
    } else {
      spout.visible = false;
      spoutMat.opacity = 0;
    }
    return 1;
  }

  // =========================================================================
  // DOLPHINS - three arc-leapers in the east bay
  // =========================================================================

  const dolphinHull = bakeParts([
    { geo: sphere(0.5, 10, 7), color: '#5f7d92', pos: [0, 0, 0], scale: [0.72, 0.72, 2.3] },
    { geo: sphere(0.34, 8, 6), color: '#6d8ba0', pos: [0, -0.12, 0.55], scale: [0.85, 0.6, 1.1] },
    { geo: cone(0.13, 0.5, 5), color: '#4e6b80', pos: [0, 0.42, -0.1], scale: [0.45, 1, 1] },
    { geo: box(0.7, 0.08, 0.34), color: '#4e6b80', pos: [0.42, -0.06, 0.35], rot: [0, 0, -0.3] },
    { geo: box(0.7, 0.08, 0.34), color: '#4e6b80', pos: [-0.42, -0.06, 0.35], rot: [0, 0, 0.3] },
  ]);
  const dolphinTail = bakeParts([
    { geo: box(0.9, 0.1, 0.7), color: '#54718a', pos: [0, 0, -0.35] },
  ]);

  const dolphinList = [];
  {
    const bp = pois.beachEast.position;
    const bl = Math.hypot(bp.x, bp.z) || 1;
    const ux = bp.x / bl;
    const uz = bp.z / bl;
    // march offshore from the beach until the water is properly deep
    let bayX = bp.x + ux * 700;
    let bayZ = bp.z + uz * 700;
    for (let d = 350; d <= 1500; d += 50) {
      const x = bp.x + ux * d;
      const z = bp.z + uz * d;
      if (layout.waterDepth(x, z) > 12) { bayX = x; bayZ = z; break; }
    }
    const count = Math.max(3, Math.ceil(3 * MAX_SCALE));
    for (let i = 0; i < count; i++) {
      // shrink the circle until the whole swim ring is comfortably in water
      let r = 60 + i * 35;
      while (r > 30 && layout.waterDepth(bayX + r, bayZ) <= 2.5) r -= 8;
      dolphinList.push({
        cx: bayX, cz: bayZ, r, phase: (i / count) * TAU,
        ang: (i / count) * TAU,
        angSpeed: 0.055,
        x: bayX, y: 0, z: bayZ, yaw: 0, pitch: 0,
        scale: 1,
      });
    }
  }

  S.dolphin = addSpecies('dolphins', {
    base: 3, radius: 1100, castShadow: false, list: dolphinList,
    parts: [{ geo: dolphinHull }, { geo: dolphinTail }],
  });

  function updateDolphins(dt, px, pz) {
    const sp = S.dolphin;
    let near = 0;
    for (let i = 0; i < sp.count; i++) {
      const d = dolphinList[i];
      const dx = d.x - px, dz = d.z - pz;
      if (dx * dx + dz * dz > sp.radius * sp.radius) continue;
      near++;
      d.ang += d.angSpeed * dt;
      d.phase += dt * 0.42;
      d.x = d.cx + Math.cos(d.ang) * d.r;
      d.z = d.cz + Math.sin(d.ang) * d.r;
      const s = Math.sin(d.phase);
      d.y = -0.65 + Math.max(0, s) * 2.7;
      const sgn = 1;
      d.yaw = Math.atan2(-Math.sin(d.ang) * sgn, Math.cos(d.ang) * sgn);
      d.pitch = clamp(Math.cos(d.phase) * 0.9, -0.9, 0.9);
      const tail = Math.sin(d.phase * 3.1) * 0.32;
      rootAt(d.x, d.y, d.z, d.yaw, d.pitch, 0, d.scale);
      writeAtRoot(sp, 0, i);
      writePart(sp, 1, i, 0, 0, -1.05, tail, 0, 0);
    }
    sp.meshes[0].instanceMatrix.needsUpdate = true;
    sp.meshes[1].instanceMatrix.needsUpdate = true;
    return near;
  }

  // =========================================================================
  // Quality, stats and the per-frame update
  // =========================================================================

  let pointScale = 420;

  function applyQuality() {
    const raw = typeof preset.animalScale === 'number' && preset.animalScale > 0 ? preset.animalScale : 1;
    let total = 0;
    let tris = 0;
    for (const sp of species) {
      const want = Math.round(sp.base * raw);
      sp.count = clamp(want, Math.min(sp.min, sp.maxCount), sp.maxCount);
      for (const m of sp.meshes) {
        m.count = sp.count;
        m.castShadow = sp.castShadow && !!preset.shadows;
        const g = m.geometry;
        const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
        tris += t * sp.count;
      }
      stats[sp.id] = sp.count;
      total += sp.count;
    }
    ffCount = clamp(Math.round(FIREFLY_BASE * raw), 1, ffCap);
    stats.fireflies = ffCount;
    total += ffCount;
    stats.total = total;
    stats.drawCalls = group.children.length;
    stats.triangles = Math.round(tris);
  }

  /** Allocation-free: matrix writes for the animals near the player. */
  function update(dt, state) {
    let step = dt;
    if (!(step > 0)) step = 0;
    else if (step > 0.1) step = 0.1;
    const sdt = step > 0 ? step : 1 / 60;
    time += step;

    const st = state || null;
    const player = (st && st.player && st.player.position) || _origin;
    const px = player.x, pz = player.z;
    const hour = st && typeof st.hour === 'number' ? (((st.hour % 24) + 24) % 24) : 12;
    const rain = st && st.weather && typeof st.weather.rain === 'number' ? st.weather.rain : 0;
    const wind = st && st.wind;
    const windX = wind && typeof wind.x === 'number' ? wind.x : 0.7;
    const windZ = wind && typeof wind.z === 'number' ? wind.z : 0.5;
    const boost = st && st.photoMode ? 1.3 : 1;

    debug.hour = hour;
    const day = hour > 8 && hour < 18 && rain < 0.55;
    const night = hour >= 20 || hour < 5;
    const duskDawn = (hour > 4.5 && hour < 8.5) || (hour > 16.5 && hour < 20.5);
    debug.night = night;

    if (engine && engine.sizes) {
      const h = (engine.sizes.height || 720) * (engine.sizes.pixelRatio || 1);
      pointScale = h * 0.5;
    }

    for (const sp of species) sp.radius = sp.baseRadius * boost;

    // Butterflies and bees only fly on dry daylight, fish only jump in the
    // dawn/dusk window - outside it their updates are skipped entirely.
    const showBugs = day;
    const fishOn = duskDawn;

    S.gull.near = updateGulls(sdt, px, pz);
    S.duck.near = updateDucks(sdt, px, pz);
    S.heron.near = updateHerons(sdt, px, pz);
    S.rabbit.near = updateRabbits(sdt, px, pz);
    S.deer.near = updateDeer(sdt, px, pz);
    S.crab.near = updateCrabs(sdt, px, pz);
    S.butterfly.near = showBugs ? updateButterflies(sdt, px, pz) : 0;
    S.bee.near = showBugs ? updateBees(sdt, px, pz) : 0;
    debug.butterflyVisible = S.butterfly.near;
    debug.beeVisible = S.bee.near;
    S.fish.near = updateFish(sdt, px, pz, fishOn);
    S.dolphin.near = updateDolphins(sdt, px, pz);
    S.whale.near = updateWhale(sdt);

    // Freeze/hide: a species is drawn only while one of its individuals is
    // inside the active radius, so a rider who never leaves the road still
    // gets the flock overhead but pays nothing for empty corners of the island.
    let active = 0;
    for (const sp of species) {
      const on = sp.near > 0 && sp.count > 0;
      for (const m of sp.meshes) m.visible = on;
      if (on) active += sp.near;
    }

    updateRipples(sdt);
    active += updateFireflies(sdt, px, pz, night, windX, windZ);
    stats.active = active;
  }

  function setQuality(level) {
    const next = QUALITY_PRESETS[level];
    if (next) Object.assign(preset, next);
    applyQuality();
  }

  if (bus && typeof bus.on === 'function') {
    bus.on('quality:changed', (payload) => setQuality((payload && payload.level) || qualityLevel));
  }

  applyQuality();
  for (const sp of species) {
    for (const m of sp.meshes) {
      for (let i = 0; i < sp.capacity; i++) {
        _rootM.compose(_v.set(0, 0, 0), _quat.identity(), _scl.set(0, 0, 0));
        m.setMatrixAt(i, _rootM);
      }
      m.instanceMatrix.needsUpdate = true;
    }
  }
  for (let i = 0; i < RIPPLE_CAP; i++) {
    _rootM.compose(_v.set(0, -999, 0), _quat.identity(), _scl.set(0, 0, 0));
    rippleMesh.setMatrixAt(i, _rootM);
  }
  rippleMesh.instanceMatrix.needsUpdate = true;
  ffGeo.setDrawRange(0, 0);

  return { group, update, setQuality, stats, debug };
}
