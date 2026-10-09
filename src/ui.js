
/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
'use strict';
/* Drawerforge UI. Core geometry functions are in scope from the previous script tag. */
const $ = (id) => document.getElementById(id);
// "4 pieces", "1 piece" — never "4 piece(s)". Shared with the bins tool; see widgets.js.
const plural = DF.plural;

// ---------- state ----------
const state = Object.assign({}, DEFAULTS, {
  marginMode: 'auto', splitMode: 'balanced', rowCuts: null, colCuts: null,
});
let layout = null;
let builds = {};            // pieceId -> {polys, meta}
let buildToken = 0;
/* The filament price and the printer speed override, in panel 02. They are yours and not
   the design's, so ESTIMATE keeps them on this device, shared with the bins page, and they
   never reach the link or a saved drawer. A change redraws the figures and nothing else:
   the pieces are seconds of CSG, and a dearer spool changes none of them. */
const est = ESTIMATE.bind({ price: $('filPrice'), sym: $('filSym'), speed: $('printSpeed'),
                            err: $('filPriceErr') },
                          () => refreshEstimates());
/* The connector families, named once each. KEY_CONN is the three that take a flat key
   and offer the housing choice; KEYED adds the H-clip, whose clip is a loose part too —
   see keysStl for what the ZIP did while it kept its own shorter copy of that list.
   The membership tests were written out inline in six places between them. */
const KEY_CONN = ['bowtie', 'puzzlekey', 'snap'];
const KEYED = [...KEY_CONN, 'hclip'];
/* Where the key lives, and therefore which way it goes in. The insert control only
   exists for a wall-housed key: a floor-housed one is laid into a recess in the solid
   base and has nowhere to come down from. Both predicates are asked by the control
   visibility, the seam warning, the key dimensions, the README's assembly order and the
   joint the fit coupon is built to — five readers, and they have to be one answer. */
const keyInWall = () => state.connector === 'hclip' ||
  (KEY_CONN.includes(state.connector) && state.keyMount === 'wall');
const keyFromTop = () => keyInWall() && state.keyInsert === 'top';
const PIECE_COLORS = ['#4fc3e8','#e8b34f','#7fd8a5','#e88a8a','#b18ae8','#7fb5e8','#e8d47f','#8ae8d4'];

// ---------- read/write controls ----------
const numIds = ['drawerW','drawerD','bedW','bedD','bedH','mLeft','mRight','mFront','mBack',
  'pitch','outerRadius','bottomPad','topCutoff','magnetD','magnetH',
  'screwHoleD','screwHeadD','screwHeadDepth','infill'];
// the ones readControls reads after the rest, in this order (see there)
const MOUNT_LAST = ['magnetH', 'screwHeadDepth', 'screwHoleD', 'screwHeadD', 'magnetD'];

/* The fields that carry a real-world size, and the range one can be.
 *
 * Nothing downstream defends itself against a number that cannot exist, and it should
 * not have to. A drawer width of -50 produced a piece 50 mm wide in the negative
 * direction: a pieces row reading "-50.0 × 211.0 … fits", an SVG rect the browser
 * rejected with a console error, "building 0/2…" that was never going to finish, and
 * the Download button offered as the primary action for a plate that could never be
 * built. A blank field did the same. So the clamp happens here, before computeLayout
 * sees anything, and the message says what is actually wrong — the checks below reason
 * about the clamped value, which is why they answered a negative width with "Drawer
 * smaller than one 42 mm cell", a true statement about a different problem.
 *
 * The typed value is left alone. Rewriting the field as you type takes the caret with
 * it and puts "306" out of reach behind "30", so state gets the clamp and the field
 * keeps what you wrote with the reason underneath it. `min` and `max` go on the markup
 * as well, so the browser's own validity — which reported `valid` for -50 — agrees. */
/* Every other field that reaches the geometry is here too, because each of them built a
   broken file while Download stayed on: a blank magnet depth read as 0 and cut a pocket
   whose roof was the plate's floor; a rim cutoff of 0 left a rim of no width; a margin
   of -100 laid a 378 mm grid into a 306 mm drawer; 1e308 anywhere reached the mesh as
   Infinity. The numbers themselves come from core.js PLATE_RANGES and mountLimits,
   which say why each one is where it is; this adds the words.
 *
 * `max` may be a function, for a range that depends on the rest of the design — a
 * margin cannot exceed the drawer, a magnet pocket has to fit the cell the pitch makes.
 * `when` says whether the field is in play: magnet sizes are not checked with magnets
 * off, nor margins outside Custom, because a complaint about a field you cannot see is
 * one you cannot act on. `why` finishes the too-big message where "check the figure is
 * in millimetres" would be the wrong advice, and `off` names the switch that drops a cut
 * the pitch has no room for. `gaps` are sizes under `max` refused all the same, as
 * [from, to] with both ends taken. */
const RANGES = PLATE_RANGES;
const customMargins = () => state.marginMode === 'custom' && !state.noMargin;
/* The sizes a joint's cut in the floor leaves room for depend on where the seams are and
   on the clearance, so mountLimits takes the layout, and readControls reads the mounting
   sizes after everything that moves either. The layout is worked out once for a read, the
   first time a size needs it, and recomputeLayout keeps that one rather than working it
   out again: none of the mounting sizes moves it. In Fewest plates mode one is a search,
   about 100 ms, and with magnets on a keystroke ran three. The answer is kept meanwhile,
   for the range and the reason alike. */
let mountNow = null, mountLayout = null;
const mount = () => mountNow ||
  (mountNow = mountLimits(state, mountLayout || (mountLayout = computeLayout(state))));
// how deep a pocket goes: only a corner boss caps it, which needs no layout
const mountDepth = () => mountLimits(state).depth;
// "an 18 mm pitch", "an 80 mm pitch": the article goes by how the number is said
const atPitch = () => `at ${/^(8|1[18](\.|$))/.test(String(state.pitch)) ? 'an' : 'a'} ` +
  `${state.pitch} mm pitch`;
// a joint's cut in the floor, as the messages name it: "the notches the dovetail tabs fit into"
const cutsNamed = () => `${['dovetail', 'puzzle'].includes(state.connector) ? 'notches' : 'recesses'} the ` +
  `${CONNECTOR_NAMES[state.connector]} fit into`;
/* Why `field` stops where it does. A joint's cut stops it in one of the ways mountLimits'
   `joint` names: a pocket from beneath as deep as a dovetail's notch, a magnet or screw
   that would reach the tab in one, a pocket any wider coming too near the notch's edge,
   or any other hole breaking into the cut. The hint about keys put in from above is not
   given with corner pockets: there is no solid floor under them, and such a key's cup
   stands into a boss's pocket (#75). Nor where the bosses are buried in the floor a
   joint needs (cornerBosses): a key put in from above, in the walls, needs none, so
   taking the hint would stand them up again, and the cup in their pockets. Only a floor
   asked for (bottomPad) keeps them buried whatever the joint. */
const mountWhy = (opens, field) => {
  const joint = mount().joint[field];
  const cuts = cutsNamed();
  return `${atPitch()} — mounting holes sit ` +
    `${state.holeOffset} mm from each cell centre, where the Gridfinity spec puts them, and ` +
    (joint === 'level' ? `a pocket ${field === 'magnetD' ? state.magnetH : state.screwHeadDepth} mm deep, ` +
        `as deep as the ${cuts}, has to stay out of them`
      : joint === 'part' ? `${{ magnetD: 'a magnet', screwHeadD: 'a screw head', screwHoleD: 'a screw' }[field]} ` +
        `has to stay clear of the ${CONNECTOR_NAMES[state.connector]} in the notches beside it`
      : joint === 'near' ? `a pocket any wider would come too near the edge of the ${cuts} to cut cleanly`
      : joint ? `a hole has to stay out of the ${cuts}`
      : mount().beside[field] ? 'a cell\'s four holes have to stay clear of each other'
      : cornerBosses(state) ? 'a pocket has to stay inside its corner boss'
      : opens ? 'a cut open to the socket has to stay on the socket floor'
      : 'a pocket under the floor has to stay inside its cell') +
    (joint && KEYED.includes(state.connector) && !keyFromTop() &&
     !(state.baseMode === 'bosses' && !(state.bottomPad > 0))
      ? `; keys ${keyInWall() ? '' : 'housed inside the walls and '}put in from above ` +
        'keep out of the solid floor under these pockets' : '');
};
// why a size under the largest is refused (mountLimits' `gaps`)
const nearWhy = () => `${atPitch()} — its pocket would come too near the edge of the ${cutsNamed()} to cut cleanly`;
// corner bosses only where they stand: over a floor the pockets are the floor's (cornerBosses)
const bossDepth = () => cornerBosses(state)
  ? 'with corner pockets — a boss is 2.6 mm tall, while the solid floor grows to suit' : '';
const LIMITS = {
  drawerW: { min: 1, max: 2000, label: 'Drawer width' },
  drawerD: { min: 1, max: 2000, label: 'Drawer depth' },
  bedW: { min: 20, max: 2000, label: 'Bed width' },
  bedD: { min: 20, max: 2000, label: 'Bed depth' },
  bedH: { min: 20, max: 2000, label: 'Bed height' },
  /* pitch divides into the drawer to get the cell count, so a zero here is not a bad
     plate, it is an infinite one — Math.floor(x / 0) is Infinity and the grid loops
     never come back. The floor is higher than that now: below it the joints leak. */
  pitch: { ...RANGES.pitch, label: 'Grid pitch',
    tooSmall: 'below that the sockets and joints no longer fit their cells, and the plate comes out with holes in it' },
  mLeft: { min: 0, max: () => state.drawerW, label: 'Left margin', when: customMargins,
    why: () => '— the drawer is only that wide' },
  mRight: { min: 0, max: () => state.drawerW, label: 'Right margin', when: customMargins,
    why: () => '— the drawer is only that wide' },
  mFront: { min: 0, max: () => state.drawerD, label: 'Front margin', when: customMargins,
    why: () => '— the drawer is only that deep' },
  mBack: { min: 0, max: () => state.drawerD, label: 'Back margin', when: customMargins,
    why: () => '— the drawer is only that deep' },
  bottomPad: { ...RANGES.bottomPad, label: 'Extra floor' },
  topCutoff: { ...RANGES.topCutoff, label: 'Rim cutoff',
    tooSmall: 'at 0 the rim between sockets is a face with no width, and the plate comes out open',
    why: () => '— past that a spec bin rides on the rim instead of seating in its socket' },
  magnetD: { ...RANGES.magnetD, max: () => mount().magnetD, label: 'Magnet Ø', when: () => state.magnets,
    why: () => mountWhy(state.magnetSide === 'top', 'magnetD'), off: 'magnet pockets',
    gaps: () => mount().gaps.magnetD },
  magnetH: { ...RANGES.magnetH, max: () => Math.min(RANGES.magnetH.max, mountDepth()), label: 'Magnet depth',
    when: () => state.magnets, why: bossDepth },
  screwHoleD: { ...RANGES.screwHoleD, max: () => mount().screwHoleD, label: 'Screw hole Ø',
    when: () => state.screws, why: () => mountWhy(true, 'screwHoleD'), off: 'screw holes',
    gaps: () => mount().gaps.screwHoleD },
  screwHeadD: { ...RANGES.screwHeadD, max: () => mount().screwHeadD, label: 'Screw head Ø',
    when: () => state.screws, why: () => mountWhy(false, 'screwHeadD'), off: 'screw holes',
    gaps: () => mount().gaps.screwHeadD },
  screwHeadDepth: { ...RANGES.screwHeadDepth, max: () => Math.min(RANGES.screwHeadDepth.max, mountDepth()),
    label: 'Screw head depth', when: () => state.screws, why: bossDepth },
  // each joint's ceiling is its own, so none is held to another's reason; see clrWhy
  connClr: { min: RANGES.connClr.min, max: () => connClrCeiling(state).max, label: 'Fit clearance',
    when: () => state.connector !== 'none', why: () => clrWhy(connClrCeiling(state)) },
};
/* What sets the clearance's ceiling, in words: core.js connClrCeiling decides it and says
   which reason applies. A ceiling that moves with the pitch names the pitch, as the mount
   sizes do, because that is the number to change, and the pitch its band runs up to,
   which for the puzzle is its own; 'slip' is the plain 1 mm and keeps the millimetres
   advice. The puzzle and the puzzle key said they opened holes in the plate, as they did
   until a joint's cut was taken again when it came out open (cutAgain in core.js); past
   each ceiling now two cells' shells share an edge at some pitches, which is not
   watertight either but is no hole. The dovetail said its pocket broke through into the
   socket beside it, which it does from 0.25, under its ceiling. */
const CLR_JOINT = { puzzle: 'puzzle tab', puzzlekey: 'puzzle key' };
const clrWhy = ({ by, below }) => ({
  dovetail: '— any looser and a dovetail pocket leaves the plate not watertight at some ' +
    'pitches',
  snaptop: '— any looser and the housing of a snap clip dropped in from above runs up to ' +
    'the seam and on into the next piece',
  pitch: `${atPitch()} — on cells under ${below} mm a ` +
    `looser ${CLR_JOINT[state.connector]} leaves the plate not watertight`,
  joint: `— any looser and a ${CLR_JOINT[state.connector]}'s recess leaves the plate not ` +
    'watertight at some pitches',
})[by] || '';
/* id -> the message that goes under it. Rebuilt from scratch on every read, so a field
   that has come good stops complaining without anything having to remember it once did. */
const fieldErrors = new Map();
// id -> the cut the pitch has no room for at all; a check on the design, see readNumber
const noRoom = new Map();
/* Named one field at a time rather than derived from the id: the build audits the
   template by literal, and $('errDrawerW') is what it looks for. Fields that sit in one
   row share the line under it. */
const ERR_FIELDS = [
  ['drawerW', 'errDrawerW'], ['drawerD', 'errDrawerD'],
  ['bedW', 'errBedW'], ['bedD', 'errBedD'], ['bedH', 'errBedH'], ['pitch', 'errPitch'],
  ['mLeft', 'errMargins'], ['mRight', 'errMargins'], ['mFront', 'errMargins'], ['mBack', 'errMargins'],
  ['bottomPad', 'errFloor'], ['topCutoff', 'errFloor'],
  ['magnetD', 'errMagnet'], ['magnetH', 'errMagnet'],
  ['screwHoleD', 'errScrew'], ['screwHeadD', 'errScrew'], ['screwHeadDepth', 'errScrew'],
  ['connClr', 'errConnClr'],
];
const ERR_EL = { errDrawerW: () => $('errDrawerW'), errDrawerD: () => $('errDrawerD'),
  errBedW: () => $('errBedW'), errBedD: () => $('errBedD'), errBedH: () => $('errBedH'),
  errPitch: () => $('errPitch'), errMargins: () => $('errMargins'), errFloor: () => $('errFloor'),
  errMagnet: () => $('errMagnet'), errScrew: () => $('errScrew'), errConnClr: () => $('errConnClr') };

const roundMm = (n) => +n.toFixed(2);
/* The size a half cell is quoted at: half the pitch, rounded UP to the hundredth. Checks
   rounds the room left over DOWN when it says there is no room for one, so the two figures
   can never come out equal. Rounded to the nearest, a half with a third decimal in it
   could: at a 42.01 mm pitch the page said "21 mm is left across … and a half cell needs
   21 mm", which is a contradiction in the one line meant to explain the gap. The menu and
   the README quote the same figure, so a half cell has one size wherever the page says it. */
const halfCellMm = () => Math.ceil(state.pitch / 2 * 100 - 1e-6) / 100;
/* The drawer's own measurements: the fields the unit switch in panel 01 converts. Every
   other number on the page — the bed, the pitch, magnet and screw sizes — stays in
   millimetres whatever the drawer was measured in, because millimetres are how every
   one of them is quoted. FIELDS.lengthOf hands back millimetres from either unit, so
   `state` and everything downstream of it never learn which one was typed. */
const LENGTH_IDS = ['drawerW', 'drawerD', 'mLeft', 'mRight', 'mFront', 'mBack'];
let unit = 'mm';   // what the length fields are showing; the saved choice is applied at boot

function readNumber(id) {
  const lim = LIMITS[id];
  const len = LENGTH_IDS.includes(id);
  const v = len ? FIELDS.lengthOf($(id), unit) : parseFloat($(id).value.trim());
  if (!lim) return isFinite(v) ? v : 0;
  /* Out of play, a field keeps its fixed range but not the one the rest of the design
     sets, and does not complain: magnets off at a 30 mm pitch should not quietly shrink
     the magnet size the link carries, to be found smaller when they go back on. */
  const inPlay = !lim.when || lim.when();
  const lo = lim.min;
  let hi = typeof lim.max !== 'function' ? (lim.max ?? Infinity) : inPlay ? lim.max() : Infinity;
  /* A range with nothing in it: the pitch leaves no room for a pocket of any size. No
     number in this field answers that — a screw hole at a 34 mm pitch is refused at 1 mm
     as at 3 — and putting it on the field left one whose maximum sat under its minimum,
     red whatever it held. So it is a check on the design instead, under the cut map,
     naming what does fix it; and the field keeps only its fixed range meanwhile, so the
     size a link carries is still there when the pitch comes back up. */
  if (hi < lo) {
    if (inPlay) noRoom.set(id, `${lim.label}: there is no room for one ${lim.why()}. ` +
      `Use a larger pitch, or turn off ${lim.off}.`);
    hi = Infinity;
  }
  /* The range is millimetres because the model is; in inches it is quoted in both, since
     "at least 1 mm" means nothing to the field you are typing inches into, and the
     millimetre figure is the one the tool actually holds you to. The advice for a huge
     number follows the unit too: typing millimetres into an inch field is the likeliest
     way to get one. The field's own min and max are in the unit it shows, as
     FIELDS.convert sets them, or the browser called a sound inch figure out of range. */
  const inch = len && unit === 'in';
  const both = (mm) => inch ? `${mm} mm (${FIELDS.inchText(mm)} in)` : `${mm} mm`;
  const unitName = inch ? 'inches' : 'millimetres';
  const shown = (mm) => String(inch ? mm / FIELDS.MM_PER_IN : mm);
  $(id).min = shown(lo);
  if (isFinite(hi)) $(id).max = shown(hi); else $(id).removeAttribute('max');
  const say = (msg) => { if (inPlay) fieldErrors.set(id, msg); };
  if (!isFinite(v)) {
    say(`${lim.label} is blank — enter a measurement in ${unitName}.`);
    return lo;
  }
  if (v < lo) {
    say(`${lim.label} must be at least ${both(lo)}` + (lim.tooSmall ? ` — ${lim.tooSmall}.` : '.'));
    return lo;
  }
  if (v > hi) {
    const why = lim.why && lim.why();
    say(`${lim.label} must be ${both(roundMm(hi))} or less ` +
        (why ? `${why}.` : `— check the figure is in ${unitName}.`));
    return hi;
  }
  /* A size under the largest can be refused as well, where its pocket would come too near
     the edge of a dovetail's notch (mountLimits' `gaps`); the sizes either side are taken.
     Two gaps can meet at one taken size, so the advice names the sizes taken round the
     run of gaps the size is in, inside the field's range: "Use 11.89 mm or less, 11.92 mm,
     or 11.95 mm or more" at 41.49 mm, never a size in the next gap, under the field's least
     or over its largest. */
  const gaps = inPlay && lim.gaps ? lim.gaps() : [];
  const at = gaps.findIndex(([a, b]) => v > a && v < b);
  if (at >= 0) {
    let i = at, j = at;
    while (i > 0 && gaps[i - 1][1] >= gaps[i][0] - 1e-9) i--;
    while (j < gaps.length - 1 && gaps[j + 1][0] <= gaps[j][1] + 1e-9) j++;
    const ok = [];
    if (gaps[i][0] > lo) ok.push(`${both(gaps[i][0])} or less`);
    else if (gaps[i][0] === lo) ok.push(both(lo));
    for (let k = i; k < j; k++) if (gaps[k][1] >= lo) ok.push(both(gaps[k][1]));
    ok.push(gaps[j][1] < hi ? `${both(gaps[j][1])} or more` : both(gaps[j][1]));
    say(`${lim.label} of ${both(v)} is refused ${nearWhy()}. Use ` +
        (ok.length > 1 ? `${ok.slice(0, -1).join(', ')}, or ${ok[ok.length - 1]}` : ok[0]) + '.');
    return gaps[at][0] >= lo ? gaps[at][0] : gaps[at][1];
  }
  return v;
}
/* The invalid state is set on the element rather than through a class, because the
   stylesheet is shared with the bins tool and is not this change's to edit. Colour is
   not carrying it on its own: aria-invalid says it to a screen reader and the message
   below the field says it in words. */
