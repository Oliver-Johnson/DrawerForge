/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Drawerforge — Gridfinity bin geometry.
 *
 * Built entirely by direct mesh construction and overlapping closed shells.
 * There is NO CSG in this file: see docs/ENGINE.md — the hand-rolled BSP is
 * fragile around the conical foot surfaces, and every feature here can be made
 * additively instead. Shells overlap by BLOAT and the slicer fuses them.
 *
 * Spec (42 mm pitch), from the published Gridfinity specification:
 *   footprint 41.5 mm square at its widest, corner fillet r = 3.75 mm
 *   foot profile from the bottom: 35.6 -> 0.8 mm @45deg -> 37.2,
 *                                 1.8 mm vertical,
 *                                 2.15 mm @45deg -> 41.5
 *   total foot height 4.75 mm; heights quantise to 7 mm units
 *
 * Every rounded square here shares one corner-arc centre at 17.00 mm
 * (= 41.5/2 - 3.75). Keeping that constant is what makes clearance uniform
 * around the perimeter — see docs/socket-clearance.md for why that matters.
 *
 * A bin is whole cells or half cells (21 mm) on each axis. A half-size bin stands
 * on quarter feet: see binFeet.
 *
 * Runs in the browser and headless in Node (module.exports guard at the bottom).
 */
'use strict';

const SPEC = {
  pitch: 42,
  footH: 4.75,          // total height of the base
  half: 41.5 / 2,       // 20.75 — half-width at the widest point
  r: 3.75,              // corner fillet at the widest point
  centre: 41.5 / 2 - 3.75, // 17.00 — corner-arc centre, constant at every height
  unitH: 7,             // height quantum
  // [z, half-width] — corner radius at each level is always (half - centre)
  prof: [[0, 35.6 / 2], [0.8, 37.2 / 2], [2.6, 37.2 / 2], [4.75, 41.5 / 2]],
};

const BLOAT = 0.05;     // shell overlap; never rely on coincident faces

/* A bin's note as raised letters on its label shelf: which characters print, how they
   fit and the letters as shells all live in text.js. On the page it is spliced in ahead
   of this file, so its functions are already defined there. */
const NOTE_TEXT = typeof module !== 'undefined' ? require('./text.js')
  : { NOTE_SPEC, notePrintable, noteFit, noteShells };

/* Rails for a removable divider: how thick each rib is, and how far it stands proud of
   the wall. 1.2 is two perimeters at a 0.4 nozzle, so a rib prints solid and stiff
   rather than as two skins with a void between them. */
const RAIL_T = 1.2, RAIL_D = 1.2;

/* The thinnest wall the engine will build, whatever it is asked for. A wall of 0 puts
   the cavity's skin exactly on the outer one — the coincident faces this file exists to
   avoid — and came out with 64 open edges and shells inside out; at 0.2 a carved shape
   still left 3. 0.4 is one line from a 0.4 mm nozzle, so nothing thinner prints anyway.
   The page and a shared link both accept walls down to 0, so the floor is kept here,
   where every way of handing the engine a bin passes, and Checks says when it bites. */
const WALL_MIN = 0.4;
const withWall = (c) => Object.assign(c, { wall: isFinite(c.wall) ? Math.max(WALL_MIN, c.wall) : BIN_DEFAULTS.wall });

// Everything buildBin reaches for through G. The bins UI checks itself against this
// at load; keep it in step when a new primitive is used.
const REQUIRED_CORE = ['makePoly', 'triangulateRing', 'extrudePoly', 'clampZ', 'profilePrism',
                       'polyArea2D'];

const BIN_DEFAULTS = {
  u: 1, v: 1,           // footprint in grid cells
  hUnits: 3,            // height in 7 mm units (total, base included)
  wall: 1.2,            // side wall thickness
  floorT: 1.2,          // floor thickness above the top of the base
  divX: 0, divY: 0,     // interior dividers (cuts, not compartments)
  divRemovable: false,  // dividers as loose plates in rails, rather than printed in
  divT: 1.6,            // thickness of a loose divider plate
  divClr: 0.25,         // slot clearance per side, so it slides rather than presses
  solid: false,         // no cavity at all
  arcSegs: 12,          // corner-arc segments; only affects the bin's own smoothness
  shrink: 0,            // extra clearance per side, on top of the spec's 0.25
  lip: true,            // stacking lip on top (only when every edge is full height)
  edges: null,          // {f,b,l,r} wall heights as a fraction; 0 = open, 1 = full
  lipMin: 0.55,         // flat width of the lip's top rim
  cells: null,          // occupied [x,y] offsets; null means the whole u x v rectangle
  scoop: 0,             // radius of the front scoop fillet, 0 = none
  label: 0,             // depth of the label shelf at the back, 0 = none
  labelT: 1.2,          // thickness of the label shelf
  labelMode: 0,         // what the shelf carries: 0 nothing, 1 the note as raised letters
  note: '',             // what goes in the bin, as typed; printed only with labelMode 1
  insert: 0,            // holes across the floor for: an index into INSERTS, 0 = none
  insertDepth: 0,       // how deep those holes are, mm; 0 = worked out from the item
  holeClr: 0,           // added across every one of them, on top of the preset's own room
  magnets: false,       // magnet pockets in the feet
  screws: false,        // M3 screw holes in the feet
  holesEvery: false,    // holes in every cell, rather than the bin's outer corners
  magnetD: 6,           // the magnet the pockets are for: diameter and thickness, mm
  magnetH: 2,
};

/* Scoop and label shelf.
 *
 * Both are ADDED prisms, never cutters. ENGINE.md's rule is that anything which
 * looks like a subtraction here can be built additively instead, which keeps the
 * bins engine free of CSG entirely.
 *
 * The scoop fills the internal corner between the cavity floor and the front wall
 * with a quarter-round, so contents can be swept up and out.
 *
 * The label shelf projects inward from the top of the back wall. Its underside runs
 * at 45 degrees back to the wall so every layer overhangs the one below it by its
 * own height — printable without support.
 */
function scoopPrism(G, hwI, hdI, floorZ, r, segs) {
  const y0 = -hdI, prof = [[y0, floorZ], [y0 + r, floorZ]];
  for (let k = 1; k <= segs; k++) {                 // arc from floor up to the wall
    const a = (k / segs) * Math.PI / 2;
    prof.push([y0 + r - r * Math.sin(a), floorZ + r - r * Math.cos(a)]);
  }
  prof.push([y0 - BLOAT, floorZ + r], [y0 - BLOAT, floorZ - BLOAT], [y0, floorZ - BLOAT]);
  return G.profilePrism(prof, -hwI - BLOAT, hwI + BLOAT, (u, v) => [v, u]);
}
// the shelf with its top at `top`: H, or lower with a note raised on it (noteOnShelf)
function labelPrism(G, hwI, hdI, top, depth, t) {
  const yb = hdI;
  const prof = [
    [yb + BLOAT, top - t - depth], [yb + BLOAT, top], [yb - depth, top],
    [yb - depth, top - t],
  ];
  return G.profilePrism(prof, -hwI - BLOAT, hwI + BLOAT, (u, v) => [v, u]);
}

/* ...which suits a wall of the usual thickness and nothing much thinner. The prisms end
   square, a BLOAT into the side walls, and the bin's outer corner is an arc of SPEC.r:
   a wall under about 1.15 mm leaves those square ends standing out through the rounded
   corners, 1.06 mm at the 0.4 minimum and 0.21 at 1.0. Such a bin builds the scoop and
   the shelf over the cavity's own rounded outline instead, grown a BLOAT into the wall
   all round, so their ends follow the corners. The usual wall keeps the prisms, and with
   them the same bytes. Dividers and their rails are boxes with the same trouble, and
   are built the same way when they have it (see the dividers in buildBin). */
function cornersPoke(hw, hd, hwI, hdI, n) {
  return outsideArc(hw, hd, hwI + BLOAT, hdI + BLOAT, n);
}

/* Whether a point stands out through the outline's rounded corner, or on it. Measured
   against the outline as built, chords and all: in the direction of the point, the chord
   it faces comes in to SPEC.r * cos(half a segment) at its middle and out to SPEC.r at
   its ends. Held to the chord's middle everywhere, a scoop's corner, which lies exactly
   on a vertex at 45 degrees, counted as out at walls 1.148 to 1.154 that never were. */
function outsideArc(hw, hd, x, y, n) {
  const dx = Math.abs(x) - (hw - SPEC.r), dy = Math.abs(y) - (hd - SPEC.r);
  if (dx <= 0 || dy <= 0) return Math.max(dx, dy) > SPEC.r - 1e-6;
  const seg = Math.PI / (2 * n), a = Math.atan2(dy, dx);
  const mid = (Math.min(n - 1, Math.floor(a / seg)) + 0.5) * seg;
  return Math.hypot(dx, dy) > SPEC.r * Math.cos(seg / 2) / Math.cos(a - mid) - 1e-6;
}

// the part of a convex outline with keep * (p[axis] - v) >= 0, the cut along it set to v
function clipSide(pts, axis, v, keep) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const da = keep * (a[axis] - v), db = keep * (b[axis] - v);
    if (da >= 0) out.push(a);
    if (da * db < 0) {
      const o = 1 - axis;
      const p = [];
      p[o] = a[o] + (b[o] - a[o]) * da / (da - db);
      p[axis] = v;
      out.push(p);
    }
  }
  return out;
}

/* A solid standing over a convex outline in plan, between a bottom and a top that
   depend on y alone and run straight between consecutive `stations`. Cut at the
   stations, every band of it has a flat top and a flat bottom, so it is built as flat
   faces: the outline's sides, and each band's top and bottom fanned from its middle.

   Nothing in it is closer than WELD to anything else. checkManifold, and a slicer, weld
   vertices a micron or so apart, and a scoop's arc runs into the floor at a tangent: a
   0.09 mm scoop on a lowered front had stations 0.0004 mm apart and a top that never
   rose a thousandth above its bottom, and welded, its faces folded onto each other. So
   stations closer than ten times WELD are thinned out, a vertex that close to a station
   is moved onto it, and the bottom stays a little way under the top's lowest point. */
const WELD = 0.002;
function bandSolid(G, ring, ylo, yhi, stations, zTop, zBot) {
  const pts = clipSide(clipSide(ring, 1, ylo, 1), 1, yhi, -1);
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  const cuts = [];
  for (const s of stations.slice().sort((a, b) => a - b))
    if (s > lo + 10 * WELD && s < hi - 10 * WELD && !(s - cuts[cuts.length - 1] < 10 * WELD)) cuts.push(s);
  // a vertex wherever a station crosses the outline, and any vertex near one moved onto it
  const rim = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const near = cuts.find((s) => Math.abs(a[1] - s) < WELD);
    rim.push(near === undefined ? a : [a[0], near]);
    const on = cuts.filter((s) => (s - a[1]) * (s - b[1]) < 0);
    if (b[1] < a[1]) on.reverse();
    for (const s of on) rim.push([a[0] + (b[0] - a[0]) * (s - a[1]) / (b[1] - a[1]), s]);
  }
  const vs = [];
  for (const p of rim) {
    const q = vs[vs.length - 1];
    if (!q || Math.hypot(p[0] - q.x, p[1] - q.y) >= WELD)
      vs.push({ x: p[0], y: p[1], t: zTop(p[1]), b: zBot(p[1]) });
  }
  while (vs.length > 1 && Math.hypot(vs[0].x - vs[vs.length - 1].x, vs[0].y - vs[vs.length - 1].y) < WELD)
    vs.pop();
  const polys = [];
  const add = (verts) => { const p = G.makePoly(verts); if (p) polys.push(p); };
  for (let i = 0; i < vs.length; i++) {             // sides, outwards: the outline is CCW
    const a = vs[i], b = vs[(i + 1) % vs.length];
    add([[a.x, a.y, a.b], [b.x, b.y, b.b], [b.x, b.y, b.t], [a.x, a.y, a.t]]);
  }
  /* Each band takes the outline's edges that lie in it. An edge along a station belongs
     to the band the outline's inside is on: above it when the edge runs +x, as it does
     anticlockwise along the bottom. */
  const edges = [lo].concat(cuts, [hi]);
  for (let k = 0; k + 1 < edges.length; k++) {
    const y0 = edges[k], y1 = edges[k + 1];
    const mine = vs.map((a, i) => {
      const b = vs[(i + 1) % vs.length], m = (a.y + b.y) / 2;
      if (a.y === b.y && (a.y === y0 || a.y === y1)) return a.y === (b.x > a.x ? y0 : y1);
      return m > y0 && m < y1;
    });
    const band = vs.filter((v, i) => mine[i] || mine[(i - 1 + vs.length) % vs.length]);
    const cx = band.reduce((s, v) => s + v.x, 0) / band.length;
    const cy = band.reduce((s, v) => s + v.y, 0) / band.length;
    for (let i = 0; i < band.length; i++) {
      const a = band[i], b = band[(i + 1) % band.length];
      add([[cx, cy, zTop(cy)], [a.x, a.y, a.t], [b.x, b.y, b.t]]);
      add([[cx, cy, zBot(cy)], [b.x, b.y, b.b], [a.x, a.y, a.b]]);
    }
  }
  return polys;
}

// straight between the points of a profile [[y, z], ...] sorted by y, flat beyond it
function piecewise(prof) {
  return (y) => {
    if (y <= prof[0][0]) return prof[0][1];
    for (let k = 1; k < prof.length; k++)
      if (y <= prof[k][0]) {
        const [y0, z0] = prof[k - 1], [y1, z1] = prof[k];
        return y === y1 ? z1 : z0 + (z1 - z0) * (y - y0) / (y1 - y0);
      }
    return prof[prof.length - 1][1];
  };
}

// the cavity's outline grown a BLOAT into the wall, without the straights' split points
function cavityRing(hwI, hdI, wall, n, grow = BLOAT) {
  return roundRect(hwI + grow, hdI + grow, Math.max(0.4, SPEC.r - wall) + grow, n,
                   [[], [], [], []]);
}
function scoopRounded(G, hwI, hdI, wall, floorZ, r, segs, n) {
  const y0 = -hdI, prof = [];
  for (let k = segs; k >= 0; k--) {                 // the same arc, from the wall down
    const a = (k / segs) * Math.PI / 2;
    prof.push([y0 + r - r * Math.sin(a), floorZ + r - r * Math.cos(a)]);
  }
  return bandSolid(G, cavityRing(hwI, hdI, wall, n), -Infinity, y0 + r,
                   prof.map(([y]) => y), piecewise(prof), () => floorZ - BLOAT / 2);
}
function labelRounded(G, hwI, hdI, wall, H, depth, t, n) {
  const yb = hdI;
  return bandSolid(G, cavityRing(hwI, hdI, wall, n), yb - depth, Infinity, [],
                   () => H, piecewise([[yb - depth, H - t], [yb + BLOAT, H - t - depth]]));
}

/* The note raised on the label shelf (labelMode 1).
 *
 * A bin stacked on this one comes down into its lip until the chamfers of its feet meet
 * the lip's, 0.25 mm below H (the spec's clearance, on 45 degree faces: stack-check.js),
 * unless something stops it first, and a shelf with its top at H does. Letters standing
 * on a shelf there would hold that bin up and be crushed by it. So with letters on it
 * the shelf drops to H - 1.0, and they stand 0.6 on it and top out at H - 0.4: 0.15 mm
 * under the feet of a bin seated above. Without letters nothing moves: every other bin
 * is built exactly as it was.
 *
 * The letters go where they can be read from above. At the back and the sides that is
 * clear of the stacking lip, whose chamfer leans in over the shelf to 2.70 from the
 * outside at H: the band stops there, which at the letters' top, 0.4 lower, is 0.4 clear
 * of the chamfer too. At the front they keep 0.6 off the shelf's edge.
 *
 * Dividers stand from the floor to H, through the shelf and anything on it (buildBin), so
 * the letters keep 0.4 off each one that crosses the band: a fixed divider is a wall
 * thick, and a removable one has a rail each side of the slot its plate slides down,
 * which is where the plate goes too. They go in the widest space left across the shelf
 * and, where dividers the other way cross it, the deepest from front to back. A space
 * that will not take the note at the usual sizes (noteFit's readable) takes nothing. The
 * walls alone leave one that narrow only on a half-size bin with walls past about 6.5 mm,
 * where letters came out half a millimetre tall. noteFit lets letters under 3 mm stand
 * where the depth it is given is the shelf's, and a space cut short by dividers along the
 * bin is not: there they came out a millimetre tall, or under nothing and mirrored, and a
 * space like that takes letters only 3 mm tall or more.
 *
 * `footAt` is how low the shelf's slope may reach, which buildBin works out. Returns what
 * goes on the shelf: { why } with why 'off' when no note was asked for, 'empty' when
 * nothing in it prints, 'shallow' when the lowered shelf is under 6 mm deep (with its
 * depth, and `by`: 'asked' for a shelf asked for that shallow, 'inside' for one held to
 * 0.8 of the inside's depth, 'height' for one held to the room above the floor),
 * 'dividers' when the dividers leave no space the note fits (with `along` when it is
 * the ones along the bin: the shelf's whole depth would take it) and 'narrow' when the
 * walls do (both with its depth); otherwise { why: '', top, depth, text, fit, divided }, `fit`
 * being noteFit's answer and `divided` whether dividers narrowed the space it was fitted
 * to. */
const NOTE_CLEAR = 0.4;      // letters stop this far under H
const NOTE_DIV_CLEAR = 0.4;  // ...and this far off a divider, its rails or its plate's slot
function noteOnShelf(c, iw, id, H, footAt) {
  if (+c.labelMode !== 1) return { why: 'off' };
  const text = NOTE_TEXT.notePrintable(c.note).text;
  if (!text) return { why: 'empty' };
  const S = NOTE_TEXT.NOTE_SPEC, top = H - NOTE_CLEAR - S.relief;
  const inside = id * 0.8, room = top - c.labelT - footAt;
  const depth = Math.min(c.label, inside, room);
  if (!(depth >= S.shelfMin))
    return { why: 'shallow', depth: Math.max(0, depth),
             by: depth === c.label ? 'asked' : depth === inside ? 'inside' : 'height' };
  const m = Math.max(0.5, LIP[0][1] - c.wall);
  /* The widest stretch of lo..hi clear of n dividers spread across -inner..inner as
     buildBin spreads them, `half` either side of each centre line, the first of equals;
     null when nothing is left. `divided` says whether any of them crossed it. */
  const half = (c.divRemovable ? c.divT / 2 + c.divClr + RAIL_T : c.wall / 2) + NOTE_DIV_CLEAR;
  let divided = false;
  const widest = (lo, hi, n, inner) => {
    let gaps = [[lo, hi]];
    for (let k = 1; k <= n; k++) {
      const p = -inner + (2 * inner) * k / (n + 1), a = p - half, b = p + half;
      if (b <= lo || a >= hi) continue;
      divided = true;
      gaps = gaps.flatMap(([u, v]) => [[u, Math.min(v, a)], [Math.max(u, b), v]])
        .filter(([u, v]) => v - u > 1e-9);
    }
    return gaps.reduce((w, g) => (!w || g[1] - g[0] > w[1] - w[0] + 1e-9 ? g : w), null);
  };
  const y0 = id - depth + S.front, y1 = id - m;
  // the dividers as built: removable ones no more than fit (dividersBuilt)
  const built = dividersBuilt(c);
  const xs = widest(-iw + m, iw - m, built.divX, iw), across = divided, ys = widest(y0, y1, built.divY, id);
  const fitIn = (x, y) => NOTE_TEXT.noteFit(text, { x0: x[0], x1: x[1], y0: y[0], y1: y[1] });
  const prints = (f) => f.readable && f.cap > 0;
  /* Nothing printed, and why: the dividers along the bin only when the shelf's whole
     depth, between the same dividers across, would have taken the note. Said whenever
     they cut the shelf short, it sent people to take out dividers that were not in the
     way: a 1 x 0.5 with one divider each way had no room between the ones across. */
  const refuse = (cut) => (cut && xs && prints(fitIn(xs, [y0, y1]))
    ? { why: 'dividers', depth, along: true } : { why: across ? 'dividers' : 'narrow', depth });
  if (!xs || !ys) return refuse(!ys);
  const fit = fitIn(xs, ys), cut = ys[1] - ys[0] < y1 - y0 - 1e-9;
  if (!prints(fit) || (cut && fit.cap < S.capMin - 1e-9)) return refuse(cut);
  return { why: '', top, depth, text, fit, divided };
}

/* The scoop as buildBin builds it, for a rectangle with a cavity and no holes across its
   floor (those leave the scoop off): its radius, or 0 for none, one sum which buildBin
   builds it by and binVolume weighs it by. `id` is the cavity's half depth, and floorZ
   its floor. The label shelf's is floorPlan's, for both, as the holes need it.
   There is no scoop where the front is open: it fills the corner between the floor and
   the front wall, and an open front has no corner to fill. No taller than the front wall
   it fills the corner of, either. With the front lowered, a scoop held only to the full
   height stood above the wall, and above the height binTop quotes: a 2x1x4 with every
   wall at a quarter and an 8.5 mm scoop was 14.45 mm built and 11.5 quoted, to its
   README and the bed check. */
function scoopBuilt(c, id, H, floorZ) {
  const eF = c.edges && c.edges.f !== undefined ? c.edges.f : 1;
  if (!(c.scoop > 0.05 && eF > 0)) return 0;
  const r = Math.min(c.scoop, id * 0.9, (H - floorZ) * 0.9 * Math.min(1, eF));
  return r > 0.05 ? r : 0;
}

/* Stacking lip.
 *
 * The lip's inner surface is a baseplate socket: a bin stacks on a bin exactly as
 * a bin sits on a baseplate, which is what makes it interoperable. Insets from the
 * bin's outer outline, at the same corner-arc centre so clearance stays uniform:
 *   floor  2.70  (= 20.75 - 18.05, i.e. the spec foot's 17.80 plus 0.25 clearance)
 *   +0.8   1.90  after the foot's bottom chamfer
 *   +2.6   1.90  after the foot's vertical section
 *   top    lipMin
 *
 * Spec says the lip adds 4.4 mm. A true 4.4 mm lip tapers to a ~0.1 mm knife edge,
 * so like every other generator we stop it early to leave a printable rim; that
 * costs (lipMin - 0.1) mm of height and sits inside the spec's 0.5 mm tolerance.
 * It does not affect stacking, which is governed by the inner transition only.
 */
const LIP = [[0, 2.70], [0.8, 1.90], [2.6, 1.90]];
const lipHeight = (lipMin) => 2.6 + (1.90 - lipMin);   // 3.95 at the default

/* The top of the cavity floor. Never less than two BLOAT above the foot, so the slab
   encloses the foot's overlap extension rather than ending exactly on it — ending on
   it leaves 128 boundary edges. Only a floor thinner than 0.1 mm ever hits that clamp.
   A function of its own because the page quotes it: the inside depth shown beside the
   height field is measured from here, and a second copy of this sum in the UI would be
   a number that drifts from the bin the day the floor changes. The floor is the one the
   bin is built with, which screw holes in the feet raise: see builtFloorT. */
const floorTop = (c) => SPEC.footH + Math.max(builtFloorT(c), 2 * BLOAT);
/* A floor that reaches within 0.2 mm of the top leaves no cavity worth the name, so
   buildBin builds that bin as one block, the same as one asked to be solid. */
