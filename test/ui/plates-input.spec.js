/* What the baseplates tool does with a number nobody meant to type, and what it says
 * about the design once it has one.
 *
 * Every case here is a finding from a review that drove the real page. The worst was
 * not that a bad number produced a bad plate — it was that it produced a screen saying
 * four contradictory things at once: "resolve the errors above to generate",
 * "building 0/2…" for good, a pieces row reading "-50.0 × 211.0 … fits", a console
 * error per SVG rect, and the Download button offered as the primary action.
 *
 * Each assertion is written to fail against the code as it was, and the fixture values
 * are chosen so it cannot pass by accident: the leftover case leaves one axis large and
 * the other tight, because the bug was printing both; the hint cases compare two
 * selections against each other, because a hint that never changes matches whatever it
 * was written to match.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

// the page settles behind a 260 ms debounce and then builds, so the checks are polled
// rather than read once at an arbitrary moment
const warnings = (page) => page.locator('#warnings');
const settle = (page) => page.waitForTimeout(900);

test.describe('nonsense in the size fields', () => {
  for (const [what, value] of [['negative', '-50'], ['blank', '']]) {
    test(`a ${what} drawer width is refused at the field, not downstream`, async ({ page }) => {
      const errors = await H.openPlates(page);
      await H.setField(page, 'drawerW', value);
      await settle(page);

      const s = await page.evaluate(() => ({
        msg: document.getElementById('errDrawerW').textContent,
        msgShown: !document.getElementById('errDrawerW').hidden,
        invalid: document.getElementById('drawerW').getAttribute('aria-invalid'),
        tail: document.getElementById('pieceTail').textContent,
        rows: document.getElementById('pieceRows').textContent,
        exportOff: document.getElementById('openExport').disabled,
        // every geometry attribute the map wrote, so a negative one cannot hide
        negatives: [...document.querySelectorAll('#cutmap [width],#cutmap [height]')]
          .flatMap((e) => [e.getAttribute('width'), e.getAttribute('height')])
          .filter((v) => parseFloat(v) < 0),
        viewBox: document.getElementById('cutmap').getAttribute('viewBox'),
      }));

      expect(s.msg, 'the field says nothing about what is wrong with it').not.toBe('');
      expect(s.msg).toMatch(/drawer width/i);
      expect(s.msgShown).toBe(true);
      expect(s.invalid, 'aria-invalid never moved').toBe('true');
      /* The old diagnosis. It is true of the clamped value and useless as an account of
         a blank or negative one, which is the complaint. */
      expect(await warnings(page).textContent())
        .not.toMatch(/Drawer smaller than one .* cell/);
      expect(s.tail, '"building 0/2…" never terminated').not.toMatch(/building \d+\/\d+/);
      expect(s.rows, 'a piece of an impossible drawer was listed as fitting the bed')
        .not.toMatch(/fits/);
      expect(s.exportOff, 'Download stayed the primary action with nothing behind it')
        .toBe(true);
      expect(s.negatives, 'a negative length reached the SVG').toEqual([]);
      expect(s.viewBox.split(' ').map(Number).filter((n) => n < 0)).toEqual([]);
      expect(errors, 'the page logged errors while being given a bad number').toEqual([]);
    });
  }

  test('the browser agrees the value is invalid', async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'drawerW', '-50');
    // `#drawerW` had no min at all, so the constraint API reported this as valid
    expect(await page.evaluate(() => document.getElementById('drawerW').validity.valid))
      .toBe(false);
  });

  test('a good value clears the complaint again', async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'drawerW', '-50');
    await settle(page);
    await H.setField(page, 'drawerW', '306');
    await page.waitForFunction(
      () => /ready/.test(document.getElementById('pieceTail').textContent),
      null, { timeout: 30000 });
    const s = await page.evaluate(() => ({
      msg: document.getElementById('errDrawerW').textContent,
      hidden: document.getElementById('errDrawerW').hidden,
      invalid: document.getElementById('drawerW').getAttribute('aria-invalid'),
      exportOff: document.getElementById('openExport').disabled,
    }));
    expect(s).toEqual({ msg: '', hidden: true, invalid: 'false', exportOff: false });
  });
});