function showFieldErrors() {
  const lines = new Map();
  for (const [id, errId] of ERR_FIELDS) {
    const msg = fieldErrors.get(id) || '';
    $(id).setAttribute('aria-invalid', msg ? 'true' : 'false');
    $(id).style.borderColor = msg ? 'var(--red)' : '';
    if (!lines.has(errId)) lines.set(errId, []);
    if (msg) lines.get(errId).push(msg);
  }
  for (const [errId, msgs] of lines) {
    const out = ERR_EL[errId]();
    out.textContent = msgs.join(' ');
    out.hidden = !msgs.length;
  }
}

function readControls() {
  fieldErrors.clear(); noRoom.clear();
  /* The switches before the numbers: which ranges apply, and how wide they are, depend
     on them — see LIMITS. */
  state.alignX = $('alignX').value; state.alignY = $('alignY').value;
  const mm = $('marginMode').value;
  /* 'half' is kept as itself, not folded into 'auto' with the rest: it is the one
     computeLayout lays the strips of half cells for (halfStrips in core.js). A page from
     before it does not offer the value, so a link carrying it leaves that page's menu
     where it was (set() in loadFromHash) and the plate there has a solid margin. */
  state.marginMode = mm === 'custom' ? 'custom' : mm === 'half' ? 'half' : 'auto';
  state.noMargin = mm === 'none';
  state.connector = $('connector').value;
  state.keyType = KEY_CONN.includes(state.connector) ? state.connector : 'bowtie';
  state.keyMount = $('keyMount').value;
  state.keyInsert = $('keyInsert').value;
  state.baseMode = $('baseMode').value;
  state.plateStyle = $('plateStyle').value;
  state.tolerance = $('tolerance').value;
  state.magnets = $('magnets').checked;
  state.screws = $('screws').checked;
  state.magnetSide = $('magnetSide').value;
  for (const id of numIds) if (!MOUNT_LAST.includes(id)) state[id] = readNumber(id);
  if (state.noMargin) { state.marginMode = 'custom'; state.mLeft = state.mRight = state.mFront = state.mBack = 0; }
  // the per-corner radii need no range here: buildPiece caps each one at the socket's rim
  if ($('perCorner').checked) {
    state.cornerRadii = { ll: parseFloat($('rFL').value)||0, lr: parseFloat($('rFR').value)||0,
                          ul: parseFloat($('rBL').value)||0, ur: parseFloat($('rBR').value)||0 };
  } else state.cornerRadii = null;
  /* Read with the other numbers above; clamped here because it is a percentage and
     the estimate divides by 100, so a stray 900 would quote a mass nothing can print. */
  state.infill = Math.max(0, Math.min(100, state.infill));
  // `|| 0.2` made a clearance of 0 into 0.2, and let 100 through
  const fit = fitClearances(readNumber('connClr'));
  state.tab = Object.assign({}, DEFAULTS.tab, { clr: fit.tab });
  /* No state.bowtie: a bowtie is built from state.key like the other two keyed joints,
     and DEFAULTS.bowtie is gone. This line survived it by being harmless —
     Object.assign over undefined yields {} — which is exactly how a parameter block
     that configures nothing goes on looking like it configures something. */
  state.key = Object.assign({}, DEFAULTS.key, { clr: fit.key });
  state.hclip = Object.assign({}, DEFAULTS.hclip, { clr: fit.hclip });
  state.puzzle = Object.assign({}, DEFAULTS.puzzle, { clr: fit.puzzle });
  /* The mounting sizes last, since a joint's cut beside the sites moves with the margins,
     the split and the clearance (see mount). The magnet's is the very last, and measured
     again: a pocket from above meets a cut by how thick the floor is, which the screws
     and the magnet's own depth set. Only that step is taken again, on the same layout
     and the cuts already measured, unless the floor has moved (mountLimits' `known`). */
  mountNow = mountLayout = null;
  for (const id of MOUNT_LAST) {
    if (id === 'magnetD' && mountNow) mountNow = mountLimits(state, mountLayout, mountNow.cuts);
    state[id] = readNumber(id);
  }
  // and Checks says what is wrong in the panel's order, not the order it was read in
  for (const m of [fieldErrors, noRoom]) {
    const read = new Map(m);
    m.clear();
    for (const id of [...numIds, 'connClr']) if (read.has(id)) m.set(id, read.get(id));
  }
  // half cells keep the alignment: it places what is left after them
  $('alignRow').style.display = mm === 'auto' || mm === 'half' ? '' : 'none';
  $('halfHint').style.display = mm === 'half' ? '' : 'none';
  $('customMargins').style.display = mm === 'custom' ? '' : 'none';
  /* A half cell is half the pitch, and panel 06 can move the pitch: the menu said 21 mm
     whatever it was. Written only when it changes, so a screen reader is not told the
     menu changed on every keystroke elsewhere. */
  const halfOpt = $('marginMode').querySelector('option[value="half"]');
  const halfText = `Fill with half cells where they fit (${halfCellMm()} mm)`;
  if (halfOpt && halfOpt.textContent !== halfText) halfOpt.textContent = halfText;
  $('magRow').style.display = state.magnets ? '' : 'none';
  $('screwRow').style.display = state.screws ? '' : 'none';
  $('connHintDove').style.display = state.connector === 'dovetail' ? '' : 'none';
  $('connHintPuzzle').style.display = state.connector === 'puzzle' ? '' : 'none';
  // Bowtie and puzzle key shared one hint, so picking between them meant reading the
  // same paragraph twice and being told nothing about the difference. They differ in
  // one thing that matters — whether the key grips along the seam — so they say so.
  $('connHintBow').style.display = state.connector === 'bowtie' ? '' : 'none';
  $('connHintPkey').style.display = state.connector === 'puzzlekey' ? '' : 'none';
  $('connHintSnap').style.display = state.connector === 'snap' ? '' : 'none';
  $('connHintHclip').style.display = state.connector === 'hclip' ? '' : 'none';
  /* 'none' has no figure, and correctly shows nothing rather than the last one you
     looked at. Queried rather than held in a list so that adding a joint to
     tools/joints.js is enough -- a second list here could silently stop matching. */
  for (const fig of document.querySelectorAll('.connfig'))
    fig.style.display = fig.dataset.joint === state.connector ? '' : 'none';
  const hasKeys = KEY_CONN.includes(state.connector);
  $('keyMountRow').style.display = hasKeys ? '' : 'none';
  $('keyMountHint').style.display = hasKeys ? '' : 'none';
  // top-insert applies exactly where the key lives in the wall (see keyInWall)
  $('keyInsertRow').style.display = keyInWall() ? '' : 'none';
  $('keyInsertHint').style.display = keyInWall() ? '' : 'none';
  $('baseModeRow').style.display = (state.magnets || state.screws) ? '' : 'none';
  $('cornerRow').style.display = $('perCorner').checked ? '' : 'none';
  $('cornerHint').style.display = $('perCorner').checked ? '' : 'none';
  DF.hint($('plateStyleHint'), ...plateStyleHint());
  showFieldErrors();
}

/* The hint under Plate style was static, so with "Solid" selected the first word
   underneath it was "Skeleton" — it described the option you had not picked. It also
   sits on the first screen and is the first use of four terms nothing has defined:
   skeleton, socket, rim, wall band. The socket is the one you cannot guess from the
   word, so it is glossed here, once, in whichever hint is showing. The pitch is read
   from the state rather than written as 42, because panel 06 can move it.
   Two parts: the first sentence, which stays in view and carries the gloss, and the rest,
   behind the hint's "more" (DF.hint). */
function plateStyleHint() {
  const socket = `the socket, the ${state.pitch} mm recess a bin's foot drops into`;
  return state.plateStyle === 'skeleton'
    ? [`Skeleton keeps ${socket}, along with the rim round the outside of the plate and ` +
       'the band of wall between neighbouring cells, and leaves out the bulk underneath — ' +
       'lighter, and quicker to print.',
       'Cells carrying a joint stay solid, ' +
       'and it turns off entirely with magnets or screws, which need that material.']
    : [`Solid backs ${socket} with material all the way down to the drawer floor.`,
       'The sturdy default: the heaviest and slowest to print, and the only style that ' +
       'works with magnets, screws, or a joint that needs a floor to house its keys.'];
}

// ---------- layout & validation ----------
/* `ev` is the input or change event when a field called this directly — the undo
   history uses it to tell typing apart from a discrete edit. Every other caller passes
   nothing, and each of those is a discrete edit. */
function recomputeLayout(ev) {
  readControls();
  layout = mountLayout || computeLayout(state);   // the one the sizes were read against, if any
  // clamp stored manual cuts to the current grid
  if (state.splitMode === 'manual') {
    state.rowCuts = layout.rowCuts.slice();
    state.colCuts = layout.colCuts.map(c => c.slice());
  }
  drawMap();
  drawWarnings();
  drawPieceTable();
  scheduleBuild();
  /* Here rather than in readControls: this is where a change has settled into a layout,
     and readControls also runs on paths that are only reading the panel back. */
  rememberState();
  noteDesignChange(ev);
}

/* The margins as the page quotes them: the plain plastic past the cells, half cells
   included. computeLayout counts a strip of half cells into mR and mB (gridCells in
   core.js), because to the bed check and the split that is width the piece takes, and
   that is right for them. "R 21.5 mm" beside "plus a half column on the right" would say
   the column is margin, so the summary, the export dialog and the README take it back
   out. With no strip each is the layout's own number, unchanged. */
function solidMargins() {
  const h = state.pitch / 2;
  return [layout.mL, layout.mR - layout.hX * h, layout.mF, layout.mB - layout.hY * h];
}
// "a half column on the right and a half row at the back", or '' with neither
function halfStripText() {
  const parts = [];
  if (layout.hX) parts.push('a half column on the right');
  if (layout.hY) parts.push('a half row at the back');
  return parts.join(' and ');
}
// a piece's cells, "4 × 3", with a ½ on the side that carries a strip of half cells
const cellsOf = (pc, sep = ' × ') => `${pc.nx}${pc.hR ? '½' : ''}${sep}${pc.ny}${pc.hB ? '½' : ''}`;

/* The bed room a piece actually needs: its plate, plus the dovetail tabs that stick
   out past it. One function, because the export dialog reports the largest piece and
   has to be quoting the same number the fit test used — otherwise it can call a piece
   174 mm wide and reject it against a 256 mm bed in the same breath. */
function pieceExtent(pc) {
  const pitch = state.pitch;
  const ext = state.connector === 'dovetail' ? state.tab.dp + 0.4 : 0;
  return [pc.mL + pc.nx*pitch + pc.mR + ext, pc.mF + pc.ny*pitch + pc.mB + ext];
}
function footprintFits(pc) {
  const [w, d] = pieceExtent(pc);
  return w <= state.bedW + 1e-6 && d <= state.bedD + 1e-6;
}
/* The bed has three dimensions and only two were checked. An extra floor of 300 mm made
   a 304 mm plate, the print plan quietly packed it onto nothing — four empty plates —
   and the dialog said every piece fit while quoting 10 kg of PLA. The height is known
   before anything is built: it is the floor platePad works out, under the profile. */
const plateHeightMm = () => platePad(state) + state.plateHeight;
const heightFits = () => plateHeightMm() <= state.bedH + 1e-6;
function pieceFits(pc) {
  return footprintFits(pc) && heightFits();
}

/* How big a job this tool will take on in one go.
   There was no ceiling at all. A drawer of 9999 × 9999 mm — one stray keystroke away
   from 999 — gave a 238 × 238 grid, 1600 pieces, and a build that started working
   through them one real CSG at a time with nothing on the page to say it would not
   finish. Both numbers are well past any drawer: MAX_CELLS is a 1.26 m square of grid
   at the spec pitch, MAX_PIECES more separate prints than anyone is going to run.
   MAX_CELLS is core.js's, because the Fewest plates search has to stop at it too.

   MAX_PIECE_CELLS is the same idea for one piece, which is one synchronous build: the
   bed fields go to 2 m, so a 1260 mm drawer on a "2000 mm bed" was one 900-cell piece,
   22 s with the page frozen and a 189 MB STL at the end. 24 × 24 cells is a metre
   square at the spec pitch — bigger than any printer's bed. */
const MAX_CELLS = PLATE_MAX_CELLS, MAX_PIECES = 60, MAX_PIECE_CELLS = 576;
const overCap = () => !!layout &&
  (layout.nx * layout.ny > MAX_CELLS || layout.pieces.length > MAX_PIECES);

/* `err` marks a check that stops the build. `stop` is the narrower kind that also
   takes the Download button away: there is no design at all, so the dialog would have
   nothing to describe. A piece that overflows the bed is an `err` but not a `stop` —
   the design exists, the dialog explains the overflow in a sentence the checks cannot,
   and the test tile and joint sample in there are exactly what you want next. */
