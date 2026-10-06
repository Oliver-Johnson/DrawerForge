#!/usr/bin/env node
/* Can the site still be installed, and does the service worker still cache the site?
 *
 * Every way this breaks is quiet. A manifest field a browser needs goes missing and the
 * install option simply never appears; an icon is redrawn at the wrong size and a home
 * screen shows it blurred or on a white disc; a page is added to tools/manifest.js and
 * the worker never caches it, so that one page fails offline and nothing else does. None
 * of that shows on the site as anyone loads it online, so it is checked here, on every
 * push, from the committed files.
 *
 * `build.js --check` already proves manifest.webmanifest and sw.js are what the sources
 * make. This checks that what they make is right. test/ui/offline.spec.js drives the
 * worker itself in a browser.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = require('../tools/app.js');
const seo = require('../tools/seo.js');
const pages = require('../tools/manifest.js');

const ROOT = path.join(__dirname, '..');
let bad = 0;
const check = (what, ok, detail) => {
  console.log(`  ${what.padEnd(68)}${ok ? 'ok' : `WRONG — ${detail}`}`);
  if (!ok) bad++;
};
const file = (rel) => path.join(ROOT, rel);
// the PNG's own size, from its IHDR chunk, rather than trusted from anything that names it
const pngSize = (f) => {
  const b = fs.readFileSync(f);
  return b.slice(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
};

console.log('the web manifest');
let m = {};
try {
  m = JSON.parse(fs.readFileSync(file(app.MANIFEST), 'utf8'));
  check(`${app.MANIFEST} parses`, true);
} catch (e) {
  check(`${app.MANIFEST} parses`, false, e.message);
}
/* Its URLs are relative to where it is served, as a browser resolves them; on this site
   that is the root. */
const MANIFEST_URL = seo.SITE + app.MANIFEST;
const resolve = (u) => { try { return new URL(u, MANIFEST_URL).href; } catch (e) { return null; } };
check('name is Drawerforge', m.name === 'Drawerforge', `says ${JSON.stringify(m.name)}`);
/* A launcher label is cut off at about twelve characters, and an app called "Drawerfo…"
   on someone's home screen is a worse first impression than any missing feature. */
check('short_name fits under a home-screen icon (12 characters)',
      typeof m.short_name === 'string' && m.short_name.length > 0 && m.short_name.length <= 12,
      `says ${JSON.stringify(m.short_name)}`);
check('description is the site\'s own one-line description',
      m.description === require('../package.json').description, `says ${JSON.stringify(m.description)}`);
check('display is standalone', m.display === 'standalone', `says ${JSON.stringify(m.display)}`);
check(`start_url opens ${seo.SITE}`, resolve(m.start_url) === seo.SITE, `resolves to ${resolve(m.start_url)}`);
check(`scope is the whole site, ${seo.SITE}`, resolve(m.scope) === seo.SITE, `resolves to ${resolve(m.scope)}`);
check('start_url is inside the scope',
      !!resolve(m.start_url) && !!resolve(m.scope) && resolve(m.start_url).startsWith(resolve(m.scope)));

/* The colours are the page's own: the installed app's title bar and splash screen are
   the header's colour, and a token changed in the stylesheet changes them too. */
const bg = app.tokens(fs.readFileSync(file('src/shared-ui/style.css'), 'utf8')).bg;
check(`theme_color is the page's --bg, ${bg}`, m.theme_color === bg, `says ${m.theme_color}`);
check(`background_color is the page's --bg, ${bg}`, m.background_color === bg, `says ${m.background_color}`);

console.log('\nits icons, at the size it claims for each');
const icons = Array.isArray(m.icons) ? m.icons : [];
const has = (size, purpose) => icons.some((i) => i.sizes === `${size}x${size}` &&
  (i.purpose || 'any').split(/\s+/).includes(purpose) && i.type === 'image/png');