const builtSolid = (c) => c.solid || floorTop(c) >= c.hUnits * SPEC.unitH - 0.2;
/* The tallest of the four walls, as the share of the height above the floor it stands
   to. A solid block counts as all wall, and so does a carved bin: its walls are built
   cell by cell to the full height, and the edges never reach them. */
const tallestWall = (c) => (c.solid || !isFullRect(c) ? 1 : Math.max(...['f', 'b', 'l', 'r'].map((k) =>
  (!c.edges || c.edges[k] === undefined) ? 1 : Math.max(0, Math.min(1, c.edges[k])))));
/* How tall a bin really stands, lip aside. H stays the stacking pitch whatever the walls
   do, but a bin with every wall lowered stops at the tallest of them, and one with every
   wall open is its floor slab and nothing more: a tray. Dividers are not walls, though:
   a fixed one, or the rails of a removable one, runs from the floor to H whatever the
   walls do, so a bin built with any stands at H: removable ones past the most that fit
   are not built (dividersBuilt). buildBin reports this as the bin's height,
   which is what its README, the plate files and the bed's height check use, and the
   page quotes it beside the height field; one function for all of them, like floorTop,
   so they cannot drift. It is buildBin's figure, not a measurement of the mesh: the
   share is taken from the top of the slab while the wall ring runs from floorZ, so a
   part-height wall stands up to BLOAT under it (0.025 mm at half height). */
const binTop = (c) => {
  /* A bin with holes across its floor builds no dividers (holeLayout), so they cannot
     stand it H tall, and the block the holes are in can stand above walls that are all
     lowered. Asked only of a bin set to have them, so every other bin is answered as it
     always was. */
  const holes = +c.insert > 0 ? insertPlan(c) : null;
  if (holes && holes.n) return Math.max(wallTop(c), holes.top);
  const d = dividersBuilt(c);
  return d.divX > 0 || d.divY > 0 ? c.hUnits * SPEC.unitH : wallTop(c);
};
/* The top of the tallest wall, dividers aside: what holds a part standing in the bin,
   and so what its inside depth is measured to (binHeights). */
const wallTop = (c) => {
  const H = c.hUnits * SPEC.unitH, floorZ = floorTop(c);
  if (builtSolid(c)) return H;
  return floorZ + BLOAT + tallestWall(c) * (H - floorZ - BLOAT);
};

/* A bin's heights as the page quotes them, from the numbers buildBin builds it with
   rather than from constants kept beside them. H is the stacking height, units x 7 —
   the top of the walls, which is where the feet of a bin stacked on this one come to
   rest — and the lip stands above it. The inside depth runs from the floor to the top
   of the walls, because a part standing any taller is in the way of the bin above it,
   or of a lid, or with a wall lowered is no longer held by it. A solid bin has no
   inside, and a bin with a lowered wall has no lip.

   The floor a part stands on is not floorZ itself. buildBin runs the slab a BLOAT past
   it, so the wall ring that starts below floorZ is buried in the slab instead of meeting
   it face to face, and the surface left inside the bin is that BLOAT higher. Measured
   from floorZ, every inside depth was quoted 0.05 mm deeper than the bin is. */
function binHeights(cfg) {
  /* Sized as buildBin sizes it, and a half-size bin's mask dropped as buildBin drops it:
     asked with one, the quote took it for a carved bin, walled full height. */
  const c = halfSized(Object.assign({}, BIN_DEFAULTS, cfg || {}));
  if (isHalfSize(c)) c.cells = null;
  const H = c.hUnits * SPEC.unitH, floorZ = floorTop(c), top = binTop(c);
  const allFull = !c.edges || ['f', 'b', 'l', 'r'].every((k) =>
    c.edges[k] === undefined || c.edges[k] >= 1);
  const lipH = c.lip && allFull && !c.solid ? lipHeight(c.lipMin) : 0;
  /* `top` is H unless a wall is lowered all round. The inside runs up to the tallest
     wall, which is `top` but for a bin with dividers: they stand it H tall whatever its
     walls do, but they are not what holds a part in it, and measured to them half walls
     at 6 units were quoted 36 mm inside where the walls stop 18 mm above the floor. A
     part standing taller than every wall is not in the bin. `hollow` says whether the
     bin has an inside at any height. A solid block never does, and nor does a tray open
     on every side, whose walls stop at its floor whatever its units. */
  return { H, floorZ, top, lipH, hollow: !c.solid && tallestWall(c) > 0,
           inside: builtSolid(c) ? 0 : Math.max(0, wallTop(c) - (floorZ + BLOAT)) };
}
/* The fewest whole units that give at least `depth` mm inside. Rounded up, not to the
   nearest: someone typing the inside depth is sizing a bin for a part, and a bin a
   millimetre short of the part is a bin the part does not fit. Counted up through
   binHeights rather than solved for, so it is that function run backwards whatever the
   bin: a lowered wall adds only its share of each unit to the inside, and a floor that
   reaches the top makes the first units solid. The epsilon keeps an exact fit exact —
   36 mm on a 1.2 mm floor is 6 units, not 7 because a sum came out at 35.99999999999999.
   No units at all, 0, for a bin with no inside at any height; past the tallest bin a
   link carries, the tallest. */
function unitsForInside(depth, cfg) {
  const c = Object.assign({}, BIN_DEFAULTS, cfg || {});
  if (!binHeights(c).hollow) return 0;
  let n = 1;
  while (n < LINK_MAX.hUnits && binHeights(Object.assign(c, { hUnits: n })).inside < depth - 1e-9) n++;
  return n;
}
/* The whole units whose top comes nearest `mm`: an overall height is a target, and the
   nearest bin is the honest answer to it. Halves go up, as Math.round's do. A tray open
   on every side stands the same at any height, so for one it is the units whose
   stacking height comes nearest: they still say how much room it keeps in a stack. */
function unitsForTop(mm, cfg) {
  const c = Object.assign({}, BIN_DEFAULTS, cfg || {});
  let best = 1, off = Infinity, offH = Infinity;
  for (let n = 1; n <= LINK_MAX.hUnits; n++) {
    const h = binHeights(Object.assign(c, { hUnits: n }));
    const d = Math.abs(h.top - mm), dH = Math.abs(h.H - mm);
    if (d < off - 1e-9 || (d < off + 1e-9 && dH <= offH)) { best = n; off = d; offH = dH; }
  }
  return best;
}

/* There is one base: the spec foot, 4.75 mm, under the spec lip. Truncated feet
 * were offered for a while and are gone. They bought 1.70 mm of usable depth, and
 * only in the bins above the first — the bottom one sits on a baseplate and needs a
 * full foot whatever the ones above it do. On a two-layer 10-unit stack that is
 * 59.80 mm against 58.10, under 3%, and it cost a 2.15 mm taper visible as a waist
 * at every joint, a lip that only mated with its own kind, and a base style to
 * choose. Not worth the surface area.
 */

/* ---------- 2D outlines --------------------------------------------------- */

// Straight-run subdivisions. The straights need their own vertices so a wall can
// change height along a side; without them an edge's height would be dictated by
// the corner arcs. Fixed, not a parameter: every ring in a bin must share a vertex
// count so the skins stitch, and one constant is harder to get wrong than a
// threaded argument.
const SSEG = 4;

/* How far a lowered wall takes to climb to the corner post, in millimetres.
 *
 * A fixed distance, not a fraction of the wall. It was a quarter of the wall to begin
 * with, because a quarter is the gap between two straight vertices and the mesh could
 * not express anything shorter — which meant a 3-wide bin got a 29.5 mm ramp for the
 * same 7.5 mm climb a 1x1 did in 8.5, flattening the angle and eating a third of an
 * opening that had no strength problem to solve. 8.5 mm is the 1x1's ramp, and holding
 * it fixed keeps the angle the same whatever the bin's footprint: a wider bin gets the
 * same corner and a longer flat opening, which is the whole point of making it wider.
 *
 * Still capped at a quarter of the wall, so a bin too small to give up 8.5 mm at each
 * end gives up less rather than having its opening closed over.
 *
 * The angle does vary with HEIGHT, because a taller wall has further to climb over the
 * same run — 41 degrees on a 3-unit bin, 60 on a 5. That follows from fixing the
 * distance, and fixing the distance is what was asked for.
 */
const RAMP_RUN = 8.5;
const rampLen = (wallLen) => Math.min(RAMP_RUN, wallLen / 4);

/* Where to put vertices along a straight, as fractions of its length.
 *
 * The uniform SSEG subdivision, plus one at each end where a ramp finishes. Without
 * that second pair the ramp can only end where a vertex already is, which is what
 * pinned it to a quarter of the wall. Deduplicated, so a 1x1 — whose ramp lands exactly
 * on the first uniform vertex — comes out with the same points it always had rather
 * than a zero-length edge beside it. */
function straightSplits(L) {
  const fs = [];
  for (let k = 1; k < SSEG; k++) fs.push(k / SSEG);
  if (L > 1e-6) { const t = rampLen(L) / L; fs.push(t, 1 - t); }
  return fs.filter((t) => t > 1e-6 && t < 1 - 1e-6).sort((a, b) => a - b)
           .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);
}

/* Rounded rectangle centred on origin, CCW, sharing SPEC.centre where possible.
 *
 * `splits` is one fraction list per straight, in the order the straights are emitted:
 * back, left, front, right. Passing the SAME lists to two rings is what keeps them
 * pairing index for index — see wallRing. The outer and inner wall rings shrink both
 * hw and r by the wall thickness, so their straights are the same length and a fraction
 * means the same millimetres on each. */
function roundRect(hw, hd, r, n, splits) {
  r = Math.max(0.2, Math.min(r, Math.min(hw, hd) - 0.01));
  const cs = [[hw - r, hd - r, 0], [-hw + r, hd - r, 90],
              [-hw + r, -hd + r, 180], [hw - r, -hd + r, 270]];
  const arcs = cs.map(([ox, oy, a0]) => {
    const out = [];
    for (let k = 0; k <= n; k++) {
      const a = (a0 + 90 * k / n) * Math.PI / 180;
      out.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
    }
    return out;
  });
  const uniform = [];
  for (let k = 1; k < SSEG; k++) uniform.push(k / SSEG);
  const pts = [];
  for (let c = 0; c < 4; c++) {
    pts.push(...arcs[c]);
    // arc ends are tangent, so the gap to the next arc is exactly the straight edge
    const a = arcs[c][arcs[c].length - 1], b = arcs[(c + 1) % 4][0];
    for (const t of (splits && splits[c]) || uniform)
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return pts;
}

/* The split lists for one bin's wall rings, from the OUTER dimensions. Straights are
   emitted back, left, front, right — so the x-running pair share one list and the
   y-running pair the other. */
function wallSplits(hw, hd, r) {
  const sx = straightSplits(2 * (hw - r)), sy = straightSplits(2 * (hd - r));
  return [sx, sy, sx, sy];
}

/* Which edge each outline vertex belongs to, and how a short one meets a tall one.
 *
 * Straights are classified by position; corner-arc vertices take the taller of their two
 * neighbours, so an open front still leaves the side walls running the full length with
 * a corner post.
 *
 * The lowered edge climbs to meet that post over the first straight segment, instead of
 * stopping dead beside it. It used to step: the last arc vertex stood at full height and
 * the first straight vertex next to it at half, so the top edge fell the better part of
 * a centimetre across a tangent point. That is a square notch at the end of the longest
 * unsupported run of wall on the bin, and it is where one broke — the top of a side wall
 * came away when the bin was picked up. Nearly all of a thin wall's stiffness in bending
 * comes from material at its edge, and the end of that edge is the worst place to put a
 * stress riser.
 *
 * One segment, not a computed 45 degrees. Every ring in a bin shares a vertex count so
 * the skins stitch (see SSEG), so the shortest ramp expressible is the gap between two
 * straight vertices — a quarter of the wall. Asking for less silently gets you a quarter
 * anyway. Buying finer control means raising SSEG for every ring on every bin: measured,
 * SSEG 6 costs 12% more triangles and SSEG 8 costs 25%, and even at 8 a three-wide bin
 * still cannot express a ramp under 14 mm. That is a whole-catalogue cost for something
 * only partial-wall bins would use.
 *
 * So the slope varies with the bin: about 41 degrees across a 1x1, gentler as the wall
 * gets longer. Gentler is stronger, and it costs a quarter of the opening at each end,
 * which is the trade. Nothing here overhangs — the top edge only ever climbs, so every
 * layer lands on the one beneath it.
 *
 * This does not get the stacking lip back. allFull still drops it from all four walls
 * the moment one is lowered, which is a far larger loss of material and all of it from
 * the top edge. That is the other half of this repair, and it is not done. */
function edgeHeights(outline, hw, hd, r, edges, zLow, zHigh) {
  const E = 1e-6;
  const frac = (k) => Math.max(0, Math.min(1, edges && edges[k] !== undefined ? edges[k] : 1));
  /* How high this edge stands `dist` along from a corner whose other wall is taller.
     Never lowers anything: a wall already at or above its neighbour is left alone. */
  const ramp = (self, nbr, dist, wallLen) => {
    const len = rampLen(wallLen);
    if (nbr <= self + 1e-9 || len <= E || dist >= len) return self;
    return self + (nbr - self) * (1 - dist / len);
  };
  return outline.map(([x, y]) => {
    let f;
    if (Math.abs(y) <= hd - r + E) {
      // a left or right wall, running between the front and the back corners
      const self = x > 0 ? frac('r') : frac('l'), L = 2 * (hd - r);
      f = Math.max(self, ramp(self, frac('f'), y + (hd - r), L),
                         ramp(self, frac('b'), (hd - r) - y, L));
    } else if (Math.abs(x) <= hw - r + E) {
      const self = y > 0 ? frac('b') : frac('f'), L = 2 * (hw - r);
      f = Math.max(self, ramp(self, frac('l'), x + (hw - r), L),
                         ramp(self, frac('r'), (hw - r) - x, L));
    } else f = Math.max(x > 0 ? frac('r') : frac('l'), y > 0 ? frac('b') : frac('f'));
    return zLow + f * (zHigh - zLow);
  });
}

// The bin's outer outline at a given foot half-width, for a u x v footprint.
// Extra cells extend the straight sections; the corners keep the spec radius.
function outlineAt(u, v, half, shrink, n, splits) {
  const hw = (u - 1) * SPEC.pitch / 2 + half - shrink;
  const hd = (v - 1) * SPEC.pitch / 2 + half - shrink;
  return roundRect(hw, hd, half - SPEC.centre, n, splits);
}

/* ---------- mesh helpers -------------------------------------------------- */

function sweep(mk, rings, zs) {
  // side faces between consecutive rings, as TRIANGLES — corner-arc faces are
  // conical and a quad across them is non-planar (a confirmed mesh-destroyer).
  const polys = [];
  const n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a0 = [rings[i][j][0], rings[i][j][1], zs[i]];
      const b0 = [rings[i][k][0], rings[i][k][1], zs[i]];
      const a1 = [rings[i + 1][j][0], rings[i + 1][j][1], zs[i + 1]];
      const b1 = [rings[i + 1][k][0], rings[i + 1][k][1], zs[i + 1]];
      let p = mk([a0, b0, b1]); if (p) polys.push(p);
      p = mk([a0, b1, a1]); if (p) polys.push(p);
    }
  return polys;
}

function fanCap(mk, ring, z, up, cx, cy) {
  const polys = [];
  const c = [cx, cy, z];
  const n = ring.length;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    const a = [ring[j][0], ring[j][1], z], b = [ring[k][0], ring[k][1], z];
    const p = mk(up ? [c, a, b] : [c, b, a]);
    if (p) polys.push(p);
  }
  return polys;
}

/* Band between two CCW loops that correspond index-for-index.
 *
 * Every loop in a bin comes from roundRect with the same segment count, so the two
 * rims pair up vertex for vertex and a direct strip is exact. This deliberately
 * avoids triangulateRing's keyhole + ear-clipping path, which bails out SILENTLY on
 * a thin ring: on a 1.2 mm wall it returned 57 of the 128 triangles needed, covering
 * 119.5 of 187.0 mm2 and leaving the rest as holes. That is where the slicer's
 * non-manifold edges were coming from.
 */
function ringStrip(mk, outer, inner, z, up) {
  const polys = [], n = outer.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o0 = [outer[i][0], outer[i][1], z], o1 = [outer[j][0], outer[j][1], z];
    const i0 = [inner[i][0], inner[i][1], z], i1 = [inner[j][0], inner[j][1], z];
    let p = mk(up ? [o0, o1, i1] : [i1, o1, o0]); if (p) polys.push(p);
    p = mk(up ? [o0, i1, i0] : [i0, i1, o0]); if (p) polys.push(p);
  }
  return polys;
}

// Closed annular wall between two CCW loops, from z0 up to a per-vertex top.
// zTop may be a number or an array — an array lets one side stand full height
// while another drops to the floor, which is how an open-fronted bin is made.
function wallRing(G, outer, inner, z0, zTop) {
  const mk = G.makePoly, polys = [];
  const n = outer.length;
  const zt = (i) => (Array.isArray(zTop) ? zTop[i] : zTop);
  for (let i = 0; i < n; i++) {            // outer skin, normals outward
    const j = (i + 1) % n;
    const p = mk([[outer[i][0], outer[i][1], z0], [outer[j][0], outer[j][1], z0],
                  [outer[j][0], outer[j][1], zt(j)], [outer[i][0], outer[i][1], zt(i)]]);
    if (p) polys.push(p);                  // planar: all four lie in one vertical plane
  }
  for (let i = 0; i < n; i++) {            // inner skin, normals into the cavity
    const j = (i + 1) % n;
    const p = mk([[inner[j][0], inner[j][1], z0], [inner[i][0], inner[i][1], z0],
                  [inner[i][0], inner[i][1], zt(i)], [inner[j][0], inner[j][1], zt(j)]]);
    if (p) polys.push(p);
  }
  for (let i = 0; i < n; i++) {            // top ribbon — TRIANGLES: a varying top
    const j = (i + 1) % n;                 // makes the quad non-planar
    const oi = [outer[i][0], outer[i][1], zt(i)], oj = [outer[j][0], outer[j][1], zt(j)];
    const ii = [inner[i][0], inner[i][1], zt(i)], ij = [inner[j][0], inner[j][1], zt(j)];
    let p = mk([oi, oj, ij]); if (p) polys.push(p);
    p = mk([oi, ij, ii]); if (p) polys.push(p);
  }
  polys.push(...ringStrip(mk, outer, inner, z0, false));   // bottom annulus
  return polys;
}

// Closed lip ring: a socket-profiled rim standing on top of the bin walls.
// A separate overlapping shell. How it meets the wall depends on whether the wall
// is thinner than the lip's base or not; see the chamfer below.
function lipRing(G, c, hwO, hdO, H, n) {
  const ring = (t) => roundRect(hwO - t, hdO - t, SPEC.r - t, n);
  const lipH = lipHeight(c.lipMin);
  const steps = LIP.concat([[lipH, c.lipMin]]);
  const inner = steps.map(([, t]) => ring(t));
  const zsI = steps.map(([z]) => H + z);
  /* Chamfer the underside of the lip instead of dropping it straight down.
     The wall is 1.2 mm and the lip base is 2.70, so the lip used to begin with
     1.50 mm of material starting in mid-air over the cavity. Every printed bin
     failed in the same place, just below the internal lip. Running the inner
     surface down to the wall thickness at 45 degrees makes it self-supporting.

     Clamped to the wall height available: a 1-unit bin has only 1.05 mm of wall
     below the lip, so it gets a steeper chamfer rather than one that starts below
     the floor. Steeper still beats a flat overhang. */
  const base = steps[0][1];                         // 2.70, the socket floor's inset
  const room = Math.max(BLOAT, H - (SPEC.footH + c.floorT) - 0.3);
  if (base - c.wall >= BLOAT) {
    inner.unshift(ring(c.wall)); zsI.unshift(H - Math.min(base - c.wall, room));
  } else {
    /* A wall as thick as the lip's base has nothing to chamfer: the lip stands on it.
       But the chamfer above collapsed to zero height there, putting the lip's bottom
       cap on the wall's top face — 256 edges used four times from 2.70 mm, 72 and
       coplanar folds from 3.5. Burying the cap a BLOAT down is not enough on its own:
       at exactly 2.70 the wall's top inner edge IS the lip's base corner (2.70, H),
       so the two shells still share that ring of edges whatever the cap does.

       So the buried part stays strictly inside the wall, a BLOAT in from its inner
       face, and the lip's next ring sits a BLOAT up its own 45 degree chamfer instead
       of on that corner. The cost is a 0.05 mm triangle off the corner where the
       chamfer meets the wall top, in the loose direction, under any nozzle. */
    inner[0] = ring(base - BLOAT); zsI[0] = H + BLOAT;
    inner.unshift(ring(Math.min(c.wall, base) - BLOAT)); zsI.unshift(H - Math.min(1, room));
  }
  const drop = H - zsI[0];

  const outer = ring(0);
  const polys = [];
  // inner skin (socket), normals pointing into the recess
  for (let i = 0; i < inner.length - 1; i++)
    for (let j = 0; j < outer.length; j++) {
      const k = (j + 1) % outer.length;
      const a0 = [inner[i][j][0], inner[i][j][1], zsI[i]];
      const b0 = [inner[i][k][0], inner[i][k][1], zsI[i]];
      const a1 = [inner[i + 1][j][0], inner[i + 1][j][1], zsI[i + 1]];
      const b1 = [inner[i + 1][k][0], inner[i + 1][k][1], zsI[i + 1]];
      let p = G.makePoly([a0, b1, b0]); if (p) polys.push(p);
      p = G.makePoly([a0, a1, b1]); if (p) polys.push(p);
    }
  // outer skin, normals outward
  for (let j = 0; j < outer.length; j++) {
    const k = (j + 1) % outer.length;
    const p = G.makePoly([[outer[j][0], outer[j][1], H - drop], [outer[k][0], outer[k][1], H - drop],
                          [outer[k][0], outer[k][1], H + lipH], [outer[j][0], outer[j][1], H + lipH]]);
    if (p) polys.push(p);
  }
  // caps: bottom (down) and the flat top rim (up) — index-paired strips, not the
  // keyhole triangulator, which silently leaves a thin ring half covered
  /* The bottom cap sits where the chamfer starts, not at H - BLOAT: the inner
     surface now runs down to meet the wall thickness, and a cap at the old height
     would leave the two skins ending at different z with nothing joining them. */
  polys.push(...ringStrip(G.makePoly, outer, inner[0], H - drop, false));
  polys.push(...ringStrip(G.makePoly, outer, inner[inner.length - 1], H + lipH, true));
  return polys;
}

/* ---------- carved footprints ----------------------------------------------
 * A bin may occupy any subset of its u x v bounding box, so L, U, T and notched
 * shapes are possible. The mask is a Set of "x,y" keys.
 *
 * These shapes are built cell by cell rather than by extruding their outline.
 * Extruding a concave outline is what docs/ENGINE.md names as the confirmed
 * mesh-destroyer, and the inset an outline would need for the walls does not
 * correspond to it vertex for vertex — which is precisely the condition ringStrip
 * relies on, and precisely how the non-manifold bins happened. Per-cell boxes that
 * overlap and fuse sidestep both.
 */