function warningsList() {
  const out = [];
  // first, and above everything: these say what is wrong with what you typed, which
  // nothing below can — every check after this one is reasoning about the clamped value
  for (const msg of fieldErrors.values()) out.push({ err: true, stop: true, t: msg });
  for (const msg of noRoom.values()) out.push({ err: true, stop: true, t: msg });
  /* A piece the engine threw on. runBuild stops there, and the piece table, the preview and
     the Download button's tooltip said so, but the checks, which are where a design is read
     for what is wrong with it, said nothing: #76's B1 left Download off with no reason
     under the cut map. Drawn as an error but not flagged `err`, which would stop the next
     build as well, and the next build, on any change, is what clears it. It says Download
     is off, not that nothing can be downloaded: the pieces built before it keep their own
     STL buttons in the piece table. And it promises no size that gets past it: a size a
     hundredth off one that fails can build with holes, as the 41.24 mm jigsaw plate in
     plate-audit.js did at 7.502 mm on main, beside a 7.504 mm head that failed. */
  if (buildFailed)
    out.push({ failed: true, t: `Piece ${buildFailed} could not be built, so the build stopped ` +
      'there and Download is off. That is a fault in this tool, not in the design; moving a cut ' +
      'through the piece or picking another joint may get past it.' });
  if (layout.nx * layout.ny > MAX_CELLS)
    out.push({ err: true, stop: true, t: `A ${layout.nx} × ${layout.ny} grid is ` +
      `${layout.nx * layout.ny} cells, past the ${MAX_CELLS} this tool will build in one ` +
      'go — and far larger than a drawer. Check the measurements are in millimetres.' });
  else if (layout.pieces.length > MAX_PIECES)
    out.push({ err: true, stop: true, t: `This split makes ${layout.pieces.length} pieces, ` +
      `past the ${MAX_PIECES} this tool will build in one go. A larger printer bed, or ` +
      'fewer cuts on the map, brings it back down.' });
  else {
    const big = layout.pieces.find((pc) => pc.nx * pc.ny > MAX_PIECE_CELLS);
    if (big)
      out.push({ err: true, stop: true, t: `Piece ${big.id} is ${big.nx} × ${big.ny} = ` +
        `${big.nx * big.ny} cells, past the ${MAX_PIECE_CELLS} this tool will build as one ` +
        'piece — no printer bed is that big. Check the bed size, or add cuts on the map.' });
  }
  // suppressed when the drawer fields are already complaining: "smaller than one cell"
  // is true of the clamped value and useless as a diagnosis of a blank or negative one
  const tooSmall = !fieldErrors.has('drawerW') && !fieldErrors.has('drawerD') &&
      (layout.nx < 1 || layout.ny < 1 || state.drawerW < state.pitch || state.drawerD < state.pitch);
  if (tooSmall)
    out.push({ err: true, stop: true, t: `Drawer smaller than one ${state.pitch} mm cell — nothing to generate.` });
  /* Each custom margin can be inside the drawer while the pair of them leaves no room
     for a cell. computeLayout puts one there regardless and hands the far margin what
     is left, which is then a negative width. */
  else if (customMargins()) {
    const freeW = state.drawerW - state.mLeft - state.mRight;
    const freeD = state.drawerD - state.mFront - state.mBack;
    if (freeW < state.pitch - 1e-6)
      out.push({ err: true, stop: true, t: `The left and right margins leave ${roundMm(freeW)} mm ` +
        `of the drawer's width — not enough for one ${state.pitch} mm cell.` });
    if (freeD < state.pitch - 1e-6)
      out.push({ err: true, stop: true, t: `The front and back margins leave ${roundMm(freeD)} mm ` +
        `of the drawer's depth — not enough for one ${state.pitch} mm cell.` });
  }
  for (const pc of layout.pieces) if (!footprintFits(pc))
    out.push({ err: true, t: `Piece ${pc.id} (${(pc.mL+pc.nx*state.pitch+pc.mR).toFixed(0)} × ${(pc.mF+pc.ny*state.pitch+pc.mB).toFixed(0)} mm) exceeds the ${state.bedW} × ${state.bedD} bed — add a cut through it.` });
  if (!heightFits())
    out.push({ err: true, t: `The plate is ${roundMm(plateHeightMm())} mm tall, more than ` +
      `your printer's ${state.bedH} mm build height — lower the extra floor, or check the bed height.` });
  /* A key on each side of a piece one cell deep (or wide), facing each other. Their
     housings run into each other below about 14.35 mm and the plate leaks; keysMeet in
     core.js has the measurements and why this is refused rather than built. A moved cut,
     a larger pitch or another joint clears it, and the joints named are the ones
     jointsThatFit finds clear on this layout at a pitch they were measured to build clean
     at — test/plate-audit.js builds each of them across the range it refuses. Not on a
     grid past the caps above, which is refused already and would be thousands of housings
     to measure on every redraw. */
  if (!overCap()) {
    const meet = keysMeet(state, layout);
    if (meet.length) {
      const ids = meet.map((m) => m.id), one = ids.length === 1;
      const needs = Math.ceil(Math.max(...meet.map((m) => m.needs)) * 100 - 1e-6) / 100;
      const list = (xs) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
      // deep where the two seams are front and back, wide where they are left and right
      const dirs = [...new Set(meet.map((m) => m.across))];
      const dir = dirs.length === 1 ? dirs[0] : null;
      const pieces = (xs, P) => `${P}iece${xs.length > 1 ? 's' : ''} ` +
        (xs.length < 2 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
      /* Both ways at once says which piece is which. It said "Pieces A2 and B3 have one
         cell between two seams … Move a cut so they have two", which leaves you to work
         out which way each one is narrow. */
      const across = (way) => meet.filter((m) => m.across === way).map((m) => m.id);
      const is = dir ? `${pieces(ids, 'P')} ${one ? 'is' : 'are'} one cell ${dir}`
        : `${pieces(across('deep'), 'P')} ${across('deep').length > 1 ? 'are' : 'is'} one cell deep ` +
          `and ${pieces(across('wide'), 'p')} one cell wide`;
      const keyName = { bowtie: 'bowtie keys', puzzlekey: 'puzzle keys', snap: 'snap clips' }[state.connector];
      /* Each named the way it is set: the insert direction is part of the joint, and a
         snap clip goes in from above only from inside the walls, where the page has the
         insert control. The H-clip is named by its insert too, each way that clears, since
         picking H-clips keeps the Key insertion you had: it was named from beneath alone,
         and a key put in from above became an H-clip from above that Checks never named. */
      const JOINT = { dovetail: 'dovetail tabs', puzzle: 'puzzle tabs', hclip: 'H-clips put in from beneath',
                      'hclip top': 'H-clips put in from above',
                      'snap top': 'snap clips inside the walls, put in from above',
                      wall: `${keyName} inside the walls, put in from beneath`,
                      cup: `${keyName} inside the walls, put in from above` };
      // on a snap plate the snap clip from above is the key in use in the wall from above
      const ok = jointsThatFit(state, layout)
        .map((j) => (state.connector === 'snap' && j.id === 'snap top' ? 'cup' : j.id));
      // a joint both ways is one item, not the same words twice over
      if (ok.includes('wall') && ok.includes('cup'))
        JOINT.wall = `${keyName} inside the walls, put in from beneath or above`;
      if (ok.includes('hclip') && ok.includes('hclip top')) JOINT.hclip = 'H-clips put in from beneath or above';
      const fit = ok.filter((id) => !(id === 'cup' && ok.includes('wall')) &&
                                    !(id === 'hclip top' && ok.includes('hclip'))).map((id) => JOINT[id]);
      // items that have a comma of their own are kept apart with semicolons
      const named = fit.some((t) => t.includes(','))
        ? (fit.length < 2 ? fit.join('') : `${fit.slice(0, -1).join('; ')}; or ${fit[fit.length - 1]}`)
        : list(fit);
      out.push({ err: true, t: `${is} between two seams, and at this ${state.pitch} mm pitch ` +
        `the keys on ${one ? 'its' : 'their'} two sides are too close: their housings run into ` +
        'each other, which leaves holes in the plate. Move a cut so ' +
        (dir ? `${one ? 'it is' : 'they are'} two cells ${dir}` : 'each has two cells between its seams') +
        `, use a pitch of ${needs} mm or more` +
        (fit.length ? `, or use a joint that fits at ${state.pitch} mm: ${named}.` : '.') });
    }
  }
  if (layout.pieces.some(pc => pc.nx*pc.ny === 1 && !pc.hR && !pc.hB))
    out.push({ t: 'A piece is a single cell — printable, but consider moving a cut for a sturdier layout.' });
  /* One axis at a time. It fired on either and then printed both, so a drawer narrower
     than a single cell reported "Leftover space is large (-92 × 40 mm)" — the -92 being
     width the drawer does not have. And it stopped a step short of the advice: the
     guide has a section on exactly this, so the warning links to it rather than leaving
     "double-check the measurement" as the whole of what the tool knows. */
  /* Less any strip of half cells, which is that leftover put to use: with one in, what is
     left is under half a cell and there is nothing here to say. */
  const remX = state.drawerW - layout.nx*state.pitch - layout.hX*state.pitch/2;
  const remY = state.drawerD - layout.ny*state.pitch - layout.hY*state.pitch/2;
  const spare = [];
  if (remX > state.pitch * 0.75) spare.push(`${remX.toFixed(0)} mm across the width`);
  if (remY > state.pitch * 0.75) spare.push(`${remY.toFixed(0)} mm across the depth`);
  if (spare.length)
    out.push({ t: `Leftover space is large — ${spare.join(' and ')}, nearly another whole cell. ` +
      'Re-measure before you print; if the drawer really is that size, ' +
      '<a href="guide/drawer-sizes/#leftover">the guide covers what to do with the remainder</a>.' });
  /* Half cells asked for. With room for none, the plate has a solid margin, and says why
     in the drawer's own figures rather than leaving the menu looking ignored; with any,
     it says what they will and will not take, since neither shows on the cut map — a
     whole-size bin does not fit one, and buildPiece cuts no mounting holes in them. */
  if (state.marginMode === 'half' && !tooSmall &&
      !fieldErrors.has('drawerW') && !fieldErrors.has('drawerD')) {
    const down = (n) => Math.floor(n * 100 + 1e-6) / 100;
    if (!layout.hX && !layout.hY)
      out.push({ t: `No room for half cells: ${down(remX)} mm is left across and ` +
        `${down(remY)} mm deep, and a half cell needs ${halfCellMm()} mm.` });
    else
      out.push({ t: 'Half cells take half-size bins only, and have no magnet or screw holes.' });
  }
  const keyedC = KEY_CONN.includes(state.connector);
  if ((keyedC && state.keyMount === 'floor' || state.connector === 'puzzle') && layout.pieces.length > 1) {
    const padV = state.connector === 'puzzle' ? 2.6 : state.key.depth + 0.8;
    const what = state.connector === 'puzzle' ? 'the jigsaw lobes' :
      state.connector === 'snap' ? 'the snap clips' : 'the keys';
    out.push({ t: `This joint adds a ${Math.max(state.bottomPad, padV).toFixed(1)} mm solid floor to house ${what}. Prefer no floor? Pick a keyed joint and set Key housing to "Inside the walls".` });
  }
  /* Corner pockets over a floor. The bosses would stand inside it, their pockets sealed or
     cut short (#70), so core.js builds the plate as a solid floor builds it (cornerBosses),
     and says so here: the menu still reads "Corner pockets only". */
  if (state.baseMode === 'bosses' && (state.magnets || state.screws) && !cornerBosses(state))
    out.push({ t: `Corner pockets need an open underside, and ${jointFloor(state) > 0
      ? 'this joint is housed in a floor' : 'Extra floor closes it'}, so the plate is built with a solid floor and the ${
      state.magnets && state.screws ? 'magnet and screw' : state.magnets ? 'magnet' : 'screw'} pockets are cut into it.` });
  if (keyInWall() &&
      layout.seams.some(s => s.junctions.some(j => Math.abs(j - Math.round(j)) > 0.25)))
    out.push({ t: 'One seam overlaps by a single cell — wall-housed keys need a wall junction, so that seam gets no connector. The neighbouring joints still hold the assembly.' });
  if (state.plateStyle === 'skeleton') {
    if (state.magnets || state.screws)
      out.push({ t: 'Skeleton is off while magnets or screws are on — their pockets and bosses need the material a skeleton removes. Turn them off, or use Solid.' });
    else if (state.connector !== 'none')
      out.push({ t: 'Skeleton is applied to the inner cells only. Cells along each piece edge stay solid because that is where the joints cut in — pick "None" for joints to skeletonise the whole plate.' });
  }
  if (state.noMargin && (remX > 0.5 || remY > 0.5))
    out.push({ t: 'No margin selected: the plate will sit loose by the leftover amount. The drawer walls still contain it.' });
  return out;
}
const hasErrors = () => warningsList().some(w => w.err);
function drawWarnings() {
  const ws = warningsList();
  $('warnings').innerHTML = ws.map(w => `<div class="w${w.err || w.failed ? ' err' : ''}">${w.t}</div>`).join('');
  /* The Download button stops being the primary action when there is nothing behind it.
     It was enabled through all of this: type -50 into the drawer width and the page
     said "resolve the errors above to generate" and offered you the download in the
     same breath. See warningsList for why this is `stop` and not `err`. */
  const stop = ws.some(w => w.stop);
  $('openExport').disabled = stop || !!buildFailed;
  $('openExport').title = stop ? 'Fix the errors under the cut map first'
    : buildFailed ? `Piece ${buildFailed} failed to build — try different cuts` : '';
}

// ---------- interactive cut map ----------
function drawMap() {
  const svg = $('cutmap');
  const pitch = state.pitch;
  const Wmm = state.drawerW, Dmm = state.drawerD;
  // first, because it is in the heading the map's height is measured against
  $('mapTail').textContent = `${cellsOf({ nx: layout.nx, ny: layout.ny, hR: layout.hX, hB: layout.hY })} ` +
    `cells · ${plural(layout.pieces.length, 'piece')}`;
  /* Beside the preview or above it, by the bins map's rules and through the same
     helper (see DF.stageRow in widgets.js for the two traps it exists to avoid). A
     drawer more than 1.15 times as wide as it is deep keeps the whole stage width, as
     a wide bins grid does — 900 × 420 squeezed into half a row would be a smaller map
     to click cut lines on, which is the opposite of the point.
     The map used to measure #mapwrap, its own card. That card is now the column being
     sized from the map, so it is the row that gets measured: its width less the
     preview's minimum and the gap when paired, less the card's 30 px of chrome
     (#mapwrap's 14 px padding each side and the border) either way.
     The 680 × 460 caps are a ceiling, not a target, and they were fixed pixels: from
     2560 to 5120 px wide the map stayed 391 × 454 while the screen round it doubled.
     They now grow with a window taller than the 1080 lines they were set on (row.big
     — see DF.stageRow), so a 1440 screen gets a map a third bigger and a 1080 one is
     unchanged. The labels are drawn at a fixed size whatever the scale, so a bigger map
     is more room to click a cut line, not bigger type. */
  const PREVIEW_MIN = 320;
  const top = document.querySelector('.stagetop');
  top.classList.toggle('wide', Wmm / Math.max(1, Dmm) > 1.15);
  const row = DF.stageRow(top, $('stage'));
  const roomW = row.two ? row.width - row.gap - PREVIEW_MIN - 30 : row.width - 30;
  /* The height is also held to the stage you can see, as the bins map's is. Paired, the
     preview is as tall as this card, so with the Undo row under the map a 768 px window
     put the bottom of both 15 px under the window. The heading above the map and the
     Undo row below it are measured; the warnings are left out, because they come and
     go with the design, and a map that changed size as they did would be worse than a
     warning you scroll to. Below the map is measured down to the top of the warnings,
     not to the bottom of the card: paired, the card is stretched to the row, so its
     bottom is wherever the last draw left the preview. Never under 300 px: a short
     window scrolls a little rather than shrinking the thing you click cut lines on. The
     1 is the card's bottom border.
     It is sized twice when paired. stageRow has just taken the columns away to ask how
     many there are, so the first measure is of a card the whole row wide; paired, the
     card is half that, and its heading wraps onto a second line that the first measure
     never saw.
     The room, across and down, is an edge, so each is solved against the size the map
     is actually drawn at: its margins and then the drawer at sc pixels a millimetre. The
     width was not. It was the room over the drawer plus 90, as the caps are, when the
     margins across come to 92 — so whenever the drawer was drawn at under a pixel per
     millimetre the map came out wider than its room, and since the map's column is
     sized from the map, the preview beside it was pushed off the side of the stage: 56
     px of it with a 1150 × 1000 drawer at 1300 × 800, Fit and Expand with it. The caps
     keep the drawer-plus-90 form they were tuned in, which is what stops a small drawer
     being blown up to fill them; they are a ceiling on how big the map looks, not a
     wall that anything else is pushed against. */
  const chrome = () => {
    const sr = svg.getBoundingClientRect();
    return (sr.top - top.getBoundingClientRect().top)
         + ($('warnings').getBoundingClientRect().top - sr.bottom) + 1;
  };
  // the map's margins: ox left of the drawer and 34 right of it, oy above and 56 below
  const ox = 58, oy = 26, padW = ox + 34, padD = oy + 56;
  let sc, w, h;
  const size = (fixed) => {
    sc = Math.max(0.05, Math.min(680 * row.big / (Wmm + 90), 460 * row.big / (Dmm + 90),
                                 (roomW - padW) / Math.max(1, Wmm),
                                 (Math.max(300, row.room - fixed) - padD) / Math.max(1, Dmm)));
    w = padW + Wmm * sc; h = padD + Dmm * sc;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    if (row.two) DF.pairColumns(top, w + 30, PREVIEW_MIN);
  };
  const fixed = chrome();
  size(fixed);
  if (row.two) { const paired = chrome(); if (paired > fixed) size(paired); }
  const X = (mm) => ox + mm * sc;
  const Y = (mm) => oy + (Dmm - mm) * sc;     // front of drawer at the bottom
  let s = '';
  const gx0 = layout.mL, gy0 = layout.mF;
  /* Past the cap the map draws the drawer and nothing inside it. A 238 × 238 grid is
     around fifteen thousand SVG elements — it is not a picture of anything, and
     generating it is most of what made a mistyped drawer size feel like a hang. */
  const capped = overCap();
  if (!capped) {

    // piece fills
    layout.pieces.forEach((pc, i) => {
      const x0 = pc.cellX0 === 0 ? 0 : gx0 + pc.cellX0 * pitch;
      const x1 = pc.cellX0 + pc.nx === layout.nx ? Wmm : gx0 + (pc.cellX0 + pc.nx) * pitch;
      const y0 = pc.cellY0 === 0 ? 0 : gy0 + pc.cellY0 * pitch;
      const y1 = pc.cellY0 + pc.ny === layout.ny ? Dmm : gy0 + (pc.cellY0 + pc.ny) * pitch;
      const col = PIECE_COLORS[i % PIECE_COLORS.length];
      const bad = !pieceFits(pc);
      s += `<rect x="${X(x0)}" y="${Y(y1)}" width="${(x1-x0)*sc}" height="${(y1-y0)*sc}" fill="${col}" opacity="${bad?0.28:0.16}"/>`;
      s += `<text class="plabel${bad?' bad':''}" x="${X((x0+x1)/2)}" y="${Y((y0+y1)/2)-2}" text-anchor="middle">${pc.id}</text>`;
      s += `<text class="psub" x="${X((x0+x1)/2)}" y="${Y((y0+y1)/2)+11}" text-anchor="middle">${cellsOf(pc, '×')}</text>`;
    });

    /* Half cells, each a dashed box: the whole cells have no outline of their own here,
       only the lines between them, so a strip drawn the same way would read as more of
       the margin it replaces. Drawn under the grid lines, which run on through the
       strips so the half cells line up with the cells they continue. */
    const hw = pitch / 2, gx1 = gx0 + layout.nx * pitch, gy1 = gy0 + layout.ny * pitch;
    const half = (x, y, w, d) =>
      `<rect class="halfcell" x="${X(x)}" y="${Y(y + d)}" width="${w * sc}" height="${d * sc}"/>`;
    if (layout.hX) for (let j = 0; j < layout.ny; j++) s += half(gx1, gy0 + j * pitch, hw, pitch);
    if (layout.hY) for (let i = 0; i < layout.nx; i++) s += half(gx0 + i * pitch, gy1, pitch, hw);
    if (layout.hX && layout.hY) s += half(gx1, gy1, hw, hw);
    const gTop = gy1 + layout.hY * hw, gRight = gx1 + layout.hX * hw;

    // grid lines + hit targets
    for (let i = 1; i < layout.nx; i++) {
      const xm = gx0 + i * pitch;
      s += `<line class="gridline" x1="${X(xm)}" y1="${Y(gy0)}" x2="${X(xm)}" y2="${Y(gTop)}"/>`;
    }
    for (let j = 1; j < layout.ny; j++) {
      const ym = gy0 + j * pitch;
      s += `<line class="gridline" x1="${X(gx0)}" y1="${Y(ym)}" x2="${X(gRight)}" y2="${Y(ym)}"/>`;
    }
    // active cuts: rows
    const bandStarts = [0, ...layout.rowCuts];
    for (const rc of layout.rowCuts) {
      const ym = gy0 + rc * pitch;
      s += `<line class="cutline" x1="${X(0)}" y1="${Y(ym)}" x2="${X(Wmm)}" y2="${Y(ym)}"/>`;
    }
    // active cuts: columns per band
    layout.colCuts.forEach((cuts, b) => {
      const yA = gy0 + bandStarts[b] * pitch;
      const yB = b + 1 < bandStarts.length ? gy0 + bandStarts[b+1] * pitch
                                           : gy0 + layout.ny * pitch;
      const y0 = b === 0 ? 0 : yA;
      const y1 = b + 1 < bandStarts.length ? yB : Dmm;
      for (const c of cuts)
        s += `<line class="cutline" x1="${X(gx0 + c*pitch)}" y1="${Y(y0)}" x2="${X(gx0 + c*pitch)}" y2="${Y(y1)}"/>`;
    });
    // hit targets — horizontal (whole-plate row cuts)
    for (let j = 1; j < layout.ny; j++) {
      const ym = gy0 + j * pitch;
      s += `<line class="hitline" data-row="${j}" x1="${X(0)}" y1="${Y(ym)}" x2="${X(Wmm)}" y2="${Y(ym)}"/>`;
    }
    // hit targets — vertical, per band segment
    layout.colCuts.forEach((cuts, b) => {
      const yA = bandStarts[b], yB = b + 1 < bandStarts.length ? bandStarts[b+1] : layout.ny;
      for (let i = 1; i < layout.nx; i++) {
        const xm = gx0 + i * pitch;
        s += `<line class="hitline" data-band="${b}" data-col="${i}" x1="${X(xm)}" y1="${Y(gy0 + yA*pitch)}" x2="${X(xm)}" y2="${Y(gy0 + yB*pitch)}"/>`;
      }
    });

  } else {
    s += `<text x="${X(Wmm/2)}" y="${Y(Dmm/2)}" text-anchor="middle" font-size="13" fill="var(--red)">too large to draw — see the checks below</text>`;
  }

  // outline + dimension lines
  s += `<rect x="${X(0)}" y="${Y(Dmm)}" width="${Wmm*sc}" height="${Dmm*sc}" fill="none" stroke="var(--ink)" stroke-width="1.4"/>`;
  const dy = Y(0) + 22;
  s += `<line class="dim" x1="${X(0)}" y1="${dy}" x2="${X(Wmm)}" y2="${dy}"/>`
     + `<line class="dim" x1="${X(0)}" y1="${dy-4}" x2="${X(0)}" y2="${dy+4}"/>`
     + `<line class="dim" x1="${X(Wmm)}" y1="${dy-4}" x2="${X(Wmm)}" y2="${dy+4}"/>`
     + `<text x="${X(Wmm/2)}" y="${dy+14}" text-anchor="middle" font-size="11">${Wmm} mm</text>`;
  const dx = X(0) - 20;
  s += `<line class="dim" x1="${dx}" y1="${Y(0)}" x2="${dx}" y2="${Y(Dmm)}"/>`
     + `<line class="dim" x1="${dx-4}" y1="${Y(0)}" x2="${dx+4}" y2="${Y(0)}"/>`
     + `<line class="dim" x1="${dx-4}" y1="${Y(Dmm)}" x2="${dx+4}" y2="${Y(Dmm)}"/>`
     + `<text x="${dx-6}" y="${Y(Dmm/2)}" text-anchor="middle" font-size="11" transform="rotate(-90 ${dx-6} ${Y(Dmm/2)})">${Dmm} mm</text>`;
  s += `<text x="${X(Wmm/2)}" y="${h-6}" text-anchor="middle" font-size="10">▾ front of drawer</text>`;
  svg.innerHTML = s;
  /* Both units with inches on, millimetres first. The grid is millimetres by nature —
     42 mm cells — and that is the number the rest of the page and every download quote,
     so it stays; the inches are there to hold against the tape measure the drawer was
     measured with. */
  const gw = layout.nx * state.pitch, gd = layout.ny * state.pitch;
  const inch = unit === 'in';
  const [mL, mR, mF, mB] = solidMargins(), strips = halfStripText();
  $('gridSummary').innerHTML = `Grid: <span class="klabel">${layout.nx} × ${layout.ny}</span> cells (${gw.toFixed(0)} × ${gd.toFixed(0)} mm` +
    (inch ? `, ${FIELDS.inchText(gw)} × ${FIELDS.inchText(gd)} in` : '') +
    `)${strips ? `, plus ${strips}` : ''}` +
    ` · margins L ${mL.toFixed(1)} / R ${mR.toFixed(1)} / F ${mF.toFixed(1)} / B ${mB.toFixed(1)} mm` +
    (inch ? ` (${[mL, mR, mF, mB].map(FIELDS.inchText).join(' / ')} in)` : '');

  /* To anything that cannot see it the cut map is one image with no alt text — and it
     is the whole answer to "what did that setting just do". The label is rebuilt here
     on every draw rather than written once into the markup: a fixed string would
     describe the starting drawer forever, which is worse than silence because it is
     confidently wrong. The pieces are not enumerated; the piece table below already
     lists every one of them as text a screen reader can navigate. */
  svg.setAttribute('aria-label', capped
    ? 'Cut map: not drawn — the grid is larger than this tool will build. See the checks below.'
    : `Cut map: a ${layout.nx} by ${layout.ny} cell grid${strips ? `, plus ${strips},` : ''} ` +
      `in a ${Wmm} by ${Dmm} millimetre drawer, ${splitName()} split into ` +
      `${plural(layout.pieces.length, 'piece')}. ` +
      'Front of the drawer is at the bottom.');

  svg.querySelectorAll('.hitline').forEach(el => el.addEventListener('click', onMapClick));
}

function onMapClick(ev) {
  if (mapLeft) return;   // the release of a press the page let go of as it left (leave)
  const el = ev.currentTarget;
  // seed manual state from the current layout
  if (state.splitMode !== 'manual') {
    state.splitMode = 'manual';
    state.rowCuts = layout.rowCuts.slice();
    state.colCuts = layout.colCuts.map(c => c.slice());
    setSplitSeg('manual');
  }
  if (el.dataset.row !== undefined) {
    const j = parseInt(el.dataset.row);
    const i = state.rowCuts.indexOf(j);
    const oldStarts = [0, ...state.rowCuts];
    if (i >= 0) state.rowCuts.splice(i, 1); else { state.rowCuts.push(j); state.rowCuts.sort((a,b)=>a-b); }
    // remap per-band col cuts onto the new bands by band start position
    const newStarts = [0, ...state.rowCuts];
    const byStart = {};
    oldStarts.forEach((st, k) => byStart[st] = state.colCuts[k] || []);
    state.colCuts = newStarts.map(st => {
      if (byStart[st]) return byStart[st].slice();
      // new band from a split: inherit the cuts of the band it came from
      const src = oldStarts.filter(s0 => s0 < st).pop();
      return (byStart[src] || []).slice();
    });
  } else {
    const b = parseInt(el.dataset.band), c = parseInt(el.dataset.col);
    if (!state.colCuts[b]) state.colCuts[b] = [];
    const i = state.colCuts[b].indexOf(c);
    if (i >= 0) state.colCuts[b].splice(i, 1); else { state.colCuts[b].push(c); state.colCuts[b].sort((a,bb)=>a-bb); }
  }
  recomputeLayout();
}

function setSplitSeg(v) {
  document.querySelectorAll('#splitSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}

// ---------- piece table ----------
function drawPieceTable() {
  const tb = $('pieceRows');
  const pitch = state.pitch;
  const ws = warningsList();
  const stopped = ws.some(w => w.stop);
  /* The pieces a clamped drawer produces are pieces of a drawer nobody asked for, and
     listing them under a column headed "Bed fit" with the word "fits" in it is the
     self-contradiction this whole guard exists to remove — the screen said "resolve the
     errors above to generate" and "-50.0 × 211.0 … fits" at the same time. */
  if (stopped) {
    tb.innerHTML = '<tr><td colspan="7">Nothing to list until the checks above are clear.</td></tr>';
    $('pieceTail').textContent = 'not building — see the checks above';
    updatePreviewLabel(true);
    syncExportDialog();
    return;
  }
  tb.innerHTML = layout.pieces.map((pc, i) => {
    const w = pc.mL + pc.nx*pitch + pc.mR, d = pc.mF + pc.ny*pitch + pc.mB;
    const fit = pieceFits(pc);
    const built = builds[pc.id];
    let joints = pc.id === buildFailed ? 'failed' : '…';
    if (built) {
      const m = built.meta, parts = [];
      if (m.tabs) parts.push(plural(m.tabs, 'tab'));
      if (m.notches) parts.push(plural(m.notches, 'pocket'));
      if (m.puzzles) parts.push(plural(m.puzzles, 'puzzle'));
      if (m.bowties) parts.push(plural(m.bowties, 'key'));
      joints = parts.join(' + ') || '—';
    }
    return `<tr>
      <td><span class="sw" style="background:${PIECE_COLORS[i%PIECE_COLORS.length]}"></span><b>${pc.id}</b></td>
      <td class="mono">${cellsOf(pc)}</td>
      <td class="mono">${w.toFixed(1)} × ${d.toFixed(1)}</td>
      <td class="mono">${joints || '—'}</td>
      <td class="${fit?'':'bad'}">${fit ? 'fits' : footprintFits(pc) ? 'TOO TALL' : 'TOO BIG'}</td>
      <td class="mono">${built ? massText(pieceGrams(pc.id)) + costTail(pieceGrams(pc.id)) : '…'}</td>
      <td><button class="ghost" data-dl="${pc.id}" ${built?'':'disabled'}>STL</button></td>
    </tr>`;
  }).join('');
  tb.querySelectorAll('button[data-dl]').forEach(b => b.addEventListener('click', () => downloadPiece(b.dataset.dl)));
  const tot = layout.pieces.length;
  const okc = Object.keys(builds).length;
  /* "building 0/2…" used to be permanent whenever a check found an error, because
     runBuild returns before it starts one — so the count was counting towards a number
     it would never reach, next to a status line saying the build could not start. */
  const blocked = ws.some(w => w.err);
  $('pieceTail').textContent = blocked ? 'not building — see the checks above'
    : buildFailed ? `build failed at piece ${buildFailed} — try different cuts`
    : okc < tot ? `building ${okc}/${tot}…` : `${tot} ready`;
  updatePreviewLabel(blocked);
  // this runs once per piece as the build proceeds, which is exactly the cadence an
  // open dialog needs to keep its readiness line and its file list honest
  syncExportDialog();
}

/* Same reasoning as the cut map's label: a <canvas> is a blank rectangle to anything
   that cannot see it, and this one carries the answer to "did that do what I meant".
   A summary rather than a description of the scene — the shape of each piece is in the
   piece table, as text.

   Every number in it is read from the state the piece table and the print plan read, and
   the joint is named through CONNECTOR_NAMES, which is the export dialog's name for it —
   so the label cannot end up describing a different design from the rest of the page.
   It is written on every draw, including the ones that have nothing to show: a label
   set once goes stale, and a stale label is worse than none because it is confident. */
function updatePreviewLabel(blocked) {
  const n = layout.pieces.length, built = Object.keys(builds).length;
  if (!threeOk) {
    $('three').setAttribute('aria-label', '3D preview unavailable — this browser could not start WebGL.');
    return;
  }
  $('three').setAttribute('aria-label', blocked
    ? '3D preview: nothing to show — see the checks under the cut map.'
    : buildFailed ? `3D preview: the build failed at piece ${buildFailed}.`
    : built < n
      ? `3D preview: building, ${built} of ${plural(n, 'piece')} so far.`
      : `3D preview: a ${layout.nx} by ${layout.ny} cell baseplate, ` +
        `${(layout.nx * state.pitch).toFixed(0)} by ` +
        `${(layout.ny * state.pitch).toFixed(0)} millimetres` +
        `${halfStripText() ? `, plus ${halfStripText()}` : ''}, split into ` +
        `${plural(n, 'piece')} and joined with ` +
        `${CONNECTOR_NAMES[state.connector] || state.connector}.`);
}

// ---------- async build ----------
let buildTimer = null;
function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(runBuild, 260);
}
/* The id of the piece whose build threw, until the next build starts. A failure used to
   be a line in the preview's corner and nothing else: the piece table sat on "building
   1/2…" for good, the dialog said "Still building", and Download stayed on — for a
   build that had already given up. */
let buildFailed = null;
async function runBuild() {
  const token = ++buildToken;
  builds = {};
  if (buildFailed) { buildFailed = null; drawWarnings(); }
  printPlan = null; renderPrintPlan();
  drawPieceTable();
  clearThree();
  if (hasErrors()) { $('status').textContent = 'resolve the errors above to generate'; return; }
  for (const pc of layout.pieces) {
    $('status').textContent = `building ${pc.id}…`;
    await new Promise(r => setTimeout(r, 0));
    if (token !== buildToken) return;
    try {
      const res = buildPiece(state, layout, pc);
      // measured once, here, rather than every time the dialog re-syncs — which is once
      // per piece as the build proceeds, so it would be quadratic in the piece count
      builds[pc.id] = { polys: res.polys, meta: res, mat: meshMaterial(res.polys) };
      addPieceToThree(pc, res);
    } catch (e) {
      console.error('build failed for', pc.id, e);
      $('status').textContent = `piece ${pc.id} failed — try different cuts`;
      buildFailed = pc.id;
      drawWarnings();
      drawPieceTable();
      // the pieces that did build are what is on screen now, and the framing may still be
      // for the meshes this build cleared away (see frameKey)
      autoFrame();
      return;
    }
    drawPieceTable();
  }
  $('status').textContent = '';
  computePrintPlan();
  autoFrame();
}

// ---------- three.js ----------
let scene, camera, renderer, root, sph = { theta: -0.7, phi: 1.05, r: 420, cx: 0, cy: 0, cz: 0 };
/* The preview is the one part of the page that needs WebGL, and it was set up first, so
   a browser without it — GPU blocklisted, hardware acceleration off, three.js not
   loaded — threw on the renderer and took the rest of the boot with it: no layout, no
   build, no downloads, for a tool whose files never touch the GPU. So a failed setup
   says so in the preview box and leaves `threeOk` false, and every preview function
   below checks it and does nothing. */
let threeOk = false;
/* Who is in charge of the framing, the page or the person looking at it.
 *
 * The preview re-framed itself at the end of every build, and a build follows every
 * change on the page — so zooming in on a joint and then changing the clearance threw
 * the zoom away. It now frames itself only when what it is framing changes: the size of
 * what is drawn — a different drawer, the exploded view, more pieces spread apart, a
 * thicker floor — or the canvas's own shape (see frameKey). And not even then once you
 * have zoomed or panned, because those say what you want to look at, and re-framing
 * would overrule it.
 *
 * Rotating does not count. It says which SIDE you want to look from, and a re-frame
 * keeps the angle, so there is nothing to overrule. The Fit button hands control back:
 * it frames now and lets the page frame again from then on. */
let viewOwned = false, framedKey = '', fitR = 0;
function initThree() {
  try {
    setupThree();
    threeOk = true;
  } catch (e) {
    console.warn('3D preview unavailable:', e && e.message);
    $('noGl').style.display = 'grid';
    $('threehint').style.display = 'none';
  }
}
function setupThree() {
  const canvas = $('three');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 2, 1, 5000);
  scene.add(new THREE.HemisphereLight(0xcfe8f4, 0x1a2027, 0.95));
  const d = new THREE.DirectionalLight(0xffffff, 0.75); d.position.set(0.6, -1, 1.4); scene.add(d);
  root = new THREE.Group(); scene.add(root);
  const onResize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    // a new shape of canvas wants a new distance: expanding to full screen, or the page
    // settling its layout after load, would otherwise keep a framing worked out for
    // a different rectangle
    if (layout) autoFrame();
  };
  new ResizeObserver(onResize).observe(canvas); onResize();
  // controls
  let drag = null;
  /* Two-finger pinch, because a touch screen has no wheel and no shift key.
     Every pointer is tracked rather than just the first: with one down we rotate as
     before, with two the gap between them drives zoom and the midpoint drives pan —
     which is the same pair of gestures the mouse gets from the wheel and shift-drag,
     just expressed the way a hand does it. */
  const pts = new Map();
  const gap = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  let pinch = null, pmid = null;
  const zoom = (f) => { sph.r = clampR(sph.r * f); viewOwned = true; };

  canvas.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    canvas.setPointerCapture(e.pointerId);
    if (pts.size === 2) { pinch = gap(); pmid = mid(); drag = null; }
    /* Middle button pans as well as shift, which is what most 3D tools do and what the
       bins preview now does. preventDefault stops the browser's autoscroll taking the
       drag over. */
    else if (pts.size === 1) {
      drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 };
      if (e.button === 1) e.preventDefault();
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size >= 2) {
      const g = gap(), m = mid();
      if (pinch > 0 && g > 0) zoom(pinch / g);
      if (pmid && (m[0] !== pmid[0] || m[1] !== pmid[1])) {
        sph.cx -= (m[0] - pmid[0]) * sph.r * 0.0011; sph.cy += (m[1] - pmid[1]) * sph.r * 0.0011;
        viewOwned = true;
      }
      pinch = g; pmid = m;
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.pan) { sph.cx -= dx * sph.r * 0.0011; sph.cy += dy * sph.r * 0.0011; viewOwned = true; }
    else { sph.theta -= dx * 0.0065; sph.phi = Math.max(0.03, Math.min(3.11, sph.phi - dy * 0.0065)); }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) { pinch = null; pmid = null; }
    // lifting one of two fingers must re-seat the rotate anchor on the one still
    // down, or the model jumps by the distance between them
    if (pts.size === 1) { const [p] = [...pts.values()]; drag = { x: p[0], y: p[1], pan: false }; }
    if (pts.size === 0) drag = null;
  };
  canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(1 + e.deltaY * 0.0011); }, { passive: false });
  (function loop() {
    requestAnimationFrame(loop);
    camera.position.set(
      sph.cx + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
      sph.cy - sph.r * Math.sin(sph.phi) * Math.cos(sph.theta),
      sph.cz + sph.r * Math.cos(sph.phi));
    camera.up.set(0, 0, 1);
    camera.lookAt(sph.cx, sph.cy, sph.cz);
    renderer.render(scene, camera);
  })();
}
function clearThree() {
  if (!threeOk) return;
  while (root.children.length) {
    const m = root.children.pop();
    m.geometry.dispose(); m.material.dispose();
  }
}
function piecePlacement(pc) {
  const pitch = state.pitch, gap = $('explode').checked ? 14 : 0.6;
  const gx = pc.cellX0 === 0 ? 0 : layout.mL + pc.cellX0 * pitch;
  const gy = pc.cellY0 === 0 ? 0 : layout.mF + pc.cellY0 * pitch;
  return [gx + pc.seg * gap, gy + pc.band * gap];
}
function addPieceToThree(pc, res) {
  if (!threeOk) return;
  const tris = polysToTriangles(res.polys);
  const pos = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const v of t) { pos[o++] = v[0]; pos[o++] = v[1]; pos[o++] = v[2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const i = layout.pieces.indexOf(pc);
  const mat = new THREE.MeshStandardMaterial({
    color: PIECE_COLORS[i % PIECE_COLORS.length], flatShading: true,
    metalness: 0.05, roughness: 0.75 });
  const mesh = new THREE.Mesh(g, mat);
  const [px, py] = piecePlacement(pc);
  mesh.position.set(px, py, 0);
  mesh.userData.pieceId = pc.id;
  root.add(mesh);
}
/* The wheel's limits, widened to suit the drawer. A fixed 2200 mm ceiling is short of
   the distance the largest drawer this page accepts needs to fit a narrow canvas, and a
   ceiling below the fitted distance would make the first wheel tick OUT jump inwards. */
const clampR = (r) => Math.max(60, Math.min(Math.max(2200, fitR * 2), r));

/* What there is to look at: the plate the layout describes, which is there from the
   start, and whatever has been built so far, which is where exploded pieces and tabs
   standing proud of an edge come from. The layout alone would crop an exploded view;
   the meshes alone are empty until the first piece finishes, which is when the first
   framing has to happen. */
function sceneBox() {
  /* The plate's height and the floor asked for, as the first framing has always been
     worked out: not builtH(), which adds the floor a magnet, screw or key raises it to,
     so a plate's framing before its first build stays as it was. */
  const h = (state.plateHeight || 4.25) + (state.bottomPad || 0);
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0),
                             new THREE.Vector3(state.drawerW, state.drawerD, h));
  if (root.children.length) box.union(new THREE.Box3().setFromObject(root));
  return box;
}
/* When the framing is out of date: the box of what is drawn, to the millimetre, and the
   canvas it is drawn on.
   It was the drawer's size, the exploded toggle and the canvas, and that missed the
   case that matters most. Changing the drawer's size resizes the map, and beside it the
   canvas, so the resize observer frames straight away — but the build is still waiting
   out its debounce, and the meshes on screen are the old drawer's. Shrinking 600 deep
   to 380 was framed for 600, and stamped with the 380 key, so the frame at the end of
   the build found nothing to do: the plate sat small and off to one side until Fit.
   Keyed on the box, a frame taken against meshes that are on their way out is out of
   date the moment they are replaced. The same box also sees what the old key could
   not: an exploded view spreading further as the piece count grows, an extra floor,
   tabs standing proud of an edge. A change that leaves the box as it was, which is
   most of them, still leaves the camera alone — a rotated view in particular keeps
   the distance it is at, rather than being re-fitted to its new angle by every edit. */
