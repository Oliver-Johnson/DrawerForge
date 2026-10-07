/* The bins page against input it did not expect: values past their limits, links that
 * put two bins on one cell, carved shapes meeting features built for rectangles, a
 * browser with no WebGL, and a long session of edits. Each case is a finding from a
 * review, and each failed on the code it was written against.
 */
'use strict';
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
const JSZip = require('../../vendor/jszip.min.js');

const settle = (page, ms = 400) => page.waitForTimeout(ms);

/* A layout arriving by link, on a page with nothing saved behind it. Console errors
   count as failures here as they do in bins.spec.js. */
async function openAt(page, hash) {
  await H.forgetSaved(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !H.blankFavicon(m)) errors.push(m.text()); });
  await page.goto(H.BINS_URL + (hash ? '#' + hash : ''));
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await settle(page, 300);
  return errors;
}
const absCells = (page) => page.evaluate(() => B().flatMap((b) =>
  binCells(b).map(([dx, dy]) => `${b.x + dx},${b.y + dy}`)));
const errText = (page) => page.$$eval('#warnings .w.err', (els) => els.map((e) => e.textContent));

/* ---------- #5, #11: wall and floor limits -------------------------------- */

test('a negative wall or floor is held at zero, and no wall at all still builds', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'floorT', -0.5);
  await H.setField(page, 'wall', -1);
  const b = await page.evaluate(() => ({ wall: B()[0].wall, floorT: B()[0].floorT,
                                         bad: checkManifold(geomFor(B()[0]).polys).bad }));
  expect(b.floorT, 'a negative floor reached the bin and the link').toBe(0);
  expect(b.wall).toBe(0);
  // the field says what is being used once you are out of it
  expect(await page.inputValue('#floorT')).toBe('0');
  expect(await page.inputValue('#wall')).toBe('0');
  // a wall of 0 put the cavity on the outer skin; the engine builds its thinnest instead
  expect(b.bad, 'open edges in a bin with no wall').toBe(0);
  expect((await errText(page)).join(' ')).toContain('built at 0.4 mm');
  await settle(page, 600);            // past the save debounce, which used to throw
  expect(errors).toEqual([]);
});

test('a wall typed past the cap builds at the cap, and a thick one is noted', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'wall', 100);
  const r = await page.evaluate(() => {
    const b = B()[0], gm = geomFor(b);
    return { wall: b.wall, max: +document.getElementById('wall').max, W: gm.meta.W, vol: gm.vol };
  });
  expect(r.wall).toBe(r.max);
  expect(r.W, 'a 100 mm wall built inside out, wider than the bin').toBeCloseTo(41.5, 3);
  expect(r.vol).toBeGreaterThan(0);
  await expect(page.locator('#totals')).not.toContainText('≈ -');

  /* 2.7 is where the lip used to open: 256 edges used four times. */
  await H.setField(page, 'wall', 2.7);
  expect(await page.evaluate(() => checkManifold(geomFor(B()[0]).polys).bad)).toBe(0);
  await expect(page.locator('#warnings')).not.toContainText('mm walls');
  await H.setField(page, 'wall', 3);
  await expect(page.locator('#warnings')).toContainText('thicker than the 2.7 mm');
  expect(await errText(page), 'a thick wall prints fine; it is a note, not a fault').toEqual([]);
  expect(errors).toEqual([]);
});

/* ---------- #4: limits and slow paths -------------------------------------- */

test('a drawer typed hundreds of cells wide is capped, and says so', async ({ page }) => {
  test.setTimeout(60_000);            // it used to freeze for longer than this
  const errors = await openAt(page, '');
  await H.setField(page, 'drawerW', 21000);
  await H.setField(page, 'drawerD', 21000);
  await settle(page);
  const r = await page.evaluate(() => ({ g: grid(), w: state.drawerW, d: state.drawerD }));
  // 2000 mm, the largest drawer a link carries, is 47 cells
  expect([r.g.nx, r.g.ny, r.w, r.d]).toEqual([47, 47, 2000, 2000]);
  await expect(page.locator('#warnings')).toContainText('21000 × 21000 mm drawer is bigger than the 2000 mm');

  // the cell fields reach the same cap, with the same message
  await page.goto('about:blank');
  await openAt(page, '');
  await H.setField(page, 'gridX', 500);
  await settle(page);
  expect((await page.evaluate(() => grid())).nx).toBe(47);
  await expect(page.locator('#warnings')).toContainText('bigger than the 2000 mm');
  expect(await page.inputValue('#gridX'), 'the cell field shows the grid in use').toBe('47');
  expect(errors).toEqual([]);
});

test('the stack check reads each layer once, not once per cell', async ({ page }) => {
  const errors = await openAt(page, 'w=1260&d=1260&bl=0-0-1-1-2~0-0-1-1-2~0-0-1-1-2~0-0-1-1-2~0-0-1-1-2');
  const r = await page.evaluate(() => {
    let n = 0;
    const real = occupancyOf;
    window.occupancyOf = (k) => { n++; return real(k); };
    try { stackHeight(); } finally { window.occupancyOf = real; }
    return { n, layers: layers.length, cells: grid().nx * grid().ny };
  });
  expect(r.cells).toBe(900);
  expect(r.n, `${r.n} occupancy builds for one stack check`).toBeLessThanOrEqual(r.layers);
  expect(errors).toEqual([]);
});

