
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
const LIMITS = {
  drawerW: { min: 1, max: 2000, label: 'Drawer width' },
  drawerD: { min: 1, max: 2000, label: 'Drawer depth' },
  bedW: { min: 20, max: 2000, label: 'Bed width' },
  bedD: { min: 20, max: 2000, label: 'Bed depth' },
  bedH: { min: 20, max: 2000, label: 'Bed height' },
  // pitch divides into the drawer to get the cell count, so a zero here is not a bad
  // plate, it is an infinite one — Math.floor(x / 0) is Infinity and the grid loops
  // never come back
  pitch: { min: 5, max: 200, label: 'Grid pitch' },
};
/* id -> the message that goes under it. Rebuilt from scratch on every read, so a field
   that has come good stops complaining without anything having to remember it once did. */
const fieldErrors = new Map();
/* Named one field at a time rather than derived from the id: the build audits the
   template by literal, and $('errDrawerW') is what it looks for. */
const ERR_FIELDS = [
  ['drawerW', 'errDrawerW'], ['drawerD', 'errDrawerD'],
  ['bedW', 'errBedW'], ['bedD', 'errBedD'], ['bedH', 'errBedH'], ['pitch', 'errPitch'],
];
const ERR_EL = { errDrawerW: () => $('errDrawerW'), errDrawerD: () => $('errDrawerD'),
  errBedW: () => $('errBedW'), errBedD: () => $('errBedD'), errBedH: () => $('errBedH'),
  errPitch: () => $('errPitch') };

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
  /* The range is millimetres because the model is; in inches it is quoted in both, since
     "at least 1 mm" means nothing to the field you are typing inches into, and the
     millimetre figure is the one the tool actually holds you to. The advice for a huge
     number follows the unit too: typing millimetres into an inch field is the likeliest
     way to get one. */
  const inch = len && unit === 'in';
  const both = (mm) => inch ? `${mm} mm (${FIELDS.inchText(mm)} in)` : `${mm} mm`;
  const unitName = inch ? 'inches' : 'millimetres';
  if (!isFinite(v)) {
    fieldErrors.set(id, `${lim.label} is blank — enter a measurement in ${unitName}.`);
    return lim.min;
  }
  if (v < lim.min) {
    fieldErrors.set(id, `${lim.label} must be at least ${both(lim.min)}.`);
    return lim.min;
  }
  if (v > lim.max) {
    fieldErrors.set(id, `${lim.label} must be ${both(lim.max)} or less — check the figure is in ${unitName}.`);
    return lim.max;
  }
  return v;
}
/* The invalid state is set on the element rather than through a class, because the
   stylesheet is shared with the bins tool and is not this change's to edit. Colour is
   not carrying it on its own: aria-invalid says it to a screen reader and the message
   below the field says it in words. */
function showFieldErrors() {
  for (const [id, errId] of ERR_FIELDS) {
    const msg = fieldErrors.get(id) || '';
    const out = ERR_EL[errId]();
    $(id).setAttribute('aria-invalid', msg ? 'true' : 'false');
    $(id).style.borderColor = msg ? 'var(--red)' : '';
    out.textContent = msg;
    out.hidden = !msg;
  }
}

