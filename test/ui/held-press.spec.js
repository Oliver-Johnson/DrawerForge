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

/* Over HTTP (H.serveRoot). From file:// a page's local save now and then went missing on
   the next load, and the case then arrived over nothing of yours. The header links the
   cases at the foot follow point at directories, which file:// does not resolve, and a
   request the service worker answers never reaches page.route, so the worker is kept
   out. */
test.use({ serviceWorkers: 'block' });
let site;
test.beforeAll(async () => { site = await H.serveRoot(); });
test.afterAll(() => site.close());
const BINS_AT = () => site.base + 'bins/';
const PLATES_AT = () => site.base;

/* The page (`at`, one of the two above) at a link `hash`, through about:blank, with a
   layout of yours saved before it, so the link sets yours aside and says so above the
   map. */
async function arriveOverYours(page, at, yours, hash) {
  page.__errors = await (at === BINS_AT ? H.openBins : H.openPlates)(page, at());
  await yours();
  await page.waitForTimeout(600);                        // past the save's 400 ms
  await page.goto('about:blank');
  await page.goto(at() + '#' + hash);
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
const binsNow = (page) => page.evaluate(() => B().map((b) => [b.x, b.y, b.u, b.v]));

/* Pressed at `from` and moved to `to` with the page's save kept (keepSave, below), then
   that save let come due while the press is still held, and the press let go a pixel or
   two away. Gives every press watch() saw, where the map was once the save had come, and
   whether there was a save waiting to come. The save comes when the test says rather than
   400 ms on: timed, the drag had to change the design inside 400 ms of the press or the
   click before it, and every step of getting there is a round trip to a browser that a
   busy machine slows, so under load three goes in a row could all miss. */
async function holdOverSave(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  const due = await saveDue(page);
  const held = await page.evaluate(() => document.getElementById('fillmap').getBoundingClientRect().top);
  await page.mouse.move(to.x + 2, to.y + 1);
  await page.mouse.up();
  return { due, held, presses: await page.evaluate(() => window.__presses) };
}
/* and the line goes once the bin is let go: the release sets the save going again, and
   that one finds the layout changed */
async function lineGoes(page) {
  await page.waitForFunction(() => window.__save !== null);
  await saveDue(page);
  await expect(page.locator('#setAside')).toBeHidden();
}

/* The press grabs the bin, which sets the save going, and the drag has moved it before
   the save comes, so the save finds the design changed. */
test('a bin dragged and held on a link that set yours aside lands where it was let go', async ({ page }) => {
  await arriveOverYours(page, BINS_AT, () => H.clickCell(page, 0, 0), BINS_LINK);
  const from = await H.cellPoint(page, 3, 3), to = await H.cellPoint(page, 4, 3);
  await keepSave(page);
  await watch(page, 'fillmap');
  const { due, held, presses: [p] } = await holdOverSave(page, from, to);
  expect(due, 'the press set a save going').toBe(true);
  expect(p.lineUp && p.changedAt !== null, 'the drag changed the design with the line up').toBe(true);
  expect.soft(held, 'the map stayed where it was pressed').toBe(p.top);
  expect(await binsNow(page), 'one cell right').toEqual([[4, 3, 2, 2], [0, 6, 1, 1]]);
  await lineGoes(page);
});

/* A grip is pressed a moment after the click that selected the bin, and has pulled the
   bin out before the save that click set going comes, so the save finds it resized. */
test('a grip pulled and held a moment after selecting the bin makes the size it was let go at', async ({ page }) => {
  await arriveOverYours(page, BINS_AT, () => H.clickCell(page, 0, 0), BINS_LINK);
  const to = await H.cellPoint(page, 5, 5), bin = await H.cellPoint(page, 3, 3);
  await keepSave(page);
  await watch(page, 'fillmap');
  await page.mouse.click(bin.x, bin.y);
  await page.waitForFunction(() => window.__save !== null);
  const box = await page.locator('#fillmap .grip[data-handle="rb"]').boundingBox();
  const grip = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const { due, held, presses: [, p] } = await holdOverSave(page, grip, to);
  expect(due, 'the click set a save going').toBe(true);
  expect(p.lineUp && p.changedAt !== null, 'the grip changed the design with the line up').toBe(true);
  expect.soft(held, 'the map stayed where it was pressed').toBe(p.top);
  expect(await binsNow(page), 'one cell out each way').toEqual([[3, 3, 3, 3], [0, 6, 1, 1]]);
  await lineGoes(page);
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

/* The page's save, run when the test says rather than 400 ms on. rememberState's timer
   is the only one that long on the baseplates page, so it is kept instead of set going:
   the save the first click below sets going then comes due while the second line is
   held, however long the build that click starts holds the page up. Timed, it came due
   before the second press on a busy machine, and six goes in a row could all miss: 7
   runs in 8 failed with 4 workers. */
const keepSave = (page) => page.evaluate(() => {
  const later = setTimeout;
  window.__save = null;
  window.setTimeout = (f, ms, ...a) => (ms === 400 ? ((window.__save = f), 0) : later(f, ms, ...a));
});
const saveDue = (page) => page.evaluate(() => {
  const f = window.__save;
  window.__save = null;
  if (f) f();
  return !!f;
});

/* A first click on a grid line switches the split to Manual, a change, and the second
   line is pressed before that click's save and held while it comes due. Both points are
   found before the first click: the build that click sets going holds the page up. */
test('a cut-map line pressed and held on a link that set yours aside still takes the click', async ({ page }) => {
  const rows = () => page.evaluate(() => state.splitMode === 'manual' ? state.rowCuts.slice() : null);
  await arriveOverYours(page, PLATES_AT, () => H.setField(page, 'drawerW', '420'), 'w=300&d=300');
  // the pieces built, so that the build is not holding the page up when the clicks come
  await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
    null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById('cutmap').scrollIntoView({ block: 'center' }));
  const first = await linePoint(page, '#cutmap .hitline[data-row="1"]');
  const second = await linePoint(page, '#cutmap .hitline[data-row="3"]');
  // the first click seeds the manual split with the cuts the layout has now
  const seeded = await page.evaluate(() => layout.rowCuts.slice());
  await keepSave(page);
  await watch(page, 'cutmap');
  await page.mouse.click(first.x, first.y);
  await page.waitForFunction(() => window.__save !== null);
  await page.mouse.move(second.x, second.y);
  await page.mouse.down();
  expect(await saveDue(page), 'the first click set a save going').toBe(true);
  const held = await page.evaluate(() => document.getElementById('cutmap').getBoundingClientRect().top);
  await page.mouse.move(second.x + 2, second.y + 1);
  await page.mouse.up();
  const [, p] = await page.evaluate(() => window.__presses);
  expect(p.lineUp && p.changed, 'the second press came on a changed design, the line still up').toBe(true);
  expect.soft(held, 'the map stayed where it was pressed').toBe(p.top);
  const toggle = (cuts, j) => cuts.includes(j) ? cuts.filter((k) => k !== j) : [...cuts, j].sort((a, b) => a - b);
  await expect.poll(rows, { message: 'both clicks took' }).toEqual(toggle(toggle(seeded, 1), 3));
  // the release sets the save going again, and that one takes the line away
  await page.waitForFunction(() => window.__save !== null);
  await saveDue(page);
  await expect(page.locator('#setAside')).toBeHidden();
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
  await arriveOverYours(page, BINS_AT, () => H.clickCell(page, 0, 0), BINS_LINK);
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
  await arriveOverYours(page, PLATES_AT, () => H.setField(page, 'drawerW', '420'), 'w=300&d=300');
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

/* ---------- leaving with a bin still held ----------------------------------------
   The header's Baseplates and Guide links save the design and hand it to the next page
   (leave), and either can be pressed while the mouse still holds a bin on the map: from
   the keyboard, or with a finger on a touch screen. What they hand over has the bin where
   the drag had it, which is where a press the page loses lands it (lostpointercapture).
   But the press stayed on: the bin went on following the pointer while the next page
   loaded, and letting go set a save going that wrote another layout into the address and
   the local save after the hand-over, so Back came to a layout the other page was never
   given. The next page is held back here until the bin has been let go somewhere else
   and that save would have come. */
test.describe('leaving with a bin still held', () => {
  // BINS_LINK's layout with the 2 x 2 two cells right, as packBin writes it
  const HELD = BINS_LINK.replace(/^bl=3-3-/, '5-3-');
  const binsIn = (h) => (decodeURIComponent(h || '').match(/(?:^|[#&])bl=([^&]*)/) || [])[1];

  async function openOver(page) {
    const errors = page.__errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BINS_AT() + '#' + BINS_LINK);
    await page.waitForFunction(() => typeof THREE !== 'undefined' && typeof drawers !== 'undefined');
    await page.waitForTimeout(600);                      // past the boot's save
  }
  /* The 2 x 2 grabbed and moved two cells right, `go` following the link with it held,
     then the pointer moved on and let go elsewhere on the map while the page the link
     asked for (`to`) is held back, and that page let through once the save the release
     would set going is due. Focus moving down the page scrolls it, so where the pointer
     goes on to lands on whichever cell is there by then. */
  async function holdAndLeave(page, to, go) {
    const from = await H.cellPoint(page, 3, 3), held = await H.cellPoint(page, 5, 3);
    const away = await H.cellPoint(page, 1, 6);
    let letThrough;
    const gate = new Promise((r) => { letThrough = r; });
    await page.route(to, async (route) => { await gate; await route.continue(); });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(held.x, held.y, { steps: 6 });
    expect(await binsNow(page), 'held two cells right').toEqual([[5, 3, 2, 2], [0, 6, 1, 1]]);
    /* The next page asked for is the link followed, so leave() has run. Nothing is read
       out of the page until the next one arrives: the browser answers no evaluate while
       a navigation waits, and the press or tap that started it may wait for it too. */
    const asked = page.waitForRequest((r) => to(new URL(r.url())));
    const going = go();
    await asked;
    await page.mouse.move(away.x, away.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);                      // past the save's 400 ms
    letThrough();
    await going;
    await page.waitForURL(to);
  }
  /* What the next page was handed, what the bins page saved on this device, and what Back
     comes to: each the bin where it was when the link was followed. */
  async function heldEverywhere(page) {
    expect(binsIn(page.url()), 'handed over').toBe(HELD);
    expect(binsIn(await page.evaluate(() => localStorage.getItem('drawerforge:bins:v1'))),
      'the bins page\'s save').toBe(HELD);
    await page.goBack();
    await page.waitForFunction(() => typeof B === 'function' && typeof drawers !== 'undefined');
    expect(await binsNow(page), 'Back').toEqual([[5, 3, 2, 2], [0, 6, 1, 1]]);
  }

  test('the Baseplates link followed from the keyboard with a bin held keeps the layout it handed over',
    async ({ page }) => {
      await openOver(page);
      await holdAndLeave(page, (u) => u.pathname === '/', async () => {
        // Tab on from where the press was, as far as the link
        for (let i = 0; i < 100; i++) {
          await page.keyboard.press('Tab');
          if (await page.evaluate(() => document.activeElement.id === 'navPlates')) break;
        }
        await page.keyboard.press('Enter');
      });
      await heldEverywhere(page);
    });

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true });
    test('the Guide link tapped with a bin held by the mouse keeps the layout it handed over',
      async ({ page }) => {
        await openOver(page);
        await holdAndLeave(page, (u) => u.pathname === '/guide/', async () => {
          const box = await page.locator('#navGuide').boundingBox();
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        });
        await heldEverywhere(page);
      });
  });
});
