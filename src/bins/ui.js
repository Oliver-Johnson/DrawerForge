/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Drawerforge Bins UI. Core geometry and buildBin are in scope from the previous
   script tags (both end with a module.exports guard, so in the browser their
   functions land as globals). */
'use strict';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const G = {
  makePoly, triangulateRing, extrudePoly, clampZ, profilePrism, polyArea2D,
  polysToTriangles, stlBinary, checkManifold,
};
// In Node the audits pass the whole core module; in the browser this object is
// assembled by hand, so the two surfaces can drift. Fail loudly at load rather
// than at the first bin that happens to need the missing one.
for (const fn of REQUIRED_CORE)
  if (typeof G[fn] !== 'function')
    throw new Error(`bins UI is missing core function ${fn}() — add it to G in src/bins/ui.js`);

const PLA_DENSITY = 1.24;   // g/cm3
const S = 40;               // map cell size, svg units

/* Counted things, written the way a person would say them — see DF.plural, which both
   tools share now that baseplates needed the same fix. */
const plural = DF.plural;

const state = {};           // drawer + defaults for new bins
let layers = [{ bins: [] }];
let cur = 0;                // layer being edited, 0 = sitting on the baseplate
let selected = -1;          // the primary selection: what resize and move act on
/* Carving was alt-click only, which meant the feature may as well not have existed:
   the sole mention was a line of grey help text, while merge — the other route to the
   same shapes — had a button. This is that button. Alt-click still works. */
let carving = false;
/* Single-bin focus: a view mode and nothing else. The bin it means is B()[selected]
   in layer `cur`, so every existing edit path — the settings, undo, the keyboard, the
   context menu — keeps working in it unchanged rather than learning a second way to
   name a bin. What the mode HIDES lives in one class on <body>; see applyFocus() and
   the block it points at in style.css. */
let focused = false;
/* A bin being designed with no drawer around it. It is NOT in `layers`, which is the
   whole point: somebody who wants one 2x3x6 bin should not have to lay out a drawer
   and drag on a grid to get it. Everything downstream reaches the focused bin through
   fBin() rather than through B()[selected], so a loose bin and a placed one are the
   same object to the piece table, the plan, the preview and the export. */
let scratch = null;
let savedView = null;       // the drawer's camera, put back when focus is left
let selExtra = new Set();   // ctrl-clicked companions, edited together with it
let hashExtras = {};
let pendingNotes = null;
let pendingFocus = null;    // "layer.index" from the hash, applied once the layout exists
let pendingScratch = null;  // a packed loose bin from the hash
const geoCache = new Map();

const B = () => layers[cur].bins;
// every selected index, primary first, filtered to bins that still exist
const selAll = () => (selected < 0 ? []
  : [selected, ...selExtra].filter((v, i, a) => a.indexOf(v) === i && B()[v]));
const clearSel = () => { selected = -1; selExtra.clear(); };
/* The bin focus is pointed at, whichever kind it is. Null whenever focus is off. */
const fBin = () => (!focused ? null : scratch || (selected >= 0 ? B()[selected] : null));
const LIP_H = lipHeight(0.55);

/* ---------- model --------------------------------------------------------- */
/* The largest drawer the map will lay out, and so the most cells a side. Every draw
   walks every cell, and a 21 m drawer typed by accident — 500 cells a side — froze the
   page for over a minute. 2000 mm is the largest drawer or bed the baseplates page and
   a shared link accept, read from the drawer field's own max so the spinner and the
   clamp agree; that is 47 cells. Past it Checks says the drawer was cut down rather
   than the tab hanging. */
const DRAWER_MAX = parseFloat($('drawerW').max) || 2000;
const GRID_MAX = Math.floor(DRAWER_MAX / SPEC.pitch);
$('gridX').max = $('gridY').max = GRID_MAX;
// the drawer size as typed, before the clamp; Checks names it when the two differ
let drawerAsked = { w: 0, d: 0 };
/* The margins the baseplate keeps, as the Baseplates page left them in the link.
 *
 * This page has no fields for them, and carries them through untouched in hashExtras,
 * but they decide how many cells the plate has: custom margins take their room off the
 * drawer before the cells are counted. A margin that does not read as a length is none,
 * as the plate's own field reads it. The other two modes, a solid margin and a gap, pad
 * the same grid and change no count. */
function plateMargins() {
  if (hashExtras.mm !== 'custom') return null;
  const m = (k) => {
    const x = Number(hashExtras[k]);
    return isFinite(x) && x > 0 ? x : 0;
  };
  return { l: m('ml'), r: m('mr'), f: m('mf'), b: m('mb') };
}
/* The pitch the baseplate in the link was laid out at, or null when it is the standard
   one or there is none. Spec bins are 42 mm and seat in nothing else — see warnings.
   Within a hundredth of a millimetre is the standard one. The test was exact, so a plate
   at 42.001 mm was "a 42 mm grid ... not the standard's 42 mm"; and a hundredth a cell
   is a few hundredths across any bin a bed will print, where a 41.5 mm foot has a
   quarter of a millimetre to spare each side of its socket. The 1e-9 is for 42.01,
   which floating point puts 0.010000000000005 away. */
const PITCH_SLACK = 0.01;
function platePitch() {
  if (!Object.prototype.hasOwnProperty.call(hashExtras, 'pi')) return null;
  const x = Number(hashExtras.pi);
  return Math.abs(x - SPEC.pitch) <= PITCH_SLACK + 1e-9 ? null : x;
}
/* The plate's cells, counted by the code that lays the plate out (gridCells in core.js),
   at the 42 mm a spec bin is made to. It was the drawer over 42 and nothing else, so a
   plate whose margins left it six cells wide arrived here as a map seven wide, and the
   seventh column took bins with no sockets under them. At any other pitch the plate has
   no cell a spec bin fits, so the grid is the 42 mm cells the plate's margins leave room
   for, and Checks says why none of them will seat. A W × D drawer, so the cell fields can
   ask it of the largest drawer there is (see readControls). The margins around the
   cells come too, custom or where the plate's alignment puts the leftover: they are
   where the plate sits in the drawer (see drawerBox). */
function plateCells(W, D) {
  const pm = plateMargins();
  // each held to the drawer, as the plate's fields hold them
  const c = gridCells({ drawerW: W, drawerD: D, pitch: SPEC.pitch,
    marginMode: pm ? 'custom' : 'auto', alignX: hashExtras.ax, alignY: hashExtras.ay,
    mLeft: pm ? Math.min(pm.l, W) : 0, mRight: pm ? Math.min(pm.r, W) : 0,
    mFront: pm ? Math.min(pm.f, D) : 0, mBack: pm ? Math.min(pm.b, D) : 0 });
  return { nx: Math.max(1, Math.min(GRID_MAX, c.nx)), ny: Math.max(1, Math.min(GRID_MAX, c.ny)),
           mL: c.mL, mR: c.mR, mF: c.mF, mB: c.mB };
}
function grid() {
  const { nx, ny } = plateCells(state.drawerW, state.drawerD);
  const avail = state.drawerH - state.plateH;
  return { nx, ny, avail, maxUnits: Math.max(1, Math.floor((avail - LIP_H) / SPEC.unitH)) };
}
const EDGES = ['f', 'b', 'l', 'r'];
const binCfg = (b) => ({ u: b.u, v: b.v, hUnits: b.hUnits, wall: b.wall,
                         floorT: b.floorT, divX: b.divX, divY: b.divY,
                         solid: b.solid, edges: b.edges,
                         scoop: b.scoop, label: b.label, cells: b.cells,
                         /* Rail sizing is a printer setting, not a per-bin one, so it
                            rides state like arcSegs. Whether a bin HAS removable
                            dividers is per bin, so that comes off b. */
                         divRemovable: b.divRemovable, divT: state.divT, divClr: state.divClr,
                         // holes in the feet are per bin, the magnet they fit is the page's
                         magnets: b.magnets, screws: b.screws, holesEvery: b.holesEvery,
                         magnetD: state.magnetD, magnetH: state.magnetH,
                         arcSegs: state.arcSegs });
const edgeSig = (b) => EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)).join(',');
const allFullEdges = (b) => EDGES.every((k) => !b.edges || b.edges[k] === undefined || b.edges[k] >= 1);
/* Whether "every cell" puts more holes in this bin than "corners" does: not on a 1x1,
   whose four sites are all corners. Where it does not, the two are one part. */
const everyMatters = (b) => !!b.holesEvery && (b.magnets || b.screws) &&
  holeSites(Object.assign(binCfg(b), { holesEvery: false })).length !==
  holeSites(binCfg(b)).length;
/* What a bin's feet take, for the rows, the README and the panel. */
const holeCounts = (b) => {
  const n = b.magnets || b.screws ? holeSites(binCfg(b)).length : 0;
  return { magnets: b.magnets ? n : 0, screws: b.screws ? n : 0 };
};
const holesText = (b) => {
  const h = holeCounts(b);
  return [h.magnets ? plural(h.magnets, 'magnet') : '', h.screws ? plural(h.screws, 'screw') : '']
    .filter(Boolean).join(', ');
};
const typeKey = (b) => `${b.u}x${b.v}x${b.hUnits}` +
  /* The floor as built: screws raise a thinner one to the same 1.85, so two bins that
     differ only below that are one part. Without screws it is the floor as asked. */
  (b.solid ? '-solid' : `-w${b.wall}-f${builtFloorT(b)}` +
   /* A railed bin and a fixed-divider bin of the same size are DIFFERENT parts — one
      has a wall across it and the other has rails and a loose plate. Without this they
      would share a type, and therefore one STL, and you would print the wrong one. */
   (b.divX || b.divY ? `-d${b.divX}.${b.divY}${b.divRemovable ? `r${state.divT}.${state.divClr}` : ''}` : '') +
   (allFullEdges(b) ? '' : `-e${edgeSig(b)}`)) +
  (b.scoop ? `-s${b.scoop}` : '') + (b.label ? `-L${b.label}` : '') +
  (b.cells ? `-c${maskBits(b)}` : '') +
  /* A holed bin is a different part from the plain one, and from one holed for another
     magnet: the magnet's size is the page's, so it goes in from state, as the rails'
     sizes do above. */
  (b.magnets || b.screws ? `-h${feetBits({ magnets: b.magnets, screws: b.screws })}` +
    (everyMatters(b) ? 'e' : '') + (b.magnets ? `m${state.magnetD}.${state.magnetH}` : '') : '');

function occupancyOf(k) {
  const g = grid();
  const occ = Array.from({ length: g.ny }, () => new Array(g.nx).fill(-1));
  (layers[k] ? layers[k].bins : []).forEach((b, i) => {
    for (const [dx, dy] of binCells(b)) {
      const x = b.x + dx, y = b.y + dy;
      if (y >= 0 && y < g.ny && x >= 0 && x < g.nx) occ[y][x] = i;
    }
  });
  return occ;
}
const occupancy = () => occupancyOf(cur);

/* Per-cell top surface available to layer k, and whether the stack below is
   continuous. A bin can only sit where every layer beneath it has one. */
function support(k) {
  const g = grid();
  const top = Array.from({ length: g.ny }, () => new Array(g.nx).fill(0));
  const ok = Array.from({ length: g.ny }, () => new Array(g.nx).fill(true));
  for (let L = 0; L < k; L++) {
    const occ = occupancyOf(L);
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) {
        const i = occ[y][x];
        if (i === -1) ok[y][x] = false;
        else top[y][x] += layers[L].bins[i].hUnits * SPEC.unitH;
      }
  }
  return { top, ok };
}
// z of a bin's base, and whether its support is sound
function seat(b, k) {
  const s = support(k);
  let z = null, flat = true, solidBelow = true;
  for (let dy = 0; dy < b.v; dy++)
    for (let dx = 0; dx < b.u; dx++) {
      const y = b.y + dy, x = b.x + dx;
      if (!s.ok[y] || !s.ok[y][x]) { solidBelow = false; continue; }
      const t = s.top[y][x];
      if (z === null) z = t; else if (Math.abs(t - z) > 0.001) flat = false;
    }
  return { z: z === null ? 0 : z, flat, solidBelow };
}
function canPlace(x, y, u, v, ignore) {
  const g = grid();
  if (x < 0 || y < 0 || x + u > g.nx || y + v > g.ny) return false;
  const occ = occupancy();
  for (let dy = 0; dy < v; dy++)
    for (let dx = 0; dx < u; dx++) {
      const o = occ[y + dy][x + dx];
      if (o !== -1 && o !== ignore) return false;
    }
  return true;
}
// same test for a bin that may be carved: only its kept cells need to be free
function canPlaceBin(b, x, y, ignore) {
  const g = grid(), occ = occupancy();
  for (const [dx, dy] of binCells(b)) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= g.nx || py >= g.ny) return false;
    const o = occ[py][px];
    if (o !== -1 && o !== ignore) return false;
  }
  return true;
}
/* Occupied offsets within a bin's own bounding box. The clip is the invariant that
   holds everything together: a bin can never occupy a cell outside its own box. A
   resize used to leave the old mask in place, and those out-of-box cells drew nothing
   on the map yet still blocked other bins from being dropped there and still built in
   the preview — a bin you could neither see nor get rid of. */
function binCells(b) {
  if (b.cells && b.cells.length) {
    const kept = b.cells.filter(([x, y]) => x >= 0 && y >= 0 && x < b.u && y < b.v);
    if (kept.length) return kept;
  }
  const out = [];
  for (let x = 0; x < b.u; x++) for (let y = 0; y < b.v; y++) out.push([x, y]);
  return out;
}
const isCarved = (b) => binCells(b).length < b.u * b.v;

/* The one way to change a footprint. Resizing a carved bin has to reconcile the mask,
   and what carries across is the HOLES rather than the kept cells: clip the kept cells
   and growing a bin leaves its new column empty, which is not what dragging a grip
   outwards means. Carrying the holes grows and shrinks an L the way you would expect,
   and a shape whose holes swallow the whole new box falls back to a plain rectangle. */
function setFootprint(b, nu, nv) {
  if (b.cells && b.cells.length) {
    const kept = new Set(binCells(b).map((c) => c[0] + ',' + c[1]));
    const holes = new Set();
    for (let x = 0; x < b.u; x++) for (let y = 0; y < b.v; y++)
      if (!kept.has(x + ',' + y)) holes.add(x + ',' + y);
    const next = [];
    for (let x = 0; x < nu; x++) for (let y = 0; y < nv; y++)
      if (!holes.has(x + ',' + y)) next.push([x, y]);
    b.cells = next.length && next.length < nu * nv ? next : null;
  }
  b.u = nu; b.v = nv;
}
/* Cut a cell out of a bin, or put one back. Both maps carve — the drawer map by
   alt-click or carve mode, the focus map by a plain click — and the rule for what a
   click may do is subtle enough (never empty the bin; never take back a cell another
   bin now owns) that a second copy would be a fourth jointKind. Says whether it
   changed anything. */
function carveToggle(b, dx, dy) {
  if (dx < 0 || dy < 0 || dx >= b.u || dy >= b.v) return false;
  const cells = binCells(b).slice();
  const at = cells.findIndex(([a, o]) => a === dx && o === dy);
  if (at >= 0) {
    if (cells.length <= 1) return false;          // a bin with no cells is not a bin
    pushUndo(); cells.splice(at, 1); b.cells = cells;
    return true;
  }
  /* A loose bin can always take a cell back — there is no drawer, so there is nothing
     for it to collide with. Asking canPlace anyway would consult the grid at 0,0 and
     refuse cells that a bin sitting in the corner of the drawer happens to own. */
  if (b !== scratch && !canPlace(b.x + dx, b.y + dy, 1, 1, selected)) return false;
  pushUndo(); cells.push([dx, dy]);
  b.cells = cells.length === b.u * b.v ? null : cells;
  return true;
}

const allBins = () => layers.flatMap((L, k) => L.bins.map((b) => ({ b, k })));
/* What the page is currently ABOUT. Everything that lists parts — the piece table, the
   print plan, the filament estimate, the lids, the divider plates, the whole export —
   reads through types(), and types() reads through here. So focus narrows all of them
   at one line rather than at eight call sites, each of which could be forgotten
   separately and only one of which anybody would notice. */
const scoped = () => { const b = fBin(); return b ? [{ b, k: scratch ? 0 : cur }] : allBins(); };

/* ---------- geometry + volume --------------------------------------------- */
/* The key names everything the build reads, so an edit that changes a bin finds a new
   key and one that does not — a note, the infill — finds the old build. That is what
   lets the cache stay put across edits instead of being thrown away on every one. */
const geoKey = (b) => typeKey(b) + '-s' + state.arcSegs;
function geomFor(b) {
  const k = geoKey(b);
  let r = geoCache.get(k);
  if (!r) { r = buildBin(G, binCfg(b)); geoCache.set(k, r); }
  /* Read fresh every time rather than cached with the mesh: it moves with the infill
     setting, which the key deliberately leaves out, and it is arithmetic, not a build. */
  const vv = volumeMm3(b);
  r.vol = vv.filament; r.rawVol = vv.raw;
  return r;
}
/* Forget builds no bin uses any more, and hand their buffers back to the GPU. Clearing
   the caches on every edit without dispose() kept every old buffer alive: twelve bins,
   250 edits, 1757 geometries and 620 MB of GPU memory. With the cache kept, this is
   what bounds it — to the shapes actually in the drawer. */
function pruneGeometry() {
  const live = new Set(allBins().map(({ b }) => geoKey(b)));
  if (scratch) live.add(geoKey(scratch));
  for (const [k, gm] of geoCache) {
    if (live.has(k)) continue;
    if (gm.three) gm.three.dispose();
    geoCache.delete(k);
  }
}
function areaRR(hw, hd, r) { return 4 * hw * hd - (4 - Math.PI) * r * r; }
function perimRR(hw, hd, r) { return 4 * hw + 4 * hd - 8 * r + 2 * Math.PI * r; }

/* Material estimate.
 *
 * Raw mesh volume is NOT what a printer uses. Thin features (walls, floor,
 * dividers, lip) come out solid because they are only a few perimeters wide, but
 * the feet are thick blocks that the slicer shells and then infills — and on a
 * shallow bin the feet dominate. So thin parts are counted at full density and
 * the base block is counted as shell + infill x core.
 *
 * Assumes 2 perimeters (0.8 mm) and 4 solid top/bottom layers (0.8 mm), which is
 * a common default. Geometry is unaffected either way.
 */
const SHELL_T = 0.8, SKIN_T = 0.8;

