/* The printer you pick, and what it does to the pieces.
 *
 * The preset list carried "220 × 220 × 250 (Ender 3, A1 mini class)". The A1 mini is a
 * 180 mm printer, so an A1 mini owner who picked the entry with their printer's name in
 * it got five-cell, 210 mm pieces — and every check on the page passed, because the
 * checks trust the bed they are given. Nothing downstream can catch a wrong bed; the
 * only defence is the list itself, so these hold the list to the printer it names.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

/* Every option that names a printer, and the bed that option fills in. Read from the
   page rather than written out here, so a new entry is covered without anyone
   remembering to add it. */
const namedOptions = (page, name) => page.evaluate((name) =>
  [...document.querySelectorAll('#bedPreset option')]
    .filter((o) => o.textContent.includes(name))
    .map((o) => ({ value: o.value, label: o.textContent })), name);

const pick = (page, value) => page.evaluate((value) => {
  const s = document.getElementById('bedPreset');
  s.value = value;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

const bed = (page) => page.evaluate(() =>
  ['bedW', 'bedD', 'bedH'].map((id) => +document.getElementById(id).value));

for (const [name, open] of [['baseplates', H.openPlates], ['bins', H.openBins]]) {
  test(`${name}: the entry that names the A1 mini gives it a 180 mm bed`, async ({ page }) => {
    await H.forgetSaved(page);
    await open(page);
    const opts = await namedOptions(page, 'A1 mini');
    expect(opts.length, 'nothing in the list names the A1 mini').toBeGreaterThan(0);
    for (const o of opts) {
      await pick(page, o.value);
      expect(await bed(page), `"${o.label}" fills in the wrong bed`).toEqual([180, 180, 180]);
    }
  });
}

/* The consequence, on the plate: a 180 mm bed takes four cells, not five. The default
   drawer is 7 × 9 cells, so a five-cell piece is what a wrong bed would produce. */
test('baseplates: the A1 mini gets pieces of at most 4 × 4 cells, all of which fit',
  async ({ page }) => {
    await H.forgetSaved(page);
    await H.openPlates(page);
    const [o] = await namedOptions(page, 'A1 mini');
    await pick(page, o.value);
    await page.waitForFunction(
      () => /ready/.test(document.getElementById('pieceTail').textContent),
      null, { timeout: 60000 });

    const s = await page.evaluate(() => ({
      bed: [state.bedW, state.bedD],
      grid: [layout.nx, layout.ny],
      pieces: layout.pieces.map((pc) => [pc.nx, pc.ny]),
      allFit: layout.pieces.every(pieceFits),
      rows: document.getElementById('pieceRows').textContent,
    }));
    expect(s.bed).toEqual([180, 180]);
    expect(s.grid, 'fixture: the drawer must be bigger than five cells each way')
      .toEqual([7, 9]);
    expect(Math.max(...s.pieces.flat()), 'a piece wider than four cells').toBeLessThanOrEqual(4);
    expect(s.allFit).toBe(true);
    expect(s.rows).not.toMatch(/TOO BIG/);
  });
