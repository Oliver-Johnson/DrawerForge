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
        unpackBin, binFeet, dividersBuilt, shelfNote, NOTE_CLEAR, insertPlan, HOLES_MAX,
        fingerSlotPlan } = require('../src/bins/bin.js');
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
  { name: '2x1x3-note-mag-scr', u: 2, v: 1, hUnits: 3, label: 12, labelMode: 1, note: 'Fuses 5A, 10A',
    magnets: true, screws: true, fit: { lines: 1, cut: false } },
  ...NOTE_GLYPHS.map((note, i) => ({ name: `4x1x3-glyphs-${i + 1}`, u: 4, v: 1, hUnits: 3, label: 12,
                                      labelMode: 1, note, fit: { lines: 1, cut: false } })),
  /* Holes across the floor for what goes in the bin (insert: 1 AA, 2 AAA, 3 18650, 4 1/4
     inch hex bits), one tile per hole (holeLayout). Every preset on the four footprints
     the spec counted, then beside a shelf and under a raised note, at both ends of the
     wall's range, on half-size bins, over holes in the feet, in a tray, cut to the room
     the bin has, typed deeper than automatic, at both ends of the clearance field, at
     both other smoothnesses, and a 6x4 to time. `holes` is how many the section on holes
     further down expects, from the spec's table and not from the engine; `depth` is
     written where it is not the automatic third of the item. */
  ...[['aa', 1, 4, [4, 8, 16, 28]], ['aaa', 2, 4, [9, 18, 36, 54]], ['18650', 3, 5, [1, 3, 9, 15]],
      ['hex', 4, 3, [16, 40, 80, 120]]].flatMap(([tag, insert, hUnits, counts]) =>
    [[1, 1], [2, 1], [2, 2], [3, 2]].map(([u, v], k) =>
      ({ name: `${u}x${v}x${hUnits}-${tag}`, u, v, hUnits, insert, holes: counts[k] }))),
  { name: '2x1x4-hex-label', u: 2, v: 1, hUnits: 4, insert: 4, label: 12, holes: 20 },
  { name: '2x1x4-hex-note', u: 2, v: 1, hUnits: 4, insert: 4, label: 12, labelMode: 1, note: 'Hex bits',
    fit: { lines: 1, cut: false }, holes: 20 },
  /* Asked for dividers and a scoop too, which holes leave off, so the letters have the
     whole shelf: one line each, where between those dividers both would take two. */
  { name: '2x1x4-hex-note-div', u: 2, v: 1, hUnits: 4, insert: 4, label: 12, labelMode: 1, divX: 2, divY: 1,
    scoop: 8, note: 'Hex bits 1/4 inch', fit: { lines: 1, cut: false }, holes: 20 },
  { name: '1x1x4-aa-note-div1', u: 1, v: 1, hUnits: 4, insert: 1, label: 12, labelMode: 1, divX: 1,
    note: 'AA cells', fit: { lines: 1, cut: false }, holes: 2 },
  { name: '1x1x4-hex-wall0.4', u: 1, v: 1, hUnits: 4, insert: 4, wall: 0.4, holes: 16 },
  { name: '1x1x4-hex-wall3', u: 1, v: 1, hUnits: 4, insert: 4, wall: 3, holes: 12 },
  { name: '0.5x1x3-hex', u: 0.5, v: 1, hUnits: 3, insert: 4, holes: 8 },
  { name: '1.5x1.5x3-aaa', u: 1.5, v: 1.5, hUnits: 3, insert: 2, holes: 16, depth: 14.5 },
  { name: '2x2x3-hex-feet', u: 2, v: 2, hUnits: 3, insert: 4, holes: 80, ...BOTH },
  { name: '2x1x3-hex-tray', u: 2, v: 1, hUnits: 3, insert: 4, edges: { f: 0, b: 0, l: 0, r: 0 }, holes: 40 },
  // 21 mm tall: the block stops 0.5 under the rim, 14.5 over the floor, short of 16.8
  { name: '1x1x3-aa-room', u: 1, v: 1, hUnits: 3, insert: 1, holes: 4, depth: 14.5 },
  { name: '1x1x5-hex-typed', u: 1, v: 1, hUnits: 5, insert: 4, insertDepth: 20, holes: 16, depth: 20 },
  { name: '1x1x4-aa-clr1', u: 1, v: 1, hUnits: 4, insert: 1, holeClr: 1, holes: 4 },
  { name: '1x1x3-hex-clr-0.3', u: 1, v: 1, hUnits: 3, insert: 4, holeClr: -0.3, holes: 16 },
  { name: '1x1x4-aa-smooth8', u: 1, v: 1, hUnits: 4, insert: 1, arcSegs: 8, holes: 4 },
  { name: '1x1x4-aa-smooth24', u: 1, v: 1, hUnits: 4, insert: 1, arcSegs: 24, holes: 4 },
  { name: '6x4x5-hex', u: 6, v: 4, hUnits: 5, insert: 4, holes: 558 },
  /* A tray past a hundred thousand polygons, which a spread into push() could not pass
     as arguments: it threw, and the page had no parts and no Checks. 23 x 30. */
  { name: '7x9x3-aaa', u: 7, v: 9, hUnits: 3, insert: 2, holes: 690, depth: 14.5 },
  /* Tiles whose corner a neighbour's ray landed on within a micron, so the two were one
     vertex and edges stood open (10, 10, 16 and 4 of them), or did at a weld of 5 to 10
     microns (36 and 14) where the same bins without holes weld clean. */
  { name: '1.5x1x4-aa-wall10', u: 1.5, v: 1, hUnits: 4, wall: 10, insert: 1, holes: 2 },
  { name: '1x1.5x4-aa-wall10', u: 1, v: 1.5, hUnits: 4, wall: 10, insert: 1, holes: 2 },
  { name: '3x3x6-18650-wall2.7', u: 3, v: 3, hUnits: 6, wall: 2.7, insert: 3, holes: 25 },
  { name: '3x4x3-18650-label', u: 3, v: 4, hUnits: 3, wall: 2.7, insert: 3, label: 12, holes: 35,
    depth: 13.3 },
  { name: '2x3x2-aa-low-feet', u: 2, v: 3, hUnits: 2, wall: 2, insert: 1, insertDepth: 1000, magnets: true,
    screws: true, edges: { f: 0.66, b: 1, l: 1, r: 0.5 }, holes: 28, depth: 6.85 },
  { name: '4x2.5x6-18650-wall0.4', u: 4, v: 2.5, hUnits: 6, wall: 0.4, insert: 3, magnets: true,
    holesEvery: true, holes: 32 },
  /* Hex bits in a thin-walled bin without a lip: 0.8 mm off the straight walls, a corner
     hole came 0.72 from the rounded corner. */
  { name: '2x4x6-hex-wall0.4-low', u: 2, v: 4, hUnits: 6, wall: 0.4, insert: 4,
    edges: { f: 0, b: 1, l: 0, r: 0.5 }, holes: 180 },
  /* Finger slots, a U-shaped dip in the top of a wall, one per compartment. At three
     heights and the tallest, on each wall, between dividers and rails, beside a scoop, a
     label shelf and a raised note, at both ends of the wall's range, on half-size bins,
     over holes in the feet and across the floor, and on a lowered and an open wall.
     `slots` is how many each wall should get, worked out here from the spec and not read
     from the engine; the section on finger slots further down measures every one. */
  { name: '1x1x2-slot-f', u: 1, v: 1, hUnits: 2, fingerSlots: { f: true }, slots: { f: 1 } },
  { name: '1x1x3-slot-f', u: 1, v: 1, hUnits: 3, fingerSlots: { f: true }, slots: { f: 1 } },
  { name: '1x1x6-slot-f', u: 1, v: 1, hUnits: 6, fingerSlots: { f: true }, slots: { f: 1 } },
  // half way down is past where the two sides meet: it stops there
  { name: '1x1x10-slot-f', u: 1, v: 1, hUnits: 10, fingerSlots: { f: true }, slots: { f: 1 } },
  { name: '2x1x3-slot-fb', u: 2, v: 1, hUnits: 3, fingerSlots: { f: true, b: true }, slots: { f: 1, b: 1 } },
  { name: '2x1x3-slot-lr', u: 2, v: 1, hUnits: 3, fingerSlots: { l: true, r: true }, slots: { l: 1, r: 1 } },
  // the back slot takes the shelf, so nothing keeps the side ones off it
  { name: '3x2x4-slot-all', u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12,
    fingerSlots: { f: true, b: true, l: true, r: true }, slots: { f: 3, b: 3, l: 2, r: 2 } },
  { name: '3x2x4-slot-lr-label', u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12,
    fingerSlots: { l: true, r: true }, slots: { l: 2, r: 2 } },
  { name: '3x2x4-slot-b-note', u: 3, v: 2, hUnits: 4, label: 12, labelMode: 1, note: 'M3 screws',
    fingerSlots: { b: true }, slots: { b: 1 }, noNote: 'slot' },
  { name: '3x2x5-slot-railed', u: 3, v: 2, hUnits: 5, divX: 2, divY: 1, divRemovable: true,
    fingerSlots: { f: true, b: true, l: true, r: true }, slots: { f: 3, b: 3, l: 2, r: 2 } },
  /* Compartments between the dividers as built: two removable ones asked for, but at a
     10 mm wall a half cell deep the plate would have no length (railedLimit's 'length'),
     so none is built and each wall has one compartment, and one slot. Fixed ones there
     would leave three, each too narrow for one. */
  { name: '1x0.5x4-slot-no-rails', u: 1, v: 0.5, hUnits: 4, wall: 10, divX: 2, divRemovable: true,
    fingerSlots: { f: true, b: true }, slots: { f: 1, b: 1 } },
  // a 12 mm scoop stands 6 mm over a 3-unit slot's bottom: the slot holds it under
  { name: '2x1x3-slot-scoop', u: 2, v: 1, hUnits: 3, scoop: 12, fingerSlots: { f: true }, slots: { f: 1 } },
  { name: '1x1x6-slot-scoop', u: 1, v: 1, hUnits: 6, scoop: 20, label: 12,
    fingerSlots: { f: true, l: true, r: true }, slots: { f: 1, l: 1, r: 1 } },
  { name: '2x1x3-slot-wall3', u: 2, v: 1, hUnits: 3, wall: 3, fingerSlots: { f: true, l: true },
    slots: { f: 1, l: 1 } },
  { name: '2x1x3-slot-wall0.4', u: 2, v: 1, hUnits: 3, wall: 0.4,
    fingerSlots: { f: true, b: true, l: true, r: true }, slots: { f: 1, b: 1, l: 1, r: 1 } },
  // a side half a cell long has a 13 mm straight: too short for one
  { name: '0.5x1x3-slot-all', u: 0.5, v: 1, hUnits: 3,
    fingerSlots: { f: true, b: true, l: true, r: true }, slots: { l: 1, r: 1 } },
  { name: '1.5x1x3-slot-all', u: 1.5, v: 1, hUnits: 3, scoop: 8, label: 10,
    fingerSlots: { f: true, b: true, l: true, r: true }, slots: { f: 1, b: 1, l: 1, r: 1 } },
  { name: '2x2x3-slot-mag-scr', u: 2, v: 2, hUnits: 3, ...BOTH, fingerSlots: { f: true, r: true },
    slots: { f: 1, r: 1 } },
  // a slot stops half a millimetre over the block the holes are in
  { name: '2x1x4-slot-hex', u: 2, v: 1, hUnits: 4, insert: 4, holes: 40, fingerSlots: { f: true, l: true },
    slots: { f: 1, l: 1 } },
  { name: '2x1x5-slot-aa-label', u: 2, v: 1, hUnits: 5, insert: 1, label: 12, holes: 4,
    fingerSlots: { f: true, l: true }, slots: { f: 1, l: 1 } },
  /* A back slot takes the label shelf, and the holes spread into its room: 4 AA cells,
     where keeping in front of a shelf that is not there left room for 2. */
  { name: '1x1x4-slot-b-aa-L12', u: 1, v: 1, hUnits: 4, insert: 1, label: 12, holes: 4,
    fingerSlots: { b: true }, slots: { b: 1 } },
  /* Spread into its room, the AAA cells' block stands 0.5 under the rim, too high for the
     slot, so they keep in front of where the shelf would be, which leaves room for none,
     and the page is told they gave way (holesGaveWay) rather than that the shelf took it,
     and why: too high for the slot in the back wall. */
  { name: '1x0.5x3-slot-b-aaa-L8', u: 1, v: 0.5, hUnits: 3, insert: 2, label: 8,
    fingerSlots: { b: true }, slots: { b: 1 }, gave: 'high:b' },
  /* Spread into its room, 2 AA cells would fit, but their block would stand too high for
     the slot in the lowered front wall. A slot asked for is not traded for holes: they keep
     in front of where the shelf would be, which leaves room for none, and both are built. */
  { name: '1x0.5x3-slot-fb-aa-L8', u: 1, v: 0.5, hUnits: 3, insert: 1, insertDepth: 8, label: 8,
    edges: { f: 0.5 }, fingerSlots: { f: true, b: true }, slots: { f: 1, b: 1 }, gave: 'high:f' },
  /* Spread into its room, the hex bits would come to 2009 holes, past the 2000 one bin is
     built with, which builds none: they keep in front of where the shelf would be, 1960 of
     them, and the slot builds over them. */
  { name: '9x8.5x3-slot-b-hex-L8', u: 9, v: 8.5, hUnits: 3, insert: 4, holeClr: -0.3, label: 8, holes: 1960,
    fingerSlots: { b: true }, slots: { b: 1 }, gave: 'many' },
  // on a thick wall the outer face is the wider: the inner one, where a finger goes, is to spec
  { name: '2x1x3-slot-wall5', u: 2, v: 1, hUnits: 3, wall: 5, fingerSlots: { f: true, l: true },
    slots: { f: 1, l: 1 } },
  // from the lowered wall's own top, off its ramps
  { name: '2x1x3-slot-low', u: 2, v: 1, hUnits: 3, edges: { f: 0.5 }, fingerSlots: { f: true, l: true },
    slots: { f: 1, l: 1 } },
  { name: '1x1x4-slot-low', u: 1, v: 1, hUnits: 4, edges: { f: 0.5, l: 0.75 },
    fingerSlots: { f: true, l: true, b: true }, slots: { f: 1, l: 1, b: 1 } },
  { name: '2x1x3-slot-open', u: 2, v: 1, hUnits: 3, edges: { f: 0 }, fingerSlots: { f: true, l: true },
    slots: { l: 1 } },
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
  // a finger slot takes the lip, as a lowered wall does: the section on them checks that
  if ((cs.cells || halfSize(cs)) && !cs.solid && !cs.edges && !cs.slots) {
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
  // a half-size bin's feet take no holes whatever its boxes say (the half-size section)
  if ((cs.magnets || cs.screws) && !halfSize(cs)) {
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
      // finger slots move points along every straight of both wall rings
      ['2x1x3 finger slots', { u: 2, v: 1, hUnits: 3, fingerSlots: { f: true, b: true, l: true, r: true } }],
      ['3x2x4 slots, everything', { u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12,
                                    fingerSlots: { f: true, l: true, r: true } }],
      ['1.5x1x4 slots, rails', { u: 1.5, v: 1, hUnits: 4, divX: 1, divRemovable: true, scoop: 8, label: 12,
                                 fingerSlots: { f: true, b: true, l: true, r: true } }],
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
                              ['half-size, rails', { u: 0.5, v: 1.5, divY: 1, divRemovable: true }],
                              ['rectangle, finger slots', { u: 2, v: 1, scoop: H, label: 42,
                                                            fingerSlots: { f: true, b: true, l: true, r: true } }],
                              ['rectangle, side slots + label', { u: 2, v: 2, scoop: H, label: 12,
                                                                  fingerSlots: { l: true, r: true } }]])
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
   plate dividerPart makes, dropped into it. It goes in only if nothing stands where it
   stands. Spaced closer than a slot and a rail apart, a neighbour's rail stands in the
   slot and takes from its clearance: the fields allowed 31 on a 1x1, and at 11 a plate
   went in with 0.208 mm of clearance where 0.25 was asked for, at 12 not at all. With a
   thin plate and little clearance the end plates' corners stood in the cavity's rounded
   corners, up to 0.26 mm into the wall at a 0.8 mm plate and 0.1 clearance. So each plate
   a bin is built for must have some length, and is set in its slot, as wide, thick and
   tall as dividerPart makes it and standing on the floor, and the bin's triangles must
   keep out of it, to a micron either way. Where the clearance at its ends took the whole
   cavity, a 1x0.5 with a 9.5 mm wall and 1 mm clearance listed a plate -0.5 mm long.
   The slot itself, the room the plate has to move by the clearance either way, must then
   be clear of the walls of the bin with no dividers, and of every rail of the bin as
   built. Held only to having the plate's corner inside the cavity, the end ones kept
   0.0014 mm of the 0.1 mm clearance asked at their corners on a 2x1 with a 1.2 mm wall,
   a 0.8 mm plate and 35 across. Held only to room for its own rails, a lone divider had
   the rails the other way 0.45 mm into each side of its 1 mm clearance on a half-cell bin
   with a 5 mm wall and a 5 mm plate, which only a bin with dividers both ways shows.
   Then each face of its slot, at each end of the plate, must have a rail standing from
   the floor to the rim along a full rail's depth of that end: the rails reached only a
   rail's depth from the wall while the plate stops the clearance short of it, so at 1 mm
   clearance a plate end sat 0.2 mm in its rails and could twist out. Each end is
   measured on its own: measured from the middle out, the far wall's rail counted for the
   near end, and a bin with rails on one wall only passed most of the rows.
   Asked for as many as the fields allow, a bin is built with as many as fit, and one more
   would not. One more is set out the same way in the same bin with no dividers, and fits
   if its plates have length, its slots and the rails that would hold them, a rail thick
   across and a rail's depth along, are clear of the walls and the floor, no two stand
   closer than a slot and a rail, and no slot stands where the rails the other way would:
   a rail's depth and the clearance from each end wall, and ten times WELD (0.02 mm) more
   so that their tips are not flush with its face. The limit for one way cannot know
   whether there will be any the other way, so it keeps clear of them either way. That
   only ever decides a lone divider, which has no neighbour, so what decides it is room
   for those rails: the limit once asked it for a neighbour's spacing, and built none on
   a half-cell bin with a 3 mm wall at a 5 mm plate, where one fits. Some of the rows
   below are just that. That is done at both ends of the plate and the clearance the page
   takes, and at its three smoothnesses, which set the corners' chords, and then with
   dividers both ways on half cells with thick walls and on whole cells with thin ones.
   The lip is left off. Its chamfer stands over the top of every plate's ends, which is a
   matter of the lip and not of where the dividers stand. */
{
  const triBox = (c, h, t) => {
    const v = t.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
    for (let a = 0; a < 3; a++)
      if (Math.min(v[0][a], v[1][a], v[2][a]) > h[a] || Math.max(v[0][a], v[1][a], v[2][a]) < -h[a]) return false;
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
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
  // whether any triangle reaches into the box lo..hi
  const blocked = (tris, lo, hi) => {
    const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2), h = [0, 1, 2].map((a) => (hi[a] - lo[a]) / 2);
    return tris.some(({ t, lo: a, hi: b }) =>
      a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1] && a[2] <= hi[2] && b[2] >= lo[2] &&
      triBox(c, h, t));
  };
  const most = (inside, wall) => Math.max(0, Math.floor(inside / Math.max(wall, 1.2)) - 1);
  const RAIL_T = 1.2, RAIL_D = 1.2, E = 1e-6;
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
  const faults = (cfg) => {
    const c = Object.assign({}, BIN_DEFAULTS, cfg), H = c.hUnits * SPEC.unitH;
    const r = buildBin(G, cfg), tris = trisOf(r.polys), built = dividersBuilt(cfg), out = [];
    const bareKey = JSON.stringify(Object.assign({}, cfg, { divX: 0, divY: 0, divRemovable: false }));
    if (!bare.has(bareKey)) bare.set(bareKey, trisOf(buildBin(G, JSON.parse(bareKey)).polys));
    /* Clear of every triangle, and inside the cavity's rectangle: a box wholly inside a
       wall meets no triangle either. */
    const room = [innerOf(c, 0), innerOf(c, 1)];
    const inside = (box) => [0, 1].every((a) => box.lo[a] >= -room[a] && box.hi[a] <= room[a]);
    const clear = (box) => inside(box) && !blocked(bare.get(bareKey), box.lo, box.hi);
    let plates = 0;
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
        if (Math.min(...zs) <= r.meta.floorZ + 0.05 + E && Math.max(...zs) >= H - E)
          faces.push([x, Math.min(...as), Math.max(...as)]);
      }
      for (const pl of platesOf(c, r, n, ax, -E)) {
        plates++;
        if (pl.end < RAIL_D) short++;
        if (!(pl.end > 0)) { out.push(`${key} plate ${pl.k} of ${n} has no length`); continue; }
        if (!inside(pl) || blocked(tris, pl.lo, pl.hi)) { out.push(`${key} plate ${pl.k} of ${n} blocked`); continue; }
        // its room to move by the clearance either way: clear of the walls, then of every rail
        const slot = slotOf(pl, ax, -E);
        if (!clear(slot)) { out.push(`${key} plate ${pl.k} of ${n} has its slot in a corner`); continue; }
        if (blocked(tris, slot.lo, slot.hi)) { out.push(`${key} plate ${pl.k} of ${n} has a rail in its clearance`); continue; }
        // each face of the slot, at each end on its own: from the middle to that end
        const need = Math.min(RAIL_D, pl.end) - 1e-6;
        for (const x of pl.faces) for (const s of [-1, 1]) {
          const hold = Math.max(0, ...faces.filter((f) => Math.abs(f[0] - x) < 1e-7)
            .map(([, a, b]) => (s > 0 ? Math.min(b, pl.end) - Math.max(a, 0) : Math.min(b, 0) - Math.max(a, -pl.end))));
          if (pl.end >= RAIL_D) least = Math.min(least, hold);
          if (hold < need) { out.push(`${key} plate ${pl.k} of ${n} held ${hold.toFixed(2)} mm at one end`); break; }
        }
      }
      /* one more: crowded by a neighbour, its slots or their rails into a wall of the bare
         bin, a slot where the rails the other way would stand, or a plate with no length */
      if (n < (c[key] || 0)) {
        const k = n + 1, crowded = k > 1 && 2 * inner / (k + 1) < pitch - 1e-9;
        const reach = RAIL_D + c.divClr + 0.02;
        if (!crowded && platesOf(c, r, k, ax, E).every((pl) => pl.end > 0 && clear(slotOf(pl, ax, E)) &&
            railsOf(pl, ax, H).every(clear) && pl.faces[0] >= -inner + reach - 1e-9 && pl.faces[1] <= inner - reach + 1e-9))
          out.push(`${key}: ${k} would have fit, ${n} built`);
      }
    }
    return { out, plates };
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
  let plates = 0;
  const fails = [], kinds = {};
  for (const [name, cfg] of rows) {
    const f = faults(cfg);
    plates += f.plates;
    if (f.out.length) fails.push(`${name}: ${f.out[0]}${f.out.length > 1 ? ` and ${f.out.length - 1} more` : ''}`);
    for (const k of new Set(f.out.map((t) => t.replace(/.*\b(length|blocked|corner|clearance|held|would have fit|asked)\b.*/, '$1'))))
      kinds[k] = (kinds[k] || 0) + 1;
  }
  console.log(`  ${rows.length} bins, ${plates} plates, ${lone} with one divider where two would not go: ` + (fails.length
    ? `${fails.length} FAILED (${Object.entries(kinds).map(([k, n]) => `${k} in ${n}`).join(', ')}), ` +
      `${fails.slice(0, 4).join('; ')}${fails.length > 4 ? ` and ${fails.length - 4} more` : ''}`
    : !lone ? 'NONE with a lone divider, so that was not tried'
    : `every one in its slot, each end held ${least.toFixed(2)} mm or more, ` +
      `or along its whole half in the ${short} shorter than two rails' depth`));
  if (fails.length || !lone) bad++;
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
 * full rail's depth in them (reach in buildBin), and nothing else in it changed. */
