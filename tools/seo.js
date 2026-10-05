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

module.exports = { inject, faqJsonLd, questions, plain, sitemap, urlFor, SITE };
