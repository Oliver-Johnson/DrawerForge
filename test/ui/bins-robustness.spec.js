/* The bins page against input it did not expect: values past their limits, links that
 * put two bins on one cell, carved shapes meeting features built for rectangles, a
 * browser with no WebGL, and a long session of edits. Each case is a finding from a
 * review, and each failed on the code it was written against.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page, ms = 400) => page.waitForTimeout(ms);

/* A layout arriving by link, on a page with nothing saved behind it. Console errors
   count as failures here as they do in bins.spec.js. */
async function openAt(page, hash) {
  await H.forgetSaved(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(H.BINS_URL + (hash ? '#' + hash : ''));
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await settle(page, 300);
  return errors;
}
const absCells = (page) => page.evaluate(() => B().flatMap((b) =>
  binCells(b).map(([dx, dy]) => `${b.x + dx},${b.y + dy}`)));
const errText = (page) => page.$$eval('#warnings .w.err', (els) => els.map((e) => e.textContent));

/* ---------- #5, #11: wall and floor limits -------------------------------- */

test('a negative wall or floor is held at zero, and no wall at all still builds', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'floorT', -0.5);
  await H.setField(page, 'wall', -1);
  const b = await page.evaluate(() => ({ wall: B()[0].wall, floorT: B()[0].floorT,
                                         bad: checkManifold(geomFor(B()[0]).polys).bad }));
  expect(b.floorT, 'a negative floor reached the bin and the link').toBe(0);
  expect(b.wall).toBe(0);
  // the field says what is being used once you are out of it
  expect(await page.inputValue('#floorT')).toBe('0');
  expect(await page.inputValue('#wall')).toBe('0');
  // a wall of 0 put the cavity on the outer skin; the engine builds its thinnest instead
  expect(b.bad, 'open edges in a bin with no wall').toBe(0);
  expect((await errText(page)).join(' ')).toContain('built at 0.4 mm');
  await settle(page, 600);            // past the save debounce, which used to throw
  expect(errors).toEqual([]);
});

test('a wall typed past the cap builds at the cap, and a thick one is noted', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'wall', 100);
  const r = await page.evaluate(() => {
    const b = B()[0], gm = geomFor(b);
    return { wall: b.wall, max: +document.getElementById('wall').max, W: gm.meta.W, vol: gm.vol };
  });
  expect(r.wall).toBe(r.max);
  expect(r.W, 'a 100 mm wall built inside out, wider than the bin').toBeCloseTo(41.5, 3);
  expect(r.vol).toBeGreaterThan(0);
  await expect(page.locator('#totals')).not.toContainText('≈ -');

  /* 2.7 is where the lip used to open: 256 edges used four times. */
  await H.setField(page, 'wall', 2.7);
  expect(await page.evaluate(() => checkManifold(geomFor(B()[0]).polys).bad)).toBe(0);
  await expect(page.locator('#warnings')).not.toContainText('mm walls');
  await H.setField(page, 'wall', 3);
  await expect(page.locator('#warnings')).toContainText('thicker than the 2.7 mm');
  expect(await errText(page), 'a thick wall prints fine; it is a note, not a fault').toEqual([]);
  expect(errors).toEqual([]);
});

/* ---------- #4: limits and slow paths -------------------------------------- */

test('a drawer typed hundreds of cells wide is capped, and says so', async ({ page }) => {
  test.setTimeout(60_000);            // it used to freeze for longer than this
  const errors = await openAt(page, '');
  await H.setField(page, 'drawerW', 21000);
  await H.setField(page, 'drawerD', 21000);
  await settle(page);
  const r = await page.evaluate(() => ({ g: grid(), w: state.drawerW, d: state.drawerD }));
  // 2000 mm, the largest drawer a link carries, is 47 cells
  expect([r.g.nx, r.g.ny, r.w, r.d]).toEqual([47, 47, 2000, 2000]);
  await expect(page.locator('#warnings')).toContainText('21000 × 21000 mm drawer is bigger than the 2000 mm');

  // the cell fields reach the same cap, with the same message
  await page.goto('about:blank');
  await openAt(page, '');
  await H.setField(page, 'gridX', 500);
  await settle(page);
  expect((await page.evaluate(() => grid())).nx).toBe(47);
  await expect(page.locator('#warnings')).toContainText('bigger than the 2000 mm');
  expect(await page.inputValue('#gridX'), 'the cell field shows the grid in use').toBe('47');
  expect(errors).toEqual([]);
});