test('typed values are rounded and held to the limits a link is held to', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [1, 0]);
  await H.setField(page, 'divX', 2.6);
  expect(await page.evaluate(() => B()[0].divX), 'rounded, not truncated').toBe(3);
  await H.setField(page, 'divX', 500);
  await H.setField(page, 'divY', -3);
  await H.setField(page, 'u', 80);
  await H.setField(page, 'hUnits', 5000);
  const b = await page.evaluate(() => ({ divX: B()[0].divX, divY: B()[0].divY,
                                         hUnits: B()[0].hUnits, u: B()[0].u }));
  /* As many dividers as leave each compartment a 1.2 mm wall wide: 81.1 mm inside a
     2x1 makes 67 of them, less one. */
  expect(b.divX).toBe(66);
  expect(b.divY).toBe(0);
  expect(b.hUnits).toBe(285);
  expect(b.u, 'refused by the drawer, not held to 50').toBe(2);
  expect(await page.inputValue('#divX')).toBe('66');

  // the floor and the scoop go up to the bin's height, the label shelf to its depth
  await H.setField(page, 'hUnits', 3);
  await H.setField(page, 'floorT', 500);
  await H.setField(page, 'scoop', 500);
  await H.setField(page, 'label', 500);
  const f = await page.evaluate(() => ({ floorT: B()[0].floorT, scoop: B()[0].scoop, label: B()[0].label }));
  expect(f).toEqual({ floorT: 21, scoop: 21, label: 42 });
  expect(await page.inputValue('#label')).toBe('42');
  expect(errors).toEqual([]);
});

test('a floor that fills the bin leaves no loose divider plates to print', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [1, 0]);
  await H.setField(page, 'divX', 1);
  await page.locator('#divRemovable').check();
  await settle(page);
  expect(await page.evaluate(() => dividerParts().length)).toBe(1);
  await H.setField(page, 'floorT', 21);
  const r = await page.evaluate(() => ({ plates: dividerParts().map((d) => d.meta.tall),
                                         bad: checkManifold(geomFor(B()[0]).polys).bad }));
  expect(r.plates, 'a plate of negative height, inside out').toEqual([]);
  expect(r.bad).toBe(0);
  await page.locator('#openExport').click();
  await expect(page.locator('#exFiles [data-ex="stl"]')).toHaveCount(1);
  await expect(page.locator('#exFiles [data-ex="divider"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

/* Each removable divider is a slot between two rails, and closer than a slot and a rail
   apart a neighbour's rail stands in the slot and takes from its clearance: the fields
   allowed 31 on a 1x1, and at 11 a plate went in with 0.208 mm of clearance where 0.25
   was asked for, at 12 not at all. Held to a slot and a rail apart, every slot keeps the
   whole clearance, and 10 fit. */
test('removable dividers are held to as many as leave every slot room for a plate', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'divX', 1);
  await page.locator('#divRemovable').check();
  await settle(page);
  const most = () => page.evaluate(() => +document.getElementById('divX').max);
  const plates = () => page.evaluate(() => dividerParts().reduce((n, d) => n + d.qty, 0));
  /* 39.1 mm inside a 1x1, and a slot and a rail take 3.3 mm at the usual 1.6 mm plate
     and 0.25 mm clearance: 11 spaces, so 10 dividers. Fixed, one wall each, 31. */
  expect(await most()).toBe(10);
  await H.setField(page, 'divX', 50);
  expect(await page.evaluate(() => B()[0].divX)).toBe(10);
  expect(await page.inputValue('#divX')).toBe('10');
  expect(await plates()).toBe(10);
  // the limit moves with the plate and the clearance: 2.5 mm a divider, and 3.8
  await H.setField(page, 'divT', 0.8);
  expect(await most()).toBe(14);
  await H.setField(page, 'divT', 1.6);
  await H.setField(page, 'divClr', 0.5);
  expect(await most()).toBe(9);
  /* The bin still asks for 10, and is built with 9: a setting of the drawer's does not
     rewrite a bin, and the plates are the ones it is built with. */
  expect(await page.evaluate(() => B()[0].divX)).toBe(10);
  expect(await plates()).toBe(9);
  expect((await page.$$eval('#warnings .w', (els) => els.map((e) => e.textContent))).join(' '))
    .toContain('is built with 9 removable dividers across, not the 10 it asks for');
  await page.locator('#divRemovable').uncheck();
  await settle(page);
  expect(await most()).toBe(31);
  /* A thin plate with little clearance comes down further than its slots need: spaced
     only for them, 17 on a 1x1 with a 0.4 mm wall, the end plates' corners stood in the
     cavity's rounded corners. 12 leave them clear. */
  await page.locator('#divRemovable').check();
  await H.setField(page, 'wall', 0.4);
  await H.setField(page, 'divT', 0.8);
  await H.setField(page, 'divClr', 0.1);
  expect(await most()).toBe(12);
  expect(errors).toEqual([]);
});

test('a link asking for more removable dividers than fit opens unchanged, and Checks says so once', async ({ page }) => {
  const asks = (x) => `${x}-0-1-1-3-1.2-1.2-30-0-0-1-1-1-1-0-0-0-0-1-0-15`;
  const bl = [0, 1, 2].map(asks).join('_') + '_3-0-1-1-3-1.2-1.2-4-0-0-1-1-1-1-0-0-0-0-1-0-15';
  const errors = await openAt(page, 'bl=' + bl);
  await settle(page, 600);
  const link = () => page.evaluate(() => location.hash);
  const before = await link();
  expect(before).toContain('bl=' + bl);
  expect(await page.evaluate(() => B().map((b) => b.divX))).toEqual([30, 30, 30, 4]);
  // built with 10 each, and as many plates
  expect(await page.evaluate(() => dividerParts().reduce((n, d) => n + d.qty, 0))).toBe(34);
  const notes = async () => (await page.$$eval('#warnings .w', (els) => els.map((e) => e.textContent)))
    .filter((t) => t.includes('removable dividers'));
  expect(await notes()).toEqual(['3 bins are built with fewer removable dividers than they ask for, as no more ' +
    'leave every slot room for a 1.6 mm plate at 0.25 mm clearance: the 1×1 on layer 1 at column 1 row 1, ' +
    'the 1×1 on layer 1 at column 2 row 1 and the 1×1 on layer 1 at column 3 row 1.']);

  // choosing it, or editing something else about it, is not asking for fewer
  await H.clickCell(page, 0, 0);
  await settle(page, 600);
  expect(await page.inputValue('#divX')).toBe('30');
  expect(await page.evaluate(() => +document.getElementById('divX').max)).toBe(10);
  expect(await link()).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem('drawerforge:bins:v1'))).toContain('bl=' + bl);
  await H.setField(page, 'note', 'screws');
  expect(await page.evaluate(() => B()[0].divX)).toBe(30);
  // a number other than the one it asks for, typed in, is held to the limit
  await H.setField(page, 'divX', 50);
  expect(await page.evaluate(() => B()[0].divX)).toBe(10);
  expect(await notes()).toEqual(['2 bins are built with fewer removable dividers than they ask for, as no more ' +
    'leave every slot room for a 1.6 mm plate at 0.25 mm clearance: the 1×1 on layer 1 at column 2 row 1 ' +
    'and the 1×1 on layer 1 at column 3 row 1.']);
  expect(errors).toEqual([]);
});

