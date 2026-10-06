/* The header on a first visit and after it.
 *
 * The title, a two-line pitch and the privacy line took 202 px of a 1920 × 1080 window on
 * Baseplates and 245 on Bins, 304 and 287 of an 844 px phone, and 242 of a phone on its
 * side, which is 390 px tall — on every visit, to tell the visitor what they already knew.
 * After the first visit it is one line. These drive the real second arrival rather than
 * planting a key: the tool saves its own layout a moment after it opens, and that save is
 * what the next visit is told by.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const TOOLS = [
  { name: 'baseplates', open: H.openPlates, key: 'drawerforge:plates:v1', file: 'index.html' },
  { name: 'bins', open: H.openBins, key: 'drawerforge:bins:v1', file: 'bins/index.html' },
];

/* The second arrival, the way it happens: the first visit's own save lands, then the page
   is opened again. */
async function comeBack(page, tool) {
  await page.waitForFunction((k) => !!localStorage.getItem(k), tool.key, { timeout: 5000 });
  return tool.open(page);
}

const head = (page) => page.evaluate(() => {
  const h = document.querySelector('header');
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  // the boxes of what is left showing, to tell one row from several
  const kids = [...h.children].filter(vis).map((e) => e.getBoundingClientRect());
  return {
    height: h.getBoundingClientRect().height,
    pitch: vis(h.querySelector(':scope>p')),
    privacy: vis(h.querySelector(':scope>.privacy')),
    nav: vis(h.querySelector('nav')),
    drawer: vis(document.getElementById('drawersBtn')),
    quick: vis(document.getElementById('scratchBinTop')),
    oneRow: Math.max(...kids.map((r) => r.top)) < Math.min(...kids.map((r) => r.bottom)),
  };
});

for (const tool of TOOLS) {
  test(`${tool.name}: the full header on a first visit, one line after it`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const errors = await tool.open(page);
    const first = await head(page);
    expect(first.pitch, 'a first visit is told what the tool is').toBe(true);
    expect(first.privacy, 'and that nothing leaves the browser').toBe(true);
    expect(first.height, 'fixture: the full header is the tall one').toBeGreaterThan(150);

    const errors2 = await comeBack(page, tool);
    const again = await head(page);
    expect(again.pitch).toBe(false);
    expect(again.privacy).toBe(false);
    expect(again.oneRow, 'the name, the pages and the drawer on one line').toBe(true);
    expect(again.height).toBeLessThan(70);
    // nothing that does something has gone with the words
    expect(again.nav).toBe(true);
    expect(again.drawer).toBe(true);
    if (tool.name === 'bins') expect(again.quick).toBe(true);

    /* The work area is sized from whatever the header comes to, so the shorter header is
       space given to the rail and the stage rather than a gap under the footer. */
    const m = await page.evaluate(() => ({ vh: innerHeight,
      app: document.querySelector('.app').getBoundingClientRect().bottom }));
    expect(Math.abs(m.app - m.vh)).toBeLessThanOrEqual(1);
    expect(errors.concat(errors2)).toEqual([]);
  });

  /* A phone on its side is where the header cost most: 242 of 390 px. */
  test(`${tool.name}: one row on a phone on its side, and short upright`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await tool.open(page);
    const full = (await head(page)).height;

    await page.setViewportSize({ width: 844, height: 390 });
    await comeBack(page, tool);
    const side = await head(page);
    expect(side.oneRow).toBe(true);
    expect(side.height).toBeLessThan(70);

    /* Upright, the name and the tabs cannot share 390 px, so the bar wraps — the name,
       then the tabs with the drawer, and on Bins the way in to one bin — but it is still
       a fraction of the header it replaces. */
    await page.setViewportSize({ width: 390, height: 844 });
    await tool.open(page);
    const upright = await head(page);
    expect(upright.pitch).toBe(false);
    expect(upright.height).toBeLessThan(full * 0.55);
  });

  /* Drawn short from the first frame, not drawn long and collapsed. Every frame the page
     renders before it finishes loading is recorded, and none of them may have shown the
     tall header; and the script that decides is in the <head>, ahead of anything that
     could be painted, and not deferred. */
  test(`${tool.name}: a return visit never paints the tall header first`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await tool.open(page);
    await page.waitForFunction((k) => !!localStorage.getItem(k), tool.key);
    await page.addInitScript(() => {
      window.__frames = [];
      const tick = () => {
        const h = document.querySelector('header');
        if (h) window.__frames.push(h.getBoundingClientRect().height);
        if (document.readyState !== 'complete') requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await tool.open(page);
    const frames = await page.evaluate(() => window.__frames);
    expect(frames.length, 'fixture: no frame was recorded with the header in it')
      .toBeGreaterThan(0);
    expect(Math.max(...frames)).toBeLessThan(70);

    const html = fs.readFileSync(path.join(H.ROOT, tool.file), 'utf8');
    const at = html.indexOf("classList.add('returning')");
    expect(at, 'fixture: the script is in the page').toBeGreaterThan(0);
    expect(at, 'it runs in the <head>, before the header exists').toBeLessThan(html.indexOf('<body'));
    const tag = html.lastIndexOf('<script', at);
    expect(html.slice(tag, html.indexOf('>', tag) + 1)).toBe('<script>');
  });

  /* Storage that throws on access is what a browser with site data blocked does. The
     check is wrapped, and the visit counts as a first one: more said, not less. */
  test(`${tool.name}: blocked storage shows the full header and breaks nothing`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true,
        get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    });
    const errors = await tool.open(page);
    const h = await head(page);
    expect(h.pitch).toBe(true);
    expect(h.privacy).toBe(true);
    expect(await page.evaluate(() => document.documentElement.classList.contains('returning')))
      .toBe(false);
    expect(errors).toEqual([]);
  });

  /* The privacy line leaves the header after the first visit, so the footer has to carry
     it, and carry the same words rather than a paraphrase that drifts. */
  test(`${tool.name}: the footer says what the header's privacy line says`, async ({ page }) => {
    await tool.open(page);
    const t = await page.evaluate(() => ({
      header: document.querySelector('header .privacy').textContent.trim(),
      footer: document.querySelector('footer').textContent.replace(/\s+/g, ' '),
    }));
    expect(t.header.length, 'fixture: the header has a privacy line').toBeGreaterThan(40);
    expect(t.footer.toLowerCase()).toContain(t.header.toLowerCase());
  });
}

/* The guides have no layout of their own to come back to, and their header is the page's
   introduction, so it stays whole whatever this browser has saved. */
test('the guide keeps its whole header for a returning visitor', async ({ page }) => {
  // over HTTP: what one page stores for the next is only dependable on a real origin
  const site = await H.serveRoot();
  try {
    await page.goto(site.base + 'bins/');
    await page.waitForFunction(() => !!localStorage.getItem('drawerforge:bins:v1'));
    await page.goto(site.base + 'guide/');
    expect(await page.evaluate(() => !!localStorage.getItem('drawerforge:bins:v1')),
      'fixture: the guide is visited by a browser that has a saved layout').toBe(true);
    const h = await head(page);
    expect(h.pitch).toBe(true);
    expect(h.privacy).toBe(true);
  } finally {
    await site.close();
  }
});
