# Contributing

Thanks for looking. Issues and pull requests are both welcome, and so is simply
telling me something printed badly — that is harder to find out than it sounds.

## Licence of what you contribute

Drawerforge is [AGPL-3.0-or-later](LICENSE) with the additional terms in [NOTICE](NOTICE).
A pull request is offered under those same terms — the licence you received the code under
is the licence your change is accepted under, and you keep the copyright in it. Only send
code you have the right to license that way.

## The one thing that will trip you up

**`index.html`, `bins/index.html` and every page under `guide/` are generated. Do not
edit them.**

Each page is one self-contained file with no third-party requests, which is what makes
the tools work offline and load instantly. That file is built by splicing the sources
in `src/` into a template:

```bash
node build.js
```

Edit the files in `src/`, run the build, and commit **both** the source and the
regenerated page. `node build.js --check` fails if they are out of step, and CI runs
it, so a change to only one of them will not merge.

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
| `test/plate-files.js` | a part's name comes back out of a 3MF as it went in, whatever characters it holds, and the 3MF transform turns a part about its origin before moving it, the convention the print plates are placed by |
| `test/drawers-file.js` | a saved drawer survives the design file round trip byte for byte, and a malformed or hostile file is refused with a reason rather than half-read |
| `test/seo-check.js` | structured data parses and matches the visible prose; the link-preview image and icons exist at the size and path every page's tags claim |
| `test/guide-facts.js` | the numbers the guides quote, recomputed from `core.js` and the bin spec — every row of the drawer-size and printer tables, and each worked example in the prose — and that the split guide and both tools list the same printers on the same beds as `tools/printers.js` |
| `test/ui/` | Playwright: place, carve, merge, resize, share |
| `test/ci-sim.js` | what CI will see, spliced from git's stored bytes rather than your working tree — so a page you rebuilt but never staged fails here, as it would on CI |

## Line endings

Every text file is checked out **LF, on every platform**, Windows included, and
`.gitattributes` enforces it. Leave it alone: `--check` compares the generated pages byte
for byte, parts of them (the FAQ markup, the sitemap rows) are emitted as LF rather than
copied from a source file, and a CRLF checkout makes untouched pages report as stale.
Setting `core.autocrlf` to fight this brings those false failures back.

If a clone predates this and `--check` fails on pages you have not touched, run
`node build.js` and then `git add --renormalize .`. Neither changes any content.

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
