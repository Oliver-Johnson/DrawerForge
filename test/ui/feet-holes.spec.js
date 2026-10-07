/* Holes in the feet, on the bins page: the Feet row in panel 03, the magnet size beside
 * it, and everything downstream that has to know a holed bin is a different part — its
 * name, the link, Apply to all, the README and Checks.
 *
 * The geometry is the audit's (test/bin-audit.js probes every hole it builds). What is
 * tested here is that the page asks for the holes it says it does, and says what they
 * need: a README that lists a drawer of magnet pockets without saying how many magnets
 * to buy is the README being read at the printer with the wrong number in hand.
 */
'use strict';
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
const JSZip = require('../../vendor/jszip.min.js');

const settle = (page) => page.waitForTimeout(900);   // past the 400 ms save debounce
async function arrive(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
}
const holesOf = (page) => page.evaluate(() => B().map((b) =>
  ['magnets', 'screws', 'holesEvery'].filter((k) => b[k]).join('+') || 'none'));
const tick = async (page, id, on = true) => {
  await page.locator('#' + id)[on ? 'check' : 'uncheck']();
  await page.waitForTimeout(300);
};
/* With nothing selected the panel is "New bins", and it loads closed. */
const openPanel = async (page) => {
  if (await page.locator('#s-bin.closed').count()) await page.locator('#s-bin > h2 > button').click();
};
const where = async (page, v) => {
  await page.selectOption('#holesWhere', v);
  await page.waitForTimeout(300);
};

test.beforeEach(async ({ page }) => {
  await H.forgetSaved(page);
  page.__errors = await H.openBins(page);
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

test('ticking a hole box makes a different part, and says what it takes', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 0]);                 // a 2x1, selected
  const plain = await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0])]);
  await expect(page.locator('#holesWhereRow')).toBeHidden();
  await expect(page.locator('#magnetHint')).toBeHidden();

  await tick(page, 'magnets');
  expect(await holesOf(page)).toEqual(['magnets']);
  await expect(page.locator('#magnetHint')).toBeVisible();
  await expect(page.locator('#magnetHint')).toContainText('Pockets for 6 x 2 mm magnets');
  await expect(page.locator('#holesWhereRow')).toBeVisible();
  await expect(page.locator('#holeCount')).toHaveText('This bin takes 4 magnets.');
  const holed = await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0]), geomFor(B()[0]).meta.magnets]);
  expect(holed[0], 'a holed bin is its own type, so its own STL').not.toBe(plain[0]);
  expect(holed[1]).toBe('bin-2x1x3-magnets-qty1');
  expect(plain[1]).toBe('bin-2x1x3-qty1');
  expect(holed[2], 'the mesh has the holes the panel counts').toBe(4);

  // every cell: a 2x1 has eight sites, and the name says so, since corners has four
  await where(page, 'every');
  await expect(page.locator('#holeCount')).toHaveText('This bin takes 8 magnets.');
  expect(await page.evaluate(() => typeName(types()[0]))).toBe('bin-2x1x3-magnets-every-cell-qty1');

  // screws raise the floor: a note, not a problem
  await tick(page, 'screws');
  await expect(page.locator('#screwHint')).toBeVisible();
  await expect(page.locator('#holeCount')).toHaveText('This bin takes 8 magnets, 8 screws.');
  await expect(page.locator('#warnings')).toContainText('its floor is built 1.85 mm thick rather than 1.2 mm');
  await expect(page.locator('#warnBadge')).toBeHidden();
  expect(await page.evaluate(() => geomFor(B()[0]).meta.floorZ)).toBeCloseTo(4.75 + 1.85, 6);

  // each box is an undo step of its own
  await page.locator('#undoBtn').click();
  await page.waitForTimeout(300);
  expect(await holesOf(page)).toEqual(['magnets+holesEvery']);
});

