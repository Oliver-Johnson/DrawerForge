
/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
'use strict';
/* Drawerforge UI. Core geometry functions are in scope from the previous script tag. */
const $ = (id) => document.getElementById(id);

// ---------- state ----------
const state = Object.assign({}, DEFAULTS, {
  marginMode: 'auto', splitMode: 'balanced', rowCuts: null, colCuts: null,
});
let layout = null;
let builds = {};            // pieceId -> {polys, meta}
let buildToken = 0;
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
 * in millimetres" would be the wrong advice. */
const RANGES = PLATE_RANGES;
const customMargins = () => state.marginMode === 'custom' && !state.noMargin;
const mount = () => mountLimits(state);
const mountWhy = (opens) => `at a ${state.pitch} mm pitch — mounting holes sit ` +
  `${state.holeOffset} mm from each cell centre, where the Gridfinity spec puts them, and ` +
  (state.baseMode === 'bosses' ? 'a pocket has to stay inside its corner boss'
    : opens ? 'a cut open to the socket has to stay on the socket floor'
    : 'a pocket under the floor has to stay inside its cell');
const bossDepth = () => state.baseMode === 'bosses'
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
    why: () => mountWhy(state.magnetSide === 'top') },
  magnetH: { ...RANGES.magnetH, max: () => Math.min(RANGES.magnetH.max, mount().depth), label: 'Magnet depth',
    when: () => state.magnets, why: bossDepth },
  screwHoleD: { ...RANGES.screwHoleD, max: () => mount().screwHoleD, label: 'Screw hole Ø',
    when: () => state.screws, why: () => mountWhy(true) },
  screwHeadD: { ...RANGES.screwHeadD, max: () => mount().screwHeadD, label: 'Screw head Ø',
    when: () => state.screws, why: () => mountWhy(false) },
  screwHeadDepth: { ...RANGES.screwHeadDepth, max: () => Math.min(RANGES.screwHeadDepth.max, mount().depth),
    label: 'Screw head depth', when: () => state.screws, why: bossDepth },
  connClr: { ...RANGES.connClr, label: 'Fit clearance', when: () => state.connector !== 'none',
    why: () => '— any looser and a dovetail pocket breaks through into the socket beside it' },
};
/* id -> the message that goes under it. Rebuilt from scratch on every read, so a field
   that has come good stops complaining without anything having to remember it once did. */
