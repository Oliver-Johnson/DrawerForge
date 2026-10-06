#!/usr/bin/env node
/* The 3MF writer, headless: what build3mfXML puts in the file for a part's name and for
 * where the part goes.
 *
 * Names first. Each part's name is written into an XML attribute, and it was written
 * as it came. Today the names are piece ids, key labels and the Bins page's type keys,
 * none of which can hold a quote or an ampersand — but a name is the obvious place for
 * text someone typed to end up, and the day it does, a quote ends the attribute early
 * and the rest of the name is read as markup. A slicer refuses a file like that, or
 * worse, reads a different part list out of it. So every character XML gives a meaning
 * to is written as its entity, and this reads the names back out of the model to check
 * they arrive as they were sent. A tab, newline or return goes as a character reference,
 * and the few control characters XML has no way to carry at all are dropped, so the
 * file stays XML whatever a name holds.
 *
 * Then the transform, because the convention it is written in is what the print plates
 * got wrong: build3mfXML turns a part about its own origin and then moves it, so the
 * translation says where the origin goes, not the part's corner. The page-level check
 * that every part lands on its planned rectangle is test/ui/plate-files.spec.js; this
 * pins the convention that check depends on.
 *
 * Usage: node test/plate-files.js
 */
'use strict';
const { build3mfXML } = require('../src/core.js');

let bad = 0;
const check = (name, ok, detail) => {
  console.log(`  ${name.padEnd(62)}${ok ? 'ok' : 'FAILED' + (detail ? ' — ' + detail : '')}`);
  if (!ok) bad++;
};

// one closed unit cube, as a list of quads, from (0,0,0) to (1,1,1)
const cube = () => {
  const v = (x, y, z) => [x, y, z];
  return [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)], [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
    [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)], [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
  ].map((verts) => ({ verts }));
};

/* Every attribute in the model, read the way an XML parser reads one: a name, '=', and
   a value running to the next matching quote. A value holding a raw '<' or a bare '&' is
   not well-formed, and a raw quote cannot be inside one at all — it ends it, and what
   follows has to look like another attribute or the tag's end.

   And the three rules of XML 1.0 that a name holding a control character runs into.
   Node has no XML parser to ask, so they are applied here as the standard writes them.
   A document holds only the characters XML calls Char (section 2.2): a raw U+0001
   anywhere, or a reference to one, and the file is not XML at all, so a slicer reads
   none of it. Every line end is read as a newline, whatever was written (2.11). And an
   attribute's value is normalized (3.3.3): each raw tab, newline or return in it is
   read as a space, and only a character reference brings one through as itself. */
