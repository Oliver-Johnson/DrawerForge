/* A bin's height, typed the way the person knows it.
 *
 * It was 7 mm units or nothing, and someone sizing a bin for a part knows the part in
 * millimetres — so they divided by seven, and had to guess whether the floor counted.
 * The height can now be typed as units, as millimetres overall, or as the depth wanted
 * inside. What is stored is still whole units, so the link and saved drawers are the same
 * bytes whichever way it was typed; these hold that, the two rounding rules, the line
 * that says what the typing came to, and that the figures in it are the engine's own.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

test.afterEach(async ({ page }) => {
  expect(page.__errors || [], 'the page threw while being driven').toEqual([]);
});

/* One 2×2 bin placed and selected, with the panel that holds its height open. */
async function oneBin(page) {
  page.__errors = await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await expect(page.locator('#hMode')).toBeVisible();
}
const units = (page) => page.evaluate(() => B()[0].hUnits);
const result = (page) => page.locator('#hResult').textContent();
/* Typed as a person types: into the focused field, then Tab away. setField writes the
   value without focus, which skips the very case that matters — the field is left alone
   under the caret and only put right once you leave it. */
async function typeHeight(page, value) {
  await page.locator('#hMm').fill(String(value));
  await page.waitForTimeout(300);
}
const leave = async (page) => { await page.locator('#hMm').press('Tab'); await page.waitForTimeout(300); };

test('units stay the default, and the line beside the field says what they come to', async ({ page }) => {
  await oneBin(page);
  await expect(page.locator('#hMode')).toHaveValue('units');
  await expect(page.locator('#hUnits')).toBeVisible();
  await expect(page.locator('#hMm')).toBeHidden();
  /* 3 units: 21 mm to the top of the walls, a 3.95 mm lip above, and inside, 21 less the
     4.75 mm foot, the 1.2 mm floor and the 0.05 mm the slab runs past it: 15 mm. */
  expect(await result(page)).toBe('3 units · 21 mm overall + 3.95 mm lip · 15 mm inside');
  await H.setField(page, 'hUnits', 6);
  expect(await result(page)).toBe('6 units · 42 mm overall + 3.95 mm lip · 36 mm inside');
});

test('overall millimetres round to the nearest unit', async ({ page }) => {
  await oneBin(page);
  await page.selectOption('#hMode', 'overall');
  await expect(page.locator('#hUnits')).toBeHidden();
  await expect(page.locator('#hMm')).toBeVisible();
  await expect(page.locator('#hMmLabel')).toHaveText('Height overall (mm)');
  // the field opens on the bin's own height, in the unit it now takes
  await expect(page.locator('#hMm')).toHaveValue('21');

  await typeHeight(page, 45);             // 6.43 units
  expect(await units(page)).toBe(6);
  // under the caret it stays as typed; the line says what it came to
  await expect(page.locator('#hMm')).toHaveValue('45');
  expect(await result(page)).toMatch(/^6 units · 42 mm overall/);
  await leave(page);
  // and once you leave it, it shows the height that will be built
  await expect(page.locator('#hMm')).toHaveValue('42');

  await typeHeight(page, 46);             // 6.57 units
  expect(await units(page)).toBe(7);
  await typeHeight(page, 3);              // less than one unit is still one unit
  expect(await units(page)).toBe(1);
  await typeHeight(page, 99999);          // and no more than the field's own limit
  expect(await units(page)).toBe(285);
});

test('inside depth rounds up, so the part fits', async ({ page }) => {
  await oneBin(page);
  await page.selectOption('#hMode', 'inside');
  await expect(page.locator('#hMmLabel')).toHaveText('Inside depth (mm)');
  await expect(page.locator('#hMm')).toHaveValue('15');

  await typeHeight(page, 36);             // exactly 6 units' worth on a 1.2 mm floor
  expect(await units(page)).toBe(6);
  /* A hundredth more needs the next unit. 36.01 to 36.05 used to be quoted as 6 units,
     measured from floorZ rather than from the top of the slab a BLOAT above it, and
     came out 0.05 mm shallower than was typed. */
  await typeHeight(page, 36.01);
  expect(await units(page)).toBe(7);
  await typeHeight(page, 36.05);
  expect(await units(page)).toBe(7);
  await typeHeight(page, 30);             // 6 units gives 36 — the smallest that holds 30
  expect(await units(page)).toBe(6);
  expect(await result(page)).toBe('6 units · 42 mm overall + 3.95 mm lip · 36 mm inside');
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('36');

  /* The floor is part of the sum. A 3 mm floor takes 1.8 mm more of the inside, so the
     depth that was 6 units on the default floor is 7 on this one. */
  await H.setField(page, 'floorT', 3);
  await expect(page.locator('#hMm')).toHaveValue('34.2');
  await typeHeight(page, 36);
  expect(await units(page)).toBe(7);
});

