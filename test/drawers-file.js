#!/usr/bin/env node
/* The design file and the saved-drawer merge, headless.
 *
 * A design file is how a drawer moves between devices and onto a bug report, so two
 * things have to hold: a file this page writes comes back as exactly the design that
 * went in, and a file from anywhere else is either exactly that shape or refused with a
 * reason — never half-read, and never able to reach past the data it carries. The
 * browser specs (test/ui/drawers.spec.js) drive both through the page; this drives the
 * edges of the format, which are too many to click through one at a time.
 *
 * Usage: node test/drawers-file.js
 */
'use strict';
const D = require('../src/shared-ui/drawers.js');

let bad = 0;
const check = (name, ok, detail) => {
  console.log(`  ${name.padEnd(62)}${ok ? 'ok' : 'FAILED' + (detail ? ' — ' + detail : '')}`);
  if (!ok) bad++;
};
const ch = (n) => String.fromCharCode(n);

console.log('round trip');
{
  const notes = JSON.stringify([['tape, 12 mm', 'drill bits & hex keys'], ['café']]);
  const designs = [
    { name: 'Kitchen', hash: D.encodePairs([['w', '306'], ['d', '380'], ['sp', 'manual'],
      ['rc', '2,5'], ['cc', '3.4_2'], ['cn', 'hclip'], ['v', '2']]) },
    { name: 'Garage, top', hash: D.encodePairs([['w', '612.5'], ['d', '410'],
      ['bl', '0-0-2-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0-0-0-0-0~3-0-1-1-6'], ['bnotes', notes],
      ['v', '2']]) },
  ];
  const text = D.designFile(designs, new Date('2026-01-02T03:04:05Z'));
  const back = D.readDesignFile(text).drawers;
  check('every drawer comes back', back.length === designs.length);
  check('names come back exactly', back.every((b, i) => b.name === designs[i].name));
  check('designs come back byte for byte', back.every((b, i) => b.hash === designs[i].hash),
    back.map((b) => b.hash).join(' | '));
  const parsed = JSON.parse(text);
  check('settings are readable in the file, not a link string',
    parsed.drawers[1].design.bnotes === notes && parsed.drawers[0].design.rc === '2,5');
  check('the file says what it is', parsed.drawerforge === D.KIND && parsed.version === D.VERSION);
  // numbers are accepted where a hand-edited file might have them
  const handEdited = JSON.stringify({ drawerforge: D.KIND, version: 1,
    drawers: [{ name: 'Hand', design: { w: 400, d: 300.5 } }] });
  check('a number where a string was written still reads',
    D.readDesignFile(handEdited).drawers[0].hash === 'w=400&d=300.5');
}