function footProfileHalf(z) {
  let h = SPEC.prof[SPEC.prof.length - 1][1];
  for (let q = 0; q < SPEC.prof.length - 1; q++) {
    const [z0, h0] = SPEC.prof[q], [z1, h1] = SPEC.prof[q + 1];
    if (z >= z0 && z <= z1) { h = h0 + (h1 - h0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
  }
  return h;
}

// { raw, filament } in mm3
function volumeMm3(c) {
  const C = SPEC.centre;
  const hwO = (c.u - 1) * SPEC.pitch / 2 + SPEC.half;
  const hdO = (c.v - 1) * SPEC.pitch / 2 + SPEC.half;
  // the floor as built: screw holes raise a thin one
  const floorT = builtFloorT(c);
  const H = c.hUnits * SPEC.unitH, floorZ = SPEC.footH + floorT;
  // a carved bin has fewer feet and less floor than its bounding box implies
  const cells = binCells(c).length;
  const infill = Math.max(0, Math.min(1, (state.infill === undefined ? 15 : state.infill) / 100));

  /* base block: the feet plus the solid floor slab above them */
  let footV = 0, footLat = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const h = footProfileHalf(SPEC.footH * (i + 0.5) / N);
    footV += areaRR(h, h, h - C) * (SPEC.footH / N);
    footLat += perimRR(h, h, h - C) * (SPEC.footH / N);
  }
  footV *= cells; footLat *= cells;
  const slabH = (c.solid || floorZ >= H - 0.2) ? (H - SPEC.footH) : floorT;
  const baseRaw = footV + areaRR(hwO, hdO, SPEC.r) * slabH;
  const baseLat = footLat + perimRR(hwO, hdO, SPEC.r) * slabH;
  const botA = cells * areaRR(SPEC.prof[0][1], SPEC.prof[0][1], SPEC.prof[0][1] - C);
  const baseShell = baseLat * SHELL_T + (botA + areaRR(hwO, hdO, SPEC.r)) * SKIN_T;
  const baseFil = Math.min(baseRaw, baseShell + infill * Math.max(0, baseRaw - baseShell));

  if (c.solid || floorZ >= H - 0.2) return { raw: baseRaw, filament: baseFil };

  /* thin parts — solid whatever the infill setting */
  const e = (k) => (c.edges && c.edges[k] !== undefined ? Math.max(0, Math.min(1, c.edges[k])) : 1);
  const wall = Math.max(WALL_MIN, c.wall);        // as built: buildBin holds it there too
  const hwI = hwO - wall, hdI = hdO - wall;
  const wallsFull = (areaRR(hwO, hdO, SPEC.r) - areaRR(hwI, hdI, Math.max(0.4, SPEC.r - wall)))
                    * (H - floorZ);
  const perim = 4 * hwO + 4 * hdO;
  const wallFrac = (e('f') * 2 * hwO + e('b') * 2 * hwO + e('l') * 2 * hdO + e('r') * 2 * hdO) / perim;
  const divs = (c.divX * wall * 2 * hdI + c.divY * wall * 2 * hwI) * (H - floorZ);
  const lipV = allFullEdges(c) ? areaRR(hwO, hdO, SPEC.r) * 0.35 * LIP_H / 1.9 : 0;
  const thin = wallsFull * wallFrac + divs + lipV;
  return { raw: baseRaw + thin, filament: baseFil + thin };
}

/* ---------- controls ------------------------------------------------------ */
/* Panels are opened from two places now — the header button, and the page deciding
   you need to see something — so both go through here. The class is what actually
   shows the body and aria-expanded is what says so; anything that sets one without
   the other leaves a panel that is open to the eye and shut to a screen reader. */
function setPanel(id, open) {
  const sec = $(id);
  sec.classList.toggle('closed', !open);
  const btn = sec.querySelector(':scope>h2>button');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}
/* Both of these open a panel on an EDGE — when there was nothing to see and now there
   is — rather than on every draw. Re-asserting it on each keystroke would mean a panel
   you closed on purpose sprang open again the next time you typed, which is a worse
   interface than the one this is fixing. */
let hadSelection = false;
let hadErrors = false;

/* ---------- the bin sheet (phone) -----------------------------------------
   On a phone the selected bin's settings are a sheet over the foot of the screen with
   the map above it, instead of panel 03 opening 1,500 px of settings above the map (the
   rules, and the reason, are in style.css). This keeps the class that makes it a sheet
   in step with the selection, and does the three things the stylesheet cannot. */
const PHONE = matchMedia('(max-width: 980px)');
let sheetWas = false, sheetReveal = false;
function applySheet() {
  /* A new bin drawn on the map above the sheet starts by letting go of the selection
     (pointerdown), and with nothing selected the sheet would go — mid-drag. Put away,
     panel 03 drops back into the column above the map and moves the map down under a
     finger that is still on it, so a drag from row 3 to row 5 made a bin four or five rows
     deep. So a sheet that was up stays up while a bin is being drawn; the release selects
     the new bin, which keeps it up, or places nothing, which puts it away then. */
  const on = !focused && (selAll().length > 0 ||
    (!!drag && drag.mode === 'create' && sheetWas));
  /* Put away, the panel's header goes back into the column above the map and pushes the
     map down by its height, under whatever you were looking at, or under the finger that
     has just let go of a drag. So the map is held where it is: measured before, and the
     page scrolled by however far it moved. Not on the way into single-bin mode, which
     hides the map. Done here, at once, because scroll anchoring will not: the padding the
     sheet gives the page's foot comes off in the same change, and a change of padding on
     an element round the anchor is one the browser declines to correct for. */
  const map = $('fillmap');
  const held = PHONE.matches && sheetWas && !on && !focused && map.getClientRects().length
    ? map.getBoundingClientRect().top : null;
  document.body.classList.toggle('binsheet', on);
  if (PHONE.matches && on !== sheetWas) {
    /* Opening, the sheet comes up over the bottom half of the screen, which is where the
       bin you just tapped may well be. Not while a finger is still dragging it: the page
       moving under a drag would move the bin. The release redraws, and comes back here. */
    if (on) sheetReveal = true;
    /* Put away, the panel goes back into the column above the map, and open it would be
       the 1,500 px the sheet exists to keep out of the way — so it goes back folded, as
       the page first showed it. Not on the way into single-bin mode, which is about
       nothing but this panel. */
    else if (!focused) setPanel('s-bin', false);
  }
  sheetWas = on;
  if (held !== null) scrollBy(0, map.getBoundingClientRect().top - held);
  /* Two frames on, not one. The panel leaving the column (it was in it in single-bin
     mode, all 1,500 px of it, above the map) moves everything under it, and the browser's
     scroll anchoring corrects for that in the frame's own update, after a callback in the
     first frame has already measured the page as it was. */
  if (sheetReveal && !drag) {
    sheetReveal = false;
    requestAnimationFrame(() => requestAnimationFrame(revealSelected));
  }
}
/* Scroll the selected bin clear of the sheet, without pushing the top of it under the
   section bar. The bin's box comes from the map's own transform (see cellFromEvent). */
function revealSelected() {
  const b = selected >= 0 ? B()[selected] : null;
  if (!b || !document.body.classList.contains('binsheet')) return;
  const svg = $('fillmap'), m = svg.getScreenCTM && svg.getScreenCTM();
  if (!m || !svg.getClientRects().length) return;
  const g = grid(), p = svg.createSVGPoint();
  p.x = 0; p.y = (g.ny - b.y - b.v) * S; const top = p.matrixTransform(m).y;
  p.y = (g.ny - b.y) * S; const bottom = p.matrixTransform(m).y;
  /* Where the sheet's top will be, not where it is: it is still sliding up at this point,
     and a transform moves the box getBoundingClientRect reports. It sits on the bottom of
     the window, so its height is enough. */
  const sheetTop = innerHeight - $('s-bin').offsetHeight - 12;
  /* the bar's height, not where it is now: it comes down once the header has scrolled away,
     which the scroll below may well be what does */
  const bar = $('jumpbar').offsetHeight + 8;
  if (bottom > sheetTop) scrollBy(0, Math.min(bottom - sheetTop, top - bar));
  // or scrolled past it — leaving single-bin mode brings the map back above the fold
  else if (top < bar) scrollBy(0, top - bar);
}
/* Size, height and dividers are what a bin gets changed for, and a sheet has room for a
   few rows before it scrolls, so on a phone the dividers come up under the height. Moved
   in the document rather than reordered with CSS, so that Tab goes the way the eye does;
   and moved back on a wider window, where the panel is the rail's and does not change. */
function placeDividers() {
  const after = PHONE.matches ? $('binSizeHint') : $('thickRow');
  if (after.nextElementSibling !== $('divRow')) after.after($('divRow'), $('divHint'));
}
PHONE.addEventListener('change', placeDividers);
placeDividers();
function closeSheet() {
  const inside = $('s-bin').contains(document.activeElement);
  /* What was typed a moment ago is still waiting for its redraw (schedule, below), and
     landing after the selection has gone it would go to the next bin drawn instead of
     this one: so it lands now, while the bin is still the selected one. Escape straight
     after typing a note was the case that lost it. */
  clearTimeout(timer); readControls();
  clearSel(); readControls(); drawMap(); refresh();
  /* The X has gone with the sheet, and focus with it unless it is put somewhere: on the
     panel's own header, folded back into the column, which is where the sheet went. */
  if (inside) $('s-bin').querySelector(':scope>h2>button').focus({ preventScroll: true });
}
$('binSheetClose').addEventListener('click', closeSheet);

/* ---------- single-bin focus ----------------------------------------------
   The one place that says what focus mode looks like. It sets a class and lets the
   stylesheet do the hiding, for the reason written above that CSS block: this
   function already makes twenty-five show/hide decisions, and a mode whose restore
   is twenty-five assignments the other way is a mode that eventually half-restores.

   It also RE-VALIDATES the mode on every draw. The focused bin can stop existing
   under you — Delete, an undo, a layer removed, a split that replaces it with four —
   and every one of those routes already ends in readControls(). Checking here means
   none of them has to remember to, and the mode falls away instead of pointing at a
   bin that is gone. */
function applyFocus() {
  if (focused && !fBin()) leaveFocus(true);
  const on = focused;
  document.body.classList.toggle('binfocus', on);
  document.body.classList.toggle('binscratch', !!scratch);
  document.body.classList.toggle('focuscarve', on && carving);
  const one = selAll().length === 1;
  $('focusBin').style.display = !on && one ? '' : 'none';
  $('focusBinHint').style.display = !on && one ? '' : 'none';
  /* Offered with nothing selected, which is when panel 03 describes the next bin you
     would draw rather than one that exists. With a bin selected the slot belongs to
     the focus button above. */
  const none = !on && selAll().length === 0;
  $('scratchBin').style.display = none ? '' : 'none';
  $('scratchBinHint').style.display = none ? '' : 'none';
  /* Both pairs of undo buttons, every pass. There are two histories now and switching
     between them changes what the buttons should say without touching either stack —
     so leaving it to the callers meant discardScratch, which clears the loose bin's
     stack and hands the page back to the drawer's, left the drawer's Undo greyed out
     with a full stack behind it. Nothing has to remember to call this any more. */
  updateUndoButtons();
  if (!on) return;
  const b = fBin();
  $('focusName').textContent = `${b.u}×${b.v}×${b.hUnits}` + (b.note ? ` — ${b.note}` : '');
  $('focusWhere').textContent = scratch ? 'not in the drawer'
    : `column ${b.x + 1}, row ${b.y + 1}` + (layers.length > 1 ? `, layer ${cur + 1}` : '');
  /* Worked out every draw, so the answer is on the button before you press it rather
     than in a message after. A bin that cannot land says why, and the reason changes
     as you change the size — which is the thing that would fix it. */
  if (scratch) {
    drawScratchLayers();
    const spot = scratchLanding();
    $('scratchAdd').disabled = !!spot.why;
    $('scratchWhy').classList.toggle('no', !!spot.why);
    $('scratchWhy').textContent = spot.why ||
      `goes in at column ${spot.x + 1}, row ${spot.y + 1} of layer ${cur + 1}`;
  }
  /* drawMap() writes an inline grid-template-columns on .stagetop sized to the map,
     and an inline style beats the class rule that widens the preview — the same trap
     its own comment describes for the mobile breakpoint. The map card is gone here, so
     the measurement it left behind has to go with it, or the preview stays pinned to a
     column shaped like a map that is no longer on the page. */
  const top = document.querySelector('.stagetop');
  if (top) {
    top.style.gridTemplateColumns = '';
    top.classList.remove('wide', 'paired');   // see DF.stageRow for what .paired does
  }
}
/* Frame the bin, not the drawer. The drawer's framing would put a 1×1 bin in the
   middle distance as a speck — the mode looking broken at the exact moment it opens.

   The framing itself is done by autoFrame() on the next draw, because the bin is the
   subject of the frame key in focus and the key has just changed. All this has to do is
   put the drawer's view somewhere safe and let the page frame again, whatever had been
   done to the drawer's view: a zoom into one corner of the drawer means nothing for a
   bin on its own. The angle carries over, as it always did. What comes back on the way
   out is the whole view, including whose it was — a drawer view you had zoomed stays
   yours, and one the page framed is framed again if the canvas changed shape meanwhile,
   which leaving focus does, since the map comes back and takes its column. */
function restoreView() {
  if (!savedView) return;
  theta = savedView.theta; phi = savedView.phi; dist = savedView.dist;
  panX = savedView.panX; panZ = savedView.panZ; lookY = savedView.lookY;
  viewOwned = savedView.owned; framedKey = savedView.key;
  savedView = null;
}
function frameBin() {
  savedView = savedView ||
    { theta, phi, dist, panX, panZ, lookY, owned: viewOwned, key: framedKey };
  viewOwned = false;
}
/* Where a loose bin would go if you added it now: the first free spot on the layer you
   were last editing, scanned front-left first because that is the corner the map draws
   at its origin and the one people fill first. Returns the reason instead when there
   is nowhere — the two failures are different and want different sentences. */
function scratchLanding() {
  const b = scratch, g = grid();
  if (!b) return { why: 'no bin' };
  if (b.u > g.nx || b.v > g.ny)
    return { why: `a ${b.u}×${b.v} bin does not fit the ${g.nx}×${g.ny} grid — make it smaller, or the drawer bigger` };
  const sup = support(cur);
  for (let y = 0; y <= g.ny - b.v; y++)
    for (let x = 0; x <= g.nx - b.u; x++) {
      if (!canPlace(x, y, b.u, b.v, -1)) continue;
      /* Upper layers need level, continuous support underneath, the same rule the
         drag-to-place path applies — a bin dropped onto a step would rock. */
      if (cur > 0) {
        const st = seat({ x, y, u: b.u, v: b.v }, cur);
        if (!st.flat || !st.solidBelow) continue;
      }
      return { x, y };
    }
  return { why: `no free ${b.u}×${b.v} space on layer ${cur + 1} — clear some cells, or add a layer` };
}
function enterFocus() {
  if (!(selected >= 0 && B()[selected])) return;
  selExtra.clear();          // focus is one bin; a companion selection means nothing here
  focused = true; carving = false; scratch = null;
  const b = B()[selected];
  frameBin();
  setPanel('s-bin', true);
  $('focusSay').textContent =
    `Editing the ${b.u} by ${b.v} bin on its own. The drawer, the layers and the map are hidden.`;
  writeControls(b);
  readControls(); drawMap(); refresh();
}
/* quiet is for the call inside applyFocus, which is already mid-redraw: redrawing from
   in there would recurse through readControls and back into this function. */
function leaveFocus(quiet) {
  if (!focused) return;
  /* A loose bin has nowhere to go back TO. Leaving would have to either place it or
     throw it away, and guessing which is not a choice worth making on somebody's
     behalf — so the two explicit buttons are the only ways out and this refuses. */
  if (scratch) return;
  focused = false; carving = false;
  restoreView();
  $('focusSay').textContent = 'Back to the whole drawer.';
  if (!quiet) { readControls(); drawLayerTabs(); drawMap(); refresh(); }
}
/* Design one bin, with no drawer around it.
 *
 * Born from the "New bins" settings rather than from the tool's defaults: that panel is
 * where you have just said what you want, and starting over from 1×1×3 would throw it
 * away. x and y are zeroes it never reads — they exist so the bin is the same SHAPE of
 * object as a placed one, which is what lets the preview, the piece table, the plan and
 * the export take it without knowing which kind it is. */
function startScratch() {
  clearSel();
  scratch = { x: 0, y: 0, u: state.u, v: state.v, hUnits: state.hUnits,
              wall: state.wall, floorT: state.floorT,
              divX: state.divX, divY: state.divY, solid: state.solid,
              scoop: state.scoop, label: state.label, note: '',
              magnets: state.magnets, screws: state.screws, holesEvery: state.holesEvery,
              edges: Object.assign({}, state.edges) };
  sUndoStack.length = 0; sRedoStack.length = 0;
  focused = true; carving = false;
  frameBin();
  setPanel('s-bin', true);
  $('focusSay').textContent =
    `Designing a ${scratch.u} by ${scratch.v} bin on its own. There is no drawer and no map.`;
  writeControls(scratch);
  readControls(); drawMap(); refresh();
}
/* Put it in the drawer after all. The bin stops being loose BEFORE the undo is pushed,
   so the snapshot is the drawer's and lands on the drawer's stack — pushing it while
   scratch was still set would file "the drawer without this bin" under the loose bin's
   history, where the drawer's undo button would never find it. */
function addScratchToDrawer() {
  const spot = scratchLanding();
  if (spot.why) return;                       // the button is disabled, but not only here
  const b = Object.assign({}, scratch, { x: spot.x, y: spot.y });
  scratch = null;
  sUndoStack.length = 0; sRedoStack.length = 0;
  pushUndo();
  B().push(b);
  focused = false; carving = false;
  restoreView();
  selected = B().length - 1; B()[selected].sel = true;
  $('focusSay').textContent =
    `Added to the drawer at column ${spot.x + 1}, row ${spot.y + 1}.`;
  writeControls(B()[selected]);
  readControls(); drawLayerTabs(); drawMap(); refresh();
}
function discardScratch() {
  scratch = null;
  sUndoStack.length = 0; sRedoStack.length = 0;
  focused = false; carving = false;
  restoreView();
  $('focusSay').textContent = 'Discarded. Back to the whole drawer.';
  readControls(); drawLayerTabs(); drawMap(); refresh();
}
$('focusBin').addEventListener('click', enterFocus);
for (const id of ['scratchBin', 'scratchBinMap', 'scratchBinTop'])
  $(id).addEventListener('click', startScratch);
$('scratchAdd').addEventListener('click', addScratchToDrawer);
$('scratchDrop').addEventListener('click', discardScratch);
$('focusExit').addEventListener('click', () => leaveFocus());
$('focusUndo').addEventListener('click', () => undo());
$('focusRedo').addEventListener('click', () => redo());

/* The drawer's own measurements: the fields the unit switch in panel 01 converts. The
   baseplate height is not one — it is a spec figure the baseplates page hands across,
   not something anyone measures — and neither is anything about the printer or a bin,
   all of which are quoted in millimetres whatever the drawer was measured in.
   FIELDS.lengthOf hands back millimetres from either unit, so `state` and everything
   downstream of it never learn which one was typed. */
const LENGTH_IDS = ['drawerW', 'drawerD', 'drawerH', 'drawerFrontH'];
let unit = 'mm';   // what the length fields are showing; the saved choice is applied at boot

/* A typed value held to its field's own min and max, so each limit is written in one
   place and the spinner stops where the clamp does. The limits are the ones a shared
   link is held to, so nothing can be typed that the page's own link would not carry
   back. A negative floor used to reach the geometry and the link, and a 100 mm wall
   built inside out and weighed -430 g. A drawer length is clamped in millimetres: its
   field shows its limits in inches too when it does, and keeps the millimetres beside
   them (FIELDS.convert). */
function fieldClamp(id, x) {
  const el = $(id), mm = (k, attr) => parseFloat(k in el.dataset ? el.dataset[k] : el[attr]);
  const lo = mm('minMm', 'min'), hi = mm('maxMm', 'max');
  return Math.min(isFinite(hi) ? hi : Infinity, Math.max(isFinite(lo) ? lo : -Infinity, x));
}
const BIN_FIELDS = ['u', 'v', 'hUnits', 'wall', 'floorT', 'divX', 'divY', 'scoop', 'label'];
/* The magnet size nobody has set: the baseplate's, when the link brought one, since the
   magnets bought for the plate are the ones going into the bins; else 6 x 2. Held to the
   fields' limits, as a typed size is. The link carries the bins' own size only when it
   differs from this, so until someone sets one the bins follow the plate. */
function magnetDefault() {
  const pick = (k, id, d) => {
    const v = hashExtras[k], x = Number(v);
    return fieldClamp(id, v !== undefined && v !== '' && isFinite(x) ? x : d);
  };
  return { d: pick('md', 'magnetD', 6), h: pick('mh', 'magnetH', 2) };
}
/* The most dividers that fit across a bin `cells` wide: as many as leave every
   compartment at least one wall thick, never counting a wall as thinner than a 1.2 mm
   rail. The link uses the same rule. */
const mostDividers = (cells, wall) => Math.max(0,
  Math.floor(((cells - 1) * SPEC.pitch + 2 * SPEC.half - 2 * wall) / Math.max(wall, RAIL_T)) - 1);
/* The limits that depend on the bin itself, written onto the fields: the floor and the
   scoop up to the bin's height, the label shelf up to its depth, the dividers up to
   what fits across. */
function setBinLimits(u, v, hUnits, wall) {
  const H = hUnits * SPEC.unitH;
  $('floorT').max = H; $('scoop').max = H;
  $('label').max = v * SPEC.pitch;
  $('divX').max = mostDividers(u, wall); $('divY').max = mostDividers(v, wall);
}

function readControls() {
  const num = (id, d) => { const x = parseFloat($(id).value); return isFinite(x) ? x : d; };
  const int = (id, d) => { const x = parseInt($(id).value, 10); return isFinite(x) ? x : d; };
  /* Counts are rounded, not truncated: parseInt read "2.7" dividers as 2 and "1e3" as 1. */
  const count = (id, d) => fieldClamp(id, Math.round(num(id, d)));
  const len = (id, d) => { const x = FIELDS.lengthOf($(id), unit); return isFinite(x) ? x : d; };
  /* Only the drawer's own fields are shown in inches. The wall, floor, scoop, label and
     bed stay in millimetres whatever the unit, so reading them as lengths took a 1.2 mm
     wall for 1.2 in: clamped to 10 mm, with a floor filling the bin and a 256 mm bed
     read as 256 in and held at 2000 mm. */
  const mm = (id, d) => fieldClamp(id, LENGTH_IDS.includes(id) ? len(id, d) : num(id, d));
  drawerAsked = { w: len('drawerW', 306), d: len('drawerD', 380) };
  state.drawerW = mm('drawerW', 306);
  state.drawerD = mm('drawerD', 380);
  state.drawerH = mm('drawerH', 84);
  state.plateH = num('plateH', 4.25);
  state.showDrawer = $('showDrawer').checked;
  state.drawerFrontH = len('drawerFrontH', 0);
  state.arcSegs = int('arcSegs', 12);
  state.infill = num('infill', 15);
  /* Page-level, not per bin: how thick a divider plate is and how much slack its slot
     leaves are properties of your printer, the same as arcSegs. Which bins HAVE
     removable dividers is per bin and rides `t` above. */
  state.divT = Math.max(0.8, Math.min(5, num('divT', 1.6)));
  state.divClr = Math.max(0, Math.min(1, num('divClr', 0.25)));
  /* Page-level too: one drawer, one kind of magnet. Held to the fields' limits, which
     are what the engine builds, and the box shows the size in use once it is left. */
  const md = magnetDefault();
  state.magnetD = fieldClamp('magnetD', num('magnetD', md.d));
  state.magnetH = fieldClamp('magnetH', num('magnetH', md.h));
  for (const id of ['magnetD', 'magnetH'])
    if (document.activeElement !== $(id) && parseFloat($(id).value) !== state[id]) $(id).value = state[id];
  state.bedW = mm('bedW', 256);
  state.bedD = mm('bedD', 256);
  state.bedH = mm('bedH', 256);
  state.gap = num('gap', 3);

  const t = {
    u: count('u', 1), v: count('v', 1),
    hUnits: count('hUnits', 3),
    wall: mm('wall', 1.2),
    solid: $('solid').checked,
    /* By character, not by UTF-16 unit: slicing units cut an emoji in half and left a
       lone surrogate in the note, the link and the README. */
    note: [...$('note').value].slice(0, 28).join(''),
    divRemovable: $('divRemovable').checked,
    lid: $('lid').checked,
    magnets: $('magnets').checked, screws: $('screws').checked,
    holesEvery: $('holesWhere').value === 'every',
    lidSides: { f: $('lidF').checked, b: $('lidB').checked,
                l: $('lidL').checked, r: $('lidR').checked },
    edges: { f: parseFloat($('edgeF').value), b: parseFloat($('edgeB').value),
             l: parseFloat($('edgeL').value), r: parseFloat($('edgeR').value) },
  };
  /* Deliberately not part of `t`. Whether a bin has been printed is a fact about the
     world, not a design setting, and `t` is the settings object — bulk-assigned to the
     selection and then copied into `state`, the template for the next bin drawn.

     Being honest about how much that buys today: new bins are built from an explicit
     field list further down, so `done` could not leak through `state` even if it were
     in `t`. Keeping it out matters the day that construction becomes a spread of
     `state`, which is a very ordinary tidy-up to make — and then a flag in `t` would
     have every bin drawn after a mark born already printed. print-queue.spec.js fails
     on exactly that pair of changes. */
  const sel = selAll();
  const b = !scratch && sel.length ? B()[selected] : null;
  /* The footprint is settled first: the floor, the label shelf and the dividers are
     limited by the bin's real size, so they wait for it. A loose bin has no drawer to
     collide with, so its footprint is held only by the fields' own 50 cells — with no
     limit at all a 100×100 took 14 s to rebuild on every keystroke — and Checks and the
     Add button say when it is too big for the bed or the grid. */
  if (!scratch && sel.length > 1) {
    /* Footprint is per bin and must never be bulk-assigned. Writing the primary's
       size onto the others silently resized every bin in the selection to match it,
       which quietly destroyed their shapes. */
    delete t.u; delete t.v;
    $('u').value = b.u; $('v').value = b.v;
  } else if (b && (t.u !== b.u || t.v !== b.v) && !canPlace(b.x, b.y, t.u, t.v, selected)) {
    t.u = b.u; t.v = b.v; $('u').value = b.u; $('v').value = b.v;
  }
  /* Several bins take the same settings, so the smallest of them sets the limit: the
     dividers that fit a 1x1 are the most any of them can be given. */
  const sizes = sel.length > 1 && !scratch ? sel.map((i) => B()[i]) : [t];
  setBinLimits(Math.min(...sizes.map((x) => x.u)), Math.min(...sizes.map((x) => x.v)),
               t.hUnits, t.wall);
  Object.assign(t, { floorT: mm('floorT', 1.2), scoop: mm('scoop', 0), label: mm('label', 0),
                     divX: count('divX', 0), divY: count('divY', 0) });
  /* Show the value actually used once you have left the field: typed past a limit, the
     box would otherwise go on saying 100 while the bin is built at 10. Never under the
     caret, where emptying the box to type a new number would have it filled back in
     before the first digit landed. */
  for (const id of BIN_FIELDS)
    if (t[id] !== undefined && document.activeElement !== $(id) && parseFloat($(id).value) !== t[id])
      $(id).value = t[id];
  /* Whether a bin has been printed is a fact about one sitting in the drawer. A loose
     bin is not in a drawer, so the question does not arise. */
  $('doneRow').style.display = sel.length && !scratch ? '' : 'none';
  const anyDiv = t.divX > 0 || t.divY > 0;
  $('divRemovableRow').style.display = anyDiv ? '' : 'none';
  $('divRemovableHint').style.display = anyDiv && $('divRemovable').checked ? '' : 'none';
  if (scratch) {
    /* u and v still go through setFootprint, because a carved shape has to reconcile
       its mask whichever kind of bin it is. */
    const nu = t.u, nv = t.v; delete t.u; delete t.v;
    noteSettingsEdit([scratch], t, nu, nv);
    Object.assign(scratch, t, { edges: Object.assign({}, t.edges) });
    if (nu !== undefined && (nu !== scratch.u || nv !== scratch.v))
      setFootprint(scratch, nu, nv);
  } else if (sel.length) {
    /* u and v never ride the bulk assign — a footprint change has to reconcile the
       carve mask, so it goes through setFootprint. */
    const nu = t.u, nv = t.v; delete t.u; delete t.v;
    noteSettingsEdit(sel.map((i) => B()[i]), t, nu, nv);
    for (const i of sel) Object.assign(B()[i], t, { edges: Object.assign({}, t.edges) });
    if (sel.length === 1 && nu !== undefined && (nu !== b.u || nv !== b.v))
      setFootprint(b, nu, nv);
  } else {
    Object.assign(state, t);
  }
  /* A lid needs a lip to grip, and a lowered wall takes the lip away. Say which it is
     rather than hiding the control, or ticking it and getting nothing looks like a bug.
     A carved bin keeps its lip, but the lid is a rectangle: it would hang over the cells
     cut away, so it is not made for one either, and that gets its own sentence. */
  const lipOk = EDGES.every((k) => !t.edges || !isFinite(t.edges[k]) || t.edges[k] >= 1);
  const target = scratch || (sel.length ? B()[selected] : null);
  const carvedNow = !!target && isCarved(target);
  $('lidRow').style.display = t.solid ? 'none' : '';
  $('lidNoLip').style.display = !t.solid && !lipOk && $('lid').checked ? '' : 'none';
  $('lidCarved').style.display = !t.solid && lipOk && carvedNow && $('lid').checked ? '' : 'none';
  $('lidHint').style.display = !t.solid && lipOk && !carvedNow && $('lid').checked ? '' : 'none';
  /* The feet. "Where" and the count only mean something once there are holes, and each
     hint says what its holes are for, so each shows with its box. */
  const holes = t.magnets || t.screws;
  $('holesWhereRow').style.display = holes ? '' : 'none';
  $('magnetHint').style.display = t.magnets ? '' : 'none';
  $('screwHint').style.display = t.screws ? '' : 'none';
  $('magnetSize').textContent = `${state.magnetD} x ${state.magnetH}`;
  const holed = target || Object.assign({}, state, t);
  $('holeCount').style.display = holes ? '' : 'none';
  $('holeCount').textContent = !holes ? ''
    : (!target ? `A new ${holed.u} by ${holed.v} bin takes `
       : sel.length > 1 && !scratch ? 'The first of these bins takes ' : 'This bin takes ') +
      holesText(holed) + '.';
  // the front measurement is only worth asking for once the drawer is being drawn
  $('drawerFrontRow').style.display = state.showDrawer ? '' : 'none';
  $('drawerViewHint').style.display = state.showDrawer ? '' : 'none';
  $('thickRow').style.display = t.solid ? 'none' : '';
  $('divRow').style.display = t.solid ? 'none' : '';
  $('edgeRowA').style.display = t.solid ? 'none' : '';
  $('edgeRowB').style.display = t.solid ? 'none' : '';
  $('edgeHint').style.display = t.solid ? 'none' : '';
  $('featureRow').style.display = t.solid ? 'none' : '';
  $('featureHint').style.display = t.solid ? 'none' : '';
  $('presetTray').style.display = t.solid ? 'none' : '';
  $('selActions').style.display = selected >= 0 ? '' : 'none';
  $('sizeRow').style.display = selAll().length > 1 ? 'none' : '';
  /* Carving needs exactly one bin to carve. A loose bin IS exactly one bin — it just
     is not a selection, so counting the selection would have hidden the Carve button
     in the one mode built around a single bin. */
  const one = !!scratch || selAll().length === 1;
  if (!one) carving = false;
  $('carveMode').style.display = one ? '' : 'none';
  $('carveHint').style.display = one && carving ? '' : 'none';
  $('carveMode').classList.toggle('on', carving);
  $('fillmap').classList.toggle('carving', carving);
  $('carveMode').textContent = carving ? 'Done carving' : 'Carve this bin into a shape';
  $('mergeBins').style.display = selAll().length > 1 ? '' : 'none';
  $('mergeHint').style.display = selAll().length > 1 ? '' : 'none';
  const selBin = selected >= 0 ? B()[selected] : null;
  const needsSplit = !!selBin && !fitsBed(selBin.u, selBin.v) && !!splitPlan(selBin.u, selBin.v);
  $('splitFit').style.display = needsSplit ? '' : 'none';
  $('splitHint').style.display = needsSplit ? '' : 'none';
  if (needsSplit) {
    const sp = describeSplit(selBin.u, selBin.v);
    $('splitFit').textContent = `Split into ${sp.text} to fit the bed`;
  }
  const nSel = selAll().length;
  $('binPanelTitle').textContent = scratch ? 'This bin'
    : nSel > 1 ? `${plural(nSel, 'bin')} selected`
    : nSel === 1 ? 'Selected bin' : 'New bins';
  /* The panel ships closed, so selecting a bin has to open it or its settings are
     behind a click that nothing asks you to make. */
  if (nSel && !hadSelection) setPanel('s-bin', true);
  hadSelection = nSel > 0;
  $('fillSize').textContent = `${state.u}×${state.v}`;
  $('delLayer').style.display = layers.length > 1 ? '' : 'none';
  /* The cell fields are a second way to say the drawer size, so they follow it —
     except while they are being typed into, where rewriting the value under the
     caret turns "12" into "1". */
  const g = grid();
  if (document.activeElement !== $('gridX')) $('gridX').value = g.nx;
  if (document.activeElement !== $('gridY')) $('gridY').value = g.ny;
  /* And they stop where the drawer does: the most cells is what a drawer at the cap holds
     once the plate's margins are off it, so the spinner stops where the written drawer
     stops growing (see the fields' input handler). It was GRID_MAX whatever the margins,
     which spun on past the room they leave. */
  const top = plateCells(DRAWER_MAX, DRAWER_MAX);
  $('gridX').max = top.nx; $('gridY').max = top.ny;
  /* Last, so it sees the selection this pass settled on — and so the one class that
     decides what focus hides is applied after every other visibility decision above,
     rather than being quietly undone by one of them. */
  applyFocus();
  // and whether this is a sheet on a phone follows from the selection and the mode
  applySheet();
}
function writeControls(src) {
  $('u').value = src.u; $('v').value = src.v; $('hUnits').value = src.hUnits;
  $('wall').value = src.wall; $('floorT').value = src.floorT;
  $('divX').value = src.divX; $('divY').value = src.divY;
  $('solid').checked = !!src.solid;
  $('scoop').value = src.scoop || 0; $('label').value = src.label || 0;
  $('done').checked = !!src.done;
  $('divRemovable').checked = !!src.divRemovable;
  $('lid').checked = !!src.lid;
  $('magnets').checked = !!src.magnets; $('screws').checked = !!src.screws;
  $('holesWhere').value = src.holesEvery ? 'every' : 'corners';
  for (const [id, k] of [['lidF', 'f'], ['lidB', 'b'], ['lidL', 'l'], ['lidR', 'r']])
    $(id).checked = !src.lidSides || src.lidSides[k] !== false;
  $('note').value = src.note || '';
  for (const [k, id] of [['f', 'edgeF'], ['b', 'edgeB'], ['l', 'edgeL'], ['r', 'edgeR']])
    $(id).value = String(src.edges && src.edges[k] !== undefined ? src.edges[k] : 1);
}

/* ---------- layers -------------------------------------------------------- */
function drawLayerTabs() {
  const bar = $('layerTabs');
  bar.innerHTML = '';
  layers.forEach((L, i) => {
    const b = document.createElement('button');
    b.textContent = `Layer ${i + 1}` + (L.bins.length ? ` · ${L.bins.length}` : '');
    if (i === cur) b.className = 'on';
    b.addEventListener('click', () => {
      cur = i; clearSel(); readControls(); drawLayerTabs(); drawMap(); refresh();
    });
    bar.appendChild(b);
  });
}
/* The drawer's layer tabs live inside #s-layout, which focus hides wholesale, so a loose
   bin had no way to answer the refusal that told it to pick another layer. This is the
   same choice in the shape that fits a one-line bar. Rebuilt only when what it shows
   actually changes: it is written on every refresh, and replacing the options under a
   select the keyboard is inside would drop focus mid-choice. The key carries every
   layer's bin count, not just how many layers there are, because the count is what the
   options say — a key without it left a layer that had since filled up reading "empty"
   the next time a loose bin was started. */
let scratchLayerKey = '';
function drawScratchLayers() {
  const sel = $('scratchLayer'), key = cur + '/' + layers.map((L) => L.bins.length).join(',');
  if (key === scratchLayerKey) return;
  scratchLayerKey = key;
  sel.innerHTML = '';
  layers.forEach((L, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `Layer ${i + 1}` + (L.bins.length ? ` · ${L.bins.length}` : ' · empty');
    if (i === cur) o.selected = true;
    sel.appendChild(o);
  });
}
/* Switching the target layer is not an edit — it changes where the bin WOULD go, and the
   drawer's own layer tabs do not bank an undo entry for the same choice either. refresh()
   re-runs scratchLanding, so the reason under the button answers the new layer straight
   away rather than keeping the old one's. It does move the drawer's own current layer,
   so Discard comes back to the layer you picked: that is where the bin was going. */
$('scratchLayer').addEventListener('change', (e) => {
  const i = parseInt(e.target.value, 10);
  if (!(i >= 0 && i < layers.length)) return;
  cur = i;
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('scratchAddLayer').addEventListener('click', () => {
  pushDrawerUndo();
  layers.push({ bins: [] });
  cur = layers.length - 1;
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('addLayer').addEventListener('click', () => {
  pushUndo();
  layers.push({ bins: [] });
  cur = layers.length - 1; clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('delLayer').addEventListener('click', () => {
  if (layers.length < 2) return;
  pushUndo();
  layers.splice(cur, 1);
  cur = Math.min(cur, layers.length - 1); clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});

/* ---------- the map ------------------------------------------------------- */
let drag = null;
/* The focus map's cell size. Bigger than the drawer map's because it is showing one
   bin instead of sixty-three cells, and the reason carving on the drawer map is
   awkward is that a 1×1 bin there is a 40 px square. */
const FS = 64;
/* One bin's own cells, and nothing else. Absent unless you press Carve — asked for
   that way, so the default focus view is the settings and the preview with nothing
   between them. */
function drawFocusMap() {
  const svg = $('focusmap');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const b = fBin();
  if (!b) return;
  const W = b.u * FS, H = b.v * FS;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  /* Sized from the stage for the same reason the drawer map is: measuring its own
     container, whose width this drawing helps decide, makes each depend on the other. */
  const CAP = 88, stage = document.querySelector('.stage');
  const availW = Math.max(160, (stage ? stage.clientWidth : 900) - 400);
  const sc = Math.min(availW / W, 440 / H, CAP / FS);
  svg.setAttribute('width', Math.round(W * sc));
  svg.setAttribute('height', Math.round(H * sc));
  const on = new Set(binCells(b).map(([x, y]) => x + ',' + y));
  const el = (n, a) => { const e = document.createElementNS(SVGNS, n);
    for (const k in a) e.setAttribute(k, a[k]); return e; };
  for (let dy = 0; dy < b.v; dy++)
    for (let dx = 0; dx < b.u; dx++) {
      const here = on.has(dx + ',' + dy);
      /* A gap the drawer will not give back, because another bin has taken the cell
         since it was carved. Marked rather than left to a click that does nothing.
         A loose bin is never blocked: it is not in the drawer, so consulting the grid
         at 0,0 would grey out whatever a bin in that corner happens to own — and the
         cell would then get no click handler either, which is a carve grid that
         silently refuses half its cells. The same test guards carveToggle. */
      const blocked = !here && b !== scratch &&
        !canPlace(b.x + dx, b.y + dy, 1, 1, selected);
      const r = el('rect', {
        class: 'fcell' + (here ? ' on' : blocked ? ' blocked' : ' off'),
        /* dy 0 is the FRONT of the bin and is drawn at the bottom, the same way the
           drawer map flips its rows — the two maps carry the same "▾ front" marker and
           must not disagree about which end it points at. */
        x: dx * FS, y: (b.v - dy - 1) * FS, width: FS, height: FS, rx: 4 });
      if (!blocked)
        r.addEventListener('click', () => {
          if (carveToggle(b, dx, dy)) { readControls(); drawMap(); refresh(); }
        });
      svg.appendChild(r);
    }
  svg.setAttribute('aria-label',
    `The ${b.u} by ${b.v} cells of this bin, ${plural(binCells(b).length, 'cell')} kept. ` +
    'Click a cell to cut it out, click a gap to put it back.');
  /* Hug the grid rather than stretch around it, the same way drawMap sizes its own
     column. Without this the `auto` track grew to half the stage and a 2×3 bin sat as
     six cells adrift in an empty card. applyFocus() clears this on every pass — which
     is right, because the default focus view has no map at all — so it is re-stated
     here, and only while carving. Asking the element how many tracks it actually got
     keeps the 1280 px breakpoint in the stylesheet, where drawMap leaves it too — the
     same DF.stageRow, which also tells the preview how much stage it has when it is
     alone in the row, as it is for the rest of focus. */
  const top = document.querySelector('.stagetop');
  if (DF.stageRow(top, stage).two && carving)
    DF.pairColumns(top, Math.round(W * sc) + 30, 320);
}
/* The lines written on a bin on the map, cut to fit the bin.
 *
 * They were written at a fixed size whatever the bin, so the height line "3u · 21mm" —
 * about 51 map units wide — spilled out of every one-cell-wide bin, which is 36 wide,
 * and across its neighbours' labels. A note did the same at seven characters a cell,
 * and in a bin one cell deep the note sat below the bottom edge altogether.
 *
 * So each line is measured against the room the bin has. The height line drops to "3u"
 * when the whole of it will not fit, and a note is cut to what will, with an ellipsis.
 * Lines are stacked and centred, and when there are more than the bin is tall — a note
 * in a one-deep bin — the height goes first: the size says which bin this is and the
 * note is what you wrote on it, while the height is in the hover text and the preview.
 *
 * Measured by character count, not by asking the browser. The map font is monospace,
 * and getComputedTextLength() answers 0 for a map that is not on screen, which would
 * hand every bin the long form the next time it appeared. CH, ASC and DESC are a little
 * wider and taller than any monospace in --mono actually is, so the estimate errs into
 * the margin rather than out of the bin. Sizes are the stylesheet's #fillmap ones.
 *
 * Returns [{ cls, text, dy }], dy being each baseline's offset from the bin's centre. */
const LABEL = { CH: 0.62, ASC: 0.95, DESC: 0.27, GAP: 1.5,
                size: { blabel: 12, bsub: 9.5, bnote: 9 } };
function binLabels(b) {
  const roomW = b.u * S - 10, roomH = b.v * S - 8;   // the rect's 2 inset, plus clearance
  const fits = (str, cls) => str.length * LABEL.CH * LABEL.size[cls] <= roomW;
  const lines = [{ cls: 'blabel', text: `${b.u}×${b.v}`, rank: 0 }];
  const full = `${b.hUnits}u · ${b.hUnits * SPEC.unitH}mm`, short = `${b.hUnits}u`;
  const ht = fits(full, 'bsub') ? full : fits(short, 'bsub') ? short : null;
  if (ht) lines.push({ cls: 'bsub', text: ht, rank: 2 });
  if (b.note) {
    const max = Math.floor(roomW / (LABEL.CH * LABEL.size.bnote));
    const note = b.note.length <= max ? b.note : max >= 3 ? b.note.slice(0, max - 1) + '…' : '';
    if (note) lines.push({ cls: 'bnote', text: note, rank: 1 });
  }
  const tall = (ls) => ls.reduce((a, l) => a + (LABEL.ASC + LABEL.DESC) * LABEL.size[l.cls], 0) +
                       LABEL.GAP * (ls.length - 1);
  // drop the least important line until the stack fits the bin's height
  let keep = lines.slice();
  while (keep.length > 1 && tall(keep) > roomH)
    keep = keep.filter((l) => l.rank !== Math.max(...keep.map((k) => k.rank)));
  let y = -tall(keep) / 2;
  return keep.map((l) => {
    const fs = LABEL.size[l.cls];
    const dy = y + LABEL.ASC * fs;
    y += (LABEL.ASC + LABEL.DESC) * fs + LABEL.GAP;
    return { cls: l.cls, text: l.text, dy };
  });
}
function drawMap() {
  /* In focus there is no drawer map to draw, and drawing it would be worse than
     doing nothing: the body of this function sizes .stagetop's columns from the map,
     and doing that for a card that is hidden pins the preview to a column that is not
     there. Delegating rather than returning empty keeps every existing drawMap() call
     site — there are fourteen — correct in both modes without any of them asking
     which mode it is in. */
  if (focused) { drawFocusMap(); return; }
  const g = grid(), svg = $('fillmap');
  const W = g.nx * S, H = g.ny * S;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  /* Pair the map with the 3D view only when the grid is portrait or square. A wide
     drawer's map wants the full stage width, and halving it to sit beside the preview
     would make the thing you actually work in smaller — the opposite of the point. */
  const top = document.querySelector('.stagetop');
  const wide = g.nx / g.ny > 1.15;
  top.classList.toggle('wide', wide);

  /* Size from the STAGE, never from the map's own container. The column width is set
     from the map below, so measuring the container here would make each depend on the
     other — which froze a square grid at its previous size and collapsed a wide one.
     The stage does not depend on the map, so it breaks the loop.

     Cells get a comfortable fixed size rather than filling whatever room exists;
     available space is a ceiling, not a target. */
  const CELL_PX = 52, PREVIEW_MIN = 320;
  /* Sizing the two columns from the map is only meaningful where there ARE two
     columns. The stylesheet collapses .stagetop to one column below 1280 px, and an
     inline style beats a media query — so on a phone this pinned a 320 px preview
     beside the map and hung the whole card off the right edge of the screen.
     Clearing the inline style and asking the element how many tracks it ended up with
     keeps that breakpoint in one place, the stylesheet, instead of repeating the
     number here where the two could drift apart.

     It is asked FIRST, because the answer decides how wide the map may be. It used to
     be asked after the size was settled, and the size always took the preview's 320 px
     share out of the stage — including in one column, where the preview is underneath
     and takes no width at all. A phone got a 180 px map of 26 px cells in a card with
     room for 45, and a 1024 px tablet a 216 px one. DF.stageRow does the asking, the
     same way for the baseplates page's cut map.

     The width is the row's own, not the stage's guessed at: .stagetop is as wide as
     the stage's content box whatever its columns hold, so measuring it is not the loop
     described above. The 30 is the card's chrome around the map — #fillwrap's 14 px of
     padding each side and the border — which is also what the column below adds back.
     The old "stage minus 44" over-counted it by 26 px on one column, enough for the
     max-width:100% clamp to letterbox the grid inside its own box. */
  const stage = document.querySelector('.stage');
  const row = DF.stageRow(top, stage);
  const twoCol = !wide && row.two;
  const availW = Math.max(180, twoCol ? row.width - row.gap - PREVIEW_MIN - 30 : row.width - 30);
  /* The height ceiling is the part of the stage you can see. Two thirds of the window
     stood in for that while the stage ran off the bottom of the page anyway; now the
     stage is exactly the window under the header and is the thing that scrolls, so at
     1280×720 that guess was a 468 px map in 513 px of stage — the front row, the
     coverage bar and the errors about the layout (#mapChecks) always just out of view,
     at the very moment they were the point. The map, its front marker and the
     coverage bar now fit together with the stage scrolled to the top.
     Above the map is measured rather than assumed, because the layer tabs wrap as
     layers are added: the card's heading and tabs (row.room has already lost the
     stage's top padding). Below it the marker and the bar are a fixed 41 px. Stacked,
     the stage is as tall as its content and it is the window that scrolls, so there
     the window is the room — see DF.stageRow.
     Fitting the height never takes a cell under 40 px, the size the phone pass set as
     the smallest thing a finger can hit: on a short window with the "picked up your
     layout" banner showing, a map that scrolls a little beats one too fine to use.
     The 52 px cell and 720 px caps are for a 1080-line window and grow with a taller
     one (row.big): at 1440 a cell may be 69 px rather than staying 52 while the screen
     round it got a third bigger. The labels scale with the cells, so they stay legible. */
  const above = svg.getBoundingClientRect().top - top.getBoundingClientRect().top;
  const availH = Math.max(H * 40 / S, Math.min(720 * row.big, row.room - above - 41));
  const sc = Math.min(availW / W, availH / H, Math.round(CELL_PX * row.big) / S);
  svg.setAttribute('width', Math.round(W * sc));
  svg.setAttribute('height', Math.round(H * sc));
  if (twoCol) DF.pairColumns(top, Math.round(W * sc) + 30, PREVIEW_MIN);

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const el = (n, a) => { const e = document.createElementNS(SVGNS, n);
    for (const k in a) e.setAttribute(k, a[k]); return e; };
  const sy = (y, v) => (g.ny - y - v) * S;

  const occ = occupancy();
  const sup = support(cur);
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      const free = occ[y][x] === -1;
      const dead = cur > 0 && !sup.ok[y][x];
      const c = el('rect', { class: 'cell' + (free && !dead ? ' free' : '') + (dead ? ' dead' : ''),
        x: x * S, y: sy(y, 1), width: S, height: S });
      svg.appendChild(c);
    }

  // ghost the layer below so you can line bins up with what supports them
  if (cur > 0)
    for (const b of layers[cur - 1].bins)
      svg.appendChild(el('rect', { class: 'ghostbin', x: b.x * S + 3, y: sy(b.y, b.v) + 3,
        width: b.u * S - 6, height: b.v * S - 6, rx: 5 }));

  const claims = { [cur]: layerClaims(cur) };
  B().forEach((b, i) => {
    const issues = binIssues(b, cur, claims).filter((x) => typeof x === 'string' || !x.note);
    const cls = 'bin' + (selAll().includes(i) ? ' sel' : '') + (issues.length ? ' clash' : '')
                      + (b.done ? ' done' : '');
    const cells = binCells(b);
    const held = new Set(cells.map(([dx, dy]) => dx + ',' + dy));
    let r = null;
    if (!isCarved(b)) {
      r = el('rect', { class: cls, x: b.x * S + 2, y: sy(b.y, b.v) + 2,
                       width: b.u * S - 4, height: b.v * S - 4, rx: 5 });
      r.dataset.i = i; svg.appendChild(r);
    } else {
      /* A carved bin is drawn cell by cell with the border on exposed edges only,
         so it reads as one shape rather than a row of tiles. */
      for (const [dx, dy] of cells) {
        const c = el('rect', { class: cls + ' cellpart',
          x: (b.x + dx) * S + 1, y: sy(b.y + dy, 1) - 1, width: S - 2, height: S - 2 });
        c.dataset.i = i; svg.appendChild(c);
        if (!r) r = c;
      }
      for (const [dx, dy] of cells) {
        const px = (b.x + dx) * S, py = sy(b.y + dy, 1);
        const line = (x1, y1, x2, y2) => svg.appendChild(
          el('line', { class: 'binedge', x1, y1, x2, y2 }));
        if (!held.has((dx - 1) + ',' + dy)) line(px + 1, py - 1, px + 1, py + S - 1);
        if (!held.has((dx + 1) + ',' + dy)) line(px + S - 1, py - 1, px + S - 1, py + S - 1);
        if (!held.has(dx + ',' + (dy - 1))) line(px + 1, py + S - 1, px + S - 1, py + S - 1);
        if (!held.has(dx + ',' + (dy + 1))) line(px + 1, py - 1, px + S - 1, py - 1);
      }
    }
    const cx = (b.x + b.u / 2) * S, cy = sy(b.y, b.v) + b.v * S / 2;
    for (const t of binLabels(b)) {
      const e = el('text', { class: t.cls, x: cx, y: cy + t.dy, 'text-anchor': 'middle' });
      e.textContent = t.text;
      svg.appendChild(e);
    }
    // hovering a bin says what you decided goes in it — and the whole of it, which is
    // what makes it safe for the labels to shorten or drop a line in a small bin
    const tip = document.createElementNS(SVGNS, 'title');
    tip.textContent = (b.note ? b.note + ' — ' : '') +
      `${b.u}×${b.v}, ${b.hUnits} units (${b.hUnits * SPEC.unitH} mm)`;
    r.appendChild(tip);
    if (issues.length) {
      const warn = el('text', { class: 'bwarn', x: b.x * S + 13, y: sy(b.y, b.v) + 20 });
      warn.textContent = '⚠';
      const tip = document.createElementNS(SVGNS, 'title');
      tip.textContent = issues.join('; ');
      warn.appendChild(tip);
      svg.appendChild(warn);
    }
    if (i === selected && selAll().length === 1)   // grips need one bin, not several
      for (const [hx, hy, key] of [[b.x, b.y, 'lf'], [b.x + b.u, b.y, 'rf'],
                                   [b.x, b.y + b.v, 'lb'], [b.x + b.u, b.y + b.v, 'rb']]) {
        const h = el('rect', { class: 'grip', x: hx * S - 6, y: (g.ny - hy) * S - 6,
                               width: 12, height: 12, rx: 3 });
        h.dataset.handle = key;
        svg.appendChild(h);
      }
  });

  /* Only a create drag has an anchor to rubber-band from. Drawing this for a resize
     or a move read x0/y0 off a drag that never set them, so every attribute came out
     NaN and the browser rejected the rect four times a frame. */
  if (drag && drag.mode === 'create') {
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    const u = Math.abs(drag.x1 - drag.x0) + 1, v = Math.abs(drag.y1 - drag.y0) + 1;
    svg.appendChild(el('rect', { class: 'drag' + (canPlace(x, y, u, v, -1) ? '' : ' bad'),
      x: x * S + 1, y: sy(y, v) + 1, width: u * S - 2, height: v * S - 2, rx: 5 }));
  }

  /* To anything that cannot see it, the map is one image with no alt text — the whole
     working surface of the tool, unreadable. The label is rebuilt here, on every draw,
     rather than written once in the markup: a fixed string would describe an empty
     drawer forever, which is worse than silence because it is confidently wrong.
     Long layouts are summarised rather than enumerated. Reading out seventy bins is
     not useful, and the piece table below already lists every one of them as real
     text a screen reader can navigate. */
  const listed = B().slice(0, 12).map((b) =>
    `${b.u} by ${b.v}${isCarved(b) ? ' carved' : ''} at column ${b.x + 1}, row ${b.y + 1}`);
  const more = B().length - listed.length;
  svg.setAttribute('aria-label',
    `Drawer layout map, front of the drawer at the bottom. ` +
    `Layer ${cur + 1} of ${layers.length}, grid ${g.nx} by ${g.ny} cells ` +
    `in a ${state.drawerW} by ${state.drawerD} millimetre drawer. ` +
    (B().length
      ? `${plural(B().length, 'bin')} on this layer: ` +
        listed.join('; ') + (more > 0 ? `; and ${more} more` : '') + '.'
      : 'No bins on this layer.'));
}
/* Screen point -> grid cell.
   Goes through the SVG's own screen matrix rather than measuring the element box.
   preserveAspectRatio letterboxes the drawing inside that box whenever the element's
   aspect ratio differs from the viewBox's, so box-relative arithmetic is off by the
   dead margin — and the margin changes as the element resizes. getScreenCTM accounts
   for the viewBox, the letterboxing, page zoom and scroll together. */
function cellFromEvent(e) {
  const g = grid(), svg = $('fillmap');
  const m = svg.getScreenCTM && svg.getScreenCTM();
  let vx, vy;
  if (m) {
    const p = svg.createSVGPoint ? svg.createSVGPoint() : new DOMPoint();
    p.x = e.clientX; p.y = e.clientY;
    const loc = p.matrixTransform(m.inverse());
    vx = loc.x; vy = loc.y;
  } else {                                    // detached or display:none
    const r = svg.getBoundingClientRect();
    vx = (e.clientX - r.left) / (r.width || 1) * g.nx * S;
    vy = (e.clientY - r.top) / (r.height || 1) * g.ny * S;
  }
  return { x: Math.max(0, Math.min(g.nx - 1, Math.floor(vx / S))),
           y: Math.max(0, Math.min(g.ny - 1, g.ny - 1 - Math.floor(vy / S))) };
}
function initMap() {
  const svg = $('fillmap');
  /* Right-click on the map. Uses the same cell arithmetic as every other click here, so
     the menu opens on the bin under the cursor whether or not it is the selected one. */
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const c = cellFromEvent(e);
    const i = B().findIndex((b) => binCells(b).some(([dx, dy]) =>
      b.x + dx === c.x && b.y + dy === c.y));
    if (i < 0) return closeMenu();
    hideTip();
    openMenu(e.clientX, e.clientY, cur, i);
  });
  svg.addEventListener('pointerdown', (e) => {
    const c = cellFromEvent(e);
    const handle = e.target && e.target.dataset ? e.target.dataset.handle : null;

    /* Grips sit on the bin's corners, which is exactly where you click to carve an
       L. While carving they have to yield, or the one cell you most want to remove
       is the one cell you cannot. */
    if (handle && !e.altKey && !carving && selected >= 0 && B()[selected]) {
      const b = B()[selected];
      pushUndo();
      drag = { mode: 'resize', idx: selected,
               ax: handle[0] === 'l' ? b.x + b.u - 1 : b.x,
               ay: handle[1] === 'f' ? b.y + b.v - 1 : b.y,
               x1: c.x, y1: c.y };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
      return;
    }

    /* Alt-click carves. Inside the selected bin it removes a cell; on a cell the bin
       once covered it puts one back, so a carve can be undone by the same gesture. */
    if ((e.altKey || carving) && selected >= 0 && B()[selected]) {
      const b = B()[selected];
      const dx = c.x - b.x, dy = c.y - b.y;
      if (dx >= 0 && dy >= 0 && dx < b.u && dy < b.v) {
        carveToggle(b, dx, dy);
        /* Redrawn whether or not it changed anything: a refused click still has to put
           the map back, because the pointer-down that produced it may have started a
           selection highlight. */
        readControls(); drawMap(); refresh();
        return;
      }
      /* Outside the bin. Alt is a deliberate modifier, so it swallows the click either
         way; a plain click in carve mode must stay a click, or the mode traps you with
         no way to select anything else. Clicking away simply leaves the mode. */
      if (e.altKey) return;
      carving = false;
    }
    const hit = occupancy()[c.y][c.x];
    if (hit !== -1) {
      if (e.ctrlKey || e.metaKey) {                      // add or remove from the set
        if (hit === selected) {                          // dropping the primary promotes another
          const rest = [...selExtra]; selExtra.delete(rest[0]);
          selected = rest.length ? rest[0] : -1;
        } else if (selExtra.has(hit)) selExtra.delete(hit);
        else if (selected < 0) selected = hit;
        else selExtra.add(hit);
        if (selected >= 0) writeControls(B()[selected]);
        readControls(); drawMap(); refresh();
        return;
      }
      const b = B()[hit];                                // grab to move; a still
      selExtra.clear();                                  // release is just a select
      selected = hit;
      writeControls(b);
      pushUndo();
      drag = { mode: 'move', idx: hit, dx: c.x - b.x, dy: c.y - b.y, moved: false };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
      readControls(); drawMap(); refresh();
      return;
    }

    clearSel();                                          // draw a new bin
    drag = { mode: 'create', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    readControls(); drawMap();
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = cellFromEvent(e);

    if (drag.mode === 'create') {
      if (c.x === drag.x1 && c.y === drag.y1) return;
      drag.x1 = c.x; drag.y1 = c.y; drawMap();
      return;
    }
    const b = B()[drag.idx];
    if (!b) return;

    if (drag.mode === 'move') {
      const nx = c.x - drag.dx, ny = c.y - drag.dy;
      if (nx === b.x && ny === b.y) return;
      if (!canPlace(nx, ny, b.u, b.v, drag.idx)) return;  // refuse, don't snap away
      b.x = nx; b.y = ny; drag.moved = true;
      drawMap();
      return;
    }
    // resize: the opposite corner stays put, this one follows the pointer
    const nx = Math.min(c.x, drag.ax), ny = Math.min(c.y, drag.ay);
    const nu = Math.abs(c.x - drag.ax) + 1, nv = Math.abs(c.y - drag.ay) + 1;
    if (nx === b.x && ny === b.y && nu === b.u && nv === b.v) return;
    if (!canPlace(nx, ny, nu, nv, drag.idx)) return;
    b.x = nx; b.y = ny; setFootprint(b, nu, nv);
    drag.moved = true;
    writeControls(b); drawMap();
  });

  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.mode === 'create') {
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
      const u = Math.abs(drag.x1 - drag.x0) + 1, v = Math.abs(drag.y1 - drag.y0) + 1;
      if (canPlace(x, y, u, v, -1)) {
        /* Snapshot here rather than at pointerdown: a drag that ends across an
           occupied cell places nothing, and an entry filed for it would make the
           next Undo spend itself on a layout that never changed. */
        pushUndo();
        B().push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                   floorT: state.floorT, divX: state.divX, divY: state.divY,
                   solid: state.solid, scoop: state.scoop, label: state.label,
                   note: '',
                   magnets: state.magnets, screws: state.screws, holesEvery: state.holesEvery,
                   edges: Object.assign({}, state.edges) });
        selected = B().length - 1;
        writeControls(B()[selected]);
      }
    }
    drag = null;
    readControls(); drawLayerTabs(); drawMap(); refresh();
  });
  /* and a sheet kept up for a drag that never finished goes the way a release over
     nothing would put it */
  svg.addEventListener('pointercancel', () => { drag = null; applySheet(); drawMap(); refresh(); });
}

