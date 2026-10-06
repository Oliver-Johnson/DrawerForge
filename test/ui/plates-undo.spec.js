/* Undo on the baseplates page.
 *
 * Bins has had Undo from the start; this page had none, so one stray click on the cut
 * map — which switches the whole split to Manual — or a figure typed into the wrong
 * field could only be reversed by remembering what was there before.
 *
 * The design is compared as the serialised string the share link carries, read out of
 * the page, rather than as a handful of field values. That string is what undo stores
 * and what it restores, and it covers every setting, so "back to the original design"
 * is checked as exactly that and not as "the width looks right".
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const design = (page) => page.evaluate(() => encodeDesc(descriptor()));
const undoBtn = (page) => page.locator('#undoBtn');
const redoBtn = (page) => page.locator('#redoBtn');
const settle = (page) => page.waitForTimeout(300);

/* Click a cut-map grid line the way a person does, with the real mouse. The hit lines
   are 11 px of transparent stroke and they cross each other at every grid junction, so
   clicking the middle of one's box can land on its neighbour. This walks along the line
   until the browser agrees the point is on it. */
async function clickGridLine(page, selector) {
  await page.evaluate(() => document.getElementById('cutmap').scrollIntoView({ block: 'center' }));
  const p = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    for (let f = 0.1; f < 0.95; f += 0.05) {
      const x = r.left + r.width / 2, y = r.top + r.height * f;
      if (document.elementFromPoint(x, y) === el) return { x, y };
    }
    return null;
  }, selector);
  expect(p, `no clickable point on ${selector}`).not.toBeNull();
  await page.mouse.click(p.x, p.y);
  await settle(page);
}

test('undo walks back a dimension and a cut, and redo walks forward again', async ({ page }) => {
  const errors = await H.openPlates(page);
  const original = await design(page);
  await expect(undoBtn(page), 'nothing has happened yet, so there is nothing to undo').toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();

  await H.setField(page, 'drawerW', '500');
  const wider = await design(page);
  expect(wider).not.toBe(original);
  await expect(undoBtn(page)).toBeEnabled();

  // the stray click: any grid line on the map turns the split into a manual one
  await clickGridLine(page, '#cutmap .hitline[data-col]');
  const cut = await design(page);
  expect(cut, 'the click has to have changed the split, or undo has nothing to show')
    .toContain('sp=manual');

  await undoBtn(page).click();
  await settle(page);
  expect(await design(page), 'one undo takes back the click and only the click').toBe(wider);
  await expect(page.locator('#splitSeg button.on')).not.toHaveText('Manual');

  await undoBtn(page).click();
  await settle(page);
  expect(await design(page), 'two undos are back to the design the page opened with')
    .toBe(original);
  expect(await page.inputValue('#drawerW')).toBe('306');
  await expect(undoBtn(page)).toBeDisabled();

  // and redo is the same two steps the other way
  await expect(redoBtn(page)).toBeEnabled();
  await redoBtn(page).click();
  await settle(page);
  expect(await design(page)).toBe(wider);
  await redoBtn(page).click();
  await settle(page);
  expect(await design(page)).toBe(cut);
  await expect(redoBtn(page)).toBeDisabled();

  /* A fresh edit after undoing forks the history, and the abandoned branch is gone —
     redo must not resurrect a step that no longer follows from what is on screen. */
  await undoBtn(page).click();
  await settle(page);
  await page.selectOption('#connector', 'hclip');
  await settle(page);
  await expect(redoBtn(page)).toBeDisabled();
  expect(errors).toEqual([]);
});

/* Every kind of setting goes through the one recorder, so a select, a checkbox and a
   split button are each one step — the cases a per-handler push is most likely to miss. */
