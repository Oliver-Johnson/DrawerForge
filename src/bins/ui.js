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
let pendingScratchNote = null;  // ...and its note, which travels beside it (bsn)
let noteHeld = new WeakSet();   // bins whose raised note is past RAISED_MAX (holdNotes)
let notesOver = 0;              // ...and how many different notes that is
let insertHeld = new WeakSet(); // bins whose holes are past HOLES_MAX for the layout (holdHoles)
let holesOver = { used: 0, kinds: 0, holes: 0 };   // ...what was built, and what was not
const geoCache = new Map();

const B = () => layers[cur].bins;
// every selected index, primary first, filtered to bins that still exist
const selAll = () => (selected < 0 ? []
  : [selected, ...selExtra].filter((v, i, a) => a.indexOf(v) === i && B()[v]));
const clearSel = () => { selected = -1; selExtra.clear(); };
/* The bin focus is pointed at, whichever kind it is. Null whenever focus is off. */
const fBin = () => (!focused ? null : scratch || (selected >= 0 ? B()[selected] : null));
const LIP_H = lipHeight(0.55);
/* The most whole units that stand in `room` millimetres with a stacking lip on top —
   the same sum the drawer-height check makes, run backwards, so the count it names is
   one the check then passes. Zero when not even one unit fits. */
const unitsUnder = (room) => Math.max(0, Math.floor((room - LIP_H + 0.001) / SPEC.unitH));

/* The filament price and the printer speed override, in panel 02. They are yours and not
   the layout's, so ESTIMATE keeps them on this device, shared with the baseplates page,
   and they never reach the link or a saved drawer. A change redraws the figures and
   nothing else: no bin changes because a spool got dearer. Bound here, at the top,
   because refresh() reads it and refresh() can run from any of the boot paths below. */
const est = ESTIMATE.bind({ price: $('filPrice'), sym: $('filSym'), speed: $('printSpeed'),
                            err: $('filPriceErr') },
                          // the dialog too: a price typed on the other page arrives here
                          () => { refresh(); if ($('exportDlg').open) renderExport(); });

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
  /* A plate with half cells in its leftover (see halfStrips in core.js) has the same
     whole cells, and its margins take the strip on the right and the back: asked as
     'auto', the drawer was drawn up to half a cell off where the plate sits in it. The
     strip is not offered to bins here yet, so to this page it is margin. */
  const c = gridCells({ drawerW: W, drawerD: D, pitch: SPEC.pitch,
    marginMode: pm ? 'custom' : hashExtras.mm === 'half' ? 'half' : 'auto',
    alignX: hashExtras.ax, alignY: hashExtras.ay,
    mLeft: pm ? Math.min(pm.l, W) : 0, mRight: pm ? Math.min(pm.r, W) : 0,
    mFront: pm ? Math.min(pm.f, D) : 0, mBack: pm ? Math.min(pm.b, D) : 0 });
  return { nx: Math.max(1, Math.min(GRID_MAX, c.nx)), ny: Math.max(1, Math.min(GRID_MAX, c.ny)),
           mL: c.mL, mR: c.mR, mF: c.mF, mB: c.mB };
}
function grid() {
  const { nx, ny } = plateCells(state.drawerW, state.drawerD);
  const avail = state.drawerH - state.plateH;
  /* By the drawer-height check's own sum, rounding allowance and all: without it 69.1 mm
     less a 2.15 mm plate came to 8.999… units here, and the summary said 8 where Checks
     said 9. */
  return { nx, ny, avail, maxUnits: Math.max(1, unitsUnder(avail)) };
}
/* Whether the drawer leaves no room above the baseplate. A link can hand this page a
   baseplate as tall as the drawer or taller, and Checks, the panel and the README gave
   the room all the same: "only -4.3 mm is available above the baseplate". They say so in
   words instead, whyNoRoom's, from the two heights (`also` is the panel's inches). Under
   0.05 mm shows as 0.0, or -0.0, so that is none too. */
const noRoomAbove = (g) => !(g.avail >= 0.05);
const whyNoRoom = (also = () => '') => `the baseplate alone is ${+state.plateH.toFixed(2)} mm${also(state.plateH)} ` +
  `tall and the drawer's usable height is ${+state.drawerH.toFixed(2)} mm${also(state.drawerH)}`;
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
                         /* the note goes in only to be raised on the shelf (labelMode 1),
                            and not past the most one layout raises (holdNotes) */
                         labelMode: noteHeld.has(b) ? 0 : b.labelMode, note: b.note,
                         /* holes across the floor are per bin, their clearance the page's,
                            and not past the most one layout builds (holdHoles) */
                         insert: insertHeld.has(b) ? 0 : b.insert, insertDepth: b.insertDepth,
                         holeClr: state.holeClr,
                         // a dip in the top of each wall ticked, one per compartment
                         fingerSlots: b.fingerSlots,
                         arcSegs: state.arcSegs });
/* The dividers a bin is built with: removable ones no more than leave every slot room
   for its plate at the page's plate and clearance and keep the end ones out of the rounded
   corners (railedMost), however many it asks for.
   The plates, the names and Checks all go by these, so they say what is built. None on a
   bin with holes across its floor, which the holes divide, as buildBin builds it
   (binDividers, which asks the holes as holesIn does), with the new-bin settings at a
   1x1 as these are. A bin with finger slots ticked asks the holes of its kept plan
   (insertPlanOf), as binDividers would ask them of the slots all over again. */
const builtDivs = (b) => {
  const c = Object.assign(binCfg(b), { u: b.u || 1, v: b.v || 1 });
  if (!(b.u && b.v && fingerPlan(b))) return binDividers(c);
  return +c.insert > 0 && insertPlanOf(b).n ? { divX: 0, divY: 0 } : dividersBuilt(c);
};
// and how many compartments they make, or 0 for a bin with none
const compartments = (b) => {
  const d = builtDivs(b);
  return d.divX || d.divY ? (d.divX + 1) * (d.divY + 1) : 0;
};
const edgeSig = (b) => EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)).join(',');
const allFullEdges = (b) => EDGES.every((k) => !b.edges || b.edges[k] === undefined || b.edges[k] >= 1);
/* ---------- finger slots ----------------------------------------------------
   A dip in the top of each wall ticked, one per compartment (fingerSlots in bin.js),
   which takes the stacking lip away as a lowered wall does. bin.js decides where each
   goes and what makes way: fingerSlotPlan, worked out without building anything. A bin
   that asks for none is answered without asking it, and is the bin it always was. */
const FINGER_WALLS = { f: 'front', b: 'back', l: 'left', r: 'right' };
const fingersAsked = (b) => !b.solid && !!b.fingerSlots && FINGER_SIDES.some((k) => b.fingerSlots[k]);
/* Kept by the settings that asked it: a refresh asks it of each bin several times over,
   for its key, its name, its lip, Checks and its weight, and 63 slotted bins spent 19 ms
   a refresh on it. fingerSlotPlan is pure, so the same settings have the same answer,
   and nothing here changes one. */
const fingerPlans = new Map();
const fingerPlan = (b) => {
  if (!fingersAsked(b)) return null;
  const cfg = binCfg(b), key = JSON.stringify(cfg);
  let p = fingerPlans.get(key);
  if (!p) {
    if (fingerPlans.size >= 500) fingerPlans.clear();
    fingerPlans.set(key, (p = fingerSlotPlan(cfg)));
  }
  return p;
};
// the walls that really get one, 'fb', or '' for none
const fingersBuilt = (b) => { const p = fingerPlan(b); return p ? p.built : ''; };
// "front", "front and back", "front, left and right"
const wallList = (ks) => {
  const n = [...ks].map((k) => FINGER_WALLS[k]);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};
// "2 finger slots, front and back", for the rows and the README, or ''
const fingerText = (b) => {
  const p = fingerPlan(b);
  return p && p.n ? `${plural(p.n, 'finger slot')}, ${wallList(p.built)}` : '';
};
/* The scoop and the label shelf a bin is built with, for its key and its name, which go
   by what it is built with: two bins built alike are one part. A front slot holds the
   scoop under it, so 15 and 25 mm asked for are both built at what it is held to; a back
   slot leaves the shelf off, so a shelf asked for is no shelf, unless the holes across
   the floor kept clear of it all the same (holesGaveWay): then how deep it would have
   been is where they are, and the bin is keyed by that, the depth it is laid out to. The
   depth asked for is not it: on a bin too short for a 20 mm shelf it is laid out 15 deep,
   and 14 with a note raised on it, which the slot keeps from printing, so two bins asking
   for 20 kept their holes a millimetre apart under one key. A bin with no slots is keyed
   and named by what it asks for, as it always was. Both read the bin's slot plan
   (fingerPlan), the one buildBin builds it from and binVolume weighs it by: the scoop a
   front slot holds is the radius scoopBuilt gives both, with removable plates too, whose
   own cap is the higher. */
const scoopAsBuilt = (b) => {
  const p = fingerPlan(b);
  return p && p.scoop !== null ? +p.scoopNow.toFixed(3) : b.scoop;
};
const labelAsBuilt = (b) => {
  const p = fingerPlan(b);
  if (!(p && p.shelfOff)) return b.label;
  return p.holesGaveWay && holesIn(b) ? +p.floor.shelf.depth.toFixed(3) : 0;
};
/* Whether the bin has its stacking lip: not a solid block, nor one with a wall lowered
   or a finger slot in one. The same test buildBin makes. */
const hasLip = (b) => !b.solid && allFullEdges(b) && !fingersBuilt(b);
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
/* ---------- holes across the floor -----------------------------------------
   A bin set to hold batteries, cells or hex bits (insert) is built with a block of holes
   across its floor: bin.js decides how many, where and how deep (insertPlan), and leaves
   the dividers and the scoop off a bin that has them. What a bin really gets, insertPlan's
   answer, or null when it gets no holes: none asked for, a solid block, a carved shape,
   or none that fit. Worked out without building anything, so it is cheap to ask. */
const holesIn = (b) => {
  if (!(+b.insert > 0) || b.solid) return null;
  const h = insertPlanOf(b);
  return h.n ? h : null;
};
// "16 holes for AA batteries", for the rows and the README, or ''
const insertText = (b) => { const h = holesIn(b); return h ? `${plural(h.n, 'hole')} for ${h.p.items}` : ''; };
/* insertPlan's answer for a bin, taken from its kept finger slot plan where it has one
   (fingerPlan): with slots ticked insertPlan works them all out again to say where the
   holes go, some 25 times a bin a refresh, and a refresh of 63 bins with a back slot over
   AA cells took about 40 ms where it takes 10. */
function insertPlanOf(b) {
  const p = fingerPlan(b);
  return p && p.floor ? p.floor.holes : insertPlan(binCfg(b));
}
/* Why the holes across a bin's floor keep clear of where its label shelf would be, when a
   finger slot in its back wall takes the shelf away (holesGaveWay in bin.js), or null when
   they do not: spread into the shelf's room they would come to more than one bin is built
   with, or stand too high for a slot. `its` is how the bin is spoken of: 'its' in Checks,
   'their' for several bins at once, 'the' in the hint. `room` is why, said after "kept
   clear of where the shelf would be"; `instead` is what the bin has asked for no shelf,
   for a slot that would go. */
function keptClearSay(b, its) {
  const g = (fingerPlan(b) || {}).holesGaveWay;
  if (!g) return null;
  if (g.why === 'many')
    return { many: true, count: g.without.count,
             room: `since spread into that room there would be ${g.without.count} holes, more than the ` +
               `${HOLES_MAX} one bin is built with` };
  const more = g.walls.length > 1 || its === 'their', s = more ? 's' : '';
  const walls = `${its} ${wallList(g.walls)} wall${s}`;
  // the hint has just named the back wall's slot: that one is "that slot"
  return { many: false, slots: g.walls === 'b' ? 'that slot' : `the finger slot${s} in ${walls}`,
           room: `to leave room for the finger slot${s} in ${walls}`,
           instead: `${plural(g.without.n, 'hole')} and no finger slot${s} in ${walls}` };
}
/* A bin with holes is a part of its own (typeKey): which kind, the hole as built (the
   page's clearance is in it, as the rails' sizes are in a railed bin's key) and how deep.
   Its dividers and scoop are not built, so they leave its key; a bin asked for holes that
   it does not get is the plain part, and keyed as one. */
const insertKey = (b) => {
  const h = holesIn(b);
  return h ? `-i${+b.insert}w${+h.d.toFixed(3)}d${+h.depth.toFixed(3)}` : '';
};
/* The holes' hint under the menu: what is built, or why nothing is. [lead, rest], the
   rest for behind "more". Written with textContent, through DF.hint, like the note's. `b`
   is the bin the panel shows, or the settings for new bins. */
function insertHintSay(b) {
  const S = INSERT_SPEC, mm = (x) => +x.toFixed(1);
  /* Held for its own count, or after one that was: the first holes are the first in the
     layout, so a few that would fit after a kind that did not are held as well. */
  if (insertHeld.has(b)) {
    const n = insertPlan(Object.assign(binCfg(b), { insert: b.insert })).n;
    return [holesOver.used + n > HOLES_MAX
      ? `This layout already builds ${holesOver.used} holes across other bins' floors, and this bin's ` +
        `${n} would take it past the ${HOLES_MAX} one layout builds, so it is built without them.`
      : `Bins before this one in the layout already ask for more holes than the ${HOLES_MAX} one layout ` +
        `builds, so this bin is built without its ${plural(n, 'hole')}.`,
    'Set some of the others to Nothing, or print some bins as a layout of their own.'];
  }
  const h = insertPlanOf(b);
  if (h.why === 'off' || h.why === 'solid') return ['', ''];
  const p = h.p;
  if (h.why === 'carved') return ['Holes need a rectangle, so a carved shape is built without them.', ''];
  const size = `Each hole is ${+h.d.toFixed(2)} mm ${p.shape === 'hex' ? 'across the flats' : 'across'}, ` +
    `the largest ${p.items} with ${+(h.d - p.size).toFixed(2)} mm to spare.`;
  /* A finger slot in the back wall takes the shelf away, and the holes spread into its
     room unless that is more than one bin is built with or stands them too high for a
     slot: then they keep clear of where it would be (holesGaveWay), and are said to, with
     what the bin would have with no shelf asked for. Kept for being too many, the bin has
     the holes it had with the shelf; kept for standing too high, it has none, since any
     the shelf's layout had would stand too high as well. Never too short for them: a bin
     tall enough for a back slot has room for holes under the shelf. */
  const gave = keptClearSay(b, 'the');
  const why = gave ? 'The finger slot in the back wall takes the label shelf away, but spread into its room ' +
    (gave.many ? `there would be ${gave.count} holes, more than the ${HOLES_MAX} one bin is built with.`
      : `the holes would stand too high for ${gave.slots}.`) : '';
  const instead = gave && !gave.many ? ` Asked for no label shelf, this bin has ${gave.instead}.` : '';
  const under = h.under === 'shelf' ? (gave ? 'where the label shelf would be' : 'the label shelf') : 'the rim';
  if (h.why === 'short')
    return [`This bin has room for holes ${h.room > 0.05 ? `only ${mm(h.room)} mm deep` : 'no depth at all'} ` +
            `under ${under}, and they need ${S.minDepth} mm, so it has none.`,
            `A taller bin has room for them${h.shelf ? ', and so has one without a label shelf' : ''}.`];
  if (h.why === 'none')
    return gave
      ? [`The holes keep clear of where the label shelf would be, ${gave.room}, and in front of it there is ` +
         `no room for even one hole for ${p.items}.`, `${why}${instead} ${size}`]
      : h.byShelf
      ? [`The label shelf leaves no room in front of it for even one hole for ${p.items}.`,
         `A shallower shelf, or none, has room for them. ${size}`]
      : [`Not one hole for ${p.items} fits in a bin this size.`, size];
  if (h.why === 'many')
    return [`A bin this size would have ${h.count} holes for ${p.items}, more than the ${HOLES_MAX} one bin ` +
            'is built with, so it has none.', `Smaller bins have fewer: each is built with up to ${HOLES_MAX}. ${size}`];
  const want = h.asked ? +b.insertDepth : Math.max(S.autoMin, p.len / 3);
  /* Below the rim is under where a bin stacked on this one comes down, S.seat under it.
     Items stopping between the two are under the rim and still in that bin's way, so
     they are said to need the taller bin, and the rest says why. */
  const lead = `${plural(h.n, 'hole')}, ${mm(h.depth)} mm deep. ${p.say} are ${p.len} mm long, ` +
    (h.over > 1e-9 ? `so this bin needs ${plural(h.units, 'unit')} to keep them below the rim.`
      : 'so they stay below the rim.');
  const off = [b.divX || b.divY ? 'Dividers' : '', b.scoop ? 'the scoop' : ''].filter(Boolean);
  const rest = [
    size,
    gave ? `They keep clear of where the label shelf would be: ${why[0].toLowerCase()}${why.slice(1)}` : '',
    h.over > 1e-9 && !(h.above > 1e-9) ? `They stop ${mm(-h.above)} mm under the rim, and a bin stacked ` +
      `on this one comes down ${S.seat} mm into it.` : '',
    h.capped ? `${h.asked ? `${mm(want)} mm` : `A third of their length, ${mm(want)} mm,`} is more than ` +
      `this bin has room for, so the holes stop ${S.headroom} mm under ${under}.`
      : !h.asked ? `Left blank, the depth is a third of their length, at least ${S.autoMin} mm.` : '',
    off.length ? `${off.length > 1 ? 'Dividers and the scoop are' : off[0] === 'Dividers' ? 'Dividers are'
      : 'The scoop is'} left off a bin with holes.` : '',
  ].filter(Boolean).join(' ');
  return [lead, rest];
}
/* The most holes one layout builds, over its different parts in layout order, as
   holdNotes holds raised notes: a bin is built from its part, so two alike cost one
   build. Every bin can have up to HOLES_MAX (bin.js), and a drawer of different ones
   could ask for them all at once; past the count, a bin whose part is not among the
   first is built without holes, keeps its setting so the link and the saved drawer still
   say what was asked, and Checks says so. In layout order and no further: once one kind
   is held, so is every new kind after it, so "the first" means the first. Worked out at
   the start of every pass, after holdNotes, whose held notes are in a part's key. */
function holdHoles() {
  insertHeld = new WeakSet();
  const seen = new Map();
  let used = 0, full = false, kinds = 0, holes = 0;
  for (const L of layers) for (const b of L.bins) {
    const h = holesIn(b);
    if (!h) continue;
    const k = typeKey(b);
    if (!seen.has(k)) {
      const ok = !full && used + h.n <= HOLES_MAX;
      if (ok) used += h.n; else { full = true; kinds++; holes += h.n; }
      seen.set(k, ok);
    }
    if (!seen.get(k)) insertHeld.add(b);
  }
  holesOver = { used, kinds, holes };
}
/* How a bin carries what stands on it, from its base: `pitch`, where the bin stacked on
   it stands, its height H, or higher when what stands in its holes reaches past where
   that bin comes down (INSERT_SPEC.seat under H), since it then rests on them; its
   height `H`, and `items`, the top of those items, 0 for none. For stackHeight and
   support, which add them up a column at a time. */
function binReach(b) {
  const H = b.hUnits * SPEC.unitH, h = holesIn(b), items = h ? h.floor + h.p.len : 0;
  return { H, items, pitch: h ? Math.max(H, items + INSERT_SPEC.seat) : H };
}
/* The dividers as built: a bin asking for more removable ones than fit is the same part
   as one asking for as many as fit, and a bin with holes across its floor has none. */
const divKey = (b) => {
  const d = builtDivs(b);
  return d.divX || d.divY ? `-d${d.divX}.${d.divY}${b.divRemovable ? `r${state.divT}.${state.divClr}` : ''}` : '';
};
/* ---------- the note, raised on the label shelf ----------------------------
   A bin set to it (labelMode 1) prints its note in raised letters on its label shelf:
   bin.js decides where and whether, text.js which letters and how big. */
/* How many different notes one layout prints raised. Each is a part of its own, built
   and held in memory like any other, so a link could ask for as many as it has bins: 256
   took the page to 1.3 GB and 20 s to load. A hundred is a 10 x 10 drawer of 1x1 bins
   each with its own label. Past it, a bin whose note is not among the first hundred,
   layer by layer and bin by bin, prints plain, and Checks says so, as it does for a
   drawer past the most this tool lays out; the bins keep the setting, so the link and
   the saved drawer still say what was asked. A loose bin is one bin, and never held. A
   bin whose note does not fit its shelf builds no part for it, so it takes none of the
   hundred: a hundred shelfless bins with notes held the one note that could print. */
const RAISED_MAX = 100;
/* Which bins are past it, worked out afresh at the start of every pass that reads or
   draws the layout (readControls, refresh), since anything can have changed a note or
   the order: an edit, Undo, a link. Once per pass, not per bin: per bin it was the whole
   layout for every raised bin in it. */
function holdNotes() {
  noteHeld = new WeakSet();
  const allowed = new Set(), held = new Set();
  for (const L of layers) for (const b of L.bins) {
    if (+b.labelMode !== 1 || !b.note) continue;
    const t = notePrintable(b.note).text;
    if (!t || !shelfNote(binCfg(b)).fit) continue;
    if (!allowed.has(t) && !held.has(t)) (allowed.size < RAISED_MAX ? allowed : held).add(t);
    if (held.has(t)) noteHeld.add(b);
  }
  notesOver = held.size;
}
/* What a bin prints on its shelf, shelfNote's answer, or null when it prints nothing
   there. Only a bin set to raise its note can print one, so every other bin is answered
   without working anything out. */
const printedNote = (b) => {
  if (+b.labelMode !== 1 || !b.note || noteHeld.has(b)) return null;
  const s = shelfNote(binCfg(b));
  return s.fit ? s : null;
};
/* A bin printing its note is a part of its own: two with different notes are two
   parts, and two whose letters come out the same are one. So the key carries the lines
   as printed, and the size, which a note cut short takes from the whole of it: exactly,
   since two notes sharing a key share a part, and one bin would print the other's
   letters. It used to carry a 32-bit hash of them, where two notes in a hundred
   matched about once in 868,000 drawers. Written as the code of each character in hex,
   never as the note itself: the key is the object's name in a 3MF and goes into the
   download table's markup, and a note is whatever someone typed. */
const noteKey = (b) => {
  const p = printedNote(b);
  if (!p) return '';
  const hex = [...p.fit.lines.join('\n')].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
  return `-n${hex}.${+p.fit.cap.toFixed(6)}`;
};
/* A character the font cannot draw, as the hint and Checks name it: itself, or its code
   point when it is one nobody could see — a control, or a space of some other kind —
   so a sentence never names a blank. */
const charName = (ch) => (/^[\p{C}\p{Z}]+$/u.test(ch)
  ? [...ch].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')
  : ch);
const charList = (list) => {
  const n = list.map(charName);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};
const leftOff = (list) => `${charList(list)} cannot print, so ${list.length > 1 ? 'they are' : 'it is'} left off`;
/* The note field's hint while the note is to be raised: what will print, how tall and on
   how many lines, or why nothing will, and what is left off. [lead, rest], the rest for
   behind "more" when there is one. The page writes it with textContent, through DF.hint:
   a note is whatever was typed, and it is quoted back here. `b` is the bin the panel is
   showing, or nothing when it is the settings for new bins, which start with no note. */