/* The selection goes with an Undo, so afterwards the panel is "New bins", holding the bin
   it last showed. It went on holding the screws the Undo had just taken off that bin, and
   being the panel for new bins, it handed them to the next bin drawn. */
test('undoing a holes tick shows the bin without it at once', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 0]);
  await tick(page, 'magnets');
  await tick(page, 'screws');
  await page.locator('#undoBtn').click();
  await page.waitForTimeout(300);
  expect(await holesOf(page)).toEqual(['magnets']);
  expect(await page.evaluate(() => ['magnets', 'screws'].map((id) => document.getElementById(id).checked)),
    'the boxes still showed the step the Undo took back').toEqual([true, false]);
  expect(await page.evaluate(() => document.getElementById('screwHint').style.display)).toBe('none');
  // and the next bin drawn takes what the panel shows
  await H.dragCells(page, [3, 0], [3, 0]);
  expect(await holesOf(page)).toEqual(['magnets', 'magnets']);
});

test('a 1x1 is the same part with holes in its corners or in every cell', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await tick(page, 'magnets');
  const corners = await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0])]);
  await where(page, 'every');
  expect(await page.evaluate(() => [typeKey(B()[0]), typeName(types()[0])])).toEqual(corners);
  await expect(page.locator('#holeCount')).toHaveText('This bin takes 4 magnets.');
});

test('new bins are drawn with the holes set in the panel', async ({ page }) => {
  await openPanel(page);
  await tick(page, 'magnets');
  await tick(page, 'screws');
  await expect(page.locator('#holeCount')).toHaveText('A new 1 by 1 bin takes 4 magnets, 4 screws.');
  await H.dragCells(page, [0, 0], [1, 1]);
  expect(await holesOf(page)).toEqual(['magnets+screws']);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(400);
  const all = await holesOf(page);
  expect(all.length).toBeGreaterThan(2);
  expect(all.every((h) => h === 'magnets+screws')).toBe(true);
});

test('Apply to all carries the holes to every bin', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 0]);
  await H.dragCells(page, [0, 2], [0, 3]);
  await H.dragCells(page, [3, 0], [3, 0]);
  expect(await holesOf(page)).toEqual(['none', 'none', 'none']);
  await tick(page, 'magnets');
  await tick(page, 'screws');
  await where(page, 'every');
  await page.locator('#applyAll').click();
  await page.waitForTimeout(300);
  expect(await holesOf(page)).toEqual(Array(3).fill('magnets+screws+holesEvery'));

  // and taking them off again carries too
  await tick(page, 'magnets', false);
  await tick(page, 'screws', false);
  await page.locator('#applyAll').click();
  await page.waitForTimeout(300);
  expect((await holesOf(page)).map((h) => h.replace('holesEvery', ''))).toEqual(Array(3).fill(''));
});

test('holes and the magnet size survive a round trip through the url', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 0]);
  await tick(page, 'magnets');
  await tick(page, 'screws');
  /* A new bin starts from the panel as it was left, which was the first bin's: so it
     is born with magnets and screws, and loses the screws here. */
  await H.dragCells(page, [0, 2], [1, 3]);
  await tick(page, 'screws', false);
  await where(page, 'every');
  await H.setField(page, 'magnetD', '5');
  await H.setField(page, 'magnetH', '3');
  await expect(page.locator('#magnetSize')).toHaveText('5 x 3');
  const before = await holesOf(page);
  expect(before).toEqual(['magnets+screws', 'magnets+holesEvery']);

  const link = await page.evaluate(() => shareLink());
  expect(link).toContain('bmd=5');
  expect(link).toContain('bmh=3');
  await arrive(page, link);
  expect(await holesOf(page)).toEqual(before);
  expect(await page.inputValue('#magnetD')).toBe('5');
  expect(await page.inputValue('#magnetH')).toBe('3');
  expect(await page.evaluate(() => geomFor(B()[1]).meta.magnets)).toBe(16);
});