test('a select, a checkbox and a split button are each one step', async ({ page }) => {
  const errors = await H.openPlates(page);
  const steps = [await design(page)];
  await page.selectOption('#connector', 'puzzle');
  await settle(page);
  steps.push(await design(page));
  await page.locator('#magnets').check();
  await settle(page);
  steps.push(await design(page));
  await page.locator('#splitSeg button[data-v="staggered"]').click();
  await settle(page);
  steps.push(await design(page));
  expect(new Set(steps).size, 'each edit really changed the design').toBe(4);

  for (let i = steps.length - 2; i >= 0; i--) {
    await undoBtn(page).click();
    await settle(page);
    expect(await design(page)).toBe(steps[i]);
  }
  await expect(undoBtn(page)).toBeDisabled();
  expect(await page.inputValue('#connector')).toBe('dovetail');
  expect(await page.isChecked('#magnets')).toBe(false);
  expect(errors).toEqual([]);
});

test('Ctrl+Z and Ctrl+Shift+Z share the stack the buttons use', async ({ page }) => {
  const errors = await H.openPlates(page);
  const original = await design(page);
  await H.setField(page, 'drawerW', '500');
  const wider = await design(page);
  await page.selectOption('#marginMode', 'none');
  await settle(page);
  const noMargin = await design(page);

  // focus on the page, not in a field — where the shortcut is the design's
  await page.locator('#undoBtn').focus();
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await design(page)).toBe(wider);
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await design(page)).toBe(original);

  await page.keyboard.press('Control+Shift+z');
  await settle(page);
  expect(await design(page)).toBe(wider);
  await page.keyboard.press('Control+y');
  await settle(page);
  expect(await design(page)).toBe(noMargin);
  expect(errors).toEqual([]);
});

/* A number typed is one step however many keys it took, so Undo takes back what you
   typed rather than its last digit. The pause in the middle is deliberate: a build runs
   between the keystrokes and holds the page while it does, which is what split a typed
   number into several steps while the run was measured with a clock. */
test('typing a number is one step, not one per keystroke', async ({ page }) => {
  const errors = await H.openPlates(page);
  const original = await design(page);

  await page.locator('#drawerW').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('5');
  await page.waitForTimeout(1500);                    // a build gets in between the keys
  await page.keyboard.type('12');
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('512');
  // and the page computed with it, not merely displayed it
  expect(await design(page)).toContain('w=512');

  // Enter commits the field, so what is typed next is a step of its own
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('600');
  await settle(page);
  expect(await design(page)).toContain('w=600');

  await undoBtn(page).click();
  await settle(page);
  expect(await page.inputValue('#drawerW'), 'the second run is its own step').toBe('512');
  await undoBtn(page).click();
  await settle(page);
  expect(await design(page), 'and one Undo took back all three keys of the first')
    .toBe(original);
  await expect(undoBtn(page)).toBeDisabled();
  expect(errors).toEqual([]);
});

/* Inside a field, Ctrl+Z is the field's. Someone pressing it mid-number means "take back
   what I just typed", and the browser already does that well; the page answering too would
   undo a second, unrelated thing at the same time. Told apart by the redo button: the
   page's undo always leaves something to redo, the browser's never touches the stack. */
test('Ctrl+Z inside a field is left to the field', async ({ page }) => {
  const errors = await H.openPlates(page);
  await H.setField(page, 'drawerW', '500');           // a step the page owns
  const wider = await design(page);

  await page.locator('#drawerD').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('450');
  await settle(page);
  expect(await design(page)).toContain('d=450');

  await page.keyboard.press('Control+z');             // still focused in the field
  await settle(page);
  /* How much one press takes back is the browser's business — Chromium undoes a typed
     character at a time here — so this asserts only that the field moved and nothing
     else did. */
  expect(await page.inputValue('#drawerD'), 'the browser undid some typing').not.toBe('450');
  expect(await page.inputValue('#drawerW'), 'and the page did not undo anything else')
    .toBe('500');
  await expect(redoBtn(page), 'the page never spent a step of its own').toBeDisabled();

  // keep pressing, in the field, until the browser is back to the value before the typing
  for (let i = 0; i < 6 && await page.inputValue('#drawerD') !== '380'; i++) {
    await page.keyboard.press('Control+z');
    await settle(page);
  }
  expect(await page.inputValue('#drawerD')).toBe('380');
  expect(await design(page)).toBe(wider);
  await expect(redoBtn(page)).toBeDisabled();

  /* The typing opened a step and then typed its way back to where it began, so that
     step is gone — the next Undo is the width, not a no-op. */
  await undoBtn(page).click();
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('306');
  expect(errors).toEqual([]);
});

