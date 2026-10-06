#!/usr/bin/env node
/* A bin layout travels in the URL hash, so it must survive being packed and unpacked
 * byte for byte. It did not: the field separator was '.', wall thickness 1.2 split
 * into "1" and "2", every later field shifted, and a bin came back from a round trip
 * carrying dividers nobody asked for.
 *
 * The values that break this are the ones with decimals, so those are exactly what
 * this exercises. Usage: node test/hash-roundtrip.js
 */
'use strict';
const { packBin, unpackBin, packLayers, unpackLayers, BIN_DEFAULTS } = require('../src/bins/bin.js');

const bin = (o) => Object.assign({
  x: 0, y: 0, u: 1, v: 1, hUnits: 3, wall: 1.2, floorT: 1.2, divX: 0, divY: 0,
  solid: false, edges: { f: 1, b: 1, l: 1, r: 1 }, scoop: 0, label: 0,
}, o);

const CASES = [
  ['defaults, decimal wall and floor', bin({})],
  ['no dividers, must stay none', bin({ wall: 1.2, floorT: 1.2, divX: 0, divY: 0 })],
  ['dividers that are real', bin({ divX: 2, divY: 1 })],
  ['fractional edges', bin({ edges: { f: 0.66, b: 0.5, l: 0.25, r: 1 } })],
  ['open front tray', bin({ edges: { f: 0, b: 0, l: 0, r: 0 } })],
  ['scoop and label', bin({ scoop: 8, label: 12 })],
  ['solid block', bin({ solid: true })],
  ['awkward decimals', bin({ wall: 0.85, floorT: 2.35, scoop: 6.5, label: 10.5 })],
  ['placed away from the origin', bin({ x: 5, y: 7, u: 3, v: 2, hUnits: 12 })],
];

const KEYS = ['x', 'y', 'u', 'v', 'hUnits', 'wall', 'floorT', 'divX', 'divY',
              'solid', 'scoop', 'label'];
let bad = 0;

console.log('single bins');
for (const [name, b] of CASES) {
  const back = unpackBin(packBin(b));
  const diffs = [];
  for (const k of KEYS) if (back[k] !== b[k]) diffs.push(`${k}: ${b[k]} -> ${back[k]}`);
  for (const k of ['f', 'b', 'l', 'r'])
    if (back.edges[k] !== b.edges[k]) diffs.push(`edge ${k}: ${b.edges[k]} -> ${back.edges[k]}`);
  console.log(`  ${name.padEnd(36)}${diffs.length ? 'CORRUPTED: ' + diffs.join(', ') : 'intact'}`);
  if (diffs.length) bad++;
}

console.log('\nmulti-bin, multi-layer');
{
  const layers = [
    { bins: [bin({ x: 0, y: 0, u: 2, v: 2 }), bin({ x: 3, y: 0, u: 1, v: 4, divY: 2 })] },
    { bins: [bin({ x: 0, y: 0, u: 2, v: 2, scoop: 8 })] },
    { bins: [] },
  ];
  const back = unpackLayers(packLayers(layers));
  const shapeOk = back.length === layers.length &&
    back.every((L, i) => L.bins.length === layers[i].bins.length);
  console.log(`  layer and bin counts survive          ${shapeOk ? 'intact' : 'CORRUPTED'}`);
  if (!shapeOk) bad++;
  const deep = JSON.stringify(back) === JSON.stringify(layers.map(
    (L) => ({ bins: L.bins.map((b) => unpackBin(packBin(b))) })));
  console.log(`  every bin identical after a trip      ${deep ? 'intact' : 'CORRUPTED'}`);
  if (!deep) bad++;
}

