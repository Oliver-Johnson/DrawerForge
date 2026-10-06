/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* What a job costs and roughly how long it prints: the two questions after "how much
 * filament", and the two the tools did not answer. Both tools quote grams per part, per
 * plate and in total; this turns grams into money and a plate into a duration, the same
 * way on both pages, because two copies of an estimate are two estimates.
 *
 * The price is the person's, not the design's. It lives on this device, under one key
 * both tools read, and never in the link: a friend's link must not tell you what your
 * filament costs, and yours must not tell them. Empty until someone types one, and while
 * it is empty no money is shown anywhere — a cost worked out from a price we made up,
 * in a currency we guessed, is a number people would quote back to us as ours.
 *
 * Same discipline as widgets.js and fields.js: everything takes its elements as
 * arguments and knows no ids, so every getElementById stays in a tool's ui.js where the
 * build's id audit can see it.
 */
'use strict';

const ESTIMATE = (() => {
  /* ---- the price, and the printer speed override ---------------------------------
   * One key for both, read by both tools, as JSON so either can grow a field without a
   * second key to keep in step. Every read and write is wrapped: private windows and
   * blocked storage throw on access, and a full quota throws on write, and in all of
   * those the fields still work for the visit — they are just not remembered. */
  const KEY = 'drawerforge:filament:v1';
  /* A symbol, or none. A short fixed list rather than a currency code per country: it is
     a label beside a number the person typed, nothing is converted, and "none" is there
     for anyone whose symbol is not on it, who then sees the number alone. Prefixed with
     a full stop for the decimals, like every other figure on these pages. */
  const SYMBOLS = ['£', '€', '$', ''];
  /* The starting symbol, from the browser's region — en-GB is £, de-DE €, en-US $ — and
     none at all when the language names no region, or one that uses another currency.
     Only a default for the menu: nothing is shown until a price is typed beside it, and
     whatever the person picks is what is kept. */
  const POUND = ['GB', 'GG', 'GI', 'IM', 'JE'];
  const EURO = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT',
                'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
  const DOLLAR = ['AU', 'CA', 'HK', 'NZ', 'SG', 'US'];
  function regionSymbol(langs) {
    for (const l of langs || []) {
      const m = /^[a-z]{2,3}(?:-[a-z]{4})?-([a-z]{2})(?:-|$)/i.exec(String(l || ''));
      if (!m) continue;
      const r = m[1].toUpperCase();
      return POUND.includes(r) ? '£' : EURO.includes(r) ? '€' : DOLLAR.includes(r) ? '$' : '';
    }
    return '';
  }
  const browserLangs = () => {
    try { return navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]; }
    catch (err) { return []; }
  };
  const SPEED_CHOICES = ['auto', 'fast', 'standard'];
  // past any real spool, and well short of a typo the size of a phone number
  const PRICE_MAX = 10000;
  const priceOf = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.min(v, PRICE_MAX) : null);

  function load() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (err) { p = null; }
    if (!p || typeof p !== 'object') p = {};
    return {
      price: priceOf(p.price),
      sym: SYMBOLS.includes(p.sym) ? p.sym : regionSymbol(browserLangs()),
      speed: SPEED_CHOICES.includes(p.speed) ? p.speed : 'auto',
    };
  }
  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); }
    catch (err) { /* private mode, or the quota is full: the fields still work for this
                     visit, they are just not remembered */ }
  }

  /* ---- money ---------------------------------------------------------------------
   * Two decimals, always: a bin is pennies, and 0.4 next to 0.42 reads as two different
   * kinds of number. Empty when there is no price, which is how every caller knows to
   * leave the money out rather than print a zero. */
  const money = (amount, sym) => `${sym}${amount.toFixed(2)}`;
  const cost = (grams, prefs) =>
    (prefs && prefs.price && isFinite(grams) ? money(grams / 1000 * prefs.price, prefs.sym) : '');
  const perKg = (prefs) => (prefs && prefs.price ? `${money(prefs.price, prefs.sym)}/kg` : '');

  /* ---- print time ----------------------------------------------------------------
   * A rough guess, and it says so wherever it is shown: only a slicer knows the paths,
   * the speeds and the accelerations, and this knows none of them. What it does know is
   * how much plastic a plate is and how tall it stands, and that is most of a print.
   *
   *   time = warm-up
   *        + filament volume / an effective volumetric rate
   *        + every layer x a layer-change overhead
   *        + every layer of every part x an overhead per part
   *
   * The rate is an average over a whole print — outer walls slow, infill fast, every
   * corner an acceleration — not the hotend's limit, which is two to four times higher
   * and which nobody's print averages. A bin or a baseplate is nearly all perimeter, so
   * the rate is set from wall speeds. A classic bed-slinger's stock profile runs walls
   * at 25 to 50 mm/s, and a 0.42 × 0.2 mm line at those is 2.1 to 4.2 mm³/s: 3 mm³/s,
   * about 13 g of PLA an hour. A fast printer's runs them at 150 to 300 mm/s but cannot
   * reach that on a 40 mm bin wall before it has to slow for the corner, and generic
   * PLA profiles cap the flow at 12 mm³/s or so: 8 mm³/s, about 36 g an hour. Both sit
   * at the slow end of what those printers are seen to do on bins.
   *
   * The layer terms are the time spent not extruding: the z move and the wipe on every
   * layer, and the travel to each part and the retraction either side of it, once per
   * part per layer, so a plate of nine small bins is slower than one bin of the same
   * weight. 0.2 mm layers, because that is what nearly everyone prints these at. The
   * warm-up is heating, bed levelling and the purge line, once a plate; six minutes is
   * on the long side of a printer that levels itself before every print.
   *
   * With those, before rounding, a 1×1×3 bin is about 35 minutes fast and 70 standard,
   * a 2×2×3 about 75 minutes and 2 h 55, and a 5 × 5 baseplate about 1 h 20 and 3 h 15.
   *
   * Conservative on purpose — a print that finishes early is a pleasant surprise and
   * one that runs past bedtime is not — and rounded up to the next 5 minutes under an
   * hour and the next 15 above, so it never claims a precision it does not have. */
  const LAYER = 0.2;              // mm
  const WARMUP_S = 6 * 60;        // heat, level, purge: once a plate
  const SPEEDS = {
    // CoreXY and input-shaped printers: Bambu Lab, Prusa MK4 and CORE One, Voron, K1
    fast: { rate: 8, layerS: 4, partS: 1.5, name: 'fast' },
    // classic bed-slingers: an Ender 3, a Prusa MK3, anything not known to be fast
    standard: { rate: 3, layerS: 6, partS: 3, name: 'standard' },
  };
  /* What every total time is followed by, in both tools, so none of them can be read as
     a promise. */
  const ROUGH = 'a rough estimate; only your slicer can time it exactly';
  /* Seconds for one plate. `parts` is what is on it, each { vol, h, z }: the filament it
     takes in mm³, its height and the height it starts at (a part stacked on another
     starts above the bed, and the plate is as tall as its tallest stack). */
  function plateSeconds(parts, cls) {
    const s = SPEEDS[cls] || SPEEDS.standard;
    let vol = 0, top = 0, partLayers = 0;
    for (const p of parts) {
      vol += Math.max(0, p.vol || 0);
      top = Math.max(top, (p.z || 0) + (p.h || 0));
      partLayers += Math.ceil((p.h || 0) / LAYER - 1e-9);
    }
    return WARMUP_S + vol / s.rate + Math.ceil(top / LAYER - 1e-9) * s.layerS + partLayers * s.partS;
  }
  // whole minutes, rounded up: to the next 5 under an hour and the next 15 from there
  function roundMinutes(sec) {
    const m = Math.max(0, sec) / 60;
    const step = m < 60 ? 5 : 15;
    return Math.max(step, Math.ceil(m / step - 1e-9) * step);
  }
  const duration = (min) => {
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h` + (m ? ` ${m} min` : '') : `${m} min`;
  };
  /* Which kind of printer the time is for. The override wins; otherwise the printer list
     says, from the data-speed tools/printers.js writes on the options it knows to be fast,
     and everything else — the size-only entries, Custom, a printer we have no figure
     for — is timed as standard, which is the slower and so the safer guess. */
  const listedSpeed = (select) => {
    const o = select && select.selectedOptions && select.selectedOptions[0];
    return o && o.dataset && o.dataset.speed === 'fast' ? 'fast' : 'standard';
  };
  const speedOf = (select, prefs) =>
    (prefs && SPEEDS[prefs.speed] ? prefs.speed : listedSpeed(select));

  /* ---- the fields ----------------------------------------------------------------
   * The price, the symbol and the speed override, in panel 02 of both tools. Filled from
   * storage at load, saved on every edit, and refilled when the other tool — or this one
   * in another tab — changes them, so a price typed on one page is the price on the
   * other without a reload. `onChange` is the tool's own redraw. */
  function bind(els, onChange) {
    let prefs = load();
    const show = () => {
      if (document.activeElement !== els.price)
        els.price.value = prefs.price === null ? '' : String(prefs.price);
      els.sym.value = prefs.sym;
      els.speed.value = prefs.speed;
    };
    show();
    const read = () => {
      prefs = { price: priceOf(parseFloat(els.price.value)), sym: els.sym.value,
                speed: SPEED_CHOICES.includes(els.speed.value) ? els.speed.value : 'auto' };
      save(prefs);
      onChange();
    };
    els.price.addEventListener('input', read);
    els.sym.addEventListener('change', read);
    els.speed.addEventListener('change', read);
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      prefs = load(); show(); onChange();
    });
    return { get: () => prefs };
  }
  /* The automatic entry says what it has decided, so nobody has to know the list of
     fast printers to know which time they are being given. */
  function labelAuto(speedSelect, printerSelect) {
    const o = speedSelect.querySelector('option[value="auto"]');
    if (o) o.textContent = `From the printer: ${listedSpeed(printerSelect)}`;
  }

  return { KEY, SYMBOLS, SPEEDS, LAYER, ROUGH, regionSymbol, load, cost, perKg, money,
           plateSeconds, roundMinutes, duration, speedOf, listedSpeed, bind, labelAuto };
})();
