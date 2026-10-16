/**
 * utils.js - shared math, random and geometry helpers for "Pelican Island Ride".
 *
 * Zero dependencies on three.js except where noted. Everything here is
 * deterministic when driven by a seeded RNG so the island is identical on
 * every load (unless the player passes ?seed=... ).
 */

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));

/**
 * Cooperative time slicer for long synchronous builds (the island scatter
 * passes). Heavy loops call the returned function once per iteration; when the
 * current slice has run for `budgetMs` it yields a macrotask so the browser can
 * paint the loading screen. Without it the whole build is one multi-second
 * long task: a frozen progress bar, and Lighthouse total blocking time of
 * ~5 s (desktop) / ~14 s (mobile).
 *
 * The yield uses MessageChannel: setTimeout(0) is clamped to 4 ms once nested,
 * which would add seconds across hundreds of slices, and requestAnimationFrame
 * would wait for a full frame each time.
 */
export function createSlicer(budgetMs = 24) {
  const hasChannel = typeof MessageChannel === 'function';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let start = now();

  const yieldToBrowser = () => new Promise((resolve) => {
    if (hasChannel) {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(0);
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });

  return async function slice() {
    if (now() - start < budgetMs) return false;
    await yieldToBrowser();
    start = now();
    return true;
  };
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Polynomial smooth-min (k = blend radius). */
export function smin(a, b, k) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Polynomial smooth-max. */
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

/** Frame-rate independent exponential damping. */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function dampVec3(out, tx, ty, tz, lambda, dt) {
  const f = 1 - Math.exp(-lambda * dt);
  out.x += (tx - out.x) * f;
  out.y += (ty - out.y) * f;
  out.z += (tz - out.z) * f;
  return out;
}

export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest-path angular interpolation. */
export function angleLerp(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

export function angleDamp(current, target, lambda, dt) {
  return current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutElastic = (t) => {
  const c4 = TAU / 3;
  return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

export function hashStringToSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1337) {
    this.next = mulberry32(typeof seed === 'string' ? hashStringToSeed(seed) : seed >>> 0);
  }
  float() { return this.next(); }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(a + (b - a + 1) * this.next()) > b ? b : Math.floor(a + (b - a + 1) * this.next()); }
  intInclusive(a, b) { return a + Math.floor((b - a + 1) * this.next()) * (this.next() < 1 ? 1 : 0); }
  /** Integer in [a, b] inclusive. */
  irange(a, b) { return a + Math.floor((b - a + 1) * this.next()); }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  /** Weighted pick: entries = [{weight, ...}] or pairs [item, weight]. */
  weighted(items, weightOf) {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = this.next() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** Box-Muller gaussian, mean 0 sigma 1. */
  gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }
  /** Random point in unit disc. */
  discPoint() {
    const r = Math.sqrt(this.next());
    const a = this.next() * TAU;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  }
}

// ---------------------------------------------------------------------------
// Simplex noise (2D) + fBm family
// ---------------------------------------------------------------------------

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export class SimplexNoise2D {
  constructor(seed = 0) {
    const rng = mulberry32(typeof seed === 'string' ? hashStringToSeed(seed) : seed >>> 0);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }

  /** Raw noise in roughly [-1, 1]. */
  noise(xin, yin) {
    const perm = this.perm, permMod8 = this.permMod8;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1 = 0, j1 = 1;
    if (x0 > y0) { i1 = 1; j1 = 0; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const gi0 = permMod8[ii + perm[jj]];
    const gi1 = permMod8[ii + i1 + perm[jj + j1]];
    const gi2 = permMod8[ii + 1 + perm[jj + 1]];
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * (GRAD2[gi0][0] * x0 + GRAD2[gi0][1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * (GRAD2[gi1][0] * x1 + GRAD2[gi1][1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * (GRAD2[gi2][0] * x2 + GRAD2[gi2][1] * y2); }
    return 70 * (n0 + n1 + n2);
  }

  /** Noise remapped to [0, 1]. */
  noise01(x, y) {
    return this.noise(x, y) * 0.5 + 0.5;
  }

  /** Fractal Brownian motion. Returns roughly [-1, 1]. */
  fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Rigged multifractal - sharp mountain ridges, roughly [0, 1]. */
  ridged(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Billowy noise, roughly [0, 1]. */
  billow(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * Math.abs(this.noise(x * freq, y * freq));
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Domain-warped fbm - organic, swirly shapes. */
  warpedFbm(x, y, warpStrength = 0.6, octaves = 4) {
    const wx = this.noise(x + 5.2, y + 1.3);
    const wy = this.noise(x - 3.7, y + 8.1);
    return this.fbm(x + warpStrength * wx, y + warpStrength * wy, octaves);
  }
}

// ---------------------------------------------------------------------------
// Polyline distance field (uniform grid accelerated)
// ---------------------------------------------------------------------------

/**
 * Accelerated distance queries against a closed or open polyline.
 * Points: flat Float32Array of [x, z, x, z, ...] (world XZ plane).
 */
export class PolylineDistanceField {
  constructor(points, { cellSize = 24, pad = 64, closed = true } = {}) {
    this.pts = points;
    this.count = points.length / 2;
    this.closed = closed;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const x = points[i * 2], z = points[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    this.minX = minX - pad; this.minZ = minZ - pad;
    this.maxX = maxX + pad; this.maxZ = maxZ + pad;
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil((this.maxX - this.minX) / cellSize));
    this.rows = Math.max(1, Math.ceil((this.maxZ - this.minZ) / cellSize));
    /** @type {number[][]} */
    this.cells = new Array(this.cols * this.rows);
    this._build();
  }

  _build() {
    const { pts, count, cellSize, closed } = this;
    const segCount = closed ? count : count - 1;
    for (let i = 0; i < segCount; i++) {
      const ax = pts[i * 2], az = pts[i * 2 + 1];
      const j = (i + 1) % count;
      const bx = pts[j * 2], bz = pts[j * 2 + 1];
      // Rasterize segment into overlapped cells
      const minX = Math.min(ax, bx) - cellSize, maxX = Math.max(ax, bx) + cellSize;
      const minZ = Math.min(az, bz) - cellSize, maxZ = Math.max(az, bz) + cellSize;
      const c0 = clamp(Math.floor((minX - this.minX) / cellSize), 0, this.cols - 1);
      const c1 = clamp(Math.floor((maxX - this.minX) / cellSize), 0, this.cols - 1);
      const r0 = clamp(Math.floor((minZ - this.minZ) / cellSize), 0, this.rows - 1);
      const r1 = clamp(Math.floor((maxZ - this.minZ) / cellSize), 0, this.rows - 1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = r * this.cols + c;
          (this.cells[k] || (this.cells[k] = [])).push(i);
        }
      }
    }
  }

  /**
   * @returns {number} distance from (x, z) to the polyline. Returns Infinity
   * when the query falls outside the padded bounds.
   */
  distanceTo(x, z, maxSearch = Infinity) {
    const res = this.closest(x, z, maxSearch);
    return res ? res.dist : Infinity;
  }

  /**
   * @returns {{dist:number, x:number, z:number, index:number, t:number}|null}
   * Closest point info on the polyline (world XZ). `t` is the segment parameter.
   */
  closest(x, z, maxSearch = Infinity) {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return null;
    const c = clamp(Math.floor((x - this.minX) / this.cellSize), 0, this.cols - 1);
    const r = clamp(Math.floor((z - this.minZ) / this.cellSize), 0, this.rows - 1);
    const list = this.cells[r * this.cols + c];
    if (!list) return null;
    const pts = this.pts;
    let bestD2 = maxSearch * maxSearch;
    let bx = 0, bz = 0, bt = 0, bi = -1;
    for (let n = 0; n < list.length; n++) {
      const i = list[n];
      if (!this.closed && i >= this.count - 1) continue;
      const ax = pts[i * 2], az = pts[i * 2 + 1];
      const j = (i + 1) % this.count;
      const cx = pts[j * 2], cz = pts[j * 2 + 1];
      const dx = cx - ax, dz = cz - az;
      const len2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (z - az) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t, pz = az + dz * t;
      const ddx = x - px, ddz = z - pz;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < bestD2) {
        bestD2 = d2; bx = px; bz = pz; bt = t; bi = i;
      }
    }
    if (bi < 0) return null;
    return { dist: Math.sqrt(bestD2), x: bx, z: bz, index: bi, t: bt };
  }
}

/** Distance from point to segment (XZ plane). */
export function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t, z = az + dz * t;
  return Math.hypot(px - x, pz - z);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Stable pseudo-random hash for integer lattice coords -> [0,1). */
export function hash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Format seconds as M:SS. */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Format hour 0..24 as HH:MM. */
export function formatClock(hour) {
  const h = ((hour % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Tiny event bus. */
export class EventBus {
  constructor() { this.map = new Map(); }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    const s = this.map.get(type);
    if (s) s.delete(fn);
  }
  emit(type, payload) {
    const s = this.map.get(type);
    if (s) for (const fn of s) fn(payload);
  }
}

/** Small object pool to keep update loops allocation-free. */
export class Pool {
  constructor(factory, reset = () => {}) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
  }
  acquire() { return this.free.pop() || this.factory(); }
  release(obj) { this.reset(obj); this.free.push(obj); }
}