/* Half a cell across leaves 18.1 mm inside at a 1.2 mm wall: room for 4 slots and their
   rails at the usual plate, where one wall a divider allows 14. A cell and a half, 17. */
test('half-size bins are held to the removable dividers that fit them, and Checks names them', async ({ page }) => {
  const asks = (x, u, n) => `${x}-0-${u}-1-3-1.2-1.2-${n}-0-0-1-1-1-1-0-0-0-0-1-0-15`;
  const bl = asks(0, 0.5, 10) + '_' + asks(1, 1.5, 30);
  const errors = await openAt(page, 'bl=' + bl);
  await settle(page, 600);
  const link = () => page.evaluate(() => location.hash);
  const before = await link();
  expect(before).toContain('bl=' + bl);
  expect(await page.evaluate(() => B().map((b) => [b.u, b.divX]))).toEqual([[0.5, 10], [1.5, 30]]);
  expect(await page.evaluate(() => dividerParts().reduce((n, d) => n + d.qty, 0))).toBe(4 + 17);
  expect(await page.evaluate(() => B().map((b) => checkManifold(geomFor(b).polys).bad))).toEqual([0, 0]);
  const notes = async () => (await page.$$eval('#warnings .w', (els) => els.map((e) => e.textContent)))
    .filter((t) => t.includes('removable dividers'));
  expect(await notes()).toEqual(['2 bins are built with fewer removable dividers than they ask for, as no more ' +
    'leave every slot room for a 1.6 mm plate at 0.25 mm clearance: the 0.5×1 on layer 1 at column 1 row 1 ' +
    'and the 1.5×1 on layer 1 at column 2 row 1.']);

  // the half-cell-wide one, chosen, still asks for 10 and offers no more than 4
  await H.clickCell(page, -0.25, 0);
  await settle(page, 600);
  expect(await page.inputValue('#u')).toBe('0.5');
  expect(await page.inputValue('#divX')).toBe('10');
  expect(await page.evaluate(() => +document.getElementById('divX').max)).toBe(4);
  expect(await link()).toBe(before);
  await H.setField(page, 'divX', 50);
  expect(await page.evaluate(() => B()[0].divX)).toBe(4);
  expect(await page.inputValue('#divX')).toBe('4');
  expect(await notes()).toEqual(['Layer 1, the 1.5×1 bin at column 2 row 1: is built with 17 removable dividers ' +
    'across, not the 30 it asks for, as no more leave every slot room for a 1.6 mm plate at 0.25 mm clearance.']);
  expect(errors).toEqual([]);
});

/* One removable divider has no neighbour, so it needs only its slot and a rail either
   side. Held to a neighbour's spacing as well, a half-cell bin with a 3 mm wall at a 5 mm
   plate and 1 mm clearance was built with none, its field allowed none, and Checks said
   none fit. */
test('a bin with room for one removable divider and no more is built with one', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-0.5-1-3-3-1.2-1-0-0-1-1-1-1-0-0-0-0-1-0-15&bdt=5&bdc=1');
  await settle(page, 600);
  expect(await page.evaluate(() => [state.divT, state.divClr, B()[0].divX])).toEqual([5, 1, 1]);
  expect(await page.evaluate(() => dividerParts().reduce((n, d) => n + d.qty, 0))).toBe(1);
  expect(await page.evaluate(() => checkManifold(geomFor(B()[0]).polys).bad)).toBe(0);
  expect((await page.$$eval('#warnings .w', (els) => els.map((e) => e.textContent)))
    .filter((t) => t.includes('removable dividers'))).toEqual([]);
  await H.clickCell(page, -0.25, 0);
  await settle(page, 600);
  expect(await page.inputValue('#divX')).toBe('1');
  expect(await page.evaluate(() => +document.getElementById('divX').max)).toBe(1);
  expect(errors).toEqual([]);
});

/* The one divider there is room for must leave room for the rails the other way too, which
   reach a rail's depth and the clearance out from the end walls. Given only room for its
   own rails, a half-cell bin with a 5 mm wall, one across and two along at a 5 mm plate
   and 1 mm clearance, had the rails along standing 0.45 mm into each side of the one
   across's 1 mm clearance. */
test('one removable divider is not built where the rails the other way would stand in its clearance', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-0.5-1-3-5-1.2-1-2-0-1-1-1-1-0-0-0-0-1-0-15&bdt=5&bdc=1');
  await settle(page, 600);
  expect(await page.evaluate(() => [B()[0].divX, B()[0].divY, builtDivs(B()[0])])).toEqual([1, 2, { divX: 0, divY: 2 }]);
  expect(await page.evaluate(() => dividerParts().reduce((n, d) => n + d.qty, 0))).toBe(2);
  // and Checks gives that as the reason, not that no slot has room
  expect((await page.$$eval('#warnings .w', (els) => els.map((e) => e.textContent)))
    .filter((t) => t.includes('removable dividers'))).toEqual(['Layer 1, the 0.5×1 bin at column 1 row 1: is built with ' +
    'no removable dividers across, not the 1 it asks for, as even one would leave too little room beside its slot ' +
    'for the rails of dividers the other way, with a 5 mm plate at 1 mm clearance.']);
  expect(errors).toEqual([]);
});