console.log('\nlinks from before half sizes build the same bytes');
{
  const crypto = require('crypto');
  const OLD = [
    ['1x1x3', '0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0', 'a6b5ca988bcf9ec4'],
    ['1x1x1', '4-1-1-1-1-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0', '055b9aa96e86b515'],
    ['3x2x5, dividers, scoop and label', '1-2-3-2-5-1.2-1.2-2-1-0-1-1-1-1-6-10-0-0-0-0-15-0', '66c515b3c3ab2fcc'],
    ['2x2x3, removable dividers', '0-0-2-2-3-1.2-1.2-1-1-0-1-1-1-1-0-0-0-0-1-0-15-0', '7b838b800b92ce03'],
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
    if (cs.noNote) {
      /* A finger slot in the back wall takes the shelf's place, and the letters with it:
         nothing stands at the back but the floor, and the page is told why. */
      const back = at(0, id - 3).pop();
      if (s.fit || s.why !== cs.noNote) faults.push(`shelfNote says ${s.fit ? 'letters' : s.why}, not ${cs.noNote}`);
      if (!(back < H / 2)) faults.push(`something at the back stands ${back.toFixed(2)} high`);
    } else if (!s.fit) faults.push(`NO LETTERS (${s.why})`);
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
         evenly across the cavity, not from what built it. A bin that has holes has no
         dividers (the section on holes below), so it has none to keep clear of. */
      const wall = cs.wall !== undefined ? cs.wall : BIN_DEFAULTS.wall;
      const iw = (cs.u - 1) * SPEC.pitch / 2 + SPEC.half - wall;
      const dT = cs.divT !== undefined ? cs.divT : BIN_DEFAULTS.divT;
      const dC = cs.divClr !== undefined ? cs.divClr : BIN_DEFAULTS.divClr;
      const half = cs.divRemovable ? dT / 2 + dC + 1.2 : wall / 2;
      // the dividers as built: removable ones no more than fit, and none with holes
      const built = r.meta.holes ? { divX: 0, divY: 0 } : dividersBuilt(cs);
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
      (faults.length ? faults.join('; ') : cs.noNote ? `no shelf and no letters: ${cs.noNote}`
        : 'letters at H - 0.4 on a shelf at H - 1.0' +
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

/* Holes across the floor (insert, holeLayout in bin.js).
 *
 * Built, not merely closed: a block with no holes in it, or no block, is just as
 * watertight. So every case above with holes is probed from above. Straight down through
 * the centre of every hole the first thing met is the bin's floor; through the block
 * beside a hole it is the block's top, the floor plus the depth. Around the first hole,
 * just inside its nominal width is the floor on every side, so no hole is tighter than it
 * says, and just outside the corners of its facets is the block, so none is looser than
 * its polygon. The hole's width and the item's length are written here from the spec,
 * not read from INSERTS.
 *
 * The layout is checked against the rules it was made by, measured from the spec's
 * outline: webs of 1.2 mm at least, every hole inside the lip's opening with a quarter of
 * a millimetre to spare (2.70 from the outside), or 0.8 from the wall without a lip, and
 * in front of a label shelf by 0.8. With a shelf the block runs on under it to the back
 * wall and stops below it: under the middle of the shelf there is block, and the highest
 * thing is still the shelf. */
console.log('\nholes across the floor');
/* Edges not used exactly twice once every vertex within `tol` of another is one vertex,
   as a slicer welds them: a grid of cells `tol` across, each vertex joined to any within
   tol of it in its own cell or the 26 around it. */
function weldOpen(polys, tol) {
  const verts = [], ids = new Map(), cell = new Map();
  const tris = G.polysToTriangles(polys).map((t) => t.map((v) => {
    const k = v.join(',');
    if (!ids.has(k)) { ids.set(k, verts.length); verts.push(v); }
    return ids.get(k);
  }));
  const up = verts.map((_, i) => i);
  const find = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const at = (v) => v.map((x) => Math.floor(x / tol));
  verts.forEach((v, i) => {
    const k = at(v).join(',');
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(i);
  });
  verts.forEach((v, i) => {
    const [cx, cy, cz] = at(v);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const j of cell.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
        if (j <= i) continue;
        const w = verts[j];
        if (Math.abs(v[0] - w[0]) <= tol && Math.abs(v[1] - w[1]) <= tol && Math.abs(v[2] - w[2]) <= tol) {
          const a = find(i), b = find(j);
          if (a !== b) up[a] = b;
        }
      }
  });
  const E = new Map();
  for (const t of tris) {
    const f = t.map(find);
    if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) continue;
    for (let i = 0; i < 3; i++) {
      const a = f[i], b = f[(i + 1) % 3], k = a < b ? a + '|' + b : b + '|' + a;
      E.set(k, (E.get(k) || 0) + 1);
    }
  }
  let open = 0;
  for (const n of E.values()) if (n !== 2) open++;
  return open;
}
{
  const ITEM = { 1: { across: 15.0, len: 50.5 }, 2: { across: 11.0, len: 44.5 },
                 3: { across: 19.0, len: 65.5 }, 4: { across: 6.65, len: 25, hex: true } };
  const near = (z, want) => z !== undefined && Math.abs(z - want) < 1e-6;
  for (const cs of CASES.filter((c) => c.insert && c.holes)) {
    const t0 = Date.now();
    const r = buildBin(G, cs);
    const ms = Date.now() - t0;
    const h = insertPlan(cs), at = prober(r.polys), faults = [];
    const it = ITEM[cs.insert], across = it.across + (cs.holeClr || 0);
    const H = cs.hUnits * SPEC.unitH, wall = cs.wall === undefined ? BIN_DEFAULTS.wall : cs.wall;
    const floorT = cs.screws ? Math.max(BIN_DEFAULTS.floorT, HOLE.floor) : BIN_DEFAULTS.floorT;
    const floor = SPEC.footH + floorT + 0.05;                 // the slab runs a BLOAT past floorZ
    const depth = cs.depth !== undefined ? cs.depth : Math.max(5, it.len / 3);
    // the polygon's corners: a hex's across its flats over cos 30, a round one's over cos 5
    const corner = it.hex ? across / Math.sqrt(3) : across / 2 / Math.cos(Math.PI / 36);
    const bx = it.hex ? across : 2 * corner, by = 2 * corner;
    if (r.meta.holes !== cs.holes || !h.n || h.n !== cs.holes)
      faults.push(`${r.meta.holes} holes built, ${h.n} said, ${cs.holes} wanted`);
    else {
      if (!near(h.depth, depth)) faults.push(`${h.depth.toFixed(2)} deep, not ${depth.toFixed(2)}`);
      let floors = 0;
      for (const x of h.xs) for (const y of h.ys) if (near(at(x, y).pop(), floor)) floors++;
      if (floors !== h.n) faults.push(`${h.n - floors} hole centres not down to the floor at ${floor.toFixed(2)}`);
      const [x0, y0] = [h.xs[0], h.ys[0]];
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4 + 0.1, c = Math.cos(a), s = Math.sin(a);
        const inZ = at(x0 + (across / 2 - 0.02) * c, y0 + (across / 2 - 0.02) * s).pop();
        // the highest surface up to the block's top: by a wall the lip leans in over it
        const outZ = at(x0 + (corner + 0.02) * c, y0 + (corner + 0.02) * s)
          .filter((z) => z < floor + depth + 0.5).pop();
        if (!near(inZ, floor)) { faults.push(`inside the first hole at ${k * 45} degrees, ${inZ && inZ.toFixed(2)}`); break; }
        if (!near(outZ, floor + depth)) { faults.push(`beside the first hole at ${k * 45} degrees, ${outZ && outZ.toFixed(2)}, not the block's top at ${(floor + depth).toFixed(2)}`); break; }
      }
      // the layout's rules, from the spec's outline
      const hw = (cs.u - 1) * 21 + 20.75, hd = (cs.v - 1) * 21 + 20.75;
      const lip = !cs.edges, Wl = Math.max(0.4, wall);
      const side = lip ? Math.max(0.8, 2.70 + 0.25 - Wl) : 0.8;
      // a finger slot in the back wall takes the shelf away
      const shelved = cs.label && !(cs.slots && cs.slots.b), shelf = shelved ? shelfNote(cs) : null;
      const webs = [];
      for (let i = 1; i < h.xs.length; i++) webs.push(h.xs[i] - h.xs[i - 1] - bx);
      for (let j = 1; j < h.ys.length; j++) webs.push(h.ys[j] - h.ys[j - 1] - by);
      if (webs.length && Math.min(...webs) < 1.2 - 1e-9) faults.push(`a web of ${Math.min(...webs).toFixed(2)} mm`);
      const reachX = Math.max(...h.xs.map(Math.abs)) + bx / 2, front = -Math.min(...h.ys) + by / 2;
      const backY = Math.max(...h.ys) + by / 2;
      if (reachX > hw - Wl - side + 1e-9 || front > hd - Wl - side + 1e-9)
        faults.push(`a hole reaches ${(hw - reachX).toFixed(2)} / ${(hd - front).toFixed(2)} from the outside, past the ${(Wl + side).toFixed(2)} kept`);
      /* ...and the corners are rounded, the cavity's on an arc of 3.75 less the wall and
         the lip's opening on one of 1.05, so every corner of every hole is measured to
         those outlines as well: 0.8 from the cavity's, and with a lip 0.25 inside its
         opening. Without a lip, hex bits came 0.72 from a 0.4 mm wall's corner. */
      const rrIn = (x, y, a, b, r) => {
        const ax = Math.abs(x), ay = Math.abs(y);
        return ax > a - r && ay > b - r ? r - Math.hypot(ax - (a - r), ay - (b - r)) : Math.min(a - ax, b - ay);
      };
      const ring = it.hex ? [0, 1, 2, 3, 4, 5].map((k) => Math.PI / 2 + k * Math.PI / 3)
        : Array.from({ length: 36 }, (_, k) => 2 * Math.PI * k / 36);
      let toWall = Infinity, toLip = Infinity;
      for (const x of h.xs) for (const y of h.ys) for (const a of ring) {
        const px = x + corner * Math.cos(a), py = y + corner * Math.sin(a);
        toWall = Math.min(toWall, rrIn(px, py, hw - Wl, hd - Wl, Math.max(0.4, 3.75 - Wl)));
        toLip = Math.min(toLip, rrIn(px, py, hw - 2.70, hd - 2.70, 1.05));
      }
      if (toWall < 0.8 - 1e-9) faults.push(`a hole ${toWall.toFixed(3)} from the cavity's outline`);
      if (lip && toLip < 0.25 - 1e-9) faults.push(`a hole ${toLip.toFixed(3)} inside the lip's opening`);
      /* Welded at 10 microns, it closes as the bin without holes does: two tiles whose
         points are a micron apart are one vertex to a slicer, and that left edges open
         that checkManifold, which rounds to a micron, could miss. */
      const open = weldOpen(r.polys, 0.01), was = weldOpen(buildBin(G, Object.assign({}, cs, { insert: 0 })).polys, 0.01);
      if (open > was) faults.push(`${open} edges open welded at 10 microns, where the bin without holes has ${was}`);
      // the shelf as built: noteOnShelf's depth with a note, else as asked (12 fits all of these)
      const sd = shelf && shelf.depth ? shelf.depth : cs.label;
      // given way to a back slot, they keep clear of where it would be, as if it were there
      if ((shelved || cs.gave) && backY > hd - Wl - sd - 0.8 + 1e-9)
        faults.push(`a hole reaches under ${shelved ? 'the shelf' : 'where the shelf would be'}, to ${backY.toFixed(2)}`);
      if (shelved) {
        const top = shelf && shelf.fit ? H - 1.0 : H;
        const under = at(0, hd - Wl - sd / 2);
        if (!under.some((z) => near(z, floor + depth))) faults.push('no block under the shelf');
        if (!near(under[under.length - 1], top)) faults.push(`the block comes through the shelf: ${under[under.length - 1].toFixed(2)}`);
      } else if (backY > hd - Wl - side + 1e-9) faults.push(`a hole reaches ${(hd - backY).toFixed(2)} from the back`);
    }
    console.log(`  ${cs.name.padEnd(20)} ` + (faults.length ? 'WRONG: ' + faults.join('; ')
      : `${String(h.n).padStart(3)} holes ${across.toFixed(2)} across, ${h.depth.toFixed(2)} deep, ` +
        `${h.xs.length} x ${h.ys.length}` + (h.n > 200 ? `, built in ${ms} ms` : '')));
    if (faults.length) bad++;
  }

  /* No dividers and no scoop where there are holes: the holes take the floor. A bin asked
     for both is the same part as the bin with neither. */
  const stl = (cfg) => Buffer.from(G.stlBinary(buildBin(G, cfg).polys, 'b')).toString('base64');
  const holed = { u: 2, v: 2, hUnits: 3, insert: 4 };
  const extras = [{ divX: 2, divY: 1, scoop: 8 }, { divX: 1, divY: 1, divRemovable: true }];
  const kept = extras.filter((e) => stl(Object.assign({}, holed, e)) !== stl(holed)).map((e) => JSON.stringify(e));
  console.log(`  ${'dividers and scoop'.padEnd(20)} ` + (kept.length ? 'BUILT beside holes: ' + kept.join(', ')
    : `${extras.length} kinds left off, each the same STL as the bin without`));
  if (kept.length) bad++;

  /* Opt-in, and only when there are holes to build: every other bin is built to the byte
     as it was, whatever its hole settings say. Each row is a bin that has to come out the
     same as without them, and the reason insertPlan gives the page for building none. */
  const one = { u: 1, v: 1, hUnits: 3 };
  const SAME = [
    ['none asked for', { u: 2, v: 1, hUnits: 3, label: 12, scoop: 8, divX: 1 },
     { insert: 0, insertDepth: 12, holeClr: 0.5 }, 'off'],
    ['not a preset', one, { insert: 9 }, 'off'],
    ['not a number', one, { insert: 'AA' }, 'off'],
    ['carved', { u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) }, { insert: 1 }, 'carved'],
    ['solid', Object.assign({}, one, { solid: true }), { insert: 4 }, 'solid'],
    ['a 1-unit bin, too short', Object.assign({}, one, { hUnits: 1 }), { insert: 4 }, 'short'],
    ['18650s in half a cell', { u: 0.5, v: 0.5, hUnits: 6 }, { insert: 3 }, 'none'],
    // 2392 of them, past the most one bin is built with (HOLES_MAX)
    ['hex bits on a 10x10', { u: 10, v: 10, hUnits: 3 }, { insert: 4 }, 'many'],
    // none fit, so the dividers are built after all and the note goes between them
    ['18650s, a note between dividers', { u: 0.5, v: 1, hUnits: 3, label: 12, labelMode: 1, divY: 3, note: 'M2' },
     { insert: 3 }, 'none'],
  ];
  const moved = SAME.map(([name, cfg, extra, why]) => {
    const withIt = Object.assign({}, cfg, extra), got = insertPlan(withIt).why;
    if (stl(cfg) !== stl(withIt)) return `${name}: BUILT DIFFERENTLY`;
    if (buildBin(G, withIt).meta.holes) return `${name}: counts holes`;
    if (JSON.stringify(shelfNote(cfg)) !== JSON.stringify(shelfNote(withIt))) return `${name}: its note told differently`;
    return got === why ? '' : `${name}: insertPlan says ${got}, not ${why}`;
  }).filter(Boolean);
  console.log(`  ${'bins with no holes'.padEnd(20)} ` + (moved.length ? 'FAILED: ' + moved.join('; ')
    : `${SAME.length} kinds, each the same STL to the byte, and the page told why`));
  if (moved.length) bad++;

  /* The most holes one bin is built with, at the boundary: exactly HOLES_MAX are laid
     out, and one more is refused ('many'), where the row above only tries 2392. Asked of
     insertPlan alone: the 2000 AAA holes are 1.07 million triangles to build. */
  const EDGE = [
    ['AAA on an 11.5x14.5, 40 x 50', { u: 11.5, v: 14.5, hUnits: 6, insert: 2, holeClr: -0.3 }, '', HOLES_MAX],
    ['hex bits on a 4.5x18, 5 mm walls', { u: 4.5, v: 18, hUnits: 6, wall: 5, insert: 4, holeClr: -0.3 },
     'many', HOLES_MAX + 1],
  ];
  const off = EDGE.map(([name, cfg, why, n]) => {
    const h = insertPlan(cfg), got = why ? h.count : h.n;
    return h.why === why && got === n ? '' : `${name}: ${h.why || 'built'}, ${got} holes`;
  }).filter(Boolean);
  console.log(`  ${'the most holes'.padEnd(20)} ` + (off.length ? 'WRONG: ' + off.join('; ')
    : `${HOLES_MAX} laid out, ${HOLES_MAX + 1} refused`));
  if (off.length) bad++;

  /* Links from before holes, built by the engine before them: the same bytes. A shelf, a
     raised note and the dividers and scoop are what the holes' code goes past on its way,
     so those are the rows. Notes ride in bnotes, so the two that print one are given it.
     The removable dividers' row is main's since its rails reach the clearance further
     (#50), as the table of links from before the feet holes has it. */
  const crypto = require('crypto');
  const BEFORE = [
    ['2x1x4, label shelf 12', '0-0-2-1-4-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15', {}, '314a909d03d54277'],
    ['1x1x3, note raised', '0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15-0-1', { note: 'M3 screws' }, 'e43cbc548a2737ae'],
    ['3x2x5, dividers, scoop, label, magnets', '0-0-3-2-5-1.2-1.2-2-1-0-1-1-1-1-8-12-0-0-0-0-15-1', {}, '378b909714f22d86'],
    ['2x2x3, removable dividers', '0-0-2-2-3-1.2-1.2-1-1-0-1-1-1-1-0-0-0-0-1-0-15', {}, '7b838b800b92ce03'],
    ['1.5x1x3, scoop and label', '0-0-1.5-1-3-1.2-1.2-0-0-0-1-1-1-1-8-10-0-0-0-0-15', {}, '4a2046d7ad5c3eae'],
    ['2x1x3 tray, open front', '0-0-2-1-3-1.2-1.2-0-0-0-0-1-1-1-0-0-0-0-0-0-15', {}, '0c8a28868cae2148'],
    ['2x1x2, note raised over screws', '0-0-2-1-2-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15-2-1', { note: 'Fuses 5A' }, 'fadd35485043a028'],
  ];
  const changed = BEFORE.map(([name, link, extra, want]) => {
    const got = crypto.createHash('sha256').update(Buffer.from(G.stlBinary(
      buildBin(G, Object.assign(unpackBin(link), extra)).polys, 'b'))).digest('hex').slice(0, 16);
    return got === want ? '' : `${name} (${link}) now ${got}, was ${want}`;
  }).filter(Boolean);
  console.log(`  ${'links from before'.padEnd(20)} ` + (changed.length ? 'CHANGED: ' + changed.join('; ')
    : `${BEFORE.length} links, each the same STL to the byte`));
  if (changed.length) bad++;
}

