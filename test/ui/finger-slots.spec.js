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
// the engine itself, in Node, to measure what the page builds (estimate.spec does the same)
const G = require('../../src/core.js');
const { buildBin } = require('../../src/bins/bin.js');
const { enclosedVolume } = require('../enclosed-volume.js');
const meshOf = (cfg) => enclosedVolume(buildBin(G, cfg).polys);

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
                                           packBin(B()[0]), volumeMm3(B()[0])]);
  await expect(page.locator('#hResult')).toContainText('+ 3.95 mm lip');

  await slot(page, 'F');
  const [key, name, vol, meta, link, weighed, dips, cfg] = await page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return [typeKey(b), typeName(types()[0]), geomFor(b).vol, { n: m.fingers, walls: m.fingerWalls, lip: m.hasLip }, packBin(b),
            volumeMm3(b), fingerPlan(b).area * b.wall, binCfg(b)];
  });
  expect(meta).toEqual({ n: 1, walls: 'f', lip: false });
  expect(key, 'a bin with a slot is its own part').toBe(plain[0] + '-slot-f');
  expect(name).toBe('bin-1x1x3-slot-f-qty1');
  expect(plain[1]).toBe('bin-1x1x3-qty1');
  expect(vol, 'the filament estimate leaves out the wall the slot takes, and the lip').toBeLessThan(plain[2]);
  /* By how much, from binVolume's own terms: the lip the plain bin has, 1229.8 mm³, and
     the dip, 152.1 mm³ (fingerSlots' area, the wall's face it takes, times the wall). Both
     are thin parts, laid down solid, so the filament drops by the same; and the mesh drops
     by 1381.7 mm³ (enclosedVolume), where the weight drops by 1381.9. 9.95 g, 8.24 g. */
  expect(weighed.parts.lip, 'no lip weighed').toBe(0);
  expect(plain[4].raw - weighed.raw).toBeCloseTo(plain[4].parts.lip + dips, 6);
  expect(plain[4].filament - weighed.filament).toBeCloseTo(plain[4].parts.lip + dips, 6);
  expect(Math.abs(weighed.raw / meshOf(cfg) - 1), 'the plastic the slotted bin is built of').toBeLessThan(0.015);
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

/* With removable plates the lip has a notch at each plate, and the plates across are cut
   to the scoop, which they hold under a cap of their own. A slotted bin has no lip, so
   nothing to notch, and its weight leaves the lip out once, notches and all: weighed with
   its notches still taken off a lip it does not have, its lip would come to less than
   nothing. A front slot holds the scoop lower than the plates need it held, and the plates
   across are cut to that, so Checks names the slot for it and not the plates. */
