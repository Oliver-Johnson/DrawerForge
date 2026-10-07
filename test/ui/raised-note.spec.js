/* A bin's note raised on its label shelf, on the bins page: the "On the shelf" menu in
 * panel 03, the hint under the note that says what will print, and the notes Checks
 * gains about it.
 *
 * The geometry is the audit's (test/bin-audit.js probes the letters at H - 0.4 and the
 * shelf at H - 1.0, and stack-check.js holds them under the bin above). What is tested
 * here is that the page asks for what it says it does, and says what it prints: the
 * hint is the only place a person finds out before printing that half their note will
 * not fit, or that the emoji in it is not going to come out.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(400);
const raise = async (page, on = true) => {
  await page.selectOption('#labelMode', on ? '1' : '0');
  await settle(page);
};
const note = async (page, text) => {
  await page.fill('#note', text);
  await settle(page);
};
const hint = (page) => page.locator('#noteHint');
// the hint's own words, without the "more"/"less" of its button
const lead = (page) => page.evaluate(() => {
  const h = document.getElementById('noteHint'), b = h.querySelector(':scope>button.more');
  return (b ? b.previousElementSibling.textContent : h.textContent).trim();
});
const checks = (page) => page.locator('#warnings');

test.beforeEach(async ({ page }) => {
  await H.forgetSaved(page);
  page.__errors = await H.openBins(page);
  /* A page without the menu fails here, at once, rather than every case waiting out the
     whole timeout on a select it cannot find. */
  await expect(page.locator('#labelMode'), 'the page has the "On the shelf" menu').toHaveCount(1, { timeout: 2000 });
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

test('the note raised: the menu gives the bin a shelf, and the bin becomes its own part', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);                 // a 1x1x3, selected
  await note(page, 'M3 screws');
  const plain = await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0])]);
  await expect(page.locator('#labelMode')).toHaveValue('0');
  await expect(page.locator('#label')).toHaveValue('0');
  await expect(hint(page), 'nothing to say while nothing is raised').toBeHidden();
  expect(plain[1], 'a note that is not printed stays out of the name').toBe('bin-1x1x3-qty1');

  await raise(page);
  // no shelf to print on, so choosing it gave the bin one, in the same step
  await expect(page.locator('#label')).toHaveValue('12');
  expect(await page.evaluate(() => [B()[0].labelMode, B()[0].label])).toEqual([1, 12]);
  await expect(hint(page)).toBeVisible();
  expect(await lead(page)).toBe('Prints 4.5 mm tall on one line.');

  const [key, name, top, cap] = await page.evaluate(() => {
    const b = B()[0], H = b.hUnits * SPEC.unitH;
    // the highest point the build reaches well inside the lip's opening: the letters' tops
    let z = -Infinity;
    for (const p of geomFor(b).polys)
      for (const v of p.verts) if (Math.abs(v[0]) < 15 && Math.abs(v[1]) < 15) z = Math.max(z, v[2]);
    return [typeKey(b), typeName(types()[0]), z - H, printedNote(b).fit.cap];
  });
  expect(key, 'a printed note is its own part').not.toBe(plain[0]);
  /* keyed on the lines as printed, written as character codes, and the letters' size:
     never the note itself */
  const codes = [...'M3 screws'].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
  expect(key).toBe(plain[0] + '-L12-n' + codes + '.' + +cap.toFixed(6));
  expect(key).not.toMatch(/M3|screws/i);
  expect(name).toBe('bin-1x1x3-m3-screws-qty1');
  expect(top, 'the letters stop 0.4 mm under the rim').toBeCloseTo(-0.4, 6);
  // the link carries it in the one field it added, and a plain bin's is as it was
  expect(await page.evaluate(() => packBin(B()[0]).split('-').slice(21))).toEqual(['0', '1']);

  // one step back takes the menu and the shelf it brought back together
  await page.locator('#undoBtn').click();
  await settle(page);
  expect(await page.evaluate(() => [B()[0].labelMode || 0, B()[0].label])).toEqual([0, 0]);
  await expect(page.locator('#labelMode')).toHaveValue('0');
  await expect(hint(page)).toBeHidden();
  expect(await page.evaluate(() => packBin(B()[0]).split('-').length)).toBe(21);
});

