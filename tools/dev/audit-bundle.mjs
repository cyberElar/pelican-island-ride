/**
 * audit-bundle.mjs - size + composition audit of the shipped bundles.
 *
 * 1. raw / gzip / brotli byte sizes of the repo-root game.js and dist/game.js
 *    (plus a sha256 so we can tell whether the published copy is stale)
 * 2. an esbuild rebuild with `metafile: true` (written to the OS temp dir, no
 *    repo files touched) that attributes output bytes to inputs, so the real
 *    three.js share is measured in *output* bytes, not source bytes
 * 3. a tree-shaking probe: three's GLSL shader chunks are plain string
 *    literals, so they survive minification - their presence in the bundle
 *    tells us which code paths (skinning, morph, batched mesh, transmission,
 *    iridescence, ...) were actually kept.
 *
 * Usage: node tools/dev/audit-bundle.mjs [--json out.json]
 */

import { build } from 'esbuild';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const jsonOut = arg('json', '');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const br = (buf) => brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const KiB = (n) => +(n / 1024).toFixed(1);

const report = { files: {}, bundle: {}, sourceAttribution: [], shaderChunks: [], probes: {} };

// ---------------------------------------------------------------- 1. files
for (const rel of ['game.js', path.join('dist', 'game.js'), path.join('dist', 'styles.css'), 'styles.css', 'index.html']) {
  const file = path.join(root, rel);
  let buf;
  try {
    buf = await readFile(file);
  } catch {
    report.files[rel] = { missing: true };
    continue;
  }
  report.files[rel] = {
    bytes: buf.length,
    KiB: KiB(buf.length),
    gzipBytes: gz(buf),
    gzipKiB: KiB(gz(buf)),
    brotliBytes: br(buf),
    brotliKiB: KiB(br(buf)),
    sha256: sha256(buf).slice(0, 16),
  };
}

// ------------------------------------------------------- 2. metafile rebuild
const tmpOut = path.join(os.tmpdir(), `pelican-audit-${process.pid}`, 'game.js');
await mkdir(path.dirname(tmpOut), { recursive: true });

const t0 = Date.now();
const result = await build({
  entryPoints: [path.join(root, 'src/main.js')],
  absWorkingDir: root,
  bundle: true,
  outfile: tmpOut,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const buildMs = Date.now() - t0;

const builtBuf = await readFile(tmpOut);
const outKey = Object.keys(result.metafile.outputs)[0];
const outInfo = result.metafile.outputs[outKey];

report.bundle = {
  outfile: path.relative(root, tmpOut),
  bytes: builtBuf.length,
  KiB: KiB(builtBuf.length),
  gzipKiB: KiB(gz(builtBuf)),
  brotliKiB: KiB(br(builtBuf)),
  buildMs,
  inputCount: Object.keys(outInfo.inputs).length,
};

const buckets = {
  'three core (node_modules/three/build)': 0,
  'three addons (node_modules/three/examples/jsm)': 0,
  'three src (node_modules/three/src)': 0,
  'game source (src/)': 0,
  other: 0,
};
for (const [name, info] of Object.entries(outInfo.inputs)) {
  const n = name.replace(/\\/g, '/');
  const bytes = info.bytesInOutput || 0;
  if (n.includes('node_modules/three/build/')) buckets['three core (node_modules/three/build)'] += bytes;
  else if (n.includes('node_modules/three/examples/jsm/')) buckets['three addons (node_modules/three/examples/jsm)'] += bytes;
  else if (n.includes('node_modules/three/src/')) buckets['three src (node_modules/three/src)'] += bytes;
  else if (n.startsWith('src/')) buckets['game source (src/)'] += bytes;
  else buckets.other += bytes;
}
report.allInputs = Object.entries(outInfo.inputs)
  .map(([name, info]) => ({ name: name.replace(/\\/g, '/'), bytesInOutput: info.bytesInOutput || 0 }))
  .sort((a, b) => b.bytesInOutput - a.bytesInOutput);
report.sourceAttribution = report.allInputs.slice(0, 25);
report.buckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { bytes: v, KiB: KiB(v), pctOfBundle: +((v / builtBuf.length) * 100).toFixed(1) }]));

