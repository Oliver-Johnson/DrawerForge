/* Links and saves that are wrong, by accident or on purpose.
 *
 * A link is text in an address bar: it gets hand-edited, cut short by a chat client,
 * and written by people who want to see what happens. Both tools also save the same
 * string to this browser and read it back on every bare visit, so a link that broke
 * the page once used to break it on every visit after, with the Start fresh button
 * that would have rescued it wired too late to work.
 *
 * A link is followed through about:blank, so it is a real load of the page rather
 * than a same-document hash change, and each case reads what the page believes (its
 * own state, its own save) rather than what the DOM happens to show.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(900);   // past the 400 ms save debounce
const PLATES = 'drawerforge:plates:v1';
const BINS = 'drawerforge:bins:v1';

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}
async function ready(page) {
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
}
async function arrive(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
  await ready(page);
}
// a button that navigates: wait for the new page rather than for a duration
async function clickAndLoad(page, sel) {
  await Promise.all([page.waitForEvent('load'), page.click(sel)]);
  await ready(page);
}
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const binsIn = (page) => page.evaluate(() => layers.map((L) => L.bins.length).reduce((a, b) => a + b, 0));

/* ---------- baseplates ------------------------------------------------------ */

test('a stray % in a setting name does not break every later visit', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, H.PLATES_URL + '#w=420&d=300&%25=1');
  expect(await page.inputValue('#drawerW')).toBe('420');
  // the setting is carried, encoded, so the save it lands in can be read back
  expect(await stored(page, PLATES)).toContain('%25=1');

  await arrive(page, H.PLATES_URL);              // the bare site, which reads the save
  expect(await page.inputValue('#drawerW')).toBe('420');
  expect(errors).toEqual([]);
});

test('a malformed escape loses that one setting, not the page', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, H.PLATES_URL + '#w=%E0%A4%A&d=300');
  expect(await page.inputValue('#drawerD')).toBe('300');
  expect(await page.inputValue('#drawerW')).toBe('306');
  expect(errors).toEqual([]);

  await arrive(page, H.BINS_URL + '#w=%E0%A4%A&bl=0-0-1-1-3');
  expect(await binsIn(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('a setting with no value is not written back as "undefined"', async ({ page }) => {
  await arrive(page, H.PLATES_URL + '#w=420&junk');
  expect(await page.inputValue('#drawerW')).toBe('420');
  expect(await page.evaluate(() => location.hash)).not.toContain('undefined');
  expect(await stored(page, PLATES)).not.toContain('undefined');
});

test('an unknown connector or split mode keeps the default', async ({ page }) => {
  await arrive(page, H.PLATES_URL + '#cn=bogus&sp=constructor');
  expect(await page.inputValue('#connector')).toBe('dovetail');
  expect(await page.evaluate(() => [state.connector, state.splitMode, splitName()]))
    .toEqual(['dovetail', 'balanced', 'balanced']);

  await arrive(page, H.PLATES_URL + '#sp=__proto__');
  expect(await page.evaluate(() => [state.splitMode, splitName()]))
    .toEqual(['balanced', 'balanced']);
});

test('manual cuts from a link are whole, distinct and few', async ({ page }) => {
  const cuts = () => page.evaluate(() => [state.rowCuts, state.colCuts]);
  // a repeated cut made a zero-height piece; a fractional one, a fractional piece
  await arrive(page, H.PLATES_URL + '#sp=manual&rc=2,2,2');
  expect((await cuts())[0]).toEqual([2]);
  await arrive(page, H.PLATES_URL + '#sp=manual&rc=1.5');
  expect((await cuts())[0]).toEqual([]);
  await arrive(page, H.PLATES_URL + '#sp=manual&rc=' + Array(300).fill(1).join(','));
  expect((await cuts())[0]).toEqual([1]);
  await arrive(page, H.PLATES_URL + '#sp=manual&cc=1.1.1.2.2');
  expect((await cuts())[1]).toEqual([[1, 2]]);
  // a grid big enough to hold them all: still no more cuts than pieces the tool builds
  const all = Array.from({ length: 399 }, (_, i) => i + 1).join(',');
  await arrive(page, H.PLATES_URL + `#w=2000&d=2000&pi=5&sp=manual&rc=${all}`);
  expect((await cuts())[0].length).toBeLessThanOrEqual(59);
});

test('a setting name carrying a line break cannot write into the README', async ({ page }) => {
  await arrive(page, H.PLATES_URL + '#w=420&x%0Ay=1');
  const link = await page.evaluate(() => shareLink());
  expect(link).toContain('x%0Ay=1');
  expect(link).not.toContain('\n');
});

test('following a link puts the layout it replaced aside, with a way back',
  async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'drawerW', '512');
    await settle(page);

    await arrive(page, H.PLATES_URL + '#w=333');
    expect(await page.inputValue('#drawerW')).toBe('333');   // the link still wins
    await expect(page.locator('#restored')).toBeHidden();
    await expect(page.locator('#setAside')).toBeVisible();
    expect(await stored(page, PLATES + ':prev')).toContain('w=512');

    await clickAndLoad(page, '#putBack');
    expect(await page.inputValue('#drawerW')).toBe('512');
  });

