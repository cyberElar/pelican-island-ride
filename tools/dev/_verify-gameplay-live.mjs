import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--mute-audio', '--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => localStorage.clear());
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href + '?quality=low');
  await page.waitForFunction(() => window.__pelican?.ready, null, { timeout: 240000 });
  const fresh = await page.evaluate(() => ({ keys: Object.keys(window.__pelican.state.discovered).length, hud: document.getElementById('pi-hud-discovered').textContent }));
  assert.equal(fresh.keys, 0); assert.match(fresh.hud, /0 \/ 25/);
  console.log('FRESH', JSON.stringify(fresh));
  // Full speed at an isolated point, away from every discovery radius.
  const fast = await page.evaluate(() => {
    const P = window.__pelican, s = P.state;
    P.start('ride'); P.teleport(2800, 2800); s.player.speed = 25.6;
    P.modules.events.update(.1, s);
    return { speed: s.player.speed, discovered: Object.keys(s.discovered).length, total: s.discoverableTotal };
  });
  await page.waitForTimeout(200);
  assert.equal(fast.discovered, 0);
  console.log('FULL_SPEED_NO_POI', JSON.stringify(fast));
  await page.evaluate(() => { const P = window.__pelican; P.modules.controls.spawn(P.state); });
  const read = () => page.evaluate(() => { const P = window.__pelican, s = P.state; return { speedMps: Number(s.player.speed.toFixed(3)), checkpoint: s.race.checkpoint, total: s.race.total, countdown: s.race.countdown, raceSeconds: s.race.time, active: s.race.active, finished: !!s.race.finished, distance: Number(s.player.distanceTravelled.toFixed(2)) }; });
  await page.keyboard.down('w'); await page.waitForTimeout(10000);
  console.log('RIDE_10S', JSON.stringify(await read()));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const countdown = await read(); assert.equal(countdown.speedMps, 0); assert.equal(countdown.checkpoint, 0);
  console.log('COUNTDOWN_1S', JSON.stringify(countdown));
  await page.waitForTimeout(4000); await page.keyboard.up('w');
  const after = await read(); assert.equal(after.finished, false);
  console.log('RACE_RIDE_5S', JSON.stringify(after));
  const abuse = await page.evaluate(() => {
    const P = window.__pelican, e = P.modules.events, s = P.state;
    e.startRace(s); e.update(3.01, s);
    for (const g of [...e.gates.slice(1), e.gates[0]]) { s.player.position.set(g.x, g.y, g.z); e.update(1.93 / e.gates.length, s); }
    return { seconds: s.race.time, checkpoint: s.race.checkpoint, total: s.race.total, finished: s.race.finished };
  });
  assert.equal(abuse.finished, false); console.log('TELEPORT_1_93S', JSON.stringify(abuse));
  const valid = await page.evaluate(() => {
    const P = window.__pelican, e = P.modules.events, s = P.state, point = {};
    e.startRace(s); e.update(3.01, s);
    for (let distance = 0; distance <= P.layout.roadLength + 2; distance += 1) {
      P.layout.roadPoint(distance / P.layout.roadLength % 1, point);
      s.player.position.set(point.x, point.y, point.z); e.update(.05, s);
      if (s.race.finished) break;
    }
    return { seconds: s.race.time, checkpoint: s.race.checkpoint, total: s.race.total, finished: s.race.finished, active: s.race.active };
  });
  assert.equal(valid.finished, true); assert.equal(valid.active, false); console.log('ORDERED_LAP', JSON.stringify(valid));
  await page.waitForTimeout(8500);
  console.log('LETTERBOX', await page.locator('#pi-letterbox').getAttribute('class'));
  assert.equal(await page.locator('#pi-letterbox').evaluate(e => e.classList.contains('is-on')), false);
  assert.deepEqual(errors, []); console.log('CONSOLE_ERRORS', errors.length);
} finally { await browser.close(); }