// ------------------------------------------------------ 3. tree-shake probe
// three keeps every GLSL chunk in one object literal, so the whole chunk table
// ships whenever WebGLProgram does. Measure that table on its own.
try {
  const probe = await build({
    stdin: {
      contents: `import * as mod from 'three/src/renderers/shaders/ShaderChunk.js';\nexport default mod;\n`,
      resolveDir: root,
      loader: 'js',
    },
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'esm',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const pbuf = probe.outputFiles[0].contents;
  const n = pbuf.length;
  report.probes.shaderChunkTable = {
    bytes: n, KiB: KiB(n), gzipKiB: KiB(gz(pbuf)), brotliKiB: KiB(br(pbuf)),
    pctOfBundle: +((n / builtBuf.length) * 100).toFixed(1),
  };
} catch (err) {
  report.probes.shaderChunkTable = { error: String(err && err.message || err) };
}

const text = builtBuf.toString('utf8');

// ---- namespace-escape probe ------------------------------------------------
// `import * as THREE` + handing the namespace object to another object
// (src/main.js:126 `THREE,`) makes esbuild materialise every export, so all of
// three must stay. Measure the two extremes so the gap is a hard number.
const probeBuild = async (contents, label) => {
  const res = await build({
    stdin: { contents, resolveDir: root, loader: 'js' },
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'iife',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const buf = res.outputFiles[0].contents;
  const n = buf.length;
  report.probes[label] = { bytes: n, KiB: KiB(n), gzipKiB: KiB(gz(buf)), brotliKiB: KiB(br(buf)) };
  return n;
};

await probeBuild(`import * as THREE from 'three';\nglobalThis.__NS = THREE;\n`, 'threeNamespaceMaterialised');

// Collect the three symbols the game actually touches (static THREE.X only -
// there is no dynamic THREE[...] access in src/) and rebuild the same surface
// with named imports so the two bundle sizes are comparable.
const { readdir } = await import('node:fs/promises');
const srcFiles = [];
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith('.js')) srcFiles.push(p);
  }
};
await walk(path.join(root, 'src'));
const symbols = new Set();
for (const f of srcFiles) {
  const src = await readFile(f, 'utf8');
  for (const m of src.matchAll(/\bTHREE\.([A-Za-z_][A-Za-z0-9_]*)/g)) symbols.add(m[1]);
}
const symbolList = [...symbols].sort();
const fixture = `
import { ${symbolList.join(', ')} } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
globalThis.__NAMED = [${symbolList.join(', ')}, mergeGeometries, EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass, SMAAPass];
`;
const namedBytes = await probeBuild(fixture, 'namedImportsEquivalent');
report.probes.namedImportSymbolCount = symbolList.length;
report.probes.namedImportSymbols = symbolList;
report.probes.namespaceEscapeDetectedIn = ['src/main.js:126 (ctx = { ..., THREE })'];
void namedBytes;

// addon byte contributions come straight from the metafile of the real build
// (report.allInputs filtered by examples/jsm) - probing them in isolation would
// also pull in their three core imports and overstate their cost.
report.probes.potentialSavings = {
  note: 'three(-ish) bytes if the game stopped hand-exporting the THREE namespace; game source bytes are unchanged in both builds',
  threeNamespaceKiB: report.probes.threeNamespaceMaterialised.KiB,
  namedImportsKiB: report.probes.namedImportsEquivalent.KiB,
  deltaKiB: +(report.probes.threeNamespaceMaterialised.KiB - report.probes.namedImportsEquivalent.KiB).toFixed(1),
};

const MARKERS = [
  ['skinning_pars_vertex', 'SkinnedMesh skinning'],
  ['morphinstance_vertex', 'morph targets'],
  ['morphcolor_vertex', 'morph target colors'],
  ['batching_pars_vertex', 'BatchedMesh'],
  ['iridescence_pars_fragment', 'MeshPhysicalMaterial.iridescence'],
  ['clearcoat_pars_fragment', 'MeshPhysicalMaterial.clearcoat'],
  ['sheen_pars_fragment', 'MeshPhysicalMaterial.sheen'],
  ['anisotropy_pars_fragment', 'MeshPhysicalMaterial.anisotropy'],
  ['transmission_pars_fragment', 'MeshPhysicalMaterial.transmission'],
  ['dispersion_pars_fragment', 'MeshPhysicalMaterial.dispersion'],
  ['volume_pars_fragment', 'NodeMaterial volume'],
  ['alphahash_fragment', 'alphaHash'],
  ['lightmap_pars_fragment', 'lightMap support'],
  ['envmap_physical_pars_fragment', 'IBL envmap (PMREM)'],
  ['shadowmap_pars_fragment', 'shadow maps'],
  ['distanceRGBA_vert', 'point/spot shadow (MeshDistanceMaterial)'],
  ['background_vert', 'Scene.background cube/equirect'],
  ['cube_uv_reflection_fragment', 'CubeUVReflectionMapping'],
  ['points_vert', 'Points'],
  ['sprite_vert', 'Sprite'],
  ['normal_pars_fragment', 'normal maps'],
  ['roughnessmap_pars_fragment', 'roughness maps'],
  ['logdepthbuf_pars_fragment', 'logarithmicDepthBuffer'],
  ['dithering_pars_fragment', 'dithering'],
  ['clipping_planes_pars_fragment', 'clipping planes'],
  ['uv1_pars_vertex', 'second UV set (aoMap/lightMap)'],
  ['GPUShaderStage', 'WebGPU marker (should be absent)'],
  ['WebGPURenderer', 'WebGPU renderer (should be absent)'],
  ['KTX2Loader', 'KTX2Loader (should be absent)'],
  ['DRACOLoader', 'DRACOLoader (should be absent)'],
  ['GLTFLoader', 'GLTFLoader (should be absent)'],
  ['AnimationMixer', 'AnimationMixer (should be absent)'],
  ['CSS2DRenderer', 'CSS2DRenderer (should be absent)'],
  ['OrbitControls', 'OrbitControls (should be absent)'],
  ['Curve', 'Curve base class'],
  ['Raycaster', 'Raycaster'],
  ['AudioContext', 'three AudioListener/WebAudio'],
];
for (const [marker, meaning] of MARKERS) {
  const at = text.indexOf(marker);
  report.shaderChunks.push({
    marker,
    meaning,
    present: at >= 0,
    // a bare string in a console.warn() is not live code - keep the context so
    // "present" can be judged instead of trusted
    context: at >= 0 ? text.slice(Math.max(0, at - 90), at + 90).replace(/\s+/g, ' ') : null,
  });
}

// extra: names that survive because they are property/type strings
const STRINGS = ['MeshStandardMaterial', 'MeshBasicMaterial', 'ShaderMaterial', 'SpriteMaterial', 'LineBasicMaterial', 'MeshDepthMaterial', 'UnrealBloomPass', 'SMAAPass', 'Instance of'];
report.probes.typeStrings = Object.fromEntries(STRINGS.map((s) => [s, text.includes(s)]));
// strings that only exist inside code we do NOT need: if they are present the
// subsystem really shipped (a bare class name in the export map proves nothing)
const DEAD_WEIGHT_STRINGS = [
  'No target node found for track',
  'THREE.PropertyBinding',
  'Cannot use two different cache methods',
  'THREE.AnimationLoader',
  'THREE.AudioLoader',
  'THREE.Audio: ',
  'is not a valid DRACO',
];
report.probes.deadWeightStrings = Object.fromEntries(DEAD_WEIGHT_STRINGS.map((s) => [s, text.includes(s)]));

await writeFile(jsonOut || path.join(os.tmpdir(), 'pelican-audit-bundle.json'), JSON.stringify(report, null, 2));

// ------------------------------------------------------------------ print
console.log('--- shipped files ---');
for (const [rel, info] of Object.entries(report.files)) {
  if (info.missing) { console.log(`${rel.padEnd(18)} MISSING`); continue; }
  console.log(`${rel.padEnd(18)} ${String(info.bytes).padStart(8)} B  ${String(info.gzipBytes).padStart(7)} gz  ${String(info.brotliBytes).padStart(7)} br  sha=${info.sha256}`);
}
console.log(`\n--- rebuilt bundle (${result.metafile.outputs[outKey] ? '' : ''}esbuild ${buildMs} ms) ---`);
console.log(`${report.bundle.KiB} KiB raw / ${report.bundle.gzipKiB} KiB gz / ${report.bundle.brotliKiB} KiB br from ${report.bundle.inputCount} inputs`);
for (const [k, v] of Object.entries(report.buckets)) {
  console.log(`  ${String(v.KiB).padStart(8)} KiB  ${String(v.pctOfBundle).padStart(5)}%  ${k}`);
}
console.log('\n--- top inputs by output bytes ---');
for (const r of report.sourceAttribution.slice(0, 15)) {
  console.log(`  ${String(KiB(r.bytesInOutput)).padStart(8)} KiB  ${r.name}`);
}
console.log(`\n--- shader chunk table alone ---`);
console.log(JSON.stringify(report.probes.shaderChunkTable));
console.log('\n--- tree-shaking probe (shader chunk markers) ---');
for (const r of report.shaderChunks) {
  console.log(`  ${r.present ? 'PRESENT' : 'absent '}  ${r.marker.padEnd(32)} ${r.meaning}`);
}
