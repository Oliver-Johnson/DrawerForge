/* Browser-level checks for the bins page.
 *
 * The geometry has had audits from the start; the interface had none, and every
 * bug found in it was found by hand. Each test below is a bug that actually
 * shipped, so the suite is a record of them rather than a wish list.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

test.beforeEach(async ({ page }) => {
  const errors = await H.openBins(page);
  page.__errors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

test('drag places a bin of the dragged size', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 1]);
  const b = await H.bins(page);
  expect(b).toHaveLength(1);
  expect([b[0].u, b[0].v]).toEqual([3, 2]);
  expect(b[0].carved).toBe(false);
});

test('alt-click carves a cell out and puts it back', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);
  let b = await H.bins(page);
  expect(b[0].cells).toHaveLength(8);
  expect(b[0].carved).toBe(true);
  expect(b[0].cells).not.toContain('2,2');

  await H.clickCell(page, 2, 2, ['Alt']);
  b = await H.bins(page);
  expect(b[0].cells).toHaveLength(9);
  expect(b[0].carved).toBe(false);
});

/* A carved bin is a normal bin. It was reported as an error and painted red the
   moment you carved, which made the feature look broken as you used it. */
test('a carved bin keeps its stacking lip and is not an error', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);

  const meta = await page.evaluate(() => {
    const m = geomFor(B()[0]).meta;
    return { hasLip: m.hasLip, totalH: m.totalH, pitch: m.H, carved: m.carved };
  });
  expect(meta.carved).toBe(true);
  expect(meta.hasLip).toBe(true);
  // same overall height as the rectangle of the same unit count: 3 x 7 + 3.95 lip
  expect(meta.pitch).toBeCloseTo(21, 3);
  expect(meta.totalH).toBeCloseTo(24.95, 3);

  expect(await page.locator('#fillmap .clash').count()).toBe(0);
  expect(await page.locator('#warnings .w.err').count()).toBe(0);
  await expect(page.locator('#warnings')).toContainText('keeps its stacking lip');
});

test('the carve button drives the same thing, and lets you out again', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  const btn = page.locator('#carveMode');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText(/Carve this bin/);

  await btn.click();
  await expect(btn).toHaveText(/Done carving/);
  await expect(page.locator('#fillmap')).toHaveClass(/carving/);

  await H.clickCell(page, 2, 2);                       // plain click now carves
  expect((await H.bins(page))[0].cells).toHaveLength(8);

  // clicking outside the bin must not be swallowed, or the mode traps you
  await H.clickCell(page, 6, 6);
  await expect(page.locator('#fillmap')).not.toHaveClass(/carving/);

  await btn.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#fillmap')).not.toHaveClass(/carving/);
});

/* Resizing left the old mask in place. Cells outside the new box drew nothing on
   the map yet still blocked other bins and still built in the preview. */
test('resizing a carved bin reconciles its mask', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);

  await H.setField(page, 'u', 4);
  await H.setField(page, 'v', 4);
  let b = await H.bins(page);
  expect(b[0].outsideBox, 'mask must never reach outside the bounding box').toBe(0);
  expect(b[0].cells).toHaveLength(15);          // 4x4 with the one hole carried over
  expect(b[0].cells).not.toContain('2,2');

  // shrinking past the hole drops it: a rectangle is the only honest result
  await H.setField(page, 'u', 2);
  await H.setField(page, 'v', 2);
  b = await H.bins(page);
  expect(b[0].outsideBox).toBe(0);
  expect(b[0].carved).toBe(false);
  expect(b[0].cells).toHaveLength(4);

  // and the cells it gave up must really be free again
  await H.dragCells(page, [3, 3], [3, 3]);
  expect(await H.bins(page)).toHaveLength(2);
});

/* Selecting bins of different sizes bulk-assigned the primary's footprint onto
   all of them, silently resizing every bin in the selection. */