test('a save nobody has touched is not offered back', async ({ page }) => {
  await H.openPlates(page);
  await settle(page);                                  // the defaults are saved
  await arrive(page, H.PLATES_URL + '#w=333');
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, PLATES + ':prev')).toBeNull();

  await arrive(page, H.BINS_URL);
  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-3');
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, BINS + ':prev')).toBeNull();
});

/* The boot guard. A layout that hung or crashed the page leaves the marker the page
   writes before loading it; finding that marker for the same layout means the last
   attempt never finished, and loading it again would only do the same thing again. */
test('a link that did not finish loading last time is not loaded again', async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  expect(await stored(page, PLATES + ':loading'), 'a finished load clears its marker').toBeNull();
  await page.evaluate((k) => localStorage.setItem(k, 'w=333'), PLATES + ':loading');

  await arrive(page, H.PLATES_URL + '#w=333');
  expect(await page.inputValue('#drawerW')).toBe('306');   // the defaults, not the link
  await expect(page.locator('#setAside')).toBeVisible();
  await expect(page.locator('#setAside')).toContainText(/did not finish loading/);
  expect(await stored(page, PLATES + ':prev')).toContain('w=512');

  // the stand-in defaults were never saved over the drawer the page declined
  expect(await stored(page, PLATES)).toContain('w=512');

  await clickAndLoad(page, '#tryAnyway');
  expect(await page.inputValue('#drawerW')).toBe('333');
  expect(await stored(page, PLATES + ':loading')).toBeNull();
  // so the link that did load can still be undone
  await expect(page.locator('#putBack')).toBeVisible();
  await clickAndLoad(page, '#putBack');
  expect(await page.inputValue('#drawerW')).toBe('512');
});

test('a saved layout that did not finish loading is still declined after a reload',
  async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'drawerW', '512');
    await settle(page);
    const save = await stored(page, PLATES);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [PLATES + ':loading', save]);

    for (let visit = 0; visit < 2; visit++) {
      await arrive(page, H.PLATES_URL);
      expect(await page.inputValue('#drawerW')).toBe('306');
      await expect(page.locator('#setAside')).toContainText(/did not finish loading/);
      expect(await stored(page, PLATES), 'nothing saved over it').toBe(save);
    }
    // the first change is a choice to start again, so it is saved and the banner goes
    await H.setField(page, 'drawerW', '400');
    await settle(page);
    expect(await stored(page, PLATES)).toContain('w=400');
    await expect(page.locator('#setAside')).toBeHidden();
    expect(await stored(page, PLATES + ':prev')).toBe(save);
  });

test('a second link does not push your own layout out of the backup', async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  await arrive(page, H.PLATES_URL + '#w=333');
  await arrive(page, H.PLATES_URL + '#w=444');
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toContain('w=512');

  // putting it back sets the link's layout aside in its place, rather than losing it
  await clickAndLoad(page, '#putBack');
  expect(await page.inputValue('#drawerW')).toBe('512');
  expect(await stored(page, PLATES + ':prev')).toContain('w=444');
});

test('changing a linked layout takes the offer to put yours back away', async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  await arrive(page, H.PLATES_URL + '#w=333');
  await expect(page.locator('#setAside')).toBeVisible();
  await page.waitForTimeout(600);                      // the boot's own save is no edit
  await expect(page.locator('#setAside')).toBeVisible();
  await H.setField(page, 'drawerW', '340');
  await settle(page);
  await expect(page.locator('#setAside')).toBeHidden();
  // and that edited layout is yours now: the next link sets it aside
  await arrive(page, H.PLATES_URL + '#w=444');
  expect(await stored(page, PLATES + ':prev')).toContain('w=340');
});