test('the stack check reads each layer once, not once per cell', async ({ page }) => {
  const errors = await openAt(page, 'w=1260&d=1260&bl=0-0-1-1-2~0-0-1-1-2~0-0-1-1-2~0-0-1-1-2~0-0-1-1-2');
  const r = await page.evaluate(() => {
    let n = 0;
    const real = occupancyOf;
    window.occupancyOf = (k) => { n++; return real(k); };
    try { stackHeight(); } finally { window.occupancyOf = real; }
    return { n, layers: layers.length, cells: grid().nx * grid().ny };
  });
  expect(r.cells).toBe(900);
  expect(r.n, `${r.n} occupancy builds for one stack check`).toBeLessThanOrEqual(r.layers);
  expect(errors).toEqual([]);
});

test('typed values are rounded and held to the limits a link is held to', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [1, 0]);
  await H.setField(page, 'divX', 2.6);
  expect(await page.evaluate(() => B()[0].divX), 'rounded, not truncated').toBe(3);
  await H.setField(page, 'divX', 500);
  await H.setField(page, 'divY', -3);
  await H.setField(page, 'u', 80);
  await H.setField(page, 'hUnits', 5000);
  const b = await page.evaluate(() => ({ divX: B()[0].divX, divY: B()[0].divY,
                                         hUnits: B()[0].hUnits, u: B()[0].u }));
  /* As many dividers as leave each compartment a 1.2 mm wall wide: 81.1 mm inside a
     2x1 makes 67 of them, less one. */
  expect(b.divX).toBe(66);
  expect(b.divY).toBe(0);
  expect(b.hUnits).toBe(285);
  expect(b.u, 'refused by the drawer, not held to 50').toBe(2);
  expect(await page.inputValue('#divX')).toBe('66');

  // the floor and the scoop go up to the bin's height, the label shelf to its depth
  await H.setField(page, 'hUnits', 3);
  await H.setField(page, 'floorT', 500);
  await H.setField(page, 'scoop', 500);
  await H.setField(page, 'label', 500);
  const f = await page.evaluate(() => ({ floorT: B()[0].floorT, scoop: B()[0].scoop, label: B()[0].label }));
  expect(f).toEqual({ floorT: 21, scoop: 21, label: 42 });
  expect(await page.inputValue('#label')).toBe('42');
  expect(errors).toEqual([]);
});

