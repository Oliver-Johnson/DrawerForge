/* Is the whole drawer in the preview?
 *
 * Neither preview asked. Bins stood its camera 600 mm away whatever the drawer and
 * whatever the canvas, so at 1366 × 768 — where the preview is a tall narrow column
 * beside the map — the default drawer showed as one corner, at 1920 it ran off two
 * edges, and a 600 × 500 drawer was cropped. Baseplates scaled its distance by the
 * drawer but not by the canvas, and re-framed after every build, so changing any
 * setting threw away a zoom.
 *
 * "In view" is a claim about pixels, so these project the corners of what is actually
 * drawn — the meshes' own bounding box, read out of the scene — through the page's own
 * camera, and check each lands on the canvas. They do not ask the framing code what it
 * thinks it did; that is the code under test.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

/* The tip jar is fixed to the bottom right and turns up on the first scroll, which is
   exactly where a wheel or a click aimed at the preview can land. */
async function quiet(page) {
  await page.addInitScript(() => { try { localStorage.setItem('df-kofi', 'off'); } catch (e) {} });
  await H.forgetSaved(page);
}

/* Normalised device coordinates of the eight corners of everything drawn: -1..1 on
   both axes is the canvas. Bins draws on demand, so render() first; baseplates draws
   every animation frame, so wait for two of them to be sure the camera has caught up. */
async function corners(page, tool) {
  if (tool === 'plates')
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate((tool) => {
    let box;
    if (tool === 'bins') {
      render();
      box = new THREE.Box3().setFromObject(group).union(new THREE.Box3().setFromObject(drawerGroup));
    } else {
      box = new THREE.Box3().setFromObject(root);
    }
    if (box.isEmpty()) return null;
    const out = [];
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x,
                                  i & 2 ? box.max.y : box.min.y,
                                  i & 4 ? box.max.z : box.min.z).project(camera);
      out.push([v.x, v.y, v.z]);
    }
    return out;
  }, tool);
}

/* All of it on the canvas, and not as a speck in the middle — a camera parked a mile
   away passes the first half of that on its own. */
function expectFramed(pts, what) {
  expect(pts, `${what}: nothing drawn to frame`).not.toBeNull();
  for (const [x, y, z] of pts) {
    expect(Math.abs(x), `${what}: a corner is off the side of the canvas`).toBeLessThanOrEqual(1);
    expect(Math.abs(y), `${what}: a corner is off the top or bottom of the canvas`).toBeLessThanOrEqual(1);
    expect(z, `${what}: a corner is behind the camera or past the far plane`).toBeLessThan(1);
  }
  const reach = Math.max(...pts.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
  expect(reach, `${what}: in view, but too small to see`).toBeGreaterThan(0.75);
}
const offCanvas = (pts) => pts.some(([x, y]) => Math.abs(x) > 1 || Math.abs(y) > 1);

/* A point over the canvas that is also inside the viewport. At 1366 × 768 the bins
   canvas is taller than the window, so its middle can be below the fold — and a wheel
   event there goes to whatever the window has instead. */
async function overCanvas(page) {
  await page.locator('#three').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const r = document.getElementById('three').getBoundingClientRect();
    const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
    return { x: r.left + r.width * 0.4, y: (top + bottom) / 2 };
  });
}
async function wheelIn(page, ticks) {
  const p = await overCanvas(page);
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < ticks; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(30); }
  await page.waitForTimeout(150);
}
async function fit(page) {
  await page.locator('.fitbtn').click();
  await page.waitForTimeout(150);
}

async function openBinsFilled(page) {
  await quiet(page);
  const errors = await H.openBins(page);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(800);
  return errors;
}
async function openPlates(page) {
  await quiet(page);
  return H.openPlates(page);
}
const platesReady = (page) => page.waitForFunction(() => {
  const t = document.getElementById('pieceTail');
  return t && /ready/.test(t.textContent);
}, null, { timeout: 30000 });

