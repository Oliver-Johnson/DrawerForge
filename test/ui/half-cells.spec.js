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

test('the arrow keys move a half-size bin half a cell only with half steps on', async ({ page }) => {
  await openAt(page, 'bl=' + bin(0, 0, 1.5, 1));
  await select(page, 0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  expect(await binsNow(page)).toEqual([[0.5, 0.5, 1.5, 1]]);
  // shift resizes in halves too — never into a whole size at a half step — and stops at half a cell
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await binsNow(page), '1 x 1 at column 1.5 is refused').toEqual([[0.5, 0.5, 1.5, 1]]);
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
  await openAt(page, 'bl=' + bin(0, 0, 0.5, 2) + '_' + bin(1, 0, 2, 0.5) + '_' + bin(3, 0, 1.5, 1));
  const w = await page.locator('#warnings').innerText();
  expect(w).toContain('the 0.5×2 bin at column 1 row 1: is only half a cell wide. On a standard ' +
    'baseplate the bins beside it hold it in place; on its own it can slide about 21 mm in its socket.');
  expect(w).toContain('the 2×0.5 bin at column 2 row 1: is only half a cell deep.');
  expect(w, 'a bin a cell and a half across is held by its own feet').not.toContain('1.5×1 bin');
  // a note, not a fault
  expect(await page.locator('#warnings .w.err').count()).toBe(0);
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
