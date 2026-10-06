/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* The site as an installable app: the web manifest, the icons it names, and the service
 * worker that lets the tools open with no connection at all.
 *
 * The tools always kept working offline once they were open, because nothing they need
 * comes from anywhere but this site. What failed was opening one: with no connection the
 * browser had no page to show, and with no manifest there was nothing to install, so the
 * tools could not sit on a home screen or in a dock the way the Gridfinity Layout Tool
 * does.
 *
 * Everything here is generated rather than written by hand, for the same reason the
 * sitemap is. The worker's list of files comes from the page manifest (tools/manifest.js)
 * and from what the built pages themselves load, so a page or a vendored script cannot
 * be added without being cached. Its cache name carries a hash of exactly those bytes and
 * of the worker's own code, so a deploy that changes any of them is a new worker with a
 * new cache, and one that changes none of them is no change at all — which is what keeps
 * `build.js --check` deterministic. The colours come from the page's own tokens in
 * style.css, so the title bar of the installed app is the colour of the header beneath
 * it.
 *
 * build.js writes manifest.webmanifest and sw.js from this, test/ci-sim.js rebuilds both
 * from git's stored bytes with the same functions, and test/app-check.js reads them back.
 *
 * Nothing in here requires anything outside node's own modules, because ci-sim.js copies
 * the committed tools/ files into a temporary folder and requires them from there.
 */
'use strict';
const crypto = require('crypto');

const MANIFEST = 'manifest.webmanifest';
const SW = 'sw.js';
const SW_SOURCE = 'src/sw.js';
const NAME = 'Drawerforge';

/* The icons the manifest names, all drawn from favicon.svg by tools/app-icons.js.
 *
 * 192 and 512 are the two sizes every platform asks for: Android's launcher and splash
 * screen, and the desktop install dialogs, pick between them. The maskable one is the
 * same mark on a full-bleed square with the grid pulled into the middle, because Android
 * crops a maskable icon to whatever shape the launcher uses — circle, squircle, teardrop
 * — and only promises to keep a centred circle 80% of the width across. The plain icons
 * keep the favicon's rounded corners on a transparent ground, which is how a desktop dock
 * expects an icon to look; given only those, Android would shrink one onto a white disc.
 * `size` is what the script renders and what test/app-check.js reads out of the PNG. */
const ICONS = [
  { src: 'icon-192.png', size: 192, purpose: 'any' },
  { src: 'icon-512.png', size: 512, purpose: 'any' },
  { src: 'icon-maskable-512.png', size: 512, purpose: 'maskable' },
];

/* Long-press the installed icon (or right-click it in a dock) and these are offered.
   Keyed by the page's name in tools/manifest.js rather than by URL, so a page that moves
   takes its shortcut with it. */
const SHORTCUTS = [
  { page: 'baseplates', name: 'Baseplates',
    description: 'Size a baseplate to your drawer and split it for your print bed' },
  { page: 'bins', name: 'Bins',
    description: 'Lay out the bins that fill your drawer' },
];

/* The custom properties declared in the stylesheet's :root, as { bg: '#171c22', ... }.
   Read from the CSS rather than repeated here, because a colour kept in two places is
   one that changes in one of them. */
