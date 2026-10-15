/**
 * capture-frame.mjs - authoritative frame capture that does NOT depend on
 * the browser compositor: renders the composer into its own render target,
 * reads the pixels back with readRenderTargetPixels and writes a PNG.
 *
 * Usage:
 *   node tools/dev/capture-frame.mjs --out shot.png [--script "js-in-page"]
 *   node tools/dev/capture-frame.mjs --scenario village --out village.png
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
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
const out = path.resolve(root, arg('out', '../../pelican-shots/frame.png'));
const scenario = arg('scenario', 'chase');
const noShadow = process.argv.includes('--noshadow');
const hideModule = arg('hide', '');
const evalCode = arg('eval', '');

const SCENARIOS = {
  chase: `
    const P = window.__pelican;
    P.start('ride'); P.setHour(17.15);
    setTimeout(() => P.setCameraMode('chase'), 400);
  `,
  village: `
    const P = window.__pelican;
    P.start('ride'); P.setHour(17.4);
    const v = P.layout.pois.village.position; P.teleport(v.x + 34, v.z + 26, -2.2);
  `,
  harbor: `
    const P = window.__pelican;
    P.start('ride'); P.setHour(16.6);
    const h = P.layout.pois.harbor.position; P.teleport(h.x - 55, h.z - 40, 0.9);
  `,
  lighthouse: `
    const P = window.__pelican;
    P.start('ride'); P.setHour(22.4);
    const l = P.layout.pois.lighthouse.position; P.teleport(l.x - 45, l.z + 32, 0.6);
  `,
  cliffs: `
    const P = window.__pelican;
    P.start('ride'); P.setHour(18.4);
    const b = P.layout.pois.bench.position; P.teleport(b.x + 24, b.z + 18, -1.9);
  `,
  peak: `
    const P = window.__pelican;
    P.start('ride'); P.setHour(6.2);
    const p = P.layout.pois.peak.position; P.teleport(p.x + 26, p.z + 26, -2.4);
  `,
  bridge: `
    const P = window.__pelican;
    P.start('ride'); P.setHour(11.5);
    const b = P.layout.pois.bridge.position;
    P.teleport(b.x - 30, b.z - 26, 0.7);
  `,
  title: '',
};

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('console.error:', m.text()); });
await page.goto(`${pathToFileURL(path.join(dist, 'index.html')).href}?quality=${quality}&seed=${seed}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pelican?.ready === true, null, { timeout: 240000 });

if (noShadow) {
  await page.evaluate(() => {
    const P = window.__pelican;
    P.engine.renderer.shadowMap.enabled = false;
    P.engine.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.isMeshStandardMaterial) m.needsUpdate = true;
    });
  });
}

if (hideModule) {
  await page.evaluate((id) => {
    const P = window.__pelican;
    const inst = P.modules[id];
    if (inst?.group) inst.group.visible = false;
    if (id === 'terrain' && inst?._debug) {
      inst._debug.terrainMesh.visible = false;
      inst._debug.roadMesh.visible = false;
    }
  }, hideModule);
}

if (evalCode) {
  await page.evaluate((code) => {
    new Function('P', code)(window.__pelican);
  }, evalCode);
}

if (SCENARIOS[scenario]) {
  await page.evaluate(new Function(SCENARIOS[scenario]));
  await page.waitForTimeout(2600);
}

// --- stage 1: raw scene render straight into an 8-bit sRGB render target ---
// (reading a HalfFloat target into a Uint8Array is invalid and returns zeros,
//  so the QA target must be UnsignedByte + SRGBColorSpace)
const raw = await page.evaluate(() => {
  const P = window.__pelican;
  const THREE = P.ctx.THREE;
  const renderer = P.engine.renderer;
  const rt = new THREE.WebGLRenderTarget(640, 360, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  renderer.setRenderTarget(rt);
  renderer.render(P.engine.scene, P.engine.camera);
  const buf = new Uint8Array(640 * 360 * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, 640, 360, buf);
  const calls = renderer.info.render.calls;
  const tris = renderer.info.render.triangles;
  renderer.setRenderTarget(null);
  let sum = [0, 0, 0];
  let n = 0;
  let max = 0;
  for (let i = 0; i < 640 * 360; i += 91) { sum[0] += buf[i * 4]; sum[1] += buf[i * 4 + 1]; sum[2] += buf[i * 4 + 2]; n++; }
  for (let i = 0; i < 640 * 360; i += 13) max = Math.max(max, buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(640, 360);
  for (let y = 0; y < 360; y++) {
    const src = (360 - 1 - y) * 640 * 4;
    img.data.set(buf.subarray(src, src + 640 * 4), y * 640 * 4);
  }
  ctx.putImageData(img, 0, 0);
  rt.dispose();
  return {
    avg: sum.map((v) => Math.round(v / n)),
    calls, tris, max,
    center: [buf[(360 / 2 * 640 + 320) * 4], buf[(360 / 2 * 640 + 320) * 4 + 1], buf[(360 / 2 * 640 + 320) * 4 + 2]],
    dataUrl: canvas.toDataURL('image/png'),
  };
});
console.log(`raw scene -> RT   : avg ${raw.avg.join(',')}  center ${raw.center.join(',')}  max ${raw.max}  calls ${raw.calls} tris ${(raw.tris / 1000).toFixed(0)}k`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out.replace(/\.png$/, '-raw.png'), Buffer.from(raw.dataUrl.split(',')[1], 'base64'));

// --- stage 1b: lighting variant matrix -------------------------------------
const variants = await page.evaluate(() => {
  const P = window.__pelican;
  const THREE = P.ctx.THREE;
  const renderer = P.engine.renderer;
  const scene = P.engine.scene;
  const results = [];
  const rt = new THREE.WebGLRenderTarget(320, 180, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  const env = scene.environment;
  const shadow = renderer.shadowMap.enabled;
  const mkShot = (label2) => {
    const w = 640, h = 360;
    const rt2 = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
    renderer.setRenderTarget(rt2);
    renderer.render(scene, P.engine.camera);
    const b = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt2, 0, 0, w, h, b);
    renderer.setRenderTarget(null);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      img.data.set(b.subarray(src, src + w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    rt2.dispose();
    return { label: label2, dataUrl: canvas.toDataURL('image/png') };
  };

  const run = (label, setup, teardown) => {
    setup();
    renderer.setRenderTarget(rt);
    renderer.render(scene, P.engine.camera);
    const buf = new Uint8Array(320 * 180 * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
    renderer.setRenderTarget(null);
    let sum = [0, 0, 0], max = 0, n = 0;
    for (let i = 0; i < 320 * 180; i += 37) {
      sum[0] += buf[i * 4]; sum[1] += buf[i * 4 + 1]; sum[2] += buf[i * 4 + 2];
      max = Math.max(max, buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
      n++;
    }
    results.push({ label, avg: sum.map((v) => Math.round(v / n)), max });
    teardown();
  };

  run('as-is', () => {}, () => {});
  const shotShadowOff = (() => {
    renderer.shadowMap.enabled = false;
    scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.isMeshStandardMaterial) m.needsUpdate = true;
    });
    const shot = mkShot('shadow-off');
    renderer.shadowMap.enabled = shadow;
    scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.isMeshStandardMaterial) m.needsUpdate = true;
    });
    return shot;
  })();
  run('no-env', () => { scene.environment = null; }, () => { scene.environment = env; });
  run('no-shadow', () => { renderer.shadowMap.enabled = false; }, () => { renderer.shadowMap.enabled = shadow; });
  run('no-env+no-shadow', () => { scene.environment = null; renderer.shadowMap.enabled = false; }, () => { scene.environment = env; renderer.shadowMap.enabled = shadow; });
  run('sun-only-10x', () => {
    const sun = P.modules.environment.sun;
    sun.intensity = 30;
  }, () => { P.modules.environment.update(0.016, P.state); });
  rt.dispose();
  return { results, shots: [shotShadowOff] };
});
for (const v of variants.results) console.log(`variant ${v.label.padEnd(16)} avg ${v.avg.join(',')}  max ${v.max}`);
for (const s of variants.shots) {
  await writeFile(out.replace(/\.png$/, `-${s.label}.png`), Buffer.from(s.dataUrl.split(',')[1], 'base64'));
}

// --- stage 1c: light inventory + per-module visibility ----------------------
const lights = await page.evaluate(() => {
  const P = window.__pelican;
  return P.engine.scene.children
    .filter((o) => o.isLight)
    .map((l) => ({
      type: l.type,
      intensity: +l.intensity.toFixed(2),
      visible: l.visible,
      color: l.color.getHexString(),
      pos: [l.position.x, l.position.y, l.position.z].map((v) => +v.toFixed(1)),
      castsShadow: !!l.castShadow,
    }));
});
console.log('lights:', JSON.stringify(lights));

const perModule = await page.evaluate(() => {
  const P = window.__pelican;
  const THREE = P.ctx.THREE;
  const renderer = P.engine.renderer;
  const scene = P.engine.scene;
  const rt = new THREE.WebGLRenderTarget(320, 180, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  const out = [];
  const top = P.engine.world.children;
  const saved = top.map((c) => c.visible);
  const measure = () => {
    renderer.setRenderTarget(rt);
    renderer.render(scene, P.engine.camera);
    const buf = new Uint8Array(320 * 180 * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
    renderer.setRenderTarget(null);
    // bottom 60% of the frame = terrain region
    let sum = [0, 0, 0], max = 0, n = 0;
    for (let y = 0; y < 108; y++) {
      for (let x = 0; x < 320; x += 5) {
        const i = (y * 320 + x) * 4;
        sum[0] += buf[i]; sum[1] += buf[i + 1]; sum[2] += buf[i + 2];
        max = Math.max(max, buf[i], buf[i + 1], buf[i + 2]);
        n++;
      }
    }
    return { avg: sum.map((v) => Math.round(v / n)), max };
  };
  // ground truth for a lit surface: add a fresh sun-lit sphere right in front of the camera
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(2, 24, 16), new THREE.MeshStandardMaterial({ color: 0xcc8844, roughness: 0.8 }));
  sphere.position.copy(P.state.player.position).add(new THREE.Vector3(0, 2, 0));
  const dl = new THREE.DirectionalLight(0xffffff, 4);
  dl.position.set(P.state.player.position.x + 20, P.state.player.position.y + 30, P.state.player.position.z + 20);
  dl.target = sphere;
  scene.add(sphere, dl);
  out.push({ label: 'probe-sphere+light', ...measure() });
  scene.remove(sphere, dl);

  for (let i = 0; i < top.length; i++) {
    for (let j = 0; j < top.length; j++) top[j].visible = i === j;
    out.push({ label: top[i].name || top[i].type, ...measure() });
  }
  for (let j = 0; j < top.length; j++) top[j].visible = saved[j];
  rt.dispose();
  return out;
});
for (const m of perModule) console.log(`visibility ${m.label.padEnd(22)} lower-frame avg ${m.avg.join(',')}  max ${m.max}`);

// --- stage 1d: is the PMREM environment poisoning the lights? ---------------
const envTest = await page.evaluate(() => {
  const P = window.__pelican;
  const THREE = P.ctx.THREE;
  const renderer = P.engine.renderer;
  const scene = P.engine.scene;
  const rt = new THREE.WebGLRenderTarget(320, 180, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  const measure = () => {
    renderer.setRenderTarget(rt);
    renderer.render(scene, P.engine.camera);
    const buf = new Uint8Array(320 * 180 * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
    renderer.setRenderTarget(null);
    let sum = [0, 0, 0], max = 0, n = 0;
    for (let y = 0; y < 108; y++) for (let x = 0; x < 320; x += 5) {
      const i = (y * 320 + x) * 4;
      sum[0] += buf[i]; sum[1] += buf[i + 1]; sum[2] += buf[i + 2];
      max = Math.max(max, buf[i], buf[i + 1], buf[i + 2]); n++;
    }
    return { avg: sum.map((v) => Math.round(v / n)), max };
  };
  const out = [];
  out.push({ label: 'baseline', ...measure() });

  // 1) environmentIntensity = 0 (uniform only, no recompile)
  const prevIntensity = scene.environmentIntensity;
  scene.environmentIntensity = 0;
  out.push({ label: 'envIntensity=0', ...measure() });
  scene.environmentIntensity = prevIntensity;

  // 2) drop the env map and force every material to recompile
  const prevEnv = scene.environment;
  scene.environment = null;
  const touched = [];
  scene.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { if (m && m.isMeshStandardMaterial) { m.needsUpdate = true; touched.push(m.uuid); } }
  });
  out.push({ label: `envOff+recompile(${new Set(touched).size})`, ...measure() });
  scene.environment = prevEnv;
  scene.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m && m.isMeshStandardMaterial) m.needsUpdate = true;
  });
  out.push({ label: 'envBack+recompile', ...measure() });

  rt.dispose();
  return out;
});
for (const v of envTest) console.log(`envtest ${v.label.padEnd(24)} avg ${v.avg.join(',')}  max ${v.max}`);

// --- stage 1e: minimal standalone scene sanity check -------------------------
const minimal = await page.evaluate(() => {
  const P = window.__pelican;
  const THREE = P.ctx.THREE;
  const renderer = P.engine.renderer;
  const scene2 = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(50, 320 / 180, 0.1, 100);
  cam.position.set(0, 0.5, 6);
  cam.lookAt(0, 0, 0);
  const geo = new THREE.SphereGeometry(1, 24, 16);
  const basic = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff4040 }));
  basic.position.set(-2.4, 0, 0);
  const std = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x40ff40, roughness: 0.7 }));
  std.position.set(0, 0, 0);
  const std2 = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8080ff, roughness: 0.7 }));
  std2.position.set(2.4, 0, 0);
  scene2.add(basic, std, std2);
  const dl = new THREE.DirectionalLight(0xffffff, 3);
  dl.position.set(3, 5, 6);
  scene2.add(dl);
  const amb = new THREE.AmbientLight(0xffffff, 0.4);
  scene2.add(amb);
  const rt = new THREE.WebGLRenderTarget(320, 180, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  renderer.setRenderTarget(rt);
  renderer.render(scene2, cam);
  const buf = new Uint8Array(320 * 180 * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
  renderer.setRenderTarget(null);
  const px = (x, y) => {
    const i = (y * 320 + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
  const out = {
    version: renderer.getContext().getParameter(renderer.getContext().VERSION),
    renderer: renderer.getContext().getParameter(renderer.getContext().RENDERER),
    basicRed: px(53, 90),
    stdGreen: px(160, 90),
    stdBlue: px(266, 90),
    background: px(10, 10),
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
  };
  rt.dispose();
  return out;
});
console.log('minimal scene:', JSON.stringify(minimal));

// --- stage 1f: are the procedural canvas textures actually painted? ---------
const texProbe = await page.evaluate(() => {
  const P = window.__pelican;
  const TEX = P.ctx.textures;
  const names = ['grass', 'asphalt', 'bark', 'plaster', 'roofTile', 'wicker', 'waterNormal', 'cloudSprite'];
  const out = {};
  for (const n of names) {
    try {
      const surf = typeof TEX[n] === 'function' ? TEX[n]() : null;
      const tex = surf?.map || surf?.image ? (surf.map || surf) : surf;
      const img = tex && (tex.image || tex.source?.data);
      if (!img || !img.width) { out[n] = 'no-image'; continue; }
      const c = document.createElement('canvas');
      c.width = Math.min(64, img.width); c.height = Math.min(64, img.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = [0, 0, 0], max = 0;
      for (let i = 0; i < c.width * c.height; i++) {
        sum[0] += d[i * 4]; sum[1] += d[i * 4 + 1]; sum[2] += d[i * 4 + 2];
        max = Math.max(max, d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
      }
      const n2 = c.width * c.height;
      out[n] = { size: [img.width, img.height], avg: sum.map((v) => Math.round(v / n2)), max, colorSpace: tex.colorSpace };
    } catch (err) {
      out[n] = `err: ${err.message}`;
    }
  }
  return out;
});
for (const [k, v] of Object.entries(texProbe)) console.log(`texture ${k.padEnd(14)}`, JSON.stringify(v));

// --- stage 1g: what is the road actually made of? ---------------------------
const roadProbe = await page.evaluate(() => {
  const P = window.__pelican;
  const THREE = P.ctx.THREE;
  const renderer = P.engine.renderer;
  const mats = P.modules.terrain.materials;
  const dbg = P.modules.terrain._debug;
  const info = (m) => m ? {
    type: m.type,
    color: m.color ? `#${m.color.getHexString()}` : null,
    hasMap: !!m.map,
    mapSize: m.map?.image ? [m.map.image.width, m.map.image.height] : null,
    mapRepeat: m.map ? [m.map.repeat.x, m.map.repeat.y] : null,
    roughness: m.roughness,
    metalness: m.metalness,
    vertexColors: m.vertexColors,
    side: m.side,
    envMapIntensity: m.envMapIntensity,
  } : null;
  const out = {
    road: info(mats.road),
    skirt: info(mats.skirt),
    paint: info(mats.paint),
    roadMeshVisible: dbg.roadMesh.visible,
    roadMeshTriangles: dbg.roadMesh.geometry.index ? dbg.roadMesh.geometry.index.count / 3 : dbg.roadMesh.geometry.attributes.position.count / 3,
    // render straight down at the road from above the spawn point and sample
    cam: null,
  };
  // sample the road straight down
  const spawn = P.layout.pois.spawn.position;
  const cam = new THREE.PerspectiveCamera(60, 320 / 180, 0.1, 500);
  cam.position.set(spawn.x, spawn.y + 12, spawn.z);
  cam.lookAt(spawn.x, spawn.y, spawn.z);
  const rt = new THREE.WebGLRenderTarget(320, 180, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  renderer.setRenderTarget(rt);
  renderer.render(P.engine.scene, cam);
  const buf = new Uint8Array(320 * 180 * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
  renderer.setRenderTarget(null);
  const i = (90 * 320 + 160) * 4;
  out.centerPixel = [buf[i], buf[i + 1], buf[i + 2]];
  out.aboveRoadPixel = [buf[(120 * 320 + 160) * 4], buf[(120 * 320 + 160) * 4 + 1], buf[(120 * 320 + 160) * 4 + 2]];
  rt.dispose();
  return out;
});
console.log('road probe:', JSON.stringify(roadProbe));

// --- stage 1h: why is the shadow map darkening everything? ------------------
const shadowMatrix = await page.evaluate(() => {
  const P = window.__pelican;
  const THREE = P.ctx.THREE;
  const renderer = P.engine.renderer;
  const scene = P.engine.scene;
  const sun = P.modules.environment.sun;
  const rt = new THREE.WebGLRenderTarget(320, 180, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  const measure = () => {
    renderer.setRenderTarget(rt);
    renderer.render(scene, P.engine.camera);
    const buf = new Uint8Array(320 * 180 * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
    renderer.setRenderTarget(null);
    let sum = [0, 0, 0], n = 0;
    for (let i = 0; i < 320 * 180; i += 53) {
      // skip the sky (upper third) so we measure lit ground
      const y = Math.floor(i / 320);
      if (y > 100) continue;
      sum[0] += buf[i * 4]; sum[1] += buf[i * 4 + 1]; sum[2] += buf[i * 4 + 2];
      n++;
    }
    return n ? sum.map((v) => Math.round(v / n)) : [0, 0, 0];
  };
  const out = { lights: [], results: [] };
  out.lights.push({
    sunPos: [sun.position.x, sun.position.y, sun.position.z].map((v) => +v.toFixed(1)),
    targetPos: [sun.target.position.x, sun.target.position.y, sun.target.position.z].map((v) => +v.toFixed(1)),
    camPos: [sun.shadow.camera.position.x, sun.shadow.camera.position.y, sun.shadow.camera.position.z].map((v) => +v.toFixed(1)),
    near: sun.shadow.camera.near, far: sun.shadow.camera.far,
    left: sun.shadow.camera.left, right: sun.shadow.camera.right,
    hasMap: !!sun.shadow.map,
    mapSize: sun.shadow.map ? [sun.shadow.map.width, sun.shadow.map.height] : null,
    mapType: sun.shadow.map ? sun.shadow.map.texture.type : null,
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, intensity: sun.shadow.intensity,
  });

  const recompile = () => scene.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m && m.isMeshStandardMaterial) m.needsUpdate = true;
  });

  out.results.push({ label: 'as-is', avg: measure() });

  const b0 = sun.shadow.bias;
  sun.shadow.bias = -0.02;
  out.results.push({ label: 'bias-0.02', avg: measure() });
  sun.shadow.bias = b0;

  const n0 = sun.shadow.normalBias;
  sun.shadow.normalBias = 4.0;
  out.results.push({ label: 'normalBias4', avg: measure() });
  sun.shadow.normalBias = n0;

  // tight depth range: light is ~420 from the target
  const cam = sun.shadow.camera;
  const n1 = cam.near, f1 = cam.far;
  cam.near = 300; cam.far = 620; cam.updateProjectionMatrix();
  out.results.push({ label: 'near300/far620', avg: measure() });
  cam.near = n1; cam.far = f1; cam.updateProjectionMatrix();

  // smaller ortho box
  const l0 = cam.left, r0 = cam.right;
  cam.left = -40; cam.right = 40; cam.updateProjectionMatrix();
  out.results.push({ label: 'box80', avg: measure() });
  cam.left = l0; cam.right = r0; cam.updateProjectionMatrix();

  // shadows off entirely (with recompiles)
  renderer.shadowMap.enabled = false;
  recompile();
  out.results.push({ label: 'shadows-off', avg: measure() });
  renderer.shadowMap.enabled = true;
  recompile();

  rt.dispose();
  return out;
});
console.log('shadow diagnostics:', JSON.stringify(shadowMatrix, null, 1));

const frame = await page.evaluate(() => {
  const P = window.__pelican;
  const composer = P.post.composer;
  const renderer = P.engine.renderer;
  const prev = composer.renderToScreen;
  composer.renderToScreen = false;
  composer.render(0.016);
  const rt = composer.readBuffer;
  const w = rt.width, h = rt.height;
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  composer.renderToScreen = prev;

  let sum = [0, 0, 0];
  const samples = [];
  for (let i = 0; i < 12; i++) samples.push([buf[i * 40000 * 4 + 1], buf[i * 40000 * 4 + 2], buf[i * 40000 * 4 + 3]]);
  for (let i = 0; i < w * h; i += 997) { sum[0] += buf[i * 4]; sum[1] += buf[i * 4 + 1]; sum[2] += buf[i * 4 + 2]; }
  const n = Math.ceil(w * h / 997);
  const avg = sum.map((v) => Math.round(v / n));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    img.data.set(buf.subarray(src, src + w * 4), y * w * 4);
  }
  ctx.putImageData(img, 0, 0);
  return { w, h, avg, samples, dataUrl: canvas.toDataURL('image/png') };
});

await mkdir(path.dirname(out), { recursive: true });
const b64 = frame.dataUrl.split(',')[1];
await writeFile(out, Buffer.from(b64, 'base64'));
console.log(`captured ${frame.w}x${frame.h} -> ${out}`);
console.log(`average colour ${frame.avg.join(',')}  samples ${JSON.stringify(frame.samples.slice(0, 6))}`);
await browser.close();
