#!/usr/bin/env node
/* Does a bin seat in the lip of the bin below it, all the way up?
 *
 * This used to assert a 3x3 matrix of base styles against each other, because a short
 * foot could not enter a full lip and that was the one pairing which looks right on
 * screen and is not. There is one base now, so the matrix would be a matrix of one.
 * What survives is the part that was never about the styles: the lip's opening and the
 * foot that goes into it are two profiles maintained in different places — the lip is
 * an inset from the bin's outline, the foot comes from the published spec — and
 * nothing else checks that they agree at every height rather than at the step
 * heights.
 *
 * bin-audit samples the three corners of the lip table. This walks the whole lip in
 * 0.01 mm and descends the upper bin's real outer profile into it, body included,
 * because the body at full width is what would foul a lip the foot cleared.
 *
 * Both slopes are 45 degrees, so the answer is not merely "positive": the clearance is
 * the spec's 0.25 mm at every single height, and a change that tilts either profile
 * shows up here as a clearance that varies even while it stays positive.
 */
'use strict';
const { SPEC, LIP_TABLE, lipHeight, BIN_DEFAULTS } = require('../src/bins/bin.js');

const lipMin = BIN_DEFAULTS.lipMin !== undefined ? BIN_DEFAULTS.lipMin : 0.55;
const LIP_H = lipHeight(lipMin);
const CLEARANCE = 0.25;              // the spec's, per side

/* Inner half-width of the lip at height z above the top of the bin below. */
function lipInnerAt(z) {
  const steps = LIP_TABLE.concat([[LIP_H, lipMin]]);
  if (z > LIP_H) return Infinity;                // above the lip: nothing in the way
  for (let i = 0; i < steps.length - 1; i++) {
    const [z0, t0] = steps[i], [z1, t1] = steps[i + 1];
    if (z >= z0 && z <= z1) {
      const t = z1 > z0 ? t0 + (t1 - t0) * (z - z0) / (z1 - z0) : t0;
      return SPEC.half - t;
    }
  }
  return SPEC.half - steps[steps.length - 1][1];
}

/* Outer half-width of a bin at height z above its own base: the foot while the foot
   lasts, then the full body. */
function outerHalfAt(z) {
  const prof = SPEC.prof;
  if (z >= prof[prof.length - 1][0]) return SPEC.half;
  for (let i = 0; i < prof.length - 1; i++) {
    const [z0, h0] = prof[i], [z1, h1] = prof[i + 1];
    if (z >= z0 && z <= z1) return z1 > z0 ? h0 + (h1 - h0) * (z - z0) / (z1 - z0) : h0;
  }
  return prof[0][1];
}

let bad = 0;
console.log(`a bin descending into the lip below it (lip ${LIP_H.toFixed(2)} mm tall)`);
console.log('      z    lip inner   bin outer   clearance');

let worst = Infinity, worstAt = 0, widest = -Infinity;
for (let z = 0; z <= LIP_H + 1e-9; z += 0.01) {
  const clr = lipInnerAt(z) - outerHalfAt(z);
  if (clr < worst) { worst = clr; worstAt = z; }
  if (clr > widest) widest = clr;
}
for (const z of [0, 0.8, 2.6, LIP_H]) {
  const inner = lipInnerAt(z), outer = outerHalfAt(z);
  const clr = inner - outer;
  console.log(`   ${z.toFixed(2).padStart(4)}   ${inner.toFixed(2).padStart(9)}   ` +
              `${outer.toFixed(2).padStart(9)}   ${clr.toFixed(3).padStart(9)}` +
              `${Math.abs(clr - CLEARANCE) < 1e-6 ? '  ok' : '  OFF SPEC'}`);
}

const seats = worst > -1e-6;
console.log(`\n   tightest ${worst.toFixed(3)} mm at z ${worstAt.toFixed(2)} — ` +
            `${seats ? 'seats' : 'FOULS — it would perch on top'}`);
if (!seats) bad++;

