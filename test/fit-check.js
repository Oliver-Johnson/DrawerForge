#!/usr/bin/env node
/* Measures the real clearance between a spec Gridfinity bin foot and our baseplate socket.
 *
 * The bin outline here is derived ONLY from the published Gridfinity spec — it never
 * consults src/core.js. That independence is the point: deriving the bin from our own
 * socket would make any shared error invisible.
 *
 * Published spec (42 mm pitch):
 *   footprint 41.5 mm square at the widest, corner fillet r = 3.75 mm
 *   base profile from the bottom: 35.6 -> 0.8 mm @45deg -> 37.2, 1.8 mm vertical,
 *   then 2.15 mm @45deg -> 41.5.  Total base height 0.8 + 1.8 + 2.15 = 4.75 mm.
 *
 * Both outlines are rounded squares, so each is fully described at a given z by
 * (half-width, corner radius). The corner-arc CENTRE sits at (half - r); when the two
 * shapes disagree on that centre, clearance stops being uniform around the perimeter.
 *
 * Usage: node test/fit-check.js
 */
'use strict';

const PITCH = 42, HALF = PITCH / 2;

/* ---- spec bin (independent of our code) --------------------------------- */
const BIN_R_MAX = 3.75, BIN_HALF_MAX = 41.5 / 2;      // 20.75
const BIN_CENTRE = BIN_HALF_MAX - BIN_R_MAX;          // 17.00
function binAt(z) {
  let half;
  if (z <= 0) half = 35.6 / 2;                        // 17.80
  else if (z < 0.8) half = 35.6 / 2 + z;              // 45deg chamfer
  else if (z < 2.6) half = 37.2 / 2;                  // 18.60 vertical
  else if (z < 4.75) half = 37.2 / 2 + (z - 2.6);     // 45deg chamfer
  else half = BIN_HALF_MAX;
  return { half, r: half - BIN_CENTRE };
}

/* ---- our socket, replicating src/core.js buildPiece + socketCutter ------- */
const TOP_CUTOFF = 0.4, D_MID = 2.15, D_BOT = 2.85, PLATE_H = 4.25;
const ZS = [-1, 0, 0.7, 2.5, PLATE_H, PLATE_H + 1.5];
const DS = [D_BOT, D_BOT, D_MID, D_MID, TOP_CUTOFF, TOP_CUTOFF];
function dAt(z) {
  if (z <= ZS[1]) return DS[1];
  for (let i = 1; i < ZS.length - 1; i++) {
    if (z <= ZS[i + 1]) {
      const t = (z - ZS[i]) / (ZS[i + 1] - ZS[i]);
      return DS[i] + t * (DS[i + 1] - DS[i]);
    }
  }
  return DS[DS.length - 1];
}
// current law: r = rTop - (d - ds_last)   -> centre = HALF - rTop - ds_last
// matched law: r = rTop - d               -> centre = HALF - rTop
function socketAt(z, rTop, matched) {
  const d = dAt(z);
  const half = HALF - d;
  const r = matched ? rTop - d : rTop - (d - TOP_CUTOFF);
  return { half, r: Math.max(0.3, Math.min(r, half - 0.01)) };
}

/* ---- outlines ----------------------------------------------------------- */
// faithful to roundedSquareRing: n points per corner, angles a0 + 90*k/n, k in [0,n)
function ring(half, r, n) {
  r = Math.max(0.3, Math.min(r, half - 0.01));
  const pts = [];
  for (const [ox, oy, a0] of [[half - r, half - r, 0], [-half + r, half - r, 90],
                              [-half + r, -half + r, 180], [half - r, -half + r, 270]])
    for (let k = 0; k < n; k++) {
      const a = (a0 + 90 * k / n) * Math.PI / 180;
      pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
    }
  return pts;
}

function distToSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const L = vx * vx + vy * vy;
  let t = L > 0 ? (wx * vx + wy * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = a[0] + t * vx - p[0], dy = a[1] + t * vy - p[1];
  return Math.hypot(dx, dy);
}
function minDist(p, poly) {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++)
    m = Math.min(m, distToSeg(p, poly[i], poly[(i + 1) % poly.length]));
  return m;
}