test('a floor that fills the bin leaves no loose divider plates to print', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [1, 0]);
  await H.setField(page, 'divX', 1);
  await page.locator('#divRemovable').check();
  await settle(page);
  expect(await page.evaluate(() => dividerParts().length)).toBe(1);
  await H.setField(page, 'floorT', 21);
  const r = await page.evaluate(() => ({ plates: dividerParts().map((d) => d.meta.tall),
                                         bad: checkManifold(geomFor(B()[0]).polys).bad }));
  expect(r.plates, 'a plate of negative height, inside out').toEqual([]);
  expect(r.bad).toBe(0);
  await page.locator('#openExport').click();
  await expect(page.locator('#exFiles [data-ex="stl"]')).toHaveCount(1);
  await expect(page.locator('#exFiles [data-ex="divider"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a bin designed on its own is held to the 50 cells a link carries', async ({ page }) => {
  test.setTimeout(60_000);            // 100 × 100 took 14 s an edit with no limit at all
  const errors = await openAt(page, '');
  await page.locator('#scratchBinMap').click();
  await settle(page, 250);
  await H.setField(page, 'u', 100);
  await settle(page);
  // wider than the drawer is still allowed — the Add button says why it cannot go in
  expect(await page.evaluate(() => [scratch.u, scratch.v])).toEqual([50, 1]);
  expect(await page.inputValue('#u')).toBe('50');
  await expect(page.locator('#scratchAdd')).toBeDisabled();
  expect(errors).toEqual([]);
});

/* ---------- #6: splitting a carved bin ------------------------------------ */

test('splitting a carved bin keeps each piece to its own cells', async ({ page }) => {
  const errors = await openAt(page,
    'w=400&d=100&bl=0-0-8-1-3-1.2-1.2-0-0-0-1-1-1-1-0-0-11111110_7-0-1-1-3');
  await H.clickCell(page, 0, 0);
  await expect(page.locator('#splitFit')).toHaveText(/4×1 \+ 4×1/);
  await page.locator('#splitFit').click();
  await settle(page);

  const cells = await absCells(page);
  expect(cells.slice().sort(), 'the same eight cells, each held once')
    .toEqual(['0,0', '1,0', '2,0', '3,0', '4,0', '5,0', '6,0', '7,0']);
  const bins = await H.bins(page);
  expect(bins.every((b) => b.outsideBox === 0)).toBe(true);
  expect(await errText(page)).toEqual([]);
  expect(errors).toEqual([]);
});

/* ---------- #17: overlaps and coverage ------------------------------------ */

test('two bins on one cell are flagged, and counted once', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-1-1-3_0-0-1-1-3_0-0-1-1-3');
  const errs = await errText(page);
  expect(errs.filter((t) => /shares cells/.test(t)), 'each of the three is told').toHaveLength(3);
  await expect(page.locator('#coverage')).toContainText('1/63 cells (2%)');
  await expect(page.locator('#fillmap .clash').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('a bin off the grid is flagged and coverage stops at 100%', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-30-30-3');
  expect((await errText(page)).join(' ')).toContain('outside the drawer grid');
  const pct = await page.locator('#coverage').textContent();
  expect(Number(/\((\d+)%\)/.exec(pct)[1])).toBeLessThanOrEqual(100);
  expect(errors).toEqual([]);
});

/* ---------- #18: no rectangular lid over a carved bin --------------------- */

test('a carved bin is not given a rectangular lid, and the panel says why', async ({ page }) => {
  const errors = await openAt(page, 'bl=2-0-3-2-4-1.2-1.2-0-0-0-1-1-1-1-0-0-110110-0-0-1-3');
  expect(await page.evaluate(() => lidParts().length)).toBe(0);
  await page.locator('#openExport').click();
  await expect(page.locator('#exFiles [data-ex="stl"]').first()).toBeVisible();
  await expect(page.locator('#exFiles [data-ex="lid"]')).toHaveCount(0);
  await page.locator('#exportClose').click();

  await H.clickCell(page, 2, 0);
  await expect(page.locator('#lid')).toBeChecked();
  await expect(page.locator('#lidCarved')).toBeVisible();
  await expect(page.locator('#lidHint')).toBeHidden();
  expect(errors).toEqual([]);
});

/* ---------- #27: moving a carved bin between layers ----------------------- */

test('"Move to layer" compares cells, so an L moves over a bin in its notch', async ({ page }) => {
  const errors = await openAt(page, 'bl=0-0-2-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-1110~1-1-1-1-3');
  const p = await H.cellPoint(page, 0, 0);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const item = page.locator('#ctxmenu button', { hasText: 'Move to layer 2' });
  await expect(item).toHaveText('Move to layer 2');
  await expect(item).toBeEnabled();
  await item.click();
  await settle(page);
  expect(await page.evaluate(() => [layers[0].bins.length, layers[1].bins.length])).toEqual([0, 2]);
  await expect(page.locator('#warnings')).not.toContainText('shares cells');
  expect(errors).toEqual([]);
});

/* ---------- #26: undo -------------------------------------------------------- */

test('"Already printed" and "Mark all printed" are each one Undo', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.dragCells(page, [2, 0], [2, 0]);
  await H.clickCell(page, 0, 0);
  await page.locator('#done').check();
  await settle(page, 200);
  expect(await page.evaluate(() => B()[0].done)).toBe(true);
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => !!B()[0].done), 'the first Undo did nothing').toBe(false);

  await page.locator('#markAllDone').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().every((b) => b.done))).toBe(true);
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().some((b) => b.done))).toBe(false);
  expect(await page.evaluate(() => B().length), 'and the bins are still there').toBe(2);
  expect(errors).toEqual([]);
});

test('changing a bin\'s settings is an Undo step of its own', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'hUnits', 5);
  expect(await page.evaluate(() => B()[0].hUnits)).toBe(5);
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  const after = await page.evaluate(() => B().map((b) => b.hUnits));
  expect(after, 'Undo took the bin away instead of the height').toEqual([3]);
  await page.locator('#redoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().map((b) => b.hUnits))).toEqual([5]);
  expect(errors).toEqual([]);
});

test('typing a note a letter at a time is one Undo step', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await page.locator('#note').click();
  // slower than the 180 ms redraw, so every letter reaches the bin on its own
  await page.keyboard.type('drill bits', { delay: 230 });
  await settle(page, 300);
  expect(await page.evaluate(() => B()[0].note)).toBe('drill bits');
  await page.locator('#undoBtn').click();
  await settle(page, 200);
  expect(await page.evaluate(() => B().map((b) => b.note || '')), 'the whole note, in one step')
    .toEqual(['']);
  expect(errors).toEqual([]);
});

/* ---------- #16: GPU memory --------------------------------------------------- */