/* ---------- actions ------------------------------------------------------- */
$('fillRest').addEventListener('click', () => {
  pushUndo();
  const g = grid();
  clearSel(); readControls();
  const sup = support(cur);
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      if (cur > 0 && !sup.ok[y][x]) continue;
      for (const [u, v] of [[state.u, state.v], [state.v, state.u], [1, 1]]) {
        if (!canPlace(x, y, u, v, -1)) continue;
        // on upper layers, only place where the support underneath is level
        const probe = { x, y, u, v };
        if (cur > 0) { const st = seat(probe, cur); if (!st.flat || !st.solidBelow) continue; }
        B().push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                   floorT: state.floorT, divX: state.divX, divY: state.divY,
                   solid: state.solid, scoop: state.scoop, label: state.label,
                 note: '',
                 magnets: state.magnets, screws: state.screws, holesEvery: state.holesEvery,
                 edges: Object.assign({}, state.edges) });
        break;
      }
    }
  drawLayerTabs(); drawMap(); refresh();
});
$('clearAll').addEventListener('click', () => {
  pushUndo();
  layers[cur].bins = []; clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('delBin').addEventListener('click', () => {
  if (selected < 0) return;
  pushUndo();
  for (const i of selAll().sort((a, b) => b - a)) B().splice(i, 1);
  clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('splitFit').addEventListener('click', () => {
  if (selected < 0) return;
  const b = B()[selected], sp = describeSplit(b.u, b.v);
  if (!sp) return;
  pushUndo();
  const src = Object.assign({}, b);
  /* A carved bin's mask is in its own box's coordinates, so every piece takes the part
     of it that falls in the piece's box, rebased to that box. Copying the whole mask
     into each piece read cells meant for the first piece in all of them — and outside
     the first, where nothing matched, the mask was ignored and the piece came out full,
     on top of the cell another bin held. */
  const kept = binCells(src);
  B().splice(selected, 1);
  let oy = src.y;
  for (const vv of sp.ys) {
    let ox = src.x;
    for (const uu of sp.xs) {
      const rx = ox - src.x, ry = oy - src.y;
      const cells = kept.filter(([x, y]) => x >= rx && x < rx + uu && y >= ry && y < ry + vv)
                        .map(([x, y]) => [x - rx, y - ry]);
      if (cells.length)                       // a piece the carve emptied is not a bin
        B().push(Object.assign({}, src, { x: ox, y: oy, u: uu, v: vv,
                                          cells: cells.length === uu * vv ? null : cells,
                                          edges: Object.assign({}, src.edges) }));
      ox += uu;
    }
    oy += vv;
  }
  clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
/* Merge the selection into one bin. Union the cells they cover, take the bounding box
   as the new footprint, and keep only the cells that were actually occupied — which is
   the same mask the carve gesture produces, so the two routes meet in the same place. */
$('carveMode').addEventListener('click', () => {
  carving = !carving;
  readControls(); drawMap();
});

$('mergeBins').addEventListener('click', () => {
  const sel = selAll();
  if (sel.length < 2) return;
  pushUndo();
  const bins = sel.map((i) => B()[i]);
  const abs = new Set();
  for (const b of bins) for (const [dx, dy] of binCells(b)) abs.add((b.x + dx) + ',' + (b.y + dy));
  const pts = [...abs].map((k) => k.split(',').map(Number));
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const u = x1 - x0 + 1, v = y1 - y0 + 1;
  const cells = pts.map(([x, y]) => [x - x0, y - y0]);
  const merged = Object.assign({}, bins[0], {   // the primary's settings carry
    x: x0, y: y0, u, v,
    cells: cells.length === u * v ? null : cells,   // a solid rectangle needs no mask
    edges: Object.assign({}, bins[0].edges),
  });
  for (const i of sel.sort((a, b) => b - a)) B().splice(i, 1);
  B().push(merged);
  selected = B().length - 1; selExtra.clear();
  writeControls(merged);
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('applyAll').addEventListener('click', () => {
  if (selected < 0) return;
  pushUndo();
  const s = B()[selected];
  for (const b of B()) Object.assign(b, {
    hUnits: s.hUnits, wall: s.wall, floorT: s.floorT,
    divX: s.divX, divY: s.divY, solid: s.solid, scoop: s.scoop, label: s.label,
    magnets: !!s.magnets, screws: !!s.screws, holesEvery: !!s.holesEvery,
    edges: Object.assign({}, s.edges) });
  drawMap(); refresh();
});

/* ---------- undo ----------------------------------------------------------
   Snapshots of the layout only — drawer and printer settings are not part of it,
   so undo never surprises you by moving the walls of the room. Pushed before a
   change, not after, and deduplicated so a drag that ends where it started is not
   an undo step. */
const undoStack = [], redoStack = [];
/* A loose bin is a separate document and gets a separate history. One shared stack
   would mean an undo taken inside the loose bin restoring a drawer that knows nothing
   about it — and an undo taken in the drawer, later, wiping a bin that was never in
   the drawer to be restored to. Which stack is in play follows which document is on
   screen, so neither ever sees the other's states. */
const sUndoStack = [], sRedoStack = [];
const uStack = () => (scratch ? sUndoStack : undoStack);
const rStack = () => (scratch ? sRedoStack : redoStack);
const UNDO_MAX = 60;
const drawerSnap = () => JSON.stringify({ layers, cur });
const snapshot = () => (scratch ? JSON.stringify({ scratch }) : drawerSnap());
function pushOn(U, R, snap) {
  if (U.length && U[U.length - 1] === snap) return;
  U.push(snap);
  if (U.length > UNDO_MAX) U.shift();
  R.length = 0;
  updateUndoButtons();
}
function pushUndo() { pushOn(uStack(), rStack(), snapshot()); }
/* A settings edit to a bin is an undo step of its own. readControls wrote the panel
   straight onto the selection and banked nothing, so draw a bin, change its height,
   Undo — and the step spent was the draw, taking the bin with it.

   Pushed BEFORE the change, as everything else here is, and only when the panel really
   differs from the bin: readControls also runs on every selection and redraw, and those
   must not file steps. A burst of edits to one field of one selection is one step —
   typing "12" or a note a letter at a time — as long as nothing else has been banked
   in between and the next keystroke follows within a second. */
const SETTINGS_COALESCE_MS = 1000;
let settingsBurst = null;
const sameNum = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
const edgeAt = (o, k) => (o.edges && o.edges[k] !== undefined ? o.edges[k] : 1);
// the first setting the panel would change on this bin, or '' for none
function settingsChange(b, t, nu, nv) {
  if (nu !== undefined && (nu !== b.u || nv !== b.v)) return 'size';
  for (const k of ['hUnits', 'wall', 'floorT', 'divX', 'divY']) if (!sameNum(t[k], b[k])) return k;
  for (const k of ['solid', 'divRemovable', 'lid', 'magnets', 'screws', 'holesEvery'])
    if (!!t[k] !== !!b[k]) return k;
  for (const k of ['scoop', 'label']) if (!sameNum(t[k] || 0, b[k] || 0)) return k;
  if ((t.note || '') !== (b.note || '')) return 'note';
  if (lidSideBits(t.lidSides) !== lidSideBits(b.lidSides)) return 'lidSides';
  return EDGES.some((k) => !sameNum(edgeAt(t, k), edgeAt(b, k))) ? 'edges' : '';
}
function noteSettingsEdit(bins, t, nu, nv) {
  let field = '';
  for (const b of bins) if ((field = settingsChange(b, t, nu, nv))) break;
  if (!field) return;
  const sig = (scratch ? 'loose' : `${cur}:${selAll().join(',')}`) + ':' + field;
  const U = uStack(), now = Date.now();
  if (settingsBurst && settingsBurst.sig === sig && now - settingsBurst.at < SETTINGS_COALESCE_MS &&
      U[U.length - 1] === settingsBurst.snap) {
    settingsBurst.at = now;
    return;
  }
  const snap = snapshot();
  pushOn(U, rStack(), snap);
  settingsBurst = { sig, at: now, snap };
}
/* Adding a layer while a loose bin is on screen edits the DRAWER, and the loose bin has
   its own history that captures only itself. Routing this through pushUndo would file the
   entry on the scratch stack, where undoing it restores the bin and leaves the new layer
   standing — and spends an Undo that appears to do nothing. It belongs on the drawer,
   which is where it will be seen when you go back. Same push, named target. */
function pushDrawerUndo() { pushOn(undoStack, redoStack, drawerSnap()); }
function applySnap(snap) {
  const o = JSON.parse(snap);
  /* A loose bin's history holds only the bin. Nothing about the drawer is restored,
     because nothing about the drawer was captured — that is the separation working. */
  if (o.scratch) {
    scratch = o.scratch;
    writeControls(scratch);
    readControls(); drawMap(); refresh();
    return;
  }
  /* An undo inside focus must not throw you back to the drawer. Focus is defined by the
     selection and clearSel() below drops it, so undoing a carve used to end the mode
     the carve was performed in — which is the one place undo gets used most. The index
     is stable across an undo because the snapshot restores the same bin list; if the
     bin genuinely is not there any more, focus falls away as it should. */
  const keep = focused ? selected : -1;
  layers = o.layers; cur = Math.min(o.cur, layers.length - 1);
  clearSel();
  if (keep >= 0 && B()[keep]) {
    selected = keep; B()[keep].sel = true; writeControls(B()[keep]);
  }
  readControls(); drawLayerTabs(); drawMap(); refresh();
}
function undo() {
  const U = uStack(), R = rStack();
  if (!U.length) return;
  R.push(snapshot());
  applySnap(U.pop());
  updateUndoButtons();
}
function redo() {
  const U = uStack(), R = rStack();
  if (!R.length) return;
  U.push(snapshot());
  applySnap(R.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  const U = uStack(), R = rStack();
  $('undoBtn').disabled = !U.length;
  $('redoBtn').disabled = !R.length;
  // the focus bar carries its own pair, because the card holding those two is hidden
  $('focusUndo').disabled = !U.length;
  $('focusRedo').disabled = !R.length;
}

/* ---------- splitting an oversized bin ------------------------------------
   Rotating on the bed never helps: a rectangle's bounding box is smallest at 0 or
   90 degrees, so anything longer than the bed stays longer than the bed. The only
   answer is fewer cells per piece. */
const footW = (u) => (u - 1) * SPEC.pitch + 2 * SPEC.half;
const fitsBed = (u, v) => {
  const w = footW(u), d = footW(v);
  return (w <= state.bedW && d <= state.bedD) || (d <= state.bedW && w <= state.bedD);
};
// fewest pieces that each fit; ties broken towards squarer pieces
function splitPlan(u, v) {
  let best = null;
  for (let nx = 1; nx <= u; nx++)
    for (let ny = 1; ny <= v; ny++) {
      const pu = Math.ceil(u / nx), pv = Math.ceil(v / ny);
      if (!fitsBed(pu, pv)) continue;
      const n = nx * ny, ar = Math.max(pu, pv) / Math.min(pu, pv);
      if (!best || n < best.n || (n === best.n && ar < best.ar)) best = { nx, ny, n, ar, pu, pv };
    }
  return best;
}
const evenParts = (total, n) => {
  const base = Math.floor(total / n), extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
};
function describeSplit(u, v) {
  const p = splitPlan(u, v);
  if (!p) return null;
  const xs = evenParts(u, p.nx), ys = evenParts(v, p.ny);
  const names = [];
  for (const b of ys) for (const a of xs) names.push(`${a}×${b}`);
  return { plan: p, xs, ys, text: names.join(' + ') };
}

/* ---------- per-bin problems ----------------------------------------------
   One place decides what is wrong with a bin, so the badge on the map and the
   text in Checks can never disagree. Nothing here blocks placement — you may be
   about to fill in the thing that fixes it. */
/* Who claims each cell of a layer: -1, one bin's index, or an array of them when two or
   more bins sit on the same cell. occupancyOf keeps only the last bin per cell, which is
   right for "what is here" and blind to the case that matters for Checks — a link
   holding two bins on one cell drew one, counted both, and reported nothing. */
function layerClaims(k) {
  const g = grid();
  const cl = Array.from({ length: g.ny }, () => new Array(g.nx).fill(-1));
  (layers[k] ? layers[k].bins : []).forEach((b, i) => {
    for (const [dx, dy] of binCells(b)) {
      const x = b.x + dx, y = b.y + dy;
      if (y < 0 || y >= g.ny || x < 0 || x >= g.nx) continue;
      const c = cl[y][x];
      if (c === -1) cl[y][x] = i;
      else if (Array.isArray(c)) c.push(i);
      else cl[y][x] = [c, i];
    }
  });
  return cl;
}
/* `claims`, when given, is layerClaims per layer index, worked out once by a caller
   that is about to ask about every bin rather than once per bin. */
function binIssues(b, k, claims) {
  const g = grid(), out = [];
  /* A loose bin is not in the drawer, so the questions the drawer asks — does it fit
     the grid, what holds it up, does the stack clear the lid — have no answer here,
     and answering them anyway would report a 10-wide bin as "outside the grid" when
     the grid is not where it lives. What still bites is the printer: the bed, the Z
     height, the wall thickness, and whether a carved shape holds together. */
  const loose = b === scratch;
  if (!loose && (b.x < 0 || b.y < 0 || b.x + b.u > g.nx || b.y + b.v > g.ny)) {
    out.push('sits outside the drawer grid');
    return out;
  }
  if (!loose) {
    const cl = (claims && claims[k]) || layerClaims(k), others = new Set();
    for (const [dx, dy] of binCells(b)) {
      const c = cl[b.y + dy][b.x + dx];
      if (Array.isArray(c)) for (const i of c) if (layers[k].bins[i] !== b) others.add(i);
    }
    if (others.size) {
      const o = layers[k].bins[[...others][0]];
      out.push((others.size === 1
        ? `shares cells with the ${o.u}×${o.v} bin at column ${o.x + 1} row ${o.y + 1}`
        : `shares cells with ${others.size} other bins`) +
        ' — two bins cannot fill the same cell, so one of them has to move');
    }
  }
  const st = loose ? { z: 0, flat: true, solidBelow: true } : seat(b, k);
  // layer 0 sits on the baseplate, which every bin fits; the rest sit on other bins
  if (!loose && k > 0) {
    const occB = occupancyOf(k - 1);
    // Where the bin below reaches each of this bin's four edges. Support does not
    // have to be continuous: a bin bridging a gap between two others is a plank on
    // two beams. What it cannot do is rest on one side only, or on nothing.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, any = false;
    for (let dy = 0; dy < b.v; dy++)
      for (let dx = 0; dx < b.u; dx++) {
        if (occB[b.y + dy][b.x + dx] === -1) continue;
        any = true;
        x0 = Math.min(x0, dx); x1 = Math.max(x1, dx + 1);
        y0 = Math.min(y0, dy); y1 = Math.max(y1, dy + 1);
      }
    // Tips unless its centre of mass falls strictly inside the supported span. Touching
    // two opposite edges is not enough on its own: a wide bin resting on one narrow bin
    // reaches that bin's front and back rails, but every rail is on one side of it.
    const E = 1e-9;
    const stable = any &&
      b.u / 2 > x0 + E && b.u / 2 < x1 - E &&
      b.v / 2 > y0 + E && b.v / 2 < y1 - E;

    if (!any) {
      out.push('has nothing underneath it at all');
    } else if (!stable) {
      out.push('overhangs its support — the bins below are all to one side of its centre, so it would tip. Bridging a gap is fine; leaning off the end is not');
    } else if (!st.flat) {
      out.push('spans bins of different heights below — it would rock');
    } else {
      // The lip below is four rails around its perimeter, with open cavity between.
      // Spanning a bin across either axis lands you on two of its opposite rails;
      // being inset on BOTH axes leaves you over the hole in the middle.
      const covered = new Set();
      for (let dy = 0; dy < b.v; dy++)
        for (let dx = 0; dx < b.u; dx++) covered.add(occB[b.y + dy][b.x + dx]);
      for (const i of covered) {
        const bb = layers[k - 1].bins[i];
        if (!bb) continue;
        const spansX = b.x <= bb.x && b.x + b.u >= bb.x + bb.u;
        const spansY = b.y <= bb.y && b.y + b.v >= bb.y + bb.v;
        if (!spansX && !spansY)
          out.push(`sits inside the ${bb.u}×${bb.v} bin below on both axes, so it rests over open cavity and would drop in — span its full width or its full depth`);
        if (!allFullEdges(bb))
          out.push('the bin below has a lowered wall, so it has no stacking lip to sit on');
      }
    }
  }
  /* Bins print upright, so height is a bed constraint too — and an easy one to miss,
     because a deep drawer will let you ask for a bin far taller than the printer's Z.
     Splitting cannot help here: a bin is one piece, so the only fix is fewer units. */
  const lipUp = (!b.solid && allFullEdges(b)) ? LIP_H : 0;
  const printH = b.hUnits * SPEC.unitH + lipUp;
  if (printH > state.bedH + 0.001)
    out.push(`stands ${printH.toFixed(1)} mm tall, past your printer's ${state.bedH} mm Z height — a bin prints in one piece, so it needs fewer units rather than splitting (max ${Math.max(1, Math.floor((state.bedH - lipUp) / SPEC.unitH))} here)`);

  if (isCarved(b)) {
    const m = maskCheck(maskOf({ u: b.u, v: b.v, cells: b.cells }), b.u, b.v);
    if (!m.ok)
      out.push(`${m.why} — it still prints, but it is not one solid bin` +
        (m.why.indexOf('pieces') >= 0 ? ' and will come out as separate parts' : ''));
    /* A note, not a fault. A carved bin keeps its stacking lip and takes bins on top
       exactly like a rectangle; only the features that need a rectangle to mean
       anything are left off. Flagging the shape itself in red made carving look
       broken the moment you started. */
    out.push({ note: true, t: 'is a carved shape — it keeps its stacking lip and still takes bins on top, but dividers, the scoop and the label shelf need a rectangle, so they are left off' });
  }

  const fw = (b.u - 1) * SPEC.pitch + 2 * SPEC.half, fd = (b.v - 1) * SPEC.pitch + 2 * SPEC.half;
  if (!((fw <= state.bedW && fd <= state.bedD) || (fd <= state.bedW && fw <= state.bedD)))
  {
    const sp = describeSplit(b.u, b.v);
    out.push(`is ${fw.toFixed(0)} × ${fd.toFixed(0)} mm, too big for your ${state.bedW} × ${state.bedD} mm bed in either orientation` +
      (sp ? ` — split it into ${sp.text}` : ''));
  }
  if (!loose && st.z + b.hUnits * SPEC.unitH + LIP_H > g.avail + 0.001)
    out.push(`reaches ${(st.z + b.hUnits * SPEC.unitH + LIP_H).toFixed(1)} mm, past the ${g.avail.toFixed(1)} mm available`);
  if (!b.solid && b.wall < 0.8)
    /* Below one nozzle line the engine builds the thinnest wall it can rather than an
       open shell, so the file holds more wall than the field says; say so. */
    out.push(`${b.wall} mm walls are thinner than two perimeters at a 0.4 mm nozzle` +
             (b.wall < WALL_MIN ? `; they are built at ${WALL_MIN} mm, a single line, since nothing thinner prints` : ''));
  /* A note, because the bin prints fine: the floor field goes on saying what was typed,
     and the floor that gets built is thicker, which is worth knowing before measuring
     what fits inside. */
  if (b.screws && !b.solid && builtFloorT(b) > b.floorT)
    out.push({ note: true, t: `has screw holes, so its floor is built ${builtFloorT(b)} mm thick rather than ` +
      `${b.floorT} mm, to keep a skin over the end of each hole` });
  /* Past the stacking lip's base a thicker wall buys nothing at the top edge — the lip
     already stands on it — and every tenth of a millimetre comes out of the inside on
     both sides. Worth saying, because the inside is what the bin is for; not a fault,
     because it prints fine. */
  const lipBase = LIP[0][1];
  if (!b.solid && b.wall > lipBase)
    out.push({ note: true, t: `has ${b.wall} mm walls, thicker than the ${lipBase} mm the stacking lip stands on — ` +
      `each side takes ${(b.wall - BIN_DEFAULTS.wall).toFixed(1)} mm more of the inside than the usual ${BIN_DEFAULTS.wall} mm` });
  return out;
}

/* ---------- checks -------------------------------------------------------- */
function stackHeight() {
  const g = grid();
  /* Each layer's occupancy once, not once per cell: rebuilt inside the cell loop it was
     cells squared times layers, 4.2 s a redraw on a 100 × 100 grid of five layers. */
  const occs = layers.map((_, L) => occupancyOf(L));
  let top = 0;
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      let h = 0;
      for (let L = 0; L < layers.length; L++) {
        const i = occs[L][y][x];
        if (i !== -1) h += layers[L].bins[i].hUnits * SPEC.unitH;
      }
      if (h > top) top = h;
    }
  return top ? top + LIP_H : 0;
}
function warnings() {
  const g = grid(), out = [];
  /* Focus asks about one bin, so the checks answer about one bin. The stack total and
     the "no bins yet" prompt belong to the drawer and would be noise here. Everything
     binIssues says stays, INCLUDING what it says about where the bin sits and what
     holds it up — those are facts about this bin, and dropping them would make focus a
     place where an unprintable bin looks fine. */
  if (fBin()) {
    const b = fBin();
    for (const it of binIssues(b, scratch ? 0 : cur)) {
      const x = typeof it === 'string' ? { err: true, t: it } : it;
      out.push({ err: !x.note, note: x.note, t: `This bin ${x.t}.` });
    }
    return out;
  }
  if (drawerAsked.w > DRAWER_MAX || drawerAsked.d > DRAWER_MAX)
    out.push({ err: true, t: `A ${drawerAsked.w} × ${drawerAsked.d} mm drawer is bigger than the ${DRAWER_MAX} mm a side this tool lays out, so it is drawn as ${state.drawerW} × ${state.drawerD} mm — a ${g.nx} × ${g.ny} grid. Check the drawer size; split a drawer that really is this big into parts.` });
  /* Custom margins can leave the drawer no room for a cell. The Baseplates page builds
     nothing from a design like that, and says why; this page drew its one cell anyway,
     because grid() never draws fewer, and said nothing, so the design looked sound here
     and failed there. The test is the plate's own (see warnings in src/ui.js). A drawer
     too small for a cell without its margins is the drawer's doing, not theirs, and the
     plate puts that first too. Only numbers go in: this goes into the panel as markup. */
  const pm = plateMargins();
  if (pm)
    for (const [len, a, b, sides, dim, line] of [
      [state.drawerW, pm.l, pm.r, 'left and right', 'width', 'column'],
      [state.drawerD, pm.f, pm.b, 'front and back', 'depth', 'row']]) {
      const free = len - Math.min(a, len) - Math.min(b, len), shown = +free.toFixed(1);
      if (len < SPEC.pitch || free >= SPEC.pitch - 1e-6) continue;
      out.push({ err: true, t: `The baseplate's ${sides} margins ${shown > 0 ? `leave ${shown} mm of the drawer's ${dim}, not enough for` : `take up the drawer's whole ${dim}, with no room for`} one ${SPEC.pitch} mm cell. The Baseplates page builds no plate from this design, and the one ${line} on this map has no socket under it: check the margins there, and the drawer size.` });
    }
  /* A baseplate at another pitch has no socket a spec bin seats in, and nothing else on
     this page would say so: the map is drawn in 42 mm cells whatever the plate is. The
     figure is the link's, so it is written as a number and only when it reads as one —
     this goes into the panel as markup. To the thousandth, so that no pitch platePitch
     calls non-standard is named as 42; and one too small to show there is not called a
     0 mm grid. */
  const pp = platePitch();
  if (pp !== null) {
    const shown = isFinite(pp) ? +pp.toFixed(3) : 0;
    out.push({ err: true, t: `The baseplate in this design is laid out on a ${shown > 0 ? `${shown} mm` : 'non-standard'} grid. These bins are made to the standard's ${SPEC.pitch} mm, so they will not seat in it: set Grid pitch on the Baseplates page back to ${SPEC.pitch} mm.` });
  }
  const tot = stackHeight();
  if (tot > g.avail + 0.001)
    out.push({ err: true, t: `The tallest stack is ${tot.toFixed(1)} mm but only ${g.avail.toFixed(1)} mm is available above the baseplate.` });
  else if (tot > 0)
    out.push({ t: `Tallest stack ${tot.toFixed(1)} mm of ${g.avail.toFixed(1)} mm available — ${(g.avail - tot).toFixed(1)} mm spare (includes the ${LIP_H.toFixed(2)} mm top lip).` });

  const claims = layers.map((_, k) => layerClaims(k));
  layers.forEach((L, k) => L.bins.forEach((b) => {
    for (const it of binIssues(b, k, claims)) {
      const x = typeof it === 'string' ? { err: true, t: it } : it;
      out.push({ err: !x.note, note: x.note,
                 t: `Layer ${k + 1}, the ${b.u}×${b.v} bin at column ${b.x + 1} row ${b.y + 1}: ${x.t}.` });
    }
  }));

  if (!allBins().length)
    out.push({ t: 'No bins yet. Drag across the map to place one, or use "Fill the rest".' });
  return out;
}
/* Where the checks are said, and how loudly.
 *
 * They were said in exactly one place: the body of panel 04, which on a 1440 px screen
 * starts around 1240 px down a rail that scrolls on its own, and on a phone is a
 * thousand pixels below the fold. A 7×9 bin 40 units tall produced four correct,
 * well-written errors and nothing on screen said so — the only signal was a ⚠ glyph in
 * the corner of the map, and nothing at all stopped you downloading a 283.9 mm bin that
 * no printer will make.
 *
 * So three signals, each for a different way of looking at the page: a count in the
 * panel header, which is visible whether or not the body is; the errors repeated under
 * the map, where the baseplates page has always put them and where your eye already is;
 * and the panel opening itself the moment a sound layout stops being one.
 */
const focusedAllClear = () => (fBin()
  ? '<div class="hint">This bin is sound and fits your printer.</div>'
  : '<div class="hint">Layout is sound and everything fits.</div>');
function drawWarnings() {
  const w = warnings();
  const errs = w.filter((x) => x.err);
  $('warnings').innerHTML = w.length
    ? w.map((x) => `<div class="w${x.err ? ' err' : ''}"><span>${x.t}</span></div>`).join('')
    /* 'Layout' is the drawer's word. Focus is looking at one bin, and a loose one
       has no layout at all to be sound. */
    : focusedAllClear();

  // errors only in the stage: the panel keeps the notes and the all-clear, and a
  // second copy of "this is a carved shape" beside the map would be noise
  $('mapChecks').style.display = errs.length ? '' : 'none';
  $('mapChecksList').innerHTML = errs.map((x) => `<div>${x.t}</div>`).join('');

  $('warnBadge').textContent = errs.length ? `· ${plural(errs.length, 'problem')}` : '';
  $('warnBadge').style.display = errs.length ? '' : 'none';
  if (errs.length && !hadErrors) setPanel('s-warn', true);
  hadErrors = errs.length > 0;
}

/* ---------- types + totals ------------------------------------------------ */
/* The bins still to print, grouped by shape.
 *
 * Everything you could print comes through here — the plates, the per-type STLs, the
 * ZIP, the filament estimate — so marking a bin printed here removes it from all of
 * them at once rather than from whichever ones someone remembered to filter. The bin
 * stays in the layout: it is in the drawer, it just is not in the queue.
 */
/* How a type reads in a list: its shape, and what you said goes in it. Distinct from
   typeName further down, which builds the STL FILENAME and must stay stable and
   filesystem-safe — a note with a slash in it has no business in a filename. */
const B_DIV = (b, axis) => dividerPart(G, binCfg(b), axis);
const typeLabel = (t) => `${t.b.u}×${t.b.v}×${t.b.hUnits}` +
  (t.b.solid ? ' solid' : '') + (holesText(t.b) ? `, ${holesText(t.b)} each` : '') +
  (t.qty > 1 ? ` × ${t.qty}` : '') +
  (t.notes && t.notes.length ? ` — ${t.notes.join(', ')}` : '');

/* The loose divider plates a layout needs.
 *
 * Grouped by the plate itself rather than by the bin, because two different bins that
 * happen to want the same size of divider want the same part — and because what you
 * carry to the printer is "six of these", not "two for that bin and four for this one".
 * Only bins with removable dividers contribute; a fixed divider is part of its bin.
 */
/* The lids a layout needs, grouped by the part rather than by the bin: two bins of the
   same footprint wanting the same skirt want the same lid, and what you carry to the
   printer is "three of these".

   A lid can only grip a bin that still HAS a lip, and lowering any wall drops the lip
   from all four — so a bin with a lowered edge is skipped here rather than offered a lid
   that could not attach. binHasLip is the same test buildBin uses to decide. */
const binHasLip = (b) => !b.solid &&
  EDGES.every((k) => !b.edges || b.edges[k] === undefined || b.edges[k] >= 1);
/* A carved bin keeps its lip, but lidPart only makes a rectangle: on an L it was a full
   125.5 × 83.5 plate over a shape with a corner missing, overhanging the cut-away cells
   by a whole cell. Shaping the lid to the cells is a lid builder of its own, so carved
   bins are not offered one, and the panel says why. */
const lidFits = (b) => binHasLip(b) && !isCarved(b);
const L_LID = (b) => lidPart(G, Object.assign({}, binCfg(b), { lidSides: b.lidSides }));
function lidParts() {
  const m = new Map();
  for (const t of types()) {
    if (!t.b.lid || !lidFits(t.b)) continue;
    const L = L_LID(t.b);
    const key = `${t.b.u}x${t.b.v}:${L.meta.sides.join('')}`;
    if (!m.has(key)) m.set(key, { key, b: t.b, meta: L.meta, qty: 0 });
    m.get(key).qty += t.qty;
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}
const lidName = (d) => `lid-${d.b.u}x${d.b.v}-${d.meta.sides.join('') || 'flat'}`;

function dividerParts() {
  const m = new Map();
  for (const t of types()) {
    /* Plates only for a bin that has rails to hold them. buildBin leaves the rails off a
       solid or carved bin, and off one whose floor fills it — and a floor as thick as
       the bin is tall, which the floor field allows, made a plate of negative height:
       an STL turned inside out. */
    if (!t.b.divRemovable || t.b.solid || isCarved(t.b)) continue;
    for (const [axis, n] of [['y', t.b.divX || 0], ['x', t.b.divY || 0]]) {
      if (!n) continue;
      const d = B_DIV(t.b, axis);
      if (d.meta.tall < 1) continue;
      const key = `${d.meta.span.toFixed(1)}x${d.meta.tall.toFixed(1)}x${d.meta.t}`;
      if (!m.has(key)) m.set(key, { key, axis, b: t.b, meta: d.meta, qty: 0 });
      m.get(key).qty += n * t.qty;
    }
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}
const dividerName = (d) =>
  `divider-${d.meta.span.toFixed(1)}x${d.meta.tall.toFixed(1)}x${d.meta.t}mm`;

function types() {
  const m = new Map();
  for (const { b } of scoped()) {
    /* "Printed" is a queue fact: it drops a bin off the plates because it is already
       sitting in the drawer. In focus you are looking AT one bin and asking for its
       STL, and filtering it out there answers with an empty table and no download. */
    if (b.done && !focused) continue;
    const k = typeKey(b);
    if (!m.has(k)) m.set(k, { key: k, b, qty: 0, notes: [] });
    const t = m.get(k);
    t.qty++;
    /* What you wrote in the bin travels with its type, because "1x1x3 x 2" is the one
       thing a row of the download table cannot tell you: which of the four identical
       shapes on the plate is the one for drill bits. Notes are NOT part of typeKey — two
       bins the same shape share one STL whatever they are for — so a type can carry
       several, and all of them are worth showing. */
    const n = (b.note || '').trim();
    if (n && !t.notes.includes(n)) t.notes.push(n);
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}
function refresh() {
  const g = grid();
  // the tallest bin is capped by the drawer OR the printer's Z, whichever bites first
  const zUnits = Math.max(1, Math.floor((state.bedH - LIP_H) / SPEC.unitH));
  const capUnits = Math.min(g.maxUnits, zUnits);
  const capBy = zUnits < g.maxUnits ? 'your printer' : 'the drawer';
  /* With inches on, the lengths here are given in both: the millimetres are what the
     grid and every download are made of, the inches are what the drawer was measured
     in and what a tape measure will be held against. */
  const inch = unit === 'in';
  const also = (mm) => inch ? ` / ${FIELDS.inchText(mm)} in` : '';
  const gw = g.nx * SPEC.pitch, gd = g.ny * SPEC.pitch;
  $('gridSummary').textContent =
    `Grid: ${g.nx} × ${g.ny} cells` +
    (inch ? ` (${gw} × ${gd} mm, ${FIELDS.inchText(gw)} × ${FIELDS.inchText(gd)} in)` : '') +
    ` · ${g.avail.toFixed(1)} mm${also(g.avail)} above the baseplate · ` +
    `tallest single bin ${capUnits} units (${capUnits * SPEC.unitH} mm${also(capUnits * SPEC.unitH)} + lip), limited by ${capBy}`;
  const src = scratch || (selected >= 0 && B()[selected] ? B()[selected] : state);
  $('binSizeHint').textContent =
    `${(src.u * SPEC.pitch - 0.5).toFixed(1)} × ${(src.v * SPEC.pitch - 0.5).toFixed(1)} × ${(src.hUnits * SPEC.unitH).toFixed(1)} mm (+${LIP_H.toFixed(2)} lip)`;

  /* Cells covered, not cells claimed: summing every bin's cells counted two bins on one
     cell twice and a bin off the grid in full, which is how 500 copies of one bin read
     "794%". Checks names the overlap; this is just how full the grid is. */
  let used = 0;
  for (const row of occupancy()) for (const c of row) if (c !== -1) used++;
  const total = g.nx * g.ny;
  const pct = total ? Math.round(100 * used / total) : 0;
  /* The drawer is named here because nothing else on the stage names it. Arriving from
     the baseplates page with a 412 × 297 drawer, the only confirmation that it carried
     across sat inside collapsed panel 01, and this line said "0/63 cells" — true, and
     no help at all in telling whether the tool was working on your drawer or its own
     default one. The totals across layers only appear once there is more than one
     layer; on a single-layer design they repeated the same count in the same line. */
  $('coverage').textContent =
    `Layer ${cur + 1}: ${plural(B().length, 'bin')} · ${used}/${total} cells (${pct}%) · ` +
    `${g.nx} × ${g.ny} grid in a ${state.drawerW} × ${state.drawerD} mm drawer` +
    (layers.length > 1
      ? ` · ${plural(allBins().length, 'bin')} over ${plural(layers.length, 'layer')}`
      : '') +
    ` · tallest stack ${stackHeight().toFixed(1)} mm`;
  $('covfill').style.width = pct + '%';

  const ts = types();
  let vol = 0;
  /* The table is built as markup and a note is text someone typed, so a note goes in
     escaped: a "<" in a note is a "<" on the screen, not the start of a tag. */
  const asText = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  $('typeRows').innerHTML = ts.map((t) => {
    const gm = geomFor(t.b);
    vol += gm.vol * t.qty;
    return `<tr><td class="mono">${t.b.u}×${t.b.v}×${t.b.hUnits}${t.b.solid ? ' solid' : ''}${t.b.divX || t.b.divY ? ` · ${(t.b.divX + 1) * (t.b.divY + 1)} comp` : ''}` +
      `${holesText(t.b) ? ` · ${asText(holesText(t.b))}` : ''}` +
      /* what it is for, beside what it is — the row is how you tell four identical
         shapes apart when they come off the plate */
      `${t.notes && t.notes.length ? `<span class="tnote">${asText(t.notes.join(', '))}</span>` : ''}</td>` +
      `<td class="mono">${gm.meta.W.toFixed(1)} × ${gm.meta.D.toFixed(1)} × ${gm.meta.totalH.toFixed(1)}</td>` +
      `<td class="mono">${t.qty}</td>` +
      `<td class="mono">${(gm.vol * t.qty / 1000 * PLA_DENSITY).toFixed(0)} g</td>` +
      `<td><button data-t="${t.key}">STL</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="mono">no bins placed</td></tr>';
  for (const btn of $('typeRows').querySelectorAll('button[data-t]'))
    btn.addEventListener('click', () => {
      const t = types().find((x) => x.key === btn.dataset.t);
      if (t) downloadType(t);
    });
  /* Two counts once anything is marked: what is in the drawer, and what is still to
     come off the printer. Reporting only the second would make the drawer look
     half-designed; only the first would quote filament for bins already sitting in it. */
  const inScope = scoped();
  /* Not counted in focus: types() deliberately keeps a printed bin there, so a "still
     to print" figure computed the drawer's way would contradict the table above it.
     What is worth saying instead is that the one bin on screen carries the mark. */
  const doneN = focused ? 0 : inScope.filter(({ b }) => b.done).length;
  $('totals').textContent = inScope.length
    ? `${plural(inScope.length, 'bin')}` +
      (doneN ? ` · ${plural(inScope.length - doneN, 'bin')} still to print` : '') +
      ` · ${plural(ts.length, 'distinct type')} · ` +
      `≈ ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g PLA at ${state.infill}% infill` +
      (doneN ? ' for those' : '') +
      (fBin() && fBin().done ? ' · this one is marked printed' : '')
    : '—';

  drawWarnings();
  drawPlan();
  updateExportTail();
  showScene();
  pruneGeometry();
  rememberState();
}

/* ---------- print plan ----------------------------------------------------
   Reuses packPlates from the shared core: shelf packing with rotation, no
   stacking (bins are open-topped, so nothing can bridge over them). */
let printPlan = null;
function computePlan() {
  const ts = types();
  if (!ts.length) { printPlan = null; return; }
  /* Bins AND the loose divider plates. A plate of bins with no dividers on it is not
     the job: you would print the whole drawer and then have to come back for the parts
     that divide it. Both are just rectangles with a height as far as the packer is
     concerned, so they go in the same list rather than getting a pass of their own. */
  const parts = ts.map((t) => ({
    key: t.key, b: t.b, qty: t.qty,
    meta: geomFor(t.b).meta, polys: () => geomFor(t.b).polys,
  })).concat(dividerParts().map((d) => ({
    key: 'div:' + d.key, b: null, qty: d.qty, divider: d,
    meta: d.meta, polys: () => B_DIV(d.b, d.axis).polys,
  }))).concat(lidParts().map((d) => ({
    key: 'lid:' + d.key, b: null, qty: d.qty,
    meta: d.meta, polys: () => L_LID(d.b).polys,
  })));
  const items = parts.map((t) => ({
    id: t.key, w: t.meta.W, d: t.meta.D, h: t.meta.totalH, qty: t.qty, ids: [t.key],
  }));
  printPlan = { plates: packPlates(items, state.bedW, state.bedD, state.gap,
                                   { stack: false }), types: parts };
}
/* Bins and divider plates are both on the plate now, so counting them all as "bins"
   would be a small lie in the one place someone checks what they are about to print. */
function countOf(placed) {
  const divs = placed.filter((p) => String(p.id).startsWith('div:')).length;
  const lids = placed.filter((p) => String(p.id).startsWith('lid:')).length;
  const bins = placed.length - divs - lids;
  return [bins ? plural(bins, 'bin') : '', divs ? plural(divs, 'divider') : '',
          lids ? plural(lids, 'lid') : ''].filter(Boolean).join(' + ') || '0 bins';
}
function drawPlan() {
  computePlan();
  if (!printPlan) {
    $('plateWrap').innerHTML = '';
    $('plateSummary').textContent = '—';
    return;
  }
  const over = printPlan.plates.filter((p) => p.overflow);
  const good = printPlan.plates.filter((p) => !p.overflow);
  const sc = Math.min(170 / state.bedW, 170 / state.bedD);
  const byKey = new Map(printPlan.types.map((t, i) => [t.key, i]));
  const COLORS = ['#4fc3e8', '#e8b34f', '#7fd8a5', '#e88a8a', '#b18ae8', '#7fb5e8', '#e8d47f'];
  $('plateWrap').innerHTML = good.map((pl, i) => {
    let svg = `<svg width="${state.bedW * sc + 2}" height="${state.bedD * sc + 2}" ` +
              `style="background:var(--panel2);border:1px solid var(--line);border-radius:4px">`;
    for (const p of pl.placed) {
      const c = COLORS[(byKey.get(p.id) || 0) % COLORS.length];
      /* Draw the shape that actually prints. The packer works in bounding boxes, which
         is correct — a carved bin still sweeps its full box — but drawing the box made
         the plan claim an L was a rectangle. Cells are placed the same way the 3D plate
         places the mesh: centre the bin on the origin, rotate, then translate. */
      const t = printPlan.types.find((x) => x.key === p.id);
      const b = t && t.b;
      const cells = b && isCarved(b) ? binCells(b) : null;
      if (!cells) {
        svg += `<rect x="${p.x * sc + 1}" y="${(state.bedD - p.y - p.d) * sc + 1}" ` +
               `width="${p.w * sc}" height="${p.d * sc}" fill="${c}" opacity="0.5" stroke="var(--line)"/>`;
        continue;
      }
      const P = 42, HALF = 20.75;
      const midX = p.x + p.w / 2, midY = p.y + p.d / 2;
      for (const [dx, dy] of cells) {
        let cx = (dx - (b.u - 1) / 2) * P, cy = (dy - (b.v - 1) / 2) * P;
        if (p.rot === 90) { const t2 = cx; cx = -cy; cy = t2; }
        const X = midX + cx, Y = midY + cy;
        svg += `<rect x="${(X - HALF) * sc + 1}" y="${(state.bedD - Y - HALF) * sc + 1}" ` +
               `width="${2 * HALF * sc}" height="${2 * HALF * sc}" fill="${c}" ` +
               `opacity="0.5" stroke="var(--line)"/>`;
      }
    }
    svg += '</svg>';
    return `<div style="display:grid;gap:4px;justify-items:center">${svg}` +
           `<div class="hint">plate ${i + 1} — ${countOf(pl.placed)}</div></div>`;
  }).join('');
  $('plateSummary').textContent =
    `${plural(good.length, 'plate')} on a ${state.bedW} × ${state.bedD} mm bed · ` +
    `${countOf(good.flatMap((p) => p.placed))} packed` +
    (over.length ? ` · ${plural(over.length, 'part')} TOO BIG for the bed` : '');
}

/* ---------- three.js preview ---------------------------------------------- */
let scene, camera, renderer, group, drawerGroup;
/* +theta puts the camera on the front side. It was -0.9, which sat the camera
   behind the drawer: the front row of the map rendered furthest away and the whole
   layout read mirrored against the map you had just drawn it on. Nothing pointed
   that out until the drawer shell arrived and its tall front panel appeared at the
   back. Same elevation and distance, same view, just from the side you open. */
let theta = 0.9, phi = 0.95, dist = 600, dragging = null;
/* Who is in charge of the framing: see autoFrame(). */
let viewOwned = false, framedKey = '', fitDist = 0;
/* Where the camera is looking, on the drawer floor. Orbit alone always swung about the
   middle of the grid, so a bin in a far corner of a nine-cell drawer could not be
   brought to the middle of the view to be looked at — you could only get further away.
   Middle-drag or shift-drag moves this; the baseplates tool has panned on shift-drag
   from the start and now takes the middle button too, so the two previews answer to the
   same hands. */
let panX = 0, panZ = 0, panning = false;
/* The height of that point. It was a fixed 20 mm, which is about right for the middle of
   a drawer of 3-unit bins and wrong for anything else — a drawer shell 150 mm tall had
   its pivot near the floor. Framing sets it to the middle of what is drawn. */
let lookY = 20;
/* The wheel's limits. The outer one follows the drawer, because a fixed 4000 mm would
   sit inside the fitted distance for a big enough drawer in a narrow enough canvas, and
   the first wheel tick OUT would then jump the camera in. */
const clampDist = (d) => Math.min(Math.max(4000, fitDist * 2), Math.max(80, d));
function initThree() {
  const canvas = $('three');
  /* No WebGL — disabled by policy, blocklisted GPU, a remote desktop. The renderer's
     constructor throws, and thrown here it stopped the boot: no map, no table, no export,
     no saving, and the Start fresh button never wired. The preview is the one part that
     needs a GPU, so it is the one part that goes; renderer stays null, which every
     preview function already treats as "nothing to draw". */
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err) {
    renderer = null;
    $('threeempty').textContent = '3D preview unavailable — this browser could not start WebGL. ' +
      'Everything else, downloads included, still works.';
    $('threeempty').style.display = '';
    $('threehint').style.display = 'none';
    canvas.setAttribute('aria-label', '3D preview unavailable: this browser could not start WebGL.');
    /* Nothing to expand, so no Expand button. chrome.js makes it, and runs as the
       page's last script, so during the boot there is no button yet and looking for
       one here hid nothing; once the page has parsed, every script has run. */
    const hideExpand = () => {
      const expand = $('threewrap').querySelector('.previewbtn');
      if (expand) expand.style.display = 'none';
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideExpand);
    else hideExpand();
    window.addEventListener('resize', () => drawMap());
    return;
  }
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.85); d1.position.set(1, 1.4, 1); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0x88bbff, 0.35); d2.position.set(-1, -0.6, 0.4); scene.add(d2);
  group = new THREE.Group(); scene.add(group);
  /* The drawer shell is a sibling of the bins, not a child, and that placement is
     load-bearing twice over. The hover raycast walks group.children, so a wall in
     there would be a hit to filter out on every mouse move — and a tooltip to lose
     the day somebody forgets the filter. And showScene() empties group on every
     edit, so a wall in there would be torn down and rebuilt because a bin moved. */
  drawerGroup = new THREE.Group(); scene.add(drawerGroup);
  /* Two-finger pinch to zoom. A touch screen has no wheel, and the expanded preview
     takes touch-action away from the canvas so a drag rotates instead of scrolling —
     which left no way to zoom at all on a phone. One finger rotates as before. */
  const pts = new Map();
  const gap = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    dragging = [e.clientX, e.clientY];
    /* Middle button, or shift with the left. preventDefault stops the browser's
       middle-click autoscroll, which otherwise takes over the drag entirely. */
    panning = e.button === 1 || e.shiftKey;
    if (e.button === 1) e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (pts.size === 2) { pinch = gap(); dragging = null; hideTip(); }
  });
  // the autoscroll cursor appears on the click that FOLLOWS the drag without this
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size === 0) panning = false;
    if (pts.size < 2) pinch = null;
    // re-seat on the finger still down, or the model jumps when the other lifts
    dragging = pts.size === 1 ? [...pts.values()][0].slice() : null;
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  canvas.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size >= 2) {
      const g = gap();
      if (pinch > 0 && g > 0) {
        dist = clampDist(dist * (pinch / g));
        viewOwned = true;
        render();
      }
      pinch = g;
      return;
    }
    if (dragging) {
      const dx = e.clientX - dragging[0], dy = e.clientY - dragging[1];
      if (panning) {
        /* Move the look-at point across the drawer floor, in the plane of the screen:
           dragging right carries the model right, so the target goes left. Scaled by
           distance so the model keeps up with the cursor at any zoom. */
        const k = dist * 0.0011;
        panX -= (dx * Math.sin(theta) + dy * Math.cos(theta)) * k;
        panZ += (dx * Math.cos(theta) - dy * Math.sin(theta)) * k;
        if (dx || dy) viewOwned = true;
      } else {
        theta -= dx * 0.01;
        phi = Math.min(3.11, Math.max(0.03, phi - dy * 0.01));
      }
      dragging = [e.clientX, e.clientY]; render();
      hideTip();
      return;
    }
    // which bin is under the cursor? the meshes carry their bin on userData
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(group.children, false)
                   .find((h) => h.object.userData && h.object.userData.bin);
    if (hit) showTip(e, hit.object.userData.bin, hit.object.userData.layer);
    else hideTip();
  });
  canvas.addEventListener('pointerleave', hideTip);
  /* Right-click in the preview. The same ray the tooltip uses, so the menu opens on the
     bin you are pointing at rather than the one that happens to be selected — and the
     preview is where you notice a bin is in the wrong layer, because the map only shows
     one layer at a time. */
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(group.children, false)
                   .find((h) => h.object.userData && h.object.userData.bin);
    if (!hit) return closeMenu();
    const L = hit.object.userData.layer, b = hit.object.userData.bin;
    const i = layers[L].bins.indexOf(b);
    if (i >= 0) { hideTip(); openMenu(e.clientX, e.clientY, L, i); }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = clampDist(dist * (1 + Math.sign(e.deltaY) * 0.12));
    viewOwned = true;
    render();
  }, { passive: false });
  window.addEventListener('resize', () => { drawMap(); render(); });
  /* chrome.js owns the button, because it owns Expand beside it and runs on both tools;
     it says "fit" with an event rather than calling in, so it needs to know nothing of
     how either tool keeps its camera. */
  $('threewrap').addEventListener('previewfit', () => {
    viewOwned = false;
    framedKey = '';           // whatever the key says, frame now
    render();
  });
}
/* The one place the model axes are mapped to the scene: model (x, y, z) becomes
   (x, z, -y), so model z is up and model y runs into the screen. The parts beside the
   bin go through this too — a second copy of the mapping that drifted would put a lid
   on its side and look like a geometry bug rather than a transcription one. */
function polysToGeo(polys) {
  const tris = G.polysToTriangles(polys);
  const pos = new Float32Array(tris.length * 9);
  let i = 0;
  for (const t of tris) for (const v of t) { pos[i++] = v[0]; pos[i++] = v[2]; pos[i++] = -v[1]; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
function geoOf(b) {
  const gm = geomFor(b);
  if (!gm.three) gm.three = polysToGeo(gm.polys);
  return gm.three;
}
/* Divider and lid geometry, cached by the part rather than by the bin: two bins wanting
   the same lid want the same buffer. The key is the part's full shape, and each scene
   draw records the keys it used so showScene can dispose of the rest — the same rule as
   pruneGeometry, for the same leak. */
const partGeoCache = new Map();
let partsUsed = new Set();
function partGeoOf(key, make) {
  let g = partGeoCache.get(key);
  if (!g) { g = polysToGeo(make()); partGeoCache.set(key, g); }
  partsUsed.add(key);
  return g;
}
/* The pieces that come off the printer ALONGSIDE the bin, drawn where you can see them.
   Dividers and a lid are separate prints, and until now the first look at either was in
   the slicer or off the bed — which is late to find out a divider is not the height you
   pictured, or that a lid you asked for could not attach at all.

   dividerParts() and lidParts() read types(), which focus already narrows to this one
   bin, so what comes back is this bin's parts and nothing else. Both are the SAME calls
   the piece table, the plan and the export make, so what is drawn here is what you get
   rather than a second opinion about it.

   Nothing here touches the export. These offsets exist to separate the pieces on screen;
   renderExport and the plate packer keep asking dividerParts()/lidParts() for their own
   coordinates and never see these. */
const PART_GAP = 8;
let partMat = null;
function addLooseParts(b) {
  if (!partMat) {
    /* A colour of their own, so a divider lying beside the bin does not read as part of
       it. Lambert like the bin, not wireframe: the point is to judge a real shape. */
    partMat = new THREE.MeshLambertMaterial({ color: 0xb9c6d4, side: THREE.DoubleSide,
                                              flatShading: true });
  }
  const binD = b.v * SPEC.pitch, binTop = b.hUnits * SPEC.unitH + LIP_H;

  /* Laid flat, the way they print and the way they would sit on a bench. dividerPart
     builds them lying down already — span x tall on the bed, t thick — so no rotation
     is wanted, only somewhere to put them. In a row in front of the bin, nearest the
     camera at the angle the preview opens on. */
  let z = binD / 2 + PART_GAP;
  for (const d of dividerParts()) {
    // d.key rounds to 0.1 mm for grouping; the buffer wants the exact plate
    const exact = [d.meta.span, d.meta.tall, d.meta.t].map((n) => n.toFixed(3)).join('x');
    const geo = partGeoOf('div:' + exact, () => B_DIV(d.b, d.axis).polys);
    for (let i = 0; i < d.qty; i++) {
      const m = new THREE.Mesh(geo, partMat);
      m.position.set(0, 0, z + d.meta.tall / 2);
      group.add(m);
      z += d.meta.tall + PART_GAP;
    }
  }

  /* The lid, floating above the bin with its skirt pointing down at the lip it seats in.
     lidPart is built in PRINT orientation — upside down, plate first, skirt descending
     as z grows — because that is how it goes on the bed. Showing it that way here would
     answer the wrong question: what is being asked is whether it FITS, so it is turned
     over exactly as you would turn it over in your hand.

     Turning it over is a rotation, not a mirror, so one horizontal axis reverses with it.
     That is what the real part does too. The flip is about the front-to-back axis, so
     the Front skirt stays at the front (+z, per syncDrawer) and left and right trade
     places — which is where they land on the printed part turned over the same way.
     Flipping about x instead put a Front-only skirt over the back of the bin. */
  for (const d of lidParts()) {
    // the lid's corner arcs follow the smoothness setting, which d.key leaves out
    const m = new THREE.Mesh(partGeoOf(`lid:${d.key}-s${state.arcSegs}`, () => L_LID(d.b).polys),
                             partMat);
    m.rotation.z = Math.PI;
    m.position.set(0, binTop + PART_GAP + d.meta.totalH, 0);
    group.add(m);
  }
}
const MATS = [0x6fd0e0, 0x8fdc9a, 0xe0c46f, 0xd08fd0, 0xe08f8f];
let matCache = [];

/* ---------- the drawer around the bins ------------------------------------
   An open-topped box drawn around the design so you can judge whether the bins
   suit the drawer you actually own. It is a view and nothing else: no export, no
   print plan and no fit check reads any of it.

   Two decisions worth stating.

   The sides stand at `drawerH`, the usable height already on the page, rather than
   at a side measurement of their own. That number is measured from the same datum
   — the drawer floor — and it is what the "tallest stack vs available" check
   compares against, so drawing the walls anywhere else would let the picture and
   the check disagree: bins over the rim while Checks says it fits, or the reverse.
   The front is genuinely a second measurement, because a drawer front is routinely
   taller or lower than the sides it is screwed to, and that is the panel you reach
   over. Nothing else here is a new number.

   The walls sit at the drawer's inside dimensions, not the grid's. grid() floors
   the drawer to whole 42 mm cells, and the remainder it throws away is exactly the
   thing this feature exists to show — draw the walls on the grid and the margin
   vanishes, which is the one measurement you cannot get from the map. */
const DRAWER_T = 8;        // drawn wall thickness, mm — a drawer, not a sheet of foil
const DRAWER_FLOOR_T = 3;
/* The floor is dropped a hair below the baseplate rather than left touching it.
   Physically the plate sits on the drawer bottom, so the two faces are coincident,
   and coincident faces are the one thing that reliably flickers. Nobody can see
   0.4 mm at this scale; everybody can see z-fighting. */
const DRAWER_FLOOR_GAP = 0.4;
let drawerMat = null, drawerEdgeMat = null, drawerKey = '';
/* Read instead of state.showDrawer everywhere the shell is decided. Focus draws one
   bin on a baseplate its own size, and a drawer around that would be a drawer around
   nothing — but the toggle's value has to survive the mode, so it is suppressed here
   rather than switched off. showScene and syncDrawer must agree, and did not once:
   leaving syncDrawer reading the raw flag left the shell standing around a bin. */
const shellOn = () => !!state.showDrawer && !focused;

function drawerBox() {
  const g = grid();
  /* grid() forces at least one cell even in a drawer too small to hold one, so on
     that input the grid is bigger than the drawer. Clamp, or the walls close inside
     the bins and the picture is a lie in the other direction. */
  const W = Math.max(state.drawerW, g.nx * SPEC.pitch);
  const D = Math.max(state.drawerD, g.ny * SPEC.pitch);
  /* The plate is drawn at the origin, and the drawer goes where the plate sits in it:
     its margins, custom or from its alignment, off the plate's edges (plateCells). It
     was centred whatever they said, so a plate with 20 mm on its left and 76 on its
     right was drawn with 48 each side. Held to the room there is, for the same reason
     as the clamp above: margins with no room for a cell would put walls through it. */
  const c = plateCells(state.drawerW, state.drawerD);
  const hold = (v, room) => Math.max(-room, Math.min(room, v));
  const dx = hold((c.mR - c.mL) / 2, (W - g.nx * SPEC.pitch) / 2);
  const dz = hold((c.mF - c.mB) / 2, (D - g.ny * SPEC.pitch) / 2);   // front is +z
  const side = Math.max(0, state.drawerH);
  return { W, D, dx, dz, side,
           // 0 means "same as the sides" — one fewer number to keep in step
           front: state.drawerFrontH > 0 ? state.drawerFrontH : side,
           floor: -state.plateH };   // y = 0 is the top of the baseplate
}

function syncDrawer() {
  const b = drawerBox();
  const key = shellOn() ? [b.W, b.D, b.dx, b.dz, b.side, b.front, b.floor].join('/') : '';
  // Built when its inputs change and never otherwise: render() runs on every drag
  // frame and every pinch, and showScene() runs on every edit to a bin.
  if (key === drawerKey) return;
  drawerKey = key;
  while (drawerGroup.children.length) drawerGroup.children.pop().geometry.dispose();
  if (!key) return;

  if (!drawerMat) {
    /* depthWrite off is what keeps this a window rather than a lid. The shell is
       drawn after the opaque bins and still depth-TESTED against them, so a wall
       behind a bin is hidden and a wall in front of one tints it instead of
       replacing it. It also settles the case where the drawer is an exact multiple
       of 42 mm: the wall's inner face then lands on the baseplate's edge, and two
       surfaces at the same depth only fight when both are writing. */
    drawerMat = new THREE.MeshLambertMaterial({
      color: 0x9fb4c6, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false });
    drawerEdgeMat = new THREE.LineBasicMaterial({
      color: 0xcfe2f0, transparent: true, opacity: 0.45, depthWrite: false });
  }

  /* A box plus its own outline. At 16% opacity four flat panels read as haze; the
     edges are what make them read as a drawer. */
  const panel = (w, h, d, x, yBase, z) => {
    if (h <= 0) return;
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, drawerMat);
    m.position.set(b.dx + x, yBase + h / 2, b.dz + z);   // laid out about the drawer's centre
    drawerGroup.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), drawerEdgeMat);
    e.position.copy(m.position);
    drawerGroup.add(e);
  };

  const T = DRAWER_T, hw = b.W / 2, hd = b.D / 2;
  panel(b.W, DRAWER_FLOOR_T, b.D, 0,
        b.floor - DRAWER_FLOOR_GAP - DRAWER_FLOOR_T, 0);
  /* Side walls run the full outer depth and the front and back stop at the inside
     width, so the four abut instead of overlapping. Overlapping translucent panels
     double their tint, and the result is four dark posts at the corners of an
     otherwise even box. */
  panel(T, b.side, b.D + 2 * T, -(hw + T / 2), b.floor, 0);
  panel(T, b.side, b.D + 2 * T, hw + T / 2, b.floor, 0);
  panel(b.W, b.side, T, 0, b.floor, -(hd + T / 2));         // back
  // Front of the drawer is the bottom of the map, which is +z here — the same
  // convention seat/showScene use when they negate the grid's y.
  panel(b.W, b.front, T, 0, b.floor, hd + T / 2);
}

/* One baseplate mesh, resized only when its size changes. A new BoxGeometry and
   material on every draw was one more live geometry per refresh, never freed. */
let plateMesh = null, plateKey = '';
function plateOf(w, d) {
  const h = state.plateH, key = `${w}x${h}x${d}`;
  if (!plateMesh || key !== plateKey) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (plateMesh) { plateMesh.geometry.dispose(); plateMesh.geometry = geo; }
    else plateMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x2b3947 }));
    plateKey = key;
  }
  plateMesh.position.set(0, -h / 2, 0);
  return plateMesh;
}
function showScene() {
  if (!renderer) return;
  partsUsed = new Set();
  drawScene();
  // loose parts are only drawn in focus; anything this draw did not use is let go
  for (const [k, g] of partGeoCache)
    if (!partsUsed.has(k)) { g.dispose(); partGeoCache.delete(k); }
}
function drawScene() {
  while (group.children.length) group.remove(group.children[0]);
  const g = grid();
  const gw = g.nx * SPEC.pitch, gd = g.ny * SPEC.pitch;

  /* With nothing placed, the baseplate on its own is a featureless slab overflowing the
     panel in every direction — it looks like the renderer has failed rather than like an
     empty drawer. Say so instead. The drawer shell is exempt: if you have turned it on
     you have asked to look at the drawer, and an empty one is a real answer. */
  const empty = scoped().length === 0;
  const shell = shellOn();
  /* The canvas stays visible and simply has nothing in it. Hiding it seemed tidier
     and broke the touch gestures: a hidden canvas takes no pointer events, so pinch
     and rotate had nothing to act on before the first bin was placed. */
  $('threeempty').style.display = empty && !shell ? '' : 'none';
  $('threehint').style.display = empty && !shell ? 'none' : '';
  /* Everything the tail of this function is responsible for has to happen before the
     return as well, and twice now it has not. syncDrawer is what tears the shell down
     when the toggle goes off, and skipping it left the drawer standing in an empty
     preview. The label is the third: written after the return, it never ran on an empty
     drawer, so the canvas kept the markup's "loading" text — and empty is where every
     visitor starts, so a screen reader was told the preview was still loading until the
     first bin went in. render() rather than a bare renderer.render for the same reason:
     it is what sizes the drawing buffer to the canvas and points the camera. */
  $('three').setAttribute('aria-label', sceneLabel(empty, shell, g));
  if (empty && !shell) { syncDrawer(); render(); return; }

  /* One bin, centred, on a baseplate of exactly its own footprint. The drawer's plate
     is drawn from the grid, so reusing it would put a 1×1 bin in the corner of a 7×9
     slab — and the other sixty-two cells are precisely what focus exists to stop
     showing you. */
  if (fBin()) {
    const b = fBin();
    group.add(plateOf(b.u * SPEC.pitch, b.v * SPEC.pitch));
    if (!matCache[cur]) matCache[cur] = new THREE.MeshLambertMaterial({
      color: MATS[cur % MATS.length], side: THREE.DoubleSide, flatShading: true });
    /* Fading is about what is stacked ABOVE the layer being edited. Nothing is stacked
       here, so the material has to be put back to solid — it is cached per layer and
       would otherwise arrive still carrying the transparency the drawer view gave it,
       which reads as a bin drawn wrong rather than as a bin drawn faded. */
    const mat = matCache[cur];
    mat.transparent = false; mat.opacity = 1; mat.depthWrite = true; mat.needsUpdate = true;
    const one = new THREE.Mesh(geoOf(b), mat);
    one.userData.bin = b; one.userData.layer = cur;
    group.add(one);
    addLooseParts(b);
    syncDrawer();
    render();
    return;
  }

  group.add(plateOf(gw, gd));

  layers.forEach((L, k) => {
    if (!matCache[k]) matCache[k] = new THREE.MeshLambertMaterial({
      color: MATS[k % MATS.length], side: THREE.DoubleSide, flatShading: true });
    /* Fade anything stacked above the layer being edited, so it stops hiding the one
       you are working on. Updated every draw: the material is cached per layer, and
       baking this in at creation meant switching layers changed nothing. */
    const above = k > cur;
    matCache[k].transparent = above;
    matCache[k].opacity = above ? 0.28 : 1;
    matCache[k].depthWrite = !above;
    matCache[k].needsUpdate = true;
    for (const b of L.bins) {
      const m = new THREE.Mesh(geoOf(b), matCache[k]);
      m.userData.bin = b; m.userData.layer = k;
      m.position.set((b.x + b.u / 2) * SPEC.pitch - gw / 2, seat(b, k).z,
                     -((b.y + b.v / 2) * SPEC.pitch - gd / 2));
      group.add(m);
    }
  });
  syncDrawer();
  render();
}
/* Same reasoning as the map's label: a <canvas> is a blank rectangle to anything that
   cannot see it, and this one carries the answer to "did that do what I meant". A
   summary, not a scene description — the shape of a bin is in the piece table.
   The empty case quotes #threeempty rather than paraphrasing it, so the sentence a
   screen reader gets and the sentence on the screen cannot drift apart. */
function sceneLabel(empty, shell, g) {
  if (fBin()) {
    const b = fBin();
    return `3D preview: one ${b.u} by ${b.v} bin, ${b.hUnits} units tall, ` +
           'on a baseplate of its own size.';
  }
  if (empty && !shell)
    return `3D preview: empty. ${$('threeempty').textContent.trim()}`;
  if (empty)
    return `3D preview: the drawer, empty, around a ${g.nx} by ${g.ny} cell baseplate.`;
  return `3D preview: ${plural(allBins().length, 'bin')} over ${plural(layers.length, 'layer')} ` +
         `on a ${g.nx} by ${g.ny} cell baseplate, ` +
         `tallest stack ${stackHeight().toFixed(1)} millimetres.`;
}
/* Fitting the view to what is drawn.
 *
 * The camera stood 600 mm away whatever the drawer and whatever the canvas, which at
 * 1366 px — where the preview is a tall narrow column beside the map — showed one
 * corner of the default drawer, and at 1920 ran it off two edges. DF.frame works out
 * the real distance from the field of view and the canvas's shape.
 *
 * When it runs is the other half. The key is the SUBJECT — the drawer's footprint, the
 * shell if it is shown, or in focus the one bin's size — plus the canvas's size. While
 * that holds still the view is left alone, so placing a bin, changing a wall or
 * switching layer never moves the camera under you. When it changes, the view is
 * re-framed from the angle it is already at, unless you have zoomed or panned: those
 * say what you want to look at, and re-framing would overrule it. Rotating does not
 * count, because the angle survives a re-frame anyway. Fit hands control back — it
 * frames now, and lets the page frame again from then on.
 *
 * Bins are deliberately not in the key. The frame is taken from the meshes when it
 * happens, so a stack that is already there is in it; but re-framing because a taller
 * bin went in would move the camera on the edit itself, which is the thing above that
 * must not happen. Fit is one press away, and an empty drawer is framed with room for a
 * bin of the size you would draw next. */
function frameKey(w, h) {
  const b = fBin();
  const subject = b ? ['bin', b.u, b.v, b.hUnits]
    : ['drawer', state.drawerW, state.drawerD,
       shellOn() ? `${state.drawerH}x${state.drawerFrontH}` : 'open'];
  return subject.concat([w, h]).join('/');
}
function sceneBox() {
  // drawerGroup is empty when the shell is off, and an empty box unions to nothing
  const box = new THREE.Box3().setFromObject(group)
    .union(new THREE.Box3().setFromObject(drawerGroup));
  if (box.isEmpty()) {
    const g = grid(), hw = g.nx * SPEC.pitch / 2, hd = g.ny * SPEC.pitch / 2;
    box.set(new THREE.Vector3(-hw, -state.plateH, -hd),
            new THREE.Vector3(hw, state.hUnits * SPEC.unitH + LIP_H, hd));
  }
  return box;
}
function fitView(w, h) {
  const box = sceneBox();
  const f = DF.frame({ min: box.min.toArray(), max: box.max.toArray() },
    [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)],
    [0, 1, 0], camera.fov, w / h, 0.08);
  [panX, lookY, panZ] = f.target;
  dist = fitDist = f.dist;
  camera.far = Math.max(8000, fitDist * 4);
}
function autoFrame(w, h) {
  const key = frameKey(w, h);
  if (key === framedKey) return;
  framedKey = key;
  if (!viewOwned) fitView(w, h);
}
function render() {
  if (!renderer) return;
  const wrap = $('threewrap');
  const w = wrap.clientWidth, h = wrap.clientHeight || 380;
  if (w > 0) autoFrame(w, h);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  camera.position.set(panX + dist * Math.sin(phi) * Math.cos(theta),
                      lookY + dist * Math.cos(phi),
                      panZ + dist * Math.sin(phi) * Math.sin(theta));
  camera.lookAt(panX, lookY, panZ);
  renderer.render(scene, camera);
}

/* ---------- hover tooltip -------------------------------------------------- */
function showTip(e, b, k) {
  const el = $('tip');
  el.textContent = (b.note ? b.note + ' — ' : '') +
    `${b.u}×${b.v}, ${b.hUnits} units (${b.hUnits * SPEC.unitH} mm)` +
    (k !== undefined && layers.length > 1 ? ` · layer ${k + 1}` : '');
  el.style.display = 'block';
  const pad = 14;
  el.style.left = Math.min(e.clientX + pad, window.innerWidth - el.offsetWidth - 8) + 'px';
  el.style.top = Math.max(8, e.clientY - el.offsetHeight - 10) + 'px';
}
function hideTip() { const el = $('tip'); if (el) el.style.display = 'none'; }

/* ---------- export -------------------------------------------------------- */
function saveBlob(buf, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
/* A holed bin and a plain one are different prints, so they arrive as different files:
   "bin-2x1x3-magnets-screws-qty4.stl" beside "bin-2x1x3-qty2.stl". */
const holeTag = (b) => (!b.magnets && !b.screws ? ''
  : '-' + [b.magnets ? 'magnets' : '', b.screws ? 'screws' : ''].filter(Boolean).join('-') +
    (everyMatters(b) ? '-every-cell' : ''));
function typeName(t) {
  return `bin-${t.b.u}x${t.b.v}x${t.b.hUnits}${t.b.solid ? '-solid' : ''}` +
         `${t.b.divX || t.b.divY ? `-${t.b.divX}x${t.b.divY}div` : ''}${holeTag(t.b)}-qty${t.qty}`;
}
/* One bin type as an STL. Two places offer this — the row in "Bins to print" and the
   row in the download dialog — and they are the one pair that could give you two
   differently named files for the same click. */
function downloadType(t) {
  saveBlob(G.stlBinary(geomFor(t.b).polys, 'bin'), typeName(t) + '.stl');
}
/* What to buy for the feet, and how many: the drawer's totals, with what each hole is
   for. Counted off the same holeSites the engine builds from. */
function holesReadme(ts) {
  let mags = 0, screws = 0;
  for (const t of ts) {
    const h = holeCounts(t.b);
    mags += h.magnets * t.qty; screws += h.screws * t.qty;
  }
  const out = [];
  if (mags) out.push(`Magnets: ${mags}, ${state.magnetD} x ${state.magnetH} mm. Press one into each pocket ` +
                     'under the feet, all the same face down.');
  if (screws) out.push(`Screws: ${screws} M3, driven up through the baseplate. Each hole in a bin is 6 mm deep.`);
  return out;
}
function layoutReadme() {
  const g = grid(), ts = types();
  const L = [];
  /* A focus download contains one bin. The drawer header, the per-layer maps and the
     assembly instructions would all be describing thirty bins that are not in the ZIP —
     and a README that disagrees with the files beside it is worse than no README,
     because it is read at the printer with the parts in hand. */
  if (fBin()) {
    const b = fBin(), gm = geomFor(b);
    L.push('GRIDFINITY BIN — generated by Drawerforge');
    L.push('=========================================');
    L.push('https://drawerforge.co.uk');
    L.push('');
    L.push(`Bin: ${b.u}x${b.v}x${b.hUnits}` + (b.note ? `  — ${b.note}` : ''));
    L.push(`Size: ${gm.meta.W.toFixed(1)} x ${gm.meta.D.toFixed(1)} x ${gm.meta.totalH.toFixed(1)} mm incl. lip`);
    if (b.divX || b.divY) L.push(`Compartments: ${(b.divX + 1) * (b.divY + 1)}` +
      (b.divRemovable ? '  (removable divider plates, printed loose)' : ''));
    if (b.lid && lidFits(b)) L.push('Lid: yes — prints upside down, no supports.');
    L.push(...holesReadme([{ b, qty: 1 }]));
    L.push(`Material: about ${(gm.vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA at ${state.infill}% infill.`);
    L.push('');
    L.push(scratch
      ? 'Designed on its own. It is not placed in a drawer.'
      : `It belongs at column ${b.x + 1}, row ${b.y + 1} of a ${g.nx} x ${g.ny} grid` +
        (layers.length > 1 ? `, on layer ${cur + 1}.` : '.'));
    L.push('');
    L.push('PRINTING: flat as oriented, no supports. Check it seats in your baseplate');
    L.push('before printing the rest of the drawer.');
    L.push('');
    L.push('Layout link: ' + designLink());
    return L.join('\n');
  }
  L.push('GRIDFINITY BINS — generated by Drawerforge');
  L.push('==========================================');
  L.push('https://drawerforge.co.uk');
  L.push('');
  L.push(`Drawer: ${state.drawerW} x ${state.drawerD} mm | Grid: ${g.nx} x ${g.ny} cells @ ${SPEC.pitch} mm`);
  L.push(`Height above the baseplate: ${g.avail.toFixed(1)} mm | tallest stack here: ${stackHeight().toFixed(1)} mm`);
  L.push(`Layers: ${layers.length}`);
  L.push('');
  L.push('BINS TO PRINT:');
  let vol = 0;
  for (const t of ts) {
    const gm = geomFor(t.b);
    vol += gm.vol * t.qty;
    L.push(`  ${String(t.qty).padStart(3)} x  ${t.b.u}x${t.b.v}x${t.b.hUnits}` +
      `  (${gm.meta.W.toFixed(1)} x ${gm.meta.D.toFixed(1)} x ${gm.meta.totalH.toFixed(1)} mm incl. lip)` +
      `${t.b.solid ? '  solid' : ''}${t.b.divX || t.b.divY ? `  ${(t.b.divX + 1) * (t.b.divY + 1)} compartments` : ''}` +
      // the README is read beside a pile of printed parts, which is exactly when
      // "1x1x3" stops being enough to tell them apart
      `${t.notes && t.notes.length ? `  — ${t.notes.join(', ')}` : ''}` +
      `${holesText(t.b) ? `  ${holesText(t.b)} each` : ''}`);
  }
  L.push('');
  L.push(`Total: ${plural(scoped().length, 'bin')}, about ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA.`);
  const fix = holesReadme(ts);
  if (fix.length) L.push(...fix);
  L.push('');
  layers.forEach((Ly, k) => {
    L.push(`LAYER ${k + 1} (front of the drawer at the bottom):`);
    const occ = occupancyOf(k);
    for (let y = g.ny - 1; y >= 0; y--)
      L.push('  ' + occ[y].map((i) => i === -1 ? ' . ' : String.fromCharCode(65 + (i % 26)) + '  ').join('').trimEnd());
    Ly.bins.forEach((b, i) => {
      const tag = String.fromCharCode(65 + (i % 26));
      L.push(`    ${tag} = ${b.u}x${b.v}x${b.hUnits}` + (b.note ? `  — ${b.note}` : ''));
    });
    L.push('');
  });
  if (printPlan) {
    const good = printPlan.plates.filter((p) => !p.overflow);
    L.push(`PRINT PLATES: ${good.length} on a ${state.bedW} x ${state.bedD} mm bed.`);
    L.push('');
  }
  L.push('ASSEMBLY: lay layer 1 into the baseplate, then drop each higher layer into');
  L.push('the stacking lips of the bins below it.');
  L.push('');
  L.push('PRINTING: flat as oriented, no supports. Print one bin and check it seats');
  L.push('in your baseplate before committing to the whole drawer.');
  L.push('');
  L.push('Layout link: ' + designLink());
  return L.join('\n');
}
function platePolysAndItems(idx) {
  const pl = printPlan.plates[idx];
  const objs = [];
  for (const p of pl.placed) {
    const t = printPlan.types.find((x) => x.key === p.id);
    if (!t) continue;
    // bins are modelled centred on the origin; packPlates gives a corner
    objs.push({ name: p.id, polys: t.polys(),
                tx: p.x + p.w / 2, ty: p.y + p.d / 2, tz: 0, rot: p.rot });
  }
  return objs;
}
/* Deflated, for the reason the baseplates page gives beside its own copy in src/ui.js:
   JSZip stores files unless asked, and a 3MF is a ZIP of XML text, so every plate and
   every ZIP left this page several times the size it needed to be. A copy, because the
   two pages share no script that zips. Slicers read either. */
const ZIP_DEFLATE = { compression: 'DEFLATE', compressionOptions: { level: 6 } };
async function plate3mfBytes(idx) {
  const x = build3mfXML(platePolysAndItems(idx).map((o) => ({
    name: o.name, polys: transformPolys(o.polys, 0, 0, 0, o.rot), tx: o.tx, ty: o.ty, tz: o.tz, rot: 0 })));
  const pz = new JSZip();
  pz.file('[Content_Types].xml', x.contentTypes);
  pz.file('_rels/.rels', x.rels);
  pz.file('3D/3dmodel.model', x.model);
  return pz.generateAsync({ type: 'uint8array', ...ZIP_DEFLATE });
}
const goodPlates = () =>
  printPlan ? printPlan.plates.map((p, i) => [p, i]).filter(([p]) => !p.overflow) : [];

/* Plates are numbered by position among the ones that fit, not by index in the raw
   list — everywhere. A bin too big for the bed gets a plate of its own that is never
   exported, and numbering around those produced a zip holding plate-1 and plate-3
   while the print plan on the page, and the per-plate downloads, both counted 1, 2, 3.
   The name is shared with the standalone download so the same plate arrives under the
   same name whichever row you clicked. */
const plateName = (k) => `bin-plate-${k + 1}.3mf`;
async function downloadPlate(k) {
  const good = goodPlates();
  if (!good[k]) return;
  saveBlob(await plate3mfBytes(good[k][1]), plateName(k));
}
async function downloadAllPlates() {
  const good = goodPlates();
  if (!good.length) return;
  if (good.length === 1) return downloadPlate(0);
  const zip = new JSZip();
  for (let k = 0; k < good.length; k++) zip.file(plateName(k), await plate3mfBytes(good[k][1]));
  saveBlobAsync(await zip.generateAsync({ type: 'blob', ...ZIP_DEFLATE }),
                `drawerforge-bin-plates-x${good.length}.zip`);
}
async function downloadBinZip() {
  if (!scoped().length) return;
  const zip = new JSZip();
  for (const t of types())
    zip.file(typeName(t) + '.stl', G.stlBinary(geomFor(t.b).polys, 'bin'));
  /* The dividers go in the same ZIP. A bin with rails and no plate is not a divided
     bin, and the ZIP is what someone downloads when they want the whole job. */
  for (const d of dividerParts())
    zip.file(dividerName(d) + '.stl', G.stlBinary(B_DIV(d.b, d.axis).polys, 'divider'));
  for (const d of lidParts())
    zip.file(lidName(d) + '.stl', G.stlBinary(L_LID(d.b).polys, 'lid'));
  zip.file('README.txt', layoutReadme());
  saveBlobAsync(await zip.generateAsync({ type: 'blob', ...ZIP_DEFLATE }),
                `drawerforge-bins-${grid().nx}x${grid().ny}.zip`);
}
function saveBlobAsync(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
/* Cells in, millimetres out. The drawer size stays the one measurement the tool and
   the shared link are built on — a second stored dimension could disagree with the
   first — so these write it and then let everything recompute from there. A drawer of
   exactly n × 42 mm grids to n cells, which is what someone who owns an n-cell
   baseplate is telling us they have. Plus the margins that baseplate keeps, when the
   link carries custom ones: those come off the drawer before the cells are counted (see
   grid), so n cells and nothing else would come back as fewer than were typed.
   The margins never carry the drawer past DRAWER_MAX, though. They did: 47 cells and
   100 mm a side wrote a 2174 mm drawer, which readControls cut down and Checks called a
   drawer nobody had typed, and a margin of 1e9 put a ten-digit drawer in the field. At
   the cap the grid is the most cells there is room for, which is where the field's max
   stops the spinner. Cells alone past the cap are still written as asked, so Checks
   says the drawer was cut down, as it does for one typed into the drawer field. */
for (const [id, field] of [['gridX', 'drawerW'], ['gridY', 'drawerD']])
  $(id).addEventListener('input', () => {
    const n = parseInt($(id).value, 10);
    if (!isFinite(n) || n < 1) return;      // mid-edit: an empty box is not a request
    const pm = plateMargins();
    const keep = !pm ? 0 : field === 'drawerW' ? pm.l + pm.r : pm.f + pm.b;
    const cells = n * SPEC.pitch;
    // in whatever unit it is showing
    FIELDS.setLength($(field), Math.min(cells + keep, Math.max(DRAWER_MAX, cells)), unit);
    schedule();
  });
$('bedPreset').addEventListener('change', () => {
  const bed = FIELDS.bedOf($('bedPreset').selectedOptions[0]);   // null for Custom
  /* Custom keeps the bed it had, so there is nothing to rebuild, but the choice is
     still part of the design: without a save a reload put the printer's name back. */
  if (!bed) { rememberState(); return; }
  [$('bedW').value, $('bedD').value, $('bedH').value] = bed;
  schedule();
});
const bedNow = () => [+$('bedW').value, +$('bedD').value, +$('bedH').value];
for (const id of ['bedW', 'bedD', 'bedH'])
  $(id).addEventListener('input', () => FIELDS.followBed($('bedPreset'), bedNow()));

/* ---------- the drawer's unit ----------
   Converts what the length fields show and nothing else, so it goes through refresh()
   and not schedule(): schedule throws away every cached bin mesh, and a unit switch
   changes no measurement. The comparison is a guard, not an expected path: FIELDS keeps
   the exact millimetres behind each field, so nothing should move — but if a conversion
   ever did move a value, the page has to recompute as for any edit rather than go on
   showing bins sized from the old number. */
function applyUnit(to) {
  if (to === unit) return;
  FIELDS.convert(LENGTH_IDS.map((id) => $(id)), unit, to, $('b-drawer'));
  unit = to;
  $('unitMm').classList.toggle('on', to === 'mm');
  $('unitMm').setAttribute('aria-pressed', String(to === 'mm'));
  $('unitIn').classList.toggle('on', to === 'in');
  $('unitIn').setAttribute('aria-pressed', String(to === 'in'));
}
function chooseUnit(to) {
  if (to === unit) return;
  const before = LENGTH_IDS.map((id) => state[id]);
  applyUnit(to);
  FIELDS.saveUnit(to);
  readControls();
  if (LENGTH_IDS.some((id, i) => state[id] !== before[i])) schedule();
  else refresh();
}
$('unitMm').addEventListener('click', () => chooseUnit('mm'));
$('unitIn').addEventListener('click', () => chooseUnit('in'));

/* ---------- the download dialog -------------------------------------------
   Built fresh every time it opens. A column of buttons tells you nothing about what
   comes out of them, so the dialog states what the design is, whether it fits the
   printer you configured, and then names every file with its size or its count. The
   row and group widgets are shared with the baseplates tool, in widgets.js.
   Nothing here needs the live re-render the baseplates dialog has: everything on this
   page is computed synchronously, and a modal makes the page behind it inert, so the
   layout cannot change while the dialog is open. */
const exGroup = (text) => DF.group($('exFiles'), text);
const exRow = (name, meta, label, onClick, attrs) =>
  DF.row($('exFiles'), { name, meta, label, onClick, attrs });

function bedFitText() {
  const bed = `${state.bedW} × ${state.bedD} mm bed`;
  const bins = scoped().map(({ b }) => b);
  if (!bins.length) return { cls: 'wait', t: 'No bins placed yet — drag across the drawer map to place one.' };
  const wide = bins.filter((b) => !fitsBed(b.u, b.v));
  const tall = bins.filter((b) => {
    const lip = (!b.solid && allFullEdges(b)) ? LIP_H : 0;
    return b.hUnits * SPEC.unitH + lip > state.bedH + 0.001;
  });
  if (!wide.length && !tall.length) {
    const w = Math.max(...bins.map((b) => footW(b.u))), d = Math.max(...bins.map((b) => footW(b.v)));
    const h = Math.max(...bins.map((b) => b.hUnits * SPEC.unitH +
      ((!b.solid && allFullEdges(b)) ? LIP_H : 0)));
    return { cls: 'ok', t: `Everything fits your ${bed}. The largest bin is ` +
      `${Math.max(w, d).toFixed(0)} × ${Math.min(w, d).toFixed(0)} mm and the tallest ` +
      `stands ${h.toFixed(1)} mm, inside your ${state.bedH} mm Z height.` };
  }
  const parts = [];
  if (wide.length) parts.push(`${plural(wide.length, 'bin')} ${wide.length > 1 ? 'are' : 'is'} too big for your ${bed}`);
  if (tall.length) parts.push(`${plural(tall.length, 'bin')} ${tall.length > 1 ? 'stand' : 'stands'} taller than your ${state.bedH} mm Z height`);
  return { cls: 'bad', t: parts.join(', and ') +
    '. Those are left off the print plates — Checks says what to do with each of them.' };
}

function renderExport() {
  const g = grid(), ts = types(), n = scoped().length;
  let vol = 0;
  for (const t of ts) vol += geomFor(t.b).vol * t.qty;
  /* In focus the dialog is about one bin, and saying "7 × 9 cell grid" over a single
     STL is the same disagreement the README has to avoid. */
  const fb = fBin();
  $('exDesign').textContent = fb
    ? `One bin — ${fb.u} × ${fb.v} × ${fb.hUnits}` + (fb.note ? ` — ${fb.note}` : '') + '\n' +
      (scratch ? 'designed on its own, not placed in a drawer'
               : `from column ${fb.x + 1}, row ${fb.y + 1} of your drawer` +
                 (layers.length > 1 ? `, layer ${cur + 1}` : '')) + '\n' +
      `about ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA at ${state.infill}% infill`
    : n
    ? `${g.nx} × ${g.ny} cell grid in a ${state.drawerW} × ${state.drawerD} mm drawer\n` +
      `${plural(n, 'bin')} of ${plural(ts.length, 'distinct type')} over ${plural(layers.length, 'layer')}\n` +
      `about ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA at ${state.infill}% infill`
    : `${g.nx} × ${g.ny} cell grid in a ${state.drawerW} × ${state.drawerD} mm drawer — no bins in it yet`;
  const fit = bedFitText();
  $('exFit').className = 'exfit ' + fit.cls;
  $('exFit').textContent = fit.t;

  $('exFiles').innerHTML = '';
  const good = goodPlates();
  if (good.length) {
    exGroup('Pre-arranged print plates');
    exRow('Every plate', `${plural(good.length, 'plate')} · 3MF` + (good.length > 1 ? ' in a ZIP' : ''),
          'Download', downloadAllPlates, { 'data-ex': 'allplates' });
    /* Per-plate downloads. The combined export already builds each plate on its own
       and zips them, so one plate at a time is the same call with the zip left off —
       and it is what you want when a print fails, or when you are only doing one
       plate's worth this evening. */
    good.forEach(([pl], k) => exRow(`Plate ${k + 1}`,
      `${countOf(pl.placed)} on a ${state.bedW} × ${state.bedD} mm bed · 3MF`, 'Download',
      () => downloadPlate(k), { 'data-ex': 'plate' }));
  }
  if (ts.length) {
    exGroup('Meshes');
    exRow('Every bin type, with a README', `${plural(ts.length, 'STL file')} + README.txt · ZIP`,
          'Download', downloadBinZip, { 'data-ex': 'zip' });
    /* With every side unticked the lid is a flat plate, and "( sides) · 4.2 mm tall"
       described a part that does not exist. */
    for (const d of lidParts())
      exRow(`Lid ${d.b.u}×${d.b.v}` + (!d.meta.sides.length ? ', flat — no skirt'
              : d.meta.sides.length < 4 ? ` (${d.meta.sides.join('')} sides)` : '') + ` × ${d.qty}`,
            `${d.meta.totalH.toFixed(1)} mm ` +
              (d.meta.sides.length ? 'tall, prints upside down' : 'thick') + ' · STL', 'STL',
            () => saveBlob(G.stlBinary(L_LID(d.b).polys, 'lid'), lidName(d) + '.stl'),
            { 'data-ex': 'lid' });
    for (const d of dividerParts())
      exRow(`Divider ${d.meta.span.toFixed(1)} × ${d.meta.tall.toFixed(1)} × ${d.meta.t} mm × ${d.qty}`,
            `slides into a ${d.meta.slot.toFixed(2)} mm slot · STL`, 'STL',
            () => saveBlob(G.stlBinary(B_DIV(d.b, d.axis).polys, 'divider'),
                           dividerName(d) + '.stl'), { 'data-ex': 'divider' });
    for (const t of ts)
      exRow(typeLabel(t),
            `${DF.bytes(DF.stlBytes(geomFor(t.b).polys))} · STL`, 'STL',
            () => downloadType(t), { 'data-ex': 'stl' });
  }
}
function updateExportTail() {
  const n = scoped().length, p = goodPlates().length;
  $('exportTail').textContent = n
    ? plural(n, 'bin') + (p ? ` · ${plural(p, 'plate')}` : '')
    : '';
}
$('openExport').addEventListener('click', () => {
  renderExport();
  const dlg = $('exportDlg');
  // showModal is the whole point — the fallback is for a browser old enough not to
  // have it, where an in-flow panel that closes is still better than a dead button
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
});
$('exportClose').addEventListener('click', () => $('exportDlg').close());
/* Click to dismiss, from the backdrop only. A click reports the common ancestor of its
   two ends, so selecting text in the summary and releasing outside the box reported the
   dialog itself and shut it — losing the selection and the dialog together. Both ends
   have to be the backdrop. */
let downOnBackdrop = false;
$('exportDlg').addEventListener('mousedown', (e) => { downOnBackdrop = e.target === $('exportDlg'); });
$('exportDlg').addEventListener('click', (e) => {
  if (downOnBackdrop && e.target === $('exportDlg')) $('exportDlg').close();
  downOnBackdrop = false;
});

/* ---------- shared project descriptor -------------------------------------- */
/* The bed, infill and gap were missing, so a reload put them back to 256 mm, 15 % and
   3 mm, and the bed set on the baseplates page — which sends bw, bd and bh — never
   arrived. They use that page's own names, so the two tools share one bed and one
   infill whichever way a link goes; the gap is ours, and baseplates carries it back. */
const KEYS = { w: 'drawerW', d: 'drawerD', dh: 'drawerH', ph: 'plateH',
               dfh: 'drawerFrontH', bw: 'bedW', bd: 'bedD', bh: 'bedH', if: 'infill',
               bgap: 'gap' };
/* What each may be when it arrives in a link: never negative, and never past the
   largest bed the baseplates page accepts. The drawer is held to the same 2000 mm by
   readControls, which says so in Checks — a 100 m drawer froze this page laying out its
   grid. A drawer or bed of no size is not one ("1 × 1 grid in a -500 × -500 mm drawer"
   is what accepting it said), so that keeps the default. */
const KEY_MAX = { if: 100 };
const NEEDS_SIZE = new Set(['w', 'd', 'dh', 'bw', 'bd', 'bh']);
/* Keys that describe how the design is being LOOKED at rather than what it is. They
   travel in a shared link, because a link that does not reproduce what the sender saw
   is not much of a share — but they are struck out of the link the README carries.
   The README ships inside the download, so anything that reaches it turns a view
   toggle into a changed exported byte, and the drawer shell is not allowed to change
   one. See designLink(). */
/* 'bf' joins them: which bin you have open on its own is how the design is being
   LOOKED at, not what it is. It travels in a shared link — sending someone a bin and
   having the page open on the drawer would defeat the point of sending it — and, like
   the drawer shell, it is struck out of the link the README carries, so a view can
   never change an exported byte. */
const VIEW_KEYS = ['dv', 'dfh', 'bf'];
// packing lives in bin.js so it can be tested headlessly
function descriptor() {
  const o = Object.assign({}, hashExtras, { v: 2 });
  for (const [k, id] of Object.entries(KEYS)) o[k] = state[id];
  // which printer, as well as its bed: several share one — see FIELDS.presetFor
  o.pr = $('bedPreset').value;
  o.dv = state.showDrawer ? 1 : 0;
  /* Not a VIEW key, unlike bf beside it: a loose bin is not a way of looking at the
     design, it IS the design while it is open, and it is what the download contains.
     So it travels in the link the README carries too. Packed with the same packBin the
     layers use — one serialisation to keep right rather than a second that can
     disagree with it, and hash-roundtrip.js already proves that one. */
  if (scratch) o.bs = packLayers([{ bins: [scratch] }]);
  else if (focused && fBin()) o.bf = `${cur}.${selected}`;
  o.bl = packLayers(layers);
  o.bseg = state.arcSegs;
  o.bdt = state.divT; o.bdc = state.divClr;
  // only a size someone set: an unset one follows the baseplate's (magnetDefault)
  const md = magnetDefault();
  if (state.magnetD !== md.d) o.bmd = state.magnetD;
  if (state.magnetH !== md.h) o.bmh = state.magnetH;
  const notes = layers.map((L) => L.bins.map((b) => b.note || ''));
  if (notes.some((L) => L.some((n) => n))) o.bnotes = JSON.stringify(notes);
  return o;
}
/* Names are encoded as well as values. Keys from the other tool ride through here as
   they came, and the baseplates page decodes them, so one written raw ("%=1") made
   every later visit there throw URIError; a raw line break would have reached the
   README. */
const encodeDesc = (o) => Object.entries(o)
  .map(([k, x]) => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`).join('&');
/* packBin no longer throws, but if packing ever fails again it must cost that save and
   no more: an empty string, which the save skips, rather than an exception through the
   share, hand-over and README links that all build from here. An older string standing
   in was worse than none, since a layout that failed from the start stood in for by the
   boot's defaults saved those over it. `strip` names keys to leave out, for the README's
   link. */
function descString(strip) {
  try {
    const o = descriptor();
    for (const k of strip || []) delete o[k];
    return encodeDesc(o);
  } catch (err) { return ''; }
}
/* One bad pair costs that pair. A malformed escape (%E0%A4%A) used to throw out of the
   whole load, which took the page with it. */
function parseHash(h) {
  const q = Object.create(null);
  for (const kv of h.split('&')) {
    const i = kv.indexOf('=');
    if (i < 1) continue;
    try { q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); }
    catch (err) { /* not valid percent-encoding: drop it, keep the rest */ }
  }
  return q;
}
/* A note from a link is one short line of text, as the field would have made it. Notes
   reach the README, which is plain text read at the printer: a number in their place
   threw ".trim is not a function" on every refresh, and a line break let a link write
   lines of its own into the file. Cut to the 28 characters the field takes, counted the
   way the field and a design file count them, and never halfway through an emoji. */
function cleanNote(n) {
  let out = '';
  for (const ch of String(n).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')) {
    if (out.length + ch.length > 28) break;
    out += ch;
  }
  return out;
}
/* Keep the address bar holding the current design, so a reload does not throw it away.
 *
 * The tool has no accounts and no server, which is the point of it — but it also meant
 * a refresh, a crashed tab or a mistyped URL lost a drawer someone had spent twenty
 * minutes laying out, with a "Copy settings link" button they had to have known to
 * press first. The state was already serialisable: this writes the same string that
 * button copies, so persistence and sharing cannot drift apart.
 *
 * replaceState rather than pushState: the design is not a sequence of pages, and a
 * history entry per edit would turn the back button into an undo nobody asked for and
 * make leaving the page take fifty presses. It does not fire hashchange, so nothing
 * here can feed back into loadFromHash.
 *
 * The hashReady guard is honest belt-and-braces, and worth saying so plainly: as the
 * init order stands, nothing CAN write before loadFromHash has run — the only callers
 * are recomputeLayout/refresh, both of which run after it, and the write is debounced
 * behind them anyway. Removing the guard breaks no test, because there is no test that
 * can distinguish it. It stays because the failure it prevents is silent and expensive:
 * a save landing before the load would replace a link someone had just followed with
 * this page's defaults, and neither they nor the person who sent it would ever know
 * they were looking at a different drawer. If you reorder init, this is the line that
 * stops that being your problem.
 */
let hashSaveT = 0, hashReady = false;
/* Kept on this browser, so the work survives arriving without a link.
 *
 * The address bar already carries the design and a refresh already restores it. What it
 * cannot do is help someone who types the domain, or opens a bookmark of the bare site:
 * no hash, nothing to read, and the drawer they spent twenty minutes on is gone. This
 * covers that, and only that.
 *
 * It saves the SAME string the link carries, so there is one serialisation to keep
 * right rather than two that can disagree — the format is already round-tripped by
 * test/hash-roundtrip.js.
 *
 * A link always wins. Someone following a shared layout must see the sender's drawer and
 * not their own, and the person who sent it would never know if they did not.
 *
 * Saved automatically rather than behind a Save button. A button you have to remember to
 * press does not protect you from the case this exists for, which is closing a tab
 * without thinking about it. The cost is that a restore could be a surprise, so it says
 * when it has done one and offers a way back.
 */
const SAVE_KEY = 'drawerforge:bins:v1';
const saveLocal = (h) => {
  try { localStorage.setItem(SAVE_KEY, h); }
  catch (err) { /* private mode, or the quota is full — losing the save is not worth
                   an exception that stops the page working */ }
};
const readLocal = () => { try { return localStorage.getItem(SAVE_KEY) || ''; } catch (err) { return ''; } };
/* Only a fragment that carries settings is a layout. The page has fragments of its own —
   the skip link's #stage — and one arriving as if it were a shared link loaded nothing,
   then saved the empty default over the drawer this browser had kept. */
const isLayoutHash = (h) => /(^|&)[^&=]+=/.test(h);
function startFresh() {
  try { localStorage.removeItem(SAVE_KEY); } catch (err) { /* nothing to clear */ }
  location.href = location.origin + location.pathname;   // drop the hash and reload clean
}
/* Wired here, before the boot below reads any link: a link that throws there must not
   also take away the button that gets you out of it, or stop the next link working. */
$('startFresh').addEventListener('click', startFresh);
/* A hash this page did not write means someone navigated to a link — pasted a share URL
   into the address bar, or picked a bookmark — and changing only the fragment is a
   same-document navigation, so nothing re-reads it and the drawer on screen stays put.
   Before local saving that was merely confusing; now it means a shared layout loses to
   whatever this browser had stored, which is the one case that must never happen.
   Reloading applies the link. replaceState does not fire this event, so the saves this
   page makes every few seconds cannot trigger it. A fragment with no settings in it is
   an anchor, not a link to a drawer, and reloading for one threw the drawer away. */
addEventListener('hashchange', () => {
  if (isLayoutHash((location.hash || '').replace(/^#/, ''))) location.reload();
});

/* More slots beside the save, so a layout is set aside rather than lost.
 *
 * PREV_KEY: following a link overwrote the save within 400 ms with no way back, so
 * whatever is about to replace it — a link, or the defaults standing in for a layout
 * that would not load — copies it here first, and the page offers to put it back.
 *
 * LINKED_KEY: the save a link wrote, while nobody has changed it. That save is the
 * sender's drawer, not yours, so a second link replacing it leaves PREV_KEY holding
 * yours; setting it aside instead lost your layout to the first link you had opened.
 * Changed, it is kept while the page still uses any of the link's drawer, bed and infill.
 *
 * PREV_LINKED_KEY: the LINKED_KEY of the layout in PREV_KEY. Whether a layout is a link's
 * travels with it, so a link put back is still the link's and your own put back is not;
 * left behind, it went to whatever was put back in its place.
 *
 * LOADING_KEY: names the layout being loaded, and is cleared once the page has drawn
 * it. Still there at the next visit, for the same layout, means the last attempt hung or
 * crashed the tab; loading it again would only do that again, on every visit. */
const PREV_KEY = SAVE_KEY + ':prev', LINKED_KEY = SAVE_KEY + ':linked',
  PREV_LINKED_KEY = PREV_KEY + ':linked', LOADING_KEY = SAVE_KEY + ':loading';
const readKey = (k) => { try { return localStorage.getItem(k) || ''; } catch (err) { return ''; } };
const writeKey = (k, v) => {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); }
  catch (err) { /* private mode: the guard and the backup go, the page does not */ }
};
let stalled = '';   // the layout the boot declined to load, for "Try it anyway"
/* Set the first time anyone changes a design on either tool, and never cleared. The
   template's <head> reads it, with the saved drawers, to draw the one-line header for a
   browser that has used the tools rather than only opened them: the save above is written
   within moments of any visit, so its being there said nothing, and a first visit that went
   from one tool to the other arrived at the second with its header already shortened. */
const USED_KEY = 'drawerforge:used:v1';
/* What an untouched page saves, and what this one held when the boot finished — null
   from the first change on. Until that change a stalled page saves nothing: saving the
   defaults it stands in with put them over the layout it declined, and one more reload
   lost that layout for good. */
let pristine = '', bootDesc = null;
/* Someone's link this page holds, or ''. Each of its drawer, bed and infill values the
   page still uses is the link's, not yours, whatever else has been changed: so taking
   the design to the other page does not replace yours there without setting it aside.
   Key by key: compared as one group, changing only the infill made the drawer yours. */
let heldLink = '';
// the drawer, bed and infill settings in which a design still has a link's values
function linkKeys(h, link) {
  if (!link) return [];
  const p = parseHash(h), q = parseHash(link);
  return [...SHARED_KEYS].filter((k) => k in q && p[k] === q[k]);
}
function leaveFor(url) {
  hashReady = false; clearTimeout(hashSaveT);   // no save of this page's may land after
  location.href = url;
}
/* Swapped rather than copied over: what is here now goes aside in its place, so putting
   a layout back is never the step that loses one. */
function putBack() {
  const prev = readKey(PREV_KEY);
  if (!prev) return;
  const prevLinked = readKey(PREV_LINKED_KEY);
  const cur = descString();
  if (cur && cur !== pristine && !(stalled && cur === bootDesc)) {
    writeKey(PREV_KEY, cur);
    writeKey(PREV_LINKED_KEY, heldLink);
  }
  saveLocal(prev);
  writeKey(LINKED_KEY, prevLinked);
  leaveFor(location.href.split('#')[0]);   // a bare visit restores it, and says so
}
function tryAnyway() {
  writeKey(LOADING_KEY, '');
  leaveFor(location.href.split('#')[0] + '#' + stalled);
  location.reload();   // a change of fragment alone reloads nothing
}
function showSetAside(msg, canPutBack, canTry) {
  $('setAsideMsg').textContent = msg;
  $('putBack').style.display = canPutBack ? '' : 'none';
  $('tryAnyway').style.display = canTry ? '' : 'none';
  $('setAside').style.display = '';
}
$('putBack').addEventListener('click', putBack);
$('tryAnyway').addEventListener('click', tryAnyway);

function rememberState() {
  if (!hashReady) return;
  clearTimeout(hashSaveT);
  addEventListener('beforeunload', dropSave);
  hashSaveT = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(hashSaveT);
  removeEventListener('beforeunload', dropSave);
  const h = descString();
  if (!h) return;
  /* The first change is the moment the banner stops being true: "put my layout back"
     would now also throw away the edit, so it goes. */
  if (bootDesc !== null) {
    if (sameDesign(h, bootDesc)) { if (stalled) return; }
    else {
      bootDesc = null; $('setAside').style.display = 'none';
      // what a stalled page goes on from is its defaults, not the link it declined
      if (stalled) writeKey(LINKED_KEY, '');
      writeKey(USED_KEY, '1');   // and this is someone using the tools (see USED_KEY)
    }
  }
  /* Marked as this tab's own, or as someone's link's while the page still holds it as
     it arrived (see ownMark). */
  try { history.replaceState(drawers.stamp(h, linkedNow && bootDesc !== null), '', '#' + h); }
  catch (err) { /* some browsers refuse replaceState on file:// — a lost URL is not
                   worth an exception that stops the rest of the page working */ }
  saveLocal(h);   // outside the try: a refused URL is no reason to lose the save too
  drawers.wrote(h);   // and into the saved drawer this is, if it is one
}
/* A reload takes the address as it stands when it starts, and the page runs on until the
   new one arrives. A save still waiting would land in that gap and record in the saved
   drawer a design the reloaded page did not arrive with, and the page came back unsaved.
   So a save still waiting when the page starts to go is dropped: the change it held is in
   neither the address nor the drawer, and the page comes back as both have it. The
   listener is there only while a save waits, because some browsers keep no page that
   listens for beforeunload in the back-forward cache. The page's own links to the other
   tool and the guide save first instead (leave, below), so a change made just before
   one is kept for Back. */
function dropSave() {
  clearTimeout(hashSaveT);
  removeEventListener('beforeunload', dropSave);
}
function shareLink() {
  return location.origin + location.pathname + '#' + descString();
}
// the same layout with the view stripped, so the README's bytes depend on the design
function designLink() {
  return location.origin + location.pathname + '#' + descString(VIEW_KEYS);
}
function loadFromHash(src) {
  const h = (src !== undefined ? src : location.hash || '').replace(/^#/, '');
  if (!h) return;
  const q = parseHash(h);
  for (const [k, val] of Object.entries(q)) {
    if (k === 'v') continue;
    if (k === 'bl') { const ls = unpackLayers(val); if (ls.length) layers = ls; continue; }
    // a menu takes only a value it offers; anything else leaves it blank and reads NaN
    if (k === 'bseg') {
      if ([...$('arcSegs').options].some((o) => o.value === val)) $('arcSegs').value = val;
      continue;
    }
    if (k === 'bdt') { $('divT').value = val; continue; }
    if (k === 'bdc') { $('divClr').value = val; continue; }
    if (k === 'bmd' || k === 'bmh') continue;     // below, once the plate's size is known
    // a checkbox, so it cannot ride the generic .value path below
    if (k === 'dv') { $('showDrawer').checked = val === '1'; continue; }
    if (k === 'bnotes') { pendingNotes = val; continue; }
    if (k === 'bf') { pendingFocus = val; continue; }
    if (k === 'bs') { pendingScratch = val; continue; }
    if (k === 'pr') continue;             // applied below, once the bed is in
    // not Object.hasOwn, which Safari only has from 15.4
    const id = Object.prototype.hasOwnProperty.call(KEYS, k) ? KEYS[k] : '';
    if (!id) { hashExtras[k] = val; continue; }
    const x = Number(val);
    if (val === '' || !isFinite(x) || x < 0 || (x === 0 && NEEDS_SIZE.has(k))) continue;
    /* Not the drawer: readControls holds it to the field's limit and Checks says so, as
       for a typed one. Cut down here, a 5 m drawer from a link was drawn 2 m wide with
       nothing said. The link is millimetres, always; a drawer length is written into its
       field in whatever unit the field is showing. */
    const max = k === 'w' || k === 'd' ? Infinity : KEY_MAX[k] || 2000;
    if (LENGTH_IDS.includes(id)) FIELDS.setLength($(id), Math.min(x, max), unit);
    else if ($(id)) $(id).value = String(Math.min(x, max));
  }
  // the list follows the bed: a link with a 180 mm bed must not reopen naming a 256 one
  $('bedPreset').value = FIELDS.presetFor($('bedPreset'), bedNow(), q.pr);
  /* The magnet: the bins' own size if the link has one, else the baseplate's, else 6 x 2.
     Anything that is not a number is not a size; readControls holds the rest to the
     fields' limits, so a link asking for a 1e9 mm magnet gets the widest a foot takes. */
  const md = magnetDefault();
  for (const [k, id, d] of [['bmd', 'magnetD', md.d], ['bmh', 'magnetH', md.h]]) {
    const x = Number(q[k]);
    $(id).value = String(q[k] !== undefined && q[k] !== '' && isFinite(x) ? x : d);
  }
}
/* Saved drawers live in src/shared-ui/drawers.js, shared with the baseplates page. What
   this page tells it is which keys of the design string are its own to write: exactly the
   ones loadFromHash above takes for itself rather than parking in hashExtras, so if one is
   added there it belongs here too. */
const BINS_OWN = new Set(['v', ...Object.keys(KEYS), 'pr', 'dv', 'bl', 'bseg', 'bdt', 'bdc',
                          'bmd', 'bmh', 'bnotes', 'bf', 'bs']);
const drawers = DRAWERS.create({
  tool: 'bins',
  owns: (k) => BINS_OWN.has(k),
  given: ['ph'],   // the baseplates page builds the plates, and says how tall they came out
  design: () => encodeDesc(descriptor()),
  stop: () => { clearTimeout(hashSaveT); hashReady = false; },
  els: {
    name: $('drawerName'), button: $('drawersBtn'), dialog: $('drawersDlg'),
    close: $('drawersClose'), form: $('drawersSaveForm'), input: $('drawersNewName'),
    list: $('drawersList'), now: $('drawersNow'), msg: $('drawersMsg'),
    exportOne: $('drawersExport'), exportAll: $('drawersExportAll'),
    importBtn: $('drawersImportBtn'), importInput: $('drawersImport'),
  },
});
/* Each hand-over leaves one note in this tab for the page at the other end to read once
   (handoff in drawers.js, which also tells the saved drawer, if this is one, so that page
   recognises the design it arrives with as that drawer — see attach there). A design
   arriving from the other tool may carry a drawer or bed changed there, and that is the
   same layout moving on, not a link replacing it. The guide passes the address through
   untouched, so going by way of it is the same.
   The note names any drawer, bed and infill settings still at someone's link's values:
   those are not yours to carry over, and the other page compares them as a link's, so
   they do not replace yours there without setting it aside. Left out of the comparison,
   they did, after any edit at all.
   A change still waiting to be saved is saved now, not dropped as the page goes: Back
   comes to this page's address, and that and the drawer must both have the change. */
function leave(href) {
  if (hashReady) saveNow();
  drawers.handoff(href.slice(href.indexOf('#') + 1), linkKeys(descString(), heldLink));
  location.href = href;
}
// the guide holds no state, so hand it ours and it can hand it back
$('navGuide').addEventListener('click', (e) => {
  e.preventDefault();
  leave('../guide/#' + descString());
});
$('shareBtn').addEventListener('click', () => {
  const link = shareLink();
  navigator.clipboard.writeText(link).then(
    () => { $('shareBtn').textContent = 'Copied ✓'; setTimeout(() => $('shareBtn').textContent = 'Copy layout link', 1600); },
    () => prompt('Copy this link:', link));
});
// the whole bins descriptor travels; baseplates re-emits what it doesn't own
function platesHref() { return '../#' + descString(); }
for (const id of ['toPlates', 'navPlates'])
  $(id).addEventListener('click', (e) => { e.preventDefault(); leave(platesHref()); });

/* ---------- boot ---------------------------------------------------------- */
let timer = null;
/* No cache clearing here any more: the geometry caches are keyed by everything a build
   reads, so an edit that changes a bin misses the cache by itself, and refresh() lets go
   of the builds nothing uses. Clearing on every input rebuilt every type in the drawer
   because a note was typed, and leaked the old buffers each time. */
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => {
  readControls(); drawLayerTabs(); drawMap(); refresh(); }, 180); };
for (const id of ['drawerW', 'drawerD', 'drawerH', 'plateH', 'infill', 'bedW', 'bedD', 'bedH', 'gap',
                  'u', 'v', 'hUnits',
                  'wall', 'floorT', 'divX', 'divY', 'solid', 'arcSegs',
                  'edgeF', 'edgeB', 'edgeL', 'edgeR', 'scoop', 'label', 'note',
                  'divRemovable', 'divT', 'divClr',
                  'lid', 'lidF', 'lidB', 'lidL', 'lidR',
                  'magnets', 'screws', 'holesWhere', 'magnetD', 'magnetH'])
  $(id).addEventListener('input', schedule);
/* The bin's number fields too: leaving one is when a value typed past its limit is put
   back to the one in use, and leaving fires change, not input. */
for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR', 'divRemovable',
                  'lid', 'lidF', 'lidB', 'lidL', 'lidR',
                  'magnets', 'screws', 'holesWhere', 'magnetD', 'magnetH', ...BIN_FIELDS])
  $(id).addEventListener('change', schedule);
$('presetTray').addEventListener('click', () => {
  for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR']) $(id).value = '0';
  $('solid').checked = false;
  readControls(); drawMap(); refresh();
});
$('solid').addEventListener('change', schedule);
$('arcSegs').addEventListener('change', schedule);
/* The drawer shell deliberately does not go through schedule(). That path redraws the
   map, the checks and the plan, which is the right thing for anything that changes what
   gets printed and pure waste for something that changes only what is drawn around it. */
const drawerViewChanged = () => { readControls(); showScene(); };
for (const id of ['showDrawer', 'drawerFrontH']) {
  $(id).addEventListener('input', drawerViewChanged);
  $(id).addEventListener('change', drawerViewChanged);
}
/* The handler is on the <button> inside the header, not on the <h2>.
   A bare heading with a click listener is only a control for a mouse, and because a
   closed panel's body is display:none there was nothing focusable inside it either —
   so panels 01 and 02, which load closed, put the drawer size and the printer bed
   beyond a keyboard entirely. There was no route to them at all, not a slow one.
   aria-expanded is written from the class rather than kept alongside it, so the two
   cannot drift: the class is what actually shows the panel. */
for (const btn of document.querySelectorAll('section.p>h2>button')) {
  const sec = btn.closest('section.p');
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-expanded', String(!sec.classList.toggle('closed')));
  });
}

$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('dupBtn').addEventListener('click', duplicateSelected);

function duplicateSelected() {
  if (selected < 0) return;
  const src = B()[selected];
  // first free spot scanning right then up from the original
  const g = grid();
  for (let dy = 0; dy < g.ny; dy++)
    for (let dx = 0; dx < g.nx; dx++) {
      const nx = src.x + dx, ny = src.y + dy;
      if (!dx && !dy) continue;
      if (!canPlace(nx, ny, src.u, src.v, -1)) continue;
      pushUndo();
      B().push(Object.assign({}, src, { x: nx, y: ny, edges: Object.assign({}, src.edges) }));
      selected = B().length - 1;
      readControls(); drawLayerTabs(); drawMap(); refresh();
      return;
    }
}

/* None of these keys reach the drawer while a dialog is open. The drawer behind it is
   not what you are working on: Ctrl+Z on a button in the Drawers dialog took back a
   step of the layout out of sight, and the dialog's Save then stored the layout as it
   was a step before. Delete and the arrows would have removed or moved the selected bin
   just as invisibly. */
document.addEventListener('keydown', (e) => {
  const t = e.target;
  /* A key typed into a field is the field's, and goes no further — except Escape in a field
     of the phone's bin sheet. The sheet is in the way of the map the way a dialog is, and
     its fields are where focus mostly is while it is up, so the key that puts it away has
     to work from them. Nothing in it means anything else there: a number or a checkbox
     does nothing with Escape, an open menu's list takes the key for itself and closes, and
     the note's text is not touched. An IME still composing keeps it. */
  const sheetField = e.key === 'Escape' && !e.isComposing && PHONE.matches &&
    document.body.classList.contains('binsheet') && $('s-bin').contains(t);
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') &&
      !sheetField) return;
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (e.key === 'Escape' && carving) { e.preventDefault(); carving = false; readControls(); drawMap(); return; }
  /* Carving first, focus second — so Escape backs out one layer at a time rather than
     dropping you all the way to the drawer from inside the carve grid. */
  if (e.key === 'Escape' && focused) { e.preventDefault(); leaveFocus(); return; }
  /* And the phone's bin sheet, which is in the way of the map the way a dialog is. Not
     when the Escape was for something else: the right-click menu marks its own, and the
     expanded preview is closed by chrome.js on the same key. */
  if (e.key === 'Escape' && !e.defaultPrevented && PHONE.matches &&
      document.body.classList.contains('binsheet') &&
      !document.body.classList.contains('previewlock')) {
    e.preventDefault(); closeSheet(); return;
  }
  if (selected < 0) return;
  const b = B()[selected];
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); pushUndo();
    for (const i of selAll().sort((x, y) => y - x)) B().splice(i, 1);
    clearSel();
    readControls(); drawLayerTabs(); drawMap(); refresh(); return;
  }
  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
  if (nudge) {
    e.preventDefault();
    const [dx, dy] = nudge;
    if (e.shiftKey) {                       // shift-arrow grows or shrinks instead
      const nu = Math.max(1, b.u + dx), nv = Math.max(1, b.v + dy);
      if (canPlace(b.x, b.y, nu, nv, selected)) { pushUndo(); setFootprint(b, nu, nv); }
    } else if (canPlace(b.x + dx, b.y + dy, b.u, b.v, selected)) {
      pushUndo(); b.x += dx; b.y += dy;
    }
    writeControls(b); readControls(); drawMap(); refresh();
  }
});

/* The remembered unit goes on before anything is loaded, so a drawer from a link or a
   save lands in the unit the fields show. It converts the markup's own millimetres, not
   whatever is in the fields: a browser that refills a form on reload refills it in the
   unit it was showing, and converting those figures as millimetres would turn a 12 in
   drawer into 0.47 in. The link or the save then writes the real values. */
if (FIELDS.savedUnit() !== unit) {
  for (const id of LENGTH_IDS) $(id).value = $(id).defaultValue;
  applyUnit(FIELDS.savedUnit());
}
/* Whether two saves hold the same bins, compared setting by setting on what this page
   owns. Compared as strings, the baseplates page handing the drawer back — its keys in
   its own order, with its own extras — was a link that had replaced your layout, on
   every trip there and back. A hand-over also leaves out the drawer and the bed, the
   settings the two pages share: changing them on the other page is not a different
   layout, unless the other page still had them from someone's link. A link from someone
   keeps them, since a drawer of another size is exactly what one brings. The view keys
   are left out always: how the design is looked at is not what it is. */
// the drawer, the bed and its printer, and the infill: drawers.js keeps the same list
const SHARED_KEYS = new Set([...DRAWERS.SHARED].filter((k) => k !== 'v'));
const OWN_KEYS = [...Object.keys(KEYS), 'pr', 'bl', 'bs', 'bseg', 'bdt', 'bdc', 'bmd', 'bmh', 'bnotes']
  .filter((k) => k !== 'ph' && !VIEW_KEYS.includes(k));
function sameDesign(a, b, skip = []) {
  const p = parseHash(a), q = parseHash(b);
  return OWN_KEYS.every((k) => skip.includes(k) || p[k] === q[k]);
}
/* A link beats a saved layout, always. Reading the hash first and only falling back
   means a shared drawer is never quietly replaced by the recipient's own. */
const incomingHash = (location.hash || '').replace(/^#/, '');
let linkedNow = false;   // this page holds a link's layout, not yet changed by anyone
let linkNew = false;     // ...one that arrived on this visit, so is recorded afresh
let linkKept = '';       // the link this page last opened, unless a hand-over came since
let notLinked = [];      // settings a link arrived with that were yours on the other page
let arrivedWith = '';    // the design string this page was opened with
{
  const fromLink = isLayoutHash(incomingHash);
  const saved = readLocal();
  const src = fromLink ? incomingHash : saved.length > 2 ? saved : '';
  /* What this page saves when nobody has touched it. A save that is only that is no
     one's work, so replacing it sets nothing aside — or every link would offer the
     defaults back. */
  readControls();
  pristine = descString();
  stalled = src && readKey(LOADING_KEY) === src ? src : '';
  /* The tab's note of what this page arrives with, if it is this design: the other tool
     or the guide handing it over, or a saved drawer opened. Read every time, so a stale
     note never lingers. */
  const note = drawers.arrival(incomingHash);
  /* An address this tab wrote: a reload, or Back to an earlier page of yours. Never
     someone's link, however far the save has moved on since — in another tab of this
     tool, or on a later page in this one. */
  const own = fromLink && !!note && note.own;
  const handOver = fromLink && note && !note.own ? note : null;
  // a saved drawer opened from the list is yours, whatever it replaces
  const opened = !!handOver && handOver.open;
  // your own drawer, bed and infill settings, as the other page had them
  const yours = handOver ? [...SHARED_KEYS].filter((k) => !handOver.link.includes(k)) : [];
  // the other page had nothing of anyone's link: your own layout come back
  const handedOver = !!handOver && (opened || !handOver.link.length);
  notLinked = handOver ? yours : [];
  const replaces = fromLink && !opened && !own &&
    (saved.length <= 2 || !sameDesign(saved, src, yours));
  /* Your own layout handed over onto a save that is some saved drawer's — the other
     drawer's half, when a drawer was opened on the other page — replaces nothing that is
     only here: it is kept in that drawer. So nothing is set aside, and nothing is said.
     A hand-over still carrying someone's link is that link arriving, and says so. */
  const kept = !!handOver && !handOver.link.length && saved.length > 2 && drawers.holds(saved);
  /* Your own earlier page come back over a later layout that is only here: Back past a
     change, or a reload in a tab whose address another tab has moved on from. Going back
     is what you asked for, but the later layout would be gone at the first save, so it
     goes aside and Put back brings it back. One that a saved drawer holds is still in
     that drawer, and the page catches up with it instead. */
  const back = own && saved.length > 2 && !sameDesign(saved, src) && !drawers.holds(saved);
  const linked = readKey(LINKED_KEY);
  linkKept = handedOver ? '' : linked;
  /* Compared on what the record holds: one made without the settings that came with
     the link as yours does not count those, or your own drawer made it "changed", and a
     second link set it aside over the layout the first had. */
  const savedLinked = saved.length > 2 && !!linked && sameDesign(saved, linked,
    [...SHARED_KEYS].filter((k) => !(k in parseHash(linked))));
  /* Set aside whatever is about to be replaced: by a different layout, by an earlier one
     of yours, or by the defaults standing in for one that would not load. Not a link's own
     layout, untouched: what that link replaced is already set aside, and it is the one
     you would want back. */
  const aside = saved.length > 2 && saved !== pristine && !savedLinked &&
    ((replaces && !kept) || back || !!stalled);
  if (aside) {
    writeKey(PREV_KEY, saved);
    writeKey(PREV_LINKED_KEY, linkKeys(saved, linked).length ? linked : '');
  }
  const canPutBack = (replaces && !kept && (aside || (savedLinked && !!readKey(PREV_KEY)))) ||
    (back && aside);
  if (stalled) {
    showSetAside('This layout did not finish loading last time, so the page has started ' +
      'from its defaults rather than try it again.', canPutBack, true);
  } else if (src) {
    writeKey(LOADING_KEY, src);
    loadFromHash(src);
    if (!fromLink) $('restored').style.display = '';
    else if (canPutBack) {
      showSetAside(back ? 'This page went back to an earlier layout of yours. The later one is set aside.'
        : 'This link replaced the layout you had here.', true, false);
    }
    /* A hand-over is your own layout come back from the other page, never someone's
       link, even onto an empty save; and one that moved the drawer or bed on has been
       changed, by you, there. One still holding a link's settings is that link's. */
    linkedNow = handedOver ? false
      : fromLink ? replaces || (savedLinked && sameDesign(saved, src))
      : savedLinked;
    linkNew = fromLink && replaces && !handedOver;
    arrivedWith = src;
  }
}
/* Applied after the layout so indices line up, and only in the shape descriptor writes:
   a list per layer of notes. A note that is not a string is left out, and one that is
   is cleaned to what the field could have made. A number where a note should be
   stopped the map's labels drawing, and a mangled link should not stop the tool
   loading. */
if (pendingNotes) {
  let all = null;
  try { all = JSON.parse(pendingNotes); } catch (err) { /* left out whole */ }
  (Array.isArray(all) ? all : []).forEach((ns, k) => (Array.isArray(ns) ? ns : []).forEach((n, i) => {
    if (typeof n === 'string' && layers[k] && layers[k].bins[i]) layers[k].bins[i].note = cleanNote(n);
  }));
}
readControls();
hashReady = true;                         // loadFromHash has had its say; ours may start
initThree();
initMap();
drawLayerTabs();
drawMap();
refresh();
updateUndoButtons();

/* A link or a saved layout that was focused on a bin opens focused on that bin. The
   alternative — landing in the drawer after a refresh — is a small thing that happens
   at the worst moment, since the reason to be in focus is that the drawer is the part
   you did not want to look at. Indices are safe to trust here because the same hash
   carried the layout they point into. */
if (pendingScratch) {
  const ls = unpackLayers(pendingScratch);
  const b = ls[0] && ls[0].bins[0];
  if (b) {
    scratch = b;
    focused = true;
    frameBin();
    setPanel('s-bin', true);
    writeControls(scratch);
    readControls(); drawMap(); refresh();
  }
} else if (pendingFocus) {
  const [lk, ix] = String(pendingFocus).split('.').map(Number);
  if (layers[lk] && layers[lk].bins[ix]) {
    cur = lk; clearSel(); selected = ix; layers[lk].bins[ix].sel = true;
    drawLayerTabs();
    enterFocus();
  }
}
bootDesc = descString();
/* Laid out and drawn, so the marker has done its job. A stalled layout keeps its marker:
   reloading the same link must be declined again, not tried again. */
if (!stalled) {
  writeKey(LOADING_KEY, '');
  /* A link that arrived on this visit is recorded as it is, less any drawer, bed or infill
     settings that came with it as yours: kept, they were the link's from then on, and a
     later trip that changed them on the other page was a link replacing your layout
     there. The same link reloaded or reopened keeps its record, which writing it afresh
     filled back in. A changed one is kept while the page still uses any of its values,
     so a reload does not turn those into yours. */
  const keep = !linkedNow ? (linkKeys(bootDesc, linkKept).length ? linkKept : '')
    : !linkNew ? linkKept
    : bootDesc.split('&').filter((kv) =>
      !notLinked.includes(kv.slice(0, kv.indexOf('=')))).join('&');
  writeKey(LINKED_KEY, keep);
  heldLink = keep;
}
// after focus is restored too, so the design it compares against is the one on screen
drawers.attach(arrivedWith);

/* Applied straight to the selection rather than through readControls, for the reason
   given where doneRow is hidden: readControls also writes `state`, the template for the
   next bin you draw. */
/* The snapshot goes on BEFORE the change, like every other edit. Taken after, it was
   the marked state itself, so the first Undo restored what was already there and
   appeared to do nothing. */
$('done').addEventListener('change', () => {
  pushUndo();
  for (const i of selAll()) B()[i].done = $('done').checked;
  drawMap(); refresh();
});
const markAll = (v) => () => {
  pushUndo();
  for (const L of layers) for (const b of L.bins) b.done = v;
  drawMap(); refresh();
};
$('markAllDone').addEventListener('click', markAll(true));
$('markNoneDone').addEventListener('click', markAll(false));


/* ---------- right-click menu ---------------------------------------------- */
/* The actions you want on a bin are spread across three panels and a keyboard
 * shortcut list: delete is a button in the rail, duplicate is another, the printed
 * mark is a checkbox two panels up, and moving a bin between layers could not be done
 * at all — you deleted it and drew it again on the other tab. A right-click on the
 * thing itself is where people look for all of that.
 *
 * Offered on the map AND in the preview, because the preview is where you notice that
 * a bin is in the wrong layer: the map only ever shows one layer at a time.
 *
 * Built on open rather than kept in the markup, since half the entries depend on which
 * bin was clicked — which layers it could move to, and whether it is already printed.
 */
let ctxFor = null;                     // { layer, index } while the menu is open
function closeMenu() {
  const m = $('ctxmenu');
  if (!m.hidden) { m.hidden = true; m.innerHTML = ''; }
  ctxFor = null;
}
function menuItem(label, fn, opts) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.setAttribute('role', 'menuitem');
  if (opts && opts.disabled) b.disabled = true;
  else b.addEventListener('click', () => { closeMenu(); fn(); });
  return b;
}
function openMenu(clientX, clientY, layerIdx, idx) {
  closeMenu();
  const m = $('ctxmenu');
  const b = layers[layerIdx].bins[idx];
  if (!b) return;
  ctxFor = { layer: layerIdx, index: idx };

  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = `${b.u}\u00d7${b.v}\u00d7${b.hUnits}` + (b.note ? ` \u2014 ${b.note}` : '');
  m.appendChild(head);

  /* Acting on a bin selects it first. Every action below already works on the
     selection, and a menu that acted on something other than what is highlighted
     would be its own kind of surprise. */
  const pick = () => {
    if (layerIdx !== cur) { cur = layerIdx; drawLayerTabs(); }
    clearSel(); selected = idx; B()[idx].sel = true;
    writeControls(B()[idx]); readControls();
  };

  m.appendChild(menuItem(b.done ? 'Mark as not printed' : 'Mark as printed', () => {
    pushUndo(); layers[layerIdx].bins[idx].done = !b.done;
    drawMap(); refresh();
  }));
  m.appendChild(menuItem('Rename\u2026', () => {
    pick();
    setPanel('s-bin', true);
    $('note').focus(); $('note').select();
    drawMap(); refresh();
  }));
  /* The other way in. The button in panel 03 needs the bin selected and that panel
     open; this is the one you reach from the bin itself, on the map or in the preview —
     which is where you are standing when you decide you want it on its own. */
  m.appendChild(menuItem('Edit on its own', () => { pick(); enterFocus(); }));
  m.appendChild(menuItem('Duplicate', () => { pick(); duplicateSelected(); }));

  /* Moving between layers. Only the layers it actually fits in are offered — a bin
     dropped onto an occupied cell would either overlap or vanish, and finding out
     which after the click is not a choice worth giving anyone. */
  const sep = document.createElement('div'); sep.className = 'sep'; m.appendChild(sep);
  const targets = layers.map((_, k) => k).filter((k) => k !== layerIdx);
  if (!targets.length) m.appendChild(menuItem('Move to layer\u2026', null, { disabled: true }));
  /* Cell against cell, not box against box: an L and a bin sitting in its notch have
     overlapping boxes and no cell in common, and the box test called that layer
     occupied. */
  const mine = new Set(binCells(b).map(([dx, dy]) => (b.x + dx) + ',' + (b.y + dy)));
  for (const k of targets) {
    const clash = layers[k].bins.some((o) =>
      binCells(o).some(([dx, dy]) => mine.has((o.x + dx) + ',' + (o.y + dy))));
    m.appendChild(menuItem(`Move to layer ${k + 1}${clash ? ' (occupied)' : ''}`, () => {
      pushUndo();
      const [moved] = layers[layerIdx].bins.splice(idx, 1);
      layers[k].bins.push(moved);
      clearSel(); cur = k; selected = layers[k].bins.length - 1;
      layers[k].bins[selected].sel = true;
      writeControls(layers[k].bins[selected]);
      readControls(); drawLayerTabs(); drawMap(); refresh();
    }, { disabled: clash }));
  }
  m.appendChild(menuItem('Move to a new layer on top', () => {
    pushUndo();
    const [moved] = layers[layerIdx].bins.splice(idx, 1);
    layers.push({ bins: [moved] });
    clearSel(); cur = layers.length - 1; selected = 0; layers[cur].bins[0].sel = true;
    writeControls(layers[cur].bins[0]);
    readControls(); drawLayerTabs(); drawMap(); refresh();
  }));

  const sep2 = document.createElement('div'); sep2.className = 'sep'; m.appendChild(sep2);
  m.appendChild(menuItem('Delete', () => {
    pushUndo();
    layers[layerIdx].bins.splice(idx, 1);
    clearSel(); readControls(); drawLayerTabs(); drawMap(); refresh();
  }));

  /* Placed after measuring, so a menu opened near the right or bottom edge folds back
     into the window instead of hanging off it. */
  m.hidden = false;
  m.style.left = '0px'; m.style.top = '0px';
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(clientX, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(clientY, innerHeight - r.height - 4)) + 'px';
  const first = m.querySelector('button:not([disabled])');
  if (first) first.focus();
}
/* Arrow keys and Escape, because a menu you can open with the keyboard and not leave is
   worse than no menu. */
$('ctxmenu').addEventListener('keydown', (e) => {
  const items = [...$('ctxmenu').querySelectorAll('button:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { closeMenu(); $('fillmap').focus(); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); }
});
addEventListener('pointerdown', (e) => { if (!$('ctxmenu').contains(e.target)) closeMenu(); }, true);
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);

