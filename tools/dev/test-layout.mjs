/**
 * Dev test for world/layout.js - runs headless in Node (three.js core works
 * without a DOM). Validates the island math before anything renders.
 */
import { createLayout } from '../../src/world/layout.js';

const t0 = performance.now();
const layout = createLayout(20261014);
const buildMs = performance.now() - t0;

console.log(`--- layout built in ${buildMs.toFixed(1)} ms ---`);
console.log('road length', layout.roadLength.toFixed(0), 'm');

const probes = [
  ['center', 0, 0],
  ['spawn', layout.pois.spawn.position.x, layout.pois.spawn.position.z],
  ['peak', layout.pois.peak.position.x, layout.pois.peak.position.z],
  ['lake center', layout.pois.lake.position.x, layout.pois.lake.position.z],
  ['village', layout.pois.village.position.x, layout.pois.village.position.z],
  ['harbor', layout.pois.harbor.position.x, layout.pois.harbor.position.z],
  ['lighthouse', layout.pois.lighthouse.position.x, layout.pois.lighthouse.position.z],
  ['waterfall', layout.pois.waterfall.position.x, layout.pois.waterfall.position.z],
  ['bridge', layout.pois.bridge.position.x, layout.pois.bridge.position.z],
  ['arch', layout.pois.arch.position.x, layout.pois.arch.position.z],
  ['offshore S', 0, 2900],
  ['offshore E', 2900, 0],
];
for (const [name, x, z] of probes) {
  const h = layout.heightAt(x, z);
  console.log(
    `${name.padEnd(14)} (${x.toFixed(0)}, ${z.toFixed(0)})  h=${h.toFixed(1).padStart(8)}` +
    `  slope=${layout.slopeAt(x, z).toFixed(3)}  biome=${layout.biomeAt(x, z)}` +
    `  roadDist=${layout.roadDistance(x, z).toFixed(1)}  riverDist=${layout.riverDistance(x, z).toFixed(1)}`
  );
}

// --- road quality ---
{
  const pts = layout.roadSamples;
  const n = pts.length / 3;
  let maxGrade = 0, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j * 3] - pts[i * 3];
    const dz = pts[j * 3 + 2] - pts[i * 3 + 2];
    const dy = pts[j * 3 + 1] - pts[i * 3 + 1];
    const d = Math.hypot(dx, dz) || 1e-6;
    maxGrade = Math.max(maxGrade, Math.abs(dy / d));
    minY = Math.min(minY, pts[i * 3 + 1]);
    maxY = Math.max(maxY, pts[i * 3 + 1]);
  }
  console.log(`road: y range ${minY.toFixed(1)}..${maxY.toFixed(1)}  max grade ${(maxGrade * 100).toFixed(1)}%`);
  if (maxGrade > 0.20) throw new Error('Road grade too steep: ' + maxGrade);

  // terrain under the road should match the road surface closely
  let maxErr = 0;
  for (let i = 0; i < n; i += 7) {
    const x = pts[i * 3], z = pts[i * 3 + 2];
    const dy = Math.abs(layout.heightAt(x, z) - pts[i * 3 + 1]);
    maxErr = Math.max(maxErr, dy);
  }
  console.log(`road<->terrain max mismatch: ${maxErr.toFixed(2)} m (bridge zones expected large)`);
}

// --- heights ---
{
  const grid = layout.sampleHeightGrid(200);
  let mn = Infinity, mx = -Infinity, land = 0;
  for (let i = 0; i < grid.length; i++) {
    mn = Math.min(mn, grid[i]); mx = Math.max(mx, grid[i]);
    if (grid[i] > 0) land++;
  }
  console.log(`grid: min ${mn.toFixed(1)}  max ${mx.toFixed(1)}  land fraction ${(land / grid.length * 100).toFixed(1)}%`);
  if (mx < 250) throw new Error('peak too low');
  if (mn > -40) throw new Error('sea too shallow');
}

// --- lake / river sanity ---
{
  const lh = layout.heightAt(layout.pois.lake.position.x, layout.pois.lake.position.z);
  console.log('lake bed height', lh.toFixed(2), 'water y', layout.lakeY);
  if (!(lh < layout.lakeY - 3)) throw new Error('lake is not below its surface');
  const bh = layout.heightAt(layout.pois.bridge.position.x, layout.pois.bridge.position.z);
  console.log('terrain under bridge', bh.toFixed(2), 'deck y', layout.pois.bridge.position.y.toFixed(2));
  if (!(layout.pois.bridge.position.y - bh > 5)) throw new Error('no gorge under the bridge');
}

// --- placement guard ---
{
  const spawn = layout.pois.spawn.position;
  console.log('isClear at spawn (should be false, on road):', layout.isClear(spawn.x, spawn.z));
  const rng = { float: () => 0.5, range: (a, b) => (a + b) / 2 };
  const spot = layout.randomSpotNear('windmill', 60, 140, { float: Math.random, range: (a, b) => a + Math.random() * (b - a) }, { poi: 0 });
  console.log('random spot near windmill:', spot);
  if (layout.isClear(0, 2900)) throw new Error('offshore was clear!');
  void rng;
}

// --- query throughput ---
{
  const t1 = performance.now();
  let acc = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const a = (i * 0.618033988) % 1;
    acc += layout.heightAt(Math.cos(a * 6.283) * 1800, Math.sin(a * 6.283) * 1800);
  }
  const ms = performance.now() - t1;
  console.log(`heightAt: ${(ms / N * 1000).toFixed(2)} us/call (${N} calls in ${ms.toFixed(0)} ms)  checksum ${acc.toFixed(0)}`);
}

console.log('ALL LAYOUT TESTS PASSED');
