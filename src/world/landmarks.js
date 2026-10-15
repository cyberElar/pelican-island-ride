/**
 * landmarks.js - the island's "postcard" set pieces.
 *
 * Everything here is procedural: no asset files, no network, shared materials
 * and per-piece merged geometry so the whole module costs ~100 draw calls.
 * Night lighting is emissive-only (never a real THREE.Light).
 *
 * Contract (docs/SPEC.md 4.11):
 *   createLandmarks(ctx) -> {
 *     group, update(dt, state), colliders, emitters, parts,
 *     stats: { count, tris }, samples
 *   }
 * `samples` is a debug/QA list of one ground anchor per set piece:
 * { id, x, y, z, baseY } where baseY is the elevation of the piece's ground
 * (or water) contact at (x, z) - the dev test checks it against
 * layout.heightAt(x, z). The sea arch and sea stacks anchor at y = 0.
 * `update()` allocates nothing and creates nothing.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Rng, SimplexNoise2D, clamp, clamp01, lerp, smoothstep, TAU, HALF_PI,
} from '../core/utils.js';

// ---------------------------------------------------------------------------
// Scratch objects - update() must never allocate
// ---------------------------------------------------------------------------

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const gBox = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const gCyl = (rt, rb, h, seg = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
const gCone = (r, h, seg = 12, open = false) => new THREE.ConeGeometry(r, h, seg, 1, open);
const gIco = (r, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
const gTorus = (r, tube, rs = 6, ts = 16, arc = TAU) => new THREE.TorusGeometry(r, tube, rs, ts, arc);
const gSphere = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const gPlane = (w, h, ws = 1, hs = 1) => new THREE.PlaneGeometry(w, h, ws, hs);

/**
 * Half-disc cap whose flat edge lies on y = 0 and whose arc opens upward.
 * Used for arched windows, doors and headstone tops.
 */
function gArch(radius, depth, seg = 10) {
  return gCyl(radius, radius, depth, seg, false, 0, Math.PI)
    .rotateX(HALF_PI)
    .rotateZ(HALF_PI);
}

/** Thin capped cylinder from A to B - ropes, branches, oars, braces. */
function strut(ax, ay, az, bx, by, bz, r, seg = 5) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = gCyl(r, r, len, seg, false);
  _dir.set(dx / len, dy / len, dz / len);
  _quat.setFromUnitVectors(_up, _dir);
  g.applyQuaternion(_quat);
  g.translate((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  return g;
}

/** Multiply UVs so a shared texture tiles at a sane physical size. */
function tileUV(geo, su, sv = su) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

/**
 * Per-vertex noise displacement. The offset is a pure function of the vertex
 * position, so coincident vertices on hard edges move together and the mesh
 * stays watertight.
 */
function displace(geo, amp, freq, noise, salt = 0) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = noise.noise(x * freq + salt, (z + y * 0.7) * freq - salt);
    const ny = noise.noise((y + z * 0.35) * freq + 11.7, x * freq - 3.1 - salt);
    const nz = noise.noise((z - x * 0.6) * freq + 7.3, y * freq + 19.1 + salt);
    pos.setXYZ(i, x + nx * amp, y + ny * amp * 0.7, z + nz * amp);
  }
  pos.needsUpdate = true;
  geo.deleteAttribute('normal');
  geo.computeVertexNormals();
  return geo;
}

