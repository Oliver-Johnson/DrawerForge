#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* The installed app's icons, drawn from favicon.svg.
 *
 *   icon-192.png            192 × 192, the mark as the tab shows it, corners transparent
 *   icon-512.png            512 × 512, the same, for splash screens and install dialogs
 *   icon-maskable-512.png   512 × 512, full bleed, the grid inside Android's safe circle
 *
 * The list, and the size each is promised at, is tools/app.js's ICONS: the manifest is
 * written from it and test/app-check.js reads each PNG's real size back against it.
 * Rendered rather than drawn by hand so the icon cannot drift from the favicon — change
 * favicon.svg and rerun:
 *
 *   node tools/app-icons.js && node build.js
 *
 * The build has to follow, because the service worker's cache name is a hash of what it
 * caches and the icons are part of that.
 *
 * Like tools/social-image.js this needs the dev dependencies, because it drives a real
 * browser. Set CHROMIUM to an executable to use another one. Nothing here is text, so
 * unlike the link-preview card the output does not depend on the machine's fonts.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const app = require('./app.js');

const ROOT = path.join(__dirname, '..');

/* How much of a maskable icon the favicon may fill. Android keeps only a centred circle
   80% of the width across, so everything that matters must sit within 0.4 of the width
   of the centre. The grid in favicon.svg spans 9 to 55 of its 64 units, so its outer
   corners are 23 units out on both axes, 0.51 of the width away along the diagonal; drawn
   at 75% they come in to 0.38, and the cells' rounded corners to 0.36, inside it. The
   ground behind is the favicon's own colour, so the tile's rounded edge disappears into
   it and what is left is the grid on a full square. */
const MASKABLE_SCALE = 0.75;

(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'favicon.svg'));
  const src = 'data:image/svg+xml;base64,' + svg.toString('base64');
  const ground = app.themeColor(fs.readFileSync(path.join(ROOT, 'src/shared-ui/style.css'), 'utf8'));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  try {
    for (const icon of app.ICONS) {
      const S = icon.size;
      const page = await browser.newPage({ viewport: { width: S, height: S }, deviceScaleFactor: 1 });
      const maskable = icon.purpose === 'maskable';
      const draw = maskable ? Math.round(S * MASKABLE_SCALE) : S;
      const at = (S - draw) / 2;
      await page.setContent(`<!doctype html><html><body style="margin:0;width:${S}px;height:${S}px;
        background:${maskable ? ground : 'transparent'}">
        <img src="${src}" style="position:absolute;left:${at}px;top:${at}px;width:${draw}px;height:${draw}px">
        </body></html>`, { waitUntil: 'load' });
      // transparent where the page is, so the plain icons keep the favicon's round corners
      await page.screenshot({ path: path.join(ROOT, icon.src), omitBackground: !maskable });
      await page.close();
      console.log(`  wrote ${icon.src.padEnd(22)} ${S} × ${S}  ${icon.purpose}`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
