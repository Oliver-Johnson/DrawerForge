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
/* A fresh page at a link, through about:blank, as half-cells.spec.js opens one: a hash
   alone does not reload it. The blank page now and then asks for the favicon of the
   page it replaced, which it may not load from file://, and says so in the console; that
   line is the hop's, not the page's, and is let go. */
const BLANK_FAVICON = /^Not allowed to load local resource: file:\S*\/favicon\.svg$/;
const arrive = async (page, hash) => {
  await page.goto('about:blank');
  await page.goto(H.BINS_URL + hash);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  const errors = page.__errors;
  for (let i = errors.length - 1; i >= 0; i--) if (BLANK_FAVICON.test(errors[i])) errors.splice(i, 1);
};
// one bin as a link writes it: at x, y, u by v, h units tall, with holes for `insert`
const linkBin = (x, y, u, v, h, insert) =>
  `${x}-${y}-${u}-${v}-${h}-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0-0-${insert}-0`;
const stack = (page) => page.evaluate(() => +stackHeight().toFixed(2));

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

    const at0 = await page.evaluate(() => descString());
    await H.setField(page, 'holeClr', 0.2);
    expect(await rest(page)).toMatch(/^Each hole is 6\.85 mm across the flats, the largest hex bits with 0\.5 mm to spare\./);
    expect(await page.evaluate(() => descriptor().bhc)).toBe(0.2);
    // another design, so a link differing only in it sets the saved one aside
    expect(await page.evaluate((a) => sameDesign(descString(), a), at0)).toBe(false);
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
  // and the stack is measured to their tops, as a bin too tall is said twice: the stack, then the bin
  await expect(checks(page)).toContainText('The tallest stack is 56.5 mm but only 45.8 mm is available above the baseplate.');
  expect(await page.locator('#warnings .w.err').count()).toBe(2);
  await H.setField(page, 'drawerH', 84);

  // too short a bin for a hole at all
  await H.setField(page, 'hUnits', 1);
  expect(await lead(page)).toBe('This bin has room for holes only 0.5 mm deep under the rim, and they need 3 mm, so it has none.');
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

/* A hint with nothing to say is emptied as well as hidden: it kept the last bin's
   words, there for a screen reader or a copy of the page to find. */
test('the hint is empty, not only hidden, once there are no holes', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await holesFor(page, 1);
  expect(await lead(page)).toMatch(/^4 holes, 14\.5 mm deep\./);
  await holesFor(page, 0);
  await expect(hint(page)).toBeHidden();
  expect(await hint(page).evaluate((e) => e.textContent)).toBe('');
});

/* A bin stacked on one whose batteries stand past where it comes down stands on them:
   higher than its layer, held by nothing, and the stack is as tall as that makes it. The
   batteries in the top bin count too, where they stand above its lip. */
test('a bin on batteries that stand past the rim below is a fault, and the stack is measured to them',
  async ({ page }) => {
    await arrive(page, '#bl=' + linkBin(0, 0, 1, 1, 3, 1) + '~0-0-1-1-3');
    // the AA tops are 56.5 mm up, and the bin on them comes down 0.25 mm less than on a lip
    expect(await stack(page)).toBe(81.7);
    await expect(page.locator('#warnings .w.err').filter({ hasText: 'stands on' })).toHaveText(
      'Layer 2, the 1×1 bin at column 1 row 1: stands on the AA batteries in the 1×1 bin below, 35.8 mm ' +
      'higher than that bin\'s lip would hold it, so nothing keeps it in place; at 9 units that bin keeps them below its rim.');
    await expect(checks(page)).toContainText('The tallest stack is 81.7 mm but only 79.8 mm is available above the baseplate.');

    // on its own, the top of the stack is the batteries' tops, not its lip
    await arrive(page, '#bl=' + linkBin(0, 0, 1, 1, 3, 1));
    expect(await stack(page)).toBe(56.5);
    await expect(checks(page)).toContainText('Tallest stack 56.5 mm of 79.8 mm available');

    // at 9 units the bin below keeps them under its rim, and the one on it is in its place
    await arrive(page, '#dh=120&bl=' + linkBin(0, 0, 1, 1, 9, 1) + '~0-0-1-1-3');
    expect(await stack(page)).toBe(87.95);
    await expect(checks(page)).not.toContainText('stands on');
    expect(await page.locator('#warnings .w.err').count()).toBe(0);
  });