console.log('\nrefused, with a reason, and nothing else thrown');
{
  const ok = { drawerforge: D.KIND, version: 1 };
  const one = (d) => JSON.stringify(Object.assign({}, ok, { drawers: [d] }));
  const good = { name: 'Box', design: { w: '300', d: '200' } };
  const CASES = [
    ['not JSON', '{"drawerforge":'],
    ['an empty file', ''],
    ['a JSON string', '"drawerforge-drawers"'],
    ['a JSON array', '[1,2,3]'],
    ['null', 'null'],
    ['some other JSON object', JSON.stringify({ name: 'Box', w: 300 })],
    ['the wrong kind', JSON.stringify(Object.assign({}, ok, { drawerforge: 'other', drawers: [good] }))],
    ['a newer version', JSON.stringify(Object.assign({}, ok, { version: 2, drawers: [good] }))],
    ['a version as a string', JSON.stringify(Object.assign({}, ok, { version: '1', drawers: [good] }))],
    ['no drawers key', JSON.stringify(ok)],
    ['drawers not a list', JSON.stringify(Object.assign({}, ok, { drawers: { 0: good } }))],
    ['an empty list', JSON.stringify(Object.assign({}, ok, { drawers: [] }))],
    ['too many drawers', JSON.stringify(Object.assign({}, ok,
      { drawers: Array(D.CAP.drawers + 1).fill(good) }))],
    ['a drawer that is a string', JSON.stringify(Object.assign({}, ok, { drawers: ['Box'] }))],
    ['no name', one({ design: good.design })],
    ['a name that is only spaces and controls', one({ name: ' ' + ch(7) + ch(0x202e) + ' ', design: good.design })],
    ['a name that is a number', one({ name: 42, design: good.design })],
    ['no design', one({ name: 'Box' })],
    ['a design that is a link string', one({ name: 'Box', design: 'w=300&d=200' })],
    ['a design that is a list', one({ name: 'Box', design: [['w', '300']] })],
    ['no width', one({ name: 'Box', design: { d: '200' } })],
    ['a width that is not a number', one({ name: 'Box', design: { w: 'wide', d: '200' } })],
    ['a negative depth', one({ name: 'Box', design: { w: '300', d: '-200' } })],
    ['an upper-case key', one({ name: 'Box', design: { w: '300', d: '200', W: '1' } })],
    ['a key with punctuation', one({ name: 'Box', design: { w: '300', d: '200', 'a&b': '1' } })],
    ['a key that is far too long', one({ name: 'Box', design: { w: '300', d: '200', abcdefghijklmn: '1' } })],
    ['__proto__ as a key', '{"drawerforge":"drawerforge-drawers","version":1,"drawers":' +
      '[{"name":"Box","design":{"w":"300","d":"200","__proto__":{"polluted":1}}}]}'],
    ['constructor smuggled as an object', one({ name: 'Box', design: { w: '300', d: '200', constructor: { x: 1 } } })],
    ['a value that is an object', one({ name: 'Box', design: { w: '300', d: '200', bl: { x: 1 } } })],
    ['a value that is null', one({ name: 'Box', design: { w: '300', d: '200', bl: null } })],
    ['a value that is true', one({ name: 'Box', design: { w: '300', d: '200', mg: true } })],
    ['a value far too long', one({ name: 'Box', design: { w: '300', d: '200', bl: 'x'.repeat(D.CAP.value + 1) } })],
    ['a value with half an emoji in it', one({ name: 'Box', design: { w: '300', d: '200', cn: 'a' + ch(0xd83d) } })],
    ['a drawer 0 wide', one({ name: 'Box', design: { w: '0', d: '200' } })],
    ['more settings than any design', one({ name: 'Box', design: Object.assign({ w: '300', d: '200' },
      Object.fromEntries(Array.from({ length: D.CAP.keys }, (_, i) => ['k' + i, '1']))) })],
    ['a whole file past the cap', ' '.repeat(D.CAP.fileBytes + 1)],
  ];
  for (const [what, text] of CASES) {
    let err = null, got;
    try { got = D.readDesignFile(text); } catch (e) { err = e; }
    const fine = err instanceof D.FileError && typeof err.message === 'string' && err.message.length > 10;
    check(what, fine, err ? `${err.constructor.name}: ${err.message}` : `accepted ${JSON.stringify(got).slice(0, 80)}`);
  }
  check('nothing reached Object.prototype', ({}).polluted === undefined && ({}).x === undefined);
}

console.log('\none bad drawer in a file');
{
  /* An export of every drawer is one file, and the bins page will save a drawer 0 wide.
     Refusing the whole file over it lost every good drawer in it as well. */
  const file = (drawers) => JSON.stringify({ drawerforge: D.KIND, version: 1, drawers });
  const box = { name: 'Box', design: { w: '300', d: '200' } };
  const got = D.readDesignFile(file([box, { name: 'Bad', design: { w: '0', d: '300' } },
    { name: 'Rack', design: { w: '250', d: '250' } }]));
  check('the good drawers either side of it are read', got.drawers.map((d) => d.name).join() === 'Box,Rack');
  check('and the bad one is named, with the reason', got.skipped.length === 1 &&
    /Bad/.test(got.skipped[0]) && /drawer 2/.test(got.skipped[0]) && /width/.test(got.skipped[0]),
    got.skipped.join(' | '));
  check('a file of good drawers skips nothing', D.readDesignFile(file([box])).skipped.length === 0);
  let none = null;
  try { D.readDesignFile(file([{ name: 'A', design: { w: '0', d: '1' } }, { name: 'B', design: {} }])); }
  catch (e) { none = e; }
  check('a file with no good drawer at all is refused, with a reason',
    none instanceof D.FileError && /“A”/.test(none.message), none && none.message);

  // and the export does not write one in the first place
  check('a drawer 0 wide is not exported', /“Zero” has no drawer width/.test(
    D.exportProblem({ name: 'Zero', hash: 'w=0&d=380&v=2' })));
  check('a drawer whose design does not parse is not exported',
    D.exportProblem({ name: 'Mangled', hash: 'w=%E0%A4%A&d=380' }) !== '');
  check('a good one is', D.exportProblem({ name: 'Box', hash: 'w=300&d=200&v=2' }) === '');
}