const fieldErrors = new Map();
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
function readNumber(id) {
  const lim = LIMITS[id];
  const raw = $(id).value.trim();
  const v = parseFloat(raw);
  if (!lim) return isFinite(v) ? v : 0;
  /* Out of play, a field keeps its fixed range but not the one the rest of the design
     sets, and does not complain: magnets off at a 30 mm pitch should not quietly shrink
     the magnet size the link carries, to be found smaller when they go back on. */
  const inPlay = !lim.when || lim.when();
  const lo = lim.min;
  const hi = typeof lim.max !== 'function' ? (lim.max ?? Infinity) : inPlay ? lim.max() : Infinity;
  $(id).min = lo;
  if (isFinite(hi)) $(id).max = Math.max(lo, hi); else $(id).removeAttribute('max');
  const say = (msg) => { if (inPlay) fieldErrors.set(id, msg); };
  if (!isFinite(v)) {
    say(`${lim.label} is blank — enter a measurement in millimetres.`);
    return lo;
  }
  /* A range with nothing in it: the pitch leaves no room for a pocket of any size. */
  if (hi < lo) {
    say(`${lim.label}: there is no room for one ${lim.why()}. Use a larger pitch, ` +
        'or turn this off.');
    return lo;
  }
  if (v < lo) {
    say(`${lim.label} must be at least ${lo} mm` + (lim.tooSmall ? ` — ${lim.tooSmall}.` : '.'));
    return lo;
  }
  if (v > hi) {
    const why = lim.why && lim.why();
    say(`${lim.label} must be ${roundMm(hi)} mm or less ` +
        (why ? `${why}.` : '— check the figure is in millimetres.'));
    return hi;
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
  fieldErrors.clear();
  /* The switches before the numbers: which ranges apply, and how wide they are, depend
     on them — see LIMITS. */
  state.alignX = $('alignX').value; state.alignY = $('alignY').value;
  const mm = $('marginMode').value;
  state.marginMode = mm === 'custom' ? 'custom' : 'auto';
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
  for (const id of numIds) state[id] = readNumber(id);
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
  const clr = readNumber('connClr');
  state.tab = Object.assign({}, DEFAULTS.tab, { clr });
  /* No state.bowtie: a bowtie is built from state.key like the other two keyed joints,
     and DEFAULTS.bowtie is gone. This line survived it by being harmless —
     Object.assign over undefined yields {} — which is exactly how a parameter block
     that configures nothing goes on looking like it configures something. */
  state.key = Object.assign({}, DEFAULTS.key, { clr: Math.max(0.1, clr - 0.05) });
  state.hclip = Object.assign({}, DEFAULTS.hclip, { clr: Math.max(0.08, clr - 0.05) });
  state.puzzle = Object.assign({}, DEFAULTS.puzzle, { clr });
  $('alignRow').style.display = mm === 'auto' ? '' : 'none';
  $('customMargins').style.display = mm === 'custom' ? '' : 'none';
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
  $('plateStyleHint').textContent = plateStyleHint();
  showFieldErrors();
}

/* The hint under Plate style was static, so with "Solid" selected the first word
   underneath it was "Skeleton" — it described the option you had not picked. It also
   sits on the first screen and is the first use of four terms nothing has defined:
   skeleton, socket, rim, wall band. The socket is the one you cannot guess from the
   word, so it is glossed here, once, in whichever hint is showing. The pitch is read
   from the state rather than written as 42, because panel 06 can move it. */
function plateStyleHint() {
  const socket = `the socket, the ${state.pitch} mm recess a bin's foot drops into`;
  return state.plateStyle === 'skeleton'
    ? `Skeleton keeps ${socket}, along with the rim round the outside of the plate and ` +
      'the band of wall between neighbouring cells, and leaves out the bulk underneath — ' +
      'lighter, and quicker to print. Cells carrying a joint stay solid, ' +
      'and it turns off entirely with magnets or screws, which need that material.'
    : `Solid backs ${socket} with material all the way down to the drawer floor. ` +
      'The sturdy default: the heaviest and slowest to print, and the only style that ' +
      'works with magnets, screws, or a joint that needs a floor to house its keys.';
}

// ---------- layout & validation ----------
function recomputeLayout() {
  readControls();
  layout = computeLayout(state);
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
}

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
  if (layout.pieces.some(pc => pc.nx*pc.ny === 1))
    out.push({ t: 'A piece is a single cell — printable, but consider moving a cut for a sturdier layout.' });
  /* One axis at a time. It fired on either and then printed both, so a drawer narrower
     than a single cell reported "Leftover space is large (-92 × 40 mm)" — the -92 being
     width the drawer does not have. And it stopped a step short of the advice: the
     guide has a section on exactly this, so the warning links to it rather than leaving
     "double-check the measurement" as the whole of what the tool knows. */
  const remX = state.drawerW - layout.nx*state.pitch, remY = state.drawerD - layout.ny*state.pitch;
  const spare = [];
  if (remX > state.pitch * 0.75) spare.push(`${remX.toFixed(0)} mm across the width`);
  if (remY > state.pitch * 0.75) spare.push(`${remY.toFixed(0)} mm across the depth`);
  if (spare.length)
    out.push({ t: `Leftover space is large — ${spare.join(' and ')}, nearly another whole cell. ` +
      'Re-measure before you print; if the drawer really is that size, ' +
      '<a href="guide/drawer-sizes/#leftover">the guide covers what to do with the remainder</a>.' });
  const keyedC = KEY_CONN.includes(state.connector);
  if ((keyedC && state.keyMount === 'floor' || state.connector === 'puzzle') && layout.pieces.length > 1) {
    const padV = state.connector === 'puzzle' ? 2.6 : state.key.depth + 0.8;
    const what = state.connector === 'puzzle' ? 'the jigsaw lobes' :
      state.connector === 'snap' ? 'the snap clips' : 'the keys';
    out.push({ t: `This joint adds a ${Math.max(state.bottomPad, padV).toFixed(1)} mm solid floor to house ${what}. Prefer no floor? Pick a keyed joint and set Key housing to "Inside the walls".` });
  }
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
  $('warnings').innerHTML = ws.map(w => `<div class="w${w.err ? ' err' : ''}">${w.t}</div>`).join('');
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
  const availW = Math.min(680, ($('mapwrap').clientWidth || 680) - 10);
  const sc = Math.min(availW / (Wmm + 90), 460 / (Dmm + 90));
  const ox = 58, oy = 26;
  const X = (mm) => ox + mm * sc;
  const Y = (mm) => oy + (Dmm - mm) * sc;     // front of drawer at the bottom
  const w = ox + Wmm * sc + 34, h = oy + Dmm * sc + 56;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
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
      s += `<text class="psub" x="${X((x0+x1)/2)}" y="${Y((y0+y1)/2)+11}" text-anchor="middle">${pc.nx}×${pc.ny}</text>`;
    });

    // grid lines + hit targets
    for (let i = 1; i < layout.nx; i++) {
      const xm = gx0 + i * pitch;
      s += `<line class="gridline" x1="${X(xm)}" y1="${Y(gy0)}" x2="${X(xm)}" y2="${Y(gy0 + layout.ny*pitch)}"/>`;
    }
    for (let j = 1; j < layout.ny; j++) {
      const ym = gy0 + j * pitch;
      s += `<line class="gridline" x1="${X(gx0)}" y1="${Y(ym)}" x2="${X(gx0 + layout.nx*pitch)}" y2="${Y(ym)}"/>`;
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
  $('mapTail').textContent = `${layout.nx} × ${layout.ny} cells · ${layout.pieces.length} piece${layout.pieces.length>1?'s':''}`;
  $('gridSummary').innerHTML = `Grid: <span class="klabel">${layout.nx} × ${layout.ny}</span> cells (${(layout.nx*state.pitch).toFixed(0)} × ${(layout.ny*state.pitch).toFixed(0)} mm) · margins L ${layout.mL.toFixed(1)} / R ${layout.mR.toFixed(1)} / F ${layout.mF.toFixed(1)} / B ${layout.mB.toFixed(1)} mm`;

  /* To anything that cannot see it the cut map is one image with no alt text — and it
     is the whole answer to "what did that setting just do". The label is rebuilt here
     on every draw rather than written once into the markup: a fixed string would
     describe the starting drawer forever, which is worse than silence because it is
     confidently wrong. The pieces are not enumerated; the piece table below already
     lists every one of them as text a screen reader can navigate. */
  svg.setAttribute('aria-label', capped
    ? 'Cut map: not drawn — the grid is larger than this tool will build. See the checks below.'
    : `Cut map: a ${layout.nx} by ${layout.ny} cell grid in a ${Wmm} by ${Dmm} millimetre ` +
      `drawer, ${splitName()} split into ` +
      `${layout.pieces.length} piece${layout.pieces.length === 1 ? '' : 's'}. ` +
      'Front of the drawer is at the bottom.');

  svg.querySelectorAll('.hitline').forEach(el => el.addEventListener('click', onMapClick));
}

