#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* The pictures the site is shown with when it is not being looked at directly.
 *
 *   og-image.png          1200 × 630, the card under a link on Reddit, Discord, Slack,
 *                         Mastodon, iMessage — whatever reads Open Graph
 *   apple-touch-icon.png  180 × 180, the home-screen icon, from favicon.svg
 *
 * Generated rather than drawn, so the picture of the tool is a picture of THE tool: the
 * render in the card is the bins page's own preview, built from the committed page with
 * a drawer laid out in it, not a mock-up that drifts from what a visitor finds. Rerun it
 * after a change you would want the card to show:
 *
 *   node build.js && node tools/social-image.js
 *
 * Unlike the build this needs the dev dependencies, because it drives a real browser —
 * the same Chromium the UI tests use. Set CHROMIUM to an executable to use another one.
 *
 * Reproducible in the sense that matters: the same script on the same machine gives the
 * same picture. It is not byte-identical across machines and is not meant to be — the
 * text is set in the system's own sans and monospace, as the site's is, so a Mac and a
 * Linux box draw slightly different letters. That is also why nothing checks the bytes;
 * test/seo-check.js checks the size, which is the part a crawler is promised.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('@playwright/test');
const seo = require('./seo.js');

const ROOT = path.join(__dirname, '..');
// one sentence, kept in one place: package.json's description is the README's subtitle
const TAGLINE = require('../package.json').description;

/* A drawer worth looking at: the default 306 × 380, so a 7 × 9 grid, with the mixture of
   sizes a real one ends up with rather than sixty-three identical cells. Grid y counts
   from the front of the drawer, which is the side nearest the camera. */
const LAYOUT = [
  // x, y, u, v, height units, dividers across, dividers along
  [0, 0, 3, 2, 3, 2, 0],
  [3, 0, 2, 2, 3, 0, 1],
  [5, 0, 2, 1, 3, 0, 0],
  [5, 1, 2, 1, 3, 1, 0],
  [0, 2, 1, 3, 6, 0, 0],
  [1, 2, 2, 3, 3, 0, 2],
  [3, 2, 4, 2, 2, 3, 0],
  [3, 4, 2, 1, 3, 0, 0],
  [5, 4, 2, 2, 6, 0, 0],
  [0, 5, 2, 2, 3, 1, 1],
  [2, 5, 3, 1, 3, 0, 0],
  [2, 6, 1, 1, 3, 0, 0],
  [3, 6, 1, 1, 3, 0, 0],
  [4, 6, 1, 1, 3, 0, 0],
  [5, 6, 2, 3, 3, 0, 2],
  [0, 7, 3, 2, 4, 2, 0],
  [3, 7, 2, 2, 3, 0, 0],
];

/* Where the render sits on the card: the right-hand side, full height. */
const SHOT = { w: 600, h: 630 };

/* The render: the bins page, expanded so its canvas is the whole viewport, at twice the
   size it will be shown so the card is drawn from more pixels than it shows. The canvas
   is read straight out of WebGL rather than screenshotted, so the background is
   transparent and the card's own shows through it. */
async function renderDrawer(browser) {
  const page = await browser.newPage({ viewport: { width: SHOT.w * 2, height: SHOT.h * 2 } });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('df-kofi', 'off'); } catch (e) {} });
  await page.goto(pathToFileURL(path.join(ROOT, 'bins', 'index.html')).href);
  await page.waitForFunction(() => typeof render === 'function' && !!document.getElementById('fillmap'));
  /* Pushed into the model rather than dragged out on the map: this is a picture, not a
     test, and the shape of a bin is the same object the map's own drag creates. */
  await page.evaluate((layout) => {
    for (const [x, y, u, v, hUnits, divX, divY] of layout)
      B().push({ x, y, u, v, hUnits, wall: state.wall, floorT: state.floorT, divX, divY,
                 solid: false, scoop: state.scoop, label: state.label, note: '',
                 edges: Object.assign({}, state.edges) });
    const shell = document.getElementById('showDrawer');
    shell.checked = true;
    shell.dispatchEvent(new Event('change', { bubbles: true }));
    drawMap(); refresh();
  }, LAYOUT);
  await page.locator('.previewbtn').click();          // full screen: canvas = viewport
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    theta = 0.62; phi = 0.86;                         // a little more from above than the default
    document.getElementById('threewrap').dispatchEvent(new CustomEvent('previewfit'));
    render();
    return document.getElementById('three').toDataURL('image/png');
  });
}

