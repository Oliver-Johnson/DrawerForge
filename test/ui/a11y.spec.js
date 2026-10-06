/* Browser-level checks for the things a mouse never notices.
 *
 * Every case here is a finding from a review that drove the real pages, so like the
 * rest of test/ui this is a record of bugs rather than a wish list. The worst of them
 * was not a rough edge: panels 01 and 02 load collapsed, a collapsed panel's body is
 * display:none, and the header was a bare <h2> with a click listener — so the drawer
 * size and the printer bed were not reachable by keyboard at all. Not slow to reach.
 * Absent. The baseplates page had the same shape and the same bug in panel 06, the
 * socket profile, which is why the panel cases below run against both tools.
 *
 * Each assertion is written to fail against the code as it was. Where a test could
 * pass by accident — a label written once into the markup, an aria attribute that
 * never moves — it checks the value CHANGES with the state as well as matching it.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');
const H = require('./helpers.js');

const pageUrl = (rel) => pathToFileURL(path.join(H.ROOT, rel)).href;

const OWNED_PAGES = [
  ['baseplates', 'index.html'],
  ['bins', 'bins/index.html'],
  ['guide', 'guide/index.html'],
  ['guide/split', 'guide/split/index.html'],
  ['guide/drawer-sizes', 'guide/drawer-sizes/index.html'],
];

/* Both tools have the same rail of collapsing panels, and both ship at least one of
   them closed, so the panel cases below run against each. The closed panel and the
   first field inside it differ — bins loads 01 and 02 closed, baseplates loads 06 —
   and that is the whole of what the two pages disagree about here. */
const PANEL_TOOLS = [
  { name: 'bins', open: H.openBins, closed: 's-drawer', field: 'drawerW' },
  { name: 'baseplates', open: H.openPlates, closed: 's-prof', field: 'tolerance' },
];

/* Tab forward until `match` is happy, and say where focus ended up. Bounded, because
   the tab ring wraps: without a cap a control that is never reachable spins forever
   instead of failing. */
async function tabUntil(page, match, limit = 60) {
  const seen = [];
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const sec = a.closest('section.p');
      return {
        tag: a.tagName,
        id: a.id,
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        section: sec ? sec.id : null,
        inHeader: !!a.closest('section.p>h2'),
        expanded: a.getAttribute('aria-expanded'),
      };
    });
    if (at) seen.push(at);
    if (at && match(at)) return { hit: at, seen };
  }
  return { hit: null, seen };
}

/* ---- the collapsed panel ------------------------------------------------- */

/* Enter and Space are tested separately rather than in a loop over the two keys,
   because they reach a button by different routes — Enter fires click on keydown,
   Space on keyup — and a hand-rolled key handler has historically got exactly one
   of them right. */
for (const tool of PANEL_TOOLS) for (const key of ['Enter', 'Space']) {
  test(`${tool.name}: a keyboard can reach a collapsed panel header and open it with ${key}`,
    async ({ page }) => {
      await tool.open(page);

      // the panel has to actually be collapsed, or this test proves nothing
      await expect(page.locator('#' + tool.closed)).toHaveClass(/closed/);
      await expect(page.locator('#' + tool.field)).toBeHidden();

      const { hit, seen } = await tabUntil(page, (a) => a.section === tool.closed && a.inHeader);
      expect(hit,
        `Tab never stopped on the header of #${tool.closed}, so its fields cannot be reached. ` +
        'Focus visited: ' + seen.map((s) => s.tag + '#' + s.id).join(' → ')).not.toBeNull();
      expect(hit.expanded).toBe('false');

      await page.keyboard.press(key);
      await expect(page.locator('#' + tool.closed)).not.toHaveClass(/closed/);
      await expect(page.locator('#' + tool.field)).toBeVisible();
      // and the field is now genuinely usable from where the keyboard already is
      await page.keyboard.press('Tab');
      await expect(page.locator('#' + tool.field)).toBeFocused();
    });
}

