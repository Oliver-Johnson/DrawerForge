/* Installed, and opened with no connection.
 *
 * The tools always worked offline once they were open. Opening one did not: with no
 * connection there was no page to show. sw.js caches the site so that it can be, and
 * this is the check that it really is — the tool loads, three.js and all, and the drawer
 * in the address is the drawer on screen.
 *
 * Served over HTTP by H.serveRoot, because a service worker needs an origin and a page
 * opened from a file has none.
 *
 * "Offline" is two switches here, not one. context.setOffline() is what a browser with no
 * connection looks like to the page, but it reaches the service worker through DevTools,
 * and with the Chromium these were written against it did not stop the worker's own
 * requests: offline, the worker fetched /bins/ from the server and the page loaded from
 * the network. A test that passes because the network answered proves nothing, so the
 * server goes dark as well and cuts off every request unanswered. Then the only place a
 * page can come from is the cache.
 *
 * The layout matters as much as the page. It is in the fragment, which the browser never
 * sends to a server, so an offline visit to /bins/#bl=… has to find the cached /bins/
 * rather than a page the cache has never seen.
 *
 * The last case is the other half of the promise: opened from a file, as these tests and
 * plenty of people open it, the page registers nothing and logs nothing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

let site;
test.beforeAll(async () => { site = await H.serveRoot(); });
test.afterAll(() => site.close());
// one server for the file, so a case that ends offline must not leave the next one offline
test.afterEach(() => { site.down = false; site.files = {}; site.maxAge = 0; site.log = []; });

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}
const platesReady = (page) => page.waitForFunction(() => {
  const t = document.getElementById('pieceTail');
  return typeof THREE !== 'undefined' && t && /ready/.test(t.textContent);
}, null, { timeout: 30000 });
const binsReady = async (page) => {
  await page.waitForFunction(() => typeof THREE !== 'undefined' &&
    !!document.getElementById('fillmap') && typeof B === 'function');
  await page.waitForTimeout(200);
};
const binCount = (page) => page.evaluate(() => B().length);
// the worker installs after load, caches the site, then takes over the page
const controlled = (page) => page.waitForFunction(() =>
  !!navigator.serviceWorker && !!navigator.serviceWorker.controller, null, { timeout: 30000 });
/* The caches there are, by the version at the end of each name. A wait for the caches to
   change polls this with expect.poll: page.waitForFunction takes an async check's promise
   for a truthy answer and returns at once, without waiting for anything. */
const versions = (page) => page.evaluate(() => caches.keys())
  .then((keys) => keys.map((k) => k.split(' ').pop()));
async function offline(context) {
  await context.setOffline(true);
  site.down = true;
}

test('Baseplates opens offline, with the drawer in its address', async ({ page, context }) => {
  const errors = watch(page);
  // the layout can only come from the address: nothing this browser saved is there to restore
  await H.forgetSaved(page);
  await page.goto(site.base + '#w=333&d=444');
  await platesReady(page);
  expect(await page.inputValue('#drawerW')).toBe('333');
  await controlled(page);
  const hash = await page.evaluate(() => location.hash);   // as the page wrote it back

  await offline(context);
  const res = await page.reload();
  expect(res.fromServiceWorker()).toBe(true);
  await platesReady(page);                                  // three.js came from the cache too
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  expect(await page.inputValue('#drawerW')).toBe('333');
  expect(await page.inputValue('#drawerD')).toBe('444');

  /* And the other tool, which this browser has never opened: cached when the worker
     installed, not merely kept from a visit. */
  const bins = await page.goto(site.base + 'bins/#w=333&d=444&bl=0-0-2-1-3');
  expect(bins.fromServiceWorker()).toBe(true);
  await binsReady(page);
  expect(await binCount(page)).toBe(1);
  expect(await page.evaluate(() => [B()[0].u, B()[0].v])).toEqual([2, 1]);
  expect(errors).toEqual([]);
});

test('Bins opens offline, with the drawer in its address', async ({ page, context }) => {
  const errors = watch(page);
  await H.forgetSaved(page);
  await page.goto(site.base + 'bins/#bl=0-0-1-1-3_1-0-2-2-4');
  await binsReady(page);
  expect(await binCount(page)).toBe(2);
  await controlled(page);
  const hash = await page.evaluate(() => location.hash);

  await offline(context);
  const res = await page.reload();
  expect(res.fromServiceWorker()).toBe(true);
  await binsReady(page);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  expect(await binCount(page)).toBe(2);

  // the guide comes along too, with the layout passing through it as it does online
  await page.goto(site.base + 'guide/split/' + hash);
  await expect(page.locator('h1')).toContainText('GUIDE');
  expect(errors).toEqual([]);
});

