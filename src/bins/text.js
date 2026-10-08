/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Drawerforge — a bin's note, as raised letters on its label shelf.
 *
 * Three steps, each a function here: which characters of the note can print
 * (notePrintable), how big and on how many lines they fit the shelf (noteFit), and the
 * letters as closed shells (noteShells). bin.js decides where the shelf is and calls them.
 * The font is Hershey Simplex (font.js), a single-stroke font: every letter is a few
 * strokes of a pen, not an outline.
 *
 * Text only ever goes through a lookup table here. A note is something a person typed
 * or a link carried, and no part of it reaches markup or a file name from this file:
 * the page writes what it says about the letters with textContent, and file names get
 * noteSlug, which keeps only a-z, 0-9 and dashes.
 *
 * Runs in the browser and headless in Node, like bin.js (module.exports guard at the
 * bottom). On the page font.js is spliced in ahead of this file and bin.js after it.
 */
'use strict';

const NOTE_FONT = typeof module !== 'undefined' ? require('./font.js') : HERSHEY_SIMPLEX;

const NOTE_SPEC = {
  /* Letter sizes are cap heights. 8 mm is as big as a note is ever printed, which a
     word or two on a wide bin would otherwise pass. Under 3 mm the counters of e, a and
     8 close up at a 0.8 mm stroke, so a note that would print smaller goes on two lines,
     and one too long for two lines at 3 mm is cut short. 3 mm is from a render, where
     the counters stayed open at 3.25 mm; nothing has been printed at it yet. */
  capMax: 8,
  capMin: 3,
  /* A shelf shallower than this takes no letters: under it a single line of capitals
     comes out under 3 mm on a 1.2 mm wall. A 1-unit bin has no room under its rim for
     a lowered shelf at all, and a 2-unit one with screw holes only 5.75 mm. */
  shelfMin: 6,
  stroke: 0.8,        // two lines from a 0.4 mm nozzle
  relief: 0.6,        // how far the letters stand up: three 0.2 mm layers
  front: 0.6,         // kept clear of the shelf's front edge
  lineGap: 0.35,      // between two lines, in cap heights
  sides: 8,           // facets of the disc at each point of a stroke
};
// Hershey units, y counting down: the cap height runs from -12 to the baseline at 9
const NOTE_CAP_U = 21, NOTE_TOP_U = -12, NOTE_BASE_U = 9;
/* How far the plastic reaches past a stroke's centre line: to a corner of the disc at
   each point (noteShells), half the stroke and 0.05 over the inscribed radius. */
const NOTE_INK = (NOTE_SPEC.stroke / 2 + 0.05) / Math.cos(Math.PI / NOTE_SPEC.sides);
/* How far apart noteShells keeps the corners of any two of a note's shells, in x or in
   y, wherever a move it may make allows it: twice a 0.01 mm grid such as some tools that
   repair a mesh weld it on. Where none does, as far apart as the best of them leaves
   them, which nothing holds to a figure (noteShells). */
const NOTE_APART = 0.02;

/* ---------- characters ---------------------------------------------------- */

/* One glyph string to { L, R, strokes }: its left and right edges and its strokes as
   lists of points, in Hershey units (see font.js for the format). */
function decodeGlyph(s) {
  const L = s.charCodeAt(0) - 82, R = s.charCodeAt(1) - 82, strokes = [];
  let cur = [];
  for (let k = 2; k + 1 < s.length; k += 2) {
    if (s[k] === ' ' && s[k + 1] === 'R') { if (cur.length) strokes.push(cur); cur = []; continue; }
    cur.push([s.charCodeAt(k) - 82, s.charCodeAt(k + 1) - 82]);
  }
  if (cur.length) strokes.push(cur);
  return { L, R, strokes };
}
const noteGlyphs = new Map();
// a single character's glyph, or null when the font has none
function noteGlyph(ch) {
  if (noteGlyphs.has(ch)) return noteGlyphs.get(ch);
  const code = ch.length === 1 ? ch.charCodeAt(0) : -1;
  const s = code >= 32 && code <= 126 ? NOTE_FONT.ascii[code - 32]
    : Object.prototype.hasOwnProperty.call(NOTE_FONT.more, ch) ? NOTE_FONT.more[ch] : '';
  if (!s) return null;                     // not cached: the misses are unbounded
  const g = decodeGlyph(s);
  noteGlyphs.set(ch, g);
  return g;
}

