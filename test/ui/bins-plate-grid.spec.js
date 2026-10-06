/* The Bins map is the plate's grid, not the drawer divided by 42.
 *
 * The Bins page counted its cells as floor(drawer / 42) and nothing else. The baseplate
 * the design came from may have fewer: custom margins take their room off the drawer
 * before the cells are counted, so a 306 mm drawer with 20 mm a side is six cells wide,
 * not seven. Bins drew seven, offered the seventh to place bins in, and Fill the rest
 * filled it — a column of bins with no sockets under them, on a page that said nothing.
 * The margins were in the link all along: the Bins page carries every Baseplates setting
 * through untouched, and simply never read them.
 *
 * These go from one page to the other by the page's own link, over HTTP as the site is
 * served (see H.serveRoot), because the link is the thing that carries the margins.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

let site;
test.beforeAll(async () => { site = await H.serveRoot(); });
test.afterAll(() => site.close());

const platesReady = (page) => page.waitForFunction(
  () => /ready/.test(document.getElementById('pieceTail')?.textContent || ''),
  null, { timeout: 30000 });
const binsReady = async (page) => {
  await page.waitForFunction(() => typeof hashReady !== 'undefined' && hashReady &&
    !!document.getElementById('fillmap'));
  await page.waitForTimeout(300);
};
function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}
async function toBins(page) {
  await page.click('#toBins');
  await page.waitForURL(/\/bins\/#/);
  await binsReady(page);
}
// the map's own size, in cells: what is offered to drag across
const mapCells = (page) => page.evaluate(() => {
  const vb = document.getElementById('fillmap').getAttribute('viewBox').split(' ').map(Number);
  return [vb[2] / 40, vb[3] / 40];
});
const checksText = (page) => page.locator('#warnings').textContent();

test('custom margins on the plate leave the Bins map with the cells the plate has', async ({ page }) => {
  const errors = watch(page);
  await H.forgetSaved(page);
  await page.goto(site.base);
  await platesReady(page);
  // 306 x 380 is 7 x 9 cells; these margins leave 266 x 320, which is 6 x 7
  await H.setField(page, 'marginMode', 'custom');
  for (const [id, v] of [['mLeft', 20], ['mRight', 20], ['mFront', 30], ['mBack', 30]])
    await H.setField(page, id, v);
  await platesReady(page);
  const plate = await page.evaluate(() => [layout.nx, layout.ny]);
  expect(plate, 'fixture: the margins must cost the plate a column and rows').toEqual([6, 7]);

  await toBins(page);
  expect(await page.evaluate(() => [grid().nx, grid().ny]), 'the grid the page works in').toEqual(plate);
  expect(await mapCells(page), 'the map drawn to drag across').toEqual(plate);
  // and the cells Fill the rest fills: one 1 x 1 bin to each cell the plate has
  await page.locator('#fillRest').click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => B().length)).toBe(plate[0] * plate[1]);
  expect(errors).toEqual([]);
});

/* The cell fields are the other way to say the drawer size: n cells writes a drawer of
   n × 42 mm. With the plate keeping margins, that drawer came back as fewer cells than
   were typed, so the drawer the fields write has the margins added back. */
test('typing a cell count with the plate keeping margins gives that many cells', async ({ page }) => {
  const errors = watch(page);
  await page.goto(site.base + 'bins/#w=306&d=380&mm=custom&ml=20&mr=20&mf=30&mb=30');
  await binsReady(page);
  expect(await page.evaluate(() => [grid().nx, grid().ny]), 'fixture').toEqual([6, 7]);
  await H.setField(page, 'gridX', 5);
  await H.setField(page, 'gridY', 4);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => [grid().nx, grid().ny])).toEqual([5, 4]);
  expect(await page.evaluate(() => [state.drawerW, state.drawerD]))
    .toEqual([5 * 42 + 40, 4 * 42 + 60]);
  expect(errors).toEqual([]);
});

/* "Leave as gap" builds the grid alone with the leftover as gaps, and "Fill with solid
   margin" pads it — neither changes how many cells there are, so neither may cost the
   Bins page one. */
test('the other leftover-space modes keep the whole grid', async ({ page }) => {
  const errors = watch(page);
  for (const mm of ['auto', 'none']) {
    await page.goto(site.base + 'bins/#w=306&d=380&mm=' + mm + '&ml=20&mr=20&mf=30&mb=30');
    await binsReady(page);
    expect(await page.evaluate(() => [grid().nx, grid().ny]), mm).toEqual([7, 9]);
  }
  expect(errors).toEqual([]);
});

/* Spec bins are 42 mm, and a plate at any other pitch has no socket they seat in. The
   grid stays one of 42 mm cells in the room the plate's margins leave — the only grid a
   spec bin has — and Checks says, as an error, why none of it will fit. */
test('a plate at a pitch other than 42 mm is called out in Checks', async ({ page }) => {
  const errors = watch(page);
  await H.forgetSaved(page);
  await page.goto(site.base + '#w=306&d=380&pi=50');
  await platesReady(page);
  expect(await page.evaluate(() => state.pitch), 'fixture').toBe(50);
  await toBins(page);
  await expect(page.locator('#warnings .w.err').filter({ hasText: /50 mm/ })).toHaveCount(1);
  expect(await checksText(page)).toMatch(/42 mm/);
  expect(await page.evaluate(() => [grid().nx, grid().ny])).toEqual([7, 9]);

  // and at 42 there is nothing to say
  await page.goto(site.base + 'bins/#w=306&d=380&pi=42');
  await binsReady(page);
  expect(await checksText(page)).not.toMatch(/pitch/i);
  expect(errors).toEqual([]);
});

/* A link from before this, or one with nothing from the plate in it, is the grid it
   always was. One whose margins arrive mangled costs those margins and nothing else:
   the page treats a margin it cannot read as none, as the plate's own field does. And a
   bin already placed past the plate's edge is kept and named, the way shrinking the
   drawer keeps one, rather than silently dropped. */
test('older and broken links keep working', async ({ page }) => {
  const errors = watch(page);
  await page.goto(site.base + 'bins/#w=306&d=380');
  await binsReady(page);
  expect(await page.evaluate(() => [grid().nx, grid().ny]), 'no plate keys').toEqual([7, 9]);

  await page.goto(site.base + 'bins/#w=306&d=380&mm=custom&ml=abc&mr=-40&mf=%E0%A4&mb=1e400');
  await binsReady(page);
  expect(await page.evaluate(() => [grid().nx, grid().ny]), 'unreadable margins').toEqual([7, 9]);

  // a 1 x 1 bin in the seventh column, then the plate's margins take that column away
  await page.goto(site.base + 'bins/#w=306&d=380');
  await binsReady(page);
  await H.dragCells(page, [6, 0], [6, 0]);
  const bl = await page.evaluate(() => packLayers(layers));
  await page.goto('about:blank');
  await page.goto(site.base + 'bins/#w=306&d=380&mm=custom&ml=20&mr=20&bl=' + encodeURIComponent(bl));
  await binsReady(page);
  expect(await page.evaluate(() => B().map((b) => [b.x, b.y])), 'the bin is kept').toEqual([[6, 0]]);
  expect(await checksText(page)).toMatch(/outside the drawer grid/);
  expect(errors).toEqual([]);
});
