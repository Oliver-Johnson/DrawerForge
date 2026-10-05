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
  /* 21 since a bin can carry a lid and the sides its skirt sits on: position IS the format, so this
     number is deliberate and changing it changes what every link means. Update it on
     purpose or not at all.
     It went 17 -> 18 by APPENDING, which is the only safe direction — see the
     older-link case below, which is what makes appending safe rather than merely
     conventional. */
  const packed = packBin(bin({}));
  const fieldCount = packed.split('-').length;
  console.log(`  field count is stable                  ${fieldCount === 21 ? '21, correct' : fieldCount + ' — WRONG'}`);
  if (fieldCount !== 21) bad++;

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
      if (!(b.u >= 1 && b.v >= 1 && b.hUnits >= 1)) why = `footprint ${b.u}x${b.v}x${b.hUnits}`;
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