const cellKey = (x, y) => x + ',' + y;
const maskOf = (c) => {
  if (!c.cells || !c.cells.length) {
    const all = new Set();
    for (let x = 0; x < c.u; x++) for (let y = 0; y < c.v; y++) all.add(cellKey(x, y));
    return all;
  }
  return new Set(c.cells.map(([x, y]) => cellKey(x, y)));
};
/* No mask is a full rectangle whatever the size. Counting the cells instead sent every
   half-size bin down the carved path: a 1.5 x 1 has two whole cells in its mask and an
   area of 1.5, and the two can never be equal. */
const isFullRect = (c) => !c.cells || !c.cells.length || maskOf(c).size === c.u * c.v;

/* Advisory, not a gate. Both odd carves turn out to build watertight — the per-cell
   builder walls a hole just as readily as an outer edge — so they are reported and
   still made. A severed shape is simply two objects in one file; a hole is a frame,
   which is a legitimate thing to want. */
function maskCheck(mask, u, v) {
  if (!mask.size) return { ok: false, why: 'no cells left' };
  const start = [...mask][0].split(',').map(Number);
  const seen = new Set([cellKey(start[0], start[1])]), queue = [start];
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = cellKey(x + dx, y + dy);
      if (mask.has(k) && !seen.has(k)) { seen.add(k); queue.push([x + dx, y + dy]); }
    }
  }
  if (seen.size !== mask.size) return { ok: false, why: 'the shape is in separate pieces' };
  // flood the empty cells from outside the bounding box; anything unreached is a hole
  const out = new Set(), q2 = [];
  for (let x = -1; x <= u; x++) for (const y of [-1, v]) q2.push([x, y]);
  for (let y = -1; y <= v; y++) for (const x of [-1, u]) q2.push([x, y]);
  for (const [x, y] of q2) out.add(cellKey(x, y));
  while (q2.length) {
    const [x, y] = q2.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = cellKey(nx, ny);
      if (nx < -1 || ny < -1 || nx > u || ny > v) continue;
      if (mask.has(k) || out.has(k)) continue;
      out.add(k); q2.push([nx, ny]);
    }
  }
  let holes = 0;
  for (let x = 0; x < u; x++) for (let y = 0; y < v; y++)
    if (!mask.has(cellKey(x, y)) && !out.has(cellKey(x, y))) holes++;
  if (holes) return { ok: false, why: 'the shape encloses a hole' };
  return { ok: true };
}

/* ---------- half-size bins --------------------------------------------------
 * A bin may be half a cell, 21 mm, longer on either axis: 0.5, 1.5, 2.5 cells and so on.
 * Its body, lip, lid, dividers, scoop and label all come from its outline, and the
 * outline takes any size already (outlineAt). What changes is what it stands on.
 *
 * A half-size bin stands on QUARTER feet, in both axes, whichever axis is the half one:
 * the spec foot on a 21 mm pitch instead of 42. Each is the spec profile 10.5 mm in from
 * every side of a whole foot — 20.5 mm square at the top — with the spec's corner radius
 * at every level, half-width less 17.00, so its outer corner arcs sit on the same centres
 * as a whole foot's. In a standard 42 mm socket a quarter foot fills one corner of it with
 * the clearance a whole foot gets on its two outer sides and its outer corner, so a
 * half-size bin fits any Gridfinity baseplate, and a 21 mm half-grid plate besides, which
 * is the same foot Gridfinity Rebuilt's half grid builds. test/fit-check.js measures it
 * from the spec alone.
 *
 * Quarter feet rather than half feet, 20.5 x 41.5, split only along the half axis. Half
 * feet would be fewer, but a 1.5 x 1 bin on them could sit on a half step one way and
 * not the other. Quarter feet sit on any half step both ways.
 *
 * A whole-size bin keeps its whole feet, and so stays on whole cells. On quarter feet it
 * could sit anywhere too, but then moving it would change its file, and a bin already
 * printed could not follow.
 *
 * A foot only presses on a socket's walls with its outer sides. A bin half a cell across
 * has no outer side on the far half of the socket, so alone in it, it can slide 21 mm
 * across it (fit-check measures it); the bins beside it are what hold it.
 *
 * Not carved, in this version: a mask counts whole cells, so a half-size bin's is ignored
 * here and dropped from a link.
 */
const isWhole = (x) => Math.abs(x - Math.round(x)) < 1e-9;
/* Width and depth to the nearest half cell, never under one half, as the panel reads
   them. Every part starts here, so a size with no place on the grid builds as the half
   it is nearest, body and feet alike: built as asked, 1.25 was a 52 mm body on quarter
   feet 62.5 mm across. A whole size or a half is its own nearest half, so builds as it
   did. Neither the page nor a link hands the engine anything else. */
const toHalf = (n) => (isFinite(n) ? Math.max(0.5, Math.round(n * 2) / 2) : n);
const halfSized = (c) => Object.assign(c, { u: toHalf(c.u), v: toHalf(c.v) });
/* Half-size as it would be built, so 1.2, which builds as 1, is not. A size that is not
   a number is nobody's half: the floor and holes it decides stay whole. */
const isHalfSize = (c) => [c.u, c.v].some((n) => isFinite(n) && !isWhole(toHalf(n)));
const QUARTER_IN = SPEC.pitch / 4;      // 10.5: a quarter foot is a whole one less this per side

/* The feet a bin stands on, as { i, j, x, y, inset }: the cell, or for a half-size bin the
   quarter, it stands under; its centre in the bin's frame; and how far in from a whole
   foot each of its sides is. Whole feet go cell by cell in the order buildBin has always
   built them, so a whole bin comes out byte for byte as it did. Pure, so the page can
   count and weigh feet without building anything. */
function binFeet(cfg) {
  const c = halfSized(Object.assign({}, BIN_DEFAULTS, cfg || {})), out = [];
  if (isHalfSize(c)) {
    const p = SPEC.pitch / 2, nx = Math.round(c.u / 0.5), ny = Math.round(c.v / 0.5);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        out.push({ i, j, x: (i - (nx - 1) / 2) * p, y: (j - (ny - 1) / 2) * p, inset: QUARTER_IN });
    return out;
  }
  const mask = maskOf(c);
  for (let i = 0; i < c.u; i++)
    for (let j = 0; j < c.v; j++)
      if (mask.has(cellKey(i, j)))
        out.push({ i, j, x: (i - (c.u - 1) / 2) * SPEC.pitch, y: (j - (c.v - 1) / 2) * SPEC.pitch,
                   inset: 0 });
  return out;
}

/* Why a bin's feet take no holes whatever it asks for, or '' when they take them.
 *
 * A half-size bin's do not, in this version. A plate's magnet sits 13 mm from its cell's
 * centre, which is 2.5 mm from the centre of the quarter a quarter foot stands in, towards
 * that corner of the socket — so a different way in each of the four quarters. Which
 * quarter a foot lands in is decided by where the bin sits on the half grid: a hole placed
 * to meet the magnet in one position misses it by 5 mm half a cell along. Holes built at
 * fixed sites would be right in some places and wrong in others, and the part cannot know
 * which, and a hole built for the place the bin sits in would mean moving the bin changes
 * its file, which is the reason a whole bin stays on whole cells.
 *
 * The settings are kept, on the bin and in its link, and simply not built: holeSites
 * finds no sites, holePlan nothing to build, and screws raise no floor. The page uses this
 * to say so beside the boxes. */
const feetHolesOff = (c) => (isHalfSize(c)
  ? 'Half-size bins have no magnet or screw holes yet: where a hole would meet a ' +
    'baseplate magnet depends on where the bin sits on the half grid.'
  : '');

/* Carved body: a slab per cell and a wall panel per exposed edge, all overlapping.
   A cell's slab reaches the bin's outer face where an edge is exposed and past the
   cell boundary where it is not, so neighbours fuse.
   `under`, with screws, is where the slab proper starts and what builds the layer below
   that from one cell's outline: see slabLayer in buildBin. */
function carvedBody(G, c, mask, H, floorZ, zTop, lipSteps, under) {
  const polys = [], P = SPEC.pitch, half = SPEC.half;
  const ox = (c.u - 1) * P / 2, oy = (c.v - 1) * P / 2;   // mask cell -> bin coords
  const has = (x, y) => mask.has(cellKey(x, y));
  const wall = c.wall;

  /* An exposed edge is one shell from the floor to the top of its stacking lip.
     The lip was tried as its own shell first and it cost 12 bad edges a shape: its
     base ring landed on the wall's top cap with the same corner coordinates, so
     four faces met on one edge. Carrying the profile up through the same sweep
     removes the interface rather than papering over it — there is nothing left to
     coincide. Widths are insets from the outer face, so the ledge where the 1.2 mm
     wall becomes the 2.70 mm lip base falls out of the profile for free. */
  const wallProfile = (top) => {
    /* The step from wall thickness to lip base gets BLOAT of height rather than
       being exactly horizontal. Both rings share the outer-face vertices, so at
       equal z that quad has zero area, makePoly drops it, and each panel loses two
       triangles — 72 boundary edges across an L. A 0.05 mm rise costs nothing and
       keeps every face real. */
    /* Same 45 degree chamfer under the lip that lipRing gets, for the same reason:
       the lip base is 2.70 against a 1.20 wall, and that 1.50 mm used to start in
       mid-air over the cavity. Clamped to the wall height available. */
    const drop = lipSteps
      ? Math.min(Math.max(BLOAT, lipSteps[0][1] - wall), Math.max(BLOAT, top - floorZ - 0.3))
      : 0;
    const st = [[floorZ - BLOAT, wall], [top - drop, wall]];
    if (lipSteps) for (const [dz, t] of lipSteps) st.push([H + dz, t]);
    return st;
  };
  const sweptPanel = (steps, rect) => {
    const rings = steps.map(([, t]) => rect(t));
    const zs = steps.map(([z]) => z);
    polys.push(...sweep(G.makePoly, rings, zs));
    /* Centroid, not the midpoint of two opposite corners. fanCap radiates from this
       point, so it only closes the ring if the ring is star-shaped about it — true of
       a rectangle either way, but the corner pieces are sectors, and the two-corner
       midpoint fell outside them and produced inverted triangles. */
    const mid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length,
                        r.reduce((t, p) => t + p[1], 0) / r.length];
    const a = mid(rings[0]), b = mid(rings[rings.length - 1]);
    polys.push(...fanCap(G.makePoly, rings[0], zs[0], false, a[0], a[1]));
    polys.push(...fanCap(G.makePoly, rings[rings.length - 1], zs[zs.length - 1], true, b[0], b[1]));
  };

  /* Convex corners follow the spec arc, exactly like a rectangular bin's.
     A carved bin was built from plain rectangles, so every convex corner came out
     square and reached 1.55 mm further than the Gridfinity profile allows — visibly
     sharp beside an uncarved bin, and outside the standard.

     The corner is an annular sector: outer radius CR about the spec arc centre, inner
     radius CR - t so the wall keeps its thickness and the lip keeps its step. It gets
     its own sweep because an annular sector is star-shaped about no point at all, so
     fanCap cannot close it — the outer and inner arcs are index-paired instead, which
     is the same reasoning that made ringStrip necessary for the bins in the first
     place. */
  const NARC = 8;                       // arc segments per 90 degrees of corner
  /* Shells must interpenetrate, never meet on a plane: two faces that touch share
     their edges, and a shared edge is used four times instead of twice. Cutting the
     panels off exactly at the arc's tangent point did precisely that and cost 160
     bad edges. Running them OVER past it costs 5 microns of bulge where the flat
     face crosses the arc, which is four orders of magnitude below a nozzle. */
  const OVER = 4 * BLOAT;
  const CC = SPEC.centre, CR = half - SPEC.centre;
  const arcPts = (ccx, ccy, rad, a0) => {
    const out = [];
    for (let k = 0; k <= NARC; k++) {
      const a = (a0 + 90 * k / NARC) * Math.PI / 180;
      out.push([ccx + rad * Math.cos(a), ccy + rad * Math.sin(a)]);
    }
    return out;
  };
  /* radii(t) -> [rOuter, rInner]. A convex corner puts the material INSIDE the arc,
     so its inner radius shrinks with wall thickness; a concave one puts the material
     outside, so its inner radius grows. Same band, opposite sense. */
  const sweptSector = (steps, ccx, ccy, a0, radii) => {
    const zs = steps.map(([z]) => z);
    /* Name the rings by RADIUS, not by which side of the wall they are. A convex
       corner has the material inside the arc, so its band runs CR down to CR - t; a
       concave one has it outside, so the band runs CR up to CR + t and the two
       arguments arrive the other way round. The loop below traces outer-forward then
       inner-back, which is only counter-clockwise when the first really is the larger
       — so with the concave case the whole fillet came out inside out, one per reflex
       corner, -214 mm3 each. Every carved shape shipped with them, watertight and
       backwards, until an orientation check went looking. */
    const rings = steps.map(([, t]) => {
      const [ra, rb] = radii(t);
      const ro = Math.max(ra, rb), ri = Math.min(ra, rb);
      return { outer: arcPts(ccx, ccy, ro, a0), inner: arcPts(ccx, ccy, ri, a0) };
    });
    const loop = (r) => r.outer.concat(r.inner.slice().reverse());
    polys.push(...sweep(G.makePoly, rings.map(loop), zs));
    // caps: index-paired band between the two arcs, never a fan
    const cap = (r, z, up) => {
      for (let i = 0; i < r.outer.length - 1; i++) {
        const a = [r.outer[i][0], r.outer[i][1], z], b = [r.outer[i + 1][0], r.outer[i + 1][1], z];
        const c2 = [r.inner[i + 1][0], r.inner[i + 1][1], z], d = [r.inner[i][0], r.inner[i][1], z];
        for (const tri of up ? [[a, b, c2], [a, c2, d]] : [[c2, b, a], [d, c2, a]]) {
          const pp = G.makePoly(tri); if (pp) polys.push(pp);
        }
      }
    };
    cap(rings[0], zs[0], false);
    cap(rings[rings.length - 1], zs[zs.length - 1], true);
  };

  for (const key of mask) {
    const [x, y] = key.split(',').map(Number);
    const cx = x * P - ox, cy = y * P - oy;
    const e = { l: !has(x - 1, y), r: !has(x + 1, y), f: !has(x, y - 1), b: !has(x, y + 1) };
    // slab: outer face on exposed sides, over the boundary on shared ones
    const x0 = cx - (e.l ? half : P / 2 + BLOAT), x1 = cx + (e.r ? half : P / 2 + BLOAT);
    const y0 = cy - (e.f ? half : P / 2 + BLOAT), y1 = cy + (e.b ? half : P / 2 + BLOAT);
    // a corner is convex only where two adjacent edges of this cell are both exposed
    const cvx = { fl: e.f && e.l, fr: e.f && e.r, bl: e.b && e.l, br: e.b && e.r };
    const outline = [];
    const push = (pts) => outline.push(...pts);
    if (cvx.fl) push(arcPts(cx - CC, cy - CC, CR, 180)); else outline.push([x0, y0]);
    if (cvx.fr) push(arcPts(cx + CC, cy - CC, CR, 270)); else outline.push([x1, y0]);
    if (cvx.br) push(arcPts(cx + CC, cy + CC, CR, 0));   else outline.push([x1, y1]);
    if (cvx.bl) push(arcPts(cx - CC, cy + CC, CR, 90));  else outline.push([x0, y1]);
    if (under) polys.push(...under.layer(x, y, cx, cy, outline));
    polys.push(...G.extrudePoly(outline, under ? under.from : SPEC.footH - BLOAT, floorZ + BLOAT));
    if (zTop <= floorZ + 0.01) continue;
    /* Panels stop at the arc's tangent point where a convex corner takes over, and
       otherwise run long so they meet at the boundary. Running them full length past
       a rounded corner is what left the square corner sticking out. */
    const L = x0 - BLOAT, R = x1 + BLOAT, F = y0 - BLOAT, Bk = y1 + BLOAT;
    const yF = cvx.fl || cvx.fr ? cy - CC : null, yB = cvx.bl || cvx.br ? cy + CC : null;
    const steps = wallProfile(zTop);
    if (e.l) sweptPanel(steps, (t) => {
      const a = cvx.fl ? cy - CC - OVER : F, b = cvx.bl ? cy + CC + OVER : Bk;
      return [[x0, a], [x0 + t, a], [x0 + t, b], [x0, b]];
    });
    if (e.r) sweptPanel(steps, (t) => {
      const a = cvx.fr ? cy - CC - OVER : F, b = cvx.br ? cy + CC + OVER : Bk;
      return [[x1 - t, a], [x1, a], [x1, b], [x1 - t, b]];
    });
    if (e.f) sweptPanel(steps, (t) => {
      const a = cvx.fl ? cx - CC - OVER : L, b = cvx.fr ? cx + CC + OVER : R;
      return [[a, y0], [b, y0], [b, y0 + t], [a, y0 + t]];
    });
    if (e.b) sweptPanel(steps, (t) => {
      const a = cvx.bl ? cx - CC - OVER : L, b = cvx.br ? cx + CC + OVER : R;
      return [[a, y1 - t], [b, y1 - t], [b, y1], [a, y1]];
    });
    // clamped, so a wall thicker than the corner radius cannot fold the arc inside out
    const cvxR = (t) => [CR, Math.max(0.2, CR - t)];
    if (cvx.fl) sweptSector(steps, cx - CC, cy - CC, 180, cvxR);
    if (cvx.fr) sweptSector(steps, cx + CC, cy - CC, 270, cvxR);
    if (cvx.br) sweptSector(steps, cx + CC, cy + CC, 0, cvxR);
    if (cvx.bl) sweptSector(steps, cx - CC, cy + CC, 90, cvxR);
  }

  /* Reflex corners.
   *
   * Every exposed face sits at `half` (20.75) from its cell centre while the cell
   * boundary is at pitch/2 (21). That 0.25 mm is the clearance between neighbouring
   * bins and is right on an outside edge. At a reflex corner, though, the two faces
   * meeting there are perpendicular and belong to DIFFERENT cells, so both are inset
   * and each panel runs only BLOAT past its own cell. The walls never touched: an L
   * had a 0.25 mm slot at the inside corner and both walls simply stopped, with no
   * corner geometry between them at all.
   *
   * One quarter disc closes it. Centred on the notch corner with a radius equal to
   * the inset, it is tangent to both faces by construction, so the inside surface
   * sweeps from one wall to the other at constant thickness — a pipe bend rather
   * than a mitre — and there is no crease to leave a crack. It rides the same
   * profile as the panels, so the stacking lip carries round the corner instead of
   * stopping short of it.
   */
  /* Reflex corners are built from three overlapping convex pieces rather than one
     wrapping band. The band was the right SHAPE — the containment was correct — but
     it has a reflex vertex at the notch corner, and a single fan cap cannot close a
     ring that is not star-shaped about one point. Three convex pieces each cap
     cleanly, and overlapping shells is what the rest of this file already does.

       sector  the quarter between the notch corner and an arc of radius t, which is
               tangent to both wall faces, so the wall keeps constant thickness round
               the turn and the inside reads as one sweep rather than a mitre
       laps    a short rectangle along each wall, running past the corner far enough
               to overlap real panel material

     The laps must reach INTO the sector, not merely touch it: two shells meeting on
     a plane share edges and stop being two shells. They overlap by OVER, which makes
     the wall 0.02 mm proud at the transition — below a nozzle width, and the price of
     never relying on a coincident face. */
  const lap = (P / 2 - half) + 2 * BLOAT;
  const sector = (fx, fy, dx, dy) => (t) => {
    const base = dx > 0 ? (dy > 0 ? 0 : -Math.PI / 2) : (dy > 0 ? Math.PI / 2 : Math.PI);
    const pts = [[fx, fy]];
    for (let k = 0; k <= NARC; k++) {
      const a = base + (Math.PI / 2) * k / NARC;
      pts.push([fx + t * Math.cos(a), fy + t * Math.sin(a)]);
    }
    return G.polyArea2D(pts) < 0 ? pts.reverse() : pts;
  };
  const box = (ax, ay, bx, by) => {
    const pts = [[ax, ay], [bx, ay], [bx, by], [ax, by]];
    return G.polyArea2D(pts) < 0 ? pts.reverse() : pts;
  };

  /* A grid vertex with exactly one empty cell around it is a reflex corner. Three
     empties is a convex corner, which the panels already cover by overlapping; two
     is a straight run or a pinch point, and neither has a corner to fill. */
  for (let vx = 0; vx <= c.u; vx++)
    for (let vy = 0; vy <= c.v; vy++) {
      const around = [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]];
      if (around.some(([i, j]) => i < 0 || j < 0 || i >= c.u || j >= c.v)) continue;
      const empty = around.filter(([i, j]) => !has(i, j));
      if (empty.length !== 1) continue;
      const [ex, ey] = empty[0];
      const vX = vx * P - ox - P / 2, vY = vy * P - oy - P / 2;
      // into the material, away from the empty cell, on each axis
      const dx = (ex * P - ox) < vX ? 1 : -1;
      const dy = (ey * P - oy) < vY ? 1 : -1;
      /* The notch corner, where the two exposed faces meet. Each face is inset from
         the grid boundary by (pitch/2 - half) TOWARDS the material, so the corner is
         that much inside the vertex — not outside it. Getting this sign backwards put
         the corner 0.5 mm into the notch, which filled the gap but left the bin proud
         exactly where a neighbouring bin sits. */
      const fx = vX + dx * (P / 2 - half);
      const fy = vY + dy * (P / 2 - half);
      const steps = wallProfile(zTop);
      /* Fill the junction first: the two walls arrive from different cells and do not
         otherwise touch. */
      sweptPanel(steps, sector(fx, fy, dx, dy));
      sweptPanel(steps, (t) => box(fx + dx * t, fy + dy * OVER, fx, fy - dy * lap));
      sweptPanel(steps, (t) => box(fx + dx * OVER, fy + dy * t, fx - dx * lap, fy));

      /* Then round the outside of it to the same radius the convex corners use.
         The arc centre sits in the notch, so the fillet ADDS material there — which
         is exactly right, because the bin that goes in the notch has a convex corner
         of the same radius, and the two are complements. Its corner nests into this
         one with the standard clearance instead of facing a square hole. Leaving it
         sharp, which is what happened first, is the only version that does not match
         a neighbouring bin. */
      const ox2 = fx - dx * CR, oy2 = fy - dy * CR;
      const base = dx > 0 ? (dy > 0 ? 0 : 270) : (dy > 0 ? 90 : 180);
      sweptSector(steps, ox2, oy2, base, (t) => [CR, CR + t + OVER]);
    }
  return polys;
}

