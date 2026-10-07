/* Nothing above a map moves while a press on it is held.
 *
 * Following a link that set a layout of yours aside, both tools show a line above the
 * map, "This link replaced the layout you had here.", until the design is first changed:
 * the save that finds it changed takes the line away (saveNow). That save comes 400 ms
 * after the last change, and on the bins page a press that grabs a bin is one, so a drag
 * held that long met it half way: the save found the bin half moved, the line went, and
 * the map moved up 42 px under the pointer. The drag landed a row off: a 2 x 2 moved one
 * cell right came down at [4, 2] rather than [4, 3], and a grip pulled out one cell each
 * way made a 3 x 2 rather than a 3 x 3. On the baseplates page a cut is a click, and a
 * grid line pressed and held over the save was let go 42 px from the line, so the click
 * went nowhere. The save now waits for the press to be let go.
 *
 * Each case measures the map at the press and again just before the release, which is
 * the claim, as well as what the press did. The release is a pixel or two from where the
 * pointer was held, as a hand's is: let go exactly where it was held, the pointer asks
 * the map nothing more, and the map moving under it did no harm.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

// a 2 x 2 at [3, 3] and a 1 x 1 at [0, 6], as packBin writes them
const BINS_LINK = 'bl=3-3-2-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15_0-6-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-15';

/* The page at a link, through about:blank, with a layout of yours saved before it, so
   the link sets yours aside and says so above the map. The blank page's favicon line is
   the hop's, and the helpers' listener lets it go. */
async function arriveOverYours(page, open, yours, url) {
  // a case made again starts with nothing kept from the last try
  await page.evaluate(() => { try { localStorage.clear(); } catch (err) { /* about:blank */ } });
  page.__errors = await open(page);
  await yours();
  await page.waitForTimeout(600);                        // past the save's 400 ms
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await page.waitForTimeout(600);                        // and past the boot's own, no change
  await expect(page.locator('#setAside')).toBeVisible();
  await expect(page.locator('#setAsideMsg')).toHaveText('This link replaced the layout you had here.');
}
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

/* What the page was like at each press from now, read in the page as it happens, so that
   nothing the test does in between can let a save land first: whether the set-aside
   line was up, whether the design had been changed since the page opened (so a save
   waits that will take the line away), when the press came, when the drag first changed
   the design and when it was let go, and where the map's top was at the press. */
const watch = (page, map) => page.evaluate((map) => {
  const design = () => typeof descString === 'function' ? descString() : encodeDesc(descriptor());
  const log = window.__presses = [];
  addEventListener('pointerdown', () => {
    log.push({ lineUp: document.getElementById('setAside').style.display !== 'none',
               changed: bootDesc !== null && !sameDesign(design(), bootDesc),
               at: performance.now(), changedAt: null, upAt: null, was: design(),
               top: document.getElementById(map).getBoundingClientRect().top });
  }, true);
  // bubbling, so after the map's own handler has moved or resized the bin
  addEventListener('pointermove', () => {
    const p = log[log.length - 1];
    if (p && p.upAt === null && p.changedAt === null && !sameDesign(design(), p.was))
      p.changedAt = performance.now();
  });
  addEventListener('pointerup', () => { if (log.length) log[log.length - 1].upAt = performance.now(); }, true);
}, map);
/* Pressed at `from`, moved to `to` and held there past the save, then let go a pixel or
   two away. Gives every press watch() saw, and where the map was at the end of the hold. */
async function holdAndLet(page, map, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.waitForTimeout(700);                        // held past the save's 400 ms
  const held = await page.evaluate((map) => document.getElementById(map).getBoundingClientRect().top, map);
  await page.mouse.move(to.x + 2, to.y + 1);
  await page.mouse.up();
  await page.waitForTimeout(150);
  return { held, presses: await page.evaluate(() => window.__presses) };
}

const binsNow = (page) => page.evaluate(() => B().map((b) => [b.x, b.y, b.u, b.v]));

/* The press grabs the bin, which sets the save going, and the drag has moved it before
   the save comes, so the save finds the design changed. Made again should the drag have
   been slow to move it, which is not the case this is about. */
test('a bin dragged and held on a link that set yours aside lands where it was let go', async ({ page }) => {
  for (let tries = 1; ; tries++) {
    await arriveOverYours(page, H.openBins, () => H.clickCell(page, 0, 0), H.BINS_URL + '#' + BINS_LINK);
    const from = await H.cellPoint(page, 3, 3), to = await H.cellPoint(page, 4, 3);
    await watch(page, 'fillmap');
    const { held, presses: [p] } = await holdAndLet(page, 'fillmap', from, to);
    if (p.lineUp && p.changedAt !== null && p.changedAt - p.at < 380) {
      expect.soft(held, 'the map stayed where it was pressed').toBe(p.top);
      expect(await binsNow(page), 'one cell right').toEqual([[4, 3, 2, 2], [0, 6, 1, 1]]);
      // and the line goes once the bin is let go: the layout is a changed one now
      await expect(page.locator('#setAside')).toBeHidden();
      break;
    }
    expect(tries, 'the drag moved the bin while the press\'s save still waited').toBeLessThan(3);
  }
});

/* A grip is pressed a moment after the click that selected the bin, and has pulled the
   bin out inside the 400 ms that click set the save going for, so the save finds it
   resized. Made again should the save have come first all the same, which is the
   ordinary order and not the one this is about. */
