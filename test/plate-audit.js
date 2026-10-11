#!/usr/bin/env node
/* Watertightness audit for baseplates, matching the one the bins have had from the
 * start. Its absence is why this went unnoticed: fit-check.js proves a bin fits the
 * socket, and nothing ever asked whether the plate around that socket was closed.
 *
 * It is not. Every plate is generated without a top or bottom face — four outer
 * walls and the socket funnel surfaces, with neither annulus capping the ends. The
 * count is exactly 8 * arcSegs + 8 per cell: 4 outer-wall edges and 4*arcSegs socket
 * edges left unmatched at z=0, and the same again at the top.
 *
 * Capping a face that has holes in it is the one job earTriangulate fails at without
 * saying so — the same silent failure that shipped bins with 218 boundary edges.
 *
 * The caps are fixed, so a plate that prints in one piece is watertight.
 *
 * csgSubtract used to be lossy whatever it was handed — a watertight box minus a
 * watertight cutter came back with boundary edges for an interior hole, a blind pocket,
 * an edge notch and a corner bite alike — so magnets, screws and every split piece
 * carrying a notch inherited it. Three cases were quarantined by name for that, and all
 * three now pass.
 *
 * Others were quarantined in their place. They are not regressions — every one of them
 * is one to two orders of magnitude better than it was — but they leak, and a summary
 * line reading "all plates watertight" over a configuration a user can select from a
 * dropdown is the kind of reassurance this file exists to stop. The puzzle notch has
 * since come off that list; the two boss cases have not.
 *
 * The reassurance can also come from a case that is simply absent, which is worse because
 * nothing is even claimed. There was no case here for keyInsert 'top' in any of its four
 * housings, and all four were open by hundreds to thousands of edges; the three keyed
 * connectors had a case each and built the same bowtie plate three times, because the key
 * SHAPE comes from cfg.keyType and only the page kept it in step with cfg.connector. Both
 * are fixed below, and both were found by asking what a case actually builds rather than
 * whether it passes.
 *
 * `quarantine: '<reason>'` makes the audit fail BOTH if a healthy case regresses AND if
 * a quarantined one starts passing and nobody took it off the list. Red forever teaches
 * people to ignore a check; silent teaches them it never mattered. `worst: n` beside it
 * fails the case again past n bad edges, so a known leak cannot quietly grow.
 */
'use strict';
const G = require('../src/core.js');
const { checkOrientation, orientationNote } = require('./orientation.js');

/* Two drawers for the half-cell cases below: 4 × 4 cells and 2 × 2, each with a column
   and a row of half cells and a few millimetres of margin past them, the first on a bed
   that splits it into four pieces. */
const HALF_SPLIT = { drawerW: 192, drawerD: 194, bedW: 128, bedD: 128, marginMode: 'half',
                     strips: [1, 1] };
const HALF_SMALL = { drawerW: 107, drawerD: 108, marginMode: 'half', strips: [1, 1] };

const CASES = [
  { name: '1x1 solid', drawerW: 42, drawerD: 42 },
  { name: '2x2 solid', drawerW: 84, drawerD: 84 },
  { name: '3x3 solid', drawerW: 126, drawerD: 126 },
  { name: '3x3 skeleton', drawerW: 126, drawerD: 126, plateStyle: 'skeleton' },
  { name: '3x3 coarse arcs', drawerW: 126, drawerD: 126, arcSegs: 6 },
  { name: '3x3 magnets', drawerW: 126, drawerD: 126, magnets: true },
  /* Screws are the case that proved the cutters must not be thrown into one soup: the
     shank runs up the middle of its own counterbore, and a BSP cannot classify a point
     that is inside two shells of one "solid". */
  { name: '3x3 screws', drawerW: 126, drawerD: 126, screws: true },
  /* Must be big enough to split, or there are no seams and no connector is built --
     the first version of this case quietly measured a plain plate and "passed". */
  { name: '9x9 dovetail', drawerW: 400, drawerD: 400, connector: 'dovetail' },
  { name: '9x9 no joint', drawerW: 400, drawerD: 400, connector: 'none' },
  { name: '5x4 solid', drawerW: 210, drawerD: 168 },
  { name: '3x3 with margin', drawerW: 140, drawerD: 140, marginMode: 'auto' },
  /* A hand-placed split, which is the only path that reads cfg.rowCuts and cfg.colCuts —
     and with the bands cut at different columns, so the pieces do not line up and the two
     bands' seams meet a piece edge rather than each other. */
  { name: '4x4 manual split', drawerW: 168, drawerD: 168, splitMode: 'manual',
    rowCuts: [2], colCuts: [[1], [3]] },
  /* Every remaining connector, because all of them are dropdown options and only
     dovetail was ever covered. They have to be big enough to split, as above.
   *
   * keyType is spelled out beside connector and that is not decoration. buildPiece takes
   * the key's SHAPE from cfg.keyType and only the page kept the two in step
   * (`state.keyType = KEY_CONN.includes(state.connector) ? state.connector : 'bowtie'`),
   * so these three cases used to build one bowtie plate three times: identical piece,
   * identical 11577 polygons, identical everything. The puzzle key had never been built
   * by this file at all, and it was leaking 14 edges a plate the whole time. */
  { name: '9x9 bowtie', drawerW: 400, drawerD: 400, connector: 'bowtie', keyType: 'bowtie' },
  { name: '9x9 puzzlekey', drawerW: 400, drawerD: 400, connector: 'puzzlekey', keyType: 'puzzlekey' },
  { name: '9x9 snap', drawerW: 400, drawerD: 400, connector: 'snap', keyType: 'snap' },
  { name: '9x9 hclip', drawerW: 400, drawerD: 400, connector: 'hclip' },
  /* Top insert, for every connector that offers it — which is what the page offers when
     the key lives in the WALL (`keyInsertRow` is shown for hclip, or for a keyed
     connector with keyMount 'wall'), plus the snap, whose housing switches to the clip
     pocket on keyInsert 'top' whichever mount is selected.
   *
   * None of these had a case, and every one of them was non-manifold: 3536 bad edges on
   * the H-clip, 2658 on the bowtie, 7796 on the puzzle key, 1946 on the snap, and the
   * histogram was overwhelmingly use-count 1 — open boundary, on a dropdown option that
   * ships. clipConvexPrismTop cut the material away and closed nothing behind it. */
  { name: '9x9 hclip top', drawerW: 400, drawerD: 400, connector: 'hclip', keyInsert: 'top',
    opens: true },
  { name: '9x9 bowtie wall top', drawerW: 400, drawerD: 400, connector: 'bowtie',
    keyType: 'bowtie', keyMount: 'wall', keyInsert: 'top', opens: true },
  /* Watertight, and until unfoldFinished the only key housing in the file that still
     folded. It is also the only one whose cutter crosses the socket's CORNER cone: a key
     site sits where four cells meet, the wall mount puts the pocket in the rim rather than
     in a floor pad, and top insert makes it run from below the pocket floor up past the
     plate top. So a lobe arc and a cone arc cross at a shallow angle and csgSubtract dices
     the crossing into slivers a few microns wide, which fanned as they come stand on edge
     and fold: 12 coplanar folds, 1e-4 mm² each, on 3 of the 4 pieces at arcSegs 12 (14 on
     main), none at the arcSegs 6 the tool ships. It was quarantined for them; laid out on
     the finished piece they are gone, and the row now holds it clean. */
  { name: '9x9 puzzlekey wall top', drawerW: 400, drawerD: 400, connector: 'puzzlekey',
    keyType: 'puzzlekey', keyMount: 'wall', keyInsert: 'top', opens: true },
  { name: '9x9 snap wall top', drawerW: 400, drawerD: 400, connector: 'snap',
    keyType: 'snap', keyMount: 'wall', keyInsert: 'top', opens: true },
  /* The same housing over a floor pad rather than a wall, so the pocket sits 2.8 mm
     higher and cuts a different part of the cell. It is reachable: the page hides the
     insert control when the mount is 'floor' but does not reset it, and buildPiece asks
     only whether the connector is a snap. */
  { name: '9x9 snap floor top', drawerW: 400, drawerD: 400, connector: 'snap',
    keyType: 'snap', keyMount: 'floor', keyInsert: 'top', opens: true },
  { name: '3x3 magnets above', drawerW: 126, drawerD: 126, magnets: true, magnetSide: 'top' },
  { name: '3x3 magnets+screws', drawerW: 126, drawerD: 126, magnets: true, screws: true },
  /* Quarantined for most of this file's life, at 78 bad edges and then 5033 before that:
     30 used once and 40 used three times, a genuine open boundary on 3 of the 4 pieces.
     The reason on file was that the notch presents a reflex outline to the cutter. It
     does, and that was not the problem — a cell region minus this cutter is watertight
     with the reflex corner untouched. The outline was NON-SIMPLE: the neck flank ran a
     third of a millimetre past the point where the lobe circle crosses it and came back
     along itself, so extrudePoly gave the cutter two coincident side quads facing
     opposite ways and the BSP was being asked about points inside a shell twice. See
     puzzleShape. */

  /* --- half cells: Leftover space set to fill with them (marginMode 'half') ---
   *
   * A 21 mm column of cells along the right and a row along the back, wherever the
   * leftover has room (halfStrips in core.js). Each case names the strips it expects in
   * `strips`, [column, row], and the loop below fails it if the layout has any others:
   * a half-cell case that quietly built none is a solid margin, and passes everything
   * else here. Every one is probed half socket by half socket as well — see
   * halfSocketsCut — because a strip left as margin is just as watertight.
   *
   * They use a 128 mm bed so a 4 × 4 drawer splits into four pieces: every joint meets
   * the strips where a seam crosses them, which is all the joints have to do with them,
   * at a fraction of a 9 × 9 plate's build time. Magnets and the floor pad are 2 × 2,
   * the dearest builds in the file. */
  { name: 'half column', drawerW: 191, drawerD: 170, marginMode: 'half', strips: [1, 0] },
  { name: 'half row', drawerW: 170, drawerD: 191, marginMode: 'half', strips: [0, 1] },
  // both, with the quarter cell in the corner, no margin past them and the corners rounded
  { name: 'half both, rounded', drawerW: 189, drawerD: 189, marginMode: 'half', strips: [1, 1],
    outerRadius: 4 },
  /* A small pitch, where a half socket's corner is held smaller than a whole one's and
     comes out towards the plate's corner: the corner arc is capped by the half cell's
     own ring there, or it folds through the rim (six coplanar folds at pitch 14). */
  { name: 'half small pitch, rounded', pitch: 14, drawerW: 49, drawerD: 49, marginMode: 'half',
    strips: [1, 1], outerRadius: 4.88, connector: 'none' },
  // 0.05 mm of margin past the strip, which joins the half cell rather than make a sliver
  { name: 'half, sliver past', drawerW: 189.05, drawerD: 170, marginMode: 'half', alignX: 'end',
    strips: [1, 0] },
  // the leftover past the strips, placed by the alignment on the far side of the grid
  { name: 'half, margin left', drawerW: 199, drawerD: 199, marginMode: 'half', strips: [1, 1],
    alignX: 'start', alignY: 'start' },
  { name: 'half split dovetail', ...HALF_SPLIT },
  { name: 'half split no joint', ...HALF_SPLIT, connector: 'none' },
  { name: 'half split bowtie', ...HALF_SPLIT, connector: 'bowtie', keyType: 'bowtie' },
  { name: 'half split puzzlekey', ...HALF_SPLIT, connector: 'puzzlekey', keyType: 'puzzlekey' },
  { name: 'half split snap', ...HALF_SPLIT, connector: 'snap', keyType: 'snap' },
  { name: 'half split hclip', ...HALF_SPLIT, connector: 'hclip' },
  { name: 'half split hclip top', ...HALF_SPLIT, connector: 'hclip', keyInsert: 'top', opens: true },
  { name: 'half split snap top', ...HALF_SPLIT, connector: 'snap', keyType: 'snap',
    keyMount: 'wall', keyInsert: 'top', opens: true },
  { name: 'half staggered', ...HALF_SPLIT, drawerW: 6 * 42 + 24, splitMode: 'staggered' },
  { name: 'half split @6', ...HALF_SPLIT, arcSegs: 6 },
  { name: 'half skeleton', drawerW: 192, drawerD: 194, marginMode: 'half', strips: [1, 1],
    plateStyle: 'skeleton', connector: 'none' },
  { name: 'half magnets+screws', ...HALF_SMALL, magnets: true, screws: true },
  { name: 'half magnets above', ...HALF_SMALL, magnets: true, magnetSide: 'top' },
  { name: 'half extra floor', ...HALF_SMALL, bottomPad: 2 },

  /* Quarantined until now. The lobe's far pole points along the seam, the boundary
     between two cell regions runs down that same line, and both regions cut the same
     notch — so both carried the apex vertex and the vertical edge either side of it: one
     edge per notch used 4 times, two closed shells sharing an edge. It was left because
     every fix tried cost joint geometry: sliding the joint 0.09 mm along the seam landed
     the lobe on the socket's flat wall and opened five real edges, and reshaping the lobe
     moved the notch's reach, which the fit section at the foot of this file holds to 1e-9.

     Nothing about the notch has to move: the region does. The one past the pole now
     starts half a BLOAT beyond it rather than a BLOAT short, so the pole is in one region
     only (buildPiece). The notch, its reach and the plate's shape are what they were.

     It mattered beyond these cases because the count was luck. Where the two regions
     happened to split their copies of the apex edge at different heights the four uses
     landed on two edges and read clean, so anything that changed a region's outline —
     a margin's cut moving, a floor cap triangulated another way — turned a clean piece
     into a leaking one and back. Both smoothnesses, and half cells. */
  { name: '9x9 puzzle', drawerW: 400, drawerD: 400, connector: 'puzzle' },
  { name: '9x9 puzzle @6', drawerW: 400, drawerD: 400, connector: 'puzzle', arcSegs: 6 },
  { name: 'half split puzzle', ...HALF_SPLIT, connector: 'puzzle' },
  /* And with margins of four widths by a rounded corner, at the page's arc smoothness:
     the margins' cuts touching shells on main, and once they moved, a pole edge on two
     pieces where main's luck had held on one. */
  { name: 'puzzle, four margins', pitch: 20, drawerW: 80.25, drawerD: 60.55, mLeft: 0.05,
    mRight: 0.2, mFront: 0.4, mBack: 0.15, connector: 'puzzle', outerRadius: 4,
    bedW: 50, bedD: 50, arcSegs: 6 },
  /* Watertight, and folded until healCsgSeams fanned a dented face from a point that sees
     all of it. Where it puts a vertex back into an edge it sits a thousandth or two off,
     the face it mends comes out with a dent too small to see, and the fan from the face's
     first corner, or from its average, turned a sliver across the dent the wrong way:
     three coplanar folds on a piece, where main had edges used four times or nothing
     wrong at all. In the bed face by a puzzle notch on two pieces of the first two, which
     were pinned here as known; on one of the third, a 55 mm bed's split; and in the side
     of a tab on one of the fourth, which has four margins. It is not the puzzle's: the
     dent comes wherever the weld has to reach, the bottom face by a mounting pocket
     among them (see the mounting cases below). Each is now held to no fold on any piece.
     Over 1,200 random puzzle designs, 4,686 pieces, 143 pieces folded before and 2 do
     now, both on one design, with the one fold each that they have on main. */
  { name: 'puzzle 30 rows', pitch: 30, drawerW: 90, drawerD: 90, splitMode: 'manual',
    rowCuts: [1, 2], colCuts: [[], [], []], connector: 'puzzle', outerRadius: 4, arcSegs: 6,
    puzzle: { ...G.DEFAULTS.puzzle, clr: 0.2 } },
  { name: 'puzzle 20 quads', pitch: 20, drawerW: 80, drawerD: 80, splitMode: 'manual',
    rowCuts: [2], colCuts: [[2], [2]], connector: 'puzzle', outerRadius: 0, arcSegs: 6,
    puzzle: { ...G.DEFAULTS.puzzle, clr: 0.3 } },
  { name: 'puzzle 22, 55 bed', pitch: 22, drawerW: 88.3, drawerD: 66.3, marginMode: 'auto',
    bedW: 55, bedD: 55, splitMode: 'plates', connector: 'puzzle', outerRadius: 4, arcSegs: 6,
    puzzle: { ...G.DEFAULTS.puzzle, clr: 0.1 } },
  { name: 'puzzle 18, a tab side', pitch: 18, drawerW: 54.7, drawerD: 55.3, mLeft: 0.2,
    mRight: 0.5, mFront: 0.3, mBack: 1, splitMode: 'manual', rowCuts: [1, 2],
    colCuts: [[], [], []], connector: 'puzzle', outerRadius: 4, arcSegs: 6,
    puzzle: { ...G.DEFAULTS.puzzle, clr: 0.1 } },
  /* Four pieces meeting at a corner with puzzle tabs at a 0.35 mm fit (#72): two of them
     had an edge used four times beside a notch's pole, at every pitch from 31.6 to 52.2
     mm, and 0.34 and 0.36 were clean. A socket wall's facet plane, carried across the
     cell by the BSP, crossed the lobe's face 0.3 microns from where the side of the region
     across the junction crosses it, and no retry that keeps the cutters where they are
     moves that plane (the touch retries in buildPiece). */
  { name: 'puzzle 42 quads, 0.35', pitch: 42, drawerW: 168, drawerD: 168, bedW: 100, bedD: 100,
    connector: 'puzzle', arcSegs: 6, puzzle: { ...G.DEFAULTS.puzzle, clr: 0.35 } },
  /* A skeleton plate whose far cuts moved half a thousandth, clear of a vertex 0.0995 mm
     from them, so the strip its cells keep solid where the margin was ended a hair from
     the margin's own region: four edges each used four times. A cut that moves now moves
     at least a hundredth (clearCut in buildPiece). */
  { name: 'skeleton, cut a hair', drawerW: 85.25, drawerD: 85.25, mLeft: 0.417,
    mRight: 0.833, mFront: 0.417, mBack: 0.833, outerRadius: 6, connector: 'none',
    plateStyle: 'skeleton', arcSegs: 6 },
  /* The corner of what a skeleton cell hollows a thousandth or two inside the corner arc,
     the arc's next vertex that far past it: a needle of no width in the strip's underside
     and 12 open edges in the bed face of each. See openSplit, and the section on the
     hollow's corner further down, which sweeps the family. */
  { name: 'skeleton, needle 3.08', drawerW: 84.2, drawerD: 88.16, mLeft: 0.1, mRight: 0.1,
    mFront: 2.08, mBack: 2.08, outerRadius: 3.08, connector: 'none', plateStyle: 'skeleton',
    arcSegs: 6 },
  { name: 'skeleton, needle 4', drawerW: 84.29, drawerD: 89.43, mLeft: 0.145, mRight: 0.145,
    mFront: 2.715, mBack: 2.715, outerRadius: 4, connector: 'none', plateStyle: 'skeleton',
    arcSegs: 6 },

  /* A spoke of a cell's bottom cap a few thousandths from a corner of a mounting cutter.
     The cutter's two sides there cross the spoke a couple of thousandths apart,
     healCsgSeams takes the two crossings for one point, and the sliver of floor between
     them and the corner goes with it: three or six open edges in the bottom face at the
     pocket's rim. One cell with 6 mm magnets and 4 mm corners had it on main, at every
     arc smoothness, and was quarantined for it as near-coincident outlines in the cap,
     past healCsgSeams' tolerance; this is the shape of the bin fit test tile. A margin
     of 0.25 or 0.08 mm joined to the cell beside the corner (clearCut) moved the fan's
     centre onto two more. The fan now moves off any spoke that close (fanCentre). */
  { name: '1x1 magnets', drawerW: 42, drawerD: 42, magnets: true },
  { name: 'magnets, joined margins', drawerW: 84.75, drawerD: 84.75, mLeft: 0.25, mRight: 0.5,
    mFront: 0.25, mBack: 0.5, outerRadius: 4, magnets: true, connector: 'none', arcSegs: 6 },
  { name: 'screws, joined margins', drawerW: 84.24, drawerD: 84.24, mLeft: 0.08, mRight: 0.16,
    mFront: 0.08, mBack: 0.16, outerRadius: 4.88, magnets: true, screws: true, connector: 'none',
    arcSegs: 6 },
  /* And where fanCentre does not reach. Two sides of a cutter, carried across the cell
     as planes by the BSP, cross a spoke of the cap 0.031 mm apart, or the pocket's
     ceiling is welded a hair past healCsgSeams' tolerance, and the same sliver goes:
     three or six open edges at the rim of a pocket, on three plates that were closed on
     main until joined margins moved their cuts. Moving the fan's centre closed the first
     at every offset tried, the second at some and the third at none, so buildPiece now
     cuts a cell's pockets again when healCsgSeams says they came out open (see the
     fastener cut there). The fourth was closed and folded: three coplanar folds where a
     weld dented the bottom face and the fan from its first corner turned a sliver back
     (see the dented faces in healCsgSeams). */
  { name: 'magnets 50, joined', pitch: 50, drawerW: 50.47, drawerD: 102.19, mLeft: 0,
    mRight: 0.47, mFront: 1.13, mBack: 1.06, outerRadius: 6, magnets: true, connector: 'none',
    arcSegs: 6 },
  { name: 'from above 50, joined', pitch: 50, drawerW: 150.66, drawerD: 152.11, mLeft: 0.66,
    mRight: 0, mFront: 0.64, mBack: 1.47, outerRadius: 3, magnets: true, magnetSide: 'top',
    screws: true, connector: 'none', arcSegs: 6 },
  { name: '10 mm magnets, joined', drawerW: 42.64, drawerD: 126.99, mLeft: 0.64, mRight: 0,
    mFront: 0.19, mBack: 0.8, outerRadius: 5.75, magnets: true, magnetD: 10, connector: 'none',
    arcSegs: 6 },
  { name: 'screws, two sides joined', drawerW: 84.59, drawerD: 84.58, mLeft: 0.59, mRight: 0,
    mFront: 0.58, mBack: 0, outerRadius: 6, magnets: true, screws: true, connector: 'none',
    arcSegs: 6 },
  /* A dented face with no point that sees all of it: a dent between two straight runs, in
     the bottom face beside a screw hole. Only the ears lay it right; without them it is
     three coplanar folds (clean on main). */
  { name: 'ears, a dent between runs', pitch: 50, drawerW: 100, drawerD: 102, mLeft: 0,
    mRight: 0, mFront: 0.63, mBack: 1.37, outerRadius: 1.31, magnets: true, magnetSide: 'top',
    screws: true, connector: 'none', arcSegs: 6 },
  /* And three that laying a dented face out again made worse, each through the engine alone:
     the mounting sites 2 or 3.5 mm from a cell's centre (holeOffset, which the page does not
     set) with pockets small enough to fit there, at the small pitches. On the socket's
     sloped wall, a corner's fan stood triangles in the plane of an H-clip pocket's wall and
     folded them against it (four coplanar folds on each of two pieces that are clean on
     main); where a bowtie's cup cuts that wall, a corner's fan and then ears used two edges
     four times; ears turned a 3-corner sliver the weld had turned over back to face the
     plane, so its edges ran the same way as its neighbours' (three on each of two pieces).
     healCsgSeams now lays a face out again only where its plain fan lies back to back with
     it, and only in a layout whose every triangle lies within 60 degrees of the face, keeps
     its winding and repeats no edge. The bowtie kept folds where main has them by the
     cup, fewer (6 and 3 against main's 10 and 5), until healCsgSeams counted the faces it
     turns over and buildPiece cut the cup again (cutAgain): none now. The puzzle tabs
     keep three on each of the two pieces, at the sliver itself, which faces the wrong way
     however it is laid out; main builds those two clean, because its puzzle notch regions
     are cut differently (the pole moved into one region, above). */
  { name: 'H-clip above, holes in', pitch: 14.3, drawerW: 3 * 14.3, drawerD: 3 * 14.3,
    bedW: 400, bedD: 400, splitMode: 'manual', rowCuts: [1, 2], colCuts: [[], [], []],
    connector: 'hclip', keyType: 'bowtie', keyInsert: 'top', magnets: true, magnetSide: 'top',
    holeOffset: 2, magnetD: 2.4, hclip: { ...G.DEFAULTS.hclip, clr: 0.08 }, arcSegs: 6 },
  { name: 'bowtie cup, holes in', pitch: 14.5, drawerW: 3 * 14.5, drawerD: 3 * 14.5,
    bedW: 400, bedD: 400, splitMode: 'manual', rowCuts: [1, 2], colCuts: [[], [], []],
    connector: 'bowtie', keyType: 'bowtie', keyMount: 'wall', keyInsert: 'top', magnets: true,
    magnetSide: 'top', holeOffset: 2, magnetD: 2.5, key: { ...G.DEFAULTS.key, clr: 0.1 },
    arcSegs: 6 },
  { name: 'puzzle 20, holes in', pitch: 20, drawerW: 60, drawerD: 100, bedW: 400, bedD: 400,
    splitMode: 'manual', rowCuts: [1, 2], colCuts: [[], [], [1, 2]], connector: 'puzzle',
    keyType: 'bowtie', magnets: true, magnetSide: 'top', holeOffset: 3.5, magnetD: 5.1,
    puzzle: { ...G.DEFAULTS.puzzle, clr: 0.3 }, tab: { ...G.DEFAULTS.tab, clr: 0.3 }, arcSegs: 6,
    oriQuarantine: 'a 3-corner sliver the weld turned over', oriWorst: { B3: 3, C3: 3 } },
  /* An H-clip from above with its clearance at the top of the field, at a pitch Checks
     can offer it at: the side of the clip's pocket fans into slivers standing on edge,
     folded against the faces beside them (eight coplanar folds on main). Laying out only
     the faces whose fan folds onto itself, healCsgSeams leaves three on each of two pieces;
     unfoldFinished lays them out on the finished piece. */
  { name: 'H-clip above, clearance at the top', pitch: 14.3, drawerW: 3 * 14.3,
    drawerD: 3 * 14.3, bedW: 400, bedD: 400, splitMode: 'manual', rowCuts: [1, 2],
    colCuts: [[], [], []], connector: 'hclip', keyInsert: 'top', arcSegs: 6,
    tab: { ...G.DEFAULTS.tab, clr: 0.98 }, puzzle: { ...G.DEFAULTS.puzzle, clr: 0.98 },
    key: { ...G.DEFAULTS.key, clr: 0.93 }, hclip: { ...G.DEFAULTS.hclip, clr: 0.93 } },
  /* A cell whose pockets come out open is cut again (see the fastener cut in buildPiece),
     and here the turned cutters' cut reaches healCsgSeams' T-junction pass limit, ten
     times over the five pieces. Taken unguarded, that one try made the whole plate fail to
     build, where main builds it open. Until #76 it threw there: the throw was passed over,
     and the cutters nudged 1.7 microns, the try after it, closed every cell left open here
     (3 to 9 edges a piece; main has 9 and folds on every piece). Now the repair makes one
     point of those it was still putting into edges and settles, closed, so the turned try
     is kept itself: every piece's bytes change, and every piece is still watertight and
     oriented. So the row is named for what it was found as: it no longer reaches the catch
     that passes over a try that throws, and no row here does. Engine-only again: the
     sites 2.5 mm in, at 15.5 mm. */
  { name: 'a retry that throws', pitch: 15.5, drawerW: 3 * 15.5, drawerD: 5 * 15.5, bedW: 400,
    bedD: 400, splitMode: 'manual', rowCuts: [1, 2], colCuts: [[], [], [1, 2]],
    connector: 'snap', keyType: 'snap', keyInsert: 'top', magnets: true, screws: true,
    holeOffset: 2.5, magnetD: 3.3, screwHeadD: 3.3, screwHoleD: 1.7, arcSegs: 6,
    tab: { ...G.DEFAULTS.tab, clr: 0.3 }, puzzle: { ...G.DEFAULTS.puzzle, clr: 0.3 },
    key: { ...G.DEFAULTS.key, clr: 0.25 }, hclip: { ...G.DEFAULTS.hclip, clr: 0.25 } },

  /* --- quarantined: real, measured, not regressions, still leaking --- */

  /* Benign, but it has to be named rather than waved through: corner bosses of adjacent
     cells ABUT face to face on the cell boundary instead of overlapping by BLOAT, so
     every shared face is counted twice. All counts are 4 and 6, never 1 — no boundary
     edge, no hole. The fix is to bloat the bosses; it changes their footprint, so it is
     not a change to make while chasing something else. Was 2964 and 8332. */
  { name: '3x3 bosses+magnets', drawerW: 126, drawerD: 126, magnets: true,
    baseMode: 'bosses', quarantine: 'bosses abut, not overlap' },
  { name: '3x3 bosses+screws', drawerW: 126, drawerD: 126, screws: true,
    baseMode: 'bosses', quarantine: 'bosses abut, not overlap' },
  /* The bosses with half cells, which add nothing: the loop builds the case again as
     solid margin and requires the same edges used the same number of times. The bosses
     sit on whole cells, so the strips do not meet them. */
  { name: 'half bosses+magnets', ...HALF_SMALL, magnets: true, baseMode: 'bosses',
    quarantine: 'bosses abut, not overlap' },
];

let bad = 0;
/* Which of DEFAULTS' keys the builders actually look at, collected as they run. See the
   section at the foot of this file for what it is for. The proxy goes to core.js and
   nowhere else: Object.assign over it would enumerate every key and report the lot as
   read, which is the one way this measurement can lie. */
const readKeys = new Set();
/* And for marginMode, which values: it is one key with three meanings to core.js ('none'
   on the page arrives as 'custom' with no margins), and a mode no case hands the builders
   is as untested as a key they never read — see the foot of the file. */
const modesRead = new Set();
const watch = (cfg) => new Proxy(cfg, {
  get(t, k) {
    if (typeof k === 'string') readKeys.add(k);
    if (k === 'marginMode') modesRead.add(t[k]);
    return t[k];
  },
});

