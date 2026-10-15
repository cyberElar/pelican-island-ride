/**
 * terrain.js - the island mesh (4-way splat), the ring-road ribbon with
 * markings, the gravel spur paths, and the shared height DataTexture used by
 * ocean foam + the minimap.
 */

import * as THREE from 'three';
import { clamp01, lerp } from '../core/utils.js';

export function createTerrain(ctx) {
  const { layout, textures: TEX, engine } = ctx;
  const preset = engine?.preset || { terrainSegments: 400, heightTextureSize: 768, treeDensity: 1 };
  const group = new THREE.Group();
  group.name = 'terrain';

  const worldSize = layout.WORLD_SIZE;
  const half = layout.HALF;

  // Detail texture scale (world meters per texture tile)
  const TILE = { grass: 6.4, sand: 7.5, rock: 8.5, snow: 9.5, dirt: 5.0 };

  const tex = {
    grass: TEX.grass(), sand: TEX.sand(), rock: TEX.rock(), snow: TEX.snow(), dirt: TEX.dirt(),
    dryGrass: TEX.dryGrass(),
  };
  // Average albedo of each detail texture: kept in sync with core/textures.js.
  const AVG = {
    grass: new THREE.Color('#6f9b4c'), sand: new THREE.Color('#ddcaa0'),
    rock: new THREE.Color('#84888f'), snow: new THREE.Color('#e9eef7'), dirt: new THREE.Color('#7c6246'),
  };

  // ---------------------------------------------------------------------------
  // Terrain heightfield
  // ---------------------------------------------------------------------------

  const segments = Math.max(64, preset.terrainSegments | 0);
  const verts = (segments + 1) * (segments + 1);
  const positions = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const splat = new Float32Array(verts * 4);
  const splat2 = new Float32Array(verts * 2);
  const jitter = new Float32Array(verts * 2);

  const step = worldSize / segments;
  const w = { grass: 1, sand: 0, rock: 0, snow: 0, dirt: 0 };
  const tmpColor = new THREE.Color();

  for (let j = 0; j <= segments; j++) {
    const z = -half + j * step;
    for (let i = 0; i <= segments; i++) {
      const x = -half + i * step;
      const vi = j * (segments + 1) + i;
      const h = layout.heightAt(x, z);
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = h;
      positions[vi * 3 + 2] = z;

      layout.splatAt(x, z, w);
      // fold dirt into the rock channel for the shader (4 channels) and keep
      // the raw dirt weight in splat2.x for micro-variation
      const rock = clamp01(w.rock + w.dirt * 0.55);
      splat[vi * 4] = w.grass;
      splat[vi * 4 + 1] = w.sand;
      splat[vi * 4 + 2] = rock;
      splat[vi * 4 + 3] = w.snow;
      splat2[vi * 2] = w.dirt;
      splat2[vi * 2 + 1] = w.grass * 0.5 + w.rock * 0.5; // macro tint factor
      // Per-vertex UV jitter breaks up the obvious tiling of the detail maps.
      const jh = ((i * 73856093) ^ (j * 19349663)) >>> 0;
      jitter[vi * 2] = ((jh & 255) / 255 - 0.5) * 3.2;
      jitter[vi * 2 + 1] = (((jh >> 8) & 255) / 255 - 0.5) * 3.2;

      // Base color = weighted average of the detail textures (used as the
      // far-distance color when detail fades out).
      tmpColor.setRGB(0, 0, 0);
      tmpColor.r = AVG.grass.r * w.grass + AVG.sand.r * w.sand + AVG.rock.r * rock + AVG.snow.r * w.snow + AVG.dirt.r * w.dirt * 0.55;
      tmpColor.g = AVG.grass.g * w.grass + AVG.sand.g * w.sand + AVG.rock.g * rock + AVG.snow.g * w.snow + AVG.dirt.g * w.dirt * 0.55;
      tmpColor.b = AVG.grass.b * w.grass + AVG.sand.b * w.sand + AVG.rock.b * rock + AVG.snow.b * w.snow + AVG.dirt.b * w.dirt * 0.55;
      const norm = w.grass + w.sand + rock + w.snow + w.dirt * 0.55 || 1;
      tmpColor.multiplyScalar(1 / norm);
      // subtle macro brightness variation
      const macro = 0.92 + 0.16 * splat2[vi * 2 + 1];
      tmpColor.multiplyScalar(macro);
      colors[vi * 3] = tmpColor.r;
      colors[vi * 3 + 1] = tmpColor.g;
      colors[vi * 3 + 2] = tmpColor.b;
    }
  }

  // index buffer
  const indices = new Uint32Array(segments * segments * 6);
  let ii = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i;
      const b = a + 1;
      const c = a + (segments + 1);
      const d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
  geo.setAttribute('aSplat2', new THREE.BufferAttribute(splat2, 2));
  geo.setAttribute('aJit', new THREE.BufferAttribute(jitter, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const uniforms = {
    texGrass: { value: tex.grass.map },
    texSand: { value: tex.sand.map },
    texRock: { value: tex.rock.map },
    texSnow: { value: tex.snow.map },
    texDirt: { value: tex.dirt.map },
    texDetailNormal: { value: tex.grass.normalMap },
    texMacro: { value: tex.dryGrass.map },
    uTile: { value: new THREE.Vector4(TILE.grass, TILE.sand, TILE.rock, TILE.snow) },
    uDetailFade: { value: new THREE.Vector2(150, 400) },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
    dithering: true,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aSplat;
        attribute vec2 aSplat2;
        attribute vec2 aJit;
        varying vec4 vSplat;
        varying vec2 vSplat2;
        varying vec2 vJit;
        varying vec3 vTerrainW;
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSplat = aSplat;
        vSplat2 = aSplat2;
        vJit = aJit;
        vTerrainW = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vSplat;
        varying vec2 vSplat2;
        varying vec2 vJit;
        varying vec3 vTerrainW;
        uniform sampler2D texGrass;
        uniform sampler2D texSand;
        uniform sampler2D texRock;
        uniform sampler2D texSnow;
        uniform sampler2D texDirt;
        uniform sampler2D texDetailNormal;
        uniform sampler2D texMacro;
        uniform vec4 uTile;
        uniform vec2 uDetailFade;
      `)
      .replace('#include <map_fragment>', `
        vec2 wxz = vTerrainW.xz + vJit;
        vec3 cG = texture2D(texGrass, wxz / uTile.x).rgb;
        vec3 cS = texture2D(texSand,  wxz / uTile.y).rgb;
        vec3 cR = texture2D(texRock,  wxz / uTile.z).rgb;
        vec3 cN = texture2D(texSnow,  wxz / uTile.w).rgb;
        vec3 cD = texture2D(texDirt,  wxz / 5.0).rgb;
        float wSum = vSplat.x + vSplat.y + vSplat.z + vSplat.w + 0.0001;
        vec3 blended = (cG * vSplat.x + cS * vSplat.y + cR * vSplat.z + cN * vSplat.w + cD * vSplat2.x * 0.6) / wSum;
        // macro layer: kills the repetition and paints dry patches
        vec3 macro = texture2D(texMacro, vTerrainW.xz / 26.0).rgb;
        float macroL = dot(macro, vec3(0.333));
        blended *= 0.86 + macroL * 0.34;
        float dry = smoothstep(0.52, 0.78, macro.g + (vSplat2.y - 0.5) * 0.25);
        blended = mix(blended, blended * vec3(1.16, 1.04, 0.72), dry * 0.45 * vSplat.x);
        // distance fade to vertex colour (kills shimmer at range)
        float dCam = distance(vTerrainW, cameraPosition);
        float fade = 1.0 - smoothstep(uDetailFade.x, uDetailFade.y, dCam);
        diffuseColor.rgb *= mix(vec3(1.0), blended * 1.55, fade);
      `)
      .replace('#include <normal_fragment_maps>', `
        {
          float dCam2 = distance(vTerrainW, cameraPosition);
          float nfade = 1.0 - smoothstep(uDetailFade.x * 0.6, uDetailFade.y * 0.7, dCam2);
          vec3 dn = texture2D(texDetailNormal, (vTerrainW.xz + vJit) / 2.2).xyz * 2.0 - 1.0;
          normal = normalize(normal + vec3(dn.x, 0.0, dn.y) * 0.55 * nfade * vSplat.x);
        }
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        roughnessFactor = mix(0.94, 0.78 + 0.16 * vSplat.z, diffuseColor.b * 0.25 + 0.1);
      `);
  };

  const terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.name = 'terrainMesh';
  terrainMesh.castShadow = false;
  terrainMesh.receiveShadow = true;
  terrainMesh.frustumCulled = false;
  group.add(terrainMesh);

  // ---------------------------------------------------------------------------
  // Ring road ribbon (+ markings) and spur trails
  // ---------------------------------------------------------------------------

  const roadMat = (() => {
    // markings are baked into this texture: one tile = 9 m along the road
    const a = TEX.roadSurface();
    const m = new THREE.MeshStandardMaterial({
      map: a.map, normalMap: a.normalMap, roughnessMap: a.roughnessMap,
      roughness: 0.92, metalness: 0.0, color: 0xffffff,
      // the ribbon is a thin shell; double-sided keeps it visible from every
      // camera angle regardless of the winding of the generated strip
      side: THREE.DoubleSide,
    });
    const repeatU = 1 / (9 * 0.16); // ribbon UVs are dist*0.16, tile = 9 m
    for (const t of [m.map, m.normalMap, m.roughnessMap]) {
      if (!t) continue;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeatU, 1);
    }
    m.userData.isRoad = true;
    return m;
  })();
  const skirtMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0, side: THREE.DoubleSide });

  /** Build a ribbon mesh along a polyline. cross: [{off, y, u}] */
  function buildRibbon(points /* Float32Array x,z[,y] stride 3 */, opts) {
    const { cross, lift = 0.07, closed = true, colorize = null } = opts;
    const n = points.length / 3;
    const cols = cross.length;
    const vCount = n * cols + (closed ? cols : 0);
    const pos = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const col = colorize ? new Float32Array(vCount * 3) : null;
    const idx = [];
    let dist = 0;
    for (let i = 0; i <= (closed ? n : n - 1); i++) {
      const i0 = i % n;
      const x = points[i0 * 3], y = points[i0 * 3 + 1], z = points[i0 * 3 + 2];
      const iPrev = (i0 - 1 + n) % n;
      const iNext = (i0 + 1) % n;
      let tx = points[iNext * 3] - points[iPrev * 3];
      let tz = points[iNext * 3 + 2] - points[iPrev * 3 + 2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      if (i === 0) dist = 0;
      for (let c = 0; c < cols; c++) {
        const cs = cross[c];
        const vi = i * cols + c;
        pos[vi * 3] = x + nx * cs.off;
        pos[vi * 3 + 1] = y + lift + (cs.y || 0);
        pos[vi * 3 + 2] = z + nz * cs.off;
        uv[vi * 2] = dist * (opts.uScale || 0.12);
        uv[vi * 2 + 1] = cs.u;
        if (col) {
          const t = cs.color || 0;
          col[vi * 3] = t; col[vi * 3 + 1] = t; col[vi * 3 + 2] = t;
        }
      }
      if (i > 0) {
        const total = i * cols;
        const prev = (i - 1) * cols;
        for (let c = 0; c < cols - 1; c++) {
          idx.push(prev + c, total + c, prev + c + 1);
          idx.push(prev + c + 1, total + c, total + c + 1);
        }
      }
      dist += Math.hypot(points[iNext * 3] - x, points[iNext * 3 + 2] - z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  const roadMeshes = new THREE.Group();
  roadMeshes.name = 'roads';

  const HW = layout.roadWidth * 0.5;   // 3.25
  // gravel skirt with a grass blend at the outer edge
  const skirtGeo = buildRibbon(layout.roadSamples, {
    lift: 0.05, closed: true, uScale: 0.2, colorize: true,
    cross: [
      { off: -HW - 1.7, u: 0, color: 0.20 },
      { off: -HW - 0.3, u: 0.6, color: 0.34 },
      { off: -HW + 0.02, u: 1, color: 0.40 },
    ],
  });
  const skirtGeoR = buildRibbon(layout.roadSamples, {
    lift: 0.05, closed: true, uScale: 0.2, colorize: true,
    cross: [
      { off: HW - 0.02, u: 0, color: 0.40 },
      { off: HW + 0.3, u: 0.4, color: 0.34 },
      { off: HW + 1.7, u: 1, color: 0.20 },
    ],
  });
  const skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);
  const skirtMeshR = new THREE.Mesh(skirtGeoR, skirtMat);
  skirtMesh.receiveShadow = skirtMeshR.receiveShadow = true;
  roadMeshes.add(skirtMesh, skirtMeshR);

  // asphalt surface with a slight crown
  const roadGeo = buildRibbon(layout.roadSamples, {
    lift: 0.08, closed: true, uScale: 0.16,
    cross: [
      { off: -HW, u: 0, y: 0.0 },
      { off: -HW + 0.8, u: 0.12, y: 0.045 },
      { off: 0, u: 0.5, y: 0.07 },
      { off: HW - 0.8, u: 0.88, y: 0.045 },
      { off: HW, u: 1, y: 0.0 },
    ],
  });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.name = 'ringRoad';
  roadMeshes.add(roadMesh);

  // Road markings (centre dashes + edge lines) are baked into
  // TEX.roadSurface(); see core/textures.js. Thin standalone marking geometry
  // proved fragile and produced visible artifacts.
  const lineMesh = null;
  const dashMesh = null;

  // Spur trails (gravel)
  const gravel = TEX.gravel();
  const trailMat = new THREE.MeshStandardMaterial({
    map: gravel.map, normalMap: gravel.normalMap, roughnessMap: gravel.roughnessMap,
    roughness: 0.98, metalness: 0, side: THREE.DoubleSide,
  });
  const trailGroup = new THREE.Group();
  for (const [id, spur] of Object.entries(layout.spurs)) {
    const pts = new Float32Array((spur.points.length / 2) * 3);
    for (let i = 0; i < spur.points.length / 2; i++) {
      pts[i * 3] = spur.points[i * 2];
      pts[i * 3 + 1] = spur.ys[i] ?? layout.heightAt(spur.points[i * 2], spur.points[i * 2 + 1]);
      pts[i * 3 + 2] = spur.points[i * 2 + 1];
    }
    const w = spur.width;
    const g = buildRibbon(pts, {
      lift: 0.07, closed: false, uScale: 0.14,
      cross: [
        { off: -w - 1.4, u: 0, y: -0.03 },
        { off: -w, u: 0.15, y: 0 },
        { off: 0, u: 0.5, y: 0.03 },
        { off: w, u: 0.85, y: 0 },
        { off: w + 1.4, u: 1, y: -0.03 },
      ],
    });
    const m = new THREE.Mesh(g, trailMat);
    m.receiveShadow = true;
    m.userData.spur = id;
    trailGroup.add(m);
  }
  roadMeshes.add(trailGroup);
  group.add(roadMeshes);

  // ---------------------------------------------------------------------------
  // Shared height texture (ocean foam + minimap)
  // ---------------------------------------------------------------------------

  const htSize = Math.max(128, preset.heightTextureSize | 0);
  const heightGrid = layout.sampleHeightGrid(htSize);
  // half-float keeps linear filtering universally supported
  const heightData = new Uint16Array(htSize * htSize);
  for (let i = 0; i < heightData.length; i++) heightData[i] = THREE.DataUtils.toHalfFloat(heightGrid[i]);
  const heightTexture = new THREE.DataTexture(heightData, htSize, htSize, THREE.RedFormat, THREE.HalfFloatType);
  heightTexture.needsUpdate = true;
  heightTexture.magFilter = THREE.LinearFilter;
  heightTexture.minFilter = THREE.LinearFilter;
  heightTexture.wrapS = heightTexture.wrapT = THREE.ClampToEdgeWrapping;

  const borders = {
    half,
    uvFromWorld(u) { return (u + half) / worldSize; },
    worldFromUv(t) { return t * worldSize - half; },
  };

  return {
    group,
    heightTexture,
    heightGrid,
    heightSize: htSize,
    borders,
    materials: { terrain: mat, road: roadMat, skirt: skirtMat, trail: trailMat },
    update() { /* static */ },
    setQuality() { /* rebuild not supported at runtime; preset applied at load */ },
    // line/dash meshes were folded into TEX.roadSurface(); keys kept for tools
    _debug: { terrainMesh, roadMesh, lineMesh, dashMesh, skirtMesh, skirtMeshR, roadGroup: roadMeshes },
  };
}
