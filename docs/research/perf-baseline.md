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
be out of frustum — which is why the low tier reads 364 calls here, not the 306
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
| ultra | 471 | 5.58 M | 4.47 | ≤1500 (hard 2000) | pass |
| high | 460 | 3.91 M | 3.52 | ≤1500 (hard 2000) | pass |
| medium | 447 | 2.65 M | 2.43 | ≤900 | pass |
| low | 362 | 1.37 M | 1.69 | ≤400 (mobile ≤300) | pass, above the mobile aspiration |

Triangle budgets from `quality-benchmarks.md` (D4): high ≤5 M — pass (3.91 M,
real headroom now); medium ≤2.5 M — 2.65 M, 6 % above the aspiration and
closing; mobile ≤1.5 M — pass (1.37 M). Both numbers include the shadow-map
pass.

## high preset, per view

| View | Calls | Triangles | GPU ms |
| --- | --- | --- | --- |
| gate-road | 384 | 2.23 M | 2.40 |
| village | 447 | 3.62 M | 3.11 |
| harbor | 301 | 1.64 M | 1.85 |
| farm | 377 | 3.12 M | 2.75 |
| windmill | 417 | 3.44 M | 3.05 |
| bridge | 460 | 3.91 M | 3.52 |
| waterfall | 376 | 3.22 M | 3.15 |
| cliffs-sunset | 305 | 2.56 M | 2.48 |
| peak-noon | 313 | 2.61 M | 2.53 |
| lighthouse-night | 358 | 2.04 M | 2.17 |

## What the optimisation passes removed

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

`src/core/merge-static.js` holds two static-merge passes:

- **Within a parent** (the rider): the bike and the pelican collapse from 172
  meshes to 87. Because every mesh is also drawn by the shadow pass, that is
  ~85 calls saved *twice*; the village camera went from 561 to 476 calls and
  its shadow pass from 229 to 57, with identical triangles and every animated
  joint (wheels, crank, pedals, steering, flag, body rig) untouched.
- **Across parents** (the landmarks): each set piece is already batched per
  material, so the win is island-wide — everything static in world space
  becomes one mesh per material (~63 draw calls at the village camera instead
  of 81, and 96 instead of 115 at the bridge). The honest cost: a merged mesh
  spans the island, so it is never frustum-culled (+0.03 M triangles) and it
  always intersects the shadow frustum (+8 shadow-pass calls). Net per frame:
  ~18 main-pass calls fewer, ~10 calls fewer overall.

`buildBushVariant()` also stopped over-tessellating: the bramble's 0.2–0.38 m
blobs and the gorse's 5 cm blossoms are octahedra (8 triangles) instead of
icosahedra (20), the gorse grows 6–10 blossoms instead of 10–18, and the
bramble twigs are open-ended. Bush triangles at the village camera fell from
0.96 M to **0.45 M** (−53 %) with no visible change at a metre or more; the
medium preset's worst camera dropped from 3.01 M to 2.65 M triangles with it.

## Where the remaining cost is (village, high)

Composition from the split probe (it re-snapshots after toggling module
visibility, so its absolute totals run a few percent above the matrix table;
the shares are what matter here).

| Item | Draw calls | Triangles |
| --- | --- | --- |
| vegetation — trees (54 meshes) | 116 | 1.26 M |
| rider | 87 | 0.03 M |
| props | 69 | 0.23 M |
| shadow-map pass | 65 | 0.68 M |
| landmarks | 63 | 0.04 M |
| vegetation — flowers / rocks / reeds (44 meshes) | 37 | 0.67 M |
| vegetation — bushes (9 meshes, 2 600 instances) | 24 | 0.45 M |
| vegetation — grass (78 chunks, 23 drawn) | 23 | 0.99 M |
| terrain / ocean | 11 | 0.51 M |
| animals / collectibles / sky | 9 | 0.01 M |

Next candidates, in order of value per unit of risk:

1. **trees**: 1.26 M triangles in 116 calls — now the biggest single block.
   Trees are large and visible, so impostors or a geometry LOD need care.
2. **medium triangles** (2.65 M) are 6 % above the 2.5 M aspiration; the tree
   work or another grass-density trim at that preset would close it.
3. **grass** (0.99 M) — the distance cull already removed 62 % of it; the next
   lever would be a second, sparser far-field variant instead of a binary cut.

Two notes on how this maps back to the audit's own wording
(`quality-benchmarks.md` P1 #4):

- It suggested an LOD pass for *high-poly landmarks*. Measured, the landmarks
  cost 0.01–0.04 M triangles per view — they are already merged geometry with
  shared materials. The polygons are in the vegetation (grass, trees, bushes),
  so the LOD went into the ground cover, where the budget pressure actually was.
- Its "mobile" budget row maps to this matrix's **low** tier (362 calls,
  1.37 M triangles) and to `smoke-ci.mjs --mobile`, which runs the phone-sized
  viewport and touch input end to end. Real-device frame rates are still
  unmeasured — see the gaps in `browser-matrix.md`.
