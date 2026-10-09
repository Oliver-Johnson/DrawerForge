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

/* Served over HTTP (H.serveRoot), not opened from disk. Over file:// the tools' hand-over
   links ("../#…") open a directory listing, so these tests followed each one by hand, and
   now and then a page did not see what the page before it had just stored: the save, or
   the note a hand-over leaves for the next page. Then a trip read as someone's link, or
   a bare visit as a page with nothing saved. On a real origin each page's own button and
   link is followed onto the page it means, as on the site. The service worker is
   blocked: nothing here is about it, and a page it answers is not the one on disk. */
test.use({ serviceWorkers: 'block' });
let site;
test.beforeAll(async () => { site = await H.serveRoot(); });
test.afterAll(() => site.close());
const platesUrl = () => site.base;
const binsUrl = () => site.base + 'bins/';

const settle = (page) => page.waitForTimeout(900);   // past the 400 ms save debounce
/* Until the page's save has landed: no edit still waiting to be read in (the bins page's
   fields are read in a moment after they change, `timer`), and this browser's save is the
   design on the page. Going on to another address drops a save still waiting (see
   dropSave), and a fixed wait for it was now and then too short for a page still drawing. */
const saved = (page) => expect.poll(() => page.evaluate(() =>
  (typeof timer === 'undefined' || timer === null) &&
  localStorage.getItem(SAVE_KEY) === encodeDesc(descriptor())), { message: 'the page has saved' })
  .toBe(true);
const PLATES = 'drawerforge:plates:v1';
const BINS = 'drawerforge:bins:v1';

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !H.blankFavicon(m)) errors.push(m.text()); });
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
  await arrive(page, platesUrl() + '#w=420&d=300&%25=1');
  expect(await page.inputValue('#drawerW')).toBe('420');
  // the setting is carried, encoded, so the save it lands in can be read back
  expect(await stored(page, PLATES)).toContain('%25=1');

  await arrive(page, platesUrl());               // the bare site, which reads the save
  expect(await page.inputValue('#drawerW')).toBe('420');
  expect(errors).toEqual([]);
});

test('a malformed escape loses that one setting, not the page', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, platesUrl() + '#w=%E0%A4%A&d=300');
  expect(await page.inputValue('#drawerD')).toBe('300');
  expect(await page.inputValue('#drawerW')).toBe('306');
  expect(errors).toEqual([]);

  await arrive(page, binsUrl() + '#w=%E0%A4%A&bl=0-0-1-1-3');
  expect(await binsIn(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('a setting with no value is not written back as "undefined"', async ({ page }) => {
  await arrive(page, platesUrl() + '#w=420&junk');
  expect(await page.inputValue('#drawerW')).toBe('420');
  expect(await page.evaluate(() => location.hash)).not.toContain('undefined');
  expect(await stored(page, PLATES)).not.toContain('undefined');
});

test('an unknown connector or split mode keeps the default', async ({ page }) => {
  await arrive(page, platesUrl() + '#cn=bogus&sp=constructor');
  expect(await page.inputValue('#connector')).toBe('dovetail');
  expect(await page.evaluate(() => [state.connector, state.splitMode, splitName()]))
    .toEqual(['dovetail', 'balanced', 'balanced']);

  await arrive(page, platesUrl() + '#sp=__proto__');
  expect(await page.evaluate(() => [state.splitMode, splitName()]))
    .toEqual(['balanced', 'balanced']);
});

test('manual cuts from a link are whole, distinct and few', async ({ page }) => {
  const cuts = () => page.evaluate(() => [state.rowCuts, state.colCuts]);
  // a repeated cut made a zero-height piece; a fractional one, a fractional piece
  await arrive(page, platesUrl() + '#sp=manual&rc=2,2,2');
  expect((await cuts())[0]).toEqual([2]);
  await arrive(page, platesUrl() + '#sp=manual&rc=1.5');
  expect((await cuts())[0]).toEqual([]);
  await arrive(page, platesUrl() + '#sp=manual&rc=' + Array(300).fill(1).join(','));
  expect((await cuts())[0]).toEqual([1]);
  await arrive(page, platesUrl() + '#sp=manual&cc=1.1.1.2.2');
  expect((await cuts())[1]).toEqual([[1, 2]]);
  // a grid big enough to hold them all: still no more cuts than pieces the tool builds
  const all = Array.from({ length: 399 }, (_, i) => i + 1).join(',');
  await arrive(page, platesUrl() + `#w=2000&d=2000&pi=5&sp=manual&rc=${all}`);
  expect((await cuts())[0].length).toBeLessThanOrEqual(59);
});

test('a setting name carrying a line break cannot write into the README', async ({ page }) => {
  await arrive(page, platesUrl() + '#w=420&x%0Ay=1');
  const link = await page.evaluate(() => shareLink());
  expect(link).toContain('x%0Ay=1');
  expect(link).not.toContain('\n');
});

test('following a link puts the layout it replaced aside, with a way back',
  async ({ page }) => {
    await H.openPlates(page, platesUrl());
    await H.setField(page, 'drawerW', '512');
    await saved(page);

    await arrive(page, platesUrl() + '#w=333');
    expect(await page.inputValue('#drawerW')).toBe('333');   // the link still wins
    await expect(page.locator('#restored')).toBeHidden();
    await expect(page.locator('#setAside')).toBeVisible();
    expect(await stored(page, PLATES + ':prev')).toContain('w=512');

    await clickAndLoad(page, '#putBack');
    expect(await page.inputValue('#drawerW')).toBe('512');
  });

test('a save nobody has touched is not offered back', async ({ page }) => {
  await H.openPlates(page, platesUrl());
  await saved(page);                                   // the defaults are saved
  await arrive(page, platesUrl() + '#w=333');
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, PLATES + ':prev')).toBeNull();

  await arrive(page, binsUrl());
  await arrive(page, binsUrl() + '#bl=0-0-1-1-3');
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, BINS + ':prev')).toBeNull();
});

