/* Several saved drawers, and the design file that carries them.
 *
 * Each tool used to keep exactly one layout on the device, so a tool chest of eight
 * drawers meant one at a time and a pile of bookmarked links. A saved drawer holds the
 * baseplate and the bins together, so these drive both pages and go between them by the
 * real header links — the claim is that switching drawers on either page brings BOTH
 * halves back, and that the hand-over between the tools keeps working while it does.
 *
 * Served over HTTP rather than opened from disk like the rest of test/ui. The header
 * links point at directories ("bins/", "../"), which a file:// URL does not resolve to
 * their index.html, and the hand-over is exactly what is under test here — faking it with
 * page.goto would skip the code that tells the saved drawer it is happening. The server
 * is H.serveRoot.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const H = require('./helpers.js');

/* Over HTTP the pages register the service worker (sw.js), and a request the worker
   answers never reaches page.route — so the slowed reload below would quietly stop being
   slow. Nothing here is about the worker; offline.spec.js is. */
test.use({ serviceWorkers: 'block' });

let site, base;
test.beforeAll(async () => { site = await H.serveRoot(); base = site.base; });
test.afterAll(() => site.close());

const settle = (page) => page.waitForTimeout(900);   // past the 400 ms save debounce
const platesReady = (page) => page.waitForFunction(() => {
  const t = document.getElementById('pieceTail');
  return typeof drawers !== 'undefined' && t && /ready/.test(t.textContent);
}, null, { timeout: 30000 });
const binsReady = async (page) => {
  await page.waitForFunction(() => typeof drawers !== 'undefined' &&
    !!document.getElementById('fillmap') && typeof B === 'function');
  await page.waitForTimeout(200);
};
const design = (page) => page.evaluate(() => encodeDesc(descriptor()));
const binCount = (page) => page.evaluate(() => B().length);

async function openPlates(page, hash = '') {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + hash);
  await platesReady(page);
  return errors;
}
async function toBins(page) {
  await page.click('#navBins');
  await page.waitForURL(/\/bins\/#/);
  await binsReady(page);
}
async function toPlates(page) {
  await page.click('#navPlates');
  await page.waitForURL((u) => !/\/bins\//.test(u.pathname));
  await platesReady(page);
}

const dialog = (page) => page.locator('#drawersDlg');
async function openDialog(page) {
  await page.click('#drawersBtn');
  await expect(dialog(page)).toBeVisible();
}
async function closeDialog(page) {
  await page.click('#drawersClose');
  await expect(dialog(page)).toBeHidden();
}
async function saveAs(page, name) {
  await openDialog(page);
  await page.fill('#drawersNewName', name);
  await page.press('#drawersNewName', 'Enter');
  await expect(page.locator('#drawersMsg')).toContainText(`Saved as “${name}”`);
  await closeDialog(page);
  await expect(page.locator('#drawerName')).toHaveText(name);
}
const listed = (page) => page.$$eval('#drawersList .dwrow .nm', (els) => els.map((e) => e.textContent));
// every saved drawer's settings, by name, read straight out of storage
const stored = (page) => page.evaluate(() => Object.fromEntries(
  JSON.parse(localStorage.getItem('drawerforge:drawers:v1')).drawers.map((d) => [d.name,
    Object.fromEntries(d.hash.split('&').map((kv) => kv.split('=').map(decodeURIComponent)))])));
/* Opening a drawer reloads the page with that drawer's design, so wait for the reload
   rather than for a duration. */
async function openDrawer(page, name, ready) {
  await openDialog(page);
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: `Open ${name}`, exact: true }).click(),
  ]);
  await ready(page);
  await expect(page.locator('#drawerName')).toHaveText(name);
}

/* The page records which drawer it is at its first save, 400 ms after it loads. A reload
   inside that used to find no record of the hand-over and came back unsaved. */