console.log('case              grid    polys   W x D x H (mm)          mesh');
for (const cs of CASES) {
  const cfg = Object.assign({}, G.DEFAULTS, {
    marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: 12,
  }, cs);
  const wcfg = watch(cfg);
  /* EVERY piece, not just the first. Checking pieces[0] alone reported a split
     dovetail plate as watertight: that piece carries 8 tabs and no notches, so it
     never subtracts, while the three pieces holding the notches leaked 3000+ edges
     each. A case that does not build the geometry it names is worse than no case. */
  let L, pieces;
  try {
    L = G.computeLayout(wcfg);
    pieces = L.pieces.map((pc) => {
      const r = G.buildPiece(wcfg, L, pc);
      return r.polys || r;
    });
  } catch (e) {
    console.log(`${cs.name.padEnd(17)} BUILD FAILED: ${e.message}`);
    bad++; continue;
  }

  const mans = pieces.map((p) => G.checkManifold(p));
  const man = mans.reduce((a, b) => (b.bad > a.bad ? b : a));
  const leaking = mans.filter((m) => m.bad).length;
  /* Orientation, per piece. Watertightness cannot see which way a face points, and
     neither can the volume of the whole piece — a plate is dozens of deliberately
     overlapping shells and the sign of their sum survives one small shell being built
     backwards. orientation.js checks each shell on its own. Not quarantined anywhere
     here, including on the three cases that leak: abutting shells and shells sharing an
     edge are both correctly wound, and both come out clean. */
  const oris = pieces.map(checkOrientation);
  const oriBad = oris.filter((o) => !o.ok);
  const polys = pieces[0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of polys) for (const v of p.verts) {
    x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]);
    y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]);
    z0 = Math.min(z0, v[2]); z1 = Math.max(z1, v[2]);
  }
  /* A closed solid has a horizontal face at each end. Reporting this separately from
     the edge count says WHAT is missing rather than only how much. */
  const flatAt = (z) => polys.filter((p) => p.verts.every((v) => Math.abs(v[2] - z) < 1e-6)).length;
  const capBottom = flatAt(z0), capTop = flatAt(z1);
  const dims = `${(x1 - x0).toFixed(2)} x ${(y1 - y0).toFixed(2)} x ${(z1 - z0).toFixed(2)}`;
  const ok = man.bad === 0;

  const worse = cs.worst !== undefined && man.bad > cs.worst;
  const note = cs.quarantine
    ? (ok ? '  NOW PASSES — take it out of quarantine'
       : worse ? `  WORSE than the ${cs.worst} on file for: ${cs.quarantine}`
       : `  known: ${cs.quarantine}`)
    : '';
  const many = pieces.length > 1 ? ` [${leaking}/${pieces.length} pieces leak]` : '';
  /* An edge used once is a hole; an edge used four times is two shells touching. Both
     count as "bad" and they need completely different fixes, so say which. */
  const shape = ok ? '' : '  ' + boundaryShare(pieces);
  console.log(`${cs.name.padEnd(24)} ${(L.nx + 'x' + L.ny).padEnd(6)} ${String(polys.length).padStart(6)}  ` +
              `${dims.padEnd(22)} ${ok ? 'watertight' : man.bad + ' BAD EDGES' + many}` +
              `${capBottom ? '' : '  NO BOTTOM FACE'}${capTop ? '' : '  NO TOP FACE'}${shape}${note}`);
  if ((cs.quarantine ? ok : !ok) || worse) bad++;
  /* Orientation gets its own quarantine key. The two questions are independent — a case
     can be watertight and folded, or leak and be perfectly wound — so one flag covering
     both would excuse a defect nobody had looked at. */
  /* And it is held to the size on file, piece by piece, as `worst` holds a leak: folds on
     any piece past its `oriWorst`, on a piece with none on file, or a defect of any other
     kind fail it. Without that a quarantine for a few folds on two pieces waved through
     any number on all of them. */
  if (oriBad.length || cs.oriQuarantine) {
    const past = !cs.oriQuarantine ? []
      : !cs.oriWorst ? ['NO SIZE ON FILE']
      : oris.map((o, i) => [L.pieces[i].id, o])
          .filter(([id, o]) => o.folds > (cs.oriWorst[id] || 0) || o.inverted.length || o.wind)
          .map(([id, o]) => `${id}: ${orientationNote(o)}`);
    const oriNote = cs.oriQuarantine
      ? (!oriBad.length ? '  NOW CLEAN — take it out of quarantine'
         : past.length ? `  WORSE than on file (${past.join('; ')}) for: ${cs.oriQuarantine}`
         : `  known: ${cs.oriQuarantine}`)
      : '';
    console.log(`${''.padEnd(24)} ${oriBad.length}/${pieces.length} pieces: ` +
                `${oriBad.length ? orientationNote(oriBad[0]) : 'oriented'}${oriNote}`);
    if (cs.oriQuarantine ? !oriBad.length || past.length : true) bad++;
  }

  /* Watertight is not the same as built. A top-insert plate with the pocket never cut and
     the housing never added is watertight too, and every line above passes on it — which
     is the failure this project keeps repeating, so the two halves of the housing are
     asserted here against the same plate switched to bottom insert.
   *
   * Material out: the cutter runs past the plate top, so the top face has to LOSE area.
   * Shells in: the cup or the clip pocket are separate closed shells overlapping the
   * plate, so the piece has to GAIN connected components. Each catches the other half's
   * disappearance and neither catches its own, which is the point of having both.
   *
   * What it does not catch is a pocket of the wrong size or in the wrong place; the
   * opened area is printed so a change in one is at least legible, and the coupon at the
   * foot of this file is what a user actually presses a key into. */
  if (cs.opens) {
    /* Straight down the middle of the first key site on each piece: the highest
       horizontal surface over that point has to be the pocket floor and not the plate's
       top face. Reading it as a ray rather than as an area is what makes it work for both
       housings — the clip pocket's own walls come up flush with the plate top and give
       back very nearly the area its cavity took, so a top-face area only says the
       material moved, not that a key can get in. */
    const inTri = (t, px, py) => {
      const s = (a, b) => (b[0]-a[0])*(py-a[1]) - (b[1]-a[1])*(px-a[0]);
      const d1 = s(t[0], t[1]), d2 = s(t[1], t[2]), d3 = s(t[2], t[0]);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    const roofAt = (ps, px, py) => {
      let z = -Infinity;
      for (const t of G.polysToTriangles(ps)) {
        if (Math.abs(t[0][2] - t[1][2]) > 1e-6 || Math.abs(t[0][2] - t[2][2]) > 1e-6) continue;
        if (t[0][2] > z && inTri(t, px, py)) z = t[0][2];
      }
      return z;
    };
    const D = 1.0;   // just inside the seam, well within the narrowest waist of any key
    const probe = (b) => b.edge === '+x' ? [b.e - D, b.s] : b.edge === '-x' ? [b.e + D, b.s]
                       : b.edge === '+y' ? [b.s, b.e - D] : [b.s, b.e + D];
    const refCfg = Object.assign({}, cfg, { keyInsert: 'bottom' });
    const refL = G.computeLayout(refCfg);
    const ref = refL.pieces.map((pc) => G.buildPiece(refCfg, refL, pc).polys);
    let probed = 0, opened = 0, solid = 0, drop = 0;
    L.pieces.forEach((pc, i) => {
      // the wall-junction filter buildPiece applies: a key needs a cell junction to sit on
      const site = G.pieceConnectors(wcfg, L, pc).keyed
        .find((b) => Math.abs(b.s / cfg.pitch - Math.round(b.s / cfg.pitch)) <= 0.25);
      if (!site) return;
      probed++;
      const [px, py] = probe(site);
      const zH = roofAt(pieces[i], px, py), zR = roofAt(ref[i], px, py);
      if (zH < z1 - 0.5) { opened++; drop = Math.max(drop, z1 - zH); }
      if (Math.abs(zR - z1) < 1e-6) solid++;   // the same point is roofed without the housing
    });
    const gained = pieces.reduce((s, p) => s + checkOrientation(p).shells, 0) -
                   ref.reduce((s, p) => s + checkOrientation(p).shells, 0);
    const good = probed > 0 && opened === probed && solid === probed && gained > 0;
    console.log(`${''.padEnd(24)} housing: open to the top on ${opened}/${probed} pieces ` +
                `(${drop.toFixed(2)} mm down to the pocket floor), ${gained} shells added` +
                `${good ? '' : '   HOUSING NOT BUILT'}`);
    if (!good) bad++;
  }

  if (cfg.marginMode === 'half') {
    const got = [L.hX, L.hY];
    const want = cs.strips || [0, 0];
    const sockets = halfSocketsCut(cfg, L, pieces);
    const same = got[0] === want[0] && got[1] === want[1];
    const good = same && sockets.cut === sockets.of && sockets.of > 0;
    console.log(`${''.padEnd(24)} half cells: column ${got[0]}, row ${got[1]}` +
                `${same ? '' : `, NOT THE ${want[0]} AND ${want[1]} THE CASE NAMES`}; ` +
                `${sockets.cut} of ${sockets.of} half sockets cut at their own size` +
                `${sockets.fail.length ? '   NOT CUT: ' + sockets.fail.slice(0, 3).join('; ') : ''}`);
    if (!good) bad++;
    /* No magnet or screw holes in a half cell, and the whole cells keep theirs: a hole
       is surfaces inside a cell away from its socket wall, so an engine that put them
       back, or left them off the whole cells, is caught here and nowhere else. */
    if (cfg.magnets || cfg.screws) {
      const h = holeSurfaces(cfg, L, pieces);
      const ok = h.half === 0 && h.wholeWith === h.whole && h.whole > 0;
      console.log(`${''.padEnd(24)} holes: ${h.wholeWith} of ${h.whole} whole cells, ` +
                  `${h.half} surfaces inside ${h.halves} half cells${ok ? '' : '   HOLES WRONG'}`);
      if (!ok) bad++;
    }
    /* A known leak with half cells has to be the same leak as without them: the same
       drawer as solid margin, compared edge-use count for edge-use count. */
    if (cs.quarantine) {
      const autoCfg = Object.assign({}, cfg, { marginMode: 'auto' });
      const autoL = G.computeLayout(autoCfg);
      const autoPieces = autoL.pieces.map((pc) => G.buildPiece(autoCfg, autoL, pc).polys);
      const mine = boundaryShare(pieces), theirs = boundaryShare(autoPieces);
      console.log(`${''.padEnd(24)} as solid margin: ${theirs}` +
                  `${mine === theirs ? ' — the same, so the half cells add none' : '   HALF CELLS ADD TO IT'}`);
      if (mine !== theirs) bad++;
    }
  }
}

/* Every half socket on a half-cell plate, probed straight down: open at its centre and
 * just inside its top edge on each axis, and roofed at the plate top just outside it, on
 * the rim the cell keeps round its socket. The first says a socket was cut and the
 * second that it was cut at the half cell's size — a whole socket centred on a half cell
 * would open the rim, and run on through the wall into its neighbour. A strip of half
 * cells built as margin instead is solid all the way across, and watertight, and nothing
 * else in this file would notice it.
 *
 * Probing reads horizontal faces only, so the socket's sloped walls do not count as a
 * roof, and the socket floor of a padded plate is "open" here: it is a pad's height off
 * the bed, far below the plate top. */
function halfSocketsCut(cfg, L, pieces) {
  const inTri = (t, px, py) => {
    const s = (a, b) => (b[0]-a[0])*(py-a[1]) - (b[1]-a[1])*(px-a[0]);
    const d1 = s(t[0], t[1]), d2 = s(t[1], t[2]), d3 = s(t[2], t[0]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const roofAt = (tris, px, py) => {
    let z = -Infinity;
    for (const t of tris) {
      if (Math.abs(t[0][2] - t[1][2]) > 1e-6 || Math.abs(t[0][2] - t[2][2]) > 1e-6) continue;
      if (t[0][2] > z && inTri(t, px, py)) z = t[0][2];
    }
    return z;
  };
  const pitch = cfg.pitch, half = pitch / 2, H = G.platePad(cfg) + cfg.plateHeight;
  const IN = 0.15;   // in from the socket's top edge, and in from the cell's
  let of = 0, cut = 0;
  const fail = [];
  L.pieces.forEach((pc, i) => {
    const cells = [];   // [centre x, centre y, half size x, half size y], piece-local
    const x0 = pc.mL + pc.nx * pitch, y0 = pc.mF + pc.ny * pitch;
    if (pc.hR) for (let j = 0; j < pc.ny; j++) cells.push([x0 + half / 2, pc.mF + j * pitch + half, half / 2, half]);
    if (pc.hB) for (let k = 0; k < pc.nx; k++) cells.push([pc.mL + k * pitch + half, y0 + half / 2, half, half / 2]);
    if (pc.hR && pc.hB) cells.push([x0 + half / 2, y0 + half / 2, half / 2, half / 2]);
    if (!cells.length) return;
    const tris = G.polysToTriangles(pieces[i]);
    for (const [cx, cy, hx, hy] of cells) {
      of++;
      const inner = [[cx, cy], [cx - hx + cfg.topCutoff + IN, cy], [cx + hx - cfg.topCutoff - IN, cy],
                     [cx, cy - hy + cfg.topCutoff + IN], [cx, cy + hy - cfg.topCutoff - IN]];
      const rim = [[cx - hx + IN, cy], [cx + hx - IN, cy], [cx, cy - hy + IN], [cx, cy + hy - IN]];
      const open = inner.every(([x, y]) => roofAt(tris, x, y) < H - 1);
      const roofed = rim.every(([x, y]) => Math.abs(roofAt(tris, x, y) - H) < 1e-6);
      if (open && roofed) cut++;
      else fail.push(`${pc.id} at ${cx.toFixed(1)}, ${cy.toFixed(1)}: ` +
                     `${open ? '' : 'not open'}${open || roofed ? '' : ', '}${roofed ? '' : 'rim open'}`);
    }
  });
  return { of, cut, fail };
}

/* Surfaces inside each cell of a half-cell plate away from its socket wall, at a few
 * heights through the pad and the socket. Whole cells with holes have some; a half or
 * quarter cell must have none. The socket wall itself is left out by its profile's
 * inset at each height (2.85 mm at the bottom of the socket, 2.15 through its middle,
 * narrowing to the cutoff at the top). After the reviewer's probe for #45. */
function holeSurfaces(cfg, L, pieces) {
  const slice = (tris, z) => {
    const segs = [];
    for (const t of tris) {
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3], da = a[2] - z, db = b[2] - z;
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const u = da / (da - db);
          pts.push([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]);
        }
      }
      if (pts.length === 2) segs.push(pts);
    }
    return segs;
  };
  const P = cfg.pitch, pad = G.platePad(cfg);
  const dAt = (z) => { const zz = z - pad; if (zz < 0) return null; if (zz <= 0.7) return 2.85 - zz;
                       if (zz <= 2.5) return 2.15; return 2.15 - (zz - 2.5); };
  const zs = [0.5, 1.0, 1.5, 2.0, 2.4, pad + 0.3, pad + 1.2, pad + 2.0];
  const out = { whole: 0, wholeWith: 0, halves: 0, half: 0 };
  L.pieces.forEach((pc, i) => {
    const sl = zs.map((z) => [z, slice(G.polysToTriangles(pieces[i]), z)]);
    for (let a = 0; a < pc.nx + (pc.hR ? 1 : 0); a++) for (let b = 0; b < pc.ny + (pc.hB ? 1 : 0); b++) {
      const hx = a === pc.nx ? P / 4 : P / 2, hy = b === pc.ny ? P / 4 : P / 2;
      const cx = pc.mL + a * P + hx, cy = pc.mF + b * P + hy;
      let c = 0;
      for (const [z, segs] of sl) {
        const d = dAt(z);
        for (const [p, q] of segs) {
          const mx = (p[0] + q[0]) / 2 - cx, my = (p[1] + q[1]) / 2 - cy;
          if (Math.abs(mx) > hx - 0.3 || Math.abs(my) > hy - 0.3) continue;
          if (d !== null && Math.abs(mx) < hx - d + 0.2 && Math.abs(my) < hy - d + 0.2) continue;
          c++;
        }
      }
      if (a === pc.nx || b === pc.ny) { out.halves++; out.half += c; }
      else { out.whole++; if (c > 0) out.wholeWith++; }
    }
  });
  return out;
}

/* How many of the bad edges are actually open boundary, and how many are shells meeting
   face to face. Reported as a histogram of edge use, because "120 bad edges, all of them
   used 4 times" and "120 bad edges, 30 of them used once" are different bugs. */
function boundaryShare(pieces) {
  const hist = new Map();
  for (const polys of pieces) {
    const key = (v) => v.map((x) => Math.round(x * 1000) / 1000).join(',');
    const edges = new Map();
    for (const t of G.polysToTriangles(polys))
      for (let i = 0; i < 3; i++) {
        const a = key(t[i]), b = key(t[(i + 1) % 3]);
        const k = a < b ? a + '|' + b : b + '|' + a;
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    for (const c of edges.values()) if (c !== 2) hist.set(c, (hist.get(c) || 0) + 1);
  }
  const open = [...hist.entries()].filter(([c]) => c % 2 === 1).reduce((s, [, n]) => s + n, 0);
  return `[${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${n}x used ${c}`).join(', ')}` +
         `${open ? ' — OPEN BOUNDARY' : ' — shells touching, no hole'}]`;
}

/* Enclosed volume by the divergence theorem. Every triangle contributes its tetrahedron
   with the origin, so a mesh with a hole in it, a doubled face or an inside-out triangle
   all get the wrong answer — and unlike the edge count, this is a number healCsgSeams
   cannot reach. It repairs connectivity, so "watertight" is a metric it optimises
   directly; volume is the independent one, and it is what caught the screw counterbore
   never being cut at all. */
function volume(polys) {
  let v = 0;
  for (const t of G.polysToTriangles(polys)) {
    const [a, b, c] = t;
    v += (a[0]*(b[1]*c[2] - c[1]*b[2]) - a[1]*(b[0]*c[2] - c[0]*b[2]) + a[2]*(b[0]*c[1] - c[0]*b[1])) / 6;
  }
  return v;
}

/* The CSG at its smallest, in the four shapes a cut can take. A closed box minus a
   closed prism must be a closed solid of exactly the arithmetic volume. All four used to
   come back with boundary edges, which is where healCsgSeams was written from; keep them,
   so the next person to touch the BSP finds out here rather than on a 30k-polygon plate.
   The expected volumes are 20x20x5 = 2000 minus the cut: 4x4x5, 4x4x3, 6x4x5 clipped to
   the box, 6x6x5 clipped to the box. */
console.log('\nthe CSG itself, minimum cases:');
{
  const box = () => G.extrudePoly([[0, 0], [20, 0], [20, 20], [0, 20]], 0, 5);
  const CUTS = [
    ['through the middle, out both faces', [[8, 8], [12, 8], [12, 12], [8, 12]], -1, 6, 1920],
    ['blind pocket from the top', [[8, 8], [12, 8], [12, 12], [8, 12]], 2, 6, 1952],
    ['notch from an edge', [[-1, 8], [6, 8], [6, 12], [-1, 12]], -1, 6, 1880],
    ['bite from a corner', [[-1, -1], [6, -1], [6, 6], [-1, 6]], -1, 6, 1820],
  ];
  for (const [label, pts, z0, z1, want] of CUTS) {
    const cut = G.extrudePoly(pts, z0, z1);
    const before = G.checkManifold(cut);
    const res = G.csgSubtract(box(), cut);
    const m = G.checkManifold(res);
    const v = volume(res);
    const vOk = Math.abs(v - want) < 1e-6;
    console.log(`  ${label.padEnd(36)} cutter ${before.bad ? 'BAD' : 'ok'}   ` +
                `result ${(m.bad ? m.bad + ' bad of ' + m.edges : 'watertight').padEnd(11)}` +
                `  volume ${v.toFixed(6)} of ${want}${vOk ? '' : '  WRONG'}`);
    if (before.bad || m.bad || !vOk) bad++;
  }
}

/* csgUnion had no test at all, and fastenerCutter now depends on it for every magnet and
   screw pocket. These are the two unions it actually performs. Both were broken before
   the repair pass existed — 74 and 71 bad edges — which nothing would have told us. */
console.log('\ncsgUnion, the cases fastenerCutter relies on:');
{
  const cyl = (r, z0, z1, seg) => G.extrudePoly(
    Array.from({ length: seg }, (_, i) => {
      const a = 2 * Math.PI * i / seg;
      return [r * Math.cos(a), r * Math.sin(a)];
    }), z0, z1);
  const area = (r, n) => 0.5 * n * r * r * Math.sin(2 * Math.PI / n);
  const CASES2 = [
    ['counterbore over shank', cyl(3, -0.5, 2, 14), cyl(1.5, -0.5, 7.55, 12),
     area(3, 14) * 2.5 + area(1.5, 12) * 5.55],
    ['magnet pocket over counterbore', cyl(3.1, -0.5, 2, 14), cyl(3, -0.5, 2, 14),
     area(3.1, 14) * 2.5],
  ];
  for (const [label, a, b, want] of CASES2) {
    const u = G.csgUnion(a, b);
    const m = G.checkManifold(u);
    const v = volume(u);
    const vOk = Math.abs(v - want) < 1e-6;
    console.log(`  ${label.padEnd(36)} ${(m.bad ? m.bad + ' bad of ' + m.edges : 'watertight').padEnd(11)}` +
                `  volume ${v.toFixed(6)} of ${want.toFixed(6)}${vOk ? '' : '  WRONG'}`);
    if (m.bad || !vOk) bad++;
  }
}

/* The rim cap has to be a VALID tiling, not merely a closed one.
 *
 * Watertightness cannot see a triangle that is inside out, and for most of this
 * project's life 21% of every cell rim was at the shipped smoothness, rising to 33% at
 * arcSegs 24. The cap pairs a 4-corner outline against a 4*arcSegs socket ring by
 * sweeping angle, and a fan from one outline corner turns over once it passes that
 * corner's tangent to the ring.
 *
 * Two independent things are asserted, and it is worth being precise about what each one
 * can and cannot catch, because the first draft of this check got it wrong:
 *
 *   - No triangle has negative area. This is the one that catches the inversion.
 *   - The strip emits exactly outline + ring triangles, which catches a dropped or
 *     duplicated one.
 *
 * There was a third — the signed areas summing to outline minus ring — presented as
 * complementary. It is not: for ANY complete pairing of the two loops the interior
 * spokes cancel and the sum telescopes to that value by Green's theorem, whatever the
 * orientations. It passed at 1e-13 on the fully broken version, for every smoothness. A
 * check that cannot fail on the bug its own comment describes is worse than no check,
 * so it is gone rather than kept as decoration.
 *
 * A fourth is added here, and it is the general form of the first: the whole cell region
 * through orientation.js. That matters because the 2D-area test only works on a face
 * known in advance to be flat and horizontal, and it exists only because somebody already
 * knew where to look. The generic check has to find it without being told, and only one
 * of its three tests does. Reverting the fix in annulusStrip and measuring:
 *
 *   per-shell signed volume   1340.010167086673 at arcSegs 6 — identical to fifteen
 *                             digits with the fix in place. Blind, and necessarily so:
 *                             the cap is planar and Green's theorem telescopes it, which
 *                             is the same reason the deleted assertion could not fail.
 *   directed-edge balance     zero imbalance. Also blind: the strip is a combinatorially
 *                             valid triangulation whichever way its triangles land, so
 *                             every spoke is still traversed once each way.
 *   coplanar folds            12 at arcSegs 6, 12 at 24. This is the one that bites.
 *
 * So the fold count is asserted alongside the area sign rather than instead of it. If
 * they ever disagree, the area test is the one that knows what it is looking at. */
console.log('\nrim cap tiling, at each smoothness:');
for (const n of [6, 8, 12, 24]) {
  const H = 4.25;
  const prof = { pitchHalf: 21, rTop: 4.0, zs: [-1, 0, 0.7, 2.5, H, H + 1.5],
                 ds: [2.85, 2.85, 2.15, 2.15, 0.4, 0.4] };
  const cell = [[-0.05, -0.05], [42.05, -0.05], [42.05, 42.05], [-0.05, 42.05]];
  const polys = G.directCellRegion(cell, prof, 21, 21, H, 0, n);
  const top = polys.filter((p) => p.verts.every((v) => Math.abs(v[2] - H) < 1e-9));
  let flipped = 0;
  for (const p of top) if (G.polyArea2D(p.verts.map((v) => [v[0], v[1]])) < -1e-12) flipped++;
  const wantTris = cell.length + 4 * n;
  const ori = checkOrientation(polys);
  const ok = flipped === 0 && top.length === wantTris && ori.ok;
  console.log(`  arcSegs ${String(n).padStart(2)}   ${String(top.length).padStart(3)} of ${wantTris} tris   ` +
              (flipped ? `${flipped} INSIDE OUT (${(100 * flipped / top.length).toFixed(0)}%)` : 'all outward') +
              `   region ${orientationNote(ori)}`);
  if (!ok) bad++;
}

/* Caps used to leak 8*arcSegs + 8 per cell. Asserting zero at every smoothness stops a
   future change reintroducing a partial cap that only shows up at fine arcs. */
console.log('\nboundary edges per cell, at each smoothness:');
for (const n of [6, 8, 12, 24]) {
  const cfg = Object.assign({}, G.DEFAULTS, {
    drawerW: 42, drawerD: 42, marginMode: 'custom',
    mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: n,
  });
  const L = G.computeLayout(cfg);
  const r = G.buildPiece(cfg, L, L.pieces[0]);
  const man = G.checkManifold(r.polys || r);
  console.log(`  arcSegs ${String(n).padStart(2)}   ${man.bad ? String(man.bad).padStart(4) + ' BAD EDGES' : 'watertight'}`);
  if (man.bad) bad++;
}

/* The puzzle joint, measured off the BUILT MESH.
 *
 * Watertightness was bought by changing the notch outline, and a change to a cutter's
 * outline is one edit away from a change to the fit. Nothing above would notice: a
 * jigsaw joint 0.3 mm slacker in the throat is exactly as watertight and prints exactly
 * as well, right up to the point where the pieces will not hold together.
 *
 * So the numbers come out of the finished triangle soup rather than out of puzzleShape,
 * and they are read off two surfaces that cannot be confused with anything else near
 * them: the notch cavity is the only thing with a downward-facing horizontal face at the
 * cut height, and the male tab the only thing with an upward-facing one at the tab
 * height. Everything else at that height is a side wall, a socket or a cell floor.
 *
 * What is asserted is the FIT — throat, reach and lobe of the cavity against the same
 * three on the tab — because that is the thing a user feels. The absolute sizes are
 * asserted too, against the parameters rather than against remembered numbers, so this
 * still means something if cfg.puzzle is ever retuned. */
console.log('\nthe puzzle joint, off the built mesh:');
{
  const cfg = Object.assign({}, G.DEFAULTS, {
    drawerW: 400, drawerD: 400, marginMode: 'custom',
    mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: 12, connector: 'puzzle',
  });
  const L = G.computeLayout(cfg);
  const built = {};
  for (const pc of L.pieces) built[pc.id] = G.buildPiece(cfg, L, pc);

  // every vertex of every horizontal triangle at height z facing the given way
  const faceAt = (polys, z, up) => {
    const out = [];
    for (const t of G.polysToTriangles(polys)) {
      if (!t.every((v) => Math.abs(v[2] - z) < 1e-6)) continue;
      const nz = (t[1][0]-t[0][0])*(t[2][1]-t[0][1]) - (t[1][1]-t[0][1])*(t[2][0]-t[0][0]);
      if (Math.abs(nz) > 1e-12 && (nz > 0) === up) out.push(...t.map((v) => [v[0], v[1]]));
    }
    return out;
  };
  /* Reduced to (depth into the piece, offset along the seam) about one joint site, and
     windowed to that site so a neighbouring one 42 mm away cannot contribute. */
  const shape = (pts, dep, lat) => {
    const P = pts.map((q) => [dep(q), lat(q)])
                 .filter((p) => p[0] > -1 && p[0] < 14 && Math.abs(p[1]) < 8);
    if (P.length < 3) return null;
    const reach = Math.max(...P.map((p) => p[0]));
    const lobe = Math.max(...P.map((p) => Math.abs(p[1])));
    // the straight neck runs from behind the seam to the lobe junction, ~0.55 deep
    const throat = 2 * Math.max(...P.filter((p) => p[0] < 0.5).map((p) => Math.abs(p[1])));
    return { throat, reach, lobe };
  };

  const pz = cfg.puzzle;
  const zCut = Math.max(cfg.bottomPad, 2.6) - 0.4;         // notch ceiling
  const zTab = Math.max(1.2, Math.max(cfg.bottomPad, 2.6) - 0.65);
  const notch = shape(faceAt(built.A2.polys, zCut, false), (q) => q[1], (q) => q[0] - 42);
  const tab = shape(faceAt(built.A1.polys, zTab, true),
                    (q) => q[1] - built.A1.D, (q) => q[0] - 42);
  if (!notch || !tab) {
    console.log('  NO JOINT SURFACE FOUND — the measurement, not the joint, is broken');
    bad++;
  } else {
    /* The tab's flank and far pole are both sampled points on its outline, so these are
       exact; the widest point of the lobe need not be sampled, so that one is compared
       within the sagitta of a 19-point arc on r ≈ 4.6, which is 0.02 mm. */
    const want = [
      ['throat  (neckW + 2 grow)', notch.throat, pz.neckW + 2*pz.clr, tab.throat, pz.neckW, 2*pz.clr, 1e-9],
      ['reach   (neck + lobe)   ', notch.reach, pz.neckL + pz.lobeR*1.55 + pz.clr,
                                   tab.reach, pz.neckL + pz.lobeR*1.55, pz.clr, 1e-9],
      ['lobe    (radius)        ', notch.lobe, pz.lobeR + pz.clr, tab.lobe, pz.lobeR, pz.clr, 0.021],
    ];
    for (const [label, nv, nWant, tv, tWant, gap, tol] of want) {
      const ok = Math.abs(nv - nWant) <= tol && Math.abs(tv - tWant) <= tol &&
                 Math.abs((nv - tv) - gap) <= 2 * tol;
      console.log(`  ${label}  notch ${nv.toFixed(4)} of ${nWant.toFixed(4)}` +
                  `   tab ${tv.toFixed(4)} of ${tWant.toFixed(4)}` +
                  `   clearance ${(nv - tv).toFixed(4)} of ${gap.toFixed(4)}` +
                  `${ok ? '' : '   FIT CHANGED'}`);
      if (!ok) bad++;
    }
  }
}

/* The orientation check itself, on meshes broken on purpose.
 *
 * Two of its three tests have a real defect in this repository to bite on — a shell built
 * backwards (snapTopClip, below) and a fold (annulusStrip, above). The third, directed-edge
 * balance, has none: nothing here has ever had a patch wound against its neighbours. An
 * unexercised assertion is how this project shipped three tests that measured nothing, so
 * it is exercised here instead of taken on trust.
 *
 * The table asserts the MISSES as firmly as the hits, because "implement both and say what
 * each buys" is only worth anything if the buying is written down somewhere it can fail.
 * A wholly reversed shell leaves every edge balanced, so the winding count reads zero on
 * it; a single reversed face barely moves the enclosed volume, so the volume test reads
 * clean on that. Neither substitutes for the other, and this is where that stops being a
 * claim in a comment.
 *
 * An octahedron rather than a box: every pair of adjacent faces meets at an angle, so the
 * fold count stays out of the first two rows and the three tests can be told apart. */
console.log('\nthe orientation check itself, on meshes broken on purpose:');
{
  const V = [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]];
  const F = [[0,2,4], [2,1,4], [1,3,4], [3,0,4], [2,0,5], [1,2,5], [3,1,5], [0,3,5]];
  const octa = () => F.map((f) => G.makePoly(f.map((i) => V[i].slice())));

  const allReversed = octa().map((p) => G.makePoly(p.verts.slice().reverse()));
  const oneReversed = octa();
  oneReversed[0] = G.makePoly(oneReversed[0].verts.slice().reverse());
  /* Split one face into three about its centroid and reverse one of the three. The
     reversed piece is coplanar with its two siblings, so this is a fold as well as a
     winding break — that is what a fold IS, and the row asserts both. */
  const folded = octa();
  {
    const t = folded.shift().verts;
    const m = [0, 1, 2].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
    folded.push(G.makePoly([m, t[1], t[0]]));          // reversed
    folded.push(G.makePoly([t[1], t[2], m]));
    folded.push(G.makePoly([t[2], t[0], m]));
  }
  const PROBES = [
    ['intact',                 octa(),        0, 0, 0],
    ['every face reversed',    allReversed,   1, 0, 0],
    ['one face reversed',      oneReversed,   0, 3, 0],
    ['one coplanar face folded back', folded, 0, 3, 2],
  ];
  for (const [label, polys, wInv, wWind, wFold] of PROBES) {
    const r = checkOrientation(polys);
    const got = [r.inverted.length, r.wind, r.folds];
    const ok = got[0] === wInv && got[1] === wWind && got[2] === wFold;
    console.log(`  ${label.padEnd(32)} volume ${r.volume.toFixed(4).padStart(8)}   ` +
                `inverted ${got[0]}  wound-twice ${got[1]}  folds ${got[2]}   ` +
                `${ok ? 'as expected' : `EXPECTED ${wInv}/${wWind}/${wFold}`}`);
    if (!ok) bad++;
  }
}

/* Everything else a user can download, checked for orientation.
 *
 * The plate cases above are the big meshes and they were never the problem. The loose
 * parts were: snapTopClip — the U-clip you print and press into a joint — was inside out
 * from the day it was written, -8.84 mm³ of enclosed volume, watertight, zero bad edges,
 * and nothing in this project looked at a loose part at all. It came out of profilePrism,
 * which emits a CCW (u, z) profile in whatever frame mapUV lays down and had no idea the
 * frame could be left-handed; the bins' scoop and label pass its mirror and were fine,
 * which is why nobody noticed.
 *
 * So the rule this section encodes is coverage, not cleverness: every shape the export
 * buttons can produce gets built here, including the combinations of connector, insertion
 * direction and key housing that change WHICH part is produced. The key branch mirrors
 * connectorPart() in src/ui.js — that function is the only answer to "which part", and if
 * it is ever changed to produce something else, this list has to follow it. */
console.log('\nloose parts and samples, watertight and oriented:');
{
  const report = (label, polys, quarantine) => {
    const r = checkOrientation(polys);
    const m = G.checkManifold(polys);
    const ok = r.ok && m.bad === 0;
    const note = quarantine
      ? (ok ? '  NOW CLEAN — take it out of quarantine' : `  known: ${quarantine}`)
      : '';
    /* Watertightness is asserted here now, not only orientation. It was left out because
       the one part where it mattered — the top-insert snap sample, whose rim is cut open
       at each junction — could not meet the bar, and leaving it out cost the test tile:
       a shipped download with 47 boundary edges that this section printed as `oriented`
       and passed, because an inside-out triangle is not what was wrong with it. Every
       part here is closed now, so the bar can be the same bar the plates answer to. */
    const open = r.open ? `, ${r.open} open` : '';
    console.log(`  ${label.padEnd(26)} ${String(r.tris).padStart(6)} tris  ` +
                `${String(r.shells).padStart(3)} shells${open.padEnd(9)}  ` +
                `${r.volume.toFixed(3).padStart(11)} mm3  ` +
                `${m.bad ? m.bad + ' BAD EDGES, ' : ''}${orientationNote(r)}${note}`);
    if (quarantine ? ok : !ok) bad++;
  };
  const H = 4.25;
  const CONNECTORS = ['dovetail', 'puzzle', 'bowtie', 'puzzlekey', 'snap', 'hclip', 'none'];
  const KEYED = ['bowtie', 'puzzlekey', 'snap', 'hclip'];

  for (const conn of CONNECTORS)
    for (const keyInsert of ['bottom', 'top'])
      for (const keyMount of ['floor', 'wall']) {
        if (!KEYED.includes(conn)) continue;          // no loose part to print
        const cfg = Object.assign({}, G.DEFAULTS, { connector: conn, keyInsert, keyMount });
        const label = `key ${conn}/${keyInsert}/${keyMount}`;
        /* A top-inserted snap takes the sprung U-clip, not a flat key. They are not
           variants of one shape, so both routes have to be built. */
        if (conn === 'snap' && keyInsert === 'top') {
          const prm = Object.assign({ legT: 1.0, legLen: 1.35, legC: 1.4, barb: 0.18,
                                      bridgeW: 1.7, bridgeD: 0.85, wall: 0.6 }, { clr: cfg.key.clr });
          report(label, G.snapTopClip(prm, H));
          continue;
        }
        const kd = conn === 'hclip' ? Object.assign(G.hclipPrm(cfg.hclip), { depth: 2.3 })
          : keyMount === 'wall' ? Object.assign({}, G.DEFAULTS.keySlim) : Object.assign({}, cfg.key);
        if (keyInsert === 'top' && (conn === 'hclip' || keyMount === 'wall')) kd.depth = 2.0;
        report(label, G.buildKey(conn === 'hclip' ? 'snap' : conn, kd, kd.depth - 0.15));
      }

  /* The pocket the U-clip drops into, on all four seam edges. It is here rather than in
     a plate case because no plate case above selects keyInsert 'top' — those
     configurations leak, for reasons that have nothing to do with orientation, and adding
     them would import that argument into this one. Building the pocket directly covers
     the fix without it.
     Its barb lip was inside out on exactly two of the four edges: the (depth, along)
     frame `map` puts down is right-handed on -x and +y and mirrored on the other two, and
     the wedge's winding was written out by hand for one of them. One 8-triangle shell of
     -0.072 mm³ per site, on half the sites of every top-snap plate. */
  const sp = { legT: 1.0, legLen: 1.35, legC: 1.4, barb: 0.18,
               bridgeW: 1.7, bridgeD: 0.85, wall: 0.6, clr: 0.15 };
  for (const edge of ['+x', '-x', '+y', '-y'])
    report(`snap pocket ${edge}`, G.snapTopPocket(edge, 42, 21, sp, H));

  const tileCfg = Object.assign({}, G.DEFAULTS, {
    drawerW: G.DEFAULTS.pitch, drawerD: G.DEFAULTS.pitch,
    marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0 });
  report('test tile', G.buildTestTile(tileCfg).polys);
  /* The tile with magnets and screws, the page's own sizes. Once a screw's bores stood
     their flats on the sizes, the 6 mm counterbore's walls stood 0.022 mm inside the 6 mm
     magnet pocket's from beneath, and the tile left 6 edges open in its underside; a
     counterbore the magnet pocket holds whole is not cut now (fastenerCutter). A magnet
     from above is cut from the other face, and that tile is built too. A counterbore
     deeper than the 2 mm magnet left the same 6 at every depth from 2.25 to 4: it is cut
     at the pocket's corners now, one prism with it (MOUNT_BORE.head.cut). */
  for (const side of ['bottom', 'top'])
    report(`tile, magnets ${side === 'top' ? 'above' : 'below'}, screws`,
      G.buildTestTile({ ...tileCfg, magnets: true, magnetSide: side, screws: true }).polys);
  for (const depth of [2.5, 3])
    report(`tile, below, ${depth} deep`,
      G.buildTestTile({ ...tileCfg, magnets: true, screws: true, screwHeadDepth: depth }).polys);

  for (const conn of CONNECTORS)
    for (const keyInsert of ['bottom', 'top']) {
      const cfg = Object.assign({}, G.DEFAULTS, { connector: conn, keyInsert });
      /* The puzzle strip used to carry six coplanar slivers on the underside of two of its
         four tiles, 5.2e-5 to 5.5e-4 mm² each, and was quarantined for them. They are gone,
         and the honest account of why is that the coupon's tiles went from 8 mm deep to 10
         (see buildFitSample) and the cutter's planes now graze the tile's corner arc
         somewhere else. Nothing in csgSubtract changed. This is the sliver-spur class, it
         is sensitive to geometry at the micron level — the same six were reproducible at
         clearance 0.25 and absent at 0.20 and 0.30 — and if it reappears, that is what it
         is rather than a new bug. */
      /* buildFitSample takes the joint rather than re-deriving it, since deriving it
         twice is what made the coupon present the wrong housing in the first place.
         The UI is the authority (activeJoint in src/ui.js); this is a fixture standing
         in for it, deliberately explicit so it reads as a test input and not as a
         second opinion. It covers the subset this loop varies: connector and insertion,
         at the default clearances. */
      const keyed = ['bowtie', 'puzzlekey', 'snap', 'hclip'].includes(conn);
      /* Mirrors activeKeyDims() in src/ui.js, which is the authority. It used to hand
         cfg.key to everything, so the H-clip coupon presented a 14 mm key's housing where
         the tool builds a 3.6 mm one — a fixture that was not standing in for anything. */
      const prm = conn === 'hclip' ? G.hclipPrm(cfg.hclip)
        : cfg.keyMount === 'wall' ? Object.assign({}, G.DEFAULTS.keySlim)
        : Object.assign({}, cfg.key);
      if (keyInsert === 'top' && (conn === 'hclip' || cfg.keyMount === 'wall')) prm.depth = 2.0;
      const joint = keyed
        ? { kind: G.jointKind(conn, cfg.keyMount, keyInsert),
            shape: conn === 'hclip' ? 'snap' : conn, prm,
            /* The pad is what a top-insert cup sits in. With zero the cup has nowhere
               to go and the coupon comes back as two dozen open shells -- a fixture
               fault, not a geometry one. buildPiece forces this same figure. */
            pad: prm.depth + 0.8, clr: prm.clr,
            part: G.buildKey(conn === 'hclip' ? 'snap' : conn, prm, prm.depth - 0.15) }
        : { kind: conn, pad: 0,
            clr: conn === 'puzzle' ? cfg.puzzle.clr : cfg.tab.clr };
      /* hclip/top was quarantined here as `clipConvexPrismTop leaves the cup open`, and
         it is out: the clip is gone, the housing is a subtraction with a closed cutter
         and the cup is two closed extrusions instead of a stitched surface. The same
         change is what closed every top-insert plate above. */
      report(`fit sample ${conn}/${keyInsert}`, G.buildFitSample(cfg, H, joint).polys);
    }
}

/* The corner radii, on the plate's corners and on no others.
 *
 * cfg.outerRadius and cfg.cornerRadii reached nothing at all until now — buildPiece asked
 * `piece.col` and `layout.cols` against a layout that has only ever produced `band` and
 * `seg`, so every flag was `undefined === 0` and every exported plate had square corners
 * while the page offered a radius per corner and a hint about matching your drawer. That
 * is not a defect any of the checks above can see: a square plate is exactly as watertight
 * as a rounded one, and the DEFAULTS sweep at the foot of this file cannot see it either,
 * because the field is read and then discarded.
 *
 * So the shape is asserted, on a split plate where three of each piece's four corners must
 * stay square or the pieces will not butt together. A square corner has a vertex sitting on
 * it; a rounded one has none, and has the two arc ends instead, which is what pins the
 * radius to the number asked for rather than merely to something. */
console.log('\nrounded outer corners, on the plate and nowhere else:');
{
  const radii = { ll: 2, lr: 0, ur: 6, ul: 4 };
  const cfg = Object.assign({}, G.DEFAULTS, {
    drawerW: 168, drawerD: 168, marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: 12, connector: 'none',
    splitMode: 'manual', rowCuts: [2], colCuts: [[2], [2]], cornerRadii: radii });
  const L = G.computeLayout(cfg);
  // the cap the socket forces on a corner arc; 6 is asked for above and must come back capped
  const rMax = ((cfg.topCutoff + cfg.socketRadius) * Math.SQRT2 - cfg.socketRadius - 0.2)
               / (Math.SQRT2 - 1);
  for (const pc of L.pieces) {
    const r = G.buildPiece(cfg, L, pc);
    const at = (x, y) => r.polys.some((p) => p.verts.some(
      (v) => Math.abs(v[0] - x) < 1e-6 && Math.abs(v[1] - y) < 1e-6));
    const owns = { ll: pc.cellX0 === 0 && pc.cellY0 === 0,
                   lr: pc.cellX0 + pc.nx === L.nx && pc.cellY0 === 0,
                   ur: pc.cellX0 + pc.nx === L.nx && pc.cellY0 + pc.ny === L.ny,
                   ul: pc.cellX0 === 0 && pc.cellY0 + pc.ny === L.ny };
    const corner = { ll: [0, 0], lr: [r.W, 0], ur: [r.W, r.D], ul: [0, r.D] };
    const inward = { ll: [1, 1], lr: [-1, 1], ur: [-1, -1], ul: [1, -1] };
    const notes = [];
    let good = true;
    for (const k of ['ll', 'lr', 'ur', 'ul']) {
      const rc = Math.min(radii[k], rMax);
      const [cx, cy] = corner[k], [sx, sy] = inward[k];
      const round = owns[k] && rc > 0.01;
      const square = at(cx, cy);
      // the two ends of the arc, one along each edge
      const ends = round && at(cx + sx*rc, cy) && at(cx, cy + sy*rc);
      if (square === round || (round && !ends)) { good = false; notes.push(k); }
    }
    console.log(`  piece ${pc.id}  cells (${pc.cellX0},${pc.cellY0})+${pc.nx}x${pc.ny}  ` +
                `rounded ${['ll', 'lr', 'ur', 'ul'].filter((k) => owns[k] && radii[k] > 0.01).join(',') || 'none'}` +
                `${good ? '' : `   WRONG AT ${notes.join(',')}`}`);
    if (!good) bad++;
  }
  console.log(`  a 6 mm corner is capped to ${rMax.toFixed(2)} mm, where the arc would ` +
              `otherwise eat the corner socket's rim`);
}