function noteHintSay(b) {
  if (!b) return ['New bins print their note raised on the label shelf, once you give each one a note.', ''];
  if (noteHeld.has(b))
    return [`This layout already raises ${RAISED_MAX} other notes, the most one layout prints, ` +
            'so this one prints plain.', 'Set some of the others to Nothing, or print some bins as a layout of their own.'];
  const s = shelfNote(binCfg(b)), S = NOTE_SPEC, mm = (x) => +x.toFixed(1);
  const many = s.dropped.length > 3;
  const off = !s.dropped.length ? ''
    : many ? ` ${s.dropped.length} characters cannot print, so they are left off.` : ` ${leftOff(s.dropped)}.`;
  const offMore = many ? `They are ${charList(s.dropped)}.` : '';
  const rest = (...parts) => parts.filter(Boolean).join(' ');
  if (s.why === '') {
    const f = s.fit;
    return [`Prints ${mm(f.cap)} mm tall on ${f.lines.length > 1 ? 'two lines' : 'one line'}` +
            `${s.divided ? ', between the dividers' : ''}${f.cut ? ', cut short to fit' : ''}.${off}`,
            rest(f.cut ? `It reads \u201c${f.lines.join(' / ')}\u201d: a wider bin, a deeper shelf or a shorter note fits more.` : '',
                 s.divided ? 'The dividers stand through the shelf, so the letters go in the widest space between them.' : '',
                 f.cap < S.capMin - 1e-9 ? `That is under the ${S.capMin} mm that stays readable; a deeper shelf has room for bigger letters.` : '',
                 offMore)];
  }
  if (s.why === 'dividers' && s.along)
    return ['The dividers along the bin cut the label shelf too short from front to back for the note, so nothing prints.' + off,
            rest(`They stand through the shelf, and the letters keep clear of each one; where they cut it short, letters print only ${S.capMin} mm tall or more. Fewer of them, or a bin deeper from front to back, leaves room.`, offMore)];
  if (s.why === 'dividers')
    return ['The dividers leave no space on the label shelf wide enough for the note, so nothing prints.' + off,
            rest('They stand through the shelf, and the letters keep clear of each one. Fewer dividers, a bigger bin or a shorter note leaves room.', offMore)];
  if (s.why === 'narrow')
    return ['The walls leave the label shelf too narrow for the note, so nothing prints.' + off,
            rest('Thinner walls or a wider bin leaves room.', offMore)];
  if (s.why === 'empty')
    return !(b.note || '').trim()
      ? ['Type what goes in it above, and it prints raised on the label shelf.', '']
      : ['Nothing in this note can print, so the shelf stays plain.',
         `The letters are A to Z and a to z without accents, the digits, the punctuation on a ` +
         `keyboard, and \u00b5 \u03a9 \u00b0 \u00b1 \u00d7 \u00d8. ${charList(s.dropped)} ${s.dropped.length > 1 ? 'are' : 'is'} not among them.`];
  /* Which limit held the shelf (noteOnShelf's `by`) is what to change: the depth asked
     for, the inside's own depth, or the height. Said as the height, a 1 x 0.5 bin six
     units tall with 3 mm walls was told a taller bin had room for a deeper shelf. */
  if (s.why === 'shallow')
    return [(s.by === 'asked'
      ? `The label shelf is ${mm(b.label)} mm deep, and letters need ${S.shelfMin} mm, so nothing prints.`
      : s.by === 'inside' ? `A shelf takes at most 80% of the inside's depth, ${mm(s.depth)} mm here, and letters need ${S.shelfMin} mm, so nothing prints.`
      : s.depth < 0.05 ? 'A bin this short has no room under its rim for a shelf to print on, so nothing prints.'
      : `A bin this tall has room under its rim for a shelf ${mm(s.depth)} mm deep, and letters need ${S.shelfMin} mm, so nothing prints.`) + off,
      rest(s.by === 'asked' ? ''
        : s.by === 'inside' ? 'A bin deeper from front to back, or with thinner walls, has room for a deeper shelf.'
        : 'The shelf slopes down to the wall at 45 degrees, so its depth is held to the room above the floor. A taller bin has room for a deeper one.', offMore)];
  return [{
    noshelf: 'Give it a label shelf above, and the note prints raised on it.',
    carved: 'A carved shape has no label shelf, so the note does not print.',
    back: 'With the back wall lowered there is no label shelf, so the note does not print.',
    slot: 'A finger slot in the back wall takes the label shelf\u2019s place, so the note does not print.',
    solid: 'A solid block has no label shelf, so the note does not print.',
  }[s.why] || '', ''];
}

const typeKey = (b) => `${b.u}x${b.v}x${b.hUnits}` +
  /* The floor as built: screws raise a thinner one to the same 1.85, so two bins that
     differ only below that are one part. Without screws it is the floor as asked. */
  (b.solid ? '-solid' : `-w${b.wall}-f${builtFloorT(b)}` +
   /* A railed bin and a fixed-divider bin of the same size are DIFFERENT parts — one
      has a wall across it and the other has rails and a loose plate. Without this they
      would share a type, and therefore one STL, and you would print the wrong one. */
   divKey(b) +
   (allFullEdges(b) ? '' : `-e${edgeSig(b)}`) +
   /* A solid block has no cavity for a scoop or a shelf (buildBin builds neither), so
      a solid with one is the same part as a solid without. Both as built: a finger slot
      can hold the one and take the other away. */
   (scoopAsBuilt(b) && !holesIn(b) ? `-s${scoopAsBuilt(b)}` : '') + (labelAsBuilt(b) ? `-L${labelAsBuilt(b)}` : '')) +
  // a mask covering every cell (a hand-written link can say so) is no shape at all
  (maskBits(b) ? `-c${maskBits(b)}` : '') +
  /* A holed bin is a different part from the plain one, and from one holed for another
     magnet: the magnet's size is the page's, so it goes in from state, as the rails'
     sizes do above. A half-size bin has no holes yet whatever its boxes say
     (feetHolesOff), so it is the plain part and is named as one. */
  (holesBuilt(b) ? `-h${feetBits({ magnets: b.magnets, screws: b.screws })}` +
    (everyMatters(b) ? 'e' : '') + (b.magnets ? `m${state.magnetD}.${state.magnetH}` : '') : '') +
  noteKey(b) + insertKey(b) +
  /* The walls with finger slots, as built: one asked for slots it does not get is the
     plain part, and keyed as one, so its key is the one it always had. */
  (fingersBuilt(b) ? `-slot-${fingersBuilt(b)}` : '');

/* ---------- half cells -----------------------------------------------------
   A bin's position and size are counted in cells, and since half-size bins they may end
   in .5 (unpackBin). Everything that asks "what is here" asks it in HALF SLOTS, two to a
   cell each way, so a 1.5 wide bin and the half cell beside it are both somebody's or
   nobody's rather than sharing one cell. slotsOf is the one place a bin is turned into
   slots, and every occupancy, support and clash test below goes through it.
   A whole-size bin still covers four slots per cell of its own, so a layout with no
   half-size bin in it fills every slot of a cell or none, and answers every question
   exactly as the whole-cell grid did.
   The map still draws one rectangle per cell, with a dashed midline through each when
   half steps are on: drawing every slot would be four times the elements on a 47 x 47
   drawer for no more information. */
const slot = (n) => Math.round(n * 2);          // cells to half slots
const onWhole = (n) => Number.isInteger(n);
/* The holes a bin's feet really get: none on a half-size bin, whatever its boxes say. */
const holesBuilt = (b) => !!(b.magnets || b.screws) && !feetHolesOff(b);
// the half slots a bin covers, at its own position or at (x, y)
function slotsOf(b, x = b.x, y = b.y) {
  const X = slot(x), Y = slot(y), out = [];
  if (isHalfSize(b)) {
    // a half-size bin is never carved, so it is its whole box
    for (let i = 0; i < slot(b.u); i++) for (let j = 0; j < slot(b.v); j++) out.push([X + i, Y + j]);
    return out;
  }
  for (const [dx, dy] of binCells(b))
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) out.push([X + 2 * dx + i, Y + 2 * dy + j]);
  return out;
}
/* Whether a layout holds a half-size bin anywhere: what turns half steps on by
   themselves, and what doubles the README's map for a layer. */
const binsHaveHalf = (bins) => bins.some((b) => isHalfSize(b));
const layoutHasHalf = () => layers.some((L) => binsHaveHalf(L.bins)) || (!!scratch && isHalfSize(scratch));
/* The steps the map draws, moves and resizes in. Starts on whole cells, so nothing
   changes for anyone who never asks for a half; a layout holding a half-size bin turns
   it on (stepsFollowLayout), and a choice made on the switch is kept in this browser.
   Never in the link: it is how you are working, not what the drawer is, and a link
   from someone who likes half steps should not change how your map behaves. */
const STEPS_KEY = 'drawerforge:bins:steps';
let halfSteps = false;
let hadHalf = false;      // whether the layout held a half-size bin at the last look
const stepOf = () => (halfSteps ? 0.5 : 1);
/* The reason a place is refused when it is not a clash or the edge of the grid. A
   whole-size bin stands on whole feet, one to a socket, and a socket is a whole cell:
   on a half step every foot would straddle two. Giving it quarter feet there instead
   would change its file when it moved, and a bin already printed could not follow. */
const WHOLE_ON_WHOLE = 'A whole-size bin sits on whole cells.';

function occupancyOf(k) {
  const g = grid(), W = 2 * g.nx, D = 2 * g.ny;
  const occ = Array.from({ length: D }, () => new Array(W).fill(-1));
  (layers[k] ? layers[k].bins : []).forEach((b, i) => {
    for (const [x, y] of slotsOf(b))
      if (y >= 0 && y < D && x >= 0 && x < W) occ[y][x] = i;
  });
  return occ;
}
const occupancy = () => occupancyOf(cur);

/* Per-slot top surface available to layer k, and whether the stack below is
   continuous. A bin can only sit where every layer beneath it has one. */
function support(k) {
  const g = grid(), W = 2 * g.nx, D = 2 * g.ny;
  const top = Array.from({ length: D }, () => new Array(W).fill(0));
  const ok = Array.from({ length: D }, () => new Array(W).fill(true));
  for (let L = 0; L < k; L++) {
    // each bin's once: on what stands in its holes, if that is higher (binReach)
    const occ = occupancyOf(L), pitch = layers[L].bins.map((b) => binReach(b).pitch);
    for (let y = 0; y < D; y++)
      for (let x = 0; x < W; x++) {
        const i = occ[y][x];
        if (i === -1) ok[y][x] = false;
        else top[y][x] += pitch[i];
      }
  }
  return { top, ok };
}
// z of a bin's base, and whether its support is sound — over its whole box, as ever
function seat(b, k) {
  const s = support(k);
  let z = null, flat = true, solidBelow = true;
  const X = slot(b.x), Y = slot(b.y);
  for (let j = 0; j < slot(b.v); j++)
    for (let i = 0; i < slot(b.u); i++) {
      const y = Y + j, x = X + i;
      if (!s.ok[y] || !s.ok[y][x]) { solidBelow = false; continue; }
      const t = s.top[y][x];
      if (z === null) z = t; else if (Math.abs(t - z) > 0.001) flat = false;
    }
  return { z: z === null ? 0 : z, flat, solidBelow };
}
/* Why a box of u x v at (x, y) cannot go on this layer, or '' when it can: 'outside',
   'clash', or WHOLE_ON_WHOLE, the one worth saying out loud — the other two are
   visible on the map. */
function placeWhy(x, y, u, v, ignore) {
  const g = grid();
  if (x < 0 || y < 0 || x + u > g.nx || y + v > g.ny) return 'outside';
  if (!isHalfSize({ u, v }) && !(onWhole(x) && onWhole(y))) return WHOLE_ON_WHOLE;
  const occ = occupancy(), X = slot(x), Y = slot(y);
  for (let j = 0; j < slot(v); j++)
    for (let i = 0; i < slot(u); i++) {
      const o = occ[Y + j][X + i];
      if (o !== -1 && o !== ignore) return 'clash';
    }
  return '';
}
function canPlace(x, y, u, v, ignore) { return !placeWhy(x, y, u, v, ignore); }
// same test for a bin that may be carved: only its kept cells need to be free
function canPlaceBin(b, x, y, ignore) {
  const g = grid(), occ = occupancy();
  if (!isHalfSize(b) && !(onWhole(x) && onWhole(y))) return false;
  for (const [px, py] of slotsOf(b, x, y)) {
    if (px < 0 || py < 0 || px >= 2 * g.nx || py >= 2 * g.ny) return false;
    const o = occ[py][px];
    if (o !== -1 && o !== ignore) return false;
  }
  return true;
}
/* Occupied offsets within a bin's own bounding box. The clip is the invariant that
   holds everything together: a bin can never occupy a cell outside its own box. A
   resize used to leave the old mask in place, and those out-of-box cells drew nothing
   on the map yet still blocked other bins from being dropped there and still built in
   the preview — a bin you could neither see nor get rid of.
   Cells are whole cells: a half-size bin, which is never carved, gives every cell its
   box touches. Anything asking what a bin covers asks slotsOf instead. */
function binCells(b) {
  if (b.cells && b.cells.length && !isHalfSize(b)) {
    const kept = b.cells.filter(([x, y]) => x >= 0 && y >= 0 && x < b.u && y < b.v);
    if (kept.length) return kept;
  }
  const out = [];
  for (let x = 0; x < b.u; x++) for (let y = 0; y < b.v; y++) out.push([x, y]);
  return out;
}
const isCarved = (b) => !isHalfSize(b) && binCells(b).length < b.u * b.v;

/* The one way to change a footprint. Resizing a carved bin has to reconcile the mask,
   and what carries across is the HOLES rather than the kept cells: clip the kept cells
   and growing a bin leaves its new column empty, which is not what dragging a grip
   outwards means. Carrying the holes grows and shrinks an L the way you would expect,
   and a shape whose holes swallow the whole new box falls back to a plain rectangle.
   A carve is counted in whole cells, so a bin made half-size loses it and is the plain
   rectangle its box is: every caller has already checked that whole box is free, and
   Undo has the shape. */
