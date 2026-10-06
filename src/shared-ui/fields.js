/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* The two things panels 01 and 02 do the same way in both tools: the unit the drawer is
 * measured in, and the printer list. Here rather than in each ui.js because they have to
 * behave identically on both pages — a drawer typed in inches on one page and read as
 * millimetres on the other is 25 times the wrong size — and two copies of the same
 * thirty lines is how this project has ended up with two answers to one question
 * before.
 *
 * Same discipline as widgets.js: everything takes its elements as arguments and knows
 * no ids, so every getElementById stays in a tool's ui.js where the build's id audit
 * can see it.
 */
'use strict';

const FIELDS = (() => {
  /* ---- the length unit ----------------------------------------------------------
   * The grid is metric and so is everything the tools write — the model, the link, every
   * STL and 3MF. Inches are a way of TYPING a drawer, nothing more: a field shows its
   * length in the chosen unit and hands back millimetres, and nothing past the field
   * ever sees an inch. That is what keeps a link made in inches identical to one made in
   * millimetres, and an export the same bytes whichever unit you typed in.
   *
   * The unit is a preference of the person, not a property of the drawer, so it lives
   * on the device rather than in the link: someone who measures in inches should get
   * inches on a link a metric friend sent them, and the friend's drawer should be
   * exactly as big as the friend made it. One key for both tools, because a person who
   * measures in inches does so on both pages. */
  const KEY = 'drawerforge:units:v1';
  const MM_PER_IN = 25.4;

  const savedUnit = () => {
    try { return localStorage.getItem(KEY) === 'in' ? 'in' : 'mm'; }
    catch (err) { return 'mm'; }          // private mode: millimetres, as before
  };
  const saveUnit = (u) => {
    try { localStorage.setItem(KEY, u); }
    catch (err) { /* private mode, or the quota is full — the switch still works for
                     this visit, it just will not be remembered */ }
  };

  /* An inch figure as a person would write it. Sixteenths are how inch tapes are
     marked, so a value that IS a sixteenth — 12, 12.5, 12.125, 12.0625 — is shown
     exactly; anything else is a conversion from millimetres and gets two decimals,
     which is a quarter of a millimetre and finer than anyone measures a drawer. */
  const inchText = (mm) => {
    const v = mm / MM_PER_IN;
    const s = Math.round(v * 16);
    if (Math.abs(v - s / 16) < 5e-4) return String(s / 16);
    return String(Math.round(v * 100) / 100);
  };
  const mmText = (mm) => String(Math.round(mm * 1000) / 1000);
  const show = (mm, unit) => unit === 'in' ? inchText(mm) : mmText(mm);

  /* The field remembers the exact millimetres behind what it shows. Switching to inches
     and back would otherwise round a 306 mm drawer to 12.05 in and bring it back as
     306.07 mm — a drawer changed by looking at it in a different unit. So the exact
     value rides on the element, and is used for as long as the text is still the text
     that was written; the moment someone types, what they typed is the value. */
  function setLength(el, mm, unit) {
    el.value = show(mm, unit);
    el.dataset.mm = String(mm);
    el.dataset.shown = el.value;
  }
  /* Millimetres, or NaN for a blank or unreadable field — the caller decides what a
     missing value means, the way it already did. Converted values are rounded to the
     micrometre so 12 in is 304.8 mm and not 304.79999999999995, which is the number a
     shared link would otherwise carry. */
  function lengthOf(el, unit) {
    const raw = el.value.trim();
    if (el.dataset.mm !== undefined && raw === el.dataset.shown) return +el.dataset.mm;
    const v = parseFloat(raw);
    if (!isFinite(v)) return NaN;
    return unit === 'in' ? Math.round(v * MM_PER_IN * 1000) / 1000 : v;
  }

  /* Re-express each field in the new unit, and move its constraints with it. min and max
     are kept as exact conversions rather than tidy ones, so the browser's own validity
     and the tool's range check (which works in millimetres) accept exactly the same
     values. step goes to "any" in inches: a figure converted from millimetres is almost
     never on a tidy step, and a value the tool wrote itself must not be one the browser
     calls invalid. Labels marked data-unit say which unit the field is in now. */
  function convert(els, from, to, root) {
    for (const el of els) {
      if (!('stepMm' in el.dataset)) {
        el.dataset.stepMm = el.getAttribute('step') || '';
        el.dataset.minMm = el.getAttribute('min') || '';
        el.dataset.maxMm = el.getAttribute('max') || '';
      }
      const mm = lengthOf(el, from);
      if (isFinite(mm)) setLength(el, mm, to);
      const lim = (v) => v === '' ? null : to === 'in' ? String(+v / MM_PER_IN) : v;
      const attr = (name, v) => v === null || v === '' ? el.removeAttribute(name)
                                                     : el.setAttribute(name, v);
      attr('step', to === 'in' ? 'any' : el.dataset.stepMm);
      attr('min', lim(el.dataset.minMm));
      attr('max', lim(el.dataset.maxMm));
    }
    for (const s of root.querySelectorAll('[data-unit]')) s.textContent = to;
  }

  /* ---- the printer list ---------------------------------------------------------
   * The options are generated from tools/printers.js at build time. Each carries its bed
   * in data-bed; the value is the printer's id, because several printers share a bed
   * and the value has to say which one you picked. */
  const bedOf = (opt) => opt && opt.dataset.bed ? opt.dataset.bed.split(',').map(Number) : null;
  const sameBed = (opt, bed) => {
    const b = bedOf(opt);
    return !!b && b.every((v, i) => v === bed[i]);
  };

  /* Which entry a bed should show as, when it arrives from a link or a saved layout.
     The id wins when it still describes the bed: a link says which printer, not just
     which size. Without one — a link made before printers had names — only the
     size-only entries are matched, because they are exactly the sizes the old list
     offered, so an old link reopens on the entry it was made with. Matching a named
     printer instead would be a guess: a 256 mm bed is half a dozen printers here.
     Anything else is Custom, which shows the numbers and claims nothing. */
  function presetFor(select, bed, id) {
    const opts = [...select.options];
    if (id === 'custom') return 'custom';
    const named = opts.find((o) => o.value === id);
    if (named && sameBed(named, bed)) return named.value;
    const generic = opts.find((o) => o.hasAttribute('data-generic') && sameBed(o, bed));
    return generic ? generic.value : 'custom';
  }
  /* A bed edited by hand is no longer the printer the list names, so the list stops
     naming it. It used to go on saying "Prusa MK4 class" over a bed someone had typed
     300 into. */
  function followBed(select, bed) {
    if (select.value !== 'custom' && !sameBed(select.selectedOptions[0], bed))
      select.value = 'custom';
  }

  return { MM_PER_IN, savedUnit, saveUnit, inchText, show, setLength, lengthOf, convert,
           bedOf, presetFor, followBed };
})();
