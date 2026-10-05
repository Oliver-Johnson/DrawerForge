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
