/* Half-size bins on the bins page.
 *
 * A bin may be 1.5 cells wide and stand half a cell in, in any standard baseplate: its
 * feet are quarter feet, two to a socket side (bin-audit.js and fit-check.js hold the
 * geometry to that). What this file holds is the page around it — the map that draws,
 * drags and resizes in half cells, the whole-size bin that may not sit on a half step,
 * and the things a half-size bin cannot have yet saying so rather than vanishing.
 *
 * Every case reads the page's own model (B(), halfSteps, the occupancy) for what
 * happened, and the DOM for what you are told: the DOM is what is under test, so it
 * cannot also be the source of truth.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(300);
// one bin, as packBin writes it, with everything after the size left at the defaults
const bin = (x, y, u, v, h = 3, feet = 0) =>
  [x, y, u, v, h, 1.2, 1.2, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 15].concat(feet ? [feet] : []).join('-');

async function openAt(page, hash) {
  page.__errors = await H.openBins(page);
  if (hash) {
    await page.goto('about:blank');
    await page.goto(H.BINS_URL + '#' + hash);
    await page.waitForFunction(() => typeof THREE !== 'undefined');
    await settle(page);
  }
}
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

/* The centre of half slot (sx, sy) in viewport pixels: two slots to a cell each way,
   counted from the front-left corner like the grid. Through the SVG's own screen matrix,
   for the reason helpers.js gives. */
async function slotPoint(page, sx, sy) {
  await H.mapInView(page);
  return page.evaluate(({ sx, sy, CELL }) => {
    const svg = document.getElementById('fillmap');
    const ny = svg.getAttribute('viewBox').split(' ').map(Number)[3] / CELL;
    const p = svg.createSVGPoint();
    p.x = (sx + 0.5) * CELL / 2;
    p.y = (2 * ny - 1 - sy + 0.5) * CELL / 2;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  }, { sx, sy, CELL: H.CELL });
}
/* The same point where the map is now, without scrolling it into the middle first: for
   the cases that measure the page as it opened, where a scroll would be what they see. */
const slotHere = (page, sx, sy) => page.evaluate(({ sx, sy, CELL }) => {
  const svg = $('fillmap'), ny = svg.getAttribute('viewBox').split(' ').map(Number)[3] / CELL;
  const p = svg.createSVGPoint();
  p.x = (sx + 0.5) * CELL / 2; p.y = (2 * ny - 1 - sy + 0.5) * CELL / 2;
  const q = p.matrixTransform(svg.getScreenCTM());
  return { x: q.x, y: q.y };
}, { sx, sy, CELL: H.CELL });
async function dragSlots(page, from, to) {
  const a = await slotPoint(page, ...from), b = await slotPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}
const binsNow = (page) => page.evaluate(() => B().map((b) => [b.x, b.y, b.u, b.v]));
const steps = (page) => page.evaluate(() => ({
  half: halfSteps,
  pressed: document.getElementById('stepHalf').getAttribute('aria-pressed'),
  whole: document.getElementById('stepWhole').getAttribute('aria-pressed'),
  midlines: document.querySelectorAll('#fillmap .midline').length,
}));
const select = (page, i) => page.evaluate((i) => {
  clearSel(); selected = i; writeControls(B()[i]); readControls(); drawMap(); refresh();
}, i);

test('width and depth take halves, and a size between halves is built as the nearest', async ({ page }) => {
  await openAt(page, '');
  for (const id of ['u', 'v']) {
    expect(await page.getAttribute('#' + id, 'step')).toBe('0.5');
    expect(await page.getAttribute('#' + id, 'min')).toBe('0.5');
  }
  await expect(page.locator('#sizeHalfHint')).toHaveText(
    'A half cell is 21 mm. Half-size bins have small feet that fit any Gridfinity baseplate, two to a socket.');

  await H.dragCells(page, [0, 0], [1, 0]);
  await H.setField(page, 'u', 1.3);
  await H.setField(page, 'v', 0.2);
  expect(await binsNow(page), 'buildBin must never see a 1.3').toEqual([[0, 0, 1.5, 0.5]]);
  expect(await page.inputValue('#u')).toBe('1.5');
  expect(await page.inputValue('#v')).toBe('0.5');
  // and it is built that size: 1.5 cells less the half millimetre every bin gives up
  expect(await page.evaluate(() => geomFor(B()[0]).meta.W)).toBeCloseTo(62.5, 3);
});

test('half steps start off, turn on by themselves for a half-size bin, and draw midlines', async ({ page }) => {
  await openAt(page, '');
  expect(await steps(page)).toEqual({ half: false, pressed: 'false', whole: 'true', midlines: 0 });

  // a whole-cell drawer stays on whole cells whatever is drawn in it
  await H.dragCells(page, [0, 0], [1, 1]);
  expect((await steps(page)).half).toBe(false);

  await H.setField(page, 'u', 1.5);
  expect(await steps(page)).toEqual({ half: true, pressed: 'true', whole: 'false', midlines: 1 });
  expect(await page.getAttribute('#fillmap', 'aria-label')).toContain('half-cell steps');

  // switched back by hand it stays back, even with the half-size bin still there
  await page.click('#stepWhole');
  await settle(page);
  expect(await steps(page)).toEqual({ half: false, pressed: 'false', whole: 'true', midlines: 0 });
  await H.setField(page, 'hUnits', 4);
  expect((await steps(page)).half).toBe(false);
});

