/**
 * ocean.js - the sea, the lake and the river share one Gerstner-wave water
 * shader. Depth-aware colouring + shore foam come from the terrain height
 * DataTexture built by terrain.js (passed in through ctx.heightTexture).
 */

import * as THREE from 'three';
import { clamp01, lerp } from '../core/utils.js';
import { skyPaletteForHour } from './sky.js';

const WAVE_COUNT = 6;

function waterVertexShader({ lake, river }) {
  return /* glsl */`
    uniform float uTime;
    uniform vec4 uWaves[${WAVE_COUNT}];   // dirX, dirZ, amplitude, wavelength
    uniform float uAmpScale;
    uniform float uWaterLevel;
    uniform sampler2D uHeightTex;
    uniform vec3 uHeightInfo;   // halfWorld, 1/worldSize, unused
    attribute float aWaterY;   // per-vertex water surface height (river rises)
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vCrest;
    varying float vWaterY;
    #include <fog_pars_vertex>

    void gerstner(vec2 p, out vec3 disp, out vec3 nrm) {
      disp = vec3(0.0);
      float dhdx = 0.0, dhdz = 0.0;
      float crestSum = 0.0;
      for (int i = 0; i < ${WAVE_COUNT}; i++) {
        vec4 wv = uWaves[i];
        vec2 d = normalize(wv.xy);
        float amp = wv.z * uAmpScale;
        float len = wv.w;
        float k = 6.28318 / len;
        float speed = sqrt(9.81 / k) * 0.62;
        float phase = dot(d, p) * k + uTime * speed;
        float s = sin(phase), c = cos(phase);
        float steep = 0.62 / k;
        disp.x += d.x * steep * c * amp * k * 0.5;
        disp.z += d.y * steep * c * amp * k * 0.5;
        disp.y += amp * s;
        dhdx += d.x * k * amp * c;
        dhdz += d.y * k * amp * c;
        crestSum += amp * s;
      }
      nrm = normalize(vec3(-dhdx, 1.0, -dhdz));
      vCrest = crestSum;
    }

    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec3 disp, nrm;
      // Damp the swell with distance. The detail plane only reaches ~900 m, so
      // the waves have to be gone well before its edge - otherwise the seam
      // with the flat far plane shows. (Long swells at range are handled in the
      // fragment shader, where the pixel footprint is known.)
      float camDist = distance(wp.xz, cameraPosition.xz);
      float ampFade = 1.0 - smoothstep(240.0, 760.0, camDist);
      // Shallow-water damping. Without it a 1.7 m swell rides straight up the
      // beach and paints water (and foam) over dry land, which is what produced
      // the floating white blobs on the shoreline.
      vec2 huv = (wp.xz + uHeightInfo.x) * uHeightInfo.y;
      float terrainH = texture2D(uHeightTex, huv).r;
      float shoreDepth = max(0.0, aWaterY - terrainH);
      float shoal = mix(0.12, 1.0, smoothstep(0.0, 5.0, shoreDepth));
      gerstner(wp.xz, disp, nrm);
      // ampFade must reach exactly 0: a flat far plane is aliasing-free, whereas even
      // a third of the amplitude sampled at 150 m per quad turned the horizon
      // into hard horizontal bands.
      disp *= ampFade * shoal;
      wp.xyz += disp;
      nrm = normalize(mix(vec3(0.0, 1.0, 0.0), nrm, shoal));
      vec4 mvPosition = viewMatrix * wp;
      vWorld = wp.xyz;
      vNormal = nrm;
      vWaterY = aWaterY;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `;
}