const uniform = Math.abs(worst - CLEARANCE) < 1e-6 && Math.abs(widest - CLEARANCE) < 1e-6;
console.log(`   clearance across the whole lip: ${worst.toFixed(3)} to ${widest.toFixed(3)} mm — ` +
            `${uniform ? `uniform at the spec's ${CLEARANCE}` : 'NOT UNIFORM, the profiles disagree'}`);
if (!uniform) bad++;

/* How far the bin above sinks into the lip before its foot rests on it. Both slopes are
 * 45 degrees with the spec's 0.25 mm between them, so it comes down 0.25 mm past H, the
 * top of the bin below, and seats there with its flat underside at H - 0.25. That is
 * found here by lowering the real foot into the real lip until they touch, not taken
 * from the 0.25, so it moves if either profile does. A plain label shelf is not lowered
 * at all: its top is at H, so the bin above stands on it 0.25 mm short of that seat. */
let seatDrop = 0;
{
  const fits = (d) => {
    for (let z = 0; z <= LIP_H + 1e-9; z += 0.001) if (lipInnerAt(z) - outerHalfAt(z + d) < -1e-9) return false;
    return true;
  };
  let lo = 0, hi = 2;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
  seatDrop = lo;
}
console.log(`   the bin above seats ${seatDrop.toFixed(3)} mm below H, where its foot meets the lip`);

/* A note raised on the label shelf stands in the way of the bin above, if anything does.
 * That bin's flat underside comes down to H - 0.25 (seatDrop, above), and covers every
 * letter the lip's opening lets it reach: the opening is 2.70 mm in from the outline,
 * the underside 2.95, so all but a 0.25 mm band at the back, which its chamfer clears
 * by more. So the shelf with letters on it drops to H - 1.0 and the letters stop at
 * H - 0.4, 0.15 mm under it. This used to say they were 0.4 mm clear, measuring from H,
 * where the bin above does not stop.
 *
 * 0.15 mm is positive but tight: less than one 0.2 mm layer, so a lip printed a touch
 * wide or a foot a touch narrow can take it up. What then happens is the letters
 * carrying the bin above at most 0.15 mm high, where a plain shelf carries it 0.25 mm
 * high every time, so a raised note never stacks worse than the shelf it replaced.
 *
 * Measured off the real mesh, not the numbers that built it: every vertex inside the
 * lip's opening, which is all the bin above can reach into, and inside the walls, has
 * to be at H - 0.4 or below, and the highest has to be AT H - 0.4, or the letters were
 * not built at all and this proved nothing. */
console.log('\nnotes raised on the label shelf, under the bin above');
{
  const G = require('../src/core.js');
  const { buildBin } = require('../src/bins/bin.js');
  const CLEAR = 0.4;
  const NOTES = [
    ['1x1x3, one line', { u: 1, v: 1, hUnits: 3, label: 12, note: 'M3 screws' }],
    ['1x1x3, two lines', { u: 1, v: 1, hUnits: 3, label: 12, note: 'Resistors 10k to 100k' }],
    ['2x1x2, the lowest shelf', { u: 2, v: 1, hUnits: 2, label: 12, note: 'Drill bits 1-6 mm' }],
    ['1x1x3, 0.4 mm walls', { u: 1, v: 1, hUnits: 3, wall: 0.4, label: 12, note: 'M3 screws' }],
    ['1x1x3, 3 mm walls', { u: 1, v: 1, hUnits: 3, wall: 3, label: 12, note: 'M3 screws' }],
    ['0.5x1x3, half a cell wide', { u: 0.5, v: 1, hUnits: 3, label: 12, note: 'M2' }],
    ['3x2x4, holes in every foot', { u: 3, v: 2, hUnits: 4, label: 20, note: 'Fuses 5A, 10A',
                                     magnets: true, screws: true, holesEvery: true }],
  ];
  for (const [name, cfg] of NOTES) {
    const c = Object.assign({ wall: BIN_DEFAULTS.wall, labelMode: 1 }, cfg);
    const H = c.hUnits * SPEC.unitH;
    const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half, hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half;
    /* Strictly inside the rounded outline inset by the lip's opening at the top, 2.70, or
       by the wall where that is thicker. The corner arcs share the 17.00 mm centre. */
    const t = Math.max(LIP_TABLE[0][1], c.wall) + 0.01, r = SPEC.r - t;
    const inside = ([x, y]) => {
      const ax = Math.abs(x), ay = Math.abs(y);
      if (ax >= hw - t || ay >= hd - t) return false;
      const dx = Math.max(0, ax - (hw - SPEC.r)), dy = Math.max(0, ay - (hd - SPEC.r));
      return Math.hypot(dx, dy) < r;
    };
    let top = -Infinity;
    for (const p of buildBin(G, c).polys)
      for (const v of p.verts) if (inside(v)) top = Math.max(top, v[2]);
    const under = H - seatDrop - top;
    const ok = Math.abs(top - (H - CLEAR)) < 1e-9 && under > 0.1;
    console.log(`   ${name.padEnd(28)} highest ${(top - H).toFixed(3).padStart(7)} mm from H, ` +
                `${under.toFixed(3)} mm under the bin above   ` +
                (ok ? 'clear of it'
                  : top > H - CLEAR || under <= 0.1 ? 'IN THE WAY of the bin above' : 'NO LETTERS BUILT'));
    if (!ok) bad++;
  }
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\na bin seats in the bin below it');
process.exit(bad ? 1 : 0);
