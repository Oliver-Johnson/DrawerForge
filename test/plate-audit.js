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
     and here the turned cutters' cut throws: healCsgSeams' T-junction pass limit. Taken
     unguarded, that one try made the whole plate fail to build, where main builds it open.
     The throw is passed over, and the cutters nudged 1.7 microns, the try after it, close
     every cell left open here (3 to 9 edges a piece; main has 9 and folds on every piece).
     Engine-only again: the sites 2.5 mm in, at 15.5 mm. */
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
function buildAll(over) {
  const cfg = designCfg(over);
  const L = G.computeLayout(cfg);
  const built = L.pieces.map((pc) => G.buildPiece(cfg, L, pc));
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
 * threw and the cap, and the step either side in depth and pitch: every piece built, and
 * watertight. */
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
  for (const [label, over] of ROWS) {
    let r = null, err = null;
    try { r = buildAll({ ...PLATE, ...over }); } catch (e) { err = e.message; }
    console.log(`  ${label.padEnd(38)} ${err ? `THREW: ${err}` : `${r.pieces.length} pieces, ${leakText(r)}`}`);
    if (err || r.bad) bad++;
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
     the radius over cos(π/14) (its flats on the magnet); a screw's bores have their corners
     on its size. At 55 and 60 mm, each way in: the widest the page takes has to build
     watertight, and the first tenth past the rule has to be refused. */
  const reach = G.DEFAULTS.holeOffset - 0.5;
  const corner = { magnetD: (d) => Math.max(d / 2 + 0.1, d / 2 / Math.cos(Math.PI / 14)),
                   screwHoleD: (d) => d / 2, screwHeadD: (d) => d / 2 };
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
     open at the floor's height has its floor fanned again (fanCentre). */
  for (const [nm, o] of [['21.7 mm magnet at 55 mm', { pitch: 55, magnets: true, magnetD: 21.7 }],
                         ['22.2 mm screw shank at 56.5', { pitch: 56.5, screws: true, screwHoleD: 22.2, screwHeadD: 22.2 }],
                         ['10.1 mm magnet above, 47.91', { pitch: 47.91, magnets: true, magnetD: 10.1, magnetSide: 'top' }],
                         ['10.6 mm magnet below, 48.98', { pitch: 48.98, magnets: true, magnetD: 10.6 }],
                         ['11.1 mm magnet above, 48.55', { pitch: 48.55, magnets: true, magnetD: 11.1, magnetSide: 'top' }]]) {
    const r = buildAll({ drawerW: 2 * o.pitch, drawerD: 2 * o.pitch, ...o });
    console.log(`  ${nm.padEnd(28)} ${leakText(r)}`);
    if (r.bad) bad++;
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
  /* The clearance one step past its end, which leaked, and that was why the end is where
     it is. It no longer does: the joint's cut taken again when it comes out open
     (cutAgain in core.js) closes it, as it closes the steps past the ceilings below. So it
     has to stay closed, and the field has to go on refusing it: the cap stays where it is
     until a sweep says how far it can go, the dovetail every 0.01 mm of pitch and every
     0.05 of the field past 0.3, on both piece layouts, clean up to the new cap. */
  const past = buildAll({ ...split, connector: 'dovetail', clr: 0.35 });
  const capped = 0.35 > G.connClrCeiling({ ...G.DEFAULTS, connector: 'dovetail' }).max + 1e-9;
  console.log(`  ${'dovetail at 0.35 clearance'.padEnd(28)} ${leakText(past)}` +
              (!capped ? '   THE FIELD TAKES IT' : past.bad ? '   OPEN AGAIN — cutAgain no longer closes it'
                : ' — closed, and the cap waits on a sweep'));
  if (!capped || past.bad) bad++;

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
 * Then the step past each ceiling that set it, which has to be open or across the seam
 * still: if the engine closes one, this says that ceiling can go up (four are closed, and
 * wait on a sweep to say how far; see PAST below). It has to be past the
 * ceiling as well, refused by the field. A puzzle key in the floor loosened to 0.9 built
 * clean at 20, 30 and 42 and its step past, 0.82, leaked as before, so a ceiling moved
 * over the very number that earned it passed; now the field taking that number fails.
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

  /* The puzzle key in the floor's step is 0.82, the first clearance that leaked at every
     pitch measured from 20 to 60; a ceiling at or over it lets the field take it.

     The last four were earned by open edges alone, and the joint's cut taken again when
     it comes out open (cutAgain in core.js) closes all four. Those ceilings stay where
     they are until a sweep as fine as the one that found the small-pitch leaks says how
     far each can go: the joint every 0.01 mm over its pitch band and every 0.05 of the
     field past its ceiling, on both piece layouts, clean up to the new one. `waits` marks
     such a step: it has to stay closed, or cutAgain has lost ground, and the field still
     has to refuse it. */
  const PAST = [
    ['snap from above, 0.35 at 42', { connector: 'snap', keyInsert: 'top', pitch: 42, clr: 0.35 }, '2x2 pieces'],
    ['puzzle, 0.3 at 13.5', { connector: 'puzzle', pitch: 13.5, clr: 0.3 }, '1-cell pieces'],
    ['puzzle, 0.35 at 19', { connector: 'puzzle', pitch: 19, clr: 0.35 }, '2x2 pieces', 'waits'],
    ['bowtie, 0.35 at 15', { connector: 'bowtie', pitch: 15, clr: 0.35 }, '2x2 pieces', 'waits'],
    ['puzzle key, 0.4 at 14', { connector: 'puzzlekey', pitch: 14, clr: 0.4 }, '2x2 pieces', 'waits'],
    ['puzzle key, 0.82 at 42', { connector: 'puzzlekey', pitch: 42, clr: 0.82 }, '2x2 pieces', 'waits'],
  ];
  for (const [what, o, ln, waits] of PAST) {
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
    const still = r.open > 0 || r.beyond > OVER || inFace;
    const most = G.connClrCeiling(r.cfg).max, refused = o.clr > most + 1e-9;
    console.log(`  ${what.padEnd(28)} ${r.beyond > OVER ? `${r.beyond} mm into the next piece`
      : inFace ? `its slot ${(Math.round(face.near * 1e4) / 1e4 + 0).toFixed(3)} mm off the seam face`
      : leakText(r)}` +
                (!refused ? `   THE FIELD TAKES IT: the ceiling went up to ${most}`
                  : waits ? (still ? '   OPEN AGAIN — cutAgain no longer closes it'
                                   : ' — closed, and the ceiling waits on a sweep')
                  : still ? ' — the ceiling is earned' : '   NOW CLEAN — that ceiling can go up'));
    if (!refused || (waits ? still : !still)) bad++;
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
    // volume unchanged
    ['126 x 126, magnets and screws', { drawerW: 126, drawerD: 126, marginMode: 'custom',
      mLeft: 0, mRight: 0, mFront: 0, mBack: 0, magnets: true, screws: true }, '5b339b75bd8c513e'],
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