test('with half steps on, a drag draws in half cells and the grips resize in halves', async ({ page }) => {
  await openAt(page, '');
  await page.click('#stepHalf');
  await settle(page);

  // from the first half slot to the third across and the second up: 1.5 x 1
  await dragSlots(page, [0, 0], [2, 1]);
  expect(await binsNow(page)).toEqual([[0, 0, 1.5, 1]]);

  // a single half slot is the smallest bin there is
  await dragSlots(page, [8, 0], [8, 0]);
  expect((await binsNow(page))[1]).toEqual([4, 0, 0.5, 0.5]);

  // the right-back grip of the first bin, pulled out half a cell each way
  await select(page, 0);
  const to = await slotPoint(page, 3, 2);
  const g = await page.locator('#fillmap .grip[data-handle="rb"]').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  expect((await binsNow(page))[0]).toEqual([0, 0, 2, 1.5]);
});

test('a whole-size bin is refused a half step, and the page says why', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0.5, 0, 1.5, 1) + '_' + bin(3, 3, 1, 1));
  expect((await steps(page)).half, 'the half-size bin turned half steps on').toBe(true);
  const say = page.locator('#stepWhy');
  await expect(say).toHaveText('');

  // drawn: one whole cell, half a cell in from the left
  await dragSlots(page, [1, 4], [2, 5]);
  expect(await binsNow(page), 'nothing drawn').toHaveLength(2);
  await expect(say).toHaveText('A whole-size bin sits on whole cells.');

  // a press anywhere else on the map clears it, and the same box on whole cells is fine
  await dragSlots(page, [2, 4], [3, 5]);
  await expect(say).toHaveText('');
  expect((await binsNow(page))[2]).toEqual([1, 2, 1, 1]);

  // moved: the whole bin only ever lands on whole cells, the half-size one on halves
  await select(page, 1);
  await page.keyboard.press('ArrowRight');
  expect((await binsNow(page))[1], 'a whole cell, never half').toEqual([4, 3, 1, 1]);
  await select(page, 0);
  await page.keyboard.press('ArrowRight');
  expect((await binsNow(page))[0], 'half a cell').toEqual([1, 0, 1.5, 1]);
  await page.keyboard.press('ArrowLeft');

  // typed: 2 wide at column 1.5 is free cells, just not whole ones, so it is put back
  await H.setField(page, 'u', 2);
  expect((await binsNow(page))[0]).toEqual([0.5, 0, 1.5, 1]);
  expect(await page.inputValue('#u')).toBe('1.5');
  await expect(page.locator('#sizeWhy')).toHaveText('A whole-size bin sits on whole cells.');
  await expect(page.locator('#sizeWhy')).toBeVisible();
  // and 2.5 is a half size, which may stand there
  await H.setField(page, 'u', 2.5);
  expect((await binsNow(page))[0]).toEqual([0.5, 0, 2.5, 1]);
  await expect(page.locator('#sizeWhy')).toBeHidden();
});

/* A half-size bin on a half step has whole sizes on either side of it in Width and
   Depth: 1.5 at column 1.5 steps to 2 or 1, and neither may stand there. The field
   refused each and wrote 1.5 back under the caret, 180 ms later, so the arrows and the
   spinner never got past 2, typing "2.5" at a human pace became "1.55", and emptying
   the field to type a new number filled it straight back in. A step now goes over a
   whole size it may not take to the next half size; typing is left alone until you
   leave the field, and only then is a refused size put back, with the reason. */
