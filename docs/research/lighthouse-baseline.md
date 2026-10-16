# Lighthouse baseline (desktop + mobile)

Date: 2026-10-16 · Windows 11, headless Edge (ANGLE D3D11) · Lighthouse 13.5.0
Game served locally with `npm run serve` (http://localhost:5577/).
Mobile = Lighthouse's default emulated mid-tier phone + simulated 4G; desktop = `--preset=desktop`.
Categories: performance / accessibility / best-practices / seo.

Raw reports: `lighthouse-desktop.report.{json,html}`, `lighthouse-mobile.report.{json,html}`.

## Reproduce

```powershell
npm run serve
$env:CHROME_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npx lighthouse http://localhost:5577/ --preset=desktop --output=json,html --output-path=docs/research/lighthouse-desktop --chrome-flags="--headless=new --use-angle=d3d11 --enable-unsafe-swiftshader --mute-audio" --only-categories=performance,accessibility,best-practices,seo
npx lighthouse http://localhost:5577/ --output=json,html --output-path=docs/research/lighthouse-mobile --chrome-flags="--headless=new --use-angle=d3d11 --enable-unsafe-swiftshader --mute-audio" --only-categories=performance,accessibility,best-practices,seo
```

## Scores

| Category | Desktop | Mobile |
| --- | --- | --- |
| Performance | 54 | 27 |
| Accessibility | **100** | **100** |
| Best practices | **100** | **100** |
| SEO | **100** | **100** |

## Key metrics

| Metric | Desktop | Mobile |
| --- | --- | --- |
| First contentful paint | 1.3 s | 7.0 s |
| Largest contentful paint | 1.3 s | 7.0 s |
| Total blocking time | 4 890 ms | 13 740 ms |
| Speed index | 5.4 s | 11.9 s |
| Time to interactive | 6.8 s | 21.3 s |
| Cumulative layout shift | 0 | 0 |
| Total byte weight | 1 184 KiB | 1 184 KiB |

## Update: cooperative build slicing (measured delta)

The first run measured the world build as one long task chain (boot log:
terrain 1.1 s, vegetation 1.9 s, environment 0.6 s, props 0.4 s, landmarks
0.2 s). All scatter passes now yield to the browser every ~24 ms through
`createSlicer()` in `src/core/utils.js`; nothing about the placement rules or
the generated world changed (the module test suites compare counts, spacing and
road/water/POI rules and all still pass unchanged).

| Metric | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | --- | --- | --- |
| Performance score | 54 | **70** | 27 | **30** |
| Total blocking time | 4 890 ms | **560 ms** | 13 740 ms | **6 400 ms** |
| Time to interactive | 6.8 s | 3.2 s | 21.3 s | 18.1 s |
| Boot-up time | 11.9 s | 3.7 s | 30.6 s | 12.8 s |
| Main-thread work | 12.4 s | 3.9 s | 31.7 s | 13.3 s |
| Accessibility / best-practices / SEO | 100 | 100 | 100 | 100 |

The raw reports in this folder are from the "after" run. The long-task probe
(`tools/dev/_probe-longtasks.mjs`) confirms the shape on desktop: before, six
long tasks with a 1 855 ms worst case and 4 162 ms total; after, thirteen tasks
with a 617 ms worst case and 1 866 ms total (everything else under 300 ms).

What is left, deliberately:

- `environment` is a single ~620 ms task: the first `PMREMGenerator.fromScene()`
  call pays the sky shader compile, which cannot be sliced from the outside.
- `terrain` keeps a ~290 ms task in `BufferGeometry.computeVertexNormals()`
  (three.js internal, 160k vertices). Replacing it with sliced analytic normals
  is possible but changes the shading path, so it was left alone for now.
- Mobile numbers still scale with Lighthouse's 4x CPU simulation; the slicing
  budget (24 ms) is a deliberate trade-off between chunk count and total boot
  time.

## Findings

- Accessibility, best-practices and SEO are perfect on both presets — no work needed there.
- Performance is dominated by the **synchronous world build**. Boot-up time is 11.9 s
  (desktop) / 30.6 s (mobile) and main-thread work 12.4 s / 31.7 s: `src/main.js` builds
  one module per long task, and the total blocking time is essentially the sum of those
  chunks. FCP/LCP land early (the boot overlay paints first), so the score is a
  responsiveness problem, not a loading problem.
- The remaining failing audits are small or artifacts of the single-file build:
  `unused-javascript` (~256 KiB desktop / 302 KiB mobile estimate), no source maps,
  the published `styles.css` is an unminified copy, and the game bundle is a
  render-blocking script by design (it is the game).
- Next action (P1 #2 in `quality-benchmarks.md`): the slicing landed — see the
  delta above. Remaining work is the PMREM shader-compile task, sliced analytic
  terrain normals, and a smaller slicing budget on low-end/mobile devices.

## Caveats

- Headless Edge with ANGLE D3D11 on the author's machine; the mobile column uses
  simulated throttling, not a real phone.
- Measured over `http://localhost`, so network-dependent metrics are optimistic;
  TBT, boot-up time and main-thread work are the meaningful numbers for this build.
