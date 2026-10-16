/**
 * vegetation.js - everything that grows (and everything the sea throws up).
 *
 * Everything is procedural: primitive geometries are baked into one merged
 * BufferGeometry per tree/bush/rock variant, then drawn with InstancedMesh.
 * Ground cover (grass, flowers) is chunked on a 500 m grid so the frustum can
 * cull it; trees/bushes/rocks are spread over the island and culled as whole
 * meshes.
 *
 * Placement always goes through layout.isClear()/layout.biomeAt() so the road,
 * the river, the lake and the landmark POIs stay clear. The four *region* POIs
 * (forest, pineForest, beach, beachEast) are already excluded from the POI veto
 * inside layout.isClear() - which is exactly where wild trees belong.
 *
 * Deterministic: everything derives from new Rng('vegetation:' + layout.seed).
 * update() writes wind uniforms and toggles ground-cover chunk visibility by
 * distance - it never allocates.
 *
 * See docs/SPEC.md sections 4.5 / 4.9 for the frozen contracts.
 */

import * as THREE from 'three';
import { Rng, TAU, HALF_PI, lerp, createSlicer } from '../core/utils.js';
import { QUALITY_PRESETS } from '../core/settings.js';

// ---------------------------------------------------------------------------
// Module scratch objects - reused by every build pass and by update()
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _vec = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const _roadPt = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 500;                // grass/flower chunk edge, meters
const CHUNK_GRID = 12;                 // 12 x 12 chunks cover the 6000 m world
const TREE_MIN_SPACING = 4;            // m, hard minimum between two tree trunks
const COLLIDER_MIN_RADIUS = 0.35;      // m, only thicker trunks become colliders
const COLLIDER_ROAD_RANGE = 25;        // m, colliders only matter near the road
const COLLIDER_CAP = 600;
const GRASS_ATTEMPT_DENSITY = 0.032;  // attempts / m^2 of land (high preset)
const FLOWER_PATCH_DENSITY = 0.00011; // patches / m^2 of meadow + forest

const GRASS_BIOME_WEIGHT = {
  meadow: 1.0, forest: 0.55, beach: 0.22, rock: 0.65,
  road: 0, river: 0, lake: 0, ocean: 0, snow: 0,
};
const FLOWER_BIOME_WEIGHT = { meadow: 1.0, forest: 0.45 };

const FLOWER_KINDS = [
  { id: 'poppy', weight: 0.28, height: 0.70 },
  { id: 'daisy', weight: 0.24, height: 0.42 },
  { id: 'cornflower', weight: 0.18, height: 0.66 },
  { id: 'mustard', weight: 0.16, height: 0.92 },
  { id: 'lupine', weight: 0.14, height: 1.00 },
];

const BUSH_KINDS = ['shrub', 'bramble', 'gorse'];

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

/** Accepts either a raw THREE.Texture or a texture-surface record. */
function texMap(value) {
  if (!value) return null;
  if (value.isTexture) return value;
  return value.map || null;
}

/** Compose TRS into the module scratch matrix. */
function trs(x, y, z, rx, ry, rz, sx, sy, sz) {
  _euler.set(rx || 0, ry || 0, rz || 0);
  _quat.setFromEuler(_euler);
  _pos.set(x, y, z);
  _scl.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
  return _m4.compose(_pos, _quat, _scl);
}

// ---------------------------------------------------------------------------
// Merged geometry builder
//
// A part list accumulates non-indexed position/normal/uv streams plus one group
// per contiguous material run; the result is ONE BufferGeometry, which is what
// "merge each variant into a single geometry" asks for.
// ---------------------------------------------------------------------------

function newPartList() {
  // `part` mirrors the material index of every vertex; it becomes the
  // aVegPart attribute that lets the shadow pass keep trunk and drop foliage.
  return { pos: [], nor: [], uv: [], part: [], groups: [], verts: 0 };
}

function addPart(list, geometry, materialIndex, matrix) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const u = g.attributes.uv;
  const normalMatrix = matrix ? _m3.getNormalMatrix(matrix) : null;
  const start = list.verts;

  for (let i = 0; i < p.count; i++) {
    _vec.fromBufferAttribute(p, i);
    if (matrix) _vec.applyMatrix4(matrix);
    list.pos.push(_vec.x, _vec.y, _vec.z);

    if (n) {
      _nrm.fromBufferAttribute(n, i);
      if (normalMatrix) _nrm.applyMatrix3(normalMatrix);
      _nrm.normalize();
      list.nor.push(_nrm.x, _nrm.y, _nrm.z);
    } else {
      list.nor.push(0, 1, 0);
    }
    list.uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    list.part.push(materialIndex);
  }

  const count = p.count;
  const groups = list.groups;
  const last = groups[groups.length - 1];
  if (last && last.materialIndex === materialIndex) last.count += count;
  else groups.push({ start, count, materialIndex });
  list.verts += count;

  if (g !== geometry) g.dispose();
}