console.log('\nseparators cannot appear inside a value');
{
  /* The guard used to throw, and the throw landed in the save, the share link, the
     hand-over and the README: saving stopped without a word. A value that would carry
     a separator is written so that it cannot, and packing never throws. */
  for (const [name, b, key, want] of [
    ['a negative wall is written as 0', bin({ wall: -0.5 }), 'wall', 0],
    ['a negative floor is written as 0', bin({ floorT: -1 }), 'floorT', 0],
    ['a tiny value is spelled out, not 1e-7', bin({ wall: 1e-7 }), 'wall', 1e-7],
  ]) {
    let packed = '', why = '';
    try { packed = packBin(b); } catch (e) { why = 'THREW: ' + e.message; }
    if (!why && packed.split('-').length !== 21) why = `shifted to ${packed.split('-').length} fields`;
    if (!why && /e/.test(packed)) why = `exponent form in ${packed}`;
    if (!why && unpackBin(packed)[key] !== want) why = `read back as ${unpackBin(packed)[key]}`;
    console.log(`  ${name.padEnd(38)} ${why ? 'FAILED — ' + why : 'packs'}`);
    if (why) bad++;
  }
  /* 21 for a bin with nothing in its feet, and 22 for one with holes: position IS the
     format, so these numbers are deliberate and changing them changes what every link
     means. Update them on purpose or not at all. A plain bin stays at 21 so that every
     link made before holes existed packs back to exactly the same text: written as a 0
     on every bin, the 22nd field rewrote old links the first time they were opened.
     It went 17 -> 18 by APPENDING, which is the only safe direction — see the
     older-link case below, which is what makes appending safe rather than merely
     conventional. */
  const packed = packBin(bin({}));
  const fieldCount = packed.split('-').length;
  const holedCount = packBin(bin({ magnets: true })).split('-').length;
  const countsOk = fieldCount === 21 && holedCount === 22;
  console.log(`  field count is stable                  ${countsOk ? '21, and 22 with holes, correct' : fieldCount + ' and ' + holedCount + ' — WRONG'}`);
  if (!countsOk) bad++;

  /* A link written before the field existed. Nobody has one yet, but the reason to
     handle it is the same reason to append rather than insert: the day the format grows
     again, this is the case that says whether it grew safely. A bin nobody has marked
     is a bin nobody has printed, so the absent field has to read as false — not as
     NaN, and not as true, which would hide it from the plates it belongs on. */
  const short = packed.split('-').slice(0, 17).join('-');
  const old = unpackBin(short);
  const okOld = old.done === false && old.divRemovable === false &&
                old.lid === false && old.u === 1 && old.hUnits === 3;
  console.log(`  a link from before the field still reads ${okOld ? 'as unprinted' : 'WRONG: ' + JSON.stringify(old.done)}`);
  if (!okOld) bad++;

  // and the flag itself has to survive the trip, or marking a bin is lost on sharing
  const round = unpackBin(packBin(bin({ done: true })));
  console.log(`  a printed mark survives the trip       ${round.done === true ? 'intact' : 'LOST'}`);
  if (round.done !== true) bad++;

  /* Removable dividers change what the bin IS — rails and a loose plate rather than a
     wall across it — so a link that dropped the flag would hand someone a different
     part while looking identical. */
  const rem = unpackBin(packBin(bin({ divX: 1, divRemovable: true })));
  console.log(`  removable dividers survive the trip   ${rem.divRemovable === true ? 'intact' : 'LOST'}`);
  if (rem.divRemovable !== true) bad++;

  /* A lid and, separately, WHICH sides its skirt sits on. A lid that came back with
     four skirts when three were asked for would not fit the bin it was made for. */
  const lid = unpackBin(packBin(bin({ lid: true, lidSides: { f: false, b: true, l: true, r: true } })));
  const sidesOk = lid.lid === true && lid.lidSides.f === false &&
                  lid.lidSides.b && lid.lidSides.l && lid.lidSides.r;
  console.log(`  a lid and its chosen sides survive    ${sidesOk ? 'intact' : 'LOST: ' + JSON.stringify(lid.lidSides)}`);
  if (!sidesOk) bad++;
}

/* Holes in the feet ride in field 22, a bitmask: 1 magnets, 2 screws, 4 every cell
   rather than the corners. 8 to 64 are kept for finger slots. Every link and saved
   drawer from before the field has 21, and has to come back as the bin it always was:
   no holes. So does anything in the field that is not a whole number it could hold,
   since a link is typed into as often as it is copied. */
