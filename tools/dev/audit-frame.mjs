/**
 * audit-frame.mjs - frame-budget harness.
 *
 * WHY NOT rAF: headless Chrome clamps requestAnimationFrame to ~17 ms even
 * with --disable-frame-rate-limit (measured: an empty rAF loop = 17.4 ms), so
 * rAF intervals cannot express frame cost. This harness instead stops the
 * engine loop and drives `engine.render()` by hand:
 *   - one EXT_disjoint_timer_query_webgl2 query per frame -> real GPU ms
 *   - wall clock around the render call      -> CPU submit ms
 *   - optional gl.finish()                   -> serialized CPU+GPU frame ms
 * each frame waits for the previous query so the GPU never queues up.
 *
 * UPDATE COSTS: when the engine loop is stopped the modules stop updating, so
 * update() costs are measured separately (__timeModules) and reported as
 * CPU-only numbers. GPU work is unaffected by a frozen world except for
 * skinning-free instanced animation, which is CPU-side in this project.
 *
 * Usage:
 *   node tools/dev/audit-frame.mjs --quality high --json docs/research/data/frame-high.json
 *   node tools/dev/audit-frame.mjs --quality low  --json docs/research/data/frame-low.json
 *   node tools/dev/audit-frame.mjs --quality medium --width 1920 --height 1080
 *   node tools/dev/audit-frame.mjs --quality high --views-only --json docs/research/data/matrix-high.json
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const quality = arg('quality', 'high');
const seed = arg('seed', '20261014');
const browserName = arg('browser', 'chrome');
const frames = Number(arg('frames', '60'));
const width = Number(arg('width', '1280'));
const height = Number(arg('height', '720'));
const jsonOut = arg('json', '');
const tag = arg('tag', quality);
// --views-only: skip the A/B sections and just record the ten fixed cameras
// (draw calls, triangles, GPU ms). This is the tier matrix that goes into
// docs/research/perf-baseline.md.
const viewsOnly = process.argv.includes('--views-only');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const exe = browserName === 'edge' ? EDGE : CHROME;
if (!exe) { console.error('no browser found'); process.exit(2); }

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio',
    '--allow-file-access-from-files', '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit', '--disable-gpu-vsync',
  ],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const tNav = Date.now();
await page.goto(`${pathToFileURL(path.join(dist, 'index.html')).href}?quality=${quality}&seed=${seed}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
const bootMs = Date.now() - tNav;

const glInfo = await page.evaluate(() => {
  const gl = window.__pelican.engine.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  return {
    unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    timerQuery: !!ext,
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    devicePixelRatio: window.devicePixelRatio,
    preset: { ...window.__pelican.engine.preset },
  };
});
if (!glInfo.timerQuery) console.error('WARNING: no GPU timer query - GPU numbers unavailable');

// ------------------------------------------------------------ instrumentation
await page.evaluate(() => {
  const P = window.__pelican;
  const renderer = P.engine.renderer;
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

  const A = { ext, mode: 'off', samples: [], pending: [], cpu: {}, gl };
  window.__A = A;

  const drain = () => {
    if (!ext) return;
    const keep = [];
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    for (const item of A.pending) {
      if (disjoint) { gl.deleteQuery(item.q); continue; }
      if (gl.getQueryParameter(item.q, gl.QUERY_RESULT_AVAILABLE)) {
        A.samples.push({ label: item.label, ms: gl.getQueryParameter(item.q, gl.QUERY_RESULT) / 1e6 });
        gl.deleteQuery(item.q);
      } else keep.push(item);
    }
    A.pending = keep;
  };
  A.drain = drain;
  A.available = (q) => !!ext && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);
  A.begin = (label, requiredMode) => {
    if (!ext || A.mode !== requiredMode || A.pending.length > 200) return null;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    return { q, label, pushed: false };
  };
  A.beginFrame = () => A.begin('frame', 'frame');
  A.beginPass = (label) => A.begin(label, 'passes');
  A.beginRender = () => A.begin('render', 'render');
  A.end = (tok) => {
    if (!tok) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    A.pending.push(tok);
  };

  // --- pass wrappers: one query per pass per frame in 'passes' mode
  const post = P.post;
  const origPass = {};
  for (const [name, pass] of Object.entries(post.passes)) {
    if (!pass || typeof pass.render !== 'function') continue;
    origPass[name] = pass.render.bind(pass);
    pass.render = (...a) => {
      const tok = A.beginPass(name);
      const r = origPass[name](...a);
      A.end(tok);
      return r;
    };
  }
  // --- frame wrapper: whole composite chain
  const origPostRender = post.render.bind(post);
  post.render = (dt, state) => {
    const tok = A.beginFrame();
    const t0 = performance.now();
    origPostRender(dt, state);
    A.cpu.postSubmit = (A.cpu.postSubmit || 0) + (performance.now() - t0);
    A.end(tok);
  };
  // --- direct render path (post disabled)
  const origRender = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const tok = A.beginRender();
    const t0 = performance.now();
    const r = origRender(scene, camera);
    A.cpu.renderSubmit = (A.cpu.renderSubmit || 0) + (performance.now() - t0);
    A.end(tok);
    return r;
  };

  // ---------------- manual driver -----------------------------------------
  window.__drive = async ({ frameCount = 60, mode = 'frame', finish = false, warmup = 8 }) => {
    A.mode = 'off';
    A.samples = [];
    A.pending = [];
    const gl2 = A.gl;
    for (let i = 0; i < warmup; i++) { P.engine.render(); gl2.finish(); }
    A.mode = mode;
    A.cpu = {};
    const wallSubmit = [];
    const wallFinish = [];
    let prev = null;
    for (let i = 0; i < frameCount; i++) {
      // serialise: never let the GPU queue more than one frame deep
      let spins = 0;
      while (prev && !A.available(prev.q) && spins < 200) { await new Promise((r) => setTimeout(r, 0)); spins++; }
      const tok = mode === 'frame' ? A.begin('frame-main', 'frame') : null;
      const t0 = performance.now();
      P.engine.render();
      wallSubmit.push(performance.now() - t0);
      if (finish) { gl2.finish(); wallFinish.push(performance.now() - t0); }
      if (tok) { A.end(tok); prev = tok; }
      if (mode === 'passes' && A.pending.length) prev = A.pending[A.pending.length - 1];
      drain();
    }
    // last drain
    const deadline = performance.now() + 4000;
    while (A.pending.length && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      drain();
    }
    A.mode = 'off';
    return { samples: A.samples, wallSubmit, wallFinish, cpu: { ...A.cpu } };
  };

  // ---------------- CPU-only probes ---------------------------------------
  window.__timeModules = (n = 200) => {
    const state = P.state;
    const dt = 1 / 60;
    const out = {};
    for (const [id, mod] of Object.entries(P.modules)) {
      if (!mod || typeof mod.update !== 'function') continue;
      // warm
      for (let i = 0; i < 5; i++) { try { mod.update(dt, state); } catch { /* ignore */ } }
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { try { mod.update(dt, state); } catch { /* ignore */ } }
      out[id] = +((performance.now() - t0) / n).toFixed(4);
    }
    return out;
  };
  window.__timeMatrixWorld = (n = 60) => {
    const scene = P.engine.scene;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) scene.updateMatrixWorld(false);
    return +((performance.now() - t0) / n).toFixed(4);
  };
  window.__snapshotInfo = () => new Promise((resolve) => {
    const r = P.engine.renderer;
    const prevAuto = r.info.autoReset;
    r.info.autoReset = false;
    r.info.reset();
    P.engine.render();
    const out = {
      calls: r.info.render.calls, triangles: r.info.render.triangles,
      points: r.info.render.points, lines: r.info.render.lines,
      programs: r.info.programs?.length ?? 0,
      geometries: r.info.memory.geometries, textures: r.info.memory.textures,
    };
    r.info.autoReset = prevAuto;
    resolve(out);
  });
  // the engine loop is stopped, so the chase camera has to be settled by hand
  // after every teleport (it is damped, ~120 steps of 1/60 s is plenty)
  window.__settleCamera = (n = 140) => {
    const cam = P.modules.camera;
    if (!cam || typeof cam.update !== 'function') return 0;
    for (let i = 0; i < n; i++) { try { cam.update(1 / 60, P.state); } catch { /* ignore */ } }
    return n;
  };
});

