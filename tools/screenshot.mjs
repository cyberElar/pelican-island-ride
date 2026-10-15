/**
 * screenshot.mjs - headless visual verification harness.
 *
 * Loads dist/index.html (file://), waits for the world to build, then walks a
 * scenario of camera/teleport/daylight states and saves PNGs. Also reports
 * WebGL draw stats, measured FPS and every console error.
 *
 * Usage:
 *   node tools/screenshot.mjs                 # full scenario
 *   node tools/screenshot.mjs --only title,chase
 *   node tools/screenshot.mjs --quality medium --seed 1234
 *   node tools/screenshot.mjs --out ../../pelican-shots
 */

import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const outDir = path.resolve(root, arg('out', '../../pelican-shots'));
const quality = arg('quality', 'high');
const seed = arg('seed', '20261014');
const only = arg('only', '');
const width = parseInt(arg('width', '1600'), 10);
const height = parseInt(arg('height', '900'), 10);

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const p of EDGE_PATHS) if (existsSync(p)) return { path: p, name: 'Edge' };
  for (const p of CHROME_PATHS) if (existsSync(p)) return { path: p, name: 'Chrome' };
  return null;
}

const SCENARIOS = [
  {
    id: 'title',
    label: '标题界面',
    setup: async () => {},
    settle: 2600,
  },
  {
    id: 'chase',
    label: '追逐视角 · 黄金时刻',
    setup: async (page) => {
      await page.evaluate(() => { window.__pelican.start('ride'); window.__pelican.setHour(17.15); });
    },
    settle: 3200,
  },
  {
    id: 'village',
    label: '海风村',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        const v = P.layout.pois.village.position;
        P.setHour(17.5);
        P.teleport(v.x + 40, v.z + 30, -2.2);
      });
    },
    settle: 2600,
  },
  {
    id: 'harbor',
    label: '旧鱼港',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        P.start('ride');
        const h = P.layout.pois.harbor.position;
        P.setHour(16.6);
        P.teleport(h.x - 60, h.z - 40, 0.9);
      });
    },
    settle: 2600,
  },
  {
    id: 'lighthouse-night',
    label: '灯塔 · 深夜光束',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        P.start('ride');
        const l = P.layout.pois.lighthouse.position;
        P.setHour(22.4);
        P.teleport(l.x - 40, l.z + 30, 0.6);
      });
    },
    settle: 3000,
  },
  {
    id: 'cliffs-sunset',
    label: '西崖 · 落日',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        P.start('ride');
        const b = P.layout.pois.bench.position;
        P.setHour(18.35);
        P.teleport(b.x + 25, b.z + 20, -1.9);
      });
    },
    settle: 3000,
  },
  {
    id: 'peak-dawn',
    label: '云顶 · 破晓',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        P.start('ride');
        const p = P.layout.pois.peak.position;
        P.setHour(6.1);
        P.teleport(p.x + 30, p.z + 30, -2.4);
      });
    },
    settle: 3000,
  },
  {
    id: 'bridge',
    label: '石拱桥 · 河谷',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        P.start('ride');
        const b = P.layout.pois.bridge.position;
        P.setHour(11.5);
        P.teleport(b.x - 30, b.z - 26, 0.7);
      });
    },
    settle: 2800,
  },
  {
    id: 'photo',
    label: '摄影模式',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        const v = P.layout.pois.village.position;
        P.setHour(17.7);
        P.teleport(v.x + 26, v.z + 18, -2.1);
        P.enterPhoto(true);
      });
    },
    settle: 2800,
  },
  {
    id: 'map',
    label: '地图 HUD',
    setup: async (page) => {
      await page.evaluate(() => {
        const P = window.__pelican;
        P.enterPhoto(false);
        P.teleport(P.layout.pois.spawn.position.x, P.layout.pois.spawn.position.z, 0.1);
        P.modules.hud?.toggleMinimap?.();
      });
    },
    settle: 2200,
  },
];