const frameKey = () => {
  const cv = $('three'), b = sceneBox();
  return [...b.min.toArray(), ...b.max.toArray()].map(Math.round)
    .concat([cv.clientWidth, cv.clientHeight]).join('/');
};
/* Frame the plate from wherever the camera is now looking from. Keeping the angle is
   deliberate, for Fit as much as for the automatic case: the button answers "show me
   all of it", not "start again", and a reload is still there for that. */
function fitThree() {
  if (!threeOk) return;
  const cv = $('three');
  const w = cv.clientWidth, h = cv.clientHeight;
  framedKey = frameKey();
  if (!w || !h) return;               // not laid out yet; the resize observer comes back
  const box = sceneBox();
  const f = DF.frame({ min: box.min.toArray(), max: box.max.toArray() },
    [Math.sin(sph.phi) * Math.sin(sph.theta), -Math.sin(sph.phi) * Math.cos(sph.theta), Math.cos(sph.phi)],
    [0, 0, 1], camera.fov, w / h, 0.08);
  [sph.cx, sph.cy, sph.cz] = f.target;
  sph.r = fitR = f.dist;
  // the far plane was set for drawers of a sensible size, and a large one zoomed all the
  // way out would lose its back edge to it
  camera.far = Math.max(5000, fitR * 4);
  camera.updateProjectionMatrix();
}
function autoFrame() {
  if (!threeOk || frameKey() === framedKey) return;
  if (viewOwned) framedKey = frameKey();
  else fitThree();
}
/* chrome.js owns the button, because it owns Expand beside it and runs on both tools;
   it says "fit" with an event rather than calling in, so it needs to know nothing of
   how either tool keeps its camera. */