/* Enter commits a number field: change fires there and then, under the caret, where the
   field is left as typed. Leaving it afterwards fired nothing at all, so "40" stayed in
   the box over a bin 43 deep inside until something else redrew the panel. */
test('Enter, then Tab, still shows the height that will be built', async ({ page }) => {
  await oneBin(page);
  await page.selectOption('#hMode', 'inside');
  await typeHeight(page, 40);
  await page.locator('#hMm').press('Enter');
  await page.waitForTimeout(300);
  expect(await units(page)).toBe(7);
  await expect(page.locator('#hMm')).toHaveValue('40');      // still under the caret
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('43');
  // and coming back to it and leaving again changes nothing
  await page.locator('#hMm').focus();
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('43');
  expect(await units(page)).toBe(7);
});

/* Not a hand-kept constant: the floor, the lip and the stacking height quoted beside the
   field are the ones buildBin builds, for a plain bin, a thick floor, a lowered wall
   (no lip), a solid block (nothing inside) and a floor thin enough to meet its clamp.
   The floor is found in the mesh itself, not in buildBin's meta: it is the first face
   above the feet that looks straight up, which in a bin with its walls standing is the
   top of the slab — the surface a part stands on. */
test('the heights it quotes are the ones the engine builds', async ({ page }) => {
  page.__errors = await H.openBins(page);
  const rows = await page.evaluate(() => [
    { hUnits: 6 }, { hUnits: 4, floorT: 3 }, { hUnits: 5, edges: { f: 0.5 } },
    { hUnits: 2, solid: true }, { hUnits: 1, floorT: 0.02 }, { hUnits: 3, floorT: 1.25 },
  ].map((c) => {
    const q = binHeights(c), built = buildBin(G, Object.assign({ u: 1, v: 1 }, c)), m = built.meta;
    const flatUp = built.polys.filter((p) => p.plane.n[2] > 0.999 &&
      p.verts.every((v) => Math.abs(v[2] - p.verts[0][2]) < 1e-9)).map((p) => p.verts[0][2]);
    const slab = Math.min(...flatUp.filter((z) => z > SPEC.footH + 0.06));
    return { c, q, m: { H: m.H, floorZ: m.floorZ, lipH: m.lipH, slab } };
  }));
  for (const { c, q, m } of rows) {
    expect(q.H).toBe(m.H);
    expect(q.floorZ).toBe(m.floorZ);
    expect(q.lipH).toBe(m.lipH);
    if (c.solid) { expect(q.inside).toBe(0); continue; }
    expect(q.inside, JSON.stringify(c)).toBeCloseTo(m.H - m.slab, 9);
  }
  /* And the inverse agrees with it: the units it picks hold the depth, one fewer does
     not — with the walls standing, and lowered, where each unit adds only a share of its
     7 mm to the inside. A bin with no inside at any height is given no units at all. */
  const ok = await page.evaluate(() => {
    for (const edges of [null, { f: 0.5 }, { f: 0.5, b: 0.5, l: 0.5, r: 0.5 }, { f: 0.25, b: 0, l: 0, r: 0 }])
      for (const floorT of [0.6, 1.2, 2, 3.5])
        for (let d = 0.5; d < 120; d += 0.37) {
          const cfg = { floorT, edges }, n = unitsForInside(d, cfg);
          const at = (k) => binHeights(Object.assign({ hUnits: k }, cfg)).inside;
          if (at(n) < d - 1e-9) return `${d} on ${JSON.stringify(cfg)}: ${n} too shallow`;
          if (n > 1 && at(n - 1) >= d) return `${d} on ${JSON.stringify(cfg)}: ${n} not the fewest`;
        }
    if (unitsForInside(5, { solid: true }) !== 0) return 'a solid block was given units for a depth';
    if (unitsForInside(5, { edges: { f: 0, b: 0, l: 0, r: 0 } }) !== 0) return 'an open tray was given units for a depth';
    return 'ok';
  });
  expect(ok).toBe('ok');
});