test('with removable plates: no lip to notch, weighed once, and plates cut to the held scoop', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 0]);               // a 2x1x3, selected
  await H.setField(page, 'hUnits', 2);
  await H.setField(page, 'divX', 2);
  await page.check('#divRemovable');
  await H.setField(page, 'scoop', 10);
  await settle(page);
  await expect(checks(page)).toContainText('is built with a 6.6 mm scoop rather than 7.2 mm, so the plates across keep 1 mm of their front ends in their rails');
  const weigh = () => page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta, p = fingerPlan(b), v = volumeMm3(b), cfg = binCfg(b);
    const across = dividerPlates(G, cfg).find((q) => q.axis === 'y'), L = plateLayout(cfg, builtDivs(b));
    return { notched: m.hasLip && L.lip ? L.pX.length + L.pY.length : 0, raw: v.raw, parts: v.parts, lip: m.hasLip,
             dips: p ? p.area * b.wall : 0, cfg,
             cut: across.meta.outline[0][1] - m.floorZ - state.divClr, scoop: p ? p.scoopNow : null };
  });
  const plain = await weigh();
  expect(plain.lip).toBe(true);
  expect(plain.notched, 'fixture: the lip is notched for its two plates').toBe(2);
  expect(plain.cut, 'fixture: the plates across cut to the plates\' own cap').toBeCloseTo(6.6, 6);

  await slot(page, 'F');
  const slotted = await weigh();
  expect(slotted.lip).toBe(false);
  expect(slotted.parts.lip, 'no lip weighed, and no notches taken off one').toBe(0);
  expect(slotted.parts.walls, 'the walls less the dips').toBeCloseTo(plain.parts.walls - slotted.dips, 6);
  /* What the slot takes off, measured: the lip as it was, notches and all (1834.3 mm³),
     the dips (257.2), and the scoop held from 6.6 to 3.62 mm (501.5), less the rails' ends
     the lip's chamfer no longer stands over (10.3), 2582.7 mm³ in all, where the mesh
     loses 2579.4 (enclosedVolume, which measures to a few mm³ here). Both bins weigh
     within 0.03% of their meshes. 15.89 g, 12.78 g. */
  const [meshPlain, meshSlotted] = [meshOf(plain.cfg), meshOf(slotted.cfg)];
  expect(Math.abs(plain.raw / meshPlain - 1), 'the plain bin, its lip notched').toBeLessThan(0.015);
  expect(Math.abs(slotted.raw / meshSlotted - 1), 'the slotted bin').toBeLessThan(0.015);
  expect(Math.abs((plain.raw - slotted.raw) / (meshPlain - meshSlotted) - 1), 'what the slot takes off').toBeLessThan(0.005);
  expect(slotted.scoop).toBeCloseTo(3.6225, 4);
  expect(slotted.parts.scoop, 'the scoop weighed is the one the slot holds').toBeLessThan(plain.parts.scoop / 3);
  expect(slotted.cut, 'the plates across cut to the scoop the slot holds it to').toBeCloseTo(slotted.scoop, 6);
  await expect(checks(page)).toContainText('has a finger slot in its front wall, so its scoop is held to 3.6 mm, under the slot');
  await expect(checks(page)).not.toContainText('rather than');
  expect(await page.locator('#warnings .w.err').count(), 'notes, not faults').toBe(0);
});

/* The reviewer's link (#58-SF-A): a 1x1x3 with a 0.4 mm wall, a front slot and 40 removable
   plates asked for along, which the link reader holds to 32. The slot takes the lip, so
   there is no notch for the end plates to keep clear of its corners: 11 fit, as on any
   bin without a lip, where the lip's rule allows 10. Counted with it, the bin was built
   with 10, and Checks said no more could have a notch through a stacking lip it does not
   have. The field lets it ask for the 11 it is built with. */
test('a slotted bin has no lip, so its plates are not counted as if it had', async ({ page }) => {
  await page.goto('about:blank');
  await page.goto(H.BINS_URL + '#bl=0-0-1-1-3-0.4-1.2-0-40-0-1-1-1-1-0-0-0-0-1-0-15-8&w=400&d=400&bw=400&bd=400');
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await settle(page);
  const seen = () => page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return { asked: b.divY, built: builtDivs(b), lip: m.hasLip, slots: m.fingers,
             plates: dividerPlates(G, binCfg(b)).reduce((n, p) => n + p.qty, 0) };
  });
  expect(await seen()).toEqual({ asked: 32, built: { divX: 0, divY: 11 }, lip: false, slots: 1, plates: 11 });
  await expect(checks(page)).toContainText('is built with 11 removable dividers along, not the 32 it asks for, ' +
    'as no more leave every slot room for a 1.6 mm plate at 0.25 mm clearance');
  await expect(checks(page)).not.toContainText('stacking lip');

  // and asks for them: the field goes up to the 11, where the lip's rule stopped it at 10
  await H.clickCell(page, 0, 0);
  await settle(page);
  await expect(page.locator('#divY')).toHaveAttribute('max', '11');
  await H.setField(page, 'divY', 11);
  expect(await seen()).toEqual({ asked: 11, built: { divX: 0, divY: 11 }, lip: false, slots: 1, plates: 11 });
  await expect(checks(page)).not.toContainText('removable dividers along, not');

  // without the slot it has its lip, and the lip's rule holds it to 10 again
  await slot(page, 'F', false);
  expect(await seen()).toEqual({ asked: 11, built: { divX: 0, divY: 10 }, lip: true, slots: 0, plates: 10 });
  await expect(checks(page)).toContainText('is built with 10 removable dividers along, not the 11 it asks for, ' +
    'as no more can have a notch through the stacking lip clear of its corners');
});