/* The boot guard. A layout that hung or crashed the page leaves the marker the page
   writes before loading it; finding that marker for the same layout means the last
   attempt never finished, and loading it again would only do the same thing again. */
test('a link that did not finish loading last time is not loaded again', async ({ page }) => {
  await H.openPlates(page, platesUrl());
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  expect(await stored(page, PLATES + ':loading'), 'a finished load clears its marker').toBeNull();
  await page.evaluate((k) => localStorage.setItem(k, 'w=333'), PLATES + ':loading');

  await arrive(page, platesUrl() + '#w=333');
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
    await H.openPlates(page, platesUrl());
    await H.setField(page, 'drawerW', '512');
    await settle(page);
    const save = await stored(page, PLATES);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [PLATES + ':loading', save]);

    for (let visit = 0; visit < 2; visit++) {
      await arrive(page, platesUrl());
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
  await H.openPlates(page, platesUrl());
  await H.setField(page, 'drawerW', '512');
  await saved(page);
  await arrive(page, platesUrl() + '#w=333');
  await arrive(page, platesUrl() + '#w=444');
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toContain('w=512');

  // putting it back sets the link's layout aside in its place, rather than losing it
  await clickAndLoad(page, '#putBack');
  expect(await page.inputValue('#drawerW')).toBe('512');
  expect(await stored(page, PLATES + ':prev')).toContain('w=444');
});

test('changing a linked layout takes the offer to put yours back away', async ({ page }) => {
  await H.openPlates(page, platesUrl());
  await H.setField(page, 'drawerW', '512');
  await saved(page);
  await arrive(page, platesUrl() + '#w=333');
  await expect(page.locator('#setAside')).toBeVisible();
  await page.waitForTimeout(600);                      // the boot's own save is no edit
  await expect(page.locator('#setAside')).toBeVisible();
  await H.setField(page, 'drawerW', '340');
  await saved(page);
  await expect(page.locator('#setAside')).toBeHidden();
  // and that edited layout is yours now: the next link sets it aside
  await arrive(page, platesUrl() + '#w=444');
  expect(await stored(page, PLATES + ':prev')).toContain('w=340');
});

test('the printer menu names the bed a link brings', async ({ page }) => {
  await arrive(page, platesUrl() + '#bw=220&bd=220&bh=250');
  expect(await page.inputValue('#bedPreset')).toBe('bed-220');
  await arrive(page, platesUrl() + '#bw=200&bd=210&bh=220');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
  await H.setField(page, 'bedH', '230');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
  await page.selectOption('#bedPreset', 'bed-300');
  await H.setField(page, 'bedW', '299');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
});

test('the pages do not need Object.hasOwn', async ({ page }) => {
  const errors = watch(page);
  await page.addInitScript(() => { delete Object.hasOwn; });
  await arrive(page, platesUrl() + '#sp=plates&w=500');
  expect(await page.evaluate(() => typeof Object.hasOwn)).toBe('undefined');
  expect(await page.evaluate(() => [state.splitMode, layout.pieces.length > 0])).toEqual(['plates', true]);
  await arrive(page, binsUrl() + '#bl=0-0-1-1-3&bw=220');
  expect(await binsIn(page)).toBe(1);
  expect(await page.inputValue('#bedW')).toBe('220');
  expect(errors).toEqual([]);
});

/* ---------- bins ------------------------------------------------------------ */

test('a note that is not a string does not stop the bins page', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, binsUrl() + '#bl=0-0-2-2-3&bnotes=%5B%5B5%5D%5D');
  expect(await page.evaluate(() => B()[0].note || '')).toBe('');   // left out, not drawn
  expect(errors).toEqual([]);
});

/* 28 as the note field and a design file count them, so a note that arrives in a link
   can be saved to a file and opened again. */
test('notes from a link are one clean line of at most 28 characters', async ({ page }) => {
  const notes = encodeURIComponent(JSON.stringify([['one\ntwo\u0007three', '🙂'.repeat(40)]]));
  await arrive(page, binsUrl() + '#bl=0-0-1-1-3_2-0-1-1-3&bnotes=' + notes);
  const [a, b] = await page.evaluate(() => B().map((x) => x.note));
  expect(a).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(a).toContain('one');
  expect(a).toContain('three');
  expect(b).toBe('🙂'.repeat(14));       // whole emoji, never half of one
});

/* A note that is printed on its bin reaches more than the screen: the part's key, which
   is the object's name in a 3MF, the STL's file name, the hint and Checks. One written to
   break each of them, arriving by a link with the note raised (the 23rd field), leaves
   the page working, the hint and Checks showing it as text, the 3MF well-formed XML and
   every name made of plain characters. */
test('a note full of markup and emoji, raised on its shelf, breaks nothing it reaches', async ({ page }) => {
  const errors = watch(page);
  const hostile = '<i>M3</i> & "x" \u{1F642}</script>';
  const notes = encodeURIComponent(JSON.stringify([[hostile]]));
  await arrive(page, binsUrl() + '#bl=0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15-0-1&bnotes=' + notes);
  expect(await page.evaluate(() => [B()[0].labelMode, B()[0].note])).toEqual([1, hostile.slice(0, 28)]);

  await H.clickCell(page, 0, 0);
  await page.waitForTimeout(400);
  await expect(page.locator('#noteHint')).toContainText('cannot print, so it is left off');
  await expect(page.locator('#warnings')).toContainText('left off: \u{1F642}');
  expect(await page.locator('#noteHint *:not(span):not(button), #warnings i, #warnings script').count()).toBe(0);

  const out = await page.evaluate(() => {
    const t = types()[0];
    const x = build3mfXML(platePolysAndItems(0)).model;
    const doc = new DOMParser().parseFromString(x, 'application/xml');
    return { key: t.key, name: typeName(t), bad: doc.getElementsByTagName('parsererror').length,
             objects: [...doc.getElementsByTagName('object')].map((o) => o.getAttribute('name')) };
  });
  expect(out.bad, 'the 3MF parses as XML').toBe(0);
  expect(out.objects).toEqual([out.key]);
  expect(out.key).toMatch(/^[\w.,-]+$/);
  expect(out.name).toMatch(/^bin-1x1x3-[a-z0-9-]+-qty1$/);
  expect(errors).toEqual([]);
});

