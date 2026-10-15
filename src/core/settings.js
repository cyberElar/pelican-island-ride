/**
 * settings.js - global game constants and quality presets.
 */

export const GAME = {
  worldSize: 6000,
  waterLevel: 0,
  roadWidth: 6.5,
  dayLengthSeconds: 900,   // one full 24h cycle in 15 real minutes
  defaultSeed: 20261014,
  featherCount: 40,
  defaultHour: 16.2,       // warm late afternoon (golden hour arrives as you ride)
};

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const QUALITY_PRESETS = {
  low: {
    label: '流畅',
    renderScale: 0.72,
    pixelRatioCap: 1.0,
    shadows: false,
    shadowMapSize: 1024,
    softShadows: false,
    shadowDistance: 60,
    bloom: false,
    bloomStrength: 0.0,
    godrays: false,
    grain: false,
    vignette: true,
    chromatic: false,
    smaa: false,
    anisotropy: 1,
    terrainSegments: 224,
    heightTextureSize: 512,
    treeDensity: 0.45,
    grassDensity: 0.30,
    flowerDensity: 0.4,
    foliageShadows: false,
    animalScale: 0.45,
    particleScale: 0.35,
    oceanSegments: 96,
    cloudLayers: 1,
    viewDistance: 9000,
    fogDensity: 0.00010,
  },
  medium: {
    label: '均衡',
    renderScale: 0.85,
    pixelRatioCap: 1.25,
    shadows: true,
    shadowMapSize: 2048,
    softShadows: true,
    shadowDistance: 80,
    bloom: true,
    bloomStrength: 0.35,
    godrays: false,
    grain: true,
    vignette: true,
    chromatic: false,
    smaa: false,
    anisotropy: 4,
    terrainSegments: 320,
    heightTextureSize: 640,
    treeDensity: 0.7,
    grassDensity: 0.6,
    flowerDensity: 0.75,
    foliageShadows: false,
    animalScale: 0.7,
    particleScale: 0.7,
    oceanSegments: 128,
    cloudLayers: 2,
    viewDistance: 14000,
    fogDensity: 0.000075,
  },
  high: {
    label: '高画质',
    renderScale: 1.0,
    pixelRatioCap: 1.5,
    shadows: true,
    shadowMapSize: 3072,
    softShadows: true,
    shadowDistance: 95,
    bloom: true,
    bloomStrength: 0.42,
    godrays: true,
    grain: true,
    vignette: true,
    chromatic: true,
    smaa: true,
    anisotropy: 8,
    terrainSegments: 400,
    heightTextureSize: 768,
    treeDensity: 1.0,
    grassDensity: 1.0,
    flowerDensity: 1.0,
    foliageShadows: true,
    animalScale: 1.0,
    particleScale: 1.0,
    oceanSegments: 160,
    cloudLayers: 3,
    viewDistance: 18000,
    fogDensity: 0.000058,
  },
  ultra: {
    label: '极致',
    renderScale: 1.0,
    pixelRatioCap: 2.0,
    shadows: true,
    shadowMapSize: 4096,
    softShadows: true,
    shadowDistance: 120,
    bloom: true,
    bloomStrength: 0.45,
    godrays: true,
    grain: true,
    vignette: true,
    chromatic: true,
    smaa: true,
    anisotropy: 16,
    terrainSegments: 512,
    heightTextureSize: 1024,
    treeDensity: 1.25,
    grassDensity: 1.4,
    flowerDensity: 1.3,
    foliageShadows: true,
    animalScale: 1.25,
    particleScale: 1.35,
    oceanSegments: 200,
    cloudLayers: 3,
    viewDistance: 22000,
    fogDensity: 0.00005,
  },
};

/** Pick a sensible default preset for the current device. */
export function detectQuality() {
  try {
    const nav = navigator;
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '');
    if (mobile) return 'medium';
    const cores = nav.hardwareConcurrency || 4;
    const mem = nav.deviceMemory || 8;
    if (cores <= 4 || mem <= 4) return 'medium';
    return 'high';
  } catch {
    return 'high';
  }
}