/* What a character prints as when the font has no glyph of its own for it. Typing
   gives curly quotes, long dashes and no-break spaces as readily as plain ones, and
   phones put them in for you, so they print as the ASCII they stand for rather than
   being left off. µ and Ω each have two code points that look the same, and ⌀ is the
   diameter sign Ø is usually typed for. */
const NOTE_SAME = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-',
  '−': '-',
  '\t': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '…': '...',
  'μ': 'µ', 'Ω': 'Ω', '⌀': 'Ø',
};

/* A note split into what a reader would call its characters. An emoji with a skin tone,
   a flag, or a letter with a combining accent is several code points and one character,
   and it is left off whole: by code point, an accent would be named as left off on its
   own, as an invisible mark nobody typed. Browsers without Intl.Segmenter split by code
   point, which only differs for those. */
let noteSegmenter;
function noteChars(s) {
  if (noteSegmenter === undefined)
    noteSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return noteSegmenter ? Array.from(noteSegmenter.segment(s), (x) => x.segment) : [...s];
}

/* The note as it will print: { text, dropped }. `text` is every character the font can
   draw, after NOTE_SAME, with the spaces at its ends and any run of them inside it
   closed up — one left where a character was dropped from between two spaces would
   print as a double gap. `dropped` is each character that cannot print, once, in the
   order they come, for the page to name. */
const notePrinted = new Map();
function notePrintable(note) {
  const s = String(note === undefined || note === null ? '' : note);
  if (notePrinted.has(s)) return notePrinted.get(s);
  let text = '';
  const dropped = [];
  for (const g of noteChars(s.normalize('NFC'))) {
    const t = Object.prototype.hasOwnProperty.call(NOTE_SAME, g) ? NOTE_SAME[g] : g;
    if ([...t].every((c) => noteGlyph(c))) text += t;
    else if (!dropped.includes(g)) dropped.push(g);
  }
  const out = { text: text.replace(/ {2,}/g, ' ').replace(/^ | $/g, ''), dropped };
  if (notePrinted.size > 500) notePrinted.clear();
  notePrinted.set(s, out);
  return out;
}

/* ---------- fitting ------------------------------------------------------- */

/* One line laid out in Hershey units: its strokes, its advance, and how far it reaches
   up and down. At least the cap height, so a line of lower case is sized as the capitals
   would be and "prints 4.6 mm tall" means the same thing for every note. */
function noteLine(text) {
  let x = 0, top = NOTE_TOP_U, bottom = NOTE_BASE_U;
  const strokes = [];
  for (const ch of text) {
    const g = noteGlyph(ch);
    for (const st of g.strokes)
      strokes.push(st.map(([px, py]) => {
        top = Math.min(top, py); bottom = Math.max(bottom, py);
        return [x + px - g.L, py];
      }));
    x += g.R - g.L;
  }
  return { text, strokes, adv: x, top, span: bottom - top };
}

const NOTE_ELLIPSIS = '...';
const NOTE_CUT_KEEPS = 3;     // a cut keeping fewer of the note's characters is no note
/* The note cut short to fit, with an ellipsis, when it will not go on two lines 3 mm
   tall: { lays, s, cut }, or null when cutting would not make it any bigger. Every line
   is given the vertical reach of the whole note, so whatever is kept fits whatever was
   cut. Two lines at 3 mm if the shelf is deep enough for them, else one, as tall as the
   shelf allows up to 3 mm. The first of two lines breaks at a space where it can, and
   inside a word only when the first word alone is too long. */