/** Strip to position/normal/uv non-indexed so anything can merge with anything. */
function normalizeGeometry(geo) {
  let out = geo;
  if (out.index) {
    out = out.toNonIndexed();
    geo.dispose();
  }
  for (const key of Object.keys(out.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') out.deleteAttribute(key);
  }
  const count = out.attributes.position.count;
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) {
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return out;
}

/** Collects geometry per material, then merges each bucket into one mesh. */
function createBatcher() {
  const buckets = new Map();
  return {
    add(mat, geo) {
      const g = normalizeGeometry(geo);
      const list = buckets.get(mat);
      if (list) list.push(g);
      else buckets.set(mat, [g]);
      return g;
    },
    flush(parent, opts = {}) {
      const castShadow = opts.castShadow !== false;
      const receiveShadow = opts.receiveShadow !== false;
      let meshes = 0;
      for (const [mat, list] of buckets) {
        const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
        if (!merged) {
          for (const g of list) {
            const m = new THREE.Mesh(g, mat);
            m.castShadow = castShadow;
            m.receiveShadow = receiveShadow;
            parent.add(m);
            meshes++;
          }
          continue;
        }
        if (merged !== list[0]) for (const g of list) g.dispose();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        if (opts.name) mesh.name = opts.name;
        parent.add(mesh);
        meshes++;
      }
      buckets.clear();
      return meshes;
    },
  };
}

/** 0 by day, 1 deep at night (dusk/dawn ramps). */
function nightAmount(hour) {
  const h = ((hour % 24) + 24) % 24;
  const dusk = smoothstep(17.75, 19.5, h);
  const dawn = 1 - smoothstep(4.9, 6.6, h);
  return clamp01(Math.max(dusk, dawn));
}

// ---------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------

function surfaceMat(surf, opts) {
  return new THREE.MeshStandardMaterial(Object.assign({
    map: (surf && surf.map) || null,
    normalMap: (surf && surf.normalMap) || null,
    roughnessMap: (surf && surf.roughnessMap) || null,
    roughness: 0.92,
    metalness: 0,
  }, opts || {}));
}

function createMaterials(TEX) {
  const M = {};
  M.stone = surfaceMat(TEX.stoneWall(), { roughness: 0.95 });
  M.stoneLight = surfaceMat(TEX.stoneWall(), { color: 0xe9e2d4, roughness: 0.9 });
  M.rock = surfaceMat(TEX.rock(), { roughness: 0.98 });
  M.rockDark = surfaceMat(TEX.rock(), { color: 0x8d9198, roughness: 0.98 });
  M.rockMoss = surfaceMat(TEX.rock(), { color: 0x8b9a70, roughness: 0.98 });
  M.cliff = surfaceMat(TEX.cliff(), { roughness: 0.98 });
  M.plaster = surfaceMat(TEX.plaster('#f2e8d5'), { roughness: 0.86 });
  M.plasterWhite = surfaceMat(TEX.plaster('#fbf7ee'), { roughness: 0.82 });
  M.roof = surfaceMat(TEX.roofTile('#a8483a'), { roughness: 0.9 });
  M.roofSlate = surfaceMat(TEX.roofTile('#767b83'), { roughness: 0.9 });
  M.roofThatch = surfaceMat(TEX.thatch(), { roughness: 0.95 });
  M.wood = surfaceMat(TEX.wood({ tone: 'dark' }), { roughness: 0.86 });
  M.plank = surfaceMat(TEX.planks(), { roughness: 0.86 });
  M.bark = surfaceMat(TEX.bark(), { roughness: 0.95 });
  M.metal = surfaceMat(TEX.metal({ color: '#71767e', rough: 0.45 }), { roughness: 0.5, metalness: 0.55 });
  M.rust = surfaceMat(TEX.metal({ color: '#8d5a37', rough: 0.9 }), { roughness: 0.95, metalness: 0.25 });
  M.rope = surfaceMat(TEX.rope(), { roughness: 0.95 });
  M.wicker = surfaceMat(TEX.wicker(), { roughness: 0.9 });
  M.fabricCream = surfaceMat(TEX.fabric({ color: '#f2e8d5' }), { roughness: 0.85 });
  M.tent = surfaceMat(TEX.fabric({ color: '#d9c9a6', stripeColor: '#a8564a', stripeFreq: 5 }), { roughness: 0.9 });
  M.sail = surfaceMat(TEX.fabric({ color: '#efe4cd', stripeColor: '#5b7fd4', stripeFreq: 4 }), { roughness: 0.85 });
  M.blanket = surfaceMat(TEX.fabric({ color: '#c0503f', stripeColor: '#efe0c8', stripeFreq: 6 }), { roughness: 0.92 });
  M.leaf = new THREE.MeshStandardMaterial({ color: 0x5d8a3a, roughness: 0.9 });
  M.leafDark = new THREE.MeshStandardMaterial({ color: 0x375c37, roughness: 0.9 });
  M.weed = new THREE.MeshStandardMaterial({ color: 0x6f8f3d, roughness: 0.95 });
  M.flowerRed = new THREE.MeshStandardMaterial({ color: 0xe0523f, roughness: 0.75 });
  M.flowerBlue = new THREE.MeshStandardMaterial({ color: 0x5b7fd4, roughness: 0.75 });
  M.flowerCream = new THREE.MeshStandardMaterial({ color: 0xf0e2b6, roughness: 0.75 });
  M.gull = new THREE.MeshStandardMaterial({ color: 0xf6f4ee, roughness: 0.8 });
  M.lens = new THREE.MeshStandardMaterial({
    color: 0xffe3b0, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0.4,
    roughness: 0.25, metalness: 0.2,
  });
  M.glass = new THREE.MeshStandardMaterial({
    color: 0xcfe2e6, roughness: 0.1, metalness: 0,
    transparent: true, opacity: 0.34, side: THREE.DoubleSide,
  });
  M.window = new THREE.MeshStandardMaterial({
    color: 0x3c3830, emissive: new THREE.Color(0xffcf8c), emissiveIntensity: 0, roughness: 0.4,
  });
  M.lamp = new THREE.MeshStandardMaterial({
    color: 0x4a443a, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0, roughness: 0.4,
  });
  M.burner = new THREE.MeshStandardMaterial({
    color: 0x4a3a2c, emissive: new THREE.Color(0xff9a3c), emissiveIntensity: 0, roughness: 0.6,
  });
  M.beam = new THREE.MeshBasicMaterial({
    color: 0xffe6bb, transparent: true, opacity: 0.12, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
  M.balloonA = surfaceMat(TEX.fabric({ color: '#f2e8d5' }), { roughness: 0.8 });
  M.balloonB = surfaceMat(TEX.fabric({ color: '#1f6f78' }), { roughness: 0.8 });
  M.balloonC = surfaceMat(TEX.fabric({ color: '#e0523f' }), { roughness: 0.8 });
  M.balloonD = surfaceMat(TEX.fabric({ color: '#e8b64c' }), { roughness: 0.8 });
  M.balloonE = surfaceMat(TEX.fabric({ color: '#5b7fd4' }), { roughness: 0.8 });
  M.balloonF = surfaceMat(TEX.fabric({ color: '#2f5d8a' }), { roughness: 0.8 });
  // Translucent decals (conform to the terrain, so no z-fighting).
  M.dirtDecal = surfaceMat(TEX.dirt(), {
    transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  M.foamDecal = surfaceMat(TEX.foam(), {
    transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
    roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  return M;
}

// ---------------------------------------------------------------------------
// createLandmarks
// ---------------------------------------------------------------------------

export function createLandmarks(ctx) {
  const layout = ctx.layout;
  const TEX = ctx.textures;
  const quality = ctx.quality || 'high';
  const preset = (ctx.engine && ctx.engine.preset) || null;
  const detail = quality === 'low' ? 0.5 : quality === 'medium' ? 0.75 : 1;
  const rng = new Rng('landmarks:' + layout.seed);
  const noise = new SimplexNoise2D('landmarks:' + layout.seed);
  const M = createMaterials(TEX);

  const group = new THREE.Group();
  group.name = 'landmarks';

  const colliders = [];
  const emitters = [];
  const samples = [];
  const parts = {};
  const ids = [];
  const nightLights = [];      // { mat, max } - emissive only, driven by state.hour
  const animated = [];         // { obj, ... } balloons and small idlers

  const ground = (x, z) => layout.heightAt(x, z);
  const seaAngle = (x, z) => Math.atan2(z, x);   // outward radial heading

  function registerNightLight(mat, max) {
    for (let i = 0; i < nightLights.length; i++) {
      if (nightLights[i].mat === mat) {
        if (max > nightLights[i].max) nightLights[i].max = max;
        return mat;
      }
    }
    nightLights.push({ mat, max });
    return mat;
  }

  /** Every set piece goes through here: anchor, merge, expose a sample. */
  function createPiece(id, x, z, y, rotY = 0) {
    const holder = new THREE.Group();
    holder.name = id;
    holder.position.set(x, y, z);
    holder.rotation.y = rotY;
    group.add(holder);
    ids.push(id);
    samples.push({ id, x, y, z, baseY: y });
    return { b: createBatcher(), holder };
  }

  // =========================================================================
  // 1. Lighthouse + keeper's cottage
  // =========================================================================

  {
    const p = layout.pois.lighthouse.position;
    const baseY = ground(p.x, p.z) - 0.4;
    const rot = HALF_PI - seaAngle(p.x, p.z);      // local +Z points out to sea
    const scope = createPiece('lighthouse', p.x, p.z, baseY, rot);
    const { b, holder } = scope;
    const R = 3.3, TOP = 22;

    // Tapered stone tower + white plaster bands.
    b.add(M.stone, tileUV(gCyl(R * 0.62, R, TOP, 20).translate(0, TOP * 0.5, 0), 7, 8));
    b.add(M.stone, gCyl(R * 1.24, R * 1.34, 0.7, 20).translate(0, 0.32, 0));
    for (let i = 0; i < 4; i++) {
      const y = 3.4 + i * 5.1;
      const t = y / TOP;
      const r = lerp(R, R * 0.62, t) + 0.09;
      b.add(M.plasterWhite, gCyl(r, r, 1.05, 20).translate(0, y, 0));
    }
    // Gallery deck + railing.
    b.add(M.stoneLight, gCyl(2.55, 2.9, 0.5, 20).translate(0, TOP + 0.25, 0));
    b.add(M.metal, tileUV(gTorus(2.5, 0.05, 5, 28).rotateX(HALF_PI).translate(0, TOP + 1.35, 0), 10, 1));
    b.add(M.metal, gTorus(2.5, 0.05, 5, 28).rotateX(HALF_PI).translate(0, TOP + 0.85, 0));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      b.add(M.metal, gCyl(0.045, 0.045, 1.1, 5)
        .translate(Math.cos(a) * 2.5, TOP + 0.85, Math.sin(a) * 2.5));
    }
    // Lamp room: glass shell + roof + ball finial.
    b.add(M.glass, gCyl(1.62, 1.62, 2.6, 16, true).translate(0, TOP + 1.8, 0));
    b.add(M.metal, gCyl(1.72, 1.72, 0.14, 16).translate(0, TOP + 0.62, 0));
    b.add(M.metal, gCyl(1.72, 1.72, 0.14, 16).translate(0, TOP + 3.0, 0));
    b.add(M.metal, gCone(1.9, 1.1, 16).translate(0, TOP + 3.6, 0));
    b.add(M.metal, gSphere(0.22, 8, 6).translate(0, TOP + 4.25, 0));
    // Fresnel lens + rotating beam rig.
    const rotator = new THREE.Group();
    rotator.position.set(0, TOP + 1.95, 0);
    holder.add(rotator);
    const lens = new THREE.Mesh(gCyl(0.85, 0.95, 1.5, 12), M.lens);
    lens.position.y = -0.15;
    const ribGeo = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ribGeo.push(gBox(0.16, 1.35, 0.34)
        .translate(Math.cos(a) * 0.82, -0.15, Math.sin(a) * 0.82));
    }
    const ribs = new THREE.Mesh(mergeGeometries(ribGeo.map(normalizeGeometry), false), M.lens);
    rotator.add(lens, ribs);
    const beamGeo = gCone(3.0, 115, 18, true).rotateZ(HALF_PI).translate(57.5, 0, 0);
    const beam = new THREE.Mesh(beamGeo, M.beam);
    beam.frustumCulled = false;
    rotator.add(beam);
    parts.beamRotator = rotator;
    parts.beam = beam;
    parts.beamMat = M.beam;
    parts.lens = lens;
    parts.lensMat = M.lens;
    registerNightLight(M.lens, 2.4);

    // Keeper's cottage beside the tower.
    const cx = -9.5, cz = 5.5, cw = 7.2, cd = 5.4, ch = 3.1;
    b.add(M.plaster, gBox(cw, ch, cd).translate(cx, ch * 0.5, cz));
    b.add(M.roof, gBox(cw + 0.7, 0.28, cd + 0.7).translate(cx, ch + 0.14, cz));
    const roofA = gBox(cw + 0.5, 0.22, cd * 0.62).rotateX(0.42).translate(cx, ch + 0.75, cz - cd * 0.24);
    const roofB = gBox(cw + 0.5, 0.22, cd * 0.62).rotateX(-0.42).translate(cx, ch + 0.75, cz + cd * 0.24);
    b.add(M.roof, roofA);
    b.add(M.roof, roofB);
    b.add(M.roof, gBox(cw + 0.6, 0.3, 0.5).translate(cx, ch + 1.32, cz));
    b.add(M.stone, gBox(0.7, 1.5, 0.7).translate(cx + 2.2, ch + 1.9, cz - 1.2));
    b.add(M.wood, gBox(0.95, 2.0, 0.12).translate(cx + 0.6, 1.0, cz + cd * 0.5 + 0.05));
    b.add(M.window, gBox(1.0, 1.0, 0.14).translate(cx - 2.0, 1.85, cz + cd * 0.5 + 0.04));
    b.add(M.window, gBox(0.14, 1.0, 1.0).translate(cx + cw * 0.5 + 0.04, 1.85, cz - 0.9));
    registerNightLight(M.window, 1.5);
    // Low stone wall along the seaward side.
    for (let i = 0; i < 16; i++) {
      const a = -1.35 + (i / 15) * 2.7;
      const wx = cx + Math.sin(a) * 11.5 - 2.0;
      const wz = cz + Math.cos(a) * 11.5;
      b.add(M.stone, gBox(1.5, 0.85, 0.45).rotateY(-a).translate(wx, 0.42, wz));
      b.add(M.stoneLight, gBox(1.6, 0.14, 0.6).rotateY(-a).translate(wx, 0.92, wz));
    }
    // Three steps up to the tower door.
    for (let i = 0; i < 3; i++) {
      b.add(M.stoneLight, gBox(2.0, 0.22, 1.0 - i * 0.22)
        .translate(0, 0.12 + i * 0.22, R * 1.35 + 0.5 - i * 0.22));
    }
    b.add(M.wood, gBox(1.1, 2.1, 0.14).translate(0, 1.45, R * 0.98 + 0.02));
    // Bench facing the sea (local +Z is seaward after the holder rotation).
    const bx = 0, bz = 13.5;
    b.add(M.plank, gBox(1.9, 0.12, 0.55).translate(bx, 0.62, bz));
    b.add(M.plank, gBox(1.9, 0.55, 0.1).translate(bx, 0.95, bz + 0.3));
    b.add(M.wood, gBox(0.1, 0.62, 0.5).translate(bx - 0.8, 0.31, bz));
    b.add(M.wood, gBox(0.1, 0.62, 0.5).translate(bx + 0.8, 0.31, bz));
    // Flower clumps on the seaward slope.
    const flowerMats = [M.flowerRed, M.flowerBlue, M.flowerCream];
    for (let f = 0; f < 3; f++) {
      const mats = flowerMats[f];
      const count = Math.round(18 * detail);
      const mesh = new THREE.InstancedMesh(gIco(0.17, 0), mats, count);
      for (let i = 0; i < count; i++) {
        const a = rng.range(-1.9, 1.9);
        const r = rng.range(6, 13);
        const fx = Math.sin(a) * r - 1;
        const fz = Math.cos(a) * r + 1;
        const w = localToWorld(p.x, p.z, rot, fx, fz);
        _mat4.makeTranslation(fx, ground(w.x, w.z) - baseY + 0.12, fz);
        mesh.setMatrixAt(i, _mat4);
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      holder.add(mesh);
    }

    b.flush(holder, { name: 'lighthouse' });
    colliders.push({ x: p.x, z: p.z, r: 4 });
    const cottage = localToWorld(p.x, p.z, rot, -9.5, 5.5);
    colliders.push({ x: cottage.x, z: cottage.z, r: 6 });
  }

  // =========================================================================
  // 2. Standing stones
  // =========================================================================

  {
    const p = layout.pois.standingStones.position;
    const baseY = ground(p.x, p.z) - 0.3;
    const rot = rng.range(0, TAU);
    const scope = createPiece('standingStones', p.x, p.z, baseY, rot);
    const { b, holder } = scope;
    const ringR = 9.0;
    const count = 9 + rng.irange(0, 2);
    const startA = rng.range(0, TAU);

    for (let i = 0; i < count; i++) {
      const a = startA + (i / count) * TAU + rng.range(-0.06, 0.06);
      const x = Math.cos(a) * ringR;
      const z = Math.sin(a) * ringR;
      const h = rng.range(2.7, 4.6);
      const w = rng.range(1.1, 1.9);
      const d = rng.range(0.55, 0.95);
      const geo = tileUV(gBox(w, h, d, 2, 3, 1), 2.2, 2.6);
      displace(geo, 0.16, 0.35, noise, i * 3.7);
      geo.rotateX(rng.range(-0.09, 0.09));
      geo.rotateZ(rng.range(-0.11, 0.11));
      const wpos = localToWorld(p.x, p.z, rot, x, z);
      geo.translate(x, ground(wpos.x, wpos.z) - baseY + h * 0.5 - 0.25, z);
      b.add(M.rock, geo);
    }
    // Altar slab with a carved spiral.
    b.add(M.rock, tileUV(gBox(2.4, 0.45, 1.7, 2, 1, 2), 1.6).translate(0, 0.22, 0));
    b.add(M.rock, gBox(1.5, 0.22, 1.1).translate(0, 0.52, 0));
    const spiralCanvas = drawSpiral(TEX);
    if (spiralCanvas) {
      const tex = TEX.texture(spiralCanvas, { repeat: 1, wrap: THREE.ClampToEdgeWrapping });
      const decal = new THREE.Mesh(gPlane(2.2, 1.55), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.88, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      decal.rotation.x = -HALF_PI;
      decal.position.y = 0.641;
      holder.add(decal);
      parts.spiralDecal = decal;
    }
    // Worn path ring (conforms to the terrain).
    b.add(M.dirtDecal, terrainRing(layout, p.x, p.z, 7.6, 9.9, 56, 0.07, baseY));
    b.flush(holder, { name: 'standingStones' });
    colliders.push({ x: p.x, z: p.z, r: 3 });
  }

  // =========================================================================
  // 3. Treehouse
  // =========================================================================

  {
    const p = layout.pois.treehouse.position;
    const baseY = ground(p.x, p.z) - 0.6;
    const scope = createPiece('treehouse', p.x, p.z, baseY, rng.range(0, TAU));
    const { b, holder } = scope;
    const PLAT = 7.0;

    // Earth mound skirt so the trunk meets the sloped rock cleanly.
    b.add(M.rock, displace(gCyl(3.4, 4.6, 1.6, 14).translate(0, 0.1, 0), 0.28, 0.5, noise, 5));
    // Trunk (flared lathe) + noise.
    const profile = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      profile.push(new THREE.Vector2(0.62 + 1.35 * Math.pow(1 - t, 2.4), 0.4 + t * 13.6));
    }
    b.add(M.bark, displace(tileUV(new THREE.LatheGeometry(profile, 11), 5, 7), 0.13, 0.55, noise, 9));
    // Limbs.
    b.add(M.bark, strut(0, 4.2, 0, 3.4, 8.6, 1.4, 0.5, 7));
    b.add(M.bark, strut(0, 5.2, 0, -3.0, 9.4, -1.6, 0.44, 7));
    b.add(M.bark, strut(0, 6.4, 0, 0.6, 10.6, -3.4, 0.36, 7));
    b.add(M.bark, strut(0, 8.4, 0, 1.2, 13.2, 0.8, 0.3, 6));
    // Canopy blobs.
    const blobs = [[0.4, 11.4, 0.2, 3.5], [-3.2, 10.2, -1.6, 2.5], [3.5, 9.4, 1.5, 2.4], [0.6, 13.6, -0.6, 2.2]];
    for (let i = 0; i < blobs.length; i++) {
      const [x, y, z, r] = blobs[i];
      b.add(M.leaf, displace(gIco(r, 1), r * 0.22, 0.7, noise, 20 + i * 4).translate(x, y, z));
    }
    // Platform + railings.
    b.add(M.plank, tileUV(gCyl(3.5, 3.5, 0.28, 8).translate(0, PLAT, 0), 4));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.4;
      const x = Math.cos(a) * 3.35;
      const z = Math.sin(a) * 3.35;
      b.add(M.wood, gBox(0.14, 1.05, 0.14).translate(x, PLAT + 0.62, z));
    }
    const railGeo = tileUV(new THREE.TorusGeometry(3.35, 0.07, 5, 20), 8, 1);
    railGeo.rotateX(HALF_PI);
    railGeo.translate(0, PLAT + 1.1, 0);
    b.add(M.wood, railGeo);
    // Cabin with a pitched roof.
    b.add(M.plank, tileUV(gBox(4.4, 2.5, 3.6), 4, 2).translate(0, PLAT + 1.4, 0));
    b.add(M.roofSlate, gBox(4.9, 0.2, 2.4).rotateX(0.62).translate(0, PLAT + 3.3, 0.95));
    b.add(M.roofSlate, gBox(4.9, 0.2, 2.4).rotateX(-0.62).translate(0, PLAT + 3.3, -0.95));
    const gable = new THREE.Shape();
    gable.moveTo(-1.95, 0);
    gable.lineTo(1.95, 0);
    gable.lineTo(0, 1.2);
    gable.closePath();
    b.add(M.plank, new THREE.ExtrudeGeometry(gable, { depth: 0.14, bevelEnabled: false })
      .translate(-0.0, PLAT + 2.6, 1.72));
    b.add(M.plank, new THREE.ExtrudeGeometry(gable, { depth: 0.14, bevelEnabled: false })
      .translate(0, PLAT + 2.6, -1.86));
    b.add(M.wood, gBox(0.85, 1.7, 0.12).translate(-1.2, PLAT + 0.9, 1.82));
    b.add(M.window, gBox(0.7, 0.7, 0.12).translate(1.3, PLAT + 1.7, 1.82));
    registerNightLight(M.window, 1.4);
    // Rope ladder down the trunk.
    {
      // The ladder leans against the flaring trunk: wide at the ground, tight
      // against the bark up at the platform.
      const ladderPoint = (t, side) => {
        const u = lerp(1.98, 1.06, t) * Math.SQRT1_2;
        return { x: u + side * 0.28, y: 0.6 + t * (PLAT - 0.6), z: u };
      };
      const bl = ladderPoint(0, -1);
      const br = ladderPoint(0, 1);
      const tl = ladderPoint(1, -1);
      const tr = ladderPoint(1, 1);
      b.add(M.rope, strut(bl.x, bl.y, bl.z, tl.x, tl.y, tl.z, 0.05, 5));
      b.add(M.rope, strut(br.x, br.y, br.z, tr.x, tr.y, tr.z, 0.05, 5));
      for (let i = 0; i <= 7; i++) {
        const l = ladderPoint(i / 7, -1);
        const r2 = ladderPoint(i / 7, 1);
        b.add(M.wood, strut(l.x, l.y, l.z, r2.x, r2.y, r2.z, 0.045, 5));
      }
    }
    // Bucket pulley.
    b.add(M.wood, gBox(0.14, 0.14, 1.2).translate(2.55, PLAT + 2.2, -0.4));
    b.add(M.wood, gCyl(0.26, 0.26, 0.1, 10).rotateZ(HALF_PI).translate(2.55, PLAT + 2.05, -1.0));
    b.add(M.rope, strut(2.55, PLAT + 2.02, -1.0, 2.55, PLAT + 0.1, -1.0, 0.035, 5));
    b.add(M.wood, gCyl(0.3, 0.24, 0.42, 10).translate(2.55, PLAT - 0.12, -1.0));
    b.add(M.metal, gTorus(0.3, 0.035, 4, 12, Math.PI).rotateY(HALF_PI).translate(2.55, PLAT + 0.08, -1.0));
    // Hammock between the trunk and a limb.
    {
      const rows = 6, cols = 4;
      const pos = [];
      const idx = [];
      for (let i = 0; i <= cols; i++) {
        for (let j = 0; j <= rows; j++) {
          const u = i / cols;
          const v = j / rows;
          const x = lerp(-6.4, -0.7, u);
          const z = lerp(-3.0, 1.4, v);
          const sag = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.85;
          pos.push(x, PLAT - 0.5 - sag, z);
        }
      }
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const a = i * (rows + 1) + j;
          idx.push(a, a + 1, a + rows + 1, a + 1, a + rows + 2, a + rows + 1);
        }
      }
      const hg = new THREE.BufferGeometry();
      hg.setIndex(idx);
      hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      hg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2).fill(0.5), 2));
      hg.computeVertexNormals();
      b.add(M.sail, hg);
      b.add(M.rope, strut(-6.4, PLAT - 0.5, -0.8, -6.9, PLAT + 1.9, -1.9, 0.04, 5));
      b.add(M.rope, strut(-0.7, PLAT - 0.5, -0.8, -0.2, PLAT + 2.1, -1.9, 0.04, 5));
    }
    // Lanterns + string lights.
    const lanternPos = [[2.1, PLAT + 2.05, 1.5], [-2.1, PLAT + 2.0, 1.5], [0.2, PLAT + 3.0, -1.9]];
    for (const [lx, ly, lz] of lanternPos) {
      b.add(M.metal, gCyl(0.16, 0.14, 0.3, 8).translate(lx, ly, lz));
      b.add(M.lamp, gCyl(0.1, 0.1, 0.22, 8).translate(lx, ly, lz));
      b.add(M.metal, gCone(0.19, 0.12, 8).translate(lx, ly + 0.2, lz));
    }
    registerNightLight(M.lamp, 2.0);
    {
      const beads = 20;
      const linePts = [];
      const beadGeo = gIco(0.075, 0);
      const beadsMesh = new THREE.InstancedMesh(beadGeo, M.lamp, beads);
      for (let i = 0; i < beads; i++) {
        const t = i / (beads - 1);
        const a = -2.1 + t * 3.6;
        const x = Math.cos(a) * 3.3;
        const z = Math.sin(a) * 3.3;
        const y = PLAT + 1.5 + Math.sin(t * Math.PI) * 0.7 + Math.sin(t * 12.0) * 0.06;
        linePts.push(x, y, z);
        _mat4.makeTranslation(x, y, z);
        beadsMesh.setMatrixAt(i, _mat4);
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x2c2823 }));
      beadsMesh.castShadow = false;
      holder.add(line, beadsMesh);
      parts.stringLights = beadsMesh;
    }

    b.flush(holder, { name: 'treehouse' });
    colliders.push({ x: p.x, z: p.z, r: 1.2 });
  }

  // =========================================================================
  // 4. Old watchtower ruins + explorer's camp
  // =========================================================================

  {
    const p = layout.pois.ruins.position;
    const baseY = ground(p.x, p.z) - 0.5;
    const scope = createPiece('ruins', p.x, p.z, baseY, rng.range(0, TAU));
    const { b, holder } = scope;
    const R = 3.4;

    // Solid lower drum, then a jagged crown of stone blocks.
    b.add(M.stone, tileUV(gCyl(R * 0.97, R * 1.06, 3.4, 16), 5, 2).translate(0, 1.7, 0));
    b.add(M.stone, tileUV(gCyl(R * 1.12, R * 1.2, 0.55, 16), 5, 1).translate(0, 0.25, 0));
    const blocks = 26;
    for (let i = 0; i < blocks; i++) {
      const a = (i / blocks) * TAU;
      if ((i > 15 && i < 19) || i === 7) continue;      // collapsed breach
      const h = 4.0 + 5.2 * (0.5 + 0.5 * noise.noise(i * 0.7, 3.1)) - (i > 19 ? 3.4 : 0);
      const hh = Math.max(1.2, h);
      const geo = tileUV(gBox(1.0, hh, 0.82, 2, 2, 1), 1.6, 1.6);
      displace(geo, 0.08, 0.7, noise, i * 2.3);
      geo.rotateY(-a);
      geo.translate(Math.cos(a) * R, 3.4 + hh * 0.5 - 0.2, Math.sin(a) * R);
      b.add(M.stone, geo);
    }
    // Crumbling wall fragments running away from the tower.
    for (let run = 0; run < 3; run++) {
      const a = 2.2 - run * 1.05;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const len = 7 + run * 2.5;
      for (let i = 0; i < 8; i++) {
        const t = i / 7;
        const h = (1.7 - t * 1.05) * (0.7 + 0.6 * noise.noise01(i * 0.9, run * 3.7));
        if (h < 0.25) continue;
        const x = dx * (R + 1.0 + t * len);
        const z = dz * (R + 1.0 + t * len);
        const g = tileUV(gBox(1.5, h, 0.7, 2, 1, 1), 1.4);
        displace(g, 0.07, 0.9, noise, run * 8 + i);
        g.rotateY(-a);
        g.translate(x, h * 0.5 - 0.15, z);
        b.add(M.stone, g);
      }
    }
    // Fallen arch doorway: surviving jamb, collapsed voussoirs, keystone.
    b.add(M.stone, tileUV(gBox(0.9, 3.4, 1.1, 2, 2, 1), 1.2, 2.4).translate(-1.9, 1.6, -R - 0.9));
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const a = -0.1 + t * 1.9;
      const g = tileUV(gBox(0.75, 1.05, 1.0, 2, 1, 2), 1.1);
      displace(g, 0.06, 1.1, noise, 40 + i);
      g.rotateZ(a);
      g.rotateY(0.5 + t * 0.25);
      g.translate(-1.35 + Math.sin(a) * 2.3, 2.9 + Math.cos(a) * 2.0 - 0.6, -R - 0.9 + 0.15 * i);
      b.add(M.stone, g);
    }
    b.add(M.stone, tileUV(gBox(1.25, 0.85, 1.2, 2, 1, 2), 1.2).rotateY(0.6).rotateX(0.2)
      .translate(2.6, 0.4, -R - 2.4));
    // Weeds inside and around the ruin.
    {
      const count = Math.round(46 * detail);
      const mesh = new THREE.InstancedMesh(gCone(0.16, 0.75, 4), M.weed, count);
      for (let i = 0; i < count; i++) {
        const a = rng.range(0, TAU);
        const r = Math.sqrt(rng.float()) * (R - 0.4);
        _mat4.makeRotationY(rng.range(0, TAU));
        _mat4.setPosition(Math.cos(a) * r, 0.28 + rng.range(-0.1, 0.15), Math.sin(a) * r);
        mesh.setMatrixAt(i, _mat4);
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      holder.add(mesh);
    }
    // Explorer's camp: tent, crate, map table.
    const tentX = 7.6;
    const tentZ = 4.4;
    b.add(M.tent, gBox(2.9, 0.12, 2.4).rotateX(0.66).translate(tentX, 1.02, tentZ - 0.62));
    b.add(M.tent, gBox(2.9, 0.12, 2.4).rotateX(-0.66).translate(tentX, 1.02, tentZ + 0.62));
    b.add(M.wood, strut(tentX - 1.5, 0.1, tentZ - 1.15, tentX - 1.5, 1.65, tentZ, 0.06, 5));
    b.add(M.wood, strut(tentX - 1.5, 1.65, tentZ, tentX - 1.5, 0.1, tentZ + 1.15, 0.06, 5));
    b.add(M.rope, strut(tentX - 1.5, 1.6, tentZ, tentX - 3.6, 0.05, tentZ, 0.03, 4));
    b.add(M.wood, gBox(0.9, 0.72, 0.86).translate(tentX + 2.6, 0.36, tentZ - 2.2));
    b.add(M.wood, gBox(1.0, 0.1, 0.94).translate(tentX + 2.6, 0.76, tentZ - 2.2));
    b.add(M.plank, gBox(1.5, 0.1, 1.0).translate(tentX + 1.0, 0.9, tentZ + 2.5));
    b.add(M.wood, strut(tentX + 0.45, 0.05, tentZ + 2.15, tentX + 0.45, 0.9, tentZ + 2.15, 0.07, 5));
    b.add(M.wood, strut(tentX + 1.55, 0.05, tentZ + 2.15, tentX + 1.55, 0.9, tentZ + 2.15, 0.07, 5));
    b.add(M.wood, strut(tentX + 0.45, 0.05, tentZ + 2.85, tentX + 0.45, 0.9, tentZ + 2.85, 0.07, 5));
    b.add(M.wood, strut(tentX + 1.55, 0.05, tentZ + 2.85, tentX + 1.55, 0.9, tentZ + 2.85, 0.07, 5));
    b.add(M.fabricCream, gBox(1.35, 0.04, 0.9).translate(tentX + 1.0, 0.96, tentZ + 2.5));

    b.flush(holder, { name: 'ruins' });
    colliders.push({ x: p.x, z: p.z, r: 6 });
  }

  // =========================================================================
  // 5. Sea arch + sea stacks (water anchors, y = 0)
  // =========================================================================

  {
    const p = layout.pois.arch.position;
    const scope = createPiece('seaArch', p.x, p.z, 0, Math.atan2(p.x, p.z));
    const { b, holder } = scope;
    const shape = new THREE.Shape();
    shape.moveTo(-10.5, -7);
    shape.lineTo(-10.5, 15);
    shape.quadraticCurveTo(-10.5, 26, 0, 26);
    shape.quadraticCurveTo(10.5, 26, 10.5, 15);
    shape.lineTo(10.5, -7);
    shape.lineTo(6.4, -7);
    shape.lineTo(6.4, 14);
    shape.quadraticCurveTo(6.4, 20.6, 0, 20.6);
    shape.quadraticCurveTo(-6.4, 20.6, -6.4, 14);
    shape.lineTo(-6.4, -7);
    shape.closePath();
    const archGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 9.5, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.4,
      bevelSegments: 1, curveSegments: 9,
    });
    archGeo.translate(0, 0, -4.75);
    displace(archGeo, 0.62, 0.055, noise, 3);
    tileUV(archGeo, 0.14);
    b.add(M.cliff, archGeo);
    // Barnacle shelf + a couple of boulders at the feet.
    b.add(M.rockDark, displace(gCyl(2.6, 3.4, 2.2, 9).translate(-9.4, -5.2, 0), 0.5, 0.3, noise, 5));
    b.add(M.rockDark, displace(gCyl(2.9, 3.8, 2.0, 9).translate(9.6, -5.4, 0.6), 0.5, 0.3, noise, 6));
    b.add(M.rockDark, displace(gIco(1.7, 1).translate(7.2, -4.4, 3.2), 0.35, 0.4, noise, 7));
    b.add(M.foamDecal, new THREE.RingGeometry(2.2, 4.6, 26).rotateX(-HALF_PI).translate(-9.4, 0.05, 0));
    b.add(M.foamDecal, new THREE.RingGeometry(2.4, 5.0, 26).rotateX(-HALF_PI).translate(9.6, 0.05, 0.6));
    // Nesting bird dots along the crown.
    {
      const N = Math.round(46 * detail);
      const birds = new THREE.InstancedMesh(gIco(0.3, 0), M.gull, N);
      const p0x = -10.5, p0y = 15, p1x = 0, p1y = 31, p2x = 10.5, p2y = 15;
      for (let i = 0; i < N; i++) {
        const t = rng.float();
        const mt = 1 - t;
        const x = mt * mt * p0x + 2 * mt * t * p1x + t * t * p2x;
        const y = mt * mt * p0y + 2 * mt * t * p1y + t * t * p2y;
        _mat4.makeTranslation(x + rng.range(-0.5, 0.5), y + rng.range(-0.4, 0.6), rng.range(-3.4, 3.4));
        birds.setMatrixAt(i, _mat4);
      }
      birds.castShadow = false;
      birds.receiveShadow = false;
      holder.add(birds);
      parts.archBirds = birds;
    }
    b.flush(holder, { name: 'seaArch' });
  }

  {
    const p = layout.pois.seaStacks.position;
    const scope = createPiece('seaStacks', p.x, p.z, 0, rng.range(0, TAU));
    const { b, holder } = scope;
    // [x, z, base radius, height above the waterline (12..24 m)]
    const SUBMERGE = 6;                       // the stacks rise out of 6 m of water
    const stacks = [
      [-12, 6, 5.6, 23.0], [4, -8, 4.4, 17.0], [13, 9, 3.4, 12.5],
      [-4, 12, 2.6, 15.0], [-20, -9, 3.0, 20.0], [20, -2, 2.2, 12.0],
    ];
    for (let i = 0; i < stacks.length; i++) {
      const sx = stacks[i][0];
      const sz = stacks[i][1];
      const r = stacks[i][2];
      const above = stacks[i][3];
      const h = above + SUBMERGE;
      const g = gCyl(r * 0.5, r, h, 9, true);
      g.translate(sx, above - h * 0.5, sz);
      displace(g, r * 0.22, 0.22, noise, i * 5.5);
      tileUV(g, 3, 4);
      b.add(M.cliff, g);
      for (let k = 0; k < 3; k++) {
        const a = rng.range(0, TAU);
        const kr = r * rng.range(0.35, 0.6);
        const kg = displace(gIco(kr, 0), kr * 0.35, 0.5, noise, i * 3 + k);
        kg.translate(sx + Math.cos(a) * r * 0.5, above + rng.range(-0.6, 1.2), sz + Math.sin(a) * r * 0.5);
        b.add(M.rock, kg);
      }
      b.add(M.foamDecal, new THREE.RingGeometry(r * 0.9, r * 1.75, 24)
        .rotateX(-HALF_PI).translate(sx, 0.05, sz));
      b.add(M.rock, displace(gIco(r * 0.5, 0), r * 0.2, 0.5, noise, i * 11)
        .translate(sx + r * 0.9, -0.5, sz - r * 0.7));
    }
    // White birds perched on the two tallest stacks.
    {
      const N = Math.round(16 * detail);
      const birds = new THREE.InstancedMesh(gIco(0.28, 0), M.gull, N);
      for (let i = 0; i < N; i++) {
        const s = stacks[i % 2];
        _mat4.makeTranslation(s[0] + rng.range(-1.6, 1.6), s[3] + rng.range(0.2, 1.4), s[1] + rng.range(-1.6, 1.6));
        birds.setMatrixAt(i, _mat4);
      }
      birds.castShadow = false;
      holder.add(birds);
    }
    b.flush(holder, { name: 'seaStacks' });
  }

  // =========================================================================
  // 6. Lake pavilion + jetty + rowboat
  // =========================================================================

  {
    const p = layout.pois.lakeIsland.position;
    const baseY = ground(p.x, p.z) - 0.3;
    const scope = createPiece('lakePavilion', p.x, p.z, baseY, rng.range(0, TAU));
    const { b, holder } = scope;
    b.add(M.plank, tileUV(gBox(4.4, 0.24, 4.4), 4, 4).translate(0, 0.22, 0));
    b.add(M.wood, gBox(5.0, 0.18, 0.18).translate(0, 0.03, -2.2));
    b.add(M.wood, gBox(5.0, 0.18, 0.18).translate(0, 0.03, 2.2));
    for (const [px, pz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) {
      b.add(M.wood, gBox(0.2, 3.0, 0.2).translate(px, 1.7, pz));
    }
    b.add(M.wood, gBox(3.9, 0.16, 0.16).translate(0, 3.16, -1.7));
    b.add(M.wood, gBox(3.9, 0.16, 0.16).translate(0, 3.16, 1.7));
    b.add(M.wood, gBox(0.16, 0.16, 3.9).translate(-1.7, 3.16, 0));
    b.add(M.wood, gBox(0.16, 0.16, 3.9).translate(1.7, 3.16, 0));
    b.add(M.roofThatch, gCone(3.15, 1.7, 4).rotateY(Math.PI * 0.25).translate(0, 4.1, 0));
    b.add(M.wood, gCyl(0.09, 0.09, 0.5, 6).translate(0, 5.1, 0));
    b.add(M.stoneLight, gSphere(0.16, 8, 6).translate(0, 5.42, 0));
    b.add(M.wood, gBox(2.2, 0.1, 0.5).translate(0, 0.78, -1.7));
    b.add(M.wood, gBox(2.2, 0.5, 0.1).translate(0, 1.05, -1.45));
    b.add(M.wood, gBox(0.1, 0.72, 0.45).translate(-1.0, 0.4, -1.7));
    b.add(M.wood, gBox(0.1, 0.72, 0.45).translate(1.0, 0.4, -1.7));
    b.add(M.metal, gCyl(0.12, 0.12, 0.3, 8).translate(1.7, 3.35, 1.7));
    b.add(M.lamp, gCyl(0.08, 0.08, 0.24, 8).translate(1.7, 3.35, 1.7));
    registerNightLight(M.lamp, 1.7);
    b.flush(holder, { name: 'lakePavilion' });
  }

  {
    // Jetty on the lake shore, walked out from the hillside to the waterline.
    const ls = layout.pois.lakeside.position;
    const centre = layout.lake.center;
    const dx = centre.x - ls.x;
    const dz = centre.z - ls.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    let shoreX = ls.x;
    let shoreZ = ls.z;
    for (let d = 0; d <= len; d += 2) {
      const x = ls.x + ux * d;
      const z = ls.z + uz * d;
      if (layout.waterDepth(x, z) > 0.05) break;
      shoreX = x;
      shoreZ = z;
    }
    const deckY = Math.max(ground(shoreX, shoreZ), layout.lakeY) + 0.65;
    const rot = -Math.atan2(uz, ux);
    const scope = createPiece('lakeJetty', shoreX, shoreZ, deckY - 0.3, rot);
    const { b, holder } = scope;
    const L = 11.0;
    // Local +X runs out over the water.
    for (let i = 0; i < 16; i++) {
      b.add(M.plank, gBox(0.56, 0.1, 1.9).translate(1.2 + i * 0.62, 0.3, 0));
    }
    b.add(M.wood, gBox(L, 0.2, 0.22).translate(1.2 + L * 0.5, 0.16, -0.75));
    b.add(M.wood, gBox(L, 0.2, 0.22).translate(1.2 + L * 0.5, 0.16, 0.75));
    for (let i = 0; i < 5; i++) {
      const x = 1.8 + i * 2.6;
      for (const z of [-0.85, 0.85]) {
        const wx = shoreX + x * Math.cos(rot) + z * Math.sin(rot);
        const wz = shoreZ - x * Math.sin(rot) + z * Math.cos(rot);
        const gy = ground(wx, wz);
        const postH = deckY - 0.3 - gy + 0.8;
        b.add(M.wood, gBox(0.22, postH, 0.22).translate(x, 0.3 - postH * 0.5, z));
      }
    }
    // Railing on the far side + fishing rod.
    for (let i = 0; i < 6; i++) {
      b.add(M.wood, gBox(0.14, 1.0, 0.14).translate(2.2 + i * 2.0, 0.85, -0.9));
    }
    b.add(M.wood, gBox(L - 1.4, 0.12, 0.12).translate(2.0 + (L - 1.4) * 0.5, 1.32, -0.9));
    b.add(M.wood, gBox(L - 1.4, 0.1, 0.1).translate(2.0 + (L - 1.4) * 0.5, 0.92, -0.9));
    b.add(M.wood, strut(9.6, 1.45, -0.95, 12.9, 2.5, -1.35, 0.045, 5));
    b.add(M.metal, gCyl(0.09, 0.09, 0.12, 8).rotateZ(HALF_PI).translate(9.4, 1.45, -0.95));
    b.add(M.rope, strut(12.9, 2.5, -1.35, 13.4, 0.4, -1.5, 0.012, 4));
    b.add(M.flowerRed, gSphere(0.07, 6, 5).translate(13.4, 0.42, -1.5));
    b.flush(holder, { name: 'lakeJetty' });
    parts.fishingRod = holder;
    parts.jettyShore = { x: shoreX, z: shoreZ, deckY: deckY - 0.3 };

    // Moored rowboat with oars.
    const box = shoreX + ux * (len * 0.46) + uz * -7.5;
    const boz = shoreZ + uz * (len * 0.46) - ux * -7.5;
    const waterY = layout.lakeY + 0.14;
    const boatRot = rot + 0.5;
    const boat = new THREE.Group();
    boat.name = 'rowboat';
    boat.position.set(box, waterY, boz);
    boat.rotation.y = boatRot;
    group.add(boat);              // world space: it floats, it does not follow the jetty
    const bb = createBatcher();
    const hull = new THREE.Shape();
    hull.moveTo(2.2, 0);
    hull.quadraticCurveTo(0.6, 0.78, -2.2, 0);
    hull.quadraticCurveTo(0.6, -0.78, 2.2, 0);
    const hullGeo = new THREE.ExtrudeGeometry(hull, {
      depth: 0.95, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 1, curveSegments: 10,
    });
    hullGeo.rotateX(-HALF_PI);
    bb.add(M.plank, tileUV(hullGeo, 2, 1));
    bb.add(M.wood, gBox(4.1, 0.1, 0.14).translate(0, 0.44, 0.62));
    bb.add(M.wood, gBox(4.1, 0.1, 0.14).translate(0, 0.44, -0.62));
    bb.add(M.plank, gBox(0.18, 0.1, 1.2).translate(-0.7, 0.3, 0));
    bb.add(M.plank, gBox(0.18, 0.1, 1.2).translate(1.0, 0.32, 0));
    bb.add(M.wood, gBox(0.9, 0.08, 0.22).rotateY(0.4).translate(-1.8, 0.4, 0.45));
    bb.add(M.wood, gBox(0.9, 0.08, 0.22).rotateY(0.4).translate(-1.8, 0.4, -0.45));
    bb.add(M.wood, strut(-1.6, 0.52, 0.5, 2.6, 0.85, 1.5, 0.05, 5));
    bb.add(M.wood, strut(-1.6, 0.52, -0.5, 2.6, 0.85, -1.5, 0.05, 5));
    bb.add(M.rope, strut(2.1, 0.5, 0, 6.0, 1.2, -3.6, 0.035, 5));
    bb.flush(boat, { name: 'rowboat' });
    parts.rowboat = boat;

    b.flush(holder, { name: 'lakeJetty' });

    // Water lilies drifting near the boat (world space, unrotated).
    {
      const lilies = new THREE.Group();
      lilies.name = 'waterLilies';
      group.add(lilies);
      const lb = createBatcher();
      for (let i = 0; i < 14; i++) {
        const a = rng.range(0, TAU);
        const r = rng.range(4, 15);
        const wx = box + Math.cos(a) * r;
        const wz = boz + Math.sin(a) * r;
        lb.add(M.leafDark, gCyl(0.55, 0.55, 0.05, 7).translate(wx, layout.lakeY + 0.03, wz));
        if (i % 3 === 0) {
          lb.add(M.flowerRed, gSphere(0.13, 7, 5).translate(wx, layout.lakeY + 0.14, wz));
        }
      }
      lb.flush(lilies, { castShadow: false, receiveShadow: false, name: 'waterLilies' });
    }
  }

  // =========================================================================
  // 7. Hot-air balloons
  // =========================================================================

  {
    const p = layout.pois.balloons.position;
    const baseY = ground(p.x, p.z) - 0.3;
    const scope = createPiece('balloons', p.x, p.z, baseY, 0);
    const { b, holder } = scope;
    const balloonList = [];

    /** One balloon: 12 gores in two alternating stripe colours. */
    function makeBalloon(envelopeHeight, envelopeRadius, matA, matB, withBurner) {
      const g = new THREE.Group();
      const bb = createBatcher();
      const gores = 12;
      const rows = 9;
      const rAt = (u) => {
        const s = Math.sin(Math.PI * Math.pow(clamp01(u), 0.6));
        return envelopeRadius * (Math.pow(clamp01(s), 0.8) * 0.95 + 0.3 * Math.pow(clamp01(u), 3));
      };
      for (let i = 0; i < gores; i++) {
        const a0 = (i / gores) * TAU;
        const a1 = ((i + 1) / gores) * TAU;
        const pos = [];
        const uv = [];
        for (let j = 0; j <= rows; j++) {
          const u = j / rows;
          const r = Math.max(envelopeRadius * 0.02, rAt(u));
          const y = u * envelopeHeight;
          pos.push(Math.cos(a0) * r, y, Math.sin(a0) * r);
          pos.push(Math.cos(a1) * r, y, Math.sin(a1) * r);
          uv.push(0, u * 1.6, 1, u * 1.6);
        }
        const idx = [];
        for (let j = 0; j < rows; j++) {
          const a = j * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setIndex(idx);
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.computeVertexNormals();
        bb.add(i % 2 === 0 ? matA : matB, geo);
      }
      bb.add(M.rope, gTorus(envelopeRadius * 0.31, 0.05, 4, 14).rotateX(HALF_PI)
        .translate(0, envelopeHeight - 0.05, 0));
      bb.add(M.wood, gTorus(envelopeRadius * 0.31, 0.06, 4, 14).rotateX(HALF_PI).translate(0, 0.02, 0));
      bb.add(M.wicker, tileUV(gCyl(0.62, 0.5, 1.05, 12), 3, 1).translate(0, -0.55, 0));
      bb.add(M.wicker, gTorus(0.64, 0.07, 5, 14).rotateX(HALF_PI).translate(0, -0.05, 0));
      for (const [cx2, cz2] of [[0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]]) {
        bb.add(M.rope, strut(cx2 * 0.85, 0, cz2 * 0.85, cx2 * 0.85, envelopeHeight * 0.34, cz2 * 0.85, 0.03, 4));
        bb.add(M.rope, strut(cx2 * 0.85, envelopeHeight * 0.34, cz2 * 0.85, cx2 * 0.5, envelopeHeight - 0.15, cz2 * 0.5, 0.025, 4));
      }
      if (withBurner) {
        bb.add(M.metal, gCyl(0.2, 0.24, 0.3, 8).translate(0, 0.18, 0));
        bb.add(M.burner, gCyl(0.14, 0.17, 0.22, 8).translate(0, 0.42, 0));
      }
      bb.flush(g, { name: 'balloon' });
      return g;
    }

    // Two tethered balloons; their tether lines are static stakes-to-basket.
    const tethers = [
      { x: 13, z: 5, h: 9.5, r: 4.6, mats: [M.balloonA, M.balloonB] },
      { x: -11, z: -9, h: 13.5, r: 5.2, mats: [M.balloonC, M.balloonA] },
    ];
    for (let i = 0; i < tethers.length; i++) {
      const cfg = tethers[i];
      const gy = ground(p.x + cfg.x, p.z + cfg.z) - baseY;
      const balloon = makeBalloon(11 + i, cfg.r, cfg.mats[0], cfg.mats[1], true);
      balloon.name = 'tetheredBalloon' + i;
      balloon.position.set(cfg.x, gy + cfg.h, cfg.z);
      balloon.rotation.y = rng.range(0, TAU);
      holder.add(balloon);
      balloonList.push(balloon);
      animated.push({
        group: balloon, baseY: gy + cfg.h, amp: 0.62 + i * 0.14,
        rate: 0.55 + i * 0.12, phase: i * 2.1,
      });
      for (const [sx, sz] of [[3.4, 3.4], [-3.4, 3.4], [3.4, -3.4], [-3.4, -3.4]]) {
        const wx = cfg.x + sx;
        const wz = cfg.z + sz;
        const wy = ground(p.x + wx, p.z + wz) - baseY;
        b.add(M.wood, gBox(0.16, 0.5, 0.16).translate(wx, wy + 0.2, wz));
        b.add(M.rope, strut(wx, wy + 0.35, wz, cfg.x + sx * 0.22, gy + cfg.h + 0.02, cfg.z + sz * 0.22, 0.03, 4));
      }
    }

    // One balloon drifting slowly in a wide circle at 40 m.
    {
      const drift = makeBalloon(12.5, 5.6, M.balloonD, M.balloonF, true);
      drift.name = 'driftBalloon';
      const startY = ground(p.x, p.z) + 40;
      drift.position.set(p.x - 70, startY, p.z + 20);
      group.add(drift);           // world space: it circles the meadow at 40 m
      parts.driftBalloon = drift;
      balloonList.push(drift);
      animated.push({
        drift: true, group: drift, cx: p.x - 70, cz: p.z + 20, r: 62,
        angle: 0, speed: TAU / 150, baseY: startY,
      });
    }

    // One grounded balloon being inflated: squashed envelope + basket + burner.
    {
      const gx = 9;
      const gz = -13;
      const gy = ground(p.x + gx, p.z + gz) - baseY;
      const flat = makeBalloon(9.5, 4.8, M.balloonE, M.balloonA, true);
      flat.name = 'groundedBalloon';
      flat.position.set(gx, gy + 1.3, gz);
      flat.rotation.set(0.16, 0.5, 1.45);
      flat.scale.set(1.0, 0.34, 1.0);
      holder.add(flat);
      balloonList.push(flat);
      animated.push({ group: flat, baseY: gy + 1.3, amp: 0.0, rate: 0.4, phase: 0, fixed: true });
      parts.groundedBalloon = flat;
      b.add(M.wicker, tileUV(gCyl(0.62, 0.5, 1.05, 12), 3, 1).rotateZ(1.5).translate(gx - 3.4, gy + 0.5, gz + 1.2));
      b.add(M.metal, gCyl(0.2, 0.24, 0.3, 8).translate(gx - 2.2, gy + 0.28, gz + 2.1));
      b.add(M.burner, gCyl(0.14, 0.17, 0.22, 8).translate(gx - 2.2, gy + 0.52, gz + 2.1));
      for (let i = 0; i < 6; i++) {
        b.add(M.plank, gBox(1.6, 0.1, 0.5).rotateY((i / 6) * TAU).translate(gx - 1.0, gy + 0.1, gz + 0.6));
      }
      parts.burnerMat = M.burner;
      registerNightLight(M.burner, 2.6);
      colliders.push({ x: p.x + gx - 3.4, z: p.z + gz + 1.2, r: 2 });
    }
    b.flush(holder, { name: 'balloons' });
    parts.balloons = balloonList;      // [tethered, tethered, drifting, grounded]
    parts.balloonsField = holder;
  }

  // =========================================================================
  // 8. Summit cluster: cairn, telescope, flag, bent pine, signposts
  // =========================================================================

  {
    const peak = layout.pois.peak.position;
    const cairnPoi = layout.pois.cairn;
    const cairnX = cairnPoi ? cairnPoi.position.x : peak.x + 9.5;
    const cairnZ = cairnPoi ? cairnPoi.position.z : peak.z + 11.0;
    const cairnY = ground(cairnX, cairnZ) - 0.35;
    const scope = createPiece('summitCairn', cairnX, cairnZ, cairnY, rng.range(0, TAU));
    const { b, holder } = scope;
    // Balancing-stone cairn, 2.5 m of improbably stacked rocks.
    const rocks = [
      [0.95, 0.0, 0.0, 0.72], [0.76, 0.12, -0.1, 0.55], [0.62, -0.14, 0.12, 0.45],
      [0.5, 0.06, 0.16, 0.4], [0.4, -0.05, -0.12, 0.33], [0.3, 0.02, 0.05, 0.28],
    ];
    let stackY = 0;
    for (let i = 0; i < rocks.length; i++) {
      const r = rocks[i][0];
      const g = displace(gIco(r, 0), r * 0.3, 0.75, noise, 60 + i * 3);
      g.rotateY(rng.range(0, TAU));
      g.translate(rocks[i][1], stackY + r * rocks[i][3], rocks[i][2]);
      stackY += r * rocks[i][3] * 2 * 0.85;
      b.add(M.rock, g);
    }
    b.add(M.rock, tileUV(gBox(1.7, 0.4, 1.7, 2, 1, 2), 1.5).translate(-0.3, 0.15, 0.4));
    b.flush(holder, { name: 'summitCairn' });
  }

  {
    const p = layout.pois.observatory.position;
    const baseY = ground(p.x, p.z) - 0.4;
    const rot = HALF_PI - Math.atan2(p.z, p.x);
    const scope = createPiece('observatory', p.x, p.z, baseY, rot);
    const { b, holder } = scope;
    // Stone plinth.
    b.add(M.stoneLight, tileUV(gBox(1.25, 1.1, 1.25, 2, 1, 2), 1.4).translate(0, 0.55, 0));
    b.add(M.stoneLight, gBox(1.5, 0.18, 1.5).translate(0, 1.16, 0));
    b.add(M.stone, gBox(1.9, 0.3, 1.9).translate(0, 0.15, 0));
    // Tripod on the plinth + panning yoke.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      b.add(M.wood, strut(Math.cos(a) * 0.85, 0.05, Math.sin(a) * 0.85, 0, 1.5, 0, 0.07, 5));
    }
    b.add(M.metal, gCyl(0.09, 0.09, 0.3, 8).translate(0, 1.6, 0));
    const yoke = new THREE.Group();
    yoke.position.set(0, 1.72, 0);
    holder.add(yoke);
    const tubeGeo = gCyl(0.18, 0.15, 1.9, 12, false).rotateZ(-HALF_PI);
    tubeGeo.rotateZ(0.34);
    const tube = new THREE.Mesh(tubeGeo, M.wood);
    tube.castShadow = true;
    const bandGeo = [];
    bandGeo.push(gCyl(0.2, 0.2, 0.16, 12).rotateZ(-HALF_PI).rotateZ(0.34).translate(0.5, 0.19, 0));
    bandGeo.push(gCyl(0.2, 0.2, 0.12, 12).rotateZ(-HALF_PI).rotateZ(0.34).translate(-0.5, -0.19, 0));
    const bands = new THREE.Mesh(mergeGeometries(bandGeo.map(normalizeGeometry), false), M.metal);
    bands.castShadow = true;
    const eye = new THREE.Mesh(gCyl(0.07, 0.07, 0.22, 8).rotateZ(HALF_PI).translate(-1.02, -0.38, 0), M.metal);
    const weight = new THREE.Mesh(gSphere(0.13, 8, 6).translate(0.95, 0.36, 0), M.metal);
    yoke.add(tube, bands, eye, weight);
    parts.telescopeYoke = yoke;
    parts.telescopeTube = tube;
    // A couple of marker stones + a snow pole.
    b.add(M.rock, displace(gIco(0.5, 0), 0.16, 0.7, noise, 71).translate(2.4, 0.4, 1.3));
    b.add(M.metal, gCyl(0.06, 0.06, 2.2, 6).translate(-2.2, 1.1, -1.1));
    b.add(M.flowerRed, gBox(0.4, 0.18, 0.05).translate(-2.2, 2.1, -1.1));
    b.flush(holder, { name: 'observatory' });
  }

  {
    const peak = layout.pois.peak.position;
    const fx = peak.x - 8.0;
    const fz = peak.z - 6.0;
    const baseY = ground(fx, fz) - 0.35;
    const scope = createPiece('summitFlag', fx, fz, baseY, 0);
    const { b, holder } = scope;
    b.add(M.stone, tileUV(gCyl(0.6, 0.8, 0.6, 10), 2, 1).translate(0, 0.2, 0));
    b.add(M.metal, gCyl(0.07, 0.09, 6.4, 8).translate(0, 3.4, 0));
    b.add(M.stoneLight, gSphere(0.13, 8, 6).translate(0, 6.65, 0));
    const pennant = new THREE.Group();
    pennant.position.set(0, 6.35, 0);
    pennant.rotation.y = rng.range(-0.6, 0.6);
    const flag = new THREE.Mesh(
      triangleMesh(0, 0, 0, 0, -0.95, 0.05, 0, -0.08, -2.5),
      new THREE.MeshStandardMaterial({ color: 0xe0523f, roughness: 0.8, side: THREE.DoubleSide }),
    );
    flag.castShadow = true;
    pennant.add(flag);
    holder.add(pennant);
    parts.pennant = pennant;
    // Wind-bent lone pine.
    const pineX = 14, pineZ = -12;
    const pineBase = ground(fx + pineX, fz + pineZ) - baseY;
    b.add(M.bark, gCyl(0.22, 0.4, 5.2, 8).rotateZ(0.42).translate(pineX - 1.1, pineBase + 2.4, pineZ));
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      b.add(M.leafDark, gCone(1.9 - t * 0.7, 2.4, 8).scale(1.5, 0.62, 1.0)
        .rotateZ(0.42)
        .translate(pineX - 2.2 - t * 1.2, pineBase + 3.4 + t * 1.0, pineZ));
    }
    // Two wooden signposts.
    for (let s = 0; s < 2; s++) {
      const sx2 = -14 + s * 22;
      const sz2 = 6 + s * 13;
      const sy = ground(fx + sx2, fz + sz2) - baseY;
      b.add(M.wood, gBox(0.16, 1.8, 0.16).translate(sx2, sy + 0.9, sz2));
      for (let k = 0; k < 2; k++) {
        const a = 0.7 + k * 1.9 + s * 0.8;
        b.add(M.plank, gBox(1.15, 0.24, 0.07).rotateY(a).translate(sx2 + Math.sin(a) * 0.5, sy + 1.55 - k * 0.34, sz2 + Math.cos(a) * 0.5));
        b.add(M.flowerRed, gBox(0.22, 0.24, 0.05).rotateY(a).translate(sx2 + Math.sin(a) * 1.06, sy + 1.55 - k * 0.34, sz2 + Math.cos(a) * 1.06));
      }
    }
    b.flush(holder, { name: 'summitFlag' });
  }

  // =========================================================================
  // 9. Chapel + graveyard
  // =========================================================================

  {
    const p = layout.pois.chapel.position;
    const baseY = ground(p.x, p.z) - 0.3;
    const rot = rng.range(-0.4, 0.4);
    const scope = createPiece('chapel', p.x, p.z, baseY, rot);
    const { b, holder } = scope;
    // Nave + gable roof.
    b.add(M.plasterWhite, tileUV(gBox(9.2, 4.4, 5.6, 3, 2, 2), 4, 3).translate(0, 2.2, 0));
    const gable = new THREE.Shape();
    gable.moveTo(-3.05, 0);
    gable.lineTo(3.05, 0);
    gable.lineTo(0, 2.35);
    gable.closePath();
    b.add(M.roof, new THREE.ExtrudeGeometry(gable, { depth: 9.6, bevelEnabled: false })
      .rotateY(HALF_PI).translate(-4.8, 4.35, 0));
    b.add(M.roof, gBox(9.8, 0.22, 0.4).translate(0, 6.75, 0));
    b.add(M.stoneLight, gBox(0.9, 2.0, 0.3).translate(4.62, 1.0, 0));
    b.add(M.wood, gArch(0.62, 0.42).rotateY(HALF_PI).translate(4.72, 1.95, 0));
    b.add(M.wood, gBox(0.1, 0.42, 1.25).translate(4.66, 2.5, 0));
    // Bell tower + swinging bell.
    const towerX = -5.4;
    b.add(M.plasterWhite, tileUV(gBox(2.5, 7.4, 2.5, 2, 4, 2), 2, 5).translate(towerX, 3.7, 0));
    b.add(M.stoneLight, gBox(2.9, 0.28, 2.9).translate(towerX, 7.5, 0));
    b.add(M.lamp, gBox(0.55, 1.15, 0.12).translate(towerX, 6.55, 1.26));
    b.add(M.lamp, gBox(0.55, 1.15, 0.12).translate(towerX, 6.55, -1.26));
    b.add(M.lamp, gBox(0.12, 1.15, 0.55).translate(towerX + 1.26, 6.55, 0));
    registerNightLight(M.lamp, 1.6);
    b.add(M.roof, gCone(2.05, 2.5, 4).rotateY(Math.PI * 0.25).translate(towerX, 8.9, 0));
    b.add(M.metal, gCyl(0.05, 0.05, 0.9, 6).translate(towerX, 10.3, 0));
    b.add(M.metal, gBox(0.5, 0.08, 0.08).translate(towerX, 10.5, 0));
    const bell = new THREE.Group();
    bell.position.set(towerX, 7.05, 0);
    const bellProfile = [];
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      bellProfile.push(new THREE.Vector2(0.09 + 0.34 * Math.pow(t, 1.7), -t * 0.62));
    }
    const bellMesh = new THREE.Mesh(new THREE.LatheGeometry(bellProfile, 12), M.metal);
    bellMesh.castShadow = true;
    bell.add(bellMesh);
    bell.add(new THREE.Mesh(gSphere(0.09, 7, 6).translate(0, -0.62, 0), M.metal));
    bell.add(new THREE.Mesh(gBox(0.7, 0.12, 0.16).translate(0, 0.08, 0), M.wood));
    holder.add(bell);
    parts.bell = bell;
    // Arched windows (emissive at night).
    for (let i = 0; i < 3; i++) {
      const wx = -2.4 + i * 2.4;
      for (const s of [-1, 1]) {
        b.add(M.window, gBox(0.95, 1.5, 0.16).translate(wx, 2.35, s * 2.84));
        b.add(M.window, gArch(0.475, 0.16).rotateY(s > 0 ? 0 : Math.PI).translate(wx, 3.1, s * 2.84));
        b.add(M.stoneLight, gBox(1.15, 0.14, 0.22).translate(wx, 1.55, s * 2.84));
      }
    }
    b.add(M.window, gBox(0.85, 1.1, 0.16).translate(-5.4, 4.0, 1.28));
    b.add(M.window, gArch(0.42, 0.16).translate(-5.4, 4.55, 1.28));
    registerNightLight(M.window, 1.5);
    // Tiny graveyard: two rows of leaning mossy headstones.
    for (let i = 0; i < 11; i++) {
      const row = i % 2;
      const col = Math.floor(i / 2);
      const lx = -1.5 + col * 2.5 + rng.range(-0.5, 0.5);
      const lz = 9.5 + row * 3.4 + rng.range(-0.7, 0.7);
      const w = localToWorld(p.x, p.z, rot, lx, lz);
      const gy = ground(w.x, w.z) - baseY;
      const h = rng.range(0.55, 0.95);
      const g = tileUV(gBox(0.58, h, 0.17, 2, 2, 1), 1.1);
      g.rotateZ(rng.range(-0.14, 0.14));
      g.rotateX(rng.range(-0.12, 0.12));
      g.rotateY(rng.range(-0.4, 0.4));
      g.translate(lx, gy + h * 0.5, lz);
      b.add(M.rockMoss, g);
      b.add(M.rockMoss, gArch(0.29, 0.17).rotateY(rng.range(-0.4, 0.4)).translate(lx, gy + h, lz));
    }
    for (let i = 0; i < 3; i++) {
      const lx = 7.5 + i * 2.1;
      const lz = 8.0 + (i % 2) * 1.6;
      const w = localToWorld(p.x, p.z, rot, lx, lz);
      const gy = ground(w.x, w.z) - baseY;
      b.add(M.rockMoss, tileUV(gBox(0.95, 0.5, 1.75, 2, 1, 2), 1.3).rotateY(rng.range(-0.3, 0.3))
        .translate(lx, gy + 0.2, lz));
    }
    // Cypress pair + low wall with a gate.
    for (const s of [-1, 1]) {
      const lx = 6.4;
      const lz = s * 3.9;
      const w = localToWorld(p.x, p.z, rot, lx, lz);
      const gy = ground(w.x, w.z) - baseY;
      b.add(M.wood, gCyl(0.14, 0.2, 0.7, 6).translate(lx, gy + 0.35, lz));
      b.add(M.leafDark, gCone(1.05, 5.6, 9).translate(lx, gy + 3.5, lz));
    }
    // Low wall both sides of the yard, with a gate opening on the path side.
    for (const side of [-1, 1]) {
      const lz = side * 7.4;
      for (let i = 0; i < 10; i++) {
        const lx = -6.6 + i * 1.42;
        if (side < 0 && lx > -3.4 && lx < 1.2) continue;      // gate opening
        const w = localToWorld(p.x, p.z, rot, lx, lz);
        const gy = ground(w.x, w.z) - baseY;
        b.add(M.stone, gBox(1.4, 1.0, 0.42).rotateY(rng.range(-0.05, 0.05)).translate(lx, gy + 0.45, lz));
        b.add(M.stoneLight, gBox(1.52, 0.14, 0.58).translate(lx, gy + 1.02, lz));
      }
    }
    // Gate posts + two slatted leaves.
    for (const lx of [-3.0, 0.8]) {
      const lz = -7.4;
      const w = localToWorld(p.x, p.z, rot, lx, lz);
      const gy = ground(w.x, w.z) - baseY;
      b.add(M.stone, tileUV(gBox(0.62, 1.95, 0.62, 1, 2, 1), 1.2).translate(lx, gy + 0.95, lz));
      b.add(M.stoneLight, gBox(0.8, 0.18, 0.8).translate(lx, gy + 1.99, lz));
      const dir = lx < 0 ? 1 : -1;
      for (let i = 0; i < 5; i++) {
        b.add(M.wood, gBox(0.15, 1.25, 0.08).translate(lx + dir * (0.42 + i * 0.36), gy + 0.65, lz));
      }
    }
    b.flush(holder, { name: 'chapel' });
  }

  // =========================================================================
  // 10. Start / finish gates + kilometre-zero marker
  // =========================================================================

  {
    const p = layout.pois.gates.position;
    const baseY = ground(p.x, p.z) - 0.3;
    const rot = typeof p.heading === 'number' ? p.heading : 0;
    const scope = createPiece('gates', p.x, p.z, baseY, rot);
    const { b, holder } = scope;
    const SPAN = 5.6;
    for (const s of [-1, 1]) {
      const px = s * SPAN;
      b.add(M.stoneLight, gBox(1.4, 0.34, 1.4).translate(px, 0.17, 0));
      b.add(M.stone, tileUV(gBox(1.02, 4.2, 1.02, 2, 5, 2), 1.6, 4).translate(px, 2.28, 0));
      b.add(M.plasterWhite, gBox(1.08, 0.75, 1.08).translate(px, 2.78, 0));
      b.add(M.stoneLight, gBox(1.32, 0.26, 1.32).translate(px, 4.5, 0));
      b.add(M.stoneLight, gSphere(0.3, 8, 6).translate(px, 4.78, 0));
    }
    // Wooden arch: main beam, tie beam, lattice slats.
    b.add(M.wood, gBox(13.0, 0.5, 0.5).translate(0, 4.95, 0));
    b.add(M.wood, gBox(12.4, 0.28, 0.28).translate(0, 4.36, 0));
    for (let i = 0; i < 9; i++) {
      b.add(M.plank, gBox(0.18, 0.62, 0.14).translate(-5.0 + i * 1.25, 4.64, 0.22));
    }
    // Big sign board with the title drawn onto a canvas.
    b.add(M.plank, gBox(6.0, 1.5, 0.18).translate(0, 5.95, 0));
    b.add(M.wood, gBox(6.34, 0.18, 0.28).translate(0, 6.79, 0));
    b.add(M.wood, gBox(6.34, 0.18, 0.28).translate(0, 5.11, 0));
    b.add(M.wood, gBox(0.18, 1.86, 0.28).translate(-3.08, 5.95, 0));
    b.add(M.wood, gBox(0.18, 1.86, 0.28).translate(3.08, 5.95, 0));
    const signCanvas = drawSignBoard(TEX);
    if (signCanvas) {
      const signTex = TEX.texture(signCanvas, { repeat: 1, wrap: THREE.ClampToEdgeWrapping });
      const signMat = new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false });
      const faceA = new THREE.Mesh(gPlane(5.6, 1.4), signMat);
      faceA.position.set(0, 5.95, 0.115);
      const faceB = new THREE.Mesh(gPlane(5.6, 1.4), signMat);
      faceB.position.set(0, 5.95, -0.115);
      faceB.rotation.y = Math.PI;
      holder.add(faceA, faceB);
      parts.signBoard = faceA;
    }
    // Start / finish banner hanging under the beam (exposed as parts.banner).
    {
      const bannerCanvas = drawBanner(TEX);
      const bannerMat = bannerCanvas
        ? new THREE.MeshStandardMaterial({
          map: TEX.texture(bannerCanvas, { repeat: 1, wrap: THREE.ClampToEdgeWrapping }),
          roughness: 0.9, side: THREE.DoubleSide,
        })
        : new THREE.MeshStandardMaterial({ color: 0xf2e8d5, roughness: 0.9, side: THREE.DoubleSide });
      const bannerGeo = gPlane(6.4, 1.05, 12, 2);
      const bpos = bannerGeo.attributes.position;
      for (let i = 0; i < bpos.count; i++) {
        bpos.setZ(i, Math.sin((bpos.getX(i) / 6.4 + 0.5) * Math.PI) * 0.22);
      }
      bannerGeo.computeVertexNormals();
      const banner = new THREE.Mesh(bannerGeo, bannerMat);
      banner.position.set(0, 3.72, 0);
      banner.castShadow = true;
      holder.add(banner);
      parts.banner = banner;
      b.add(M.rope, strut(-3.0, 4.3, 0, -3.2, 4.74, 0, 0.03, 4));
      b.add(M.rope, strut(3.0, 4.3, 0, 3.2, 4.74, 0, 0.03, 4));
    }
    // Pennant string between the pillars.
    {
      const pennantMat = new THREE.MeshStandardMaterial({
        color: 0xe0523f, roughness: 0.8, side: THREE.DoubleSide,
      });
      const pts = [-5.2, 4.62, 0];
      const count = 9;
      for (let i = 1; i <= count; i++) {
        const t = i / (count + 1);
        const x = lerp(-5.2, 5.2, t);
        const y = 4.62 - Math.sin(t * Math.PI) * 0.5;
        pts.push(x, y, 0);
        b.add(pennantMat, triangleMesh(x - 0.19, y, 0, x + 0.19, y, 0, x, y - 0.5, 0));
      }
      pts.push(5.2, 4.62, 0);
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      holder.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x2c2823 })));
    }
    // Kilometre-zero marker stone.
    b.add(M.stoneLight, tileUV(gBox(0.8, 0.9, 0.8, 1, 2, 1), 1.2).translate(8.2, 0.45, 2.4));
    b.add(M.stoneLight, gBox(0.94, 0.14, 0.94).translate(8.2, 0.97, 2.4));
    const kmCanvas = drawKmZero(TEX);
    if (kmCanvas) {
      const kmMat = new THREE.MeshBasicMaterial({
        map: TEX.texture(kmCanvas, { repeat: 1, wrap: THREE.ClampToEdgeWrapping }),
        transparent: false,
      });
      const plate = new THREE.Mesh(gPlane(0.5, 0.5), kmMat);
      plate.position.set(8.2, 0.6, 1.99);
      holder.add(plate);
    }
    b.flush(holder, { name: 'gates' });
    for (const s of [-1, 1]) {
      const w = localToWorld(p.x, p.z, rot, s * SPAN, 0);
      colliders.push({ x: w.x, z: w.z, r: 1.0 });
    }
  }

  // =========================================================================
  // 11. Stone arch bridge over the gorge
  // =========================================================================

  {
    const bp = layout.pois.bridge.position;
    const deckTop = bp.y - 0.15;
    const rp = layout.roadPoint(layout.pois.bridge.roadT, {});
    const roadRot = Math.atan2(rp.dirX, rp.dirZ);
    const tX = Math.sin(roadRot);
    const tZ = Math.cos(roadRot);
    let crossD = 0;
    let bestRd = Infinity;
    for (let d = -40; d <= 40; d += 1) {
      const rd = layout.riverDistance(bp.x + tX * d, bp.z + tZ * d);
      if (rd < bestRd) {
        bestRd = rd;
        crossD = d;
      }
    }
    const cx = bp.x + tX * crossD;
    const cz = bp.z + tZ * crossD;
    const rot = roadRot - HALF_PI;              // holder local +X follows the road
    const scope = createPiece('bridge', cx, cz, deckTop, rot);
    const { b, holder } = scope;
    samples[samples.length - 1] = { id: 'bridge', x: cx, z: cz, y: deckTop, baseY: ground(cx, cz) };
    parts.bridgeDeckTop = deckTop;
    const alongX = (d) => cx + tX * d;
    const alongZ = (d) => cz + tZ * d;

    const DECK_LEN = 48;
    const DECK_W = 7.4;
    const SPRING = -10.6;      // arch springing (local y; deck top = 0)
    const UNDER = -0.55;       // deck underside
    b.add(M.stone, tileUV(gBox(DECK_LEN, 0.55, DECK_W, 8, 1, 3), 9, 2).translate(0, -0.275, 0));
    for (const s of [-1, 1]) {
      b.add(M.stone, tileUV(gBox(DECK_LEN, 0.9, 0.44, 8, 2, 1), 9, 1.4).translate(0, 0.45, s * 3.48));
      for (let i = 0; i < 24; i++) {
        b.add(M.stoneLight, gBox(1.05, 0.22, 0.56)
          .rotateY(rng.range(-0.03, 0.03))
          .translate(-DECK_LEN * 0.5 + 1.0 + i * 2.0, 1.0, s * 3.48));
      }
    }
    // Piers down to the terrain + cutwater noses.
    for (const d of [-14, 0, 14]) {
      const terrainLocal = ground(alongX(d), alongZ(d)) - deckTop - 1.2;
      const h = SPRING - terrainLocal;
      const cy = (SPRING + terrainLocal) * 0.5;
      b.add(M.stone, tileUV(gBox(3.3, h, 6.6, 2, 8, 3), 3, 8).translate(d, cy, 0));
      for (const s of [-1, 1]) {
        b.add(M.stone, gBox(1.3, h, 1.3).rotateY(Math.PI * 0.25).translate(d + s * 1.64, cy, 0));
      }
    }
    // Two arches: extruded spandrel walls with semicircular openings.
    const archPanel = (centerX) => {
      const hw = 5.6;
      const r = 4.0;
      const shape = new THREE.Shape();
      shape.moveTo(-hw, 0);
      shape.lineTo(hw, 0);
      shape.lineTo(hw, UNDER - SPRING);
      shape.lineTo(-hw, UNDER - SPRING);
      shape.closePath();
      const hole = new THREE.Path();
      hole.moveTo(-r, 0.05);
      hole.lineTo(r, 0.05);
      hole.absarc(0, 0.05, r, 0, Math.PI, false);
      hole.closePath();
      shape.holes.push(hole);
      const g = new THREE.ExtrudeGeometry(shape, { depth: 6.6, bevelEnabled: false, curveSegments: 12 });
      g.translate(centerX, SPRING, -3.3);
      return g;
    };
    for (const pc of [-7, 7]) {
      const panel = archPanel(pc);
      tileUV(panel, 0.16);
      b.add(M.stone, panel);
      for (const s of [-1, 1]) {
        b.add(M.stoneLight, gTorus(4.2, 0.24, 5, 20, Math.PI)
          .translate(pc, SPRING + 0.05, s * 3.36));
      }
      b.add(M.stoneLight, tileUV(gBox(0.95, 1.15, 6.9, 1, 2, 3), 1.2).translate(pc, SPRING + 4.45, 0));
    }
    // Abutments tying the deck ends into the gorge walls.
    for (const d of [-22, 22]) {
      const terrainLocal = ground(alongX(d), alongZ(d)) - deckTop - 1.2;
      const h = UNDER - terrainLocal;
      b.add(M.stone, tileUV(gBox(4.4, h, DECK_W, 2, 6, 3), 4, 6).translate(d, (UNDER + terrainLocal) * 0.5, 0));
    }
    // Lamp niches (emissive after dark) + two gargoyles.
    for (const s of [-1, 1]) {
      for (const x of [-19, -9, 9, 19]) {
        b.add(M.stoneLight, gBox(0.7, 0.9, 0.18).translate(x, 0.55, s * 3.72));
        b.add(M.lamp, gBox(0.4, 0.56, 0.08).translate(x, 0.55, s * 3.82));
        b.add(M.stoneLight, gBox(0.86, 0.14, 0.34).translate(x, 1.07, s * 3.72));
      }
    }
    registerNightLight(M.lamp, 1.8);
    for (const s of [-1, 1]) {
      const gx = s * 23.6;
      const gz = s * 3.6;
      const g = displace(gIco(0.42, 1), 0.14, 1.1, noise, s * 9);
      g.scale(1.0, 0.8, 1.5);
      g.rotateY(s * 0.4);
      g.translate(gx, 0.62, gz);
      b.add(M.stoneLight, g);
      b.add(M.stoneLight, gBox(0.3, 0.22, 0.5).rotateY(s * 0.4).translate(gx + s * 0.1, 0.58, gz + s * 0.42));
    }
    b.flush(holder, { name: 'bridge' });
  }

  // =========================================================================
  // 12. Waterfall rocks + plunge pool
  // =========================================================================

  {
    const river = layout.riverCurve;
    const lipT = 0.16;
    const lip = river.getPointAt(lipT);
    const baseY = ground(lip.x, lip.z) - 0.45;
    const scope = createPiece('waterfall', lip.x, lip.z, baseY, 0);
    const { b, holder } = scope;
    const frame = (t) => {
      const a = river.getPointAt(clamp01(t));
      const c = river.getPointAt(clamp01(t + 0.004));
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      return { x: a.x, z: a.z, nx: -dz / l, nz: dx / l };
    };
    // Boulders framing the ~9 m step, both banks, lip to plunge.
    for (let i = 0; i < 24; i++) {
      const t = 0.150 + (i / 23) * 0.038;
      const f = frame(t);
      const side = i % 2 === 0 ? 1 : -1;
      const off = 2.0 + rng.range(0, 3.6);
      const wx = f.x + f.nx * off * side;
      const wz = f.z + f.nz * off * side;
      const wy = ground(wx, wz) - baseY;
      const r = rng.range(0.75, 2.1);
      const g = displace(gIco(r, 1), r * 0.3, 0.6, noise, i * 3.3);
      g.scale(1.18, 0.86, 1.0);
      g.rotateY(rng.range(0, TAU));
      g.translate(wx - lip.x, wy + r * 0.3, wz - lip.z);
      b.add(i % 3 === 0 ? M.rockMoss : M.cliff, g);
    }
    // Two big lip boulders at the fall line.
    for (const s of [-1, 1]) {
      const f = frame(0.158);
      const wx = f.x + f.nx * 1.5 * s;
      const wz = f.z + f.nz * 1.5 * s;
      const wy = ground(wx, wz) - baseY;
      b.add(M.cliff, displace(gIco(2.2, 1), 0.6, 0.35, noise, 50 + s)
        .scale(1.2, 0.8, 1.1)
        .translate(wx - lip.x, wy + 0.6, wz - lip.z));
    }
    // Fallen log lying across the gorge just below the lip.
    {
      const f = frame(0.168);
      const ax = f.x + f.nx * 5.6;
      const az = f.z + f.nz * 5.6;
      const bx2 = f.x - f.nx * 5.2;
      const bz2 = f.z - f.nz * 5.2;
      const ay = ground(ax, az) - baseY + 0.5;
      const by = ground(bx2, bz2) - baseY + 0.1;
      b.add(M.bark, strut(ax - lip.x, ay, az - lip.z, bx2 - lip.x, by, bz2 - lip.z, 0.34, 8));
      b.add(M.wood, gCyl(0.36, 0.36, 0.09, 8).rotateZ(HALF_PI).translate(ax - lip.x, ay, az - lip.z));
      b.add(M.rockMoss, displace(gIco(0.55, 0), 0.16, 0.8, noise, 77)
        .translate(ax - lip.x + 0.9, ay + 0.1, az - lip.z - 0.7));
    }
    // Plunge-pool stones.
    for (let i = 0; i < 8; i++) {
      const f = frame(0.176 + i * 0.0016);
      const side = i % 2 === 0 ? 1 : -1;
      const off = 1.4 + rng.range(0, 2.6);
      const wx = f.x + f.nx * off * side;
      const wz = f.z + f.nz * off * side;
      const wy = ground(wx, wz) - baseY;
      const r = rng.range(0.6, 1.5);
      b.add(M.rockMoss, displace(gIco(r, 1), r * 0.3, 0.7, noise, 90 + i)
        .scale(1.2, 0.7, 1.1)
        .translate(wx - lip.x, wy + r * 0.2, wz - lip.z));
    }
    b.flush(holder, { name: 'waterfall' });
    // Hand-off to the particles module.
    const pool = layout.pois.pool.position;
    parts.poolCenter = { x: pool.x, y: pool.y, z: pool.z };
    emitters.push({ x: pool.x, y: pool.y + 0.7, z: pool.z, type: 'mist', rate: 1.0 });
  }

  // =========================================================================
  // 13. Shipwreck: beached trawler on the south-east beach
  // =========================================================================

  {
    const sx = -120;
    const sz = 2050;
    const baseY = ground(sx, sz) - 0.45;
    const rot = HALF_PI - Math.atan2(sz, sx);     // holder local +Z faces the sea
    const scope = createPiece('shipwreck', sx, sz, baseY, rot);
    const { b, holder } = scope;
    // Keel + ribs: a broken hull skeleton, heeled over.
    b.add(M.wood, gBox(9.6, 0.62, 1.05).rotateZ(0.09).translate(0, 0.35, 1.5));
    for (let i = 0; i < 9; i++) {
      const rib = gTorus(2.0 - i * 0.16, 0.14, 6, 14, Math.PI).rotateY(HALF_PI);
      rib.rotateZ(rng.range(-0.22, 0.22));
      rib.translate(-4.3 + i * 1.15, 0.5, 1.5);
      b.add(M.wood, rib);
    }
    // Gunwale planks + deck fragments.
    for (let i = 0; i < 5; i++) {
      b.add(M.rust, gBox(2.0, 0.14, 0.9)
        .rotateZ(rng.range(-0.3, 0.3))
        .rotateY(rng.range(-0.35, 0.35))
        .translate(-3.6 + i * 1.9, 1.0 + rng.range(-0.2, 0.2), 1.5 + (i % 2 === 0 ? 1.5 : -1.5)));
    }
    b.add(M.wood, gBox(1.5, 0.12, 2.2).rotateY(0.4).translate(1.6, 0.72, 1.2));
    b.add(M.rust, gBox(1.3, 0.1, 1.6).rotateY(-0.7).translate(-2.4, 0.66, 2.4));
    // Leaning mast, cross spar, stays and a broken spar on the sand.
    b.add(M.wood, strut(1.0, 0.8, 1.5, -3.4, 6.6, 3.6, 0.22, 8));
    b.add(M.wood, strut(-1.6, 5.4, 2.9, -4.6, 4.5, 4.6, 0.12, 6));
    b.add(M.rope, strut(-3.2, 6.3, 3.5, -4.6, 0.4, 0.4, 0.035, 4));
    b.add(M.rope, strut(-3.3, 6.2, 3.5, 4.4, 0.4, 3.2, 0.035, 4));
    b.add(M.wood, gCyl(0.16, 0.2, 4.4, 7).rotateZ(HALF_PI).rotateY(0.5).translate(4.6, 0.45, -1.6));
    // Rusted winch: drum, frame, crank, chain.
    b.add(M.rust, gCyl(0.48, 0.48, 0.9, 10).rotateZ(HALF_PI).translate(-4.0, 1.0, 0.2));
    b.add(M.rust, gBox(0.22, 1.1, 0.22).translate(-4.5, 0.6, -0.4));
    b.add(M.rust, gBox(0.22, 1.1, 0.22).translate(-3.5, 0.6, -0.4));
    b.add(M.rust, strut(-4.0, 1.0, -0.4, -4.0, 1.55, -1.25, 0.06, 5));
    b.add(M.rust, strut(-4.0, 1.55, -1.25, -4.0, 1.55, -1.85, 0.06, 5));
    b.add(M.rust, gTorus(0.32, 0.06, 4, 12).rotateY(HALF_PI).translate(-4.0, 0.95, 0.2));
    // Seagull nest on the highest rib.
    b.add(M.rope, gTorus(0.52, 0.13, 5, 12).rotateX(0.12).translate(-3.3, 1.55, 1.5));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      b.add(M.fabricCream, gSphere(0.12, 7, 5).translate(-3.3 + Math.cos(a) * 0.16, 1.6, 1.5 + Math.sin(a) * 0.16));
    }
    b.flush(holder, { name: 'shipwreck' });
    colliders.push({ x: sx, z: sz, r: 6 });
  }

  // =========================================================================
  // 14. Small photogenic extras
  // =========================================================================

  {
    // Rope swing over a river bend.
    const t = 0.585;
    const p = layout.riverCurve.getPointAt(t);
    const q = layout.riverCurve.getPointAt(t + 0.004);
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    const side = ground(p.x + nx * 5.5, p.z + nz * 5.5) >= ground(p.x - nx * 5.5, p.z - nz * 5.5) ? 1 : -1;
    const bankX = p.x + nx * 5.5 * side;
    const bankZ = p.z + nz * 5.5 * side;
    const baseY = ground(bankX, bankZ) - 0.3;
    const rot = Math.atan2(-nx * side, -nz * side);
    const scope = createPiece('ropeSwing', bankX, bankZ, baseY, rot);
    const { b, holder } = scope;
    for (const s of [-1, 1]) {
      b.add(M.wood, gBox(0.24, 3.1, 0.24).translate(s * 1.7, 1.55, 0));
      b.add(M.wood, strut(s * 1.7, 0.1, 0.95, s * 1.7, 2.0, 0, 0.1, 5));
    }
    b.add(M.wood, gBox(3.9, 0.28, 0.28).translate(0, 3.0, 0));
    const swing = new THREE.Group();
    swing.position.set(0, 2.86, 0.1);
    const swb = createBatcher();
    swb.add(M.rope, strut(0, 0, 0, 0, -2.35, 0, 0.045, 5));
    swb.add(M.plank, gBox(0.92, 0.09, 0.3).translate(0, -2.42, 0));
    swb.add(M.rope, strut(-0.3, -2.36, 0, 0.25, -2.42, 0, 0.02, 4));
    swb.flush(swing, { name: 'ropeSwing' });
    holder.add(swing);
    parts.ropeSwing = swing;
    b.flush(holder, { name: 'ropeSwing' });
  }

  {
    // Picnic blanket + basket on the flattest patch near the orchard.
    const orchard = layout.pois.orchard.position;
    let spot = { s: Infinity, x: orchard.x, z: orchard.z };
    for (let i = 0; i < 240; i++) {
      const a = i * 2.39996;
      const r = 7 + (i % 40) * 0.72;
      if (r > 36) continue;
      const x = orchard.x + Math.cos(a) * r;
      const z = orchard.z + Math.sin(a) * r;
      const s = layout.slopeAt(x, z);
      if (s < spot.s) spot = { s, x, z };
    }
    const baseY = ground(spot.x, spot.z) - 0.25;
    const rot = rng.range(0, TAU);
    const scope = createPiece('picnic', spot.x, spot.z, baseY, rot);
    const { b, holder } = scope;
    // Blanket conforming to the grass.
    {
      const cols = 6;
      const rows = 5;
      const pos = [];
      const uv = [];
      const idx = [];
      for (let i = 0; i <= cols; i++) {
        for (let j = 0; j <= rows; j++) {
          const lx = -1.65 + (i / cols) * 3.3;
          const lz = -1.35 + (j / rows) * 2.7;
          const w = localToWorld(spot.x, spot.z, rot, lx, lz);
          pos.push(lx, ground(w.x, w.z) - baseY + 0.07, lz);
          uv.push(i / cols, j / rows);
        }
      }
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const a = i * (rows + 1) + j;
          idx.push(a, a + 1, a + rows + 1, a + 1, a + rows + 2, a + rows + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setIndex(idx);
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc0503f, roughness: 0.95, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      holder.add(mesh);
    }
    // Basket, plates, bottle, apples, blanket roll.
    b.add(M.wicker, tileUV(gCyl(0.36, 0.3, 0.42, 12), 3, 1).translate(0.35, 0.3, 0.2));
    b.add(M.wicker, gCyl(0.38, 0.38, 0.06, 12).translate(0.35, 0.53, 0.2));
    b.add(M.wicker, gTorus(0.34, 0.045, 4, 12, Math.PI).rotateY(HALF_PI).translate(0.35, 0.55, 0.2));
    b.add(M.fabricCream, gCyl(0.24, 0.24, 0.04, 12).translate(-0.75, 0.12, -0.5));
    b.add(M.fabricCream, gCyl(0.24, 0.24, 0.04, 12).translate(1.0, 0.12, -0.35));
    b.add(M.flowerCream, gCyl(0.16, 0.2, 0.24, 8).translate(-0.3, 0.2, 0.75));
    b.add(M.flowerCream, gCyl(0.07, 0.09, 0.2, 6).translate(-0.3, 0.42, 0.75));
    b.add(M.flowerRed, gSphere(0.11, 7, 5).translate(0.9, 0.18, 0.6));
    b.add(M.flowerRed, gSphere(0.1, 7, 5).translate(-1.1, 0.15, 0.35));
    b.add(M.blanket, gBox(0.9, 0.22, 0.36).rotateY(0.3).translate(1.2, 0.12, -1.05));
    b.flush(holder, { name: 'picnic' });
  }

  {
    // Railed viewing platform at the west-cliff bench.
    const p = layout.pois.bench.position;
    const baseY = ground(p.x, p.z) - 0.4;
    const rot = HALF_PI - Math.atan2(p.z, p.x);     // holder local +Z looks out to sea
    const scope = createPiece('viewpoint', p.x, p.z, baseY, rot);
    const { b, holder } = scope;
    const DECK = 0.95;
    b.add(M.plank, tileUV(gBox(5.6, 0.26, 4.6, 6, 1, 5), 6, 5).translate(0, DECK, 0));
    for (const px of [-2.5, 0, 2.5]) {
      for (const pz of [-2.0, 2.0]) {
        const w = localToWorld(p.x, p.z, rot, px, pz);
        const gy = ground(w.x, w.z) - baseY;
        const h = DECK - gy + 1.2;
        b.add(M.wood, gBox(0.24, h, 0.24).translate(px, DECK - h * 0.5 + 0.06, pz));
      }
    }
    const railRuns = [
      { x: -2.68, z: 0, len: 4.6, alongX: false },
      { x: 2.68, z: 0, len: 4.6, alongX: false },
      { x: 0, z: -2.28, len: 5.6, alongX: true },
    ];
    for (const run of railRuns) {
      b.add(M.wood, gBox(run.len, 0.14, 0.14).translate(run.x, DECK + 1.24, run.z));
      b.add(M.wood, gBox(run.len, 0.1, 0.1).translate(run.x, DECK + 0.72, run.z));
      const posts = Math.round(run.len / 1.4) + 1;
      for (let i = 0; i < posts; i++) {
        const t = posts === 1 ? 0.5 : i / (posts - 1);
        const off = (t - 0.5) * run.len;
        b.add(M.wood, gBox(0.16, 1.36, 0.16)
          .translate(run.alongX ? run.x + off : run.x, DECK + 0.68, run.alongX ? run.z : run.z + off));
      }
    }
    // Bench + a marker stone.
    b.add(M.plank, gBox(2.0, 0.12, 0.55).translate(0, DECK + 0.55, -0.35));
    b.add(M.plank, gBox(2.0, 0.55, 0.1).translate(0, DECK + 0.88, -0.05));
    b.add(M.wood, gBox(0.12, 0.55, 0.5).translate(-0.85, DECK + 0.28, -0.35));
    b.add(M.wood, gBox(0.12, 0.55, 0.5).translate(0.85, DECK + 0.28, -0.35));
    b.add(M.rockDark, displace(gIco(0.42, 0), 0.14, 0.8, noise, 111).translate(-2.2, 0.35, 1.9));
    b.flush(holder, { name: 'viewpoint' });
  }

  // =========================================================================
  // Animation (allocation-free)
  // =========================================================================

  let simTime = 0;
  const rowboatY = parts.rowboat ? parts.rowboat.position.y : 0;

  function update(dt, state) {
    if (!(dt > 0)) dt = 0;
    else if (dt > 0.25) dt = 0.25;          // clamp long frames / tab switches
    simTime += dt;
    const hour = state && typeof state.hour === 'number' ? state.hour : 17.1;
    const night = nightAmount(Number.isFinite(hour) ? hour : 17.1);

    for (let i = 0; i < nightLights.length; i++) {
      const l = nightLights[i];
      l.mat.emissiveIntensity = l.max * night;
    }
    // Lighthouse: beam sweeps faster after dark and only shows at night.
    if (parts.beamRotator) parts.beamRotator.rotation.y += dt * (0.55 + 0.45 * night);
    if (parts.beamMat) parts.beamMat.opacity = 0.25 * night;
    if (parts.lensMat) parts.lensMat.emissiveIntensity = 0.35 + 1.9 * night;

    for (let i = 0; i < animated.length; i++) {
      const a = animated[i];
      if (a.drift) {
        a.angle += dt * a.speed;
        a.group.position.x = a.cx + Math.cos(a.angle) * a.r;
        a.group.position.z = a.cz + Math.sin(a.angle) * a.r;
        a.group.position.y = a.baseY + Math.sin(simTime * 0.42) * 1.7;
        a.group.rotation.y = HALF_PI - a.angle;
        a.group.rotation.z = Math.sin(simTime * 0.6) * 0.045;
      } else if (a.fixed) {
        // Grounded balloon: slow breathing as it fills.
        a.group.scale.y = 0.34 + Math.sin(simTime * 0.5) * 0.012;
      } else {
        a.group.position.y = a.baseY + Math.sin(simTime * a.rate + a.phase) * a.amp;
        a.group.rotation.z = Math.sin(simTime * 0.41 + a.phase) * 0.035;
        a.group.rotation.x = Math.cos(simTime * 0.33 + a.phase) * 0.028;
      }
    }
    if (parts.burnerMat) {
      parts.burnerMat.emissiveIntensity = (0.3 + 0.7 * night)
        * (1.5 + Math.sin(simTime * 9.3) * 0.6 + Math.sin(simTime * 21.7) * 0.25);
    }
    if (parts.telescopeYoke) parts.telescopeYoke.rotation.y = Math.sin(simTime * 0.17) * 0.6;
    if (parts.bell) parts.bell.rotation.z = Math.sin(simTime * 2.05) * 0.19;
    if (parts.pennant) {
      parts.pennant.rotation.y = Math.sin(simTime * 1.15) * 0.7;
      parts.pennant.rotation.z = Math.sin(simTime * 3.4) * 0.09;
    }
    if (parts.banner) parts.banner.rotation.x = Math.sin(simTime * 1.6) * 0.035;
    if (parts.ropeSwing) parts.ropeSwing.rotation.z = Math.sin(simTime * 0.63) * 0.17;
    if (parts.rowboat) {
      parts.rowboat.position.y = rowboatY + Math.sin(simTime * 0.85) * 0.05;
      parts.rowboat.rotation.z = Math.sin(simTime * 0.72) * 0.022;
      parts.rowboat.rotation.x = Math.cos(simTime * 0.61) * 0.018;
    }
  }

  // =========================================================================
  // Stats + contract
  // =========================================================================

  let tris = 0;
  let meshes = 0;
  let lines = 0;
  group.traverse((o) => {
    if (o.isMesh) {
      const g = o.geometry;
      const count = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
      tris += (count / 3) * (o.isInstancedMesh ? o.count : 1);
      meshes++;
    } else if (o.isLine) {
      lines++;
    }
  });
  if (preset && preset.shadows === false) {
    group.traverse((o) => { o.castShadow = false; });
  }

  return {
    group,
    update,
    colliders,
    emitters,
    parts,
    stats: { count: ids.length, tris: Math.round(tris), meshes, lines },
    samples,
  };
}

