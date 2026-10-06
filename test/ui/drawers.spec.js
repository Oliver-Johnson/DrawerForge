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