function waterFragmentShader({ lake, river }) {
  return /* glsl */`
    precision highp float;
    uniform sampler2D uHeightTex;
    uniform vec3 uHeightInfo;      // halfWorld, 1/worldSize, unused
    uniform sampler2D uRippleTex;
    uniform vec3 uSunDir, uSunColor, uSkyZenith, uSkyHorizon;
    uniform vec3 uDeepColor, uShallowColor, uFoamColor;
    uniform float uTime, uWaterLevel, uIsLake, uIsRiver, uSunIntensity, uNight, uFoamStrength, uAmpScale;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vCrest;
    varying float vWaterY;
    #include <fog_pars_fragment>

    void main() {
      vec2 huv = (vWorld.xz + uHeightInfo.x) * uHeightInfo.y;
      float terrainH = texture2D(uHeightTex, huv).r;
      // NOTE: the surface height must come from the geometry, not a constant -
      // the river climbs from the sea to the lake, and using uWaterLevel made
      // every river fragment read as a 0 m shoreline (all foam, pure white).
      float depth = max(0.0, vWaterY - terrainH);

      // Screen-space footprint of one pixel measured in metres of water. Cheap
      // and exact: it makes every normal detail scale itself down before it can
      // alias, which is what produced the banded horizon on grazing views.
      float px = max(fwidth(vWorld.x), fwidth(vWorld.z));
      float rippleFade = 1.0 - smoothstep(0.05, 0.85, px);
      float swellFade = 1.0 - smoothstep(1.6, 22.0, px);

      // --- normal: gerstner + two scrolling ripple layers ---
      vec3 N = normalize(vNormal);
      vec2 uv1 = vWorld.xz * 0.020 + vec2(uTime * 0.011, uTime * 0.007);
      vec2 uv2 = vWorld.xz * 0.047 - vec2(uTime * 0.008, uTime * 0.013);
      vec3 r1 = texture2D(uRippleTex, uv1).xyz * 2.0 - 1.0;
      vec3 r2 = texture2D(uRippleTex, uv2).xyz * 2.0 - 1.0;
      float rScale = mix(0.35, 0.10, uIsLake);
      N = normalize(N + vec3(r1.x + r2.x * 0.6, 0.0, r1.z + r2.z * 0.6) * rScale * rippleFade);
      // Beyond the detail plane the geometry is flat on purpose, so the only
      // thing that may add shape there is mip-filtered texture: sampling a
      // normal map with its own screen derivatives makes the GPU pick a
      // prefiltered mip, and averaged normal maps fade to flat instead of
      // aliasing into bands. Analytic sines were tried first and read as
      // obvious stripes on the horizon.
      {
        vec2 uvS = vWorld.xz * 0.0016;
        vec3 rs = textureGrad(uRippleTex, uvS, dFdx(uvS) * 2.2, dFdy(uvS) * 2.2).xyz * 2.0 - 1.0;
        N = normalize(N + vec3(rs.x, 0.0, rs.z) * 0.22 * swellFade);
      }

      vec3 V = normalize(cameraPosition - vWorld);
      float fres = 0.02 + 0.90 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

      // --- sky reflection (matches sky.js palette) ---
      vec3 R = reflect(-V, N);
      vec3 skyCol = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.y, 0.0, 1.0), 0.55));
      // A mirror-perfect sea reads as blown-out white under a bright sky;
      // keep some of the water body in the reflection term.
      skyCol *= 0.72;
      // The sharp lobe is a sub-pixel highlight, so it may only exist where the
      // footprint is small; the wide lobe is what carries the sun path at range.
      float sd2 = max(dot(R, uSunDir), 0.0);
      // A 6x sharp lobe plus bloom turned the sun path into a blown-out white
      // shelf. Real glitter is bright but it still reads as water.
      float sunSpec = pow(sd2, 900.0) * 2.1 * rippleFade
                    + pow(sd2, 60.0) * 0.22 * mix(0.35, 1.0, swellFade);
      // glitter
      float glitter = texture2D(uRippleTex, vWorld.xz * 0.35 + vec2(uTime * 0.05)).x;
      sunSpec *= 0.6 + glitter * 1.4 * rippleFade;
      skyCol += uSunColor * sunSpec * clamp(uSunIntensity * 0.5, 0.1, 2.0);

      // --- water body colour ---
      float shallowMix = smoothstep(0.0, 10.0, depth);
      vec3 body = mix(uShallowColor, uDeepColor, shallowMix);
      // sub-surface glow when looking towards the sun through a crest
      float toward = pow(max(dot(-V, normalize(vec3(uSunDir.x, 0.05, uSunDir.z))), 0.0), 2.0);
      body += uShallowColor * toward * 0.5 * (1.0 - shallowMix * 0.7) * (0.4 + clamp(uSunIntensity * 0.3, 0.0, 1.0));
      body *= mix(0.30, 1.0, 1.0 - uNight * 0.82);

      vec3 col = mix(body, skyCol, fres);

      // --- foam ---
      // rivers are shallow by construction - do not read them as surf beaches
      // The height texture is 7.8 m per texel at the high preset, so a narrow
      // band is the honest choice: a wide one turns into a blown-out white
      // shelf tens of metres offshore.
      float shore = (1.0 - smoothstep(0.05, 1.15, depth)) * (1.0 - uIsRiver * 0.92);
      vec2 fuv = vWorld.xz * 0.09 + vec2(uTime * 0.02, -uTime * 0.016);
      float fn = texture2D(uRippleTex, fuv).x * 0.6 + texture2D(uRippleTex, fuv * 2.7 - 3.1).x * 0.4;
      // lace the shoreline with noise, push the foam line back and forth
      float wobble = (fn - 0.5) * 1.6;
      float foamBand = smoothstep(0.9, 0.0, depth + wobble * 1.1) * shore;
      float crestFoam = smoothstep(0.55, 1.15, vCrest * uAmpScale * 1.6) * 0.55;
      crestFoam *= mix(1.0, 0.45, 1.0 - rippleFade) * mix(1.0, 0.5, 1.0 - swellFade);
      float foam = clamp(foamBand * 1.2 + crestFoam * 0.5, 0.0, 1.0) * uFoamStrength;
      foam *= mix(0.32, 1.0, 1.0 - uNight * 0.62);
      col = mix(col, uFoamColor, foam);

      // river: subtle whitewater
      col = mix(col, uFoamColor * 0.92, uIsRiver * smoothstep(0.35, 0.9, fn) * 0.35);

      // Distant water sits under a lot of atmosphere: pull it toward the sky so
      // the horizon line dissolves instead of ending in a hard edge.
      float horizonFade = smoothstep(900.0, 6500.0, distance(vWorld, cameraPosition));
      col = mix(col, mix(uSkyHorizon, uSkyZenith, 0.25), horizonFade * 0.72);

      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
      #include <colorspace_fragment>
    }
  `;
}