// ---------------------------------------------------------------------------
// Module-level helpers: canvas decals + terrain-conforming geometry
// ---------------------------------------------------------------------------

/** World position of a holder-local offset (matches three's Y rotation). */
function localToWorld(ox, oz, rot, lx, lz) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: ox + lx * c + lz * s, z: oz - lx * s + lz * c };
}

/** Flat ring that follows the terrain, returned in holder-local space. */
function terrainRing(layout, cx, cz, rInner, rOuter, segs, lift, baseY) {
  const pos = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const rr of [rInner, rOuter]) {
      const x = cx + ca * rr;
      const z = cz + sa * rr;
      pos.push(x - cx, layout.heightAt(x, z) - baseY + lift, z - cz);
      uvs.push((rr - rInner) / (rOuter - rInner), i / segs);
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

/** A single flat triangle (pennants, flags). */
function triangleMesh(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([ax, ay, az, bx, by, bz, cx, cy, cz], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  g.computeVertexNormals();
  return g;
}

/** Fresh canvas + 2D context, or null when canvas drawing is unavailable. */
function canvasContext(TEX, size) {
  const canvas = TEX && typeof TEX.canvas === 'function' ? TEX.canvas(size) : null;
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  let g = null;
  try {
    g = canvas.getContext('2d');
  } catch (err) {
    return null;
  }
  return g ? { canvas, g } : null;
}

/** Carved spiral for the standing-stones altar slab. */
function drawSpiral(TEX) {
  const hit = canvasContext(TEX, 256);
  if (!hit) return null;
  const canvas = hit.canvas;
  const g = hit.g;
  try {
    if (typeof g.clearRect === 'function') g.clearRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(58,49,40,0.92)';
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= 260; i++) {
      const t = i / 260;
      const a = t * TAU * 3.1;
      const r = 8 + t * 106;
      const x = 128 + Math.cos(a) * r;
      const y = 128 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.lineWidth = 5;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU;
      g.beginPath();
      g.moveTo(128 + Math.cos(a) * 116, 128 + Math.sin(a) * 116);
      g.lineTo(128 + Math.cos(a) * 124, 128 + Math.sin(a) * 124);
      g.stroke();
    }
  } catch (err) {
    return null;
  }
  return canvas;
}

/** Big wooden sign board: the island's Chinese title. */
function drawSignBoard(TEX) {
  const hit = canvasContext(TEX, 1024);
  if (!hit) return null;
  const canvas = hit.canvas;
  const g = hit.g;
  try {
    g.fillStyle = '#5c3f26';
    g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#6d4a2c';
    for (let i = 1; i < 4; i++) g.fillRect(0, i * 64 - 2, 1024, 3);
    g.strokeStyle = '#d9b877';
    g.lineWidth = 8;
    g.strokeRect(20, 20, 984, 216);
    const text = '提鹅鹏 · 单车环岛';
    let measured = 0;
    try {
      g.font = 'bold 104px "Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif';
      measured = g.measureText(text).width || 0;
    } catch (err) {
      measured = 0;
    }
    if (!measured) {
      // Graceful fallback: whatever serif face the system actually has.
      try { g.font = 'bold 104px serif'; } catch (err) { /* keep previous face */ }
    }
    g.fillStyle = '#f4e6c4';
    try {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
    } catch (err) { /* defaults are fine */ }
    g.fillText(text, 512, 140);
  } catch (err) {
    return null;
  }
  return canvas;
}

/** Start / finish banner cloth (ASCII only). */
function drawBanner(TEX) {
  const hit = canvasContext(TEX, 512);
  if (!hit) return null;
  const canvas = hit.canvas;
  const g = hit.g;
  try {
    g.fillStyle = '#f2e8d5';
    g.fillRect(0, 0, 512, 96);
    g.fillStyle = '#1f6f78';
    g.fillRect(0, 0, 512, 10);
    g.fillRect(0, 86, 512, 10);
    try { g.font = 'bold 46px Georgia,"Times New Roman",serif'; } catch (err) { /* default face */ }
    g.fillStyle = '#2f2a24';
    try {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
    } catch (err) { /* defaults are fine */ }
    g.fillText('START / FINISH', 256, 48);
    g.fillStyle = '#e0523f';
    g.beginPath();
    g.moveTo(20, 48);
    g.lineTo(52, 30);
    g.lineTo(52, 66);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(492, 48);
    g.lineTo(460, 30);
    g.lineTo(460, 66);
    g.closePath();
    g.fill();
  } catch (err) {
    return null;
  }
  return canvas;
}

/** Kilometre-zero marker plate. */
function drawKmZero(TEX) {
  const hit = canvasContext(TEX, 256);
  if (!hit) return null;
  const canvas = hit.canvas;
  const g = hit.g;
  try {
    g.fillStyle = '#e9e2d4';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#8d9198';
    g.lineWidth = 10;
    g.strokeRect(14, 14, 228, 228);
    try { g.font = 'bold 96px Georgia,"Times New Roman",serif'; } catch (err) { /* default face */ }
    g.fillStyle = '#2f2a24';
    try {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
    } catch (err) { /* defaults are fine */ }
    g.fillText('KM 0', 128, 128);
  } catch (err) {
    return null;
  }
  return canvas;
}
