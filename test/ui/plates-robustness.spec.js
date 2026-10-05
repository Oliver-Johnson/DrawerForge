/* The baseplates page under inputs and conditions it used to fall over on.
 *
 * Every case is a finding from a review that drove the real page, and each one is
 * written to fail against the code as it was: a page that froze in its first layout, a
 * field that took any number and built a broken plate with Download still offered, a
 * build failure that left "building 1/2…" on screen for good, a preview that took the
 * whole page down when WebGL was missing.
 *
 * Most designs arrive by link rather than by typing, because a link is the other way a
 * number reaches the page and the ranges have to hold for both. The geometry behind the
 * ranges — why each limit is where it is — is measured in test/plate-audit.js.
 */
'use strict';
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
const JSZip = require('../../vendor/jszip.min.js');

const SETTLED = /ready|not building|failed/;
async function openAt(page, hash, timeout = 30000) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(H.PLATES_URL + hash, { timeout });
  await page.waitForFunction((re) => new RegExp(re).test(
    document.getElementById('pieceTail').textContent), SETTLED.source, { timeout });
  return errors;
}
const text = (page, id) => page.evaluate((i) => document.getElementById(i).textContent, id);
const exportOff = (page) => page.evaluate(() => document.getElementById('openExport').disabled);

/* ---- #8: Fewest plates on a grid too big to search ------------------------------- */
test.describe('Fewest plates on a big grid', () => {
  /* 2000 × 2000 at 13.5 mm is 148 × 148 cells. The search tried every split pattern
     of every row and column with nothing to stop it, inside the first computeLayout,
     so the page never finished loading. The second link is the one from the review: a
     5 mm pitch, which is now refused, but the page has to say so rather than hang. */
  for (const hash of ['#w=2000&d=2000&bw=800&bd=800&sp=plates&pi=13.5',
                      '#w=1200&d=1000&bw=350&bd=350&sp=plates&pi=5']) {
    test(`${hash} settles instead of freezing the page`, async ({ page }) => {
      const errors = await openAt(page, hash, 20000);
      const s = await page.evaluate(() => {
        const t0 = performance.now();
        computeLayout(state);
        return { ms: performance.now() - t0 };
      });
      expect(s.ms, 'one layout of this drawer has to be quick').toBeLessThan(2000);
      expect(await text(page, 'warnings')).toMatch(/past the 900 this tool will build in one go/);
      expect(await exportOff(page)).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  // there was no split pattern within the search's own limits for 23 columns on this
  // bed, and it read the first element of an empty list — a TypeError on load
  test('a 1000 × 600 drawer on a 256 mm bed lays out', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(H.PLATES_URL + '#w=1000&d=600&sp=plates');
    await page.waitForFunction(() => document.querySelectorAll('#pieceRows tr').length > 1,
                               null, { timeout: 20000 });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => layout.pieces.length)).toBeGreaterThan(1);
  });
});

