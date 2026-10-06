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

/* ---- printers by name ---------------------------------------------------------
   The beds below are written out again here on purpose, from the makers' spec pages
   rather than from tools/printers.js. A test that read its expectations from the list
   it is testing would pass whatever the list said, and the list being wrong is the bug
   this file exists for. */
const KNOWN = [
  ['Bambu Lab A1 mini', [180, 180, 180]],
  ['Bambu Lab A1 —', [256, 256, 256]],
  ['Bambu Lab H2D', [325, 320, 325]],
  ['Prusa MK4', [250, 210, 220]],
  ['Prusa CORE One', [250, 220, 270]],
  ['Creality Ender-3 V3 KE', [220, 220, 240]],
  ['Creality K1 Max', [300, 300, 300]],
  ['Elegoo Centauri Carbon', [256, 256, 256]],
  ['Anycubic Kobra 3', [250, 250, 260]],
];

for (const [name, open] of [['baseplates', H.openPlates], ['bins', H.openBins]]) {
  test(`${name}: printers are listed by name, grouped by maker, and fill in their bed`,
    async ({ page }) => {
      await H.forgetSaved(page);
      await open(page);
      const groups = await page.$$eval('#bedPreset optgroup', (gs) => gs.map((g) => g.label));
      for (const maker of ['Bambu Lab', 'Prusa', 'Creality', 'Elegoo', 'Anycubic'])
        expect(groups, `no ${maker} group`).toContain(maker);
      // the sizes the list used to offer are still there, and so is Custom
      expect(groups.some((g) => /by bed size/i.test(g))).toBe(true);
      expect(await page.$$eval('#bedPreset > option', (os) => os.map((o) => o.value)))
        .toContain('custom');

      for (const [label, want] of KNOWN) {
        const [o] = await namedOptions(page, label);
        expect(o, `nothing in the list is called "${label}"`).toBeTruthy();
        await pick(page, o.value);
        expect(await bed(page), `"${o.label}"`).toEqual(want);
      }
    });

  /* A link names the printer, not just the size: several entries share a 256 mm bed, and
     reopening on whichever came first would name a printer the sender never picked. */
  test(`${name}: a printer picked by name survives the link`, async ({ page }) => {
    await H.forgetSaved(page);
    await open(page);
    const [o] = await namedOptions(page, 'Elegoo Centauri Carbon');
    await pick(page, o.value);
    await page.waitForTimeout(900);              // past the save debounce
    const link = await page.evaluate(() => shareLink());
    expect(link).toContain(`pr=${o.value}`);
    expect(link).toContain('bw=256');

    await page.goto('about:blank');
    await page.goto(link);
    await page.waitForFunction(() => typeof THREE !== 'undefined');
    await page.waitForTimeout(300);
    expect(await page.inputValue('#bedPreset')).toBe(o.value);
    expect(await bed(page)).toEqual([256, 256, 256]);
  });

  /* Custom changes no number, which is how the bins page came to skip saving it: a
     reload put the printer's name back on a bed the person had said was their own. */
  test(`${name}: picking Custom survives a reload`, async ({ page }) => {
    await H.forgetSaved(page);
    await open(page);
    const [o] = await namedOptions(page, 'Elegoo Centauri Carbon');
    await pick(page, o.value);
    await page.waitForTimeout(900);              // past the save debounce
    await pick(page, 'custom');
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => location.hash)).toContain('pr=custom');

    await page.reload();
    await page.waitForFunction(() => typeof hashReady !== 'undefined' && hashReady);
    expect(await page.inputValue('#bedPreset')).toBe('custom');
    expect(await bed(page)).toEqual([256, 256, 256]);
  });

  /* Links and saves made before printers had names carry a bed and no id. They reopen
     on the size-only entry they were made with, and a bed matching nothing on the list
     says Custom — rather than the 256 mm entry the page loads with, which is what it
     showed above a 180 mm bed before. */
  test(`${name}: an older link shows its own bed, or Custom when nothing matches`,
    async ({ page }) => {
      const url = name === 'bins' ? H.BINS_URL : H.PLATES_URL;
      await page.goto(url + '#w=306&d=380&bw=220&bd=220&bh=250');
      await page.waitForFunction(() => typeof THREE !== 'undefined');
      await page.waitForTimeout(300);
      expect(await page.inputValue('#bedPreset')).toBe('bed-220');
      expect(await bed(page)).toEqual([220, 220, 250]);

      await page.goto('about:blank');
      await page.goto(url + '#w=306&d=380&bw=231&bd=228&bh=240');
      await page.waitForFunction(() => typeof THREE !== 'undefined');
      await page.waitForTimeout(300);
      expect(await page.inputValue('#bedPreset')).toBe('custom');
      expect(await bed(page)).toEqual([231, 228, 240]);

      // and an id whose bed was edited after picking it is not believed
      await page.goto('about:blank');
      await page.goto(url + '#w=306&d=380&bw=200&bd=180&bh=180&pr=bambu-a1-mini');
      await page.waitForFunction(() => typeof THREE !== 'undefined');
      await page.waitForTimeout(300);
      expect(await page.inputValue('#bedPreset')).toBe('custom');
    });

  test(`${name}: typing a bed by hand stops the list naming a printer`, async ({ page }) => {
    await H.forgetSaved(page);
    await open(page);
    const [o] = await namedOptions(page, 'Prusa MK4');
    await pick(page, o.value);
    expect(await page.inputValue('#bedPreset')).toBe(o.value);
    await H.setField(page, 'bedW', 300);
    expect(await page.inputValue('#bedPreset')).toBe('custom');
  });
}