test('multi-select edits settings without resizing anything', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 1]);        // 3x2
  await H.dragCells(page, [0, 3], [0, 4]);        // 1x2
  await H.clickCell(page, 0, 0, ['Control']);     // both selected

  const b = await H.bins(page);
  expect(b.map((x) => `${x.u}x${x.v}`).sort()).toEqual(['1x2', '3x2']);

  await H.setField(page, 'hUnits', 5);
  const after = await H.bins(page);
  expect(after.map((x) => `${x.u}x${x.v}`).sort()).toEqual(['1x2', '3x2']);
  expect(after.every((x) => x.hUnits === 5), 'the shared setting should apply to both').toBe(true);
});

test('merging two bins makes one bin of their combined shape', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 1]);        // 3x2
  await H.dragCells(page, [0, 2], [0, 3]);        // 1x2 on its left end
  await H.clickCell(page, 0, 0, ['Control']);
  await page.locator('#mergeBins').click();
  await page.waitForTimeout(300);

  const b = await H.bins(page);
  expect(b).toHaveLength(1);
  expect([b[0].u, b[0].v]).toEqual([3, 4]);
  expect(b[0].carved).toBe(true);
  expect(b[0].cells).toHaveLength(8);
  expect(b[0].outsideBox).toBe(0);
});

/* The plan drew bounding boxes, so an L was shown as a rectangle. */
test('the print plan draws the shape that will actually print', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  const full = await page.locator('#plateWrap svg rect').count();
  expect(full).toBe(1);

  await H.clickCell(page, 2, 2, ['Alt']);
  await page.waitForTimeout(300);
  expect(await page.locator('#plateWrap svg rect').count()).toBe(8);
});

test('cell coverage counts the cells a bin occupies, not its bounding box', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await expect(page.locator('body')).toContainText('9/');
  await H.clickCell(page, 2, 2, ['Alt']);
  await expect(page.locator('body')).toContainText('8/');
});

/* A bin prints in one piece, so a tall one is a hard stop rather than a split. */
test('a bin taller than the printer is called out', async ({ page }) => {
  await H.setField(page, 'bedH', 120);
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'hUnits', 18);
  await expect(page.locator('#warnings')).toContainText('Z height');
});

/* The layout travels in the URL hash; a carved shape has to survive that like
   anything else, or sharing a link quietly changes what people print. */
test('a carved layout survives a round trip through the url', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);
  const before = await H.bins(page);

  const link = await page.evaluate(() => shareLink());
  await page.goto(link);
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(400);

  expect(await H.bins(page)).toEqual(before);
});

/* A carved shape and a solid block are built with no dividers, whatever the bin asks for
   (buildBin), but the page listed them as asked: a carved L asking for two across and
   one along was "2×2×3 · 6 comp" in the parts list and "6 compartments" in the README,
   and its STL was named bin-2x2x3-2x1div, and a solid block the same. Rows, README and
   names now go by the dividers built (dividersBuilt), so those say none, and a carved
   or solid bin asking for dividers is the same part as one that does not. A plain bin
   with dividers keeps its count and the name it had. */
