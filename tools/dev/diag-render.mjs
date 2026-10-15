/**
 * diag-render.mjs - answers "why is the canvas black?" with hard evidence:
 * DOM stacking, canvas size/style, camera vs terrain, GL pixel readback with
 * and without the post pipeline.
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

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('console.error:', m.text()); });
await page.goto(`${pathToFileURL(path.join(dist, 'index.html')).href}?quality=${quality}&seed=20261014&preserve=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => window.__pelican.start('ride'));
await page.waitForTimeout(2500);

const sample = () => page.evaluate(() => {
  const P = window.__pelican;
  const gl = P.engine.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const buf = new Uint8Array(4 * 9);
  gl.readPixels(Math.floor(w / 2) - 1, Math.floor(h / 2) - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const avg = [0, 0, 0];
  for (let i = 0; i < 9; i++) { avg[0] += buf[i * 4]; avg[1] += buf[i * 4 + 1]; avg[2] += buf[i * 4 + 2]; }
  return { glSize: [w, h], centerPixelAverage: avg.map((v) => Math.round(v / 9)) };
});

const dom = await page.evaluate(() => {
  const canvas = document.getElementById('game-canvas');
  const r = canvas.getBoundingClientRect();
  const cs = getComputedStyle(canvas);
  const at = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const uiRoot = document.getElementById('ui-root');
  const uiCs = uiRoot ? getComputedStyle(uiRoot) : null;
  return {
    canvasRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    canvasStyle: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, position: cs.position, zIndex: cs.zIndex, background: cs.backgroundColor, filter: cs.filter },
    elementAtCenter: at ? (at.id || at.className || at.tagName) : null,
    uiRootStyle: uiCs ? { position: uiCs.position, inset: uiCs.inset, background: uiCs.backgroundColor, zIndex: uiCs.zIndex, pointerEvents: uiCs.pointerEvents } : null,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
  };
});

const cam = await page.evaluate(() => {
  const P = window.__pelican;
  const c = P.engine.camera;
  const p = P.state.player.position;
  return {
    camera: { x: +c.position.x.toFixed(1), y: +c.position.y.toFixed(1), z: +c.position.z.toFixed(1), fov: c.fov, near: c.near, far: c.far, aspect: +c.aspect.toFixed(3) },
    player: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) },
    terrainAtCamera: +P.layout.heightAt(c.position.x, c.position.z).toFixed(1),
    mode: P.state.camera.mode,
    sceneChildren: P.engine.scene.children.length,
    worldChildren: P.engine.world.children.map((c2) => c2.name || c2.type),
    visibleSky: P.engine.skyGroup.children[0]?.visible ?? null,
    exposure: P.engine.renderer.toneMappingExposure,
    sunIntensity: P.state.sun.intensity,
  };
});

console.log('DOM :', JSON.stringify(dom, null, 1));
console.log('CAM :', JSON.stringify(cam, null, 1));
console.log('WITH post   :', JSON.stringify(await sample()));

await page.evaluate(() => { window.__pelican.engine.setPost(null); });
await page.waitForTimeout(300);
console.log('WITHOUT post:', JSON.stringify(await sample()));

// isolate the composer chain, pass by pass
await page.evaluate(() => {
  const P = window.__pelican;
  P.engine.setPost(P.post);
  const { godPass, bloomPass, gradePass, outputPass, smaaPass } = P.post.passes;
  for (const p of [godPass, bloomPass, gradePass, outputPass, smaaPass]) if (p) p.enabled = false;
});
await page.waitForTimeout(300);
console.log('renderPass only      :', JSON.stringify(await sample()));

await page.evaluate(() => { window.__pelican.post.passes.gradePass.enabled = true; });
await page.waitForTimeout(300);
console.log('+ grade              :', JSON.stringify(await sample()));

await page.evaluate(() => { window.__pelican.post.passes.outputPass.enabled = true; });
await page.waitForTimeout(300);
console.log('+ output             :', JSON.stringify(await sample()));

await page.evaluate(() => { window.__pelican.post.passes.bloomPass.enabled = true; });
await page.waitForTimeout(300);
console.log('+ bloom              :', JSON.stringify(await sample()));

await page.evaluate(() => {
  const P = window.__pelican;
  P.post.passes.godPass.enabled = true;
  P.post.passes.smaaPass.enabled = true;
  P.engine.renderer.info.autoReset = false;
  P.engine.renderer.info.reset();
  window.__glError = P.engine.renderer.getContext().getError();
});
await page.waitForTimeout(200);
console.log('gl error code:', await page.evaluate(() => window.__glError));

// sky only: hide everything else
await page.evaluate(() => {
  const P = window.__pelican;
  for (const c of P.engine.world.children) c.visible = false;
});
await page.waitForTimeout(300);
console.log('SKY only    :', JSON.stringify(await sample()));

await browser.close();
