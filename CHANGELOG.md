# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Cross-browser smoke coverage: `tools/dev/smoke-ci.mjs --browser firefox`
  and `--browser webkit` run the same desktop checks as Chromium (boot,
  WebGL2, tutorial, real input, pause/resume, recovery, content sanity and the
  `file://` contract). `npm run smoke:cross` runs all three; the documented
  matrix now records Firefox 157 and WebKit 27.2 passes in addition to Edge and
  Chrome, and CI runs a WebKit job alongside the Chromium one. Firefox stays a
  local/manual check: Playwright's headless Linux Firefox never reaches a
  usable WebGL2 context on the CI runner, while it passes on Windows.
  Playwright's WebKit is not Safari/iOS, so real-device Safari remains an
  explicit gap.

### Changed

- The release checklist is version-agnostic and includes the cross-browser
  smoke step; the package-lock root version is back in sync with
  `package.json` (1.1.0).
- Tree geometry: trunk and branch cylinders are open-ended (the caps are buried
  or inside the canopy), which is RNG-neutral, so the island layout is
  untouched. Built vegetation drops from 1.52 M to 1.32 M triangles and the
  high preset's worst camera from 3.91 M to 3.70 M.
- The medium preset's ground-cover draw distance moved from 1000 m to 900 m for
  the last 3 k triangles; together with the tree trim its worst camera is now
  2.44 M, inside the 2.5 M budget. Every draw-call and triangle budget in
  `docs/research/quality-benchmarks.md` is met as of this change.
- Bush geometry: the bramble's small blobs and the gorse's 5 cm blossoms are
  octahedra instead of icosahedra, the gorse grows 6-10 blossoms instead of
  10-18 and the twigs are open-ended. Bush triangles at the village camera drop
  from 0.96 M to 0.45 M with no visible change at a metre or more; the high
  preset's worst camera is now 3.91 M triangles (was 4.41 M) and the medium
  preset's 2.65 M (was 3.01 M). All four matrices re-recorded.
- Landmarks merge across pieces: everything static in world space collapses
  into one mesh per material (`src/core/merge-static.js`, moved there from
  `src/character/` so both content modules can share it). The village camera
  drops from 81 to 63 landmark draw calls and the bridge camera from 115 to 96;
  the honest cost is 0.03 M never-culled triangles plus 8 shadow-pass calls,
  because a merged mesh spans the island. Net ~18 main-pass calls fewer per
  frame. All four camera matrices are re-recorded; the low tier's worst camera
  is 364 calls and 1.48 M triangles.

## [1.1.0] - 2026-10-17

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
- Photo mode: four real grade filters (original / sea film / golden hour /
  silver mono) cycled with `V` or the on-screen chip, and `X` (or the chip)
  exports the current frame as a PNG.
- First-run tutorial: a three-step goal strip (set off, ring the bell, collect
  a feather) that is non-blocking and remembered per browser, plus an
  fps / frame-time / draw-call overlay behind `?debug=1`.
- A browser-level smoke test (`tools/dev/smoke-ci.mjs`, run by the `smoke` job
  in CI): it boots the built game from `file://` in headless chromium —
  desktop and emulated phone — rides, pauses, resumes, and fails on any console
  error or external request. Results and the browser/device matrix are in
  `docs/research/browser-matrix.md`.
- A short loop of the ride through the start gate at the top of both READMEs
  (`screenshots/ride.gif`, recorded from the published build by
  `tools/dev/make-readme-gif.mjs`).
- Automatic recovery from the states a rider cannot leave on their own: deep
  water, being pinned against colliders without progress for ~2.6 s, and
  crossing the edge of the world all return the rider to the nearest road with
  a toast (`player:unstuck` carries the reason). The gameplay suite sweeps 20
  edge points — map corners, open water, and cages of colliders — and asserts
  every one either recovers onto a road or escapes by itself; the browser smoke
  test wedges the rider in the real build.

### Fixed

- The start/finish gate was built without its heading (the code read `.heading`
  off the position vector, which is always undefined): the arch sat 77 degrees
  out and one of its pillar colliders stood on the racing line, so every ride
  crashed a few metres after the start. The piece now rotates onto the road
  normal, and the landmark test asserts both pillar colliders clear the road.
- `Escape` now resumes from the pause screen, as the card always claimed:
  gameplay input is disabled while paused, so the menu handler is the only
  place that can catch it.
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

- The rider's static meshes are merged per parent and material
  (`src/character/merge-static.js`): 172 meshes become 87, which removes ~85
  draw calls from the main pass *and* ~85 from the shadow pass (the village
  camera drops from 561 to 476 calls, its shadow pass from 229 to 57) with
  identical triangles and every animated joint untouched.
- The perf probes re-parent the character onto the teleported position before
  measuring. Earlier matrices silently dropped the rider's draw calls in views
  whose previous camera position was out of frustum, which is why the low
  tier's worst camera now reads 393 calls instead of the 306 the first revision
  of `docs/research/perf-baseline.md` listed.
- Repository layout, docs and tooling now live under this project folder.
- Island build at the high preset dropped from ~30 s to ~4-5 s on an
  unthrottled desktop (up to ~13 s on a busy machine): the grass scatter uses
  cached biome and "uncertain zone" grids instead of exact layout queries per
  attempt.
- The world build now runs as a chain of short, cooperatively scheduled tasks:
  terrain, vegetation, props and landmarks yield to the browser every ~24 ms
  (`createSlicer`), so the loading screen keeps animating and no single task
  blocks for seconds. Lighthouse total blocking time fell from 4.9 s to 0.6 s
  (desktop) and 13.7 s to 6.4 s (mobile) with identical placement.
  Evidence: `docs/research/lighthouse-baseline.md`.
- Ground-cover LOD: grass and flower chunks are culled beyond the preset draw
  distance (700 / 1000 / 1300 / 1600 m) and flowers are batched over 2 km
  blocks. The village camera at *high* drops from 629 to 549 draw calls and
  from 6.43 M to 4.36 M triangles with the same look; the flower batches alone
  went from 219 draw calls to 5. Evidence and the ten-camera matrix for all
  four presets: `docs/research/perf-baseline.md`.
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
- Arcade bicycle physics, 40 golden feathers, 25 discoverable landmarks, an
  8-checkpoint time trial with a stored best lap, photo mode, day/night cycle
  and dynamic weather.
- Custom sky and ocean shaders, four-way blended terrain splatting, PMREM
  image-based lighting and a full post-processing chain.
- Fully synthesised WebAudio soundtrack and sound effects.
- GitHub Pages deployment, dual-language README, screenshot harness and eight
  headless module test suites.

[Unreleased]: https://github.com/cyberElar/pelican-island-ride/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/cyberElar/pelican-island-ride/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/cyberElar/pelican-island-ride/releases/tag/v1.0.0
