# Pelican Island Ride - Technical Specification (frozen contracts)

> A cinematic three.js cycling showcase: a pelican (提鹅鹏) riding a vintage
> cruiser bicycle around a large, richly detailed island. No external asset
> files, everything is generated procedurally in code. Runs by double-clicking
> `index.html` (file:// compatible, single bundled JS).

This document is the interface contract between modules. Do not change an
interface without updating this file, and keep every module allocation-free in
its `update()` loop.

---

## 1. Tech baseline

- three.js **r186.1** (installed at `node_modules/three`, import as `three` and
  `three/addons/...`).
- ES modules, bundled by **esbuild 0.28** into one IIFE (`dist/game.js`).
- WebGL2 renderer, physically correct lighting (r186 defaults: NO
  `useLegacyLights`). Directional sun intensity ~2.5-4, hemisphere ~0.4-0.8.
- Colors: `THREE.ColorManagement` on. Hex colors are sRGB values.
- Tone mapping ACESFilmic, exposure 1.0-1.15 (post `OutputPass` owns the final
  tone map/color space when the composer is active).
- **No network access at runtime. No external image/audio files.**
  Textures come from `core/textures.js` (procedural canvas), audio from
  `core/audio.js` (WebAudio synthesis).
- Units: meters. Y-up. Water level `y = 0`. Island centered at `(0, 0)`.
  World extent: `[-3000, +3000]` in x and z (`WORLD_SIZE = 6000`).

## 2. Art direction

"High-budget animated feature": warm golden-hour default (17:10), long soft
shadows, teal ocean, cream sand, saturated but tasteful greens. Strong
silhouettes, beveled/detailed geometry, no untextured grey primitives in the
player's field of view within 400 m of the road.

Palette anchors:

| thing | color |
| --- | --- |
| sky zenith / horizon | `#3f7fd0` / `#f7c78a` |
| sunset band | `#ff9d6b` |
| ocean shallow / deep / foam | `#4ec3c9` / `#0b4f6c` / `#f2fbfb` |
| grass green / dry | `#6f9e4a` / `#c9b26a` |
| rock / cliff | `#8a8f96` / `#a08c78` |
| sand dry / wet | `#e8d5a8` / `#bfae83` |
| wood / painted accents | `#7a5230` / teal `#1f6f78`, cream `#f2e8d5` |
| pelican body / beak / pouch / wingtip | `#f5f1e8` / `#f2a33c` / `#e8845f` / `#4a4d52` |
| flowers | poppy `#e0523f`, cornflower `#5b7fd4`, mustard `#e8b64c`, white |

Materials: `roughness` 0.55-1.0, `metalness` 0 except real metal (bike chrome,
bells, lamps). Reuse `MeshStandardMaterial`/`MeshPhysicalMaterial`; the same
material instance must be shared across instances of the same object type.

## 3. Project layout

```
src/
  core/        utils.js textures.js engine.js settings.js input.js audio.js
  world/       layout.js terrain.js ocean.js sky.js vegetation.js props.js
               landmarks.js animals.js particles.js environment.js
  character/   pelican.js bicycle.js rider.js
  gameplay/    controls.js camera.js collectibles.js events.js
  fx/          post.js weather.js
  ui/          hud.js menus.js styles.css
  main.js
tools/         build.mjs screenshot.mjs serve.mjs
dist/          game.js (built), index.html copy
```

## 4. Module contract

Every world/feature module exports a factory:

```js
export function createXxx(ctx) -> {
  group: THREE.Group,        // or several groups; caller adds to scene
  update(dt, state): void,   // required; allocation-free
  setQuality(level): void,   // optional
  dispose(): void            // optional
}
```

`ctx` = `{ engine, layout, textures, rng, quality, bus, THREE }` where
`textures` is the texture library object from `core/textures.js`.
Modules **must not** add their own `group` to the scene, create a renderer, or
create `<script>` tags. They may create `CanvasTexture`s via the texture
library. Modules must never import `main.js`.

### 4.1 `core/engine.js`

```js
createEngine(canvas, { quality }) -> {
  renderer, scene, camera, clock, bus,        // bus = EventBus (core/utils)
  world: THREE.Group,                          // static world root (y=0)
  sizes: { width, height, pixelRatio, scale },
  quality: string, preset: {...},
  setQuality(level), setPost(post),            // post: { render(dt) }
  render(dt), onResize(fn), addUpdate(fn)
}
```

### 4.2 `core/settings.js`

Exports `QUALITY_PRESETS`, `detectQuality()`, `GAME` constants
(`worldSize`, `waterLevel`, `roadWidth`, `dayLengthSeconds`, ...).

### 4.3 `core/input.js`

```js
createInput(canvas) -> {
  axes: { steer: -1..1, throttle: 0..1, brake: 0..1, pitch, yaw },
  held(action): boolean,        // 'boost' 'brakeHard' 'lookBack' 'map'
  pressed(action): boolean,     // consumed once per frame - call in update order!
  endFrame(): void,             // clears pressed set - main.js calls this
  setTouchAxes({steer, throttle, brake}) / touchButton(action, down),
  pointer: { x: -1..1, y: -1..1, dx, dy, locked },
  enabled: boolean
}
```

Actions: `camera`(C), `photo`(P), `map`(M), `help`(H), `time`(T), `bell`(B),
`boost`(Shift), `brakeHard`(Space), `reset`(R), `sound`(N), `pause`(Esc),
`race`(Enter), `ui`(1/2/3 selects menus), `lookBack`(E).

### 4.4 `core/textures.js`

```js
createTextureLibrary(quality) -> TEX
```

`TEX` is a cached factory object. **Every method returns a surface object**
`{ map, normalMap, roughnessMap, alphaMap?, color? }` of `THREE.Texture`
(except sprite helpers which return a single `CanvasTexture`).

Methods (all take an optional `opts` object with `{ seed, repeat, size }`):

`TEX.grass()`, `TEX.dryGrass()`, `TEX.sand()`, `TEX.rock()`, `TEX.cliff()`,
`TEX.snow()`, `TEX.dirt()`, `TEX.gravel()`, `TEX.asphalt()`, `TEX.cobble()`,
`TEX.stoneWall()`, `TEX.plaster(colorHex)`, `TEX.roofTile(colorHex)`,
`TEX.terracotta()`, `TEX.wood({ tone })`, `TEX.planks()`, `TEX.bark()`,
`TEX.logEnd()`, `TEX.leafCanopy()`, `TEX.thatch()`, `TEX.hay()`,
`TEX.metal({ color, rough })`, `TEX.paintedMetal(colorHex)`,
`TEX.fabric({ color, stripeColor })`, `TEX.leather()`, `TEX.rope()`,
`TEX.terrainSplat()` (returns the 4 detail textures used by terrain),
`TEX.waterNormal()`, `TEX.foam()`, `TEX.cloudSprite()`, `TEX.smokeSprite()`,
`TEX.starSprite()`, `TEX.sparkSprite()`, `TEX.leafSprite(kind)`,
`TEX.grassBladeSprite()`, `TEX.flowerSprite(kind)`,
`TEX.featherSprite()`, `TEX.window()` (emissive glass), `TEX.poster()`,
`TEX.wicker()`, `TEX.kiteFabric()`.

Helper exports: `TEX.canvas(size)` (new canvas), `TEX.noiseCanvas(opts)`,
`TEX.normalFromHeight(canvas, strength)`, `TEX.texture(canvas, opts)`,
`TEX.disposeAll()`.

### 4.5 `world/layout.js` - THE ISLAND (frozen API)

```js
createLayout(seed) -> {
  seed, WORLD_SIZE: 6000, HALF: 3000, WATER_LEVEL: 0,

  heightAt(x, z): number,           // terrain height in meters (lake water handled separately)
  slopeAt(x, z): number,            // 0 flat .. 1 vertical (finite difference, ~6 m)
  normalAt(x, z, out): Vector3,     // optional, out is THREE.Vector3
  biomeAt(x, z): string,            // 'ocean'|'beach'|'meadow'|'forest'|'rock'|'snow'|'lake'|'river'|'road'
  splatAt(x, z, out): { grass, sand, rock, snow, dirt },  // weights, sum 1 (out reused)

  isLand(x, z): boolean,            // height > 0.3
  isWater(x, z): boolean,
  waterDepth(x, z): number,         // > 0 in lake/sea
  lakeY: number,                    // lake surface height (e.g. 22)
  lake: { center: Vector3, radius: number, waterY: number },
  riverCurve,                       // THREE.CatmullRomCurve3, open, y = terrain
  riverDistance(x, z): number,      // distance to river centerline

  roadCurve,                        // THREE.CatmullRomCurve3 closed, y = terrain, ~4.6 km
  roadLength: number,
  roadPoint(t, out): { x, y, z, dirX, dirZ },   // t in 0..1, out reused (plain object)
  roadDistance(x, z): number,       // distance to ring road centerline (fast, grid accel)
  onRoad(x, z, margin = 0): boolean,
  roadWidth: 6.5,
  spurs: {                          // additional paths, same API as roadPoint
    lighthouse: { curve, length, point(t, out), distance(x, z) },
    village:    {...},
    summit:     {...},
    mill:       {...},
  },

  pois: {                           // fixed landmark slots - use these positions!
    spawn:      { id, position: Vector3, radius, heading },
    village:    { ... }, lighthouse, windmill, harbor, lakeIsland, mill,
    peak, cairn, forest, orchard, vineyard, farm, camp, standingStones,
    treehouse, ruins, arch, seaStacks, bridge, boardwalk, balloons, bench,
    observatory, waterfall, pool, terrace, chapel, gates,
  },
  poi(id): object,                  // throws if id unknown

  isClear(x, z, opts = {}): boolean,   // { road: 8, poi: 0, river: 6, minHeight: 1, maxSlope: 0.45, water: false }
  sampleHeightGrid(size): Float32Array,   // row-major, index = z * size + x, covers [-HALF, HALF]
}
```

Deterministic for a given seed. `heightAt` must be fast (~2 µs) - it is called
by physics every frame and by placement loops.

Island anatomy (design intent, approximate):

- Coastline radius ~2300 m with an irregular outline (bays, NE peninsula,
  SE harbor bay, west cliffs).
- Central highlands peak ~340 m in the north-center, secondary ridge west.
- Ring road circles the island at r ≈ 1350-1700 m, elevation 20-130 m,
  one switchback section on the west cliffs, a bridge over the river gorge.
- A lake (~340 m across) with a small island, at ~( -520, 180 ), surface
  `lakeY ≈ 22`. A river flows from the lake south-east to the sea, cutting a
  gorge; the ring road crosses it on a stone arch bridge.
- Beaches on the south and east; cliffs on the west; pine forests north-east;
  broadleaf forests west; meadows everywhere else.

### 4.6 `world/terrain.js`

`createTerrain(ctx) -> { group, update(dt, state), heightTexture }` - the
heightfield mesh with 4-way splat material (uses `splatAt`), plus the shared
`heightTexture` (DataTexture, 1024², for ocean depth/foam + minimap).

### 4.7 `world/ocean.js`

`createOcean(ctx) -> { group, update(dt, state), setQuality, splash(x, z, size) }`.
Gerstner waves + shore foam from the terrain height texture + sky-reflection
approximation + sun glitter. Extends to r=12000 with fog.

### 4.8 `world/sky.js`

`createSky(ctx) -> { group, update(dt, state), sunDir: Vector3, moonDir, hourToSun(h) }`.
Custom shader dome (Preetham-ish), cloud layer, stars+moon at night. Owns
`state.sun`, `state.moon`, `state.weather.cloudiness`.

### 4.9 `world/vegetation.js`

`createVegetation(ctx) -> { group, update(dt, state), setQuality }`.
Instanced trees (pine/broadleaf/palm/cypress/birch), bushes, rock clusters,
grass tufts (near-player GPU wind), flowers, reeds. Uses `layout.isClear` +
`layout.pois.forest` etc. for placement. Wind uniforms shared in
`vegetation.sharedUniforms`.

### 4.10 `world/props.js`

`createProps(ctx) -> { group, update(dt, state), colliders }`.
Village buildings (walls+roof separate materials, chimneys, windows with warm
emissive glass, doors, signs), harbor docks/boats/crates/barrels/fishnets,
bridges, fences and dry-stone walls along the road, lamp posts with emissive
globes placed along `layout.roadCurve`, benches, signposts, market stalls,
windmill (turning blades), watermill (turning wheel), tents, campfire,
hammocks, hay bales, orchard trees, vineyard rows, field crops.
`colliders` is `[{x, z, r}]` used by `gameplay/controls.js`.

### 4.11 `world/landmarks.js`

`createLandmarks(ctx) -> { group, update(dt, state) }`.
Lighthouse (rotating beam at night), standing stones, treehouse, watchtower
ruins, sea arch, sea stacks, lake island pavilion + rowboat, hot-air balloons
(tethered, bobbing), summit cairn + observatory + telescope, chapel,
scenic viewpoint gates, big wooden sign "提鹅鹏 · 单车环岛" at spawn.

### 4.12 `world/animals.js`

`createAnimals(ctx) -> { group, update(dt, state) }`.
Seagulls (flocking), ducks (lake, wake ripples), rabbits/env-hopping, deer
(forest, startled), crabs (beach), fish jumps (rings), butterflies (day,
flowers), fireflies (night, near player), bees, a whale that spouts offshore,
dolphins arcing in the bay. Each species: LOD + hard cap by quality.

### 4.13 `world/particles.js`

`createParticles(ctx) -> { group, update(dt, state), bursts: { dust(x,y,z,dir,strength), splashWater(x,y,z,strength), leaves(x,y,z), sparkle(x,y,z), confetti(x,y,z) } }`.
Ambient: pollen motes in sunlight, drifting leaves, sea spray near cliffs,
chimney smoke wisps (from props' chimneys via registered emitters).

### 4.14 `world/environment.js`

`createEnvironment(ctx) -> { update(dt, state), setHour(h), sun: DirectionalLight, hemi, fog }`.
Sole owner of the sun/hemisphere lights, shadow camera (follows player,
`CSM`-lite: 90 m box), scene fog (FogExp2 tuned per hour), PMREM environment
regeneration (throttled to every ~45 game-minutes).

### 4.15 `character/pelican.js`, `character/bicycle.js`, `character/rider.js`

Pelican: ~8 k tris procedural body with beak+pouch, folded wings
(feather-card edges), tail, webbed feet, expressive eyes; rig = nested groups
(`pelican.root/hip/spine/neck/head/beak/lids/wingL/wingR/footL/footR`),
animations: idle breathing/blink/look-around, pedal pump, coast, lean,
crash flap. Bicycle: ~12 k tris cruiser with chrome fenders, spoked wheels,
crank+chain+pedals (kinematic `wheelAngle`, `crankAngle` driven by speed),
basket with bread+flowers, headlamp (emissive, spotlight-free), bell, kickstand,
pennant flag that flutters.
Rider combines them: `createRider(ctx) -> { root, update(dt, state), parts }`,
`root.position/rotation` written by controls; rider reads
`state.player.{speed, lean, steer, grounded, wheelSpin, crash, boost}`.

### 4.16 `gameplay/controls.js`

`createControls(ctx) -> { update(dt, state), spawn(), reset() }` - arcade bike
physics: acceleration/braking/steering with speed-dependent turn radius, lean,
slope gravity, off-road friction by surface, water/beach limits, collisions
vs `props.colliders` + landmark colliders, jump over small bumps at speed,
bell/boost hooks. Owns `state.player` core fields.

### 4.17 `gameplay/camera.js`

`createCameraController(ctx) -> { update(dt, state), mode, setMode(m) }`.
Modes: `chase` (spring arm, speed FOV, look-ahead, wall avoidance),
`cinematic` (auto director: slow orbit when idle, POI flybys),
`firstPerson` (handlebar), `photo` (free-fly + DOF focus), `tour`
(spline flyover, used by the title screen).

### 4.18 `gameplay/collectibles.js`

`createCollectibles(ctx) -> { group, update(dt, state), total }`.
40 glowing golden feathers scattered via `layout.isClear` near POIs and along
the road; bob+spin+shimmer, pickup radius, resupply sparkles, sound via bus.

### 4.19 `gameplay/events.js`

`createEvents(ctx) -> { update(dt, state) }`. Discovery triggers (enter POI
radius → letterbox name card + sound), the ring-road time trial (gates at
spawn; `race` state machine with best time in localStorage), day-night curator
that keeps `state.weather` interesting, achievements toast hookups.

### 4.20 `fx/post.js`

`createPost(engine, ctx) -> { render(dt), setQuality, setMode(name) }`.
Passes: bloom (subtle, threshold ~0.85), god-rays (screen-space radial from
sun, gated by sun visibility), color grade (film curve + teal-shadow warm-
highlight split tone + saturation), vignette, chromatic aberration (edges),
film grain (animated), SMAA, optional DOF in photo mode. Order:
Render → GodRays → Bloom → Grade/Grain/Vignette → Output → SMAA.

### 4.21 `fx/weather.js`

`createWeather(ctx) -> { update(dt, state), setRain(v) }`. Sea mist banks,
low fog wisps in valleys at 5-8 am, heat shimmer off asphalt at 13-15h,
optional light rain with puddle darkening. Cheap billboard systems.

### 4.22 `ui/hud.js`, `ui/menus.js`

HUD: speedometer (analog-ish arc + digital km/h), collected feathers counter,
compass strip, minimap (canvas, terrain height texture + road + POI icons +
player arrow; toggled by M), discovery name cards, race timer, photo-mode
overlay (grid, focal length), toasts, vignette-safe letterbox for
cinematic moments, keyboard hints. Menus: title screen with poster art
(gradient + big type), start/free-ride/photo/settings, settings (quality,
volume, time of day, language, comfort & accessibility), pause menu, and a
reset-progress entry. Touch devices get a virtual pad (`ui/touch.js`) driving
the same input API. All DOM/CSS, no images. Chinese-first typography with
English accents.

### 4.23 `core/audio.js`

`createAudio(ctx) -> { init() (must be called after first user gesture),
update(dt, state), setMasterVolume(v), setMusicVolume(v), setMuted(b),
sfx(name, opts), setSurface(surface), setWind(strength), setHour(h) }`.
WebAudio only, synthesized: ambient wind/waves/forest birds/crickets/night
insects, generative ambient music (pads + pentatonic plucks, evolves with
time of day), bicycle bell/chain/tire roll (speed-driven), water splash,
bird calls, pickup chime, discovery swell, thunder (rare), harbour bell.
Listens to `ctx.bus` for `sfx` events: `bus.emit('sfx', { name, volume })`.

## 5. Global state (owned by `main.js`)

```js
state = {
  t: 0, dt: 0, hour: 17.1, dayLength: 900, timeScale: 1,
  quality: 'high', paused: false, photoMode: false, started: false,
  player: { position: Vector3, velocity: Vector3, heading, speed, lean,
            steer, wheelSpin, onRoad, surface, grounded, inWater, boost,
            crash, distanceTravelled },
  camera: { position: Vector3, quaternion: Quaternion, mode: 'chase', fov },
  feathers: { collected: 0, total: 40 },
  discovered: Object.create(null),
  race: { active: false, checkpoint: 0, time: 0, best: null },
  wind: { x: 0.7, z: 0.5, strength: 0.4, gust: 0 },
  weather: { rain: 0, cloudiness: 0.35, fogBoost: 0 },
  sun: { dir: Vector3, color: Color, intensity: 3 },   // written by sky/environment
  moon: { dir: Vector3, intensity: 0.2 },
  events: [],   // ui toasts consume+clear
}
```

Bus events: `sfx`, `feather:collected`, `poi:discovered`, `race:*`,
`time:hour`, `quality:changed`, `sfx:music:intensity`, `camera:mode`,
`photo:enter`, `photo:exit`, `player:reset`, `rider:crash`.

## 6. Performance rules

- Target: 60 fps at "high" on a mid-range dGPU (RTX 2060-class), 30+ on
  integrated; presets low/medium/high/ultra.
- No `new THREE.*` inside `update()`; use module-level scratch objects.
- Instanced everything repeated (>10 copies). Share geometries/materials.
- Total draw calls < 1100 (high). Trees/grass use one InstancedMesh per
  species; grass is a single InstancedMesh with shader-side distance fade.
- Shadow casters: only large statics near the player + rider + bike +
  animals that are close; foliage casts shadows at medium+ only, grass never.
- `update()` budget: each module < 1.5 ms on mid hardware.

## 7. Build & verification

- `npm run build` → `dist/game.js` (esbuild bundle) + copies `index.html`,
  `src/ui/styles.css` (or inlines CSS).
- `npm run shot` → headless Edge/Chrome screenshot harness (tools/screenshot.mjs)
  capturing: title, chase view day, chase view sunset, night at lighthouse,
  photo mode, minimap open. Writes PNGs to `work/shots/`.
- The game must run from `file://` with zero console errors and zero network
  requests.

## 8. Determinism

Single seed from `?seed=N` (default 20261014). Every module derives its own
RNG: `new Rng('vegetation:' + layout.seed)` etc. Same seed → same island.
