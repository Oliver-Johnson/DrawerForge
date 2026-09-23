# Drawerforge

**Gridfinity baseplates and bins, built to the drawer you actually have.**

Drawerforge is a pair of free, open, browser-based tools for [Gridfinity](https://gridfinity.xyz/).
Measure your drawer once, and it works out the grid, splits the baseplate to fit your print
bed, joins the pieces with printable connectors, then lays out the bins that go inside —
exporting STL and 3MF, including pre-arranged print plates that open straight in your slicer.

Everything runs in your browser. Nothing is uploaded, there's no account, and there's no tracking.

**[▶ Baseplates — drawerforge.co.uk](https://drawerforge.co.uk/)** · **[▶ Bins — drawerforge.co.uk/bins](https://drawerforge.co.uk/bins/)** · **[Guide](https://drawerforge.co.uk/guide/)**

Your drawer dimensions carry between the two, in both directions, without losing your work.

---

## Baseplates

- **Drawer-first workflow** — start from internal dimensions; choose how leftover space becomes margins (centred, one-sided, custom per side, or left as a gap)
- **Four split modes** — Balanced, Staggered (brickwork joints so seams never line up), **Fewest plates** (searches split patterns to minimise print-bed loads), and Manual
- **Interactive cut map** — click any grid line to add or remove a cut
- **Seven joint options** — dovetail tabs, puzzle tabs, bowtie keys, puzzle keys, snap clips, H-clips, or none
- **Key housing & insertion choices** — keys in a solid floor (strongest) or inside the grid walls (no extra filament); inserted from beneath, or **from above** to join pieces inside the drawer, including click-locking snap clips
- **Magnets & screws** — pockets openable from above or below, in a full solid floor or filament-saving corner bosses
- **Print plan** — automatic packing onto your bed, plate count, optional stacked printing
- **Exports** — per-piece STL, all-plates 3MF, connector keys, bin-fit test tile, **joint fit sample** (four graduated clearances in one small print), and a ZIP with a README and assembly order

## Bins

- **Whole-drawer layout** — drag across the grid to place bins, click to edit, or fill the rest automatically; coverage and leftover cells shown as you go
- **Multiple layers** — stack bins on bins, as many layers as fit. The layer below is ghosted for alignment, and checks catch the ways a real stack fails: overhanging an empty cell, spanning bins of different heights (it would rock), or a footprint mismatch the lip can't locate
- **Per-edge walls** — each of the four walls can be full, two thirds, half, a low retaining lip, or fully open. An open front makes a bin you can reach into; all four open makes a **flat tray or lid**
- **Dividers** in both directions, solid blocks, and adjustable wall and floor thickness
- **Stacking lips** built to spec, so bins stack on each other and on any spec baseplate
- **See the drawer** — an optional translucent shell around the preview at the drawer's inside dimensions, with the front panel at its own height, so you can judge whether the bins suit the drawer before printing any of them. It changes nothing you download
- **Honest material estimates** — computed analytically at your slicer's infill, not from raw mesh volume
- **Print plan and export** — packs bins onto your bed, exports pre-arranged 3MF plates, or a ZIP with one STL per bin type and a README carrying the layout

## Guide

Written for the questions people actually arrive with, and readable without opening either
tool:

- **[Gridfinity for drawers](https://drawerforge.co.uk/guide/)** — measuring and what to
  subtract, what to do with leftover space, choosing a joint, and which bin heights fit
- **[Drawer size to grid](https://drawerforge.co.uk/guide/drawer-sizes/)** — reference
  tables in millimetres and inches, and where to put the remainder
- **[Baseplate too big for your printer?](https://drawerforge.co.uk/guide/split/)** — how
  many cells each bed takes, why rotating diagonally never helps, and how to split and rejoin

## How to use it

1. **Measure your drawer** internally at its tightest point and subtract 1–2 mm so the finished assembly slides in. Enter width × depth in Baseplates.
2. **Pick your printer** and a split mode. *Fewest plates* is usually the best start.
3. **Choose a joint.** Whatever you pick, **print the joint fit sample first** — four tile pairs at graduated clearances tell you in one five-minute print which fit your printer produces.
4. **Export and print the baseplate.**
5. **Switch to Bins** using the header nav. Your drawer comes with you; add its usable height.
6. **Lay out your bins**, add layers if you want them, and check the plate count before committing — a full drawer is a lot of filament and a lot of hours.
7. **Print one bin first** and check it seats before committing to the rest.

## Self-hosting

The shipped app is a handful of static HTML files with no runtime build step.

1. Fork or clone this repository.
2. Enable **GitHub Pages** (deploy from branch, root).
3. Done — Baseplates at the root, Bins at `/bins/`, the guide at `/guide/`.

Hosting it unmodified needs nothing further. If you **change** it and put it in front of
other people, the licence asks you to offer your users the source of your version — a link
to your own fork in the footer covers it. Keep the name off it (see [License](#license)).

three.js and JSZip are vendored in [`vendor/`](vendor/) and served from your own origin, so
a page makes no third-party request at all and works offline once loaded. Copy that
directory along with the HTML. The build refuses to emit a page that references an external
script or stylesheet, so a CDN URL cannot creep back in.

## Building

`index.html`, `bins/index.html` and every page under `guide/` are **generated**. Edit the
sources in `src/`, never the built files:

| file | contents |
|---|---|
| `src/shared-ui/style.css` | one stylesheet, both tools |
| `src/core.js` | shared geometry engine — pure JS, also runs headless in Node |
| `src/template.html`, `src/ui.js` | the Baseplates tool |
| `src/bins/bin.js` | bin geometry, no CSG at all |
| `src/bins/template.html`, `src/bins/ui.js` | the Bins tool |
| `src/guide/*.html` | the guide pages, one file each |

```bash
node build.js
```

The build itself needs nothing but Node — it splices text. `node build.js --check` verifies
the outputs are in sync without writing, and runs in CI. The full test suite does have
dependencies, because the browser tests drive a real browser; see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to run it.

The build refuses to emit output unless three checks pass, each of which has caught a
shipped bug: `node --check` on every source; an **id audit** (every `$('id')` must exist in
its template); and a **display-reachability audit** (anything hidden with `display:none`
must be un-hidden somewhere, or it is dead UI).

Geometry is verified headlessly:

```bash
node test/bin-audit.js
```

```bash
node test/fit-check.js
```

**Read [docs/ENGINE.md](docs/ENGINE.md) before touching geometry.** The CSG is fragile in
specific, documented ways, and the failure mode is silently broken output rather than a
crash.

## How it works (for the curious)

- Socket profiles follow the published Gridfinity spec (42 mm pitch, three-part profile, 4.25 mm plate); bins follow the published bin spec, so they fit any spec baseplate.
- Each piece is built by **region decomposition** — every grid cell becomes a directly-constructed watertight mesh, and small convex features are subtracted as prisms, the one CSG operation that is numerically robust in a hand-rolled BSP.
- Cuts are designed to **never intersect the curved socket surfaces**. The bins engine uses no CSG at all — every feature is additive.
- Print-plate packing is shelf-based with rotation; *Fewest plates* enumerates banded split patterns and packs each candidate.
- 3MF export writes the OPC container via JSZip.

Some joint pockets intentionally leave small uncapped faces where a cut interrupts the top
rim (≈20 mm² per piece, all simple planar rectangles). Every mainstream slicer's automatic
mesh repair closes these.

## Attribution

- **Gridfinity** was created by [Zack Freedman](https://www.youtube.com/c/ZackFreedman) (Voidstar Lab) as an open standard. These tools implement the published profiles.
- The H-clip and click-locking snap-clip connector styles were inspired by the connector system in the Gridfinity Layout Tool; the geometry here is an independent implementation adapted to unpadded spec-height plates (parts are **not** interchangeable between the tools).

## Issues, suggestions & support

Found a bug, or want a feature? **[Open an issue](https://github.com/Oliver-Johnson/Baseplate-Studio/issues)** — reports with a settings share-link attached are especially easy to act on.

If the tool saved you some time, there's a tip jar at **[ko-fi.com/oliver_johnson](https://ko-fi.com/oliver_johnson)** — entirely optional, always appreciated.

## License

**[AGPL-3.0-or-later](LICENSE)** — free software, and it stays free software. Use it, fork it,
self-host it, build on it. If you distribute it or run a modified version as a public
service, you have to offer that version's source under the same terms.

**The models you make with it are yours.** Everything the tool generates — STL, 3MF, the
ZIP, and the geometry in them — is explicitly excluded from the licence. Sell the files,
sell the prints, sell them on Etsy at a markup. No attribution, no obligation, no share of
anything. That exception is written into [LICENSE](LICENSE) rather than left to be argued
about.

The name is reserved: call your fork something else, so visitors can tell whose work they
are looking at. A link back is appreciated but not required.

Versions published before 2026-08-20 were MIT, and that grant is not withdrawn.
