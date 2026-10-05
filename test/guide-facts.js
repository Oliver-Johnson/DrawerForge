#!/usr/bin/env node
/* Do the guides still tell the truth?
 *
 * The prose quotes real numbers — the 42 mm pitch, the 41.5 mm footprint, the 4.25 mm
 * baseplate, the 7 mm unit, how many cells fit a 306 mm drawer. Those came from the
 * code once and then stopped being connected to it. Nothing has ever checked them, so
 * a change to SPEC or to the layout arithmetic would leave three pages quietly lying,
 * and prose is the one part of this project a test has never read.
 *
 * This does not check writing. It checks arithmetic that appears in writing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../src/core.js');
const { SPEC, BIN_DEFAULTS, lipHeight } = require('../src/bins/bin.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/&nbsp;/g, ' ');
/* Prose as a reader sees it: no markup, no line wrapping. A sentence that runs across
   two source lines is one sentence to a person, so it has to be one string here too. */
const text = (p) => read(p).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const PAGES = ['guide/index.html', 'guide/split/index.html', 'guide/drawer-sizes/index.html'];
const prose = PAGES.map((p) => [p, read(p)]);

let bad = 0;
const check = (what, want, found) => {
  const ok = found === true || (found !== false && Math.abs(found - want) < 1e-9);
  console.log(`  ${what.padEnd(56)}${ok ? 'ok' : `WRONG — code says ${want}`}`);
  if (!ok) bad++;
};
const saysIn = (page, re) => prose.find(([p]) => p === page)[1].match(re);
const R2 = (n) => Math.round(n * 100) / 100;
const saysAnywhere = (re) => prose.some(([, s]) => re.test(s));

console.log('constants the prose quotes, against the code');
check(`pitch is ${SPEC.pitch} mm`, SPEC.pitch, saysAnywhere(/\b42 mm\b/) && SPEC.pitch === 42);
check(`bin footprint is ${(SPEC.half * 2).toFixed(1)} mm`, 41.5,
      saysAnywhere(/\b41\.5 mm\b/) && SPEC.half * 2 === 41.5);
check(`height unit is ${SPEC.unitH} mm`, 7, saysAnywhere(/\b7 mm\b/) && SPEC.unitH === 7);
check(`baseplate is ${G.DEFAULTS.plateHeight} mm`, 4.25,
      saysAnywhere(/\b4\.25 mm\b/) && G.DEFAULTS.plateHeight === 4.25);
check('the gap between neighbouring bins is 0.5 mm', 0.5,
      Number(((SPEC.pitch - SPEC.half * 2)).toFixed(3)));

/* The tables in drawer-sizes.html are pure arithmetic: floor(size / pitch) and the
   remainder. Every row is checkable, and a wrong row is the kind of thing someone
   plans a purchase around. */
