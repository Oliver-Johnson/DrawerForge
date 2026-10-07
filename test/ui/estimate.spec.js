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

  /* Half of Europe writes a price with a decimal comma. The field was a number input,
     and Chromium took "12,50" typed into it as 1250: saved, shared with the other tool,
     written into the README, and the totals said about $199.15. A lone comma is a
     decimal point now, and anything else that is not a plain number is refused out
     loud — the field marked, a line saying what to type, and the price in use left as
     it was — rather than guessed at. */
  for (const tool of ['bins', 'baseplates']) {
    test(`${tool}: a decimal comma is a decimal point, and anything else is refused, not guessed`, async ({ page }) => {
      page.__errors = await (tool === 'bins' ? H.openBins(page) : H.openPlates(page));
      // typed into as a person types, so on bins the printer panel is opened first
      if (tool === 'bins') await page.locator('#s-printer .ph button').click();
      const price = page.locator('#filPrice'), err = page.locator('#filPriceErr');
      const inUse = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').price, KEY);
      await price.click();
      await price.pressSequentially('12,50');
      await page.waitForTimeout(300);
      expect(await inUse()).toBe(12.5);
      await expect(price).not.toHaveAttribute('aria-invalid', 'true');
      await expect(err).toBeHidden();

      for (const bad of ['12,50 €', '1.234,50', '12,5,0', '-5', 'twelve', '1e3']) {
        await price.fill(bad);
        await page.waitForTimeout(250);
        await expect(price, bad).toHaveAttribute('aria-invalid', 'true');
        await expect(err, bad).toBeVisible();
        await expect(err, bad).toContainText('$12.50/kg');
        expect(await inUse(), bad).toBe(12.5);
      }
      // left, it keeps what was typed, so it can be put right
      await price.press('Tab');
      await page.waitForTimeout(250);
      await expect(price).toHaveValue('1e3');
      await price.fill('22,99');
      await page.waitForTimeout(250);
      expect(await inUse()).toBe(22.99);
      await expect(price).toHaveAttribute('aria-invalid', 'false');
      await expect(err).toBeHidden();
      await price.fill('');                  // empty is no price, not a mistake
      await page.waitForTimeout(250);
      expect(await inUse()).toBe(null);
      await expect(err).toBeHidden();
    });
  }

  /* Two tabs. A tab whose price box was left focused took a price set in the other but
     went on showing its own, and its next change of currency read that stale box and
     wrote it back over the new price. Untouched, the box now shows the new price at
     once; typed into, it keeps what is being typed until it is left, and a currency or
     speed change never reads it. */
  test('a tab left with its price box focused does not write a stale price back', async ({ page, context }) => {
    const srv = await H.serveRoot();
    try {
      page.__errors = [];
      page.on('pageerror', (e) => page.__errors.push(String(e)));
      const open = async (p) => {
        await p.goto(srv.base + 'bins/');
        await p.waitForFunction(() => !!document.getElementById('fillmap'));
        await p.waitForTimeout(300);
        await p.locator('#s-printer .ph button').click();
      };
      const inUse = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').price, KEY);
      await open(page);
      const other = await context.newPage();
      await open(other);

      await page.locator('#filPrice').click();          // focused, nothing typed
      await other.locator('#filPrice').fill('40');
      await page.waitForTimeout(400);
      await expect(page.locator('#filPrice')).toHaveValue('40');

      await page.locator('#filPrice').fill('20');       // typed into, and left focused
      await page.waitForTimeout(250);
      await other.locator('#filPrice').fill('30');
      await page.waitForTimeout(400);
      expect(await inUse()).toBe(30);
      await page.selectOption('#filSym', '€');
      await page.waitForTimeout(250);
      expect(await inUse()).toBe(30);
      await page.locator('#filPrice').press('Tab');
      await page.waitForTimeout(250);
      await expect(page.locator('#filPrice')).toHaveValue('30');
      expect(await inUse()).toBe(30);
    } finally {
      await srv.close();
    }
  });

  /* Past any real spool the price is held at 10000, and the field used to go on showing
     the 1000000000 typed over costs worked out at 10000. Once it is left it shows the
     price in use, as the other fields do; under the caret it is left alone. */
  test('a price past the limit shows the price in use once the field is left', async ({ page }) => {
    await binsJob(page);
    await page.locator('#s-printer .ph button').click();
    const price = page.locator('#filPrice');
    await price.fill('1000000000');
    await page.waitForTimeout(250);
    await expect(price).toHaveValue('1000000000');
    await price.press('Tab');
    await page.waitForTimeout(250);
    await expect(price).toHaveValue('10000');
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

  /* A piece too big for the bed is weighed and priced with the rest, but has no plate to
     time, so every time that leaves it out says so. A 330 mm drawer split for a 220 x 180
     bed leaves A1 too big, and "In all" gave the grams and cost of four pieces beside the
     time of three, as if it were the whole job. */
  test('baseplates: with a piece too big for the bed, the time says it is for the plates that fit', async ({ page }) => {
    page.__errors = await H.openPlates(page);
    /* A new hash on the open page is a same-document navigation, which the page answers
       by reloading itself, so the wait below runs on in the new document, and there it
       can look before the page's script has defined printPlan at all. */
    await page.goto(H.PLATES_URL + '#w=330&d=330&bw=220&bd=180&mm=custom&ml=5&mr=0&mf=5&mb=0&cn=puzzle&v=2');
    await page.waitForFunction(() => typeof printPlan !== 'undefined' && printPlan && printPlan.over.length > 0);
    const f = await platesFigures(page);
    expect(f.summary).toMatch(/^In all: .* of printing on a standard printer for the plates that fit \(a rough/);
    expect(f.dialog).toMatch(/roughly .* of printing on a standard printer for the plates that fit \(/);
    expect(f.readme).toMatch(/Print time: roughly .* on a standard printer for the plates that fit\./);
    // the plates are said once, not "over 3 plates for the plates that fit"
    for (const t of [f.summary, f.dialog, f.readme]) expect(t).not.toMatch(/over \d plates? (on|for)/);
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

  /* Custom keeps the bed it had, so there is nothing to rebuild, but it is not a printer
     known to be fast. Going to it from a Bambu left the menu saying "fast" and the
     summary timing a fast printer, while the dialog and the README timed it as
     standard. */
  test('bins: choosing Custom after a fast printer retimes the page as well', async ({ page }) => {
    await binsJob(page);
    await H.setField(page, 'bedPreset', 'bambu-p1');
    await page.waitForTimeout(300);
    await expect(page.locator('#printSpeed option[value="auto"]')).toHaveText('From the printer: fast');
    await expect(page.locator('#plateSummary')).toContainText('on a fast printer');
    await H.setField(page, 'bedPreset', 'custom');
    await page.waitForTimeout(300);
    await expect(page.locator('#printSpeed option[value="auto"]')).toHaveText('From the printer: standard');
    await expect(page.locator('#plateSummary')).toContainText('on a standard printer');
    const f = await binsFigures(page);
    const total = await page.evaluate(() => ESTIMATE.duration(jobEstimate().min));
    for (const t of [f.summary, f.dialog]) expect(t).toContain(total);
    expect(f.summary).toContain('standard printer');
    expect(f.dialog).toContain('standard printer');
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

/* And in Bins, where the page already said it: the README weighs every bin, a 3 x 1 too
   long for a 120 mm bed among them, so its time says it is for the plates that fit. */
test('the bins README and download dialog say their time leaves out a bin too big for the bed', async ({ page }) => {
  page.__errors = await H.openBins(page);
  await H.setField(page, 'bedPreset', 'custom');
  await H.setField(page, 'bedW', 120);
  await H.setField(page, 'bedD', 120);
  await H.dragCells(page, [0, 0], [2, 0]);
  await H.dragCells(page, [0, 1], [0, 1]);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => printPlan.plates.filter((p) => p.overflow).length),
         'fixture: the 3 x 1 is too big').toBe(1);
  await expect(page.locator('#plateSummary')).toContainText('for the plates that fit');
  expect(await page.evaluate(() => layoutReadme()))
    .toMatch(/Print time: roughly .* printer for the plates that fit\./);
  // and the download dialog, whose line above already says the bin is left off
  const f = await binsFigures(page);
  expect(f.dialog).toMatch(/roughly .* of printing on a standard printer for the plates that fit \(/);
});

/* What a bin with removable dividers weighs.
 *
 * Its dividers are not built into it. It gets two pairs of rails for each, and each plate
 * is a part of its own, which the plan weighs beside the bin. The bin's estimate counted a
 * wall per divider all the same, so the rails went uncounted and every plate was weighed
 * twice, once in its bin and once as itself: a 1x1x3 with two removable dividers each way
 * came out, with its plates, 10% over what their meshes enclose and a 2x1x6 with three
 * across and two along 21% over, where a bin with none, or with fixed ones, comes out a few
 * percent under. A bin with fixed dividers is held to exactly what it weighed.
 *
 * And the plates go in: the lip has a notch at each end of each plate, which the bin's
 * estimate takes off its lip, and plates both ways halve where they cross, so each is
 * weighed by its own outline, slots and all, rather than as the rectangle round it.
 */
const RAILED = [[1, 1, 3, 2, 2], [2, 1, 6, 3, 2]];       // u, v, units, across, along
// one bin as a link writes it, with dividers both ways, removable or fixed
const divBin = (x, y, [u, v, h, divX, divY], removable) =>
  [x, y, u, v, h, 1.2, 1.2, divX, divY, 0, 1, 1, 1, 1, 0, 0, 0, 0, removable ? 1 : 0, 0, 15].join('-');

test.describe('the weight', () => {
  test('a bin with removable dividers weighs its rails, not a wall for each plate', async ({ page }) => {
    page.__errors = await H.openBins(page);
    const r = await page.evaluate((cases) => cases.map(([u, v, hUnits, divX, divY]) => {
      const bin = (more) => Object.assign({}, state, { x: 0, y: 0, u, v, hUnits, cells: null,
        edges: null, solid: false, scoop: 0, label: 0, divX: 0, divY: 0, divRemovable: false }, more);
      const plain = bin({}), railed = bin({ divX, divY, divRemovable: true });
      const built = (b, more) => buildBin(G, Object.assign(binCfg(b), more));
      // every plate the bin takes, halving slots and all
      const plates = dividerPlates(G, binCfg(railed)).reduce((a, p) => a + p.qty * meshVolume(p.polys), 0);
      const m = built(railed).meta, deep = m.H - m.floorZ;
      /* With the lip off, what the dividers add is the rails alone; with it on, the lip
         loses a notch at each end of each plate as well. */
      const noLip = (b) => meshVolume(built(b, { lip: false }).polys);
      const mesh = meshVolume(built(railed).polys), meshPlain = meshVolume(built(plain).polys);
      return { est: volumeMm3(railed).raw, estPlain: volumeMm3(plain).raw, plates, mesh, meshPlain,
               rails: noLip(railed) - noLip(plain), notches: (meshPlain - noLip(plain)) - (mesh - noLip(railed)),
               /* The rails as the mesh has them reach a BLOAT into the wall and a BLOAT into
                  the floor, which meshVolume, adding up shells that overlap, counts twice
                  where the plastic is there once. */
               trim: RAIL_D / (RAIL_D + BLOAT) * deep / (deep + BLOAT) };
    }), RAILED);
    for (const [i, x] of r.entries()) {
      const what = `${RAILED[i]}`;
      // the bin and its plates, within a few percent of what their meshes enclose
      expect(Math.abs((x.est + x.plates) / (x.mesh + x.plates) - 1), what).toBeLessThan(0.06);
      // and what the dividers add to the bin is the rails buildBin adds to it, exactly,
      // less the notches it cuts in the lip for the plates to go in past
      expect(x.notches, `${what}: fixture, the lip is notched`).toBeGreaterThan(0);
      expect((x.est - x.estPlain) / (x.rails * x.trim - x.notches), what).toBeCloseTo(1, 4);
    }
  });

  /* Wherever the page totals the job, the plates are in it once, as their own parts, and
     the bins beside them weigh their rails. A fixed divider is a wall of its bin and has
     no plate, and the fixed-divider bins of the same sizes weigh what they did. */
  test('the job weighs each plate once, and a fixed-divider bin what it did', async ({ page }) => {
    page.__errors = [];
    page.on('pageerror', (e) => page.__errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') page.__errors.push(m.text()); });
    await page.goto(H.BINS_URL + '#bl=' + [divBin(0, 0, RAILED[0], true), divBin(1, 0, RAILED[1], true),
                                           divBin(3, 0, RAILED[0], false), divBin(0, 1, RAILED[1], false)].join('_'));
    await page.waitForFunction(() => typeof THREE !== 'undefined' && !!document.getElementById('fillmap'));
    await page.waitForTimeout(600);
    const f = await page.evaluate(() => {
      const bins = types().reduce((a, t) => a + volumeMm3(t.b).filament * t.qty, 0);
      // each plate as its mesh encloses it, halving slots and all
      const plates = dividerParts().reduce((a, d) => a + meshVolume(d.polys) * d.qty, 0);
      return { want: gramsOf(bins + plates), job: jobEstimate().grams,
               plan: jobEstimate().plates.reduce((a, e) => a + e.grams, 0),
               loose: looseParts(), plateCount: printPlan.plates.length,
               fixed: types().filter((t) => !t.b.divRemovable).map((t) => volumeMm3(t.b).raw),
               rows: [...document.querySelectorAll('#typeRows tr td:nth-child(4)')].map((e) => e.textContent) };
    });
    expect(f.loose, 'fixture: two and two plates, and three and two').toBe('9 dividers');
    expect(f.plateCount, 'fixture: one plate, so it carries the whole job').toBe(1);
    expect(f.job).toBeCloseTo(f.want, 6);
    expect(f.plan).toBeCloseTo(f.want, 6);
    // the railed 1x1x3 and 2x1x6 were 13 g and 41 g, as their fixed twins still are
    expect(f.rows).toEqual(['10 g', '27 g', '13 g', '41 g']);
    expect(f.fixed[0]).toBeCloseTo(15799.3449, 3);
    expect(f.fixed[1]).toBeCloseTo(42850.1545, 3);

    /* and every total says so: 114 g, where it was 133. 116 until the plates halved where
       they cross, a slot each, and the lips took a notch at each end of each plate. */
    const g = f.want.toFixed(0);
    expect(g).toBe('114');
    const t = await binsFigures(page);
    expect(t.totals).toContain(`≈ ${g} g PLA at 15% infill, 9 dividers included`);
    expect(t.plates).toEqual([expect.stringContaining(`4 bins + 9 dividers${g} g`)]);
    expect(t.dialog).toContain(`about ${g} g of PLA at 15% infill, 9 dividers included`);
    expect(t.plateRows.every((s) => s.includes(`${g} g`))).toBe(true);
    expect(t.readme).toContain(`Total: 4 bins plus 9 dividers, about ${g} g of PLA.`);
    expect(t.readme).toContain(`plate 1: 4 bins + 9 dividers, about ${g} g,`);
  });
});