test('width and depth can change a half-size bin on a half step', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0.5, 0, 1.5, 1) + '&w=600&d=500');
  await select(page, 0);
  const now = () => page.evaluate(() => [B()[0].u, B()[0].v, $('u').value, $('v').value]);
  const why = page.locator('#sizeWhy');

  // the arrow keys, in the field
  await page.focus('#u');
  await page.keyboard.press('ArrowUp');
  await settle(page);
  expect(await now(), 'up, over 2').toEqual([2.5, 1, '2.5', '1']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await settle(page);
  expect(await now(), 'down, over 2 and then over 1').toEqual([0.5, 1, '0.5', '1']);
  await page.keyboard.press('ArrowUp');
  await settle(page);
  expect(await now()).toEqual([1.5, 1, '1.5', '1']);
  // Depth steps by halves as ever: 1.5 x 2 is a half size, so 2 is no step over
  await page.focus('#v');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await settle(page);
  expect(await now()).toEqual([1.5, 2, '1.5', '2']);
  await expect(why).toBeHidden();

  // the spinner's up arrow, inside the field's right-hand padding
  const box = await page.locator('#u').boundingBox();
  await page.mouse.click(box.x + box.width - 14, box.y + box.height / 4);
  await settle(page);
  expect(await now(), 'the spinner, over 2').toEqual([2.5, 2, '2.5', '2']);

  // typed at a human pace, the 1 on the way to 1.5 and the 2 on the way to 2.5 are left
  // under the caret, not put back
  await page.focus('#u');
  for (const typed of ['1.5', '2.5', '1.5']) {
    await page.keyboard.press('Control+a');
    await page.keyboard.type(typed, { delay: 250 });
    await settle(page);
    expect(await now(), `typed ${typed}`).toEqual([Number(typed), 2, typed, '2']);
  }

  // emptied to type another number, it stays empty, and the bin keeps its size meanwhile
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);
  expect(await now(), 'not refilled under the caret').toEqual([1.5, 2, '', '2']);
  await expect(why).toBeHidden();
  // and left empty, the field shows the size the bin still has
  await page.keyboard.press('Tab');
  await settle(page);
  expect(await now()).toEqual([1.5, 2, '1.5', '2']);
  await expect(why).toBeHidden();

  // a whole size typed and left is refused when it is left, and the page says why
  await page.focus('#u');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('3', { delay: 250 });
  await settle(page);
  expect(await now(), 'still being typed, so left as typed').toEqual([1.5, 2, '3', '2']);
  await expect(why).toHaveText('A whole-size bin sits on whole cells.');
  await page.keyboard.press('Tab');
  await settle(page);
  expect(await now(), 'put back once left').toEqual([1.5, 2, '1.5', '2']);
  await expect(why).toHaveText('A whole-size bin sits on whole cells.');

  // and an edit of anything else says nothing more about it
  await H.setField(page, 'hUnits', 4);
  await expect(why).toBeHidden();

  // Shift and the arrows on the map step over a whole size in the same way
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Shift+ArrowRight');
  expect(await binsNow(page)).toEqual([[0.5, 0, 2.5, 2]]);
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await binsNow(page), 'over 2 and over 1').toEqual([[0.5, 0, 0.5, 2]]);
});

test('the arrow keys move a half-size bin half a cell only with half steps on', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0, 0, 1.5, 1));
  await select(page, 0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  expect(await binsNow(page)).toEqual([[0.5, 0.5, 1.5, 1]]);
  /* shift resizes in halves too, and steps over a whole size the bin may not take where
     it stands: 1 x 1 at column 1.5 is not one, so 1.5 goes to 0.5 and back to 1.5. It
     used to stop there, refused, and a bin on a half step could not be resized at all. */
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await binsNow(page), 'over 1 x 1 to half a cell').toEqual([[0.5, 0.5, 0.5, 1]]);
  await page.keyboard.press('Shift+ArrowRight');
  expect(await binsNow(page), 'and back over it').toEqual([[0.5, 0.5, 1.5, 1]]);
  await expect(page.locator('#stepWhy'), 'nothing was refused').toHaveText('');
  // 1 x 1.5 is a half size, so it is no step over; and the smallest is half a cell
  await page.keyboard.press('Shift+ArrowUp');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
  expect(await binsNow(page)).toEqual([[0.5, 0.5, 0.5, 1.5]]);

  await page.click('#stepWhole');
  await select(page, 0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  expect(await binsNow(page), 'whole steps move and grow it a whole cell')
    .toEqual([[1.5, 0.5, 1.5, 1.5]]);
});

/* A carve counts whole cells, so a carved bin made half-size is the plain rectangle its
   box is. That is still so; what is new is that the page says it, where the size was
   changed, and that Undo, which brings the shape back, takes the sentence away too. */
test('a carved bin made half-size says its shape has gone, and Undo brings it back', async ({ page }) => {
  const L = [0, 0, 2, 2, 3, 1.2, 1.2, 0, 0, 0, 1, 1, 1, 1, 0, 0, '1110', 0, 0, 0, 15].join('-');
  const note = 'A half-size bin cannot keep a carved shape, so this one is a plain rectangle now. ' +
    'Undo brings the shape back.';
  const now = () => page.evaluate(() => [B()[0].u, B()[0].v, isCarved(B()[0])]);
  await openAt(page, 'bl=' + L);
  await select(page, 0);
  expect(await now(), 'fixture: a carved 2 x 2').toEqual([2, 2, true]);

  // typed into Width
  await H.setField(page, 'u', 1.5);
  expect(await now()).toEqual([1.5, 2, false]);
  await expect(page.locator('#sizeWhy')).toHaveText(note);
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await now()).toEqual([2, 2, true]);
  await expect(page.locator('#sizeWhy'), 'gone with what it was about').toHaveText('');

  // and with shift and an arrow on the map, in half steps, said under the map, in the
  // one line there is room for there
  expect((await steps(page)).half, 'still on from the half-size bin a moment ago').toBe(true);
  await select(page, 0);
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await now()).toEqual([1.5, 2, false]);
  await expect(page.locator('#stepWhy')).toHaveText('A half-size bin cannot be carved.');
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await now()).toEqual([2, 2, true]);
  await expect(page.locator('#stepWhy'), 'and Undo takes this one away too').toHaveText('');
});

/* The hint under the size fields gives the half cell's length in the drawer's unit, as
   the grid summary gives its own: millimetres always, and inches beside them. */