test('edits do not pile up geometry on the GPU', async ({ page }) => {
  const six = [2, 3, 4, 5, 6, 7];
  const bl = six.flatMap((h, i) => [`${i}-0-1-1-${h}`, `${i}-1-1-1-${h}`]).join('_');
  const errors = await openAt(page, 'bl=' + bl);
  const geos = () => page.evaluate(() => renderer.info.memory.geometries);
  await H.clickCell(page, 0, 0);
  await settle(page);
  const base = await geos();

  // a note cannot change a mesh, and must not rebuild one
  for (let i = 0; i < 25; i++) {
    await page.evaluate((i) => {
      const n = document.getElementById('note');
      n.value = 'n' + i; n.dispatchEvent(new Event('input', { bubbles: true }));
    }, i);
    await settle(page, 230);
  }
  expect(await geos(), 'typing a note leaked a geometry per type per keystroke')
    .toBeLessThanOrEqual(base);

  // a height does, and the old shape has to be let go
  for (let i = 0; i < 10; i++) await H.setField(page, 'hUnits', 8 + (i % 2));
  expect(await geos()).toBeLessThanOrEqual(base + 1);
  await H.setField(page, 'infill', 40);
  expect(await geos()).toBeLessThanOrEqual(base + 1);
  expect(errors).toEqual([]);
});

/* ---------- #9: no WebGL ------------------------------------------------------ */

/* A browser of its own, so the rest of the file keeps its GPU. Launched from the
   project's own launch options rather than through test.use, which would replace them —
   and with them the browser a local config points at. */
test('without WebGL the map, the table, the export and saving all still work',
  async ({ playwright, browserName, launchOptions }) => {
    const browser = await playwright[browserName].launch(Object.assign({}, launchOptions,
      { args: [...((launchOptions && launchOptions.args) || []), '--disable-3d-apis'] }));
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(H.BINS_URL + '#bl=0-0-1-1-3');
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);

      expect(errors, 'the WebGL failure stopped the boot').toEqual([]);
      expect(await page.evaluate(() => renderer)).toBeNull();
      await expect(page.locator('#threeempty')).toContainText('3D preview unavailable');
      await expect(page.locator('#fillmap rect.bin')).toHaveCount(1);
      await expect(page.locator('#typeRows')).toContainText('1×1×3');

      await H.dragCells(page, [2, 2], [3, 3]);
      expect(await page.evaluate(() => B().length)).toBe(2);
      await page.locator('#openExport').click();
      await expect(page.locator('#exFiles [data-ex="stl"]')).toHaveCount(2);
      const dl = page.waitForEvent('download');
      await page.locator('#exFiles [data-ex="stl"]').first().click();
      expect((await dl).suggestedFilename()).toMatch(/\.stl$/);
      await page.locator('#exportClose').click();

      // saved, so a visit with no link brings it back — and Start fresh clears it
      await settle(page, 900);
      await page.goto(H.BINS_URL);
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);
      expect(await page.evaluate(() => B().length)).toBe(2);
      await page.locator('#startFresh').click();
      await page.waitForFunction(() => !!document.getElementById('fillmap') && !location.hash);
      await settle(page);
      expect(await page.evaluate(() => B().length)).toBe(0);

      /* The boot's last steps open a link focused on a bin, or on a loose one; both
         frame the preview. They have to run to the end too, or a link that names a
         focus would be one the page never finishes opening. */
      await page.goto('about:blank');
      await page.goto(H.BINS_URL + '#bl=0-0-1-1-3&bf=0.0');
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);
      expect(await page.evaluate(() => focused && selected === 0)).toBe(true);
      await page.goto('about:blank');
      await page.goto(H.BINS_URL + '#bs=0-0-2-1-3');
      await page.waitForFunction(() => !!document.getElementById('fillmap'));
      await settle(page);
      expect(await page.evaluate(() => scratch && [scratch.u, scratch.v])).toEqual([2, 1]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

/* ---------- #30: the small ones ----------------------------------------------- */

test('a note is cut by character, never through an emoji', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'note', 'a'.repeat(27) + '😀b');
  const note = await page.evaluate(() => B()[0].note);
  expect([...note]).toHaveLength(28);
  expect(note.endsWith('😀'), 'cut through the surrogate pair').toBe(true);
  expect(errors).toEqual([]);
});

test('a lid with no skirt is listed as the flat plate it is', async ({ page }) => {
  const errors = await openAt(page, '');
  await H.dragCells(page, [0, 0], [0, 0]);
  await page.locator('#lid').check();
  for (const s of ['lidF', 'lidB', 'lidL', 'lidR']) await page.locator('#' + s).uncheck();
  await settle(page);
  await page.locator('#openExport').click();
  await expect(page.locator('#exFiles [data-ex="lid"]')).toHaveCount(1);
  const text = await page.locator('#exFiles').textContent();
  expect(text).not.toContain('( sides)');
  expect(text).toContain('Lid 1×1, flat — no skirt');
  expect(text).toContain('1.2 mm thick');
  expect(text).not.toContain('4.2 mm tall');
  expect(errors).toEqual([]);
});
