/**
 * sky.js - the sky dome: atmosphere gradient, sun & moon discs, stars,
 * milky way, and two animated cloud layers. Also computes the sun/moon
 * directions and the lighting palette for the current hour.
 *
 * The dome uses depthTest:false and renders first, so it never occludes
 * anything. It provides `skyScene` for PMREM environment generation.
 */

import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../core/utils.js';

const RAMP = [
  // hour, zenith, horizon, sun colour, sun intensity, ambient
  [0.0, '#04070f', '#0a1220', '#7d92c4', 0.0, 0.28],
  [4.3, '#060a16', '#101a2c', '#8093c2', 0.0, 0.30],
  [5.4, '#182a4e', '#6a6a86', '#e8b090', 0.55, 0.48],
  [6.4, '#2b4a7d', '#f0a271', '#ffb27a', 2.10, 0.66],
  [7.6, '#3a6bb4', '#ffd0a0', '#ffe0bd', 2.75, 0.80],
  [10.0, '#2f6fd0', '#c3dcf2', '#fff4e2', 3.30, 0.86],
  [13.0, '#2c6bcc', '#cfe4f6', '#fffaf0', 3.45, 0.88],
  [16.0, '#3170cb', '#c9dff2', '#ffeED2', 3.20, 0.84],
  [17.4, '#2f5fae', '#ffc894', '#ffcf9a', 2.75, 0.76],
  [18.4, '#27457f', '#ff9d6b', '#ff9f66', 1.75, 0.62],
  [19.3, '#16233f', '#7d6a86', '#d79a86', 0.65, 0.40],
  [20.2, '#0a1224', '#1d2a44', '#9aa6cc', 0.06, 0.34],
  [21.5, '#05080f', '#0c1424', '#8595c0', 0.0, 0.30],
  [24.0, '#04070f', '#0a1220', '#7d92c4', 0.0, 0.28],
];

function rampSample(hour) {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < RAMP.length - 1; i++) {
    const a = RAMP[i], b = RAMP[i + 1];
    if (h >= a[0] && h <= b[0]) {
      const t = (h - a[0]) / Math.max(1e-6, b[0] - a[0]);
      const s = t * t * (3 - 2 * t);
      return {
        zenith: new THREE.Color(a[1]).lerp(new THREE.Color(b[1]), s),
        horizon: new THREE.Color(a[2]).lerp(new THREE.Color(b[2]), s),
        sunColor: new THREE.Color(a[3]).lerp(new THREE.Color(b[3]), s),
        sunIntensity: lerp(a[4], b[4], s),
        ambient: lerp(a[5], b[5], s),
      };
    }
  }
  return {
    zenith: new THREE.Color(RAMP[0][1]), horizon: new THREE.Color(RAMP[0][2]),
    sunColor: new THREE.Color(RAMP[0][3]), sunIntensity: RAMP[0][4], ambient: RAMP[0][5],
  };
}