/* ---------- holes in the feet ------------------------------------------------
 * Magnet pockets, and M3 screw holes, at the spec's positions: 13 mm from each cell
 * centre on both axes, which is where the baseplate puts its own (holeOffset, core.js),
 * so a bin's magnets sit over the plate's.
 *
 * Built without cutting, like everything else in this file. A foot with holes is not a
 * foot with cylinders taken out of it; it is the same foot made of pieces that leave the
 * holes empty, each a closed shell of a kind this file already trusts:
 *
 *   bands    left and right, everything past |x| = b: the foot's own rings clipped by a
 *            vertical line and swept up the spec profile exactly as a plain foot is, so
 *            they carry its cone faces, corner arcs included, triangle for triangle. The
 *            line is inside the 17.00 arc centre, so it always crosses a straight and
 *            every level keeps the same vertex count. Front and back are the same across
 *            |y|, held to |x| <= b + 2 BLOAT so they never share the corner arcs with the
 *            side bands: two shells carrying the same arc triangles is edges used four
 *            times.
 *   cross    two boxes through the middle, between the columns and rows of sites.
 *   columns  one per site, a stack of tubes, each a square outside and the hole inside,
 *            built by wallRing between two loops sampled on the same rays from the
 *            site's centre — so they pair index for index and nothing goes near
 *            earTriangulate's keyhole. A site with no hole is a plain box.
 *
 * Every hole sits wholly inside the narrowest part of the foot, so nothing here comes
 * near a cone, and the outside of a holed foot is a plain foot's to the micron.
 *
 * A screw goes up 6 mm, past the top of the foot at 4.75, so with screws the slab under
 * the floor is split the same way from the top of the foot to the screw's end, and the
 * floor grows to keep a skin over it. Above a magnet the screw hole starts with two
 * bridging layers — a slot across the pocket, then a square across the slot, then the
 * round hole — so each opening is held up by the layer below and the whole stack prints
 * without supports. Each opening also sits inside the one under it, which is what keeps
 * the BLOAT of overlap between two tubes from closing a hole: where two tubes overlap,
 * what is left open is the smaller opening, which is the one above.
 */
const FOOT_HOLES = {
  off: 13,              // site from the cell centre: the spec's, and the plate's holeOffset
  fit: 0.2,             // pocket over the magnet's diameter: a press fit, the plate's rule
  deeper: 0.4,          // pocket over the magnet's thickness: the spec's 2.4 for a 2 mm one
  screwD: 3,            // M3, 6 mm deep: the spec's screw hole
  screwTop: 6,
  layer: 0.2,           // one bridging layer, one print layer
  skin: 0.6,            // floor left over the end of a screw hole: three layers
  /* The magnets the fields take. 7 mm is the widest whose pocket still sits 0.3 mm
     inside a site square that stays clear of the corner arcs (SITE_MAX, below). 4.5 is
     the narrowest whose pocket, across its flats, still leaves the screw's square room
     inside the slot that bridges it. 3.5 thick keeps both bridging layers well inside
     the foot, below where the split slab starts. */
  magnetD: { min: 4.5, max: 7 },
  magnetH: { min: 1, max: 3.5 },
  mSides: 16,           // facets of a magnet pocket and of a screw hole
  sSides: 12,
};
/* How far each site's square may reach: the front and back bands run 2 BLOAT past it,
   and that has to stop a BLOAT short of the corner arcs, which start at 17.00. */
const SITE_MAX = SPEC.centre - FOOT_HOLES.off - 2 * BLOAT;
/* The floor a screw needs: the hole's end plus a skin, above the top of the foot. 1.85,
   rounded, because the sum comes out 1.8499999999999996 and the page quotes it. */
const SCREW_FLOOR = Math.round((FOOT_HOLES.screwTop + FOOT_HOLES.skin - SPEC.footH) * 100) / 100;
/* the floor a bin is really built with: screws raise it, nothing else does, and only
   screws that are built (feetHolesOff) */
const builtFloorT = (c) => (c.screws && !feetHolesOff(c) ? Math.max(c.floorT, SCREW_FLOOR) : c.floorT);
const holeSize = (x, lim, d) => Math.min(lim.max, Math.max(lim.min, isFinite(x) ? x : d));

/* Which corners of which cells get a hole, as [i, j, sx, sy]: the cell, and which of its
   four sites, sx and sy each +1 or -1. "Corners" means the bin's outer corners, which a
   cell owns where neither of its neighbours along that corner's two edges is in the
   bin — so a rectangle gets four however big it is, and a carved L gets the five convex
   corners of its outline. Pure, so the page counts magnets without building anything.
   Of the size as it is built, to the nearest half cell (halfSized), as buildBin asks it:
   asked of a 1.2 x 1 as given, every cell counted two columns, 8 holes where the bin
   built as 1 x 1 has 4. Neither page hands it such a size; a script can. */
function holeSites(cfg) {
  const c = halfSized(Object.assign({}, cfg));
  if ((!c.magnets && !c.screws) || feetHolesOff(c)) return [];
  const mask = maskOf(c), has = (x, y) => mask.has(cellKey(x, y)), out = [];
  for (let i = 0; i < c.u; i++)
    for (let j = 0; j < c.v; j++) {
      if (!has(i, j)) continue;
      for (const sx of [1, -1])
        for (const sy of [1, -1])
          if (c.holesEvery || (!has(i + sx, j) && !has(i, j + sy))) out.push([i, j, sx, sy]);
    }
  return out;
}

/* What one site's column is made of, bottom up, as [z0, z1, hole]; a null hole is solid.
   Each piece runs a BLOAT into the next, and each opening is inside the one below. */
function holePlan(c) {
  if ((!c.magnets && !c.screws) || feetHolesOff(c)) return null;
  const F = FOOT_HOLES, magnets = !!c.magnets, screws = !!c.screws;
  const rM = holeSize(c.magnetD, F.magnetD, 6) / 2 + F.fit / 2;
  const depth = holeSize(c.magnetH, F.magnetH, 2) + F.deeper;
  const rS = F.screwD / 2, L = F.layer, top = SPEC.footH + BLOAT;
  const circle = (r, n) => ({ kind: 'circle', r, n });
  let foot;
  if (!screws) foot = [[0, depth + BLOAT, circle(rM, F.mSides)], [depth, top, null]];
  else if (!magnets) foot = [[0, top, circle(rS, F.sSides)]];
  else {
    /* The slot spans the pocket between its flats, not its corners: the polygon's
       inscribed circle is what the slot's ends have to stay inside. */
    const flat = rM * Math.cos(Math.PI / F.mSides);
    foot = [[0, depth + BLOAT, circle(rM, F.mSides)],
            [depth, depth + L + BLOAT, { kind: 'rect', hx: rS, hy: Math.sqrt(flat * flat - rS * rS) }],
            [depth + L, depth + 2 * L + BLOAT, { kind: 'rect', hx: rS, hy: rS }],
            [depth + 2 * L, top, circle(rS, F.sSides)]];
  }
  return {
    magnets, screws, depth, foot,
    // half a millimetre round the widest hole, as far as the arcs allow
    s: Math.min(SITE_MAX, (magnets ? rM : rS) + 0.5),
    slab: screws ? [[SPEC.footH - BLOAT, F.screwTop + BLOAT, circle(rS, F.sSides)]] : null,
  };
}

/* Clip a convex CCW polygon to the half-plane a*x + b*y <= c. Order is kept, so it stays
   CCW, and points that land on top of each other are dropped: makePoly would turn the
   zero-length edge between them into a missing face. */
function clipHalf(pts, a, b, c) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const fp = a * p[0] + b * p[1] - c, fq = a * q[0] + b * q[1] - c;
    if (fp <= 1e-12) out.push(p);
    if ((fp < -1e-12 && fq > 1e-12) || (fp > 1e-12 && fq < -1e-12)) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
}
/* Points in the middle of a straight run carry no shape, and a slab split per cell keeps
   them at a price: the midpoint of a 2-wide bin's edge lands in both cells' overlap, and
   both pieces then carry the same vertical edge — four uses. */
const dropCollinear = (pts) => pts.filter((p, i, a) => {
  const q = a[(i + a.length - 1) % a.length], r = a[(i + 1) % a.length];
  return Math.abs((p[0] - q[0]) * (r[1] - q[1]) - (p[1] - q[1]) * (r[0] - q[0])) > 1e-9;
});

/* Convex rings, one per level, swept and closed top and bottom. Fans from the centroid,
   which a convex ring is star-shaped about. */
function sweptConvex(mk, rings, zs) {
  const n = rings[0].length, last = rings.length - 1;
  if (rings.some((r) => r.length !== n))
    throw new Error('a holed foot band changed vertex count between levels: ' + rings.map((r) => r.length));
  const mid = (r) => [r.reduce((t, p) => t + p[0], 0) / n, r.reduce((t, p) => t + p[1], 0) / n];
  const a = mid(rings[0]), b = mid(rings[last]);
  return sweep(mk, rings, zs).concat(fanCap(mk, rings[0], zs[0], false, a[0], a[1]),
                                     fanCap(mk, rings[last], zs[last], true, b[0], b[1]));
}

/* The two loops of one tube: the site's square outside, the hole inside, both sampled on
   the same rays from the site's centre. Every corner of either shape gets a ray of its
   own, so both loops are exact and each quad of the strip between them lies between two
   straight edges; a ray every 22.5 degrees besides, so a long side is not one sliver. A
   round hole is its polygon, not the true circle: the ray meets the chord it crosses. */
function tubeLoops(sx, sy, s, hole) {
  const angs = [];
  for (let k = 0; k < 16; k++) angs.push(22.5 * k);          // the square's corners among them
  if (hole.kind === 'circle') for (let k = 0; k < hole.n; k++) angs.push(45 + 360 * k / hole.n);
  else for (const [x, y] of [[1, 1], [-1, 1], [-1, -1], [1, -1]])
    angs.push(Math.atan2(y * hole.hy, x * hole.hx) * 180 / Math.PI);
  const list = angs.map((a) => ((a % 360) + 360) % 360).sort((a, b) => a - b)
    .filter((a, i, arr) => i === 0 || a - arr[i - 1] > 1e-6)
    .filter((a, i, arr) => i < arr.length - 1 || 360 - a + arr[0] > 1e-6);
  const ray = (deg, shape) => {
    const c = Math.cos(deg * Math.PI / 180), d = Math.sin(deg * Math.PI / 180);
    let t;
    if (shape.kind === 'square') t = shape.h / Math.max(Math.abs(c), Math.abs(d));
    else if (shape.kind === 'rect')
      t = Math.min(Math.abs(c) > 1e-12 ? shape.hx / Math.abs(c) : Infinity,
                   Math.abs(d) > 1e-12 ? shape.hy / Math.abs(d) : Infinity);
    else {
      const step = 360 / shape.n;
      const k = Math.floor(((deg - 45 + 3600) % 360) / step);
      const a0 = (45 + k * step) * Math.PI / 180, a1 = (45 + (k + 1) * step) * Math.PI / 180;
      const p0 = [shape.r * Math.cos(a0), shape.r * Math.sin(a0)];
      const ex = shape.r * Math.cos(a1) - p0[0], ey = shape.r * Math.sin(a1) - p0[1];
      t = (p0[0] * ey - p0[1] * ex) / (c * ey - d * ex);
    }
    return [sx + t * c, sy + t * d];
  };
  return { outer: list.map((a) => ray(a, { kind: 'square', h: s })),
           inner: list.map((a) => ray(a, hole)) };
}

/* One cell's worth of material with holes in it, between the convex `rings` at levels
   `zs` (the foot's profile, or two copies of a slab region). `columns` gives each of the
   four sites as { x, y, segs }, segs bottom up as holePlan writes them, spanning the same
   levels. See the block comment above for what each piece is. */
function holedCell(G, rings, zs, cx, cy, s, columns) {
  const polys = [], off = FOOT_HOLES.off, OV = 2 * BLOAT;
  const b = off + s - BLOAT;             // inner edge of the bands
  const a = off - s + BLOAT;             // half-width of the cross
  const z0 = zs[0], z1 = zs[zs.length - 1];
  const band = (clip) => polys.push(...sweptConvex(G.makePoly, rings.map(clip), zs));
  for (const sg of [1, -1]) {
    band((r) => clipHalf(r, -sg, 0, -sg * (cx + sg * b)));
    band((r) => clipHalf(clipHalf(clipHalf(r, 0, -sg, -sg * (cy + sg * b)),
                                  1, 0, cx + b + OV), -1, 0, -(cx - b - OV)));
  }
  const box = (x0, y0, x1, y1, za, zb) =>
    polys.push(...G.extrudePoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], za, zb));
  box(cx - a, cy - b - OV, cx + a, cy + b + OV, z0, z1);
  box(cx - b - OV, cy - a, cx + b + OV, cy + a, z0, z1);
  for (const { x, y, segs } of columns)
    for (const [za, zb, hole] of segs) {
      if (!hole) { box(x - s, y - s, x + s, y + s, za, zb); continue; }
      const { outer, inner } = tubeLoops(x, y, s, hole);
      polys.push(...wallRing(G, outer, inner, za, zb));
    }
  return polys;
}

/* ---------- holes across the floor -----------------------------------------
 * A bin can be built to hold its contents upright, one hole each: batteries, cells, hex
 * bits. The holes are part of the bin, in a block across the cavity floor, rather than a
 * loose insert dropped into a plain bin, which would need a fit of its own and a second
 * print.
 *
 * Built, not cut, like everything else in this file. The block is one TILE per hole: the
 * hole's share of the cavity, out to halfway to each neighbour and a BLOAT past it, and
 * out to the cavity's own outline a BLOAT into the wall, so neighbours overlap and fuse.
 * Every tile is a rectangle clipped by a rounded rectangle, so it is convex and holds its
 * hole's centre. The tile and the hole are sampled on the same rays from that centre, so
 * the two loops pair index for index, and wallRing closes them into one tube, the way a
 * holed foot's columns are (tubeLoops). Nothing reaches earTriangulate, and the floor of
 * every hole is the bin's own floor slab, a BLOAT under the tube's foot.
 *
 * One trap, found in the prototype. The cavity's outline a tile is clipped by carries
 * points on its corner arcs only. roundRect's straight-run points (SSEG) sat in the strip
 * where two tiles overlap, so both tiles had the very same vertex there, and that cost 1
 * to 4 edges used four times a bin. Arc points are never in such a strip: the first line
 * between two tiles is a hole and a web from the wall, and the arcs are under 3.4 mm.
 *
 * One grid across the whole cavity, not one per cell, because the floor is one slab. The
 * holes spread evenly between their margins with webs of at least 1.2 mm. Items go in
 * from above, through the lip, whose base leans in to 2.70 mm from the outside, so with a
 * lip the holes keep a quarter of a millimetre inside that. A label shelf keeps them in
 * front of it: the tiles of the back row run on under the shelf to the wall, so there is
 * no slot behind the holes to lose things in, and the block stops half a millimetre under
 * the shelf's front edge so it never comes through the shelf, or through a note raised
 * on it. Dividers and the scoop are left off a bin with holes, and a carved shape gets
 * none. A half-size bin is a rectangle with one slab like any other, and takes them.
 *
 * A note raised on the shelf is fitted to the bin as it is built (floorPlan): a bin with
 * holes has no dividers, so its note takes the whole shelf, as on a bin that never had
 * any, and the block keeps under the lowered shelf as it does under a plain one.
 */
/* The presets: what goes in, at its largest, and the room its hole gets. The AA and AAA
   sizes are the IEC maxima; the 18650's is a typical maximum, and a protected cell can be
   bigger. The room is half a millimetre across a round hole and 0.3 across a hex's flats,
   from common practice with FDM printers rather than a test print, which is why the page
   has a Hole clearance field that adds to it. `tag` is what a file is named with, `items`
   how the page names them in a sentence and `say` at the start of one. Index 0 is no
   holes; the link stores the index, so new ones go on the end. */
const INSERTS = [
  null,
  { tag: 'aa', items: 'AA batteries', say: 'AA batteries', shape: 'circle', size: 14.5, clr: 0.5, len: 50.5 },
  { tag: 'aaa', items: 'AAA batteries', say: 'AAA batteries', shape: 'circle', size: 10.5, clr: 0.5, len: 44.5 },
  { tag: '18650', items: '18650 cells', say: '18650 cells', shape: 'circle', size: 18.5, clr: 0.5, len: 65.5 },
  { tag: 'hex-bit', items: 'hex bits', say: 'Bits', shape: 'hex', size: 6.35, clr: 0.3, len: 25 },
];
const INSERT_SPEC = {
  web: 1.2,             // the least between two holes: three lines at a 0.4 nozzle
  edge: 0.8,            // the least between a hole and a wall, or the front of a shelf
  lipClear: 0.25,       // and inside the lip's opening, when there is a lip
  sides: 36,            // facets of a round hole
  headroom: 0.5,        // the block stops this far under the rim, or the shelf's front edge
  /* A bin stacked on this one comes down this far under H, where its foot meets the lip
     (stack-check.js measures it), so an item reaching higher is in its way: that is what
     "below the rim" is measured to, for the units it needs and for Checks. */
  seat: 0.25,
  minDepth: 3,          // shallower than this a hole holds nothing upright, so none is built
  autoMin: 5,           // the automatic depth, a third of the item, is never less than this
  depthMin: 1,          // nor a depth someone typed
  clr: { min: -0.3, max: 1 },   // the Hole clearance field's limits, held here as well
};
/* The most holes one bin is built with. Each is a tile of its own, some 200 triangles for
   a round hole, so the count is what the build costs: a link could ask for a 47 x 47 tray
   of AAA holes, 9.6 million triangles, 13 s and 4.2 GB in Node. At the most, a 13 x 13 of
   AAA (1,936) is 730,000 triangles, 1 s and 280 MB, and a 9 x 9 of hex bits (1,927), the
   largest square a 400 mm bed prints, 210,000 and 0.4 s. Past it a bin gets none
   (holeLayout's 'many'), from every way in, and the page says so; the page holds a whole
   layout to the same count (holdHoles in bins/ui.js), as it does raised notes. */
const HOLES_MAX = 2000;
/* A hole of `d` across, at the origin, CCW, with what the layout and the estimate need to
   know of it. Round holes are faceted outside the nominal size, every facet a tangent of
   the circle, so a hole is never tighter than it says. A hex has its flats left and right,
   so `d` across them runs along x. */
function holeShape(kind, d) {
  if (kind === 'hex') {
    const rc = d / Math.sqrt(3), pts = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 2 + k * Math.PI / 3;
      pts.push([rc * Math.cos(a), rc * Math.sin(a)]);
    }
    return { pts, bx: d, by: 2 * rc, area: Math.sqrt(3) / 2 * d * d, perim: 6 * rc };
  }
  const N = INSERT_SPEC.sides, r = d / 2 / Math.cos(Math.PI / N), pts = [];
  for (let k = 0; k < N; k++) pts.push([r * Math.cos(2 * Math.PI * k / N), r * Math.sin(2 * Math.PI * k / N)]);
  return { pts, bx: 2 * r, by: 2 * r, area: N / 2 * r * r * Math.sin(2 * Math.PI / N),
           perim: 2 * N * r * Math.sin(Math.PI / N) };
}
/* How many boxes `b` wide fit along `span` between the margins, with webs of at least
   INSERT_SPEC.web, and where their centres go: the first against one margin and the last
   against the other, evenly between, or one in the middle. */
function spreadHoles(span, b, lo, hi) {
  const W = INSERT_SPEC.web, room = span - lo - hi;
  const n = room < b - 1e-9 ? 0 : Math.floor((room + W) / (b + W) + 1e-9);
  const step = n > 1 ? (room - b) / (n - 1) : 0;
  return Array.from({ length: n }, (_, k) => (n > 1 ? lo + b / 2 + k * step : lo + room / 2));
}
/* The margin from the walls a hole keeps, `side`, measured square to the straight walls,
   grown where that would bring a corner hole nearer than `edge` to the cavity's rounded
   corner, an arc of `rc`. Only a hex in a thin-walled bin without a lip comes that close:
   at a 0.4 mm wall and 0.8 mm from both walls a corner of one is 0.72 mm from the arc. A
   corner hole sits against both margins, so its outline is measured from the arc's centre
   (the farthest point of a straight edge is one of its ends), and only where it is in the
   arc's quarter: elsewhere the straight walls are nearer, and `side` already keeps those. */
function cornerMargin(shape, rc, side, edge) {
  const clear = (m) => {
    const ox = rc - m - shape.bx / 2, oy = rc - m - shape.by / 2;
    let least = Infinity;
    for (const [x, y] of shape.pts) {
      const dx = ox + x, dy = oy + y;
      if (dx > 0 && dy > 0) least = Math.min(least, rc - Math.hypot(dx, dy));
    }
    return least;
  };
  if (clear(side) >= edge - 1e-9) return side;
  let lo = side, hi = side + rc;                   // by then none of it is in the quarter
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (clear(m) >= edge) hi = m; else lo = m; }
  return hi;
}
/* The label shelf as buildBin builds it, { top, depth, raised }, or null for none: the
   shelf sits at H, or with the note raised on it lower (noteOnShelf). The holes need it
   to keep in front of it and under it. */
function shelfFor(c, iw, id, H) {
  const eB = c.edges && c.edges.b !== undefined ? c.edges.b : 1;
  if (!(c.label > 0.05 && eB > 0.99)) return null;
  /* Limited by height as well as depth. The shelf's underside runs down at 45 degrees,
     so a shelf deeper than the bin is tall pokes its foot through the floor and out among
     the feet: 4 open edges from 8 mm on a 1-unit bin. Into the floor is fine, it is solid,
     and overlap is how every shell here meets the next; out of it is not. The slab starts
     a BLOAT below the body, so the foot stops at the top of the feet, a BLOAT above it,
     whatever the floor — which is where a whole-millimetre shelf on whole units bottoms
     out, so none of those moves. Held 0.2 above the floor, it cut shelves that had always
     built cleanly: a 14 mm label on a 1x1x3 came out 13.65.
     With screws the foot stops above the screws' ends instead, for the reason the wall
     ring does: behind a wall over 5 mm thick it reaches in over a hole. */
  const raised = noteOnShelf(c, iw, id, H, shelfFoot(c));
  if (raised.fit) return { top: raised.top, depth: raised.depth, raised };
  const d = Math.min(c.label, id * 0.8, H - c.labelT - shelfFoot(c));
  return d > 0.05 ? { top: H, depth: d, raised: null } : null;
}
// how low the shelf's slope may reach: the top of the feet, or of the screws in them
const shelfFoot = (c) => {
  const feet = holePlan(c);
  return feet && feet.screws ? FOOT_HOLES.screwTop + BLOAT : SPEC.footH + BLOAT;
};
/* The shelf and the holes of a bin, as buildBin builds them: { shelf, holes }, shelfFor's
   and holeLayout's answers. They decide each other. The holes keep in front of the shelf
   and under it, so they need it first; and a bin with holes is built without its
   dividers, which a note raised on the shelf keeps clear of (noteOnShelf), so the shelf
   needs to know whether there are holes. Asked for holes, a bin is worked out without its
   dividers, and if the holes come out built that is the bin. If they do not (too short,
   or none fit), the dividers are built after all and the shelf is worked out with them,
   as on any bin without holes, which is every bin not asked for them. */