/* The reviewer's link (#58-SF-B): the same bin with a slot in its left wall, one plate
   along and 32 across asked for. The plate along leaves the left wall no compartment wide
   enough for a slot, so the bin has its lip and takes 10 across. The across field was
   held as if there were no plates along, where the slot builds and 11 fit: it offered 11,
   and the bin built 10 and said so in Checks. Held with the plate along, it offers 10. */
test('the across field offers as many plates as are built with the plates along it has', async ({ page }) => {
  await page.goto('about:blank');
  await page.goto(H.BINS_URL + '#bl=0-0-1-1-3-0.4-1.2-32-1-0-1-1-1-1-0-0-0-0-1-0-15-32&w=400&d=400&bw=400&bd=400');
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  const seen = () => page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return { asked: [b.divX, b.divY], built: builtDivs(b), lip: m.hasLip, slots: m.fingers };
  });
  expect(await seen()).toEqual({ asked: [32, 1], built: { divX: 10, divY: 1 }, lip: true, slots: 0 });
  await expect(page.locator('#divX')).toHaveAttribute('max', '10');
  await H.setField(page, 'divX', 10);
  expect(await seen()).toEqual({ asked: [10, 1], built: { divX: 10, divY: 1 }, lip: true, slots: 0 });
  await expect(checks(page)).not.toContainText('removable dividers across, not');

  // with none along the slot is built, the lip goes, and 11 fit across
  await H.setField(page, 'divY', 0);
  await expect(page.locator('#divX')).toHaveAttribute('max', '11');
  await H.setField(page, 'divX', 11);
  expect(await seen()).toEqual({ asked: [11, 0], built: { divX: 11, divY: 0 }, lip: false, slots: 1 });
  await expect(checks(page)).not.toContainText('removable dividers across, not');
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

/* Load a layout from its link, with the rest of the link after it, and select the bin at
   the first cell. */
const load = async (page, bl, rest = '') => {
  await page.evaluate(([h, more]) => {
    clearSel(); loadFromHash('bl=' + encodeURIComponent(h) + more); readControls(); refresh();
  }, [bl, rest]);
  await settle(page);
  expect(await page.evaluate(() => packLayers(layers)), 'the layout loaded').toBe(bl);
  await H.clickCell(page, 0, 0);
  await settle(page);
};