test('the half cell under the size fields is given in inches too, with inches on', async ({ page }) => {
  await openAt(page, '');
  await expect(page.locator('#sizeHalfHint')).toHaveText(/^A half cell is 21 mm\. /);
  await page.evaluate(() => $('unitIn').click());
  await expect(page.locator('#sizeHalfHint')).toHaveText(/^A half cell is 21 mm \/ 0\.83 in\. /);
  await page.evaluate(() => $('unitMm').click());
  await expect(page.locator('#sizeHalfHint')).toHaveText(/^A half cell is 21 mm\. /);
});

test('carve and merge are greyed for a half-size bin, with the reason', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0, 0, 1.5, 1) + '_' + bin(2, 0, 2, 2));
  await select(page, 1);
  await expect(page.locator('#carveMode')).toBeEnabled();
  await expect(page.locator('#shapeOff')).toBeHidden();

  await select(page, 0);
  await expect(page.locator('#carveMode')).toBeVisible();
  await expect(page.locator('#carveMode')).toBeDisabled();
  await expect(page.locator('#shapeOff')).toHaveText(
    'Carve and Merge work in whole cells, so they are off for half-size bins.');
  // and the shortcut that carves does nothing either
  await H.clickCell(page, 0, 0, ['Alt']);
  expect(await page.evaluate(() => [B()[0].cells || null, isCarved(B()[0])])).toEqual([null, false]);

  // the two together: merging would need a mask, which counts whole cells
  await page.evaluate(() => { selExtra.add(1); readControls(); drawMap(); refresh(); });
  await expect(page.locator('#mergeBins')).toBeVisible();
  await expect(page.locator('#mergeBins')).toBeDisabled();
  await expect(page.locator('#shapeOff')).toBeVisible();
  await page.evaluate(() => document.getElementById('mergeBins').click());
  expect(await page.evaluate(() => B().length), 'nothing merged').toBe(2);
});

test('a half-size bin has no holes in its feet yet, and its file says so', async ({ page }) => {
  // asked for magnets in every cell, which a whole bin of the same footprint would get
  await openAt(page, 'bl=' + bin(0, 0, 1.5, 1, 3, 5) + '_' + bin(2, 0, 2, 1, 3, 5));
  await select(page, 0);
  await expect(page.locator('#magnets')).toBeDisabled();
  await expect(page.locator('#screws')).toBeDisabled();
  const why = await page.evaluate(() => feetHolesOff(B()[0]));
  expect(why).toMatch(/^Half-size bins have no magnet or screw holes yet/);
  await expect(page.locator('#feetOff')).toHaveText(why);
  // what was asked for is kept, and none of it is built or counted
  expect(await page.evaluate(() => [B()[0].magnets, holeSites(binCfg(B()[0])).length])).toEqual([true, 0]);
  await expect(page.locator('#holeCount')).toBeHidden();
  await expect(page.locator('#holesWhereRow')).toBeHidden();

  const names = await page.evaluate(() => types().map((t) => [typeName(t), t.key]));
  const half = names.find((n) => n[0].startsWith('bin-1.5')), whole = names.find((n) => n[0].startsWith('bin-2'));
  expect(half[0]).toBe('bin-1.5x1x3-qty1');
  expect(half[1], 'the part is the plain one').not.toMatch(/-h/);
  expect(whole[0]).toMatch(/^bin-2x1x3-magnets/);

  // the whole one keeps its holes, and its boxes
  await select(page, 1);
  await expect(page.locator('#magnets')).toBeEnabled();
  await expect(page.locator('#feetOff')).toBeHidden();
});

test('checks notes a bin only half a cell across, and why the bins beside it matter', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0, 0, 0.5, 2) + '_' + bin(3, 0, 1.5, 1));
  let w = await page.locator('#warnings').innerText();
  expect(w).toContain('Layer 1, the 0.5×2 bin at column 1 row 1: is only half a cell wide. On a standard ' +
    'baseplate the bins beside it hold it in place; on its own it can slide about 21 mm in its socket.');
  expect(w, 'a bin a cell and a half across is held by its own feet').not.toContain('1.5×1 bin');
  // a note, not a fault
  expect(await page.locator('#warnings .w.err').count()).toBe(0);

  /* Two or more are one note between them, not the same two sentences a bin: filling a
     drawer with half-cell-wide bins said them 126 times. */
  await openAt(page, 'bl=' + bin(0, 0, 0.5, 2) + '_' + bin(1, 0, 2, 0.5) + '_' + bin(3, 0, 1.5, 1) +
    '~' + bin(0, 0, 0.5, 1, 2));
  const notes = await page.locator('#warnings .w').allInnerTexts();
  expect(notes.filter((t) => /half a cell/.test(t))).toEqual(['3 bins are only half a cell wide or deep: ' +
    'the 0.5×2 on layer 1 at column 1 row 1, the 2×0.5 on layer 1 at column 2 row 1 and the 0.5×1 on ' +
    'layer 2 at column 1 row 1. On a standard baseplate the bins beside each one hold it in place; on ' +
    'its own one can slide about 21 mm in its socket.']);
  // and filled with half-cell-wide bins, still one
  await page.click('#layerTabs button >> nth=0');
  await H.setField(page, 'u', 0.5);
  await page.click('#fillRest');
  await settle(page);
  const many = (await page.locator('#warnings .w').allInnerTexts()).filter((t) => /half a cell/.test(t));
  expect(many).toHaveLength(1);
  expect(many[0]).toMatch(/^\d+ bins are only half a cell wide or deep: the 0\.5×2 on layer 1 at column 1 row 1, .* and \d+ more\. /);
});