/* How tall a bin stands is buildBin's own figure — the one its README and plate files
   give — worked out in one function both of them call, so the quote cannot drift from
   it. Against the mesh too: a tray open on every side is its slab, 6 mm at any height,
   and a part-height wall stands within BLOAT of the figure. (buildBin takes the share
   from the top of the slab while the wall ring runs from floorZ, which leaves a
   half-height wall 0.025 mm under it.) */
test('a lowered bin is quoted as tall as the engine builds it', async ({ page }) => {
  page.__errors = await H.openBins(page);
  const rows = await page.evaluate(() => {
    const half = { f: 0.5, b: 0.5, l: 0.5, r: 0.5 }, open = { f: 0, b: 0, l: 0, r: 0 };
    return [
      { hUnits: 6 }, { hUnits: 6, edges: open }, { hUnits: 6, edges: half }, { hUnits: 2, edges: open },
      { hUnits: 4, edges: { f: 0, b: 0.25, l: 0.66, r: 0.5 } }, { hUnits: 3, floorT: 3, edges: half },
    ].map((c) => {
      const q = binHeights(c), built = buildBin(G, Object.assign({ u: 2, v: 1 }, c)), m = built.meta;
      let zmax = -Infinity;
      for (const p of built.polys) for (const v of p.verts) zmax = Math.max(zmax, v[2]);
      return { c, q, top: m.totalH - m.lipH, zmax: zmax - m.lipH };
    });
  });
  for (const { c, q, top, zmax } of rows) {
    expect(q.top, JSON.stringify(c)).toBe(top);
    expect(zmax, JSON.stringify(c)).toBeCloseTo(q.top, 1);
  }
  expect(rows[0].q.top).toBe(42);
  expect(rows[1].q.top).toBeCloseTo(6, 9);       // the tray: the slab, and nothing inside
  expect(rows[1].q.inside).toBe(0);
  expect(rows[2].q.top).toBeCloseTo(24, 9);      // 6 to the slab, then half of the 36 above it
  expect(rows[2].q.inside).toBeCloseTo(18, 9);
});

/* A lowered wall stops short of H, and with every wall open the bin is its slab and
   nothing more. Quoted at full height, the Tray preset at 6 units read "42 mm overall"
   for a part that stands 6 mm, and four half walls the same for one that stands 24. */
test('a tray, or walls lowered all round, is quoted at the height it is built', async ({ page }) => {
  await oneBin(page);
  await H.setField(page, 'hUnits', 6);
  for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR']) await page.selectOption(`#${id}`, '0.5');
  await page.waitForTimeout(300);
  // 6 mm of foot and floor, half of the 36 above it, and no lip over a lowered wall
  expect(await result(page)).toBe('6 units · 24 mm tall · 18 mm inside');

  // the field says the same, and typing runs the same sum backwards
  await page.selectOption('#hMode', 'overall');
  await expect(page.locator('#hMm')).toHaveValue('24');
  await typeHeight(page, 31);             // 7 units stand 27.5, 8 stand 31
  expect(await units(page)).toBe(8);
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('31');
  await page.selectOption('#hMode', 'inside');
  await expect(page.locator('#hMm')).toHaveValue('25');
  await typeHeight(page, 18);             // the fewest units that hold 18 at half height
  expect(await units(page)).toBe(6);
  await typeHeight(page, 18.01);
  expect(await units(page)).toBe(7);
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('21.5');

  // the preset opens every wall, and a tray is its slab: 6 mm, whatever its units
  await page.locator('#presetTray').click();
  await page.waitForTimeout(300);
  expect(await result(page)).toBe('7 units · 6 mm tall · open on every side');
});

/* A solid block has no inside at any height, and nor has a tray open on every side. The
   field showed 0 for one, and a depth typed into it was worked out as if the bin were
   hollow. With inside depth chosen, either takes its height overall instead, and the
   label says so. */