for (const tool of PANEL_TOOLS)
test(`${tool.name}: aria-expanded tracks the panel, in both directions`, async ({ page }) => {
  await tool.open(page);

  const read = () => page.evaluate(() =>
    [...document.querySelectorAll('section.p')].map((s) => {
      const b = s.querySelector(':scope>h2>button');
      return { id: s.id, open: !s.classList.contains('closed'),
               expanded: b ? b.getAttribute('aria-expanded') : null };
    }));

  const before = await read();
  expect(before.length).toBeGreaterThan(2);
  for (const p of before) {
    expect(p.expanded, `${p.id} has no header button`).not.toBeNull();
    expect(p.expanded, `${p.id} starts out of step with its own class`)
      .toBe(String(p.open));
  }
  // the two states have to both be represented, or "matches" is a coincidence
  expect(new Set(before.map((p) => p.expanded)).size).toBe(2);

  // toggle every one of them, so a value written once into the markup is caught
  await page.evaluate(() =>
    document.querySelectorAll('section.p>h2>button').forEach((b) => b.click()));

  const after = await read();
  for (let i = 0; i < after.length; i++) {
    expect(after[i].open, `${after[i].id} did not toggle`).toBe(!before[i].open);
    expect(after[i].expanded, `${after[i].id} left aria-expanded behind`)
      .toBe(String(after[i].open));
  }
});

/* ---- the map and the preview --------------------------------------------- */

test('the map says what it is showing, and keeps saying it as the drawer fills',
  async ({ page }) => {
    await H.openBins(page);

    const label = () => page.locator('#fillmap').getAttribute('aria-label');
    const empty = await label();
    expect(empty).toBeTruthy();
    expect(empty).toMatch(/no bins on this layer/i);
    expect(empty).toMatch(/layer 1 of 1/i);
    // the grid size is read out, and it is the real one rather than a guess
    const g = await page.evaluate(() => { const q = grid(); return [q.nx, q.ny]; });
    expect(empty).toContain(`${g[0]} by ${g[1]} cells`);

    await H.dragCells(page, [0, 0], [2, 1]);       // a 3x2 bin in the front-left corner
    const filled = await label();
    expect(filled, 'the label never changed, so it is markup rather than state')
      .not.toBe(empty);
    expect(filled).toMatch(/1 bin on this layer/i);
    expect(filled).toContain('3 by 2 at column 1, row 1');

    // and it follows a layer change, which is the state you are most likely to lose
    await page.locator('#addLayer').click();
    await page.waitForTimeout(200);
    const layer2 = await label();
    expect(layer2).toMatch(/layer 2 of 2/i);
    expect(layer2).toMatch(/no bins on this layer/i);
  });

/* The Steps switch is two buttons in a group named by its label, each saying whether it
   is the one on, and worked from the keyboard like any button. What it changes is how
   the map draws, which a screen reader cannot see, so the map's own label says it. */
test('the steps switch is a labelled pair a keyboard can work, and the map says which',
  async ({ page }) => {
    await H.openBins(page);
    const group = page.getByRole('group', { name: 'Steps' });
    await expect(group.getByRole('button')).toHaveText(['Whole cells', 'Half cells']);
    const pressed = () => page.evaluate(() => ['stepWhole', 'stepHalf'].map((id) =>
      document.getElementById(id).getAttribute('aria-pressed')));
    const label = () => page.locator('#fillmap').getAttribute('aria-label');
    expect(await pressed()).toEqual(['true', 'false']);
    expect(await label()).not.toMatch(/half-cell steps/);

    const { hit } = await tabUntil(page, (a) => a.id === 'stepHalf');
    expect(hit, 'never tabbed onto the Half cells button').not.toBeNull();
    await page.keyboard.press('Enter');
    expect(await pressed()).toEqual(['false', 'true']);
    expect(await label()).toMatch(/Drawing in half-cell steps\.$/);

    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('stepWhole');
    await page.keyboard.press('Space');
    expect(await pressed()).toEqual(['true', 'false']);
    expect(await label()).not.toMatch(/half-cell steps/);
    // why a place was refused is said where a screen reader hears it
    await expect(page.locator('#stepWhy')).toHaveAttribute('role', 'status');
  });

