# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Community health files: contribution guide, code of conduct, security policy,
  issue forms and a pull-request template.
- CI pipeline: module test suites on Node 22 and 24, a check that the committed
  bundle matches `src/`, a bundle size budget, and guards for the project's two
  invariants (no runtime network access, no external asset files).
- Touch controls: a virtual pad (`src/ui/touch.js`) appears on coarse-pointer
  devices and drives the same input API as the keyboard and gamepad.
- Comfort & accessibility settings that persist: camera shake level, comfort
  FOV, reduce motion, auto-cinematic camera, captions and UI scale.
- "Reset progress" entry in the settings menu (feathers and discovered
  landmarks for the current seed).
- Boot-stage timings (`window.__pelican.bootStages`, logged per stage) and a
  build stopwatch inside the vegetation scatter.
- Graphics-context-loss recovery overlay with a watchdog, a boot-time error
  strip in `index.html`, and a shared module-failure report.
- A finish presentation for the time trial: a cut to a celebration angle, the
  director's orbit, confetti and sparkle bursts, a held letterbox and a
  best-lap toast (any real input hands control back).

### Fixed

- The HUD never updated: speedometer, clock, compass and minimap were frozen at
  their initial values.
- "Explored X / 28" could never complete; the HUD and minimap now share the
  25-discoverable list with the discovery logic.
- Exploration progress (feathers, discovered landmarks) now survives a reload,
  per seed.
- The discovery letterbox no longer sticks forever, and the cinematic camera,
  the `C` key and photo mode share one mode machine instead of desyncing.
- Pickup / discovery / crash sounds no longer double-trigger.
- Time trial: the countdown locks the bike, the whole lap is validated, and
  teleporting past a gate no longer completes it.
- Deep water no longer traps the rider: falling in returns the bike to the road.
- Golden feathers can no longer sit on steep slopes or inside buildings, and
  collision sweeps the movement segment so low frame rates cannot tunnel
  through obstacles.
- Input hardening: tab blur, gamepad disconnect and quit-to-title no longer
  leave keys or brake inputs stuck down.
- Ultra/high-DPR rendering is clamped by an absolute pixel budget, and hidden
  tabs suspend rendering and audio.
- Quality upgrades apply at runtime (bloom / SMAA), and the settings whitelist
  no longer drops the comfort switches on reload.
- Photo-mode look on iOS Safari: touch pointers report `movementX/Y` as 0, so
  the input layer now falls back to client-coordinate deltas.
- The touch steering hint is shown once per browser session instead of on every
  reload.

### Changed

- Repository layout, docs and tooling now live under this project folder.
- Island build at the high preset dropped from ~30 s to ~4-5 s on an
  unthrottled desktop (up to ~13 s on a busy machine): the grass scatter uses
  cached biome and "uncertain zone" grids instead of exact layout queries per
  attempt.
- Denser vegetation (≈9 000 trees and ≈740 000 grass tufts at high) without new
  draw calls; off-road slopes stay deliberately lighter.
- Seabreeze Village keeps 12-16 houses on every seed (unlucky seeds used to
  place as few as one).
- README / SPEC numbers corrected: 20 hand-built landmarks, 25 discoverable
  landmarks, preset-dependent creature counts, measured frame and build data.

## [1.0.0] - 2026-10-14

### Added

- A cinematic three.js cycling showcase: a pelican rides a vintage cruiser
  around a procedurally generated island.
- 6 km x 6 km island with an 11 km ring road, beaches, cliffs, alpine
  highlands, a lake with an islet, a river gorge and a two-arch stone bridge.
- 21 hand-built landmarks, including a rotating-beam lighthouse, a harbour with
  bobbing boats, a windmill, standing stones, a sea arch and an observatory.
- 234 procedural creatures and six particle systems.
- Arcade bicycle physics, 40 golden feathers, 28 discoverable landmarks, an
  8-checkpoint time trial with a stored best lap, photo mode, day/night cycle
  and dynamic weather.
- Custom sky and ocean shaders, four-way blended terrain splatting, PMREM
  image-based lighting and a full post-processing chain.
- Fully synthesised WebAudio soundtrack and sound effects.
- GitHub Pages deployment, dual-language README, screenshot harness and eight
  headless module test suites.

[Unreleased]: https://github.com/cyberElar/pelican-island-ride/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cyberElar/pelican-island-ride/releases/tag/v1.0.0
