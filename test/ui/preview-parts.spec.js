/* The pieces that come off the printer alongside the bin, drawn where you can see them.
 *
 * A divider and a lid are separate prints. Until now the preview showed the bin body and
 * nothing else, so the first look at either was in the slicer or off the bed — late to
 * find out a divider is not the height you pictured, or that the lid you ticked could
 * never attach. These cases pin what is drawn, and the two things about it that are easy
 * to get wrong: the lid's orientation, and the offsets leaking into what you download.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { openBins, setField, dragCells } = require('./helpers');

const start = async (page) => {
  await page.locator('#scratchBinMap').click();
  await page.waitForTimeout(250);
};
/* Meshes drawn with the parts material, which is what separates a loose piece from the
   bin it belongs to. Reading the scene rather than a screenshot: the question is where
   the geometry went, and a pixel diff would answer it far less precisely. */
const parts = (page) => page.evaluate(() => group.children
  .filter((c) => c.material === partMat)
  .map((c) => ({ y: +c.position.y.toFixed(2), z: +c.position.z.toFixed(2),
                 rx: +c.rotation.x.toFixed(3) })));

test('removable dividers are drawn as loose pieces beside the bin', async ({ page }) => {
  const errors = await openBins(page);
  await start(page);
  await setField(page, 'u', 2);
  await setField(page, 'divX', 2);
  await page.locator('#divRemovable').check();
  await page.waitForTimeout(400);

  const p = await parts(page);
  expect(p, 'one loose piece per divider the bin asks for').toHaveLength(2);
  for (const d of p) {
    expect(d.y, 'laid flat, the way dividerPart builds them and the way they print').toBe(0);
    expect(d.rx, 'no rotation wanted — they are built lying down already').toBe(0);
  }
  expect(p[0].z, 'clear of the bin').toBeGreaterThan(0);
  expect(p[1].z, 'and spread out rather than stacked on each other')
    .toBeGreaterThan(p[0].z);
  expect(errors).toEqual([]);
});

test('the lid floats above the bin, turned over the way it seats', async ({ page }) => {
  const errors = await openBins(page);
  await start(page);
  await setField(page, 'hUnits', 3);
  await page.locator('#lid').check();
  await page.waitForTimeout(400);

  const p = await parts(page);
  expect(p, 'the lid, and nothing else — no dividers were asked for').toHaveLength(1);
  /* lidPart is built in print orientation, plate first and skirt descending as z grows.
     Drawn that way the skirt would point at the sky and answer the wrong question. */
  expect(Math.abs(p[0].rx), 'turned over, so the skirt points down at the lip it seats in')
    .toBeCloseTo(Math.PI, 2);
  const binTop = await page.evaluate(() => scratch.hUnits * SPEC.unitH + LIP_H);
  expect(p[0].y, 'floating clear above the rim, not buried in it').toBeGreaterThan(binTop);
  expect(errors).toEqual([]);
});

/* Lowering any wall drops the stacking lip from all four, and a lid has nothing to grip.
   lidParts already refuses that case; drawing it anyway would show a part the download
   does not contain, which is worse than showing nothing. */
test('a lid that could not attach is not drawn', async ({ page }) => {
  await openBins(page);
  await start(page);
  await page.locator('#lid').check();
  await page.waitForTimeout(300);
  expect(await parts(page), 'with the lip intact it is drawn').toHaveLength(1);

  await page.locator('#edgeF').selectOption({ index: 2 });   // lower the front wall
  await page.waitForTimeout(400);
  expect(await parts(page), 'lip gone, so there is no lid to draw').toHaveLength(0);
});

/* The offsets exist to separate the pieces on screen. The plan and the export ask
   dividerParts()/lidParts() for their own coordinates and must never see them. */
test('the exploded offsets do not reach the print plan', async ({ page }) => {
  await openBins(page);
  await start(page);
  await setField(page, 'u', 2);
  await setField(page, 'divX', 2);
  await page.locator('#divRemovable').check();
  await page.locator('#lid').check();
  await page.waitForTimeout(400);
  expect((await parts(page)).length, 'the pieces really are on screen').toBeGreaterThan(0);

  const meta = await page.evaluate(() => ({
    div: dividerParts().map((d) => ({ span: d.meta.span, tall: d.meta.tall, qty: d.qty })),
    lid: lidParts().map((d) => ({ w: d.meta.W, d: d.meta.D, qty: d.qty })),
  }));
  expect(meta.div.length).toBe(1);
  expect(meta.lid.length).toBe(1);
  for (const d of meta.div) {
    expect(d.span, 'a real span, not one displaced by PART_GAP').toBeGreaterThan(0);
    expect(d.tall).toBeGreaterThan(0);
  }
});

/* addLooseParts runs in the focus branch only. The drawer view draws many bins, and a
   fan of every divider and lid across all of them is not a sanity check, it is a mess. */
test('the drawer view is left alone', async ({ page }) => {
  await openBins(page);
  /* A bin in the drawer, asking for both parts. #divRemovable itself lives in a row the
     page keeps hidden until a divider exists, so the settings go on the bin directly --
     the assertion is about where addLooseParts runs, not about how the row is revealed. */
  await dragCells(page, [0, 0], [1, 0]);
  await page.evaluate(() => {
    const b = layers[cur].bins[0];
    b.divX = 2; b.divRemovable = true; b.lid = true;
    geoCache.clear(); partGeoCache.clear(); drawMap(); refresh(); showScene();
  });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => dividerParts().length + lidParts().length),
    'the bin really does ask for loose parts').toBeGreaterThan(0);
  expect(await parts(page), 'but the drawer view draws none of them').toHaveLength(0);
});
