/**
 * events.js - the "director": landmark discovery cards, the ring-road time
 * trial, day/night + weather curation, achievement milestones and the idle
 * cinematic trigger.
 */

import * as THREE from 'three';
import { Rng, clamp01, formatTime, TAU } from '../core/utils.js';
import { GAME } from '../core/settings.js';

export const DISCOVERABLE = [
  ['village', '海风村', 'Seabreeze Village'],
  ['chapel', '白墙礼拜堂', 'White Chapel'],
  ['windmill', '风车山丘', 'Windmill Hill'],
  ['harbor', '旧鱼港', 'Old Harbour'],
  ['lighthouse', '灯塔岬', 'Lighthouse Cape'],
  ['peak', '云顶', 'Cloud Peak'],
  ['observatory', '观星台', 'Observatory'],
  ['lake', '镜湖', 'Mirror Lake'],
  ['lakeIsland', '湖心小岛', 'Lake Islet'],
  ['lakeside', '湖畔栈台', 'Lakeside Deck'],
  ['mill', '水车磨坊', 'Watermill'],
  ['bridge', '石拱桥', 'Stone Bridge'],
  ['waterfall', '银练瀑布', 'Silverfall'],
  ['orchard', '果园坡', 'Orchard Slope'],
  ['vineyard', '葡萄梯田', 'Vineyard Terraces'],
  ['farm', '麦田农庄', 'Wheat Farm'],
  ['camp', '北滩营地', 'North Beach Camp'],
  ['standingStones', '巨石阵', 'Standing Stones'],
  ['treehouse', '树屋', 'Treehouse'],
  ['ruins', '古瞭望塔废墟', 'Old Watchtower'],
  ['arch', '海蚀拱门', 'Sea Arch'],
  ['seaStacks', '海蚀柱群', 'Sea Stacks'],
  ['boardwalk', '南滩木栈道', 'South Boardwalk'],
  ['balloons', '热气球草坪', 'Balloon Meadow'],
  ['bench', '眺望长椅', 'Viewpoint Bench'],
];

