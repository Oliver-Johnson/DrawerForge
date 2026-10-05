/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Widgets for the download dialog. Both tools have one, and they must look and read
   the same in both, so the pieces live here rather than being written twice.
 *
 * They take the container element as an argument and know no ids. That is the whole
 * discipline: every getElementById stays in a tool's ui.js, where the build's id audit
 * can see it and fail if the element is missing.
 *
 * Spliced between the core and each tool's ui.js, so DF is simply in scope by the time
 * a ui.js is parsed — no load-order rule to remember, and the three prose pages, which
 * have no dialog, do not ship it.
 */
'use strict';

const DF = {
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
};