/* ---- #12: every field that reaches the geometry has a range ----------------------- */
test.describe('ranges on the geometry fields', () => {
  /* [link, the line under the field, what it has to say]. The magnet and screw maxima
     are the standard 42 mm pitch's, from mountLimits; the pitch cases show the same
     limit moving with the cell, down to no room at all. */
  const CASES = [
    ['#tc=0', 'errFloor', /Rim cutoff must be at least 0\.1 mm/],
    ['#tc=5', 'errFloor', /Rim cutoff must be 1 mm or less — past that a spec bin rides on the rim/],
    ['#bp=-10', 'errFloor', /Extra floor must be at least 0 mm/],
    ['#bp=300', 'errFloor', /Extra floor must be 20 mm or less/],
    ['#mm=custom&ml=-100', 'errMargins', /Left margin must be at least 0 mm/],
    ['#w=306&mm=custom&mr=400', 'errMargins', /Right margin must be 306 mm or less — the drawer is only that wide/],
    ['#mg=1&md=0', 'errMagnet', /Magnet Ø must be at least 1 mm/],
    ['#mg=1&mh=0', 'errMagnet', /Magnet depth must be at least 0\.5 mm/],
    ['#mg=1&ms=top&mh=-5', 'errMagnet', /Magnet depth must be at least 0\.5 mm/],
    ['#mg=1&md=20', 'errMagnet', /Magnet Ø must be 13\.8 mm or less at a 42 mm pitch/],
    ['#mg=1&ms=top&md=10', 'errMagnet', /Magnet Ø must be 8\.1 mm or less at a 42 mm pitch/],
    ['#mg=1&pi=30', 'errMagnet', /Magnet Ø must be 1\.8 mm or less at a 30 mm pitch/],
    ['#mg=1&pi=20', 'errMagnet', /Magnet Ø: there is no room for one at a 20 mm pitch/],
    ['#mg=1&bm=bosses&mh=3', 'errMagnet', /Magnet depth must be 2 mm or less with corner pockets/],
    ['#sc=1&sh=20', 'errScrew', /Screw hole Ø must be 8\.3 mm or less/],
    ['#sc=1&sd=30', 'errScrew', /Screw head Ø must be 14 mm or less/],
    ['#sc=1&se=50', 'errScrew', /Screw head depth must be 10 mm or less/],
    ['#cl=1', 'errConnClr', /Fit clearance must be 0\.3 mm or less/],
    ['#cl=-1', 'errConnClr', /Fit clearance must be at least 0 mm/],
    ['#pi=10', 'errPitch', /Grid pitch must be at least 13\.5 mm/],
  ];
  for (const [hash, errId, msg] of CASES) {
    test(`${hash} is refused at the field`, async ({ page }) => {
      const errors = await openAt(page, hash);
      const s = await page.evaluate((id) => ({
        msg: document.getElementById(id).textContent,
        shown: !document.getElementById(id).hidden,
        checks: document.getElementById('warnings').textContent,
        tail: document.getElementById('pieceTail').textContent,
      }), errId);
      expect(s.msg).toMatch(msg);
      expect(s.shown).toBe(true);
      expect(s.checks, 'the checks under the map say the same thing').toMatch(msg);
      expect(s.tail).toMatch(/not building/);
      expect(await exportOff(page), 'Download stayed on for a plate it would build broken')
        .toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test('a typed value is held to the same range, and a good one clears it', async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'topCutoff', '0');
    expect(await text(page, 'errFloor')).toMatch(/Rim cutoff must be at least 0\.1 mm/);
    expect(await exportOff(page)).toBe(true);
    await H.setField(page, 'topCutoff', '0.4');
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                               null, { timeout: 30000 });
    expect(await page.evaluate(() => document.getElementById('errFloor').hidden)).toBe(true);
    expect(await exportOff(page)).toBe(false);
  });

  // a field you cannot see does not get to stop the build
  test('a magnet size with magnets off is not complained about', async ({ page }) => {
    await openAt(page, '#md=0&mh=-5');
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await page.evaluate(() => document.getElementById('errMagnet').hidden)).toBe(true);
  });

  test('margins that leave no room for a cell are a check, not a plate', async ({ page }) => {
    await openAt(page, '#w=306&mm=custom&ml=150&mr=150');
    expect(await text(page, 'warnings'))
      .toMatch(/left and right margins leave 6 mm of the drawer's width — not enough for one 42 mm cell/);
    expect(await exportOff(page)).toBe(true);
  });

  /* The bed has a height. A 20 mm extra floor on a 20 mm tall printer made a 24 mm
     plate, and the page said every piece fit. */
  test('a plate taller than the printer fails the bed check', async ({ page }) => {
    await openAt(page, '#bp=20&bh=20');
    expect(await text(page, 'warnings'))
      .toMatch(/The plate is 24\.25 mm tall, more than your printer's 20 mm build height/);
    expect(await text(page, 'pieceRows')).toMatch(/TOO TALL/);
    expect(await text(page, 'pieceTail')).toMatch(/not building/);
    await page.locator('#openExport').click();
    expect(await text(page, 'exFit')).toMatch(/24\.25 mm tall and your printer builds 20 mm high/);
  });
});

/* ---- #19: a build that throws ----------------------------------------------------- */
test('a failed build says so in the table and the dialog, and Download goes off',
  async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await H.openPlates(page);
    await page.locator('#openExport').click();
    // the engine failing, on demand: the second piece throws, the first builds
    await page.evaluate(() => {
      window.realBuildPiece = buildPiece;
      let n = 0;
      window.buildPiece = (...a) => {
        if (++n === 2) throw new Error('forced failure');
        return window.realBuildPiece(...a);
      };
    });
    await H.setField(page, 'drawerW', '300');
    await page.waitForFunction(() => /failed/.test(document.getElementById('pieceTail').textContent),
                               null, { timeout: 30000 });
    const s = await page.evaluate(() => ({
      tail: document.getElementById('pieceTail').textContent,
      rows: document.getElementById('pieceRows').textContent,
      fit: document.getElementById('exFit').textContent,
      zipOff: document.querySelector('#exFiles [data-ex="zip"]').disabled,
      off: document.getElementById('openExport').disabled,
      failed: buildFailed,
    }));
    expect(s.tail).toMatch(new RegExp(`build failed at piece ${s.failed}`));
    expect(s.rows).toMatch(/failed/);
    expect(s.fit).toMatch(new RegExp(`Piece ${s.failed} could not be built`));
    expect(s.zipOff).toBe(true);
    expect(s.off, 'Download stayed on after the build gave up').toBe(true);
    expect(pageErrors, 'the failure is caught, not thrown out of the page').toEqual([]);

    // and the next good build clears all of it
    await page.evaluate(() => { window.buildPiece = window.realBuildPiece; });
    await H.setField(page, 'drawerW', '306');
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                               null, { timeout: 30000 });
    expect(await exportOff(page)).toBe(false);
  });