/* Only a field you type in has an undo of its own to leave Ctrl+Z to. Focus stays on a
   list after you pick from it and on a box after you tick it, and the shortcut used to
   stand aside for every <input> and <select> alike — so Ctrl+Z straight after choosing a
   joint or ticking Magnets did nothing at all. */
test('Ctrl+Z straight after picking from a list or ticking a box takes it back',
  async ({ page }) => {
    const errors = await H.openPlates(page);
    const original = await design(page);

    await page.locator('#connector').focus();
    await page.selectOption('#connector', 'puzzle');
    await settle(page);
    expect(await design(page)).not.toBe(original);
    expect(await page.evaluate(() => document.activeElement.id),
      'fixture: focus is still on the list').toBe('connector');
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await design(page), 'Ctrl+Z on the list took back the pick').toBe(original);
    expect(await page.inputValue('#connector')).toBe('dovetail');

    await page.locator('#magnets').check();
    await settle(page);
    expect(await page.evaluate(() => document.activeElement.id),
      'fixture: focus is on the box').toBe('magnets');
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await page.isChecked('#magnets'), 'Ctrl+Z on the box took back the tick').toBe(false);
    expect(await design(page)).toBe(original);
    expect(errors).toEqual([]);
  });

/* A dialog has the keyboard, and the design behind it is not what is being worked on.
   Ctrl+Z on one of the Drawers dialog's buttons took back a step of the design out of
   sight underneath it, and the dialog's own Save then stored the design as it was one
   step before. */
test('Ctrl+Z with a dialog open leaves the design behind it alone', async ({ page }) => {
  const errors = await H.openPlates(page);
  await H.setField(page, 'drawerW', '500');           // a step there to be undone
  const wider = await design(page);

  await page.locator('#drawersBtn').click();
  await expect(page.locator('#drawersDlg')).toBeVisible();
  await page.locator('#drawersClose').focus();        // a button in it, not a field
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await design(page), 'the design behind the dialog was undone').toBe(wider);
  await expect(redoBtn(page), 'and no step of it was spent').toBeDisabled();

  // closed again, the shortcut is the design's as it was
  await page.locator('#drawersClose').click();
  await expect(page.locator('#drawersDlg')).toBeHidden();
  await page.locator('#undoBtn').focus();
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('306');
  expect(errors).toEqual([]);
});

/* The page keeps the design in the address bar with replaceState. Undo goes through the
   same save, and it must not be the thing that starts filling the back button with
   entries — leaving the tool would then take one press per undo. */
test('undo and redo add nothing to the browser history', async ({ page }) => {
  const errors = await H.openPlates(page);
  const start = await page.evaluate(() => history.length);
  await H.setField(page, 'drawerW', '450');
  await H.setField(page, 'drawerD', '420');
  await page.waitForTimeout(600);                     // past the address-bar debounce
  for (const b of ['#undoBtn', '#undoBtn', '#redoBtn', '#undoBtn']) {
    await page.locator(b).click();
    await page.waitForTimeout(600);
  }
  expect(await page.inputValue('#drawerW')).toBe('306');
  expect(await page.evaluate(() => history.length)).toBe(start);
  // and the address bar followed the undo, so a reload keeps where you undid to
  expect(await page.evaluate(() => location.hash)).toContain('w=306');
  expect(errors).toEqual([]);
});
