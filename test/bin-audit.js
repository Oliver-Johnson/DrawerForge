#!/usr/bin/env node
/* Headless audit for bin geometry: manifold check, bounds, and STL output.
 * Usage: node test/bin-audit.js [outDir]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../src/core.js');
const { buildBin, SPEC, REQUIRED_CORE, BIN_DEFAULTS, outlineAt, wallSplits, dividerPart,
        lidPart: lidPartOf, lipHeight: lipHeightOf, LIP_TABLE, holeSites, feetHolesOff,
        unpackBin, binFeet, dividersBuilt, plateLayout, shelfNote, shelfBuilt, NOTE_CLEAR } = require('../src/bins/bin.js');
const NOTE_TEXT = require('../src/bins/text.js');
const HERSHEY = require('../src/bins/font.js');
const { checkOrientation, orientationNote } = require('./orientation.js');

// the browser hand-assembles its own G; make sure core still exports everything
{
  const missing = REQUIRED_CORE.filter((f) => typeof G[f] !== 'function');
  if (missing.length) {
    console.error('core.js is missing: ' + missing.join(', '));
    process.exit(1);
  }
}

// half a cell along either axis, decided here rather than by asking the engine
const halfSize = (c) => c.u % 1 !== 0 || c.v % 1 !== 0;

const cellsExcept = (u, v, drop) => {
  const out = [];
  for (let x = 0; x < u; x++) for (let y = 0; y < v; y++)
    if (!drop.some((d) => d[0] === x && d[1] === y)) out.push([x, y]);
  return out;
};

/* The page's own fields, from its template. The sweeps run a field from its min to its
   max, so raising a cap there without the geometry to back it fails here rather than in
   somebody's slicer. */
const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'src', 'bins', 'template.html'), 'utf8');
const fieldAttr = (id, a) => {
  const m = TEMPLATE.match(new RegExp(`id="${id}"[^>]*\\b${a}="([^"]+)"`));
  return m ? Number(m[1]) : NaN;
};

/* ---- holes in the feet: what they should be, written here rather than read from bin.js,
   so a change to the engine's numbers has to be a change to these as well ---- */
const HOLE = {
  off: 13,          // the spec's site, 13 mm from the cell centre on both axes
  fit: 0.2,         // a pocket is its magnet plus 0.2 across
  deeper: 0.4,      // and its thickness plus 0.4 deep: the spec's 2.4 for 6 x 2
  screwR: 1.5,      // M3, 3 mm across, ending 6 mm up
  screwTop: 6,
  layer: 0.2,       // the two bridging layers over a pocket under a screw
  floor: 1.85,      // the floor screws need: 0.6 over the hole's end
};
const BOTH = { magnets: true, screws: true, holesEvery: true };

/* The four sites of each cell, and whether each should be holed: in every cell, or only
   where the bin has an outer corner — where neither of the cell's neighbours along that
   corner's two edges is in the bin. */
function expectedSites(cfg) {
  const has = (x, y) => x >= 0 && y >= 0 && x < cfg.u && y < cfg.v &&
    (!cfg.cells || cfg.cells.some(([a, b]) => a === x && b === y));
  const out = [];
  for (let i = 0; i < cfg.u; i++)
    for (let j = 0; j < cfg.v; j++) {
      if (!has(i, j)) continue;
      for (const sx of [1, -1])
        for (const sy of [1, -1])
          out.push({ x: (i - (cfg.u - 1) / 2) * 42 + HOLE.off * sx,
                     y: (j - (cfg.v - 1) / 2) * 42 + HOLE.off * sy,
                     holed: !!(cfg.magnets || cfg.screws) &&
                            (!!cfg.holesEvery || (!has(i + sx, j) && !has(i, j + sy))) });
    }
  return out;
}

/* Every height at which a probe straight up from the bed at (x, y) meets the mesh,
   lowest first. Overlapping shells put internal faces in the list, so only the first one
   or two mean anything: the first surface above the bed is a hole's roof, and a point the
   bed covers starts at 0. Bucketed on a 2 mm grid, because whole drawers of sites get
   probed. */
function prober(polys) {
  const C = 2, cells = new Map();
  for (const t of G.polysToTriangles(polys)) {
    const xs = t.map((p) => p[0]), ys = t.map((p) => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / C); gx <= Math.floor(Math.max(...xs) / C); gx++)
      for (let gy = Math.floor(Math.min(...ys) / C); gy <= Math.floor(Math.max(...ys) / C); gy++) {
        const k = gx + ',' + gy;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(t);
      }
  }
  return (x, y) => {
    const zs = [];
    for (const [a, b, c] of cells.get(Math.floor(x / C) + ',' + Math.floor(y / C)) || []) {
      const d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(d) < 1e-12) continue;          // an upright face: the probe runs along it
      const l1 = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / d;
      const l2 = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / d;
      if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue;
      zs.push(l1 * a[2] + l2 * b[2] + (1 - l1 - l2) * c[2]);
    }
    return zs.sort((p, q) => p - q).filter((z, i, s) => i === 0 || z - s[i - 1] > 1e-6);
  };
}

/* The holes have to be BUILT, not merely closed: a foot with every hole left solid is
   just as watertight and wound just as well. So every site of the bin is probed from the
   bed. Where a hole was asked for, the first surface is its roof — the pocket's for
   magnets alone, the screw's end where there is a screw — and the bed must not cover it.
   Where none was, the bed covers the site and nothing above it is a roof until the slab:
   an inner site of a corners-only bin is solid. On the first holed site the layers that
   bridge a pocket under a screw are probed one by one, and the pocket's own size. The
   pocket's polygon has a corner on each axis at the full radius, so it is open 0.02 mm
   inside that and solid 0.02 mm outside: a fit of 0.25 instead of 0.2 fails. Returns
   what is wrong. */
function holeFaults(r, cfg) {
  const at = prober(r.polys), out = [];
  const D = isFinite(cfg.magnetD) ? cfg.magnetD : 6, T = isFinite(cfg.magnetH) ? cfg.magnetH : 2;
  const rM = D / 2 + HOLE.fit / 2, depth = T + HOLE.deeper;
  const roof = cfg.screws ? HOLE.screwTop : depth;
  const sites = expectedSites(cfg), holed = sites.filter((s) => s.holed);
  const near = (z, want) => z !== undefined && Math.abs(z - want) < 1e-3;
  for (const s of sites) {
    const z = at(s.x, s.y);
    if (s.holed ? !near(z[0], roof) : !(near(z[0], 0) && z[1] >= SPEC.footH - 0.05 - 1e-6))
      out.push(`${s.holed ? 'hole' : 'solid site'} at ${s.x.toFixed(0)},${s.y.toFixed(0)} reads ` +
               z.slice(0, 2).map((v) => v.toFixed(2)).join(' then ') +
               (s.holed ? `, roof wanted at ${roof}` : ', wanted the bed and then nothing below the slab'));
  }
  const first = holed[0];
  if (first && cfg.magnets) {
    const probes = [[rM - 0.02, 0, depth, 'just inside the pocket'],
                    [rM + 0.02, 0, 0, 'just outside the pocket']];
    if (cfg.screws)
      probes.push([(HOLE.screwR + 0.9 * rM) / 2, 0, depth, 'beside the slot'],
                  [0, HOLE.screwR + 0.15, depth + HOLE.layer, 'in the slot, past the square'],
                  [HOLE.screwR - 0.1, HOLE.screwR - 0.1, depth + 2 * HOLE.layer, 'in the square, past the circle']);
    for (const [dx, dy, want, what] of probes) {
      const z = at(first.x + dx, first.y + dy)[0];
      if (!near(z, want)) out.push(`${what}: ${z === undefined ? 'nothing' : z.toFixed(2)}, wanted ${want.toFixed(2)}`);
    }
  }
  const nM = cfg.magnets ? holed.length : 0, nS = cfg.screws ? holed.length : 0;
  if (r.meta.magnets !== nM || r.meta.screws !== nS)
    out.push(`counts ${r.meta.magnets} magnets and ${r.meta.screws} screws, built ${nM} and ${nS}`);
  if (cfg.screws && r.meta.floorZ < SPEC.footH + HOLE.floor - 1e-9)
    out.push(`floor at ${r.meta.floorZ.toFixed(2)}, under the ${(SPEC.footH + HOLE.floor).toFixed(2)} screws need`);
  return out.join('; ');
}

const outDir = process.argv[2] || path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });

/* Every character the font draws, written down here rather than read from it: the 94
   printable ASCII characters after the space, and the six past ASCII. In four notes of
   25, one line each on a 4x1x3. */
const ALL_GLYPHS = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i))
  .concat(['µ', 'Ω', '°', '±', '×', 'Ø']);
const NOTE_GLYPHS = [0, 1, 2, 3].map((k) => ALL_GLYPHS.slice(25 * k, 25 * k + 25).join(''));

const CASES = [
  { name: '1x1x3', u: 1, v: 1, hUnits: 3 },
  { name: '1x1x6', u: 1, v: 1, hUnits: 6 },
  { name: '2x1x3', u: 2, v: 1, hUnits: 3 },
  { name: '2x2x3', u: 2, v: 2, hUnits: 3 },
  { name: '3x2x4', u: 3, v: 2, hUnits: 4 },
  { name: '1x1x3-solid', u: 1, v: 1, hUnits: 3, solid: true },
  { name: '2x1x3-div', u: 2, v: 1, hUnits: 3, divX: 1 },
  { name: '3x2x5-div', u: 3, v: 2, hUnits: 5, divX: 2, divY: 1 },
  /* Removable dividers build rails instead of a wall across the cavity — four small
     prisms per divider, which is four more chances to leave a shell open. */
  { name: '2x2x3-railed', u: 2, v: 2, hUnits: 3, divX: 1, divRemovable: true },
  { name: '3x2x5-railed', u: 3, v: 2, hUnits: 5, divX: 2, divY: 1, divRemovable: true },
  { name: '1x1x1', u: 1, v: 1, hUnits: 1 },
  { name: '2x1x3-scoop', u: 2, v: 1, hUnits: 3, scoop: 8 },
  /* A scoop deeper than a lowered front wall is tall stood above it, past the height
     the bin quotes, its README and the bed check use: 14.45 mm built against 11.5 quoted
     here, and 17.95 against 15 below. It stops at the front wall's height now. Walls
     of part height stand up to a BLOAT under the quote (see binTop), so these may be
     that much under it, never over. */
  { name: '2x1x4-low-scoop', u: 2, v: 1, hUnits: 4, scoop: 8.5, under: 0.05,
    edges: { f: 0.25, b: 0.25, l: 0.25, r: 0.25 } },
  { name: '2x1x6-low-scoop', u: 2, v: 1, hUnits: 6, scoop: 12, under: 0.05,
    edges: { f: 0.25, b: 0.25, l: 0.25, r: 0.25 } },
  { name: '2x1x3-label', u: 2, v: 1, hUnits: 3, label: 12 },
  /* A thin wall under a scoop and a shelf. Both ran square into the side walls, and a
     wall under about 1.15 mm left their ends standing out through the rounded outer
     corners: 1.06 mm at 0.4, which the outline check below now catches. The lowered one
     is a 0.09 mm scoop, whose arc never rose a thousandth above the floor before it was
     welded flat. */
  { name: '1x1x3-wall0.4-scoop-label', u: 1, v: 1, hUnits: 3, wall: 0.4, scoop: 8, label: 12 },
  { name: '2x1x4-wall1-scoop-label', u: 2, v: 1, hUnits: 4, wall: 1, scoop: 8, label: 10 },
  { name: '0.5x1x3-wall0.4-scoop-label', u: 0.5, v: 1, hUnits: 3, wall: 0.4, scoop: 8, label: 10 },
  /* Dividers and rails packed up to a thin wall's corner stood out through it the same
     way: 0.36 mm for 32 dividers across a 1x1, 0.92 for 16 pairs of rails. Both ways at
     once, with a scoop and a shelf, is the four shells that meet at one corner. */
  { name: '1x1x3-wall0.4-div32', u: 1, v: 1, hUnits: 3, wall: 0.4, divX: 32 },
  { name: '1x1x3-wall0.4-rails16', u: 1, v: 1, hUnits: 3, wall: 0.4, divX: 16, divRemovable: true },
  { name: '1x1x3-wall0.4-rails-both', u: 1, v: 1, hUnits: 3, wall: 0.4, divX: 16, divY: 16,
    divRemovable: true, scoop: 8, label: 12 },
  /* A fixed divider with a face on the label shelf's front shared the shelf's top front
     edge, used four times: with its back there the two touched face to face. The first
     two were found by review; the third is the usual wall. The sweep further down finds
     every one in a range of walls and shelves. */
  { name: '1x1x3-wall0.6-div30-label12', u: 1, v: 1, hUnits: 3, wall: 0.6, divY: 30, label: 12 },
  { name: '1.5x2.5x3-wall0.4-div84-label12', u: 1.5, v: 2.5, hUnits: 3, wall: 0.4, divY: 84, label: 12 },
  { name: '1x1x3-div16-label4', u: 1, v: 1, hUnits: 3, divY: 16, label: 4 },
  { name: '1x1x1-wall0.4-low-scoop', u: 1, v: 1, hUnits: 1, wall: 0.4, scoop: 8, under: 0.05,
    edges: { f: 0.25, b: 0.25, l: 0.25, r: 0.25 }, magnets: true, screws: true, holesEvery: true },
  /* A shelf deeper than the cavity is tall: its 45 degree underside used to run down
     through the floor and out among the feet, 4 open edges from 8 mm on a 1-unit bin. */
  { name: '1x1x1-label12', u: 1, v: 1, hUnits: 1, label: 12 },
  { name: '2x1x2-label20', u: 2, v: 1, hUnits: 2, label: 20 },
  { name: '2x1x3-openfront', u: 2, v: 1, hUnits: 3, edges: { f: 0 } },
  { name: '2x2x2-tray', u: 2, v: 2, hUnits: 2, edges: { f: 0, b: 0, l: 0, r: 0 } },
  { name: '6x4x5-everything', u: 6, v: 4, hUnits: 5, divX: 2, divY: 1, scoop: 6, label: 10 },
  // carved footprints — the concave outlines the per-cell builder exists for
  { name: 'L-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) },
  { name: 'U-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[1, 2]]) },
  { name: 'T-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[0, 0], [2, 0]]) },
  { name: 'staircase-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[1, 2], [2, 2], [2, 1]]) },
  { name: 'bigL-5x4', u: 5, v: 4, hUnits: 4, cells: cellsExcept(5, 4, [[3, 3], [4, 3], [4, 2]]) },
  /* Holes in the feet. Each of the three bodies — a rectangle's slab, a solid block, a
     carved shape's cell slabs — is split differently once screws reach up into it, so
     each gets one. The section further down builds every hole set on every shape and
     probes the holes; these are here so their STLs are written with the rest. */
  { name: '1x1x3-mag', u: 1, v: 1, hUnits: 3, magnets: true },
  { name: '2x2x3-mag-all', u: 2, v: 2, hUnits: 3, magnets: true, holesEvery: true },
  { name: '1x1x3-mag-scr', u: 1, v: 1, hUnits: 3, magnets: true, screws: true },
  { name: '3x2x4-mag-scr', u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12,
    magnets: true, screws: true, holesEvery: true },
  { name: 'solid-mag-scr', u: 1, v: 1, hUnits: 3, solid: true, magnets: true, screws: true },
  { name: 'L-3x3-mag', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]), magnets: true },
  { name: 'L-3x3-mag-scr', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]),
    magnets: true, screws: true, holesEvery: true },
  /* Half-size bins: quarter feet under the same body, lip, dividers, scoop and label any
     bin gets, half a cell along either axis or both. The section on quarter feet further
     down probes the feet themselves; these are the shapes, and their STLs. */
  { name: '0.5x0.5x3', u: 0.5, v: 0.5, hUnits: 3 },
  { name: '0.5x0.5x1', u: 0.5, v: 0.5, hUnits: 1 },
  { name: '0.5x1x3', u: 0.5, v: 1, hUnits: 3 },
  { name: '1x0.5x3', u: 1, v: 0.5, hUnits: 3 },
  { name: '1.5x1x3', u: 1.5, v: 1, hUnits: 3 },
  { name: '1.5x1.5x3', u: 1.5, v: 1.5, hUnits: 3 },
  { name: '0.5x1x3-solid', u: 0.5, v: 1, hUnits: 3, solid: true },
  { name: '2.5x1x4-div', u: 2.5, v: 1, hUnits: 4, divX: 2 },
  { name: '0.5x2x6-railed', u: 0.5, v: 2, hUnits: 6, divY: 1, divRemovable: true },
  { name: '0.5x1x3-scoop-label', u: 0.5, v: 1, hUnits: 3, scoop: 8, label: 10 },
  { name: '1.5x1x3-scoop-label', u: 1.5, v: 1, hUnits: 3, scoop: 8, label: 10 },
  { name: '1.5x1x3-openfront', u: 1.5, v: 1, hUnits: 3, edges: { f: 0 } },
  { name: '3.5x2.5x5-everything', u: 3.5, v: 2.5, hUnits: 5, divX: 2, divY: 1, scoop: 6, label: 10 },
  /* A bin's note raised on its label shelf: the shelf a millimetre lower and the letters
     standing on it, every stroke a pile of convex shells (text.js). On one line and on
     two, cut short, at both ends of the wall's range, on a half-size bin and over holes
     in the feet, and every glyph the font has in the four after those. `fit` is what the
     section on raised notes further down expects of each; it probes them all. */
  { name: '1x1x3-note', u: 1, v: 1, hUnits: 3, label: 12, labelMode: 1, note: 'M3 screws',
    fit: { lines: 1, cut: false } },
  { name: '2x1x2-note', u: 2, v: 1, hUnits: 2, label: 12, labelMode: 1, note: 'Drill bits 1-6 mm',
    fit: { lines: 1, cut: false } },
  { name: '4x1x3-note', u: 4, v: 1, hUnits: 3, label: 12, labelMode: 1, note: 'Assorted M3 M4 nuts, washers',
    fit: { lines: 1, cut: false } },
  { name: '1x1x3-note-2lines', u: 1, v: 1, hUnits: 3, label: 12, labelMode: 1, note: 'Resistors 10k to 100k',
    fit: { lines: 2, cut: false } },
  { name: '1x1x3-note-cut', u: 1, v: 1, hUnits: 3, label: 12, labelMode: 1, note: 'Assorted M3 M4 nuts, washers',
    fit: { cut: true } },
  { name: '1x1x3-note-wall0.4', u: 1, v: 1, hUnits: 3, wall: 0.4, label: 12, labelMode: 1, note: 'M3 screws',
    fit: { lines: 1, cut: false } },
  { name: '1x1x3-note-wall3', u: 1, v: 1, hUnits: 3, wall: 3, label: 12, labelMode: 1, note: 'M3 screws',
    fit: { lines: 1, cut: false } },
  /* A wall under about 1.15 mm builds the shelf over the cavity's rounded outline, a
     millimetre lower with letters on it as at any other wall. Across the thin range, with
     a note cut short so its letters run the band from end to end, and on a half cell. */
  { name: '1x1x3-note-wall0.8', u: 1, v: 1, hUnits: 3, wall: 0.8, label: 12, labelMode: 1, note: 'M3 screws',
    fit: { lines: 1, cut: false } },
  { name: '1x1x3-note-wall1', u: 1, v: 1, hUnits: 3, wall: 1, label: 12, labelMode: 1, note: 'M3 screws',
    fit: { lines: 1, cut: false } },
  { name: '1x1x3-note-wall0.4-cut', u: 1, v: 1, hUnits: 3, wall: 0.4, label: 12, labelMode: 1,
    note: 'Assorted M3 M4 nuts, washers', fit: { cut: true } },
  { name: '0.5x1x3-note-wall0.4', u: 0.5, v: 1, hUnits: 3, wall: 0.4, label: 12, labelMode: 1, note: 'M2',
    fit: { lines: 1, cut: false } },
  { name: '0.5x1x3-note', u: 0.5, v: 1, hUnits: 3, label: 12, labelMode: 1, note: 'M2',
    fit: { lines: 1, cut: false } },
  /* Dividers stand from the floor to H, through the shelf and anything on it, so the
     letters go in the widest space between them and keep 0.4 mm off each: a fixed one is
     a wall thick, a removable one the rails either side of the slot its plate slides
     down. Ones across the other way that cross the shelf split it front from back, and
     the letters take the deeper part. The section on raised notes holds every corner of
     every letter 0.4 clear of each divider's footprint, worked out from the bin's own
     numbers; a bin whose dividers leave no room for any of it is with the bins that
     print nothing. */
  { name: '1x1x3-note-div1', u: 1, v: 1, hUnits: 3, label: 12, divX: 1, labelMode: 1, note: 'M3 screws',
    fit: { lines: 2, cut: false } },
  { name: '3x1x3-note-div2', u: 3, v: 1, hUnits: 3, label: 12, divX: 2, labelMode: 1,
    note: 'Assorted M3 M4 nuts', fit: { lines: 2, cut: false } },
  { name: '1x1x3-note-wall0.4-div1', u: 1, v: 1, hUnits: 3, wall: 0.4, label: 12, divX: 1, labelMode: 1,
    note: 'M3 screws', fit: { lines: 2, cut: false } },
  { name: '2x1x3-note-rails1', u: 2, v: 1, hUnits: 3, label: 12, divX: 1, divRemovable: true,
    labelMode: 1, note: 'M3 screws', fit: { lines: 1, cut: false } },
  { name: '1x1x3-note-rails2', u: 1, v: 1, hUnits: 3, label: 12, divX: 2, divRemovable: true,
    labelMode: 1, note: 'M2 nuts', fit: { lines: 2, cut: true } },
  { name: '1x1x3-note-divY3', u: 1, v: 1, hUnits: 3, label: 12, divY: 3, labelMode: 1, note: 'M3 screws',
    fit: { lines: 1, cut: false } },
  { name: '2x2x4-note-div-both', u: 2, v: 2, hUnits: 4, label: 16, divX: 1, divY: 5, labelMode: 1,
    note: 'Fuses 5A, 10A', fit: { lines: 1, cut: false } },
  { name: '2x2x4-note-rails-both', u: 2, v: 2, hUnits: 4, label: 16, divX: 1, divY: 5, divRemovable: true,
    labelMode: 1, note: 'Fuses 5A, 10A', fit: { lines: 1, cut: false } },
  /* A removable divider asked for where none fits (a half cell with 5 mm walls and a 5 mm
     plate) is not built, so the note has the shelf to itself: it was fitted between
     dividers that are not there, and refused as if they were. */
  { name: '0.5x1x4-note-rails-none', u: 0.5, v: 1, hUnits: 4, wall: 5, label: 12, divX: 1, divRemovable: true,
    divT: 5, divClr: 1, labelMode: 1, note: 'M3 screws', fit: { lines: 2, cut: true } },
  /* Removable plates along stay in front of the label shelf (railedLimit): asked for 3
     on a 1 x 0.5 and 6 on a 1 x 1, these are built with one, and the note prints behind
     it, where the ones asked for would have cut the shelf too short for it. */
  { name: '1x0.5x6-note-rails-along', u: 1, v: 0.5, hUnits: 6, label: 12, divY: 3, divRemovable: true,
    labelMode: 1, note: 'M3 screws', fit: { lines: 1, cut: false } },
  { name: '1x1x6-note-rails-along6', u: 1, v: 1, hUnits: 6, label: 12, divY: 6, divRemovable: true,
    labelMode: 1, note: 'M3 screws', fit: { lines: 1, cut: false } },
  { name: '2x1x3-note-mag-scr', u: 2, v: 1, hUnits: 3, label: 12, labelMode: 1, note: 'Fuses 5A, 10A',
    magnets: true, screws: true, fit: { lines: 1, cut: false } },
  ...NOTE_GLYPHS.map((note, i) => ({ name: `4x1x3-glyphs-${i + 1}`, u: 4, v: 1, hUnits: 3, label: 12,
                                      labelMode: 1, note, fit: { lines: 1, cut: false } })),
];