/* Kept from more than one direction for different reasons, Checks says it once for both,
   and one direction may have none: it said "no more fit" of a half cell 2 deep with a 5 mm
   wall at a 5 mm plate, asking for 1 across and 12 along, which has none across (the lone rule) and
   7 along (the slots). */
test('a bin kept from removable dividers both ways for different reasons says so plainly', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-0.5-2-3-5-1.2-1-12-0-1-1-1-1-0-0-0-0-1-0-15&bdt=5&bdc=1');
  await settle(page, 600);
  expect(await page.evaluate(() => builtDivs(B()[0]))).toEqual({ divX: 0, divY: 7 });
  expect((await page.$$eval('#warnings .w', (els) => els.map((e) => e.textContent)))
    .filter((t) => t.includes('removable dividers'))).toEqual(['Layer 1, the 0.5×2 bin at column 1 row 1: is built with ' +
    'no removable dividers across and 7 along, not the 1 and 12 it asks for, as that is as many as fit with a ' +
    '5 mm plate at 1 mm clearance.']);
  expect(errors).toEqual([]);
});

/* Both ways, where the end spacing on both axes was a rail and its reach, the tip of the
   end rail one way met the end rail the other way corner to corner, on one edge used four
   times: a 1x1 with a 0.4 mm wall and 10 each way at the usual plate and clearance, which
   Checks said nothing about. */
test('removable dividers both ways build watertight where the end rails meet at a corner', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-1-1-3-0.4-1.2-10-10-0-1-1-1-1-0-0-0-0-1-0-15&bdt=1.6&bdc=0.25');
  await settle(page, 600);
  expect(await page.evaluate(() => builtDivs(B()[0]))).toEqual({ divX: 10, divY: 10 });
  expect(await page.evaluate(() => checkManifold(geomFor(B()[0]).polys).bad)).toBe(0);
  expect(errors).toEqual([]);
});

/* Where the rounded corners set the limit and not the slots' spacing, Checks says so: the
   reason given was that no more left every slot room for a plate, where 17 do. */
test('Checks says it is the rounded corners when they hold a bin to fewer removable dividers', async ({ page }) => {
  const asks = (x, n) => `${x}-0-1-1-3-0.4-1.2-${n}-0-0-1-1-1-1-0-0-0-0-1-0-15`;
  const errors = await openAt(page, 'bl=' + asks(0, 17) + '&bdt=0.8&bdc=0.1');
  await settle(page, 600);
  const notes = async () => (await page.$$eval('#warnings .w', (els) => els.map((e) => e.textContent)))
    .filter((t) => t.includes('removable dividers'));
  expect(await page.evaluate(() => dividerParts().reduce((n, d) => n + d.qty, 0))).toBe(12);
  expect(await notes()).toEqual(['Layer 1, the 1×1 bin at column 1 row 1: is built with 12 removable dividers ' +
    'across, not the 17 it asks for, as more would stand the end ones so far into the bin\'s rounded corners ' +
    'that a plate would lose the clearance at its corner, with a 0.8 mm plate at 0.1 mm clearance.']);
  // and said once for several, for that reason
  await page.goto('about:blank');
  await openAt(page, 'bl=' + [0, 1].map((x) => asks(x, 17)).join('_') + '&bdt=0.8&bdc=0.1');
  await settle(page, 600);
  expect(await notes()).toEqual(['2 bins are built with fewer removable dividers than they ask for, as more ' +
    'would stand the end ones so far into their rounded corners that a plate would lose the clearance at its ' +
    'corner, with a 0.8 mm plate at 0.1 mm clearance: the 1×1 on layer 1 at column 1 row 1 and the 1×1 on ' +
    'layer 1 at column 2 row 1.']);
  expect(errors).toEqual([]);
});

/* A type is weighed from its first bin, and two bins built alike are one type whatever
   each asks for. Weighed as asked, a 1x1 asking for 30 removable dividers and one asking
   for 10, both built with 10, were one row of two at 72 g, or at 37 g the other way round. */
test('bins built with the same removable dividers weigh the same, whichever comes first', async ({ page }) => {
  const asks = (x, n) => `${x}-0-1-1-3-1.2-1.2-${n}-0-0-1-1-1-1-0-0-0-0-1-0-15`;
  const rows = async (bl) => {
    await page.goto('about:blank');
    await openAt(page, 'bl=' + bl);
    await settle(page, 600);
    return page.evaluate(() => [...document.querySelectorAll('#typeRows tr')]
      .map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(' | ')));
  };
  // one row: the size and compartments, the measurements, how many, the grams
  const asTen = await rows(asks(0, 10) + '_' + asks(1, 10));
  expect(asTen).toHaveLength(1);
  expect(asTen[0]).toMatch(/^1×1×3 · 11 comp \| .* \| 2 \| \d+ g \| /);
  expect(await rows(asks(0, 30) + '_' + asks(1, 10))).toEqual(asTen);
  expect(await rows(asks(0, 10) + '_' + asks(1, 30))).toEqual(asTen);
});

/* The fields with nothing selected are the next bin drawn, and it is drawn with fixed
   dividers: the count is taken, Removable is not. Held to the rails of the bin chosen a
   moment before, a 1x2 asking for 30 removable dividers along, the next bin got 23. */