function floorPlan(c, iw, id, H) {
  if (!insertOf(c)) return { shelf: shelfFor(c, iw, id, H), holes: { why: 'off' } };
  const bare = c.divX || c.divY ? Object.assign({}, c, { divX: 0, divY: 0 }) : c;
  const shelf = shelfFor(bare, iw, id, H), holes = holeLayout(c, iw, id, H, shelf);
  return holes.n ? { shelf, holes } : { shelf: bare === c ? shelf : shelfFor(c, iw, id, H), holes };
}
/* Where the holes go in a bin settled as buildBin settles it, and how deep they are, or
   why there are none. `why` is 'off' (none asked for), 'carved', 'solid', 'short' (under
   minDepth of room above the floor), 'none' (not one fits) or 'many' (more than
   HOLES_MAX would, `count` of them), and '' when they are built.
   Every answer but 'off' carries the preset `p` and the hole's width `d`; from 'short'
   on, also `floor` (what an item stands on), `room` (the deepest the block may be) and
   `under`, what holds the room down: 'rim', or 'shelf' when the label shelf is lower;
   `units` (the fewest that keep an item clear of a bin stacked on this one, which comes
   down INSERT_SPEC.seat under H), `above` (how far one stands over the rim, H, negative
   when it is under) and `over` (how far into a stacked bin's way: over the rim less the
   seat). 'none' says whether the shelf is what left no room (`byShelf`). Built: `n` holes,
   at `xs` by `ys`, `depth` deep, the block's `top`, and whether the depth was typed
   (`asked`) and cut to the room (`capped`). `shelf` is the label shelf they keep clear
   of, shelfFor's answer, settled as floorPlan settles it. */
function holeLayout(c, iw, id, H, shelf) {
  const p = Number.isInteger(+c.insert) ? INSERTS[+c.insert] || null : null;
  if (!p) return { why: 'off' };
  const S = INSERT_SPEC;
  const extra = Math.min(S.clr.max, Math.max(S.clr.min, isFinite(c.holeClr) ? +c.holeClr : 0));
  const d = p.size + p.clr + extra;
  if (!isFullRect(c)) return { why: 'carved', p, d };
  if (builtSolid(c)) return { why: 'solid', p, d };
  const shape = holeShape(p.shape, d);
  const floor = floorTop(c) + BLOAT;
  const allFull = !c.edges || ['f', 'b', 'l', 'r'].every((k) => c.edges[k] === undefined || c.edges[k] >= 1);
  const side = cornerMargin(shape, Math.max(0.4, SPEC.r - c.wall),
    c.lip && allFull ? Math.max(S.edge, LIP[0][1] - c.wall + S.lipClear) : S.edge, S.edge);
  const back = Math.max(side, shelf ? shelf.depth + S.edge : 0);
  const xs = spreadHoles(2 * iw, shape.bx, side, side).map((x) => x - iw);
  const ys = spreadHoles(2 * id, shape.by, side, back).map((y) => y - id);
  const lid = shelf ? shelf.top - c.labelT : Infinity;
  const top = Math.min(H, lid) - S.headroom;
  const out = { p, d, shape, floor, room: top - floor, under: lid < H ? 'shelf' : 'rim', shelf,
                units: Math.ceil((floor + p.len + S.seat) / SPEC.unitH - 1e-9),
                above: floor + p.len - H, over: floor + p.len - (H - S.seat) };
  if (out.room < S.minDepth) return Object.assign(out, { why: 'short' });
  if (!xs.length || !ys.length)
    return Object.assign(out, { why: 'none', byShelf: !!xs.length && back > side &&
      spreadHoles(2 * id, shape.by, side, side).length > 0 });
  if (xs.length * ys.length > HOLES_MAX) return Object.assign(out, { why: 'many', count: xs.length * ys.length });
  const asked = isFinite(c.insertDepth) && c.insertDepth > 0;
  const want = asked ? Math.max(S.depthMin, +c.insertDepth) : Math.max(S.autoMin, p.len / 3);
  const depth = Math.min(out.room, want);
  return Object.assign(out, { why: '', n: xs.length * ys.length, xs, ys, depth, top: floor + depth,
                              asked, capped: want > out.room + 1e-9 });
}
/* holeLayout for any bin, worked out without building it, for the page: the count, the
   depth and the reasons it quotes, and the volume it weighs. */
function insertPlan(cfg) {
  const c = halfSized(withWall(Object.assign({}, BIN_DEFAULTS, cfg || {})));
  c.floorT = builtFloorT(c);
  if (isHalfSize(c)) c.cells = null;
  const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  return insertOf(c) ? floorPlan(c, hw - c.wall, hd - c.wall, c.hUnits * SPEC.unitH).holes : { why: 'off' };
}
/* Both loops of one tile: the tile's outline and the hole's, sampled on the same rays
   from the hole's centre. A ray goes through every corner of either, so both come out
   exact. Two corners within a milliradian of each other, seen from the centre, share one
   ray, the tile's: on the hole that moves a corner by under a micron, where two rays that
   close would put points closer than checkManifold's thousandth of a millimetre. */
function tileLoops(tile, hole, cx, cy) {
  const TAU = 2 * Math.PI, TOL = 1e-3, angs = [];
  const add = ([x, y]) => {
    let a = Math.atan2(y - cy, x - cx);
    if (a < 0) a += TAU;
    if (!angs.some((b) => { const g = Math.abs(a - b); return Math.min(g, TAU - g) < TOL; })) angs.push(a);
  };
  tile.forEach(add); hole.forEach(add);
  angs.sort((a, b) => a - b);
  // where a ray from the centre leaves a convex loop that holds the centre
  const hit = (poly, a) => {
    const dx = Math.cos(a), dy = Math.sin(a);
    let t = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-14) continue;
      const s = ((p[0] - cx) * ey - (p[1] - cy) * ex) / den;
      const u = ((p[0] - cx) * dy - (p[1] - cy) * dx) / den;
      if (s > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) t = Math.min(t, s);
    }
    if (!isFinite(t)) throw new Error('a hole tile does not hold its own centre');
    return [cx + t * dx, cy + t * dy];
  };
  return { outer: angs.map((a) => hit(tile, a)), inner: angs.map((a) => hit(hole, a)) };
}
/* The block, one tile per hole of a holeLayout, from a BLOAT under the floor slab's top
   to the block's top, added to `polys` one by one: a big tray is hundreds of thousands
   of polygons, past what a spread into push() can pass as arguments (a 7 x 7 tray of AAA
   holes threw).
   Each tile reaches past halfway to its neighbours, and out past the cavity's outline,
   by its own overlap, and neighbours' differ: a BLOAT, or 0.6 of one, in a checkerboard.
   With one overlap for all, the tiles of a row shared their top and bottom lines, so a
   corner of each lay on its neighbour's edge, where the neighbour has a point wherever
   one of its rays lands; one landing within a micron of the corner made the two one
   vertex and left edges open (10 on a 1.5 x 1 with 10 mm walls). The tiles at the walls
   shared the cavity's outline the same way. Now no tile's corner is on another's line:
   the nearest is 0.02 mm off it. */
function holeTiles(G, c, h, iw, id, polys) {
  const rc = Math.max(0.4, SPEC.r - c.wall), BL = [BLOAT, 0.6 * BLOAT];
  // points on the corner arcs only: see the block comment for why not on the straights
  const cav = BL.map((b) => roundRect(iw + b, id + b, rc + b, c.arcSegs || 12, [[], [], [], []]));
  // a tile's span: halfway to the next centre and its overlap past it, the cavity at the ends
  const span = (cs, k, b) => [k ? (cs[k - 1] + cs[k]) / 2 - b : null,
                              k < cs.length - 1 ? (cs[k] + cs[k + 1]) / 2 + b : null];
  h.xs.forEach((cx, i) => h.ys.forEach((cy, j) => {
    const q = (i + j) % 2, b = BL[q];
    let tile = cav[q];
    const [x0, x1] = span(h.xs, i, b), [y0, y1] = span(h.ys, j, b);
    if (x0 !== null) tile = clipHalf(tile, -1, 0, -x0);
    if (x1 !== null) tile = clipHalf(tile, 1, 0, x1);
    if (y0 !== null) tile = clipHalf(tile, 0, -1, -y0);
    if (y1 !== null) tile = clipHalf(tile, 0, 1, y1);
    const { outer, inner } = tileLoops(tile, h.shape.pts.map(([x, y]) => [x + cx, y + cy]), cx, cy);
    for (const p of wallRing(G, outer, inner, h.floor - 2 * BLOAT, h.top)) polys.push(p);
  }));
  return polys;
}

/* ---------- the bin ------------------------------------------------------- */

/* The most removable dividers that fit along one direction of a bin, and which rule
 * stopped there: `axis` is 'x' for divX, the ones standing at a fixed x, and 'y' for divY.
 * `by` is 'slots' when the spacing below set the count, 'corners' when the rounded
 * corners brought it down further.
 *
 * Each is a slot between two rails RAIL_T thick, so neighbours closer together than a
 * slot and a rail put one's rail into the other's slot, where it takes from the plate's
 * clearance. The divider fields count one wall per divider, as fixed ones are, and
 * allowed 31 on a 1x1 at the usual 1.6 mm plate and 0.25 mm clearance: at 11 a plate
 * still went in, with 0.208 mm of clearance where 0.25 was asked for, and at 12 not at
 * all. Held to a slot and a rail apart, every plate keeps the whole clearance asked for,
 * and 10 fit. Exactly that far apart, two neighbours' rails are one rail between
 * their slots, and both plates go in.
 *
 * Even spacing stands the end ones as far from the end walls as from each other, which
 * one alone does not need: with no neighbour, it needs only its slot and, from there to
 * each end wall, room for the rails the other way, should there be any, which reach a
 * rail's depth and the clearance out from the wall (see reach in buildBin), more than
 * its own rail takes. Held only to its slot and a rail either side, the other way's
 * rails stood in its clearance, 0.45 mm into each side of the 1 mm asked on a half-cell
 * bin with a 5 mm wall and a 5 mm plate. With ten times WELD over, their tips stop short
 * of the slot's face rather than flush with it, where in a square bin a rail each way
 * had a corner on one edge, used four times. Asked for a neighbour's spacing as well, a
 * half-cell bin with a 3 mm wall built none at a 5 mm plate and 1 mm clearance, where
 * one fits with room over.
 *
 * The end ones must clear the cavity's rounded corners as well. Spaced so, the plate
 * nearest an end wall stands a slot and a rail from it less half a plate, which with a
 * thin plate and little clearance is inside the corner's radius: 1.8 mm out at 0.8 mm
 * and 0.1, where the corner's radius is up to 3.35. Its plate spans to the clearance
 * from the side walls, so its corner stood up to 0.26 mm into the wall at smoothness 8,
 * and the plate could not go in. Held only to having the plate's corner inside the
 * outline, it went in with next to no clearance at its corner: 0.0014 mm of the 0.1
 * asked, across the plate, on a 2x1 with a 1.2 mm wall and 35 across. So the count
 * comes down until the slot's face on the end wall's side, at the end of the plate's
 * span, is inside the cavity's outline as built, chords and all, or on it: the whole
 * slot is then clear of the corner, and the plate keeps the clearance asked for across
 * it at its corner, as along the rest of the slot (0.134 mm at the 33 that bin is built
 * with). Fewer dividers rather than end plates cut to the corner, because every plate
 * is then the same part, and goes in any slot.
 *
 * And none at all where the clearance at the plate's two ends takes the whole cavity:
 * a 1x0.5 with a 9.5 mm wall and 1 mm clearance listed a plate -0.5 mm long, and at a
 * 10 mm wall and the usual clearance one with no volume.
 */
function railedLimit(cfg, axis) {
  // the size as it is built, to the nearest half cell (halfSized), as buildBin does
  const c = halfSized(withWall(Object.assign({}, BIN_DEFAULTS, cfg)));
  const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink - c.wall;
  const hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink - c.wall;
  const inner = axis === 'x' ? hw : hd;
  const slot = c.divT / 2 + c.divClr, pitch = 2 * slot + RAIL_T;
  let most = Math.max(0, Math.floor(2 * inner / pitch + 1e-9) - 1) || 0, why = '';
  if (!most && inner >= slot + RAIL_D + c.divClr + 10 * WELD - 1e-9) most = 1;
  // its slot and a rail would go in, but not the room for the rails the other way
  else if (!most && inner >= slot + RAIL_T - 1e-9) why = 'lone';
  // none where the clearance at the plate's ends leaves it no length (see dividerPart)
  if ((axis === 'x' ? hd : hw) - c.divClr < WELD) { most = 0; why = 'length'; }
  const slots = most;
  // the cavity's corner as roundRect builds it, and whether a point stands out through it
  const r = Math.max(0.2, Math.min(Math.max(0.4, SPEC.r - c.wall), Math.min(hw, hd) - 0.01));
  const n = c.arcSegs, seg = Math.PI / (2 * n);
  const outside = (x, y) => {
    const dx = Math.abs(x) - (hw - r), dy = Math.abs(y) - (hd - r);
    if (dx <= 0 || dy <= 0) return Math.max(dx, dy) > r + 1e-9;
    const a = Math.atan2(dy, dx), mid = (Math.min(n - 1, Math.floor(a / seg)) + 0.5) * seg;
    return Math.hypot(dx, dy) > r * Math.cos(seg / 2) / Math.cos(a - mid) + 1e-9;
  };
  // the end plate's slot, its face on the end wall's side, at the end of the plate's span
  const endOut = (k) => {
    const face = -inner + (2 * inner) / (k + 1) - slot;
    return axis === 'x' ? outside(face, hd - c.divClr) : outside(hw - c.divClr, face);
  };
  while (most > 0 && endOut(most)) most--;
  return { most, by: why || (most < slots ? 'corners' : 'slots') };
}
const railedMost = (cfg, axis) => railedLimit(cfg, axis).most;
/* The dividers a bin is built with: as many as it asks for, bar removable ones past the
   most that fit. What a bin asks for is left as it is, in the link and everywhere it is
   kept, so a design from before this held them there opens unchanged; the page says in
   Checks that it is built with fewer, and the plates it lists are the ones built.
   And none at all on a carved shape or a solid block, whatever it asks for: buildBin
   builds both without dividers, as it does a bin whose floor fills it (builtSolid). A
   half-size bin is never carved, so its mask is dropped first, as buildBin drops it.
   Counted as asked, a carved L of three cells asking for two across and one along was
   listed with 6 compartments, named bin-2x2x3-2x1div and weighed with three walls across
   it that it does not have, and a solid block asking the same was listed and named the
   same way. */
function dividersBuilt(cfg) {
  const c = Object.assign({}, BIN_DEFAULTS, cfg);
  const shape = halfSized(Object.assign({}, c));
  if (isHalfSize(shape)) shape.cells = null;
  if (!isFullRect(shape) || builtSolid(shape)) return { divX: 0, divY: 0 };
  const n = (key, axis) => Math.min(c[key] || 0, c.divRemovable ? railedMost(c, axis) : Infinity);
  return { divX: n('divX', 'x'), divY: n('divY', 'y') };
}

/* The loose divider plate, for a bin built with removable dividers.
 *
 * Sized from the SAME numbers the rails are built from, so the two cannot drift: the
 * rails leave a gap of divT + 2*divClr and the plate is divT, which is the clearance
 * per side. The bin's own fit coupons exist because a joint whose two halves are
 * derived separately is a joint that eventually stops fitting.
 *
 * `axis` is 'y' for the plate that stands at a fixed x — the one that divides the bin
 * left from right — matching the rails() call in buildBin.
 *
 * A plain slab: no foot, no lip, nothing that has to stack. It prints flat on its side,
 * which is also the orientation that puts its layers across the load rather than along
 * the split.
 */
function dividerPart(G, cfg, axis) {
  const c = halfSized(withWall(Object.assign({}, BIN_DEFAULTS, cfg)));
  const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const iw = hw - c.wall, id = hd - c.wall;
  const H = c.hUnits * SPEC.unitH;
  // the floor the bin is built with, which screw holes raise: the plate stands on it
  const floorZ = SPEC.footH + builtFloorT(c);
  /* Spans wall to wall, less the clearance, so it drops in rather than having to be
     forced. Its height stops short of the rim by the same amount: a plate standing
     proud of the bin would foul anything stacked on top. */
  const span = 2 * (axis === 'y' ? id : iw) - 2 * c.divClr;
  const tall = (H - floorZ) - c.divClr;
  const t = c.divT;
  /* Built LYING DOWN — span x tall on the bed, t thick — because that is how it prints
     and how the plate packer has to place it. It was built standing up first, which
     matched neither: a 1.6 mm wide tower is not a thing anyone prints, and the packer
     rotates about z only, so it could never have been laid flat afterwards. */
  const rect = [[-span / 2, -tall / 2], [span / 2, -tall / 2],
                [span / 2, tall / 2], [-span / 2, tall / 2]];
  return { polys: G.extrudePoly(rect, 0, t),
           meta: { span, tall, t, slot: t + 2 * c.divClr, W: span, D: tall, totalH: t } };
}

/* A lid for a bin: a flat plate with a skirt that seats inside the bin's stacking lip.
 *
 * Measured off four reference lids before writing any of this, and the measurement
 * changed the design. None of them used clips. All three that retain at all use one
 * CONTINUOUS skirt whose outside mirrors the lip's inner funnel — 62.8 mm at the plate
 * tapering to 60.9 mm at its deepest, against the lip's own 2.70 -> 1.90 mm inset. So a
 * lid seats the way a bin foot does, except hollow: a rim rather than a solid foot,
 * which is where the filament saving comes from. The fourth was a bare plate 3 mm
 * undersize that just rests in the lip and retains nothing.
 *
 * Built in PRINT orientation — upside down, plate first. That is how it goes on the bed
 * and it makes the plate the first layer, so the skirt grows off it with no overhang.
 * z = 0 is therefore the TOP of the lid in use, and the skirt descends as z increases.
 *
 * Per side rather than one ring, because a skirt is only wanted where the bin has a lip
 * to grip and sometimes not on a side you want to reach into. Each side is a prism along
 * its straight run; the corner arcs are left bare, which costs nothing — retention comes
 * from the straights, and a segment that tried to follow the arc would be a swept ring
 * again with none of the per-side freedom.
 */
/* Which sides carry a skirt, packed into one number. All four by default — an absent
   or unreadable field means every side, which is the shape someone gets if they tick
   "lid" and change nothing. */
const LID_SIDES = ['f', 'b', 'l', 'r'];
function lidSideBits(sides) {
  if (!sides) return 15;
  return LID_SIDES.reduce((n, k, i) => n | (sides[k] === false ? 0 : 1 << i), 0);
}
function lidSidesFrom(n) {
  const bits = isFinite(n) ? n : 15;
  const out = {};
  LID_SIDES.forEach((k, i) => { out[k] = !!(bits & (1 << i)); });
  return out;
}

/* Holes in the feet, packed into one field: 1 magnet pockets, 2 screw holes, 4 in every
   cell rather than the bin's outer corners. 8, 16, 32 and 64 are spoken for, by finger
   slots in the front, back, left and right walls, so they stay clear here. A link from
   before the field has none, which reads as 0 — no holes, the bin it always built — and
   so does anything that is not a whole number the field could hold. */
const feetBits = (b) => (b.magnets ? 1 : 0) | (b.screws ? 2 : 0) | (b.holesEvery ? 4 : 0);
function feetFrom(n) {
  const bits = Number.isInteger(n) && n >= 0 && n <= 127 ? n : 0;
  return { magnets: !!(bits & 1), screws: !!(bits & 2), holesEvery: !!(bits & 4) };
}

function lidPart(G, cfg) {
  const c = halfSized(Object.assign({}, BIN_DEFAULTS, { lidT: 1.2, lidClr: 0.2, lidSkirt: 3.0,
                                                        lidSides: null }, cfg));
  const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const r = SPEC.half - SPEC.centre;
  const t = c.lidT, skirt = c.lidSkirt;
  const polys = [];

  // the plate, full footprint, lying on the bed
  polys.push(...G.extrudePoly(roundRect(hw, hd, r, c.arcSegs || 12), 0, t));

  /* The skirt's cross-section, as (inset from the outer face, height). It follows the
     lip's own inner steps so the two mate, plus clearance so it drops rather than binds:
     the lip runs 1.90 mm in through its vertical band and 2.70 at its base, and the
     skirt sits inside that. Deliberately stops short of the lip's full 3.95 mm depth —
     the references only use the top ~2 mm of the funnel, and going deeper would foul the
     radius where the lip meets the wall. */
  /* The skirt follows the LIP'S OWN ramp, not a shape of its own.
     First attempt invented a taper — flat for 0.6 mm then ramping over 1.2 — and it
     fouled the lip from 0.3 mm to 1.5 mm down, by as much as 0.40 mm. The lid would have
     jammed near the top and never seated, and nothing about the mesh would have said so:
     it was watertight, the right size, and wrong. The lip narrows from lipMin at the rim
     to 1.90 over the first 1.35 mm; the skirt does the same, plus clearance. */
  const RAMP = lipHeight(c.lipMin) - 2.6;  // 1.35: rim down to the vertical band
  const IN_TOP = c.lipMin + c.lidClr;      // just inside the rim
  const IN_DEEP = 1.90 + c.lidClr;         // against the lip's vertical band
  const wantSide = (k) => !c.lidSides || c.lidSides[k] !== false;

  /* One side's skirt, as a profile swept along the straight run. `along` is the length
     axis; the profile is (distance in from the outer face, z). */
  const side = (k, axis, sign) => {
    if (!wantSide(k)) return;
    const half = axis === 'x' ? hw : hd;          // distance to the outer face
    const run = (axis === 'x' ? hd : hw) - r;     // straight length, arcs excluded
    const face = sign * half;
    const prof = [
      [face - sign * IN_TOP, t - BLOAT],
      [face - sign * IN_DEEP, t + RAMP],
      [face - sign * IN_DEEP, t + skirt],
      [face - sign * (IN_DEEP + 1.0), t + skirt],
      [face - sign * (IN_DEEP + 1.0), t + RAMP],
      [face - sign * (IN_TOP + 1.0), t - BLOAT],
    ];
    const p = sign > 0 ? prof : prof.slice().reverse();
    polys.push(...(axis === 'x'
      ? G.profilePrism(p, -run, run, (u, v) => [u, v])
      : G.profilePrism(p, -run, run, (u, v) => [v, u])));
  };
  side('l', 'x', -1); side('r', 'x', +1);
  side('f', 'y', -1); side('b', 'y', +1);

  /* With every side unticked there is no skirt, so the part is the plate alone and
     stands t tall. Counting the skirt anyway told the plate packer and the download
     list a 1.2 mm plate was 4.2 mm tall. */
  const sides = ['l', 'r', 'f', 'b'].filter(wantSide);
  return { polys, meta: { W: 2 * hw, D: 2 * hd, totalH: sides.length ? t + skirt : t, t,
                          skirt: sides.length ? skirt : 0, sides } };
}

