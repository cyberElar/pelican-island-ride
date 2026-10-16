/**
 * Keeps the shipped bundle honest. Run after `npm run build`.
 *
 * The budget is a ceiling, not a target: it is deliberately a few percent above
 * the current size so ordinary changes pass and a careless one does not.
 *
 * Usage: node tools/dev/check-bundle-budget.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// bytes
const BUDGET = {
  'dist/game.js': { raw: 1_400_000, gzip: 400_000 },
  'dist/styles.css': { raw: 80_000, gzip: 20_000 },
};

const k = (n) => (n / 1024).toFixed(0) + ' KiB';

let failed = false;
let missing = 0;

for (const [rel, budget] of Object.entries(BUDGET)) {
  const file = path.join(root, rel);
  if (!existsSync(file)) {
    console.error(`  ??  ${rel} not built yet - run 'npm run build' first`);
    missing++;
    continue;
  }
  const raw = readFileSync(file);
  const gzip = gzipSync(raw, { level: 9 });
  const overRaw = raw.length > budget.raw;
  const overGzip = gzip.length > budget.gzip;
  if (overRaw || overGzip) failed = true;
  const mark = overRaw || overGzip ? 'OVER' : ' ok ';
  console.log(
    `  ${mark} ${rel.padEnd(18)} raw ${k(raw.length).padStart(9)} / ${k(budget.raw)}` +
      `   gzip ${k(gzip.length).padStart(8)} / ${k(budget.gzip)}`
  );
}

if (missing) {
  console.error('\ncheck-bundle-budget: nothing to check (build first)');
  process.exit(1);
}

if (failed) {
  console.error('\ncheck-bundle-budget: FAILED - the bundle outgrew its budget.');
  console.error('Either trim the change or raise the budget in tools/dev/check-bundle-budget.mjs');
  console.error('and say why in the pull request.');
  process.exit(1);
}

console.log('\ncheck-bundle-budget: ok');