test('a shelf that is already there keeps its depth, and the next bins drawn take the setting',
  async ({ page }) => {
    await H.dragCells(page, [0, 0], [1, 0]);               // a 2x1
    await H.setField(page, 'label', 15);
    await raise(page);
    await expect(page.locator('#label')).toHaveValue('15');

    // with nothing selected the panel is the new bins' settings
    await page.evaluate(() => { clearSel(); readControls(); drawMap(); refresh(); });
    await settle(page);
    if (await page.locator('#s-bin.closed').count()) await page.locator('#s-bin > h2 > button').click();
    await raise(page);
    await expect(hint(page)).toHaveText('New bins print their note raised on the label shelf, once you give each one a note.');
    await H.dragCells(page, [0, 2], [0, 2]);
    expect(await page.evaluate(() => B()[B().length - 1].labelMode)).toBe(1);
    await expect(hint(page)).toHaveText('Type what goes in it above, and it prints raised on the label shelf.');
  });

test('the hint says what is left off, and a long one keeps the rest behind "more"', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await raise(page);

  // what has a glyph prints, curly quotes as straight ones; an emoji is named as left off
  await note(page, '“10µF” ±5% \u{1F642}');
  expect(await lead(page)).toMatch(/^Prints [\d.]+ mm tall on one line\. \u{1F642} cannot print, so it is left off\.$/u);
  await expect(hint(page).locator('button.more')).toHaveCount(0);

  // more than three are counted in the sentence and named behind "more"
  await note(page, 'café ñ ü ß \u{1F642}');
  expect(await lead(page)).toMatch(/5 characters cannot print, so they are left off\.$/);
  const more = hint(page).locator('button.more');
  await expect(more).toHaveCount(1);
  await expect(more).toHaveAttribute('aria-describedby', 'noteHintLead');
  await expect(hint(page).locator('.moretext')).toBeHidden();
  await expect(hint(page).locator('.moretext')).toHaveText('They are é, ñ, ü, ß and \u{1F642}.');

  // a note too long for the shelf is cut short, and the hint says how it will read
  await note(page, 'Assorted M3 M4 nuts, washers');
  expect(await lead(page)).toMatch(/^Prints 3 mm tall on two lines, cut short to fit\.$/);
  await expect(hint(page).locator('.moretext')).toContainText('It reads “Assorted M3 / M4 nuts, wa');
  // still no taller than four lines until it is opened (hints.spec.js holds the rest)
  const lines = await page.evaluate(() => {
    const h = document.getElementById('noteHint');
    return h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight);
  });
  expect(lines).toBeLessThanOrEqual(4.05);
  await more.click();
  await expect(hint(page).locator('.moretext')).toBeVisible();

  // and nothing printable at all
  await note(page, '\u{1F642}\u{1F642}');
  expect(await lead(page)).toBe('Nothing in this note can print, so the shelf stays plain.');
});

test('Checks says when the note is wrapped, cut short, left off or has no shelf', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await raise(page);
  await note(page, 'Resistors 10k to 100k');
  await expect(checks(page)).toContainText('has its note on two lines, 3.7 mm tall');

  await note(page, 'Assorted M3 M4 nuts, washers');
  await expect(checks(page)).toContainText('has its note cut short to fit its label shelf, 3 mm tall');

  // what was typed is shown as typed: as text, never as markup
  await note(page, '<b>x</b> & "y" \u{1F642}');
  await expect(checks(page)).toContainText('has a character in its note that cannot print, so it is left off: \u{1F642}');
  await note(page, '<b>bold</b> <i>and</i> & "quoted"');
  await expect(checks(page)).toContainText('it prints as “<b>bold</b>');
  expect(await page.locator('#warnings b, #warnings i, #noteHint b, #noteHint i').count()).toBe(0);
  // notes, not faults: nothing here stops a download
  expect(await page.locator('#warnings .w.err').count()).toBe(0);

  // too short a bin for a shelf letters could stand on
  await note(page, 'M3');
  await H.setField(page, 'hUnits', 1);
  await expect(checks(page)).toContainText('is too short for a label shelf to print its note on, so its note is not printed');
  expect(await lead(page)).toBe('A bin this short has no room under its rim for a shelf to print on, so nothing prints.');
  await H.setField(page, 'hUnits', 3);

  // a shelf typed shallower than letters need
  await H.setField(page, 'label', 5);
  expect(await lead(page)).toBe('The label shelf is 5 mm deep, and letters need 6 mm, so nothing prints.');
  await expect(checks(page)).toContainText('has a label shelf only 5 mm deep, under the 6 mm letters need');

  // no shelf at all, once the menu has given one and it is taken away again
  await H.setField(page, 'label', 0);
  expect(await lead(page)).toBe('Give it a label shelf above, and the note prints raised on it.');
  await expect(checks(page)).toContainText('is set to print its note on its label shelf, but it has none');
  await H.setField(page, 'edgeB', '0.5');
  await H.setField(page, 'label', 12);
  expect(await lead(page)).toBe('With the back wall lowered there is no label shelf, so the note does not print.');
  await expect(checks(page)).toContainText('but its back wall is lowered, so it has none');
});

