/**
 * layout.js - the island. Pure math, no rendering.
 *
 * Everything else in the game (terrain mesh, ocean foam, road ribbon,
 * vegetation placement, POI construction, physics) queries this module.
 * Must stay deterministic and fast: heightAt() is called every physics frame.
 *
 * See docs/SPEC.md §4.5 for the frozen public API.
 */

import * as THREE from 'three';
import {
  SimplexNoise2D, Rng, PolylineDistanceField,
  clamp, clamp01, lerp, smoothstep, smootherstep, TAU, wrapAngle,
} from '../core/utils.js';
import { GAME } from '../core/settings.js';

const angDiff = (a, b) => wrapAngle(a - b);
const gauss = (d, s) => Math.exp(-(d / s) * (d / s));

export function createLayout(seed = GAME.defaultSeed) {
  const HALF = GAME.worldSize / 2;
  const WATER_LEVEL = 0;
  const LAKE_X = -520, LAKE_Z = 180, LAKE_R = 330, LAKE_Y = 22;
  const ROAD_WIDTH = GAME.roadWidth;
  /** Where the ring road crosses the river (used to place the bridge deck). */
  const bridgeXGuess = { x: 810, z: 1400 };

  const nCoast = new SimplexNoise2D(`${seed}:coast`);
  const nLake = new SimplexNoise2D(`${seed}:lake`);
  const nHills = new SimplexNoise2D(`${seed}:hills`);
  const nDetail = new SimplexNoise2D(`${seed}:detail`);
  const nRidge = new SimplexNoise2D(`${seed}:ridge`);
  const nSplat = new SimplexNoise2D(`${seed}:splat`);

  // -------------------------------------------------------------------------
  // Coastline
  // -------------------------------------------------------------------------

  /** Distance from island center to the shoreline at angle theta. */
  function coastRadius(theta) {
    let r = 2180;
    r += 300 * nCoast.fbm(Math.cos(theta) * 1.15 + 40.3, Math.sin(theta) * 1.15 + 40.3, 4);
    r -= 210 * gauss(angDiff(theta, 0.62), 0.34);     // SE harbour bay
    r += 430 * gauss(angDiff(theta, -0.78), 0.30);    // NE lighthouse peninsula
    r += 250 * gauss(angDiff(theta, -2.60), 0.42);    // NW headland
    r -= 260 * gauss(angDiff(theta, 1.90), 0.30);     // SW bay
    r += 170 * gauss(angDiff(theta, 2.95), 0.32);     // W cape
    return r;
  }

  /** Signed distance to the shoreline along the radial direction (+ = land). */
  function shoreDistance(x, z) {
    const r = Math.hypot(x, z);
    const theta = Math.atan2(z, x);
    return r - coastRadius(theta);
  }

  // -------------------------------------------------------------------------
  // Terrain body (before lake / river / road carving)
  // -------------------------------------------------------------------------

  function baseLand(x, z, u) {
    const t = clamp01(1 - u / 0.92);
    let h = 38 * smootherstep(0, 0.14, t);

    // Central massif (the peak) - a noise-modulated dome
    const dPeak = Math.hypot(x + 250, z + 850);
    const massif = gauss(dPeak, 900) * 0.65 + gauss(dPeak, 480) * 0.55;
    h += 250 * massif * smoothstep(0.08, 0.5, t);

    // West ridge
    const westRidge = Math.exp(-Math.pow(Math.abs(x + 1250) / 950, 1.8)) * gauss(Math.abs(z + 100), 1500);
    h += 165 * westRidge * smoothstep(0.05, 0.45, t);

    // Rolling hills + medium detail + alpine ridges
    h += 46 * nHills.fbm(x * 0.00085, z * 0.00085, 4) * smootherstep(0, 0.22, t);
    h += 12 * nDetail.fbm(x * 0.0042, z * 0.0042, 3) * smootherstep(0, 0.30, t);
    h += 74 * (nRidge.ridged(x * 0.0016 + 5, z * 0.0016 + 5, 4) - 0.46) * massif * smoothstep(0.08, 0.5, t);
    return h;
  }

  /** Terrain before lake/river/road carving. */
  function terrainRaw(x, z) {
    const r = Math.hypot(x, z);
    const theta = Math.atan2(z, x);
    const u = r / coastRadius(theta);
    let h;
    if (u >= 1) {
      const s = clamp01((u - 1) / 0.55);
      // The sea floor has to leave the waterline at 0, not at -5 m: the old
      // constant put a 5 m step exactly at the shoreline, which the terrain
      // mesh rendered as a vertical wall of grass with no beach at all.
      // A continuous, gentler shelf also gives the water shader a real depth
      // gradient to paint the shallows with.
      h = -108 * smootherstep(0, 1, s);
      h += 6 * nDetail.fbm(x * 0.006, z * 0.006, 2) * s;   // sea floor texture
    } else {
      // 1 deep inland -> 0 at the waterline (u = 1)
      const inlandBlend = 1 - smootherstep(0.90, 1.0, u);
      const beachRamp = 1 - smootherstep(0.93, 1.0, u);
      h = baseLand(x, z, u) * inlandBlend;
      h += 2.6 * beachRamp;                                // gentle shelf above the waterline

      // West cliffs: steep uplift near the shore + striations.
      // NOTE: lift ramps 0 inland -> 1 at the coastline.
      const westMask = gauss(angDiff(theta, Math.PI), 0.62);
      if (westMask > 0.02) {
        h += westMask * (46 * smootherstep(0.965, 0.998, u) + 14 * smootherstep(0.988, 0.9995, u));
        h += westMask * 9 * nRidge.ridged(x * 0.012 + 9, z * 0.012 + 9, 3) * smootherstep(0.94, 0.99, u);
      }
    }
    return h;
  }

  // -------------------------------------------------------------------------
  // The river (lake -> sea) and the ring road
  // -------------------------------------------------------------------------

  const riverCtrl = [
    [-400, 350], [-220, 520], [0, 700], [240, 880],
    [520, 1080], [760, 1310], [900, 1560], [980, 1800],
    [1050, 2050], [1120, 2320],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));

  const riverCurve = new THREE.CatmullRomCurve3(riverCtrl, false, 'catmullrom', 0.5);
  const riverSampleCount = 420;
  const riverPts3 = riverCurve.getSpacedPoints(riverSampleCount);
  const riverXZ = new Float32Array((riverSampleCount + 1) * 2);
  for (let i = 0; i <= riverSampleCount; i++) {
    riverXZ[i * 2] = riverPts3[i].x;
    riverXZ[i * 2 + 1] = riverPts3[i].z;
  }
  const riverField = new PolylineDistanceField(riverXZ, { cellSize: 30, pad: 120, closed: false });

  /** River bed height along the course (0 = lake outlet, 1 = sea). */
  function riverBedY(t) {
    const table = [
      [0.00, 21.0],
      [0.10, 20.2],
      [0.155, 19.7],
      [0.175, 10.6],   // waterfall step
      [0.30, 9.4],
      [0.50, 4.6],
      [0.70, 2.4],
      [0.85, 0.4],
      [1.00, -4.0],
    ];
    for (let i = 0; i < table.length - 1; i++) {
      const [t0, y0] = table[i];
      const [t1, y1] = table[i + 1];
      if (t <= t1) {
        const k = clamp01((t - t0) / (t1 - t0));
        return lerp(y0, y1, k * k * (3 - 2 * k));
      }
    }
    return table[table.length - 1][1];
  }

  // --- ring road ---
  const roadCtrl = [
    [0, 1620], [620, 1520], [1080, 1230], [1330, 850], [1240, 420],
    [900, 60], [1180, -420], [1420, -980], [900, -1500], [150, -1650],
    [-450, -1450], [-950, -1150], [-1450, -700], [-1650, -100], [-1780, 380],
    [-1500, 700], [-980, 780], [-620, 620], [-120, 1250],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const roadCurve = new THREE.CatmullRomCurve3(roadCtrl, true, 'catmullrom', 0.5);

  const roadSampleCount = 900;
  const roadPts = roadCurve.getSpacedPoints(roadSampleCount); // count+1, last == first
  const roadN = roadSampleCount; // unique points
  const roadXZ = new Float32Array(roadN * 2);
  const roadStepLen = roadCurve.getLength() / roadN;
  for (let i = 0; i < roadN; i++) {
    roadXZ[i * 2] = roadPts[i].x;
    roadXZ[i * 2 + 1] = roadPts[i].z;
  }
  const roadField = new PolylineDistanceField(roadXZ, { cellSize: 26, pad: 80, closed: true });

  /** Distance from (x,z) to the river centerline. */
  function riverDistance(x, z) {
    const c = riverField.closest(x, z, 400);
    return c ? c.dist : 1e9;
  }
  /** Distance from (x,z) to the ring-road centerline. */
  function roadDistance(x, z) {
    const c = roadField.closest(x, z, 200);
    return c ? c.dist : 1e9;
  }

  // --- road elevation profile: sample raw terrain, smooth heavily -------------
  function smoothProfile(arr, passes, radius) {
    let cur = arr;
    for (let p = 0; p < passes; p++) {
      const next = new Float32Array(cur.length);
      for (let i = 0; i < cur.length; i++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = ((i + k) % cur.length + cur.length) % cur.length;
          sum += cur[j]; n++;
        }
        next[i] = sum / n;
      }
      cur = next;
    }
    return cur;
  }
  function limitGrade(arr, maxGrade, step, passes = 3) {
    const out = Float32Array.from(arr);
    const maxDelta = maxGrade * step;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < out.length; i++) {
        const j = (i + 1) % out.length;
        const d = out[j] - out[i];
        if (d > maxDelta) { const fix = (d - maxDelta) * 0.5; out[i] += fix; out[j] -= fix; }
        else if (d < -maxDelta) { const fix = (-d - maxDelta) * 0.5; out[i] -= fix; out[j] += fix; }
      }
    }
    return out;
  }

  let roadY = new Float32Array(roadN);
  for (let i = 0; i < roadN; i++) roadY[i] = terrainRaw(roadXZ[i * 2], roadXZ[i * 2 + 1]);
  roadY = smoothProfile(roadY, 3, 22);
  roadY = limitGrade(roadY, 0.085, roadStepLen, 10);
  roadY = smoothProfile(roadY, 1, 3);
  // keep the deck above the river gorge (bridge zone)
  for (let i = 0; i < roadN; i++) {
    const x = roadXZ[i * 2], z = roadXZ[i * 2 + 1];
    const rc = riverField.closest(x, z, 70);
    if (rc) {
      const tP = (rc.index + rc.t) / riverSampleCount;
      const bed = riverBedY(tP);
      if (roadY[i] < bed + 14) roadY[i] = bed + 14;
    }
  }
  roadY = limitGrade(roadY, 0.095, roadStepLen, 14);

  function roadYAtIndex(i, t) {
    const a = roadY[((i % roadN) + roadN) % roadN];
    const b = roadY[(((i + 1) % roadN) + roadN) % roadN];
    return lerp(a, b, t);
  }

  // --- spurs -----------------------------------------------------------------
  const spurDefs = {
    lighthouse: {
      pts: [[1420, -980], [1610, -1230], [1750, -1480], [1800, -1660]],
      width: 4.0, maxGrade: 0.16, smoothRadius: 8, smoothPasses: 2,
    },
    harbor: {
      pts: [[1330, 850], [1450, 980], [1650, 1180]],
      width: 4.4, maxGrade: 0.14, smoothRadius: 8, smoothPasses: 2,
    },
    summit: {
      pts: [[-450, -1450], [-700, -1270], [-560, -1100], [-760, -1010], [-470, -950], [-250, -895]],
      width: 3.4, maxGrade: 0.20, smoothRadius: 6, smoothPasses: 2,
    },
    lake: {
      pts: [[-620, 620], [-670, 520], [-650, 470]],
      width: 4.0, maxGrade: 0.15, smoothRadius: 5, smoothPasses: 2,
    },
  };

  const spurFields = {};
  const spurYs = {};
  const spurStep = {};
  const spurN = {};
  const spurPtsXZ = {};
  const spurCurves = {};

  for (const [id, def] of Object.entries(spurDefs)) {
    const curve = new THREE.CatmullRomCurve3(def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'catmullrom', 0.5);
    spurCurves[id] = curve;
    const count = Math.max(24, Math.round(curve.getLength() / 6));
    const pts = curve.getSpacedPoints(count);
    const xz = new Float32Array((count + 1) * 2);
    for (let i = 0; i <= count; i++) { xz[i * 2] = pts[i].x; xz[i * 2 + 1] = pts[i].z; }
    spurFields[id] = new PolylineDistanceField(xz, { cellSize: 24, pad: 60, closed: false });
    spurN[id] = count;
    const step = curve.getLength() / count;
    spurStep[id] = step;
    // heights sampled from terrain that already includes the ring road
    let ys = new Float32Array(count + 1);
    for (let i = 0; i <= count; i++) {
      ys[i] = terrainPreview(pts[i].x, pts[i].z);
    }
    ys = smoothProfileOpen(ys, def.smoothPasses, def.smoothRadius);
    ys = limitGradeOpen(ys, def.maxGrade, step, 4);
    spurYs[id] = ys;
    spurPtsXZ[id] = xz;
  }

  function smoothProfileOpen(arr, passes, radius) {
    let cur = arr;
    for (let p = 0; p < passes; p++) {
      const next = new Float32Array(cur.length);
      for (let i = 0; i < cur.length; i++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = clamp(i + k, 0, cur.length - 1);
          sum += cur[j]; n++;
        }
        next[i] = sum / n;
      }
      cur = next;
    }
    return cur;
  }
  function limitGradeOpen(arr, maxGrade, step, passes) {
    const out = Float32Array.from(arr);
    const maxDelta = maxGrade * step;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < out.length - 1; i++) {
        const d = out[i + 1] - out[i];
        if (d > maxDelta) { const fix = (d - maxDelta) * 0.5; out[i] += fix; out[i + 1] -= fix; }
        else if (d < -maxDelta) { const fix = (-d - maxDelta) * 0.5; out[i] -= fix; out[i + 1] += fix; }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // heightAt - the final terrain surface including all carvings
  // -------------------------------------------------------------------------

  /** Terrain including lake + river carve, before any road carving. */
  function terrainPreview(x, z) {
    let h = terrainRaw(x, z);

    // lake bowl
    const dl = Math.hypot(x - LAKE_X, z - LAKE_Z);
    const lr = LAKE_R * (1 + 0.13 * nLake.fbm(x * 0.004 + 3, z * 0.004 + 3, 3));
    const lm = 1 - smootherstep(0.42, 1.06, dl / lr);
    if (lm > 0.001) {
      h = lerp(h, 14.5, lm);
      const di = Math.hypot(x + 560, z - 210);
      const im = 1 - smootherstep(22, 58, di);
      if (im > 0.001) h = lerp(h, Math.max(h, 25.6), im);
    }

    // river valley (wide dip) then channel floor at the bed height
    const rc = riverField.closest(x, z, 190);
    if (rc) {
      const tP = (rc.index + rc.t) / riverSampleCount;
      const bed = riverBedY(tP);
      const w = 11 + 13 * tP;
      const valley = 1 - smootherstep(0.05, 1, rc.dist / (w * 5.5));
      h -= (5 + 15 * tP) * valley;
      const m = 1 - smootherstep(0.18, 1, rc.dist / w);
      h = lerp(h, bed, m * 0.94);
    }
    return h;
  }

  const gorgeSuppress = { riverDist: 44, roadDist: 26 };

  function heightAt(x, z) {
    let h = terrainPreview(x, z);

    // ring road carve (unless we are over the river gorge = bridge)
    const rr = roadField.closest(x, z, 34);
    let bridgeBlend = 1;
    if (rr) {
      const nearRiver = riverField.closest(x, z, 70);
      if (nearRiver && nearRiver.dist < gorgeSuppress.riverDist) {
        bridgeBlend = lerp(0.06, 1, smootherstep(0.55, 1.0, nearRiver.dist / gorgeSuppress.riverDist));
      }
      const m = (1 - smootherstep(0.38, 1, rr.dist / 11.5)) * bridgeBlend;
      const y = roadYAtIndex(rr.index, rr.t);
      h = lerp(h, y, m);
    }

    for (const id of Object.keys(spurFields)) {
      const f = spurFields[id];
      const c = f.closest(x, z, 16);
      if (c) {
        const ys = spurYs[id];
        const y = lerp(ys[c.index], ys[Math.min(c.index + 1, ys.length - 1)], c.t);
        const w = spurDefs[id].width + 2.2;
        const m = 1 - smootherstep(0.34, 1, c.dist / w);
        h = lerp(h, y, m);
      }
    }
    return h;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  function slopeAt(x, z, eps = 4) {
    const hx = heightAt(x + eps, z) - heightAt(x - eps, z);
    const hz = heightAt(x, z + eps) - heightAt(x, z - eps);
    return Math.hypot(hx, hz) / (2 * eps);
  }

  function normalAt(x, z, out = new THREE.Vector3(), eps = 4) {
    const hx = heightAt(x + eps, z) - heightAt(x - eps, z);
    const hz = heightAt(x, z + eps) - heightAt(x, z - eps);
    out.set(-hx / (2 * eps), 1, -hz / (2 * eps)).normalize();
    return out;
  }

  function waterDepth(x, z) {
    const h = heightAt(x, z);
    // lake surface is above sea level
    const dl = Math.hypot(x - LAKE_X, z - LAKE_Z);
    const inLake = dl < LAKE_R * 1.25;
    const surface = inLake ? LAKE_Y : WATER_LEVEL;
    return Math.max(0, surface - h);
  }

  function isWater(x, z) { return heightAt(x, z) < WATER_LEVEL + 0.05; }
  function isLand(x, z) { return heightAt(x, z) > WATER_LEVEL + 0.3; }

  function onRoad(x, z, margin = 0) {
    return roadDistance(x, z) < ROAD_WIDTH * 0.5 + margin;
  }

  // -------------------------------------------------------------------------
  // POIs - landmark slots (refined to real terrain)
  // -------------------------------------------------------------------------

  function refine(x0, z0, id, {
    search = 140, prefer = 'flat', minHeight = 2.5, maxSlope = 0.34, tries = 120,
    wantShore = null, maxHeight = Infinity,
  } = {}) {
    const rng = new Rng(`${seed}:refine:${id}`);
    let best = null;
    const consider = (x, z, dist, relax = 1) => {
      const h = heightAt(x, z);
      if (h < minHeight * relax || h > maxHeight) return;
      const s = slopeAt(x, z);
      if (s > maxSlope * relax) return;
      let score = -s * 120;
      if (prefer === 'high') score += h * 0.55;
      else if (prefer === 'low') score -= h * 0.35;
      if (wantShore !== null) {
        const sd = shoreDistance(x, z);
        score -= Math.abs(sd - wantShore) * 0.8;
        if (sd < -30) score -= 300;  // must be on land
      }
      if (roadDistance(x, z) < 7) score -= 500;
      if (riverDistance(x, z) < 5) score -= 200;
      score -= dist * 0.25;
      if (!best || score > best.score) best = { x, z, score };
    };
    consider(x0, z0, 0);
    for (let i = 0; i < tries; i++) {
      const a = rng.float() * TAU;
      const rr = Math.sqrt(rng.float()) * search;
      consider(x0 + Math.cos(a) * rr, z0 + Math.sin(a) * rr, rr);
    }
    // Relaxed second pass: widen the search and allow rougher ground so a POI
    // never silently falls back to an underwater/steep ideal point.
    if (!best) {
      for (let i = 0; i < tries * 2; i++) {
        const a = rng.float() * TAU;
        const rr = Math.sqrt(rng.float()) * search * 2.2;
        consider(x0 + Math.cos(a) * rr, z0 + Math.sin(a) * rr, rr, 2.2);
      }
    }
    return best || { x: x0, z: z0, score: 0 };
  }

  const POI_DEFS = [
    // id, name, nameEn, x, z, radius, refineOpts/type
    ['village', '海风村', 'Seabreeze Village', 1330, 850, 250, { prefer: 'flat', maxSlope: 0.22, minHeight: 6, search: 90 }],
    ['chapel', '白墙礼拜堂', 'White Chapel', 1420, 1060, 34, { maxSlope: 0.2, minHeight: 6, search: 70 }],
    ['windmill', '风车山丘', 'Windmill Hill', 980, 690, 46, { prefer: 'high', maxSlope: 0.24, minHeight: 20, search: 160 }],
    ['harbor', '旧鱼港', 'Old Harbour', 1560, 1100, 90, { wantShore: 30, minHeight: 1.2, maxSlope: 0.30, search: 220 }],
    ['lighthouse', '灯塔岬', 'Lighthouse Cape', 1800, -1660, 40, { prefer: 'high', wantShore: 70, minHeight: 8, maxSlope: 0.40, search: 260 }],
    ['peak', '云顶', 'Cloud Peak', -250, -895, 60, { prefer: 'high', minHeight: 180, maxSlope: 0.5, search: 200 }],
    ['observatory', '观星台', 'Observatory', -330, -840, 30, { prefer: 'high', minHeight: 140, maxSlope: 0.4, search: 190 }],
    ['lake', '镜湖', 'Mirror Lake', LAKE_X, LAKE_Z, 300, { type: 'water', skipRefine: true }],
    ['lakeIsland', '湖心小岛', 'Lake Islet', -560, 210, 60, { type: 'water', skipRefine: true }],
    ['lakeside', '湖畔栈台', 'Lakeside Deck', -640, 470, 40, { maxSlope: 0.24, minHeight: 18, search: 80 }],
    ['mill', '水车磨坊', 'Watermill', 700, 1300, 34, { maxSlope: 0.3, minHeight: 4, search: 120 }],
    ['bridge', '石拱桥', 'Stone Bridge', 810, 1400, 60, { skipRefine: true }],
    ['waterfall', '银练瀑布', 'Silverfall', -300, 470, 40, { skipRefine: true }],
    ['orchard', '果园坡', 'Orchard Slope', 700, 420, 110, { maxSlope: 0.26, minHeight: 12, search: 120 }],
    ['vineyard', '葡萄梯田', 'Vineyard Terraces', 520, 520, 100, { maxSlope: 0.3, minHeight: 10, search: 120 }],
    ['farm', '麦田农庄', 'Wheat Farm', 1350, -120, 140, { maxSlope: 0.2, minHeight: 6, search: 150 }],
    ['camp', '北滩营地', 'North Beach Camp', 120, -1720, 70, { wantShore: 40, minHeight: 2, maxSlope: 0.3, search: 140 }],
    ['standingStones', '巨石阵', 'Standing Stones', 1000, -700, 70, { prefer: 'high', maxSlope: 0.22, minHeight: 15, search: 170 }],
    ['treehouse', '树屋', 'Treehouse', -1150, -850, 50, { prefer: 'high', maxSlope: 0.4, minHeight: 12, search: 180 }],
    ['ruins', '古瞭望塔废墟', 'Old Watchtower', -700, 1650, 50, { prefer: 'high', wantShore: 60, minHeight: 8, maxSlope: 0.4, search: 160 }],
    ['arch', '海蚀拱门', 'Sea Arch', 2450, -500, 70, { type: 'water', skipRefine: true }],
    ['seaStacks', '海蚀柱群', 'Sea Stacks', -2450, 320, 90, { type: 'water', skipRefine: true }],
    ['boardwalk', '南滩木栈道', 'South Boardwalk', -480, 1850, 80, { wantShore: 18, minHeight: 1.2, maxSlope: 0.22, search: 130 }],
    ['balloons', '热气球草坪', 'Balloon Meadow', 620, 1120, 90, { maxSlope: 0.2, minHeight: 8, search: 140 }],
    ['bench', '眺望长椅', 'Viewpoint Bench', -1520, -40, 26, { prefer: 'high', maxSlope: 0.3, minHeight: 20, search: 120 }],
    ['forest', '西林', 'West Woods', -1250, -250, 900, { type: 'region', skipRefine: true }],
    ['pineForest', '北松林', 'Pinewoods', 750, -1350, 780, { type: 'region', skipRefine: true }],
    ['beach', '南沙滩', 'South Beach', -60, 1900, 220, { type: 'region', skipRefine: true }],
    ['beachEast', '东沙滩', 'East Beach', 1850, 300, 180, { type: 'region', skipRefine: true }],
  ];

  const pois = {};
  for (const [id, name, nameEn, x0, z0, radius, opts] of POI_DEFS) {
    const o = opts || {};
    let x = x0, z = z0;
    if (!o.skipRefine) {
      const r = refine(x0, z0, id, o);
      x = r.x; z = r.z;
    }
    const y = o.type === 'water' && id !== 'lake' && id !== 'lakeIsland' ? 0 : heightAt(x, z);
    pois[id] = {
      id, name, nameEn,
      position: new THREE.Vector3(x, id === 'lake' ? LAKE_Y : y, z),
      radius,
      type: o.type || 'landmark',
    };
  }

  // spawn: on the ring road at t=0 (south gate), facing along the road
  {
    const t0 = 0.0;
    const p = roadCurve.getPointAt(t0);
    const p2 = roadCurve.getPointAt((t0 + 0.004) % 1);
    const spawnX = p.x, spawnZ = p.z;
    pois.spawn = {
      id: 'spawn', name: '起跑线', nameEn: 'Start / Finish', radius: 26, type: 'spawn',
      position: new THREE.Vector3(spawnX, heightAt(spawnX, spawnZ), spawnZ),
      heading: Math.atan2(p2.x - p.x, p2.z - p.z),
    };
    pois.gates = { ...pois.spawn, id: 'gates', name: '环岛起点', nameEn: 'Island Gate' };
  }

  // waterfall + pool derived from the river course
  {
    const wf = riverCurve.getPointAt(0.165);
    const pool = riverCurve.getPointAt(0.23);
    pois.waterfall.position.set(wf.x, heightAt(wf.x, wf.z) + 8.5, wf.z);
    pois.pool = {
      id: 'pool', name: '碧潭', nameEn: 'Jade Pool', radius: 30, type: 'water',
      position: new THREE.Vector3(pool.x, heightAt(pool.x, pool.z), pool.z),
    };
    // bridge sits where the ring road crosses the river
    const br = roadField.closest(bridgeXGuess.x, bridgeXGuess.z, 400);
    if (br) {
      pois.bridge.position.set(br.x, roadYAtIndex(br.index, br.t), br.z);
      pois.bridge.roadT = (br.index + br.t) / roadN;
    }
  }

  function poi(id) {
    if (!pois[id]) throw new Error(`layout.poi: unknown id "${id}"`);
    return pois[id];
  }

  // -------------------------------------------------------------------------
  // Placement helpers
  // -------------------------------------------------------------------------

  const poiList = Object.values(pois);

  /**
   * isClear: can something be placed here?
   * opts: { road=8, poi=1, river=6, minHeight=1, maxSlope=0.45, maxHeight=Inf,
   *         margin=140, water=false, lake=false }
   */
  function isClear(x, z, opts = {}) {
    const o = Object.assign({
      road: 8, poi: 1, river: 6, minHeight: 1.0, maxSlope: 0.45,
      maxHeight: Infinity, margin: 140, water: false, lake: false,
    }, opts);
    if (Math.abs(x) > HALF - o.margin || Math.abs(z) > HALF - o.margin) return false;
    const h = heightAt(x, z);
    if (h < o.minHeight || h > o.maxHeight) return false;
    if (waterDepth(x, z) > 0.25 && !o.water) return false;
    if (slopeAt(x, z) > o.maxSlope) return false;
    if (o.road > 0 && roadDistance(x, z) < o.road) return false;
    if (o.river > 0 && riverDistance(x, z) < o.river) return false;
    if (o.poi > 0) {
      for (const p of poiList) {
        if (p.id === 'forest' || p.id === 'pineForest' || p.id === 'beach' || p.id === 'beachEast') continue;
        const dx = x - p.position.x, dz = z - p.position.z;
        if (dx * dx + dz * dz < (p.radius * o.poi) ** 2) return false;
      }
    }
    return true;
  }

  /** Random clear spot near a POI (annulus rMin..rMax). Returns null if none found. */
  function randomSpotNear(poiId, rMin, rMax, rng, opts = {}) {
    const p = poi(poiId);
    for (let i = 0; i < 80; i++) {
      const a = rng.float() * TAU;
      const r = lerp(rMin, rMax, Math.sqrt(rng.float()));
      const x = p.position.x + Math.cos(a) * r;
      const z = p.position.z + Math.sin(a) * r;
      if (isClear(x, z, opts)) return { x, z, y: heightAt(x, z) };
    }
    return null;
  }

  /** Random clear spot anywhere on the island. */
  function randomSpot(rng, opts = {}) {
    const o = Object.assign({ road: 10, poi: 0, river: 8, minHeight: 1.5, maxSlope: 0.42 }, opts);
    for (let i = 0; i < 120; i++) {
      // bias towards land: sample in a disc of radius 2150
      const a = rng.float() * TAU;
      const r = Math.sqrt(rng.float()) * 2150;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (isClear(x, z, o)) return { x, z, y: heightAt(x, z) };
    }
    return null;
  }

  /** Sample a square grid of heights (row-major, z rows). */
  function sampleHeightGrid(size) {
    const out = new Float32Array(size * size);
    const stepX = GAME.worldSize / (size - 1);
    for (let j = 0; j < size; j++) {
      const z = -HALF + j * stepX;
      for (let i = 0; i < size; i++) {
        out[j * size + i] = heightAt(-HALF + i * stepX, z);
      }
    }
    return out;
  }

  /** Biome classification (primary surface type). */
  function biomeAt(x, z) {
    const h = heightAt(x, z);
    const depth = waterDepth(x, z);
    if (depth > 0.2) {
      const dl = Math.hypot(x - LAKE_X, z - LAKE_Z);
      return dl < LAKE_R * 1.2 ? 'lake' : 'ocean';
    }
    if (riverDistance(x, z) < 9 && h > 0.5) return 'river';
    if (onRoad(x, z, 1.5)) return 'road';
    const s = slopeAt(x, z);
    if (h > 245 + 22 * nSplat.fbm(x * 0.004, z * 0.004, 3)) return 'snow';
    if (s > 0.55 || h > 205) return 'rock';
    if (h < 6.5 && s < 0.30) return 'beach';
    const forest = (p) => {
      const dx = x - p.position.x, dz = z - p.position.z;
      return Math.hypot(dx, dz) / p.radius;
    };
    const fWest = forest(pois.forest);
    const fPine = forest(pois.pineForest);
    const edge = 0.62 + 0.3 * nSplat.fbm(x * 0.0022 + 11, z * 0.0022 + 11, 3);
    if ((fWest < edge || fPine < edge) && s < 0.6) return 'forest';
    return 'meadow';
  }

  const _splat = { grass: 1, sand: 0, rock: 0, snow: 0, dirt: 0 };
  function splatAt(x, z, out = _splat) {
    const h = heightAt(x, z);
    const s = slopeAt(x, z);
    const beachNoise = nSplat.fbm(x * 0.0035 + 5, z * 0.0035 + 5, 3);
    const rockNoise = nSplat.fbm(x * 0.006 + 21, z * 0.006 + 21, 3);
    const snowNoise = nSplat.fbm(x * 0.004 + 31, z * 0.004 + 31, 3);
    const dryNoise = nSplat.fbm(x * 0.002 + 41, z * 0.002 + 41, 3);

    // Sand follows the actual shoreline as a narrow ribbon instead of a
    // height threshold (which painted whole low basins pale).
    const sd = shoreDistance(x, z);
    const bandIn = 14 + beachNoise * 8;
    const bandOut = bandIn + 24 + beachNoise * 10;
    let sand = 1 - smootherstep(bandIn, bandOut, Math.abs(sd));
    sand *= 1 - smootherstep(0.34, 0.56, s);
    // NOTE: river/lake sand bands were removed - at the terrain's mesh
    // resolution (15 m quads) they quantised into hard pale polygons.

    let rock = smoothstep(0.42, 0.72, s + rockNoise * 0.14) + smootherstep(185, 245, h + rockNoise * 24);
    let snow = smootherstep(232 + snowNoise * 30, 262 + snowNoise * 30, h) * (1 - smoothstep(0.72, 0.95, s));
    // grass must yield to rock/snow, otherwise the summit stays green
    rock = clamp01(rock);
    snow = clamp01(snow * (1 - rock * 0.35));
    let grass = clamp01(1 - rock * 0.92 - snow * 0.92);
    let dirt = smoothstep(0.5, 0.8, s) * 0.5 + Math.max(0, dryNoise) * 0.12;

    // dry grass patches in the rain shadow (east of the massif)
    if (h > 20 && h < 200) {
      const dry = clamp01(dryNoise * 0.6 + 0.5);
      grass *= lerp(0.72, 1.0, dry);
    }

    sand = clamp01(sand);
    const sum = grass + sand + rock + snow + dirt + 1e-5;
    out.grass = grass / sum;
    out.sand = sand / sum;
    out.rock = rock / sum;
    out.snow = snow / sum;
    out.dirt = dirt / sum;
    return out;
  }

  // -------------------------------------------------------------------------
  // Road sampling helpers for other modules
  // -------------------------------------------------------------------------

  const roadSamples = new Float32Array(roadN * 3);
  for (let i = 0; i < roadN; i++) {
    roadSamples[i * 3] = roadXZ[i * 2];
    roadSamples[i * 3 + 1] = roadY[i];
    roadSamples[i * 3 + 2] = roadXZ[i * 2 + 1];
  }

  /** Project a world point to the ring road. Returns {t, x, y, z, dirX, dirZ}. */
  function projectToRoad(x, z, out = {}) {
    const c = roadField.closest(x, z, 500);
    if (!c) return null;
    const t = (c.index + c.t) / roadN;
    const i2 = (c.index + 1) % roadN;
    const dx = roadXZ[i2 * 2] - roadXZ[c.index * 2];
    const dz = roadXZ[i2 * 2 + 1] - roadXZ[c.index * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    out.t = t;
    out.x = c.x; out.z = c.z;
    out.y = roadYAtIndex(c.index, c.t);
    out.dirX = dx / len; out.dirZ = dz / len;
    return out;
  }

  /** Road point by t in [0,1). */
  const _rp = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };
  function roadPoint(t, out = _rp) {
    const tt = ((t % 1) + 1) % 1;
    const fi = tt * roadN;
    const i = Math.floor(fi) % roadN;
    const f = fi - Math.floor(fi);
    const i2 = (i + 1) % roadN;
    out.x = lerp(roadXZ[i * 2], roadXZ[i2 * 2], f);
    out.z = lerp(roadXZ[i * 2 + 1], roadXZ[i2 * 2 + 1], f);
    out.y = lerp(roadY[i], roadY[i2], f);
    const dx = roadXZ[i2 * 2] - roadXZ[i * 2];
    const dz = roadXZ[i2 * 2 + 1] - roadXZ[i * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    out.dirX = dx / len; out.dirZ = dz / len;
    return out;
  }

  const layout = {
    seed,
    WORLD_SIZE: GAME.worldSize,
    HALF,
    WATER_LEVEL,
    roadWidth: ROAD_WIDTH,
    roadLength: roadCurve.getLength(),

    heightAt,
    terrainRaw,
    slopeAt,
    normalAt,
    shoreDistance,
    coastRadius,

    isLand,
    isWater,
    waterDepth,
    lakeY: LAKE_Y,
    lake: { center: new THREE.Vector3(LAKE_X, LAKE_Y, LAKE_Z), radius: LAKE_R, waterY: LAKE_Y },

    riverCurve,
    riverSamples: riverXZ,
    riverBedY,
    riverDistance,

    roadCurve,
    roadSamples,
    roadPoint,
    roadDistance,
    onRoad,
    projectToRoad,

    spurs: Object.fromEntries(Object.keys(spurDefs).map((id) => [id, {
      curve: spurCurves[id],
      points: spurPtsXZ[id],
      ys: spurYs[id],
      width: spurDefs[id].width,
      distance(x, z) { const c = spurFields[id].closest(x, z, 200); return c ? c.dist : 1e9; },
      point(t, out = {}) {
        const c = spurCurves[id].getPointAt(clamp01(t));
        const c2 = spurCurves[id].getPointAt(clamp01(Math.min(1, t + 0.01)));
        const dx = c2.x - c.x, dz = c2.z - c.z;
        const len = Math.hypot(dx, dz) || 1;
        out.x = c.x; out.y = heightAt(c.x, c.z); out.z = c.z;
        out.dirX = dx / len; out.dirZ = dz / len;
        return out;
      },
    }])),

    pois,
    poi,
    poiList,

    isClear,
    randomSpotNear,
    randomSpot,
    sampleHeightGrid,
    biomeAt,
    splatAt,
  };

  return layout;
}