console.log('\nholes in the feet');
{
  const holes = (x) => ['magnets', 'screws', 'holesEvery'].filter((k) => x[k]).join('+') || 'none';
  const packed = packBin(bin({}));
  const old = unpackBin(packed.split('-').slice(0, 21).join('-'));
  const oldOk = old.magnets === false && old.screws === false && old.holesEvery === false &&
                old.lid === false && old.lidSides.f === true;
  console.log(`  a 21-field link reads as no holes      ${oldOk ? 'intact' : 'WRONG: ' + holes(old)}`);
  if (!oldOk) bad++;
  /* And packs back to the same text. A link opened is written straight back to the
     address, the local save and any saved drawer, so one that came back a field longer
     was a changed layout: the next load said the link had replaced it. */
  const before = [packBin(bin({})), packBin(bin({ lid: true, scoop: 10, edges: { f: 0.5, b: 1, l: 1, r: 1 } }))];
  const rewritten = before.filter((p) => packBin(unpackBin(p)) !== p || p.split('-').length !== 21);
  console.log(`  a link from before holes packs as it was ${rewritten.length ? 'REWRITTEN: ' + rewritten.join(', ') : 'byte for byte'}`);
  if (rewritten.length) bad++;

  // every combination the three boxes can make, each on its own and each with the rest
  const fails = [];
  for (let n = 0; n < 8; n++) {
    const want = { magnets: !!(n & 1), screws: !!(n & 2), holesEvery: !!(n & 4) };
    const p = packBin(bin(want)), back = unpackBin(p);
    const f = p.split('-');
    if ((n ? f.length !== 22 || f[21] !== String(n) : f.length !== 21) ||
        ['magnets', 'screws', 'holesEvery'].some((k) => back[k] !== want[k]))
      fails.push(`${holes(want)} came back ${holes(back)} from ${p.split('-')[21]}`);
  }
  console.log(`  each hole setting survives the trip    ${fails.length ? 'LOST: ' + fails.join('; ') : '8 combinations, intact'}`);
  if (fails.length) bad++;

  // finger slots will set the higher bits; until then they are read past, not misread
  const slot = unpackBin(packed.split('-').slice(0, 21).concat(['9']).join('-'));
  const slotOk = slot.magnets === true && slot.screws === false && slot.holesEvery === false;
  console.log(`  a slot bit is read past, not misread   ${slotOk ? 'intact' : 'WRONG: ' + holes(slot)}`);
  if (!slotOk) bad++;

  const junk = ['NaN', '3.5', '-1', '1e9', '128', 'abc', '', 'Infinity', '7e0.5'];
  const misread = junk.filter((j) => {
    const b = unpackBin(packed.split('-').slice(0, 21).concat([j]).join('-'));
    return b.magnets || b.screws || b.holesEvery;
  });
  console.log(`  junk in the field reads as no holes    ` +
              (misread.length ? 'MISREAD: ' + misread.join(', ') : `${junk.length} values, none read as holes`));
  if (misread.length) bad++;
}

/* What the label shelf carries rides in field 23: 0 nothing, 1 the note raised on it,
   and 2 kept for a label slot, which reads as 1 until there is one. It is written only
   for a bin that has it set, so every link and saved drawer from before it has 21 or 22
   fields, reads as nothing on the shelf and packs back to the same text. One with the
   note raised and no holes writes its 22nd field as a 0, which reads as no holes. The
   note itself is not in the bin's fields: it rides in bnotes, as it always has. */