test('the printer menu names the bed a link brings', async ({ page }) => {
  await arrive(page, H.PLATES_URL + '#bw=220&bd=220&bh=250');
  expect(await page.inputValue('#bedPreset')).toBe('220,220,250');
  await arrive(page, H.PLATES_URL + '#bw=200&bd=210&bh=220');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
  await H.setField(page, 'bedH', '230');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
  await page.selectOption('#bedPreset', '300,300,300');
  await H.setField(page, 'bedW', '299');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
});

test('the pages do not need Object.hasOwn', async ({ page }) => {
  const errors = watch(page);
  await page.addInitScript(() => { delete Object.hasOwn; });
  await arrive(page, H.PLATES_URL + '#sp=plates&w=500');
  expect(await page.evaluate(() => typeof Object.hasOwn)).toBe('undefined');
  expect(await page.evaluate(() => [state.splitMode, layout.pieces.length > 0])).toEqual(['plates', true]);
  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-3&bw=220');
  expect(await binsIn(page)).toBe(1);
  expect(await page.inputValue('#bedW')).toBe('220');
  expect(errors).toEqual([]);
});

/* ---------- bins ------------------------------------------------------------ */

test('a note that is not a string does not stop the bins page', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, H.BINS_URL + '#bl=0-0-2-2-3&bnotes=%5B%5B5%5D%5D');
  expect(await page.evaluate(() => B()[0].note)).toBe('5');
  expect(errors).toEqual([]);
});

test('notes from a link are one clean line of at most 28 characters', async ({ page }) => {
  const notes = encodeURIComponent(JSON.stringify([['one\ntwo\u0007three', '🙂'.repeat(40)]]));
  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-3_2-0-1-1-3&bnotes=' + notes);
  const [a, b] = await page.evaluate(() => B().map((x) => x.note));
  expect(a).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(a).toContain('one');
  expect(a).toContain('three');
  expect(b).toBe('🙂'.repeat(28));       // whole emoji, never half of one
});

test('a fractional position is rounded rather than thrown on', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, H.BINS_URL + '#bl=0-0.5-1-1-3');
  const all = await H.bins(page);
  expect(all).toHaveLength(1);
  expect(Number.isInteger(all[0].x) && Number.isInteger(all[0].y)).toBe(true);
  expect(errors).toEqual([]);
});

test('dividers and height from a link are capped', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-3-1.2-1.2-100000-2.5');
  const b = await page.evaluate(() => B()[0]);
  expect(b.divX).toBeLessThanOrEqual(31);
  expect(b.divY).toBe(Math.round(b.divY));

  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-1e308');
  expect(await page.evaluate(() => B()[0].hUnits)).toBeLessThan(1000);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('Infinity');
  expect(errors).toEqual([]);
});

test('a wall height the menu does not offer snaps to one it does', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-3-1.2-1.2-0-0-0-0.3');
  await H.clickCell(page, 0, 0);
  await settle(page);
  expect(await page.inputValue('#edgeF')).toBe('0.25');
  expect(await page.evaluate(() => B()[0].edges.f)).toBe(0.25);
  expect(errors).toEqual([]);
});

test('the bed, infill and gap come back after a reload', async ({ page }) => {
  await H.openBins(page);
  for (const [id, v] of [['bedW', 180], ['bedD', 180], ['bedH', 180], ['infill', 40], ['gap', 7]])
    await H.setField(page, id, v);
  await settle(page);
  await page.reload();
  await ready(page);
  for (const [id, v] of [['bedW', 180], ['bedD', 180], ['bedH', 180], ['infill', 40], ['gap', 7]])
    expect(await page.inputValue('#' + id), id).toBe(String(v));
});

test('the bed size baseplates sends is the one bins uses', async ({ page }) => {
  await arrive(page, H.BINS_URL + '#bw=180&bd=180&bh=150');
  expect(await page.evaluate(() => [state.bedW, state.bedD, state.bedH])).toEqual([180, 180, 150]);
});