function onMapClick(ev) {
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
    tb.innerHTML = '<tr><td colspan="6">Nothing to list until the checks above are clear.</td></tr>';
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
      if (m.tabs) parts.push(`${m.tabs} tab`);
      if (m.notches) parts.push(`${m.notches} pocket`);
      if (m.puzzles) parts.push(`${m.puzzles} puzzle`);
      if (m.bowties) parts.push(`${m.bowties} key`);
      joints = parts.join(' + ') || '—';
    }
    return `<tr>
      <td><span class="sw" style="background:${PIECE_COLORS[i%PIECE_COLORS.length]}"></span><b>${pc.id}</b></td>
      <td class="mono">${pc.nx} × ${pc.ny}</td>
      <td class="mono">${w.toFixed(1)} × ${d.toFixed(1)}</td>
      <td class="mono">${joints || '—'}</td>
      <td class="${fit?'':'bad'}">${fit ? 'fits' : footprintFits(pc) ? 'TOO TALL' : 'TOO BIG'}</td>
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
      ? `3D preview: building, ${built} of ${n} piece${n === 1 ? '' : 's'} so far.`
      : `3D preview: a ${layout.nx} by ${layout.ny} cell baseplate, ` +
        `${(layout.nx * state.pitch).toFixed(0)} by ` +
        `${(layout.ny * state.pitch).toFixed(0)} millimetres, split into ` +
        `${n} piece${n === 1 ? '' : 's'} and joined with ` +
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
      return;
    }
    drawPieceTable();
  }
  $('status').textContent = '';
  computePrintPlan();
  fitThree();
}

// ---------- three.js ----------
let scene, camera, renderer, root, sph = { theta: -0.7, phi: 1.05, r: 420, cx: 0, cy: 0 };
/* The preview is the one part of the page that needs WebGL, and it was set up first, so
   a browser without it — GPU blocklisted, hardware acceleration off, three.js not
   loaded — threw on the renderer and took the rest of the boot with it: no layout, no
   build, no downloads, for a tool whose files never touch the GPU. So a failed setup
   says so in the preview box and leaves `threeOk` false, and every preview function
   below checks it and does nothing. */
let threeOk = false;
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
  const zoom = (f) => { sph.r = Math.max(60, Math.min(2200, sph.r * f)); };

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
      if (pmid) { sph.cx -= (m[0] - pmid[0]) * sph.r * 0.0011; sph.cy += (m[1] - pmid[1]) * sph.r * 0.0011; }
      pinch = g; pmid = m;
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.pan) { sph.cx -= dx * sph.r * 0.0011; sph.cy += dy * sph.r * 0.0011; }
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
  canvas.addEventListener('wheel', e => { e.preventDefault(); sph.r = Math.max(60, Math.min(2200, sph.r * (1 + e.deltaY * 0.0011))); }, { passive: false });
  (function loop() {
    requestAnimationFrame(loop);
    camera.position.set(
      sph.cx + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
      sph.cy - sph.r * Math.sin(sph.phi) * Math.cos(sph.theta),
      sph.r * Math.cos(sph.phi));
    camera.up.set(0, 0, 1);
    camera.lookAt(sph.cx, sph.cy, 0);
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
function fitThree() {
  sph.cx = state.drawerW / 2; sph.cy = state.drawerD / 2;
  sph.r = Math.max(state.drawerW, state.drawerD) * 1.5;
}
$('explode').addEventListener('change', () => {
  if (!threeOk) return;
  for (const mesh of root.children) {
    const pc = layout.pieces.find(p => p.id === mesh.userData.pieceId);
    if (pc) { const [px, py] = piecePlacement(pc); mesh.position.set(px, py, 0); }
  }
});


// ---------- print plan ----------
let printPlan = null;
function computePrintPlan() {
  if (!layout || Object.keys(builds).length < layout.pieces.length) { printPlan = null; renderPrintPlan(); return; }
  /* Never below zero. A negative spacing packed parts into each other, and a negative
     stack gap sank the upper piece into the one under it, so the 3MF printed them as
     one fused lump. A blank field means the default; 0 is an answer and stays 0 — the
     old `|| 4` turned it into 4. */
  const gapOf = (id, dflt) => {
    const v = parseFloat($(id).value);
    return isFinite(v) ? Math.max(0, v) : dflt;
  };
  const gap = gapOf('plateGap', 4);
  const stack = $('stackToggle').checked;
  const zGap = gapOf('stackGap', 0.24);
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
  if (shipsKeys()) {
    const ext = partExtent(connectorPart().polys);
    items.push({ id: 'key', w: ext.w, d: ext.d, h: ext.h,
                 qty: keysNeeded(), stackable: false });
  }
  printPlan = { plates: packPlates(items, state.bedW, state.bedD, gap,
    { stack, zGap, bedH: state.bedH || 1e9 }), merged: items, zGap };
  renderPrintPlan();
}
function renderPrintPlan() {
  const row = $('platesRow');
  updateExportTail();
  if (!printPlan) { row.innerHTML = '<div class="hint">Print plan appears when all pieces are built.</div>'; $('planTail').textContent = ''; return; }
  const plates = printPlan.plates;
  const stacked = plates.some(pl => pl.placed.some(p => p.z > 0.01));
  $('planTail').textContent = `${plates.length} print plate${plates.length > 1 ? 's' : ''}` + (stacked ? ' · stacked' : '');
  const sc = 116 / Math.max(state.bedW, state.bedD);
  row.innerHTML = plates.map((pl, i) => {
    let svg = `<svg width="${state.bedW*sc+2}" height="${state.bedD*sc+2}" style="background:var(--panel2);border:1px solid var(--line);border-radius:5px">`;
    for (const p of pl.placed) {
      const ci = p.id === 'key' ? 7 : layout.pieces.findIndex(pc => pc.id === p.id);
      const lvl = Math.round(p.z / (4.5 + printPlan.zGap));
      svg += `<rect x="${p.x*sc+1}" y="${(state.bedD-p.y-p.d)*sc+1}" width="${p.w*sc}" height="${p.d*sc}" fill="${PIECE_COLORS[(ci<0?0:ci)%PIECE_COLORS.length]}" opacity="${p.z>0.01?0.35:0.55}" stroke="var(--line)"/>`;
      if (p.id !== 'key')
        svg += `<text x="${(p.x+p.w/2)*sc+1}" y="${(state.bedD-p.y-p.d/2)*sc+4+(lvl*10)}" text-anchor="middle" font-size="10" fill="var(--ink)">${p.id}${p.z>0.01?' ↥':''}</text>`;
    }
    svg += '</svg>';
    return `<div style="display:grid;gap:4px;justify-items:center">${svg}<div class="hint">plate ${i+1}</div></div>`;
  }).join('');
}
function platePolysAndItems(idx) {
  const pl = printPlan.plates[idx];
  const objs = [];
  // built once: every key unit on the plate is the same part, and buildKey runs CSG
  let part = null;
  for (const p of pl.placed) {
    let polys;
    if (p.id === 'key') { part = part || connectorPart(); polys = part.polys; }
    else {
      const b = builds[p.id];
      if (!b) continue;
      polys = transformPolys(b.polys, b.meta.protrusion.l, b.meta.protrusion.f, 0, 0);
    }
    objs.push({ name: p.id + (p.z > 0.01 ? `@${p.z.toFixed(2)}` : ''), polys, tx: p.x, ty: p.y, tz: p.z, rot: p.rot });
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
  if (!printPlan) return;
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
// the plate height the first built piece came out at — the top clip is sized to it
function builtH() {
  return layout && builds[layout.pieces[0].id] ? builds[layout.pieces[0].id].meta.H : 4.25;
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
 * `pad` is read back off the height the build actually came out at rather than worked
 * out again from bottomPad and the joint's own minimum — the puzzle cavity is cut
 * relative to it, and the coupon has no other way to know. */
function activeJoint() {
  const pad = builtH() - state.plateHeight;
  if (!KEYED.includes(state.connector))
    return { kind: state.connector === 'none' ? 'none' : state.connector, pad,
             clr: state.connector === 'puzzle' ? state.puzzle.clr : state.tab.clr };
  const prm = activeKeyDims();
  // core.js owns this, so the coupon, the plate and the audit cannot disagree
  const kind = jointKind(state.connector, state.keyMount, state.keyInsert);
  return { kind, shape: activeKeyShape(), prm, pad,
           // the clip is one part at one size in either housing, so it is fitted to the
           // full key's clearance — buildPiece says the same
           clr: kind === 'snaptop' ? state.key.clr : prm.clr,
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
  lines.push(`Margins: L ${layout.mL.toFixed(1)} R ${layout.mR.toFixed(1)} F ${layout.mF.toFixed(1)} B ${layout.mB.toFixed(1)} mm`);
  lines.push(`Split: ${splitName()} | Pieces: ${layout.pieces.length} in ${rows} row band(s)`);
  lines.push(`Connectors: ${state.connector}` + (state.connector === 'dovetail' ? ` (clearance ${state.tab.clr} mm/side)` : ''));
  if (state.magnets) lines.push(`Magnets: ${state.magnetD} x ${state.magnetH} mm, from ${state.magnetSide}`);
  if (state.screws) lines.push(`Screws: ${state.screwHoleD} mm holes, ${state.screwHeadD} mm counterbore`);
  lines.push('');
  lines.push('LAYOUT (front of drawer at the bottom):');
  const bandIds = {};
  for (const pc of layout.pieces) (bandIds[pc.band] = bandIds[pc.band] || []).push(pc.id);
  Object.keys(bandIds).sort((a, b) => b - a).forEach(b => lines.push('  ' + bandIds[b].join(' | ')));
  lines.push('');
  lines.push('PRINTING: flat as oriented, no supports needed. Print the test tile first');
  lines.push('and check a bin fits before committing to the full plates.');
  lines.push('');
  if (printPlan) lines.push(`PRINT PLATES: ${printPlan.plates.length} — pre-arranged 3MF files in print-plates/ open directly in your slicer.`);
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
   link was a "function Object() { [native code] } split" on screen and in the README. */
const splitName = () =>
  (Object.hasOwn(SPLIT_NAMES, state.splitMode) ? SPLIT_NAMES[state.splitMode] : state.splitMode);

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
    return { cls: 'bad', t: `${bad.length} piece(s) — ${bad.map((pc) => pc.id).join(', ')} — ` +
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
    return { cls: 'wait', t: `Still building — ${ready} of ${layout.pieces.length} piece(s) ready. ` +
      'The meshes below appear as they finish.' };
  // quoting pieceExtent, so the number shown is the number the test above used
  const big = layout.pieces.map(pieceExtent).sort((a, b) => b[0] * b[1] - a[0] * a[1])[0];
  return { cls: 'ok', t: `All ${layout.pieces.length} piece(s) fit your ${bed} — the largest ` +
    `needs ${big[0].toFixed(0)} × ${big[1].toFixed(0)} mm.` };
}

function renderExportSummary() {
  const pitch = state.pitch;
  const g = materialGrams();
  $('exDesign').textContent =
    `${layout.nx} × ${layout.ny} cell grid (${(layout.nx * pitch).toFixed(0)} × ${(layout.ny * pitch).toFixed(0)} mm) ` +
    `in a ${state.drawerW} × ${state.drawerD} mm drawer\n` +
    `${layout.pieces.length} piece(s), ${splitName()} split, joined with ${CONNECTOR_NAMES[state.connector] || state.connector}\n` +
    `margins L ${layout.mL.toFixed(1)} / R ${layout.mR.toFixed(1)} / F ${layout.mF.toFixed(1)} / B ${layout.mB.toFixed(1)} mm` +
    (g === null ? '' : `\nabout ${massText(g)} of PLA ${infillNote()}`);
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

  if (printPlan) {
    const n = printPlan.plates.length;
    exGroup('Pre-arranged print plates');
    // named as the recommended path, because it is: every part already placed on a bed,
    // in the order the plan worked out, with nothing left to arrange
    exRow('Every plate — recommended',
          `${n} plate(s) · 3MF` + (n > 1 ? ' in a ZIP' : '') + ' · the whole job, arranged',
          'Download', downloadAllPlates,
          { 'data-ex': 'allplates', 'aria-label': 'Download every print plate (3MF)' });
    /* Per-plate downloads. The combined export already builds each plate on its own
       before zipping them, so one plate at a time is the same call with the zip left
       off — and it is what you want when one print failed, or when tonight's print is
       only this plate. */
    printPlan.plates.forEach((pl, i) => exRow(`Plate ${i + 1}`,
      `${pl.placed.length} part(s) on a ${state.bedW} × ${state.bedD} mm bed · 3MF`, 'Download',
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
          `${pc.nx} × ${pc.ny} cells · ` + (b ? `${DF.bytes(DF.stlBytes(b.polys))} · STL` : 'not built yet'),
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
  $('exportTail').textContent = `${n} piece${n > 1 ? 's' : ''}` +
    (printPlan ? ` · ${printPlan.plates.length} plate${printPlan.plates.length > 1 ? 's' : ''}` : '');
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
const OWNED = new Set(['w','d','mm','ax','ay','ml','mr','mf','mb','bw','bd','bh','sp','km','ki',
  'rc','cc','cn','cl','to','mg','md','mh','ms','sc','sh','sd','se','pi','or','bp','tc','bm','pc',
  'r1','r2','r3','r4','v','ph','ps','if']);

function descriptor() {
  const o = {
    w: state.drawerW, d: state.drawerD, mm: $('marginMode').value,
    ax: state.alignX, ay: state.alignY,
    ml: state.mLeft, mr: state.mRight, mf: state.mFront, mb: state.mBack,
    bw: state.bedW, bd: state.bedD, bh: state.bedH, sp: state.splitMode, km: state.keyMount, ki: state.keyInsert,
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
   an anchor, not a link to a drawer, and reloading for one threw the drawer away. */
addEventListener('hashchange', () => {
  if (isLayoutHash((location.hash || '').replace(/^#/, ''))) location.reload();
});

/* Two more slots beside the save, so a layout is set aside rather than lost.
 *
 * PREV_KEY: following a link overwrote the save within 400 ms with no way back, so
 * whatever is about to replace it — a link, or the defaults standing in for a layout
 * that would not load — copies it here first, and the page offers to put it back.
 *
 * LOADING_KEY: names the layout being loaded, and is cleared once the page has drawn
 * it. Still there at the next visit, for the same layout, means the last attempt hung or
 * crashed the tab; loading it again would only do that again, on every visit. */
const PREV_KEY = SAVE_KEY + ':prev', LOADING_KEY = SAVE_KEY + ':loading';
const readKey = (k) => { try { return localStorage.getItem(k) || ''; } catch (err) { return ''; } };
const writeKey = (k, v) => {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); }
  catch (err) { /* private mode: the guard and the backup go, the page does not */ }
};
let stalled = '';   // the layout the boot declined to load, for "Try it anyway"
function leaveFor(url) {
  hashReady = false; clearTimeout(hashSaveT);   // no save of this page's may land after
  location.href = url;
}
function putBack() {
  const prev = readKey(PREV_KEY);
  if (!prev) return;
  saveLocal(prev);
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
  hashSaveT = setTimeout(() => {
    const h = encodeDesc(descriptor());
    try { history.replaceState(null, '', '#' + h); }
    catch (err) { /* some browsers refuse replaceState on file:// — a lost URL is not
                     worth an exception that stops the rest of the page working */ }
    saveLocal(h);   // outside the try: a refused URL is no reason to lose the save too
  }, 400);
}
function shareLink() {
  return location.origin + location.pathname + '#' + encodeDesc(descriptor());
}
// Hand the drawer across to the bins tool. Only the shared keys travel; the bins
// tool re-emits anything it doesn't recognise, so a round trip is lossless.
function binsHref() {
  const built = layout && layout.pieces.length && builds[layout.pieces[0].id];
  const H = built ? built.meta.H : state.plateHeight;
  // full baseplate state plus the plate height bins needs; extras ride along
  return 'bins/#' + encodeDesc(Object.assign(descriptor(), { ph: (+H).toFixed(2) }));
}
for (const id of ['toBins', 'navBins'])
  $(id).addEventListener('click', (e) => { e.preventDefault(); location.href = binsHref(); });
// the guide holds no state, so hand it ours and it can hand it back
$('navGuide').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = 'guide/#' + encodeDesc(descriptor());
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
     named "-fit-sample-". Anything else keeps the default. */
  const set = (id, v) => {
    const el = $(id);
    if (v === undefined || !el) return;
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === v)) return;
    el.value = v;
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
  if (q.sp && Object.hasOwn(SPLIT_NAMES, q.sp)) {
    state.splitMode = q.sp; setSplitSeg(q.sp);
    if (q.sp === 'manual') {
      state.rowCuts = cutList(q.rc, ',');
      state.colCuts = q.cc ? q.cc.split('_').slice(0, MAX_PIECES).map((s) => cutList(s, '.')) : [];
    }
  }
}
/* Cuts are whole cells, each one once, in order, and no more than the pieces this page
   will build. "rc=2,2,2" built zero-height pieces, "rc=1.5" a fractional one, and 2,500
   copies of one cut took 1.8 GB — and were saved, so every visit after took it again. */
const CUT_TOP = Math.floor(LIMITS.drawerW.max / LIMITS.pitch.min);   // most cells on a side
const cutList = (s, sep) => [...new Set(String(s || '').split(sep).map(Number))]
  .filter((n) => Number.isInteger(n) && n > 0 && n < CUT_TOP)
  .sort((a, b) => a - b).slice(0, MAX_PIECES - 1);

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
document.querySelectorAll('#splitSeg button').forEach(b => b.addEventListener('click', () => {
  state.splitMode = b.dataset.v;
  if (b.dataset.v !== 'manual') { state.rowCuts = null; state.colCuts = null; }
  setSplitSeg(b.dataset.v);
  recomputeLayout();
}));
$('bedPreset').addEventListener('change', () => {
  const v = $('bedPreset').value;
  if (v !== 'custom') { const [w, d, h] = v.split(','); $('bedW').value = w; $('bedD').value = d; $('bedH').value = h; }
  recomputeLayout();
});
for (const id of [...numIds, 'alignX', 'alignY', 'marginMode', 'connector', 'connClr',
  'tolerance', 'magnetSide', 'magnets', 'screws', 'baseMode', 'perCorner', 'rFL', 'rFR', 'rBL', 'rBR', 'keyMount', 'keyInsert', 'plateStyle']) {
  $(id).addEventListener('input', recomputeLayout);
  $(id).addEventListener('change', recomputeLayout);
}
window.addEventListener('resize', () => { if (layout) drawMap(); });

initThree();
/* A link beats a saved layout, always. Reading the hash first and only falling back
   means a shared drawer is never quietly replaced by the recipient's own. */
const incomingHash = (location.hash || '').replace(/^#/, '');
{
  const fromLink = isLayoutHash(incomingHash);
  const saved = readLocal();
  const src = fromLink ? incomingHash : saved.length > 2 ? saved : '';
  /* What this page saves when nobody has touched it. A save that is only that is no
     one's work, so replacing it sets nothing aside — or every link would offer the
     defaults back. */
  readControls();
  const pristine = encodeDesc(descriptor());
  stalled = src && readKey(LOADING_KEY) === src ? src : '';
  // set aside whatever is about to replace the save: a different link, or the defaults
  const aside = saved.length > 2 && saved !== pristine &&
    (saved !== src || (!!stalled && !fromLink));
  if (aside) writeKey(PREV_KEY, saved);
  if (stalled) {
    showSetAside('This layout did not finish loading last time, so the page has started ' +
      'from its defaults rather than try it again.', aside && saved !== src, true);
  } else if (src) {
    writeKey(LOADING_KEY, src);
    loadFromHash(src);
    if (!fromLink) $('restored').style.display = '';
    else if (aside) showSetAside('This link replaced the layout you had here.', true, false);
  }
}
hashReady = true;                         // loadFromHash has had its say; ours may start
recomputeLayout();
/* Laid out and drawn, so the marker has done its job. A stalled layout keeps its marker:
   reloading the same link must be declined again, not tried again. */
if (!stalled) writeKey(LOADING_KEY, '');
fitThree();

