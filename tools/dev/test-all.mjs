/**
 * test-all.mjs - runs every module dev test in sequence and reports a summary.
 * `npm test`
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const TESTS = [
  'test-layout.mjs',
  'test-character.mjs',
  'test-vegetation.mjs',
  'test-props.mjs',
  'test-landmarks.mjs',
  'test-life.mjs',
  'test-audio.mjs',
  'test-ui.mjs',
];

let failed = 0;
for (const file of TESTS) {
  const name = file.replace(/^test-|\.mjs$/g, '');
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(here, file)], { cwd: root, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const ok = res.status === 0 && /PASSED/.test(out);
  const last = out.trim().split('\n').filter(Boolean).pop() || '(no output)';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${last.slice(0, 90)}`);
  if (!ok) {
    failed++;
    console.log(out.split('\n').slice(-12).join('\n'));
  }
}

console.log(failed === 0 ? `\nnpm test: all ${TESTS.length} suites passed` : `\nnpm test: ${failed} suite(s) failed`);
process.exit(failed === 0 ? 0 : 1);
