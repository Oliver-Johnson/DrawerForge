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
                 rx: +c.rotation.x.toFixed(3), rz: +c.rotation.z.toFixed(3) })));

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
  expect(Math.abs(p[0].rz), 'turned over, so the skirt points down at the lip it seats in')
    .toBeCloseTo(Math.PI, 2);
  const binTop = await page.evaluate(() => scratch.hUnits * SPEC.unitH + LIP_H);
  expect(p[0].y, 'floating clear above the rim, not buried in it').toBeGreaterThan(binTop);
  expect(errors).toEqual([]);
});

/* Turning the lid over has to reverse one horizontal axis, and which one decides whether
   the preview tells the truth about the sides you ticked. Front is +z (syncDrawer), so a
   Front-only skirt must hang over the front of the bin. Flipping about x instead put it
   over the back: a perfectly plausible picture of the wrong lid, which is the exact
   mistake the preview exists to catch. */
test('a Front-only lid has its skirt over the front of the bin', async ({ page }) => {
  const errors = await openBins(page);
  await start(page);
  await page.locator('#lid').check();
  for (const id of ['#lidB', '#lidL', '#lidR']) await page.locator(id).uncheck();
  await page.waitForTimeout(400);

  const skirt = await page.evaluate(() => {
    const m = group.children.find((c) => c.material === partMat);
    const [d] = lidParts();
    m.updateMatrix();
    const pos = m.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrix);
      // below the plate, i.e. the skirt rather than the plate it hangs from
      if (v.y > m.position.y - d.meta.t - 0.01) continue;
      lo = Math.min(lo, v.z); hi = Math.max(hi, v.z);
    }
    return { sides: d.meta.sides, lo, hi };
  });
  expect(skirt.sides).toEqual(['f']);
  expect(skirt.lo, 'the skirt is on the front half of the bin, not the back')
    .toBeGreaterThan(0);
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

  /* A leak would show as a part that is no longer where its builder put it: dividers are
     built centred on the origin, lids plate-down from z = 0. Measuring a dimension here
     instead could never fail, because no translation changes a span. */
  const box = await page.evaluate(() => {
    const bb = (polys) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const t of G.polysToTriangles(polys))
        for (const v of t)
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
      return { lo, hi };
    };
    return {
      div: dividerParts().map((d) => bb(B_DIV(d.b, d.axis).polys)),
      lid: lidParts().map((d) => Object.assign(bb(L_LID(d.b).polys), { h: d.meta.totalH })),
    };
  });
  expect(box.div.length).toBe(1);
  expect(box.lid.length).toBe(1);
  for (const d of box.div) {
    expect((d.lo[0] + d.hi[0]) / 2, 'divider still centred in x').toBeCloseTo(0, 3);
    expect((d.lo[1] + d.hi[1]) / 2, 'divider still centred in y').toBeCloseTo(0, 3);
    expect(d.lo[2], 'divider still on the bed').toBeCloseTo(0, 3);
  }
  for (const d of box.lid) {
    expect((d.lo[0] + d.hi[0]) / 2, 'lid still centred in x').toBeCloseTo(0, 3);
    expect((d.lo[1] + d.hi[1]) / 2, 'lid still centred in y').toBeCloseTo(0, 3);
    expect(d.lo[2], 'lid plate still on the bed').toBeCloseTo(0, 2);
    expect(d.hi[2], 'and still in print orientation').toBeCloseTo(d.h, 2);
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