/* Online, a page comes from the network rather than the cache, so a fix deployed since
   the last visit shows at once rather than one visit late. The files a page loads do too,
   or a new page could find itself running an old library out of the cache. */
test('online, a page and its files are what the server has now, not the cached copies',
  async ({ page }) => {
    await page.goto(site.base + 'guide/');
    await controlled(page);
    site.files['/guide/'] = '<!doctype html><title>deployed since</title><h1>NEW</h1>';
    site.files['/favicon.svg'] = '<svg xmlns="http://www.w3.org/2000/svg"><!-- new --></svg>';
    const res = await page.reload();
    expect(res.fromServiceWorker()).toBe(true);             // answered through the worker...
    await expect(page.locator('h1')).toHaveText('NEW');     // ...with what the server has now
    expect(await page.evaluate(() => fetch('../favicon.svg').then((r) => r.text())))
      .toContain('<!-- new -->');
  });

/* A page and the scripts it loads have to be one deploy: vendor/three.min.js keeps its
   name across upgrades, so a page from one deploy running another's would fail with
   nothing to say why. There are three places a page or a script can come from — the
   server, the worker's cache, and the copy the browser keeps of what it was last sent,
   which GitHub Pages lets it use for ten minutes without asking — and the browser's copy
   can be a deploy the worker's cache is not: one the visitor saw since, whose own worker
   failed to install or has not finished.

   Two tiny deploys of the guide stand in for the site here, each page saying which deploy
   its script came from. The worker's cache is filled with A; a visit after B is deployed
   leaves the browser holding B for ten minutes, as if B's worker had failed. Each page
   also has a second script it loads only when asked, later(), for a page still loading
   when the connection comes back. */
const deploy = (d) => {
  site.files['/guide/'] = '<!doctype html><title>-</title><script src="../vendor/jszip.min.js"></script>' +
    `<script>document.title = 'page ${d}, script ' + self.deploy;\n` +
    'window.later = () => new Promise((done) => { const s = document.createElement("script");' +
    ` s.src = "../vendor/three.min.js"; s.onload = () => done("page ${d}, script " + self.later);` +
    ' document.head.append(s); });</script>';
  site.files['/vendor/jszip.min.js'] = `self.deploy = '${d}';`;
  site.files['/vendor/three.min.js'] = `self.later = '${d}';`;
};
async function cacheDeployA(page) {
  deploy('A');
  await page.goto(site.base + 'guide/');
  await page.evaluate(() => navigator.serviceWorker.register('../sw.js'));
  await controlled(page);
}

test('offline, a page from the cache gets its scripts from the cache, not the browser\'s copies',
  async ({ page, context }) => {
    await cacheDeployA(page);
    deploy('B');
    site.maxAge = 600;   // as GitHub Pages
    await page.goto(site.base + 'guide/');
    await expect(page).toHaveTitle('page B, script B');

    await offline(context);
    await page.reload();
    await expect(page).toHaveTitle('page A, script A');
    // a page opened offline comes from the cache too, never from the browser's copy
    await page.goto(site.base + 'guide/');
    await expect(page).toHaveTitle('page A, script A');
    // and if the connection comes back while it loads, the rest it loads is still deploy A
    await context.setOffline(false);
    site.down = false;
    expect(await page.evaluate(() => window.later())).toBe('page A, script A');
  });

/* And online, both come from the server now, even while the browser holds copies it is
   allowed to use: a page from the server with a script the browser kept would be the
   same mismatch the other way round. */
test('online, a page and its scripts are what the server has now, even inside the ten minutes',
  async ({ page }) => {
    site.maxAge = 600;
    await cacheDeployA(page);
    deploy('B');
    await page.goto(site.base + 'guide/');
    await expect(page).toHaveTitle('page B, script B');
  });

/* The cache is named for a hash of what it holds, so a deploy that changes anything is a
   new worker, and when it takes over the old cache goes — a visitor's browser does not
   keep every version of a 600 KB three.js it has ever been sent. */
test('a new deploy replaces the old cache rather than adding to it', async ({ page }) => {
  await page.goto(site.base + 'guide/');
  await controlled(page);
  const sw = fs.readFileSync(path.join(H.ROOT, 'sw.js'), 'utf8');
  const version = sw.match(/const VERSION = "([0-9a-f]+)";/)[1];
  expect(await versions(page)).toEqual([version]);

  site.files['/sw.js'] = sw.replace(`"${version}"`, '"0123456789ab"');
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await expect.poll(() => versions(page), { timeout: 30000 }).toEqual(['0123456789ab']);
});

