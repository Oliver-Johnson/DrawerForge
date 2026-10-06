# Contributing

Thanks for looking. Issues and pull requests are both welcome, and so is simply
telling me something printed badly — that is harder to find out than it sounds.

## Licence of what you contribute

Drawerforge is [AGPL-3.0-or-later](LICENSE) with the additional terms in [NOTICE](NOTICE).
A pull request is offered under those same terms — the licence you received the code under
is the licence your change is accepted under, and you keep the copyright in it. Only send
code you have the right to license that way.

## The one thing that will trip you up

**`index.html`, `bins/index.html` and every page under `guide/` are generated, and so are
`sw.js` and `manifest.webmanifest`. Do not edit them.**

Each page is one self-contained file with no third-party requests, which is what makes
the tools work offline and load instantly. That file is built by splicing the sources
in `src/` into a template:

```bash
node build.js
```

Edit the files in `src/`, run the build, and commit **both** the source and the
regenerated page. `node build.js --check` fails if they are out of step, and CI runs
it, so a change to only one of them will not merge.

**A merge conflict in a generated file is never resolved by hand: take either side and
run `node build.js`.** `sw.js` is the one you will meet. It carries a hash of every page,
so two branches that change different pages both change it, and the only right version
is the one the build writes from the merged sources. For the same reason, a branch that
changes a page needs the current main merged in and rebuilt before it merges, or main
ends up with a `sw.js` that names the wrong hash.

## Running the checks

```bash
npm ci && npx playwright install chromium
```

Then:

```bash
npm run test:all
```

That covers:

| check | what it proves |
|---|---|
| `build.js --check` | pages match `src/`, scripts parse, every `$('id')` exists, no unreachable `display:none` element |
| `test/bin-audit.js` | bin geometry against the published spec, and **every mesh watertight** |
| `test/plate-audit.js` | the same, for baseplates: every piece of every representative plate configuration, plus the minimum CSG cases and the rim cap tiling |
| `test/fit-check.js` | a spec bin fits the socket the baseplate ships |
| `test/stack-check.js` | a bin seats in the one below it with the spec's 0.25 mm at **every** height up the lip, not merely somewhere positive — the foot comes from the published spec and the lip from an inset of the bin outline, so the two are maintained in different places and can drift apart while both still look right |
| `test/hash-roundtrip.js` | a layout survives the URL round trip byte for byte |
| `test/plate-files.js` | a 3MF stays well-formed whatever characters a part's name holds, and the name comes back out as it went in, less the control characters XML has no way to carry; and the 3MF transform turns a part about its origin before moving it, the convention the print plates are placed by |
| `test/drawers-file.js` | a saved drawer survives the design file round trip byte for byte, and a malformed or hostile file is refused with a reason rather than half-read |
| `test/seo-check.js` | structured data parses and matches the visible prose; the link-preview image and icons exist at the size and path every page's tags claim |
| `test/guide-facts.js` | the numbers the guides quote, recomputed from `core.js` and the bin spec — every row of the drawer-size and printer tables, and each worked example in the prose — and that the split guide and both tools list the same printers on the same beds as `tools/printers.js` |
| `test/app-check.js` | the web manifest has what a browser needs to offer an install, each icon is the size the manifest claims, and the service worker caches exactly the pages in `tools/manifest.js` and everything they load |
| `test/ui/` | Playwright: place, carve, merge, resize, share, open offline |
| `test/ci-sim.js` | what CI will see, spliced from git's stored bytes rather than your working tree — so a page you rebuilt but never staged fails here, as it would on CI |

## Line endings

Every text file is checked out **LF, on every platform**, Windows included, and
`.gitattributes` enforces it. Leave it alone: `--check` compares the generated pages byte
for byte, parts of them (the FAQ markup, the sitemap rows) are emitted as LF rather than
copied from a source file, and a CRLF checkout makes untouched pages report as stale.
Setting `core.autocrlf` to fight this brings those false failures back.

If a clone predates this and `--check` fails on pages you have not touched, run
`node build.js` and then `git add --renormalize .`. Neither changes any content.

## Taking the service worker out

`sw.js` keeps a copy of the whole site in every visitor's browser. If that ever has to
stop — it is serving something it must not, or a browser turns out to have a bug with
it — **do not delete `sw.js`.** A browser that asks for it and gets a 404 keeps the
worker it already has, and that worker goes on answering from its cache whenever the
connection drops. Replace it with a worker that removes itself:

1. Delete the block at the end of `src/shared-ui/chrome.js` that registers the worker,
   so no page installs it again.
2. Replace everything in `src/sw.js` below the licence header with this. `build.js`
   still fills in the two markers; nothing reads them.

   ```js
   'use strict';
   const VERSION = /*__VERSION__*/'';
   const FILES = /*__FILES__*/[];

   self.addEventListener('install', () => self.skipWaiting());
   self.addEventListener('activate', (e) => {
     const prefix = 'drawerforge ' + self.registration.scope + ' ';
     e.waitUntil(caches.keys()
       .then((keys) => Promise.all(keys.filter((k) => k.startsWith(prefix)).map((k) => caches.delete(k))))
       .then(() => self.registration.unregister()));
   });
   ```

3. Run `node build.js`, take out `test/ui/offline.spec.js`, which tests the worker that
   is going, and merge.

A browser with the old worker asks for `sw.js` again whenever one of the pages is
opened, so a visitor's next visit installs this one. It deletes the caches — only the
ones with the worker's own prefix, for the reason in `src/sw.js` — and unregisters, and
from the visit after that every page comes straight from the server, as if there had
never been a worker. It has no fetch handler, so it answers nothing in between. Leave it
in place for good: someone who comes back in a year still has the old worker, and this
is what takes it away.

## Geometry, before you change any of it

Read [`docs/ENGINE.md`](docs/ENGINE.md) first. It is short, and it is a list of things
that have already broken this mesh once. The two that catch people:

- **Never cut near a conical surface.** The CSG is hand-rolled and BSP-based; it will
  produce a mesh that looks fine and slices wrong. Build overlapping closed shells
  instead of subtracting.
- **`earTriangulate` fails silently.** It returns a partial triangulation rather than
  throwing. That shipped bins with 218 boundary edges and a slicer rejected them as
  non-manifold. If you add a surface, the audit must show `watertight` — a low
  proportion of bad edges is not "close enough", it is a hole.

`test/bin-audit.js` is the arbiter. If it does not say `all cases clean`, the change
is not finished, whatever the preview looks like.

## Scope

The tools implement the published Gridfinity standard, so output has to stay
compatible with anyone else's baseplates and bins. Changes to the 42 mm pitch, the
7 mm height unit or the foot profile are out of scope.

Everything runs locally in the browser. There is no server, no account and no
analytics, and that is a deliberate constraint rather than an unfinished state.

## Style

Match the surrounding code. Comments explain *why* — particularly why something is
done the awkward way — because most of the awkward code here is awkward for a reason
that cost time to find.