function noteCut(text, W, Hh) {
  const sMin = NOTE_SPEC.capMin / NOTE_CAP_U, gap = NOTE_SPEC.lineGap * NOTE_CAP_U;
  const span = noteLine(text).span;
  const sFor = (n) => Math.min(sMin, Hh / (n * span + (n - 1) * gap));
  const n = sFor(2) >= sMin - 1e-9 ? 2 : 1, s = sFor(n), Wu = W / s;
  const fits = (t) => noteLine(t).adv <= Wu + 1e-9;
  if (!fits(NOTE_ELLIPSIS)) return null;
  let cut = false;
  const cutTo = (t) => {
    if (fits(t)) return t;
    cut = true;
    for (let k = t.length - 1; k > 0; k--) {
      const p = t.slice(0, k).trimEnd() + NOTE_ELLIPSIS;
      if (fits(p)) return p;
    }
    return NOTE_ELLIPSIS;
  };
  let lines;
  if (n === 1) lines = [cutTo(text)];
  else {
    let k = text.length, inWord = false;
    while (k > 0 && !fits(text.slice(0, k).trimEnd())) k--;
    if (k < text.length && text[k] !== ' ') {
      const sp = text.lastIndexOf(' ', k - 1);
      if (sp > 0) k = sp;
      else inWord = true;
    }
    const first = text.slice(0, k).trimEnd(), rest = text.slice(k).trimStart();
    const second = rest ? cutTo(rest) : '';
    /* A second line of nothing but the ellipsis is not a line, and a word broken over
       two lines and then cut short reads as two words: the note goes on one line, cut to
       fit. Between dividers "M3 screws" came out "M / ..." and "Assorted M3 M4 nuts,
       washers" "As / s...". A word broken with nothing cut ("Resis / tors") stays. */
    lines = !rest ? [first]
      : second === NOTE_ELLIPSIS || (inWord && second !== rest) ? [cutTo(text)] : [first, second];
  }
  return { lays: lines.map(noteLine), s, cut };
}

/* The note fitted to a band of the shelf, { x0, x1, y0, y1 } in mm with y0 the front:
   the largest letters that fit, up to 8 mm; under 3 mm, two lines split at whichever
   space gives the largest letters, the nearer the middle on a tie; still under 3 mm, cut
   short (noteCut). Centred both ways in the band.
   The band is where plastic may go, so the strokes' centre lines are fitted NOTE_INK
   inside it: fitted to the band itself, a letter at its edge reached half a stroke past
   it, under the lip at the back and to a tenth of a millimetre from the shelf's front.
   Returns { lines, cap, cut, segs, readable }: the lines as printed, the cap height in
   mm, whether anything was cut, every stroke as a list of [x, y] points in mm, and
   whether the band has room for the note at these rules. A cut note on a shelf too
   shallow even for one line 3 mm tall is smaller than 3 mm, and `cap` says so; that is
   the shelf's depth, and still readable. A band too NARROW is not: when not even the
   ellipsis goes in at the size the depth allows, nothing could be cut to fit, and the
   letters come out as small as the width makes them; and when a cut keeps fewer than
   three of the note's characters, or less than all of a shorter one, too little of it is
   there to read: "M..." says nothing "M3 screws" did. Nor is a band with no width or
   depth left at all, where the size came out at nothing or under it, mirroring the
   letters. A shelf the width of a bin is never that narrow; the spaces between dividers
   can be (noteOnShelf). */