/* A rounded corner beside a half cell keeps its rim.
 *
 * A half cell's short side is a quarter pitch, and its socket ring's corner is held to that
 * side less the cutoff, so below about 17.6 mm the ring's corner shrinks and comes out
 * towards the plate's. buildPiece caps the plate's arc there by the half cell's own ring
 * (rMaxHalf, from rcHalf), solved, as the whole cell's cap is, to leave WALL — 0.2 mm —
 * between the two arcs. Before that cap the arc folded through the rim at pitch 14, and
 * at 16 and 17 it did not fold and left 0.031 and 0.134 mm of rim. Every other check here
 * passed those: a rim a few hundredths thick is exactly as watertight, and as well wound,
 * as one of 0.2.
 *
 * So the rim is measured off the mesh, as the least distance between the plate's outer
 * wall along the corner arc (its vertical faces that run neither along x nor along y) and
 * the socket's top edge (the sloped faces' edges at the plate top). What it is held to is
 * what the cap promises the mesh: WALL, or the rim cutoff where that is thinner, since
 * along the straight sides the cutoff is the rim; less what the outline gives up by
 * drawing the arc as NARC chords, each up to rc(1 − cos(π/4·NARC)) inside it — 15 µm at
 * 4.88. The socket's ring is drawn inside its own arc too, which only adds rim. Measured
 * from 13.5 to 60 mm, every cutoff and tolerance, at arcSegs 6 to 24, the thinnest rim
 * lands on that bar to 1e-14 and never under it, so the bar is the cap's and not a
 * tolerance chosen to pass. The cap itself is right on the arc; the chord's share is the
 * outline's, and a whole cell's capped corner gives up the same. */
console.log('\na rounded corner beside a half cell keeps its rim:');
{
  const WALL = 0.2, NARC = 10;
  const sag = (rc) => rc * (1 - Math.cos(Math.PI / (4 * NARC)));
  /* Every rounded corner of every piece: the least distance from the arc's chords to the
     socket edges within reach of that corner, and the arc's radius, read off the arc's two
     ends where they sit on the plate's edges. */
  const cornerRims = (cfg, L) => {
    const H = G.platePad(cfg) + cfg.plateHeight, out = [];
    const ptSeg = (p, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx*dx + dy*dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / l2)) : 0;
      return Math.hypot(p[0] - a[0] - t*dx, p[1] - a[1] - t*dy);
    };
    const gap = (a, b) => Math.min(ptSeg(a[0], b[0], b[1]), ptSeg(a[1], b[0], b[1]),
                                   ptSeg(b[0], a[0], a[1]), ptSeg(b[1], a[0], a[1]));
    for (const pc of L.pieces) {
      const r = G.buildPiece(cfg, L, pc);
      const arc = [], rim = [];
      for (const t of G.polysToTriangles(r.polys)) {
        const top = t.filter((v) => Math.abs(v[2] - H) < 1e-6);
        if (top.length !== 2) continue;
        const u = [0, 1, 2].map((k) => t[1][k] - t[0][k]), w = [0, 1, 2].map((k) => t[2][k] - t[0][k]);
        const n = [u[1]*w[2] - u[2]*w[1], u[2]*w[0] - u[0]*w[2], u[0]*w[1] - u[1]*w[0]];
        const len = Math.hypot(...n);
        if (len < 1e-12) continue;
        const e = top.map((v) => [v[0], v[1]]);
        if (Math.abs(n[2] / len) > 1e-6) rim.push(e);
        else if (Math.abs(e[1][0] - e[0][0]) > 1e-6 && Math.abs(e[1][1] - e[0][1]) > 1e-6) arc.push(e);
      }
      const corners = { ll: [0, 0], lr: [r.W, 0], ur: [r.W, r.D], ul: [0, r.D] };
      const halfAt = { ll: false, lr: !!pc.hR, ur: !!(pc.hR || pc.hB), ul: !!pc.hB };
      for (const [k, [cx, cy]] of Object.entries(corners)) {
        const within = (d) => (s) => s.every(([x, y]) => Math.abs(x - cx) < d && Math.abs(y - cy) < d);
        const chords = arc.filter(within(7)), edges = rim.filter(within(12));
        if (!chords.length || !edges.length) continue;
        let thin = Infinity, rc = 0;
        for (const a of chords) for (const b of edges) thin = Math.min(thin, gap(a, b));
        for (const s of chords) for (const [x, y] of s) {
          if (Math.abs(y - cy) < 1e-6) rc = Math.max(rc, Math.abs(x - cx));
          if (Math.abs(x - cx) < 1e-6) rc = Math.max(rc, Math.abs(y - cy));
        }
        out.push({ at: `${pc.id} ${k}`, half: halfAt[k], rim: thin, rc,
                   bar: Math.min(cfg.topCutoff, WALL) - sag(rc) });
      }
    }
    return out;
  };
  const C = G.PLATE_RANGES.topCutoff;
  const pitches = [];
  for (let p = G.PLATE_RANGES.pitch.min; p <= 18 + 1e-9; p += 0.5) pitches.push(p);
  pitches.push(42);
  const LAYS = {
    'column and row': (p) => ({ drawerW: 3*p + p/2, drawerD: 2*p + p/2 }),
    'column': (p) => ({ drawerW: 3*p + p/2, drawerD: 2*p }),
    'row': (p) => ({ drawerW: 3*p, drawerD: 2*p + p/2 }),
  };
  let builds = 0, halves = 0, worst = null;
  const under = [];
  for (const arcSegs of [6, 12])
    for (const p of pitches)
      for (const topCutoff of [C.min, G.DEFAULTS.topCutoff, C.max])
        for (const outerRadius of [4.88, 6])
          for (const [ln, lay] of Object.entries(LAYS)) {
            const cfg = Object.assign({}, G.DEFAULTS, { pitch: p, marginMode: 'half', connector: 'none',
              outerRadius, topCutoff, arcSegs }, lay(p));
            const L = G.computeLayout(cfg);
            builds++;
            for (const c of cornerRims(cfg, L)) {
              if (c.half) halves++;
              if (c.rim < c.bar - 1e-9)
                under.push(`${p} mm, cutoff ${topCutoff}, radius ${outerRadius}, ${ln}, arcSegs ${arcSegs}, ` +
                           `${c.at}${c.half ? ' (half)' : ''}: ${c.rim.toFixed(4)} under ${c.bar.toFixed(4)}`);
              if (c.half && (!worst || c.rim - c.bar < worst.rim - worst.bar))
                worst = Object.assign({ p, topCutoff, outerRadius }, c);
            }
          }
  /* The reviewer's two, by name: the default cutoff, the stock cap's radius, a half column
     and a half row, at the shipped smoothness. */
  const named = [16, 17].map((p) => {
    const cfg = Object.assign({}, G.DEFAULTS, { pitch: p, marginMode: 'half', connector: 'none',
      outerRadius: 4.88 }, LAYS['column and row'](p));
    const hs = cornerRims(cfg, G.computeLayout(cfg)).filter((c) => c.half);
    return `${p} mm ${Math.min(...hs.map((c) => c.rim)).toFixed(3)}`;
  });
  console.log(`  ${builds} plates, ${halves} half-cell corners: ` +
              (under.length ? `RIM UNDER WHAT THE CAP LEAVES: ${under.slice(0, 4).join('; ')}` +
                              (under.length > 4 ? ` and ${under.length - 4} more` : '')
                            : `none under WALL ${WALL} (or the cutoff) less the arc's chords`) +
              (halves ? '' : '   NO HALF-CELL CORNER MEASURED'));
  if (worst)
    console.log(`  nearest its bar: ${worst.rim.toFixed(4)} mm at ${worst.p} mm, cutoff ` +
                `${worst.topCutoff}, radius ${worst.outerRadius} capped to ${worst.rc.toFixed(3)}, ` +
                `against ${worst.bar.toFixed(4)}; at the stock cutoff, 16 and 17 mm: ${named.join(', ')}`);
  if (under.length || !halves) bad++;
}

/* Shared by the sections below: build every piece of a design and count its bad edges,
   and how many of those are open (used an odd number of times) rather than shells
   touching. `beyond` is how far any piece reaches past its own footprint and the tabs or
   lobes buildPiece says stick out of it — the room the print plan packs it into, and the
   line the next piece starts at. */
function designCfg(over) {
  const cfg = Object.assign({}, G.DEFAULTS, {
    marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: 6 }, over);
  if (['bowtie', 'puzzlekey', 'snap'].includes(cfg.connector) && !over.keyType) cfg.keyType = cfg.connector;
  if (over.clr !== undefined) {   // the four clearances, cut from the field as the page cuts them
    const fit = G.fitClearances(over.clr);
    for (const j of ['tab', 'key', 'hclip', 'puzzle'])
      cfg[j] = Object.assign({}, G.DEFAULTS[j], { clr: fit[j] });
  }
  return cfg;
}
// every piece of a design, or with `tile` the test tile the page would print for it
function buildAll(over, tile) {
  const cfg = designCfg(over);
  const L = G.computeLayout(cfg);
  const built = tile ? [G.buildTestTile(cfg)] : L.pieces.map((pc) => G.buildPiece(cfg, L, pc));
  const pieces = built.map((r) => r.polys);
  let bad = 0, open = 0, beyond = 0;
  for (const r of built) {
    bad += G.checkManifold(r.polys).bad;
    const key = (v) => v.map((x) => Math.round(x * 1000) / 1000).join(',');
    const edges = new Map();
    const p = r.protrusion;
    for (const t of G.polysToTriangles(r.polys))
      for (let i = 0; i < 3; i++) {
        const a = key(t[i]), b = key(t[(i + 1) % 3]);
        const k = a < b ? a + '|' + b : b + '|' + a;
        edges.set(k, (edges.get(k) || 0) + 1);
        const [x, y] = t[i];
        beyond = Math.max(beyond, -p.l - x, x - r.W - p.r, -p.f - y, y - r.D - p.b);
      }
    for (const c of edges.values()) if (c % 2) open++;
  }
  return { cfg, L, pieces, bad, open, beyond: Math.round(beyond * 1e4) / 1e4 };
}
const leakText = (r) => r.bad ? `${r.bad} BAD EDGES${r.open ? ` (${r.open} open)` : ' (shells touching)'}` : 'watertight';
// four 2 × 2 pieces, and a 3 × 3 split into pieces one cell wide — the narrow one is
// what gives out first as the pitch comes down
const PIECE_LAYOUTS = {
  '2x2 pieces': (p) => ({ drawerW: 4 * p, drawerD: 4 * p, splitMode: 'manual', rowCuts: [2], colCuts: [[2], [2]] }),
  '1-cell pieces': (p) => ({ drawerW: 3 * p, drawerD: 3 * p, splitMode: 'manual', rowCuts: [1], colCuts: [[2], [1]] }),
};

/* A magnet or screw-head pocket never cuts through the floor it sits in.
 *
 * The floor under a solid-based plate was 2.8 mm whatever went into it, and the magnet
 * depth field took any number. A 3 mm magnet — a common size — opened from below came
 * out through the socket floor, so the bin above sat on the magnet and nothing held it
 * in; opened from above it went out through the bottom of the plate. Every check above
 * passed on both, because a hole straight through a plate is perfectly watertight.
 *
 * So this reads the plate along a vertical line through the pocket and measures what is
 * left between the pocket and the far face: platePad has to leave MOUNT_SKIN of it.
 *
 * And no more than that. `floor` is the socket floor's height, written out rather than
 * worked out: 2.8 for anything up to 2.6 deep, because 2.8 is what those plates have
 * always been and they printed — the spec's 6.5 × 2.4 magnet over 0.4 mm of floor. A
 * thicker skin raises those plates for nothing, and the height the Bins page is handed
 * with them, and it would pass every other line here. */
console.log('\nmagnet and screw pockets keep a floor:');
{
  const inTri = (t, px, py) => {
    const s = (a, b) => (b[0]-a[0])*(py-a[1]) - (b[1]-a[1])*(px-a[0]);
    const d1 = s(t[0], t[1]), d2 = s(t[1], t[2]), d3 = s(t[2], t[0]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  // every horizontal face over a point, low to high
  const facesAt = (polys, px, py) => {
    const zs = [];
    for (const t of G.polysToTriangles(polys)) {
      if (Math.abs(t[0][2] - t[1][2]) > 1e-6 || Math.abs(t[0][2] - t[2][2]) > 1e-6) continue;
      if (inTri(t, px, py) && !zs.some((z) => Math.abs(z - t[0][2]) < 1e-6)) zs.push(t[0][2]);
    }
    return zs.sort((a, b) => a - b);
  };
  const POCKETS = [
    { name: 'magnet 3 mm, from below', depth: 3, floor: 3.2, from: 'bottom',
      cfg: { magnets: true, magnetH: 3 } },
    { name: 'magnet 3 mm, from above', depth: 3, floor: 3.2, from: 'top',
      cfg: { magnets: true, magnetH: 3, magnetSide: 'top' } },
    { name: 'magnet 6 mm, from below', depth: 6, floor: 6.2, from: 'bottom',
      cfg: { magnets: true, magnetH: 6 } },
    { name: 'magnet 2 mm, from below', depth: 2, floor: 2.8, from: 'bottom',
      cfg: { magnets: true, magnetH: 2 } },
    { name: 'magnet 6.5 × 2.4, from below', depth: 2.4, floor: 2.8, from: 'bottom',
      cfg: { magnets: true, magnetD: 6.5, magnetH: 2.4 } },
    { name: 'magnet 6.5 × 2.4, from above', depth: 2.4, floor: 2.8, from: 'top',
      cfg: { magnets: true, magnetD: 6.5, magnetH: 2.4, magnetSide: 'top' } },
    // the deepest the 2.8 mm floor holds, and the first step past it
    { name: 'magnet 2.6 mm, from below', depth: 2.6, floor: 2.8, from: 'bottom',
      cfg: { magnets: true, magnetH: 2.6 } },
    { name: 'magnet 2.7 mm, from below', depth: 2.7, floor: 2.9, from: 'bottom',
      cfg: { magnets: true, magnetH: 2.7 } },
    // probed through the counterbore beside the shank, which goes right through by design
    { name: 'screw head 3 mm', depth: 3, floor: 3.2, from: 'bottom', off: 2.25,
      cfg: { screws: true, screwHeadDepth: 3 } },
    { name: 'screw head 2.5 mm', depth: 2.5, floor: 2.8, from: 'bottom', off: 2.25,
      cfg: { screws: true, screwHeadDepth: 2.5 } },
  ];
  for (const pk of POCKETS) {
    // 2 × 2 rather than one cell, as it was when one cell with magnets from below had a
    // leak of its own at the pocket rim; that is the cases' at the top of this file now
    const r = buildAll(Object.assign({ drawerW: 84, drawerD: 84, arcSegs: 12 }, pk.cfg));
    const polys = r.pieces[0];
    const c = r.cfg.pitch / 2;
    const px = c - r.cfg.holeOffset + (pk.off || 0), py = c - r.cfg.holeOffset;
    const floorTop = Math.max(...facesAt(polys, c, c));   // the socket floor, at the cell centre
    const zs = facesAt(polys, px, py);
    let skin = -Infinity, depthOk = false;
    if (pk.from === 'bottom' && zs.length >= 2) {
      // the lowest face is the pocket's roof, and the next one up is the socket floor
      skin = zs[1] - zs[0];
      depthOk = Math.abs(zs[0] - pk.depth) < 1e-3 && Math.abs(zs[1] - floorTop) < 1e-3;
    }
    if (pk.from === 'top' && zs.length >= 2) {
      // the highest face is the pocket's floor, and the one under it the plate's bottom
      skin = zs[zs.length - 1] - zs[zs.length - 2];
      depthOk = Math.abs(floorTop - zs[zs.length - 1] - pk.depth) < 1e-3;
    }
    // and exactly, in platePad: 2.6 + 0.2 came to 2.8000000000000003, which moved every
    // face of a 2.8 mm plate by a hair and changed its file
    const floorOk = Math.abs(floorTop - pk.floor) < 1e-3 && G.platePad(r.cfg) === pk.floor;
    const good = r.bad === 0 && skin >= G.MOUNT_SKIN - 1e-6 && depthOk && floorOk;
    console.log(`  ${pk.name.padEnd(30)} floor ${floorTop.toFixed(2)} mm` +
                `${floorOk ? '' : ` NOT ${pk.floor.toFixed(2)}`}, ` +
                `${isFinite(skin) ? skin.toFixed(2) + ' mm left under the pocket' : 'CUT STRAIGHT THROUGH'}` +
                `${depthOk ? '' : ', POCKET NOT THE DEPTH ASKED'}, ${leakText(r)}${good ? '' : '   FAIL'}`);
    if (!good) bad++;
  }
}

/* The area of a plate's cross-section at height z: every triangle the plane crosses gives
   a segment, wound so the solid is on its left, and along each scanline the overlapping
   shells add up — inside the plate wherever the count is above zero. Scanlines `dy`
   apart, so a change narrower than that in y can slip between two; one in x cannot. */
function sectionArea(polys, z, dy) {
  const segs = [];
  for (const t of G.polysToTriangles(polys)) {
    const [a, b, c] = t;
    const n = [(b[1]-a[1])*(c[2]-a[2]) - (b[2]-a[2])*(c[1]-a[1]),
               (b[2]-a[2])*(c[0]-a[0]) - (b[0]-a[0])*(c[2]-a[2])];
    const pts = [];
    for (let [p, q] of [[a, b], [b, c], [c, a]]) {
      // the same edge in two triangles gives the same point, whichever way round it runs
      if (p[2] > q[2] || (p[2] === q[2] && (p[0] > q[0] || (p[0] === q[0] && p[1] > q[1])))) [p, q] = [q, p];
      if ((p[2] < z) !== (q[2] < z)) {
        const s = (z - p[2]) / (q[2] - p[2]);
        pts.push([p[0] + s*(q[0]-p[0]), p[1] + s*(q[1]-p[1])]);
      }
    }
    if (pts.length !== 2) continue;
    let [p, q] = pts;
    if ((q[0]-p[0])*-n[1] + (q[1]-p[1])*n[0] < 0) [p, q] = [q, p];
    segs.push([p, q, Math.min(p[1], q[1]), Math.max(p[1], q[1])]);
  }
  segs.sort((u, v) => u[2] - v[2]);
  const top = Math.max(...segs.map((s) => s[3]));
  let area = 0, next = 0, live = [];
  for (let k = 0; ; k++) {
    const y = segs[0][2] + dy/2 + k*dy;
    if (y >= top) break;
    while (next < segs.length && segs[next][2] <= y) live.push(segs[next++]);
    live = live.filter((s) => s[3] > y);
    const xs = [];
    for (const [p, q, lo] of live)
      if (y >= lo) xs.push([p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]), q[1] < p[1] ? 1 : -1]);
    xs.sort((u, v) => u[0] - v[0]);
    let w = 0, from = 0;
    for (const [x, s] of xs) {
      if (w <= 0 && w + s > 0) from = x;
      else if (w > 0 && w + s <= 0) area += (x - from) * dy;
      w += s;
    }
  }
  return area;
}

/* #76: a counterbore whose ceiling three cut lines cross at one point.
 *
 * At 39.07 mm, with a dovetail joint, a 3 mm shank and a counterbore 2.34 mm deep, every
 * piece with a seam on its left threw in healCsgSeams and was never built: B1 on the page's
 * two-piece plate, B1 to D1 on a four-piece one. Two facets of the socket's sloped wall at
 * the cell's corner, carried down by the cell's tree, cross the counterbore's ceiling about
 * 2 microns from an edge of the ceiling's own, and the weld's T-junction pass flipped
 * between the three corners of the triangle that leaves until it ran out of passes. It
 * was a point and not a band: 2.339 and 2.341 mm built, as did 39.06 and 39.08 mm, a
 * 2.5 or 3.4 mm shank, and heads up to 7.2 mm; from 7.3 mm to the 9.4 cap every head threw.
 * The repair now makes one point of the three and runs again (see healCsgSeams). So the
 * plate as filed, the other drawer the issue names, three seams, the smallest head that
 * threw and the cap, and the step either side in depth and pitch: every piece built,
 * watertight, and with every shell facing outwards. The last is asked as well as the edge
 * count because a merge can close a hole with a fold.
 *
 * And where the merge does not help. A jigsaw plate at 41.24 mm, with magnets from above
 * and a counterbore 3.126 mm deep under a 7.504 mm head, runs out of passes on the first
 * cut of both its pieces, and threw there before the merge. The merge lets that repair
 * settle, but open; kept as it came, the page built both pieces with 55 bad edges and
 * Download on, and with the magnet 2.264 mm deep, closed but folded twice, with NaN normals
 * in the STL. A second run that comes out open throws now, so the plate fails to build, as
 * it did before, and the checks say so. These two rows are built as the page builds them
 * (its clearances and margins), and hold "threw in the seam repair, or watertight and
 * oriented": whatever builds them later has to build them whole.
 *
 * With a bore's flats on its size, the same link cuts a counterbore 0.19 mm and a shank
 * 0.1 mm wider, a cut the seam repair settles. It came out open instead, 26 edges a piece
 * in the socket floor, and so did 38 of the 41 heads from 7.3 to 7.7 mm: a corner of the
 * magnet's pocket stood 0.4 microns off the plane of a flat of the shank. The shank is
 * turned for that now (MOUNT_BORE.hole.turn), so both rows build whole here, and so does
 * the third, a 7.4 mm head, which main builds whole as well. Of those heads only 7.31 mm
 * leaked, its corners 0.001 mm inside the magnet's (#77), until a counterbore that near is
 * cut as the pocket (MOUNT_BORE.head.snap); its row is below. The fourth cuts main's
 * bores, the head and shank whose polygons are main's 7.504 and 3 mm ones, 7.504 cos(π/14)
 * and 3 cos(π/12). That head's corners stand 0.002 mm outside the magnet's, inside the band
 * where the counterbore is cut as the magnet's pocket (MOUNT_BORE.head.snap), so it builds
 * whole now. The fifth cuts the same head apart from the pocket, as before the band: it runs
 * out of passes as on main and throws, so the second run's guard is still tested (without
 * the guard it builds both pieces with 55 bad edges). The magnet 2 and 2.2 mm deep and the
 * 7.498, 7.502 and 7.31 mm heads are #77's third case, the same link with the 7.3 mm
 * magnet's pocket and the counterbore's standing a few thousandths of a millimetre apart:
 * the issue counted 71 to 82 bad edges for the magnet 2 or 2.2 mm deep and 26 to 57 for the
 * heads at 7.498 and 7.502, with Download on, and the 7.31 mm head left 12 open edges and
 * two folds a piece before the counterbore was cut as the pocket. Main builds the first
 * four with 52 to 142 bad edges over the two pieces (and the 7.31 mm head closed); all
 * five build whole here. */