test('bed, infill and gap survive a trip through baseplates and back', async ({ page }) => {
  await H.openBins(page);
  const want = [['bedW', '200'], ['bedD', '210'], ['bedH', '220'], ['infill', '35'], ['gap', '6']];
  for (const [id, v] of want) await H.setField(page, id, v);
  await settle(page);

  /* The hand-over links are relative to a directory ("../#…"), which over file:// opens
     a directory listing, so the test follows each page's own link onto the page. */
  const hashOf = (href) => href.slice(href.indexOf('#'));
  await arrive(page, H.PLATES_URL + hashOf(await page.evaluate(() => platesHref())));
  for (const [id, v] of want.slice(0, 4)) expect(await page.inputValue('#' + id), id).toBe(v);

  await arrive(page, H.BINS_URL + hashOf(await page.evaluate(() => binsHref())));
  for (const [id, v] of want) expect(await page.inputValue('#' + id), id).toBe(v);
  // the same layout come back, not a link that replaced it
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await page.inputValue('#bedPreset')).toBe('custom');
});

test('a drawer of no size, or an absurd one, in a link is not used', async ({ page }) => {
  await arrive(page, H.BINS_URL + '#w=-500&d=0');
  expect(await page.evaluate(() => [state.drawerW, state.drawerD])).toEqual([306, 380]);
  await arrive(page, H.BINS_URL + '#w=5000&d=380');
  expect(await page.evaluate(() => state.drawerW)).toBeLessThanOrEqual(2000);
});

test('a negative wall does not stop the bins page saving', async ({ page }) => {
  const errors = watch(page);
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'wall', '-0.5');
  await settle(page);
  await H.dragCells(page, [2, 2], [2, 2]);
  await settle(page);
  const save = await stored(page, BINS);
  const bl = decodeURIComponent(save.split('&').find((kv) => kv.startsWith('bl=')).slice(3));
  expect(bl.split('_')).toHaveLength(2);
  // and the buttons that build a link from the same string still work
  expect(await page.evaluate(() => [shareLink(), platesHref(), designLink()].every(Boolean))).toBe(true);
  expect(errors.filter((e) => /separator/.test(e))).toEqual([]);
});

test('following a link puts the bins it replaced aside, with a way back', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);

  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-3');
  expect(await binsIn(page)).toBe(1);
  await expect(page.locator('#setAside')).toBeVisible();

  await clickAndLoad(page, '#putBack');
  expect(await binsIn(page)).toBe(2);
});

test('a saved layout that did not finish loading last time is set aside', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const save = await stored(page, BINS);
  expect(await stored(page, BINS + ':loading')).toBeNull();
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [BINS + ':loading', save]);

  await arrive(page, H.BINS_URL);                       // a bare visit reads the save
  expect(await binsIn(page)).toBe(0);
  await expect(page.locator('#restored')).toBeHidden();
  await expect(page.locator('#setAside')).toContainText(/did not finish loading/);
  expect(await stored(page, BINS + ':prev')).toBe(save);

  await clickAndLoad(page, '#tryAnyway');
  expect(await binsIn(page)).toBe(1);
  expect(await stored(page, BINS + ':loading')).toBeNull();
});

/* The tools' own hand-over is not a link from someone. Comparing the save with the
   address as strings called every trip to baseplates and back a replaced layout,
   because each page writes the keys in its own order.
   The page's own button is clicked, so its own marking is what is tested. Over file://
   its relative link opens a directory listing, which keeps the address, so the test
   goes on from there to the page the link means. */
async function viaButton(page, sel, url) {
  await Promise.all([page.waitForEvent('load'), page.click(sel)]);
  const hash = await page.evaluate(() => location.hash);
  expect(hash.length, 'the button carried the layout').toBeGreaterThan(2);
  await page.goto(url + hash);
  await ready(page);
}
test('a trip to baseplates and back keeps the bins, with nothing offered back',
  async ({ page }) => {
    await H.openBins(page);
    await H.dragCells(page, [0, 0], [1, 1]);
    await H.dragCells(page, [3, 3], [3, 3]);
    await settle(page);

    await viaButton(page, '#navPlates', H.PLATES_URL);
    await expect(page.locator('#setAside')).toBeHidden();
    await H.setField(page, 'drawerW', '400');         // changed on the other page
    await settle(page);

    await viaButton(page, '#navBins', H.BINS_URL);
    expect(await binsIn(page)).toBe(2);
    expect(await page.inputValue('#drawerW')).toBe('400');
    await expect(page.locator('#setAside')).toBeHidden();
    expect(await stored(page, BINS + ':prev')).toBeNull();
  });

