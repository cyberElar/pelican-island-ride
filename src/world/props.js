/**
 * props.js - hand-built island dressing: village, harbour, mills, farms, camp,
 * roadside furniture and scattered details. Fully procedural.
 *
 * Everything static is merged into one mesh per shared material, so the whole
 * module costs a few dozen draw calls. The handful of things that move (mill
 * sails, waterwheel, flags, laundry, sails, awnings, moored boats, lamp glass)
 * own small meshes; `update()` only writes numbers into existing objects and
 * never allocates.
 *
 * See docs/SPEC.md 4.10 for the frozen interface.
 */

import * as THREE from 'three';
import { Rng, TAU, clamp, clamp01, lerp } from '../core/utils.js';
import { QUALITY_PRESETS } from '../core/settings.js';

const WHITE = { r: 1, g: 1, b: 1 };
const EMPTY = {};
const r2 = (v) => Math.round(v * 100) / 100;

/* --------------------------------------------------------------------------
 * Vertex accumulation
 * ------------------------------------------------------------------------ */

class MeshBuf {
  constructor(cap = 1024) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.nor = new Float32Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.col = new Float32Array(cap * 3);
  }
  reserve(extra) {
    const need = this.n + extra;
    if (need <= this.cap) return;
    let cap = this.cap;
    while (cap < need) cap *= 2;
    const pos = new Float32Array(cap * 3);
    const nor = new Float32Array(cap * 3);
    const uv = new Float32Array(cap * 2);
    const col = new Float32Array(cap * 3);
    pos.set(this.pos.subarray(0, this.n * 3));
    nor.set(this.nor.subarray(0, this.n * 3));
    uv.set(this.uv.subarray(0, this.n * 2));
    col.set(this.col.subarray(0, this.n * 3));
    this.cap = cap; this.pos = pos; this.nor = nor; this.uv = uv; this.col = col;
  }
  push(px, py, pz, nx, ny, nz, u, v, tr, tg, tb) {
    const i3 = this.n * 3;
    const i2 = this.n * 2;
    this.n++;
    this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
    this.nor[i3] = nx; this.nor[i3 + 1] = ny; this.nor[i3 + 2] = nz;
    this.uv[i2] = u; this.uv[i2 + 1] = v;
    this.col[i3] = tr; this.col[i3 + 1] = tg; this.col[i3 + 2] = tb;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, this.n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.n * 3), 3));
    g.computeBoundingSphere();
    return g;
  }
}

/* --------------------------------------------------------------------------
 * Scratch objects
 * ------------------------------------------------------------------------ */

const _pa = new THREE.Vector3();
const _pn = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _nm3 = new THREE.Matrix3();
const _ml = new THREE.Matrix4();
const _mProto = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _sca = new THREE.Vector3();
const _trl = new THREE.Vector3();

function composeMat(out, x, y, z, rx, ry, rz, sx, sy, sz) {
  // YXZ: yaw * pitch * roll, so `ry` aims +Z and `rx` pitches it up or down.
  _eul.set(rx, ry, rz, 'YXZ');
  _quat.setFromEuler(_eul);
  _trl.set(x, y, z);
  _sca.set(sx, sy, sz);
  return out.compose(_trl, _quat, _sca);
}

/** Append a THREE geometry into a MeshBuf through `matrix`, tinted. */
function appendGeo(buf, geo, matrix, tint) {
  const pos = geo.attributes.position;
  if (!pos) return;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const col = geo.attributes.color;
  const idx = geo.index;
  const count = idx ? idx.count : pos.count;
  buf.reserve(count);
  _nm3.getNormalMatrix(matrix);
  const tr = tint ? tint.r : 1;
  const tg = tint ? tint.g : 1;
  const tb = tint ? tint.b : 1;
  for (let i = 0; i < count; i++) {
    const vi = idx ? idx.getX(i) : i;
    _pa.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(matrix);
    if (nor) _pn.set(nor.getX(vi), nor.getY(vi), nor.getZ(vi)).applyNormalMatrix(_nm3);
    else _pn.set(0, 1, 0);
    const u = uv ? uv.getX(vi) : 0;
    const v = uv ? uv.getY(vi) : 0;
    buf.push(_pa.x, _pa.y, _pa.z, _pn.x, _pn.y, _pn.z, u, v,
      col ? col.getX(vi) * tr : tr,
      col ? col.getY(vi) * tg : tg,
      col ? col.getZ(vi) * tb : tb);
  }
}

/* --------------------------------------------------------------------------
 * Primitive emitters - all keep a consistent texel density
 * ------------------------------------------------------------------------ */

// sign triples of the unit cube corners, outward normal, and the UV axes
const BOX_FACES = [
  { n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], u: 2, v: 1 },
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], u: 2, v: 1 },
  { n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], u: 0, v: 2 },
  { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], u: 0, v: 2 },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], u: 0, v: 1 },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], u: 0, v: 1 },
];

function tintOf(t) { return t ? [t.r, t.g, t.b] : [1, 1, 1]; }

function emitBox(buf, m4, w, h, d, tile, tint) {
  const half = [w * 0.5, h * 0.5, d * 0.5];
  _nm3.getNormalMatrix(m4);
  buf.reserve(36);
  const c3 = tintOf(tint);
  for (let f = 0; f < 6; f++) {
    const face = BOX_FACES[f];
    _pn.set(face.n[0], face.n[1], face.n[2]).applyNormalMatrix(_nm3);
    const cs = face.c;
    for (let t = 0; t < 2; t++) {
      const ids = [0, 1 + t, 2 + t];
      for (let q = 0; q < 3; q++) {
        const c = cs[ids[q]];
        const uu = ((c[face.u] + 1) * half[face.u]) / tile;
        const vv = ((c[face.v] + 1) * half[face.v]) / tile;
        _pa.set(c[0] * half[0], c[1] * half[1], c[2] * half[2]).applyMatrix4(m4);
        buf.push(_pa.x, _pa.y, _pa.z, _pn.x, _pn.y, _pn.z, uu, vv, c3[0], c3[1], c3[2]);
      }
    }
  }
}

function emitCyl(buf, m4, rt, rb, h, seg, tile, tint, caps) {
  const hh = h * 0.5;
  _nm3.getNormalMatrix(m4);
  const c3 = tintOf(tint);
  buf.reserve(seg * 12 + seg * 6 + 12);
  const slope = (rb - rt) / (h || 1);
  const rMid = (rt + rb) * 0.5;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU;
    const a1 = ((i + 1) / seg) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const l0 = Math.hypot(1, slope);
    const u0 = (a0 * rMid) / tile;
    const u1 = (a1 * rMid) / tile;
    const vt = hh / tile, vb = -hh / tile;
    pushV(buf, m4, rt * c0, hh, rt * s0, c0 / l0, slope / l0, s0 / l0, u0, vt, c3);
    pushV(buf, m4, rb * c1, -hh, rb * s1, c1 / l0, slope / l0, s1 / l0, u1, vb, c3);
    pushV(buf, m4, rb * c0, -hh, rb * s0, c0 / l0, slope / l0, s0 / l0, u0, vb, c3);
    pushV(buf, m4, rt * c0, hh, rt * s0, c0 / l0, slope / l0, s0 / l0, u0, vt, c3);
    pushV(buf, m4, rt * c1, hh, rt * s1, c1 / l0, slope / l0, s1 / l0, u1, vt, c3);
    pushV(buf, m4, rb * c1, -hh, rb * s1, c1 / l0, slope / l0, s1 / l0, u1, vb, c3);
  }
  if (caps !== false) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * TAU;
      const a1 = ((i + 1) / seg) * TAU;
      if (rt > 1e-4) {
        pushV(buf, m4, 0, hh, 0, 0, 1, 0, 0, 0, c3);
        pushV(buf, m4, rt * Math.cos(a1), hh, rt * Math.sin(a1), 0, 1, 0, 1, 0, c3);
        pushV(buf, m4, rt * Math.cos(a0), hh, rt * Math.sin(a0), 0, 1, 0, 0, 1, c3);
      }
      if (rb > 1e-4) {
        pushV(buf, m4, 0, -hh, 0, 0, -1, 0, 0, 0, c3);
        pushV(buf, m4, rb * Math.cos(a0), -hh, rb * Math.sin(a0), 0, -1, 0, 1, 0, c3);
        pushV(buf, m4, rb * Math.cos(a1), -hh, rb * Math.sin(a1), 0, -1, 0, 0, 1, c3);
      }
    }
  }
}

function pushV(buf, m4, x, y, z, nx, ny, nz, u, v, c3) {
  _pn.set(nx, ny, nz).applyNormalMatrix(_nm3);
  _pa.set(x, y, z).applyMatrix4(m4);
  buf.push(_pa.x, _pa.y, _pa.z, _pn.x, _pn.y, _pn.z, u, v, c3[0], c3[1], c3[2]);
}

/** Flat triangle from three points (CCW = outward); UVs from a cheap planar map. */
function pushTri(buf, a, b, c, tile, tint) {
  _p0.copy(a); _p1.copy(b); _p2.copy(c);
  _pn.copy(_p1).sub(_p0).cross(_p3.copy(_p2).sub(_p0));
  if (!_pn.lengthSq()) _pn.set(0, 1, 0);
  _pn.normalize();
  const c3 = tintOf(tint);
  for (let i = 0; i < 3; i++) {
    const p = i === 0 ? _p0 : i === 1 ? _p1 : _p2;
    buf.push(p.x, p.y, p.z, _pn.x, _pn.y, _pn.z,
      (p.x * 0.7 + p.z * 0.3) / tile, (p.y + p.z * 0.5) / tile, c3[0], c3[1], c3[2]);
  }
}

/** Surface of revolution around Y. pts = [[radius, y], ...] bottom to top. */
function emitLathe(buf, m4, pts, seg, tile, tint, cap) {
  _nm3.getNormalMatrix(m4);
  const c3 = tintOf(tint);
  buf.reserve(seg * (pts.length - 1) * 6 + seg * 6 + 12);
  for (let j = 0; j < pts.length - 1; j++) {
    const r0 = pts[j][0], y0 = pts[j][1];
    const r1 = pts[j + 1][0], y1 = pts[j + 1][1];
    const dr = r1 - r0, dy = y1 - y0;
    let nr = dy, ny = -dr;
    const nl = Math.hypot(nr, ny);
    if (nl < 1e-6) { nr = 1; ny = 0; } else { nr /= nl; ny /= nl; }
    if (nr < 0) { nr = -nr; ny = -ny; }
    const rMid = (r0 + r1) * 0.5;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * TAU;
      const a1 = ((i + 1) / seg) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const u0 = (a0 * rMid) / tile;
      const u1 = (a1 * rMid) / tile;
      pushV(buf, m4, r1 * c0, y1, r1 * s0, nr * c0, ny, nr * s0, u0, y1 / tile, c3);
      pushV(buf, m4, r0 * c1, y0, r0 * s1, nr * c1, ny, nr * s1, u1, y0 / tile, c3);
      pushV(buf, m4, r0 * c0, y0, r0 * s0, nr * c0, ny, nr * s0, u0, y0 / tile, c3);
      pushV(buf, m4, r1 * c0, y1, r1 * s0, nr * c0, ny, nr * s0, u0, y1 / tile, c3);
      pushV(buf, m4, r1 * c1, y1, r1 * s1, nr * c1, ny, nr * s1, u1, y1 / tile, c3);
      pushV(buf, m4, r0 * c1, y0, r0 * s1, nr * c1, ny, nr * s1, u1, y0 / tile, c3);
    }
  }
  if (cap !== false) {
    const top = pts[pts.length - 1];
    const bot = pts[0];
    if (top[0] > 1e-4) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
        pushV(buf, m4, 0, top[1], 0, 0, 1, 0, 0, 0, c3);
        pushV(buf, m4, top[0] * Math.cos(a1), top[1], top[0] * Math.sin(a1), 0, 1, 0, 1, 0, c3);
        pushV(buf, m4, top[0] * Math.cos(a0), top[1], top[0] * Math.sin(a0), 0, 1, 0, 0, 1, c3);
      }
    }
    if (bot[0] > 1e-4) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
        pushV(buf, m4, 0, bot[1], 0, 0, -1, 0, 0, 0, c3);
        pushV(buf, m4, bot[0] * Math.cos(a0), bot[1], bot[0] * Math.sin(a0), 0, -1, 0, 1, 0, c3);
        pushV(buf, m4, bot[0] * Math.cos(a1), bot[1], bot[0] * Math.sin(a1), 0, -1, 0, 0, 1, c3);
      }
    }
  }
}

/* --------------------------------------------------------------------------
 * Frozen geometry prototypes (built once, re-used by every placement)
 * ------------------------------------------------------------------------ */

const protoCache = new Map();

function proto(key, build) {
  let g = protoCache.get(key);
  if (!g) {
    const buf = new MeshBuf(256);
    build(buf);
    g = buf.geometry();
    protoCache.set(key, g);
  }
  return g;
}

function boxG(w, h, d, tile = 1.6) {
  return proto(`b|${r2(w)}|${r2(h)}|${r2(d)}|${tile}`, (buf) => {
    _mProto.identity();
    emitBox(buf, _mProto, Math.max(w, 0.02), Math.max(h, 0.02), Math.max(d, 0.02), tile, WHITE);
  });
}

function cylG(rt, rb, h, seg = 10, tile = 1.2) {
  return proto(`c|${r2(rt)}|${r2(rb)}|${r2(h)}|${seg}|${tile}`, (buf) => {
    _mProto.identity();
    emitCyl(buf, _mProto, Math.max(rt, 0), Math.max(rb, 0), Math.max(h, 0.02), seg, tile, WHITE, true);
  });
}

function latheG(key, pts, seg = 14, tile = 1.0) {
  return proto(`l|${key}|${seg}`, (buf) => {
    _mProto.identity();
    emitLathe(buf, _mProto, pts, seg, tile, WHITE, true);
  });
}

/** Chamfered plank / beam: rectangle extruded along Z with a beveled edge. */
function plankG(len, thick, wide, bevel = 0.03) {
  const L = r2(len), T = r2(thick), W = r2(wide);
  const B = r2(Math.max(0.0, Math.min(bevel, T * 0.3, W * 0.3, L * 0.1)));
  return proto(`p|${L}|${T}|${W}|${B}`, (buf) => {
    const shape = new THREE.Shape();
    shape.moveTo(-L / 2, -T / 2);
    shape.lineTo(L / 2, -T / 2);
    shape.lineTo(L / 2, T / 2);
    shape.lineTo(-L / 2, T / 2);
    shape.closePath();
    const depth = Math.max(0.01, W - B * 2);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: B > 0.002, bevelThickness: B, bevelSize: B,
      bevelSegments: 1, steps: 1, curveSegments: 1,
    });
    geo.translate(0, 0, -depth / 2);
    const uv = geo.attributes.uv;
    if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 1.6, uv.getY(i) / 1.6);
    _mProto.identity();
    appendGeo(buf, geo, _mProto, WHITE);
    geo.dispose();
  });
}

/** Gable triangle: base along X, apex up, extruded along Z. */
function triG(width, height, thick) {
  const w = r2(width), h = r2(height), t = r2(thick);
  return proto(`t|${w}|${h}|${t}`, (buf) => {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo(w / 2, -h / 2);
    shape.lineTo(0, h / 2);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1, curveSegments: 1 });
    geo.translate(0, 0, -t / 2);
    const uv = geo.attributes.uv;
    if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 1.6, uv.getY(i) / 1.6);
    _mProto.identity();
    appendGeo(buf, geo, _mProto, WHITE);
    geo.dispose();
  });
}

function icoG(r, detail = 0) {
  return proto(`i|${r2(r)}|${detail}`, (buf) => {
    const geo = new THREE.IcosahedronGeometry(r, detail);
    _mProto.identity();
    appendGeo(buf, geo, _mProto, WHITE);
    geo.dispose();
  });
}

function torusG(r, tube, rs = 8, ts = 18) {
  return proto(`r|${r2(r)}|${r2(tube)}|${rs}|${ts}`, (buf) => {
    const geo = new THREE.TorusGeometry(r, tube, rs, ts);
    _mProto.identity();
    appendGeo(buf, geo, _mProto, WHITE);
    geo.dispose();
  });
}

function planeG(w, h, ws = 1, hs = 1) {
  return proto(`f|${r2(w)}|${r2(h)}|${ws}|${hs}`, (buf) => {
    const geo = new THREE.PlaneGeometry(w, h, ws, hs);
    _mProto.identity();
    appendGeo(buf, geo, _mProto, WHITE);
    geo.dispose();
  });
}

/** Open lattice panel in the XY plane (nets, cages, sail frames). */
function latticeG(w, h, cols, rows, t) {
  return proto(`g|${r2(w)}|${r2(h)}|${cols}|${rows}|${r2(t)}`, (buf) => {
    for (let i = 0; i <= cols; i++) {
      composeMat(_mProto, -w / 2 + (w * i) / cols, 0, 0, 0, 0, 0, 1, 1, 1);
      emitBox(buf, _mProto, t, h, t, 1.0, WHITE);
    }
    for (let j = 0; j <= rows; j++) {
      composeMat(_mProto, 0, -h / 2 + (h * j) / rows, 0, 0, 0, 0, 1, 1, 1);
      emitBox(buf, _mProto, w, t, t, 1.0, WHITE);
    }
  });
}

/** Lofted boat hull: pointed bow, transom stern, V bottom, open top. */
function hullG(len, beam, depth) {
  const L = r2(len), B = r2(beam), D = r2(depth);
  return proto(`h|${L}|${B}|${D}`, (buf) => {
    const segs = 9;
    const CS = [[-1, 0], [-0.62, 0.42], [0, 1], [0.62, 0.42], [1, 0]];
    const stations = segs + 1;
    const V = new Float32Array(stations * 5 * 3);
    for (let s = 0; s < stations; s++) {
      const t = s / segs;
      const x = (t - 0.5) * L;
      const splay = Math.pow(Math.sin(Math.PI * clamp01(t)), 0.5);
      const hw = 0.5 * B * (0.3 + 0.7 * splay);
      const kd = -D * (0.34 + 0.66 * Math.pow(Math.sin(Math.PI * clamp01(t)), 0.42));
      for (let k = 0; k < 5; k++) {
        const o = (s * 5 + k) * 3;
        V[o] = x; V[o + 1] = CS[k][1] * kd; V[o + 2] = CS[k][0] * hw;
      }
    }
    const at = (s, k, out) => {
      const o = (s * 5 + k) * 3;
      return out.set(V[o], V[o + 1], V[o + 2]);
    };
    for (let s = 0; s < segs; s++) {
      for (let k = 0; k < 4; k++) {
        at(s, k, _p0); at(s, k + 1, _p1); at(s + 1, k + 1, _p2); at(s + 1, k, _p3);
        pushTri(buf, _p0, _p2, _p1, 1.2, WHITE);
        pushTri(buf, _p0, _p3, _p2, 1.2, WHITE);
      }
    }
    for (const end of [0, segs]) {
      let cy = 0, cz = 0;
      for (let k = 0; k < 5; k++) { cy += V[(end * 5 + k) * 3 + 1]; cz += V[(end * 5 + k) * 3 + 2]; }
      _pa.set(V[end * 5 * 3], cy / 5, cz / 5);
      for (let k = 0; k < 4; k++) {
        at(end, k, _p0);
        at(end, k + 1, _p1);
        if (end === 0) pushTri(buf, _pa, _p0, _p1, 1.2, WHITE);
        else pushTri(buf, _pa, _p1, _p0, 1.2, WHITE);
      }
    }
  });
}

/* ==========================================================================
 * createProps
 * ======================================================================== */

