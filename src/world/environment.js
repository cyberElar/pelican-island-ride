/**
 * environment.js - the single owner of scene lighting, fog and the PMREM
 * environment map. Sun + moon directional lights follow the player so the
 * shadow frustum stays tight around the action.
 */

import * as THREE from 'three';
import { clamp01, lerp } from '../core/utils.js';

export function createEnvironment(ctx) {
  const { engine, sky } = ctx;
  const preset = engine?.preset || {};
  const scene = engine.scene;
  const renderer = engine.renderer;

  // --- lights ---
  const sun = new THREE.DirectionalLight(0xfff2dc, 3.2);
  sun.castShadow = preset.shadows !== false;
  const shadowSize = preset.shadowDistance || 110;
  sun.shadow.mapSize.set(preset.shadowMapSize || 2048, preset.shadowMapSize || 2048);
  sun.shadow.camera.left = -shadowSize;
  sun.shadow.camera.right = shadowSize;
  sun.shadow.camera.top = shadowSize;
  sun.shadow.camera.bottom = -shadowSize;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 1200;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.8;
  // softening the shadow keeps the frustum edge from showing as a hard band
  sun.shadow.intensity = 0.75;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  const moon = new THREE.DirectionalLight(0xb9ccff, 0.0);
  moon.castShadow = false;
  scene.add(moon);
  scene.add(moon.target);

  const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x63705a, 0.55);
  scene.add(hemi);

  const fill = new THREE.AmbientLight(0xffffff, 0.06);
  scene.add(fill);

  // --- fog ---
  const fogColor = new THREE.Color('#bfd6e4');
  scene.fog = new THREE.FogExp2(fogColor.getHex(), preset.fogDensity || 0.00006);

  // --- PMREM environment ---
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader?.();
  let envRT = null;
  let lastEnvHour = -999;
  let lastEnvTime = -999;
  let exposureBase = 1.06;

  function regenerateEnvironment() {
    try {
      const prev = envRT;
      envRT = pmrem.fromScene(sky.skyScene, 0.02, 0.1, 1000);
      scene.environment = envRT.texture;
      // Keep the image-based light supportive, not dominant: a full-strength
      // sky env washes out dark materials (asphalt, stone) at low sun angles.
      if (scene.environmentIntensity !== undefined) scene.environmentIntensity = 0.62;
      if (prev) prev.dispose();
    } catch (err) {
      // PMREM can fail on very limited devices; the scene still lights fine
      console.warn('PMREM generation failed', err);
    }
  }

  const tmp = new THREE.Vector3();
  // NOTE: colours need their own scratch - copying a THREE.Color into a
  // Vector3 yields undefined components (NaN fog colour → black scene).
  const fogTargetColor = new THREE.Color();
  let elapsed = 0;

  function update(dt, state) {
    elapsed += dt;
    const hour = state?.hour ?? 17.1;
    const p = sky.palette;
    const night = clamp01(p.night);

    // sun
    sun.color.copy(state?.sun?.color || p.sunColor);
    sun.intensity = Math.max(0, state?.sun?.intensity ?? p.sunIntensity);
    const anchor = state?.player?.position || state?.camera?.position || tmp.set(0, 0, 0);
    sun.target.position.set(anchor.x, anchor.y * 0.4, anchor.z);
    sun.position.set(
      anchor.x + (state?.sun?.dir?.x ?? 0.3) * 420,
      anchor.y + Math.max(30, (state?.sun?.dir?.y ?? 0.5) * 420),
      anchor.z + (state?.sun?.dir?.z ?? 0.8) * 420,
    );

    // moon: real moonlight so night stays readable
    moon.color.setHex(0xb9ccff);
    moon.intensity = 1.05 * night;
    moon.target.position.copy(sun.target.position);
    moon.position.set(
      anchor.x + (state?.moon?.dir?.x ?? -0.3) * 420,
      anchor.y + Math.max(30, (state?.moon?.dir?.y ?? 0.5) * 420),
      anchor.z + (state?.moon?.dir?.z ?? -0.8) * 420,
    );

    // ambient
    hemi.color.copy(p.zenith).lerp(new THREE.Color('#dfeaff'), 0.35);
    hemi.groundColor.setHex(0x4c5a44).multiplyScalar(clamp01(1.1 - night * 0.75));
    hemi.intensity = lerp(p.ambient * 0.85, 0.42, night);
    fill.intensity = lerp(0.16, 0.24, night);

    // fog: horizon colour, denser at dawn and in bad weather
    fogTargetColor.copy(p.horizon).lerp(p.zenith, 0.18);
    fogColor.lerp(fogTargetColor, 1 - Math.exp(-1.6 * dt));
    const weatherBoost = (state?.weather?.fogBoost || 0) + (state?.weather?.rain || 0) * 0.5;
    const dawnBoost = 1 + 0.55 * Math.exp(-Math.pow((hour - 6.2) / 1.4, 2));
    scene.fog.color.copy(fogColor);
    // Aerial perspective. The presets are tuned conservatively, which on a
    // 6 km island left the far hills as saturated as the roadside: nothing read
    // as "distant". Scaling here keeps the presets intact and gives the golden
    // hour the warm haze it needs.
    const AERIAL_PERSPECTIVE = 2.1;
    scene.fog.density = (preset.fogDensity || 0.00006) * AERIAL_PERSPECTIVE * dawnBoost * (1 + weatherBoost);

    // exposure: slightly higher at night so the world stays readable
    const targetExposure = 1.02 + night * 0.34;
    exposureBase = lerp(exposureBase, targetExposure, 1 - Math.exp(-1.1 * dt));
    renderer.toneMappingExposure = exposureBase;

    // PMREM throttle: regenerate when the hour moved enough, at most every 8 s
    if (Math.abs(hour - lastEnvHour) > 0.35 && elapsed - lastEnvTime > 8) {
      lastEnvHour = hour;
      lastEnvTime = elapsed;
      regenerateEnvironment();
    }
  }

  regenerateEnvironment();

  return {
    update,
    sun,
    moon,
    hemi,
    fill,
    fog: scene.fog,
    get environmentMap() { return envRT ? envRT.texture : null; },
    setHour() { lastEnvHour = -999; },
    dispose() {
      pmrem.dispose();
      if (envRT) envRT.dispose();
    },
  };
}
