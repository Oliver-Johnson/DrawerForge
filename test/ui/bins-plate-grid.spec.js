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
  for (const mm of ['auto', 'none', 'half']) {
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

/* Near enough to 42 is 42. A link from a plate at 42.001 mm, or 41.999, said "laid out
   on a 42 mm grid ... made to the standard's 42 mm", because the test was exact and the
   figure was rounded to two places. Within a hundredth of a millimetre the plate is the
   standard one, and any other pitch is named to the thousandth, so the figure given is
   never 42. A pitch too small to show in thousandths is not called a 0 mm grid. */
test('a pitch a hair off 42 is standard, and any other is named as itself', async ({ page }) => {
  const errors = watch(page);
  const at = async (pi) => {
    await page.goto('about:blank');
    await page.goto(site.base + 'bins/#w=306&d=380&pi=' + pi);
    await binsReady(page);
    return checksText(page);
  };
  for (const pi of ['42.001', '41.999', '42.01', '41.99', '42.0'])
    expect(await at(pi), pi).not.toMatch(/laid out on/);
  for (const [pi, shown] of [['42.011', '42.011 mm'], ['41.989', '41.989 mm'], ['42.5', '42.5 mm'],
                             ['50', '50 mm'], ['13.5', '13.5 mm']])
    expect(await at(pi), pi).toContain(`laid out on a ${shown} grid`);
  for (const pi of ['1e-7', '0.0004']) {
    const t = await at(pi);
    expect(t, pi).toContain('laid out on a non-standard grid');
    expect(t, pi).not.toMatch(/\b0 mm grid/);
  }
  expect(errors).toEqual([]);
});

/* The cell fields write a drawer, and a drawer stops at DRAWER_MAX. With the plate's
   margins added back, 47 cells in a 2000 mm drawer with 100 mm a side wrote a 2174 mm
   drawer, which the page then cut down and reported as an error nobody had made; a
   margin of 1e9 put 1000000210 in the width field. The margins never carry the written
   drawer past the cap, and the spinner stops at the cells a drawer at the cap holds.
   Cells that by themselves ask for more than the cap are told so, with or without
   margins, as bins-robustness.spec.js has them told without. */
test('the cell fields stop where the drawer does, margins and all', async ({ page }) => {
  const errors = watch(page);
  const maxes = () => page.evaluate(() => [$('gridX').max, $('gridY').max]);
  await page.goto(site.base + 'bins/#w=2000&d=380&mm=custom&ml=100&mr=100');
  await binsReady(page);
  // 1800 mm across is 42 cells; nothing comes off the depth, so 2000 mm of it is 47
  expect(await maxes()).toEqual(['42', '47']);
  await H.setField(page, 'gridX', 47);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => [state.drawerW, $('drawerW').value, grid().nx]))
    .toEqual([2000, '2000', 42]);
  expect(await checksText(page)).not.toMatch(/bigger than/);
  await H.setField(page, 'gridX', 40);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => [state.drawerW, grid().nx])).toEqual([40 * 42 + 200, 40]);
  // 500 cells is 21000 mm before any margin: past the cap on its own, and said so
  await H.setField(page, 'gridX', 500);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => [state.drawerW, $('drawerW').value, grid().nx]))
    .toEqual([2000, '21000', 42]);
  await expect(page.locator('#warnings')).toContainText('21000 × 380 mm drawer is bigger than the 2000 mm');

  // a margin no drawer has room for: one cell is all there is, and nothing runs away
  await page.goto('about:blank');
  await page.goto(site.base + 'bins/#w=306&d=380&mm=custom&ml=1e9');
  await binsReady(page);
  expect(await maxes()).toEqual(['1', '47']);
  await H.setField(page, 'gridX', 5);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => [state.drawerW, $('drawerW').value])).toEqual([2000, '2000']);
  expect(await checksText(page)).not.toMatch(/bigger than/);
  expect(errors).toEqual([]);
});

/* Margins that leave the drawer no room for a cell stop the Baseplates page building
   anything, and it says why. Bins drew its one cell regardless (grid() never draws
   fewer) and said nothing, so the design looked fine here and failed there. */