/* A loose bin's note arrives beside it (bsn), cleaned as a layer's note is: one line of
   at most 28 characters, shown as text. A note with no loose bin to go on is nothing. */
test('a loose bin\'s note from a link is one clean line, as a layer\'s is', async ({ page }) => {
  const errors = watch(page);
  const bin = '0-0-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15-0-1';
  await arrive(page, binsUrl() + '#bs=' + bin + '&bsn=' +
    encodeURIComponent('one\ntwo\u0007<b>three</b>' + '\u{1F642}'.repeat(40)));
  const n = await page.evaluate(() => scratch.note);
  expect(n).toBe('one two <b>three</b>' + '\u{1F642}'.repeat(4));
  await expect(page.locator('#noteHint')).toContainText('cannot print, so it is left off');
  expect(await page.locator('#noteHint b, #warnings b').count()).toBe(0);
  const bins = (await page.evaluate(() => layoutReadme())).split('\n').filter((l) => l.startsWith('Bin: '));
  expect(bins).toEqual(['Bin: 1x1x3  — ' + n]);

  await arrive(page, binsUrl() + '#bl=0-0-1-1-3&bsn=stray');
  expect(await page.evaluate(() => [scratch, B()[0].note || ''])).toEqual([null, '']);
  expect(errors).toEqual([]);
});

/* A link can ask for as many raised notes as it has bins, and each is a part to build and
   hold: 256 took the page to 1.3 GB and 20 s. The first hundred print, layer by layer and
   bin by bin, the rest print plain, and Checks says so the way it does for a drawer past
   the most the page lays out. The bins keep the setting, so the save still says what the
   link asked for. */
test('a link raising more different notes than one layout prints raises the first hundred', async ({ page }) => {
  const errors = watch(page);
  const bins = [], notes = [];
  for (let i = 0; i < 103; i++) {
    bins.push(`${i % 11}-${Math.floor(i / 11)}-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-12-0-0-0-0-15-0-1`);
    notes.push(`N${i}`);
  }
  await arrive(page, binsUrl() + '#w=462&d=462&bl=' + bins.join('_') +
    '&bnotes=' + encodeURIComponent(JSON.stringify([notes])));
  const out = await page.evaluate(() => ({
    asked: B().filter((b) => b.labelMode === 1 && b.note).length,
    raised: types().filter((t) => printedNote(t.b)).length,
    plain: types().filter((t) => !printedNote(t.b)).map((t) => t.qty),
    held: B().filter((b) => !printedNote(b)).map((b) => b.note),
  }));
  expect(out).toEqual({ asked: 103, raised: 100, plain: [3], held: ['N100', 'N101', 'N102'] });
  await expect(page.locator('#warnings .w.err')).toContainText(
    '103 different notes are set to print raised on label shelves, more than the 100 one layout prints, ' +
    'so the bins with the 3 notes after the first 100 print plain.');
  expect(await stored(page, BINS)).toContain(encodeURIComponent('"N102"'));

  // and the bin says why, where its note is
  await H.clickCell(page, 102 % 11, Math.floor(102 / 11));
  await page.waitForTimeout(400);
  await expect(page.locator('#noteHint')).toContainText(
    'This layout already raises 100 other notes, the most one layout prints, so this one prints plain.');
  expect(errors).toEqual([]);
});

/* A bin whose note cannot print builds no part for it, so it takes none of the hundred:
   a hundred bins with no shelf to print on held back the one note that could print, and
   Checks counted 101 different notes. */
test('notes that cannot print take none of the hundred', async ({ page }) => {
  const errors = watch(page);
  const bins = [], notes = [];
  for (let i = 0; i < 101; i++) {
    bins.push(`${i % 11}-${Math.floor(i / 11)}-1-1-3-1.2-1.2-0-0-0-1-1-1-1-0-${i === 100 ? 12 : 0}-0-0-0-0-15-0-1`);
    notes.push(`N${i}`);
  }
  await arrive(page, binsUrl() + '#w=462&d=462&bl=' + bins.join('_') +
    '&bnotes=' + encodeURIComponent(JSON.stringify([notes])));
  expect(await page.evaluate(() => types().filter((t) => printedNote(t.b)).map((t) => t.b.note))).toEqual(['N100']);
  await expect(page.locator('#warnings')).not.toContainText('different notes');
  expect(errors).toEqual([]);
});

test('a fractional position is rounded rather than thrown on', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, binsUrl() + '#bl=0-0.5-1-1-3');
  const all = await H.bins(page);
  expect(all).toHaveLength(1);
  expect(Number.isInteger(all[0].x) && Number.isInteger(all[0].y)).toBe(true);
  expect(errors).toEqual([]);
});

/* Half cells, from a link: a half-size bin keeps its half size and its half step, as the
   layout and as the bin being edited on its own, and the save holds them as they came.
   Before the map took half steps this was a page that threw (occupancy at y 0.5), and
   then one that rounded every half onto whole cells. A whole-size bin on a half step is
   still put on the grid, the way a fractional position always was: it sits on whole
   cells. */