test('a carved or solid bin is listed and named without the dividers it is built without', async ({ page }) => {
  const binAt = (x, y, more) => [x, y, 2, 2, 3, 1.2, 1.2, 2, 1, ...more].join('-');
  await page.goto('about:blank');
  await page.goto(H.BINS_URL + '#bl=' + [
    binAt(0, 0, [0, 1, 1, 1, 1, 0, 0, '1110']),             // carved L, fixed dividers asked
    binAt(3, 0, [0, 1, 1, 1, 1, 0, 0, '1110', 0, 1]),       // carved L, removable ones asked
    binAt(0, 3, [1]),                                       // a solid block asking for them
    binAt(3, 3, []),                                        // a plain bin with fixed ones
  ].join('_'));
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(400);
  const got = await page.evaluate(() => ({
    asked: layers[0].bins.map((b) => [b.divX, b.divY, (b.cells || []).length, !!b.solid]),
    rows: [...document.querySelectorAll('#typeRows tr td:first-child')].map((e) => e.textContent),
    names: types().map((t) => typeNames().get(t.key)).sort(),
    readme: layoutReadme().split('\n').filter((l) => /^\s+\d+ x\s+2x2x3/.test(l)),
    plates: dividerParts().length,
  }));
  expect(got.asked, 'fixture: every bin asks for two across and one along')
    .toEqual([[2, 1, 3, false], [2, 1, 3, false], [2, 1, 0, true], [2, 1, 0, false]]);
  expect(got.rows.filter((r) => /comp/.test(r))).toEqual(['2×2×3 · 6 comp']);
  expect(got.rows).toEqual(expect.arrayContaining(['2×2×3', '2×2×3 solid']));
  expect(got.readme.filter((l) => /compartments/.test(l))).toEqual([expect.stringMatching(/^\s+1 x\s+2x2x3 .*\)\s+6 compartments$/)]);
  expect(got.names).toEqual(['bin-2x2x3-2x1div-qty1', 'bin-2x2x3-qty2', 'bin-2x2x3-solid-qty1']);
  expect(got.plates, 'and no loose plates for the carved one').toBe(0);
});

/* The libraries are vendored, not fetched from a CDN. Two things must hold: they
   actually load from the relative path (a wrong path fails silently until you try to
   render), and nothing on the page reaches a third party — which is what lets the
   page claim nothing is uploaded and nothing is tracked. */
test('libraries load locally and nothing calls out to a third party', async ({ page }) => {
  const offsite = [];
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (!/^(file|data|blob):/.test(u)) offsite.push(u);
    return route.continue();
  });
  await page.goto(H.BINS_URL);
  await page.waitForFunction(() => typeof THREE !== 'undefined');

  const libs = await page.evaluate(() => ({
    three: typeof THREE !== 'undefined' ? THREE.REVISION : null,
    jszip: typeof JSZip !== 'undefined' ? JSZip.version : null,
    srcs: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')),
  }));
  expect(libs.three).toBe('128');
  expect(libs.jszip).toBe('3.10.1');
  expect(libs.srcs.every((s) => !/^(https?:)?\/\//.test(s)), `external script: ${libs.srcs}`).toBe(true);
  expect(offsite, 'the page must not reach off-site').toEqual([]);
});

/* An empty preview used to be the baseplate slab on its own, filling the panel and
   running off every edge with nothing to identify it. It read as a failed render, and
   it was the largest element on the page. */
test('an empty drawer says so instead of showing a bare slab', async ({ page }) => {
  await expect(page.locator('#threeempty')).toBeVisible();
  await expect(page.locator('#threeempty')).toHaveText(/place a bin/i);
  // nothing in the scene, rather than a slab nobody can identify
  expect(await page.evaluate(() => group.children.length)).toBe(0);
  // and the canvas is still live, or the touch gestures have nothing to act on
  expect(await page.locator('#three').evaluate((c) => getComputedStyle(c).visibility))
    .not.toBe('hidden');

  await H.dragCells(page, [0, 0], [1, 1]);
  await expect(page.locator('#threeempty')).toBeHidden();
  expect(await page.evaluate(() => group.children.length)).toBeGreaterThan(0);

  // and it comes back, so this is state and not a one-shot on load
  await page.locator('#clearAll').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#threeempty')).toBeVisible();
});

/* Turning the drawer shell on is asking to look at the drawer, so an empty one is a
   real answer rather than a blank panel. */
test('the drawer shell still draws with nothing placed', async ({ page }) => {
  await page.evaluate(() => {
    const t = document.getElementById('showDrawer');
    t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await expect(page.locator('#threeempty')).toBeHidden();
  expect(await page.evaluate(() => drawerGroup && drawerGroup.children.length))
    .toBeGreaterThan(0);
});