test('a bin with no inside takes its height overall, even with inside depth chosen', async ({ page }) => {
  await oneBin(page);
  await page.selectOption('#hMode', 'inside');
  await page.locator('#solid').check();
  await page.waitForTimeout(300);
  await expect(page.locator('#hMmLabel')).toHaveText('Height overall (mm)');
  await expect(page.locator('#hMm')).toHaveValue('21');
  await typeHeight(page, 45);             // to the nearest unit, not the 8 a 45 mm cavity would take
  expect(await units(page)).toBe(6);
  expect(await result(page)).toBe('6 units · 42 mm overall · solid, nothing inside');
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('42');

  await page.locator('#solid').uncheck();
  await page.waitForTimeout(300);
  await page.locator('#presetTray').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#hMmLabel')).toHaveText('Height overall (mm)');
  await expect(page.locator('#hMm')).toHaveValue('6');
  /* A tray stands 6 mm at any height, but its units still say how much room it keeps in
     a stack, so a height typed for it still sets them, to the nearest unit. */
  await typeHeight(page, 30);
  expect(await units(page)).toBe(4);
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('6');

  // one wall back up, and there is an inside to type again
  await page.selectOption('#edgeF', '1');
  await page.waitForTimeout(300);
  await expect(page.locator('#hMmLabel')).toHaveText('Inside depth (mm)');
  await expect(page.locator('#hMm')).toHaveValue('22');
});

test('a bin with a lowered wall has no lip to quote, and a solid one no inside', async ({ page }) => {
  await oneBin(page);
  await page.selectOption('#edgeF', '0.5');
  await page.waitForTimeout(300);
  expect(await result(page)).toBe('3 units · 21 mm overall · 15 mm inside');
  await page.selectOption('#edgeF', '1');
  await page.locator('#solid').check();
  await page.waitForTimeout(300);
  expect(await result(page)).toBe('3 units · 21 mm overall · solid, nothing inside');
});

/* Units are what is stored, so units are what travels. A bin made 6 units tall by typing
   45 mm overall is the same link, byte for byte, as one made by typing 6. */
test('the link is the same whichever way the height was typed', async ({ page }) => {
  await oneBin(page);
  await H.setField(page, 'hUnits', 6);
  await page.waitForTimeout(500);
  const byUnits = await page.evaluate(() => designLink());

  await H.setField(page, 'hUnits', 3);
  await page.selectOption('#hMode', 'overall');
  await typeHeight(page, 45);
  await leave(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => designLink())).toBe(byUnits);

  await page.selectOption('#hMode', 'inside');
  await H.setField(page, 'hUnits', 3);
  await typeHeight(page, 33);
  await leave(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => designLink())).toBe(byUnits);
  // the choice of menu is not in it either
  expect(byUnits).not.toMatch(/inside|overall/);
});

test('the way you type the height is remembered on this device', async ({ page }) => {
  await oneBin(page);
  await page.selectOption('#hMode', 'inside');
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(300);
  await expect(page.locator('#hMode')).toHaveValue('inside');
  expect(await page.evaluate(() => localStorage.getItem('drawerforge:height-entry:v1'))).toBe('inside');

  // a stored value this page does not know is units, not a broken field
  await page.evaluate(() => localStorage.setItem('drawerforge:height-entry:v1', 'furlongs'));
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(300);
  await expect(page.locator('#hMode')).toHaveValue('units');
});

/* The millimetre entry is a length like the drawer's, so with inches on it takes inches.
   1.75 in is 44.45 mm, which is 6.35 units and rounds to 6. */
test('with inches on, the length is typed in inches', async ({ page }) => {
  await oneBin(page);
  await page.evaluate(() => document.getElementById('unitIn').click());
  await page.waitForTimeout(300);
  await page.selectOption('#hMode', 'overall');
  await expect(page.locator('#hMmLabel')).toHaveText('Height overall (in)');
  await expect(page.locator('#hMm')).toHaveValue('0.83');      // 21 mm
  await typeHeight(page, 1.75);
  expect(await units(page)).toBe(6);
  expect(await result(page)).toContain('42 mm / 1.65 in overall');
  await leave(page);
  await expect(page.locator('#hMm')).toHaveValue('1.65');

  // back to millimetres, the field says the same height in millimetres
  await page.evaluate(() => document.getElementById('unitMm').click());
  await page.waitForTimeout(300);
  await expect(page.locator('#hMmLabel')).toHaveText('Height overall (mm)');
  await expect(page.locator('#hMm')).toHaveValue('42');
});