console.log('\na counterbore whose ceiling three cut lines cross at one point (#76):');
{
  const PLATE = { pitch: 39.07, drawerW: 170, drawerD: 90, bedW: 100, bedD: 400, marginMode: 'auto',
                  connector: 'dovetail', screws: true, screwHoleD: 3, screwHeadDepth: 2.34, screwHeadD: 8 };
  const ROWS = [
    ['as filed: B1 threw', {}],
    ['164 mm wide: B1 threw', { drawerW: 164 }],
    ['three seams: B1, C1, D1 threw', { drawerW: 280 }],
    ['7.3 mm head, the smallest that threw', { screwHeadD: 7.3 }],
    ['9.4 mm head, the cap', { screwHeadD: 9.4 }],
    ['7.2 mm head', { screwHeadD: 7.2 }],
    ['2.33 mm deep', { screwHeadDepth: 2.33 }],
    ['2.35 mm deep', { screwHeadDepth: 2.35 }],
    ['39.06 mm', { pitch: 39.06 }],
    ['39.08 mm', { pitch: 39.08 }],
  ];
  const build = (over) => {
    let r = null, err = null;
    try { r = buildAll(over); } catch (e) { err = e.message; }
    const turned = r ? r.pieces.map(checkOrientation).filter((o) => !o.ok) : [];
    const text = err ? `THREW: ${err}` : `${r.pieces.length} pieces, ${leakText(r)}, ` +
      (turned.length ? `${turned.length} pieces: ${orientationNote(turned[0])}` : 'oriented');
    return { r, err, whole: r && !r.bad && !turned.length, text };
  };
  for (const [label, over] of ROWS) {
    const b = build({ ...PLATE, ...over });
    console.log(`  ${label.padEnd(38)} ${b.text}`);
    if (!b.whole) bad++;
  }
  const JIGSAW = { pitch: 41.24, drawerW: 84.79, drawerD: 60.96, bedW: 53.61, bedD: 400, marginMode: 'auto',
                   connector: 'puzzle', clr: 0.2, screws: true, screwHoleD: 3, screwHeadDepth: 3.126,
                   screwHeadD: 7.504, magnets: true, magnetSide: 'top', magnetD: 7.3, magnetH: 2.25 };
  for (const [label, over] of [['41.24 mm jigsaw: 55 bad edges a piece', {}],
                               ['2.264 mm magnet: folded twice', { magnetH: 2.264 }],
                               ['7.4 mm head', { screwHeadD: 7.4 }],
                               ['magnet 2 mm deep', { magnetH: 2 }],
                               ['magnet 2.2 mm deep', { magnetH: 2.2 }],
                               ['7.498 mm head', { screwHeadD: 7.498 }],
                               ['7.502 mm head', { screwHeadD: 7.502 }],
                               ['7.31 mm head', { screwHeadD: 7.31 }],
                               ["main's bores", { screwHeadD: 7.504 * Math.cos(Math.PI / 14),
                                                  screwHoleD: 3 * Math.cos(Math.PI / 12) }],
                               ["main's bores, cut apart", { screwHeadD: 7.504 * Math.cos(Math.PI / 14),
                                                             screwHoleD: 3 * Math.cos(Math.PI / 12),
                                                             apart: true }]]) {
    const { apart, ...sizes } = over, snap = G.MOUNT_BORE.head.snap;
    if (apart) G.MOUNT_BORE.head.snap = 0;
    let b;
    try { b = build({ ...JIGSAW, ...sizes }); } finally { G.MOUNT_BORE.head.snap = snap; }
    const held = b.whole || /^healCsgSeams/.test(b.err || '');
    console.log(`  ${label.padEnd(38)} ${b.text}${held ? '' : '  NEITHER THREW NOR BUILT WHOLE'}`);
    if (!held) bad++;
  }
}

/* A margin of any width beside a corner, square or rounded.
 *
 * A margin is a region of its own, cut from the plate's outline beside the cells it runs
 * along, and each region is built BLOAT past the cut so the two shells overlap. That only
 * works while the band where they overlap holds no vertex of the outline. One that does is
 * in both shells, and each puts a vertical edge of the plate's side wall on it: an edge
 * used four times, two closed shells touching where they were meant to overlap. A margin
 * under a BLOAT puts the corner itself in the band, and with it the whole of the side wall
 * either side; beside a rounded corner the arc's own vertices are spread across the first
 * millimetre or so of the edge, so 0.15, 0.4 and 0.75 mm beside a 4 mm corner each did it
 * once a side.
 *
 * So the cut moves out towards the plate's edge until the band is clear, and a margin with
 * no room left joins its cells. That changes which region a strip of plate belongs to and
 * must change nothing else — and on a skeleton plate it did: a skeleton cell is hollow
 * underneath out to the edge of its region, so a cell whose region had grown over a margin
 * hollowed the margin too, and 48 of 105 skeleton plates in one sweep lost plastic on the
 * bed while their meshes stayed perfectly clean. A 1 mm margin by a 1 mm corner lost its
 * whole solid border, 815 mm² of footprint down to 459. Nothing here could see it.
 *
 * A region's corners are points of its outline too: where the arc crosses a clip line of
 * the other axis, a BLOAT either side of a cut, every region along that line has the same
 * point. With 2.2 mm margins front and back, side margins of 0.54 to 0.8 mm beside a 4 or
 * 4.88 mm corner put one of those in the band once their cuts had moved, 58 plates of the
 * row below, solid and skeleton. And a skeleton cell beside a moved cut hollows only as
 * far as the margin was cut before, so where the arc runs through that corner of the
 * hollow the solid strip around it pinched to a point: 0.69 mm margins left and front and
 * 1.38 right and back, by a 4.88 mm corner.
 *
 * So every margin from none to 1 mm, a hundredth at a time, on all four sides of one cell,
 * beside square corners, the default radius and the largest the cap allows; the same past
 * a strip of half cells, which is a margin cut of its own; on the sides only, beside
 * 2.2 mm front and back; and on the left and front, with twice that on the right and
 * back; each as a solid plate and as a skeleton. Every one has to come back with no bad
 * edge at all, open or touching. And
 * the shape: the area of each plate's cross-section just off the bed, at 1.3 mm, and at
 * 3.1 mm above the hollow, summed over each row of 101 plates, has to be what it was
 * before any cut could move — measured on main at 21b1dc4, whose cuts were where its
 * margins ended, to within 0.01 mm² a row. A change here is a change to the printed
 * plate; if it is meant, the line printed says what to put in its place. */
console.log('\na margin of any width beside a corner:');
{
  const touched = [];
  const ZS = [0.137, 1.3, 3.1], DY = 0.02;
  const WAS = {
    'solid margins r0': [52296.615, 44205.427, 35244.483],
    'solid past half cells r0': [134588.378, 111585.760, 85866.769],
    'skeleton margins r0': [21029.262, 21312.539, 35244.483],
    'skeleton past half cells r0': [102885.028, 88257.595, 85866.769],
    'solid margins r4': [50888.745, 42797.557, 33836.614],
    'solid past half cells r4': [133183.770, 110181.152, 84462.161],
    'skeleton margins r4': [27875.451, 26002.964, 33836.614],
    'skeleton past half cells r4': [101832.387, 87204.954, 84462.161],
    'solid margins r4.88': [50200.920, 42109.732, 33148.789],
    'solid past half cells r4.88': [132496.762, 109494.144, 83775.153],
    'skeleton margins r4.88': [34609.233, 30746.763, 33148.789],
    // the same as solid: the arc leaves the corner cell short of whole, so it is not hollowed
    'skeleton past half cells r4.88': [132496.762, 109494.144, 83775.153],
    'solid beside 2.2 mm margins r0': [67027.862, 58938.779, 49978.919],
    'skeleton beside 2.2 mm margins r0': [35698.979, 35985.081, 49978.919],
    'solid beside 2.2 mm margins r4': [65619.993, 57530.910, 48571.049],
    'skeleton beside 2.2 mm margins r4': [34299.969, 34586.071, 48571.049],
    'solid beside 2.2 mm margins r4.88': [64932.168, 56843.085, 47883.224],
    'skeleton beside 2.2 mm margins r4.88': [33656.240, 33942.342, 47883.224],
    'solid twice that right and back r0': [56692.937, 48601.749, 39640.806],
    'skeleton twice that right and back r0': [25425.585, 25708.862, 39640.806],
    'solid twice that right and back r4': [55287.689, 47196.501, 38235.558],
    'skeleton twice that right and back r4': [29749.751, 28540.591, 38235.558],
    'solid twice that right and back r4.88': [54600.540, 46509.353, 37548.409],
    'skeleton twice that right and back r4.88': [34032.406, 31496.592, 37548.409],
  };
  const sums = {};
  let builds = 0;
  for (let i = 0; i <= 100; i++) {
    const m = i / 100;
    for (const outerRadius of [0, 4, 4.88]) {
      const DESIGNS = {
        'margins': { drawerW: 42 + 2 * m, drawerD: 42 + 2 * m, mLeft: m, mRight: m, mFront: m, mBack: m },
        // the leftover past a half column and a half row, all of it on the far side
        'past half cells': { drawerW: 42 + 21 + m, drawerD: 42 + 21 + m, marginMode: 'half',
                             alignX: 'end', alignY: 'end' },
        // where a moved cut's clip lines cross the arc beside a margin of another width
        'beside 2.2 mm margins': { drawerW: 42 + 2 * m, drawerD: 42 + 4.4, mLeft: m, mRight: m,
                                   mFront: 2.2, mBack: 2.2 },
        // and where the arc runs through the corner of what a skeleton cell hollows
        'twice that right and back': { drawerW: 42 + 3 * m, drawerD: 42 + 3 * m, mLeft: m,
                                       mRight: 2 * m, mFront: m, mBack: 2 * m },
      };
      for (const plateStyle of ['solid', 'skeleton'])
        for (const [dn, d] of Object.entries(DESIGNS)) {
          const r = buildAll({ ...d, outerRadius, connector: 'none', plateStyle });
          builds++;
          if (r.bad) touched.push(`${plateStyle} ${dn} ${m.toFixed(2)} mm, radius ${outerRadius}: ${leakText(r)}`);
          const row = `${plateStyle} ${dn} r${outerRadius}`;
          sums[row] = sums[row] || ZS.map(() => 0);
          ZS.forEach((z, k) => { sums[row][k] += sectionArea(r.pieces[0], z, DY); });
        }
    }
  }
  console.log(`  0 to 1 mm by 0.01, ${builds} plates: ` +
              (touched.length ? `NOT CLEAN: ${touched.slice(0, 6).join('; ')}` +
                                (touched.length > 6 ? ` and ${touched.length - 6} more` : '')
                              : 'every one watertight with no shells touching'));
  bad += touched.length;
  const moved = Object.entries(sums).filter(([row, s]) =>
    !WAS[row] || s.some((a, k) => Math.abs(a - WAS[row][k]) > 0.01));
  for (const [row, s] of moved)
    console.log(`  ${row}: cross-sections at z ${ZS.join(', ')} sum to ` +
                `[${s.map((a) => a.toFixed(3)).join(', ')}] mm², ` +
                (WAS[row] ? `NOT [${WAS[row].join(', ')}] — THE PLATE CHANGED SHAPE` : 'NOTHING ON FILE'));
  console.log(`  cross-sections of ${Object.keys(sums).length} rows of plates, at z ${ZS.join(', ')}: ` +
              (moved.length ? `${moved.length} CHANGED` : 'each the shape it was before the cuts could move'));
  bad += moved.length;
}

/* A skeleton cell's hollow with its corner on the corner arc.
 *
 * Beside a moved cut a skeleton cell hollows only as far as the margin was cut before
 * (the section above), and where that corner of the hollow lands on the plate's corner
 * arc, openSplit puts it into the outline. A corner a thousandth or two inside the arc,
 * with the arc's next vertex that far past it on the hollow's side line, left a needle of
 * no width in the strip's underside and a hole in the bed face: 0.1 mm margins beside
 * 2.08 mm ones by a 3.08 mm corner had 12 open edges, and 62 of the 686 plates here had
 * holes. Every margin row above missed it, because it takes the two margins together to
 * put the corner there.
 *
 * So margins chosen to put that corner on the arc: on each of its ten segments, at a
 * vertex and 0.4% of the segment either side of one, rounded to a thousandth as the page's
 * fields are, beside corners from 1 to 4.88 mm, both ways round. Every one watertight,
 * and the shape what main built, to within 0.004 mm² a plate summed over them all: where
 * the arc pinches the strip at that corner the hollow's corner is cut off a hair, and the
 * outline moves a hundredth at most (openSplit). */
console.log('\na skeleton cell\'s hollow with its corner on the arc:');
{
  const BLOAT = 0.05, NARC = 10, ZS = [0.137, 1.3, 3.1], DY = 0.02;
  const WAS = [188938.601, 190857.982, 285277.342];   // main at 21b1dc4
  const radii = Array.from({ length: 33 }, (_, i) => Math.round((1 + i * 0.12) * 100) / 100).concat(4.88);
  const designs = [], seen = new Set();
  for (const r of radii)
    for (let k = 0; k < NARC; k++)
      for (const t of [0, 0.004, 0.996]) {
        // the arc as buildPiece draws it, about the front left corner
        const a0 = (180 + 90 * k / NARC) * Math.PI / 180, a1 = (180 + 90 * (k + 1) / NARC) * Math.PI / 180;
        const x = r + r * Math.cos(a0) + t * r * (Math.cos(a1) - Math.cos(a0));
        const y = r + r * Math.sin(a0) + t * r * (Math.sin(a1) - Math.sin(a0));
        const m = Math.round((x - BLOAT) * 1000) / 1000, f = Math.round((y - BLOAT) * 1000) / 1000;
        if (m <= 0.011 || f <= 0.011) continue;
        for (const [ml, mf] of [[m, f], [f, m]]) {
          if (seen.has(`${r} ${ml} ${mf}`)) continue;
          seen.add(`${r} ${ml} ${mf}`);
          designs.push({ outerRadius: r, mLeft: ml, mRight: ml, mFront: mf, mBack: mf,
                         drawerW: Math.round((42 + 2 * ml) * 1000) / 1000,
                         drawerD: Math.round((42 + 2 * mf) * 1000) / 1000 });
        }
      }
  const holed = [], sums = ZS.map(() => 0);
  for (const d of designs) {
    const r = buildAll({ ...d, connector: 'none', plateStyle: 'skeleton' });
    if (r.bad) holed.push(`${d.mLeft}/${d.mFront} mm by ${d.outerRadius}: ${leakText(r)}`);
    ZS.forEach((z, k) => { sums[k] += sectionArea(r.pieces[0], z, DY); });
  }
  const off = sums.map((s, k) => Math.abs(s - WAS[k]));
  const changed = off.some((o) => o > 0.004 * designs.length);
  console.log(`  ${designs.length} plates: ` +
              (holed.length ? `NOT CLEAN: ${holed.slice(0, 6).join('; ')}` +
                              (holed.length > 6 ? ` and ${holed.length - 6} more` : '')
                            : 'every one watertight') +
              `; cross-sections at z ${ZS.join(', ')} sum to [${sums.map((s) => s.toFixed(3)).join(', ')}] mm², ` +
              (changed ? `NOT [${WAS.join(', ')}] — THE PLATES CHANGED SHAPE`
                       : `within ${(0.004 * designs.length).toFixed(2)} of main's`));
  bad += holed.length + (changed ? 1 : 0);
}

/* The limits the page enforces, built at their ends.
 *
 * PLATE_RANGES and mountLimits are where the page stops accepting a number, and each end
 * is there because one step past it leaked or broke through — the reasons are written
 * next to them in core.js. A limit is only worth having if the value AT it is good, so
 * the extremes are built here; and the one step past each that justified the pitch floor
 * is built too, so that if the engine ever closes it the floor can come down and this
 * says so, the way a quarantined case does. */

console.log('\nthe smallest pitch the page allows:');
{
  const P = G.PLATE_RANGES.pitch.min;
  const CONFIGS = {
    none: { connector: 'none' }, dovetail: { connector: 'dovetail' }, puzzle: { connector: 'puzzle' },
    bowtie: { connector: 'bowtie' }, puzzlekey: { connector: 'puzzlekey' }, snap: { connector: 'snap' },
    hclip: { connector: 'hclip' },
    'bowtie wall': { connector: 'bowtie', keyMount: 'wall' },
    'puzzlekey wall': { connector: 'puzzlekey', keyMount: 'wall' },
    'snap wall': { connector: 'snap', keyMount: 'wall' },
    'hclip top': { connector: 'hclip', keyInsert: 'top' },
    'bowtie wall top': { connector: 'bowtie', keyMount: 'wall', keyInsert: 'top' },
    'puzzlekey wall top': { connector: 'puzzlekey', keyMount: 'wall', keyInsert: 'top' },
    'snap top': { connector: 'snap', keyInsert: 'top' },
    skeleton: { connector: 'none', plateStyle: 'skeleton' },
  };
  /* And two layouts in which a piece is one cell deep between two seams, rows and then
     columns, so that it takes a key from each side. Below about 14.3 mm the two housings
     meet in the middle of it (keysMeet in core.js), and the page refuses the design: Checks
     says why and nothing is built. Neither layout was here, and every keyed joint in the
     floor leaked on both, as did a key in the wall put in from above. So a refused design
     has to be one the engine really cannot build — open at this pitch — and at the first
     pitch the page takes it again it has to come back clean. */
  const LAYOUTS = Object.assign({}, PIECE_LAYOUTS, {
    'rows one cell deep': (p) => ({ drawerW: 3 * p, drawerD: 3 * p, splitMode: 'manual',
                                    rowCuts: [1, 2], colCuts: [[], [], []] }),
    'columns one cell wide': (p) => ({ drawerW: 3 * p, drawerD: 3 * p, splitMode: 'manual',
                                       rowCuts: [], colCuts: [[1, 2]] }),
  });
  // folds too, which an edge count cannot see: a sliver turned over against its neighbour
  const foldsOf = (r) => r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
  const health = (r, folds) => r.bad ? leakText(r) + (folds ? `, ${folds} FOLDS` : '')
                                     : folds ? `${folds} FOLDS` : 'watertight';
  const refused = [];
  for (const [ln, lay] of Object.entries(LAYOUTS)) {
    const leaks = [];
    for (const [cn, conf] of Object.entries(CONFIGS)) {
      const r = buildAll(Object.assign({ pitch: P }, lay(P), conf));
      const meet = G.keysMeet(r.cfg, r.L);
      if (meet.length) { refused.push({ cn, ln, r, meet }); continue; }
      const folds = foldsOf(r);
      if (r.bad || folds) leaks.push(`${cn} ${health(r, folds)}`);
    }
    const no = refused.filter((f) => f.ln === ln).length;
    console.log(`  ${P} mm, ${ln}: ${Object.keys(CONFIGS).length} configurations` +
                `${no ? `, ${no} refused (below)` : ''}, ` +
                (leaks.length ? `LEAKING: ${leaks.join('; ')}` : 'every other one watertight, with no folds'));
    bad += leaks.length;
  }
  for (const { cn, ln, r, meet } of refused) {
    const needs = Math.max(...meet.map((m) => m.needs));
    // up a hundredth at a time to the first pitch the page takes, which has to build clean
    const meets = (p) => {
      const c = designCfg(Object.assign({ pitch: p }, LAYOUTS[ln](p), CONFIGS[cn]));
      return G.keysMeet(c, G.computeLayout(c)).length > 0;
    };
    let p = P;
    while (meets(p)) p = Math.round((p + 0.01) * 100) / 100;
    const ok = buildAll(Object.assign({ pitch: p }, LAYOUTS[ln](p), CONFIGS[cn]));
    const earned = r.open > 0, clean = !ok.bad;
    /* And every joint Checks names as one that fits instead, at this pitch on this
       layout: each has to build watertight, or the page is sending you to another leak. */
    const fit = G.jointsThatFit(r.cfg, r.L).map((j) => {
      const b = buildAll(Object.assign({ pitch: P }, LAYOUTS[ln](P), CONFIGS[cn], j.over));
      return { id: j.id, b, refused: G.keysMeet(b.cfg, b.L).length > 0 };
    });
    const badFit = fit.filter((f) => f.b.bad || f.refused);
    const many = meet.length > 1;
    console.log(`  refused: ${cn} @ ${ln}, ${many ? 'pieces' : 'piece'} ` +
                `${meet.map((m) => m.id).join(', ')} ${many ? 'need' : 'needs'} ` +
                `${needs.toFixed(2)} mm: ${leakText(r)} at ${P}` +
                `${earned ? '' : ' — NOT OPEN, SO THE REFUSAL COSTS A PLATE THAT BUILDS'}; ` +
                `taken again at ${p}, ${leakText(ok)}${clean ? '' : '   FAIL'}; ` +
                `${fit.length} joints named instead, ` +
                (badFit.length ? `NOT ALL BUILD: ${badFit.map((f) => `${f.id} ${f.refused ? 'REFUSED' : leakText(f.b)}`).join('; ')}`
                               : `each watertight at ${P}`));
    if (!earned || !clean || badFit.length || !fit.length) bad++;
  }
  // the step below: 13.3 opened the narrow pieces of four joints; with the joint's cut tried
  // again when it comes out open (cutAgain in core.js) it opens the puzzle's alone
  const below = Math.round((P - 0.2) * 10) / 10;
  const opened = ['puzzle', 'bowtie', 'puzzlekey', 'snap'].filter((cn) =>
    buildAll(Object.assign({ pitch: below }, LAYOUTS['1-cell pieces'](below), CONFIGS[cn])).open > 0);
  console.log(`  ${below} mm, 1-cell pieces: ${opened.length ? `open on ${opened.join(', ')} — the floor is earned`
                                                              : 'ALL CLOSED — the pitch floor can come down'}`);
  if (!opened.length) bad++;

  /* And above it. Everything here was built at 13.5 mm and nowhere else, so what the page
     took between that and 16 mm went out unread: a sweep of the joints and layouts above
     every 0.01 mm, at the clearances as they come, found 285 of the 14,194 plates it took
     open, with shells touching, or folded, and one every 0.05 mm across the field found
     the H-clip put in from above open at a field of 0.74 at every pitch. One plate from
     each run of pitches main left that way is built here at the clearances as they come,
     and then some at other fields. Each has to be taken, closed, its shells apart, and
     with no folds. */
  const MAIN_LEFT = {
    dovetail: { '2x2 pieces': [15.1], 'rows one cell deep': [15.1] },
    puzzle: { '2x2 pieces': [15.71], '1-cell pieces': [14.41, 14.51],
              'rows one cell deep': [13.91, 14.95, 15.71], 'columns one cell wide': [14.52] },
    bowtie: { '2x2 pieces': [13.59, 13.66, 13.98, 14.58], '1-cell pieces': [14.9], 'rows one cell deep': [14.58] },
    puzzlekey: { '1-cell pieces': [15.02], 'rows one cell deep': [14.46, 15.02, 15.18, 15.43, 15.56],
                 'columns one cell wide': [14.56, 15.11, 15.18] },
    snap: { '2x2 pieces': [14.84, 15.98], '1-cell pieces': [14.19, 14.53, 14.63, 15.42],
            'rows one cell deep': [14.84, 15.98], 'columns one cell wide': [15.98] },
    hclip: { '2x2 pieces': [14.3, 16], '1-cell pieces': [14.3, 16],
             'rows one cell deep': [14.3, 16], 'columns one cell wide': [14.3, 16] },
    'bowtie wall': { '2x2 pieces': [15.13, 15.19, 15.21, 15.34, 15.61], '1-cell pieces': [15.61],
                     'rows one cell deep': [14.67, 15.13, 15.19, 15.21, 15.34, 15.61],
                     'columns one cell wide': [15.61] },
    'puzzlekey wall': { '2x2 pieces': [13.56, 14.07, 14.36, 15.43],
                        'rows one cell deep': [13.54, 13.58, 13.8, 14.07, 14.36, 14.42, 14.48, 14.67],
                        'columns one cell wide': [13.54, 13.58, 13.8, 14.42, 14.48] },
    'snap wall': { '2x2 pieces': [13.51, 14.81, 15.13], '1-cell pieces': [14.81],
                   'rows one cell deep': [13.51, 13.85, 14.67, 14.81, 15.13, 15.24],
                   'columns one cell wide': [14.81] },
    'hclip top': { '2x2 pieces': [14.85], '1-cell pieces': [14.85],
                   'rows one cell deep': [14.85], 'columns one cell wide': [14.85] },
    'bowtie wall top': { 'rows one cell deep': [14.44, 14.97], 'columns one cell wide': [14.44] },
    'puzzlekey wall top': { '2x2 pieces': [13.99, 14.85, 15.8], '1-cell pieces': [14, 14.85, 15.88],
                            'rows one cell deep': [14.44, 14.79, 15.54, 15.71, 15.86, 15.94],
                            'columns one cell wide': [14.44, 14.85, 15.54, 15.81] },
  };
  // [joint, layout, pitch, field, and the layout written out where it is none of the above]:
  // the field as the page cuts it, or the joint's ceiling if lower
  const AT_FIELD = [
    ['hclip top', '2x2 pieces', 14.75, 0.74], ['hclip top', '1-cell pieces', 13.5, 0.74],
    ['hclip top', 'rows one cell deep', 14.75, 0.74], ['hclip top', 'columns one cell wide', 13.5, 0.74],
    ['hclip top', 'columns one cell wide', 15.8, 0.74], ['hclip top', '2x2 pieces', 14.85, 0.2],
    ['hclip top', 'rows one cell deep', 15.15, 0.5], ['hclip top', 'columns one cell wide', 15.65, 1],
    ['hclip', '2x2 pieces', 14.3, 0.2], ['hclip', 'rows one cell deep', 14.6, 0.5],
    ['hclip', 'columns one cell wide', 15, 0.9],
    ['dovetail', 'columns one cell wide', 13.5, 0.1], ['dovetail', '2x2 pieces', 13.55, 0.3],
    ['dovetail', 'rows one cell deep', 13.55, 0.3], ['dovetail', 'columns one cell wide', 13.55, 0.3],
    ['dovetail', '2x2 pieces', 15.1, 0.2],
    ['puzzle', 'columns one cell wide', 13.6, 0.1], ['puzzle', '1-cell pieces', 14.55, 0],
    ['puzzle', 'rows one cell deep', 14.95, 0.2], ['puzzle', '2x2 pieces', 15.4, 0.3],
    ['puzzle', 'rows one cell deep', 15.75, 0.3],
    ['puzzlekey', '1-cell pieces', 13.55, 0.3], ['puzzlekey', '2x2 pieces', 13.85, 0.3],
    ['puzzlekey', '2x2 pieces', 13.9, 0], ['puzzlekey', 'rows one cell deep', 14.35, 0],
    ['puzzlekey', 'rows one cell deep', 15.2, 0.3],
    ['bowtie', '2x2 pieces', 13.8, 0], ['bowtie', 'columns one cell wide', 14.8, 0],
    ['bowtie', '1-cell pieces', 14.9, 0.2],
    ['snap', '2x2 pieces', 13.55, 0], ['snap', '2x2 pieces', 13.95, 0.9], ['snap', '1-cell pieces', 14.35, 0],
    ['snap', '1-cell pieces', 14.95, 0.7], ['snap', 'rows one cell deep', 15.3, 0.5],
    // a spoke of the bottom cap 8.1 microns from a lobe's corner (fanCentre in core.js)
    ['puzzle', 'rows beside columns', 14.71, 0.3, { drawerW: 3 * 14.71, drawerD: 5 * 14.71,
      splitMode: 'manual', rowCuts: [1, 2], colCuts: [[], [], [1, 2]] }],
  ];
  /* And the same lottery at 42 mm, where it is rarer: a dovetail at a field of 0.3 on
     rows one cell wide (an edge used four times and a fold at each seam), a puzzle key in
     the wall at the page's own smoothness (a face left as a line, four edges used four
     times), and the H-clip from above at 0.74. */
  const AT_42 = [
    ['dovetail', 'a column of rows', 0.3, { drawerW: 42, drawerD: 126, splitMode: 'manual',
                                            rowCuts: [1, 2], colCuts: [[], [], []] }],
    ['puzzlekey wall', 'columns one cell wide', undefined,
     { ...LAYOUTS['columns one cell wide'](42), arcSegs: G.DEFAULTS.arcSegs, magnets: true, magnetSide: 'top' }],
    ['hclip top', 'rows one cell deep', 0.74, LAYOUTS['rows one cell deep'](42)],
  ];
  const cases = [];
  for (const [cn, by] of Object.entries(MAIN_LEFT))
    for (const [ln, ps] of Object.entries(by)) for (const p of ps) cases.push([cn, ln, p]);
  const fielded = cases.length;
  cases.push(...AT_FIELD, ...AT_42.map(([cn, ln, f, lay]) => [cn, ln, 42, f, lay]));
  const notClean = [];
  const t0 = Date.now();
  for (const [cn, ln, p, f, lay] of cases) {
    const over = { pitch: p, ...(lay || LAYOUTS[ln](p)), ...CONFIGS[cn] };
    if (f !== undefined) over.clr = Math.min(f, G.connClrCeiling(designCfg(over)).max);
    const r = buildAll(over);
    const at = `${cn} at ${p} mm, ${ln}${f === undefined ? '' : `, field ${over.clr}`}`;
    if (G.keysMeet(r.cfg, r.L).length) { notClean.push(`${at}: REFUSED`); continue; }
    const folds = foldsOf(r);
    if (r.bad || folds) notClean.push(`${at}: ${health(r, folds)}`);
  }
  console.log(`  above it: ${fielded} plates from 13.5 to 16 mm that main left leaking or folded at the ` +
              'clearances as they come, ' +
              `${AT_FIELD.length} at other fields, and ${AT_42.length} at 42 mm, ` +
              `built in ${((Date.now() - t0) / 1000).toFixed(0)} s: ` +
              (notClean.length ? `NOT ALL CLEAN: ${notClean.slice(0, 6).join('; ')}` +
                                 (notClean.length > 6 ? ` and ${notClean.length - 6} more` : '')
                               : 'every one taken, watertight and with no folds'));
  bad += notClean.length;
}

/* The joints Checks names in place of keys that meet, across every pitch it refuses at.
 *
 * The section above builds them at 13.5 mm and the default clearance only, and named
 * that way the message sent people to plates that leaked. jointsThatFit names a joint
 * only from the pitch it was swept clean from (KEY_ALTERNATIVES in core.js). It held
 * some back from where they leaked, 006ea48 named all but the cup, and this built a plate
 * just short of each bound; the joint's cut taken again (cutAgain in core.js) closed
 * every one of them, so every joint is named wherever it clears and none is held back.
 *
 * So this builds what it names, the way it is named, insert and all: the H-clip put in
 * from beneath or from above, the snap clip inside the walls from above. Every 0.4 mm
 * from 13.5 to 15.9, the last pitch anything is refused at, and at 14.3, 14.5 and 15.3,
 * where joints used to be held back from; rows one cell deep, and rows beside columns
 * one cell wide in one drawer; the field every 0.1 from 0, and 0.74, as far as the joint
 * in use goes. The joint named is built at that field, or at its own ceiling where that
 * is lower: the page refuses a field over the ceiling ("Fit clearance must be ... or
 * less") until it is lowered, and the ceiling is as far as it has to come. A plate that
 * leaks, or that keysMeet refuses after all, fails it.
 *
 * The fields were 0, 0.3 and the ceiling, and none of the three met the H-clip from
 * above at 0.74, which leaked at every pitch until cutAgain (see KEY_ALTERNATIVES). */