console.log('\nwhat the label shelf carries');
{
  const plain = packBin(bin({ label: 12 })), holed = packBin(bin({ label: 12, magnets: true }));
  const olds = [plain, holed, packBin(bin({ label: 12, labelMode: 0 }))];
  const rewritten = olds.filter((p) => {
    const b = unpackBin(p);
    return b.labelMode !== 0 || packBin(b) !== p || p.split('-').length > 22;
  });
  console.log(`  a link from before reads as nothing on it ${rewritten.length ? 'WRONG: ' + rewritten.join(', ') : 'and packs as it was, byte for byte'}`);
  if (rewritten.length) bad++;

  const raised = packBin(bin({ label: 12, labelMode: 1 })), rf = raised.split('-'), rb = unpackBin(raised);
  const raisedOk = rf.length === 23 && rf[21] === '0' && rf[22] === '1' && rb.labelMode === 1 &&
    !rb.magnets && !rb.screws && !rb.holesEvery && packBin(rb) === raised;
  console.log(`  the note raised survives the trip      ${raisedOk ? 'intact, 23 fields' : 'LOST: ' + raised}`);
  if (!raisedOk) bad++;
  const both = packBin(bin({ label: 12, labelMode: 1, magnets: true, screws: true })), bb = unpackBin(both);
  const bothOk = both.split('-').length === 23 && bb.labelMode === 1 && bb.magnets && bb.screws && !bb.holesEvery;
  console.log(`  and beside holes in the feet           ${bothOk ? 'intact' : 'LOST: ' + both}`);
  if (!bothOk) bad++;

  // anything else in the field is held to 0 to 1: the slot's 2 as the note, junk as nothing
  const at = (j) => unpackBin(rf.slice(0, 22).concat([j]).join('-')).labelMode;
  const WANT = [['2', 1], ['9', 1], ['1e9', 1], ['0.6', 1], ['0.4', 0], ['NaN', 0], ['abc', 0],
                ['Infinity', 0], ['', 0]];
  const misread = WANT.filter(([j, want]) => at(j) !== want).map(([j, want]) => `${j || '(empty)'} as ${at(j)}, not ${want}`);
  console.log(`  anything else is held to 0 or 1        ` +
              (misread.length ? 'MISREAD: ' + misread.join(', ') : `${WANT.length} values, each where it belongs`));
  if (misread.length) bad++;
}

/* Holes across the floor ride in fields 24 and 25: the preset, 1 to 4 (AA, AAA, 18650,
   hex bits), and the depth, 0 for worked out from the item. Both are written only for a
   bin that has holes, with the 22nd and 23rd written as 0 where they are not set, so every
   link and saved drawer from before has 21 to 23 fields, reads as no holes, and packs back
   to the same text. Unpacking holds the preset to the presets there are and the depth to
   0 to H. */
console.log('\nholes across the floor');
{
  const olds = [packBin(bin({ label: 12 })), packBin(bin({ magnets: true })),
                packBin(bin({ label: 12, labelMode: 1 })), packBin(bin({ label: 12, labelMode: 1, screws: true })),
                // a depth with no preset says nothing, and is not written
                packBin(bin({ insert: 0, insertDepth: 12 }))];
  const rewritten = olds.filter((p) => {
    const b = unpackBin(p);
    return b.insert !== 0 || b.insertDepth !== 0 || packBin(b) !== p || p.split('-').length > 23;
  });
  console.log(`  a link from before reads as no holes      ${rewritten.length ? 'WRONG: ' + rewritten.join(', ') : 'and packs as it was, byte for byte'}`);
  if (rewritten.length) bad++;

  const plain = packBin(bin({ insert: 4 })), pf = plain.split('-'), pb = unpackBin(plain);
  const plainOk = pf.length === 25 && pf[21] === '0' && pf[22] === '0' && pf[23] === '4' && pf[24] === '0' &&
    pb.insert === 4 && pb.insertDepth === 0 && pb.labelMode === 0 && !pb.magnets && !pb.screws &&
    packBin(pb) === plain;
  console.log(`  holes for hex bits survive the trip       ${plainOk ? 'intact, 25 fields, the two before as 0' : 'LOST: ' + plain}`);
  if (!plainOk) bad++;
  const all = packBin(bin({ hUnits: 6, label: 12, labelMode: 1, magnets: true, screws: true, insert: 1, insertDepth: 12.5 }));
  const ab = unpackBin(all);
  const allOk = all.split('-').length === 25 && ab.insert === 1 && ab.insertDepth === 12.5 && ab.labelMode === 1 &&
    ab.magnets && ab.screws && packBin(ab) === all;
  console.log(`  beside a raised note and holes in the feet ${allOk ? 'intact, depth and all' : 'LOST: ' + all}`);
  if (!allOk) bad++;

  /* the preset held to 0 to 4, and the depth to 0 to H: 21 mm on these 3-unit bins. No
     field can hold a minus sign, which is the separator. */
  const at = (pre, dep) => unpackBin(pf.slice(0, 23).concat([pre, dep]).join('-'));
  const WANT = [['9', '0', 4, 0], ['1e9', '0', 4, 0], ['4.6', '0', 4, 0], ['2.4', '0', 2, 0], ['0.4', '0', 0, 0],
                ['NaN', '0', 0, 0], ['abc', '0', 0, 0], ['', '0', 0, 0], ['Infinity', '0', 0, 0],
                ['3', '1e9', 3, 21], ['3', '30', 3, 21], ['3', 'NaN', 3, 0], ['3', '', 3, 0], ['3', 'x', 3, 0],
                ['3', '7.5', 3, 7.5]];
  const misread = WANT.filter(([p, d, wp, wd]) => at(p, d).insert !== wp || at(p, d).insertDepth !== wd)
    .map(([p, d, wp, wd]) => `${p || '(empty)'}-${d || '(empty)'} as ${at(p, d).insert}, ${at(p, d).insertDepth}, not ${wp}, ${wd}`);
  console.log(`  anything else is held to what there is    ` +
              (misread.length ? 'MISREAD: ' + misread.join('; ') : `${WANT.length} pairs, each where it belongs`));
  if (misread.length) bad++;
}