/* The drawer-height check always worked in millimetres. It now says the unit count that
   fits, which is the number the field takes. 60 mm usable less a 4.25 mm baseplate is
   55.75; with a 3.95 mm lip that is 7 units (49 mm), and 8 would be 59.95. */
test('the drawer-height check names the tallest unit count that fits', async ({ page }) => {
  await oneBin(page);
  await H.setField(page, 'drawerH', 60);
  await H.setField(page, 'hUnits', 9);
  const checks = page.locator('#warnings');
  await expect(checks).toContainText('7 units is the tallest that fits here');
  await expect(checks).toContainText('The tallest that fits is 7 units (49 mm + lip), in one bin or a stack.');

  // and the count it names is one the check then passes
  await H.setField(page, 'hUnits', 7);
  await expect(page.locator('#warnings .w.err')).toHaveCount(0);
  await expect(checks).toContainText('The tallest that fits is 7 units');
  await H.setField(page, 'hUnits', 8);
  await expect(page.locator('#warnings .w.err')).not.toHaveCount(0);
});

test('on a second layer it names what fits on the bins underneath', async ({ page }) => {
  await oneBin(page);
  await H.setField(page, 'drawerH', 60);
  await H.setField(page, 'hUnits', 4);       // 28 mm on the baseplate
  // a layer on top, and a bin on it over the first
  await page.locator('#addLayer').click();
  await page.waitForTimeout(200);
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.setField(page, 'hUnits', 5);       // 28 + 35 + 3.95 is past 55.75
  // 55.75 - 28 leaves 27.75: 3 units and a lip
  await expect(page.locator('#warnings')).toContainText('3 units is the tallest that fits on the bins under it');
});

/* The summary above the map and Checks both name the tallest bin that fits. The summary
   made the sum without Checks' allowance for rounding, and 69.1 mm less a 2.15 mm plate
   came to 8.999… units in it, so it said 8 where Checks said 9. */
test('the grid summary and Checks name the same tallest bin', async ({ page }) => {
  await oneBin(page);
  await H.setField(page, 'drawerH', 69.1);
  await H.setField(page, 'plateH', 2.15);
  await expect(page.locator('#warnings')).toContainText('The tallest that fits is 9 units');
  await expect(page.locator('#gridSummary')).toContainText('tallest single bin 9 units');
});

/* The field shows the height to the hundredth, and a step of 0.5 made most of those
   figures ones the browser calls invalid — 14.95 on a 1.25 mm floor — and had the arrow
   keys snap them to the next half instead of stepping from them. */
test('a height the field shows is one it accepts, and the arrows step from it', async ({ page }) => {
  await oneBin(page);
  await H.setField(page, 'floorT', 1.25);
  await page.selectOption('#hMode', 'inside');
  await expect(page.locator('#hMm')).toHaveValue('14.95');
  expect(await page.evaluate(() => document.getElementById('hMm').validity.valid)).toBe(true);
  await page.locator('#hMm').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#hMm')).toHaveValue('15.95');
});

/* The line under the field is a live region: a screen reader reads it out whenever it
   changes. It was rewritten on every redraw, so typing a note or a wall thickness
   announced again a height nobody had touched. */
test('the height line is only rewritten when what it says changes', async ({ page }) => {
  await oneBin(page);
  await page.evaluate(() => {
    window.__said = 0;
    new MutationObserver((m) => { window.__said += m.length; })
      .observe(document.getElementById('hResult'), { childList: true, characterData: true, subtree: true });
  });
  await H.setField(page, 'note', 'M3 screws');
  await H.setField(page, 'wall', 1.6);
  expect(await page.evaluate(() => window.__said)).toBe(0);
  await H.setField(page, 'hUnits', 4);
  expect(await page.evaluate(() => window.__said)).toBeGreaterThan(0);
});