/* The nav link, followed the way its handler follows it. Clicking it would go to
   bins/, which over file:// is a directory listing rather than the page. */
async function toBins(page) {
  const hash = await page.evaluate(() => binsHref().split('#')[1]);
  await page.goto(H.BINS_URL + '#' + hash);
  /* hashReady is the last thing the page's boot sets, after the saved unit and the
     link are applied. The map and three.js are both there before the page's own script
     has run, and on a loaded machine a fixed wait after them was not always enough. */
  await page.waitForFunction(() => typeof hashReady !== 'undefined' && hashReady);
  await page.waitForTimeout(300);
}

/* The bins page used to carry the bed through the link without reading it, so the
   printer picked on the baseplates page arrived as the 256 mm default — and a bed set on
   the bins page itself was lost on reload. */
test('the printer picked on the baseplates page arrives on the bins page', async ({ page }) => {
  await H.forgetSaved(page);
  await H.openPlates(page);
  const [o] = await namedOptions(page, 'A1 mini');
  await pick(page, o.value);
  await page.waitForTimeout(900);
  await toBins(page);
  expect(await page.inputValue('#bedPreset')).toBe(o.value);
  expect(await page.evaluate(() => [state.bedW, state.bedD, state.bedH]))
    .toEqual([180, 180, 180]);
});

/* ---- inches -------------------------------------------------------------------
   Inches are a way of typing the drawer. The model, the link and every export stay in
   millimetres, so a drawer typed as 12 in has to BE 304.8 mm everywhere past the field
   — and come back as 12 in for the person who typed it. */
const UNIT_KEY = 'drawerforge:units:v1';
/* Waits for the switch to have taken rather than for a fixed time: under load a click
   could still be queued when a test went on to the other page, which then opened in
   millimetres. The unit is stored in the same click handler that sets aria-pressed. */
