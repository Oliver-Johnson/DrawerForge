/* Choosing where a loose bin lands, from the page the loose bin is on.
 *
 * scratchLanding() refuses a bin with "no free U×V space on layer N — clear some cells,
 * or add a layer". Both remedies it names lived inside #s-layout, which focus hides
 * wholesale, so the only way to take either was to discard the bin, fix the drawer, and
 * start again. These cases pin the two controls that answer it, and the one thing about
 * them that is easy to get wrong.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { openBins, dragCells, bins, setField } = require('./helpers');

const start = async (page) => {
  await page.locator('#scratchBinMap').click();
  await page.waitForTimeout(250);
};
const why = (page) => page.evaluate(() => document.getElementById('scratchWhy').textContent);
const layerCount = (page) => page.evaluate(() => layers.length);
const curLayer = (page) => page.evaluate(() => cur);
const undoDepths = (page) => page.evaluate(() => ({
  drawer: undoStack.length, loose: sUndoStack.length }));

test('the loose bin can see and choose the layer it will land on', async ({ page }) => {
  const errors = await openBins(page);
  await page.locator('#addLayer').click();          // two layers in the drawer
  await start(page);

  await expect(page.locator('#scratchTarget')).toBeVisible();
  const opts = await page.locator('#scratchLayer option').allTextContents();
  expect(opts, 'one option per layer, named the way the tabs name them').toHaveLength(2);
  expect(opts[0]).toContain('Layer 1');
  expect(opts[1]).toContain('Layer 2');
  expect(errors).toEqual([]);
});

test('choosing another layer re-answers the landing question straight away',
  async ({ page }) => {
    await openBins(page);
    /* Added from the drawer, because #addLayer is hidden inside the mode -- which is the
       whole reason this feature exists. The picker is the way in from here. */
    await page.locator('#addLayer').click();
    await start(page);
    await setField(page, 'u', 2);
    await setField(page, 'v', 2);

    await page.locator('#scratchLayer').selectOption('0');
    await page.waitForTimeout(150);
    expect(await curLayer(page)).toBe(0);
    expect(await why(page), 'the reason follows the layer, not the one it was written for')
      .toContain('layer 1');

    await page.locator('#scratchLayer').selectOption('1');
    await page.waitForTimeout(150);
    expect(await curLayer(page)).toBe(1);
    expect(await why(page)).toContain('layer 2');
  });

/* The refusal in full: fill layer 1, then resolve it without leaving the page. */
test('adding a layer from here clears a refusal that had no answer on this page',
  async ({ page }) => {
    await openBins(page);
    const g = await page.evaluate(() => { const q = grid(); return { nx: q.nx, ny: q.ny }; });
    /* Layer 1 covered edge to edge by ONE bin, so a landing spot on layer 2 is certain
       wherever the loose bin ends up. That is the only reason for full coverage here --
       NOT that a partial layer would refuse the bin. Support is judged per bin: seat(b, k)
       walks the new bin's own footprint and nothing else, so a mostly-empty layer below
       takes a bin quite happily as long as the cells directly under it are covered on
       every layer beneath and come out level. A footprint larger than the support under
       it is what gets refused. */
    await dragCells(page, [0, 0], [g.nx - 1, g.ny - 1]);
    expect((await bins(page)).length).toBe(1);

    await start(page);
    await setField(page, 'u', 2);
    await setField(page, 'v', 2);
    await expect(page.locator('#scratchAdd'),
      'layer 1 is full, so there is nowhere to land').toBeDisabled();
    expect(await why(page)).toContain('add a layer');

    await page.locator('#scratchAddLayer').click();
    await page.waitForTimeout(250);
    expect(await layerCount(page)).toBe(2);
    expect(await curLayer(page), 'the new layer becomes the target, or the button did nothing')
      .toBe(1);
    await expect(page.locator('#scratchAdd'),
      'the full layer below supports the new one, so the bin can land').toBeEnabled();
    expect(await why(page)).toContain('layer 2');
  });

/* The one that is easy to get wrong. snapshot() in scratch mode captures ONLY the loose
 * bin, and pushUndo files it on the loose bin's stack. Adding a layer edits the DRAWER,
 * so routing it through pushUndo would bank an entry on the wrong stack: undoing it
 * restores the bin, leaves the new layer standing, and spends an Undo that appears to do
 * nothing at all. */
test('adding a layer banks its undo on the drawer, not on the loose bin',
  async ({ page }) => {
    await openBins(page);
    await start(page);
    const before = await undoDepths(page);

    await page.locator('#scratchAddLayer').click();
    await page.waitForTimeout(200);
    expect(await layerCount(page)).toBe(2);

    const after = await undoDepths(page);
    expect(after.loose, 'the loose bin did not change, so its history must not have grown')
      .toBe(before.loose);
    expect(after.drawer, 'the drawer gained a layer, so the drawer is where it is undoable')
      .toBe(before.drawer + 1);

    /* And it really undoes, once you are back in the drawer looking at it. */
    await page.locator('#scratchDrop').click();
    await page.waitForTimeout(200);
    expect(await layerCount(page)).toBe(2);
    await page.locator('#undoBtn').click();
    await page.waitForTimeout(200);
    expect(await layerCount(page), 'the drawer stack holds the layer, so Undo takes it back')
      .toBe(1);
  });
