/**
 * textures.js - procedural texture library. Every visual asset in the game is
 * generated here at runtime: no image files, no network, no external assets.
 *
 * Public API: createTextureLibrary(quality, renderer) -> TEX   (see docs/SPEC.md §4.4)
 * Every surface factory returns { map, normalMap, roughnessMap, alphaMap?, emissiveMap?, color? }
 * and is cached by option key, so calling TEX.grass() everywhere is cheap.
 */

import * as THREE from 'three';
import { Rng, clamp01, lerp, TAU, hashStringToSeed } from './utils.js';

// ---------------------------------------------------------------------------
// Color helpers (all colors are float 0..1 sRGB triplets)
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  if (typeof hex !== 'string') return [hex, hex, hex];
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// ---------------------------------------------------------------------------
// Tileable value-noise fields
// ---------------------------------------------------------------------------

/** Seamless (tileable) fBm field, values in [0,1], size*size, wraps at size. */
export function fbmField(size, { cells = 4, octaves = 5, gain = 0.5, seed = 1, ridged = false } = {}) {
  const rng = new Rng(seed);
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, c = Math.max(2, cells | 0);
  for (let o = 0; o < octaves; o++) {
    const grid = new Float32Array(c * c);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.float();
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * c;
      const y0 = Math.floor(gy);
      const wy = gy - y0;
      const sy = wy * wy * (3 - 2 * wy);
      const y0m = ((y0 % c) + c) % c;
      const y1m = (y0m + 1) % c;
      const rowA = y0m * c;
      const rowB = y1m * c;
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * c;
        const x0 = Math.floor(gx);
        const wx = gx - x0;
        const sx = wx * wx * (3 - 2 * wx);
        const x0m = ((x0 % c) + c) % c;
        const x1m = (x0m + 1) % c;
        const v00 = grid[rowA + x0m], v10 = grid[rowA + x1m];
        const v01 = grid[rowB + x0m], v11 = grid[rowB + x1m];
        let v = lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sy);
        if (ridged) v = 1 - Math.abs(v * 2 - 1);
        out[y * size + x] += amp * v;
      }
    }
    norm += amp;
    amp *= gain;
    c *= 2;
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

// ---------------------------------------------------------------------------
// Pixel buffer + painting DSL
// ---------------------------------------------------------------------------

class Pixels {
  constructor(size) {
    this.size = size;
    const n = size * size;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n).fill(1);
  }
  idx(x, y) {
    const s = this.size;
    return (((y | 0) % s + s) % s) * s + (((x | 0) % s + s) % s);
  }
  set(x, y, c, a = 1) {
    const i = this.idx(x, y);
    this.r[i] = c[0]; this.g[i] = c[1]; this.b[i] = c[2]; this.a[i] = a;
  }
  blend(x, y, c, t) {
    if (t <= 0) return;
    t = clamp01(t);
    const i = this.idx(x, y);
    this.r[i] = lerp(this.r[i], c[0], t);
    this.g[i] = lerp(this.g[i], c[1], t);
    this.b[i] = lerp(this.b[i], c[2], t);
  }
  scale(x, y, s) {
    const i = this.idx(x, y);
    this.r[i] *= s; this.g[i] *= s; this.b[i] *= s;
  }
}

const fill = (P, hex) => {
  const c = hexToRgb(hex);
  P.r.fill(c[0]); P.g.fill(c[1]); P.b.fill(c[2]);
};

const tint = (P, field, hex, amount = 1) => {
  const c = hexToRgb(hex);
  const n = P.size * P.size;
  for (let i = 0; i < n; i++) {
    const t = field[i] * amount;
    P.r[i] = lerp(P.r[i], c[0], t);
    P.g[i] = lerp(P.g[i], c[1], t);
    P.b[i] = lerp(P.b[i], c[2], t);
  }
};

/** Multiply brightness by (1 + amount*(field-0.5)*2). */
const shade = (P, field, amount = 0.3) => {
  const n = P.size * P.size;
  for (let i = 0; i < n; i++) {
    const s = 1 + (field[i] - 0.5) * 2 * amount;
    P.r[i] *= s; P.g[i] *= s; P.b[i] *= s;
  }
};

const speckle = (P, rng, { count = 400, color = '#000000', alphaMin = 0.05, alphaMax = 0.25, radius = 2 } = {}) => {
  const c = hexToRgb(color);
  for (let i = 0; i < count; i++) {
    const x = rng.float() * P.size;
    const y = rng.float() * P.size;
    const r = rng.range(0.5, radius);
    const a = rng.range(alphaMin, alphaMax);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= r) P.blend(x + dx, y + dy, c, a * (1 - d / (r + 0.001)));
      }
    }
  }
};

const strokes = (P, rng, {
  count = 300, color = '#ffffff', alphaMin = 0.1, alphaMax = 0.4,
  lenMin = 4, lenMax = 24, width = 1, angle = 0, jitter = 0.3, curve = 0.3, taper = true,
} = {}) => {
  const c = hexToRgb(color);
  for (let i = 0; i < count; i++) {
    let x = rng.float() * P.size;
    let y = rng.float() * P.size;
    const a0 = angle + rng.range(-jitter, jitter) * Math.PI;
    const len = rng.range(lenMin, lenMax);
    const steps = Math.ceil(len);
    const bend = rng.range(-curve, curve) * 0.1;
    const baseA = rng.range(alphaMin, alphaMax);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const a = a0 + bend * s;
      x += Math.cos(a); y += Math.sin(a);
      const w = width * (taper ? (1 - t * 0.85) : 1);
      for (let k = -w; k <= w; k += 0.5) {
        P.blend(Math.round(x + k * Math.cos(a + Math.PI / 2)), Math.round(y + k * Math.sin(a + Math.PI / 2)), c, baseA * (1 - t * 0.3));
      }
    }
  }
};

/** Voronoi cobble/stone cells with mortar gaps. */
const cellsPattern = (P, rng, {
  cells = 6, palette = ['#9a9a9a'], mortar = '#6f6a63', mortarWidth = 0.04,
  jitter = 0.35, shadeAmount = 0.35, bg = '#777777',
} = {}) => {
  const size = P.size;
  const cols = cells, rows = cells;
  const siteX = new Float32Array(cols * rows), siteY = new Float32Array(cols * rows);
  const siteC = new Array(cols * rows);
  const siteS = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      siteX[i] = (c + 0.5 + (rng.float() - 0.5) * jitter * 2) / cols * size;
      siteY[i] = (r + 0.5 + (rng.float() - 0.5) * jitter * 2) / rows * size;
      siteC[i] = hexToRgb(palette[(rng.irange(0, palette.length - 1))]);
      siteS[i] = 0.85 + rng.float() * 0.3;
    }
  }
  const mc = hexToRgb(mortar);
  const cellW = size / cols, cellH = size / rows;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cc = Math.floor(x / cellW), cr = Math.floor(y / cellH);
      let d1 = 1e9, d2 = 1e9, best = -1;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = cr + dr, c2 = cc + dc;
          if (rr < 0 || c2 < 0 || rr >= rows || c2 >= cols) continue;
          const i = rr * cols + c2;
          let dx = x - siteX[i], dy = y - siteY[i];
          const d = Math.hypot(dx, dy);
          if (d < d1) { d2 = d1; d1 = d; best = i; }
          else if (d < d2) { d2 = d; }
        }
      }
      if (best < 0) { P.set(x, y, hexToRgb(bg)); continue; }
      const edge = Math.min(d2 - d1, 12) / 12;
      if (edge < mortarWidth * size / 24) {
        P.set(x, y, mc);
      } else {
        const s = siteS[best] * (0.75 + 0.5 * clamp01(edge));
        P.set(x, y, mul3(siteC[best], s));
        // inner shading towards cell edge for volume
        P.blend(x, y, [0, 0, 0], clamp01((0.35 - edge) * 1.4) * shadeAmount);
      }
    }
  }
};