/* Every carved footprint builds one outer fillet per reflex corner, and every one of
 * them used to be inside out: a closed 212-triangle shell of -214.259 mm³. Watertight,
 * zero bad edges, and the total volume stayed positive because it was one shell among
 * forty in a pile of overlapping ones — which is exactly the gap the orientation check
 * exists to close. sweptSector traced the band as `outer` forward then `inner` reversed,
 * which is only anticlockwise while `outer` is the larger radius; the concave case
 * passes them the other way round. It now sorts them by radius before tracing. */
const orientQuarantine = (cs, r) => cs.orientQuarantine
  ? (r.ok ? '  ORIENTATION NOW CLEAN — take it out of quarantine' : `  known: ${cs.orientQuarantine}`)
  : '';

/* How far a bin stands out through its outline above the feet: the spec's, rounded
   corners and all, with the bin's extra clearance taken off every side, and each corner
   the chords it is built from rather than the arc they stand for. The bounding box
   cannot see a corner: the scoop's square ends stood 1.06 mm out through a 0.4 mm
   wall's corners with the box exactly right, and so did dividers and rails packed up to
   one. The arc could not see a poke under a chord's sagitta, 8 µm at the default 12
   segments and 18 µm at 8, nor anything standing out by less than the clearance. So a
   vertex is measured against each straight side and each chord, and the most it stands
   out past any of them is how far it is outside: exact where a side is nearest, a little
   short of it at a corner of the outline, and outside is outside either way.
   The clearance moves every side in and keeps the corners' centres, so their radius is
   the spec's less the clearance. That is the outline the feet are built to at their
   top, which the body overlaps by a BLOAT. The body's own corners keep the spec's radius
   about centres moved in, so they stand inside it, by 0.41 of the clearance on the
   diagonal, and measured against those the feet's overlap would stand out by as much.
   Carved shapes have outlines of their own and are left to the box. */
function outsideBy(r, cfg) {
  if (cfg.cells) return 0;
  const s = cfg.shrink || 0, n = cfg.arcSegs || 12, R = SPEC.r - s, seg = Math.PI / (2 * n);
  const ox = ((cfg.u - 1) * 42 + 41.5) / 2 - SPEC.r, oy = ((cfg.v - 1) * 42 + 41.5) / 2 - SPEC.r;
  const chords = [];
  for (let k = 0; k < n; k++) {
    const m = (k + 0.5) * seg, cx = Math.cos(m), cy = Math.sin(m);
    chords.push([cx, cy, ox * cx + oy * cy + R * Math.cos(seg / 2)]);
  }
  let out = 0;
  for (const p of r.polys) for (const v of p.verts) {
    if (v[2] <= 4.75 + 1e-6) continue;
    const x = Math.abs(v[0]), y = Math.abs(v[1]);
    let o = Math.max(x - ox - R, y - oy - R);
    for (const [cx, cy, h] of chords) o = Math.max(o, x * cx + y * cy - h);
    out = Math.max(out, o);
  }
  return out;
}

let bad = 0;
console.log('case            tris   W x D x H (mm)        zmin   zmax   mesh');
for (const cs of CASES) {
  let r;
  try {
    r = buildBin(G, cs);
  } catch (e) {
    console.log(`${cs.name.padEnd(14)} BUILD FAILED: ${e.message}`);
    bad++; continue;
  }
  const tris = G.polysToTriangles(r.polys);
  let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of r.polys) for (const v of p.verts) {
    zmin = Math.min(zmin, v[2]); zmax = Math.max(zmax, v[2]);
    xmin = Math.min(xmin, v[0]); xmax = Math.max(xmax, v[0]);
    ymin = Math.min(ymin, v[1]); ymax = Math.max(ymax, v[1]);
  }
  /* Bins ARE watertight and must stay so. An earlier build leaked 218 boundary
     edges because triangulateRing's ear clipper bailed out silently on a thin ring,
     and a slicer reported them as non-manifold. Every edge must now be shared by
     exactly two faces — boundary edges (used once) are holes, and anything used
     more than twice is two shells meeting on a plane instead of overlapping. */
  const man = G.checkManifold(r.polys);
  const pct = 100 * man.bad / man.edges;
  const ok = man.bad === 0;
  /* Watertight says nothing about which way a face points, and a bin is a pile of
     overlapping shells, so the sign of the total volume says nothing either. See
     orientation.js: per-shell volume, directed-edge balance and coplanar folds. */
  const ori = checkOrientation(r.polys);
  const dims = `${(xmax - xmin).toFixed(2)} x ${(ymax - ymin).toFixed(2)} x ${(zmax - zmin).toFixed(2)}`;

  // expected footprint straight from the spec, independent of the builder
  const expW = (cs.u - 1) * 42 + 41.5, expD = (cs.v - 1) * 42 + 41.5;
  /* A carved shape spans its bounding box to the same tolerance as a plain one now
     that its convex corners follow the spec arc. It used to need 0.2 mm of slack
     because square corners put it 1.55 mm outside the Gridfinity profile diagonally
     and 0.1 mm over on the flats. */
  const tol = 0.02;
  const wOk = Math.abs((xmax - xmin) - expW) < tol && Math.abs((ymax - ymin) - expD) < tol;
  // ...and inside the spec's outline, rounded corners and all: see outsideBy
  const out = outsideBy(r, cs);
  const oOk = out < 0.001;
  /* The stacking PITCH is always hUnits*7 — that is what a bin occupies in a stack.
     The real height can be less: a tray with every wall open is just its floor, so
     compare zmax against meta.totalH and check the pitch separately. */
  const hOk = zmax - r.meta.totalH < 0.02 && r.meta.totalH - zmax < (cs.under || 0.02) &&
              Math.abs(r.meta.H - cs.hUnits * 7) < 0.001 &&
              zmin > -0.001;

  console.log(`${cs.name.padEnd(14)} ${String(tris.length).padStart(6)}  ${dims.padEnd(20)} ` +
              `${zmin.toFixed(3).padStart(6)} ${zmax.toFixed(3).padStart(6)}  ` +
              `${ok ? 'watertight' : man.bad + ' BAD EDGES'}`.padStart(12) +
              `${wOk ? '' : '  FOOTPRINT MISMATCH exp ' + expW + 'x' + expD}` +
              `${oOk ? '' : '  OUTSIDE THE OUTLINE by ' + out.toFixed(3) + ' mm'}` +
              `${hOk ? '' : '  HEIGHT MISMATCH: zmax ' + zmax.toFixed(2) + ' vs totalH ' + r.meta.totalH.toFixed(2) + ', pitch ' + r.meta.H}`);
  /* A carved shape is still a bin: it takes a stacking lip like any other, so it
     must report one and stand the same height as the rectangle of the same units.
     Losing the lip silently would make anything carved unstackable. A half-size bin
     is held to the same: it stacks on a half-size bin as a bin sits on a plate. */
  let lipOk = true;
  if ((cs.cells || halfSize(cs)) && !cs.solid && !cs.edges) {
    const expTotal = cs.hUnits * 7 + 3.95;
    lipOk = r.meta.hasLip === true && Math.abs(r.meta.totalH - expTotal) < 0.001;
    if (!lipOk) console.log(`${''.padEnd(14)}  LIP MISSING: hasLip ${r.meta.hasLip}, ` +
      `totalH ${r.meta.totalH.toFixed(2)} vs ${expTotal.toFixed(2)}`);
  }
  if (!ori.ok || cs.orientQuarantine)
    console.log(`${''.padEnd(14)}  ${ori.shells} shells, ${ori.volume.toFixed(1)} mm3   ` +
                `${orientationNote(ori)}${orientQuarantine(cs, ori)}`);
  if (!ok || !wOk || !oOk || !hOk || !lipOk) bad++;
  if (cs.orientQuarantine ? ori.ok : !ori.ok) bad++;
  if (cs.magnets || cs.screws) {
    const f = holeFaults(r, cs);
    if (f) { console.log(`${''.padEnd(14)}  HOLES WRONG: ${f}`); bad++; }
  }

  fs.writeFileSync(path.join(outDir, `bin-${cs.name}.stl`),
                   Buffer.from(G.stlBinary(r.polys, cs.name)));
}

/* cross-section audit: slice the real mesh and compare against the spec profile.
   maxAbs catches the flats; maxRad catches the corner arcs. Expected values come
   from the published spec, not from bin.js. */
function sectionExtents(polys, z) {
  const tris = G.polysToTriangles(polys);
  let maxAbs = 0, maxRad = 0, hits = 0;
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      if ((a[2] - z) * (b[2] - z) >= 0) continue;
      const s = (z - a[2]) / (b[2] - a[2]);
      const x = a[0] + s * (b[0] - a[0]), y = a[1] + s * (b[1] - a[1]);
      maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
      maxRad = Math.max(maxRad, Math.hypot(x, y));
      hits++;
    }
  }
  return { maxAbs, maxRad, hits };
}
/* A foot with holes in it is built from a dozen pieces rather than one sweep, and the
   pieces that carry its outside are the same rings clipped. So the holed foot is sliced
   too, against the spec and against the plain foot: holes are allowed to change what is
   inside the foot and nothing else, and the plain one is the measure of "nothing". */
const SLICES = [[0.4, 17.8 + 0.4], [1.5, 18.6], [2.5, 18.6], [3.5, 18.6 + 0.9], [4.6, 18.6 + 2.0]];
const plainSections = SLICES.map(([z]) => sectionExtents(buildBin(G, { u: 1, v: 1, hUnits: 3 }).polys, z));
for (const [what, holes] of [['', {}],
                             [' with magnet and screw holes', { magnets: true, screws: true }]]) {
  console.log(`\ncross-sections of the built 1x1x3 mesh${what} vs the published spec:`);
  console.log('   z    half-width  (exp)    corner reach  (exp)');
  const r = buildBin(G, Object.assign({ u: 1, v: 1, hUnits: 3 }, holes));
  const C = SPEC.centre;
  SLICES.forEach(([z, expHalf], k) => {
    const s = sectionExtents(r.polys, z);
    const expRad = C * Math.SQRT2 + (expHalf - C);
    const flatOk = Math.abs(s.maxAbs - expHalf) < 0.03;
    const radOk = Math.abs(s.maxRad - expRad) < 0.06;   // faceting slack
    const p = plainSections[k];
    const sameOk = Math.abs(s.maxAbs - p.maxAbs) < 1e-4 && Math.abs(s.maxRad - p.maxRad) < 1e-4;
    console.log(`  ${z.toFixed(2)}   ${s.maxAbs.toFixed(3)}   (${expHalf.toFixed(2)})   ` +
                `${s.maxRad.toFixed(3)}   (${expRad.toFixed(2)})  ` +
                `${flatOk && radOk ? (sameOk ? 'ok' : 'MOVED from the plain foot') : 'MISMATCH'}`);
    if (!(flatOk && radOk && sameOk)) bad++;
  });
}

/* Half-size bins stand on quarter feet, and the feet have to be BUILT that way, not
 * merely closed: a half-size bin on whole feet, or on one half foot per axis, is just as
 * watertight, and its footprint is set by the body, so the footprint check above would
 * pass it too. So the feet are read off the mesh.
 *
 * A quarter foot is the spec foot on a 21 mm pitch: 10.5 mm in from a whole foot on
 * every side at every level of the published profile, with the spec's corner radius
 * there. Its half-width is the spec's less 10.5, and its corner reaches the spec's
 * 17.00 arc centre less 10.5 along each axis, plus that radius. Every quarter of every
 * half-size case is sliced on its own at the heights the whole foot is, against those
 * numbers. Then each is probed from the bed: at its centre the bed has to cover it, and
 * on every line between two quarters nothing may come below the body, which starts at
 * the top of the feet. A whole foot, or a half foot along that line, covers it from 0.
 */
console.log('\nhalf-size bins stand on quarter feet, against the spec:');
{
  const Q = SPEC.pitch / 2, IN = Q / 2;         // a quarter's pitch, and how far in it is
  const C = SPEC.centre;
  const pointsAt = (tris, z) => {
    const out = [];
    for (const t of tris)
      for (let i = 0; i < 3; i++) {
        const a = t[i], b = t[(i + 1) % 3];
        if ((a[2] - z) * (b[2] - z) >= 0) continue;
        const s = (z - a[2]) / (b[2] - a[2]);
        out.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])]);
      }
    return out;
  };
  // every centre along one axis, n halves of a cell across: from the size alone
  const centres = (n) => Array.from({ length: Math.round(n * 2) }, (_, i) => (i + 0.5) * Q - n * Q);
  for (const cs of CASES.filter(halfSize)) {
    const r = buildBin(G, cs), tris = G.polysToTriangles(r.polys), at = prober(r.polys);
    const xs = centres(cs.u), ys = centres(cs.v), faults = [];
    let worstFlat = 0, worstRad = 0;
    for (const [z, expHalf] of SLICES) {
      const pts = pointsAt(tris, z);
      const wantHalf = expHalf - IN, wantRad = (C - IN) * Math.SQRT2 + (expHalf - C);
      for (const fx of xs) for (const fy of ys) {
        let maxAbs = 0, maxRad = 0;
        for (const [x, y] of pts) {
          const dx = Math.abs(x - fx), dy = Math.abs(y - fy);
          if (dx >= IN || dy >= IN) continue;      // another quarter's
          maxAbs = Math.max(maxAbs, dx, dy);
          maxRad = Math.max(maxRad, Math.hypot(dx, dy));
        }
        worstFlat = Math.max(worstFlat, Math.abs(maxAbs - wantHalf));
        worstRad = Math.max(worstRad, Math.abs(maxRad - wantRad));
        if (Math.abs(maxAbs - wantHalf) >= 0.03 || Math.abs(maxRad - wantRad) >= 0.06)
          faults.push(`quarter at ${fx},${fy} sliced at ${z}: half-width ${maxAbs.toFixed(3)} for ` +
                      `${wantHalf.toFixed(2)}, corner ${maxRad.toFixed(3)} for ${wantRad.toFixed(2)}`);
      }
    }
    const first = (x, y) => { const z = at(x, y)[0]; return z === undefined ? Infinity : z; };
    for (const fx of xs) for (const fy of ys)
      if (Math.abs(first(fx, fy)) > 1e-6) faults.push(`the bed does not cover the quarter at ${fx},${fy}`);
    const seams = [];
    for (let i = 0; i + 1 < xs.length; i++) for (const fy of ys) seams.push([(xs[i] + xs[i + 1]) / 2, fy]);
    for (let j = 0; j + 1 < ys.length; j++) for (const fx of xs) seams.push([fx, (ys[j] + ys[j + 1]) / 2]);
    for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++)
      seams.push([(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2]);
    for (const [x, y] of seams)
      if (first(x, y) < SPEC.footH - 0.1)
        faults.push(`a foot reaches over the line between quarters at ${x},${y} from ${first(x, y).toFixed(2)}`);
    console.log(`  ${cs.name.padEnd(22)} ` + (faults.length ? 'WRONG: ' + faults.slice(0, 4).join('; ')
      : `${xs.length * ys.length} quarter ${xs.length * ys.length === 1 ? 'foot' : 'feet, open between,'} ` +
        `within ${worstFlat.toFixed(3)} on the flats ` +
        `and ${worstRad.toFixed(3)} at the corners`));
    if (faults.length) bad++;
  }
}

/* A half-size bin builds no holes in its feet whatever it asks for: where one would meet
   the plate's magnet depends on where the bin sits on the half grid (feetHolesOff). The
   settings stay on the bin, and nothing about the part may change with them — not the
   mesh, not the counts the page reads, not the floor screws would raise, nor the divider
   plate that stands on it. And a mask, which counts whole cells, is ignored. */
console.log('\nhalf-size bins build no holes, and no carve');
{
  const stl = (cfg) => Buffer.from(G.stlBinary(buildBin(G, cfg).polys, 'b')).toString('base64');
  const SETS = [{ magnets: true }, { screws: true }, { magnets: true, screws: true }, BOTH];
  const fails = [];
  let n = 0;
  for (const base of [{ u: 0.5, v: 0.5, hUnits: 3 }, { u: 1.5, v: 1, hUnits: 3, divX: 1, divRemovable: true },
                      { u: 1, v: 2.5, hUnits: 2, solid: true }]) {
    const plain = stl(base), name = `${base.u}x${base.v}`;
    if (!feetHolesOff(base)) fails.push(`${name} gives no reason for having no holes`);
    for (const holes of SETS) {
      const cfg = Object.assign({}, base, holes), r = buildBin(G, cfg);
      const what = `${name} ${Object.keys(holes).join('+')}`;
      n++;
      if (stl(cfg) !== plain) fails.push(`${what} is not the bin without`);
      if (r.meta.magnets || r.meta.screws || holeSites(cfg).length)
        fails.push(`${what} counts ${r.meta.magnets} magnets, ${r.meta.screws} screws`);
      if (Math.abs(r.meta.floorZ - (SPEC.footH + BIN_DEFAULTS.floorT)) > 1e-9)
        fails.push(`${what} raised its floor to ${r.meta.floorZ.toFixed(2)}`);
      if (base.divRemovable && dividerPart(G, cfg, 'y').meta.tall !== dividerPart(G, base, 'y').meta.tall)
        fails.push(`${what} shortened its divider plate`);
    }
  }
  if (feetHolesOff({ u: 2, v: 1 })) fails.push('a whole bin is given a reason for no holes');
  const carved = { u: 1.5, v: 1, hUnits: 3, cells: [[0, 0]] };
  if (stl(carved) !== stl({ u: 1.5, v: 1, hUnits: 3 })) fails.push('a 1.5x1 with a mask came out carved');
  console.log('  ' + (fails.length ? 'WRONG: ' + fails.join('; ')
    : `${n} holed builds, each the bin without; no such reason on a whole bin; a mask ignored`));
  if (fails.length) bad++;
}

