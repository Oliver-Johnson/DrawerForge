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
        unpackBin, binFeet, shelfNote, NOTE_CLEAR } = require('../src/bins/bin.js');
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

/* How far a bin stands out through the spec's outline, rounded corners and all, above
   the feet. The bounding box cannot see a corner: the scoop's square ends stood 1.06 mm
   out through a 0.4 mm wall's corners with the box exactly right, and so did dividers
   and rails packed up to one. Carved shapes have outlines of their own and are left to
   the box. */
function outsideBy(r, cfg) {
  if (cfg.cells) return 0;
  const ox = ((cfg.u - 1) * 42 + 41.5) / 2 - 3.75, oy = ((cfg.v - 1) * 42 + 41.5) / 2 - 3.75;
  let out = 0;
  for (const p of r.polys) for (const v of p.verts) {
    if (v[2] <= 4.75 + 1e-6) continue;
    const dx = Math.max(0, Math.abs(v[0]) - ox), dy = Math.max(0, Math.abs(v[1]) - oy);
    out = Math.max(out, Math.hypot(dx, dy) - 3.75);
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
const cleanBuild = (cfg) => {
  const r = buildBin(G, cfg);
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
 * in the digests this prints, and say so in the commit. */
console.log('\nlinks from before half sizes build the same bytes');
{
  const crypto = require('crypto');
  const OLD = [
    ['1x1x3', '0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0', 'a6b5ca988bcf9ec4'],
    ['1x1x1', '4-1-1-1-1-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0', '055b9aa96e86b515'],
    ['3x2x5, dividers, scoop and label', '1-2-3-2-5-1.2-1.2-2-1-0-1-1-1-1-6-10-0-0-0-0-15-0', '66c515b3c3ab2fcc'],
    ['2x2x3, removable dividers', '0-0-2-2-3-1.2-1.2-1-1-0-1-1-1-1-0-0-0-0-1-0-15-0', '857e407d5b6d51d2'],
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
      const half = cs.divRemovable ? BIN_DEFAULTS.divT / 2 + BIN_DEFAULTS.divClr + 1.2 : wall / 2;
      const offDiv = (n, inner, v) => {
        let d = Infinity;
        for (let k = 1; k <= n; k++) d = Math.min(d, Math.abs(v - (-inner + 2 * inner * k / (n + 1))) - half);
        return d;
      };
      divClear = Infinity;
      for (const [cx, cy] of corners)
        divClear = Math.min(divClear, offDiv(cs.divX || 0, iw, cx), offDiv(cs.divY || 0, id, cy));
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
    ['removable ones along, past nothing', { u: 1, v: 0.5, hUnits: 6, label: 12, divY: 3, divRemovable: true },
     { labelMode: 1, note: 'M3 screws' }, 'dividers along'],
    ['six removable ones along', { u: 1, v: 1, hUnits: 6, label: 12, divY: 6, divRemovable: true },
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
