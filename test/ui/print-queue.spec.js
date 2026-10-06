/* Printing a drawer a few bins at a time.
 *
 * A drawer is filled over several evenings, so half of it is already sitting there
 * while the rest is still to print. Arranging plates around parts you already own
 * wastes the plate. Marking a bin printed leaves it in the layout — it is in the
 * drawer, it is just not in the queue — and takes it out of everything you would
 * print from.
 *
 * These drive the page rather than calling types(), because the claim is about what
 * the plates and the export offer, not about what one function returns.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(700);

async function placeTwo(page) {
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.dragCells(page, [2, 0], [2, 0]);
  await settle(page);
}
const planText = (page) => page.locator('#plateSummary').textContent();

test('a bin marked printed leaves the plates but stays in the drawer', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  expect(await planText(page)).toMatch(/2 bins packed/);

  await H.clickCell(page, 0, 0);            // select the first
  await settle(page);
  await expect(page.locator('#doneRow')).toBeVisible();
  await page.check('#done');
  await settle(page);

  // out of the queue...
  expect(await planText(page)).toMatch(/1 bin packed/);
  expect(await page.locator('#totals').textContent()).toMatch(/1 bin still to print/);
  // ...but still in the drawer
  expect((await H.bins(page)).length).toBe(2);
  expect(await page.locator('#coverage').textContent()).toMatch(/2 bins/);
});

/* The figures follow the queue. A bin already sitting in the drawer costs nothing more
   and takes no more printing, so marking it printed takes its grams, its cost and its
   share of the plate's time off every total that quotes them — the page's and the
   README's alike. */
test('a bin marked printed comes off the weight, the cost and the time', async ({ page }) => {
  await H.openBins(page);
  await H.setField(page, 'filPrice', '20');
  await placeTwo(page);
  const figures = () => page.evaluate(() => ({
    g: jobEstimate().grams, min: jobEstimate().min,
    totals: document.getElementById('totals').textContent, readme: layoutReadme() }));
  const both = await figures();

  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.check('#done');
  await settle(page);
  const one = await figures();

  expect(one.g, 'two identical bins, one still to print').toBeCloseTo(both.g / 2, 6);
  expect(one.min).toBeLessThan(both.min);
  const cost = `$${(one.g / 1000 * 20).toFixed(2)}`;
  expect(one.totals).toContain(`about ${cost}`);
  expect(one.readme).toContain(`about ${one.g.toFixed(0)} g of PLA — about ${cost} at $20.00/kg`);
});

test('the toggle is hidden with nothing selected, so it cannot describe the next bin', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { B().forEach((b) => { b.sel = false; }); selected = -1; readControls(); });
  await settle(page);
  await expect(page.locator('#doneRow')).toBeHidden();
});

/* Neither half of this is enough on its own, which is worth stating because the first
   version of this test checked the wrong one and passed against everything.
   `done` is kept out of the settings object, AND new bins are built from an explicit
   field list rather than a spread of `state`. Break either and nothing happens; break
   both — route the flag through `t` and spread `state` into new bins, which is an
   ordinary tidy-up — and every bin drawn after a mark is born printed. This fails on
   that pair. It also needs the deselect below: with a bin selected the flag reaches
   only that bin, so the bug hides until you click away. */
test('marking one bin printed does not infect the bins drawn next', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.check('#done');
  await settle(page);

  /* Deselect BEFORE drawing the next one. That is the whole path: with a bin selected
     the flag only reaches that bin, so a version routed through `state` looks correct
     until you click away — readControls then writes the still-ticked box into the
     template for every bin drawn afterwards. Without this line the test passes against
     the bug it exists to catch. */
  await page.evaluate(() => { B().forEach((b) => { b.sel = false; }); selected = -1; readControls(); });
  await settle(page);

  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  const marks = await page.evaluate(() => B().map((b) => !!b.done));
  expect(marks.filter(Boolean).length, 'only the one that was marked').toBe(1);
  expect(await planText(page)).toMatch(/1 bin packed/);
});