const stats = (arr) => {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
    median: +pick(0.5).toFixed(2),
    p95: +pick(0.95).toFixed(2),
    min: +s[0].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
};

const measure = async (label, opts = {}) => {
  const raw = await page.evaluate((o) => window.__drive(o), {
    frameCount: opts.frames ?? frames,
    mode: opts.mode ?? 'frame',
    finish: !!opts.finish,
    warmup: opts.warmup ?? 8,
  });
  const byLabel = {};
  for (const s of raw.samples) (byLabel[s.label] ||= []).push(s.ms);
  const gpu = {};
  for (const [k, v] of Object.entries(byLabel)) gpu[k] = stats(v);
  const key = raw.samples.some((s) => s.label === 'frame-main') ? 'frame-main' : Object.keys(gpu)[0];
  const out = {
    label,
    mode: opts.mode ?? 'frame',
    gpu,
    gpuKey: key,
    gpuMs: gpu[key]?.median ?? null,
    submit: stats(raw.wallSubmit),
    finishWall: raw.wallFinish.length ? stats(raw.wallFinish) : null,
    sampleCount: raw.samples.length,
  };
  console.log(`  ${label.padEnd(30)} gpu ${String(out.gpuMs ?? '-').padStart(6)} ms  submit ${String(out.submit?.median ?? '-').padStart(5)} ms`
    + `${out.finishWall ? `  finish ${String(out.finishWall.median).padStart(6)} ms` : ''}  samples ${String(out.sampleCount).padStart(3)}`);
  return out;
};