/* A size with no place on the grid builds as the half it is nearest, body and feet
   alike. Built as asked, a 1.25 wide bin was a 52 mm body on quarter feet spanning
   62.5 mm. The page and a link never hand the engine one, but nothing else stops a
   caller doing it. Each part and the feet the page counts are compared with the half's. */
console.log('\na size between halves builds as the nearest half');
{
  const stl = (polys) => Buffer.from(G.stlBinary(polys, 'b')).toString('base64');
  const fails = [];
  const PAIRS = [[{ u: 1.25, v: 1 }, { u: 1.5, v: 1 }], [{ u: 1, v: 2.3 }, { u: 1, v: 2.5 }],
                 [{ u: 0.2, v: 0.6 }, { u: 0.5, v: 0.5 }], [{ u: 2.1, v: 1.9 }, { u: 2, v: 2 }]];
  for (const [asked, near] of PAIRS) {
    const extra = { hUnits: 3, divX: 1, divRemovable: true };
    const a = Object.assign({}, asked, extra), b = Object.assign({}, near, extra);
    const what = `${asked.u}x${asked.v}`;
    const r = buildBin(G, a);
    if (stl(r.polys) !== stl(buildBin(G, b).polys)) fails.push(`${what} is not the ${near.u}x${near.v} bin`);
    const feet = binFeet(a), span = feet.length ? Math.max(...feet.map((f) => f.x)) -
      Math.min(...feet.map((f) => f.x)) + 2 * (SPEC.half - feet[0].inset - BIN_DEFAULTS.shrink) : 0;
    if (Math.abs(span - r.meta.W) > 0.01) fails.push(`${what} has feet ${span.toFixed(1)} mm across a ${r.meta.W.toFixed(1)} mm body`);
    if (JSON.stringify(feet) !== JSON.stringify(binFeet(b))) fails.push(`${what} counts other feet`);
    if (stl(dividerPart(G, a, 'y').polys) !== stl(dividerPart(G, b, 'y').polys)) fails.push(`${what} has another divider`);
    if (stl(lidPartOf(G, a).polys) !== stl(lidPartOf(G, b).polys)) fails.push(`${what} has another lid`);
  }
  console.log('  ' + (fails.length ? 'WRONG: ' + fails.join('; ')
    : `${PAIRS.length} sizes: bin, feet, divider and lid each the nearest half's`));
  if (fails.length) bad++;
}

/* Holes in the feet, every set on every shape that builds a foot or a slab differently.
 *
 * A holed foot is a dozen overlapping shells instead of one sweep, and with screws the
 * slab above it is split the same way, in each of the three bodies. Each build has to be
 * watertight, wound the right way and have its holes where holeFaults says. The number of
 * holes in "corners" is written out by hand for each shape rather than worked out: a
 * rectangle of any size has four outer corners, an L five, a U six. */
console.log('\nholes in the feet');
{
  const SETS = [
    ['magnets', { magnets: true }], ['magnets everywhere', { magnets: true, holesEvery: true }],
    ['screws', { screws: true }], ['screws everywhere', { screws: true, holesEvery: true }],
    ['both', { magnets: true, screws: true }], ['both everywhere', BOTH],
  ];
  const L2 = cellsExcept(2, 2, [[1, 1]]);
  const SHAPES = [
    ['1x1x1', { u: 1, v: 1, hUnits: 1 }, 4],
    ['1x1x3', { u: 1, v: 1, hUnits: 3 }, 4],
    ['2x2x3', { u: 2, v: 2, hUnits: 3 }, 4],
    ['3x2x4 everything', { u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12 }, 4],
    ['2x2x3 railed', { u: 2, v: 2, hUnits: 3, divX: 1, divY: 1, divRemovable: true }, 4],
    ['2x1x3 half front', { u: 2, v: 1, hUnits: 3, edges: { f: 0.5 } }, 4],
    ['L-2x2', { u: 2, v: 2, hUnits: 3, cells: L2 }, 5],
    ['L-3x3', { u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) }, 5],
    ['U-3x3', { u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[1, 2]]) }, 6],
    ['1x1x3 solid', { u: 1, v: 1, hUnits: 3, solid: true }, 4],
    ['L-2x2 solid', { u: 2, v: 2, hUnits: 3, solid: true, cells: L2 }, 5],
  ];
  const check = (cfg, want) => {
    let r;
    try { r = buildBin(G, cfg); } catch (e) { return 'build failed: ' + e.message; }
    const m = G.checkManifold(r.polys), ori = checkOrientation(r.polys);
    const n = cfg.magnets ? r.meta.magnets : r.meta.screws;
    return [m.bad ? `${m.bad} bad edges` : '', ori.ok ? '' : orientationNote(ori),
            n === want ? '' : `${n} holes where the bin has ${want}`, holeFaults(r, cfg)]
      .filter(Boolean).join(', ');
  };
  for (const [name, base, corners] of SHAPES) {
    const cells = base.cells ? base.cells.length : base.u * base.v, fails = [];
    for (const [set, holes] of SETS) {
      const f = check(Object.assign({}, base, holes), holes.holesEvery ? 4 * cells : corners);
      if (f) fails.push(`${set}: ${f}`);
    }
    console.log(`  ${name.padEnd(18)} ` + (fails.length ? 'FAILED with ' + fails.join('; ')
      : `${SETS.length} hole sets, all clean: ${corners} in the corners, ${4 * cells} in every cell`));
    if (fails.length) bad++;
  }

  const shape = (n) => SHAPES.find((x) => x[0] === n);
  /* The rings come from the smoothness setting and the sites do not, so the clipped bands
     meet the arcs at different vertices at each one. One shape for each body. */
  const SMOOTH = ['1x1x3', '2x1x3 half front', 'L-2x2', 'L-2x2 solid'].map(shape);
  const SMOOTH_SETS = SETS.filter(([n]) => ['magnets', 'screws everywhere', 'both everywhere'].includes(n));
  for (const arcSegs of [8, 24]) {
    const fails = [];
    for (const [name, base, corners] of SMOOTH)
      for (const [set, holes] of SMOOTH_SETS) {
        const cells = base.cells ? base.cells.length : base.u * base.v;
        const f = check(Object.assign({ arcSegs }, base, holes), holes.holesEvery ? 4 * cells : corners);
        if (f) fails.push(`${name} ${set}: ${f}`);
      }
    console.log(`  ${('smoothness ' + arcSegs).padEnd(18)} ` +
                (fails.length ? 'FAILED with ' + fails.join('; ') : `${SMOOTH.length * SMOOTH_SETS.length} builds, all clean`));
    if (fails.length) bad++;
  }

  /* Every magnet the fields take, from their min to their max. The pocket is probed for its
     size and depth each time, so a field that lets through a magnet the engine builds
     smaller fails here. The width sets the slot over the pocket and the thickness sets
     how high the bridges go, so each is swept the whole way at both ends of the other. */
  const dLo = fieldAttr('magnetD', 'min'), dHi = fieldAttr('magnetD', 'max');
  const hLo = fieldAttr('magnetH', 'min'), hHi = fieldAttr('magnetH', 'max');
  if (!(dLo > 0 && dHi > dLo && hLo > 0 && hHi > hLo)) {
    console.log(`  the magnet fields have no usable min/max (${dLo}..${dHi}, ${hLo}..${hHi})`);
    bad++;
  } else {
    const steps = (lo, hi) => {
      const out = [];
      for (let x = lo; x < hi - 1e-9; x += 0.5) out.push(+x.toFixed(2));
      return out.concat([hi]);
    };
    const sizes = steps(dLo, dHi).flatMap((d) => [[d, hLo], [d, hHi]])
      .concat(steps(hLo, hHi).flatMap((h) => [[dLo, h], [dHi, h]]))
      .filter(([d, h], i, a) => a.findIndex(([e, k]) => e === d && k === h) === i);
    const fails = [];
    let n = 0;
    /* Every size with screws, which is where the slot and the bridges are; magnets alone
       and a carved solid at the four extremes. */
    const ends = (d, h) => (d === dLo || d === dHi) && (h === hLo || h === hHi);
    for (const [magnetD, magnetH] of sizes)
      for (const [set, holes, name, base, corners] of [
        ['both', { magnets: true, screws: true }, ...shape('1x1x3')],
        ...(ends(magnetD, magnetH) ? [['magnets', { magnets: true }, ...shape('1x1x3')],
                                      ['both', { magnets: true, screws: true }, ...shape('L-2x2 solid')]] : [])]) {
        const f = check(Object.assign({ magnetD, magnetH }, base, holes), corners);
        n++;
        if (f) fails.push(`${magnetD} x ${magnetH} ${set} ${name}: ${f}`);
      }
    console.log(`  ${'magnet sizes'.padEnd(18)} ` + (fails.length ? 'FAILED at ' + fails.join('; ')
      : `${dLo}–${dHi} across, ${hLo}–${hHi} thick: ${n} builds, all clean`));
    if (fails.length) bad++;

    /* A link can carry any number, and the engine holds it to the fields' limits. A size
       past either limit builds exactly the bin at that limit, and a size that is not a
       finite number builds the 6 x 2. */
    const stl = (cfg) => Buffer.from(G.stlBinary(buildBin(G, Object.assign(
      { u: 1, v: 1, hUnits: 3, magnets: true, screws: true }, cfg)).polys, 'b')).toString('base64');
    const pairs = [[{ magnetD: dLo - 2 }, { magnetD: dLo }], [{ magnetD: 1e9 }, { magnetD: dHi }],
                   [{ magnetH: -1 }, { magnetH: hLo }], [{ magnetH: 50 }, { magnetH: hHi }],
                   [{ magnetD: NaN, magnetH: NaN }, { magnetD: 6, magnetH: 2 }],
                   [{ magnetD: 'abc', magnetH: Infinity }, { magnetD: 6, magnetH: 2 }],
                   [{}, { magnetD: 6, magnetH: 2 }]];
    const off = pairs.filter(([a, b]) => stl(a) !== stl(b))
      .map(([a]) => JSON.stringify(a, (k, v) => (typeof v === 'number' && !isFinite(v) ? String(v) : v)));
    console.log(`  ${'sizes out of range'.padEnd(18)} ` +
                (off.length ? 'NOT HELD to the limits: ' + off.join(', ') : `${pairs.length} sizes, each built at its limit`));
    if (off.length) bad++;
  }

  /* With neither box ticked the other hole settings must change nothing at all: every
     bin anyone has saved has them at their defaults, and none of them may move. */
  {
    const key = (cfg) => Buffer.from(G.stlBinary(buildBin(G, cfg).polys, 'b')).toString('base64');
    const same = ['1x1x3', 'L-3x3', '1x1x3 solid'].map(shape)
      .filter(([, base]) => key(base) !== key(Object.assign({ holesEvery: true, magnetD: 5, magnetH: 3 }, base)))
      .map(([n]) => n);
    console.log(`  ${'no holes ticked'.padEnd(18)} ` +
                (same.length ? 'CHANGED by the hole settings: ' + same.join(', ') : '3 bins, byte for byte the bin without'));
    if (same.length) bad++;
  }

  /* Screws raise the floor to 1.85 over the foot, and only screws: the plate that drops
     between removable dividers stands on that floor, so it shortens with it. */
  {
    const H = 3 * SPEC.unitH, rows = [];
    for (const [what, holes, floorT, want] of [
      ['magnets', { magnets: true }, 1.2, 1.2], ['screws', { screws: true }, 1.2, HOLE.floor],
      ['screws', { screws: true }, 0, HOLE.floor], ['screws', { screws: true }, 3, 3]]) {
      const cfg = Object.assign({ u: 2, v: 2, hUnits: 3, divX: 1, divRemovable: true, floorT }, holes);
      const fz = buildBin(G, cfg).meta.floorZ, plate = dividerPart(G, cfg, 'y').meta.tall;
      const wantPlate = H - (SPEC.footH + want) - BIN_DEFAULTS.divClr;
      const ok = Math.abs(fz - (SPEC.footH + want)) < 1e-9 && Math.abs(plate - wantPlate) < 1e-9;
      rows.push(ok ? '' : `${what} on ${floorT}: floor at ${fz.toFixed(2)}, plate ${plate.toFixed(2)} tall, ` +
                          `wanted ${(SPEC.footH + want).toFixed(2)} and ${wantPlate.toFixed(2)}`);
    }
    const fails = rows.filter(Boolean);
    console.log(`  ${'floor under screws'.padEnd(18)} ` +
                (fails.length ? 'WRONG: ' + fails.join('; ') : `${HOLE.floor} over the foot with screws, the asked floor without; divider plates to match`));
    if (fails.length) bad++;
  }
}

/* stacking: does a spec foot fit the lip? The lip's inner surface is defined by an
   inset from the bin's outer outline; the foot comes from the published spec. Both
   share corner-arc centre 17.00, so one number covers flats and corners alike. */
console.log('\nstacking clearance — spec foot inside the lip above it:');
console.log("   z'    lip inner   foot half   clearance");
{
  const { LIP_TABLE } = require('../src/bins/bin.js');
  const steps = LIP_TABLE || [[0, 2.70], [0.8, 1.90], [2.6, 1.90]];
  let worst = Infinity;
  for (const [z, t] of steps) {
    const lipInner = SPEC.half - t;
    let fh = SPEC.prof[SPEC.prof.length - 1][1];
    for (let k = 0; k < SPEC.prof.length - 1; k++) {
      const [z0, h0] = SPEC.prof[k], [z1, h1] = SPEC.prof[k + 1];
      if (z >= z0 && z <= z1) { fh = h0 + (h1 - h0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
    }
    const clr = lipInner - fh;
    worst = Math.min(worst, clr);
    console.log(`  ${z.toFixed(2).padStart(4)}   ${lipInner.toFixed(2).padStart(9)}   ` +
                `${fh.toFixed(2).padStart(9)}   ${clr.toFixed(3).padStart(9)}` +
                `${Math.abs(clr - 0.25) < 0.001 ? '  ok' : '  OFF SPEC'}`);
    if (Math.abs(clr - 0.25) > 0.001) bad++;
  }
  console.log(`  uniform on flats and corners (both outlines share centre ${SPEC.centre.toFixed(2)})`);
}

/* independent check: the foot outline must share the spec corner-arc centre */
console.log('\nfoot corner-arc centre (must be 17.00 at every level):');
for (const [z, half] of SPEC.prof) {
  const r = half - SPEC.centre;
  console.log(`  z ${z.toFixed(2).padStart(5)}  half ${half.toFixed(2)}  r ${r.toFixed(2)}  centre ${(half - r).toFixed(2)}`);
}

/* Nothing was checking the OUTSIDE for overhangs, which is how the retired low-profile
   base shipped a 2.15 mm ledge starting in mid-air, and how the taper meant to fix it
   sat buried inside the body doing nothing across two commits. The styles that caused
   it are gone; the check stays, because it is the only thing here that reads the
   silhouette of the mesh that came out rather than the profile it was built from.
   Walk it and demand no sideways step wider than the height it rises over — that is
   45 degrees, the angle a printer holds without support. */
console.log('\nouter silhouette: no overhang steeper than 45 degrees');
{
  const STEP = 0.05;
  for (const hUnits of [1, 3]) {
    const r = buildBin(G, { u: 2, v: 1, hUnits });
    const tris = G.polysToTriangles(r.polys);
    const at = (z) => {
      let m = 0;
      for (const t of tris) {
        const lo = Math.min(t[0][2], t[1][2], t[2][2]);
        const hi = Math.max(t[0][2], t[1][2], t[2][2]);
        if (z < lo - 1e-9 || z > hi + 1e-9) continue;
        for (let i = 0; i < 3; i++) {
          const a = t[i], b = t[(i + 1) % 3];
          if ((a[2] - z) * (b[2] - z) > 0) continue;
          const s = Math.abs(b[2] - a[2]) < 1e-12 ? 0 : (z - a[2]) / (b[2] - a[2]);
          m = Math.max(m, Math.abs(a[1] + s * (b[1] - a[1])));
        }
      }
      return m;
    };
    let prev = null, worst = 0, where = 0;
    for (let z = STEP; z <= hUnits * 7; z += STEP) {
      const v = at(z);
      if (prev !== null && v - prev > worst) { worst = v - prev; where = z; }
      prev = v;
    }
    const ok = worst <= STEP + 1e-6;
    console.log(`  ${(hUnits + 'u').padEnd(13)} widest step ${worst.toFixed(3)} mm ` +
                `per ${STEP} mm of height, at z ${where.toFixed(2)}   ${ok ? 'ok' : 'OVERHANG'}`);
    if (!ok) bad++;
  }
}

/* Where a lowered wall meets a full-height one.
 *
 * A bin with a half-height front broke in the hand: the top of a side wall came away.
 * The lowered edge used to stop dead beside the full-height corner post, so the top edge
 * fell most of a centimetre across a tangent point — a square notch at the end of the
 * longest unsupported run of wall on the bin, and nearly all of a thin wall's stiffness
 * in bending comes from material at that edge. It now climbs over the first straight
 * segment instead.
 *
 * Measured off the mesh rather than off edgeHeights: the outline rule and the geometry
 * it produces are two different claims, and only the second one gets printed. The top of
 * the wall is read along the outer outline in order, and the steepest step between
 * neighbouring points has to stay clear of vertical. A cliff reads 90.
 */
console.log('\nwhere a lowered wall meets a full-height one');
{
  const seen = new Map();
  const LIMIT = 75;   // degrees from horizontal; the ramps measure 41-61, a step is 90
  const RAMP = [
    ['1x1 front at half', 1, 1, { f: 0.5 }],
    ['1x1 front open', 1, 1, { f: 0 }],
    ['3x1 front at half', 3, 1, { f: 0.5 }],
    ['2x2 front and left', 2, 2, { f: 0.5, l: 0.5 }],
    ['1x1 all full', 1, 1, null],
  ];
  for (const [label, u, v, edges] of RAMP) {
    const r = buildBin(G, Object.assign({}, BIN_DEFAULTS, { u, v, hUnits: 3, edges }));
    /* The same outline buildBin walls with, splits and all. Rebuilding it uniformly
       would sample straight over the ramp vertex and read the shallow average instead
       of the step that is actually there — a check that cannot see the defect. */
    const sp = wallSplits((u - 1) * SPEC.pitch / 2 + SPEC.half,
                          (v - 1) * SPEC.pitch / 2 + SPEC.half, SPEC.r);
    const prof = outlineAt(u, v, SPEC.half, 0, 6, sp).map(([x, y]) => {
      let z = -Infinity;
      for (const pl of r.polys) for (const w of pl.verts)
        if (Math.hypot(w[0] - x, w[1] - y) < 0.35 && w[2] > z) z = w[2];
      return [x, y, z];
    }).filter((q) => isFinite(q[2]));
    let worst = 0;
    for (let i = 0; i < prof.length; i++) {
      const a = prof[i], b = prof[(i + 1) % prof.length];
      const climb = Math.abs(a[2] - b[2]);
      if (climb < 0.2) continue;                       // flat runs carry no transition
      const run = Math.hypot(a[0] - b[0], a[1] - b[1]);
      worst = Math.max(worst, Math.atan2(climb, run) * 180 / Math.PI);
    }
    const ok = worst <= LIMIT;
    console.log(`  ${label.padEnd(20)}steepest top edge ${worst.toFixed(1).padStart(5)}°   ` +
                (ok ? 'ok' : 'CLIFF — a wall ending in a square notch is what broke'));
    if (!ok) bad++;
    seen.set(label, worst);
  }

  /* The angle must not depend on the footprint.
   *
   * The ramp was a quarter of the wall to begin with, which meant a wide bin got a long
   * shallow one — 26 degrees across a 3x5 against 60 across a 1x1 — and gave up a third
   * of an opening that had no strength problem to solve. It is a fixed 8.5 mm now, so
   * the same climb takes the same run whatever the bin's plan. The check above cannot
   * see that regression on its own: a shallower ramp passes a "not a cliff" test
   * comfortably. This is the assertion that fails if the rule goes back to a fraction.
   */
  const wide = [['1x1x5', 1, 1], ['3x1x5', 3, 1], ['3x5x5', 3, 5], ['5x5x5', 5, 5]];
  const angles = wide.map(([, u, v]) => {
    const r = buildBin(G, Object.assign({}, BIN_DEFAULTS, { u, v, hUnits: 5, edges: { f: 0.5 } }));
    const sp = wallSplits((u - 1) * SPEC.pitch / 2 + SPEC.half,
                          (v - 1) * SPEC.pitch / 2 + SPEC.half, SPEC.r);
    const prof = outlineAt(u, v, SPEC.half, 0, 6, sp).map(([x, y]) => {
      let z = -Infinity;
      for (const pl of r.polys) for (const w of pl.verts)
        if (Math.hypot(w[0] - x, w[1] - y) < 0.35 && w[2] > z) z = w[2];
      return [x, y, z];
    }).filter((q) => isFinite(q[2]));
    let worst = 0;
    for (let i = 0; i < prof.length; i++) {
      const a = prof[i], b = prof[(i + 1) % prof.length];
      const climb = Math.abs(a[2] - b[2]);
      if (climb < 0.2) continue;
      worst = Math.max(worst, Math.atan2(climb,
        Math.hypot(a[0] - b[0], a[1] - b[1])) * 180 / Math.PI);
    }
    return worst;
  });
  const spread = Math.max(...angles) - Math.min(...angles);
  console.log(`  ${'same angle at any width'.padEnd(24)}` +
    wide.map(([n], i) => `${n} ${angles[i].toFixed(1)}°`).join('  ') +
    `   ${spread <= 1 ? 'ok' : `SPREAD ${spread.toFixed(1)}° — the ramp is scaling with the bin again`}`);
  if (spread > 1) bad++;
}

/* Does a lid actually go into the lip it is made for?
 *
 * Nothing about the mesh can tell you. The first skirt was watertight, the right
 * footprint and the right height, and fouled the lip from 0.3 mm to 1.5 mm down by up
 * to 0.40 mm — it would have jammed near the top and never seated. It invented a taper
 * instead of following the lip's, which is the sort of mistake that only shows up in
 * the hand, on a print, after an hour.
 *
 * So this compares the two profiles directly: at every depth down the skirt, how much
 * narrower is the lid than the opening it goes into. Must be positive everywhere, and
 * should come out at the clearance, since the two surfaces are meant to be parallel.
 */
console.log('\na lid fits the lip it is made for');
{
  const lipMin = BIN_DEFAULTS.lipMin, lipH = lipHeightOf(lipMin), CLR = 0.2;
  // lip inner inset, as a function of depth below the rim
  const pts = LIP_TABLE.map(([h, i]) => [lipH - h, i]).concat([[0, lipMin]])
                       .sort((a, b) => a[0] - b[0]);
  const lipAt = (d) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [d0, i0] = pts[i], [d1, i1] = pts[i + 1];
      if (d >= d0 && d <= d1) return i0 + (i1 - i0) * ((d - d0) / ((d1 - d0) || 1));
    }
    return pts[pts.length - 1][1];
  };
  const RAMP = lipH - 2.6, IN_TOP = lipMin + CLR, IN_DEEP = 1.90 + CLR, SKIRT = 3.0;
  const lidAt = (d) => (d <= RAMP ? IN_TOP + (IN_DEEP - IN_TOP) * (d / RAMP) : IN_DEEP);
  let worst = Infinity, at = 0;
  for (let d = 0; d <= SKIRT + 1e-9; d += 0.05) {
    const gap = lidAt(d) - lipAt(d);
    if (gap < worst) { worst = gap; at = d; }
  }
  const ok = worst > 0.05;
  console.log(`  tightest clearance down the skirt      ` +
    (ok ? `${worst.toFixed(3)} mm at ${at.toFixed(2)} mm down`
        : `FOULS by ${(-worst).toFixed(3)} mm at ${at.toFixed(2)} mm down`));
  if (!ok) bad++;

  // and the skirt must stop before the lip's bottom taper, or it lands on the ramp
  const straightTo = lipH - 0.8;
  console.log(`  skirt stays in the lip's straight band  ` +
    (SKIRT <= straightTo ? `ok (${SKIRT} of ${straightTo.toFixed(2)} mm)`
                         : `TOO DEEP: ${SKIRT} past ${straightTo.toFixed(2)}`));
  if (SKIRT > straightTo) bad++;

  for (const [name, cfg] of [['every side', { u: 3, v: 5 }],
                             ['front left open', { u: 3, v: 5, lidSides: { f: false } }],
                             ['one cell', { u: 1, v: 1 }],
                             ['half a cell', { u: 0.5, v: 0.5 }],
                             ['1.5 x 0.5, front left open', { u: 1.5, v: 0.5, lidSides: { f: false } }]]) {
    const L = lidPartOf(G, cfg);
    const m = G.checkManifold(L.polys);
    const expW = (cfg.u - 1) * 42 + 41.5;
    const wOk = Math.abs(L.meta.W - expW) < 0.02;
    console.log(`  lid, ${name.padEnd(32)}${m.bad === 0 && wOk ? 'watertight, right footprint' :
      (m.bad ? m.bad + ' BAD EDGES' : `FOOTPRINT ${L.meta.W} vs ${expW}`)}`);
    if (m.bad || !wOk) bad++;
  }

  /* A lid with every skirt unticked is the plate alone. It was reported as plate plus
     skirt, 4.2 mm, to the packer and to the download list, for a 1.2 mm part. */
  const flat = lidPartOf(G, { u: 1, v: 1, lidSides: { f: false, b: false, l: false, r: false } });
  const fm = G.checkManifold(flat.polys);
  let fz = 0;
  for (const p of flat.polys) for (const w of p.verts) fz = Math.max(fz, w[2]);
  const flatOk = fm.bad === 0 && Math.abs(flat.meta.totalH - fz) < 0.001;
  console.log(`  lid, ${'no skirt at all'.padEnd(32)}` + (flatOk
    ? `watertight, ${flat.meta.totalH.toFixed(1)} mm as built`
    : `says ${flat.meta.totalH.toFixed(1)} mm tall, built ${fz.toFixed(1)} mm` + (fm.bad ? `, ${fm.bad} BAD EDGES` : '')));
  if (!flatOk) bad++;
}

