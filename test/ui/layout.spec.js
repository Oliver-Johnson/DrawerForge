/* How the two tools use the screen they are given.
 *
 * Every case here came out of measuring the built pages at real viewport sizes, from a
 * 390 px phone to a 3440 px ultrawide, rather than out of reading the stylesheet: the
 * numbers that were wrong were all ones the CSS and the sizing code agreed on and the
 * screen did not. So these assert against rendered boxes — getBoundingClientRect and
 * getScreenCTM — and never against the rules that are supposed to produce them.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

/* On-screen size of one map cell. The map is an SVG with a viewBox and
   preserveAspectRatio, so its CSS box is not the drawing: getScreenCTM is the only
   mapping that includes any letterboxing (see helpers.js). */
const cellPx = (page) => page.evaluate((CELL) =>
  document.getElementById('fillmap').getScreenCTM().a * CELL, H.CELL);

/* ---- 1. the bins map on one column -------------------------------------- */

/* drawMap took the preview's 320 px column out of the map's width even when the
   stylesheet had already stacked the preview underneath, so on a phone the default
   drawer was a 180 px map of 26 px cells — under the 40 px the rest of the phone
   layout treats as the smallest thing a finger can hit — in a card with room for 45. */
for (const [w, h] of [[390, 844], [1024, 768]]) {
  test(`the bins map uses the whole stage when it is one column, at ${w}×${h}`,
    async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await H.forgetSaved(page);
      const errors = await H.openBins(page);

      // fixture: the default drawer, and a layout that really is one column here
      expect(await page.evaluate(() => [grid().nx, grid().ny])).toEqual([7, 9]);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stagetop'))
        .gridTemplateColumns.trim().split(/\s+/).length)).toBe(1);

      expect(await cellPx(page), 'cells a finger can hit').toBeGreaterThanOrEqual(40);

      /* And it is the size it says it is. The width used to over-count the card's
         chrome, which the max-width:100% clamp then hid by letterboxing the grid inside
         a box taller than the drawing — a dead band above and below the cells, which is
         where the pointer offsets in helpers.js came from. */
      const fit = await page.evaluate(() => {
        const svg = document.getElementById('fillmap');
        const wrap = document.getElementById('fillwrap');
        const cs = getComputedStyle(wrap);
        return { drawn: svg.getBoundingClientRect().width,
                 asked: Number(svg.getAttribute('width')),
                 room: wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
      });
      expect(fit.drawn).toBeCloseTo(fit.asked, 0);
      expect(fit.asked).toBeLessThanOrEqual(fit.room + 0.5);
      expect(errors).toEqual([]);
    });
}

/* ---- 2. one window, not three scrollbars --------------------------------- */

/* .app, the rail and the stage were all sized `calc(100vh - 96px)`, and 96 px was
   nobody's header: Baseplates' is 164 and Bins' 207. At 1920×1080 the page scrolled
   70–110 px beyond the footer while the rail and the stage scrolled inside it, so the
   bottom of the working area was always just off the screen. */
const appBox = (page) => page.evaluate(() => {
  window.scrollTo(0, 0);
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  const se = document.scrollingElement;
  return { vh: innerHeight, app: r('.app').bottom, rail: r('.rail').bottom,
           stage: r('.stage').bottom, footer: r('footer').height,
           pageScroll: se.scrollHeight - innerHeight };
});

for (const tool of [{ name: 'baseplates', open: H.openPlates },
                    { name: 'bins', open: H.openBins }]) {
  test(`${tool.name}: the work area ends at the bottom of a 1920×1080 window`,
    async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await H.forgetSaved(page);
      const errors = await tool.open(page);

      const m = await appBox(page);
      expect(Math.abs(m.app - m.vh), 'the bottom of .app is the bottom of the window')
        .toBeLessThanOrEqual(1);
      // both columns run the full height, so each is the one scroller for its side
      expect(Math.abs(m.rail - m.vh)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.stage - m.vh)).toBeLessThanOrEqual(1);
      // and the page itself scrolls only as far as the footer underneath, no further
      expect(Math.abs(m.pageScroll - m.footer)).toBeLessThanOrEqual(1);

      /* The point of not using a number: the header changes height and nothing has to
         be told. The banner is the case that varies from one visit to the next. */
      await page.evaluate(() => { document.getElementById('restored').style.display = ''; });
      const banner = await page.locator('#restored').boundingBox();
      expect(banner.height, 'fixture: the banner really is taking room').toBeGreaterThan(20);
      const withBanner = await appBox(page);
      expect(Math.abs(withBanner.app - withBanner.vh)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    });
}