const noteFits = new Map();
function noteFit(text, outer) {
  const k = [text, outer.x0, outer.x1, outer.y0, outer.y1].join('|');
  if (noteFits.has(k)) return noteFits.get(k);
  const band = { x0: outer.x0 + NOTE_INK, x1: outer.x1 - NOTE_INK,
                 y0: outer.y0 + NOTE_INK, y1: outer.y1 - NOTE_INK };
  const W = band.x1 - band.x0, Hh = band.y1 - band.y0;
  const sMax = NOTE_SPEC.capMax / NOTE_CAP_U, sMin = NOTE_SPEC.capMin / NOTE_CAP_U;
  const gap = NOTE_SPEC.lineGap * NOTE_CAP_U;
  const sizeOf = (lays) => Math.min(sMax, W / Math.max(...lays.map((l) => l.adv)),
    Hh / (lays.reduce((t, l) => t + l.span, 0) + gap * (lays.length - 1)));
  let best = { lays: [noteLine(text)], cut: false };
  best.s = sizeOf(best.lays);
  if (best.s < sMin) {
    const mid = text.length / 2;
    let at = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== ' ') continue;
      const lays = [noteLine(text.slice(0, i)), noteLine(text.slice(i + 1))];
      const s = sizeOf(lays);
      if (s > best.s + 1e-9 || (at >= 0 && s > best.s - 1e-9 && Math.abs(i - mid) < Math.abs(at - mid))) {
        best = { lays, s, cut: false };
        at = i;
      }
    }
  }
  if (best.s < sMin) {
    const c = noteCut(text, W, Hh);
    if (c && c.s > best.s + 1e-9) best = c;
  }
  const s = best.s, segs = [];
  const blockH = best.lays.reduce((t, l) => t + l.span, 0) * s + gap * s * (best.lays.length - 1);
  let yTop = (band.y0 + band.y1) / 2 + blockH / 2;
  for (const lay of best.lays) {
    const x0 = band.x0 + (W - lay.adv * s) / 2;
    for (const st of lay.strokes) segs.push(st.map(([x, y]) => [x0 + x * s, yTop - (y - lay.top) * s]));
    yTop -= (lay.span + gap) * s;
  }
  const sDepth = Math.min(sMin, Hh / noteLine(text).span);
  // what a cut keeps, its own ellipsis (always at the end of the last line) and spaces aside
  const chars = (t) => t.replace(/\s/g, '').length, shown = best.lays.map((l) => l.text).join(' ');
  const few = best.cut &&
    chars(shown.slice(0, -NOTE_ELLIPSIS.length)) < Math.min(NOTE_CUT_KEEPS, chars(text));
  const out = { lines: best.lays.map((l) => l.text), cap: s * NOTE_CAP_U, cut: best.cut, segs,
                readable: !few && W > 0 && Hh > 0 && s >= sDepth - 1e-9 };
  if (noteFits.size > 500) noteFits.clear();
  noteFits.set(k, out);
  return out;
}

/* ---------- shells -------------------------------------------------------- */

