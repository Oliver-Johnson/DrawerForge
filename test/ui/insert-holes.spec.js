/* Holes across a bin's floor, on the bins page: the "Holes for" menu in panel 03 with
 * its depth, the hint that says what is built, the Hole clearance field, the notes
 * Checks gains, and a bin with holes as a part and a file of its own.
 *
 * The geometry is the audit's (test/bin-audit.js counts, probes and times the holes;
 * stack-check.js holds the block under the bin above). What is tested here is that the
 * page asks for what it says it does, says what the bin gets, and keeps every layout
 * without holes exactly as it was.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(400);
const holesFor = async (page, value) => {
  await page.selectOption('#insert', String(value));
  await settle(page);
};
const hint = (page) => page.locator('#insertHint');
// the hint's own first sentence, without its button and the rest behind it
const lead = (page) => page.evaluate(() => {
  const h = document.getElementById('insertHint'), b = h.querySelector(':scope>button.more');
  return (b ? b.previousElementSibling.textContent : h.textContent).trim();
});
const rest = (page) => page.evaluate(() => {
  const m = document.querySelector('#insertHint>.moretext');
  return m ? m.textContent : '';
});
const checks = (page) => page.locator('#warnings');
const tail = (page, i = 0) => page.evaluate((i) => packBin(B()[i]).split('-').slice(21), i);

test.beforeEach(async ({ page }) => {
  await H.forgetSaved(page);
  page.__errors = await H.openBins(page);
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

test('the menu builds the holes, the hint says what they are, and the bin is its own part',
  async ({ page }) => {
    await H.dragCells(page, [0, 0], [0, 0]);               // a 1x1x3, selected
    const plain = await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0]), geomFor(B()[0]).vol]);
    await expect(page.locator('#insert')).toHaveValue('0');
    await expect(page.locator('#insertDepthRow'), 'no depth to give while there are no holes').toBeHidden();
    await expect(hint(page)).toBeHidden();
    await expect(page.locator('#holeClrHint')).toBeHidden();
    expect(await page.locator('#insert option').allTextContents())
      .toEqual(['Nothing', 'AA batteries', 'AAA batteries', '18650 cells', '1/4 inch hex bits']);

    await holesFor(page, 4);
    await expect(page.locator('#insertDepthRow')).toBeVisible();
    await expect(page.locator('#insertDepth')).toHaveValue('');
    await expect(page.locator('#insertDepth')).toHaveAttribute('placeholder', 'auto');
    await expect(hint(page)).toBeVisible();
    await expect(page.locator('#holeClrHint')).toBeVisible();
    // the brief's own example, word for word
    expect(await lead(page)).toBe('16 holes, 8.3 mm deep. Bits are 25 mm long, so this bin needs 5 units to keep them below the rim.');
    expect(await rest(page)).toBe('Each hole is 6.65 mm across the flats, the largest hex bits with 0.3 mm to spare. ' +
      'Left blank, the depth is a third of their length, at least 5 mm.');
    await expect(hint(page).locator('.moretext'), 'the rest waits behind "more"').toBeHidden();
    await expect(hint(page).locator('button.more')).toHaveAttribute('aria-describedby', 'insertHintLead');

    const [key, name, vol, meta] = await page.evaluate(() => {
      const b = B()[0], m = geomFor(b).meta;
      return [typeKey(b), typeName(types()[0]), geomFor(b).vol, m.holes];
    });
    expect(meta, 'the build has the holes the hint counts').toBe(16);
    expect(key, 'a bin with holes is its own part').not.toBe(plain[0]);
    expect(key).toMatch(/-i4w6\.65d8\.333$/);
    expect(name).toBe('bin-1x1x3-hex-bit-holes-qty1');
    expect(plain[1]).toBe('bin-1x1x3-qty1');
    expect(vol, 'the filament estimate counts the block the holes are in').toBeGreaterThan(plain[2]);
    await expect(page.locator('#typeRows')).toContainText('16 holes for hex bits');
    // the link: the label mode and the lid bits written as off, then the kind and the depth
    expect(await tail(page)).toEqual(['0', '0', '4', '0']);

    // one step back takes it all away again, and the link is as it was
    await page.locator('#undoBtn').click();
    await settle(page);
    await expect(page.locator('#insert')).toHaveValue('0');
    await expect(hint(page)).toBeHidden();
    expect(await page.evaluate(() => packBin(B()[0]).split('-').length)).toBe(21);
    expect(await page.evaluate(() => typeKey(B()[0]))).toBe(plain[0]);
  });

test('a depth typed is used, held to the bin, and blank is automatic again', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'hUnits', 5);
  await holesFor(page, 4);
  await H.setField(page, 'insertDepth', 20);
  expect(await lead(page)).toBe('16 holes, 20 mm deep. Bits are 25 mm long, so they stay below the rim.');
  expect(await rest(page)).not.toContain('Left blank');
  expect(await tail(page)).toEqual(['0', '0', '4', '20']);

  // past the bin's height the box is put back to it, and the hint says where they stop
  await H.setField(page, 'insertDepth', 100);
  await expect(page.locator('#insertDepth')).toHaveValue('35');
  expect(await lead(page)).toBe('16 holes, 28.5 mm deep. Bits are 25 mm long, so they stay below the rim.');
  expect(await rest(page)).toContain('35 mm is more than this bin has room for, so the holes stop 0.5 mm under the rim.');

  // 0 is automatic too, and the box goes blank for it
  await H.setField(page, 'insertDepth', 0);
  await expect(page.locator('#insertDepth')).toHaveValue('');
  expect(await lead(page)).toMatch(/^16 holes, 8\.3 mm deep\./);
  expect(await tail(page)).toEqual(['0', '0', '4', '0']);

  // and a shelf at the back keeps them in front of it and under it
  await H.setField(page, 'hUnits', 3);
  await holesFor(page, 1);
  expect(await lead(page)).toBe('4 holes, 14.5 mm deep. AA batteries are 50.5 mm long, so this bin needs 9 units to keep them below the rim.');
  expect(await rest(page)).toContain('A third of their length, 16.8 mm, is more than this bin has room for, so the holes stop 0.5 mm under the rim.');
  await H.setField(page, 'label', 12);
  expect(await rest(page)).toContain('so the holes stop 0.5 mm under the label shelf.');
  const lines = await page.evaluate(() => {
    const h = document.getElementById('insertHint');
    return h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight);
  });
  expect(lines, 'no more than four lines until "more" is opened').toBeLessThanOrEqual(4.05);
});

test('Hole clearance is one figure for the drawer, carried by the link only when it is set',
  async ({ page }) => {
    await H.dragCells(page, [0, 0], [0, 0]);
    await holesFor(page, 4);
    const before = await page.evaluate(() => typeKey(B()[0]));
    expect(await page.evaluate(() => 'bhc' in descriptor())).toBe(false);

    await H.setField(page, 'holeClr', 0.2);
    expect(await rest(page)).toMatch(/^Each hole is 6\.85 mm across the flats, the largest hex bits with 0\.5 mm to spare\./);
    expect(await page.evaluate(() => descriptor().bhc)).toBe(0.2);
    expect(await page.evaluate(() => typeKey(B()[0])), 'a looser hole is another part').toMatch(/-i4w6\.85d/);
    expect(await page.evaluate(() => typeKey(B()[0]))).not.toBe(before);

    // held to the field's limits, which are the engine's
    await H.setField(page, 'holeClr', 5);
    await expect(page.locator('#holeClr')).toHaveValue('1');
    await H.setField(page, 'holeClr', -2);
    await expect(page.locator('#holeClr')).toHaveValue('-0.3');
    expect(await rest(page)).toMatch(/^Each hole is 6\.35 mm across the flats, the largest hex bits with 0 mm to spare\./);

    // a design carries it back, and one without it is a design at 0
    await page.evaluate(() => {
      loadFromHash('bhc=0.15&bl=' + encodeURIComponent(packLayers(layers)));
      readControls(); refresh();
    });
    await expect(page.locator('#holeClr')).toHaveValue('0.15');
    await page.evaluate(() => { loadFromHash('bl=' + encodeURIComponent(packLayers(layers))); readControls(); refresh(); });
    await expect(page.locator('#holeClr')).toHaveValue('0');
    expect(await page.evaluate(() => 'bhc' in descriptor())).toBe(false);
    await page.evaluate(() => { loadFromHash('bhc=junk&bl=' + encodeURIComponent(packLayers(layers))); readControls(); });
    await expect(page.locator('#holeClr')).toHaveValue('0');
    expect(await page.evaluate(() => typeKey(B()[0]))).toBe(before);
  });

test('Checks says what is left off and what stands above the rim, as notes', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'divX', 1);
  await H.setField(page, 'scoop', 8);
  await holesFor(page, 1);
  await expect(checks(page)).toContainText('has holes for AA batteries, so its dividers and scoop are left off');
  await expect(checks(page)).toContainText('has AA batteries standing 35.5 mm above its rim, so nothing can stack on it; at 9 units they stay below the rim');
  expect(await rest(page)).toContain('Dividers and the scoop are left off a bin with holes.');
  expect(await page.locator('#warnings .w.err').count(), 'notes, not faults').toBe(0);
  expect(await page.evaluate(() => [geomFor(B()[0]).meta.holes, typeName(types()[0])]))
    .toEqual([4, 'bin-1x1x3-aa-holes-qty1']);
  // and a lid would sit on them too
  await page.locator('#lid').check();
  await settle(page);
  await expect(checks(page)).toContainText('so nothing can stack on it and its lid will not go on; at 9 units');
  await page.locator('#lid').uncheck();
  await settle(page);

  // a drawer too shallow for what stands in the holes is a fault: it would not shut
  await H.setField(page, 'drawerH', 50);
  await expect(checks(page)).toContainText(/has AA batteries reaching 56\.5 mm above the baseplate, past the 45\.8 mm available, so the drawer would not shut over them/);
  expect(await page.locator('#warnings .w.err').count()).toBe(1);
  await H.setField(page, 'drawerH', 84);

  // too short a bin for a hole at all
  await H.setField(page, 'hUnits', 1);
  expect(await lead(page)).toBe('This bin has room for holes only 0.5 mm deep, and they need 3 mm, so it has none.');
  await expect(checks(page)).toContainText('is too short for holes for AA batteries, so it has none: it has room for 0.5 mm under its rim, and a hole needs 3 mm');
  expect(await page.evaluate(() => [geomFor(B()[0]).meta.holes, typeName(types()[0])]))
    .toEqual([0, 'bin-1x1x1-1x0div-qty1']);                // and its dividers are back
  expect(await page.locator('#warnings .w.err').count()).toBe(0);
});

test('a carved shape gets no holes, and says so in the panel and in Checks', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 1]);                 // a 2x2
  await holesFor(page, 2);
  expect(await lead(page)).toMatch(/^36 holes, 14\.5 mm deep\. AAA batteries are 44\.5 mm long/);
  await H.clickCell(page, 1, 1, ['Alt']);
  expect(await page.evaluate(() => isCarved(B()[0]))).toBe(true);
  await settle(page);
  expect(await lead(page)).toBe('Holes need a rectangle, so a carved shape is built without them.');
  await expect(checks(page)).toContainText('is a carved shape, so its holes for AAA batteries are left off: holes need a rectangle');
  expect(await page.evaluate(() => [geomFor(B()[0]).meta.holes || 0, typeName(types()[0])]))
    .toEqual([0, 'bin-2x2x3-qty1']);
});

test('a drawer filled with holed bins hears each note once', async ({ page }) => {
  if (await page.locator('#s-bin.closed').count()) await page.locator('#s-bin > h2 > button').click();
  await holesFor(page, 1);                                 // the new bins' settings
  expect(await lead(page), 'the panel speaks of the next bin drawn').toMatch(/^4 holes, 14\.5 mm deep\./);
  await page.locator('#fillRest').click();
  await settle(page);
  const n = await page.evaluate(() => B().length);
  expect(n).toBeGreaterThan(3);
  expect(await page.evaluate(() => B().every((b) => b.insert === 1))).toBe(true);
  const above = page.locator('#warnings .w').filter({ hasText: 'standing above' });
  await expect(above).toHaveCount(1);
  await expect(above).toContainText(new RegExp(`^${n} bins have AA batteries standing above their rims, so nothing can stack on them: ` +
    `the 1×1 on layer 1 at column 1 row 1, the 1×1 on layer 1 at column 2 row 1, the 1×1 on layer 1 at column 3 row 1 and ${n - 3} more\\. ` +
    'At 9 units they stay below the rim\\.$'));
  expect(await page.locator('#warnings .w').filter({ hasText: 'AA batteries' }).count()).toBe(1);
});

test('a bin with holes is its own STL, and two depths are two files', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.dragCells(page, [1, 0], [1, 0]);                 // the second is selected
  await holesFor(page, 1);
  expect(await page.evaluate(() => [...typeNames().values()].sort()))
    .toEqual(['bin-1x1x3-aa-holes-qty1', 'bin-1x1x3-qty1']);
  expect(await page.evaluate(() => types().length)).toBe(2);

  await H.clickCell(page, 0, 0);
  await holesFor(page, 1);
  expect(await page.evaluate(() => [...typeNames().values()]), 'two alike are one part')
    .toEqual(['bin-1x1x3-aa-holes-qty2']);
  await H.setField(page, 'insertDepth', 10);
  expect(await page.evaluate(() => [...typeNames().values()].sort()))
    .toEqual(['bin-1x1x3-aa-holes-depth10-qty1', 'bin-1x1x3-aa-holes-depth14.5-qty1']);

  // the download is named the same way
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#typeRows button[data-t]').first().click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/^bin-1x1x3-aa-holes-depth(10|14\.5)-qty1\.stl$/);
});

/* Holes and a note raised on the shelf, on one bin. The holes keep in front of the shelf
   and under it, so the shelf is lowered for the letters first and the block stops under
   it; and the dividers holes leave off are not there for the letters to keep clear of, so
   they have the whole shelf. The page says the same as the build: the note's hint, its
   key and name, the link, the rows and the README, and Checks. */