test('the 3D preview is labelled with what it contains', async ({ page }) => {
  await H.openBins(page);
  const label = () => page.locator('#three').getAttribute('aria-label');

  expect(await label()).toMatch(/empty/i);
  await H.dragCells(page, [0, 0], [1, 1]);
  const filled = await label();
  expect(filled).toMatch(/1 bin over 1 layer/i);
  expect(filled).toMatch(/tallest stack [\d.]+ millimetres/i);
});

/* The same for the baseplates preview, which had neither the role nor a label at all —
   on the tool the site opens on. Written to fail against a label that merely exists:
   every fact in it is compared against the page's own model, and both the grid and the
   joint are moved to check the label moves with them. A label set once and left is the
   failure mode the bins page has shipped, where an early return skips the update and it
   reads "loading" for the life of the session. */
test('the baseplates preview is labelled, and the label follows the design',
  async ({ page }) => {
    await H.openPlates(page);
    const label = () => page.locator('#three').getAttribute('aria-label');
    const ready = () => page.waitForFunction(
      () => /ready/.test(document.getElementById('pieceTail').textContent),
      null, { timeout: 40000 });

    expect(await page.locator('#three').getAttribute('role')).toBe('img');

    const first = await label();
    const m = await page.evaluate(() =>
      ({ nx: layout.nx, ny: layout.ny, n: layout.pieces.length }));
    expect(first).toContain(`${m.nx} by ${m.ny} cell baseplate`);
    expect(first).toContain(`${m.n} piece`);
    expect(first, 'fixture: the default joint is dovetail tabs').toMatch(/dovetail tabs/);

    // the joint moves, and the label with it
    await H.setField(page, 'connector', 'hclip');
    await ready();
    const joint = await label();
    expect(joint, 'the label ignored the joint changing').not.toBe(first);
    expect(joint).toMatch(/H-clips/);

    // and so does the grid
    await H.setField(page, 'drawerW', 500);
    await ready();
    const bigger = await label();
    const m2 = await page.evaluate(() => [layout.nx, layout.ny]);
    expect(m2[0], 'fixture: the drawer must really have gained cells')
      .toBeGreaterThan(m.nx);
    expect(bigger).toContain(`${m2[0]} by ${m2[1]} cell baseplate`);

    // and it does not go on describing a design that is no longer possible
    await H.setField(page, 'drawerW', '');
    await page.waitForTimeout(900);
    const gone = await label();
    expect(gone, 'the label outlived the design').not.toBe(bigger);
    expect(gone).toMatch(/nothing to show/i);
  });

/* ---- structure ----------------------------------------------------------- */

for (const [name, rel] of OWNED_PAGES) {
  test(`${name} has one main landmark and a skip link that reaches it`,
    async ({ page }) => {
      await page.goto(pageUrl(rel));
      await expect(page.locator('main')).toHaveCount(1);

      const skip = page.locator('a.skip');
      await expect(skip).toHaveCount(1);
      // it is the first thing Tab finds, or it is not a skip link
      await page.keyboard.press('Tab');
      await expect(skip).toBeFocused();
      // and visible once focused — parked off-screen until then is fine, hidden is not
      await expect(skip).toBeInViewport();

      const target = await skip.getAttribute('href');
      expect(target).toMatch(/^#\w/);
      /* window.Node, not the bare name. src/core.js declares `class Node` for the BSP
         tree at top level, which puts a binding in the global lexical scope and
         shadows the DOM interface for everything evaluated in the page afterwards —
         so a bare `Node.DOCUMENT_POSITION_PRECEDING` is undefined on the tools and
         this check silently passed nothing. The window property is untouched, because
         a class declaration does not become one. */
      const landed = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.focus();
        return { ok: document.activeElement === el, afterHeader:
          !!(el.compareDocumentPosition(document.querySelector('header')) &
             window.Node.DOCUMENT_POSITION_PRECEDING) };
      }, target);
      expect(landed, `${target} does not exist`).not.toBeNull();
      /* Honest about its reach: on the guide pages, deleting tabindex="-1" fails this
         assertion, which is the point of it. On the tools it does not, because the
         stage is a scroll container and Chrome makes those focusable on their own —
         so in Chromium the attribute is redundant there. It stays in the markup
         because that is a Chrome behaviour, not a specified one, and this suite runs
         one engine. Do not read a pass here as proof the attribute is present. */
      expect(landed.ok, 'the skip target cannot take focus, so Tab carries on from the nav')
        .toBe(true);
      expect(landed.afterHeader, 'the skip target sits before the nav it should skip')
        .toBe(true);
    });

  test(`${name} puts no interactive content inside a link`, async ({ page }) => {
    await page.goto(pageUrl(rel));
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll('a button, a a, a input, a select, a textarea')]
        .map((e) => e.outerHTML.slice(0, 90)));
    expect(bad, 'interactive content inside an <a> is invalid HTML').toEqual([]);
  });
}

