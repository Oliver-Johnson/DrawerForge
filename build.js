#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Drawerforge build — splices sources into one self-contained HTML file per tool.
 *
 * The single self-contained HTML file is a deliberate product feature (offline use,
 * trivial hosting), so the sources live apart and the shipped artifacts are generated.
 *
 * Checks that must pass before anything is written (each has caught a shipped bug):
 *   1. syntax  — node --check on every JS source
 *   2. id      — every $('id') referenced in a tool's ui.js exists in its template
 *   3. display — every id hidden with style="display:none" in a template is
 *                un-hidden somewhere in that tool's ui.js, or it is dead UI
 *
 * Usage:  node build.js            build every tool
 *         node build.js --check    verify outputs are up to date, write nothing
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const checkOnly = process.argv.includes('--check');

/* Every page, its template and the sources spliced into it, live in tools/manifest.js
   — shared with test/ci-sim.js, which splices the same parts from git's stored bytes,
   and with the sitemap. A second copy of this list has drifted twice. */
const TOOLS = require('./tools/manifest.js');

const seo = require('./tools/seo.js');
const generated = require('./tools/generated.js');
/* Everything the build reads is LF, so everything it writes is LF, so the bytes
   written are the bytes git stores are the bytes a checkout produces — on every
   platform. .gitattributes pins the checkout, which normally makes this a no-op; it
   earns its keep when a file arrives in the working tree some other way, from an
   editor that saves CRLF or a paste into a new source file. Without it the built page
   inherits its line endings from whatever produced its inputs, and `--check` reports a
   page as stale over bytes that carry no content. The comparison below is deliberately
   NOT normalised: the committed artifact has to be exactly these bytes. */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const fail = (msg, detail) => {
  console.error('\n  BUILD FAILED: ' + msg);
  if (detail) for (const d of detail) console.error('    - ' + d);
  console.error('');
  process.exit(1);
};

/* ---- 1. syntax ---------------------------------------------------------- */
const syntaxChecked = new Set();
function syntaxCheck(rel, source) {
  if (syntaxChecked.has(rel)) return;
  syntaxChecked.add(rel);
  const tmp = path.join(os.tmpdir(), `drawerforge-${process.pid}-${rel.replace(/[\\/]/g, '_')}`);
  fs.writeFileSync(tmp, source);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax error in ${rel}`, String(e.stderr || e.message).trim().split('\n'));
  } finally {
    fs.unlinkSync(tmp);
  }
}

const MARK = (name) => new RegExp(`[ \\t]*\\r?\\n?/\\*__${name}__\\*/[ \\t]*\\r?\\n?`);
let stale = 0;

for (const tool of TOOLS) {
  const template = read(tool.template);
  const sources = {};
  for (const [marker, rel] of Object.entries(tool.parts)) {
    sources[marker] = read(rel);
    if (rel.endsWith('.js')) syntaxCheck(rel, sources[marker]);
    if (!MARK(marker).test(template))
      fail(`${tool.template} is missing the /*__${marker}__*/ marker`);
  }

  /* ---- 2. id audit ------------------------------------------------------ */
  const ui = sources[tool.uiPart] || '';
  const templateIds = new Set();
  for (const m of template.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) templateIds.add(m[1]);
  const referenced = new Map();
  for (const m of ui.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g))
    referenced.set(m[1], (referenced.get(m[1]) || 0) + 1);
  const missing = [...referenced.keys()].filter((id) => !templateIds.has(id));
  if (missing.length)
    fail(`[${tool.name}] ui references ${missing.length} id(s) absent from ${tool.template}`,
         missing.map((id) => `$('${id}')  — referenced ${referenced.get(id)}x`));

  /* ---- 3. display-reachability audit ------------------------------------ */
  const hidden = [];
  for (const m of template.matchAll(/<[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/g))
    if (/style\s*=\s*["'][^"']*display\s*:\s*none/i.test(m[0])) hidden.push(m[1]);
  const unreachable = hidden.filter((id) => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`['"]${esc}['"][^\\n]*\\)\\s*\\.style\\.display`).test(ui);
  });
  if (unreachable.length)
    fail(`[${tool.name}] ${unreachable.length} element(s) are display:none and never un-hidden`,
         unreachable.map((id) => `#${id} — unreachable in the UI; un-hide it or remove it`));

  /* ---- 4. no third-party subresources ----------------------------------- */
  /* Every page tells the visitor that nothing is uploaded and nothing is tracked.
     That was true of the code and not of the page: two script tags pointed at
     cdnjs, so a third party saw every visitor's IP on load. The libraries are
     vendored now, and this stops a CDN URL coming back by habit and quietly making
     the promise untrue again. Links are fine — a link is the visitor's choice. */
  const external = [...template.matchAll(/<(script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["'][^>]*>/gi)]
    .filter((m) => !/rel\s*=\s*["'](canonical|alternate)["']/i.test(m[0]))
    .map((m) => m[0].slice(0, 110));
  if (external.length)
    fail(`[${tool.name}] ${external.length} third-party subresource(s) in ${tool.template}`,
         external.concat(['vendor it under vendor/ and reference it relatively']));

  /* ---- splice ----------------------------------------------------------- */
  let out = template;
  for (const marker of Object.keys(tool.parts))
    out = out.replace(MARK(marker), () => sources[marker]);
  /* The generated content -- the FAQ markup and the joint diagrams -- is applied by
     tools/generated.js, which test/ci-sim.js also calls. Two lists of build steps kept
     in two places is what made ci-sim report a stale page three separate times. */
  out = generated(out, require('./src/core.js'));

  const outPath = path.join(ROOT, tool.out);
  if (checkOnly) {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    if (current !== out) {
      console.error(`  STALE: ${tool.out} does not match src/ — run \`node build.js\``);
      stale++;
    } else {
      console.log(`  ${tool.out} up to date (${out.length} bytes)`);
    }
    continue;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  console.log(`  built ${tool.out.padEnd(16)} ${String(out.length).padStart(7)} bytes` +
              `   ids: ${referenced.size} referenced / ${templateIds.size} present`);
}

/* The sitemap is generated from the page manifest, so adding a page cannot forget to
   list it. It carries no dates on purpose — see tools/seo.js. */
{
  const xml = seo.sitemap(TOOLS);
  const smPath = path.join(ROOT, 'sitemap.xml');
  const current = fs.existsSync(smPath) ? fs.readFileSync(smPath, 'utf8') : '';
  if (checkOnly) {
    if (current !== xml) {
      console.error('  STALE: sitemap.xml does not match the built pages — run `node build.js`');
      stale++;
    } else {
      console.log(`  sitemap.xml up to date (${TOOLS.length} urls)`);
    }
  } else if (current !== xml) {
    fs.writeFileSync(smPath, xml);
    console.log(`  wrote sitemap.xml    ${TOOLS.length} urls`);
  }
}

if (checkOnly && stale) {
  fail(`${stale} output(s) out of date with src/ — run \`node build.js\` and commit the result`);
}