test('a reload straight after the hand-over is still the drawer that was handed over',
  async ({ page }) => {
    const errors = await openPlates(page);
    await H.setField(page, 'drawerW', '400');
    await saveAs(page, 'Kitchen');
    await toBins(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    await page.reload();
    await binsReady(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    expect(await page.inputValue('#drawerW')).toBe('400');
    expect(errors).toEqual([]);
  });

/* The page saves 400 ms after a change, and a page being reloaded runs on until the new
   one arrives. On a slow connection that save landed after the reload had taken the
   address from before it, and the page came back unsaved. The server is slowed here so
   the save would always land in that gap. */
test('a reload started before the last save is still the drawer', async ({ page }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Kitchen');
  await toBins(page);
  await settle(page);
  let slow = 0;
  await page.route(/\/bins\/$/, async (route) => {
    await new Promise((r) => setTimeout(r, slow));
    await route.continue();
  });
  slow = 900;
  await H.dragCells(page, [0, 0], [1, 1]);
  await page.waitForTimeout(100);
  await page.reload();
  await binsReady(page);
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  expect(errors).toEqual([]);
});

/* The page saves 400 ms after a change, and a save still waiting as a page goes is
   dropped. Going to the other tool is the page's own doing, so it saves first: a change
   made just before was in the hand-over, but not in the address Back returns to, and the
   page coming back wrote the old setting over it. The reload after Back is what a browser
   without the back-forward cache does. */
test('a change made just before going to the other tool is still there after Back',
  async ({ page }) => {
    const errors = await openPlates(page);
    await saveAs(page, 'Kitchen');
    await settle(page);
    expect((await stored(page)).Kitchen.cn).toBe('dovetail');
    // the change and the click in one go, so the save cannot run between them
    await Promise.all([page.waitForURL(/\/bins\/#/), page.evaluate(() => {
      const s = document.getElementById('connector');
      s.value = 'snap';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('navBins').click();
    })]);
    await binsReady(page);
    await settle(page);
    expect((await stored(page)).Kitchen.cn, 'the hand-over has it').toBe('snap');
    await page.goBack();
    await platesReady(page);
    await page.reload();
    await platesReady(page);
    await settle(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    expect(await page.inputValue('#connector')).toBe('snap');
    expect((await stored(page)).Kitchen.cn, 'and so does the drawer, after Back').toBe('snap');
    expect(errors).toEqual([]);
  });

/* A link copied from the page is the design as it was then. Opened after a later change
   has been saved, it is an older design than the drawer's, and opening it as the drawer
   would save it over that change. */
test('a link copied before the last change does not open as the drawer', async ({ page, context }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Kitchen');
  await H.setField(page, 'drawerW', '410');
  await settle(page);
  const link = page.url();
  await H.setField(page, 'drawerW', '420');
  await settle(page);

  // in a new tab, which has only the device's record of the drawer
  const other = await context.newPage();
  other.on('pageerror', (e) => errors.push(String(e)));
  await other.goto(link);
  await platesReady(other);
  await expect(other.locator('#drawerName')).toHaveText('not saved');
  await settle(other);
  await other.close();

  // and in this tab, which has its own
  await page.goto('about:blank');
  await page.goto(link);
  await platesReady(page);
  await expect(page.locator('#drawerName')).toHaveText('not saved');
  await settle(page);
  expect((await stored(page)).Kitchen.w, 'the later change is still in the drawer').toBe('420');
  expect(errors).toEqual([]);
});

test('two drawers, switched on either page, bring both halves back and survive a reload',
  async ({ page }) => {
    const errors = await openPlates(page);
    await expect(page.locator('#drawerName'), 'a first visit is not a saved drawer').toHaveText('not saved');

    // Kitchen: a 400 mm drawer with one 2x2 bin
    await H.setField(page, 'drawerW', '400');
    await saveAs(page, 'Kitchen');
    await toBins(page);
    await expect(page.locator('#drawerName'), 'the drawer travels with the hand-over').toHaveText('Kitchen');
    expect(await page.inputValue('#drawerW')).toBe('400');
    await H.dragCells(page, [0, 0], [1, 1]);
    await settle(page);

    /* Garage: saved from the baseplates page as a copy of Kitchen, then made its own. In
       that order — Kitchen is open, so an edit made before the copy is an edit to Kitchen. */
    await toPlates(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    await saveAs(page, 'Garage');
    await H.setField(page, 'drawerW', '500');
    await toBins(page);
    await expect(page.locator('#drawerName')).toHaveText('Garage');
    expect(await binCount(page), 'save-as copies both halves of the drawer').toBe(1);
    await H.dragCells(page, [4, 0], [4, 0]);
    expect(await binCount(page)).toBe(2);
    await settle(page);

    // switch on the bins page: Kitchen's bins, and Kitchen's drawer size
    await openDrawer(page, 'Kitchen', binsReady);
    expect(await binCount(page)).toBe(1);
    expect(await page.inputValue('#drawerW')).toBe('400');
    // ...and its baseplate is the one across the hand-over
    await toPlates(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    expect(await page.inputValue('#drawerW')).toBe('400');

    // switch on the baseplates page: Garage, and Garage's bins across the hand-over
    await openDrawer(page, 'Garage', platesReady);
    expect(await page.inputValue('#drawerW')).toBe('500');
    await toBins(page);
    await expect(page.locator('#drawerName')).toHaveText('Garage');
    expect(await binCount(page)).toBe(2);

    // and Kitchen was not touched by any of it: editing Garage saved into Garage
    await page.reload();
    await binsReady(page);
    await openDialog(page);
    expect(await listed(page)).toEqual(['Garage', 'Kitchen']);
    await expect(page.locator('#drawersList .dwrow.on .nm'), 'and it knows which is open').toHaveText('Garage');
    expect(errors).toEqual([]);
  });

/* Both pages write the drawer's size and the printer, so a page that saved them whether
   or not it had changed them made the rule "the last page to save anything wins". Going
   Back is the plain way to hit it: the page you return to reloads the address it last
   wrote, which still has the old size, and its first save put that size back. */
test('going Back to the other page shows the drawer as it is now, and puts no old size back',
  async ({ page }) => {
    const errors = await openPlates(page);
    await saveAs(page, 'Kitchen');                // 306 wide, saved from the baseplates page
    await settle(page);
    await toBins(page);
    await H.setField(page, 'drawerW', '400');
    await settle(page);
    expect((await stored(page)).Kitchen.w).toBe('400');

    // the browser's Back, not the header link: the baseplates address still says 306
    await page.goBack();
    await expect.poll(() => page.inputValue('#drawerW').catch(() => ''),
      { message: 'the page shows the drawer as it is now', timeout: 20000 }).toBe('400');
    await platesReady(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    await settle(page);
    expect((await stored(page)).Kitchen.w, 'and its first save left the width alone').toBe('400');
    expect(errors).toEqual([]);
  });

/* Two tabs on one drawer: each saves only what it changed, so neither undoes the other.
   And a page the browser restores from its back-forward cache, where nothing reloads,
   catches up with the drawer instead of going on showing a size it no longer has. */
test('a second tab resizing the drawer is not undone when the first tab saves', async ({ page, context }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Kitchen');
  await toBins(page);                             // so the bins page has a save of Kitchen
  await settle(page);
  await toPlates(page);
  await settle(page);

  const other = await context.newPage();
  other.on('pageerror', (e) => errors.push(String(e)));
  await other.goto(base + 'bins/');
  await binsReady(other);
  await expect(other.locator('#drawerName')).toHaveText('Kitchen');
  /* drawers.js keeps its own list of the keys both pages write, and it has to be exactly
     the keys both pages own. The baseplates page lists 'ph' only so as not to echo it, and
     does not write it into a drawer (see the comment above DRAWERS.create in src/ui.js). */
  const platesOwn = await page.evaluate(() => [...OWNED].filter((k) => k !== 'ph'));
  const binsOwn = await other.evaluate(() => [...BINS_OWN]);
  expect(platesOwn.filter((k) => binsOwn.includes(k)).sort(), 'the keys both pages own')
    .toEqual(await page.evaluate(() => [...DRAWERS.SHARED].sort()));

  await H.setField(other, 'drawerW', '400');
  await settle(other);

  // the first tab still shows 306, and changes something of its own
  expect(await page.inputValue('#drawerW')).toBe('306');
  await page.selectOption('#connector', 'hclip');
  await settle(page);
  const k = (await stored(page)).Kitchen;
  expect(k.w, 'the width the other tab set').toBe('400');
  expect(k.cn, 'and the connector this one set').toBe('hclip');

  await Promise.all([page.waitForEvent('load'), page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))]);
  await platesReady(page);
  expect(await page.inputValue('#drawerW')).toBe('400');
  expect(await page.inputValue('#connector')).toBe('hclip');
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await settle(page);
  expect((await stored(page)).Kitchen).toMatchObject({ w: '400', cn: 'hclip' });
  expect(errors).toEqual([]);
});

/* The backup slots beside each tool's save (see PREV_KEY in src/ui.js). None of the cases
   below is a link replacing your layout, so none of them may write one. */
const slots = (page) => page.evaluate(() => Object.fromEntries(['plates', 'bins'].flatMap((t) =>
  [':prev', ':linked', ':prev:linked'].map((s) => [t + s, localStorage.getItem(`drawerforge:${t}:v1${s}`)]))));

/* Opening a drawer on one page and then taking it to the other replaces what the other
   page showed last, which is another drawer's half. That half is kept in its own drawer,
   so this is no link replacing your layout: no banner, and the backup keeps what it had.
   Someone's link onto the same page still gets both. */
test('taking an opened drawer to the other page sets nothing aside', async ({ page }) => {
  const errors = await openPlates(page);
  await H.setField(page, 'drawerW', '400');
  await saveAs(page, 'Kitchen');
  await toBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await toPlates(page);
  await saveAs(page, 'Garage');
  await H.setField(page, 'drawerW', '500');
  await toBins(page);
  await H.dragCells(page, [4, 0], [4, 0]);
  await settle(page);
  const before = await slots(page);

  // Kitchen opened on the baseplates page, over Garage there; the bins page still has Garage
  await toPlates(page);
  await openDrawer(page, 'Kitchen', platesReady);
  await toBins(page);
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  expect(await binCount(page)).toBe(1);
  await expect(page.locator('#setAside')).toBeHidden();
  await settle(page);

  // and the other way: Garage opened on the bins page, over Kitchen on the baseplates page
  await openDrawer(page, 'Garage', binsReady);
  await toPlates(page);
  await expect(page.locator('#drawerName')).toHaveText('Garage');
  expect(await page.inputValue('#drawerW')).toBe('500');
  await expect(page.locator('#setAside')).toBeHidden();
  await settle(page);
  expect(await slots(page), 'nothing was set aside').toEqual(before);

  // someone's link is still a link, drawer or no drawer
  await page.goto('about:blank');
  await openPlates(page, '#w=333&d=444&v=2');
  await expect(page.locator('#setAside')).toBeVisible();
  await expect(page.locator('#drawerName')).toHaveText('not saved');
  expect(errors).toEqual([]);
});

/* Two tabs of one tool on one drawer, and the second moves it on. Reloading the first is
   that tab's own page coming back, not someone's link: no banner and nothing set aside,
   and it is still the drawer, caught up with what the other tab set. It used to come
   back unsaved on the old size, and nothing it did after reached the drawer. */
for (const tool of ['plates', 'bins']) {
  test(`reloading a ${tool} tab after another tab moved its drawer on`, async ({ page, context }) => {
    const ready = tool === 'plates' ? platesReady : binsReady;
    const errors = await openPlates(page);
    await saveAs(page, 'Kitchen');
    if (tool === 'bins') await toBins(page);
    await settle(page);
    const before = await slots(page);

    const other = await context.newPage();
    other.on('pageerror', (e) => errors.push(String(e)));
    await other.goto(base + (tool === 'bins' ? 'bins/' : ''));
    await ready(other);
    await expect(other.locator('#drawerName')).toHaveText('Kitchen');
    await H.setField(other, 'drawerW', '650');
    await settle(other);

    await page.reload();
    await expect.poll(() => page.inputValue('#drawerW').catch(() => ''),
      { message: 'caught up with the other tab', timeout: 20000 }).toBe('650');
    await ready(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    await expect(page.locator('#setAside')).toBeHidden();
    await H.setField(page, 'drawerD', '420');
    await settle(page);
    expect((await stored(page)).Kitchen, 'its edits reach the drawer').toMatchObject({ w: '650', d: '420' });
    expect(await slots(page), 'nothing was set aside').toEqual(before);
    expect(errors).toEqual([]);
  });
}

/* Each page saves its whole half of the drawer, so one whose half is older than the
   drawer's would write it back: a reload of a tab after another tab of the same tool
   changed the drawer, or Back to a page of yours that a later page has moved on. Both
   come back as the drawer is now, and what the other page did stays done. */
test('a reload never writes an older half back over the drawer', async ({ page, context }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Kitchen');
  await settle(page);
  const other = await context.newPage();
  other.on('pageerror', (e) => errors.push(String(e)));
  await other.goto(base);
  await platesReady(other);
  await expect(other.locator('#drawerName')).toHaveText('Kitchen');
  await other.selectOption('#connector', 'snap');
  await expect.poll(() => stored(page).then((s) => s.Kitchen.cn),
    { message: 'the other tab saved into the drawer', timeout: 20000 }).toBe('snap');

  await page.reload();
  await expect.poll(() => page.inputValue('#connector').catch(() => ''),
    { message: 'the connector the other tab set', timeout: 20000 }).toBe('snap');
  await platesReady(page);
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await settle(page);
  expect((await stored(page)).Kitchen.cn, 'and the drawer keeps it').toBe('snap');

  // the bins page: a bin the other tab added
  await toBins(page);
  await settle(page);
  await other.goto(base + 'bins/');
  await binsReady(other);
  await expect(other.locator('#drawerName')).toHaveText('Kitchen');
  await H.dragCells(other, [0, 0], [1, 1]);
  await expect.poll(() => stored(page).then((s) => s.Kitchen.bl || ''),
    { message: 'the other tab saved into the drawer', timeout: 20000 }).not.toBe('');
  await page.reload();
  await expect.poll(() => binCount(page).catch(() => -1),
    { message: 'the bin the other tab added', timeout: 20000 }).toBe(1);
  await binsReady(page);
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await settle(page);
  expect((await stored(page)).Kitchen.bl, 'and the drawer keeps it').not.toBe('');
  await other.close();

  // one tab: Back to a baseplates page older than the drawer
  await toPlates(page);
  await page.selectOption('#connector', 'hclip');
  await settle(page);
  await toBins(page);
  await settle(page);
  await page.goBack();
  await platesReady(page);
  await page.goBack();
  await binsReady(page);
  await page.goBack();
  await expect.poll(() => page.inputValue('#connector').catch(() => ''),
    { message: 'Back shows the drawer as it is now', timeout: 20000 }).toBe('hclip');
  await platesReady(page);
  await settle(page);
  expect((await stored(page)).Kitchen.cn, 'and the drawer keeps it').toBe('hclip');
  expect(errors).toEqual([]);
});

/* A link handed over from the other page is that link arriving, even onto a save that a
   drawer holds: it says so, and sets the layout it replaces aside, in both directions. */
test('someone\'s link taken to the other page still says it replaced your layout', async ({ page }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Kitchen');
  await toBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await toPlates(page);
  await settle(page);
  const key = (t, slot = '') => `drawerforge:${t}:v1${slot}`;
  const read = (k) => page.evaluate((k) => localStorage.getItem(k), k);
  const halves = { plates: await read(key('plates')), bins: await read(key('bins')) };

  // a link opened on the baseplates page and taken to the bins page, whose save is Kitchen's half
  await page.goto('about:blank');
  await openPlates(page, '#w=520&d=410&v=2');
  await toBins(page);
  await expect(page.locator('#setAside')).toBeVisible();
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await read(key('bins', ':prev'))).toBe(halves.bins);

  // and the other way, onto Kitchen's half on the baseplates page, with its backup cleared
  await page.evaluate(([k, h, p]) => { localStorage.setItem(k, h); localStorage.removeItem(p); },
    [key('plates'), halves.plates, key('plates', ':prev')]);
  await page.goto('about:blank');
  await page.goto(base + 'bins/#w=500&d=400&cn=hclip&v=2');
  await binsReady(page);
  await toPlates(page);
  await expect(page.locator('#setAside')).toBeVisible();
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await read(key('plates', ':prev'))).toBe(halves.plates);
  expect(errors).toEqual([]);
});

/* Back to an earlier page of your own, when the browser loads it again rather than keeping
   it — Playwright keeps none, and nor does a browser that has evicted it. Its address is
   older than the save, but it is still your page and not a link: no banner, nothing set
   aside, still the drawer and caught up with it, and the next trip is a hand-over too. */
test('Back to an earlier page of your own is not a link', async ({ page }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Kitchen');
  await toBins(page);
  await H.setField(page, 'drawerW', '450');
  await H.setField(page, 'drawerD', '400');
  await settle(page);
  await toPlates(page);
  await H.setField(page, 'drawerD', '410');
  await settle(page);
  await toBins(page);
  await settle(page);
  const before = await slots(page);

  await page.goBack();
  await platesReady(page);
  await page.goBack();
  await expect.poll(() => page.inputValue('#drawerD').catch(() => ''),
    { message: 'shown at the drawer\'s depth now', timeout: 20000 }).toBe('410');
  await binsReady(page);
  expect(page.url()).toMatch(/\/bins\//);
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await expect(page.locator('#setAside')).toBeHidden();
  await settle(page);

  await toPlates(page);
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await expect(page.locator('#setAside')).toBeHidden();
  await settle(page);
  expect(await slots(page), 'nothing was set aside').toEqual(before);
  expect((await stored(page)).Kitchen).toMatchObject({ w: '450', d: '410' });
  expect(errors).toEqual([]);
});

/* The same with no drawer saved. Going back is what you asked for, but the later layout
   is only in this browser's save, and the first change on the earlier page would write
   over it. So it goes aside, the page says so, and Put back brings it back. On both
   pages, and in a second tab reloaded on an address the first tab has moved on from. */
test('Back to an earlier layout with nothing saved sets the later one aside', async ({ page, context }) => {
  const errors = await openPlates(page);
  const key = (t, slot = '') => `drawerforge:${t}:v1${slot}`;
  const read = (p, k) => p.evaluate((k) => localStorage.getItem(k), k);
  const wentBack = async (p) => {
    await expect(p.locator('#setAside')).toBeVisible();
    await expect(p.locator('#setAsideMsg')).toContainText('went back to an earlier layout');
    await expect(p.locator('#putBack')).toBeVisible();
  };

  await H.setField(page, 'drawerW', '500');
  await page.selectOption('#connector', 'snap');
  await settle(page);
  await toBins(page);
  await settle(page);
  await toPlates(page);
  await H.setField(page, 'drawerW', '600');
  await page.selectOption('#connector', 'hclip');
  await settle(page);
  const later = await read(page, key('plates'));
  await page.goBack();
  await binsReady(page);
  await expect(page.locator('#setAside'), 'the bins page has not moved on').toBeHidden();
  await page.goBack();
  await expect.poll(() => page.inputValue('#connector').catch(() => ''),
    { message: 'Back shows the earlier layout', timeout: 20000 }).toBe('snap');
  await platesReady(page);
  await wentBack(page);
  expect(await read(page, key('plates', ':prev'))).toBe(later);
  await Promise.all([page.waitForEvent('load'), page.click('#putBack')]);
  await platesReady(page);
  expect(await page.inputValue('#connector'), 'Put back brings the later one back').toBe('hclip');
  await settle(page);
  expect(await read(page, key('plates'))).toBe(later);

  // the bins page
  await toBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  await toPlates(page);
  await settle(page);
  await toBins(page);
  await H.dragCells(page, [3, 0], [4, 1]);
  await settle(page);
  expect(await binCount(page)).toBe(2);
  const laterBins = await read(page, key('bins'));
  await page.goBack();
  await platesReady(page);
  await expect(page.locator('#setAside'), 'the baseplates page has not moved on').toBeHidden();
  await page.goBack();
  await expect.poll(() => binCount(page).catch(() => -1),
    { message: 'Back shows the earlier layout', timeout: 20000 }).toBe(1);
  await binsReady(page);
  await wentBack(page);
  expect(await read(page, key('bins', ':prev'))).toBe(laterBins);

  // a second tab on an older address, reloaded after the first tab moved on
  await toPlates(page);
  await settle(page);
  const other = await context.newPage();
  other.on('pageerror', (e) => errors.push(String(e)));
  await other.goto(base);
  await platesReady(other);
  await settle(other);
  await page.selectOption('#connector', 'puzzle');
  await settle(page);
  const newer = await read(page, key('plates'));
  await other.reload();
  await platesReady(other);
  await wentBack(other);
  expect(await read(other, key('plates', ':prev'))).toBe(newer);
  await other.close();
  expect(errors).toEqual([]);
});

/* Put back after someone's link, then Back to the link's page: that is the link replacing
   your layout again, not a page of your own. It says so, sets your layout aside again,
   and the link's settings stay the link's. */
test('Back to a link after Put back is still that link', async ({ page }) => {
  const errors = await openPlates(page);
  const key = (t, slot = '') => `drawerforge:${t}:v1${slot}`;
  const read = (k) => page.evaluate((k) => localStorage.getItem(k), k);
  const linkAgain = async () => {
    await expect(page.locator('#setAside')).toBeVisible();
    await expect(page.locator('#setAsideMsg')).toHaveText('This link replaced the layout you had here.');
    await expect(page.locator('#putBack')).toBeVisible();
  };

  await page.selectOption('#connector', 'snap');
  await settle(page);
  const mine = await read(key('plates'));
  await page.goto('about:blank');
  await openPlates(page, '#w=520&d=410&cn=hclip&v=2');
  await linkAgain();
  await settle(page);
  await Promise.all([page.waitForEvent('load'), page.click('#putBack')]);
  await platesReady(page);
  expect(await page.inputValue('#connector')).toBe('snap');
  await settle(page);
  await page.goBack();
  await expect.poll(() => page.inputValue('#connector').catch(() => ''),
    { message: 'Back shows the link', timeout: 20000 }).toBe('hclip');
  await platesReady(page);
  await linkAgain();
  expect(await read(key('plates', ':prev'))).toBe(mine);
  expect(await read(key('plates', ':linked')), 'the link is still a link').toContain('cn=hclip');

  // the bins page
  await page.goto('about:blank');
  await page.goto(base + 'bins/');
  await binsReady(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const mineBins = await read(key('bins'));
  await page.goto('about:blank');
  await page.goto(base + 'bins/#w=500&d=400&bl=0-0-2-2-3_3-0-2-2-3&v=2');
  await binsReady(page);
  await linkAgain();
  await settle(page);
  await Promise.all([page.waitForEvent('load'), page.click('#putBack')]);
  await binsReady(page);
  expect(await binCount(page)).toBe(1);
  await settle(page);
  await page.goBack();
  await expect.poll(() => binCount(page).catch(() => -1),
    { message: 'Back shows the link', timeout: 20000 }).toBe(2);
  await binsReady(page);
  await linkAgain();
  expect(await read(key('bins', ':prev'))).toBe(mineBins);
  expect(await read(key('bins', ':linked')), 'the link is still a link').toContain('bl=');
  expect(errors).toEqual([]);
});

/* A page you went Back to carries the other tool's settings as they were when it was
   written, before you changed them over there. Taking it to the other page by the header
   link brings that page up as the drawer has it, not with those older settings: they
   were saved into the drawer in place of yours, and the bins were gone. Both ways. */
test('Back, then the header link, brings the other page up as the drawer has it', async ({ page }) => {
  const errors = await openPlates(page);
  await page.selectOption('#connector', 'snap');
  await settle(page);
  await saveAs(page, 'Kitchen');
  await settle(page);
  await toBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.setField(page, 'gap', '6');
  await expect.poll(() => stored(page).then((s) => s.Kitchen.bgap),
    { message: 'the bins saved into the drawer', timeout: 20000 }).toBe('6');
  const bins = (await stored(page)).Kitchen.bl;

  await page.goBack();
  await platesReady(page);
  await toBins(page);
  await expect.poll(() => binCount(page).catch(() => -1),
    { message: 'the bin placed before going Back', timeout: 20000 }).toBe(1);
  await binsReady(page);
  expect(await page.inputValue('#gap')).toBe('6');
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await expect(page.locator('#setAside')).toBeHidden();
  await settle(page);
  expect((await stored(page)).Kitchen, 'and the drawer keeps them').toMatchObject({ bl: bins, bgap: '6' });

  // the other way: a bins page you went Back to, taken to the baseplates page
  await toPlates(page);
  await page.selectOption('#connector', 'hclip');
  await expect.poll(() => stored(page).then((s) => s.Kitchen.cn),
    { message: 'the connector saved into the drawer', timeout: 20000 }).toBe('hclip');
  await page.goBack();
  await binsReady(page);
  await toPlates(page);
  await expect.poll(() => page.inputValue('#connector').catch(() => ''),
    { message: 'the connector set before going Back', timeout: 20000 }).toBe('hclip');
  await platesReady(page);
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await expect(page.locator('#setAside')).toBeHidden();
  await settle(page);
  expect((await stored(page)).Kitchen, 'and the drawer keeps it').toMatchObject({ cn: 'hclip', bl: bins });
  expect(errors).toEqual([]);
});

/* With the browser's storage full, a change reaches the drawer nowhere: the page's
   address holds it. Reloaded, gone Back to, or carried to the other page and back by the
   header links, the page came up with the drawer's older half instead, and the change
   was gone. The junk fills storage to the last byte, so a save that grows the drawer is
   refused. */
const fillStorage = (page) => page.evaluate(() => {
  let i = 0;
  for (let size = 1 << 20; size >= 1; size >>= 1) {
    const s = 'x'.repeat(size);
    for (;;) { try { localStorage.setItem('junk' + i++, s); } catch (err) { break; } }
  }
});
/* Kitchen saved on `tool`, storage filled, and then a change that would grow the drawer,
   so the browser refuses it: the address is the one copy of it. */
async function changeWithStorageFull(page, tool) {
  const errors = await openPlates(page);
  if (tool === 'bins') { await toBins(page); await H.dragCells(page, [0, 0], [1, 1]); }
  await settle(page);
  await saveAs(page, 'Kitchen');
  await settle(page);
  await fillStorage(page);
  if (tool === 'bins') await H.dragCells(page, [2, 0], [3, 1]);
  else await page.selectOption('#connector', 'puzzlekey');
  await expect(page.locator('#drawerName')).toHaveText('not saving · Kitchen');
  return errors;
}
/* The change is on screen, and the page's first save after it landed, past any reload,
   was refused: the change is still too big for the storage. */
async function stillThere(page, tool, how) {
  await expect(page.locator('#drawerName'), `${how}: the change, refused again`)
    .toHaveText('not saving · Kitchen');
  if (tool === 'bins') expect(await binCount(page), how).toBe(2);
  else expect(await page.inputValue('#connector'), how).toBe('puzzlekey');
  await expect(page.locator('#setAside'), how).toBeHidden();
}
for (const tool of ['bins', 'plates']) {
  const ready = tool === 'bins' ? binsReady : platesReady;
  test(`with storage full, a change on ${tool} is still there after the trip to the other page`,
    async ({ page }) => {
      const errors = await changeWithStorageFull(page, tool);
      if (tool === 'bins') { await toPlates(page); await toBins(page); }
      else { await toBins(page); await toPlates(page); }
      await stillThere(page, tool, 'there and back');
      // the drawer was not told the page has a half it could not save, so this is no Back
      await page.reload();
      await ready(page);
      await stillThere(page, tool, 'there and back, then reload');
      expect(errors).toEqual([]);
    });
  test(`with storage full, a change on ${tool} is still there after a reload`, async ({ page }) => {
    const errors = await changeWithStorageFull(page, tool);
    await page.reload();
    await ready(page);
    await stillThere(page, tool, 'reload');
    expect(errors).toEqual([]);
  });
  test(`with storage full, a change on ${tool} is still there after going Back to it`, async ({ page }) => {
    const errors = await changeWithStorageFull(page, tool);
    if (tool === 'bins') await toPlates(page); else await toBins(page);
    await page.goBack();
    await ready(page);
    await stillThere(page, tool, 'Back');
    expect(errors).toEqual([]);
  });
  test(`with storage full, a change on ${tool} is still there when Back brings it from the cache`,
    async ({ page }) => {
      const errors = await changeWithStorageFull(page, tool);
      // the back-forward cache shows the page again without loading it
      const stayed = await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        return !!(history.state && history.state.drawerforge);   // reopening clears it to reload
      });
      expect(stayed, 'the page stays as it is').toBe(true);
      await stillThere(page, tool, 'Back from the cache');
      expect(errors).toEqual([]);
    });
}

/* Two tabs of one tool on one drawer. The first changes a setting, and the second puts
   it back, so the drawer holds the very save the first tab had before its change. A
   reload of the first tab, or its page coming back from the back-forward cache, still
   finds the drawer moved on, and comes up as the drawer has it. The address's mark used
   to name the save before its own, so the reload took the drawer as not moved on, kept
   its change, and its first save wrote it back over the other tab's. */
for (const tool of ['bins', 'plates']) {
  const ready = tool === 'bins' ? binsReady : platesReady;
  const [field, key, older, newer] = tool === 'bins' ? ['gap', 'bgap', '6', '7']
    : ['connector', 'cn', 'dovetail', 'hclip'];
  const set = (p, v) => (tool === 'bins' ? H.setField(p, field, v) : p.selectOption('#' + field, v));
  for (const cache of [false, true]) {
    test(`a ${tool} tab ${cache ? 'shown again from the back-forward cache' : 'reloaded'} after ` +
      'another tab put the drawer back to an earlier save', async ({ page, context }) => {
      const errors = await openPlates(page);
      if (tool === 'bins') await toBins(page);
      await set(page, older);
      await settle(page);
      await saveAs(page, 'Kitchen');
      await set(page, newer);
      await expect.poll(() => stored(page).then((s) => s.Kitchen[key]),
        { message: 'the first tab\'s change saved', timeout: 20000 }).toBe(newer);

      const other = await context.newPage();
      other.on('pageerror', (e) => errors.push(String(e)));
      await other.goto(base + (tool === 'bins' ? 'bins/' : ''));
      await ready(other);
      await expect(other.locator('#drawerName')).toHaveText('Kitchen');
      await set(other, older);
      await expect.poll(() => stored(other).then((s) => s.Kitchen[key]),
        { message: 'the second tab put it back', timeout: 20000 }).toBe(older);

      if (cache) {
        await Promise.all([page.waitForEvent('load'), page.evaluate(() =>
          dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))]);
      } else await page.reload();
      await expect.poll(() => page.inputValue('#' + field).catch(() => ''),
        { message: 'the drawer as the other tab left it', timeout: 20000 }).toBe(older);
      await ready(page);
      await expect(page.locator('#drawerName')).toHaveText('Kitchen');
      await expect(page.locator('#setAside')).toBeHidden();
      await settle(page);
      expect((await stored(page)).Kitchen[key], 'and the drawer keeps it').toBe(older);
      expect(errors).toEqual([]);
    });
  }
}

/* Two tabs of one tool on one drawer, and the second changes a setting. The first,
   still showing the drawer as it was and with no change of its own, goes to the other
   page and back. Leaving, it saved its older half over the second tab's change, and
   then the second tab's reload, or its page from the back-forward cache, came up on that
   older half: the change was gone everywhere. A page with nothing new writes nothing
   back, and the first tab comes back with the drawer as the second left it. */
for (const tool of ['bins', 'plates']) {
  const ready = tool === 'bins' ? binsReady : platesReady;
  const [field, key, older, newer] = tool === 'bins' ? ['gap', 'bgap', '6', '7']
    : ['connector', 'cn', 'dovetail', 'hclip'];
  const set = (p, v) => (tool === 'bins' ? H.setField(p, field, v) : p.selectOption('#' + field, v));
  for (const cache of [false, true]) {
    test(`a ${tool} tab with nothing new going to the other page keeps another tab's change` +
      (cache ? ', from the back-forward cache' : ''), async ({ page, context }) => {
      const errors = await openPlates(page);
      if (tool === 'bins') await toBins(page);
      await set(page, older);
      await settle(page);
      await saveAs(page, 'Kitchen');
      await settle(page);

      const other = await context.newPage();
      other.on('pageerror', (e) => errors.push(String(e)));
      await other.goto(base + (tool === 'bins' ? 'bins/' : ''));
      await ready(other);
      await expect(other.locator('#drawerName')).toHaveText('Kitchen');
      await set(other, newer);
      await expect.poll(() => stored(other).then((s) => s.Kitchen[key]),
        { message: 'the second tab\'s change saved', timeout: 20000 }).toBe(newer);

      // the first tab still shows the older value, and goes across and back
      expect(await page.inputValue('#' + field)).toBe(older);
      if (tool === 'bins') { await toPlates(page); await toBins(page); }
      else { await toBins(page); await toPlates(page); }
      await expect.poll(() => page.inputValue('#' + field).catch(() => ''),
        { message: 'the first tab comes back with the drawer as it is', timeout: 20000 }).toBe(newer);
      await ready(page);
      await settle(page);
      expect((await stored(page)).Kitchen[key], 'the drawer keeps the change').toBe(newer);

      if (cache) {
        await other.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      } else await other.reload();
      await expect.poll(() => other.inputValue('#' + field).catch(() => ''),
        { message: 'the second tab still has its change', timeout: 20000 }).toBe(newer);
      await ready(other);
      await expect(other.locator('#drawerName')).toHaveText('Kitchen');
      await settle(other);
      expect((await stored(other)).Kitchen[key], 'and so does the drawer').toBe(newer);
      expect(errors).toEqual([]);
    });
  }
}

test('export, clear the browser, import: the same design comes back', async ({ page }) => {
  const errors = await openPlates(page);
  await H.setField(page, 'drawerW', '412');
  await page.selectOption('#connector', 'hclip');
  await page.locator('#splitSeg button[data-v="staggered"]').click();
  await saveAs(page, 'Workbench');
  await toBins(page);
  await H.dragCells(page, [0, 0], [2, 1]);
  await settle(page);
  const binsDesign = await design(page);
  await toPlates(page);
  await settle(page);
  const platesDesign = await design(page);
  expect(platesDesign, 'the bins half rides along in the baseplates design').toContain('bl=');

  await openDialog(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#drawersExport')]);
  expect(dl.suggestedFilename()).toBe('drawerforge-workbench.json');
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const file = JSON.parse(text);
  expect(file).toMatchObject({ drawerforge: 'drawerforge-drawers', version: 1 });
  expect(file.drawers.map((d) => d.name)).toEqual(['Workbench']);
  expect(file.drawers[0].design, 'readable settings, not a link string').toMatchObject(
    { w: '412', cn: 'hclip', sp: 'staggered' });
  expect(text.length, 'a small file').toBeLessThan(20000);

  // a different device, as far as this page can tell
  await page.evaluate(() => localStorage.clear());
  await page.goto('about:blank');
  await openPlates(page);
  expect(await page.inputValue('#drawerW')).toBe('306');
  await openDialog(page);
  expect(await listed(page)).toEqual([]);

  await page.setInputFiles('#drawersImport',
    { name: 'workbench.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.locator('#drawersMsg')).toContainText('Added “Workbench”');
  await expect(page.locator('#drawersMsg')).toHaveClass(/ok/);
  expect(await listed(page)).toEqual(['Workbench']);
  // an import adds to the list; it does not replace what is on screen by itself
  expect(await page.inputValue('#drawerW')).toBe('306');
  await closeDialog(page);

  await openDrawer(page, 'Workbench', platesReady);
  expect(await design(page), 'the baseplates design, byte for byte').toBe(platesDesign);
  await toBins(page);
  expect(await design(page), 'and the bins design, byte for byte').toBe(binsDesign);
  expect(errors).toEqual([]);
});

test('every drawer in one file, and importing it twice keeps both copies apart', async ({ page }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Drawer 10');
  await saveAs(page, 'Drawer 2');
  await H.setField(page, 'drawerW', '350');     // into Drawer 2, the one now open
  await settle(page);

  await openDialog(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#drawersExportAll')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const file = JSON.parse(text);
  expect(file.drawers.map((d) => d.name), 'in the order the list shows them').toEqual(['Drawer 2', 'Drawer 10']);
  expect(file.drawers.map((d) => d.design.w)).toEqual(['350', '306']);

  await page.evaluate(() => localStorage.clear());
  await page.goto('about:blank');
  await openPlates(page);
  await openDialog(page);
  const load = () => page.setInputFiles('#drawersImport',
    { name: 'all.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await load();
  await expect(page.locator('#drawersMsg')).toContainText('Added 2 drawers');
  expect(await listed(page)).toEqual(['Drawer 2', 'Drawer 10']);
  // the same file again: nothing is overwritten, and the copies are named apart
  await load();
  await expect(page.locator('#drawersMsg')).toContainText('“Drawer 2 (2)”');
  expect(await listed(page)).toEqual(['Drawer 2', 'Drawer 2 (2)', 'Drawer 10', 'Drawer 10 (2)']);
  expect(errors).toEqual([]);
});

/* The bins page used to take a drawer width of 0, so a drawer could be saved that the
   importer refuses. Written into "every drawer", it made the whole file refuse to import.
   The page holds a typed 0 to its 1 mm floor now, so the drawer is stored here as the
   older page saved it. */
test('a drawer that would not import is left out of an export, and does not spoil a file',
  async ({ page }) => {
    const errors = await openPlates(page);
    await saveAs(page, 'Good');
    await toBins(page);
    await saveAs(page, 'Zero');
    await H.setField(page, 'drawerW', '0');
    await settle(page);
    expect((await stored(page)).Zero.w).toBe('1');
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('drawerforge:drawers:v1'));
      const d = s.drawers.find((x) => x.name === 'Zero');
      d.hash = d.hash.replace(/(^|&)w=[^&]*/, '$1w=0');
      localStorage.setItem('drawerforge:drawers:v1', JSON.stringify(s));
    });
    expect((await stored(page)).Zero.w).toBe('0');

    await openDialog(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#drawersExportAll')]);
    const file = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    expect(file.drawers.map((d) => d.name)).toEqual(['Good']);
    await expect(page.locator('#drawersMsg')).toHaveClass(/bad/);
    await expect(page.locator('#drawersMsg')).toContainText('“Zero” has no drawer width');

    // on its own, the open drawer is not exported at all, and the message says why
    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.evaluate(() => { document.getElementById('drawersMsg').textContent = ''; });
    await page.click('#drawersExport');
    await expect(page.locator('#drawersMsg')).toContainText('“Zero” has no drawer width');
    await page.waitForTimeout(300);
    expect(downloaded).toBe(false);

    // a file with a bad drawer in the middle, as an older export could have written
    const text = JSON.stringify({ drawerforge: 'drawerforge-drawers', version: 1, drawers: [
      { name: 'Shelf', design: { w: '300', d: '200' } },
      { name: 'Broken', design: { w: '0', d: '380' } },
      { name: 'Rack', design: { w: '250', d: '250' } }] });
    await page.setInputFiles('#drawersImport',
      { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.locator('#drawersMsg')).toContainText('Added 2 drawers: “Shelf”, “Rack”');
    await expect(page.locator('#drawersMsg')).toContainText('“Broken” (drawer 2 in that file)');
    expect(await listed(page)).toEqual(['Good', 'Rack', 'Shelf', 'Zero']);
    expect(errors).toEqual([]);
  });

/* The file is untrusted input. Each of these is refused with a message, and the proof
   that "changes nothing" is that the stored list and the design on screen are the same
   strings afterwards as before. */
test('a malformed design file is refused with a message and changes nothing', async ({ page }) => {
  const errors = await openPlates(page);
  await H.setField(page, 'drawerW', '420');
  await saveAs(page, 'Shed');
  await settle(page);
  const stored = () => page.evaluate(() => localStorage.getItem('drawerforge:drawers:v1'));
  const before = { store: await stored(), design: await design(page) };

  const ok = { drawerforge: 'drawerforge-drawers', version: 1 };
  const one = (d) => JSON.stringify(Object.assign({}, ok, { drawers: [d] }));
  const BAD = [
    ['not JSON', '{ "drawerforge": "drawerforge-drawers", '],
    ['some other JSON', JSON.stringify({ name: 'Shed', w: 400 })],
    ['a newer version', JSON.stringify(Object.assign({}, ok, { version: 7, drawers: [] }))],
    ['no drawers', JSON.stringify(Object.assign({}, ok, { drawers: [] }))],
    ['no name', one({ design: { w: '300', d: '300' } })],
    ['no size', one({ name: 'Box', design: { cn: 'hclip' } })],
    ['a key that is not a setting', '{"drawerforge":"drawerforge-drawers","version":1,' +
      '"drawers":[{"name":"Box","design":{"w":"300","d":"300","__proto__":{"x":1}}}]}'],
    ['a value that is not a value', one({ name: 'Box', design: { w: '300', d: '300', bl: { x: 1 } } })],
    ['a value far too long', one({ name: 'Box', design: { w: '300', d: '300', bl: 'x'.repeat(300000) } })],
    ['bin notes that are not notes', one({ name: 'Box', design: { w: '300', d: '300', bnotes: '[[1]]' } })],
  ];
  await openDialog(page);
  for (const [what, body] of BAD) {
    await page.setInputFiles('#drawersImport',
      { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(body) });
    await expect(page.locator('#drawersMsg'), what).toHaveClass(/bad/);
    await expect(page.locator('#drawersMsg'), what).not.toBeEmpty();
    expect(await stored(), `${what}: the stored drawers are untouched`).toBe(before.store);
    expect(await listed(page), what).toEqual(['Shed']);
    // reset the message so the next case cannot pass on this one's
    await page.evaluate(() => { const m = document.getElementById('drawersMsg'); m.className = ''; m.textContent = ''; });
  }
  // a file too big to be a design file is refused before it is even read
  await page.setInputFiles('#drawersImport',
    { name: 'huge.json', mimeType: 'application/json', buffer: Buffer.alloc(6 * 1024 * 1024, 32) });
  await expect(page.locator('#drawersMsg')).toHaveClass(/bad/);
  await expect(page.locator('#drawersMsg')).toContainText('larger than a design file');
  expect(await stored()).toBe(before.store);
  expect(await design(page)).toBe(before.design);
  await expect(page.locator('#drawerName')).toHaveText('Shed');

  /* And a well-formed file is still data, not markup: a name that is HTML is shown as the
     characters it is, and nothing in it runs. */
  const sneaky = '<img src=x onerror="window.__ran=1">';
  await page.setInputFiles('#drawersImport', { name: 'ok.json', mimeType: 'application/json',
    buffer: Buffer.from(one({ name: sneaky, design: { w: '300', d: '200' } })) });
  await expect(page.locator('#drawersMsg')).toHaveClass(/ok/);
  expect((await listed(page)).sort()).toEqual(['Shed', sneaky].sort());
  expect(await page.locator('#drawersDlg img').count()).toBe(0);
  expect(await page.evaluate(() => window.__ran)).toBeUndefined();
  expect(errors).toEqual([]);
});

/* A bin's note is text someone typed, and the bins page lists it in a table it builds as
   markup. From a design file, or a link, a note with markup in it is shown as the
   characters it is. */
test('a bin note from a design file is shown on the bins page as the text it is', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + 'bins/');
  await binsReady(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  const note = '<img src=x onerror=__r=1>';
  const settings = await page.evaluate((note) => {
    const o = descriptor();
    o.bnotes = JSON.stringify([[note]]);
    return Object.fromEntries(DRAWERS.parsePairs(encodeDesc(o)));
  }, note);
  const file = JSON.stringify({ drawerforge: 'drawerforge-drawers', version: 1,
                                drawers: [{ name: 'Noted', design: settings }] });

  await openDialog(page);
  await page.setInputFiles('#drawersImport',
    { name: 'noted.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.locator('#drawersMsg')).toHaveClass(/ok/);
  // the bin drawn above is not saved, so opening asks first
  await page.getByRole('button', { name: 'Open Noted', exact: true }).click();
  await Promise.all([page.waitForEvent('load'),
    page.getByRole('button', { name: 'Open anyway: Noted', exact: true }).click()]);
  await binsReady(page);
  await expect(page.locator('#drawerName')).toHaveText('Noted');
  await expect(page.locator('#typeRows .tnote')).toHaveText(note);
  expect(await page.locator('#typeRows img').count()).toBe(0);
  expect(await page.evaluate(() => typeof __r)).toBe('undefined');
  expect(errors).toEqual([]);
});

/* A note in the link that is not a note at all used to stop the map's labels drawing. */
test('bin notes in a link that are not notes are left out, and the page still draws', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + 'bins/');
  await binsReady(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  const hash = await page.evaluate(() => { const o = descriptor(); o.bnotes = '[[1]]'; return encodeDesc(o); });
  await page.goto('about:blank');
  await page.goto(base + 'bins/#' + hash);
  await binsReady(page);
  expect(await binCount(page)).toBe(1);
  expect(await page.evaluate(() => B()[0].note || '')).toBe('');
  expect(errors).toEqual([]);
});

/* Which drawer a page saves into is decided by whether this browser wrote the design it
   arrived with. "Whichever was open last" would save a shared link from someone else into
   your drawer, and Start fresh would overwrite it with the defaults. */
test('a shared link or a fresh start never writes over the drawer you had open', async ({ page }) => {
  const errors = await openPlates(page);
  await H.setField(page, 'drawerW', '400');
  await saveAs(page, 'Kitchen');
  await settle(page);

  // someone else's link: shown, but not saved into Kitchen
  await page.goto('about:blank');
  await openPlates(page, '#w=333&d=444&v=2');
  await expect(page.locator('#drawerName')).toHaveText('not saved');
  expect(await page.inputValue('#drawerW')).toBe('333');
  await H.setField(page, 'drawerD', '450');
  await settle(page);

  // a reload of that link stays unsaved too, rather than finding its way into Kitchen
  await page.reload();
  await platesReady(page);
  await expect(page.locator('#drawerName')).toHaveText('not saved');

  // opening Kitchen over an unsaved design takes two presses, and says why
  await openDialog(page);
  await page.getByRole('button', { name: 'Open Kitchen', exact: true }).click();
  await expect(page.locator('#drawersMsg')).toContainText('replaces it');
  expect(await page.inputValue('#drawerW'), 'the first press only warns').toBe('333');
  await Promise.all([page.waitForEvent('load'),
    page.getByRole('button', { name: 'Open anyway: Kitchen', exact: true }).click()]);
  await platesReady(page);
  expect(await page.inputValue('#drawerW'), 'Kitchen is as it was saved').toBe('400');
  expect(await page.inputValue('#drawerD')).toBe('380');
  await settle(page);

  /* The bare site restores this browser's last layout, which is Kitchen's, so it is still
     Kitchen — and Start fresh from there leaves Kitchen alone. */
  await page.goto('about:blank');
  await openPlates(page);
  await expect(page.locator('#restored')).toBeVisible();
  await expect(page.locator('#drawerName')).toHaveText('Kitchen');
  await Promise.all([page.waitForEvent('load'), page.click('#startFresh')]);
  await platesReady(page);
  await expect(page.locator('#drawerName')).toHaveText('not saved');
  await settle(page);                           // the fresh page has saved its defaults
  await openDrawer(page, 'Kitchen', platesReady);
  expect(await page.inputValue('#drawerW')).toBe('400');
  expect(errors).toEqual([]);
});

/* Two drawers can hold one design, and so share a fingerprint: a backup saved from the
   drawer on screen, or a row of placeholders saved straight from the defaults. Opening
   one used to attach the page to whichever of them was saved last, so the next edit went
   into the other. */
test('opening a drawer saves into that drawer, even when another holds the same design',
  async ({ page }) => {
    const errors = await openPlates(page);
    await H.setField(page, 'drawerW', '400');
    await saveAs(page, 'Kitchen');
    await saveAs(page, 'Kitchen backup');       // the same design, and saved last
    await settle(page);
    await openDrawer(page, 'Kitchen', platesReady);
    await H.setField(page, 'drawerW', '450');
    await settle(page);
    let all = await stored(page);
    expect([all.Kitchen.w, all['Kitchen backup'].w], 'the edit went into Kitchen').toEqual(['450', '400']);
    await page.reload();
    await platesReady(page);
    await expect(page.locator('#drawerName'), 'and a reload stays on it').toHaveText('Kitchen');

    // placeholders: three drawers saved from the defaults, before any of them is measured
    await page.evaluate(() => localStorage.clear());
    await page.goto('about:blank');
    await openPlates(page);
    for (const n of ['Drawer 1', 'Drawer 2', 'Drawer 3']) await saveAs(page, n);
    await settle(page);
    await openDrawer(page, 'Drawer 1', platesReady);
    await H.setField(page, 'drawerD', '420');
    await settle(page);
    all = await stored(page);
    expect([1, 2, 3].map((n) => all[`Drawer ${n}`].d)).toEqual(['420', '380', '380']);

    /* A fresh start shows the defaults, which are exactly what Drawers 2 and 3 hold. It is
       still not a drawer, and a reload of it does not quietly become one. */
    await page.goto('about:blank');
    await openPlates(page);
    await Promise.all([page.waitForEvent('load'), page.click('#startFresh')]);
    await platesReady(page);
    await settle(page);
    await page.reload();
    await platesReady(page);
    await expect(page.locator('#drawerName')).toHaveText('not saved');
    await H.setField(page, 'drawerW', '500');
    await settle(page);
    all = await stored(page);
    expect([1, 2, 3].map((n) => all[`Drawer ${n}`].w), 'no placeholder took the edit')
      .toEqual(['306', '306', '306']);
    expect(errors).toEqual([]);
  });

/* The dialog says changes save into the open drawer as you work, so a save the browser
   refuses (a full quota, say) is said on the bar and in the dialog, not swallowed. */
test('a save into the open drawer that the browser refuses is said, until one goes through',
  async ({ page }) => {
    const errors = await openPlates(page);
    await saveAs(page, 'Kitchen');
    await page.evaluate(() => {
      const real = Storage.prototype.setItem;
      window.__realSetItem = real;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'drawerforge:drawers:v1') throw new DOMException('full', 'QuotaExceededError');
        return real.call(this, k, v);
      };
    });
    await H.setField(page, 'drawerD', '390');
    await settle(page);
    await expect(page.locator('#drawerName')).toHaveText('not saving · Kitchen');
    await expect(page.locator('#drawersBtn')).toHaveAttribute('aria-label', /could not be saved/);
    await openDialog(page);
    await expect(page.locator('#drawersNow')).toContainText('could not be saved into it');
    await closeDialog(page);

    await page.evaluate(() => { Storage.prototype.setItem = window.__realSetItem; });
    await H.setField(page, 'drawerD', '395');
    await settle(page);
    await expect(page.locator('#drawerName')).toHaveText('Kitchen');
    expect((await stored(page)).Kitchen.d).toBe('395');
    expect(errors).toEqual([]);
  });

test('rename and delete, each from the list', async ({ page }) => {
  const errors = await openPlates(page);
  await saveAs(page, 'Top');
  await H.setField(page, 'drawerW', '360');
  await saveAs(page, 'Bottom');

  await openDialog(page);
  await page.getByRole('button', { name: 'Rename Top', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'New name for Top' })).toBeFocused();
  // a name already in use is refused rather than making two drawers nobody can tell apart
  await page.keyboard.press('Control+a');
  await page.keyboard.type('bottom');
  await page.keyboard.press('Enter');
  await expect(page.locator('#drawersMsg')).toContainText('already have a drawer');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Top drawer');
  await page.keyboard.press('Enter');
  expect(await listed(page)).toEqual(['Bottom', 'Top drawer']);
  // Escape abandons a rename without closing the dialog
  await page.getByRole('button', { name: 'Rename Bottom', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  expect(await listed(page)).toEqual(['Bottom', 'Top drawer']);

  // delete takes two presses; deleting the open drawer leaves its design on screen, unsaved
  await page.getByRole('button', { name: 'Delete Bottom', exact: true }).click();
  expect(await listed(page), 'the first press only asks').toEqual(['Bottom', 'Top drawer']);
  await page.getByRole('button', { name: 'Really delete? Bottom', exact: true }).click();
  expect(await listed(page)).toEqual(['Top drawer']);
  await expect(page.locator('#drawerName')).toHaveText('not saved');
  expect(await page.inputValue('#drawerW')).toBe('360');

  await page.reload();
  await platesReady(page);
  await openDialog(page);
  expect(await listed(page)).toEqual(['Top drawer']);
  expect(errors).toEqual([]);
});