/* Half-size bins ride in the same four fields as every bin's size and position, counted
   in cells as always and now allowed to end in .5, so the format did not grow. What a
   link from before held was whole, and a whole number reads as it always did. A whole
   bin stays on whole cells, so one on a half step is put back on the grid the way a
   fractional position always was. Anything between halves, which no page writes, is
   read the way a page from before half sizes read it, rounded to whole cells; so is a
   bin with a carve mask, which only whole-cell bins carry, mask and all. */
console.log('\nhalf-size bins');
{
  const KEYS4 = ['x', 'y', 'u', 'v'];
  const read = (b) => KEYS4.map((k) => `${k} ${b[k]}`).join(', ');
  for (const [name, b, want] of [
    ['half a cell, at the origin', bin({ u: 0.5, v: 0.5 }), [0, 0, 0.5, 0.5]],
    ['1.5 x 0.5 on a half step both ways', bin({ x: 2.5, y: 0.5, u: 1.5, v: 0.5 }), [2.5, 0.5, 1.5, 0.5]],
    ['1 x 2.5 on a half step across', bin({ x: 3.5, y: 4, u: 1, v: 2.5, divX: 1, scoop: 6 }), [3.5, 4, 1, 2.5]],
    ['a whole bin on a half step is rounded', bin({ x: 2.5, y: 0.5, u: 2, v: 1 }), [3, 1, 2, 1]],
  ]) {
    const back = unpackBin(packBin(b));
    const ok = KEYS4.every((k, i) => back[k] === want[i]) && back.hUnits === b.hUnits &&
               back.divX === b.divX && back.scoop === b.scoop;
    console.log(`  ${name.padEnd(38)} ${ok ? 'intact' : 'WRONG: ' + read(back)}`);
    if (!ok) bad++;
  }

  /* Typed by hand: sizes and positions between halves. No page writes one, so each is
     read as a page from before half sizes read it, rounded to a whole cell and at least
     one, and the bin is what it was there. Snapped to the nearest half instead, 1.4 came
     back a cell and a half where it had been one, and a 1.3 grew into the bin beside it. */
  const tail = '3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0';
  for (const [name, link, want] of [
    ['0.25 is a cell, as before half sizes', `0.25-0.75-0.25-0.25-${tail}`, [0, 1, 1, 1]],
    ['a size under a quarter is still a cell', `0-0-0.1-0-${tail}`, [0, 0, 1, 1]],
    ['1.3 and 1.2 are 1', `1.3-1.2-1.3-1.2-${tail}`, [1, 1, 1, 1]],
    ['1.4 x 1.4 is a 1 x 1, as on main', '0-0-1.4-1.4-3', [0, 0, 1, 1]],
    ['a whole bin is not moved by a quarter', `1.3-1.75-2-1-${tail}`, [1, 2, 2, 1]],
    ['a half keeps a hand-typed place whole', `0.3-1.6-1.5-0.5-${tail}`, [0, 2, 1.5, 0.5]],
  ]) {
    const back = unpackBin(link);
    const ok = KEYS4.every((k, i) => back[k] === want[i]);
    console.log(`  ${name.padEnd(38)} ${ok ? 'as before' : 'WRONG: ' + read(back)}`);
    if (!ok) bad++;
  }
  /* Two bins side by side as a page from before read them: the 1.3 is one cell, so the
     bin at column 2 is beside it, not under it. Read as 1.5 they shared half a cell. */
  {
    const two = unpackLayers('0-0-1.3-1-3_1-0-1-1-3')[0].bins.map((b) => [b.x, b.y, b.u, b.v]);
    const ok = JSON.stringify(two) === '[[0,0,1,1],[1,0,1,1]]';
    console.log(`  ${'1.3 beside a 1 x 1 does not overlap it'.padEnd(38)} ${ok ? 'side by side' : 'WRONG: ' + JSON.stringify(two)}`);
    if (!ok) bad++;
  }

  /* A mask is never written for a half-size bin, so a bin that carries one came from a
     page that counted whole cells, or was typed over one: it is read as that page read
     it, every size and place rounded to whole cells, and keeps its shape. The 6-cell mask
     is what a 2 x 3 carries, and 1.5 x 2.5 is 2 x 3 there; 2.5 x 2 is 3 x 2. */
  const masked = unpackBin('0-0-1.5-2.5-3-1.2-1.2-0-0-0-1-1-1-1-0-0-110111');
  const wide = unpackBin('0-0-2.5-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-110111');
  const written = packBin(bin({ u: 1.5, v: 1, cells: [[0, 0]] })).split('-')[16];
  const maskOk = masked.u === 2 && masked.v === 3 && (masked.cells || []).length === 5 &&
                 wide.u === 3 && wide.v === 2 && (wide.cells || []).length === 5 && written === '0';
  console.log(`  ${'a bin with a mask is read as before'.padEnd(38)} ` + (maskOk
    ? 'whole cells, shape kept; none written for a half'
    : `WRONG: read ${read(masked)} ${JSON.stringify(masked.cells)} and ${read(wide)} ` +
      `${JSON.stringify(wide.cells)}, wrote ${written}`));
  if (!maskOk) bad++;

  /* Holes in the feet are not built on a half-size bin yet, but what was asked for is
     kept: the bin is the same bin, and the day they are built the link already says. */
  const holed = packBin(bin({ u: 0.5, v: 1.5, magnets: true, screws: true, holesEvery: true }));
  const hb = unpackBin(holed);
  const holesOk = holed.split('-')[21] === '7' && hb.magnets && hb.screws && hb.holesEvery;
  console.log(`  ${'its hole settings survive the trip'.padEnd(38)} ${holesOk ? 'intact' : 'LOST from ' + holed}`);
  if (!holesOk) bad++;

  /* No field of its own: a plain half-size bin is 21 fields like any plain bin, and one
     asking for holes 22, like any holed bin (the holed one above). */
  const count = packBin(bin({ x: 0.5, y: 1.5, u: 2.5, v: 0.5 })).split('-').length;
  const holedCount = holed.split('-').length;
  const countOk = count === 21 && holedCount === 22;
  console.log(`  ${'the field count does not grow'.padEnd(38)} ` +
              (countOk ? '21, and 22 with holes, correct' : `${count} and ${holedCount} — WRONG`));
  if (!countOk) bad++;
}

