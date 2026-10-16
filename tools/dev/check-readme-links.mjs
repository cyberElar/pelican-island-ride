/**
 * Cheapest possible documentation test: every relative link and image in the
 * READMEs must point at a file that actually exists.
 *
 * Usage: node tools/dev/check-readme-links.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const DOCS = ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const problems = [];
let checked = 0;

for (const doc of DOCS) {
  const file = path.join(root, doc);
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(LINK)) {
    const target = m[1];
    if (/^(https?:|mailto:|#|tel:)/.test(target)) continue;
    const cleaned = decodeURIComponent(target.split('#')[0]);
    if (!cleaned) continue;
    checked++;
    if (!existsSync(path.resolve(root, cleaned))) {
      problems.push(`${doc}: missing target '${target}'`);
    }
  }
}

if (problems.length) {
  console.error('check-readme-links: FAILED');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(`check-readme-links: ok (${checked} local links and images resolve)`);