/* The strokes as closed shells, from z0 to z1. No union and no ear clipping that can go
 * wrong: every shell is convex, and earTriangulate cannot fail on a convex polygon.
 *
 *   segments  each a rectangle the stroke's width
 *   discs     an octagon whose INSCRIBED radius is half the stroke and 0.05 mm more, at
 *             each end of a stroke and at each corner sharper than 28 degrees, rounding it
 *
 * At a gentler bend there is no disc. The two rectangles there each run 0.1 mm past the
 * point instead, and their outer edges cross within that: they meet as a mitred corner,
 * all the way out, while 0.4 tan(28 / 2) is under 0.1. Most of a curve's points are
 * bends like that, and a disc is 28 triangles where a rectangle is 12: with a disc at
 * every point "M3 screws" cost 3,720 triangles, which is more than the whole bin under
 * it. Where there is a disc, a rectangle stops short of it, 0.1 mm at the far end of the
 * segment and 0.12 at the near one, so it ends strictly inside the disc.
 *
 * They overlap and are fused by the slicer, as every shell in a bin is (ENGINE.md §1),
 * and none may share an edge with another, which would be an edge used four times. The
 * points of a stroke lie on Hershey's grid, so shells lined up along it are the usual
 * case rather than a coincidence, and each way two could meet is kept apart:
 *
 *   - Two discs side by side met flat to flat wherever the letters were scaled to put
 *     them exactly a stroke apart: the two strokes of "$" did at 4.2 mm. The octagon is
 *     turned 1.2 degrees, which leaves every flat facing a direction no two points of a
 *     note can lie in, at any size: the nearest is 1.2 degrees off (searched).
 *   - Two strokes side by side, the same length, met along a side when they were a
 *     stroke apart: "$" again, at 4.2 mm, the stems of "m", and "=" and '"' smaller. A
 *     segment's ends are 0.004 mm further along in every other lane (lane, below), so
 *     two that lie a stroke apart never end level.
 *   - A stroke that turns straight back on itself would end its two rectangles on the
 *     same corners, so the near stop is longer than the far one (0.12 and 0.1).
 *   - A segment drawn twice is built once.
 *   - And any other one vertex in common, which nothing lines up, still makes no shared
 *     edge: each shell starts a different depth into the shelf, 0.003 mm apart, so their
 *     upright edges never match.
 *
 * That keeps them apart to the last digit, and some tools that repair a mesh work to
 * less: they weld it on a grid, 0.01 mm across, say, every vertex put on the grid and
 * the ones in one cell of it made one, and two shells with a corner each in one cell
 * share whatever edge leaves that cell. Laid out only as above, every note had two
 * shells' corners closer than 0.02 mm, and welded on a grid of 0.01 mm, at one offset of
 * it or another, nearly half the notes in the audit's sweep had an edge used four times.
 * At a bend a little gentler than 28 degrees the outer corners of the two rectangles all
 * but meet, and 0.004 and 0.003 mm are both less than a cell. "Fuses 5A, 10A" on a 2x1x2
 * did it with two discs 0.37 mm apart, corners 8 µm apart, on a grid moved 5 µm.
 *
 * So each shell is laid clear of the corners of every one before it, NOTE_APART in x or
 * in y, and one that would not be moves the least that clears it (stop, below). A
 * rectangle's end moves 0.01 mm at a time, up to 0.08: at a disc into it or back towards
 * its point, to 0.18 from the point at most, where its corners are 0.44 from it and still
 * inside the disc's 0.45; at a mitred bend nearer the point or further past it, never so
 * near that the outer edges no longer cross and never more than 0.18 past. Where none of
 * those clears it, half steps between and on to 0.16, within the same bounds, and where
 * none of those does either, the one that leaves the most room. A disc turns 2.5 degrees
 * at a time, to any of the 18 ways an octagon can face, or where none clears it, the way
 * that leaves the most room. Turned, it could meet another flat to flat, but never with
 * their corners together, which is what made the shared edge. Where the letters' outline
 * moves at all, it is by under 0.04 mm: a disc's corners stand 0.037 out from its flats,
 * and a mitre's outer tip stands out under 0.04.
 *
 * What that keeps is NOTE_APART wherever any of those moves gives it, and otherwise the
 * most any of them leaves, which nothing here holds to a figure. In 79,625 random notes
 * of any of the font's characters, 22 had a shell with no move that gave it: in 21 a
 * stroke's end at a mitred bend, 13 of them near 27 degrees, where it may stop only
 * within 0.08 mm, and in one a disc. The nearest two shells' corners came was 18.2 µm.
 * Keeping the stop it started with, as it did before, left 31 of the first 39,811 under
 * 0.02 mm, two under 1 µm. The audit holds a sweep of such notes to 15 µm: over 10 µm,
 * two corners are never in one cell of a 10 µm grid, at any offset, and over 14.2 µm,
 * nor turned any way. A coarser weld still joins them. Cura melds vertices within
 * 0.03 mm, and under that most notes still have two shells sharing an edge, as they did
 * before any of this: 667 of the audit's 720, against all 720. That is no worse, and
 * Cura copes with such an edge on its own.
 *
 * One segment too short to leave any rectangle between its stops is covered by the
 * discs at its ends: each reaches 0.45 mm from its point, and the farthest corner of the
 * stroke from both is under 0.42 mm. Whether there is one is decided at the stops laid
 * out above, before any is moved. */