console.log('\nthe joints named in place of keys that meet, wherever they meet:');
{
  const LAYS = {
    rows: (p) => ({ drawerW: 3 * p, drawerD: 3 * p, splitMode: 'manual', rowCuts: [1, 2], colCuts: [[], [], []] }),
    both: (p) => ({ drawerW: 3 * p, drawerD: 5 * p, splitMode: 'manual', rowCuts: [1, 2], colCuts: [[], [], [1, 2]] }),
  };
  const IN_USE = {
    bowtie: { connector: 'bowtie' }, puzzlekey: { connector: 'puzzlekey' }, snap: { connector: 'snap' },
    'bowtie wall top': { connector: 'bowtie', keyMount: 'wall', keyInsert: 'top' },
    'puzzlekey wall top': { connector: 'puzzlekey', keyMount: 'wall', keyInsert: 'top' },
  };
  // the joint named, at the field as it stands or at the joint's own ceiling if lower
  const named = (p, lay, conf, f, over) => {
    const base = { pitch: p, ...lay(p), ...conf, ...over };
    return { ...base, clr: Math.min(f, G.connClrCeiling(designCfg(base)).max) };
  };
  /* These were held back, and leaked: the dovetail for a bowtie at 13.6 with 0.3, the
     H-clip from beneath for a snap clip at 14.2 with 1, puzzle tabs for a snap clip at
     15.94 with 1, a puzzle key in the wall from beneath at 14.48 with 0.3 and a snap clip
     at 15.24 with 1, a bowtie in a cup at 14.44 with 0.3. Each builds clean now and is
     named, so nothing is held back and nothing is checked for it. Should a sweep (every
     0.01 mm from 13.5 to 16, every 0.05 of the field, both layouts below) find a joint
     that leaks where it would be named, it goes back into KEY_ALTERNATIVES with a bound,
     and a plate just short of that bound goes here: built as named it has to leak still,
     keysMeet has to refuse the key in use, and jointsThatFit must not name the joint. */
  const pitches = new Set([14.3, 14.5, 15.3]);
  for (let p = 13.5; p <= 15.9 + 1e-9; p = Math.round((p + 0.4) * 10) / 10) pitches.add(p);
  const built = new Set(), leaks = [], names = {}, folded = {};
  let refused = 0;
  const t0 = Date.now();
  for (const p of [...pitches].sort((a, b) => a - b))
    for (const [ln, lay] of Object.entries(LAYS))
      for (const [cn, conf] of Object.entries(IN_USE)) {
        const most = G.connClrCeiling(designCfg({ pitch: p, ...lay(p), ...conf })).max;
        const fields = [0.74];
        for (let i = 0; i <= 10; i++) fields.push(i / 10);
        for (const f of new Set(fields.map((x) => Math.min(x, most)))) {
          const cfg = designCfg({ pitch: p, ...lay(p), ...conf, clr: f });
          const L = G.computeLayout(cfg);
          if (!G.keysMeet(cfg, L).length) continue;
          refused++;
          for (const j of G.jointsThatFit(cfg, L)) {
            names[j.id] = (names[j.id] || 0) + 1;
            const over = named(p, lay, conf, f, j.over), k = JSON.stringify(over);
            if (built.has(k)) continue;
            built.add(k);
            const r = buildAll(over);
            const meets = G.keysMeet(r.cfg, r.L).length > 0;
            if (r.bad || meets)
              leaks.push(`${j.id} for ${cn} at ${p} mm, ${ln}, field ${over.clr}: ${meets ? 'REFUSED' : leakText(r)}`);
            // once a plate: the same H-clip is built again for each key it stands in for
            const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
            const at = `${p} mm ${ln} ${over.clr}`, xs = folded[j.id] = folded[j.id] || [];
            if (folds && !xs.some((x) => x.at === at)) xs.push({ at, folds });
          }
        }
      }
  console.log(`  ${refused} designs refused; named instead ${Object.entries(names).map(([id, n]) => `${id} ${n}`).join(', ')}; ` +
              `${built.size} plates built in ${((Date.now() - t0) / 1000).toFixed(0)} s: ` +
              (leaks.length ? `NOT ALL CLEAN: ${leaks.slice(0, 6).join('; ')}` +
                              (leaks.length > 6 ? ` and ${leaks.length - 6} more` : '')
                            : 'every one watertight'));
  bad += leaks.length + (refused && built.size ? 0 : 1);
  /* And folds, which an edge count cannot see. The H-clip put in from beneath had them: a
     sliver of the bed face by the clip's pocket turned over, four on a piece, and no edge
     open, where the pitch is 14.1 mm more than the field (27 plates of 5,202 from 14.3 to
     15.95 mm every 0.05 and every 0.02 of the field, and 8 here). It was held to the
     plates on file, as a quarantine is, until healCsgSeams counted the faces it turns
     over and cutAgain took those cuts again. None is on file now: a joint named here
     that folds fails. */
  const FOLDED = {};
  const foldNotes = [], foldFails = [];
  for (const [id, xs] of Object.entries(folded)) {
    if (!xs.length) continue;
    const on = FOLDED[id], most = Math.max(...xs.map((x) => x.folds));
    const say = `${id} on ${xs.length} plates, up to ${most} folds (${xs.slice(0, 3).map((x) => x.at).join('; ')}` +
                `${xs.length > 3 ? '; ...' : ''})`;
    if (!on) foldFails.push(`${say}, NONE ON FILE`);
    else if (xs.length > on.plates || most > on.most) foldFails.push(`${say}, WORSE than ${on.plates} plates and ${on.most} on file`);
    else foldNotes.push(`${say}, known`);
  }
  for (const id of Object.keys(FOLDED))
    if (!(folded[id] || []).length) foldFails.push(`${id} NOW CLEAN — take it off the folds on file`);
  console.log(`  folded: ${foldNotes.join('; ') || 'none'}` + (foldFails.length ? `   FAIL: ${foldFails.join('; ')}` : ''));
  bad += foldFails.length;
}