/* A number that is not one. Nothing on the page is known to make a NaN, but one used to
   be written as 0, and 0 is a real value for most fields: it came back as a bin with no
   wall, no floor or an open side, where a field that says nothing should read as its
   default, the way a missing one does. */
console.log('\na value that is not a number comes back as the default');
{
  for (const [name, b, read, want] of [
    ['a NaN wall', bin({ wall: NaN }), (x) => x.wall, BIN_DEFAULTS.wall],
    ['a NaN floor', bin({ floorT: NaN }), (x) => x.floorT, BIN_DEFAULTS.floorT],
    ['a NaN height', bin({ hUnits: NaN }), (x) => x.hUnits, BIN_DEFAULTS.hUnits],
    ['a NaN front edge', bin({ edges: { f: NaN, b: 0.5, l: 1, r: 1 } }),
      (x) => [x.edges.f, x.edges.b].join(' '), '1 0.5'],
    ['an infinite wall', bin({ wall: Infinity }), (x) => x.wall, BIN_DEFAULTS.wall],
    ['a floor of minus infinity', bin({ floorT: -Infinity }), (x) => x.floorT, BIN_DEFAULTS.floorT],
  ]) {
    let why = '';
    try {
      const packed = packBin(b);
      if (packed.split('-').length !== 21) why = `shifted to ${packed.split('-').length} fields`;
      else if (read(unpackBin(packed)) !== want) why = `read back as ${read(unpackBin(packed))}, not ${want}`;
    } catch (e) { why = 'THREW: ' + e.message; }
    console.log(`  ${name.padEnd(38)} ${why ? 'FAILED — ' + why : 'default'}`);
    if (why) bad++;
  }
}