async function main() {
  const browserInfo = findBrowser();
  if (!browserInfo) {
    console.error('no Edge/Chrome found');
    process.exit(2);
  }
  await mkdir(outDir, { recursive: true });

  const launchArgs = [
    '--use-angle=d3d11',
    '--enable-unsafe-swiftshader',
    '--disable-lcd-text',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--mute-audio',
    '--allow-file-access-from-files',
  ];

  const browser = await chromium.launch({
    executablePath: browserInfo.path,
    headless: true,
    args: launchArgs,
    timeout: 60000,
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  const consoleWarns = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') consoleErrors.push(text);
    else if (msg.type() === 'warning') consoleWarns.push(text);
  });
  let pageErrorStacks = 0;
  page.on('pageerror', (err) => {
    // keep the first few stacks: they are the actionable ones
    if (pageErrorStacks < 3) consoleErrors.push(`pageerror: ${err.message}\n${err.stack || ''}`);
    else consoleErrors.push(`pageerror: ${err.message}`);
    pageErrorStacks++;
  });

  // preserve=1 keeps the GL drawing buffer so headless capture is reliable
  const url = `${pathToFileURL(path.join(dist, 'index.html')).href}?quality=${quality}&seed=${seed}&preserve=1`;
  console.log(`[shot] ${browserInfo.name} -> ${url}`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  try {
    await page.waitForFunction(
      () => window.__pelican && (window.__pelican.ready === true || !!window.__pelican.error),
      null,
      { timeout: 240000 },
    );
  } catch (err) {
    const diag = await page.evaluate(() => ({
      progress: window.__pelicanProgress || null,
      pelican: window.__pelican ? { ready: window.__pelican.ready, error: window.__pelican.error || null } : null,
    })).catch(() => null);
    console.error('[shot] boot timed out. progress =', JSON.stringify(diag));
    throw err;
  }
  const boot = await page.evaluate(() => ({ ready: window.__pelican.ready, error: window.__pelican.error || null }));
  if (!boot.ready) {
    console.error('[shot] boot failed:', boot.error);
    await page.screenshot({ path: path.join(outDir, 'boot-failed.png') });
    await browser.close();
    process.exit(3);
  }
  console.log(`[shot] world built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // let the title flyover settle
  await page.waitForTimeout(2500);

  const wanted = only ? new Set(only.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) : null;
  const results = [];
  for (const sc of SCENARIOS) {
    if (wanted && !wanted.has(sc.id)) continue;
    await sc.setup(page);
    await page.waitForTimeout(sc.settle);
    const file = path.join(outDir, `${sc.id}.png`);
    // draw-call stats: accumulate exactly one frame (the composer runs several
    // passes, and autoReset normally keeps only the last one)
    const stat = await page.evaluate(() => new Promise((resolve) => {
      const r = window.__pelican.engine.renderer;
      r.info.autoReset = false;
      r.info.reset();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const out = {
          calls: r.info.render.calls,
          triangles: r.info.render.triangles,
          programs: r.info.programs?.length ?? 0,
          geometries: r.info.memory.geometries,
          textures: r.info.memory.textures,
          hour: +window.__pelican.state.hour.toFixed(2),
          mode: window.__pelican.state.camera.mode,
          speed: +window.__pelican.state.player.speed.toFixed(1),
        };
        r.info.autoReset = true;
        resolve(out);
      }));
    }));
    await page.screenshot({ path: file, type: 'png' });
    results.push({ ...sc, file, stat });
    console.log(`[shot] ${sc.id.padEnd(18)} ${sc.label}  draws=${stat.calls} tris=${(stat.triangles / 1000).toFixed(0)}k  mode=${stat.mode}`);
  }

  // measured fps over 2 s
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    function tick() {
      frames++;
      if (performance.now() - start < 2000) requestAnimationFrame(tick);
      else resolve(Math.round((frames * 1000) / (performance.now() - start)));
    }
    requestAnimationFrame(tick);
  }));
  console.log(`[shot] measured ${fps} fps at ${width}x${height} (${quality})`);

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ fps, quality, seed, results, consoleErrors }, null, 2));

  if (consoleErrors.length) {
    console.log(`\n[shot] ${consoleErrors.length} console error(s):`);
    for (const e of consoleErrors.slice(0, 25)) console.log('   ! ' + e);
  } else {
    console.log('[shot] no console errors');
  }
  if (consoleWarns.length) {
    console.log(`[shot] ${consoleWarns.length} warning(s): ` + consoleWarns.slice(0, 6).join(' | '));
  }

  await browser.close();
  console.log(`[shot] saved to ${outDir}`);
  if (consoleErrors.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
