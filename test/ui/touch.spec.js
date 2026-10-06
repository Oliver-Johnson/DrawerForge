/* Touch gestures in the preview.
 *
 * The expanded preview takes touch-action off the canvas so a drag rotates instead of
 * scrolling the page. That left no way to zoom at all on a phone: no wheel, no shift
 * key. These drive real touch points through CDP rather than synthesising events, so
 * they exercise the same pointer plumbing a finger does.
 */
'use strict';
const { test, expect, devices } = require('@playwright/test');
const H = require('./helpers.js');

test.use({ ...devices['Pixel 5'] });

/* Playwright's touchscreen API is single-point, so a pinch needs raw CDP. */
async function pinch(page, cx, cy, from, to, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const pair = (d) => [
    { x: cx - d / 2, y: cy, id: 1, radiusX: 6, radiusY: 6, force: 1 },
    { x: cx + d / 2, y: cy, id: 2, radiusX: 6, radiusY: 6, force: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pair(from) });
  for (let i = 1; i <= steps; i++) {
    const d = from + (to - from) * (i / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pair(d) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const camera = (page, which) => page.evaluate((w) =>
  (w === 'bins' ? dist : sph.r), which);

for (const [name, url, which] of [['bins', H.BINS_URL, 'bins'],
                                  ['baseplates', H.PLATES_URL, 'plates']]) {
  test(`${name}: pinching the preview zooms it`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => typeof THREE !== 'undefined');
    await page.waitForTimeout(600);

    await page.locator('.previewbtn').click();          // full screen, touch-action off
    await page.waitForTimeout(400);

    const box = await page.locator('#threewrap').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

    const start = await camera(page, which);
    await pinch(page, cx, cy, 80, 320);                 // fingers apart = zoom in
    await page.waitForTimeout(200);
    const closer = await camera(page, which);
    expect(closer, 'spreading two fingers should move the camera in').toBeLessThan(start);

    await pinch(page, cx, cy, 320, 80);                 // fingers together = zoom out
    await page.waitForTimeout(200);
    const further = await camera(page, which);
    expect(further, 'pinching in should move the camera back out').toBeGreaterThan(closer);

    expect(errors).toEqual([]);
  });

  test(`${name}: one finger still rotates, and lifting one of two does not jump`, async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => typeof THREE !== 'undefined');
    await page.waitForTimeout(600);
    await page.locator('.previewbtn').click();
    await page.waitForTimeout(400);

    const box = await page.locator('#threewrap').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const angle = () => page.evaluate((w) => (w === 'bins' ? theta : sph.theta), which);

    const before = await angle();
    await page.touchscreen.tap(cx, cy);                 // a tap must not spin it
    await page.waitForTimeout(150);
    expect(await angle()).toBeCloseTo(before, 6);

    const cdp = await page.context().newCDPSession(page);
    const pt = (x, id) => ({ x, y: cy, id, radiusX: 6, radiusY: 6, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(cx - 60, 1)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(cx - 20, 1)] });
    await page.waitForTimeout(100);
    const rotated = await angle();
    expect(rotated, 'one finger should rotate').not.toBeCloseTo(before, 4);

    /* Put a second finger down, then lift it. The remaining finger's anchor has to be
       re-seated or the model snaps by the gap between them. */
    await cdp.send('Input.dispatchTouchEvent',
      { type: 'touchStart', touchPoints: [pt(cx - 20, 1), pt(cx + 120, 2)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [pt(cx - 20, 1)] });
    const held = await angle();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(cx - 18, 1)] });
    await page.waitForTimeout(100);
    const after = await angle();
    expect(Math.abs(after - held), 'lifting one of two fingers must not jump the model')
      .toBeLessThan(0.1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  });
}

test('hints name gestures the device actually has', async ({ page }) => {
  await page.goto(H.BINS_URL);
  await page.waitForTimeout(400);
  // no wheel and no shift key on a phone, so the hint must not promise them
  await expect(page.locator('#threehint')).toHaveText(/pinch/);
  await expect(page.locator('#threehint')).not.toHaveText(/wheel|shift/);
  /* The map's help opens on its first sentence and keeps the rest behind "more", which is
     where the gestures are, so it is opened the way a reader opens it. */
  const mapHint = page.locator('.hint').filter({ hasText: 'Drag across empty cells' });
  await mapHint.locator('button.more').tap();
  // keyboard shortcuts are unreachable without a keyboard
  expect(await page.locator('.haskeys').first().isVisible()).toBe(false);
  expect(await page.locator('.hastouch').first().isVisible()).toBe(true);
  /* Nor is Alt. The map's help taught carving as Alt-click and nothing else, so the one
     sentence about making an L or a U described something a phone cannot do. innerText,
     because the hidden half of the hint is still in textContent. */
  const hint = await mapHint.innerText();
  expect(hint).not.toMatch(/alt-click/i);
  expect(hint, 'the touch route to carving is the Carve button').toContain('Carve this bin into a shape');
});

/* And the other way round: with a mouse and a keyboard, the shortcut is the quicker
   route, and the hint should still offer it rather than the touch wording. */
test.describe('with a mouse', () => {
  // the context options only: a device preset also names a browser, which a describe
  // block is not allowed to switch
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1440, height: 1000 } });
  test('the map hint offers Alt-click, not the touch wording', async ({ page }) => {
    await page.goto(H.BINS_URL);
    await page.waitForTimeout(400);
    const mapHint = page.locator('.hint').filter({ hasText: 'Drag across empty cells' });
    await mapHint.locator('button.more').click();
    const hint = await mapHint.innerText();
    expect(hint).toMatch(/Alt-click/);
    expect(hint).not.toMatch(/\btap\b/);
  });
});
