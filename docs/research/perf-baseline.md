# Performance baseline: ten fixed cameras, four presets

Date: 2026-10-16 · Windows 11, headless Edge, ANGLE D3D11 (Intel iGPU) ·
seed `20261014` · 1280x720, devicePixelRatio 1.

The engine loop is stopped for every measurement and frames are driven by hand
(`tools/dev/audit-frame.mjs`): headless Chrome clamps `requestAnimationFrame`
to ~17 ms, so wall-clock frame times say nothing about frame cost. Each frame
waits for the previous GPU timer query, and the draw-call / triangle numbers
come from one `renderer.info` snapshot per camera with `autoReset` off — they
therefore include the shadow-map pass, which is roughly a third of the calls.

## The ten cameras

| View | Anchor | Time of day |
| --- | --- | --- |
| `gate-road` | spawn / start gate | 17:15 |
| `village` | Seabreeze Village | 16:24 |
| `harbor` | Old Harbour | 15:48 |
| `farm` | Wheat Farm | 11:36 |
| `windmill` | Windmill Hill | 13:12 |
| `bridge` | Stone Bridge | 10:24 |
| `waterfall` | Silverfall | 09:12 |
| `cliffs-sunset` | Viewpoint Bench | 18:21 |
| `peak-noon` | Cloud Peak | 12:12 |
| `lighthouse-night` | Lighthouse Cape | 22:24 |

## Record / reproduce

```powershell
node tools/dev/audit-frame.mjs --quality high --views-only --json docs/research/data/matrix-high.json
# ultra / medium / low: same command with --quality and a matching --json
node tools/dev/_probe-view-split.mjs --quality high --view village   # per-module + per-kind split
```

Raw per-view data: `docs/research/data/matrix-{ultra,high,medium,low}.json`.

## Per-tier maxima (worst of the ten cameras)

| Tier | Max draw calls | Max triangles | Max GPU ms/frame | Budget calls | Verdict |
| --- | --- | --- | --- | --- | --- |
| ultra | 577 | 6.09 M | 4.82 | ≤1500 (hard 2000) | pass |
| high | 559 | 4.39 M | 3.67 | ≤1500 (hard 2000) | pass |
| medium | 550 | 2.99 M | 2.36 | ≤900 | pass |
| low | 306 | 1.45 M | 1.69 | ≤400 (mobile ≤300) | pass (just over the mobile aspiration) |

Triangle budgets from `quality-benchmarks.md` (D4): high ≤5 M — pass (4.39 M);
medium ≤2.5 M — 2.99 M, still above the aspiration; mobile ≤1.5 M — pass (1.45 M).

## high preset, per view

| View | Calls | Triangles | GPU ms |
| --- | --- | --- | --- |
| gate-road | 392 | 2.69 M | 2.76 |
| village | 544 | 4.18 M | 3.23 |
| harbor | 363 | 2.13 M | 2.67 |
| farm | 459 | 3.60 M | 2.93 |
| windmill | 512 | 3.92 M | 3.22 |
| bridge | 559 | 4.39 M | 3.67 |
| waterfall | 470 | 3.71 M | 3.09 |
| cliffs-sunset | 370 | 3.03 M | 2.93 |
| peak-noon | 377 | 3.04 M | 3.07 |
| lighthouse-night | 432 | 2.56 M | 3.02 |

## What the ground-cover LOD removed

`_probe-view-split.mjs` A/Bs the distance culling with
`vegetation.setChunkRange(Infinity)` (the previous "everything in the frustum
draws" behaviour) against the preset range:

| Camera (high) | Draw calls | Triangles |
| --- | --- | --- |
| village, LOD off | 629 | 6.43 M |
| village, chunkRange 1300 m | 549 | 4.36 M |
| bridge, LOD off | 634 | 6.12 M |
| bridge, chunkRange 1300 m | 558 | 4.29 M |

Two changes produced that: grass/flower chunks beyond `chunkRange` (700/1000/
1300/1600 m for low/medium/high/ultra) are skipped — the terrain splat already
carries the ground colour out there, so the horizon is unchanged — and flowers
are merged over a 4x4 block of the 500 m grid, which alone took the flower
draw calls in the village view from **219 to 5** for the same triangles.

## Where the remaining cost is (village, high)

| Item | Draw calls | Triangles |
| --- | --- | --- |
| shadow-map pass | 229 | 0.69 M |
| trees (54 meshes) | 116 | 1.26 M |
| bushes (9 meshes, 2 600 instances) | 24 | 0.96 M |
| grass (78 chunks, 23 drawn) | 23 | 0.99 M |
| rider (bike + pelican) | 172 | 0.03 M |
| props / landmarks / terrain / ocean | 161 | 0.75 M |

Next candidates, in order of value per unit of risk:

1. **rider**: 172 draw calls for 0.03 M triangles — the bike and pelican are
   assembled from many small meshes; merging the static parts (keeping the
   animated wheels/legs as separate meshes) would cut ~150 calls in every view.
2. **bushes**: 0.96 M triangles in 24 calls — the bush variants are dense
   (≈370 triangles per instance for a 1 m plant); a two-tier variant set or a
   distance cull would remove most of that.
3. **shadow pass**: 229 calls, 0.69 M triangles; the shadow camera could drop
   everything beyond ~60 m at high (the perceived radius of the bike shadow).
4. **medium triangles** (2.99 M) sit above the 2.5 M aspiration; the same three
   items cover it.

Two notes on how this maps back to the audit's own wording
(`quality-benchmarks.md` P1 #4):

- It suggested an LOD pass for *high-poly landmarks*. Measured, the landmarks
  cost 0.01–0.02 M triangles per view — they are already merged geometry with
  shared materials. The polygons are in the vegetation (grass 2.59 M, trees
  1.26 M, bushes 0.96 M), so the LOD went into the ground cover, where the
  budget pressure actually was.
- Its "mobile" budget row maps to this matrix's **low** tier (306 calls,
  1.45 M triangles) and to `smoke-ci.mjs --mobile`, which runs the phone-sized
  viewport and touch input end to end. Real-device frame rates are still
  unmeasured — see the gaps in `browser-matrix.md`.