console.log('\nevery row of the metric and inch tables');
{
  const html = read('guide/drawer-sizes/index.html');
  const rows = [...html.matchAll(/<tr><td>([\d.]+)(?:")?\s*(mm)?<\/td><td>([\d.]+) mm<\/td><td>(\d+)<\/td><td>([\d.]+) mm<\/td><\/tr>/g)];
  const metric = [...html.matchAll(/<tr><td>(\d+) mm<\/td><td>(\d+)<\/td><td>(\d+) mm<\/td><td>(\d+) mm<\/td><\/tr>/g)];
  let n = 0;
  for (const m of metric) {
    const size = +m[1], cells = +m[2], grid = +m[3], left = +m[4];
    const wantCells = Math.floor(size / SPEC.pitch);
    const wantGrid = wantCells * SPEC.pitch;
    const ok = cells === wantCells && grid === wantGrid && left === size - wantGrid;
    if (!ok) {
      console.log(`  ${size} mm: says ${cells} cells / ${grid} mm / ${left} left — ` +
                  `should be ${wantCells} / ${wantGrid} / ${size - wantGrid}`);
      bad++;
    }
    n++;
  }
  for (const m of rows) {
    const inches = +m[1], mm = +m[3], cells = +m[4], left = +m[5];
    const wantMm = Math.round(inches * 25.4 * 10) / 10;
    const wantCells = Math.floor(wantMm / SPEC.pitch);
    const wantLeft = Math.round((wantMm - wantCells * SPEC.pitch) * 10) / 10;
    const ok = Math.abs(mm - wantMm) < 0.05 && cells === wantCells &&
               Math.abs(left - wantLeft) < 0.05;
    if (!ok) {
      console.log(`  ${inches}": says ${mm} mm / ${cells} cells / ${left} left — ` +
                  `should be ${wantMm} / ${wantCells} / ${wantLeft}`);
      bad++;
    }
    n++;
  }
  console.log(`  ${n} rows checked${bad ? '' : ', every one correct'}`);
  if (n < 15) { console.log('  TOO FEW ROWS MATCHED — the parser has drifted from the markup'); bad++; }
}

/* Worked examples in the prose. These are the sentences a reader trusts most, because
   they are specific. */
console.log('\nworked examples');
{
  const g = read('guide/index.html');
  // "An 84 mm drawer gives 79.75 mm above the plate"
  const m = read('guide/drawer-sizes/index.html')
    .match(/An (\d+)&?n?b?s?p?;? ?mm drawer gives ([\d.]+) mm above the plate/);
  if (m) check(`${m[1]} mm drawer leaves ${m[2]} mm above a plate`,
               +m[1] - G.DEFAULTS.plateHeight, +m[2]);
  else {
    console.log('  the "NN mm drawer gives NN.NN mm above the plate" example is gone ' +
                'or reworded — reword this check with it, do not delete it');
    bad++;
  }

  /* Every claim below MUST be found. A regex that stops matching because someone
     reworded a sentence would otherwise turn this file into a check that silently
     passes on prose it never read -- which is the exact failure this project has
     shipped several times. Not finding the sentence is itself a failure. */
  const words = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const split = read('guide/split/index.html');
  const bed = split.match(/A (\d+) mm bed takes (\w+) cells, because (\w+) would need (\d+) mm/);
  if (!bed) {
    console.log('  the "a NNN mm bed takes N cells" example is gone or reworded — ' +
                'reword this check with it, do not delete it');
    bad++;
  } else {
    check(`a ${bed[1]} mm bed takes ${bed[2]} cells`,
          Math.floor(+bed[1] / SPEC.pitch), words[bed[2]] ?? -1);
    check(`and ${bed[3]} cells would need ${bed[4]} mm`,
          (words[bed[3]] ?? -1) * SPEC.pitch, +bed[4]);
  }
}

/* The printer table on the split page: a bed, and the largest piece it takes. The cell
   counts are floor(bed / pitch) and nothing else, so every row can be recomputed. What
   this cannot check is whether the bed is the printer's — the row that said the Bambu
   A1 had a 220 mm bed was arithmetically perfect and wrong about the printer. */
console.log('\nthe printer table');
{
  const html = read('guide/split/index.html');
  const rows = [...html.matchAll(/<tr><td>([^<]+)<\/td><td>(\d+) × (\d+)<\/td><td>(\d+) × (\d+)<\/td><td>(\d+) × (\d+) mm<\/td><\/tr>/g)];
  for (const m of rows) {
    const [w, d, nx, ny, sw, sd] = m.slice(2).map(Number);
    const want = [Math.floor(w / SPEC.pitch), Math.floor(d / SPEC.pitch)];
    const ok = nx === want[0] && ny === want[1] &&
               sw === want[0] * SPEC.pitch && sd === want[1] * SPEC.pitch;
    if (!ok) {
      console.log(`  ${m[1]}: says ${nx} × ${ny} (${sw} × ${sd} mm) on ${w} × ${d} — ` +
                  `should be ${want[0]} × ${want[1]} (${want[0] * SPEC.pitch} × ${want[1] * SPEC.pitch} mm)`);
      bad++;
    }
  }
  console.log(`  ${rows.length} rows checked`);
  if (rows.length < 5) { console.log('  TOO FEW ROWS MATCHED — the parser has drifted'); bad++; }
}

/* Claims the prose makes outright, each of which was wrong once and shipped that way.
   A sentence that states its own rule has to produce its own number: an example that
   contradicts the rule beside it is worse than no example, because the reader trusts
   the specific half. */
console.log('\nclaims the prose states outright');
{
  // "A 306 × 380 mm drawer wants a 294 × 378 mm plate — 1.75 times the area a 256 mm bed
  // can take in one piece."  Said "more than twice" for a while; it is 1.75.
  const s = text('guide/split/index.html');
  const m = s.match(/A (\d+) × (\d+) mm drawer wants a (\d+) × (\d+) mm plate — ([\d.]+) times the area a (\d+) mm bed can take/);
  if (!m) {
    console.log('  the "drawer wants a plate N times the area" comparison is gone or ' +
                'reworded — reword this check with it, do not delete it');
    bad++;
  } else {
    const [dw, dd, pw, pd, ratio, bed] = m.slice(1).map(Number);
    const grid = (mm) => Math.floor(mm / SPEC.pitch) * SPEC.pitch;
    check(`a ${dw} mm drawer grids to ${grid(dw)} mm`, grid(dw), pw);
    check(`a ${dd} mm drawer grids to ${grid(dd)} mm`, grid(dd), pd);
    check(`that is ${((pw * pd) / grid(bed) ** 2).toFixed(2)}× a ${bed} mm bed`,
          Math.round((pw * pd) / grid(bed) ** 2 * 100) / 100,
          Math.round(ratio * 100) / 100);
  }

  /* "a 200 mm drawer leaves 32 mm, a 500 mm drawer leaves 38 mm" — the examples that
     stop a reader believing a large remainder means they measured wrong. */
  {
    const said = [...text('guide/index.html')
      .matchAll(/a (\d+) mm drawer leaves (\d+) mm/g)];
    if (!said.length) {
      console.log('  the "a NNN mm drawer leaves NN mm" examples are gone or reworded — ' +
                  'reword this check with them, do not delete it');
      bad++;
    }
    for (const d of said)
      check(`a ${d[1]} mm drawer leaves ${+d[1] % SPEC.pitch} mm over`,
            +d[1] % SPEC.pitch, +d[2]);
  }

  /* The bin footprint rule. n × 42 − 0.5, not n × 41.5 — the two agree only at n = 1,
     and the page used to state the second rule and then quote a number from the first. */
  const g = text('guide/index.html');
  const f = g.match(/A bin is ([\d.]+) mm smaller than the cells it sits in, however many it spans: n × (\d+) − ([\d.]+), so ([\d.]+) mm for one cell and ([\d.]+) mm for six/);
  if (!f) {
    console.log('  the bin-footprint rule is gone or reworded — reword this check with ' +
                'it, do not delete it');
    bad++;
  } else {
    const [gap, pitch, gap2, one, six] = f.slice(1).map(Number);
    const want = (n) => n * SPEC.pitch - (SPEC.pitch - SPEC.half * 2);
    check('the stated gap is the spec gap', SPEC.pitch - SPEC.half * 2, gap);
    check('the rule quotes the same gap twice', gap, gap2);
    check('the stated pitch is the spec pitch', SPEC.pitch, pitch);
    check(`the rule gives ${want(1)} mm for one cell`, want(1), one);
    check(`the rule gives ${want(6)} mm for six`, want(6), six);
  }
}

/* The bin height table, and the worked example that sends a reader to look a row up.
   It listed 1, 2, 3, 4, 6 while the example told you to read off 5. */
console.log('\nthe bin height table');
{
  const html = read('guide/index.html');
  const base = SPEC.footH + BIN_DEFAULTS.floorT;   // foot plus floor, before anything fits
  const rows = new Map();
  for (const m of html.matchAll(/<tr><td>(\d+)<\/td><td>([\d.]+) mm<\/td><td>([\d.]+) mm<\/td><\/tr>/g)) {
    const units = +m[1], total = +m[2], usable = +m[3];
    rows.set(units, total);
    const wantTotal = units * SPEC.unitH;
    const wantUsable = Math.round((wantTotal - base) * 100) / 100;
    if (total !== wantTotal || Math.abs(usable - wantUsable) > 0.005) {
      console.log(`  ${units} units: says ${total} mm / ${usable} usable — ` +
                  `should be ${wantTotal} / ${wantUsable}`);
      bad++;
    }
  }
  console.log(`  ${rows.size} rows checked`);
  if (rows.size < 6) { console.log('  TOO FEW ROWS MATCHED — the parser has drifted'); bad++; }

  const words = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const g = text('guide/index.html');
  const ex = g.match(/An (\d+) mm drawer gives ([\d.]+) mm above the plate, which works out at (\w+) units in total — ([\d + ]+?) across two layers, or ([\d + ]+?) across three/);
  if (!ex) {
    console.log('  the "NN mm drawer works out at N units" example is gone or reworded — ' +
                'reword this check with it, do not delete it');
    bad++;
  } else {
    const drawer = +ex[1], above = +ex[2], total = words[ex[3]] ?? -1;
    const lip = lipHeight(BIN_DEFAULTS.lipMin);
    check(`${drawer} mm leaves ${drawer - G.DEFAULTS.plateHeight} mm above the plate`,
          drawer - G.DEFAULTS.plateHeight, above);
    check(`which is ${Math.floor((above - lip) / SPEC.unitH)} units of ${SPEC.unitH} mm`,
          Math.floor((above - lip) / SPEC.unitH), total);
    /* Every layer split has to add up, and every number in one has to be a row of the
       table above it — that is the whole point of quoting a split here. */
    for (const split of [ex[4], ex[5]]) {
      const parts = split.split('+').map((n) => +n.trim());
      check(`${parts.join(' + ')} is ${total} units`, total, parts.reduce((a, b) => a + b, 0));
      const missing = parts.filter((n) => !rows.has(n));
      check(`${parts.join(' + ')} are all rows of the table`, 0, missing.length);
    }
  }
}

/* Nothing in the prose may describe a feature that no longer exists. Low-profile bins
   and low lips were removed; the guides mentioned both. */
console.log('\nno prose describing features that were removed');
for (const [p, s] of prose) {
  const ghosts = [/low[- ]profile/i, /low lip/i, /shallow foot/i].filter((re) => re.test(s));
  console.log(`  ${p.padEnd(56)}${ghosts.length ? 'MENTIONS A REMOVED FEATURE' : 'clean'}`);
  if (ghosts.length) bad++;
}

/* The joint diagrams are generated from core.js's own parameters, so their captions
   quote real dimensions. A hand-drawn diagram is a claim about the geometry that
   nothing checks; this asserts the generated one still agrees with the part. */
console.log('\njoint diagrams');
{
  const J = require('../tools/joints.js');
  const html = read('guide/index.html');
  const figs = (html.match(/class="jointfig"/g) || []).length;
  check(`${J.KINDS.length} diagrams on the guide`, J.KINDS.length, figs);
  if (html.includes('__JOINTS__')) { console.log('  the marker was left unfilled'); bad++; }

  const D = G.DEFAULTS;
  const want = {
    dovetail: [String(D.tab.wr), String(D.tab.wt), String(D.tab.dp)],
    puzzle: [String(D.puzzle.neckW), String(D.puzzle.lobeR * 2)],
    bowtie: [String(D.key.len)],
    snap: [String(D.key.len)],
  };
  /* A key BRIDGES the seam -- half in each piece -- so the extent it spans ACROSS the
     seam is its `len`, and the extent along the seam is its end width. Drawn straight
     from keyOutline, which lays a key out along x, all four lay flat along the seam
     holding nothing together. The captions were all correct while the pictures were
     wrong, which is why checking the numbers in the words is not enough: a diagram
     makes a claim of its own.

     Stated as len-vs-width rather than taller-vs-wider on purpose. The h-clip is 3.6 mm
     across its flanges and 3.8 mm along them, so "the bridging span is the longer one"
     is simply untrue of it, and a shape rule would have called the correct picture
     wrong. Naming the dimension holds for any aspect ratio. */
  const span = (d) => {
    const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
    const ext = (i) => Math.max(...pts.map((p) => p[i])) - Math.min(...pts.map((p) => p[i]));
    return { alongSeam: ext(0), acrossSeam: ext(1) };
  };
  for (const kind of ['bowtie', 'puzzlekey', 'snap', 'hclip']) {
    const prm = kind === 'hclip' ? G.hclipPrm(G.DEFAULTS.hclip) : G.DEFAULTS.key;
    const m = J.diagram(kind, G).svg.match(/class="j-part" d="([^"]+)"/);
    if (!m) { console.log(`  ${kind.padEnd(56)}no loose part drawn`); bad++; continue; }
    const { alongSeam, acrossSeam } = span(m[1]);
    const ok = Math.abs(acrossSeam - prm.len) < 0.05;
    console.log(`  ${(kind + ' bridges the seam, not along it').padEnd(56)}` +
      (ok ? `ok (spans ${acrossSeam.toFixed(1)} mm across)`
          : `WRONG WAY — spans ${acrossSeam.toFixed(1)} across and ` +
            `${alongSeam.toFixed(1)} along; its length is ${R2(prm.len)}`));
    if (!ok) bad++;
  }

  const made = J.all(G);
  for (const [kind, nums] of Object.entries(want)) {
    const cap = made[kind].caption;
    const missing = nums.filter((n) => !cap.includes(n));
    const shown = html.includes(cap);
    console.log(`  ${kind.padEnd(54)}` +
      (missing.length ? `caption lost ${missing.join(', ')}`
       : shown ? 'ok' : 'not on the page'));
    if (missing.length || !shown) bad++;
  }
}

console.log(bad ? `\n${bad} claim(s) in the guides are WRONG` : '\nthe guides still tell the truth');
process.exit(bad ? 1 : 0);