test('by way of the guide is a hand-over too', async ({ page }) => {
  await H.openPlates(page);
  await page.check('#magnets');                       // a baseplate layout of your own
  await settle(page);
  await viaButton(page, '#navBins', H.BINS_URL);
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'drawerW', '400');
  await settle(page);

  await viaButton(page, '#navGuide', H.PLATES_URL);
  expect(await page.inputValue('#drawerW')).toBe('400');
  expect(await page.isChecked('#magnets')).toBe(true);
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, PLATES + ':prev')).toBeNull();
});

test('a layout handed over onto an empty page is yours, not a link', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await viaButton(page, '#navPlates', H.PLATES_URL);  // baseplates had nothing saved
  const handed = await stored(page, PLATES);

  await arrive(page, H.PLATES_URL + '#w=333');
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toBe(handed);
});

test("someone's bins link carried to baseplates still keeps your drawer", async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  // their link was made after a trip through baseplates, so it carries its keys too
  const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333') +
    '&bl=0-0-1-1-3';
  await arrive(page, H.BINS_URL + '#' + theirs);

  await viaButton(page, '#navPlates', H.PLATES_URL);
  expect(await page.inputValue('#drawerW')).toBe('333');   // the link still wins
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toContain('w=512');
});

test("someone's bins link, edited, carried to baseplates still keeps your drawer",
  async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'drawerW', '512');
    await settle(page);
    // their baseplate settings are the same as yours; only their drawer differs
    const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333') +
      '&bl=0-0-1-1-3';
    await arrive(page, H.BINS_URL + '#' + theirs);
    await H.setField(page, 'gap', '6');               // changed, but still their drawer
    await settle(page);
    await arrive(page, H.BINS_URL);                   // and a reload does not make it yours

    await viaButton(page, '#navPlates', H.PLATES_URL);
    expect(await page.inputValue('#drawerW')).toBe('333');
    await expect(page.locator('#putBack')).toBeVisible();
    expect(await stored(page, PLATES + ':prev')).toContain('w=512');
  });

/* Each of a link's drawer, bed and infill settings is the link's while it is in use, key
   by key. Compared as one group, changing any one of them made the rest yours, and the
   trip brought them onto your baseplates with nothing set aside. */
async function theirBinsLink(page) {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  // made after a trip through baseplates, with the same baseplate settings as yours
  const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333') +
    '&bl=0-0-1-1-3';
  await arrive(page, H.BINS_URL + '#' + theirs);
}
for (const [id, value] of [['infill', '20'], ['bedH', '200'], ['drawerD', '300']]) {
  test(`someone's bins link with only #${id} changed still keeps your drawer`,
    async ({ page }) => {
      await theirBinsLink(page);
      await H.setField(page, id, value);
      await settle(page);

      await viaButton(page, '#navPlates', H.PLATES_URL);
      expect(await page.inputValue('#drawerW')).toBe('333');
      await expect(page.locator('#putBack')).toBeVisible();
      expect(await stored(page, PLATES + ':prev')).toContain('w=512');
    });
}

// whether a layout is a link's goes aside with it, and comes back with it
test("an edited link put back is still the link's", async ({ page }) => {
  await theirBinsLink(page);
  await H.setField(page, 'gap', '6');
  await settle(page);
  await arrive(page, H.BINS_URL + '#bl=2-2-1-1-3');   // sets the edited one aside
  await clickAndLoad(page, '#putBack');
  expect(await page.inputValue('#gap')).toBe('6');

  await viaButton(page, '#navPlates', H.PLATES_URL);
  expect(await page.inputValue('#drawerW')).toBe('333');
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toContain('w=512');
});

test("your own layout put back is not the link's, even in the same drawer",
  async ({ page }) => {
    await H.openPlates(page);
    await page.check('#magnets');
    await settle(page);
    await viaButton(page, '#navBins', H.BINS_URL);
    await H.dragCells(page, [0, 0], [0, 0]);
    await H.setField(page, 'drawerW', '400');
    await settle(page);
    const mine = await stored(page, BINS);
    await arrive(page, H.BINS_URL + '#' + mine.replace(/(^|&)bl=[^&]*/, '$1bl=2-2-1-1-3'));
    await clickAndLoad(page, '#putBack');
    expect(await binsIn(page)).toBe(1);

    await viaButton(page, '#navPlates', H.PLATES_URL);
    expect(await page.inputValue('#drawerW')).toBe('400');
    expect(await page.isChecked('#magnets')).toBe(true);
    await expect(page.locator('#setAside')).toBeHidden();
    expect(await stored(page, PLATES + ':prev')).toBeNull();
  });