function readControls() {
  fieldErrors.clear();
  for (const id of numIds) state[id] = readNumber(id);
  state.alignX = $('alignX').value; state.alignY = $('alignY').value;
  const mm = $('marginMode').value;
  state.marginMode = mm === 'custom' ? 'custom' : 'auto';
  state.noMargin = mm === 'none';
  if (state.noMargin) { state.marginMode = 'custom'; state.mLeft = state.mRight = state.mFront = state.mBack = 0; }
  state.connector = $('connector').value;
  state.keyType = KEY_CONN.includes(state.connector) ? state.connector : 'bowtie';
  state.keyMount = $('keyMount').value;
  state.keyInsert = $('keyInsert').value;
  state.baseMode = $('baseMode').value;
  state.plateStyle = $('plateStyle').value;
  if ($('perCorner').checked) {
    state.cornerRadii = { ll: parseFloat($('rFL').value)||0, lr: parseFloat($('rFR').value)||0,
                          ul: parseFloat($('rBL').value)||0, ur: parseFloat($('rBR').value)||0 };
  } else state.cornerRadii = null;
  state.tolerance = $('tolerance').value;
  /* Read with the other numbers above; clamped here because it is a percentage and
     the estimate divides by 100, so a stray 900 would quote a mass nothing can print. */
  state.infill = Math.max(0, Math.min(100, state.infill));
  state.magnets = $('magnets').checked;
  state.screws = $('screws').checked;
  state.magnetSide = $('magnetSide').value;
  const clr = parseFloat($('connClr').value) || 0.2;
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
/* `ev` is the input or change event when a field called this directly — the undo
   history uses it to tell typing apart from a discrete edit. Every other caller passes
   nothing, and each of those is a discrete edit. */
function recomputeLayout(ev) {
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
  noteDesignChange(ev);
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
function pieceFits(pc) {
  const [w, d] = pieceExtent(pc);
  return w <= state.bedW + 1e-6 && d <= state.bedD + 1e-6;
}

/* How big a job this tool will take on in one go.
   There was no ceiling at all. A drawer of 9999 × 9999 mm — one stray keystroke away
   from 999 — gave a 238 × 238 grid, 1600 pieces, and a build that started working
   through them one real CSG at a time with nothing on the page to say it would not
   finish. Both numbers are well past any drawer: MAX_CELLS is a 1.26 m square of grid
   at the spec pitch, MAX_PIECES more separate prints than anyone is going to run. */
const MAX_CELLS = 900, MAX_PIECES = 60;
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
  // suppressed when the drawer fields are already complaining: "smaller than one cell"
  // is true of the clamped value and useless as a diagnosis of a blank or negative one
  if (!fieldErrors.has('drawerW') && !fieldErrors.has('drawerD') &&
      (layout.nx < 1 || layout.ny < 1 || state.drawerW < state.pitch || state.drawerD < state.pitch))
    out.push({ err: true, stop: true, t: `Drawer smaller than one ${state.pitch} mm cell — nothing to generate.` });
  for (const pc of layout.pieces) if (!pieceFits(pc))
    out.push({ err: true, t: `Piece ${pc.id} (${(pc.mL+pc.nx*state.pitch+pc.mR).toFixed(0)} × ${(pc.mF+pc.ny*state.pitch+pc.mB).toFixed(0)} mm) exceeds the ${state.bedW} × ${state.bedD} bed — add a cut through it.` });
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
  $('openExport').disabled = stop;
  $('openExport').title = stop ? 'Fix the errors under the cut map first' : '';
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
  $('mapTail').textContent = `${layout.nx} × ${layout.ny} cells · ${plural(layout.pieces.length, 'piece')}`;
  /* Both units with inches on, millimetres first. The grid is millimetres by nature —
     42 mm cells — and that is the number the rest of the page and every download quote,
     so it stays; the inches are there to hold against the tape measure the drawer was
     measured with. */
  const gw = layout.nx * state.pitch, gd = layout.ny * state.pitch;
  const inch = unit === 'in';
  $('gridSummary').innerHTML = `Grid: <span class="klabel">${layout.nx} × ${layout.ny}</span> cells (${gw.toFixed(0)} × ${gd.toFixed(0)} mm` +
    (inch ? `, ${FIELDS.inchText(gw)} × ${FIELDS.inchText(gd)} in` : '') +
    `) · margins L ${layout.mL.toFixed(1)} / R ${layout.mR.toFixed(1)} / F ${layout.mF.toFixed(1)} / B ${layout.mB.toFixed(1)} mm` +
    (inch ? ` (${[layout.mL, layout.mR, layout.mF, layout.mB].map(FIELDS.inchText).join(' / ')} in)` : '');

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
      `${plural(layout.pieces.length, 'piece')}. ` +
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
    let joints = '…';
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
      <td class="mono">${pc.nx} × ${pc.ny}</td>
      <td class="mono">${w.toFixed(1)} × ${d.toFixed(1)}</td>
      <td class="mono">${joints || '—'}</td>
      <td class="${fit?'':'bad'}">${fit ? 'fits' : 'TOO BIG'}</td>
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
  $('three').setAttribute('aria-label', blocked
    ? '3D preview: nothing to show — see the checks under the cut map.'
    : built < n
      ? `3D preview: building, ${built} of ${plural(n, 'piece')} so far.`
      : `3D preview: a ${layout.nx} by ${layout.ny} cell baseplate, ` +
        `${(layout.nx * state.pitch).toFixed(0)} by ` +
        `${(layout.ny * state.pitch).toFixed(0)} millimetres, split into ` +
        `${plural(n, 'piece')} and joined with ` +
        `${CONNECTOR_NAMES[state.connector] || state.connector}.`);
}

// ---------- async build ----------
let buildTimer = null;
function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(runBuild, 260);
}
async function runBuild() {
  const token = ++buildToken;
  builds = {};
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
/* Who is in charge of the framing, the page or the person looking at it.
 *
 * The preview re-framed itself at the end of every build, and a build follows every
 * change on the page — so zooming in on a joint and then changing the clearance threw
 * the zoom away. It now frames itself only when what it is framing changes: the plate's
 * size, the exploded view, or the canvas's own shape. And not even then once you have
 * zoomed or panned, because those say what you want to look at, and re-framing would
 * overrule it.
 *
 * Rotating does not count. It says which SIDE you want to look from, and a re-frame
 * keeps the angle, so there is nothing to overrule. The Fit button hands control back:
 * it frames now and lets the page frame again from then on. */
let viewOwned = false, framedKey = '', fitR = 0;
function initThree() {
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
  // not builtH(): that reads the first piece, and a layout the checks stopped has none
  const h = (state.plateHeight || 4.25) + (state.bottomPad || 0);
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0),
                             new THREE.Vector3(state.drawerW, state.drawerD, h));
  if (root.children.length) box.union(new THREE.Box3().setFromObject(root));
  return box;
}
const frameKey = () => {
  const cv = $('three');
  return [state.drawerW, state.drawerD, $('explode').checked, cv.clientWidth, cv.clientHeight].join('/');
};
/* Frame the plate from wherever the camera is now looking from. Keeping the angle is
   deliberate, for Fit as much as for the automatic case: the button answers "show me
   all of it", not "start again", and a reload is still there for that. */