/* Below the rim is below where a bin stacked on this one comes down, 0.25 mm under it:
   AA batteries in an 8-unit bin on a 0.6 mm floor stop 0.1 mm under the rim, and that
   bin would stand on them. */
test('items that stop just under the rim are still in the way of a bin stacked on it', async ({ page }) => {
  await arrive(page, '#bl=0-0-1-1-8-1.2-0.6-0-0-0-1-1-1-1-0-0-0-0-0-0-15-0-0-1-0');
  await H.clickCell(page, 0, 0);
  await settle(page);
  expect(await lead(page)).toBe('4 holes, 16.8 mm deep. AA batteries are 50.5 mm long, so this bin needs 9 units to keep them below the rim.');
  expect(await rest(page)).toContain('They stop 0.1 mm under the rim, and a bin stacked on this one comes down 0.25 mm into it.');
  await expect(checks(page)).toContainText('has AA batteries reaching to 0.1 mm under its rim, where a bin stacked on it ' +
    'comes 0.25 mm down, so nothing can stack on it; at 9 units they stay below the rim');
  expect(await page.locator('#warnings .w.err').count(), 'a note, as standing above it is').toBe(0);
});

/* Every bin is built with up to 2000 holes (HOLES_MAX in bin.js), and a layout of
   different ones could ask for them all at once. Past 2000 over its different parts, in
   layout order, a bin whose part is not among the first is built plain, keeps its
   setting so the link still says what was asked, and Checks and its hint say why. */
test('a layout past the most holes one layout builds builds the first, and says so', async ({ page }) => {
  /* a 9x9 of hex bits is 1927 holes, a 2x2 80 more, past 2000; the 1x1 after it is held
     too, though its 16 would fit, since "the first" means the first; and the second 2x2
     is the first's part, so it costs nothing more and is held with it */
  await arrive(page, '#w=500&d=500&bl=' + [linkBin(0, 0, 9, 9, 3, 4), linkBin(9, 0, 2, 2, 3, 4),
    linkBin(9, 2, 1, 1, 3, 4), linkBin(9, 3, 2, 2, 3, 4)].join('_'));
  const built = () => page.evaluate(() => types().map((t) => [typeName(t), geomFor(t.b).meta.holes || 0]).sort());
  expect(await built()).toEqual([['bin-1x1x3-qty1', 0], ['bin-2x2x3-qty2', 0], ['bin-9x9x3-hex-bit-holes-qty1', 1927]]);
  expect(await page.evaluate(() => B().map((b) => packBin(b).split('-').slice(23).join('-'))), 'the setting is kept')
    .toEqual(['4-0', '4-0', '4-0', '4-0']);
  await expect(page.locator('#warnings .w.err').filter({ hasText: 'holes are set' })).toHaveText(
    '2023 holes are set across the floors of different bins, more than the 2000 one layout builds, so the bins of ' +
    'the 2 kinds after the first 1927 holes are built without them. Set some to Nothing; print a layout with this ' +
    'many holes in parts.');

  // the bin says why, where its holes are
  await H.clickCell(page, 9, 0);
  await settle(page);
  expect(await lead(page)).toBe('This layout already builds 1927 holes across other bins\' floors, and this bin\'s 80 ' +
    'would take it past the 2000 one layout builds, so it is built without them.');
  // and the one held for coming after it says that, not that its own 16 are too many
  await H.clickCell(page, 9, 2);
  await settle(page);
  expect(await lead(page)).toBe('Bins before this one in the layout already ask for more holes than the 2000 one ' +
    'layout builds, so this bin is built without its 16 holes.');

  // the big one set to Nothing, the rest are built, and Checks has nothing to say of it
  await H.clickCell(page, 0, 0);
  await holesFor(page, 0);
  expect(await built()).toEqual([['bin-1x1x3-hex-bit-holes-qty1', 16], ['bin-2x2x3-hex-bit-holes-qty2', 80], ['bin-9x9x3-qty1', 0]]);
  await expect(checks(page)).not.toContainText('holes are set');
});

