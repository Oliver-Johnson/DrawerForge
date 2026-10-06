/* The tab icon and the link-preview picture, as a browser sees them.
 *
 * test/seo-check.js reads the tags and the files headlessly. This is the half only a
 * browser can answer: whether the icon each page links to actually loads from where that
 * page is served — guide/split/ climbs two directories to reach it, the home page none —
 * and whether adding tags to every page's head has quietly made any of them fetch
 * something from another site. The preview image is an absolute URL, which is right for
 * a crawler and would be wrong for a visitor's browser to request, so it must not be.
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const PAGES = ['index.html', 'bins/index.html', 'guide/index.html',
               'guide/split/index.html', 'guide/drawer-sizes/index.html'];

for (const rel of PAGES) {
  test(`${rel}: the icons load from where the page is, and nothing is fetched off-site`,
    async ({ page }) => {
      const offsite = [];
      await page.route('**/*', (route) => {
        const u = route.request().url();
        if (!/^(file|data|blob):/.test(u)) offsite.push(u);
        return route.continue();
      });
      await page.goto(pathToFileURL(path.join(H.ROOT, rel)).href);

      const icons = await page.evaluate(() => Promise.all(
        ['icon', 'apple-touch-icon'].map((r) => new Promise((done) => {
          const link = document.querySelector(`link[rel="${r}"]`);
          if (!link) return done({ r, ok: false, why: 'no link' });
          const img = new Image();
          img.onload = () => done({ r, ok: img.naturalWidth > 0, why: link.getAttribute('href') });
          img.onerror = () => done({ r, ok: false, why: `${link.getAttribute('href')} did not load` });
          img.src = link.href;
        }))));
      for (const i of icons) expect(i.ok, `${rel} ${i.r}: ${i.why}`).toBe(true);

      const meta = await page.evaluate(() => ({
        og: document.querySelector('meta[property="og:image"]').content,
        card: document.querySelector('meta[name="twitter:card"]').content,
      }));
      expect(meta.og).toBe('https://drawerforge.co.uk/og-image.png');
      expect(meta.card).toBe('summary_large_image');

      await page.waitForTimeout(300);
      expect(offsite, 'the page must not reach off-site').toEqual([]);
    });
}