for (const [w, h] of [[1366, 768], [1920, 1080]]) {
  test.describe(`at ${w} × ${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('bins: the default drawer is all in view, and Fit brings it back after a zoom',
      async ({ page }) => {
        const errors = await openBinsFilled(page);
        expectFramed(await corners(page, 'bins'), 'on load');

        await wheelIn(page, 12);
        expect(offCanvas(await corners(page, 'bins')),
          'fixture: the zoom must really have pushed part of the drawer out of view').toBe(true);
        await fit(page);
        expectFramed(await corners(page, 'bins'), 'after Fit');
        expect(errors).toEqual([]);
      });

    test('baseplates: the default plate is all in view, and Fit brings it back after a zoom',
      async ({ page }) => {
        const errors = await openPlates(page);
        expectFramed(await corners(page, 'plates'), 'on load');

        await wheelIn(page, 5);
        expect(offCanvas(await corners(page, 'plates')),
          'fixture: the zoom must really have pushed part of the plate out of view').toBe(true);
        await fit(page);
        expectFramed(await corners(page, 'plates'), 'after Fit');
        expect(errors).toEqual([]);
      });
  });
}

test.describe('at 1366 × 768', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  /* The drawer that was cropped. Changing the size is the moment the old framing stops
     describing anything, so an untouched view follows it. */
  test('bins: a 600 × 500 drawer is framed when the size changes', async ({ page }) => {
    const errors = await openBinsFilled(page);
    await H.setField(page, 'drawerW', 600);
    await H.setField(page, 'drawerD', 500);
    await page.locator('#fillRest').click();
    await page.waitForTimeout(800);
    expectFramed(await corners(page, 'bins'), '600 × 500');
    expect(errors).toEqual([]);
  });

  test('baseplates: a 600 × 500 drawer is framed when the size changes', async ({ page }) => {
    const errors = await openPlates(page);
    await H.setField(page, 'drawerW', 600);
    await H.setField(page, 'drawerD', 500);
    await platesReady(page);
    expectFramed(await corners(page, 'plates'), '600 × 500');
    expect(errors).toEqual([]);
  });

  /* The shell stands at the drawer's full height, so it is a taller thing to fit than
     the bins in it — and turning it on is asking to see the drawer. */
  test('bins: turning the drawer shell on frames the shell', async ({ page }) => {
    const errors = await openBinsFilled(page);
    await H.setField(page, 'drawerH', 160);
    await page.evaluate(() => {
      const e = document.getElementById('showDrawer');
      e.checked = true;
      e.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => drawerGroup.children.length),
      'fixture: the shell must really be drawn').toBeGreaterThan(0);
    expectFramed(await corners(page, 'bins'), 'with the shell');
    expect(errors).toEqual([]);
  });
});

/* The rule for when the page moves the camera and when it leaves it alone.
 *
 * The page frames the view until you zoom or pan, and then it is yours until you press
 * Fit. Rotating does not take it over: a re-frame keeps the angle, so there is nothing
 * of the rotation to overrule. Both halves are tested, because a fix for "it ignores
 * the drawer" that re-frames on everything is the bug baseplates already had. */
test('bins: a rotated view is re-framed for a new drawer, and keeps its angle',
  async ({ page }) => {
    const errors = await openBinsFilled(page);
    const p = await overCanvas(page);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 90, p.y + 20, { steps: 6 });
    await page.mouse.up();
    const turned = await page.evaluate(() => [theta, phi]);

    await H.setField(page, 'drawerW', 600);
    await H.setField(page, 'drawerD', 500);
    await page.locator('#fillRest').click();
    await page.waitForTimeout(800);
    expectFramed(await corners(page, 'bins'), 'after the drawer grew');
    const now = await page.evaluate(() => [theta, phi]);
    expect(now[0], 'the re-frame must not undo the rotation').toBeCloseTo(turned[0], 6);
    expect(now[1]).toBeCloseTo(turned[1], 6);
    expect(errors).toEqual([]);
  });

test('bins: once you zoom, the view is yours until Fit', async ({ page }) => {
  const errors = await openBinsFilled(page);
  await wheelIn(page, 4);
  const zoomed = await page.evaluate(() => [dist, panX, panZ, lookY]);

  // an edit to the bins, and then the drawer itself, and the camera stays put for both
  await H.setField(page, 'hUnits', 6);
  await H.setField(page, 'drawerW', 400);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => [dist, panX, panZ, lookY]),
    'a zoomed view was re-framed from under the person who zoomed it').toEqual(zoomed);

  // Fit keeps the angle it is given, and hands the framing back to the page
  const angle = await page.evaluate(() => [theta, phi]);
  await fit(page);
  expectFramed(await corners(page, 'bins'), 'after Fit');
  expect(await page.evaluate(() => [theta, phi])).toEqual(angle);
  await H.setField(page, 'drawerD', 500);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(800);
  expectFramed(await corners(page, 'bins'), 'a drawer change after Fit');
  expect(errors).toEqual([]);
});

/* This one shipped: every build ended by re-framing, and a build follows every change,
   so zooming in to look at a joint and then changing the clearance lost the zoom. */
test('baseplates: a rebuild no longer throws your zoom away', async ({ page }) => {
  const errors = await openPlates(page);
  await wheelIn(page, 3);
  const zoomed = await page.evaluate(() => ({ ...sph }));
  await page.selectOption('#connector', 'puzzle');
  await page.waitForTimeout(400);
  await platesReady(page);
  expect(await page.evaluate(() => ({ ...sph })),
    'a zoomed view was re-framed by a rebuild').toEqual(zoomed);
  expect(errors).toEqual([]);
});

/* Focus frames one bin, and leaving gives the drawer's view back — both of which the
   old fixed-distance framing did, and both of which moving the framing into the draw
   could have lost. */
test('bins: focus frames the one bin, and leaving it frames the drawer again',
  async ({ page }) => {
    await quiet(page);
    const errors = await H.openBins(page);
    await H.dragCells(page, [0, 0], [0, 0]);
    await H.clickCell(page, 0, 0);
    await page.locator('#focusBin').click();
    await page.waitForTimeout(500);
    expectFramed(await corners(page, 'bins'), 'one bin in focus');

    await page.locator('#focusExit').click();
    await page.waitForTimeout(500);
    expectFramed(await corners(page, 'bins'), 'back in the drawer');
    expect(errors).toEqual([]);
  });
