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
  // and the inverse agrees with it: the units it picks hold the depth, one fewer does not
  const ok = await page.evaluate(() => {
    for (const floorT of [0.6, 1.2, 2, 3.5])
      for (let d = 0.5; d < 120; d += 0.37) {
        const n = unitsForInside(d, { floorT });
        if (binHeights({ hUnits: n, floorT }).inside < d - 1e-9) return `${d} on ${floorT}: ${n} too shallow`;
        if (n > 1 && binHeights({ hUnits: n - 1, floorT }).inside >= d) return `${d} on ${floorT}: ${n} not the fewest`;
      }
    return 'ok';
  });
  expect(ok).toBe('ok');
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
