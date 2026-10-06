/* Simulate CI: splice the COMMITTED sources and compare to the COMMITTED outputs.
   Reading git's stored bytes answers the question `build.js --check` cannot — whether
   what you are about to push holds together, rather than what happens to be on disk.
   A page rebuilt but never staged passes there and fails here, which is the case CI
   sees. (This used to warn that working-tree line endings could hide a stale file on
   Windows; .gitattributes checks every text file out as LF now, so the working tree
   and git's bytes no longer disagree.) */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = (p) => execSync(`git show HEAD:${p}`, { encoding: 'utf8', maxBuffer: 1e8 });

/* The joint diagrams are drawn from core.js's DEFAULTS, so the committed page can only
   be reproduced by the committed core.js -- requiring the working tree's would let an
   uncommitted change to a joint dimension slip past the one check whose whole purpose
   is to read git's bytes rather than the disk's. Node can only require a path, so the
   blob goes to a temp file. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cisim-'));
const coreTmp = path.join(tmp, 'core.js');
fs.writeFileSync(coreTmp, g('src/core.js'));
const CORE = require(coreTmp);
/* The same goes for the code that writes the generated parts of a page: the printer
   table, the joint figures, the share tags, and the app's manifest and service worker.
   Requiring the working tree's let an uncommitted change to tools/printers.js pass here
   and fail in CI. They require only each other, so the committed copies go side by side
   in one temp folder. */
fs.mkdirSync(path.join(tmp, 'tools'));
for (const f of ['generated.js', 'seo.js', 'joints.js', 'printers.js', 'app.js'])
  fs.writeFileSync(path.join(tmp, 'tools', f), g(`tools/${f}`));
const generated = require(path.join(tmp, 'tools', 'generated.js'));
const MARK = (name) => new RegExp(`[ \\t]*\\r?\\n?/\\*__${name}__\\*/[ \\t]*\\r?\\n?`);

/* The same manifest build.js splices from. This used to be a hand-kept copy that
   "must mirror build.js's TOOLS exactly", and it drifted twice — once when chrome.js
   and the three guide pages were added to the build and not to here, and again when
   the download-dialog widgets were. Both times it reported a failure against a build
   that was correct, which is the worst kind of check to have. */
const tools = require('../tools/manifest.js');

let ok = true;
const built = {};
for (const t of tools) {
  let s = g(t.template);
  for (const [m, f] of Object.entries(t.parts)) {
    if (!MARK(m).test(s)) { console.log(`${t.out}: marker ${m} NOT FOUND`); ok = false; }
    s = s.replace(MARK(m), () => g(f));
  }
  s = generated(s, CORE, t);
  built[t.out] = s;
  const committed = g(t.out);
  const match = s === committed;
  if (!match) ok = false;
  console.log(`${t.out.padEnd(16)} ${match ? 'matches committed output' : `DIFFERS (${s.length} vs ${committed.length})`}`);
}

/* The web manifest and the service worker, by the same functions build.js uses. The
   worker's cache name is a hash of every file it caches — the pages, the vendored
   scripts, the icons — so a page rebuilt and committed without the sw.js that goes with
   it is exactly the stale file this exists to catch. The icons and scripts are read as
   bytes, not text: a PNG decoded as UTF-8 hashes to something else. */
const app = require(path.join(tmp, 'tools', 'app.js'));
const blob = (p) => execSync(`git show HEAD:${p}`, { maxBuffer: 1e8 });
try {
  const manifest = app.webManifest(tools, g('src/shared-ui/style.css'),
                                   JSON.parse(g('package.json')).description);
  const sw = app.serviceWorker(g(app.SW_SOURCE), tools, (rel) =>
    rel === app.MANIFEST ? manifest
      : Object.prototype.hasOwnProperty.call(built, rel) ? built[rel] : blob(rel));
  for (const [rel, text] of [[app.MANIFEST, manifest], [app.SW, sw]]) {
    const committed = g(rel);
    const match = text === committed;
    if (!match) ok = false;
    console.log(`${rel.padEnd(16)} ${match ? 'matches committed output' : `DIFFERS (${text.length} vs ${committed.length})`}`);
  }
} catch (e) {
  ok = false;
  console.log(`the manifest and sw.js could not be rebuilt from the committed files: ${String(e.message).split('\n')[0]}`);
}
console.log(ok ? '\nCI will pass.' : '\nCI WOULD FAIL.');
process.exit(ok ? 0 : 1);