/* ---- measure ------------------------------------------------------------ */
// isCorner: a bin sample lies in a corner quadrant if both |x|,|y| exceed the centre
function measure(z, rTop, matched, segs) {
  const b = binAt(z), s = socketAt(z, rTop, matched);
  const bin = ring(b.half, b.r, 256);
  const sock = ring(s.half, s.r, segs);
  let flat = Infinity, corner = Infinity;
  for (const p of bin) {
    const d = minDist(p, sock);
    if (Math.abs(p[0]) > BIN_CENTRE && Math.abs(p[1]) > BIN_CENTRE) corner = Math.min(corner, d);
    else flat = Math.min(flat, d);
  }
  return { flat, corner, binHalf: b.half, binR: b.r, sockHalf: s.half, sockR: s.r,
           binCentre: b.half - b.r, sockCentre: s.half - s.r };
}

const ZS_TEST = [0.05, 0.4, 0.8, 1.5, 2.5, 2.6, 3.4, 4.2];
function report(title, rTop, matched, segs) {
  console.log('\n' + title);
  console.log('   z     bin(half/r)     socket(half/r)   centres      flat gap  corner gap');
  let worstC = Infinity, worstF = Infinity;
  for (const z of ZS_TEST) {
    const m = measure(z, rTop, matched, segs);
    worstC = Math.min(worstC, m.corner); worstF = Math.min(worstF, m.flat);
    console.log(
      `  ${z.toFixed(2).padStart(4)}  ` +
      `${m.binHalf.toFixed(2)}/${m.binR.toFixed(2)}`.padStart(13) + '  ' +
      `${m.sockHalf.toFixed(2)}/${m.sockR.toFixed(2)}`.padStart(14) + '  ' +
      `${m.binCentre.toFixed(2)}/${m.sockCentre.toFixed(2)}`.padStart(11) + '  ' +
      `${m.flat.toFixed(3)}`.padStart(9) + '  ' + `${m.corner.toFixed(3)}`.padStart(10));
  }
  console.log(`  worst:  flat ${worstF.toFixed(3)} mm   corner ${worstC.toFixed(3)} mm`);
  return { worstF, worstC };
}

console.log('Gridfinity spec bin foot vs Drawerforge baseplate socket');
console.log('bin corner-arc centre (spec): ' + BIN_CENTRE.toFixed(2) + ' mm');

const a = report('A. shipped: socketRadius 4.0, r = rTop - (d - 0.4), arcSegs 6', 4.0, false, 6);
const b = report('B. shipped law, ideal arcs (arcSegs 256) — isolates faceting', 4.0, false, 256);
const c = report('C. socketRadius 3.6, shipped law, arcSegs 6 — centres matched', 3.6, false, 6);
const d = report('D. socketRadius 3.6, ideal arcs — centres matched, no faceting', 3.6, false, 256);

console.log('\nsummary');
console.log(`  shipped            corner ${a.worstC.toFixed(3)}  flat ${a.worstF.toFixed(3)}  ratio ${(a.worstF / a.worstC).toFixed(1)}x`);
console.log(`  faceting costs     ${(b.worstC - a.worstC).toFixed(3)} mm at the corners`);
console.log(`  centres matched    corner ${c.worstC.toFixed(3)}  flat ${c.worstF.toFixed(3)}  ratio ${(c.worstF / c.worstC).toFixed(1)}x`);
console.log(`  matched, no facet  corner ${d.worstC.toFixed(3)}  flat ${d.worstF.toFixed(3)}`);

/* ---- a half-size bin's quarter foot --------------------------------------
 * A half-size bin stands on quarter feet: the spec foot on a 21 mm pitch, as Gridfinity
 * Rebuilt's half grid builds it. At every level of the profile it is 10.5 mm in from the
 * spec foot on each side, keeping the spec's corner radius there — 20.5 mm square at the
 * top, with its corner arcs on the same 17.00 centres as the whole foot's. Derived here
 * from the spec as the whole foot is, never from src/bins/bin.js.
 *
 * In a standard socket a quarter foot fills one corner. Its two outer sides and its outer
 * corner face the socket's walls and are measured like a whole foot's; its two inner
 * sides face the rest of the socket, which a neighbouring quarter fills or nothing does,
 * so they have nothing to measure against. Every one of its points must still be inside
 * the socket at every height, in each of the four corners. Sampled the way the whole foot
 * is above, so the two compare like for like. */