/* The host lets the browser keep anything for ten minutes, so a new worker must not fill
   its cache from the browser's copies, which can be the deploy before. But a file the
   server says has not changed need not be sent again. On GitHub Pages a deploy changes
   every file's ETag, so that is only ever a file asked for twice within one deploy: the
   page the worker installs from and what it loaded, or a failed install tried again. The
   server here hashes the file for its ETag, so the files this deploy leaves alone stand
   in for those. */
test('an install caches each file as the server has it now, without sending again what has not changed',
  async ({ page }) => {
    site.maxAge = 600;                  // as GitHub Pages
    await page.goto(site.base + 'guide/');
    await controlled(page);             // and the browser now holds its own copy of every file
    const sw = fs.readFileSync(path.join(H.ROOT, 'sw.js'), 'utf8');
    const version = sw.match(/const VERSION = "([0-9a-f]+)";/)[1];
    site.files['/sw.js'] = sw.replace(`"${version}"`, '"0123456789ab"');
    site.files['/favicon.svg'] = '<svg xmlns="http://www.w3.org/2000/svg"><!-- deployed since --></svg>';
    site.log = [];
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await expect.poll(() => versions(page), { timeout: 30000 }).toEqual(['0123456789ab']);
    const cached = (rel) => page.evaluate((u) => caches.match(u).then((r) => r.text()), site.base + rel);

    // three.js had not changed: the server was asked, said so, and sent none of it...
    expect(site.log.filter((l) => l.path === '/vendor/three.min.js').map((l) => [!!l.ifNoneMatch, l.status]))
      .toEqual([[true, 304]]);
    // ...and the new cache holds all of it, from the browser's copy
    expect((await cached('vendor/three.min.js')).length)
      .toBe(fs.readFileSync(path.join(H.ROOT, 'vendor/three.min.js'), 'utf8').length);
    // the favicon had changed, and the new cache has the new one, not the browser's copy
    expect(await cached('favicon.svg')).toContain('<!-- deployed since -->');
  });

/* A deploy whose worker never installs: its list names a file the server does not have,
   so one fetch fails while the rest are coming in. The browser keeps the worker it has,
   and the cache the failed one had begun to fill goes with it rather than sitting in the
   visitor's storage until some later install deletes it. */
test('a failed install leaves no cache behind, and the worker before it still opens the site offline',
  async ({ page, context }) => {
    await page.goto(site.base + 'guide/');
    await controlled(page);
    const sw = fs.readFileSync(path.join(H.ROOT, 'sw.js'), 'utf8');
    const version = sw.match(/const VERSION = "([0-9a-f]+)";/)[1];
    site.files['/sw.js'] = sw.replace(`"${version}"`, '"0123456789ab"')
      .replace('const FILES = [', 'const FILES = [\n  "nowhere.js",');
    // asks for the new worker, and waits for the browser to give up on it
    const state = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) =>
      new Promise((resolve) => {
        r.addEventListener('updatefound', () => {
          const w = r.installing;
          w.addEventListener('statechange', () => {
            if (w.state === 'redundant' || w.state === 'activated') resolve(w.state);
          });
        });
        r.update().catch(() => {});
      })));
    expect(state).toBe('redundant');
    expect(await versions(page)).toEqual([version]);

    await offline(context);
    const res = await page.reload();
    expect(res.fromServiceWorker()).toBe(true);
    await expect(page.locator('h1')).toContainText('GUIDE');
  });

test('opened from a file, no worker is registered and nothing is logged', async ({ page }) => {
  const errors = watch(page);
  // count the attempts, however the page might make one
  await page.addInitScript(() => {
    window.__registers = 0;
    const C = window.ServiceWorkerContainer;
    if (C && C.prototype.register) {
      const real = C.prototype.register;
      C.prototype.register = function () { window.__registers++; return real.apply(this, arguments); };
    }
  });
  for (const rel of ['index.html', 'bins/index.html', 'guide/index.html']) {
    await page.goto(pathToFileURL(path.join(H.ROOT, rel)).href);
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.waitForTimeout(500);   // registration waits for load; give it the chance
    expect(await page.evaluate(() => window.__registers), rel).toBe(0);
    expect(await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)),
           rel).toBe(false);
  }
  expect(errors).toEqual([]);
});