export function createEvents(ctx) {
  const { layout, bus } = ctx;
  const rng = new Rng(`events:${layout.seed}`);

  const discoverable = DISCOVERABLE.filter(([id]) => layout.pois[id]);
  const discovered = Object.create(null);
  const progressKey = `pelicanIsland.discovery.${layout.seed}`;
  try {
    const saved = JSON.parse(localStorage.getItem(progressKey));
    if (saved?.v === 1 && Array.isArray(saved.data?.ids)) {
      for (const [id] of discoverable) if (saved.data.ids.includes(id)) discovered[id] = true;
    }
  } catch { /* unavailable or corrupt storage */ }
  let currentState = ctx.state;
  let savePending = false;
  const saveProgress = () => {
    savePending = false;
    try { localStorage.setItem(progressKey, JSON.stringify({ v: 1, data: { ids: Object.keys(discovered) } })); } catch { /* storage denied */ }
  };
  function persist() { if (!savePending) { savePending = true; queueMicrotask(saveProgress); } }
  const discoveryPayloads = new Map(discoverable.map(([id, name, nameEn]) => [id, { id, name, nameEn, position: layout.pois[id].position }]));
  const toastEvent = { title: '', sub: '' };
  const fireworkEvent = { name: 'firework', volume: 1 };
  const musicEvent = { intensity: 0.35 };
  const hourEvent = { hour: 0 };
  let lastHour = -1;
  let discoveryTimer = 0;
  const discoveryEnd = { active: false };
  function endDiscovery() {
    discoveryTimer = 0;
    ctx.hud?.setLetterbox?.(false);
    bus.emit('discovery:end', discoveryEnd);
  }

  // --- race ---
  const RACE_GATES = Math.max(32, Math.ceil(layout.roadLength / 100));
  const gates = [];
  for (let i = 0; i < RACE_GATES; i++) {
    const t = i / RACE_GATES;
    const rp = layout.roadPoint(t, {});
    gates.push({ x: rp.x, y: rp.y, z: rp.z, t });
  }
  const race = { active: false, checkpoint: 0, time: 0, best: null, finished: false, countdown: 0 };
  const minLapTime = layout.roadLength * 0.85 / 25.6;
  let raceDistance = 0;
  const racePrevious = new THREE.Vector3();
  const checkpointEvent = { checkpoint: 0, total: RACE_GATES, time: 0, best: null };
  const finishEvent = { time: 0, best: null, record: false };
  const saveBest = () => {
    try { localStorage.setItem('pelicanIsland.bestLap', String(race.best)); } catch { /* storage denied */ }
  };
  try {
    const stored = localStorage.getItem('pelicanIsland.bestLap');
    if (stored && Number.isFinite(Number(stored)) && Number(stored) >= minLapTime) race.best = Number(stored);
  } catch { /* private mode */ }

  function startRace(state) {
    currentState = state;
    race.active = true;
    race.finished = false;
    race.checkpoint = 0;
    race.time = 0;
    race.countdown = 3.0;
    const p = state.player;
    const start = layout.roadPoint(0, {});
    p.position.set(start.x, start.y + 0.05, start.z);
    p.heading = Math.atan2(start.dirX, start.dirZ);
    p.velocity.set(0, 0, 0);
    racePrevious.copy(p.position);
    raceDistance = 0;
    Object.assign(state.race, race, { total: RACE_GATES });
    p.speed = 0;
    bus.emit('race:start', { total: RACE_GATES });
    bus.emit('sfx', { name: 'discovery', volume: 0.7 });
  }

  function finishRace(state) {
    race.active = false;
    race.finished = true;
    const t = race.time;
    let isRecord = false;
    if (!race.best || t < race.best) {
      race.best = t;
      isRecord = true;
      queueMicrotask(saveBest);
    }
    state.race.active = false;
    state.race.finished = true;
    state.race.finishedTime = t;
    state.race.best = race.best;
    finishEvent.time = t;
    finishEvent.best = race.best;
    finishEvent.record = isRecord;
    bus.emit('race:finish', finishEvent);
    bus.emit('sfx', fireworkEvent);
    ctx.particles?.bursts?.confetti?.(state.player.position.x, state.player.position.y + 3, state.player.position.z);
  }

  const penalizeCrash = () => { if (race.active && race.countdown <= 0) race.time += 3; };
  const penalizeReset = () => { if (race.active && race.countdown <= 0) { race.time += 5; racePrevious.copy(currentState.player.position); } };
  const unsubscribeCrash = bus.on('rider:crash', penalizeCrash);
  const unsubscribeReset = bus.on('player:reset', penalizeReset);

  // --- weather ---
  const weather = { cloudTarget: 0.35, rainTarget: 0, rainTimer: 0, gustPhase: rng.range(0, TAU) };

  // --- milestones ---
  const milestones = {
    firstFeather: false, tenFeathers: false, allFeathers: false,
    peak: false, nightLighthouse: false, village: false, bridge: false, bench: false,
  };
  const completionText = `All ${GAME.featherCount} feathers found`;

  function toast(title, sub) {
    toastEvent.title = title; toastEvent.sub = sub;
    bus.emit('ui:toast', toastEvent);
  }

  let idleTimer = 0;
  let time = 0;
  const discoveredPoint = new THREE.Vector3();

  function update(dt, state) {
    time += dt;
    const p = state.player;
    currentState = state;
    const playerPos = p.position;
    state.discoverableTotal = discoverable.length;
    for (const [id] of discoverable) if (discovered[id]) state.discovered[id] = true;
    if (discoveryTimer > 0) {
      discoveryTimer -= dt;
      if (discoveryTimer <= 0 || state.photoMode) endDiscovery();
    }

    // ---------------- day / night ----------------
    const rate = (24 / GAME.dayLengthSeconds) * (state.timeScale ?? 1);
    state.hour = ((state.hour + dt * rate) % 24 + 24) % 24;

    if (Math.floor(state.hour) !== lastHour) {
      lastHour = Math.floor(state.hour);
      hourEvent.hour = state.hour;
      bus.emit('time:hour', hourEvent);
    }

    // ---------------- weather drift ----------------
    weather.rainTimer -= dt;
    if (weather.rainTimer <= 0) {
      weather.rainTimer = rng.range(150, 420);
      const roll = rng.float();
      weather.cloudTarget = clamp01(0.25 + roll * 0.5);
      weather.rainTarget = roll > 0.86 ? rng.range(0.25, 0.55) : 0;
    }
    state.weather.cloudiness += (weather.cloudTarget - state.weather.cloudiness) * Math.min(1, dt * 0.06);
    state.weather.rain += (weather.rainTarget - state.weather.rain) * Math.min(1, dt * 0.12);
    state.weather.fogBoost = state.weather.rain * 0.6
      + 0.25 * Math.exp(-Math.pow((state.hour - 6.0) / 1.6, 2));

    // wind: slow-gusting direction
    const gust = Math.sin(time * 0.13 + weather.gustPhase) * 0.5 + 0.5;
    state.wind.strength = 0.22 + gust * 0.45;
    state.wind.x = Math.cos(time * 0.02 + weather.gustPhase);
    state.wind.z = Math.sin(time * 0.02 + weather.gustPhase);

    // ---------------- discovery ----------------
    for (const [id] of discoverable) {
      if (!state.started || state.discovered[id]) continue;
      const poi = layout.pois[id];
      if (!poi) continue;
      const r = Math.max(18, Math.min(poi.radius, 60));
      const dx = playerPos.x - poi.position.x;
      const dz = playerPos.z - poi.position.z;
      if (dx * dx + dz * dz < r * r) {
        state.discovered[id] = discovered[id] = true;
        persist();
        discoveryTimer = 7;
        discoveredPoint.copy(poi.position);
        bus.emit('poi:discovered', discoveryPayloads.get(id));
        bus.emit('sfx:music:intensity', musicEvent);

        // only steal the camera mid-ride: never on the title screen, never in
        // photo mode, and only when the player is moving slowly
        if (state.started && !state.paused && !state.photoMode && Math.abs(p.speed) < 4.5) {
          ctx.camera?.flyby(discoveredPoint, 7.0, Math.max(26, Math.min(poi.radius * 1.5, 120)));
        }
      }
    }

    state.discoveryActive = discoveryTimer > 0;

    // ---------------- milestones ----------------
    const collected = state.feathers.collected;
    if (!milestones.firstFeather && collected >= 1) { milestones.firstFeather = true; toast('拾得金色羽毛', 'First Golden Feather'); }
    if (!milestones.tenFeathers && collected >= 10) { milestones.tenFeathers = true; toast('已找到 10 根羽毛', '10 Finders'); bus.emit('sfx', fireworkEvent); }
    if (!milestones.allFeathers && collected >= state.feathers.total) {
      milestones.allFeathers = true;
      toast('收集完成！', completionText);
      bus.emit('sfx', fireworkEvent);
      ctx.particles?.bursts?.confetti?.(playerPos.x, playerPos.y + 4, playerPos.z);
      ctx.particles?.bursts?.sparkle?.(playerPos.x, playerPos.y + 2, playerPos.z, 60);
    }
    if (!milestones.peak && layout.heightAt(playerPos.x, playerPos.z) > 320) { milestones.peak = true; toast('登顶成功', 'Summit reached'); }
    if (!milestones.village) {
      const vp = layout.pois.village.position;
      if (Math.hypot(playerPos.x - vp.x, playerPos.z - vp.z) < 120) { milestones.village = true; toast('抵达海风村', 'Welcome to Seabreeze Village'); }
    }
    if (!milestones.nightLighthouse && state.hour > 20.5) {
      const lp = layout.pois.lighthouse.position;
      if (Math.hypot(playerPos.x - lp.x, playerPos.z - lp.z) < 120) {
        milestones.nightLighthouse = true;
        toast('灯塔之光', 'The light in the night');
      }
    }
    if (!milestones.bridge) {
      const bp = layout.pois.bridge.position;
      if (Math.hypot(playerPos.x - bp.x, playerPos.z - bp.z) < 60) { milestones.bridge = true; toast('跨越石拱桥', 'Stone Bridge crossed'); }
    }
    if (!milestones.bench && state.hour > 17.0 && state.hour < 19.5) {
      const pp = layout.pois.bench.position;
      if (Math.hypot(playerPos.x - pp.x, playerPos.z - pp.z) < 30) {
        milestones.bench = true;
        toast('黄金时刻', 'Golden hour at the west point');
      }
    }

    // Countdown never consumes the starting gate. Gate 1 is the first target;
    // gate 0 must be crossed again after every other gate to close the loop.
    if (race.active) {
      if (race.countdown > 0) {
        race.countdown = Math.max(0, race.countdown - dt);
        racePrevious.copy(playerPos);
      } else {
        race.time += dt;
        const step = racePrevious.distanceTo(playerPos);
        const validStep = step <= 25.6 * dt + 0.5;
        if (validStep && layout.onRoad(playerPos.x, playerPos.z, 8)) raceDistance += step;
        racePrevious.copy(playerPos);
        const gate = gates[(race.checkpoint + 1) % RACE_GATES];
        if (validStep && Math.hypot(playerPos.x - gate.x, playerPos.z - gate.z) < 14) {
          if (race.checkpoint < RACE_GATES - 1 ||
              (race.time >= minLapTime && raceDistance >= layout.roadLength * 0.85)) {
            race.checkpoint++;
            if (race.checkpoint === RACE_GATES) finishRace(state);
            else {
              checkpointEvent.checkpoint = race.checkpoint;
              checkpointEvent.time = race.time;
              checkpointEvent.best = race.best;
              bus.emit('race:checkpoint', checkpointEvent);
            }
          }
        }
      }
    }
    state.race.active = race.active;
    state.race.finished = race.finished;
    state.race.checkpoint = race.checkpoint;
    state.race.total = RACE_GATES;
    state.race.time = race.time;
    state.race.best = race.best;
    state.race.countdown = race.countdown;

    // ---------------- idle cinematic ----------------
    if (Math.abs(p.speed) < 0.35 && !state.photoMode && state.started && !state.paused) {
      idleTimer += dt;
      if (idleTimer > 7 && ctx.camera?.mode === 'chase' && !race.active) {
        idleTimer = -8;
        ctx.camera.flyby(p.position, 7.5, 17);
      }
    } else {
      idleTimer = 0;
    }
  }

  return {
    update,
    dispose() { unsubscribeCrash?.(); unsubscribeReset?.(); endDiscovery(); },
    discoverableTotal: discoverable.length,
    resetProgress() {
      for (const [id] of discoverable) { delete discovered[id]; if (currentState) delete currentState.discovered[id]; }
      for (const key of Object.keys(milestones)) milestones[key] = false;
      endDiscovery();
      saveProgress();
    },
    startRace,
    stopRace() { race.active = false; },
    race,
    gates,
    formatTime,
  };
}
