# Vegetation density and roadside detail

Validated on Windows 11, headless Edge / ANGLE D3D11, seed `20261014`, high,
1600 x 900, hour 17.1. All PNGs named below were opened with `view_image`.

## Implementation

- Pine and oak placement now uses 96 deterministic, overlapping groves per
  forest region, with 52 m scatter radii. Enlarged oak crown lobes make crowns
  connect instead of reading as separated little balls. Birch retains the
  forest-edge annulus; existing `forestEdgeBoost` still weights flower patches.
- Added a build-only road corridor pass, sampling both sides of the full ring
  road at 5.5-63 m from its centreline. The pavement and shoulder exclusion
  still apply. Grass goes into the existing 500 m buckets: **no additional
  grass draw calls**. Added roadside flower patches and biased bushes toward
  the corridor. Pebbles also favour the roadside.
- Increased island-wide ground cover, including rocky uplands that previously
  rejected 90% of grass candidates. Beach/upland corridor grass is shorter;
  flowers favour meadow and woodland, with existing reeds/cattails, lilies,
  palms and shore debris retaining their water/coastal niches.
- Added seven-frond ferns, small capped mushrooms and fallen logs. Ferns,
  mushrooms and logs require woodland or proximity to river/lake banks.
  Four new instance batches including roadside pebbles reuse existing
  materials and procedural geometry. No external files or new vivid palette.
- Ground cover now uses cached barycentric heights from the actual terrain
  mesh tessellation. Exact `heightAt` values can differ from the rendered
  triangle by more than a short plant's height. This fix prevents much of
  the slope vegetation from being buried. Trees keep their existing grounding
  contract and tests.
- Tree instances are split into near-road (<95 m) and distant batches, sharing
  the same variant geometry/material references. Distant trees never cast
  shadows. Near batches retain the existing trunk/foliage quality gates.
- `update()` is unchanged and allocation-free. All placement happens during
  construction. Return/export contract is unchanged. Quality still trims
  existing instance lists without rebuilding them.

Only vegetation.js and its permitted test were edited, plus this requested
report and validation artifacts. settings.js and other contributors' changes
were preserved. Existing quality density multipliers remain unchanged.

## Density parameters and counts

The current checkout's measured baseline was **2,420 trees**, rather than the
older approximately 1,150 figure in the task description.

| High parameter | Before | After |
| --- | ---: | ---: |
| Pine target | 700 | 3,800 |
| Oak target | 520 | 3,600 |
| Birch target | 300 | 700 |
| Palm / cypress / willow | 190 / 330 / 380 | unchanged |
| Bush target | 1,150 | 2,600 |
| Island grass attempts / m2 | 0.0095 | 0.032 |
| Grass biome weight: forest / beach / rock | .35 / .15 / .10 | .55 / .22 / .65 |
| Island flower patches / m2 | .000072 | .00011 |
| Corridor grass attempts | none | roadLength * 120 * .32 * grassDensity |
| Corridor flower patches | none | 2,400 * flowerDensity, 14 candidates each |
| Fern / mushroom / fallen log targets | none | 2,200 / 700 / 220, scaled by treeDensity |
| Additional roadside pebble target | none | 5,200 * treeDensity |

| Measured instances, high | Before | After |
| --- | ---: | ---: |
| All trees | 2,420 | 9,000 |
| Pine + oak canopy trees | 1,220 | 7,400 |
| Grass | 92,385 | 769,188 |
| Flowers | 14,992 | 52,495 |
| Rocks including pebbles | 1,433 | 6,826 |
| Bushes | 1,150 | 2,600 |
| Grass chunks | 78 | 78 |
| Instanced meshes | 428 | 467 |
| Existing tree/bush/rock variants | 45 | 45 |

Direct low construction was verified at 4,051 trees; high-to-low trimming
produces 4,052 trees due to rounding per batch, with 230,761 grass instances.
Direct ultra construction was verified at 11,251 trees. The ultra/low tree
results are unaffected by the final ground-cover biome-weight adjustment.
Switching up cannot exceed the density originally constructed, as before.

## Performance

`shot.mjs --fps` reads renderer.info after the final postprocessing pass, so
it reports **1 call / approximately 0M triangles** both before and after.
Those counters do not describe the world. To measure the full composite
frame, a supplementary Playwright probe sets `renderer.info.autoReset=false`,
resets once, calls `engine.render(1/60)`, copies the counters, then restores
autoReset. This includes shadow and postprocessing passes. The shot utility
was not modified.

| Metric | Before | After |
| --- | ---: | ---: |
| Spawn full-frame calls | 665 | 663 (-0.3%) |
| Spawn full-frame triangles | 1,833,281 | 3,097,950 |
| shot rAF median | 12.6 ms | 20.8 ms |
| shot rAF p95 / worst | 16.7 / 21.1 ms | 29.2 / 33.4 ms |
| Approximate median FPS | 79 | 48 |
| Page ready | 3.4-3.7 s | 8.2-9.8 s |
| Vegetation-only Node build | 1,042 ms | 5,560 ms |
| esbuild build log | 127 ms | 126 ms |
| Shader programs / textures | 75 / 195 | 75 / 195 |
| Renderer geometries | 484 | 488 |

The bundler durations are its own logged build time, not total npm process
wall time. Boot measurements include page construction/initialization. An
additional high vegetation test while browser work ran took 7.7 seconds;
ultra construction before the final biome adjustment took 8.2 seconds.

