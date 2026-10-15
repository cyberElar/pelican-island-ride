# 提鹅鹏 · 单车环岛 · A Pelican's Island Ride

> A cinematic three.js cycling showcase: a pelican rides a vintage cruiser
> around a large, richly detailed island.
>
> **Everything is procedural.** Terrain, buildings, trees, creatures, textures,
> music and sound effects are all generated in code at runtime — no image files,
> no audio files, no glTF, no CDN, no network access.

**▶ Play it:** https://cyberelar.github.io/pelican-island-ride/
(or clone the repo and double-click `index.html` — it runs straight from `file://`)

[中文说明 · Chinese README](README.zh-CN.md)

![riding around golden hour](screenshots/ride.jpg)

![sunset at the west cliffs](screenshots/sunset.jpg)

---

## What's in the box

**The island** — 6 km x 6 km terrain: an 11 km ring road with dashes, edge lines,
gravel shoulders, lamp posts, guard rails and distance markers; beaches, cliffs,
alpine highlands, a lake with an islet, a river gorge crossed by a two-arch stone
bridge, broadleaf forest, pine woods, meadows, farm terraces.

**21 hand-built landmarks** — lighthouse (rotating beam at night), Seabreeze
Village (16 houses, market square, fountain, laundry lines), fishing harbour with
bobbing boats, windmill, watermill with turning wheel, standing stones, treehouse,
watchtower ruins, sea arch and sea stacks, lake pavilion, hot-air balloons
(tethered, drifting), summit observatory, chapel with graveyard, start/finish
gates, shipwreck, waterfall, rope swing, cliff viewpoint.

**Living island** — 234 creatures: seagulls, ducks, herons, rabbits, deer, crabs,
butterflies, bees, fireflies at night, jumping fish, a whale offshore, dolphins in
the bay. Six particle systems: pollen, falling leaves, chimney smoke, campfire
embers, waterfall mist, sea spray.

**Gameplay** — arcade bicycle physics (slope gravity, surface-dependent friction,
lean, jumps, crashes), 40 hidden golden feathers, 28 discoverable landmarks with
letterboxed name cards, an 8-checkpoint ring-road time trial with a stored best
lap, photo mode with depth of field, day/night cycle, weather, minimap,
speedometer, compass.

**The look** — custom sky shader (sun, moon, stars, milky way, two cloud layers),
Gerstner-wave ocean with shore foam, four-way blended terrain splat, PMREM
image-based lighting, and a post chain: bloom, screen-space god rays, split-tone
grade, vignette, chromatic aberration, film grain, SMAA, and photo-mode DoF.

**The sound** — fully synthesised WebAudio: wind, waves, forest birds, crickets,
seagulls, a harbour bell, tyre roll that changes with the road surface, chain
whirr, bell, splashes, crash, plus generative ambient music that follows the time
of day and your speed.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | pedal |
| `S` / `↓` | brake |
| `A` `D` / `←` `→` | steer |
| `Shift` | boost |
| `Space` | hard brake |
| `C` | camera: chase → first person → cinematic |
| `P` | photo mode (wheel = zoom, `F` = grid) |
| `M` | minimap |
| `B` | bell |
| `R` | return to the nearest road |
| `Enter` | start the ring-road time trial |
| `T` | time of day: dawn / noon / sunset / night / cycle |
| `N` | mute · `Esc` pause |

Gamepad: left stick steers, triggers pedal and brake. `?seed=1234` generates a
different island, `?quality=low|medium|high|ultra` sets the preset manually.

## Under the hood

- **three.js r186.1** (WebGL2), bundled with esbuild into a single IIFE so the
  game runs from `file://`.
- 16 modules in a small registry: sky, terrain, environment, ocean, vegetation,
  props, landmarks, animals, particles, weather, camera, controls, rider,
  collectibles, events, audio. Each one is a factory returning
  `{ group, update(dt, state), setQuality? }`.
- 484 geometries, 195 procedural textures, ~75 shader programs, ~1 300–2 000
  draw calls and 3–4.7 M triangles per frame at the *high* preset (shadows and
  post-processing included).
- Full island build takes ~4–11 s on a desktop CPU, then streams at interactive
  frame rates; the loading screen reports progress.

## Development

```bash
npm install          # three + esbuild + playwright-core (dev only)
npm run build        # -> dist/game.js (minified)
npm run build:publish# also refresh the playable root copies (game.js, styles.css)
npm test             # 8 module test suites, all headless in Node
npm run serve        # dev server at http://localhost:5577/
npm run shots:readme # regenerate screenshots/ from the root build
```

The deployable site is the repository root: `index.html` + `game.js` +
`styles.css`. `game.js` and `styles.css` are built artefacts committed on
purpose so GitHub Pages can serve the game without a CI step.

## Repository layout

```
index.html          entry point (also the GitHub Pages index)
game.js             built bundle (three.js + all game code)
styles.css          built UI stylesheet (source: src/ui/styles.css)
src/
  core/             engine, settings, input, procedural textures, audio, utils
  world/            layout (island math), terrain+roads, sky, ocean, environment,
                    vegetation, props, landmarks, animals, particles, weather
  character/        pelican, bicycle, rider rig
  gameplay/         controls, camera director, collectibles, events
  fx/               post-processing chain
  ui/               HUD, menus, stylesheet
tools/              build, static server, screenshot harness, module test suite
docs/SPEC.md        the technical spec the modules were built against
screenshots/        README images (captured from the root build)
```

## License

MIT — see [LICENSE](LICENSE). Have fun, and ring the bell. 🔔