function setFootprint(b, nu, nv) {
  if (isHalfSize({ u: nu, v: nv })) b.cells = null;
  else if (b.cells && b.cells.length) {
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
/* Carving and merging count whole cells — the mask in the link is one bit a cell — so
   neither takes a half-size bin in this version. Their buttons go grey and say why
   rather than vanish, so the feature does not look missing. */
const SHAPE_OFF = 'Carve and Merge work in whole cells, so they are off for half-size bins.';
const carveOff = (b) => !!b && isHalfSize(b);
/* Cut a cell out of a bin, or put one back. Both maps carve — the drawer map by
   alt-click or carve mode, the focus map by a plain click — and the rule for what a
   click may do is subtle enough (never empty the bin; never take back a cell another
   bin now owns) that a second copy would be a fourth jointKind. Says whether it
   changed anything. A half-size bin is not carved: see carveOff. */
function carveToggle(b, dx, dy) {
  if (carveOff(b) || dx < 0 || dy < 0 || dx >= b.u || dy >= b.v) return false;
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
  /* Weighed once a part, and again when the infill moves: the key names what binVolume
     reads but the infill, which it leaves out so that a new infill rebuilds nothing, so
     the weight is kept with the build, and goes when pruneGeometry drops it. On a bin
     built without dividers the key leaves out whether they would be removable, and their
     plate and clearance, as the build does, and binVolume reads none of them either: it
     weighs the bin as the one asking for none, as it is built, to the bit. Weighed afresh
     on every call, a drawer of 1,600 bins of 700 parts asked binVolume 3,700 times a
     refresh, about 200 ms of it. */
  const infill = state.infill === undefined ? 15 : state.infill;
  if (r.volInfill !== infill) {
    const vv = volumeMm3(b);
    r.vol = vv.filament; r.rawVol = vv.raw; r.volInfill = infill;
  }
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
/* Material estimate: { raw, filament, parts } in mm3, from binVolume in bin.js, which
   weighs what buildBin builds by the numbers buildBin builds it from: the feet, the
   slab, the walls and the lip of the shape as built, the scoop, the label shelf, fixed
   dividers or a removable one's rails, the block of holes across the floor, and less
   the holes in the feet and the notches a removable bin's lip and shelf have for its
   plates. A removable divider's plate is a part of its own, which the plan weighs
   beside the bin by its own outline (dividerParts, computePlan), so it is not in its
   bin. Raw is what the solid holds; filament is what a slicer lays down for it at the
   infill set here. The bin is the one the page builds (binCfg), so a note held to plain
   (holdNotes), or holes held off (holdHoles), is weighed as it is built. */
function volumeMm3(b) {
  return binVolume(binCfg(b), (state.infill === undefined ? 15 : state.infill) / 100);
}

/* The volume a closed mesh encloses: the signed volume of the tetrahedron each triangle
   makes with the origin, summed, which over a closed mesh is the volume inside wherever
   the origin falls. For the lids, which have no parameters to estimate from the way a
   bin does — and which are a thin plate and a thinner skirt, solid whatever the infill,
   so what they enclose is the filament they take. */
function meshVolume(polys) {
  let v = 0;
  for (const p of polys) {
    const q = p.verts;
    for (let i = 1; i + 1 < q.length; i++) {
      const a = q[0], b = q[i], c = q[i + 1];
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  }
  return Math.abs(v);
}

/* ---------- grams, money and time -----------------------------------------
   Every gram figure on the page is written through these, so none of them can be the one
   that forgot the cost: the parts table, the totals, the plan, the download dialog and
   the README. The money is empty until a price is set, and then it is everywhere. The
   time is ESTIMATE's rough one, per plate and summed, for whichever kind of printer the
   list or the override says. */
const gramsOf = (mm3) => mm3 / 1000 * PLA_DENSITY;
const costOf = (g) => ESTIMATE.cost(g, est.get());
// " · £0.42", or nothing without a price
const costTail = (g) => { const c = costOf(g); return c ? ` · ${c}` : ''; };
const speedNow = () => ESTIMATE.speedOf($('bedPreset'), est.get());
/* What one plate of the plan weighs and roughly takes. Every part on it counts, divider
   plates and lids included — a plate of nothing but dividers is not a free plate. */
function plateEstimate(pl) {
  const byKey = new Map(printPlan.types.map((t) => [t.key, t]));
  const parts = pl.placed.map((p) => ({ vol: (byKey.get(p.id) || {}).vol || 0, h: p.h, z: p.z }));
  const vol = parts.reduce((a, p) => a + p.vol, 0);
  return { grams: gramsOf(vol),
           min: ESTIMATE.roundMinutes(ESTIMATE.plateSeconds(parts, speedNow())) };
}
/* The whole job: grams of every part, whether or not it fits the bed, and the time of the
   plates that can be printed — a part too big for the bed has no plate to time. The total
   time is the sum of the per-plate times as shown, so the plates and the total add up. */
function jobEstimate() {
  if (!printPlan) return { grams: 0, min: 0, plates: [] };
  const plates = goodPlates().map(([pl]) => plateEstimate(pl));
  const vol = printPlan.types.reduce((a, t) => a + t.vol * t.qty, 0);
  return { grams: gramsOf(vol), min: plates.reduce((a, p) => a + p.min, 0), plates };
}
// "fast printer", for the sentences that say what the time is for
const speedName = () => `${ESTIMATE.SPEEDS[speedNow()].name} printer`;
/* "2 dividers and 1 lid": the loose parts a total weighs along with the bins, named so
   that a total larger than the bins table adds up to says why. Empty when there are none. */
function looseParts() {
  if (!printPlan) return '';
  let d = 0, l = 0;
  for (const t of printPlan.types) {
    if (t.key.startsWith('div:')) d += t.qty;
    else if (t.key.startsWith('lid:')) l += t.qty;
  }
  return [d ? plural(d, 'divider') : '', l ? plural(l, 'lid') : ''].filter(Boolean).join(' and ');
}
/* The README's versions. It is read at the printer, away from the page, so the cost says
   which price it was worked out at, and the time says in full what it is and is not. */
function readmeCost(g) {
  const c = costOf(g);
  return c ? ` — about ${c} at ${ESTIMATE.perKg(est.get())}` : '';
}
/* The grams are every part's, but a part too big for the bed has no plate to time, so a
   time that leaves one out says so. Where it does, "over 3 plates" is not said as well:
   it would be the plates said twice. */
const fitNote = () => (printPlan && printPlan.plates.some((p) => p.overflow) ? ' for the plates that fit' : '');
function readmeTime(job) {
  if (!job.plates.length) return [];
  return [`Print time: roughly ${ESTIMATE.duration(job.min)} on a ${speedName()}` +
            (job.plates.length > 1 && !fitNote() ? ` over ${job.plates.length} plates` : '') +
            `${fitNote()}.`,
          'That is a rough estimate from the filament and the layer count, not a slice:',
          'your slicer gives the real figure.'];
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
/* The Steps switch goes on the drawer map's heading row on a wider window, and beside the
   layer tabs on a phone, moved the same way and for the same reason. Beside the tabs,
   the map's card had to be as wide as two layers' tabs and the switch, which came out of
   the preview, and from a third layer the switch took a row of its own: at 1366 × 768
   that put the coverage bar 21 px under the window, with the map already at its 40 px
   cells and nothing left to give. The heading row is there anyway, so in it the switch
   costs the map no height and the tabs have their row to themselves, as they did before
   it. A phone's heading has no room for it beside the title, and a 40 px button is
   taller than the heading, so there it stays on the tabs' row. drawMap is run again on
   the change, which comes after the resize that already drew it.
   On the row, beside the <h3> and never in it: inside it, the heading was read out as
   "Drawer layout Steps Steps". And a button that had the focus keeps it: moving an
   element in the document takes the focus off it, and a window narrowed past 980 px, or
   zoomed, with the keyboard on Half cells left it on the page's body. */
function placeSteps() {
  const card = $('s-layout'), steps = card.querySelector('.steps');
  const home = card.querySelector(PHONE.matches ? '.maptools' : '.layouthead');
  if (steps.parentNode === home) return;
  const had = steps.contains(document.activeElement) ? document.activeElement : null;
  home.appendChild(steps);
  if (had) had.focus({ preventScroll: true });
}
PHONE.addEventListener('change', () => { placeSteps(); drawMap(); });
placeSteps();
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
   is nowhere — the two failures are different and want different sentences. A
   half-size bin may land on any half step, a whole one only on whole cells. */
function scratchLanding() {
  const b = scratch, g = grid();
  if (!b) return { why: 'no bin' };
  if (b.u > g.nx || b.v > g.ny)
    return { why: `a ${b.u}×${b.v} bin does not fit the ${g.nx}×${g.ny} grid — make it smaller, or the drawer bigger` };
  const step = isHalfSize(b) ? 0.5 : 1;
  for (let y = 0; y <= g.ny - b.v; y += step)
    for (let x = 0; x <= g.nx - b.u; x += step) {
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
              scoop: state.scoop, label: state.label, labelMode: state.labelMode, note: '',
              magnets: state.magnets, screws: state.screws, holesEvery: state.holesEvery,
              insert: state.insert, insertDepth: state.insertDepth,
              fingerSlots: Object.assign({}, state.fingerSlots),
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
   scoop up to the bin's height, the label shelf up to its depth. A hole is never deeper
   than the bin is tall either, which is the limit the link holds it to; the engine stops
   it under the rim besides. The dividers come after (setDividerLimit). */
function setBinLimits(u, v, hUnits) {
  const H = hUnits * SPEC.unitH;
  $('floorT').max = H; $('scoop').max = H; $('insertDepth').max = H;
  $('label').max = v * SPEC.pitch;
}
/* And the dividers, once the floor, scoop and shelf are read: up to what fits across, and
   removable ones up to as many as leave every slot room for its plate, which moves with
   the plate and the clearance, and as go in past the lip and the shelf (railedMost). The
   ones along also as many as keep enough plate where they cross the ones across, or stand
   on the scoop, and leave the lip its corners (dividersBuilt), so `cfg` carries the count
   across when this is asked for the count along. A bin with a finger slot built in it has
   no lip, and is counted without it (countedAs), up to as many as still leave a slot
   built: more plates would leave it none, and its lip back. Whether it has one is settled
   between the plates both ways, so `cfg` carries the count along when this is asked for
   the count across, too. */
function setDividerLimit(id, cfg) {
  const axis = id === 'divX' ? 'x' : 'y';
  let most = mostDividers(axis === 'x' ? cfg.u : cfg.v, cfg.wall);
  if (cfg.divRemovable) {
    const by = countedAs(cfg);
    most = Math.min(most, railedMost(by, axis));
    if (axis === 'y' || by.lipTaken)
      most = dividersBuilt(Object.assign({}, cfg, { [id]: most }))[id];
  }
  $(id).max = most;
}

function readControls() {
  const num = (id, d) => { const x = parseFloat($(id).value); return isFinite(x) ? x : d; };
  const int = (id, d) => { const x = parseInt($(id).value, 10); return isFinite(x) ? x : d; };
  /* Counts are rounded, not truncated: parseInt read "2.7" dividers as 2 and "1e3" as 1. */
  const count = (id, d) => fieldClamp(id, Math.round(num(id, d)));
  /* Width and depth to the nearest half cell, as the engine would build them anyway
     (halfSized in bin.js): a 1.3 would be a bin of no size the grid has. */
  const halves = (id, d) => fieldClamp(id, Math.round(num(id, d) * 2) / 2);
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
  /* And one fit for every hole across a floor, added to each kind's own room. Held to the
     field's limits, which bin.js holds it to as well (INSERT_SPEC.clr). */
  state.holeClr = fieldClamp('holeClr', num('holeClr', 0));
  if (document.activeElement !== $('holeClr') && parseFloat($('holeClr').value) !== state.holeClr)
    $('holeClr').value = state.holeClr;
  state.bedW = mm('bedW', 256);
  state.bedD = mm('bedD', 256);
  state.bedH = mm('bedH', 256);
  state.gap = num('gap', 3);

  const t = {
    u: halves('u', 1), v: halves('v', 1),
    hUnits: count('hUnits', 3),
    wall: mm('wall', 1.2),
    solid: $('solid').checked,
    /* By character, not by UTF-16 unit: slicing units cut an emoji in half and left a
       lone surrogate in the note, the link and the README. */
    note: [...$('note').value].slice(0, 28).join(''),
    labelMode: $('labelMode').value === '1' ? 1 : 0,
    divRemovable: $('divRemovable').checked,
    lid: $('lid').checked,
    magnets: $('magnets').checked, screws: $('screws').checked,
    holesEvery: $('holesWhere').value === 'every',
    // a menu, so only a kind it offers; anything else is none
    insert: Math.max(0, Math.min(INSERTS.length - 1, parseInt($('insert').value, 10) || 0)),
    lidSides: { f: $('lidF').checked, b: $('lidB').checked,
                l: $('lidL').checked, r: $('lidR').checked },
    edges: { f: parseFloat($('edgeF').value), b: parseFloat($('edgeB').value),
             l: parseFloat($('edgeL').value), r: parseFloat($('edgeR').value) },
    fingerSlots: { f: $('fingerF').checked, b: $('fingerB').checked,
                   l: $('fingerL').checked, r: $('fingerR').checked },
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
  /* What #sizeWhy says after this pass. Each pass says it afresh, so a reason stays only
     until the next edit, Undo or selection, whatever that touched: it was about the
     size the fields held then. */
  let sizeNote = '';
  // a size the last pass refused under the caret, if it did (sizeHeld)
  const held = sizeHeld;
  sizeHeld = null;
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
  } else if (b) {
    /* An emptied field is a number about to be typed, not the default 1: the bin keeps
       its size meanwhile, and the field shows it again if it is left empty. */
    if (!$('u').value.trim()) t.u = b.u;
    if (!$('v').value.trim()) t.v = b.v;
    if (t.u !== b.u || t.v !== b.v) {
      /* A size that would clash is put back, as ever. So is a whole size for a bin on a
         half step, and that one says why under the fields, because nothing on the map
         shows it: 2 wide at column 1.5 is free cells, just not whole ones. Never under
         the caret (sizeDraft): there it may be the 2 of a 2.5 still being typed, and
         the bin simply waits. It is put back once the field is left. */
      const why = placeWhy(b.x, b.y, t.u, t.v, selected);
      if (why) {
        t.u = b.u; t.v = b.v;
        if (!sizeTyping()) { $('u').value = b.u; $('v').value = b.v; }
        else sizeHeld = { u: b.u, v: b.v };
      }
      if (why === WHOLE_ON_WHOLE) sizeNote = why;
    }
  } else if (!scratch && held) {
    /* With no bin selected the fields are the size of the next one drawn, and what they
       hold here is a size the bin selected a moment ago refused, left under the caret.
       It goes back to that bin's, as it would have on leaving the field had the bin
       still been selected: Fill the rest takes the selection away first, and a 2 typed
       for the 1.5 × 1 on a half step filled the drawer with 2 × 1 bins. */
    Object.assign(t, held);
    $('u').value = held.u; $('v').value = held.v;
  }
  /* Several bins take the same settings, so the smallest of them sets the limit: the
     dividers that fit a 1x1 are the most any of them can be given. */
  const sizes = sel.length > 1 && !scratch ? sel.map((i) => B()[i]) : [t];
  const minU = Math.min(...sizes.map((x) => x.u)), minV = Math.min(...sizes.map((x) => x.v));
  /* With nothing selected the fields are the next bin drawn, which is drawn with fixed
     dividers whatever the box says (it takes the count, not Removable), so they are held
     to what fixed ones allow. Held to the rails, the bin chosen a moment before left its
     limit behind: after a 1x2 with removable dividers, the next bin drawn got 23 where 30
     were asked for. */
  const own = scratch || b;
  setBinLimits(minU, minV, t.hUnits);
  Object.assign(t, { floorT: mm('floorT', 1.2), scoop: mm('scoop', 0), label: mm('label', 0) });
  /* A bin asking for more removable dividers than fit keeps asking for them: a link or a
     saved drawer from before the limit followed the rails can ask for 31 on a 1x1, where
     10 fit, and is built with 10 (Checks says so). Selecting it, or changing anything
     else about it, must not rewrite the link, so while the field still shows what the bin
     asks for, that is kept, held only to the limit the link reader holds it to. So is
     the same number typed in again, and the fixed dividers of a bin whose Removable is
     ticked: the field shows them above its limit, and the bin is built with as many as fit
     until a plate or a clearance lets more in. Any other number typed in is held to the
     field's limit. */
  const divCount = (id, most) => {
    const x = count(id, 0), asked = Math.round(num(id, 0));
    return own && asked > x && asked === own[id] ? Math.min(asked, most) : x;
  };
  // the smallest bin's footprint, with what this pass gives every bin it applies to
  const lim = binCfg(Object.assign({}, t, { u: minU, v: minV, cells: null, divX: 0, divY: 0,
                                            divRemovable: t.divRemovable && !!own }));
  /* The count across is held with the plates along the field asks for, as the count along
     is with the ones across: plates along can leave a side wall no room for its finger
     slot, and the bin then has its lip, which holds the plates across to fewer. Held as
     if there were none, a 1x1x3 with a 0.4 mm wall, a left slot and one plate along was
     let ask for 11 across and built 10. */
  setDividerLimit('divX', Object.assign({}, lim, { divY: divCount('divY', mostDividers(minV, t.wall)) }));
  t.divX = divCount('divX', mostDividers(minU, t.wall));
  setDividerLimit('divY', Object.assign(lim, { divX: t.divX }));
  t.divY = divCount('divY', mostDividers(minV, t.wall));
  /* Show the value actually used once you have left the field: typed past a limit, the
     box would otherwise go on saying 100 while the bin is built at 10. Never under the
     caret, where emptying the box to type a new number would have it filled back in
     before the first digit landed. */
  for (const id of BIN_FIELDS)
    if (t[id] !== undefined && document.activeElement !== $(id) && parseFloat($(id).value) !== t[id])
      $(id).value = t[id];
  /* The holes' depth: blank, or nothing above 0, is automatic (0), and the box goes
     blank again once it is left; a depth typed is held to the field's limits, after the
     height that sets the top one. */
  const hd = parseFloat($('insertDepth').value);
  t.insertDepth = isFinite(hd) && hd > 0 ? fieldClamp('insertDepth', hd) : 0;
  if (document.activeElement !== $('insertDepth') &&
      $('insertDepth').value !== (t.insertDepth ? String(t.insertDepth) : ''))
    $('insertDepth').value = t.insertDepth || '';
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
    Object.assign(scratch, t, { edges: Object.assign({}, t.edges),
                                fingerSlots: Object.assign({}, t.fingerSlots) });
    if (nu !== undefined && (nu !== scratch.u || nv !== scratch.v)) {
      if (dropsShape(scratch, nu, nv)) sizeNote = SHAPE_DROPPED;
      setFootprint(scratch, nu, nv);
    }
  } else if (sel.length) {
    /* u and v never ride the bulk assign — a footprint change has to reconcile the
       carve mask, so it goes through setFootprint. */
    const nu = t.u, nv = t.v; delete t.u; delete t.v;
    noteSettingsEdit(sel.map((i) => B()[i]), t, nu, nv);
    for (const i of sel) Object.assign(B()[i], t, { edges: Object.assign({}, t.edges),
                                                    fingerSlots: Object.assign({}, t.fingerSlots) });
    if (sel.length === 1 && nu !== undefined && (nu !== b.u || nv !== b.v)) {
      if (dropsShape(b, nu, nv)) sizeNote = SHAPE_DROPPED;
      setFootprint(b, nu, nv);
    }
  } else {
    Object.assign(state, t);
  }
  sizeSay(sizeNote);
  /* The map's reason lasts as long as the action that said it (mapSay): any pass after
     that is another edit, an Undo or a selection, which it is not about. */
  if (!stepSaid) mapSay('');
  stepSaid = false;
  /* A lid needs a lip to grip, and a lowered wall takes the lip away. Say which it is
     rather than hiding the control, or ticking it and getting nothing looks like a bug.
     A carved bin keeps its lip, but the lid is a rectangle: it would hang over the cells
     cut away, so it is not made for one either, and that gets its own sentence. */
  const lipOk = EDGES.every((k) => !t.edges || !isFinite(t.edges[k]) || t.edges[k] >= 1);
  const target = scratch || (sel.length ? B()[selected] : null);
  const carvedNow = !!target && isCarved(target);
  /* A finger slot takes the lip as well, and has its own sentence: the one about a
     lowered wall would send someone to the wall menus, which are all at full height. */
  const slotted = lipOk && !t.solid && !!fingersBuilt(target || Object.assign({}, state, t));
  $('lidRow').style.display = t.solid ? 'none' : '';
  $('lidNoLip').style.display = !t.solid && !lipOk && $('lid').checked ? '' : 'none';
  $('lidNoLipSlot').style.display = slotted && $('lid').checked ? '' : 'none';
  $('lidCarved').style.display = !t.solid && lipOk && !slotted && carvedNow && $('lid').checked ? '' : 'none';
  $('lidHint').style.display = !t.solid && lipOk && !slotted && !carvedNow && $('lid').checked ? '' : 'none';
  /* The feet. "Where" and the count only mean something once there are holes, and each
     hint says what its holes are for, so each shows with its box.
     A half-size bin has no holes yet (feetHolesOff), so its boxes go grey with the
     reason under them. They keep what they hold rather than being cleared: the bin
     takes its holes back if it is made whole again, and clearing them here would file
     an undo step for a change nobody made. Several bins are greyed only when none of
     them could take a hole — the whole ones among them still do. */
  const holed = target || Object.assign({}, state, t);
  const holesFor = sel.length > 1 && !scratch ? sel.map((i) => B()[i]) : [holed];
  const holesOff = holesFor.every((x) => feetHolesOff(x)) ? feetHolesOff(holesFor[0]) : '';
  $('magnets').disabled = $('screws').disabled = !!holesOff;
  $('feetOff').textContent = holesOff;
  $('feetOff').style.display = holesOff ? '' : 'none';
  const holes = (t.magnets || t.screws) && !holesOff;
  $('holesWhereRow').style.display = holes ? '' : 'none';
  $('magnetHint').style.display = t.magnets && !holesOff ? '' : 'none';
  $('screwHint').style.display = t.screws && !holesOff ? '' : 'none';
  $('magnetSize').textContent = `${state.magnetD} x ${state.magnetH}`;
  $('holeCount').style.display = holes ? '' : 'none';
  $('holeCount').textContent = !holes ? ''
    : (!target ? `A new ${holed.u} by ${holed.v} bin takes `
       : sel.length > 1 && !scratch ? 'The first of these bins takes ' : 'This bin takes ') +
      (holesText(holed) || 'no holes') + '.';
  // the front measurement is only worth asking for once the drawer is being drawn
  $('drawerFrontRow').style.display = state.showDrawer ? '' : 'none';
  $('drawerViewHint').style.display = state.showDrawer ? '' : 'none';
  $('thickRow').style.display = t.solid ? 'none' : '';
  $('divRow').style.display = t.solid ? 'none' : '';
  $('edgeRowA').style.display = t.solid ? 'none' : '';
  $('edgeRowB').style.display = t.solid ? 'none' : '';
  $('edgeHint').style.display = t.solid ? 'none' : '';
  $('fingerRow').style.display = t.solid ? 'none' : '';
  $('fingerHint').style.display = t.solid ? 'none' : '';
  $('featureRow').style.display = t.solid ? 'none' : '';
  $('featureHint').style.display = t.solid ? 'none' : '';
  /* The note raised on the shelf: the menu sits with the shelf it prints on, the hint
     under the note it describes, saying what will print. A solid block has no shelf. */
  $('labelModeRow').style.display = t.solid ? 'none' : '';
  holdNotes(); holdHoles();
  const raise = t.labelMode === 1 && !t.solid;
  $('noteHint').style.display = raise ? '' : 'none';
  /* Emptied, not only hidden, once nothing is raised: the note's field is described by
     it, and a hidden description is still read out, so the field went on saying
     "Prints 4.5 mm tall on one line." after the note was set back to Nothing. */
  if (!raise) $('noteHint').textContent = '';
  else {
    const [lead, rest] = noteHintSay(target);
    if (rest) DF.hint($('noteHint'), lead, rest);
    else $('noteHint').textContent = lead;
  }
  /* Holes across the floor. The depth and the clearance only once there are holes to be
     that deep or that loose; the hint says what the bin the panel shows gets, as the
     feet's count does, or why it gets none. A solid block has no floor to put them in. */
  $('insertRow').style.display = t.solid ? 'none' : '';
  const ins = !t.solid && t.insert > 0;
  $('insertDepthRow').style.display = ins ? '' : 'none';
  $('holeClrHint').style.display = ins ? '' : 'none';
  $('insertHint').style.display = ins ? '' : 'none';
  // emptied once there are none, as the note's is, since the menu is still described by it
  if (!ins) $('insertHint').textContent = '';
  else {
    const [lead, rest] = insertHintSay(holed);
    if (rest) DF.hint($('insertHint'), lead, rest);
    else $('insertHint').textContent = lead;
  }
  $('presetTray').style.display = t.solid ? 'none' : '';
  $('selActions').style.display = selected >= 0 ? '' : 'none';
  $('sizeRow').style.display = selAll().length > 1 ? 'none' : '';
  /* Carving needs exactly one bin to carve. A loose bin IS exactly one bin — it just
     is not a selection, so counting the selection would have hidden the Carve button
     in the one mode built around a single bin. */
  const one = !!scratch || selAll().length === 1;
  // neither takes a half-size bin (SHAPE_OFF): greyed, with the reason beside them
  const carveNo = one && carveOff(scratch || B()[selected]);
  const many = selAll().length > 1;
  const mergeNo = many && selAll().some((i) => carveOff(B()[i]));
  if (!one || carveNo) carving = false;
  $('carveMode').style.display = one ? '' : 'none';
  $('carveMode').disabled = carveNo;
  $('carveHint').style.display = one && carving ? '' : 'none';
  $('carveMode').classList.toggle('on', carving);
  $('fillmap').classList.toggle('carving', carving);
  $('carveMode').textContent = carving ? 'Done carving' : 'Carve this bin into a shape';
  $('mergeBins').style.display = many ? '' : 'none';
  $('mergeBins').disabled = mergeNo;
  $('mergeHint').style.display = many && !mergeNo ? '' : 'none';
  $('shapeOff').textContent = SHAPE_OFF;
  $('shapeOff').style.display = carveNo || mergeNo ? '' : 'none';
  const selBin = selected >= 0 ? B()[selected] : null;
  const needsSplit = !!selBin && !fitsBed(selBin.u, selBin.v) && !!splitPlan(selBin);
  $('splitFit').style.display = needsSplit ? '' : 'none';
  $('splitHint').style.display = needsSplit ? '' : 'none';
  if (needsSplit) {
    const sp = describeSplit(selBin);
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
  stepsFollowLayout();
  /* Last, so it sees the selection this pass settled on — and so the one class that
     decides what focus hides is applied after every other visibility decision above,
     rather than being quietly undone by one of them. */
  applyFocus();
  // and whether this is a sheet on a phone follows from the selection and the mode
  applySheet();
}
function writeControls(src) {
  sizeSay('');              // a refusal was about the size the fields held before
  $('u').value = src.u; $('v').value = src.v; $('hUnits').value = src.hUnits;
  $('wall').value = src.wall; $('floorT').value = src.floorT;
  $('divX').value = src.divX; $('divY').value = src.divY;
  $('solid').checked = !!src.solid;
  $('scoop').value = src.scoop || 0; $('label').value = src.label || 0;
  $('labelMode').value = +src.labelMode === 1 ? '1' : '0';
  $('done').checked = !!src.done;
  $('divRemovable').checked = !!src.divRemovable;
  $('lid').checked = !!src.lid;
  $('magnets').checked = !!src.magnets; $('screws').checked = !!src.screws;
  $('holesWhere').value = src.holesEvery ? 'every' : 'corners';
  $('insert').value = String(Number.isInteger(+src.insert) && INSERTS[+src.insert] ? +src.insert : 0);
  $('insertDepth').value = src.insertDepth > 0 ? src.insertDepth : '';
  for (const [id, k] of [['lidF', 'f'], ['lidB', 'b'], ['lidL', 'l'], ['lidR', 'r']])
    $(id).checked = !src.lidSides || src.lidSides[k] !== false;
  $('note').value = src.note || '';
  for (const [k, id] of [['f', 'edgeF'], ['b', 'edgeB'], ['l', 'edgeL'], ['r', 'edgeR']])
    $(id).value = String(src.edges && src.edges[k] !== undefined ? src.edges[k] : 1);
  for (const [k, id] of [['f', 'fingerF'], ['b', 'fingerB'], ['l', 'fingerL'], ['r', 'fingerR']])
    $(id).checked = !!(src.fingerSlots && src.fingerSlots[k]);
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
/* A press the page will not see the end of is ended as a release over nothing ends one:
   a bin being moved or resized stays where the drag had it, one being drawn is not
   placed, and a sheet kept up for it goes. The release, if it comes, then finds no drag
   and does nothing. See lostpointercapture in initMap, and leave. */
function letGoOfMap() {
  if (drag) { drag = null; applySheet(); drawMap(); refresh(); }
}
/* The Steps switch above the map: whole cells or half cells. See STEPS_KEY for what it
   is, and why it is kept in this browser and never in the link. */
function showSteps() {
  for (const [id, on] of [['stepWhole', !halfSteps], ['stepHalf', halfSteps]]) {
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-pressed', String(on));
  }
}
function chooseSteps(half) {
  writeKey(STEPS_KEY, half ? 'half' : 'whole');
  if (half === halfSteps) return;
  halfSteps = half;
  mapSay('');
  showSteps(); drawMap();
}
$('stepWhole').addEventListener('click', () => chooseSteps(false));
$('stepHalf').addEventListener('click', () => chooseSteps(true));
/* Half steps turn themselves on when a half-size bin appears — opening a link that has
   one, or typing 1.5 into a width — because a half-size bin on a whole-step map can be
   drawn but not lined up. Only on that edge, the way a panel opens on one: switched back
   to whole cells, the map stays on whole cells until the layout next gains a half-size
   bin. Not saved, since nobody chose it; what this browser remembers is the choice made
   on the switch. */
function stepsFollowLayout() {
  const any = layoutHasHalf();
  if (any && !hadHalf) halfSteps = true;
  hadHalf = any;
  showSteps();
}
/* Says why the map refused a place, when the reason is not one the map can show: a
   clash is a red outline, the edge of the drawer is the edge of the map, but a whole
   bin on a half step looks like free cells. Cleared by the next press on the map, and by
   the readControls pass after the one that ends the action that said it: an Undo or an
   edit of anything else left it there, about a place nobody was trying any more. */
let stepSaid = false;
function mapSay(t) {
  if ($('stepWhy').textContent !== t) $('stepWhy').textContent = t;
  stepSaid = !!t;
}
/* The same, under the Width and Depth fields, for a size typed there. Present but empty
   when there is nothing to say, never display:none: a status region only announces what
   changes inside it while it is there, and one shown at the moment it got its text was
   one a screen reader might not read out. Empty, it takes no room. */
function sizeSay(t) {
  if ($('sizeWhy').textContent !== t) $('sizeWhy').textContent = t;
}
/* A carve is counted in whole cells, so a carved bin made half-size is the plain
   rectangle its box is (setFootprint). That happened without a word: the L simply went.
   Said where the size was changed, under the fields or under the map.
   Under the map it is said in a line, the one it has there (#stepWhy in style.css): the
   sentence took three on a 1366 × 768 window, from the front marker to 23 px under the
   window, over the coverage bar, and a block of up to 58 px over it on a phone. The map
   has just shown the shape go, so the line need only say why; it fits a 320 px phone
   with room to spare, as WHOLE_ON_WHOLE does. */
const SHAPE_DROPPED = 'A half-size bin cannot keep a carved shape, so this one is a plain rectangle now. Undo brings the shape back.';
const SHAPE_DROPPED_MAP = 'A half-size bin cannot be carved.';
/* A press on the map that lands a drawer size typed a moment before is not taken: the
   map is drawn again for the new grid under the pointer (initMap). Said under the map,
   since a press that does nothing looks lost; one line on a 320 px phone. */
const GRID_MOVED = 'The drawer changed size. Press again.';
const dropsShape = (b, nu, nv) => isCarved(b) && isHalfSize({ u: nu, v: nv });

/* Width and Depth while they are being typed into. A size refused under the caret was
   written back there when the debounce ran out, 180 ms later, so "2.5" typed at a human
   pace was refused at its "2" and came out "1.55", and a field emptied to type a new
   number filled straight back in. A refused size now leaves the field as it is typed,
   and is put back with the reason when the field is committed: left, or stepped by its
   arrows, which give a whole value at once rather than a number on its way. */
let sizeDraft = null;          // the field being typed into, if either is
const sizeTyping = () => !!sizeDraft && document.activeElement === $(sizeDraft);
/* The size of the bin that refused what is under the caret, from the last pass that
   refused it: if that bin is no longer selected by the next pass, the fields go back to
   it rather than handing the refused size to the next bin drawn (readControls). */
let sizeHeld = null;
// the one bin the fields are sizing, where it stands: a loose or a new bin stands nowhere
const sizedBin = () => (!scratch && selected >= 0 && selAll().length === 1 && B()[selected]) || null;
/* A step of Width or Depth from `from` to the next half cell up or down, and over a whole
   size the bin may not take where it stands to the half size beyond it: 1.5 wide at
   column 1.5 steps to 2.5 and to 0.5, since 2 and 1 there would be whole bins on a half
   step. The field's own step stopped on them, refused, and never got past. */
function sizeStep(id, from, dir) {
  const lo = parseFloat($(id).min), hi = parseFloat($(id).max), b = sizedBin();
  const held = (n) => Math.min(hi, Math.max(lo, n));
  const whole = (n) => !!b && placeWhy(b.x, b.y, id === 'u' ? n : b.u, id === 'v' ? n : b.v,
                                       selected) === WHOLE_ON_WHOLE;
  let n = held(dir > 0 ? Math.floor(from * 2) / 2 + 0.5 : Math.ceil(from * 2) / 2 - 0.5);
  if (whole(n) && held(n + dir * 0.5) !== n) n += dir * 0.5;
  return n;
}
for (const id of ['u', 'v']) {
  // the arrow keys step here rather than in the browser, so that they can step over
  $(id).addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey) return;
    const b = sizedBin();
    if (!b) return;
    e.preventDefault();
    const x = parseFloat($(id).value);
    $(id).value = sizeStep(id, isFinite(x) ? x : b[id], e.key === 'ArrowUp' ? 1 : -1);
    sizeDraft = null;
    schedule();
  });
  /* The spinner steps in the browser, and Chromium says so with an input event that is
     not an InputEvent, which typing always is. A step onto a refused whole size goes on
     to the half size past it, the way the keys do; where a browser does not tell the
     two apart, the spinner's step is refused when it lands, as typing is when left. */
  let before = NaN;
  $(id).addEventListener('beforeinput', () => { before = parseFloat($(id).value); });
  $(id).addEventListener('input', (e) => {
    if (!e.isTrusted || e instanceof InputEvent) { sizeDraft = id; return; }
    sizeDraft = null;
    const b = sizedBin(), x = parseFloat($(id).value);
    if (!b || !isFinite(x)) return;
    const from = isFinite(before) && before !== x ? before : b[id];
    if (x !== from) $(id).value = sizeStep(id, from, Math.sign(x - from));
  });
  $(id).addEventListener('change', () => { sizeDraft = null; });
  $(id).addEventListener('blur', () => { sizeDraft = null; });
}
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
 * A half-size bin can be narrower than its own size. Every whole bin's size fits across
 * it — "1×10" in a bin one cell wide is the tightest, 30 of 30 — so this only ever moves
 * a half-size bin's: turned to run up the bin if it is taller than wide, else in the
 * smaller type, else turned and smaller, else left off. A 0.5 × 0.5 has room for none;
 * the hover text and the map's own label still say what it is.
 *
 * Returns [{ cls, text, dy, turn }], dy being each baseline's offset from the bin's
 * centre, in a frame turned a quarter anticlockwise when turn is set. */
const LABEL = { CH: 0.62, ASC: 0.95, DESC: 0.27, GAP: 1.5,
                size: { blabel: 12, bsize: 9.5, bsub: 9.5, bnote: 9 } };
function binLabels(b) {
  let roomW = b.u * S - 10, roomH = b.v * S - 8;     // the rect's 2 inset, plus clearance
  const size = `${b.u}×${b.v}`;
  const across = (str, cls, room) => str.length * LABEL.CH * LABEL.size[cls] <= room;
  let top = 'blabel', turn = false;
  if (!across(size, top, roomW)) {
    // turned, the line has the bin's width to stand in, edge to edge inside the outline
    const way = [['blabel', true], ['bsize', false], ['bsize', true]].find(([cls, t]) =>
      across(size, cls, t ? b.v * S - 10 : roomW) &&
      (LABEL.ASC + LABEL.DESC) * LABEL.size[cls] <= (t ? b.u : b.v) * S - 4);
    if (!way) return [];
    [top, turn] = way;
    if (turn) [roomW, roomH] = [b.v * S - 10, b.u * S - 8];
  }
  const fits = (str, cls) => across(str, cls, roomW);
  const lines = [{ cls: top, text: size, rank: 0 }];
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
    return { cls: l.cls, text: l.text, dy, turn };
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
     stage's top padding). Below it the marker and the bar are a fixed 41 px: #stepWhy,
     the reason the map refused a place, says it on the marker's own line (style.css),
     because a line of its own put the bar 20 px under a 1366 × 768 window. Stacked,
     the stage is as tall as its content and it is the window that scrolls, so there
     the window is the room — see DF.stageRow.
     Fitting the height never takes a cell under 40 px, the size the phone pass set as
     the smallest thing a finger can hit: on a short window with the "picked up your
     layout" banner showing, a map that scrolls a little beats one too fine to use.
     The 52 px cell and 720 px caps are for a 1080-line window and grow with a taller
     one (row.big): at 1440 a cell may be 69 px rather than staying 52 while the screen
     round it got a third bigger. The labels scale with the cells, so they stay legible.
     Paired, the card is the map's width, and no narrower than its heading's row needs
     for the whole title and the Steps switch, which is on that row on any window wide
     enough to pair (placeSteps). That is 290 to 310 px in the fonts tried, less than a
     7-column map at 1366 × 768 and no more than one at its 40 px cells, so it takes
     nothing from the preview there; a narrower drawer's card is held at it, its preview
     no narrower than a 7-column drawer's. Counted at the title's first word only, the
     row cut the title to "DRAWER LAYO…" for every drawer under 7 columns, and for a
     7-column one on a shorter window.
     The switch was first beside the layer tabs, and the card kept as wide as that row:
     paired at the map's width alone, a 1366 × 768 window had no room
     for the switch beside two layers' tabs, it dropped to a row of its own after the
     height was settled, and the map, its front marker and the coverage bar went 38 px
     under the window. Kept that wide, each layer took a tab's width, about 70 px, out of
     the preview, in a drawer of whole bins as much as in one of half; held at two
     layers' width, the switch's own row from a third layer still put the bar 21 px under
     the window, the map there being within a pixel of its 40 px cells. On the heading's
     row it costs no height, and the tabs have their row to themselves as before it.
     "Above" is measured with the columns taken away (stageRow), and the map is sized
     again once paired, as the baseplates page's cut map is, should anything above it
     wrap all the same: the tabs' labels do, with five layers or more. */
  let headW = 0;
  const steps = twoCol && $('s-layout').querySelector('.layouthead > .steps');
  if (steps) {
    /* the title on one line and the heading's padding round it, the switch and its
       margin, and the card's border, up to the next pixel, which a rounded offsetWidth
       was not: 385.4 px in 385 overlaps. The title's text, not the <h3>, whose box is
       the room it was given last time and may have cut it. */
    const h3 = $('s-layout').querySelector('.layouthead > h3'), cs = getComputedStyle(h3);
    const title = document.createRange();
    title.selectNodeContents(h3);
    headW = Math.ceil(parseFloat(cs.paddingLeft) + title.getBoundingClientRect().width +
                      parseFloat(cs.paddingRight) + steps.getBoundingClientRect().width +
                      parseFloat(getComputedStyle(steps).marginRight)) + 2;
  }
  const chrome = () => svg.getBoundingClientRect().top - top.getBoundingClientRect().top + 41;
  const size = (fixed) => {
    const availH = Math.max(H * 40 / S, Math.min(720 * row.big, row.room - fixed));
    const sc = Math.min(availW / W, availH / H, Math.round(CELL_PX * row.big) / S);
    svg.setAttribute('width', Math.round(W * sc));
    svg.setAttribute('height', Math.round(H * sc));
    if (twoCol) DF.pairColumns(top, Math.min(availW + 30, Math.max(Math.round(W * sc) + 30, headW)), PREVIEW_MIN);
  };
  const fixed = chrome();
  size(fixed);
  if (twoCol) { const paired = chrome(); if (paired > fixed) size(paired); }

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const el = (n, a) => { const e = document.createElementNS(SVGNS, n);
    for (const k in a) e.setAttribute(k, a[k]); return e; };
  const sy = (y, v) => (g.ny - y - v) * S;

  const occ = occupancy();
  const sup = support(cur);
  /* One rectangle a cell, read from its four half slots. They agree in any cell no
     half-size bin reaches, which is every cell of a whole-cell layout. Where they do not,
     the cell is drawn free if any of it is, and a slot with nothing under it on an upper
     layer is greyed on its own. */
  const H2 = S / 2;
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      const q = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => ({ i, j,
        free: occ[2 * y + j][2 * x + i] === -1, dead: cur > 0 && !sup.ok[2 * y + j][2 * x + i] }));
      const same = q.every((s) => s.free === q[0].free && s.dead === q[0].dead);
      const free = q.some((s) => s.free && !s.dead), dead = same && q[0].dead;
      const c = el('rect', { class: 'cell' + (free && !dead ? ' free' : '') + (dead ? ' dead' : ''),
        x: x * S, y: sy(y, 1), width: S, height: S });
      svg.appendChild(c);
      if (!same)
        for (const s of q.filter((s) => s.dead))
          svg.appendChild(el('rect', { class: 'cell dead', x: x * S + s.i * H2,
            y: sy(y, 1) + (1 - s.j) * H2, width: H2, height: H2 }));
    }
  /* Half steps draw a dashed line through the middle of every cell, both ways: the
     places a half-size bin can start. One path for the lot. */
  if (halfSteps) {
    let d = '';
    for (let x = 0; x < g.nx; x++) d += `M${x * S + H2} 0V${H}`;
    for (let y = 0; y < g.ny; y++) d += `M0 ${y * S + H2}H${W}`;
    svg.appendChild(el('path', { class: 'midline', d }));
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
      if (t.turn) e.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
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
    const { x, y, u, v } = dragBox(drag);
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
      : 'No bins on this layer.') +
    (halfSteps ? ' Drawing in half-cell steps.' : ''));
}
/* Screen point -> grid cell.
   Goes through the SVG's own screen matrix rather than measuring the element box.
   preserveAspectRatio letterboxes the drawing inside that box whenever the element's
   aspect ratio differs from the viewBox's, so box-relative arithmetic is off by the
   dead margin — and the margin changes as the element resizes. getScreenCTM accounts
   for the viewBox, the letterboxing, page zoom and scroll together.
   x and y are where a bin would start under the pointer, in the map's steps: a whole
   cell, or with half steps on, a half one. slot is the half slot under the pointer,
   which is what "what is here" asks about, and cell the whole cell, which is what a
   carve asks about. */
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
  const sx = Math.max(0, Math.min(2 * g.nx - 1, Math.floor(vx / (S / 2))));
  const sy = Math.max(0, Math.min(2 * g.ny - 1, 2 * g.ny - 1 - Math.floor(vy / (S / 2))));
  const cell = { x: Math.floor(sx / 2), y: Math.floor(sy / 2) };
  return { x: halfSteps ? sx / 2 : cell.x, y: halfSteps ? sy / 2 : cell.y,
           slot: { x: sx, y: sy }, cell };
}
/* The box a create drag has swept, from the step it started in to the one under the
   pointer, both included. */
const dragBox = (d) => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
                          u: Math.abs(d.x1 - d.x0) + d.st, v: Math.abs(d.y1 - d.y0) + d.st });