test('margins that leave no room for a cell are called out in Checks', async ({ page }) => {
  const errors = watch(page);
  await page.goto(site.base + 'bins/#w=306&d=380&mm=custom&ml=200&mr=100');
  await binsReady(page);
  await expect(page.locator('#warnings .w.err')
    .filter({ hasText: /left and right margins leave 6 mm of the drawer's width/ })).toHaveCount(1);
  expect(await checksText(page)).not.toMatch(/front and back margins/);

  await page.goto('about:blank');
  await page.goto(site.base + 'bins/#w=306&d=380&mm=custom&ml=1e9&mf=200&mb=200');
  await binsReady(page);
  const t = await checksText(page);
  expect(t).toMatch(/left and right margins take up the drawer's whole width/);
  expect(t).toMatch(/front and back margins take up the drawer's whole depth/);

  /* Exactly one cell's room is room for one; margins the plate does not keep (any mode
     but custom) take none; and a drawer too small for a cell without its margins is not
     the margins' doing. */
  for (const hash of ['w=306&d=380&mm=custom&ml=200&mr=64', 'w=306&d=380&mm=auto&ml=200&mr=100',
                      'w=30&d=380&mm=custom&ml=5']) {
    await page.goto('about:blank');
    await page.goto(site.base + 'bins/#' + hash);
    await binsReady(page);
    expect(await checksText(page), hash).not.toMatch(/margins (leave|take up)/);
  }
  expect(errors).toEqual([]);
});

/* "Show the drawer" draws the drawer around the plate, and it drew the plate in the
   middle of it whatever the plate's margins or alignment said. A plate with 20 mm on
   the left and 76 on the right was drawn with 48 on each side. The gaps between the
   plate and the drawer's inside walls are the plate's margins, as Baseplates lays them
   out; and when the margins leave no room at all, the plate is still drawn inside. */
test('the drawer is drawn where the plate sits in it', async ({ page }) => {
  const errors = watch(page);
  const gaps = async (hash) => {
    await page.goto('about:blank');
    await page.goto(site.base + 'bins/#' + hash);
    await binsReady(page);
    await page.evaluate(() => {
      const e = document.getElementById('showDrawer');
      e.checked = true;
      e.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    // world boxes: the shell's outer faces are DRAWER_T outside the drawer's inside
    return page.evaluate(() => {
      const d = new THREE.Box3().setFromObject(drawerGroup);
      const p = new THREE.Box3().setFromObject(plateMesh);
      const r = (v) => Math.round(v * 1000) / 1000;
      return { left: r(p.min.x - (d.min.x + DRAWER_T)), right: r(d.max.x - DRAWER_T - p.max.x),
               front: r(d.max.z - DRAWER_T - p.max.z), back: r(p.min.z - (d.min.z + DRAWER_T)) };
    });
  };
  // 306 less 20 and 60 is five cells, 210 mm, so the right margin is 76; 380 likewise
  expect(await gaps('w=306&d=380&mm=custom&ml=20&mr=60&mf=10&mb=50'))
    .toEqual({ left: 20, right: 76, front: 10, back: 76 });
  // no custom margins: where the alignment puts the leftover (gridCells in core.js)
  expect(await gaps('w=306&d=380&mm=auto&ax=end&ay=start'))
    .toEqual({ left: 0, right: 12, front: 2, back: 0 });
  expect(await gaps('w=306&d=380')).toEqual({ left: 6, right: 6, front: 1, back: 1 });
  /* Half cells: nine whole cells and a half column leave 1 mm, which the alignment puts
     on the left, and seven and a half row leave 15 at the front. The strips are on the
     right and the back, so those margins are the strips' 21 mm. */
  expect(await gaps('w=400&d=330&mm=half&ax=start&ay=start'))
    .toEqual({ left: 1, right: 21, front: 15, back: 21 });
  /* Margins with no room for a cell: the one cell is drawn against the wall, not through
     it. (Custom margins hand what the cells leave to the right and the back.) */
  expect(await gaps('w=306&d=380&mm=custom&ml=300'))
    .toEqual({ left: 264, right: 0, front: 0, back: 2 });
  expect(errors).toEqual([]);
});

/* The plate's height goes over in the link too, as `ph`: Bins takes it off the drawer's
   height for the room its bins have, and the guide passes it on. It was read off the
   first piece built. The page rebuilds 260 ms after a change, behind a debounce, so a
   link followed in that time carried the plate from before the change: tick Magnets and
   go straight to Bins, and Bins was told 4.25 mm about a 7.05 mm plate. With nothing
   built at all it was 4.25 mm and no floor, whatever floor the plate has.
   The height Bins should have is the one the plate builds at, so each test first builds
   the plate it is going to hand over and reads that off the piece. */
const PLATE = '#w=84&d=84';   // one small piece: quick to build
const pieceH = (page) => page.evaluate(() => builds[layout.pieces[0].id].meta.H);
const phOf = (url) => new URL(url).hash.match(/[#&]ph=([^&]*)/)[1];

test('a change still waiting to build goes to Bins and the guide at the plate\'s new height',
  async ({ page }) => {
    const errors = watch(page);
    await H.forgetSaved(page);
    await page.goto(site.base + PLATE + '&mg=1');
    await platesReady(page);
    const tall = await pieceH(page);
    for (const [link, at] of [['toBins', /\/bins\/#/], ['navGuide', /\/guide\/#/]]) {
      await page.goto('about:blank');
      await page.goto(site.base + PLATE);
      await platesReady(page);
      const low = await pieceH(page);
      expect(tall, 'fixture: magnets must make the plate taller').toBeGreaterThan(low + 1);
      // the tick and the click in one go, so the rebuild cannot land between them
      const [, before] = await Promise.all([page.waitForURL(at), page.evaluate((link) => {
        document.getElementById('magnets').click();
        const before = builds[layout.pieces[0].id].meta.H;
        document.getElementById(link).click();
        return before;
      }, link)]);
      expect(before, `${link}: fixture: followed with the plate before the tick still built`)
        .toBe(low);
      expect(phOf(page.url()), `${link}: the height handed over`).toBe(tall.toFixed(2));
      if (link === 'toBins') {
        await binsReady(page);
        expect(await page.evaluate(() => state.plateH), 'the plate Bins has').toBe(+tall.toFixed(2));
      }
    }
    expect(errors).toEqual([]);
  });

/* A plate the checks stop from building still has a height, and Bins still needs it:
   this one is too tall for the bed, which is a printing problem, not a reason to tell
   Bins its bins have 20 mm more room above the plate than they do. */
test('a plate the checks stop from building goes to Bins at its own height', async ({ page }) => {
  const errors = watch(page);
  await H.forgetSaved(page);
  await page.goto(site.base + PLATE + '&bp=20');
  await platesReady(page);
  const tall = await pieceH(page);
  await page.goto('about:blank');
  await page.goto(site.base + PLATE + '&bp=20&bh=20');
  await page.waitForFunction(
    () => /not building/.test(document.getElementById('pieceTail')?.textContent || ''));
  expect(await page.evaluate(() => Object.keys(builds).length), 'fixture: nothing built').toBe(0);
  await toBins(page);
  expect(phOf(page.url()), 'the height handed over').toBe(tall.toFixed(2));
  expect(await page.evaluate(() => state.plateH), 'the plate Bins has').toBe(+tall.toFixed(2));
  expect(errors).toEqual([]);
});