/**
 * A/B with baseline sandwiches. The Intel iGPU in this box drifts by tens of
 * percent over a few minutes, so an absolute number taken once is worthless:
 * every config is bracketed by two baseline measurements and only the delta
 * against their mean is trusted. `noise` is the gap between the two baselines.
 */
const abMeasure = async (label, setup, restore, opts = {}) => {
  const o = { frames: opts.frames ?? 30, warmup: opts.warmup ?? 8, mode: opts.mode ?? 'frame' };
  const baseO = { mode: opts.baseMode ?? 'frame', frames: opts.baseFrames ?? 15, warmup: 4 };
  // baseline is measured with the config still OFF, so the delta is honest
  const before = await measure(`  ↳ baseline before [${label}]`, baseO);
  if (setup) await setup();
  const cfg = await measure(`  ↳ ${label}`, o);
  if (restore) await restore();
  const after = await measure(`  ↳ baseline after  [${label}]`, baseO);
  const baseMean = ((before.gpuMs ?? 0) + (after.gpuMs ?? 0)) / 2;
  const noise = baseMean > 0 ? Math.abs((after.gpuMs ?? 0) - (before.gpuMs ?? 0)) / baseMean : null;
  return {
    label,
    mode: cfg.mode,
    gpuMs: cfg.gpuMs,
    baseBefore: before.gpuMs,
    baseAfter: after.gpuMs,
    baseMean: +baseMean.toFixed(2),
    deltaMs: cfg.gpuMs !== null ? +(cfg.gpuMs - baseMean).toFixed(2) : null,
    deltaPct: baseMean > 0 && cfg.gpuMs !== null ? +(((cfg.gpuMs - baseMean) / baseMean) * 100).toFixed(1) : null,
    noise: noise !== null ? +noise.toFixed(3) : null,
    submitMs: cfg.submit?.median ?? null,
    finishWallMs: cfg.finishWall?.median ?? null,
    gpu: cfg.gpu,
    source: { before, cfg, after },
  };
};

// ------------------------------------------------------------------- scenario
await page.evaluate(() => {
  const P = window.__pelican;
  P.start('ride');
  P.setHour(17.15);
  const s = P.layout.pois.spawn.position;
  P.teleport(s.x, s.z + 8, 0.35);
  window.__settleCamera(240);
});
await page.waitForTimeout(2500);
// freeze the world clock so every config renders the same thing
await page.evaluate(() => { window.__pelican.state.paused = true; });
await page.waitForTimeout(300);
await page.evaluate(() => { window.__pelican.engine.stop(); });
await page.waitForTimeout(200);

const results = {
  tag, quality, seed, viewport: [width, height], bootMs, frames,
  glInfo, configs: [], moduleCpu: null, matrixWorld: {}, notes: [
    'engine loop stopped for all cost measurements: rAF is clamped to ~17 ms in headless Chrome',
    'each measured frame waits for the previous GPU query, so the GPU queue stays one frame deep',
  ],
};