/* Focus mode changes both ends at once: the header loses its quickstart row and .app
   gains the focus bar across the top. The bar takes the first row of .app; if it were
   left to auto-placement against unplaced columns it would push the rail and stage
   into an unsized row that overflows the window instead of scrolling inside it. */
test('bins: in single-bin mode the bar sits on top and the columns still end at the bottom',
  async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await H.forgetSaved(page);
    const errors = await H.openBins(page);
    await page.locator('#scratchBinTop').click();
    await page.waitForTimeout(400);
    await expect(page.locator('#focusbar')).toBeVisible();

    const m = await appBox(page);
    const bar = await page.locator('#focusbar').boundingBox();
    const stageTop = await page.locator('.stage').boundingBox();
    expect(stageTop.y, 'the bar is above the columns, not beside or below them')
      .toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    for (const k of ['app', 'rail', 'stage'])
      expect(Math.abs(m[k] - m.vh), `${k} ends at the bottom of the window`)
        .toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

/* ---- 3. the cut map and the preview side by side ------------------------- */

/* openPlates without the hash: a drawer given in the link, settled and built. */
async function openPlatesAt(page, hash) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(H.PLATES_URL + hash);
  await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
    null, { timeout: 20000 });
  return errors;
}
const stageTop = (page) => page.evaluate(() => {
  const t = document.querySelector('.stagetop');
  return { tracks: getComputedStyle(t).gridTemplateColumns.trim().split(/\s+/).length,
           inline: t.style.gridTemplateColumns, paired: t.classList.contains('paired') };
});
const boxes = (page) => page.evaluate(() => {
  const r = (s) => { const b = document.querySelector(s).getBoundingClientRect();
                     return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
  const st = document.querySelector('.stage');
  return { vh: innerHeight, map: r(document.getElementById('cutmap') ? '#cutmap' : '#fillmap'),
           three: r('#threewrap'),
           card: document.getElementById('threewrap').parentElement.getBoundingClientRect().height,
           stage: r('.stage'), stageH: st.clientHeight };
});

/* The preview sat under the cut map at a fixed 380 px, starting at y≈750 in a 768 px
   window — so at the most common laptop sizes, changing a setting changed nothing on
   the screen. It now shares the bins page's .stagetop row. */
test.describe('baseplates at 1366×768', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('the preview sits beside the cut map, all of it on screen without scrolling',
    async ({ page }) => {
      await H.forgetSaved(page);
      const errors = await H.openPlates(page);
      expect(await stageTop(page)).toMatchObject({ tracks: 2, paired: true });
      const b = await boxes(page);
      expect(b.three.x, 'beside the map, not under it').toBeGreaterThanOrEqual(b.map.right);
      expect(b.three.y).toBeGreaterThanOrEqual(b.stage.y);
      expect(b.three.bottom, 'the whole preview is in the window').toBeLessThanOrEqual(b.vh);
      expect(b.three.h).toBeGreaterThanOrEqual(400);

      /* The same trap the bins map fell into: the paired columns are an inline style,
         which beats the media query that stacks the row. Narrowing the window has to
         take them away again, or the preview hangs off the side at 320 px. */
      await page.setViewportSize({ width: 1100, height: 768 });
      await page.waitForTimeout(300);
      expect(await stageTop(page)).toEqual({ tracks: 1, inline: '', paired: false });
      expect(errors).toEqual([]);
    });

  /* Halving a wide drawer's map to sit beside the preview would make the thing you
     click cut lines on smaller, so a wide drawer still takes the whole row — the rule
     the bins map uses for a wide grid. */
  test('a wide drawer keeps the whole row for its map, with the preview below',
    async ({ page }) => {
      const errors = await openPlatesAt(page, '#w=900&d=420');
      expect(await stageTop(page)).toMatchObject({ tracks: 1, paired: false });
      const b = await boxes(page);
      expect(b.three.y).toBeGreaterThan(b.map.bottom);
      expect(errors).toEqual([]);
    });
});