function finishPartList(list, upNormals) {
  const geo = new THREE.BufferGeometry();
  if (upNormals) {
    for (let i = 0; i < list.verts; i++) {
      list.nor[i * 3] = 0;
      list.nor[i * 3 + 1] = 1;
      list.nor[i * 3 + 2] = 0;
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(list.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(list.nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(list.uv, 2));
  if (list.groups.length > 1) geo.setAttribute('aVegPart', new THREE.Float32BufferAttribute(list.part, 1));
  for (const g of list.groups) geo.addGroup(g.start, g.count, g.materialIndex);
  geo.computeBoundingSphere();
  return geo;
}

/** Crossed pair of quads, base at local y = 0, height exactly 1. */
function crossQuadGeometry() {
  const parts = newPartList();
  const a = new THREE.PlaneGeometry(1, 1, 1, 1);
  a.translate(0, 0.5, 0);
  addPart(parts, a, 0, null);
  const b = new THREE.PlaneGeometry(1, 1, 1, 1);
  b.rotateY(HALF_PI);
  b.translate(0, 0.5, 0);
  addPart(parts, b, 0, null);
  a.dispose();
  b.dispose();
  return finishPartList(parts, true);
}

/** A tapered, bent leaf blade (reeds / seaweed / drooping strands). */
function bladeGeometry(width, height, bend, taper) {
  const parts = newPartList();
  const g = new THREE.PlaneGeometry(width, height, 1, 3);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + height * 0.5) / height;
    const k = lerp(1, taper === undefined ? 0.12 : taper, t * t);
    p.setX(i, p.getX(i) * k + bend * t * t);
  }
  p.needsUpdate = true;
  g.translate(0, height * 0.5, 0);
  addPart(parts, g, 0, null);
  g.dispose();
  return finishPartList(parts, true);
}

/** Cone with a baked sideways curve, used as a palm frond. */
function bentCone(radius, height, segments, bend) {
  const g = new THREE.ConeGeometry(radius, height, segments, 1, true);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + height * 0.5) / height;
    p.setX(i, p.getX(i) + bend * t * t);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Lumpy boulder shell. IcosahedronGeometry is non-indexed (vertices are
 * duplicated per face), so the displacement has to be a pure function of the
 * vertex position - otherwise the rock tears apart.
 */
function boulderGeometry(radius, detail, squash, seed) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const p = g.attributes.position;
  const ox = 11.3 + seed * 3.7, oz = 7.1 + seed * 1.9;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const s = Math.sin(x * 1.7 + ox) * Math.cos(z * 1.3 + oz) + 0.55 * Math.sin(y * 2.9 - ox * 0.5);
    const k = 1 + 0.24 * s;
    p.setXYZ(i, x * k, y * k * squash, z * k);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createVegetation(ctx) {
  const layout = ctx.layout;
  const textures = ctx.textures || {};
  const engine = ctx.engine || null;
  const bus = ctx.bus || null;

  const qualityLevel = (engine && engine.qualityLevel) || ctx.quality || 'high';
  const preset = (engine && engine.preset) || QUALITY_PRESETS[qualityLevel] || QUALITY_PRESETS.high;

  // Determinism contract (docs/SPEC.md section 8): one stream, fixed order.
  const rng = new Rng('vegetation:' + layout.seed);

  const HALF = layout.HALF;
  const WORLD = layout.WORLD_SIZE;
  const LAKE = layout.lake;
  const LAKE_Y = layout.lakeY;

  const group = new THREE.Group();
  group.name = 'vegetation';

  const sharedUniforms = {
    time: { value: 0 },
    windDir: { value: new THREE.Vector2(0.7, 0.5).normalize() },
    windStrength: { value: 0.4 },
  };
  let elapsed = 0;

  // Cooperative build slicing: the scatter passes below yield to the browser
  // whenever ~24 ms of work has piled up, so the boot is a run of short tasks
  // instead of one multi-second freeze (the progress bar keeps animating and
  // Lighthouse total blocking time stays near zero).
  const slice = createSlicer(24);

  // TEMP-PROFILE: build-stage stopwatch (browser only) - remove after tuning.
  const __timing = typeof window !== 'undefined' && typeof performance !== 'undefined';
  let __tprev = __timing ? performance.now() : 0;
  const __tmark = (name) => {
    if (!__timing) return;
    const now = performance.now();
    console.log(`[pelican] veg.${name} ${Math.round(now - __tprev)}ms`);
    __tprev = now;
  };

  /** Meshes whose instance count follows a preset density multiplier. */
  const scaledMeshes = [];
  /** Meshes that may cast shadows, with the tier each one belongs to. */
  const shadowMeshes = [];
  /**
   * Ground-cover chunk meshes (grass, flowers) and the preset draw distance: a
   * chunk further than `chunkRange` contributes sub-pixel tufts and is skipped
   * in update() - the terrain splat already carries its colour out there.
   */
  const chunkedMeshes = [];
  let chunkRange = 1300;
  const built = {};

  const stats = {
    trees: 0, grass: 0, flowers: 0, rocks: 0,
    bushes: 0, reeds: 0, lilies: 0, seaweed: 0, driftwood: 0, shells: 0,
    treeColliders: 0, grassChunks: 0, flowerChunks: 0, variants: 0,
  };
  const treeColliders = [];

  const densityOf = (key) => {
    const v = preset[key];
    return typeof v === 'number' && v > 0 ? v : 1;
  };

  // -------------------------------------------------------------------------
  // Materials - one instance per look, shared by every variant that uses it
  // -------------------------------------------------------------------------

  function surfaceMaterial(surface, opts) {
    const s = surface || {};
    return new THREE.MeshStandardMaterial(Object.assign({
      color: 0xffffff,
      map: s.map || null,
      normalMap: s.normalMap || null,
      roughnessMap: s.roughnessMap || null,
      roughness: 0.9,
      metalness: 0,
    }, opts || {}));
  }

  function foliage(color, extra) {
    return new THREE.MeshStandardMaterial(Object.assign({
      color, roughness: 0.95, metalness: 0,
    }, extra || {}));
  }

  // Defensive lookup: tests hand us a proxy whose properties are not callable,
  // so a missing/!function texture factory degrades to an untextured material.
  function callTex(name, ...args) {
    const fn = textures[name];
    return typeof fn === 'function' ? fn(...args) : null;
  }

  const surfBark = callTex('bark');
  const surfPlanks = callTex('planks');
  const surfRock = callTex('rock');

  const matBark = surfaceMaterial(surfBark, { roughness: 0.94 });
  const matBarkPale = surfaceMaterial(surfBark, { color: 0xd8d1c2, roughness: 0.9 });
  const matDriftwood = surfaceMaterial(surfPlanks, { color: 0xbdb4a5, roughness: 0.96 });
  const matRock = surfaceMaterial(surfRock, { flatShading: true, roughness: 0.96 });
  const matPebble = surfaceMaterial(surfRock, { flatShading: true, roughness: 0.93, color: 0xc9c1b2 });

  const matFoliageDark = foliage(0x33512c);                                  // pine, cypress
  const matFoliageWarm = foliage(0x5f8c3a);                                  // oak
  const matFoliageLight = foliage(0x8aa851);                                 // birch
  const matFoliagePalm = foliage(0x4d8a3c, { side: THREE.DoubleSide });      // palm
  const matFoliageWillow = foliage(0x6f9a52);                                // eucalyptus/willow
  const matGorse = foliage(0xe4c247, { roughness: 0.7, emissive: 0x241c04 });
  const matReed = foliage(0x4f7c3c, { side: THREE.DoubleSide });
  const matCattail = foliage(0x6d4a2c, { roughness: 0.85 });
  const matLilyPad = foliage(0x3f6f3c, { roughness: 0.65, side: THREE.DoubleSide });
  const matLotus = foliage(0xe9a7c4, { roughness: 0.6 });
  const matSeaweed = foliage(0x37623c, { side: THREE.DoubleSide, roughness: 0.8 });
  const matShell = foliage(0xe4d6bd, { roughness: 0.7 });

  const matGrass = new THREE.MeshStandardMaterial({
    map: texMap(callTex('grassBladeSprite')),
    alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.95, metalness: 0,
  });

  const matFlower = {};
  for (let i = 0; i < FLOWER_KINDS.length; i++) {
    const kind = FLOWER_KINDS[i];
    matFlower[kind.id] = new THREE.MeshStandardMaterial({
      map: texMap(callTex('flowerSprite', kind.id, 341 + i * 7)),
      alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
    });
  }

  /**
   * Vertex-shader wind. Time / direction / strength come from the shared
   * uniform objects, so update() touches exactly three values; amplitude,
   * height normalisation and speed are baked into the program source and folded
   * into the program cache key.
   */
  function applyWind(material, amp, heightScale, speed) {
    const a = amp.toFixed(5);
    const h = heightScale.toFixed(6);
    const s1 = speed.toFixed(4);
    const s2 = (speed * 2.31).toFixed(4);
    const body = [
      '#include <begin_vertex>',
      '{',
      `  float windH = clamp(transformed.y * ${h}, 0.0, 1.0);`,
      '  float windPhase;',
      '  vec2 windLocal = uWindDir;',
      '  #ifdef USE_INSTANCING',
      '    vec3 windCx = normalize(instanceMatrix[0].xyz);',
      '    vec3 windCz = normalize(instanceMatrix[2].xyz);',
      '    windPhase = instanceMatrix[3].x * 0.19 + instanceMatrix[3].z * 0.157;',
      '    windLocal = vec2(',
      '      dot(vec3(uWindDir.x, 0.0, uWindDir.y), windCx),',
      '      dot(vec3(uWindDir.x, 0.0, uWindDir.y), windCz));',
      '  #else',
      '    windPhase = 0.0;',
      '  #endif',
      `  float windS = sin(uTime * ${s1} + windPhase) * 0.62 + sin(uTime * ${s2} + windPhase * 1.73) * 0.38;`,
      `  float windA = ${a} * windH * (0.55 + 0.75 * uWindStrength);`,
      '  transformed.x += windLocal.x * windS * windA;',
      '  transformed.z += windLocal.y * windS * windA;',
      '}',
    ].join('\n');

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = sharedUniforms.time;
      shader.uniforms.uWindDir = sharedUniforms.windDir;
      shader.uniforms.uWindStrength = sharedUniforms.windStrength;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nuniform vec2 uWindDir;\nuniform float uWindStrength;'
        )
        .replace('#include <begin_vertex>', body);
    };
    material.customProgramCacheKey = () => `vegWind:${a}:${h}:${s1}`;
    return material;
  }

  applyWind(matFoliageDark, 0.13, 1 / 12, 0.95);
  applyWind(matFoliageWarm, 0.13, 1 / 12, 0.85);
  applyWind(matFoliageLight, 0.15, 1 / 11, 1.1);
  applyWind(matFoliagePalm, 0.34, 1 / 7, 0.75);
  applyWind(matFoliageWillow, 0.26, 1 / 9, 0.8);
  applyWind(matGorse, 0.1, 0.5, 1.2);
  applyWind(matGrass, 0.22, 1, 1.35);
  applyWind(matReed, 0.3, 1, 1.15);
  applyWind(matSeaweed, 0.16, 1, 1.5);
  for (const kind of FLOWER_KINDS) applyWind(matFlower[kind.id], 0.11, 1, 1.6);

  // -------------------------------------------------------------------------
  // Tree species - each variant is ONE merged geometry plus scale metadata
  // -------------------------------------------------------------------------

  __tmark('materials+wind');
  function buildPineVariant(r) {
    const h = r.range(10, 22);
    const trunkR = 0.14 + h * 0.014;
    const trunkH = h * 0.78;
    const parts = newPartList();
    // Open-ended: a trunk cap is either buried (bottom) or inside the canopy
    // (top), so both caps are invisible and cost 2 x radialSegments triangles.
    addPart(parts, new THREE.CylinderGeometry(trunkR * 0.52, trunkR, trunkH, 6, 1, true), 0, trs(0, trunkH * 0.5, 0));

    const layers = r.irange(4, 6);
    const baseY = h * r.range(0.24, 0.32);
    for (let i = 0; i < layers; i++) {
      const t = layers > 1 ? i / (layers - 1) : 0;
      const radius = lerp(h * 0.27, h * 0.055, t) * r.range(0.9, 1.12);
      const height = h * lerp(0.34, 0.2, t);
      const y = lerp(baseY, h * 0.9, t);
      const ox = h * 0.03 * r.range(-1, 1);
      const oz = h * 0.03 * r.range(-1, 1);
      const cone = new THREE.ConeGeometry(radius, height, 7, 1, true);
      addPart(parts, cone, 1, trs(ox, y + height * 0.5, oz, 0, r.float() * TAU, r.range(-0.06, 0.06)));
      cone.dispose();
    }
    return { geometry: finishPartList(parts), height: h, trunkRadius: trunkR };
  }

  function buildOakVariant(r) {
    const h = r.range(9, 18);
    const trunkR = 0.16 + h * 0.016;
    const trunkH = h * r.range(0.42, 0.52);
    const parts = newPartList();
    addPart(parts, new THREE.CylinderGeometry(trunkR * 0.55, trunkR, trunkH, 7, 1, true), 0, trs(0, trunkH * 0.5, 0));

    const branches = r.irange(2, 3);
    for (let i = 0; i < branches; i++) {
      const a = (i / branches) * TAU + r.range(0, 1.1);
      const len = h * r.range(0.16, 0.3);
      const tilt = r.range(0.55, 0.95);
      const br = trunkR * r.range(0.34, 0.55);
      const geo = new THREE.CylinderGeometry(br * 0.5, br, len, 5, 1, true);
      addPart(parts, geo, 0, trs(
        Math.cos(a) * len * 0.3, trunkH + len * 0.32, Math.sin(a) * len * 0.3,
        Math.sin(a) * tilt, 0, -Math.cos(a) * tilt
      ));
      geo.dispose();
    }

    const blobs = r.irange(6, 9);
    const crownY = h * r.range(0.6, 0.72);
    const crownR = h * r.range(0.22, 0.3);
    for (let i = 0; i < blobs; i++) {
      const a = (i / blobs) * TAU + r.range(-0.45, 0.45);
      const rr = crownR * r.range(0.4, 1.0);
      const blobR = h * r.range(0.13, 0.19);
      const geo = new THREE.IcosahedronGeometry(blobR, 0);
      addPart(parts, geo, 1, trs(
        Math.cos(a) * rr, crownY + h * r.range(-0.06, 0.16) - rr * 0.22, Math.sin(a) * rr,
        r.range(0, 3), r.range(0, 3), r.range(0, 3), 1, r.range(0.72, 0.95), 1
      ));
      geo.dispose();
    }
    return { geometry: finishPartList(parts), height: h, trunkRadius: trunkR };
  }

  function buildBirchVariant(r) {
    const h = r.range(8, 14);
    const trunkR = 0.08 + h * 0.008;
    const trunkH = h * 0.74;
    const parts = newPartList();
    const lean = r.range(-0.05, 0.05);
    addPart(parts, new THREE.CylinderGeometry(trunkR * 0.6, trunkR, trunkH, 6, 1, true), 0,
      trs(0, trunkH * 0.5, 0, 0, 0, lean));
    const topX = -Math.sin(lean) * trunkH;

    const blobs = r.irange(4, 7);
    const crownR = h * r.range(0.17, 0.24);
    for (let i = 0; i < blobs; i++) {
      const a = (i / blobs) * TAU + r.range(-0.5, 0.5);
      const rr = crownR * r.range(0.35, 1.0);
      const blobR = h * r.range(0.06, 0.095);
      const geo = new THREE.IcosahedronGeometry(blobR, 0);
      addPart(parts, geo, 1, trs(
        topX + Math.cos(a) * rr, h * r.range(0.62, 0.95), Math.sin(a) * rr,
        r.range(0, 3), r.range(0, 3), r.range(0, 3), 1, r.range(0.8, 1.05), 1
      ));
      geo.dispose();
    }
    return { geometry: finishPartList(parts), height: h, trunkRadius: trunkR };
  }

  function buildPalmVariant(r) {
    const h = r.range(6, 11);
    const trunkR = 0.13 + h * 0.012;
    const parts = newPartList();

    // Curved trunk: short stacked segments, each leaning a little more.
    const segments = 6;
    const segLen = (h * 0.84) / segments;
    const leanTotal = r.range(0.16, 0.44);
    let px = 0, py = 0;
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments, t1 = (i + 1) / segments;
      const am = (leanTotal * Math.pow(t0, 1.5) + leanTotal * Math.pow(t1, 1.5)) * 0.5;
      const dx = Math.sin(am), dy = Math.cos(am);
      const rad = trunkR * lerp(1.0, 0.82, t0);
      const geo = new THREE.CylinderGeometry(rad * 0.92, rad, segLen * 1.08, 6);
      addPart(parts, geo, 0, trs(px + dx * segLen * 0.5, py + dy * segLen * 0.5, 0, 0, 0, -am));
      geo.dispose();
      px += dx * segLen;
      py += dy * segLen;
    }

    const fronds = r.irange(7, 9);
    const frondLen = h * r.range(0.34, 0.46);
    for (let i = 0; i < fronds; i++) {
      const az = (i / fronds) * TAU + r.range(-0.3, 0.3);
      const tilt = HALF_PI - r.range(0.1, 0.8);
      const geo = bentCone(0.26, frondLen, 5, frondLen * r.range(0.3, 0.7));
      addPart(parts, geo, 1, trs(px, py, 0, 0, az, -tilt, 1, 1, 0.4));
      geo.dispose();
    }
    return { geometry: finishPartList(parts), height: h, trunkRadius: trunkR };
  }

  function buildCypressVariant(r) {
    const h = r.range(6, 10);
    const trunkR = 0.18 + h * 0.026;
    const parts = newPartList();
    addPart(parts, new THREE.CylinderGeometry(trunkR * 0.5, trunkR, h * 0.92, 6, 1, true), 0, trs(0, h * 0.46, 0));

    const layers = 4;
    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1);
      const y = lerp(h * 0.1, h * 0.66, t);
      const radius = h * lerp(0.135, 0.055, t) * r.range(0.92, 1.08);
      const height = h * lerp(0.34, 0.26, t);
      const geo = new THREE.ConeGeometry(radius, height, 6, 1, true);
      addPart(parts, geo, 1, trs(0, y + height * 0.5, 0, 0, r.float() * TAU, 0));
      geo.dispose();
    }
    const tip = new THREE.ConeGeometry(h * 0.045, h * 0.3, 5, 1, true);
    addPart(parts, tip, 1, trs(0, h * 0.85, 0));
    tip.dispose();
    return { geometry: finishPartList(parts), height: h, trunkRadius: trunkR };
  }

  function buildWillowVariant(r) {
    const h = r.range(7, 14);
    const trunkR = 0.13 + h * 0.011;
    const parts = newPartList();

    const segments = 2;
    const segLen = (h * 0.82) / segments;
    const leanTotal = r.range(0.04, 0.18);
    let px = 0, py = 0;
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments, t1 = (i + 1) / segments;
      const am = leanTotal * (t0 + t1) * 0.5;
      const dx = Math.sin(am), dy = Math.cos(am);
      const geo = new THREE.CylinderGeometry(trunkR * 0.8, trunkR, segLen * 1.06, 6, 1, true);
      addPart(parts, geo, 0, trs(px + dx * segLen * 0.5, py + dy * segLen * 0.5, 0, 0, 0, -am));
      geo.dispose();
      px += dx * segLen;
      py += dy * segLen;
    }

    const blobs = r.irange(3, 5);
    for (let i = 0; i < blobs; i++) {
      const t = blobs > 1 ? i / (blobs - 1) : 0;
      const crownR = h * lerp(0.3, 0.15, t);
      const geo = new THREE.IcosahedronGeometry(crownR * 0.55, 0);
      addPart(parts, geo, 1, trs(
        px + r.range(-0.2, 0.2) * h * 0.03, lerp(h * 0.6, h * 0.95, t), r.range(-0.2, 0.2) * h * 0.03,
        r.range(0, 3), r.range(0, 3), r.range(0, 3), 1.4, 0.52, 1.4
      ));
      geo.dispose();
    }

    // Drooping strands around the crown rim.
    const strands = r.irange(8, 12);
    for (let i = 0; i < strands; i++) {
      const a = (i / strands) * TAU + r.range(-0.2, 0.2);
      const rr = h * r.range(0.16, 0.28);
      const len = h * r.range(0.16, 0.3);
      const geo = new THREE.ConeGeometry(0.13, len, 4, 1, true);
      addPart(parts, geo, 1, trs(
        px + Math.cos(a) * rr, h * r.range(0.56, 0.78) - len * 0.4, Math.sin(a) * rr,
        Math.PI, a, r.range(-0.12, 0.12), 1, 1, 0.6
      ));
      geo.dispose();
    }
    return { geometry: finishPartList(parts), height: h, trunkRadius: trunkR };
  }

  const TREE_DEFS = [
    { id: 'pine', variants: 6, build: buildPineVariant, trunk: matBark, foliage: matFoliageDark, scale: [0.8, 1.25] },
    { id: 'oak', variants: 6, build: buildOakVariant, trunk: matBark, foliage: matFoliageWarm, scale: [0.8, 1.2] },
    { id: 'birch', variants: 5, build: buildBirchVariant, trunk: matBarkPale, foliage: matFoliageLight, scale: [0.85, 1.2] },
    { id: 'palm', variants: 5, build: buildPalmVariant, trunk: matBarkPale, foliage: matFoliagePalm, scale: [0.85, 1.15] },
    { id: 'cypress', variants: 4, build: buildCypressVariant, trunk: matBark, foliage: matFoliageDark, scale: [0.8, 1.2] },
    { id: 'willow', variants: 5, build: buildWillowVariant, trunk: matBark, foliage: matFoliageWillow, scale: [0.85, 1.15] },
  ];

  for (const def of TREE_DEFS) {
    def.baked = [];
    for (let i = 0; i < def.variants; i++) {
      const variant = def.build(rng);
      // Ground every trunk: the lowest baked vertex sits exactly at local y = 0,
      // so an instance at (x, heightAt(x, z) - sink, z) really stands on the
      // terrain (stacked/leaning trunk segments can dip a few centimetres).
      variant.geometry.computeBoundingBox();
      variant.geometry.translate(0, -variant.geometry.boundingBox.min.y, 0);
      variant.materials = [def.trunk, def.foliage];
      def.baked.push(variant);
    }
  }

  // -------------------------------------------------------------------------
  // Bush / rock / water-plant variants
  // -------------------------------------------------------------------------

  function buildBushVariant(r, kind) {
    const parts = newPartList();
    if (kind === 'shrub') {
      const blobs = r.irange(2, 3);
      for (let i = 0; i < blobs; i++) {
        const geo = new THREE.IcosahedronGeometry(r.range(0.5, 0.85), 0);
        addPart(parts, geo, 0, trs(r.range(-0.35, 0.35), r.range(0.3, 0.75), r.range(-0.35, 0.35),
          r.range(0, 3), r.range(0, 3), r.range(0, 3), 1.15, 0.85, 1.15));
        geo.dispose();
      }
      return { geometry: finishPartList(parts), height: 1.3 };
    }
    if (kind === 'bramble') {
      const blobs = r.irange(5, 8);
      for (let i = 0; i < blobs; i++) {
        // An octahedron (8 triangles) reads the same as an icosahedron (20) at
        // the 0.2-0.38 m this blob is, and the bramble has 5-8 of them.
        const geo = new THREE.OctahedronGeometry(r.range(0.2, 0.38), 0);
        addPart(parts, geo, 0, trs(r.range(-0.7, 0.7), r.range(0.22, 0.85), r.range(-0.7, 0.7),
          r.range(0, 3), r.range(0, 3), r.range(0, 3), 1, 0.8, 1));
        geo.dispose();
      }
      const twigs = r.irange(3, 4);
      for (let i = 0; i < twigs; i++) {
        const a = r.float() * TAU;
        const len = r.range(0.9, 1.4);
        const geo = new THREE.CylinderGeometry(0.02, 0.035, len, 4, 1, true);
        addPart(parts, geo, 0, trs(Math.cos(a) * 0.2, len * 0.42, Math.sin(a) * 0.2,
          Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5));
        geo.dispose();
      }
      return { geometry: finishPartList(parts), height: 1.5 };
    }
    // gorse: dark cushions studded with tiny yellow blossoms
    const blobs = r.irange(4, 6);
    const centers = [];
    for (let i = 0; i < blobs; i++) {
      const radius = r.range(0.35, 0.6);
      const cx = r.range(-0.5, 0.5), cy = r.range(0.3, 0.62), cz = r.range(-0.5, 0.5);
      centers.push({ cx, cy, cz, radius });
      const geo = new THREE.IcosahedronGeometry(radius, 0);
      addPart(parts, geo, 0, trs(cx, cy, cz, r.range(0, 3), r.range(0, 3), r.range(0, 3), 1.2, 0.9, 1.2));
      geo.dispose();
    }
    // Blossoms: they are 5 cm across, so past arm's length only the silhouette
    // matters - eight cheap octahedra instead of ten to eighteen icosahedra.
    const dots = r.irange(6, 10);
    for (let i = 0; i < dots; i++) {
      const c = centers[r.irange(0, centers.length - 1)];
      const a = r.float() * TAU;
      const dr = c.radius * r.range(1.0, 1.12);
      const geo = new THREE.OctahedronGeometry(r.range(0.04, 0.06), 0);
      addPart(parts, geo, 1, trs(
        c.cx + Math.cos(a) * dr, c.cy + r.range(-0.6, 0.9) * dr * 0.5, c.cz + Math.sin(a) * dr,
        r.range(0, 3), r.range(0, 3), r.range(0, 3)
      ));
      geo.dispose();
    }
    return { geometry: finishPartList(parts), height: 1.2 };
  }

  const BUSH_DEFS = [];
  for (const kind of BUSH_KINDS) {
    const baked = [];
    for (let i = 0; i < 3; i++) {
      const variant = buildBushVariant(rng, kind);
      variant.materials = kind === 'gorse' ? [matFoliageDark, matGorse] : [matFoliageWarm];
      baked.push(variant);
    }
    BUSH_DEFS.push({ id: kind, baked });
  }

  const ROCK_DEFS = [
    boulderGeometry(1.0, 1, 0.72, 0),
    boulderGeometry(1.35, 1, 0.78, 1),
    boulderGeometry(1.7, 1, 0.66, 2),
  ];
  const PEBBLE_DEFS = [
    boulderGeometry(0.32, 0, 0.55, 7),
    boulderGeometry(0.5, 0, 0.6, 8),
  ];

  const GEO_GRASS = crossQuadGeometry();
  const GEO_FLOWER = crossQuadGeometry();
  const GEO_REED = (() => {
    const parts = newPartList();
    for (let i = 0; i < 6; i++) {
      const blade = bladeGeometry(0.075, 1, rng.range(0.06, 0.3), 0.1);
      const a = (i / 6) * TAU + rng.range(-0.3, 0.3);
      addPart(parts, blade, 0, trs(0, 0, 0, 0, a, rng.range(0.08, 0.26)));
      blade.dispose();
    }
    return finishPartList(parts);
  })();
  const GEO_CATTAIL = (() => {
    const parts = newPartList();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + rng.range(-0.2, 0.2);
      const tilt = rng.range(0.05, 0.18);
      const height = rng.range(0.95, 1.25);
      const blade = bladeGeometry(0.07, height, rng.range(0.05, 0.2), 0.1);
      addPart(parts, blade, 0, trs(0, 0, 0, 0, a, tilt));
      blade.dispose();
      if (i < 3) {
        const head = new THREE.CylinderGeometry(0.042, 0.042, 0.22, 5);
        addPart(parts, head, 1, trs(Math.sin(tilt) * height * 0.9, height * 0.92, 0, 0, 0, tilt));
        head.dispose();
      }
    }
    return finishPartList(parts);
  })();
  const GEO_LILY = new THREE.CircleGeometry(0.55, 8).rotateX(-HALF_PI);
  const GEO_LOTUS = new THREE.IcosahedronGeometry(0.14, 0);
  const GEO_SEAWEED = (() => {
    const parts = newPartList();
    for (let i = 0; i < 4; i++) {
      const blade = bladeGeometry(0.18, rng.range(0.7, 1.15), rng.range(0.1, 0.45), 0.2);
      addPart(parts, blade, 0, trs(0, 0, 0, 0, rng.float() * TAU, rng.range(0.1, 0.4)));
      blade.dispose();
    }
    return finishPartList(parts);
  })();
  const GEO_DRIFTWOOD = (() => {
    const parts = newPartList();
    const pieces = rng.irange(2, 3);
    for (let i = 0; i < pieces; i++) {
      const len = rng.range(1.2, 3.0);
      const radius = rng.range(0.1, 0.22);
      const log = new THREE.CylinderGeometry(radius * 0.75, radius, len, 6);
      addPart(parts, log, 0, trs(rng.range(-0.2, 0.2), radius * 0.8, rng.range(-0.25, 0.25),
        0, rng.float() * TAU, HALF_PI));
      log.dispose();
    }
    const stubs = rng.irange(1, 3);
    for (let i = 0; i < stubs; i++) {
      const stub = new THREE.CylinderGeometry(0.05, 0.09, rng.range(0.4, 0.9), 5);
      addPart(parts, stub, 0, trs(rng.range(-0.3, 0.3), rng.range(0.2, 0.45), rng.range(-0.3, 0.3),
        rng.range(-0.8, 0.8), rng.float() * TAU, rng.range(-0.8, 0.8)));
      stub.dispose();
    }
    return finishPartList(parts);
  })();
  const GEO_SHELL = new THREE.IcosahedronGeometry(0.12, 0);

  // -------------------------------------------------------------------------
  // Placement helpers
  // -------------------------------------------------------------------------

  // Coarse height mask: cheap "is this even land" pre-filter before the
  // expensive layout.biomeAt() / layout.isClear() calls.
  const MASK_N = 129;
  const MASK_MIN = -HALF - 120;
  const MASK_STEP = (WORLD + 240) / (MASK_N - 1);
  const mask = new Float32Array(MASK_N * MASK_N);
  for (let j = 0; j < MASK_N; j++) {
    await slice();
    for (let i = 0; i < MASK_N; i++) {
      // Max of a small probe, not a point sample: a coastal cell must never
      // read as open ocean, or beach palms/seaweed get filtered out before the
      // exact heightAt()/isClear() checks ever run.
      let best = -Infinity;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const h = layout.heightAt(
            MASK_MIN + (i + dx * 0.34) * MASK_STEP,
            MASK_MIN + (j + dz * 0.34) * MASK_STEP
          );
          if (h > best) best = h;
        }
      }
      mask[j * MASK_N + i] = best;
    }
  }

  __tmark('geometry+mask');
  function fastHeight(x, z) {
    const gx = (x - MASK_MIN) / MASK_STEP;
    const gz = (z - MASK_MIN) / MASK_STEP;
    if (gx < 0 || gz < 0 || gx > MASK_N - 1 || gz > MASK_N - 1) return -999;
    const i0 = gx | 0, j0 = gz | 0;
    const i1 = i0 + 1 < MASK_N ? i0 + 1 : i0;
    const j1 = j0 + 1 < MASK_N ? j0 + 1 : j0;
    const fx = gx - i0, fz = gz - j0;
    const a = mask[j0 * MASK_N + i0], b = mask[j0 * MASK_N + i1];
    const c = mask[j1 * MASK_N + i0], d = mask[j1 * MASK_N + i1];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }

  // Match terrain's actual triangle surface; sub-grid height noise otherwise
  // buries short plants by metres on slopes. Cache vertices only during build.
  const terrainSegments = Math.max(64, preset.terrainSegments | 0);
  const terrainStep = WORLD / terrainSegments;
  const groundCache = new Float32Array((terrainSegments + 1) ** 2).fill(NaN);
  function groundVertex(i, j) {
    const index = j * (terrainSegments + 1) + i;
    let h = groundCache[index];
    if (Number.isNaN(h)) {
      h = layout.heightAt(-HALF + i * terrainStep, -HALF + j * terrainStep);
      groundCache[index] = h;
    }
    return h;
  }
  function coverHeight(x, z) {
    const gx = Math.max(0, Math.min(terrainSegments - 0.00001, (x + HALF) / terrainStep));
    const gz = Math.max(0, Math.min(terrainSegments - 0.00001, (z + HALF) / terrainStep));
    const i = Math.floor(gx), j = Math.floor(gz), u = gx - i, v = gz - j;
    const b = groundVertex(i + 1, j), c = groundVertex(i, j + 1);
    return u + v <= 1
      ? groundVertex(i, j) * (1 - u - v) + b * u + c * v
      : groundVertex(i + 1, j + 1) * (u + v - 1) + b * (1 - v) + c * (1 - u);
  }

  // Cached biome lookup: layout.biomeAt() runs several heightAt() queries and
  // the grass scatter calls it once per attempt (~1.5M at high). Biomes change
  // slowly, so one 40 m grid keeps the scatter visually identical while
  // removing the dominant boot cost (measured: grass pass 21.8 s -> seconds).
  const BIOME_STEP = 40;
  const BIOME_N = Math.ceil((WORLD + 240) / BIOME_STEP) + 1;
  const biomeGrid = new Int16Array(BIOME_N * BIOME_N);
  const biomeIds = [];
  const biomeIdsByName = new Map();
  for (let j = 0; j < BIOME_N; j++) {
    await slice();
    const z = MASK_MIN + j * BIOME_STEP;
    for (let i = 0; i < BIOME_N; i++) {
      const name = layout.biomeAt(MASK_MIN + i * BIOME_STEP, z);
      let id = biomeIdsByName.get(name);
      if (id === undefined) {
        id = biomeIds.length;
        biomeIdsByName.set(name, id);
        biomeIds.push(name);
      }
      biomeGrid[j * BIOME_N + i] = id;
    }
  }
  __tmark('biomeGrid');

  function biomeNear(x, z) {
    const i = Math.max(0, Math.min(BIOME_N - 1, Math.round((x - MASK_MIN) / BIOME_STEP)));
    const j = Math.max(0, Math.min(BIOME_N - 1, Math.round((z - MASK_MIN) / BIOME_STEP)));
    return biomeIds[biomeGrid[j * BIOME_N + i]];
  }

  // Uncertain-zone flags. A 40 m biome grid cannot resolve the 9.5 m road
  // ribbon, a gorge river or a shoreline, so instead of trusting the grid
  // there, cells that *may* touch those features are flagged and the exact
  // layout.* / biomeAt() rule runs only inside them. Flagging is generous by
  // half a cell diagonal, so an unflagged point can never violate the rules.
  const EXCL_STEP = 24;
  const EXCL_N = Math.ceil((WORLD + 240) / EXCL_STEP) + 1;
  const EXCL_SLACK = Math.hypot(EXCL_STEP, EXCL_STEP) * 0.5 + 0.5;
  const exclGrid = new Uint8Array(EXCL_N * EXCL_N);
  {
    const raw = new Uint8Array(EXCL_N * EXCL_N);
    for (let j = 0; j < EXCL_N; j++) {
      await slice();
      const z = MASK_MIN + j * EXCL_STEP;
      for (let i = 0; i < EXCL_N; i++) {
        const x = MASK_MIN + i * EXCL_STEP;
        let f = 0;
        if (layout.roadDistance(x, z) < 4.75 + EXCL_SLACK) f |= 1;
        if (layout.riverDistance(x, z) < 9 + EXCL_SLACK) f |= 2;
        const dl = Math.hypot(x - LAKE.center.x, z - LAKE.center.z);
        const surface = dl < LAKE.radius * 1.25 ? LAKE_Y : 0;
        if (coverHeight(x, z) < surface + 6) f |= 4;
        raw[j * EXCL_N + i] = f;
      }
    }
    // Dilate one cell so a flagged feature cannot clip a corner of a
    // neighbouring, unvisited cell.
    for (let j = 0; j < EXCL_N; j++) {
      await slice();
      for (let i = 0; i < EXCL_N; i++) {
        let f = 0;
        for (let dj = -1; dj <= 1 && f !== 7; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= EXCL_N) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= EXCL_N) continue;
            f |= raw[jj * EXCL_N + ii];
          }
        }
        exclGrid[j * EXCL_N + i] = f;
      }
    }
  }
  __tmark('exclGrid');

  function exclBits(x, z) {
    const i = Math.max(0, Math.min(EXCL_N - 1, Math.round((x - MASK_MIN) / EXCL_STEP)));
    const j = Math.max(0, Math.min(EXCL_N - 1, Math.round((z - MASK_MIN) / EXCL_STEP)));
    return exclGrid[j * EXCL_N + i];
  }

  /** Fraction of a chunk's 4x4 probe grid that reads as land above 1.2 m. */
  function chunkLandFraction(x0, z0) {
    let land = 0;
    const n = 4;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + ((i + 0.5) / n) * CHUNK_SIZE;
        const z = z0 + ((j + 0.5) / n) * CHUNK_SIZE;
        if (fastHeight(x, z) > 1.2) land++;
      }
    }
    return land / (n * n);
  }

  // Coarse spatial hash for the >= 4 m tree spacing rule.
  const treeHash = new Map();
  const hashKey = (ix, iz) => (ix + 4096) * 16384 + (iz + 4096);

  function treeSpacingOk(x, z) {
    const ix = Math.floor(x / TREE_MIN_SPACING);
    const iz = Math.floor(z / TREE_MIN_SPACING);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const cell = treeHash.get(hashKey(ix + a, iz + b));
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 2) {
          const dx = cell[k] - x, dz = cell[k + 1] - z;
          if (dx * dx + dz * dz < TREE_MIN_SPACING * TREE_MIN_SPACING) return false;
        }
      }
    }
    return true;
  }

  function treeSpacingAdd(x, z) {
    const key = hashKey(Math.floor(x / TREE_MIN_SPACING), Math.floor(z / TREE_MIN_SPACING));
    let cell = treeHash.get(key);
    if (!cell) {
      cell = [];
      treeHash.set(key, cell);
    }
    cell.push(x, z);
  }

  const poiForests = [layout.pois.forest, layout.pois.pineForest];
  const poiLandmarks = layout.poiList.filter((p) => p.type !== 'region');

  /** 0 far from every POI .. 1 right at a POI ring - drives "more near POIs". */
  function poiBoost(x, z) {
    let best = 0;
    for (let i = 0; i < poiLandmarks.length; i++) {
      const p = poiLandmarks[i];
      const d = Math.hypot(x - p.position.x, z - p.position.z);
      const reach = p.radius * 2.6;
      if (d < reach) {
        const k = 1 - d / reach;
        if (k > best) best = k;
      }
    }
    return best;
  }

  /** 1 on the forest rim, falling off both ways. */
  function forestEdgeBoost(x, z) {
    let best = 0;
    for (let i = 0; i < poiForests.length; i++) {
      const p = poiForests[i];
      const d = Math.hypot(x - p.position.x, z - p.position.z) / p.radius;
      const k = 1 - Math.abs(d - 1) / 0.4;
      if (k > best) best = k;
    }
    return best;
  }

  /** Ambient per-instance tint: subtle green variation, near 1.0. */
  function greenTint(r, jitter) {
    const j = jitter === undefined ? 1 : jitter;
    return [
      1 + (r.float() - 0.5) * 0.16 * j,
      1 + (r.float() - 0.5) * 0.3 * j,
      1 + (r.float() - 0.5) * 0.22 * j,
    ];
  }

  function greyTint(r, jitter) {
    const j = jitter === undefined ? 1 : jitter;
    return [
      1 + (r.float() - 0.5) * 0.24 * j,
      1 + (r.float() - 0.5) * 0.24 * j,
      1 + (r.float() - 0.5) * 0.22 * j,
    ];
  }

  /**
   * InstancedMesh factory. Instances are added in placement order, so trimming
   * mesh.count later draws a spatially random subset - that is how setQuality
   * downshifts without rebuilding anything.
   */
  function makeInstanced(name, geometry, material, list, opts) {
    const o = opts || {};
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const s = p.s === undefined ? 1 : p.s;
      _euler.set(p.rx || 0, p.ry || 0, p.rz || 0);
      _quat.setFromEuler(_euler);
      _pos.set(p.x, p.y, p.z);
      _scl.set(
        p.sx === undefined ? s : p.sx,
        p.sy === undefined ? s : p.sy,
        p.sz === undefined ? s : p.sz
      );
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;

    if (o.tint) {
      for (let i = 0; i < list.length; i++) {
        const t = list[i].tint;
        if (t) _col.setRGB(t[0], t[1], t[2]);
        else _col.setRGB(1, 1, 1);
        mesh.setColorAt(i, _col);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    mesh.name = name;
    mesh.frustumCulled = true;
    const tier = o.shadowTier || 'none';
    mesh.castShadow = tier === 'trunkFoliage'
      ? (trunkShadow || foliageShadow)
      : tier === 'trunk' ? trunkShadow : false;
    if (tier === 'trunkFoliage' && !foliageShadow) mesh.customDepthMaterial = trunkOnlyDepth;
    mesh.receiveShadow = !!o.receiveShadow;
    mesh.userData = {
      kind: o.kind || 'vegetation',
      densityKey: o.densityKey || null,
      baseCount: list.length,
      species: o.species || null,
      variant: o.variant === undefined ? -1 : o.variant,
      height: o.height || 0,
      trunkRadius: o.trunkRadius || 0,
      shadowTier: tier,
    };
    group.add(mesh);

    if (o.chunk) {
      mesh.userData.chunkX = o.chunk.x;
      mesh.userData.chunkZ = o.chunk.z;
      chunkedMeshes.push(mesh);
    }
    if (o.densityKey) scaledMeshes.push(mesh);
    if (tier !== 'none') shadowMeshes.push(mesh);
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Trees
  // -------------------------------------------------------------------------

  const trunkShadow = !!preset.shadows;
  const foliageShadow = !!preset.foliageShadows;
  const receiveStatic = !!preset.shadows;

  /**
   * Trunks cast from "medium" up, foliage only from "high" up - but a variant
   * is a single merged mesh, and r186 picks its shadow material per object, not
   * per group. The depth material below therefore discards every vertex whose
   * aVegPart flag says "foliage" (group 1), so the trunk still casts a shadow
   * while the canopy stays out of the shadow map (and out of the shadow pass
   * cost) on low/medium presets.
   */
  const trunkOnlyDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  trunkOnlyDepth.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aVegPart;\nvarying float vVegPart;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVegPart = aVegPart;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vVegPart;')
      .replace('void main() {', 'void main() {\n\tif (vVegPart > 0.5) discard;');
  };
  trunkOnlyDepth.customProgramCacheKey = () => 'vegTrunkOnlyDepth';

  async function placeTrees(def, target, sample, clearOpts, extraFilter) {
    const treeDensity = densityOf('treeDensity');
    const wanted = Math.round(target * treeDensity);
    const placed = [];
    const maxTries = Math.max(80, wanted * 16);
    let tries = 0;

    while (placed.length < wanted && tries < maxTries) {
      await slice();
      tries++;
      const c = sample(rng);
      if (!c) continue;
      const x = c.x, z = c.z;
      if (Math.abs(x) > HALF - 90 || Math.abs(z) > HALF - 90) continue;
      if (fastHeight(x, z) < 1.2) continue;
      if (!layout.isClear(x, z, clearOpts)) continue;
      if (extraFilter && !extraFilter(x, z)) continue;
      if (!treeSpacingOk(x, z)) continue;
      treeSpacingAdd(x, z);

      const variant = def.baked[rng.irange(0, def.baked.length - 1)];
      const scale = rng.range(def.scale[0], def.scale[1]);
      const h = layout.heightAt(x, z);
      const slope = layout.slopeAt(x, z);
      const sink = Math.min(0.35, 0.06 + 0.9 * variant.trunkRadius * slope);
      const tint = greenTint(rng);
      placed.push({
        x, y: h - sink, z,
        ry: rng.float() * TAU,
        rx: rng.range(-0.03, 0.03),
        rz: rng.range(-0.03, 0.03),
        s: scale,
        tint,
        variant: def.baked.indexOf(variant),
        trunkRadius: variant.trunkRadius * scale,
      });

      if (treeColliders.length < COLLIDER_CAP &&
        variant.trunkRadius * scale > COLLIDER_MIN_RADIUS &&
        layout.roadDistance(x, z) < COLLIDER_ROAD_RANGE) {
        treeColliders.push({ x, z, r: variant.trunkRadius * scale * 0.9 });
      }
    }

    // Split into one InstancedMesh per variant.
    for (let v = 0; v < def.baked.length; v++) {
      const variant = def.baked[v];
      for (let tier = 0; tier < 2; tier++) {
        const list = placed.filter((p) => p.variant === v && (layout.roadDistance(p.x, p.z) < 95 ? 1 : 0) === tier);
        if (!list.length) continue;
        makeInstanced(
          `tree:${def.id}:${v}:${tier}`,
          variant.geometry,
          variant.materials,
          list,
          {
            kind: 'tree', species: def.id, variant: v, tint: true,
            height: variant.height, trunkRadius: variant.trunkRadius,
            densityKey: 'treeDensity',
            shadowTier: tier ? 'trunkFoliage' : 'none', receiveShadow: receiveStatic,
          }
        );
      }
    }
    stats.trees += placed.length;
    return placed;
  }

  // --- candidate samplers ---------------------------------------------------

  const _curvePt = new THREE.Vector3();
  const _curveTan = new THREE.Vector3();

  function sampleForest(r, poi, inner) {
    const a = r.float() * TAU;
    // Stable groves overlap into crowns, with glades between them.
    const grove = r.irange(0, 95);
    const ga = grove * 2.3999632297;
    const gr = poi.radius * inner * Math.sqrt((grove + 0.5) / 96);
    const rr = 52 * Math.sqrt(r.float());
    return { x: poi.position.x + Math.cos(ga) * gr + Math.cos(a) * rr,
      z: poi.position.z + Math.sin(ga) * gr + Math.sin(a) * rr };
  }

  function sampleForestRing(r, poi, lo, hi) {
    const a = r.float() * TAU;
    const rr = poi.radius * r.range(lo, hi);
    return { x: poi.position.x + Math.cos(a) * rr, z: poi.position.z + Math.sin(a) * rr };
  }

  // layout.shoreDistance() is negative on land, positive out at sea, so
  // `inward` metres of land and `outward` metres of water straddle the line.
  function sampleShore(r, inward, outward) {
    const a = r.float() * TAU;
    const rr = layout.coastRadius(a) + r.range(-outward, inward);
    return { x: Math.cos(a) * rr, z: Math.sin(a) * rr };
  }

  function sampleRiverSide(r, lo, hi) {
    const t = r.float();
    layout.riverCurve.getPointAt(t, _curvePt);
    layout.riverCurve.getTangentAt(t, _curveTan);
    const s = r.sign() * r.range(lo, hi);
    return { x: _curvePt.x - _curveTan.z * s, z: _curvePt.z + _curveTan.x * s };
  }

  function sampleRoadSide(r, lo, hi) {
    layout.roadPoint(r.float(), _roadPt);
    const s = r.sign() * r.range(lo, hi);
    return { x: _roadPt.x - _roadPt.dirZ * s, z: _roadPt.z + _roadPt.dirX * s };
  }

  function sampleRing(r, poi, lo, hi) {
    const a = r.float() * TAU;
    const rr = r.range(lo, hi);
    return { x: poi.position.x + Math.cos(a) * rr, z: poi.position.z + Math.sin(a) * rr };
  }

  function sampleLakeShore(r) {
    const a = r.float() * TAU;
    const rr = LAKE.radius * r.range(1.06, 1.3);
    return { x: LAKE.center.x + Math.cos(a) * rr, z: LAKE.center.z + Math.sin(a) * rr };
  }

  function sampleIsland(r, extent) {
    const a = r.float() * TAU;
    const rr = extent * Math.sqrt(r.float());
    return { x: Math.cos(a) * rr, z: Math.sin(a) * rr };
  }

  const biomeIs = (x, z, list) => list.indexOf(layout.biomeAt(x, z)) >= 0;

  const treeById = {};
  for (const def of TREE_DEFS) treeById[def.id] = def;

  function treeClear(extra) {
    return Object.assign({ road: 9, poi: 1, river: 6, minHeight: 2, maxSlope: 0.5 }, extra || {});
  }

  // pine: the whole north-east pinewood, happy on slopes
  await placeTrees(treeById.pine, 3800, (r) => sampleForest(r, layout.pois.pineForest, 0.95),
    treeClear({ maxSlope: 0.62 }),
    (x, z) => biomeIs(x, z, ['forest', 'meadow', 'rock', 'snow']));

  // oak: broadleaf woodland, gently sloping ground
  await placeTrees(treeById.oak, 3600, (r) => sampleForest(r, layout.pois.forest, 0.9),
    treeClear({ maxSlope: 0.48 }),
    (x, z) => biomeIs(x, z, ['forest', 'meadow']));

  // birch: the sunny rim of both forests
  await placeTrees(treeById.birch, 700,
    (r) => sampleForestRing(r, r.chance(0.5) ? layout.pois.forest : layout.pois.pineForest, 0.82, 1.22),
    treeClear({ maxSlope: 0.45 }),
    (x, z) => biomeIs(x, z, ['forest', 'meadow']));

  // palm: beaches, h < 12 m, close to the shore
  await placeTrees(treeById.palm, 190, (r) => sampleShore(r, 10, 90),
    treeClear({ minHeight: 0.7, maxSlope: 0.5 }),
    (x, z) => {
      const h = layout.heightAt(x, z);
      const sd = layout.shoreDistance(x, z);
      return h < 12 && sd < -6 && sd > -150 && biomeIs(x, z, ['beach', 'meadow']);
    });

  // cypress: village lanes, chapel grounds and the ring road verges
  await placeTrees(treeById.cypress, 330, (r) => {
    const k = r.float();
    if (k < 0.62) return sampleRoadSide(r, 9.5, 24);
    if (k < 0.81) return sampleRing(r, layout.pois.village, 60, 210);
    return sampleRing(r, layout.pois.chapel, 46, 130);
  }, treeClear({ maxSlope: 0.45 }),
  (x, z) => biomeIs(x, z, ['meadow', 'beach', 'forest']));

  // willow / eucalyptus: river banks and the lake shore
  await placeTrees(treeById.willow, 380,
    (r) => (r.chance(0.6) ? sampleRiverSide(r, 8, 34) : sampleLakeShore(r)),
    treeClear({ river: 7, minHeight: 1, maxSlope: 0.5 }),
    (x, z) => biomeIs(x, z, ['meadow', 'forest', 'beach']));

  // -------------------------------------------------------------------------
  // Bushes
  // -------------------------------------------------------------------------

  {
    const target = Math.round(2600 * densityOf('treeDensity'));
    const perKind = [[], [], []];
    const maxTries = target * 18;
    let placed = 0;
    for (let tries = 0; tries < maxTries && placed < target; tries++) {
      await slice();
      const c = rng.chance(0.65) ? sampleRoadSide(rng, 7, 60) : rng.chance(0.65)
        ? sampleForestRing(rng, rng.chance(0.5) ? layout.pois.forest : layout.pois.pineForest, 0.72, 1.35)
        : sampleIsland(rng, 2320);
      const x = c.x, z = c.z;
      if (fastHeight(x, z) < 1.4) continue;
      if (!layout.isClear(x, z, { road: 8, poi: 1, river: 6, minHeight: 1.4, maxSlope: 0.55 })) continue;
      if (!biomeIs(x, z, ['meadow', 'forest'])) continue;

      const roll = rng.float();
      const kindIndex = roll < 0.36 ? 0 : roll < 0.72 ? 1 : 2;
      const def = BUSH_DEFS[kindIndex];
      const variantIndex = rng.irange(0, def.baked.length - 1);
      perKind[kindIndex].push({
        x, y: coverHeight(x, z) - 0.1, z,
        ry: rng.float() * TAU,
        rx: rng.range(-0.06, 0.06),
        rz: rng.range(-0.06, 0.06),
        s: rng.range(0.7, 1.5) * (kindIndex === 1 ? 1.1 : 1),
        tint: greenTint(rng, 0.8),
        variant: variantIndex,
      });
      placed++;
    }

    for (let k = 0; k < BUSH_DEFS.length; k++) {
      const def = BUSH_DEFS[k];
      for (let v = 0; v < def.baked.length; v++) {
        const list = perKind[k].filter((p) => p.variant === v);
        if (!list.length) continue;
        const variant = def.baked[v];
        makeInstanced(`bush:${def.id}:${v}`, variant.geometry, variant.materials, list, {
          kind: 'bush', species: def.id, variant: v, tint: true,
          height: variant.height, densityKey: 'treeDensity',
          shadowTier: 'trunk', receiveShadow: receiveStatic,
        });
      }
    }
    stats.bushes = placed;
  }

  // -------------------------------------------------------------------------
  // Rocks: scattered boulders, big accents, stream pebbles
  // -------------------------------------------------------------------------

  __tmark('trees');
  const ROCK_BIOME_WEIGHT = { rock: 1.0, snow: 0.5, beach: 0.3, meadow: 0.22, forest: 0.18 };

  {
    const boulders = [[], [], []];
    const target = Math.round(680 * densityOf('treeDensity'));
    const maxTries = target * 10;
    let placed = 0;
    for (let tries = 0; tries < maxTries && placed < target; tries++) {
      await slice();
      const c = sampleIsland(rng, 2350);
      const x = c.x, z = c.z;
      if (fastHeight(x, z) < 0.8) continue;
      const biome = layout.biomeAt(x, z);
      const weight = ROCK_BIOME_WEIGHT[biome] || 0;
      if (weight <= 0 || rng.float() > weight) continue;
      if (!layout.isClear(x, z, { road: 8, poi: 1, river: 5, minHeight: 0.8, maxSlope: 1.2 })) continue;

      const variantIndex = rng.irange(0, ROCK_DEFS.length - 1);
      const scale = rng.range(0.45, 1.6);
      boulders[variantIndex].push({
        // Partial burial scaled with the rock, so small and large boulders both
        // read as half-sunk stones instead of disappearing into the ground.
        x, y: coverHeight(x, z) - 0.45 * scale, z,
        ry: rng.float() * TAU,
        rx: rng.range(-0.4, 0.4),
        rz: rng.range(-0.4, 0.4),
        s: scale,
        tint: greyTint(rng),
      });
      placed++;
    }

    // big boulders as accents on rocky/high ground
    const accents = [[], [], []];
    const accentTarget = Math.round(46 * densityOf('treeDensity'));
    const maxAccentTries = accentTarget * 30;
    let accentPlaced = 0;
    for (let tries = 0; tries < maxAccentTries && accentPlaced < accentTarget; tries++) {
      await slice();
      const c = sampleIsland(rng, 2300);
      const x = c.x, z = c.z;
      if (fastHeight(x, z) < 2) continue;
      const h = layout.heightAt(x, z);
      const slope = layout.slopeAt(x, z);
      if (h < 6 || slope < 0.16) continue;
      if (!layout.isClear(x, z, { road: 10, poi: 1, river: 6, minHeight: 2, maxSlope: 1.4 })) continue;
      const variantIndex = rng.irange(0, ROCK_DEFS.length - 1);
      accents[variantIndex].push({
        x, y: h - 1.4, z,
        ry: rng.float() * TAU,
        rx: rng.range(-0.2, 0.2),
        rz: rng.range(-0.2, 0.2),
        s: rng.range(1.7, 3.4),
        tint: greyTint(rng, 0.7),
      });
      accentPlaced++;
    }

    for (let v = 0; v < ROCK_DEFS.length; v++) {
      if (boulders[v].length) {
        makeInstanced(`rock:${v}`, ROCK_DEFS[v], matRock, boulders[v], {
          kind: 'rock', densityKey: 'treeDensity', tint: true,
          shadowTier: 'trunk', receiveShadow: receiveStatic,
        });
      }
      if (accents[v].length) {
        makeInstanced(`rockBig:${v}`, ROCK_DEFS[v], matRock, accents[v], {
          kind: 'rockBig', densityKey: 'treeDensity', tint: true,
          shadowTier: 'trunk', receiveShadow: receiveStatic,
        });
      }
    }
    stats.rocks = placed + accentPlaced;
  }

  {
    // pebble patches along the stream bed
    const pebbles = [[], []];
    const patches = Math.round(96 * densityOf('treeDensity'));
    for (let p = 0; p < patches; p++) {
      await slice();
      const c = sampleRiverSide(rng, 4, 20);
      const count = rng.irange(12, 34);
      for (let i = 0; i < count; i++) {
        const x = c.x + rng.range(-4.5, 4.5);
        const z = c.z + rng.range(-4.5, 4.5);
        if (fastHeight(x, z) < 0.4) continue;
        if (layout.roadDistance(x, z) < 7) continue;
        if (layout.riverDistance(x, z) > 30) continue;
        if (layout.waterDepth(x, z) > 0.3) continue;
        if (layout.slopeAt(x, z) > 0.85) continue;
        const variantIndex = rng.irange(0, PEBBLE_DEFS.length - 1);
        pebbles[variantIndex].push({
          x, y: coverHeight(x, z) - 0.05, z,
          ry: rng.float() * TAU,
          rx: rng.range(-0.5, 0.5),
          rz: rng.range(-0.5, 0.5),
          s: rng.range(0.5, 1.6),
          tint: greyTint(rng, 0.9),
        });
        stats.rocks++;
      }
    }
    for (let v = 0; v < PEBBLE_DEFS.length; v++) {
      if (!pebbles[v].length) continue;
      makeInstanced(`pebble:${v}`, PEBBLE_DEFS[v], matPebble, pebbles[v], {
        kind: 'pebble', densityKey: 'treeDensity', tint: true, receiveShadow: receiveStatic,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Grass tufts - 12 x 12 chunks of 500 m, weighted by biome
  // -------------------------------------------------------------------------

  built.treeDensity = densityOf('treeDensity');
  built.grassDensity = densityOf('grassDensity');
  built.flowerDensity = densityOf('flowerDensity');

  {
    // Reuse island chunks: the dense road corridor adds no grass draw calls.
    const corridor = Array.from({ length: CHUNK_GRID * CHUNK_GRID }, () => []);
    const roadAttempts = Math.round(layout.roadLength * 120 * 0.32 * built.grassDensity);
    for (let i = 0; i < roadAttempts; i++) {
      await slice();
      // Inlined sampleRoadSide(): the lateral distance is needed anyway, and
      // every layout.* query per attempt was the hot spot of the whole boot.
      layout.roadPoint(rng.float(), _roadPt);
      const spread = rng.sign() * rng.range(5.5, 63);
      const x = _roadPt.x - _roadPt.dirZ * spread;
      const z = _roadPt.z + _roadPt.dirX * spread;
      // Reachability guard: 4.75 m = ROAD_WIDTH/2 + 1.5, same as onRoad(x, z, 1.5).
      if (Math.abs(spread) < 4.75) continue;
      const ci = Math.floor((x + HALF) / CHUNK_SIZE);
      const cj = Math.floor((z + HALF) / CHUNK_SIZE);
      if (ci < 0 || ci >= CHUNK_GRID || cj < 0 || cj >= CHUNK_GRID) continue;
      const list = corridor[cj * CHUNK_GRID + ci];
      const biome = biomeNear(x, z);
      if (!GRASS_BIOME_WEIGHT[biome]) continue;
      const flags = exclBits(x, z);
      const h = coverHeight(x, z);
      if ((flags & 1) && layout.onRoad(x, z, 1.5)) continue;
      if ((flags & 2) && layout.riverDistance(x, z) < 9) continue;
      if ((flags & 4) && layout.waterDepth(x, z) > 0.1) continue;
      const dry = biome === 'beach' || biome === 'rock';
      list.push({ x, y: h - 0.04, z, ry: rng.float() * TAU,
        sx: rng.range(1.2, 2.2), sy: rng.range(dry ? 0.3 : 0.65, dry ? 0.65 : 1.35),
        sz: rng.range(1.2, 2.2), tint: greenTint(rng, 0.8) });
    }
    for (let cj = 0; cj < CHUNK_GRID; cj++) {
      await slice();
      for (let ci = 0; ci < CHUNK_GRID; ci++) {
        const x0 = -HALF + ci * CHUNK_SIZE;
        const z0 = -HALF + cj * CHUNK_SIZE;
        const landFrac = chunkLandFraction(x0, z0);
        if (landFrac <= 0.02) continue;

        const attempts = Math.round(
          CHUNK_SIZE * CHUNK_SIZE * GRASS_ATTEMPT_DENSITY * built.grassDensity * Math.min(1, landFrac * 1.25)
        );
        const list = [];
        for (let i = 0; i < attempts; i++) {
          const x = x0 + rng.float() * CHUNK_SIZE;
          const z = z0 + rng.float() * CHUNK_SIZE;
          if (fastHeight(x, z) < 1.2) continue;
          const weight = GRASS_BIOME_WEIGHT[biomeNear(x, z)];
          if (!weight || rng.float() >= weight) continue;
          const h = coverHeight(x, z);
          const dl = Math.hypot(x - LAKE.center.x, z - LAKE.center.z);
          const surface = dl < LAKE.radius * 1.25 ? LAKE_Y : 0;
          if (h < surface + 0.4) continue;
          // Near a road, a gorge or a shoreline the coarse grids are not
          // trusted: the categorical rule runs exactly, as the tests check it.
          if (exclBits(x, z) && !GRASS_BIOME_WEIGHT[layout.biomeAt(x, z)]) continue;
          list.push({
            x, y: h - 0.04, z,
            ry: rng.float() * TAU,
            sx: rng.range(1.1, 2.0), sy: rng.range(0.6, 1.2), sz: rng.range(1.1, 2.0),
            tint: greenTint(rng, 1.2),
          });
        }
        list.push(...corridor[cj * CHUNK_GRID + ci]);
        if (!list.length) continue;
        makeInstanced(`grass:${ci}:${cj}`, GEO_GRASS, matGrass, list, {
          kind: 'grass', densityKey: 'grassDensity', tint: true,
          chunk: { x: x0 + CHUNK_SIZE / 2, z: z0 + CHUNK_SIZE / 2 },
        });
        stats.grass += list.length;
        stats.grassChunks++;
      }
    }
  }

  __tmark('grass');
  // -------------------------------------------------------------------------
  // Flowers - patch based, same chunking, meadow + forest edge, denser at POIs
  // -------------------------------------------------------------------------

  {
    const cumulative = [];
    let acc = 0;
    for (const kind of FLOWER_KINDS) {
      acc += kind.weight;
      cumulative.push(acc);
    }
    const pickKind = (roll) => {
      const v = roll * acc;
      for (let i = 0; i < cumulative.length; i++) if (v <= cumulative[i]) return i;
      return cumulative.length - 1;
    };

    // Flowers merge a FLOWER_MERGE x FLOWER_MERGE block of 500 m chunks into
    // one mesh: measured at the village camera, the per-chunk meshes cost ~200
    // draw calls for ~0.16 M triangles, which is pure overhead.
    const FLOWER_MERGE = 4;
    const buckets = new Map();
    for (let cj = 0; cj < CHUNK_GRID; cj++) {
      await slice();
      for (let ci = 0; ci < CHUNK_GRID; ci++) {
        const x0 = -HALF + ci * CHUNK_SIZE;
        const z0 = -HALF + cj * CHUNK_SIZE;
        const landFrac = chunkLandFraction(x0, z0);
        if (landFrac <= 0.05) continue;

        const patches = Math.round(
          CHUNK_SIZE * CHUNK_SIZE * FLOWER_PATCH_DENSITY * built.flowerDensity * landFrac
        );
        let done = 0;
        for (let attempt = 0; attempt < patches * 8 && done < patches; attempt++) {
          const cx = x0 + rng.float() * CHUNK_SIZE;
          const cz = z0 + rng.float() * CHUNK_SIZE;
          let weight = FLOWER_BIOME_WEIGHT[layout.biomeAt(cx, cz)] || 0;
          if (!weight) continue;
          if (layout.roadDistance(cx, cz) < 8 || layout.riverDistance(cx, cz) < 6) continue;
          weight *= 1 + 1.6 * poiBoost(cx, cz) + 1.1 * forestEdgeBoost(cx, cz);
          if (rng.float() > Math.min(1, weight)) continue;
          done++;

          const kindIndex = pickKind(rng.float());
          const kind = FLOWER_KINDS[kindIndex];
          const key = `${Math.floor(ci / FLOWER_MERGE)}:${Math.floor(cj / FLOWER_MERGE)}:${kindIndex}`;
          let list = buckets.get(key);
          if (!list) {
            list = [];
            buckets.set(key, list);
          }

          const count = rng.irange(6, 24);
          const patchRadius = rng.range(2.5, 7);
          for (let i = 0; i < count; i++) {
            const a = rng.float() * TAU;
            const rr = patchRadius * Math.sqrt(rng.float());
            const x = cx + Math.cos(a) * rr;
            const z = cz + Math.sin(a) * rr;
            if (fastHeight(x, z) < 1.0) continue;
            if (layout.onRoad(x, z, 1.2)) continue;
            if (layout.waterDepth(x, z) > 0.1) continue;
            if (layout.riverDistance(x, z) < 5.5) continue;
            list.push({
              x, y: coverHeight(x, z) - 0.03, z,
              ry: rng.float() * TAU,
              sx: rng.range(0.8, 1.2), sy: rng.range(0.75, 1.3), sz: rng.range(0.8, 1.2),
              s: kind.height,
              tint: [1 + (rng.float() - 0.5) * 0.1, 1 + (rng.float() - 0.5) * 0.1, 1 + (rng.float() - 0.5) * 0.1],
            });
          }
        }
      }
    }

    for (let patch = 0; patch < 2400 * built.flowerDensity; patch++) {
      await slice();
      const c = sampleRoadSide(rng, 7, 55);
      if (!FLOWER_BIOME_WEIGHT[layout.biomeAt(c.x, c.z)]) continue;
      const kindIndex = pickKind(rng.float());
      for (let i = 0; i < 14; i++) {
        const x = c.x + rng.range(-3, 3), z = c.z + rng.range(-3, 3);
        if (layout.onRoad(x, z, 1.5) || layout.waterDepth(x, z) > 0.1 || layout.riverDistance(x, z) < 6) continue;
        const ci = Math.floor((x + HALF) / CHUNK_SIZE), cj = Math.floor((z + HALF) / CHUNK_SIZE);
        if (ci < 0 || ci >= CHUNK_GRID || cj < 0 || cj >= CHUNK_GRID) continue;
        const key = `${Math.floor(ci / FLOWER_MERGE)}:${Math.floor(cj / FLOWER_MERGE)}:${kindIndex}`;
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        const h = FLOWER_KINDS[kindIndex].height;
        list.push({ x, y: coverHeight(x, z) - 0.03, z, ry: rng.float() * TAU,
          sx: h * rng.range(0.8, 1.4), sy: h * rng.range(0.8, 1.4), sz: h,
          tint: greenTint(rng, 0.2) });
      }
    }

    for (const [key, list] of buckets) {
      if (!list.length) continue;
      const parts = key.split(':');
      const kind = FLOWER_KINDS[Number(parts[2])];
      makeInstanced(`flower:${kind.id}:${parts[0]}:${parts[1]}`, GEO_FLOWER, matFlower[kind.id], list, {
        kind: 'flower', species: kind.id, densityKey: 'flowerDensity', tint: true,
        chunk: {
          x: -HALF + (Number(parts[0]) + 0.5) * CHUNK_SIZE * FLOWER_MERGE,
          z: -HALF + (Number(parts[1]) + 0.5) * CHUNK_SIZE * FLOWER_MERGE,
        },
      });
      stats.flowers += list.length;
      stats.flowerChunks++;
    }
  }

  __tmark('flowers');
  // -------------------------------------------------------------------------
  // Reeds / cattails (river + lake shore), water lilies, beach debris
  // -------------------------------------------------------------------------

  {
    const target = Math.round(4200 * built.treeDensity);
    const reeds = [];
    const cattails = [];
    const maxTries = target * 10;
    let placed = 0;
    for (let tries = 0; tries < maxTries && placed < target; tries++) {
      await slice();
      let x, z;
      if (rng.chance(0.68)) {
        const c = sampleRiverSide(rng, 6, 15);
        x = c.x; z = c.z;
      } else {
        const a = rng.float() * TAU;
        const rr = LAKE.radius * rng.range(0.97, 1.1);
        x = LAKE.center.x + Math.cos(a) * rr;
        z = LAKE.center.z + Math.sin(a) * rr;
      }
      const h = layout.heightAt(x, z);
      if (h < 0.4) continue;
      if (layout.waterDepth(x, z) > 2.2) continue;
      if (layout.roadDistance(x, z) < 6) continue;
      if (layout.slopeAt(x, z) > 0.6) continue;

      const entry = {
        x, y: h - 0.06, z,
        ry: rng.float() * TAU,
        rz: rng.range(-0.08, 0.08),
        s: rng.range(0.8, 1.7),
        tint: greenTint(rng, 0.9),
      };
      if (rng.chance(0.26)) cattails.push(entry);
      else reeds.push(entry);
      placed++;
    }
    if (reeds.length) {
      makeInstanced('reeds', GEO_REED, matReed, reeds, {
        kind: 'reed', densityKey: 'treeDensity', tint: true, receiveShadow: receiveStatic,
      });
    }
    if (cattails.length) {
      makeInstanced('cattails', GEO_CATTAIL, [matReed, matCattail], cattails, {
        kind: 'cattail', densityKey: 'treeDensity', tint: true, receiveShadow: receiveStatic,
      });
    }
    stats.reeds = reeds.length + cattails.length;
  }

  {
    const pads = [];
    const blooms = [];
    const islet = layout.pois.lakeIsland.position;
    const target = Math.round(340 * built.treeDensity);
    const maxTries = target * 12;
    for (let tries = 0; tries < maxTries && pads.length < target; tries++) {
      await slice();
      const a = rng.float() * TAU;
      const rr = LAKE.radius * Math.sqrt(rng.float()) * 0.9;
      const x = LAKE.center.x + Math.cos(a) * rr;
      const z = LAKE.center.z + Math.sin(a) * rr;
      if (Math.hypot(x - islet.x, z - islet.z) < 55) continue;
      if (LAKE_Y - layout.heightAt(x, z) < 0.7) continue;
      const pad = {
        x, y: LAKE_Y + 0.06, z,
        ry: rng.float() * TAU,
        s: rng.range(0.55, 1.35),
        tint: greenTint(rng, 0.7),
      };
      pads.push(pad);
      if (rng.chance(0.22)) {
        blooms.push({
          x: pad.x + rng.range(-0.25, 0.25), y: LAKE_Y + 0.18, z: pad.z + rng.range(-0.25, 0.25),
          ry: rng.float() * TAU,
          s: rng.range(0.7, 1.3),
          tint: [1, 1, 1],
        });
      }
    }
    if (pads.length) {
      makeInstanced('lilies', GEO_LILY, matLilyPad, pads, { kind: 'lily', tint: true });
    }
    if (blooms.length) {
      makeInstanced('lotus', GEO_LOTUS, matLotus, blooms, { kind: 'lily', tint: false });
    }
    stats.lilies = pads.length + blooms.length;
  }

  {
    const seaweed = [];
    const driftwood = [];
    const shells = [];

    const weedTarget = Math.round(780 * built.treeDensity);
    const weedTries = weedTarget * 26;
    for (let tries = 0; tries < weedTries && seaweed.length < weedTarget; tries++) {
      await slice();
      const c = sampleShore(rng, 8, 60);
      const x = c.x, z = c.z;
      const h = layout.heightAt(x, z);
      if (h < 0.25 || h > 4.5) continue;
      if (!biomeIs(x, z, ['beach', 'meadow'])) continue;
      if (!layout.isClear(x, z, { road: 8, poi: 0.8, river: 5, minHeight: 0.25, maxSlope: 0.8 })) continue;
      seaweed.push({
        x, y: h - 0.05, z,
        ry: rng.float() * TAU,
        rz: rng.range(-0.1, 0.1),
        s: rng.range(0.6, 1.5),
        tint: greenTint(rng, 0.8),
      });
    }

    const driftTarget = Math.round(150 * built.treeDensity);
    const driftTries = driftTarget * 24;
    for (let tries = 0; tries < driftTries && driftwood.length < driftTarget; tries++) {
      await slice();
      const c = sampleShore(rng, 6, 55);
      const x = c.x, z = c.z;
      const h = layout.heightAt(x, z);
      if (h < 0.7 || h > 4.5) continue;
      if (!biomeIs(x, z, ['beach'])) continue;
      if (!layout.isClear(x, z, { road: 9, poi: 1, river: 5, minHeight: 0.7, maxSlope: 0.7 })) continue;
      driftwood.push({
        x, y: h - 0.05, z,
        ry: rng.float() * TAU,
        rz: rng.range(-0.12, 0.12),
        s: rng.range(0.7, 1.6) * 0.5,
        tint: [1 + (rng.float() - 0.5) * 0.2, 1 + (rng.float() - 0.5) * 0.2, 1 + (rng.float() - 0.5) * 0.18],
      });
    }

    const shellTarget = Math.round(220 * built.treeDensity);
    const shellTries = shellTarget * 20;
    for (let tries = 0; tries < shellTries && shells.length < shellTarget; tries++) {
      await slice();
      const c = sampleShore(rng, 10, 70);
      const x = c.x, z = c.z;
      const h = layout.heightAt(x, z);
      if (h < 0.4 || h > 5) continue;
      if (!biomeIs(x, z, ['beach'])) continue;
      if (layout.onRoad(x, z, 2)) continue;
      shells.push({
        x, y: h - 0.02, z,
        ry: rng.float() * TAU,
        s: rng.range(0.6, 1.4),
        tint: [1 + (rng.float() - 0.5) * 0.2, 1 + (rng.float() - 0.5) * 0.2, 1 + (rng.float() - 0.5) * 0.2],
      });
    }

    if (seaweed.length) {
      makeInstanced('seaweed', GEO_SEAWEED, matSeaweed, seaweed, {
        kind: 'seaweed', densityKey: 'treeDensity', tint: true,
      });
    }
    if (driftwood.length) {
      makeInstanced('driftwood', GEO_DRIFTWOOD, matDriftwood, driftwood, {
        kind: 'driftwood', densityKey: 'treeDensity', tint: true,
        shadowTier: 'trunk', receiveShadow: receiveStatic,
      });
    }
    if (shells.length) {
      makeInstanced('shells', GEO_SHELL, matShell, shells, {
        kind: 'shell', densityKey: 'treeDensity', tint: true,
      });
    }
    stats.seaweed = seaweed.length;
    stats.driftwood = driftwood.length;
  }

  // -------------------------------------------------------------------------
  // Understory accents share a tiny fixed set of procedural geometries.
  {
    const fernParts = newPartList();
    for (let i = 0; i < 7; i++) {
      const leaf = bladeGeometry(0.28, 0.85, 0.45, 0.04);
      addPart(fernParts, leaf, 0, trs(0, 0, 0, 0, i * TAU / 7, 0.7));
      leaf.dispose();
    }
    const fern = finishPartList(fernParts);
    const fungusParts = newPartList();
    const stem = new THREE.CylinderGeometry(0.035, 0.05, 0.23, 5);
    const cap = new THREE.SphereGeometry(0.18, 7, 3, 0, TAU, 0, HALF_PI);
    addPart(fungusParts, stem, 0, trs(0, 0.115, 0));
    addPart(fungusParts, cap, 0, trs(0, 0.23, 0, 0, 0, 0, 1, 0.55, 1));
    stem.dispose(); cap.dispose();
    const fungus = finishPartList(fungusParts);
    const log = new THREE.CylinderGeometry(0.18, 0.28, 3.8, 6).rotateZ(HALF_PI).translate(0, 0.22, 0);
    const defs = [
      { id: 'fern', geometry: fern, material: matReed, count: 2200 },
      { id: 'mushroom', geometry: fungus, material: matDriftwood, count: 700 },
      { id: 'fallenLog', geometry: log, material: matBark, count: 220 },
      { id: 'pebble', geometry: PEBBLE_DEFS[0], material: matPebble, count: 5200 },
    ];
    for (const def of defs) {
      const list = [];
      const target = Math.round(def.count * built.treeDensity);
      for (let attempt = 0; attempt < target * 12 && list.length < target; attempt++) {
        await slice();
        const c = rng.chance(0.7) ? sampleRoadSide(rng, 7, 60)
          : sampleForest(rng, rng.chance(0.5) ? layout.pois.forest : layout.pois.pineForest, 1);
        const x = c.x, z = c.z;
        if (!layout.isClear(x, z, { road: 6, poi: 1, river: 6, minHeight: 1.2, maxSlope: 0.58 })) continue;
        const biome = layout.biomeAt(x, z);
        const damp = biome === 'forest' || layout.riverDistance(x, z) < 50
          || Math.hypot(x - LAKE.center.x, z - LAKE.center.z) < LAKE.radius * 1.4;
        if (def.id !== 'pebble' && !damp) continue;
        list.push({ x, y: coverHeight(x, z) - 0.03, z, ry: rng.float() * TAU,
          s: rng.range(0.65, 1.4), tint: def.id === 'fern' ? greenTint(rng) : greyTint(rng) });
      }
      if (list.length) makeInstanced(`understory:${def.id}`, def.geometry, def.material, list,
        { kind: def.id, densityKey: 'treeDensity', tint: true, receiveShadow: receiveStatic });
    }
  }

  __tmark('water+understory');
  // Quality, stats and the per-frame update
  // -------------------------------------------------------------------------

  function densityFactor(key) {
    const base = built[key] || 1;
    return densityOf(key) / base;
  }

  function recountStats() {
    let trees = 0, grass = 0, flowers = 0, rocks = 0, bushes = 0;
    let reeds = 0, lilies = 0, seaweed = 0, driftwood = 0, shells = 0;
    let grassChunks = 0, flowerChunks = 0;
    for (const child of group.children) {
      const kind = child.userData.kind;
      const count = child.count;
      if (kind === 'tree') trees += count;
      else if (kind === 'grass') { grass += count; grassChunks++; }
      else if (kind === 'flower') { flowers += count; flowerChunks++; }
      else if (kind === 'bush') bushes += count;
      else if (kind === 'rock' || kind === 'rockBig' || kind === 'pebble') rocks += count;
      else if (kind === 'reed' || kind === 'cattail') reeds += count;
      else if (kind === 'lily') lilies += count;
      else if (kind === 'seaweed') seaweed += count;
      else if (kind === 'shell') shells += count;
      else if (kind === 'driftwood') driftwood += count;
    }
    stats.trees = trees;
    stats.grass = grass;
    stats.flowers = flowers;
    stats.rocks = rocks;
    stats.bushes = bushes;
    stats.reeds = reeds;
    stats.lilies = lilies;
    stats.seaweed = seaweed;
    stats.driftwood = driftwood;
    stats.shells = shells;
    stats.grassChunks = grassChunks;
    stats.flowerChunks = flowerChunks;
    stats.treeColliders = treeColliders.length;
  }

  /**
   * Applies the active preset without rebuilding anything: instance counts are
   * trimmed from the already placed lists, and the shadow tiers are re-applied.
   * Counts can only go down - a mesh never built more instances than the build
   * preset asked for.
   */
  function applyQuality() {
    chunkRange = typeof preset.chunkRange === 'number' ? preset.chunkRange : 1300;
    for (const mesh of scaledMeshes) {
      const base = mesh.userData.baseCount;
      const count = Math.round(base * densityFactor(mesh.userData.densityKey));
      mesh.count = count < 0 ? 0 : count > base ? base : count;
    }

    const solidShadows = !!preset.shadows;
    const leafShadows = !!preset.foliageShadows;
    for (const mesh of shadowMeshes) {
      if (mesh.userData.shadowTier === 'trunkFoliage') {
        mesh.castShadow = solidShadows || leafShadows;
    // NOTE: three r186 treats `customDepthMaterial !== undefined` as "has a
    // custom depth material"; assigning null makes WebGLShadowMap crash on
    // `result.visible = material.visible`. Use undefined to mean "default".
    mesh.customDepthMaterial = leafShadows ? undefined : trunkOnlyDepth;
      } else {
        mesh.castShadow = solidShadows;
      }
    }
    recountStats();
  }

  /** Allocation-free: three uniform writes plus a small wind filter. */
  function update(dt, state) {
    let step = dt;
    if (!(step > 0)) step = 0;
    else if (step > 0.25) step = 0.25;
    elapsed += step;
    sharedUniforms.time.value = elapsed;

    if (state && state.wind) {
      const wind = state.wind;
      const length = Math.sqrt(wind.x * wind.x + wind.z * wind.z);
      const dir = sharedUniforms.windDir.value;
      if (length > 1e-4) {
        dir.x += (wind.x / length - dir.x) * 0.1;
        dir.y += (wind.z / length - dir.y) * 0.1;
        const norm = Math.sqrt(dir.x * dir.x + dir.y * dir.y) || 1;
        dir.x /= norm;
        dir.y /= norm;
      }
      const strength = typeof wind.strength === 'number' ? wind.strength : 0.4;
      const gust = typeof wind.gust === 'number' ? wind.gust : 0;
      sharedUniforms.windStrength.value = 0.3 + strength * 1.1 + gust * 1.2;
    }

    // Ground-cover LOD: skip chunks outside the preset draw distance. Frustum
    // culling still runs per chunk on top of this, so the pass is two compares
    // per chunk mesh and no allocation.
    const cam = state && state.camera && state.camera.position;
    if (cam) {
      const range2 = chunkRange * chunkRange;
      for (let i = 0; i < chunkedMeshes.length; i++) {
        const mesh = chunkedMeshes[i];
        const dx = mesh.userData.chunkX - cam.x;
        const dz = mesh.userData.chunkZ - cam.z;
        mesh.visible = dx * dx + dz * dz < range2;
      }
    }
  }

  function setQuality(level) {
    const next = QUALITY_PRESETS[level];
    if (next) Object.assign(preset, next);
    applyQuality();
  }

  /**
   * Override the ground-cover draw distance in metres (Infinity = no distance
   * culling). Tooling use: the perf probes A/B the LOD with it. A later
   * quality change resets it to the preset value.
   */
  function setChunkRange(metres) {
    const value = Number(metres);
    chunkRange = Number.isFinite(value) && value > 0 ? value : Infinity;
  }

  if (bus && typeof bus.on === 'function') {
    bus.on('quality:changed', (payload) => setQuality((payload && payload.level) || qualityLevel));
  }

  applyQuality();
  stats.variants = TREE_DEFS.reduce((n, d) => n + d.baked.length, 0) +
    BUSH_DEFS.reduce((n, d) => n + d.baked.length, 0) +
    ROCK_DEFS.length + PEBBLE_DEFS.length;

  return { group, update, setQuality, setChunkRange, treeColliders, stats, sharedUniforms };
}
