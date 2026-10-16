# Contributing

Thanks for taking a look. This is a small, opinionated project, so a quick read
here saves everyone time.

## The two hard rules

Everything in this repository is generated in code:

1. **No external asset files.** No `.png`, `.jpg`, `.mp3`, `.gltf`, no fonts, no
   CDN. Textures come from `src/core/textures.js`, audio from
   `src/core/audio.js`, geometry from maths.
2. **No network access at runtime.** The game must keep working when opened
   straight from `file://`.

Both are enforced in CI. A pull request that adds a binary asset will be asked
to generate it instead.

## Getting set up

```bash
git clone https://github.com/cyberElar/pelican-island-ride.git
cd pelican-island-ride
npm ci
npm run serve      # http://localhost:5577/
npm test           # 8 module suites, headless
```

`node_modules` needs no network beyond `npm ci`: three.js, esbuild and the dev
test harness are the only dependencies.

## The build is committed on purpose

The repository root **is** the deployed site: `index.html` + `game.js` +
`styles.css` are served directly by GitHub Pages, without a build step. That
means:

```bash
npm run build           # -> dist/ (gitignored, for inspection only)
npm run build:publish   # -> refreshes root game.js + styles.css, commit these
```

CI fails if the committed bundle does not match `src/`. If you changed anything
under `src/`, run `npm run build:publish` before committing.

## Module contracts

The interface every world/gameplay module implements is frozen in
[`docs/SPEC.md`](docs/SPEC.md):

```js
export function createSomething(ctx) {
  return { group, update(dt, state), setQuality?(tier), dispose?() };
}
```

- `update()` must be **allocation-free**: no `new Vector3()` per frame, no
  closures created per frame. Reuse scratch objects.
- Materials and geometries are **shared** between instances of the same object
  type, not cloned per instance.
- Anything the player can see within 400 m of the road must be textured
  geometry, never a bare grey primitive.

If a change needs a different interface, update `docs/SPEC.md` in the same
pull request.

## Testing

```bash
npm test                        # all suites
node tools/dev/test-layout.mjs  # one suite
npm run shot                    # 10-scene screenshot harness (needs a browser)
node tools/dev/smoke-live.mjs   # end-to-end check of a deployed URL
```

Headless tests run in Node with a small WebGL stub, so they catch geometry,
physics, state-machine and UI wiring bugs but **not** visual regressions. If
your change affects how something looks, capture a screenshot and say so in the
pull request.

## Adding world content

New landmarks, props or creatures should go through the existing factories
(`src/world/landmarks.js`, `props.js`, `animals.js`) so they pick up the shared
material/texture cache, the quality tiers and the shadow/LOD rules. Keep the
triangle and draw-call budgets in `docs/SPEC.md` in mind, and mention the budget
impact in your pull request.

## Pull requests

- Branch names follow the usual conventions: `feat/…`, `fix/…`, `perf/…`,
  `docs/…`, `chore/…`.
- Commit messages are in English and written in the imperative mood
  ("Add touch controls", not "added touch controls").
- Keep pull requests focused: one idea per pull request is easier to review than
  five.
- For bigger gameplay or art-direction changes, open an issue first so we can
  agree on the shape before you write code.
- AI-assisted contributions are welcome. You are responsible for them: run the
  tests, play the build, and be able to explain every line you submit.

## Reporting bugs

Use the issue templates. The most useful reports include the browser, the
quality preset and the seed from the URL, since the island is procedurally
generated and a seed makes the report reproducible.

## Licence

By contributing you agree that your work is released under the [MIT
Licence](LICENSE).
