/* The two tools on a phone held upright: the bin's settings as a sheet over the map, the
 * section bar, and the baseplates panels folded below the first.
 *
 * Measured at 390 × 844 in the October 2026 review: tapping a bin opened about 1,500 px
 * of settings ABOVE the map, so every edit was a scroll up to make it and a scroll down to
 * see it, and the baseplates cut map started 2.4 screens below the drawer size. Bins are
 * placed here with a finger, through the same touch plumbing a phone uses, because touch
 * placement is the thing the sheet must not get in the way of.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/* One finger from the centre of one cell to the centre of another. Playwright's own
   touchscreen only taps, so the drag goes through CDP (see touch.spec.js). */
async function fingerDrag(page, from, to) {
  const a = await H.cellPoint(page, from[0], from[1]);
  const b = await H.cellPoint(page, to[0], to[1]);
  await fingerPath(page, a, b);
  return a;
}
async function fingerPath(page, a, b) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (p) => [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a) });
  for (let i = 1; i <= 6; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: pt({ x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 }) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(350);   // the sheet slides up in 160 ms
}
/* Where a cell is on screen as things stand, without scrolling the map into view first
   the way H.cellPoint does: with the sheet up, where the page has been left matters. */
const cellNow = (page, gx, gy) => page.evaluate(({ gx, gy, CELL }) => {
  const svg = document.getElementById('fillmap');
  const ny = svg.getAttribute('viewBox').split(' ').map(Number)[3] / CELL;
  const p = svg.createSVGPoint();
  p.x = (gx + 0.5) * CELL; p.y = (ny - 1 - gy + 0.5) * CELL;
  const q = p.matrixTransform(svg.getScreenCTM());
  return { x: q.x, y: q.y };
}, { gx, gy, CELL: H.CELL });

const sheet = (page) => page.evaluate((CELL) => {
  const s = document.getElementById('s-bin');
  const r = s.getBoundingClientRect();
  const svg = document.getElementById('fillmap');
  const sel = selected >= 0 ? B()[selected] : null;
  let bin = null;
  if (sel) {
    const ny = svg.getAttribute('viewBox').split(' ').map(Number)[3] / CELL;
    const m = svg.getScreenCTM(), p = svg.createSVGPoint();
    p.x = 0; p.y = (ny - sel.y - sel.v) * CELL; const top = p.matrixTransform(m).y;
    p.y = (ny - sel.y) * CELL; const bottom = p.matrixTransform(m).y;
    bin = { top, bottom };
  }
  return { vh: innerHeight, position: getComputedStyle(s).position, top: r.top,
           bottom: r.bottom, open: !s.classList.contains('closed'), bin,
           bar: document.getElementById('jumpbar').getBoundingClientRect().bottom,
           cls: document.body.classList.contains('binsheet') };
}, H.CELL);

