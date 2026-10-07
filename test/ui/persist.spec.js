/* Does a reload keep the work?
 *
 * The tool has no accounts and no server, and until now that also meant a refresh, a
 * crashed tab or a stray Ctrl+R lost a drawer someone had spent twenty minutes laying
 * out — unless they had known to press "Copy settings link" first. The state was always
 * serialisable; nothing was writing it down.
 *
 * These reload the real page rather than inspecting location.hash, because the hash
 * being right is not the claim. The claim is that the design comes back, and only a
 * round trip through loadFromHash can say that. A test that asserted the URL contained
 * the right characters would have passed against a hash the page could not read.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

/* Served over HTTP (H.serveRoot), not opened from disk. Every test here reads, on a later
   page, what an earlier one saved, and from file:// pages the CI browser has now and then
   opened the second page with the first page's localStorage write missing: a bare visit
   read 306, the page's own default, where 444 had been saved, once in 611 runs. On a real
   origin the save is dependable, as it is on the site. The service worker is blocked:
   nothing here is about it, and a page it answers is not the one on disk. */
test.use({ serviceWorkers: 'block' });
let site;
test.beforeAll(async () => { site = await H.serveRoot(); });
test.afterAll(() => site.close());
const binsUrl = () => site.base + 'bins/';
// as H.openPlates and H.openBins, at the served pages
async function openPlates(page) {
  await page.goto(site.base);
  await page.waitForFunction(() => {
    const t = document.getElementById('pieceTail');
    return t && /ready/.test(t.textContent);
  }, null, { timeout: 20000 });
}
async function openBins(page) {
  await page.goto(binsUrl());
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(200);
}

const settle = (page) => page.waitForTimeout(900);   // past the 400 ms debounce

test('the baseplates page comes back the way you left it', async ({ page }) => {
  await openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await page.selectOption('#connector', 'hclip');
  await settle(page);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);

  expect(await page.inputValue('#drawerW')).toBe('512');
  expect(await page.inputValue('#connector')).toBe('hclip');
  // and the page believes it too, rather than just showing the value
  expect(await page.$$eval('.connfig',
    (els) => els.filter((e) => e.style.display !== 'none').map((e) => e.dataset.joint)))
    .toEqual(['hclip']);
});

test('the bins page comes back with the bins still in it', async ({ page }) => {
  await openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  const before = await H.bins(page);
  expect(before.length).toBe(2);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);

  const after = await H.bins(page);
  expect(after.length).toBe(2);
  expect(after.map((b) => [b.x, b.y, b.u, b.v]).sort())
    .toEqual(before.map((b) => [b.x, b.y, b.u, b.v]).sort());
});

/* A link someone followed must win over anything the page would have written. The guard
   exists because an init-time save would otherwise overwrite the incoming design with
   the defaults the page had not finished loading yet — and the person who sent the link
   would never know their recipient saw a different drawer. */
test('following a shared link does not overwrite it with the defaults', async ({ page }) => {
  await openPlates(page);
  await H.setField(page, 'drawerW', '378');
  await settle(page);
  const shared = await page.evaluate(() => location.href);
  expect(shared).toContain('#');

  await page.goto('about:blank');
  await page.goto(shared);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('378');
});

/* Saving must not cost you the back button.
 *
 * replaceState and pushState both keep the design across a reload, so every test above
 * passes with either — which is exactly why this one exists. pushState would file a
 * history entry per settled edit, turning Back into an undo nobody asked for and making
 * "leave this page" take one press per change you made. Twenty minutes of layout would
 * trap you on the tool.
 */
test('editing does not fill the history with entries', async ({ page }) => {
  await openPlates(page);
  const start = await page.evaluate(() => history.length);
  for (const w of ['400', '450', '500', '550']) {
    await H.setField(page, 'drawerW', w);
    await settle(page);
  }
  expect(await page.evaluate(() => history.length)).toBe(start);
});

/* Coming back to the bare site, with no link to carry the design.
 *
 * The hash covers a refresh; it cannot cover someone typing the domain or opening a
 * bookmark of the bare site, which is the case that actually loses work. These drive
 * that path exactly — visit, work, then arrive again at a URL with no hash on it.
 */
