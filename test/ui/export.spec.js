/* The download dialog, on both tools.
 *
 * Export used to be a panel that sat in the page while you worked. It is now one
 * button and a dialog, and the dialog's whole purpose is to answer three questions
 * before you download anything: what is this, will it fit my printer, and which files
 * am I about to get. Each test below is one of those, plus getting in and out again —
 * because a modal you cannot close is worse than a panel you can ignore.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
// the library the pages themselves use, so reading a zip back costs no dependency
const JSZip = require('../../vendor/jszip.min.js');

/* Both pages carry the same dialog markup, so the open/close behaviour is worth
   driving identically on each rather than trusting that it was copied correctly. */
for (const tool of [
  // read out of each page's own model — the DOM is what is under test, so it cannot
  // also be the thing that says how many plates there should have been
  { name: 'bins', open: H.openBins, plates: () => goodPlates().length },
  { name: 'baseplates', open: H.openPlates, plates: () => printPlan.plates.length },
]) {
  test.describe(tool.name, () => {
    test.beforeEach(async ({ page }) => {
      page.__errors = await tool.open(page);
      if (tool.name === 'bins') {
        await page.locator('#fillRest').click();      // something to export
        await page.waitForTimeout(400);
      }
    });
    test.afterEach(async ({ page }) => {
      expect(page.__errors, 'the page threw while being driven').toEqual([]);
    });

    test('the dialog opens, and every way out of it works', async ({ page }) => {
      const dlg = page.locator('#exportDlg');
      await expect(dlg).toBeHidden();

      await page.locator('#openExport').click();
      await expect(dlg).toBeVisible();

      await page.locator('#exportClose').click();
      await expect(dlg).toBeHidden();

      await page.locator('#openExport').click();
      await expect(dlg).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
    });

    /* Selecting text in the summary and releasing outside the box used to shut the
       dialog, because a click whose two ends differ reports their common ancestor. */
    test('a drag out of the dialog does not dismiss it', async ({ page }) => {
      await page.locator('#openExport').click();
      const dlg = page.locator('#exportDlg');
      const box = await page.locator('#exDesign').boundingBox();
      await page.mouse.move(box.x + 10, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(dlg).toBeVisible();

      // a click that begins and ends on the backdrop still closes it
      const d = await dlg.boundingBox();
      await page.mouse.click(Math.max(4, d.x / 2), d.y + 20);
      await expect(dlg).toBeHidden();
    });

    test('there is a download for every plate, and one for all of them', async ({ page }) => {
      await page.locator('#openExport').click();
      const n = await page.evaluate(tool.plates);
      expect(n, 'the fixture should produce at least one plate').toBeGreaterThan(0);

      await expect(page.locator('#exFiles [data-ex="plate"]')).toHaveCount(n);
      await expect(page.locator('#exFiles [data-ex="allplates"]')).toHaveCount(1);
      for (let i = 0; i < n; i++)
        await expect(page.locator('#exFiles .exrow').filter({ hasText: `Plate ${i + 1}` })).toHaveCount(1);
    });

    /* Every download path moved when the panel became a dialog, so at least one of
       them has to be taken end to end rather than merely rendered. A single plate is
       the one worth taking: it is the new affordance, and it exercises the same
       build-transform-zip path the combined export uses. */
    test('a single plate really downloads', async ({ page }) => {
      await page.locator('#openExport').click();
      const [dl] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#exFiles [data-ex="plate"]').first().click(),
      ]);
      expect(dl.suggestedFilename()).toMatch(/plate-1\.3mf$/);
      expect(fs.statSync(await dl.path()).size).toBeGreaterThan(500);
    });

    test('it says whether the design fits the configured bed', async ({ page }) => {
      await page.locator('#openExport').click();
      const fit = page.locator('#exFit');
      await expect(fit).toHaveClass(/exfit ok/);
      await expect(fit).toContainText(/fits? your 256 × 256 mm bed/);
      await page.locator('#exportClose').click();

      // shrink the bed below a single cell, so nothing at all can fit
      await H.setField(page, 'bedPreset', 'custom');
      await H.setField(page, 'bedW', 30);
      await H.setField(page, 'bedD', 30);
      await page.waitForTimeout(700);
      await page.locator('#openExport').click();
      await expect(fit).toHaveClass(/exfit bad/);
      await expect(fit).toContainText(/too big|not fit/);
    });

    test('it describes the design, not just the files', async ({ page }) => {
      await page.locator('#openExport').click();
      await expect(page.locator('#exDesign')).toContainText('306 × 380 mm drawer');
      await expect(page.locator('#exFiles .exrow').first()).toBeVisible();
    });
  });
}