test('fill the rest packs half-size bins edge to edge and leaves nothing uncovered', async ({ page }) => {
  await openAt(page, '');
  await H.setField(page, 'u', 1.5);
  await page.click('#fillRest');
  await settle(page);
  const r = await page.evaluate(() => ({
    row0: B().filter((b) => b.y === 0).map((b) => [b.x, b.u, b.v]),
    free: occupancy().flat().filter((i) => i === -1).length,
    twice: layerClaims(cur).flat().filter(Array.isArray).length,
    whole: B().filter((b) => !isHalfSize(b) && !(Number.isInteger(b.x) && Number.isInteger(b.y))).length,
  }));
  expect(r.row0.slice(0, 4)).toEqual([[0, 1.5, 1], [1.5, 1.5, 1], [3, 1.5, 1], [4.5, 1.5, 1]]);
  expect(r.free, 'every half slot filled').toBe(0);
  expect(r.twice, 'no two bins on one slot').toBe(0);
  expect(r.whole, 'no whole-size bin on a half step').toBe(0);
});

test('duplicate puts a half-size bin right beside itself', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0, 0, 1.5, 1));
  await select(page, 0);
  await page.click('#dupBtn');
  await settle(page);
  expect(await binsNow(page)).toEqual([[0, 0, 1.5, 1], [1.5, 0, 1.5, 1]]);
});

test('a half-size bin too big for the bed splits on whole cells', async ({ page }) => {
  // 5.5 wide from column 1.5 on a 120 mm bed: no piece may be whole-size on a half step
  await openAt(page, 'w=600&d=500&bw=120&bd=120&bl=' + bin(0.5, 0, 5.5, 2));
  await select(page, 0);
  await expect(page.locator('#splitFit')).toHaveText('Split into 1.5×2 + 2×2 + 2×2 to fit the bed');
  await page.click('#splitFit');
  await settle(page);
  expect(await binsNow(page)).toEqual([[0.5, 0, 1.5, 2], [2, 0, 2, 2], [4, 0, 2, 2]]);
});

/* The cuts fall on whole cells, which keeps a piece whole-size only where it starts on
   one. A span from a half column with ONE piece across keeps both its half cells: a 3
   wide from column 1.5 is a whole 3 standing on a half step. Split into rows, a 3 x 7.5
   there gave a whole 3 x 4 at column 1.5, which Checks never questioned; reloaded, the
   link put it on whole cells, on top of the bin beside it. That one piece across is now
   cut in two, a half cell in each, so every piece is half-size. */
test('a split never leaves a whole-size piece on a half step, and a reload keeps it', async ({ page }) => {
  for (const [hash, label, want] of [
    ['bl=' + bin(0.5, 0, 3, 7.5) + '_' + bin(3.5, 0, 0.5, 4),
     'Split into 1.5×4 + 1.5×4 + 1.5×3.5 + 1.5×3.5 to fit the bed',
     [[3.5, 0, 0.5, 4], [0.5, 0, 1.5, 4], [2, 0, 1.5, 4], [0.5, 4, 1.5, 3.5], [2, 4, 1.5, 3.5]]],
    // 5 wide from column 1.5 fits a 220 mm bed across, and 5.5 deep does not
    ['bw=220&bd=220&bl=' + bin(0.5, 0, 5, 5.5),
     'Split into 2.5×3 + 2.5×3 + 2.5×2.5 + 2.5×2.5 to fit the bed',
     [[0.5, 0, 2.5, 3], [3, 0, 2.5, 3], [0.5, 3, 2.5, 2.5], [3, 3, 2.5, 2.5]]],
  ]) {
    await openAt(page, hash);
    const i = await page.evaluate(() => B().findIndex((b) => !fitsBed(b.u, b.v)));
    await select(page, i);
    const said = await page.locator('#splitFit').textContent();
    await page.click('#splitFit');
    await settle(page);
    const state = () => page.evaluate(() => ({
      bins: B().map((b) => [b.x, b.y, b.u, b.v]),
      whole: B().filter((b) => !isHalfSize(b) && !(Number.isInteger(b.x) && Number.isInteger(b.y))).length,
      twice: layerClaims(cur).flat().filter(Array.isArray).length,
      shared: /shares cells/.test($('warnings').textContent),
    }));
    const split = await state();
    expect(split).toEqual({ bins: want, whole: 0, twice: 0, shared: false });
    expect(said, 'and the button said so').toBe(label);

    await page.waitForTimeout(600);                    // past the save's 400 ms
    await page.reload();
    await page.waitForFunction(() => typeof THREE !== 'undefined');
    await settle(page);
    expect(await state(), 'the same after a reload').toEqual(split);
  }
});