/* Finger slots: a U-shaped dip in the top of a wall, one per compartment.
 *
 * Built, not merely closed: a bin whose slots were left out is just as watertight. So the
 * top of every wall asked for one is read off the mesh, on both its faces, and every dip
 * in its inner face, where a finger goes in, measured against the spec, written here:
 * 20 mm across the top or the room the
 * compartment has, never under 13; sides at 70 degrees; two 4 mm rounded corners at the
 * bottom; the bottom half way down the wall's own height above the floor, or where the
 * two corners meet if that is higher, or half a millimetre over the block of holes across
 * the floor if that is higher still. A wall's top edge as a whole is held to the 75
 * degrees every wall's is (see where a lowered wall meets a full-height one), and the
 * stacking lip has to be gone, since a lip over a dip has nothing under it. The outer face
 * takes the same fractions of its straight, which is the longer on a wall over 3.35 mm,
 * where the cavity's corners stop getting smaller, so there each dip is wider by the two
 * straights' ratio, about the same middle, to the same bottom.
 *
 * Nothing inside may stand in a slot: along each one, just inside the wall, the highest
 * thing is no higher than the top of the wall there. That is what keeps a slot off the
 * dividers and rails, the scoop, the label shelf and the block of holes. */
console.log('\nfinger slots');
{
  const F = { top: 20, angle: 70, round: 4, share: 0.5, least: 13, clear: 0.5 };
  const tan = (d) => Math.tan(d * Math.PI / 180);
  const deepest = (a) => (a - F.round * tan(F.angle / 2)) * tan(F.angle);
  for (const cs of CASES.filter((c) => c.slots)) {
    const r = buildBin(G, cs), at = prober(r.polys), faults = [];
    const H = cs.hUnits * SPEC.unitH;
    const wall = Math.max(0.4, cs.wall === undefined ? BIN_DEFAULTS.wall : cs.wall);
    const floorT = cs.screws ? Math.max(BIN_DEFAULTS.floorT, HOLE.floor) : BIN_DEFAULTS.floorT;
    const floorZ = SPEC.footH + floorT;
    const hw = (cs.u - 1) * 21 + 20.75, hd = (cs.v - 1) * 21 + 20.75;
    let zmax = -Infinity;
    for (const p of r.polys) for (const w of p.verts) zmax = Math.max(zmax, w[2]);
    if (r.meta.hasLip || r.meta.lipH || zmax > H + 1e-6) faults.push(`a lip: ${zmax.toFixed(2)} tall`);
    const want = Object.entries(cs.slots);
    const n = want.reduce((s, [, k]) => s + k, 0);
    if (r.meta.fingers !== n) faults.push(`${r.meta.fingers} slots built, ${n} wanted`);
    /* The holes the page is told of are the ones built, and with a back slot over a
       shelf, whether they gave way to it, and why: 'many' when spread into its room they
       would come to more than one bin is built with, 'high' and the walls whose slots they
       would stand too high for. */
    const plan = fingerSlotPlan(cs), told = cs.insert ? insertPlan(cs).n || 0 : 0;
    if ((r.meta.holes || 0) !== (cs.holes || 0) || told !== (cs.holes || 0))
      faults.push(`${r.meta.holes || 0} holes built, ${told} said, ${cs.holes || 0} wanted`);
    if (plan.shelfOff !== !!(cs.label && cs.slots.b)) faults.push(`shelfOff ${plan.shelfOff}`);
    const g = plan.holesGaveWay, gave = g ? g.why + (g.walls ? ':' + g.walls : '') : false;
    if (gave !== (cs.gave || false)) faults.push(`holesGaveWay ${gave}, not ${cs.gave || false}`);
    let worstSide = 0, narrowest = Infinity, widest = 0, bottoms = [];
    for (const side of ['f', 'b', 'l', 'r']) {
      const e = cs.edges && cs.edges[side] !== undefined ? cs.edges[side] : 1;
      const T = floorZ + e * (H - floorZ);
      /* The top of the wall along each face, the highest point at each place along it, read
         off the ribbon across the wall's top: its faces are the only ones with a corner on
         each face, so a divider, the scoop or the shelf against the inner face is not taken
         for the wall. */
      const across = side === 'f' || side === 'b', sign = side === 'f' || side === 'l' ? -1 : 1;
      const outerAt = sign * (across ? hd : hw), innerAt = outerAt - sign * wall;
      const on = (w, f) => Math.abs(w[across ? 1 : 0] - f) < 1e-4;
      const ribbon = r.polys.filter((p) => p.verts.some((w) => on(w, outerAt)) && p.verts.some((w) => on(w, innerAt)));
      const topAlong = (f) => {
        const tops = new Map();
        for (const p of ribbon) for (const w of p.verts) {
          if (!on(w, f) || w[2] < floorZ + 0.5) continue;
          const k = (across ? w[0] : w[1]).toFixed(4);
          tops.set(k, Math.max(tops.get(k) ?? -Infinity, w[2]));
        }
        return [...tops].map(([k, z]) => [+k, z]).sort((a, b) => a[0] - b[0]);
      };
      const outer = topAlong(outerAt), prof = topAlong(innerAt);
      const edgeAt = (x) => {
        for (let i = 1; i < prof.length; i++)
          if (x <= prof[i][0]) return prof[i - 1][1] + (prof[i][1] - prof[i - 1][1]) *
            (x - prof[i - 1][0]) / (prof[i][0] - prof[i - 1][0]);
        return prof[prof.length - 1][1];
      };
      // the whole top edge, ramps and all, on both faces
      const steepest = (pr) => {
        let steep = 0;
        for (let i = 1; i < pr.length; i++) {
          const climb = Math.abs(pr[i][1] - pr[i - 1][1]);
          if (climb >= 0.2) steep = Math.max(steep, Math.atan2(climb, pr[i][0] - pr[i - 1][0]) * 180 / Math.PI);
        }
        return steep;
      };
      for (const [f, pr] of [['inner', prof], ['outer', outer]])
        if (steepest(pr) > 75) faults.push(`${side}: a cliff of ${steepest(pr).toFixed(1)} degrees on the ${f} face`);
      // each run below the wall's own top is a slot, from the top corner before it to the one after
      const dipsOf = (pr) => {
        const dips = [];
        for (let i = 0; i < pr.length; i++) {
          if (!(pr[i][1] < T - 1e-6)) continue;
          let j = i;
          while (j + 1 < pr.length && pr[j + 1][1] < T - 1e-6) j++;
          if (i === 0 || j + 1 === pr.length) return [];      // no top corner: not a slot
          dips.push({ x0: pr[i - 1][0], x1: pr[j + 1][0], run: pr.slice(i - 1, j + 2) });
          i = j;
        }
        return dips;
      };
      const dips = dipsOf(prof), outs = dipsOf(outer);
      if (dips.length !== (cs.slots[side] || 0) || outs.length !== dips.length) {
        faults.push(`${side}: ${dips.length} slots inside, ${outs.length} outside, ${cs.slots[side] || 0} wanted`);
        continue;
      }
      // the two straights, end to end along each face: the outer is the longer on a thick wall
      const stretch = (outer[outer.length - 1][0] - outer[0][0]) / (prof[prof.length - 1][0] - prof[0][0]);
      for (const [i, d] of dips.entries()) {
        const w = d.x1 - d.x0, mid = (d.x0 + d.x1) / 2;
        const bottom = Math.min(...d.run.map(([, z]) => z));
        let sides = 0;
        for (let i = 1; i < d.run.length; i++) {
          const climb = Math.abs(d.run[i][1] - d.run[i - 1][1]);
          if (climb >= 0.2) sides = Math.max(sides, Math.atan2(climb, d.run[i][0] - d.run[i - 1][0]) * 180 / Math.PI);
        }
        // just inside the wall, at the slot's middle and along it
        const inside = (x) => {
          const q = across ? [x, side === 'f' ? -hd + wall + 0.3 : hd - wall - 0.3]
                           : [side === 'l' ? -hw + wall + 0.3 : hw - wall - 0.3, x];
          const zs = at(q[0], q[1]);
          return zs.length ? zs[zs.length - 1] : -Infinity;
        };
        const block = cs.insert ? inside(mid) + F.clear : -Infinity;
        const expect = Math.max(T - Math.min(F.share * (T - floorZ), deepest(w / 2)), block);
        if (w > F.top + 1e-6 || w < F.least - 1e-6) faults.push(`${side}: ${w.toFixed(2)} across`);
        if (Math.abs(sides - F.angle) > 0.5) faults.push(`${side}: sides at ${sides.toFixed(1)} degrees`);
        if (Math.abs(bottom - expect) > 1e-3)
          faults.push(`${side}: bottom at ${bottom.toFixed(3)}, not ${expect.toFixed(3)}`);
        const o = outs[i], ow = o.x1 - o.x0;
        if (Math.abs(ow - w * stretch) > 1e-3 || Math.abs((o.x0 + o.x1) / 2 - mid * stretch) > 1e-3 ||
            Math.abs(Math.min(...o.run.map(([, z]) => z)) - bottom) > 1e-6)
          faults.push(`${side}: ${ow.toFixed(2)} across outside, not ${(w * stretch).toFixed(2)}`);
        for (let x = d.x0 + 0.5; x <= d.x1 - 0.5; x += 0.5) {
          const z = inside(x), edge = edgeAt(x) - (cs.insert ? F.clear : 0);
          if (z > edge + 1e-3) { faults.push(`${side}: at ${x.toFixed(1)} something inside stands ${(z - edge).toFixed(2)} into the slot`); break; }
        }
        // with nothing to keep it off-centre, in the middle of the wall
        if (!cs.divX && !cs.divY && !cs.label && !cs.scoop && !cs.edges && Math.abs(mid) > 1e-3)
          faults.push(`${side}: ${mid.toFixed(2)} off the middle`);
        widest = Math.max(widest, ow);
        worstSide = Math.max(worstSide, sides);
        narrowest = Math.min(narrowest, w);
        bottoms.push(bottom);
      }
    }
    console.log(`  ${cs.name.padEnd(22)} ` + (faults.length ? 'WRONG: ' + faults.slice(0, 4).join('; ')
      : `${String(n).padStart(2)} ${n > 1 ? 'slots' : 'slot '} ${narrowest.toFixed(2)}+ across` +
        `${widest > narrowest + 1e-3 && cs.wall > 3.35 ? ` (to ${widest.toFixed(2)} outside)` : ''}, sides ` +
        `${worstSide.toFixed(1)}°, bottom ${Math.min(...bottoms).toFixed(2)}${bottoms.some((b) => b !== bottoms[0]) ? ' to ' + Math.max(...bottoms).toFixed(2) : ''}, no lip`));
    if (faults.length) bad++;
  }

  /* Opt-in, and only where one can be built: every other bin is built to the byte as it
     was, whatever its slot settings say. Each row is a bin that has to come out the same
     as without them, and the reason fingerSlotPlan gives the page for building none. */
  const stl = (cfg) => Buffer.from(G.stlBinary(buildBin(G, cfg).polys, 'b')).toString('base64');
  const one = { u: 1, v: 1, hUnits: 3 }, front = { fingerSlots: { f: true } };
  const SAME = [
    ['none asked for', { u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12 },
     { fingerSlots: { f: false, b: false, l: false, r: false } }, null],
    ['a 1-unit bin, too shallow', Object.assign({}, one, { hUnits: 1 }), front, 'low'],
    ['a quarter-height front', Object.assign({}, one, { edges: { f: 0.25 } }), front, 'low'],
    ['an open front', Object.assign({}, one, { edges: { f: 0 } }), front, 'open'],
    ['four compartments in a 1x1', Object.assign({}, one, { divX: 3 }), front, 'narrow'],
    ['half a cell square', { u: 0.5, v: 0.5, hUnits: 3 }, { fingerSlots: { f: true, b: true, l: true, r: true } }, 'narrow'],
    ['carved', { u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) }, front, 'carved'],
    ['solid', Object.assign({}, one, { solid: true }), front, 'solid'],
    ['AA cells in a 1x1x3', Object.assign({}, one, { insert: 1 }), front, 'holes'],
  ];
  const moved = SAME.map(([name, cfg, extra, why]) => {
    const withIt = Object.assign({}, cfg, extra), plan = fingerSlotPlan(withIt);
    if (stl(cfg) !== stl(withIt)) return `${name}: BUILT DIFFERENTLY`;
    if (buildBin(G, withIt).meta.fingers || plan.n) return `${name}: counts slots`;
    const got = Object.values(plan.sides).map((s) => s.why);
    return why === null ? (got.length ? `${name}: says ${got}` : '')
      : got.length && got.every((g) => g === why) ? '' : `${name}: fingerSlotPlan says ${got}, not ${why}`;
  }).filter(Boolean);
  console.log(`  ${'bins with no slots'.padEnd(22)} ` + (moved.length ? 'FAILED: ' + moved.join('; ')
    : `${SAME.length} kinds, each the same STL to the byte, and the page told why`));
  if (moved.length) bad++;
}

console.log(bad ? `\n${bad} case(s) FAILED` : '\nall cases clean');
process.exit(bad ? 1 : 0);