/* The plate numbering bug, on a layout that actually has the shape that caused it.
 *
 * A bin too big for the bed gets a plate of its own that is never exported, and those
 * sort to the front. Numbering the downloads by raw index therefore skipped the front
 * of the range: with four overflow plates the files came out plate-5 to plate-14 while
 * the page, the print plan and the dialog all said 1 to 10. A fixture with no overflow
 * plates cannot see the difference — the first version of this test had one, and passed
 * against the unfixed code.
 */
test('plate numbering skips the plates that cannot be printed, not the numbers', async ({ page }) => {
  await H.openBins(page);
  await H.setField(page, 'drawerW', 600);
  await H.setField(page, 'drawerD', 500);
  await H.setField(page, 'bedPreset', 'custom');
  await H.setField(page, 'bedW', 120);
  await H.setField(page, 'bedD', 120);
  await H.setField(page, 'u', 5);
  await H.setField(page, 'v', 5);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(1200);

  const plan = await page.evaluate(() => ({
    total: printPlan.plates.length,
    good: goodPlates().length,
    firstGood: goodPlates()[0][1],
  }));
  /* Fourteen: the bins that fit are all on plates that print. It read ten while the
     packer put four plates' worth of them on the overflow plates, where no file had
     them. */
  expect(plan.good, 'fixture: several printable plates').toBe(14);
  expect(plan.firstGood, 'fixture: unprintable plates must sort ahead of them')
    .toBeGreaterThan(0);

  await page.locator('#openExport').click();
  const labels = await page.locator('#exFiles [data-ex="plate"]')
    .evaluateAll((btns) => btns.map((b) => b.closest('.exrow').querySelector('.nm').textContent));
  expect(labels).toEqual(Array.from({ length: 14 }, (_, i) => `Plate ${i + 1}`));

  // the last row must be plate 14, not plate 18
  const [last] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="plate"]').last().click(),
  ]);
  expect(last.suggestedFilename()).toBe('bin-plate-14.3mf');

  // and the zip has to agree with the buttons, entry for entry
  const [zipDl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="allplates"]').click(),
  ]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await zipDl.path()));
  expect(Object.keys(zip.files).sort()).toEqual(
    Array.from({ length: 14 }, (_, i) => `bin-plate-${i + 1}.3mf`).sort());
});

/* "Everything, with a README" has to mean everything. The ZIP kept its own list of
   which connectors need loose parts and that list left out H-clips, so an hclip
   download arrived with a README telling the reader to press a clip into each junction
   and no clip anywhere in the file. */
test('the everything ZIP carries the connector parts for every joint that needs them',
  async ({ page }) => {
    await H.openPlates(page);
    // a shallow drawer: still wider than the bed, so it still splits and still has
    // seams to key, but two pieces and one plate rather than four and four
    await H.setField(page, 'drawerD', 180);
    for (const connector of ['hclip', 'bowtie']) {
      await H.setField(page, 'connector', connector);
      await page.waitForFunction(
        () => /ready/.test(document.getElementById('pieceTail').textContent),
        null, { timeout: 20000 });
      await page.evaluate(() => document.getElementById('openExport').click());
      const [dl] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#exFiles [data-ex="zip"]').click(),
      ]);
      const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
      const names = Object.keys(zip.files);
      expect(names.filter((n) => /(keys|clips)-x\d+\.stl$/.test(n)),
             `${connector}: the ZIP must contain the parts its README tells you to press in`)
        .toHaveLength(1);
      await page.locator('#exportClose').click();
    }
  });

/* The dialog is rebuilt on open and never again — which was fine until it started
   claiming otherwise. The baseplates page builds asynchronously, so opening it mid-build
   showed a half-built list under the words "the meshes below appear as they finish",
   and they never did: you had to close and reopen. Throttled hard so the build is still
   running when the dialog opens, which is the only way to see it. */
