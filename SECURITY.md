# Security Policy

## Supported versions

The deployed game at https://cyberelar.github.io/pelican-island-ride/ always
runs the tip of `main`. Only that revision is supported.

## Reporting a vulnerability

Please report privately through GitHub's [security
advisories](https://github.com/cyberElar/pelican-island-ride/security/advisories/new)
rather than in a public issue.

Useful things to include: the affected revision or URL, browser and version,
and a minimal reproduction.

## Attack surface

The project is deliberately small: a static site with a single bundled
JavaScript file. There is no server, no build-time third-party code in the
shipped bundle, and no runtime network access.

Things that *are* in scope:

- XSS or HTML injection through URL parameters (`?seed=`, `?quality=`) reaching
  the DOM.
- Denial of service (freezes, crashes, tab-killing memory growth) triggered by
  crafted input or parameters.
- Supply-chain issues in the development dependencies (`esbuild`, `three`,
  `jsdom`, `playwright-core`).

Things that are *not* in scope: the visual content of the game, gameplay bugs
(use the bug report template), and issues that require a compromised browser or
OS.

## What we already do

- URL parameters are parsed and clamped, never injected into markup.
- Progress is stored in `localStorage` behind `try/catch` with a versioned
  schema.
- The shipped bundle is reproducible from `src/`; CI verifies that the committed
  artefact matches.