function noteShells(G, segs, z0, z1) {
  const h = NOTE_SPEC.stroke / 2, n = NOTE_SPEC.sides, R = NOTE_INK;
  const past = 0.1, stopA = 0.12, stopB = 0.1, turn = -1.2 * Math.PI / 180;
  const mitre = Math.cos(2 * Math.atan(past / h));    // the sharpest bend left square
  const key = (p) => p[0].toFixed(4) + ',' + p[1].toFixed(4);
  const polys = [], discs = new Map(), done = new Set();
  let shells = 0;
  // every corner laid so far, by the square NOTE_APART across it is in
  const laid = new Map(), cell = (v) => Math.floor(v / NOTE_APART);
  const clear = (ring) => ring.every(([x, y]) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const [qx, qy] of laid.get((cell(x) + i) + ',' + (cell(y) + j)) || [])
        if (Math.abs(x - qx) < NOTE_APART && Math.abs(y - qy) < NOTE_APART) return false;
    return true;
  });
  // how far the ring's corners are from the nearest laid one, the more of x and y, up to NOTE_APART
  const room = (ring) => {
    let m = NOTE_APART;
    for (const [x, y] of ring) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const [qx, qy] of laid.get((cell(x) + i) + ',' + (cell(y) + j)) || [])
        m = Math.min(m, Math.max(Math.abs(x - qx), Math.abs(y - qy)));
    return m;
  };
  const shell = (ring) => {
    for (const p of ring) {
      const k = cell(p[0]) + ',' + cell(p[1]);
      if (!laid.has(k)) laid.set(k, []);
      laid.get(k).push(p);
    }
    polys.push(...G.extrudePoly(ring, z0 - 0.003 * (shells++ % 64), z1));
  };
  /* Where a rectangle stops at one end: `s` as laid out below, or the least move from it
     that leaves the end's two corners (`ends(t)` for a stop t) clear of every shell laid
     so far, 0.01 mm at a time up to 0.08 either way. At a disc the stop stays within 0.18
     of the point; at a mitre the end runs at least `need` past it and at most 0.18. `most`
     keeps the rectangle 0.02 long. When none of those clears them, the half steps between
     and on to 0.16, within the same bounds, the least move first; and when none of those
     does either, whichever of them, or `s`, leaves the corners the most room. It kept `s`
     there, which could leave two shells' corners under 1 µm apart (above). */
  const stop = (s, round, need, most, ends) => {
    const out = (t) => t > most || t < -0.18 || (round ? t > 0.18 : t > -need);
    for (let k = 0; k <= 8; k++) for (const t of k ? [s + k * 0.01, s - k * 0.01] : [s]) {
      if (k && out(t)) continue;
      if (clear(ends(t))) return t;
    }
    let best = s, wide = room(ends(s));
    for (let k = 1; k <= 16; k++) for (const t of [s + (k - 0.5) * 0.01, s - (k - 0.5) * 0.01, s + k * 0.01, s - k * 0.01]) {
      if (out(t)) continue;
      const r = room(ends(t));
      if (r >= NOTE_APART) return t;
      if (r > wide) { wide = r; best = t; }
    }
    return best;
  };
  /* Which lane a segment runs in: how many strokes its line is from the origin, odd or
     even, measured across it. Two parallel segments a stroke apart are in neighbouring
     lanes whichever way each was drawn. */
  const lane = (a, ux, uy) => {
    const flip = -uy < 0 || (uy === 0 && ux < 0) ? -1 : 1;
    return Math.round(flip * (-uy * a[0] + ux * a[1]) / (2 * h)) & 1;
  };
  for (const raw of segs) {
    const line = raw.filter((p, i) => i === 0 || key(p) !== key(raw[i - 1]));
    const dir = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const dx = line[i + 1][0] - line[i][0], dy = line[i + 1][1] - line[i][1];
      const L = Math.hypot(dx, dy);
      dir.push([dx / L, dy / L, L]);
    }
    const round = line.map((p, i) => i === 0 || i === line.length - 1 ||
      dir[i - 1][0] * dir[i][0] + dir[i - 1][1] * dir[i][1] < mitre);
    line.forEach((p, i) => { if (round[i] && !discs.has(key(p))) discs.set(key(p), p); });
    // how far past a mitred bend a rectangle has to run for the outer edges to cross, and a hundredth
    const need = line.map((p, i) => {
      if (round[i]) return 0;
      const c = dir[i - 1][0] * dir[i][0] + dir[i - 1][1] * dir[i][1];
      return h * Math.sqrt((1 - c) / (1 + c)) + 0.01;
    });
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1], [ux, uy, L] = dir[i];
      // how far in from each end the rectangle starts; less than nothing runs past it
      const step = 0.004 * lane(a, ux, uy);
      const sa = round[i] ? stopA + step : -past - step, sb = round[i + 1] ? stopB + step : -past - step;
      if (L - sa - sb < 0.02) continue;
      const ka = key(a), kb = key(b), k = ka < kb ? ka + ' ' + kb : kb + ' ' + ka;
      if (done.has(k)) continue;
      done.add(k);
      const nx = -uy * h, ny = ux * h;
      // the two corners across the stroke at `d` along it from p
      const ends = (p, d) => [[p[0] + ux * d - nx, p[1] + uy * d - ny], [p[0] + ux * d + nx, p[1] + uy * d + ny]];
      const ta = stop(sa, round[i], need[i], L - sb - 0.02, (t) => ends(a, t));
      const tb = stop(sb, round[i + 1], need[i + 1], L - ta - 0.02, (t) => ends(b, -t));
      const p0 = [a[0] + ux * ta, a[1] + uy * ta], p1 = [b[0] - ux * tb, b[1] - uy * tb];
      shell([[p0[0] - nx, p0[1] - ny], [p1[0] - nx, p1[1] - ny],
             [p1[0] + nx, p1[1] + ny], [p0[0] + nx, p0[1] + ny]]);
    }
  }
  for (const p of discs.values()) {
    /* turned as above, else the least further, 2.5 degrees at a time: the 18 ways it can
       face; and when none clears, the way that leaves the most room */
    const tries = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9].map((k) => {
      const ring = [];
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) * 2 * Math.PI / n + turn + k * 2.5 * Math.PI / 180;
        ring.push([p[0] + R * Math.cos(t), p[1] + R * Math.sin(t)]);
      }
      return ring;
    });
    shell(tries.find(clear) || tries.reduce((a, b) => (room(b) > room(a) ? b : a)));
  }
  return polys;
}

/* ---------- names --------------------------------------------------------- */

/* Eight hex digits (FNV-1a, 32 bits) that name a printed note in a file name when the
   note has nothing noteSlug can spell. Only a name: two notes that hash alike still
   download as two files, since typeNames numbers a clash apart. It is not what tells
   one part from another. It was, in the part's key, and two notes sharing a key share a
   part, so one bin printed the other's letters: in a drawer of a hundred notes that is
   about one drawer in 868,000, not the chance in a few hundred million this said. The
   key now carries the printed lines themselves (noteKey in ui.js). */
function noteHash(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
/* The printed note in a file name: lower case a-z and 0-9, anything else a dash, at most
   24 characters and never starting or ending with a dash. "M3 screws" is m3-screws. A
   note with nothing in that alphabet — "µΩ" — is named by its hash, so it still has a
   name of its own. */
function noteSlug(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '')
    .slice(0, 24).replace(/-+$/, '');
  return s || noteHash(text);
}

if (typeof module !== 'undefined') {
  module.exports = { NOTE_SPEC, NOTE_SAME, NOTE_INK, NOTE_CAP_U, noteGlyph, notePrintable,
    noteLine, noteFit, noteShells, noteHash, noteSlug };
}