test('the magnet size starts at the baseplate\'s, and follows it until set', async ({ page }) => {
  await arrive(page, H.BINS_URL + '#md=5.5&mh=2.5&bl=0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-1');
  expect(await page.inputValue('#magnetD')).toBe('5.5');
  expect(await page.inputValue('#magnetH')).toBe('2.5');
  // not written as the bins' own: it is the plate's, and the plate's travels anyway
  const link = await page.evaluate(() => shareLink());
  expect(link).not.toContain('bmd=');
  expect(link).toContain('md=5.5');

  // a plate magnet wider than a foot takes is held to the widest that fits
  await arrive(page, H.BINS_URL + '#md=10&mh=2&bl=0-0-1-1-3');
  expect(await page.inputValue('#magnetD')).toBe('7');
  expect(await page.evaluate(() => state.magnetD)).toBe(7);
});

test('a hostile magnet size in a link is held to what a foot takes', async ({ page }) => {
  await arrive(page, H.BINS_URL + '#bmd=1e9&bmh=-5&bl=0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-3');
  expect(await page.evaluate(() => [state.magnetD, state.magnetH])).toEqual([7, 1]);
  expect(await page.inputValue('#magnetD')).toBe('7');
  expect(await page.inputValue('#magnetH')).toBe('1');
  expect(await page.evaluate(() => geomFor(B()[0]).meta)).toMatchObject({ magnets: 4, screws: 4 });
  const saved = await page.evaluate(() => localStorage.getItem('drawerforge:bins:v1'));
  expect(saved).toContain('bmd=7');
  expect(saved).not.toContain('1e9');

  // not a number at all: the default, and a junk bitmask is no holes
  await arrive(page, H.BINS_URL + '#bmd=abc&bmh=&bl=0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15-1e9');
  expect(await page.evaluate(() => [state.magnetD, state.magnetH])).toEqual([6, 2]);
  expect(await holesOf(page)).toEqual(['none']);
});

test('the README says how many magnets and screws each type takes, and in all', async ({ page }) => {
  // new bins with magnets and screws, so everything drawn below starts with both
  await openPanel(page);
  await tick(page, 'magnets');
  await tick(page, 'screws');
  await H.dragCells(page, [0, 0], [1, 0]);                 // 2x1, corners: 4 + 4
  await H.dragCells(page, [0, 1], [1, 1]);                 // and another
  await H.dragCells(page, [0, 2], [1, 3]);                 // 2x2, every cell: 16 magnets
  await tick(page, 'screws', false);
  await where(page, 'every');
  await H.dragCells(page, [3, 0], [3, 0]);                 // a 1x1, made plain
  await where(page, 'corners');                            // hidden once there are no holes
  await tick(page, 'magnets', false);
  expect(await holesOf(page)).toEqual(['magnets+screws', 'magnets+screws', 'magnets+holesEvery', 'none']);

  await page.locator('#openExport').click();
  await expect(page.locator('#exFiles [data-ex="zip"]')).toBeEnabled();
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="zip"]').click(),
  ]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  expect(Object.keys(zip.files).sort()).toEqual([
    'README.txt',
    'bin-1x1x3-qty1.stl',
    'bin-2x1x3-magnets-screws-qty2.stl',
    'bin-2x2x3-magnets-every-cell-qty1.stl',
  ]);
  const readme = await zip.file('README.txt').async('string');
  expect(readme).toMatch(/2 x {2}2x1x3 .*4 magnets, 4 screws each/);
  expect(readme).toMatch(/1 x {2}2x2x3 .*16 magnets each/);
  expect(readme).toMatch(/1 x {2}1x1x3 [^\n]*mm incl\. lip\)\n/);
  expect(readme).toContain('Magnets: 24, 6 x 2 mm.');
  expect(readme).toContain('Screws: 8 M3, driven up through the baseplate.');

  // the rows in the dialog say it too, as plain text
  await expect(page.locator('#exFiles')).toContainText('2×1×3, 4 magnets, 4 screws each × 2');
});