test.describe('bins', () => {
  test.beforeEach(async ({ page }) => {
    await H.forgetSaved(page);
    page.__errors = await H.openBins(page);
  });
  test.afterEach(async ({ page }) => {
    expect(page.__errors, 'the page threw while being driven').toEqual([]);
  });

  test('a bin placed with a finger opens its settings as a sheet over the map, not above it',
    async ({ page }) => {
      await fingerDrag(page, [1, 1], [2, 2]);
      const placed = await H.bins(page);
      expect(placed.length, 'a finger drag still places a bin').toBe(1);
      expect([placed[0].u, placed[0].v]).toEqual([2, 2]);

      const s = await sheet(page);
      expect(s.position).toBe('fixed');
      expect(s.bottom).toBeCloseTo(s.vh, 0);
      expect(s.top, 'the sheet leaves the top half of the screen to the map')
        .toBeGreaterThanOrEqual(s.vh * 0.45);
      // the bin you just placed is in view above it, and not under the section bar
      expect(s.bin.bottom).toBeLessThanOrEqual(s.top);
      expect(s.bin.top).toBeGreaterThanOrEqual(s.bar - 1);

      /* Size, height and dividers first: on screen in the sheet without scrolling it, and
         first in the document too, so Tab takes them in the order they are shown. */
      for (const id of ['u', 'v', 'hUnits', 'divX', 'divY']) {
        const r = await page.locator('#' + id).boundingBox();
        expect(r.y, `#${id} is in the sheet`).toBeGreaterThanOrEqual(s.top);
        expect(r.y + r.height, `#${id} is in view without scrolling the sheet`)
          .toBeLessThanOrEqual(s.vh);
      }
      const order = await page.evaluate(() => ['u', 'hUnits', 'divX', 'note', 'wall']
        .map((id) => document.getElementById(id))
        .every((e, i, a) => !i || (a[i - 1].compareDocumentPosition(e) & 4)));
      expect(order, 'width, height, dividers, then the rest').toBe(true);

      const x = await page.locator('#binSheetClose').boundingBox();
      expect(x.height, 'a way out a finger can hit').toBeGreaterThanOrEqual(40);
      await expect(page.locator('#binSheetClose')).toBeVisible();
    });

  test('the map above the sheet still takes a finger, and the sheet edits what it selects',
    async ({ page }) => {
      await fingerDrag(page, [0, 0], [1, 1]);
      expect((await sheet(page)).cls).toBe(true);

      // a second bin, drawn on the part of the map the sheet leaves showing
      const s = await sheet(page);
      const a = await cellNow(page, 4, 5), b = await cellNow(page, 5, 5);
      expect(a.y, 'fixture: these cells are above the sheet').toBeLessThan(s.top);
      expect(a.y, 'and below the section bar').toBeGreaterThan(s.bar);
      await fingerPath(page, a, b);
      const after = await H.bins(page);
      expect(after.length).toBe(2);
      expect(await page.evaluate(() => [selected, B()[selected].x, B()[selected].y]))
        .toEqual([1, 4, 5]);
      expect([after[1].u, after[1].v], 'two cells across, and one deep: no further').toEqual([2, 1]);
      expect((await sheet(page)).cls, 'still a sheet, now for the new bin').toBe(true);
      await expect(page.locator('#u')).toHaveValue('2');
      await expect(page.locator('#v')).toHaveValue('1');

      // and what is typed into the sheet goes to the bin on the map
      await H.setField(page, 'hUnits', 6);
      expect(await page.evaluate(() => B()[1].hUnits)).toBe(6);
      expect(await page.evaluate(() => B()[0].hUnits), 'and only to it').toBe(3);
    });

  /* Drawn up or down the map, the drag above crosses rows, and a row is where it went
     wrong: pressing on an empty cell lets go of the selection, which put the sheet away,
     and panel 03 dropping back into the column above the map moved the map 58 px down
     under a finger that was still on it. A drag from row 3 to row 5 made a bin four rows
     deep at 390 × 844, and five at 320 × 568, where the cells are smaller. Sideways, the
     rows the finger crossed were all one row and it never showed. */
  for (const vp of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    test.describe(`at ${vp.width} × ${vp.height}`, () => {
      test.use({ viewport: vp });

      test('a bin drawn down the map above the sheet covers the cells the finger crossed',
        async ({ page }) => {
          await fingerDrag(page, [1, 1], [2, 2]);
          const s = await sheet(page);
          expect(s.cls).toBe(true);
          const a = await cellNow(page, 4, 3), b = await cellNow(page, 4, 5);
          expect(a.y, 'fixture: the cells are above the sheet').toBeLessThan(s.top);
          expect(b.y, 'and below the section bar').toBeGreaterThan(s.bar);
          await fingerPath(page, a, b);
          const placed = await H.bins(page);
          expect(placed.length).toBe(2);
          expect([placed[1].x, placed[1].y, placed[1].u, placed[1].v],
            'rows 3 to 5, one cell across').toEqual([4, 3, 1, 3]);
          expect((await sheet(page)).cls, 'the sheet stays up, for the new bin').toBe(true);
          await expect(page.locator('#v')).toHaveValue('3');
          // and the map is where it was when the finger came down, now the drag is over
          expect((await cellNow(page, 4, 3)).y).toBeCloseTo(a.y, 0);
        });

      /* A drag that ends over a bin places nothing, and with nothing selected the sheet
         goes, as the X puts it away: the panel goes back into the column above the map,
         and the map is held where it was rather than moved down by the panel's header. */
      test('a drag that places nothing puts the sheet away without moving the map',
        async ({ page }) => {
          await fingerDrag(page, [1, 1], [2, 2]);
          const a = await cellNow(page, 3, 1), b = await cellNow(page, 2, 1);
          expect(a.y, 'fixture: the cells are above the sheet').toBeLessThan((await sheet(page)).top);
          await fingerPath(page, a, b);
          expect((await H.bins(page)).length, 'fixture: the drag ended over the bin').toBe(1);
          const s = await sheet(page);
          expect(s.cls).toBe(false);
          expect(s.position).toBe('static');
          expect((await cellNow(page, 3, 1)).y).toBeCloseTo(a.y, 0);
        });
    });
  }

  test('the X lets go of the bin and puts the sheet away, folded back into the page',
    async ({ page }) => {
      await fingerDrag(page, [1, 1], [2, 2]);
      const was = await cellNow(page, 1, 1);
      await page.locator('#binSheetClose').tap();
      await page.waitForTimeout(200);
      const s = await sheet(page);
      expect(await page.evaluate(() => selected)).toBe(-1);
      // the bin you were looking at is where it was, not 58 px further down
      expect((await cellNow(page, 1, 1)).y).toBeCloseTo(was.y, 0);
      expect(s.cls).toBe(false);
      expect(s.position).toBe('static');
      expect(s.open, 'back in the column, folded as the page first showed it').toBe(false);
      await expect(page.locator('#s-bin>h2>button')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#binSheetClose')).toBeHidden();
      expect((await H.bins(page)).length, 'nothing is deleted by closing').toBe(1);

      // and the next bin selected brings it straight back
      const p = await cellNow(page, 1, 1);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForTimeout(350);
      expect((await sheet(page)).position).toBe('fixed');
      expect((await sheet(page)).open).toBe(true);

      // Escape puts it away too, for a keyboard on a narrow window
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      expect((await sheet(page)).cls).toBe(false);
    });

  test('single-bin mode takes the panel back from the sheet, and leaving it gives it back',
    async ({ page }) => {
      await fingerDrag(page, [1, 1], [2, 2]);
      await page.locator('#focusBin').tap();
      await page.waitForTimeout(300);
      let s = await sheet(page);
      expect(await page.evaluate(() => document.body.classList.contains('binfocus'))).toBe(true);
      expect(s.cls).toBe(false);
      expect(s.position).toBe('static');
      expect(s.open, 'the mode is about this panel, so it stays open').toBe(true);

      await page.locator('#focusExit').tap();
      await page.waitForTimeout(400);
      s = await sheet(page);
      expect(s.position).toBe('fixed');
      expect(s.bin.bottom).toBeLessThanOrEqual(s.top);
    });
});

/* ---- the section bar --------------------------------------------------------- */

for (const tool of [{ name: 'baseplates', open: H.openPlates },
                    { name: 'bins', open: H.openBins }]) {
  test(`${tool.name}: the section bar jumps by scrolling and moving focus, and leaves the address alone`,
    async ({ page }) => {
      await H.forgetSaved(page);
      const errors = await tool.open(page);
      /* The page writes its own layout into the address a moment after it opens; wait for
         that, so what is compared below is the bar's doing and nothing else's. */
      await page.waitForFunction(() => location.hash.length > 3);
      await page.waitForTimeout(600);
      const hash = await page.evaluate(() => location.hash);
      await page.evaluate(() => {
        window.__hashchanges = 0;
        addEventListener('hashchange', () => { window.__hashchanges++; });
      });
      let navigations = 0;
      page.on('framenavigated', () => { navigations++; });

      const bar = page.locator('#jumpbar');
      const barTop = async () => (await bar.boundingBox()).y;
      /* While the header is on screen the bar is up out of sight and takes no room: the
         first screen is the same as it was without one. */
      expect(await page.evaluate(() => scrollY)).toBe(0);
      expect((await bar.boundingBox()).y + (await bar.boundingBox()).height).toBeLessThanOrEqual(0);
      // a long way down, it has come down and stays at the top
      await page.evaluate(() => scrollTo(0, 3000));
      await expect.poll(barTop).toBeCloseTo(0, 0);

      for (const label of ['Map', 'Preview', 'Export', 'Settings']) {
        const b = bar.getByRole('button', { name: label, exact: true });
        await expect.poll(barTop, `the bar is down before ${label} is tapped`).toBeCloseTo(0, 0);
        const r = await b.boundingBox();
        expect(r.height, `${label} is a finger-sized target`).toBeGreaterThanOrEqual(40);
        await b.tap();
        await page.waitForTimeout(150);
        const m = await page.evaluate((ids) => {
          const t = ids.split(' ').map((id) => document.getElementById(id))
            .find((el) => el && el.getClientRects().length);
          const a = document.activeElement;
          return { id: t.id, top: t.getBoundingClientRect().top, vh: innerHeight,
                   bar: document.getElementById('jumpbar').getBoundingClientRect().bottom,
                   focused: a === t || a === t.querySelector(':scope>h2>button') };
        }, await b.getAttribute('data-jump'));
        expect(m.top, `${label} lands ${m.id} clear of the bar`).toBeGreaterThanOrEqual(m.bar - 1);
        expect(m.top, `and on the screen`).toBeLessThan(m.vh / 2);
        expect(m.focused, `${label} moves focus to ${m.id}`).toBe(true);
      }
      expect(await page.evaluate(() => location.hash), 'the layout in the address is untouched')
        .toBe(hash);
      expect(await page.evaluate(() => window.__hashchanges)).toBe(0);
      expect(navigations, 'and the page did not navigate').toBe(0);
      expect(errors).toEqual([]);
    });

  test(`${tool.name}: the section bar is in the Tab order even while it is up, and comes down for focus`,
    async ({ page }) => {
      await H.forgetSaved(page);
      const errors = await tool.open(page);
      const bar = page.locator('#jumpbar');
      expect(await page.evaluate(() => scrollY)).toBe(0);
      // Tab from the header's last control: the next stop is the bar's first button
      await page.locator('header').evaluate((h) => {
        const all = [...h.querySelectorAll('a[href],button,input,select')]
          .filter((e) => e.getClientRects().length);
        all[all.length - 1].focus();
      });
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement.closest('#jumpbar') !== null),
        'Tab reaches the bar').toBe(true);
      await expect.poll(async () => (await bar.boundingBox()).y, 'and it comes down to be seen')
        .toBeCloseTo(0, 0);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.activeElement.closest('#jumpbar')),
        'Enter on it jumps, and focus leaves the bar').toBe(null);
      expect(errors).toEqual([]);
    });
}

