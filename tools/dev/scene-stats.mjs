/**
 * scene-stats.mjs - loads the built game headless and reports where the
 * triangles and draw calls actually go, per top-level module group.
 *
 * Usage: node tools/dev/scene-stats.mjs [--quality medium] [--seed 20261014]
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const quality = arg('quality', 'medium');
const seed = arg('seed', '20261014');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) { console.error('no Edge'); process.exit(2); }

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${pathToFileURL(path.join(dist, 'index.html')).href}?quality=${quality}&seed=${seed}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });

// walk the scene graph from the browser side
const report = await page.evaluate(() => {
  const P = window.__pelican;
  // hunt for LOD objects with null levels (they crash three's LOD.update)
  const lodProblems = [];
  const nullMaterials = [];
  const scan = (o, path) => {
    if ((o.isMesh || o.isLine || o.isPoints) && (o.material === null || o.material === undefined)) {
      nullMaterials.push({ path, name: o.name || o.type, type: o.type, castShadow: o.castShadow, visible: o.visible, isInstanced: !!o.isInstancedMesh });
    }
    if (Array.isArray(o.material) && o.material.some((m) => !m)) {
      nullMaterials.push({ path, name: o.name || o.type, type: o.type, castShadow: o.castShadow, note: 'material array contains null' });
    }
    if (o.isLOD) {
      lodProblems.push({
        path,
        name: o.name || '(unnamed)',
        levels: o.levels.map((l) => ({ hasObject: !!l.object, distance: l.distance })),
      });
    }
    if (o.levels && Array.isArray(o.levels) && !o.isLOD) {
      lodProblems.push({ path, name: `levels-like ${o.type}`, levels: o.levels.map((l) => ({ hasObject: !!(l && l.object) })) });
    }
    for (const c of o.children) scan(c, `${path}/${c.name || c.type}`);
  };
  scan(P.engine.scene, '');

  const out = [];
  const children = P.engine.world.children.concat(P.engine.skyGroup.children);
  for (const top of children) {
    let meshes = 0, instanced = 0, draws = 0, tris = 0, instCount = 0;
    const worst = [];
    top.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      let t = 0;
      if (g?.index) t = g.index.count / 3;
      else if (g?.attributes?.position) t = g.attributes.position.count / 3;
      const n = o.isInstancedMesh ? o.count : 1;
      if (o.isInstancedMesh) { instanced++; instCount += o.count; }
      draws += o.isInstancedMesh ? 1 : 1;
      tris += t * n;
      worst.push({ name: o.name || o.type, t: Math.round(t), n, total: Math.round(t * n), visible: o.visible, culled: o.frustumCulled });
    });
    worst.sort((a, b) => b.total - a.total);
    out.push({ name: top.name || top.type, meshes, instanced, instCount, draws, tris: Math.round(tris), worst: worst.slice(0, 6) });
  }
  out.sort((a, b) => b.tris - a.tris);
  const r = P.engine.renderer;
  return {
    nullMaterials: nullMaterials.slice(0, 20),
    lodProblems: lodProblems.slice(0, 20),
    groups: out,
    renderer: {
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
      programs: r.info.programs?.length ?? 0,
    },
    shadowEnabled: r.shadowMap.enabled,
    preset: { treeDensity: P.engine.preset.treeDensity, grassDensity: P.engine.preset.grassDensity, terrainSegments: P.engine.preset.terrainSegments },
  };
});

console.log(`quality=${quality} renderer: calls=${report.renderer.calls} tris=${(report.renderer.triangles / 1e6).toFixed(1)}M geometries=${report.renderer.geometries} textures=${report.renderer.textures} programs=${report.renderer.programs}`);
if (report.lodProblems.length) {
  console.log('LOD problems:', JSON.stringify(report.lodProblems, null, 1));
} else {
  console.log('LOD problems: none');
}
if (report.nullMaterials.length) {
  console.log('null-material objects:', JSON.stringify(report.nullMaterials, null, 1));
} else {
  console.log('null-material objects: none');
}
console.log(`preset: ${JSON.stringify(report.preset)}  shadows=${report.shadowEnabled}`);
console.log('');
for (const g of report.groups) {
  if (g.tris === 0 && g.meshes === 0) continue;
  console.log(`${(g.tris / 1e6).toFixed(2).padStart(8)}M tris  ${String(g.meshes).padStart(5)} meshes (${g.instanced} instanced, ${g.instCount} instances)  ${g.name}`);
  for (const w of g.worst.slice(0, 3)) {
    if (w.total < 50000) continue;
    console.log(`            ${(w.total / 1000).toFixed(0).padStart(7)}k  ${w.name} x${w.n} (geo ${w.t} tris)`);
  }
}

await browser.close();