test('a back slot gives the holes the label shelf’s room, or says they kept clear of it', async ({ page }) => {
  // a 1x1x4 for AA cells with a 12 mm shelf: the 4 holes of a bin with none, not the 2 in front of one
  await load(page, '0-0-1-1-4-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15-16-0-1-0');
  expect(await page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return [m.holes, holesIn(b).n, m.fingerWalls, typeName(types()[0])];
  })).toEqual([4, 4, 'b', 'bin-1x1x4-aa-holes-slot-b-qty1']);
  await expect(page.locator('#insertHint')).toContainText('4 holes, 16.8 mm deep.');
  await expect(checks(page)).toContainText('has a finger slot in its back wall, so its label shelf is left off');
  await expect(checks(page)).not.toContainText('where its label shelf would be');

  /* A 1x0.5x3 for AAA cells with an 8 mm shelf: in the shelf's room a row of them would
     stand too high for the slot, so they keep clear of it, which leaves room for none, and
     Checks says so, not that a shelf the bin does not have is too deep. */
  await load(page, '0-0-1-0.5-3-1.2-1.2-0-0-0-1-1-1-1-0-8-0-0-0-0-15-16-0-2-0');
  expect(await page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return [m.holes, holesIn(b), m.fingerWalls];
  })).toEqual([0, null, 'b']);
  await expect(checks(page)).toContainText('has no holes for AAA batteries: they keep in front of where its label ' +
    'shelf would be, to leave room for the finger slot in its back wall, and there is no room there for even one');
  await expect(checks(page)).toContainText('has a finger slot in its back wall, so its label shelf is left off');
  await expect(checks(page)).not.toContainText('label shelf too deep');
  await expect(page.locator('#insertHint')).toContainText('The holes keep clear of where the label shelf would be, ' +
    'to leave room for the finger slot in the back wall, and in front of it there is no room for even one hole for AAA batteries.');
  // and what the bin would be without the shelf: holes, and no slot
  await expect(page.locator('#insertHint')).toContainText('spread into its room the holes would stand too high for ' +
    'that slot. Asked for no label shelf, this bin has 3 holes and no finger slot in the back wall.');
  expect(await page.locator('#warnings .w.err').count(), 'notes, not faults').toBe(0);

  /* The same for a slot in another wall: with its front lowered to half, a 1x0.5x3 for AA
     cells 8 mm deep would have 2 of them in the shelf's room, standing too high for the
     front slot. The holes take the shelf's room only where that costs no slot the shelf's
     layout builds, so here they keep in front of where it would be, which leaves room for
     none, and both slots are built. (It is not that a slot is never traded for holes: with
     a block too high for the back slot even in front of the shelf, the shelf stays and the
     back slot is not built.) */
  await load(page, '0-0-1-0.5-3-1.2-1.2-0-0-0-0.5-1-1-1-0-8-0-0-0-0-15-24-0-1-8');
  expect(await page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return [m.holes, holesIn(b), m.fingerWalls];
  })).toEqual([0, null, 'fb']);
  await expect(checks(page)).toContainText('has no holes for AA batteries: they keep in front of where its label ' +
    'shelf would be, to leave room for the finger slot in its front wall, and there is no room there for even one');
  await expect(page.locator('#insertHint')).toContainText('The finger slot in the back wall takes the label shelf ' +
    'away, but spread into its room the holes would stand too high for the finger slot in the front wall. Asked for ' +
    'no label shelf, this bin has 2 holes and no finger slot in the front wall.');
  expect(await page.locator('#warnings .w.err').count(), 'notes, not faults').toBe(0);
});

