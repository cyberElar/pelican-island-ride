/**
 * build.mjs - bundles the game into dist/ as a self-contained, file://
 * friendly package:
 *   dist/index.html   (copied from the project root)
 *   dist/game.js      (esbuild IIFE bundle: three.js + all game code)
 *   dist/styles.css   (copied UI stylesheet)
 *
 * Usage: node tools/build.mjs [--quick] [--verbose]
 *        node tools/build.mjs --publish    (also refresh the playable copies
 *                                           in the repo root: game.js + styles.css)
 */

import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');

const quick = process.argv.includes('--quick');
const verbose = process.argv.includes('--verbose');
const publish = process.argv.includes('--publish');

async function main() {
  await mkdir(dist, { recursive: true });

  const missing = [];
  for (const rel of ['src/character/rider.js', 'src/world/props.js', 'src/world/animals.js', 'src/world/particles.js']) {
    if (!existsSync(path.join(root, rel))) missing.push(rel);
  }
  if (missing.length) {
    console.log(`note: modules not present yet (registry guards them): ${missing.join(', ')}`);
  }

  const t0 = Date.now();
  const result = await build({
    entryPoints: [path.join(root, 'src/main.js')],
    bundle: true,
    outfile: path.join(dist, 'game.js'),
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: !quick,
    sourcemap: false,
    legalComments: 'none',
    logLevel: verbose ? 'info' : 'warning',
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  await cp(path.join(root, 'index.html'), path.join(dist, 'index.html'));
  await cp(path.join(root, 'src/ui/styles.css'), path.join(dist, 'styles.css'));

  if (publish) {
    // The repository root doubles as the GitHub Pages site: index.html already
    // lives there, so it only needs the freshly built bundle + stylesheet.
    await cp(path.join(dist, 'game.js'), path.join(root, 'game.js'));
    await cp(path.join(dist, 'styles.css'), path.join(root, 'styles.css'));
    console.log('published: root game.js + styles.css refreshed');
  }

  // Report module sizes for the biggest contributors (keeps the bundle honest)
  const js = await stat(path.join(dist, 'game.js'));
  const outs = Object.entries(result.metafile.outputs)[0][1];
  const biggest = Object.entries(result.metafile.inputs)
    .map(([name, info]) => [name, info.bytes])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  console.log(`built dist/game.js in ${Date.now() - t0} ms  (${(js.size / 1024).toFixed(0)} KiB, ${quick ? 'dev' : 'minified'})`);
  console.log(`  index.html + styles.css copied`);
  void readFile; void writeFile;
  void outs;
  for (const [name, bytes] of biggest) {
    console.log(`   ${(bytes / 1024).toFixed(0).padStart(6)} KiB  ${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