console.log('\nnames');
{
  check('controls and bidi overrides are removed',
    D.cleanName('Top' + ch(0x202e) + 'drawer' + ch(10) + ch(7)) === 'Top drawer');
  check('runs of space collapse', D.cleanName('  a    b  ') === 'a b');
  check('long names are cut to the cap', D.cleanName('x'.repeat(500)).length === D.CAP.name);
  check('markup is left as the characters it is', D.cleanName('<b>x</b>') === '<b>x</b>');
  check('a non-string is no name', D.cleanName({ toString: () => 'x' }) === '');
  // invisible, so two names that differ only by them look the same in the list
  check('soft hyphens and word joiners are removed',
    D.cleanName('Kit' + ch(0xad) + 'chen') === 'Kitchen' && D.cleanName('a' + ch(0x2060) + 'b' + ch(0x2063) + 'c') === 'abc');
  const face = ch(0xd83d) + ch(0xde00);
  const cut = D.cleanName('x'.repeat(D.CAP.name - 1) + face + 'tail');
  check('the cap does not cut an emoji in half', cut === 'x'.repeat(D.CAP.name - 1), JSON.stringify(cut));
  check('half an emoji on its own is removed', D.cleanName('Box ' + ch(0xd83d)) === 'Box' &&
    D.cleanName(ch(0xde00) + 'Box') === 'Box');
  check('a whole emoji is kept', D.cleanName('Box ' + face) === 'Box ' + face);
}

console.log('\nmerging one page\'s save into a drawer');
{
  // plates owns w, d, cn, v; bins owns w, d, bl, bf, v
  const platesOwns = (k) => ['w', 'd', 'cn', 'v'].includes(k);
  const binsOwns = (k) => ['w', 'd', 'bl', 'bf', 'v'].includes(k);
  const stored = 'w=300&d=200&cn=hclip&bl=OLD&bf=0.1&v=2';
  const q = (h) => Object.fromEntries(D.parsePairs(h));

  // the plates page's string carries a stale copy of the bins layout
  const fromPlates = D.mergeDesign(stored, 'bl=STALE&w=320&d=200&cn=puzzle&v=2', platesOwns);
  check('a page writes the keys it owns', q(fromPlates).cn === 'puzzle' && q(fromPlates).w === '320');
  check('and keeps the other page\'s, not its stale copy of them', q(fromPlates).bl === 'OLD');

  // the bins page has left focus, so its string no longer has bf
  const fromBins = D.mergeDesign(stored, 'cn=STALE&w=300&d=200&bl=NEW&v=2', binsOwns);
  check('an owned key the page no longer writes is dropped', !('bf' in q(fromBins)));
  check('the other page\'s keys survive the bins save', q(fromBins).cn === 'hclip');
  check('nothing is duplicated', D.parsePairs(fromBins).length === new Set(D.parsePairs(fromBins).map((p) => p[0])).size);
  check('a string with a broken escape parses as nothing', D.parsePairs('w=%E0%A4%A') === null);

  /* The drawer's size and the printer are written by both pages. Each writes them only
     when it changed them, so a page that saves for any other reason does not put back
     the size it arrived with over one the other page has set since. */
  const arrived = new Map(D.parsePairs('w=300&d=200&v=2'));
  const widened = 'w=400&d=200&cn=hclip&bl=OLD&v=2';          // the bins page set 400 since
  const kept = q(D.mergeDesign(widened, 'w=300&d=200&cn=puzzle&v=2', platesOwns, arrived));
  check('a shared key this page did not change keeps what is stored', kept.w === '400');
  check('while the keys it did change are written', kept.cn === 'puzzle');
  const moved = q(D.mergeDesign(widened, 'w=350&d=200&cn=puzzle&v=2', platesOwns, arrived));
  check('a shared key this page changed is written', moved.w === '350');
  check('with no record of what it arrived with, every key is written',
    q(D.mergeDesign(widened, 'w=300&d=200&cn=puzzle&v=2', platesOwns)).w === '300');
  check('the drawer and the printer are what is shared',
    ['w', 'd', 'bw', 'bd', 'bh', 'pr'].every((k) => D.SHARED.has(k)) && !D.SHARED.has('cn') && !D.SHARED.has('bl'));
}

console.log('\nfingerprints');
{
  const a = 'w=306&d=380&v=2', b = 'w=306&d=381&v=2';
  check('the same string, the same print', D.fingerprint(a) === D.fingerprint(a));
  check('a one-character change, a different print', D.fingerprint(a) !== D.fingerprint(b));
  check('short enough to be worth storing instead', D.fingerprint('x'.repeat(50000)).length <= 12);
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks pass');
process.exit(bad ? 1 : 0);