test('the next bin drawn takes the dividers asked for, not the removable limit of the last one chosen', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-1-2-3-1.2-1.2-0-30-0-1-1-1-1-0-0-0-0-1-0-15');
  await settle(page, 600);
  await H.clickCell(page, 0, 0);
  await settle(page, 400);
  expect(await page.inputValue('#divY')).toBe('30');
  await H.dragCells(page, [3, 0], [3, 1]);
  await settle(page, 600);
  const b = await page.evaluate(() => B().map((x) => [x.u, x.v, x.divY, !!x.divRemovable]));
  expect(b).toEqual([[1, 2, 30, true], [1, 2, 30, false]]);
  expect(errors).toEqual([]);
});

test('a bin designed on its own is held to the 50 cells a link carries', async ({ page }) => {
  test.setTimeout(60_000);            // 100 × 100 took 14 s an edit with no limit at all
  const errors = await openAt(page, '');
  await page.locator('#scratchBinMap').click();
  await settle(page, 250);
  await H.setField(page, 'u', 100);
  await settle(page);
  // wider than the drawer is still allowed — the Add button says why it cannot go in
  expect(await page.evaluate(() => [scratch.u, scratch.v])).toEqual([50, 1]);
  expect(await page.inputValue('#u')).toBe('50');
  await expect(page.locator('#scratchAdd')).toBeDisabled();
  expect(errors).toEqual([]);
});

/* ---------- #6: splitting a carved bin ------------------------------------ */

test('splitting a carved bin keeps each piece to its own cells', async ({ page }) => {
  const errors = await openAt(page,
    'w=400&d=100&bl=0-0-8-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-11111110_7-0-1-1-3');
  await H.clickCell(page, 0, 0);
  await expect(page.locator('#splitFit')).toHaveText(/4×1 \+ 4×1/);
  await page.locator('#splitFit').click();
  await settle(page);

  const cells = await absCells(page);
  expect(cells.slice().sort(), 'the same eight cells, each held once')
    .toEqual(['0,0', '1,0', '2,0', '3,0', '4,0', '5,0', '6,0', '7,0']);
  const bins = await H.bins(page);
  expect(bins.every((b) => b.outsideBox === 0)).toBe(true);
  expect(await errText(page)).toEqual([]);
  expect(errors).toEqual([]);
});

/* ---------- #17: overlaps and coverage ------------------------------------ */

test('two bins on one cell are flagged, and counted once', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-1-1-3_0-0-1-1-3_0-0-1-1-3');
  const errs = await errText(page);
  expect(errs.filter((t) => /shares cells/.test(t)), 'each of the three is told').toHaveLength(3);
  await expect(page.locator('#coverage')).toContainText('1/63 cells (2%)');
  await expect(page.locator('#fillmap .clash').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('a bin off the grid is flagged and coverage stops at 100%', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-30-30-3');
  expect((await errText(page)).join(' ')).toContain('outside the drawer grid');
  const pct = await page.locator('#coverage').textContent();
  expect(Number(/\((\d+)%\)/.exec(pct)[1])).toBeLessThanOrEqual(100);
  expect(errors).toEqual([]);
});

/* ---------- #18: no rectangular lid over a carved bin --------------------- */

test('a carved bin is not given a rectangular lid, and the panel says why', async ({ page }) => {
  const errors = await openAt(page, 'bl=2-0-3-2-4-1.2-1.2-0-0-0-1-1-1-1-0-0-110110-0-0-1-3');
  expect(await page.evaluate(() => lidParts().length)).toBe(0);
  await page.locator('#openExport').click();
  await expect(page.locator('#exFiles [data-ex="stl"]').first()).toBeVisible();
  await expect(page.locator('#exFiles [data-ex="lid"]')).toHaveCount(0);
  await page.locator('#exportClose').click();

  await H.clickCell(page, 2, 0);
  await expect(page.locator('#lid')).toBeChecked();
  await expect(page.locator('#lidCarved')).toBeVisible();
  await expect(page.locator('#lidHint')).toBeHidden();
  expect(errors).toEqual([]);
});

/* ---------- #27: moving a carved bin between layers ----------------------- */

test('"Move to layer" compares cells, so an L moves over a bin in its notch', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-2-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-1110~1-1-1-1-3');
  const p = await H.cellPoint(page, 0, 0);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const item = page.locator('#ctxmenu button', { hasText: 'Move to layer 2' });
  await expect(item).toHaveText('Move to layer 2');
  await expect(item).toBeEnabled();
  await item.click();
  await settle(page);
  expect(await page.evaluate(() => [layers[0].bins.length, layers[1].bins.length])).toEqual([0, 2]);
  await expect(page.locator('#warnings')).not.toContainText('shares cells');
  expect(errors).toEqual([]);
});

/* ---------- #26: undo -------------------------------------------------------- */

test('"Already printed" and "Mark all printed" are each one Undo', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.dragCells(page, [2, 0], [2, 0]);
  await H.clickCell(page, 0, 0);
  await page.locator('#done').check();
  await settle(page, 200);
  expect(await page.evaluate(() => B()[0].done)).toBe(true);
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => !!B()[0].done), 'the first Undo did nothing').toBe(false);

  await page.locator('#markAllDone').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().every((b) => b.done))).toBe(true);
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().some((b) => b.done))).toBe(false);
  expect(await page.evaluate(() => B().length), 'and the bins are still there').toBe(2);
  expect(errors).toEqual([]);
});

test('changing a bin\'s settings is an Undo step of its own', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'hUnits', 5);
  expect(await page.evaluate(() => B()[0].hUnits)).toBe(5);
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  const after = await page.evaluate(() => B().map((b) => b.hUnits));
  expect(after, 'Undo took the bin away instead of the height').toEqual([3]);
  await page.locator('#redoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().map((b) => b.hUnits))).toEqual([5]);
  expect(errors).toEqual([]);
});