test('an upper layer stands on half-size bins the way it stands on whole ones', async ({ page }) => {
  // a 3 x 1 lid of a layer over two 1.5 x 1 bins: level, so it sits; one of them taller, so it rocks
  await openAt(page, 'bl=' + bin(0, 0, 1.5, 1) + '_' + bin(1.5, 0, 1.5, 1) + '~' + bin(0, 0, 3, 1, 2));
  expect(await page.evaluate(() => binIssues(layers[1].bins[0], 1)
    .filter((x) => typeof x === 'string'))).toEqual([]);
  await page.evaluate(() => { layers[0].bins[1].hUnits = 4; readControls(); drawMap(); refresh(); });
  expect(await page.evaluate(() => binIssues(layers[1].bins[0], 1).filter((x) => typeof x === 'string')))
    .toEqual(['spans bins of different heights below — it would rock']);
  // and a bin standing on one half-size bin only is off to the side of its own centre
  await page.evaluate(() => { layers[0].bins.splice(1, 1); readControls(); drawMap(); refresh(); });
  expect(await page.evaluate(() => binIssues(layers[1].bins[0], 1)[0])).toMatch(/^overhangs its support/);
});

/* The Steps switch shares the layer tabs' row while there is room, and drawMap fixed the
   map's height from the room above it. It measured before the map's own column was set,
   while the card was still the width the last draw left it; narrowed to the map, the card
   had no room for the switch beside two layers' tabs, the switch took a row of its own,
   and at 1366 x 768 the map, its front marker and the coverage bar went 38 px down, past
   the bottom of the window. The reason a place was refused, under the map, then pushed
   the bar 20 px further, even with one layer. Measured where it lands, with nothing
   scrolled: a drag through slotPoint would scroll the map to the middle first. */
test('at 1366 x 768 the map, its front, the reason under it and the coverage bar all fit', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openAt(page, 'bl=' + bin(0.5, 0, 1.5, 1) + '_' + bin(3, 3, 1, 1) + '~' + bin(3, 3, 1, 1, 2));
  const at = () => page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect().bottom;
    const why = $('stepWhy');
    return { said: why.textContent, map: r($('fillmap')), front: r(why.previousElementSibling),
             why: r(why), bar: r(document.querySelector('#s-layout .covbar')), fold: innerHeight };
  });
  const inView = (m) => {
    for (const k of ['map', 'front', 'why', 'bar'])
      expect(m[k], `${k} ends at ${m[k]}, inside the ${m.fold} px window`).toBeLessThanOrEqual(m.fold);
  };
  inView(await at());

  // a whole cell drawn half a cell in from the left, which the map refuses and says so
  const a = await slotHere(page, 1, 4), b = await slotHere(page, 2, 5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  const m = await at();
  expect(m.said).toBe('A whole-size bin sits on whole cells.');
  inView(m);
  expect(await page.evaluate(() => document.querySelector('.stage').scrollTop), 'nothing scrolled').toBe(0);
});

/* The reason under the map says it on the front marker's line, over the marker, so that
   saying it never moves the map or the coverage bar. That held for the one-line reason it
   was made for, but a carved bin made half-size on the map said three lines there: at
   1366 x 768 they ran from the marker to 23 px under the window, over the coverage bar,
   and on a phone they were a 58 px block over it. Under the map that is now said in a
   line of its own length, the long sentence stays under the size fields, and the line
   stays one line whatever it is given: an overlong one is cut short rather than let
   loose over the bar. Checked at each window size the page is laid out for, by Shift
   and an arrow, and at 1366 x 768 by a grip too, and with a reason too long for its line. */
test('a reason under the map stays on the front marker\'s line, at any window size', async ({ page }) => {
  const L = [3, 3, 2, 2, 3, 1.2, 1.2, 0, 0, 0, 1, 1, 1, 1, 0, 0, '1110', 0, 0, 0, 15].join('-');
  const hash = 'bl=' + bin(0.5, 0, 1.5, 1) + '_' + L;
  const short = 'A half-size bin cannot be carved.';
  const at = () => page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
    const why = $('stepWhy'), bar = document.querySelector('#s-layout .covbar');
    const b = bar.getBoundingClientRect();
    return { said: why.textContent, whole: why.scrollWidth <= why.clientWidth,
             why: r(why), front: r(why.previousElementSibling), bar: r(bar), map: r($('fillmap')),
             covered: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === why,
             fold: innerHeight, scrolled: document.querySelector('.stage').scrollTop };
  });
  const onItsLine = (m, where) => {
    expect(m.why.bottom, `${where}: on the marker's line`).toBeLessThanOrEqual(m.front.bottom + 0.5);
    expect(m.why.bottom, `${where}: clear of the coverage bar`).toBeLessThanOrEqual(m.bar.top);
    expect(m.covered, `${where}: the bar is not under the reason`).toBe(false);
  };
  const inView = (m, where) => {
    for (const k of ['map', 'front', 'why', 'bar'])
      expect(m[k].bottom, `${where}: ${k} inside the ${m.fold} px window`).toBeLessThanOrEqual(m.fold);
    expect(m.scrolled, `${where}: nothing scrolled`).toBe(0);
  };

  for (const [w, h] of [[1366, 768], [1024, 768], [1440, 900], [1920, 1080], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width: w, height: h });
    await openAt(page, hash);
    await select(page, 1);
    await page.keyboard.press('Shift+ArrowLeft');
    await settle(page);
    expect(await page.evaluate(() => [B()[1].u, B()[1].v, isCarved(B()[1])])).toEqual([1.5, 2, false]);
    const m = await at();
    expect(m.said, `${w} x ${h}`).toBe(short);
    expect(m.whole, `${w} x ${h}: said in full`).toBe(true);
    onItsLine(m, `${w} x ${h}`);
    if (w === 1366) inView(m, '1366 x 768');
  }

  // a grip pulled half a cell in on the same L, at 1366 x 768
  await page.setViewportSize({ width: 1366, height: 768 });
  await openAt(page, hash);
  await select(page, 1);
  const g = await page.locator('#fillmap .grip[data-handle="rb"]').boundingBox();
  const to = await slotHere(page, 8, 9);
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  expect(await page.evaluate(() => [B()[1].u, B()[1].v, isCarved(B()[1])])).toEqual([1.5, 2, false]);
  let m = await at();
  expect(m.said, 'by a grip').toBe(short);
  onItsLine(m, 'by a grip');
  inView(m, 'by a grip');

  // and a reason far longer than the line has room for is cut short, not let over the bar
  await page.evaluate(() => mapSay(SHAPE_DROPPED));
  m = await at();
  expect(m.said.length, 'fixture: a long reason').toBeGreaterThan(100);
  expect(m.whole, 'too long for one line').toBe(false);
  onItsLine(m, 'a long reason');
  inView(m, 'a long reason');
});