function buildBin(G, cfg) {
  const c = halfSized(withWall(Object.assign({}, BIN_DEFAULTS, cfg || {})));
  // screw holes run up past the foot, and the floor grows to keep them closed
  c.floorT = builtFloorT(c);
  const n = c.arcSegs;
  const H = c.hUnits * SPEC.unitH;
  if (H <= SPEC.footH + 0.5)
    throw new Error(`hUnits ${c.hUnits} gives ${H} mm, which is not taller than the ${SPEC.footH} mm base`);

  // a mask counts whole cells, and a half-size bin is not carved: see binFeet
  const half = isHalfSize(c);
  if (half) c.cells = null;
  const polys = [];
  const mask = maskOf(c), full = isFullRect(c);

  /* Holes in the feet, if any: which sites, and what each site's column is made of. A
     cell with no site holed is built exactly as it always was. */
  const plan = holePlan(c);
  const holed = new Map();                   // cell key -> its holed sites, as [sx, sy]
  for (const [i, j, sx, sy] of plan ? holeSites(c) : []) {
    const k = cellKey(i, j);
    if (!holed.has(k)) holed.set(k, []);
    holed.get(k).push([sx, sy]);
  }
  /* The four sites of a cell, each with the column it gets between za and zb: `segs`
     where it is holed, solid where it is not. */
  const columnsOf = (i, j, cx, cy, segs, za, zb) => {
    const on = holed.get(cellKey(i, j)) || [];
    const out = [];
    for (const sx of [1, -1])
      for (const sy of [1, -1])
        out.push({ x: cx + sx * FOOT_HOLES.off, y: cy + sy * FOOT_HOLES.off,
                   segs: on.some((q) => q[0] === sx && q[1] === sy) ? segs : [[za, zb, null]] });
    return out;
  };
  /* With screws, the slab from the top of the foot to the screw's end, for one cell's
     region of it: a plain prism where the cell has no screw, split round the holes where
     it does. Above it the slab goes on whole, from the end of the screw. */
  const slabFrom = plan && plan.screws ? FOOT_HOLES.screwTop : SPEC.footH - BLOAT;
  const slabLayer = (i, j, cx, cy, region) => {
    const z0 = SPEC.footH - BLOAT, z1 = FOOT_HOLES.screwTop + BLOAT;
    if (!holed.has(cellKey(i, j))) return G.extrudePoly(region, z0, z1);
    return holedCell(G, [region, region], [z0, z1], cx, cy, plan.s,
                     columnsOf(i, j, cx, cy, plan.slab, z0, z1));
  };

  /* feet — one closed shell per foot, overlapping the body above: a whole foot under
     each occupied cell, or a half-size bin's quarter feet. A quarter foot is the same
     sweep on rings `inset` narrower each side, keeping each level's corner radius, so
     its corner arcs keep the 17.00 centres (see binFeet). */
  const prof = SPEC.prof;
  const zs = prof.map((p) => p[0]).concat([SPEC.footH + BLOAT]);
  for (const { i, j, x: cx, y: cy, inset } of binFeet(c)) {
    const rings = prof.map(([, w]) => {
      const h = w - c.shrink;
      return roundRect(h - inset, h - inset, h - SPEC.centre, n).map((p) => [p[0] + cx, p[1] + cy]);
    });
    rings.push(rings[rings.length - 1]);      // BLOAT extension into the body
    if (holed.has(cellKey(i, j))) {
      polys.push(...holedCell(G, rings, zs, cx, cy, plan.s,
                              columnsOf(i, j, cx, cy, plan.foot, 0, zs[zs.length - 1])));
      continue;
    }
    polys.push(...sweep(G.makePoly, rings, zs));
    polys.push(...fanCap(G.makePoly, rings[0], zs[0], false, cx, cy));
    // capped at the height the sweep actually ends at, overlap extension included:
    // capping lower left the shell open at the top with a stray lid inside it
    polys.push(...fanCap(G.makePoly, rings[rings.length - 1], zs[zs.length - 1], true, cx, cy));
  }

  /* body */
  /* One split list, both loops. The ramp needs a vertex where it ends, and the two
     rims only pair index for index if they are cut the same way. */
  const wsp = wallSplits((c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink,
                         (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink, SPEC.r);
  const outer = outlineAt(c.u, c.v, SPEC.half, c.shrink, n, wsp);
  /* The foot reaches full width at 4.75, so that is where the body starts and there
     is no step in the silhouette between them. */
  const bodyBase = SPEC.footH;
  // see floorTop for the clamp, and for why it is not written out here
  const floorZ = floorTop(c);

  /* Whether there is a lip has to be known before the body: a carved bin's wall
     panels carry their own lip, so the decision cannot wait until after. A lip over
     a lowered edge would have nothing under it and nothing could seat on it. */
  const allFull = !c.edges || ['f', 'b', 'l', 'r'].every((k) =>
    c.edges[k] === undefined || c.edges[k] >= 1);
  const hasLip = c.lip && allFull && !c.solid;
  const lipH = hasLip ? lipHeight(c.lipMin) : 0;
  const lipSteps = hasLip ? LIP.concat([[lipH, c.lipMin]]) : null;

  /* With screws, a rectangle's slab is split cell by cell below the screw's end: each
     cell takes its square of the outline, BLOAT past the boundary so neighbours fuse,
     exactly as a carved bin's slab already is. */
  const rectSlabLayer = () => {
    const out = [], P2 = SPEC.pitch / 2 + BLOAT, shape = dropCollinear(outer);
    for (let i = 0; i < c.u; i++)
      for (let j = 0; j < c.v; j++) {
        const cx = (i - (c.u - 1) / 2) * SPEC.pitch, cy = (j - (c.v - 1) / 2) * SPEC.pitch;
        let r = clipHalf(shape, 1, 0, cx + P2);
        r = clipHalf(r, -1, 0, -(cx - P2));
        r = clipHalf(r, 0, 1, cy + P2);
        out.push(...slabLayer(i, j, cx, cy, clipHalf(r, 0, -1, -(cy - P2))));
      }
    return out;
  };

  let holesBuilt = 0;                        // holes across the floor: see holeLayout
  if (!full) {
    /* Carved shapes are built cell by cell. Dividers, scoop and the label shelf still
       assume a rectangle and are left off rather than guessed at. The stacking lip is
       not one of them: it rides on the wall panels, so a carved bin still stacks. */
    const zTop = (c.solid || floorZ >= H - 0.2) ? H : H;
    /* A floor at or past the top is held a quarter of a millimetre under it. The panels
       run from the floor up to the top, so one starting above the top was a wall swept
       downwards — shells inside out and folded back on themselves, and with the floor as
       thick as the bin is tall the cell slabs stood 0.85 mm above the top of the lip —
       and one starting a tenth below it left 40 open edges. A rectangle's body goes
       solid instead, but here the panels are what carry the stacking lip, so they keep
       a sliver of wall to stand on. */
    const carvedFloor = c.solid ? H - 0.01 : Math.min(floorZ, H - 0.25);
    polys.push(...carvedBody(G, c, mask, H, carvedFloor, zTop,
                             c.solid ? null : lipSteps,
                             plan && plan.screws ? { from: slabFrom, layer: slabLayer } : null));
  } else if (builtSolid(c)) {
    if (plan && plan.screws) polys.push(...rectSlabLayer());
    polys.push(...G.extrudePoly(outer, slabFrom, H));
  } else {
    // solid slab from the top of the feet to the cavity floor
    if (plan && plan.screws) polys.push(...rectSlabLayer());
    polys.push(...G.extrudePoly(outer, slabFrom, floorZ + BLOAT));
    // wall ring above it
    const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
    const hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
    const inner = roundRect(hw - c.wall, hd - c.wall,
                            Math.max(0.4, SPEC.r - c.wall), n, wsp);
    // Start the ring below the cavity floor, buried in the slab. An "open" edge
    // then has its top at floorZ and the ring is still a real volume there rather
    // than a zero-height sliver — the degenerate case simply hides inside the slab.
    /* ...but never onto a plane the foot already occupies. Dropping a floor's worth
       below the floor lands exactly on bodyBase for any floor up to 1 mm, which is
       the foot's own top ring; the overlap cap sits a BLOAT above that. Either one
       puts two shells face to face, costing 64 edges used four times apiece, so the
       start is lifted 1.4 BLOAT clear of both. */
    /* With screws it starts above the screws' ends as well. A wall over 6.2 mm thick
       reaches in over a hole, and starting at the usual floor's depth below the floor it
       filled the top of the hole in. */
    const zBase = Math.max(plan && plan.screws ? FOOT_HOLES.screwTop + 1.4 * BLOAT : 0,
                           bodyBase + 1.4 * BLOAT,
                           floorZ - Math.min(1.0, Math.max(0.2, c.floorT)));
    const zTop = edgeHeights(outer, hw, hd, SPEC.r, c.edges, floorZ, H);
    polys.push(...wallRing(G, outer, inner, zBase, zTop));

    /* scoop and label shelf — added shells, and only where there is a wall to
       attach them to (an open front has no corner to fill). The shelf is worked out
       first, because holes across the floor keep in front of it and under it, and a bin
       with holes has no scoop and no dividers: the holes take the floor. Sized by
       floorPlan and scoopBuilt, which binVolume weighs them by. */
    const iw = hw - c.wall, id = hd - c.wall, poke = cornersPoke(hw, hd, iw, id, n);
    const { shelf, holes } = floorPlan(c, iw, id, H);
    const holesOn = !!holes.n;
    const scoopR = holesOn ? 0 : scoopBuilt(c, id, H, floorZ);
    if (scoopR) polys.push(...(poke ? scoopRounded(G, iw, id, c.wall, floorZ, scoopR, Math.max(4, n), n)
                                    : scoopPrism(G, iw, id, floorZ, scoopR, Math.max(4, n))));
    if (shelf) {
      /* How deep and how high is shelfFor's, which the holes keep in front of and under.
         The shelf's top is H, or lower with a note raised on it (noteOnShelf), and on a
         thin wall it is built over the cavity's rounded outline (cornersPoke) whichever
         height it is at. */
      polys.push(...(poke ? labelRounded(G, iw, id, c.wall, shelf.top, shelf.depth, c.labelT, n)
                          : labelPrism(G, iw, id, shelf.top, shelf.depth, c.labelT)));
      if (shelf.raised)
        polys.push(...NOTE_TEXT.noteShells(G, shelf.raised.fit.segs, shelf.raised.top - BLOAT, H - NOTE_CLEAR));
    }

    /* Dividers — separate overlapping shells, never unioned.
     *
     * Two kinds. A fixed divider is one prism straight across the cavity, printed as
     * part of the bin. A REMOVABLE one is not built at all: what is built is two pairs
     * of rails, one pair on each of the facing walls, and the plate that slides down
     * between them is exported as its own part. That way a bin can be re-divided after
     * it is printed instead of being reprinted.
     *
     * Rails rather than a slot cut into the wall, and that is not a stylistic choice:
     * this file builds everything additively because the hand-rolled BSP is fragile
     * near the foot cones (ENGINE.md), and a slot is a subtraction. Two ribs with a gap
     * between them are the same slot made out of added material.
     */
    const t = c.wall / 2;
    const slot = c.divT / 2 + c.divClr;            // inner face of each rail: the slot
    const rail = slot + RAIL_T;                    // outer face of each rail
    /* Where the dividers of one direction cross the cavity, as spans of the axis they
       stand on — a fixed divider is one span, a removable one the two rails either side
       of its slot — merged wherever two meet. Packed as closely as the divider fields
       allow, neighbours did meet: at the most dividers that fit, a wall of 4.15 mm put
       fixed ones exactly side by side and a spacing of 1.2 mm put one rail's face on its
       neighbour's, and two shells face to face cost 24 to 1616 edges used four times. A
       span that runs into the next is one prism, so there is no face between them to
       coincide; at any sensible count nothing meets and nothing changes.
       The label shelf stands in the way of the dividers along the depth as a neighbour
       does, and a fixed one that came to it met it the same way. With its back on the
       shelf's front the two touched face to face under the bin's rim, sharing the top
       edge, used four times: a 1.5x2.5 with a 0.4 mm wall, 84 dividers and a 12 mm shelf;
       a 1x1 with the usual wall, 16 dividers and a 4 mm shelf. So a divider whose back
       comes to the shelf's front, or within a BLOAT of it, runs a BLOAT into the shelf,
       as it would into its neighbour. Under the shelf that is up to two BLOAT more
       divider, the most a merge with a neighbour adds. One whose FRONT lies on the
       shelf's front already runs into the shelf; see box for that one. "On" is to ten
       times WELD, either side, for both. Held to WELD, a face 2 to 5 µm off the shelf's
       front was left as it was: clean as built, but welded at 5 to 10 µm, as a slicer may
       weld, the two shells' corners became one and the edge was shared again. */
    const spans = (n, inner, shelf) => {
      const out = [];
      for (let k = 1; k <= n; k++) {
        const p = -inner + (2 * inner) * k / (n + 1);
        if (c.divRemovable) out.push([p - rail, p - slot], [p + slot, p + rail]);
        else out.push([p - t, p + t]);
      }
      for (const s of out) if (s[1] >= shelf - BLOAT && s[1] < shelf + 10 * WELD) s[1] = shelf + BLOAT;
      out.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [lo, hi] of out) {
        const last = merged[merged.length - 1];
        if (last && lo <= last[1] + BLOAT) last[1] = Math.max(last[1], hi);
        else merged.push([lo, hi]);
      }
      return merged;
    };
    /* Across the cavity for a fixed divider, from wall to wall and BLOAT into each; for a
       removable one, out from each of the two walls the plate slides between, again BLOAT
       into the wall. The far rail used to stop exactly on the wall's inner face, the near
       one BLOAT inside its wall; both now reach in.
       A removable one's rails reach a rail's depth along the plate's end, which stops the
       clearance short of the wall (dividerPart): so the clearance and a rail's depth out
       from the wall. Reaching only a rail's depth, they held each end of the plate a rail's
       depth less the clearance, 0.95 mm at the usual 0.25 and 0.2 mm at 1 mm, where it can
       twist out. Rails that would meet across a cavity that shallow are one rib across it,
       rather than two boxes face to face. */
    const deep = RAIL_D + c.divClr;
    const reach = (inner) => (!c.divRemovable || deep >= inner - BLOAT / 2
      ? [[-inner - BLOAT, inner + BLOAT]]
      : [[-inner - BLOAT, -inner + deep], [inner - deep, inner + BLOAT]]);
    /* A box that would stand out through a rounded corner, as one packed up to a corner
       does (16 pairs of rails across a 1x1 with a 0.4 mm wall: 0.92 mm out; the most
       rails both ways the fields allow, at the usual 1.2: 0.67), is
       the cavity's outline grown a BLOAT into the wall, cut to the box instead: the same
       outline the scoop and shelf follow there, so it meets the wall the same way. A box
       left with almost nothing inside the outline is all wall, and is not built.
       Each direction's boxes take the outline grown a little less than a BLOAT, and by a
       different amount, so that two cut at one corner, or one and the shelf, never share
       a vertical edge at the same outline vertex: 8 edges used four times when they did.
       A fixed divider whose front lies on the label shelf's front is built that way too,
       wherever it stands. Plain, it reached a BLOAT into each wall as the shelf does and
       stopped at the rim as the shelf does, so the two shared their top front edge; cut
       from the outline grown less than a BLOAT, it reaches the walls short of the shelf's
       ends and shares nothing.
       What the cut leaves is thinned as bandSolid thins a band, and for the same reason.
       An outline vertex just inside a line the box was cut along is nearly in line with
       the cut's own edge there, and the cap made a triangle of the three: 0.20 µm across
       on a 1x1 with a 0.8 mm wall and 16 pairs of rails at smoothness 24, where the bin
       had 2.65 µm before boxes were cut. So a vertex within ten times WELD of a line that
       cuts the outline goes, and the vertex the cut put on that line stays. Thinned the
       other way round, by distance to the next vertex alone, a vertex on the line could be
       the one to go, and the side of the box along the line leant over by up to 1.6 µm.
       Only lines that cut count: the box's ends stand a little way past the outline it
       is cut from, and the outline's own corners are as near to those as this. */
    const box = (pts, grow, onShelf) => {
      if (!onShelf && !pts.some(([x, y]) => outsideArc(hw, hd, x, y, n)))
        return G.extrudePoly(pts, floorZ - BLOAT, H);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const lines = [[0, Math.min(...xs)], [0, Math.max(...xs)], [1, Math.min(...ys)], [1, Math.max(...ys)]];
      let cut = cavityRing(iw, id, c.wall, n, grow);
      cut = clipSide(clipSide(cut, 0, lines[0][1], 1), 0, lines[1][1], -1);
      cut = clipSide(clipSide(cut, 1, lines[2][1], 1), 1, lines[3][1], -1);
      const cuts = lines.filter(([ax, v]) => cut.some((p) => p[ax] === v));
      cut = cut.filter((p) => cuts.some(([ax, v]) => p[ax] === v) ||
                              !cuts.some(([ax, v]) => Math.abs(p[ax] - v) < 10 * WELD));
      cut = cut.filter((p, i) => Math.hypot(p[0] - cut[(i + 1) % cut.length][0],
                                            p[1] - cut[(i + 1) % cut.length][1]) >= WELD);
      return cut.length >= 3 && Math.abs(G.polyArea2D(cut)) > 0.01
        ? G.extrudePoly(cut, floorZ - BLOAT, H) : [];
    };
    /* Where the label shelf's front stands, for a fixed divider to meet it: the depth the
       shelf above was built to, floorPlan's, which is the depth noteOnShelf gave it when a
       note is raised on it. That shelf is a millimetre lower, and on a short bin up to a
       millimetre shallower too, so a divider that came to the plain shelf's front would
       stop short of it, or flush with it. Nothing, when there is no shelf. */
    const front = !c.divRemovable && shelf ? id - shelf.depth : NaN;
    /* Removable ones no more than fit, however many are asked for: see railedMost. None
       with holes across the floor: the holes are what divides it. */
    const built = holesOn ? { divX: 0, divY: 0 } : dividersBuilt(c);
    const xs = spans(built.divX, iw), ys = spans(built.divY, id, front);
    /* Removable both ways, the rails of one direction end in the cavity beside those of
       the other. Where the end spacing on both axes is a rail and its reach (half a
       plate, twice the clearance and 2.4 mm), the tip of the end divY rail came to the
       outer face of the end divX rail, at that rail's own tip: two boxes corner to corner
       on one vertical edge, used four times (a 1x1 with a 0.4 mm wall, 10 each way, at
       the usual plate and clearance). Spaced so on one axis, the tip came to the other
       rail's face, and the two touched face to face. So a rail whose tip comes within
       ten times WELD of the face of a rail the other way, where the two meet, runs a
       BLOAT on into that rail, as a divider does into the label shelf. That is the face
       towards the wall the tip comes from, and the rail is a rail thick, so the tip ends
       in it, stands in no slot, and holds its plate no less. Where the two only meet
       corner to corner, or overlap in part, the tip's run-on also adds up to 0.66 mm²
       of footprint in the open cavity beside the other rail, about 0.01 g, outside every
       slot. */
    const runOn = ([a, b], [lo, hi], others, otherReach) => {
      if (c.divRemovable && otherReach.some(([p, q]) => a < q + 10 * WELD && b > p - 10 * WELD))
        for (const [oa, ob] of others) {
          if (Math.abs(hi - oa) < 10 * WELD) hi = oa + BLOAT;
          if (Math.abs(lo - ob) < 10 * WELD) lo = ob - BLOAT;
        }
      return [lo, hi];
    };
    for (const [a, b] of xs)
      for (const r of reach(id)) {
        const [lo, hi] = runOn([a, b], r, ys, reach(iw));
        polys.push(...box([[a, lo], [b, lo], [b, hi], [a, hi]], 0.8 * BLOAT));
      }
    for (const [a, b] of ys)
      for (const r of reach(iw)) {
        const [lo, hi] = runOn([a, b], r, xs, reach(id));
        polys.push(...box([[lo, a], [hi, a], [hi, b], [lo, b]], 0.6 * BLOAT, Math.abs(a - front) < 10 * WELD));
      }

    // the holes, last, so a bin without them is every shell it was, in the order it was
    if (holesOn) { holeTiles(G, c, holes, iw, id, polys); holesBuilt = holes.n; }
  }

  /* A rectangle's lip is still its own swept ring around the rounded outline. */
  const hwO = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const hdO = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  if (hasLip && full) polys.push(...lipRing(G, c, hwO, hdO, H, n));

  // H stays the stacking pitch whatever the walls do; topZ is how tall it really is,
  // which for an all-open tray is just the floor. See binTop, which the page quotes too.
  const topZ = binTop(c);

  const meta = {
    u: c.u, v: c.v, hUnits: c.hUnits, H, hasLip, openEdges: !allFull,
    carved: !full,
    lipH, totalH: topZ + lipH,       // H is the stacking pitch; totalH is what it occupies
    W: (c.u - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    D: (c.v - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    // a half-size bin's mask is whole cells under part of it; its area is the count
    footH: SPEC.footH, floorZ, cells: half ? c.u * c.v : mask.size,
    cavity: Math.max(0, H - floorZ),
    // what goes into the feet once it is printed: a magnet, or a screw, per hole
    magnets: plan && plan.magnets ? holeSites(c).length : 0,
    screws: plan && plan.screws ? holeSites(c).length : 0,
    // and what stands in the holes across its floor, one each
    holes: holesBuilt,
  };
  return { polys: G.clampZ(polys, 0), meta };
}

/* What buildBin puts on a bin's label shelf, worked out without building it, for the page
   to say: noteOnShelf's answer, settled the way buildBin settles a bin. When there is no
   shelf for letters to stand on, why says which of the reasons buildBin has for building
   none: 'carved' (a carved shape gets no shelf), 'solid', 'back' (the back wall is
   lowered) or 'noshelf' (none was asked for). `dropped` is every character of the note
   that cannot print, whatever the shelf. */
function shelfNote(cfg) {
  const c = halfSized(withWall(Object.assign({}, BIN_DEFAULTS, cfg || {})));
  c.floorT = builtFloorT(c);
  if (isHalfSize(c)) c.cells = null;
  const dropped = NOTE_TEXT.notePrintable(c.note).dropped;
  const say = (o) => Object.assign(o, { dropped });
  if (+c.labelMode !== 1) return say({ why: 'off' });
  if (!isFullRect(c)) return say({ why: 'carved' });
  if (builtSolid(c)) return say({ why: 'solid' });
  if (c.edges && c.edges.b !== undefined && !(c.edges.b > 0.99)) return say({ why: 'back' });
  if (!(c.label > 0.05)) return say({ why: 'noshelf' });
  const plan = holePlan(c), H = c.hUnits * SPEC.unitH;
  const iw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink - c.wall;
  const id = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink - c.wall;
  const footAt = plan && plan.screws ? FOOT_HOLES.screwTop + BLOAT : SPEC.footH + BLOAT;
  // a bin built with holes across its floor is built without dividers (floorPlan)
  const holed = insertOf(c) && floorPlan(c, iw, id, H).holes.n;
  return say(noteOnShelf(holed ? Object.assign({}, c, { divX: 0, divY: 0 }) : c, iw, id, H, footAt));
}

/* ---------- what a bin weighs ----------------------------------------------------
 * The plastic in a bin, worked out from the numbers buildBin builds it from, so the page
 * can weigh and time a whole layout without building any of it: binVolume gives
 * { raw, filament, parts } in mm³.
 *
 * `raw` is the plastic the bin is made of: every part buildBin builds, as it sizes it,
 * and nothing it leaves off. The mesh is shells that overlap on purpose (BLOAT, and the
 * wall ring buried up to a millimetre in the floor slab), and where they overlap the
 * plastic is there once, so it is counted once here: the shells' volumes added up come
 * to 2 to 11% more than the plastic on a plain bin, the most on small bins with thick
 * walls, and up to a quarter more with holes in the feet. Where two parts meet
 * — a divider through the scoop or the label shelf, two dividers crossing, a removable
 * divider's rails both ways, the block of holes across the floor under the label shelf,
 * and a divider's ends, its rails and the block where they stand in the lip's chamfer —
 * the plastic they share is counted once as well. On a carved shape every corner is
 * counted as carvedBody builds it.
 *
 * `filament` is what a slicer lays down for it at `infill` (0 to 1). The feet and the
 * floor slab are a thick block that it shells and infills, and so are the scoop and the
 * label shelf, which are as thick as they are deep (a 12 mm shelf is 13 mm thick at the
 * wall), and the block of holes across the floor. The walls, the lip, the dividers and their rails are a few perimeters wide and
 * come out solid. Assumes 2 perimeters (0.8 mm) and 4 solid top and bottom layers
 * (0.8 mm), a common default. A wall past 1.6 mm is infilled too, which this does not
 * model: a 3x2x6 with 5 mm walls weighs 121 g here, and with the middle of its walls at
 * the same 15% it would be about 50 g less; at 3 mm about 20 g, at 2 mm 6 g.
 *
 * Left out, each a few hundredths of a gram on any bin the fields allow:
 *   - the note's raised letters, 0.22 g at the most (a full shelf of the biggest);
 *   - fixed dividers packed into the cavity's rounded corners, which are counted as if
 *     the corners were square there, under 1 mm³ a divider, and where they or rails
 *     stand in the lip's chamfer there, as along a straight wall;
 *   - the corner arcs of a rectangle and of the feet, which are counted as true arcs where
 *     buildBin builds chords: at the coarsest smoothness the outline encloses 0.1% less
 *     (a carved shape's are counted on their chords);
 *   - the block of holes where it stands in the lip's chamfer in a rounded corner, which
 *     is counted along straight walls, and in a half-millimetre strip behind the label
 *     shelf's front, both a few mm³.
 */
const SHELL_T = 0.8, SKIN_T = 0.8;
// a rounded rectangle's area and perimeter, half-widths hw x hd and corner radius r
const areaRR = (hw, hd, r) => 4 * hw * hd - (4 - Math.PI) * r * r;
const perimRR = (hw, hd, r) => 4 * hw + 4 * hd - 8 * r + 2 * Math.PI * r;
// the integral of f from a to b, by Simpson's rule on k pairs of panels: exact for a
// quadratic, which every area here is in the height it is taken at
function simpsonOf(f, a, b, k = 1) {
  if (!(b > a)) return 0;
  const n = 2 * k, h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return s * h / 3;
}
/* ...and by three-point Gauss on k panels, which never asks f at a or b: what stands on
   the floor steps up at the label shelf's front, and the step is where a piece ends. */
function gaussOf(f, a, b, k = 2) {
  if (!(b > a)) return 0;
  const h = (b - a) / k, g = Math.sqrt(3 / 5) / 2;
  let s = 0;
  for (let i = 0; i < k; i++) {
    const m = a + (i + 0.5) * h;
    s += (5 * f(m - g * h) + 8 * f(m) + 5 * f(m + g * h)) / 18;
  }
  return s * h;
}
// intervals [[lo, hi], ...]: merged where they meet or overlap, and their total length
const mergedSpans = (list, gap = 0) => {
  const out = [];
  for (const [lo, hi] of list.slice().sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + gap) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
};
const spansLength = (list) => list.reduce((a, [lo, hi]) => a + Math.max(0, hi - lo), 0);
const spansClip = (list, lo, hi) => list.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => b > a);
const spansMeet = (A, B) => spansLength(A.flatMap(([a, b]) => spansClip(B, a, b)));
const inSpans = (list, x) => list.some(([lo, hi]) => x > lo && x < hi);

/* The plan area of the rails `n` removable dividers stand in along one direction: each a
   slot between two ribs RAIL_T thick, standing out from each of the two facing walls its
   plate slides between, as deep as buildBin's reach() builds them: a rail's depth and the
   clearance, or the whole way across a cavity too shallow for two. `along` is half the
   length of those walls inside the cavity, hwI for the dividers that stand at a fixed x
   (divX), hdI for the others, as buildBin's spans() and reach() take them, and `across`
   half the distance between them. Placed, sorted and merged where two meet exactly as
   spans() does it, so dividers packed close enough for one's rail to run into the next
   count the plastic they share once.
   A rail beside an end wall can stand in the cavity's rounded corner, where buildBin
   either leaves it buried in the wall or, if it would stand out through the bin, cuts it
   to the cavity's outline. Either way the part behind the arc is wall, already counted,
   so only the part in front of it is counted here: the rail's depth left in front of
   the arc, summed along it, against a true arc of the cavity's radius rather than the
   chords it is built from (under a rail 1.2 mm wide the two differ by a few hundredths
   of a square millimetre at the coarsest smoothness). A rail on a straight run is
   counted whole, so at any count that keeps the rails out of the corners the sum is
   exactly the rails' own area. */
function railArea(n, along, across, wall, divT, divClr) {
  if (!(n > 0) || !(along > 0)) return 0;
  const slot = divT / 2 + divClr, rail = slot + RAIL_T;
  const deep = RAIL_D + divClr >= across - BLOAT / 2 ? across : RAIL_D + divClr;
  const spans = [];
  for (let k = 1; k <= n; k++) {
    const p = -along + (2 * along) * k / (n + 1);
    spans.push([p - rail, p - slot], [p + slot, p + rail]);
  }
  const merged = mergedSpans(spans, BLOAT);
  /* t into a corner, the arc stands rI - sqrt(rI² - t²) in front of the wall's straight
     line, and takes the whole of a rail's depth at tEnd (or never quite, where the
     radius is no deeper than the rail). `under` is the depth left in front of it, summed
     from the corner's start to t; `upTo` the same from the middle of the wall to x, both
     ways, so a span's area is upTo(hi) - upTo(lo). Past the end wall it adds nothing. */
  const rI = Math.max(0.4, SPEC.r - wall), straight = Math.max(0, along - rI);
  const tEnd = deep >= rI ? rI : Math.sqrt(rI * rI - (rI - deep) * (rI - deep));
  const under = (t) => {
    t = Math.min(Math.max(t, 0), tEnd);
    return (deep - rI) * t + (t * Math.sqrt(rI * rI - t * t) + rI * rI * Math.asin(t / rI)) / 2;
  };
  const upTo = (x) => Math.sign(x) * (deep * Math.min(Math.abs(x), straight) + under(Math.abs(x) - straight));
  return 2 * merged.reduce((a, [lo, hi]) => a + upTo(hi) - upTo(lo), 0);  // both walls
}

/* What one holed site leaves empty, bottom up through holePlan's pieces, and the area
   of its sides and its roof for the slicer's shells. Each piece runs a BLOAT into the
   next, whose opening is inside its own, so where two overlap the next one's opening is
   what is open; with screws the hole goes on up through the slab to the screw's end. A
   round hole is its polygon, as buildBin builds it. */
function holeVoid(plan) {
  const area = (h) => (h.kind === 'circle' ? h.n / 2 * h.r * h.r * Math.sin(2 * Math.PI / h.n) : 4 * h.hx * h.hy);
  const side = (h) => (h.kind === 'circle' ? 2 * h.n * h.r * Math.sin(Math.PI / h.n) : 4 * (h.hx + h.hy));
  const segs = plan.foot.map(([z0, z1, h], k) =>
    [z0, k + 1 < plan.foot.length ? plan.foot[k + 1][0] : plan.screws ? FOOT_HOLES.screwTop : z1, h]);
  let vol = 0, sides = 0, roof = 0;
  for (const [z0, z1, h] of segs) {
    if (!h) continue;
    vol += area(h) * (z1 - z0); sides += side(h) * (z1 - z0); roof = area(h);
  }
  return { vol, sides, roof, mouth: segs[0][2] ? area(segs[0][2]) : 0 };
}

/* At a carved shape's reflex corner, the plastic carvedBody builds in plan less what
   binVolume counts there, in mm², with the walls t thick; and with onSlab, where the
   cells' floor slab stands round them too, as it does for the slab's last 2·BLOAT.
   binVolume counts the two walls running square into each other at the notch corner,
   with the fillet outside them, (1 - π/4)·CR², whole. carvedBody builds the corner from
   pieces that overlap: the two cells' panels, ending 2·BLOAT past their cells, a lap
   along each, a quarter disc of radius t on NARC chords, and the fillet as a band CR to
   CR + t + OVER about the fillet's centre, which reaches the notch corner only on walls
   of 1.35 mm or more and stands OVER into the cavity either side of it. Under them the
   slab of the cell across from the notch runs BLOAT past its two shared sides into it.
   The union is taken by scanlines: cut at every vertex and every crossing of two edges,
   its width is linear in x between two cuts, so its width halfway times the gap is exact.
   Kept by t, as a page weighs the same walls over and over. The notch corner is at the
   origin, and the material is towards +x and +y. */
const reflexOver = (() => {
  const memo = new Map();
  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const unionArea = (polys) => {
    const edges = polys.map((p) => p.map((a, i) => [a, p[(i + 1) % p.length]])
      .filter(([a, b]) => a[0] !== b[0]).map(([a, b]) => (a[0] < b[0] ? [a, b] : [b, a])));
    const all = edges.flat(), cuts = all.flat().map((p) => p[0]);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const [a, b] = all[i], [p, q] = all[j];
        const lo = Math.max(a[0], p[0]), hi = Math.min(b[0], q[0]);
        const s = (b[1] - a[1]) / (b[0] - a[0]), u = (q[1] - p[1]) / (q[0] - p[0]);
        if (!(hi > lo) || s === u) continue;
        const x = (p[1] - u * p[0] - a[1] + s * a[0]) / (s - u);
        if (x > lo && x < hi) cuts.push(x);
      }
    cuts.sort((a, b) => a - b);
    let area = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const x0 = cuts[i], x1 = cuts[i + 1], x = (x0 + x1) / 2, spans = [];
      if (!(x1 > x0)) continue;
      for (const es of edges) {
        const ys = es.filter(([a, b]) => a[0] < x && b[0] > x)
          .map(([a, b]) => a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])).sort((a, b) => a - b);
        for (let j = 0; j + 1 < ys.length; j += 2) spans.push([ys[j], ys[j + 1]]);
      }
      area += spansLength(mergedSpans(spans)) * (x1 - x0);
    }
    return area;
  };
  return (t, onSlab) => {
    const key = (onSlab ? 's' : 'w') + t;
    if (memo.has(key)) return memo.get(key);
    const d = SPEC.pitch / 2 - SPEC.half, CR = SPEC.half - SPEC.centre, NARC = 8, OVER = 4 * BLOAT;
    const lap = d + 2 * BLOAT, A = CR + 1, B = t + OVER + 1;      // A, B: room round all of it
    const arc = (r, o) => Array.from({ length: NARC + 1 }, (_, q) =>
      [o + r * Math.cos(Math.PI / 2 * q / NARC), o + r * Math.sin(Math.PI / 2 * q / NARC)]);
    const built = [box(0, -A, t, 2 * BLOAT - d), box(-A, 0, 2 * BLOAT - d, t),
      box(0, -lap, t, OVER), box(-lap, 0, OVER, t), [[0, 0]].concat(arc(t, 0)),
      arc(CR + t + OVER, -CR).concat(arc(CR, -CR).reverse())];
    const v = onSlab
      ? unionArea(built.concat([box(0, -A, B, B), box(-A, 0, 0, B), box(-d - BLOAT, -d - BLOAT, 0, 0)])) -
        ((A + B) ** 2 - A * A)
      : unionArea(built) - (2 * A * t + t * t + (1 - Math.PI / 4) * CR * CR);
    if (memo.size > 4096) memo.clear();
    memo.set(key, v);
    return v;
  };
})();

