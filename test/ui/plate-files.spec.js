/* Where the print-plate 3MF puts each part, measured out of the downloaded file.
 *
 * The print plan on the page and the 3MF it downloads are two drawings of the same
 * plate, and nothing held them together. packPlates hands back the corner of the
 * rectangle a part should occupy, and the plate file placed every part by that corner
 * as if the corner were the mesh's origin. It is only the origin of an unturned
 * baseplate piece. A piece turned a quarter swings round its origin into the space to
 * its left, so on a 250 x 210 bed piece B2 printed on top of B1, and with stacking on a
 * turned piece left the bed altogether. The connector keys are modelled centred on the
 * origin, so every one sat 7 mm left of and 4 mm in front of where the plan drew it, and
 * those in the front row hung off the bed. The plan on the page looked right throughout.
 *
 * So this takes the files the download button saves, unzips them with the library the
 * pages zip with, puts every vertex of every part through the transform the file gives
 * it, and compares the box that comes out with the rectangle the page planned. Reading
 * the transform back is the point: a test of what platePolysAndItems returns would agree
 * with whatever the function thought it was doing. The window is 0.6 mm, which is the
 * jigsaw's lobe falling a fraction short of its planned edge and nothing else; a part in
 * the wrong place misses by a piece width or by half a key.
 *
 * Each layout also states what it contains — a turned piece, a turned key, a stack —
 * because a layout with no turned part in it passes against the bug, and the sweep these
 * were picked from found plenty that do.
 */
'use strict';
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
// the library the pages themselves use, so reading a zip back costs no dependency
const JSZip = require('../../vendor/jszip.min.js');

const TOL = 0.6;

/* The parts in one 3MF model, each as the box its vertices occupy after the item's
   transform. 3MF writes the transform as m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
   and applies it to a row vector, so the last three numbers are the translation and a
   point comes out as x' = x m00 + y m10 + z m20 + m30. Split first, match second: a
   piece is a megabyte of one <object>, and a lazy regex across the whole model walks
   back over every mesh before it. */
function partsOf(model) {
  const objects = new Map();
  for (const chunk of model.split('<object ').slice(1)) {
    const head = /^id="(\d+)"[^>]*?name="([^"]*)"/.exec(chunk);
    const verts = [...chunk.matchAll(/<vertex x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"\/>/g)]
      .map((m) => [+m[1], +m[2], +m[3]]);
    objects.set(head[1], { name: head[2], verts });
  }
  return [...model.matchAll(/<item objectid="(\d+)" transform="([^"]+)"\/>/g)].map(([, id, t]) => {
    const m = t.trim().split(/\s+/).map(Number);
    const o = objects.get(id);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const [x, y, z] of o.verts) {
      const p = [x * m[0] + y * m[3] + z * m[6] + m[9],
                 x * m[1] + y * m[4] + z * m[7] + m[10],
                 x * m[2] + y * m[5] + z * m[8] + m[11]];
      for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
    }
    return { name: o.name, lo, hi };
  });
}

/* Every plate the "All plates" button saves, in plate order: one 3MF on its own when
   there is one plate, a ZIP of them when there are several. */
async function downloadPlates(page, button) {
  await page.locator('#openExport').click();
  const [dl] = await Promise.all([page.waitForEvent('download'),
                                  page.locator(`#exFiles [data-ex="${button}"]`).click()]);
  const buf = fs.readFileSync(await dl.path());
  const name = dl.suggestedFilename();
  const files = [];
  if (/\.zip$/.test(name)) {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => /\.3mf$/.test(n))
      .sort((a, b) => +/(\d+)\.3mf$/.exec(a)[1] - +/(\d+)\.3mf$/.exec(b)[1]);
    for (const n of names) files.push(await zip.file(n).async('uint8array'));
  } else files.push(buf);
  const models = [];
  for (const f of files)
    models.push(await (await JSZip.loadAsync(f)).file('3D/3dmodel.model').async('string'));
  await page.locator('#exportClose').click();
  return models;
}

/* What is wrong with one plate file against the plate the page planned, as readable
   lines rather than a first failing number: when this breaks, the useful thing to see
   is every part that moved and by how much. */
function misplaced(model, plan, bed, label) {
  const parts = partsOf(model);
  const out = [];
  if (parts.length !== plan.length)
    return [`${label}: the file holds ${parts.length} parts, the plan ${plan.length}`];
  plan.forEach((p, k) => {
    const f = parts[k];
    const want = [p.x, p.x + p.w, p.y, p.y + p.d];
    const got = [f.lo[0], f.hi[0], f.lo[1], f.hi[1]];
    const where = `${label} ${p.id}${p.rot ? ' (turned)' : ''}`;
    const fmt = (b) => `x ${b[0].toFixed(1)}..${b[1].toFixed(1)} y ${b[2].toFixed(1)}..${b[3].toFixed(1)}`;
    if (!f.name.startsWith(p.id))
      out.push(`${where}: the file's part ${k + 1} is named ${f.name}`);
    if (want.some((v, i) => Math.abs(v - got[i]) > TOL))
      out.push(`${where}: planned ${fmt(want)}, the file puts it at ${fmt(got)}`);
    if (got[0] < -TOL || got[1] > bed[0] + TOL || got[2] < -TOL || got[3] > bed[1] + TOL)
      out.push(`${where}: off the ${bed[0]} x ${bed[1]} bed at ${fmt(got)}`);
    // a stacked piece sits on the stack gap above the one beneath it, not in it
    if (Math.abs(f.lo[2] - p.z) > 0.01)
      out.push(`${where}: planned to stand at z ${p.z.toFixed(2)}, the file has ${f.lo[2].toFixed(2)}`);
  });
  return out;
}

