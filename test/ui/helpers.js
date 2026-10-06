/* Shared driving for the bins page.
 *
 * Every one of these helpers exists because the map is an SVG with a viewBox and
 * preserveAspectRatio, so its internal coordinates are NOT its CSS pixels: the
 * element letterboxes, and measuring across getBoundingClientRect once produced a
 * ~190 px dead margin and a pointer offset that felt like the map was ignoring
 * clicks. getScreenCTM is the only mapping that accounts for it.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const BINS_URL = pathToFileURL(path.join(ROOT, 'bins', 'index.html')).href;
const PLATES_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const CELL = 40;   // the map's own viewBox units per grid cell

async function openBins(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BINS_URL);
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(200);
  return errors;
}

/* The baseplates page builds its pieces asynchronously and on a timer, so there is a
   window after load in which the piece table, the print plan and the export dialog are
   all still empty. Waiting for the table to say "ready" is waiting for the real thing
   rather than for a duration that happens to be long enough on this machine. */
async function openPlates(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(PLATES_URL);
  await page.waitForFunction(() => {
    const t = document.getElementById('pieceTail');
    return t && /ready/.test(t.textContent);
  }, null, { timeout: 20000 });
  return errors;
}

/* Both tools save the layout to localStorage behind a 400 ms debounce and, on a load
   that finds one, show the #restored banner. A test that opens the page a second time
   therefore gets one of two different pages depending on whether that timer beat the
   navigation — which is a coin toss, and has already been flaky in on-screen.spec.js:
   the banner is ~88 px tall and pushes the map down the phone viewport.

   This makes the second arrival a genuinely fresh one. It clears the key before any
   page script runs on EVERY subsequent navigation, rather than deleting it once and
   hoping the outgoing page's timer does not fire in the gap. Opt-in on purpose:
   persist.spec.js exists to drive the restore, so the helpers must not clear it for
   everybody. */
const SAVE_KEYS = ['drawerforge:bins:v1', 'drawerforge:plates:v1'];
async function forgetSaved(page) {
  await page.addInitScript((keys) => {
    for (const k of keys) { try { localStorage.removeItem(k); } catch (err) { /* private mode */ } }
  }, SAVE_KEYS);
}

/* Viewport coordinates of the centre of grid cell (gx, gy). Front of the drawer is
   the bottom of the map, so grid y counts up from there while SVG y counts down. */
async function cellPoint(page, gx, gy) {
  /* Scroll first, then measure. page.mouse works in viewport coordinates, and the
     map sits well down a long page — measuring before scrolling gives coordinates
     that are off-screen, so the drag lands nowhere and the test sees an empty
     drawer rather than the bug it was written for. */
  await page.evaluate(() =>
    document.getElementById('fillmap').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(80);
  return page.evaluate(({ gx, gy, CELL }) => {
    const svg = document.getElementById('fillmap');
    const ny = svg.getAttribute('viewBox').split(' ').map(Number)[3] / CELL;
    const p = svg.createSVGPoint();
    p.x = (gx + 0.5) * CELL;
    p.y = (ny - 1 - gy + 0.5) * CELL;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  }, { gx, gy, CELL });
}

async function dragCells(page, from, to) {
  const a = await cellPoint(page, from[0], from[1]);
  const b = await cellPoint(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* page.mouse.click takes no `modifiers` option -- that only exists on locator and
   page click. Passing one there is accepted and ignored, so an alt-click silently
   became a plain click and the test failed against working code. Hold the key. */
async function clickCell(page, gx, gy, modifiers = []) {
  const p = await cellPoint(page, gx, gy);
  for (const m of modifiers) await page.keyboard.down(m);
  try {
    await page.mouse.click(p.x, p.y);
  } finally {
    for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
  }
  await page.waitForTimeout(150);
}

/* The layout, read out of the page's own model rather than scraped from the DOM —
   the DOM is what we are testing, so it cannot also be the source of truth. */
async function bins(page) {
  return page.evaluate(() => B().map((b) => ({
    x: b.x, y: b.y, u: b.u, v: b.v, hUnits: b.hUnits,
    cells: binCells(b).map((c) => c.join(',')).sort(),
    carved: isCarved(b),
    outsideBox: (b.cells || []).filter(([x, y]) => x >= b.u || y >= b.v || x < 0 || y < 0).length,
  })));
}

const setField = async (page, id, value) => {
  await page.evaluate(({ id, value }) => {
    const e = document.getElementById(id);
    e.value = value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, value: String(value) });
  await page.waitForTimeout(250);
};

/* The site's own files over HTTP, for tests that go from one page to the other the way
   a visitor does. The header links point at directories ("bins/", "../"), which a
   file:// URL does not resolve to their index.html, and what one page stores for the
   next is only dependable on a real origin: from file:// pages the CI browser has now
   and then opened the second page with the first page's localStorage write missing,
   through reloads. The server listens on a port the system picks, so there is no port
   to collide on. Resolves to { base, close }, and two switches for the offline cases:

     down   set true and every request is cut off unanswered, as a dropped connection
            is, until it is set false again
     files  { '/path': text } served in place of the file on disk, to stand in for a
            deploy that has changed it

   The manifest's type is the one GitHub Pages sends for .webmanifest. */
async function serveRoot() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
                  '.svg': 'image/svg+xml', '.png': 'image/png',
                  '.webmanifest': 'application/manifest+json' };
  const site = { down: false, files: {} };
  const server = http.createServer((req, res) => {
    if (site.down) { req.socket.destroy(); return; }
    const asked = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const p = asked.endsWith('/') ? asked + 'index.html' : asked;
    const type = { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' };
    if (Object.prototype.hasOwnProperty.call(site.files, asked)) {
      res.writeHead(200, type);
      res.end(site.files[asked]);
      return;
    }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, type);
      res.end(buf);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  site.base = `http://127.0.0.1:${server.address().port}/`;
  site.close = () => new Promise((r) => server.close(r));
  return site;
}

module.exports = { openBins, openPlates, cellPoint, dragCells, clickCell, bins, setField,
                   forgetSaved, serveRoot, SAVE_KEYS, BINS_URL, PLATES_URL, CELL, ROOT };
