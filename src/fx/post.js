/**
 * post.js - the cinematic post-processing chain.
 *
 * RenderPass -> GodRays -> Bloom -> Grade(+DOF, grain, vignette, CA)
 *            -> OutputPass -> SMAA
 *
 * Everything is quality-gated through engine.preset. Photo mode enables a
 * half-res depth prepass for depth-of-field.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { clamp01, lerp } from '../core/utils.js';

const GodRayShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSunPos: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0.0 },
    uDensity: { value: 0.62 },
    uDecay: { value: 0.94 },
    uWeight: { value: 0.35 },
    uColor: { value: new THREE.Color('#ffdca8') },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uSunPos;
    uniform float uStrength, uDensity, uDecay, uWeight;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      if (uStrength <= 0.001) { gl_FragColor = vec4(base, 1.0); return; }
      vec2 delta = (uSunPos - vUv) * (uDensity / 24.0);
      vec2 p = vUv;
      vec3 acc = vec3(0.0);
      float illum = 1.0;
      for (int i = 0; i < 24; i++) {
        p += delta;
        vec3 s = texture2D(tDiffuse, clamp(p, vec2(0.001), vec2(0.999))).rgb;
        float l = max(0.0, dot(s, vec3(0.299, 0.587, 0.114)) - 0.78);
        acc += s * l * illum;
        illum *= uDecay;
      }
      gl_FragColor = vec4(base + acc * uWeight * uColor * uStrength, 1.0);
    }
  `,
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.0 },
    uGrain: { value: 0.6 },
    uCA: { value: 0.35 },
    uSaturation: { value: 1.02 },
    uContrast: { value: 1.05 },
    uLift: { value: 0.0 },
    uDofAmount: { value: 0.0 },
    uFocusDist: { value: 12.0 },
    uAperture: { value: 0.35 },
    uNear: { value: 0.25 },
    uFar: { value: 18000.0 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uFade: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float uTime, uVignette, uGrain, uCA, uSaturation, uContrast, uLift;
    uniform float uDofAmount, uFocusDist, uAperture, uNear, uFar, uFade;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // chromatic aberration towards the frame edges
      vec3 col;
      if (uCA > 0.001) {
        vec2 off = d * r2 * uCA * 0.02;
        col.r = texture2D(tDiffuse, uv + off).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - off).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // depth of field (photo mode only)
      if (uDofAmount > 0.001) {
        float depth = texture2D(tDepth, uv).x;
        float viewZ = perspectiveDepthToViewZ(depth, uNear, uFar);
        float coc = clamp(abs(-viewZ - uFocusDist) / max(1.0, uFocusDist) * uAperture, 0.0, 1.0);
        coc = pow(coc, 1.35) * uDofAmount;
        vec3 blur = vec3(0.0);
        float total = 0.0;
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 2.39996;
          float r = sqrt(float(i) + 0.5) * 2.4 * coc / uResolution.y * 90.0;
          vec2 o = vec2(cos(a), sin(a)) * r / uResolution * 120.0;
          float w = 1.0 / (1.0 + float(i) * 0.4);
          blur += texture2D(tDiffuse, uv + o).rgb * w;
          total += w;
        }
        blur /= total;
        col = mix(col, blur, clamp(coc, 0.0, 0.85));
      }

      // --- grade: contrast, split tone, saturation ---
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // teal shadows / warm highlights
      vec3 shadowTint = vec3(0.94, 1.015, 1.045);
      vec3 highTint = vec3(1.035, 1.005, 0.965);
      vec3 tint = mix(shadowTint, highTint, smoothstep(0.15, 0.85, luma));
      col *= tint;
      // gentle film curve
      col = col / (1.0 + max(col - 1.0, 0.0) * 0.22);
      col = mix(vec3(luma), col, uSaturation);
      col += uLift * (1.0 - luma);

      // vignette
      float vig = smoothstep(0.95, 0.22, length(d) * 1.28);
      col *= mix(1.0, vig, uVignette * 0.62);

      // film grain
      if (uGrain > 0.001) {
        float g = hash12(uv * uResolution + fract(uTime) * 977.0) - 0.5;
        col += g * 0.028 * uGrain;
      }

      // fade (used for scene transitions)
      col *= uFade;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export function createPost(engine, ctx) {
  const { renderer, scene, camera } = engine;
  const layout = ctx.layout;
  const preset = engine.preset;

  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);

  const composer = new EffectComposer(renderer);
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const godPass = new ShaderPass(GodRayShader);
  godPass.enabled = !!preset.godrays;
  composer.addPass(godPass);

  let bloomPass = null;
  if (preset.bloom) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), preset.bloomStrength ?? 0.4, 0.55, 0.86);
    composer.addPass(bloomPass);
  }

  const gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uGrain.value = preset.grain ? 0.6 : 0.0;
  gradePass.uniforms.uCA.value = preset.chromatic ? 0.35 : 0.0;
  gradePass.uniforms.uVignette.value = preset.vignette ? 1.0 : 0.0;
  gradePass.uniforms.uNear.value = camera.near;
  gradePass.uniforms.uFar.value = camera.far;
  composer.addPass(gradePass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  let smaaPass = null;
  if (preset.smaa) {
    smaaPass = new SMAAPass(size.x, size.y);
    composer.addPass(smaaPass);
  }

  // half-res depth prepass target (photo mode DOF only)
  const depthRT = new THREE.WebGLRenderTarget(Math.max(2, size.x >> 1), Math.max(2, size.y >> 1), {
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: new THREE.DepthTexture(Math.max(2, size.x >> 1), Math.max(2, size.y >> 1)),
  });
  depthRT.depthTexture.type = THREE.UnsignedIntType;
  depthRT.depthTexture.format = THREE.DepthFormat;
  gradePass.uniforms.tDepth.value = depthRT.depthTexture;

  const photo = {
    active: false,
    focusDist: 12,
    aperture: 0.6,
  };

  // sun visibility: cheap terrain occlusion march, throttled
  let visTimer = 0;
  let visibility = 1;
  const sunPosNDC = new THREE.Vector3();
  const marchDir = new THREE.Vector3();
  const marchPos = new THREE.Vector3();

  function estimateSunVisibility(state) {
    const dir = state?.sun?.dir;
    if (!dir) return 0;
    const cam = camera.position;
    marchDir.copy(dir).normalize();
    if (marchDir.y < 0.02) return 0;
    let occluded = 0;
    for (let i = 1; i <= 12; i++) {
      const t = i * 85;
      marchPos.set(cam.x + marchDir.x * t, cam.y + marchDir.y * t, cam.z + marchDir.z * t);
      const h = layout.heightAt(marchPos.x, marchPos.z);
      if (h > marchPos.y + 3) { occluded++; }
    }
    const openness = 1 - occluded / 12;
    // softer at low sun, harder at high sun
    return clamp01(openness * lerp(1.0, 0.75, clamp01(marchDir.y * 2.5)));
  }

  const tmpV = new THREE.Vector3();
  let time = 0;

  function render(dtOrTime, state) {
    const dt = typeof dtOrTime === 'number' ? Math.min(0.1, dtOrTime) : 0.016;
    time += dt;
    const s = state || null;

    if (godPass.enabled) {
      visTimer -= dt;
      if (visTimer <= 0) {
        visTimer = 0.2;
        visibility = estimateSunVisibility(s);
        const target = (s?.weather?.cloudiness ?? 0.35);
        visibility *= lerp(1.0, 0.55, clamp01(target));
      }
      if (s?.sun?.dir) {
        tmpV.copy(camera.position).addScaledVector(s.sun.dir, 4000).project(camera);
        godPass.uniforms.uSunPos.value.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5);
        godPass.uniforms.uColor.value.copy(s.sun.color);
        const strength = visibility * clamp01((s.sun.intensity ?? 2) * 0.42) * (tmpV.z < 1 ? 1 : 0);
        godPass.uniforms.uStrength.value = strength;
      }
    }

    if (bloomPass) {
      bloomPass.strength = (preset.bloomStrength ?? 0.4) * (photo.active ? 1.05 : 1.0);
    }

    const gu = gradePass.uniforms;
    gu.uTime.value = time;
    gu.uNear.value = camera.near;
    gu.uFar.value = camera.far;
    gu.uDofAmount.value = photo.active ? 1.0 : 0.0;
    gu.uFocusDist.value = photo.focusDist;
    gu.uAperture.value = photo.aperture;

    if (photo.active) {
      renderer.setRenderTarget(depthRT);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      gradePass.uniforms.tDepth.value = depthRT.depthTexture;
    }

    composer.render(dt);
    void sunPosNDC;
  }

  return {
    composer,
    passes: { renderPass, godPass, bloomPass, gradePass, outputPass, smaaPass },
    render,
    setMode(name) {
      photo.active = name === 'photo';
      gradePass.uniforms.uGrain.value = preset.grain ? (photo.active ? 0.35 : 0.6) : 0.0;
      gradePass.uniforms.uSaturation.value = photo.active ? 1.0 : 1.02;
    },
    setPhoto({ focusDist, aperture }) {
      if (typeof focusDist === 'number') photo.focusDist = focusDist;
      if (typeof aperture === 'number') photo.aperture = aperture;
    },
    setFade(v) { gradePass.uniforms.uFade.value = clamp01(v); },
    setSize(w, h) {
      composer.setSize(w, h);
      if (bloomPass) bloomPass.setSize(w, h);
      if (smaaPass) smaaPass.setSize(w, h);
      depthRT.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
      gradePass.uniforms.uResolution.value.set(w, h);
    },
    setQuality(level) {
      const p = engine.preset;
      if (godPass) godPass.enabled = !!p.godrays;
      gradePass.uniforms.uGrain.value = p.grain ? 0.6 : 0.0;
      gradePass.uniforms.uCA.value = p.chromatic ? 0.35 : 0.0;
      gradePass.uniforms.uVignette.value = p.vignette ? 1.0 : 0.0;
      if (smaaPass) smaaPass.enabled = !!p.smaa;
      if (bloomPass) bloomPass.enabled = !!p.bloom;
      void level;
    },
  };
}
