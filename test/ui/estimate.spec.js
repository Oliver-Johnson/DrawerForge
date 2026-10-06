/* What a job costs, and roughly how long it prints.
 *
 * Both tools weighed the job and neither priced or timed it, which are the next two
 * questions anyone asks before committing a spool and a weekend to a drawer. The price
 * is the person's and not the design's, so it lives on the device, under one key both
 * tools read, and never in a link; while it is empty no money is shown anywhere, so
 * nobody is quoted a guess in a guessed currency. The time is a rough figure from the
 * filament and the layer count, and says so wherever it appears.
 *
 * These hold: no cost until a price is set, then a cost beside every gram figure, then
 * none again once it is cleared; the price surviving a reload and the trip between the
 * tools, and staying out of the link; the currency's starting symbol; and the time —
 * per plate and in total, adding up, steered by the printer list and the override,
 * rounded, and labelled for what it is.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
const JSZip = require('../../vendor/jszip.min.js');
const fs = require('fs');

const KEY = 'drawerforge:filament:v1';
const MONEY = /\$\d+\.\d\d/;

test.afterEach(async ({ page }) => {
  expect(page.__errors || [], 'the page threw while being driven').toEqual([]);
});

/* A bins layout small enough to be quick and big enough to need several plates: a
   4 × 4 drawer of 1×1 bins on a 120 mm bed, which takes four bins a plate. */
async function binsJob(page) {
  page.__errors = await H.openBins(page);
  await H.setField(page, 'drawerW', 168);
  await H.setField(page, 'drawerD', 168);
  await H.setField(page, 'bedPreset', 'custom');
  await H.setField(page, 'bedW', 120);
  await H.setField(page, 'bedD', 120);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => goodPlates().length), 'fixture: four plates').toBe(4);
}
/* Every place the bins page writes a gram figure, read back as text. The README is the
   one in the ZIP, which the export spec already holds equal to layoutReadme(). */
const binsFigures = (page) => page.evaluate(() => {
  document.getElementById('openExport').click();
  const out = {
    rows: [...document.querySelectorAll('#typeRows tr td:nth-child(4)')].map((e) => e.textContent),
    totals: document.getElementById('totals').textContent,
    plates: [...document.querySelectorAll('#plateWrap .hint')].map((e) => e.textContent),
    summary: document.getElementById('plateSummary').textContent,
    dialog: document.getElementById('exDesign').textContent,
    plateRows: [...document.querySelectorAll('#exFiles [data-ex="plate"], #exFiles [data-ex="allplates"]')]
      .map((b) => b.closest('.exrow').querySelector('.meta').textContent),
    readme: layoutReadme(),
  };
  document.getElementById('exportDlg').close();
  return out;
});
const platesFigures = (page) => page.evaluate(() => {
  document.getElementById('openExport').click();
  const out = {
    rows: [...document.querySelectorAll('#pieceRows tr td:nth-child(6)')].map((e) => e.textContent),
    plates: [...document.querySelectorAll('#platesRow .hint')].map((e) => e.textContent),
    summary: document.getElementById('planTime').textContent,
    dialog: document.getElementById('exDesign').textContent,
    plateRows: [...document.querySelectorAll('#exFiles [data-ex="plate"], #exFiles [data-ex="allplates"]')]
      .map((b) => b.closest('.exrow').querySelector('.meta').textContent),
    readme: readmeText(),
  };
  document.getElementById('exportDlg').close();
  return out;
});
const everyText = (f) => [...f.rows, f.totals || '', ...f.plates, f.summary, f.dialog,
                          ...f.plateRows, f.readme];

