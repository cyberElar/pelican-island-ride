/**
 * audit-scene.mjs - static resource inventory of the built world: geometry and
 * texture memory, material count, per-module mesh/instance/triangle split,
 * CPU-side scene-graph overhead flags (matrixAutoUpdate, frustumCulled,
 * castShadow) and the renderer's own counters.
 *
 * Usage: node tools/dev/audit-scene.mjs [--quality high] [--seed 20261014]
 *                                      [--browser chrome|edge] [--json out.json]
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
const jsonOut = arg('json', '');

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
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${pathToFileURL(path.join(dist, 'index.html')).href}?quality=${quality}&seed=${seed}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => { window.__pelican.start('ride'); window.__pelican.setHour(17.15); });
await page.waitForTimeout(2500);

const data = await page.evaluate(() => {
  const P = window.__pelican;
  const renderer = P.engine.renderer;
  const scene = P.engine.scene;

  const geometryCache = new Map();
  const textureCache = new Map();
  let meshes = 0, instancedMeshes = 0, instances = 0, points = 0, lines = 0, sprites = 0;
  let shadowsCast = 0, shadowsReceive = 0, frustumCulledOff = 0, autoUpdateOn = 0, autoUpdateOff = 0;
  let visibleMeshes = 0, transparentMaterials = 0, doubleSided = 0, alphaTestMats = 0;
  const materialSet = new Set();
  const materialTypes = new Map();
  const geometryByModule = [];
  const driver = [];

  const texUsage = (mat) => {
    const usage = [];
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'emissiveMap', 'aoMap', 'lightMap', 'envMap', 'specularMap', 'bumpMap', 'displacementMap', 'gradientMap', 'sheenColorMap', 'clearcoatMap', 'iridescenceMap', 'transmissionMap', 'thicknessMap']) {
      if (mat[key]) usage.push([key, mat[key]]);
    }
    return usage;
  };

  const bytesPerPixel = (tex) => {
    const T = P.ctx.THREE;
    const ch = { [T.RedFormat]: 1, [T.RGFormat]: 2, [T.RGBFormat]: 3, [T.RGBAFormat]: 4, [T.AlphaFormat]: 1, [T.DepthFormat]: 1, [T.RedIntegerFormat]: 1, [T.RGIntegerFormat]: 2, [T.RGBAIntegerFormat]: 4 }[tex.format] ?? 4;
    const type = tex.type;
    const sz = (type === T.FloatType || type === T.UnsignedIntType || type === T.IntType) ? 4
      : (type === T.HalfFloatType || type === T.UnsignedShortType || type === T.ShortType) ? 2
        : 1;
    return ch * sz;
  };

  const registerTexture = (tex, usage) => {
    if (!tex || !tex.isTexture) return;
    const img = tex.image || {};
    const w = img.width || tex.source?.data?.width || img.videoWidth || 0;
    const h = img.height || tex.source?.data?.height || img.videoHeight || 0;
    const entry = textureCache.get(tex.uuid) || {
      uuid: tex.uuid, name: tex.name || '(unnamed)', w, h, format: tex.format, type: tex.type,
      colorSpace: tex.colorSpace, anisotropy: tex.anisotropy, generateMipmaps: tex.generateMipmaps,
      minFilter: tex.minFilter, magFilter: tex.magFilter, wrapS: tex.wrapS, wrapT: tex.wrapT,
      isDataTexture: !!tex.isDataTexture, isCanvasTexture: !!tex.isCanvasTexture, isCompressed: !!tex.isCompressedTexture,
      uses: [], pixels: w * h, bytes: 0,
    };
    const bpp = bytesPerPixel(tex);
    const mipFactor = tex.generateMipmaps && tex.minFilter !== P.ctx.THREE.NearestFilter && tex.minFilter !== P.ctx.THREE.LinearFilter ? 4 / 3 : 1;
    entry.bytes = Math.round(w * h * bpp * mipFactor);
    if (!entry.uses.includes(usage)) entry.uses.push(usage);
    textureCache.set(tex.uuid, entry);
  };

  const groups = [];

  const collect = (obj, moduleName, acc) => {
    const isRenderable = obj.isMesh || obj.isPoints || obj.isLine || obj.isSprite;
    if (isRenderable) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        materialSet.add(m.uuid);
        materialTypes.set(m.type, (materialTypes.get(m.type) || 0) + 1);
        if (m.transparent) transparentMaterials++;
        if (m.side === P.ctx.THREE.DoubleSide) doubleSided++;
        if (m.alphaTest > 0) alphaTestMats++;
        for (const [key, tex] of texUsage(m)) registerTexture(tex, m.type + '.' + key);
      }
      const g = obj.geometry;
      if (g && !geometryCache.has(g.uuid)) {
        let bytes = 0, verts = 0;
        for (const key of Object.keys(g.attributes || {})) {
          const a = g.attributes[key];
          bytes += a.array?.byteLength || 0;
          if (key === 'position') verts = a.count;
        }
        if (g.index) bytes += g.index.array?.byteLength || 0;
        geometryCache.set(g.uuid, {
          uuid: g.uuid, name: g.name || '(unnamed)', bytes, verts,
          indexed: !!g.index, indexCount: g.index?.count || 0,
          attributes: Object.keys(g.attributes || {}),
          drawRange: g.drawRange ? { start: g.drawRange.start, count: g.drawRange.count } : null,
        });
      }
      if (obj.isMesh) {
        meshes++;
        if (obj.isInstancedMesh) { instancedMeshes++; instances += obj.count; }
      } else if (obj.isPoints) points++;
      else if (obj.isLine || obj.isLineSegments) lines++;
      else if (obj.isSprite) sprites++;
      if (obj.castShadow) shadowsCast++;
      if (obj.receiveShadow) shadowsReceive++;
      if (obj.frustumCulled === false) frustumCulledOff++;
      if (obj.visible) visibleMeshes++;
      let tris = 0;
      if (g) tris = (g.index ? g.index.count / 3 : (g.attributes?.position?.count ?? 0) / 3) * (obj.isInstancedMesh ? obj.count : 1);
      acc.tris += tris;
      acc.renderables += 1;
      acc.draws += 1;
      acc.castShadow += obj.castShadow ? 1 : 0;
    }
    for (const child of obj.children || []) collect(child, moduleName, acc);
  };

  const world = P.engine.world;
  for (const top of [...world.children, ...P.engine.skyGroup.children]) {
    const acc = { name: top.name || top.type, tris: 0, renderables: 0, draws: 0, castShadow: 0 };
    collect(top, acc.name, acc);
    groups.push(acc);
  }
  // driver: sprites/points that live outside the module groups
  driver.push({ note: 'scene-root children', count: scene.children.length, names: scene.children.map((c) => c.name || c.type) });

  const geoms = [...geometryCache.values()].sort((a, b) => b.bytes - a.bytes);
  const texs = [...textureCache.values()].sort((a, b) => b.bytes - a.bytes);
  const geometryBytes = geoms.reduce((s, g) => s + g.bytes, 0);
  const textureBytes = texs.reduce((s, t) => s + t.bytes, 0);
  const totalVerts = geoms.reduce((s, g) => s + g.verts, 0);

  const anyObjFlags = (root2) => {
    let autoOn = 0, autoOff = 0;
    root2.traverse((o) => { if (o.matrixAutoUpdate) autoOn++; else autoOff++; });
    return { autoOn, autoOff };
  };
  const flags = anyObjFlags(scene);

  return {
    quality: P.state.quality,
    preset: { ...P.engine.preset },
    renderer: {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      points: renderer.info.render.points,
      lines: renderer.info.render.lines,
      programs: renderer.info.programs?.length ?? 0,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      autoReset: renderer.info.autoReset,
    },
    sceneTotals: {
      meshes, instancedMeshes, instances, points, lines, sprites,
      shadowsCast, shadowsReceive, frustumCulledOff, visibleMeshes,
      uniqueMaterials: materialSet.size, transparentMaterials, doubleSided, alphaTestMats,
      uniqueGeometries: geometryCache.size, geometryBytes, geometryMiB: +(geometryBytes / 1048576).toFixed(2),
      uniqueTextures: textureCache.size, textureBytes, textureMiB: +(textureBytes / 1048576).toFixed(2),
      totalVerts,
      matrixAutoUpdateOn: flags.autoOn, matrixAutoUpdateOff: flags.autoOff,
    },
    materialTypes: [...materialTypes.entries()].sort((a, b) => b[1] - a[1]),
    groups: groups.sort((a, b) => b.tris - a.tris),
    topGeometries: geoms.slice(0, 15),
    topTextures: texs.slice(0, 20),
    texturesWithoutMipmaps: texs.filter((t) => !t.generateMipmaps || t.minFilter === P.ctx.THREE.LinearFilter || t.minFilter === P.ctx.THREE.NearestFilter).length,
    texturesAnisoZero: texs.filter((t) => t.anisotropy <= 1).length,
    driver,
  };
});

if (jsonOut) {
  await mkdir(path.dirname(path.resolve(jsonOut)), { recursive: true });
  await writeFile(path.resolve(jsonOut), JSON.stringify(data, null, 2));
}

const t = data.sceneTotals;
console.log(`quality=${data.quality}  calls=${data.renderer.calls} tris=${(data.renderer.triangles / 1e3).toFixed(0)}k programs=${data.renderer.programs} geometries=${data.renderer.geometries} textures=${data.renderer.textures}`);
console.log(`scene: ${t.meshes} meshes (${t.instancedMeshes} instanced, ${t.instances} instances) points=${t.points} lines=${t.lines} sprites=${t.sprites} visibleRenderables=${t.visibleMeshes}`);
console.log(`unique: ${t.uniqueGeometries} geometries ${t.geometryMiB} MiB | ${t.uniqueTextures} textures ${t.textureMiB} MiB | ${t.uniqueMaterials} materials`);
console.log(`flags: castShadow=${t.shadowsCast} receiveShadow=${t.shadowsReceive} frustumCulled=false:${t.frustumCulledOff} matrixAutoUpdate ${t.matrixAutoUpdateOn} on / ${t.matrixAutoUpdateOff} off`);
console.log(`transparent=${t.transparentMaterials} doubleSided=${t.doubleSided} alphaTest=${t.alphaTestMats} | textures w/o mipmaps=${data.texturesWithoutMipmaps} aniso<=1=${data.texturesAnisoZero}`);
console.log('\nmaterial types:', JSON.stringify(data.materialTypes));
console.log('\nper module (tris / draw-candidates / shadow casters):');
for (const g of data.groups) {
  if (g.tris === 0 && g.renderables === 0) continue;
  console.log(`  ${(g.tris / 1e3).toFixed(0).padStart(7)}k tris  ${String(g.renderables).padStart(5)} draws  ${String(g.castShadow).padStart(4)} shadow  ${g.name}`);
}
console.log('\nheaviest geometries:');
for (const g of data.topGeometries.slice(0, 8)) console.log(`  ${(g.bytes / 1024).toFixed(0).padStart(7)} KiB  ${String(g.verts).padStart(7)} verts  ${g.name}`);
console.log('\nheaviest textures:');
for (const x of data.topTextures.slice(0, 12)) {
  console.log(`  ${(x.bytes / 1048576).toFixed(2).padStart(6)} MiB  ${String(x.w)}x${String(x.h)}  aniso=${x.anisotropy} mip=${x.generateMipmaps} ${x.isCanvasTexture ? 'canvas' : x.isDataTexture ? 'data' : 'tex'}  ${x.uses.slice(0, 2).join(',')}`);
}

await browser.close();