test('typing a note a letter at a time is one Undo step', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await page.locator('#note').click();
  // slower than the 180 ms redraw, so every letter reaches the bin on its own
  await page.keyboard.type('drill bits', { delay: 230 });
  await settle(page, 300);
  expect(await page.evaluate(() => B()[0].note)).toBe('drill bits');
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().map((b) => b.note || '')), 'the whole note, in one step')
    .toEqual(['']);
  expect(errors).toEqual([]);
});

/* ---------- #16: GPU memory --------------------------------------------------- */

test('edits do not pile up geometry on the GPU', async ({ page }) => {
  const six = [2, 3, 4, 5, 6, 7];
  const bl = six.flatMap((h, i) => [`${i}-0-1-1-${h}`, `${i}-1-1-1-${h}`]).join('_');
  const errors = await openAt(page, 'bl=' + bl);
  const geos = () => page.evaluate(() => renderer.info.memory.geometries);
  await H.clickCell(page, 0, 0);
  await settle(page);
  const base = await geos();

  // a note cannot change a mesh, and must not rebuild one
  for (let i = 0; i < 25; i++) {
    await page.evaluate((i) => {
      const n = document.getElementById('note');
      n.value = 'n' + i; n.dispatchEvent(new Event('input', { bubbles: true }));
    }, i);
    await settle(page, 230);
  }
  expect(await geos(), 'typing a note leaked a geometry per type per keystroke')
    .toBeLessThanOrEqual(base);

  // a height does, and the old shape has to be let go
  for (let i = 0; i < 10; i++) await H.setField(page, 'hUnits', 8 + (i % 2));
  expect(await geos()).toBeLessThanOrEqual(base + 1);
  await H.setField(page, 'infill', 40);
  expect(await geos()).toBeLessThanOrEqual(base + 1);
  expect(errors).toEqual([]);
});

/* ---------- #9: no WebGL ------------------------------------------------------ */

/* A browser of its own, so the rest of the file keeps its GPU. Launched from the
   project's own launch options rather than through test.use, which would replace them —
   and with them the browser a local config points at. */
const launchWithoutWebGL = ({ playwright, browserName, launchOptions }) =>
  playwright[browserName].launch(Object.assign({}, launchOptions,
    { args: [...((launchOptions && launchOptions.args) || []), '--disable-3d-apis'] }));