/* ---- #20: spacing on the print plate ---------------------------------------------- */
test.describe('print plate spacing', () => {
  // two identical 2 × 2 pieces, which fit one plate side by side or one on the other
  const TWO = '#w=168&d=84&sp=manual&rc=&cc=2&cn=none';
  const gaps = (page) => page.evaluate(() => {
    const out = [];
    for (const pl of printPlan.plates)
      for (let i = 0; i < pl.placed.length; i++) for (let j = i + 1; j < pl.placed.length; j++) {
        const a = pl.placed[i], b = pl.placed[j];
        if (Math.abs(a.z - b.z) > 1e-6) continue;
        out.push(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.d), a.y - (b.y + b.d)));
      }
    return out;
  });

  test('a negative part spacing does not overlap the parts', async ({ page }) => {
    await openAt(page, TWO);
    await page.waitForFunction(() => !!printPlan);
    await H.setField(page, 'plateGap', '-10');
    const g = await gaps(page);
    expect(g.length).toBeGreaterThan(0);
    for (const v of g) expect(v).toBeGreaterThanOrEqual(-1e-6);
  });

  test('a part spacing of 0 is 0, not the default', async ({ page }) => {
    await openAt(page, TWO);
    await page.waitForFunction(() => !!printPlan);
    await H.setField(page, 'plateGap', '0');
    const g = await gaps(page);
    expect(g.length).toBeGreaterThan(0);
    expect(Math.min(...g)).toBeCloseTo(0, 6);
  });

  test('a negative stack gap does not sink one piece into the other', async ({ page }) => {
    await openAt(page, TWO);
    await page.waitForFunction(() => !!printPlan);
    await page.evaluate(() => { document.getElementById('stackToggle').checked = true; });
    await H.setField(page, 'stackGap', '-1');
    const s = await page.evaluate(() => ({
      H: builds[layout.pieces[0].id].meta.H,
      zs: printPlan.plates.flatMap((pl) => pl.placed.map((p) => p.z)).filter((z) => z > 0),
    }));
    expect(s.zs.length, 'the fixture has to stack, or this proves nothing').toBeGreaterThan(0);
    for (const z of s.zs) expect(z).toBeGreaterThanOrEqual(s.H - 1e-6);
  });
});