/* The settings you changed are yours on the way back, while the ones still at the link's
   values are compared. Not marking the trip at all, because some were still the link's,
   called this a link replacing your bins and pushed your own out of the backup. */
test("someone's drawer changed on baseplates comes back to bins as yours", async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const mine = await stored(page, BINS);
  await arrive(page, H.BINS_URL + '#w=333&bl=0-0-1-1-3');
  await H.setField(page, 'gap', '6');
  await settle(page);
  await viaButton(page, '#navPlates', H.PLATES_URL);
  await H.setField(page, 'drawerW', '400');           // their bed and infill still in use
  await settle(page);

  await viaButton(page, '#navBins', H.BINS_URL);
  expect(await page.inputValue('#drawerW')).toBe('400');
  expect(await page.inputValue('#gap')).toBe('6');
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, BINS + ':prev')).toBe(mine);
});

/* A drawer you typed on someone's link is yours on the other page too, not the link's.
   Recorded there as the link's, a later trip that changed it was a link replacing your
   bins, and set your own original aside over the one the link had set aside. */
test("your own drawer on someone's link is not recorded as theirs", async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333')
    .replace(/(^|&)bw=[^&]*/, '$1bw=220').replace(/(^|&)bd=[^&]*/, '$1bd=220') + '&bl=0-0-1-1-3';
  expect(theirs).toContain('bw=220');
  await arrive(page, H.BINS_URL);
  await H.dragCells(page, [0, 0], [1, 1]);            // your own bins
  await settle(page);
  const mine = await stored(page, BINS);

  await arrive(page, H.BINS_URL + '#' + theirs);
  await H.setField(page, 'drawerW', '500');           // your drawer, their bed
  await H.setField(page, 'drawerD', '400');
  await settle(page);
  await viaButton(page, '#navPlates', H.PLATES_URL);
  await expect(page.locator('#putBack')).toBeVisible();

  await arrive(page, H.BINS_URL);
  await H.setField(page, 'drawerW', '600');
  await settle(page);
  await arrive(page, H.PLATES_URL);
  await viaButton(page, '#navBins', H.BINS_URL);
  expect(await page.inputValue('#drawerW')).toBe('500');
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, BINS + ':prev')).toBe(mine);
});

/* And that link, with your drawer in it, is still the link's untouched layout: compared
   on everything, the drawer left out of its record made it "changed", and a second link
   set it aside over your own layout, which Put back no longer offered. */
for (const reload of [false, true]) {
  test('a second link after one with your own drawer keeps yours' +
    (reload ? ', after a reload' : ''), async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'drawerW', '600');
    await H.setField(page, 'drawerD', '400');
    await H.setField(page, 'bedW', '220');
    await page.selectOption('#connector', 'snap');
    await settle(page);
    const mine = await stored(page, PLATES);

    await arrive(page, H.BINS_URL + '#w=333&d=333&bw=250&bd=250&bl=0-0-1-1-3');
    await H.setField(page, 'drawerW', '520');         // your drawer, their bed
    await H.setField(page, 'drawerD', '410');
    await settle(page);
    await viaButton(page, '#navPlates', H.PLATES_URL);
    expect(await stored(page, PLATES + ':prev')).toBe(mine);

    if (reload) await arrive(page, H.PLATES_URL);
    await arrive(page, H.PLATES_URL + '#w=444');
    await expect(page.locator('#putBack')).toBeVisible();
    expect(await stored(page, PLATES + ':prev')).toBe(mine);
    await clickAndLoad(page, '#putBack');
    expect(await page.inputValue('#drawerW')).toBe('600');
    expect(await page.inputValue('#connector')).toBe('snap');
  });
}

test('a page that declined a link goes on from its defaults, not the link', async ({ page }) => {
  await arrive(page, H.BINS_URL + '#w=333&bl=0-0-1-1-3');
  expect(await stored(page, BINS + ':linked')).not.toBeNull();
  const save = await stored(page, BINS);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [BINS + ':loading', save]);
  await arrive(page, H.BINS_URL);
  await expect(page.locator('#setAside')).toContainText(/did not finish loading/);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  expect(await stored(page, BINS + ':linked')).toBeNull();
});