test('the baseplates page remembers a drawer with no link to carry it', async ({ page }) => {
  await openPlates(page);
  await H.setField(page, 'drawerW', '444');
  await settle(page);

  // arrive again with nothing in the URL at all
  await page.goto(page.url().split('#')[0]);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);

  expect(await page.inputValue('#drawerW')).toBe('444');
  await expect(page.locator('#restored')).toBeVisible();
});

test('the bins page remembers its bins with no link to carry them', async ({ page }) => {
  await openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  expect((await H.bins(page)).length).toBe(1);

  await page.goto(page.url().split('#')[0]);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect((await H.bins(page)).length).toBe(1);
});

test('start fresh clears the save rather than hiding it', async ({ page }) => {
  await openPlates(page);
  await H.setField(page, 'drawerW', '451');
  await settle(page);
  await page.goto(page.url().split('#')[0]);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('451');

  await page.click('#startFresh');
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.inputValue('#drawerW')).not.toBe('451');
  await expect(page.locator('#restored')).toBeHidden();

  // and it stays gone: coming back again must not resurrect it
  await page.goto(page.url().split('#')[0]);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.inputValue('#drawerW')).not.toBe('451');
});

/* The one that matters most. A shared link has to beat whatever the recipient saved,
   or they see their own drawer while believing it is the sender's — and the sender has
   no way of finding out. */
test('a shared link beats the layout this browser saved', async ({ page }) => {
  await openPlates(page);
  await H.setField(page, 'drawerW', '333');
  await settle(page);
  const mine = await page.evaluate(() => location.href);

  await page.goto(mine.split('#')[0]);
  await H.setField(page, 'drawerW', '512');       // saved: 512, link says 333
  await settle(page);

  await page.goto(mine);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('333');
  await expect(page.locator('#restored')).toBeHidden();
});

/* The skip link is the first thing Tab reaches, so it is one keypress from a keyboard
   user's very first action. Followed the ordinary way it put #stage in the address bar,
   and a hash change reloads both tools — which then read "stage" as a shared link,
   found no drawer in it, and saved the empty default over the work. Bins lost every
   bin; baseplates went back to 306 × 380. Nothing on screen said so, and a bare visit
   afterwards restored the empty save. */
const backAgain = async (page) => {
  await page.waitForTimeout(1500);                  // long enough for a reload to land
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
};

test('the skip link on the bins page keeps the bins', async ({ page }) => {
  await openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  expect((await H.bins(page)).length).toBe(2);

  await page.focus('a.skip');
  await page.keyboard.press('Enter');
  await backAgain(page);
  expect((await H.bins(page)).length).toBe(2);
  // it still does its job: focus lands on the stage it skips to
  expect(await page.evaluate(() => document.activeElement.id)).toBe('stage');
  expect(await page.evaluate(() => location.hash)).not.toBe('#stage');

  await page.goto(page.url().split('#')[0]);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect((await H.bins(page)).length).toBe(2);
});

test('the skip link on the baseplates page keeps the drawer', async ({ page }) => {
  await openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await settle(page);

  await page.focus('a.skip');
  await page.keyboard.press('Enter');
  await backAgain(page);
  expect(await page.inputValue('#drawerW')).toBe('512');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('stage');

  await page.goto(page.url().split('#')[0]);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('512');
});

/* The same failure by another road: an outside link, a bookmark or a typed address
   ending in a fragment that carries no settings. It is not a layout, so it must not
   beat the one this browser saved. */
test('an address with no settings in it does not replace the saved layout', async ({ page }) => {
  await openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);

  const bare = page.url().split('#')[0];
  await page.goto('about:blank');           // a fresh arrival, not a same-page jump
  await page.goto(bare + '#stage');
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect((await H.bins(page)).length).toBe(1);
  await expect(page.locator('#restored')).toBeVisible();
});

/* The Steps switch above the map is how this person likes to draw, not part of the
   drawer: it is kept in this browser and never written into the link, so a link sent to
   someone else opens on their own choice. Turning on by itself for a half-size bin is
   the page's doing, not a choice, so that is not kept either. */
const halfBin = (x, y, u, v) =>
  [x, y, u, v, 3, 1.2, 1.2, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 15].join('-');