const QUARTER_IN = PITCH / 4;                          // 10.5
function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
// the quarter foot at z, in the corner of the socket that (sx, sy) points to
function quarterAt(z, sx, sy) {
  const b = binAt(z), h = b.half - QUARTER_IN;
  return ring(h, b.r, 256).map(([x, y]) => [x + sx * QUARTER_IN, y + sy * QUARTER_IN]);
}
function quarterReport() {
  console.log('\nE. a half-size bin\'s quarter foot in a corner of the shipped socket');
  console.log('   z    flat gap  corner gap  points outside');
  let worstF = Infinity, worstC = Infinity, out = 0;
  for (const z of ZS_TEST) {
    const s = socketAt(z, 4.0, false), sock = ring(s.half, s.r, 6);
    let flat = Infinity, corner = Infinity, outHere = 0;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      for (const p of quarterAt(z, sx, sy)) {
        if (!inside(p, sock)) outHere++;
        // how far out towards this corner's two walls, from the quarter's own centre
        const dx = sx * (p[0] - sx * QUARTER_IN), dy = sy * (p[1] - sy * QUARTER_IN);
        const arc = BIN_CENTRE - QUARTER_IN;           // 6.5: where its corner arcs start
        if (dx <= arc && dy <= arc) continue;          // faces the rest of the socket
        const d = minDist(p, sock);
        if (dx > arc && dy > arc) corner = Math.min(corner, d); else flat = Math.min(flat, d);
      }
    worstF = Math.min(worstF, flat); worstC = Math.min(worstC, corner); out += outHere;
    console.log(`  ${z.toFixed(2).padStart(4)}  ${flat.toFixed(3).padStart(8)}  ` +
                `${corner.toFixed(3).padStart(10)}  ${String(outHere).padStart(14)}`);
  }
  console.log(`  worst:  flat ${worstF.toFixed(3)} mm   corner ${worstC.toFixed(3)} mm   ` +
              `points outside the socket ${out}`);

  /* A foot presses on a wall only with its outer sides, so a bin half a cell across, alone
     in a socket, has nothing on its far side: it can slide until its inner side meets the
     socket's other wall. Said here so the page can say it; not a fault, and not gated. */
  let play = 0;
  for (let dx = 0; dx < PITCH; dx += 0.01) {
    const fits = [0.05, 0.8, 2.5, 4.2].every((z) => {
      const s = socketAt(z, 4.0, false), sock = ring(s.half, s.r, 6);
      // a 0.5 x 1 bin: two quarters down the left of the socket, slid right by dx
      return [-1, 1].every((sy) => quarterAt(z, -1, sy).every(([x, y]) => inside([x + dx, y], sock)));
    });
    if (!fits) break;
    play = dx;
  }
  console.log(`  a bin half a cell wide, alone in a socket, can slide ${play.toFixed(2)} mm across it`);
  return { worstF, worstC, out };
}
const e = quarterReport();
console.log(`  quarter foot       corner ${e.worstC.toFixed(3)}  flat ${e.worstF.toFixed(3)}` +
            `  (whole foot ${a.worstC.toFixed(3)} and ${a.worstF.toFixed(3)})`);

/* CI guard. Deliberately loose: the corner clearance being tighter than the flats is a
   known, documented deviation (docs/socket-clearance.md) and applying the fix should not
   fail the build. What must never happen is clearance going to zero — that is a socket a
   bin cannot enter. A quarter foot is held to the same, and must not be any tighter than
   a whole foot: its corners sit on the whole foot's arc centres, so it gets the same. */
if (!(a.worstC > 0.02) || !(a.worstF > 0.05)) {
  console.error(`\n  FAIL: a spec bin no longer fits the socket ` +
                `(corner ${a.worstC.toFixed(3)}, flat ${a.worstF.toFixed(3)} mm)`);
  process.exit(1);
}
if (!(e.worstC > 0.02) || !(e.worstF > 0.05) || e.out ||
    e.worstC < a.worstC - 1e-3 || e.worstF < a.worstF - 1e-3) {
  console.error(`\n  FAIL: a quarter foot no longer fits a corner of the socket as a whole foot does ` +
                `(corner ${e.worstC.toFixed(3)}, flat ${e.worstF.toFixed(3)} mm, ${e.out} points outside)`);
  process.exit(1);
}
console.log('\nspec bin fits the shipped socket, and so does a half-size bin\'s quarter foot');
