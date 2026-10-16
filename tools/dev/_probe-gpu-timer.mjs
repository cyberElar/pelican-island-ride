/**
 * _probe-gpu-timer.mjs - scratch probe: does EXT_disjoint_timer_query_webgl2
 * hand back per-frame GPU times in this headless setup, and does gl.finish()
 * change the answer?
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist');
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${pathToFileURL(path.join(dist, 'index.html')).href}?quality=low&seed=20261014`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });

const out = await page.evaluate(async () => {
  const P = window.__pelican;
  const renderer = P.engine.renderer;
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const log = { ext: !!ext, samples: [], errors: [] };
  if (!ext) return log;

  P.start('ride');
  P.engine.stop();
  await new Promise((r) => setTimeout(r, 300));

  const renderOnce = (finish) => {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    P.engine.render();
    if (finish) gl.finish();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    return { q, wall: performance.now() - t0 };
  };

  // pass 1: no finish, poll later
  const pending = [];
  for (let i = 0; i < 20; i++) pending.push(renderOnce(false));
  await new Promise((r) => setTimeout(r, 400));
  let avail = 0, got = 0;
  for (const p of pending) {
    const ok = gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE);
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (ok && !disjoint) { got++; log.samples.push({ i: 'nofinish', ns: gl.getQueryParameter(p.q, gl.QUERY_RESULT), wall: p.wall, disjoint }); }
    if (ok) avail++;
    gl.deleteQuery(p.q);
  }
  log.pass1 = { avail, got, total: pending.length };

  // pass 2: with gl.finish() inside the query window
  for (let i = 0; i < 20; i++) {
    const p = renderOnce(true);
    const ok = gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE);
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (ok && !disjoint) log.samples.push({ i: 'finish', ns: gl.getQueryParameter(p.q, gl.QUERY_RESULT), wall: p.wall, disjoint });
    gl.deleteQuery(p.q);
  }
  log.errorCode = gl.getError();
  return log;
});

console.log(JSON.stringify({ ext: out.ext, pass1: out.pass1, errorCode: out.errorCode, samples: out.samples.map((s) => ({ i: s.i, ms: +(s.ns / 1e6).toFixed(2), wall: +s.wall.toFixed(2) })) }, null, 1));
await browser.close();