/* ---- #21: more than 26 columns of pieces ----------------------------------------- */
test('pieces past the 26th column are named like spreadsheet columns', async ({ page }) => {
  // 33 cells in a row on a bed that takes one at a time
  await openAt(page, '#w=1386&d=42&bw=50&bd=50&bh=50', 90000);
  const ids = await page.evaluate(() => layout.pieces.map((p) => p.id));
  expect(ids).toHaveLength(33);
  for (const id of ids) expect(id).toMatch(/^[A-Z]+[0-9]+$/);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.slice(24, 28)).toEqual(['Y1', 'Z1', 'AA1', 'AB1']);
  expect(await text(page, 'pieceRows')).toContain('AG1');
});

/* ---- #23: a plate in one piece needs no keys ------------------------------------- */
test('a one-piece plate offers no keys, plans none and zips none', async ({ page }) => {
  await openAt(page, '#w=200&d=200&cn=bowtie');
  await page.waitForFunction(() => !!printPlan);
  const s = await page.evaluate(() => ({
    pieces: layout.pieces.length, needed: keysNeeded(),
    planned: printPlan.plates.flatMap((pl) => pl.placed.map((p) => p.id)),
  }));
  expect(s.pieces).toBe(1);
  expect(s.needed).toBe(0);
  expect(s.planned).not.toContain('key');
  await page.locator('#openExport').click();
  expect(await page.locator('#exFiles [data-ex="keys"]').count()).toBe(0);
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="zip"]').click(),
  ]);
  const buf = fs.readFileSync(await dl.path());
  const names = Object.keys((await JSZip.loadAsync(buf)).files);
  expect(names.filter((n) => /-x\d+\.stl$/.test(n))).toEqual([]);
  // #24 as well: the archive is deflated, not stored (method 8 at offset 8 of the first entry)
  expect(buf.readUInt16LE(8), 'the ZIP is stored uncompressed').toBe(8);
});

/* ---- #24: one piece too big to build, and output size ----------------------------- */
test('a piece of 900 cells is refused rather than built', async ({ page }) => {
  // a 1260 mm drawer on a "2000 mm bed" was one piece, 22 s of frozen page and a 189 MB STL
  await openAt(page, '#w=1260&d=1260&bw=2000&bd=2000&cn=none');
  expect(await text(page, 'warnings'))
    .toMatch(/Piece A1 is 30 × 30 = 900 cells, past the 576 this tool will build as one piece/);
  expect(await text(page, 'pieceTail')).toMatch(/not building/);
  expect(await exportOff(page)).toBe(true);
});

test('a 3MF plate is deflated', async ({ page }) => {
  await H.openPlates(page);
  await page.waitForFunction(() => !!printPlan);
  const head = await page.evaluate(async () => Array.from((await plate3mfBytes(0)).slice(0, 10)));
  expect(head.slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
  expect(head[8], 'compression method of the first entry: 8 is deflate, 0 is stored').toBe(8);
});

/* ---- #9: no WebGL ---------------------------------------------------------------- */
/* Its own browser, launched with the 3D APIs off, from the same launch options the rest
   of the suite uses — so the executable and anything else the config sets still apply. */
test('without WebGL the page still builds, and says the preview is unavailable',
  async ({ playwright, browserName, launchOptions }) => {
    const browser = await playwright[browserName].launch({
      ...launchOptions, args: [...(launchOptions.args || []), '--disable-3d-apis'] });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      // three.js reports the failed context on the console itself before it throws
      page.on('console', (m) => {
        if (m.type() === 'error' && !/THREE\.WebGLRenderer/.test(m.text())) errors.push(m.text());
      });
      await page.goto(H.PLATES_URL);
      expect(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl')),
             'the flag has to have taken, or this proves nothing').toBe(false);
      await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                                 null, { timeout: 30000 });
      const s = await page.evaluate(() => ({
        note: getComputedStyle(document.getElementById('noGl')).display,
        label: document.getElementById('three').getAttribute('aria-label'),
        off: document.getElementById('openExport').disabled,
        plan: !!printPlan,
      }));
      expect(s.note).not.toBe('none');
      expect(s.label).toMatch(/unavailable/);
      expect(s.off).toBe(false);
      expect(s.plan).toBe(true);
      // the controls that drive the preview must not throw either
      await page.locator('#explode').check();
      await H.setField(page, 'drawerW', '300');
      await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                                 null, { timeout: 30000 });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