function fitThree() {
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
  if (frameKey() === framedKey) return;
  if (viewOwned) framedKey = frameKey();
  else fitThree();
}
/* chrome.js owns the button, because it owns Expand beside it and runs on both tools;
   it says "fit" with an event rather than calling in, so it needs to know nothing of
   how either tool keeps its camera. */
$('threewrap').addEventListener('previewfit', () => { viewOwned = false; fitThree(); });
$('explode').addEventListener('change', () => {
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
  const gap = parseFloat($('plateGap').value) || 4;
  const stack = $('stackToggle').checked;
  const zGap = parseFloat($('stackGap').value) || 0.24;
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
  if (KEYED.includes(state.connector)) {
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
  $('planTail').textContent = plural(plates.length, 'print plate') + (stacked ? ' · stacked' : '');
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
async function plate3mfBytes(idx) {
  const x = build3mfXML(platePolysAndItems(idx));
  const pz = new JSZip();
  pz.file('[Content_Types].xml', x.contentTypes);
  pz.file('_rels/.rels', x.rels);
  pz.file('3D/3dmodel.model', x.model);
  return pz.generateAsync({ type: 'uint8array' });
}
async function downloadAllPlates() {
  if (!printPlan) return;
  const n = printPlan.plates.length;
  if (n === 1) { saveBlob(await plate3mfBytes(0), 'print-plates.3mf'); return; }
  const zip = new JSZip();
  for (let i = 0; i < n; i++) zip.file(`plate-${i+1}.3mf`, await plate3mfBytes(i));
  saveBlobAsync(await zip.generateAsync({ type: 'blob' }), `print-plates-x${n}.zip`);
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
  if (KEYED.includes(state.connector))
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
const keysNeeded = () => keyCount(topClips()) || 1;
async function downloadEverythingZip() {
  if (Object.keys(builds).length < layout.pieces.length) return;
  const zip = new JSZip();
  for (const pc of layout.pieces)
    zip.file(`baseplate-${pc.id}.stl`, stlBinary(builds[pc.id].polys, pc.id));
  if (KEYED.includes(state.connector)) {
    const k = keysStl();
    zip.file(k.name, stlBinary(k.polys, k.mesh));
  }
  if (printPlan) {
    for (let i = 0; i < printPlan.plates.length; i++)
      zip.file(`print-plates/plate-${i+1}.3mf`, await plate3mfBytes(i));
  }
  zip.file('README.txt', readmeText());
  saveBlobAsync(await zip.generateAsync({ type: 'blob' }),
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
  lines.push(`Split: ${splitName()} | Pieces: ${layout.pieces.length} in ${plural(rows, 'row band')}`);
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
const splitName = () => SPLIT_NAMES[state.splitMode] || state.splitMode;

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
  const bad = layout.pieces.filter((pc) => !pieceFits(pc));
  if (bad.length)
    return { cls: 'bad', t: `${plural(bad.length, 'piece')} — ${bad.map((pc) => pc.id).join(', ')} — ` +
      `will not fit your ${bed}. Add a cut through them on the cut map, or pick a split mode ` +
      'that makes smaller pieces; the files below would print oversized as they stand.' };
  const err = warningsList().find((w) => w.err);
  if (err) return { cls: 'bad', t: err.t + ' Nothing can be exported until that is fixed.' };
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
  const g = materialGrams();
  $('exDesign').textContent =
    `${layout.nx} × ${layout.ny} cell grid (${(layout.nx * pitch).toFixed(0)} × ${(layout.ny * pitch).toFixed(0)} mm) ` +
    `in a ${state.drawerW} × ${state.drawerD} mm drawer\n` +
    `${plural(layout.pieces.length, 'piece')}, ${splitName()} split, joined with ${CONNECTOR_NAMES[state.connector] || state.connector}\n` +
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
          `${plural(n, 'plate')} · 3MF` + (n > 1 ? ' in a ZIP' : '') + ' · the whole job, arranged',
          'Download', downloadAllPlates,
          { 'data-ex': 'allplates', 'aria-label': 'Download every print plate (3MF)' });
    /* Per-plate downloads. The combined export already builds each plate on its own
       before zipping them, so one plate at a time is the same call with the zip left
       off — and it is what you want when one print failed, or when tonight's print is
       only this plate. */
    printPlan.plates.forEach((pl, i) => exRow(`Plate ${i + 1}`,
      `${plural(pl.placed.length, 'part')} on a ${state.bedW} × ${state.bedD} mm bed · 3MF`, 'Download',
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
  if (KEYED.includes(state.connector)) {
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
const encodeDesc = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
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
function startFresh() {
  try { localStorage.removeItem(SAVE_KEY); } catch (err) { /* nothing to clear */ }
  location.href = location.origin + location.pathname;   // drop the hash and reload clean
}

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
  const q = Object.fromEntries(h.split('&').map(kv => kv.split('=').map(decodeURIComponent)));
  for (const [k, v] of Object.entries(q)) if (!OWNED.has(k)) hashExtras[k] = v;
  /* The link is millimetres, always; a drawer length is written into its field in
     whatever unit the field is showing. Anything that is not a number goes in as it
     came, so the field's own check can say what is wrong with it. */
  const set = (id, v) => {
    if (v === undefined || !$(id)) return;
    if (LENGTH_IDS.includes(id) && v !== '' && isFinite(+v)) FIELDS.setLength($(id), +v, unit);
    else $(id).value = v;
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
  if (q.sp) {
    state.splitMode = q.sp; setSplitSeg(q.sp);
    if (q.sp === 'manual') {
      state.rowCuts = q.rc ? q.rc.split(',').map(Number).filter(n => !isNaN(n)) : [];
      state.colCuts = q.cc ? q.cc.split('_').map(s => s ? s.split('.').map(Number) : []) : [];
    }
  }
  /* The list follows the bed, not the other way round. It did not follow it at all: a
     link with a 180 mm bed reopened with the fields at 180 and the list still showing
     the 256 mm entry above them. */
  $('bedPreset').value = FIELDS.presetFor($('bedPreset'), bedNow(), q.pr);
}
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
   a field. There Ctrl+Z belongs to the field — it takes back the last few characters you
   typed, which is what anyone pressing it mid-number means — and the run-of-typing logic
   above tidies up after it. Everywhere else, including a button you just clicked, it is
   the design's. */
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
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
/* A link beats a saved layout, always. Reading the hash first and only falling back
   means a shared drawer is never quietly replaced by the recipient's own. */
const incomingHash = (location.hash || '').replace(/^#/, '');
if (incomingHash.length > 2) loadFromHash();
else {
  const saved = readLocal();
  if (saved.length > 2) { loadFromHash(saved); $('restored').style.display = ''; }
}
hashReady = true;                         // loadFromHash has had its say; ours may start
recomputeLayout();
autoFrame();


if ($('startFresh')) $('startFresh').addEventListener('click', startFresh);

/* A hash this page did not write means someone navigated to a link — pasted a share URL
   into the address bar, or picked a bookmark — and changing only the fragment is a
   same-document navigation, so nothing re-reads it and the drawer on screen stays put.
   Before local saving that was merely confusing; now it means a shared layout loses to
   whatever this browser had stored, which is the one case that must never happen.
   Reloading applies the link. replaceState does not fire this event, so the saves this
   page makes every few seconds cannot trigger it. */
addEventListener('hashchange', () => location.reload());