test('the baseplates dialog keeps up with a build running behind it', async ({ page }) => {
  const client = await page.context().newCDPSession(page);
  await H.openPlates(page);
  // after the navigation, not before: the override does not survive the page load
  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });

  /* A wide drawer with magnet pockets: the pockets are the CSG-subtract path, which is
     by far the slowest thing either tool does, and throttled it takes about eight
     seconds — long enough to open the dialog while the build is genuinely mid-flight.
     The piece table is the synchronisation point: it reads "building n/N" for exactly
     as long as runBuild is working. */
  await page.evaluate(() => {
    const m = document.getElementById('magnets');
    m.checked = true;
    m.dispatchEvent(new Event('change', { bubbles: true }));
    const e = document.getElementById('drawerW');
    e.value = '900';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  /* The status line under the preview is the exact signal: runBuild writes the id of
     the piece it is working on and clears it when the last one lands. The piece table
     is not — it reads "building" from the moment the layout changes, which is before
     the debounce has even fired. */
  await page.waitForFunction(
    () => /building/.test(document.getElementById('status').textContent), null,
    { timeout: 20000 });
  /* Opened with the element's own click, not the locator's. Under a 6x throttle
     Playwright's actionability checks and scroll took seconds, and the build we are
     trying to catch had finished before the pointer landed. */
  /* One synchronous snapshot rather than a series of expects. Two polled assertions
     about a state that is actively moving will race each other, and the second one
     failing because the fix worked is not a useful failure. */
  const midBuild = await page.evaluate(() => {
    document.getElementById('openExport').click();
    return { cls: document.getElementById('exFit').className,
             txt: document.getElementById('exFit').textContent,
             zip: document.querySelector('#exFiles [data-ex="zip"]').disabled,
             open: document.getElementById('exportDlg').open };
  });
  expect(midBuild.open).toBe(true);
  expect(midBuild.cls).toMatch(/wait/);
  expect(midBuild.txt).toContain('Still building');
  expect(midBuild.zip, 'the ZIP cannot be offered before the meshes exist').toBe(true);

  // without closing it: the same dialog has to arrive at the finished state on its own
  await expect(page.locator('#exFit')).toHaveClass(/exfit ok/, { timeout: 45000 });
  await expect(page.locator('#exFiles [data-ex="zip"]')).toBeEnabled();
  await expect(page.locator('#exFiles [data-ex="plate"]').first()).toBeVisible();
  await expect(page.locator('#exFiles .exrow').filter({ hasText: 'Piece A1' }))
    .toContainText(/KB|MB/);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
});

/* The bins map writes an inline grid-template-columns to size itself beside the 3D
   preview. An inline style beats the media query that collapses that grid below
   1280 px, so on a phone it pinned a 320 px preview alongside the map and hung the
   card off the right of the screen. It now asks the element which layout it is in. */