if (!viewsOnly) {
const setPasses = (patch) => page.evaluate((p) => {
  const passes = window.__pelican.post.passes;
  for (const [k, v] of Object.entries(p)) if (passes[k]) passes[k].enabled = v;
}, patch);
const ALL_ON = { godPass: true, bloomPass: true, gradePass: true, outputPass: true, smaaPass: true };
const ALL_OFF = { godPass: false, bloomPass: false, gradePass: false, outputPass: false, smaaPass: false };

console.log(`\n### quality=${tag} ${width}x${height} gpuTimer=${glInfo.timerQuery} boot=${bootMs} ms`);
console.log('  config (gpu ms per frame, median)');

// --- absolute baseline, single serialized frame ------------------------------
await setPasses(ALL_ON);
results.baseline = await measure('baseline (full chain, gl.finish())', { finish: true, frames: 60, warmup: 20 });

// --- per-pass GPU split -------------------------------------------------------
results.passSplit = await abMeasure('per-pass GPU split', null, null, { mode: 'passes', frames: 40 });
delete results.passSplit.deltaMs; delete results.passSplit.deltaPct; delete results.passSplit.baseBefore; delete results.passSplit.baseAfter;

// --- post chain: each pass removed / all removed ------------------------------
// only A/B the passes this preset actually enables
const presetCases = [['all passes off (render pass only)', ALL_OFF]];
if (glInfo.preset.smaa) presetCases.push(['minus SMAA', { smaaPass: false }]);
if (glInfo.preset.godrays) presetCases.push(['minus godrays', { godPass: false }]);
if (glInfo.preset.bloom) presetCases.push(['minus bloom', { bloomPass: false }]);
presetCases.push(['minus grade (grain/CA/vignette)', { gradePass: false }]);
presetCases.push(['minus output pass', { outputPass: false }]);
if (glInfo.preset.shadows) presetCases.push(['minus shadow maps', { shadowPass: undefined }]);
results.postAb = [];
for (const [label, patch] of presetCases) {
  if (patch.shadowPass !== undefined) continue; // handled below
  results.postAb.push(await abMeasure(label, () => setPasses(patch), () => setPasses(ALL_ON), {}));
}

// --- no post at all (scope = renderer.render, compare with the renderPass row
//     of the per-pass split, not with the whole-chain baseline) ---------------
await page.evaluate(() => { window.__pelican.engine.setPost(null); });
results.noPost = await measure('post pipeline removed (renderer.render GPU)', { mode: 'render', frames: 30, warmup: 10 });
await page.evaluate(() => { window.__pelican.engine.setPost(window.__pelican.post); });

// --- post chain resolution ---------------------------------------------------
results.halfRes = await abMeasure(
  'post chain at half resolution',
  () => page.evaluate(() => {
    const P = window.__pelican;
    const size = P.engine.renderer.getDrawingBufferSize(new P.ctx.THREE.Vector2());
    P.post.setSize(Math.round(size.x / 2), Math.round(size.y / 2));
  }),
  () => page.evaluate(() => {
    const P = window.__pelican;
    const s = P.engine.sizes;
    P.post.setSize(Math.round(s.width * s.scale), Math.round(s.height * s.scale));
  }),
  { frames: 30 },
);

// --- shadows -----------------------------------------------------------------
const setShadows = (on) => page.evaluate((enable) => {
  const P = window.__pelican;
  P.engine.renderer.shadowMap.enabled = enable;
  P.engine.scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m) m.needsUpdate = true;
  });
}, on);
if (glInfo.preset.shadows) {
  results.shadowsOff = await abMeasure('shadow map disabled', () => setShadows(false), () => setShadows(true), {});
}

const setShadowSize = (size) => page.evaluate((s) => {
  const P = window.__pelican;
  let target = null;
  P.engine.scene.traverse((o) => { if (!target && o.isDirectionalLight && o.castShadow) target = o; });
  if (!target) return null;
  const prev = target.shadow.mapSize.x;
  target.shadow.mapSize.set(s, s);
  if (target.shadow.map) { target.shadow.map.dispose(); target.shadow.map = null; }
  return prev;
}, size);
const prevShadowSize = await page.evaluate(() => {
  const P = window.__pelican;
  let target = null;
  P.engine.scene.traverse((o) => { if (!target && o.isDirectionalLight && o.castShadow) target = o; });
  return target ? target.shadow.mapSize.x : null;
});
if (prevShadowSize && glInfo.preset.shadows) {
  results.shadowMap1024 = await abMeasure(`shadow map ${prevShadowSize} -> 1024`, () => setShadowSize(1024), () => setShadowSize(prevShadowSize), {});
}

