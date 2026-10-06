/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* The printers both tools offer by name, and the table the split guide prints of them.
 *
 * One list, written once. It was three: the same five bed sizes typed into each tool's
 * template and a table in the guide, and the copies disagreed — both tools filed the
 * Bambu A1 mini under 220 mm while the guide gave it 180, and the guide put the Bambu
 * A1 at 220 when it is 256. A wrong bed is the one input nothing downstream can catch:
 * every check on the page trusts it, so a printer listed with a bed it does not have
 * produces pieces that fail in the slicer, or on the plate, with the page saying they
 * fit. So the options and the guide table are generated from here at build time, the
 * way tools/joints.js draws the joint figures, and test/guide-facts.js holds all three
 * outputs to this list.
 *
 * Every bed is width × depth × height in millimetres as the MANUFACTURER publishes it,
 * checked against a second source — the slicer profile the maker ships, where there is
 * one. Where the two disagree the smaller figure wins and the entry says why, because
 * a bed quoted a few millimetres generous is exactly the error that makes a six-cell
 * piece look printable on a printer that takes five. A printer that could not be
 * checked is not here: a missing entry costs someone one click on Custom, a wrong one
 * costs them a failed print.
 *
 * `id` travels in the shared link (`pr`), so a link reproduces the entry the sender
 * picked rather than whichever printer happens to share its bed. Ids are permanent:
 * rename the label freely, never the id.
 *
 * `speed: 'fast'` marks a printer that prints well past the speeds of a classic
 * bed-slinger — CoreXY, or input shaping with firmware tuned for it — and only steers
 * the rough print time (src/shared-ui/estimate.js). Absent means standard, which is the
 * slower guess, so a printer is marked only where its maker's own profiles run fast as
 * shipped: a printer that has to be tuned to go fast, or a listing that covers a fast
 * and a slow model under one name (the Ender-3 V3 and V3 SE), is left standard.
 */
'use strict';

const PRINTERS = [
  { maker: 'Anycubic', models: [
    /* Anycubic: 250 × 250 × 260. OrcaSlicer's profile says 255 × 255 — enough for a
       six-cell, 252 mm piece that the published bed cannot take. The maker's figure. */
    { id: 'anycubic-kobra-3', name: 'Kobra 3', bed: [250, 250, 260], speed: 'fast' },
  ] },
  { maker: 'Bambu Lab', models: [
    // bambulab.com tech specs, and Bambu Studio's machine profiles (printable_area)
    { id: 'bambu-a1-mini', name: 'A1 mini', bed: [180, 180, 180], speed: 'fast' },
    { id: 'bambu-a1', name: 'A1', bed: [256, 256, 256], speed: 'fast' },
    { id: 'bambu-p1', name: 'P1S / P1P', bed: [256, 256, 256], speed: 'fast' },
    { id: 'bambu-x1c', name: 'X1 Carbon', bed: [256, 256, 256], speed: 'fast' },
    /* Quoted as 350 × 320 × 325, which is the width the two nozzles cover between them.
       Each reaches 325 of it (Bambu Studio: left nozzle x 0–325, right x 25–350) and a
       one-filament part is printed by one nozzle, so Bambu's single-nozzle figure. */
    { id: 'bambu-h2d', name: 'H2D, one nozzle', bed: [325, 320, 325], speed: 'fast' },
  ] },
  { maker: 'Creality', models: [
    // creality.com specs and its Ender-3 V3 series comparison; OrcaSlicer profiles agree
    { id: 'creality-ender-3-v3', name: 'Ender-3 V3 / V3 SE', bed: [220, 220, 250] },
    { id: 'creality-ender-3-v3-ke', name: 'Ender-3 V3 KE', bed: [220, 220, 240], speed: 'fast' },
    { id: 'creality-k1', name: 'K1 / K1C', bed: [220, 220, 250], speed: 'fast' },
    { id: 'creality-k1-max', name: 'K1 Max', bed: [300, 300, 300], speed: 'fast' },
    { id: 'creality-k2-plus', name: 'K2 Plus', bed: [350, 350, 350], speed: 'fast' },
  ] },
  { maker: 'Elegoo', models: [
    { id: 'elegoo-neptune-4', name: 'Neptune 4 / 4 Pro', bed: [225, 225, 265], speed: 'fast' },
    { id: 'elegoo-centauri-carbon', name: 'Centauri Carbon / Carbon 2', bed: [256, 256, 256], speed: 'fast' },
  ] },
  { maker: 'Prusa', models: [
    // prusa3d.com specs, and PrusaSlicer's bundled profiles (bed_shape, max_print_height)
    { id: 'prusa-mini', name: 'MINI / MINI+', bed: [180, 180, 180] },
    { id: 'prusa-mk4', name: 'MK4 / MK4S', bed: [250, 210, 220], speed: 'fast' },
    { id: 'prusa-core-one', name: 'CORE One', bed: [250, 220, 270], speed: 'fast' },
    { id: 'prusa-xl', name: 'XL', bed: [360, 360, 360], speed: 'fast' },
  ] },
  { maker: 'Sovol', models: [
    { id: 'sovol-sv06', name: 'SV06', bed: [220, 220, 250] },
  ] },
  { maker: 'Voron', models: [
    /* A kit, built in three sizes. X and Y from the Voron 2.4 Klipper config in
       VoronDesign/Voron-2; the height is that config's own position_max for Z, which
       is lower than the size it is named for. */
    { id: 'voron-2.4-250', name: '2.4, 250 mm', bed: [250, 250, 210], speed: 'fast' },
    { id: 'voron-2.4-300', name: '2.4, 300 mm', bed: [300, 300, 260], speed: 'fast' },
    { id: 'voron-2.4-350', name: '2.4, 350 mm', bed: [350, 350, 310], speed: 'fast' },
  ] },
];

