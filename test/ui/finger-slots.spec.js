/* Finger slots on the bins page: the four toggles under the wall menus in panel 03, the
 * hint under them, the notes Checks gains, the lip they take away, and a bin with slots
 * as a part and a file of its own.
 *
 * The geometry is the audit's (test/bin-audit.js reads every slot's bottom and sides off
 * the mesh). What is tested here is that the page asks for what it says it does, says
 * what the bin gets, and keeps every layout without slots exactly as it was.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(400);
const slot = async (page, side, on = true) => {
  const box = page.locator(`#finger${side}`);
  if (on) await box.check(); else await box.uncheck();
  await settle(page);
};
const checks = (page) => page.locator('#warnings');
const HINT = 'A U-shaped dip in the top of the wall, one per compartment, for getting a finger in. ' +
  'Like a lowered wall, it removes the stacking lip.';

test.beforeEach(async ({ page }) => {
  await H.forgetSaved(page);
  page.__errors = await H.openBins(page);
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

test('four toggles under the wall menus, none on, with the hint under them', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  const row = page.locator('#fingerRow');
  await expect(row).toBeVisible();
  await expect(row.locator('#fingerLabel')).toHaveText('Finger slot:');
  await expect(row).toHaveAttribute('role', 'group');
  expect(await row.locator('label.tog').allTextContents()).toEqual([' Front', ' Back', ' Left', ' Right']);
  for (const k of ['F', 'B', 'L', 'R']) {
    await expect(page.locator(`#finger${k}`)).not.toBeChecked();
    await expect(page.locator(`#finger${k}`)).toHaveAttribute('aria-describedby', 'fingerHint');
  }
  await expect(page.locator('#fingerHint')).toHaveText(HINT);
  // under the wall menus, before the feet
  expect(await page.evaluate(() => {
    const at = (id) => [...document.querySelectorAll('#s-bin [id]')].indexOf(document.getElementById(id));
    return at('edgeRowB') < at('fingerRow') && at('fingerRow') < at('fingerHint') && at('fingerHint') < at('feetRow');
  })).toBe(true);
  const lines = await page.evaluate(() => {
    const h = document.getElementById('fingerHint');
    return h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight);
  });
  expect(lines, 'no more than four lines, so it needs no "more"').toBeLessThanOrEqual(4.05);

  // a solid block has no walls to dip
  await page.locator('#solid').check();
  await settle(page);
  await expect(row).toBeHidden();
  await expect(page.locator('#fingerHint')).toBeHidden();
});

test('a front slot builds one, takes the lip, and makes the bin its own part', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);               // a 1x1x3, selected
  const plain = await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0]), geomFor(B()[0]).vol,
                                           packBin(B()[0])]);
  await expect(page.locator('#hResult')).toContainText('+ 3.95 mm lip');

  await slot(page, 'F');
  const [key, name, vol, meta, link] = await page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return [typeKey(b), typeName(types()[0]), geomFor(b).vol, { n: m.fingers, walls: m.fingerWalls, lip: m.hasLip }, packBin(b)];
  });
  expect(meta).toEqual({ n: 1, walls: 'f', lip: false });
  expect(key, 'a bin with a slot is its own part').toBe(plain[0] + '-slot-f');
  expect(name).toBe('bin-1x1x3-slot-f-qty1');
  expect(plain[1]).toBe('bin-1x1x3-qty1');
  expect(vol, 'the filament estimate leaves out the wall the slot takes, and the lip').toBeLessThan(plain[2]);
  expect(link.split('-').slice(21), 'the slot rides in the feet field: 8 for the front').toEqual(['8']);
  await expect(page.locator('#hResult'), 'no lip quoted').not.toContainText('lip');
  await expect(page.locator('#typeRows')).toContainText('1 finger slot, front');

  // every wall: one slot each, 8 + 16 + 32 + 64
  for (const k of ['B', 'L', 'R']) await slot(page, k);
  expect(await page.evaluate(() => [packBin(B()[0]).split('-')[21], typeName(types()[0]), geomFor(B()[0]).meta.fingers]))
    .toEqual(['120', 'bin-1x1x3-slot-fblr-qty1', 4]);
  await expect(page.locator('#typeRows')).toContainText('4 finger slots, front, back, left and right');

  // a lid has no lip to grip, and the panel says why in the slot's own words
  await page.locator('#lid').check();
  await settle(page);
  await expect(page.locator('#lidNoLipSlot')).toBeVisible();
  await expect(page.locator('#lidNoLipSlot')).toHaveText(
    'This bin has a finger slot, so it has no stacking lip for a lid to grip. Turn its finger slots off to give it one.');
  await expect(page.locator('#lidNoLip')).toBeHidden();
  await expect(page.locator('#lidHint')).toBeHidden();
  expect(await page.evaluate(() => lidParts().length)).toBe(0);
  await page.locator('#lid').uncheck();
  await settle(page);

  // off again, it is the plain bin with the plain link
  for (const k of ['F', 'B', 'L', 'R']) await slot(page, k, false);
  expect(await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0]), packBin(B()[0])]))
    .toEqual([plain[0], plain[1], plain[3]]);
  expect(plain[3].split('-').length).toBe(21);
  await expect(page.locator('#hResult')).toContainText('+ 3.95 mm lip');
});

test('Checks says what makes way and which walls get none, as notes', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  // a back slot takes the label shelf, and the note raised on it
  await H.setField(page, 'label', 12);
  await page.locator('#labelMode').selectOption('1');
  await page.locator('#note').fill('M3 screws');
  await settle(page);
  await slot(page, 'B');
  await expect(checks(page)).toContainText('has a finger slot in its back wall, so its label shelf is left off and its note is not printed');
  await expect(page.locator('#noteHint')).toHaveText(
    'A finger slot in the back wall takes the label shelf’s place, so the note does not print.');
  await slot(page, 'B', false);
  await expect(checks(page)).not.toContainText('finger slot');
  await page.locator('#labelMode').selectOption('0');
  await H.setField(page, 'label', 0);

  // a front slot holds the scoop under it
  await H.setField(page, 'scoop', 12);
  await slot(page, 'F');
  await expect(checks(page)).toContainText('has a finger slot in its front wall, so its scoop is held to 6.8 mm, under the slot');
  await H.setField(page, 'scoop', 0);

  // compartments too narrow
  await H.setField(page, 'divX', 3);
  await expect(checks(page)).toContainText('has compartments under 15 mm across along its front wall, too narrow for a finger slot, so it has none there');
  expect(await page.evaluate(() => [geomFor(B()[0]).meta.fingers, typeName(types()[0])])).toEqual([0, 'bin-1x1x3-3x0div-qty1']);
  await H.setField(page, 'divX', 0);

  // a wall too low, and one open
  await H.setField(page, 'hUnits', 1);
  await expect(checks(page)).toContainText('has its front wall too low for a finger slot, so it has none there');
  await H.setField(page, 'hUnits', 3);
  await page.selectOption('#edgeF', '0');
  await settle(page);
  await expect(checks(page)).toContainText('has its front wall open, so there is no finger slot there');
  // a lowered one gets its slot from its own top
  await page.selectOption('#edgeF', '0.5');
  await settle(page);
  expect(await page.evaluate(() => geomFor(B()[0]).meta.fingers)).toBe(1);
  await expect(checks(page)).not.toContainText('finger slot');
  await page.selectOption('#edgeF', '1');
  await settle(page);

  // holes across the floor that stand too high for one
  await page.selectOption('#insert', '1');
  await settle(page);
  await expect(checks(page)).toContainText('has its holes for AA batteries reaching too high for a finger slot in its front wall, so it has none there');
  await page.selectOption('#insert', '0');
  await settle(page);
  expect(await page.locator('#warnings .w.err').count(), 'notes, not faults').toBe(0);
});

test('a half-size bin gets slots where they fit, and a carved one none', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 1]);               // a 2x2, selected
  await slot(page, 'F');
  expect(await page.evaluate(() => geomFor(B()[0]).meta.fingers)).toBe(1);
  await H.clickCell(page, 1, 1, ['Alt']);
  expect(await page.evaluate(() => isCarved(B()[0]))).toBe(true);
  await settle(page);
  await expect(checks(page)).toContainText('is a carved shape, so its finger slots are left off: they need a rectangle');
  expect(await page.evaluate(() => [geomFor(B()[0]).meta.fingers, typeName(types()[0])])).toEqual([0, 'bin-2x2x3-qty1']);

  // half a cell wide: its front and back are too short, its sides are not
  await H.dragCells(page, [3, 0], [3, 0]);
  await H.setField(page, 'u', 0.5);
  await slot(page, 'F');
  await slot(page, 'L');
  await expect(checks(page)).toContainText('has its front wall too short for a finger slot, which needs 15 mm of straight wall, so it has none there');
  expect(await page.evaluate(() => [geomFor(B()[1]).meta.fingers, B()[1].u]))
    .toEqual([1, 0.5]);
  expect(await page.evaluate(() => [...typeNames().values()].sort()))
    .toEqual(['bin-0.5x1x3-slot-l-qty1', 'bin-2x2x3-qty1']);
});

test('a drawer of slotted bins hears each note once, and a bin cannot stand on one', async ({ page }) => {
  if (await page.locator('#s-bin.closed').count()) await page.locator('#s-bin > h2 > button').click();
  await H.setField(page, 'scoop', 12);                    // the new bins' settings
  await slot(page, 'F');
  await page.locator('#fillRest').click();
  await settle(page);
  const n = await page.evaluate(() => B().length);
  expect(n).toBeGreaterThan(3);
  expect(await page.evaluate(() => B().every((b) => b.fingerSlots.f && geomFor(b).meta.fingers === 1))).toBe(true);
  const held = page.locator('#warnings .w').filter({ hasText: 'scoop' });
  await expect(held).toHaveCount(1);
  await expect(held).toContainText(new RegExp(`^${n} bins have a finger slot in their front walls, so their scoops are held to 6\\.8 mm, under the slot: ` +
    'the 1×1 on layer 1 at column 1 row 1, the 1×1 on layer 1 at column 2 row 1, the 1×1 on layer 1 at column 3 row 1 ' +
    `and ${n - 3} more\\.$`));

  // a bin on top of a slotted one has no lip to sit in
  await page.evaluate(() => {
    const below = Object.assign({}, B()[0], { x: 0, y: 0, sel: false });
    const above = Object.assign({}, below, { fingerSlots: { f: false, b: false, l: false, r: false } });
    loadFromHash('bl=' + encodeURIComponent(packLayers([{ bins: [below] }, { bins: [above] }])));
    readControls(); refresh();
  });
  await settle(page);
  await expect(checks(page)).toContainText('the bin below has a finger slot, so it has no stacking lip to sit on');
});

test('a slotted bin is its own STL, named for its walls', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.dragCells(page, [1, 0], [1, 0]);               // the second is selected
  await slot(page, 'F');
  await slot(page, 'B');
  expect(await page.evaluate(() => [...typeNames().values()].sort()))
    .toEqual(['bin-1x1x3-qty1', 'bin-1x1x3-slot-fb-qty1']);
  const files = [];
  for (const i of [0, 1]) {
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#typeRows button[data-t]').nth(i).click(),
    ]);
    files.push(dl.suggestedFilename());
  }
  expect(files.sort()).toEqual(['bin-1x1x3-qty1.stl', 'bin-1x1x3-slot-fb-qty1.stl']);
  // and the README says which walls
  expect(await page.evaluate(() => layoutReadme())).toContain('1 x  1x1x3  (41.5 x 41.5 x 21.0 mm incl. lip)  2 finger slots, front and back');
});

test('a link carries the slots, and one without them is written as it always was', async ({ page }) => {
  // a link from before slots: two bins, one holed, read and written back to the byte
  const old = '0-0-2-1-3-1.2-1.2-1-0-0-1-1-1-1-8-12-0-0-0-0-15_0-1-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-1';
  await page.evaluate((bl) => { loadFromHash('bl=' + encodeURIComponent(bl)); readControls(); refresh(); }, old);
  await settle(page);
  expect(await page.evaluate(() => packLayers(layers))).toBe(old);
  expect(await page.evaluate(() => B().map((b) => Object.values(b.fingerSlots).some(Boolean)))).toEqual([false, false]);
  const before = await page.evaluate(() => descString());

  // slots on and off again leave it as it was
  await H.clickCell(page, 0, 0);
  await slot(page, 'L');
  expect(await page.evaluate(() => descString())).not.toBe(before);
  expect(await page.evaluate(() => packBin(B()[0]).split('-').slice(21))).toEqual(['32']);
  await slot(page, 'L', false);
  expect(await page.evaluate(() => descString())).toBe(before);

  // and a slotted design comes back slotted, toggles and all
  await slot(page, 'F');
  await slot(page, 'R');
  const link = await page.evaluate(() => descString());
  await page.evaluate((h) => { clearSel(); loadFromHash(h); readControls(); refresh(); }, link);
  await settle(page);
  expect(await page.evaluate(() => B()[0].fingerSlots)).toEqual({ f: true, b: false, l: false, r: true });
  await H.clickCell(page, 0, 0);
  await settle(page);
  await expect(page.locator('#fingerF')).toBeChecked();
  await expect(page.locator('#fingerR')).toBeChecked();
  await expect(page.locator('#fingerB')).not.toBeChecked();
  expect(await page.evaluate(() => [...typeNames().values()].sort()))
    .toEqual(['bin-1x1x3-magnets-qty1', 'bin-2x1x3-1x0div-slot-fr-qty1']);
});