test('past the most holes one bin is built with, they keep clear of the shelf’s room, and the slot builds over them', async ({ page }) => {
  /* A 9x8.5x3 for hex bits at -0.3 mm with an 8 mm shelf: spread into the shelf's room
     they would come to 2009, more than one bin is built with, so they keep to the 1960 in
     front of where it would be, as without the slot, and the back slot builds over them. */
  const big = (label) => `0-0-9-8.5-3-1.2-1.2-0-0-0-1-1-1-1-0-${label}-0-0-0-0-15-16-0-4-0`;
  const rest = '&bhc=-0.3&w=400&d=400&bw=400&bd=400';
  await load(page, big(8), rest);
  expect(await page.evaluate(() => {
    const b = B()[0], m = geomFor(b).meta;
    return [m.holes, (holesIn(b) || { n: 0 }).n, m.fingerWalls];
  })).toEqual([1960, 1960, 'b']);
  await expect(checks(page)).toContainText('has its holes for hex bits kept clear of where its label shelf would be, ' +
    'since spread into that room there would be 2009 holes, more than the 2000 one bin is built with');
  await expect(checks(page)).toContainText('has a finger slot in its back wall, so its label shelf is left off');
  await expect(checks(page)).not.toContainText('so it has none');
  expect(await page.locator('#warnings .w.err').count(), 'notes, not faults').toBe(0);
  await expect(page.locator('#insertHint')).toContainText('1960 holes, 8.3 mm deep.');
  await expect(page.locator('#insertHint')).toContainText('They keep clear of where the label shelf would be: the ' +
    'finger slot in the back wall takes the label shelf away, but spread into its room there would be 2009 holes, ' +
    'more than the 2000 one bin is built with.');

  /* The block fills the wedge under where the shelf would be, as the bin has no shelf to
     fill it, and no lip whose chamfer it stands in: binVolume weighs it whole, the
     cavity's rounded outline less the holes, from the slab's top (a BLOAT over the floor)
     to the block's top, and no shelf. The bin without the slot has the same holes, and
     weighs its block less the wedge its shelf fills, 1198.2 mm³ here: a triangle in
     section, 1203.7 across the cavity's whole width, less where its rounded back corners
     narrow it. Its block stands under the lip's chamfer, so nothing comes off it there. */
  expect(await page.evaluate(() => {
    const b = B()[0], a = Object.assign({}, b, { fingerSlots: { f: false, b: false, l: false, r: false } });
    const hwO = (b.u - 1) * SPEC.pitch / 2 + SPEC.half, hdO = (b.v - 1) * SPEC.pitch / 2 + SPEC.half;
    const wall = Math.max(WALL_MIN, b.wall), rI = Math.max(0.4, SPEC.r - wall), h = holesIn(b);
    const whole = (areaRR(hwO - wall, hdO - wall, rI) - h.n * h.shape.area) * (h.top - (geomFor(b).meta.floorZ + BLOAT));
    const [vb, va] = [volumeMm3(b).parts, volumeMm3(a).parts];
    return [vb.shelf, vb.lip, +(vb.block - whole).toFixed(6), h.n === holesIn(a).n && h.top === holesIn(a).top,
            +(whole - va.block).toFixed(1), va.shelf > 0];
  })).toEqual([0, 0, 0, true, 1198.2, true]);

  /* Where the holes are goes by how deep the shelf would be, so the bin is keyed by it:
     at 10 mm they are 2 mm further forward, another part. */
  const key = () => page.evaluate(() => typeKey(B()[0]));
  const at8 = await key();
  await load(page, big(10), rest);
  expect(await page.evaluate(() => holesIn(B()[0]).n)).toBe(1960);
  expect([at8, await key()]).toEqual(['9x8.5x3-w1.2-f1.2-L8-i4w6.35d8.333-slot-b',
                                      '9x8.5x3-w1.2-f1.2-L10-i4w6.35d8.333-slot-b']);
});

/* The reviewer's link (#58-SF1): two such bins asking for a 20 mm shelf, which on 3 units is
   laid out 15 deep, and 14 for the second, which asks for a note raised on it that the slot
   keeps from printing. Their holes keep clear of shelves a millimetre apart, so they are two
   parts, keyed by the depth each is laid out to. Keyed by the 20 mm both asked for, they were
   one, "x2", and both printed from the first one's STL. As two parts they are 3822 holes, past
   the 2000 a layout builds, so the second is built without its holes, and Checks says so. */