// --- per-module visibility A/B ----------------------------------------------
results.moduleAb = [];
const moduleIds = await page.evaluate(() => Object.keys(window.__pelican.modules).filter((id) => window.__pelican.modules[id]?.group));
const setModuleVisible = (id, visible) => page.evaluate(([mid, vis]) => {
  const P = window.__pelican;
  const inst = P.modules[mid];
  if (inst?.group) inst.group.visible = vis;
  if (mid === 'terrain' && inst?._debug) {
    for (const key of ['terrainMesh', 'roadMesh']) if (inst._debug[key]) inst._debug[key].visible = vis;
  }
}, [id, visible]);
for (const id of moduleIds) {
  const r = await abMeasure(`hide ${id}`, () => setModuleVisible(id, false), () => setModuleVisible(id, true), { frames: 25, warmup: 6 });
  r.hiddenModule = id;
  results.moduleAb.push(r);
}

// --- matrixAutoUpdate freeze -------------------------------------------------
results.matrixWorld.allOn = await page.evaluate(() => window.__timeMatrixWorld(60));
const STATIC_IDS = ['terrain', 'vegetation', 'props', 'landmarks', 'ocean', 'sky'];
let frozenCount = 0;
results.matrixFreeze = await abMeasure(
  'matrixAutoUpdate=false on static modules',
  async () => { frozenCount = await page.evaluate((ids) => {
    const P = window.__pelican;
    let n = 0;
    for (const id of ids) {
      const g = P.modules[id]?.group;
      if (!g) continue;
      g.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; n++; });
    }
    return n;
  }, STATIC_IDS); },
  async () => {
    // still frozen here: price the matrix pass in both states
    results.matrixWorld.staticFrozen = await page.evaluate(() => window.__timeMatrixWorld(60));
    await page.evaluate((ids) => {
      const P = window.__pelican;
      for (const id of ids) P.modules[id]?.group?.traverse?.((o) => { o.matrixAutoUpdate = true; });
    }, STATIC_IDS);
  },
  { frames: 30 },
);
results.matrixWorld.frozenObjects = frozenCount;
results.matrixFreeze.label = `matrixAutoUpdate=false on ${frozenCount} static objects`;
}

// The ten fixed cameras of the draw-call / frame-time matrix. Every entry is
// anchored to a POI and a time of day, so the same spots can be re-recorded on
// any machine and compared with the budgets in docs/research/quality-benchmarks.md.
const views = [
  ['gate-road', (P) => { const s = P.layout.pois.spawn.position; P.setHour(17.15); P.teleport(s.x + 6, s.z + 10, 0.35); }],
  ['village', (P) => { const v = P.layout.pois.village.position; P.setHour(16.4); P.teleport(v.x + 34, v.z + 26, -2.2); }],
  ['harbor', (P) => { const h = P.layout.pois.harbor.position; P.setHour(15.8); P.teleport(h.x - 55, h.z - 40, 0.9); }],
  ['farm', (P) => { const f = P.layout.pois.farm.position; P.setHour(11.6); P.teleport(f.x + 40, f.z + 30, -2.4); }],
  ['windmill', (P) => { const w = P.layout.pois.windmill.position; P.setHour(13.2); P.teleport(w.x + 32, w.z + 28, -2.3); }],
  ['bridge', (P) => { const b = P.layout.pois.bridge.position; P.setHour(10.4); P.teleport(b.x + 26, b.z + 22, -2.3); }],
  ['waterfall', (P) => { const w = P.layout.pois.waterfall.position; P.setHour(9.2); P.teleport(w.x + 34, w.z + 24, -2.4); }],
  ['cliffs-sunset', (P) => { const b = P.layout.pois.bench.position; P.setHour(18.35); P.teleport(b.x + 24, b.z + 18, -1.9); }],
  ['peak-noon', (P) => { const p = P.layout.pois.peak.position; P.setHour(12.2); P.teleport(p.x + 26, p.z + 26, -2.4); }],
  ['lighthouse-night', (P) => { const l = P.layout.pois.lighthouse.position; P.setHour(22.4); P.teleport(l.x - 45, l.z + 32, 0.6); }],
];
for (const [name, fn] of views) {
  await page.evaluate((src) => {
    const P = window.__pelican;
    // eslint-disable-next-line no-new-func
    new Function('P', `(${src})(P);`)(P);
    window.__settleCamera(240);
  }, fn.toString());
  await page.waitForTimeout(200);
  const view = await measure(`view:${name}`, { frames: Math.min(frames, 40), warmup: 15 });
  // one manual render per view with info.autoReset off: the draw-call count of
  // exactly this camera, not the running average of the whole session
  view.info = await page.evaluate(() => window.__snapshotInfo());
  results.configs.push(view);
}