export function createSky(ctx) {
  const { textures: TEX } = ctx;
  const group = new THREE.Group();
  group.name = 'sky';
  const R = 6400;

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.3, 0.4, 0.85) },
    uMoonDir: { value: new THREE.Vector3(-0.3, 0.5, -0.8) },
    uZenith: { value: new THREE.Color('#2f6fd0') },
    uHorizon: { value: new THREE.Color('#c3dcf2') },
    uSunColor: { value: new THREE.Color('#fff4e2') },
    uSundown: { value: new THREE.Color('#ff9d6b') },
    uGround: { value: new THREE.Color('#33404f') },
    uNight: { value: 0 },
    uCloudiness: { value: 0.35 },
    uTime: { value: 0 },
    uSunElev: { value: 0.5 },
    uStarField: { value: 1 },
    uMoonPhase: { value: 0.35 },
  };

  const vertexShader = /* glsl */`
    varying vec3 vDir;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDir = normalize(wp.xyz - cameraPosition);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const fragmentShader = /* glsl */`
    precision highp float;
    uniform vec3 uSunDir, uMoonDir, uZenith, uHorizon, uSunColor, uSundown, uGround;
    uniform float uNight, uCloudiness, uTime, uSunElev, uStarField, uMoonPhase;
    varying vec3 vDir;

    float hash13(vec3 p3) {
      p3 = fract(p3 * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec3 x) {
      vec3 i = floor(x), f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
            mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
        mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
            mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
        f.z);
    }
    float fbm3(vec3 p) {
      float a = 0.5, s = 0.0;
      for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
      return s;
    }

    void main() {
      vec3 dir = normalize(vDir);
      float hgt = dir.y;

      // --- base atmosphere ---
      float t = pow(clamp(hgt, 0.0, 1.0), 0.52);
      vec3 col = mix(uHorizon, uZenith, t);

      // ground haze below the horizon (stops the dome from looking hollow)
      col = mix(col, uGround, smoothstep(0.0, -0.16, hgt));

      // --- sun ---
      float sd = max(dot(dir, uSunDir), 0.0);
      // sunset / sunrise band around the sun azimuth near the horizon
      float horiz = pow(clamp(1.0 - abs(hgt) * 2.1, 0.0, 1.0), 2.4);
      float sunAz = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 3.0);
      col = mix(col, uSundown, horiz * sunAz * 0.75 * (1.0 - uNight));
      // disc + halo
      float disc = smoothstep(0.99966, 0.99985, sd);
      float glow = pow(sd, 480.0) * 1.4 + pow(sd, 26.0) * 0.22 + pow(sd, 6.0) * 0.022;
      col += uSunColor * (disc * 12.0 + glow) * clamp(uSunElev * 3.0 + 0.15, 0.0, 1.6);
      // atmospheric extinction near the horizon
      col *= mix(vec3(1.0), vec3(1.06, 0.92, 0.78), clamp(1.0 - abs(hgt) * 3.0, 0.0, 1.0));

      // --- moon ---
      float md = max(dot(dir, uMoonDir), 0.0);
      float moonDisc = smoothstep(0.99980, 0.99992, md);
      vec3 moonRight = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-5, 0.0, 0.0));
      float phaseDot = max(dot(dir, normalize(uMoonDir + moonRight * (uMoonPhase - 0.5) * 0.09)), 0.0);
      float phaseCut = smoothstep(0.99980, 0.99992, phaseDot);
      float crescent = clamp(moonDisc - phaseCut * uMoonPhase, 0.0, 1.0);
      float crater = 0.75 + 0.25 * vnoise(dir * 2600.0);
      vec3 moonCol = vec3(1.0, 0.97, 0.90) * crater;
      col += moonCol * crescent * 4.0 * uNight;
      // wide moon halo so night still reads as "sky" not "void"
      col += vec3(0.42, 0.52, 0.78) * pow(md, 90.0) * 0.55 * uNight;

      // --- stars + milky way ---
      if (uStarField > 0.001) {
        vec3 sp = dir * 260.0;
        vec3 cell = floor(sp);
        float h1 = hash13(cell);
        float star = 0.0;
        if (h1 > 0.9835) {
          vec3 jit = vec3(hash13(cell + 13.1), hash13(cell + 27.3), hash13(cell + 41.7)) - 0.5;
          float d = length(fract(sp) - 0.5 - jit * 0.55);
          float tw = 0.6 + 0.4 * sin(uTime * 2.3 + h1 * 90.0);
          star = smoothstep(0.16, 0.0, d) * ((h1 - 0.9835) / 0.0165) * tw;
        }
        // milky way band
        vec3 bandN = normalize(vec3(0.42, 0.55, -0.72));
        float band = exp(-pow(dot(dir, bandN) * 3.6, 2.0));
        float mw = fbm3(dir * 7.0 + 3.1) * band;
        col += vec3(0.74, 0.80, 0.98) * (star * 2.4 + mw * 0.09) * uStarField * clamp(hgt + 0.06, 0.0, 1.0);
      }

      // --- clouds (2 layers, raymarched on a plane) ---
      if (uCloudiness > 0.01 && hgt > 0.008) {
        vec2 drift = vec2(uTime * 0.0026, uTime * 0.0013);
        for (int layer = 0; layer < 2; layer++) {
          float h = mix(900.0, 2100.0, float(layer));
          vec2 p = dir.xz / max(hgt, 0.02) * h;
          float scale = mix(0.00042, 0.00022, float(layer));
          float cov = uCloudiness * mix(0.72, 1.0, float(layer));
          float n = fbm3(vec3(p * scale + drift * float(layer + 1), float(layer) * 7.0));
          float cloud = smoothstep(1.0 - cov * 0.85, 1.0 - cov * 0.25, n);
          // light the cloud: bright toward the sun side, dark bottoms
          float sunSide = clamp(dot(normalize(vec3(dir.x, 0.28, dir.z)), normalize(vec3(uSunDir.x, 0.32, uSunDir.z))) * 0.5 + 0.5, 0.0, 1.0);
          float density = smoothstep(0.0, 0.6, n - (1.0 - cov * 0.8));
          vec3 cloudShadow = mix(vec3(0.34, 0.36, 0.42), uZenith * 0.55, 0.4);
          vec3 cloudLit = mix(vec3(1.0, 0.99, 0.97), uSunColor * 1.1, 0.55);
          vec3 cloudCol = mix(cloudShadow, cloudLit, sunSide * (1.0 - density * 0.35));
          // sunset warmth
          cloudCol = mix(cloudCol, uSundown * 1.05, horiz * 0.55 * (1.0 - uNight) * sunSide);
          // moonlight: clouds must go dim at night instead of glowing white
          cloudCol *= mix(1.0, 0.085, uNight);
          cloudCol += vec3(0.30, 0.36, 0.52) * uNight * 0.22 * sunSide;
          // fade near the horizon and the zenith
          float fadeH = smoothstep(0.012, 0.10, hgt) * (1.0 - smoothstep(0.72, 0.98, hgt) * 0.55);
          float a = cloud * fadeH * (layer == 0 ? 0.86 : 0.5);
          col = mix(col, cloudCol, clamp(a, 0.0, 1.0));
        }
      }

      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 24), mat);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  group.add(dome);
  group.frustumCulled = false;

  // separate scene for PMREM environment generation
  const skyScene = new THREE.Scene();
  const pmremDome = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 20), mat);
  pmremDome.frustumCulled = false;
  skyScene.add(pmremDome);

  const sunDir = new THREE.Vector3(0.3, 0.5, 0.8);
  const moonDir = new THREE.Vector3(-0.4, 0.5, -0.7);
  const palette = rampSample(17.1);
  let hour = 17.1;

  function computeDirs(h) {
    // sun: rises east (6h), sets west (18h)
    const dayT = (h - 6) / 12;
    // Lift the low-sun part of the curve a little: with a real 7° evening sun
    // the island's own hills put most of the map in shadow, which reads as
    // "broken" rather than "moody".
    const s = Math.sin(dayT * Math.PI);
    const elev = Math.sign(s) * Math.pow(Math.abs(s), 0.82) * (Math.PI * 0.46);
    const az = -Math.PI * 0.02 + dayT * Math.PI;
    sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)).normalize();
    // moon: rises east (18h), sets west (6h)
    const mnT = (((h - 18) % 24) + 24) % 24 / 12;
    const mElev = Math.sin(clamp01(mnT) * Math.PI) * (Math.PI * 0.40);
    const mAz = -Math.PI * 0.02 + mnT * Math.PI;
    moonDir.set(Math.cos(mAz) * Math.cos(mElev), Math.sin(mElev), Math.sin(mAz) * Math.cos(mElev)).normalize();
    return { elev };
  }

  function updatePalette(h) {
    const p = rampSample(h);
    palette.zenith = p.zenith; palette.horizon = p.horizon;
    palette.sunColor = p.sunColor; palette.sunIntensity = p.sunIntensity;
    palette.ambient = p.ambient;
    const { elev } = computeDirs(h);
    const night = 1 - smoothstep(-0.06, 0.10, Math.sin(elev));
    palette.night = night;
    palette.sunElevation = Math.sin(elev);
    uniforms.uZenith.value.copy(p.zenith);
    uniforms.uHorizon.value.copy(p.horizon);
    uniforms.uSunColor.value.copy(p.sunColor);
    uniforms.uGround.value.copy(p.horizon).multiplyScalar(0.32);
    uniforms.uNight.value = night;
    uniforms.uSunDir.value.copy(sunDir);
    uniforms.uMoonDir.value.copy(moonDir);
    uniforms.uSunElev.value = Math.sin(elev);
    // stars only at night; clouds still visible by moonlight (dimmed in shader)
    uniforms.uStarField.value = clamp01((night - 0.35) / 0.5);
    return palette;
  }

  const state = { hour };
  function setHour(h) {
    hour = ((h % 24) + 24) % 24;
    state.hour = hour;
    updatePalette(hour);
  }
  setHour(hour);

  return {
    group,
    skyScene,
    material: mat,
    uniforms,
    sunDir,
    moonDir,
    palette,
    get hour() { return hour; },
    setHour,
    update(dt, gameState) {
      uniforms.uTime.value += dt;
      if (gameState && typeof gameState.hour === 'number') {
        const h = gameState.hour;
        if (Math.abs(h - hour) > 0.0005) setHour(h);
      }
      uniforms.uCloudiness.value = clamp01((gameState?.weather?.cloudiness ?? 0.35));
      if (gameState) {
        if (!gameState.sun) gameState.sun = { dir: new THREE.Vector3(), color: new THREE.Color(), intensity: 1 };
        if (!gameState.moon) gameState.moon = { dir: new THREE.Vector3(), intensity: 0 };
        gameState.sun.dir.copy(sunDir);
        gameState.sun.color.copy(palette.sunColor);
        gameState.sun.intensity = palette.sunIntensity;
        gameState.moon.dir.copy(moonDir);
        gameState.moon.intensity = palette.night * 0.22;
      }
    },
  };
}

/** Exported for the ocean shader so water reflections match the sky. */
export function skyPaletteForHour(hour) {
  return rampSample(hour);
}