test('the guide passes a layout on without its own anchors in the way', async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'bottomPad', '2');           // a plate taller than the default
  await settle(page);
  const H0 = await page.evaluate(() => +binsHref().match(/(?:^|[#&])ph=([^&]*)/)[1]);
  expect(H0).toBeGreaterThan(4.25);

  // the guide is handed the plate height the bins page needs, as the Bins button hands it
  await Promise.all([page.waitForEvent('load'), page.click('#navGuide')]);
  const layout = await page.evaluate(() => location.hash);
  expect(layout).toMatch(/(^#|&)ph=/);

  // a guide link with an anchor of its own carries the layout, not "#heights#w=…"
  await page.goto(H.PLATES_URL.replace(/index\.html$/, 'guide/drawer-sizes/index.html') + layout);
  await Promise.all([page.waitForEvent('load'), page.click('a[href="../#heights"]')]);
  expect(await page.evaluate(() => location.hash)).toBe(layout);

  await page.goto(H.BINS_URL + layout);
  await ready(page);
  expect(await page.evaluate(() => state.plateH)).toBeCloseTo(H0, 2);
});

test('looking at a linked layout differently is not changing it', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  await arrive(page, H.BINS_URL + '#bl=0-0-1-1-3');
  await expect(page.locator('#putBack')).toBeVisible();

  await H.clickCell(page, 0, 0);                       // open their bin on its own
  await page.click('#focusBin');
  await settle(page);
  expect(await stored(page, BINS)).toContain('bf=');
  await expect(page.locator('#putBack')).toBeVisible();

  // still their layout, untouched, so the next link keeps yours in the backup
  await arrive(page, H.BINS_URL + '#bl=2-2-1-1-3');
  await clickAndLoad(page, '#putBack');
  expect(await binsIn(page)).toBe(2);
});

test('a link with your bins in a drawer of another size still offers yours back',
  async ({ page }) => {
    await H.openBins(page);
    await H.dragCells(page, [0, 0], [1, 1]);
    await settle(page);
    const save = await stored(page, BINS);
    await arrive(page, H.BINS_URL + '#' + save.replace(/(^|&)w=\d+/, '$1w=500'));
    expect(await page.evaluate(() => state.drawerW)).toBe(500);
    await expect(page.locator('#putBack')).toBeVisible();
    expect(await stored(page, BINS + ':prev')).toBe(save);
  });

test('reloading a bins layout that did not finish loading does not lose it',
  async ({ page }) => {
    await H.openBins(page);
    await H.dragCells(page, [0, 0], [1, 1]);
    await settle(page);
    const save = await stored(page, BINS);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [BINS + ':loading', save]);

    // a reload keeps the layout in the address, which is how it usually comes back
    for (let visit = 0; visit < 2; visit++) {
      await arrive(page, H.BINS_URL + '#' + save);
      expect(await binsIn(page)).toBe(0);
      await expect(page.locator('#setAside')).toContainText(/did not finish loading/);
      expect(await stored(page, BINS), 'nothing saved over it').toBe(save);
      expect(await page.evaluate(() => location.hash.slice(1))).toBe(save);
    }
    expect(await stored(page, BINS + ':prev')).toBe(save);
    await clickAndLoad(page, '#tryAnyway');
    expect(await binsIn(page)).toBe(1);
  });

test('a drawer too big for the page, from a link, is said in Checks', async ({ page }) => {
  await arrive(page, H.BINS_URL + '#w=5000&d=380&bl=0-0-1-1-3');
  expect(await page.evaluate(() => state.drawerW)).toBe(2000);
  await expect(page.locator('#warnings')).toContainText('5000 × 380 mm drawer is bigger than the 2000 mm');
});

test('the bins printer menu names the bed a link brings', async ({ page }) => {
  await arrive(page, H.BINS_URL + '#bw=220&bd=220&bh=250');
  expect(await page.inputValue('#bedPreset')).toBe('220,220,250');
  await arrive(page, H.BINS_URL + '#bw=200&bd=210&bh=220');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
});

test('a layout that will not write is not saved as something else', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const save = await stored(page, BINS);
  await page.evaluate(() => { window.descriptor = () => { throw new Error('no'); }; });
  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  expect(await stored(page, BINS)).toBe(save);
});