for (const [width, tracks] of [[1440, 2], [1100, 1], [375, 1]]) {
  test(`the bins stage is ${tracks} column(s) wide at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await H.openBins(page);
    await expect
      .poll(() => page.evaluate(() =>
        getComputedStyle(document.querySelector('.stagetop'))
          .gridTemplateColumns.trim().split(/\s+/).length))
      .toBe(tracks);
  });
}

/* Measured at 375 px, the tools were 11 px text and 31 px controls throughout. These
   are the two numbers that matter on a phone, asserted against the rendered page so
   that a future stylesheet cannot quietly walk them back. The guide pages are in here
   because they share the stylesheet and were the one place 11 px survived the first
   pass — a claim about "the site" has to be tested on the site. */
const pageUrl = (rel) => pathToFileURL(path.join(H.ROOT, rel)).href;
for (const [name, rel, tool] of [
  ['baseplates', 'index.html', true],
  ['bins', 'bins/index.html', true],
  ['guide', 'guide/index.html', false],
  ['guide/split', 'guide/split/index.html', false],
  ['guide/drawer-sizes', 'guide/drawer-sizes/index.html', false],
]) {
  test(`${name} stays legible and tappable at 375 px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    if (tool) {
      await (name === 'bins' ? H.openBins : H.openPlates)(page);
      if (name === 'bins') {
        await page.locator('#fillRest').click();   // so the dialog has rows to audit
        await page.waitForTimeout(400);
      }
      // every panel open, so nothing escapes the audit by being collapsed
      await page.evaluate(() =>
        document.querySelectorAll('section.p.closed').forEach((s) => s.classList.remove('closed')));
      await page.locator('#openExport').click();
      await page.waitForTimeout(300);
    } else {
      await page.goto(pageUrl(rel));
      await page.waitForTimeout(300);
    }

    const bad = await page.evaluate(() => {
      const small = [], tiny = [];
      for (const e of document.querySelectorAll('body *')) {
        if (e.closest('svg') || e.tagName === 'SCRIPT' || e.tagName === 'STYLE') continue;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden') continue;
        const owns = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (owns && parseFloat(cs.fontSize) < 12)
          small.push(`${e.tagName}#${e.id || '-'} ${cs.fontSize}`);
        /* Checkboxes are excluded on purpose: every one of them is a 36x20 switch
           inside a .tog label, and the label is the thing a finger hits. Anchors are
           in when they are navigation or are dressed as buttons — a.ghost is the
           "back to baseplates" link, which is a button in everything but the tag. */
        const control = /^(BUTTON|SELECT|TEXTAREA)$/.test(e.tagName) ||
                        (e.tagName === 'INPUT' && e.type !== 'checkbox') ||
                        (e.tagName === 'A' && (!!e.closest('nav') || e.classList.contains('ghost')));
        if (control && r.height < 40) tiny.push(`${e.tagName}#${e.id || '-'} ${r.height.toFixed(1)}px`);
      }
      return { small, tiny };
    });
    expect(bad.small, 'text below 12px').toEqual([]);
    expect(bad.tiny, 'tap targets below 40px').toEqual([]);
  });
}

/* ---------- half-size bins, and the links from before them ----------------- */

// one bin as a link writes it: 21 fields, and a 22nd only when it asks for holes
const binAt = (x, y, u, v, h, rest = [1.2, 1.2, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 15]) =>
  [x, y, u, v, h, ...rest].join('-');
const holed = (x, y, u, v, h) => binAt(x, y, u, v, h, [1.2, 1.2, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 15, 1]);
async function zipOf(page, hash) {
  page.__errors = await H.openBins(page);
  await page.goto('about:blank');
  await page.goto(H.BINS_URL + '#' + hash);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await page.waitForTimeout(600);
  await page.locator('#openExport').click();
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="zip"]').click(),
  ]);
  return JSZip.loadAsync(fs.readFileSync(await dl.path()));
}

/* A half-size bin is named by its size like any other, 1.5 and all, and two the same are
   one file with a count. One whose holes boxes are ticked is built without them, since
   its quarter feet have no room, so its name does not promise magnets either. In the
   README, the layer holding half-size bins is mapped one letter per half cell, and a
   layer without any keeps the map it always had. */
test('half-size bins download under their own sizes, with no holes they cannot have',
  async ({ page }) => {
    const zip = await zipOf(page, 'bl=' + [binAt(0, 0, 1.5, 1, 3), binAt(1.5, 0, 1.5, 1, 3),
      holed(3, 0, 0.5, 2, 3), holed(4, 0, 2, 1, 3)].join('_') + '~' + binAt(0, 0, 3, 1, 2));
    expect(Object.keys(zip.files).sort()).toEqual([
      'README.txt', 'bin-0.5x2x3-qty1.stl', 'bin-1.5x1x3-qty2.stl',
      'bin-2x1x3-magnets-qty1.stl', 'bin-3x1x2-qty1.stl']);

    const readme = (await zip.file('README.txt').async('string')).split('\n');
    const layer = (k) => {
      const at = readme.findIndex((l) => l.startsWith(`LAYER ${k} `));
      return readme.slice(at, readme.indexOf('', at));
    };
    const one = layer(1), two = layer(2);
    expect(one[0]).toBe('LAYER 1 (front of the drawer at the bottom, one letter per half cell):');
    // a row per half cell, 9 cells deep; the front row last: A and B a cell and a half
    // wide, C half a cell wide and two cells deep, D two whole cells
    expect(one.slice(1, 19)).toHaveLength(18);
    expect(one[19]).toMatch(/^ {4}A = /);
    expect(one.slice(15, 19)).toEqual([
      '  . . . . . . C . . . . . . .',
      '  . . . . . . C . . . . . . .',
      '  A A A B B B C . D D D D . .',
      '  A A A B B B C . D D D D . .',
    ]);
    expect(two[0]).toBe('LAYER 2 (front of the drawer at the bottom):');
    expect(two[10]).toMatch(/^ {4}A = /);
    expect(two[9]).toBe('  A  A  A   .  .  .  .');
    expect(page.__errors, 'the page threw while being driven').toEqual([]);
  });