/* A hash is in the address bar, so it gets hand-edited, truncated by a chat client and
   pasted back short. None of that may throw, and none of it may produce a bin the
   geometry cannot build — a white screen over a typo loses the whole layout, while a
   bin that falls back to its defaults loses one field. */
console.log('\nmalformed hashes fall back instead of throwing');
{
  const G = require('../src/core.js');
  const { buildBin } = require('../src/bins/bin.js');
  const JUNK = [
    ['empty string', ''],
    ['not a bin at all', 'hello world'],
    ['truncated after three fields', '0-0-2'],
    ['a field that is not a number', '0-0-two-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0'],
    ['more fields than the format has', '0-0-2-2-3-1.2-1.2-0-0-0-1-1-1-1-2-8-12-0'],
    ['negative footprint', '0-0--2--2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0'],
    ['a mask that does not fit its footprint', '0-0-2-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-111111111'],
  ];
  for (const [name, s] of JUNK) {
    let why = '';
    try {
      const b = unpackBin(s);
      // half a cell is the smallest footprint, since half-size bins
      if (!(b.u >= 0.5 && b.v >= 0.5 && b.hUnits >= 1)) why = `footprint ${b.u}x${b.v}x${b.hUnits}`;
      else if (!isFinite(b.wall) || !isFinite(b.floorT)) why = 'wall or floor is NaN';
      else {
        const r = buildBin(G, { u: b.u, v: b.v, hUnits: b.hUnits, wall: b.wall,
                                floorT: b.floorT, divX: b.divX, divY: b.divY,
                                solid: b.solid, edges: b.edges, scoop: b.scoop,
                                label: b.label, cells: b.cells });
        if (!r.polys.length) why = 'built an empty mesh';
      }
    } catch (e) { why = 'THREW: ' + e.message; }
    console.log(`  ${name.padEnd(42)}${why ? 'FAILED — ' + why : 'loads'}`);
    if (why) bad++;
  }
  let threw = false;
  try { unpackLayers('~~junk_more junk~'); } catch (e) { threw = true; }
  console.log(`  ${'a hash of nothing but separators'.padEnd(42)}${threw ? 'FAILED — threw' : 'loads'}`);
  if (threw) bad++;
}

/* A link can ask for anything, and the geometry builds what it is asked for: a
   million dividers froze the tab for half a minute, a footprint of 1e9 cells crashed
   it, a height of 1e308 printed as "Infinity mm", a y of 0.5 threw in the map, and a
   wall height the edge menu does not offer turned into NaN on the next edit. Each case
   here is a link someone could paste; what comes back must be buildable, whole where
   it counts something, and inside the range the page can show. */