/* The Steps switch was first beside the layer tabs, and the map's card was kept as wide
   as that row. Measured with every tab, each layer took a tab's width, about 70 px, off
   the preview: four layers left it 391 px at 1366 x 768 rather than 587, beside a map
   centred in an empty card, in a drawer of whole bins too. Held at two layers' width,
   the switch took a row of its own from a third layer, and at 1366 x 768 that put the
   coverage bar 21 px under the window, where the old page kept it in view up to four.
   On a wider window the switch is now in the card's heading (placeSteps), so the tabs
   have their row as before and the number of layers costs the preview nothing; on a
   phone it stays on the tabs' row, where it was. */
test('more layers take none of the preview\'s width, and at 1366 x 768 keep the bar in view', async ({ page }) => {
  const one = bin(0, 0, 1, 1);
  const look = () => page.evaluate(() => {
    const card = $('s-layout').getBoundingClientRect();
    const inCard = [...document.querySelectorAll('#layerTabs button, .steps')]
      .every((el) => { const r = el.getBoundingClientRect(); return r.left >= card.left && r.right <= card.right; });
    const why = $('stepWhy'), bottom = (el) => el.getBoundingClientRect().bottom;
    return { preview: Math.round($('threewrap').getBoundingClientRect().width), inCard,
             tabs: Math.round($('layerTabs').getBoundingClientRect().height),
             steps: document.querySelector('#s-layout .steps').parentElement.matches('.layouthead') ? 'heading' : 'tabs',
             low: Math.max(bottom($('fillmap')), bottom(why.previousElementSibling), bottom(why),
                           bottom(document.querySelector('#s-layout .covbar'))),
             fold: innerHeight, scrolled: document.querySelector('.stage').scrollTop };
  });
  for (const [w, h, inView] of [[1366, 768, 4], [1920, 1080, 6]]) {
    await page.setViewportSize({ width: w, height: h });
    const seen = {};
    for (const n of [1, 2, 3, 4, 6]) {
      await openAt(page, 'bl=' + Array(n).fill(one).join('~'));
      const m = seen[n] = await look();
      const at = `${w} x ${h}, ${n} layers`;
      expect(m.steps, `${at}: the switch in the heading`).toBe('heading');
      expect(m.inCard, `${at}: every tab and the switch inside the card`).toBe(true);
      expect(m.preview, `${at}: no narrower than with one`).toBeGreaterThanOrEqual(seen[1].preview - 2);
      if (n <= inView) {
        expect(m.low, `${at}: the map, its front, the reason and the bar inside the window`)
          .toBeLessThanOrEqual(m.fold);
        expect(m.scrolled, `${at}: nothing scrolled`).toBe(0);
      }
    }
    // two layers' tabs, the one in use in bold, each on one line
    expect(seen[2].tabs, `${w} x ${h}: two layers' tabs each on one line`).toBe(seen[1].tabs);
  }
  /* On a phone the switch is on the tabs' row, as it was, and many tabs still fit the
     card. Taken there by a narrower window, and brought back by a wider one. */
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  expect((await look()).steps, 'narrowed to a phone').toBe('tabs');
  await openAt(page, 'bl=' + Array(6).fill(one).join('~'));
  const phone = await look();
  expect([phone.steps, phone.inCard], 'six layers on a phone').toEqual(['tabs', true]);
  await page.setViewportSize({ width: 1366, height: 768 });
  await settle(page);
  expect((await look()).steps, 'widened again').toBe('heading');
});

/* A size the selected bin refuses is left in the field while it is being typed, and put
   back once the field is left (sizeDraft). Left by pressing Fill the rest, the selection
   was gone before the bin had put it back, and with no bin selected the fields are the
   size of the next bin: a 2 typed for the 1.5 x 1 on a half step, refused, filled the
   drawer with 2 x 1 bins. Before half steps a refused size was written back at once. */
