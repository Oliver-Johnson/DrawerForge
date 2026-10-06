/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* The service worker: what lets the tools open with no connection.
 *
 * sw.js at the site root is generated from src/sw.js by build.js, which fills in VERSION
 * and FILES (see tools/app.js). Edit src/sw.js and rebuild; never the copy at the root.
 *
 * The cache holds one deploy: every page, everything the pages load, and the app's icons
 * and manifest, fetched together when the worker installs and never written to again.
 * A deploy that changes any of those files changes the hash in sw.js, so the browser
 * installs a new worker with a new cache the next time a page is opened, and the old
 * cache is deleted when the new worker takes over.
 *
 * Online, everything comes from the network, exactly as it would with no worker, so a fix
 * shows the moment it is deployed rather than one visit late. The cache is only the
 * answer when the network gives none. That applies to the scripts as well as the pages:
 * vendor/three.min.js keeps its name across upgrades, and a library served from the
 * cache beside a page served from the network would put a new page with an old three.js
 * for the one visit between a deploy and the new worker taking over.
 *
 * A request to another site, or for anything this site did not cache, is never answered
 * here at all. The browser handles it as it would without a worker, and nothing from
 * another site is ever stored.
 *
 * It is registered by src/shared-ui/chrome.js, only over http(s): a page opened from a
 * file has no origin to register a worker on, and works offline anyway.
 */
'use strict';

/* Filled in by build.js. FILES is every page in tools/manifest.js, everything those pages
   load from this site, and the app's icons and manifest, as paths from the root. VERSION
   is a hash of all of those files, names and bytes. */
const VERSION = "edc333880cfc";
const FILES = [
  "./",
  "bins/",
  "guide/",
  "guide/split/",
  "guide/drawer-sizes/",
  "apple-touch-icon.png",
  "favicon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "manifest.webmanifest",
  "vendor/jszip.min.js",
  "vendor/three.min.js",
];

/* The cache's name carries the scope as well as the version. Caches belong to an origin,
   not to a folder, and a fork served from someone.github.io/drawerforge/ shares its origin
   with everything else that person publishes — deleting "every cache but mine" there
   would empty other sites' caches. So only caches with this worker's own prefix are
   ever deleted. */
const PREFIX = 'drawerforge ' + self.registration.scope + ' ';
const CACHE = PREFIX + VERSION;

// relative to this script, so the worker is right wherever the site is served from
const ROOT = new URL('./', self.location).href;
const URLS = FILES.map((f) => new URL(f, ROOT).href);
const PAGES = new Set(URLS.filter((u) => u.endsWith('/')));
const ASSETS = new Set(URLS.filter((u) => !u.endsWith('/')));

/* A response that arrived through a redirect cannot be used to answer a navigation in
   Safari, which refuses the page outright. Nothing here is expected to redirect, but a
   host that adds a slash or moves a folder would otherwise break the offline page in one
   browser only, so the body is stored without the redirect attached. */
const plain = (r) => (r.redirected
  ? r.blob().then((b) => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers }))
  : Promise.resolve(r));

self.addEventListener('install', (e) => {
  /* All or nothing: one file that fails fails the install, and the browser tries again on
     the next visit. A half-filled cache would open a tool offline with no three.js in it,
     which is worse than the browser's own message that it is offline. */
  e.waitUntil(caches.open(CACHE).then((cache) => Promise.all(URLS.map((u) =>
    /* cache: 'reload' goes past the browser's HTTP cache. GitHub Pages lets anything be
       cached for ten minutes, so without it a worker installed just after a deploy could
       fill its new cache with the previous deploy's files. */
    fetch(new Request(u, { cache: 'reload' })).then((r) => {
      if (!r.ok) throw new Error(u + ' answered ' + r.status);
      return plain(r).then((p) => cache.put(u, p));
    }))))
    /* Straight to active rather than waiting for every tab to close. The pages hold
       everything they need once loaded and ask this worker for nothing afterwards, so an
       open page loses nothing by the cache under it changing. */
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith(PREFIX) && k !== CACHE)
      .map((k) => caches.delete(k))))
    // and look after the page that registered it, so it opens offline from the first visit
    .then(() => self.clients.claim()));
});

/* Which cached file answers a request, or null for one this worker leaves alone.
 *
 * The layout is in the fragment, and the fragment is never sent to a server: the address
 * /bins/#w=420&… asks the server for /bins/. The worker's own copy of the request does
 * carry the fragment, though, so it is dropped here before the lookup — otherwise every
 * layout would be a page the cache has never seen, and the tools would open offline only
 * when opened bare. For a page the query string goes the same way, and /bins/index.html
 * is the same page as /bins/. */
function cachedAs(req) {
  const u = new URL(req.url);
  u.hash = '';
  if (req.mode !== 'navigate') return ASSETS.has(u.href) ? u.href : null;
  u.search = '';
  if (u.pathname.endsWith('/index.html')) u.pathname = u.pathname.slice(0, -'index.html'.length);
  return PAGES.has(u.href) ? u.href : null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // never another site's
  const key = cachedAs(req);
  if (!key) return;
  /* The network's answer whatever it is, a 404 included: it answered. The cache only
     when it did not, and if the browser has evicted that too, its own offline page. */
  e.respondWith(fetch(req).catch(() => caches.open(CACHE)
    .then((c) => c.match(key))
    .then((hit) => hit || Response.error())));
});