function binVolume(cfg, infill) {
  const c = halfSized(withWall(Object.assign({}, BIN_DEFAULTS, cfg || {})));
  c.floorT = builtFloorT(c);
  if (isHalfSize(c)) c.cells = null;
  const fill = Math.max(0, Math.min(1, isFinite(infill) ? infill : 0.15));
  const P = SPEC.pitch, C = SPEC.centre, CR = SPEC.half - C, n = c.arcSegs, wall = c.wall;
  const H = c.hUnits * SPEC.unitH, full = isFullRect(c), floorZ = floorTop(c);
  const allFull = !c.edges || ['f', 'b', 'l', 'r'].every((k) => c.edges[k] === undefined || c.edges[k] >= 1);
  const hasLip = c.lip && allFull && !c.solid;
  const lipH = lipHeight(c.lipMin), base = LIP[0][1];

  /* The outline in plan, as the area inside it `t` in from its outer face, and its
     perimeter. A rectangle is buildBin's rounded one. A carved shape is its cells, each
     outer face `half` from its cell's centre, so a quarter of a millimetre in from the
     grid line, with every convex corner on an arc of the spec's radius; a reflex corner
     is square in its slab and filleted to the same radius in its walls (carvedBody).
     The feet are binFeet's, whatever the shape. */
  const hwO = (c.u - 1) * P / 2 + SPEC.half - c.shrink, hdO = (c.v - 1) * P / 2 + SPEC.half - c.shrink;
  let areaIn, perim, fillets = 0, reflex = 0, convex = 0;
  if (full) {
    areaIn = (t) => areaRR(hwO - t, hdO - t, Math.max(0.4, SPEC.r - t));
    perim = perimRR(hwO, hdO, SPEC.r);
  } else {
    const mask = maskOf(c), has = (x, y) => mask.has(cellKey(x, y));
    let exposed = 0;
    for (const key of mask) {
      const [x, y] = key.split(',').map(Number);
      const e = [!has(x, y - 1), !has(x + 1, y), !has(x, y + 1), !has(x - 1, y)];
      exposed += e.filter(Boolean).length;
      for (let k = 0; k < 4; k++) if (e[k] && e[(k + 1) % 4]) convex++;
    }
    for (let vx = 0; vx <= c.u; vx++)
      for (let vy = 0; vy <= c.v; vy++) {
        const around = [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]];
        if (around.some(([i, j]) => i < 0 || j < 0 || i >= c.u || j >= c.v)) continue;
        if (around.filter(([i, j]) => !has(i, j)).length === 1) reflex++;
      }
    const d = P / 2 - SPEC.half, k = 1 - Math.PI / 4;
    areaIn = (t) => mask.size * P * P - (d + t) * exposed * P + (d + t) * (d + t) * (convex - reflex) -
      convex * k * Math.max(0, CR - t) ** 2;
    perim = exposed * P - 2 * d * (convex - reflex) - convex * (2 - Math.PI / 2) * CR;
    fillets = reflex * k * CR * CR;
  }
  const area0 = areaIn(0), outer = area0 + fillets;
  /* What carvedBody builds at a carved shape's corners, less what that outline counts
     there, in plan with the walls t thick: its convex corners are arcs on 8 chords, inside
     and out, and its reflex corners pieces that overlap (reflexOver). */
  const seg = (r) => r * r * (Math.PI / 4 - 4 * Math.sin(Math.PI / 16));   // a quarter arc less its 8 chords
  const cornersAt = (t) => (reflex ? reflex * reflexOver(t) : 0) + convex * (seg(Math.max(0, CR - t)) - seg(CR));

  /* The base block: the feet, added up foot by foot (binFeet) — a carved bin has fewer
     than its bounding box, and a half-size bin stands on quarter feet, 10.5 mm in on
     every side — and the floor slab over the whole outline, from the top of the feet to
     the cavity's floor, or to the top for a bin built as one block. Less what the holes
     in the feet leave empty. */
  const sizes = new Map();                       // how far in from a whole foot -> how many
  for (const f of binFeet(c)) sizes.set(f.inset, (sizes.get(f.inset) || 0) + 1);
  const footAt = (inset, g) => (z) => {
    let w = SPEC.prof[SPEC.prof.length - 1][1];
    for (let q = 0; q + 1 < SPEC.prof.length; q++) {
      const [z0, w0] = SPEC.prof[q], [z1, w1] = SPEC.prof[q + 1];
      if (z >= z0 && z <= z1) { w = w0 + (w1 - w0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
    }
    const h = w - c.shrink;
    return g(h - inset, h - inset, h - C);
  };
  let footV = 0, footLat = 0, botA = 0;
  for (const [inset, count] of sizes) {
    for (let q = 0; q + 1 < SPEC.prof.length; q++) {
      const z0 = SPEC.prof[q][0], z1 = SPEC.prof[q + 1][0];
      footV += count * simpsonOf(footAt(inset, areaRR), z0, z1);
      footLat += count * simpsonOf(footAt(inset, perimRR), z0, z1);
    }
    botA += count * footAt(inset, areaRR)(0);
  }
  const plan = holePlan(c), sites = plan ? holeSites(c).length : 0;
  const hole = plan ? holeVoid(plan) : { vol: 0, sides: 0, roof: 0, mouth: 0 };
  /* Where the slab ends: a rectangle built as one block goes to the top; a carved one to
     a hundredth under it, and a carved one with a floor at or past the top keeps a
     sliver of wall over its floor (carvedBody). The slab runs a BLOAT past the floor, and
     that is the floor a part stands on. */
  const solidBody = full && builtSolid(c);
  const cavityFloor = full ? floorZ : c.solid ? H - 0.01 : Math.min(floorZ, H - 0.25);
  const slabTop = solidBody ? H : cavityFloor + BLOAT;
  const slabH = slabTop - SPEC.footH;
  const holes = sites * hole.vol;
  /* A carved shape's corners in the slab (cornersAt): the convex ones' chords; at each
     reflex corner the slab of the cell across from the notch, which runs BLOAT past its
     two shared sides into it; and in the slab's last 2·BLOAT, the corner's own pieces,
     which start there (on a carved shape built as one block, its last BLOAT + 0.01). */
  const on = Math.min(slabTop, hasLip ? H + lipH : H) - (cavityFloor - BLOAT);
  const slabCorners = full ? 0 : -convex * seg(CR) * slabH +
    (reflex ? reflex * ((P / 2 - SPEC.half + BLOAT) ** 2 * (slabH + BLOAT - on) + reflexOver(wall, true) * on) : 0);
  const baseRaw = footV + area0 * slabH + slabCorners - holes;
  const baseShell = (footLat + perim * slabH + sites * hole.sides) * SHELL_T +
                    (botA - sites * hole.mouth + area0 + sites * hole.roof) * SKIN_T;
  const baseFil = Math.min(baseRaw, baseShell + fill * Math.max(0, baseRaw - baseShell));

  /* The lip: the socket profile standing on the walls, from H to H + lipH, and under H
     the 45 degree chamfer from the wall out to the lip's base, beyond the wall (lipRing,
     and carvedBody's wallProfile). A bin built as one block keeps the part above H. */
  let lip = 0, lipDrop = 0;
  const cavity = !solidBody && !(c.solid && !full);
  if (hasLip) {
    const steps = LIP.concat([[lipH, c.lipMin]]);
    for (let q = 0; q + 1 < steps.length; q++) {
      const [dz0, t0] = steps[q], [dz1, t1] = steps[q + 1];
      lip += simpsonOf((z) => outer - areaIn(t0 + (t1 - t0) * (z - dz0) / (dz1 - dz0)), dz0, dz1);
    }
    if (cavity && full && base - wall >= BLOAT)
      lipDrop = Math.min(base - wall, Math.max(BLOAT, H - (SPEC.footH + c.floorT) - 0.3));
    else if (cavity && !full)
      lipDrop = Math.min(Math.max(BLOAT, base - wall), Math.max(BLOAT, H - cavityFloor - 0.3));
    // (on a carved shape with walls thicker than the lip's base, it narrows to it instead)
    lip += simpsonOf((z) => areaIn(wall) - areaIn(wall + (base - wall) * z / lipDrop), 0, lipDrop, 4);
  }

  if (!cavity) {
    const parts = { base: baseRaw, walls: 0, lip, dividers: 0, scoop: 0, shelf: 0, block: 0, holes };
    return { raw: baseRaw + lip, filament: baseFil + lip, parts };
  }

  /* The walls, from the slab's top up: to H all round, or on a rectangle to each wall's
     own height (edgeHeights), the straight runs at their own and each corner at the
     taller of its two, a lower wall rising to a taller neighbour over rampLen of it. A
     carved shape's walls are full height, and its reflex corners are filleted.
     A straight is the band wallRing builds between the outer straight and the inner one,
     their vertices paired at the same fractions along each: a rectangle while the
     cavity's corner shares the outer corner's centre (walls up to SPEC.r - 0.4), and past
     that, where the cavity's corner stays at 0.4 mm, a trapezoid, longer outside than in.
     A ramp spans the same fraction of both, so it is weighed at the band's mean width. */
  const hFull = H - slabTop;
  const ring = outer - areaIn(wall);
  let walls = ring * hFull;
  if (full && !allFull) {
    const frac = (k) => Math.max(0, Math.min(1, c.edges && c.edges[k] !== undefined ? c.edges[k] : 1));
    const tall = (f) => Math.max(0, f * (H - floorZ) - BLOAT);
    const run = { f: 2 * (hwO - SPEC.r), b: 2 * (hwO - SPEC.r), l: 2 * (hdO - SPEC.r), r: 2 * (hdO - SPEC.r) };
    const ends = { f: ['l', 'r'], b: ['l', 'r'], l: ['f', 'b'], r: ['f', 'b'] };
    const inset = 2 * (wall + Math.max(0.4, SPEC.r - wall) - SPEC.r);   // how much shorter inside
    const band = (k) => wall * (run[k] + Math.max(0, run[k] - inset)) / 2;
    const corner = (ring - band('f') - band('b') - band('l') - band('r')) / 4;
    walls = 0;
    for (const k of ['f', 'b', 'l', 'r']) {
      walls += band(k) * tall(frac(k));
      for (const o of ends[k]) {
        const rise = tall(frac(o)) - tall(frac(k));
        if (rise > 0 && run[k] > 0) walls += band(k) / run[k] * rise * rampLen(run[k]) / 2;
      }
    }
    for (const [a, b] of [['f', 'l'], ['f', 'r'], ['b', 'l'], ['b', 'r']])
      walls += corner * tall(Math.max(frac(a), frac(b)));
  }
  if (!full) {
    /* ...and its corners (cornersAt) up the walls' own profile: the wall's thickness, then
       the chamfer's and the lip's. */
    const prof = [[slabTop, wall], [H - lipDrop, wall]]
      .concat(hasLip ? LIP.concat([[lipH, c.lipMin]]).map(([dz, t]) => [H + dz, t]) : []);
    for (let q = 0; q + 1 < prof.length; q++) {
      const [z0, t0] = prof[q], [z1, t1] = prof[q + 1];
      walls += t0 === t1 ? cornersAt(t0) * (z1 - z0)
        : simpsonOf((z) => cornersAt(t0 + (t1 - t0) * (z - z0) / (z1 - z0)), z0, z1, 4);
    }
    const parts = { base: baseRaw, walls, lip, dividers: 0, scoop: 0, shelf: 0, block: 0, holes };
    return { raw: baseRaw + walls + lip, filament: baseFil + walls + lip, parts };
  }

  /* Inside a rectangle: the dividers, the scoop, the label shelf and the block of holes
     across the floor, sized by the sums buildBin builds them by (floorPlan, dividersBuilt,
     scoopBuilt). A bin with holes has no dividers and no scoop. A divider, or a removable
     one's rails, stands from the floor to H, so where one stands nothing else there
     counts; the scoop and the shelf are counted across the rest of the cavity's width, in
     the cavity's rounded outline. Where the two meet, on a bin too shallow for both, they
     are counted once. */
  const iw = hwO - wall, id = hdO - wall, rI = Math.max(0.4, SPEC.r - wall);
  const { shelf: sh, holes: hb } = floorPlan(c, iw, id, H), holesOn = !!hb.n;
  const built = holesOn ? { divX: 0, divY: 0 } : dividersBuilt(c), half = wall / 2;
  const slot = c.divT / 2 + c.divClr, rail = slot + RAIL_T, deep = RAIL_D + c.divClr;
  const spansOf = (count, inner) => {
    const out = [];
    for (let k = 1; k <= count; k++) {
      const p = -inner + (2 * inner) * k / (count + 1);
      if (c.divRemovable) out.push([p - rail, p - slot], [p + slot, p + rail]);
      else out.push([p - half, p + half]);
    }
    return spansClip(mergedSpans(out, BLOAT), -inner, inner);
  };
  const reachOf = (inner) => (!c.divRemovable ? [[-inner, inner]]
    : deep >= inner - BLOAT / 2 ? [[-inner, inner]] : [[-inner, -inner + deep], [inner - deep, inner]]);
  const xs = spansOf(built.divX, iw), ys = spansOf(built.divY, id);   // x where divX stand, y where divY do
  const xReach = reachOf(id), yReach = reachOf(iw);                     // how far along each they stand
  const crossing = spansMeet(xs, yReach) * spansMeet(ys, xReach);
  const divPlan = c.divRemovable
    ? railArea(built.divX, iw, id, wall, c.divT, c.divClr) + railArea(built.divY, id, iw, wall, c.divT, c.divClr) - crossing
    : spansLength(xs) * 2 * id + spansLength(ys) * 2 * iw - crossing;
  let dividers = divPlan * hFull;

  const scoopR = holesOn ? 0 : scoopBuilt(c, id, H, floorZ), segs = Math.max(4, n);
  const arc = [];
  for (let k = 0; k <= segs; k++) {
    const a = (k / segs) * Math.PI / 2;
    arc.push([scoopR - scoopR * Math.sin(a), scoopR - scoopR * Math.cos(a)]);
  }
  arc.reverse();                                         // from the wall out
  const scoopTop = (s) => {                              // over the floor, s from the front wall
    if (!scoopR || s < 0 || s >= scoopR) return 0;
    for (let k = 1; k < arc.length; k++)
      if (s <= arc[k][0]) return arc[k - 1][1] + (arc[k][1] - arc[k - 1][1]) * (s - arc[k - 1][0]) / (arc[k][0] - arc[k - 1][0]);
    return 0;
  };
  const shelfD = sh ? sh.depth : 0, shelfFront = id - shelfD, t = c.labelT;
  /* What stands on the floor at y, from the slab's top: the scoop, the shelf, and both.
     The shelf is a term of its own (parts.shelf), and shelfCol(y) its section, from its
     45 degree underside to its top: the block of holes, which runs on under it to the
     back wall, takes off what it shares with shelfCol (blockOver, below). */
  const scoopCol = (y) => Math.max(0, floorZ + scoopTop(y + id) - slabTop);
  const shelfCol = (y) => (!shelfD || y < shelfFront ? [0, 0]
    : [Math.max(slabTop, sh.top - t - (y - shelfFront)), sh.top]);
  const bothCol = (y) => {
    const s = scoopCol(y), [lo, hi] = shelfCol(y);
    return s + Math.max(0, hi - lo) - Math.max(0, Math.min(slabTop + s, hi) - lo);
  };
  // how wide the cavity is at y, in its rounded corners too, and how much of that is free
  const gap = (d) => (d >= rI ? 0 : rI - Math.sqrt(Math.max(0, rI * rI - (rI - d) * (rI - d))));
  const width = (y) => 2 * (iw - gap(id - Math.abs(y)));
  const taken = (y) => spansLength(mergedSpans([
    ...(inSpans(xReach, y) ? xs : []),
    ...(inSpans(ys, y) ? yReach : [])]));
  // how much of the shelf's section at y is inside the block of holes, which stands on the floor
  const blockTop = holesOn ? hb.top : slabTop;
  const blockCol = (y) => { const [lo, hi] = shelfCol(y); return Math.max(0, Math.min(hi, blockTop) - Math.max(lo, slabTop)); };
  const stops = [-id, id, -id + scoopR, shelfFront, shelfD ? shelfFront + sh.top - t - slabTop : -id,
                 shelfD && holesOn ? shelfFront + sh.top - t - blockTop : -id,
                 -id + rI, id - rI, ...arc.map(([s]) => -id + s), ...xReach.flat(), ...ys.flat()]
    .filter((y) => y >= -id && y <= id).sort((a, b) => a - b);
  let scoop = 0, both = 0, blockOver = 0;
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i], b = stops[i + 1];
    // only where there is a scoop or a shelf to count
    if (b - a < 1e-9 || !((scoopR && a < -id + scoopR) || (shelfD && b > shelfFront))) continue;
    const used = taken((a + b) / 2);
    const free = (y) => Math.max(0, width(y) - used);
    scoop += gaussOf((y) => scoopCol(y) * free(y), a, b);
    both += gaussOf((y) => bothCol(y) * free(y), a, b);
    if (holesOn) blockOver += gaussOf((y) => blockCol(y) * free(y), a, b);
  }
  /* The lip's chamfer comes down over the back wall and the side walls, and a shelf whose
     top is at H, or within the chamfer's drop of it, stands in it there: counted in the
     lip, it is taken off the shelf. */
  let underLip = 0;
  if (shelfD && lipDrop > 0) {
    const z1 = Math.min(H, sh.top) - (H - lipDrop);
    if (z1 > 0) underLip = (base - wall) / lipDrop * z1 * z1 / 2 * (2 * iw + 2 * Math.min(shelfD, id));
  }
  const shelf = Math.max(0, both - scoop - underLip);
  /* A divider's ends, and the ribs of a removable one's rails, stand in the lip's chamfer
     where they meet a wall: counted in the lip, they are taken off the dividers. The
     chamfer's section is base - wall out from the wall at H, coming in to the wall over
     lipDrop below it; a rib stands in the part of it within its reach of the wall, a
     fixed divider in all of it. Where the label shelf stands against a wall, underLip
     took the chamfer below the shelf's top off the shelf along the whole wall, dividers'
     ends and all, so there only what is above the shelf's top comes off here. */
  if (lipDrop > 0 && (xs.length || ys.length)) {
    const A = base - wall, L = lipDrop;
    const upTo = (z, d) => {                // the section within d of the wall, z up its drop
      const zd = d * L / A;
      return z <= zd ? A * z * z / (2 * L) : A * zd * zd / (2 * L) + d * (z - zd);
    };
    const over = (z0, d) => upTo(L, d) - upTo(Math.min(L, Math.max(0, z0)), d);
    const dX = Math.min(A, !c.divRemovable || deep >= id - BLOAT / 2 ? A : deep);
    const dY = Math.min(A, !c.divRemovable || deep >= iw - BLOAT / 2 ? A : deep);
    const z0 = shelfD ? Math.min(H, sh.top) - (H - L) : 0;
    const yShelf = shelfD ? spansLength(spansClip(ys, shelfFront, id)) : 0;
    dividers -= spansLength(xs) * (over(0, dX) + over(z0, dX)) +
                2 * ((spansLength(ys) - yShelf) * over(0, dY) + yShelf * over(z0, dY));
  }
  /* The block of holes across the floor (holeLayout): the cavity's outline, less the
     holes, from the slab's top to the block's top, which is half a millimetre under the
     rim or under the label shelf's front edge. Its tiles run a BLOAT into the walls and
     into one another, all inside what is counted already. Under the shelf it runs on to
     the back wall, through the wedge the shelf's underside fills (blockOver, the shelf's
     plastic, counted there); and where the lip's chamfer comes down over the walls, a
     block whose top is within the chamfer's drop of H stands in it, along the walls in
     front of the shelf: counted in the lip, it is taken off the block. A thick part like
     the base, so for the filament a shell round its outside and every hole, a skin over
     its top, and infill inside that; the webs between holes are thinner than two shells,
     so most of a dense grid comes out solid, which the min() keeps. */
  let block = 0, blockFil = 0;
  if (holesOn) {
    const deepB = hb.top - slabTop, topA = Math.max(0, areaRR(iw, id, rI) - hb.n * hb.shape.area);
    let inLip = 0;
    if (lipDrop > 0) {
      const z1 = hb.top - (H - lipDrop);
      const along = shelfD ? 2 * iw + 2 * (shelfFront + id) : perimRR(iw, id, rI);
      if (z1 > 0) inLip = (base - wall) / lipDrop * z1 * z1 / 2 * along;
    }
    block = Math.max(0, topA * deepB - blockOver - inLip);
    const shell = (perimRR(iw, id, rI) + hb.n * hb.shape.perim) * SHELL_T * deepB + topA * SKIN_T;
    blockFil = Math.min(block, shell + fill * Math.max(0, block - shell));
  }
  /* How much of each the slicer lays down solid: what lies within its shells of the
     surfaces it shows, the scoop's curve, and the shelf's top, front and underside. */
  const solidPart = (area, edge) => (area > 0 ? Math.min(1, edge * SHELL_T / area) : 1);
  const sSolid = solidPart(scoopR * scoopR * (1 - segs / 2 * Math.sin(Math.PI / (2 * segs))),
                           2 * segs * scoopR * Math.sin(Math.PI / (4 * segs)));
  const lSolid = solidPart(shelfD * (t + shelfD / 2), shelfD + t + shelfD * Math.SQRT2);
  const infilled = (v, solid) => v * (solid + fill * (1 - solid));

  const thin = walls + lip + dividers;
  const parts = { base: baseRaw, walls, lip, dividers, scoop, shelf, block, holes };
  return { raw: baseRaw + thin + scoop + shelf + block,
           filament: baseFil + thin + infilled(scoop, sSolid) + infilled(shelf, lSolid) + blockFil, parts };
}