/* Beside the map, the map's column is sized from the map, so a map wider than the room
   it was given takes the difference out of the preview, and past the preview's minimum
   that pushes it off the side of the stage. The width was bounded as if the map's side
   margins came to 90 px when they come to 92, and the map comes out wider than its room
   whenever the drawer is drawn at under about a pixel per millimetre: a 1150 × 1000
   drawer at 1300 × 800 put the preview card 56 px past the stage, Fit and Expand with
   it, under a sideways scrollbar. 1150 × 1000 is also the widest shape of drawer that still sits
   beside the preview rather than above it (see drawMap). */
test.describe('baseplates at 1300×800', () => {
  test.use({ viewport: { width: 1300, height: 800 } });

  test('a big drawer beside the preview leaves all of the preview on the stage',
    async ({ page }) => {
      /* Not openPlatesAt: this is twenty pieces of CSG, and none of them moves the row.
         The map is sized as the page loads, so the layout is settled once it is drawn. */
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(H.PLATES_URL + '#w=1150&d=1000');
      await page.waitForFunction(() => !!document.querySelector('#cutmap rect'));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      expect(await stageTop(page), 'fixture: the map and the preview are side by side')
        .toMatchObject({ tracks: 2, paired: true });
      const m = await page.evaluate(() => {
        const st = document.querySelector('.stage');
        const right = st.getBoundingClientRect().left + st.clientLeft + st.clientWidth
                    - parseFloat(getComputedStyle(st).paddingRight);
        const ends = (sel) => Math.max(...[...document.querySelectorAll(sel)]
          .map((e) => e.getBoundingClientRect().right));
        return { right, card: ends('.stagetop > .stagecard'),
                 buttons: ends('#threewrap .fitbtn, #threewrap .previewbtn'),
                 sideways: st.scrollWidth - st.clientWidth };
      });
      expect(m.card, 'the preview card ends inside the stage').toBeLessThanOrEqual(m.right + 0.5);
      expect(m.buttons, 'Fit and Expand are on the stage').toBeLessThanOrEqual(m.right + 0.5);
      expect(m.sideways, 'and the stage has nothing to scroll sideways to').toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
});

/* Under the map, the preview's height is the stage you can see, so scrolling to it
   shows all of it — rather than 380 px whatever the window. Checked across two very
   different windows, because one size can match a fixed number by coincidence. */
for (const [w, h] of [[1280, 720], [1920, 1080]]) {
  test(`baseplates: a preview under the map fills the visible stage at ${w}×${h}`,
    async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      const errors = await openPlatesAt(page, '#w=900&d=420');
      expect(await stageTop(page)).toMatchObject({ tracks: 1 });
      const b = await boxes(page);
      expect(b.card, 'the preview card fits the stage you can see').toBeLessThanOrEqual(b.stageH);
      expect(b.card, 'and does not leave most of it empty').toBeGreaterThan(b.stageH - 100);
      expect(errors).toEqual([]);
    });
}

/* On a phone the window is the room, and a preview a whole screen tall is a whole
   screen of page to scroll past; it stays at the old floor there. */
test('stacked on a phone, the preview is a fixed, scroll-past size on both tools',
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await H.forgetSaved(page);
    for (const open of [H.openPlates, H.openBins]) {
      const errors = await open(page);
      const b = await boxes(page);
      expect(b.three.h).toBeCloseTo(420, 0);
      expect(errors).toEqual([]);
    }
  });

/* The stacked layout is one long page on purpose — the rail's panels and the stage
   are read top to bottom — and it has to stay that way: a phone-height window with
   its own inner scrollers would trap a finger in whichever one it landed on. */