test.describe('the price', () => {
  test('bins: no cost until a price is set, then beside every gram figure, then gone', async ({ page }) => {
    await binsJob(page);
    await expect(page.locator('#filPrice')).toHaveValue('');
    for (const t of everyText(await binsFigures(page)))
      expect(t, 'money shown with no price set').not.toMatch(/[$£€]\s?\d/);

    await H.setField(page, 'filPrice', '20');
    const f = await binsFigures(page);
    for (const r of f.rows) expect(r).toMatch(/^\d+ g · \$\d+\.\d\d$/);
    expect(f.totals).toMatch(/g PLA at 15% infill, about \$\d+\.\d\d/);
    for (const p of f.plates) expect(p).toMatch(/\d+ g · \$\d+\.\d\d · ≈/);
    expect(f.dialog).toMatch(/about \d+ g of PLA at 15% infill, about \$\d+\.\d\d at \$20\.00\/kg/);
    for (const r of f.plateRows) expect(r).toMatch(/\d+ g · \$\d+\.\d\d · ≈/);
    expect(f.readme).toMatch(/Total: 16 bins, about \d+ g of PLA — about \$\d+\.\d\d at \$20\.00\/kg\./);
    expect(f.readme.match(/^ {2}plate \d: .*\$\d+\.\d\d/gm)).toHaveLength(4);

    /* The arithmetic, against the page's own weight: grams over a thousand, times the
       price. Each row's cost is that row's grams priced. */
    const want = await page.evaluate(() => (jobEstimate().grams / 1000 * 20).toFixed(2));
    expect(f.totals).toContain(`about $${want}`);
    const row = await page.evaluate(() => {
      const t = types()[0], g = geomFor(t.b).vol * t.qty / 1000 * PLA_DENSITY;
      return `${g.toFixed(0)} g · $${(g / 1000 * 20).toFixed(2)}`;
    });
    expect(f.rows[0]).toBe(row);

    await H.setField(page, 'filPrice', '');
    for (const t of everyText(await binsFigures(page)))
      expect(t, 'money left behind after the price was cleared').not.toMatch(MONEY);
  });

  test('baseplates: no cost until a price is set, then beside every gram figure, then gone', async ({ page }) => {
    page.__errors = await H.openPlates(page);
    await expect(page.locator('#filPrice')).toHaveValue('');
    for (const t of everyText(await platesFigures(page)))
      expect(t, 'money shown with no price set').not.toMatch(/[$£€]\s?\d/);

    await H.setField(page, 'filPrice', '24.5');
    const f = await platesFigures(page);
    expect(f.rows.length, 'fixture: the default drawer is four pieces').toBe(4);
    for (const r of f.rows) expect(r).toMatch(/^\d+ g · \$\d+\.\d\d$/);
    for (const p of f.plates) expect(p).toMatch(/\d+ g · \$\d+\.\d\d · ≈/);
    expect(f.summary).toMatch(/^In all: \d+ g · \$\d+\.\d\d · about /);
    expect(f.dialog).toMatch(/about \d+ g of PLA \(about \$\d+\.\d\d at \$24\.50\/kg\)/);
    for (const r of f.plateRows) expect(r).toMatch(/\d+ g · \$\d+\.\d\d · ≈/);
    expect(f.readme).toMatch(/Material: about \d+ g of PLA \(about \$\d+\.\d\d at \$24\.50\/kg\)/);
    expect(f.readme.match(/^ {2}plate \d: .*\$\d+\.\d\d/gm)).toHaveLength(4);
    const want = await page.evaluate(() => (materialGrams() / 1000 * 24.5).toFixed(2));
    expect(f.dialog).toContain(`about $${want} at`);

    await H.setField(page, 'filPrice', '');
    for (const t of everyText(await platesFigures(page)))
      expect(t, 'money left behind after the price was cleared').not.toMatch(MONEY);
  });

  test('a price survives a reload, and is kept under one key as JSON', async ({ page }) => {
    await binsJob(page);
    await H.setField(page, 'filPrice', '18.99');
    await H.setField(page, 'filSym', '€');
    expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), KEY)))
      .toEqual({ price: 18.99, sym: '€', speed: 'auto' });
    await page.reload();
    await page.waitForFunction(() => !!document.getElementById('fillmap'));
    await page.waitForTimeout(400);
    await expect(page.locator('#filPrice')).toHaveValue('18.99');
    await expect(page.locator('#filSym')).toHaveValue('€');
    await expect(page.locator('#totals')).toContainText(/about €\d+\.\d\d/);
  });

  /* One key, both tools: a price typed on the baseplates page is the bins page's price
     too. Over HTTP, because what one page stores for the next is only dependable on a
     real origin (see serveRoot). Then back again, the other way. */
  test('a price set on one tool is the price on the other', async ({ page }) => {
    const srv = await H.serveRoot();
    try {
      page.__errors = [];
      page.on('pageerror', (e) => page.__errors.push(String(e)));
      await page.goto(srv.base);
      await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                                 null, { timeout: 20000 });
      await H.setField(page, 'filPrice', '30');
      await H.setField(page, 'printSpeed', 'fast');
      await page.goto(srv.base + 'bins/');
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await page.waitForTimeout(300);
      await expect(page.locator('#filPrice')).toHaveValue('30');
      await expect(page.locator('#printSpeed')).toHaveValue('fast');
      await page.locator('#fillRest').click();
      await page.waitForTimeout(400);
      await expect(page.locator('#totals')).toContainText(/about \$\d+\.\d\d/);

      await H.setField(page, 'filPrice', '12');
      await page.goto(srv.base);
      await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                                 null, { timeout: 20000 });
      await expect(page.locator('#filPrice')).toHaveValue('12');
      await expect(page.locator('#pieceRows')).toContainText(/\$\d+\.\d\d/);
    } finally {
      await srv.close();
    }
  });

  /* The price is the viewer's. A link that carried it would tell a friend what your
     filament costs, and set theirs; a saved drawer that carried it would bring back an
     old price with an old drawer. */
  test('the price and the speed never reach the link or the saved layout', async ({ page }) => {
    await binsJob(page);
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => [shareLink(), designLink()]);
    await H.setField(page, 'filPrice', '23.75');
    await H.setField(page, 'printSpeed', 'fast');
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => [shareLink(), designLink(),
                                             localStorage.getItem('drawerforge:bins:v1')]);
    expect(after.slice(0, 2)).toEqual(before);
    for (const s of after) expect(s).not.toMatch(/23\.75|fast/);

    page.__errors = [...page.__errors, ...await H.openPlates(page)];
    const plates = await page.evaluate(() => shareLink());
    expect(plates).not.toMatch(/23\.75|fast/);
  });

  /* Private windows and blocked site data throw on any touch of localStorage. The fields
     still work for the visit; they are just not remembered. */
  test('with storage refused, a price still works for the visit', async ({ page }) => {
    await page.addInitScript(() => {
      const no = () => { throw new DOMException('denied', 'SecurityError'); };
      Storage.prototype.getItem = no;
      Storage.prototype.setItem = no;
    });
    await binsJob(page);
    await H.setField(page, 'filPrice', '20');
    await expect(page.locator('#totals')).toContainText(/about \$\d+\.\d\d/);
  });
});