test('a link with half cells keeps them, and a whole bin still sits on whole cells', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, binsUrl() + '#bl=0.5-0.5-1.5-0.5-3_3-0-0.5-2.5-3_4.5-3.5-2-1-3');
  expect(await page.evaluate(() => B().map((b) => [b.x, b.y, b.u, b.v])))
    .toEqual([[0.5, 0.5, 1.5, 0.5], [3, 0, 0.5, 2.5], [5, 4, 2, 1]]);
  expect(await stored(page, BINS)).toContain('bl=0.5-0.5-1.5-0.5-3-');
  expect(await stored(page, BINS)).toContain('_3-0-0.5-2.5-3-');
  expect(await stored(page, BINS)).toContain('_5-4-2-1-3-');
  // and the page does not just hold them: it draws them, with nothing claiming twice
  expect(await page.locator('#fillmap .bin').count()).toBe(3);
  expect(await page.evaluate(() => layerClaims(0).flat().some(Array.isArray))).toBe(false);

  await arrive(page, binsUrl() + '#bl=0-0-1-1-3&bs=0-0-1.5-0.5-3');
  expect(await page.evaluate(() => [scratch.u, scratch.v])).toEqual([1.5, 0.5]);
  expect(errors).toEqual([]);
});

/* No page writes 1.3 or 1.4, so a link that has one was typed by hand, and a page from
   before half sizes read it as whole cells. It still reads that way: a 1.4 x 1.4 is the
   1 x 1 it was, a 1.3 does not grow into the bin beside it, and a carved bin typed 2.5
   wide keeps its shape as the 3 wide bin it was. */
test('hand-typed sizes between halves read as they did before half sizes', async ({ page }) => {
  const errors = watch(page);
  const sizes = () => page.evaluate(() => B().map((b) => [b.x, b.y, b.u, b.v]));
  const shared = () => page.evaluate(() =>
    layerClaims(0).flat().some(Array.isArray) || warnings().some((w) => /shares cells/.test(w.t)));

  await arrive(page, binsUrl() + '#bl=0-0-1.4-1.4-3');
  expect(await sizes()).toEqual([[0, 0, 1, 1]]);

  await arrive(page, binsUrl() + '#bl=0-0-1.3-1-3_1-0-1-1-3');
  expect(await sizes()).toEqual([[0, 0, 1, 1], [1, 0, 1, 1]]);
  expect(await shared()).toBe(false);

  await arrive(page, binsUrl() + '#bl=0-0-2.5-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-110111');
  expect(await sizes()).toEqual([[0, 0, 3, 2]]);
  expect(await page.evaluate(() => [isCarved(B()[0]), binCells(B()[0]).length])).toEqual([true, 5]);
  // drawn carved, one square for each cell it keeps
  expect(await page.locator('#fillmap .bin').count()).toBe(5);
  expect(errors).toEqual([]);
});

test('dividers and height from a link are capped', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, binsUrl() + '#bl=0-0-1-1-3-1.2-1.2-100000-2.5');
  const b = await page.evaluate(() => B()[0]);
  expect(b.divX).toBeLessThanOrEqual(31);
  expect(b.divY).toBe(Math.round(b.divY));

  await arrive(page, binsUrl() + '#bl=0-0-1-1-1e308');
  expect(await page.evaluate(() => B()[0].hUnits)).toBeLessThan(1000);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('Infinity');
  expect(errors).toEqual([]);
});

test('a wall height the menu does not offer snaps to one it does', async ({ page }) => {
  const errors = watch(page);
  await arrive(page, binsUrl() + '#bl=0-0-1-1-3-1.2-1.2-0-0-0-0.3');
  await H.clickCell(page, 0, 0);
  await settle(page);
  expect(await page.inputValue('#edgeF')).toBe('0.25');
  expect(await page.evaluate(() => B()[0].edges.f)).toBe(0.25);
  expect(errors).toEqual([]);
});

test('the bed, infill and gap come back after a reload', async ({ page }) => {
  await H.openBins(page, binsUrl());
  for (const [id, v] of [['bedW', 180], ['bedD', 180], ['bedH', 180], ['infill', 40], ['gap', 7]])
    await H.setField(page, id, v);
  await settle(page);
  await page.reload();
  await ready(page);
  for (const [id, v] of [['bedW', 180], ['bedD', 180], ['bedH', 180], ['infill', 40], ['gap', 7]])
    expect(await page.inputValue('#' + id), id).toBe(String(v));
});

test('the bed size baseplates sends is the one bins uses', async ({ page }) => {
  await arrive(page, binsUrl() + '#bw=180&bd=180&bh=150');
  expect(await page.evaluate(() => [state.bedW, state.bedD, state.bedH])).toEqual([180, 180, 150]);
});

test('bed, infill and gap survive a trip through baseplates and back', async ({ page }) => {
  await H.openBins(page, binsUrl());
  const want = [['bedW', '200'], ['bedD', '210'], ['bedH', '220'], ['infill', '35'], ['gap', '6']];
  for (const [id, v] of want) await H.setField(page, id, v);
  await saved(page);

  // each page's own link, as the page means it
  await arrive(page, await page.evaluate(() => new URL(platesHref(), location.href).href));
  for (const [id, v] of want.slice(0, 4)) expect(await page.inputValue('#' + id), id).toBe(v);

  await arrive(page, await page.evaluate(() => new URL(binsHref(), location.href).href));
  for (const [id, v] of want) expect(await page.inputValue('#' + id), id).toBe(v);
  // the same layout come back, not a link that replaced it
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await page.inputValue('#bedPreset')).toBe('custom');
});

test('a drawer of no size, or an absurd one, in a link is not used', async ({ page }) => {
  await arrive(page, binsUrl() + '#w=-500&d=0');
  expect(await page.evaluate(() => [state.drawerW, state.drawerD])).toEqual([306, 380]);
  await arrive(page, binsUrl() + '#w=5000&d=380');
  expect(await page.evaluate(() => state.drawerW)).toBeLessThanOrEqual(2000);
});

test('a negative wall does not stop the bins page saving', async ({ page }) => {
  const errors = watch(page);
  await H.openBins(page, binsUrl());
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
  await H.openBins(page, binsUrl());
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.dragCells(page, [3, 3], [3, 3]);
  await saved(page);

  await arrive(page, binsUrl() + '#bl=0-0-1-1-3');
  expect(await binsIn(page)).toBe(1);
  await expect(page.locator('#setAside')).toBeVisible();

  await clickAndLoad(page, '#putBack');
  expect(await binsIn(page)).toBe(2);
});

