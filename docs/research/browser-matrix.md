# Browser and device matrix

Recorded 2026-10-16 and re-checked 2026-10-18 on the author's machine
(Windows 11, headless browsers, ANGLE D3D11). Every row below passes on the
current `main`.

| Where | How it runs | What it proves |
| --- | --- | --- |
| Node 22 / 24 (CI matrix) | `npm test` | the 11 module suites: layout, engine, character, vegetation, props, landmarks, life, audio, UI, gameplay, mobile |
| Headless **Edge 155.0.4283.45**, 1280x720 @1x | `node tools/dev/smoke-ci.mjs` | boots the built game from `file://`, rides with real key input, pauses and resumes, tutorial strip appears, `?debug=1` overlay reports fps/calls, HUD speedometer follows, 537 scene meshes, 25 discoverable landmarks, zero console errors, zero external requests |
| Headless **Chrome 155.0.8059.40**, same viewport | `PELICAN_BROWSER="…chrome.exe" node tools/dev/smoke-ci.mjs` | the same checks on a second Chromium build |
| Headless **Firefox 157.0**, same viewport | `npm run smoke:firefox` | the same checks on Gecko; the only browser notice is Firefox's local-font visibility warning, which is filtered as browser-internal |
| Headless **WebKit 27.2** (Safari engine), same viewport | `npm run smoke:webkit` | the same checks on WebKit, including WebGL2, the tutorial, input, pause/resume and the recovery sweep |
| Headless Edge 155, **emulated phone** (390x844 @3x, Android UA, touch) | `node tools/dev/smoke-ci.mjs --mobile` | the same checks plus: the virtual pad is visible, the layout does not overflow horizontally, and the bike actually moves when the on-screen throttle is held |
| Lighthouse 13.5, mobile preset + desktop preset | `docs/research/lighthouse-baseline.md` | performance / accessibility / best-practices / SEO scores and blocking time |
| Ten fixed cameras x four presets | `docs/research/perf-baseline.md` | draw calls, triangles and GPU ms per camera, per tier |
| Screenshot pipeline (6 shots) | `npm run shots:readme` | the published root bundle renders the hero scenes with no console errors |
| README loop (`screenshots/ride.gif`, 560x315, 36 frames @ 8 fps) | `node tools/dev/make-readme-gif.mjs` | the recorded ride through the start gate at golden hour, straight from the published build |

The smoke test is not ceremony: it found the start-gate bug (the arch was built
77 degrees out and one pillar collider sat on the racing line, so every ride
crashed a few metres after the start) and the pause screen's Escape key, which
the card advertised but no handler implemented.

## Re-record

```powershell
npm run build:publish
node tools/dev/smoke-ci.mjs                       # desktop, Edge or $CHROME_PATH
PELICAN_BROWSER="C:\Program Files\Google\Chrome\Application\chrome.exe" node tools/dev/smoke-ci.mjs
node tools/dev/smoke-ci.mjs --mobile

# one-time per machine: Playwright's own browsers
npx --yes playwright@1.64.0 install firefox webkit
npm run smoke:cross                                # chromium + firefox + webkit
```

## Gaps, stated plainly

- **No real phone was available.** The mobile row is Chromium device emulation
  (viewport, DPR, touch, UA): it verifies correctness — touch input, layout,
  boot — and says nothing about frame rate on a mid-range device. The audit's
  P0 item "mobile 30 fps record" therefore stays open until real hardware is
  used.
- **Firefox and WebKit are now covered**, but Playwright's WebKit build is not
  Safari on macOS/iOS. Real Safari/iOS specifics (WebAudio unlock behaviour,
  `file://` rules, the iOS pointer fallback) still need a device or a Mac.
  `docs/SPEC.md` assumes WebGL2, which Safari has shipped since 15.
- GPU numbers in `perf-baseline.md` come from the Intel iGPU in this machine via
  ANGLE D3D11, so they are comparative, not absolute.