/* ---------- layout packing -------------------------------------------------
 * Bins travel in the URL hash, so the encoding has to be compact. It also has to
 * survive the values it carries: the original separator was '.', and wall
 * thickness 1.2 split into "1" and "2", shifting every later field so a bin came
 * back with dividers it never had. Separators are now characters that cannot
 * occur in a plain non-negative decimal, and packBin writes every number as one.
 *
 * Field positions are the format. A bin is 21 fields, 22 when its feet have holes, 23
 * when its label shelf carries its note, 25 when its floor has holes for what goes in
 * it, and everything after a change
 * shifts, so adding or removing one invalidates every link already in circulation.
 * Growing it is safe only at the end: a link from before reads the fields it lacks as
 * absent, and each field's absent value has to mean what such a link always meant.
 * The base-style field was dropped when the base styles went, which was free only
 * because the site had not been advertised and no link existed to break. Anything
 * retired from here on gets left in place as a dead field instead.
 *
 * Pure functions living here rather than in the UI so they can be tested headlessly.
 */
const SEP = { field: '-', bin: '_', layer: '~' };
const PACK_EDGES = ['f', 'b', 'l', 'r'];

function maskBits(b) {
  // a half-size bin is never carved, so it never carries a mask (see binFeet)
  if (!b.cells || !b.cells.length || isHalfSize(b)) return '';
  const set = new Set(b.cells.map(([x, y]) => cellKey(x, y)));
  if (set.size === b.u * b.v) return '';
  let out = '';
  for (let x = 0; x < b.u; x++) for (let y = 0; y < b.v; y++)
    out += set.has(cellKey(x, y)) ? '1' : '0';
  return out;
}
function bitsToCells(bits, u, v) {
  if (!bits) return null;
  const out = [];
  let i = 0;
  for (let x = 0; x < u; x++) for (let y = 0; y < v; y++, i++)
    if (bits[i] === '1') out.push([x, y]);
  return out.length ? out : null;
}
/* Every number goes out as a plain non-negative decimal. packBin used to throw on any
   value with a '-' in it, and two ordinary ones have one: a negative wall or floor, and
   a tiny value, which String() writes in exponent form (1e-7). The throw landed in the
   save, the share link, the hand-over to baseplates and the README, so saving stopped
   without a word and those buttons died with it. No field can be negative, so a
   negative is written as 0, and an exponent is spelled out in full instead.
   A value that is no number at all goes out as "NaN", which unpackBin reads back as
   the field's default. Written as 0 it came back as a real value instead: a NaN wall
   as no wall, a NaN edge as an open side. An empty field would not do, since
   Number('') is 0. */
const plainNum = (v) => {
  if (typeof v !== 'number') return v;     // the carve mask: already 0s and 1s
  if (!isFinite(v)) return 'NaN';          // NaN and both infinities
  if (!(v > 0)) return 0;                  // negative and -0
  const s = String(v);
  return s.includes('e') ? v.toFixed(20).replace(/\.?0+$/, '') : s;
};
/* Which preset of holes a bin has, as the link stores it: 0 for anything that is not one. */
const insertOf = (b) => (Number.isInteger(+b.insert) && INSERTS[+b.insert] ? +b.insert : 0);
function packBin(b) {
  const f = [b.x, b.y, b.u, b.v, b.hUnits, b.wall, b.floorT, b.divX, b.divY,
             b.solid ? 1 : 0]
    .concat(PACK_EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)))
    /* `done` last, so a link written before it existed still reads: an absent field 17
       is undefined, and a bin nobody has marked is one nobody has printed. */
    .concat([b.scoop || 0, b.label || 0, maskBits(b) || 0, b.done ? 1 : 0,
             b.divRemovable ? 1 : 0,
             /* A lid, and which of its four sides carry a skirt, as a bitmask. One
                field rather than four: the sides are only meaningful when there is a
                lid, and the format is positional so every field costs every link. */
             b.lid ? 1 : 0, lidSideBits(b.lidSides)])
    /* Holes in the feet, and later the finger slots (see feetBits), only on a bin that
       has some. Every bin had this field written as a 0, so a link made before it came
       back one field longer, which rewrote the address, the local save, saved drawers
       and the README link the first time it was opened, and the page then said the
       link had replaced the layout. A bin without holes is 21 fields, exactly as it
       was; unpackBin reads the absent 22nd as none. */
    .concat(feetBits(b) || b.labelMode || insertOf(b) ? [feetBits(b)] : [])
    /* What the label shelf carries, the 23rd field, and for the same reason only on a bin
       that has it set: one without it is the 21 or 22 fields it always was. It needs the
       22nd in place to stand 23rd, so a bin with a note raised and no holes writes its
       feet as 0. 0 is nothing, 1 the note raised on the shelf; 2 is kept for a label
       slot, which unpackBin reads as 1 until there is one. */
    .concat(b.labelMode || insertOf(b) ? [b.labelMode || 0] : [])
    /* Holes across the floor, the 24th and 25th fields: which preset (an index into
       INSERTS) and how deep, 0 for worked out from the item. Again only on a bin that has
       them, writing the two fields before as 0 where they are not set, so a bin without
       is byte for byte what it was. */
    .concat(insertOf(b) ? [insertOf(b), b.insertDepth > 0 ? b.insertDepth : 0] : []);
  /* Still checked, but answered with a 0 rather than a throw: a bad field then costs
     that one field, where a separator inside it would shift every field after it. */
  const seps = Object.values(SEP);
  return f.map((v) => {
    const s = String(plainNum(v));
    return seps.some((c) => s.includes(c)) ? '0' : s;
  }).join(SEP.field);
}
/* The most a link can ask for. Nothing here was bounded and the geometry does what it
   is told: a million dividers froze the tab for half a minute and were then saved, so
   every visit froze it again; a footprint of 1e9 cells crashed it; a height of 1e308
   came out as "Infinity mm". Each limit is past anything that can be printed or put in
   a drawer — 2000 mm is the largest drawer or bed the baseplates page accepts — so
   clamping to it loses nothing a person could have meant. */
const LINK_MAX = {
  cells: 50,                               // 2100 mm, for a footprint or a position
  hUnits: Math.floor(2000 / SPEC.unitH),   // as tall as the tallest bed
  wall: 10,                                // already half the inside of a 1x1 bin
};
/* The wall heights the edge menus offer. One that is not in the list put the menu on a
   blank entry, the next edit read that back as NaN, and the bin was built from NaN. */
const EDGE_STEPS = [0, 0.25, 0.5, 0.66, 1];
const snapEdge = (x) => (!isFinite(x) ? 1
  : EDGE_STEPS.reduce((a, s) => (Math.abs(s - x) < Math.abs(a - x) ? s : a)));
/* How many dividers fit across `inside` mm. Each is one wall thick, and closer together
   than that they only overlap into solid plastic: more cannot change the part, only how
   long it takes to build. Never counted thinner than a rail, two lines of a 0.4 mm
   nozzle, so a zero wall cannot make the limit infinite. */
const maxDividers = (inside, wall) =>
  Math.max(0, Math.floor(inside / Math.max(wall, RAIL_T)) - 1);
/* Anything can arrive here: the hash is in the address bar, so it gets hand-edited,
   truncated by a chat client and pasted back a field short. Every field therefore
   falls back to its default rather than passing NaN through to the geometry — a bin
   with a NaN footprint builds no polygons at all, so the page comes up blank, which
   looks exactly like losing the layout rather than like a typo. Every field is also
   held to the range it can really take: none is negative, and counts are whole —
   a y of 0.5 threw in the map, and 2.5 dividers were reported as 3.5 compartments. */
const numAt = (p, i, d, hi) => (isFinite(p[i]) ? Math.min(hi, Math.max(0, p[i])) : d);
const countAt = (p, i, d, lo, hi) =>
  (isFinite(p[i]) ? Math.min(hi, Math.max(lo, Math.round(p[i]))) : d);
/* A size or a place as a page writes it: whole, or since half-size bins, half a cell on.
   Kept as it is. Anything else is read as countAt reads it, which is how a page from
   before half sizes read every one: no page writes 1.3, so one is typed by hand, and was
   a whole cell there. Snapped to the nearest half instead, 1.4 x 1.4 came back a cell and
   a half where it had been a cell, and a 1.3 grew into the bin beside it. */
const halfAt = (p, i, d, lo, hi) =>
  (isFinite(p[i]) && Number.isInteger(p[i] * 2) && p[i] >= 0.5 && p[i] <= hi ? p[i]
    : countAt(p, i, d, Math.max(1, lo), hi));
const placeAt = (p, i, hi) =>
  (isFinite(p[i]) && Number.isInteger(p[i] * 2) && p[i] >= 0 && p[i] <= hi ? p[i]
    : countAt(p, i, 0, 0, hi));
/* Sizes and positions are in cells, and since half-size bins they may end in .5. The
   four fields are the same four, so the format did not grow and a link from before reads
   exactly as it did: it only ever held whole numbers.
     u and v keep a half (halfAt); anything between halves is a whole cell, as it was.
     x and y keep a half for a half-size bin, and are whole cells for a whole one, which
   stays on whole cells (see binFeet): a whole bin on a half step is rounded onto the
   grid as a fractional position always was.
     A bin with a carve mask is read as a page from before half sizes read it, all four
   rounded to whole cells, and keeps its mask. A mask counts whole cells, and no page
   writes one for a half-size bin, so a bin that has one came from a whole-cell page or
   was typed over one: read in halves, a 2.5 wide bin lost its shape where it had been
   a 3 wide L.
   A page from before half sizes reads 1.5 as 2, and has no way to know it should not:
   neither page checks the link's version. That is the one thing a new link loses in an
   old tab. */
function unpackBin(t) {
  const raw = String(t).split(SEP.field);
  const p = raw.map(Number);
  const edges = {};
  PACK_EDGES.forEach((k, i) => { edges[k] = snapEdge(p[10 + i]); });
  const mask = raw[16] && raw[16] !== '0' ? raw[16] : '';
  const sizeAt = mask ? countAt : halfAt;
  const u = sizeAt(p, 2, BIN_DEFAULTS.u, 1, LINK_MAX.cells);
  const v = sizeAt(p, 3, BIN_DEFAULTS.v, 1, LINK_MAX.cells);
  const half = isHalfSize({ u, v });
  const posAt = (i) => (half ? placeAt(p, i, LINK_MAX.cells) : countAt(p, i, 0, 0, LINK_MAX.cells));
  const hUnits = countAt(p, 4, BIN_DEFAULTS.hUnits, 1, LINK_MAX.hUnits);
  const H = hUnits * SPEC.unitH;
  const wall = numAt(p, 5, BIN_DEFAULTS.wall, LINK_MAX.wall);
  const inside = (n) => (n - 1) * SPEC.pitch + 2 * SPEC.half - 2 * wall;
  /* A floor or scoop past the bin's height, or a label shelf past its depth, builds
     the same part as one at it: the geometry already stops them there. */
  return { x: posAt(0), y: posAt(1),
           u, v, hUnits, wall, floorT: numAt(p, 6, BIN_DEFAULTS.floorT, H),
           divX: countAt(p, 7, 0, 0, maxDividers(inside(u), wall)),
           divY: countAt(p, 8, 0, 0, maxDividers(inside(v), wall)), solid: !!p[9],
           edges, scoop: numAt(p, 14, 0, H), label: numAt(p, 15, 0, v * SPEC.pitch),
           cells: half ? null : bitsToCells(mask, u, v),
           done: !!p[17], divRemovable: !!p[18],
           lid: !!p[19], lidSides: lidSidesFrom(p[20]), ...feetFrom(p[21]),
           labelMode: countAt(p, 22, 0, 0, 1),
           /* one of the presets there are, and no deeper than the bin is tall: the block
              stops under the rim whatever is asked, so deeper builds the same part */
           insert: presetAt(p, 23), insertDepth: numAt(p, 24, 0, H) };
}
/* A preset this page has, or none. Held to the last one, a 5th from a later page opened
   here as hex bits and was written back as them; read as none, it is a bin without
   holes, whose link drops the two fields as any bin's without holes does. */
const presetAt = (p, i) => {
  const k = isFinite(p[i]) ? Math.round(p[i]) : 0;
  return k > 0 && INSERTS[k] ? k : 0;
};
const packLayers = (layers) =>
  layers.map((L) => L.bins.map(packBin).join(SEP.bin)).join(SEP.layer);
const unpackLayers = (s) => (s || '').split(SEP.layer)
  .map((ls) => ({ bins: ls.split(SEP.bin).filter(Boolean).map(unpackBin) }));

if (typeof module !== 'undefined') {
  module.exports = { buildBin, binVolume, dividerPart, railedMost, railedLimit, dividersBuilt, lidPart, lidSideBits, lidSidesFrom, roundRect, outlineAt, wallSplits, RAMP_RUN, SPEC, BIN_DEFAULTS, LIP_TABLE: LIP,
    lipHeight, binHeights, unitsForInside, unitsForTop, REQUIRED_CORE,
    FOOT_HOLES, SCREW_FLOOR, holeSites, holePlan, builtFloorT, feetBits, feetFrom,
    isHalfSize, binFeet, feetHolesOff,
    maskOf, maskCheck, isFullRect, cellKey, maskBits, bitsToCells,
    packBin, unpackBin, packLayers, unpackLayers, LINK_MAX, shelfNote, NOTE_CLEAR,
    INSERTS, INSERT_SPEC, HOLES_MAX, insertPlan };
}