test('mark every bin printed, and clear it again', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  await page.click('#markAllDone');
  await settle(page);
  expect(await page.evaluate(() => B().every((b) => b.done))).toBe(true);

  await page.click('#markNoneDone');
  await settle(page);
  expect(await page.evaluate(() => B().some((b) => b.done))).toBe(false);
  expect(await planText(page)).toMatch(/2 bins packed/);
});

/* The mark has to travel, or sharing a half-built drawer hands the recipient a plate
   of everything including what you already printed. */
test('the printed mark survives a reload', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.check('#done');
  await settle(page);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.evaluate(() => B().filter((b) => b.done).length)).toBe(1);
  expect(await planText(page)).toMatch(/1 bin packed/);
});

/* What a bin is FOR, wherever a bin is listed.
 *
 * The download table said "1×1×3 × 2". Standing over four identical printed shapes,
 * that is the one thing it cannot help you with — which of them is the one for drill
 * bits. The note you typed is the answer and it was on screen nowhere but the map.
 *
 * Notes are deliberately not part of typeKey: two bins of one shape share one STL
 * whatever they are for. So a type can carry several notes and all of them show.
 */
test('a bin note reaches the piece table and the download list', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.fill('#note', 'drill bits');
  await settle(page);

  await expect(page.locator('#typeRows')).toContainText('drill bits');

  await page.click('#openExport');
  await page.waitForTimeout(700);
  await expect(page.locator('#exportDlg')).toContainText('drill bits');
  await page.locator('#exportClose').click();
});

test('two bins of one shape with different notes list both against the one STL', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.fill('#note', 'M3 screws');
  await settle(page);

  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  await H.clickCell(page, 3, 3);
  await settle(page);
  await page.fill('#note', 'drill bits');
  await settle(page);

  await page.click('#openExport');
  await page.waitForTimeout(700);
  const dlg = page.locator('#exportDlg');
  await expect(dlg).toContainText('M3 screws');
  await expect(dlg).toContainText('drill bits');
  await page.locator('#exportClose').click();
});

/* Removable dividers, from the control to the part you can download.
 *
 * The geometry landed first and nothing reached it: no control, and typeKey did not
 * know the difference, so a railed bin and a fixed-divider bin of the same size would
 * have shared one STL and you would have printed the wrong one.
 */
test('removable dividers reach the bin, the type key and the download list', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);

  // nothing to make removable yet, so the control stays out of the way
  await expect(page.locator('#divRemovableRow')).toBeHidden();
  await page.fill('#divX', '1');
  await settle(page);
  await expect(page.locator('#divRemovableRow')).toBeVisible();

  await page.check('#divRemovable');
  await settle(page);
  expect(await page.evaluate(() => B()[0].divRemovable), 'the flag reaches the bin').toBe(true);

  await page.click('#openExport');
  await page.waitForTimeout(900);
  const dlg = page.locator('#exportDlg');
  await expect(dlg, 'the plate is a part you can print').toContainText('Divider');
  await expect(dlg, 'and it says what slot it drops into').toContainText('mm slot');
  await page.locator('#exportClose').click();
});

/* A railed bin and a fixed-divider bin of one size are different parts. If typeKey
   cannot tell them apart they share an STL, and half of what you print is wrong. */
test('a railed bin and a fixed-divider bin do not share an STL', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.fill('#divX', '1');
  await settle(page);

  await H.dragCells(page, [3, 3], [4, 4]);
  await settle(page);
  await H.clickCell(page, 3, 3);
  await settle(page);
  await page.fill('#divX', '1');
  await settle(page);
  await page.check('#divRemovable');
  await settle(page);

  const keys = await page.evaluate(() => types().map((t) => t.key));
  expect(new Set(keys).size, `two distinct parts, got ${JSON.stringify(keys)}`).toBe(2);
});

test('the removable flag survives a reload', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.fill('#divX', '1');
  await settle(page);
  await page.check('#divRemovable');
  await settle(page);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.evaluate(() => B()[0].divRemovable)).toBe(true);
});

