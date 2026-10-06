/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Everything a page gets that is generated rather than spliced.
 *
 * build.js assembles a page by replacing markers with the contents of files, and then
 * does this: content computed at build time from the sources rather than copied out of
 * them. There are three such steps — the icon and link-preview tags every page shares,
 * the FAQ markup seo.js derives from the page's own questions, and the joint diagrams
 * joints.js draws from core.js's DEFAULTS.
 *
 * They live here because test/ci-sim.js has to perform the identical sequence against
 * git's stored bytes, and when the two lists were kept separately they drifted. That
 * file's own comment records it happening twice before — chrome.js and the guide pages,
 * then the download-dialog widgets — each time reporting a failure against a build that
 * was correct. Adding the joint diagrams to build.js and not to ci-sim.js made it three:
 * ci-sim declared guide/index.html stale by exactly the size of the gallery, while the
 * real CI, which runs `build.js --check`, was passing. A check that cries wolf is worse
 * than no check, because the next real failure gets waved through.
 *
 * One function, called by both, so a fourth step cannot be added to one of them only.
 *
 * `G` is passed in rather than required here on purpose: build.js works from the
 * working tree and ci-sim.js from the committed blob, and core.js decides what the
 * diagrams look like, so which copy it is matters.
 *
 * `page` is the manifest entry being built. The icon and link-preview tags need to know
 * where the page sits, because the icon is linked relatively and guide/split/ is two
 * levels further from it than the home page is.
 */
'use strict';
const seo = require('./seo.js');
const joints = require('./joints.js');
const printers = require('./printers.js');

module.exports = function generated(html, G, page) {
  html = seo.share(html, page.out);     // favicon and link-preview image, every page
  html = seo.inject(html);              // FAQ markup, from the page's own questions
  if (html.includes('<!--__JOINTS__-->'))
    html = html.replace('<!--__JOINTS__-->', joints.gallery(G));
  if (html.includes('<!--__JOINTFIGS__-->'))
    html = html.replace('<!--__JOINTFIGS__-->', joints.pickerFigures(G));
  if (html.includes('<!--__PRINTERS__-->'))
    html = html.replace('<!--__PRINTERS__-->', () => printers.options());
  // the pitch comes from core.js for the same reason the joints do: it decides the counts
  if (html.includes('<!--__PRINTERTABLE__-->'))
    html = html.replace('<!--__PRINTERTABLE__-->', () => printers.guideRows(G.DEFAULTS.pitch));
  return html;
};
