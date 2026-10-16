# Performance baseline: ten fixed cameras, four presets

Date: 2026-10-16 · Windows 11, headless Edge, ANGLE D3D11 (Intel iGPU) ·
seed `20261014` · 1280x720, devicePixelRatio 1.

The engine loop is stopped for every measurement and frames are driven by hand
(`tools/dev/audit-frame.mjs`): headless Chrome clamps `requestAnimationFrame`
to ~17 ms, so wall-clock frame times say nothing about frame cost. Each frame
waits for the previous GPU timer query, and the draw-call / triangle numbers
come from one `renderer.info` snapshot per camera with `autoReset` off — they
therefore include the shadow-map pass.

Because the loop is stopped, the tool re-parents the rider onto the teleported
position by hand (`__syncRider`). Before that fix the character's draw calls
were silently missing from any view whose previous camera position happened to
be out of frustum — which is why the low tier reads 393 calls here, not the 306
an earlier revision of this document listed.

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

| Tier | Max draw calls | Max triangles | Max GPU ms/frame | Call budget | Verdict |
| --- | --- | --- | --- | --- | --- |
| ultra | 492 | 6.09 M | 4.80 | ≤1500 (hard 2000) | pass |
| high | 474 | 4.39 M | 3.79 | ≤1500 (hard 2000) | pass |
| medium | 465 | 2.99 M | 2.44 | ≤900 | pass |
| low | 393 | 1.47 M | 1.50 | ≤400 (mobile ≤300) | pass, above the mobile aspiration |

Triangle budgets from `quality-benchmarks.md` (D4): high ≤5 M — pass (4.39 M);
medium ≤2.5 M — 2.99 M, still above the aspiration; mobile ≤1.5 M — pass
(1.47 M, with no headroom). Both numbers include the shadow-map pass.

## high preset, per view

| View | Calls | Triangles | GPU ms |
| --- | --- | --- | --- |
| gate-road | 362 | 2.71 M | 2.53 |
| village | 459 | 4.18 M | 3.52 |
| harbor | 278 | 2.13 M | 2.07 |
| farm | 374 | 3.60 M | 3.15 |
| windmill | 427 | 3.92 M | 3.30 |
| bridge | 474 | 4.39 M | 3.79 |
| waterfall | 385 | 3.71 M | 3.13 |
| cliffs-sunset | 285 | 3.03 M | 2.80 |
| peak-noon | 292 | 3.04 M | 2.43 |
| lighthouse-night | 347 | 2.56 M | 2.49 |

## What the two optimisation passes removed

`_probe-view-split.mjs` A/Bs the ground-cover distance culling with
`vegetation.setChunkRange(Infinity)` (the previous "everything in the frustum
draws" behaviour) against the preset range:

| Camera (high) | Draw calls | Triangles |
| --- | --- | --- |
| village, LOD off | 544 | 6.43 M |
| village, chunkRange 1300 m | 464 | 4.36 M |
| bridge, LOD off | 549 | 6.12 M |
| bridge, chunkRange 1300 m | 473 | 4.29 M |

Grass/flower chunks beyond `chunkRange` (700/1000/1300/1600 m for
low/medium/high/ultra) are skipped — the terrain splat already carries the
ground colour out there, so the horizon is unchanged — and flowers are merged
over a 4x4 block of the 500 m grid, which alone took the flower draw calls in
the village view from **219 to 5** for the same triangles.

The character is merged per parent+material (`src/character/merge-static.js`):
the rider's static meshes (frame tubes, hub parts, bakery) collapse from 172 to
87 meshes. Because every mesh is drawn in the shadow pass as well, that is ~85
draw calls saved **twice** per frame — the village camera went from 561 to 476
calls and its shadow pass from 229 to 57. Triangles are unchanged, and the
animated joints (wheels, crank, pedals, steering, flag, body rig) keep their
own meshes.

## Where the remaining cost is (village, high)

| Item | Draw calls | Triangles |
| --- | --- | --- |
| vegetation — trees (54 meshes) | 116 | 1.26 M |
| vegetation — grass (78 chunks, 23 drawn) | 23 | 0.99 M |
| vegetation — bushes (9 meshes, 2 600 instances) | 24 | 0.96 M |
| vegetation — flowers / rocks / reeds (44 meshes) | 37 | 0.67 M |
| shadow-map pass | 57 | 0.67 M |
| terrain / ocean | 11 | 0.51 M |
| props | 69 | 0.23 M |
| rider | 87 | 0.03 M |
| landmarks + collectibles + animals + sky | 90 | 0.03 M |

Next candidates, in order of value per unit of risk:

1. **bushes**: 0.96 M triangles in 24 calls — the bush variants are dense
   (≈370 triangles per instance for a 1 m plant); a two-tier variant set or a
   distance cull would remove most of that.
2. **trees**: 1.26 M triangles in 116 calls — the biggest remaining block, but
   trees are large and visible, so impostors or a geometry LOD need care.
3. **medium triangles** (2.99 M) sit above the 2.5 M aspiration; the same two
   items cover it.

Two notes on how this maps back to the audit's own wording
(`quality-benchmarks.md` P1 #4):

- It suggested an LOD pass for *high-poly landmarks*. Measured, the landmarks
  cost 0.01–0.02 M triangles per view — they are already merged geometry with
  shared materials. The polygons are in the vegetation (grass, trees, bushes),
  so the LOD went into the ground cover, where the budget pressure actually
  was.
- Its "mobile" budget row maps to this matrix's **low** tier (393 calls,
  1.47 M triangles) and to `smoke-ci.mjs --mobile`, which runs the phone-sized
  viewport and touch input end to end. Real-device frame rates are still
  unmeasured — see the gaps in `browser-matrix.md`.