// --- module CPU costs --------------------------------------------------------
results.moduleCpu = await page.evaluate(() => window.__timeModules(200));
results.rendererInfo = await page.evaluate(() => window.__snapshotInfo());
results.pageErrors = pageErrors;

if (jsonOut) {
  await mkdir(path.dirname(path.resolve(jsonOut)), { recursive: true });
  await writeFile(path.resolve(jsonOut), JSON.stringify(results, null, 2));
}

if (viewsOnly) {
  console.log(`\n## fixed-camera matrix (quality=${tag}, ${width}x${height}, seed=${seed})`);
  console.log('  view              gpu ms   submit   calls    tris   points   lines  programs');
  for (const v of results.configs) {
    if (!v.label.startsWith('view:')) continue;
    const i = v.info || {};
    console.log(
      `  ${v.label.replace('view:', '').padEnd(16)} ${String(v.gpuMs).padStart(6)}  `
      + `${String(v.submit?.median ?? '-').padStart(6)}  ${String(i.calls ?? '-').padStart(5)}  `
      + `${String(Math.round((i.triangles ?? 0) / 1000)).padStart(6)}k  `
      + `${String(i.points ?? '-').padStart(6)}  ${String(i.lines ?? '-').padStart(6)}  ${String(i.programs ?? '-').padStart(8)}`
    );
  }
  console.log(`  renderer.info (after the last view) ${JSON.stringify(results.rendererInfo)}`);
  if (pageErrors.length) console.log('  page errors:', pageErrors.slice(0, 5));
  await browser.close();
  process.exit(0);
}

// --------------------------------------------------------------------- print
const base = results.baseline;
const perPass = results.passSplit;
console.log(`\nbaseline: GPU ${base.gpuMs} ms/frame (median of ${base.gpuKey} samples), CPU submit ${base.submit.median} ms, serialized CPU+GPU ${base.finishWall?.median} ms`);
console.log('\n== GPU split per post pass (median ms) ==');
for (const [k, v] of Object.entries(perPass?.gpu || {})) console.log(`  ${k.padEnd(14)} ${v.median}  (p95 ${v.p95}, n=${v.n})`);
const passSum = Object.values(perPass?.gpu || {}).filter((v) => v).reduce((a, b) => a + b.median, 0);
console.log(`  sum of passes ${passSum.toFixed(2)} ms`);

const printAb = (rows) => {
  for (const r of rows) {
    if (!r) continue;
    console.log(`  ${r.label.padEnd(38)} gpu ${String(r.gpuMs).padStart(6)} ms  Δ ${String(r.deltaMs).padStart(7)} ms (${String(r.deltaPct).padStart(6)}%)  noise ${r.noise}`);
  }
};
console.log('\n== post-processing A/B (vs full chain) ==');
printAb(results.postAb || []);
printAb([results.noPost, results.halfRes]);
console.log('\n== shadows A/B ==');
printAb([results.shadowsOff, results.shadowMap1024]);
console.log('\n== per-module visibility A/B (hide one module) ==');
printAb((results.moduleAb || []).slice().sort((a, b) => (a.deltaMs ?? 0) - (b.deltaMs ?? 0)));
console.log('\n== static transform freeze ==');
printAb([results.matrixFreeze]);
console.log('\n== per-module update() CPU (ms/frame, dt=1/60) ==');
for (const [k, v] of Object.entries(results.moduleCpu || {}).sort((a, b) => b[1] - a[1])) if (v >= 0.002) console.log(`  ${k.padEnd(14)} ${v}`);
console.log(`  total ${Object.values(results.moduleCpu || {}).reduce((a, b) => a + b, 0).toFixed(3)} ms`);
console.log('\n== Scene.updateMatrixWorld ==');
console.log(`  all matrixAutoUpdate=true : ${results.matrixWorld.allOn} ms/frame`);
console.log(`  ${results.matrixWorld.frozenObjects} static objects frozen  : ${results.matrixWorld.staticFrozen} ms/frame`);
console.log('\n== renderer.info (one frame, autoReset off) ==');
console.log(' ', JSON.stringify(results.rendererInfo));
console.log('\n== view scenarios (absolute GPU ms) ==');
for (const v of results.configs) if (v.label.startsWith('view:')) console.log(`  ${v.label.padEnd(26)} gpu ${v.gpuMs} ms  submit ${v.submit?.median} ms`);
if (pageErrors.length) console.log('\npage errors:', pageErrors.slice(0, 5));

await browser.close();