test('a grip pulled and held a moment after selecting the bin makes the size it was let go at', async ({ page }) => {
  for (let tries = 1; ; tries++) {
    await arriveOverYours(page, H.openBins, () => H.clickCell(page, 0, 0), H.BINS_URL + '#' + BINS_LINK);
    const to = await H.cellPoint(page, 5, 5), bin = await H.cellPoint(page, 3, 3);
    await watch(page, 'fillmap');
    await page.mouse.click(bin.x, bin.y);
    const box = await page.locator('#fillmap .grip[data-handle="rb"]').boundingBox();
    const grip = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const { held, presses: [click, p] } = await holdAndLet(page, 'fillmap', grip, to);
    if (p.lineUp && p.changedAt !== null && p.changedAt - click.upAt < 380) {
      expect.soft(held, 'the map stayed where it was pressed').toBe(p.top);
      expect(await binsNow(page), 'one cell out each way').toEqual([[3, 3, 3, 3], [0, 6, 1, 1]]);
      await expect(page.locator('#setAside')).toBeHidden();
      break;
    }
    expect(tries, 'the grip resized the bin while the click\'s save still waited').toBeLessThan(3);
  }
});

/* A point on a cut-map grid line the browser agrees is on it, as plates-undo.spec.js
   finds one: the hit lines are 11 px of transparent stroke, and cross at every junction.
   Along the line: for a row line, across the drawer. */
async function linePoint(page, selector) {
  const p = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect(), across = r.width > r.height;
    for (let f = 0.1; f < 0.95; f += 0.05) {
      const x = across ? r.left + r.width * f : r.left + r.width / 2;
      const y = across ? r.top + r.height / 2 : r.top + r.height * f;
      if (document.elementFromPoint(x, y) === el) return { x, y };
    }
    return null;
  }, selector);
  expect(p, `no point on ${selector}`).not.toBeNull();
  return p;
}

/* A first click on a grid line switches the split to Manual, a change, and the second
   line is pressed inside the 400 ms that set the save going for and held past them. Both
   points are found before the first click: the build that click sets going holds the
   page up, and a look at the page in between can let the save in first. Under load the
   save can still come first now and then, so this one is given more goes. */
test('a cut-map line pressed and held on a link that set yours aside still takes the click', async ({ page }) => {
  const rows = () => page.evaluate(() => state.splitMode === 'manual' ? state.rowCuts.slice() : null);
  for (let tries = 1; ; tries++) {
    await arriveOverYours(page, H.openPlates, () => H.setField(page, 'drawerW', '420'),
      H.PLATES_URL + '#w=300&d=300');
    // the pieces built, so that the build is not holding the page up when the clicks come
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
      null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById('cutmap').scrollIntoView({ block: 'center' }));
    const first = await linePoint(page, '#cutmap .hitline[data-row="1"]');
    const second = await linePoint(page, '#cutmap .hitline[data-row="3"]');
    // the first click seeds the manual split with the cuts the layout has now
    const seeded = await page.evaluate(() => layout.rowCuts.slice());
    await watch(page, 'cutmap');
    await page.mouse.click(first.x, first.y);
    const { held, presses: [, p] } = await holdAndLet(page, 'cutmap', second, second);
    if (p.lineUp && p.changed) {
      expect.soft(held, 'the map stayed where it was pressed').toBe(p.top);
      const toggle = (cuts, j) => cuts.includes(j) ? cuts.filter((k) => k !== j) : [...cuts, j].sort((a, b) => a - b);
      expect(await rows(), 'both clicks took').toEqual(toggle(toggle(seeded, 1), 3));
      await expect(page.locator('#setAside')).toBeHidden();
      break;
    }
    expect(tries, 'pressed the second line while the first click\'s save still waited').toBeLessThan(6);
  }
});

/* A release the page never hears of: the button let go in another window after an
   alt-tab. The browser then moves the pointer with no button down, and the map gets no
   pointerup or pointercancel, only its capture going (bins) or nothing at all (the
   baseplates' cut map, which takes no capture). The save waits for a held press to be
   let go, so a press the page thought was still held kept every later edit, typed ones
   included, out of the address and the saved layout, and a reload lost them. */
async function letGoElsewhere(page, at) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: at.x + 3, y: at.y + 2, button: 'none', buttons: 0 });
  await cdp.detach();
}

test('a bin dragged and let go outside the page does not keep the saves waiting', async ({ page }) => {
  await arriveOverYours(page, H.openBins, () => H.clickCell(page, 0, 0), H.BINS_URL + '#' + BINS_LINK);
  const from = await H.cellPoint(page, 3, 3), to = await H.cellPoint(page, 4, 3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.waitForTimeout(600);
  await letGoElsewhere(page, to);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => drag), 'the drag is over').toBeNull();
  await H.setField(page, 'hUnits', 6);
  await page.waitForTimeout(600);                        // past the save's 400 ms
  expect(await binsNow(page)).toEqual([[4, 3, 2, 2], [0, 6, 1, 1]]);
  expect(decodeURIComponent(await page.evaluate(() => location.hash)), 'the address has both edits')
    .toContain('bl=4-3-2-2-6-');
  await expect(page.locator('#setAside')).toBeHidden();
});

test('a cut-map press let go outside the page does not keep the saves waiting', async ({ page }) => {
  await arriveOverYours(page, H.openPlates, () => H.setField(page, 'drawerW', '420'),
    H.PLATES_URL + '#w=300&d=300');
  await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
    null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById('cutmap').scrollIntoView({ block: 'center' }));
  const at = await linePoint(page, '#cutmap .hitline[data-row="3"]');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await letGoElsewhere(page, at);
  await H.setField(page, 'drawerW', '520');
  await page.waitForTimeout(600);                        // past the save's 400 ms
  expect(await page.evaluate(() => location.hash), 'the typed width saved').toMatch(/[#&]w=520(&|$)/);
  await expect(page.locator('#setAside')).toBeHidden();
});