/* The symbol starts from the browser's region and is only ever a default: nothing is
   shown until a price is typed beside it. A language with no region, or a region whose
   currency is not on the short list, gets no symbol and the number alone. */
for (const [locale, sym] of [['en-GB', '£'], ['de-DE', '€'], ['en-US', '$'], ['ja-JP', '']]) {
  test.describe(`a browser in ${locale}`, () => {
    test.use({ locale });
    test(`starts the currency on "${sym || 'no symbol'}"`, async ({ page }) => {
      page.__errors = await H.openBins(page);
      await expect(page.locator('#filSym')).toHaveValue(sym);
      await page.locator('#fillRest').click();
      await H.setField(page, 'filPrice', '20');
      const totals = await page.locator('#totals').textContent();
      expect(totals).toMatch(new RegExp(`about ${sym.replace('$', '\\$')}\\d+\\.\\d\\d`));
      if (!sym) expect(totals).not.toMatch(/[$£€]/);
    });
  });
}

test.describe('the print time', () => {
  test('rounds up, to 5 minutes under an hour and 15 above, and reads as a duration', async ({ page }) => {
    page.__errors = await H.openBins(page);
    const r = await page.evaluate(() => [1, 29 * 60, 31 * 60, 59.5 * 60, 61 * 60, 135 * 60, 136 * 60]
      .map((s) => ESTIMATE.duration(ESTIMATE.roundMinutes(s))));
    expect(r).toEqual(['5 min', '30 min', '35 min', '1 h', '1 h 15 min', '2 h 15 min', '2 h 30 min']);
  });

  /* Not a promise, so never shown as one: every total says it is a rough estimate and
     that only a slicer can time it. The total is the plates' times added up, as shown. */
  test('bins: a time per plate and in total, which add up and say what they are', async ({ page }) => {
    await binsJob(page);
    const f = await binsFigures(page);
    const mins = (s) => { const m = /≈ (?:(\d+) h)? ?(?:(\d+) min)?/.exec(s); return (+m[1] || 0) * 60 + (+m[2] || 0); };
    const plates = f.plates.map(mins);
    expect(plates).toHaveLength(4);
    for (const m of plates) expect(m).toBeGreaterThan(0);
    const total = await page.evaluate(() => jobEstimate().min);
    expect(total).toBe(plates.reduce((a, b) => a + b, 0));
    expect(f.summary).toContain(`about ${await page.evaluate((m) => ESTIMATE.duration(m), total)} of printing`);
    for (const t of [f.summary, f.dialog]) expect(t).toMatch(/rough estimate; only your slicer can time it/);
    expect(f.readme).toMatch(/Print time: roughly .* over 4 plates\.\nThat is a rough estimate/);
  });

  test('baseplates: a time per plate and in total, which add up and say what they are', async ({ page }) => {
    page.__errors = await H.openPlates(page);
    const f = await platesFigures(page);
    expect(f.plates).toHaveLength(4);
    for (const p of f.plates) expect(p).toMatch(/≈ \d+ (h|min)/);
    const job = await page.evaluate(() => jobTime());
    expect(job.min).toBe(job.plates.reduce((a, e) => a + e.min, 0));
    expect(f.summary).toMatch(/rough estimate; only your slicer can time it/);
    expect(f.dialog).toMatch(/roughly .* of printing over 4 plates on a standard printer \(a rough estimate/);
    expect(f.readme).toMatch(/Print time: roughly .* on a standard printer over 4 plates\./);
  });

  /* The kind of printer comes from the list, where tools/printers.js marks the fast ones,
     and the override beats it. A size-only entry and Custom are timed as standard: the
     slower guess is the safer one. */
  test('the printer list sets the speed, the override beats it, and fast is faster', async ({ page }) => {
    await binsJob(page);
    const now = () => page.evaluate(() => ({ min: jobEstimate().min, cls: speedNow(),
      label: document.querySelector('#printSpeed option[value="auto"]').textContent }));
    const custom = await now();
    expect(custom.cls).toBe('standard');
    expect(custom.label).toBe('From the printer: standard');

    await H.setField(page, 'bedPreset', 'bambu-p1');
    await page.waitForTimeout(300);
    const bambu = await now();
    expect(bambu.cls).toBe('fast');
    expect(bambu.label).toBe('From the printer: fast');
    await expect(page.locator('#plateSummary')).toContainText('on a fast printer');

    await H.setField(page, 'bedPreset', 'creality-ender-3-v3');
    await page.waitForTimeout(300);
    expect((await now()).cls).toBe('standard');

    await H.setField(page, 'bedPreset', 'bambu-p1');
    await H.setField(page, 'printSpeed', 'standard');
    const forced = await now();
    expect(forced.cls).toBe('standard');
    await expect(page.locator('#plateSummary')).toContainText('on a standard printer');
    // the same plates, timed as a fast printer and as a standard one
    expect(bambu.min).toBeLessThan(forced.min);
  });

  /* Conservative is the brief, and these are the bounds it is held to: a 1×1×3 bin on its
     own is half an hour or so on a fast printer and an hour or so on a classic one, and a
     plate of them is more than one of them but less than the sum of each printed alone. */
  test('the figures are in the right range, and conservative', async ({ page }) => {
    page.__errors = await H.openBins(page);
    const t = await page.evaluate(() => {
      const b = Object.assign({}, state, { u: 1, v: 1, hUnits: 3, cells: null });
      const one = { vol: geomFor(b).vol, h: geomFor(b).meta.totalH, z: 0 };
      const s = (parts, c) => ESTIMATE.plateSeconds(parts, c) / 60;
      return { fast: s([one], 'fast'), std: s([one], 'standard'),
               nine: s(Array(9).fill(one), 'fast') };
    });
    expect(t.fast).toBeGreaterThan(28); expect(t.fast).toBeLessThan(45);
    expect(t.std).toBeGreaterThan(55);  expect(t.std).toBeLessThan(90);
    expect(t.nine).toBeGreaterThan(t.fast * 3);
    expect(t.nine).toBeLessThan(t.fast * 9);
  });

  test('the override is remembered', async ({ page }) => {
    page.__errors = await H.openBins(page);
    await H.setField(page, 'printSpeed', 'fast');
    await page.reload();
    await page.waitForFunction(() => !!document.getElementById('fillmap'));
    await page.waitForTimeout(300);
    await expect(page.locator('#printSpeed')).toHaveValue('fast');
  });
});

/* The ZIP is what goes to the printer, so the README inside it has to carry the same
   figures the page does — read out of the real download, not out of the function. */
test('the README in the bins ZIP carries the cost and the time', async ({ page }) => {
  await binsJob(page);
  await H.setField(page, 'filPrice', '20');
  await page.locator('#openExport').click();
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="zip"]').click(),
  ]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  const readme = await zip.files['README.txt'].async('string');
  expect(readme).toMatch(/about \$\d+\.\d\d at \$20\.00\/kg/);
  expect(readme).toMatch(/Print time: roughly /);
  expect(readme).toMatch(/your slicer gives the real figure/);
});