test('stacked, the page scrolls as a whole and the stage is not a scroller of its own',
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await H.forgetSaved(page);
    const errors = await H.openBins(page);
    const m = await page.evaluate(() => {
      const st = document.querySelector('.stage');
      return { page: document.scrollingElement.scrollHeight - innerHeight,
               stage: st.scrollHeight - st.clientHeight };
    });
    expect(m.page).toBeGreaterThan(844);
    expect(m.stage).toBe(0);
    expect(errors).toEqual([]);
  });

/* ---- 4. a very wide screen ----------------------------------------------- */

/* Measured from 2560 to 5120 px, nothing on the stage grew except the things that
   should not have: the cut map stayed 391 × 454 and a bins cell 52 px, while the
   print plan's inputs stretched to ~1000 px each, the bins parts table across 3000 px
   and the preview into a 4678 × 380 strip. 3440 × 1440 is a common ultrawide. */
const wideScreen = (page) => page.evaluate(() => {
  const r = (e) => e.getBoundingClientRect();
  const map = document.getElementById('cutmap') || document.getElementById('fillmap');
  const three = r(document.getElementById('threewrap'));
  const plan = document.getElementById('platesRow') || document.getElementById('plateWrap');
  return {
    map: { w: r(map).width, h: r(map).height },
    three: { w: three.width, h: three.height, right: three.right, bottom: three.bottom },
    plan: r(plan.closest('.stagecard')),
    table: r(document.querySelector('table.pieces')).width,
    widest: Math.max(0, ...[...document.querySelectorAll(
      '.stage input:not([type=checkbox]), .stage select')].map((e) => r(e).width)),
  };
});

for (const tool of [{ name: 'baseplates', open: H.openPlates },
                    { name: 'bins', open: H.openBins }]) {
  test(`${tool.name}: a 3440×1440 screen gets a bigger map, a sane preview and no stretched form`,
    async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await H.forgetSaved(page);
      const errors = await tool.open(page);
      const small = await wideScreen(page);

      // both tools redraw their map on a window resize, so this is the same page grown
      await page.setViewportSize({ width: 3440, height: 1440 });
      await page.waitForTimeout(400);
      const big = await wideScreen(page);

      expect(big.map.w, 'the map grows with the screen').toBeGreaterThan(small.map.w * 1.15);
      expect(big.map.h).toBeGreaterThan(small.map.h * 1.15);
      expect(big.widest, 'no form control stretched across the stage').toBeLessThanOrEqual(480);
      expect(big.three.w / big.three.h, 'a preview, not a letterbox').toBeLessThanOrEqual(3);
      // the print plan comes up beside the preview, not a screen further down the stage
      expect(big.plan.x).toBeGreaterThanOrEqual(big.three.right);
      expect(big.plan.y).toBeLessThan(big.three.bottom);
      expect(big.table, 'the parts table at a readable width').toBeLessThanOrEqual(760);
      expect(errors).toEqual([]);
    });
}

/* The aspect ratio is the number that runs away as the window widens, so it is checked
   at 5120 too — and with a wide drawer, where the preview is alone under the map
   rather than beside it, which is the other way it can end up a strip. 2300 × 1000 is
   short of the side column and at the 1080-line map size, so beside the cut map the
   preview there is held in shape by its --pmin floor alone (2.5 with it, 2.94 without,
   and rising with every pixel wider). */
for (const [w, h] of [[2300, 1000], [3440, 1440], [5120, 1440]]) {
  test(`the preview keeps a sane shape at ${w}×${h}, beside a map or under a wide one`,
    async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await H.forgetSaved(page);
      for (const hash of ['', '#w=900&d=420']) {
        await page.goto('about:blank');
        const errors = await openPlatesAt(page, hash);
        const s = await wideScreen(page);
        expect(s.three.w / s.three.h, `baseplates, drawer ${hash || 'default'}`)
          .toBeLessThanOrEqual(3);
        expect(errors).toEqual([]);
      }
      const errors = await H.openBins(page);
      const s = await wideScreen(page);
      expect(s.three.w / s.three.h, 'bins').toBeLessThanOrEqual(3);
      expect(errors).toEqual([]);
    });
}