console.log('\nwhat a link asks for is held to what can be built');
{
  const { LINK_MAX } = require('../src/bins/bin.js');
  const HUGE = ['1e308', '1e9', '1000000'];
  const CASES = [
    ['a million dividers across', '0-0-1-1-3-1.2-1.2-1000000-1000000',
      (b) => b.divX >= 1 && b.divX <= 31 && b.divY <= 31],
    ['half a divider', '0-0-1-1-3-1.2-1.2-2.5-0.4',
      (b) => Number.isInteger(b.divX) && Number.isInteger(b.divY)],
    ['a footprint of 1e9 cells', '0-0-1e9-1e9-3',
      (b) => b.u === LINK_MAX.cells && b.v === LINK_MAX.cells],
    ['a height of 1e308', '0-0-1-1-1e308', (b) => b.hUnits === LINK_MAX.hUnits],
    ['a fractional position, then a stray dash', '0.5--3-1-1-3',
      (b) => Number.isInteger(b.x) && Number.isInteger(b.y) && b.x >= 0 && b.y >= 0],
    ['an enormous position', '1e308-1e308-1-1-3',
      (b) => b.x === LINK_MAX.cells && b.y === LINK_MAX.cells],
    ['walls and floor of every size', `0-0-1-1-3-${HUGE[0]}-${HUGE[0]}`,
      (b) => b.wall <= LINK_MAX.wall && b.floorT <= b.hUnits * 7],
    ['a scoop and label past the bin', `0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-${HUGE[1]}-${HUGE[2]}`,
      (b) => b.scoop <= 21 && b.label <= 42],
    ['wall heights the menu does not offer', '0-0-1-1-3-1.2-1.2-0-0-0-0.3-0.6-7-0.1',
      (b) => b.edges.f === 0.25 && b.edges.b === 0.66 && b.edges.l === 1 && b.edges.r === 0],
  ];
  const G = require('../src/core.js');
  const { buildBin } = require('../src/bins/bin.js');
  for (const [name, s, ok] of CASES) {
    let why = '';
    try {
      const b = unpackBin(s);
      const nums = ['x', 'y', 'u', 'v', 'hUnits', 'wall', 'floorT', 'divX', 'divY', 'scoop', 'label'];
      const odd = nums.filter((k) => !(isFinite(b[k]) && b[k] >= 0));
      if (odd.length) why = 'out of range: ' + odd.join(', ');
      else if (!ok(b)) why = JSON.stringify(b).slice(0, 160);
      else {
        const t = Date.now();
        const r = buildBin(G, Object.assign({}, b, { edges: b.edges }));
        if (!r.polys.length) why = 'built an empty mesh';
        else if (Date.now() - t > 8000) why = `took ${Date.now() - t} ms to build`;
      }
    } catch (e) { why = 'THREW: ' + e.message; }
    console.log(`  ${name.padEnd(42)}${why ? 'FAILED — ' + why : 'held'}`);
    if (why) bad++;
  }
}

/* Carved footprints ride in the last field as an occupancy bitmap. A rectangle
   must stay a rectangle through the trip — the failure that matters here is a
   full bin coming back carved, which is what would put phantom holes in a shape
   the user never touched. */
console.log('\ncarved footprints');
{
  const shapes = [
    ['L, one corner gone', 3, 3, [[2, 2]]],
    ['U, two reflex corners', 3, 3, [[1, 2]]],
    ['staircase', 3, 3, [[1, 2], [2, 2], [2, 1]]],
    ['single cell left of a 4x4', 4, 4, (() => {
      const d = []; for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++)
        if (x || y) d.push([x, y]); return d;
    })()],
  ];
  for (const [name, u, v, drop] of shapes) {
    const cells = [];
    for (let x = 0; x < u; x++) for (let y = 0; y < v; y++)
      if (!drop.some((d) => d[0] === x && d[1] === y)) cells.push([x, y]);
    const b = bin({ u, v, cells });
    const back = unpackBin(packBin(b));
    const key = (c) => c.map((p) => p.join(',')).sort().join(' ');
    const ok = back.u === u && back.v === v && back.cells && key(back.cells) === key(cells);
    console.log(`  ${name.padEnd(36)}${ok ? 'intact' : 'CORRUPTED: ' + JSON.stringify(back.cells)}`);
    if (!ok) bad++;
  }
  // and the inverse: a full rectangle must never come back as a carved shape
  const plain = unpackBin(packBin(bin({ u: 3, v: 2 })));
  const plainOk = !plain.cells;
  console.log(`  ${'a full rectangle stays uncarved'.padEnd(36)}${plainOk ? 'intact' : 'CORRUPTED: gained a mask'}`);
  if (!plainOk) bad++;
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nlayouts survive the hash intact');
process.exit(bad ? 1 : 0);
