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
// a missing element reads as empty, so a page without the line fails on what it says
const text = (page, id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  return el ? el.textContent : '';
}, id);
const shown = (page, id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  return !!el && !el.hidden;
}, id);
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
     limit moving with the cell, down to no room at all. Those take no joint (cn=none):
     the default dovetail's tabs stop a magnet from beneath first, at 13.1 mm, and the
     joint cases at the end of the list say so. */
  const BOWTIE_42 = '#pi=42&w=168&d=84&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=100&bd=400&cn=bowtie&km=floor&ki=bottom';
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
    ['#cn=none&mg=1&md=20', 'errMagnet', /Magnet Ø must be 13\.6 mm or less at a 42 mm pitch/],
    ['#mg=1&ms=top&md=10', 'errMagnet', /Magnet Ø must be 8 mm or less at a 42 mm pitch/],
    ['#cn=none&mg=1&pi=30', 'errMagnet', /Magnet Ø must be 1\.8 mm or less at a 30 mm pitch/],
    // past about 50 mm it is the hole beside a pocket that stops it: a 1-inch magnet met it
    ['#pi=55&w=110&d=110&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=400&bd=400&mg=1&md=25.4', 'errMagnet',
      /Magnet Ø must be 24\.3 mm or less at a 55 mm pitch — mounting holes sit 13 mm from each cell centre, where the Gridfinity spec puts them, and a cell's four holes have to stay clear of each other/],
    ['#pi=60&w=120&d=120&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=400&bd=400&sc=1&sd=26', 'errScrew',
      /Screw head Ø must be 24\.3 mm or less at a 60 mm pitch — .* a cell's four holes have to stay clear of each other/],
    ['#mg=1&bm=bosses&mh=3', 'errMagnet', /Magnet depth must be 2\.4 mm or less with corner pockets/],
    ['#sc=1&sh=20', 'errScrew', /Screw hole Ø must be 8 mm or less/],
    ['#cn=none&sc=1&sd=30', 'errScrew', /Screw head Ø must be 13\.6 mm or less/],
    ['#sc=1&se=50', 'errScrew', /Screw head depth must be 10 mm or less/],
    ['#cl=1', 'errConnClr', /Fit clearance must be 0\.3 mm or less — any looser and a dovetail pocket/],
    ['#cn=bowtie&cl=5', 'errConnClr', /Fit clearance must be 1 mm or less — check the figure is in millimetres/],
    ['#cl=-1', 'errConnClr', /Fit clearance must be at least 0 mm/],
    ['#pi=10', 'errPitch', /Grid pitch must be at least 13\.5 mm/],
    /* #64: a hole has to stay out of a joint's cut in the floor. A 10 mm magnet from
       beneath reached a bowtie's recess at 42 mm, and the plate built with 19 bad edges a
       piece and Download on; from above, an 8 mm one stood over the key. */
    [`${BOWTIE_42}&mg=1&md=10`, 'errMagnet',
      /Magnet Ø must be 7\.6 mm or less at a 42 mm pitch — mounting holes sit 13 mm from each cell centre, where the Gridfinity spec puts them, and a hole has to stay out of the recesses the bowtie keys fit into; keys housed inside the walls and put in from above keep out of the solid floor under these pockets\./],
    [`${BOWTIE_42}&mg=1&ms=top&md=8`, 'errMagnet',
      /Magnet Ø must be 7\.6 mm or less at a 42 mm pitch — .* the recesses the bowtie keys fit into/],
    [`${BOWTIE_42.replace('cn=bowtie', 'cn=snap')}&sc=1&sd=10`, 'errScrew',
      /Screw head Ø must be 7\.6 mm or less at a 42 mm pitch — .* the recesses the snap clips fit into/],
    /* A dovetail's notch lets a pocket from beneath in (#69's review, option c), so long
       as the magnet stays clear of the tab and the pocket is not as deep as the notch,
       and does not stop just short of its edge; each refusal says which it is. */
    ['#mg=1&md=20', 'errMagnet',
      /Magnet Ø must be 13\.1 mm or less at a 42 mm pitch — .* a magnet has to stay clear of the dovetail tabs in the notches beside it\./],
    ['#mg=1&mh=2.4&md=13', 'errMagnet',
      /Magnet Ø must be 12\.5 mm or less at a 42 mm pitch — .* a pocket 2\.4 mm deep, as deep as the notches the dovetail tabs fit into, has to stay out of them\./],
    ['#pi=36&mg=1&md=5.6', 'errMagnet',
      /Magnet Ø of 5\.6 mm is refused at a 36 mm pitch — its pocket would come too near the edge of the notches the dovetail tabs fit into to cut cleanly\. Use 5\.58 mm or less, or 5\.61 mm or more\./],
    /* Two gaps can meet at one size, taken between them, and the advice names it rather
       than pointing into the next gap; nor does it name a size under the field's least. */
    ['#pi=41.49&mg=1&md=11.93', 'errMagnet',
      /Magnet Ø of 11\.93 mm is refused at a 41\.49 mm pitch — .* Use 11\.89 mm or less, 11\.92 mm, or 11\.95 mm or more\./],
    ['#pi=31&cl=0&mg=1&md=1', 'errMagnet',
      /Magnet Ø of 1 mm is refused at a 31 mm pitch — .* Use 1\.01 mm, or 1\.04 mm or more\./],
    /* #75: a bowtie key in the walls put in from above stands in a cup of its own, and with
       corner bosses there is no floor between that cup and the bosses' pockets. With the
       default 6 mm magnet at 36.13 mm the cup's floor stood in the pocket beside each key,
       watertight and with Download on, where the magnet could not seat. */
    ['#pi=36.13&w=144.52&d=72.26&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=88.26&bd=400&cn=bowtie&km=wall&ki=top' +
      '&bm=bosses&mg=1', 'errMagnet',
      /Magnet Ø must be 5 mm or less at a 36\.13 mm pitch — mounting holes sit 13 mm from each cell centre, where the Gridfinity spec puts them, and a hole has to stay out of the housings the bowtie keys drop into from above; put in from beneath, the bowtie keys leave more room\./],
    /* #83: with corner pockets a cell is its socket's rim alone, and over a boss the rim
       is the socket's wall, so a hole that opens on the boss's top has to clear it. A
       6 mm magnet from above at 36.13 mm stood 0.26 mm under the rim, and a 4.5 mm screw
       hole at 34.5 mm under it too, both with Download on. The screw's cap goes by how
       its bore's corners stand off its size, so only the reason is pinned. */
    ['#pi=36.13&w=144.52&d=72.26&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=88.26&bd=400&cn=none&bm=bosses&mg=1&ms=top',
      'errMagnet',
      /Magnet Ø must be 5\.4 mm or less at a 36\.13 mm pitch — mounting holes sit 13 mm from each cell centre, where the Gridfinity spec puts them, and a magnet put in from above has to clear the socket's rim over its corner boss\./],
    ['#pi=34.5&w=138&d=69&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=85&bd=400&cn=none&bm=bosses&sc=1&sh=4.5', 'errScrew',
      /Screw hole Ø must be [\d.]+ mm or less at a 34\.5 mm pitch — .* a screw has to clear the socket's rim over its corner boss\./],
    /* #70: the joint is cut from the corner bosses now, so a boss's pocket can reach it as
       a cell's can. A bowtie key in the walls at 36.13 mm took a 7.9 mm magnet, and with
       the recess cut from the bosses it would have built 19 open edges a piece. */
    ['#pi=36.13&w=144.52&d=72.26&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=88.26&bd=400&cn=bowtie&km=wall&ki=bottom' +
      '&bm=bosses&mg=1&md=7.9', 'errMagnet',
      /Magnet Ø must be 6\.1 mm or less at a 36\.13 mm pitch — .* the recesses the bowtie keys fit into/],
    /* #81: a shank has to clear the magnet pocket it runs up the middle of, as it would a
       counterbore. 5 mm under a 5.1 mm magnet and a 5.4 mm head built 47 open edges at
       42 mm. */
    ['#cn=none&mg=1&md=5.1&ms=top&sc=1&sh=5&sd=5.4', 'errScrew',
      /Screw hole Ø must be 4\.9 mm or less — it runs through the 5\.1 mm magnet's pocket, and has to stay inside the pocket's sides to leave a ledge round it that holds the magnet\./],
  ];
  for (const [hash, errId, msg] of CASES) {
    test(`${hash} is refused at the field`, async ({ page }) => {
      const errors = await openAt(page, hash);
      expect(await text(page, errId)).toMatch(msg);
      expect(await shown(page, errId)).toBe(true);
      expect(await text(page, 'warnings'), 'the checks under the map say the same thing')
        .toMatch(msg);
      expect(await text(page, 'pieceTail')).toMatch(/not building/);
      expect(await exportOff(page), 'Download stayed on for a plate it would build broken')
        .toBe(true);
      expect(errors).toEqual([]);
    });
  }

  /* The range moves with the joint. With a bowtie in the floor at 42 mm a magnet from
     beneath goes up to 7.6 mm, where the cell alone takes 13.6: at 7.6 it builds with
     Download on, a tenth past is refused with Download off, and with no joint the field
     takes the cell's size again. */
  test('a magnet pocket is held out of a joint\'s recess, and the field says how far',
    async ({ page }) => {
      const errors = await openAt(page, `${BOWTIE_42}&mg=1&md=7.6`);
      const max = () => page.evaluate(() => document.getElementById('magnetD').max);
      expect(await max()).toBe('7.6');
      expect(await shown(page, 'errMagnet')).toBe(false);
      expect(await text(page, 'pieceTail')).toMatch(/ready/);
      expect(await exportOff(page)).toBe(false);
      await H.setField(page, 'magnetD', '7.7');
      expect(await text(page, 'errMagnet'))
        .toMatch(/Magnet Ø must be 7\.6 mm or less .* the recesses the bowtie keys fit into/);
      expect(await text(page, 'pieceTail')).toMatch(/not building/);
      expect(await exportOff(page)).toBe(true);
      await page.selectOption('#connector', 'none');
      await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                                 null, { timeout: 30000 });
      expect(await max()).toBe('13.6');
      expect(await shown(page, 'errMagnet')).toBe(false);
      expect(await exportOff(page)).toBe(false);
      expect(errors).toEqual([]);
    });

  /* The shank's cap moves with the magnet typed after it, on the one read: the shank is
     read again after the head and the magnet (readControls). Pasted in, one input event
     and no change, 5.1 was measured against the 6 mm magnet before it, and built. */
  test('a screw hole is held inside the magnet pocket typed after it', async ({ page }) => {
    const errors = await openAt(page, '#cn=none&mg=1&ms=top&sc=1&sh=5&sd=5.4');
    expect(await shown(page, 'errScrew')).toBe(false);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    await page.evaluate(() => {
      const e = document.getElementById('magnetD');
      e.value = '5.1';
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    expect(await text(page, 'errScrew'))
      .toMatch(/Screw hole Ø must be 4\.9 mm or less — it runs through the 5\.1 mm magnet's pocket/);
    expect(await text(page, 'pieceTail')).toMatch(/not building/);
    expect(await exportOff(page)).toBe(true);
    await H.setField(page, 'magnetD', '6');
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                               null, { timeout: 30000 });
    expect(await shown(page, 'errScrew')).toBe(false);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  // one input event and no change, as a paste is
  const paste = (page, id, value) => page.evaluate(({ id, value }) => {
    const e = document.getElementById(id);
    e.value = value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, value });
  const settled = (page) => page.waitForFunction((re) => new RegExp(re).test(
    document.getElementById('pieceTail').textContent), SETTLED.source, { timeout: 30000 });

  /* #81: a counterbore that turns off the magnet pocket's flats is measured turned, so the
     head's cap goes by the head typed, and the head is read again on its own (readControls).
     At 46.45 mm with a jigsaw and a 6.2 mm magnet from beneath, a 14.05 mm head turns and
     stops at 14, where the 6 before it goes to 14.1. Pasted in, it was read against the 6's
     cap and built with Download on; and 14.1 pasted over a 14, which turns, was held to the
     14's cap and refused, at every read after as well. */
  test('a screw head is held to its own cap, not the one of the head before it', async ({ page }) => {
    const errors = await openAt(page, '#pi=46.45&w=92.9&d=92.9&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=58.45&bd=256' +
                                      '&cn=puzzle&mg=1&md=6.2&mh=2.4&ms=bottom&sc=1&sd=6');
    const max = () => page.evaluate(() => document.getElementById('screwHeadD').max);
    const refused = /Screw head Ø must be 14 mm or less at a 46\.45 mm pitch — .* a hole has to stay out of the notches the puzzle tabs fit into\./;
    expect(await max()).toBe('14.1');
    expect(await exportOff(page)).toBe(false);
    await paste(page, 'screwHeadD', '14.05');
    await page.waitForTimeout(250);
    expect(await max()).toBe('14');
    expect(await text(page, 'errScrew')).toMatch(refused);
    expect(await text(page, 'warnings'), 'the checks under the map say the same thing').toMatch(refused);
    expect(await text(page, 'pieceTail')).toMatch(/not building/);
    expect(await exportOff(page)).toBe(true);
    await H.setField(page, 'screwHeadD', '14');
    await settled(page);
    expect(await shown(page, 'errScrew')).toBe(false);
    expect(await exportOff(page)).toBe(false);
    await paste(page, 'screwHeadD', '14.1');
    await page.waitForTimeout(250);
    await settled(page);
    expect(await max()).toBe('14.1');
    expect(await shown(page, 'errScrew')).toBe(false);
    expect(await text(page, 'warnings')).not.toMatch(/Screw head Ø/);
    expect(await page.evaluate(() => state.screwHeadD)).toBe(14.1);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  /* And the shank after it, measured on the head as held. At 41.86 mm with a jigsaw, loose,
     a 7.8 mm hole is turned a little under an 8.3 mm head's corners (MOUNT_BORE.hole.turn),
     which stops it at 7.7, and not at all under the 7.9 mm the head is held to, which takes
     it. Pasted at 8.3, the head is refused and the hole is not. */
  test('a screw hole is measured under the head as held, not as typed', async ({ page }) => {
    const errors = await openAt(page, '#pi=41.86&w=83.72&d=83.72&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=53.86&bd=256' +
                                      '&cn=puzzle&to=loose&sc=1&sh=7.8&sd=6');
    const max = () => page.evaluate(() => document.getElementById('screwHoleD').max);
    expect(await max()).toBe('7.8');
    expect(await exportOff(page)).toBe(false);
    await paste(page, 'screwHeadD', '8.3');
    await page.waitForTimeout(250);
    expect(await text(page, 'errScrew')).toMatch(/Screw head Ø must be 7\.9 mm or less at a 41\.86 mm pitch/);
    expect(await text(page, 'errScrew')).not.toMatch(/Screw hole Ø/);
    expect(await text(page, 'warnings')).not.toMatch(/Screw hole Ø/);
    expect(await max()).toBe('7.8');
    expect(await page.evaluate(() => [state.screwHeadD, state.screwHoleD])).toEqual([7.9, 7.8]);
    expect(await exportOff(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  /* #70: corner pockets over a floor. A bowtie housed in the floor stood its 2.8 mm floor
     round the 2.6 mm bosses and sealed their pockets in it, with Download on, and an extra
     floor did the same. Such a plate is built as a solid floor builds it now, and Checks
     says so; the floor grows to suit, so a 3 mm magnet goes in where a boss stops at 2.4.
     With the key in the walls the underside is open and the bosses stand again. */
  test('corner pockets over a floor are cut into the floor, and Checks says so', async ({ page }) => {
    const errors = await openAt(page, `${BOWTIE_42}&bm=bosses&mg=1&mh=3`);
    const note = /Corner pockets need an open underside, and this joint is housed in a floor, so the plate is built with a solid floor and the magnet pockets are cut into it\./;
    expect(await text(page, 'warnings')).toMatch(note);
    expect(await shown(page, 'errMagnet')).toBe(false);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await exportOff(page)).toBe(false);
    await page.selectOption('#keyMount', 'wall');
    await page.waitForFunction((re) => new RegExp(re).test(
      document.getElementById('pieceTail').textContent), SETTLED.source, { timeout: 30000 });
    expect(await text(page, 'warnings')).not.toMatch(/Corner pockets need an open underside/);
    expect(await text(page, 'errMagnet')).toMatch(/Magnet depth must be 2\.4 mm or less with corner pockets/);
    expect(await exportOff(page)).toBe(true);
    expect(errors).toEqual([]);
  });
  /* #79's review: a refused pocket over a floored key went on to say that keys inside the
     walls, put in from above, keep out of the solid floor under it. With corner pockets
     that is the way back to #75: such a key needs no floor, so the bosses stand again
     and its cup stands in their pockets. An extra floor keeps them buried, and there the
     hint holds, as it does for a solid base. */
  test('corner pockets over a floored key are not pointed at keys put in from above', async ({ page }) => {
    const at = '#pi=37.98&w=151.92&d=75.96&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=91.96&bd=400&cn=bowtie&km=floor' +
               '&ki=bottom&bm=bosses&mg=1&md=5.81';
    const errors = await openAt(page, at);
    const refusal = /Magnet Ø must be 3\.8 mm or less at a 37\.98 mm pitch — .* the recesses the bowtie keys fit into/;
    const hint = /put in from above keep out of the solid floor/;
    expect(await text(page, 'errMagnet')).toMatch(refusal);
    expect(await text(page, 'errMagnet')).not.toMatch(hint);
    expect(await text(page, 'warnings')).not.toMatch(hint);
    expect(await exportOff(page)).toBe(true);
    await page.goto('about:blank');
    await openAt(page, at.replace('&bm=bosses', '&bm=bosses&bp=1'));
    expect(await text(page, 'errMagnet')).toMatch(refusal);
    expect(await text(page, 'errMagnet')).toMatch(hint);
    expect(errors).toEqual([]);
  });
  /* #75: a magnet's range stops where the cup of a key put in from above starts. At 5 mm
     the plate builds with Download on, 5.1 is refused and names the keys, and the same
     keys put in from beneath take their recess's 6.1 again. */
  test('a corner boss\'s pocket is held out of the cup a key drops into from above', async ({ page }) => {
    const at = '#pi=36.13&w=144.52&d=72.26&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=88.26&bd=400&cn=bowtie' +
               '&km=wall&ki=top&bm=bosses&mg=1';
    const errors = await openAt(page, `${at}&md=5`);
    const max = () => page.evaluate(() => document.getElementById('magnetD').max);
    expect(await max()).toBe('5');
    expect(await shown(page, 'errMagnet')).toBe(false);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await exportOff(page)).toBe(false);
    await H.setField(page, 'magnetD', '5.1');
    expect(await text(page, 'errMagnet'))
      .toMatch(/Magnet Ø must be 5 mm or less .* the housings the bowtie keys drop into from above; put in from beneath, the bowtie keys leave more room\./);
    expect(await text(page, 'pieceTail')).toMatch(/not building/);
    expect(await exportOff(page)).toBe(true);
    await page.selectOption('#keyInsert', 'bottom');
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                               null, { timeout: 30000 });
    expect(await max()).toBe('6.1');
    expect(await shown(page, 'errMagnet')).toBe(false);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });
  test('corner pockets under an extra floor are cut into it, and Checks says so', async ({ page }) => {
    const errors = await openAt(page, '#cn=none&bm=bosses&sc=1&bp=1');
    expect(await text(page, 'warnings')).toMatch(
      /Corner pockets need an open underside, and Extra floor closes it, so the plate is built with a solid floor and the screw pockets are cut into it\./);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  /* The half-inch magnet on the default dovetail at 42 mm: its pocket breaks 0.04 to
     0.09 mm into the notches, the magnet 0.24 mm clear of the tabs, and it builds clean,
     so the field takes it; 2.4 mm deep, level with the notch, it would not. */
  test('a half-inch magnet beside the default dovetail is taken', async ({ page }) => {
    const errors = await openAt(page, '#mg=1&md=12.7&mh=2');
    expect(await page.evaluate(() => document.getElementById('magnetD').max)).toBe('13.1');
    expect(await shown(page, 'errMagnet')).toBe(false);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('a typed value is held to the same range, and a good one clears it', async ({ page }) => {
    await H.openPlates(page);
    await H.setField(page, 'topCutoff', '0');
    expect(await text(page, 'errFloor')).toMatch(/Rim cutoff must be at least 0\.1 mm/);
    expect(await exportOff(page)).toBe(true);
    await H.setField(page, 'topCutoff', '0.4');
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent),
                               null, { timeout: 30000 });
    expect(await shown(page, 'errFloor')).toBe(false);
    expect(await exportOff(page)).toBe(false);
  });

  // a field you cannot see does not get to stop the build
  test('a magnet size with magnets off is not complained about', async ({ page }) => {
    await openAt(page, '#md=0&mh=-5');
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await shown(page, 'errMagnet')).toBe(false);
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

  /* Three rows, each its own piece, so the middle one is one cell deep with a seam on
     each side and a bowtie key from each, at the same place along both. Below 14.35 mm
     the two housings overlap and that piece came out with 47 open edges; the page said
     nothing and offered the download (test/plate-audit.js, the smallest pitch). The
     joints it names are the ones that clear at this pitch and were swept clean there
     (jointsThatFit), and the audit builds each. */
  const rows = (p, w) => `#pi=${p}&w=${w}&d=${w}&sp=manual&rc=1,2&cc=__&cn=bowtie`;
  const instead = 'or use a joint that fits at 13\\.5 mm: dovetail tabs; puzzle tabs; H-clips put in ' +
    'from beneath or above; snap clips inside the walls, put in from above; or bowtie keys ' +
    'inside the walls, put in from beneath\\.';
  test('keys that meet across a piece one cell deep are a check, not a plate', async ({ page }) => {
    const errors = await openAt(page, rows(13.5, 40.5));
    expect(await page.evaluate(() => layout.pieces.map((pc) => `${pc.id} ${pc.nx}x${pc.ny}`)),
      'fixture: three rows, one cell deep each').toEqual(['A1 3x1', 'A2 3x1', 'A3 3x1']);
    expect(await text(page, 'warnings')).toMatch(new RegExp(
      'Piece A2 is one cell deep between two seams, and at this 13\\.5 mm pitch the keys ' +
      'on its two sides are too close: their housings run into each other, which leaves ' +
      'holes in the plate\\. Move a cut so it is two cells deep, use a pitch of ' +
      '14\\.35 mm or more, ' + instead));
    expect(await text(page, 'pieceTail')).toMatch(/not building/);
    await page.locator('#openExport').click();
    expect(await text(page, 'exFit')).toMatch(/Piece A2 is one cell deep.*Nothing can be exported until that is fixed\./);
    expect(errors).toEqual([]);
  });

  // the same across three columns, where the piece is one cell wide
  test('keys that meet across a piece one cell wide say wide', async ({ page }) => {
    const errors = await openAt(page, '#pi=13.5&w=40.5&d=40.5&sp=manual&rc=&cc=1.2&cn=bowtie');
    expect(await page.evaluate(() => layout.pieces.map((pc) => `${pc.id} ${pc.nx}x${pc.ny}`)),
      'fixture: three columns, one cell wide each').toEqual(['A1 1x3', 'B1 1x3', 'C1 1x3']);
    expect(await text(page, 'warnings')).toMatch(new RegExp(
      'Piece B1 is one cell wide between two seams, .* Move a cut so it is two cells wide, ' +
      'use a pitch of 14\\.35 mm or more, ' + instead));
    expect(errors).toEqual([]);
  });

  /* Clear of each other was not the same as clean. At 13.6 mm with a clearance of 0.3 the
     dovetail's tabs are clear of each other, and that plate had 12 open edges, so it was
     named only from 14.5 mm. The joint's cut taken again closes them (cutAgain in
     core.js, and test/plate-audit.js builds every joint named), so it is named, and
     following the words gives a plate that builds and downloads. */
  test('a joint named at 13.6 mm builds when you pick it', async ({ page }) => {
    const errors = await openAt(page,
      '#pi=13.6&w=40.8&d=40.8&mm=custom&ml=0&mr=0&mf=0&mb=0&sp=manual&rc=1,2&cc=__&cn=bowtie&cl=0.3');
    const said = await text(page, 'warnings');
    expect(said).toMatch(/Piece A2 is one cell deep between two seams/);
    expect(said).toMatch(new RegExp('or use a joint that fits at 13\\.6 mm: dovetail tabs; puzzle ' +
      'tabs; H-clips put in from beneath or above; snap clips inside the walls, put in from ' +
      'above; or bowtie keys inside the walls, put in from beneath\\.'));
    await page.selectOption('#connector', 'dovetail');
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent));
    expect(await text(page, 'warnings')).not.toMatch(/between two seams/);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  // and at 14.5 mm the key from above clears as well, so it is named both ways
  test('every joint that clears is named', async ({ page }) => {
    const errors = await openAt(page, rows(14.5, 43.5) + '&cl=0.3');
    expect(await text(page, 'warnings')).toMatch(new RegExp('or use a joint that fits at ' +
      '14\\.5 mm: dovetail tabs; puzzle tabs; H-clips put in from beneath or above; snap clips ' +
      'inside the walls, put in from above; or bowtie keys inside the walls, put in from ' +
      'beneath or above\\.'));
    expect(errors).toEqual([]);
  });

  /* The H-clip is named by the way it goes in, and picking H-clips keeps the Key insertion
     you had. It was named from beneath alone, so from a key put in from above you got the
     H-clip from above, which the words did not name and which leaked at a field of 0.74
     (six bad edges on two of three rows at 42 mm). That one builds clean now, and is
     named, and picking it clears the check with the insertion as it was. */
  test('the H-clip is named both ways in, and the one you get clears the check', async ({ page }) => {
    const errors = await openAt(page, '#pi=14.38&w=43.14&d=43.14&mm=custom&ml=0&mr=0&mf=0&mb=0' +
      '&sp=manual&rc=&cc=1.2&cn=bowtie&km=wall&ki=top&cl=0.74');
    expect(await text(page, 'warnings')).toMatch(new RegExp('Piece B1 is one cell wide .* ' +
      'or use a joint that fits at 14\\.38 mm: dovetail tabs; puzzle tabs; H-clips put in from ' +
      'beneath or above; snap clips inside the walls, put in from above; or bowtie keys inside ' +
      'the walls, put in from beneath\\.'));
    await page.selectOption('#connector', 'hclip');
    expect(await page.locator('#keyInsert').inputValue(), 'fixture: the design is put in from above')
      .toBe('top');
    await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail').textContent));
    expect(await text(page, 'warnings')).not.toMatch(/between two seams/);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  /* On a snap plate the snap clip from above is the snap clip inside the walls from
     above, so it is named once: it was named as "snap clips put in from above" and again
     as "snap clips inside the walls, put in from above". */
  test('a snap plate names the snap clip once', async ({ page }) => {
    const errors = await openAt(page, '#pi=15.29&w=45.87&d=45.87&mm=custom&ml=0&mr=0&mf=0&mb=0' +
      '&sp=manual&rc=1,2&cc=__&cn=snap&cl=1');
    // the whole list, from the pitch to its full stop, so nothing is named twice
    const named = (await text(page, 'warnings')).split('or use a joint that fits at ')[1] || '';
    expect(named).toMatch(new RegExp('^15\\.29 mm: dovetail tabs; puzzle tabs; H-clips put in ' +
      'from beneath or above; or snap clips inside the walls, put in from beneath or above\\.'));
    expect(errors).toEqual([]);
  });

  /* Rows one cell deep and columns one cell wide in one drawer. It said "Pieces A2 and
     B3 have one cell between two seams … Move a cut so they have two", which left you to
     work out which piece was narrow which way. */
  test('keys that meet both ways say which piece is which', async ({ page }) => {
    const errors = await openAt(page,
      '#pi=13.5&w=40.5&d=67.5&mm=custom&ml=0&mr=0&mf=0&mb=0&sp=manual&rc=1,2&cc=__1.2&cn=bowtie');
    expect(await text(page, 'warnings')).toMatch(new RegExp(
      'Piece A2 is one cell deep and piece B3 one cell wide between two seams, and at this ' +
      '13\\.5 mm pitch the keys on their two sides are too close: their housings run into ' +
      'each other, which leaves holes in the plate\\. Move a cut so each has two cells ' +
      'between its seams, use a pitch of 14\\.35 mm or more, ' + instead));
    expect(errors).toEqual([]);
  });

  // and the pitch it names is enough: the same split builds, with nothing to say
  test('at the pitch the check names, the same rows build', async ({ page }) => {
    const errors = await openAt(page, rows(14.35, 43.05));
    expect(await page.evaluate(() => layout.pieces.length)).toBe(3);
    expect(await text(page, 'warnings')).not.toMatch(/between two seams/);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(errors).toEqual([]);
  });
});

/* ---- limits no tighter than the geometry ------------------------------------------ */
/* The cases above are numbers refused one step before they break something. These are
   the other side of the same ranges: numbers that build clean and were refused anyway,
   because a limit measured on one configuration was held over others — and a pitch with
   no room for a cut at all, which put its complaint on a field no value could satisfy. */
test.describe('limits no tighter than the geometry', () => {
  // 4 × 2 cells cut once: two pieces and one seam, quick to build
  const SEAM = '#w=168&d=84&sp=manual&rc=&cc=2';
  const seamAt = (p) => `#pi=${p}&w=${4 * p}&d=${2 * p}&sp=manual&rc=&cc=2`;

  for (const cn of ['puzzle', 'bowtie', 'puzzlekey', 'snap', 'hclip'])
    test(`a ${cn} at 0.5 mm clearance builds — the 0.3 ceiling is the dovetail's`, async ({ page }) => {
      const errors = await openAt(page, `${SEAM}&cn=${cn}&cl=0.5`);
      expect(await shown(page, 'errConnClr')).toBe(false);
      expect(await text(page, 'pieceTail')).toMatch(/ready/);
      expect(await page.evaluate(() => state.tab.clr)).toBe(0.5);
      expect(await exportOff(page)).toBe(false);
      expect(errors).toEqual([]);
    });

  /* The coupon prints four pairs from 0.05 tighter to 0.1 looser than the joint, so a
     dovetail at 0.25 printed a 0.35 pair — a fit the field then refuses. At the top of
     a joint's range the slackest pair is the ceiling itself, and all four still differ.
     [link, the joint's clearance as set, its ceiling]: a bowtie's key is cut 0.05 under
     the field, so the field's 1 mm is 0.95 on the key. */
  for (const [hash, nominal, ceiling] of [[`${SEAM}&cn=dovetail&cl=0.25`, 0.25, 0.3],
                                          [`${SEAM}&cn=dovetail&cl=0.3`, 0.3, 0.3],
                                          [`${SEAM}&cn=bowtie&cl=1`, 0.95, 0.95],
                                          // the other ceilings, each at its own; a snap clip
                                          // dropped in from above is cut to the key's 0.25,
                                          // whose slot stands a BLOAT off the seam face
                                          [`${SEAM}&cn=snap&km=wall&ki=top&cl=0.3`, 0.25, 0.25],
                                          [`${SEAM}&cn=puzzlekey&cl=0.8`, 0.75, 0.75],
                                          [`${seamAt(18)}&cn=puzzlekey&cl=0.3`, 0.25, 0.25],
                                          [`${seamAt(13.5)}&cn=puzzle&cl=0.25`, 0.25, 0.25]])
    test(`the fit sample stays inside the range: ${hash}`, async ({ page }) => {
      const errors = await openAt(page, hash);
      const clrs = await page.evaluate(() => fitSample().clrs);
      expect(clrs).toHaveLength(4);
      expect(new Set(clrs.map((c) => c.toFixed(2))).size, 'four different fits').toBe(4);
      for (const c of clrs) expect(c, `pairs ${clrs.join(', ')}`).toBeLessThanOrEqual(ceiling + 1e-9);
      expect(clrs.map((c) => c.toFixed(2)), 'the joint as set is one of the pairs')
        .toContain(nominal.toFixed(2));
      expect(errors).toEqual([]);
    });

  // the Gridfinity spec's own magnet, 6.5 × 2.4, in a 2.6 mm boss with a layer over it
  test('a 2.4 mm magnet in a corner boss builds', async ({ page }) => {
    const errors = await openAt(page, '#w=84&d=84&mg=1&md=6.5&mh=2.4&bm=bosses');
    expect(await shown(page, 'errMagnet')).toBe(false);
    expect(await text(page, 'pieceTail')).toMatch(/ready/);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  /* 2.8 mm of floor holds a 2.4 mm magnet over 0.4 of plastic and always has: the plate
     is 7.05 mm tall, and so is the height handed to the Bins page with it. */
  test('a 2.4 mm magnet leaves the solid floor at 2.8 mm', async ({ page }) => {
    await openAt(page, '#w=84&d=84&mg=1&md=6.5&mh=2.4');
    const s = await page.evaluate(() => ({
      planned: plateHeightMm(), built: builds[layout.pieces[0].id].meta.H }));
    expect(s.planned).toBeCloseTo(7.05, 9);
    expect(s.built).toBeCloseTo(7.05, 9);
  });

  /* The 34.5 mm case takes no joint: the default dovetail's tabs hold its 6 mm screw
     head to 4.7 mm there, which is a field error of its own. It was 34 mm until a head
     was cut with its flats on its size; at 34 the cell now has room for a 5.8 mm head,
     so the 6 mm one would be a field error too, and 34.5 still has no room for a shank.
     The puzzle tabs' are what leave a magnet no room at 36 mm, where the cell alone
     would take 7.7. */
  for (const [hash, id, errId, carried, msg] of [
    ['#cn=none&sc=1&pi=34.5', 'screwHoleD', 'errScrew', 3,
     /Screw hole Ø: there is no room for one at a 34\.5 mm pitch.*Use a larger pitch, or turn off screw holes\./],
    ['#mg=1&pi=20', 'magnetD', 'errMagnet', 6,
     /Magnet Ø: there is no room for one at a 20 mm pitch.*Use a larger pitch, or turn off magnet pockets\./],
    ['#cn=puzzle&mg=1&pi=36', 'magnetD', 'errMagnet', 6,
     /Magnet Ø: there is no room for one at a 36 mm pitch — .* the notches the puzzle tabs fit into\. Use a larger pitch, or turn off magnet pockets\./]])
    test(`${hash}: no room at all is a check on the design, not a field nothing satisfies`,
      async ({ page }) => {
        const errors = await openAt(page, hash);
        const f = await page.evaluate((i) => {
          const e = document.getElementById(i);
          return { valid: e.validity.valid, invalid: e.getAttribute('aria-invalid'),
                   min: e.min, max: e.max, state: state[i] };
        }, id);
        expect(f.valid, `the field has to have a value it accepts (min ${f.min}, max ${f.max})`).toBe(true);
        if (f.max !== '') expect(Number(f.max)).toBeGreaterThanOrEqual(Number(f.min));
        expect(f.invalid).toBe('false');
        expect(await shown(page, errId), 'no number in the field fixes this').toBe(false);
        expect(f.state, 'the size the link carries is kept for a larger pitch').toBe(carried);
        expect(await text(page, 'warnings')).toMatch(msg);
        expect(await text(page, 'pieceTail')).toMatch(/not building/);
        expect(await exportOff(page)).toBe(true);
        expect(errors).toEqual([]);
      });
});

/* ---- #19: a build that throws ----------------------------------------------------- */
/* ---- the clearance ceiling is the joint's and the pitch's ---------------------------- */
/* A 1 mm ceiling for every joint but the dovetail let through two kinds of plate. A snap
   clip dropped in from above is housed in a slot whose seam-side wall stands 0.3 mm less
   the clearance from the seam, so at 0.35 on the field the wall lies in the seam face and
   past it in the next piece — the field stops at 0.3, a BLOAT short of the face;
   and under 20 mm (20.7 for the puzzle) the puzzle and the puzzle key leave plates that
   are not watertight at clearances that build closed at 42. Each case is refused at the
   field, clamped to the ceiling in the state a link loads into, and says which joint and
   which pitch — the pitch is the number to change. A joint that builds closed at a small
   pitch is not held to the others' reason: the bowtie in the floor was, until a sweep
   built it closed from 13.5 to 20 mm at every clearance to 1. */
test.describe('the clearance ceiling is the joint\'s and the pitch\'s', () => {
  const SEAM = '#w=168&d=84&sp=manual&rc=&cc=2';
  for (const [hash, ceiling, msg] of [
    [`${SEAM}&cn=snap&km=wall&ki=top&cl=0.35`, 0.3,
     /Fit clearance must be 0\.3 mm or less — any looser and the housing of a snap clip dropped in from above runs up to the seam and on into the next piece\./],
    ['#pi=18&cn=puzzle&cl=1', 0.3,
     /Fit clearance must be 0\.3 mm or less at an 18 mm pitch — on cells under 20\.7 mm a looser puzzle tab leaves the plate not watertight\./],
    ['#pi=14&cn=puzzlekey&cl=0.5', 0.3,
     /Fit clearance must be 0\.3 mm or less at a 14 mm pitch — on cells under 20 mm a looser puzzle key leaves the plate not watertight\./],
    ['#pi=13.5&cn=puzzle&cl=0.3', 0.25,
     /Fit clearance must be 0\.25 mm or less at a 13\.5 mm pitch — on cells under 20\.7 mm a looser puzzle tab leaves the plate not watertight\./],
    ['#pi=20.3&cn=puzzle&cl=0.9', 0.3,
     /Fit clearance must be 0\.3 mm or less at a 20\.3 mm pitch — on cells under 20\.7 mm a looser puzzle tab leaves the plate not watertight\./],
    ['#cn=puzzlekey&cl=0.85', 0.8,
     /Fit clearance must be 0\.8 mm or less — any looser and a puzzle key's recess leaves the plate not watertight at some pitches\./],
  ])
    test(`${hash} is held to ${ceiling}, and says why`, async ({ page }) => {
      const errors = await openAt(page, hash);
      expect(await text(page, 'errConnClr')).toMatch(msg);
      expect(await shown(page, 'errConnClr')).toBe(true);
      expect(await text(page, 'warnings')).toMatch(msg);
      const f = await page.evaluate(() => ({
        clr: state.tab.clr, max: document.getElementById('connClr').max }));
      expect(f.clr, 'the link\'s figure is clamped to the ceiling').toBe(ceiling);
      expect(Number(f.max), 'the field offers no more than the ceiling').toBe(ceiling);
      expect(await text(page, 'pieceTail')).toMatch(/not building/);
      expect(await exportOff(page)).toBe(true);
      expect(errors).toEqual([]);
    });

  // the snap, the H-clip and the bowtie built closed at every clearance and pitch measured
  for (const hash of ['#pi=16&w=64&d=32&sp=manual&rc=&cc=2&cn=hclip&cl=1',
                      '#pi=16&w=64&d=32&sp=manual&rc=&cc=2&cn=snap&cl=1',
                      '#pi=16&w=64&d=32&sp=manual&rc=&cc=2&cn=bowtie&cl=1'])
    test(`${hash} builds — the small-pitch hold is not every joint's`, async ({ page }) => {
      const errors = await openAt(page, hash);
      expect(await shown(page, 'errConnClr')).toBe(false);
      expect(await text(page, 'pieceTail')).toMatch(/ready/);
      expect(await exportOff(page)).toBe(false);
      expect(errors).toEqual([]);
    });
});

/* ---- #73: a screw head only a hair wider than its shank ---------------------------- */
/* Its counterbore's 14 flats crossed the shank's 12 corners, and the plate leaked by the
   hundred with nothing said and Download on: on main, a 2.03 mm head over a 2 mm shank
   left 196 edges in each of two pieces at 37.67 mm. A head that does not clear the shank's
   corners is cut as none now, as one no wider than the hole always was (MOUNT_BORE in
   core.js): within 3.5% of the hole it is no seat for a screw head. So the link builds
   with Download on and nothing in Checks, and the README says there is no counterbore
   and from what size there would be one, as does a line under the fields. 2.1 mm clears a
   2 mm hole and is cut; 2 mm is no wider than the hole, and needs no word. */
test.describe('a screw head that does not clear its shank is cut as none', () => {
  const AT = '#pi=37.67&w=150.68&d=75.34&mm=custom&ml=0&mr=0&mf=0&mb=0&bw=91.34&bd=400' +
    '&sc=1&sh=2&cn=none';
  for (const [sd, says, hint] of [
    ['2.03', 'Screws: 2 mm holes, no counterbore (a head clears a 2 mm hole from 2.09 mm)',
      'A 2.03 mm head does not clear the corners of a 2 mm hole, so no counterbore is cut. ' +
      'One is from 2.09 mm.'],
    ['2.1', 'Screws: 2 mm holes, 2.1 mm counterbore', null],
    ['2', 'Screws: 2 mm holes, no counterbore', null],
  ])
    test(`a ${sd} mm head over a 2 mm shank builds, and the README says what was cut`,
      async ({ page }) => {
        const errors = await openAt(page, `${AT}&sd=${sd}`);
        expect(await text(page, 'pieceTail')).toMatch(/ready/);
        expect(await shown(page, 'errScrew')).toBe(false);
        expect(await exportOff(page)).toBe(false);
        const readme = (await page.evaluate(() => readmeText())).split('\n');
        expect(readme).toContain(says);
        expect(await shown(page, 'screwHeadHint')).toBe(!!hint);
        if (hint) expect(await text(page, 'screwHeadHint')).toBe(hint);
        expect(errors).toEqual([]);
      });
  /* The line names a size the field takes, or says none fits: a bowtie in the floor at
     42 mm holds the head to 7.6 mm, and over a 7.5 mm hole a counterbore is cut only
     from 7.78. It is read with the field. */
  test('where no counterbore fits, the line says so rather than naming one the field refuses',
    async ({ page }) => {
      const errors = await openAt(page, '#cn=bowtie&sc=1&sh=7.5&sd=7.55');
      expect(await shown(page, 'errScrew')).toBe(false);
      expect(await text(page, 'screwHeadHint')).toBe('A 7.55 mm head does not clear the corners of ' +
        'a 7.5 mm hole, so no counterbore is cut. None fits here: one is from 7.78 mm, and the ' +
        'head stops at 7.6 mm.');
      expect(await page.getAttribute('#screwHeadD', 'aria-describedby')).toContain('screwHeadHint');
      expect(errors).toEqual([]);
    });
});

/* The checks name the piece as well (#76). The table, the preview and Download's tooltip
   said so already, but the list under the cut map, where a design is read for what is
   wrong with it, was empty, so Download was off with no reason given there. The failure is
   forced rather than taken from a design that fails, which would tie this test to an engine
   bug a later fix should remove: #76's plate builds now (below), and so does the 41.24 mm
   jigsaw plate in plate-audit.js, which failed in the seam repair on main. */
test('a failed build says so in the checks, the table and the dialog, and Download goes off',
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
      checks: [...document.querySelectorAll('#warnings .w.err')].map((w) => w.textContent),
    }));
    expect(s.tail).toMatch(new RegExp(`build failed at piece ${s.failed}`));
    expect(s.checks.join(' '), 'the checks name the piece that failed')
      .toMatch(new RegExp(`Piece ${s.failed} could not be built`));
    // Download, not every file: the pieces built before it keep their own STL buttons
    expect(s.checks.join(' ')).toMatch(/Download is off/);
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
    expect(await text(page, 'warnings')).not.toMatch(/could not be built/);
  });

/* #76: B1 of this plate threw in the engine's seam repair (healCsgSeams), so only A1 was
   ever listed and Download stayed off. At 2.33 or 2.35 mm it built; plate-audit.js has the
   rows either side. */
test('#76: the 39.07 mm dovetail plate with a 2.34 mm counterbore builds both pieces',
  async ({ page }) => {
    const errors = await openAt(page, '#pi=39.07&w=170&d=90&bw=100&bd=400&cn=dovetail&sc=1&sh=3&se=2.34&sd=8',
                                60000);
    expect(await text(page, 'pieceTail')).toMatch(/2 ready/);
    expect(await text(page, 'warnings')).not.toMatch(/could not be built/);
    expect(await exportOff(page)).toBe(false);
    expect(errors).toEqual([]);
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

  /* 0 is an answer for the spacing and stays 0, and it was let through for the stack gap
     on the same terms — but there it stands the upper piece straight on the lower one,
     and the slicer prints the two as one part. */
  test('a stack gap of 0 still leaves a layer between stacked pieces', async ({ page }) => {
    await openAt(page, TWO);
    await page.waitForFunction(() => !!printPlan);
    await page.evaluate(() => { document.getElementById('stackToggle').checked = true; });
    await H.setField(page, 'stackGap', '0');
    const s = await page.evaluate(() => ({
      H: builds[layout.pieces[0].id].meta.H,
      zs: printPlan.plates.flatMap((pl) => pl.placed.map((p) => p.z)).filter((z) => z > 0),
    }));
    expect(s.zs.length, 'the fixture has to stack, or this proves nothing').toBeGreaterThan(0);
    for (const z of s.zs) expect(z, 'one 0.2 mm layer over the piece below').toBeGreaterThanOrEqual(s.H + 0.2 - 1e-6);
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

/* A piece whose joints take it past the bed. The check above the plan counts only a
   dovetail's tabs, so this one builds; the plan noted it as a plate of its own that
   prints nothing, and the next piece was packed onto that plate. Drawn and downloaded,
   that was a plate that looked like it held A1 and a file without it. The plan now
   leaves it out, every other piece is on a plate that has a file, and A1 is named. */
test('a piece too big for the bed with its joints is named, and takes no other piece with it',
  async ({ page }) => {
    const errors = await openAt(page,
      '#w=330&d=330&bw=220&bd=180&mm=custom&ml=5&mr=0&mf=5&mb=0&cn=puzzle&v=2', 60000);
    await page.waitForFunction(() => !!printPlan, null, { timeout: 60000 });
    const s = await page.evaluate(() => ({
      pieces: layout.pieces.map((pc) => pc.id),
      planned: printPlan.plates.map((pl) => pl.placed.map((p) => p.id)),
      over: printPlan.over,
    }));
    expect(s.over).toEqual(['A1']);
    expect(s.planned.every((ids) => ids.length > 0), 'no plate without anything on it').toBe(true);
    expect(s.planned.flat().sort(), 'every other piece is on a plate')
      .toEqual(s.pieces.filter((id) => id !== 'A1').sort());
    expect(await text(page, 'planTail')).toContain('1 part too big for the bed');
    expect(await text(page, 'platesRow')).toContain('Piece A1 does not fit the 220 × 180 mm bed');
    await page.locator('#openExport').click();
    expect(await page.locator('#exFiles [data-ex="plate"]').count()).toBe(s.planned.length);
    expect(errors).toEqual([]);
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

/* ---- half cells, arriving by link (#16) ------------------------------------------- */
/* Half cells are a value of the margin key the link already had, `mm=half`, so they come
   the way every other design does — and a page from before them meets the value too. */
test.describe('half cells from a link', () => {
  /* The page's own drawer: 12 mm over across and 2 mm deep. Asked for half cells, it has
     room for none, and the plate is the solid-margin one — test/plate-audit.js holds it
     to the same bytes. The check says so in the drawer's figures, and is a note, not an
     error: there is nothing wrong with the design. */
  test('no room for half cells is a note with the real figures, and a solid margin',
    async ({ page }) => {
      const errors = await openAt(page, '#mm=half');
      const s = await page.evaluate(() => ({
        mode: state.marginMode, strips: [layout.hX, layout.hY],
        margins: [layout.mL, layout.mR, layout.mF, layout.mB],
        summary: document.getElementById('gridSummary').textContent,
      }));
      expect(s.mode).toBe('half');
      expect(s.strips).toEqual([0, 0]);
      expect(s.margins).toEqual([6, 6, 1, 1]);
      expect(s.summary).not.toContain('half');
      const w = page.locator('#warnings .w');
      await expect(w.filter({ hasText: 'No room for half cells' })).toHaveText(
        'No room for half cells: 12 mm is left across and 2 mm deep, and a half cell needs 21 mm.');
      await expect(w.filter({ hasText: 'No room for half cells' })).not.toHaveClass(/err/);
      await expect(w.filter({ hasText: 'Half cells take' })).toHaveCount(0);
      expect(await exportOff(page)).toBe(false);
      expect(await text(page, 'pieceTail')).toMatch(/ready/);
      expect(errors).toEqual([]);
    });

  /* The strips go right and back whatever the alignment says; the alignment places what
     is left. 199 mm is four cells, a half column and 10 mm: "Right (margin left)" puts
     the 10 mm on the left, and "Front (margin back)" puts the depth's behind the half
     row. The menus come back as the link left them, and the link says the same again. */
  test('a link keeps its half cells, and its alignment places the rest', async ({ page }) => {
    const errors = await openAt(page, '#w=199&d=199&mm=half&ax=start&ay=end');
    const s = await page.evaluate(() => ({
      menus: ['marginMode', 'alignX', 'alignY'].map((id) => document.getElementById(id).value),
      strips: [layout.hX, layout.hY],
      summary: document.getElementById('gridSummary').textContent,
      link: shareLink(),
    }));
    expect(s.menus).toEqual(['half', 'start', 'end']);
    expect(s.strips).toEqual([1, 1]);
    expect(s.summary).toContain('plus a half column on the right and a half row at the back');
    expect(s.summary).toContain('margins L 10.0 / R 0.0 / F 0.0 / B 10.0 mm');
    expect(s.link).toMatch(/[#&]mm=half(&|$)/);
    expect(s.link).toMatch(/[#&]ax=start(&|$)/);
    expect(errors).toEqual([]);
  });

  /* A half cell is half the pitch. The menu said 21 mm whatever panel 06 held, and the
     check would have measured a 30 mm grid's leftover against a 42 mm grid's half cell. */
  test('a half cell is half the pitch, in the menu and in the check', async ({ page }) => {
    await openAt(page, '#pi=30&w=310&d=325&mm=half');
    expect(await page.evaluate(() =>
      document.querySelector('#marginMode option[value="half"]').textContent))
      .toBe('Fill with half cells where they fit (15 mm)');
    await expect(page.locator('#warnings .w').filter({ hasText: 'No room for half cells' }))
      .toHaveCount(0);
    expect(await page.evaluate(() => [layout.hX, layout.hY])).toEqual([0, 1]);
    await openAt(page, '#pi=30&w=310&d=310&mm=half');
    await expect(page.locator('#warnings .w').filter({ hasText: 'No room for half cells' }))
      .toHaveText('No room for half cells: 10 mm is left across and 10 mm deep, and a half cell needs 15 mm.');
  });

  /* What is left is rounded down. Rounded to the nearest, 20.996 mm read as the 21 mm a
     half cell needs, in the line saying there was no room for one. */
  test('the room left is never rounded up to a half cell', async ({ page }) => {
    await openAt(page, '#w=398.996&d=314.996&mm=half');
    await expect(page.locator('#warnings .w').filter({ hasText: 'No room for half cells' }))
      .toHaveText('No room for half cells: 20.99 mm is left across and 20.99 mm deep, and a half cell needs 21 mm.');
  });

  /* And the half cell is rounded up. Rounded to the nearest, a pitch with a third decimal
     in its half — 42.01, 13.51, 13.53 — quoted the same figure as the room left: "21 mm
     is left across … and a half cell needs 21 mm". The menu and the README quote that
     size too, so all three say the same number. */
  test('the size a half cell needs is never rounded down to the room left', async ({ page }) => {
    const note = () => page.locator('#warnings .w').filter({ hasText: 'No room for half cells' });
    const menu = () => page.evaluate(() =>
      document.querySelector('#marginMode option[value="half"]').textContent);
    const readme = () => page.evaluate(() => readmeText());
    await openAt(page, '#pi=42.01&w=399.09&d=300&mm=half');
    await expect(note()).toHaveText(
      'No room for half cells: 21 mm is left across and 5.93 mm deep, and a half cell needs 21.01 mm.');
    expect(await menu()).toBe('Fill with half cells where they fit (21.01 mm)');
    for (const [pi, w, left, size] of [[13.51, 141.85, 6.75, 6.76], [13.53, 142.06, 6.76, 6.77]]) {
      await openAt(page, `#pi=${pi}&w=${w}&d=${w}&mm=half`);
      await expect(note()).toHaveText(`No room for half cells: ${left} mm is left across and ` +
        `${left} mm deep, and a half cell needs ${size} mm.`);
      expect(await menu()).toBe(`Fill with half cells where they fit (${size} mm)`);
      // one more hundredth across, and the column fits; the README quotes it at the same size
      await openAt(page, `#pi=${pi}&w=${(w + 0.01).toFixed(2)}&d=${w}&mm=half`);
      expect(await page.evaluate(() => [layout.hX, layout.hY])).toEqual([1, 0]);
      expect(await readme()).toContain(`Half cells: a half column on the right (${size} mm)`);
    }
  });

  /* A piece of 1½ × 1½ cells is not a single cell, and the note suggesting a cut be moved
     for a sturdier layout said it was. A whole single cell still gets it. */
  test('a piece with half cells on it is not a single cell', async ({ page }) => {
    const note = (p) => p.locator('#warnings .w').filter({ hasText: 'A piece is a single cell' });
    await openAt(page, '#w=63&d=63&mm=half');
    expect(await page.evaluate(() => layout.pieces.map((pc) => [pc.nx, pc.ny, !!pc.hR, !!pc.hB])))
      .toEqual([[1, 1, true, true]]);
    await expect(note(page)).toHaveCount(0);
    await openAt(page, '#w=63&d=63');
    await expect(note(page)).toHaveCount(1);
  });

  /* A link made here, opened in a page from before half cells: a stale tab, or a saved
     copy. That page's menu has no 'half', and set() in loadFromHash takes only a value its
     menu offers, so the menu stays where it was and the plate gets a solid margin rather
     than anything half-built. This page's loader is that same code, unchanged, so taking
     the option out of the menu is the old page as far as this link can tell. */
  test('a page without the option reads a half-cell link as a solid margin', async ({ page }) => {
    const errors = await openAt(page, '');
    const s = await page.evaluate(() => {
      // optional, so that main's page, which has no such option, runs this test as well
      const opt = document.querySelector('#marginMode option[value="half"]');
      if (opt) opt.remove();
      loadFromHash('w=400&d=330&mm=half');
      recomputeLayout();
      /* `|| 0` for the same page: its layout has no hX or hY at all, and a strip it never
         heard of is no strip. Read straight, the test failed there on undefined. */
      return { menu: document.getElementById('marginMode').value, mode: state.marginMode,
               strips: [layout.hX || 0, layout.hY || 0], link: descriptor().mm,
               margins: [layout.mL, layout.mR, layout.mF, layout.mB] };
    });
    expect(s.menu).toBe('auto');
    expect(s.mode).toBe('auto');
    expect(s.link, 'the link it writes back says what it built').toBe('auto');
    expect(s.strips).toEqual([0, 0]);
    expect(s.margins).toEqual([11, 11, 18, 18]);
    expect(errors).toEqual([]);
  });
});
