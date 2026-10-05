#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Tell IndexNow which pages changed.
 *
 * IndexNow is a ping, not an upload: you name URLs that have changed and the engines
 * that use it (Bing, Yandex, Seznam, Naver, Yep — not Google) come and fetch them
 * sooner than their own schedule would have. So it is worth exactly as much as the
 * accuracy of the list, and submitting pages that did not change is what the protocol
 * asks you not to do. This works out the list from the push rather than sending all
 * five URLs every time.
 *
 * The key is read from the verification file at the repo root, never written here.
 * The whole protocol rests on the key in the request matching the file served at
 * https://drawerforge.co.uk/<key>.txt, and the classic way to break it is to rotate one
 * and not the other — which fails with a 403 in a CI log nobody reads, weeks after the
 * change that caused it. Deriving both from the same file makes that impossible, and
 * test/indexnow-check.js checks the file's name and its contents agree.
 *
 * Usage:
 *   node tools/indexnow.js <changed-file> [...]     submit the pages among them
 *   node tools/indexnow.js --all                    submit every page
 *   node tools/indexnow.js --dry-run <files...>     print the payload, send nothing
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pages = require('./manifest.js');
const seo = require('./seo.js');

const ROOT = path.join(__dirname, '..');
const ENDPOINT = 'https://api.indexnow.org/indexnow';

/* The key file is <key>.txt at the site root. Matched by shape rather than by name so
   that rotating the key means dropping in a new file and deleting the old one, with
   nothing here to update — and so robots.txt and llms.txt, which also sit at the root,
   cannot be mistaken for it. */
function readKey() {
  const found = fs.readdirSync(ROOT).filter((f) => /^[0-9a-f]{8,128}\.txt$/i.test(f));
  if (found.length !== 1)
    throw new Error(found.length
      ? `expected one IndexNow key file at the repo root, found ${found.length}: ${found.join(', ')}`
      : 'no IndexNow key file at the repo root — expected <key>.txt of 8-128 hex characters');
  const key = found[0].replace(/\.txt$/i, '');
  const body = fs.readFileSync(path.join(ROOT, found[0]), 'utf8').trim();
  if (body !== key)
    throw new Error(`${found[0]} must contain exactly its own key; it contains ${JSON.stringify(body)}`);
  return { key, file: found[0] };
}

/* Which published URLs a set of changed files affects. A page is republished when its
   own built file changes -- and the built files are what git tracks, so a source edit
   that did not change the output correctly submits nothing. */
function urlsFor(changed) {
  const set = new Set();
  for (const p of pages)
    if (changed.some((f) => f.replace(/\\/g, '/') === p.out)) set.add(seo.urlFor(p.out));
  return [...set];
}

const allUrls = () => pages.map((p) => seo.urlFor(p.out));

async function main(argv) {
  const dry = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  const urls = rest.includes('--all') ? allUrls() : urlsFor(rest);

  if (!urls.length) {
    console.log('no published page changed — nothing to submit');
    return 0;
  }
  const { key, file } = readKey();
  const payload = {
    host: new URL(seo.SITE).host,
    key,
    keyLocation: seo.SITE + file,
    urlList: urls,
  };
  console.log(`submitting ${urls.length} URL${urls.length === 1 ? '' : 's'}:`);
  for (const u of urls) console.log('  ' + u);

  if (dry) { console.log('\n--dry-run: not sending\n' + JSON.stringify(payload, null, 2)); return 0; }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const body = await res.text().catch(() => '');
  console.log(`IndexNow responded ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 300) : ''}`);

  /* 429 is the one refusal that means nothing is wrong: too many submissions, come back
     later. Failing the run for it would put a red cross on main for having pushed twice
     in an hour, and the next real 403 would be read as more of the same. */
  if (res.status === 429) {
    console.log('rate limited — nothing is broken, the next push will carry these URLs');
    return 0;
  }
  /* 200 accepted, 202 accepted with the key still to be validated. Anything else is a
     real failure and worth breaking the run for: a submission that silently 403s because
     the key file never deployed looks exactly like a working integration. */
  if (res.status !== 200 && res.status !== 202) {
    console.error('IndexNow rejected the submission');
    return 1;
  }
  return 0;
}

if (require.main === module)
  main(process.argv.slice(2)).then((c) => process.exit(c),
    (e) => { console.error(String(e.message || e)); process.exit(1); });

module.exports = { readKey, urlsFor, allUrls };