function initMap() {
  const svg = $('fillmap');
  /* Right-click on the map. Uses the same cell arithmetic as every other click here, so
     the menu opens on the bin under the cursor whether or not it is the selected one. */
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const c = cellFromEvent(e);
    const i = B().findIndex((b) => slotsOf(b).some(([x, y]) => x === c.slot.x && y === c.slot.y));
    if (i < 0) return closeMenu();
    hideTip();
    openMenu(e.clientX, e.clientY, cur, i);
  });
  svg.addEventListener('pointerdown', (e) => {
    /* An edit still waiting lands first (landEdit), before the field is left, which
       comes after this, and before the press is read: against the grid it leaves, not
       the one before it. Read first, a drawer width or depth typed and pressed on the
       map at once looked a cell up in the old grid and then in the new, smaller one,
       and threw. And where it changed the grid, the press goes no further: the map was
       drawn again under the pointer, and the cell aimed at has moved, or is gone.
       The edit is only read in here. A press that selects or moves a bin draws the map
       and refreshes the page straight after, and drawing the edit a moment before that
       was the same work twice: about 40 ms of the 80 such a press took, at four layers
       of 63 bins. So that press draws the edit with its own pass, and every other press
       draws it first (drawLanded), as it always was. */
    const was = grid(), landed = landEdit(false);
    let owed = landed;
    const drawLanded = () => { if (owed) { owed = false; drawLayerTabs(); drawMap(); refresh(); } };
    mapSay('');
    if (landed && (grid().nx !== was.nx || grid().ny !== was.ny)) {
      drawLanded();
      /* Said, or the press looks lost: the same press made a bin before the edit landed
         first. The press is over as it is said, so the next pass of any kind takes it
         away, not only the next press on the map (mapSay). */
      mapSay(GRID_MOVED);
      stepSaid = false;
      return;
    }
    const c = cellFromEvent(e);
    const handle = e.target && e.target.dataset ? e.target.dataset.handle : null;

    /* Grips sit on the bin's corners, which is exactly where you click to carve an
       L. While carving they have to yield, or the one cell you most want to remove
       is the one cell you cannot. */
    if (handle && !e.altKey && !carving && selected >= 0 && B()[selected]) {
      drawLanded();
      const b = B()[selected], st = stepOf();
      /* The anchor is the step at the far corner, which stays put. In half steps the
         grips resize in halves; in whole ones a half-size bin keeps its far edge where
         it is, and the near one follows the pointer in whole cells. The undo step is
         filed at the first change (banked), not here: a grip pressed and let go is no
         edit. */
      drag = { mode: 'resize', idx: selected, st, snap: snapshot(), moved: false,
               ax: handle[0] === 'l' ? b.x + b.u - st : b.x,
               ay: handle[1] === 'f' ? b.y + b.v - st : b.y,
               x1: c.x, y1: c.y };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
      return;
    }

    /* Alt-click carves. Inside the selected bin it removes a cell; on a cell the bin
       once covered it puts one back, so a carve can be undone by the same gesture. */
    if ((e.altKey || carving) && selected >= 0 && B()[selected]) {
      drawLanded();
      const b = B()[selected];
      // carving counts whole cells, whatever the steps
      const dx = c.cell.x - b.x, dy = c.cell.y - b.y;
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
    const hit = occupancy()[c.slot.y][c.slot.x];
    if (hit !== -1) {
      if (e.ctrlKey || e.metaKey) {                      // add or remove from the set
        drawLanded();
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
      selExtra.clear();                                  // release is just a select,
      selected = hit;                                    // so the undo step waits for
      writeControls(b);                                  // the first move (banked)
      drag = { mode: 'move', idx: hit, dx: c.x - b.x, dy: c.y - b.y, moved: false,
               snap: snapshot() };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
      // the landed edit's drawing too, which is all of this and the layer tabs
      readControls(); if (owed) drawLayerTabs(); drawMap(); refresh();
      return;
    }

    drawLanded();
    clearSel();                                          // draw a new bin
    drag = { mode: 'create', st: stepOf(), x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    readControls(); drawMap();
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = cellFromEvent(e);

    /* A refusal the map cannot show is said (mapSay); any other outcome clears it, so
       it describes where the pointer is now rather than somewhere it passed. Except that
       a carved shape a resize made half-size has gone for good, so that stays said while
       the bin is half-size: pulled back to a whole size in the same drag it is a plain
       rectangle, which may be carved, and the line went on saying it could not be. */
    const say = (why) => mapSay(why === WHOLE_ON_WHOLE ? why
      : drag.dropped && isHalfSize(B()[drag.idx]) ? SHAPE_DROPPED_MAP : '');
    /* A move or a resize files its undo step with the layout as the press found it, at
       its first real change. Filed at the press, a click that only selected a bin was a
       step of its own: the next Undo spent itself on a layout that had not changed, and
       the click threw away Redo. */
    const banked = () => { if (!drag.moved) pushOn(uStack(), rStack(), drag.snap); };
    if (drag.mode === 'create') {
      if (c.x === drag.x1 && c.y === drag.y1) return;
      drag.x1 = c.x; drag.y1 = c.y;
      const box = dragBox(drag);
      say(placeWhy(box.x, box.y, box.u, box.v, -1));
      drawMap();
      return;
    }
    const b = B()[drag.idx];
    if (!b) return;

    if (drag.mode === 'move') {
      const nx = c.x - drag.dx, ny = c.y - drag.dy;
      if (nx === b.x && ny === b.y) return;
      const why = placeWhy(nx, ny, b.u, b.v, drag.idx);
      say(why);
      if (why) return;                                   // refuse, don't snap away
      banked();
      b.x = nx; b.y = ny; drag.moved = true;
      drawMap();
      return;
    }
    // resize: the opposite corner stays put, this one follows the pointer
    const nx = Math.min(c.x, drag.ax), ny = Math.min(c.y, drag.ay);
    const nu = Math.abs(c.x - drag.ax) + drag.st, nv = Math.abs(c.y - drag.ay) + drag.st;
    if (nx === b.x && ny === b.y && nu === b.u && nv === b.v) return;
    const why = placeWhy(nx, ny, nu, nv, drag.idx);
    if (why) { say(why); return; }
    banked();
    if (dropsShape(b, nu, nv)) drag.dropped = true;
    b.x = nx; b.y = ny; setFootprint(b, nu, nv);
    say('');                                             // about the size it is now
    drag.moved = true;
    writeControls(b); drawMap();
  });

  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.mode === 'create') {
      const { x, y, u, v } = dragBox(drag);
      if (canPlace(x, y, u, v, -1)) {
        /* Snapshot here rather than at pointerdown: a drag that ends across an
           occupied cell places nothing, and an entry filed for it would make the
           next Undo spend itself on a layout that never changed. */
        pushUndo();
        B().push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                   floorT: state.floorT, divX: state.divX, divY: state.divY,
                   solid: state.solid, scoop: state.scoop, label: state.label,
                   labelMode: state.labelMode, note: '',
                   magnets: state.magnets, screws: state.screws, holesEvery: state.holesEvery,
                   insert: state.insert, insertDepth: state.insertDepth,
                   fingerSlots: Object.assign({}, state.fingerSlots),
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
  /* and so does one whose release never reaches the page: let go in another window after
     an alt-tab, the map gets neither of the two above, only the capture going. The drag
     stayed on, the bin followed a pointer with no button held, and since the save waits
     for a press to be let go, nothing more was saved until the next press on the map.
     After an ordinary release or cancel the drag is already over and this does nothing. */
  svg.addEventListener('lostpointercapture', letGoOfMap);
}

/* ---------- actions ------------------------------------------------------- */
/* Two passes. The first is the fill there has always been: the new-bin size either way
   round, else a 1x1, tried at every whole cell — or at every half step when the new bins
   are half-size, so that they pack edge to edge rather than a half cell apart. The second
   only finds anything beside a half-size bin, which can leave part of a cell free that
   no whole bin fits: it takes those half strips and quarters, largest first. A layout of
   whole bins comes out of it exactly as it always did. */
$('fillRest').addEventListener('click', () => {
  landEdit();
  pushUndo();
  const g = grid();
  clearSel(); readControls();
  const sup = support(cur);
  // the slots taken so far, kept here so a step already full is passed without a search
  const taken = occupancy();
  const tryAt = (x, y, sizes) => {
    if (taken[slot(y)][slot(x)] !== -1) return;
    if (cur > 0 && !sup.ok[slot(y)][slot(x)]) return;
    for (const [u, v] of sizes) {
      if (!canPlace(x, y, u, v, -1)) continue;
      // on upper layers, only place where the support underneath is level
      const probe = { x, y, u, v };
      if (cur > 0) { const st = seat(probe, cur); if (!st.flat || !st.solidBelow) continue; }
      B().push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                 floorT: state.floorT, divX: state.divX, divY: state.divY,
                 solid: state.solid, scoop: state.scoop, label: state.label,
                 labelMode: state.labelMode, note: '',
                 magnets: state.magnets, screws: state.screws, holesEvery: state.holesEvery,
                 insert: state.insert, insertDepth: state.insertDepth,
                 fingerSlots: Object.assign({}, state.fingerSlots),
                 edges: Object.assign({}, state.edges) });
      for (const [px, py] of slotsOf(probe)) taken[py][px] = B().length - 1;
      return;
    }
  };
  const step = isHalfSize(state) ? 0.5 : 1;
  for (let y = 0; y < g.ny; y += step)
    for (let x = 0; x < g.nx; x += step) tryAt(x, y, [[state.u, state.v], [state.v, state.u], [1, 1]]);
  for (let y = 0; y < g.ny; y += 0.5)
    for (let x = 0; x < g.nx; x += 0.5) tryAt(x, y, [[1, 0.5], [0.5, 1], [0.5, 0.5]]);
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
  const b = B()[selected], sp = describeSplit(b);
  if (!sp) return;
  pushUndo();
  const src = Object.assign({}, b);
  /* A carved bin's mask is in its own box's coordinates, so every piece takes the part
     of it that falls in the piece's box, rebased to that box. Copying the whole mask
     into each piece read cells meant for the first piece in all of them — and outside
     the first, where nothing matched, the mask was ignored and the piece came out full,
     on top of the cell another bin held. A half-size bin has no mask, so its pieces
     are plain. */
  const kept = binCells(src), half = isHalfSize(src);
  B().splice(selected, 1);
  let oy = src.y;
  for (const vv of sp.ys) {
    let ox = src.x;
    for (const uu of sp.xs) {
      const rx = ox - src.x, ry = oy - src.y;
      const cells = half ? null
        : kept.filter(([x, y]) => x >= rx && x < rx + uu && y >= ry && y < ry + vv)
          .map(([x, y]) => [x - rx, y - ry]);
      if (half || cells.length)               // a piece the carve emptied is not a bin
        B().push(Object.assign({}, src, { x: ox, y: oy, u: uu, v: vv,
                                          cells: half || cells.length === uu * vv ? null : cells,
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
  if (!carving && carveOff(scratch || B()[selected])) return;   // greyed, see SHAPE_OFF
  carving = !carving;
  readControls(); drawMap();
});

$('mergeBins').addEventListener('click', () => {
  const sel = selAll();
  // the button is greyed for a half-size bin (SHAPE_OFF), but not only here
  if (sel.length < 2 || sel.some((i) => carveOff(B()[i]))) return;
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
    fingerSlots: Object.assign({}, bins[0].fingerSlots),
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
    labelMode: s.labelMode, magnets: !!s.magnets, screws: !!s.screws, holesEvery: !!s.holesEvery,
    insert: +s.insert || 0, insertDepth: +s.insertDepth || 0,
    fingerSlots: Object.assign({}, s.fingerSlots),
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
  for (const k of ['scoop', 'label', 'insertDepth']) if (!sameNum(t[k] || 0, b[k] || 0)) return k;
  if ((+t.labelMode || 0) !== (+b.labelMode || 0)) return 'labelMode';
  if ((+t.insert || 0) !== (+b.insert || 0)) return 'insert';
  if ((t.note || '') !== (b.note || '')) return 'note';
  if (lidSideBits(t.lidSides) !== lidSideBits(b.lidSides)) return 'lidSides';
  if (FINGER_SIDES.some((k) => !!(t.fingerSlots && t.fingerSlots[k]) !== !!(b.fingerSlots && b.fingerSlots[k])))
    return 'fingerSlots';
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
  const was = selected, wasCur = cur;
  layers = o.layers; cur = Math.min(o.cur, layers.length - 1);
  clearSel();
  if (keep >= 0 && B()[keep]) {
    selected = keep; B()[keep].sel = true; writeControls(B()[keep]);
  } else if (was >= 0 && cur === wasCur && B()[was]) {
    /* Out of focus the selection goes, and the panel, now "New bins", keeps the bin it
       last showed, as it does when you click away from one. It has to be that bin as
       the step left it: still showing what the step took back, the panel went on saying
       the bin had it, and readControls below handed it to the next bin drawn. */
    writeControls(B()[was]);
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
const evenParts = (total, n) => {
  const base = Math.floor(total / n), extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
};
/* A span of `n` cells starting at `at`, cut into k pieces as evenly as whole cells allow.
   The cuts fall on whole cells, so a piece that is whole-size starts on a whole cell, as a
   whole-size bin must (WHOLE_ON_WHOLE): a half cell at either end stays with the end
   piece, which makes that one half-size. evenParts gives its spare cells to the first
   pieces, so a half cell at the start turns the order round and lands on a smaller one:
   5.5 from column 1.5 is 1.5 + 2 + 2, not 2.5 + 2 + 1. For a whole span this is
   evenParts. */
function splitParts(at, n, k) {
  const head = Math.ceil(at) - at, tail = at + n - Math.floor(at + n);
  const parts = evenParts(n - head - tail, k);
  if (head && !tail) parts.reverse();
  parts[0] += head; parts[k - 1] += tail;
  return parts;
}
/* That holds for each axis on its own, and is not enough for a piece. One piece across a
   span with a half cell at BOTH ends keeps the two halves, and is a whole number of cells
   standing on a half step: a 3 wide from column 1.5 is 0.5 + 2 + 0.5, all one piece. Cut
   into rows, a 3 x 7.5 there gave a whole 3 x 4 at column 1.5, which Checks never
   questioned and a reload put on whole cells, on top of the bin beside it. It is the one
   case: a span cut in two or more gives its head to the first piece and its tail to the
   last, and every piece between starts on a whole cell. So where it leaves a whole-size
   piece, that span is cut in two instead, a half cell to each side (1.5 + 1.5), which
   makes every piece half-size whatever the other axis does. The pieces only get smaller,
   so the plan still fits the bed. Where every piece the other way is half-size anyway (a
   3 x 2.5 at column 1.5 is fine there) the span stays one piece. */
const wholeOnHalf = (x, y, u, v) => !isHalfSize({ u, v }) && !(onWhole(x) && onWhole(y));
function piecesStand(x0, xs, y0, ys) {
  for (let j = 0, y = y0; j < ys.length; y += ys[j++])
    for (let i = 0, x = x0; i < xs.length; x += xs[i++])
      if (wholeOnHalf(x, y, xs[i], ys[j])) return false;
  return true;
}
const halvesAtBothEnds = (at, n, parts) => parts.length === 1 && !onWhole(at) && onWhole(n);
// fewest pieces that each fit; ties broken towards squarer pieces
function splitPlan(b) {
  let best = null;
  for (let nx = 1; nx <= Math.ceil(b.u); nx++)
    for (let ny = 1; ny <= Math.ceil(b.v); ny++) {
      let xs = splitParts(b.x, b.u, nx), ys = splitParts(b.y, b.v, ny);
      if (!(Math.min(...xs) > 0 && Math.min(...ys) > 0)) continue;
      if (!piecesStand(b.x, xs, b.y, ys)) {
        if (halvesAtBothEnds(b.x, b.u, xs)) xs = splitParts(b.x, b.u, 2);
        else if (halvesAtBothEnds(b.y, b.v, ys)) ys = splitParts(b.y, b.v, 2);
        // never reached by the rule above, and refused all the same: no plan offered here
        // may be one a reload would have to move
        if (!piecesStand(b.x, xs, b.y, ys)) continue;
      }
      const pu = Math.max(...xs), pv = Math.max(...ys);
      if (!fitsBed(pu, pv)) continue;
      const n = xs.length * ys.length, ar = Math.max(pu, pv) / Math.min(pu, pv);
      if (!best || n < best.n || (n === best.n && ar < best.ar))
        best = { nx: xs.length, ny: ys.length, n, ar, pu, pv, xs, ys };
    }
  return best;
}
function describeSplit(b) {
  const p = splitPlan(b);
  if (!p) return null;
  const { xs, ys } = p;
  const names = [];
  for (const b of ys) for (const a of xs) names.push(`${a}×${b}`);
  return { plan: p, xs, ys, text: names.join(' + ') };
}

/* ---------- per-bin problems ----------------------------------------------
   One place decides what is wrong with a bin, so the badge on the map and the
   text in Checks can never disagree. Nothing here blocks placement — you may be
   about to fill in the thing that fixes it. */
/* Who claims each half slot of a layer: -1, one bin's index, or an array of them when
   two or more bins sit on the same slot. occupancyOf keeps only the last bin per slot,
   which is right for "what is here" and blind to the case that matters for Checks — a
   link holding two bins on one cell drew one, counted both, and reported nothing. */
function layerClaims(k) {
  const g = grid(), W = 2 * g.nx, D = 2 * g.ny;
  const cl = Array.from({ length: D }, () => new Array(W).fill(-1));
  (layers[k] ? layers[k].bins : []).forEach((b, i) => {
    for (const [x, y] of slotsOf(b)) {
      if (y < 0 || y >= D || x < 0 || x >= W) continue;
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
    for (const [x, y] of slotsOf(b)) {
      const c = cl[y][x];
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
    // Counted in half slots, and measured in cells from the bin's own corner.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, any = false;
    const X = slot(b.x), Y = slot(b.y), under = new Set();
    for (let j = 0; j < slot(b.v); j++)
      for (let i = 0; i < slot(b.u); i++) {
        if (occB[Y + j][X + i] === -1) continue;
        any = true;
        under.add(occB[Y + j][X + i]);
        x0 = Math.min(x0, i / 2); x1 = Math.max(x1, (i + 1) / 2);
        y0 = Math.min(y0, j / 2); y1 = Math.max(y1, (j + 1) / 2);
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
      for (let j = 0; j < slot(b.v); j++)
        for (let i = 0; i < slot(b.u); i++) covered.add(occB[Y + j][X + i]);
      for (const i of covered) {
        const bb = layers[k - 1].bins[i];
        if (!bb) continue;
        const spansX = b.x <= bb.x && b.x + b.u >= bb.x + bb.u;
        const spansY = b.y <= bb.y && b.y + b.v >= bb.y + bb.v;
        if (!spansX && !spansY)
          out.push(`sits inside the ${bb.u}×${bb.v} bin below on both axes, so it rests over open cavity and would drop in — span its full width or its full depth`);
        if (!allFullEdges(bb))
          out.push('the bin below has a lowered wall, so it has no stacking lip to sit on');
        else if (fingersBuilt(bb))
          out.push('the bin below has a finger slot, so it has no stacking lip to sit on');
      }
    }
    /* What stands in the holes of a bin below, past where this one comes down onto its
       lip (binReach): it stands on them instead, higher than its layer, with nothing to
       hold it. Said whatever else holds it up or does not. */
    for (const i of under) {
      const bb = layers[k - 1].bins[i], h = bb && holesIn(bb);
      if (h && h.over > 1e-9)
        out.push(`stands on the ${h.p.items} in the ${bb.u}×${bb.v} bin below, ${+h.over.toFixed(1)} mm ` +
          `higher than that bin's lip would hold it, so nothing keeps it in place; at ` +
          `${plural(h.units, 'unit')} that bin keeps them below its rim`);
    }
  }
  /* Bins print upright, so height is a bed constraint too — and an easy one to miss,
     because a deep drawer will let you ask for a bin far taller than the printer's Z.
     Splitting cannot help here: a bin is one piece, so the only fix is fewer units. */
  const lipUp = hasLip(b) ? LIP_H : 0;
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
  /* A foot only touches the socket walls on its outer sides, so a bin half a cell across
     has nothing holding it that way on a standard baseplate: alone in a socket it was
     measured sliding 21 mm. The bins beside it hold it, so this is a note, not a fault —
     but it is worth knowing before a drawer goes in with a gap beside one. Marked `thin`,
     because Checks says it once for every such bin in the drawer (warnings). */
  const thin = [b.u === 0.5 ? 'wide' : '', b.v === 0.5 ? 'deep' : ''].filter(Boolean).join(' and ');
  if (thin)
    out.push({ note: true, thin: true, t: `is only half a cell ${thin}. On a standard baseplate the bins ` +
      'beside it hold it in place; on its own it can slide about 21 mm in its socket' });

  const fw = (b.u - 1) * SPEC.pitch + 2 * SPEC.half, fd = (b.v - 1) * SPEC.pitch + 2 * SPEC.half;
  if (!((fw <= state.bedW && fd <= state.bedD) || (fd <= state.bedW && fw <= state.bedD)))
  {
    const sp = describeSplit(b);
    out.push(`is ${fw.toFixed(0)} × ${fd.toFixed(0)} mm, too big for your ${state.bedW} × ${state.bedD} mm bed in either orientation` +
      (sp ? ` — split it into ${sp.text}` : ''));
  }
  /* The check has always worked in millimetres; the fix is a number of units, so it
     says which one. Worked out from where this bin actually stands, so a bin on layer 2
     is told what fits on top of the bins under it, not what would fit on the baseplate. */
  if (!loose && st.z + b.hUnits * SPEC.unitH + LIP_H > g.avail + 0.001) {
    const fit = unitsUnder(g.avail - st.z);
    out.push(`reaches ${(st.z + b.hUnits * SPEC.unitH + LIP_H).toFixed(1)} mm, ` + (noRoomAbove(g)
      ? 'and the baseplate takes the drawer\'s whole height — ' : `past the ${g.avail.toFixed(1)} mm available — `) +
      (fit < 1 ? 'there is no room for a bin at all where it stands'
               : `${plural(fit, 'unit')} is the tallest that fits ${st.z > 0 ? 'on the bins under it' : 'here'}`));
  }
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
  /* A note, because the bin prints, with fewer removable dividers than it asks for: as
     many as leave every slot room for its plate, and the end ones the clearance at the
     plate's corner in the bin's rounded corners, and the plate some length, with room for
     the rails the other way beside a lone one (railedLimit), and the note says which
     stopped it; or as many as go in past the lip and the shelf and keep their
     plate where they cross, which notes of their own say (dividersWhy). A design from
     before the fields held them there can ask for 31 on a 1x1, where 10 fit at the usual
     plate and clearance. Its link keeps asking, so a thinner plate or a tighter clearance
     builds more without it being edited. A whole drawer of such bins says it once
     (warnings), once for each reason.
     Not of a bin built as one block, solid or with a floor that fills it, nor of a carved
     one: those have no rails at all (dividersBuilt), for want of a cavity rather than of
     room for slots. A 1x1x1 with a 3 mm floor asking for two was said to be built with
     none "as none leave every slot room", which was not why. Nor of a bin with holes
     across its floor: it is built with no dividers at all, not as many as fit, and
     insertIssues says that its dividers are left off; nor are its plates' notes below, as
     it has none (builtDivs). */
  const d = builtDivs(b);
  const cfg = Object.assign(binCfg(b), { u: b.u || 1, v: b.v || 1 });
  const short = [['divX', 'across', 'x'], ['divY', 'along', 'y']].filter(([k]) => d[k] < (b[k] || 0));
  if (b.divRemovable && !builtSolid(cfg) && !isCarved(b) && !holesIn(b) && short.length) {
    /* What brought each direction's count down (dividersWhy). The rails' own rules are
       said together as one note; what stands over a slot, the lip and the shelf, and what
       the plates keep where they cross or stand on the scoop, each in a note of its own. */
    const why = dividersWhy(cfg);
    /* The rails' own rules, said together as one note (railedLimit): the slots, the
       corners, and two more. 'lone': room for one divider's slot and a rail either side,
       but not for the rails the other way beside it, which are kept room for whether or
       not it has any, so that dividers the other way never take it away. 'length': the
       clearance at a plate's two ends leaves it under PLATE_MIN long, as a plate under
       PLATE_MIN tall is not listed either. Either would read wrongly
       as "none leave every slot room", as the slot itself has room. 'fit': two of those,
       or one of them with the slots or corners, said once for both directions, either of
       which may have none. */
    const railShort = short.filter(([k]) => ['slots', 'corners', 'lone', 'length'].includes(why[k]));
    if (railShort.length) {
      const rules = new Set(railShort.map(([k]) => why[k]));
      const by = rules.size < 2 ? [...rules][0]
        : [...rules].every((r) => r === 'slots' || r === 'corners') ? 'both' : 'fit';
      const more = railShort.some(([k]) => d[k]);
      const at = `a ${state.divT} mm plate at ${state.divClr} mm clearance`;
      const because = (them) => (by === 'slots' ? `${more ? 'no more' : 'none'} leave every slot room for ${at}`
        : by === 'corners' ? (more ? `more would stand the end ones so far into ${them} rounded corners that a plate would lose the clearance at its corner, with ${at}`
          : `even one would stand so far into ${them} rounded corners that its plate would lose the clearance at its corner, with ${at}`)
        : by === 'lone' ? `even one would leave too little room beside its slot for the rails of dividers the other way, with ${at}`
        : by === 'length' ? `the clearance at a plate's ends would leave it under ${PLATE_MIN} mm long, with ${at}`
        : by === 'fit' ? (them === 'their' ? `only those fit with ${at}` : `that is as many as fit with ${at}`)
        : `${more ? 'no more' : 'none'} leave every slot room and keep the end ones out of ${them} rounded corners with ${at}`);
      out.push({ note: true, group: `rails-${by}`,
        t: `is built with ${railShort.map(([k, w], i) => `${d[k] || 'no'}${i ? '' : ` removable divider${d[k] === 1 ? '' : 's'}`} ${w}`).join(' and ')}, ` +
           `not the ${railShort.map(([k]) => b[k]).join(' and ')} it asks for, as ${because("the bin's")}`,
        many: (n, names) => `${n} bins are built with fewer removable dividers than they ask for, as ` +
          `${by === 'slots' ? `no more leave every slot room for ${at}` : by === 'corners'
            ? `more would stand the end ones so far into their rounded corners that a plate would lose the clearance at its corner, with ${at}`
            : by === 'lone' || by === 'length' || by === 'fit' ? because('their')
            : `no more leave every slot room and keep the end ones out of their rounded corners with ${at}`}: ${names}` });
    }
    const stand = d.divX ? `cross the ones across${b.scoop ? ', or stand on the scoop' : ''}` : 'stand on the scoop';
    const REASON = {
      lip: (any) => `${any ? 'no more' : 'none'} can have a notch through the stacking lip clear of its corners`,
      shelf: (any) => `${any ? 'no more' : 'none'} fit in front of the label shelf, which a plate along cannot drop in under`,
      cross: (any) => `${any ? 'no more' : 'none'} keep ${PLATE_END} mm of plate where they ${stand}`,
      lipCorners: (any) => `${any ? 'more' : 'any'} would notch the stacking lip too close to its corners`,
      // both, where one more would go wrong both ways (dividersWhy)
      crossCorners: (any) => `${any ? 'no more' : 'none'} keep ${PLATE_END} mm of plate where they ${stand}, ` +
        `and ${any ? 'more' : 'any'} would notch the stacking lip too close to its corners`,
      /* A bin with a finger slot has no lip, and is counted without it, but for this: with
         more plates it would have no slot, and so its lip, which they would notch too close
         to its corners (dividersWhy). A fallback: no bin swept has reached it. */
      slot: (any) => `${any ? 'more' : 'any'} would leave no room for its finger slots, and it would have the ` +
        `stacking lip back, which ${any ? 'no more' : 'none'} can have a notch through clear of its corners`,
    };
    const MANY = {
      lip: 'no more can have a notch through the stacking lip clear of its corners',
      shelf: 'no more along fit in front of the label shelf, which a plate along cannot drop in under',
      cross: `no more along keep ${PLATE_END} mm of plate where they cross the ones across, or stand on the scoop`,
      lipCorners: 'more along would notch the stacking lip too close to its corners',
      crossCorners: `no more along keep ${PLATE_END} mm of plate where they cross the ones across, or stand on the ` +
        'scoop, and more would notch the stacking lip too close to its corners',
      slot: 'more would leave no room for their finger slots, and they would have the stacking lip back, which ' +
        'no more can have a notch through clear of its corners',
    };
    for (const r of Object.keys(REASON)) {
      const these = short.filter(([k]) => why[k] === r);
      if (!these.length) continue;
      out.push({ note: true, group: 'rails-' + r,
        t: `is built with ${these.map(([k, w], i) => `${d[k] || 'no'}${i ? '' : ` removable divider${d[k] === 1 ? '' : 's'}`} ${w}`).join(' and ')}, ` +
           `not the ${these.map(([k]) => b[k]).join(' and ')} it asks for, as ${REASON[r](these.some(([k]) => d[k]))}`,
        many: (n, names) => `${n} bins are built with fewer removable dividers than they ask for, as ${MANY[r]}: ${names}` });
    }
  }
  /* How its plates go in, where that is not simply any plate in any slot: notes, because
     the bin prints, and what the plates' rows and their files' names say as well. */
  if (b.divRemovable && !b.solid && !isCarved(b) && (d.divX || d.divY)) {
    const L = plateLayout(Object.assign(binCfg(b), { u: b.u || 1, v: b.v || 1 }), d);
    if (L.printed && L.pX.length && L.pY.length)
      out.push({ note: true, group: 'plates-cross',
        t: 'has removable dividers both ways, which halve together where they cross: put the plates across in first, slots up, then drop the plates along over them, slots down',
        many: (n, names) => `${n} bins have removable dividers both ways, which halve together where they cross: put the plates across in first, slots up, then drop the plates along over them, slots down: ${names}` });
    if (L.printed && L.pX.length && L.r)
      out.push({ note: true, group: 'plates-scoop',
        t: 'has its plates across cut at the bottom front corner to follow the scoop: that corner goes to the front',
        many: (n, names) => `${n} bins have their plates across cut at the bottom front corner to follow the scoop: that corner goes to the front: ${names}` });
    if (L.printed && L.along.some((a) => a.zb > L.zf))
      out.push({ note: true, group: 'plates-stand',
        t: 'has plates along that stand on the scoop, each made for its own slot: its row in the downloads says which',
        many: (n, names) => `${n} bins have plates along that stand on the scoop, each made for its own slot: their rows in the downloads say which: ${names}` });
    const free = L.scoopFree;
    if (L.printed && free && L.r < free - 1e-9)
      out.push({ note: true,
        t: `is built with ${L.r ? `a ${+L.r.toFixed(1)} mm scoop rather than ${+free.toFixed(1)} mm` : 'no scoop'}, so the plates across keep ${PLATE_END} mm of their front ends in their rails` });
  }
  /* The note raised on the label shelf. Notes, not faults: the bin prints either way,
     and these say how much of the note it prints. They name what was typed, which is
     why drawWarnings writes text rather than markup. A carved bin's own note already
     says its shelf is left off, and a solid block has no menu to have set. */
  if (+b.labelMode === 1 && !b.solid && !isCarved(b)) {
    const s = shelfNote(binCfg(b)), mm = (x) => +x.toFixed(1);
    if (s.why === '' && s.fit.cut)
      out.push({ note: true, t: `has its note cut short to fit its label shelf, ${mm(s.fit.cap)} mm tall: ` +
        `it prints as \u201c${s.fit.lines.join(' / ')}\u201d` });
    else if (s.why === '' && s.fit.cap < NOTE_SPEC.capMin - 1e-9)
      out.push({ note: true, t: `has its note ${mm(s.fit.cap)} mm tall${s.fit.lines.length > 1 ? ' on two lines' : ''}, ` +
        `under the ${NOTE_SPEC.capMin} mm that stays readable: its label shelf is too shallow for bigger letters` });
    else if (s.why === '' && s.fit.lines.length > 1)
      out.push({ note: true, t: `has its note on two lines, ${mm(s.fit.cap)} mm tall, as on one it would print ` +
        `under the ${NOTE_SPEC.capMin} mm that stays readable` });
    if (s.dropped.length && (s.why === '' || s.why === 'empty'))
      out.push({ note: true, t: `has ${s.dropped.length > 1 ? 'characters' : 'a character'} in its note that ` +
        `cannot print, so ${s.dropped.length > 1 ? 'they are' : 'it is'} left off: ${charList(s.dropped)}` });
    if (s.why === 'shallow')
      out.push({ note: true, t: (s.depth < 0.05 ? 'is too short for a label shelf to print its note on'
        : `has a label shelf only ${mm(s.depth)} mm deep, under the ${NOTE_SPEC.shelfMin} mm letters need`) +
        ', so its note is not printed' });
    if (s.why === 'noshelf' || s.why === 'back')
      out.push({ note: true, t: 'is set to print its note on its label shelf, but ' +
        (s.why === 'back' ? 'its back wall is lowered, so it has none' : 'it has none') });
    if (s.why === 'dividers' || s.why === 'narrow')
      out.push({ note: true, t: s.along
        ? 'has dividers along it that cut its label shelf too short for its note, so its note is not printed'
        : `has ${s.why === 'dividers' ? 'dividers across its label shelf too close together'
        : 'walls too thick'} for its note to fit between them, so its note is not printed` });
  }
  out.push(...insertIssues(b, loose ? null : st.z));
  out.push(...fingerIssues(b));
  return out;
}
/* Holes across the floor, for binIssues: notes, not faults, as the spec has them, bar
 * one. The bin prints either way; these say what it does not get, and what the things
 * standing in it do above it. The one fault is items that reach past the drawer's room
 * above the baseplate: the drawer would not shut on them, which is what the drawer
 * height check is there to say about a bin. `z` is where the bin stands, or null for a
 * loose bin, which has no drawer.
 *
 * Notes a whole drawer of bins would each repeat carry a `group`, and Checks says those
 * once for all the bins it fits (warnings): "Fill the rest" with holes for AA batteries
 * would otherwise put the same sentence under the map once a bin. `many(n, names)` is
 * that sentence for n bins. A solid block has no menu to have set. */
function insertIssues(b, z) {
  if (!(+b.insert > 0) || b.solid) return [];
  const h = insertPlanOf(b), out = [], mm = (x) => +x.toFixed(1);
  if (h.why === 'off' || h.why === 'solid') return out;
  const p = h.p;
  if (h.why === 'carved') {
    out.push({ note: true, t: `is a carved shape, so its holes for ${p.items} are left off: holes need a rectangle` });
    return out;
  }
  /* Kept clear of a label shelf the back wall's finger slot takes away, because laid out
     in its room they would come to more than one bin is built with, or stand too high for a
     slot (holesGaveWay, keptClearSay). The first keeps the holes the shelf's layout has;
     the second leaves none, never too short a one (insertHintSay says why). */
  const gave = keptClearSay(b, 'its'), their = keptClearSay(b, 'their');
  if (gave && h.why === 'none') {
    out.push({ note: true, group: `gave:none:${b.insert}:${gave.room}`,
      t: `has no holes for ${p.items}: they keep in front of where its label shelf would be, ${gave.room}, ` +
         'and there is no room there for even one',
      many: (n, names) => `${n} bins have no holes for ${p.items}: they keep in front of where their label ` +
        `shelves would be, ${their.room}, and there is no room there for even one: ${names}` });
    return out;
  }
  if (h.why === 'short' || h.why === 'none') {
    const under = h.under === 'shelf' ? 'its label shelf' : 'its rim';
    out.push(h.why === 'short'
      ? { note: true, group: `short:${b.insert}:${h.under}`, t: `is too short for holes for ${p.items}, so it has none: ` +
          `it has room for ${h.room > 0.05 ? `${mm(h.room)} mm` : 'none'} under ${under}, and a hole needs ${INSERT_SPEC.minDepth} mm`,
          many: (n, names) => `${n} bins are too short for holes for ${p.items}, so they have none: ${names}` }
      : h.byShelf
        ? { note: true, group: `noroom:${b.insert}`, t: `has a label shelf too deep to leave room in front of it for ` +
            `even one hole for ${p.items}, so it has none`,
            many: (n, names) => `${n} bins have label shelves too deep to leave room in front of them for even ` +
              `one hole for ${p.items}, so they have none: ${names}` }
        : { note: true, group: `none:${b.insert}`, t: `is too small for even one hole for ${p.items}, so it has none`,
            many: (n, names) => `${n} bins are too small for even one hole for ${p.items}, so they have none: ${names}` });
    return out;
  }
  /* More than one bin is built with (HOLES_MAX in bin.js): a fault, as the most notes one
     layout raises is, since what was asked for is not built. */
  if (h.why === 'many') {
    out.push({ err: true, group: `many:${b.insert}`, t: `would have ${h.count} holes for ${p.items}, more than ` +
        `the ${HOLES_MAX} one bin is built with, so it has none`,
      many: (n, names) => `${n} bins would have more holes for ${p.items} than the ${HOLES_MAX} one bin is ` +
        `built with, so they have none: ${names}` });
    return out;
  }
  // with holes, only ever kept for being too many
  if (gave)
    out.push({ note: true, group: `gave:many:${b.insert}`,
      t: `has its holes for ${p.items} kept clear of where its label shelf would be, ${gave.room}`,
      many: (n, names) => `${n} bins have their holes for ${p.items} kept clear of where their label shelves ` +
        `would be, since spread into that room there would be more than the ${HOLES_MAX} one bin is built ` +
        `with: ${names}` });
  const divs = !!(b.divX || b.divY), off = [divs ? 'dividers' : '', b.scoop ? 'scoop' : ''].filter(Boolean);
  if (off.length)
    out.push({ note: true, group: `off:${off.join()}`,
      t: `has holes for ${p.items}, so its ${off.join(' and ')} ${divs ? 'are' : 'is'} left off`,
      many: (n, names) => `${n} bins have holes across their floors, so their ` +
        `${divs ? 'dividers' : ''}${off.length > 1 ? ' and ' : ''}${b.scoop ? 'scoops' : ''} are left off: ${names}` });
  /* Past where a bin stacked on this one comes down, INSERT_SPEC.seat under the rim, the
     items are in its way, and in a lid's. Most stand above the rim, and are said to; the
     few that stop between the two are said to reach just under it. A bin with a lowered
     wall or a finger slot has no lip for either, so it is only worth saying of one that
     has. */
  if (h.over > 1e-9 && hasLip(b)) {
    const lid = !!b.lid && lidFits(b), up = h.above > 1e-9;
    const stand = up ? `standing ${mm(h.above)} mm above its rim` : `reaching to ${mm(-h.above)} mm under ` +
      `its rim, where a bin stacked on it comes ${INSERT_SPEC.seat} mm down`;
    out.push({ note: true, group: `above:${b.insert}:${h.units}:${lid}:${up}`,
      t: `has ${p.items} ${stand}, so nothing can stack on it` +
         `${lid ? ' and its lid will not go on' : ''}; at ${plural(h.units, 'unit')} they stay below the rim`,
      many: (n, names) => `${n} bins have ${p.items} standing ${up ? 'above their rims' : 'just under their rims'}, ` +
        `so nothing can stack on them${lid ? ' and their lids will not go on' : ''}: ${names}. ` +
        `At ${plural(h.units, 'unit')} they stay below the rim` });
  }
  if (z !== null) {
    const g = grid(), reach = z + h.floor + p.len, avail = g.avail;
    if (reach > avail + 0.001)
      out.push(`has ${p.items} reaching ${mm(reach)} mm above the baseplate, ` + (noRoomAbove(g)
        ? 'and the baseplate takes the drawer\'s whole height' : `past the ${mm(avail)} mm available`) +
        ', so the drawer would not shut over them');
  }
  return out;
}

/* Finger slots, for binIssues: notes, not faults. The bin prints either way; these say
 * which walls ticked get no slot and why, and what made way for the slots it gets. Each
 * carries a `group`, so Checks says it once for every bin it fits (warnings), and
 * `many(n, names)` is that sentence for n bins. A bin that ticks none, or a solid block,
 * which has no walls to tick, is answered with nothing (fingerPlan). */
function fingerIssues(b) {
  const p = fingerPlan(b), out = [];
  if (!p) return out;
  const mm = (x) => +x.toFixed(1), least = FINGER.least + 2 * FINGER.keep;
  const sides = Object.keys(p.sides);
  const walls = (test) => sides.filter((k) => test(p.sides[k], k)).join('');
  const why = (w) => walls((s) => s.why === w);
  const wl = (ks) => `${wallList(ks)} wall${ks.length > 1 ? 's' : ''}`;
  const note = (group, t, many) => out.push({ note: true, group, t, many });
  if (why('carved')) {
    note('slot:carved', 'is a carved shape, so its finger slots are left off: they need a rectangle',
      (n, names) => `${n} bins are carved shapes, so their finger slots are left off: ${names}`);
    return out;
  }
  // a floor as thick as the bin is tall leaves a solid block, with no walls to dip
  if (why('solid')) {
    note('slot:solid', 'has a floor that fills it to the top, so there is no wall for a finger slot',
      (n, names) => `${n} bins have floors that fill them to the top, so there is no wall for a finger slot: ${names}`);
    return out;
  }
  const open = why('open'), low = why('low'), high = why('holes');
  if (open)
    note(`slot:open:${open}`, `has its ${wl(open)} open, so there is no finger slot there`,
      (n, names) => `${n} bins have their ${wl(open)} open, so there is no finger slot there: ${names}`);
  if (low)
    note(`slot:low:${low}`, `has its ${wl(low)} too low for a finger slot, so it has none there`,
      (n, names) => `${n} bins have their ${wl(low)} too low for a finger slot, so they have none there: ${names}`);
  const h = holesIn(b), items = h ? h.p.items : '';
  if (high)
    note(`slot:holes:${b.insert}:${high}`, `has its holes for ${items} reaching too high for a finger slot ` +
      `in its ${wl(high)}, so it has none there`,
      (n, names) => `${n} bins have their holes for ${items} reaching too high for a finger slot in their ` +
        `${wl(high)}, so they have none there: ${names}`);
  /* Too narrow: the compartments between dividers, where there are dividers across the
     wall, or else the wall itself, between its corners and whatever else keeps a slot
     off its ends (a ramp, the scoop, the label shelf). The dividers as built: removable
     ones no more than fit, and none with holes across the floor (builtDivs). */
  const divs = builtDivs(b);
  const across = (k) => (k === 'f' || k === 'b' ? divs.divX : divs.divY) > 0;
  const tight = walls((s, k) => s.why === 'narrow' && across(k));
  const short = walls((s, k) => s.why === 'narrow' && !across(k));
  if (tight)
    note(`slot:narrow:${tight}`, `has compartments under ${least} mm across along its ${wl(tight)}, too narrow ` +
      'for a finger slot, so it has none there',
      (n, names) => `${n} bins have compartments under ${least} mm across along their ${wl(tight)}, too ` +
        `narrow for a finger slot, so they have none there: ${names}`);
  if (short)
    note(`slot:short:${short}`, `has its ${wl(short)} too short for a finger slot, which needs ${least} mm ` +
      'of straight wall, so it has none there',
      (n, names) => `${n} bins have their ${wl(short)} too short for a finger slot, which needs ${least} mm ` +
        `of straight wall, so they have none there: ${names}`);
  const some = walls((s) => s.slots.length && s.narrow);
  if (some)
    note(`slot:some:${some}`, `has some compartments along its ${wl(some)} under ${least} mm across, too ` +
      'narrow for a finger slot, so those have none',
      (n, names) => `${n} bins have some compartments along their ${wl(some)} under ${least} mm across, too ` +
        `narrow for a finger slot, so those have none: ${names}`);
  // a slot held above the block the holes are in is shallower than half the wall
  const held = walls((s) => s.slots.length && s.held === 'holes');
  const heldN = [...held].reduce((n, k) => n + p.sides[k].slots.length, 0);
  if (held)
    note(`slot:held:${b.insert}:${held}`, `has its finger ${heldN > 1 ? 'slots' : 'slot'} in its ${wl(held)} ` +
      `stopping ${FINGER.clear} mm over its holes for ${items}, short of half way down`,
      (n, names) => `${n} bins have their finger slots in their ${wl(held)} stopping ${FINGER.clear} mm over ` +
        `their holes for ${items}, short of half way down: ${names}`);
  if (p.shelfOff) {
    const noted = +b.labelMode === 1 && !!(b.note || '').trim();
    note(`slot:shelf:${noted}`, 'has a finger slot in its back wall, so its label shelf is left off' +
      (noted ? ' and its note is not printed' : ''),
      (n, names) => `${n} bins have a finger slot in their back walls, so their label shelves are left off` +
        `${noted ? ' and their notes are not printed' : ''}: ${names}`);
  }
  if (p.scoop !== null && p.scoopWas - p.scoopNow > 0.05)
    note(`slot:scoop:${mm(p.scoopNow)}`, `has a finger slot in its front wall, so its scoop is held to ` +
      `${mm(p.scoopNow)} mm, under the slot`,
      (n, names) => `${n} bins have a finger slot in their front walls, so their scoops are held to ` +
        `${mm(p.scoopNow)} mm, under the slot: ${names}`);
  return out;
}

/* ---------- checks -------------------------------------------------------- */
function stackHeight() {
  const g = grid();
  /* Each layer's occupancy once, not once per cell: rebuilt inside the cell loop it was
     cells squared times layers, 4.2 s a redraw on a 100 × 100 grid of five layers. */
  const occs = layers.map((_, L) => occupancyOf(L));
  /* A bin stacked on one whose holes hold things standing past where it comes down
     rests on them, and things standing in the top bin's holes can be the highest of all
     (binReach): an AA bin of 3 units with a 3-unit bin on it was counted 46.0 mm where
     the stack is 81.7. Without them each layer is its height, and the top its lip. */
  const reach = layers.map((L) => L.bins.map(binReach));
  let top = 0;
  for (let y = 0; y < 2 * g.ny; y++)          // every half slot: see slotsOf
    for (let x = 0; x < 2 * g.nx; x++) {
      let h = 0, t = 0;
      for (let L = 0; L < layers.length; L++) {
        const i = occs[L][y][x];
        if (i === -1) continue;
        const r = reach[L][i];
        t = Math.max(t, h + r.H + LIP_H, r.items ? h + r.items : 0);
        h += r.pitch;
      }
      if (t > top) top = t;
    }
  return top;
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
  // the most different notes one layout raises (holdNotes), said the way the drawer's is
  if (notesOver)
    out.push({ err: true, t: `${RAISED_MAX + notesOver} different notes are set to print raised on label shelves, more than the ${RAISED_MAX} one layout prints, so the bins with the ${plural(notesOver, 'note')} after the first ${RAISED_MAX} print plain. Set some to Nothing; print a layout this labelled in parts.` });
  // and the most holes one layout builds (holdHoles), said the same way
  if (holesOver.kinds)
    out.push({ err: true, t: `${holesOver.used + holesOver.holes} holes are set across the floors of different bins, more than the ${HOLES_MAX} one layout builds, so the bins of the ${plural(holesOver.kinds, 'kind')} after the first ${holesOver.used} holes are built without them. Set some to Nothing; print a layout with this many holes in parts.` });
  /* Custom margins can leave the drawer no room for a cell. The Baseplates page builds
     nothing from a design like that, and says why; this page drew its one cell anyway,
     because grid() never draws fewer, and said nothing, so the design looked sound here
     and failed there. The test is the plate's own (see warnings in src/ui.js). A drawer
     too small for a cell without its margins is the drawer's doing, not theirs, and the
     plate puts that first too. Only numbers go in. */
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
     figure is the link's, so it is written as a number and only when it reads as one,
     though the panel is text now (drawWarnings). To the thousandth, so that no pitch platePitch
     calls non-standard is named as 42; and one too small to show there is not called a
     0 mm grid. */
  const pp = platePitch();
  if (pp !== null) {
    const shown = isFinite(pp) ? +pp.toFixed(3) : 0;
    out.push({ err: true, t: `The baseplate in this design is laid out on a ${shown > 0 ? `${shown} mm` : 'non-standard'} grid. These bins are made to the standard's ${SPEC.pitch} mm, so they will not seat in it: set Grid pitch on the Baseplates page back to ${SPEC.pitch} mm.` });
  }
  const tot = stackHeight();
  /* Both say the unit count that fits, since units are what the height field takes. A
     stack's lip is only the top one's, so a stack fits the same number of units in all as
     a single bin does: that is one figure, and it is the one Checks gives. */
  const fit = unitsUnder(g.avail);
  const fitText = fit < 1 ? 'There is no room above the baseplate for even a 1-unit bin.'
    : `The tallest that fits is ${plural(fit, 'unit')} (${fit * SPEC.unitH} mm + lip), in one bin or a stack.`;
  if (tot > g.avail + 0.001)
    out.push({ err: true, t: noRoomAbove(g) ? `The tallest stack is ${tot.toFixed(1)} mm, but ${whyNoRoom()}. ${fitText}`
      : `The tallest stack is ${tot.toFixed(1)} mm but only ${g.avail.toFixed(1)} mm is available above the baseplate. ${fitText}` });
  else if (tot > 0)
    // a stack within the 0.001 above of the room has a hair under none spare: not -0.0
    out.push({ t: `Tallest stack ${tot.toFixed(1)} mm of ${g.avail.toFixed(1)} mm available — ${Math.max(0, g.avail - tot).toFixed(1)} mm spare (includes the ${LIP_H.toFixed(2)} mm top lip). ${fitText}` });

  const claims = layers.map((_, k) => layerClaims(k));
  const where = (b, k) => `Layer ${k + 1}, the ${b.u}×${b.v} bin at column ${b.x + 1} row ${b.y + 1}`;
  /* The note about a bin half a cell across is said once for all of them. Said for each,
     "Fill the rest" with a half-cell-wide bin gave 126 copies of the same two sentences,
     some 23,000 characters, between the faults that matter. One such bin keeps its own. */
  const thin = [];
  /* Likewise any note a whole drawer of bins would each repeat: it carries a `group`, and
     is said once for all the bins it fits, by its `many(n, names)`. The holes' notes are
     among them, each kind once for all its bins (insertIssues). */
  const groups = new Map();
  layers.forEach((L, k) => L.bins.forEach((b) => {
    for (const it of binIssues(b, k, claims)) {
      if (it.thin) { thin.push({ b, k, t: it.t }); continue; }
      if (it.group) {
        if (!groups.has(it.group)) groups.set(it.group, []);
        groups.get(it.group).push({ b, k, it });
        continue;
      }
      const x = typeof it === 'string' ? { err: true, t: it } : it;
      out.push({ err: !x.note, note: x.note, t: `${where(b, k)}: ${x.t}.` });
    }
  }));
  if (thin.length === 1) out.push({ note: true, t: `${where(thin[0].b, thin[0].k)}: ${thin[0].t}.` });
  else if (thin.length) {
    const named = thin.slice(0, 3).map(({ b, k }) =>
      `the ${b.u}×${b.v} on layer ${k + 1} at column ${b.x + 1} row ${b.y + 1}`);
    if (thin.length > 3) named.push(`${thin.length - 3} more`);
    out.push({ note: true, t: `${thin.length} bins are only half a cell wide or deep: ` +
      `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}. On a standard ` +
      'baseplate the bins beside each one hold it in place; on its own one can slide about 21 mm in its socket.' });
  }
  // each said once, a fault when what was asked is not built (insertIssues' 'many')
  for (const list of groups.values()) {
    const say = (t) => (list[0].it.err ? { err: true, t } : { note: true, t });
    if (list.length === 1) { out.push(say(`${where(list[0].b, list[0].k)}: ${list[0].it.t}.`)); continue; }
    const named = list.slice(0, 3).map(({ b, k }) =>
      `the ${b.u}×${b.v} on layer ${k + 1} at column ${b.x + 1} row ${b.y + 1}`);
    if (list.length > 3) named.push(`${list.length - 3} more`);
    out.push(say(list[0].it.many(list.length,
      `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`) + '.'));
  }

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
  ? 'This bin is sound and fits your printer.'
  : 'Layout is sound and everything fits.');
/* Written as text, not markup. A check names what was typed into a bin's note when its
   letters cannot all print, so a "<" there has to come out as a "<". */
const checkLine = (t, cls) => {
  const d = document.createElement('div');
  if (!cls) { d.textContent = t; return d; }
  d.className = cls;
  d.appendChild(document.createElement('span')).textContent = t;
  return d;
};
function drawWarnings() {
  const w = warnings();
  const errs = w.filter((x) => x.err);
  $('warnings').replaceChildren(...(w.length
    ? w.map((x) => checkLine(x.t, `w${x.err ? ' err' : ''}`))
    /* 'Layout' is the drawer's word. Focus is looking at one bin, and a loose one
       has no layout at all to be sound. */
    : [Object.assign(document.createElement('div'), { className: 'hint', textContent: focusedAllClear() })]));

  // errors only in the stage: the panel keeps the notes and the all-clear, and a
  // second copy of "this is a carved shape" beside the map would be noise
  $('mapChecks').style.display = errs.length ? '' : 'none';
  $('mapChecksList').replaceChildren(...errs.map((x) => checkLine(x.t)));

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
const typeLabel = (t) => `${t.b.u}×${t.b.v}×${t.b.hUnits}` +
  (t.b.solid ? ' solid' : '') + (insertText(t.b) ? `, ${insertText(t.b)}` : '') +
  (fingerText(t.b) ? `, ${fingerText(t.b)}` : '') +
  (holesText(t.b) ? `, ${holesText(t.b)} each` : '') +
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
   from all four, as a finger slot does — so a bin with either is skipped here rather than
   offered a lid that could not attach. hasLip is the same test buildBin uses to decide. */
/* A carved bin keeps its lip, but lidPart only makes a rectangle: on an L it was a full
   125.5 × 83.5 plate over a shape with a corner missing, overhanging the cut-away cells
   by a whole cell. Shaping the lid to the cells is a lid builder of its own, so carved
   bins are not offered one, and the panel says why. */
const lidFits = (b) => hasLip(b) && !isCarved(b);
const L_LID = (b) => lidPart(G, Object.assign({}, binCfg(b), { lidSides: b.lidSides }));
/* Bin by bin, not type by type. A lid is not part of typeKey (the bin prints the same
   with or without one), and reading it off a type's first bin and counting the whole
   type left a lidded bin drawn after a plain one with no lid in any download, gave two
   lids for one drawn the other way round, and made two lids with different sides one
   kind, twice. Each lid is built once per type and set of sides. */
function lidParts() {
  const m = new Map(), built = new Map();
  for (const t of types()) for (const b of t.bins) {
    if (!b.lid || !lidFits(b)) continue;
    const bk = `${t.key}:${lidSideBits(b.lidSides)}`;
    if (!built.has(bk)) built.set(bk, L_LID(b));
    const L = built.get(bk);
    const key = `${b.u}x${b.v}:${L.meta.sides.join('')}`;
    // measured off the mesh this build already made, once per kind of lid
    if (!m.has(key)) m.set(key, { key, b, meta: L.meta, vol: meshVolume(L.polys), qty: 0 });
    m.get(key).qty++;
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}
const lidName = (d) => `lid-${d.b.u}x${d.b.v}-${d.meta.sides.join('') || 'flat'}`;

/* A bin's distinct plates, each with its mesh and how many the bin takes (dividerPlates),
   kept while the bin's settings are the same: the table, the plan, the preview and the
   ZIP all ask for them, and a plate with halving slots is a mesh of its own to build. */
const platesSeen = new Map();
function platesOf(b) {
  const cfg = binCfg(b), key = JSON.stringify(cfg);
  if (!platesSeen.has(key)) {
    if (platesSeen.size > 200) platesSeen.clear();
    platesSeen.set(key, dividerPlates(G, cfg));
  }
  return platesSeen.get(key);
}
// a plate's outline in its own plane, for what it weighs: a plain one is its rectangle
const plateArea = (meta) => !meta.outline ? meta.span * meta.tall
  : Math.abs(meta.outline.reduce((a, p, i, o) => { const q = o[(i + 1) % o.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
function dividerParts() {
  const m = new Map();
  for (const t of types()) {
    /* Plates only for a bin that has rails to hold them, which dividerPlates says as
       buildBin builds them: none for fixed dividers, a solid or carved bin, or one whose
       floor fills it (a floor as thick as the bin is tall, which the floor field allows,
       made a plate of negative height: an STL turned inside out). As many as the bin
       has slots for, which is not always as many as it asks for, and none for one with
       holes across its floor, which has no dividers (dividerPlates goes by binDividers,
       as builtDivs does). A plain plate is the rectangle it always was, grouped to the
       0.1 mm its name gives; one shaped to pass the scoop or to halve with the plates
       the other way is grouped by its exact outline, so two that differ go in as two
       parts, and two bins that take the same one share its file. */
    for (const p of platesOf(t.b)) {
      const key = p.meta.outline ? p.key : `${p.meta.span.toFixed(1)}x${p.meta.tall.toFixed(1)}x${p.meta.t}`;
      if (!m.has(key)) m.set(key, { key, axis: p.axis, b: t.b, meta: p.meta, polys: p.polys, uses: [],
                                    vol: plateArea(p.meta) * p.meta.t, qty: 0 });
      const d = m.get(key);
      d.qty += p.qty * t.qty;
      /* What is the bin's and not the plate's goes with each bin type that takes it:
         which of its slots it is for. Kept from the first type alone, a plate standing on
         the scoop in the 1st slot of one 2x2x6 and the 2nd of another was listed for the
         1st of both, where it stands about 1.9 mm over the lip. The rest of its meta is the
         plate's: its outline is its key, and its slot's width the page's plate and
         clearance, the same for every bin. */
      d.uses.push({ t, ks: p.ks });
    }
  }
  const out = [...m.values()].sort((a, b) => b.qty - a.qty);
  /* Where plates go in more than one bin type, which bins a shaped plate is for, by their
     files in the download (plateHow). The names are worked out once here: typeNames
     builds every type's dividers, and asked for each plate's words it made the export
     rows of 56 bins of 20 types take 195 ms rather than 16. */
  const withPlates = new Set(out.flatMap((d) => d.uses.map((u) => u.t.key)));
  const binned = withPlates.size > 1, names = binned && out.some((d) => d.meta.outline) ? typeNames() : null;
  for (const d of out) {
    d.binned = binned;
    if (names) for (const u of d.uses) u.file = (names.get(u.t.key) || typeName(u.t)) + '.stl';
  }
  /* Named by size, and a shaped one by which way it stands and what it is shaped for, so
     the file says how it goes in: "across-slots-up", "along-slots-down", "-scoop" for the
     corner cut to the scoop, "-on-scoop" for one that stands on it. Two of a name that
     still differ, made for different slots, are told apart by a number. */
  const seen = new Map();
  for (const d of out) {
    const m2 = d.meta, size = `divider-${m2.span.toFixed(1)}x${m2.tall.toFixed(1)}x${m2.t}mm`;
    const base = !m2.outline ? size : size + (d.axis === 'y'
      ? '-across' + (m2.slots ? '-slots-up' : '') + (m2.cut ? '-scoop' : '')
      : '-along' + (m2.slots ? '-slots-down' : '') + (m2.stands ? '-on-scoop' : ''));
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    d.name = n > 1 ? `${base}-${n}` : base;
    d.base = base;
  }
  /* And its words, once, for its row and the README. Two plates along of one name can
     still read alike, made for different slots of one bin: on a 1x1.5x4 with a 40 mm
     scoop, one across and two along, the plate across meets the scoop beside the front
     crossing, so the front plate along has its slot from the bottom 0.14 mm taller than
     the back one's. Those say their slots as well, as one on the scoop does. They are
     found by name and bin type, not by their words: where plates go in more than one
     type of bin the words end in each plate's bins, and the same 1x1.5x4 beside one with
     no scoop has its back plate along shared with that bin and its front one not, so the
     two read differently and still neither said which slot it was for. */
  for (const d of out) d.how = plateHow(d);
  const alike = new Map();
  for (const d of out) {
    if (!d.meta.outline || d.axis !== 'x' || d.meta.stands) continue;
    for (const u of d.uses) {
      const k = `${d.base} ${u.t.key}`;
      if (!alike.has(k)) alike.set(k, new Set());
      alike.get(k).add(d);
    }
  }
  for (const g of alike.values()) if (g.size > 1) for (const d of g) { d.bySlot = true; d.how = undefined; d.how = plateHow(d); }
  return out;
}
const dividerName = (d) => d.name;
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const andList = (n) => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
const slotsFromFront = (ks) => `the ${andList(ks.map(ordinal))} slot${ks.length > 1 ? 's' : ''} from the front`;
/* Which slots a plate along is for, where it stands on the scoop or would read as another
   of its size does (bySlot, dividerParts). It is made for its own slot, and two
   bin types that take the same plate need not take it in the same one: a 2x2x6 with a
   40 mm scoop takes it in its 1st slot with 2 along and its 2nd with 5. So where plates
   go in more than one bin type, the slots are said bin by bin, naming each bin by its
   file in the download (dividerParts), and the bins that take it in the same slots
   together; with plates for one bin type, as a layout of one bin always has, they are
   said as before. */
function slotsFor(d) {
  if (!d.binned) return slotsFromFront(d.uses[0].ks);
  const by = new Map();
  for (const u of d.uses) {
    const k = u.ks.join(',');
    if (!by.has(k)) by.set(k, { ks: u.ks, bins: [] });
    const g = by.get(k);
    if (!g.bins.includes(u.file)) g.bins.push(u.file);
  }
  return [...by.values()].map((x, i) => `${i ? `the ${andList(x.ks.map(ordinal))}` : slotsFromFront(x.ks)} of ` +
    andList(x.bins)).join('; ');
}
/* How a shaped plate goes in, for its row and the README; '' for a plain one, which goes
   in any slot either way round. Where plates go in more than one bin type, a shaped one
   names the bins it is for as well, as one on the scoop names its slots in them: two
   plates across of one size, cut to scoops of 8 and 10 mm, were two rows word for word
   alike, and the one for the 8 mm scoop goes into the other bin 0.79 mm high, over the
   rim. A plain plate goes in any bin of its size, and says nothing. Worked out once for
   each plate in dividerParts, which keeps it as d.how. */
function plateHow(d) {
  if (d.how !== undefined) return d.how;
  const m = d.meta;
  if (!m.outline) return '';
  const where = m.stands || d.bySlot ? `for ${slotsFor(d)}`
    : d.binned ? `for ${andList([...new Set(d.uses.map((u) => u.file))])}` : '';
  if (d.axis === 'y')
    return [m.slots ? 'across, slots up: these go in first' : 'across',
            m.cut ? 'cut corner to the front, over the scoop' : '', where].filter(Boolean).join(', ');
  return [m.slots ? 'along, slots down: these go in over the plates across' : 'along',
          m.stands ? 'stands on the scoop' : '', where].filter(Boolean).join(', ');
}

function types() {
  const m = new Map();
  for (const { b } of scoped()) {
    /* "Printed" is a queue fact: it drops a bin off the plates because it is already
       sitting in the drawer. In focus you are looking AT one bin and asking for its
       STL, and filtering it out there answers with an empty table and no download. */
    if (b.done && !focused) continue;
    const k = typeKey(b);
    if (!m.has(k)) m.set(k, { key: k, b, qty: 0, notes: [], bins: [] });
    const t = m.get(k);
    t.qty++;
    t.bins.push(b);   // for what is not part of the type: its lid (lidParts)
    /* What you wrote in the bin travels with its type, because "1x1x3 x 2" is the one
       thing a row of the download table cannot tell you: which of the four identical
       shapes on the plate is the one for drill bits. Notes are NOT part of typeKey — two
       bins the same shape share one STL whatever they are for — so a type can carry
       several, and all of them are worth showing. The exception is a note printed on
       the bin's shelf, which makes it a part of its own (noteKey). */
    const n = (b.note || '').trim();
    if (n && !t.notes.includes(n)) t.notes.push(n);
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}
function refresh() {
  holdNotes(); holdHoles();
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
    /* With no room there is no tallest bin either, nor with room under a 1-unit bin and
       its lip: capUnits is never under 1, and it said "tallest single bin 1 units" there
       while Checks said no 1-unit bin fits. */
    (noRoomAbove(g) ? ` · no room above the baseplate, as ${whyNoRoom(also)}` :
    ` · ${g.avail.toFixed(1)} mm${also(g.avail)} above the baseplate · ` + (unitsUnder(g.avail) < 1
      ? `too little for even a 1-unit bin (${SPEC.unitH} mm${also(SPEC.unitH)} + lip)`
      : `tallest single bin ${capUnits} units (${capUnits * SPEC.unitH} mm${also(capUnits * SPEC.unitH)} + lip), limited by ${capBy}`));
  // and the half cell under the size fields, which said 21 mm whatever the drawer was in
  $('halfCellLen').textContent = `${SPEC.pitch / 2} mm${also(SPEC.pitch / 2)}`;
  const src = scratch || (selected >= 0 && B()[selected] ? B()[selected] : state);
  $('binSizeHint').textContent =
    `${(src.u * SPEC.pitch - 0.5).toFixed(1)} × ${(src.v * SPEC.pitch - 0.5).toFixed(1)} × ${(src.hUnits * SPEC.unitH).toFixed(1)} mm (+${LIP_H.toFixed(2)} lip)`;
  drawHeight();
  // the speed menu's own entry says which kind of printer the list makes this one
  ESTIMATE.labelAuto($('printSpeed'), $('bedPreset'));

  /* Cells covered, not cells claimed: summing every bin's cells counted two bins on one
     cell twice and a bin off the grid in full, which is how 500 copies of one bin read
     "794%". Checks names the overlap; this is just how full the grid is. */
  let slots = 0;
  for (const row of occupancy()) for (const c of row) if (c !== -1) slots++;
  const used = slots / 4, total = g.nx * g.ny;     // in cells, so a half-size bin counts its part
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
  /* The plan first: the totals below weigh every part it packs, the divider plates and
     lids as well as the bins, and the plate times come from it. */
  computePlan();
  const job = jobEstimate();
  /* The table is built as markup and a note is text someone typed, so a note goes in
     escaped: a "<" in a note is a "<" on the screen, not the start of a tag. */
  const asText = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  $('typeRows').innerHTML = ts.map((t) => {
    const gm = geomFor(t.b);
    const g = gramsOf(gm.vol * t.qty);
    return `<tr><td class="mono">${t.b.u}×${t.b.v}×${t.b.hUnits}${t.b.solid ? ' solid' : ''}${compartments(t.b) ? ` · ${compartments(t.b)} comp` : ''}` +
      `${insertText(t.b) ? ` · ${asText(insertText(t.b))}` : ''}` +
      `${fingerText(t.b) ? ` · ${asText(fingerText(t.b))}` : ''}` +
      `${holesText(t.b) ? ` · ${asText(holesText(t.b))}` : ''}` +
      /* what it is for, beside what it is — the row is how you tell four identical
         shapes apart when they come off the plate */
      `${t.notes && t.notes.length ? `<span class="tnote">${asText(t.notes.join(', '))}</span>` : ''}</td>` +
      `<td class="mono">${gm.meta.W.toFixed(1)} × ${gm.meta.D.toFixed(1)} × ${gm.meta.totalH.toFixed(1)}</td>` +
      `<td class="mono">${t.qty}</td>` +
      `<td class="mono">${g.toFixed(0)} g${costTail(g)}</td>` +
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
      `≈ ${job.grams.toFixed(0)} g PLA at ${state.infill}% infill` +
      (doneN ? ' for those' : '') +
      (looseParts() ? `, ${looseParts()} included` : '') +
      (costOf(job.grams) ? `, about ${costOf(job.grams)}` : '') +
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
  /* `vol` is the filament one of each takes, in mm³, for the grams, the cost and the
     time: a bin's from its own estimate, which knows about infill; a divider plate's
     from its size, since a plate that thin prints solid; a lid's off its mesh. */
  const parts = ts.map((t) => ({
    key: t.key, b: t.b, qty: t.qty,
    meta: geomFor(t.b).meta, polys: () => geomFor(t.b).polys, vol: geomFor(t.b).vol,
  })).concat(dividerParts().map((d) => ({
    key: 'div:' + d.key, b: null, qty: d.qty, divider: d,
    meta: d.meta, polys: () => d.polys, vol: d.vol,
  }))).concat(lidParts().map((d) => ({
    key: 'lid:' + d.key, b: null, qty: d.qty,
    meta: d.meta, polys: () => L_LID(d.b).polys, vol: d.vol,
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
  // computed by refresh(), which weighs the job from it before this draws it
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
           `<div class="hint">plate ${i + 1} — ${countOf(pl.placed)}<br>` +
           `${plateFigures(plateEstimate(pl))}</div></div>`;
  }).join('');
  const job = jobEstimate();
  $('plateSummary').textContent =
    `${plural(good.length, 'plate')} on a ${state.bedW} × ${state.bedD} mm bed · ` +
    `${countOf(good.flatMap((p) => p.placed))} packed` +
    (over.length ? ` · ${plural(over.length, 'part')} TOO BIG for the bed` : '') +
    (good.length ? ` · about ${ESTIMATE.duration(job.min)} of printing on a ${speedName()}` +
                   (over.length ? ' for the plates that fit' : '') + ` (${ESTIMATE.ROUGH})` : '');
}
// "96 g · £1.92 · ≈ 3 h 15 min": a plate's weight, its cost once priced, its rough time
function plateFigures(e) {
  return `${e.grams.toFixed(0)} g${costTail(e.grams)} · ≈ ${ESTIMATE.duration(e.min)}`;
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
    // a plain plate's key rounds to 0.1 mm for grouping; the buffer wants the exact plate
    const exact = d.meta.outline ? d.key : [d.meta.span, d.meta.tall, d.meta.t].map((n) => n.toFixed(3)).join('x');
    const geo = partGeoOf('div:' + exact, () => d.polys);
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
   "bin-2x1x3-magnets-screws-qty4.stl" beside "bin-2x1x3-qty2.stl". A half-size bin is
   built without holes whatever its boxes say (holesBuilt), so its name says none:
   "bin-1.5x1x3-qty2.stl". */
const holeTag = (b) => (!holesBuilt(b) ? ''
  : '-' + [b.magnets ? 'magnets' : '', b.screws ? 'screws' : ''].filter(Boolean).join('-') +
    (everyMatters(b) ? '-every-cell' : ''));
/* A bin printing its note says so in its name, as the note shortened to a-z, 0-9 and
   dashes (noteSlug) behind "note": "bin-1x1x3-note-m3-screws-qty2.stl". Two bins with the
   same shape and different notes are two files, and the name says which is which. The
   word keeps a note from reading as the rest of the name: a note "solid" was
   "bin-1x1x3-solid-qty1", a solid block's name. A note that does not print stays out of
   the name, as it always has. */
const noteTag = (b) => { const p = printedNote(b); return p ? '-note-' + noteSlug(p.fit.lines.join(' ')) : ''; };
/* A bin with holes across its floor says what for, "bin-1x1x3-aa-holes-qty2.stl", and
   not the dividers it is built without; ahead of its note, which comes last, so the name
   reads "bin-1x1x3-aa-holes-note-aa-cells-qty1". One asked for holes it does not get is
   the plain bin, and is named as one. */
const insertTag = (b) => { const h = holesIn(b); return h ? `-${h.p.tag}-holes` : ''; };
/* A bin with finger slots says which walls, "bin-2x1x3-slot-fb-qty2.stl", in f, b, l, r
   order. One that ticked walls it gets none in is the plain bin, and named as one. */
const fingerTag = (b) => (fingersBuilt(b) ? `-slot-${fingersBuilt(b)}` : '');
function typeName(t) {
  const d = builtDivs(t.b);
  return `bin-${t.b.u}x${t.b.v}x${t.b.hUnits}${t.b.solid ? '-solid' : ''}` +
         `${d.divX || d.divY ? `-${d.divX}x${d.divY}div` : ''}${insertTag(t.b)}` +
         `${fingerTag(t.b)}${holeTag(t.b)}${noteTag(t.b)}-qty${t.qty}`;
}
/* typeName leaves out the walls and floor, lowered walls, a carved shape, the scoop and
   the label shelf, so two kinds of bin could share a name: a scooped 1x1x3 and a plain
   one were both "bin-1x1x3-qty1.stl". The ZIP keeps the last file of a name, so one of
   them was simply not in it. Kinds whose names differ only in their count, or not at
   all, are told apart by what differs between them: "bin-1x1x3-scoop8-qty2.stl" beside
   "bin-1x1x3-qty1.stl". Each tag is the thing itself, so a name does not change with
   the order bins were drawn in, and a default wall or floor is not named, so adding a
   thicker one leaves the others' names alone. A number is the last resort, for two
   kinds no tag tells apart. A name nothing shares stays exactly as it was. */
const edgeOf = (b, k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1);
const VARIANT_TAGS = [
  (b) => (b.solid || b.wall === BIN_DEFAULTS.wall ? '' : `wall${b.wall}`),
  (b) => (b.solid || builtFloorT(b) === builtFloorT(Object.assign({}, b, { floorT: BIN_DEFAULTS.floorT }))
    ? '' : `floor${builtFloorT(b)}`),
  // which walls, and how far: "low-f50" is the front at half height
  (b) => (b.solid || allFullEdges(b) ? ''
    : 'low-' + EDGES.filter((k) => edgeOf(b, k) < 1).map((k) => k + Math.round(edgeOf(b, k) * 100)).join('-')),
  // the cells it keeps, as hex: the same shape is the same name wherever it is drawn
  (b) => (maskBits(b) ? `shaped-${BigInt('0b' + maskBits(b)).toString(16)}` : ''),
  // a bin with holes across its floor is built without its scoop and dividers (holesIn)
  // the scoop and the shelf as built: a finger slot can hold the one and take the other
  (b) => {
    const s = scoopAsBuilt(b);
    return !b.solid && s && !holesIn(b) ? `scoop${s === b.scoop ? s : +s.toFixed(2)}` : '';
  },
  (b) => (!b.solid && labelAsBuilt(b) ? `label${labelAsBuilt(b)}` : ''),
  (b) => (!b.solid && b.divRemovable && (builtDivs(b).divX || builtDivs(b).divY) ? 'loose-dividers' : ''),
  // two bins holed for the same thing to different depths
  (b) => { const h = holesIn(b); return h ? `depth${+h.depth.toFixed(1)}` : ''; },
];
function typeNames() {
  const groups = new Map();
  const stemOf = (t) => { const n = typeName(t); return n.slice(0, n.lastIndexOf('-qty')); };
  for (const t of types()) {
    const n = stemOf(t);
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(t);
  }
  const names = new Map(), used = new Set();
  for (const [n, group] of groups) {
    const differ = group.length < 2 ? []
      : VARIANT_TAGS.filter((tag) => new Set(group.map((t) => tag(t.b))).size > 1);
    for (const t of group) {
      const stem = n +
        differ.map((tag) => tag(t.b)).filter(Boolean).map((s) => '-' + s).join('');
      let name = `${stem}-qty${t.qty}`;
      for (let i = 2; used.has(name); i++) name = `${stem}-${i}-qty${t.qty}`;
      used.add(name);
      names.set(t.key, name);
    }
  }
  return names;
}
/* One bin type as an STL. Two places offer this — the row in "Bins to print" and the
   row in the download dialog — and they are the one pair that could give you two
   differently named files for the same click. Both, and the ZIP, name it here. */
const fileName = (t) => typeNames().get(t.key) || typeName(t);
function downloadType(t) {
  saveBlob(G.stlBinary(geomFor(t.b).polys, 'bin'), fileName(t) + '.stl');
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
/* How the shaped divider plates go in, for the README, which is read at the printer with
   them in hand: each file, how many, and which way it goes. Nothing when every plate is
   plain and goes in any slot either way round, so such a README is as it always was. */
function platesReadme(parts) {
  const shaped = parts.filter((d) => d.meta.outline);
  if (!shaped.length) return [];
  const L = ['DIVIDER PLATES:'];
  for (const d of shaped) L.push(`  ${String(d.qty).padStart(3)} x  ${dividerName(d)}.stl  (${plateHow(d)})`);
  if (shaped.some((d) => d.meta.slots))
    L.push('  Where plates cross they halve together: put the plates across in first, slots up,',
           '  then drop the plates along over them, slots down. Lift them out the other way round.');
  L.push('');
  return L;
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
    const holes = holesIn(b);
    if (compartments(b)) L.push(`Compartments: ${compartments(b)}` +
      (b.divRemovable ? '  (removable divider plates, printed loose)' : ''));
    if (holes) L.push(`Holes: ${holes.n} for ${holes.p.items}, ${+holes.d.toFixed(2)} mm ` +
      `${holes.p.shape === 'hex' ? 'across the flats' : 'across'}, ${+holes.depth.toFixed(1)} mm deep`);
    /* The note raised on its shelf, as it prints: the lines it comes out as, which a note
       cut short or left partly off is not the same as the note above. */
    const raised = printedNote(b);
    if (raised) L.push(`Raised note: “${raised.fit.lines.join(' / ')}” on the label shelf, ` +
      `${+raised.fit.cap.toFixed(1)} mm letters on ${raised.fit.lines.length > 1 ? 'two lines' : 'one line'}` +
      (raised.fit.cut ? ', cut short to fit' : '') + '.');
    if (fingerText(b)) L.push(`Finger slots: ${fingerText(b)}`);
    if (b.lid && lidFits(b)) L.push('Lid: yes — prints upside down, no supports.');
    L.push(...holesReadme([{ b, qty: 1 }]));
    const job = jobEstimate();
    L.push(`Material: about ${job.grams.toFixed(0)} g of PLA at ${state.infill}% infill` +
           (looseParts() ? `, ${looseParts()} included` : '') + `${readmeCost(job.grams)}.`);
    L.push(...readmeTime(job));
    L.push('');
    L.push(scratch
      ? 'Designed on its own. It is not placed in a drawer.'
      : `It belongs at column ${b.x + 1}, row ${b.y + 1} of a ${g.nx} x ${g.ny} grid` +
        (layers.length > 1 ? `, on layer ${cur + 1}.` : '.'));
    L.push('');
    L.push(...platesReadme(dividerParts()));
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
  L.push(`Height above the baseplate: ${noRoomAbove(g) ? `none, as ${whyNoRoom()}` : `${g.avail.toFixed(1)} mm`}` +
    ` | tallest stack here: ${stackHeight().toFixed(1)} mm`);
  L.push(`Layers: ${layers.length}`);
  L.push('');
  L.push('BINS TO PRINT:');
  for (const t of ts) {
    const gm = geomFor(t.b);
    L.push(`  ${String(t.qty).padStart(3)} x  ${t.b.u}x${t.b.v}x${t.b.hUnits}` +
      `  (${gm.meta.W.toFixed(1)} x ${gm.meta.D.toFixed(1)} x ${gm.meta.totalH.toFixed(1)} mm incl. lip)` +
      `${t.b.solid ? '  solid' : ''}${compartments(t.b) ? `  ${compartments(t.b)} compartments` : ''}` +
      `${insertText(t.b) ? `  ${insertText(t.b)}` : ''}` +
      `${fingerText(t.b) ? `  ${fingerText(t.b)}` : ''}` +
      // a part of its own, with its note in letters on the shelf
      `${printedNote(t.b) ? '  note raised on the shelf' : ''}` +
      // the README is read beside a pile of printed parts, which is exactly when
      // "1x1x3" stops being enough to tell them apart
      `${t.notes && t.notes.length ? `  — ${t.notes.join(', ')}` : ''}` +
      `${holesText(t.b) ? `  ${holesText(t.b)} each` : ''}`);
  }
  L.push('');
  const job = jobEstimate();
  L.push(`Total: ${plural(scoped().length, 'bin')}` + (looseParts() ? ` plus ${looseParts()}` : '') +
         `, about ${job.grams.toFixed(0)} g of PLA${readmeCost(job.grams)}.`);
  const fix = holesReadme(ts);
  if (fix.length) L.push(...fix);
  L.push('');
  layers.forEach((Ly, k) => {
    /* A character for each cell, three wide. A layer holding a half-size bin is drawn
       at twice that resolution — a character for each half cell, two wide, so a cell is
       about as wide as before — and says so. Only that layer: every README a whole-cell
       layout has ever written comes out the same to the byte. */
    const occ = occupancyOf(k);
    const half = binsHaveHalf(Ly.bins);
    L.push(`LAYER ${k + 1} (front of the drawer at the bottom${half ? ', one letter per half cell' : ''}):`);
    const tag = (i) => (i === -1 ? '.' : String.fromCharCode(65 + (i % 26)));
    for (let y = 2 * g.ny - 1; y >= 0; y -= half ? 1 : 2)
      L.push('  ' + (half ? occ[y].map((i) => tag(i) + ' ')
        : occ[y].filter((_, x) => x % 2 === 0).map((i) => (i === -1 ? ' . ' : tag(i) + '  '))).join('').trimEnd());
    Ly.bins.forEach((b, i) => {
      const tag = String.fromCharCode(65 + (i % 26));
      L.push(`    ${tag} = ${b.u}x${b.v}x${b.hUnits}` + (b.note ? `  — ${b.note}` : ''));
    });
    L.push('');
  });
  if (printPlan) {
    const good = printPlan.plates.filter((p) => !p.overflow);
    L.push(`PRINT PLATES: ${good.length} on a ${state.bedW} x ${state.bedD} mm bed.`);
    // numbered as the plate files are, among the plates that fit (see plateName)
    good.forEach((pl, k) => {
      const e = job.plates[k], c = costOf(e.grams);
      L.push(`  plate ${k + 1}: ${countOf(pl.placed)}, about ${e.grams.toFixed(0)} g` +
             (c ? `, ${c}` : '') + `, roughly ${ESTIMATE.duration(e.min)}`);
    });
    L.push(...readmeTime(job));
    L.push('');
  }
  L.push(...platesReadme(dividerParts()));
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
  const zip = new JSZip(), names = typeNames();
  for (const t of types())
    zip.file(names.get(t.key) + '.stl', G.stlBinary(geomFor(t.b).polys, 'bin'));
  /* The dividers go in the same ZIP. A bin with rails and no plate is not a divided
     bin, and the ZIP is what someone downloads when they want the whole job. */
  for (const d of dividerParts())
    zip.file(dividerName(d) + '.stl', G.stlBinary(d.polys, 'divider'));
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
     still part of the design: without a save a reload put the printer's name back. Nor
     is it a printer known to be fast, so the times change with it: saving alone left the
     page timing a fast printer while the dialog and the README timed a standard one.
     refresh() redraws them, and saves as it always does at the end. */
  if (!bed) { refresh(); return; }
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
  /* The bin's height, when it is typed as a length, is typed in the same unit as the
     drawer: someone measuring in inches measures the part in inches too. Converted on
     its own because it is not a drawer measurement — state has no field for it, and
     the guard in chooseUnit compares drawer measurements only. */
  FIELDS.convert([$('hMm')], unit, to, $('hMmRow'));
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

/* ---------- the bin's height, three ways ----------
   A bin is a whole number of 7 mm units, and stays one: the link, saved drawers and
   every export carry units, so nothing past this field learns how the height was typed.
   What changes is what you may type. Someone sizing a bin for a part knows the part in
   millimetres, and was left dividing by seven and wondering whether the floor counted.

   Overall millimetres round to the NEAREST unit, because an overall height is a target
   and the nearest bin is the honest answer to it. Inside depth rounds UP, because it is
   a requirement: a bin a millimetre too shallow for the part is a bin the part does not
   go in. Both are worked out from the bin engine's own numbers (binHeights,
   unitsForTop and unitsForInside in bin.js), so the floor, the lip and the top quoted
   here are the floor, the lip and the top that get built.

   Which way you type is a habit of the person, not a property of the bin, so it is
   remembered on this device the way the mm/inch switch is, and never put in the link. */
const HEIGHT_KEY = 'drawerforge:height-entry:v1';
const H_MODES = ['units', 'overall', 'inside'];
let hMode = 'units';
const savedHMode = () => {
  try { const m = localStorage.getItem(HEIGHT_KEY); return H_MODES.includes(m) ? m : 'units'; }
  catch (err) { return 'units'; }        // private mode: units, as before
};
const saveHMode = (m) => {
  try { localStorage.setItem(HEIGHT_KEY, m); }
  catch (err) { /* private mode or a full quota: the menu still works, unremembered */ }
};
// the bin the height field is describing: the one on its own, the selected one, or the next
const heightSrc = () => scratch || (selected >= 0 && B()[selected] ? B()[selected] : state);
/* everything about a bin its heights depend on, bar the units being worked out. Screws
   are among them, because their holes raise the floor; so are the dividers it is built
   with, which stand to the full height whatever the walls do, and the cells, because a
   carved bin's walls are full height too. The new-bin settings have no cells of their
   own, and are a whole rectangle; nor is a half-size bin carved (buildBin drops its
   mask), so it is asked without one, or it would be quoted walled full height. They are
   drawn with fixed dividers whatever Removable says (readControls), so they are asked
   with fixed ones: held to the removable limit, a half-cell bin with its walls halved
   and one divider was quoted at the walls' height, where the bin drawn stands full
   height on its divider.
   A bin with holes across its floor takes everything else besides: it has no dividers
   to stand it full height (builtDivs), and the block its holes are in stands as high as
   they go, which the walls, the label shelf and the note on it all have a say in
   (binTop). So does one with finger slots ticked: whether they take its lip depends on
   where they fit, which is the whole bin (fingerSlotPlan, which binHeights asks). */
const heightCfg = (b) => Object.assign((+b.insert > 0 || fingersAsked(b)) && !b.solid ? binCfg(b) : {}, {
                            floorT: b.floorT, screws: b.screws, solid: b.solid, edges: b.edges,
                            ...builtDivs(b === state ? Object.assign({}, b, { divRemovable: false }) : b),
                            u: b.u || 1, v: b.v || 1,
                            cells: isHalfSize(b) ? null : b.cells || null });
const heightsOf = (b) => binHeights(Object.assign(heightCfg(b), { hUnits: b.hUnits }));
/* Which length the field takes for this bin. Inside depth when that is the menu's choice
   and the bin has an inside; a solid block has none at any height, nor has a tray open
   on every side, and the field used to show 0 for one and work a typed depth out as if
   it were hollow. Those take their height overall instead, and the label says so. */
const lengthMode = (b) => (hMode === 'inside' && !heightsOf(b).hollow ? 'overall' : hMode);
/* Both ways round through the engine's own heights, so a bin with its walls lowered is
   given the units that stand it, or hold the depth, at the height it is built to. */
const unitsFor = (mm, b) => {
  if (lengthMode(b) === 'inside') return fieldClamp('hUnits', unitsForInside(mm, heightCfg(b)));
  /* The height the field shows, typed back, is the bin it shows. A tray stands at its
     slab whatever its units, and the nearest stacking height to the 6 mm a 6-unit tray
     shows made it 1 unit: the same mesh, with another link and another place in a stack. */
  if (FIELDS.show(mm, unit) === FIELDS.show(heightsOf(b).top, unit)) return b.hUnits;
  return fieldClamp('hUnits', unitsForTop(mm, heightCfg(b)));
};
/* An inside depth as it is shown: to the hundredth of `per` millimetres — one for
   millimetres, 25.4 for inches — and rounded DOWN. To the nearest, it could be more than
   the bin holds: 2 units on a bare floor hold 9.1 mm, 0.358 in, shown as 0.36, and 0.36
   typed back is 9.144 mm, which takes 3. Rounded down, what is shown the bin holds, and
   typed back it is the same bin. The epsilon keeps 36 from showing as 35.99 because the
   sum that made it came to 35.99999999999999. */
const depthDown = (mm, per) => Math.floor(mm / per * 100 + 1e-6) / 100 * per;
/* What the typing came to, said beside the field. Millimetres to the hundredth because
   the inside depth is genuinely fractional — 35.95 on a 1.25 mm floor — and rounding
   it to 36 would quote a bin deeper than the one you get. A bin with every wall lowered
   is quoted at the height it stands, not at H: the Tray preset at 6 units read "42 mm
   overall" for a part 6 mm tall. */
function heightText(b) {
  const h = heightsOf(b);
  const mm = (x) => `${Math.round(x * 100) / 100} mm` + (unit === 'in' ? ` / ${FIELDS.inchText(x)} in` : '');
  // the depth in each unit as the field would show it in that unit
  const depth = (x) => `${Math.round(depthDown(x, 1) * 100) / 100} mm` +
    (unit === 'in' ? ` / ${FIELDS.inchText(depthDown(x, FIELDS.MM_PER_IN))} in` : '');
  return `${plural(b.hUnits, 'unit')} · ` +
    (h.top < h.H - 1e-6 ? `${mm(h.top)} tall` : `${mm(h.H)} overall`) +
    (h.lipH ? ` + ${h.lipH.toFixed(2)} mm lip` : '') +
    (b.solid ? ' · solid, nothing inside' : !h.hollow ? ' · open on every side' : ` · ${depth(h.inside)} inside`);
}
/* Called from refresh(), so it follows every change of bin, floor or unit. The length
   field is rewritten with the height actually built — 43 after typing 40 inside —
   but never under the caret, where it would turn "4" into "43" before the 0 lands. */
function drawHeight() {
  const b = heightSrc(), inMm = hMode !== 'units', mode = lengthMode(b);
  $('hUnitsRow').style.display = inMm ? 'none' : '';
  $('hMmRow').style.display = inMm ? '' : 'none';
  $('hMmLabel').textContent = `${mode === 'inside' ? 'Inside depth' : 'Height overall'} (${unit})`;
  if (inMm && document.activeElement !== $('hMm')) {
    const h = heightsOf(b);
    FIELDS.setLength($('hMm'), mode === 'inside'
      ? depthDown(h.inside, unit === 'in' ? FIELDS.MM_PER_IN : 1) : h.top, unit);
  }
  /* A live region is read out whenever it is written, the same words or not, and this
     runs on every redraw: typing a note announced the height again. */
  const said = heightText(b);
  if ($('hResult').textContent !== said) $('hResult').textContent = said;
}
/* Typing a length writes the units field and then goes the way typing units always
   went, so a bin can only ever be given a height through one door. A blank or a zero is
   mid-edit, not a request. */
$('hMm').addEventListener('input', () => {
  const mm = FIELDS.lengthOf($('hMm'), unit);
  if (!isFinite(mm) || mm <= 0) return;
  $('hUnits').value = unitsFor(mm, heightSrc());
  schedule();
});
$('hMm').addEventListener('change', () => schedule());
/* Leaving the field is when it is put right, and leaving does not always fire change:
   Enter fires it while the caret is still in the box, and then Tab fires nothing, so the
   "40" typed stayed over a bin 43 deep. Through schedule, not a redraw here and now, so
   a value typed a moment ago has reached the bin before the field is rewritten from it;
   and back in the box before the 180 ms are up, it is under the caret and left alone. */
$('hMm').addEventListener('blur', () => schedule());
function applyHMode(m) {
  hMode = H_MODES.includes(m) ? m : 'units';
  $('hMode').value = hMode;
}
$('hMode').addEventListener('change', () => {
  applyHMode($('hMode').value);
  saveHMode(hMode);
  drawHeight();
});

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
    const lip = hasLip(b) ? LIP_H : 0;
    return b.hUnits * SPEC.unitH + lip > state.bedH + 0.001;
  });
  if (!wide.length && !tall.length) {
    const w = Math.max(...bins.map((b) => footW(b.u))), d = Math.max(...bins.map((b) => footW(b.v)));
    const h = Math.max(...bins.map((b) => b.hUnits * SPEC.unitH +
      (hasLip(b) ? LIP_H : 0)));
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
  /* The material line weighs everything the files hold, divider plates and lids too, and
     carries the cost once there is a price; the line after it is the rough time. */
  const job = jobEstimate();
  const material = `about ${job.grams.toFixed(0)} g of PLA at ${state.infill}% infill` +
    (looseParts() ? `, ${looseParts()} included` : '') +
    (costOf(job.grams) ? `, about ${costOf(job.grams)} at ${ESTIMATE.perKg(est.get())}` : '');
  const time = job.plates.length
    ? `\nroughly ${ESTIMATE.duration(job.min)} of printing` +
      (job.plates.length > 1 && !fitNote() ? ` over ${plural(job.plates.length, 'plate')}` : '') +
      ` on a ${speedName()}${fitNote()} (${ESTIMATE.ROUGH})`
    : '';
  /* In focus the dialog is about one bin, and saying "7 × 9 cell grid" over a single
     STL is the same disagreement the README has to avoid. */
  const fb = fBin();
  $('exDesign').textContent = fb
    ? `One bin — ${fb.u} × ${fb.v} × ${fb.hUnits}` + (fb.note ? ` — ${fb.note}` : '') + '\n' +
      (scratch ? 'designed on its own, not placed in a drawer'
               : `from column ${fb.x + 1}, row ${fb.y + 1} of your drawer` +
                 (layers.length > 1 ? `, layer ${cur + 1}` : '')) + '\n' +
      material + time
    : n
    ? `${g.nx} × ${g.ny} cell grid in a ${state.drawerW} × ${state.drawerD} mm drawer\n` +
      `${plural(n, 'bin')} of ${plural(ts.length, 'distinct type')} over ${plural(layers.length, 'layer')}\n` +
      material + time
    : `${g.nx} × ${g.ny} cell grid in a ${state.drawerW} × ${state.drawerD} mm drawer — no bins in it yet`;
  const fit = bedFitText();
  $('exFit').className = 'exfit ' + fit.cls;
  $('exFit').textContent = fit.t;

  $('exFiles').innerHTML = '';
  const good = goodPlates();
  if (good.length) {
    exGroup('Pre-arranged print plates');
    /* Each plate says what it weighs, costs and roughly takes, and so does the whole
       set: "which plate tonight" is a question about time. The whole set's figures are
       the job's — every plate that fits, summed as the plan sums them. */
    const all = { grams: job.plates.reduce((a, e) => a + e.grams, 0), min: job.min };
    exRow('Every plate', `${plural(good.length, 'plate')} · ${plateFigures(all)} · 3MF` +
          (good.length > 1 ? ' in a ZIP' : ''),
          'Download', downloadAllPlates, { 'data-ex': 'allplates' });
    /* Per-plate downloads. The combined export already builds each plate on its own
       and zips them, so one plate at a time is the same call with the zip left off —
       and it is what you want when a print fails, or when you are only doing one
       plate's worth this evening. */
    good.forEach(([pl], k) => exRow(`Plate ${k + 1}`,
      `${countOf(pl.placed)} on a ${state.bedW} × ${state.bedD} mm bed · ` +
      `${plateFigures(job.plates[k])} · 3MF`, 'Download',
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
    /* A plate shaped to its slot says which way it goes in, and which go in first: the
       same words its file's name and the README give. */
    for (const d of dividerParts())
      exRow(`Divider ${d.meta.span.toFixed(1)} × ${d.meta.tall.toFixed(1)} × ${d.meta.t} mm × ${d.qty}`,
            (plateHow(d) ? plateHow(d) + ' · ' : '') + `slides into a ${d.meta.slot.toFixed(2)} mm slot · STL`, 'STL',
            () => saveBlob(G.stlBinary(d.polys, 'divider'), dividerName(d) + '.stl'), { 'data-ex': 'divider' });
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
  if (scratch) {
    o.bs = packLayers([{ bins: [scratch] }]);
    /* Its note beside it, as bnotes carries the layers' below, since packBin carries no
       note. Without it a loose bin's note was never saved: a reload, a saved drawer and
       the README's link all came back without it, and one raised on the shelf came back
       a plain bin under another name. Written only when there is a note, so a loose bin
       without one has the link it always had. */
    if (scratch.note) o.bsn = scratch.note;
  } else if (focused && fBin()) o.bf = `${cur}.${selected}`;
  o.bl = packLayers(layers);
  o.bseg = state.arcSegs;
  o.bdt = state.divT; o.bdc = state.divClr;
  /* The holes' clearance only when it is not 0, so every link from before there were
     holes, and every one since without a clearance set, comes out byte for byte as it
     did. loadFromHash reads its absence as 0. */
  if (state.holeClr) o.bhc = state.holeClr;
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
   an anchor, not a link to a drawer, and reloading for one threw the drawer away. The
   reload is that link, not this page reloaded (see forget in drawers.js). */
addEventListener('hashchange', () => {
  if (!isLayoutHash((location.hash || '').replace(/^#/, ''))) return;
  try { drawers.forget(); } catch (err) { /* the page never got as far as its drawers */ }
  location.reload();
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
/* The boot meant to set this browser's save aside and could not: the storage was full.
   Until the design changes at all the page does not write over that save either, which
   was then the one copy of it (see saveNow). */
let unkept = false;
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

/* Not while a press on the map is held (drag): the save waits for the release, which
   refreshes, and so sets it going again from there. On a link that set a layout aside,
   the first save to find the design changed takes the set-aside line above the map away
   (below), and a press that grabs a bin sets a save going. A drag held 400 ms met it:
   the save found the bin half moved, the map went up 43 px under the pointer, and the
   bin landed a row off. The save is the one thing that runs on a clock while a press is
   held (an edit still waiting lands at the press, landEdit), so holding it holds all a
   save changes above the map, the drawer bar's "not saving" too, rather than each line
   being held on its own. And what a save keeps is a design someone has let go of, not
   a bin half way across the map. */
function rememberState() {
  if (!hashReady) return;
  clearTimeout(hashSaveT);
  addEventListener('beforeunload', dropSave);
  hashSaveT = setTimeout(() => { if (!drag) saveNow(); }, 400);
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
  /* Any change ends unkept, one that sameDesign does not count among them: kept on
     until the first one it counts, a plate height or a view changed alone never reached
     this browser's save. */
  if (unkept && h !== bootDesc) unkept = false;
  // not a save another tab has moved on from, nor one the boot could not set aside (unkept)
  if (!drawers.isBehind(h) && !unkept) saveLocal(h);
  try { drawers.wrote(h, linkKeys(h, heldLink)); }   // and into the saved drawer this is, if it is one
  finally {
    /* Marked as this tab's own, or as someone's link's while the page still holds it as
       it arrived (see ownMark). After the drawer's save, so the mark names the save in the
       drawer the address is at: marked before it, a reload took the save before for its
       own, and after another tab put the drawer back to that one, the reload wrote this
       page's later change back over it. */
    if (!pastedOver()) {
      try { history.replaceState(drawers.stamp(h, linkedNow && bootDesc !== null), '', '#' + h); }
      catch (err) { /* some browsers refuse replaceState on file:// — a lost URL is not
                       worth an exception that stops the rest of the page working */ }
      ownHash = location.hash;
    } else {
      try { sessionStorage.setItem(PASTED_KEY, JSON.stringify({ save: DRAWERS.fingerprint(h),
        at: DRAWERS.fingerprint(ownHash) })); }
      catch (err) { /* not kept, Back offers nothing: no worse than before */ }
    }
  }
}
/* The address as this page last left it: as it arrived, then as each save wrote it. One
   that differs, with a layout in it, is a link gone to over this page, pasted or picked
   from the bookmarks, whose hashchange (above) has not run yet: a page busy drawing comes
   to a save that was waiting first. That save is still made, so the layout the link
   replaces holds the change and is set aside with it, but the address is the link's.
   Written back over, the hashchange found this page's design there and reloaded that,
   and the link was gone. */
let ownHash = null;
const pastedOver = () => ownHash !== null && location.hash !== ownHash &&
  isLayoutHash((location.hash || '').replace(/^#/, ''));
/* That save, and the address it left as it was, by fingerprint, for this tab: the layout
   the link sets aside is the save, and it is later than the address, which never had the
   change. Back to the address offers it, and only it (see `later` below). */
const PASTED_KEY = SAVE_KEY + ':pasted';
const pastedFrom = (prev) => {
  try {
    const r = JSON.parse(sessionStorage.getItem(PASTED_KEY) || 'null');
    return !!r && !!prev && r.save === DRAWERS.fingerprint(prev) &&
      r.at === DRAWERS.fingerprint(location.hash);
  } catch (err) { return false; }
};
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
    if (k === 'bhc') continue;                    // below, with its absence
    if (k === 'bmd' || k === 'bmh') continue;     // below, once the plate's size is known
    // a checkbox, so it cannot ride the generic .value path below
    if (k === 'dv') { $('showDrawer').checked = val === '1'; continue; }
    if (k === 'bnotes') { pendingNotes = val; continue; }
    if (k === 'bf') { pendingFocus = val; continue; }
    if (k === 'bs') { pendingScratch = val; continue; }
    if (k === 'bsn') { pendingScratchNote = val; continue; }
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
  /* The holes' clearance is written only when it is not 0 (descriptor), so a design
     without one is a design at 0, not one that keeps whatever the field held before it.
     readControls holds a number to the field's limits; anything else is 0. */
  const hc = Number(q.bhc);
  $('holeClr').value = String(q.bhc !== undefined && q.bhc !== '' && isFinite(hc) ? hc : 0);
}
/* Saved drawers live in src/shared-ui/drawers.js, shared with the baseplates page. What
   this page tells it is which keys of the design string are its own to write: exactly the
   ones loadFromHash above takes for itself rather than parking in hashExtras, so if one is
   added there it belongs here too. */
const BINS_OWN = new Set(['v', ...Object.keys(KEYS), 'pr', 'dv', 'bl', 'bseg', 'bdt', 'bdc', 'bhc',
                          'bmd', 'bmh', 'bnotes', 'bf', 'bs', 'bsn']);
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
   comes to this page's address, and that and the drawer must both have the change.
   A press still held on the map is let go first, as one the page loses is (letGoOfMap):
   the link can be followed from the keyboard, or tapped on a touch screen, while the
   mouse holds a bin. The bin stays where the drag had it, and what is saved is a design
   let go of. Left held, the bin went on following the pointer while the next page
   loaded, and letting go of it set a save going that put another layout in the address,
   the local save and the drawer after this one had been handed over. An edit still
   waiting for its pass lands too (landEdit), and only then is the address the next page
   is given made (`to`): made before, a width typed and the link followed at once handed
   over the width from before it, and the page saved the new one after. */
function leave(to) {
  letGoOfMap();
  landEdit();
  const href = to();
  if (hashReady) saveNow();
  drawers.handoff(href.slice(href.indexOf('#') + 1), linkKeys(descString(), heldLink));
  location.href = href;
}
// the guide holds no state, so hand it ours and it can hand it back
$('navGuide').addEventListener('click', (e) => {
  e.preventDefault();
  leave(() => '../guide/#' + descString());
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
  $(id).addEventListener('click', (e) => { e.preventDefault(); leave(platesHref); });

/* ---------- boot ---------------------------------------------------------- */
let timer = null;
/* No cache clearing here any more: the geometry caches are keyed by everything a build
   reads, so an edit that changes a bin misses the cache by itself, and refresh() lets go
   of the builds nothing uses. Clearing on every input rebuilt every type in the drawer
   because a note was typed, and leaked the old buffers each time. */
const editPass = () => { readControls(); drawLayerTabs(); drawMap(); refresh(); };
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { timer = null; editPass(); }, 180); };
/* An edit still waiting for its pass has it now, before something takes the selection
   away, so it goes to the bin it was typed for and not to the next one drawn. Fill the
   rest and a press on the map both clear the selection first thing: a 2 typed for the
   1.5 × 1 on a half step and pressed on either inside the 180 ms became the new bins'
   size, the refusal never having run. The whole pass, the map and the save with it:
   with the fields read alone, a drawer width typed and pressed on the map at once left
   the map drawn for the old grid, its grips and all, and the address and the saved
   drawer on the old width until the next edit. True when there was one to land.
   With `draw` false the edit is only read in, and the caller draws the rest of the pass
   (drawLayerTabs, drawMap, refresh): the map press, which draws them anyway. */
function landEdit(draw = true) {
  if (timer === null) return false;
  clearTimeout(timer); timer = null;
  if (draw) editPass(); else readControls();
  return true;
}
for (const id of ['drawerW', 'drawerD', 'drawerH', 'plateH', 'infill', 'bedW', 'bedD', 'bedH', 'gap',
                  'u', 'v', 'hUnits',
                  'wall', 'floorT', 'divX', 'divY', 'solid', 'arcSegs',
                  'edgeF', 'edgeB', 'edgeL', 'edgeR', 'scoop', 'label', 'note',
                  'divRemovable', 'divT', 'divClr',
                  'lid', 'lidF', 'lidB', 'lidL', 'lidR',
                  'fingerF', 'fingerB', 'fingerL', 'fingerR',
                  'magnets', 'screws', 'holesWhere', 'magnetD', 'magnetH',
                  'insert', 'insertDepth', 'holeClr'])
  $(id).addEventListener('input', schedule);
/* The bin's number fields too: leaving one is when a value typed past its limit is put
   back to the one in use, and leaving fires change, not input. */
for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR', 'divRemovable',
                  'lid', 'lidF', 'lidB', 'lidL', 'lidR',
                  'fingerF', 'fingerB', 'fingerL', 'fingerR',
                  'magnets', 'screws', 'holesWhere', 'magnetD', 'magnetH',
                  'insert', 'insertDepth', 'holeClr', ...BIN_FIELDS])
  $(id).addEventListener('change', schedule);
/* Choosing the note raised on a bin with no label shelf gives it one, 12 mm deep: the
   letters have nowhere else to go, and 12 is the depth the shelf's own hint suggests.
   Before the read, so the bin takes both in one step. */
$('labelMode').addEventListener('change', () => {
  if ($('labelMode').value === '1' && !(parseFloat($('label').value) > 0)) $('label').value = 12;
  schedule();
});
$('presetTray').addEventListener('click', () => {
  for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR']) $(id).value = '0';
  // a tray has no walls to dip, so it asks for no finger slots
  for (const id of ['fingerF', 'fingerB', 'fingerL', 'fingerR']) $(id).checked = false;
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
  /* First free spot scanning right then up from the original: by whole cells for a
     whole-size bin, which must stay on them, and by half cells for a half-size one, so
     a 1.5 wide bin's copy lands beside it rather than half a cell off. */
  const g = grid(), step = isHalfSize(src) ? 0.5 : 1;
  for (let dy = 0; dy < g.ny; dy += step)
    for (let dx = 0; dx < g.nx; dx += step) {
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
    /* In half steps a half-size bin moves half a cell, and shift resizes by half a cell,
       as the grips do. A whole-size bin always moves a whole cell: half a cell would put
       it on a half step, which it cannot sit on. The smallest a key shrinks to is a step,
       or the bin's own size if that is smaller. */
    const st = stepOf(), move = halfSteps && isHalfSize(b) ? 0.5 : 1;
    const [dx, dy] = nudge;
    let why = '';
    let dropped = false;
    if (e.shiftKey) {                       // shift-arrow grows or shrinks instead
      /* And over a whole size the bin may not take where it stands, to the half size
         beyond it, as Width and Depth step (sizeStep): 1.5 wide at column 1.5 goes to
         2.5 and to 0.5. Stopping on 2 or 1, refused, it could not be resized at all. */
      const by = (n, d) => Math.max(Math.min(st, n), n + d * st);
      let nu = by(b.u, dx), nv = by(b.v, dy);
      why = placeWhy(b.x, b.y, nu, nv, selected);
      if (why === WHOLE_ON_WHOLE && (by(nu, dx) !== nu || by(nv, dy) !== nv)) {
        nu = by(nu, dx); nv = by(nv, dy);
        why = placeWhy(b.x, b.y, nu, nv, selected);
      }
      if (!why) { pushUndo(); dropped = dropsShape(b, nu, nv); setFootprint(b, nu, nv); }
    } else {
      why = placeWhy(b.x + dx * move, b.y + dy * move, b.u, b.v, selected);
      if (!why) { pushUndo(); b.x += dx * move; b.y += dy * move; }
    }
    mapSay(why === WHOLE_ON_WHOLE ? why : dropped ? SHAPE_DROPPED_MAP : '');
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
// and the way the bin's height is typed, which is the same kind of habit
applyHMode(savedHMode());
// the steps this browser last chose; a layout holding a half-size bin turns them on anyway
halfSteps = readKey(STEPS_KEY) === 'half';
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
const OWN_KEYS = [...Object.keys(KEYS), 'pr', 'bl', 'bs', 'bsn', 'bseg', 'bdt', 'bdc', 'bhc', 'bmd', 'bmh', 'bnotes']
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
  /* Set aside only if the browser kept it: with its storage full, the page said the
     layout was set aside and offered a Put back that brought nothing back. */
  let keptAside = false;
  if (aside) {
    const asideLinked = linkKeys(saved, linked).length ? linked : '';
    writeKey(PREV_KEY, saved);
    keptAside = readKey(PREV_KEY) === saved;
    if (keptAside) writeKey(PREV_LINKED_KEY, asideLinked);
    /* With the record of whether it is a link's refused, the one left from the layout set
       aside before would answer for it. That goes, and put back, this one is yours: still
       better than not setting it aside (unkept), which keeps it only until the first
       change made on the link. */
    if (keptAside && readKey(PREV_LINKED_KEY) !== asideLinked) writeKey(PREV_LINKED_KEY, '');
    /* Not kept, it is not written over either (unkept), unless a hand-over of your own
       brings on anything the other page sets: then the save holds the drawer, bed or the
       other page's settings from before, and a bare visit took those back to the other
       page. One still carrying someone's link is that link, and your layout is kept. */
    if (!keptAside) unkept = !handOver || handOver.link.length > 0 || drawers.onlyMine(saved, src);
  }
  /* Back to your own earlier page over a link's layout, untouched, sets nothing aside: what
     the link replaced is aside already. That can be later than the page Back brings: a change
     whose save came due as the link was pasted is aside, and in no earlier address (see
     pastedOver). So that layout is offered, if it is the one aside and this is the address it
     came from, and no other: one aside for any other reason can be older than this page, and
     Put back went further back, not on. */
  const later = back && savedLinked && pastedFrom(readKey(PREV_KEY)) ? readKey(PREV_KEY) : '';
  const canPutBack = (replaces && !kept && (keptAside || (savedLinked && !!readKey(PREV_KEY)))) ||
    (back && (keptAside || (!!later && !sameDesign(later, src))));
  if (stalled) {
    showSetAside('This layout did not finish loading last time, so the page has started ' +
      'from its defaults rather than try it again.', canPutBack, true);
  } else if (src) {
    writeKey(LOADING_KEY, src);
    loadFromHash(src);
    if (!fromLink) $('restored').style.display = '';
    else if (canPutBack) {
      /* Your own layout handed over from the other page is no link, and a reload that
         started as the page's last save landed did not go back: either way, what is set
         aside is the layout you had here. */
      showSetAside(back && !note.reloaded
        ? 'This page went back to an earlier layout of yours. The later one is set aside.'
        : back || handedOver ? 'The layout you had here is set aside.'
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
ownHash = location.hash;
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
    // its note, cleaned as a layer's is (cleanNote): one short line, whatever the link says
    if (pendingScratchNote !== null) b.note = cleanNote(pendingScratchNote);
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
  const mine = new Set(slotsOf(b).map((p) => p.join(',')));
  for (const k of targets) {
    const clash = layers[k].bins.some((o) => slotsOf(o).some((p) => mine.has(p.join(','))));
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