const toInches = async (page) => {
  await page.click('#unitIn');
  await expect(page.locator('#unitIn')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(150);
};

/* The two tests below take the unit from one page to the next, so they run on a real
   origin, as the site does: from file:// pages the CI browser has now and then opened
   the next page with the stored unit missing. See H.serveRoot. */
let site;
test.beforeAll(async () => { site = await H.serveRoot(); });
test.afterAll(() => site.close());
const platesOver = async (page) => {
  await page.goto(site.base);
  await page.waitForFunction(() => /ready/.test(document.getElementById('pieceTail')?.textContent || ''),
                             null, { timeout: 30000 });
};
const booted = (page) => page.waitForFunction(() => typeof hashReady !== 'undefined' && hashReady);

test('baseplates: 12 in is 304.8 mm to the model and the link, and 12 in again on reload',
  async ({ page }) => {
    await platesOver(page);
    await toInches(page);
    await expect(page.locator('label:has(#drawerW) b')).toHaveText('Drawer width (in)');
    await H.setField(page, 'drawerW', '12');
    await page.waitForTimeout(900);

    expect(await page.evaluate(() => state.drawerW)).toBe(304.8);
    const link = await page.evaluate(() => shareLink());
    expect(link, 'the link is in millimetres whatever the field shows').toMatch(/[#&]w=304\.8(&|$)/);
    expect(await page.evaluate((k) => localStorage.getItem(k), UNIT_KEY)).toBe('in');

    // the unit is remembered on the device, and the link's millimetres shown in it
    await page.goto('about:blank');
    await page.goto(link);
    await booted(page);
    expect(await page.inputValue('#drawerW')).toBe('12');
    expect(await page.evaluate(() => state.drawerW)).toBe(304.8);
    await expect(page.locator('#unitIn')).toHaveAttribute('aria-pressed', 'true');
  });

/* Looking at a drawer in another unit must not change it. 306 mm is 12.047 in, shown
   as 12.05 — and 12.05 in is 306.07 mm, so a switch that converted the text both ways
   would quietly grow the drawer every time someone looked at it in inches. */
test('baseplates: switching units changes no measurement and rebuilds nothing',
  async ({ page }) => {
    await H.forgetSaved(page);
    await H.openPlates(page);
    const before = await page.evaluate(() => ({ w: state.drawerW, d: state.drawerD,
      link: shareLink(), builds: Object.keys(builds).length }));

    await toInches(page);
    expect(await page.inputValue('#drawerW')).toBe('12.05');
    expect(await page.evaluate(() => state.drawerW)).toBe(306);
    await page.click('#unitMm');
    await page.waitForTimeout(400);
    expect(await page.inputValue('#drawerW')).toBe('306');

    const after = await page.evaluate(() => ({ w: state.drawerW, d: state.drawerD,
      link: shareLink(), builds: Object.keys(builds).length }));
    expect(after).toEqual(before);
    await expect(page.locator('#pieceTail')).toHaveText(/ready/);
  });

test('baseplates: the grid summary gives both units with inches on, and only then',
  async ({ page }) => {
    await H.forgetSaved(page);
    await H.openPlates(page);
    const mm = await page.locator('#gridSummary').textContent();
    expect(mm).toContain('294 × 378 mm');
    expect(mm).not.toMatch(/\bin\)/);
    await toInches(page);
    const both = await page.locator('#gridSummary').textContent();
    // 294 mm is 11.57 in, 378 mm is 14.88 in
    expect(both).toContain('294 × 378 mm, 11.57 × 14.88 in');
  });

test('baseplates: custom margins are typed in inches too', async ({ page }) => {
  await H.forgetSaved(page);
  await H.openPlates(page);
  await toInches(page);
  await page.selectOption('#marginMode', 'custom');
  await expect(page.locator('label:has(#mLeft) b')).toHaveText('Left / Right (in)');
  await H.setField(page, 'mLeft', '0.5');
  expect(await page.evaluate(() => state.mLeft)).toBe(12.7);
});

/* plates-input.spec.js drives nonsense in millimetres; this is the same nonsense typed
   into an inch field. The message has to name the unit being typed, and the browser's
   own validity has to agree with the tool's range, which works in millimetres. */
test.describe('nonsense in the size fields, in inches', () => {
  for (const [what, value, says] of [
    ['negative', '-2', /Drawer width must be at least 1 mm \(0\.04 in\)/],
    ['blank', '', /Drawer width is blank — enter a measurement in inches/],
    ['huge', '9999', /Drawer width must be 2000 mm \(78\.74 in\) or less — check the figure is in inches/],
  ]) {
    test(`a ${what} width in inches is refused at the field`, async ({ page }) => {
      await H.forgetSaved(page);
      await H.openPlates(page);
      await toInches(page);
      await H.setField(page, 'drawerW', value);
      await page.waitForTimeout(900);
      const s = await page.evaluate(() => ({
        msg: document.getElementById('errDrawerW').textContent,
        shown: !document.getElementById('errDrawerW').hidden,
        invalid: document.getElementById('drawerW').getAttribute('aria-invalid'),
        exportOff: document.getElementById('openExport').disabled,
      }));
      expect(s.msg).toMatch(says);
      expect(s).toMatchObject({ shown: true, invalid: 'true', exportOff: true });
    });
  }

  test('the browser agrees about the range in inches, and a good value clears it',
    async ({ page }) => {
      await H.forgetSaved(page);
      await H.openPlates(page);
      await toInches(page);
      const valid = () => page.evaluate(() => document.getElementById('drawerW').validity.valid);
      await H.setField(page, 'drawerW', '-2');
      expect(await valid()).toBe(false);
      await H.setField(page, 'drawerW', '80');            // 2032 mm, past the 2000 cap
      expect(await valid()).toBe(false);
      await H.setField(page, 'drawerW', '12.125');        // an eighth: no step mismatch
      expect(await valid()).toBe(true);
      await page.waitForTimeout(900);
      expect(await page.locator('#errDrawerW').textContent()).toBe('');
      expect(await page.evaluate(() => state.drawerW)).toBe(307.975);
    });
});

test('bins: the drawer is typed in inches, the height and front too', async ({ page }) => {
  await H.forgetSaved(page);
  await H.openBins(page);
  await page.click('#s-drawer > h2 > button');      // panel 01 loads closed here
  await toInches(page);
  for (const [id, label] of [['drawerW', 'Drawer width (in)'], ['drawerH', 'Usable height (in)']])
    await expect(page.locator(`label:has(#${id}) b`)).toHaveText(label);
  await H.setField(page, 'drawerW', '12');
  await H.setField(page, 'drawerD', '15');
  await H.setField(page, 'drawerH', '3.5');
  await H.setField(page, 'drawerFrontH', '4');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => [state.drawerW, state.drawerD, state.drawerH,
    state.drawerFrontH])).toEqual([304.8, 381, 88.9, 101.6]);
  // the baseplate height is a spec figure, not a measurement, and stays in millimetres
  expect(await page.inputValue('#plateH')).toBe('4.25');
  expect(await page.evaluate(() => state.plateH)).toBe(4.25);

  const link = await page.evaluate(() => shareLink());
  expect(link).toMatch(/[#&]w=304\.8&/);
  expect(link).toMatch(/[#&]dh=88\.9&/);

  /* Counting cells writes the millimetre field, so in inches it has to write inches:
     four cells is 168 mm, 6.61 in. Written as 168 into an inch field it would be a
     4.3 m drawer. */
  await H.setField(page, 'gridX', '4');
  expect(await page.inputValue('#drawerW')).toBe('6.61');
  expect(await page.evaluate(() => state.drawerW)).toBe(168);
  await expect(page.locator('#gridSummary')).toContainText('168 × 378 mm, 6.61 × 14.88 in');
});

/* Inches are for the drawer only. The bin's wall, floor, scoop and label shelf and the
   printer's bed are labelled in millimetres in either unit, and were read as inches:
   a bin drawn in inches had a 10 mm wall (1.2 in, clamped), a floor filling the whole
   bin and a 2000 mm bed (256 in, clamped). */
test('bins: in inches, a bin is drawn with its millimetre wall, floor and bed', async ({ page }) => {
  await H.forgetSaved(page);
  await H.openBins(page);
  await page.click('#s-drawer > h2 > button');      // panel 01 loads closed here
  await toInches(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  const bin = await page.evaluate(() => {
    const b = B()[0];
    return { wall: b.wall, floorT: b.floorT, scoop: b.scoop, label: b.label };
  });
  expect(bin).toEqual({ wall: 1.2, floorT: 1.2, scoop: 0, label: 0 });
  expect(await page.evaluate(() => [state.bedW, state.bedD, state.bedH])).toEqual([256, 256, 256]);
  expect(await page.inputValue('#wall')).toBe('1.2');

  // a figure typed into a millimetre field is millimetres, with inches on
  await H.setField(page, 'wall', '2');
  await H.setField(page, 'floorT', '3');
  await H.setField(page, 'scoop', '10');
  await H.setField(page, 'label', '12');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => {
    const b = B()[0];
    return [b.wall, b.floorT, b.scoop, b.label];
  })).toEqual([2, 3, 10, 12]);
  // and the check of the bed against the bin reads the bed in millimetres too
  await H.setField(page, 'bedW', '180');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => state.bedW)).toBe(180);
});

test('one unit for both tools: inches picked on one page are inches on the other',
  async ({ page }) => {
    await platesOver(page);
    await toInches(page);
    await page.click('#navBins');                // the header link, as a visitor goes
    await page.waitForURL(/\/bins\/#/);
    await booted(page);
    await expect(page.locator('#unitIn')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.inputValue('#drawerW')).toBe('12.05');
    expect(await page.evaluate(() => state.drawerW)).toBe(306);
  });