/* The last gap: dividers on the print plates.
 *
 * The plates were built from bin types only, so a layout with removable dividers gave
 * you a plate of bins and nothing to divide them with — you would print the whole
 * drawer and then have to come back for the parts that make it work. The plate is also
 * what the 3MF carries, so a divider missing here is missing from the file people
 * actually feed their slicer.
 */
test('divider plates are packed onto the print plates, and counted as dividers', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.fill('#divX', '2');
  await settle(page);

  await page.check('#divRemovable');
  await page.waitForTimeout(1400);
  const ids = await page.evaluate(() =>
    printPlan.plates.flatMap((pl) => pl.placed.map((x) => String(x.id))));
  expect(ids.filter((i) => i.startsWith('div:')).length,
    'two dividers on the bin means two plates to print').toBe(2);

  // and they are named as what they are, not counted in with the bins
  await expect(page.locator('#plateSummary')).toContainText('2 dividers');
  await expect(page.locator('#plateSummary')).toContainText('1 bin');

  // turning it off takes them away again
  await page.uncheck('#divRemovable');
  await page.waitForTimeout(1400);
  await expect(page.locator('#plateSummary')).not.toContainText('divider');
});

/* A plate is only useful if the 3MF carries the same parts the picture showed. */
test('every part on a plate can be resolved back to a mesh', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.fill('#divX', '1');
  await settle(page);
  await page.check('#divRemovable');
  await page.waitForTimeout(1400);

  const unresolved = await page.evaluate(() => {
    const out = [];
    for (const pl of printPlan.plates)
      for (const p of pl.placed) {
        const t = printPlan.types.find((x) => x.key === p.id);
        if (!t || !t.polys || !t.polys().length) out.push(String(p.id));
      }
    return out;
  });
  expect(unresolved, 'a placed part with no mesh would silently vanish from the 3MF')
    .toEqual([]);
});

/* A lid for a bin.
 *
 * Measured off four reference lids before any of it was written, which changed the
 * design: none used clips, all used a skirt mirroring the lip's inner funnel. What the
 * page has to get right is narrower — that the part is offered only where it can
 * actually attach, and that it reaches the plate rather than stopping at a checkbox.
 */
test('a lid becomes a part, on the plate and in the download list', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);

  await page.check('#lid');
  await page.waitForTimeout(1400);
  expect(await page.evaluate(() => B()[0].lid)).toBe(true);

  // on the plate, and counted as a lid rather than folded in with the bins
  await expect(page.locator('#plateSummary')).toContainText('1 lid');
  const ids = await page.evaluate(() =>
    printPlan.plates.flatMap((pl) => pl.placed.map((x) => String(x.id))));
  expect(ids.filter((i) => i.startsWith('lid:')).length).toBe(1);

  await page.click('#openExport');
  await page.waitForTimeout(800);
  await expect(page.locator('#exportDlg')).toContainText('Lid 2×2');
  await page.locator('#exportClose').click();
});

/* The one rule the geometry cannot enforce: a lid grips the stacking lip, and lowering
   any wall drops the lip from all four. Offering one anyway would hand someone a part
   that cannot attach to the bin it was made for. */
test('a bin with a lowered wall is refused a lid, with the reason', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.check('#lid');
  await page.waitForTimeout(1400);
  await expect(page.locator('#plateSummary')).toContainText('lid');

  await page.selectOption('#edgeF', '0.5');
  await page.waitForTimeout(1400);
  await expect(page.locator('#lidNoLip'), 'say why, rather than silently doing nothing')
    .toBeVisible();
  await expect(page.locator('#plateSummary')).not.toContainText('lid');
});

test('leaving a side off the lid changes the part, and survives a reload', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.check('#lid');
  await page.waitForTimeout(1200);
  await page.uncheck('#lidF');
  await page.waitForTimeout(1400);

  expect(await page.evaluate(() => B()[0].lidSides.f)).toBe(false);
  await page.click('#openExport');
  await page.waitForTimeout(800);
  await expect(page.locator('#exportDlg'), 'the part names the sides it actually has')
    .toContainText('sides');
  await page.locator('#exportClose').click();

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.evaluate(() => B()[0].lid)).toBe(true);
  expect(await page.evaluate(() => B()[0].lidSides.f)).toBe(false);
});