test('holes kept clear of shelves laid out to different depths are different parts', async ({ page }) => {
  await page.goto('about:blank');
  await page.goto(H.BINS_URL + '#v=2&w=800&d=400&dh=84&ph=4.25&bw=400&bd=400&bh=256&if=15&bgap=3&pr=custom' +
    '&bl=0-0-9-8.5-3-1.2-1.2-0-0-0-1-1-1-1-0-20-0-0-0-0-15-16-0-4-0_9-0-9-8.5-3-1.2-1.2-0-0-0-1-1-1-1-0-20-0-0-0-0-15-16-1-4-0' +
    '&bseg=12&bdt=1.6&bdc=0.25&bhc=-0.3&bnotes=%5B%5B%22%22%2C%22AA%22%5D%5D');
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    // each bin as it is on its own, the layout's count of holes aside
    const alone = B().map((b) => Object.assign({}, b));
    const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-1',
      new Uint8Array(stlBinary(buildBin(G, binCfg(b)).polys, 'b'))))].join();
    return { alone: alone.map((b) => { const h = holesIn(b); return [typeKey(b), h.n, h.shelf.depth, +h.ys[h.ys.length - 1].toFixed(3)]; }),
             stls: new Set(await Promise.all(alone.map(sha))).size, note: B()[1].note,
             types: types().map((t) => [t.key, t.qty]) };
  });
  expect(r.note, 'fixture: the second asks for a note').toBe('AA');
  expect(r.alone).toEqual([['9x8.5x3-w1.2-f1.2-L15-i4w6.35d8.333-slot-b', 1911, 15, 157.584],
                           ['9x8.5x3-w1.2-f1.2-L14-i4w6.35d8.333-slot-b', 1911, 14, 158.584]]);
  expect(r.stls).toBe(2);
  expect(r.types, 'two parts, the second without its holes').toEqual([['9x8.5x3-w1.2-f1.2-L15-i4w6.35d8.333-slot-b', 1],
                                                                      ['9x8.5x3-w1.2-f1.2-slot-b', 1]]);
  await expect(checks(page)).toContainText('3822 holes are set across the floors of different bins, more than the 2000 ' +
    'one layout builds, so the bins of the 1 kind after the first 1911 holes are built without them.');
});

test('bins built alike are one part, whatever shelf or scoop their slots took away', async ({ page }) => {
  // as many parts as different STLs, and as many files
  const parts = () => page.evaluate(() => {
    const stl = (b) => [...new Uint8Array(stlBinary(buildBin(G, binCfg(b)).polys, 'b'))].join();
    return [new Set(B().map(stl)).size, types().length, [...typeNames().values()].sort()];
  });
  // a back slot leaves the shelf off, so a 12 mm shelf asked for is the bin with none
  await load(page, '0-0-2-1-4-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15-16_2-0-2-1-4-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-16');
  expect(await parts()).toEqual([1, 1, ['bin-2x1x4-slot-b-qty2']]);
  await expect(page.locator('#typeRows button[data-t]')).toHaveCount(1);

  // a front slot holds 15 and 25 mm scoops alike to 9.92, under it; 8 mm is under it already
  await load(page, '0-0-2-1-4-1.2-1.2-0-0-0-1-1-1-1-15-0-0-0-0-0-15-8_2-0-2-1-4-1.2-1.2-0-0-0-1-1-1-1-25-0-0-0-0-0-15-8' +
    '_0-1-2-1-4-1.2-1.2-0-0-0-1-1-1-1-8-0-0-0-0-0-15-8');
  expect(await parts()).toEqual([2, 2, ['bin-2x1x4-slot-f-scoop8-qty1', 'bin-2x1x4-slot-f-scoop9.92-qty2']]);
});

test('a floor that fills the bin says there is no wall for a slot, and Tray asks for none', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await slot(page, 'F');
  await H.setField(page, 'floorT', 20);
  await expect(checks(page)).toContainText('has a floor that fills it to the top, so there is no wall for a finger slot');
  expect(await page.evaluate(() => geomFor(B()[0]).meta.fingers)).toBe(0);
  await H.setField(page, 'floorT', 1.2);
  await expect(checks(page)).not.toContainText('finger slot');

  // a tray has every wall open, so nothing to dip, and its link is the plain one
  await slot(page, 'L');
  await page.locator('#presetTray').click();
  await settle(page);
  for (const k of ['F', 'B', 'L', 'R']) await expect(page.locator(`#finger${k}`)).not.toBeChecked();
  expect(await page.evaluate(() => [B()[0].fingerSlots, packBin(B()[0]).split('-').length]))
    .toEqual([{ f: false, b: false, l: false, r: false }, 21]);
  await expect(checks(page)).not.toContainText('finger slot');
});