/* Picked from a sweep of drawer sizes, beds and joints run against the plan and the
   file side by side, which found the plate file wrong in 211 of 336. These are the
   examples the report was made from, plus one of each other kind of wrong: a turned
   key, the U-clip that a top-inserted snap ships, and the jigsaw, whose lobes stand
   proud of the plate and so make its planned box wider than the piece. */
const LAYOUTS = [
  { name: 'the MK4 example: a 300 x 250 drawer on a 250 x 210 bed',
    hash: 'w=300&d=250&pr=prusa-mk4&bw=250&bd=210&bh=220', has: { turnedPiece: true } },
  { name: 'a 300 x 300 drawer on a 256 bed, stacked',
    hash: 'w=300&d=300&bw=256&bd=256', stack: true, has: { turnedPiece: true, stacked: true } },
  { name: 'bowtie keys at their default size, on the default drawer',
    hash: 'cn=bowtie', has: { keys: true } },
  { name: 'bowtie keys turned to fit the last of a 220 bed',
    hash: 'w=500&d=220&bw=220&bd=220&pr=custom&cn=bowtie', has: { keys: true, turnedKey: true } },
  { name: 'top-inserted snap clips beside a stacked, turned piece',
    hash: 'w=300&d=300&cn=snap&km=wall&ki=top', stack: true,
    has: { keys: true, turnedPiece: true, stacked: true } },
  { name: 'the jigsaw on the MK4, one piece turned',
    hash: 'w=300&d=250&pr=prusa-mk4&bw=250&bd=210&bh=220&cn=puzzle', has: { turnedPiece: true } },
];

for (const L of LAYOUTS) {
  test(`every part of every plate file lands where the plan put it: ${L.name}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await H.forgetSaved(page);
    await page.goto(H.PLATES_URL + '#' + L.hash);
    await page.waitForFunction('printPlan && layout && Object.keys(builds).length === layout.pieces.length',
                               null, { timeout: 60_000 });
    if (L.stack) {
      // the toggle reads straight into a new plan, synchronously
      await page.evaluate(() => {
        const t = document.getElementById('stackToggle');
        t.checked = true;
        t.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    // out of the page's own model: the DOM drawing of the plan is not what is under test
    const { bed, plates } = await page.evaluate(() => ({
      bed: [state.bedW, state.bedD],
      plates: printPlan.plates.map((pl) => pl.placed.map((p) =>
        ({ id: p.id, x: p.x, y: p.y, w: p.w, d: p.d, z: p.z, rot: p.rot }))),
    }));
    const all = plates.flat();
    const has = {
      turnedPiece: all.some((p) => p.id !== 'key' && p.rot === 90),
      turnedKey: all.some((p) => p.id === 'key' && p.rot === 90),
      keys: all.some((p) => p.id === 'key'),
      stacked: all.some((p) => p.z > 0.01),
    };
    for (const [k, v] of Object.entries(L.has))
      expect(has[k], `fixture: this layout must contain ${k}, or it cannot show the bug`).toBe(v);

    const models = await downloadPlates(page, 'allplates');
    expect(models.length, 'one file per planned plate').toBe(plates.length);
    const wrong = models.flatMap((m, i) => misplaced(m, plates[i], bed, `plate ${i + 1}`));
    expect(wrong, 'parts the 3MF puts somewhere other than the plan').toEqual([]);
    expect(errors, 'the page threw while being driven').toEqual([]);
  });
}

/* The Bins page writes its plates through the same build3mfXML, and places them the
   other way on purpose: a bin is modelled centred on the origin, so the page turns the
   mesh first and then aims its centre at the middle of the planned rectangle, which is
   right whichever way round it went. This holds that to the same measurement, on a bed
   narrow enough that the long bins have to be turned to go on at all and the short ones
   do not. */
test('the Bins page plate files put each bin where its plan does, turned or not', async ({ page }) => {
  const errors = await H.openBins(page);
  await H.setField(page, 'drawerW', 252);
  await H.setField(page, 'drawerD', 168);
  await H.setField(page, 'bedPreset', 'custom');
  await H.setField(page, 'bedW', 120);
  await H.setField(page, 'bedD', 250);
  await H.setField(page, 'u', 4);
  await H.setField(page, 'v', 1);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(400);
  await H.setField(page, 'u', 2);
  await H.setField(page, 'v', 1);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(800);

  const { bed, plates } = await page.evaluate(() => ({
    bed: [state.bedW, state.bedD],
    plates: goodPlates().map(([pl]) => pl.placed.map((p) =>
      ({ id: p.id, x: p.x, y: p.y, w: p.w, d: p.d, z: p.z, rot: p.rot }))),
  }));
  const all = plates.flat();
  expect(all.some((p) => p.rot === 90), 'fixture: some bins must be turned').toBe(true);
  expect(all.some((p) => p.rot === 0), 'fixture: and some not').toBe(true);

  const models = await downloadPlates(page, 'allplates');
  expect(models.length, 'one file per printable plate').toBe(plates.length);
  const wrong = models.flatMap((m, i) => misplaced(m, plates[i], bed, `plate ${i + 1}`));
  expect(wrong, 'bins the 3MF puts somewhere other than the plan').toEqual([]);
  expect(errors, 'the page threw while being driven').toEqual([]);
});