// what Chrome asks for before it offers to install, and what Android crops to its own shape
check('a 192 × 192 PNG icon', has(192, 'any'), 'missing');
check('a 512 × 512 PNG icon', has(512, 'any'), 'missing');
check('a maskable icon', icons.some((i) => (i.purpose || '').split(/\s+/).includes('maskable')), 'missing');
for (const i of icons) {
  const rel = resolve(i.src) && resolve(i.src).startsWith(seo.SITE) ? resolve(i.src).slice(seo.SITE.length) : null;
  const size = rel && fs.existsSync(file(rel)) ? pngSize(file(rel)) : null;
  const claimed = String(i.sizes).split('x').map(Number);
  check(`${i.src} is a ${i.sizes} PNG (${i.purpose})`,
        !!size && size[0] === claimed[0] && size[1] === claimed[1],
        !rel ? 'not on this site' : !size ? 'missing, or not a PNG — run tools/app-icons.js'
          : `it is ${size[0]} × ${size[1]}`);
}

console.log('\nits shortcuts');
const shortcuts = Array.isArray(m.shortcuts) ? m.shortcuts : [];
for (const [name, page] of [['Baseplates', 'baseplates'], ['Bins', 'bins']]) {
  const s = shortcuts.find((x) => x.name === name);
  const want = seo.urlFor(pages.find((p) => p.name === page).out);
  check(`"${name}" opens ${want}`, !!s && resolve(s.url) === want,
        s ? `opens ${resolve(s.url)}` : 'no such shortcut');
}

console.log('\nevery page links the manifest and carries the theme colour');
for (const p of pages) {
  const html = fs.readFileSync(file(p.out), 'utf8');
  const href = (html.match(/<link rel="manifest" href="([^"]*)"/) || [, null])[1];
  // relative, so it is fetched from wherever the page is served — a fork, or this site
  const target = href && path.join(ROOT, path.dirname(p.out), href);
  check(`${p.out} manifest link`,
        !!href && !/^(https?:)?\/\//.test(href) && target === file(app.MANIFEST),
        href ? `points at ${href}` : 'no manifest link');
  const tc = (html.match(/<meta name="theme-color" content="([^"]*)"/) || [, null])[1];
  check(`${p.out} theme-color`, tc === m.theme_color, `says ${tc}`);
}

console.log('\nthe service worker');
const swText = fs.existsSync(file(app.SW)) ? fs.readFileSync(file(app.SW), 'utf8') : '';
check(`${app.SW} exists at the root, so its scope is the whole site`, !!swText, 'missing — run `node build.js`');
/* VERSION and FILES are read by running the script, with just enough of a worker's
   surroundings for it to start, rather than by pattern-matching its text. */
let sw = { VERSION: null, FILES: [] };
try {
  const self = { registration: { scope: seo.SITE }, location: new URL(app.SW, seo.SITE),
                 addEventListener() {}, clients: {} };
  sw = vm.runInNewContext(swText + '\n;({ VERSION, FILES })', { self, URL, caches: {} });
  check('it runs, and names its version and files', typeof sw.VERSION === 'string' && Array.isArray(sw.FILES));
} catch (e) {
  check('it runs, and names its version and files', false, e.message);
}
const files = sw.FILES || [];
const pageEntries = files.filter((f) => f.endsWith('/'));
const wantPages = pages.map((p) => app.pagePath(p.out));
check(`it caches exactly the ${wantPages.length} pages in tools/manifest.js`,
      JSON.stringify([...pageEntries].sort()) === JSON.stringify([...wantPages].sort()),
      `caches ${JSON.stringify(pageEntries)}`);
check('nothing it caches is on another site',
      files.every((f) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(f)),
      files.filter((f) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(f)).join(', '));
const missing = files.filter((f) => !fs.existsSync(file(app.fileFor(f))));
check('every file it caches exists', missing.length === 0, missing.join(', '));
check('it caches the manifest and every icon the manifest names',
      [app.MANIFEST, ...icons.map((i) => i.src)].every((f) => files.includes(f)),
      [app.MANIFEST, ...icons.map((i) => i.src)].filter((f) => !files.includes(f)).join(', '));