/* A bin asking for more removable dividers than fit is built with as many as fit, and
   Checks says so; with holes across its floor it is built with none, so it is told they
   are left off, and nothing of how many fit: no plates, no compartments, no rails. */
test('a bin with holes asking for 31 removable dividers is told they are left off, not that 10 are built',
  async ({ page }) => {
    const link = (insert) => `#bl=0-0-1-1-3-1.2-1.2-31-0-0-1-1-1-1-0-0-0-0-1-0-15-0-0-${insert}-0`;
    await arrive(page, link(0));
    await expect(checks(page)).toContainText('is built with 10 removable dividers across, not the 31 it asks for');
    expect(await page.evaluate(() => [typeName(types()[0]), dividerParts().length, compartments(B()[0])]))
      .toEqual(['bin-1x1x3-10x0div-qty1', 1, 11]);

    await arrive(page, link(1));
    await expect(checks(page)).toContainText('has holes for AA batteries, so its dividers are left off');
    await expect(checks(page)).not.toContainText('removable divider');
    expect(await page.evaluate(() => [typeName(types()[0]), dividerParts().length, compartments(B()[0]),
      geomFor(B()[0]).meta.holes, B()[0].divX]))
      .toEqual(['bin-1x1x3-aa-holes-qty1', 0, 0, 4, 31]);
    await H.clickCell(page, 0, 0);
    await settle(page);
    expect(await rest(page)).toContain('Dividers are left off a bin with holes.');
  });

/* Removable dividers both ways on a bin with its lip, a scoop and a shelf have their plates
   notch the lip and the shelf, cut to the scoop and halve where they cross, and Checks
   says how they go in. With holes across its floor there are none: no plates, no notches
   weighed, no notes of them, and the bin weighs and builds as the bin asking for none. */
test('a bin with holes asking for removable dividers both ways has no plates, notches or notes of them',
  async ({ page }) => {
    const link = (insert) => `#bl=0-0-2-2-3-1.2-1.2-2-2-0-1-1-1-1-8-12-0-0-1-0-15-0-0-${insert}-0`;
    await arrive(page, link(0));
    await expect(checks(page)).toContainText('halve together where they cross');
    expect(await page.evaluate(() => dividerParts().length)).toBe(2);

    await arrive(page, link(2));
    await expect(checks(page)).toContainText('has holes for AAA batteries, so its dividers and scoop are left off');
    for (const t of ['removable divider', 'halve together', 'bottom front corner', 'scoop rather than'])
      await expect(checks(page)).not.toContainText(t);
    expect(await page.evaluate(() => {
      const b = B()[0], none = Object.assign({}, b, { divX: 0, divY: 0, divRemovable: false });
      return [b.divX, b.divY, b.divRemovable, builtDivs(b), dividerParts().length, layoutReadme().includes('DIVIDER'),
              geomFor(b).meta.holes > 0, buildBin(G, binCfg(b)).polys.length === buildBin(G, binCfg(none)).polys.length,
              Math.abs(volumeMm3(b).raw - volumeMm3(none).raw) < 1e-6];
    })).toEqual([2, 2, true, { divX: 0, divY: 0 }, 0, false, true, true, true]);
  });

// and one bin past it on its own has none, as a fault: what was asked for is not built
test('a bin with more holes than one bin is built with has none, and says so', async ({ page }) => {
  await arrive(page, '#w=500&d=500&bl=' + linkBin(0, 0, 10, 10, 3, 4));
  expect(await page.evaluate(() => [typeName(types()[0]), geomFor(B()[0]).meta.holes || 0])).toEqual(['bin-10x10x3-qty1', 0]);
  await expect(page.locator('#warnings .w.err').filter({ hasText: 'holes for' })).toHaveText(
    'Layer 1, the 10×10 bin at column 1 row 1: would have 2392 holes for hex bits, more than the 2000 one bin is ' +
    'built with, so it has none.');
  await H.clickCell(page, 0, 0);
  await settle(page);
  expect(await lead(page)).toBe('A bin this size would have 2392 holes for hex bits, more than the 2000 one bin is ' +
    'built with, so it has none.');
});