/** Brick / stone block rows. */
const bricksPattern = (P, rng, {
  rows = 8, cols = 4, palette = ['#b06a4a'], mortar = '#d8cdb8', mortarPx = 2,
  offset = 0.5, jitter = 0.12, shadeAmount = 0.25,
} = {}) => {
  const size = P.size;
  const rh = size / rows, cw = size / cols;
  const mc = hexToRgb(mortar);
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / rh);
    const rowOff = (row % 2) * offset * cw;
    for (let x = 0; x < size; x++) {
      const xr = (x + rowOff) % size;
      const col = Math.floor(xr / cw);
      const fx = xr - col * cw, fy = y - row * rh;
      const inMortar = fx < mortarPx || fy < mortarPx;
      if (inMortar) { P.set(x, y, mc); continue; }
      const seed = hashStringToSeed(`${row}:${col}`);
      const rng2 = new Rng(seed);
      const base = hexToRgb(palette[rng2.irange(0, palette.length - 1)]);
      const s = 1 + (rng2.float() - 0.5) * jitter;
      const edge = clamp01(Math.min(fx - mortarPx, fy - mortarPx) / 6);
      P.set(x, y, mul3(base, s * (0.82 + 0.18 * edge)));
    }
  }
  void shadeAmount;
};

const ringsPattern = (P, { freq = 22, colorA = '#d8b378', colorB = '#8a5a34', wobble = 0.35, seed = 7 } = {}) => {
  const size = P.size, c = size / 2;
  const rng = new Rng(seed);
  const nx = rng.float() * 10, ny = rng.float() * 10;
  const ca = hexToRgb(colorA), cb = hexToRgb(colorB);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const w = Math.sin(a * 3 + nx) * wobble * 2 + Math.sin(a * 7 + ny) * wobble;
      const t = 0.5 + 0.5 * Math.sin((r + w) * (TAU * freq / size));
      P.set(x, y, mix3(cb, ca, t * 0.85 + 0.1));
    }
  }
};

const bands = (P, { freq = 6, angle = 0, colorA = '#ffffff', colorB = '#000000', softness = 0.35, warp = null, warpAmount = 0.25 } = {}) => {
  const size = P.size;
  const ca = hexToRgb(colorA), cb = hexToRgb(colorB);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let u = (x * cos + y * sin) / size;
      if (warp) u += (warp[y * size + x] - 0.5) * warpAmount;
      const t = 0.5 + 0.5 * Math.tanh(Math.sin(u * TAU * freq) / Math.max(0.05, softness));
      P.set(x, y, mix3(cb, ca, t));
    }
  }
};

// ---------------------------------------------------------------------------
// Canvas baking
// ---------------------------------------------------------------------------