test('a saved layout that did not finish loading last time is set aside', async ({ page }) => {
  await H.openBins(page, binsUrl());
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const save = await stored(page, BINS);
  expect(await stored(page, BINS + ':loading')).toBeNull();
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [BINS + ':loading', save]);

  await arrive(page, binsUrl());                        // a bare visit reads the save
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
   The page's own button is clicked, so its own marking is what is tested, and the test
   goes on from the page the button opens. */
async function viaButton(page, sel, url) {
  await Promise.all([page.waitForEvent('load'), page.click(sel)]);
  expect(page.url().split('#')[0]).toBe(url);
  expect(await page.evaluate(() => location.hash.length), 'the button carried the layout')
    .toBeGreaterThan(2);
  await ready(page);
}
test('a trip to baseplates and back keeps the bins, with nothing offered back',
  async ({ page }) => {
    await H.openBins(page, binsUrl());
    await H.dragCells(page, [0, 0], [1, 1]);
    await H.dragCells(page, [3, 3], [3, 3]);
    await settle(page);

    await viaButton(page, '#navPlates', platesUrl());
    await expect(page.locator('#setAside')).toBeHidden();
    await H.setField(page, 'drawerW', '400');         // changed on the other page
    await settle(page);

    await viaButton(page, '#navBins', binsUrl());
    expect(await binsIn(page)).toBe(2);
    expect(await page.inputValue('#drawerW')).toBe('400');
    await expect(page.locator('#setAside')).toBeHidden();
    expect(await stored(page, BINS + ':prev')).toBeNull();
  });

test('by way of the guide is a hand-over too', async ({ page }) => {
  await H.openPlates(page, platesUrl());
  await page.check('#magnets');                       // a baseplate layout of your own
  await settle(page);
  await viaButton(page, '#navBins', binsUrl());
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'drawerW', '400');
  await settle(page);

  await Promise.all([page.waitForEvent('load'), page.click('#navGuide')]);
  expect(page.url().split('#')[0]).toBe(site.base + 'guide/');
  await viaButton(page, 'header nav a[href="../"]', platesUrl());   // the guide's own link
  expect(await page.inputValue('#drawerW')).toBe('400');
  expect(await page.isChecked('#magnets')).toBe(true);
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, PLATES + ':prev')).toBeNull();
});

test('a layout handed over onto an empty page is yours, not a link', async ({ page }) => {
  await H.openBins(page, binsUrl());
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await viaButton(page, '#navPlates', platesUrl());   // baseplates had nothing saved
  const handed = await stored(page, PLATES);

  await arrive(page, platesUrl() + '#w=333');
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toBe(handed);
});

test("someone's bins link carried to baseplates still keeps your drawer", async ({ page }) => {
  await H.openPlates(page, platesUrl());
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  // their link was made after a trip through baseplates, so it carries its keys too
  const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333') +
    '&bl=0-0-1-1-3';
  await arrive(page, binsUrl() + '#' + theirs);

  await viaButton(page, '#navPlates', platesUrl());
  expect(await page.inputValue('#drawerW')).toBe('333');   // the link still wins
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toContain('w=512');
});

test("someone's bins link, edited, carried to baseplates still keeps your drawer",
  async ({ page }) => {
    await H.openPlates(page, platesUrl());
    await H.setField(page, 'drawerW', '512');
    await settle(page);
    // their baseplate settings are the same as yours; only their drawer differs
    const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333') +
      '&bl=0-0-1-1-3';
    await arrive(page, binsUrl() + '#' + theirs);
    await H.setField(page, 'gap', '6');               // changed, but still their drawer
    await saved(page);
    await arrive(page, binsUrl());                    // and a reload does not make it yours

    await viaButton(page, '#navPlates', platesUrl());
    expect(await page.inputValue('#drawerW')).toBe('333');
    await expect(page.locator('#putBack')).toBeVisible();
    expect(await stored(page, PLATES + ':prev')).toContain('w=512');
  });

/* Each of a link's drawer, bed and infill settings is the link's while it is in use, key
   by key. Compared as one group, changing any one of them made the rest yours, and the
   trip brought them onto your baseplates with nothing set aside. */
async function theirBinsLink(page) {
  await H.openPlates(page, platesUrl());
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  // made after a trip through baseplates, with the same baseplate settings as yours
  const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333') +
    '&bl=0-0-1-1-3';
  await arrive(page, binsUrl() + '#' + theirs);
}
for (const [id, value] of [['infill', '20'], ['bedH', '200'], ['drawerD', '300']]) {
  test(`someone's bins link with only #${id} changed still keeps your drawer`,
    async ({ page }) => {
      await theirBinsLink(page);
      await H.setField(page, id, value);
      await settle(page);

      await viaButton(page, '#navPlates', platesUrl());
      expect(await page.inputValue('#drawerW')).toBe('333');
      await expect(page.locator('#putBack')).toBeVisible();
      expect(await stored(page, PLATES + ':prev')).toContain('w=512');
    });
}

// whether a layout is a link's goes aside with it, and comes back with it
test("an edited link put back is still the link's", async ({ page }) => {
  await theirBinsLink(page);
  await H.setField(page, 'gap', '6');
  await saved(page);
  await arrive(page, binsUrl() + '#bl=2-2-1-1-3');    // sets the edited one aside
  await clickAndLoad(page, '#putBack');
  expect(await page.inputValue('#gap')).toBe('6');

  await viaButton(page, '#navPlates', platesUrl());
  expect(await page.inputValue('#drawerW')).toBe('333');
  await expect(page.locator('#putBack')).toBeVisible();
  expect(await stored(page, PLATES + ':prev')).toContain('w=512');
});