/* Every wall the page will let you type, not just the 1.2 everyone uses.
 *
 * From 2.70 mm up — the inset of the stacking lip's base — a rectangular bin leaked:
 * 256 edges used four times to 3 mm, 72 plus coplanar folds beyond. The lip's
 * underside chamfer runs from the wall thickness out to that base, and at a wall that
 * thick it had zero height, so the lip's bottom cap lay on the wall's top face. At
 * exactly 2.70 the wall's top inner edge is the lip's base corner as well, which is
 * why burying the cap alone did not close it.
 *
 * At the thin end, a wall of 0 put the cavity's skin on the outer one — 64 open edges
 * and shells inside out — and 0.2 still left a carved shape 3; the engine now builds
 * anything under 0.4 at 0.4. The page accepts 0 because a shared link does.
 *
 * The range comes from the page's own field, so raising the cap there without the
 * geometry to back it fails here rather than in somebody's slicer. */
console.log('\nwalls across the whole range the page accepts');
{
  const lo = fieldAttr('wall', 'min'), hi = fieldAttr('wall', 'max');
  if (!(lo >= 0 && hi > lo)) {
    console.log(`  the wall field has no usable min/max (${lo}..${hi}) — the page would accept anything`);
    bad++;
  } else {
    const walls = [lo, 0.1, 0.2, 0.3, 0.4, 0.8, 1.2, 2, 2.6, 2.65, 2.69, 2.7, 2.71, 2.75, 3, 3.5, 4, 5, hi]
      .filter((w, i, a) => w >= lo && w <= hi && a.indexOf(w) === i);
    const SHAPES = [
      ['1x1x1', { u: 1, v: 1, hUnits: 1 }],
      ['1x1x3', { u: 1, v: 1, hUnits: 3 }],
      ['2x1x5', { u: 2, v: 1, hUnits: 5 }],
      ['3x2x4 everything', { u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12 }],
      ['2x2x3 railed', { u: 2, v: 2, hUnits: 3, divX: 1, divY: 1, divRemovable: true }],
      ['2x1x3 open front', { u: 2, v: 1, hUnits: 3, edges: { f: 0.5 } }],
      ['L-3x3', { u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) }],
      /* Half a cell is 20.5 mm across, so the thickest wall the field takes leaves a
         slot 0.5 mm wide inside it, with a scoop and a label shelf to fit in that. */
      ['0.5x0.5x3', { u: 0.5, v: 0.5, hUnits: 3 }],
      ['1.5x0.5x4 everything', { u: 1.5, v: 0.5, hUnits: 4, divX: 1, scoop: 8, label: 12 }],
      /* A wall past 6.2 mm reaches over the screw holes from inside, and a label shelf
         on one past 5 mm: both stand above the screw's end, which the probes check. The
         walls around the lip's base have nothing to do with the feet, so these take the
         ends of the range and the walls either side of those two. */
      ['1x1x3 holes', Object.assign({ u: 1, v: 1, hUnits: 3 }, BOTH), true],
      ['L-2x2 holes', { u: 2, v: 2, hUnits: 3, cells: cellsExcept(2, 2, [[1, 1]]), magnets: true, screws: true }, true],
      ['2x1x3 label holes', { u: 2, v: 1, hUnits: 3, label: 12, magnets: true, screws: true }, true],
    ];
    const holeWalls = [lo, 0.4, 1.2, 3, 4.9, 5.1, 6.1, 6.3, 8, hi]
      .filter((w, i, a) => w >= lo && w <= hi && a.indexOf(w) === i);
    for (const [name, base, holes] of SHAPES) {
      const fails = [], these = holes ? holeWalls : walls;
      for (const wall of these) {
        const r = buildBin(G, Object.assign({}, base, { wall }));
        const m = G.checkManifold(r.polys);
        const ori = checkOrientation(r.polys);
        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (const p of r.polys) for (const w of p.verts) {
          xmin = Math.min(xmin, w[0]); xmax = Math.max(xmax, w[0]);
          ymin = Math.min(ymin, w[1]); ymax = Math.max(ymax, w[1]);
        }
        const wOk = Math.abs(xmax - xmin - ((base.u - 1) * 42 + 41.5)) < 0.02 &&
                    Math.abs(ymax - ymin - ((base.v - 1) * 42 + 41.5)) < 0.02;
        const holes = base.magnets || base.screws ? holeFaults(r, base) : '';
        if (m.bad || !ori.ok || !wOk || holes)
          fails.push(`${wall}: ` + [m.bad ? `${m.bad} bad edges` : '', ori.ok ? '' : orientationNote(ori),
                                    wOk ? '' : `footprint ${(xmax - xmin).toFixed(2)}`, holes].filter(Boolean).join(', '));
      }
      console.log(`  ${name.padEnd(18)} ${these[0]}–${these[these.length - 1]} mm  ` +
                  (fails.length ? 'FAILED at ' + fails.join('; ') : `${these.length} walls, all clean`));
      if (fails.length) bad++;
    }
  }
}

/* The other limits the page and a shared link share: a floor as thick as the bin is
   tall, and as many dividers as fit across the inside. Each used to build broken at its
   edge, so each is built here at the edge of what is allowed. */
const cleanBuild = (cfg, r = buildBin(G, cfg)) => {
  const m = G.checkManifold(r.polys), ori = checkOrientation(r.polys);
  let zmax = -Infinity;
  for (const p of r.polys) for (const w of p.verts) zmax = Math.max(zmax, w[2]);
  const H = cfg.hUnits * SPEC.unitH;
  // nothing but the stacking lip may stand above the bin's own height
  const lipTop = H + (r.meta.hasLip ? r.meta.lipH : 0) + 0.001;
  const out = outsideBy(r, cfg);
  return [m.bad ? `${m.bad} bad edges` : '', ori.ok ? '' : orientationNote(ori),
          zmax > lipTop ? `${(zmax - lipTop).toFixed(2)} mm above the top` : '',
          out >= 0.001 ? `${out.toFixed(3)} mm outside the outline` : '',
          cfg.magnets || cfg.screws ? holeFaults(r, cfg) : '']
    .filter(Boolean).join(', ');
};
const sweepReport = (label, rows) => {
  const fails = rows.map(([name, cfg]) => { const f = cleanBuild(cfg); return f ? `${name}: ${f}` : ''; })
    .filter(Boolean);
  console.log(`  ${label.padEnd(34)} ` + (fails.length ? 'FAILED at ' + fails.join('; ') : `${rows.length} builds, all clean`));
  if (fails.length) bad++;
};
const L3 = cellsExcept(2, 2, [[1, 1]]);

console.log('\nfloors up to the bin\'s own height');
/* A carved bin's wall panels run from the floor up to the top; a floor past the top
   swept them downwards — inside out, folded, and standing above the lip. */
for (const hUnits of [1, 3, 6]) {
  const H = hUnits * SPEC.unitH, cavity = H - SPEC.footH;
  const floors = [0, cavity - 0.3, cavity - 0.1, cavity, cavity + 0.5, H].filter((f) => f >= 0);
  for (const [name, base] of [['rectangle', { u: 2, v: 1 }],
                              ['rectangle, dividers', { u: 2, v: 2, divX: 1, divY: 1 }],
                              ['rectangle, rails', { u: 2, v: 2, divX: 1, divRemovable: true }],
                              ['rectangle, scoop + label', { u: 2, v: 1, scoop: H, label: 42 }],
                              ['L-2x2', { u: 2, v: 2, cells: L3 }],
                              ['L-2x2, 3 mm walls', { u: 2, v: 2, cells: L3, wall: 3 }],
                              // a floor under 1.85 is built at 1.85 with screws
                              ['rectangle, holes', { u: 2, v: 1, magnets: true, screws: true }],
                              ['L-2x2, holes', { u: 2, v: 2, cells: L3, magnets: true, screws: true }],
                              ['half-size, scoop + label', { u: 1.5, v: 0.5, scoop: H, label: 42 }],
                              ['half-size, rails', { u: 0.5, v: 1.5, divY: 1, divRemovable: true }]])
    sweepReport(`${hUnits}u ${name}`, floors.map((floorT) =>
      [`floor ${floorT.toFixed(2)}`, Object.assign({ hUnits, floorT }, base)]));
}

console.log('\nas many dividers as the fields allow');
/* The divider fields stop at what fits across the inside at one wall thickness, never
   counted thinner than 1.2 mm — the same rule the link uses. At exactly that many,
   some walls space the dividers exactly one divider apart (4.15 mm in a 1x1, 8.35 in a
   2x1) or the rails exactly one rail apart (0.95 mm, 0.9 in a 3x1), and neighbours
   touched face to face. A wall of 0 is counted for a 0 mm wall and built at 0.4, which
   packs the rails a hair closer than one apart. Those walls are swept along with a
   spread of ordinary ones, on half-size bins as well as whole. */
{
  const most = (n, wall) =>
    Math.max(0, Math.floor(((n - 1) * SPEC.pitch + 2 * SPEC.half - 2 * wall) / Math.max(wall, 1.2)) - 1);
  for (const n of [0.5, 1, 1.5, 2, 3]) {
    const walls = [0, 0.4, 0.9, 0.95, 1.2, 2, 4.15, 5, 8.35, 10];
    for (const divRemovable of [false, true])
      sweepReport(`${n}x1 ${divRemovable ? 'rails' : 'fixed'}`, walls.map((wall) =>
        [`wall ${wall} x${most(n, wall)}`, { u: n, v: 1, hUnits: 2, wall, divX: most(n, wall), divRemovable }]));
    sweepReport(`${n}x${n} both ways, rails`, [0, 0.4, 0.95, 1.2, 3].map((wall) =>
      [`wall ${wall} x${most(n, wall)}`, { u: n, v: n, hUnits: 2, wall, divX: most(n, wall), divY: most(n, wall), divRemovable: true }]));
  }
}

console.log('\nfixed dividers that come to the label shelf\'s front');
/* A fixed divider along the depth whose face lands on the label shelf's front shared the
   shelf's top front edge, used four times; one whose back lands there touched the shelf
   face to face. Which counts do that is arithmetic, worked out here from what the bin is
   meant to be rather than read from bin.js: dividers evenly spaced and one wall thick, and
   a shelf as deep as asked, which on a 6-unit bin it is up to 30 mm and 0.8 of the
   inside's half depth. So every wall from 0.4 to 5 mm, every whole-millimetre shelf and
   every count the field allows is tried on five depths, and what is built is each count
   with a face within a micron of the shelf's front, and on a 1-cell depth each one whose
   back stops short of it by a BLOAT or less too, which now runs on into the shelf. The
   count of those within a micron is printed and must not be zero, or the sweep would
   pass while building none of what it is for. */
{
  const most = (inside, wall) => Math.max(0, Math.floor(inside / Math.max(wall, 1.2)) - 1);
  const rows = [];
  let exact = 0;
  for (const v of [0.5, 1, 1.5, 2, 2.5])
    for (let w = 4; w <= 50; w++) {
      const wall = w / 10, inner = (v - 1) * SPEC.pitch / 2 + 20.75 - wall;
      for (let label = 1; label <= Math.min(30, 0.8 * inner); label++) {
        const front = inner - label;
        for (let n = 1; n <= most(2 * inner, wall); n++) {
          let on = false, near = false;
          for (let k = 1; k <= n; k++) {
            const p = -inner + 2 * inner * k / (n + 1);
            for (const f of [p - wall / 2, p + wall / 2]) on = on || Math.abs(f - front) < 0.001;
            near = near || (p + wall / 2 <= front && p + wall / 2 >= front - 0.05 - 1e-9);
          }
          if (on) exact++;
          if (on || (near && v === 1))
            rows.push([`${v} deep, wall ${wall}, ${label} mm shelf, ${n} along`,
                       { u: 0.5, v, hUnits: 6, wall, label, divY: n }]);
        }
      }
    }
  const fails = rows.map(([name, cfg]) => { const f = cleanBuild(cfg); return f ? `${name}: ${f}` : ''; })
    .filter(Boolean);
  console.log(`  ${`${exact} on its front, ${rows.length - exact} near it`.padEnd(34)} ` + (!exact
    ? 'NONE FOUND to build' : fails.length ? `FAILED ${fails.length} of ${rows.length}, ` +
      `among them ${fails.slice(0, 4).join('; ')}` : `${rows.length} builds, all clean`));
  if (!exact || fails.length) bad++;
}
/* Edges used other than twice once every vertex within `step` of another is one with it,
   as a slicer may weld them. */
