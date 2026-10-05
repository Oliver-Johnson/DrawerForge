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

  /* A name is shown on the page and nowhere else, always as text. Control characters go
     because they have no business in a label, and the bidirectional overrides because
     they can make one name display as another — the list is how you tell drawers apart. */
  function cleanName(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, CAP.name).trim();
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

  /* One drawer, two pages writing to it. Each page's design string carries the other
     page's keys too — that is how the carry works — but its copy of them is only as new
     as the moment it was handed over, so a page that wrote its whole string would put
     back the other page's half as it stood then. Each writes the keys it owns and keeps
     everyone else's from what is stored. The drawer's width and depth are owned by both,
     and the last page to change them wins, which is what the carry already does. */
  function mergeDesign(stored, mine, owns) {
    const theirs = (parsePairs(stored) || []).filter(([k]) => !owns(k));
    const ours = (parsePairs(mine) || []).filter(([k]) => owns(k));
    return encodePairs(theirs.concat(ours));
  }

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
  function designFile(list, when) {
    return JSON.stringify({
      drawerforge: KIND,
      version: VERSION,
      exported: (when || new Date()).toISOString(),
      about: 'Drawerforge design file. To load it, open https://drawerforge.co.uk, press the ' +
             'drawer button under the page links, then "Import a design file".',
      drawers: list.map((d) => {
        const design = {};
        for (const [k, v] of parsePairs(d.hash) || []) if (KEY_RE.test(k)) design[k] = v;
        return { name: d.name, design };
      }),
    }, null, 2) + '\n';
  }

  // the only errors readDesignFile throws, so a message from one is fit to show as it is
  class FileError extends Error {}
  const nope = (msg) => new FileError(msg);

  /* A design file is untrusted input: it may come from anyone, made by anything. So it
     is checked all the way through before any of it is kept, and anything that is not
     exactly what designFile writes is refused with the reason, rather than repaired by
     a guess. Nothing in it is ever evaluated or put into the page as markup: names go in
     as text, and each design becomes a link string, which is what a pasted share link is
     already — the pages read every value through a form field or a number parse. */
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
    return data.drawers.map((d, i) => {
      const which = data.drawers.length > 1 ? `Drawer ${i + 1} in that file` : 'The drawer in that file';
      if (!isPlain(d)) throw nope(`${which} is not a drawer.`);
      const name = cleanName(d.name);
      if (!name) throw nope(`${which} has no name.`);
      const it = data.drawers.length > 1 ? `“${name}” (drawer ${i + 1} in that file)` : `“${name}”`;
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
        pairs.push([k, s]);
      }
      if (pairs.length > CAP.keys) throw nope(`${it} has more settings than any design has.`);
      /* Both tools always write the drawer's size, and without it there is nothing to
         build, so a design missing it is not a design. */
      const num = (k) => { const p = pairs.find((q) => q[0] === k); return p ? parseFloat(p[1]) : NaN; };
      if (!(num('w') > 0) || !(num('d') > 0))
        throw nope(`${it} has no drawer width and depth, so it does not describe a drawer.`);
      const hash = encodePairs(pairs);
      if (hash.length > CAP.design) throw nope(`${it} is far larger than a design is.`);
      return { name, hash };
    });
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
      const c = name.slice(0, CAP.name - tail.length).trim() + tail;
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
   * o.design  () => this page's design string, exactly as its share link carries it
   * o.stop    () => cancel any save still pending, before the page is replaced
   * o.els     the elements, looked up by the tool's ui.js
   */
  function create(o) {
    const el = o.els;
    const other = o.tool === 'plates' ? 'Bins' : 'Baseplates';
    let attached = null;     // the drawer this page saves into, or null for an unsaved design
    let fresh = false;       // arrived with nothing to restore
    let bootDesign = '';
    let armed = '';          // 'open:id' or 'del:id' — the first press of a two-press action
    let renaming = '';

    const find = (s, id) => s.drawers.find((d) => d.id === id) || null;
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
      if (attached && !d) attached = null;     // deleted on another tab
      el.name.textContent = d ? d.name : 'not saved';
      el.name.classList.toggle('none', !d);
      /* The visible text is just the name, which says nothing about what pressing it does,
         so the accessible name says both — starting with the words on screen. */
      el.button.setAttribute('aria-label', d ? `${d.name}: the drawer that is open. Your drawers`
                                             : 'Not saved as a drawer. Your drawers');
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

      el.now.textContent = cur
        ? `Open now: “${cur.name}”. Changes save into it as you work, here and on ${other}.`
        : 'The design on screen is not saved as a drawer. Give it a name below to keep it, ' +
          'baseplate and bins together.';
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
      /* The mark is how the reloaded page knows the design it finds in its address bar is
         this drawer, and so keeps saving into it — see attach. */
      d.marks.open = fingerprint(d.hash);
      saveAll(s);
      o.stop();
      /* replaceState and a reload rather than a navigation: the drawer you switched away
         from is not a page you went back from, and the back button should not offer it. */
      try { history.replaceState(null, '', '#' + d.hash); location.reload(); }
      catch (err) { location.replace('#' + d.hash); }   // the page reloads on hashchange
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
      if (wasOpen) attached = null;
      armed = '';
      render();
      say(`Deleted “${d.name}”.` + (wasOpen
        ? ' Its design is still on screen, no longer saved as a drawer.' : ''));
    }

    /* The open drawer is exported as it stands this moment, not as of its last save,
       which may be a debounce behind the last edit. */
    const live = (d) => (d.id === attached ? mergeDesign(d.hash, o.design(), o.owns) : d.hash);
    function exportOne() {
      const s = loadAll();
      const cur = attached && find(s, attached);
      const rec = cur ? { name: cur.name, hash: live(cur) } : { name: 'Unsaved drawer', hash: o.design() };
      download(designFile([rec]), `drawerforge-${slug(rec.name)}.json`);
      say(`Exported “${rec.name}” as a design file.`);
    }
    function exportAll() {
      const s = loadAll();
      if (!s.drawers.length) return;
      const list = s.drawers.slice().sort(byName).map((d) => ({ name: d.name, hash: live(d) }));
      download(designFile(list), `drawerforge-${list.length}-drawers.json`);
      say(`Exported all ${list.length} drawer${list.length === 1 ? '' : 's'} as one design file.`);
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
        if (s.drawers.length + got.length > CAP.drawers) {
          say(`That would make more than ${CAP.drawers} drawers, which is as many as this page ` +
            'keeps. Delete some first.', 'bad');
          return;
        }
        const added = [];
        for (const g of got) {
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
        say(added.length === 1
          ? `Added “${added[0]}” to your drawers. Open it below to load it.`
          : `Added ${added.length} drawers: ${added.map((n) => `“${n}”`).join(', ')}. Open one below to load it.`);
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

    return {
      /* Which drawer, if any, the design this page arrived with belongs to.
       *
       * The obvious answer — "whichever drawer was open last" — is wrong in the case that
       * matters. Follow someone's shared link while your Kitchen drawer is open and the
       * page would save their design into your Kitchen. Start fresh would overwrite it
       * with the defaults. So a page belongs to a drawer only when the string it arrived
       * with is one this browser wrote for that drawer: its own last save (a reload, or
       * the bare site restoring the local copy), the hand-over from the other tool or
       * the guide, or the drawer being opened from the list. Each drawer keeps the
       * fingerprint of the latest of each. Anything else — a link from someone else, a
       * fresh start — arrives unsaved, and nothing of yours is written over.
       *
       * Called once the page has loaded its design and drawn it, so that `bootDesign` is
       * what an untouched page looks like. */
      attach(arrivedWith) {
        fresh = !arrivedWith;
        bootDesign = o.design();
        attached = null;
        if (arrivedWith) {
          const fp = fingerprint(arrivedWith);
          const hit = loadAll().drawers
            .filter((d) => Object.values(d.marks).includes(fp))
            .sort((a, b) => b.saved - a.saved)[0];
          if (hit) attached = hit.id;
        }
        paintBar();
      },
      /* After the page writes its design to the address bar and its local save. */
      wrote(h) {
        if (!attached) return;
        const s = loadAll();
        const d = find(s, attached);
        if (!d) { attached = null; paintBar(); return; }
        d.hash = mergeDesign(d.hash, h, o.owns);
        d.marks[o.tool] = fingerprint(h);
        d.saved = Date.now();
        saveAll(s);   // a failure here loses no more than the page's own save already does
      },
      /* Before the page navigates to the other tool or the guide with `h` in the address.
         Also saves: the debounced save may not have run yet, and this is the last chance. */
      handoff(h) {
        if (!attached) return;
        const s = loadAll();
        const d = find(s, attached);
        if (!d) return;
        d.hash = mergeDesign(d.hash, h, o.owns);
        d.marks.out = fingerprint(h);
        d.saved = Date.now();
        saveAll(s);
      },
    };
  }

  return { create, readDesignFile, designFile, mergeDesign, parsePairs, encodePairs,
           fingerprint, cleanName, FileError, CAP, STORE, KIND, VERSION };
})();

if (typeof module !== 'undefined') module.exports = DRAWERS;
