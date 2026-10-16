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

/**
 * Hard ceiling for the drawing buffer: width * height * pixelRatio² of the
 * renderer (and therefore of every composer render target) may not exceed
 * this. It is set just above native 4K (3840x2160 = 8.29 MP) so a 4K monitor
 * at 100% scaling still renders pixel-for-pixel, while 4K at 200% scaling
 * (33 MP) or an 8K panel is clamped instead of asking for framebuffers that
 * reliably crash mid-range GPUs - and the tab.
 */
export const PIXEL_BUDGET = 8.4e6;

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
    // Ground-cover draw distance in metres (grass + flower chunks). Chunks
    // beyond it contribute sub-pixel tufts, so they are skipped - the terrain
    // splat already carries their colour at that range.
    chunkRange: 700,
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
    chunkRange: 1000,
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
    chunkRange: 1300,
    fogDensity: 0.000058,
  },
  ultra: {
    label: '极致',
    renderScale: 1.0,
    pixelRatioCap: 1.5,
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
    chunkRange: 1600,
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
    // Big windows (4K/8K panels) get one step down: the pixel budget in
    // engine.js already clamps DPR, this just avoids starting too ambitious.
    const pixels = (window.innerWidth || 0) * (window.innerHeight || 0);
    if (cores <= 4 || mem <= 4) return pixels > 8e6 ? 'low' : 'medium';
    if (pixels > 8e6) return 'medium';
    return 'high';
  } catch {
    return 'high';
  }
}