/* The sizes the list offered before it named anything. They stay, for two reasons:
   someone whose printer is not above still has a sensible entry to pick, and a saved
   layout or a link made before this list existed carries one of exactly these beds,
   so it reopens on the entry it was made with rather than on Custom. The 256 mm one
   is the default — the bed fields ship at 256 — and is what a fresh page shows. */
const GENERIC = [
  { id: 'bed-180', bed: [180, 180, 180] },
  { id: 'bed-220', bed: [220, 220, 250] },
  { id: 'bed-250x210', bed: [250, 210, 220] },
  { id: 'bed-256', bed: [256, 256, 256], selected: true },
  { id: 'bed-300', bed: [300, 300, 300] },
];

const size = (b) => b.join(' × ');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/* The <option>s inside each tool's #bedPreset. The maker is repeated in every label
   because a closed <select> shows the option and not its group: "A1 mini" on its own
   could be anybody's. The bed rides in data-bed rather than in the value, because
   several printers share one bed and the value has to say which of them you picked. */
function options() {
  /* data-generic marks the size-only entries: they are the ones a link without a
     printer id is matched against — see FIELDS.presetFor. data-speed comes after
     data-bed, which test/guide-facts.js reads straight after the value. */
  const opt = (id, label, bed, extra) =>
    `<option value="${esc(id)}" data-bed="${bed.join(',')}"${extra || ''}>` +
    `${esc(label)}</option>`;
  return PRINTERS.map((g) =>
    `<optgroup label="${esc(g.maker)}">` +
    g.models.map((m) => opt(m.id, `${g.maker} ${m.name} — ${size(m.bed)}`, m.bed,
                            m.speed === 'fast' ? ' data-speed="fast"' : '')).join('') +
    '</optgroup>').join('\n') + '\n' +
    '<optgroup label="Any printer, by bed size">' +
    GENERIC.map((s) => opt(s.id, `${size(s.bed)} mm`, s.bed,
                           ' data-generic' + (s.selected ? ' selected' : ''))).join('') +
    '</optgroup>\n' +
    '<option value="custom">Custom…</option>';
}

/* The split guide's table: one row per bed footprint, every printer with that footprint
   named in it, and the largest piece it takes. Height is left out — a baseplate piece is
   4 mm tall, so it never decides anything here. The cell counts are worked out rather
   than written, and test/guide-facts.js recomputes them from the page anyway. */
function guideRows(pitch) {
  const rows = new Map();
  for (const g of PRINTERS) for (const m of g.models) {
    const key = `${m.bed[0]}x${m.bed[1]}`;
    if (!rows.has(key)) rows.set(key, { w: m.bed[0], d: m.bed[1], makers: new Map() });
    const r = rows.get(key);
    if (!r.makers.has(g.maker)) r.makers.set(g.maker, []);
    r.makers.get(g.maker).push(m.name);
  }
  return [...rows.values()]
    .sort((a, b) => a.w * a.d - b.w * b.d || a.w - b.w)
    .map((r) => {
      const nx = Math.floor(r.w / pitch), ny = Math.floor(r.d / pitch);
      const who = [...r.makers].map(([mk, names]) => `${mk} ${names.join(', ')}`).join('; ');
      return `    <tr><td>${esc(who)}</td><td>${r.w} × ${r.d}</td><td>${nx} × ${ny}</td>` +
             `<td>${nx * pitch} × ${ny * pitch} mm</td></tr>`;
    }).join('\n');
}

module.exports = { PRINTERS, GENERIC, options, guideRows };