const weldBad = (polys, step) => {
  const key = (v) => v.map((x) => Math.round(x / step)).join(',');
  const edges = new Map();
  for (const t of G.polysToTriangles(polys)) {
    const ks = t.map(key);
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;   // welded away
    for (let i = 0; i < 3; i++) {
      const a = ks[i], b = ks[(i + 1) % 3], k = a < b ? a + '|' + b : b + '|' + a;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let n = 0;
  for (const c of edges.values()) if (c !== 2) n++;
  return n;
};
/* Just off the shelf's front is as bad once a slicer welds what is close. A face 2 to 5
   µm from it was built as it was, clean at checkManifold's micron, but its corners and
   the shelf's became one at a weld of 5 or 10 µm and the edge was shared again. So the
   same sweep, taking each count with a face from a micron to 20 µm off the front, is
   welded at 5 µm and at 10 µm, and must still have every edge used twice. One in five of
   them is welded, 591, which takes a fifth of the time: with "on" held to WELD, 52 of those
   failed, and 241 of all 2954. */
{
  const most = (inside, wall) => Math.max(0, Math.floor(inside / Math.max(wall, 1.2)) - 1);
  const rows = [];
  for (const v of [0.5, 1, 1.5, 2, 2.5])
    for (let w = 4; w <= 50; w++) {
      const wall = w / 10, inner = (v - 1) * SPEC.pitch / 2 + 20.75 - wall;
      for (let label = 1; label <= Math.min(30, 0.8 * inner); label++) {
        const front = inner - label;
        for (let n = 1; n <= most(2 * inner, wall); n++) {
          let off = Infinity;
          for (let k = 1; k <= n; k++) {
            const p = -inner + 2 * inner * k / (n + 1);
            for (const f of [p - wall / 2, p + wall / 2]) off = Math.min(off, Math.abs(f - front));
          }
          if (off >= 0.001 && off < 0.02)
            rows.push([`${v} deep, wall ${wall}, ${label} mm shelf, ${n} along`, { u: 0.5, v, hUnits: 6, wall, label, divY: n }]);
        }
      }
    }
  const fails = [], some = rows.filter((_, i) => i % 5 === 0);
  for (const [name, cfg] of some) {
    const polys = buildBin(G, cfg).polys, b5 = weldBad(polys, 0.005), b10 = weldBad(polys, 0.01);
    if (b5 || b10) fails.push(`${name}: ${b5} edges at 5 µm, ${b10} at 10 µm`);
  }
  console.log(`  ${`${some.length} just off its front`.padEnd(34)} ` + (!some.length ? 'NONE FOUND to build'
    : fails.length ? `FAILED ${fails.length} welded, among them ${fails.slice(0, 3).join('; ')}`
    : 'welded at 5 and 10 µm, all clean'));
  if (!some.length || fails.length) bad++;
}
/* With a note raised on it the shelf stands a millimetre lower, and on a short bin it is
   shallower too: on a 2-unit bin it is 7 mm deep where a plain one is 8. So a fixed
   divider whose back comes to the raised shelf's front has to run on into that front,
   not the plain one's. Missing it leaves no shared edge, as the shelf's top is a
   millimetre under the divider's, so neither checkManifold nor a weld finds it: the
   divider stands flush against the shelf's front, or a slit of up to 10 x WELD short of
   it (a 1x1x2 with a 3.375 mm wall, a 10 mm shelf and 3 along stood flush; with a 3.36
   mm wall and a 7.5 mm shelf, 15 µm short). So the divider's back is measured where it
   is built, at the rim, against the front of the shelf shelfNote says the note is on,
   every 5 µm of wall on 2- and 3-unit bins, wherever the note still prints with the
   dividers in. Each one from flush to 20 µm short must reach a BLOAT into the shelf. The count of those flush and short is printed and must
   not be zero. */
{
  const WELD = 0.002, BLOAT = 0.05;
  const most = (inside, wall) => Math.max(0, Math.floor(inside / Math.max(wall, 1.2)) - 1);
  // the furthest back the bin reaches at its rim this near the shelf's front: the divider
  const builtBack = (cfg, from, front) => {
    const H = cfg.hUnits * SPEC.unitH;
    let back = -Infinity;
    for (const t of G.polysToTriangles(buildBin(G, cfg).polys))
      for (const [, y, z] of t)
        if (Math.abs(z - H) < 1e-6 && y >= from - 1e-6 && y <= front + 2 * BLOAT) back = Math.max(back, y);
    return back;
  };
  const rows = [
    ['1x1x2, wall 3.375, 10 mm shelf, 3 along', { u: 1, v: 1, hUnits: 2, wall: 3.375, label: 10, labelMode: 1, note: 'M3', divY: 3 }],
    ['1x1x2, wall 3.36, 7.5 mm shelf, 3 along', { u: 1, v: 1, hUnits: 2, wall: 3.36, label: 7.5, labelMode: 1, note: 'M3', divY: 3 }],
  ].map(([name, cfg]) => [name, cfg, null]);
  for (const v of [0.5, 1, 1.5, 2])
    for (const hUnits of [2, 3])
      for (const label of [7.5, 10, 15])
        for (let w = 80; w <= 1000; w++) {
          const wall = w / 200, inner = (v - 1) * SPEC.pitch / 2 + 20.75 - wall;
          const cfg = { u: 1, v, hUnits, wall, label, labelMode: 1, note: 'M3' };
          const note = shelfNote(cfg);
          if (!note.fit) continue;
          const front = inner - note.depth;
          for (let n = 1; n <= most(2 * inner, wall); n++) {
            if (2 * inner / (n + 1) - wall < 0.5) break;
            for (let k = 1; k <= n; k++) {
              const back = -inner + 2 * inner * k / (n + 1) + wall / 2;
              // only where the note still prints with them, on a shelf as deep
              const withDivs = Object.assign({}, cfg, { divY: n }), raised = shelfNote(withDivs);
              if (back >= front - 10 * WELD && back <= front + 1e-6 && raised.fit &&
                  Math.abs(raised.depth - note.depth) < 1e-9)
                rows.push([`${v} deep x${hUnits}, wall ${wall}, ${label} mm shelf, ${n} along`, withDivs, back]);
            }
          }
        }
  let flush = 0;
  const fails = [], some = rows.filter((r, i) => !r[2] || i % 3 === 0);
  for (const [name, cfg, at] of some) {
    const raised = shelfNote(cfg), inner = (cfg.v - 1) * SPEC.pitch / 2 + 20.75 - cfg.wall;
    const front = inner - raised.depth, from = at === null ? front - 10 * WELD : at;
    if (!raised.fit) { fails.push(`${name}: its note is not raised`); continue; }
    if (Math.abs(from - front) < 1e-6) flush++;
    const back = builtBack(cfg, from, front);
    if (!(back >= front + BLOAT - 1e-6))
      fails.push(`${name}: back ${back === -Infinity ? 'not found' : `${((back - front) * 1000).toFixed(1)} µm from`} the shelf's front`);
  }
  console.log(`  ${`${flush} flush, ${some.length - flush} short of a raised one`.padEnd(34)} ` +
    (some.length < 3 || !flush ? 'NONE FOUND to build' : fails.length
      ? `FAILED ${fails.length} of ${some.length}, among them ${fails.slice(0, 3).join('; ')}`
      : `${some.length} builds, each run into the shelf`));
  if (some.length < 3 || !flush || fails.length) bad++;
}

console.log('\nremovable dividers both ways, at every count up to the most that fit');
/* Removable both ways, the end rails of the two directions end beside each other, each a
   rail's depth and the clearance out from its wall. Where the end spacing on both axes was
   a rail and that reach, half a plate, twice the clearance and 2.4 mm, the tip of the end
   divY rail came to the outer face of the end divX rail at that rail's own tip, and the
   two shared a vertical edge, used four times: a 1x1 with a 0 or 0.4 mm wall at 10 each
   way, a half-cell square with a 1 mm wall at 4, a 2x2 with a 2.9 mm wall at 20 and a 3x3
   with a 1.7 mm wall at 32, all at the usual plate and clearance. The both-ways rows of
   "as many dividers as the fields allow" build only the most the fields allow, which the
   limit holds to 11 each way on a 1x1, and so never built them. So those bins are built
   at every count up to the most that fit. Then, worked out here from what the bin is
   meant to be rather than read from bin.js, every size from a half-cell square to a 3x3,
   square or not, at every wall, plate and clearance the fields allow, takes the counts
   that put the end spacing on both axes within a micron of that reach and a rail, or of
   a rail's depth and a rail, where the tips stood when the rails reached only a rail's
   depth. Those that are built as asked are kept, and one in three of them is built. The
   count found is printed and must not be zero, or the sweep would pass while building
   none of what it is for. Last, as for the label shelf above, the counts that put it
   from a micron to 20 µm off, at the reach the rails have now, are welded at 5 and at
   10 µm, one in 250 of them: with the tips run on only within WELD of a face, 7 of those
   47 came apart so. */
{
  const rows = [];
  for (const [s, walls] of [[0.5, [0.4, 1, 2]], [1, [0, 0.4, 1, 1.7]], [2, [1, 1.7, 2.9]], [3, [0.4, 1.7, 2.9]]])
    for (const wall of walls) {
      const cfg = { u: s, v: s, hUnits: 2, wall, divRemovable: true };
      const top = dividersBuilt(Object.assign({ divX: 999, divY: 999 }, cfg));
      for (let k = 1; k <= Math.max(top.divX, top.divY); k++)
        rows.push([`${s}x${s} wall ${wall} x${k}`, Object.assign({ divX: k, divY: k }, cfg)]);
    }
  sweepReport('every count, the usual plate', rows);
}
{
  const field = (cells, wall) => Math.max(0, Math.floor(((cells - 1) * 42 + 41.5 - 2 * wall) / Math.max(wall, 1.2)) - 1);
  const sizes = [0.5, 1, 1.5, 2, 2.5, 3], rows = [], near = [];
  let found = 0, close = 0;
  for (const u of sizes) for (const v of sizes)
    for (let w = 0; w <= 100; w++) {
      const wall = w / 10, ix = (u - 1) * 21 + 20.75 - Math.max(0.4, wall), iy = (v - 1) * 21 + 20.75 - Math.max(0.4, wall);
      for (let t = 8; t <= 50; t += 2)
        for (let cl = 0; cl <= 100; cl += 5) {
          const divT = t / 10, divClr = cl / 100;
          for (const reach of new Set([1.2 + divClr, 1.2])) {
            const K = divT / 2 + divClr + 1.2 + reach;
            const nx = Math.round(2 * ix / K - 1), ny = Math.round(2 * iy / K - 1);
            if (nx < 1 || ny < 1 || nx > field(u, wall) || ny > field(v, wall)) continue;
            const off = Math.max(Math.abs(2 * ix / (nx + 1) - K), Math.abs(2 * iy / (ny + 1) - K));
            const on = off <= 0.001, by = !on && off < 0.02 && reach > 1.2 + divClr - 1e-9;
            if (!on && !by) continue;
            const cfg = { u, v, hUnits: 3, wall, divX: nx, divY: ny, divRemovable: true, divT, divClr };
            const built = dividersBuilt(cfg);
            if (built.divX !== nx || built.divY !== ny) continue;
            const name = `${u}x${v} wall ${wall}, ${divT} mm plate ${divClr} clear, ${nx}+${ny}`;
            if (on && found++ % 3 === 0) rows.push([name, cfg]);
            if (by && close++ % 250 === 0) near.push([name, cfg]);
          }
        }
    }
  const fails = rows.map(([name, cfg]) => { const f = cleanBuild(cfg); return f ? `${name}: ${f}` : ''; })
    .filter(Boolean);
  console.log(`  ${`${found} with both on a face`.padEnd(34)} ` + (!found
    ? 'NONE FOUND to build' : fails.length ? `FAILED ${fails.length} of ${rows.length}, ` +
      `among them ${fails.slice(0, 4).join('; ')}` : `${rows.length} builds, all clean`));
  const welds = [];
  for (const [name, cfg] of near) {
    const polys = buildBin(G, cfg).polys, b5 = weldBad(polys, 0.005), b10 = weldBad(polys, 0.01);
    if (b5 || b10) welds.push(`${name}: ${b5} edges at 5 µm, ${b10} at 10 µm`);
  }
  console.log(`  ${`${near.length} of ${close} just off one`.padEnd(34)} ` + (!near.length ? 'NONE FOUND to build'
    : welds.length ? `FAILED ${welds.length} welded, among them ${welds.slice(0, 3).join('; ')}`
    : 'welded at 5 and 10 µm, all clean'));
  if (!found || fails.length || !near.length || welds.length) bad++;
}

/* The lone divider keeps ten times WELD over the room it needs for the rails the other
   way, as well as room for them. Without the margin a half-cell square with a 4.65 mm
   wall, one each way at a 5 mm plate and 0.95 clearance, was built 1 + 1 with the tips of
   each one's rails flush on the other's slot face: a rail each way on one corner edge,
   used four times. With it, neither is built. A wall of 4.65 can be typed, or come in a
   link; on the field's 0.1 steps the margin never decides it, so nothing above builds it. */
{
  const cfg = { u: 0.5, v: 0.5, hUnits: 3, wall: 4.65, divX: 1, divY: 1, divRemovable: true, divT: 5, divClr: 0.95 };
  const built = dividersBuilt(cfg), b = G.checkManifold(buildBin(G, cfg).polys).bad;
  const ok = built.divX === 0 && built.divY === 0 && b === 0;
  console.log(`  ${'one each way at the margin'.padEnd(34)} ` + (ok ? 'none built, no bad edges'
    : `FAILED: built ${built.divX} + ${built.divY}, ${b} bad edges`));
  if (!ok) bad++;
}

console.log('\ndivider boxes cut to the cavity\'s rounded corner');
/* A divider or rail box that would stand out through a rounded corner is the cavity's
   outline cut to the box, and both of the faults that cut could make leave the mesh
   watertight. An outline vertex a micron or two inside a cut line made a sliver of the
   cap, 0.20 µm across at the thinnest; and a vertex on the cut line could be the one
   thinned away instead of the one beside it, leaving the side along the line leaning by
   up to 1.6 µm, where every side of a box is square to an axis. So every box's bottom cap
   is measured for its thinnest triangle, and every side standing from the bottom to the
   top for one that is nearly square to an axis without being so, over thin walls with
   dividers and rails both ways, at the three smoothnesses the page offers. The count of
   bins with a box cut to the outline is printed and must not be zero. */
{
  const most = (inside, wall) => Math.max(0, Math.floor(inside / Math.max(wall, 1.2)) - 1);
  const altitude = (t) => {
    const ab = [0, 1, 2].map((i) => t[1][i] - t[0][i]), ac = [0, 1, 2].map((i) => t[2][i] - t[0][i]);
    const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return Math.hypot(...cr) / Math.max(len(t[0], t[1]), len(t[1], t[2]), len(t[2], t[0]));
  };
  let thin = Infinity, lean = 0, cutBins = 0, n = 0, thinAt = '', leanAt = '';
  for (const arcSegs of [8, 12, 24])
    for (const [u, v] of [[1, 1], [0.5, 1], [1.5, 1]])
      for (const wall of [0.4, 0.6, 0.8, 1])
        for (const divRemovable of [false, true])
          for (const share of [0.5, 0.75, 1]) {
            const nx = Math.max(1, Math.round(share * most((u - 1) * 42 + 41.5 - 2 * wall, wall)));
            const ny = Math.max(1, Math.round(share * most((v - 1) * 42 + 41.5 - 2 * wall, wall)));
            for (const [divX, divY] of [[nx, 0], [0, ny]]) {
              const cfg = { u, v, hUnits: 3, wall, divX, divY, divRemovable, arcSegs }, what = JSON.stringify(cfg);
              const r = buildBin(G, cfg), zb = r.meta.floorZ - 0.05, H = 3 * SPEC.unitH;   // boxes start a BLOAT down
              let anyCut = false;
              n++;
              for (const p of r.polys) {
                const w = p.verts;
                if (w.length === 3 && w.every((q) => Math.abs(q[2] - zb) < 1e-9)) {
                  const a = altitude(w);
                  if (a < thin) { thin = a; thinAt = what; }
                }
                if (w.length === 4 && Math.abs(w[0][2] - zb) < 1e-9 && Math.abs(w[2][2] - H) < 1e-9) {
                  const dx = Math.abs(w[1][0] - w[0][0]), dy = Math.abs(w[1][1] - w[0][1]);
                  if (dx > 0 && dy > 0) anyCut = true;            // a side along the outline
                  const off = Math.min(dx, dy);
                  if (off > 0 && off < 1e-3 * Math.max(dx, dy) && off > lean) { lean = off; leanAt = what; }
                }
              }
              if (anyCut) cutBins++;
            }
          }
  const ok = cutBins > 0 && thin >= 1e-3 && lean === 0;
  console.log(`  ${n} bins, ${cutBins} with a box cut to the outline: ` + (!cutBins ? 'NONE CUT, so nothing was measured'
    : `thinnest cap triangle ${(thin * 1000).toFixed(2)} µm${thin < 1e-3 ? ` (UNDER 1 µm: ${thinAt})` : ''}, ` +
      (lean ? `a side LEANING by ${(lean * 1000).toFixed(3)} µm: ${leanAt}` : 'no side leaning')));
  if (!ok) bad++;
}

console.log('\nthe outline at other smoothnesses and with extra clearance');
/* outsideBy measures against the corners' chords at the bin's own smoothness and inside
   its extra clearance, so it is held to seeing what the arc could not: a vertex on the
   true arc halfway along a chord, and one standing out of the clearance but not the
   spec. Then bins with everything that reaches a corner are built at both ends of the
   smoothness the engine takes and with clearance, and must stand inside it. */
{
  const at = (x, y) => ({ polys: [{ verts: [[x, y, 10]] }] });
  const C = SPEC.centre, sees = [];
  for (const arcSegs of [8, 12]) {
    const a = Math.PI / (4 * arcSegs), sag = SPEC.r * (1 - Math.cos(a));
    const o = outsideBy(at(C + SPEC.r * Math.cos(a), C + SPEC.r * Math.sin(a)), { u: 1, v: 1, arcSegs });
    sees.push([`under a chord at ${arcSegs}`, o, sag]);
  }
  sees.push(['0.2 mm into a 0.3 mm clearance', outsideBy(at(SPEC.half - 0.1, 0), { u: 1, v: 1, shrink: 0.3 }), 0.2]);
  const blind = sees.filter(([, o, want]) => Math.abs(o - want) > 1e-9);
  console.log('  ' + sees.map(([what, o]) => `${what}: ${(o * 1000).toFixed(1)} µm out`).join('; '));
  if (blind.length) { console.log(`  outsideBy MISSED ${blind.map(([w]) => w).join(', ')}`); bad++; }
  const most = (inside, wall) => Math.max(0, Math.floor(inside / Math.max(wall, 1.2)) - 1);
  const rows = [];
  for (const [u, v] of [[1.5, 1], [0.5, 1]])
    for (const arcSegs of [4, 8, 24, 48])
      for (const shrink of [0.25, 0.5])
        for (const divRemovable of [false, true]) {
          const wall = 0.4, divX = most((u - 1) * 42 + 41.5 - 2 * wall, wall), divY = most((v - 1) * 42 + 41.5 - 2 * wall, wall);
          rows.push([`${u}x${v} at ${arcSegs}, ${shrink} clear${divRemovable ? ', rails' : ''}`,
                     { u, v, hUnits: 3, wall, arcSegs, shrink, divX, divY, divRemovable, scoop: 8, label: 10 }]);
        }
  sweepReport('packed, scoop and label', rows);
}

console.log('\nremovable dividers: every plate goes into its slot');
/* A removable divider is a slot between two rails on each wall it runs between, and the
   plate dividerPart makes, dropped into it from above. It goes in only if nothing stands
   in its way, all the way down. Spaced closer than a slot and a rail apart, a neighbour's
   rail stands in the slot and takes from its clearance: the fields allowed 31 on a 1x1,
   and at 11 a plate went in with 0.208 mm of clearance where 0.25 was asked for, at 12 not
   at all. With a thin plate and little clearance the end plates' corners stood in the
   cavity's rounded corners, up to 0.26 mm into the wall at a 0.8 mm plate and 0.1
   clearance. And three things stood over every plate whatever the spacing: the stacking
   lip's chamfer over its ends, about a millimetre at the usual wall; the scoop where a
   plate across met the floor at the front, and the label shelf over its top at the back;
   and, with removable dividers both ways, the plates of the other direction.

   So each plate a bin is built for must have some length: where the clearance at its
   ends took the whole cavity, a 1x0.5 with a 9.5 mm wall and 1 mm clearance listed a
   plate -0.5 mm long. Then it is taken as dividerPart makes it, outline and all, and
   moved straight down into its slot from above the top of the bin, lip included: the
   space it passes through on the way, everything above its bottom edge across its span
   and its thickness, must keep clear of every triangle of the bin, to a micron, and stay
   inside the cavity's rectangle, as a plate wholly inside a wall meets no triangle. The
   plates across go in first; the plates along come down over them, so they must keep
   clear of the plates across as well, standing in their slots. Each distinct plate is
   watertight, wound outwards, and as big as its outline times its thickness, which is
   what ties the outline swept here to the plate that is printed.

   The slot itself, the room the plate has to move by the clearance either way, must be
   clear of the walls of the bin with no dividers, lip, scoop or shelf, and, moved down
   the same way as its plate, of every triangle of the bin as built: its rails, and the
   notches in the lip and the shelf, which are cut a little wider than the slot. Held
   only to having the plate's corner inside the cavity, the end ones kept 0.0014 mm of
   the 0.1 mm clearance asked at their corners on a 2x1 with a 1.2 mm wall, a 0.8 mm plate
   and 35 across. Held only to room for its own rails, a lone divider had the rails the
   other way 0.45 mm into each side of its 1 mm clearance on a half-cell bin with a 5 mm
   wall and a 5 mm plate, which only a bin with dividers both ways shows.

   Then each face of its slot, at each end of the plate, must have a rail standing from
   the floor to the rim along a full rail's depth of that end: the rails reached only a
   rail's depth from the wall while the plate stops the clearance short of it, so at 1 mm
   clearance a plate end sat 0.2 mm in its rails and could twist out. Each end is measured
   on its own: measured from the middle out, the far wall's rail counted for the near end,
   and a bin with rails on one wall only passed most of the rows.

   Asked for as many as the fields allow, a bin with no lip, scoop or shelf is built with
   as many as fit, and one more would not. One more is set out the same way in the same
   bin with no dividers, and fits if its plates have length, its slots and the rails that
   would hold them, a rail thick across and a rail's depth along, are clear of the walls
   and the floor, no two stand closer than a slot and a rail, and no slot stands where the
   rails the other way would: a rail's depth and the clearance from each end wall, and ten
   times WELD (0.02 mm) more so that their tips are not flush with its face. The limit for
   one way cannot know whether there will be any the other way, so it keeps clear of them
   either way. That only ever decides a lone divider, which has no neighbour, so what
   decides it is room for those rails: the limit once asked it for a neighbour's spacing,
   and built none on a half-cell bin with a 3 mm wall at a 5 mm plate, where one fits.
   Some of the rows below are just that. That is done at both ends of the plate and the
   clearance the page takes, and at its three smoothnesses, which set the corners' chords,
   and then with dividers both ways on half cells with thick walls and on whole cells
   with thin ones. Then lip, scoop and shelf each on and off, with dividers one way and
   both ways. There what the lip, the shelf and the other direction leave room for decides
   the count as well, and the Checks say which, so one more is not tried in them. */
{
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const triBox = (c, h, t) => {
    const v = t.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
    for (let a = 0; a < 3; a++)
      if (Math.min(v[0][a], v[1][a], v[2][a]) > h[a] || Math.max(v[0][a], v[1][a], v[2][a]) < -h[a]) return false;
    const apart = (ax) => {
      if (!ax[0] && !ax[1] && !ax[2]) return false;
      const p = v.map((q) => q[0] * ax[0] + q[1] * ax[1] + q[2] * ax[2]);
      const r = h[0] * Math.abs(ax[0]) + h[1] * Math.abs(ax[1]) + h[2] * Math.abs(ax[2]);
      return Math.min(...p) > r || Math.max(...p) < -r;
    };
    const e = [sub(v[1], v[0]), sub(v[2], v[1]), sub(v[0], v[2])];
    for (const ed of e) for (const u of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) if (apart(cross(u, ed))) return false;
    return !apart(cross(e[0], e[1]));
  };
  const trisOf = (polys) => G.polysToTriangles(polys).map((t) => ({ t,
    lo: [0, 1, 2].map((a) => Math.min(t[0][a], t[1][a], t[2][a])),
    hi: [0, 1, 2].map((a) => Math.max(t[0][a], t[1][a], t[2][a])) }));
  const near = (tris, lo, hi) => tris.filter(({ lo: a, hi: b }) =>
    a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1] && a[2] <= hi[2] && b[2] >= lo[2]);
  // whether any triangle reaches into the box lo..hi
  const blocked = (tris, lo, hi) => {
    const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2), h = [0, 1, 2].map((a) => (hi[a] - lo[a]) / 2);
    return near(tris, lo, hi).some(({ t }) => triBox(c, h, t));
  };
  const most = (inside, wall) => Math.max(0, Math.floor(inside / Math.max(wall, 1.2)) - 1);
  const RAIL_T = 1.2, RAIL_D = 1.2, E = 1e-6;
  /* A convex solid, given by its corners, the normals of its faces and the directions of
     its edges, against a triangle, by separating axes. Touching is apart, and so is
     overlapping by under E along any axis: a plate may stand on the floor, and with no
     clearance against its rails and the walls at its ends. */
  const meets = (P, t) => {
    const te = [sub(t[1], t[0]), sub(t[2], t[1]), sub(t[0], t[2])];
    const axes = P.normals.concat([cross(te[0], te[1])]);
    for (const d of P.dirs) for (const e of te) axes.push(cross(d, e));
    for (const ax of axes) {
      const l = Math.hypot(ax[0], ax[1], ax[2]);
      if (l < 1e-12) continue;
      let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
      for (const v of P.verts) { const s = dot(v, ax) / l; p0 = Math.min(p0, s); p1 = Math.max(p1, s); }
      for (const v of t) { const s = dot(v, ax) / l; q0 = Math.min(q0, s); q1 = Math.max(q1, s); }
      if (p1 <= q0 + E || q1 <= p0 + E) return false;
    }
    return true;
  };
  /* Triangles bucketed on a 2 mm grid in plan, so a plate's sweep is tested against the
     few under its own footprint rather than every one in the bin. */
  const indexOf = (tris) => {
    const C = 2, cells = new Map();
    tris.forEach((tr, i) => {
      for (let gx = Math.floor(tr.lo[0] / C); gx <= Math.floor(tr.hi[0] / C); gx++)
        for (let gy = Math.floor(tr.lo[1] / C); gy <= Math.floor(tr.hi[1] / C); gy++) {
          const k = gx * 100003 + gy;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(i);
        }
    });
    return (lo, hi) => {
      const seen = new Set(), out = [];
      for (let gx = Math.floor(lo[0] / C); gx <= Math.floor(hi[0] / C); gx++)
        for (let gy = Math.floor(lo[1] / C); gy <= Math.floor(hi[1] / C); gy++)
          for (const i of cells.get(gx * 100003 + gy) || []) if (!seen.has(i)) { seen.add(i); out.push(tris[i]); }
      return near(out, lo, hi);
    };
  };
  const hits = (index, P) => index(P.lo, P.hi).find(({ t }) => meets(P, t));
  /* The space a plate passes through coming straight down to its seat: everything above
     its bottom edge, up to Z, across its thickness w0..w1. Convex pieces, one over each
     piece of the bottom edge that runs along the plate. `frame` takes a point along the
     plate, up it and through it to the bin's x, y and z. */
  const swept = (bottom, w0, w1, Z, frame) => {
    const out = [];
    for (let i = 1; i < bottom.length; i++) {
      const [ua, za] = bottom[i - 1], [ub, zb] = bottom[i];
      if (ub <= ua) continue;
      const verts = [];
      for (const w of [w0, w1]) for (const [u, z] of [[ua, za], [ub, zb], [ub, Z], [ua, Z]]) verts.push(frame(u, z, w));
      const o = frame(0, 0, 0), dir = (u, z, w) => sub(frame(u, z, w), o);
      const W = dir(0, 0, 1), U = dir(1, 0, 0), Up = dir(0, 1, 0), slope = dir(ub - ua, zb - za, 0);
      out.push({ verts, normals: [W, U, Up, cross(slope, W)], dirs: [W, U, Up, slope],
                 lo: [0, 1, 2].map((a) => Math.min(...verts.map((v) => v[a])) + E),
                 hi: [0, 1, 2].map((a) => Math.max(...verts.map((v) => v[a])) - E) });
    }
    return out;
  };
  // the bottom edge of an anticlockwise outline that starts at its lower end: up to the far end
  const bottomOf = (ol) => {
    const top = Math.max(...ol.map((p) => p[0]));
    return ol.slice(0, ol.findIndex((p) => p[0] === top) + 1);
  };
  const outlineOf = (m, zf) => m.outline ||
    [[-m.span / 2, zf], [m.span / 2, zf], [m.span / 2, zf + m.tall], [-m.span / 2, zf + m.tall]];
  /* Each distinct plate: closed, wound outwards, and its outline times its thickness. The
     plain one is the rectangle it always was. */
  const meshSeen = new Map();
  const meshFault = (d) => {
    const key = JSON.stringify([d.meta.outline || [d.meta.span, d.meta.tall], d.meta.t]);
    if (meshSeen.has(key)) return meshSeen.get(key);
    const m = G.checkManifold(d.polys), ori = checkOrientation(d.polys);
    const area = d.meta.outline ? Math.abs(G.polyArea2D(d.meta.outline)) : d.meta.span * d.meta.tall;
    const f = [m.bad ? `${m.bad} bad edges` : '', ori.ok ? '' : orientationNote(ori),
               Math.abs(ori.volume - area * d.meta.t) > 1e-6 * area * d.meta.t
                 ? `${ori.volume.toFixed(3)} mm3, its outline ${(area * d.meta.t).toFixed(3)}` : '']
      .filter(Boolean).join(', ');
    meshSeen.set(key, f);
    return f;
  };
  const innerOf = (c, ax) => (ax ? (c.v - 1) * 21 + 20.75 : (c.u - 1) * 21 + 20.75) - Math.max(0.4, c.wall);
  const bare = new Map();
  /* The plates of n dividers along axis ax (0: the ones across, at a fixed x), as boxes
     each with where its slot's faces are. A plate may touch the floor it stands on and,
     with no clearance, the walls at its ends, so it is a micron short of both; through
     its thickness it is grown by `grow`, a micron either way. */
  const platesOf = (c, r, n, ax, grow) => {
    const inner = innerOf(c, ax);
    const d = dividerPart(G, c, ax ? 'x' : 'y').meta, floor = r.meta.floorZ + 0.05;
    const out = [];
    for (let k = 1; k <= n; k++) {
      const p = -inner + (2 * inner) * k / (n + 1);
      const lo = [0, 0, floor + E], hi = [0, 0, floor + d.tall - E];
      lo[ax] = p - d.t / 2 - grow; hi[ax] = p + d.t / 2 + grow;
      lo[1 - ax] = -d.span / 2 + E; hi[1 - ax] = d.span / 2 - E;
      out.push({ k, p, lo, hi, end: d.span / 2, faces: [p - d.slot / 2, p + d.slot / 2] });
    }
    return out;
  };
  /* Where a plate's rails must stand to hold it, a micron inside: a rail thick out from
     each face of its slot, and a rail's depth back from each end of the plate, floor to
     rim. Or the plate's whole half, when that is shorter than a rail's depth. */
  // the slot a plate stands in, from face to face, grown by `grow` across it
  const slotOf = (pl, ax, grow) => {
    const lo = pl.lo.slice(), hi = pl.hi.slice();
    lo[ax] = pl.faces[0] - grow; hi[ax] = pl.faces[1] + grow;
    return { lo, hi };
  };
  const railsOf = (pl, ax, H) => {
    const out = [], along = Math.min(RAIL_D, pl.end);
    for (const [a, b] of [[pl.faces[0] - RAIL_T, pl.faces[0]], [pl.faces[1], pl.faces[1] + RAIL_T]])
      for (const [c, d] of [[-pl.end, -pl.end + along], [pl.end - along, pl.end]]) {
        const lo = [0, 0, pl.lo[2]], hi = [0, 0, H - E];
        lo[ax] = a + E; hi[ax] = b - E; lo[1 - ax] = c + E; hi[1 - ax] = d - E;
        out.push({ lo, hi });
      }
    return out;
  };
  let least = Infinity, lone = 0, short = 0;
  const faults = (cfg, oneMore) => {
    const c = Object.assign({}, BIN_DEFAULTS, cfg), H = c.hUnits * SPEC.unitH;
    const r = buildBin(G, cfg), tris = trisOf(r.polys), binAt = indexOf(tris), built = dividersBuilt(cfg), out = [];
    /* The bin with no dividers, and no lip, scoop or shelf either, which stand over a
       slot only where it is notched or its plate cut: its walls and floor alone. The rows
       that share one come together, so only the last few are kept: kept for every row,
       they held gigabytes. */
    const bareKey = JSON.stringify(Object.assign({}, cfg, { divX: 0, divY: 0, divRemovable: false, lip: false, scoop: 0, label: 0 }));
    if (!bare.has(bareKey)) {
      if (bare.size >= 8) bare.delete(bare.keys().next().value);
      bare.set(bareKey, trisOf(buildBin(G, JSON.parse(bareKey)).polys));
    }
    /* Clear of every triangle, and inside the cavity's rectangle: a box wholly inside a
       wall meets no triangle either. */
    const room = [innerOf(c, 0), innerOf(c, 1)];
    const inside = (box) => [0, 1].every((a) => box.lo[a] >= -room[a] && box.hi[a] <= room[a]);
    const clear = (box) => inside(box) && !blocked(bare.get(bareKey), box.lo, box.hi);
    let Z = -Infinity;
    for (const p of r.polys) for (const v of p.verts) Z = Math.max(Z, v[2]);
    Z += 1;
    const zf = r.meta.floorZ + 0.05, lay = plateLayout(cfg, built);
    const seated = [];            // the plates across, standing in their slots
    let seatedAt = null, plates = 0;
    for (const [key, ax] of [['divX', 0], ['divY', 1]]) {
      const n = built[key], inner = innerOf(c, ax), pitch = c.divT + 2 * c.divClr + RAIL_T;
      if (n > (c[key] || 0)) out.push(`${n} ${key} built of ${c[key]} asked`);
      if (n === 1 && inner < pitch) lone++;
      // rail faces standing on the plane ax = x, as [x, from, to] along the other axis
      const faces = [];
      for (const p of r.polys) {
        const w = p.verts, x = w[0][ax];
        if (!w.every((q) => Math.abs(q[ax] - x) < 1e-9)) continue;
        const zs = w.map((q) => q[2]), as = w.map((q) => q[1 - ax]);
        if (Math.min(...zs) <= zf + E && Math.max(...zs) >= H - E)
          faces.push([x, Math.min(...as), Math.max(...as)]);
      }
      const frame = ax ? (u, z, w) => [u, w, z] : (u, z, w) => [w, u, z];
      for (const pl of platesOf(c, r, n, ax, -E)) {
        const d = dividerPart(G, cfg, ax ? 'x' : 'y', pl.k), m = d.meta, what = `${key} plate ${pl.k} of ${n}`;
        if (m.tall < 1) continue;            // the page lists no plate this short
        plates++;
        if (pl.end < RAIL_D) short++;
        if (!(2 * pl.end >= 1 - 1e-9)) { out.push(`${what} has a length of ${(2 * pl.end).toFixed(2)} mm, under 1 mm`); continue; }
        if (m.at !== undefined && Math.abs(m.at - pl.p) > 1e-9) { out.push(`${what} made for ${m.at.toFixed(3)}, stands at ${pl.p.toFixed(3)}`); continue; }
        const mf = meshFault(d);
        if (mf) { out.push(`${what}: ${mf}`); continue; }
        if (!inside(pl)) { out.push(`${what} blocked, into a wall`); continue; }
        // its room to move by the clearance either way: clear of the walls, then of every rail
        if (!clear(slotOf(pl, ax, -E))) { out.push(`${what} has its slot in a corner`); continue; }
        /* The plate, and its slot face to face, each moved down from above the bin to the
           seat. A plate along over the scoop stands on it at its front face, and moved
           forward by its clearance would stand that much higher up the scoop's slope: its
           slot comes down to the scoop at the slot's front face, which is not in its way. */
        const bottom = bottomOf(outlineOf(m, zf));
        const P = swept(bottom, pl.p - m.t / 2, pl.p + m.t / 2, Z, frame);
        const rise = ax && lay.r ? lay.S(pl.faces[0]) : -Infinity;
        const S = swept(bottom.map(([u, z]) => [u, Math.max(z, rise)]), pl.faces[0], pl.faces[1], Z, frame);
        if (ax && !seatedAt) seatedAt = indexOf(seated);
        const where = (pc) => pc.lo.map((x, a) => ((x + pc.hi[a]) / 2).toFixed(1)).join(', ');
        const bin = P.find((pc) => hits(binAt, pc));
        if (bin) { out.push(`${what} blocked going in, near ${where(bin)}`); continue; }
        const room = S.find((pc) => hits(binAt, pc));
        if (room) { out.push(`${what} has the bin in its clearance going in, near ${where(room)}`); continue; }
        const plate = ax && P.find((pc) => hits(seatedAt, pc));
        if (plate) { out.push(`${what} meets a plate across going in, near ${where(plate)}`); continue; }
        // each face of the slot, at each end on its own: from the middle to that end
        const need = Math.min(RAIL_D, pl.end) - 1e-6;
        for (const x of pl.faces) for (const s of [-1, 1]) {
          const hold = Math.max(0, ...faces.filter((f) => Math.abs(f[0] - x) < 1e-7)
            .map(([, a, b]) => (s > 0 ? Math.min(b, pl.end) - Math.max(a, 0) : Math.min(b, 0) - Math.max(a, -pl.end))));
          if (pl.end >= RAIL_D) least = Math.min(least, hold);
          if (hold < need) { out.push(`${what} held ${hold.toFixed(2)} mm at one end`); break; }
        }
        if (!ax) {
          const zc = m.zc !== undefined ? m.zc : zf + m.tall / 2;
          seated.push(...trisOf(d.polys.map((q) => ({ verts: q.verts.map(([x, y, z]) => frame(x, y + zc, pl.p - m.t / 2 + z)) }))));
        }
      }
      /* one more: crowded by a neighbour, its slots or their rails into a wall of the bare
         bin, a slot where the rails the other way would stand, or a plate under 1 mm long */
      if (oneMore && n < (c[key] || 0)) {
        const k = n + 1, crowded = k > 1 && 2 * inner / (k + 1) < pitch - 1e-9;
        const reach = RAIL_D + c.divClr + 0.02;
        if (!crowded && platesOf(c, r, k, ax, E).every((pl) => 2 * pl.end >= 1 - 1e-9 && clear(slotOf(pl, ax, E)) &&
            railsOf(pl, ax, H).every(clear) && pl.faces[0] >= -inner + reach - 1e-9 && pl.faces[1] <= inner - reach + 1e-9))
          out.push(`${key}: ${k} would have fit, ${n} built`);
      }
    }
    return { out, plates, r };
  };
  const kindOf = (t) => (/^the bin:/.test(t) ? 'the bin'
    : (t.match(/\b(length|blocked|corner|clearance|meets a plate across|held|would have fit|asked|made for)\b/) || ['', 'the plate'])[1]);
  /* A row may ask for the whole bin to be checked too, watertight and wound: see
     cleanBuild. A lone divider is only looked for where one more is tried. */
  const report = (label, rows, oneMore) => {
    let plates = 0;
    least = Infinity; lone = 0; short = 0;
    const fails = [], kinds = {};
    for (const [name, cfg, clean] of rows) {
      const f = faults(cfg, oneMore);
      plates += f.plates;
      const mesh = clean ? cleanBuild(cfg, f.r) : '';
      if (mesh) f.out.unshift(`the bin: ${mesh}`);
      if (f.out.length) fails.push(`${name}: ${f.out[0]}${f.out.length > 1 ? ` and ${f.out.length - 1} more` : ''}`);
      for (const k of new Set(f.out.map(kindOf))) kinds[k] = (kinds[k] || 0) + 1;
    }
    console.log(`  ${label}: ${rows.length} bins, ${plates} plates` +
      `${oneMore ? `, ${lone} with one divider where two would not go` : ''}: ` + (fails.length
      ? `${fails.length} FAILED (${Object.entries(kinds).map(([k, n]) => `${k} in ${n}`).join(', ')}), ` +
        `${fails.slice(0, 4).join('; ')}${fails.length > 4 ? ` and ${fails.length - 4} more` : ''}`
      : oneMore && !lone ? 'NONE with a lone divider, so that was not tried'
      : `every one in its slot, each end held ${least.toFixed(2)} mm or more` +
        `${short ? `, or along its whole half in the ${short} shorter than two rails' depth` : ''}`));
    if (fails.length || (oneMore && !lone)) bad++;
  };
  const rows = [];
  const pairs = [[1.6, 0.25], [0.8, 0], [0.8, 0.1], [0.8, 1], [5, 0], [5, 1]];
  const label = (u, v, wall, n, key, divT, divClr, arcSegs) => `${u}x${v} wall ${wall}, ${n} ` +
    `${key === 'divX' ? 'across' : 'along'}${divT === 1.6 && divClr === 0.25 ? '' : `, ${divT} mm plate ${divClr} clear`}` +
    `${arcSegs === 12 ? '' : ` at ${arcSegs}`}`;
  for (const [divT, divClr] of pairs)
    for (const arcSegs of [8, 12, 24])
      for (const [a, b] of [[0.5, 1], [1, 1], [1.5, 1], [2, 1], [3, 1]])
        for (const wall of [0.4, 0.8, 1.2, 2, 3.5, 5])
          for (const key of ['divX', 'divY']) {
            const top = most((a - 1) * 42 + 41.5 - 2 * wall, wall);
            const [u, v] = key === 'divX' ? [a, b] : [b, a];
            for (const n of new Set([top, Math.ceil(top / 2)])) if (n)
              rows.push([label(u, v, wall, n, key, divT, divClr, arcSegs),
                         { u, v, hUnits: 3, wall, divRemovable: true, lip: false, divT, divClr, arcSegs, [key]: n }]);
          }
  /* Half a cell across with thick walls: room for one divider and its rails, or for none;
     and the plates spanning that half cell, as short as the rails are deep or shorter,
     where the rails from its two walls meet and are one rib across. */
  for (const [divT, divClr] of pairs)
    for (const wall of [2.5, 3, 4, 5, 6, 7, 8, 9, 9.5, 10])
      for (const key of ['divX', 'divY'])
        for (const [a, b] of [[0.5, 1], [2, 0.5]]) {
          const top = most((a - 1) * 42 + 41.5 - 2 * wall, wall), [u, v] = key === 'divX' ? [a, b] : [b, a];
          for (const n of new Set([1, top])) if (n)
            rows.push([label(u, v, wall, n, key, divT, divClr, 12),
                       { u, v, hUnits: 3, wall, divRemovable: true, lip: false, divT, divClr, arcSegs: 12, [key]: n }]);
        }
  /* A plate under a millimetre long is no plate, as one under a millimetre tall is not
     listed: a 1 x 0.5 with a 9.9 mm wall at 0.3 mm clearance listed one 0.1 mm long. None
     is built, nor rails for it, where the clearance leaves it under 1 mm, and one is where
     it leaves 1 mm or more: walls either side of that, at the usual clearance and at 0.3,
     each way. */
  for (const divClr of [0.25, 0.3])
    for (const wall of [9.4, 9.5, 9.6, 9.7, 9.8, 9.9])
      for (const key of ['divX', 'divY']) {
        const [u, v] = key === 'divX' ? [1, 0.5] : [0.5, 1];
        rows.push([label(u, v, wall, 1, key, 1.6, divClr, 12),
                   { u, v, hUnits: 3, wall, divRemovable: true, lip: false, divT: 1.6, divClr, arcSegs: 12, [key]: 1 }]);
      }
  /* Both ways at once: the rails the other way stand along each end wall, a rail's depth
     and the clearance out from it, and must keep out of every slot. On a half cell with a
     thick wall the one divider there is room for stands near them; on whole cells with
     thin walls the end ones of both ways crowd the same corners. */
  const both = (u, v, wall, nx, ny, divT, divClr) => rows.push([`${u}x${v} wall ${wall}, ${nx} across and ${ny} along` +
    `${divT === 1.6 && divClr === 0.25 ? '' : `, ${divT} mm plate ${divClr} clear`}`,
    { u, v, hUnits: 3, wall, divRemovable: true, lip: false, divT, divClr, arcSegs: 12, divX: nx, divY: ny }]);
  for (const [divT, divClr] of pairs) {
    for (const wall of [2.5, 3, 4, 5, 5.5, 6, 7, 7.5, 8, 8.5, 9])
      for (const [u, v] of [[0.5, 1], [1, 0.5], [0.5, 0.5]]) {
        const tx = most((u - 1) * 42 + 41.5 - 2 * wall, wall), ty = most((v - 1) * 42 + 41.5 - 2 * wall, wall);
        for (const nn of new Set([[1, ty], [tx, 1], [tx, ty]].filter(([x, y]) => x && y).map(String)))
          both(u, v, wall, ...nn.split(',').map(Number), divT, divClr);
      }
    for (const wall of [0.4, 1.2, 2])
      for (const [u, v] of [[1, 1], [2, 1]])
        both(u, v, wall, most((u - 1) * 42 + 41.5 - 2 * wall, wall), most((v - 1) * 42 + 41.5 - 2 * wall, wall), divT, divClr);
  }
  report('no lip, scoop or shelf, one way and both', rows, true);
  /* Lip, scoop and shelf each on and off, with plates one way and both ways, as many as
     the fields allow and half that, at walls either side of the lip's base, where it stops
     overhanging. The bins with the most notches in the lip are checked whole as well,
     watertight and wound, and the notched lip again below at every smoothness. */
  const rows2 = [];
  const feats = [];
  for (const lip of [true, false]) for (const scoop of [0, 8]) for (const label of [0, 12])
    feats.push([{ lip, scoop, label }, [lip ? 'lip' : '', scoop ? 'scoop' : '', label ? 'shelf' : ''].filter(Boolean).join('+') || 'bare']);
  for (const [divT, divClr] of [[1.6, 0.25], [0.8, 0], [5, 1]])
    for (const [u, v, arcSegs] of [[1, 1, 12], [2, 1, 12], [1, 2, 12], [0.5, 1.5, 12], [1, 1, 8], [1.5, 1, 24]])
      for (const wall of [0.4, 1.2, 2.65, 3])
        for (const [f, fname] of feats)
          for (const keys of [['divX'], ['divY'], ['divX', 'divY']]) {
            const top = { divX: most((u - 1) * 42 + 41.5 - 2 * wall, wall), divY: most((v - 1) * 42 + 41.5 - 2 * wall, wall) };
            for (const half of [false, true]) {
              const ns = {};
              for (const k of keys) ns[k] = half ? Math.ceil(top[k] / 2) : top[k];
              rows2.push([`${u}x${v} wall ${wall}, ${fname}, ${keys.map((k) => `${ns[k]} ${k === 'divX' ? 'across' : 'along'}`).join(' and ')}` +
                          `${divT === 1.6 && divClr === 0.25 ? '' : `, ${divT} mm plate ${divClr} clear`}` +
                          `${arcSegs === 12 ? '' : ` at ${arcSegs}`}`,
                          Object.assign({ u, v, hUnits: 3, wall, divRemovable: true, divT, divClr, arcSegs }, f, ns),
                          f.lip && !half && keys.length === 2]);
            }
          }
  /* A scoop as big as the bin allows on a short bin, which holds it down so the plates
     across keep a millimetre of end in their front rails; a thick floor; a lowered wall,
     which takes the lip off; and screw holes, which raise the floor. */
  for (const [divT, divClr] of [[1.6, 0.25], [0.8, 1]])
    for (const extra of [{ hUnits: 2, scoop: 20 }, { hUnits: 2, scoop: 20, label: 6 }, { hUnits: 6, scoop: 30, label: 20 },
                         { hUnits: 3, floorT: 6, scoop: 20 }, { hUnits: 3, edges: { f: 0.5 }, scoop: 8, label: 12 },
                         { hUnits: 4, magnets: true, screws: true, scoop: 10, label: 12 }])
      rows2.push([`2x2 ${JSON.stringify(extra)}${divT === 1.6 ? '' : `, ${divT} mm plate ${divClr} clear`}`,
                  Object.assign({ u: 2, v: 2, wall: 1.2, divRemovable: true, divT, divClr, divX: 3, divY: 3 }, extra), true]);
  report('lip, scoop and shelf on and off, both ways', rows2, false);
  /* The notched lip is cut through each corner's chords at every level, so it is built at
     the smoothnesses the engine takes as well as the page's three, at walls up to the
     lip's base, with as many plates both ways as fit: where the notches come closest to
     the corners, and to each other round them. */
  const rows3 = [];
  for (const [divT, divClr] of [[1.6, 0.25], [0.8, 0.1], [5, 1]])
    for (const [u, v] of [[1, 1], [1.5, 2.5]])
      for (const wall of [0.4, 0.8, 1.2, 1.6, 2, 2.4, 2.65])
        for (const arcSegs of [4, 8, 24, 48]) {
          const divX = most((u - 1) * 42 + 41.5 - 2 * wall, wall), divY = most((v - 1) * 42 + 41.5 - 2 * wall, wall);
          rows3.push([`${u}x${v} wall ${wall} at ${arcSegs}, ${divT} mm plate ${divClr} clear`,
                      { u, v, hUnits: 3, wall, arcSegs, divRemovable: true, divT, divClr, divX, divY }, true]);
        }
  report('the notched lip at every smoothness', rows3, false);
}

/* Plates that go in are no proof on their own: a bin with no lip, no scoop and no shelf
   takes any plate. So the bins are probed from above. In every notch nothing stands
   above the rim, and between the notches, and round each corner, the lip still stands
   to its top; in every notch in the label shelf nothing stands above the floor, and
   between them the shelf does, to the rim. Then the plates: a plate across follows the
   scoop, no more than twice its clearance above it where the scoop is shallow enough to
   measure, rather than being cut short; a plate along over the scoop stands on it; and
   where plates cross, each keeps a millimetre of itself, and the two halve the height
   they share. */
console.log('\nremovable dividers: the notches, the cut and the halving slots are built');
{
  const SET = [
    ['1x1x3, 3 across and 2 along, scoop and shelf', { u: 1, v: 1, hUnits: 3, divX: 3, divY: 2, scoop: 8, label: 12 }],
    ['2x2x3, 1 each way', { u: 2, v: 2, hUnits: 3, divX: 1, divY: 1 }],
    ['1x1x3, 10 each way', { u: 1, v: 1, hUnits: 3, divX: 10, divY: 10 }],
    ['1x1x3 wall 0.4, 12 each way, 0.8 mm plate 0.1 clear', { u: 1, v: 1, hUnits: 3, wall: 0.4, divT: 0.8, divClr: 0.1, divX: 12, divY: 12 }],
    ['1.5x1x4 at 24, 2 across and 1 along, scoop and shelf', { u: 1.5, v: 1, hUnits: 4, arcSegs: 24, divX: 2, divY: 1, scoop: 10, label: 10 }],
    ['2x1x3, 4 across and 3 along, 5 mm plate 1 clear, scoop', { u: 2, v: 1, hUnits: 3, divT: 5, divClr: 1, divX: 4, divY: 3, scoop: 12 }],
    ['1x2x6, 2 across and 5 along, 0.8 mm plate, no clearance', { u: 1, v: 2, hUnits: 6, divT: 0.8, divClr: 0, divX: 2, divY: 5, scoop: 15, label: 14 }],
  ];
  const fails = [];
  let probes = 0, corners = 0;
  for (const [name, base] of SET) {
    const cfg = Object.assign({ divRemovable: true }, base), c = Object.assign({}, BIN_DEFAULTS, cfg);
    const r = buildBin(G, cfg), at = prober(r.polys), built = dividersBuilt(cfg), out = [];
    const H = c.hUnits * SPEC.unitH, top = H + lipHeightOf(c.lipMin), zf = r.meta.floorZ + 0.05;
    const hwO = (c.u - 1) * 21 + 20.75, hdO = (c.v - 1) * 21 + 20.75, iw = hwO - c.wall, id = hdO - c.wall;
    const cx = hwO - SPEC.r, cy = hdO - SPEC.r, t = c.divT, clr = c.divClr, slot = t / 2 + clr;
    const pos = (n, inner) => Array.from({ length: n }, (_, k) => -inner + (2 * inner) * (k + 1) / (n + 1));
    const pX = pos(built.divX, iw), pY = pos(built.divY, id);
    const highest = (x, y) => { probes++; const z = at(x, y); return z.length ? z[z.length - 1] : -Infinity; };
    /* Halfway along each stretch between notches a slot and a BLOAT wide, and between the
       end ones and where the side turns the corner, if there is any stretch there. */
    const mids = (ps, end, w) => {
      const a = [-end].concat(...ps.map((p) => [p - w, p + w]), [end]), out = [];
      for (let i = 0; i + 1 < a.length; i += 2) if (a[i + 1] - a[i] > 0.2) out.push((a[i] + a[i + 1]) / 2);
      return out;
    };
    // the lip: notched at every slot, standing between them, on all four sides
    for (const [ps, end, side] of [[pX, cx, (x, s) => [x, s * (hdO - 0.3)]], [pY, cy, (y, s) => [s * (hwO - 0.3), y]]])
      for (const s of [-1, 1]) {
        for (const p of ps) { const z = highest(...side(p, s)); if (z > H + 1e-6) out.push(`lip at ${side(p, s).map((v) => v.toFixed(1))} not notched: ${z.toFixed(2)}`); }
        for (const m of mids(ps, end, slot + 0.05)) { const z = highest(...side(m, s)); if (Math.abs(z - top) > 1e-6) out.push(`no lip between notches at ${side(m, s).map((v) => v.toFixed(1))}: ${z.toFixed(2)}`); }
      }
    for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const z = highest(sx * (cx + 3.45 * Math.SQRT1_2), sy * (cy + 3.45 * Math.SQRT1_2));
      if (Math.abs(z - top) < 1e-6) corners++;
      else out.push(`no lip at the ${sy > 0 ? 'back' : 'front'} ${sx > 0 ? 'right' : 'left'} corner`);
    }
    // the shelf: notched at every slot across, standing between them
    const d = c.label ? Math.min(c.label, id * 0.8, H - c.labelT - SPEC.footH - 0.05) : 0;
    if (d > 0.05 && pX.length) {
      for (const p of pX) { const z = highest(p, id - d / 2); if (z > zf + 1e-6) out.push(`shelf at ${p.toFixed(1)} not notched: ${z.toFixed(2)}`); }
      for (const m of mids(pX, iw, slot + 0.025)) { const z = highest(m, id - d / 2); if (Math.abs(z - H) > 1e-6) out.push(`no shelf at ${m.toFixed(1)}: ${z.toFixed(2)}`); }
    }
    // the plates across follow the scoop; the plates along stand on it
    const chainAt = (ol, u) => {
      const b = ol.slice(0, ol.findIndex((p) => p[0] === Math.max(...ol.map((q) => q[0]))) + 1);
      for (let i = 1; i < b.length; i++) if (b[i][0] > b[i - 1][0] && u >= b[i - 1][0] && u <= b[i][0])
        return b[i - 1][1] + (b[i][1] - b[i - 1][1]) * (u - b[i - 1][0]) / (b[i][0] - b[i - 1][0]);
      return NaN;
    };
    // a plain plate is the rectangle it always was, standing on the floor
    const withOutline = (m) => Object.assign({ outline: [[-m.span / 2, zf], [m.span / 2, zf], [m.span / 2, zf + m.tall], [-m.span / 2, zf + m.tall]] }, m);
    const across = pX.map((p, k) => withOutline(dividerPart(G, cfg, 'y', k + 1).meta));
    const along = pY.map((q, k) => withOutline(dividerPart(G, cfg, 'x', k + 1).meta));
    if (c.scoop && pX.length) {
      let measured = 0;
      for (let u = -id + clr + 0.5; u < 0; u += 0.25) {
        const s = highest(pX[0], u);
        if (s < zf + 0.2 || s > H - 1) continue;
        const z0 = highest(pX[0], u - 0.1);
        if (Math.abs(s - z0) > 0.1) continue;          // steeper than 45 degrees: not measured
        measured++;
        const gap = chainAt(across[0].outline, u) - s;
        if (!(gap >= -1e-6 && gap <= 2 * clr + 0.1)) { out.push(`plate across ${gap.toFixed(3)} mm above the scoop at y ${u.toFixed(2)}`); break; }
      }
      if (!measured) out.push('no scoop under the plates across to measure');
    }
    along.forEach((m, k) => {
      const s = highest(0, pY[k] - t / 2 + 1e-4), zb = Math.min(...m.outline.map((p) => p[1]));
      if (s > zf + 1e-6 && !(zb >= s - 1e-6 && zb - s < 0.01)) out.push(`plate along ${k + 1} stands at ${zb.toFixed(3)}, the scoop under it at ${s.toFixed(3)}`);
    });
    // where they cross: each keeps a millimetre, and they share the height between them
    if (pX.length && pY.length) {
      const ztop = zf + dividerPart(G, Object.assign({}, cfg, { divY: 0 }), 'x').meta.tall;
      along.forEach((m, k) => {
        const q = pY[k], ol = across[0].outline, olY = m.outline;
        // the bottom of the slot from the top: the lowest of the outline there that is not its bottom edge
        const cut = Math.min(...ol.filter((p) => p[0] >= q - slot - 1e-9 && p[0] <= q + slot + 1e-9 &&
                                                 p[1] > chainAt(ol, p[0]) + 1e-9).map((p) => p[1]));
        const lift = Math.max(...olY.filter((p) => p[0] >= pX[0] - slot - 1e-9 && p[0] <= pX[0] + slot + 1e-9).map((p) => p[1]));
        const keepX = cut - chainAt(ol, q - slot), keepY = ztop - lift;
        if (!isFinite(cut) || !isFinite(lift)) out.push(`crossing ${k + 1} has no ${isFinite(cut) ? '' : 'slot from the top'}${isFinite(cut) || isFinite(lift) ? '' : ' or '}${isFinite(lift) ? '' : 'slot from the bottom'}`);
        else if (keepX < 1 - 1e-6 || keepY < 1 - 1e-6) out.push(`crossing ${k + 1} keeps ${keepX.toFixed(2)} and ${keepY.toFixed(2)} mm`);
        else if (Math.abs(lift - cut - 2 * clr) > 1e-6) out.push(`crossing ${k + 1} slots ${(lift - cut).toFixed(3)} mm apart, not twice the clearance`);
      });
    }
    if (out.length) fails.push(`${name}: ${out[0]}${out.length > 1 ? ` and ${out.length - 1} more` : ''}`);
  }
  console.log('  ' + (fails.length ? `${fails.length} FAILED: ${fails.join('; ')}`
    : `${SET.length} bins, ${probes} probes: notched at every slot, the lip and shelf standing between, ${corners} of ${4 * SET.length} corners whole; plates cut to the scoop and halved where they cross`));
  if (fails.length) bad++;
}

/* The label shelf's underside runs down at 45 degrees, so the deeper the shelf the
   lower its foot, and one deeper than the bin is tall came out through the floor among
   the feet. The limit that stopped it held the foot 0.2 above the floor, and that cut
   shelves which had always built cleanly: a 14 mm label on a 1x1x3 came out 13.65, a
   7 mm one on a 2x1x2 6.65. The foot may run into the floor slab, which is solid; it
   must not leave it, and the slab ends at the top of the base. Measured off the mesh:
   the shelf is whatever adding the label adds. */
console.log('\nlabel shelves as deep as the bin\'s height allows');
{
  const key = (p) => p.verts.map((w) => w.map((x) => x.toFixed(4)).join(',')).join(' ');
  const shelfOf = (cfg) => {
    const without = new Set(buildBin(G, Object.assign({}, cfg, { label: 0 })).polys.map(key));
    let ymin = Infinity, zmin = Infinity;
    for (const p of buildBin(G, cfg).polys) if (!without.has(key(p)))
      for (const w of p.verts) { ymin = Math.min(ymin, w[1]); zmin = Math.min(zmin, w[2]); }
    if (!isFinite(zmin)) return { depth: 0, foot: NaN };          // no shelf built at all
    const inner = (cfg.v - 1) * SPEC.pitch / 2 + SPEC.half - (cfg.wall || BIN_DEFAULTS.wall);
    return { depth: inner - ymin, foot: zmin };
  };
  // [name, bin, what the shelf must be: its depth, or null for "as deep as the height allows"]
  const SHELVES = [
    ['1x1x3, 14 mm', { u: 1, v: 1, hUnits: 3, label: 14 }, 14],
    ['2x1x2, 7 mm', { u: 2, v: 1, hUnits: 2, label: 7 }, 7],
    ['2x1x3, 12 mm on a 3 mm floor', { u: 2, v: 1, hUnits: 3, floorT: 3, label: 12 }, 12],
    // the deepest a whole-millimetre shelf on whole units reaches: its foot on the base
    ['1x2x3, 15 mm', { u: 1, v: 2, hUnits: 3, label: 15 }, 15],
    ['1x1x3, 16 mm', { u: 1, v: 1, hUnits: 3, label: 16 }, null],
    ['1x1x1, 12 mm', { u: 1, v: 1, hUnits: 1, label: 12 }, null],
    ['2x1x2, 20 mm on a 3 mm floor', { u: 2, v: 1, hUnits: 2, floorT: 3, label: 20 }, null],
  ];
  for (const [name, cfg, want] of SHELVES) {
    const s = shelfOf(cfg);
    const ok = want !== null ? Math.abs(s.depth - want) < 1e-6
      : s.foot >= SPEC.footH && s.foot <= SPEC.footH + 0.1;
    console.log(`  ${name.padEnd(30)} ${s.depth.toFixed(2).padStart(5)} mm deep, foot at ` +
                `${s.foot.toFixed(2).padStart(4)}   ` + (ok ? 'ok'
                  : want !== null ? `CUT SHORT of ${want} mm`
                  : !s.depth ? 'NO SHELF where one fits'
                  : s.foot < SPEC.footH ? 'BELOW THE BASE, among the feet' : 'HELD UP off the base'));
    if (!ok) bad++;
  }
  const FLOORS = [0, 0.6, 1.05, 1.1, 1.2, 3];
  /* With screws the shelf's foot stands on the screw's end instead, and every floor under
     1.85 builds at 1.85, so two floors cover them. */
  for (const [name, base, floors] of [['1x1x3 at its limit', { u: 1, v: 1, hUnits: 3 }, FLOORS],
                                      ['2x2x2 at its limit', { u: 2, v: 2, hUnits: 2 }, FLOORS],
                                      ['1x1x3 holes, at its limit', Object.assign({ u: 1, v: 1, hUnits: 3 }, BOTH), [0, 3]]]) {
    const rows = [], H = base.hUnits * SPEC.unitH;
    // a wall of 1.148 puts the shelf's back corners on vertices of the foot's and wall's arcs
    for (const floorT of floors) for (const wall of [0.4, 1.148, 1.2, 2])
      for (const label of [H - 7, H - 6, H - 5, 42])
        rows.push([`floor ${floorT} wall ${wall} label ${label}`, Object.assign({ floorT, wall, label }, base)]);
    sweepReport(name, rows);
  }
}

/* Links from before half sizes have to build the bytes they always did.
 *
 * Half sizes went into the very code every bin goes through — the feet, what counts as
 * a full rectangle, how a link's sizes and positions are read — and a whole bin was to
 * come out of it unchanged, byte for byte, so that a link or a saved drawer from before
 * makes the same files and a bin already printed still matches its file. Nothing else
 * here would notice a whole bin that moved by a micron and stayed watertight.
 *
 * Each row is a link of one bin as the page wrote it before half sizes, and the first 16
 * hex digits of the SHA-256 of its STL as that engine built it, at the page's default
 * settings. Read through unpackBin, so the link is checked along with the geometry.
 * A change that MEANS to alter whole bins will fail here: check that it should, then put
 * in the digests this prints, and say so in the commit. One did: the 2x2x3 with removable
 * dividers has rails reaching the clearance deeper, so that each end of its plates sits a
 * full rail's depth in them (reach in buildBin), and nothing else in it changed. Then the
 * same bin again: its stacking lip has a notch at each slot, so that its plates drop in
 * past the lip's chamfer (lipNotched in buildBin), and nothing else in it changed. */
console.log('\nlinks from before half sizes build the same bytes');
{
  const crypto = require('crypto');
  const OLD = [
    ['1x1x3', '0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0', 'a6b5ca988bcf9ec4'],
    ['1x1x1', '4-1-1-1-1-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0', '055b9aa96e86b515'],
    ['3x2x5, dividers, scoop and label', '1-2-3-2-5-1.2-1.2-2-1-0-1-1-1-1-6-10-0-0-0-0-15-0', '66c515b3c3ab2fcc'],
    /* was 857e407d5b6d51d2 on main, then 7b838b800b92ce03 with the deeper rails; now its lip
       has a notch at each slot as well, so each plate drops in past it */
    ['2x2x3, removable dividers', '0-0-2-2-3-1.2-1.2-1-1-0-1-1-1-1-0-0-0-0-1-0-15-0', '576daddcf6ccc8e5'],
    ['2x1x3, front at half, left at a quarter', '0-0-2-1-3-1.2-1.2-0-0-0-0.5-1-0.25-1-0-0-0-0-0-0-15-0', '1838902a9b3e1fda'],
    ['2x2x2 tray', '0-0-2-2-2-1.2-1.2-0-0-0-0-0-0-0-0-0-0-0-0-0-15-0', '16583a72aa4bdfc9'],
    ['1x1x3 solid', '0-0-1-1-3-1.2-1.2-0-0-1-1-1-1-1-0-0-0-0-0-0-15-0', 'c6e857cede8b8d80'],
    ['L-3x3', '0-0-3-3-3-1.2-1.2-0-0-0-1-1-1-1-0-0-111111110-0-0-0-15-0', 'ea2255a79030ae95'],
    ['U-3x3', '0-0-3-3-3-1.2-1.2-0-0-0-1-1-1-1-0-0-111110111-0-0-0-15-0', 'a59a28b55e03af19'],
    ['3x2x4, magnets and screws in every cell', '0-0-3-2-4-1.2-1.2-2-1-0-1-1-1-1-8-12-0-0-0-0-15-7', 'f17b747e3c0e9cea'],
    ['L-3x3, magnets in the corners', '0-0-3-3-3-1.2-1.2-0-0-0-1-1-1-1-0-0-111111110-0-0-0-15-1', 'ad9b58c05deaba4d'],
    ['2x1x4 with a lid, 21 fields', '0-0-2-1-4-0.85-2.35-0-0-0-1-1-1-1-0-0-0-0-0-1-14', 'a7bc7318f00e19f5'],
  ];
  const moved = OLD.map(([name, link, want]) => {
    const got = crypto.createHash('sha256')
      .update(Buffer.from(G.stlBinary(buildBin(G, unpackBin(link)).polys, 'b'))).digest('hex').slice(0, 16);
    return got === want ? '' : `${name} (${link}) now ${got}, was ${want}`;
  }).filter(Boolean);
  console.log('  ' + (moved.length ? 'CHANGED: ' + moved.join('; ')
    : `${OLD.length} links, each the same STL to the byte`));
  if (moved.length) bad++;
}

/* A note raised on the label shelf (labelMode 1, text.js).
 *
 * Built, not merely closed: a bin with no letters on it is just as watertight. So every
 * case above with a note is probed. Straight down through a point of a stroke, the first
 * thing met is the top of the letters, at H - 0.4; through the strip the letters keep
 * clear at the shelf's front, it is the shelf, at H - 1.0, a millimetre lower than a
 * shelf with nothing on it. shelfNote is what the page says about the letters, so it
 * has to agree with what was built: how many lines, and whether it was cut short.
 *
 * And every letter stands on the shelf, all of it: under each corner of every stroke's
 * outline is the shelf's top. On a thin wall the shelf is the cavity's rounded outline
 * rather than a prism square to the side walls, and a letter out past it would stand on
 * nothing in the corner; the outline check above sees only the outside. */
console.log('\nnotes raised on the label shelf');
{
  for (const cs of CASES.filter((c) => c.labelMode === 1)) {
    const r = buildBin(G, cs), at = prober(r.polys), s = shelfNote(cs), faults = [];
    let divClear = Infinity;
    const H = cs.hUnits * SPEC.unitH;
    const id = (cs.v - 1) * SPEC.pitch / 2 + SPEC.half - (cs.wall || BIN_DEFAULTS.wall);
    if (!s.fit) faults.push(`NO LETTERS (${s.why})`);
    else {
      // the shelf through the strip in front of the letters, beside one: clear of dividers
      const [x, y] = s.fit.segs[0][0];
      const top = at(x, y).pop(), shelf = at(x, id - s.depth + 0.3).pop();
      if (Math.abs(top - (H - NOTE_CLEAR)) > 1e-6)
        faults.push(`a letter's top at ${top.toFixed(3)}, not H - 0.4 = ${(H - 0.4).toFixed(2)}`);
      if (Math.abs(shelf - (H - 1.0)) > 1e-6)
        faults.push(`the shelf's top at ${shelf.toFixed(3)}, not H - 1.0 = ${(H - 1).toFixed(2)}`);
      // the letters as buildBin makes them, but for how high: only where they stand counts
      const corners = NOTE_TEXT.noteShells(G, s.fit.segs, s.top, H - NOTE_CLEAR)
        .flatMap((p) => p.verts);
      const off = corners.filter(([x, y]) => !at(x, y).some((z) => Math.abs(z - s.top) < 1e-6));
      if (off.length)
        faults.push(`${off.length} of ${corners.length} letter corners not over the shelf, ` +
                    `as at ${off[0][0].toFixed(2)}, ${off[0][1].toFixed(2)}`);
      /* ...and 0.4 clear of every divider: a fixed one a wall thick, a removable one 1.2
         mm of rail each side of a slot as wide as the plate and its clearance, which is
         where the plate goes down too. Measured from the bin's numbers, centre lines
         evenly across the cavity, not from what built it. */
      const wall = cs.wall !== undefined ? cs.wall : BIN_DEFAULTS.wall;
      const iw = (cs.u - 1) * SPEC.pitch / 2 + SPEC.half - wall;
      const dT = cs.divT !== undefined ? cs.divT : BIN_DEFAULTS.divT;
      const dC = cs.divClr !== undefined ? cs.divClr : BIN_DEFAULTS.divClr;
      const half = cs.divRemovable ? dT / 2 + dC + 1.2 : wall / 2;
      // the dividers as built: removable ones no more than fit
      const built = dividersBuilt(cs);
      const offDiv = (n, inner, v) => {
        let d = Infinity;
        for (let k = 1; k <= n; k++) d = Math.min(d, Math.abs(v - (-inner + 2 * inner * k / (n + 1))) - half);
        return d;
      };
      divClear = Infinity;
      for (const [cx, cy] of corners)
        divClear = Math.min(divClear, offDiv(built.divX, iw, cx), offDiv(built.divY, id, cy));
      if (divClear < 0.4 - 1e-6)
        faults.push(divClear < 0 ? `a letter ${(-divClear).toFixed(2)} mm into a divider's footprint`
          : `a letter only ${divClear.toFixed(2)} mm off a divider`);
      if (cs.fit.lines && s.fit.lines.length !== cs.fit.lines)
        faults.push(`${s.fit.lines.length} lines, not ${cs.fit.lines}`);
      if (s.fit.cut !== cs.fit.cut) faults.push(cs.fit.cut ? 'NOT CUT short' : 'CUT short');
      // uncut, every character of the note is on the shelf
      if (!s.fit.cut && s.fit.lines.join(' ') !== cs.note) faults.push(`printed "${s.fit.lines.join(' / ')}"`);
      if (!s.fit.cut && s.fit.cap < NOTE_TEXT.NOTE_SPEC.capMin) faults.push(`only ${s.fit.cap.toFixed(2)} mm tall`);
    }
    console.log(`  ${cs.name.padEnd(22)} ${s.fit ? (s.fit.cap.toFixed(2) + ' mm, ' + s.fit.lines.length +
      (s.fit.lines.length > 1 ? ' lines' : ' line') + (s.fit.cut ? ', cut' : '')).padEnd(20) : ''.padEnd(20)} ` +
      (faults.length ? faults.join('; ') : 'letters at H - 0.4 on a shelf at H - 1.0' +
        (isFinite(divClear) ? `, ${divClear.toFixed(2)} off the nearest divider` : '')));
    if (faults.length) bad++;
  }

  /* Each glyph alone, so a fault is pinned to the character that has it: watertight,
     oriented, and every shell whole. A shell is one extrudePoly of a convex outline,
     and earTriangulate gives up on a polygon silently, so each of its two caps has to be
     the n - 2 triangles a convex n-gon is: one short is a hole a closed check may not see
     if a neighbouring shell happens to cover it. */
  const band = { x0: -18, x1: 18, y0: 8, y1: 18 };
  const fails = [];
  let shells = 0;
  for (const ch of ALL_GLYPHS) {
    const calls = [];
    const rec = Object.assign({}, G, { extrudePoly: (pts, z0, z1) => {
      const p = G.extrudePoly(pts, z0, z1);
      calls.push({ n: pts.length, z1, polys: p });
      return p;
    } });
    const polys = NOTE_TEXT.noteShells(rec, NOTE_TEXT.noteFit(ch, band).segs, 10, 10.6);
    const m = G.checkManifold(polys), o = checkOrientation(polys);
    const torn = calls.filter((c) => {
      const caps = c.polys.filter((p) => p.verts.length === 3);
      const up = caps.filter((p) => p.verts.every((w) => w[2] === c.z1)).length;
      return up !== c.n - 2 || caps.length - up !== c.n - 2 || c.polys.length - caps.length !== c.n;
    });
    shells += calls.length;
    if (!calls.length || m.bad || !o.ok || torn.length)
      fails.push(`${JSON.stringify(ch)}: ${calls.length} shells, ${m.bad} bad edges, ${orientationNote(o)}` +
                 (torn.length ? `, ${torn.length} with a cap short` : ''));
  }
  console.log(`  every glyph alone      ` + (fails.length ? 'FAILED: ' + fails.join('; ')
    : `${ALL_GLYPHS.length} glyphs, ${shells} shells, each watertight, oriented, every cap n - 2 triangles`));
  if (fails.length) bad++;

  /* The font's data goes into the page inside a script tag, where a less-than sign and a
     slash together could end the script. None of it may hold one, and the file may not
     either. And the four notes above have to be every glyph the font draws, or "every
     glyph" is not. */
  const strings = HERSHEY.ascii.concat(Object.values(HERSHEY.more));
  const fontFile = fs.readFileSync(path.join(__dirname, '..', 'src', 'bins', 'font.js'), 'utf8');
  const dataOk = strings.every((t) => /^[ B-b]+$/.test(t)) && !fontFile.includes('</') &&
    HERSHEY.ascii.length === 95 && Object.keys(HERSHEY.more).length === 6;
  const drawn = ALL_GLYPHS.filter((ch) => NOTE_TEXT.noteGlyph(ch));
  const covered = drawn.length === ALL_GLYPHS.length &&
    Object.keys(HERSHEY.more).every((ch) => ALL_GLYPHS.includes(ch));
  console.log(`  the font's data        ${dataOk ? 'spaces and B to b only, no </ anywhere in font.js' : 'UNSAFE IN A SCRIPT TAG, or not 95 + 6 glyphs'}` +
              `${covered ? '' : '; NOT EVERY GLYPH IS IN THE NOTES ABOVE'}`);
  if (!dataOk || !covered) bad++;

  /* Opt-in, and only when there are letters to print: every other bin is built to the
     byte as it was, whatever its note says. Each row is a bin that has to come out the
     same as the bin beside it without labelMode or note, and the reason shelfNote gives
     the page for printing nothing. */
  const crypto = require('crypto');
  const digest = (cfg) => crypto.createHash('sha256')
    .update(Buffer.from(G.stlBinary(buildBin(G, cfg).polys, 'b'))).digest('hex');
  const one = { u: 1, v: 1, hUnits: 3, label: 12 };
  const SAME = [
    ['not asked for', one, { labelMode: 0, note: 'M3 screws' }, 'off'],
    ['an empty note', one, { labelMode: 1, note: '' }, 'empty'],
    ['spaces only', one, { labelMode: 1, note: '   ' }, 'empty'],
    ['nothing in it prints', one, { labelMode: 1, note: '\u{1F642}é' }, 'empty'],
    ['a 1-unit bin, too shallow', Object.assign({}, one, { hUnits: 1 }), { labelMode: 1, note: 'M3' }, 'shallow'],
    ['no shelf asked for', Object.assign({}, one, { label: 0 }), { labelMode: 1, note: 'M3' }, 'noshelf'],
    ['back wall lowered', Object.assign({}, one, { edges: { b: 0.5 } }), { labelMode: 1, note: 'M3' }, 'back'],
    ['solid', Object.assign({}, one, { solid: true }), { labelMode: 1, note: 'M3' }, 'solid'],
    ['carved', { u: 3, v: 3, hUnits: 3, label: 12, cells: cellsExcept(3, 3, [[2, 2]]) },
     { labelMode: 1, note: 'M3' }, 'carved'],
    // 4.9 mm between centre lines: no space between them takes even "..." at 3 mm
    ['dividers too close for any of it', Object.assign({}, one, { divX: 7 }),
     { labelMode: 1, note: 'M3 screws' }, 'dividers'],
    ['removable ones too close', Object.assign({}, one, { divX: 4, divRemovable: true }),
     { labelMode: 1, note: 'M3 screws' }, 'dividers'],
    // a half cell with 8 mm walls is 4 mm across inside: its letters were 0.5 mm tall
    ['walls too thick for any of it', Object.assign({}, one, { u: 0.5, wall: 8 }),
     { labelMode: 1, note: 'M3 screws' }, 'narrow'],
    // ...and with 7 mm walls only "M / ..." went in, which is not a note
    ['walls leaving room for one letter', Object.assign({}, one, { u: 0.5, wall: 7 }),
     { labelMode: 1, note: 'M3 screws' }, 'narrow'],
    ['dividers leaving room for one letter', Object.assign({}, one, { divX: 4 }),
     { labelMode: 1, note: 'M3 screws' }, 'dividers'],
    /* Dividers along the bin cross the shelf and cut its depth short. Letters sized to
       what was left came out 1.05 mm tall here, -0.25 mm (mirrored, outside the lip's
       opening) with removable ones, and 0.46 mm on the 1x1. */
    ['dividers along cutting the shelf short', { u: 1, v: 0.5, hUnits: 6, label: 12, divY: 3 },
     { labelMode: 1, note: 'M3 screws' }, 'dividers along'],
    /* Removable plates along stay in front of the shelf, which they could not drop in
       under (railedLimit), so they cut it short only where the rails of the last one, and
       the clearance the letters keep off them, reach over a shelf as shallow as letters
       take. The two that cut it short before, 3 along on a 1 x 0.5 and 6 on a 1 x 1, both
       six units tall with a 12 mm shelf, are built with one in front of it and print
       their notes (with the cases above). */
    ['removable ones along, past nothing', { u: 1, v: 1, hUnits: 3, label: 6, divY: 4, divRemovable: true },
     { labelMode: 1, note: 'M3 screws' }, 'dividers along'],
    ['six removable ones along', { u: 1, v: 1, hUnits: 2, label: 6, divY: 6, divRemovable: true },
     { labelMode: 1, note: 'M3 screws' }, 'dividers along'],
    /* ...and only those along, where they are what is in the way: here the space between
       the ones across takes no note at the shelf's whole depth either, and the hint sent
       people to the ones along. With walls 7 mm thick it is the walls. */
    ['ones across in the way, ones along as well',
     { u: 1, v: 0.5, hUnits: 3, label: 8, divX: 1, divY: 1, divRemovable: true },
     { labelMode: 1, note: 'M3 screws' }, 'dividers'],
    ['walls in the way, dividers along as well', { u: 0.5, v: 1, hUnits: 3, label: 12, wall: 7, divY: 3 },
     { labelMode: 1, note: 'M3 screws' }, 'narrow'],
  ];
  const moved = SAME.map(([name, cfg, extra, why]) => {
    const withIt = Object.assign({}, cfg, extra), say = shelfNote(withIt);
    const got = say.why + (say.along ? ' along' : '');
    if (digest(cfg) !== digest(withIt)) return `${name}: BUILT DIFFERENTLY`;
    return got === why ? '' : `${name}: shelfNote says ${got}, not ${why}`;
  }).filter(Boolean);
  console.log(`  bins with nothing to print ` + (moved.length ? 'FAILED: ' + moved.join('; ')
    : `${SAME.length} kinds, each the same STL to the byte, and the page told why`));
  if (moved.length) bad++;

  /* What the dividers leave has to be a note, over the bins people make most: letters at
     least 3 mm tall wherever dividers along the bin cut the shelf short (only a shelf
     shallow by itself prints smaller, and then no smaller than it alone would), and no
     cut that keeps fewer than three characters or a line of nothing but "...". Squeezed
     by dividers along, 78 of the first 252 printed under 3 mm and passed as readable, 15
     at nothing or under it; across, 44 of 448 printed "M / ..." or the like. */
  const S = NOTE_TEXT.NOTE_SPEC, squeezed = [];
  let tried = 0, printed = 0;
  const kept = (lines) => lines.join(' ').replace(/\.\.\.$/, '').replace(/\s/g, '').length;
  for (const [u, v] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 1], [1, 0.5], [2, 0.5], [0.5, 1]])
    for (const label of [8, 12, 15]) for (const divRemovable of [false, true])
      for (const note of ['M3 screws', 'M2', 'Drill bits 1-6 mm']) {
        const base = { u, v, hUnits: 6, label, labelMode: 1, note, divRemovable };
        const alone = shelfNote(base);
        for (const [k, n] of [['divY', 1], ['divY', 2], ['divY', 3], ['divY', 4], ['divY', 5], ['divY', 6],
                              ['divX', 1], ['divX', 2], ['divX', 3], ['divX', 4], ['divX', 5], ['divX', 6]]) {
          const s = shelfNote(Object.assign({}, base, { [k]: n })), at = `${u}x${v} label ${label} ${k} ${n}` +
            `${divRemovable ? ' removable' : ''} "${note}"`;
          tried++;
          // nothing printed: the dividers along are named exactly when the note fits without them
          if (!s.fit && k === 'divY' && !!s.along !== !!alone.fit)
            squeezed.push(`${at}: says ${s.why}${s.along ? ' along' : ''}, and without them it ${alone.fit ? 'prints' : 'says ' + alone.why}`);
          if (!s.fit) continue;
          printed++;
          if (!(s.fit.cap > 0)) squeezed.push(`${at}: ${s.fit.cap.toFixed(2)} mm`);
          else if (s.fit.cap < S.capMin - 1e-9 && !(alone.fit && s.fit.cap >= alone.fit.cap - 1e-9))
            squeezed.push(`${at}: ${s.fit.cap.toFixed(2)} mm, under what the shelf alone gives`);
          // nor a word broken over two lines and then cut ("As / s...")
          const broken = s.fit.lines.length > 1 && !/\s/.test(note.slice(0, s.fit.lines[0].length + 1));
          if (s.fit.cut && (kept(s.fit.lines) < Math.min(3, note.replace(/\s/g, '').length) ||
                            s.fit.lines.includes('...') || broken))
            squeezed.push(`${at}: prints "${s.fit.lines.join(' / ')}"`);
        }
      }
  console.log(`  between dividers         ` + (squeezed.length ? `${squeezed.length} FAILED: ` +
    squeezed.slice(0, 6).join('; ') : `${printed} of ${tried} everyday bins print their note, each one readable`));
  if (squeezed.length) bad++;
}

console.log(bad ? `\n${bad} case(s) FAILED` : '\nall cases clean');
process.exit(bad ? 1 : 0);