/* Fixed dividers stand through the shelf, rails and plates too, so the letters go in the
   widest space between them, keeping 0.4 mm off each. The audit holds the geometry
   (bin-audit's divider cases); this is that the page says so, and says when there is no
   space wide enough. */
test('dividers: the note goes between them, or the hint and Checks say there is no room', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await raise(page);
  await note(page, 'M3 screws');
  expect(await lead(page)).toBe('Prints 4.5 mm tall on one line.');

  await H.setField(page, 'divX', 1);
  // half the shelf each side of the divider: two lines, smaller
  expect(await lead(page)).toBe('Prints 3.2 mm tall on two lines, between the dividers.');
  await expect(hint(page).locator('.moretext')).toHaveText(
    'The dividers stand through the shelf, so the letters go in the widest space between them.');
  await expect(checks(page)).toContainText('has its note on two lines, 3.2 mm tall');

  // seven leave no space a letter fits in
  await H.setField(page, 'divX', 7);
  expect(await lead(page)).toBe('The dividers leave no space on the label shelf wide enough for the note, so nothing prints.');
  await expect(checks(page)).toContainText(
    'has dividers across its label shelf too close together for its note to fit between them, so its note is not printed');
  // the bin is the plain part again, since nothing prints on it
  expect(await page.evaluate(() => typeKey(B()[0]).includes('-n'))).toBe(false);
  // removable ones too: the plates' slots and the rails beside them
  await page.check('#divRemovable');
  await H.setField(page, 'divX', 4);
  await settle(page);
  expect(await lead(page)).toBe('The dividers leave no space on the label shelf wide enough for the note, so nothing prints.');
  await H.setField(page, 'divX', 1);
  // a plate's slot and two rails take more of the shelf than a fixed divider does
  expect(await lead(page)).toBe('Prints 3 mm tall on two lines, between the dividers, cut short to fit.');
  expect(await page.locator('#warnings .w.err').count(), 'notes, not faults').toBe(0);
});

/* A shelf is held to 80% of the inside's depth as well as to the height under the rim. A
   bin only half a cell deep with thick walls is held by that, and was told a taller bin
   had room for a deeper shelf, which it does not. */
test('a shelf held by the inside\'s depth says so, not that a taller bin would do', async ({ page }) => {
  await page.evaluate(() => startScratch());
  await settle(page);
  for (const [id, x] of [['v', 0.5], ['hUnits', 6], ['wall', 3], ['label', 12]]) await H.setField(page, id, x);
  await raise(page);
  await note(page, 'M3');
  expect(await lead(page)).toBe("A shelf takes at most 80% of the inside's depth, 5.8 mm here, and letters need 6 mm, so nothing prints.");
  await expect(hint(page).locator('.moretext')).toHaveText(
    'A bin deeper from front to back, or with thinner walls, has room for a deeper shelf.');
});

/* Two notes are two parts. The key used to carry a 32-bit hash of the printed lines,
   and these two hash alike: they came out one part, one bin printing the other's
   letters, with one file between them. */
test('two notes are two parts, even two a 32-bit hash cannot tell apart', async ({ page }) => {
  for (const [x, text] of [[0, 'Kit 2wlfa'], [1, 'Kit zqdha']]) {
    await H.dragCells(page, [x, 0], [x, 0]);
    await raise(page);
    await note(page, text);
  }
  const out = await page.evaluate(() => ({
    hashes: B().map((b) => noteHash(b.note)),
    lines: types().map((t) => printedNote(t.b).fit.lines.join(' / ')).sort(),
    names: [...typeNames().values()].sort(),
  }));
  expect(out.hashes[0], 'the two notes this case is about hash alike').toBe(out.hashes[1]);
  expect(out.lines).toEqual(['Kit 2wlfa', 'Kit zqdha']);
  expect(out.names).toEqual(['bin-1x1x3-kit-2wlfa-qty1', 'bin-1x1x3-kit-zqdha-qty1']);
});