/* ---- the tip jar --------------------------------------------------------- */

test('the tip jar is not covering the page the moment you arrive', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await H.openBins(page);

  await expect(page.locator('#kofi')).toBeHidden();
  // nothing has reserved space for a panel that is not there
  expect(await page.evaluate(() =>
    document.documentElement.classList.contains('kofi-on'))).toBe(false);

  await page.mouse.wheel(0, 400);
  await expect(page.locator('#kofi')).toBeVisible();
  expect(await page.evaluate(() =>
    document.documentElement.classList.contains('kofi-on'))).toBe(true);

  // and dismissing it takes the reserved space away with it
  await page.locator('#kofiX').click();
  await expect(page.locator('#kofi')).toBeHidden();
  expect(await page.evaluate(() =>
    document.documentElement.classList.contains('kofi-on'))).toBe(false);
});

test('a dismissed tip jar stays dismissed across a reload', async ({ page }) => {
  await H.openBins(page);
  await page.mouse.wheel(0, 400);
  await expect(page.locator('#kofi')).toBeVisible();
  await page.locator('#kofiX').click();

  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  await expect(page.locator('#kofi')).toBeHidden();
});

/* ---- focus you can see --------------------------------------------------- */

/* .seg sets overflow:hidden to round the group's ends, and a focus ring is drawn
   OUTSIDE the element by definition, so the group clipped it away — tabbing onto a
   layer button left a faint background shift as the only cue. The fix is a ring drawn
   inside the button, which is what a negative offset means, so that is what is
   asserted: a positive or zero offset is the bug coming back. */
test('a focused segmented button draws a ring the group cannot clip', async ({ page }) => {
  await H.openBins(page);
  const { hit } = await tabUntil(page, (a) => a.text.startsWith('Layer 1'));
  expect(hit, 'never tabbed onto a segmented control').not.toBeNull();

  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return { width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset),
             style: s.outlineStyle, clipped: getComputedStyle(
               document.activeElement.parentElement).overflow };
  });
  expect(ring.clipped, 'the group no longer clips, so this test is measuring nothing')
    .toBe('hidden');
  expect(ring.style).not.toBe('none');
  expect(ring.width).toBeGreaterThan(0);
  expect(ring.offset).toBeLessThan(0);
});

test('reduced motion reaches every transition, not just the scrollbar', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await H.openBins(page);
  await page.evaluate(() => document.documentElement.classList.add('kofi-on'));

  const moving = await page.evaluate(() => {
    const out = [];
    const check = (sel, name) => {
      const el = document.querySelector(sel);
      if (!el) { out.push(name + ' (missing)'); return; }
      const t = getComputedStyle(el).transitionProperty;
      if (t && t !== 'none') out.push(name + ': ' + t);
    };
    check('section.p .caret', 'panel caret');
    check('.tog input', 'toggle knob');
    check('#kofi', 'tip jar');
    check('a.skip', 'skip link');
    check('header nav a', 'nav tab');
    return out;
  });
  expect(moving, 'these still animate under prefers-reduced-motion').toEqual([]);
});
