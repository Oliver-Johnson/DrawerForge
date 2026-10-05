/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Joint diagrams, drawn from the parameters the plates are actually cut with.
 *
 * Seven connector options and, until now, no picture of any of them anywhere on the
 * site — 3,400 words of guide about physical geometry with nothing to look at. The
 * prose is good ("dog-bone recesses under both pieces take a sprung key: the slot
 * through its middle lets it compress") but it asks the reader to hold a 3.6 mm part
 * in their head, and the 3D preview shows the whole plate at a scale where a joint is
 * sub-pixel.
 *
 * These are generated at build time from core.js's own DEFAULTS rather than drawn by
 * hand, so a change to a joint changes its picture. A hand-drawn diagram is a claim
 * about the geometry that nothing checks; this one cannot disagree with the part.
 *
 * Plan view, looking down on the seam. Millimetres map to user units 1:1 and the
 * viewBox does the scaling, so every number below is a real dimension.
 */
'use strict';

const R = (n) => Math.round(n * 100) / 100;

/* The dovetail is the one joint with no outline function of its own: buildPiece cuts
   it inline as a four-point taper. Same arithmetic here, minus the anti-coincidence
   jitter, which is a meshing detail and not something to draw. */
function dovetailTab(t) {
  const halfRoot = t.wr / 2, halfTip = t.wt / 2;
  return [[-halfRoot, 0], [-halfTip, t.dp], [halfTip, t.dp], [halfRoot, 0]];
}

const path = (pts, close) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${R(p[0])} ${R(p[1])}`).join(' ') + (close ? ' Z' : '');

/* One picture per joint: the two plate edges, the seam between them, and the joint.
   `parts` are cut into the plate; `loose` is a separate piece you print and insert. */
function diagram(kind, G) {
  const D = G.DEFAULTS;
  /* One frame and one scale for all six. Sized per joint at first, which let each
     picture fill its box -- and made a 3.6 mm h-clip look the same size as a 14 mm
     bowtie key. That hides the most useful thing a reader comparing them could know,
     because the parts differ in size far more than in shape. A shared scale means the
     dovetail sits in a lot of empty plate, and that is the honest picture of a 1.9 mm
     notch beside a key nearly eight times as long. */
  const W = 34, h = 20;                  // mm across the seam, and top to bottom
  let body = '', caption = '', loose = null;

  if (kind === 'dovetail') {
    const tab = dovetailTab(D.tab);
    body = `<path class="j-cut" d="${path(tab, true)}"/>`;
    caption = `${D.tab.wr} mm at the seam, ${D.tab.wt} mm at ${D.tab.dp} mm deep — it cannot pull straight out`;
  } else if (kind === 'puzzle') {
    const pz = G.puzzleShape('+y', 0, 0, D.puzzle, 0, false);
    body = `<path class="j-cut" d="${path(pz, true)}"/>`;
    caption = `a ${D.puzzle.neckW} mm neck opening to a ${R(D.puzzle.lobeR * 2)} mm lobe`;
  } else {
    /* The keyed joints are a recess in each piece plus a loose part. Draw the part —
       it is what you hold, and what the reader is being asked to choose between. */
    /* keyOutline lays the key out along x, which is its LENGTH. A key bridges the
       seam -- half of it in each piece -- so with the seam drawn horizontally the
       length has to run vertically. Drawn straight from keyOutline the keys lay along
       the seam instead of crossing it, holding nothing together. Swap the axes. */
    const raw = kind === 'hclip'
      ? G.keyOutline('snap', G.hclipPrm(D.hclip))
      : G.keyOutline(kind, D.key);
    const key = raw.map((p) => [p[1], p[0]]);
    loose = `<path class="j-part" d="${path(key, true)}"/>`;
    /* The snap key's caption promises a slot, so the picture has to have one, or the
       diagram argues with its own words. buildKey cuts it as len*0.62 by 1.3. */
    if (kind === 'snap') {
      const sl = D.key.len * 0.62, sw = 1.3;   // swapped with the outline above
      loose += `<path class="j-slot" d="${path([[-sw / 2, -sl / 2], [sw / 2, -sl / 2],
                                                 [sw / 2, sl / 2], [-sw / 2, sl / 2]], true)}"/>`;
    }
    // measured off the unswapped outline, so length stays length whatever the drawing does
    const w = Math.max(...raw.map((p) => p[0])) - Math.min(...raw.map((p) => p[0]));
    const d = Math.max(...raw.map((p) => p[1])) - Math.min(...raw.map((p) => p[1]));
    caption = {
      bowtie: `a ${R(w)} x ${R(d)} mm bowtie, waisted so it cannot slide out either way`,
      puzzlekey: `a ${R(w)} x ${R(d)} mm key with lobed ends`,
      snap: `a ${R(w)} x ${R(d)} mm sprung key — the slot lets it compress going in`,
      hclip: `a ${R(w)} x ${R(d)} mm U-clip, pressed in from above once the plate is down`,
    }[kind];
  }

  /* Both sides of the seam, always. A joint is two pieces meeting; drawing one plate
     with a shape hanging off it shows half the point and leaves most of the frame
     empty. The tab belongs to the upper piece and reaches into the lower one. */
  const pad = 3.5;
  const top = -(h / 2), bot = h / 2;
  const vb = `${-W / 2} ${top} ${W} ${h}`;
  return { svg:
`<svg class="joint" viewBox="${vb}" role="img" aria-label="${caption}">` +
`<rect class="j-plate" x="${-W / 2}" y="${top}" width="${W}" height="${-top}"/>` +
`<rect class="j-plate" x="${-W / 2}" y="0" width="${W}" height="${bot}"/>` +
`<path class="j-seam" d="M${-W / 2} 0 L${W / 2} 0"/>` +
(body || '') + (loose || '') +
`</svg>`, caption };
}

const KINDS = ['dovetail', 'puzzle', 'bowtie', 'puzzlekey', 'snap', 'hclip'];

function all(G) {
  const out = {};
  for (const k of KINDS) out[k] = diagram(k, G);
  return out;
}

const LABELS = { dovetail: 'Dovetail tabs', puzzle: 'Puzzle tabs', bowtie: 'Bowtie keys',
                 puzzlekey: 'Puzzle keys', snap: 'Snap clips', hclip: 'H-clips' };

/* The whole set, for the guide. Figures rather than bare images: the caption carries
   the dimensions, so the picture is readable by someone who cannot see it. */
function gallery(G) {
  const d = all(G);
  return '<div class="joints">' + KINDS.map((k) =>
    `<figure class="jointfig">${d[k].svg}` +
    `<figcaption><b>${LABELS[k]}</b>${d[k].caption}</figcaption></figure>`).join('') +
    '</div>';
}

/* The same six, for the connector picker on the baseplates page. No captions: the hint
   paragraph beside the dropdown already says the dimensions in words, and a caption
   would be the same fact twice in the width of a 400 px rail. That is also why the
   figure is aria-hidden -- the hint is the accessible equivalent, so a screen reader
   should hear it once, in the better of the two forms. */
function pickerFigures(G) {
  const d = all(G);
  return KINDS.map((k) =>
    `<div class="connfig" data-joint="${k}" style="display:none" aria-hidden="true">` +
    `${d[k].svg}</div>`).join('');
}

module.exports = { all, diagram, gallery, pickerFigures, KINDS, LABELS, dovetailTab };