const stepsNow = (page) => page.evaluate(() => ({
  half: halfSteps,
  pressed: document.getElementById('stepHalf').getAttribute('aria-pressed'),
  kept: localStorage.getItem('drawerforge:bins:steps'),
}));

test('the steps choice is kept in this browser and never in the link', async ({ page }) => {
  await openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const link = await page.evaluate(() => descString());
  expect((await stepsNow(page)).half).toBe(false);

  await page.click('#stepHalf');
  await settle(page);
  expect(await stepsNow(page)).toEqual({ half: true, pressed: 'true', kept: 'half' });
  expect(await page.evaluate(() => descString())).toBe(link);
  expect(await page.evaluate(() => location.hash)).not.toMatch(/step/i);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await stepsNow(page)).toEqual({ half: true, pressed: 'true', kept: 'half' });
  expect((await H.bins(page)).map((b) => [b.x, b.y, b.u, b.v])).toEqual([[0, 0, 2, 2]]);

  await page.click('#stepWhole');
  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await stepsNow(page)).toEqual({ half: false, pressed: 'false', kept: 'whole' });
});

test('half steps turning on for a half-size bin is not kept as a choice', async ({ page }) => {
  await openBins(page);
  await page.goto('about:blank');
  await page.goto(binsUrl() + '#bl=' + halfBin(0.5, 0, 1.5, 1));
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await stepsNow(page)).toEqual({ half: true, pressed: 'true', kept: null });
});

test('a layout with half-size bins comes back after a reload', async ({ page }) => {
  await openBins(page);
  await page.goto('about:blank');
  await page.goto(binsUrl() + '#bl=' + halfBin(0.5, 0, 1.5, 1) + '_' + halfBin(2, 0.5, 0.5, 2.5) +
    '&bs=' + halfBin(0, 0, 2.5, 0.5));
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  const before = await page.evaluate(() => [B().map((b) => [b.x, b.y, b.u, b.v]), [scratch.u, scratch.v]]);
  expect(before).toEqual([[[0.5, 0, 1.5, 1], [2, 0.5, 0.5, 2.5]], [2.5, 0.5]]);

  await page.goto(page.url().split('#')[0]);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.evaluate(() => [B().map((b) => [b.x, b.y, b.u, b.v]), [scratch.u, scratch.v]]))
    .toEqual(before);
});

/* A loose bin's note travels beside it (bsn), as the layers' notes do in bnotes. It was
   never saved at all: a reload, a restore and the README's link all brought the bin back
   without its note, and one raised on its shelf came back a plain bin under another
   name, with no letters. A loose bin with no note has the link it always had. */
test('a loose bin keeps its raised note through a reload, a restore and its README link', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openBins(page);
  await expect(page.locator('#labelMode'), 'the page has the "On the shelf" menu').toHaveCount(1, { timeout: 2000 });
  const ready = async () => {
    await page.waitForFunction(() => typeof THREE !== 'undefined');
    await settle(page);
  };
  await page.evaluate(() => startScratch());
  await settle(page);
  expect(await page.evaluate(() => descString()), 'no note, no field for one').not.toContain('bsn');

  await page.selectOption('#labelMode', '1');
  await page.fill('#note', 'M3 screws');
  await settle(page);
  const now = () => page.evaluate(() => [!!scratch, scratch && scratch.note, scratch && scratch.labelMode,
    scratch && typeName(types()[0])]);
  const want = [true, 'M3 screws', 1, 'bin-1x1x3-m3-screws-qty1'];
  expect(await now()).toEqual(want);
  const readme = await page.evaluate(() => layoutReadme());
  expect(readme).toContain('Raised note: “M3 screws” on the label shelf, 4.5 mm letters on one line.');
  const link = readme.match(/^Layout link: (.*)$/m)[1];
  expect(link).toContain('bsn=M3%20screws');

  await page.reload();
  await ready();
  expect(await now(), 'after a reload').toEqual(want);

  await page.goto('about:blank');
  await page.goto(binsUrl());
  await ready();
  expect(await now(), 'restored, on the bare page').toEqual(want);

  // and from the README's link alone, with nothing saved in this browser
  await page.evaluate(() => localStorage.clear());
  await page.goto('about:blank');
  await page.goto(link);
  await ready();
  expect(await now(), "from the README's link").toEqual(want);
  expect(errors).toEqual([]);
});