test('a bin with holes and a raised note: the letters have the whole shelf, and the page says both',
  async ({ page }) => {
    const noteLead = () => page.evaluate(() => {
      const h = document.getElementById('noteHint'), b = h.querySelector(':scope>button.more');
      return (b ? b.previousElementSibling.textContent : h.textContent).trim();
    });
    await H.dragCells(page, [0, 0], [1, 0]);               // a 2x1x3, selected
    await H.setField(page, 'hUnits', 4);
    await H.setField(page, 'divX', 2);
    await page.fill('#note', 'Hex bits 1/4 inch');
    await page.selectOption('#labelMode', '1');
    await settle(page);
    await expect(page.locator('#label')).toHaveValue('12');
    // between two dividers it takes two lines
    expect(await noteLead()).toBe('Prints 3.1 mm tall on two lines, between the dividers.');
    expect(await page.evaluate(() => typeName(types()[0]))).toBe('bin-2x1x4-2x0div-note-hex-bits-1-4-inch-qty1');

    await holesFor(page, 4);
    expect(await noteLead(), 'the dividers are left off, so not between them').toBe('Prints 5.6 mm tall on one line.');
    expect(await lead(page)).toBe('20 holes, 8.3 mm deep. Bits are 25 mm long, so this bin needs 5 units to keep them below the rim.');
    const [key, name, holes, top, tail4] = await page.evaluate(() => {
      const b = B()[0], H = b.hUnits * SPEC.unitH;
      // the highest point well inside the lip's opening: the letters' tops
      let z = -Infinity;
      for (const p of geomFor(b).polys)
        for (const v of p.verts) if (Math.abs(v[0]) < 35 && Math.abs(v[1]) < 15) z = Math.max(z, v[2]);
      return [typeKey(b), typeName(types()[0]), geomFor(b).meta.holes, z - H, packBin(b).split('-').slice(21)];
    });
    expect(holes).toBe(20);
    expect(top, 'the letters stop 0.4 mm under the rim').toBeCloseTo(-0.4, 6);
    // both are parts of their own, so both are in the key: the note's lines, then the holes
    const codes = [...'Hex bits 1/4 inch'].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
    expect(key).toMatch(new RegExp(`-n${codes}\\.5\\.64\\d*-i4w6\\.65d8\\.333$`));
    expect(name).toBe('bin-2x1x4-hex-bit-holes-note-hex-bits-1-4-inch-qty1');
    // the note's 23rd field, then the holes' two
    expect(tail4).toEqual(['0', '1', '4', '0']);
    await expect(page.locator('#typeRows')).toContainText('20 holes for hex bits');
    expect(await page.evaluate(() => layoutReadme()))
      .toMatch(/^ +1 x {2}2x1x4 {2}\(.*\) {2}20 holes for hex bits {2}note raised on the shelf/m);
    await expect(checks(page)).toContainText('has holes for hex bits, so its dividers are left off');
    await expect(checks(page)).not.toContainText('note on two lines');
    expect(await page.locator('#warnings .w.err').count()).toBe(0);

    // the README of the bin on its own says both, and no compartments
    await H.clickCell(page, 0, 0);
    await page.locator('#focusBin').click();
    await settle(page);
    const readme = await page.evaluate(() => layoutReadme());
    expect(readme).toContain('Holes: 20 for hex bits, 6.65 mm across the flats, 8.3 mm deep');
    expect(readme).toContain('Raised note: “Hex bits 1/4 inch” on the label shelf, 5.6 mm letters on one line.');
    expect(readme).not.toContain('Compartments');
    await page.locator('#focusExit').click();
    await settle(page);

    // holes off again: the dividers are back, and the letters between them as before
    await holesFor(page, 0);
    expect(await noteLead()).toBe('Prints 3.1 mm tall on two lines, between the dividers.');
    expect(await page.evaluate(() => [typeName(types()[0]), packBin(B()[0]).split('-').slice(21)]))
      .toEqual(['bin-2x1x4-2x0div-note-hex-bits-1-4-inch-qty1', ['0', '1']]);
  });

test('a layout without holes writes the same link it always did', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 0]);
  await H.setField(page, 'label', 12);
  await page.locator('#magnets').check();
  await settle(page);
  await H.dragCells(page, [0, 1], [0, 1]);
  await H.setField(page, 'divX', 2);
  const before = await page.evaluate(() => descString());
  expect(before).not.toContain('bhc');
  // the feet's field and no further: nothing of the holes' is written for a bin without
  expect(await page.evaluate(() => B().map((b) => packBin(b).split('-').length))).toEqual([22, 22]);

  // holes on and off again, and a clearance set and put back, leave it as it was
  await holesFor(page, 3);
  expect(await page.evaluate(() => descString())).not.toBe(before);
  await holesFor(page, 0);
  await H.setField(page, 'holeClr', 0.1);
  await H.setField(page, 'holeClr', 0);
  expect(await page.evaluate(() => descString())).toBe(before);
});
