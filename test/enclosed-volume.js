/* The plastic a mesh is made of: the volume its shells enclose between them, counted once
 * where they overlap.
 *
 * A bin is built of closed shells that overlap on purpose (bin.js: BLOAT, and the wall
 * ring buried in the floor slab), so adding up each shell's signed volume, as the page's
 * meshVolume does, counts the plastic in every overlap twice: 2 to 11% more than there
 * is in a plain bin, the most on small bins with thick walls, and up to a quarter more
 * in one with holes in its feet, which are built of overlapping bands. What a slicer
 * prints is the shells' union, and this measures that.
 *
 * Straight up through the mesh on a grid `step` apart, offset from every round
 * coordinate: each face a ray crosses adds one to the count of shells it is inside, or
 * takes one away, as the face looks down or up, and the length of the ray inside at
 * least one is summed. At 0.1 mm it agrees with a 0.04 mm grid to 0.2% on bins whole,
 * half and carved, with holes and with dividers; coarser grids beat against the
 * geometry's own spacings and wander by a percent or more.
 */
'use strict';

function enclosedVolume(polys, step = 0.1) {
  const T = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) {
    const q = p.verts;
    for (let i = 1; i + 1 < q.length; i++) {
      const a = q[0], b = q[i], c = q[i + 1];
      const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(area2) < 1e-12) continue;          // standing on edge: no ray crosses it
      const t = { a, b, c, area2,
                  lx: Math.min(a[0], b[0], c[0]), hx: Math.max(a[0], b[0], c[0]),
                  ly: Math.min(a[1], b[1], c[1]), hy: Math.max(a[1], b[1], c[1]) };
      T.push(t);
      x0 = Math.min(x0, t.lx); x1 = Math.max(x1, t.hx); y0 = Math.min(y0, t.ly); y1 = Math.max(y1, t.hy);
    }
  }
  if (!T.length) return 0;
  // faces bucketed on a 2 mm grid in plan, so a ray only tries the ones near it
  const cs = 2, nx = Math.ceil((x1 - x0) / cs) + 1, ny = Math.ceil((y1 - y0) / cs) + 1;
  const grid = Array.from({ length: nx * ny }, () => []);
  for (const t of T)
    for (let i = Math.floor((t.lx - x0) / cs); i <= Math.floor((t.hx - x0) / cs); i++)
      for (let j = Math.floor((t.ly - y0) / cs); j <= Math.floor((t.hy - y0) / cs); j++)
        grid[i + j * nx].push(t);
  const jx = 0.0731, jy = 0.1373;
  let vol = 0;
  for (let i = -1; x0 + (i + jx) * step < x1 + step; i++)
    for (let j = -1; y0 + (j + jy) * step < y1 + step; j++) {
      const x = x0 + (i + 0.5 + jx) * step, y = y0 + (j + 0.5 + jy) * step;
      const bi = Math.floor((x - x0) / cs), bj = Math.floor((y - y0) / cs);
      if (bi < 0 || bj < 0 || bi >= nx || bj >= ny) continue;
      const hits = [];
      for (const t of grid[bi + bj * nx]) {
        if (x < t.lx || x > t.hx || y < t.ly || y > t.hy) continue;
        const { a, b, c, area2 } = t;
        const w1 = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / area2;
        const w2 = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / area2;
        const w3 = 1 - w1 - w2;
        if (w1 < 0 || w2 < 0 || w3 < 0) continue;
        hits.push([w1 * a[2] + w2 * b[2] + w3 * c[2], area2 > 0 ? -1 : 1]);   // looking up: leaving
      }
      hits.sort((p, q) => p[0] - q[0]);
      for (let k = 1, inside = hits.length ? hits[0][1] : 0; k < hits.length; k++) {
        if (inside > 0) vol += hits[k][0] - hits[k - 1][0];
        inside += hits[k][1];
      }
    }
  return vol * step * step;
}

module.exports = { enclosedVolume };