test('a size the selected bin refused does not become the size of new bins', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0.5, 0, 1.5, 1));
  await select(page, 0);
  await page.focus('#u');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('2', { delay: 250 });
  await settle(page);
  expect(await page.evaluate(() => [B()[0].u, $('u').value]), 'refused, and left as typed').toEqual([1.5, '2']);
  await page.click('#fillRest');
  await settle(page);
  const r = await page.evaluate(() => ({ u: state.u, field: $('u').value,
    twoWide: B().filter((b) => b.u === 2 && b.v === 1).length }));
  expect(r).toEqual({ u: 1.5, field: '1.5', twoWide: 0 });

  // and when a press on the map takes the selection, which it does before the field is left
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await binsNow(page), 'the fill undone').toEqual([[0.5, 0, 1.5, 1]]);
  await select(page, 0);
  await page.focus('#u');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('2', { delay: 250 });
  await settle(page);
  await H.clickCell(page, 4, 4);
  expect(await page.evaluate(() => [state.u, $('fillSize').textContent])).toEqual([1.5, '1.5×1']);
});

/* On a wider window the Steps switch is on the map card's heading row (placeSteps). It
   was put inside the <h3>, which made the heading's name "Drawer layout Steps Steps", from
   the switch's hidden label and its group's name, and put two buttons in a heading. It
   now stands beside the heading on the same row. Moved in the document across 980 px, it
   also took the focus with it: on Half cells at 1366 and narrowed to 900, the focus was
   on the page's body. And it set the card's width: in a wider font than this machine's,
   its heading needed 16 px more than the map, out of the preview on every layout. The
   title gives way now, and the card is the map's width whatever the font; DejaVu Sans is
   the wider font that showed it. */
test('the Steps switch is on the heading row, not in the heading, and keeps the card to the map', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openAt(page, 'bl=' + bin(0, 0, 1, 1));
  await expect(page.getByRole('heading', { name: 'Drawer layout', exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelectorAll(
    '.stage :is(h1, h2, h3, h4, h5, h6, [role=heading]) :is(button, [role=button])').length),
    'no button in a heading on the stage').toBe(0);
  const row = () => page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const head = r(document.querySelector('#s-layout h3')), steps = r(document.querySelector('#s-layout .steps'));
    return { onRow: steps.top >= head.top - 0.5 && steps.bottom <= head.bottom + 0.5,
             buttons: [...document.querySelectorAll('#s-layout .steps button')].map((b) => r(b).height),
             card: Math.round(r($('s-layout')).width), map: Math.round(r($('fillmap')).width) };
  });
  for (const font of [null, 'DejaVu Sans']) {
    if (font) {
      await page.evaluate((f) => { document.documentElement.style.setProperty('--sans', `'${f}'`); }, font);
      await settle(page);
      await page.evaluate(() => drawMap());
      await settle(page);
    }
    const m = await row();
    const at = font || 'this machine\'s font';
    expect(m.onRow, `${at}: the switch on the heading's row`).toBe(true);
    for (const h of m.buttons) expect(h, `${at}: a button 24 px tall or more`).toBeGreaterThanOrEqual(24);
    expect(m.card, `${at}: the card is what the map needs, its padding and border`).toBe(m.map + 30);
  }

  // the focus stays on the button it was on, wherever the switch goes
  await page.focus('#stepHalf');
  for (const [w, where] of [[900, 'tabs'], [1366, 'heading'], [981, 'heading'], [979, 'tabs'], [1366, 'heading']]) {
    await page.setViewportSize({ width: w, height: 768 });
    await settle(page);
    expect(await page.evaluate(() => [document.activeElement.id,
      document.querySelector('#s-layout .steps').parentElement.closest('.maptools') ? 'tabs' : 'heading']),
      `at ${w} px wide`).toEqual(['stepHalf', where]);
  }
});

/* An edit typed into the panel waits 180 ms for its pass (schedule). Pressing Fill the
   rest, or the map, inside that time took the selection away before the pass had run,
   and the refused 2 typed for the 1.5 x 1 on a half step became the new bins' size. The
   press is made the moment the 2 is typed, at a point measured beforehand. */
test('a size typed a moment before a press elsewhere still goes to the bin it was typed for', async ({ page }) => {
  for (const press of ['fill', 'map']) {
    await openAt(page, 'bl=' + bin(0.5, 0, 1.5, 1));
    await select(page, 0);
    const at = press === 'fill'
      ? await page.evaluate(() => { const b = $('fillRest'); b.scrollIntoView({ block: 'center' });
          const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })
      : await H.cellPoint(page, 4, 4);
    await page.focus('#u');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('2');
    await page.mouse.click(at.x, at.y);
    await settle(page);
    const r = await page.evaluate(() => ({ u: state.u, fill: $('fillSize').textContent,
      twoWide: B().filter((b) => b.u === 2 && b.v === 1).length }));
    expect(r, `pressed on ${press === 'fill' ? 'Fill the rest' : 'the map'}`)
      .toEqual({ u: 1.5, fill: '1.5×1', twoWide: 0 });
  }
});