const NOT_CHAR = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const hex = (c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
function tagsOf(xml) {
  const out = [], problems = [];
  const stray = NOT_CHAR.exec(xml);
  if (stray) problems.push(`the model holds ${hex(stray[0])}, which XML allows nowhere`);
  xml = xml.replace(/\r\n?/g, '\n');
  for (const m of xml.matchAll(/<([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>/g)) {
    const attrs = {};
    let rest = m[2];
    while ((rest = rest.trimStart()).length) {
      const a = /^([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
      if (!a) { problems.push(`<${m[1]}> has something that is not an attribute: ${rest.slice(0, 40)}`); break; }
      const raw = a[3] !== undefined ? a[3] : a[4];
      if (/</.test(raw)) problems.push(`<${m[1]} ${a[1]}> holds a raw '<'`);
      const bare = raw.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
      if (/&/.test(bare)) problems.push(`<${m[1]} ${a[1]}> holds an '&' that begins no entity`);
      attrs[a[1]] = raw.replace(/[\t\n]/g, ' ')
        .replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (ref, e) => {
          if (e[0] !== '#') return ENTITY[e];
          const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          const c = n <= 0x10FFFF ? String.fromCodePoint(n) : '\uFFFF';
          if (NOT_CHAR.test(c)) problems.push(`<${m[1]} ${a[1]}> refers to ${ref}, which is no character XML has`);
          return c;
        });
      rest = rest.slice(a[0].length);
    }
    out.push({ tag: m[1], attrs });
  }
  return { tags: out, problems };
}

console.log('part names');
{
  const NAMES = [
    'A1', 'B2@4.49', 'key',                          // what the baseplates page writes
    '2x1x3-w1.2-f1.2-s8-L12', 'div:83.5x40.0x1.2',  // and the Bins page
    'Tom & Jerry', '<object id="9">', 'a "quoted" name', "it's", '&amp; already', '>&<"\'',
  ];
  const { model } = build3mfXML(NAMES.map((name, i) => ({ name, polys: cube(), tx: i * 2, ty: 0, tz: 0, rot: 0 })));
  const { tags, problems } = tagsOf(model);
  check('every attribute in the model is well-formed', !problems.length, problems.join('; '));
  const objects = tags.filter((t) => t.tag === 'object');
  check(`the model holds one object per part (${NAMES.length})`, objects.length === NAMES.length,
    `found ${objects.length}`);
  for (const [i, name] of NAMES.entries()) {
    const got = objects[i] && objects[i].attrs.name;
    check(`${JSON.stringify(name)} comes back as it was sent`, got === name, `read back ${JSON.stringify(got)}`);
  }
  /* The names written today contain nothing to escape, so their bytes must not move:
     the plates people have already downloaded and the ones they download now should
     differ in placement, not in what every part is called. */
  for (const name of NAMES.slice(0, 5))
    check(`${name} is written as itself`, model.includes(`name="${name}"`));

  /* The characters XML cannot carry as they are. A raw tab, newline or return in an
     attribute is read back as a space, so each is written as a character reference,
     which is read back as itself. The other control characters, U+FFFE, U+FFFF and half
     a surrogate pair are not characters XML has at all, raw or referred to, and any one
     of them left the whole file unreadable: they are dropped, and the rest of the name
     kept. Nothing typed reaches a name today; this is for the day something does. */
  const ODD = [
    ['tab\there', 'tab\there'], ['two\nlines', 'two\nlines'], ['cr\rand\r\nlf', 'cr\rand\r\nlf'],
    ['bell\u0007', 'bell'], ['\u0001start', 'start'], ['nul\u0000end', 'nulend'],
    ['esc\u001b[0m', 'esc[0m'], ['not\uFFFEa\uFFFFchar', 'notachar'],
    ['half \uD83D a pair', 'half  a pair'], ['tail \uDCE6', 'tail '],
    ['Größe 📦 ✓', 'Größe 📦 ✓'], ['del\u007F', 'del\u007F'],
  ];
  const odd = tagsOf(build3mfXML(ODD.map(([name], i) =>
    ({ name, polys: cube(), tx: i * 2, ty: 0, tz: 0, rot: 0 }))).model);
  check('control characters in names leave the model well-formed', !odd.problems.length,
    odd.problems.join('; '));
  const oddObjects = odd.tags.filter((t) => t.tag === 'object');
  // JSON escapes the C0 controls and lone surrogates but prints these raw, unseen
  const say = (s) => JSON.stringify(s).replace(/[\u007F-\u009F\uFFFE\uFFFF]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
  for (const [i, [name, want]] of ODD.entries()) {
    const got = oddObjects[i] && oddObjects[i].attrs.name;
    check(`${say(name)} comes back as ${say(want)}`, got === want, `read back ${say(got)}`);
  }
}

console.log('\nwhere a part goes');
{
  /* x' = x m00 + y m10 + z m20 + m30 and likewise for y and z: 3MF applies its 4 x 3
     matrix to a row vector, so the last three numbers are the move. */
  const placed = (it) => {
    const { model } = build3mfXML([Object.assign({ name: 'p', polys: cube(), tz: 0 }, it)]);
    const m = /transform="([^"]+)"/.exec(model)[1].split(' ').map(Number);
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const q of cube()) for (const [x, y, z] of q.verts) {
      const p = [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10]];
      for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    }
    return [lo[0], hi[0], lo[1], hi[1]].map((v) => +v.toFixed(3));
  };
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const flat = placed({ tx: 5, ty: 7, rot: 0 });
  check('unturned, the part moves by (tx, ty)', same(flat, [5, 6, 7, 8]), JSON.stringify(flat));
  /* A quarter turn takes (x, y) to (-y, x), so a part that grows from its origin toward
     +x lands to the LEFT of tx. platePolysAndItems in src/ui.js allows for this; it
     used not to, and every turned piece printed a piece-width from where it was planned. */
  const turned = placed({ tx: 5, ty: 7, rot: 90 });
  check('turned, it swings about its origin before the move', same(turned, [4, 5, 7, 8]), JSON.stringify(turned));
}

console.log(bad ? `\n${bad} FAILED` : '\n3MF names and placement hold');
process.exit(bad ? 1 : 0);