test("your own layout put back is not the link's, even in the same drawer",
  async ({ page }) => {
    await H.openPlates(page, platesUrl());
    await page.check('#magnets');
    await settle(page);
    await viaButton(page, '#navBins', binsUrl());
    await H.dragCells(page, [0, 0], [0, 0]);
    await H.setField(page, 'drawerW', '400');
    await saved(page);
    const mine = await stored(page, BINS);
    await arrive(page, binsUrl() + '#' + mine.replace(/(^|&)bl=[^&]*/, '$1bl=2-2-1-1-3'));
    await clickAndLoad(page, '#putBack');
    expect(await binsIn(page)).toBe(1);

    await viaButton(page, '#navPlates', platesUrl());
    expect(await page.inputValue('#drawerW')).toBe('400');
    expect(await page.isChecked('#magnets')).toBe(true);
    await expect(page.locator('#setAside')).toBeHidden();
    expect(await stored(page, PLATES + ':prev')).toBeNull();
  });

/* The settings you changed are yours on the way back, while the ones still at the link's
   values are compared. Not marking the trip at all, because some were still the link's,
   called this a link replacing your bins and pushed your own out of the backup. */
test("someone's drawer changed on baseplates comes back to bins as yours", async ({ page }) => {
  await H.openBins(page, binsUrl());
  await H.dragCells(page, [0, 0], [1, 1]);
  await saved(page);
  const mine = await stored(page, BINS);
  await arrive(page, binsUrl() + '#w=333&bl=0-0-1-1-3');
  await H.setField(page, 'gap', '6');
  await settle(page);
  await viaButton(page, '#navPlates', platesUrl());
  await H.setField(page, 'drawerW', '400');           // their bed and infill still in use
  await settle(page);

  await viaButton(page, '#navBins', binsUrl());
  expect(await page.inputValue('#drawerW')).toBe('400');
  expect(await page.inputValue('#gap')).toBe('6');
  await expect(page.locator('#setAside')).toBeHidden();
  expect(await stored(page, BINS + ':prev')).toBe(mine);
});

/* A drawer you typed on someone's link is yours on the other page too, not the link's.
   Recorded there as the link's, a later trip that changed it was a link replacing your
   bins, and set your own original aside over the one the link had set aside. */
test("your own drawer on someone's link is not recorded as theirs", async ({ page }) => {
  await H.openPlates(page, platesUrl());
  await H.setField(page, 'drawerW', '512');
  await settle(page);
  const theirs = (await stored(page, PLATES)).replace(/(^|&)w=512/, '$1w=333')
    .replace(/(^|&)bw=[^&]*/, '$1bw=220').replace(/(^|&)bd=[^&]*/, '$1bd=220') + '&bl=0-0-1-1-3';
  expect(theirs).toContain('bw=220');
  await arrive(page, binsUrl());
  await H.dragCells(page, [0, 0], [1, 1]);            // your own bins
  await saved(page);
  const mine = await stored(page, BINS);

  await arrive(page, binsUrl() + '#' + theirs);
  await H.setField(page, 'drawerW', '500');           // your drawer, their bed
  await H.setField(page, 'drawerD', '400');
  await settle(page);
  await viaButton(page, '#navPlates', platesUrl());
  await expect(page.locator('#putBack')).toBeVisible();

  await arrive(page, binsUrl());
  await H.setField(page, 'drawerW', '600');
  await saved(page);
  await arrive(page, platesUrl());
  await viaButton(page, '#navBins', binsUrl());
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
    await H.openPlates(page, platesUrl());
    await H.setField(page, 'drawerW', '600');
    await H.setField(page, 'drawerD', '400');
    await H.setField(page, 'bedW', '220');
    await page.selectOption('#connector', 'snap');
    await saved(page);
    const mine = await stored(page, PLATES);

    await arrive(page, binsUrl() + '#w=333&d=333&bw=250&bd=250&bl=0-0-1-1-3');
    await H.setField(page, 'drawerW', '520');         // your drawer, their bed
    await H.setField(page, 'drawerD', '410');
    await settle(page);
    await viaButton(page, '#navPlates', platesUrl());
    expect(await stored(page, PLATES + ':prev')).toBe(mine);

    if (reload) await arrive(page, platesUrl());
    await arrive(page, platesUrl() + '#w=444');
    await expect(page.locator('#putBack')).toBeVisible();
    expect(await stored(page, PLATES + ':prev')).toBe(mine);
    await clickAndLoad(page, '#putBack');
    expect(await page.inputValue('#drawerW')).toBe('600');
    expect(await page.inputValue('#connector')).toBe('snap');
  });
}

test('a page that declined a link goes on from its defaults, not the link', async ({ page }) => {
  await arrive(page, binsUrl() + '#w=333&bl=0-0-1-1-3');
  expect(await stored(page, BINS + ':linked')).not.toBeNull();
  const save = await stored(page, BINS);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [BINS + ':loading', save]);
  await arrive(page, binsUrl());
  await expect(page.locator('#setAside')).toContainText(/did not finish loading/);
  expect(await stored(page, BINS + ':linked'), 'declined, the link is still recorded').not.toBeNull();
  await H.dragCells(page, [0, 0], [0, 0]);
  // the edit's save, however long a busy page takes to it
  await expect.poll(() => stored(page, BINS + ':linked'), { message: 'the edit ends the record' })
    .toBeNull();
});