console.log('\nthe other limits, built at their ends:');
{
  const R = G.PLATE_RANGES;
  const at42 = (o) => G.mountLimits(Object.assign({}, G.DEFAULTS, o));
  const split = { drawerW: 168, drawerD: 168, splitMode: 'manual', rowCuts: [2], colCuts: [[2], [2]] };
  const cell = { drawerW: 84, drawerD: 84 };
  const ENDS = [
    ['rim cutoff at its minimum', { ...cell, topCutoff: R.topCutoff.min }],
    ['rim cutoff at its maximum', { ...cell, topCutoff: R.topCutoff.max }],
    ['extra floor at its maximum', { ...cell, bottomPad: R.bottomPad.max }],
    ['dovetail, no clearance', { ...split, connector: 'dovetail', clr: R.connClr.min }],
    ['dovetail, most clearance', { ...split, connector: 'dovetail',
      clr: G.connClrCeiling({ ...G.DEFAULTS, connector: 'dovetail' }).max }],
    ['widest magnet, from below', { ...cell, magnets: true, magnetD: at42({}).magnetD }],
    ['widest magnet, from above', { ...cell, magnets: true, magnetSide: 'top',
      magnetD: at42({ magnetSide: 'top' }).magnetD }],
    ['deepest magnet, from above', { ...cell, magnets: true, magnetSide: 'top', magnetH: R.magnetH.max }],
    ['widest screw and head', { ...cell, screws: true, screwHoleD: at42({}).screwHoleD,
      screwHeadD: at42({}).screwHeadD }],
    ['deepest screw head', { ...cell, screws: true, screwHeadDepth: R.screwHeadDepth.max }],
  ];
  for (const [nm, o] of ENDS) {
    const r = buildAll(o);
    console.log(`  ${nm.padEnd(28)} ${leakText(r)}`);
    if (r.bad) bad++;
  }
  /* A cell's four sites are 2 × holeOffset apart, so past a pitch of about 50 mm it is the
     site beside a pocket, not the cell edge or the socket floor, that stops it. A 1-inch
     magnet from beneath at 55 mm met the pocket beside it and left 52 edges open, with
     Download on. The rule, worked out here rather than read from the engine: a cut stops
     half a MOUNT_WALL short of the line halfway to the one beside it, so its corners stop
     at holeOffset less 0.5 and the wall between two pockets is at least 1 mm. A magnet
     pocket's corners are at the larger of 0.1 over the magnet's radius and
     the radius over cos(π/14) (its flats on the magnet); a screw's bores have their flats
     on its size too, so their corners are its radius over cos(π/12) for the 12-sided shank
     and cos(π/14) for the 14-sided head. At 55 and 60 mm, each way in: the widest the page
     takes has to build watertight, and the first tenth past the rule has to be refused. */
  const reach = G.DEFAULTS.holeOffset - 0.5;
  const corner = { magnetD: (d) => Math.max(d / 2 + 0.1, d / 2 / Math.cos(Math.PI / 14)),
                   screwHoleD: (d) => d / 2 / Math.cos(Math.PI / 12),
                   screwHeadD: (d) => d / 2 / Math.cos(Math.PI / 14) };
  const firstPast = (f) => { let d = 1; while (corner[f](d) <= reach + 1e-9) d = Math.round(d * 10 + 1) / 10; return d; };
  const WIDE = [
    ['magnet from below', { magnets: true }, 'magnetD'],
    ['magnet from above', { magnets: true, magnetSide: 'top' }, 'magnetD'],
    ['screw head', { screws: true, screwHoleD: 3 }, 'screwHeadD'],
    ['screw shank', { screws: true }, 'screwHoleD'],
  ];
  // the shank as wide as the head, so there is no head pocket and the shank is the cut
  const sized = (o, f, d) => ({ ...o, [f]: d, ...(f === 'screwHoleD' ? { screwHeadD: d } : {}) });
  for (const p of [55, 60])
    for (const [nm, o, f] of WIDE) {
      const at = { pitch: p, drawerW: 2 * p, drawerD: 2 * p, ...o };
      const lims = G.mountLimits(designCfg(at)), lim = lims[f];
      const takes = (d) => d <= lim + 1e-9 && (f !== 'screwHoleD' || d <= lims.screwHeadD + 1e-9);
      const widest = buildAll(sized(at, f, lim));
      const past = firstPast(f);
      const over = takes(past) ? buildAll(sized(at, f, past)) : null;
      console.log(`  ${`${nm} at ${p} mm`.padEnd(28)} widest ${lim} mm ${leakText(widest)}; ${past} mm ` +
                  (over ? `TAKEN, and ${leakText(over)}` : 'refused'));
      if (widest.bad) bad++;
      if (over) bad++;
    }
  /* Two shells sharing a cell corner's edge. A pocket's flat, carried across its cell by
     the BSP, crossed the cell's side 0.03 microns from where the corner of the cell beside
     it stands on that side: each shell closed, the corner's edge used four times. The
     magnet built clean on main and not on 0bb9e4d; the screw shank, twice over, on
     neither. A cell now checks the shells built beside it and cuts the pockets again,
     its own or the other's (settle in core.js), so both have to build watertight.
     settle's first way of doing that kept a try that touched fewer shells, and left a
     shell built later sharing an edge no try cleared: 10.1 to 11.1 mm magnets at 47.91,
     48.55, 48.98 and 50.05 mm, clean on main, with 2 or 3 edges used four times on
     d9442d4. It counts the edges shared now, and the two below are two of those, one
     each way in.
     And with the pocket that stands on the magnet's radius, a pocket from above lost a
     sliver of the socket floor by a corner 4.7 microns from one of the floor's spokes:
     11.1 mm at 48.55, 24 open edges on d9442d4. Main's pocket has a corner 1.0 micron
     from the same spoke and none open, so it is how the cut falls, not how near. A cell
     open at the floor's height has its floor fanned again (fanCentre).
     The shank is the pocket it was then, 22.2 mm across its corners: since a screw's
     bores stand their flats on the size asked, that is the shank a 21.44 mm hole cuts. */
  const shank222 = 22.2 * Math.cos(Math.PI / 12);
  for (const [nm, o] of [['21.7 mm magnet at 55 mm', { pitch: 55, magnets: true, magnetD: 21.7 }],
                         ['22.2 mm screw shank at 56.5', { pitch: 56.5, screws: true, screwHoleD: shank222, screwHeadD: shank222 }],
                         ['10.1 mm magnet above, 47.91', { pitch: 47.91, magnets: true, magnetD: 10.1, magnetSide: 'top' }],
                         ['10.6 mm magnet below, 48.98', { pitch: 48.98, magnets: true, magnetD: 10.6 }],
                         ['11.1 mm magnet above, 48.55', { pitch: 48.55, magnets: true, magnetD: 11.1, magnetSide: 'top' }]]) {
    const r = buildAll({ drawerW: 2 * o.pitch, drawerD: 2 * o.pitch, ...o });
    console.log(`  ${nm.padEnd(28)} ${leakText(r)}`);
    if (r.bad) bad++;
  }
  /* A screw head only a hair wider than its shank (#73). The counterbore's 14 flats
     crossed the shank's 12 corners, and here and there a cell leaked by the hundred: on
     main, 2.03 mm over 2 left 196 edges a piece at 37.67 mm; with the flats on the sizes,
     2.046 over 2 left 310 on these four cells and 1.034 over 1 at 42 mm 828. A head is cut
     as a counterbore only once its flats clear the shank's corners, the hole over
     cos(π/12) and 0.01 mm more (MOUNT_BORE in core.js), worked out here rather than read
     from it. Under that it is cut as none: the plate has to be the very one a head no
     wider than the hole builds, to the byte, a thousandth under the line too. The
     narrowest head cut, a thousandth past it, has to build watertight and not be that
     plate. */
  {
    const crypto = require('crypto');
    const digest = (r) => {
      const h = crypto.createHash('sha256');
      for (const polys of r.pieces) h.update(Buffer.from(G.stlBinary(polys, 'p')));
      return h.digest('hex');
    };
    const line = (d) => d / Math.cos(Math.PI / 12) + 0.01;
    const none = new Map();
    for (const [nm, p, d, h, cut] of [
      ['2.03 mm head over 2, 37.67', 37.67, 2, 2.03, false],
      ['2.046 mm head over 2, 37.67', 37.67, 2, 2.046, false],
      ['1.034 mm head over 1, 42', 42, 1, 1.034, false],
      ['just under the line, over 2', 37.67, 2, Math.floor(line(2) * 1000) / 1000, false],
      ['narrowest head over 2', 37.67, 2, Math.ceil(line(2) * 1000) / 1000, true],
    ]) {
      const at = { pitch: p, drawerW: 2 * p, drawerD: 2 * p, connector: 'none', screws: true, screwHoleD: d };
      if (!none.has(`${p} ${d}`)) none.set(`${p} ${d}`, digest(buildAll({ ...at, screwHeadD: d })));
      const r = buildAll({ ...at, screwHeadD: h });
      const same = digest(r) === none.get(`${p} ${d}`);
      console.log(`  ${nm.padEnd(28)} ${h} mm: ${leakText(r)}, ` + (same
        ? (cut ? 'NO COUNTERBORE CUT' : 'cut as no counterbore')
        : (cut ? 'a counterbore' : 'A COUNTERBORE CUT')));
      if (r.bad || same === cut) bad++;
    }
  }
  /* A counterbore with a corner on one of its shank's flats, carried on past the shank
     (#74). The BSP split the magnet pocket's floor along that flat's plane a micron or
     two from the corner, the weld moved the corner onto the split, and its wall left its
     plane: main's 1.0353 mm shank under a 1.0873 head, with a 6 x 2 magnet from above,
     left 136 edges in each of two pieces at 42 mm, and the same bores here, with their
     flats on the sizes, are a 1 mm shank under 1.06 (36 a cell). 4.25 over 4 left 26 and
     3.305 over 3 62; 5.4959 over 3 under an 8 x 3 magnet, a head nearly twice the shank,
     55; and from beneath, the magnet's roof round a counterbore deeper than it, 1.06 over
     1 left 12. The shank is turned off the corners now (MOUNT_BORE.hole.turn). The next
     two are where π/84 alone put a corner of the magnet pocket's on a flat instead (35 and
     25 edges in the socket floor), so the turn keeps those clear too. A magnet's corner on
     a flat calls for the turn as a counterbore's does: 4.9911 under 7.246 at 49.02 mm, no
     counterbore corner near, left 44 unturned. Each has to build closed, with no folds. */
  for (const [nm, o] of [
    ['main\'s 1.0353 under 1.0873, 42', { pitch: 42, drawerW: 168, drawerD: 84, bedW: 100, bedD: 400,
      screwHoleD: 1.0353 * Math.cos(Math.PI / 12), screwHeadD: 1.0873 * Math.cos(Math.PI / 14) }],
    ['1.06 mm head over 1, 42', { screwHoleD: 1, screwHeadD: 1.06 }],
    ['4.25 mm head over 4, 42', { screwHoleD: 4, screwHeadD: 4.25 }],
    ['3.305 mm head over 3, 42', { screwHoleD: 3, screwHeadD: 3.305 }],
    ['5.4959 over 3, 8 x 3 magnet', { screwHoleD: 3, screwHeadD: 5.4959, magnetD: 8, magnetH: 3 }],
    ['1.06 over 1, from beneath', { screwHoleD: 1, screwHeadD: 1.06, magnetSide: 'bottom', screwHeadDepth: 3 }],
    ['4.85 under 7.246, 49.02', { pitch: 49.02, drawerW: 49.02, drawerD: 49.02, screwHoleD: 4.85, screwHeadD: 7.246 }],
    ['5.773 under 12.053, 55', { pitch: 55, drawerW: 55, drawerD: 55, screwHoleD: 5.773, screwHeadD: 12.053 }],
    ['4.9911 under 7.246, 49.02', { pitch: 49.02, drawerW: 49.02, drawerD: 49.02, screwHoleD: 4.9911, screwHeadD: 7.246 }],
  ]) {
    const r = buildAll({ pitch: 42, drawerW: 42, drawerD: 42, connector: 'none', magnets: true,
                         magnetSide: 'top', screws: true, ...o });
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    console.log(`  ${nm.padEnd(30)} ${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}`);
    if (r.bad || folds) bad++;
  }
  /* A shank the magnet pocket does not clear as a counterbore has to, its corners at the
     pocket's flats or through them, is refused (mountLimits' throughMagnet): the walls
     weave, and no turn kept them closed. 5 mm under a 5.4 mm head and a 5.1 mm magnet, its
     corners 4.6 microns outside the pocket's flats, built closed unturned and left 47
     edges turned for the magnet's corners; 3.0177 under 6.557 with a 3 mm magnet at
     43.43 mm, two pieces with a dovetail, left 58 turned for the shank's corners on the
     pocket's flats as well; and 5.8561 under 12.053 with a 6 mm magnet at 55 mm left 116
     unturned (#77). And #77's first case, a magnet from above no wider than the shank
     under it: a 2.2 mm magnet over a 2.4 mm shank at 35.93 mm, loose, left bad edges on
     main (6 open on one cell) with Download on, and the bores here leak at 2.27 to 2.35
     (6 to 19 open) with the magnet's pocket narrower than the shank's corners. The
     magnet's ledge caps the shank at 2.2, so the 2.4 mm shank and a 2.3 that leaks 12
     built anyway are refused. Each is refused, by the magnet's pocket, and builds closed at
     the widest shank taken. */
  for (const [nm, o] of [
    ['5 under 5.4, 5.1 mm magnet', { screwHoleD: 5, screwHeadD: 5.4, magnetD: 5.1 }],
    ['3.0177 under 6.557, 43.43', { pitch: 43.43, drawerW: 86.86, drawerD: 43.43, bedW: 55.43, bedD: 400,
      connector: 'dovetail', screwHoleD: 3.0177, screwHeadD: 6.557, screwHeadDepth: 1.5, magnetD: 3, magnetH: 1.5 }],
    ['5.8561 under 12.053, 55', { pitch: 55, drawerW: 55, drawerD: 55, screwHoleD: 5.8561, screwHeadD: 12.053 }],
    ['2.4 under a 2.2 mm magnet, 35.93', { pitch: 35.93, drawerW: 35.93, drawerD: 35.93, tolerance: 'loose',
      magnetD: 2.2, screwHoleD: 2.4 }],
    ['2.3 under a 2.2 mm magnet, 35.93', { pitch: 35.93, drawerW: 35.93, drawerD: 35.93, tolerance: 'loose',
      magnetD: 2.2, screwHoleD: 2.3 }],
  ]) {
    const at = { pitch: 42, drawerW: 42, drawerD: 42, connector: 'none', magnets: true, magnetSide: 'top',
                 screws: true, ...o };
    const cfg = designCfg(at), lim = G.mountLimits(cfg, G.computeLayout(cfg));
    const refused = at.screwHoleD > lim.screwHoleD && lim.throughMagnet;
    const r = buildAll({ ...at, screwHoleD: lim.screwHoleD });
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    console.log(`  ${nm.padEnd(30)} ${refused ? `refused, by the magnet's pocket, over ${lim.screwHoleD} mm`
      : `TAKEN up to ${lim.screwHoleD} mm`}; at that, ${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}`);
    if (!refused || r.bad || folds) bad++;
  }
  /* A counterbore whose corners come within 0.05 mm of the magnet pocket's, and that
     reaches the pocket. Both are 14-gons on the same rays, and where one stopped inside
     the other a hair off it they left a ring that thin. The default 6 mm head's corners
     stand 0.022 mm inside the 6 mm magnet's, and 3 mm deep under the 6 x 2 magnet from
     beneath it left 6 edges open at 42 mm; a 6.39 mm head 2 deep broke into a 6.35 x 2
     magnet pocket from above at 44.46 mm, its corners 0.0018 mm out, and left 248 over
     two pieces. Main built both closed. Such a counterbore is cut at the pocket's corners
     now, one prism with it (MOUNT_BORE.head.cut). The shank's turn goes by the counterbore
     as cut: turned for the 6.02 mm head's corners while it was cut at the magnet's, 3.66
     under it left 9. And unioned rather than one prism, the two split their shared walls
     at the pocket's roof, and the jigsaw at 41.76 mm folded twice there. #77's second
     case is the same pair of walls: a 6.04 mm head 3 deep under the 6 x 2 magnet at 42
     mm left 6 edges open, and 6.048 folded 5 faces, before the band; with it off
     (MOUNT_BORE.head.snap set to 0) both leave 12 open here. And a 10.54 mm head over a
     10.28 mm magnet at 40 mm, tight, which the issue counted at 435 edges on main, leaves
     69 and 126 open on main over a 2 x 2 piece with the counterbore 2 and 3 deep. The
     flats stand on the sizes here, which puts those two bores 0.2 mm apart, so the last
     two rows build closed with or without the band, and fail on main. Each is a size the
     page takes, and has to build closed, with no folds. */
  for (const [nm, o] of [
    ['3 under 6, 3 deep, 42', { screwHeadDepth: 3 }],
    ['4.24 under 6.39, above, 44.46', { pitch: 44.46, drawerW: 88.92, drawerD: 44.46, bedW: 56.46, connector: 'dovetail',
      magnetD: 6.35, magnetSide: 'top', screwHoleD: 4.24, screwHeadD: 6.39 }],
    ['3.66 under 6.02, 3 deep, 42', { screwHoleD: 3.66, screwHeadD: 6.02, screwHeadDepth: 3 }],
    ['41.76 mm jigsaw, 3.742 deep', { pitch: 41.76, drawerW: 83.52, drawerD: 41.76, bedW: 53.76, connector: 'puzzle',
      screwHoleD: 3.32, screwHeadD: 5.973, screwHeadDepth: 3.742 }],
    ['6.04 under the 6 x 2 magnet, 3 deep', { screwHeadD: 6.04, screwHeadDepth: 3 }],
    ['6.048 under the 6 x 2 magnet, 3 deep', { screwHeadD: 6.048, screwHeadDepth: 3 }],
    ['10.54 over 10.28 x 2, 3 deep, 40', { pitch: 40, drawerW: 80, drawerD: 80, tolerance: 'tight', magnetD: 10.28,
      screwHeadD: 10.54, screwHeadDepth: 3 }],
    ['10.54 over 10.28 x 2, 2 deep, 40', { pitch: 40, drawerW: 80, drawerD: 80, tolerance: 'tight', magnetD: 10.28,
      screwHeadD: 10.54, screwHeadDepth: 2 }],
  ]) {
    const at = { pitch: 42, drawerW: 42, drawerD: 42, connector: 'none', magnets: true, screws: true, ...o };
    const cfg = designCfg(at), lim = G.mountLimits(cfg, G.computeLayout(cfg));
    const taken = ['magnetD', 'screwHoleD', 'screwHeadD'].every((f) => cfg[f] <= lim[f] + 1e-9 &&
      !lim.gaps[f].some(([a, b]) => cfg[f] >= a - 1e-9 && cfg[f] <= b + 1e-9));
    const r = buildAll(at);
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    console.log(`  ${nm.padEnd(30)} ${taken ? '' : 'REFUSED, '}${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}`);
    if (!taken || r.bad || folds) bad++;
  }
  /* A bare magnet pocket, with no counterbore cut, whose corner stands on a flat of the
     shank carried on past it. The BSP splits the pocket's roof or floor along that plane
     as it does round a counterbore (#74), and the plate leaks. From beneath, where the
     pocket holds the counterbore whole: a 4.18 mm shank under a 5 mm magnet and a 5.12 mm
     head, a corner 0.002 mm off a flat, left 12 edges open at 42 mm, 24 with a 5 x 3
     magnet over two cells, and 51 under a 5.08 head at 41.14 mm; 1.96 under 4.16 with a
     4 x 1.5 magnet folded 12 times; and 6.689 under an 8.068 head in an 8.11 x 3 magnet's
     pocket left 12 at 52.26 mm. From above, under heads too narrow to cut a counterbore:
     4.18 under a 5 x 2 magnet left 30, 3.296 under a 6 x 3 one 16, and 7.268 under a
     7.734 x 2.5 one 84 over a 2 x 2 piece. The first four came with the counterbore cut
     at the pocket's corners, which the pocket from beneath then holds whole and which so
     no longer turned the shank; the other four leaked before it as well. The shank is
     turned for the pocket's corners alone now (MOUNT_BORE.screw), and main, whose bores
     stand elsewhere, builds every one of them closed. Each is a size the page takes, and
     has to build closed, with no folds. */
  for (const [nm, o] of [
    ['4.18 under 5.12, 5 x 2 below, 42', { bedW: 52, magnetD: 5, screwHoleD: 4.18, screwHeadD: 5.12 }],
    ['4.18 under 5.12, 5 x 3 below, 84 x 42', { drawerW: 84, tolerance: 'tight', magnetD: 5, magnetH: 3,
      screwHoleD: 4.18, screwHeadD: 5.12, screwHeadDepth: 3 }],
    ['4.18 under 5.08, 5 x 2 below, 41.14', { pitch: 41.14, drawerW: 82.28, drawerD: 82.28, magnetD: 5,
      screwHoleD: 4.18, screwHeadD: 5.08 }],
    ['1.96 under 4.16, 4 x 1.5 below, 42', { drawerW: 84, drawerD: 84, magnetD: 4, magnetH: 1.5,
      screwHoleD: 1.96, screwHeadD: 4.16, screwHeadDepth: 1 }],
    ['6.689 under 8.068, 8.11 x 3 below', { pitch: 52.26, drawerW: 52.26, drawerD: 52.26, tolerance: 'loose',
      magnetD: 8.11, magnetH: 3, screwHoleD: 6.689, screwHeadD: 8.068, screwHeadDepth: 2.747 }],
    ['4.18 bare, 5 x 2 above, 42', { magnetD: 5, magnetSide: 'top', screwHoleD: 4.18, screwHeadD: 4.19,
      screwHeadDepth: 1 }],
    ['3.296 bare, 6 x 3 above, 42', { tolerance: 'tight', magnetD: 6, magnetH: 3, magnetSide: 'top',
      screwHoleD: 3.296, screwHeadD: 3.335, screwHeadDepth: 2.026 }],
    ['7.268 bare, 7.734 x 2.5 above, 2 x 2', { drawerW: 84, drawerD: 84, magnetD: 7.734, magnetH: 2.5,
      magnetSide: 'top', screwHoleD: 7.268, screwHeadD: 7.365, screwHeadDepth: 2.66 }],
  ]) {
    const at = { pitch: 42, drawerW: 42, drawerD: 42, connector: 'none', magnets: true, screws: true, ...o };
    const cfg = designCfg(at), lim = G.mountLimits(cfg, G.computeLayout(cfg));
    const taken = ['magnetD', 'screwHoleD', 'screwHeadD'].every((f) => cfg[f] <= lim[f] + 1e-9 &&
      !lim.gaps[f].some(([a, b]) => cfg[f] > a + 1e-9 && cfg[f] < b - 1e-9));
    const r = buildAll(at);
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    console.log(`  ${nm.padEnd(38)} ${taken ? '' : 'REFUSED, '}${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}`);
    if (!taken || r.bad || folds) bad++;
  }
  /* A bore nearly as wide as the magnet pocket it opens into, where the two stand on the
     bottom face (#92). That face is a fan held clear of every point where the mounting
     cutters' walls stand on it (fanCentre), and where a counterbore or a shank was unioned
     with a pocket it nearly fills, the BSP split each wall along the other's planes all
     round: 140 points in a cell where the corners are 56. No point fanCentre tries was
     clear of all of them, so the fan stayed at the cell's middle, a spoke a few microns
     from a corner of a pocket, and the sliver of the face between them went: 6 to 12 open
     edges a cell at 42 mm with Download on, where the magnet alone builds closed. A 6 x 2
     magnet from beneath over a 3 mm hole 3 deep at three heads; the 4.16 x 2 magnet over a
     2.58 mm shank under a 4.34 mm head; a bare 2.98 mm shank under a 3 x 2 magnet from
     above at 46 mm; and four of the round sizes the issue typed. A cell open at the bottom
     face's height has that face fanned again clear of the corners alone now (buildPiece).
     Each is a size the page takes, and has to build closed, with no folds. */
  for (const [nm, o] of [
    ['6 x 2 below, 3 under 4, 3 deep', { screwHeadD: 4, screwHeadDepth: 3 }],
    ['6 x 2 below, 3 under 5.53, 3 deep', { screwHeadD: 5.53, screwHeadDepth: 3 }],
    ['6 x 2 below, 3 under 5.93, 3 deep', { screwHeadD: 5.93, screwHeadDepth: 3 }],
    ['4.16 x 2 below, 2.58 under 4.34', { magnetD: 4.16, screwHoleD: 2.58, screwHeadD: 4.34 }],
    ['3 x 2 above, 2.98 bare, 46', { pitch: 46, drawerW: 46, drawerD: 46, magnetD: 3, magnetSide: 'top',
      screwHoleD: 2.98, screwHeadD: 2.98 }],
    ['4 x 1.5 above, 2.5 under 6.05, 1.5 deep', { magnetD: 4, magnetH: 1.5, magnetSide: 'top', screwHoleD: 2.5,
      screwHeadD: 6.05, screwHeadDepth: 1.5 }],
    ['6 x 1.5 below, 3.5 under 4.75', { magnetH: 1.5, screwHoleD: 3.5, screwHeadD: 4.75 }],
    ['3 x 3 above, 2.5 under 4.25, 1 deep', { magnetD: 3, magnetH: 3, magnetSide: 'top', screwHoleD: 2.5,
      screwHeadD: 4.25, screwHeadDepth: 1 }],
    ['6 x 3 below, 2 under 4.9, 4 deep', { magnetH: 3, screwHoleD: 2, screwHeadD: 4.9, screwHeadDepth: 4 }],
  ]) {
    const at = { pitch: 42, drawerW: 42, drawerD: 42, connector: 'none', magnets: true, screws: true, ...o };
    const cfg = designCfg(at), lim = G.mountLimits(cfg, G.computeLayout(cfg));
    const taken = ['magnetD', 'screwHoleD', 'screwHeadD'].every((f) => cfg[f] <= lim[f] + 1e-9 &&
      !lim.gaps[f].some(([a, b]) => cfg[f] >= a - 1e-9 && cfg[f] <= b + 1e-9));
    const r = buildAll(at);
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    console.log(`  ${nm.padEnd(38)} ${taken ? '' : 'REFUSED, '}${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}`);
    if (!taken || r.bad || folds) bad++;
  }
  /* A counterbore's corner on the plane of one of the magnet pocket's flats. The two are
     14-gons on the same rays, so a corner of one stands an odd multiple of π/14 off a
     normal of the other's flats, and at some sizes that puts it on the flat's plane
     carried on past the pocket. The BSP splits the counterbore along that plane a few
     thousandths from the corner, and the strip came out folded back on itself: the head
     at its cap, 13.6 mm at 42 mm, under the default 6 x 2 magnet from above, its corner
     0.004 mm off the pocket's flat at 5π/14, folded 8 times a cell 1.5 deep and 14 at 1,
     38 over 2 x 2, 54 over 3 x 2 in two and 160, 120, 128 and 96 over the default plate's
     four pieces; from beneath, 3 deep, 2. Each is a fold as checkOrientation counts one,
     two faces with area back to back in the mesh. The head at its cap folded the same way
     at 40, 43, 44 and 46 mm, each with the one magnet that puts its corner there. Main, its
     corners on the size, builds these closed (it has the same at 13.95 mm). The
     counterbore is turned half a facet, π/14, off the pocket now (MOUNT_BORE.head.turn),
     its corners midway between the pocket's. Two rows hold it to more than a little:
     turned π/126, the 6.47 x 2 magnet under the head at its cap at 43 mm came out with 2
     bad edges and a face turned over, and a 4.844 head held whole in a 6 x 3 pocket from
     beneath, a corner of the pocket 0.002 mm off the plane of one of the counterbore's
     flats, left 12 edges open a cell, where unturned it left 6 and main none. The plates
     of several cells are here so that one cell cannot pass for them. Turned π/252, a
     13.582 head 0.251 deep under a 6 x 3 magnet from above left 12 edges open a cell, 48
     over 2 x 2. The last five were found among designs drawn near the bound a turn is
     taken from, 0.01 mm now (head.turn and hole.turn), and main builds each closed. The
     38.97 mm cell, a corner 0.006 mm off a plane, folded 3 times unturned with the bound
     at 0.005; on the tile π/252 left a counterbore's corner 0.00502 mm off a shank's flat,
     the shank unturned, and 15 edges open; and the other three, turned at either bound,
     π/252 left open by 3 and 12 edges and with two shells touching along 8, split by its
     planes away from the corners. The last two are a counterbore turned half a facet
     whose two flats stand square to the cell's x edges: the BSP split one into a strip
     3.3 microns wide that came out folded, 3 times a cell at 45.16 mm with a dovetail and
     at 44 mm on one cell, where main builds both closed, until a cell whose pockets come
     out with a face turned over was cut again (the fastener cut in buildPiece). Each is a
     size the page takes, and has to build closed, with no folds. */
  for (const [nm, o, tile] of [
    ['13.6 head, 6 x 2 above, 42, 1.5 deep', { magnetSide: 'top', screwHeadD: 13.6, screwHeadDepth: 1.5 }],
    ['13.6 head, 6 x 2 above, 42, 1 deep', { magnetSide: 'top', screwHeadD: 13.6, screwHeadDepth: 1 }],
    ['13.6 head, 6 x 2 below, 42, 3 deep', { screwHeadD: 13.6, screwHeadDepth: 3 }],
    ['11.6 head, 5.09 x 2 above, 40', { pitch: 40, drawerW: 40, drawerD: 40, magnetD: 5.09, magnetSide: 'top',
      screwHeadD: 11.6, screwHeadDepth: 1.5 }],
    ['14.6 head, 6.46 x 2 above, 43', { pitch: 43, drawerW: 43, drawerD: 43, magnetD: 6.46, magnetSide: 'top',
      screwHeadD: 14.6, screwHeadDepth: 1.5 }],
    ['15.5 head, 6.87 x 2 above, 44', { pitch: 44, drawerW: 44, drawerD: 44, magnetD: 6.87, magnetSide: 'top',
      screwHeadD: 15.5, screwHeadDepth: 1.5 }],
    ['17.5 head, 7.78 x 2 above, 46', { pitch: 46, drawerW: 46, drawerD: 46, magnetD: 7.78, magnetSide: 'top',
      screwHeadD: 17.5, screwHeadDepth: 1 }],
    ['14.6 head, 6.47 x 2 above, 43, 1 deep', { pitch: 43, drawerW: 43, drawerD: 43, magnetD: 6.47,
      magnetSide: 'top', screwHeadD: 14.6, screwHeadDepth: 1 }],
    ['4.844 head in a 6 x 3 pocket below, 42', { magnetD: 6, magnetH: 3, screwHoleD: 3.48, screwHeadD: 4.844,
      screwHeadDepth: 3.408 }],
    ['13.6 head, 6 x 2 above, 1.5 deep, 2 x 2', { drawerW: 84, drawerD: 84, magnetSide: 'top', screwHeadD: 13.6,
      screwHeadDepth: 1.5 }],
    ['13.6 head, 6 x 2 above, 1.5, 3 x 2 in two', { drawerW: 126, drawerD: 84, bedW: 96, magnetSide: 'top',
      screwHeadD: 13.6, screwHeadDepth: 1.5 }],
    ['the default plate, 13.6 head, 6 x 2 above', { drawerW: 306, drawerD: 380, marginMode: 'auto',
      splitMode: 'balanced', magnetSide: 'top', screwHeadD: 13.6, screwHeadDepth: 1.5 }],
    ['13.582 head, 6 x 3 above, 42, 2 x 2', { drawerW: 84, drawerD: 84, magnetD: 6, magnetH: 3, magnetSide: 'top',
      screwHoleD: 3.613, screwHeadD: 13.582, screwHeadDepth: 0.251 }],
    ['3.24 head, 3.96 x 1.5 above, 38.97', { pitch: 38.97, drawerW: 38.97, drawerD: 38.97, magnetD: 3.96,
      magnetH: 1.5, magnetSide: 'top', screwHoleD: 2.34, screwHeadD: 3.24, screwHeadDepth: 2.5 }],
    ['tile at 53.72, 1.82 head, 4 x 2 above', { pitch: 53.72, drawerW: 53.72, drawerD: 53.72, tolerance: 'tight',
      magnetD: 4, magnetSide: 'top', screwHoleD: 1.21, screwHeadD: 1.82, screwHeadDepth: 1 }, true],
    ['2.69 head, 6 x 1.5 below, 42, tight', { tolerance: 'tight', magnetD: 6, magnetH: 1.5, screwHoleD: 1.41,
      screwHeadD: 2.69, screwHeadDepth: 2 }],
    ['13.26 head, 5.85 x 1.5 below, 84 x 42', { drawerW: 84, tolerance: 'tight', magnetD: 5.85, magnetH: 1.5,
      screwHoleD: 1.06, screwHeadD: 13.26, screwHeadDepth: 3 }],
    ['5.65 head, 4.44 x 3 below, 42', { magnetD: 4.44, magnetH: 3, screwHoleD: 2.43, screwHeadD: 5.65,
      screwHeadDepth: 3 }],
    ['3.89 head, 3 x 2 above, 45.16, dovetail', { pitch: 45.16, drawerW: 90.32, drawerD: 45.16, bedW: 57.16,
      connector: 'dovetail', magnetD: 3, magnetSide: 'top', screwHoleD: 1.01, screwHeadD: 3.89, screwHeadDepth: 1 }],
    ['3.89 head, 3 x 2 above, 44', { pitch: 44, drawerW: 44, drawerD: 44, magnetD: 3, magnetSide: 'top',
      screwHoleD: 1.01, screwHeadD: 3.89, screwHeadDepth: 1 }],
  ]) {
    const at = { pitch: 42, drawerW: 42, drawerD: 42, connector: 'none', magnets: true, screws: true, ...o };
    const cfg = designCfg(at), lim = G.mountLimits(cfg, G.computeLayout(cfg));
    const taken = ['magnetD', 'screwHoleD', 'screwHeadD'].every((f) => cfg[f] <= lim[f] + 1e-9 &&
      !lim.gaps[f].some(([a, b]) => cfg[f] > a + 1e-9 && cfg[f] < b - 1e-9));
    const r = buildAll(at, tile);
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    console.log(`  ${nm.padEnd(41)} ${taken ? '' : 'REFUSED, '}${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}`);
    if (!taken || r.bad || folds) bad++;
  }
  /* A pocket against a joint's cut in the floor (#64). A bowtie housed in the floor at
     42 mm, with magnets from beneath, built 12 bad edges at 7.9 mm and 19 at 10 with
     Download on: the pocket reached the key's recess, and with both ceilings 2 mm up the
     two shared a face. mountLimits keeps every mounting cut out of a joint's cut now,
     measured on the layout, so each case is built at the widest the page takes, which
     has to come out watertight, and the first tenth past it, and a size main took that
     reaches the cut (the first that leaked, where one did), have to be refused. Two
     pieces side by side, so the seam between them is cut. The bands are #61's, where its
     wider pocket brought the leak 0.1 to 0.4 mm lower. From above, an 8 mm magnet's
     pocket breaks into the recess under it without a bad edge, the magnet itself about
     0.13 mm clear of the key: refused all the same, as every pocket that breaks into a
     key's recess is (see mountLimits). In the wall, main's widest leaked. The 38.13 mm link is
     the one #61 left for later: its 6.5 mm counterbore stood 0.7 mm into a puzzle key's
     recess. The last two are the spec's 6.5 × 2.4 magnet beside a tab, whose notch stops
     2.4 mm up as well. And the same bowtie in four pieces with strips of half cells and
     margins round them, whose whole cells are the ones measured. */
  const pair = (p, o) => ({ pitch: p, drawerW: 4 * p, drawerD: 2 * p, bedW: 2 * p + 16, bedD: 400, ...o });
  const JOINTED = [   // [what, design, field, a size main took into the cut]
    ['bowtie, magnet below, 42', pair(42, { connector: 'bowtie', magnets: true }), 'magnetD', 7.9],
    ['bowtie, magnet above, 42', pair(42, { connector: 'bowtie', magnets: true, magnetSide: 'top' }), 'magnetD', 8],
    ['bowtie, screw head, 42', pair(42, { connector: 'bowtie', screws: true }), 'screwHeadD', 8.2],
    ['snap, magnet below, 49.02', pair(49.02, { connector: 'snap', magnets: true }), 'magnetD', 17.2],
    ['puzzle key, below, 46', pair(46, { connector: 'puzzlekey', magnets: true }), 'magnetD', 16],
    ['puzzle key, below, 49.02', pair(49.02, { connector: 'puzzlekey', magnets: true }), 'magnetD', 20.2],
    ['bowtie in the wall, 44.17', pair(44.17, { connector: 'bowtie', keyMount: 'wall', magnets: true }), 'magnetD', 15.7],
    ['38.13 mm link, counterbore', { drawerW: 134.56, drawerD: 120.48, mLeft: 11.96, mRight: 8.21, mFront: 5.39,
      mBack: 0.7, bedW: 67.2, bedD: 86.26, connector: 'puzzlekey', clr: 0.2, screws: true, screwHoleD: 3,
      screwHeadD: 6.5, pitch: 38.13, outerRadius: 3.49, topCutoff: 1 }, 'screwHeadD', 6.5],
    ['puzzle tabs, 2.4 deep, 38', pair(38, { connector: 'puzzle', magnets: true, magnetH: 2.4 }), 'magnetD', 6.5],
    ['dovetail, 2.4 deep, 36', pair(36, { connector: 'dovetail', magnets: true, magnetH: 2.4 }), 'magnetD', 6.5],
    ['bowtie, half cells, 42', { pitch: 42, drawerW: 199, drawerD: 199, marginMode: 'half', bedW: 120, bedD: 120,
      connector: 'bowtie', magnets: true }, 'magnetD', 7.9],
  ];
  for (const [nm, o, f, into] of JOINTED) {
    const cfg = designCfg(o);
    const lims = G.mountLimits(cfg, G.computeLayout(cfg)), lim = lims[f];
    const takes = (d) => d <= lim + 1e-9;
    const widest = buildAll(sized(o, f, lim));
    const past = Math.round(lim * 10 + 1) / 10;
    const taken = [past, into].filter(takes)
      .map((d) => `${d} mm TAKEN, and ${leakText(buildAll(sized(o, f, d)))}`);
    console.log(`  ${nm.padEnd(28)} widest ${lim} mm ${leakText(widest)}; ` +
                (taken.join('; ') || `${past} and ${into} mm refused`));
    if (widest.bad) bad++;
    bad += taken.length;
  }
  /* What a pocket may and may not do in a joint's cut, by size, each with the reason
     mountLimits gives (false where it takes the size). A dovetail's notch takes a pocket
     from beneath that breaks into it, unless the two ceilings are level or the magnet
     reaches the tab: the half-inch magnet on the page's default design at 42 mm, 2 and
     3 mm thick, has to be taken and come out watertight; 2.4 thick, level with the
     notch, it built 96 bad edges and has to be refused, but 2.45 thick, as far off level
     as 2.35, is taken; and 13.2 mm, 2 thick, builds clean but would touch the tab. At
     36 mm a 5.6 mm magnet's pocket would stand right on the notch's wall, under
     MOUNT_SEAM from it, so it is refused there (a gap), and 5.65 and 5.7, which break in,
     are taken. Any other cut takes none: the snap clip at 36.52 mm
     is the review's, a 1.5 mm magnet at a fit clearance of 0.5 whose pocket is only
     0.019 mm into the recess, and main built it with 6 bad edges at 2.5 mm deep (and at
     1.9, 2.1 and 2.4). The refused ones are built too, to show what main would have, but
     only the reason is held to. */
  const PAGE = { marginMode: 'auto', connector: 'dovetail', magnets: true };
  const SNAP = { pitch: 36.52, drawerW: 73.04, drawerD: 73.04, bedW: 52.52, bedD: 400, splitMode: 'balanced',
                 connector: 'snap', keyMount: 'floor', keyInsert: 'bottom', tolerance: 'tight', clr: 0.5,
                 magnets: true, magnetH: 2.5, screws: true, screwHoleD: 1.6, screwHeadD: 1.6, screwHeadDepth: 2 };
  for (const [nm, o, f, d, why] of [
    ['dovetail, 12.7 x 2, page', { ...PAGE, magnetH: 2 }, 'magnetD', 12.7, false],
    ['dovetail, 12.7 x 3, page', { ...PAGE, magnetH: 3 }, 'magnetD', 12.7, false],
    ['dovetail, 12.7 x 2.4, page', { ...PAGE, magnetH: 2.4 }, 'magnetD', 12.7, 'level'],
    ['dovetail, 12.7 x 2.45, page', { ...PAGE, magnetH: 2.45 }, 'magnetD', 12.7, false],
    ['dovetail, 13.2 x 2, page', { ...PAGE, magnetH: 2 }, 'magnetD', 13.2, 'part'],
    ['dovetail, 5.6 x 2, page, 36', { ...PAGE, pitch: 36, magnetH: 2 }, 'magnetD', 5.6, 'gap'],
    ['dovetail, 5.65 x 2, page, 36', { ...PAGE, pitch: 36, magnetH: 2 }, 'magnetD', 5.65, false],
    ['dovetail, 5.7 x 2, page, 36', { ...PAGE, pitch: 36, magnetH: 2 }, 'magnetD', 5.7, false],
    ['snap, 1.5 x 2.5, 36.52', SNAP, 'magnetD', 1.5, 'cut']]) {
    const cfg = designCfg(sized(o, f, d));
    const lims = G.mountLimits(cfg, G.computeLayout(cfg));
    const r = buildAll(sized(o, f, d));
    const refused = d > lims[f] ? lims.joint[f] : lims.gaps[f].some(([a, b]) => d > a && d < b) && 'gap';
    const holds = why ? refused === why : !refused && !r.bad;
    console.log(`  ${nm.padEnd(28)} ${refused ? `refused (${refused}), would build` : 'taken,'} ` +
                `${leakText(r)}${holds ? '' : `   FAIL: ${why ? `has to be refused as ${why}` : 'has to be taken watertight'}`}`);
    if (!holds) bad++;
  }
  /* A counterbore's floor fan (#61's round 4). Where a 4.8 mm head was unioned with its
     2.4 mm shank, the shank's flats came back split at the head's planes, and the socket
     floor's fan was held clear of those split points as well as the corners: no point
     fanCentre tried was clear of all of them, so the fan stayed put and the cell shipped
     with 6 open edges, no warning. Only the corners count now. */
  {
    const r = buildAll({ pitch: 44.08, drawerW: 137.49, drawerD: 91.53, mLeft: 1.96, mRight: 3.29, mFront: 0.58,
                         mBack: 2.79, bedW: 400, bedD: 400, connector: 'none', tolerance: 'loose',
                         screws: true, screwHoleD: 2.4, screwHeadD: 4.8, screwHeadDepth: 2 });
    console.log(`  ${'counterbore at 44.08 mm'.padEnd(28)} ${leakText(r)}`);
    if (r.bad) bad++;
  }
  /* A pocket's planes beside a housing put in from above, over a solid floor (#85).
     Nothing of the pocket reaches an H-clip's cup or a snap clip's slot there, 2.2 and
     2.1 mm of floor between them at 34.5 mm, but its planes split the cell's faces, and
     the repair can leave a split a few microns off its face, which the housing, cut
     afterwards, crosses. A 6.3 mm magnet from beneath at 34.5 mm, the field's cap, left
     4 edges open in A1 with an H-clip from above and 3 with a snap clip in the wall,
     with Download on: the page's links, so with the clearances cut from the field. A
     6.25 mm magnet at 37.5 mm, well under its 9.2 mm cap, left 14. Such a cell has its
     pockets cut again now (the top-insert pass in buildPiece). Each has to be taken by
     the field and build watertight, with nothing folded, and so does the H-clip at its
     42 mm cap, which always did. */
  for (const [nm, o, d] of [
    ['H-clip above, 6.3 magnet, 34.5', pair(34.5, { connector: 'hclip', keyInsert: 'top' }), 6.3],
    ['snap clip above, 6.3 magnet, 34.5', pair(34.5, { connector: 'snap', keyMount: 'wall', keyInsert: 'top' }), 6.3],
    ['H-clip above, 6.25 magnet, 37.5', pair(37.5, { connector: 'hclip', keyInsert: 'top' }), 6.25],
    ['H-clip above, 13.6 magnet, 42', pair(42, { connector: 'hclip', keyInsert: 'top' }), 13.6]]) {
    const at = { ...o, clr: 0.2, magnets: true, magnetD: d };
    const cfg = designCfg(at);
    const taken = d <= G.mountLimits(cfg, G.computeLayout(cfg)).magnetD + 1e-9;
    const r = buildAll(at);
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    console.log(`  ${nm.padEnd(34)} ${taken ? '' : 'REFUSED, '}${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}`);
    if (!taken || r.bad || folds) bad++;
  }
  /* The clearance one step past its end, which leaked, and that was why the end is where
     it is. The joint's cut taken again when it comes out open (cutAgain in core.js)
     closed it at 42 mm, so it waited on a sweep; the sweep connClrCeiling describes found
     0.35 open still at 42.35 mm, on two of the four pieces, so the cap is earned. It has
     to leak still, or the cap can go up, and the field has to go on refusing it. */
  const past = buildAll({ pitch: 42.35, ...PIECE_LAYOUTS['2x2 pieces'](42.35), connector: 'dovetail', clr: 0.35 });
  const capped = 0.35 > G.connClrCeiling({ ...G.DEFAULTS, connector: 'dovetail' }).max + 1e-9;
  console.log(`  ${'dovetail, 0.35 at 42.35 mm'.padEnd(28)} ${leakText(past)}` +
              (!capped ? '   THE FIELD TAKES IT' : !past.bad ? '   NOW CLEAN — the cap can go up'
                : ' — the cap is earned'));
  if (!capped || !past.bad) bad++;

  /* A corner boss is 2.6 mm tall and does not grow, so the pocket in it is capped — at
     what leaves a layer over it, which takes the spec's 6.5 × 2.4 magnet. Built at every
     depth from where the boss stops growing with the pocket up to that cap, each way a
     pocket can be cut, on one cell so the bosses' own abutting (quarantined above)
     stays out of it. */
  const cap = at42({ baseMode: 'bosses' }).depth;
  const holds = cap >= 2.4 && 2.6 - cap >= G.PRINT_LAYER - 1e-9;
  const POCKET = {
    'magnet below': (d) => ({ magnets: true, magnetH: d }),
    'magnet above': (d) => ({ magnets: true, magnetH: d, magnetSide: 'top' }),
    'screw head': (d) => ({ screws: true, screwHeadDepth: d }),
    'magnet and screw': (d) => ({ magnets: true, screws: true, magnetH: d, screwHeadDepth: d }),
  };
  const depths = [R.magnetH.min];
  for (let d = 1.5; d <= cap + 1e-9; d += 0.1) depths.push(Math.round(d * 10) / 10);
  const open = [];
  for (const [pn, mk] of Object.entries(POCKET))
    for (const d of depths) {
      const r = buildAll({ drawerW: 42, drawerD: 42, baseMode: 'bosses', ...mk(d) });
      if (r.bad) open.push(`${pn} ${d}: ${leakText(r)}`);
    }
  console.log(`  corner pockets up to ${cap} mm deep: ${depths.length * 4} builds, ` +
              (open.length ? `LEAKING: ${open.join('; ')}` : 'all watertight') +
              (holds ? '' : `   THE CAP ${cap} DOES NOT TAKE A 2.4 MM MAGNET UNDER A LAYER`));
  bad += open.length + (holds ? 0 : 1);
}

/* Corner bosses beside a joint cut from beneath (#70). A boss stands where four cells
   meet, and so does a wall key's recess, an H-clip's, and the notch a dovetail's or a
   puzzle's tab goes into from the next piece. The joint was cut from the cells and not
   from the bosses, so they stood in the whole of each housing and nothing could go in,
   with Download on: a housing filled in is watertight, and the bosses' own edges were
   there already. And a joint that houses itself in a floor, keys at 2.8 mm and the
   puzzle's lobes at 2.6, stood that floor round the 2.6 mm bosses and sealed their
   pockets in it, as an extra floor did.
 *
   So each is built two pieces side by side at 42 mm, with magnets from beneath, from
   above and screws, and read along vertical lines 0.3 mm apart. The housing is what the
   joint takes out of the plate without its mountings (solid with no joint, empty with
   one), and none of it may be solid with the bosses on, and solid 5 microns round: a
   boss's cut stands two NUDGEs off the cell's (see buildPiece), and the sliver of boss
   that leaves in a housing, 3.4 microns thick, is not a fill. Every pocket has to be empty
   from its mouth to its floor. And the edges two bosses share where they meet, used four
   times (quarantined above), may not be more than the same plate has with no joint. */
// along a vertical line, the faces above a height, each counted by which way it faces,
// add up to how many shells that height is inside
function columns(polys) {
  const cells = new Map(), key = (i, j) => i * 100003 + j;
  for (const t of G.polysToTriangles(polys)) {
    const xs = t.map((v) => v[0]), ys = t.map((v) => v[1]);
    for (let i = Math.floor(Math.min(...xs)); i <= Math.floor(Math.max(...xs)); i++)
      for (let j = Math.floor(Math.min(...ys)); j <= Math.floor(Math.max(...ys)); j++) {
        if (!cells.has(key(i, j))) cells.set(key(i, j), []);
        cells.get(key(i, j)).push(t);
      }
  }
  return (x, y) => {
    const cross = [];
    for (const [a, b, c] of cells.get(key(Math.floor(x), Math.floor(y))) || []) {
      const n = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(n) < 1e-12) continue;
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
      if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
      cross.push([l1 * a[2] + l2 * b[2] + (1 - l1 - l2) * c[2], Math.sign(n)]);
    }
    return (z) => cross.reduce((w, [zc, s]) => zc > z ? w + s : w, 0);
  };
}
console.log('\ncorner bosses beside a joint cut from beneath:');
{
  const h = 0.3, dz = 0.1;
  const zs = Array.from({ length: 40 }, (_, k) => (k + 0.5) * dz);
  const at = { pitch: 42, drawerW: 168, drawerD: 84, bedW: 100, bedD: 400 };
  const JOINTS = [
    ['keys in the floor', { connector: 'bowtie' }],
    ['keys in the wall', { connector: 'bowtie', keyMount: 'wall' }],
    ['H-clip', { connector: 'hclip' }],
    ['dovetail', { connector: 'dovetail' }],
    ['puzzle tabs', { connector: 'puzzle' }],
    ['extra floor, no joint', { connector: 'none', bottomPad: 1 }],
  ];
  const MOUNTS = [
    ['magnets below', { magnets: true }],
    ['magnets above', { magnets: true, magnetSide: 'top' }],
    ['screws', { screws: true }],
  ];
  for (const [jn, j] of JOINTS)
    for (const [mn, m] of MOUNTS) {
      const r = buildAll({ ...at, baseMode: 'bosses', ...j, ...m });
      const cfg = r.cfg, pad = G.platePad(cfg);
      const plain = buildAll({ ...at, baseMode: 'bosses', ...j, ...m, connector: 'none', bottomPad: 0 });
      const without = buildAll({ ...at, ...j, bottomPad: pad });
      const solidBefore = buildAll({ ...at, ...j, connector: 'none', bottomPad: pad });
      let housing = 0, filled = 0, pts = 0, buried = 0;
      r.pieces.forEach((polys, pi) => {
        const pc = r.L.pieces[pi];
        const A = columns(polys), B = columns(without.pieces[pi]), C = columns(solidBefore.pieces[pi]);
        if (cfg.connector !== 'none') {
          const W = pc.mL + pc.nx * cfg.pitch + pc.mR, D = pc.mF + pc.ny * cfg.pitch + pc.mB;
          for (let x = h / 2 + 0.000731; x < W; x += h)
            for (let y = h / 2 + 0.000419; y < D; y += h) {
              const a = A(x, y), b = B(x, y), c = C(x, y);
              let round = null;
              for (const z of zs)
                if (c(z) >= 1 && b(z) <= 0) {
                  housing++;
                  if (a(z) < 1) continue;
                  round = round || [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([u, v]) => A(x + u * 0.005, y + v * 0.005));
                  if (round.every((f) => f(z) >= 1)) filled++;
                }
            }
        }
        // each pocket's sides and middle, from its mouth to its floor: a standing boss's
        // top is its own height, and a floor's the floor's
        const top = G.cornerBosses(cfg) ? Math.min(2.6, Math.max(cfg.magnets ? cfg.magnetH + 0.8 : 0,
          cfg.screws ? cfg.screwHeadDepth + 1 : 0)) : pad;
        const spans = [];
        if (cfg.magnets) spans.push(cfg.magnetSide === 'top'
          ? [cfg.magnetD / 2 - 0.3, top - cfg.magnetH, top] : [cfg.magnetD / 2 - 0.3, 0, cfg.magnetH]);
        if (cfg.screws) spans.push([cfg.screwHeadD / 2 - 0.3, 0, cfg.screwHeadDepth], [cfg.screwHoleD / 2 - 0.3, 0, top]);
        for (let i = 0; i < pc.nx; i++) for (let k = 0; k < pc.ny; k++)
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            const px = pc.mL + (i + 0.5) * cfg.pitch + sx * cfg.holeOffset;
            const py = pc.mF + (k + 0.5) * cfg.pitch + sy * cfg.holeOffset;
            for (const [rad, z0, z1] of spans)
              for (let q = 0; q < 8; q++) for (const rr of [0, rad / 2, rad]) {
                const col = A(px + rr * Math.cos(q * Math.PI / 4) + 0.000731, py + rr * Math.sin(q * Math.PI / 4) + 0.000419);
                for (let z = z0 + 0.1; z <= z1 - 0.1 + 1e-9; z += 0.2) { pts++; if (col(z) >= 1) buried++; }
              }
          }
      });
      const mm3 = (n) => (n * h * h * dz).toFixed(1);
      const good = !filled && !buried && !r.open && r.bad <= plain.bad && (cfg.connector === 'none' || housing > 0);
      console.log(`  ${`${jn}, ${mn}`.padEnd(36)} ` +
                  (cfg.connector === 'none' ? 'no housing' : !housing ? 'NO HOUSING CUT'
                    : `housing ${mm3(housing)} mm³, ${filled ? `${mm3(filled)} mm³ OF IT FILLED` : 'none filled'}`) +
                  `; ${buried ? `${buried} of ${pts} pocket points SOLID` : `pockets open (${pts} points)`}; ` +
                  `${leakText(r)}${r.bad ? `, ${plain.bad} with no joint` : ''}${good ? '' : '   FAIL'}`);
      if (!good) bad++;
    }
  /* A boss a housing reaches stops short of the piece's edge, and its pockets are a
     lottery of their own: four one-cell pieces with dovetails, whose notches reach the
     bosses from 34 to 36.4 mm, left 3 open edges under a boss with default screws at
     these two pitches, where the whole boss had built closed, until the pockets were cut
     again where they come out open (buildPiece). */
  for (const p of [34.64, 34.72]) {
    const r = buildAll({ pitch: p, drawerW: 2 * p, drawerD: 2 * p, bedW: p + 5, bedD: p + 5,
                         baseMode: 'bosses', screws: true });
    console.log(`  ${`dovetail, one-cell pieces at ${p} mm, screws`.padEnd(36)} ${r.L.pieces.length} pieces; ${leakText(r)}` +
                `${r.bad ? '   FAIL' : ''}`);
    if (r.bad) bad++;
  }
  /* A boss no housing reaches has its pockets cut again too when they come out open: default
     screws in a one-cell drawer left 6 open edges under a boss at 37.7 mm (one of 22
     pitches from 34 to 60 mm), and a 9.1 mm magnet at 39.46 mm 12 a piece, with no joint. */
  for (const [name, over] of [
    ['one cell at 37.7 mm, screws', { pitch: 37.7, drawerW: 37.7, drawerD: 37.7, bedW: 57.7, bedD: 57.7, screws: true }],
    ['no joint at 39.46 mm, 9.1 magnet', { pitch: 39.46, drawerW: 157.84, drawerD: 78.92, bedW: 94.92, bedD: 400,
                                           magnets: true, magnetD: 9.1 }]]) {
    const r = buildAll({ ...over, baseMode: 'bosses', connector: 'none' });
    console.log(`  ${name.padEnd(36)} ${r.L.pieces.length} piece${r.L.pieces.length > 1 ? 's' : ''}; ${leakText(r)}` +
                `${r.open ? '   FAIL' : ''}`);
    if (r.open) bad++;
  }
  /* And the boss's own cut, where a 2 mm hole runs through it (#80). Corner pockets with
     screws and a 2 mm hole at a 34.04 mm pitch, two 2 x 2 pieces and no joint, left 24 open
     edges a piece on main, all on the rim of the shank at the boss's top (2.6 mm), with
     Download on; 34 and 34.08 mm and a 3 mm hole were closed. A boss's top is a fan from its
     corner, and its spoke to the fifth vertex of the rounded corner (51.3 degrees) passed
     4.5 microns from the shank's corner at 90 degrees from the site, 5.02 mm in from the
     cell's edges, where the sliver between them was lost. The link's own default 6 mm head
     is over the cap here now, since the counterbore is 6 across its flats and the cap is
     5.8, so the field refuses it, and the design is asked at the cap (the same plate, built
     closed: its shank has its flats on the 2 mm, so its corner stands 1.035 mm out and not
     1 mm, off that spoke), at the first size past the cap, and as linked, each of which has
     to be refused and built at the cap. The same spoke meets a corner at other pitches, and
     corner pockets still leave 3 open edges a cell at three of them with a 2 mm hole: 34.32
     mm, with screws alone or under a 6 mm magnet from beneath; 34.73 mm, under a 4 mm magnet
     from above; and with a 3 mm hole 38.95 mm, under a 6 mm magnet from above. They are what
     is left of #80, open, and are not pinned here. */
  for (const [name, head, why] of [
    ['#80: 34.04 mm, 2 mm hole, 5.8 head', 5.8, false],
    ['#80: 34.04 mm, 2 mm hole, 5.81 head', 5.81, true],
    ['#80: 34.04 mm, 2 mm hole, 6 head', 6, true]]) {
    const p = 34.04, at = { pitch: p, drawerW: 4 * p, drawerD: 2 * p, bedW: 84, bedD: 400, baseMode: 'bosses',
                            connector: 'none', screws: true, screwHoleD: 2 };
    const asked = designCfg({ ...at, screwHeadD: head });
    const lims = G.mountLimits(asked, G.computeLayout(asked));
    const refused = head > lims.screwHeadD + 1e-9;
    const r = buildAll({ ...at, screwHeadD: Math.min(head, lims.screwHeadD) });
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    const good = refused === why && !r.open && !folds;
    console.log(`  ${name.padEnd(36)} ${refused ? `refused (cap ${lims.screwHeadD}), built at it` : 'taken'}; ${r.L.pieces.length} pieces; ` +
                `${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}${good ? '' : `   FAIL${refused === why ? '' : why ? ': has to be refused' : ': has to be taken'}`}`);
    if (!good) bad++;
  }
  /* And a boss's cut moved one NUDGE could stand where the cell's stands, when one or the
     other was taken again (cutAgain): a wall puzzle key at 36.13 mm with screws and a margin
     had 73 edges used four times in a piece, against 26 with no joint. */
  {
    const p = 36.13, at = { pitch: p, drawerW: 4 * p + 7.3, drawerD: 2 * p + 5.1, mLeft: 3.1, mRight: 4.2, mFront: 2.5,
      mBack: 2.6, bedW: 2 * p + 16, bedD: 400, baseMode: 'bosses', screws: true };
    const r = buildAll({ ...at, connector: 'puzzlekey', keyMount: 'wall', keyInsert: 'bottom' });
    const plain = buildAll({ ...at, connector: 'none' });
    const good = !r.open && r.bad <= plain.bad;
    console.log(`  ${'wall puzzle keys at 36.13 mm, screws'.padEnd(36)} ${leakText(r)}, ${plain.bad} with no joint${good ? '' : '   FAIL'}`);
    if (!good) bad++;
  }
  /* A boss's top is fanned from a corner of its outline, the cell's corner for half of
     them, and where a spoke passes a few microns from a corner of the walls that open on
     the top, the sliver between goes (#91): a 2 mm shank at 34.32 mm, 1.3 microns, alone
     or under a 6 mm magnet from beneath, a 4 mm magnet's pocket from above at 34.73 mm
     and a 6 mm one's at 38.95, 5.3 microns, each with the head at the field's cap; and
     with no screw, a 4.9 mm magnet from above at 43.9 mm, its cap there. Its underside is
     fanned the same way, and the same magnet from beneath opened there. Every try of
     cutAgain left one boss a cell open, 3 edges, and 6 to 15 over 2 x 2, with Download
     on, until a boss still open after them had the cap it is open on fanned again clear
     of those corners (refanCaps in buildPiece). Each has to be taken and build with
     nothing open and no folds; the 2 x 2 pieces keep the edges their bosses share
     (quarantined above). */
  for (const [name, n, over] of [
    ['34.32 mm, 2 mm hole', 1, { pitch: 34.32, screwHoleD: 2, screwHeadD: 6.1 }],
    ['34.32 mm, 2 mm hole, 6 mm magnet below', 1, { pitch: 34.32, magnets: true, screwHoleD: 2, screwHeadD: 6.1 }],
    ['34.73 mm, 2 mm hole, 4 mm magnet above', 1, { pitch: 34.73, magnets: true, magnetD: 4, magnetSide: 'top',
      screwHoleD: 2, screwHeadD: 6.5 }],
    ['38.95 mm, 3 mm hole, 6 mm magnet above', 1, { pitch: 38.95, magnets: true, magnetSide: 'top', screwHoleD: 3,
      screwHeadD: 9.7 }],
    ['43.9 mm, 4.9 mm magnet above, no screw', 1, { pitch: 43.9, magnets: true, magnetD: 4.9, magnetSide: 'top',
      screws: false }],
    ['43.9 mm, 4.9 mm magnet below, no screw', 1, { pitch: 43.9, magnets: true, magnetD: 4.9, screws: false }],
    ['34.32 mm, 2 mm hole, 2 x 2', 2, { pitch: 34.32, screwHoleD: 2, screwHeadD: 6.1 }],
    ['34.73 mm, 4 mm magnet above, 2 x 2', 2, { pitch: 34.73, magnets: true, magnetD: 4, magnetSide: 'top',
      screwHoleD: 2, screwHeadD: 6.5 }],
    ['38.95 mm, 6 mm magnet above, 2 x 2', 2, { pitch: 38.95, magnets: true, magnetSide: 'top', screwHoleD: 3,
      screwHeadD: 9.7 }],
    ['43.9 mm, 4.9 mm magnet below, 2 x 2', 2, { pitch: 43.9, magnets: true, magnetD: 4.9, screws: false }]]) {
    const at = { drawerW: n * over.pitch, drawerD: n * over.pitch, bedW: 400, bedD: 400, baseMode: 'bosses',
                 connector: 'none', screws: true, ...over };
    const cfg = designCfg(at), lim = G.mountLimits(cfg, G.computeLayout(cfg));
    const taken = (at.magnets ? ['magnetD'] : []).concat(at.screws ? ['screwHoleD', 'screwHeadD'] : []).every((f) =>
      cfg[f] <= lim[f] + 1e-9 && !lim.gaps[f].some(([a, b]) => cfg[f] >= a - 1e-9 && cfg[f] <= b + 1e-9));
    const r = buildAll(at);
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    const good = taken && !r.open && !folds;
    console.log(`  ${name.padEnd(40)} ${taken ? '' : 'REFUSED, '}${leakText(r)}${folds ? `, ${folds} FOLDS` : ''}` +
                `${good ? '' : '   FAIL'}`);
    if (!good) bad++;
  }
  /* A boss is its pocket's depth and 0.8 (a magnet) or 1.0 (a screw head) tall, and one
     whose top stood level with the ceiling of the cut that reaches it came out open there:
     a dovetail's notch is 2.4 mm tall, an H-clip's recess 2.3 and a wall key's 2.0. These
     left 4 to 13 open edges a piece until such a boss stood MOUNT_LEVEL over the ceiling
     (buildPiece). */
  for (const [name, over] of [
    ['dovetail at 36.13 mm, 1.6 mm magnet', { pitch: 36.13, connector: 'dovetail', magnets: true, magnetH: 1.6 }],
    ['dovetail at 34.04 mm, 1.4 mm head', { pitch: 34.04, connector: 'dovetail', screws: true, screwHeadD: 4, screwHeadDepth: 1.4 }],
    ['H-clip at 33.5 mm, 1.5 mm magnet', { pitch: 33.5, connector: 'hclip', magnets: true, magnetD: 4, magnetH: 1.5 }],
    ['wall bowtie at 36.13 mm, 1 mm head', { pitch: 36.13, connector: 'bowtie', keyMount: 'wall', screws: true, screwHeadDepth: 1 }]]) {
    const p = over.pitch;
    const r = buildAll({ drawerW: 4 * p, drawerD: 2 * p, bedW: 2 * p + 16, bedD: 400, baseMode: 'bosses', ...over });
    console.log(`  ${name.padEnd(36)} ${leakText(r)}${r.open ? '   FAIL' : ''}`);
    if (r.open) bad++;
  }
  /* And a boss's cut can come out with a face turned over after every one of cutAgain's
     tries: a wall puzzle key at 36.92 mm with screws (a 2 mm hole, a 7.1 x 0.8 head), four
     2 x 2 pieces, left three folds on the bed in two of them, by the front edge's key, with
     no edge open, until such a cut was taken again moved the other way (buildPiece). So
     folds as well, which an edge count cannot see. */
  {
    const p = 36.92;
    const r = buildAll({ pitch: p, drawerW: 4 * p, drawerD: 4 * p, bedW: 2 * p + 16, bedD: 2 * p + 16,
                         connector: 'puzzlekey', keyMount: 'wall', keyInsert: 'bottom', baseMode: 'bosses',
                         screws: true, screwHoleD: 2, screwHeadD: 7.1, screwHeadDepth: 0.8 });
    const folds = r.pieces.reduce((s, pp) => s + checkOrientation(pp).folds, 0);
    const good = !r.open && !folds;
    console.log(`  ${'wall puzzle keys at 36.92 mm, screws'.padEnd(36)} ${r.L.pieces.length} pieces; ${leakText(r)}` +
                `${folds ? `, ${folds} FOLDS` : ''}${good ? '' : '   FAIL'}`);
    if (!good) bad++;
  }
  /* And a key put in from above (#75). Its housing is a cup the plate builds, a floor
     0.6 mm thick under the key 1.4 mm over the bed, with its walls from there up, at the
     corner where four cells meet, as a boss is; and it is built after the bosses' pockets
     are cut, so it stood in any it reached. A wall bowtie at 36.13 mm took a 6 mm magnet
     from beneath with 1.3 mm³ of the cup in the four pockets beside the seam, in the top
     0.6 mm of each, with Download on. mountLimits counts the cup now ('housing'): each of
     these is asked at the size that met it, which has to be refused for the housing, and
     built at the size the field takes, where every pocket has to be as open as in the
     same plate with no joint, read on vertical lines 0.1 mm apart every 0.05 mm up its
     depth. With no joint, which is the pocket's whole volume since #83 (below): before
     it the socket's rim stood in part of a 6 mm pocket at these pitches, joint or not.
     And a pocket the cup does not reach, at 42 mm, has to be taken as before. */
  {
    const h = 0.1, dz = 0.05;
    /* the open room in each pocket of a design, in mm³, mouth to floor; or, `whole`, all
       of it, open or not. A screw's head and shank are cut with their corners on the
       size, 14 and 12 sides, so they are read inside their flats; a magnet's pocket
       has its flats on the magnet (fastenerCutter). */
    const room = (r, whole) => {
      const cfg = r.cfg, out = [];
      const top = Math.min(2.6, Math.max(cfg.magnets ? cfg.magnetH + 0.8 : 0, cfg.screws ? cfg.screwHeadDepth + 1 : 0));
      const spans = [];
      if (cfg.magnets) spans.push(cfg.magnetSide === 'top'
        ? [cfg.magnetD / 2, top - cfg.magnetH, top] : [cfg.magnetD / 2, 0, cfg.magnetH]);
      if (cfg.screws) spans.push([cfg.screwHeadD / 2 * Math.cos(Math.PI / 14), 0, cfg.screwHeadDepth],
                                 [cfg.screwHoleD / 2 * Math.cos(Math.PI / 12), 0, top]);
      r.pieces.forEach((polys, pi) => {
        const pc = r.L.pieces[pi], A = whole ? null : columns(polys);
        for (let i = 0; i < pc.nx; i++) for (let k = 0; k < pc.ny; k++)
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            const px = pc.mL + (i + 0.5) * cfg.pitch + sx * cfg.holeOffset;
            const py = pc.mF + (k + 0.5) * cfg.pitch + sy * cfg.holeOffset;
            let v = 0;
            for (const [rad, z0, z1] of spans)
              for (let x = -rad; x <= rad; x += h) for (let y = -rad; y <= rad; y += h) {
                if (Math.hypot(x, y) > rad - 0.02) continue;
                const col = whole ? () => 0 : A(px + x + 0.000731, py + y + 0.000419);
                for (let z = z0 + dz / 2; z < z1; z += dz) if (col(z) < 1) v += h * h * dz;
              }
            out.push(v);
          }
      });
      return out;
    };
    const P = (p) => ({ pitch: p, drawerW: 4 * p, drawerD: 2 * p, bedW: 2 * p + 16, bedD: 400, baseMode: 'bosses',
                        connector: 'bowtie', keyMount: 'wall', keyInsert: 'top' });
    for (const [name, over, f, d, why] of [
      ['wall bowtie at 36.13 mm, 6 mm magnet', { ...P(36.13), magnets: true }, 'magnetD', 6, 'housing'],
      ['wall bowtie at 36.13 mm, magnet above', { ...P(36.13), magnets: true, magnetSide: 'top' }, 'magnetD', 6, 'housing'],
      ['wall bowtie at 36.13 mm, 6 mm head', { ...P(36.13), screws: true }, 'screwHeadD', 6, 'housing'],
      ['wall puzzle key at 36.13 mm, magnet', { ...P(36.13), connector: 'puzzlekey', magnets: true }, 'magnetD', 6, 'housing'],
      ['wall bowtie at 39.46 mm, 9.3 magnet', { ...P(39.46), magnets: true }, 'magnetD', 9.3, 'housing'],
      ['wall bowtie at 42 mm, 6 mm magnet', { ...P(42), magnets: true }, 'magnetD', 6, false]]) {
      const asked = designCfg({ ...over, [f]: d });
      const lims = G.mountLimits(asked, G.computeLayout(asked));
      const refused = d > lims[f] + 1e-9 && lims.joint[f];
      const size = Math.min(d, lims[f]);
      const r = buildAll({ ...over, [f]: size });
      const got = room(r), plain = room(buildAll({ ...over, [f]: size, connector: 'none' }));
      const short = got.map((v, k) => plain[k] - v).filter((v) => v > 0.005);
      const good = refused === why && !short.length && !r.open;
      console.log(`  ${name.padEnd(38)} ${refused ? `refused (${refused}), built at ${size}` : 'taken'}; ` +
                  (short.length ? `${short.length} of ${got.length} pockets SHORT of their room with no joint, ` +
                    `${short.reduce((s, v) => s + v, 0).toFixed(2)} mm³` : `${got.length} pockets as open as with no joint`) +
                  `; ${leakText(r)}${good ? '' : `   FAIL${refused === why ? '' : why ? `: has to be refused for the ${why}` : ': has to be taken'}`}`);
      if (!good) bad++;
    }
    /* And where the cup meets a pocket the plate can come out open, which the room above
       does not see: an H-clip from above at 34 mm took a 4 mm magnet from above with 4
       edges open in A1, where the cavity meets the pocket's wall, and a wall bowtie at
       36.13 mm a 7.9 mm magnet 1.45 mm deep, level with the cavity's floor, with 13 open
       a piece, both with Download on. Each has to be refused, and built at the size the
       field takes with no edge open: the bowtie's for the housing, and the H-clip's for
       the socket's rim. The H-clip's cup stands inside the rim's corner, and a pocket
       from above has to clear the rim over its boss since #83 (below), which it meets
       first at any fit clearance up to 0.25 mm, this row's default 0.2 among them,
       whatever the tolerance and rim cutoff: from 30 to 42 mm no pocket from above then
       reaches an H-clip's or a snap clip's cup that the rim does not stop sooner. A
       looser H-clip fit widens the cup until it comes first, and the housing's cap holds
       the pocket, as it did here before #83: from a fit of 0.26 at loose tolerance and
       rim cutoff 0.1, where a 2.1 mm magnet from above at 33 mm is refused at 2 for the
       housing, and from 0.42 at standard tolerance and the default cutoff (ENGINE.md
       §5). */
    for (const [name, over, d, why] of [
      ['H-clip at 34 mm, 4 mm magnet above', { ...P(34), connector: 'hclip', magnets: true, magnetSide: 'top' }, 4, 'rim'],
      ['wall bowtie at 36.13 mm, 7.9 x 1.45', { ...P(36.13), magnets: true, magnetH: 1.45 }, 7.9, 'housing']]) {
      const asked = designCfg({ ...over, magnetD: d });
      const lims = G.mountLimits(asked, G.computeLayout(asked));
      const refused = d > lims.magnetD + 1e-9 && (lims.rim.magnetD ? 'rim' : lims.joint.magnetD);
      const size = Math.min(d, lims.magnetD);
      const r = buildAll({ ...over, magnetD: size });
      const good = refused === why && !r.open;
      console.log(`  ${name.padEnd(38)} ${refused ? `refused (${refused}), built at ${size}` : 'TAKEN'}; ${leakText(r)}` +
                  `${good ? '' : `   FAIL${refused === why ? '' : `: has to be refused for the ${why}`}`}`);
      if (!good) bad++;
    }
    /* And the socket's rim, with no joint at all (#83). With nothing under the sockets a
       cell is its rim alone, and at small pitches a boss's pocket runs in under it; the
       pocket was cut from the boss and not from the rim, which stood in it: a 6 mm magnet
       from beneath at 34.5 mm had 14.6 mm³ of rim in each pocket, and 1.8 mm³ at 36.13
       mm, a 7.9 mm one there 20.2, and the default screw's head 13.2 at 34.5 mm, all
       taken with Download on. A pocket from above, and a shank, that the rim stood over
       were taken too. The rim is cut away under a boss whose pocket it reaches now, and a
       hole that opens on the boss's top is held clear of the rim over it (mountLimits'
       `rim`). So each of these, asked at the size that met the rim, has to be taken or
       refused for the rim as listed, and built at the size the field takes, where every
       pocket has to be open through its whole volume, mouth to floor. And at 42 mm, where
       the rim reaches no pocket, they have to be taken and open as before. */
    console.log('\ncorner pockets under the socket\'s rim:');
    const Q = (p) => ({ pitch: p, drawerW: 4 * p, drawerD: 2 * p, bedW: 2 * p + 16, bedD: 400, baseMode: 'bosses',
                        connector: 'none' });
    for (const [name, over, f, d, why] of [
      ['34.5 mm, 6 mm magnet', { ...Q(34.5), magnets: true }, 'magnetD', 6, false],
      ['36.13 mm, 6 mm magnet', { ...Q(36.13), magnets: true }, 'magnetD', 6, false],
      ['36.13 mm, 7.9 mm magnet', { ...Q(36.13), magnets: true }, 'magnetD', 7.9, false],
      ['34.5 mm, screws', { ...Q(34.5), screws: true }, 'screwHoleD', 3, false],
      ['36.13 mm, 6 mm magnet above', { ...Q(36.13), magnets: true, magnetSide: 'top' }, 'magnetD', 6, 'rim'],
      ['34.5 mm, 4.5 mm screw hole', { ...Q(34.5), screws: true }, 'screwHoleD', 4.5, 'rim'],
      ['42 mm, 6 mm magnet', { ...Q(42), magnets: true }, 'magnetD', 6, false],
      ['42 mm, 6 mm magnet above', { ...Q(42), magnets: true, magnetSide: 'top' }, 'magnetD', 6, false],
      ['42 mm, screws', { ...Q(42), screws: true }, 'screwHoleD', 3, false]]) {
      const asked = designCfg({ ...over, [f]: d });
      const lims = G.mountLimits(asked, G.computeLayout(asked));
      const refused = d > lims[f] + 1e-9 && (lims.rim[f] ? 'rim' : 'another cap');
      const size = Math.min(d, lims[f]);
      const r = buildAll({ ...over, [f]: size });
      const got = room(r), all = room(r, true);
      const short = got.map((v, k) => all[k] - v).filter((v) => v > 0.005);
      const good = refused === why && !short.length && !r.open;
      console.log(`  ${name.padEnd(38)} ${refused ? `refused (${refused}), built at ${size}` : 'taken'}; ` +
                  (short.length ? `${short.length} of ${got.length} pockets SHORT of their whole room, ` +
                    `${short.reduce((s, v) => s + v, 0).toFixed(2)} mm³ solid` : `${got.length} pockets open through`) +
                  `; ${leakText(r)}${good ? '' : `   FAIL${refused === why ? '' : why ? `: has to be refused for the ${why}` : ': has to be taken'}`}`);
      if (!good) bad++;
    }
  }
}

/* A corner boss stays inside a rounded corner of the plate (#86).
 *
 * A corner boss is a quarter square from its cell's corner, and the plate rounds the
 * corners it owns. The cell's corner is the plate's only with no margin, but a boss was
 * never cut to the arc, so with no margin or a small one its square corner stood out past
 * it, a tab as tall as the boss, up to 2.6 mm: r(√2 − 1) out at an outer radius r with no
 * margin (1.66 mm at the default 4, 0.83 at 2, 1.99 at 4.8, at every pitch) and 0.95 mm
 * with margins of 0.5. It stays inside once both margins pass 1.17 mm, or once the other
 * reaches 4 mm when one is none. Nothing above could see it: a square tab on a rounded
 * corner is as closed and faces outwards as well as a rounded one, and the rows that build
 * corner bosses with no margin and a rounded corner quarantine their edges by name.
 *
 * So it is measured off the mesh, as how far past the arc the farthest vertex of a piece
 * stands in the square of each corner the plate rounds (0 or less is inside). That has to
 * be nothing on the page that showed it and with margins of 0.5 mm, and the default
 * drawer's 6 and 1 mm are a control. The clip to the arc must not cost the plate an edge
 * either: a boss that follows the arc stands on the same points the corner cell's wall
 * does, and the plate may not have more edges used four times than it has with square
 * corners (clipToPlate), but for the kind named below. One row is the exception to
 * "nothing past the outline": margins of 1.17 mm, where the corner stands out 0.0022 mm
 * and clipToPlate leaves it, since the clip's points would stand 2.4 microns apart and the
 * weld took them for one or two as it came (3 open edges at 34 mm with screws); that row
 * allows 0.01 mm and no open edge, as does one beside it with a corner 0.0008 mm out.
 *
 * And the cut boss has to be no worse than the square one, which neither count shows. Cut,
 * a boss's pocket can break through the arc: at 30 mm with a 4.88 mm corner and a 1.8 mm
 * magnet the plate had a window in its outer wall, 1.2 mm along the arc and up to 2 mm
 * tall, that the square tab had covered, with every edge round it closed. So every row
 * reads the wall as well, points just inside the arc that no shell holds with none outside
 * them either, and may have none; and may have no open edge and no fold, since a cut boss's
 * pocket is a lottery of its own: the defaults with screws at 36.42 mm, and three plates
 * with a 2 mm corner at 29.5 to 33 mm, had 3 open edges where the square boss built closed,
 * and two whose pocket stood at the arc had 6 folds. buildPiece takes the cut boss only
 * where its bores stand MOUNT_WALL inside the arc and it comes out closed with nothing
 * turned over, and builds the square one otherwise. The rows marked so must still have
 * the square boss (the farthest vertex out by 0.01 mm or more); the four with the lottery
 * are cut, their pockets cut again turned a 28th of a turn.
 *
 * One kind of bad edge is named here and pinned, rather than held to square corners:
 * edges a cut boss shares with the shell beside it, the corner cell's wall or a margin's
 * region, where both stand on the same points of the arc. Both shells are closed and their
 * faces there lie in one plane and face the same way, so each such edge is used four times
 * and none once. It comes three ways: a side along a chord under SHORT, which clipToPlate
 * leaves whole, so its bottom edge is the wall's (every chord, under a corner of about
 * 0.19 mm); a half chord whose middle point lands on a margin region's side, which shares
 * it; and the vertical edges at the arc's points from the bed up, where a joint's cut from
 * beneath (a wall key's recess, 2 mm, or an H-clip's) splits the cell's walls and a plane
 * of the boss's pocket the boss's at the same height. In the sweeps for the review of #90,
 * 69 of the 3,469 designs the clip changed had more of them, never open: 60 the last way,
 * 7 the first and 2 the second. A row of that kind may have more bad edges than square
 * corners, by no more than it has on file, and none open; one with none more is to be
 * unpinned.
 *
 * Last, each measure has to read what it was written to find: the old boss, a square tab
 * on the corner, laid on the plate; and a skeleton plate's outer wall, which is open below
 * 2.5 mm by design (skeletonCellRegion). */
console.log('\na corner boss stays inside a rounded plate corner:');
{
  const NARC = 10;
  // every corner these rows round has the plate's radius: none has one of its own or a half cell
  const rcOf = (cfg) => Math.min(cfg.outerRadius, ((cfg.topCutoff + cfg.socketRadius) * Math.SQRT2 -
                                                  cfg.socketRadius - 0.2) / (Math.SQRT2 - 1));
  // the corners of the plate each piece of a design rounds: the corner, and the way into the plate
  const rounded = (r) => r.L.pieces.map((pc) => {
    const W = pc.mL + pc.nx * r.cfg.pitch + pc.mR, D = pc.mF + pc.ny * r.cfg.pitch + pc.mB;
    const atL = pc.cellX0 === 0, atR = pc.cellX0 + pc.nx === r.L.nx;
    const atF = pc.cellY0 === 0, atB = pc.cellY0 + pc.ny === r.L.ny;
    if (rcOf(r.cfg) <= 0.01) return [];
    return [[atL && atF, 0, 0, 1, 1], [atR && atF, W, 0, -1, 1], [atR && atB, W, D, -1, -1], [atL && atB, 0, D, 1, -1]]
      .filter(([owns]) => owns).map(([, cx, cy, sx, sy]) => ({ cx, cy, sx, sy }));
  });
  /* The farthest any vertex stands past the outline at a corner the plate rounds, and how many corners there were.
     The outline's arc is NARC = 10 chords, which sag inside the circle by up to rc (1 − cos 4.5°), 0.012 mm at
     4: a vertex is past it by how far it stands beyond the chord that covers its angle round the arc's centre.
     `extra` is laid on the first piece's corner at the origin. */
  const past = (r, extra) => {
    const rc = rcOf(r.cfg), step = 90 / NARC;
    let worst = 0, corners = 0;
    rounded(r).forEach((cs, i) => {
      for (const { cx, cy, sx, sy } of cs) {
        corners++;
        const ox = cx + sx*rc, oy = cy + sy*rc;
        for (const p of extra && i === 0 && cx === 0 && cy === 0 ? r.pieces[i].concat(extra) : r.pieces[i])
          for (const v of p.verts) {
            if ((v[0] - cx) * sx > rc + 1e-9 || (v[1] - cy) * sy > rc + 1e-9) continue;
            const a = -sx * (v[0] - ox), b = -sy * (v[1] - oy);    // across the quadrant the arc covers
            const phi = Math.max(0, Math.atan2(b, a) * 180 / Math.PI), k = Math.min(NARC - 1, Math.floor(phi / step));
            worst = Math.max(worst, Math.hypot(a, b) * Math.cos((phi - (k + 0.5) * step) * Math.PI / 180) -
                                    rc * Math.cos(step / 2 * Math.PI / 180));
          }
      }
    });
    return { worst, corners };
  };
  /* A window in the plate's outer wall at a rounded corner: a point 0.01 mm inside a chord of the arc, at
     every tenth of each chord and every 0.1 mm up, that no shell holds, with no shell within 3 mm outside it
     either (columns, above). The square boss stood outside the arc and covered whatever was behind it. */
  const windows = (r) => {
    const rc = rcOf(r.cfg);
    let n = 0;
    rounded(r).forEach((cs, i) => {
      if (!cs.length) return;
      const A = columns(r.pieces[i]);
      let top = 0;
      for (const p of r.pieces[i]) for (const v of p.verts) top = Math.max(top, v[2]);
      for (const { cx, cy, sx, sy } of cs) {
        // the arc's points as buildPiece lays them, round the quadrant that faces the corner
        const ox = cx + sx*rc, oy = cy + sy*rc, a0 = Math.atan2(-sy, -sx) - Math.PI / 4;
        const at = (k) => [ox + rc * Math.cos(a0 + k * Math.PI / 2 / NARC), oy + rc * Math.sin(a0 + k * Math.PI / 2 / NARC)];
        for (let k = 0; k < NARC; k++) {
          const a = at(k), b = at(k + 1), mx = (a[0] + b[0]) / 2 - ox, my = (a[1] + b[1]) / 2 - oy;
          const nx = -mx / Math.hypot(mx, my), ny = -my / Math.hypot(mx, my);   // into the plate
          for (let f = 0.05; f < 1; f += 0.1) {
            const px = a[0] + f * (b[0] - a[0]), py = a[1] + f * (b[1] - a[1]);
            const inside = A(px + 0.01 * nx, py + 0.01 * ny);
            let outside = null;
            for (let z = 0.05; z < top; z += 0.1) {
              if (inside(z) >= 1) continue;
              outside = outside || Array.from({ length: 30 }, (_, s) => A(px - (0.02 + 0.1 * s) * nx, py - (0.02 + 0.1 * s) * ny));
              if (!outside.some((col) => col(z) >= 1)) n++;
            }
          }
        }
      }
    });
    return n;
  };
  const page = { pitch: 42, drawerW: 84, drawerD: 84, bedW: 256, bedD: 256, connector: 'none', baseMode: 'bosses' };
  const ROWS = [
    ['the page: 84 x 84 mm at 42, no margin, magnets', { ...page, magnets: true }],
    ['0.5 mm margins, a 4.8 mm corner, 3 x 2 in two pieces at 36, dovetails, magnets and screws',
     { pitch: 36, drawerW: 109, drawerD: 73, mLeft: 0.5, mRight: 0.5, mFront: 0.5, mBack: 0.5, bedW: 76, bedD: 400,
       connector: 'dovetail', baseMode: 'bosses', magnets: true, screws: true, outerRadius: 4.8 }],
    ['no margin at 34.5, screws, whose pockets run in under the rim',
     { ...page, pitch: 34.5, drawerW: 69, drawerD: 69, screws: true }],
    ['the default drawer\'s margins, 6 and 1 mm, magnets (control)',
     { ...page, drawerW: 96, drawerD: 86, mLeft: 6, mRight: 6, mFront: 1, mBack: 1, magnets: true }],
    // the corner stands out 0.0022 mm, under the 0.01 clipToPlate leaves: clipped, it had 3 open edges here
    ['margins of 1.17 mm at 34 mm, screws, the corner a hair out (left as it is)',
     { ...page, pitch: 34, drawerW: 70.34, drawerD: 70.34, mLeft: 1.17, mRight: 1.17, mFront: 1.17, mBack: 1.17, screws: true },
     { slack: 0.01 }],
    // cut, with its pocket cut again turned a 28th of a turn: cut first, the boss had 3 open edges on its underside
    ['the defaults with screws at 36.42 mm, margins of 0, 0.433, 1 and 0, tight',
     { ...page, pitch: 36.42, drawerW: 73.273, drawerD: 73.84, mRight: 0.433, mFront: 1, tolerance: 'tight',
       screws: true, screwHoleD: 3, screwHeadD: 5.3 }],
    // and its back right corner 0.0008 mm out, which clipToPlate leaves
    ['a 2 mm corner at 30 mm, a 1.8 mm magnet, margins of 1, 0, 0 and 1.99',
     { ...page, pitch: 30, drawerW: 61, drawerD: 61.99, mLeft: 1, mBack: 1.99, outerRadius: 2, magnets: true, magnetD: 1.8 },
     { slack: 0.01 }],
    ['a 2 mm corner at 33 mm, cutoff 1, a 1.1 mm screw under a 3.5 mm head, margins of 1, 0, 0.575 and 1, tight',
     { ...page, pitch: 33, drawerW: 67, drawerD: 67.575, mLeft: 1, mFront: 0.575, mBack: 1, outerRadius: 2, topCutoff: 1,
       tolerance: 'tight', screws: true, screwHoleD: 1.1, screwHeadD: 3.5 }],
    ['a 2 mm corner at 29.5 mm, a 1.2 mm magnet, margins of 1, 0.963, 1 and 0, loose',
     { ...page, pitch: 29.5, drawerW: 60.963, drawerD: 60, mLeft: 1, mRight: 0.963, mFront: 1, outerRadius: 2,
       tolerance: 'loose', magnets: true, magnetD: 1.2 }],
    // left square: the pocket comes nearer the arc than MOUNT_WALL (clipped, a window, or folds beside one)
    ['a 4.88 mm corner at 30 mm, a 1.8 mm magnet, no margin (left square: the pocket reaches the arc)',
     { ...page, pitch: 30, drawerW: 60, drawerD: 60, outerRadius: 4.88, magnets: true, magnetD: 1.8 }, { square: true }],
    ['a 4.88 mm corner at 29.5 mm, margins of 0.2 mm, a 1.3 mm magnet (left square)',
     { ...page, pitch: 29.5, drawerW: 59.4, drawerD: 59.4, mLeft: 0.2, mRight: 0.2, mFront: 0.2, mBack: 0.2,
       outerRadius: 4.88, magnets: true, magnetD: 1.3 }, { square: true }],
    ['the largest corner at 33 mm, cutoff 1, a 4.8 mm magnet, no margin (left square)',
     { ...page, pitch: 33, drawerW: 66, drawerD: 66, outerRadius: 1000, topCutoff: 1, magnets: true, magnetD: 4.8 },
     { square: true }],
    // the kind named above, each way it comes, at what it has on file
    ['a 0.09 mm corner at 40.76 mm, a 0.8 mm margin, magnets and screws (every chord under SHORT)',
     { ...page, pitch: 40.76, drawerW: 82.318, drawerD: 81.52, mLeft: 0.798, outerRadius: 0.09, magnets: true, screws: true,
       magnetD: 8, screwHoleD: 5.8, screwHeadD: 6.3 }, { known: 20 }],
    ['a 2 mm corner at 36 mm, margins of 0.2 and 0.3, magnets and screws (a half chord on a margin\'s side)',
     { ...page, pitch: 36, drawerW: 72.2, drawerD: 72.3, mLeft: 0.2, mBack: 0.3, outerRadius: 2, magnets: true, screws: true,
       magnetD: 5 }, { known: 2 }],
    ['two pieces at 40 mm, a wall bowtie from beneath, a 4.88 mm corner, 6 x 2 mm magnets (split at 2 mm)',
     { ...page, pitch: 40, drawerW: 80, drawerD: 80, bedW: 45, bedD: 400, connector: 'bowtie', keyMount: 'wall',
       keyInsert: 'bottom', outerRadius: 4.88, magnets: true, magnetD: 6, magnetH: 2 }, { known: 24 }],
  ];
  const KIND = 'a cut boss and the shell beside it on the same points of the arc, edges used four times';
  for (const [name, over, how = {}] of ROWS) {
    const r = buildAll(over), flat = buildAll({ ...over, outerRadius: 0 });
    const m = past(r), win = windows(r);
    const turned = r.pieces.map(checkOrientation).filter((o) => !o.ok);
    const more = r.bad - flat.bad;
    const shape = how.square ? m.worst >= 0.01 : m.worst < (how.slack || 1e-6);
    const edges = how.known ? more > 0 && more <= how.known : more <= 0;
    const good = shape && m.corners >= 4 && !r.open && !turned.length && !win && edges;
    const note = !how.known ? '' : more <= 0 ? '  NOW CLEAN: unpin it' : more > how.known
      ? `  WORSE than the ${how.known} more on file for: ${KIND}` : `  known: ${KIND}`;
    console.log(`  ${name}: ${m.corners} rounded corners, the farthest vertex ${m.worst < 1e-6 ? 'inside' : m.worst.toFixed(4) + ' mm past'} the outline; ` +
                `${r.bad} bad edges against ${flat.bad} with square corners, ${r.open} open` +
                `${turned.length ? ', ' + orientationNote(turned[0]) : ''}, ${win} points of wall open${note}${good ? '' : '   FAIL'}`);
    if (!good) bad++;
  }
  // the old boss: a square tab on the corner, 3 mm a side and 2.6 tall, laid on the page's plate
  const pg = buildAll(ROWS[0][1]);
  const old = past(pg, G.extrudePoly([[0, 0], [3, 0], [3, 3], [0, 3]], 0, 2.6));
  // the tab's corner is the diagonal's point of the arc, a vertex of the chords: r(√2 − 1) from it, along a chord's normal
  const want = rcOf(pg.cfg) * (Math.SQRT2 - 1) * Math.cos(Math.PI / (4 * NARC));
  const live = Math.abs(old.worst - want) < 1e-3;
  console.log(`  the measure on the old boss, a square tab laid on the corner: ${old.worst.toFixed(3)} mm past the outline of a ${rcOf(pg.cfg)} mm corner, ` +
              `r(√2 − 1) cos 4.5° = ${want.toFixed(3)}${live ? '' : '   THE MEASURE DOES NOT SEE IT'}`);
  if (!live) bad++;
  // and the wall's: a skeleton plate leaves its outer wall open under the socket's straight walls on purpose
  const sk = windows(buildAll({ ...page, baseMode: 'solid', plateStyle: 'skeleton' }));
  console.log(`  the wall's measure on a skeleton plate, open below 2.5 mm by design: ${sk} points of wall open` +
              (sk ? '' : '   THE MEASURE DOES NOT SEE IT'));
  if (!sk) bad++;
}

