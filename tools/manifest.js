/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* The page manifest: every page the site ships, the template it comes from, and the
 * sources spliced into it.
 *
 * It lives here rather than inside build.js because build.js is not the only thing
 * that needs it — test/ci-sim.js splices the same parts from git's stored bytes, and
 * tools/seo.js writes the sitemap from the same list. Keeping a second copy in
 * ci-sim.js has now gone wrong twice: once when chrome.js and the guide pages were
 * added to the build and not to the copy, and again when the dialog widgets were, both
 * times reporting a failure against a build that was correct.
 */
'use strict';

const CSS = 'src/shared-ui/style.css';
const CHROME = 'src/shared-ui/chrome.js';
const CORE = 'src/core.js';
const WIDGETS = 'src/shared-ui/widgets.js';
// the unit switch and the printer list, which panels 01 and 02 share between the tools
const FIELDS = 'src/shared-ui/fields.js';
// what a job costs and roughly how long it prints, said the same way by both tools
const ESTIMATE = 'src/shared-ui/estimate.js';
const DRAWERS = 'src/shared-ui/drawers.js';

module.exports = [
  {
    name: 'baseplates',
    template: 'src/template.html',
    out: 'index.html',
    changefreq: 'weekly', priority: '1.0',
    parts: { CSS, CHROME, CORE, WIDGETS, FIELDS, ESTIMATE, DRAWERS, UI: 'src/ui.js' },
    uiPart: 'UI',
  },
  {
    name: 'bins',
    template: 'src/bins/template.html',
    out: 'bins/index.html',
    changefreq: 'weekly', priority: '0.9',
    parts: { CSS, CHROME, CORE, WIDGETS, FIELDS, ESTIMATE, DRAWERS, BIN: 'src/bins/bin.js', UI: 'src/bins/ui.js' },
    uiPart: 'UI',
  },
  {
    // A prose page: shared stylesheet and chrome, no tool code at all. The id and
    // display audits are trivially satisfied because there is no UI source to check.
    name: 'guide',
    template: 'src/guide/template.html',
    out: 'guide/index.html',
    changefreq: 'monthly', priority: '0.8',
    parts: { CSS, CHROME },
  },
  { name: 'guide-split', template: 'src/guide/split.html',
    out: 'guide/split/index.html',
    changefreq: 'monthly', priority: '0.7',
    parts: { CSS, CHROME } },
  { name: 'guide-sizes', template: 'src/guide/drawer-sizes.html',
    out: 'guide/drawer-sizes/index.html',
    changefreq: 'monthly', priority: '0.7',
    parts: { CSS, CHROME } },
];