test('the guide passes a layout on without its own anchors in the way', async ({ page }) => {
  await H.openPlates(page, platesUrl());
  await H.setField(page, 'bottomPad', '2');           // a plate taller than the default
  await settle(page);
  const H0 = await page.evaluate(() => +binsHref().match(/(?:^|[#&])ph=([^&]*)/)[1]);
  expect(H0).toBeGreaterThan(4.25);

  // the guide is handed the plate height the bins page needs, as the Bins button hands it
  await Promise.all([page.waitForEvent('load'), page.click('#navGuide')]);
  const layout = await page.evaluate(() => location.hash);
  expect(layout).toMatch(/(^#|&)ph=/);

  // on from the guide to one of its own pages, which carries it too
  await Promise.all([page.waitForEvent('load'), page.click('a[href="drawer-sizes/"]')]);
  expect(page.url().split('#')[0]).toBe(site.base + 'guide/drawer-sizes/');
  expect(await page.evaluate(() => location.hash)).toBe(layout);

  // and a link there with an anchor of its own carries the layout, not "#heights#w=…"
  await Promise.all([page.waitForEvent('load'), page.click('a[href="../#heights"]')]);
  expect(page.url().split('#')[0]).toBe(site.base + 'guide/');
  expect(await page.evaluate(() => location.hash)).toBe(layout);

  // and the guide's own Bins link brings it on to the bins page
  await viaButton(page, 'header nav a[href="../bins/"]', binsUrl());
  expect(await page.evaluate(() => state.plateH)).toBeCloseTo(H0, 2);
});

test('looking at a linked layout differently is not changing it', async ({ page }) => {
  await H.openBins(page, binsUrl());
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.dragCells(page, [3, 3], [3, 3]);
  await saved(page);
  await arrive(page, binsUrl() + '#bl=0-0-1-1-3');
  await expect(page.locator('#putBack')).toBeVisible();

  await H.clickCell(page, 0, 0);                       // open their bin on its own
  await page.click('#focusBin');
  await settle(page);
  expect(await stored(page, BINS)).toContain('bf=');
  await expect(page.locator('#putBack')).toBeVisible();

  // still their layout, untouched, so the next link keeps yours in the backup
  await arrive(page, binsUrl() + '#bl=2-2-1-1-3');
  await clickAndLoad(page, '#putBack');
  expect(await binsIn(page)).toBe(2);
});

test('a link with your bins in a drawer of another size still offers yours back',
  async ({ page }) => {
    await H.openBins(page, binsUrl());
    await H.dragCells(page, [0, 0], [1, 1]);
    await saved(page);
    const save = await stored(page, BINS);
    await arrive(page, binsUrl() + '#' + save.replace(/(^|&)w=\d+/, '$1w=500'));
    expect(await page.evaluate(() => state.drawerW)).toBe(500);
    await expect(page.locator('#putBack')).toBeVisible();
    expect(await stored(page, BINS + ':prev')).toBe(save);
  });

test('reloading a bins layout that did not finish loading does not lose it',
  async ({ page }) => {
    await H.openBins(page, binsUrl());
    await H.dragCells(page, [0, 0], [1, 1]);
    await settle(page);
    const save = await stored(page, BINS);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [BINS + ':loading', save]);

    // a reload keeps the layout in the address, which is how it usually comes back
    for (let visit = 0; visit < 2; visit++) {
      await arrive(page, binsUrl() + '#' + save);
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
  await arrive(page, binsUrl() + '#w=5000&d=380&bl=0-0-1-1-3');
  expect(await page.evaluate(() => state.drawerW)).toBe(2000);
  await expect(page.locator('#warnings')).toContainText('5000 × 380 mm drawer is bigger than the 2000 mm');
});

test('the bins printer menu names the bed a link brings', async ({ page }) => {
  await arrive(page, binsUrl() + '#bw=220&bd=220&bh=250');
  expect(await page.inputValue('#bedPreset')).toBe('bed-220');
  await arrive(page, binsUrl() + '#bw=200&bd=210&bh=220');
  expect(await page.inputValue('#bedPreset')).toBe('custom');
});

test('a layout that will not write is not saved as something else', async ({ page }) => {
  await H.openBins(page, binsUrl());
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const save = await stored(page, BINS);
  await page.evaluate(() => { window.descriptor = () => { throw new Error('no'); }; });
  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  expect(await stored(page, BINS)).toBe(save);
});

/* A link pasted over the page as an edit's save comes due. The paste puts the link in the
   address at once and its hashchange, which reloads onto it, comes after; a page still
   drawing the edit comes to the waiting save first. That save wrote the page's own design
   back over the link, the hashchange then found that and reloaded it, and the link was
   gone, with nothing said. Here the save runs in the same task as the paste, as it did. */
for (const [tool, key] of [['plates', PLATES], ['bins', BINS]]) {
  test(`a link pasted over ${tool} as an edit's save comes due is the link`, async ({ page }) => {
    const errors = watch(page);
    await arrive(page, tool === 'bins' ? binsUrl() : platesUrl());
    const before = await page.inputValue('#drawerW');
    // the edit, its save still waiting when the paste lands, all in one task
    await Promise.all([page.waitForEvent('load'), page.evaluate(() => {
      const e = document.getElementById('drawerW');
      e.value = '412';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof landEdit === 'function') landEdit();  // the edit read in, as a save does
      location.hash = '#w=333&d=444&v=2';
      saveNow();
    })]);
    await ready(page);
    expect(await page.inputValue('#drawerW')).toBe('333');
    await expect(page.locator('#setAsideMsg')).toHaveText('This link replaced the layout you had here.');
    // the edit was saved, and is what the link set aside
    expect(await stored(page, key + ':prev')).toMatch(/(^|&)w=412(&|$)/);

    /* Back goes to the address before the paste, which never had the edit: it is aside, and
       in no earlier address, so it is offered there too. */
    await page.goBack();
    await ready(page);
    expect(await page.inputValue('#drawerW')).toBe(before);
    await expect(page.locator('#setAsideMsg'))
      .toHaveText('This page went back to an earlier layout of yours. The later one is set aside.');
    await clickAndLoad(page, '#putBack');
    expect(await page.inputValue('#drawerW')).toBe('412');
    expect(errors).toEqual([]);
  });
}

/* And only that save. A layout aside for any other reason can be older than the page Back
   brings: someone's link kept as a drawer of yours, a second link over it, then Back to the
   first. That offered "the later one", and Put back brought the layout from before the
   first link, with the second gone from Forward. */
for (const tool of ['plates', 'bins']) {
  test(`Back to a link kept as a drawer on ${tool}, over a second link, offers nothing older`,
    async ({ page }) => {
      const errors = watch(page);
      const url = tool === 'bins' ? binsUrl() : platesUrl();
      await arrive(page, url);
      await H.setField(page, 'drawerW', '400');
      await saved(page);
      const paste = async (h) => {
        await Promise.all([page.waitForEvent('load'), page.evaluate((x) => { location.hash = x; }, h)]);
        await ready(page);
      };
      await paste('#w=333&d=444&v=2');
      await page.click('#drawersBtn');
      await page.fill('#drawersNewName', 'Kit');
      await page.press('#drawersNewName', 'Enter');
      await expect(page.locator('#drawersMsg')).toContainText('Saved as “Kit”');
      await page.click('#drawersClose');
      await saved(page);
      await paste('#w=355&d=466&v=2');
      await expect(page.locator('#setAsideMsg')).toHaveText('This link replaced the layout you had here.');

      await page.goBack();
      await ready(page);
      expect(await page.inputValue('#drawerW')).toBe('333');
      await expect(page.locator('#drawerName')).toHaveText('Kit');
      await expect(page.locator('#setAside'), 'nothing is offered').toBeHidden();
      await page.goForward();
      await ready(page);
      expect(await page.inputValue('#drawerW'), 'and the second link is still Forward').toBe('355');
      expect(errors).toEqual([]);
    });
}

/* ---------- Start fresh ----------------------------------------------------- */

/* Start fresh clears this browser's save and loads the bare page, and the page runs on
   until that one arrives. A change that landed in between was saved after the clearing,
   and the bare page came back with it, saying it had been restored. Here the bare page is
   slow to come, and the change lands 50 ms after the press: on Baseplates a field's
   change, on Bins its input, which Bins reads in 180 ms on. Both pages are covered. */
for (const tool of ['plates', 'bins']) {
  test(`Start fresh on ${tool} is not undone by a change that lands as the page goes`, async ({ page }) => {
    const errors = watch(page);
    const url = tool === 'bins' ? binsUrl() : platesUrl();
    await arrive(page, url + '#w=333&d=444&v=2');
    await page.route((u) => u.href === url, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await Promise.all([page.waitForEvent('load'), page.evaluate((ev) => {
      document.getElementById('startFresh').click();
      setTimeout(() => {
        const e = document.getElementById('drawerW');
        e.value = '345';
        e.dispatchEvent(new Event(ev, { bubbles: true }));
      }, 50);
    }, tool === 'bins' ? 'input' : 'change')]);
    await ready(page);
    expect(await page.inputValue('#drawerW')).not.toBe('345');
    await expect(page.locator('#restored')).toBeHidden();
    expect(await stored(page, tool === 'bins' ? BINS : PLATES)).not.toMatch(/(^|&)w=345(&|$)/);
    expect(errors).toEqual([]);
  });
}

/* And the button is wired before the boot reads a link, so a link that throws partway
   through the boot does not take it away: Start fresh still clears the save and loads the
   bare page with the defaults, though the page never got as far as letting saves start.
   The links that used to throw no longer do, so the page is made to throw here, after it
   has read a link carrying `boom`. The note the button sits in is shown later in the
   boot, so it is pressed from script. */
for (const tool of ['plates', 'bins']) {
  test(`Start fresh on ${tool} still clears the save when a link throws in the boot`, async ({ page }) => {
    const url = tool === 'bins' ? binsUrl() : platesUrl();
    await arrive(page, url);
    await H.setField(page, 'drawerW', '451');
    await saved(page);
    await page.route((u) => u.href === url, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace('loadFromHash(src);',
        "loadFromHash(src); if (/(^|&)boom=/.test(src)) throw new Error('boom');") });
    });
    const thrown = [];
    page.on('pageerror', (e) => thrown.push(String(e)));
    await arrive(page, url + '#w=345&d=444&boom=1&v=2');
    expect(thrown.join(), 'the boot threw').toContain('boom');
    await Promise.all([page.waitForEvent('load'),
      page.evaluate(() => document.getElementById('startFresh').click())]);
    await ready(page);
    expect(await page.evaluate(() => new URL(performance.getEntriesByType('navigation')[0].name).hash),
      'the bare page').toBe('');
    expect(await page.inputValue('#drawerW')).not.toBe('451');
    expect(await page.inputValue('#drawerW')).not.toBe('345');
    await expect(page.locator('#restored')).toBeHidden();
    expect(thrown.filter((e) => !/boom/.test(e))).toEqual([]);
  });
}

/* And it ends the offer of an edit a pasted link set aside (see the paste tests above). The
   edit was offered on Back, and left; then a bare visit, and Start fresh there. The record
   of the edit's save stayed, and the fresh page is at the address it names: another link
   pasted over it, then Back to it, offered the edit as the later layout, and Put back
   brought it, though Start fresh came after it. Both pages are covered. */
for (const tool of ['plates', 'bins']) {
  test(`Start fresh on ${tool} ends the offer of an edit a pasted link set aside`, async ({ page }) => {
    const errors = watch(page);
    const url = tool === 'bins' ? binsUrl() : platesUrl();
    await arrive(page, url);
    await saved(page);
    const paste = async (h, edit) => {
      await Promise.all([page.waitForEvent('load'), page.evaluate(([h, edit]) => {
        if (edit) {
          const e = document.getElementById('drawerW');
          e.value = edit;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
          if (typeof landEdit === 'function') landEdit();
        }
        location.hash = h;
        if (edit) saveNow();
      }, [h, edit])]);
      await ready(page);
    };
    await paste('#w=333&d=444&v=2', '412');
    await page.goBack();
    await ready(page);
    await expect(page.locator('#setAsideMsg'))
      .toHaveText('This page went back to an earlier layout of yours. The later one is set aside.');

    await arrive(page, url);
    await clickAndLoad(page, '#startFresh');
    await saved(page);
    await paste('#w=355&d=466&v=2');
    await page.goBack();
    await ready(page);
    expect(await page.inputValue('#drawerW'), 'the fresh page').not.toBe('355');
    await expect(page.locator('#setAside'), 'nothing is offered').toBeHidden();
    expect(errors).toEqual([]);
  });
}