/* The fit clearance at its ceiling, for every joint and every pitch band.
 *
 * connClrCeiling's answer depends on the joint, which way its key goes in and the pitch,
 * and a ceiling that knew only the connector let two things through at 1 mm: a snap clip
 * dropped in from above stood its housing 0.65 mm inside the next piece, and the puzzle,
 * bowtie and puzzle key left holes in plates under 20 mm. The cases above could not see
 * either. They built each joint once, at 42 mm, and asked only whether it was watertight —
 * and a housing standing in the next piece is perfectly watertight.
 *
 * So every joint the connector, mount and insert menus make is built at its own ceiling,
 * on both piece layouts, at the bottom of each pitch band the ceiling changes at, where it
 * has least room — 13.5; 13.6, where the puzzle reaches 0.3; and 20 — and at a few
 * pitches between. Each has to come back closed and inside its own width: nothing past
 * its footprint but the tabs and lobes buildPiece declares.
 *
 * Then the step that earns each ceiling, which has to be open, touching or across the
 * seam still: if the engine closes one, this says that ceiling can go up (see PAST
 * below). It has to be past the ceiling as well, refused by the field. A puzzle key in
 * the floor loosened to 0.9 built clean at 20, 30 and 42 and its step past, 0.82, leaked
 * as before, so a ceiling moved over the very number that earned it passed; now the
 * field taking that number fails.
 * And the fit coupon at each ceiling, which is the same joint at four clearances up to
 * it — its pairs have to stay at or under the ceiling, and a housing must not reach into
 * the gap between a pair's two tiles, where it meets the other tile's.
 *
 * Last, a snap clip dropped in from above at its ceiling, on the plate and on the
 * coupon: its slot's seam-side wall has to stand at least a BLOAT inside its own piece.
 * At 0.35 it lay in the seam face itself, about 9.4 mm² of face shared, with no bad edge
 * and nothing past the piece's width for the checks above to see. */
