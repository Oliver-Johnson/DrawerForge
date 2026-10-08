/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Saved drawers: several designs kept on this device, and a file to carry them.
 *
 * Each tool kept exactly one layout, so someone kitting out a tool chest — eight drawers,
 * each its own size and its own bins — could have one of them at a time and had to keep
 * the rest as bookmarked share links. A saved drawer is a name and ONE design string
 * covering both tools: the baseplate and the bins in it belong to the same drawer, so
 * opening it on either page brings both back, and the cross-tool carry goes on working
 * because the string is the same key=value format the link already uses. There is still
 * one serialisation, round-tripped by test/hash-roundtrip.js; this file never parses a
 * design beyond splitting it into keys.
 *
 * Shared by both tools, and like widgets.js it knows no ids: each ui.js looks its
 * elements up with $() — where the build's id audit can see them — and hands them in.
 * Spliced after widgets.js and before each tool's ui.js, so DRAWERS is in scope there.
 * The pure parts at the top also run in Node; test/drawers-file.js drives the file
 * format and the merge headlessly.
 */
'use strict';

const DRAWERS = (function () {
  const STORE = 'drawerforge:drawers:v1';
  const KIND = 'drawerforge-drawers';
  const VERSION = 1;
  /* How much of a design file is believed. Generous against anything this page writes —
     a three-layer drawer of a hundred bins is around 20 KB — and small against what
     would hurt: the whole of localStorage is about 5 MB, and a design that cannot fit
     there is not a design this page made. */
  const CAP = { fileBytes: 5 * 1024 * 1024, drawers: 200, name: 60, keys: 200,
                value: 200000, design: 400000 };
  // every key either tool writes is a short lowercase word, and that is all a file may use
  const KEY_RE = /^[a-z][a-z0-9]{0,11}$/;

  const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  // the strings in a list read back from storage, and nothing else
  const strings = (a) => (Array.isArray(a) ? a.filter((k) => typeof k === 'string') : []);

  /* A character outside the basic plane, which is most emoji, is two UTF-16 units, and
     half of one is not text: encodeURIComponent throws on it, and a name shows it as a
     box. So a lone half is dropped, and a cut that would fall between the two halves
     falls before them instead. The cut counts units rather than characters because that
     is what the name box's maxlength counts. No lookbehind in the pattern, because older
     Safari cannot parse one and would refuse the whole script. */
  const wellFormed = (s) => s.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g,
    (m) => (m.length === 2 ? m : ''));
  const cut = (s, n) => s.slice(0, s.length > n && /[\ud800-\udbff]/.test(s[n - 1]) ? n - 1 : n);

  /* A name is shown on the page and nowhere else, always as text. Control characters go
     because they have no business in a label, and the bidirectional overrides and marks
     because they can make one name display as another — the list is how you tell drawers
     apart. The characters that draw nothing at all go for the same reason: the soft
     hyphen, the word joiner, the invisible operators, the combining grapheme joiner and
     the Hangul fillers would let two names that look identical be different names. Those
     are removed rather than turned into spaces, because they sit inside a word, and
     Kitchen with a soft hyphen in it reads as Kitchen. Variation selectors and tag
     characters stay: they are how an emoji picks its look, and how the flags of England,
     Scotland and Wales are written. */
  function cleanName(v) {
    if (typeof v !== 'string') return '';
    return cut(wellFormed(v).replace(/[\u00ad\u034f\u115f\u1160\u2060-\u2065\u206a-\u206f\u3164\uffa0]/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim(), CAP.name).trim();
  }
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  // the list and an export of it in one order, "Drawer 2" before "Drawer 10"
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

  /* The link format, split into [key, value] pairs in order. Null for a string whose
     escapes do not decode — such a string did not come from encodeURIComponent. */
  function parsePairs(h) {
    const out = [];
    for (const kv of String(h || '').replace(/^#/, '').split('&')) {
      const i = kv.indexOf('=');
      if (i <= 0) continue;
      let v;
      try { v = decodeURIComponent(kv.slice(i + 1)); } catch (err) { return null; }
      out.push([kv.slice(0, i), v]);
    }
    return out;
  }
  const encodePairs = (pairs) =>
    pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  /* The keys both pages write: the drawer's size, the printer, the slicer infill, and the
     format version, which is the same on both. Every other key belongs to one page or the
     other. The UI spec checks this list against what the two pages actually own. */
  const SHARED = new Set(['w', 'd', 'bw', 'bd', 'bh', 'pr', 'if', 'v']);

  /* One drawer, two pages writing to it. Each page's design string carries the other
     page's keys too — that is how the carry works — but its copy of them is only as new
     as the moment it was handed over, so a page that wrote its whole string would put
     back the other page's half as it stood then. Each writes the keys it owns and keeps
     everyone else's from what is stored.

     The shared keys above are owned by both pages, and those need one more rule. Every
     page saves as it loads, so writing them on every save made the real rule "the last
     page to save anything wins": going Back to the other page, or a second tab saving
     for any reason, put back the size that page arrived with. So a page writes a shared
     key only when it has changed it, meaning its value differs from `base`, the value
     the page arrived with or last saved. The last page to CHANGE the drawer's size or
     printer wins, and a page that has not changed them leaves whatever is stored. With
     no base, every owned key is written. */
  function mergeDesign(stored, mine, owns, base) {
    const was = parsePairs(stored) || [];
    const now = new Map(was);
    const theirs = was.filter(([k]) => !owns(k));
    const ours = (parsePairs(mine) || []).filter(([k]) => owns(k)).map(([k, v]) =>
      (base && SHARED.has(k) && base.get(k) === v && now.has(k) ? [k, now.get(k)] : [k, v]));
    return encodePairs(theirs.concat(ours));
  }
  // the shared keys of a design string, in the form `base` above takes
  const sharedOf = (h) => new Map((parsePairs(h) || []).filter(([k]) => SHARED.has(k)));

  /* A short fingerprint of a design string, for recognising one this browser wrote (see
     attach below). Stored instead of the strings themselves because a bins layout can run
     to kilobytes, there are several per drawer, and they would all be in localStorage. A
     53-bit non-cryptographic hash: nothing here defends against a forged match, because
     the only thing a match does is let edits to an identical design save into it. */
  function fingerprint(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  /* ---- the design file ----------------------------------------------------
     JSON, with each design spelled out as an object of settings rather than as the link
     string, so a file attached to a bug report can be read without decoding anything.
     It holds settings only, never meshes — the meshes are rebuilt from the settings. */
  function entry(d) {
    const design = {};
    for (const [k, v] of parsePairs(d.hash) || []) if (KEY_RE.test(k)) design[k] = v;
    return { name: d.name, design };
  }
  function designFile(list, when) {
    return JSON.stringify({
      drawerforge: KIND,
      version: VERSION,
      exported: (when || new Date()).toISOString(),
      about: 'Drawerforge design file. To load it, open https://drawerforge.co.uk, press the ' +
             'drawer button under the page links, then "Import a design file".',
      drawers: list.map(entry),
    }, null, 2) + '\n';
  }

  /* The bins page's notes, as its link carries them: JSON, a list per layer of the notes
     of that layer's bins, each a string no longer than the note field takes. The parsed
     lists, or null for anything else, so both the link and a design file turn away the
     same things. */
  const NOTE_MAX = 28;
  function binNotes(s) {
    let v;
    try { v = JSON.parse(s); } catch (err) { return null; }
    const ok = Array.isArray(v) && v.every((L) => Array.isArray(L) &&
      L.every((n) => typeof n === 'string' && n.length <= NOTE_MAX));
    return ok ? v : null;
  }

  // the only errors readDesignFile throws, so a message from one is fit to show as it is
  class FileError extends Error {}
  const nope = (msg) => new FileError(msg);

  /* A design file is untrusted input: it may come from anyone, made by anything. So it
     is checked all the way through before any of it is kept, and anything that is not
     exactly what designFile writes is refused with the reason, rather than repaired by
     a guess. Nothing in it is evaluated. Names go in as text, and each design becomes a
     link string, which is what a pasted share link is already: the pages read most
     values through a form field or a number parse. Bin notes are the exception, text
     the bins page shows as it was typed, so they are shown as text there and must be
     here in the shape that page writes (see binNotes). */
  function readDesignFile(text) {
    if (typeof text !== 'string') throw nope('That file could not be read.');
    if (text.length > CAP.fileBytes)
      throw nope('That file is far larger than a design file is, so it was not opened.');
    let data;
    try { data = JSON.parse(text); }
    catch (err) { throw nope('That is not a Drawerforge design file — it is not JSON at all.'); }
    if (!isPlain(data) || data.drawerforge !== KIND)
      throw nope('That file is JSON, but not a Drawerforge design file.');
    if (data.version !== VERSION)
      throw nope(typeof data.version === 'number' && data.version > VERSION
        ? 'That design file is from a newer version of Drawerforge than this page. Reload ' +
          'the page to pick up the latest, then import it again.'
        : 'That design file is a version this page does not recognise.');
    if (!Array.isArray(data.drawers) || !data.drawers.length)
      throw nope('That design file has no drawers in it.');
    if (data.drawers.length > CAP.drawers)
      throw nope(`That design file holds ${data.drawers.length} drawers; this page keeps ` +
        `at most ${CAP.drawers}.`);
    /* Each drawer is read on its own. "Export every drawer" puts a whole tool chest in one
       file, and refusing all of it over one bad drawer lost every good drawer with it. So
       a bad drawer is left out and named with its reason, and only a file with no good
       drawer in it at all is refused. */
    const drawers = [], skipped = [];
    data.drawers.forEach((d, i) => {
      try { drawers.push(readDrawer(d, i, data.drawers.length)); }
      catch (err) { if (!(err instanceof FileError)) throw err; skipped.push(err.message); }
    });
    if (!drawers.length)
      throw nope(skipped.length === 1 ? skipped[0]
        : `None of the ${skipped.length} drawers in that file could be read. ${skipped[0]}`);
    return { drawers, skipped };
  }
  function readDrawer(d, i, count) {
    const which = count > 1 ? `Drawer ${i + 1} in that file` : 'The drawer in that file';
    if (!isPlain(d)) throw nope(`${which} is not a drawer.`);
    const name = cleanName(d.name);
    if (!name) throw nope(`${which} has no name.`);
    const it = count > 1 ? `“${name}” (drawer ${i + 1} in that file)` : `“${name}”`;
    if (!isPlain(d.design)) throw nope(`${it} in that file has no design in it.`);
    const pairs = [];
    for (const [k, v] of Object.entries(d.design)) {
      if (!KEY_RE.test(k))
        throw nope(`${it} has a setting named “${cleanName(k).slice(0, 20)}”, which ` +
          'Drawerforge never writes.');
      let s;
      if (typeof v === 'string') s = v;
      else if (typeof v === 'number' && isFinite(v)) s = String(v);
      else throw nope(`${it} has a setting (${k}) that is not a plain value.`);
      if (s.length > CAP.value) throw nope(`${it} has a setting (${k}) far too long to be real.`);
      // half an emoji, which no page writes, and which would throw when encoded for the link
      if (wellFormed(s) !== s) throw nope(`${it} has a setting (${k}) that is not whole text.`);
      pairs.push([k, s]);
    }
    if (pairs.length > CAP.keys) throw nope(`${it} has more settings than any design has.`);
    const notes = pairs.find((q) => q[0] === 'bnotes');
    if (notes && !binNotes(notes[1]))
      throw nope(`${it} has bin notes (bnotes) that are not the short notes the bins page ` +
        `writes, each at most ${NOTE_MAX} characters.`);
    /* Both tools always write the drawer's size, and without it there is nothing to
       build, so a design missing it is not a design. */
    const num = (k) => { const p = pairs.find((q) => q[0] === k); return p ? parseFloat(p[1]) : NaN; };
    if (!(num('w') > 0) || !(num('d') > 0))
      throw nope(`${it} has no drawer width and depth, so it does not describe a drawer.`);
    const hash = encodePairs(pairs);
    if (hash.length > CAP.design) throw nope(`${it} is far larger than a design is.`);
    return { name, hash };
  }

  /* Why a drawer would be refused by the file it is exported into, or '' if it would not.
     The bins page takes a drawer width of 0, so a saved drawer can be one the importer
     turns away. Checking each with the importer's own reader keeps such a drawer out of
     the file, and lets the export say so, instead of writing a file that cannot be read
     back. */
  function exportProblem(rec) {
    try { readDrawer(entry(rec), 0, 1); return ''; }
    catch (err) { if (err instanceof FileError) return err.message; throw err; }
  }

  /* ---- the list on this device -------------------------------------------- */
  function loadAll() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (err) { s = null; }
    /* The store is this page's, but it is also anyone's with the dev tools open, and a
       page that will not start over one bad entry is worse than the entry going missing. */
    const list = isPlain(s) && Array.isArray(s.drawers) ? s.drawers : [];
    return { v: 1, drawers: list.filter((d) => isPlain(d) && typeof d.id === 'string' &&
        typeof d.hash === 'string' && cleanName(d.name))
      .map((d) => ({ id: d.id, name: cleanName(d.name), hash: d.hash,
                     saved: +d.saved || 0, marks: isPlain(d.marks) ? d.marks : {} })) };
  }
  function saveAll(s) {
    try { localStorage.setItem(STORE, JSON.stringify(s)); return true; }
    catch (err) { return false; }   // private mode, or the quota is full: the caller says so
  }
  /* Two small records beside the list, of which drawer each tool last saved into (see
     attach). One is per tab, in sessionStorage, which a reload and Back keep and a new tab
     starts without. The other is per device, and goes with the local save the bare site
     restores. The tab's record also carries the note for the next page to load in it,
     the one note there is about an arrival: which drawer the design it arrives with
     belongs to, if any, and whether it is someone's link (see arrival). */
  const TAB = 'drawerforge:drawers:tab';
  const LAST = 'drawerforge:drawers:last';
  function readNote(area, key) {
    let v = null;
    try { v = JSON.parse(window[area].getItem(key) || 'null'); } catch (err) { v = null; }
    return isPlain(v) ? v : {};
  }
  function writeNote(area, key, v) {
    try { window[area].setItem(key, JSON.stringify(v)); return true; }
    catch (err) { return false; }
  }
  function newId(s) {
    let id;
    do id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    while (s.drawers.some((d) => d.id === id));
    return id;
  }
  function uniqueName(s, name) {
    if (!s.drawers.some((d) => sameName(d.name, name))) return name;
    for (let n = 2; ; n++) {
      const tail = ` (${n})`;
      const c = cut(name, CAP.name - tail.length).trim() + tail;
      if (!s.drawers.some((d) => sameName(d.name, c))) return c;
    }
  }
  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'drawer';
  function download(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---- one page's view of it ----------------------------------------------
   * o.tool    'plates' or 'bins'
   * o.owns    (key) => true for the keys this page's descriptor speaks for
   * o.given   of those, the keys the other page sets on a hand-over (the plate height)
   * o.design  () => this page's design string, exactly as its share link carries it
   * o.stop    () => cancel any save still pending, before the page is replaced
   * o.els     the elements, looked up by the tool's ui.js
   */
  function create(o) {
    const el = o.els;
    const other = o.tool === 'plates' ? 'Bins' : 'Baseplates';
    let attached = null;     // the drawer this page saves into, or null for an unsaved design
    let base = null;         // its shared keys as this page arrived with or last saved them
    let failing = false;     // the browser refused the last save into it
    /* This tool's mark in the drawer at the page's last save into it that went through,
       or as it arrived: the page's half is that save or newer. Newer when the browser
       refused the saves since (storage full), and then the address is the one copy of the
       change. Undefined when not known. */
    let ours;
    /* The other tool's mark in the drawer when the other tool's settings this page carries
       along were current: undefined when that is not known. Handed on with them, so the
       other page can tell whether the drawer's half has moved on since (see restore). */
    let theirs;
    const otherTool = o.tool === 'plates' ? 'bins' : 'plates';
    let fresh = false;       // arrived with nothing to restore
    let bootDesign = '';
    let armed = '';          // 'open:id' or 'del:id' — the first press of a two-press action
    let renaming = '';

    const find = (s, id) => s.drawers.find((d) => d.id === id) || null;

    /* Which drawer this page just saved into, '' for none, kept for this tab and for this
       device. Written only when it changes, because an unsaved page saves often. */
    function savedInto(id) {
      for (const [area, key] of [['sessionStorage', TAB], ['localStorage', LAST]]) {
        const n = readNote(area, key);
        if (n[o.tool] !== id) { n[o.tool] = id; writeNote(area, key, n); }
      }
    }
    /* The note for the next page to load in this tab: the drawer ('' for none), and the
       fingerprint of the design that page will arrive with. `link` lists the drawer, bed
       and infill settings in it that are still someone's link's, not yours (the tool's
       ui.js works that out); `open` says a drawer was opened from the list, or caught up,
       rather than handed over. `marks` gives, for each tool, its mark in the drawer when
       its settings in `h` were current, where that is known (see restore): by tool, since
       by way of the guide the next page can be either. Read once, by the page's boot (see
       arrival). False if the browser would not keep it. */
    function handOver(id, h, caughtUp, more) {
      const n = readNote('sessionStorage', TAB);
      n.next = { id, fp: fingerprint(h), caughtUp: !!caughtUp,
                 link: (more && more.link) || [], open: !!(more && more.open),
                 marks: (more && more.marks) || {} };
      return writeNote('sessionStorage', TAB, n);
    }
    /* With it, the record of the address this tool's last save left (see wrote), which is
       for the next page to load in this tab and no other. */
    function takeNotes() {
      const n = readNote('sessionStorage', TAB);
      if (!('next' in n) && !('left' in n)) return { next: null, left: null };
      const { next, left } = n;
      delete n.next;
      delete n.left;
      writeNote('sessionStorage', TAB, n);
      return { next: isPlain(next) ? next : null,
               left: isPlain(left) && left.tool === o.tool ? left : null };
    }
    // taken once per page, by whichever of arrival and attach asks first
    let taken;
    const takeOnce = () => (taken === undefined ? (taken = takeNotes()) : taken);
    /* A reload takes the address as it stands when it starts, and a save still waiting can
       land before the page goes: it writes its own address, and the browser loads the one
       it took, with no mark at all, since the entry's mark went with the address the save
       wrote. So each save leaves this tab a record of the address it is leaving and what
       it saved, and a page reloaded at that address with no mark is that reload, as long
       as the drawer still holds that save. Reloaded, not opened there: the address is
       also a link you may have copied, and opened, it is that link (see attach). A link
       pasted over the page reloads it too, and the page says so first (forget). The record
       also carries what the address's own mark would have said: the page's marks from
       before the save (ours, theirs), by which the drawer has moved on from the address or
       not, and which settings in the design saved are still someone's link's (link). */
    function leaving(id, now, had, link) {
      const n = readNote('sessionStorage', TAB);
      n.left = { tool: o.tool, id, was: fingerprint((location.hash || '').replace(/^#/, '')), now,
                 ours: had, theirs, link: strings(link) };
      writeNote('sessionStorage', TAB, n);
    }
    function reloaded() {
      try {
        const e = performance.getEntriesByType('navigation')[0];
        return e ? e.type === 'reload' : !!performance.navigation && performance.navigation.type === 1;
      } catch (err) { return false; }
    }
    function raced(left, h) {
      if (!left || !h || left.was !== fingerprint(h) || typeof left.id !== 'string' || !reloaded()) return null;
      if (!left.id) return left;
      const d = find(loadAll(), left.id);
      return d && d.marks[o.tool] === left.now ? left : null;
    }
    /* This tab's own mark on each address the page writes, kept in the browser's history
       entry for it: the fingerprint of the design, and the drawer it was saved into. A
       reload keeps the entry's mark, and so does Back to an earlier page of yours that the
       browser loads again rather than keeping. A link pasted or followed makes a new entry,
       which has none. So an address that carries a matching mark is this tab's own page
       coming back, however far the save has moved on since in another tab or a later
       page; without it, that older address was taken for someone's link. An entry
       still holding someone's link as it arrived is marked as that link's, and comes
       back as that link: after Put back, Back to it is the link replacing your layout
       again, not your own page. It still names the drawer it was saved into (markOf). The
       address a page arrived at by a note carries the note until the page first saves, so
       a reload before then is that same arrival again. */
    function markOf(h) {
      let st = null;
      try { st = history.state; } catch (err) { st = null; }
      const m = isPlain(st) && isPlain(st.drawerforge) ? st.drawerforge : null;
      return m && m.tool === o.tool && !!h && m.fp === fingerprint(h) ? m : null;
    }
    function ownMark(h) {
      const m = markOf(h);
      return m && m.link !== true && !isPlain(m.note) ? m : null;
    }
    /* The mark for the address the page writes `h` to; `link` when that is someone's
       link, untouched since it arrived; `note` the note the page arrived at it by, until
       the page saves from it. */
    const stamp = (h, link, note) => ({ drawerforge: { tool: o.tool, fp: fingerprint(h),
      id: attached || '', link: !!link, ...(note ? { note } : {}), ours, theirs } });
    // marks the address the page is at, if it is `h`, leaving it as it is
    function markHere(h, link, note) {
      if ((location.hash || '').replace(/^#/, '') !== h) return;
      try { history.replaceState(stamp(h, link, note), ''); }
      catch (err) { /* refused on file://: a reload goes by the tab's record instead */ }
    }
    // the marks for a note: this tool's `mine`, and the other's as this page has it
    const marksFor = (mine) => ({ [o.tool]: mine, [otherTool]: theirs });
    /* Whether the drawer has saved this tool's half since the page's copy `h`, which was
       current with this tool's mark `was`: it holds neither that design nor that save. */
    const movedOn = (d, h, was) => d.marks[o.tool] !== fingerprint(h) && d.marks[o.tool] !== was;
    /* Whether this page's design `h` is still the save it was last current with, and the
       drawer has moved on from that save since: another tab of this tool saved into it,
       and this one has changed nothing. Saved, it would only write the older half back
       over the newer one, and that tab's change was gone. */
    const behind = (d, h) => d.marks[o.tool] !== ours && fingerprint(h) === ours;
    /* Replaces the page with design `h`. replaceState and a reload rather than a
       navigation: the design being replaced is not a page you went back from, and the
       back button should not offer it. */
    function go(h) {
      o.stop();
      try { history.replaceState(null, '', '#' + h); location.reload(); }
      catch (err) { location.replace('#' + h); }   // the page reloads on hashchange
    }
    /* The drawer's size and printer can have moved on since the design `h` this page has:
       the other page changed them after this one last saved, which is what going Back to
       this page finds, or another tab did. Showing the old values would be wrong twice
       over, since a download would use them too, so the page reloads onto the stored ones
       instead. The note marks that reload as a catch-up, and a catch-up is never followed
       by another, so this cannot loop. True if the page is reloading. */
    function catchUp(h, d) {
      const stored = sharedOf(d.hash);
      const moved = [...stored.keys()].filter((k) => o.owns(k) && base.get(k) !== stored.get(k));
      if (!moved.length) return false;
      const pairs = parsePairs(h) || [];
      const merged = encodePairs(pairs.map(([k, v]) => [k, moved.includes(k) ? stored.get(k) : v])
        .concat(moved.filter((k) => !pairs.some((p) => p[0] === k)).map((k) => [k, stored.get(k)])));
      // without the note the reloaded page could not tell it is this drawer, so stay put
      if (!handOver(d.id, merged, true, { open: true, marks: marksFor(ours) })) return false;
      go(merged);
      return true;
    }
    /* This tool's whole half of the drawer, not only the keys both pages share. A page
       of this tool that is not the last one to save into the drawer — this tab's own page
       come back after a later page or another tab moved the drawer on — has its half out
       of date, and its first save would write that old half back over the new one: a
       bin added in the other tab was gone. So it reloads onto the drawer as stored, the
       way opening it does, and the note makes that reload the drawer, caught up. Only when
       the drawer has moved on (movedOn), though: a change made while the browser refused
       every save is in the address and nowhere else, and reopening lost it. `link`, for a
       reload that raced the save (see leaving): the settings the page held as someone's
       link's. The page goes back to the drawer as a hand-over carrying them, so they stay
       the link's, not as the drawer opened from the list, which made them yours. True if
       the page is reloading. */
    function reopen(d, link) {
      const held = strings(link);
      if (!handOver(d.id, d.hash, true, held.length ? { link: held, marks: d.marks }
        : { open: true, marks: d.marks })) return false;
      go(d.hash);
      return true;
    }
    /* This tool's own half again, on a hand-over from the other page. That page carries
       this one's settings along from the address it arrived with, and when that is a page
       you went Back to, they are older than the drawer: a bin placed since was not in
       them, and the defaults standing in for it were saved over the drawer's bins. Nothing
       on the other page changes this tool's half, so the drawer's is the one to show. The
       page reloads with it, keeping what the other page does set: the drawer, bed and
       printer, and the keys it hands over (o.given).
       Only when the drawer has moved on, though. The note says which save of this tool's
       half the other page's copy was current with (`seen`), and while the drawer still
       holds that save, the copy is as new as the drawer or newer: with the browser's
       storage full, a bin placed before going across was saved nowhere else, and taking
       the drawer's half lost it. True if the page is reloading. */
    const half = (k) => o.owns(k) && !SHARED.has(k) && !(o.given || []).includes(k);
    function restore(h, d, link, seen) {
      if (seen === d.marks[o.tool]) return false;
      const mine = (s) => (parsePairs(s) || []).filter(([k]) => half(k))
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const stored = mine(d.hash);
      if (encodePairs(stored) === encodePairs(mine(h))) return false;
      const merged = encodePairs((parsePairs(h) || []).filter(([k]) => !half(k)).concat(stored));
      if (!handOver(d.id, merged, false, { link, marks: marksFor(d.marks[o.tool]) })) return false;
      go(merged);
      return true;
    }
    /* Opening another drawer replaces what is on screen. That costs nothing when what is
       on screen is itself a saved drawer, or is the untouched page you get on a first
       visit; anything else is work that exists nowhere but here. */
    const atRisk = () => !attached && !(fresh && o.design() === bootDesign);

    function say(text, kind) {
      el.msg.textContent = text || '';
      el.msg.className = 'exfit ' + (kind || 'ok');
      el.msg.hidden = !text;
    }
    function paintBar() {
      const d = attached && find(loadAll(), attached);
      if (attached && !d) { attached = null; failing = false; }     // deleted on another tab
      /* A refused save leads, ahead of the name: on a phone the bar shows about a dozen
         characters, and the warning is the part that has to survive the cut. */
      const shown = d ? (failing ? `not saving · ${d.name}` : d.name) : 'not saved';
      el.name.textContent = shown;
      el.name.classList.toggle('none', !d);
      el.name.classList.toggle('fail', !!d && failing);
      /* The visible text is just the name, which says nothing about what pressing it does,
         so the accessible name says both — starting with the words on screen. */
      el.button.setAttribute('aria-label', !d ? 'Not saved as a drawer. Your drawers'
        : failing ? `${shown}: your last change could not be saved into the drawer that is open. Your drawers`
        : `${d.name}: the drawer that is open. Your drawers`);
    }

    function button(label, act, id, aria, onClick) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ghost'; b.textContent = label;
      b.dataset.act = act; b.dataset.id = id;
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      return b;
    }

    function describe(d, on) {
      const q = Object.fromEntries((parsePairs(d.hash) || []).filter(([k]) => k === 'w' || k === 'd'));
      const bits = [];
      if (on) bits.push('open now');
      if (q.w && q.d) bits.push(`${q.w} × ${q.d} mm drawer`);
      if (d.saved) {
        try {
          bits.push('saved ' + new Date(d.saved).toLocaleString(undefined,
            { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
        } catch (err) { /* a locale the browser cannot format is no reason to fail */ }
      }
      return bits.join(' · ');
    }

    /* Rebuilt whole on every change, as the export dialog's list is. The buttons it
       replaces may have had focus — the two-press actions are pressed twice in a row — so
       the focus is put back on the button standing in the same place. */
    function render() {
      const s = loadAll();
      const cur = attached && find(s, attached);
      if (attached && !cur) attached = null;
      const had = document.activeElement && el.list.contains(document.activeElement)
        ? { act: document.activeElement.dataset.act, id: document.activeElement.dataset.id } : null;

      el.now.textContent = !cur
        ? 'The design on screen is not saved as a drawer. Give it a name below to keep it, ' +
          'baseplate and bins together.'
        : failing
          ? `Open now: “${cur.name}”, but your last change could not be saved into it. This ` +
            'browser’s storage for this site is full, or it is a private window that keeps ' +
            'nothing. Export this drawer to keep what is on screen.'
          : `Open now: “${cur.name}”. Changes save into it as you work, here and on ${other}.`;
      el.exportOne.textContent = cur ? 'Export this drawer' : 'Export the design on screen';
      el.exportAll.disabled = !s.drawers.length;

      el.list.textContent = '';
      el.list.hidden = !s.drawers.length;
      for (const d of s.drawers.slice().sort(byName)) {
        const on = d.id === attached;
        const row = document.createElement('div');
        row.className = 'exrow dwrow' + (on ? ' on' : '');
        const left = document.createElement('div');
        const acts = document.createElement('div');
        acts.className = 'dwacts';
        if (renaming === d.id) {
          const f = document.createElement('form');
          f.className = 'dwrename';
          const inp = document.createElement('input');
          inp.type = 'text'; inp.maxLength = CAP.name; inp.value = d.name;
          inp.setAttribute('aria-label', `New name for ${d.name}`);
          inp.dataset.act = 'name'; inp.dataset.id = d.id;
          f.appendChild(inp);
          f.addEventListener('submit', (e) => { e.preventDefault(); rename(d.id, inp.value); });
          left.appendChild(f);
          acts.appendChild(button('Save name', 'savename', d.id, `Save the new name for ${d.name}`,
            () => rename(d.id, inp.value)));
          acts.appendChild(button('Cancel', 'cancel', d.id, `Keep the name ${d.name}`,
            () => { renaming = ''; say(''); render(); }));
        } else {
          const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = d.name;
          const mt = document.createElement('span'); mt.className = 'meta'; mt.textContent = describe(d, on);
          left.appendChild(nm); left.appendChild(mt);
          /* The accessible name says which drawer, so a screen reader is not offered a column
             of identical "Open" buttons; it starts with the visible words, so speaking the
             label you can see still finds the button. */
          const opening = armed === 'open:' + d.id, deleting = armed === 'del:' + d.id;
          if (!on) acts.appendChild(button(opening ? 'Open anyway' : 'Open', 'open', d.id,
            opening ? `Open anyway: ${d.name}` : `Open ${d.name}`, () => open(d.id)));
          acts.appendChild(button('Rename', 'rename', d.id, `Rename ${d.name}`, () => {
            renaming = d.id; armed = ''; say(''); render();
          }));
          acts.appendChild(button(deleting ? 'Really delete?' : 'Delete', 'del', d.id,
            deleting ? `Really delete? ${d.name}` : `Delete ${d.name}`, () => remove(d.id)));
        }
        row.appendChild(left); row.appendChild(acts);
        el.list.appendChild(row);
      }
      const back = (sel) => [...el.list.querySelectorAll('[data-act]')]
        .find((b) => b.dataset.act === sel.act && b.dataset.id === sel.id);
      const naming = renaming && back({ act: 'name', id: renaming });
      if (naming) { naming.focus(); naming.select(); }
      else if (had) {
        // the button that had focus may be gone with its row, and focus must not fall out
        // of a modal onto the page behind it
        const b = back(had) || back({ act: 'rename', id: had.id }) ||
          el.list.querySelector('button') || el.input;
        b.focus();
      }
      paintBar();
    }

    function saveAs(raw) {
      const name = cleanName(raw);
      if (!name) { say('Give the drawer a name first — whatever you call that drawer.', 'bad'); el.input.focus(); return; }
      const s = loadAll();
      if (s.drawers.some((d) => sameName(d.name, name))) {
        say(`You already have a drawer called “${name}”. Pick another name — or open that ` +
          'one, and it saves itself as you go.', 'bad');
        return;
      }
      if (s.drawers.length >= CAP.drawers) {
        say(`That would be more than ${CAP.drawers} drawers, which is as many as this page ` +
          'keeps. Export some to a file and delete them here to make room.', 'bad');
        return;
      }
      const h = o.design();
      const d = { id: newId(s), name, hash: h, saved: Date.now(), marks: { [o.tool]: fingerprint(h) } };
      s.drawers.push(d);
      if (!saveAll(s)) {
        say('This browser would not keep it — its storage for this site is full, or it is a ' +
          'private window that keeps nothing. Export the design to a file instead.', 'bad');
        return;
      }
      attached = d.id; armed = ''; renaming = '';
      base = sharedOf(h); failing = false;
      ours = d.marks[o.tool];
      theirs = undefined;   // the other tool has no mark in a new drawer
      savedInto(d.id);
      /* The address was marked as no drawer's when it was written. It is this one's now,
         so a reload comes back to it. A save still waiting marks its own address. */
      markHere(h);
      el.input.value = '';
      render();
      say(`Saved as “${name}”. From now on it keeps itself up to date as you work, here and on ${other}.`);
    }

    function open(id) {
      const s = loadAll();
      const d = find(s, id);
      if (!d) { render(); return; }
      if (atRisk() && armed !== 'open:' + id) {
        armed = 'open:' + id; render();
        say(`The design on screen is not saved as a drawer, and opening “${d.name}” replaces ` +
          'it. Save it first with the box above, or press Open anyway.', 'bad');
        return;
      }
      /* The note is how the reloaded page knows the design it finds in its address bar is
         this drawer, and not another drawer holding the same design — see attach. */
      handOver(d.id, d.hash, false, { open: true, marks: d.marks });
      go(d.hash);
    }

    function rename(id, raw) {
      const name = cleanName(raw);
      const s = loadAll();
      const d = find(s, id);
      if (!d) { renaming = ''; render(); return; }
      if (!name) { say('A drawer needs a name.', 'bad'); return; }
      if (s.drawers.some((x) => x.id !== id && sameName(x.name, name))) {
        say(`You already have a drawer called “${name}”.`, 'bad');
        return;
      }
      const was = d.name;
      d.name = name;
      if (!saveAll(s)) { say('This browser would not store the change.', 'bad'); return; }
      renaming = '';
      render();
      say(was === name ? '' : `Renamed “${was}” to “${name}”.`);
    }

    function remove(id) {
      const s = loadAll();
      const d = find(s, id);
      if (!d) { render(); return; }
      if (armed !== 'del:' + id) {
        armed = 'del:' + id; render();
        say(`Delete “${d.name}” from this device? Its baseplate and its bins both go, and it ` +
          'cannot be undone — export it first if you might want it back. Press “Really delete?” to confirm.', 'bad');
        return;
      }
      s.drawers = s.drawers.filter((x) => x.id !== id);
      if (!saveAll(s)) { say('This browser would not store the change.', 'bad'); return; }
      const wasOpen = attached === id;
      if (wasOpen) { attached = null; failing = false; }
      armed = '';
      render();
      say(`Deleted “${d.name}”.` + (wasOpen
        ? ' Its design is still on screen, no longer saved as a drawer.' : ''));
    }

    /* The open drawer is exported as it stands this moment, not as of its last save,
       which may be a debounce behind the last edit. */
    const live = (d) => (d.id === attached ? mergeDesign(d.hash, o.design(), o.owns, base) : d.hash);
    /* What an export or an import left out, and why. The first reason is given in full,
       since one bad drawer is the usual case and its reason says what to fix. */
    const leftOut = (why, because) => (why.length === 1
      ? `Left out one ${because}: ${why[0]}`
      : `Left out ${why.length} ${because}. The first: ${why[0]}`);
    function exportOne() {
      const s = loadAll();
      const cur = attached && find(s, attached);
      const rec = cur ? { name: cur.name, hash: live(cur) } : { name: 'Unsaved drawer', hash: o.design() };
      const why = exportProblem(rec);
      if (why) { say(`Not exported, because the file could not be imported again: ${why}`, 'bad'); return; }
      download(designFile([rec]), `drawerforge-${slug(rec.name)}.json`);
      say(`Exported “${rec.name}” as a design file.`);
    }
    function exportAll() {
      const s = loadAll();
      if (!s.drawers.length) return;
      const all = s.drawers.slice().sort(byName).map((d) => ({ name: d.name, hash: live(d) }));
      const why = all.map(exportProblem);
      const list = all.filter((d, i) => !why[i]);
      const bad = why.filter(Boolean);
      if (!list.length) {
        say(`Nothing was exported, because none of your drawers could be imported again. ${bad[0]}`, 'bad');
        return;
      }
      download(designFile(list), `drawerforge-${list.length}-drawers.json`);
      if (bad.length) say(`Exported ${list.length} of your ${all.length} drawers as one design file. ` +
        leftOut(bad, 'that could not be imported again'), 'bad');
      else say(`Exported all ${list.length} drawer${list.length === 1 ? '' : 's'} as one design file.`);
    }

    /* Added to the list, not opened: an import should never replace the design on screen
       behind your back, and a file of several drawers has no single one to open. */
    function importFile(file) {
      el.importInput.value = '';     // so choosing the same file again still reports
      if (!file) return;
      if (file.size > CAP.fileBytes) {
        say('That file is far larger than a design file is, so it was not opened.', 'bad');
        return;
      }
      file.text().then((text) => {
        let got;
        try { got = readDesignFile(text); }
        catch (err) {
          say(err instanceof FileError ? err.message : 'That file could not be read as a design file.', 'bad');
          return;
        }
        const s = loadAll();
        if (s.drawers.length + got.drawers.length > CAP.drawers) {
          say(`That would make more than ${CAP.drawers} drawers, which is as many as this page ` +
            'keeps. Delete some first.', 'bad');
          return;
        }
        const added = [];
        for (const g of got.drawers) {
          const name = uniqueName(s, g.name);
          s.drawers.push({ id: newId(s), name, hash: g.hash, saved: Date.now(), marks: {} });
          added.push(name);
        }
        if (!saveAll(s)) {
          say('This browser would not keep them — its storage for this site is full, or it is ' +
            'a private window that keeps nothing.', 'bad');
          return;
        }
        armed = '';
        render();
        say((added.length === 1
          ? `Added “${added[0]}” to your drawers. Open it below to load it.`
          : `Added ${added.length} drawers: ${added.map((n) => `“${n}”`).join(', ')}. Open one below to load it.`) +
          (got.skipped.length ? ' ' + leftOut(got.skipped, 'that could not be read') : ''),
        got.skipped.length ? 'bad' : 'ok');
      }, () => say('That file could not be read.', 'bad'));
    }

    el.button.addEventListener('click', () => {
      armed = ''; renaming = '';
      say('');
      render();
      if (el.dialog.showModal) el.dialog.showModal(); else el.dialog.setAttribute('open', '');
    });
    el.close.addEventListener('click', () => el.dialog.close());
    // Escape while renaming abandons the rename, not the whole dialog
    el.dialog.addEventListener('cancel', (e) => {
      if (renaming) { e.preventDefault(); renaming = ''; say(''); render(); }
    });
    // both ends of the click on the backdrop, for the reason the export dialog gives
    let downOnBackdrop = false;
    el.dialog.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === el.dialog; });
    el.dialog.addEventListener('click', (e) => {
      if (downOnBackdrop && e.target === el.dialog) el.dialog.close();
      downOnBackdrop = false;
    });
    el.form.addEventListener('submit', (e) => { e.preventDefault(); saveAs(el.input.value); });
    el.exportOne.addEventListener('click', exportOne);
    el.exportAll.addEventListener('click', exportAll);
    el.importBtn.addEventListener('click', () => el.importInput.click());
    el.importInput.addEventListener('change', () =>
      importFile(el.importInput.files && el.importInput.files[0]));

    /* A page the browser kept in its back-forward cache comes back without loading, so
       attach never sees the return. Coming Back from the other page is exactly when the
       drawer's size may have changed, so this gets the same chance to catch up as a
       reload does — the whole half, when a later page of this tool saved into it. */
    addEventListener('pageshow', (e) => {
      if (!e.persisted || !attached) return;
      const d = find(loadAll(), attached);
      if (!d) return;
      const h = o.design();
      if (movedOn(d, h, ours)) reopen(d);   // a later page saved into it
      else catchUp(h, d);
    });

    return {
      /* The note left for this page, if the design `h` it arrives with is the one the
         note is about: with `link` and `open` as handOver writes them. Read every time, so
         a stale note never lingers; attach reads the same one. The address a page arrived
         at by a note, reloaded before its first save, is that arrival again. Without one,
         `own` says the address is this tab's own (see ownMark), and `reloaded` that it is
         a reload that started as this tab's last save landed (see leaving). Else null. */
      arrival(h) {
        const { next, left } = takeOnce();
        const noteOf = (n, id) => ({ id: typeof id === 'string' ? id : '',
          link: strings(n.link),
          open: n.open === true, own: false });
        if (next && h && next.fp === fingerprint(h)) return noteOf(next, next.id);
        const m = markOf(h);
        if (m && isPlain(m.note)) return noteOf(m.note, m.id);
        const mine = ownMark(h);
        if (mine) return { id: typeof mine.id === 'string' ? mine.id : '', link: [], open: false, own: true };
        const gone = !m && raced(left, h);
        return gone ? { id: gone.id, link: [], open: false, own: true, reloaded: true } : null;
      },
      stamp,   // for the address the page is about to write (see ownMark)
      /* The page is about to reload onto an address someone chose, not as it stands:
         the next page is not a reload that a save raced (see leaving). */
      forget() {
        const n = readNote('sessionStorage', TAB);
        if ('left' in n) { delete n.left; writeNote('sessionStorage', TAB, n); }
      },
      /* Whether `h` is a save that the drawer open has moved on from, with nothing new of
         this page's (see behind). Its save writes nothing then, and nor does the page's
         own: that is the save a later visit opens, and it held the older half. */
      isBehind(h) {
        const d = attached && find(loadAll(), attached);
        return !!d && behind(d, h);
      },
      /* Whether `h` is what this tool last saved into some saved drawer: replaced, it is
         still there, in that drawer. */
      holds(h) {
        const fp = fingerprint(h);
        return loadAll().drawers.some((d) => d.marks[o.tool] === fp);
      },
      /* Whether `a` and `b` differ in this tool's own half alone (see restore): all that
         the other page sets, the drawer, bed and printer, o.given and its own settings
         carried along, the same in both. Not the plate height (ph): Baseplates never
         saves it and every hand-over from Bins carries it, and it comes over as "5.00"
         where Bins wrote "5". It follows from the plates' settings, compared here. */
      onlyMine(a, b) {
        const rest = (s) => encodePairs((parsePairs(s) || []).filter(([k]) => !half(k) && k !== 'ph')
          .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
        return rest(a) === rest(b);
      },
      /* Which drawer, if any, the design this page arrived with belongs to.
       *
       * The obvious answer — "whichever drawer was open last" — is wrong in the case that
       * matters. Follow someone's shared link while your Kitchen drawer is open and the
       * page would save their design into your Kitchen. Start fresh would overwrite it
       * with the defaults. So a page belongs to a drawer only when this browser has a
       * record that says so:
       *
       * Opening a drawer from the list, and the hand-over from the other tool or the
       * guide, leave a note in this tab naming the drawer and the fingerprint of the
       * design the next page arrives with. The note is read once, here, and it decides.
       * Matching the design against the drawers is not enough, because two drawers can
       * hold the same design: a backup saved from the drawer on screen, or placeholders
       * saved straight from the defaults. Picking the newest of those opened the backup
       * when you asked for the original, and your next edit went into the backup.
       *
       * Without a note the page is a reload, a Back, or the bare site restoring the local
       * save, so the design is one this tool saved itself. An address this tab wrote goes
       * back to the drawer it was saved into, by its mark (see ownMark), even when that
       * drawer has moved on since. Anything else goes back to the drawer this tool last
       * saved into, in this tab or else on this device, and only if that drawer's
       * fingerprint of its last save from this tool matches. A tab whose last
       * save went into no drawer stays unsaved, so a fresh start whose defaults match a
       * placeholder drawer does not quietly become that drawer.
       *
       * Anything else — a link from someone else, a fresh start — arrives unsaved, and
       * nothing of yours is written over.
       *
       * Called once the page has loaded its design and drawn it, so that `bootDesign` is
       * what an untouched page looks like. */
      attach(arrivedWith) {
        fresh = !arrivedWith;
        bootDesign = o.design();
        attached = null;
        ours = undefined;
        theirs = undefined;
        const { next, left } = takeOnce();   // read every time, so a stale note never lingers
        if (arrivedWith) {
          const s = loadAll();
          const fp = fingerprint(arrivedWith);
          const arriving = next && next.fp === fp ? next : null;
          const noted = arriving && find(s, arriving.id);
          /* This tab's own page come back: the drawer it was saved into, even when a later
             page or another tab has saved into that drawer since, which is what the
             catch-up below is for. A page still holding a link it was saved with as well:
             come back as that link, but into the drawer. And a reload that started as the
             page's last save landed, whose address lost its mark to the save's: the drawer
             that save went into (see leaving). */
          const mine = !noted && markOf(arrivedWith);
          const gone = !arriving && !mine && raced(left, arrivedWith);
          let d = noted || (mine && mine.id ? find(s, mine.id) : null) ||
            (gone && gone.id ? find(s, gone.id) : null);
          if (!d) {
            const tab = readNote('sessionStorage', TAB)[o.tool];
            const dev = readNote('localStorage', LAST)[o.tool];
            for (const id of tab === '' ? [] : [tab, dev]) {
              const c = typeof id === 'string' && find(s, id);
              if (c && c.marks[o.tool] === fp) { d = c; break; }
            }
          }
          if (d) {
            attached = d.id;
            base = sharedOf(arrivedWith);
            // the marks the design's halves came with, from the note or this tab's own mark
            const came = noted ? (isPlain(next.marks) ? next.marks : {})
              : mine && mine.id === d.id ? { [o.tool]: mine.ours, [otherTool]: mine.theirs }
              : gone && gone.id === d.id ? { [o.tool]: gone.ours, [otherTool]: gone.theirs } : {};
            const str = (v) => (typeof v === 'string' ? v : undefined);
            theirs = str(came[otherTool]);
            /* A raced reload's link settings, those the drawer still has as the page had
               them: one another tab has changed since is that tab's, not the link's. */
            const stored = sharedOf(d.hash);
            const held = gone && gone.id === d.id
              ? strings(gone.link).filter((k) => stored.get(k) === base.get(k)) : null;
            if (!noted && movedOn(d, arrivedWith, str(came[o.tool])) && reopen(d, held)) return;
            ours = d.marks[o.tool];
            /* A hand-over, onto a drawer this tool has saved into. One carrying a link's
               settings too: restore keeps the settings the other page sets, which are the
               link's, and this tool's half was saved into the drawer with them. */
            if (noted && next.open !== true && typeof d.marks[o.tool] === 'string' &&
                restore(arrivedWith, d, next.link, str(came[o.tool]))) return;
            if (!(noted && next.caughtUp) && catchUp(arrivedWith, d)) return;
            /* A hand-over is written down now rather than at the page's first save, which
               is 400 ms off: a reload before it found no record of this tool in the
               drawer, and the page came back unsaved. The half goes in with the mark, as
               a save does: the mark alone fits in a full storage, and then it named a
               half the drawer did not have. */
            if (noted) {
              d.hash = mergeDesign(d.hash, arrivedWith, o.owns, base);
              d.marks[o.tool] = fp;
              if (saveAll(s)) ours = fp;
              savedInto(d.id);
            }
          }
          /* And the address it arrived at is marked now, with the note, rather than at the
             page's first save: a reload before that save is this arrival again, not
             someone's link, and not the page going back to an earlier layout (see
             arrival). Into a drawer or none. */
          if (arriving) {
            const link = strings(arriving.link);
            markHere(arrivedWith, link.length > 0, { link, open: arriving.open === true });
          }
        }
        paintBar();
      },
      /* After the page writes its local save, and before it writes its design to the
         address bar, which is still the address the save is leaving (see leaving). `link`:
         the settings in `h` still someone's link's, as handoff takes them. */
      wrote(h, link) {
        if (!attached) { savedInto(''); leaving('', '', ours, link); return; }
        const s = loadAll();
        const d = find(s, attached);
        if (!d) {
          attached = null; failing = false; savedInto(''); leaving('', '', ours, link); paintBar(); return;
        }
        // nothing of this page's own to save, and a reload reopens onto the drawer
        if (behind(d, h)) { leaving(d.id, d.marks[o.tool], ours, link); return; }
        const was = d.marks[o.tool], had = ours;
        d.hash = mergeDesign(d.hash, h, o.owns, base);
        d.marks[o.tool] = fingerprint(h);
        d.saved = Date.now();
        const ok = saveAll(s);
        if (ok) { base = sharedOf(h); ours = d.marks[o.tool]; }
        savedInto(d.id);
        /* Refused, the drawer still holds the save before, and the address has the page's
           change, past the save the page last made into it (had): a reload that raced this
           save keeps it, rather than reopening onto the older half. */
        leaving(d.id, ok ? d.marks[o.tool] : was, had, link);
        /* The page's own save shares this storage and fails without a word, but this one is
           promised in so many words — the dialog says changes save into the drawer as you
           work — so a refused save is said, on the bar and in the dialog, until one goes
           through. */
        if (failing !== !ok) {
          failing = !ok;
          paintBar();
          if (el.dialog.open) render();
        }
      },
      /* Before the page navigates to the other tool or the guide with `h` in the address.
         Also saves: the debounced save may not have run yet, and this is the last chance.
         And leaves the note that tells the page at the other end it is a hand-over, which
         drawer it is if any, which settings in it are still someone's link's, and which
         saves of each half they were current with. */
      handoff(h, link) {
        const s = attached && loadAll();
        const d = s && find(s, attached);
        /* `h` is the address for the other page, which can carry more than this one's
           design. A design that cannot be read is no reason to stop the page going: the
           drawer keeps what it has. */
        let mine = null;
        try { mine = o.design(); } catch (err) { mine = null; }
        if (d && typeof mine === 'string' && !behind(d, mine)) {
          d.hash = mergeDesign(d.hash, h, o.owns, base);
          d.saved = Date.now();
          if (saveAll(s)) base = sharedOf(h);
        }
        /* Behind or not, the note says which save this page's half is: one the drawer has
           moved on from comes back from the other page as the drawer has it (restore). */
        handOver(d ? d.id : '', h, false, { link, marks: d ? marksFor(ours) : {} });
      },
    };
  }

  return { create, readDesignFile, designFile, exportProblem, mergeDesign, parsePairs, encodePairs,
           fingerprint, cleanName, binNotes, FileError, CAP, SHARED, STORE, KIND, VERSION };
})();

if (typeof module !== 'undefined') module.exports = DRAWERS;