function pixelsToCanvas(P) {
  const size = P.size;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = clamp01(P.r[i]) * 255;
    d[i * 4 + 1] = clamp01(P.g[i]) * 255;
    d[i * 4 + 2] = clamp01(P.b[i]) * 255;
    d[i * 4 + 3] = clamp01(P.a[i]) * 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function normalCanvasFrom(P, strength = 2.2, heightField = null) {
  const size = P.size;
  const h = heightField || (() => {
    const out = new Float32Array(size * size);
    for (let i = 0; i < out.length; i++) out[i] = (P.r[i] + P.g[i] + P.b[i]) / 3;
    return out;
  })();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function roughnessCanvasFrom(P, { min = 0.55, max = 1.0, invert = false, fromLuma = null } = {}) {
  const size = P.size;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const luma = fromLuma ? fromLuma[i] : (P.r[i] + P.g[i] + P.b[i]) / 3;
    let t = clamp01(luma);
    if (invert) t = 1 - t;
    const v = lerp(min, max, t) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// Sprite painting (2D canvas API helpers)
// ---------------------------------------------------------------------------

function spriteCanvas(size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  draw(ctx, size);
  return canvas;
}

/** Soft additive glow sprite (radial gradient). */
function glowCanvas(size, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  return spriteCanvas(size, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, 'rgba(255,246,214,0.55)');
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

function blobCanvas(size, { seed = 1, blobs = 46, blur = 7, alpha = 0.06, color = '255,255,255', spread = 0.42 } = {}) {
  return spriteCanvas(size, (ctx, s) => {
    const rng = new Rng(seed);
    ctx.filter = `blur(${blur}px)`;
    for (let i = 0; i < blobs; i++) {
      const cx = s / 2 + rng.gaussian() * s * spread * 0.5;
      const cy = s / 2 + rng.gaussian() * s * spread * 0.35;
      const r = s * rng.range(0.06, 0.18);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const a = alpha * rng.range(0.5, 1.5);
      g.addColorStop(0, `rgba(${color},${a})`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
    }
    ctx.filter = 'none';
  });
}

// ---------------------------------------------------------------------------
// Library factory
// ---------------------------------------------------------------------------

export function createTextureLibrary(quality = 'high', renderer = null) {
  const texSize = quality === 'low' ? 128 : quality === 'medium' ? 192 : quality === 'ultra' ? 320 : 256;
  const spriteSize = quality === 'low' ? 128 : 256;
  const aniso = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  const cache = new Map();
  const all = [];

  const key = (name, opts) => `${name}:${JSON.stringify(opts || {})}`;

  function texture(canvas, { repeat = 1, srgb = true, filter = THREE.LinearFilter, wrap = THREE.RepeatWrapping } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = wrap;
    const r = Array.isArray(repeat) ? repeat : [repeat, repeat];
    t.repeat.set(r[0], r[1]);
    t.anisotropy = aniso;
    t.magFilter = filter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    all.push(t);
    return t;
  }

  /**
   * Build a full surface from a paint callback.
   * paint(P, rng, size) mutates the Pixels buffer.
   */
  function surface(name, paint, {
    size = texSize, seed = 1, repeat = 1, normalStrength = 2.0, rough = { min: 0.6, max: 1.0 },
    heightFrom = null, alphaFrom = null, color = null, linearMaps = false,
  } = {}) {
    // Bake the albedo pixels once and derive albedo/normal/roughness from the
    // same deterministic buffer so all three maps stay aligned.
    const { P, canvas } = bake(name, paint, { size, seed });
    return {
      map: texture(canvas, { repeat, srgb: !linearMaps }),
      normalMap: texture(normalCanvasFrom(P, normalStrength, heightFrom ? heightFrom(P) : null), { repeat, srgb: false }),
      roughnessMap: texture(roughnessCanvasFrom(P, rough), { repeat, srgb: false }),
      ...(color ? { color } : {}),
      ...(alphaFrom ? { alphaMap: texture(alphaFrom(P), { repeat, srgb: false }) } : {}),
    };
  }

  function bake(name, paint, { size, seed }) {
    const k = `${name}@${size}:${seed}`;
    let v = cache.get(k);
    if (!v) {
      const P = new Pixels(size);
      const rng = new Rng(hashStringToSeed(`${name}:${seed}`));
      paint(P, rng, size);
      v = { P, canvas: pixelsToCanvas(P) };
      cache.set(k, v);
    }
    return v;
  }

  // -- Terrain surfaces ------------------------------------------------------

  const grassSurface = () => surface('grass', (P, rng, s) => {
    fill(P, '#6b8f4c');
    const f1 = fbmField(s, { cells: 3, octaves: 4, seed: 11 });
    const f2 = fbmField(s, { cells: 12, octaves: 3, seed: 12 });
    const f3 = fbmField(s, { cells: 48, octaves: 2, seed: 13 });
    tint(P, f1, '#86a856', 0.55);
    tint(P, f2, '#4e7a35', 0.4);
    tint(P, f3, '#c9b26a', 0.16);
    shade(P, f3, 0.18);
    strokes(P, rng, { count: 900, color: '#87b258', alphaMin: 0.06, alphaMax: 0.22, lenMin: 3, lenMax: 9, width: 0.6, angle: -Math.PI / 2, jitter: 0.45, curve: 0.2 });
    strokes(P, rng, { count: 380, color: '#3f6b2c', alphaMin: 0.05, alphaMax: 0.16, lenMin: 2, lenMax: 7, width: 0.5, angle: -Math.PI / 2, jitter: 0.5, curve: 0.3 });
    speckle(P, rng, { count: 220, color: '#d9e8a8', alphaMin: 0.05, alphaMax: 0.16, radius: 1.6 });
  }, { seed: 11, normalStrength: 1.6, rough: { min: 0.72, max: 0.95 } });

  const dryGrassSurface = () => surface('dryGrass', (P, rng, s) => {
    fill(P, '#b7a45f');
    const f1 = fbmField(s, { cells: 4, octaves: 4, seed: 21 });
    const f2 = fbmField(s, { cells: 24, octaves: 3, seed: 22 });
    tint(P, f1, '#8a9a4d', 0.5);
    tint(P, f2, '#d6c67e', 0.45);
    shade(P, f2, 0.2);
    strokes(P, rng, { count: 800, color: '#e0d194', alphaMin: 0.08, alphaMax: 0.25, lenMin: 4, lenMax: 12, width: 0.6, angle: -Math.PI / 2, jitter: 0.35, curve: 0.4 });
  }, { seed: 21, rough: { min: 0.8, max: 1.0 } });

  const sandSurface = () => surface('sand', (P, rng, s) => {
    fill(P, '#e8d5a8');
    const f1 = fbmField(s, { cells: 5, octaves: 4, seed: 31 });
    const f2 = fbmField(s, { cells: 40, octaves: 2, seed: 32 });
    tint(P, f1, '#cbb98c', 0.5);
    tint(P, f2, '#f4e8c8', 0.4);
    // wind ripples
    const ripple = fbmField(s, { cells: 6, octaves: 2, seed: 33 });
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = Math.sin((x * 0.9 + y * 0.35) * 0.35 + (ripple[y * s + x] - 0.5) * 6) * 0.5 + 0.5;
        P.blend(x, y, [0.78, 0.7, 0.52], v * 0.12);
      }
    }
    speckle(P, rng, { count: 700, color: '#fff6dd', alphaMin: 0.1, alphaMax: 0.35, radius: 1.2 });
    speckle(P, rng, { count: 260, color: '#9d8a63', alphaMin: 0.06, alphaMax: 0.2, radius: 1.4 });
  }, { seed: 31, normalStrength: 1.2, rough: { min: 0.75, max: 1.0 } });

  const rockSurface = () => surface('rock', (P, rng, s) => {
    fill(P, '#8a8f96');
    const f1 = fbmField(s, { cells: 4, octaves: 5, seed: 41 });
    const f2 = fbmField(s, { cells: 16, octaves: 4, seed: 42, ridged: true });
    const f3 = fbmField(s, { cells: 64, octaves: 2, seed: 43 });
    tint(P, f1, '#6d7278', 0.55);
    tint(P, f2, '#a8a29a', 0.5);
    tint(P, f3, '#5b5f66', 0.3);
    // crack lines from ridged field
    for (let i = 0; i < s * s; i++) {
      if (f2[i] > 0.86) { const k = (f2[i] - 0.86) / 0.14; P.r[i] *= 1 - k * 0.5; P.g[i] *= 1 - k * 0.5; P.b[i] *= 1 - k * 0.5; }
    }
    speckle(P, rng, { count: 300, color: '#b9bcc0', alphaMin: 0.08, alphaMax: 0.25, radius: 2 });
    speckle(P, rng, { count: 200, color: '#4c4f55', alphaMin: 0.08, alphaMax: 0.22, radius: 1.6 });
  }, { seed: 41, normalStrength: 3.0, rough: { min: 0.75, max: 1.0 } });

  const cliffSurface = () => surface('cliff', (P, rng, s) => {
    fill(P, '#a08c78');
    const f1 = fbmField(s, { cells: 3, octaves: 5, seed: 51 });
    const strata = fbmField(s, { cells: 2, octaves: 2, seed: 52 });
    tint(P, f1, '#8d7a66', 0.6);
    for (let y = 0; y < s; y++) {
      const band = 0.5 + 0.5 * Math.sin(y * 0.22 + (strata[y * s] - 0.5) * 4);
      for (let x = 0; x < s; x++) {
        P.blend(x, y, band > 0.5 ? [0.72, 0.62, 0.5] : [0.55, 0.5, 0.46], Math.abs(band - 0.5) * 0.5);
      }
    }
    strokes(P, rng, { count: 260, color: '#5d5548', alphaMin: 0.1, alphaMax: 0.3, lenMin: s * 0.4, lenMax: s * 1.2, width: 0.8, angle: Math.PI / 2.1, jitter: 0.06, curve: 0.05 });
    shade(P, fbmField(s, { cells: 96, octaves: 2, seed: 53 }), 0.2);
  }, { seed: 51, normalStrength: 3.2, rough: { min: 0.8, max: 1.0 } });

  const snowSurface = () => surface('snow', (P, rng, s) => {
    fill(P, '#eef3fa');
    const f1 = fbmField(s, { cells: 4, octaves: 4, seed: 61 });
    const f2 = fbmField(s, { cells: 32, octaves: 2, seed: 62 });
    tint(P, f1, '#d4e2f2', 0.6);
    tint(P, f2, '#ffffff', 0.4);
    speckle(P, rng, { count: 500, color: '#ffffff', alphaMin: 0.2, alphaMax: 0.6, radius: 1 });
  }, { seed: 61, normalStrength: 0.9, rough: { min: 0.5, max: 0.8 } });

  const dirtSurface = () => surface('dirt', (P, rng, s) => {
    fill(P, '#7c6246');
    const f1 = fbmField(s, { cells: 5, octaves: 4, seed: 71 });
    const f2 = fbmField(s, { cells: 28, octaves: 3, seed: 72 });
    tint(P, f1, '#5f4b36', 0.55);
    tint(P, f2, '#94795a', 0.5);
    shade(P, f2, 0.25);
    speckle(P, rng, { count: 420, color: '#b39d7e', alphaMin: 0.08, alphaMax: 0.25, radius: 1.5 });
    speckle(P, rng, { count: 220, color: '#453425', alphaMin: 0.1, alphaMax: 0.3, radius: 1.2 });
  }, { seed: 71, normalStrength: 1.6, rough: { min: 0.85, max: 1.0 } });

  const gravelSurface = () => surface('gravel', (P, rng, s) => {
    fill(P, '#9a938a');
    const f1 = fbmField(s, { cells: 40, octaves: 3, seed: 81 });
    tint(P, f1, '#7d766c', 0.6);
    // dozens of pebbles
    for (let i = 0; i < 900; i++) {
      const x = rng.float() * s, y = rng.float() * s;
      const r = rng.range(0.8, 2.6);
      const shadeV = rng.range(0.6, 1.25);
      const col = mul3(hexToRgb(rng.pick(['#a8a29a', '#8b857c', '#b5ada1', '#6f6960'])), shadeV);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy);
          if (d <= r) P.blend(x + dx, y + dy, col, 1 - (d / r) * 0.15);
        }
      }
    }
    shade(P, fbmField(s, { cells: 80, octaves: 2, seed: 82 }), 0.22);
  }, { seed: 81, normalStrength: 2.6, rough: { min: 0.85, max: 1.0 } });

  const asphaltSurface = () => surface('asphalt', (P, rng, s) => {
    fill(P, '#4b4d50');
    const f1 = fbmField(s, { cells: 4, octaves: 4, seed: 91 });
    const f2 = fbmField(s, { cells: 60, octaves: 3, seed: 92 });
    tint(P, f1, '#3d3f42', 0.6);
    tint(P, f2, '#5c5e61', 0.55);
    speckle(P, rng, { count: 1400, color: '#6a6c70', alphaMin: 0.06, alphaMax: 0.22, radius: 1 });
    speckle(P, rng, { count: 500, color: '#2f3134', alphaMin: 0.08, alphaMax: 0.3, radius: 1.3 });
    strokes(P, rng, { count: 20, color: '#3a3c3f', alphaMin: 0.05, alphaMax: 0.14, lenMin: s * 0.4, lenMax: s, width: 1.6, angle: 0, jitter: 3.1, curve: 0.02 });
  }, { seed: 91, normalStrength: 1.1, rough: { min: 0.68, max: 0.92 } });

  /**
   * The road ribbon's complete surface: asphalt plus baked markings.
   * One tile = 9 m along the road (u) x the full 6.5 m width (v), so the
   * dashes and edge lines come from the texture instead of extra meshes
   * (fragile thin geometry caused visible artifacts).
   */
  const roadSurface = () => surface('roadSurface', (P, rng, s) => {
    fill(P, '#4b4d50');
    const f1 = fbmField(s, { cells: 4, octaves: 4, seed: 191 });
    const f2 = fbmField(s, { cells: 52, octaves: 3, seed: 192 });
    tint(P, f1, '#3d3f42', 0.6);
    tint(P, f2, '#5c5e61', 0.5);
    speckle(P, rng, { count: 1200, color: '#6a6c70', alphaMin: 0.05, alphaMax: 0.2, radius: 1 });
    speckle(P, rng, { count: 400, color: '#2f3134', alphaMin: 0.07, alphaMax: 0.26, radius: 1.3 });
    const paint = hexToRgb('#f2efe6');
    const lineHalf = Math.max(1, Math.round(s * 0.013));
    const cx = s * 0.5;
    // continuous edge lines at v = 0.05 / 0.95
    for (const v of [0.052, 0.948]) {
      const y0 = Math.round(v * s);
      for (let y = y0 - lineHalf; y <= y0 + lineHalf; y++) {
        for (let x = 0; x < s; x++) P.blend(x, y, paint, 0.88);
      }
    }
    // centre dashes: 3.2 m of the 9 m tile, worn edges
    const dashLen = Math.round(s * (3.2 / 9));
    for (let x = 0; x < dashLen; x++) {
      const wear = 0.72 + 0.2 * Math.sin(x * 0.35) * f2[(x * 7) % (s * s)] * 2;
      for (let y = cx - lineHalf; y <= cx + lineHalf; y++) P.blend(x, y, paint, wear);
    }
    // subtle tyre wear bands where wheels run
    for (const v of [0.30, 0.70]) {
      const y0 = Math.round(v * s);
      for (let y = y0 - lineHalf * 5; y <= y0 + lineHalf * 5; y++) {
        for (let x = 0; x < s; x++) P.blend(x, y, [0.22, 0.23, 0.25], 0.18);
      }
    }
  }, { seed: 191, normalStrength: 1.0, rough: { min: 0.66, max: 0.9 } });

  const cobbleSurface = () => surface('cobble', (P, rng) => {
    cellsPattern(P, rng, {
      cells: 8, palette: ['#9d968b', '#8b857b', '#a8a094', '#77716a', '#b0a99d'],
      mortar: '#6b665e', mortarWidth: 0.05, jitter: 0.32, shadeAmount: 0.5,
    });
    shade(P, fbmField(P.size, { cells: 64, octaves: 2, seed: 101 }), 0.18);
    speckle(P, rng, { count: 300, color: '#c4bdb2', alphaMin: 0.05, alphaMax: 0.18, radius: 1.5 });
  }, { seed: 101, normalStrength: 3.0, rough: { min: 0.8, max: 1.0 } });

  const stoneWallSurface = () => surface('stoneWall', (P, rng, s) => {
    bricksPattern(P, rng, { rows: 10, cols: 4, palette: ['#a99c88', '#94897a', '#b7ab97', '#8a8171', '#c0b6a2'], mortar: '#776f62', mortarPx: 2, jitter: 0.18 });
    shade(P, fbmField(s, { cells: 48, octaves: 2, seed: 111 }), 0.16);
    speckle(P, rng, { count: 260, color: '#d9d2c4', alphaMin: 0.05, alphaMax: 0.15, radius: 1.4 });
  }, { seed: 111, normalStrength: 2.8, rough: { min: 0.85, max: 1.0 } });

  const plasterSurface = (hex = '#f0e4cd') => surface(`plaster:${hex}`, (P, rng, s) => {
    fill(P, hex);
    const f1 = fbmField(s, { cells: 5, octaves: 4, seed: 121 });
    const f2 = fbmField(s, { cells: 40, octaves: 3, seed: 122 });
    tint(P, f1, '#d9c9ab', 0.25);
    tint(P, f2, '#fff8ec', 0.3);
    // chalky stains
    for (let i = 0; i < 12; i++) {
      const x = rng.float() * s, y = rng.float() * s, r = rng.range(s * 0.05, s * 0.18);
      const g = hexToRgb(rng.pick(['#cbbfa6', '#e3d7bd', '#c2b49a']));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy) / r;
          if (d < 1) P.blend(x + dx, y + dy, g, (1 - d) * 0.25);
        }
      }
    }
    shade(P, f2, 0.06);
  }, { seed: 121, normalStrength: 0.9, rough: { min: 0.75, max: 0.95 } });

  const roofTileSurface = (hex = '#b4603f') => surface(`roofTile:${hex}`, (P, rng, s) => {
    fill(P, '#5a4638');
    const base = hexToRgb(hex);
    const rows = 9, cols = 16;
    const rh = s / rows, cw = s / cols;
    for (let y = 0; y < s; y++) {
      const row = Math.floor(y / rh);
      const rowOff = (row % 2) * cw * 0.5;
      for (let x = 0; x < s; x++) {
        const xr = (x + rowOff) % s;
        const col = Math.floor(xr / cw);
        const fx = (xr - col * cw) / cw;
        const fy = (y - row * rh) / rh;
        const rng2 = new Rng(hashStringToSeed(`${row}:${col}`));
        const shadeV = 1 + (rng2.float() - 0.5) * 0.35;
        // barrel profile: dark at edges, light in middle
        const prof = Math.sin(fx * Math.PI);
        const c = mul3(base, (0.55 + 0.65 * prof) * shadeV);
        P.set(x, y, c);
        // tile bottom shadow lip
        if (fy > 0.88) P.blend(x, y, [0.1, 0.07, 0.05], (fy - 0.88) / 0.12 * 0.6);
      }
    }
    tint(P, fbmField(s, { cells: 26, octaves: 3, seed: 131 }), '#3d2f26', 0.18);
    speckle(P, rng, { count: 500, color: '#7a6a56', alphaMin: 0.05, alphaMax: 0.2, radius: 1.6 });
  }, { seed: 131, normalStrength: 2.4, rough: { min: 0.8, max: 1.0 } });

  const terracottaSurface = () => surface('terracotta', (P, rng, s) => {
    fill(P, '#c06d47');
    const f1 = fbmField(s, { cells: 6, octaves: 4, seed: 141 });
    tint(P, f1, '#a45536', 0.5);
    tint(P, fbmField(s, { cells: 30, octaves: 3, seed: 142 }), '#d98a5c', 0.4);
    shade(P, fbmField(s, { cells: 64, octaves: 2, seed: 143 }), 0.14);
    speckle(P, rng, { count: 300, color: '#7d3d26', alphaMin: 0.08, alphaMax: 0.2, radius: 1.3 });
  }, { seed: 141, normalStrength: 1.4, rough: { min: 0.82, max: 1.0 } });

  const woodSurface = (opts = {}) => {
    const o = typeof opts === 'string' ? { tone: opts } : opts;
    const tone = o.tone || '#7a5230';
    const dark = o.dark || '#4e3722';
    return surface(`wood:${tone}`, (P, rng, s) => {
      fill(P, tone);
      const grain = fbmField(s, { cells: 3, octaves: 4, seed: 151 });
      const fine = fbmField(s, { cells: 60, octaves: 2, seed: 152 });
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const g = grain[y * s + x];
          const t = 0.5 + 0.5 * Math.sin((x * 0.5 + g * 18 + Math.sin(y * 0.07) * 3) * 0.55);
          P.blend(x, y, hexToRgb(dark), t * 0.32);
        }
      }
      tint(P, fine, '#ffffff', 0.06);
      strokes(P, rng, { count: 40, color: '#31210f', alphaMin: 0.06, alphaMax: 0.16, lenMin: s * 0.3, lenMax: s * 0.9, width: 0.7, angle: 0, jitter: 0.05, curve: 0.06 });
    }, { seed: 151, normalStrength: 1.4, rough: { min: 0.6, max: 0.9 } });
  };

  const planksSurface = (o = {}) => {
    const tone = o.tone || '#8a6a42';
    return surface(`planks:${tone}`, (P, rng, s) => {
      const boards = 6;
      const bh = s / boards;
      fill(P, tone);
      for (let b = 0; b < boards; b++) {
        const rng2 = new Rng(1000 + b);
        const shadeV = 0.85 + rng2.float() * 0.3;
        const base = mul3(hexToRgb(tone), shadeV);
        const grain = fbmField(s, { cells: 3, octaves: 3, seed: 160 + b });
        for (let y = b * bh; y < (b + 1) * bh; y++) {
          for (let x = 0; x < s; x++) {
            const g = grain[(y % s) * s + x];
            let c = mul3(base, 0.85 + 0.3 * g);
            const t = 0.5 + 0.5 * Math.sin(x * 0.35 + g * 10);
            c = mix3(c, hexToRgb('#3f2c1a'), t * 0.18);
            P.set(x, y, c);
          }
        }
        // seam
        for (let x = 0; x < s; x++) {
          P.blend(x, Math.round(b * bh), [0.14, 0.1, 0.06], 0.8);
          P.blend(x, Math.round(b * bh) + 1, [0.3, 0.22, 0.14], 0.5);
        }
        // nail heads
        for (const nx of [s * 0.12, s * 0.88]) {
          const ny = b * bh + bh * 0.5;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const d = Math.hypot(dx, dy);
            if (d <= 2) P.blend(nx + dx, ny + dy, [0.3, 0.32, 0.34], (1 - d / 2.4));
          }
        }
      }
    }, { seed: 161, normalStrength: 1.6, rough: { min: 0.62, max: 0.92 } });
  };

  const barkSurface = () => surface('bark', (P, rng, s) => {
    fill(P, '#5c4630');
    const f1 = fbmField(s, { cells: 3, octaves: 4, seed: 171 });
    const f2 = fbmField(s, { cells: 40, octaves: 2, seed: 172 });
    tint(P, f1, '#463424', 0.5);
    tint(P, f2, '#77593a', 0.4);
    strokes(P, rng, { count: 140, color: '#2f2317', alphaMin: 0.15, alphaMax: 0.45, lenMin: s * 0.25, lenMax: s * 0.9, width: 1.1, angle: Math.PI / 2, jitter: 0.06, curve: 0.08 });
    strokes(P, rng, { count: 90, color: '#8a6b46', alphaMin: 0.08, alphaMax: 0.25, lenMin: s * 0.15, lenMax: s * 0.6, width: 0.7, angle: Math.PI / 2, jitter: 0.1, curve: 0.05 });
  }, { seed: 171, normalStrength: 3.2, rough: { min: 0.85, max: 1.0 } });

  const logEndSurface = () => surface('logEnd', (P, rng) => {
    ringsPattern(P, { freq: 9, colorA: '#c8a06a', colorB: '#7c5836', wobble: 0.5, seed: 181 });
    const s = P.size;
    // radial cracks
    for (let i = 0; i < 5; i++) {
      const a = rng.float() * TAU;
      for (let r = s * 0.1; r < s * 0.5; r += 0.5) {
        const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
        P.blend(x, y, [0.2, 0.13, 0.08], 0.5);
      }
    }
  }, { seed: 181, normalStrength: 1.6, rough: { min: 0.7, max: 0.95 } });

  const thatchSurface = () => surface('thatch', (P, rng, s) => {
    fill(P, '#b99a5e');
    const f1 = fbmField(s, { cells: 4, octaves: 3, seed: 191 });
    tint(P, f1, '#8f7442', 0.45);
    strokes(P, rng, { count: 2600, color: '#d8bd83', alphaMin: 0.06, alphaMax: 0.28, lenMin: 6, lenMax: 22, width: 0.55, angle: Math.PI / 2, jitter: 0.25, curve: 0.25 });
    strokes(P, rng, { count: 900, color: '#6f5a32', alphaMin: 0.06, alphaMax: 0.2, lenMin: 5, lenMax: 16, width: 0.5, angle: Math.PI / 2, jitter: 0.3, curve: 0.2 });
    // horizontal course shadows
    for (let y = 0; y < s; y++) {
      const course = Math.sin(y * 0.5) * 0.5 + 0.5;
      const k = Math.pow(course, 6);
      for (let x = 0; x < s; x++) P.blend(x, y, [0.25, 0.18, 0.1], k * 0.3);
    }
  }, { seed: 191, normalStrength: 2.6, rough: { min: 0.88, max: 1.0 } });

  const haySurface = () => surface('hay', (P, rng, s) => {
    fill(P, '#d8bd71');
    const f1 = fbmField(s, { cells: 5, octaves: 3, seed: 201 });
    tint(P, f1, '#b89b4e', 0.5);
    strokes(P, rng, { count: 2400, color: '#eddc9a', alphaMin: 0.06, alphaMax: 0.3, lenMin: 5, lenMax: 18, width: 0.5, angle: 0, jitter: 3.14, curve: 0.35 });
    strokes(P, rng, { count: 800, color: '#8a7133', alphaMin: 0.06, alphaMax: 0.22, lenMin: 4, lenMax: 12, width: 0.5, angle: 0, jitter: 3.14, curve: 0.3 });
    shade(P, fbmField(s, { cells: 32, octaves: 2, seed: 202 }), 0.16);
  }, { seed: 201, normalStrength: 1.8, rough: { min: 0.85, max: 1.0 } });

  const metalSurface = (o = {}) => {
    const color = o.color || '#c9ccd2';
    const rough = o.rough !== undefined ? o.rough : 0.35;
    return surface(`metal:${color}:${rough}`, (P, rng, s) => {
      fill(P, color);
      const f1 = fbmField(s, { cells: 8, octaves: 3, seed: 211 });
      tint(P, f1, '#8f949c', 0.25);
      strokes(P, rng, { count: 500, color: '#ffffff', alphaMin: 0.02, alphaMax: 0.09, lenMin: 8, lenMax: 40, width: 0.5, angle: 0.06, jitter: 0.03, curve: 0 });
      strokes(P, rng, { count: 120, color: '#61656c', alphaMin: 0.04, alphaMax: 0.12, lenMin: 6, lenMax: 28, width: 0.5, angle: 0.06, jitter: 0.05, curve: 0 });
      speckle(P, rng, { count: 60, color: '#6d7177', alphaMin: 0.06, alphaMax: 0.18, radius: 1.2 });
    }, { seed: 211, normalStrength: 0.6, rough: { min: rough * 0.8, max: Math.min(1, rough * 1.4) } });
  };

  const paintedMetalSurface = (hex = '#1f6f78') => surface(`painted:${hex}`, (P, rng, s) => {
    fill(P, hex);
    tint(P, fbmField(s, { cells: 10, octaves: 3, seed: 221 }), '#000000', 0.08);
    tint(P, fbmField(s, { cells: 40, octaves: 2, seed: 222 }), '#ffffff', 0.08);
    // subtle scratches showing primer
    strokes(P, rng, { count: 60, color: '#cfc8bd', alphaMin: 0.03, alphaMax: 0.1, lenMin: 4, lenMax: 26, width: 0.5, angle: 0, jitter: 3.1, curve: 0.02 });
  }, { seed: 221, normalStrength: 0.5, rough: { min: 0.35, max: 0.6 } });

  const fabricSurface = (o = {}) => {
    const color = o.color || '#f2e8d5';
    const stripeColor = o.stripeColor || null;
    const stripeFreq = o.stripeFreq || 3;
    return surface(`fabric:${color}:${stripeColor}:${stripeFreq}`, (P, rng, s) => {
      fill(P, color);
      // weave: fine alternating warp/weft shading
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const w = ((x + y) % 4 < 2) ? 0.06 : -0.06;
          const w2 = (x % 2 === 0 ? 1 : -1) * 0.03;
          P.blend(x, y, w > 0 ? [1, 1, 1] : [0, 0, 0], Math.abs(w) + Math.abs(w2));
        }
      }
      if (stripeColor) {
        const sc = hexToRgb(stripeColor);
        const stripeW = s / stripeFreq;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const xm = x % stripeW;
            const band = Math.floor(x / stripeW);
            if (band % 2 === 0) {
              const edge = Math.min(xm, stripeW - xm);
              P.blend(x, y, sc, clamp01(0.6 + edge * 0.15));
            }
          }
        }
      }
      tint(P, fbmField(s, { cells: 24, octaves: 2, seed: 231 }), '#000000', 0.05);
    }, { seed: 231, normalStrength: 0.8, rough: { min: 0.7, max: 0.95 } });
  };

  const leatherSurface = () => surface('leather', (P, rng, s) => {
    fill(P, '#6b4a2f');
    const f1 = fbmField(s, { cells: 60, octaves: 2, seed: 241 });
    tint(P, f1, '#4a3220', 0.3);
    // pebble grain
    for (let i = 0; i < 2200; i++) {
      const x = rng.float() * s, y = rng.float() * s, r = rng.range(1, 3);
      const v = rng.range(0.85, 1.15);
      for (let dy = -r; dy <= r; dy += 0.5) for (let dx = -r; dx <= r; dx += 0.5) {
        if (Math.hypot(dx, dy) <= r) P.blend(x + dx, y + dy, v > 1 ? [0.62, 0.46, 0.3] : [0.35, 0.24, 0.15], 0.25);
      }
    }
  }, { seed: 241, normalStrength: 1.6, rough: { min: 0.55, max: 0.85 } });

  const ropeSurface = () => surface('rope', (P, rng, s) => {
    fill(P, '#a98753');
    const strands = 4;
    const sh = s / strands;
    for (let i = 0; i < strands; i++) {
      const base = mul3(hexToRgb('#a98753'), 0.85 + (i % 2) * 0.18);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const k = ((x + y * 3.2) % (s / 3)) / (s / 3);
          const v = Math.sin(k * TAU) * 0.5 + 0.5;
          P.set(x, y, mix3(base, hexToRgb('#6f552f'), v * 0.5));
        }
      }
    }
    shade(P, fbmField(s, { cells: 30, octaves: 2, seed: 251 }), 0.2);
    void rng;
  }, { seed: 251, normalStrength: 2.4, rough: { min: 0.85, max: 1.0 } });

  const wickerSurface = () => surface('wicker', (P, rng, s) => {
    fill(P, '#b98e52');
    const cell = s / 12;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        const horiz = ((cx + cy) % 2) === 0;
        const u = horiz ? (x % cell) / cell : (y % cell) / cell;
        const prof = Math.sin(u * Math.PI);
        const base = horiz ? hexToRgb('#c49a5e') : hexToRgb('#a67e46');
        P.set(x, y, mul3(base, 0.6 + prof * 0.6));
      }
    }
    shade(P, fbmField(s, { cells: 20, octaves: 2, seed: 261 }), 0.16);
    speckle(P, rng, { count: 200, color: '#7d5c30', alphaMin: 0.05, alphaMax: 0.15, radius: 1.2 });
  }, { seed: 261, normalStrength: 2.4, rough: { min: 0.85, max: 1.0 } });

  const kiteFabricSurface = () => surface('kiteFabric', (P, rng, s) => {
    fill(P, '#e8b64c');
    bands(P, { freq: 6, angle: Math.PI / 5, colorA: '#e0523f', colorB: '#f2e8d5', softness: 0.35 });
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = (x * 0.7071 - y * 0.7071) / s;
        if ((Math.floor(((u % 1) + 1) * 2) % 2) === 0) P.blend(x, y, hexToRgb('#1f6f78'), 0.35);
      }
    }
    tint(P, fbmField(s, { cells: 40, octaves: 2, seed: 271 }), '#000000', 0.06);
  }, { seed: 271, normalStrength: 0.4, rough: { min: 0.6, max: 0.8 } });

  // -- Special maps ----------------------------------------------------------

  const waterNormalSurface = () => surface('waterNormal', (P, rng, s) => {
    const f1 = fbmField(s, { cells: 8, octaves: 4, seed: 281 });
    const f2 = fbmField(s, { cells: 26, octaves: 3, seed: 282 });
    for (let i = 0; i < s * s; i++) {
      const v = f1[i] * 0.6 + f2[i] * 0.4;
      P.r[i] = P.g[i] = P.b[i] = v;
    }
    void rng;
  }, { seed: 281, normalStrength: 0.9, rough: { min: 0.05, max: 0.2 }, linearMaps: true });

  const foamSurface = () => {
    let memo = foamSurface._memo;
    if (!memo) {
      const s = texSize;
      const P = new Pixels(s);
      const f1 = fbmField(s, { cells: 10, octaves: 4, seed: 291 });
      const f2 = fbmField(s, { cells: 40, octaves: 3, seed: 292 });
      for (let i = 0; i < s * s; i++) {
        const v = clamp01(f1[i] * 0.55 + f2[i] * 0.45);
        const a = clamp01((v - 0.45) * 2.6);
        P.r[i] = P.g[i] = P.b[i] = 1;
        P.a[i] = a;
      }
      const canvas = pixelsToCanvas(P);
      const alphaCanvas = document.createElement('canvas');
      alphaCanvas.width = alphaCanvas.height = s;
      const ctx = alphaCanvas.getContext('2d');
      const img = ctx.createImageData(s, s);
      for (let i = 0; i < P.a.length; i++) {
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = P.a[i] * 255;
      }
      ctx.putImageData(img, 0, 0);
      memo = { map: texture(canvas, { repeat: 1 }), alphaMap: texture(alphaCanvas, { repeat: 1, srgb: false }) };
      foamSurface._memo = memo;
    }
    return memo;
  };

  // -- Sprite / alpha textures ------------------------------------------------

  const cloudSpriteCanvas = () => bakeSprite('cloudSprite', () => {
    const s = spriteSize;
    const c = blobCanvas(s, { seed: 301, blobs: 60, blur: 9, alpha: 0.05, spread: 0.5 });
    const ctx = c.getContext('2d');
    ctx.globalCompositeOperation = 'source-atop';
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, 'rgba(255,252,246,0.95)');
    g.addColorStop(0.6, 'rgba(240,238,236,0.9)');
    g.addColorStop(1, 'rgba(190,195,205,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return c;
  });

  const smokeSpriteCanvas = () => bakeSprite('smokeSprite', () => blobCanvas(spriteSize, { seed: 311, blobs: 40, blur: 10, alpha: 0.09, spread: 0.3 }));
  const starSpriteCanvas = () => bakeSprite('starSprite', () => spriteCanvas(spriteSize, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,250,235,0.9)');
    g.addColorStop(0.4, 'rgba(255,240,210,0.18)');
    g.addColorStop(1, 'rgba(255,235,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(c - Math.cos(a) * c * 0.9, c - Math.sin(a) * c * 0.9);
      ctx.lineTo(c + Math.cos(a) * c * 0.9, c + Math.sin(a) * c * 0.9);
      ctx.stroke();
    }
  }));
  const sparkSpriteCanvas = () => bakeSprite('sparkSprite', () => glowCanvas(spriteSize, 'rgba(255,255,255,0.95)'));

  const leafSpriteCanvas = (kind = 'broadleaf', seed = 321) => bakeSprite(`leaf:${kind}:${seed}`, () => spriteCanvas(spriteSize, (ctx, s) => {
    const rng = new Rng(seed);
    const c = s / 2;
    ctx.translate(c, c);
    if (kind === 'pine') {
      ctx.strokeStyle = '#3f6b3a';
      for (let i = 0; i < 60; i++) {
        const a = rng.float() * TAU;
        const len = s * rng.range(0.18, 0.46);
        ctx.strokeStyle = `rgba(${Math.round(rng.range(40, 80))},${Math.round(rng.range(90, 130))},${Math.round(rng.range(50, 90))},${rng.range(0.55, 0.95)})`;
        ctx.lineWidth = rng.range(0.8, 2.2);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * s * 0.03, Math.sin(a) * s * 0.03);
        ctx.quadraticCurveTo(Math.cos(a) * len * 0.6 + rng.range(-4, 4), Math.sin(a) * len * 0.6 + rng.range(-4, 4), Math.cos(a) * len, Math.sin(a) * len);
        ctx.stroke();
      }
      return;
    }
    // broadleaf-ish: draw a handful of leaves arranged in a rosette
    const leaves = kind === 'palm' ? 7 : 5;
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * TAU + rng.range(-0.15, 0.15);
      ctx.save();
      ctx.rotate(a);
      const L = s * rng.range(0.3, 0.44);
      const W = L * (kind === 'palm' ? 0.16 : rng.range(0.32, 0.44));
      const hue = rng.range(0, 1) < 0.35 ? '#4c7a3c' : '#63954a';
      const g = ctx.createLinearGradient(0, -W, 0, W);
      g.addColorStop(0, hue);
      g.addColorStop(1, '#3c5f2e');
      ctx.fillStyle = g;
      ctx.beginPath();
      if (kind === 'palm') {
        ctx.moveTo(0, -2);
        ctx.quadraticCurveTo(L * 0.5, -s * 0.09, L, 0);
        ctx.quadraticCurveTo(L * 0.5, s * 0.09, 0, 2);
        ctx.fill();
        // leaflets
        ctx.strokeStyle = 'rgba(40,70,35,0.7)';
        ctx.lineWidth = 0.8;
        for (let k = 0; k < 18; k++) {
          const t = k / 18;
          const x = L * t;
          const w = Math.sin(t * Math.PI) * s * 0.06;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 3, -w); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 3, w); ctx.stroke();
        }
      } else {
        ctx.moveTo(0, W * 0.2);
        ctx.bezierCurveTo(L * 0.3, -W * 1.1, L * 0.8, -W * 0.9, L, 0);
        ctx.bezierCurveTo(L * 0.8, W * 0.9, L * 0.3, W * 1.1, 0, W * 0.2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(35,55,25,0.55)';
        ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(0, W * 0.15); ctx.lineTo(L * 0.95, 0); ctx.stroke();
        for (let k = 0; k < 6; k++) {
          const t = 0.15 + k * 0.14;
          ctx.beginPath();
          ctx.moveTo(L * t, W * 0.15 * (1 - t));
          ctx.lineTo(L * (t + 0.1), W * 0.5 * (1 - t));
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }));

  const grassBladeSpriteCanvas = () => bakeSprite('grassBlade', () => spriteCanvas(spriteSize, (ctx, s) => {
    const rng = new Rng(331);
    for (let i = 0; i < 26; i++) {
      const x0 = s * (0.15 + rng.float() * 0.7);
      const h = s * rng.range(0.35, 0.85);
      const bend = rng.range(-s * 0.18, s * 0.18);
      const w = rng.range(1.2, 2.6);
      const g = ctx.createLinearGradient(0, s, 0, s - h);
      const c1 = rng.pick(['#5f8f3f', '#6f9e4a', '#7fae57', '#c9b26a']);
      g.addColorStop(0, '#3f5f2b');
      g.addColorStop(0.5, c1);
      g.addColorStop(1, '#a8c46a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0 - w, s);
      ctx.quadraticCurveTo(x0 - w * 0.5 + bend * 0.5, s - h * 0.6, x0 + bend, s - h);
      ctx.quadraticCurveTo(x0 + w * 0.5 + bend * 0.5, s - h * 0.6, x0 + w, s);
      ctx.fill();
    }
  }));

  const flowerSpriteCanvas = (kind = 'poppy', seed = 341) => bakeSprite(`flower:${kind}:${seed}`, () => spriteCanvas(spriteSize, (ctx, s) => {
    const rng = new Rng(seed);
    const c = s * 0.5;
    const petals = { poppy: 4, daisy: 12, cornflower: 8, mustard: 4, lupine: 5, tulip: 3 }[kind] || 6;
    const petalColor = {
      poppy: '#e0523f', daisy: '#f7f4ea', cornflower: '#5b7fd4',
      mustard: '#e8b64c', lupine: '#8a6fd4', tulip: '#e05a7a',
    }[kind] || '#ffffff';
    const centerColor = { poppy: '#3a2c22', daisy: '#e8b64c', cornflower: '#2f3f7a', mustard: '#8a6a2f', lupine: '#5f4a2a', tulip: '#e8b64c' }[kind] || '#e8b64c';
    if (kind === 'lupine') {
      // vertical raceme of small blossoms
      for (let i = 0; i < 22; i++) {
        const t = i / 22;
        const y = s * 0.92 - t * s * 0.8;
        const r = s * (0.02 + 0.05 * (1 - t));
        ctx.fillStyle = `rgba(${hexToRgb(petalColor).map((v) => Math.round(v * 255 * rng.range(0.8, 1.15))).join(',')},0.95)`;
        ctx.beginPath(); ctx.arc(c + rng.range(-1, 1) * r * 0.6, y, r, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = '#4c7a3c'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(c, s * 0.95); ctx.lineTo(c, s * 0.1); ctx.stroke();
      return;
    }
    // stem
    ctx.strokeStyle = '#4c7a3c';
    ctx.lineWidth = s * 0.018;
    ctx.beginPath();
    ctx.moveTo(c, s * 0.98);
    ctx.quadraticCurveTo(c - s * 0.04, s * 0.7, c, s * 0.45);
    ctx.stroke();
    // leaves
    ctx.fillStyle = '#55833f';
    for (let i = 0; i < 2; i++) {
      const y = s * (0.62 + i * 0.14);
      const dir = i % 2 === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.ellipse(c + dir * s * 0.07, y, s * 0.08, s * 0.03, dir * 0.5, 0, TAU);
      ctx.fill();
    }
    const pc = hexToRgb(petalColor);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU + rng.range(-0.05, 0.05);
      ctx.save();
      ctx.translate(c, s * 0.42);
      ctx.rotate(a);
      const pw = s * (kind === 'poppy' ? 0.13 : 0.075);
      const pl = s * (kind === 'poppy' ? 0.17 : 0.12);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, pl);
      g.addColorStop(0, `rgba(${pc.map((v) => Math.round(v * 255 * 1.1)).join(',')},1)`);
      g.addColorStop(1, `rgba(${pc.map((v) => Math.round(v * 255 * 0.7)).join(',')},1)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(pl * 0.55, 0, pl * 0.62, pw, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    const cc = hexToRgb(centerColor);
    ctx.fillStyle = `rgb(${cc.map((v) => Math.round(v * 255)).join(',')})`;
    ctx.beginPath();
    ctx.arc(c, s * 0.42, s * 0.055, 0, TAU);
    ctx.fill();
  }));

  const featherSpriteCanvas = () => bakeSprite('featherSprite', () => spriteCanvas(spriteSize, (ctx, s) => {
    ctx.translate(s / 2, s / 2);
    ctx.rotate(-Math.PI / 7);
    const L = s * 0.72, W = s * 0.2;
    const g = ctx.createLinearGradient(-L / 2, 0, L / 2, 0);
    g.addColorStop(0, 'rgba(255,244,214,0.95)');
    g.addColorStop(0.5, 'rgba(250,214,140,0.95)');
    g.addColorStop(1, 'rgba(224,170,80,0.9)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-L / 2, 0);
    ctx.quadraticCurveTo(0, -W * 1.6, L / 2, 0);
    ctx.quadraticCurveTo(0, W * 1.6, -L / 2, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-L / 2, 0); ctx.lineTo(L / 2, 0); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const t = (i / 12 - 0.5) * L * 0.9;
      ctx.beginPath(); ctx.moveTo(t, -1); ctx.lineTo(t * 1.15, -W * 0.85 * (1 - Math.abs(i / 12 - 0.5) * 1.4)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(t, 1); ctx.lineTo(t * 1.15, W * 0.85 * (1 - Math.abs(i / 12 - 0.5) * 1.4)); ctx.stroke();
    }
  }));

  const windowCanvas = () => bakeSprite('window', () => spriteCanvas(texSize, (ctx, s) => {
    // frame
    ctx.fillStyle = '#5f4327';
    ctx.fillRect(0, 0, s, s);
    const b = s * 0.08;
    // glass panes with warm light
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(b, b, s - b * 2, s - b * 2);
    const g = ctx.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, 'rgba(255,196,120,0.85)');
    g.addColorStop(0.45, 'rgba(255,170,90,0.5)');
    g.addColorStop(0.46, 'rgba(120,140,170,0.35)');
    g.addColorStop(1, 'rgba(60,75,95,0.3)');
    ctx.fillStyle = g;
    ctx.fillRect(b, b, s - b * 2, s - b * 2);
    // mullions
    ctx.fillStyle = '#4e371f';
    ctx.fillRect(s / 2 - s * 0.03, b, s * 0.06, s - b * 2);
    ctx.fillRect(b, s / 2 - s * 0.03, s - b * 2, s * 0.06);
  }));

  const posterCanvas = () => bakeSprite('poster', () => spriteCanvas(texSize, (ctx, s) => {
    ctx.fillStyle = '#f2e4c8';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#e8b64c';
    ctx.fillRect(s * 0.1, s * 0.12, s * 0.8, s * 0.4);
    ctx.fillStyle = '#1f6f78';
    ctx.beginPath();
    ctx.moveTo(s * 0.1, s * 0.52); ctx.lineTo(s * 0.4, s * 0.28); ctx.lineTo(s * 0.62, s * 0.52);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s * 0.4, s * 0.52); ctx.lineTo(s * 0.62, s * 0.34); ctx.lineTo(s * 0.9, s * 0.52);
    ctx.fill();
    ctx.fillStyle = '#e0523f';
    ctx.beginPath(); ctx.arc(s * 0.72, s * 0.22, s * 0.08, 0, TAU); ctx.fill();
    ctx.fillStyle = '#3a2c22';
    ctx.fillRect(s * 0.18, s * 0.64, s * 0.64, s * 0.04);
    ctx.fillRect(s * 0.24, s * 0.72, s * 0.52, s * 0.03);
    ctx.fillRect(s * 0.3, s * 0.79, s * 0.4, s * 0.03);
  }));

  const baked = new Map();
  function bakeSprite(name, drawFn) {
    if (!baked.has(name)) baked.set(name, { canvas: null, draw: drawFn, tex: null });
    const entry = baked.get(name);
    if (!entry.canvas) entry.canvas = drawFn();
    if (!entry.tex) entry.tex = texture(entry.canvas, { repeat: 1, wrap: THREE.ClampToEdgeWrapping });
    return entry.tex;
  }

  // -- Public surface factories ----------------------------------------------

  const factories = {
    grass: grassSurface,
    dryGrass: dryGrassSurface,
    sand: sandSurface,
    rock: rockSurface,
    cliff: cliffSurface,
    snow: snowSurface,
    dirt: dirtSurface,
    gravel: gravelSurface,
    asphalt: asphaltSurface,
    roadSurface,
    cobble: cobbleSurface,
    stoneWall: stoneWallSurface,
    plaster: plasterSurface,
    roofTile: roofTileSurface,
    terracotta: terracottaSurface,
    wood: woodSurface,
    planks: planksSurface,
    bark: barkSurface,
    logEnd: logEndSurface,
    thatch: thatchSurface,
    hay: haySurface,
    metal: metalSurface,
    paintedMetal: paintedMetalSurface,
    fabric: fabricSurface,
    leather: leatherSurface,
    rope: ropeSurface,
    wicker: wickerSurface,
    kiteFabric: kiteFabricSurface,
    waterNormal: waterNormalSurface,
    foam: foamSurface,
  };

  const TEX = {};
  for (const [name, fn] of Object.entries(factories)) {
    TEX[name] = (opts) => {
      const k = key(name, opts);
      if (!cache.has(k)) cache.set(k, fn(opts));
      return cache.get(k);
    };
  }

  // Canvas texture helpers (exposed for other modules that need custom maps)
  TEX.canvas = (size = 256) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  };
  TEX.noiseCanvas = (opts = {}) => {
    const { size = texSize, cells = 8, octaves = 5, seed = 1, colorA = '#000000', colorB = '#ffffff', ridged = false } = opts;
    const P = new Pixels(size);
    const f = fbmField(size, { cells, octaves, seed, ridged });
    const ca = hexToRgb(colorA), cb = hexToRgb(colorB);
    for (let i = 0; i < size * size; i++) {
      const c = mix3(ca, cb, f[i]);
      P.r[i] = c[0]; P.g[i] = c[1]; P.b[i] = c[2];
    }
    return pixelsToCanvas(P);
  };
  TEX.normalFromHeight = (canvas, strength = 2) => {
    const size = canvas.width;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, size, size).data;
    const h = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) h[i] = data[i * 4] / 255;
    return normalCanvasFrom({ size, r: null }, strength, h);
  };
  TEX.heightCanvas = (canvas) => {
    const size = canvas.width;
    const data = canvas.getContext('2d').getImageData(0, 0, size, size).data;
    const P = new Pixels(size);
    for (let i = 0; i < size * size; i++) {
      const v = data[i * 4] / 255;
      P.r[i] = P.g[i] = P.b[i] = v;
    }
    return pixelsToCanvas(P);
  };
  TEX.texture = (canvas, opts) => texture(canvas, opts);
  TEX.pixels = (size) => new Pixels(size);
  TEX.bake = (P) => pixelsToCanvas(P);
  TEX.fbmField = fbmField;
  TEX.spriteSize = spriteSize;
  TEX.texSize = texSize;

  // Sprite/simple textures
  TEX.cloudSprite = () => cloudSpriteCanvas();
  TEX.smokeSprite = () => smokeSpriteCanvas();
  TEX.starSprite = () => starSpriteCanvas();
  TEX.sparkSprite = () => sparkSpriteCanvas();
  TEX.leafSprite = (kind = 'broadleaf', seed = 321) => leafSpriteCanvas(kind, seed);
  TEX.grassBladeSprite = () => grassBladeSpriteCanvas();
  TEX.flowerSprite = (kind = 'poppy', seed = 341) => flowerSpriteCanvas(kind, seed);
  TEX.featherSprite = () => featherSpriteCanvas();
  TEX.window = () => windowCanvas();
  TEX.poster = () => posterCanvas();
  TEX.terrainSplat = () => ({ grass: TEX.grass(), rock: TEX.rock(), sand: TEX.sand(), snow: TEX.snow() });

  TEX.disposeAll = () => {
    for (const t of all) t.dispose();
    all.length = 0;
    cache.clear();
    baked.clear();
  };

  return TEX;
}