/* No ceiling at all: 9999 × 9999 gave a 238 × 238 grid and 1600 pieces, and started
   building them one real CSG at a time. */
test('an absurd drawer is capped rather than attempted', async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '9999');
  await H.setField(page, 'drawerD', '9999');
  await settle(page);

  const s = await page.evaluate(() => ({
    cells: layout.nx * layout.ny,
    pieces: layout.pieces.length,
    tail: document.getElementById('pieceTail').textContent,
    warn: document.getElementById('warnings').textContent,
    exportOff: document.getElementById('openExport').disabled,
    built: Object.keys(builds).length,
    mapNodes: document.getElementById('cutmap').childElementCount,
  }));

  // the clamp alone must not be what makes this pass: the grid is still over the cap
  expect(s.cells, 'fixture: the clamped drawer must still be over the cell cap')
    .toBeGreaterThan(900);
  expect(s.warn, 'nothing on the page said the job was too big').toMatch(/past the 900/);
  expect(s.built, 'the build started anyway').toBe(0);
  expect(s.tail).not.toMatch(/building \d+\/\d+/);
  expect(s.exportOff).toBe(true);
  /* And the map is not drawn. At 238 × 238 that was about fifteen thousand SVG
     elements, which is most of what made a mistyped size feel like a hang. */
  expect(s.mapNodes).toBeLessThan(40);
});

/* ---- copy that describes the thing you picked ---------------------------- */

