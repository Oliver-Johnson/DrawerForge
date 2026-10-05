/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Widgets for the download dialog. Both tools have one, and they must look and read
   the same in both, so the pieces live here rather than being written twice. The
   map-beside-preview sizing at the end is here on the same grounds.
 *
 * They take the container element as an argument and know no ids. That is the whole
 * discipline: every getElementById stays in a tool's ui.js, where the build's id audit
 * can see it and fail if the element is missing.
 *
 * Spliced between the core and each tool's ui.js, so DF is simply in scope by the time
 * a ui.js is parsed — no load-order rule to remember, and the three prose pages, which
 * have no dialog, do not ship it.
 *
 * One thing here is not a dialog widget: frame(), the arithmetic that fits a 3D preview
 * to what it is showing. It is here for the same reason the rest is — both tools need
 * it, and two copies of it would be two answers to "is the whole drawer in view".
 */
'use strict';

const DF = {
  /* Counted things, written the way a person would say them. The bins page carried
     eleven "bin(s)" and "layer(s)", including one line that managed both "1 bin(s)" and
     "1 bins" in eleven words — a form nobody says out loud, and the clearest sign that
     the text was written for the person who already knew what it meant. The baseplates
     page then turned out to have its own: "4 piece(s)" in the download dialog, "1
     part(s)" on a plate, and a hand-rolled `n > 1 ? 's' : ''` that said "0 piece". One
     helper for both tools, so the next count is written properly by default. Irregulars
     pass their own plural; everything so far takes an s. */
  plural(n, one, many) {
    return `${n} ${n === 1 ? one : many || one + 's'}`;
  },
  /* An STL is an 84-byte header plus 50 bytes a triangle, and a polygon fans into
     verts-2 of them, so the exact file size follows from polygons already in memory. */
  stlBytes(polys) {
    return 84 + 50 * polys.reduce((a, p) => a + p.verts.length - 2, 0);
  },
  bytes(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
                        : Math.max(1, Math.round(n / 1024)) + ' KB';
  },
  group(list, text) {
    const d = document.createElement('div');
    d.className = 'exgroup';
    d.textContent = text;
    list.appendChild(d);
    return d;
  },
  /* A name, a line of detail, one button. Deflating a plate 3MF takes a moment, and
     without the label change the dialog looks like it ignored the click — so people
     click again and get the file twice. */
  row(list, o) {
    const row = document.createElement('div');
    row.className = 'exrow';
    const left = document.createElement('div');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = o.name;
    const mt = document.createElement('span'); mt.className = 'meta'; mt.textContent = o.meta;
    left.appendChild(nm); left.appendChild(mt);
    const btn = document.createElement('button');
    btn.className = 'ghost'; btn.type = 'button'; btn.textContent = o.label || 'Download';
    for (const k in (o.attrs || {})) btn.setAttribute(k, o.attrs[k]);
    btn.addEventListener('click', () => {
      const was = btn.textContent;
      btn.disabled = true; btn.textContent = 'Working…';
      Promise.resolve().then(o.onClick).catch((e) => {
        console.error('download failed', e);
        btn.textContent = 'Failed';
      }).then(() => {
        if (btn.textContent === 'Failed') return;
        btn.textContent = was; btn.disabled = false;
      });
    });
    row.appendChild(left); row.appendChild(btn);
    list.appendChild(row);
    return btn;
  },

  /* How far back a perspective camera has to stand to see all of a box.
   *
   * Both previews used to guess. Bins stood at 600 mm whatever the drawer, and
   * baseplates at one and a half times the drawer's longer side — and neither asked
   * what shape the canvas was. A preview that is tall and narrow (Bins beside its map at
   * 1366 px is 516 × 966) needs the camera much further back than a wide one for the
   * same drawer, so the default drawer showed one corner there, ran off two edges at
   * 1920, and a 600 × 500 drawer was cropped everywhere.
   *
   * This is the exact answer rather than a better guess. Each corner of the box is put
   * into the camera's own frame — right, up, and depth along the line of sight — and a
   * corner `x` across at depth `d` is on screen when |x| <= d · tan(half-fov). Solving
   * that for the distance gives one lower bound per corner per axis; the largest of
   * them is the distance. `margin` is the fraction of the half-view kept clear at the
   * edge, so the outline does not sit under the canvas border or the buttons on it.
   *
   * The camera looks at the CENTRE of the box, and orbits about it afterwards. Centring
   * the projected outline on screen instead would frame a little tighter — the near
   * edge of a drawer seen from above is drawn bigger than the far one, so the picture
   * sits low — but it moves the pivot off the middle of the model, and then the first
   * rotation swings the drawer out of frame. A slack strip at the far edge is the
   * cheaper fault.
   *
   * `dir` points from the target to the camera, `up` is the world's up. Plain arrays
   * rather than THREE vectors so the two tools, whose scenes disagree about which axis
   * is up, pass in their own and nothing here has to know. */
  frame(box, dir, up, fovDeg, aspect, margin) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                             a[2] * b[0] - a[0] * b[2],
                             a[0] * b[1] - a[1] * b[0]];
    const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1;
                          return [a[0] / l, a[1] / l, a[2] / l]; };
    const c = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
    const fwd = unit([-dir[0], -dir[1], -dir[2]]);
    // looking straight down the up axis leaves right undefined; any horizontal will do
    let right = cross(fwd, up);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) right = cross(fwd, [up[1], up[2], up[0]]);
    right = unit(right);
    const upv = cross(right, fwd);
    const tv = Math.tan(fovDeg * Math.PI / 360) * (1 - margin);
    const th = tv * aspect;
    let dist = 0;
    for (let i = 0; i < 8; i++) {
      const q = [(i & 1 ? box.max[0] : box.min[0]) - c[0],
                 (i & 2 ? box.max[1] : box.min[1]) - c[1],
                 (i & 4 ? box.max[2] : box.min[2]) - c[2]];
      const z = dot(q, fwd);
      // the + 1 keeps the nearest corner beyond a near plane of 1, should a box ever
      // be thin enough edge-on that neither width nor height asks for any distance
      dist = Math.max(dist, Math.abs(dot(q, right)) / th - z,
                      Math.abs(dot(q, upv)) / tv - z, 1 - z);
    }
    return { target: c, dist };
  },

  /* ---- the map beside the preview -------------------------------------------
     Not a dialog widget, but shared for the same reason: both tools put their map and
     their 3D preview in one .stagetop row — side by side when the stylesheet gives the
     row two columns, the preview underneath when it gives one — and it has to behave
     the same in both. It took the bins page two shipped bugs to get right, and the
     baseplates page arriving at the same layout later is exactly how a third happens.

     The map's column is sized from the map, as an inline grid-template-columns, and the
     map from the room it has. Both halves have a trap:
       - an inline style beats the media query that collapses the row to one column,
         so the column count is asked of the element with the inline style cleared.
         That keeps the breakpoint in the stylesheet, the one place it lives;
       - the map's own container IS the column being sized, so measuring it makes each
         depend on the other. The row is measured instead: it is as wide as the stage's
         content box whatever its columns hold.
     stageRow() answers both before a map is sized, and pairColumns() states the columns
     once it is. Callers toggle .wide first, since that also collapses the row.

     It also leaves two things for the stylesheet. `.paired` says the preview is beside
     the map, where its height comes from the row. `--room` is the height of the stage
     you can see, for when it is not beside it: the stage is exactly the window under the
     header and is the thing that scrolls, so that is the space a preview below the map
     has to fit in. Stacked on a phone the stage is as tall as its content and it is
     the window that scrolls, which is why the window caps it.

     `big` is how much taller the window is than the 1080 lines both maps' size caps
     were tuned on, and never less than 1. The caps were fixed pixels, so from 2560 to
     5120 px wide the cut map stayed 391 × 454 and a bins cell 52 px while everything
     round them grew; each tool multiplies its caps by this, which keeps a 1080 screen
     exactly as it was and grows a 1440 one by a third. Height rather than width,
     because height is what the maps are short of — an ultrawide is not a bigger map. */
  stageRow(top, stage) {
    top.style.gridTemplateColumns = '';
    top.classList.remove('paired');
    const cs = getComputedStyle(top);
    const pad = stage ? parseFloat(getComputedStyle(stage).paddingTop) || 0 : 0;
    const room = Math.min(stage ? stage.clientHeight : Infinity, window.innerHeight || 900) - pad;
    top.style.setProperty('--room', Math.round(room) + 'px');
    return { two: cs.gridTemplateColumns.trim().split(/\s+/).length > 1,
             width: top.clientWidth, gap: parseFloat(cs.columnGap) || 0, room,
             big: Math.max(1, (window.innerHeight || 900) / 1080) };
  },
  /* Beside the map the preview takes the row's height, which is the map card's — and
     a short map card next to a very wide column is a letterbox: the cut map's default
     drawer left a 4243 × 484 px strip at 5120 wide, which nobody can usefully turn a
     model in (under the map it had been 4678 × 380). --pmin keeps it no more than two
     and a half times as wide as it is tall, whatever the map leaves it; the
     stylesheet makes it a floor under the preview's height. */
  pairColumns(top, mapCol, previewMin) {
    top.style.gridTemplateColumns = `${Math.round(mapCol)}px minmax(${previewMin}px, 1fr)`;
    top.classList.add('paired');
    const gap = parseFloat(getComputedStyle(top).columnGap) || 0;
    const previewW = Math.max(previewMin, top.clientWidth - mapCol - gap);
    top.style.setProperty('--pmin', Math.round(previewW / 2.5) + 'px');
  },
};