test('without WebGL the map, the table, the export and saving all still work',
  async ({ playwright, browserName, launchOptions }) => {
    const browser = await launchWithoutWebGL({ playwright, browserName, launchOptions });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(H.BINS_URL + '#bl=0-0-1-1-3');
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);

      expect(errors, 'the WebGL failure stopped the boot').toEqual([]);
      expect(await page.evaluate(() => renderer)).toBeNull();
      await expect(page.locator('#threeempty')).toContainText('3D preview unavailable');
      await expect(page.locator('#fillmap rect.bin')).toHaveCount(1);
      await expect(page.locator('#typeRows')).toContainText('1×1×3');

      await H.dragCells(page, [2, 2], [3, 3]);
      expect(await page.evaluate(() => B().length)).toBe(2);
      await page.locator('#openExport').click();
      await expect(page.locator('#exFiles [data-ex="stl"]')).toHaveCount(2);
      const dl = page.waitForEvent('download');
      await page.locator('#exFiles [data-ex="stl"]').first().click();
      expect((await dl).suggestedFilename()).toMatch(/\.stl$/);
      await page.locator('#exportClose').click();

      // saved, so a visit with no link brings it back — and Start fresh clears it
      await settle(page, 900);
      await page.goto(H.BINS_URL);
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);
      expect(await page.evaluate(() => B().length)).toBe(2);
      await page.locator('#startFresh').click();
      await page.waitForFunction(() => !!document.getElementById('fillmap') && !location.hash);
      await settle(page);
      expect(await page.evaluate(() => B().length)).toBe(0);

      /* The boot's last steps open a link focused on a bin, or on a loose one; both
         frame the preview. They have to run to the end too, or a link that names a
         focus would be one the page never finishes opening. */
      await page.goto('about:blank');
      await page.goto(H.BINS_URL + '#bl=0-0-1-1-3&bf=0.0');
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);
      expect(await page.evaluate(() => focused && selected === 0)).toBe(true);
      await page.goto('about:blank');
      await page.goto(H.BINS_URL + '#bs=0-0-2-1-3');
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);
      expect(await page.evaluate(() => scratch && [scratch.u, scratch.v])).toEqual([2, 1]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

/* The Expand button opened a full-screen box saying there was nothing to show. It was
   meant to be hidden, but the page looked for it before chrome.js, the last script on
   the page, had made it. */
test('without WebGL there is no Expand button over the empty preview',
  async ({ page, playwright, browserName, launchOptions }) => {
    // with WebGL it is there, so the check below cannot pass on a button that never was
    await openAt(page, 'bl=0-0-1-1-3');
    await expect(page.locator('#threewrap .previewbtn')).toBeVisible();

    const browser = await launchWithoutWebGL({ playwright, browserName, launchOptions });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(H.BINS_URL + '#bl=0-0-1-1-3');
      await p.waitForFunction(() => !!document.getElementById('fillmap'));
      await expect(p.locator('#threeempty')).toContainText('3D preview unavailable');
      await expect(p.locator('#threewrap .previewbtn')).toHaveCount(1);
      await expect(p.locator('#threewrap .previewbtn')).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

/* ---------- #24: downloads are deflated --------------------------------------- */

/* Each file's compression method, from the ZIP's central directory: 8 is deflate,
   0 is stored. Read from the bytes rather than through JSZip, which unzips either
   without saying which it found. Folder entries (a 3MF has two) are empty and always
   stored, so they are left out. */
function zipMethods(buf) {
  const out = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    const len = buf.readUInt16LE(at + 28), name = buf.toString('utf8', at + 46, at + 46 + len);
    if (!name.endsWith('/')) out[name] = buf.readUInt16LE(at + 10);
    at += 46 + len + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}
async function download(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
}

/* The baseplates page deflated its 3MF and ZIP downloads and this one went on storing
   them, several times the size for files that are mostly XML. Compressed, every entry
   still has to come out byte for byte what the page made: the ZIP's files against the
   same files downloaded one at a time, and the plates' 3MFs entry by entry. */
test('the bin ZIP, the plate ZIP and every 3MF are deflated, and unzip to the same bytes',
  async ({ page }) => {
    /* Two 2x2 bins, one to a 100 mm bed, so the plates come as a ZIP; and a 1x1 with a
       loose divider and a lid, so the bin ZIP carries every kind of part. */
    const errors = await openAt(page, 'bw=100&bd=100&bl=0-0-2-2-3_2-0-2-2-3_' +
                                      '4-0-1-1-3-1.2-1.2-1-0-0-1-1-1-1-0-0-0-0-1-1-15');
    expect(await page.evaluate(() => [types().length, dividerParts().length, lidParts().length,
                                      goodPlates().length > 1]),
           'fixture: two bin types, a divider, a lid and more than one plate')
      .toEqual([2, 1, 1, true]);
    await page.locator('#openExport').click();

    const zip = await download(page, '#exFiles [data-ex="zip"]');
    const methods = zipMethods(zip.buf);
    expect(Object.keys(methods)).toContain('README.txt');
    expect(Object.keys(methods)).toHaveLength(5);
    expect(methods, 'entries stored, not deflated').toEqual(
      Object.fromEntries(Object.keys(methods).map((k) => [k, 8])));
    const files = (await JSZip.loadAsync(zip.buf)).files;
    for (const kind of ['stl', 'divider', 'lid']) {
      const rows = page.locator(`#exFiles [data-ex="${kind}"]`);
      for (let i = 0; i < await rows.count(); i++) {
        const one = await download(page, `#exFiles [data-ex="${kind}"] >> nth=${i}`);
        expect(files[one.name], `${one.name} is missing from the ZIP`).toBeTruthy();
        expect(Buffer.compare(await files[one.name].async('nodebuffer'), one.buf),
               `${one.name} unzipped is not the file downloaded on its own`).toBe(0);
      }
    }
    expect(await files['README.txt'].async('string'))
      .toBe(await page.evaluate(() => layoutReadme()));

    const plates = await download(page, '#exFiles [data-ex="allplates"]');
    const plateMethods = zipMethods(plates.buf);
    expect(Object.values(plateMethods), 'plates stored in their ZIP').toEqual(
      Object.keys(plateMethods).map(() => 8));
    const inZip = (await JSZip.loadAsync(plates.buf)).files;
    /* A 3MF is a ZIP of its own, stamped with the time it was made, so two of the same
       plate differ in their headers; what is in them may not. */
    const first = await download(page, '#exFiles [data-ex="plate"] >> nth=0');
    const alone = (await JSZip.loadAsync(first.buf)).files;
    for (const [name, entry] of Object.entries(inZip)) {
      const bytes = await entry.async('nodebuffer');
      expect(Object.values(zipMethods(bytes)), `${name}: its parts are stored`)
        .toEqual([8, 8, 8]);
      if (name !== first.name) continue;
      const parts = (await JSZip.loadAsync(bytes)).files;
      expect(Object.keys(parts).sort()).toEqual(Object.keys(alone).sort());
      for (const part of Object.keys(alone).filter((k) => !alone[k].dir))
        expect(await parts[part].async('string'), `${name}: ${part}`)
          .toBe(await alone[part].async('string'));
    }
    expect(inZip[first.name], `${first.name} is missing from the plate ZIP`).toBeTruthy();
    expect(errors).toEqual([]);
  });

/* A scooped 1x1x3 and a plain one were both "bin-1x1x3-qty1.stl": the file name leaves
   out the scoop, the label shelf and lowered walls. A ZIP keeps the last file of a name,
   so one of the two bins was not in it, and nothing said so. */
test('bins the file name used to call alike each get their own file in the ZIP',
  async ({ page }) => {
    const bin = (x, y, rest) => `${x}-${y}-1-1-3-1.2-1-0-0-0-${rest}`;
    const errors = await openAt(page, 'bl=' + [
      bin(0, 0, '1-1-1-1'),          // plain
      bin(1, 0, '1-1-1-1-8'),        // a scoop
      bin(2, 0, '1-1-1-1-0-12'),     // a label shelf
      bin(0, 1, '0.5-1-1-1'),        // the front wall lowered
      bin(1, 1, '1-0.5-1-1'),        // the back wall lowered instead
      '2-1-2-1-3',                   // a 2x1, which shares its name with nothing
    ].join('_'));
    expect(await page.evaluate(() => types().length), 'fixture: six kinds of bin').toBe(6);
    await page.locator('#openExport').click();

    const zip = await download(page, '#exFiles [data-ex="zip"]');
    const files = (await JSZip.loadAsync(zip.buf)).files;
    expect(Object.keys(files).filter((n) => n.endsWith('.stl')).sort()).toEqual([
      'bin-1x1x3-label12-qty1.stl',
      'bin-1x1x3-low-b50-qty1.stl',
      'bin-1x1x3-low-f50-qty1.stl',
      'bin-1x1x3-qty1.stl',            // the plain one keeps the name it always had
      'bin-1x1x3-scoop8-qty1.stl',
      'bin-2x1x3-qty1.stl',
    ]);
    // and each row's own download is that file, under the same name
    const rows = page.locator('#exFiles [data-ex="stl"]');
    expect(await rows.count()).toBe(6);
    for (let i = 0; i < 6; i++) {
      const one = await download(page, `#exFiles [data-ex="stl"] >> nth=${i}`);
      expect(files[one.name], `${one.name} is missing from the ZIP`).toBeTruthy();
      expect(Buffer.compare(await files[one.name].async('nodebuffer'), one.buf),
             `${one.name} in the ZIP is another bin`).toBe(0);
    }
    expect(errors).toEqual([]);
  });

/* What tells two kinds of bin apart in their names is what they ARE, not the order
   they were drawn in or what else is in the drawer: a default wall or floor is not
   named, a lowered wall says which, a shape says which, and a solid block is not
   named for a scoop or a shelf it has nowhere to put. A plain bin beside a scooped one
   is told apart even when their counts already differ. */
test('a bin\'s file name says how it differs, the same whatever order or company it keeps',
  async ({ page }) => {
    const names = async (bins) => {
      await openAt(page, 'bl=' + bins.join('_'));
      return page.evaluate(() => Object.fromEntries(types().map((t) => [t.key, typeNames().get(t.key)])));
    };
    const bin = (x, y, rest) => `${x}-${y}-1-1-3-${rest}`;
    // a default wall stays unnamed beside a thicker one
    expect(Object.values(await names([bin(0, 0, '1.2-1.2'), bin(1, 0, '1.6-1.2')])).sort())
      .toEqual(['bin-1x1x3-qty1', 'bin-1x1x3-wall1.6-qty1']);
    // two different walls lowered keep their names when the bins swap places
    const f = bin(0, 0, '1.2-1.2-0-0-0-0.5-1-1-1'), b = bin(1, 0, '1.2-1.2-0-0-0-1-0.5-1-1');
    const one = await names([f, b]), two = await names([b.replace(/^1-0/, '0-0'), f.replace(/^0-0/, '1-0')]);
    expect(two).toEqual(one);
    expect(Object.values(one).sort()).toEqual(['bin-1x1x3-low-b50-qty1', 'bin-1x1x3-low-f50-qty1']);
    // a solid block with a scoop and one without are one part, so one file
    const solid = await names([bin(0, 0, '1.2-1.2-0-0-1-1-1-1-1-8'), bin(1, 0, '1.2-1.2-0-0-1')]);
    expect(Object.values(solid)).toEqual(['bin-1x1x3-solid-qty2']);
    // counts that differ do not hide the difference
    const q = await names([bin(0, 0, '1.2-1.2'), bin(1, 0, '1.2-1.2-0-0-0-1-1-1-1-8'),
                           bin(2, 0, '1.2-1.2-0-0-0-1-1-1-1-8')]);
    expect(Object.values(q).sort()).toEqual(['bin-1x1x3-qty1', 'bin-1x1x3-scoop8-qty2']);
  });

/* A lid is not part of a bin's type (the bin prints the same with or without one), and
   the lids were counted per type: from the type's first bin, times the whole type. A
   plain 1x1x3 drawn before a lidded one left the lid out of every download; drawn after
   it, two lids for one; two lids with different sides came out as one kind, twice. */
test('every lidded bin gets its own lid, whatever the bins beside it', async ({ page }) => {
  const plain = '0-0-1-1-3', lid = (x, sides) => `${x}-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-1-${sides}`;
  const lids = async (bins) => {
    await openAt(page, 'bl=' + bins.join('_'));
    return page.evaluate(() => lidParts().map((d) => [lidName(d), d.qty]));
  };
  expect(await lids([plain, lid(1, 15)])).toEqual([['lid-1x1-lrfb', 1]]);
  expect(await lids([lid(0, 15), plain.replace(/^0-0/, '1-0')])).toEqual([['lid-1x1-lrfb', 1]]);
  const two = await lids([lid(0, 15), lid(1, 3)]);
  expect(two).toHaveLength(2);
  expect(two.every(([, n]) => n === 1)).toBe(true);
  // and the ZIP carries it
  const errors = await openAt(page, 'bl=' + [plain, lid(1, 15)].join('_'));
  await page.locator('#openExport').click();
  const zip = await download(page, '#exFiles [data-ex="zip"]');
  expect(Object.keys((await JSZip.loadAsync(zip.buf)).files).filter((n) => n.startsWith('lid-')))
    .toEqual(['lid-1x1-lrfb.stl']);
  expect(errors).toEqual([]);
});

/* A bin too big for the bed is said, and leaves out only itself. The bins that fitted
   were packed onto its plate, which no file carries, so they were in no download and
   the plan said "0 bins packed". */
test('a bin too big for the bed takes none of the others with it', async ({ page }) => {
  const errors = await openAt(page, 'bw=180&bd=180&bl=0-0-5-1-3_0-1-1-1-3_1-1-1-1-3_2-1-1-1-3');
  await expect(page.locator('#plateSummary')).toContainText('3 bins packed');
  await expect(page.locator('#plateSummary')).toContainText('1 part TOO BIG');
  expect(await page.evaluate(() => goodPlates().reduce((n, [p]) => n + p.placed.length, 0)),
    'every bin that fits is on a plate that is in the files').toBe(3);
  expect(errors).toEqual([]);
});

/* ---------- #30: the small ones ----------------------------------------------- */

test('a note is cut by character, never through an emoji', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'note', 'a'.repeat(27) + '😀b');
  const note = await page.evaluate(() => B()[0].note);
  expect([...note]).toHaveLength(28);
  expect(note.endsWith('😀'), 'cut through the surrogate pair').toBe(true);
  expect(errors).toEqual([]);
});

test('a lid with no skirt is listed as the flat plate it is', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await page.locator('#lid').check();
  for (const s of ['lidF', 'lidB', 'lidL', 'lidR']) await page.locator('#' + s).uncheck();
  await settle(page);
  await page.locator('#openExport').click();
  await expect(page.locator('#exFiles [data-ex="lid"]')).toHaveCount(1);
  const text = await page.locator('#exFiles').textContent();
  expect(text).not.toContain('( sides)');
  expect(text).toContain('Lid 1×1, flat — no skirt');
  expect(text).toContain('1.2 mm thick');
  expect(text).not.toContain('4.2 mm tall');
  expect(errors).toEqual([]);
});