$('threewrap').addEventListener('previewfit', () => { viewOwned = false; fitThree(); });
$('explode').addEventListener('change', () => {
  if (!threeOk) return;
  for (const mesh of root.children) {
    const pc = layout.pieces.find(p => p.id === mesh.userData.pieceId);
    if (pc) { const [px, py] = piecePlacement(pc); mesh.position.set(px, py, 0); }
  }
  autoFrame();
});


// ---------- print plan ----------
let printPlan = null;
function computePrintPlan() {
  if (!layout || Object.keys(builds).length < layout.pieces.length) { printPlan = null; renderPrintPlan(); return; }
  /* Never below zero. A negative spacing packed parts into each other, and a negative
     stack gap sank the upper piece into the one under it, so the 3MF printed them as
     one fused lump. A blank field means the default; a spacing of 0 is an answer and
     stays 0 — the old `|| 4` turned it into 4. A stack gap of 0 is not: it prints the
     two pieces fused just the same, so it is held to one layer, as packPlates holds it. */
  const gapOf = (id, dflt) => {
    const v = parseFloat($(id).value);
    return isFinite(v) ? Math.max(0, v) : dflt;
  };
  const gap = gapOf('plateGap', 4);
  const stack = $('stackToggle').checked;
  const zGap = Math.max(PRINT_LAYER, gapOf('stackGap', 0.24));
  $('stackHint').style.display = stack ? '' : 'none';
  const items = layout.pieces.map(pc => {
    const m = builds[pc.id].meta;
    return { id: pc.id, w: m.W + m.protrusion.l + m.protrusion.r,
             d: m.D + m.protrusion.f + m.protrusion.b, h: m.H, qty: 1, stackable: true };
  });
  /* The plan reserves bed space for exactly the keys the download contains, which
     means asking keysNeeded rather than counting junctions again here. It used to
     count them here, unfiltered, and a wall-housed key skips any seam that overlaps
     by a single cell — so the plan laid out clips the STL does not contain, and the
     3MF plate carried them too. Two counts of the same thing is one too many.

     Same for the size: measured off the mesh connectorPart returns, not off the
     parameters that made it. The two are the same rectangle for a flat key and are
     nothing like each other for the U-clip, whose prm describes a cross-section. */
  /* The key's material is measured here too, off the same part, for the plates' weights
     and times: one key is the same part on every plate that carries one. */
  let keyMat = null;
  if (shipsKeys()) {
    const part = connectorPart();
    const ext = partExtent(part.polys);
    keyMat = meshMaterial(part.polys);
    items.push({ id: 'key', w: ext.w, d: ext.d, h: ext.h,
                 qty: keysNeeded(), stackable: false });
  }
  /* A part too big for the bed comes back as a plate of its own, marked `overflow`, with
     nothing on it that prints. It is left out of the plan and the files, as the bins
     page leaves it out, and named instead: drawn and downloaded, it was a plate that
     looked like it held the piece and a 3MF without it. The check above the plan cannot
     always catch it first, because it does not count every joint's tabs. */
  const packed = packPlates(items, state.bedW, state.bedD, gap,
    { stack, zGap, bedH: state.bedH || 1e9 });
  printPlan = { plates: packed.filter((pl) => !pl.overflow),
                over: packed.filter((pl) => pl.overflow).map((pl) => pl.overflow),
                merged: items, zGap, keyMat };
  renderPrintPlan();
}
function renderPrintPlan() {
  const row = $('platesRow');
  updateExportTail();
  // the speed menu's own entry says which kind of printer the list makes this one
  ESTIMATE.labelAuto($('printSpeed'), $('bedPreset'));
  if (!printPlan) { row.innerHTML = '<div class="hint">Print plan appears when all pieces are built.</div>'; $('planTail').textContent = ''; $('planTime').textContent = ''; return; }
  const plates = printPlan.plates;
  const stacked = plates.some(pl => pl.placed.some(p => p.z > 0.01));
  const over = printPlan.over.map((id) => id === 'key' ? 'a key' : `piece ${id}`);
  $('planTail').textContent = plural(plates.length, 'print plate') + (stacked ? ' · stacked' : '') +
    (over.length ? ` · ${plural(over.length, 'part')} too big for the bed` : '');
  const sc = 116 / Math.max(state.bedW, state.bedD);
  const overNote = !over.length ? '' : `<div class="hint" style="color:var(--red);flex-basis:100%">` +
    `${over.join(', ').replace(/^./, (c) => c.toUpperCase())} ${over.length > 1 ? 'do' : 'does'} not fit ` +
    `the ${state.bedW} × ${state.bedD} mm bed with ${over.length > 1 ? 'their' : 'its'} joints, so no ` +
    `plate file has ${over.length > 1 ? 'them' : 'it'} — add a cut through ${over.length > 1 ? 'each' : 'it'} on the map.</div>`;
  row.innerHTML = overNote + plates.map((pl, i) => {
    let svg = `<svg width="${state.bedW*sc+2}" height="${state.bedD*sc+2}" style="background:var(--panel2);border:1px solid var(--line);border-radius:5px">`;
    for (const p of pl.placed) {
      const ci = p.id === 'key' ? 7 : layout.pieces.findIndex(pc => pc.id === p.id);
      const lvl = Math.round(p.z / (4.5 + printPlan.zGap));
      svg += `<rect x="${p.x*sc+1}" y="${(state.bedD-p.y-p.d)*sc+1}" width="${p.w*sc}" height="${p.d*sc}" fill="${PIECE_COLORS[(ci<0?0:ci)%PIECE_COLORS.length]}" opacity="${p.z>0.01?0.35:0.55}" stroke="var(--line)"/>`;
      if (p.id !== 'key')
        svg += `<text x="${(p.x+p.w/2)*sc+1}" y="${(state.bedD-p.y-p.d/2)*sc+4+(lvl*10)}" text-anchor="middle" font-size="10" fill="var(--ink)">${p.id}${p.z>0.01?' ↥':''}</text>`;
    }
    svg += '</svg>';
    return `<div style="display:grid;gap:4px;justify-items:center">${svg}<div class="hint">plate ${i+1}` +
           (pl.overflow ? '' : `<br>${plateFigures(plateEstimate(pl))}`) + `</div></div>`;
  }).join('');
  /* The job in one line under the plates: what it all weighs and costs, and roughly how
     long, said as the rough figure it is. The weight is materialGrams, the same total the
     download dialog and the README quote. It weighs every piece, but only a plate can be
     timed, so with a piece too big for the bed the time says it is for the plates that
     fit (fitNote), as Bins says it. */
  const job = jobTime(), g = materialGrams();
  $('planTime').textContent = job.plates.length && g !== null
    ? `In all: ${massText(g)}${costTail(g)} · about ${ESTIMATE.duration(job.min)} of printing ` +
      `on a ${speedName()}${fitNote()} (${ESTIMATE.ROUGH}).`
    : '';
}
/* Each part is placed by its own box, turned, so the box lands on the rectangle the plan
   drew for it.

   packPlates hands back a rectangle — the corner, and the width and depth after any
   quarter turn — and build3mfXML turns a part about its origin before moving it. The
   two only agree when the origin IS the corner the part's box grows from, and they were
   treated as if it always was. It is for an unturned piece moved by its tabs. Turned a
   quarter, (x, y) goes to (-y, x): the piece swings into the space to the left of its
   origin, and on a 250 × 210 bed piece B2 printed on top of B1, while with stacking on
   a turned piece left the bed altogether. The keys and clips are modelled centred on
   the origin, so every one of them sat half a key to the left of and in front of where
   the plan drew it, and the front row hung off the bed. The plan on the page was right
   throughout; only the file was wrong, which is the one you print.

   So the offset comes from the mesh: where the low corner of its box ends up after the
   turn, taken off the planned corner. That is right for any part however it was
   modelled, which is why the piece no longer needs moving by its tabs first — the copy
   transformPolys made of every piece was only ever there to put that corner on the
   origin. test/ui/plate-files.spec.js reads the downloaded files back and holds every
   part to its planned rectangle. */
function platePolysAndItems(idx) {
  const pl = printPlan.plates[idx];
  const objs = [];
  // built once: every key unit on the plate is the same part, and buildKey runs CSG
  let part = null, partBox = null;
  const boxOf = (polys) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of polys) for (const v of q.verts) {
      if (v[0] < x0) x0 = v[0];
      if (v[0] > x1) x1 = v[0];
      if (v[1] < y0) y0 = v[1];
      if (v[1] > y1) y1 = v[1];
    }
    return { x0, y0, x1, y1 };
  };
  for (const p of pl.placed) {
    let polys, box;
    if (p.id === 'key') {
      if (!part) { part = connectorPart(); partBox = boxOf(part.polys); }
      polys = part.polys; box = partBox;
    } else {
      const b = builds[p.id];
      if (!b) continue;
      polys = b.polys; box = boxOf(polys);
    }
    // where the box's low corner goes under build3mfXML's turn: (x, y) -> (-y, x)
    const [lx, ly] = p.rot === 90 ? [-box.y1, box.x0] : [box.x0, box.y0];
    objs.push({ name: p.id + (p.z > 0.01 ? `@${p.z.toFixed(2)}` : ''), polys,
                tx: p.x - lx, ty: p.y - ly, tz: p.z, rot: p.rot });
  }
  return objs;
}
/* JSZip stores files uncompressed unless asked, and a 3MF is a ZIP of XML text — a
   format that compresses several times over. Stored, every 3MF and ZIP was several
   times the size it needed to be, which on a big plate is the difference between a
   download and a stall. Slicers read either. */
const ZIP_DEFLATE = { compression: 'DEFLATE', compressionOptions: { level: 6 } };
async function plate3mfBytes(idx) {
  const x = build3mfXML(platePolysAndItems(idx));
  const pz = new JSZip();
  pz.file('[Content_Types].xml', x.contentTypes);
  pz.file('_rels/.rels', x.rels);
  pz.file('3D/3dmodel.model', x.model);
  return pz.generateAsync({ type: 'uint8array', ...ZIP_DEFLATE });
}
async function downloadAllPlates() {
  if (!printPlan || !printPlan.plates.length) return;
  const n = printPlan.plates.length;
  if (n === 1) { saveBlob(await plate3mfBytes(0), 'print-plates.3mf'); return; }
  const zip = new JSZip();
  for (let i = 0; i < n; i++) zip.file(`plate-${i+1}.3mf`, await plate3mfBytes(i));
  saveBlobAsync(await zip.generateAsync({ type: 'blob', ...ZIP_DEFLATE }), `print-plates-x${n}.zip`);
}
$('plateGap').addEventListener('input', computePrintPlan);
$('stackToggle').addEventListener('change', computePrintPlan);
$('stackGap').addEventListener('input', computePrintPlan);