Final cumulative frame samples:

| Camera target | Calls | Triangles |
| --- | ---: | ---: |
| Spawn | 663 | 3,097,950 |
| 320,420,-2.3 slope | 788 | 5,087,760 |
| Village | 634 | 2,828,170 |
| Forest POI teleport | 421 | 3,572,084 |
| Pine forest POI teleport | 576 | 2,818,433 |

The measured maximum is 5.09M, below 7.5M. Only spawn has a matching cumulative
baseline; other rows are coverage samples, not per-location percentage
comparisons. This is not an exhaustive all-camera worst-case guarantee.

The headless frame-time regression is real in these samples and is reported
without claiming a guaranteed 60 FPS. More foliage increases vertex work and
alpha-tested pixel overdraw even when call counts stay flat. Parallel work in
the shared checkout and concurrent validation also limit strict attribution
of whole-game timings and colour differences to this change alone.

## Visual inspection

| View | Before | After |
| --- | --- | --- |
| Chase | [before](../../.scratch/veg-before-chase.png) | [after](../../.scratch/veg-chase.png) |
| Slope | [before](../../.scratch/veg-before-slope.png) | [after](../../.scratch/veg-slope.png) |
| Village | [before](../../.scratch/veg-before-village.png) | [after](../../.scratch/veg-village.png) |

Additional images: [FPS](../../.scratch/veg-fps.png),
[fixed woodland overview](../../.scratch/veg-forest-canopy.png).

My inspection: the chase view has changed decisively from bare turf to visible
verge tufts and flower patches across the foreground and middle distance.
The village now has ground-cover texture around the approaches rather than
just the terrain material. The fixed woodland view shows connected crown
groups separated by glades, following the habitable green belt below the
bare/snowy ridge. It does not form an uninterrupted forest blanket everywhere.
The slope is improved but still visibly more open than the road corridor;
this remains the weakest of the three required views. Grass cards also remain
recognizable at close range, so the result is richer but not yet uniformly
at the specification's animated-feature polish level.

`--poi forest` itself lands at an unrepresentative bare coastal/highland point;
the extra canopy screenshot stops the engine and positions its existing
camera above the forest region, looking toward the lower green belt. It does
not modify application sources. The player's partially buried appearance in
the slope shot also exists in the before image and was not changed here.

## Verification output

Final `npm test`:

```text
PASS  engine       1.0s  ALL ENGINE TESTS PASSED
PASS  layout       0.2s  ALL LAYOUT TESTS PASSED
PASS  character    0.2s  ALL CHARACTER TESTS PASSED
PASS  vegetation   5.8s  ALL VEGETATION TESTS PASSED
PASS  props        0.3s  ALL PROPS TESTS PASSED
PASS  landmarks    0.3s  ALL LANDMARKS TESTS PASSED
PASS  life         0.2s  ALL LIFE TESTS PASSED
PASS  audio        0.1s  ALL AUDIO TESTS PASSED
PASS  ui           4.7s  ALL UI TESTS PASSED
PASS  gameplay     5.3s  gameplay PASSED
PASS  mobile       2.0s  ALL MOBILE TESTS PASSED

npm test: all 11 suites passed
```

```text
built dist/game.js in 126 ms (1242 KiB, minified)
forest canopy: 7400; distant trees do not cast shadows
placement rules sampled: {"treeOnRoad":0,"treeInWater":0,"treeInPoi":0,"grassOnRoad":0,"grassInWater":0}
update: 200 calls with a moving camera in 0.29 ms
ALL VEGETATION TESTS PASSED
```

Added regression assertions for canopy density, grass density, understory
presence and distant-tree shadow suppression. Increased the vegetation build
test allowance from 6 to 10 seconds to reflect the larger static build while
remaining well below the 25-second world-build requirement. Existing placement,
matrix, grounding, quality restoration and update tests remain active.

All requested shot commands ran and wrote PNGs. They exit 1 because Edge
reports the same pre-existing `THREE.WebGLProgram` X4122 floating-point shader
warnings both before and after. These are warnings, not page errors; the
screenshots and metrics were still produced. No warning was hidden or fixed
outside the permitted scope. `git diff --check` passes.

## Tradeoffs and remaining risks

- No external resources, additional shadowed ground cover, per-frame scattering,
  or per-species material proliferation. The new accents add four batches.
- Kept the existing coarse grass chunks instead of adding per-frame distance
  LOD. This avoids allocation/pop-in logic but retains substantial distant
  grass vertex and alpha-test work. An actual density/visibility LOD is the
  next performance improvement if frame time must return toward baseline.
- Ground-cover buffers contain roughly 0.85M total instances in high. Matrix
  and colour instance attributes alone are about 65 MB (76 bytes each), before
  temporary construction lists and renderer overhead. Low still scales down.
- Ground-cover placement follows the terrain resolution at construction time.
  If another change rebuilds terrain at a different resolution on a quality
  switch, vegetation also needs rebuilding or a compatible shared height API.
- Low/ultra tree scaling and high screenshots were verified; ultra full-game
  frame time, all seeds and exhaustive all-camera triangle maxima were not.
- The fern/log/mushroom batches use whole-island bounds rather than additional
  chunk calls. Small instance counts make this an acceptable current tradeoff.
- No triangle-budget increase is requested. The remaining visual shortcomings
  are sparse off-road uplands and the recognizable grass-card silhouette.