export function createProps(ctx) {
  const layout = ctx.layout;
  const TEX = ctx.textures;
  const rng = ctx.rng || new Rng(20261014);
  // quality may arrive as a level name or through the engine preset
  const qName = (typeof ctx.quality === 'string' && QUALITY_PRESETS[ctx.quality]) ? ctx.quality
    : (ctx.engine && typeof ctx.engine.quality === 'string' && QUALITY_PRESETS[ctx.engine.quality])
      ? ctx.engine.quality : 'high';
  const DET = qName === 'low' ? 0 : qName === 'medium' ? 1 : 2;

  const group = new THREE.Group();
  group.name = 'props';

  const colliders = [];
  const chimneys = [];
  const lamps = [];
  const samples = [];
  const stats = { buildings: 0, props: 0 };
  const batches = new Map();
  const awningHolders = [];

  const anim = {
    spins: [],
    sways: [],
    boats: [],
    mats: [],
  };

  /* ---- materials: one per texture set, vertex tinted for variety ---- */

  const SURF = {
    plasterA: () => TEX.plaster('#f0e4cd'),
    plasterB: () => TEX.plaster('#e8d2b0'),
    plasterC: () => TEX.plaster('#d9e0dd'),
    stone: () => TEX.stoneWall(),
    roofRed: () => TEX.roofTile('#b4603f'),
    roofClay: () => TEX.roofTile('#c98a4b'),
    roofSlate: () => TEX.roofTile('#5b6675'),
    thatch: () => TEX.thatch(),
    wood: () => TEX.wood({ tone: '#6d4a2b' }),
    woodDark: () => TEX.wood({ tone: '#4a3320' }),
    planks: () => TEX.planks(),
    planksDark: () => TEX.planks({ tone: '#6a4c2e' }),
    planksRed: () => TEX.planks({ tone: '#8c4632' }),
    hay: () => TEX.hay(),
    rope: () => TEX.rope(),
    wicker: () => TEX.wicker(),
    leather: () => TEX.leather(),
    metal: () => TEX.metal({ color: '#9aa0a8', rough: 0.5 }),
    iron: () => TEX.metal({ color: '#4c4f55', rough: 0.72 }),
    teal: () => TEX.paintedMetal('#1f6f78'),
    cream: () => TEX.paintedMetal('#f2e8d5'),
    terracotta: () => TEX.terracotta(),
    cobble: () => TEX.cobble(),
    dirt: () => TEX.dirt(),
    gravel: () => TEX.gravel(),
    bark: () => TEX.bark(),
    canopy: () => TEX.grass(),
    fabricRed: () => TEX.fabric({ color: '#c0473c', stripeColor: '#f2e8d5' }),
    fabricTeal: () => TEX.fabric({ color: '#1f6f78', stripeColor: '#f2e8d5' }),
    canvas: () => TEX.fabric({ color: '#ddd0b0' }),
    sail: () => TEX.fabric({ color: '#efe4c8' }),
    water: () => TEX.waterNormal(),
  };

  const MAT = {};
  const MAT_META = {};
  const matFor = (key, opts) => {
    let m = MAT[key];
    if (m) return m;
    const surf = SURF[key] ? SURF[key]() : null;
    const o = opts || EMPTY;
    m = new THREE.MeshStandardMaterial({
      map: surf && surf.map ? surf.map : null,
      normalMap: surf && surf.normalMap ? surf.normalMap : null,
      roughnessMap: surf && surf.roughnessMap ? surf.roughnessMap : null,
      color: o.color !== undefined ? o.color : 0xffffff,
      roughness: o.roughness !== undefined ? o.roughness : 0.9,
      metalness: o.metalness !== undefined ? o.metalness : 0,
      vertexColors: true,
      side: o.side || THREE.FrontSide,
    });
    MAT[key] = m;
    MAT_META[key] = o.meta || { cast: true, receive: true };
    return m;
  };
  for (const key of Object.keys(SURF)) matFor(key);
  matFor('metal', { roughness: 0.45, metalness: 0.55 });
  matFor('iron', { roughness: 0.7, metalness: 0.6 });
  matFor('teal', { roughness: 0.5, metalness: 0.15 });
  matFor('cream', { roughness: 0.55, metalness: 0.1 });
  matFor('water', { color: 0x2f6b74, roughness: 0.12, metalness: 0.05, meta: { cast: false, receive: true } });
  // cloth is seen from both sides (flags, laundry, sails, awnings, tents)
  for (const k of ['canvas', 'sail', 'fabricRed', 'fabricTeal']) matFor(k, { side: THREE.DoubleSide });

  const winTex = TEX.window();
  const posterTex = TEX.poster();
  MAT.glass = new THREE.MeshStandardMaterial({
    map: winTex, emissiveMap: winTex, emissive: 0xffb15e, emissiveIntensity: 0,
    roughness: 0.35, metalness: 0, vertexColors: true,
  });
  MAT_META.glass = { cast: false, receive: true };
  MAT.globe = new THREE.MeshStandardMaterial({
    color: 0x2a2d33, emissive: 0xffd39a, emissiveIntensity: 0,
    roughness: 0.3, metalness: 0.2, vertexColors: true,
  });
  MAT_META.globe = { cast: false, receive: false };
  MAT.poster = new THREE.MeshStandardMaterial({
    map: posterTex, roughness: 0.85, metalness: 0, vertexColors: true,
  });
  MAT_META.poster = { cast: true, receive: true };
  anim.mats.push({ mat: MAT.glass, scale: 1 }, { mat: MAT.globe, scale: 1.05 });

  /* ---- merge sinks ---- */

  const globalSink = {
    add(matKey, geo, matrix, tint) {
      let b = batches.get(matKey);
      if (!b) { b = new MeshBuf(1024); batches.set(matKey, b); }
      appendGeo(b, geo, matrix, tint);
    },
  };

  class LocalSink {
    constructor() { this.bufs = new Map(); }
    add(matKey, geo, matrix, tint) {
      let b = this.bufs.get(matKey);
      if (!b) { b = new MeshBuf(256); this.bufs.set(matKey, b); }
      appendGeo(b, geo, matrix, tint);
    }
    build(parent) {
      for (const [matKey, buf] of this.bufs) {
        if (buf.n < 3) continue;
        const mesh = new THREE.Mesh(buf.geometry(), MAT[matKey]);
        const meta = MAT_META[matKey] || { cast: true, receive: true };
        mesh.castShadow = meta.cast !== false;
        mesh.receiveShadow = meta.receive !== false;
        mesh.name = `props:${matKey}`;
        parent.add(mesh);
      }
      this.bufs.clear();
    }
  }

  /** Build an `emit(matKey, geo, x, y, z, opts)` sink bound to a local frame. */
  function makeEmit(frame, sink) {
    return function emit(matKey, geo, lx, ly, lz, opt) {
      const o = opt || EMPTY;
      composeMat(_ml, lx || 0, ly || 0, lz || 0, o.rx || 0, o.ry || 0, o.rz || 0,
        o.sx === undefined ? 1 : o.sx, o.sy === undefined ? 1 : o.sy, o.sz === undefined ? 1 : o.sz);
      _ml.premultiply(frame.m);
      sink.add(matKey, geo, _ml, o.tint || frame.tint);
    };
  }

  function place(sink, x, y, z, ry, tint, fn) {
    const m = new THREE.Matrix4().makeRotationY(ry);
    m.elements[12] = x; m.elements[13] = y; m.elements[14] = z;
    const frame = { m, x, y, z, ry, tint: tint || WHITE };
    fn(makeEmit(frame, sink), frame);
    return frame;
  }

  /** Cylinder between two points (ropes, wires, rails, flumes). */
  function emitLine(emit, matKey, ax, ay, az, bx, by, bz, radius) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const hlen = Math.hypot(dx, dz);
    const len = Math.hypot(dx, dy, dz) || 0.001;
    emit(matKey, cylG(radius, radius, 1, 6, 0.8),
      (ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5,
      { ry: Math.atan2(-dz, dx), rz: Math.PI / 2 - Math.atan2(dy, hlen), sy: len });
  }

  /** Flag pole with a cloth pennant that flutters in update(). */
  function addFlag(x, z, ry, matKey) {
    const y = groundAt(x, z);
    const poleH = 5.4;
    place(globalSink, x, y, z, ry, tint(0.04), (emit) => {
      emit('stone', cylG(0.42, 0.52, 0.32, 10, 1.0), 0, 0.16, 0);
      emit('wood', cylG(0.07, 0.1, poleH, 8, 1.2), 0, poleH / 2, 0);
      emit('iron', cylG(0.1, 0.1, 0.16, 8, 0.6), 0, poleH + 0.08, 0);
    });
    const g = planeG(1.75, 0.85, 4, 2).clone();
    g.translate(0.87, 0, 0);
    const flag = new THREE.Mesh(g, MAT[matKey]);
    flag.castShadow = true;
    flag.receiveShadow = true;
    flag.name = 'props:flag';
    flag.position.set(x, y + poleH - 0.6, z);
    flag.rotation.y = ry;
    group.add(flag);
    anim.sways.push({ obj: flag, phase: rng.float() * TAU, amp: 0.3, axis: 'y' });
    stats.props += 2;
    recordSample(x, y, z);
  }

  /* ---- bookkeeping ---- */

  function addCollider(x, z, r, tag) {
    if (colliders.length >= 1420) return;
    colliders.push({
      x: r2(x), z: r2(z), r: r2(r),
      tag: tag || 'prop',
      road: layout.roadDistance(x, z) < 20,
    });
  }

  function recordSample(x, y, z) {
    if (samples.length < 4000) samples.push({ x: r2(x), y: r2(y), z: r2(z) });
  }

  function addChimney(frame, lx, ly, lz, rate) {
    _pa.set(lx, ly, lz).applyMatrix4(frame.m);
    chimneys.push({ x: r2(_pa.x), y: r2(_pa.y), z: r2(_pa.z), rate });
  }

  function addLampRef(frame, lx, ly, lz, material, kind) {
    _pa.set(lx, ly, lz).applyMatrix4(frame.m);
    lamps.push({ x: r2(_pa.x), y: r2(_pa.y), z: r2(_pa.z), mesh: null, material, kind: kind || 'lamp' });
  }

  const tint = (amount) => {
    const t = 1 + rng.range(-amount, amount);
    return {
      r: t,
      g: 1 + rng.range(-amount * 0.55, amount * 0.5),
      b: 1 + rng.range(-amount * 0.7, amount * 0.35),
    };
  };

  const groundAt = (x, z) => layout.heightAt(x, z);

  /** Terrain under a w x d footprint: highest corner, lowest corner, centre. */
  function padAt(x, z, w, d, ry) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const centre = layout.heightAt(x, z);
    let hi = centre, lo = centre;
    for (let i = 0; i < 4; i++) {
      const lx = ((i & 1) ? 1 : -1) * w * 0.5;
      const lz = ((i & 2) ? 1 : -1) * d * 0.5;
      const h = layout.heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
    return { hi, lo, centre };
  }

  /** Flattest clear spot in an annulus around a POI. */
  function spotNear(cx, cz, rMin, rMax, opts) {
    const o = opts || EMPTY;
    const tries = o.tries || 46;
    let best = null;
    for (let i = 0; i < tries; i++) {
      const a = rng.float() * TAU;
      const rr = lerp(rMin, rMax, Math.sqrt(rng.float()));
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      if (!layout.isClear(x, z, o.clear || { road: 9, poi: 0, river: 7, maxSlope: 0.42 })) continue;
      const pad = padAt(x, z, o.w || 4, o.d || 4, 0);
      if (pad.hi - pad.centre > (o.maxRise || 0.9)) continue;
      if (pad.hi - pad.lo > (o.maxSpread || 1.9)) continue;
      const score = (pad.hi - pad.centre) * 10 + (pad.hi - pad.lo) * 2 + rr * 0.02 + rng.float() * 0.05;
      if (!best || score < best.score) best = { x, z, y: pad.hi, score };
    }
    return best;
  }

  /** Walk out from a road sample to find a spot level with the road. */
  function roadsideSpot(i, side, opts) {
    const o = opts || EMPTY;
    const n = layout.roadSamples.length / 3;
    const si = ((i % n) + n) % n;
    const ax = layout.roadSamples[si * 3];
    const ay = layout.roadSamples[si * 3 + 1];
    const az = layout.roadSamples[si * 3 + 2];
    const bx = layout.roadSamples[((si + 1) % n) * 3];
    const bz = layout.roadSamples[((si + 1) % n) * 3 + 2];
    const dl = Math.hypot(bx - ax, bz - az) || 1;
    const dx = (bx - ax) / dl, dz = (bz - az) / dl;
    const nx = -dz * side, nz = dx * side;
    // face the street: +Z of the prop looks back at the road
    const ry = Math.atan2(-nx, -nz) + (rng.float() - 0.5) * (o.angleJitter || 0.3);
    const offsets = o.offsets || [13, 16, 19, 23, 28, 34];
    const w = o.w || 5, d = o.d || 5;
    for (const off of offsets) {
      const x = ax + nx * off + dx * rng.range(-3.5, 3.5);
      const z = az + nz * off + dz * rng.range(-3.5, 3.5);
      if (layout.onRoad(x, z, 3)) continue;
      if (!layout.isClear(x, z, { road: 7.5, poi: 0, river: 7, maxSlope: o.maxSlope || 0.34, minHeight: 1.2 })) continue;
      const pad = padAt(x, z, w, d, ry);
      if (pad.hi - pad.centre > (o.maxRise || 0.9)) continue;
      if (pad.hi - pad.lo > (o.maxSpread || 1.9)) continue;
      if (o.levelWithRoad && Math.abs(pad.hi - ay) > o.levelWithRoad) continue;
      return { x, z, y: pad.hi, ry, i: si, side, roadY: ay, roadOff: off };
    }
    return null;
  }

  /* ======================================================================
   * 1. VILLAGE
   * ==================================================================== */

  const V = layout.pois.village.position;
  const houses = [];
  const HOUSE_KINDS = [
    { id: 'balcony', w: 8.8, d: 7.6, h: 7.2, pitch: 0.66, floors: 2 },
    { id: 'farmhouse', w: 14.6, d: 7.0, h: 5.0, pitch: 0.5, floors: 1 },
    { id: 'shop', w: 9.4, d: 8.0, h: 5.8, pitch: 0.6, floors: 2, awning: true },
    { id: 'cottage', w: 6.8, d: 6.2, h: 4.8, pitch: 0.68, floors: 1, bell: true },
  ];
  const HOUSE_PLAN = [0, 1, 2, 3, 0, 0, 2, 1, 0, 3, 2, 0, 1, 0, 3, 0, 2, 1, 0, 3];
  const WALLS = ['plasterA', 'plasterB', 'plasterC'];
  const ROOFS = ['roofRed', 'roofClay', 'roofSlate'];

  function addGlazedWindow(emit, frame, lx, ly, lz, ry, t, shutters, flowers) {
    const w = 1.02;
    const h = 1.24;
    emit('glass', boxG(w, h, 0.16, h), lx, ly, lz, { ry });
    emit('wood', plankG(w + 0.24, 0.13, 0.2, 0.02), lx, ly + h / 2 + 0.07, lz, { ry });
    emit('wood', plankG(w + 0.24, 0.13, 0.2, 0.02), lx, ly - h / 2 - 0.07, lz, { ry });
    emit('stone', boxG(w + 0.44, 0.13, 0.36, 1.1), lx, ly - h / 2 - 0.2, lz, { ry });
    if (shutters) {
      const mat = rng.chance(0.5) ? 'teal' : 'planksDark';
      emit(mat, boxG(0.3, h + 0.06, 0.11, 1.0), lx - (w / 2 + 0.22), ly, lz + 0.05, { ry });
      emit(mat, boxG(0.3, h + 0.06, 0.11, 1.0), lx + (w / 2 + 0.22), ly, lz + 0.05, { ry });
    }
    if (flowers && DET > 0) {
      emit('planksDark', boxG(w + 0.36, 0.26, 0.3, 1.0), lx, ly - h / 2 - 0.5, lz + 0.2, { ry });
      for (let i = 0; i < 4; i++) {
        emit('canopy', icoG(0.11, 0), lx + (i - 1.5) * (w / 3.4), ly - h / 2 - 0.34, lz + 0.22, { ry, tint: t });
      }
    }
    addLampRef(frame, lx, ly, lz + 0.12, MAT.glass, 'window');
  }

  function buildHouse(emit, frame, kind, t) {
    const wall = WALLS[rng.irange(0, WALLS.length - 1)];
    const roofMat = kind.id === 'farmhouse' || kind.id === 'cottage' ? 'thatch' : ROOFS[rng.irange(0, 2)];
    const w = kind.w + rng.range(-0.6, 0.6);
    const d = kind.d + rng.range(-0.4, 0.4);
    const h = kind.h * rng.range(0.96, 1.05);
    const rise = (d / 2 + 0.4) * kind.pitch;
    const base = 0.42;
    stats.buildings++;
    stats.props += 6;

    // deep foundation (the terrain pad is never perfectly flat) + walls
    emit('stone', boxG(w + 0.5, 1.9, d + 0.5, 1.8), 0, base - 0.95, 0);
    emit(wall, boxG(w, h, d, 2.2), 0, base + h / 2, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        emit('stone', boxG(0.5, h * 0.98, 0.5, 1.6), sx * (w / 2 - 0.22), base + h / 2, sz * (d / 2 - 0.22));
      }
    }
    // gable roof: two slabs, ridge cap, gable walls
    const over = 0.55;
    const slopeLen = Math.hypot(d / 2 + over, rise) + 0.2;
    const ang = Math.atan2(rise, d / 2 + over);
    const ridgeY = base + h + rise;
    emit(roofMat, boxG(w + over * 2, 0.26, slopeLen, 1.5), 0, ridgeY - rise / 2 + 0.06, d / 4 + over / 2, { rx: ang });
    emit(roofMat, boxG(w + over * 2, 0.26, slopeLen, 1.5), 0, ridgeY - rise / 2 + 0.06, -(d / 4 + over / 2), { rx: -ang });
    emit(roofMat, plankG(w + over * 2 + 0.2, 0.22, 0.34, 0.04), 0, ridgeY + 0.12, 0);
    emit(wall, triG(d, rise, 0.34), w / 2 - 0.17, base + h + rise / 2 - 0.02, 0, { ry: Math.PI / 2 });
    emit(wall, triG(d, rise, 0.34), -(w / 2 - 0.17), base + h + rise / 2 - 0.02, 0, { ry: Math.PI / 2 });
    if (kind.bell) {
      emit('stone', boxG(1.1, 1.5, 0.5, 1.2), w / 2 - 0.2, ridgeY + 0.7, 0);
      emit('stone', triG(1.3, 0.8, 0.55), w / 2 - 0.2, ridgeY + 1.8, 0, { ry: Math.PI / 2 });
      emit('iron', cylG(0.16, 0.16, 0.42, 8, 0.8), w / 2 - 0.2, ridgeY + 0.95, 0, { rx: Math.PI / 2 });
    }
    // chimney
    const cxs = w * 0.28 * (rng.chance(0.5) ? 1 : -1);
    const czs = d * 0.16;
    const chBase = base + h + rise * 0.55;
    emit('stone', boxG(0.78, rise + 2.1, 0.78, 1.4), cxs, chBase + 0.5, czs);
    emit('stone', boxG(0.98, 0.2, 0.98, 1.2), cxs, chBase + 1.6, czs);
    addChimney(frame, cxs, chBase + 1.75, czs, rng.range(0.35, 0.9));

    // street door on +Z with lintel, iron hinges and stone steps
    const doorX = w * 0.22 * (rng.chance(0.5) ? 1 : -1);
    const dz = d / 2 + 0.03;
    emit('stone', boxG(1.5, 0.26, 1.0, 1.2), doorX, base + 0.11, dz + 0.42);
    emit('stone', boxG(1.25, 0.24, 0.72, 1.2), doorX, base + 0.32, dz + 0.26);
    emit('planksDark', plankG(1.0, 2.05, 0.14, 0.02), doorX, base + 1.16, dz);
    emit('wood', plankG(1.32, 0.16, 0.24, 0.03), doorX, base + 2.26, dz);
    emit('iron', plankG(0.34, 0.06, 0.16, 0.01), doorX - 0.34, base + 1.72, dz + 0.09);
    emit('iron', plankG(0.34, 0.06, 0.16, 0.01), doorX - 0.34, base + 0.6, dz + 0.09);
    emit('iron', cylG(0.05, 0.05, 0.18, 6, 0.6), doorX + 0.36, base + 1.1, dz + 0.1);

    // windows
    const front = kind.id === 'farmhouse' ? 3 : 2;
    for (let i = 0; i < front; i++) {
      const wx = lerp(-w / 2 + 1.6, w / 2 - 1.6, i / (front - 1));
      if (Math.abs(wx - doorX) < 1.35) continue;
      addGlazedWindow(emit, frame, wx, base + 2.2, dz, 0, t, rng.chance(0.7), rng.chance(0.6));
      if (kind.floors > 1) addGlazedWindow(emit, frame, wx, base + 5.0, dz, 0, t, rng.chance(0.5), false);
    }
    for (const sx of [-1, 1]) {
      const side = w > 10 ? 2 : 1;
      for (let i = 0; i < side; i++) {
        const wz = lerp(-d / 2 + 1.5, d / 2 - 1.5, side === 1 ? 0.5 : i / (side - 1));
        addGlazedWindow(emit, frame, sx * (w / 2 + 0.03), base + 2.2, wz,
          sx > 0 ? Math.PI / 2 : -Math.PI / 2, t, false, false);
      }
    }
    if (kind.awning) {
      emit('wood', plankG(w * 0.62, 0.2, 0.3, 0.03), 0, base + 3.5, dz);
      emit('poster', boxG(1.5, 0.9, 0.1, 1.5), w * 0.34, base + 4.2, dz + 0.05, { ry: -0.12 });
      awningHolders.push({ local: [0, base + 3.44, dz + 0.5], frame, mat: MAT.fabricRed, w: 5.2, h: 2.6, rx: -0.95, ry: 0 });
    }
    if (kind.floors > 1) {
      const by = base + 3.8;
      emit('planksDark', plankG(w * 0.62, 0.18, 1.5, 0.03), 0, by, dz + 0.72);
      for (let i = 0; i < 7; i++) {
        emit('wood', plankG(0.12, 0.95, 0.12, 0.02), lerp(-w * 0.3, w * 0.3, i / 6), by + 0.55, dz + 1.4);
      }
      emit('wood', plankG(w * 0.62, 0.12, 0.16, 0.02), 0, by + 1.05, dz + 1.4);
      emit('wood', plankG(w * 0.62, 0.1, 0.14, 0.02), 0, by + 0.55, dz + 1.4);
      addGlazedWindow(emit, frame, 0, by + 1.25, dz, 0, t, false, false);
    }
  }

  // main street: houses line the flatter stretch of the ring road
  {
    let slot = 0;
    // the market square owns this stretch of the street, keep houses out of it
    const inSquare = (idx, sd) => sd === 1 && Math.abs(idx - 152) <= 3;
    const fillSlots = (relax) => {
      for (let i = 118; i <= 176 && slot < 16; i++) {
        const kind = HOUSE_KINDS[HOUSE_PLAN[slot % HOUSE_PLAN.length]];
        const side = slot % 2 === 0 ? 1 : -1;
        const opts = {
          w: kind.w, d: kind.d, levelWithRoad: relax.level,
          maxRise: relax.rise, maxSlope: relax.slope,
        };
        if (relax.offsets) opts.offsets = relax.offsets;
        let spot = inSquare(i, side) ? null : roadsideSpot(i, side, opts);
        if (!spot && !inSquare(i + 1, -side)) spot = roadsideSpot(i + 1, -side, opts);
        if (!spot) continue;
        slot++;
        const t = tint(0.1);
        const frame = place(globalSink, spot.x, spot.y, spot.z, spot.ry, t,
          (emit, f) => buildHouse(emit, f, kind, t));
        addCollider(spot.x, spot.z, Math.max(kind.w, kind.d) * 0.5 + 0.6, 'building');
        recordSample(spot.x, spot.y, spot.z);
        houses.push({ frame, spot, kind, side: spot.side });
      }
    };
    // Seed safety (audit D10): the strict pass occasionally found only a
    // couple of plots, leaving "Seabreeze Village" as a hamlet. Two relaxed
    // passes keep the main street populated on every seed; houses that fit the
    // strict rules still take the good plots first.
    fillSlots({ rise: 0.9, slope: 0.45, level: 4.6 });
    if (slot < 12) fillSlots({ rise: 1.3, slope: 0.55, level: 6.5, offsets: [10, 13, 16, 19, 23, 28, 34] });
    if (slot < 12) fillSlots({ rise: 1.8, slope: 0.65, level: 8.0, offsets: [9, 12, 15, 18, 21, 25, 30, 36, 42] });
    stats.villageHouses = houses.length;
    // two church-adjacent cottages on the lane up to the chapel
    const chapel = layout.pois.chapel.position;
    for (let i = 0; i < 2; i++) {
      const sp = spotNear(chapel.x, chapel.z, 36, 48, { tries: 70, w: 7, d: 6.5, maxRise: 0.8, clear: { road: 10, poi: 0, river: 8, maxSlope: 0.3 } });
      if (!sp) continue;
      const t = tint(0.09);
      const ry = rng.float() * TAU;
      place(globalSink, sp.x, sp.y, sp.z, ry, t, (emit, f) => buildHouse(emit, f, HOUSE_KINDS[3], t));
      addCollider(sp.x, sp.z, 4.2, 'building');
      recordSample(sp.x, sp.y, sp.z);
    }
    // shop awnings live on their own meshes so they can flutter in the wind
    for (const a of awningHolders) {
      const aw = new THREE.Mesh(planeG(a.w, a.h, 6, 2), a.mat);
      aw.castShadow = true; aw.receiveShadow = true;
      aw.name = 'props:shopAwning';
      aw.rotation.order = 'YXZ';
      aw.rotation.y = a.frame.ry;
      aw.rotation.x = a.rx;
      _pa.set(a.local[0], a.local[1], a.local[2]).applyMatrix4(a.frame.m);
      aw.position.copy(_pa);
      group.add(aw);
      anim.sways.push({ obj: aw, phase: rng.float() * TAU, amp: 0.045, axis: 'z' });
      stats.props++;
    }
  }

  // --- square: cobbles, three-tier fountain, market stalls, well, board ---
  let square = null;
  {
    const sq = roadsideSpot(152, 1, { w: 16, d: 14, offsets: [21, 25, 30, 35], levelWithRoad: 5.4, maxRise: 1.2 })
      || { x: V.x, z: V.z, y: groundAt(V.x, V.z), ry: 0 };
    square = sq;
    const F = sq;
    place(globalSink, F.x, F.y, F.z, F.ry, tint(0.05), (emit) => {
      emit('cobble', cylG(4.9, 5.2, 0.32, 22, 2.4), 0, 0.16, 0);
      emit('stone', latheG('fountainBasin', [[0.3, 0], [1.85, 0], [1.9, 0.65], [1.55, 0.7], [0.35, 0.55], [0.28, 0.2]], 18, 1.4), 0, 0.3, 0);
      emit('stone', cylG(0.34, 0.42, 1.0, 14, 1.2), 0, 1.05, 0);
      emit('stone', latheG('fountainTier1', [[0.45, 0], [1.15, 0], [1.18, 0.3], [0.95, 0.34], [0.4, 0.22]], 16, 1.2), 0, 1.45, 0);
      emit('stone', cylG(0.26, 0.3, 0.9, 12, 1.0), 0, 2.05, 0);
      emit('stone', latheG('fountainTier2', [[0.3, 0], [0.85, 0], [0.88, 0.26], [0.66, 0.3], [0.3, 0.2]], 14, 1.0), 0, 2.35, 0);
      emit('stone', latheG('fountainTop', [[0.16, 0], [0.3, 0.1], [0.22, 0.5], [0.05, 0.62]], 12, 0.8), 0, 2.74, 0);
      emit('water', cylG(1.68, 1.68, 0.1, 18, 1.6), 0, 0.66, 0);
      emit('water', cylG(1.0, 1.0, 0.08, 14, 1.4), 0, 1.66, 0);
      emit('water', cylG(0.7, 0.7, 0.08, 12, 1.2), 0, 2.54, 0);
      for (let i = 0; i < 3; i++) {
        emit('stone', boxG(3.4 - i * 0.4, 0.24, 1.0, 1.4), 6.4 + i * 0.22, F.y * 0 + 0.12, -5.6);
      }
    });
    addCollider(F.x, F.z, 1.6, 'fountain');
    recordSample(F.x, F.y, F.z);
    stats.props += 3;

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.62;
      const sx = F.x + Math.cos(a) * 6.8;
      const sz = F.z + Math.sin(a) * 6.4;
      const sy = groundAt(sx, sz);
      const st = tint(0.06);
      const ry = -a + Math.PI / 2;
      place(globalSink, sx, sy, sz, ry, st, (emit) => {
        emit('planks', boxG(2.9, 0.18, 1.5, 1.2), 0, 0.95, 0.35);
        emit('planksDark', boxG(2.9, 0.9, 0.14, 1.0), 0, 0.5, 1.05);
        for (const px of [-1.35, 1.35]) {
          for (const pz of [-0.6, 1.0]) emit('wood', plankG(0.13, 2.5, 0.13, 0.02), px, 1.25, pz);
        }
        for (let c = 0; c < 3; c++) {
          const cx = (c - 1) * 0.95;
          emit('wicker', boxG(0.78, 0.42, 0.62, 0.9), cx, 1.25, 0.35);
          for (let p = 0; p < 5; p++) {
            emit('canopy', icoG(0.11, 0), cx + (p % 3) * 0.2 - 0.2, 1.5 + (p % 2) * 0.06,
              0.28 + Math.floor(p / 3) * 0.16, { tint: st });
          }
        }
        emit('poster', boxG(1.3, 0.72, 0.08, 1.3), 0, 1.9, 1.02);
      });
      const aw = new THREE.Mesh(planeG(3.4, 2.4, 4, 1), i % 2 ? MAT.fabricTeal : MAT.fabricRed);
      aw.castShadow = true; aw.receiveShadow = true;
      aw.name = 'props:stallAwning';
      aw.rotation.x = -0.85;
      aw.position.set(0, 2.42, 0.35);
      const holder = new THREE.Group();
      holder.add(aw);
      holder.position.set(sx, sy, sz);
      holder.rotation.y = ry;
      group.add(holder);
      anim.sways.push({ obj: aw, phase: rng.float() * TAU, amp: 0.05, axis: 'z' });
      stats.props += 5;
    }
    addFlag(F.x + 9.5, F.z - 6.5, 1.1, 'fabricRed');

    const well = spotNear(F.x, F.z, 9, 14, { tries: 50, w: 2.6, d: 2.6, maxRise: 0.8 });
    if (well) {
      place(globalSink, well.x, well.y, well.z, rng.float() * TAU, tint(0.05), (emit) => {
        emit('stone', latheG('wellShaft', [[0.9, 0], [1.12, 0], [1.05, 1.2], [0.88, 1.2]], 16, 1.2), 0, 0, 0);
        emit('wood', plankG(0.16, 2.6, 0.16, 0.02), -0.95, 1.35, 0);
        emit('wood', plankG(0.16, 2.6, 0.16, 0.02), 0.95, 1.35, 0);
        emit('wood', cylG(0.09, 0.09, 2.4, 8, 0.9), 0, 2.45, 0, { rz: Math.PI / 2 });
        emit('roofClay', boxG(2.7, 0.2, 1.8, 1.2), 0, 3.0, 0.45, { rx: 0.42 });
        emit('roofClay', boxG(2.7, 0.2, 1.8, 1.2), 0, 3.0, -0.45, { rx: -0.42 });
        emit('rope', cylG(0.045, 0.045, 1.6, 6, 0.7), 0, 1.75, 0);
        emit('planksDark', boxG(0.5, 0.42, 0.5, 0.8), 0, 1.0, 0.05);
        emit('wicker', boxG(0.4, 0.3, 0.36, 0.7), 0.02, 1.32, 0.04);
      });
      addCollider(well.x, well.z, 1.5, 'well');
      recordSample(well.x, well.y, well.z);
      stats.props += 2;
    }

    const board = spotNear(F.x, F.z, 8, 12, { tries: 50, w: 2.4, d: 1.2, maxRise: 0.8 });
    if (board) {
      place(globalSink, board.x, board.y, board.z, rng.float() * TAU, tint(0.05), (emit) => {
        emit('wood', plankG(0.16, 2.3, 0.16, 0.02), -1.0, 1.15, 0);
        emit('wood', plankG(0.16, 2.3, 0.16, 0.02), 1.0, 1.15, 0);
        emit('planksDark', boxG(2.4, 1.3, 0.14, 1.2), 0, 1.75, 0);
        emit('roofSlate', boxG(2.7, 0.14, 0.7, 1.0), 0, 2.45, 0.02, { rx: 0.16 });
        emit('poster', planeG(0.95, 0.62), -0.55, 1.95, 0.09);
        emit('poster', planeG(0.8, 0.55), 0.5, 1.72, 0.1, { rz: 0.06 });
      });
      stats.props += 2;
      recordSample(board.x, board.y, board.z);
    }

    // planters + barrels around the square
    for (let i = 0; i < (DET > 0 ? 5 : 3); i++) {
      const a = rng.float() * TAU;
      const px = F.x + Math.cos(a) * rng.range(4.5, 8.5);
      const pz = F.z + Math.sin(a) * rng.range(4.5, 8.5);
      const py = groundAt(px, pz);
      place(globalSink, px, py, pz, rng.float() * TAU, tint(0.07), (emit) => {
        emit('stone', cylG(0.46, 0.52, 0.55, 12, 1.0), 0, 0.27, 0);
        emit('canopy', icoG(0.42, 1), 0, 0.72, 0);
        if (DET > 1) emit('canopy', icoG(0.2, 0), 0.3, 0.5, 0.2);
      });
      stats.props++;
      recordSample(px, py, pz);
    }
    for (let i = 0; i < 4; i++) {
      const a = rng.float() * TAU;
      const bx = F.x + Math.cos(a) * rng.range(5, 9.5);
      const bz = F.z + Math.sin(a) * rng.range(5, 9.5);
      const by = groundAt(bx, bz);
      const tiltX = rng.range(-0.1, 0.1);
      place(globalSink, bx, by, bz, rng.float() * TAU, tint(0.08), (emit) => {
        emit('planksDark', latheG('barrel', [[0.03, 0], [0.3, 0], [0.42, 0.22], [0.46, 0.55], [0.42, 0.88], [0.3, 1.05], [0.28, 1.08]], 14, 1.1), 0, 0, 0, { rx: tiltX });
        emit('iron', torusG(0.44, 0.035, 6, 16), 0, 0.28, 0, { rx: Math.PI / 2 });
        emit('iron', torusG(0.45, 0.035, 6, 16), 0, 0.78, 0, { rx: Math.PI / 2 });
      });
      stats.props++;
      recordSample(bx, by, bz);
    }
  }

  // --- laundry lines between two facing houses ---
  {
    let made = 0;
    for (let i = 0; i < houses.length - 1 && made < 2; i++) {
      const a = houses[i];
      if (!a.spot) continue;
      let best = null;
      for (let j = i + 1; j < houses.length; j++) {
        const b = houses[j];
        if (!b.spot || b.side !== a.side) continue;
        const dist = Math.hypot(a.spot.x - b.spot.x, a.spot.z - b.spot.z);
        if (dist > 7 && dist < 22 && (!best || dist < best.d)) best = { b, d: dist };
      }
      if (!best) continue;
      made++;
      const b = best.b;
      const ay = a.spot.y + 4.4, by = b.spot.y + 4.2;
      place(globalSink, 0, 0, 0, 0, WHITE, (emit) => {
        emitLine(emit, 'rope', a.spot.x, ay, a.spot.z, b.spot.x, by, b.spot.z, 0.035);
      });
      stats.props++;
      const count = DET > 0 ? 4 : 3;
      for (let k = 0; k < count; k++) {
        const t = (k + 1) / (count + 1);
        const cloth = new THREE.Mesh(planeG(0.72, 0.95, 3, 2), rng.chance(0.5) ? MAT.fabricTeal : MAT.canvas);
        cloth.castShadow = true; cloth.receiveShadow = true;
        cloth.name = 'props:laundry';
        cloth.position.set(lerp(a.spot.x, b.spot.x, t), lerp(ay, by, t) - 0.48, lerp(a.spot.z, b.spot.z, t));
        cloth.rotation.y = Math.atan2(b.spot.x - a.spot.x, b.spot.z - a.spot.z) + Math.PI / 2;
        group.add(cloth);
        anim.sways.push({ obj: cloth, phase: rng.float() * TAU, amp: 0.17, axis: 'x' });
        stats.props++;
      }
    }
  }

  // --- bicycles leaning on village walls, satchels, barrels ---
  for (let i = 0; i < (DET > 0 ? 3 : 2); i++) {
    const h = houses.length ? houses[rng.irange(0, houses.length - 1)] : null;
    if (!h || !h.spot) continue;
    const sx = h.spot.x + rng.range(-3.4, 3.4);
    const sz = h.spot.z + rng.range(-3.4, 3.4);
    if (layout.onRoad(sx, sz, 1.5)) continue;
    const sy = groundAt(sx, sz);
    const lean = rng.range(0.12, 0.2) * rng.sign();
    place(globalSink, sx, sy, sz, h.spot.ry + rng.range(-0.4, 0.4), tint(0.05), (emit) => {
      emit('iron', torusG(0.34, 0.035, 6, 16), -0.62, 0.35, 0, { ry: Math.PI / 2, rz: lean });
      emit('iron', torusG(0.34, 0.035, 6, 16), 0.62, 0.35, 0, { ry: Math.PI / 2, rz: lean });
      emit('teal', plankG(1.15, 0.06, 0.06, 0.01), 0.02, 0.63, 0, { rz: 0.2 + lean });
      emit('teal', plankG(0.9, 0.06, 0.06, 0.01), -0.34, 0.52, 0, { rz: -0.5 + lean });
      emit('teal', plankG(0.95, 0.05, 0.05, 0.01), 0.3, 0.52, 0, { rz: 0.62 + lean });
      emit('wood', plankG(0.32, 0.07, 0.12, 0.01), 0.62, 0.74, 0, { rz: 0.15 + lean });
      emit('iron', cylG(0.02, 0.02, 0.5, 6, 0.5), 0.58, 0.88, 0, { rz: Math.PI / 2 });
      emit('leather', boxG(0.3, 0.24, 0.34, 0.7), -0.05, 0.8, 0);
      emit('iron', cylG(0.19, 0.19, 0.06, 12, 0.6), 0.05, 0.88, 0);
    });
    stats.props += 3;
    recordSample(sx, sy, sz);
  }
  for (let i = 0; i < 2; i++) {
    const h = houses.length ? houses[rng.irange(0, houses.length - 1)] : null;
    if (!h || !h.spot) continue;
    const sx = h.spot.x + rng.range(-4, 4);
    const sz = h.spot.z + rng.range(-4, 4);
    const sy = groundAt(sx, sz);
    place(globalSink, sx, sy, sz, rng.float() * TAU, tint(0.08), (emit) => {
      emit('leather', boxG(0.5, 0.42, 0.22, 0.6), 0, 0.22, 0, { rx: rng.range(-0.2, 0.2) });
      emit('leather', plankG(0.5, 0.06, 0.05, 0.01), 0, 0.45, 0);
      emit('leather', boxG(0.4, 0.3, 0.18, 0.6), 0.3, 0.16, 0.3, { rz: 0.3 });
    });
    stats.props += 2;
    recordSample(sx, sy, sz);
  }

  /* ======================================================================
   * 2. HARBOR
   * ==================================================================== */

  const H = layout.pois.harbor.position;
  {
    const P1 = { dx: 0.5, dz: 0.866 };
    const P2 = { dx: 0.07, dz: 0.997 };

    function buildPier(px, pz, dir, length) {
      const perp = { dx: -dir.dz, dz: dir.dx };
      const deckY = 2.55;
      const bays = Math.round(length / 3.4);
      for (let i = 0; i <= bays; i++) {
        const t = i / bays;
        const x = px + dir.dx * t * length;
        const z = pz + dir.dz * t * length;
        const g = groundAt(x, z);
        const pileH = clamp(deckY - g + 0.7, 1.2, 8);
        place(globalSink, x, g, z, Math.atan2(dir.dx, dir.dz), tint(0.06), (emit) => {
          emit('planks', boxG(2.9, 0.22, 3.4, 1.1), 0, deckY - g, 1.7);
          emit('planks', boxG(0.24, 0.28, 3.5, 1.0), -1.45, deckY - g + 0.22, 1.7);
          emit('planks', boxG(0.24, 0.28, 3.5, 1.0), 1.45, deckY - g + 0.22, 1.7);
          for (const sx of [-1.05, 1.05]) {
            emit('woodDark', cylG(0.17, 0.19, pileH, 8, 1.0), sx, pileH * 0.5 - 0.4, 0.25);
            emit('woodDark', cylG(0.17, 0.19, pileH, 8, 1.0), sx, pileH * 0.5 - 0.4, 3.15);
          }
        });
        stats.props++;
      }
      const hx = px + dir.dx * length;
      const hz = pz + dir.dz * length;
      const hg = groundAt(hx, hz);
      place(globalSink, hx, hg, hz, Math.atan2(perp.dx, perp.dz), tint(0.06), (emit) => {
        emit('planks', boxG(2.9, 0.22, 7.8, 1.2), 0, deckY - hg, 0);
        for (const sz of [-3.3, -1.1, 1.1, 3.3]) {
          const gp = groundAt(hx + perp.dx * sz, hz + perp.dz * sz);
          const ph = clamp(deckY - gp + 0.7, 1.2, 8);
          emit('woodDark', cylG(0.17, 0.19, ph, 8, 1.0), 0, ph * 0.5 - 0.4, sz);
        }
        emit('rope', torusG(0.34, 0.07, 6, 14), 1.1, 0.5, -2.4, { rx: Math.PI / 2 });
        emit('rope', torusG(0.34, 0.07, 6, 14), -1.1, 0.5, 2.6, { rx: Math.PI / 2 });
        emit('planksDark', boxG(1.1, 0.5, 0.9, 1.0), 0.9, deckY - hg + 0.3, 3.0, {});
      });
      stats.props += 2;
      return { x: hx, z: hz };
    }

    const pierA = buildPier(H.x + 6 * P1.dx, H.z + 6 * P1.dz, P1, 44);
    const pierB = buildPier(H.x + 3 * P2.dx, H.z + 3 * P2.dz, P2, 34);

    // --- fishing boats (four bob on moorings, two are hauled out) ---
    const boatSpots = [
      { x: pierA.x + 3.0, z: pierA.z - 4.4, mob: true, ry: 0.35 },
      { x: pierA.x - 3.2, z: pierA.z + 4.8, mob: true, ry: -0.5 },
      { x: pierB.x + 3.1, z: pierB.z - 8.0, mob: true, ry: 1.2 },
      { x: H.x + 52 * P1.dx - 5, z: H.z + 52 * P1.dz + 11, mob: true, ry: 2.1 },
      { x: H.x + 34 * P2.dx + 10, z: H.z + 34 * P2.dz - 7, mob: false, ry: 0.8 },
      { x: H.x + 15, z: H.z + 27, mob: false, ry: 2.6 },
    ];
    for (let bi = 0; bi < boatSpots.length; bi++) {
      const b = boatSpots[bi];
      const len = rng.range(4.6, 6.2);
      const beam = len * rng.range(0.3, 0.36);
      const depth = beam * 0.62;
      const t = tint(0.1);
      const build = (emit) => {
        emit('planks', hullG(len, beam, depth), 0, 0, 0);
        emit('wood', plankG(len * 0.92, 0.1, 0.16, 0.02), 0, 0.06, beam * 0.47);
        emit('wood', plankG(len * 0.92, 0.1, 0.16, 0.02), 0, 0.06, -beam * 0.47);
        emit('planks', boxG(len * 0.42, 0.09, beam * 0.8, 0.9), -len * 0.16, 0.03, 0);
        emit('planks', boxG(len * 0.3, 0.09, beam * 0.78, 0.9), len * 0.2, 0.03, 0);
        emit('woodDark', cylG(0.09, 0.11, 5.4, 8, 1.0), len * 0.06, 2.7, 0);
        emit('wood', cylG(0.05, 0.05, len * 0.7, 6, 0.8), len * 0.16, 0.62, 0, { rz: Math.PI / 2 });
        emit('canvas', cylG(0.16, 0.16, len * 0.62, 8, 1.0), len * 0.16, 0.86, 0, { rz: Math.PI / 2 });
        emit('rope', torusG(0.2, 0.05, 5, 12), len * 0.2, 0.5, 0.1, { rx: Math.PI / 2 });
        emit('wicker', boxG(0.6, 0.42, 0.5, 0.8), -len * 0.28, 0.32, 0.2);
        emit('iron', torusG(0.22, 0.04, 5, 12), -len * 0.44, 0.1, 0);
        emit('teal', boxG(0.5, 0.36, 0.42, 0.8), len * 0.34, 0.3, -0.2);
      };
      if (b.mob) {
        const holder = new THREE.Group();
        const sink = new LocalSink();
        place(sink, 0, 0, 0, 0, t, build);
        sink.build(holder);
        holder.position.set(b.x, 0, b.z);
        holder.rotation.y = b.ry;
        group.add(holder);
        anim.boats.push({ obj: holder, y: 0, phase: rng.float() * TAU, sp: rng.range(0.7, 1.15), amp: rng.range(0.06, 0.13) });
        const skirt = new THREE.Mesh(planeG(1.6, 1.15, 3, 2), MAT.sail);
        skirt.castShadow = true; skirt.receiveShadow = true;
        skirt.name = 'props:sail';
        skirt.position.set(len * 0.16, 1.45, 0);
        skirt.rotation.y = Math.PI / 2;
        holder.add(skirt);
        anim.sways.push({ obj: skirt, phase: rng.float() * TAU, amp: 0.09, axis: 'z' });
      } else {
        place(globalSink, b.x, 0, b.z, b.ry, t, build);
      }
      addCollider(b.x, b.z, 2, 'boat');
      stats.props += 4;
    }

    // --- rowboats pulled up on the sand ---
    for (let i = 0; i < 2; i++) {
      const rx = H.x + rng.range(-28, 16);
      const rz = H.z - rng.range(8, 28);
      if (layout.heightAt(rx, rz) < 0.45) continue;
      const sy = groundAt(rx, rz);
      const ry = rng.float() * TAU;
      const tilt = rng.range(-0.09, 0.09);
      place(globalSink, rx, sy, rz, ry, tint(0.09), (emit) => {
        emit('planks', hullG(4.2, 1.5, 0.72), 0, 0.34, 0, { rz: tilt });
        emit('wood', plankG(3.7, 0.09, 0.14, 0.02), 0, 0.4, 0.7, { rz: tilt });
        emit('wood', plankG(3.7, 0.09, 0.14, 0.02), 0, 0.4, -0.7, { rz: tilt });
        emit('planks', boxG(1.6, 0.08, 1.25, 0.9), -0.3, 0.34, 0, { rz: tilt });
        emit('wood', cylG(0.045, 0.045, 2.4, 6, 0.7), 0.5, 0.44, 0.5, { rz: Math.PI / 2 + 0.1 });
        emit('wood', cylG(0.045, 0.045, 2.4, 6, 0.7), 0.62, 0.42, -0.6, { rz: Math.PI / 2 - 0.05 });
      });
      addCollider(rx, rz, 1.6, 'boat');
      recordSample(rx, sy, rz);
      stats.props += 2;
    }

    // --- fish market stall ---
    const market = spotNear(H.x, H.z, 12, 26, { tries: 70, w: 6, d: 4, maxRise: 0.8, clear: { road: 10, poi: 0, river: 8, maxSlope: 0.28 } });
    if (market) {
      place(globalSink, market.x, market.y, market.z, rng.float() * TAU, tint(0.05), (emit) => {
        for (const px of [-2.1, 2.1]) {
          for (const pz of [-1.5, 1.5]) emit('wood', plankG(0.14, 2.4, 0.14, 0.02), px, 1.2, pz);
        }
        emit('planks', boxG(4.6, 0.16, 1.5, 1.2), 0, 0.95, 0.5);
        emit('planksDark', boxG(4.6, 0.85, 0.14, 1.0), 0, 0.5, 1.2);
        emit('roofSlate', boxG(5.2, 0.14, 4.2, 1.4), 0, 2.5, 0, { rx: 0.1 });
        for (let i = 0; i < 4; i++) {
          emit('wicker', boxG(0.82, 0.4, 0.6, 0.9), -1.8 + i * 1.2, 1.23, 0.5);
          for (let f = 0; f < 4; f++) {
            emit('metal', latheG('fish', [[0.02, -0.04], [0.11, -0.02], [0.12, 0.04], [0.02, 0.06]], 8, 0.5),
              -1.8 + i * 1.2 + (f % 2) * 0.22 - 0.1, 1.5, 0.4 + Math.floor(f / 2) * 0.18, { ry: rng.float() * TAU });
          }
        }
        for (let i = 0; i < 3; i++) {
          emit('planks', boxG(1.1, 0.62, 0.8, 1.0), -3.7, 0.31, -2.2 + i * 1.0, { ry: rng.range(-0.3, 0.3) });
          emit('planksDark', boxG(1.2, 0.1, 0.9, 1.0), -3.7, 0.66, -2.2 + i * 1.0, { rx: 0.06 });
          emit('rope', torusG(0.16, 0.04, 5, 12), -3.7, 0.74, -2.2 + i * 1.0, { rx: Math.PI / 2 });
        }
      });
      addCollider(market.x, market.z, 2.6, 'building');
      recordSample(market.x, market.y, market.z);
      stats.buildings++;
      stats.props += 6;
      addFlag(market.x - 4.5, market.z + 4.5, 1.3, 'fabricTeal');
    }

    // --- two plank storage sheds ---
    for (let i = 0; i < 2; i++) {
      const sp = spotNear(H.x, H.z, 20, 40, { tries: 70, w: 5, d: 4.4, maxRise: 0.8, clear: { road: 10, poi: 0, river: 8, maxSlope: 0.26 } });
      if (!sp) continue;
      const t = tint(0.08);
      const ry = rng.float() * TAU;
      place(globalSink, sp.x, sp.y, sp.z, ry, t, (emit) => {
        emit('stone', boxG(4.4, 0.7, 3.9, 1.6), 0, 0.35, 0);
        emit('planks', boxG(4.0, 2.5, 3.5, 1.4), 0, 1.95, 0);
        emit('planksDark', boxG(4.6, 0.2, 4.1, 1.2), 0, 3.25, 0.4, { rx: 0.3 });
        emit('planksDark', boxG(4.6, 0.2, 4.1, 1.2), 0, 3.25, -0.4, { rx: -0.3 });
        emit('planks', triG(3.6, 0.85, 0.2), 2.0, 3.55, 0, { ry: Math.PI / 2 });
        emit('planks', triG(3.6, 0.85, 0.2), -2.0, 3.55, 0, { ry: Math.PI / 2 });
        emit('planksDark', plankG(1.5, 1.9, 0.12, 0.02), 0.6, 1.0, 1.78);
        emit('wood', plankG(1.7, 0.14, 0.2, 0.02), 0.6, 2.02, 1.8);
        emit('iron', plankG(0.3, 0.05, 0.14, 0.01), 0.25, 1.5, 1.85);
        emit('iron', plankG(0.3, 0.05, 0.14, 0.01), 0.25, 0.6, 1.85);
        emit('rope', torusG(0.3, 0.06, 5, 14), -1.4, 0.06, 2.2, { rx: Math.PI / 2 });
        emit('rope', torusG(0.3, 0.06, 5, 14), -1.4, 0.15, 2.2, { rx: Math.PI / 2 });
      });
      addCollider(sp.x, sp.z, 3.2, 'building');
      recordSample(sp.x, sp.y, sp.z);
      stats.buildings++;
      stats.props += 3;
    }

    // --- nets, lobster pots, buoys, anchor ---
    for (let i = 0; i < 3; i++) {
      const a = rng.float() * TAU;
      const nx = H.x + Math.cos(a) * rng.range(14, 30);
      const nz = H.z + Math.sin(a) * rng.range(14, 30);
      if (layout.heightAt(nx, nz) < 0.35) continue;
      const ny = groundAt(nx, nz);
      place(globalSink, nx, ny, nz, rng.float() * TAU, tint(0.05), (emit) => {
        emit('wood', plankG(0.12, 2.2, 0.12, 0.02), -1.4, 1.1, 0);
        emit('wood', plankG(0.12, 2.2, 0.12, 0.02), 1.4, 1.1, 0);
        emit('wood', plankG(2.9, 0.12, 0.12, 0.02), 0, 2.1, 0);
        emit('rope', latticeG(2.7, 1.9, 7, 5, 0.055), 0, 1.05, 0.06, { rx: rng.range(-0.12, 0.12) });
        emit('rope', latticeG(2.6, 1.7, 6, 4, 0.05), 0.05, 1.0, -0.1, { rx: rng.range(-0.1, 0.1) });
      });
      stats.props += 2;
      recordSample(nx, ny, nz);
    }
    for (let i = 0; i < 4; i++) {
      const a = rng.float() * TAU;
      const px = H.x + Math.cos(a) * rng.range(12, 28);
      const pz = H.z + Math.sin(a) * rng.range(12, 28);
      if (layout.heightAt(px, pz) < 0.25) continue;
      const py = groundAt(px, pz);
      place(globalSink, px, py, pz, rng.float() * TAU, tint(0.07), (emit) => {
        emit('wicker', latheG('pot', [[0.3, 0], [0.34, 0.35], [0.28, 0.62], [0.32, 0.66]], 10, 0.8), 0, 0, 0);
        emit('rope', torusG(0.32, 0.04, 5, 12), 0, 0.6, 0, { rx: Math.PI / 2 });
        emit('rope', torusG(0.26, 0.04, 5, 12), 0, 0.86, 0, { rx: Math.PI / 2 });
      });
      stats.props++;
      recordSample(px, py, pz);
    }
    for (let i = 0; i < 6; i++) {
      const bx = H.x + rng.range(22, 44);
      const bz = H.z + rng.range(8, 42);
      if (groundAt(bx, bz) > -0.8) continue;
      const base = i % 2 === 0 ? 'fabricRed' : 'canvas';
      place(globalSink, bx, 0, bz, rng.float() * TAU, WHITE, (emit) => {
        emit(base, latheG('buoy', [[0.08, 0.52], [0.24, 0.4], [0.46, 0.2], [0.5, -0.15], [0.38, -0.3]], 12, 0.9), 0, 0.05, 0, { rz: rng.range(-0.12, 0.12) });
        emit('iron', torusG(0.14, 0.04, 5, 12), 0, 0.62, 0, { rx: Math.PI / 2 });
        emit('canvas', cylG(0.1, 0.16, 0.24, 8, 0.6), 0, 0.76, 0);
      });
      stats.props++;
    }
    const anc = spotNear(H.x, H.z, 16, 30, { tries: 50, w: 3, d: 2, maxRise: 0.8 });
    if (anc) {
      place(globalSink, anc.x, anc.y, anc.z, rng.float() * TAU, tint(0.04), (emit) => {
        emit('iron', cylG(0.08, 0.08, 2.0, 8, 1.0), 0, 0.1, 0, { rz: Math.PI / 2 });
        emit('iron', cylG(0.07, 0.07, 0.9, 8, 0.9), 0, 0.45, 0);
        emit('iron', cylG(0.06, 0.06, 1.0, 8, 0.9), -0.5, 0.1, 0.35, { rz: Math.PI / 2, ry: 0.6 });
        emit('iron', cylG(0.06, 0.06, 1.0, 8, 0.9), 0.55, 0.1, -0.3, { rz: Math.PI / 2, ry: -0.6 });
        emit('rope', torusG(0.35, 0.06, 5, 14), 1.3, 0.08, 0, { rx: Math.PI / 2 });
        emit('rope', torusG(0.3, 0.06, 5, 14), 1.3, 0.17, 0, { rx: Math.PI / 2 });
      });
      stats.props += 2;
      recordSample(anc.x, anc.y, anc.z);
    }
  }

  /* ======================================================================
   * 3. WINDMILL
   * ==================================================================== */

  {
    const W = layout.pois.windmill.position;
    const wy = groundAt(W.x, W.z);
    const capRy = 0.75 + rng.range(-0.25, 0.25);
    const hubY = 12.15;
    const shaftX = Math.sin(capRy), shaftZ = Math.cos(capRy);
    const tintW = tint(0.05);
    place(globalSink, W.x, wy, W.z, capRy, tintW, (emit, f) => {
      // stone tower, wooden balcony, timber cap with tail pole
      emit('stone', latheG('millBase', [[4.45, 0], [4.4, 0.7], [3.55, 5.5], [3.2, 6.3]], 18, 2.0), 0, 0, 0);
      emit('stone', cylG(3.02, 3.2, 3.4, 18, 1.9), 0, 8.0, 0);
      emit('planksDark', cylG(3.9, 3.9, 0.2, 18, 1.6), 0, 6.35, 0);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * TAU;
        emit('wood', plankG(0.1, 0.9, 0.1, 0.02), Math.cos(a) * 3.8, 6.85, Math.sin(a) * 3.8, { ry: -a });
      }
      emit('wood', torusG(3.8, 0.07, 5, 22), 0, 7.25, 0, { rx: Math.PI / 2 });
      emit('planksDark', latheG('millCap', [[3.3, 9.6], [3.3, 10.1], [2.7, 10.9], [1.3, 11.4], [0.3, 11.5]], 18, 1.6), 0, 0, 0);
      emit('planksDark', plankG(0.24, 4.4, 0.24, 0.03), 0, 10.6, -2.5, { rz: 1.12 });
      emit('wood', plankG(0.16, 1.3, 0.16, 0.02), 0, 12.4, -3.3);
      emit('iron', cylG(0.42, 0.42, 0.8, 12, 1.0), 0, hubY, 3.5, { rx: Math.PI / 2 });
      // low door and a couple of small windows in the tower
      emit('planksDark', plankG(1.0, 1.9, 0.14, 0.02), 0, 0.95, 4.05);
      emit('wood', plankG(1.3, 0.16, 0.24, 0.03), 0, 2.0, 4.05);
      emit('glass', boxG(0.62, 0.72, 0.16, 0.72), 0.6, 3.1, 4.0);
      emit('glass', boxG(0.62, 0.72, 0.16, 0.72), -0.7, 3.1, 3.98);
      addLampRef(f, 0.6, 3.1, 4.1, MAT.glass, 'window');
    });
    addCollider(W.x, W.z, 3.0, 'windmill');
    recordSample(W.x, wy, W.z);
    stats.buildings++;
    stats.props += 2;

    // the four lattice sails spin slowly
    const hubX = W.x + shaftX * 3.5;
    const hubZ = W.z + shaftZ * 3.5;
    const parent = new THREE.Group();
    parent.position.set(hubX, wy + hubY, hubZ);
    parent.rotation.y = capRy;
    const spinner = new THREE.Group();
    const sink = new LocalSink();
    place(sink, 0, 0, 0, 0, WHITE, (emit) => {
      emit('planksDark', cylG(0.5, 0.5, 1.0, 10, 1.2), 0, 0, 0, { rx: Math.PI / 2 });
      for (let i = 0; i < 4; i++) {
        const a = i * (TAU / 4) + 0.16;
        const ca = Math.cos(a), sa = Math.sin(a);
        emit('planksDark', plankG(7.9, 0.18, 0.3, 0.03), ca * 3.95, sa * 3.95, 0, { rz: a });
        const ox = ca * 4.35 - sa * 0.86;
        const oy = sa * 4.35 + ca * 0.86;
        emit('planksDark', latticeG(1.2, 6.6, 2, 10, 0.08), ox, oy, 0.06, { rz: a });
        emit('sail', planeG(1.2, 6.6, 1, 4), ox, oy, 0.14, { rz: a });
      }
    });
    sink.build(spinner);
    parent.add(spinner);
    group.add(parent);
    anim.spins.push({ obj: spinner, speed: 0.4, phase: rng.float() * TAU });

    // miller's cottage beside the tower
    const cot = spotNear(W.x, W.z, 16, 26, { tries: 70, w: 8, d: 7, maxRise: 0.8 });
    if (cot) {
      const t = tint(0.08);
      place(globalSink, cot.x, cot.y, cot.z, rng.float() * TAU, t, (emit, f) => buildHouse(emit, f, HOUSE_KINDS[3], t));
      addCollider(cot.x, cot.z, 4.2, 'building');
      recordSample(cot.x, cot.y, cot.z);
    }
    // wheat sacks + the miller's cart
    for (let i = 0; i < 5; i++) {
      const a = rng.float() * TAU;
      const sx = W.x + Math.cos(a) * rng.range(5.5, 9);
      const sz = W.z + Math.sin(a) * rng.range(5.5, 9);
      const sy = groundAt(sx, sz);
      place(globalSink, sx, sy, sz, rng.float() * TAU, tint(0.07), (emit) => {
        emit('canvas', latheG('sack', [[0.08, 0], [0.34, 0.06], [0.4, 0.32], [0.32, 0.58], [0.16, 0.72], [0.11, 0.8]], 12, 0.9), 0, 0, 0, { rz: rng.range(-0.16, 0.16) });
      });
      stats.props++;
      recordSample(sx, sy, sz);
    }
    const cart = spotNear(W.x, W.z, 12, 20, { tries: 60, w: 4.5, d: 2.5, maxRise: 0.8 });
    if (cart) {
      place(globalSink, cart.x, cart.y, cart.z, rng.float() * TAU, tint(0.06), (emit) => {
        emit('planks', boxG(1.5, 0.16, 3.1, 1.2), 0, 0.95, 0);
        for (const sz of [-1.3, 1.3]) emit('planksDark', boxG(1.5, 0.7, 0.12, 1.0), 0, 1.3, sz);
        emit('planksDark', boxG(0.12, 0.7, 2.5, 1.0), -0.7, 1.3, 0);
        emit('planksDark', boxG(0.12, 0.7, 2.5, 1.0), 0.7, 1.3, 0);
        for (const sz of [-1.1, 1.1]) {
          emit('woodDark', torusG(0.62, 0.14, 6, 16), 0, 0.62, sz, { ry: Math.PI / 2 });
          for (let sp = 0; sp < 4; sp++) {
            emit('wood', plankG(1.1, 0.07, 0.07, 0.01), 0, 0.62, sz, { rx: sp * 0.785, rz: Math.PI / 2 });
          }
        }
        emit('iron', cylG(0.05, 0.05, 1.7, 6, 0.6), -0.78, 0.72, 1.9, { rz: Math.PI / 2 });
        emit('iron', cylG(0.05, 0.05, 1.7, 6, 0.6), 0.78, 0.72, 1.9, { rz: Math.PI / 2 });
        emit('canvas', latheG('sack', [[0.08, 0], [0.34, 0.06], [0.4, 0.32], [0.32, 0.58], [0.16, 0.72], [0.11, 0.8]], 12, 0.9), -0.3, 1.03, 0.5, { rz: 0.2 });
        emit('canvas', latheG('sack', [[0.08, 0], [0.34, 0.06], [0.4, 0.32], [0.32, 0.58], [0.16, 0.72], [0.11, 0.8]], 12, 0.9), 0.2, 1.03, -0.4, { rz: -0.4, sy: 0.9 });
      });
      addCollider(cart.x, cart.z, 2.2, 'cart');
      recordSample(cart.x, cart.y, cart.z);
      stats.props += 2;
    }
  }

  /* ======================================================================
   * 4. WATERMILL (house on the terrace, leat down the ravine, wheel in the river)
   * ==================================================================== */

  /** Wooden footbridge across the gorge, following the real bank heights. */
  function buildFootbridge(px, pz, tx, tz, opts) {
    const o = opts || EMPTY;
    const rx = -tz, rz = tx;
    const maxHalf = o.maxHalf || 18;
    const need = groundAt(px, pz) + (o.bankRise || 7.5);
    let sA = maxHalf, sB = maxHalf;
    for (let s = 2; s <= maxHalf; s += 1.1) {
      if (groundAt(px + rx * s, pz + rz * s) > need) { sA = s; break; }
    }
    for (let s = 2; s <= maxHalf; s += 1.1) {
      if (groundAt(px - rx * s, pz - rz * s) > need) { sB = s; break; }
    }
    const ax = px + rx * sA, az = pz + rz * sA;
    const bx = px - rx * sB, bz = pz - rz * sB;
    const deckY = Math.max(groundAt(ax, az), groundAt(bx, bz)) + 0.9;
    const len = Math.hypot(bx - ax, bz - az);
    const midX = (ax + bx) * 0.5, midZ = (az + bz) * 0.5;
    const ry = Math.atan2(bx - ax, bz - az);
    const bays = Math.max(5, Math.round(len / 2.4));
    place(globalSink, midX, 0, midZ, ry, tint(0.06), (emit) => {
      for (let i = 0; i < bays; i++) {
        const lz = (i + 0.5) / bays * len - len / 2;
        emit('planks', boxG(1.9, 0.16, len / bays + 0.05, 1.2), 0, deckY, lz);
      }
      emit('wood', plankG(len, 0.14, 0.16, 0.02), -0.85, deckY + 0.85, 0, { rx: Math.PI / 2 });
      emit('wood', plankG(len, 0.14, 0.16, 0.02), 0.85, deckY + 0.85, 0, { rx: Math.PI / 2 });
      emit('wood', plankG(len, 0.1, 0.12, 0.02), -0.85, deckY + 0.45, 0, { rx: Math.PI / 2 });
      emit('wood', plankG(len, 0.1, 0.12, 0.02), 0.85, deckY + 0.45, 0, { rx: Math.PI / 2 });
      const posts = Math.max(3, Math.round(len / 2.6));
      for (let i = 0; i <= posts; i++) {
        const lz = (i / posts) * len - len / 2;
        for (const sx of [-0.85, 0.85]) emit('woodDark', plankG(0.13, 1.1, 0.13, 0.02), sx, deckY + 0.62, lz);
      }
      for (const t of [0.34, 0.66]) {
        const lz = t * len - len / 2;
        const wx = midX + Math.sin(ry) * lz;
        const wz = midZ + Math.cos(ry) * lz;
        const g = groundAt(wx, wz);
        const hgt = Math.max(0.6, deckY - 0.1 - g);
        for (const sx of [-0.75, 0.75]) {
          emit('woodDark', cylG(0.17, 0.2, hgt, 8, 1.0), sx, g + hgt * 0.5, lz);
        }
        emit('wood', plankG(1.7, 0.16, 0.16, 0.02), 0, g + hgt - 0.2, lz);
      }
      for (const e of [-1, 1]) {
        emit('stone', boxG(2.3, 1.4, 1.2, 1.6), 0, deckY - 0.8, e * (len / 2 + 0.3));
      }
    });
    stats.props += 4;
    recordSample(ax, groundAt(ax, az), az);
    recordSample(bx, groundAt(bx, bz), bz);
    return { midX, midZ, deckY, len };
  }

  {
    const M = layout.pois.mill.position;
    const my = groundAt(M.x, M.z);
    // nearest point on the river sets the down-slope direction
    let rbx = 0, rbz = 0, rbd = Infinity;
    const rn = layout.riverSamples.length / 2;
    for (let i = 0; i < rn; i++) {
      const dx = layout.riverSamples[i * 2] - M.x;
      const dz = layout.riverSamples[i * 2 + 1] - M.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < rbd) { rbd = d2; rbx = layout.riverSamples[i * 2]; rbz = layout.riverSamples[i * 2 + 1]; }
    }
    const riverLen = Math.sqrt(rbd) || 1;
    const dirX = (rbx - M.x) / riverLen;
    const dirZ = (rbz - M.z) / riverLen;
    const ry = Math.atan2(dirX, dirZ);        // local +Z points at the river
    const perpX = -dirZ, perpZ = dirX;
    const toWorld = (lx, lz) => ({
      x: M.x + Math.cos(ry) * lx + Math.sin(ry) * lz,
      z: M.z - Math.sin(ry) * lx + Math.cos(ry) * lz,
    });

    // --- mill house straddling the leat (channel passes between two blocks) ---
    const tintM = tint(0.05);
    place(globalSink, M.x, my, M.z, ry, tintM, (emit, f) => {
      const bw = 3.5, bd = 7.2, bh = 5.2, gap = 0.85;
      for (const sx of [-1, 1]) {
        const ox = sx * (gap + bw / 2);
        emit('stone', boxG(bw, 1.6, bd + 0.4, 1.8), ox, -0.8, 0);
        emit('stone', boxG(bw, bh, bd, 2.2), ox, 2.3, 0);
        emit('stone', boxG(bw + 0.4, 0.9, bd + 0.4, 1.6), ox, 5.1, 0);
        // gable + roof slab per block
        emit('stone', triG(bd, 1.7, 0.34), ox + sx * (bw / 2 - 0.17), 6.2, 0, { ry: Math.PI / 2 });
        emit('roofSlate', boxG(bw + 0.7, 0.24, Math.hypot(bd / 2 + 0.5, 1.7) + 0.2, 1.5), ox, 6.15, bd / 4 + 0.25, { rx: Math.atan2(1.7, bd / 2 + 0.5) });
        emit('roofSlate', boxG(bw + 0.7, 0.24, Math.hypot(bd / 2 + 0.5, 1.7) + 0.2, 1.5), ox, 6.15, -(bd / 4 + 0.25), { rx: -Math.atan2(1.7, bd / 2 + 0.5) });
        emit('stone', boxG(0.7, 2.6, 0.7, 1.4), ox + sx * 0.9, 6.6, -bd * 0.3);
        addChimney(f, ox + sx * 0.9, 8.0, -bd * 0.3, 0.6);
      }
      // the stone arch over the channel + a plank lintel
      emit('stone', boxG(gap * 2, 1.0, 1.0, 1.2), 0, 3.3, 0);
      emit('wood', plankG(2.2, 0.22, 0.3, 0.03), 0, 2.9, -bd / 2 + 0.2);
      // channel walls running through the building
      for (const sx of [-1, 1]) {
        emit('stone', boxG(0.42, 1.1, bd + 1.2, 1.4), sx * gap, 0.15, 0);
      }
      emit('stone', boxG(gap * 2, 0.24, bd + 1.2, 1.4), 0, -0.32, 0);
      emit('water', planeG(gap * 2 - 0.1, bd), 0, 0.06, 0, { rx: -Math.PI / 2 });
      // doors, windows, millstones, sacks
      emit('planksDark', plankG(1.1, 2.1, 0.14, 0.02), -bw - 0.6, 1.1, 1.6, { ry: -Math.PI / 2 });
      emit('wood', plankG(1.4, 0.16, 0.26, 0.03), -bw - 0.6, 2.3, 1.6, { ry: -Math.PI / 2 });
      emit('glass', boxG(0.9, 1.1, 0.16, 1.1), -gap - 1.0, 3.2, bd / 2 + 0.02);
      emit('glass', boxG(0.9, 1.1, 0.16, 1.1), gap + 0.9, 3.2, bd / 2 + 0.02);
      emit('stone', boxG(1.4, 0.3, 1.0, 1.2), -bw - 0.6, 0.15, 2.6);
      emit('stone', cylG(0.85, 0.85, 0.34, 16, 1.4), 2.6, 0.17, 5.2, { rx: Math.PI / 2 });
      emit('stone', cylG(0.85, 0.85, 0.34, 16, 1.4), 3.4, 0.17, 4.4, { rx: Math.PI / 2, rz: 0.2 });
      emit('stone', cylG(0.2, 0.2, 0.5, 10, 1.0), 2.6, 0.42, 5.2);
      emit('canvas', latheG('sack', [[0.08, 0], [0.34, 0.06], [0.4, 0.32], [0.32, 0.58], [0.16, 0.72], [0.11, 0.8]], 12, 0.9), -2.9, 0, -4.4, { rz: 0.2 });
      emit('canvas', latheG('sack', [[0.08, 0], [0.34, 0.06], [0.4, 0.32], [0.32, 0.58], [0.16, 0.72], [0.11, 0.8]], 12, 0.9), -3.2, 0, -5.2, { rz: -0.3, sy: 0.95 });
      emit('canvas', latheG('sack', [[0.08, 0], [0.34, 0.06], [0.4, 0.32], [0.32, 0.58], [0.16, 0.72], [0.11, 0.8]], 12, 0.9), -2.4, 0, -5.6, { rz: 0.5, sy: 0.85 });
      addLampRef(f, -gap - 1.0, 3.2, bd / 2 + 0.1, MAT.glass, 'window');
      addLampRef(f, gap + 0.9, 3.2, bd / 2 + 0.1, MAT.glass, 'window');
    });
    addCollider(toWorld(-2.2, 0).x, toWorld(-2.2, 0).z, 4.0, 'building');
    addCollider(toWorld(2.2, 0).x, toWorld(2.2, 0).z, 4.0, 'building');
    recordSample(M.x, my, M.z);
    stats.buildings++;
    stats.props += 6;

    // sluice gate + windlass at the head of the leat
    const head = toWorld(0.9, -9.5);
    const headY = groundAt(head.x, head.z);
    place(globalSink, head.x, headY, head.z, ry, tintM, (emit) => {
      emit('woodDark', plankG(0.24, 3.0, 0.24, 0.03), -1.1, 1.5, 0);
      emit('woodDark', plankG(0.24, 3.0, 0.24, 0.03), 1.1, 1.5, 0);
      emit('wood', plankG(2.6, 0.22, 0.26, 0.03), 0, 3.0, 0);
      emit('planksDark', boxG(2.1, 1.5, 0.16, 1.1), 0, 0.75, 0.05);
      emit('iron', plankG(0.5, 0.08, 0.2, 0.01), 0, 1.5, 0.16);
      emit('iron', cylG(0.13, 0.13, 1.6, 8, 0.8), 0, 3.3, 0, { rz: Math.PI / 2 });
      emit('iron', cylG(0.05, 0.05, 0.9, 6, 0.6), 0.85, 3.3, 0, { ry: 0.4 });
      emit('wood', plankG(0.5, 0.1, 0.14, 0.02), 1.15, 3.6, 0.25, { rz: 0.5 });
    });
    stats.props += 2;

    // --- the leat: timber trough on trestles, following the ravine ---
    const wheelT = 0.92;
    const wheelX = M.x + dirX * riverLen * wheelT;
    const wheelZ = M.z + dirZ * riverLen * wheelT;
    const wheelGround = groundAt(wheelX, wheelZ);
    const segments = clamp(Math.round(Math.hypot(wheelX - head.x, wheelZ - head.z) / 4.2), 6, 30);
    let prevX = head.x, prevZ = head.z;
    let prevY = headY + 0.4;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const x = lerp(head.x, wheelX, t);
      const z = lerp(head.z, wheelZ, t);
      const g = groundAt(x, z);
      const y = Math.max(g + 0.75, lerp(prevY, wheelGround + 3.4, 0.34));
      const mx = (prevX + x) * 0.5, mz = (prevZ + z) * 0.5;
      const dxs = x - prevX, dzs = z - prevZ, dys = y - prevY;
      const hlen = Math.hypot(dxs, dzs) || 1;
      const segLen = Math.hypot(dxs, dys, dzs);
      const segRy = Math.atan2(dxs, dzs);
      const segRx = -Math.atan2(dys, hlen);
      const sTint = tintM;
      place(globalSink, mx, (prevY + y) * 0.5, mz, segRy, sTint, (emit) => {
        emit('planksDark', boxG(2.3, 0.2, segLen + 0.2, 1.2), 0, 0, 0, { rx: segRx });
        emit('planksDark', boxG(0.3, 0.62, segLen + 0.2, 1.2), -1.05, 0.42, 0, { rx: segRx });
        emit('planksDark', boxG(0.3, 0.62, segLen + 0.2, 1.2), 1.05, 0.42, 0, { rx: segRx });
        emit('water', boxG(1.7, 0.1, segLen, 1.0), 0, 0.24, 0, { rx: segRx });
      });
      // trestle under the joint
      const th = y - groundAt(x, z);
      if (th > 0.5) {
        place(globalSink, x, groundAt(x, z), z, segRy, sTint, (emit) => {
          emit('woodDark', plankG(0.16, th, 0.16, 0.02), -0.95, th / 2, 0);
          emit('woodDark', plankG(0.16, th, 0.16, 0.02), 0.95, th / 2, 0);
          emit('wood', plankG(2.1, 0.14, 0.14, 0.02), 0, Math.max(0.2, th - 0.5), 0);
        });
      }
      prevX = x; prevZ = z; prevY = y;
      stats.props++;
    }

    // --- wheel pit: stone race + the big waterwheel ---
    const pitY = groundAt(wheelX, wheelZ);
    place(globalSink, wheelX, pitY, wheelZ, ry, tintM, (emit) => {
      emit('stone', boxG(0.9, 2.4, 11.5, 1.8), -2.5, 1.0, 0);
      emit('stone', boxG(0.9, 2.4, 11.5, 1.8), 2.5, 1.0, 0);
      emit('stone', boxG(6.0, 0.5, 11.5, 1.8), 0, -0.2, 0);
      emit('water', boxG(4.2, 0.14, 11.0, 1.2), 0, 0.35, 0);
    });
    stats.props += 2;
    addCollider(wheelX + perpX * 3.0, wheelZ + perpZ * 3.0, 2.2, 'millrace');

    const wheelY = pitY + 2.55;
    const wheelParent = new THREE.Group();
    wheelParent.position.set(wheelX, wheelY, wheelZ);
    wheelParent.rotation.y = ry;
    const wheelSpin = new THREE.Group();
    const wheelSink = new LocalSink();
    place(wheelSink, 0, 0, 0, 0, WHITE, (emit) => {
      emit('woodDark', torusG(2.85, 0.13, 6, 26), 0, 0, 0, { ry: Math.PI / 2 });
      emit('woodDark', torusG(2.5, 0.1, 5, 22), 0, 0, 0, { ry: Math.PI / 2 });
      emit('woodDark', cylG(0.45, 0.45, 1.6, 10, 1.1), 0, 0, 0, { rz: Math.PI / 2 });
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        emit('wood', plankG(5.4, 0.14, 0.16, 0.02), 0, 0, 0, { rx: a, rz: Math.PI / 2 });
        emit('planksDark', boxG(1.7, 0.12, 0.95, 1.0), 0, Math.cos(a) * 2.62, Math.sin(a) * 2.62, { rx: a });
      }
    });
    wheelSink.build(wheelSpin);
    wheelParent.add(wheelSpin);
    group.add(wheelParent);
    anim.spins.push({ obj: wheelSpin, speed: -0.55, phase: 0 });

    // wheel house on the bank, feeding the flume into the wheel
    const housePoint = { x: wheelX - dirX * 10.5, z: wheelZ - dirZ * 10.5 };
    const houseY = groundAt(housePoint.x, housePoint.z);
    place(globalSink, housePoint.x, houseY, housePoint.z, ry, tint(0.06), (emit) => {
      emit('stone', boxG(4.6, 0.9, 4.2, 1.8), 0, -0.35, 0);
      emit('planks', boxG(4.2, 2.7, 3.8, 1.4), 0, 1.65, 0);
      emit('planksDark', boxG(4.8, 0.2, 4.3, 1.2), 0, 3.0, 0.4, { rx: 0.3 });
      emit('planksDark', boxG(4.8, 0.2, 4.3, 1.2), 0, 3.0, -0.4, { rx: -0.3 });
      emit('planks', triG(3.8, 0.9, 0.2), 2.1, 3.35, 0, { ry: Math.PI / 2 });
      emit('planks', triG(3.8, 0.9, 0.2), -2.1, 3.35, 0, { ry: Math.PI / 2 });
      emit('planksDark', plankG(1.3, 1.9, 0.12, 0.02), 0, 0.95, 1.92);
      emit('iron', cylG(0.11, 0.11, 2.2, 8, 0.9), 0, 1.6, 0, { rz: Math.PI / 2 });
      emit('iron', cylG(0.07, 0.07, 0.9, 6, 0.7), 0, 2.2, 1.1, { rz: Math.PI / 2, ry: 0.5 });
    });
    addCollider(housePoint.x, housePoint.z, 3.2, 'building');
    recordSample(housePoint.x, houseY, housePoint.z);
    stats.buildings++;
    stats.props += 2;

    // old wooden footbridge over the gorge, just downstream of the wheel
    buildFootbridge(wheelX + perpX * 2, wheelZ + perpZ * 2, dirX, dirZ, { maxHalf: 19, bankRise: 8 });
  }

  /* ======================================================================
   * 5. FARMS, ORCHARD, VINEYARD
   * ==================================================================== */

  /** Instanced prototype pool: one InstancedMesh per repeated prop type. */
  class InstancePool {
    constructor(geo, matKey) { this.geo = geo; this.matKey = matKey; this.items = []; }
    push(x, y, z, ry, s) { this.items.push(x, y, z, ry, s === undefined ? 1 : s); }
    build(parent) {
      const n = this.items.length / 5;
      if (!n) return null;
      const im = new THREE.InstancedMesh(this.geo, MAT[this.matKey], n);
      for (let i = 0; i < n; i++) {
        const o = i * 5;
        const s = this.items[o + 4];
        composeMat(_ml, this.items[o], this.items[o + 1], this.items[o + 2], 0, this.items[o + 3], 0, s, s, s);
        im.setMatrixAt(i, _ml);
      }
      im.instanceMatrix.needsUpdate = true;
      const meta = MAT_META[this.matKey] || { cast: true, receive: true };
      im.castShadow = meta.cast !== false && this.cast !== false;
      im.receiveShadow = true;
      im.name = `props:inst:${this.matKey}`;
      parent.add(im);
      return im;
    }
  }

  const poolFence = new InstancePool(proto('fenceSpan', (buf) => {
    composeMat(_mProto, 0, 0.62, 0, 0, 0, 0, 1, 1, 1);
    emitBox(buf, _mProto, 0.14, 1.24, 0.14, 1.0, WHITE);
    composeMat(_mProto, 0, 0.54, 0, 0, 0, 0, 1, 1, 1);
    emitBox(buf, _mProto, 2.4, 0.11, 0.08, 1.2, WHITE);
    composeMat(_mProto, 0, 0.98, 0, 0, 0, 0, 1, 1, 1);
    emitBox(buf, _mProto, 2.4, 0.1, 0.07, 1.2, WHITE);
  }), 'woodDark');
  const poolWall = new InstancePool(proto('wallSpan', (buf) => {
    for (let i = 0; i < 4; i++) {
      composeMat(_mProto, -0.75 + (i / 3) * 1.5, 0.16 + i * 0.19, (i % 2 ? 1 : -1) * 0.05,
        0, 0, (i % 3 ? 1 : -1) * 0.05, 1, 1, 1);
      emitBox(buf, _mProto, 0.6 + (i % 2) * 0.16, 0.22, 0.46, 0.9, WHITE);
    }
  }), 'stone');
  const poolCrop = new InstancePool(proto('cropWheat', (buf) => {
    const gold = { r: 1.06, g: 1.0, b: 0.62 };
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const h = 0.55 + (i % 3) * 0.11;
      composeMat(_mProto, Math.cos(a) * 0.09, h * 0.5, Math.sin(a) * 0.09,
        Math.sin(a) * 0.22, 0, -Math.cos(a) * 0.22, 1, 1, 1);
      emitBox(buf, _mProto, 0.05, h, 0.05, 0.7, gold);
    }
    for (let i = 0; i < 3; i++) {
      composeMat(_mProto, (i - 1) * 0.12, 0.78, (i % 2) * 0.1, 0, 0, 0, 1, 1, 1);
      emitBox(buf, _mProto, 0.12, 0.24, 0.1, 0.6, { r: 1.16, g: 1.05, b: 0.6 });
    }
  }), 'canopy');
  const poolVine = new InstancePool(proto('grapeVine', (buf) => {
    const green = { r: 0.86, g: 1.05, b: 0.82 };
    composeMat(_mProto, 0, 0.45, 0, 0, 0, 0, 1, 1, 1);
    emitCyl(buf, _mProto, 0.06, 0.09, 0.9, 6, 0.8, WHITE, true);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      composeMat(_mProto, Math.cos(a) * 0.3, 0.85 + (i % 2) * 0.14, Math.sin(a) * 0.3, 0, a, 0, 1, 1, 1);
      emitBox(buf, _mProto, 0.5, 0.06, 0.34, 0.8, green);
    }
    for (let i = 0; i < 2; i++) {
      composeMat(_mProto, 0.14 + i * 0.12, 1.0 - i * 0.16, -0.12, 0, 0, 0, 0.9, 0.9, 0.9);
      emitBox(buf, _mProto, 0.16, 0.2, 0.16, 0.6, { r: 1.05, g: 0.98, b: 0.8 });
    }
  }), 'canopy');
  const poolGlobe = new InstancePool(icoG(0.2, 1), 'globe');
  const poolTerrace = new InstancePool(poolWall.geo, 'stone');
  poolCrop.cast = false;
  poolVine.cast = false;
  poolTerrace.cast = true;

  /** Fence run with colliders only where it hugs the road. */
  function fenceChain(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const n = Math.max(1, Math.round(Math.hypot(dx, dz) / 2.4));
    const ry = Math.atan2(-dz, dx);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const x = ax + dx * t;
      const z = az + dz * t;
      poolFence.push(x, groundAt(x, z) - 0.1, z, ry, 1);
      if (layout.roadDistance(x, z) < 12) addCollider(x, z, 0.6, 'fence');
      stats.props++;
    }
  }

  /** Dry-stone wall run (instanced segments). */
  function wallRun(ax, az, bx, bz, pool) {
    const dx = bx - ax, dz = bz - az;
    const n = Math.max(1, Math.round(Math.hypot(dx, dz) / 2.0));
    const ry = Math.atan2(-dz, dx);
    const target = pool || poolWall;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const x = ax + dx * t;
      const z = az + dz * t;
      target.push(x, groundAt(x, z) - 0.12, z, ry, 1);
      stats.props++;
    }
  }

  const FARMP = layout.pois.farm.position;
  {
    // --- barn: big red-brown plank barn with a hay loft ---
    const barn = spotNear(FARMP.x, FARMP.z, 14, 26, { tries: 90, w: 15, d: 10, maxRise: 1.0 });
    if (barn) {
      const ry = rng.float() * TAU;
      const t = tint(0.07);
      place(globalSink, barn.x, barn.y, barn.z, ry, t, (emit, f) => {
        const w = 13.5, d = 9.4, h = 6.2;
        emit('stone', boxG(w + 0.4, 1.4, d + 0.4, 1.8), 0, -0.4, 0);
        emit('planksRed', boxG(w, h, d, 2.0), 0, 2.9, 0);
        for (let i = 0; i < 9; i++) {
          const bx = -w / 2 + 0.8 + (i * (w - 1.6)) / 8;
          emit('planksRed', boxG(0.18, h * 0.94, 0.14, 1.0), bx, 2.9, d / 2 + 0.07);
          emit('planksRed', boxG(0.18, h * 0.94, 0.14, 1.0), bx, 2.9, -d / 2 - 0.07);
        }
        const rise = 2.9;
        const ang = Math.atan2(rise, d / 2 + 0.6);
        const sl = Math.hypot(d / 2 + 0.6, rise) + 0.2;
        emit('roofSlate', boxG(w + 1.4, 0.26, sl, 1.6), 0, 6.0 + rise / 2, d / 4 + 0.3, { rx: ang });
        emit('roofSlate', boxG(w + 1.4, 0.26, sl, 1.6), 0, 6.0 + rise / 2, -(d / 4 + 0.3), { rx: -ang });
        emit('planksRed', triG(d, rise, 0.3), w / 2 - 0.15, 6.0 + rise / 2 - 0.1, 0, { ry: Math.PI / 2 });
        emit('planksRed', triG(d, rise, 0.3), -(w / 2 - 0.15), 6.0 + rise / 2 - 0.1, 0, { ry: Math.PI / 2 });
        emit('planksDark', plankG(3.4, 3.4, 0.18, 0.03), -2.6, 1.9, d / 2 + 0.09);
        emit('planksDark', plankG(3.4, 3.4, 0.18, 0.03), 1.2, 1.9, d / 2 + 0.09);
        emit('wood', plankG(7.4, 0.24, 0.3, 0.03), -0.7, 3.75, d / 2 + 0.13);
        emit('planksDark', boxG(2.0, 1.7, 0.16, 1.4), 4.2, 5.2, d / 2 + 0.07);
        emit('wood', plankG(0.3, 0.3, 2.6, 0.04), 4.2, 7.6, -0.6);
        emit('rope', cylG(0.05, 0.05, 1.7, 6, 0.7), 4.2, 6.8, -1.6);
        emit('iron', torusG(0.18, 0.04, 5, 12), 4.2, 5.95, -1.6, { rx: Math.PI / 2 });
        emit('glass', boxG(0.8, 0.9, 0.16, 0.9), -5.0, 4.6, d / 2 + 0.06);
        emit('glass', boxG(0.8, 0.9, 0.16, 0.9), 5.9, 4.6, d / 2 + 0.06);
        addLampRef(f, -5.0, 4.6, d / 2 + 0.1, MAT.glass, 'window');
        addLampRef(f, 5.9, 4.6, d / 2 + 0.1, MAT.glass, 'window');
      });
      addCollider(barn.x, barn.z, 7.4, 'building');
      recordSample(barn.x, barn.y, barn.z);
      stats.buildings++;
      stats.props += 4;
    }

    // --- silo ---
    const silo = spotNear(FARMP.x, FARMP.z, 20, 34, { tries: 80, w: 7, d: 7, maxRise: 0.9 });
    if (silo) {
      place(globalSink, silo.x, silo.y, silo.z, 0, tint(0.05), (emit) => {
        emit('stone', cylG(3.3, 3.6, 1.2, 16, 1.8), 0, 0.4, 0);
        emit('plasterC', cylG(3.1, 3.2, 10.4, 18, 2.2), 0, 6.2, 0);
        emit('stone', torusG(3.22, 0.18, 4, 20), 0, 10.9, 0, { rx: Math.PI / 2 });
        emit('plasterC', latheG('siloCap', [[3.1, 0], [3.0, 0.9], [2.1, 1.6], [0.9, 1.95], [0.15, 2.0]], 16, 1.6), 0, 11.2, 0);
        emit('iron', plankG(0.5, 0.16, 0.16, 0.01), 1.0, 12.9, 0);
        for (let i = 0; i < 12; i++) {
          emit('iron', plankG(1.9, 0.07, 0.07, 0.01), 3.25, 1.7 + i * 0.82, 0, { rz: Math.PI / 2 });
        }
        emit('iron', plankG(0.08, 9.9, 0.08, 0.01), 2.3, 6.0, 0);
        emit('iron', plankG(0.08, 9.9, 0.08, 0.01), 4.2, 6.0, 0);
        emit('paintedMetal', boxG(1.2, 1.1, 0.16, 1.2), 0, 1.6, 3.16);
      });
      addCollider(silo.x, silo.z, 3.2, 'building');
      recordSample(silo.x, silo.y, silo.z);
      stats.buildings++;
      stats.props += 2;
    }

    // --- hay bales ---
    const bales = DET > 0 ? 12 : 8;
    for (let i = 0; i < bales; i++) {
      const a = rng.float() * TAU;
      const hx = FARMP.x + Math.cos(a) * rng.range(16, 30);
      const hz = FARMP.z + Math.sin(a) * rng.range(16, 30);
      if (!layout.isClear(hx, hz, { road: 8, poi: 0, river: 8, maxSlope: 0.3 })) continue;
      const hy = groundAt(hx, hz);
      const stack = i >= 8 ? 1 : 0;
      place(globalSink, hx, hy + stack * 1.05, hz, rng.float() * TAU, tint(0.08), (emit) => {
        emit('hay', cylG(0.62, 0.62, 1.6, 12, 1.2), 0, 0.62, 0, { rz: Math.PI / 2 });
        emit('rope', torusG(0.64, 0.03, 4, 14), -0.45, 0.62, 0, { rz: Math.PI / 2 });
        emit('rope', torusG(0.64, 0.03, 4, 14), 0.45, 0.62, 0, { rz: Math.PI / 2 });
      });
      stats.props++;
      recordSample(hx, hy, hz);
    }

    // --- tractor-shaped wooden cart ---
    const cart = spotNear(FARMP.x, FARMP.z, 12, 20, { tries: 80, w: 5.5, d: 3, maxRise: 0.8 });
    if (cart) {
      place(globalSink, cart.x, cart.y, cart.z, rng.float() * TAU, tint(0.06), (emit) => {
        emit('planks', boxG(1.6, 0.2, 2.6, 1.2), 0, 1.05, -0.9);
        emit('planksDark', boxG(1.5, 0.9, 0.16, 1.0), 0, 1.55, -2.1);
        emit('planksDark', boxG(0.16, 0.9, 2.4, 1.0), -0.75, 1.55, -0.9);
        emit('planksDark', boxG(0.16, 0.9, 2.4, 1.0), 0.75, 1.55, -0.9);
        emit('woodDark', boxG(1.7, 1.5, 1.8, 1.4), 0, 1.7, -1.1);
        emit('iron', cylG(0.1, 0.1, 1.0, 8, 0.8), 0, 2.6, -1.2, { rz: Math.PI / 2 });
        emit('wood', torusG(0.34, 0.06, 6, 14), 0, 2.75, -0.7, { rx: 0.5 });
        emit('planksDark', boxG(0.9, 0.12, 0.7, 1.0), 0, 2.1, -0.1);
        emit('planksDark', boxG(0.4, 0.5, 0.4, 0.8), 0, 2.42, -0.1);
        emit('iron', cylG(0.16, 0.16, 2.2, 8, 0.9), 0, 1.0, 1.6, { rz: Math.PI / 2 });
        emit('iron', cylG(0.12, 0.12, 1.9, 8, 0.9), 0, 0.9, 2.6, { rz: Math.PI / 2 });
        emit('woodDark', torusG(0.45, 0.16, 6, 16), 0, 0.45, 2.7, { ry: Math.PI / 2 });
        emit('woodDark', torusG(0.78, 0.18, 6, 18), 0, 0.78, 1.5, { ry: Math.PI / 2 });
        emit('planks', boxG(1.4, 0.16, 0.5, 1.0), 0, 1.15, 1.4);
        emit('hay', cylG(0.42, 0.42, 1.0, 10, 1.0), 0, 1.5, -0.6, { rz: Math.PI / 2 });
      });
      addCollider(cart.x, cart.z, 2.6, 'cart');
      recordSample(cart.x, cart.y, cart.z);
      stats.props += 2;
    }

    // --- scarecrows ---
    for (let i = 0; i < 2; i++) {
      const sp = spotNear(FARMP.x, FARMP.z, 18, 34, { tries: 70, w: 1.5, d: 1.5, maxRise: 0.7 });
      if (!sp) continue;
      place(globalSink, sp.x, sp.y, sp.z, rng.float() * TAU, tint(0.06), (emit) => {
        emit('wood', plankG(0.12, 2.3, 0.12, 0.02), 0, 1.15, 0);
        emit('wood', plankG(1.7, 0.1, 0.1, 0.02), 0, 1.75, 0);
        emit('canvas', latheG('scareBody', [[0.34, 0.2], [0.4, 0.9], [0.26, 1.4], [0.2, 1.6]], 10, 1.0), 0, 0.5, 0);
        emit('canvas', icoG(0.2, 1), 0, 2.05, 0);
        emit('hay', latheG('hat', [[0.42, 0], [0.42, 0.04], [0.22, 0.12], [0.2, 0.16]], 12, 1.0), 0, 2.3, 0);
        emit('leather', boxG(0.3, 0.3, 0.2, 0.6), 0.34, 1.0, 0.1);
      });
      stats.props += 2;
      recordSample(sp.x, sp.y, sp.z);
    }

    // --- beehives (three stacked boxes on a stand) ---
    for (let i = 0; i < 3; i++) {
      const a = rng.float() * TAU;
      const hx = FARMP.x + Math.cos(a) * rng.range(15, 28);
      const hz = FARMP.z + Math.sin(a) * rng.range(15, 28);
      if (!layout.isClear(hx, hz, { road: 8, poi: 0, river: 8, maxSlope: 0.28 })) continue;
      const hy = groundAt(hx, hz);
      place(globalSink, hx, hy, hz, rng.float() * TAU, tint(0.05), (emit) => {
        for (const sx of [-0.55, 0.55]) {
          for (const sz of [-0.4, 0.4]) emit('woodDark', plankG(0.1, 1.0, 0.1, 0.02), sx, 0.5, sz);
        }
        emit('planksDark', boxG(1.5, 0.1, 1.1, 1.0), 0, 1.0, 0);
        for (let b = 0; b < 3; b++) {
          emit('planks', boxG(1.25, 0.34, 0.9, 1.1), 0, 1.22 + b * 0.35, 0);
          emit('woodDark', boxG(1.3, 0.06, 0.95, 1.0), 0, 1.42 + b * 0.35, 0);
        }
        emit('planksDark', boxG(1.45, 0.1, 1.05, 1.0), 0, 2.38, 0);
      });
      addCollider(hx, hz, 0.95, 'hive');
      stats.props += 2;
      recordSample(hx, hy, hz);
    }
  }

  // --- fenced fields with instanced crop rows ---
  {
    const fields = [
      { cx: FARMP.x - 34, cz: FARMP.z + 16, w: 42, d: 26, rows: 8, cols: 12 },
      { cx: FARMP.x + 38, cz: FARMP.z - 26, w: 36, d: 24, rows: 7, cols: 10 },
    ];
    for (const f of fields) {
      const ry = rng.float() * 0.7;
      const cos = Math.cos(ry), sin = Math.sin(ry);
      const toW = (lx, lz) => ({ x: f.cx + cos * lx + sin * lz, z: f.cz - sin * lx + cos * lz });
      const hw = f.w / 2, hd = f.d / 2;
      const corners = [toW(-hw, -hd), toW(hw, -hd), toW(hw, hd), toW(-hw, hd)];
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        fenceChain(a.x, a.z, b.x, b.z);
      }
      for (let r = 0; r < f.rows; r++) {
        for (let c = 0; c < f.cols; c++) {
          const lx = -hw + 2.2 + (r / Math.max(1, f.rows - 1)) * (f.w - 4.4);
          const lz = -hd + 2.0 + (c / Math.max(1, f.cols - 1)) * (f.d - 4.0);
          const p = toW(lx, lz);
          const y = groundAt(p.x, p.z);
          poolCrop.push(p.x, y - 0.05, p.z, rng.float() * TAU, rng.range(0.85, 1.2));
          stats.props++;
          if (r === 0 && c < 2) recordSample(p.x, y, p.z);
        }
      }
    }
  }

  // --- orchard: rows of small fruit trees + ladder + fruit crate ---
  {
    const OP = layout.pois.orchard.position;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        const ox = OP.x + (r - 1.5) * 13 + rng.range(-1.2, 1.2);
        const oz = OP.z + (c - 2) * 12 + rng.range(-1.2, 1.2);
        if (!layout.isClear(ox, oz, { road: 9, poi: 0, river: 8, maxSlope: 0.32 })) continue;
        const oy = groundAt(ox, oz);
        const t = tint(0.12);
        const sc = rng.range(0.85, 1.12);
        place(globalSink, ox, oy, oz, rng.float() * TAU, t, (emit) => {
          emit('bark', cylG(0.16 * sc, 0.24 * sc, 2.0 * sc, 8, 1.0), 0, 1.0 * sc, 0);
          emit('bark', plankG(0.14, 1.0, 0.14, 0.02), 0.4 * sc, 1.2 * sc, 0.2, { rz: 0.5 });
          emit('bark', plankG(0.12, 0.9, 0.12, 0.02), -0.35 * sc, 1.15 * sc, -0.2, { rz: -0.55 });
          emit('canopy', icoG(1.05 * sc, 1), 0, 2.55 * sc, 0, { tint: t });
          emit('canopy', icoG(0.72 * sc, 1), 0.7 * sc, 2.1 * sc, 0.35 * sc, { tint: t });
          emit('canopy', icoG(0.66 * sc, 1), -0.6 * sc, 2.25 * sc, -0.4 * sc, { tint: t });
          emit('canopy', icoG(0.5 * sc, 1), 0.1 * sc, 3.15 * sc, -0.1 * sc, { tint: t });
          for (let a = 0; a < 3; a++) {
            emit('canopy', icoG(0.12, 0), 0.5 * sc + a * 0.12, 2.1 * sc, 0.3 * sc, { tint: { r: 1.25, g: 0.86, b: 0.72 } });
          }
        });
        stats.props += 2;
        recordSample(ox, oy, oz);
      }
    }
    const lad = spotNear(OP.x, OP.z, 6, 20, { tries: 60, w: 2, d: 2, maxRise: 0.7 });
    if (lad) {
      place(globalSink, lad.x, lad.y, lad.z, rng.float() * TAU, tint(0.05), (emit) => {
        emit('wood', plankG(0.1, 3.0, 0.1, 0.02), -0.35, 1.5, 0.4, { rx: -0.22 });
        emit('wood', plankG(0.1, 3.0, 0.1, 0.02), 0.35, 1.5, 0.4, { rx: -0.22 });
        for (let i = 0; i < 7; i++) {
          emit('wood', plankG(0.8, 0.07, 0.07, 0.01), 0, 0.25 + i * 0.42, 0.35 + i * 0.09);
        }
        emit('planks', boxG(1.0, 0.55, 0.7, 1.0), 1.5, 0.28, 0);
        for (let i = 0; i < 5; i++) {
          emit('canopy', icoG(0.13, 0), 1.2 + i * 0.16, 0.66, -0.1 + (i % 2) * 0.2, { tint: { r: 1.3, g: 0.86, b: 0.7 } });
        }
      });
      stats.props += 2;
      recordSample(lad.x, lad.y, lad.z);
    }
  }

  // --- vineyard terraces: stakes, wires, vines, retaining walls ---
  {
    const VP = layout.pois.vineyard.position;
    const rows = 5;
    for (let r = 0; r < rows; r++) {
      const lz = (r - (rows - 1) / 2) * 11;
      const ax = VP.x - 32, az = VP.z + lz;
      const bx = VP.x + 32, bz = VP.z + lz + rng.range(-3, 3);
      if (DET > 0 && r % 2 === 0) wallRun(ax - 2, az - 6.5, bx + 2, bz - 6.5, poolTerrace);
      const posts = 9;
      let prev = null;
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        const px = lerp(ax, bx, t);
        const pz = lerp(az, bz, t);
        const py = groundAt(px, pz);
        if (!layout.isClear(px, pz, { road: 8, poi: 0, river: 8, maxSlope: 0.5 })) { prev = null; continue; }
        poolFence.push(px, py - 0.1, pz, 0, 0.42);
        poolVine.push(px, py - 0.05, pz, rng.float() * TAU, rng.range(0.9, 1.15));
        if (prev) {
          place(globalSink, 0, 0, 0, 0, WHITE, (emit) => {
            emitLine(emit, 'iron', prev.x, prev.y + 1.45, prev.z, px, py + 1.45, pz, 0.025);
            emitLine(emit, 'iron', prev.x, prev.y + 1.05, prev.z, px, py + 1.05, pz, 0.025);
          });
        }
        prev = { x: px, y: py, z: pz };
        stats.props++;
        if (i === 2) recordSample(px, py, pz);
      }
    }
  }

  /* ======================================================================
   * 6. CAMP (north beach)
   * ==================================================================== */

  const CP = layout.pois.camp.position;
  {
    // --- three tents ---
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.7;
      const tx2 = CP.x + Math.cos(a) * rng.range(9, 15);
      const tz2 = CP.z + Math.sin(a) * rng.range(9, 15);
      if (!layout.isClear(tx2, tz2, { road: 8, poi: 0, river: 8, maxSlope: 0.3 })) continue;
      const ty2 = groundAt(tx2, tz2);
      const kind = i % 3;
      place(globalSink, tx2, ty2, tz2, rng.float() * TAU, tint(0.06), (emit) => {
        if (kind === 0) {
          emit('canvas', cylG(0.06, 2.0, 2.3, 8, 1.6), 0, 1.15, 0);
          emit('canvas', cylG(0.08, 0.09, 2.7, 6, 1.0), 0, 1.35, 0);
          emit('rope', torusG(1.9, 0.04, 5, 14), 0, 0.1, 0, { rx: Math.PI / 2 });
          for (let g = 0; g < 4; g++) {
            const ga = (g / 4) * TAU + 0.3;
            emitLine(emit, 'rope', 0, 2.4, 0, Math.cos(ga) * 2.6, 0.1, Math.sin(ga) * 2.6, 0.022);
            emit('wood', plankG(0.09, 0.3, 0.09, 0.01), Math.cos(ga) * 2.6, 0.14, Math.sin(ga) * 2.6);
          }
        } else if (kind === 1) {
          emit('canvas', latheG('domeTent', [[1.5, 0], [1.52, 0.35], [1.25, 1.05], [0.7, 1.6], [0.12, 1.8]], 14, 1.4), 0, 0, 0);
          emit('canvas', cylG(0.06, 0.08, 0.5, 6, 0.8), 0, 1.85, 0);
          emit('rope', torusG(1.45, 0.035, 4, 14), 0, 0.2, 0, { rx: Math.PI / 2 });
          emit('planksDark', boxG(0.9, 1.2, 0.08, 1.0), 0, 0.6, 1.46, { rx: 0.16 });
        } else {
          emit('canvas', latheG('ridgeTent', [[1.35, 0], [1.4, 0.5], [0.4, 1.35], [0.06, 1.5]], 12, 1.4), 0, 0, 0);
          emit('canvas', cylG(0.05, 0.07, 3.4, 6, 0.8), 0, 1.42, 0, { rz: Math.PI / 2 });
          for (const sz of [-1.25, 1.25]) emitLine(emit, 'rope', 0, 1.45, 0, 0, 0.05, sz * 2.1, 0.02);
          emit('planksDark', boxG(0.85, 1.05, 0.07, 1.0), 0.3, 0.55, 1.28, { rx: 0.2 });
        }
        emit('canvas', latheG('bedroll', [[0.5, 0], [0.55, 0.16], [0.42, 0.34], [0.12, 0.4]], 10, 0.9), 0.95, 0, 1.05, { rz: 0.18 });
      });
      addCollider(tx2, tz2, 1.9, 'tent');
      recordSample(tx2, ty2, tz2);
      stats.props += 3;
    }

    // --- campfire ring: stones, logs, embers + fire emitter ---
    const fxp = { x: CP.x - 3, z: CP.z - 5 };
    const fy = groundAt(fxp.x, fxp.z);
    place(globalSink, fxp.x, fy, fxp.z, 0, tint(0.05), (emit) => {
      emit('dirt', cylG(1.5, 1.6, 0.16, 14, 1.4), 0, 0.06, 0);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU;
        emit('stone', icoG(rng.range(0.2, 0.32), 0), Math.cos(a) * 1.35, 0.2, Math.sin(a) * 1.35, { ry: rng.float() * TAU });
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        emit('bark', cylG(0.07, 0.1, 1.5, 6, 0.9), Math.cos(a) * 0.2, 0.62, Math.sin(a) * 0.2,
          { rz: Math.sin(a) * 0.55, rx: -Math.cos(a) * 0.55 });
      }
      emit('iron', torusG(0.5, 0.03, 4, 12), 0, 0.95, 0);
      emit('planksDark', boxG(1.2, 0.3, 0.5, 0.9), 2.1, 0.2, 0.4, { rz: 0.1 });
    });
    chimneys.push({ x: r2(fxp.x), y: r2(fy + 0.7), z: r2(fxp.z), rate: 0.6, type: 'fire' });
    stats.props += 3;
    recordSample(fxp.x, fy, fxp.z);

    // --- log seats ---
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 1.1;
      const lx = fxp.x + Math.cos(a) * 2.7;
      const lz = fxp.z + Math.sin(a) * 2.7;
      const ly = groundAt(lx, lz);
      place(globalSink, lx, ly, lz, -a + Math.PI / 2, tint(0.07), (emit) => {
        emit('bark', cylG(0.24, 0.26, 1.7, 10, 1.1), 0, 0.24, 0, { rz: Math.PI / 2 });
        emit('logEnd', cylG(0.25, 0.25, 0.06, 10, 1.0), 0.86, 0.24, 0, { rz: Math.PI / 2 });
        emit('logEnd', cylG(0.25, 0.25, 0.06, 10, 1.0), -0.86, 0.24, 0, { rz: Math.PI / 2 });
      });
      stats.props++;
      recordSample(lx, ly, lz);
    }

    // --- hammock slung between two palms ---
    {
      const px1 = CP.x + 9, pz1 = CP.z - 9;
      const px2 = CP.x + 16.5, pz2 = CP.z - 8.5;
      const y1 = groundAt(px1, pz1), y2 = groundAt(px2, pz2);
      const palms = [[px1, pz1, y1], [px2, pz2, y2]];
      for (const [ppx, ppz, ppy] of palms) {
        const lean = rng.range(-0.18, 0.18);
        place(globalSink, ppx, ppy, ppz, rng.float() * TAU, tint(0.06), (emit) => {
          let topX = 0, topZ = 0, topY = 0;
          for (let i = 0; i < 7; i++) {
            const t = i / 7;
            const x = Math.sin(t * 1.1) * 0.5 + lean * t * 1.5;
            const z = Math.sin(t * 0.8) * 0.28;
            const y = 0.45 + i * 0.9;
            emit('bark', cylG(0.17 - t * 0.05, 0.2 - t * 0.05, 0.95, 8, 1.1), x, y, z);
            topX = x; topZ = z; topY = y + 0.6;
          }
          emit('logEnd', cylG(0.12, 0.12, 0.1, 8, 0.6), topX, topY + 0.4, topZ);
          for (let f = 0; f < 7; f++) {
            const a = (f / 7) * TAU + rng.float() * 0.4;
            emit('canopy', boxG(2.4, 0.06, 0.5, 1.2),
              topX + Math.cos(a) * 1.05, topY + 0.45 - (f % 2) * 0.1, topZ + Math.sin(a) * 1.05,
              { ry: -a, rz: -0.26 });
          }
          for (let c = 0; c < 3; c++) {
            emit('bark', icoG(0.12, 0), topX + Math.cos(c * 2.1) * 0.26, topY + 0.2, topZ + Math.sin(c * 2.1) * 0.26);
          }
        });
        stats.props += 2;
        recordSample(ppx, ppy, ppz);
      }
      const hy = Math.min(y1, y2) + 3.4;
      for (let i = 0; i < 6; i++) {
        const t0 = i / 6, t1 = (i + 1) / 6;
        const sag = (t) => hy - Math.sin(Math.PI * t) * 0.55;
        const ax = lerp(px1, px2, t0), az = lerp(pz1, pz2, t0);
        const bx = lerp(px1, px2, t1), bz = lerp(pz1, pz2, t1);
        const segLen = Math.hypot(bx - ax, bz - az);
        place(globalSink, (ax + bx) * 0.5, (sag(t0) + sag(t1)) * 0.5, (az + bz) * 0.5,
          Math.atan2(bx - ax, bz - az), WHITE, (emit) => {
            emit('fabricRed', boxG(1.3, 0.05, segLen + 0.05, 1.2), 0, 0, 0,
              { rx: -Math.atan2(sag(t1) - sag(t0), segLen) });
          });
      }
      place(globalSink, 0, 0, 0, 0, WHITE, (emit) => {
        emitLine(emit, 'rope', px1 + 0.5, hy - 0.15, pz1, px1 + 2.0, hy + 0.1, pz1 + 1.1, 0.03);
        emitLine(emit, 'rope', px2 - 0.6, hy - 0.15, pz2, px2 - 2.0, hy + 0.1, pz2 - 1.0, 0.03);
      });
      stats.props += 2;
    }

    // --- kayak on the sand ---
    {
      const kx = CP.x - 9, kz = CP.z - 11;
      const ky = groundAt(kx, kz);
      place(globalSink, kx, ky, kz, rng.float() * TAU, tint(0.07), (emit) => {
        emit('teal', hullG(4.4, 0.84, 0.42), 0, 0.3, 0);
        emit('teal', boxG(3.6, 0.07, 0.62, 1.1), 0, 0.31, 0);
        emit('planksDark', torusG(0.38, 0.06, 4, 12), -0.4, 0.34, 0, { rx: Math.PI / 2 });
        emit('wood', plankG(2.2, 0.06, 0.14, 0.01), 1.5, 0.36, 0.55, { ry: 0.3 });
        emit('wood', plankG(0.55, 0.05, 0.22, 0.01), 2.55, 0.36, 0.7, { ry: 0.3 });
        emit('wood', plankG(0.55, 0.05, 0.22, 0.01), 0.45, 0.36, 0.4, { ry: 0.3 });
        emit('teal', boxG(0.7, 0.16, 0.5, 0.8), -1.6, 0.4, 0.42, { ry: 0.1 });
      });
      addCollider(kx, kz, 2.0, 'kayak');
      stats.props += 2;
      recordSample(kx, ky, kz);
    }
    addFlag(CP.x + 5.5, CP.z + 4, 0.5, 'fabricTeal');
  }

  /* ======================================================================
   * 7. ROADSIDE INFRASTRUCTURE
   * ==================================================================== */

  const N_ROAD = layout.roadSamples.length / 3;
  const roadAt = (i) => {
    const si = ((i % N_ROAD) + N_ROAD) % N_ROAD;
    return { x: layout.roadSamples[si * 3], y: layout.roadSamples[si * 3 + 1], z: layout.roadSamples[si * 3 + 2] };
  };
  const roadDir = (i) => {
    const a = roadAt(i), b = roadAt(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { dx: dx / l, dz: dz / l };
  };

  const lampZones = [V, layout.pois.harbor.position, layout.pois.spawn.position];
  const nearLampZone = (x, z) => {
    for (const p of lampZones) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz <= 14400) return true;
    }
    return false;
  };

  {
    // --- lamp posts: ring road + harbour spur, only near village/harbour/spawn ---
    const lampPostGeo = proto('lampPost', (buf) => {
      composeMat(_mProto, 0, 0.15, 0, 0, 0, 0, 1, 1, 1);
      emitCyl(buf, _mProto, 0.3, 0.36, 0.3, 10, 1.0, WHITE, true);
      composeMat(_mProto, 0, 1.95, 0, 0, 0, 0, 1, 1, 1);
      emitCyl(buf, _mProto, 0.075, 0.1, 3.4, 8, 1.2, WHITE, true);
      composeMat(_mProto, 0, 3.68, 0.34, 0, 0, 0, 1, 1, 1);
      emitBox(buf, _mProto, 0.09, 0.09, 0.78, 1.0, WHITE);
      composeMat(_mProto, 0, 3.9, 0.72, 0, 0, 0, 1, 1, 1);
      emitCyl(buf, _mProto, 0.03, 0.26, 0.2, 10, 0.8, WHITE, true);
    });
    let count = 0;
    let lastIdx = -1e9;
    let lampSide = 1;
    const lampStep = 55 / (layout.roadLength / N_ROAD);
    for (let i = 0; i < N_ROAD; i += lampStep) {
      const idx = Math.round(i);
      const p = roadAt(idx);
      if (!nearLampZone(p.x, p.z)) continue;
      if (idx - lastIdx < lampStep * 0.7) continue;
      const d = roadDir(idx);
      lampSide = -lampSide;
      const nx = -d.dz * lampSide, nz = d.dx * lampSide;
      const lx = p.x + nx * 4.4, lz = p.z + nz * 4.4;
      if (!layout.isLand(lx, lz)) continue;
      lastIdx = idx;
      const ly = groundAt(lx, lz);
      place(globalSink, lx, ly, lz, Math.atan2(-nx, -nz), tint(0.04), (emit, f) => {
        emit('iron', lampPostGeo, 0, 0, 0);
        addLampRef(f, 0, 3.58, 0.72, MAT.globe, 'lamp');
      });
      poolGlobe.push(lx - nx * 0.72, ly + 3.58, lz - nz * 0.72, 0, 1);
      addCollider(lx, lz, 0.45, 'lamp');
      stats.props += 2;
      count++;
    }
    const hs = layout.spurs.harbor;
    if (hs) {
      const tmp = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 1 };
      for (let t = 0.34; t < 0.98; t += 0.13) {
        hs.point(t, tmp);
        if (!nearLampZone(tmp.x, tmp.z)) continue;
        const nx = -tmp.dirZ, nz = tmp.dirX;
        const lx = tmp.x + nx * 4.2, lz = tmp.z + nz * 4.2;
        const ly = groundAt(lx, lz);
        place(globalSink, lx, ly, lz, Math.atan2(-nx, -nz), tint(0.04), (emit, f) => {
          emit('iron', lampPostGeo, 0, 0, 0);
          addLampRef(f, 0, 3.58, 0.72, MAT.globe, 'lamp');
        });
        poolGlobe.push(lx - nx * 0.72, ly + 3.58, lz - nz * 0.72, 0, 1);
        addCollider(lx, lz, 0.45, 'lamp');
        stats.props += 2;
        count++;
      }
    }
    stats.lampPosts = count;
  }

  {
    // --- low dry-stone walls along the drop-off side of the road ---
    let placed = 0;
    let run = 0;
    for (let i = 0; i < N_ROAD && placed < 360; i++) {
      if (i > 118 && i < 172) { run = 0; continue; }   // keep the village street clear
      const p = roadAt(i);
      const d = roadDir(i);
      const nx = -d.dz, nz = d.dx;
      let hit = 0, side = 1;
      for (const s of [-1, 1]) {
        const drop = p.y - groundAt(p.x + nx * 8 * s, p.z + nz * 8 * s);
        if (drop > 2.6 && drop > hit) { hit = drop; side = s; }
      }
      if (!hit) { run = 0; continue; }
      run++;
      if (run < 4) continue;
      const wx = p.x + nx * 4.1 * side, wz = p.z + nz * 4.1 * side;
      poolWall.push(wx, groundAt(wx, wz) - 0.12, wz, Math.atan2(-d.dz * side, d.dx * side) + Math.PI / 2, 1);
      placed++;
      stats.props++;
    }
    stats.wallSegments = placed;
  }

  {
    // --- wooden guardrail on the west cape switchbacks ---
    let prev = null;
    let segments = 0;
    for (let i = 0; i < N_ROAD; i++) {
      const p = roadAt(i);
      if (p.x > -1380) { prev = null; continue; }
      const d = roadDir(i);
      const nx = -d.dz, nz = d.dx;
      const side = nx > 0 ? -1 : 1;
      const wx = p.x + nx * 4.4 * side, wz = p.z + nz * 4.4 * side;
      const wy = groundAt(wx, wz);
      if (prev && Math.hypot(wx - prev.x, wz - prev.z) < 3.4) continue;
      place(globalSink, wx, wy, wz, 0, tint(0.05), (emit) => {
        emit('woodDark', plankG(0.18, 1.25, 0.18, 0.03), 0, 0.6, 0);
      });
      if (prev) {
        place(globalSink, 0, 0, 0, 0, WHITE, (emit) => {
          emitLine(emit, 'wood', prev.x, prev.y + 1.1, prev.z, wx, wy + 1.1, wz, 0.085);
          emitLine(emit, 'wood', prev.x, prev.y + 0.62, prev.z, wx, wy + 0.62, wz, 0.07);
        });
        segments++;
      }
      prev = { x: wx, y: wy, z: wz };
      stats.props++;
    }
    stats.guardrailSpans = segments;
  }

  {
    // --- kilometre markers ---
    const kmGeo = proto('kmPost', (buf) => {
      composeMat(_mProto, 0, 0.55, 0, 0, 0, 0, 1, 1, 1);
      emitBox(buf, _mProto, 0.22, 1.1, 0.16, 1.0, WHITE);
      composeMat(_mProto, 0, 1.08, 0, 0, 0, 0, 1, 1, 1);
      emitBox(buf, _mProto, 0.24, 0.14, 0.18, 0.8, WHITE);
    });
    for (let i = 22; i < N_ROAD; i += 44) {
      const p = roadAt(i);
      const d = roadDir(i);
      const nx = -d.dz, nz = d.dx;
      const wx = p.x + nx * 4.7, wz = p.z + nz * 4.7;
      const wy = groundAt(wx, wz);
      if (Math.abs(wy - p.y) > 3) continue;
      place(globalSink, wx, wy, wz, Math.atan2(-nx, -nz), tint(0.04), (emit) => {
        emit('cream', kmGeo, 0, 0, 0);
        emit('poster', planeG(0.2, 0.3), 0, 0.46, 0.09);
      });
      stats.props++;
    }

    // --- hand painted road signs pointing at the POIs ---
    const SIGN = [
      { x: V.x, z: V.z, ry: 0.4, n: 3 },
      { x: layout.pois.spawn.position.x, z: layout.pois.spawn.position.z, ry: 1.2, n: 3 },
      { x: layout.pois.harbor.position.x, z: layout.pois.harbor.position.z, ry: 2.1, n: 2 },
      { x: layout.pois.windmill.position.x, z: layout.pois.windmill.position.z, ry: 0.2, n: 2 },
      { x: layout.pois.mill.position.x, z: layout.pois.mill.position.z, ry: 2.8, n: 2 },
      { x: layout.pois.farm.position.x, z: layout.pois.farm.position.z, ry: 1.6, n: 2 },
      { x: layout.pois.camp.position.x, z: layout.pois.camp.position.z, ry: 0.9, n: 3 },
      { x: layout.pois.orchard.position.x, z: layout.pois.orchard.position.z, ry: 2.4, n: 2 },
      { x: layout.pois.bench.position.x, z: layout.pois.bench.position.z, ry: 0.3, n: 2 },
      { x: layout.pois.boardwalk.position.x, z: layout.pois.boardwalk.position.z, ry: 1.9, n: 2 },
    ];
    for (const s of SIGN) {
      const sp = spotNear(s.x, s.z, 8, 16, { tries: 60, w: 2, d: 1, maxRise: 0.7, clear: { road: 6, poi: 0, river: 6, maxSlope: 0.35 } });
      if (!sp) continue;
      place(globalSink, sp.x, sp.y, sp.z, s.ry + rng.range(-0.2, 0.2), tint(0.04), (emit) => {
        emit('woodDark', plankG(0.16, 2.5, 0.16, 0.03), 0, 1.25, 0);
        emit('wood', plankG(1.9, 0.12, 0.16, 0.02), 0, 2.52, 0.06);
        for (let k = 0; k < s.n; k++) {
          emit('poster', boxG(1.72 - k * 0.16, 0.42, 0.08, 1.72 - k * 0.16), (k % 2 ? 1 : -1) * 0.06, 2.26 - k * 0.46, 0.06, { ry: k % 2 ? 0.12 : -0.1 });
        }
      });
      addCollider(sp.x, sp.z, 0.5, 'sign');
      recordSample(sp.x, sp.y, sp.z);
      stats.props += 2;
    }

    // --- bus-stop style shelter by the spawn gate ---
    const shelter = roadsideSpot(4, 1, { w: 4.4, d: 3.0, offsets: [11, 14, 17], maxRise: 0.7, levelWithRoad: 3.4 });
    if (shelter) {
      place(globalSink, shelter.x, shelter.y, shelter.z, shelter.ry, tint(0.05), (emit, f) => {
        emit('stone', boxG(4.6, 0.24, 3.2, 1.6), 0, 0.12, 0);
        for (const px of [-2.0, 2.0]) emit('woodDark', plankG(0.16, 2.5, 0.16, 0.03), px, 1.4, 1.3);
        emit('planksDark', boxG(4.6, 2.0, 0.14, 1.4), 0, 2.0, 1.45);
        emit('planksRed', boxG(5.0, 0.16, 3.4, 1.4), 0, 2.78, 0.32, { rx: 0.1 });
        emit('planksRed', boxG(5.0, 0.16, 3.4, 1.4), 0, 2.78, -0.32, { rx: -0.1 });
        emit('wood', plankG(4.2, 0.14, 1.5, 0.03), 0, 0.62, 0.2);
        for (const px of [-1.8, 0, 1.8]) emit('woodDark', plankG(0.14, 0.5, 0.14, 0.02), px, 0.3, 0.2);
        emit('poster', boxG(1.6, 1.1, 0.08, 1.6), 0, 1.7, 1.32);
        emit('iron', cylG(0.07, 0.07, 0.5, 8, 0.6), 0, 2.7, 0.6);
        addLampRef(f, 0, 2.36, 0.6, MAT.globe, 'shelter');
      });
      poolGlobe.push(shelter.x + Math.sin(shelter.ry) * 0.6, shelter.y + 2.36, shelter.z + Math.cos(shelter.ry) * 0.6, 0, 1.15);
      addCollider(shelter.x, shelter.z, 1.8, 'building');
      recordSample(shelter.x, shelter.y, shelter.z);
      stats.buildings++;
      stats.props += 3;
    }

    // --- scenic overlook at layout.pois.bench: bench + railing + cairn ---
    const BP = layout.pois.bench.position;
    const by = groundAt(BP.x, BP.z);
    const vry = Math.atan2(-BP.x, -BP.z);
    place(globalSink, BP.x, by, BP.z, vry, tint(0.05), (emit) => {
      emit('planks', boxG(2.3, 0.14, 0.6, 1.2), 0, 0.52, 0);
      emit('planksDark', boxG(2.3, 0.5, 0.12, 1.1), 0, 0.8, -0.28);
      for (const px of [-0.9, 0.9]) {
        emit('woodDark', plankG(0.14, 0.5, 0.14, 0.02), px, 0.26, 0.2);
        emit('woodDark', plankG(0.14, 0.95, 0.14, 0.02), px, 0.48, -0.22);
        emit('wood', plankG(0.16, 0.12, 0.66, 0.02), px, 0.5, 0);
      }
      for (let s = 0; s < 5; s++) {
        const rr = 0.42 - s * 0.06;
        emit('stone', cylG(rr * 0.85, rr, 0.18, 8, 0.8), -2.9 + rng.range(-0.05, 0.05), 0.1 + s * 0.19, 1.1 + rng.range(-0.05, 0.05));
      }
      emit('stone', icoG(0.2, 0), -2.9, 1.08, 1.1);
      emit('bark', cylG(0.14, 0.18, 1.6, 6, 0.9), 2.6, 0.8, 0.6, { rz: 0.35 });
      emit('canopy', icoG(0.5, 0), 2.8, 1.55, 0.6);
    });
    {
      let prev = null;
      for (let i = -4; i <= 6; i++) {
        const rx = BP.x + Math.sin(vry + Math.PI / 2) * i * 1.7 + Math.sin(vry) * 3.4;
        const rz = BP.z + Math.cos(vry + Math.PI / 2) * i * 1.7 + Math.cos(vry) * 3.4;
        const ry2 = groundAt(rx, rz);
        place(globalSink, rx, ry2, rz, 0, tint(0.05), (emit) => {
          emit('woodDark', plankG(0.14, 1.15, 0.14, 0.02), 0, 0.58, 0);
        });
        if (prev) {
          place(globalSink, 0, 0, 0, 0, WHITE, (emit) => {
            emitLine(emit, 'wood', prev.x, prev.y + 1.05, prev.z, rx, ry2 + 1.05, rz, 0.075);
            emitLine(emit, 'wood', prev.x, prev.y + 0.55, prev.z, rx, ry2 + 0.55, rz, 0.06);
          });
        }
        prev = { x: rx, y: ry2, z: rz };
        stats.props++;
      }
    }
    addCollider(BP.x, BP.z, 1.3, 'bench');
    recordSample(BP.x, by, BP.z);
    stats.buildings++;
    stats.props += 2;
    addFlag(BP.x + 3.8, BP.z + 2.4, vry, 'fabricRed');
  }

  /* ======================================================================
   * 8. SCATTERED DETAILS
   * ==================================================================== */

  {
    // --- fenced pastures beside the ring road (+ a water trough) ---
    for (let i = 0; i < 2; i++) {
      const idx = i === 0 ? 196 : 268;
      const p = roadAt(idx);
      const d = roadDir(idx);
      const s = i === 0 ? -1 : 1;
      const cx = p.x - d.dz * s * 21;
      const cz = p.z + d.dx * s * 21;
      const w = 34, dd = 24;
      const ry = Math.atan2(d.dx, d.dz) + (i ? 0.5 : -0.5);
      const cos = Math.cos(ry), sin = Math.sin(ry);
      const toW = (lx, lz) => ({ x: cx + cos * lx + sin * lz, z: cz - sin * lx + cos * lz });
      const c0 = toW(-w / 2, -dd / 2), c1 = toW(w / 2, -dd / 2);
      const c2 = toW(w / 2, dd / 2), c3 = toW(-w / 2, dd / 2);
      fenceChain(c0.x, c0.z, c1.x, c1.z);
      fenceChain(c1.x, c1.z, c2.x, c2.z);
      fenceChain(c2.x, c2.z, c3.x, c3.z);
      fenceChain(c3.x, c3.z, c0.x, c0.z);
      const tgt = toW(rng.range(-8, 8), rng.range(-6, 6));
      const ty = groundAt(tgt.x, tgt.z);
      place(globalSink, tgt.x, ty, tgt.z, rng.float() * TAU, tint(0.06), (emit) => {
        emit('planksDark', boxG(2.2, 0.5, 0.7, 1.1), 0, 0.3, 0);
        for (const sx of [-0.95, 0.95]) {
          for (const sz of [-0.28, 0.28]) emit('wood', plankG(0.12, 0.5, 0.12, 0.02), sx, 0.25, sz);
        }
        emit('hay', cylG(0.5, 0.5, 1.3, 10, 1.1), 2.4, 0.5, 0.4, { rz: Math.PI / 2 });
      });
      stats.props += 2;
      recordSample(tgt.x, ty, tgt.z);
    }

    // --- mailboxes by the village doors ---
    for (let i = 0; i < (DET > 0 ? 6 : 4); i++) {
      const h = houses.length ? houses[rng.irange(0, houses.length - 1)] : null;
      if (!h || !h.spot) continue;
      const mx = h.spot.x + Math.sin(h.spot.ry) * rng.range(5, 8);
      const mz = h.spot.z + Math.cos(h.spot.ry) * rng.range(5, 8);
      if (layout.onRoad(mx, mz, 1.2)) continue;
      const myy = groundAt(mx, mz);
      place(globalSink, mx, myy, mz, h.spot.ry, tint(0.05), (emit) => {
        emit('woodDark', plankG(0.11, 1.2, 0.11, 0.02), 0, 0.6, 0);
        emit('paintedMetal', boxG(0.34, 0.3, 0.46, 0.8), 0, 1.32, 0);
        emit('paintedMetal', latheG('mailCap', [[0.24, 0], [0.24, 0.06], [0.05, 0.2]], 8, 0.6), 0, 1.47, 0);
        emit('fabricRed', plankG(0.05, 0.16, 0.05, 0.01), 0.17, 1.42, -0.1);
      });
      addCollider(mx, mz, 0.4, 'mailbox');
      stats.props++;
      recordSample(mx, myy, mz);
    }

    // --- birdhouses on poles ---
    for (let i = 0; i < (DET > 0 ? 5 : 3); i++) {
      const a = rng.float() * TAU;
      const bx = V.x + Math.cos(a) * rng.range(30, 90);
      const bz = V.z + Math.sin(a) * rng.range(30, 90);
      if (!layout.isClear(bx, bz, { road: 9, poi: 0, river: 8, maxSlope: 0.32 })) continue;
      const byy = groundAt(bx, bz);
      place(globalSink, bx, byy, bz, rng.float() * TAU, tint(0.06), (emit) => {
        emit('wood', cylG(0.07, 0.09, 2.6, 6, 1.0), 0, 1.3, 0);
        emit('planksDark', boxG(0.42, 0.44, 0.36, 0.7), 0, 2.7, 0);
        emit('roofSlate', boxG(0.62, 0.08, 0.56, 0.6), 0, 2.95, 0.16, { rx: 0.35 });
        emit('roofSlate', boxG(0.62, 0.08, 0.56, 0.6), 0, 2.95, -0.16, { rx: -0.35 });
        emit('wood', cylG(0.06, 0.06, 0.08, 6, 0.4), 0, 2.72, 0.2);
      });
      stats.props++;
      recordSample(bx, byy, bz);
    }

    // --- garden plots beside the village houses ---
    for (let i = 0; i < (DET > 0 ? 4 : 2); i++) {
      const h = houses.length ? houses[rng.irange(0, houses.length - 1)] : null;
      if (!h || !h.spot) continue;
      const gx = h.spot.x + Math.sin(h.spot.ry + Math.PI / 2) * rng.range(7, 12);
      const gz = h.spot.z + Math.cos(h.spot.ry + Math.PI / 2) * rng.range(7, 12);
      if (!layout.isClear(gx, gz, { road: 9, poi: 0, river: 8, maxSlope: 0.3 })) continue;
      const gy = groundAt(gx, gz);
      const gry = h.spot.ry;
      place(globalSink, gx, gy, gz, gry, tint(0.05), (emit) => {
        emit('dirt', boxG(5.0, 0.26, 3.4, 1.4), 0, 0.1, 0);
        for (let r = 0; r < 4; r++) emit('dirt', boxG(0.5, 0.18, 3.0, 0.9), -1.8 + r * 1.2, 0.22, 0);
        for (const px of [-2.6, 2.6]) {
          for (const pz of [-1.8, 0, 1.8]) emit('wood', plankG(0.1, 0.5, 0.1, 0.02), px, 0.25, pz);
        }
        emit('gravel', boxG(5.4, 0.1, 0.5, 1.0), 0, 0.06, 1.9);
      });
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 5; c++) {
          const lx = -1.8 + r * 1.2;
          const lz = -1.4 + c * 0.7;
          const wx = gx + Math.cos(gry) * lx + Math.sin(gry) * lz;
          const wz = gz - Math.sin(gry) * lx + Math.cos(gry) * lz;
          poolVine.push(wx, groundAt(wx, wz) - 0.05, wz, rng.float() * TAU, rng.range(0.42, 0.6));
          stats.props++;
        }
      }
      recordSample(gx, gy, gz);
    }

    // --- upturned boats on the harbour beach ---
    for (let i = 0; i < 2; i++) {
      const a = rng.float() * TAU;
      const ux = H.x + Math.cos(a) * rng.range(18, 34);
      const uz = H.z + Math.sin(a) * rng.range(18, 34);
      if (layout.heightAt(ux, uz) < 0.5) continue;
      const uy = groundAt(ux, uz);
      place(globalSink, ux, uy, uz, rng.float() * TAU, tint(0.07), (emit) => {
        emit('planks', hullG(3.8, 1.4, 0.66), 0, 0.7, 0, { rx: Math.PI });
        emit('wood', plankG(1.7, 0.2, 0.2, 0.03), -0.9, 0.75, 0.4, { rz: 0.2 });
        emit('wood', plankG(1.7, 0.2, 0.2, 0.03), 0.9, 0.75, -0.4, { rz: -0.2 });
        emit('rope', torusG(0.25, 0.05, 5, 12), 0.7, 0.1, 1.3, { rx: Math.PI / 2 });
      });
      addCollider(ux, uz, 1.8, 'boat');
      recordSample(ux, uy, uz);
      stats.props += 2;
    }

    // --- cairns on the spur trails + a plank bridge over each deep gully ---
    const spurIds = Object.keys(layout.spurs);
    let cairnCount = 0, bridgeCount = 0;
    for (const id of spurIds) {
      const sp = layout.spurs[id];
      const tmp = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 1 };
      for (let k = 0; k < 2; k++) {
        sp.point(0.25 + k * 0.5, tmp);
        const nx = -tmp.dirZ, nz = tmp.dirX;
        const side = rng.chance(0.5) ? 1 : -1;
        const cx2 = tmp.x + nx * 4.5 * side, cz2 = tmp.z + nz * 4.5 * side;
        if (!layout.isClear(cx2, cz2, { road: 5, poi: 0, river: 3, maxSlope: 0.6, minHeight: 1.5 })) continue;
        const cy2 = groundAt(cx2, cz2);
        place(globalSink, cx2, cy2, cz2, rng.float() * TAU, tint(0.07), (emit) => {
          for (let s = 0; s < 5; s++) {
            const rr = 0.42 - s * 0.06;
            emit('stone', cylG(rr * 0.85, rr, 0.18, 8, 0.8), rng.range(-0.06, 0.06), 0.1 + s * 0.19, rng.range(-0.06, 0.06));
          }
          emit('stone', icoG(0.2, 0), 0.08, 1.06, 0.05);
          emit('canopy', icoG(0.15, 0), -0.25, 0.25, 0.18);
        });
        addCollider(cx2, cz2, 0.6, 'cairn');
        stats.props++;
        cairnCount++;
        recordSample(cx2, cy2, cz2);
      }
      // a gully crossing reads as terrain falling away on BOTH sides of the trail
      let best = null;
      const tmpA = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 1 };
      const tmpB = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 1 };
      for (let s = 0; s <= 40; s++) {
        const t = 0.06 + (s / 40) * 0.88;
        sp.point(t, tmp);
        const nx = -tmp.dirZ, nz = tmp.dirX;
        const side = Math.min(
          tmp.y - groundAt(tmp.x + nx * 10, tmp.z + nz * 10),
          tmp.y - groundAt(tmp.x - nx * 10, tmp.z - nz * 10),
        );
        if (side < 1.2) continue;
        sp.point(Math.max(0, t - 0.014), tmpA);
        sp.point(Math.min(1, t + 0.014), tmpB);
        const along = tmp.y - Math.max(tmpA.y, tmpB.y);
        if (along > 0.3) continue;               // must also be a low point along the trail
        const score = side - along;
        if (!best || score > best.score) best = { score, x: tmp.x, z: tmp.z };
      }
      if (!best) continue;
      sp.point(0.5, tmp);
      const dirX = tmp.dirX, dirZ = tmp.dirZ;
      const rx = -dirZ, rz = dirX;
      const ax = best.x + rx * 4.2, az = best.z + rz * 4.2;
      const bx2 = best.x - rx * 4.2, bz2 = best.z - rz * 4.2;
      const ay = groundAt(ax, az), by2 = groundAt(bx2, bz2);
      const deckY = Math.max(ay, by2) + 0.4;
      const bLen = 8.6;
      const bRy = Math.atan2(bx2 - ax, bz2 - az);
      const midX = (ax + bx2) * 0.5, midZ = (az + bz2) * 0.5;
      place(globalSink, midX, 0, midZ, bRy, tint(0.05), (emit) => {
        for (let i = 0; i < 5; i++) {
          emit('planks', boxG(2.0, 0.14, bLen / 5, 1.1), 0, deckY, ((i + 0.5) / 5) * bLen - bLen / 2);
        }
        emit('wood', plankG(bLen, 0.12, 0.14, 0.02), -0.85, deckY + 0.75, 0, { rx: Math.PI / 2 });
        emit('wood', plankG(bLen, 0.12, 0.14, 0.02), 0.85, deckY + 0.75, 0, { rx: Math.PI / 2 });
        for (const lz of [-3.2, 0, 3.2]) {
          for (const sx of [-0.85, 0.85]) emit('woodDark', plankG(0.11, 1.0, 0.11, 0.02), sx, deckY + 0.5, lz);
        }
        for (const lz of [-2.2, 2.2]) {
          const g = groundAt(midX + Math.sin(bRy) * lz, midZ + Math.cos(bRy) * lz);
          const hh2 = Math.max(0.4, deckY - 0.1 - g);
          for (const sx of [-0.7, 0.7]) emit('woodDark', cylG(0.14, 0.16, hh2, 8, 1.0), sx, g + hh2 * 0.5, lz);
        }
      });
      stats.props += 2;
      bridgeCount++;
      recordSample(ax, ay, az);
      recordSample(bx2, by2, bz2);
    }
    stats.cairns = cairnCount;
    stats.trailBridges = bridgeCount;
  }

  /* ---- merge the static batches: one mesh per shared material ---- */

  const staticMeshes = [];
  for (const [matKey, buf] of batches) {
    if (buf.n < 3) continue;
    const mesh = new THREE.Mesh(buf.geometry(), MAT[matKey]);
    const meta = MAT_META[matKey] || { cast: true, receive: true };
    mesh.castShadow = meta.cast !== false;
    mesh.receiveShadow = meta.receive !== false;
    mesh.name = `props:${matKey}`;
    group.add(mesh);
    staticMeshes.push({ key: matKey, mesh });
  }
  const globeMesh = poolGlobe.build(group);
  poolFence.build(group);
  poolWall.build(group);
  poolTerrace.build(group);
  poolCrop.build(group);
  poolVine.build(group);

  // register the concrete meshes on the lamp entries now that they exist
  let glassRef = null;
  for (const s of staticMeshes) if (s.key === 'glass') glassRef = s.mesh;
  for (const l of lamps) {
    if (!l.mesh) l.mesh = l.material === MAT.globe ? globeMesh : glassRef;
  }

  let drawCalls = 0, tris = 0;
  group.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    drawCalls++;
    const g = o.geometry;
    const count = g.index ? g.index.count : g.attributes.position.count;
    tris += (count / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  stats.drawCalls = drawCalls;
  stats.triangles = Math.round(tris);
  stats.materials = Object.keys(MAT).length;

  /* ---- per-frame animation: numbers only, no allocations ---- */

  let time = 0;
  let lastNight = -1;

  function update(dt, state) {
    time += dt > 0 ? dt : 0;
    for (let i = 0; i < anim.spins.length; i++) {
      const s = anim.spins[i];
      s.obj.rotation.x = time * s.speed + s.phase;
    }
    const wind = state && state.wind && typeof state.wind.strength === 'number' ? state.wind.strength : 0.4;
    const gust = state && state.wind && typeof state.wind.gust === 'number' ? state.wind.gust : 0;
    const amp = 0.75 + wind * 0.6 + gust * 0.5;
    for (let i = 0; i < anim.sways.length; i++) {
      const s = anim.sways[i];
      const a = Math.sin(time * 1.7 + s.phase * 3.1) * s.amp * amp
        + Math.sin(time * 4.3 + s.phase) * s.amp * 0.25 * amp;
      if (s.axis === 'x') s.obj.rotation.x = s.base + a;
      else if (s.axis === 'y') s.obj.rotation.y = s.base + a;
      else s.obj.rotation.z = s.base + a;
    }
    for (let i = 0; i < anim.boats.length; i++) {
      const b = anim.boats[i];
      const ph = time * b.sp + b.phase;
      b.obj.position.y = b.y + Math.sin(ph) * b.amp;
      b.obj.rotation.z = Math.sin(ph * 0.83) * 0.05;
      b.obj.rotation.x = Math.sin(ph * 0.61 + 1.1) * 0.03;
    }
    const hour = state && typeof state.hour === 'number' ? state.hour : 12;
    let night = 0;
    if (hour < 6.3 || hour > 19.7) night = 1;
    else if (hour < 6.5) night = (6.5 - hour) / 0.2;
    else if (hour > 19.5) night = (hour - 19.5) / 0.2;
    if (night !== lastNight) {
      lastNight = night;
      for (let i = 0; i < anim.mats.length; i++) {
        const m = anim.mats[i];
        m.mat.emissiveIntensity = night * 1.5 * m.scale;
      }
    }
  }

  // memorise rest rotations so swaying never drifts
  for (const s of anim.sways) {
    s.base = s.axis === 'x' ? s.obj.rotation.x : s.axis === 'y' ? s.obj.rotation.y : s.obj.rotation.z;
  }
  stats.animated = anim.spins.length + anim.sways.length + anim.boats.length;

  return { group, update, colliders, chimneys, lamps, stats, samples };
}
