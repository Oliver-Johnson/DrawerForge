/* Long hints, shortened to their first sentence with the rest behind "more".
 *
 * Several hints ran to six or eight lines, so the settings rail was a long read before
 * its controls and a phone's map sat further down for it. The rest of each one is still
 * in the hint — the build's audits and other specs read it there — so these check the
 * disclosure works as a control, keeps the words where they were, and survives the hints
 * the page rewrites or switches after load.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const TOOLS = [{ name: 'baseplates', open: H.openPlates }, { name: 'bins', open: H.openBins }];

const openAll = (page) => page.evaluate(() =>
  document.querySelectorAll('section.p.closed').forEach((s) => s.classList.remove('closed')));

for (const tool of TOOLS) {
  /* A regression guard as much as a check: a long hint added without "more" fails here.
     Four lines of 12.5 px text at the hint's leading is 78 px; the two that hold controls
     of their own are measured without them. */
  test(`${tool.name}: no hint in the rail runs past four lines until it is opened`,
    async ({ page }) => {
      const errors = await tool.open(page);
      await openAll(page);
      const long = await page.evaluate(() => {
        const out = [];
        for (const h of document.querySelectorAll('.rail .hint')) {
          if (!h.getClientRects().length) continue;
          const lh = parseFloat(getComputedStyle(h).lineHeight);
          let height = h.getBoundingClientRect().height;
          for (const row of h.querySelectorAll('.row')) height -= row.getBoundingClientRect().height + 6;
          if (height > 4 * lh + 1) out.push(`${h.id || h.textContent.slice(0, 50)}: ${Math.round(height / lh)} lines`);
        }
        return out;
      });
      expect(long).toEqual([]);
      expect(errors).toEqual([]);
    });

  test(`${tool.name}: "more" is a real button that opens the rest in place and shuts it again`,
    async ({ page }) => {
      const errors = await tool.open(page);
      await openAll(page);
      const buttons = page.locator('.hint button.more');
      expect(await buttons.count(), 'fixture: the page has long hints').toBeGreaterThan(3);

      const b = buttons.filter({ visible: true }).first();
      const hint = b.locator('xpath=..');
      const rest = b.locator('xpath=following-sibling::span[1]');
      await expect(b).toHaveAttribute('type', 'button');
      await expect(b).toHaveAttribute('aria-expanded', 'false');
      await expect(rest).toHaveClass(/moretext/);
      await expect(rest).toBeHidden();
      const before = await hint.textContent();

      await b.click();
      await expect(b).toHaveAttribute('aria-expanded', 'true');
      await expect(rest).toBeVisible();
      // in place: the rest is in the same hint, and it opens below the sentence it ends
      const s = await b.boundingBox(), r = await rest.boundingBox();
      expect(r.y).toBeGreaterThanOrEqual(s.y);
      expect(await hint.evaluate((h, el) => h.contains(el), await rest.elementHandle())).toBe(true);

      await b.click();
      await expect(b).toHaveAttribute('aria-expanded', 'false');
      await expect(rest).toBeHidden();
      // and the words are the same words, whichever way it was left (only the label moves)
      expect((await hint.textContent()).replace('less', 'more')).toBe(before);
      expect(errors).toEqual([]);
    });
}

/* The keyboard reaches it in reading order and opens it with either key. */
test('baseplates: Tab reaches "more" after the field it explains, and Enter and Space open it',
  async ({ page }) => {
    await H.openPlates(page);
    await page.locator('#infill').focus();
    await page.keyboard.press('Tab');
    const b = page.locator('.hint').filter({ hasText: 'Only affects the material estimate' })
      .locator('button.more');
    await expect(b).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(b).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(b).toHaveAttribute('aria-expanded', 'false');
  });

/* The words did not move: the rest of each shortened hint is still in its hint's text, so
   anything that reads a hint by its text still finds it. */
test('the rest of a shortened hint is still part of the hint', async ({ page }) => {
  await H.openPlates(page);
  const infill = page.locator('.hint').filter({ hasText: 'Only affects the material estimate' });
  await expect(infill).toContainText('It is the slab under a solid plate that the infill actually reaches');
  await H.openBins(page);
  const map = page.locator('.hint').filter({ hasText: 'Drag across empty cells' });
  await expect(map).toContainText('pull a corner grip to resize');
});

/* The plate style hint is written by the page, so it gets its "more" from DF.hint. It
   rewrites itself whenever the style changes, and it must neither lose the disclosure nor
   snap shut on someone who opened it. */
test('the plate style hint has the same "more", and keeps it open across a change of style',
  async ({ page }) => {
    const errors = await H.openPlates(page);
    const hint = page.locator('#plateStyleHint');
    const b = hint.locator('button.more');
    await expect(b).toHaveCount(1);
    await expect(b).toHaveAttribute('aria-expanded', 'false');
    // the gloss is in the sentence that stays in view
    expect(await hint.evaluate((h) => h.firstChild.nodeValue)).toMatch(/recess a bin's foot drops into/);
    await expect(hint.locator('.moretext')).toBeHidden();

    await b.click();
    await expect(hint.locator('.moretext')).toBeVisible();
    await expect(hint.locator('.moretext')).toContainText('The sturdy default');

    await H.setField(page, 'plateStyle', 'skeleton');
    await expect(b, 'the same button, still open').toHaveAttribute('aria-expanded', 'true');
    await expect(hint.locator('.moretext')).toBeVisible();
    await expect(hint.locator('.moretext')).toContainText('Cells carrying a joint stay solid');
    expect(await hint.textContent()).toMatch(/^Skeleton/);
    await expect(hint.locator('button.more')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

/* The joint hints are switched by the joint picked, with style.display on the hint itself.
   The disclosure lives inside it, so the switch and the disclosure must not interfere. */
test('a joint hint switched in by the joint picked has a working "more"', async ({ page }) => {
  const errors = await H.openPlates(page);
  await H.setField(page, 'connector', 'bowtie');
  const bow = page.locator('#connHintBow');
  await expect(bow).toBeVisible();
  await bow.locator('button.more').click();
  await expect(bow.locator('.moretext')).toBeVisible();
  await expect(bow).toContainText('the easiest to press home');

  await H.setField(page, 'connector', 'puzzlekey');
  await expect(bow).toBeHidden();
  const pkey = page.locator('#connHintPkey');
  await expect(pkey).toBeVisible();
  await expect(pkey.locator('.moretext')).toBeHidden();
  await pkey.locator('button.more').click();
  await expect(pkey.locator('.moretext')).toBeVisible();
  expect(errors).toEqual([]);
});