/* ---- baseplates: the panels after the first ----------------------------------- */

test('baseplates opens with only the drawer panel open, from the first frame', async ({ page }) => {
  await page.addInitScript(() => {
    window.__open = [];
    const tick = () => {
      // what is drawn, not which class it has: a body laid out is a panel showing open
      const b = document.getElementById('b-printer');
      if (b) window.__open.push(b.getClientRects().length > 0);
      if (document.readyState !== 'complete') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const errors = await H.openPlates(page);
  const panels = await page.evaluate(() => [...document.querySelectorAll('section.p')].map((s) =>
    [s.id, !s.classList.contains('closed'), s.querySelector(':scope>h2>button').getAttribute('aria-expanded')]));
  expect(panels).toEqual([
    ['s-drawer', true, 'true'], ['s-printer', false, 'false'], ['s-split', false, 'false'],
    ['s-conn', false, 'false'], ['s-mag', false, 'false'], ['s-prof', false, 'false']]);
  const frames = await page.evaluate(() => window.__open);
  expect(frames.length, 'fixture: frames were drawn with the rail in them').toBeGreaterThan(0);
  expect(frames, 'no frame drew panel 02 open first').not.toContain(true);

  // folded, not gone: a tap opens one
  await page.locator('#s-printer>h2>button').tap();
  await expect(page.locator('#bedW')).toBeVisible();

  // and the cut map is now within reach of the first screen, not 2.4 screens down
  await page.locator('#s-printer>h2>button').tap();
  const top = await page.evaluate(() => document.getElementById('cutmap').getBoundingClientRect().top + scrollY);
  expect(top).toBeLessThan(844 * 1.8);
  expect(errors).toEqual([]);
});

/* ---- the desktop is not the phone ------------------------------------------------ */

test.describe('at 1440 × 1000 with a mouse', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false });

  test('bins: a selected bin is still panel 03 in the rail, and there is no bar', async ({ page }) => {
    await H.forgetSaved(page);
    const errors = await H.openBins(page);
    await H.dragCells(page, [1, 1], [2, 2]);
    const read = () => page.evaluate(() => {
      const s = document.getElementById('s-bin'), rail = document.querySelector('.rail');
      const r = s.getBoundingClientRect(), q = rail.getBoundingClientRect();
      const t = document.getElementById('thickRow');
      return { position: getComputedStyle(s).position, inRail: rail.contains(s),
               x: r.x, w: r.width, h: r.height, railX: q.x, railW: q.width,
               dividersAfterWalls: t.nextElementSibling === document.getElementById('divRow') };
    });
    const m = await read();
    expect(m.position).toBe('static');
    expect(m.inRail).toBe(true);
    expect(m.x).toBeGreaterThanOrEqual(m.railX);
    expect(m.x + m.w).toBeLessThanOrEqual(m.railX + m.railW);
    expect(m.dividersAfterWalls, 'the panel keeps its desktop order').toBe(true);
    await expect(page.locator('#jumpbar')).toBeHidden();
    await expect(page.locator('#binSheetClose')).toBeHidden();

    /* The selection still sets the class at every width; the claim is that nothing on a
       desktop answers to it. Take it off and nothing moves. */
    expect(await page.evaluate(() => document.body.classList.contains('binsheet'))).toBe(true);
    await page.evaluate(() => document.body.classList.remove('binsheet'));
    expect(await read()).toEqual(m);
    expect(errors).toEqual([]);
  });

  test('baseplates: every panel that opened before still opens, and there is no bar',
    async ({ page }) => {
      const errors = await H.openPlates(page);
      const open = await page.evaluate(() => [...document.querySelectorAll('section.p')]
        .filter((s) => !s.classList.contains('closed')).map((s) => s.id));
      expect(open).toEqual(['s-drawer', 's-printer', 's-split', 's-conn', 's-mag']);
      await expect(page.locator('#jumpbar')).toBeHidden();
      expect(errors).toEqual([]);
    });

  /* A window that narrows to a phone's width and back: the dividers move up for the sheet
     and back to their desktop place, rather than staying wherever the narrow window put
     them. */
  test('bins: the dividers follow the window between the two orders', async ({ page }) => {
    await H.openBins(page);
    const after = () => page.evaluate(() =>
      document.getElementById('divRow').previousElementSibling.id);
    expect(await after()).toBe('thickRow');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    expect(await after()).toBe('binSizeHint');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(150);
    expect(await after()).toBe('thickRow');
  });
});