export function createOcean(ctx) {
  const { layout, textures: TEX, engine, heightTexture } = ctx;
  const preset = engine?.preset || {};
  const group = new THREE.Group();
  group.name = 'water';

  const ripple = TEX.waterNormal();
  const R = Math.min(12000, (preset.viewDistance || 14000) * 0.85);
  const seg = Math.max(48, preset.oceanSegments || 128);

  const waves = [
    [1.0, 0.15, 0.55, 42.0],
    [0.72, -0.69, 0.42, 27.0],
    [0.36, 0.93, 0.30, 17.0],
    [-0.86, 0.51, 0.22, 11.5],
    [0.15, -0.99, 0.15, 7.2],
    [-0.42, -0.91, 0.10, 4.6],
  ].map((w) => new THREE.Vector4(w[0], w[1], w[2], w[3]));

  function makeUniforms({ waterLevel, isLake, isRiver, ampScale, foam }) {
    return {
      uTime: { value: 0 },
      uWaves: { value: waves },
      uAmpScale: { value: ampScale },
      uWaterLevel: { value: waterLevel },
      uHeightTex: { value: heightTexture },
      uHeightInfo: { value: new THREE.Vector3(layout.HALF, 1 / layout.WORLD_SIZE, 0) },
      uRippleTex: { value: ripple.map },
      uSunDir: { value: new THREE.Vector3(0.3, 0.5, 0.8) },
      uSunColor: { value: new THREE.Color('#fff4e2') },
      uSkyZenith: { value: new THREE.Color('#2f6fd0') },
      uSkyHorizon: { value: new THREE.Color('#c3dcf2') },
      uDeepColor: { value: isLake ? new THREE.Color('#0e3038') : new THREE.Color('#08344c') },
      uShallowColor: { value: isLake ? new THREE.Color('#2f6f68') : new THREE.Color('#2a8496') },
      uFoamColor: { value: new THREE.Color('#e6f2f4') },
      uIsLake: { value: isLake ? 1 : 0 },
      uIsRiver: { value: isRiver ? 1 : 0 },
      uSunIntensity: { value: 3 },
      uNight: { value: 0 },
      uFoamStrength: { value: foam },
    };
  }

  function makeMaterial(opts) {
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      makeUniforms(opts),
    ]);
    // merge() clones values; re-bind live objects that must stay shared
    uniforms.uRippleTex.value = ripple.map;
    uniforms.uHeightTex.value = heightTexture;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: waterVertexShader(opts),
      fragmentShader: waterFragmentShader(opts),
      fog: true,
      side: THREE.DoubleSide,
      transparent: false,
    });
    mat.userData.uniforms = uniforms;
    return mat;
  }

  // --- sea ---------------------------------------------------------------
  // Two coplanar sheets. The far one is deliberately flat and cheap (it only
  // has to hold the reflection, the sun path and the horizon haze); the near
  // one rides with the camera with ~8 m quads so the 4.6-42 m Gerstner waves
  // actually exist as geometry. A single 150 m-per-quad plane could never
  // represent them, which is what the banded horizon was.
  const NEAR_HALF = 900;
  const nearSeg = Math.max(96, Math.min(288, Math.round(seg * 1.4)));
  const NEAR_STEP = (NEAR_HALF * 2) / nearSeg;

  const seaNearGeo = new THREE.PlaneGeometry(NEAR_HALF * 2, NEAR_HALF * 2, nearSeg, nearSeg);
  seaNearGeo.setAttribute('aWaterY', new THREE.Float32BufferAttribute(new Float32Array(seaNearGeo.attributes.position.count), 1));
  const seaNearMat = makeMaterial({ waterLevel: 0, isLake: 0, isRiver: 0, ampScale: 1.0, foam: 1.0 });
  const seaNear = new THREE.Mesh(seaNearGeo, seaNearMat);
  seaNear.rotation.x = -Math.PI / 2;
  seaNear.position.y = 0;
  seaNear.receiveShadow = false;
  seaNear.renderOrder = 1;
  seaNear.frustumCulled = false;
  seaNear.name = 'seaNear';
  group.add(seaNear);

  const seaGeo = new THREE.PlaneGeometry(R * 2, R * 2, seg, seg);
  seaGeo.setAttribute('aWaterY', new THREE.Float32BufferAttribute(new Float32Array(seaGeo.attributes.position.count), 1));
  const seaMat = makeMaterial({ waterLevel: 0, isLake: 0, isRiver: 0, ampScale: 0.0, foam: 1.0 });
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.rotation.x = -Math.PI / 2;
  // A hair below the detail sheet so the two never z-fight; at these
  // distances the offset is invisible and the seam colours match exactly.
  sea.position.y = -0.30;
  sea.receiveShadow = false;
  sea.renderOrder = 1;
  group.add(sea);

  // --- lake ---
  const lakeGeo = new THREE.PlaneGeometry(1000, 1000, Math.round(seg * 0.6), Math.round(seg * 0.6));
  {
    const n = lakeGeo.attributes.position.count;
    const wy = new Float32Array(n).fill(layout.lakeY);
    lakeGeo.setAttribute('aWaterY', new THREE.Float32BufferAttribute(wy, 1));
  }
  const lakeMat = makeMaterial({ waterLevel: layout.lakeY, isLake: 1, isRiver: 0, ampScale: 0.12, foam: 0.5 });
  const lakeMesh = new THREE.Mesh(lakeGeo, lakeMat);
  lakeMesh.rotation.x = -Math.PI / 2;
  lakeMesh.position.set(layout.lake.center.x, layout.lakeY, layout.lake.center.z);
  lakeMesh.renderOrder = 2;
  group.add(lakeMesh);

  // --- river ribbon ---
  const riverMat = makeMaterial({ waterLevel: 0, isLake: 0, isRiver: 1, ampScale: 0.08, foam: 0.3 });
  const riverMesh = (() => {
    const pts = layout.riverSamples;
    const n = pts.length / 2;
    const pos = [];
    const wy = [];
    const idx = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let tx = pts[i1 * 2] - pts[i0 * 2];
      let tz = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const t = i / (n - 1);
      const w = (7.0 + 7.0 * t);
      const y = layout.riverBedY(t) + 1.15;
      pos.push(x + nx * -w, y, z + nz * -w, x + nx * w, y, z + nz * w);
      wy.push(y, y);
      if (i > 0) {
        const a = (i - 1) * 2, b = i * 2;
        idx.push(a, a + 1, b, a + 1, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aWaterY', new THREE.Float32BufferAttribute(new Float32Array(wy), 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, riverMat);
  })();
  riverMesh.renderOrder = 2;
  group.add(riverMesh);

  // --- splash ripple rings (pooled) ---
  const rings = [];
  const ringGeo = new THREE.RingGeometry(0.4, 0.6, 28);
  const ringMatBase = new THREE.MeshBasicMaterial({
    color: 0xeafcff, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(ringGeo, ringMatBase.clone());
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.renderOrder = 3;
    group.add(m);
    rings.push({ mesh: m, life: 0, ttl: 1, size: 1 });
  }
  let ringCursor = 0;

  function splash(x, z, size = 1) {
    const r = rings[ringCursor++ % rings.length];
    r.mesh.position.set(x, 0.07, z);
    r.mesh.scale.setScalar(Math.max(0.6, size * 2));
    r.mesh.visible = true;
    r.life = 0;
    r.ttl = 1.3 + size * 0.4;
    r.size = size;
  }

  const palette = skyPaletteForHour(17.1);

  function updateUniforms(mat, dt, state) {
    const u = mat.userData.uniforms;
    u.uTime.value += dt * (1.0 + (state?.wind?.strength ?? 0.3) * 0.6);
    if (state?.sun) {
      u.uSunDir.value.copy(state.sun.dir);
      u.uSunColor.value.copy(state.sun.color);
      u.uSunIntensity.value = state.sun.intensity;
      u.uNight.value = palette.night ?? 0;
    }
    const p = skyPaletteForHour(state?.hour ?? 17.1);
    u.uSkyZenith.value.copy(p.zenith);
    u.uSkyHorizon.value.copy(p.horizon);
    u.uNight.value = p.night;
  }

  return {
    group,
    materials: { sea: seaMat, seaNear: seaNearMat, lake: lakeMat, river: riverMat },
    splash,
    update(dt, state) {
      // Ride along with the camera, snapped to the quad grid: the waves are
      // evaluated from world XZ, so snapping keeps the sample positions on the
      // world grid and the surface does not swim as the player moves.
      const cam = engine?.camera?.position;
      if (cam) {
        seaNear.position.x = Math.round(cam.x / NEAR_STEP) * NEAR_STEP;
        seaNear.position.z = Math.round(cam.z / NEAR_STEP) * NEAR_STEP;
      }
      updateUniforms(seaNearMat, dt, state);
      updateUniforms(seaMat, dt, state);
      updateUniforms(lakeMat, dt, state);
      updateUniforms(riverMat, dt, state);
      for (const r of rings) {
        if (!r.mesh.visible) continue;
        r.life += dt;
        const t = clamp01(r.life / r.ttl);
        const s = lerp(r.size * 2, r.size * 11, t);
        r.mesh.scale.setScalar(s);
        r.mesh.material.opacity = 0.5 * (1 - t) * (1 - t);
        if (t >= 1) r.mesh.visible = false;
      }
      void palette;
    },
    setQuality() { /* density fixed at build time */ },
  };
}