/* The card. Its look is the site header's: the same ground, the same faint 21 px grid,
   the wordmark set the same way. Written out here rather than borrowed from style.css
   because the header is laid out for a page and this is laid out for a 1200 × 630 box. */
function cardHtml(render, icon) {
  const { width: W, height: H } = seo.SOCIAL;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${W}px;height:${H}px;overflow:hidden}
  body{position:relative;color:#e9eef4;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    background:
      repeating-linear-gradient(0deg,transparent,transparent 20px,rgba(79,195,232,.05) 20px,rgba(79,195,232,.05) 21px),
      repeating-linear-gradient(90deg,transparent,transparent 20px,rgba(79,195,232,.05) 20px,rgba(79,195,232,.05) 21px),
      #171c22}
  .shot{position:absolute;right:0;top:0;width:${SHOT.w}px;height:${SHOT.h}px}
  .text{position:absolute;left:64px;top:0;bottom:0;width:550px;display:flex;flex-direction:column;justify-content:center}
  .mark{display:flex;align-items:center;gap:20px}
  .mark img{width:64px;height:64px}
  h1{font-size:50px;letter-spacing:.14em;font-weight:700;line-height:1}
  h1 span{color:#4fc3e8}
  p{font-size:32px;line-height:1.3;margin-top:34px;color:#e9eef4;font-weight:500;text-wrap:balance}
  .facts{margin-top:30px;font-family:ui-monospace,'SF Mono','Cascadia Code',Consolas,Menlo,monospace;
    font-size:19px;color:#8b98a5;line-height:1.6}
  .facts b{color:#4fc3e8;font-weight:400}
  .url{margin-top:26px;font-family:ui-monospace,'SF Mono','Cascadia Code',Consolas,Menlo,monospace;
    font-size:22px;color:#4fc3e8;letter-spacing:.04em}
  </style></head><body>
  <img class="shot" src="${render}" alt="">
  <div class="text">
    <div class="mark"><img src="${icon}" alt=""><h1>DRAWER<span>FORGE</span></h1></div>
    <p>${TAGLINE}</p>
    <div class="facts"><b>●</b> free, runs in your browser<br><b>●</b> splits plates to fit your bed<br><b>●</b> STL and pre-arranged 3MF</div>
    <div class="url">drawerforge.co.uk</div>
  </div>
  </body></html>`;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    // software WebGL, so this runs headless on a machine with no GPU, as CI does
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    // inline, because a page made with setContent is about:blank and may not read file://
    const iconUrl = 'data:image/svg+xml;base64,' +
      fs.readFileSync(path.join(ROOT, seo.SOCIAL.icon)).toString('base64');

    const render = await renderDrawer(browser);

    const card = await browser.newPage({ viewport: { width: seo.SOCIAL.width, height: seo.SOCIAL.height } });
    await card.setContent(cardHtml(render, iconUrl), { waitUntil: 'load' });
    await card.screenshot({ path: path.join(ROOT, seo.SOCIAL.image) });
    console.log(`  wrote ${seo.SOCIAL.image}  ${seo.SOCIAL.width} × ${seo.SOCIAL.height}`);

    /* Full bleed and square-cornered: iOS cuts its own rounded corners, and an icon that
       arrives already rounded gets a dark rim between the two curves. */
    const touch = await browser.newPage({ viewport: { width: 180, height: 180 } });
    await touch.setContent(`<!doctype html><html><body style="margin:0;background:#171c22">
      <img src="${iconUrl}" style="display:block;width:180px;height:180px"></body></html>`,
      { waitUntil: 'load' });
    await touch.screenshot({ path: path.join(ROOT, seo.SOCIAL.touchIcon) });
    console.log(`  wrote ${seo.SOCIAL.touchIcon}  180 × 180`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
