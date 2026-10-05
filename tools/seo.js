/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Structured data, generated from the page rather than written alongside it.
 *
 * Search engines require FAQ markup to match the answers a visitor actually sees,
 * and hand-maintained JSON-LD drifts from the prose the first time someone edits a
 * sentence. So the markup is derived from the page's own "Common questions" section
 * at build time: edit the wording and the markup follows, or it does not exist.
 *
 * build.js and test/ci-sim.js both call inject(), so the committed pages and the
 * CI reconstruction cannot disagree — which is the failure ci-sim already had once
 * when it was left behind by a change to the build.
 */
'use strict';

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', times: '×', deg: '°',
  hellip: '…', rarr: '→', frac12: '½',
};

/* Prose to plain text: markup out, entities decoded, whitespace collapsed. The
   answers carry links and emphasis that must not reach the JSON. */
function plain(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m)
    .replace(/\s+/g, ' ')
    .trim();
}

/* Every <h3> question in the FAQ section, with the prose that follows it up to the
   next heading. Returns [] when the page has no such section. */
function questions(html) {
  const start = html.search(/<h2[^>]*\bid\s*=\s*["']faq["'][^>]*>/i);
  if (start < 0) return [];
  const rest = html.slice(start);
  // take to the next h2 after the FAQ heading, or the end of the article
  const body = (() => {
    const afterHeading = rest.slice(rest.indexOf('>') + 1);
    const nextH2 = afterHeading.search(/<h2[\s>]/i);
    const closeArt = afterHeading.search(/<\/article>/i);
    const cuts = [nextH2, closeArt].filter((i) => i >= 0);
    return cuts.length ? afterHeading.slice(0, Math.min(...cuts)) : afterHeading;
  })();

  const out = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[\s>]|$)/gi;
  let m;
  while ((m = re.exec(body))) {
    const q = plain(m[1]);
    const a = plain(m[2].replace(/<p class="cta"[\s\S]*$/i, ''));
    if (q && a) out.push({ q, a });
  }
  return out;
}

function faqJsonLd(html) {
  const qs = questions(html);
  if (!qs.length) return null;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qs.map((x) => ({
      '@type': 'Question',
      name: x.q,
      acceptedAnswer: { '@type': 'Answer', text: x.a },
    })),
  });
}

/* Insert generated blocks just before </head>. A page that already carries its own
   FAQPage is left alone, so a hand-written one always wins. */
function inject(html) {
  if (/"@type"\s*:\s*"FAQPage"/.test(html)) return html;
  const ld = faqJsonLd(html);
  if (!ld) return html;
  /* LF, not os.EOL. These newlines are generated rather than copied out of a source
     file, so they are the one part of the page whose line endings do not follow the
     checkout — which is exactly how they once made three untouched guide pages look
     stale on Windows. The fix was to pin the checkout to LF (see .gitattributes), so
     matching the platform here is the wrong instinct: it would reintroduce the same
     mismatch on Linux instead. */
  const tag = `<script type="application/ld+json">\n${ld}\n</script>\n`;
  return html.replace(/<\/head>/i, tag + '</head>');
}

/* The sitemap, built from the same page list the build uses, so a page cannot be
 * added without being listed — which was the real failure mode of keeping it by hand.
 *
 * Deliberately no <lastmod>. The obvious source is the commit that last touched each
 * page, and that cannot work: the sitemap is committed alongside the page it dates,
 * so the moment both land, the page's last-touching commit is the one carrying the
 * sitemap, and the next build computes a date the committed file does not have. It is
 * self-referential and no amount of git history depth fixes it. A date that cannot be
 * verified is worse than no date, since a lastmod a crawler catches lying is a reason
 * to stop trusting all of them.
 */
/* Where a built page is served. Exported because the sitemap is no longer the only
   thing that needs it — tools/indexnow.js submits these same URLs, and a submitted URL
   that disagreed with the published one would be rejected as not belonging to the host,
   silently, long after the push that caused it. */
const SITE = 'https://drawerforge.co.uk/';
const urlFor = (out) => SITE + out.replace(/index\.html$/, '');

function sitemap(pages) {
  const rows = pages.map((p) => {
    const loc = urlFor(p.out);
    return '  <url><loc>' + loc + '</loc>' +
      '<changefreq>' + p.changefreq + '</changefreq>' +
      '<priority>' + p.priority + '</priority></url>';
  });
  const NL = '\n';   // LF on every platform, for the reason given in inject()
  return '<?xml version="1.0" encoding="UTF-8"?>' + NL +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + NL +
    rows.join(NL) + NL + '</urlset>' + NL;
}

/* The picture a shared link is shown with, and the icon in the tab.
 *
 * Neither existed, so a link posted to Reddit or Discord arrived as a bare line of text
 * and every tab carried the browser's blank page icon. They are the same on every page,
 * which is the reason they are written here, once, and spliced in at the
 * <!--__SHARE__--> marker. Five templates carrying five copies of ten tags is the shape
 * of thing that drifts — test/seo-check.js already catches the titles doing exactly that.
 *
 * The image URL is absolute because it has to be — a crawler fetching it has no page to
 * resolve a relative one against. That makes it the one URL here that a fork does not
 * get for free, the same as the canonical links. The icons are relative for the
 * opposite reason: they are fetched by the visitor's own browser from wherever the page
 * is served, a fork or a file:// copy included, and an absolute icon would be a request
 * to this site from somebody else's. Nothing here is fetched from a third party, and
 * the build's subresource audit now reads the finished page as well as the template, so
 * it would say so if that stopped being true.
 *
 * WIDTH and HEIGHT are what tools/social-image.js renders and what test/seo-check.js
 * reads back out of the PNG, so the size quoted to a crawler is the size it gets. */
const SOCIAL = {
  image: 'og-image.png',
  width: 1200,
  height: 630,
  alt: 'Drawerforge: a drawer of Gridfinity bins in its 3D preview, beside the line ' +
       '“Gridfinity baseplates and bins, built to the drawer you actually have.”',
  icon: 'favicon.svg',
  touchIcon: 'apple-touch-icon.png',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* The tags themselves, for the page built to `out`. The icon paths climb back to the
   site root from wherever the page sits — guide/split/index.html is two levels down. */
function shareTags(out) {
  const up = '../'.repeat(out.split('/').length - 1);
  const img = SITE + SOCIAL.image;
  return [
    `<link rel="icon" href="${up}${SOCIAL.icon}" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="${up}${SOCIAL.touchIcon}">`,
    `<meta property="og:image" content="${img}">`,
    '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:width" content="${SOCIAL.width}">`,
    `<meta property="og:image:height" content="${SOCIAL.height}">`,
    `<meta property="og:image:alt" content="${esc(SOCIAL.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${img}">`,
    `<meta name="twitter:image:alt" content="${esc(SOCIAL.alt)}">`,
  ].join('\n');   // LF on every platform, for the reason given in inject()
}

/* Every page carries the marker, and a page without it is a build failure rather than a
   page without a picture: the missing case is silent everywhere except a link preview
   nobody here will see. */
function share(html, out) {
  if (!html.includes('<!--__SHARE__-->'))
    throw new Error(`${out}: the template has no <!--__SHARE__--> marker for the icon and link-preview tags`);
  return html.replace('<!--__SHARE__-->', () => shareTags(out));
}

module.exports = { inject, faqJsonLd, questions, plain, sitemap, urlFor, SITE,
                   SOCIAL, shareTags, share };
