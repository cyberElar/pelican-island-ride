/**
 * _probe-view-split.mjs - what makes the heaviest camera heavy?
 *
 * Teleports to one of the fixed matrix cameras (default: the village at high)
 * and records renderer.info for the full frame, then again with each module
 * group hidden and with the shadow map off. The deltas are the per-module
 * draw-call / triangle share of that view.
 *
 * Usage: node tools/dev/_probe-view-split.mjs [--quality high] [--view village]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const quality = arg('quality', 'high');
const viewName = arg('view', 'village');
const seed = arg('seed', '20261014');

const VIEWS = {
  gate: (P) => { const s = P.layout.pois.spawn.position; P.setHour(17.15); P.teleport(s.x + 6, s.z + 10, 0.35); },
  village: (P) => { const v = P.layout.pois.village.position; P.setHour(16.4); P.teleport(v.x + 34, v.z + 26, -2.2); },
  bridge: (P) => { const b = P.layout.pois.bridge.position; P.setHour(10.4); P.teleport(b.x + 26, b.z + 22, -2.3); },
  windmill: (P) => { const w = P.layout.pois.windmill.position; P.setHour(13.2); P.teleport(w.x + 32, w.z + 28, -2.3); },
};
if (!VIEWS[viewName]) {
  console.error(`unknown view '${viewName}' (have: ${Object.keys(VIEWS).join(', ')})`);
  process.exit(2);
}

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.error('No Edge/Chrome found.');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(path.join(root, 'dist', 'index.html')).href}?quality=${quality}&seed=${seed}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });

await page.evaluate((name) => {
  const P = window.__pelican;
  P.start('ride');
  const view = {
    gate: () => { const s = P.layout.pois.spawn.position; P.setHour(17.15); P.teleport(s.x + 6, s.z + 10, 0.35); },
    village: () => { const v = P.layout.pois.village.position; P.setHour(16.4); P.teleport(v.x + 34, v.z + 26, -2.2); },
    bridge: () => { const b = P.layout.pois.bridge.position; P.setHour(10.4); P.teleport(b.x + 26, b.z + 22, -2.3); },
    windmill: () => { const w = P.layout.pois.windmill.position; P.setHour(13.2); P.teleport(w.x + 32, w.z + 28, -2.3); },
  }[name];
  view();
  const cam = P.modules.camera;
  for (let i = 0; i < 240; i++) cam.update(1 / 60, P.state);
  P.state.paused = true;
}, viewName);
await page.waitForTimeout(600);

// snapshotInfo: one hand-driven render with info.autoReset off, so the numbers
// are exactly this camera and include the shadow-map pass.
await page.evaluate(() => {
  const P = window.__pelican;
  P.engine.stop();
  window.__snap = () => {
    const r = P.engine.renderer;
    const prev = r.info.autoReset;
    r.info.autoReset = false;
    r.info.reset();
    P.engine.render();
    const out = {
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      lines: r.info.render.lines,
      points: r.info.render.points,
      programs: r.info.programs ? r.info.programs.length : 0,
    };
    r.info.autoReset = prev;
    return out;
  };
});
await page.waitForTimeout(200);

const split = await page.evaluate(() => {
  const P = window.__pelican;
  const base = window.__snap();
  const delta = (info) => ({ dCalls: base.calls - info.calls, dTris: base.triangles - info.triangles });

  const modules = [];
  for (const id of Object.keys(P.modules)) {
    const group = P.modules[id]?.group;
    if (!group) continue;
    group.visible = false;
    const info = window.__snap();
    group.visible = true;
    modules.push({ id, ...delta(info) });
  }

  // second level: split the heavy modules by userData.kind (grass vs trees ...)
  const kinds = [];
  for (const id of ['vegetation', 'props', 'landmarks', 'rider', 'animals']) {
    const group = P.modules[id]?.group;
    if (!group) continue;
    const byKind = new Map();
    group.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const key = o.userData?.kind || o.userData?.species || o.name || '(unnamed)';
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key).push(o);
    });
    for (const [kind, list] of byKind) {
      const prev = list.map((m) => m.visible);
      for (const m of list) m.visible = false;
      const info = window.__snap();
      list.forEach((m, i) => { m.visible = prev[i]; });
      kinds.push({ id, kind, meshes: list.length, ...delta(info) });
    }
  }

  const r = P.engine.renderer;
  const shadowPrev = r.shadowMap.enabled;
  r.shadowMap.enabled = false;
  P.engine.scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m) m.needsUpdate = true;
  });
  const shadowOff = window.__snap();
  r.shadowMap.enabled = shadowPrev;
  P.engine.scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m) m.needsUpdate = true;
  });

  return { base, modules, kinds, shadow: delta(shadowOff) };
});

// A/B the ground-cover distance LOD: chunkRange = Infinity reproduces the old
// "everything in the frustum draws" behaviour.
const lod = await page.evaluate(() => {
  const P = window.__pelican;
  const veg = P.modules.vegetation;
  const apply = (m) => { veg.setChunkRange(m); veg.update(1 / 60, P.state); };
  apply(P.engine.preset.chunkRange);
  const on = window.__snap();
  apply(Infinity);
  const off = window.__snap();
  const visible = veg.group.children.filter((c) => c.userData.kind === 'grass' || c.userData.kind === 'flower');
  const shown = visible.filter((m) => m.visible).length;
  apply(P.engine.preset.chunkRange);
  return { on, off, chunkMeshes: visible.length, shown, chunkRange: P.engine.preset.chunkRange };
});

const base = split.base;
console.log(`view=${viewName} quality=${quality}  calls=${base.calls}  tris=${(base.triangles / 1e6).toFixed(2)}M  programs=${base.programs}`);
console.log(
  `  ground-cover LOD (chunkRange ${lod.chunkRange} m): ${lod.shown}/${lod.chunkMeshes} chunk meshes drawn  `
  + `calls ${lod.off.calls} -> ${lod.on.calls}  tris ${(lod.off.triangles / 1e6).toFixed(2)}M -> ${(lod.on.triangles / 1e6).toFixed(2)}M`
);
console.log(`  shadow map off: -${split.shadow.dCalls} calls  -${(split.shadow.dTris / 1e6).toFixed(2)}M tris`);
console.log('  module                 calls   tris');
for (const r of split.modules.sort((a, b) => b.dTris - a.dTris)) {
  console.log(`  ${r.id.padEnd(20)} ${String(r.dCalls).padStart(6)}  ${(r.dTris / 1e6).toFixed(2)}M`);
}
console.log('  kind (module)          meshes  calls   tris');
for (const r of split.kinds.filter((k) => k.dTris > 20000 || k.dCalls > 10).sort((a, b) => b.dTris - a.dTris)) {
  console.log(`  ${`${r.kind} (${r.id})`.padEnd(22)} ${String(r.meshes).padStart(5)} ${String(r.dCalls).padStart(6)}  ${(r.dTris / 1e6).toFixed(2)}M`);
}
await browser.close();