test('the plate style hint follows the plate style', async ({ page }) => {
  await H.openPlates(page);
  const hint = () => page.locator('#plateStyleHint').textContent();

  const solid = await hint();
  expect(await page.locator('#plateStyle').inputValue(), 'fixture: Solid is the default')
    .toBe('solid');
  expect(solid, 'the hint under "Solid" opened by describing the skeleton')
    .not.toMatch(/^Skeleton/);
  expect(solid).toMatch(/^Solid/);
  // "socket" is the one term on this screen you cannot guess, so it is glossed
  expect(solid).toMatch(/recess a bin's foot drops into/);

  await H.setField(page, 'plateStyle', 'skeleton');
  const skel = await hint();
  expect(skel, 'the hint is markup rather than state').not.toBe(solid);
  expect(skel).toMatch(/^Skeleton/);
  expect(skel).toMatch(/recess a bin's foot drops into/);
});

test('bowtie keys and puzzle keys do not share one paragraph', async ({ page }) => {
  await H.openPlates(page);
  const shown = () => page.evaluate(() =>
    [...document.querySelectorAll('#s-conn .hint')]
      .filter((e) => e.id.startsWith('connHint') && e.style.display !== 'none')
      .map((e) => e.textContent).join(''));

  await H.setField(page, 'connector', 'bowtie');
  const bow = await shown();
  await H.setField(page, 'connector', 'puzzlekey');
  const pkey = await shown();

  expect(bow.length, 'no hint is showing for bowtie').toBeGreaterThan(40);
  expect(pkey.length, 'no hint is showing for puzzle keys').toBeGreaterThan(40);
  expect(pkey, 'the two connectors give word-for-word the same help').not.toBe(bow);
  // and the second one says which to choose, which is the whole reason it exists
  expect(pkey).toMatch(/bowtie|along the seam|lengthways/i);
});

/* `data-v="plates"` is the value behind the button labelled "Fewest plates". It was
   interpolated straight into user copy in two places. */
test('the split mode is named, not enumerated', async ({ page }) => {
  await H.openPlates(page);
  await page.locator('#splitSeg button[data-v="plates"]').click();
  await page.waitForFunction(
    () => /ready/.test(document.getElementById('pieceTail').textContent),
    null, { timeout: 30000 });

  await page.locator('#openExport').click();
  // the enum went straight into the sentence: "4 piece(s), plates split, joined with…"
  // (and the "(s)" has gone since, too — see the next case)
  await expect(page.locator('#exDesign')).toContainText(/\d+ pieces?, fewest plates split,/);
  const readme = await page.evaluate(() => readmeText());
  expect(readme).toContain('Split: fewest plates');
  expect(readme).not.toContain('Split: plates');
});

/* Counts as a person says them. The download dialog read "4 piece(s)", "1 part(s)" and
   "4 plate(s)", the README said "2 row band(s)", and the tails that did try said "0
   piece". The bins page fixed the same thing earlier and has the matching case in
   on-screen.spec.js. Two drawers, because a hedge and a wrong singular show up at
   different counts: the default splits into several pieces, a 200 mm drawer is one. */
test('counts read as English, on the page, in the dialog and in the README', async ({ page }) => {
  const ready = () => page.waitForFunction(
    () => /ready/.test(document.getElementById('pieceTail').textContent),
    null, { timeout: 30000 });
  const read = async () => {
    await page.locator('#openExport').click();
    await page.waitForTimeout(300);
    const text = await page.evaluate(() => {
      // collapsed bodies are not on screen, so open everything before reading it
      document.querySelectorAll('section.p.closed').forEach((s) => s.classList.remove('closed'));
      return document.body.innerText + '\n' + document.getElementById('exportDlg').innerText +
        '\n' + readmeText();
    });
    await page.locator('#exportClose').click();
    return text;
  };
  const NOUNS = '(pieces?|plates?|print plates?|parts?|tabs?|pockets?|puzzles?|keys?|row bands?)';
  const english = (text) => {
    expect(text, 'nothing should be hedging its plural').not.toMatch(/\(s\)/);
    expect(text, 'a plural where one is meant')
      .not.toMatch(new RegExp(`\\b1 ${NOUNS.replace(/s\?/g, 's')}\\b`));
    expect(text, 'a singular where several are meant')
      .not.toMatch(new RegExp(`\\b(0|[2-9]|[1-9]\\d+) ${NOUNS.replace(/s\?/g, '')}\\b`));
  };

  await H.openPlates(page);
  const several = await read();
  english(several);
  expect(several, 'fixture: the default drawer is several pieces').toMatch(/\b[2-9] pieces\b/);

  await H.setField(page, 'drawerW', 200);
  await H.setField(page, 'drawerD', 200);
  await ready();
  const one = await read();
  english(one);
  expect(one).toMatch(/\b1 piece\b/);
  expect(one, 'one piece is "the piece", not "all 1"').toContain('The piece fits your');
  expect(one).toMatch(/\b1 part on a\b/);
});

/* ---- the export dialog --------------------------------------------------- */

test.describe('the download dialog', () => {
  test.beforeEach(async ({ page }) => {
    await H.openPlates(page);
    await page.locator('#openExport').click();
    await expect(page.locator('#exportDlg')).toBeVisible();
  });

  test('the section called "print these first" is first', async ({ page }) => {
    const groups = await page.locator('#exFiles .exgroup').allTextContents();
    expect(groups[0], 'the advice was below every file it is advice about')
      .toMatch(/print these first/i);
    // and that means on screen, not merely earlier in the document — it was last, under
    // twenty-odd rows, and off the bottom of the dialog
    const g = await page.locator('#exFiles .exgroup')
      .filter({ hasText: /print these first/i }).boundingBox();
    const body = await page.locator('.sheetbody').boundingBox();
    expect(g.y).toBeGreaterThanOrEqual(body.y);
    expect(g.y + g.height).toBeLessThanOrEqual(body.y + body.height);
  });

  test('one path is marked as the one to take', async ({ page }) => {
    await expect(page.locator('#exFiles .exrow').filter({ hasText: 'Every plate' }))
      .toContainText(/recommended/i);
  });

  test('every button says which file it is, not just "Download"', async ({ page }) => {
    const names = await page.locator('#exFiles button').evaluateAll((bs) =>
      bs.map((b) => b.getAttribute('aria-label') || b.textContent.trim()));
    expect(names.length, 'fixture: several rows to tell apart').toBeGreaterThan(4);
    // the accessible names were "Download" and "STL", repeated
    expect(new Set(names).size, 'two buttons share an accessible name')
      .toBe(names.length);
    for (const n of names)
      expect(n, `"${n}" does not name a file or a format`).toMatch(/\((3MF|STL|ZIP)\)|ZIP/);
  });

  /* The rows have said "3MF" and "STL" all along; nothing said what the difference was
     or which one you wanted. Asserted on the prose rather than the whole dialog, or the
     file metas would satisfy it. */
  test('it says what the two formats are for', async ({ page }) => {
    const notes = (await page.locator('.sheetbody > .exnote').allTextContents()).join(' ');
    expect(notes).toMatch(/3MF/);
    expect(notes).toMatch(/STL/);
    expect(notes).toMatch(/arranged on the bed/i);
  });

  /* The number that decides whether anyone starts. The bins dialog has quoted one since
     it shipped; this one, whose jobs are the long ones, said nothing. */
  test('it says how much filament the job is', async ({ page }) => {
    await expect(page.locator('#exDesign')).toContainText(/about [\d.]+ (g|kg) of PLA/);

    const small = await page.evaluate(() => materialGrams());
    await page.locator('#exportClose').click();
    await H.setField(page, 'drawerW', 500);
    await H.setField(page, 'drawerD', 500);
    await page.waitForFunction(
      () => /ready/.test(document.getElementById('pieceTail').textContent),
      null, { timeout: 60000 });
    const big = await page.evaluate(() => materialGrams());

    // it is measured, not a constant: a bigger drawer is more plastic, roughly in
    // proportion to the grid area it gained
    expect(big).toBeGreaterThan(small * 1.4);
    expect(big).toBeLessThan(small * 4);
  });

  /* Half a total is a number people would act on, and the dialog re-renders on every
     finished piece, so it would be a different one each time they looked.

     Driven through the model rather than by catching a real build part-way through:
     the dialog is asked to render with one piece missing, which is exactly the state it
     is in mid-build. Racing a real build for this needs the 6x CPU throttle the other
     mid-build case uses, and even then the window is a few hundred milliseconds — a
     test that usually catches it is not a test. */
  test('no total is quoted until every piece exists', async ({ page }) => {
    const mid = await page.evaluate(() => {
      delete builds[layout.pieces[layout.pieces.length - 1].id];
      renderExportSummary();
      return { g: materialGrams(), text: document.getElementById('exDesign').textContent };
    });
    expect(mid.g, 'a partial total was offered as the total').toBeNull();
    expect(mid.text).not.toMatch(/of PLA/);
  });
});

/* ---- the checks ---------------------------------------------------------- */

test('the leftover warning names only the axis that has leftover, and links on', async ({ page }) => {
  await H.openPlates(page);
  // 330 mm is 7 cells and 36 mm spare across the width; the depth stays tight at 2 mm
  await H.setField(page, 'drawerW', 330);
  await settle(page);

  const w = await page.locator('#warnings .w').filter({ hasText: 'Leftover' });
  await expect(w).toHaveCount(1);
  const text = await w.textContent();
  expect(text).toContain('36 mm across the width');
  /* It fired on either axis and then printed both, so a tight axis was reported as
     leftover it does not have — at its worst, "(-92 × 40 mm)". */
  expect(text, 'the tight axis was reported as leftover too').not.toContain('across the depth');
  await expect(w.locator('a')).toHaveAttribute('href', 'guide/drawer-sizes/#leftover');
});

/* ---- the working surfaces, to something that cannot see them -------------- */

test('the cut map says what it is showing, and keeps saying it', async ({ page }) => {
  await H.openPlates(page);
  const label = () => page.locator('#cutmap').getAttribute('aria-label');

  const first = await label();
  expect(first).toBeTruthy();
  const g = await page.evaluate(() => [layout.nx, layout.ny, layout.pieces.length]);
  expect(first).toContain(`${g[0]} by ${g[1]} cell grid`);
  expect(first).toContain(`${g[2]} piece`);
  expect(first).toContain('balanced split');

  // it follows the split mode, which is a state you cannot see any other way
  await page.locator('#splitSeg button[data-v="staggered"]').click();
  await settle(page);
  const after = await label();
  expect(after, 'the label never changed, so it is markup rather than state')
    .not.toBe(first);
  expect(after).toContain('staggered split');
});

// (the 3D preview's label is asserted in a11y.spec.js, beside the bins page's)

/* The joint you picked is the joint you are shown.
 *
 * Seven connector options were described in prose and pictured nowhere; the 3D preview
 * renders the whole plate at a scale where a joint is a few pixels across. The figures
 * are generated from core.js's parameters at build time, so this does not check that
 * the drawing is right — test/guide-facts.js does that, including that each key spans
 * the seam rather than lying along it. What it checks is the wiring: that exactly one
 * is showing, that it is the one named in the dropdown, and that 'none' shows nothing
 * rather than leaving the last joint you looked at on screen.
 */
test('the connector picker shows the joint you chose, and nothing for none', async ({ page }) => {
  await H.openPlates(page);
  const shown = async () => page.$$eval('.connfig',
    (els) => els.filter((e) => e.style.display !== 'none').map((e) => e.dataset.joint));

  for (const kind of ['dovetail', 'puzzle', 'bowtie', 'puzzlekey', 'snap', 'hclip']) {
    await page.selectOption('#connector', kind);
    await page.waitForTimeout(120);
    expect(await shown(), `picked ${kind}`).toEqual([kind]);
  }
  await page.selectOption('#connector', 'none');
  await page.waitForTimeout(120);
  expect(await shown(), 'none has no joint to draw').toEqual([]);

  /* The figure is decorative: the hint paragraph beside it says the same thing in
     words, and a screen reader should be given it once rather than twice. */
  await page.selectOption('#connector', 'snap');
  await page.waitForTimeout(120);
  expect(await page.getAttribute('.connfig[data-joint="snap"]', 'aria-hidden')).toBe('true');
});

/* Does the filament estimate actually listen to the infill?
 *
 * It did not. The figure was folded in when a piece was built and cached with it, and
 * geometry does not change when the infill does — so the number was frozen at whatever
 * the control read at build time while the label beside it dutifully quoted the new
 * percentage. Worse than no control: it looked like it worked.
 *
 * The other half is that on a default open-bottomed plate the infill reaches nothing at
 * all — every part of a 4.25 mm plate is a thin wall, so the shell estimate exceeds the
 * whole volume. That is not a bug to hide; it is worth saying, or the honest lack of
 * movement reads as the same defect.
 */
test('the filament estimate follows the infill, and says when it cannot', async ({ page }) => {
  await H.openPlates(page);
  const set = async (id, v) => {
    await page.evaluate(([i, x]) => {
      const e = document.getElementById(i);
      e.value = x;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }, [id, v]);
    await page.waitForTimeout(2600);
  };
  const estimate = async () => {
    await page.click('#openExport');
    await page.waitForTimeout(800);
    const t = ((await page.locator('#exDesign').textContent()) || '').split('\n').pop();
    await page.locator('#exportClose').click();
    await page.waitForTimeout(250);
    return t;
  };
  const grams = (t) => Number((t.match(/about ([\d.]+) (g|kg)/) || [])[1]) *
                       (t.includes(' kg') ? 1000 : 1);

  // open-bottomed: all shell, and the page should say so rather than quote a percentage
  expect(await estimate()).toMatch(/mostly shell, so 15% infill barely moves it/);

  // a solid pad gives the infill something to reach
  await set('bottomPad', '2.8');
  await set('infill', '5');
  const low = await estimate();
  await set('infill', '60');
  const high = await estimate();

  expect(low, 'a reachable core means the percentage is worth quoting').toMatch(/at 5% infill/);
  expect(high).toMatch(/at 60% infill/);
  expect(grams(high), `${grams(high)} g at 60% must exceed ${grams(low)} g at 5%`)
    .toBeGreaterThan(grams(low) * 1.1);
});
