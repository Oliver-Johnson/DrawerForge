/* Dragging a bin into being is an edit, so Undo has to take it back.
 *
 * initMap's pointerdown handler pushed an undo snapshot on the 'resize' and 'move'
 * branches and not on 'create', and the pointerup that actually appends the bin did not
 * push one either. Every other mutating action in the file does — delete, duplicate,
 * fillRest, clearAll, merge, split, carve, nudge, layer add and remove — so the gap was
 * invisible next to them: the button and Ctrl+Z both worked, they simply had nothing to
 * work on, and on a fresh drawer the first bin you drew left Undo still greyed out.
 *
 * The snapshot has to be taken where the bin does not exist yet AND only when one is
 * really about to, which is inside the pointerup's canPlace guard rather than back at
 * pointerdown. The last case here is the one that tells those two apart: a drag that
 * ends across an occupied cell places nothing, and a snapshot pushed at pointerdown
 * would still file an entry for it, so the next Undo would spend itself restoring a
 * layout that had not changed and the bin you meant to remove would stay. Pushing at
 * pointerdown passes the first three cases and fails that one.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const undoBtn = (page) => page.locator('#undoBtn');

test('a bin dragged into being can be undone', async ({ page }) => {
  const errors = await H.openBins(page);
  const before = await H.bins(page);
  expect(before, 'the drawer starts empty, so undo has nothing banked yet').toEqual([]);
  await expect(undoBtn(page)).toBeDisabled();

  await H.dragCells(page, [1, 1], [2, 2]);
  const placed = await H.bins(page);
  expect(placed, 'the drag has to place a bin, or the rest measures nothing').toHaveLength(1);
  expect(placed[0]).toMatchObject({ x: 1, y: 1, u: 2, v: 2 });

  await expect(undoBtn(page), 'placing a bin is an edit and must be undoable').toBeEnabled();
  await undoBtn(page).click();
  await page.waitForTimeout(150);

  expect(await H.bins(page), 'undo puts the drawer back the way it was').toEqual(before);
  expect(errors).toEqual([]);
});

test('Ctrl+Z takes back a dragged bin too', async ({ page }) => {
  const errors = await H.openBins(page);

  await H.dragCells(page, [0, 0], [1, 0]);
  expect(await H.bins(page)).toHaveLength(1);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  expect(await H.bins(page), 'the keyboard path shares the stack the button uses').toEqual([]);

  /* Redo is the other half of the same entry: if create pushed a snapshot that undo
     could reach, redo must be able to put the bin back. */
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(150);
  const back = await H.bins(page);
  expect(back).toHaveLength(1);
  expect(back[0]).toMatchObject({ x: 0, y: 0, u: 2, v: 1 });
  expect(errors).toEqual([]);
});

test('undoing a new bin keeps the bins that were already there', async ({ page }) => {
  const errors = await H.openBins(page);

  await H.dragCells(page, [0, 0], [1, 1]);
  const one = await H.bins(page);
  expect(one).toHaveLength(1);

  await H.dragCells(page, [3, 0], [4, 1]);
  expect(await H.bins(page), 'two separate bins, not a merge').toHaveLength(2);

  await expect(undoBtn(page), 'the second drag is an edit too').toBeEnabled();
  await undoBtn(page).click();
  await page.waitForTimeout(150);

  /* The snapshot has to be the layout as it stood before the second drag — the first
     bin down to its footprint — and not an empty drawer. */
  expect(await H.bins(page)).toEqual(one);
  expect(errors).toEqual([]);
});

test('a drag that lands on an occupied cell files no undo entry', async ({ page }) => {
  const errors = await H.openBins(page);

  await H.dragCells(page, [0, 0], [1, 1]);          // bin A covers (0,0)..(1,1)
  const one = await H.bins(page);
  expect(one).toHaveLength(1);

  /* Starts on an empty cell, so this is a create drag, but the rectangle it ends up
     asking for runs back across A. canPlace refuses it and nothing is placed. */
  await H.dragCells(page, [3, 0], [1, 0]);
  expect(await H.bins(page), 'the drawer is unchanged, so nothing was placed').toEqual(one);

  /* One Undo, one edit undone. If the refused drag had banked a snapshot of its own,
     this click would restore the layout that drag never altered and A would survive. */
  await expect(undoBtn(page), 'placing A banked an entry to spend').toBeEnabled();
  await undoBtn(page).click();
  await page.waitForTimeout(150);
  expect(await H.bins(page), 'the single Undo reaches the bin that was really placed').toEqual([]);
  expect(errors).toEqual([]);
});

/* Clicking a bin only selects it, and a selection is not an edit. The press filed an undo
   step before it knew whether the bin would move, so after a click the next Undo spent
   itself on a layout that had not changed, and the click threw Redo away. */
test('selecting a bin is not an undo step, and moving it is one', async ({ page }) => {
  const errors = await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.dragCells(page, [3, 0], [3, 0]);
  expect(await H.bins(page)).toHaveLength(2);
  // one step spent and waiting on Redo, which a click must not throw away
  await undoBtn(page).click();
  await page.waitForTimeout(150);
  expect(await H.bins(page)).toHaveLength(1);
  const depth = () => page.evaluate(() => [undoStack.length, redoStack.length]);
  const before = await depth();

  await H.clickCell(page, 0, 0);
  expect(await page.evaluate(() => selected), 'the click has to select the bin').toBe(0);
  expect(await depth(), 'a click filed an undo step, or threw away Redo').toEqual(before);
  await expect(page.locator('#redoBtn')).toBeEnabled();

  // a real move is a step, and one Undo takes it back
  await H.dragCells(page, [0, 0], [1, 1]);
  expect((await H.bins(page))[0]).toMatchObject({ x: 1, y: 1 });
  await undoBtn(page).click();
  await page.waitForTimeout(150);
  expect((await H.bins(page))[0]).toMatchObject({ x: 0, y: 0 });
  expect(errors).toEqual([]);
});

/* The Drawers dialog sits over the drawer, and Ctrl+Z on one of its buttons used to take
   back a step of the layout behind it, which the dialog's Save would then have stored. */
test('Ctrl+Z with a dialog open leaves the drawer behind it alone', async ({ page }) => {
  const errors = await H.openBins(page);
  await H.dragCells(page, [1, 1], [2, 2]);
  expect(await H.bins(page)).toHaveLength(1);

  await page.locator('#drawersBtn').click();
  await expect(page.locator('#drawersDlg')).toBeVisible();
  await page.locator('#drawersClose').focus();          // a button in it, not a field
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  expect(await H.bins(page), 'the bin behind the dialog was undone').toHaveLength(1);

  // closed again, the shortcut is the drawer's as it was
  await page.locator('#drawersClose').click();
  await expect(page.locator('#drawersDlg')).toBeHidden();
  await page.locator('#undoBtn').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  expect(await H.bins(page)).toEqual([]);
  expect(errors).toEqual([]);
});
