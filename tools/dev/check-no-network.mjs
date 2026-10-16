/**
 * Guard for one of the project's two hard rules: nothing may be fetched at
 * runtime. Everything the game draws or plays is generated in code, which is
 * also what makes the `file://` build work.
 *
 * Usage: node tools/dev/check-no-network.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const RULES = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bnew\s+WebSocket\b/, 'WebSocket'],
  [/\bnew\s+EventSource\b/, 'EventSource'],
  [/navigator\s*\.\s*sendBeacon/, 'navigator.sendBeacon'],
  [/\bimport\s*\(\s*["'`]https?:/, 'dynamic import of a remote module'],
  [/from\s*["'`]\s*https?:/, 'import from a remote module'],
  [/\b(Texture|Image|File|Audio|CubeTexture|Object|GLTF|FBX|OBJ|DRACO|RGBE|KTX2)Loader\b/, 'THREE loader'],
  [/\bnew\s+Audio\s*\(/, 'new Audio()'],
  [/\bnew\s+Image\s*\(/, 'new Image()'],
  [/\.src\s*=\s*["'`]https?:/, 'remote media src assignment'],
];

const SKIP = /(\/\/|#)\s*net-guard-ignore/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|css|html)$/.test(name)) out.push(full);
  }
  return out;
}

const problems = [];

for (const file of walk(path.join(root, 'src')).concat([path.join(root, 'index.html')])) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (SKIP.test(line)) return;
    for (const [re, label] of RULES) {
      if (re.test(line)) {
        problems.push(`${rel}:${i + 1}  ${label}\n    ${line.trim()}`);
      }
    }
  });
}

// index.html must not pull remote scripts or styles either. `rel="canonical"`
// and link-preview `<meta>` tags are crawler metadata that is never fetched by
// the page itself, so those lines are exempt.
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
for (const [i, line] of html.split(/\r?\n/).entries()) {
  if (/rel\s*=\s*["']canonical["']/.test(line)) continue;
  if (/<meta\s[^>]*(?:property|name)\s*=\s*["'](?:og|twitter):/.test(line)) continue;
  for (const m of line.matchAll(/(?:src|href)\s*=\s*["'](https?:[^"']+)["']/g)) {
    problems.push(`index.html:${i + 1}  remote reference: ${m[1]}`);
  }
}

if (problems.length) {
  console.error('check-no-network: FAILED\n');
  for (const p of problems) console.error('  ' + p);
  console.error(`\n${problems.length} problem(s). The game must run with no network access.`);
  process.exit(1);
}

console.log('check-no-network: ok (no runtime network access in src/ or index.html)');