/* A link from before half sizes downloads exactly what it did: every file in the ZIP the
   same to the byte, the README the same to the byte but for the page's own address, and
   the same link written back. Whole bins on two layers with the things a bin can have
   (dividers loose and printed in, a scoop and a label, a carved L with magnets, holes in
   every cell, a lid, a solid bin, lowered walls, notes), so the map, the half-slot
   occupancy under it and the README all had to come out unchanged.

   Each digest is the first 16 hex digits of the SHA-256, recorded from the page as it
   was before half-size bins reached the bins page. A change that MEANS to alter these
   will fail here: check that it should, then put in the digests this prints. */
test('a link from before half sizes downloads the same files, byte for byte', async ({ page }) => {
  const crypto = require('crypto');
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const OLD = 'w=306&d=380&dh=84&bl=' + [
    binAt(0, 0, 2, 1, 3),
    binAt(2, 0, 3, 2, 5, [1.2, 1.2, 2, 1, 0, 1, 1, 1, 1, 6, 10, 0, 0, 0, 0, 15]),
    binAt(0, 1, 2, 2, 3, [1.2, 1.2, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 15]),
    binAt(4, 3, 3, 3, 3, [1.2, 1.2, 0, 0, 0, 1, 1, 1, 1, 0, 0, '111111110', 0, 0, 0, 15, 1]),
    binAt(0, 3, 3, 2, 4, [1.2, 1.2, 2, 1, 0, 1, 1, 1, 1, 8, 12, 0, 0, 0, 0, 15, 7]),
    binAt(0, 5, 2, 1, 4, [0.85, 2.35, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 14]),
    binAt(3, 6, 1, 1, 3, [1.2, 1.2, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 15]),
    binAt(5, 7, 2, 1, 3, [1.2, 1.2, 0, 0, 0, 0.5, 1, 0.25, 1, 0, 0, 0, 0, 0, 0, 15]),
  ].join('_') + '~' + [binAt(0, 0, 2, 2, 2), binAt(2, 0, 3, 2, 3)].join('_') +
    '&bnotes=' + encodeURIComponent(JSON.stringify([['pens', '', 'M3 screws'], ['', 'bits']]));
  const zip = await zipOf(page, OLD);
  const got = {};
  for (const name of Object.keys(zip.files).sort()) {
    let buf = await zip.file(name).async('nodebuffer');
    // the README ends with a link to this page, wherever this checkout is
    if (name === 'README.txt')
      buf = Buffer.from(buf.toString('utf8').replace(/^Layout link: [^#\n]*#/m, 'Layout link: <page>#'));
    got[name] = sha(buf);
  }
  got.link = sha(await page.evaluate(() => descString()));
  expect(got).toEqual({
    'README.txt': '81669f99abb031cd',
    'bin-2x1x3-qty1.stl': '4f879f2b46d2fef3',
    'bin-2x1x4-qty1.stl': '4b028774e7cab92a',
    'bin-2x2x2-qty1.stl': 'aa35a25aa8f07fe3',
    'bin-2x2x3-1x1div-qty1.stl': 'e75df6c3575a97a8',
    'bin-3x2x3-qty1.stl': 'fa1c2a7c90637b50',
    'bin-3x2x4-2x1div-magnets-screws-every-cell-qty1.stl': '94cba83351d3eef8',
    'bin-3x2x5-2x1div-qty1.stl': 'c584bd3b0e62f628',
    'bin-3x3x3-magnets-qty1.stl': 'c87e863e972d676a',
    'divider-80.6x14.8x1.6mm.stl': '80621d18f770f536',
    'lid-2x1-lrb.stl': 'c29d7ff271cfed07',
    link: 'fea2dd5a633c087e',
  });
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});
