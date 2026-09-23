/* Finding "design one bin" without reading past the thing you are not doing.
 *
 * The two ways in were the bottom of panel 03 — which only appears with nothing selected
 * — and a button under the drawer map. Both sit below a large panel about laying out a
 * whole drawer, so someone who wants one bin has to read past it to find it.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { openBins, openPlates } = require('./helpers');

const inMode = (page) => page.evaluate(() => ({
  loose: document.body.classList.contains('binscratch'),
  scratch: !!scratch,
}));

test('the way in is in the header, before any panel', async ({ page }) => {
  const errors = await openBins(page);
  const btn = page.locator('#scratchBinTop');
  await expect(btn).toBeVisible();

  /* In the header itself, not merely early in the document — that is what makes it
     findable without scrolling past the drawer-layout panel. */
  expect(await btn.evaluate((el) => !!el.closest('header')),
    'it lives in the header').toBe(true);

  /* Above the panel it used to be buried at the bottom of. */
  const top = await btn.boundingBox();
  const panel = await page.locator('#s-bin').boundingBox();
  expect(top.y, 'and above the bin panel, not below it').toBeLessThan(panel.y);
  expect(errors).toEqual([]);
});

test('it opens the same loose bin the old ways in do', async ({ page }) => {
  const errors = await openBins(page);
  await page.locator('#scratchBinTop').click();
  await page.waitForTimeout(300);

  const m = await inMode(page);
  expect(m.loose, 'the body class the mode is defined by').toBe(true);
  expect(m.scratch, 'and a real loose bin behind it').toBe(true);
  /* One shared handler, so this cannot drift from the other two entry points. */
  expect(await page.evaluate(() => layers[cur].bins.length),
    'still in no layer — a loose bin is not a drawer bin').toBe(0);
  expect(errors).toEqual([]);
});

/* Already designing one bin, so the way in is noise. The way OUT is the focus bar's job. */
test('it gets out of the way once you are in the mode', async ({ page }) => {
  await openBins(page);
  await expect(page.locator('#scratchBinTop')).toBeVisible();
  await page.locator('#scratchBinTop').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#quickstart')).toBeHidden();

  await page.locator('#scratchDrop').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#quickstart'),
    'and comes back when the drawer does').toBeVisible();
});

/* The header is shared furniture. Bins-only markup belongs in the bins template, and the
   proof is that the baseplates page never grew a button for a mode it does not have. */
test('the baseplates page does not sprout a bins control', async ({ page }) => {
  await openPlates(page);
  expect(await page.locator('#scratchBinTop').count(),
    'chrome.js is shared; this control is not').toBe(0);
});