console.log('\nthe fit clearance at its ceiling, every joint and pitch band:');
{
  const VARIANTS = {
    dovetail: { connector: 'dovetail' }, puzzle: { connector: 'puzzle' },
    bowtie: { connector: 'bowtie' }, puzzlekey: { connector: 'puzzlekey' }, snap: { connector: 'snap' },
    hclip: { connector: 'hclip' }, 'hclip top': { connector: 'hclip', keyInsert: 'top' },
    'bowtie wall': { connector: 'bowtie', keyMount: 'wall' },
    'puzzlekey wall': { connector: 'puzzlekey', keyMount: 'wall' },
    'snap wall': { connector: 'snap', keyMount: 'wall' },
    'bowtie wall top': { connector: 'bowtie', keyMount: 'wall', keyInsert: 'top' },
    'puzzlekey wall top': { connector: 'puzzlekey', keyMount: 'wall', keyInsert: 'top' },
    'snap top': { connector: 'snap', keyInsert: 'top' },
    'snap wall top': { connector: 'snap', keyMount: 'wall', keyInsert: 'top' },
  };
  const C = G.PLATE_RANGES.connClr;
  const ceiling = (conf, pitch) => G.connClrCeiling({ ...G.DEFAULTS, ...conf, pitch }).max;
  /* Where each band starts, read off the function rather than written out, so a ceiling
     that moves takes its checks with it; then the spec pitch and three between. */
  const bands = (conf) => {
    const at = [G.PLATE_RANGES.pitch.min];
    let was = ceiling(conf, at[0]);
    for (let i = 1; at[0] + i / 10 <= 60; i++) {
      const P = Math.round((at[0] + i / 10) * 10) / 10, now = ceiling(conf, P);
      if (now !== was) at.push(P);
      was = now;
    }
    return [...new Set([...at, 16, C.smallPitch - 0.5, 30, 42])].sort((a, b) => a - b);
  };
  /* Shells touching rather than a hole, at one clearance, pinned at what it is. The
     dovetail's notch at 0.3 put its top back edge, 2.2 mm in and 2.4 up, on an edge of
     the region next to it on the 1-cell layout's narrow pieces, 3 edges used four times
     at 42 mm, until a jointed cell that shares an edge with the one beside it was cut
     again (touchesBuilt in core.js); none is pinned now. The puzzle's lobe apex was let
     through here as well, at any count, until the region past it stopped carrying it
     (see the cases at the top). */
  const KNOWN = {};
  const OVER = 1e-6;
  /* How near a snap-from-above housing comes to the seam face it opens onto: every vertex
     of the housing keySiteOps hands back for a site, found in the solid built there, and
     the least of their depths into the piece. A site whose housing is not in the solid
     is passed over — buildPiece has none on a seam's midpoint — and a plate or a coupon
     with none found fails, since then nothing was measured. BLOAT is buildPiece's. */
  const BLOAT = 0.05;
  const offSeam = { plate: { near: Infinity, sites: 0 }, coupon: { near: Infinity, sites: 0 } };
  const seamGap = (into, at, polys, sites, H) => {
    const vk = (v) => v.map((x) => x.toFixed(6)).join(',');
    const have = new Set();
    for (const p of polys) for (const v of p.verts) have.add(vk(v));
    let found = 0;
    for (const { edge, e, s, clr } of sites) {
      const vs = G.keySiteOps('snaptop', null, null, clr, edge, e, s, H).add.flatMap((p) => p.verts);
      if (!vs.every((v) => have.has(vk(v)))) continue;
      found++;
      const ax = edge[1] === 'x' ? 0 : 1, inward = edge[0] === '+' ? -1 : 1;
      for (const v of vs) {
        const d = inward * (v[ax] - e);
        if (d < into.near) { into.near = d; into.at = at; }
      }
    }
    into.sites += found;
    return found;
  };
  const ceilings = new Map();
  for (const [vn, conf] of Object.entries(VARIANTS)) {
    const fails = [], at = [], known = [];
    const snapTop = G.jointKind(conf.connector, conf.keyMount, conf.keyInsert) === 'snaptop';
    for (const P of bands(conf)) {
      const most = ceiling(conf, P);
      for (const [ln, lay] of Object.entries(PIECE_LAYOUTS)) {
        const r = buildAll({ pitch: P, ...lay(P), ...conf, clr: most });
        if (snapTop) {
          // buildPiece's height, and the clip's clearance as buildPiece takes it
          const H = G.platePad(r.cfg) + r.cfg.plateHeight;
          const found = r.pieces.reduce((n, polys, i) => n + seamGap(offSeam.plate,
            `${vn} @ ${P} mm ${ln}`, polys, G.pieceConnectors(r.cfg, r.L, r.L.pieces[i]).keyed
              .map((st) => ({ ...st, clr: r.cfg.key.clr })), H), 0);
          if (!found) fails.push(`${P} mm ${ln}: NO SNAP HOUSING FOUND TO MEASURE`);
        }
        const pinned = KNOWN[`${vn} @ ${P} mm ${ln}`];
        const touching = r.bad && !r.open && r.bad <= pinned;
        if (touching) known.push(`${P} mm ${ln}: ${leakText(r)}`);
        if (pinned !== undefined && !r.bad) fails.push(`${P} mm ${ln}: NOW CLEAN — unpin it`);
        if ((r.bad && !touching) || r.beyond > OVER)
          fails.push(`${P} mm ${ln} at ${most}: ${leakText(r)}` +
                     (r.beyond > OVER ? `, ${r.beyond} mm INTO THE NEXT PIECE` : ''));
      }
      at.push(`${P}:${most}`);
      ceilings.set(`${vn} at ${most}`, [conf, most]);
    }
    console.log(`  ${vn.padEnd(18)} ${at.join(' ').padEnd(48)} ` +
                (fails.length ? `FAILS: ${fails.join('; ')}` : 'closed, inside its width') +
                (known.length ? `  known: ${known.join('; ')}` : ''));
    bad += fails.length;
  }
  /* The dovetail's reason is the dovetail's: at the spec pitch nothing else is held to it.
     A snap clip dropped in from above stops at the same 0.3 for a reason of its own, its
     slot's wall a BLOAT inside the seam face, which is measured below. */
  const held = Object.entries(VARIANTS).filter(([vn, conf]) => {
    const c = G.connClrCeiling({ ...G.DEFAULTS, ...conf, pitch: 42 });
    return vn !== 'dovetail' && c.by !== 'snaptop' && c.max <= C.dovetail;
  }).map(([vn]) => vn);
  console.log(`  at 42 mm, past the dovetail's ${C.dovetail}: ` + (held.length
    ? `HELD TO IT: ${held.join(', ')}` : `every other joint but the snap from above, at its own ${C.snapTop}`));
  if (held.length) bad++;

  /* The snap from above and the puzzle's lobe are earned by their geometry, above. The
     rest were earned by open edges — a puzzle at 19 and a bowtie at 15 at 0.35, a puzzle
     key at 14 at 0.4 and at 42 at 0.82, the dovetail from 0.34 — and the joint's cut taken
     again when it comes out open (cutAgain in core.js) closes every one. So each was swept
     as connClrCeiling says: every 0.01 mm of pitch over its band and every 0.05 of the
     field past it, on both piece layouts, and every 0.01 near anything that leaked. The
     dovetail's step is open still, and is built with the other ends, above. Three more
     have a leak within two steps, two cells' shells sharing an edge in the band they
     overlap in, and the first is their row: it has to leak still, or that ceiling can go
     up. The puzzle's leak runs on past 20 mm as a line, and its band with it to 20.7.
     The line's first leak past 20 is a row, with the step under it, which has to build
     closed so the row stays on the line; so is the field's own 1 mm on the line, which
     the band has to reach past. The bowtie in the floor below 20 mm leaked nowhere up to
     1.05 and takes the plain 1 mm; its step to spare has to build closed, or cutAgain
     has lost ground. A row that has to build closed says why. Each has to be refused by
     the field. */
  const PAST = [
    ['snap from above, 0.35 at 42', { connector: 'snap', keyInsert: 'top', pitch: 42, clr: 0.35 }, '2x2 pieces'],
    ['puzzle, 0.3 at 13.5', { connector: 'puzzle', pitch: 13.5, clr: 0.3 }, '1-cell pieces'],
    ['puzzle, 0.38 at 18.54', { connector: 'puzzle', pitch: 18.54, clr: 0.38 }, '1-cell pieces'],
    ['puzzle, 0.85 at 20.05', { connector: 'puzzle', pitch: 20.05, clr: 0.85 }, '1-cell pieces'],
    ['puzzle, 0.8 at 20.05', { connector: 'puzzle', pitch: 20.05, clr: 0.8 }, '1-cell pieces',
      'the step under the line'],
    ['puzzle, 1 at 20.53', { connector: 'puzzle', pitch: 20.53, clr: 1 }, '1-cell pieces'],
    ['puzzle key, 0.37 at 18.07', { connector: 'puzzlekey', pitch: 18.07, clr: 0.37 }, '1-cell pieces'],
    ['puzzle key, 0.85 at 29.74', { connector: 'puzzlekey', pitch: 29.74, clr: 0.85 }, '1-cell pieces'],
    ['bowtie, 1.05 at 18', { connector: 'bowtie', pitch: 18, clr: 1.05 }, '2x2 pieces', 'a step to spare'],
  ];
  for (const [what, o, ln, closed] of PAST) {
    const r = buildAll({ ...PIECE_LAYOUTS[ln](o.pitch), ...o });
    /* A snap from above earns its ceiling in the seam face, before anything crosses the
       seam: one step past, its slot's wall is nearer the face than a BLOAT. */
    const face = { near: Infinity, sites: 0 };
    if (o.keyInsert === 'top') {
      const H = G.platePad(r.cfg) + r.cfg.plateHeight;
      r.pieces.forEach((polys, i) => seamGap(face, what, polys, G.pieceConnectors(r.cfg, r.L,
        r.L.pieces[i]).keyed.map((st) => ({ ...st, clr: r.cfg.key.clr })), H));
    }
    const inFace = face.sites > 0 && face.near < BLOAT - 1e-6;
    const still = r.bad > 0 || r.beyond > OVER || inFace;
    const most = G.connClrCeiling(r.cfg).max, refused = o.clr > most + 1e-9;
    console.log(`  ${what.padEnd(28)} ${r.beyond > OVER ? `${r.beyond} mm into the next piece`
      : inFace ? `its slot ${(Math.round(face.near * 1e4) / 1e4 + 0).toFixed(3)} mm off the seam face`
      : leakText(r)}` +
                (!refused ? `   THE FIELD TAKES IT: the ceiling went up to ${most}`
                  : closed ? (still ? `   OPEN — no longer ${closed}` : ` — closed, ${closed}`)
                  : still ? ' — the ceiling is earned' : '   NOW CLEAN — that ceiling can go up'));
    if (!refused || (closed ? still : !still)) bad++;
  }

  /* activeJoint in src/ui.js, with the field at the ceiling — a fixture, as in the coupon
     section above, reading the same two functions the page does. */
  const H = 4.25;
  const couponOf = (conf, field) => {
    const cfg = { ...G.DEFAULTS, ...conf };
    const fit = G.fitClearances(field);
    for (const j of ['tab', 'key', 'hclip', 'puzzle']) cfg[j] = { ...G.DEFAULTS[j], clr: fit[j] };
    const top = G.fitClearances(G.connClrCeiling(cfg).max);
    const kind = G.jointKind(cfg.connector, cfg.keyMount, cfg.keyInsert);
    if (!['bowtie', 'puzzlekey', 'snap', 'hclip'].includes(cfg.connector)) {
      const puzzle = cfg.connector === 'puzzle';
      return { cfg, keyed: false, joint: { kind, pad: 0, clr: puzzle ? fit.puzzle : fit.tab,
                                           clrMax: puzzle ? top.puzzle : top.tab } };
    }
    const hclip = cfg.connector === 'hclip';
    /* The dimensions as activeKeyDims gives them, which asks where the key is housed and
       not how it goes in: a snap clip dropped in from above, wall-mounted, has keySlim.
       This took keySlim only where the clearance is the slim key's own, and so built that
       coupon with the full key. Nothing measured here could tell: the snap's slot is cut
       from snapTopPrm and the clearance alone, its pad is 2.0 deep either way, and the
       loose key laid beside the tiles is watertight at both sizes. */
    const prm = hclip ? G.hclipPrm(cfg.hclip)
      : cfg.keyMount === 'wall' ? { ...G.DEFAULTS.keySlim } : { ...cfg.key };
    if (cfg.keyInsert === 'top' && (hclip || cfg.keyMount === 'wall')) prm.depth = 2.0;
    // only a key whose clearance is its own, which the field does not move, has no ceiling
    const slim = kind !== 'snaptop' && !hclip && cfg.keyMount === 'wall';
    const shape = hclip ? 'snap' : cfg.connector;
    return { cfg, keyed: true, joint: { kind, shape, prm, pad: prm.depth + 0.8,
      clr: kind === 'snaptop' ? fit.key : prm.clr,
      clrMax: slim ? Infinity : hclip ? top.hclip : top.key,
      part: G.buildKey(shape, prm, prm.depth - 0.15) } };
  };
  const met = [];
  for (const [name, [conf, most]] of ceilings) {
    const { cfg, keyed, joint } = couponOf(conf, most);
    const s = G.buildFitSample(cfg, H, joint);
    const leaks = G.checkManifold(s.polys).bad;
    const apart = new Set(s.clrs.map((c) => c.toFixed(3))).size === s.clrs.length;
    const under = s.clrs.every((c) => c <= joint.clrMax + 1e-9);
    /* buildFitSample's tiles are 18 wide and 7 apart, each pair 0.6 either side of its
       seam, with the loose part after the last. A tab or a lobe crosses that gap by
       design; a key's housing never should. */
    const tilesEnd = (s.clrs.length - 1) * 25 + 18;
    let inGap = 0;
    if (keyed) for (const p of s.polys) for (const v of p.verts)
      if (v[0] <= tilesEnd + 1e-6 && Math.abs(v[1]) < 0.6 - 1e-6) inGap++;
    // and each pair's two housings, one either side of the gap at that pair's clearance
    const unseen = joint.kind === 'snaptop' && !seamGap(offSeam.coupon, name, s.polys,
      s.clrs.flatMap((clr, i) => [{ edge: '+y', e: -0.6, s: i * 25 + 9, clr },
                                  { edge: '-y', e: 0.6, s: i * 25 + 9, clr }]), H);
    if (leaks || !apart || !under || inGap || unseen)
      met.push(`${name}: pairs ${s.clrs.map((c) => c.toFixed(2)).join('/')}` +
               (under ? '' : ` OVER ${joint.clrMax.toFixed(2)}`) + (apart ? '' : ' NOT FOUR FITS') +
               (inGap ? `, ${inGap} vertices IN THE SEAM GAP` : '') + (leaks ? `, ${leaks} BAD EDGES` : '') +
               (unseen ? ', NO SNAP HOUSING FOUND TO MEASURE' : ''));
  }
  console.log(`  fit coupons at ${ceilings.size} ceilings: ` +
              (met.length ? `FAIL: ${met.join('; ')}` : 'pairs at or under each, apart, watertight'));
  bad += met.length;

  const { plate, coupon } = offSeam;
  const clear = (m) => m.sites > 0 && m.near >= BLOAT - 1e-6;
  // rounded, and + 0 so a wall in the face reads 0.000 rather than -0.000
  const said = (m) => m.sites ? `${(Math.round(m.near * 1e4) / 1e4 + 0).toFixed(3)} mm on ${m.sites} housings`
                              : 'NO HOUSING MEASURED';
  console.log(`  snap from above, its slot off the seam face: ${said(plate)} of the plate, ` +
              `${said(coupon)} of the coupon` +
              (clear(plate) && clear(coupon) ? `, a BLOAT (${BLOAT}) or more` : `   UNDER A BLOAT (${BLOAT}): ` +
               [plate, coupon].filter((m) => m.sites && !clear(m)).map((m) => m.at).join('; ')));
  bad += [plate, coupon].filter((m) => !clear(m)).length;
}

/* Fewest plates, on a drawer too big for its search.
 *
 * It searched every split pattern of every row and column with no ceiling on the grid,
 * and at a small pitch a big drawer is a big grid: 2000 × 2000 mm at 13.5 is 148 × 148
 * cells, and the page froze for good in the first computeLayout. Over PLATE_MAX_CELLS it
 * now falls back to the balanced split, which is what the page refuses to build there
 * anyway; under it, the plans are exactly the ones it always produced, and the drawers
 * below pin a few of those down. A 1000 × 600 drawer on a 256 mm bed used to throw
 * outright — there was no split pattern within the search's own limits for its columns
 * and it read the first element of an empty list. */
console.log('\nFewest plates stays quick, and keeps its plans:');
{
  const time = (o) => {
    const cfg = Object.assign({}, G.DEFAULTS, { splitMode: 'plates' }, o);
    const t0 = Date.now();
    let L = null, err = null;
    try { L = G.computeLayout(cfg); } catch (e) { err = e.message; }
    return { L, err, ms: Date.now() - t0 };
  };
  for (const o of [{ drawerW: 2000, drawerD: 2000, bedW: 800, bedD: 800, pitch: G.PLATE_RANGES.pitch.min },
                   { drawerW: 1200, drawerD: 1000, bedW: 350, bedD: 350, pitch: G.PLATE_RANGES.pitch.min },
                   { drawerW: 1000, drawerD: 600, bedW: 256, bedD: 256 }]) {
    const t = time(o);
    const good = !t.err && t.ms < 2000 && t.L.pieces.length > 0;
    console.log(`  ${o.drawerW} × ${o.drawerD} at ${o.pitch || 42} mm on a ${o.bedW} mm bed: ` +
                (t.err ? `THREW ${t.err}` : `${t.L.nx} × ${t.L.ny} cells, ${t.L.pieces.length} pieces in ${t.ms} ms`) +
                (good ? '' : '   FAIL'));
    if (!good) bad++;
  }
  const PLANS = [
    [{ drawerW: 306, drawerD: 380, bedW: 256, bedD: 256, connector: 'dovetail' }, [6], [[5], [5]]],
    [{ drawerW: 400, drawerD: 400, bedW: 180, bedD: 180, connector: 'dovetail' }, [3, 7, 8],
     [[3, 6, 8], [3, 6, 8], [3, 7], [3, 7]]],
    [{ drawerW: 500, drawerD: 300, bedW: 256, bedD: 256, connector: 'dovetail' }, [5], [[4, 10], [5, 6]]],
    [{ drawerW: 600, drawerD: 450, bedW: 256, bedD: 256, connector: 'none' }, [3, 9],
     [[5, 11], [5, 11, 13], [5, 11]]],
    [{ drawerW: 800, drawerD: 800, bedW: 256, bedD: 256, connector: 'dovetail' }, [6, 12, 18],
     [[6, 12, 18], [6, 12, 18], [6, 12, 18], [6, 12, 18]]],
    [{ drawerW: 600, drawerD: 450, bedW: 256, bedD: 256, connector: 'none', pitch: 30 }, [8],
     [[8, 16], [8, 16]]],
  ];
  let same = 0;
  for (const [o, rows, cols] of PLANS) {
    const t = time(o);
    const ok = !t.err && JSON.stringify(t.L.rowCuts) === JSON.stringify(rows) &&
               JSON.stringify(t.L.colCuts) === JSON.stringify(cols);
    if (ok) same++;
    else console.log(`  ${JSON.stringify(o)} CHANGED: ${t.err || JSON.stringify([t.L.rowCuts, t.L.colCuts])}`);
  }
  console.log(`  ${same}/${PLANS.length} reference drawers split exactly as before`);
  if (same !== PLANS.length) bad++;
}

/* Piece names past Z. The ids were String.fromCharCode(65 + column), which runs on into
   '[', '\\' and the lower case — a 33-column split named a piece "\\1", and the backslash
   went into the STL file name. Spreadsheet columns instead: Z, AA, AB … */
console.log('\npiece names past Z:');
{
  const want = { 0: 'A', 25: 'Z', 26: 'AA', 27: 'AB', 51: 'AZ', 52: 'BA', 701: 'ZZ', 702: 'AAA' };
  const wrong = Object.entries(want).filter(([n, s]) => G.pieceColumn(+n) !== s);
  const L = G.computeLayout(Object.assign({}, G.DEFAULTS,
    { drawerW: 1386, drawerD: 42, bedW: 50, bedD: 50 }));
  const ids = L.pieces.map((p) => p.id);
  const odd = ids.filter((id) => !/^[A-Z]+[0-9]+$/.test(id));
  const unique = new Set(ids).size === ids.length;
  console.log(`  ${Object.keys(want).length - wrong.length}/${Object.keys(want).length} columns named right; ` +
              `${ids.length} pieces in a row, ${ids[0]} … ${ids[ids.length - 1]}` +
              (odd.length ? `   BAD NAMES: ${odd.join(' ')}` : '') + (unique ? '' : '   DUPLICATE NAMES'));
  if (wrong.length || odd.length || !unique) bad++;
}

/* A part too big for the bed takes no other part with it.
 *
 * packPlates notes such a part as a plate of its own, marked `overflow`, and both pages
 * leave those plates out of the files and the plan — there is nothing on them to print.
 * But the plate was an empty one, and the parts after it were placed on the first plate
 * with room: that one. A 5 × 1 bin on a 180 mm bed took the three bins that fitted
 * with it, so they were in no file and the plan said "0 bins packed"; on the baseplates
 * page a piece that fitted went the same way as one that did not. */
console.log('\na part too big for the bed takes no other part with it:');
{
  const big = { id: 'big', w: 210, d: 42, h: 20, qty: 1 };
  const small = { id: 'small', w: 42, d: 42, h: 20, qty: 3 };
  for (const stack of [false, true]) {
    for (const bigFirst of [true, false]) {
      const items = bigFirst ? [big, small] : [small, big];
      const plates = G.packPlates(items, 180, 180, 3, { stack, bedH: 250 });
      const over = plates.filter((p) => p.overflow);
      const onOver = over.reduce((n, p) => n + p.placed.length, 0);
      const printed = plates.filter((p) => !p.overflow).flatMap((p) => p.placed.map((t) => t.id));
      const ok = over.length === 1 && over[0].overflow === 'big' && onOver === 0 &&
        printed.length === 3 && printed.every((id) => id === 'small');
      console.log(`  ${stack ? 'stacked' : 'side by side'}, ${bigFirst ? 'big part listed first' : 'big part listed last'}: ` +
        `${printed.length} of 3 printable parts on a plate that prints, ${onOver} on the overflow` +
        (ok ? '' : '   PARTS LOST'));
      if (!ok) bad++;
    }
  }
}

/* Plates from before half cells have to build the bytes they always did.
 *
 * Half cells went into the code every plate goes through — the margins gridCells hands
 * out, the region cuts and the socket ring in buildPiece — and a plate without them was
 * to come out of it unchanged, so a link or a saved drawer from before makes the same
 * files. Nothing else here would notice a plate that moved by a micron and stayed
 * watertight.
 *
 * Each row is a design and the first 16 hex digits of the SHA-256 of its pieces' STLs, in
 * order, as the engine before half cells built them. They cover the paths the change
 * touched: a margin on either side and none, margins custom and aligned, both mounting
 * kinds, skeleton, a split, and rounded corners. The last row asks for half cells in a
 * drawer with no room for them, and has to be the first row's bytes: no room means a
 * solid margin, exactly as before. A change that MEANS to alter these will fail here:
 * check that it should, then put in the digests this prints, and say so in the commit. */
console.log('\nplates without half cells build the same bytes:');
{
  const crypto = require('crypto');
  const OLD = [
    ['306 x 380, the page as it opens', { drawerW: 306, drawerD: 380, marginMode: 'auto' }, '48eb1e780f7cffce'],
    ['190 x 170, margin left and front', { drawerW: 190, drawerD: 170, marginMode: 'auto',
      alignX: 'start', alignY: 'start', connector: 'none' }, '0643a57626c1be52'],
    ['190 x 170, margin right and back', { drawerW: 190, drawerD: 170, marginMode: 'auto',
      alignX: 'end', alignY: 'end', connector: 'none' }, '37b5f305cc4da6dd'],
    // fanCentre moved four of its nine cells' bottom caps off a spoke a few thousandths from
    // a cutter's corner: the same bottom face fanned from another point, its area and the
    // volume unchanged. Then the screw's bores went out until their flats stood on the
    // sizes asked, the counterbore and the shank wider by design; then the counterbore the
    // magnet pocket from beneath holds whole was left out of the cut, the same pocket with
    // its faces no longer split by the head's walls (54138.661 mm³ to 54138.679)
    ['126 x 126, magnets and screws', { drawerW: 126, drawerD: 126, marginMode: 'custom',
      mLeft: 0, mRight: 0, mFront: 0, mBack: 0, magnets: true, screws: true }, 'e964beefa8b378bf'],
    ['140 x 140, corner pockets', { drawerW: 140, drawerD: 140, marginMode: 'auto',
      magnets: true, baseMode: 'bosses' }, '7088f24def428095'],
    ['168 x 180, skeleton', { drawerW: 168, drawerD: 180, marginMode: 'auto',
      plateStyle: 'skeleton', connector: 'none' }, '85f2999306d41bf9'],
    ['400 x 300, bowtie split', { drawerW: 400, drawerD: 300, marginMode: 'auto',
      connector: 'bowtie', keyType: 'bowtie' }, '055e2093ee5f3e27'],
    ['190 x 195, custom, rounded corners', { drawerW: 190, drawerD: 195, marginMode: 'custom',
      mLeft: 3, mRight: 5, mFront: 7, mBack: 9, outerRadius: 4 }, '0638c72a7fc0ac58'],
    ['306 x 380, half cells with no room', { drawerW: 306, drawerD: 380, marginMode: 'half' },
     '48eb1e780f7cffce'],
  ];
  const moved = OLD.map(([name, over, want]) => {
    const cfg = Object.assign({}, G.DEFAULTS, { magnets: false, screws: false, arcSegs: 6 }, over);
    const L = G.computeLayout(cfg);
    const h = crypto.createHash('sha256');
    for (const pc of L.pieces) h.update(Buffer.from(G.stlBinary(G.buildPiece(cfg, L, pc).polys, 'p')));
    const got = h.digest('hex').slice(0, 16);
    return got === want ? '' : `${name} now ${got}, was ${want}`;
  }).filter(Boolean);
  console.log('  ' + (moved.length ? 'CHANGED: ' + moved.join('; ')
    : `${OLD.length} designs, each the same STLs to the byte`));
  if (moved.length) bad++;
}

/* Every parameter in DEFAULTS is read by somebody.
 *
 * Two of the defects this file now covers were the same shape, and neither could fail a
 * test, because there is no assertion a dead parameter breaks. `cfg.outerRadius` and
 * `cfg.cornerRadii` were consulted through `piece.col` and `layout.cols`, which
 * computeLayout has never produced — four `undefined === 0` comparisons, and no plate this
 * project has ever exported had a rounded corner, while the page offered a control for it
 * and a hint about matching your drawer. `DEFAULTS.bowtie` was copied into state on every
 * clearance change and read by nothing at all; a bowtie's dimensions come from
 * `DEFAULTS.key`. Editing either one changed nothing and said nothing.
 *
 * So every cfg the cases above hand to core.js goes in through a Proxy that records which
 * keys were looked at, and the union has to cover DEFAULTS. It proves less than it sounds:
 * a key read and then ignored still counts, and a key only some configuration reaches needs
 * a case here that reaches it — which is why the manual-split case exists. But it is the
 * exact failure that got past everything else, and it costs one object wrapper. */
console.log('\nevery parameter in DEFAULTS is read by somebody:');
{
  const unread = Object.keys(G.DEFAULTS).filter((k) => !readKeys.has(k));
  console.log(`  ${Object.keys(G.DEFAULTS).length} keys, ${readKeys.size} read` +
              (unread.length ? `   NEVER READ: ${unread.join(', ')}` : '   none dead'));
  if (unread.length) bad++;
  /* The same question one level down, for the key whose value picks a different layout.
     marginMode was read by every case in this file while only two of its values were
     ever built, and the third adds geometry of its own: a mode no case reaches is the
     configuration-with-no-case ENGINE.md §5 calls worse than a quarantined one. */
  const MODES = ['auto', 'custom', 'half'];
  const unbuilt = MODES.filter((m) => !modesRead.has(m));
  console.log(`  marginMode: ${MODES.filter((m) => modesRead.has(m)).join(', ')} built` +
              (unbuilt.length ? `   NEVER BUILT: ${unbuilt.join(', ')}` : ''));
  if (unbuilt.length) bad++;
}

console.log(bad ? `\n${bad} case(s) FAILED` : '\nall plates watertight and every shell facing outwards');
process.exit(bad ? 1 : 0);