function tokens(css) {
  const root = (css.match(/:root\s*\{([\s\S]*?)\}/) || [, ''])[1];
  const out = {};
  for (const m of root.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/* The page's colour for the browser's own chrome: the header ground, which is --bg. */
function themeColor(css) {
  const bg = tokens(css).bg;
  if (!/^#[0-9a-f]{3,8}$/i.test(bg || ''))
    throw new Error(`style.css declares no --bg colour in :root to give the app (found ${JSON.stringify(bg)})`);
  return bg;
}

/* Where a page is served, relative to the site root: '' for the home page would resolve
   to sw.js itself rather than to the folder it sits in, so the root is './'. */
const pagePath = (out) => out.replace(/index\.html$/, '') || './';

/* The web manifest.
 *
 * start_url and scope are written relative to the manifest — "./" — which a browser
 * resolves against the manifest's own address. On drawerforge.co.uk that is exactly "/".
 * Written relatively for the same reason the icon links are: a fork served from
 * someone.github.io/drawerforge/ gets an app scoped to its own folder rather than one
 * that claims the whole of someone.github.io and opens the wrong page when launched.
 *
 * No "id": it defaults to start_url, which is what it would be set to anyway, and an id
 * set now could never be changed without every installed copy becoming a different app. */
function webManifest(pages, css, description) {
  const colour = themeColor(css);
  const shortcuts = SHORTCUTS.map((s) => {
    const p = pages.find((x) => x.name === s.page);
    if (!p) throw new Error(`the app shortcut "${s.name}" names page "${s.page}", which tools/manifest.js does not have`);
    return { name: s.name, short_name: s.name, description: s.description, url: pagePath(p.out) };
  });
  const m = {
    name: NAME,
    short_name: NAME,
    description,
    lang: 'en',
    dir: 'ltr',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: colour,
    theme_color: colour,
    icons: ICONS.map((i) => ({ src: i.src, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: i.purpose })),
    shortcuts,
  };
  return JSON.stringify(m, null, 2) + '\n';   // LF on every platform, as the sitemap is
}

/* The manifest link and the theme colour, for the page built to `out`. They go in beside
   the icon links tools/seo.js writes, and the link climbs back to the root the same way
   those do. The colour is read from the page's own stylesheet, which by now has been
   spliced into it. */
function tags(html, out) {
  const up = '../'.repeat(out.split('/').length - 1);
  const anchor = /<link rel="apple-touch-icon"[^>]*>/;
  if (!anchor.test(html))
    throw new Error(`${out}: no apple-touch-icon link to put the manifest link beside — run seo.share() first`);
  const add = `<link rel="manifest" href="${up}${MANIFEST}">\n` +
              `<meta name="theme-color" content="${themeColor(html)}">`;
  return html.replace(anchor, (m) => m + '\n' + add);   // LF, for the reason in seo.inject()
}

/* Every file the pages load from this site, as paths from the root: scripts, the icon
   and manifest links, images (img src, and srcset on an img or a picture's source), and
   anything a style block or a style attribute names with url(). Read from the built page
   rather than listed, so a script tag or an image added to a template is cached without
   anyone remembering to say so — and a page that opened offline without its three.js
   would be worse than one that did not open.

   The inline scripts are left out of the reading: an <img> or a url() in a script's
   string is not something the page loads as it opens, and what it would load is not a
   path that can be read from here. A url() inside a linked stylesheet would be relative
   to the stylesheet rather than the page, and is not followed: the pages carry their
   styles inline. */
function subresources(html, out) {
  const base = 'https://site.invalid/' + out;
  const found = [];
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>');
  // an attribute's value in a tag, '' when it has none; `\s` first, so src is not data-src
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
  };
  const css = [
    ...[...markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]),
    ...[...markup.matchAll(/<[a-z][^>]*>/gi)].map((m) => attr(m[0], 'style')),
  ];
  const refs = [
    ...[...markup.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...markup.matchAll(/<link\b[^>]*>/gi)]
      .filter((m) => /\brel\s*=\s*["'](icon|apple-touch-icon|manifest|stylesheet|preload|modulepreload)["']/i.test(m[0]))
      .map((m) => (m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [, ''])[1]),
    ...[...markup.matchAll(/<img\b[^>]*>/gi)].map((m) => attr(m[0], 'src')),
    /* A srcset is candidates split by commas, each a URL and then what it is for ("2x",
       "800w"). A URL can hold a comma itself — a data: URL always does — so a candidate
       starts only at a comma that follows the URL before it, never at one inside it. */
    ...[...markup.matchAll(/<(?:img|source)\b[^>]*>/gi)]
      .flatMap((m) => [...attr(m[0], 'srcset').matchAll(/(?:^|,)\s*(\S*[^\s,])/g)].map((c) => c[1])),
    ...css.flatMap((t) => [...t.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/gi)]
      .map((m) => m[1] || m[2] || m[3])),
  ];
  for (const ref of refs) {
    if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;   // another origin, data:, or a fragment
    const u = new URL(ref, base);
    if (u.origin !== 'https://site.invalid') continue;
    found.push(decodeURIComponent(u.pathname.slice(1)));
  }
  return found;
}

/* What the worker caches when it installs, in a fixed order: every page in the manifest,
   then everything those pages load, then the app's icons and the manifest. `read(rel)`
   returns the bytes of a file by its path from the root. */
function precache(pages, read) {
  const assets = new Set();
  for (const p of pages) for (const r of subresources(String(read(p.out)), p.out)) assets.add(r);
  for (const i of ICONS) assets.add(i.src);
  assets.add(MANIFEST);
  return pages.map((p) => pagePath(p.out)).concat([...assets].sort());
}

/* The file behind a precache entry: a page's URL is its folder, its file the index.html
   in it. */
const fileFor = (entry) => entry === './' ? 'index.html' : entry.endsWith('/') ? entry + 'index.html' : entry;

/* A short hash of everything the worker caches, names and bytes both, and of the worker's
   own code, `worker`: sw.js exactly as it will be served, file list and all, with only
   its version still to be filled in. Any change to any of them is a different cache; no
   change is the same one.

   The code is in it because a cache must belong to one worker only. Without it, a deploy
   that changed the worker and nothing else would install the new worker into the very
   cache the old one is still serving from, and a new worker whose install fails deletes
   its own cache — which would then be the old worker's, and the site would stop opening
   offline until the next good install. It is the served text rather than src/sw.js
   because that is what the browser compares: the list written another way here, with the
   same files and the same source, is a new worker to the browser, and must not be the
   same cache. */
function version(files, read, worker) {
  const h = crypto.createHash('sha256');
  const code = Buffer.from(worker);
  h.update(SW + '\n' + code.length + '\n');
  h.update(code);
  for (const f of files) {
    const b = Buffer.from(read(fileFor(f)));
    h.update(f + '\n' + b.length + '\n');
    h.update(b);
  }
  return h.digest('hex').slice(0, 12);
}

/* sw.js, from src/sw.js with the version and the file list filled in. The markers are
   comments in front of valid placeholders, so the source parses and can be syntax-checked
   on its own.

   The list goes in first and the version last, because the version is a hash of the text
   it goes into: everything in sw.js but itself. The version's own marker is still in
   that text when it is hashed, and test/app-check.js puts it back to check the hash. */
function serviceWorker(source, pages, read) {
  const files = precache(pages, read);
  for (const marker of ["/*__VERSION__*/''", '/*__FILES__*/[]'])
    if (!source.includes(marker)) throw new Error(`${SW_SOURCE} is missing the ${marker} marker`);
  const list = '[\n' + files.map((f) => '  ' + JSON.stringify(f) + ',').join('\n') + '\n]';
  const unversioned = source.replace('/*__FILES__*/[]', () => list);
  const v = version(files, read, unversioned);
  return unversioned.replace("/*__VERSION__*/''", () => JSON.stringify(v));
}

module.exports = { MANIFEST, SW, SW_SOURCE, NAME, ICONS, SHORTCUTS, tokens, themeColor,
                   pagePath, webManifest, tags, subresources, precache, fileFor, version,
                   serviceWorker };