// ---------- downloads ----------
function saveBlob(buf, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function saveBlobAsync(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function downloadPiece(id) {
  const b = builds[id];
  if (b) saveBlob(stlBinary(b.polys, `baseplate-${id}`), `baseplate-${id}.stl`);
}
function testTilePolys() {
  return buildTestTile(Object.assign({}, state, { drawerW: state.pitch, drawerD: state.pitch,
    marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0 })).polys;
}
/* The dimensions the housing is cut to. `depth` is the recess depth — the printed key
   comes out 0.15 mm shorter — which is why the H-clip's arrives on hclipPrm rather than
   being patched on here from a literal that buildPiece kept its own copy of. */
function activeKeyDims() {
  const d = state.connector === 'hclip' ? hclipPrm(state.hclip)
    : state.keyMount === 'wall' ? Object.assign({}, DEFAULTS.keySlim) : Object.assign({}, state.key);
  if (keyFromTop()) d.depth = 2.0;   // a top-inserted key drops into a cup, not through
  return d;
}
function activeKeyShape() {
  return state.connector === 'hclip' ? 'snap' : state.keyType;
}
/* The height the plate is built to: the fit sample is cut to it, and the top clip is
   handed it (snapTopClip does not use it). Worked out from the settings, as buildPiece
   works it out (plateHeightMm), and not read off the first piece built, which is the
   plate before a change for the 260 ms the rebuild waits and none at all while nothing
   has built. The fit sample is offered through both, so it was cut for the wrong plate:
   a 4.25 mm coupon with no floor for a 6.85 mm puzzle plate, picked and downloaded at
   once. Once a piece has built the two are the same number.
   test/ui/fit-sample.spec.js takes the coupon before the rebuild lands. */
function builtH() {
  return plateHeightMm();
}
/* The one loose part this configuration needs, built once.

   A top-inserted snap takes the U-clip you press in from above; everything else keyed
   takes a flat key laid into a pocket. They are not variants of one shape — the clip is
   a sprung cross-section 4.2 mm across, the key is a 13-14 mm slab — so getting this
   wrong does not print a slightly wrong part, it prints a part that will not go in.

   connectorPart is the ONLY answer to "which part", the way keysNeeded below is the only
   answer to "how many". It was two answers: keysStl branched on top-insert and
   platePolysAndItems did not, so a top-insert snap put the U-clip in the loose STL and
   the bottom-insert key on the 3MF print plate, under the same name, with nothing on the
   page to say the two files disagreed. The print plan made it three, reserving bed space
   from the key's parameters whichever part it was.
   test/ui/connector-part.spec.js exports both routes and compares the geometry. */
function connectorPart() {
  if (topClips())
    return { polys: snapTopClip(snapTopPrm(state.key.clr), builtH()),
             mesh: 'snap-clips', stem: 'snap-clips' };
  const kd = activeKeyDims();
  return { polys: buildKey(activeKeyShape(), kd, kd.depth - 0.15),
           mesh: 'connector-keys', stem: `${state.connector}-keys` };
}
/* Which joint this design actually builds, in the terms the geometry needs to build it:
   the housing, the shape, the dimensions, the clearance and the part that goes in.
 *
 * Same reason as connectorPart above and keysNeeded below. buildFitSample worked all of
 * this out for itself from cfg, and got it wrong for every top-inserted configuration
 * except the snap — the coupon presented a bottom recess where the plate has a top cup,
 * so the fit you printed the coupon to check was a fit you were not building. It could
 * not have got it right on its own: the depth a top-inserted key is cut to and the
 * decision to use DEFAULTS.keySlim rather than a clearance the user can move both live
 * here, in activeKeyDims, where cfg cannot see them.
 *
 * The kinds and their order match buildPiece's: a top-inserted snap takes the clip
 * whatever its housing says, so it is tested first.
 *
 * `pad` is the floor under the sockets as buildPiece builds it: builtH less the plate's
 * own height, where builtH is platePad's sum, the one buildPiece cuts to. It is not
 * worked out again here from bottomPad and the joint's own minimum — the puzzle cavity
 * is cut relative to it, and the coupon has no other way to know.
 *
 * `clrMax` is the joint's clearance with the field at its ceiling, so the coupon offers
 * no pair looser than the field will take: the same ceiling the field is held to
 * (connClrCeiling), cut the way this joint cuts the field (fitClearances). It was the
 * field's headroom added to the joint's clearance, which is the same thing only while
 * the key's 0.1 floor is not in play, and it read a ceiling that knew the connector and
 * nothing else — a snap clip dropped in from above got pairs to 0.95, whose housings
 * met across the coupon's seam. Its slackest pair now stops at the key's 0.25, which
 * holds the slot's seam-side wall one BLOAT inside its tile, off the tile's seam face,
 * as the ceiling holds it on the plate; test/plate-audit.js measures both. A slim wall
 * key's clearance is its own and the field does not move it, so it has no ceiling to
 * keep to. */
function activeJoint() {
  const pad = builtH() - state.plateHeight;
  const top = fitClearances(connClrCeiling(state).max);
  if (!KEYED.includes(state.connector)) {
    const puzzle = state.connector === 'puzzle';
    return { kind: state.connector === 'none' ? 'none' : state.connector, pad,
             clr: puzzle ? state.puzzle.clr : state.tab.clr,
             clrMax: puzzle ? top.puzzle : top.tab };
  }
  const prm = activeKeyDims();
  // core.js owns this, so the coupon, the plate and the audit cannot disagree
  const kind = jointKind(state.connector, state.keyMount, state.keyInsert);
  // the clip is one part at one size in either housing, so it is fitted to the full
  // key's clearance — buildPiece says the same
  const clr = kind === 'snaptop' ? state.key.clr : prm.clr;
  const slim = kind !== 'snaptop' && state.connector !== 'hclip' && state.keyMount === 'wall';
  return { kind, shape: activeKeyShape(), prm, pad, clr,
           clrMax: slim ? Infinity : state.connector === 'hclip' ? top.hclip : top.key,
           part: connectorPart().polys };
}
/* ---------- material ------------------------------------------------------
 * How much filament this is — the number that decides whether anyone starts. The bins
 * tool has said so since it shipped; the baseplates tool, whose jobs are the long ones,
 * said nothing at all about a twelve-piece print that is days of machine time.
 *
 * The approach is ported from volumeMm3 in the bins tool rather than shared with it.
 * That function works from a bin's own parameters — feet, walls, dividers, lip — and a
 * baseplate has none of those; what carries across is the reasoning, which is the part
 * that matters. Raw mesh volume is NOT what a printer uses: the slicer shells a part and
 * infills the core, so the 2.8 mm slab under a solid plate comes out mostly air at 15%,
 * while the 1 mm band of wall between two sockets is a couple of perimeters wide and
 * prints solid whatever you set.
 *
 * The shell is measured off the mesh itself, triangle by triangle, because a baseplate's
 * shape moves with the socket profile, the skeleton, magnets, screws and the joint —
 * there is no small set of parameters to work from the way there is for a bin. Assumes
 * 2 perimeters and 4 solid top/bottom layers, matching the bins tool, and takes the
 * infill from the panel rather than assuming it — 15% was hard-coded here, which quoted
 * a figure at people printing at 5%. Geometry is unaffected either way.
 */
const SHELL_T = 0.8, SKIN_T = 0.8, PLA_DENSITY = 1.24;   // g/cm3
function meshMaterial(polys) {
  let raw = 0, shell = 0;
  for (const p of polys) {
    const v = p.verts;
    for (let i = 1; i + 1 < v.length; i++) {
      const a = v[0], b = v[i], c = v[i + 1];
      /* Signed volume of the tetrahedron this triangle makes with the origin. Over a
         closed mesh they sum to the volume enclosed wherever the origin happens to
         fall, which is why nothing has to be centred first. */
      raw += (a[0] * (b[1]*c[2] - b[2]*c[1]) - a[1] * (b[0]*c[2] - b[2]*c[0])
              + a[2] * (b[0]*c[1] - b[1]*c[0])) / 6;
      const ux = (b[1]-a[1])*(c[2]-a[2]) - (b[2]-a[2])*(c[1]-a[1]);
      const uy = (b[2]-a[2])*(c[0]-a[0]) - (b[0]-a[0])*(c[2]-a[2]);
      const uz = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
      const len = Math.hypot(ux, uy, uz);
      // a face the nozzle lays down flat gets solid layers; a wall gets perimeters
      shell += (len / 2) * (len && Math.abs(uz) / len > 0.7 ? SKIN_T : SHELL_T);
    }
  }
  raw = Math.abs(raw);
  /* The infill only ever reaches what the shell does not already fill, which on a
     baseplate is a small share — hence the estimate moving little with it. */
  /* How good is this? An upper bound, and worth saying so where the number is used.
     Shell is summed per triangle as area x thickness, which is exactly right for a flat
     slab — two faces at 0.8 mm over a thickness T give a solid fraction of 2t/T — but
     it over-counts wherever faces meet, at every rib, rim and socket cone. On a 4.25 mm
     plate that sum comes out ABOVE the whole volume, so the part is reported as printed
     solid and the infill reaches nothing. A real slice of one does show a little sparse
     infill, so the true figure is somewhat under what this reports. Fixing it properly
     means eroding the mesh by the shell thickness and measuring what survives, which is
     a different piece of work from a per-triangle sum; until then the number is honest
     about being a ceiling rather than quietly pretending otherwise.

     Deliberately NOT blended with the infill here. This is called once per piece at
     build time and cached, and geometry does not change when the infill does — so a
     figure folded in at this point is stale the moment the control is touched, which is
     exactly how the estimate came to ignore it. Shape in, shape out; filamentOf does
     the blend at the moment of asking.

     `core` is what the infill can reach once the shell has taken its share. On the
     default open-bottomed plate it is ZERO: the shell estimate comes out larger than
     the whole volume, because every part of a 4.25 mm plate is a thin wall a couple of
     perimeters across. Only a solid pad, or the material magnets and screws need, gives
     the infill anything to do at all. */
  return { raw, shell, core: Math.max(0, raw - shell) };
}
/* The blend, at the moment of asking rather than at build time. */
const infillFrac = () => Math.max(0, Math.min(100, state.infill ?? 15)) / 100;
const filamentOf = (m) => Math.min(m.raw, m.shell + infillFrac() * m.core);

/* A baseplate is mostly shell, so the infill often reaches nothing and the estimate
   does not move however it is set. Saying so beats quoting a percentage that had no
   bearing on the number beside it. */
function infillNote() {
  const core = !layout ? 0 : layout.pieces.reduce(
    (a, pc) => a + (builds[pc.id] ? builds[pc.id].mat.core : 0), 0);
  return core > 1 ? `at ${state.infill}% infill`
                  : `— mostly shell, so ${state.infill}% infill barely moves it, ` +
                    'and this is an over-estimate';
}
const massText = (g) => g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${Math.round(g)} g`;
/* Null until every piece exists. Half a total is a number people would act on, and the
   dialog re-renders on every finished piece, so it would be a different number each
   time it appeared. */
function materialGrams() {
  if (!layout || layout.pieces.some(pc => !builds[pc.id])) return null;
  let mm3 = layout.pieces.reduce((a, pc) => a + filamentOf(builds[pc.id].mat), 0);
  // the loose parts are part of the job: keysNeeded is the same count the STL lays out
  // and the print plan reserves bed space for
  if (shipsKeys())
    mm3 += filamentOf(meshMaterial(connectorPart().polys)) * keysNeeded();
  return mm3 * PLA_DENSITY / 1000;
}

/* ---------- money and time --------------------------------------------------
 * Every gram figure on the page is written through these, so none of them can be the one
 * that forgot the cost: the piece table, the print plan, the download dialog and the
 * README. The money is empty until a price is set, and then it is everywhere. The time is
 * ESTIMATE's rough one, per plate and summed, for whichever kind of printer the list or
 * the override says. */
const costOf = (g) => ESTIMATE.cost(g, est.get());
// " · £0.42", or nothing without a price
const costTail = (g) => { const c = costOf(g); return c ? ` · ${c}` : ''; };
const speedNow = () => ESTIMATE.speedOf($('bedPreset'), est.get());
const speedName = () => `${ESTIMATE.SPEEDS[speedNow()].name} printer`;
// one piece's filament in grams, once it exists; the same blend as the total
function pieceGrams(id) {
  return builds[id] ? filamentOf(builds[id].mat) * PLA_DENSITY / 1000 : null;
}
/* What one plate of the plan weighs and roughly takes: its pieces, stacked ones included,
   and its keys, each measured the way the total measures them. */
function plateEstimate(pl) {
  const keyMm3 = printPlan.keyMat ? filamentOf(printPlan.keyMat) : 0;
  const parts = pl.placed.map((p) => ({
    vol: p.id === 'key' ? keyMm3 : builds[p.id] ? filamentOf(builds[p.id].mat) : 0,
    h: p.h, z: p.z }));
  const mm3 = parts.reduce((a, p) => a + p.vol, 0);
  return { grams: mm3 * PLA_DENSITY / 1000,
           min: ESTIMATE.roundMinutes(ESTIMATE.plateSeconds(parts, speedNow())) };
}
// "64 g · £1.28 · ≈ 2 h 15 min": a plate's weight, its cost once priced, its rough time
function plateFigures(e) {
  return `${massText(e.grams)}${costTail(e.grams)} · ≈ ${ESTIMATE.duration(e.min)}`;
}
/* Every plate's figures and the time in all, which is the sum of the plate times as
   shown, so the plates and the total add up. Null until there is a plan to time. */
function jobTime() {
  if (!printPlan) return null;
  const plates = printPlan.plates.filter((pl) => !pl.overflow).map(plateEstimate);
  return { plates, min: plates.reduce((a, e) => a + e.min, 0) };
}
/* What the time leaves out: the pieces too big for the bed, which have no plate to time.
   Where it is said, "over 3 plates" is not as well: it would be the plates said twice. */
const fitNote = () => (printPlan && printPlan.over.length ? ' for the plates that fit' : '');
/* A new price or speed changes figures and nothing else, so it redraws the two places on
   the page that show them; the dialog follows, since both of these sync it. */
function refreshEstimates() {
  if (!layout) return;
  drawPieceTable();
  renderPrintPlan();
}

// bounding box of a part, for laying copies out and for reserving bed space
function partExtent(polys) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const v of p.verts) for (let k = 0; k < 3; k++) {
    if (v[k] < lo[k]) lo[k] = v[k];
    if (v[k] > hi[k]) hi[k] = v[k];
  }
  return { w: hi[0] - lo[0], d: hi[1] - lo[1], h: hi[2] - lo[2] };
}
// the coupon, built the one way — the button saves this and test/ui/fit-sample.spec.js
// measures it, so there is no route to a coupon the tests have not seen
function fitSample() {
  return buildFitSample(state, builtH(), activeJoint());
}
function downloadFitSample() {
  const fsam = fitSample();
  saveBlob(stlBinary(fsam.polys, 'fit-sample'),
    `${state.connector}-fit-sample-clr-${fsam.clrs.map(c=>c.toFixed(2)).join('-')}.stl`);
}
/* Every connector that needs loose parts is in KEYED, declared at the top with
   KEY_CONN. The ZIP used to carry its own shorter copy of that list that left out
   H-clips, so an hclip download arrived with a README telling the reader to press a
   clip into each junction and no clip in the file. One list, and one function that
   decides what is in the STL. */
function keysStl() {
  const part = connectorPart();
  const ext = partExtent(part.polys);
  const nKeys = keysNeeded();
  const cols = Math.ceil(Math.sqrt(nKeys));
  const polys = [];
  for (let k = 0; k < nKeys; k++) {
    // spaced off the part's own extent: the grid used to be spaced off key parameters,
    // and a puzzlekey's lobes reach past wEnd, so its copies overlapped on the plate
    const dx = (k % cols) * (ext.w + 6), dy = Math.floor(k / cols) * (ext.d + 6);
    for (const p of part.polys)
      polys.push({ verts: p.verts.map(v => [v[0]+dx, v[1]+dy, v[2]]), plane: p.plane });
  }
  return { polys, mesh: part.mesh, name: `${part.stem}-x${nKeys}.stl` };
}
function downloadKeys() {
  const k = keysStl();
  saveBlob(stlBinary(k.polys, k.mesh), k.name);
}
/* How many keys the assembly needs — anything housed in a wall skips a seam that
   overlaps by a single cell, because there is no wall junction there to sink one into.
   Top-inserted snap clips force that count whatever the housing says, since they enter
   through the wall by definition.

   keysNeeded is the ONLY answer to "how many keys": the STL lays out this many, the
   print plan reserves this many and the 3MF plate carries this many. It is a single
   function because it was once three expressions — the plan counted every junction, the
   STL filtered, and a staggered split with wall housing therefore shipped a plan with
   more clips on it than the file had in it. test/ui/keys.spec.js drives a layout where
   the two counts differ and holds them together. */
function keyCount(wallOnly) {
  const wallish = wallOnly || state.keyMount === 'wall' || state.connector === 'hclip';
  return layout.seams.reduce((a, s) => a + s.junctions.filter(j =>
    !wallish || Math.abs(j - Math.round(j)) <= 0.25).length, 0);
}
const topClips = () => state.connector === 'snap' && state.keyInsert === 'top';
/* No floor of one. A plate that is a single piece has no seams, so it needs no keys —
   the `|| 1` that used to sit here put a key in the ZIP, on the print plan and in the
   file list for a design with nothing to join. shipsKeys is the one test for "is there
   a loose part to offer at all", so the plan, the ZIP and the dialog agree on it. */
const keysNeeded = () => keyCount(topClips());
const shipsKeys = () => KEYED.includes(state.connector) && keysNeeded() > 0;
async function downloadEverythingZip() {
  if (Object.keys(builds).length < layout.pieces.length) return;
  const zip = new JSZip();
  for (const pc of layout.pieces)
    zip.file(`baseplate-${pc.id}.stl`, stlBinary(builds[pc.id].polys, pc.id));
  if (shipsKeys()) {
    const k = keysStl();
    zip.file(k.name, stlBinary(k.polys, k.mesh));
  }
  if (printPlan) {
    for (let i = 0; i < printPlan.plates.length; i++)
      zip.file(`print-plates/plate-${i+1}.3mf`, await plate3mfBytes(i));
  }
  zip.file('README.txt', readmeText());
  saveBlobAsync(await zip.generateAsync({ type: 'blob', ...ZIP_DEFLATE }),
                `gridfinity-baseplate-${layout.nx}x${layout.ny}.zip`);
}
function readmeText() {
  const rows = [...new Set(layout.pieces.map(p => p.band))].length;
  const lines = [];
  lines.push('GRIDFINITY BASEPLATE — generated by Drawerforge');
  lines.push('===============================================');
  lines.push('https://drawerforge.co.uk');
  lines.push('');
  lines.push(`Drawer: ${state.drawerW} x ${state.drawerD} mm | Grid: ${layout.nx} x ${layout.ny} cells @ ${state.pitch} mm`);
  /* The solid margins, and the half cells on a line of their own after them: they take
     the place of margin, and the README is read away from the page, where nothing else
     says what a half cell will hold. */
  const [mL, mR, mF, mB] = solidMargins();
  lines.push(`Margins: L ${mL.toFixed(1)} R ${mR.toFixed(1)} F ${mF.toFixed(1)} B ${mB.toFixed(1)} mm`);
  if (layout.hX || layout.hY)
    lines.push(`Half cells: ${halfStripText()} (${halfCellMm()} mm), for ` +
               'half-size bins only; no magnet or screw holes in them');
  lines.push(`Split: ${splitName()} | Pieces: ${layout.pieces.length} in ${plural(rows, 'row band')}`);
  lines.push(`Connectors: ${state.connector}` + (state.connector === 'dovetail' ? ` (clearance ${state.tab.clr} mm/side)` : ''));
  if (state.magnets) lines.push(`Magnets: ${state.magnetD} x ${state.magnetH} mm, from ${state.magnetSide}`);
  /* A head that does not clear the hole's corners is cut as none (MOUNT_BORE in core.js),
     and one no wider than the hole always was; the README says so, and for a head that
     was meant as a counterbore, the size that would be one. */
  const { head } = MOUNT_BORE;
  if (state.screws) lines.push(`Screws: ${state.screwHoleD} mm holes, ` +
    (head.cuts(state.screwHeadD, state.screwHoleD) ? `${state.screwHeadD} mm counterbore`
      : 'no counterbore' + (state.screwHeadD <= state.screwHoleD ? ''
        : ` (a head clears a ${state.screwHoleD} mm hole from ` +
          `${Math.ceil(head.over(state.screwHoleD) * 100 - 1e-9) / 100} mm)`)));
  /* The figure the dialog quotes, said the way it says it, with the price it was worked
     out at: the README is read away from the page. The ZIP is only made once every piece
     exists, so there is always a total to give. */
  const g = materialGrams();
  if (g !== null)
    lines.push(`Material: about ${massText(g)} of PLA` +
               (costOf(g) ? ` (about ${costOf(g)} at ${ESTIMATE.perKg(est.get())})` : '') +
               ` ${infillNote()}.`);
  lines.push('');
  lines.push('LAYOUT (front of drawer at the bottom):');
  const bandIds = {};
  for (const pc of layout.pieces) (bandIds[pc.band] = bandIds[pc.band] || []).push(pc.id);
  Object.keys(bandIds).sort((a, b) => b - a).forEach(b => lines.push('  ' + bandIds[b].join(' | ')));
  lines.push('');
  lines.push('PRINTING: flat as oriented, no supports needed. Print the test tile first');
  lines.push('and check a bin fits before committing to the full plates.');
  lines.push('');
  if (printPlan) {
    lines.push(`PRINT PLATES: ${printPlan.plates.length} — pre-arranged 3MF files in print-plates/ open directly in your slicer.`);
    // numbered as the files in print-plates/ are
    const job = jobTime();
    printPlan.plates.forEach((pl, i) => {
      if (pl.overflow) return;
      const e = plateEstimate(pl), c = costOf(e.grams);
      lines.push(`  plate ${i + 1}: ${plural(pl.placed.length, 'part')}, about ${massText(e.grams)}` +
                 (c ? `, ${c}` : '') + `, roughly ${ESTIMATE.duration(e.min)}`);
    });
    if (job.plates.length) {
      lines.push(`Print time: roughly ${ESTIMATE.duration(job.min)} on a ${speedName()}` +
                 (job.plates.length > 1 && !fitNote() ? ` over ${job.plates.length} plates` : '') + `${fitNote()}.`);
      lines.push('That is a rough estimate from the filament and the layer count, not a slice:');
      lines.push('your slicer gives the real figure.');
    }
  }
  lines.push('');
  /* Which assembly the reader is walked through is the same question the geometry
     answered, so it is asked with the same predicates. It was asked here with its own
     copy — connector and keyMount spelled out again — and that copy disagreed with the
     tool for a top-inserted snap housed in the floor: topClips ships U-clips for that,
     and the reader was being told to press a flat key into a pair of recesses. */
  if (state.connector === 'puzzle') {
    lines.push('ASSEMBLY: lower the pieces together on a flat surface so each jigsaw lobe');
    lines.push('drops into its cavity, then lift the assembled plate into the drawer.');
  } else if (topClips()) {
    lines.push('ASSEMBLY: lay the pieces in the drawer edge to edge, then press a U-clip');
    lines.push('into each junction from above until it clicks. The bridge sits flush.');
    lines.push('Print clips flat as oriented with a 0.4 mm nozzle and 2+ walls.');
  } else if (keyFromTop()) {
    lines.push('ASSEMBLY: lay the pieces in the drawer edge to edge, then drop a key into');
    lines.push('each junction opening from above and press flush.');
  } else if (keyInWall()) {
    lines.push('ASSEMBLY: place pieces face-down edge to edge, press a key into each pair');
    lines.push('of wall pockets, then flip and lower into the drawer.');
  } else if (state.connector === 'puzzlekey' || state.connector === 'snap') {
    lines.push('ASSEMBLY: place pieces face-down edge to edge, press a key into each pair');
    lines.push('of recesses' + (state.connector === 'snap' ? ' until it clicks' : '') + ', then flip and lower into the drawer.');
  } else if (state.connector === 'dovetail') {
    lines.push('ASSEMBLY: on a flat surface, lay the piece with tabs down first, then lower');
    lines.push('each neighbour so its pockets drop over the tabs. Lift the assembled plate');
    lines.push('into the drawer. Tight joints: a light scrape on the tab flanks.');
  } else if (state.connector === 'bowtie') {
    lines.push('ASSEMBLY: place pieces face-down edge to edge, press a bowtie key into each');
    lines.push('pair of recesses, then flip the assembly and lower it into the drawer.');
  }
  lines.push('');
  lines.push('Settings link: ' + shareLink());
  lines.push('');
  lines.push('-----------------------------------------------');
  lines.push('Made with Drawerforge — https://drawerforge.co.uk');
  lines.push('Free and open source (AGPL-3.0). Runs in your browser. These files are yours.');
  lines.push('');
  lines.push('Bugs & feature requests:');
  lines.push('  https://github.com/Oliver-Johnson/DrawerForge/issues');
  lines.push('  (attaching the settings link above makes reports much easier to act on)');
  lines.push('');
  lines.push('If it saved you some time, there is a tip jar:');
  lines.push('  https://ko-fi.com/oliver_johnson');
  lines.push('');
  lines.push('Gridfinity was created by Zack Freedman (Voidstar Lab) as an open standard.');
  return lines.join('\n');
}

/* ---------- the download dialog -------------------------------------------
   Export was panel 07: five buttons in the settings rail, present the whole time you
   were designing, three of them named after things you would have to download to
   identify. It is a dialog now, and it states what the design is and whether it fits
   your bed before it lists a single file. The row and group widgets are shared with
   the bins tool, in widgets.js. */
const exGroup = (text) => DF.group($('exFiles'), text);
const exRow = (name, meta, label, onClick, attrs) =>
  DF.row($('exFiles'), { name, meta, label, onClick, attrs });

const CONNECTOR_NAMES = { dovetail: 'dovetail tabs', puzzle: 'puzzle tabs', bowtie: 'bowtie keys',
  puzzlekey: 'puzzle keys', snap: 'snap clips', hclip: 'H-clips', none: 'no connectors' };
/* The same job as CONNECTOR_NAMES, for the same reason. `plates` is the value on the
   button labelled "Fewest plates", and it was interpolated straight into user copy —
   the dialog said "4 piece(s), plates split" and the README in every ZIP said
   "Split: plates". An internal enum is not a name for anything. */
const SPLIT_NAMES = { balanced: 'balanced', staggered: 'staggered',
  plates: 'fewest plates', manual: 'manual' };
/* hasOwn, not a bare lookup: SPLIT_NAMES.constructor is Object, so "sp=constructor" in a
   link was a "function Object() { [native code] } split" on screen and in the README.
   Not Object.hasOwn, which Safari only has from 15.4: before that it threw here, inside
   drawing the map, and the page never laid out. */
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const splitName = () =>
  (hasOwn(SPLIT_NAMES, state.splitMode) ? SPLIT_NAMES[state.splitMode] : state.splitMode);

/* What goes wrong is tested before whether the build has finished, not after. Anything
   the checks call an error stops runBuild, so the pieces never finish and never will —
   and answering "this piece does not fit your bed" with "still building" is true and
   useless. warningsList is the same predicate runBuild gates on, so the dialog and the
   build cannot disagree about whether there is a problem. */
function bedFitText() {
  const bed = `${state.bedW} × ${state.bedD} mm bed`;
  // guard, so the "largest piece" arithmetic below never reasons about an empty list
  if (!layout.pieces.length)
    return { cls: 'bad', t: 'There is nothing to generate yet — see the checks under the cut map.' };
  const bad = layout.pieces.filter((pc) => !footprintFits(pc));
  if (bad.length)
    return { cls: 'bad', t: `${plural(bad.length, 'piece')} — ${bad.map((pc) => pc.id).join(', ')} — ` +
      `will not fit your ${bed}. Add a cut through them on the cut map, or pick a split mode ` +
      'that makes smaller pieces; the files below would print oversized as they stand.' };
  // a cut cannot fix this one, so it gets its own sentence rather than the one above
  if (!heightFits())
    return { cls: 'bad', t: `The plate is ${roundMm(plateHeightMm())} mm tall and your printer ` +
      `builds ${state.bedH} mm high. Lower the extra floor, or check the bed height.` };
  const err = warningsList().find((w) => w.err);
  if (err) return { cls: 'bad', t: err.t + ' Nothing can be exported until that is fixed.' };
  if (buildFailed)
    return { cls: 'bad', t: `Piece ${buildFailed} could not be built, so the build stopped there. ` +
      'Move a cut through it or pick another joint; the plates cannot be exported until every piece builds.' };
  const ready = Object.keys(builds).length;
  if (ready < layout.pieces.length)
    return { cls: 'wait', t: `Still building — ${ready} of ${plural(layout.pieces.length, 'piece')} ready. ` +
      'The meshes below appear as they finish.' };
  // quoting pieceExtent, so the number shown is the number the test above used
  const big = layout.pieces.map(pieceExtent).sort((a, b) => b[0] * b[1] - a[0] * a[1])[0];
  /* One piece is "the piece", not "all 1 piece", and has no "largest" to compare. */
  const size = `${big[0].toFixed(0)} × ${big[1].toFixed(0)} mm`;
  return { cls: 'ok', t: layout.pieces.length === 1
    ? `The piece fits your ${bed} — it needs ${size}.`
    : `All ${layout.pieces.length} pieces fit your ${bed} — the largest needs ${size}.` };
}

function renderExportSummary() {
  const pitch = state.pitch;
  const g = materialGrams(), job = jobTime();
  const [mL, mR, mF, mB] = solidMargins(), strips = halfStripText();
  $('exDesign').textContent =
    `${layout.nx} × ${layout.ny} cell grid (${(layout.nx * pitch).toFixed(0)} × ${(layout.ny * pitch).toFixed(0)} mm)` +
    (strips ? `, plus ${strips},` : '') +
    ` in a ${state.drawerW} × ${state.drawerD} mm drawer\n` +
    `${plural(layout.pieces.length, 'piece')}, ${splitName()} split, joined with ${CONNECTOR_NAMES[state.connector] || state.connector}\n` +
    `margins L ${mL.toFixed(1)} / R ${mR.toFixed(1)} / F ${mF.toFixed(1)} / B ${mB.toFixed(1)} mm` +
    /* The cost goes straight after the grams it is the price of, ahead of the note on
       the infill, which is about the grams. The time follows on a line of its own. */
    (g === null ? '' : `\nabout ${massText(g)} of PLA` +
      (costOf(g) ? ` (about ${costOf(g)} at ${ESTIMATE.perKg(est.get())})` : '') + ` ${infillNote()}`) +
    (g === null || !job || !job.plates.length ? ''
      : `\nroughly ${ESTIMATE.duration(job.min)} of printing` +
        (job.plates.length > 1 && !fitNote() ? ` over ${plural(job.plates.length, 'plate')}` : '') +
        ` on a ${speedName()}${fitNote()} (${ESTIMATE.ROUGH})`);
  const fit = bedFitText();
  $('exFit').className = 'exfit ' + fit.cls;
  $('exFit').textContent = fit.t;
}

/* Every row's button used to be called either "Download" or "STL", so a dialog with
   twenty-eight of them in it — 600 × 450 on a 180 mm bed — presented a screen reader
   with twenty-eight identical controls. The visible label stays short, because the
   column is narrow and the name is right beside it; the accessible name says which
   file and in what format. */
function renderExportFiles() {
  $('exFiles').innerHTML = '';
  const ready = Object.keys(builds).length >= layout.pieces.length;

  /* The tile and the sample go first. The group is called "print these first" and it
     was last, under everything else and below the fold on any bed small enough to make
     a lot of plates — advice you have to scroll past the thing it is advice about is
     not advice. They are also the only two rows that are always available, because
     neither waits on the pieces being built. */
  exGroup('Print these first');
  /* No byte size on this row. It is the one file nothing has built yet, and building a
     tile purely to measure it would be work done on every open for a number nobody
     needs — the point of the row is that it is small and quick. */
  exRow('Bin fit test tile', 'one 1 × 1 cell of the plate · STL',
        'STL', () => saveBlob(stlBinary(testTilePolys(), 'test-tile'),
                              'baseplate-test-tile-1x1.stl'),
        { 'data-ex': 'tile', 'aria-label': 'Download the bin fit test tile (STL)' });
  if (state.connector !== 'none')
    exRow('Joint fit sample', 'four tile pairs at graduated clearances · STL',
          'STL', downloadFitSample,
          { 'data-ex': 'fit', 'aria-label': 'Download the joint fit sample (STL)' });

  if (printPlan && printPlan.plates.length) {
    const n = printPlan.plates.length;
    /* Each plate says what it weighs, costs and roughly takes, and so does the whole set:
       "which plate tonight" is a question about time. */
    const job = jobTime();
    const all = { grams: job.plates.reduce((a, e) => a + e.grams, 0), min: job.min };
    exGroup('Pre-arranged print plates');
    // named as the recommended path, because it is: every part already placed on a bed,
    // in the order the plan worked out, with nothing left to arrange
    exRow('Every plate — recommended',
          `${plural(n, 'plate')} · ${plateFigures(all)} · 3MF` + (n > 1 ? ' in a ZIP' : '') +
          ' · the whole job, arranged',
          'Download', downloadAllPlates,
          { 'data-ex': 'allplates', 'aria-label': 'Download every print plate (3MF)' });
    /* Per-plate downloads. The combined export already builds each plate on its own
       before zipping them, so one plate at a time is the same call with the zip left
       off — and it is what you want when one print failed, or when tonight's print is
       only this plate. */
    printPlan.plates.forEach((pl, i) => exRow(`Plate ${i + 1}`,
      `${plural(pl.placed.length, 'part')} on a ${state.bedW} × ${state.bedD} mm bed · ` +
      `${plateFigures(plateEstimate(pl))} · 3MF`, 'Download',
      async () => saveBlob(await plate3mfBytes(i), `plate-${i + 1}.3mf`),
      { 'data-ex': 'plate', 'aria-label': `Download plate ${i + 1} (3MF)` }));
  }

  exGroup('Meshes');
  exRow('Everything, with a README', 'every piece' +
        (printPlan ? ', the print plates' : '') + ' and the assembly order · ZIP',
        'Download', downloadEverythingZip,
        { 'data-ex': 'zip', 'aria-label': 'Download everything, with a README (ZIP)' });
  for (const pc of layout.pieces) {
    const b = builds[pc.id];
    const btn = exRow(`Piece ${pc.id}`,
          `${cellsOf(pc)} cells · ` + (b ? `${DF.bytes(DF.stlBytes(b.polys))} · STL` : 'not built yet'),
          'STL', () => downloadPiece(pc.id),
          { 'data-ex': 'piece', 'aria-label': `Download piece ${pc.id} (STL)` });
    btn.disabled = !b;   // downloadPiece would otherwise fail silently
  }
  if (shipsKeys()) {
    const kn = state.connector === 'snap' ? 'Snap clips' : 'Connector keys';
    exRow(kn, `${keysNeeded()} needed, laid out on one plate · STL`, 'STL', downloadKeys,
          { 'data-ex': 'keys', 'aria-label': `Download the ${kn.toLowerCase()} (STL)` });
  }

  if (!ready)
    for (const btn of $('exFiles').querySelectorAll('button[data-ex="zip"],button[data-ex="allplates"],button[data-ex="plate"]'))
      btn.disabled = true;
}

/* The dialog was a snapshot, and said so in a sentence that was not true: "the meshes
   below appear as they finish", from a render with exactly one call site — the open
   handler. Open it mid-build and it kept the same half-built list and the same disabled
   ZIP for good, and you had to close and reopen. The build is asynchronous and the page
   rebuilds behind a 260 ms debounce on every control change, so "change a setting, hit
   Download" lands there routinely on a slow machine.
   Rebuilding the list is the only honest option — the plate rows do not merely change,
   they do not exist until the plan does — so it is rebuilt, except while the keyboard
   is inside it, where a rebuild would throw the focus away mid-tab. That case retries
   as soon as focus leaves. */
let exportDeferred = false;
function syncExportDialog() {
  if (!$('exportDlg').open || !layout) return;
  renderExportSummary();
  if ($('exFiles').contains(document.activeElement)) { exportDeferred = true; return; }
  exportDeferred = false;
  renderExportFiles();
}
function updateExportTail() {
  if (!layout) return;
  const n = layout.pieces.length;
  $('exportTail').textContent = plural(n, 'piece') +
    (printPlan ? ` · ${plural(printPlan.plates.length, 'plate')}` : '');
  syncExportDialog();
}
function openExportDialog() {
  renderExportSummary();
  renderExportFiles();
  const dlg = $('exportDlg');
  // showModal is the whole point — the fallback is for a browser old enough not to
  // have it, where an in-flow panel that closes is still better than a dead button
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}
$('openExport').addEventListener('click', openExportDialog);
$('exportClose').addEventListener('click', () => $('exportDlg').close());
$('exportDlg').addEventListener('focusout', () => {
  // the new focus is not settled until after the event, hence the deferral
  if (exportDeferred) setTimeout(syncExportDialog, 0);
});
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

// ---------- share link ----------
// Descriptor keys owned by the bins tool (or any future tool). We never interpret
// them, but we carry them so a round trip through here is lossless.
let hashExtras = {};
const OWNED = new Set(['w','d','mm','ax','ay','ml','mr','mf','mb','bw','bd','bh','pr','sp','km','ki',
  'rc','cc','cn','cl','to','mg','md','mh','ms','sc','sh','sd','se','pi','or','bp','tc','bm','pc',
  'r1','r2','r3','r4','v','ph','ps','if']);

function descriptor() {
  const o = {
    w: state.drawerW, d: state.drawerD, mm: $('marginMode').value,
    ax: state.alignX, ay: state.alignY,
    ml: state.mLeft, mr: state.mRight, mf: state.mFront, mb: state.mBack,
    bw: state.bedW, bd: state.bedD, bh: state.bedH, sp: state.splitMode, km: state.keyMount, ki: state.keyInsert,
    /* Which printer, as well as its bed: several entries share a 256 mm bed, and a link
       that reopened on whichever came first in the list would name a printer the sender
       never picked. The bed numbers stay the authority — see FIELDS.presetFor. */
    pr: $('bedPreset').value,
    rc: state.rowCuts || '', cc: state.colCuts ? state.colCuts.map(c => c.join('.')).join('_') : '',
    cn: state.connector, cl: state.tab.clr, to: state.tolerance,
    mg: state.magnets ? 1 : 0, md: state.magnetD, mh: state.magnetH, ms: state.magnetSide,
    sc: state.screws ? 1 : 0, sh: state.screwHoleD, sd: state.screwHeadD, se: state.screwHeadDepth,
    pi: state.pitch, or: state.outerRadius, bp: state.bottomPad, tc: state.topCutoff,
    bm: state.baseMode, ps: state.plateStyle, pc: $('perCorner').checked ? 1 : 0,
    if: state.infill,
    r1: $('rFL').value, r2: $('rFR').value, r3: $('rBL').value, r4: $('rBR').value,
  };
  return Object.assign({}, hashExtras, o, { v: 2 });
}
/* Names are encoded as well as values. Keys from other tools ride through here as they
   came, and loadFromHash decodes them, so one written raw did not survive its own round
   trip: "%25=1" was carried as "%=1", and every visit after that threw URIError reading
   the save back. A raw line break in a name would also have reached the README. */
const encodeDesc = (o) => Object.entries(o)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
/* One bad pair costs that pair. A malformed escape (%E0%A4%A) used to throw out of the
   whole load, and a pair with no '=' was kept as a setting whose value was undefined. */
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
const SAVE_KEY = 'drawerforge:plates:v1';
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
  hashReady = false; dropSave();   // no save of this page's may land after
  location.href = url;
}
/* Swapped rather than copied over: what is here now goes aside in its place, so putting
   a layout back is never the step that loses one. */
function putBack() {
  const prev = readKey(PREV_KEY);
  if (!prev) return;
  const prevLinked = readKey(PREV_LINKED_KEY);
  const cur = encodeDesc(descriptor());
  if (cur !== pristine && !(stalled && cur === bootDesc)) {
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

/* Not while a press on the cut map is held: the save waits for the release. On a link
   that set a layout aside, the first save to find the design changed takes the
   set-aside line above the map away (below), and the map goes up 43 px. A cut is made
   by a click, which the browser gives the grid line only when the press and the release
   are both on it, so a line pressed a moment after the click before it, and held over
   that click's save, was let go 43 px from where it was pressed and the click went
   nowhere. The save is the one thing that runs on a clock while a press is held, so
   holding it holds all a save changes above the map, as on the bins page. mapHeld runs
   from a press on the map to its release, wherever that is; a save that came due in
   between is set going again by the release (saveHeld). */
let mapHeld = false, saveHeld = false;
/* A press on the cut map that leave() let go of. A press let go in another window makes
   no click, but one ended as the page is left can still be let go on the line it was
   pressed on while the next page loads, and its click is then no cut. The next press on
   the map is a press again. */
let mapLeft = false;
function rememberState() {
  if (!hashReady) return;
  clearTimeout(hashSaveT);
  addEventListener('beforeunload', dropSave);
  hashSaveT = setTimeout(() => { if (mapHeld) saveHeld = true; else saveNow(); }, 400);
}
$('cutmap').addEventListener('pointerdown', () => { mapHeld = true; mapLeft = false; });
const letGoOfMap = () => {
  if (!mapHeld) return;
  mapHeld = false;
  if (saveHeld) { saveHeld = false; rememberState(); }
};
/* On the window, so that a release off the map counts too. Let go on a grid line, the
   click that follows is an edit, and sets the save going again of itself. */
addEventListener('pointerup', letGoOfMap, true);
addEventListener('pointercancel', letGoOfMap, true);
/* A release the page never hears of, let go in another window after an alt-tab, left
   the map held and every save after it waiting, keyboard edits included, until the next
   release somewhere on the page. A pointer that moves with no button down is not
   holding anything. */
addEventListener('pointermove', (e) => { if (!e.buttons) letGoOfMap(); }, true);
function saveNow() {
  clearTimeout(hashSaveT);
  removeEventListener('beforeunload', dropSave);
  const h = encodeDesc(descriptor());
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
    try { history.replaceState(drawers.stamp(h, linkedNow && bootDesc !== null), '', '#' + h); }
    catch (err) { /* some browsers refuse replaceState on file:// — a lost URL is not
                     worth an exception that stops the rest of the page working */ }
  }
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
  return location.origin + location.pathname + '#' + encodeDesc(descriptor());
}
/* Saved drawers — the list, the design file, and which one this page is working on —
   are shared with the bins page and live in src/shared-ui/drawers.js. What this page
   tells it is which keys of the design string are its own to write. Every key in OWNED
   except 'ph': that one is listed so a plate height carried in from bins is not echoed
   back out, but it is the bins page's setting, and a save from here must not wipe the
   value bins stored. */
const drawers = DRAWERS.create({
  tool: 'plates',
  owns: (k) => OWNED.has(k) && k !== 'ph',
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
// Hand the drawer across to the bins tool. Only the shared keys travel; the bins
// tool re-emits anything it doesn't recognise, so a round trip is lossless.
/* The plate height is worked out from the settings, as buildPiece works it out
   (plateHeightMm), and not read off the first piece built. The pieces are rebuilt 260 ms
   after a change, behind the debounce, so a link followed in that time carried the plate
   from before it: tick Magnets and go, and Bins was told 4.25 mm about a 7.05 mm plate.
   With nothing built, as when the checks stop the build, it was 4.25 mm with no floor
   under it. Once a piece has built the two are the same number.
   test/ui/bins-plate-grid.spec.js follows both links before the rebuild lands. */
function binsHref() {
  // full baseplate state plus the plate height bins needs; extras ride along
  return 'bins/#' + encodeDesc(Object.assign(descriptor(), { ph: plateHeightMm().toFixed(2) }));
}
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
   A press still held on the cut map is let go first, as one let go in another window is
   (letGoOfMap), and makes no cut (mapLeft): the link can be followed from the keyboard
   while the mouse holds a grid line. Left held, letting go on the line made its click, a
   cut, while the next page loaded, and the save that set going put another layout in the
   address, the local save and the drawer after this one had been handed over. */
function leave(href) {
  if (mapHeld) { mapLeft = true; letGoOfMap(); }
  if (hashReady) saveNow();
  drawers.handoff(href.slice(href.indexOf('#') + 1),
    linkKeys(encodeDesc(descriptor()), heldLink));
  location.href = href;
}
for (const id of ['toBins', 'navBins'])
  $(id).addEventListener('click', (e) => { e.preventDefault(); leave(binsHref()); });
/* The guide holds no state, so hand it ours and it can hand it back — what the bins page
   would be handed, plate height and all: it passes the layout on to either tool, and
   without ph the bins page took a 4.25 mm plate. */
$('navGuide').addEventListener('click', (e) => {
  e.preventDefault();
  const h = binsHref();
  leave('guide/' + h.slice(h.indexOf('#')));
});
$('shareBtn').addEventListener('click', () => {
  const link = shareLink();
  navigator.clipboard.writeText(link).then(
    () => { $('shareBtn').textContent = 'Copied ✓'; setTimeout(() => $('shareBtn').textContent = 'Copy settings link', 1600); },
    () => prompt('Copy this link:', link));
});
function loadFromHash(src) {
  const h = (src !== undefined ? src : location.hash || '').replace(/^#/, '');
  if (h.length < 2) return;
  const q = parseHash(h);
  for (const [k, v] of Object.entries(q)) if (!OWNED.has(k)) hashExtras[k] = v;
  /* A menu takes only a value it offers. "cn=bogus" left the connector menu blank, so
     the plates were cut for keys that were then never exported, and the fit sample was
     named "-fit-sample-". Anything else keeps the default.
     The link is millimetres, always; a drawer length is written into its field in
     whatever unit the field is showing. Anything that is not a number goes in as it
     came, so the field's own check can say what is wrong with it. */
  const set = (id, v) => {
    const el = $(id);
    if (v === undefined || !el) return;
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === v)) return;
    if (LENGTH_IDS.includes(id) && v !== '' && isFinite(+v)) FIELDS.setLength(el, +v, unit);
    else el.value = v;
  };
  set('drawerW', q.w); set('drawerD', q.d); set('marginMode', q.mm);
  set('alignX', q.ax); set('alignY', q.ay);
  set('mLeft', q.ml); set('mRight', q.mr); set('mFront', q.mf); set('mBack', q.mb);
  set('bedW', q.bw); set('bedD', q.bd); set('bedH', q.bh); set('keyMount', q.km); set('keyInsert', q.ki);
  set('connector', q.cn); set('connClr', q.cl); set('tolerance', q.to);
  if (q.mg !== undefined) $('magnets').checked = q.mg === '1';
  set('magnetD', q.md); set('magnetH', q.mh); set('magnetSide', q.ms);
  if (q.sc !== undefined) $('screws').checked = q.sc === '1';
  set('screwHoleD', q.sh); set('screwHeadD', q.sd); set('screwHeadDepth', q.se);
  set('pitch', q.pi); set('outerRadius', q.or); set('bottomPad', q.bp); set('topCutoff', q.tc);
  set('baseMode', q.bm); set('plateStyle', q.ps); set('infill', q.if);
  if (q.pc !== undefined) $('perCorner').checked = q.pc === '1';
  set('rFL', q.r1); set('rFR', q.r2); set('rBL', q.r3); set('rBR', q.r4);
  // only a split the page has; anything else is not a split, it is text for the README
  if (q.sp && hasOwn(SPLIT_NAMES, q.sp)) {
    state.splitMode = q.sp; setSplitSeg(q.sp);
    if (q.sp === 'manual') {
      state.rowCuts = cutList(q.rc, ',');
      state.colCuts = q.cc ? q.cc.split('_').slice(0, MAX_PIECES).map((s) => cutList(s, '.')) : [];
    }
  }
  /* The list follows the bed, not the other way round. It did not follow it at all: a
     link with a 180 mm bed reopened with the fields at 180 and the list still showing
     the 256 mm entry above them. */
  $('bedPreset').value = FIELDS.presetFor($('bedPreset'), bedNow(), q.pr);
}
/* Cuts are whole cells, each one once, in order, and no more than the pieces this page
   will build. "rc=2,2,2" built zero-height pieces, "rc=1.5" a fractional one, and 2,500
   copies of one cut took 1.8 GB — and were saved, so every visit after took it again. */
const CUT_TOP = Math.floor(LIMITS.drawerW.max / LIMITS.pitch.min);   // most cells on a side
const cutList = (s, sep) => [...new Set(String(s || '').split(sep).map(Number))]
  .filter((n) => Number.isInteger(n) && n > 0 && n < CUT_TOP)
  .sort((a, b) => a - b).slice(0, MAX_PIECES - 1);

const bedNow = () => [+$('bedW').value, +$('bedD').value, +$('bedH').value];

/* ---------- undo -----------------------------------------------------------
 * Bins has had Undo since it shipped and this page had none, so a stray click on the
 * cut map — one click on a grid line switches the whole split to Manual — or a figure
 * typed into the wrong field could only be put back by remembering what it was.
 *
 * Each step is the serialised design: the string the share link and the local save
 * already carry. So "what undo restores" and "what a link reproduces" are the same
 * thing by construction, and a setting added to the link is undoable without anyone
 * remembering to make it so. What the link leaves out — the print plan's spacing and
 * stacking, the exploded view — is how the job is laid out or looked at, not what is
 * being made, and undo leaves it alone for the reason bins' undo leaves the drawer
 * walls alone: it should never move something you did not just change.
 *
 * Recorded from recomputeLayout, which every design change already passes through,
 * rather than pushed from each handler. Bins pushes per handler, and the one handler
 * that forgot (drawing a new bin) shipped with an Undo that did nothing; here there is
 * no handler to forget.
 *
 * Typing is coalesced. Every keystroke in a number field is an input event and a full
 * recompute, so one step per event made "306" to "512" three undos with two designs
 * nobody asked for in between. A run of typing in one field is one step, and it ends
 * when the field commits — its change event, which is leaving it or pressing Enter — or
 * when anything else changes the design.
 *
 * Not a timer. "Keystrokes under a second apart" was the first version, and it split a
 * typed number into several steps whenever a build was running: each piece is built in
 * one synchronous slice of CSG that can hold the page for longer than that, the next
 * keystroke is only seen once it lets go, and so the gap between two keys typed a
 * quarter of a second apart measured as two seconds. The field's own commit is the
 * boundary the person actually drew. */
const undoStack = [], redoStack = [];
const UNDO_MAX = 60;          // the same depth bins keeps
let undoNow = null;           // the design on screen: what the next step moves away from
let typing = null;            // id of the field whose run of typing is still open
let undoApplying = false;
const designNow = () => encodeDesc(descriptor());

function noteDesignChange(ev) {
  const now = designNow();
  // the first call is the page arriving, and arriving is not an edit
  if (undoNow === null || undoApplying) { undoNow = now; updateUndoButtons(); return; }
  // the field committing ends its run of typing, even when the value did not move
  if (ev && ev.type === 'change') typing = null;
  if (now === undoNow) return;
  const el = ev && ev.type === 'input' ? ev.target : null;
  const typed = !!el && el.tagName === 'INPUT' && (el.type === 'number' || el.type === 'text');
  const sameRun = typed && typing === el.id;
  if (!sameRun) {
    undoStack.push(undoNow);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  } else if (undoStack[undoStack.length - 1] === now) {
    /* The run has typed its way back to where it started — most often the browser's own
       field undo, which Ctrl+Z inside a field is left to (see the keydown handler). The
       entry it opened now describes no change, and an Undo that visibly does nothing is
       the kind that teaches people the button is broken, so it goes. */
    undoStack.pop();
    typing = null;
    undoNow = now;
    updateUndoButtons();
    return;
  }
  redoStack.length = 0;
  typing = typed ? el.id : null;
  undoNow = now;
  updateUndoButtons();
}

/* Through loadFromHash, the same road a link or a reload takes, so a step cannot come
   back differently from the way a shared link of it would. The cuts are cleared first
   because loadFromHash only writes them for a manual split, and a step back from Manual
   to Balanced would otherwise keep serialising cuts the layout is no longer using. */
function applyDesign(h) {
  undoApplying = true;
  try {
    state.rowCuts = null; state.colCuts = null;
    loadFromHash(h);
    recomputeLayout();
  } finally {
    undoApplying = false;
    typing = null;
  }
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(designNow());
  applyDesign(undoStack.pop());
  updateUndoButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(designNow());
  applyDesign(redoStack.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
/* The same keys as bins, and the same rule about where they apply: not while focus is in
   a field you type in. There Ctrl+Z belongs to the field — it takes back the last few
   characters you typed, which is what anyone pressing it mid-number means — and the
   run-of-typing logic above tidies up after it. Everywhere else, including a button you
   just clicked, it is the design's.
   A field you type in, not every form control. The rule used to be every <input> and
   <select>, and focus stays on a list after you pick from it and on a box after you tick
   it, so Ctrl+Z straight after choosing a joint or ticking Magnets did nothing at all —
   neither has an undo of its own for the shortcut to be left to. The types below are
   the inputs that take no typing; anything else, including a type a newer browser adds,
   is treated as text, which errs towards leaving the key alone.
   And not while a dialog is open. The design behind it is not what you are working on:
   Ctrl+Z on a button in the Drawers dialog took back a step of the design out of sight,
   and that dialog's Save then stored the design as it was a step before. */
const UNTYPED = new Set(['checkbox', 'radio', 'range', 'color', 'file',
                         'button', 'submit', 'reset', 'image']);
const typesText = (t) => !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' ||
                                 (t.tagName === 'INPUT' && !UNTYPED.has(t.type)));
document.addEventListener('keydown', (e) => {
  if (typesText(e.target) || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

// ---------- wiring ----------
/* The handler is on the <button> inside the header, not on the <h2>.
   A bare heading with a click listener is only a control for a mouse, and because a
   closed panel's body is display:none there was nothing focusable inside it either —
   so panel 06, which loads closed, put the socket profile beyond a keyboard entirely.
   There was no route to it at all, not a slow one.
   aria-expanded is written from the class rather than kept alongside it, so the two
   cannot drift: the class is what actually shows the panel. */
for (const btn of document.querySelectorAll('section.p>h2>button')) {
  const sec = btn.closest('section.p');
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-expanded', String(!sec.classList.toggle('closed')));
  });
}
/* On a phone the rail is not a column beside the map but the top of one long page, and
   with panels 01 to 05 open the cut map started 2.4 screens below the drawer size. So
   there only panel 01, the drawer, opens on arrival; the rest arrive folded, a tap each,
   and the section bar jumps past them. Decided once, as the page opens: a window that
   changes width later keeps its panels as they are.
   The decision is made in the <head>, as html.fold, because by the time this script runs
   the browser has already drawn the rail: done only here, the four panels showed open
   for the first frames and then snapped shut. style.css folds them by look from the first
   frame; this makes it real — the class each panel's button reads, and aria-expanded —
   and then takes the stand-in away. */
if (document.documentElement.classList.contains('fold')) {
  for (const id of ['s-printer', 's-split', 's-conn', 's-mag']) {
    $(id).classList.add('closed');
    $(id).querySelector(':scope>h2>button').setAttribute('aria-expanded', 'false');
  }
  document.documentElement.classList.remove('fold');
}
document.querySelectorAll('#splitSeg button').forEach(b => b.addEventListener('click', () => {
  state.splitMode = b.dataset.v;
  if (b.dataset.v !== 'manual') { state.rowCuts = null; state.colCuts = null; }
  setSplitSeg(b.dataset.v);
  recomputeLayout();
}));
$('bedPreset').addEventListener('change', () => {
  const bed = FIELDS.bedOf($('bedPreset').selectedOptions[0]);   // null for Custom
  if (bed) [$('bedW').value, $('bedD').value, $('bedH').value] = bed;
  recomputeLayout();
});
for (const id of ['bedW', 'bedD', 'bedH'])
  $(id).addEventListener('input', () => FIELDS.followBed($('bedPreset'), bedNow()));

/* ---------- the drawer's unit ----------
   Converts what the length fields show and nothing else. A unit switch changes no
   measurement, so it does not rebuild: the pieces are seconds of CSG, and redoing them
   to arrive at the same plate would read as the switch having changed something. The
   comparison is a guard, not an expected path: FIELDS keeps the exact millimetres behind
   each field, so nothing should move — but if a conversion ever did move a value, the
   page has to recompute as for any edit rather than go on showing a plate built from
   the old number. */
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
  if (LENGTH_IDS.some((id, i) => state[id] !== before[i])) recomputeLayout();
  else { drawMap(); drawWarnings(); }
}
$('unitMm').addEventListener('click', () => chooseUnit('mm'));
$('unitIn').addEventListener('click', () => chooseUnit('in'));
for (const id of [...numIds, 'alignX', 'alignY', 'marginMode', 'connector', 'connClr',
  'tolerance', 'magnetSide', 'magnets', 'screws', 'baseMode', 'perCorner', 'rFL', 'rFR', 'rBL', 'rBR', 'keyMount', 'keyInsert', 'plateStyle']) {
  $(id).addEventListener('input', recomputeLayout);
  $(id).addEventListener('change', recomputeLayout);
}
window.addEventListener('resize', () => { if (layout) drawMap(); });

initThree();
/* The remembered unit goes on before anything is loaded, so a drawer from a link or a
   save lands in the unit the fields show. It converts the markup's own millimetres, not
   whatever is in the fields: a browser that refills a form on reload refills it in the
   unit it was showing, and converting those figures as millimetres would turn a 12 in
   drawer into 0.47 in. The link or the save then writes the real values. */
if (FIELDS.savedUnit() !== unit) {
  for (const id of LENGTH_IDS) $(id).value = $(id).defaultValue;
  applyUnit(FIELDS.savedUnit());
}
/* Whether two saves hold the same plates, compared setting by setting on what this page
   owns. Compared as strings, the bins page handing the drawer back — its keys in its own
   order, with its own extras — was a link that had replaced your layout, on every trip
   there and back. A hand-over also leaves out the drawer and the bed, the settings the
   two pages share: changing them on the other page is not a different layout, unless
   the other page still had them from someone's link. A link from someone keeps them,
   since a drawer of another size is exactly what one brings. */
// the drawer, the bed and its printer, and the infill: drawers.js keeps the same list
const SHARED_KEYS = new Set([...DRAWERS.SHARED].filter((k) => k !== 'v'));
function sameDesign(a, b, skip = []) {
  const p = parseHash(a), q = parseHash(b);
  return [...OWNED].every((k) => k === 'v' || k === 'ph' || skip.includes(k) || p[k] === q[k]);
}
/* A link beats a saved layout, always. Reading the hash first and only falling back
   means a shared drawer is never quietly replaced by the recipient's own. */
const incomingHash = (location.hash || '').replace(/^#/, '');
let linkedNow = false;   // this page holds a link's layout, not yet changed by anyone
let linkNew = false;     // ...one that arrived on this visit, so is recorded afresh
let linkKept = '';       // the link this page last opened, unless a hand-over came since
let notLinked = [];      // settings a link arrived with that were yours on the other page
let arrivedWith = '';    // the design string this page was opened with, if it shows it
{
  const fromLink = isLayoutHash(incomingHash);
  const saved = readLocal();
  const src = fromLink ? incomingHash : saved.length > 2 ? saved : '';
  /* What this page saves when nobody has touched it. A save that is only that is no
     one's work, so replacing it sets nothing aside — or every link would offer the
     defaults back. */
  readControls();
  pristine = encodeDesc(descriptor());
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
    writeKey(PREV_KEY, saved);
    keptAside = readKey(PREV_KEY) === saved;
    if (keptAside) writeKey(PREV_LINKED_KEY, linkKeys(saved, linked).length ? linked : '');
    /* Not kept, it is not written over either (unkept), unless a hand-over of your own
       brings on anything the other page sets: then the save holds the drawer, bed or the
       other page's settings from before, and a bare visit took those back to the other
       page. One still carrying someone's link is that link, and your layout is kept. */
    else unkept = !handOver || handOver.link.length > 0 || drawers.onlyMine(saved, src);
  }
  const canPutBack = (replaces && !kept && (keptAside || (savedLinked && !!readKey(PREV_KEY)))) ||
    (back && keptAside);
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
hashReady = true;                         // loadFromHash has had its say; ours may start
recomputeLayout();
autoFrame();
bootDesc = encodeDesc(descriptor());
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
drawers.attach(arrivedWith);              // is that a saved drawer this browser wrote?