/* What a page needs to open, it must have cached: a tool offline without its three.js is
   a blank page, which is worse than the browser's own offline message. */
for (const p of pages) {
  const needs = app.subresources(fs.readFileSync(file(p.out), 'utf8'), p.out);
  const absent = needs.filter((n) => !files.includes(n));
  check(`${p.out}: everything it loads is cached (${needs.length})`, absent.length === 0,
        `not cached: ${absent.join(', ')}`);
}

/* What a page loads is read from the page, so an image added to one some day is cached
   without anyone remembering to list it. No page has an image or a CSS url() yet, so the
   reading is checked on a page made up for it: each way an image can be loaded, and each
   thing that looks like one but loads nothing from this site. */
const madeUp = [
  '<style>.a{background:url(../../img/bg.png)} .b{src:url( "fonts/f.woff2" )} .c{mask:url(#m)}',
  '  .d{background:url(data:image/png;base64,AAAA)} .e{background:url(https://cdn.example/x.png)}</style>',
  '<div style="background:url(\'../../tile.svg\')"></div>',
  '<img src="../../photo.jpg" alt="">',
  '<img alt="" srcset="../../a-1x.png 1x, ../../a-2x.png 2x" src="../../a-1x.png">',
  '<picture><source srcset="../../wide.webp 800w,../../narrow.webp 400w"><img src="../../narrow.webp"></picture>',
  '<img srcset="data:image/png;base64,iVBOR, ../../c.png 2x" src="data:image/gif;base64,R0lGOD">',
  '<img data-src="../../not-yet.png" src="../../shown.png">',
  '<script>const s = \'<img src="../../in-a-string.png">\' + "url(../../also-a-string.png)";</script>',
].join('\n');
const madeUpWants = ['a-1x.png', 'a-2x.png', 'c.png', 'guide/x/fonts/f.woff2', 'img/bg.png', 'narrow.webp',
                     'photo.jpg', 'shown.png', 'tile.svg', 'wide.webp'];
const madeUpGot = [...new Set(app.subresources(madeUp, 'guide/x/index.html'))].sort();
check('it finds the images a page loads: img src and srcset, CSS url()',
      JSON.stringify(madeUpGot) === JSON.stringify(madeUpWants), `found ${JSON.stringify(madeUpGot)}`);

/* The cache name is a hash of the cached files and of sw.js itself, so a deploy that
   changes any of them replaces the old cache rather than serving it. Recomputed here from
   the files on disk and from sw.js as it is served, with its own version taken back out
   (the version cannot be a hash of a text that holds it), and then again with one byte of
   one page different, which must not give the same.

   And again with one byte of the worker different and nothing else. A worker whose
   install fails deletes its cache; if a change to the worker alone kept the cache's name,
   the cache it deleted would be the one the worker before it is still serving. That is
   any change to sw.js as served, not only to src/sw.js: the file list written another
   way is a different worker too. */
const read = (rel) => fs.readFileSync(file(rel));
const code = swText.replace(JSON.stringify(sw.VERSION), () => "/*__VERSION__*/''");
const v = app.version(files, read, code);
check(`its version ${sw.VERSION} hashes what it caches and sw.js itself`, sw.VERSION === v,
      `they hash to ${v}`);
const touched = app.version(files, (rel) => rel === 'index.html'
  ? Buffer.concat([read(rel), Buffer.from(' ')]) : read(rel), code);
check('a one-byte change to a page is a new version', touched !== v, 'the version did not change');
check('a change to the worker alone is a new version, so a new cache',
      app.version(files, read, code + ' ') !== v, 'the version did not change');

console.log('\nneither is a page, so neither is in the sitemap');
const sitemap = fs.readFileSync(file('sitemap.xml'), 'utf8');
for (const rel of [app.SW, app.MANIFEST])
  check(`${rel} is not in sitemap.xml`, !sitemap.includes(seo.SITE + rel), 'listed as a page');

console.log(bad ? `\n${bad} PROBLEM${bad === 1 ? '' : 'S'}` : '\nthe app installs and caches the site');
process.exit(bad ? 1 : 0);
