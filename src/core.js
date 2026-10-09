
/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Drawerforge — Gridfinity geometry core.
   Self-contained CSG (BSP) + gridfinity builders + binary STL writer.
   Runs in browser and Node (module.exports guard at bottom). */
'use strict';

const EPS = 1e-5;

// ---------- vectors ----------
const V = {
  sub: (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]],
  add: (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
  scale: (a, s) => [a[0]*s, a[1]*s, a[2]*s],
  dot: (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
  cross: (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => { const l = V.len(a); return [a[0]/l, a[1]/l, a[2]/l]; },
  lerp: (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t],
};

// ---------- polygon / plane ----------
function planeFromPoints(a, b, c) {
  const n = V.unit(V.cross(V.sub(b, a), V.sub(c, a)));
  return { n, w: V.dot(n, a) };
}
function makePoly(verts) {
  // pick 3 well-spread verts for a stable plane
  let plane = null;
  for (let i = 2; i < verts.length; i++) {
    const n = V.cross(V.sub(verts[1], verts[0]), V.sub(verts[i], verts[0]));
    if (V.len(n) > 1e-9) { plane = planeFromPoints(verts[0], verts[1], verts[i]); break; }
  }
  if (!plane) return null;
  return { verts, plane };
}
function flipPoly(p) {
  return { verts: p.verts.slice().reverse(), plane: { n: V.scale(p.plane.n, -1), w: -p.plane.w } };
}

// ---------- BSP ----------
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
function splitPolygon(plane, poly, coplanarFront, coplanarBack, front, back) {
  /* A polygon that carries this exact plane is coplanar with it, whatever its vertices
     say. Classifying by vertex distance alone is what let `build` fail to terminate: it
     takes a splitting plane from one of the polygons it is about to sort, and if that
     polygon's own vertices have drifted off it by more than EPS — a repaired mesh can be
     a micron out — then nothing lands in the node, every polygon goes to the same child,
     and the child repeats the choice forever. Growing a tree until the heap runs out is
     an alarming way to find that out. */
  const pn = poly.plane;
  const dn = pn.n[0]*plane.n[0] + pn.n[1]*plane.n[1] + pn.n[2]*plane.n[2];
  if (dn > 1 - 1e-9 && Math.abs(pn.w - plane.w) < 1e-9) { coplanarFront.push(poly); return; }
  if (dn < -1 + 1e-9 && Math.abs(pn.w + plane.w) < 1e-9) { coplanarBack.push(poly); return; }
  let polyType = 0;
  const types = [];
  for (const v of poly.verts) {
    const t = V.dot(plane.n, v) - plane.w;
    const type = (t < -EPS) ? BACK : (t > EPS) ? FRONT : COPLANAR;
    polyType |= type; types.push(type);
  }
  switch (polyType) {
    case COPLANAR:
      (V.dot(plane.n, poly.plane.n) > 0 ? coplanarFront : coplanarBack).push(poly); break;
    case FRONT: front.push(poly); break;
    case BACK: back.push(poly); break;
    case SPANNING: {
      const f = [], b = [];
      const n = poly.verts.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ti = types[i], tj = types[j];
        const vi = poly.verts[i], vj = poly.verts[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(vi);
        if ((ti | tj) === SPANNING) {
          const t = (plane.w - V.dot(plane.n, vi)) / V.dot(plane.n, V.sub(vj, vi));
          const v = V.lerp(vi, vj, t);
          f.push(v); b.push(v);
        }
      }
      if (f.length >= 3) { const p = makePoly(f); if (p) { p.plane = poly.plane; front.push(p); } }
      if (b.length >= 3) { const p = makePoly(b); if (p) { p.plane = poly.plane; back.push(p); } }
      break;
    }
  }
}
/* Named BspNode, not Node, and the prefix is load-bearing rather than decorative. This
   file is SPLICED into the page, so a bare `class Node` at top level shadows the DOM's
   Node for every script that follows it — `Node.DOCUMENT_POSITION_PRECEDING` reads
   undefined on both tools, and an assertion comparing against undefined passes while
   measuring nothing. That is what it did in test/ui/a11y.spec.js, which now says
   window.Node to route around it. Nothing here needs the name. */
class BspNode {
  constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
  invert() {
    const stack = [this];
    while (stack.length) {
      const nd = stack.pop();
      for (let i = 0; i < nd.polys.length; i++) nd.polys[i] = flipPoly(nd.polys[i]);
      if (nd.plane) nd.plane = { n: V.scale(nd.plane.n, -1), w: -nd.plane.w };
      const t = nd.front; nd.front = nd.back; nd.back = t;
      if (nd.front) stack.push(nd.front);
      if (nd.back) stack.push(nd.back);
    }
  }
  clipPolygons(polys) {
    // iterative: worklist of (node, polys)
    let out = [];
    const stack = [[this, polys]];
    while (stack.length) {
      const [nd, ps] = stack.pop();
      if (!nd.plane) { out = out.concat(ps); continue; }
      const front = [], back = [];
      for (const p of ps) splitPolygon(nd.plane, p, front, back, front, back);
      if (nd.front) { if (front.length) stack.push([nd.front, front]); }
      else out = out.concat(front);
      if (nd.back && back.length) stack.push([nd.back, back]);
      // no back child => back polys are inside: dropped
    }
    return out;
  }
  clipTo(bsp) {
    const stack = [this];
    while (stack.length) {
      const nd = stack.pop();
      nd.polys = bsp.clipPolygons(nd.polys);
      if (nd.front) stack.push(nd.front);
      if (nd.back) stack.push(nd.back);
    }
  }
  allPolygons() {
    let ps = [];
    const stack = [this];
    while (stack.length) {
      const nd = stack.pop();
      ps = ps.concat(nd.polys);
      if (nd.front) stack.push(nd.front);
      if (nd.back) stack.push(nd.back);
    }
    return ps;
  }
  build(polys) {
    const stack = [[this, polys]];
    while (stack.length) {
      const [nd, ps] = stack.pop();
      if (!ps.length) continue;
      if (!nd.plane) {
        const mid = ps[ps.length >> 1];
        nd.plane = { n: mid.plane.n.slice(), w: mid.plane.w };
      }
      const front = [], back = [];
      for (const p of ps) splitPolygon(nd.plane, p, nd.polys, nd.polys, front, back);
      if (front.length) { if (!nd.front) nd.front = new BspNode(); stack.push([nd.front, front]); }
      if (back.length) { if (!nd.back) nd.back = new BspNode(); stack.push([nd.back, back]); }
    }
  }
}
/* ---------- repairing what a BSP subtraction leaves behind ----------
 *
 * csgSubtract was "lossy whatever it was handed": a watertight box minus a watertight
 * prism came back with boundary edges for an interior hole, a blind pocket, an edge
 * notch and a corner bite alike. None of that was material going missing. The surface
 * was closed all along; its CONNECTIVITY was not, in two separate ways, and both have
 * to be repaired before the mesh will satisfy a slicer.
 *
 * 1. T-junctions. A split plane cuts every polygon it crosses in two, but a polygon it
 *    merely grazes along an edge passes through whole. The long edge then faces two
 *    short ones with a vertex sitting in its middle, and the manifold check counts three
 *    edges used once each where the mesh is in fact sealed. It cannot be fixed during
 *    the splits — the two sides are cut at unrelated depths of the tree and neither
 *    knows about the other — so it is a pass over the finished soup.
 *
 * 2. Micron slivers. Where two cutter planes cross a face at a shallow angle they carve
 *    the same corner twice, a couple of microns apart, and the polygon between the two
 *    cuts has no thickness worth the name. Merging its ends is not a fudge to satisfy
 *    the audit: at that size the two vertices are one point in every representation
 *    downstream, and an STL stores float32.
 *
 * Both repairs want the same thing first — every vertex reduced to an integer id — so
 * they share one pass. That is not tidiness: string-keyed maps over every vertex and
 * every edge, rebuilt for each of the 126 subtractions a screwed plate performs, cost
 * more than the whole CSG they were repairing.
 *
 * This function is the fix, not decoration. Disable it and the four minimum CSG cases in
 * plate-audit.js all fail, magnets go to 3207 bad edges and screws to 8389. Everything
 * else in this file's CSG changes is an optimisation sitting on top of it.
 */
/* Two points this close are one point. Chosen by measurement rather than by argument:
   across a sweep of connectors, mounting options and smoothnesses, 1e-3 left six
   configurations leaking at the arcSegs the tool actually ships (6 — it is not a UI
   control), including both magnet-from-above options; 2e-3 leaves none. It is a trade
   and not a free win: at arcSegs 8 and 16, which nothing can currently select, two
   configurations go the other way, and volumes move by up to 0.1 mm3 on a 54000 mm3
   plate. An earlier version of this comment called 1e-3 principled because it matched
   checkManifold's rounding. That is a consistency argument with the measuring
   instrument, not a correctness one, and it was choosing the worse number. */
const VTOL = 2e-3;

function healCsgSeams(polys) {
  if (!polys.length) return polys;

  /* ---- one vertex table for the whole soup, bucketed as it is built ----
   * Buckets are VTOL cubes, hashed to a 32-bit integer rather than keyed by a string of
   * the three cell coordinates. Two cells can land in one bucket, which costs nothing:
   * every use of a bucket compares coordinates anyway. Every use of a STRING, on the
   * other hand, cost most of the time this whole repair takes. */
  const hash = (cx, cy, cz) => ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) | 0;
  const verts = [], buckets = new Map();
  const idOf = (v) => {
    const cx = Math.floor(v[0]/VTOL), cy = Math.floor(v[1]/VTOL), cz = Math.floor(v[2]/VTOL);
    const k = hash(cx, cy, cz);
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    for (const i of b) {
      const w = verts[i];
      if (w[0] === v[0] && w[1] === v[1] && w[2] === v[2]) return i;
    }
    b.push(verts.length); verts.push(v);
    return verts.length - 1;
  };
  let faces = polys.map((p) => p.verts.map(idOf));
  let planes = polys.map((p) => p.plane);

  /* Edges are keyed by one number rather than a string of two, which ids make possible
     and which the profile insisted on. Ids beyond 2^26 would collide; a soup that large
     would have exhausted memory long before, and this says so if it ever does not. */
  const EKEY = 1 << 26;
  if (verts.length >= EKEY) throw new Error(`healCsgSeams: ${verts.length} vertices overflows the edge key`);

  /* A face may be dropped only if every undirected edge in it appears an EVEN number of
     times. Then removing it cannot change any edge's parity, and a closed cycle that
     retraces every one of its edges encloses no area either, so the volume is untouched.
     A real polygon uses each edge once and can never qualify. This is the whole test for
     "this face is not really there", and it is arithmetic rather than a judgement call —
     which matters, because the two places it is needed throw up quite different-looking
     degeneracies and an ad-hoc check for one of them missed the other. */
  const retraced = (f) => {
    const seen = new Map();
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = a < b ? a * EKEY + b : b * EKEY + a;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    for (const c of seen.values()) if (c % 2) return false;
    return true;
  };

  /* ---- collapse the slivers ----
   * Grouping has to be by DISTANCE and not by a rounding grid: rounding puts 52.0611 and
   * 52.0618 either side of a cell wall and leaves the sliver between them intact, which
   * was the last handful of bad edges on a screwed plate. The bound is deliberately the
   * one checkManifold rounds by, so any two vertices this leaves distinct are still
   * distinct there too — the two never disagree about what is one point. */
  const parent = verts.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  verts.forEach((v, i) => {
    const cx = Math.floor(v[0]/VTOL), cy = Math.floor(v[1]/VTOL), cz = Math.floor(v[2]/VTOL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = buckets.get(hash(cx+dx, cy+dy, cz+dz));
      if (!b) continue;
      for (const j of b) {
        if (j <= i) continue;
        const w = verts[j];
        if (Math.abs(v[0]-w[0]) > VTOL || Math.abs(v[1]-w[1]) > VTOL || Math.abs(v[2]-w[2]) > VTOL) continue;
        const ra = find(i), rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  });

  /* Move every vertex onto its group's representative. A polygon whose corners have
     merged loses the collapsed corner; one left with fewer than three, or one that has
     folded onto itself like A-B-A-D, goes entirely. */
  const dirty = [];
  {
    const nf = [], np = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi], keep = [];
      let moved = false;
      for (let i = 0; i < f.length; i++) {
        const a = find(f[i]), b = find(f[(i + 1) % f.length]);
        if (a !== f[i]) moved = true;
        if (a !== b) keep.push(a);
      }
      if (keep.length < 3 || retraced(keep)) continue;
      nf.push(keep); np.push(planes[fi]); dirty.push(moved || keep.length !== f.length);
    }
    faces = nf; planes = np;
  }

  /* ---- put the missing vertices back into the long edges ----
   * A subdivided edge leaves BOTH sides under-used: the long edge is used once, and so
   * is each half. That prunes the work at both ends — only edges already counted wrong
   * can need a vertex, and only the endpoints of those edges can be the vertex they
   * need. On a screwed plate that is a few hundred edges against a few hundred points
   * instead of a hundred thousand against a hundred thousand.
   *
   * Inserting can expose a further T-junction on a longer edge, hence the loop. Two
   * passes is the most anything here has needed; the cap is headroom, and it THROWS if
   * it is ever reached with work still to do rather than quietly returning a mesh with
   * holes in it. Silent partial success is the failure this project keeps rediscovering
   * — earTriangulate does it, and it shipped bins with 218 boundary edges.
   *
   * The distance tolerance is VTOL and not something tighter: the collapse above may
   * just have moved a vertex that far, and a weld that cannot reach it would leave the
   * T-junction it was meant to close. */
  const PASSES = 6;
  let pass = 0;
  for (; pass < PASSES; pass++) {
    /* Count polygon edges, not triangle edges — a fan's diagonals always pair up inside
       the fan, so the two counts differ only by matched pairs. */
    const use = new Map();
    for (const f of faces)
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const k = a < b ? a * EKEY + b : b * EKEY + a;
        use.set(k, (use.get(k) || 0) + 1);
      }
    const cand = new Set(), suspect = new Set();
    for (const [k, c] of use) {
      if (c === 2) continue;
      suspect.add(k);
      cand.add(Math.floor(k / EKEY)); cand.add(k % EKEY);
    }
    if (!cand.size) break;
    /* Sorted on x, so an edge only looks at the candidates inside its own x span. Even
       a few hundred against a few hundred is 30 million projections on a screwed plate
       when every edge sees every point; the window and the box test take it to a few
       hundred thousand. */
    const pts = [...cand].sort((p, q) => verts[p][0] - verts[q][0]);
    const px = pts.map((i) => verts[i][0]);
    const from = (x) => {
      let lo = 0, hi = px.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (px[m] < x) lo = m + 1; else hi = m; }
      return lo;
    };

    let changed = false;
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi], grown = [];
      let touched = false;
      for (let i = 0; i < f.length; i++) {
        const ia = f[i], ib = f[(i + 1) % f.length];
        grown.push(ia);
        if (!suspect.has(ia < ib ? ia * EKEY + ib : ib * EKEY + ia)) continue;
        const a = verts[ia], b = verts[ib];
        const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
        const L2 = dx*dx + dy*dy + dz*dz;
        if (L2 < 1e-12) continue;
        const xhi = (dx > 0 ? b[0] : a[0]) + VTOL;
        const ylo = (dy > 0 ? a[1] : b[1]) - VTOL, yhi = (dy > 0 ? b[1] : a[1]) + VTOL;
        const zlo = (dz > 0 ? a[2] : b[2]) - VTOL, zhi = (dz > 0 ? b[2] : a[2]) + VTOL;
        const hits = [];
        for (let s = from((dx > 0 ? a[0] : b[0]) - VTOL); s < px.length && px[s] <= xhi; s++) {
          const q = pts[s];
          if (q === ia || q === ib) continue;
          const p = verts[q];
          if (p[1] < ylo || p[1] > yhi || p[2] < zlo || p[2] > zhi) continue;
          const ux = p[0]-a[0], uy = p[1]-a[1], uz = p[2]-a[2];
          const t = (ux*dx + uy*dy + uz*dz) / L2;
          if (t <= 0 || t >= 1) continue;
          const ox = ux - dx*t, oy = uy - dy*t, oz = uz - dz*t;
          if (ox*ox + oy*oy + oz*oz > VTOL * VTOL) continue;
          hits.push([t, q]);
        }
        if (!hits.length) continue;
        hits.sort((x, y) => x[0] - y[0]);
        for (const [, q] of hits) grown.push(q);
        touched = true;
      }
      if (!touched) continue;
      faces[fi] = grown; dirty[fi] = true; changed = true;
    }
    if (!changed) break;
  }
  if (pass === PASSES) throw new Error('healCsgSeams: T-junctions still appearing after ' + PASSES + ' passes');

  /* Welding creates the other kind of fold. A sliver triangle D-C-B whose corners are
     nearly collinear really does have its third corner sitting on the opposite edge, so
     the insertion test above says yes and the face becomes D-C-B-C: out to a point and
     straight back, drawn as two triangles of opposite winding that an edge count cannot
     tell from real surface. That was csgUnion's last six bad edges. Refusing the
     insertion instead is wrong — it leaves a genuine T-junction elsewhere on the same
     face and the volume drifts by 1.2e-5. Dropping the face is exactly right. */

  /* The fold does not have to swallow the whole face, and the version that does not is
     the harder one to see. A face that is real surface for most of its perimeter can
     still carry a SPUR — ...P, B, C, B, Q... — where the insertion sent it out to C and
     straight back. Every edge of a spur is used twice within the one face, so the edge
     count reads clean and `retraced` says no, because the face's real edges are still
     odd. It only surfaces later: the centroid fan turns B-C and C-B into two triangles
     on the same three points facing opposite ways, and those show up as an edge used
     four times. That is where the puzzle notch's last leaks came from — its cavity
     ceiling runs under the socket's corner arc, whose facet planes are near-tangent to
     one another, so a's tree dices the ceiling into slivers a few microns wide and the
     weld folds a couple of them.

     Unwinding the spur is arithmetic rather than judgement, the same as `retraced`:
     dropping C removes the undirected edge B-C exactly twice, so no edge's parity moves
     and a genuine hole is still reported as one, and a path that goes out and back
     encloses no area, so the volume is untouched. */
  const unspur = (f) => {
    let g = f;
    for (;;) {
      const keep = [];
      for (let i = 0; i < g.length; i++)
        if (g[(i - 1 + g.length) % g.length] !== g[(i + 1) % g.length]) keep.push(g[i]);
      if (keep.length === g.length) return g;
      // a spur's two flanks now sit side by side; the duplicate goes with them
      const dedup = [];
      for (let i = 0; i < keep.length; i++)
        if (keep[i] !== keep[(i + 1) % keep.length]) dedup.push(keep[i]);
      if (dedup.length < 3) return dedup;
      g = dedup;
    }
  };
  {
    const kept = [], kp = [], kd = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const f = unspur(faces[fi]);
      if (f.length < 3 || retraced(f)) continue;
      kept.push(f); kp.push(planes[fi]); kd.push(dirty[fi] || f.length !== faces[fi].length);
    }
    faces = kept; planes = kp; dirty.length = 0; dirty.push(...kd);
  }

  /* ---- back to polygons ----
   * A repaired polygon has vertices sitting mid-edge, so the triangle fan
   * polysToTriangles builds from verts[0] can start on a straight run and emit a
   * zero-area triangle with a NaN normal. Fanning from the vertex average instead
   * cannot: these polygons are all convex (BSP splitting preserves convexity, and every
   * input here is convex), so the average is strictly interior. Every boundary edge is
   * still used exactly once and every spoke exactly twice, which is the whole point.
   * The sub-triangles inherit the parent plane rather than deriving one from three
   * nearly-collinear points.
   *
   * Not a face that is nothing but a straight run, though: three corners on one line,
   * left where a weld closed a T-junction. It has no inside for the average to be in,
   * and the average lands on the line a fraction of a micron from a corner, where
   * checkManifold's thousandths read the spokes as the face's own edges a second time.
   * That was a puzzle key in the wall at 42 mm with magnets: four edges used four times
   * where the housing's ceiling meets the side of a cell. Such a face goes out as it is;
   * whatever fans it, every edge it has is still used once.
   *
   * Convex is not quite what a weld leaves, though. Moving a vertex a thousandth or two
   * onto its group can put it just across the line of its neighbours: a dent too small
   * to see. Fanned as above, from its first corner or, when it is flat, from its average,
   * such a face can lay a sliver back to back with itself, which a slicer sees as a
   * coplanar fold (a mounting pocket's side extended across a bottom face full of seam
   * vertices; a puzzle notch's ceiling; the side of a puzzle tab at 18 mm, where a corner
   * sits a few microns in from its neighbours). So a mended face whose plain fan lays a
   * triangle within 8 degrees of back to back with the face is laid out again, from the
   * first of these that is sound: each of its corners in turn, then ears cut in its own
   * plane by earTriangulate (a dent between two straight runs, in the bottom face beside a
   * screw hole, leaves no corner that sees all of it). Sound means every triangle has
   * area, keeps the face's own winding and lies within 60 degrees of the face, and no
   * diagonal between two corners is already an edge of another face, which would then be
   * used four times. A face with nothing sound goes out as it was (a sliver the weld
   * turned right over faces the wrong way however it is laid out).
   *
   * Nothing else is touched. A sliver that only leans, or stands on edge, can turn back by
   * the sign of its normal without lying back to back with anything, and laying those out
   * again made pieces worse: a corner's fan stood triangles in the plane of an H-clip's
   * wall, where they folded against it; ears re-wound a sliver the weld had turned over,
   * against its neighbours; a corner's diagonal was an edge another face already had. Each
   * face laid out differently here is cut again by whatever comes next, and laying out more
   * of them, even soundly, still opened a hole downstream in one piece only the engine
   * reaches. One that stands on edge and does fold, against the face beside it, is laid
   * out on the finished piece instead, where nothing cuts it again (unfoldFinished). Nor
   * is the face's own average tried: where the plates come from the page it lays out
   * nothing a corner does not, and where only the engine reaches it traded folds for open
   * edges on two pieces, which nothing else here does. A face whose plain fan lies right
   * is laid out exactly as before, and so is every plate with no such face. */
  const use = new Map();
  for (const f of faces)
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = a < b ? a * EKEY + b : b * EKEY + a;
      use.set(k, (use.get(k) || 0) + 1);
    }
  // triangles as corner indices into the face; sound as above
  const sound = (f, vs, tris, nn) => {
    const n = f.length;
    for (const t of tris) {
      const p = t.map((i) => vs[i]);
      const x = V.cross(V.sub(p[1], p[0]), V.sub(p[2], p[0])), l = Math.sqrt(V.dot(x, x));
      if (l < 1e-9 || V.dot(x, nn) < 0.5 * l) return false;
      for (let e = 0; e < 3; e++) {
        const i = t[e], j = t[(e + 1) % 3];
        if ((i + 1) % n === j || (j + 1) % n === i) continue;
        const a = f[i], b = f[j];
        if (use.has(a < b ? a * EKEY + b : b * EKEY + a)) return false;
      }
    }
    return true;
  };
  // the face laid out again as above: polygons to push, or null for nothing sound
  const relay = (f, vs, nn) => {
    const n = f.length;
    for (let k = 0; k < n; k++) {
      const t = [];
      for (let i = 2; i < n; i++) t.push([k, (k + i - 1) % n, (k + i) % n]);
      if (sound(f, vs, t, nn)) return [k ? vs.slice(k).concat(vs.slice(0, k)) : vs];
    }
    const m = nn.map(Math.abs);
    const ax = m[0] > m[1] ? (m[0] > m[2] ? 0 : 2) : (m[1] > m[2] ? 1 : 2);
    const proj = vs.map((v, i) => [v[(ax + 1) % 3], v[(ax + 2) % 3], i]);
    const { pts, tris } = earTriangulate(proj);
    if (tris.length !== n - 2) return null;
    // earTriangulate turns them anticlockwise in the projection; the face's own way round
    const back = polyArea2D(proj) < 0;
    const t = tris.map((e) => (back ? [e[0], e[2], e[1]] : e).map((j) => pts[j][2]));
    return sound(f, vs, t, nn) ? t.map((e) => e.map((i) => vs[i])) : null;
  };
  const out = [], mended = [];   // mended: what a mended face went out as, by vertex id
  let turned = 0;
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi], n = f.length, vs = f.map((i) => verts[i]);
    // flat: a straight run somewhere; line: nothing but (see "back to polygons" above)
    let flat = false, line = !!dirty[fi];
    if (dirty[fi])
      for (let i = 0; i < n; i++) {
        const u = V.sub(vs[(i + 1) % n], vs[i]);
        const w = V.sub(vs[(i + 2) % n], vs[(i + 1) % n]);
        const c = V.cross(u, w);
        if (V.dot(c, c) < 1e-18) flat = true; else line = false;
      }
    const c = [0, 0, 0];
    if (flat) for (const v of vs) { c[0] += v[0]/n; c[1] += v[1]/n; c[2] += v[2]/n; }
    // does the plain fan lay a triangle back to back with the face?
    const folds = () => {
      const nn = planes[fi].n;
      for (let i = flat ? 0 : 1; i < (flat ? n : n - 1); i++) {
        const a = flat ? c : vs[0], b = vs[i], d = vs[(i + 1) % n];
        const x = V.cross(V.sub(b, a), V.sub(d, a)), l = Math.sqrt(V.dot(x, x));
        if (l > 1e-12 && V.dot(x, nn) / l < -0.99) return true;
      }
      return false;
    };
    /* or lay two of its triangles back to back with each other? A sliver of a sloping face
       the weld has pressed flat into a wall does that while neither triangle is anywhere
       near the face's own plane. Only counted, for buildPiece to cut again (cutAgain). */
    const twists = () => {
      let prev = null;
      for (let i = flat ? 0 : 1; i < (flat ? n : n - 1); i++) {
        const a = flat ? c : vs[0], b = vs[i], d = vs[(i + 1) % n];
        const x = V.cross(V.sub(b, a), V.sub(d, a)), l = Math.sqrt(V.dot(x, x));
        if (l < 1e-12) { prev = null; continue; }
        const u = V.scale(x, 1 / l);
        if (prev && V.dot(u, prev) < -0.999999) return true;
        prev = u;
      }
      return false;
    };
    if (dirty[fi] && n > 3 && folds()) {
      const again = relay(f, vs, planes[fi].n);
      if (again) {
        for (const p of again) {
          out.push({ verts: p, plane: planes[fi] });
          mended.push({ ids: p.map((v) => f[vs.indexOf(v)]), vs: p });
        }
        continue;
      }
      turned++;
    } else if (dirty[fi] && (n === 3 ? folds() : twists())) turned++;
    if (!flat || line) {
      out.push({ verts: vs, plane: planes[fi] });
      if (dirty[fi]) mended.push({ ids: f, vs });
      continue;
    }
    for (let i = 0; i < n; i++) {
      out.push({ verts: [c, vs[i], vs[(i + 1) % n]], plane: planes[fi] });
      mended.push({ ids: [-1, f[i], f[(i + 1) % n]], vs: [c, vs[i], vs[(i + 1) % n]] });
    }
  }
  /* And a mended face's triangle laid back to back with the one across an edge from it, in
     a face of its own or one beside it: a sliver of a sloping face pressed flat into the
     floor faces up against the floor's own triangle facing down. That is checkOrientation's
     fold, looked for only where a face was mended (the faces the BSP leaves are flat and
     convex), on the triangles polysToTriangles will make. Counted with the rest. */
  if (mended.length) {
    const tri = new Map();   // edge -> the unit normals of the triangles on it
    // the corners those edges run between, so a face with none of them is passed over
    const near = new Uint8Array(verts.length);
    const on = (a, b, u) => {
      if (a < 0 || b < 0) return;   // a spoke to a flat face's average is in no other face
      const k = a < b ? a * EKEY + b : b * EKEY + a, l = tri.get(k);
      if (l) l.push(u); else tri.set(k, [u]);
      near[a] = near[b] = 1;
    };
    for (const { ids, vs } of mended)
      for (let i = 2; i < ids.length; i++) {
        const x = V.cross(V.sub(vs[i - 1], vs[0]), V.sub(vs[i], vs[0])), l = Math.sqrt(V.dot(x, x));
        if (l < 1e-12) continue;
        const u = V.scale(x, 1 / l);
        on(ids[0], ids[i - 1], u); on(ids[i - 1], ids[i], u); on(ids[i], ids[0], u);
      }
    for (let fi = 0; fi < faces.length; fi++) {
      if (dirty[fi]) continue;
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        if (!near[a] || !near[b]) continue;
        const l = tri.get(a < b ? a * EKEY + b : b * EKEY + a);
        if (l) l.push(planes[fi].n);
      }
    }
    for (const l of tri.values()) if (l.length === 2 && V.dot(l[0], l[1]) < -0.999999) turned++;
  }
  /* And whether the result is closed: a polygon edge not used exactly twice is a hole the
     repairs above could not close. Counted on the ids already to hand (the use above), so
     it costs a pass over the edges; buildPiece reads it to cut a cell's mounting pockets
     again when they come out open (see the fastener cut there). */
  let open = 0;
  for (const u of use.values()) if (u !== 2) open++;
  out.open = open;
  out.turned = turned;
  return out;
}

/* Subtraction and union, with the solid's own surface kept out of its own tree.
 *
 * This is a POLYGON-COUNT optimisation and nothing more. Say so plainly, because the
 * shape of the reasoning below is exactly the shape of a root-cause argument and it is
 * not one: restore the textbook form, keep healCsgSeams, and every case in
 * plate-audit.js still passes. The only measured difference is 45332 -> 29242 polygons
 * on the 3x3 screws case, a 35% saving. Nothing in the audit would catch its reversion.
 *
 * Textbook csg.js takes the answer out of `a` — a.clipTo(b), then a.build(b's polygons),
 * then a.allPolygons(). That reads the surface back out of a tree that was built by
 * splitting a's polygons against each other. A cell region carries ~300 socket-surface
 * triangles whose planes graze the top annulus at a few thousandths of a degree, so
 * partitioning the annulus by every one of them shreds it: subtracting nothing at all
 * from a cell region — csgSubtract(region, []) — took it from 394 polygons to 1524 and
 * opened 481 bad edges, with no cutter anywhere near it.
 *
 * Nothing needs a's surface to come out of a's tree. The result of A − B is A's polygons
 * clipped to outside B, plus B's polygons clipped to inside A and turned to face the
 * cavity. So a's tree is built for classification and its fragments are thrown away, and
 * the surface we keep is the ORIGINAL a polygons put through b's tree — which has a
 * handful of planes belonging to a cutter that was chosen to be simple.
 *
 * The clipTo/invert dance on b is unchanged from csg.js: it is what discards a cutter
 * face lying exactly on a face of the solid, and it still earns its keep.
 */
function csgSubtract(aPolys, bPolys) {
  const a = new BspNode(aPolys), b = new BspNode(bPolys);
  const outside = b.clipPolygons(aPolys);            // a's surface, split only by the cutter
  a.invert();                                        // classify against a's interior
  b.clipTo(a); b.invert(); b.clipTo(a); b.invert();  // b's surface, restricted to inside a
  return healCsgSeams(outside.concat(b.allPolygons().map(flipPoly)));
}
function csgUnion(aPolys, bPolys) {
  const a = new BspNode(aPolys), b = new BspNode(bPolys);
  const outside = b.clipPolygons(aPolys);            // a's surface outside b
  b.clipTo(a); b.invert(); b.clipTo(a); b.invert();  // b's surface outside a
  return healCsgSeams(outside.concat(b.allPolygons()));
}

/* clipConvexPrismTop and keyHalfConvexParts lived here and are gone. The clipper removed
   material above a z-plane inside a convex prism using half-space splitting only, which
   made it the sanctioned way to cut across the socket cones — and it emitted no floor and
   no flanks in place of what it took, so every surface it touched came back open. Every
   top-inserted plate leaked because of it, and its convex decomposition existed only to
   feed it. keySiteOps now subtracts a closed prism instead; see the note there for what
   was measured before trusting the BSP through the cone band. */

// clamp a poly soup to the half-space z >= z0 (drops sub-floor cutter leakage)
function clampZ(polys, z0) {
  const plane = { n: [0, 0, 1], w: z0 };
  const out = [], coFront = [], coBack = [], back = [];
  for (const p of polys) splitPolygon(plane, p, coFront, coFront, out, back);
  return out.concat(coFront);
}

// ---------- 2D helpers ----------
function polyArea2D(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    s += pts[i][0]*pts[j][1] - pts[j][0]*pts[i][1];
  }
  return s / 2;
}
// ear clipping; pts = simple polygon (any winding); returns triangles as index triples of the (CCW-normalised) points, plus the points
function earTriangulate(ptsIn) {
  let pts = ptsIn.slice();
  if (polyArea2D(pts) < 0) pts = pts.reverse();
  const n0 = pts.length;
  const idx = Array.from({ length: n0 }, (_, i) => i);
  const tris = [];
  const cross = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const inTri = (p, a, b, c) =>
    cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < 20000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i - 1 + idx.length) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (cross(a, b, c) <= 1e-9) continue;           // reflex or degenerate
      let contains = false;
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue;
        if (inTri(pts[k], a, b, c)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // fallback: shouldn't happen for simple polygons
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return { pts, tris };
}

// extrude a simple 2D polygon (any winding) from z0 to z1 into closed triangle-soup polys
function extrudePoly(pts2d, z0, z1) {
  const { pts, tris } = earTriangulate(pts2d);      // pts is CCW
  const polys = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {                     // sides (outward for CCW)
    const j = (i + 1) % n;
    const a0 = [pts[i][0], pts[i][1], z0], b0 = [pts[j][0], pts[j][1], z0];
    const a1 = [pts[i][0], pts[i][1], z1], b1 = [pts[j][0], pts[j][1], z1];
    const p = makePoly([a0, b0, b1, a1]); if (p) polys.push(p);
  }
  for (const t of tris) {                           // caps
    const top = makePoly([
      [pts[t[0]][0], pts[t[0]][1], z1],
      [pts[t[1]][0], pts[t[1]][1], z1],
      [pts[t[2]][0], pts[t[2]][1], z1]]);
    if (top) polys.push(top);
    const bot = makePoly([
      [pts[t[2]][0], pts[t[2]][1], z0],
      [pts[t[1]][0], pts[t[1]][1], z0],
      [pts[t[0]][0], pts[t[0]][1], z0]]);
    if (bot) polys.push(bot);
  }
  return polys;
}

function roundedSquareRing(cx, cy, half, r, n) {
  return roundedRectRing(cx, cy, half, half, r, n);
}
/* The same ring with a half size of its own on each axis, for the half cells along a
   plate's right side and back (see halfStrips): a 21 × 42 or 21 × 21 socket. Same
   vertices in the same order as the square one, so a square ring is the bytes it was,
   and its corner radius is held by the shorter side, as the square's is by its one. */
function roundedRectRing(cx, cy, hx, hy, r, n) {
  n = n || 6;
  r = Math.max(0.3, Math.min(r, Math.min(hx, hy) - 0.01));
  const pts = [];
  const cs = [[hx-r, hy-r, 0], [-hx+r, hy-r, 90], [-hx+r, -hy+r, 180], [hx-r, -hy+r, 270]];
  for (const [ox, oy, a0] of cs) {
    for (let k = 0; k < n; k++) {
      const a = (a0 + 90*k/n) * Math.PI/180;
      pts.push([cx + ox + r*Math.cos(a), cy + oy + r*Math.sin(a)]);
    }
  }
  return pts;
}

// socket cutter: swept rounded-square through the gridfinity profile
function socketCutter(cx, cy, prof, arcSegs) {
  const zs = prof.zs, ds = prof.ds;
  const rings = zs.map((z, i) => {
    const d = ds[i];
    const r = prof.rTop - (d - ds[ds.length-1]);
    return roundedSquareRing(cx, cy, prof.pitchHalf - d, r, arcSegs).map(p => [p[0], p[1], z]);
  });
  const polys = [];
  const n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      // triangles, not quads: corner-arc faces are conical (non-planar as quads)
      let p = makePoly([rings[i][j], rings[i][k], rings[i+1][k]]); if (p) polys.push(p);
      p = makePoly([rings[i][j], rings[i+1][k], rings[i+1][j]]); if (p) polys.push(p);
    }
  }
  const c0 = [cx, cy, zs[0]], c1 = [cx, cy, zs[zs.length-1]];
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    let p = makePoly([c0, rings[0][k], rings[0][j]]); if (p) polys.push(p);
    p = makePoly([c1, rings[rings.length-1][j], rings[rings.length-1][k]]); if (p) polys.push(p);
  }
  return polys;
}

function cylinder(cx, cy, r, z0, z1, seg) {
  seg = seg || 14;
  const ring0 = [], ring1 = [];
  for (let i = 0; i < seg; i++) {
    const a = 2*Math.PI*i/seg;
    ring0.push([cx + r*Math.cos(a), cy + r*Math.sin(a), z0]);
    ring1.push([cx + r*Math.cos(a), cy + r*Math.sin(a), z1]);
  }
  const polys = [];
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    let p = makePoly([ring0[i], ring0[j], ring1[j], ring1[i]]); if (p) polys.push(p);
    p = makePoly([[cx, cy, z0], ring0[j], ring0[i]]); if (p) polys.push(p);
    p = makePoly([[cx, cy, z1], ring1[i], ring1[j]]); if (p) polys.push(p);
  }
  return polys;
}

/* Everything removed at one mounting site, as ONE solid.
 *
 * Up to three cylinders share this axis: a magnet pocket, a screw shank, and the head's
 * counterbore. They overlap by design — the ⌀3 shank runs up the middle of the ⌀6
 * counterbore, and with the stock sizes that counterbore sits entirely inside the ⌀6.2
 * magnet pocket, sharing its bottom cap exactly. Three overlapping shells handed to a
 * BSP as one "solid" is the question it cannot answer, and it answered wrong: 14304 bad
 * edges on a 3x3 screwed plate, all of it shank wall the counterbore had already taken
 * away. Unioning them properly first is what csgUnion is for, and this is the one place
 * in the file where a union is the right tool rather than the trap ENGINE.md warns about
 * — it joins two cutters, never two pieces of the model.
 *
 * The alternative, one subtraction per cylinder, is correct too but three times the work
 * on the plate's biggest mesh, and each pass re-splits what the last one cut.
 *
 * Built at the origin so the caller can move one copy to all four corners of every cell
 * instead of unioning 252 times for a drawer-sized plate.
 */
function fastenerCutter(cfg, magZ0, magZ1, shankTop) {
  let cut = null;
  const add = (c) => { cut = cut ? csgUnion(cut, c) : c; };
  /* A magnet's pocket is 14-sided, cut 0.1 mm over the magnet's radius at its corners:
     0.2 over the diameter, the press fit bins/bin.js keeps as well ("the plate's rule").
     Its flats are cos(π/14) of that, and past a 7.78 mm magnet they came inside the
     magnet itself: 4.972 mm for a 10 mm one, a pocket narrower than what goes in it,
     where bins/bin.js's 16 sides keep their flats outside every magnet its field takes.
     So the corners go out as far as it takes for the flats to stand on the magnet's
     radius. For a magnet up to 7.77 mm, the 6 mm default among them, nothing moves. */
  const magnetR = Math.max(cfg.magnetD/2 + 0.1, cfg.magnetD/2 / Math.cos(Math.PI/14));
  if (cfg.magnets)
    add(cfg.magnetSide === 'top'
      ? cylinder(0, 0, magnetR, magZ0, magZ1, 14)
      : cylinder(0, 0, magnetR, -0.5, cfg.magnetH, 14));
  if (cfg.screws) {
    if (cfg.screwHeadD > cfg.screwHoleD)
      add(cylinder(0, 0, cfg.screwHeadD/2, -0.5, cfg.screwHeadDepth, 14));
    add(cylinder(0, 0, cfg.screwHoleD/2, -0.5, shankTop, 12));
  }
  return cut;
}
/* Slide a cutter sideways. Unlike transformPolys, which is for export and leaves the
   plane alone because nothing downstream of it reads one, this has to carry the plane
   with the vertices: it feeds a BSP, and a polygon whose plane has drifted from its
   vertices sends the tree looking for a splitter it can never consume. */
function movePolys(polys, dx, dy) {
  return polys.map((p) => ({
    verts: p.verts.map((v) => [v[0] + dx, v[1] + dy, v[2]]),
    // n copied, not shared: BspNode.invert replaces a plane's normal, and the template is reused
    plane: { n: p.plane.n.slice(), w: p.plane.w + p.plane.n[0]*dx + p.plane.n[1]*dy },
  }));
}

// counterbore: hole cylinder full height + wider recess from chosen face
function screwCutter(cx, cy, holeD, headD, z0, z1, headDepth, fromTop) {
  let polys = cylinder(cx, cy, holeD/2, z0 - 0.5, z1 + 0.5, 12);
  if (headD > holeD) {
    const rec = fromTop
      ? cylinder(cx, cy, headD/2, z1 - headDepth, z1 + 0.5, 14)
      : cylinder(cx, cy, headD/2, z0 - 0.5, z0 + headDepth, 14);
    polys = csgUnion(polys, rec);
  }
  return polys;
}

// dovetail tab footprint (2D); edge: '+x'|'-x'|'+y'|'-y', e = edge coordinate, s = centre along edge
function tabFootprint(edge, e, s, wr, wt, dp, back) {
  let pts;
  if (edge === '+x' || edge === '-x') {
    const g = edge === '+x' ? 1 : -1;
    pts = [[e - g*back, s - wr/2], [e, s - wr/2], [e + g*dp, s - wt/2],
           [e + g*dp, s + wt/2], [e, s + wr/2], [e - g*back, s + wr/2]];
  } else {
    const g = edge === '+y' ? 1 : -1;
    pts = [[s - wr/2, e - g*back], [s - wr/2, e], [s - wt/2, e + g*dp],
           [s + wt/2, e + g*dp], [s + wr/2, e], [s + wr/2, e - g*back]];
  }
  return pts;
}
const OPP = { '+x': '-x', '-x': '+x', '+y': '-y', '-y': '+y' };

// Sutherland–Hodgman: clip any simple polygon to an axis-aligned rect
function clipToRect(pts, x0, y0, x1, y1) {
  const planes = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const inter = [
    (a, b) => [x0, a[1] + (b[1]-a[1]) * (x0-a[0]) / (b[0]-a[0])],
    (a, b) => [x1, a[1] + (b[1]-a[1]) * (x1-a[0]) / (b[0]-a[0])],
    (a, b) => [a[0] + (b[0]-a[0]) * (y0-a[1]) / (b[1]-a[1]), y0],
    (a, b) => [a[0] + (b[0]-a[0]) * (y1-a[1]) / (b[1]-a[1]), y1],
  ];
  let out = pts;
  for (let k = 0; k < 4; k++) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const cIn = planes[k](cur), pIn = planes[k](prev);
      if (cIn) { if (!pIn) out.push(inter[k](prev, cur)); out.push(cur); }
      else if (pIn) out.push(inter[k](prev, cur));
    }
  }
  // drop consecutive duplicates
  const clean = [];
  for (const p of out) {
    const q = clean[clean.length-1];
    if (!q || Math.abs(q[0]-p[0]) > 1e-7 || Math.abs(q[1]-p[1]) > 1e-7) clean.push(p);
  }
  if (clean.length > 2) {
    const a = clean[0], b = clean[clean.length-1];
    if (Math.abs(a[0]-b[0]) < 1e-7 && Math.abs(a[1]-b[1]) < 1e-7) clean.pop();
  }
  return clean.length >= 3 ? clean : null;
}

// ---------- layout ----------
/* The biggest grid the page will build in one go, a 1.26 m square at the spec pitch. It
   lives here because computeLayout has to honour it too (see the 'plates' split); the
   page's MAX_CELLS is this number. */
const PLATE_MAX_CELLS = 900;
/* The range the page accepts for each setting that reaches the geometry with nothing
   else bounding it. They live here, beside the geometry they protect, because
   test/plate-audit.js builds every joint at their ends — a limit the audit cannot read
   is a limit nobody re-measures when the geometry changes. The page adds the labels and
   the wording; src/ui.js LIMITS.
 *
 *   pitch      Below 13.5 the joints stop closing: keys, snaps and puzzle lobes run into
 *              their neighbours or out of their cells, and every joint leaked somewhere in
 *              5–13 mm. 13.3 still leaks a 1-cell-wide piece on four of them. 13.5 is
 *              where all fifteen configurations the audit builds there close, on both its
 *              layouts, at the default clearance. That is not a promise that every design
 *              above it closes: a puzzle key in the walls, dropped in from above, leaks at
 *              14 (12 edges on 2 × 2 pieces, 3 on 1-cell ones), and a 35 mm pitch with a
 *              magnet and the widest screw head leaks 3. Neither is new — both built the
 *              same before there were ranges — and each is one setting, the sliver class
 *              ENGINE.md describes, not a reason to move the floor. It was 5, which only
 *              stopped the grid dividing by zero.
 *   topCutoff  0 puts the socket's top edge on the plate's own outline, and the rim there
 *              is a face of no width: every joint leaked. It closes from about 0.02, and
 *              0.1 keeps well clear of that edge (a few isolated values inside the range
 *              still fold or leak a handful of edges, as they did before there was a
 *              range: the sliver class ENGINE.md describes, not this limit). From 0.75 the socket's top edge
 *              is narrower than a spec bin's chamfer at that height, so the bin stops
 *              reaching the socket floor and rides on the rim — by 0.25 mm at 1, and the
 *              chamfer turns over entirely at 2.15. 1 is as far as that is worth taking.
 *   connClr    1 is where a number stops being a fit and starts being a slip: a
 *              millimetre a side is more play than any joint holds. Most joints stop
 *              sooner, and where depends on the joint, how its key goes in and the pitch,
 *              so the ceiling is connClrCeiling's, below, and not a number here.
 *   bottomPad  Nothing breaks above 20; a plate that tall is a typing slip, and the bed
 *              check is what stops one taller than the printer.
 *   magnet and screw minimums keep a cutter from sitting flush with a face — a 0 mm
 *              magnet is a pocket whose roof is the plate's floor, and coplanar cuts are
 *              ENGINE.md §1's oldest rule. The diameters' maximums depend on the pitch
 *              and come from mountLimits. */
const PLATE_RANGES = {
  pitch: { min: 13.5, max: 200 },
  topCutoff: { min: 0.1, max: 1 },
  connClr: { min: 0, max: 1, dovetail: 0.3, snapTop: 0.3, puzzleKey: 0.8,
             smallPitch: 20, small: 0.3, puzzleRoom: 6.5 },
  bottomPad: { min: 0, max: 20 },
  magnetD: { min: 1 }, magnetH: { min: 0.5, max: 10 },
  screwHoleD: { min: 1 }, screwHeadD: { min: 1 }, screwHeadDepth: { min: 0.5, max: 10 },
};
/* The one fit-clearance field, as each joint's housing is cut to it. readControls in
   src/ui.js worked this out and the audit copied it by hand, and the ceiling below is a
   field value whose meaning depends on it — a top-inserted snap is cut to the key's
   figure, 0.05 under the field — so all three read it from here. */
function fitClearances(field) {
  return { tab: field, puzzle: field,
           key: Math.max(0.1, field - 0.05), hclip: Math.max(0.08, field - 0.05) };
}
/* The fit clearance's ceiling for one design, as { max, by }; `by` says what sets it, for
 * the page to put in words: 'dovetail', 'snaptop', 'pitch', 'joint', or 'slip' for the
 * plain 1 mm. One function, because four things have to agree on it — the field's range,
 * the clamp on a number a link brings in, the message saying why, and the fit coupon's
 * slackest pair — and it takes the whole design because the answer depends on the joint,
 * which way its key goes in and the pitch. It took a connector name, and a 1 mm ceiling
 * for everything but the dovetail let a snap clip's housing into the next piece and let
 * small pitches leak.
 *
 * Measured on 2 × 2 and 1-cell pieces from 13.5 to 60 mm, every 0.5 mm of pitch — at
 * every 0.05 of clearance for the puzzle, the bowtie and the puzzle key, at six for the
 * rest — and at every 0.01 of clearance at 20, 25, 30, 35, 42 and 60:
 *
 *   dovetail  0.3. Past it the pocket, cut 1.9 mm + this into the piece, breaks through
 *             the 2.15 mm socket wall and crosses the chamfer cone; it leaked from 0.34.
 *             The hint's own advice stops at 0.25.
 *   snaptop   0.3, in either housing. The clip's slot puts its seam-side wall
 *             0.3 − (the key's clearance) from the seam, so past a field of 0.35 that
 *             wall stands in the next piece — by 0.65 mm at 1 — and two pieces that print
 *             overlapping cannot butt together; on the coupon the pairs met at the seam.
 *             At 0.35 itself nothing overlaps, but the wall lies in the piece's own seam
 *             face, about 9.4 mm² of face shared — the coplanar face ENGINE.md keeps
 *             every shell off, with no bad edge to show for it — and the coupon's 0.3
 *             pair did the same for any field from 0.3 up. 0.3 holds the wall one BLOAT,
 *             0.05, inside the piece, the overlap the cell regions keep; the coupon's
 *             slackest pair is this ceiling cut the key's way, so it stops there too.
 *   pitch     0.3 below 20 mm, for the three housings the field cuts that leaked there:
 *             the puzzle, and the bowtie and puzzle key in the floor. Past 0.3 they left
 *             holes from 13.5 to 19 mm — a puzzle key at 14 from 0.4, a bowtie at 18 at
 *             1, a puzzle at 19 from 0.35 — and from the default 0.2 to 0.3 none did. The
 *             puzzle's lobe also needs room in its cell: it opens the plate once its
 *             clearance passes half the pitch less 6.475 mm, so it stops at half the pitch
 *             less 6.5 — 0.25 at 13.5, and 0.3 from 13.6.
 *   joint     0.8 for a puzzle key in the floor from 20 mm up: between 0.82 and 0.96 its
 *             recess leaked at every pitch measured, 20 to 60.
 *   slip      1 for the rest. A key in the walls is cut to keySlim's own clearance, which
 *             the field does not move. The snap and the H-clip did not leak above 0.3 at
 *             any pitch measured but in one band — an H-clip dropped in from above leaks
 *             at 0.74 to 0.745 and nowhere else. From 20 mm up the bowtie and the puzzle
 *             leak only at isolated values: the bowtie at 25 mm at 0.64, the puzzle at
 *             0.39–0.4 at 21 and 32.5–35 mm and here and there from 0.52 to 0.87. That is
 *             the sliver class again, not a ceiling — no limit short of 0.38 misses them,
 *             and the same class turns up under the default too: a snap at 20 mm at 0.29,
 *             a bowtie at 17 mm at 0.15 and under.
 *
 * The leaks that set the pitch and joint ceilings, and the dovetail's at 0.34, were that
 * class as well: buildPiece now cuts a joint again when its cut comes out open
 * (cutAgain), and the step past each that test/plate-audit.js builds is closed, as is the
 * H-clip from above at 0.74. The ceilings stay where they are until a sweep as fine as
 * the one that found the small-pitch leaks says how far each can go. */
function connClrCeiling(cfg) {
  const R = PLATE_RANGES.connClr;
  const kind = jointKind(cfg.connector, cfg.keyMount, cfg.keyInsert);
  if (kind === 'dovetail') return { max: R.dovetail, by: 'dovetail' };
  if (kind === 'snaptop') return { max: R.snapTop, by: 'snaptop' };
  const floorKey = ['bowtie', 'puzzlekey'].includes(cfg.connector) && cfg.keyMount !== 'wall';
  if (cfg.connector !== 'puzzle' && !floorKey) return { max: R.max, by: 'slip' };
  if (cfg.pitch < R.smallPitch) {
    const room = cfg.connector === 'puzzle'
      ? Math.floor((cfg.pitch / 2 - R.puzzleRoom) * 100 + 1e-9) / 100 : Infinity;
    return { max: Math.min(R.small, room), by: 'pitch' };
  }
  if (cfg.connector === 'puzzlekey') return { max: R.puzzleKey, by: 'joint' };
  return { max: R.max, by: 'slip' };
}
/* A piece's column letters, spreadsheet-style: A … Z, AA, AB … The id was
   String.fromCharCode(65 + s), which runs on past Z into '[', '\' and the lower case — a
   33-piece row shipped `baseplate-\1.stl`, and both `baseplate-A1.stl` and
   `baseplate-a1.stl`, which are one file on Windows and macOS. */
function pieceColumn(s) {
  let out = '';
  for (let n = s + 1; n > 0; n = Math.floor((n - 1) / 26))
    out = String.fromCharCode(65 + (n - 1) % 26) + out;
  return out;
}
/* How many cells the drawer holds, and the margins left around them: the first thing a
   layout decides, and the one thing the Bins page has to decide the same way. That page
   counted its own cells as the drawer over 42 and nothing else, so a plate with custom
   margins six cells wide arrived there as a map seven wide, and the seventh column took
   bins with no sockets under them. Both pages ask here now. Needs drawerW, drawerD,
   pitch, marginMode, and the four margins when it is 'custom' or the alignment when it
   is not.
 *
 * marginMode 'half' is 'auto' with a strip of half cells laid in the leftover first (see
 * halfStrips): hX and hY say whether there is a half column and a half row, and the
 * alignment places what is left after them. The strips are counted INTO mR and mB, so to
 * everything that sizes a piece — the bed check, the split search, the outline — they are
 * margin, which is the width they take; only buildPiece and the cut map look inside. A
 * caller quoting the solid margin takes them back out. hX and hY are 0 in every other
 * mode, and that mode's numbers are the ones it always gave. */
function gridCells(p) {
  const pitch = p.pitch;
  let nx, ny, mL, mR, mF, mB, hX = 0, hY = 0;
  if (p.marginMode === 'custom') {
    mL = p.mLeft; mR = p.mRight; mF = p.mFront; mB = p.mBack;
    nx = Math.max(1, Math.floor((p.drawerW - mL - mR) / pitch + 1e-6));
    ny = Math.max(1, Math.floor((p.drawerD - mF - mB) / pitch + 1e-6));
    mR = p.drawerW - mL - nx*pitch;
    mB = p.drawerD - mF - ny*pitch;
  } else {
    nx = Math.max(1, Math.floor(p.drawerW / pitch + 1e-6));
    ny = Math.max(1, Math.floor(p.drawerD / pitch + 1e-6));
    let remX = p.drawerW - nx*pitch, remY = p.drawerD - ny*pitch;
    if (p.marginMode === 'half') {
      ({ hX, hY } = halfStrips(remX, remY, pitch));
      remX -= hX * pitch/2; remY -= hY * pitch/2;
    }
    mL = p.alignX === 'start' ? remX : p.alignX === 'end' ? 0 : remX/2;
    mR = remX - mL;
    mF = p.alignY === 'start' ? remY : p.alignY === 'end' ? 0 : remY/2;
    mB = remY - mF;
    // added only where there is a strip, so a plate without one keeps its exact margins
    if (hX) mR += pitch/2;
    if (hY) mB += pitch/2;
  }
  return { nx, ny, mL, mR, mF, mB, hX, hY };
}
/* Whether the leftover past the whole cells takes a half cell: a column of them on the
 * right if remX is half a pitch or more, a row along the back if remY is. Each answer is
 * 0 or 1 — a second strip would be a whole cell, and the whole cells already took those.
 *
 * Always the right and the back, whatever the alignment says, and the alignment then
 * places what is left. A bin is placed in cells from the front left corner, so a strip
 * there would move every bin on the Bins page when this switched on or off; at the right
 * and back it sits past the last whole cell (x = nx, y = ny) and nothing else moves. The
 * front also stays free for the slack the drawer-size guide says to keep where you reach
 * in.
 *
 * A half cell takes half-size bins only, whose quarter feet seat in a corner of a whole
 * socket with a whole foot's clearance (ENGINE.md §4) — so the socket here is the spec
 * profile on a 21 × 42 or 21 × 21 rounded rectangle, the same distance in from every
 * side. The 1e-6 is gridCells' own floor tolerance: a 357 mm drawer is 8 cells and
 * exactly a half, and must say so. The Bins page is to ask it the same way, through
 * gridCells with the plate's `mm` from the link, so both maps put the strip in the same
 * place; until it does, it reads 'half' as a solid margin, as any page from before
 * half cells does. */
function halfStrips(remX, remY, pitch) {
  const fits = (rem) => rem >= pitch/2 - 1e-6 ? 1 : 0;
  return { hX: fits(remX), hY: fits(remY) };
}
/* General layout: horizontal bands (rowCuts) and per-band column cuts (colCuts[b]).
   splitMode: 'balanced' | 'staggered' | 'manual' (manual uses provided cuts). */
function computeLayout(p) {
  const pitch = p.pitch;
  const { nx, ny, mL, mR, mF, mB, hX, hY } = gridCells(p);
  const maxCellsX = Math.max(1, Math.floor(p.bedW / pitch));
  const maxCellsY = Math.max(1, Math.floor(p.bedD / pitch));

  function balancedCuts(n, maxCells, m0, m1, bed, extra) {
    // extra: allowance for tab protrusion etc.
    const fits = (counts) => counts.every((c, i) => {
      let w = c*pitch + extra;
      if (i === 0) w += m0;
      if (i === counts.length-1) w += m1;
      return w <= bed + 1e-6;
    });
    for (let k = Math.max(1, Math.ceil(n / maxCells)); k <= n; k++) {
      const base = Math.floor(n / k), ext = n % k;
      const counts = Array.from({ length: k }, (_, i) => base + (i < ext ? 1 : 0));
      if (fits(counts)) {
        const cuts = []; let acc = 0;
        for (let i = 0; i < k - 1; i++) { acc += counts[i]; cuts.push(acc); }
        return cuts;
      }
    }
    return [];
  }
  const extra = p.connector === 'dovetail' ? 2.5 : 0;

  // row bands
  let rowCuts;
  if (p.splitMode === 'plates') {
    /* Past the cell cap the page will refuse the job whatever split it gets, and this
       search runs first, inside the layout, before the page can say so. That ordering
       is how a stray 5 mm pitch on a big drawer froze the tab for 21 s to end at "not
       building" anyway — and every keystroke in the pitch field passes through values
       like that on its way to the one being typed. */
    const opt = nx * ny <= PLATE_MAX_CELLS
      ? optimizeForPlates(Object.assign({}, p, { splitMode: 'balanced' })) : null;
    if (opt) return computeLayout(Object.assign({}, p, { splitMode: 'manual', rowCuts: opt.rowCuts, colCuts: opt.colCuts }));
    return computeLayout(Object.assign({}, p, { splitMode: 'balanced' }));
  }
  if (p.splitMode === 'manual' && Array.isArray(p.rowCuts)) {
    rowCuts = p.rowCuts.filter(c => c > 0 && c < ny).sort((a, b) => a - b);
  } else {
    rowCuts = balancedCuts(ny, maxCellsY, mF, mB, p.bedD, extra);
  }
  const bandStarts = [0, ...rowCuts];
  const bandEnds = [...rowCuts, ny];
  const nBands = bandStarts.length;

  // per-band column cuts
  const segFits = (cuts) => {
    const segs = cuts.length ? [cuts[0], ...cuts.slice(1).map((c, i) => c - cuts[i]), nx - cuts[cuts.length-1]] : [nx];
    return segs.every((s, i) => {
      let w = s*pitch + extra;
      if (i === 0) w += mL;
      if (i === segs.length-1) w += mR;
      return s >= 1 && w <= p.bedW + 1e-6;
    });
  };
  let colCuts = [];
  for (let b = 0; b < nBands; b++) {
    let cuts;
    if (p.splitMode === 'manual' && p.colCuts && Array.isArray(p.colCuts[b])) {
      cuts = p.colCuts[b].filter(c => c > 0 && c < nx).sort((a, bb) => a - bb);
    } else {
      cuts = balancedCuts(nx, maxCellsX, mL, mR, p.bedW, extra);
      if (p.splitMode === 'staggered' && b % 2 === 1 && cuts.length) {
        const nSeg = cuts.length + 1;
        const halfSeg = Math.max(1, Math.round(nx / nSeg / 2));
        const candidates = [halfSeg, -halfSeg, halfSeg+1, -(halfSeg+1), 1, -1, 2, -2];
        let best = null;
        for (const shift of candidates) {
          const trial = cuts.map(c => c + shift);
          if (trial.some(c => c <= 0 || c >= nx)) continue;
          const sorted = trial.slice().sort((x, y) => x - y);
          if (!segFits(sorted)) continue;
          const segs = [sorted[0], ...sorted.slice(1).map((c, i) => c - sorted[i]), nx - sorted[sorted.length-1]];
          const minSeg = Math.min(...segs);
          if (!best || minSeg > best.minSeg) best = { cuts: sorted, minSeg };
          if (minSeg >= 2) break;
        }
        if (best) cuts = best.cuts;
      }
    }
    colCuts.push(cuts);
  }
  // pieces
  const pieces = [];
  for (let b = 0; b < nBands; b++) {
    const segStarts = [0, ...colCuts[b]];
    const segEnds = [...colCuts[b], nx];
    for (let s = 0; s < segStarts.length; s++) {
      pieces.push({
        id: `${pieceColumn(s)}${b + 1}`,
        band: b, seg: s,
        cellX0: segStarts[s], cellY0: bandStarts[b],
        nx: segEnds[s] - segStarts[s], ny: bandEnds[b] - bandStarts[b],
        mL: segStarts[s] === 0 ? mL : 0, mR: segEnds[s] === nx ? mR : 0,
        mF: bandStarts[b] === 0 ? mF : 0, mB: bandEnds[b] === ny ? mB : 0,
        /* The piece that owns a strip of half cells, which its mR or mB includes (see
           gridCells): every piece along the right edge carries its stretch of the half
           column, and every piece along the back its stretch of the half row. */
        hR: segEnds[s] === nx && hX === 1, hB: bandEnds[b] === ny && hY === 1,
      });
    }
  }

  // adjacency -> connector sites (global grid coords, cell units)
  // vertical seams: between horizontally adjacent pieces in same band
  // horizontal seams: between pieces of adjacent bands where x-ranges overlap
  const seams = [];
  for (const a of pieces) for (const c of pieces) {
    if (a === c) continue;
    if (a.band === c.band && a.cellX0 + a.nx === c.cellX0) {
      const y0 = a.cellY0, y1 = a.cellY0 + a.ny;
      const jts = [];
      for (let j = y0 + 1; j < y1; j++) jts.push(j);
      seams.push({ type: 'v', a: a.id, b: c.id, x: c.cellX0, y0, y1, junctions: jts });
    }
    if (a.cellY0 + a.ny === c.cellY0) {
      const x0 = Math.max(a.cellX0, c.cellX0), x1 = Math.min(a.cellX0 + a.nx, c.cellX0 + c.nx);
      if (x1 > x0) {
        const jts = [];
        for (let i = x0 + 1; i < x1; i++) jts.push(i);
        // if the overlap is a single cell wide, use its midpoint so the seam still gets a connector
        if (!jts.length && x1 - x0 === 1) jts.push(x0 + 0.5);
        seams.push({ type: 'h', a: a.id, b: c.id, y: c.cellY0, x0, x1, junctions: jts });
      }
    }
  }
  return { nx, ny, mL, mR, mF, mB, hX, hY, rowCuts, colCuts, pieces, seams,
           bands: nBands, gridW: nx*pitch, gridD: ny*pitch,
           maxCellsX, maxCellsY };
}

/* Per-piece connector lists in piece-local coordinates.
   dovetail: male on left piece (v-seams) / bottom piece (h-seams); notch on the other.
   bowtie: both sides get half-recesses; separate keys are exported. */
function pieceConnectors(cfg, layout, piece) {
  const pitch = cfg.pitch;
  const tabs = [], notches = [], ptabs = [], pnotches = [], keyed = [];
  const t = cfg.connector;
  if (t === 'none') return { tabs, notches, ptabs, pnotches, keyed };
  const W = piece.mL + piece.nx*pitch + piece.mR;
  const D = piece.mF + piece.ny*pitch + piece.mB;
  const lx = (gx) => piece.mL + (gx - piece.cellX0) * pitch;
  const ly = (gy) => piece.mF + (gy - piece.cellY0) * pitch;
  const isTab = t === 'dovetail' || t === 'puzzle';   // everything else keyed (incl. hclip)
  const male = isTab ? { dovetail: tabs, puzzle: ptabs }[t] : null;
  const female = isTab ? { dovetail: notches, puzzle: pnotches }[t] : null;
  for (const s of layout.seams) {
    if (s.type === 'v') {
      if (s.a === piece.id) for (const j of s.junctions)
        (isTab ? male : keyed).push({ edge: '+x', e: W, s: ly(j) });
      else if (s.b === piece.id) for (const j of s.junctions)
        (isTab ? female : keyed).push({ edge: '-x', e: 0, s: ly(j) });
    } else {
      if (s.a === piece.id) for (const j of s.junctions)
        (isTab ? male : keyed).push({ edge: '+y', e: D, s: lx(j) });
      else if (s.b === piece.id) for (const j of s.junctions)
        (isTab ? female : keyed).push({ edge: '-y', e: 0, s: lx(j) });
    }
  }
  return { tabs, notches, ptabs, pnotches, keyed };
}

/* bowtieHalf and bowtieKey lived here and are gone, along with the DEFAULTS.bowtie they
   read. Nothing called either of them: a bowtie key's housing comes from keyHalf('bowtie')
   and the printed part from keyOutline('bowtie'), both on DEFAULTS.key. The dimensions
   entry outlived the code by longer than the code outlived its callers, and src/ui.js was
   still faithfully copying it into state every time the clearance changed. Editing
   `bowtie.len` to change a bowtie is a mistake the file invited; see "every parameter in
   DEFAULTS is read by somebody" in test/plate-audit.js, which now fails if it comes back. */

// ---- connector shape library ----
// puzzle male footprint protruding OUT from edge (grow>0 => female cavity, cut INTO the edge)
function puzzleShape(edge, e, s, pz, grow, inward) {
  const nw = pz.neckW/2 + grow, r = pz.lobeR + grow;
  const nl = pz.neckL, cd = pz.neckL + pz.lobeR * 0.55;   // lobe centre depth
  const g0 = (edge === '+x' || edge === '+y') ? 1 : -1;
  const g = inward ? -g0 : g0;
  // half-angle where circle meets neck width
  const th = Math.asin(Math.min(0.95, nw / r));
  /* Where the lobe circle crosses the neck flank. The flank has to STOP here.
   *
   * It used to run on to nl*0.55 regardless, and with the shipped proportions that is
   * 0.24 mm (tab) to 0.33 mm (notch) past the crossing — so the outline walked out along
   * y = -nw, overshot, and came straight back along the same line to pick up the arc. A
   * spur of exactly zero area, invisible in every measurement of the shape: the enclosed
   * area and the bounding box are identical to the last bit either way.
   *
   * It is not invisible to the CSG. extrudePoly gives the spur two side quads that lie on
   * top of each other facing opposite ways, which makes the cutter a self-overlapping
   * solid rather than the single clean one csgSubtract requires, and a BSP has no answer
   * for a point that is inside a shell twice. That is where the puzzle notch's holes came
   * from: 30 edges used once and 40 used three times on a 9x9 plate, on three of the four
   * pieces. Ablated on its own — spur restored, everything else in place — the same 30
   * and 40 come straight back.
   *
   * Worth saying plainly, because the note on file said otherwise: the reflex outline was
   * NOT the problem. The shape is exactly as reflex as it was, the neck still meets the
   * lobe at a corner that turns the wrong way, and a cell region minus this cutter is
   * watertight. A reflex cutter is fine here; a self-overlapping one is not.
   *
   * Guarded rather than assumed, because neckL, neckW and lobeR are all editable and a
   * long enough neck genuinely does reach past the crossing, in which case the corner is
   * real and has to stay. */
  const junction = cd - r * Math.cos(th);
  const neckD = nl * 0.55;
  const pts = [];
  pts.push([-0.4, -nw]);                                   // start behind edge
  if (neckD < junction - 1e-6) pts.push([neckD, -nw]);
  for (let k = 0; k <= 18; k++) {                          // lobe arc through the far pole
    const a = -(Math.PI - th) + k * (2 * (Math.PI - th)) / 18;
    pts.push([cd + r * Math.cos(a), r * Math.sin(a)]);
  }
  if (neckD < junction - 1e-6) pts.push([neckD, nw]);
  pts.push([-0.4, nw]);
  // map (depth, lateral) into world
  return pts.map(([dp, lt]) => {
    if (edge === '+x' || edge === '-x') return [e + g * dp, s + lt];
    return [s + lt, e + g * dp];
  });
}
/* The notch a tab fits into, cut up into the floor of the piece across the seam from it
   (pieceConnectors' `notches` or `pnotches`), as one closed solid. buildPiece cuts it, and
   mountLimits keeps the mounting sites out of it; one shape, so the two cannot drift. */
function tabNotch(cfg, nb, pad) {
  if (cfg.connector === 'puzzle')
    return extrudePoly(puzzleShape(nb.edge, nb.e, nb.s, cfg.puzzle, cfg.puzzle.clr, true),
                       -0.5, pad - 0.4);
  const t = cfg.tab, H = pad + cfg.plateHeight;
  const nWr = t.wr + 2*t.clr, nWt = t.wt + 2*t.clr, nDp = t.dp + t.clr;
  // 4-pt taper: no vertex sits exactly on the region side plane; jitter breaks
  // residual coincidences with ring geometry
  const J = 0.0017, BK = 1.0, e = nb.e, s = nb.s + J;
  let pts;
  if (nb.edge === '+x' || nb.edge === '-x') {
    const g = nb.edge === '-x' ? 1 : -1;   // cut extends INTO the piece
    pts = [[e - g*BK, s - nWr/2], [e + g*nDp, s - nWt/2],
           [e + g*nDp, s + nWt/2], [e - g*BK, s + nWr/2]];
  } else {
    const g = nb.edge === '-y' ? 1 : -1;
    pts = [[s - nWr/2, e - g*BK], [s - nWt/2, e + g*nDp],
           [s + nWt/2, e + g*nDp], [s + nWr/2, e - g*BK]];
  }
  return extrudePoly(pts, -0.503, Math.min(t.h + 0.2, H - 0.8));
}
// generic underside key halves (recess cut into one piece's edge region)
function keyHalf(type, edge, e, s, prm, grow) {
  // returns polygon extending prm depth into the piece, 0.5 past the seam
  let prof;   // list of [depth(from seam, +into piece), halfwidth]
  if (type === 'bowtie') {
    prof = [[-0.5, prm.wWaist/2 + grow], [prm.len/2 + grow, prm.wEnd/2 + grow]];
  } else if (type === 'snap') {
    const endStart = prm.len/2 - prm.endLen, tp = prm.taper !== undefined ? prm.taper : 0.8;
    prof = [[-0.5, prm.wMid/2 + grow], [endStart, prm.wMid/2 + grow],
            [endStart + tp, prm.wEnd/2 + grow], [prm.len/2 + grow, prm.wEnd/2 + grow]];
  } else {
    prof = null;   // puzzlekey is not a depth-and-width profile; it is built below
  }
  let pts;
  if (prof) {
    pts = prof.map(([d, w]) => [d, -w]).concat(prof.slice().reverse().map(([d, w]) => [d, w]));
  } else {
    /* Puzzle key half: the waist run out to the lobe circle.
     *
     * The arc is cut into an ODD number of segments so that no vertex lands on the far
     * pole. A vertex there sits on the seam's centreline, which is exactly where two cell
     * regions meet — and both regions cut this same cutter, so both carry the apex and
     * the vertical edge either side of it: one edge used four times per site, 14 per
     * plate on every floor-mounted puzzle key and 7 on a wall-mounted one. It is the
     * defect ENGINE.md records for the puzzle NOTCH, and the rule stated there applies
     * here too — a cutter straddling a region boundary must cross it with a face, not a
     * vertex.
     *
     * The notch keeps its pole, because it mates with a printed tab and reshaping it costs
     * joint geometry; buildPiece starts the region past the pole beyond it instead. Here
     * reshaping costs nothing, because the arc is inflated to put the missing depth back
     * (below). 19 segments rather than the smallest odd number that would do: the count
     * decides where this cutter's facets cross the socket's, and 17 leaves 56 sliver folds
     * in the top-inserted wall cup at the shipped smoothness where 19 leaves none. Measured
     * over 17/19/21/25/33 at arcSegs 6 and 12, on all four mount-and-insert combinations.
     *
     * Nothing measured any of this before, because the audit's puzzlekey cases were
     * building a bowtie: keyType and connector are separate fields and only the page ever
     * kept them in step. */
    const LOBE_SEGS = 19;
    const cd = prm.len/2 - prm.lobeR, ww = prm.waistW/2 + grow, r0 = prm.lobeR + grow;
    /* Inflated so the FACET that spans the pole still reaches cd + r0, since no vertex
       does any more. Left inscribed, the housing loses r0(1 − cos(Δ/2)) of reach — 20 µm
       on the slim key, a sixth of its clearance — which is a change to the FIT paid for a
       change in topology, and this file's own history says those are the ones that get
       away. Circumscribing there instead keeps the reach at exactly lobeR + grow and
       makes the housing very slightly larger everywhere else, up to 26 µm at the widest
       point of the lobe; looser is the harmless direction for a pocket, tighter is not.
       The half-angle depends on the radius and the radius on the half-angle, so it is
       iterated; the correction is under 1% and two passes settle it to a tenth of a
       micron. */
    let r = r0, th = Math.asin(Math.min(0.95, ww / r));
    for (let i = 0; i < 2; i++) {
      r = r0 / Math.cos((Math.PI - th) / LOBE_SEGS);
      th = Math.asin(Math.min(0.95, ww / r));
    }
    pts = [[-0.5, -ww]];
    for (let k = 0; k <= LOBE_SEGS; k++) {
      const a = -(Math.PI - th) + k * (2*(Math.PI - th)) / LOBE_SEGS;
      pts.push([cd + r * Math.cos(a), r * Math.sin(a)]);
    }
    pts.push([-0.5, ww]);
  }
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;   // recess extends INTO this piece
  return pts.map(([dp, lt]) => {
    if (edge === '+x' || edge === '-x') return [e + g * dp, s + lt];
    return [s + lt, e + g * dp];
  });
}
// prism along an arbitrary horizontal axis from a (u,z) profile — for clip keys
function profilePrism(profile, v0, v1, mapUV) {
  // profile: list of [u, z], normalized to CCW; mapUV(u, v) -> [x, y]
  const ar = profile.reduce((acc, p, i) => { const q = profile[(i+1)%profile.length]; return acc + p[0]*q[1] - q[0]*p[1]; }, 0);
  if (ar < 0) profile = profile.slice().reverse();
  /* Normalising the profile to CCW is only half the job, and the missing half shipped
     the snap U-clip inside out for the life of the feature: signed volume -8.84 mm³,
     watertight, zero bad edges, so nothing in either audit could see it.

     A CCW profile in (u, z) only faces outwards if the frame mapUV lays down is
     right-handed in the order this function emits — u across, z up, v along the sweep.
     The bins' scoop and label pass (u, v) => [v, u], which is right-handed and correct;
     snapTopClip passes the identity (u, v) => [u, v], which is its mirror, and every
     face came out reversed. The caller cannot reasonably be expected to know which of
     the two it wrote, so measure it here: sweeping from v1 to v0 instead of v0 to v1
     reverses the sides and both caps together, which is exactly the correction needed. */
  const o = mapUV(0, 0), eu = mapUV(1, 0), ev = mapUV(0, 1);
  const hand = (ev[0]-o[0])*(eu[1]-o[1]) - (ev[1]-o[1])*(eu[0]-o[0]);
  if (hand < 0) { const t = v0; v0 = v1; v1 = t; }
  const polys = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const a = profile[i], b = profile[(i + 1) % n];
    const p = makePoly([
      [...mapUV(a[0], v0), a[1]], [...mapUV(b[0], v0), b[1]],
      [...mapUV(b[0], v1), b[1]], [...mapUV(a[0], v1), a[1]]]);
    if (p) polys.push(p);
  }
  const { pts, tris } = earTriangulate(profile);
  for (const t of tris) {
    let p = makePoly([t[2], t[1], t[0]].map(i => [...mapUV(pts[i][0], v0), pts[i][1]]));
    if (p) polys.push(p);
    p = makePoly(t.map(i => [...mapUV(pts[i][0], v1), pts[i][1]]));
    if (p) polys.push(p);
  }
  return polys;
}

/* Top-snap (click-lock) system, adapted from the Gridfinity Layout Tool sample.
   Per piece: leg slot with barb undercut + bridge rebate, built from box shells.
   prm: { legT:1.0, legLen:1.35(along), legC:1.35(center from seam), barb:0.18,
          bridgeW:1.7, bridgeD:0.85, wall:0.6, clr }

   The numbers are here and only here. They were written out four times — the plate's
   pocket, the coupon's pocket, the coupon's clip and the download's clip — and the
   pocket and the part they take are the two halves of one interference fit, so a barb
   changed in three places out of four prints a clip that will not click. */
function snapTopPrm(clr) {
  return { legT: 1.0, legLen: 1.35, legC: 1.4, barb: 0.18,
           bridgeW: 1.7, bridgeD: 0.85, wall: 0.6, clr };
}
function snapTopParts(edge, e, s, prm, H) {
  const c = prm.clr;
  const zf = H - 2.35, zLip0 = H - 1.1, zLip1 = H - 0.85, zReb = H - 0.85;
  const legIn = prm.legC - prm.legT/2 - c;          // near flank (toward seam)
  const legOut = prm.legC + prm.legT/2 + c;         // far flank (throat line)
  const cavOut = legOut + prm.barb + 0.05;          // barb cavity far wall
  const hw = prm.legLen/2 + c;                      // slot half-width along seam
  const W = prm.wall;
  /* Each: [d0, d1, s0, s1, z0, z1] in (across-depth, along, z). Six boxes that OVERLAP —
     the same rule the cell regions obey with their BLOAT. Where two of them merely met
     face to face the shared face was counted twice and the shared edge four times: 7 bad
     edges per site, 196 on a 9x9 plate, none of them a hole and all of them noise over the
     ones that were. The walls therefore start below the slab's top rather than on it, and
     the far wall stops short of the flanks' outer faces rather than reaching them. */
  const OVER = 0.05;
  const boxes = [];
  // floor slab under the whole pocket
  boxes.push([legIn - W, cavOut + W, -hw - W, hw + W, zf - 0.6, zf]);
  // near wall (seam side of the leg slot) — stops at the rebate so the bridge seats on it
  boxes.push([legIn - W, legIn, -hw - W, hw + W, zf - OVER, zReb]);
  // side walls (along-seam flanks) full height
  boxes.push([legIn - W, cavOut + W, -hw - W, -hw, zf - OVER, H]);
  boxes.push([legIn - W, cavOut + W, hw, hw + W, zf - OVER, H]);
  // far wall below the lip (cavity outer), held clear of the flanks' outer faces
  boxes.push([cavOut, cavOut + W, -hw - W/2, hw + W/2, zf - OVER, H]);
  // the lip itself: protrudes 0.12 past the throat line so the barb must click past
  const lipIn = legOut - 0.12;
  boxes.push([lipIn, cavOut + W, -hw - W, hw + W, zLip1, H]);
  const wedge = { d0: lipIn, d1: cavOut, z0: zLip0, z1: zLip1, s0: -hw, s1: hw };
  /* The envelope the plate has to give up for all of this: open to the seam, and just
     INSIDE the pocket's own skin on the other three sides and underneath, so the boxes
     above stand 0.05 mm deep in solid plate and the slicer fuses them to it.
     It used to be 0.02 mm OUTSIDE the skin on all four, which left the whole pocket a
     free-standing island in a cavity it never touched — visible only as a hairline in the
     preview, and only because the plate was cut open around it. Once the cut is a real
     subtraction the sign of that 0.02 is the difference between a pocket welded to the
     plate and a loose block sitting in a hole. */
  const env = [ -0.5, cavOut + W - OVER, -hw - W + OVER, hw + W - OVER, zf - 0.6 + OVER ];
  return { boxes, wedge, env, zf };
}
function snapTopPocket(edge, e, s, prm, H) {
  const { boxes, wedge } = snapTopParts(edge, e, s, prm, H);
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;   // depth direction into the piece
  const J = 0.0017, ss = s + J;
  const map = (d, t) => {
    if (edge === '+x' || edge === '-x') return [e + g*d, ss + t];
    return [ss + t, e + g*d];
  };
  const polys = [];
  const ccw = (pts) => {
    const a = pts.reduce((acc, p, i) => { const q = pts[(i+1)%pts.length]; return acc + p[0]*q[1] - q[0]*p[1]; }, 0);
    return a > 0 ? pts : pts.slice().reverse();
  };
  for (const [d0, d1, s0, s1, z0, z1] of boxes) {
    const pts = ccw([map(d0, s0), map(d1, s0), map(d1, s1), map(d0, s1)]);
    for (const p of extrudePoly(pts, z0, z1)) polys.push(p);
  }
  // barb-lip wedge: 45° underside so it prints without support
  const wpts = (z, d) => [map(d, wedge.s0), map(d, wedge.s1)];
  const [A0, A1] = wpts(0, wedge.d0), [B0, B1] = wpts(0, wedge.d1);
  /* The boxes above are laid out in (depth, along) and handed to extrudePoly, which
     normalises whatever winding `map` produced. The wedge is written out vertex by
     vertex and had no such protection: `map` puts down a right-handed (d, t, z) frame on
     the -x and +y edges and its mirror on +x and -y, so half of every top-snap plate
     carried the barb lip inside out — one 8-triangle shell of -0.072 mm³ per site,
     watertight, invisible to a total-volume check because it sits in a pile of
     overlapping shells that sum positive regardless. Measure the frame and reverse to
     suit, the same correction profilePrism makes for the same reason. */
  const o0 = map(0, 0), od = map(1, 0), ot = map(0, 1);
  const hand = (od[0]-o0[0])*(ot[1]-o0[1]) - (od[1]-o0[1])*(ot[0]-o0[0]);
  const face = (vs) => { const p = makePoly(hand < 0 ? vs.slice().reverse() : vs); if (p) polys.push(p); };
  face([[...A0, wedge.z1], [...B0, wedge.z0], [...B0, wedge.z1]]);
  face([[...B1, wedge.z1], [...B1, wedge.z0], [...A1, wedge.z1]]);
  // wedge slope + top + back faces
  face([[...A0, wedge.z1], [...A1, wedge.z1], [...B1, wedge.z0], [...B0, wedge.z0]]);
  face([[...B0, wedge.z0], [...B1, wedge.z0], [...B1, wedge.z1], [...B0, wedge.z1]]);
  face([[...A0, wedge.z1], [...B0, wedge.z1], [...B1, wedge.z1], [...A1, wedge.z1]]);
  return polys;
}
// the printed U-clip: cross-section in (across, z), extruded along the seam
function snapTopClip(prm, H) {
  const t = prm.legT, bd = prm.bridgeD, barb = prm.barb;
  const li = prm.legC - t/2, lo = prm.legC + t/2;
  const bl = lo + 0.15;
  // easier: define with z measured downward then flip
  const legDrop = 1.5;                       // floor 1.9 .. bridge underside 3.4
  const P = [];
  P.push([-bl, 0]); P.push([bl, 0]);                      // top of bridge
  P.push([bl, -bd]); P.push([lo, -bd]);                   // bridge right end, underside
  P.push([lo, -(bd + 0.28)]);                             // leg outer, short shank
  P.push([lo + barb, -(bd + 0.40)]);                      // barb ramp out
  P.push([lo + barb, -(bd + 0.62)]);                      // barb flat (catches lip underside)
  P.push([lo - 0.05, -(bd + 0.92)]);                      // ramp back in (insertion lead)
  P.push([lo - 0.05, -(bd + legDrop - 0.12)]);            // lower shank
  P.push([lo - 0.18, -(bd + legDrop)]);                   // tip chamfer
  P.push([li, -(bd + legDrop)]);                          // tip inner
  P.push([li, -bd]);                                      // leg inner up to bridge
  P.push([-li, -bd]);                                     // across the bridge underside
  P.push([-li, -(bd + legDrop)]);
  P.push([-lo + 0.18, -(bd + legDrop)]);
  P.push([-lo + 0.05, -(bd + legDrop - 0.12)]);
  P.push([-lo + 0.05, -(bd + 0.92)]);
  P.push([-lo - barb, -(bd + 0.62)]);
  P.push([-lo - barb, -(bd + 0.40)]);
  P.push([-lo, -(bd + 0.28)]);
  P.push([-lo, -bd]); P.push([-bl, -bd]);
  const zTopClip = bd + legDrop;
  const prof2 = P.map(([u, z]) => [u, z + zTopClip]);     // shift so bottom = 0
  const w = prm.legLen / 2;
  return profilePrism(prof2, -w, w, (u, v) => [u, v]);
}

/* The pocket a top-inserted key drops into: a floor slab with a U of wall standing on it.
 *
 * Two CLOSED extrusions that overlap, not one surface stitched together by hand. The
 * hand-stitched version was open by 8 to 38 edges depending on the key shape, wound the
 * wrong way in 5 to 11 places and carried a coplanar fold, and it read −55 mm³ of
 * enclosed volume for a pocket that displaces about +40. All of that came from the same
 * habit: it laid the floor slab across the WHOLE outer outline and then stood the walls
 * on top of the slab's face rather than joining them to its edge, so the wall feet and
 * the slab's outer rim were T-junctions on faces that no repair pass ever sees —
 * healCsgSeams runs inside csgSubtract, and nothing here was subtracted.
 *
 * The band between the two outlines is a simple polygon and that is the whole trick. Both
 * outlines run from the seam, into the piece, around the key and back to the seam, so
 * laying `out` down and returning along `inn` closes a U whose two ends sit on the seam
 * plane. extrudePoly closes a simple polygon by construction, and the slab underneath is
 * a second one. They overlap by 0.05 in z, the way every other pair of shells in this
 * file overlaps, so the slicer fuses them and neither has to know the other exists.
 *
 * The solid this makes is the same solid as before, vertex for vertex on every face a
 * key touches: wall between `inn` and `out` up to zTop, floor at zf, slab down to
 * zf − 0.6. Only the topology changed.
 */
function topPocketCup(type, edge, e, s, prm, clr, zf, zTop) {
  // trim both polylines flush at the seam plane (drop the -0.5 protrusion)
  const axis = (edge === '+x' || edge === '-x') ? 0 : 1;
  const dirOut = (edge === '+x' || edge === '+y') ? 1 : -1;   // direction pointing out of the piece
  const clampP = (pts) => pts.map(p => {
    const q = p.slice();
    if ((q[axis] - e) * dirOut > 1e-9) q[axis] = e;   // clamp only points past the seam
    return q;
  });
  const inn = clampP(keyHalf(type, edge, e, s, prm, clr));
  const out = clampP(keyHalf(type, edge, e, s, prm, clr + 0.6));
  const polys = extrudePoly(out.concat(inn.slice().reverse()), zf - 0.05, zTop);
  polys.push(...extrudePoly(out, zf - 0.6, zf));
  return polys;
}

/* One keyed junction, built the one way — the ONLY answer to "what does a key site do
   to the solid it sits in".
 *
 * There are three housings and they are not variants of each other: a bottom-inserted
 * key needs a recess cut up from the underside, a top-inserted one needs a cup built
 * down from above with the material over it clipped away, and a top-inserted snap needs
 * the leg slot and bridge rebate instead. buildPiece cuts them into a cell region and
 * buildFitSample cuts them into a coupon tile, and until now those were two
 * transcriptions of the same three constructions. The coupon's copy had never learned
 * about the last two: it answered every top-inserted configuration with the bottom
 * recess, so the coupon you printed to check your clearance tested a joint you were not
 * building — a pocket open at the wrong face, at the wrong depth, taking a key 0.3 mm
 * taller than the one in the download.
 *
 * `kind` is decided once, by the caller that can see the configuration (src/ui.js
 * activeJoint), for the same reason connectorPart and keysNeeded are: three answers to
 * one question is two too many, and the third is always the one nobody updates.
 *
 * Returns the operations for one site: `cut` — ONE closed cutter solid to subtract — and
 * `add`, closed shells to stand in the cavity it leaves.
 *
 * The top-inserted housings used to return a third thing: convex prisms for
 * clipConvexPrismTop, which peeled the material above a z-plane off whatever it was
 * handed. That is where every top-insert plate's holes came from. The clip splits the
 * surface by the prism's side planes and by the z-plane and then throws the inside-and-
 * above fragments away, and it emits NOTHING in their place — no floor at z0, no wall up
 * the prism's flanks. The result is the shape you wanted with the cut left open: 12 edges
 * on a plain box, 52 on a cell region, 1620 to 7308 on a 9x9 plate. The cup was expected
 * to close it and never could, being a separate shell 0.05 mm away.
 *
 * A closed prism through csgSubtract does the same removal AND closes it, and the reason
 * that was not done in the first place — ENGINE.md §2's ban on BSP cuts crossing the
 * socket cones — was measured rather than assumed this time. A cell region minus this
 * prism, which spans the whole rim cone band, comes back watertight and correctly
 * oriented at arcSegs 6, 12 and 24, with the volume the cut should remove. §2a already
 * said the ban had outlived the bugs behind it; this is one of the three features it was
 * written for, retested.
 */
function keySiteOps(kind, shape, prm, clr, edge, e, s, H) {
  if (kind === 'snaptop') {
    const p = snapTopPrm(clr);
    const { env } = snapTopParts(edge, e, s, p, H);
    const g2 = (edge === '+x' || edge === '+y') ? -1 : 1;
    const ss2 = s + 0.0017;
    const rect = (edge === '+x' || edge === '-x')
      ? [[e + g2*env[0], ss2 + env[2]], [e + g2*env[1], ss2 + env[2]],
         [e + g2*env[1], ss2 + env[3]], [e + g2*env[0], ss2 + env[3]]]
      : [[ss2 + env[2], e + g2*env[0]], [ss2 + env[3], e + g2*env[0]],
         [ss2 + env[3], e + g2*env[1]], [ss2 + env[2], e + g2*env[1]]];
    return { cut: extrudePoly(rect, env[4], H + 0.5),
             add: snapTopPocket(edge, e, s, p, H) };
  }
  if (kind === 'cup') {
    const zf = Math.max(1.2, H - 2.25), zTop = H - 0.85;
    /* Grown 0.55 against the cup's 0.6, so the cup's outer skin stands 0.05 inside solid
       plate — the same overlap the cell regions use, and the reason neither shell needs a
       coplanar face against the other. The cutter follows keyHalf rather than its convex
       decomposition, so the cavity is parallel to the wall it houses everywhere instead
       of squaring off across the dogbone's taper. */
    return { cut: extrudePoly(keyHalf(shape, edge, e, s, prm, clr + 0.55), zf - 0.55, H + 0.5),
             add: topPocketCup(shape, edge, e, s, prm, clr, zf, zTop) };
  }
  /* Bottom-inserted recess. The depth is prm.depth capped clear of the plate top, which
     is what every configuration was already cutting: 2.3 for the H-clip, 2.0 for both
     key housings (the floor mount's pad is forced to key.depth + 0.8, so its old
     `pad - 0.6` cap never bound). The key that goes in is prm.depth - 0.15 tall; that
     pairing is the whole reason the depth travels on the dimensions. */
  return { cut: extrudePoly(keyHalf(shape, edge, e, s, prm, clr), -0.5,
                            Math.min(prm.depth, H - 0.8)),
           add: [] };
}

// H-clip proportions expressed as a snap (dogbone) profile — proven-clean cut path
function hclipPrm(hc) {
  const endLen = hc.flangeT + 0.25;
  // depth is the recess this is cut to, as on every other key's dimensions — the clip
  // itself comes out 0.15 shorter. It used to read 2.15, the clip's height, while
  // buildPiece cut 2.3 from a literal and ui.js patched the 2.3 back on to size the part.
  return { len: hc.waistL + 2*endLen, wMid: hc.waistW, wEnd: hc.flangeW,
           endLen, taper: 0.25, depth: 2.3, clr: hc.clr };
}
// (legacy two-rect version, unused)
function hclipHalfRects(edge, e, s, hc, grow) {
  const J = 0.0017;
  const tW = hc.waistW/2 + grow, pW = hc.flangeW/2 + grow;
  const t0 = -0.5, t1 = hc.waistL/2 + grow + 0.05;          // throat span from seam
  const p0 = hc.waistL/2 - 0.05, p1 = hc.waistL/2 + hc.flangeT + grow;  // pocket span
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;      // into the piece
  const mk = (d0, d1, w) => {
    const ss = s + J;
    if (edge === '+x' || edge === '-x')
      return [[e + g*d0, ss - w], [e + g*d1, ss - w], [e + g*d1, ss + w], [e + g*d0, ss + w]];
    return [[ss - w, e + g*d0], [ss - w, e + g*d1], [ss + w, e + g*d1], [ss + w, e + g*d0]];
  };
  return [mk(t0, t1, tW), mk(p0, p1, pW)];
}

// full key outlines (for export)
function keyOutline(type, prm) {
  if (type === 'bowtie')
    return [[-prm.len/2, -prm.wEnd/2], [0, -prm.wWaist/2], [prm.len/2, -prm.wEnd/2],
            [prm.len/2, prm.wEnd/2], [0, prm.wWaist/2], [-prm.len/2, prm.wEnd/2]];
  if (type === 'hclip') {
    const wl = prm.waistL/2, ft = prm.flangeT, fw = prm.flangeW/2, ww = prm.waistW/2;
    return [[-wl-ft, -fw], [-wl, -fw], [-wl, -ww], [wl, -ww], [wl, -fw], [wl+ft, -fw],
            [wl+ft, fw], [wl, fw], [wl, ww], [-wl, ww], [-wl, fw], [-wl-ft, fw]];
  }
  if (type === 'snap') {
    const es = prm.len/2 - prm.endLen, tp = prm.taper !== undefined ? prm.taper : 0.8;
    return [[-prm.len/2, -prm.wEnd/2], [-es - tp, -prm.wEnd/2], [-es, -prm.wMid/2],
            [es, -prm.wMid/2], [es + tp, -prm.wEnd/2], [prm.len/2, -prm.wEnd/2],
            [prm.len/2, prm.wEnd/2], [es + tp, prm.wEnd/2], [es, prm.wMid/2],
            [-es, prm.wMid/2], [-es - tp, prm.wEnd/2], [-prm.len/2, prm.wEnd/2]];
  }
  // puzzlekey: two lobes joined at x = ±0.5 (guaranteed simple polygon)
  const r = prm.lobeR, cd = prm.len/2 - r;
  const aj = Math.acos(Math.max(-0.98, (0.5 - cd) / r));
  const pts = [];
  for (let k = 0; k <= 16; k++) {   // right lobe, CCW from lower junction
    const a = -aj + k * (2*aj) / 16;
    pts.push([cd + r * Math.cos(a), r * Math.sin(a)]);
  }
  for (let k = 0; k <= 16; k++) {   // left lobe
    const a = (Math.PI - aj) + k * (2*aj) / 16;
    pts.push([-cd + r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}
function buildKey(type, prm, height) {
  let polys = extrudePoly(keyOutline(type, prm), 0, height);
  if (type === 'snap') {   // spring slot through the middle
    const sl = prm.len * 0.62, sw = 1.3;
    polys = csgSubtract(polys, extrudePoly(
      [[-sl/2, -sw/2], [sl/2, -sw/2], [sl/2, sw/2], [-sl/2, sw/2]], -0.5, height + 0.5));
  }
  return polys;
}

// triangulate an annular region between outer loop (CCW) and inner loop (CCW)
// via keyhole bridging, then ear clipping
function triangulateRing(outer, inner) {
  // bridge from inner's rightmost vertex to a visible outer vertex
  let mi = 0;
  for (let i = 1; i < inner.length; i++) if (inner[i][0] > inner[mi][0]) mi = i;
  const M = inner[mi];
  const segInt = (a, b, c, d) => {
    const d1 = [b[0]-a[0], b[1]-a[1]], d2 = [d[0]-c[0], d[1]-c[1]];
    const den = d1[0]*d2[1] - d1[1]*d2[0];
    if (Math.abs(den) < 1e-12) return false;
    const t = ((c[0]-a[0])*d2[1] - (c[1]-a[1])*d2[0]) / den;
    const u = ((c[0]-a[0])*d1[1] - (c[1]-a[1])*d1[0]) / den;
    return t > 1e-7 && t < 1-1e-7 && u > 1e-7 && u < 1-1e-7;
  };
  const cand = outer.map((p, i) => [i, (p[0]-M[0])**2 + (p[1]-M[1])**2])
                    .sort((a, b) => a[1] - b[1]);
  let oi = cand[0][0];
  for (const [i] of cand) {
    const O = outer[i];
    let blocked = false;
    for (let k = 0; k < outer.length && !blocked; k++) {
      const k2 = (k+1) % outer.length;
      if (k === i || k2 === i) continue;
      if (segInt(M, O, outer[k], outer[k2])) blocked = true;
    }
    for (let k = 0; k < inner.length && !blocked; k++) {
      const k2 = (k+1) % inner.length;
      if (k === mi || k2 === mi) continue;
      if (segInt(M, O, inner[k], inner[k2])) blocked = true;
    }
    if (!blocked) { oi = i; break; }
  }
  // splice: outer[0..oi], M, inner reversed from mi, M, outer[oi..]
  const innerCW = [];
  for (let k = 0; k < inner.length; k++) innerCW.push(inner[(mi - k + inner.length) % inner.length]);
  const merged = [];
  for (let k = 0; k <= oi; k++) merged.push(outer[k]);
  merged.push(...innerCW, inner[mi].slice(), outer[oi].slice());
  for (let k = oi + 1; k < outer.length; k++) merged.push(outer[k]);
  const { pts, tris } = earTriangulate(merged);
  return { pts, tris };
}

/* The region's outline with every point the strip's edges need: where a side of `open`
   crosses it, and a corner of `open` it passes within `tol` of. A vertex within `tol` of a
   side is moved onto it, so no two points of this shell are closer than the edge-matching
   tolerance anyone reading the mesh uses (1e-3 in checkManifold).

   And a vertex within ten `tol` of a corner the outline runs through is moved onto the
   corner itself. Without that, the arc's next vertex one or two thousandths past the
   corner went onto the side's line beyond it, the outline ran out along that line and
   the strip's underside piece came back up it: a needle of no width, which earTriangulate
   dropped a triangle of, a hole in the bed face (0.1 mm margins beside 2.08 mm ones by a
   3.08 mm corner). Three and six `tol` still left some. So the outline moves by up to
   ten `tol` here, a hundredth, and by `tol` elsewhere, inside this shell only: the
   margin's region beside the strip starts more than a hundredth past the strip's side
   (clearCut), so it has none of the vertices moved. */
function openSplit(loop, open, tol) {
  let C = loop.map((p) => [p[0], p[1]]);
  const corners = [];
  for (const x of [open[0], open[2]]) for (const y of [open[1], open[3]])
    if (isFinite(x) && isFinite(y)) corners.push([x, y]);
  for (const q of corners) {
    for (let i = 0; i < C.length; i++) {
      const a = C[i], b = C[(i + 1) % C.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx*dx + dy*dy;
      const s = l2 ? Math.max(0, Math.min(1, ((q[0]-a[0])*dx + (q[1]-a[1])*dy) / l2)) : 0;
      if (Math.hypot(a[0] + s*dx - q[0], a[1] + s*dy - q[1]) > tol) continue;
      if (Math.hypot(a[0] - q[0], a[1] - q[1]) <= tol) C[i] = q.slice();
      else if (Math.hypot(b[0] - q[0], b[1] - q[1]) <= tol) C[(i + 1) % C.length] = q.slice();
      else C.splice(i + 1, 0, q.slice());
      break;
    }
  }
  const lines = [[0, open[0]], [1, open[1]], [0, open[2]], [1, open[3]]].filter(([, c]) => isFinite(c));
  for (const [k, c] of lines) for (const p of C) if (Math.abs(p[k] - c) <= tol) p[k] = c;
  for (const q of corners)
    for (const p of C) if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= 10 * tol) { p[0] = q[0]; p[1] = q[1]; }
  for (const [k, c] of lines) {
    const out = [];
    for (let i = 0; i < C.length; i++) {
      const a = C[i], b = C[(i + 1) % C.length];
      out.push(a);
      if ((a[k] - c) * (b[k] - c) < 0) {
        const p = [0, 0];
        p[k] = c;
        p[1-k] = a[1-k] + (c - a[k]) / (b[k] - a[k]) * (b[1-k] - a[1-k]);
        out.push(p);
      }
    }
    C = out;
  }
  return C.filter((p, i) => {
    const q = C[(i + 1) % C.length];
    return p[0] !== q[0] || p[1] !== q[1];
  });
}

// direct watertight mesh for a cell region (no CSG); supports closed floor (pad>0)
/* Skeleton cell region — a lighter alternative to directCellRegion.
 *
 * CONSTRUCTIVE, never subtractive. Hollowing a solid cell would mean BSP cuts in the
 * region immediately outside the socket cones, which ENGINE.md names as the confirmed
 * mesh-destroyer. So this builds less material in the first place.
 *
 * Above the socket's vertical section (z 2.5 up) the cell stays exactly as solid as
 * before: that band carries the rim, the wall pockets connectors live in, and the join
 * to neighbouring cells. Below it the material becomes a shell of `skin` following the
 * socket profile, and the bulk between that shell and the cell boundary simply is not
 * built. One closed shell, so there are no overlapping or coplanar caps to confuse a
 * slicer.
 *
 * `open`, when given, is [x0, y0, x1, y1]: the bulk is left out only inside it, and the
 * rest of the region is solid all the way down. buildPiece passes it for a cell whose
 * region has grown over part of a margin (see clearCut there), so the plastic below z 2.5
 * stays where the margin had it. ±Infinity on a side that has no such strip.
 */
function skeletonCellRegion(clipped, prof, cx, cy, H, arcSegs, skin, open) {
  const polys = [];
  /* With `open`, the bulk is left out of `under`, the part of the region inside it, rather
     than the whole region, and the outline gains the points the solid strip's edges need. */
  let under = clipped, clip = null;
  const nicks = [];
  const inOpen = (p) => !open || (p[0] >= open[0] - 1e-9 && p[0] <= open[2] + 1e-9 &&
                                  p[1] >= open[1] - 1e-9 && p[1] <= open[3] + 1e-9);
  if (open) {
    clipped = openSplit(clipped, open, 1e-3);
    // every point clipToRect works out again is one already there: the outline's, or a
    // corner of `open`, and it is given back exactly so the edges match
    const known = clipped.concat([[open[0], open[1]], [open[2], open[1]],
                                  [open[2], open[3]], [open[0], open[3]]]);
    clip = (x0, y0, x1, y1) => {
      const c = clipToRect(clipped, x0, y0, x1, y1);
      return c && c.map((p) => known.find((q) => Math.abs(q[0] - p[0]) < 1e-7 &&
                                                 Math.abs(q[1] - p[1]) < 1e-7) || p);
    };
    under = clip(open[0], open[1], open[2], open[3]);
    /* Where the outline runs through a corner of `open` itself — 1.38 mm margins by a
       4.88 mm corner put the arc through it — `under` meets the outline at that one point
       and the strip either side is pinched to nothing there: one edge with four faces on
       it. So that corner of the bulk left out is cut off NICK inside, which leaves
       0.0005 mm² of plastic the margin never had, and the strip goes round it. */
    if (under) {
      const onOutline = new Set(clipped.map((p) => `${p}`));
      const outlineEdge = new Set(clipped.map((p, i) => `${p}|${clipped[(i + 1) % clipped.length]}`));
      const NICK = 0.03, nicked = [];
      for (let i = 0; i < under.length; i++) {
        const p = under[(i + under.length - 1) % under.length], q = under[i];
        const r = under[(i + 1) % under.length];
        const along = (s) => (s[0] === q[0] || s[1] === q[1]) &&
                             Math.hypot(s[0] - q[0], s[1] - q[1]) > 2 * NICK;
        if (onOutline.has(`${q}`) && !outlineEdge.has(`${p}|${q}`) && !outlineEdge.has(`${q}|${r}`) &&
            along(p) && along(r)) {
          const toward = (s) => [q[0] + Math.sign(s[0] - q[0]) * NICK, q[1] + Math.sign(s[1] - q[1]) * NICK];
          const a = toward(p), b = toward(r);
          nicked.push(a, b);
          nicks.push([a, q, b]);
        } else nicked.push(q);
      }
      under = nicked;
    }
  }
  const zs = prof.zs.slice(1, 5), ds = prof.ds.slice(1, 5);
  const ringAt = (i, off) => {
    const d = ds[i];
    const r = prof.rTop - (d - ds[ds.length - 1]);
    return roundedSquareRing(cx, cy, prof.pitchHalf - d + off, r + off, arcSegs);
  };
  const inner = [0, 1, 2, 3].map((i) => ringAt(i, 0));
  const shell = [0, 1, 2].map((i) => ringAt(i, skin));
  const n = inner[0].length;

  // socket surface, all the way up — identical winding to directCellRegion
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a0 = [inner[i][j][0], inner[i][j][1], zs[i]], b0 = [inner[i][k][0], inner[i][k][1], zs[i]];
      const a1 = [inner[i+1][j][0], inner[i+1][j][1], zs[i+1]], b1 = [inner[i+1][k][0], inner[i+1][k][1], zs[i+1]];
      let p = makePoly([b0, a0, b1]); if (p) polys.push(p);
      p = makePoly([b1, a0, a1]); if (p) polys.push(p);
    }
  // outer face of the shell, reversed so its normals point away from the material
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a0 = [shell[i][j][0], shell[i][j][1], zs[i]], b0 = [shell[i][k][0], shell[i][k][1], zs[i]];
      const a1 = [shell[i+1][j][0], shell[i+1][j][1], zs[i+1]], b1 = [shell[i+1][k][0], shell[i+1][k][1], zs[i+1]];
      let p = makePoly([a0, b0, b1]); if (p) polys.push(p);
      p = makePoly([a0, b1, a1]); if (p) polys.push(p);
    }
  /* Same silent failure as the direct cell had: every one of these is a face with a
     hole in it, handed to the ear clipper. See annulusStrip. */
  const annulus = (outerLoop, innerLoop, z, up) =>
    polys.push(...annulusStrip(outerLoop, innerLoop, cx, cy, z, up));
  annulus(shell[0], inner[0], zs[0], false);            // underside of the shell
  annulus(under, shell[2], zs[2], false);               // underside of the solid band
  const wall = (a, b, z0, z1) => {
    const p = makePoly([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]]);
    if (p) polys.push(p);
  };
  const edges = new Set();
  for (let i = 0; i < clipped.length; i++) {            // outer wall of the solid band
    const a = clipped[i], b = clipped[(i + 1) % clipped.length];
    wall(a, b, zs[2], H);
    edges.add(`${a}|${b}`);
    // and on down to the bed where the strip is
    if (!inOpen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) wall(a, b, 0, zs[2]);
  }
  annulus(clipped, inner[3].map((v) => [v[0], v[1]]), H, true);   // the rim
  if (!open) return polys;
  // the strip's inner side, facing the bulk that is left out
  for (let i = 0; i < under.length; i++) {
    const a = under[i], b = under[(i + 1) % under.length];
    if (!edges.has(`${a}|${b}`)) wall(b, a, 0, zs[2]);
  }
  /* Its underside, in convex pieces either side of the open rectangle and a triangle at
     each nick, each piece given the points of the pieces beside it that fall along one
     of its edges — the open rectangle's corners, the ends of a nick — so their edges
     meet point for point. */
  const [ox0, oy0, ox1, oy1] = open;
  const pieces = nicks.slice();
  if (isFinite(ox0)) pieces.push(clip(-Infinity, -Infinity, ox0, Infinity));
  if (isFinite(ox1)) pieces.push(clip(ox1, -Infinity, Infinity, Infinity));
  if (isFinite(oy0)) pieces.push(clip(ox0, -Infinity, ox1, oy0));
  if (isFinite(oy1)) pieces.push(clip(ox0, oy1, ox1, Infinity));
  const ends = [[ox0, oy0], [ox0, oy1], [ox1, oy0], [ox1, oy1]]
    .filter(([x, y]) => isFinite(x) && isFinite(y))
    .concat(...nicks.map(([a, , b]) => [a, b]));
  for (const piece of pieces) {
    if (!piece) continue;
    let pts = piece;
    for (const s of ends) {
      const k = pts.findIndex((p, i) => {
        const q = pts[(i + 1) % pts.length];
        return (p[0] === s[0] && q[0] === s[0] && Math.min(p[1], q[1]) < s[1] - 1e-9 &&
                Math.max(p[1], q[1]) > s[1] + 1e-9) ||
               (p[1] === s[1] && q[1] === s[1] && Math.min(p[0], q[0]) < s[0] - 1e-9 &&
                Math.max(p[0], q[0]) > s[0] + 1e-9);
      });
      if (k >= 0) pts = pts.slice(0, k + 1).concat([s], pts.slice(k + 1));
    }
    const { pts: P, tris } = earTriangulate(pts);
    for (const t of tris) {
      const p = makePoly([[P[t[2]][0], P[t[2]][1], 0], [P[t[1]][0], P[t[1]][1], 0],
                          [P[t[0]][0], P[t[0]][1], 0]]);
      if (p) polys.push(p);
    }
  }
  return polys;
}

/* Cap the flat face between a cell outline and a socket ring.
 *
 * This is why every baseplate shipped with holes in it. The face is an annulus, and
 * an annulus is a face with a hole, which is the one job earTriangulate fails at
 * without saying so — it returns a partial result instead of throwing. On a full cell
 * the ring is 0.25 mm wide (42 mm cell, 41.5 mm socket opening), which is exactly the
 * thin-ring case that shipped bins with 218 boundary edges.
 *
 * Both loops are star-shaped about the cell centre, so they can be paired by sweeping
 * angle and advancing whichever loop's next vertex comes first. Every vertex of both
 * loops is used, so the cap meets the side wall and the socket surface exactly, and no
 * triangle is ever discarded for being degenerate. It cannot half-succeed: it emits
 * exactly outer.length + inner.length triangles or none at all.
 *
 * Sweeping on angle alone is not enough. The outer loop is a rectangle with four
 * corners; the inner ring has 4*arcSegs. So the sweep parks on one outer corner and fans
 * across a quarter of the ring — and a fan from a point outside a convex loop only stays
 * inside the annulus as far as that point's tangent to the loop. Past the tangent the
 * triangle turns over. A rim built this way is still closed and encloses the right
 * volume, so neither the manifold check nor a volume check can see it, but 21% of its
 * triangles faced downwards at the shipped arcSegs 6, and 33% at 24.
 *
 * So each step also checks the sign. When the angular choice would turn a triangle over
 * and the other choice would not, take the other: that steps the outer loop on to the
 * next corner, which is where the fan should have restarted anyway.
 *
 * On how much this was worth, since the temptation is to claim it was the bug: csgSubtract
 * builds its BSP from the region's own polygon planes, so a wrong-facing plane does make
 * the tree answer "outside" for solid material millimetres away, and it did throw away
 * part of every dovetail notch's ceiling. But measured on its own it is worth 6-17% of
 * the bad edges, and reverting only this fix leaves dovetail at 118, magnets+screws at 8
 * and the rest watertight. See ENGINE.md 2a.3. Fix it because an inside-out triangle is wrong on its
 * own terms.
 */
function annulusStrip(outerLoop, innerLoop, cx, cy, z, up) {
  const ang = (p) => {
    const a = Math.atan2(p[1] - cy, p[0] - cx);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  // CCW, and started at the vertex with the smallest angle, so angles only increase
  const norm = (loop) => {
    const L = loop.map((p) => [p[0], p[1]]);
    if (polyArea2D(L) < 0) L.reverse();
    let s = 0;
    for (let i = 1; i < L.length; i++) if (ang(L[i]) < ang(L[s])) s = i;
    return L.slice(s).concat(L.slice(0, s));
  };
  const unwrap = (L) => {
    const out = [ang(L[0])];
    for (let k = 1; k < L.length; k++) {
      let v = ang(L[k]);
      while (v < out[k - 1]) v += 2 * Math.PI;
      out.push(v);
    }
    out.push(out[0] + 2 * Math.PI);
    return out;
  };

  const O = norm(outerLoop), I = norm(innerLoop);
  const n = O.length, m = I.length;
  if (n < 3 || m < 3) return [];
  const oa = unwrap(O), ia = unwrap(I);
  const polys = [];
  const at = (v) => [v[0], v[1], z];
  const emit = (a, b, c) => {
    const p = makePoly(up ? [at(a), at(b), at(c)] : [at(c), at(b), at(a)]);
    if (p) polys.push(p);
  };

  const turn = (a, b, c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    let takeOuter = (j >= m) || (i < n && oa[i + 1] <= ia[j + 1]);
    if (i < n && j < m) {
      const byOuter = turn(O[i % n], O[(i + 1) % n], I[j % m]);
      const byInner = turn(O[i % n], I[(j + 1) % m], I[j % m]);
      if (takeOuter ? (byOuter <= 0 && byInner > 0) : (byInner <= 0 && byOuter > 0)) takeOuter = !takeOuter;
    }
    if (takeOuter) { emit(O[i % n], O[(i + 1) % n], I[j % m]); i++; }
    else { emit(O[i % n], I[(j + 1) % m], I[j % m]); j++; }
  }
  return polys;
}

/* Where a cell's bottom cap is fanned from: the average of its outline, unless a spoke
   from there passes a few thousandths from a corner of a mounting cutter's wall.

   The cutter is a cylinder of 12 or 14 sides, and the subtraction cuts the cap along
   each side's plane. Where a spoke passes that close to a corner, the two sides meeting
   there cross it a couple of thousandths apart and further than that from the corner.
   healCsgSeams takes the two crossings for one point, and the sliver between them and
   the corner, which is floor, goes with it: three open edges at the pocket's rim (one
   cell with 6 mm magnets and 4 mm corners, or 0.25 and 0.5 mm margins joined to the cell
   beside the same corner). The window is under a hundredth wide, so whether a plate hit
   it was a lottery on its margins and corner radius.

   So where a spoke from the average comes within FAN_NEAR of a corner, the fan moves to
   the first of a few points about the average from which every spoke keeps FAN_CLEAR
   from every corner and every triangle still turns the outline's way. Where the
   average's spokes are clear, which is most cells, nothing moves; where no point is
   clear, nothing moves either. The cap is the same flat face whichever point it is
   fanned from.

   The joints' cutters stand on the bottom face too (a puzzle notch's lobes, a dovetail's
   notch, a key's recess from beneath), and nothing kept the spokes off their corners. A
   spoke 8.1 microns from the corner of a puzzle notch's lobe, in a piece one cell wide
   at 14.71 mm and a field of 0.3, lost a sliver of floor 2 microns thin whichever order
   the cut was taken in (cutAgain in buildPiece): six open edges on each of three
   pieces. So they are avoided as well, with FAN_JOINT more room than the mounting
   cutters' corners, since 8.1 microns is past FAN_NEAR and still went; `avoid` takes a
   point's extra room as its third number. A plate with no joint has no such point, and
   its fan is where it was.

   The socket floor is fanned the same way, from the cell's centre (directCellRegion), and
   a magnet pocket from above or a screw's shank stands on it. An 11.1 mm magnet from
   above at 48.55 mm has a corner of each pocket 4.7 microns from a spoke to the floor's
   rounded corner, by `gap` below, and lost a sliver of floor there: six open edges in
   every cell, whatever way the pockets were cut. How near is not what decides it: main's
   pocket for that magnet has a corner 1.0 micron from the same spoke and comes out
   closed. So a cell that comes out open at the floor's height has its floor fanned again
   clear of those cutters' corners (buildPiece), from `start`, the centre it is fanned
   from when nothing is near. */
const FAN_NEAR = 0.008, FAN_CLEAR = 0.01, FAN_JOINT = 0.01;
function fanCentre(oc, avoid, start) {
  const n = oc.length, cc = [0, 0];
  if (start) { cc[0] = start[0]; cc[1] = start[1]; }
  else for (const p of oc) { cc[0] += p[0]/n; cc[1] += p[1]/n; }
  if (!avoid || !avoid.length) return cc;
  const gap = (c) => {
    let g = Infinity;
    for (const p of oc) {
      const dx = p[0] - c[0], dy = p[1] - c[1], L2 = dx*dx + dy*dy;
      if (L2 < 1e-12) continue;
      for (const q of avoid) {
        const t = Math.max(0, Math.min(1, ((q[0] - c[0])*dx + (q[1] - c[1])*dy) / L2));
        g = Math.min(g, Math.hypot(c[0] + t*dx - q[0], c[1] + t*dy - q[1]) - (q[2] || 0));
      }
    }
    return g;
  };
  if (gap(cc) >= FAN_NEAR) return cc;
  const turn = Math.sign(polyArea2D(oc));
  const fans = (c) => oc.every((p, i) => {
    const q = oc[(i + 1) % n];
    return turn * ((p[0] - c[0])*(q[1] - c[1]) - (p[1] - c[1])*(q[0] - c[0])) > 1e-6;
  });
  for (const rho of [0.05, 0.1, 0.2, 0.4, 0.8, 1.6])
    for (let k = 0; k < 12; k++) {
      const c = [cc[0] + rho*Math.cos(k*Math.PI/6), cc[1] + rho*Math.sin(k*Math.PI/6)];
      if (fans(c) && gap(c) >= FAN_CLEAR) return c;
    }
  return cc;
}

/* `half` is the cell's half size on each axis, [hx, hy]: left out, a whole cell at the
   profile's pitch. A half cell passes its own (see halfStrips) and gets the same socket,
   the same distance in from each of its sides, on a rounded rectangle: the strip around
   the socket, the rim on top and the floor cap all follow the ring, and annulusStrip
   pairs the cell outline against it by angle about the centre as it does a square, both
   loops being star-shaped about that point.

   `avoid` is where the mounting and joint cutters' walls stand on the bottom face
   (fanCentre), and `floorAvoid` where the mounting cutters' stand on the socket floor. */
function directCellRegion(clipped, prof, cx, cy, H, pad, arcSegs, half, avoid, floorAvoid) {
  const polys = [];
  const { pts: oc } = earTriangulate(clipped);
  const n = oc.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = makePoly([[oc[i][0], oc[i][1], 0], [oc[j][0], oc[j][1], 0],
                        [oc[j][0], oc[j][1], H], [oc[i][0], oc[i][1], H]]);
    if (p) polys.push(p);
  }
  const [hx, hy] = half || [prof.pitchHalf, prof.pitchHalf];
  const zs = prof.zs.slice(1, 5), ds = prof.ds.slice(1, 5);
  const rings = zs.map((z, i) => {
    const d = ds[i];
    const r = prof.rTop - (d - ds[ds.length-1]);
    return roundedRectRing(cx, cy, hx - d, hy - d, r, arcSegs).map(p => [p[0], p[1], z]);
  });
  const rn = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < rn; j++) {
      const k = (j + 1) % rn;
      let p = makePoly([rings[i][k], rings[i][j], rings[i+1][k]]); if (p) polys.push(p);
      p = makePoly([rings[i+1][k], rings[i][j], rings[i+1][j]]); if (p) polys.push(p);
    }
  }
  polys.push(...annulusStrip(oc, rings[rings.length - 1], cx, cy, H, true));
  if (pad > 0.01) {
    /* Full bottom cap, fanned from the region's centre — the same construction as the
       socket floor disc below it, and for the same reason.
     *
     * It was an ear clip, which on a four-corner region is two triangles and a diagonal
     * and is perfectly well behaved. Give the region a rounded outer corner and it
     * becomes a thirteen-gon, and ear clipping a thirteen-gon lays a chain of chords
     * right across the cell — chords that skim the mounting cylinders tangentially, carve
     * the same corner of a facet twice a few microns apart, and leave the sliver spurs
     * this file spends healCsgSeams repairing. Measured over outer radii 0 to 5 with
     * magnets, screws and both: the ear clip leaks at r = 2 and r = 4 and is clean either
     * side, which is a lottery rather than a property. A fan from an interior point has
     * no chords: every edge either lies on the outline or runs to one fixed point. */
    const cc = fanCentre(oc, avoid);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = makePoly([[cc[0], cc[1], 0], [oc[j][0], oc[j][1], 0], [oc[i][0], oc[i][1], 0]]);
      if (p) polys.push(p);
    }
    const fl = rings[0];
    const c = [...(floorAvoid ? fanCentre(fl, floorAvoid, [cx, cy]) : [cx, cy]), fl[0][2]];
    // whether that fan moved: where it did not, the floor is the one it would have been
    if (c[0] !== cx || c[1] !== cy) polys.floorMoved = true;
    for (let j = 0; j < rn; j++) {
      const k = (j + 1) % rn;
      const p = makePoly([c, fl[j], fl[k]]); if (p) polys.push(p);
    }
  } else {
    /* No floor pad means the socket runs clean through, so the underside is the same
       annulus as the top. It used to be left off entirely, which is half of every
       plate's missing faces.
     *
     * There used to be a SECOND underside here as well — a triangulateRing keyhole cap
     * over the same annulus — left behind when annulusStrip took the job over. It looked
     * harmless because on every shipped plate it emitted nothing at all: the keyhole
     * merge of a 4-corner outline with the socket ring is the malformed input
     * earTriangulate gives up on, and giving up silently is exactly what it does. Feed it
     * an outline with rounded corners and it makes partial progress instead — 37
     * triangles where the annulus needs 68 — laying a second, incomplete floor on top of
     * the first. That was the whole of the test tile's 47 boundary edges (42 used three
     * times where the two caps overlapped, 5 used once where neither reached), and the
     * tile was the only caller that ever passed a rounded outline in. */
    polys.push(...annulusStrip(oc, rings[0], cx, cy, rings[0][0][2], false));
  }
  return polys;
}

// ---------- plate builder ----------
/* One print layer, at the 0.2 mm the page's material estimate assumes (its 0.8 mm top
   and bottom skins are four layers). The thinnest plastic a slicer can be counted on to
   lay down: between two faces closer than this it may put nothing at all, so a floor
   that thin can print as a hole however closed the mesh is. */
const PRINT_LAYER = 0.2;
/* Plastic left between a mounting pocket and the face it stops short of: one layer. The
   solid floor was a fixed 2.8 mm, so a 6 × 3 mm magnet, as common as the 6 × 2 the spec
   draws, was cut clean through it: from above it fell out of the bottom, from below it
   stood 0.2 mm proud of the socket floor.
   One layer and no more, because more raises plates that were sound: 2.8 mm holds the
   spec's 6.5 × 2.4 magnet over 0.4 of plastic and always printed it, and a 0.6 skin makes
   that plate 0.2 mm taller — and the height the Bins page is handed with it — for
   nothing. So the floor stays 2.8 for anything up to 2.6 deep, as it always was, and
   grows only past that, where what is left under the pocket might not print. A corner
   boss is held to the same line: 2.6 tall, so 2.4 deep at most. */
const MOUNT_SKIN = PRINT_LAYER;
/* The corner bosses of baseMode 'bosses': a quarter square this far in from each cell
   corner, its inner corner rounded, never taller than BOSS_H. Named because mountLimits
   has to know how much room a boss leaves around its pocket. */
const BOSS_W = 12.5, BOSS_R = 3.5, BOSS_H = 2.6;

/* How thick the solid floor under the sockets is: what was asked for, raised to whatever
   the plate is carrying needs. A pocket cut into the floor — a magnet from either side, a
   screw head's counterbore from below — has to be shallower than the floor by
   MOUNT_SKIN, or it is a hole.
   Its own function because the page needs the plate's height before anything is built:
   a plate taller than the printer can build is a check, not a surprise in the slicer. */
function platePad(cfg) {
  let pad = cfg.bottomPad;
  /* Rounded to the micron, because 2.6 + 0.2 is 2.8000000000000003 and that is not a
     reason to move every face of a plate that was 2.8 before. */
  const under = (depth) => Math.round((depth + MOUNT_SKIN) * 1e6) / 1e6;
  if ((cfg.magnets || cfg.screws) && cfg.baseMode !== 'bosses') {
    pad = Math.max(pad, cfg.magnetBase || 2.8);
    if (cfg.magnets) pad = Math.max(pad, under(cfg.magnetH));
    if (cfg.screws && cfg.screwHeadD > cfg.screwHoleD)
      pad = Math.max(pad, under(cfg.screwHeadDepth));
  }
  const keyedConn = ['bowtie', 'snap', 'puzzlekey'].includes(cfg.connector);
  if (keyedConn && cfg.keyMount !== 'wall') pad = Math.max(pad, cfg.key.depth + 0.8);
  if (cfg.connector === 'puzzle') pad = Math.max(pad, 2.6);
  return pad;
}

/* Plastic left round a mounting cut, to whatever holds it. 1 mm rather than a token
   wall, and measured: the sites sit holeOffset from each cell centre whatever the
   pitch, and with less than this between them and the socket floor's edge the cutter's
   facets graze the floor's own triangulation — screws at a 36 mm pitch leaked 192 edges
   with 0.65 mm to spare. */
const MOUNT_WALL = 1.0;
/* How near a pocket's ceiling may come to a dovetail notch's before the two count as
   level, and how near its walls may come to any joint's cut without breaking into it.
   See mountLimits. */
const MOUNT_LEVEL = 0.05, MOUNT_SEAM = 0.01;
/* How far a mounting bore about (x, y) can grow before it meets any of `segs`, as the
   radius of the circle through its corners: the polygon cylinder() cuts, `sides` flats
   with a corner at every 2πk/sides from +x. A point is in that polygon when it stands no
   further out along any flat's normal than R cos(π/sides), so along one segment the
   least R that takes a point of it in is at an end, or where the segment crosses the
   line out through a corner, on which a point's R is its distance. */
function boreReach(sides, segs, x, y) {
  const step = 2 * Math.PI / sides, h = Math.cos(step / 2);
  const cx = [], cy = [], nx = [], ny = [];
  for (let k = 0; k < sides; k++) {
    cx.push(Math.cos(k * step)); cy.push(Math.sin(k * step));
    nx.push(Math.cos((k + 0.5) * step)); ny.push(Math.sin((k + 0.5) * step));
  }
  const at = (dx, dy) => {
    let m = -Infinity;
    for (let k = 0; k < sides; k++) m = Math.max(m, dx * nx[k] + dy * ny[k]);
    return m / h;
  };
  let r = Infinity;
  for (const [a, b] of segs) {
    const ax = a[0] - x, ay = a[1] - y, ex = b[0] - a[0], ey = b[1] - a[1];
    r = Math.min(r, at(ax, ay), at(ax + ex, ay + ey));
    for (let k = 0; k < sides; k++) {
      const den = ex * cy[k] - ey * cx[k];
      if (Math.abs(den) < 1e-12) continue;
      const t = (ay * cx[k] - ax * cy[k]) / den;
      if (t < 0 || t > 1) continue;
      const s = (ax + t * ex) * cx[k] + (ay + t * ey) * cy[k];
      if (s >= 0) r = Math.min(r, s);
    }
  }
  return r;
}
/* The largest mounting cuts this configuration has room for, as diameters and depths in
   the units the page's fields use. Magnets and screws sit holeOffset (13 mm, the spec's)
   from each cell centre at ANY pitch, so the room round them shrinks with the pitch:
   below about 34 mm a stock magnet pocket no longer fits inside its cell at all, and every
   magnet-and-screw leak a pitch sweep found, 24.5 to 36 mm, was a cutter out past the
   socket floor or the cell edge.
 *
 * Three kinds of room, by where the cut opens:
 *   - into the socket (a magnet from above, the screw shank): it must stay on the socket
 *     floor, or it crosses the floor's chamfer cone — see ENGINE.md §2;
 *   - under the floor (a magnet from below, the counterbore): it must stay in its cell;
 *   - in a corner boss: it must stay in the boss, which is shorter than the solid floor
 *     and does not grow with the pocket, so it also caps the depth.
 *
 * And whichever way it opens, it must stay out of a joint's cut in the floor beside it:
 * a key's recess, or the notch a tab fits into, where a dovetail's lets a pocket from
 * beneath in only so far as its tab leaves room. That one needs `layout`, which says
 * where the seams are; without it no joint is counted.
 *
 * These are measurements, not field ranges, and can come out below the field's minimum
 * or negative — a screw shank at a 34 mm pitch has −0.1 mm. That means no cut of any size
 * fits there; the page turns it into a check on the design rather than a range for the
 * field (src/ui.js readNumber), since no number typed into the field could fix it.
 *
 * `known` is the `cuts` of an earlier answer for the same design on the same layout,
 * with only the mounting sizes changed since: the joint's cuts are not measured again
 * unless the floor has moved, which moves their ceilings. The page reads the magnet's
 * size last and asks again for it, after the screws' sizes have settled the floor. */
function mountLimits(cfg, layout, known) {
  const half = cfg.pitch / 2, off = cfg.holeOffset;
  const tol = cfg.tolerance === 'tight' ? +0.1 : cfg.tolerance === 'loose' ? -0.1 : 0;
  // distance from a point at (s, s) to the edge of a rounded square of half-size h,
  // corner radius r, centred on the origin
  const roomIn = (h, r, s) => {
    const q = s - (h - r);
    return q > 0 ? r - Math.SQRT2 * q : h - s;
  };
  // the socket floor ring, as buildPiece's profile and roundedSquareRing make it
  const dBot = 2.85 + tol, hf = half - dBot;
  const rf = Math.max(0.3, Math.min(cfg.socketRadius - (dBot - cfg.topCutoff), hf - 0.01));
  const onFloor = roomIn(hf, rf, off) - MOUNT_WALL;
  const inCell = half - off - MOUNT_WALL;
  const s = half - off;              // the site's distance in from the cell's edges
  const inBoss = Math.min(roomIn(BOSS_W, BOSS_R, s), s) - MOUNT_WALL;
  const bosses = cfg.baseMode === 'bosses';
  const top = bosses ? inBoss : onFloor, under = bosses ? inBoss : inCell;
  const r10 = (x) => Math.floor(x * 10 + 1e-9) / 10;   // the fields step in tenths
  /* A cell's four sites are 2 × holeOffset apart, 26 mm, so past a pitch of about 50 mm
     the room above lets a cut reach the one beside it before it reaches anything else:
     two 1-inch magnet pockets met at a 55 mm pitch and left 52 open edges. Each cut stops
     half a MOUNT_WALL short of the line halfway between two sites, so a pocket's corners
     stop at 12.5 mm and the wall between two pockets is at least MOUNT_WALL, 1 mm. */
  const beside = off - MOUNT_WALL / 2;
  const fit = (r) => Math.min(r, beside);
  /* A joint cut up into the solid floor beside the sites: the recess a key or an H-clip
     is put into from beneath (keyPlan's 'recess', in the floor or in the wall), or the
     notch a dovetail or puzzle tab fits into (tabNotch). Each starts under the plate, as
     a magnet pocket from beneath, a counterbore and a shank do, so any of those that
     reaches one in plan has broken into it. A magnet from above meets it unless the
     pocket's floor stands at least MOUNT_SKIN over the cut's ceiling. The housings a key
     is dropped into from above (keySiteOps' 'cup' and 'snaptop') start 1.3 mm or more
     over the socket floor: a pocket from above stops under them, and a shank, which
     stays on the socket floor, is in the socket's open air up there.

     Measured off the solids buildPiece cuts, at the sites it cuts pockets at: whole cells
     only, so a housing beside a half cell or a margin is measured from the whole cell on
     the other side of it, which is the only one with pockets. A corner boss is left out:
     its pocket is cut in the boss, a shell of its own that no joint is cut from.

     Issue #64: a bowtie in the floor at 42 mm, with magnets from beneath, built 12 bad
     edges at 7.9 mm and 19 at 10, with Download on; puzzle tabs at 36 to 40 mm built 26
     to 86 with the spec's 6.5 × 2.4 magnet. The pocket had run into the cut with its
     ceiling level with the cut's: a 2 mm magnet or the default counterbore with a key's
     2 mm recess, a 2.4 mm magnet with a tab's notch. The two ceilings then share a face
     that two subtractions split their own ways. All 86 pockets tried level with a cut
     went bad; moved 0.001 mm up or down, 3 of them did, and 0.003 mm or more, none.
     MOUNT_LEVEL counts 0.05 mm as level.

     Off the level, what a pocket may do depends on the cut, measured on random designs
     past where a pocket first meets one: keys and tabs, magnets from both sides, screw
     heads and shanks, halves and margins, pitches that are not round numbers.
       - A key's recess, an H-clip's or a puzzle tab's notch takes no pocket at all ('cut').
         One a sliver in has gone bad off the level: 0.019 mm into a snap key's recess at
         36.52 mm, with a 0.5 mm fit clearance, at four depths on main. Let in wherever
         the magnet or screw stayed clear of the key or tab, 7 of 2,519 such pockets at
         the default fit or tighter went bad, 0.02 to 0.14 mm in, and 8 of 1,151 at
         looser fits, 0.2 to 0.65 mm in.
       - A dovetail's notch takes a pocket from beneath, a sliver or deep, unless it is
         level with the notch ('level') or the magnet or screw in it would reach the other
         piece's tab, which stands the fit clearance inside the notch ('part'). None of
         3,699 such designs went bad, 1,086 of them on the page's design at 40.5 to
         44.5 mm. So a 12.7 mm magnet at 42 mm, 2 or 3 mm thick, is taken: its pocket is
         0.04 to 0.09 mm into the notch and the magnet 0.24 mm clear of the tab.
       - A pocket from above meets any of them unless its floor stands a layer over the
         cut's ceiling ('floor').
     The pocket is measured as fastenerCutter cuts it, as a polygon (boreReach), not by the
     circle through its corners, which kept sizes out that came a flat's width short.

     A pocket that stops short of a cut stops MOUNT_SEAM short. The weld in healCsgSeams
     takes points VTOL apart for one, and a thinner wall than a few of those can come out
     welded through: 4 of 715 pockets less than 0.005 mm short went bad, and none of 1,941
     from 0.005 to 0.03 mm. Under a dovetail's notch that leaves a gap of refused sizes
     below the largest (`gaps`), between the one that stops MOUNT_SEAM short and the one
     that breaks in. Past the weld's reach there is still the lottery the room measured
     here does not see, about one design in a thousand, single sizes with clean ones on
     either side, and it needs the pocket and the cut together: a 14.1 mm counterbore 2.4 to 3 mm deep, 0.09 mm short of a dovetail's notch
     at 43.17 mm, loose, folds an edge at the notch's corner, byte for byte as on main,
     and is clean at 2.35 mm deep, at 14.075 and 14.125 mm across, at every size from there
     into the notch, and with no counterbore. A guard out that far would refuse sizes that
     build clean on both sides of it and still miss the next, 0.1 mm off. A wall of 1 mm
     would refuse the 6 mm magnet from beneath with a bowtie at 42 mm, which has 0.84 mm
     to spare and always built clean. */
  const pad = platePad(cfg), again = !!known && known.pad === pad;
  /* Each cut as { top, sites }: its ceiling, and each site in reach of it as how far a
     bore's corner circle (`room`) and the bores themselves (`bore`, by their sides) can
     grow before they meet the cut, and a magnet or screw (`body`) before it meets the
     part in it. */
  const jointCuts = again ? known.list : [];
  /* Room past the most the cell or the floor leaves cannot stop a size, so nothing
     further off than that is measured, and nothing at all where neither leaves any. A
     plate the page will build has at most 900 cells; at 30 × 30 with puzzle tabs this
     is a few milliseconds, on every redraw. */
  const reach = Math.max(fit(top), fit(under));
  if (layout && !again && !bosses && cfg.connector !== 'none' && reach > 0) {
    const plan = keyPlan(cfg), H = pad + cfg.plateHeight;
    /* A cut's footprint, as the segments its walls stand on, its extent and its ceiling,
       for each seam it can be cut from, and the part's that goes in it: the key's half,
       or the tab of the piece across the seam, as buildPiece stands it there, the fit
       clearance inside the cut. Every cut from one seam is the same solid moved along it
       (keyHalf, puzzleShape, tabNotch), so it is worked out at the origin once and each
       site is moved the other way instead. */
    const shapes = {};
    const ring = (pts) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);
    const shapeOf = (edge) => {
      if (shapes[edge]) return shapes[edge];
      const at = { edge, e: 0, s: 0 };
      const solid = plan.kind === 'recess'
        ? keySiteOps(plan.kind, plan.shape, plan.prm, plan.clr, edge, 0, 0, H).cut
        : tabNotch(cfg, at, pad);
      const segs = [], bb = [Infinity, Infinity, -Infinity, -Infinity];
      let ceiling = -Infinity;
      for (const p of solid) {
        for (const v of p.verts) {
          ceiling = Math.max(ceiling, v[2]);
          bb[0] = Math.min(bb[0], v[0]); bb[1] = Math.min(bb[1], v[1]);
          bb[2] = Math.max(bb[2], v[0]); bb[3] = Math.max(bb[3], v[1]);
        }
        if (Math.abs(p.plane.n[2]) > 1e-9) continue;
        const a = p.verts[0], b = p.verts.find((v) => Math.hypot(v[0] - a[0], v[1] - a[1]) > 1e-9);
        if (b) segs.push([a, b]);
      }
      const part = plan.kind === 'recess' ? keyHalf(plan.shape, edge, 0, 0, plan.prm, 0)
        : cfg.connector === 'puzzle' ? puzzleShape(OPP[edge], 0, 0, cfg.puzzle, 0, false)
        : tabFootprint(OPP[edge], 0, 0, cfg.tab.wr, cfg.tab.wt, cfg.tab.dp, 0.8);
      return (shapes[edge] = { segs, bb, ceiling, part: ring(part) });
    };
    // how far a point is from the footprint, less than none inside it
    const from = (segs, x, y) => {
      let d = Infinity, inside = false;
      for (const [a, b] of segs) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0])*dx + (y - a[1])*dy) / (dx*dx + dy*dy)));
        d = Math.min(d, Math.hypot(a[0] + t*dx - x, a[1] + t*dy - y));
        if ((a[1] > y) !== (b[1] > y) && x < a[0] + (y - a[1]) * dx / dy) inside = !inside;
      }
      return inside ? -d : d;
    };
    for (const piece of layout.pieces) {
      const conn = pieceConnectors(cfg, layout, piece);
      // the cuts buildPiece makes in this piece: notches for tabs, recesses for keys
      const cuts = [...conn.notches, ...conn.pnotches, ...(plan.kind !== 'recess' ? []
        : conn.keyed.filter((bo) => !(plan.junction && offJunction(bo, cfg.pitch, piece))))];
      for (const bo of cuts) {
        const { segs, bb, ceiling, part } = shapeOf(bo.edge);
        const across = bo.edge === '+x' || bo.edge === '-x';
        const ox = across ? bo.e : bo.s, oy = across ? bo.s : bo.e;
        // the whole cells with a site in reach of it (a half cell has none; see buildPiece)
        const cells = (lo, hi, m, n) => [Math.max(0, Math.floor((lo - reach - off - half - m) / cfg.pitch)),
                                          Math.min(n - 1, Math.ceil((hi + reach + off - half - m) / cfg.pitch))];
        const [i0, i1] = cells(bb[0] + ox, bb[2] + ox, piece.mL, piece.nx);
        const [j0, j1] = cells(bb[1] + oy, bb[3] + oy, piece.mF, piece.ny);
        const sites = [];
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++)
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            const x = piece.mL + i*cfg.pitch + half + sx*off - ox;
            const y = piece.mF + j*cfg.pitch + half + sy*off - oy;
            if (x < bb[0] - reach || x > bb[2] + reach || y < bb[1] - reach || y > bb[3] + reach) continue;
            // the bores and the part stand further off than the corner circle, or as far
            const room = from(segs, x, y);
            if (room >= reach) continue;
            const bore = (n) => room > 0 ? boreReach(n, segs, x, y) : room;
            sites.push({ room, body: from(part, x, y), bore: { 12: bore(12), 14: bore(14) } });
          }
        if (sites.length) jointCuts.push({ top: ceiling, sites });
      }
    }
  }
  /* The bores as fastenerCutter cuts them, in one place: how many sides, and the largest
     size whose corners stay inside a radius. A magnet's corners are 0.1 mm over its
     radius, or out to where its flats stand on that radius if that is further; a screw's
     bores have their corners on its size. */
  const BORE = {
    magnetD: { sides: 14, fits: (r) => 2 * Math.min(r - 0.1, r * Math.cos(Math.PI / 14)) },
    screwHeadD: { sides: 14, fits: (r) => 2 * r },
    screwHoleD: { sides: 12, fits: (r) => 2 * r },
  };
  // the room the cell, the floor or a boss leaves, and the hole beside
  const own = { magnetD: fit(cfg.magnetSide === 'top' ? top : under), screwHoleD: fit(top), screwHeadD: fit(under) };
  // a dovetail's notch takes a pocket from beneath that breaks into it; every other cut does not
  const notch = cfg.connector === 'dovetail';
  /* What the joint's cuts leave one size, as { cap, why, near }: the largest size, and what
     stops it: 'cut', a pocket that would break into a key's recess or a puzzle tab's notch;
     'floor', one from above that leaves no layer of floor over a cut; 'level', one from
     beneath as deep as a dovetail's notch; 'part', a magnet or screw that would reach the
     tab in one. Each stops MOUNT_SEAM short of the cut. `near` is where that leaves sizes
     under the cap refused, as [from, to]: a dovetail's notch, which a pocket may break
     into, but not stop just short of. */
  const jointFor = (f) => {
    const { sides, fits } = BORE[f];
    const above = f === 'magnetD' && cfg.magnetSide === 'top';
    // how high a pocket from beneath goes; a shank goes through
    const ceiling = f === 'magnetD' ? cfg.magnetH : f === 'screwHeadD' ? cfg.screwHeadDepth : Infinity;
    let cap = Infinity, why = false;
    const near = [];
    for (const c of jointCuts) {
      // a pocket from above clears a cut whose ceiling it leaves a layer of floor over
      if (above && !(c.top + MOUNT_SKIN > pad - cfg.magnetH + 1e-6)) continue;
      const stop = above ? 'floor' : !notch ? 'cut' : Math.abs(ceiling - c.top) < MOUNT_LEVEL ? 'level' : 'part';
      for (const s of c.sites) {
        const short = fits(s.bore[sides] - MOUNT_SEAM);
        const size = stop === 'part' ? 2 * s.body : short;
        if (size < cap) { cap = size; why = stop; }
        if (stop === 'part') near.push([short, fits(s.bore[sides])]);
      }
    }
    return { cap, why, near };
  };
  const sizes = {}, joint = {}, gaps = {};
  for (const f of ['magnetD', 'screwHoleD', 'screwHeadD']) {
    const cell = BORE[f].fits(own[f]), J = jointFor(f);
    let size = r10(Math.min(cell, J.cap));
    joint[f] = J.cap < cell && J.why;
    /* The sizes `near` refuses, out to the tenths either side, as the cap is: each gap is
       [from, to], both taken. One that reaches the cap brings it down to where it starts. */
    const out = [];
    for (const [a, b] of J.near.sort((x, y) => x[0] - y[0])) {
      const from = r10(a), to = (Math.floor(b * 10 + 1e-9) + 1) / 10;
      if (to <= 0) continue;
      if (out.length && from < out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], to);
      else out.push([from, to]);
    }
    gaps[f] = [];
    for (const [from, to] of out) {
      if (from >= size) break;
      if (to > size) { size = from; joint[f] = 'near'; break; }
      gaps[f].push([from, to]);
    }
    sizes[f] = size;
  }
  return {
    magnetD: sizes.magnetD,
    screwHoleD: sizes.screwHoleD,
    screwHeadD: sizes.screwHeadD,
    // in the solid floor the pad grows to suit, so only a boss caps the depth
    depth: bosses ? r10(BOSS_H - MOUNT_SKIN) : Infinity,
    // which of the sizes the cut beside it stops, rather than the floor, cell or boss
    beside: { magnetD: own.magnetD === beside && !joint.magnetD,
              screwHoleD: own.screwHoleD === beside && !joint.screwHoleD,
              screwHeadD: own.screwHeadD === beside && !joint.screwHeadD },
    // and which a joint's cut stops, before any of those, and how (jointFor)
    joint,
    // sizes under the largest refused all the same, as [from, to] with both ends taken
    gaps,
    // what was measured of the joint's cuts, for `known`
    cuts: { pad, list: jointCuts },
  };
}

/* What a keyed joint cuts, worked out once for buildPiece and for keysMeet: which of
   keySiteOps' housings, the key's shape, its dimensions and clearance, and whether a
   site needs a wall junction — a key housed in the wall does, and so does every housing
   put in from above, so a seam's mid-cell site gets none of those.

   `kind` is from jointKind, like everyone else. src/ui.js activeJoint asks it for the
   loose part and the fit coupon, and the audit asks it too; buildPiece was the fourth
   copy of the rule and the last one, written out longhand under a comment saying the
   decision lived elsewhere.

   It was never a live defect. jointKind falls back to the connector's own name where
   that expression said 'recess', so the two disagree for dovetail, puzzle and none — and
   every reader of the kind is inside a loop over `keyed`, which pieceConnectors leaves
   empty for exactly those three (isTab, and the early return for 'none'). The one thing
   to keep true, then, is that emptiness: if `keyed` ever carries sites for a tabbed
   connector, this starts answering a question it used to duck. Byte-identical output
   across the 112-config matrix either way.

   The snap's clip is one part at one size whatever the housing, so its fit comes from
   the full key's clearance; a flat key takes its own housing's. */
function keyPlan(cfg) {
  const isHclip = cfg.connector === 'hclip';
  const wallKeys = ['bowtie', 'snap', 'puzzlekey'].includes(cfg.connector) && cfg.keyMount === 'wall';
  const dims = wallKeys ? cfg.keySlim : cfg.key;
  const kind = jointKind(cfg.connector, cfg.keyMount, cfg.keyInsert);
  return { kind, dims,
           shape: isHclip ? 'snap' : cfg.keyType,
           prm: isHclip ? hclipPrm(cfg.hclip) : dims,
           clr: kind === 'snaptop' ? cfg.key.clr : isHclip ? cfg.hclip.clr : dims.clr,
           junction: kind !== 'recess' || wallKeys || isHclip };
}
// a keyed site a quarter cell or more from any cell junction, in the piece's own frame
// and from its first whole cell, which differ by its margin
function offJunction(bo, pitch, piece) {
  const g0 = bo.edge === '+x' || bo.edge === '-x' ? piece.mF : piece.mL;
  const off = (v) => Math.abs(v / pitch - Math.round(v / pitch)) > 0.25;
  return off(bo.s) && off(bo.s - g0);
}
/* The pieces in which two key housings would meet, as [{ id, needs, across }]: `needs` is
 * how deep the piece would have to be, in mm, for the pair that comes closest to stand a
 * BLOAT apart — which for a piece one cell deep is the pitch it needs — and `across` says
 * which way: 'deep' for keys in its front and back seams, 'wide' for its left and right.
 *
 * A piece one cell deep with a seam on each side takes a key from each, at the same place
 * along the two seams wherever the cuts line up, which is always for a midpoint. Each key's
 * housing reaches half the key and its clearance into the piece — 7.15 mm for the full key —
 * so below about 14.3 mm of pitch the two housings run into each other. buildPiece hands
 * them to one subtraction as two overlapping solids, which a BSP cannot classify (ENGINE.md
 * §1, one cutter solid per subtraction), and subtracting them one after the other leaks
 * as well. A 13.5 mm plate cut into rows one cell deep leaked 47 to 117 open edges in its
 * middle row with the bowtie, the puzzle key and the snap in the floor, and 90 and 96 with
 * a key in the wall put in from above, whose cup reaches 7.17.
 *
 * Unioning the two cutters first closes the mesh of a key in the floor, and it would still
 * be wrong, which is why this refuses rather than repairs. The key is 14 mm long, so
 * below 14 mm the two keys themselves overlap and the second will not go in, and from 14
 * up to where the housings clear they would share one slot, tip to tip. The page puts
 * this in Checks, where a moved cut, a larger pitch or another joint clears it; nothing
 * here can.
 *
 * Measured off the solids keySiteOps cuts, so it is the same housing buildPiece makes,
 * with the same sites: pieceConnectors' list less any a wall junction rules out. Two keys
 * on one seam are a pitch apart along it, and a key in a side seam sits a whole cell in
 * from the corner, so only facing keys come this close: at a pitch that leaves room for
 * two housings' reach and a BLOAT, nothing can meet and there is nothing to measure. The
 * page asks on every redraw, and at 42 mm that is one housing rather than one per site. */
function keysMeet(cfg, layout) {
  if (!['bowtie', 'puzzlekey', 'snap', 'hclip'].includes(cfg.connector)) return [];
  const plan = keyPlan(cfg), H = platePad(cfg) + cfg.plateHeight;
  const APART = 0.05;   // buildPiece's BLOAT
  const box = (bo) => {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of keySiteOps(plan.kind, plan.shape, plan.prm, plan.clr, bo.edge, bo.e, bo.s, H).cut)
      for (const v of p.verts) {
        b[0] = Math.min(b[0], v[0]); b[1] = Math.min(b[1], v[1]);
        b[2] = Math.max(b[2], v[0]); b[3] = Math.max(b[3], v[1]);
      }
    return b;
  };
  // how far a housing reaches into the piece from the seam it is cut from
  if (cfg.pitch >= 2 * box({ edge: '-y', e: 0, s: 0 })[3] + APART - 1e-9) return [];
  const out = [];
  for (const piece of layout.pieces) {
    const hs = [];
    for (const bo of pieceConnectors(cfg, layout, piece).keyed) {
      if (plan.junction && offJunction(bo, cfg.pitch, piece)) continue;
      const b = box(bo);
      const reach = bo.edge === '-x' ? b[2] - bo.e : bo.edge === '+x' ? bo.e - b[0]
                  : bo.edge === '-y' ? b[3] - bo.e : bo.e - b[1];
      hs.push({ b, reach, across: bo.edge === '-y' || bo.edge === '+y' ? 'deep' : 'wide' });
    }
    let needs = 0, across = null;
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i].b, c = hs[j].b;
      const near = (lo, hi) => lo < hi + APART - 1e-9;
      if (near(a[0], c[2]) && near(c[0], a[2]) && near(a[1], c[3]) && near(c[1], a[3]) &&
          hs[i].reach + hs[j].reach + APART > needs) {
        needs = hs[i].reach + hs[j].reach + APART;
        across = hs[i].across;
      }
    }
    if (needs) out.push({ id: piece.id, needs, across });
  }
  return out;
}
/* Joints that would fit where keysMeet refuses, as [{ id, over }], `over` being the
   settings that make it: dovetail and puzzle tabs, which have no housing to meet; the
   H-clip put in from beneath or from above; a snap clip in the wall put in from above;
   and the same key housed in the wall, put in from beneath (its slim key reaches 6.6 mm)
   or from above (the cup). Each is put to keysMeet on the design as it stands, so one is
   only named where it is clear, and only from the pitch it was measured to build clean
   at, `from`.

   `over` is the whole of what has to change, insert direction included, and the H-clip
   is two joints for that reason. Picking H-clips on the page keeps the Key insertion
   already set, and it was named from beneath alone: after a key put in from above you
   got the H-clip from above, which nothing had named or built, and which leaked at a
   field of 0.74 at every pitch. The snap clip from above is housed in the wall because
   that is where the page offers it: the insert control is only there for a key in the
   wall. On a snap plate it is the cup itself, so the cup is not named there twice.

   Clear was not clean. At pitches this small the joints leaked on their own, a few open
   edges at a time and at no pitch or clearance that a rule could pick out, and naming
   every joint keysMeet cleared sent people to them: dovetail tabs at 13.6 mm with a
   field of 0.3, 3 to 12 open edges. So each was named only from the pitch it had been
   swept clean from (the dovetail 14.5 mm, the H-clip from beneath 14.3, a puzzle key in
   the wall from beneath 14.5 and a snap clip 15.3, a key in the wall from above 14.5),
   and puzzle tabs, which leaked up to 15.94, the whole range, not at all. Those leaks
   were the lottery of the joint's cut, which buildPiece now takes again (cutAgain), and
   they are gone. Every design keysMeet refuses, built with each joint it clears instead:
   pitches 13.5 to 15.94 mm by 0.01, the last that refuses anything (a snap clip in the
   floor with a field of 1); the field every 0.1 from 0 to 1 and at 0.05, 0.15, 0.25,
   0.35 and 0.74, as far as the joint in use allows, and for the joint named no higher
   than its own ceiling, since the page refuses a field over it ("Fit clearance must be
   ... or less") until it is lowered; rows one cell deep, columns one cell wide, and both
   in one drawer; with every key and housing that is refused: 22,008 plates, none open,
   with shells touching or with a fold. So every joint is named from wherever it clears,
   and `from` is there for one that ever has to be held back again. test/plate-audit.js
   builds every joint this names over that range again, on a coarser grid. */
const KEY_ALTERNATIVES = [
  ['dovetail', { connector: 'dovetail' }, 0],
  ['puzzle', { connector: 'puzzle' }, 0],
  ['hclip', { connector: 'hclip', keyInsert: 'bottom' }, 0],
  ['hclip top', { connector: 'hclip', keyInsert: 'top' }, 0],
  ['snap top', { connector: 'snap', keyType: 'snap', keyMount: 'wall', keyInsert: 'top' }, 0],
  ['wall', { keyMount: 'wall', keyInsert: 'bottom' }, { bowtie: 0, puzzlekey: 0, snap: 0 }],
  // none for a snap plate: its cup is the snap clip from above, named once as 'snap top'
  ['cup', { keyMount: 'wall', keyInsert: 'top' }, { bowtie: 0, puzzlekey: 0 }],
];
function jointsThatFit(cfg, layout) {
  const keyed = ['bowtie', 'puzzlekey', 'snap'].includes(cfg.connector);
  return KEY_ALTERNATIVES.filter(([id, over, from]) => {
    if (typeof from !== 'number') {
      if (!keyed) return false;          // a key in the wall is the key in use, moved
      from = from[cfg.connector];
      if (from === undefined) return false;
    }
    return cfg.pitch >= from && keysMeet(Object.assign({}, cfg, over), layout).length === 0;
  }).map(([id, over]) => ({ id, over }));
}

/* Region-decomposed build: no global CSG. Each piece = margin/corner regions (plain
   extrusions) + one region per cell (extrusion minus its socket cutter and holes).
   Regions are clipped from the global outline (rounded corners, connector bites)
   and bloated 0.05mm so shells overlap; slicers union overlapping shells. */
function buildPiece(cfg, layout, piece, onStatus) {
  const pitch = cfg.pitch, half = pitch/2;
  const solidBase = cfg.baseMode !== 'bosses';
  const pad = platePad(cfg);
  const isHclip = cfg.connector === 'hclip';
  const topInsert = cfg.keyInsert === 'top';
  // the key housings, as keysMeet works them out too: see keyPlan
  const plan = keyPlan(cfg);
  const keyDims = plan.dims;
  const keyShape = plan.shape, keyPrm = plan.prm, keyKind = plan.kind, keyClr = plan.clr;
  const H = pad + cfg.plateHeight;
  const tol = cfg.tolerance === 'tight' ? +0.1 : cfg.tolerance === 'loose' ? -0.1 : 0;
  const dTop = cfg.topCutoff, dMid = 2.15 + tol, dBot = 2.85 + tol;
  const prof = {
    pitchHalf: half, rTop: cfg.socketRadius,
    zs: [pad > 0 ? pad : -1, pad, pad + 0.7, pad + 2.5, H, H + 1.5],
    ds: [dBot, dBot, dMid, dMid, dTop, dTop],
  };

  const W = piece.mL + piece.nx*pitch + piece.mR;
  const D = piece.mF + piece.ny*pitch + piece.mB;
  const gx0 = piece.mL, gy0 = piece.mF;

  // one cutter for every mounting site on the piece, built once and moved into place
  const cellFastener = ((cfg.magnets || cfg.screws) && solidBase)
    ? fastenerCutter(cfg, pad - cfg.magnetH, pad + 0.02, H + 0.5) : null;
  // the same cutter turned a 28th of a turn, half a facet of its 14-sided bores, for a
  // cell whose pockets come out open the first time (see the fastener cut below); built
  // the first time one does
  let turned = null;
  const turnedFastener = () => turned || (turned = cellFastener.map((p) => {
    const ca = Math.cos(Math.PI/14), sa = Math.sin(Math.PI/14);
    const turn = (v) => [v[0]*ca - v[1]*sa, v[0]*sa + v[1]*ca, v[2]];
    return { verts: p.verts.map(turn), plane: { n: turn(p.plane.n), w: p.plane.w } };
  }));
  // the corners of its walls where they stand on the bottom face, and on the socket floor
  // (a magnet pocket from above, a screw's shank), about its axis (fanCentre)
  const wallsAt = (z) => {
    const out = [], seen = new Set();
    for (const p of cellFastener || []) {
      const zs = p.verts.map((v) => v[2]);
      if (!(Math.min(...zs) < z && Math.max(...zs) > z)) continue;
      for (const v of p.verts) {
        const k = `${v[0].toFixed(6)} ${v[1].toFixed(6)}`;
        if (!seen.has(k)) { seen.add(k); out.push([v[0], v[1]]); }
      }
    }
    return out;
  };
  /* The same, its corners only. Where the walls of two bores were unioned (a counterbore,
     its screw's shank), the BSP split each wall along the other's planes, and wallsAt
     hands back those split points as well: two on every flat of the shank, 24 points on
     the socket floor that are no corner of anything. A 2.4 mm shank under a 4.8 mm head
     at 44.08 mm, with loose tolerance, had a spoke within FAN_CLEAR of one of them from
     every point fanCentre tries, so the socket floor's fan never moved and the cell
     shipped with six open edges. A corner is where two walls that are not in line meet;
     a split point is where one wall was cut in two. From the corners alone the fan moves
     0.2 mm and the floor closes. Only the socket floor's list, which only an open cell's
     refan reads (buildPiece), so every cell that came out closed is built as before. */
  const cornersAt = (z) => {
    const ends = new Map();   // a wall end, to the directions of the walls that end there
    for (const p of cellFastener || []) {
      const zs = p.verts.map((v) => v[2]);
      if (!(Math.min(...zs) < z && Math.max(...zs) > z) || Math.abs(p.plane.n[2]) > 1e-9) continue;
      const d = [-p.plane.n[1], p.plane.n[0]];   // along the wall
      let lo = null, hi = null;
      for (const v of p.verts) {
        const t = v[0]*d[0] + v[1]*d[1];
        if (!lo || t < lo[0]) lo = [t, v];
        if (!hi || t > hi[0]) hi = [t, v];
      }
      for (const [, v] of [lo, hi]) {
        const k = `${v[0].toFixed(6)} ${v[1].toFixed(6)}`;
        if (!ends.has(k)) ends.set(k, { at: [v[0], v[1]], dirs: [] });
        ends.get(k).dirs.push(d);
      }
    }
    return [...ends.values()].filter(({ dirs }) =>
      dirs.some((a) => dirs.some((b) => Math.abs(a[0]*b[1] - a[1]*b[0]) > 1e-6))).map((e) => e.at);
  };
  const fastenerFoot = wallsAt(0), fastenerTop = pad > 0.01 ? cornersAt(pad) : [];

  // ---- connectors ----
  const conn = pieceConnectors(cfg, layout, piece);
  const tabs = conn.tabs, notches = conn.notches;
  const ptabs = conn.ptabs, pnotches = conn.pnotches, keyed = conn.keyed;
  const t = cfg.tab;
  // ---- global outline: rect + rounded outer corners + notch bites ----
  const rr = cfg.cornerRadii || {};
  /* Capped where the arc would run into the corner socket rather than at half a cell,
     which is where it used to be capped and is a number with nothing behind it.
   *
     Both shapes are rounded squares about the same corner, so this is one dimension: the
     socket's corner arc comes to (dTop + rTop)·√2 − rTop of the cell corner along the
     diagonal, and the plate's comes to rc(√2 − 1). Leave WALL between them and solve for
     rc. On the stock profile that is 4.88 mm, and it is not theoretical — measured across
     radii 0 to 6 with magnets, with screws and with both, everything up to 5 is watertight
     and 6 opens 1168 edges on a screwed plate, which is the arc eating the rim it needed
     to cut through. A drawer with a corner rounder than this wants a margin, not a rounder
     plate: past the cap the corner cell has no rim left to hold a bin down. */
  const WALL = 0.2;
  const rMax = Math.max(0, ((cfg.topCutoff + cfg.socketRadius) * Math.SQRT2
                            - cfg.socketRadius - WALL) / (Math.SQRT2 - 1));
  /* A corner holding a half cell (see halfStrips) is capped by that cell's socket. Its
     short side is a quarter pitch, and roundedRectRing holds the top ring's corner to
     that side less the cutoff: below a pitch of about 17.6 mm the ring's corner shrinks,
     the socket's corner comes out towards the plate's, and the whole cell's cap let the
     arc fold through the rim (pitch 14, radius 4.5: six coplanar folds at the three
     corners with half cells). The same sum with the ring's own radius; at 42 mm it is
     the whole cell's number. */
  const rcHalf = Math.min(cfg.socketRadius, pitch / 4 - cfg.topCutoff - 0.01);
  const rMaxHalf = Math.max(0, Math.min(rMax, ((cfg.topCutoff + rcHalf) * Math.SQRT2
                                               - rcHalf - WALL) / (Math.SQRT2 - 1)));
  const halfAt = { ll: false, lr: !!piece.hR, ur: !!(piece.hR || piece.hB), ul: !!piece.hB };
  const rOf = (k) => Math.max(0, Math.min(rr[k] !== undefined ? rr[k] : cfg.outerRadius,
                                          halfAt[k] ? rMaxHalf : rMax, half));
  const NARC = 10;
  /* A corner of the WHOLE plate, not of the piece: only the piece that owns it gets the
     arc, and the other three of its corners stay square so it still butts up against its
     neighbours.
   *
   * This asked `piece.col`, `piece.row`, `layout.cols` and `layout.rows`, none of which
   * computeLayout has ever produced — it lays pieces out as `band`/`seg` over a grid of
   * `nx` by `ny` cells. Four `undefined === 0` comparisons meant every flag was false and
   * cfg.outerRadius and cfg.cornerRadii, both of which the page offers as controls, did
   * nothing whatever to a downloaded plate. buildTestTile was the only caller that ever
   * set col and row, so the tile was the only thing in the project with rounded corners.
   *
   * Asking the cell extents rather than the band and seg indices is deliberate: with a
   * staggered split the bands do not share their column cuts, so seg 0 of band 2 is at
   * the left edge but the LAST seg of that band need not be at the right one. Where a
   * piece sits in the cell grid always answers this; where it sits in the list does not. */
  const atL = piece.cellX0 === 0, atR = piece.cellX0 + piece.nx === layout.nx;
  const atF = piece.cellY0 === 0, atB = piece.cellY0 + piece.ny === layout.ny;
  const round = { ll: atL && atF, lr: atR && atF, ur: atR && atB, ul: atL && atB };
  function corner(cx, cy, a0, doRound, key) {
    const rc = rOf(key);
    if (!doRound || rc <= 0.01) return [[cx, cy]];
    const ccx = cx + (cx < 1 ? rc : -rc), ccy = cy + (cy < 1 ? rc : -rc);
    const out = [];
    for (let k = 0; k <= NARC; k++) {
      const a = (a0 + 90*k/NARC) * Math.PI/180;
      out.push([ccx + rc*Math.cos(a), ccy + rc*Math.sin(a)]);
    }
    return out;
  }
  const nWr = t.wr + 2*t.clr, nWt = t.wt + 2*t.clr, nDp = t.dp + t.clr;
  const outline = [];
  outline.push(...corner(0, 0, 180, round.ll, 'll'));
  outline.push(...corner(W, 0, 270, round.lr, 'lr'));
  outline.push(...corner(W, D, 0, round.ur, 'ur'));
  outline.push(...corner(0, D, 90, round.ul, 'ul'));
  if (onStatus) onStatus('outline');

  // ---- region grid: x cuts and y cuts ----
  /* A strip of half cells (piece.hR, piece.hB; see halfStrips) is one more cut, half a
     pitch past the last whole cell, and the region it closes off is a cell rather than
     margin. The margin after it is what mR or mB holds beyond the strip, and gets a
     region of its own only when there is room for one, as a plate's margin does (below). */
  const hxR = piece.hR ? 1 : 0, hyB = piece.hB ? 1 : 0;
  const BLOAT = 0.05;
  /* Where a margin's region meets the cells beside it. Both are built BLOAT past the cut
   * so the two shells overlap, and that is only an overlap while the band it makes holds
   * no vertex of the outline: a vertex inside it is inside both regions, both shells put
   * an edge of the plate's side wall up through it, and that edge is used four times — two
   * closed shells touching where they were meant to overlap.
   *
   * The cut was made wherever the margin ended, and only a margin under 0.01 mm joined
   * its cells. Under a BLOAT that puts the plate's own corner in the band, and with it the
   * side wall either side of it, 68 edges on one cell; and beside a rounded corner the
   * arc's vertices are spread over the first millimetre of each edge, so a 0.15, 0.4 or
   * 0.75 mm margin beside a 4 mm corner put one of them there, an edge a side. So the cut
   * moves out towards the plate's edge until it is two BLOATs clear of every vertex, the
   * plate edge counted as one — the margin's region takes less and the cell's rim that
   * much more, which is plastic either way — and a margin with no such room left joins
   * its cells and has no region at all. Two BLOATs rather than one so that where a cut
   * crosses the arc, each region's clip lands a BLOAT clear of the arc's vertices too
   * rather than a hair from one. It is also what a margin past a strip of half cells was
   * already held to, and that margin is cut the same way now. Cuts between cells never
   * come near the outline's vertices: the arc is never wider than half a cell.
   *
   * Two BLOATs clear is not two BLOATs moved. Beside a square corner the only vertex is
   * the corner itself, on the plate's edge, so no cut moves and a margin up to 0.1 mm
   * joins. Beside a rounded one the cut steps past each arc vertex within two BLOATs, the
   * next can be within two BLOATs of where it lands, and it goes on until there is a gap
   * (and past the crossings below). Where the margin is the same all round, beside every
   * corner from 0 to 6 mm by 0.01, a cut that stays moves 0.19 mm at most. With the four
   * margins anything from 0 to 3 mm, it moves further: 0.98 mm with 0.85, 1.81, 0.57 and
   * 0.77 by a 3.16 mm corner, and up to 1.07 over three million drawn at random. Under a
   * 1.22 mm corner the arc's vertices are that close all the way along, so the cut runs
   * off the plate and every margin up to about the radius plus 0.09 joins its cells,
   * 1.3 mm by a 1.21 mm corner; beside larger corners up to 1.13 mm joined, and 1.02 mm
   * by a corner of 4 mm or more. The plate is the same plate whichever region builds it
   * (and see wasL below for a skeleton cell).
   *
   * A vertex less than a hundredth inside two BLOATs is left where it is rather than
   * stepped past. Clearing it would move the cut a hair, and a skeleton cell beside a
   * moved cut keeps the strip it gained solid out to where the margin was cut before
   * (wasL below): that strip's side and the margin region's would be a hair apart, two
   * shells' faces closer than the mesh's own tolerance tells apart — 0.0005 mm on a
   * skeleton plate with 0.42 mm margins by a 6 mm corner, four edges each used four
   * times. So a cut that moves, moves at least a hundredth, and the vertex it leaves is
   * still four hundredths outside the band. The plate's edge is held to the full two. */
  const CLEAR = 2 * BLOAT, HAIR = 0.01;
  const clearCut = (c, edge, vs) => {
    const toward = edge < c ? -1 : 1;
    for (;;) {
      if (Math.abs(edge - c) <= CLEAR + 1e-9) return null;
      const hit = vs.filter((v) => Math.abs(v - c) < CLEAR - HAIR);
      if (!hit.length) return c;
      c = toward < 0 ? Math.min(...hit) - CLEAR - 1e-6 : Math.max(...hit) + CLEAR + 1e-6;
      if (toward < 0 ? c <= edge : c >= edge) return null;
    }
  };
  // the last cell's far side, a strip of half cells' when there is one
  const lastX = gx0 + piece.nx*pitch + (hxR ? half : 0);
  const lastY = gy0 + piece.ny*pitch + (hyB ? half : 0);
  const outX = outline.map((p) => p[0]), outY = outline.map((p) => p[1]);
  let cutL = clearCut(piece.mL, 0, outX), cutF = clearCut(piece.mF, 0, outY);
  let cutR = clearCut(lastX, W, outX), cutB = clearCut(lastY, D, outY);
  /* A region's corners are points of the outline too. Where the arc crosses a clip line of
     the other axis — a BLOAT either side of a cut — every region along that line has the
     same crossing point, so it is held clear of the band like a vertex. The two axes
     depend on each other, so this goes round until neither moves; a cut only ever moves
     out, so it settles. 0.75 mm margins by a 4.88 mm corner put a crossing in both. */
  const crossings = (k, at) => {
    const out = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      if ((a[k] - at) * (b[k] - at) < 0)
        out.push(a[1-k] + (at - a[k]) / (b[k] - a[k]) * (b[1-k] - a[1-k]));
    }
    return out;
  };
  const clipLines = (...cs) => cs.filter((c) => c !== null).flatMap((c) => [c - BLOAT, c + BLOAT]);
  for (let pass = 0; pass < 20; pass++) {
    const xv = outX.concat(...clipLines(cutF, cutB).map((y) => crossings(1, y)));
    const yv = outY.concat(...clipLines(cutL, cutR).map((x) => crossings(0, x)));
    const next = [cutL === null ? null : clearCut(cutL, 0, xv), cutF === null ? null : clearCut(cutF, 0, yv),
                  cutR === null ? null : clearCut(cutR, W, xv), cutB === null ? null : clearCut(cutB, D, yv)];
    if (next[0] === cutL && next[1] === cutF && next[2] === cutR && next[3] === cutB) break;
    [cutL, cutF, cutR, cutB] = next;
  }
  const xs = [0]; if (cutL !== null) xs.push(cutL);
  for (let i = 1; i <= piece.nx; i++) xs.push(gx0 + i*pitch);
  if (hxR) xs.push(gx0 + piece.nx*pitch + half);
  if (cutR !== null) { xs[xs.length-1] = cutR; xs.push(W); } else xs[xs.length-1] = W;
  const ys = [0]; if (cutF !== null) ys.push(cutF);
  for (let j = 1; j <= piece.ny; j++) ys.push(gy0 + j*pitch);
  if (hyB) ys.push(gy0 + piece.ny*pitch + half);
  if (cutB !== null) { ys[ys.length-1] = cutB; ys.push(D); } else ys[ys.length-1] = D;
  const cellXi = cutL !== null ? 1 : 0;           // index offset of first cell column
  const cellYi = cutF !== null ? 1 : 0;
  /* Where each margin was cut before its cut could move, or null where it joined its
     cells then too: under 0.01 mm, or 0.1 past a strip of half cells. A skeleton cell is
     hollow below z 2.5 out to the edge of its region, so the region growing over a margin
     would hollow the margin with it, and the plate's footprint on the bed changed — a
     1 mm margin by a 1 mm corner lost its whole solid border. So a cell beside a moved cut
     is still judged whole or not on the region it had, and hollowed only that far:
     skeletonCellRegion builds the rest of it solid to the bed, as the margin was. */
  const wasL = piece.mL > 0.01 ? piece.mL : null, wasF = piece.mF > 0.01 ? piece.mF : null;
  const wasR = (hxR ? piece.mR - half > 0.1 : piece.mR > 0.01) ? lastX : null;
  const wasB = (hyB ? piece.mB - half > 0.1 : piece.mB > 0.01) ? lastY : null;

  /* Shells, kept apart rather than poured into one soup, because the top-insert pass
     below has to subtract from each one on its own — a subtraction is only defined
     against a single closed solid, and this piece is a dozen of them deliberately
     overlapping. They are concatenated at the end and nothing downstream can tell. */
  const shells = [];
  /* A joint's cut taken again when it comes out open, or with a face the weld turned over.
   *
   * The same lottery as the mounting pockets' (the fastener cut below), and at small
   * pitches it comes up for the joints. A cutter's side or floor, carried across the
   * cell as a plane by the BSP, crosses one of the socket's faces a couple of thousandths
   * from where another plane crosses it, and healCsgSeams welds the two and loses the
   * sliver between them (three open edges), or keeps it turned over (a fold). The
   * socket's straight walls run only 2.5 mm either side of a cell's middle at 13.5 mm
   * and its corner arcs and cones take the rest, so every housing's cut crosses them
   * there, at a few points that move with the pitch: from 13.5 to 16 mm every 0.01, 45
   * of 14,194 plates the page takes had 3 to 8 open edges somewhere (the floor key at
   * 14.9 mm on 1-cell pieces, puzzle tabs at 14.95 in rows, a key in the wall at 13.8,
   * the cup at 14 and 15.86 to 15.92, the snap clip at 14.84), and 115 had a fold, with
   * nothing on the page to say so. It is not the pitch: 0.01 either side builds clean,
   * and the H-clip put in from above does the same at 42 mm, between fields of 0.74 and
   * 0.745, and at every pitch from 13.5 to 16 at 0.74.
   *
   * So the cut is taken again as the pockets' is, as other trees over the same solids:
   * the cutters in the other order, the solid's faces in the other order, the faces
   * started a third and two thirds of the way round (which puts another of its planes at
   * the root), the cutters moved 1.7 microns, the jitter the notch cutters already
   * carry, two ways, and last each cutter on its own, one after another, since two in
   * one cut split each other's faces and lose a sliver the same way. The first result
   * that is closed and has nothing turned over is kept; a cut that comes out right first
   * time, which is nearly every one, is built exactly as before. A try that throws is
   * passed over. */
  const NUDGE = 0.0017;
  // the cutters in a cut, each solid on its own (polygons that share a corner go together)
  const apart = (cut) => {
    const up = cut.map((_, i) => i), at = new Map();
    const top = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
    cut.forEach((p, i) => {
      for (const v of p.verts) {
        const k = v[0] + ',' + v[1] + ',' + v[2];
        if (at.has(k)) up[top(i)] = top(at.get(k)); else at.set(k, i);
      }
    });
    const groups = new Map();
    cut.forEach((p, i) => {
      const r = top(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(p);
    });
    return [...groups.values()];
  };
  const oneByOne = (solid, cut, back) => {
    const parts = apart(cut);
    if (parts.length < 2) return null;
    if (back) parts.reverse();
    let r = solid;
    for (const p of parts) {
      r = cutAgain(r, p, csgSubtract(r, p));   // one cutter: cutAgain does not come back here
      if (r.open || r.turned) return null;
    }
    return r;
  };
  const cutAgain = (solid, cut, first) => {
    if (!first.open && !first.turned) return first;
    const from = (k) => solid.slice(k).concat(solid.slice(0, k));
    const tries = [() => csgSubtract(solid, cut.slice().reverse()),
                   () => csgSubtract(solid.slice().reverse(), cut),
                   () => csgSubtract(from(solid.length / 3 | 0), cut),
                   () => csgSubtract(from(2 * solid.length / 3 | 0), cut),
                   () => csgSubtract(solid, movePolys(cut, NUDGE, NUDGE)),
                   () => csgSubtract(solid, movePolys(cut, -NUDGE, NUDGE)),
                   () => oneByOne(solid, cut)];
    for (const t of tries) {
      let again;
      try { again = t(); } catch (e) { continue; }
      if (again && !again.open && !again.turned) return again;
    }
    return first;
  };
  /* Two cells' regions overlap by a BLOAT, and a joint's cutter on the line between them (a
   * key on a cell junction, say) is cut out of both. A batch's BSP splits each cutter's
   * faces along the other cutters' planes, the same way in both cells, so where a split
   * lands inside the band the two regions share, both shells carry the same edge and it is
   * used four times: shells touching, bad edges to checkManifold and to a slicer. A key
   * from each seam of a piece one cell deep does it, its pole's face split where the other
   * key's planes cross it; so do two keys a pitch apart whose planes meet over the junction
   * between them. It is where a split lands, so it comes and goes with the pitch: from 13.5
   * to 16 mm every 0.01, 229 of 14,194 plates the page takes had such an edge.
   *
   * So a jointed cell whose shell shares an edge with a jointed cell built before it has
   * its joint cut again: each cutter on its own, one after the other, which leaves no
   * cutter split by another; then the cutters in the other order; the cell's faces in the
   * other order; and the cutters one at a time from the last. The first that is closed,
   * has nothing turned over and shares no edge is kept; otherwise the first cut stands.
   * The same goes for the top-insert pass below. Edges are compared as checkManifold
   * counts them, the triangles polysToTriangles makes with corners to a thousandth, and
   * only inside the band, so a cell with nothing there costs a pass over its polygons.
   *
   * A corner is one number, its thousandths packed: x and y from the band's corner, z
   * offset by 2^21 (2 m either way, past any plate). Text for each corner cost a jointed
   * 42 mm plate a millisecond or more. A band too big for x and y to pack exactly in what
   * a double holds, over about 46 mm square, which no band between two cells comes near,
   * keys its corners as text instead; either way two corners are the same key exactly
   * when their thousandths are. `each` is handed every edge in the band, lower key first,
   * and stops the pass by returning true. `edges`, when there are some, are the shell's
   * edges to look through instead of all of them (sideEdges, below). */
  const jointCells = [];
  const bandEdges = (polys, b, each, edges) => {
    const X0 = Math.round(b[0] * 1000), Y0 = Math.round(b[1] * 1000), NY = Math.round(b[3] * 1000) - Y0 + 1;
    const k = (Math.round(b[2] * 1000) - X0 + 1) * NY < 2 ** 31
      ? (v) => ((Math.round(v[0] * 1000) - X0) * NY + Math.round(v[1] * 1000) - Y0) * 2 ** 22 +
               Math.round(v[2] * 1000) + 2 ** 21
      : (v) => Math.round(v[0] * 1000) + ',' + Math.round(v[1] * 1000) + ',' + Math.round(v[2] * 1000);
    const inBand = (v) => v[0] >= b[0] && v[0] <= b[2] && v[1] >= b[1] && v[1] <= b[3];
    if (edges) {
      for (let i = 0; i < edges.length; i += 2) {
        const a = edges[i], c = edges[i + 1];
        if (!inBand(a) || !inBand(c)) continue;
        const ka = k(a), kc = k(c);
        if (ka < kc ? each(ka, kc) : each(kc, ka)) return;
      }
      return;
    }
    for (const p of polys) {
      const vs = p.verts;
      for (let i = 2; i < vs.length; i++) {
        const t = [vs[0], vs[i - 1], vs[i]];
        for (let e = 0; e < 3; e++) {
          const a = t[e], c = t[(e + 1) % 3];
          if (!inBand(a) || !inBand(c)) continue;
          const ka = k(a), kc = k(c);
          if (ka < kc ? each(ka, kc) : each(kc, ka)) return;
        }
      }
    }
  };
  // does this shell share an edge with built shell c, inside the band where the two overlap?
  const touchesBuilt = (polys, own, c) => {
    const b = [Math.max(own[0], c.box[0]) - 1e-3, Math.max(own[1], c.box[1]) - 1e-3,
               Math.min(own[2], c.box[2]) + 1e-3, Math.min(own[3], c.box[3]) + 1e-3];
    const theirs = new Map();   // lower corner -> the higher corners it has an edge to
    const them = c.polys || shells[c.i];
    bandEdges(them, b, (lo, hi) => {
      const l = theirs.get(lo);
      if (l) l.push(hi); else theirs.set(lo, [hi]);
    });
    if (!theirs.size) return false;
    let shared = false;
    bandEdges(polys, b, (lo, hi) => {
      const l = theirs.get(lo);
      return (shared = !!l && l.includes(hi));
    });
    return shared;
  };
  const TOUCH_TRIES = [(solid, cut) => oneByOne(solid, cut),
                       (solid, cut) => csgSubtract(solid, cut.slice().reverse()),
                       (solid, cut) => csgSubtract(solid.slice().reverse(), cut),
                       (solid, cut) => oneByOne(solid, cut, true)];
  // a cut that ends more open, or with more turned over, than the one it would replace
  const worse = (a, b) => (a.open || 0) > (b.open || 0) || (a.turned || 0) > (b.turned || 0);
  // whether a shell has an open edge lying flat at height z: one used an odd number of times,
  // its ends both at z, to checkManifold's thousandths
  const openAt = (polys, z) => {
    const Z = Math.round(z * 1000), use = new Map();
    const k = (v) => Math.round(v[0] * 1000) + ',' + Math.round(v[1] * 1000);
    for (const p of polys) {
      const vs = p.verts;
      for (let i = 0; i < vs.length; i++) {
        const a = vs[i], b = vs[(i + 1) % vs.length];
        if (Math.round(a[2] * 1000) !== Z || Math.round(b[2] * 1000) !== Z) continue;
        const ka = k(a), kb = k(b);
        if (ka === kb) continue;
        const e = ka < kb ? ka + ' ' + kb : kb + ' ' + ka;
        use.set(e, (use.get(e) || 0) + 1);
      }
    }
    for (const n of use.values()) if (n % 2) return true;
    return false;
  };
  /* The same touch, from the mounting pockets. A pocket's walls, carried across the cell as
   * planes by the BSP, split the region's sides where they cross them, and those sides
   * stand on the same planes as the neighbours' sides, a BLOAT either way of the line
   * between the cells. Where a split lands on a corner of a neighbour's region, to a
   * thousandth, the two shells share that corner's edge: used four times, all the way up.
   * A 21.7 mm magnet from beneath at a 55 mm pitch did it: a flat of the pocket in the
   * cell at the back left, on the magnet's radius, crosses that cell's front side 0.03
   * microns from the corner of the cell at the back right. A 22.2 mm screw shank at 56.5
   * mm did it twice over, from the cell at the back right as well, on main too. Each shell
   * is closed on its own, so the pockets' own retries never see it, and it comes and goes
   * with the size and the pitch.
   *
   * So with mounting pockets on the piece, every shell the cells and margins make is
   * checked against those built before it beside it, as jointed cells are above. One that
   * shares an edge has its pockets cut again with the cutters moved 1.7 microns along one
   * diagonal or the other, turned a 28th of a turn, or turned and moved (pocketTries, in
   * the cell), which takes every pocket plane off the corner, and the try that leaves the
   * fewest edges shared with all the shells beside it is kept. A corner of its own on
   * another's split does not move that way, so each shell it still shares an edge with
   * then has its pockets cut again instead, as they were first cut or any of those ways,
   * and the cut sharing the fewest with everything beside that shell, this one included,
   * is kept. Edges are counted, not shells: a 10.1 mm magnet from above at 47.91 mm kept
   * a turned cut in its second cell because it touched one shell where the first cut
   * touched two, and the fourth cell then shared an edge with it that nothing cleared,
   * since every nudged cut of the second cell touched the first cell again and was
   * refused for it. Three edges used four times, where main had none. Either way a try
   * that ends more open or with more turned over is passed over, and a shell that touches
   * nothing, which is nearly every one, is built as before.
   *
   * And once every cell is built, the shells settle cut again are checked as a whole, with
   * those beside them: if they have more bad edges (checkManifold) than they had before,
   * or more open or turned over (healCsgSeams), every one goes back to its first cut. So
   * settle never leaves those shells worse than it found them, whatever order the cells
   * come in. What is made after the check is not judged by it: the dovetail and puzzle
   * tabs, and what the top-insert pass cuts again (see the check below).
   * `alt` and `pocket` are the cuts a cell was last taken with, so a cell cut again for
   * one reason keeps what it was cut again for the other. */
  const POCKET_TRIES = 7;
  const mountCells = [];
  const builtBeside = (box) => mountCells.filter((c) => c.box[0] < box[2] && box[0] < c.box[2] &&
                                                        c.box[1] < box[3] && box[1] < c.box[3]);
  /* Every shell is checked against up to four beside it, and each of those against the
     next ones built: a pass over all of a shell's edges each time took 4 to 6 percent of
     a 42 mm plate's build with magnets. A band two shells share lies inside both, along
     one side, no deeper than the two BLOATs the regions overlap by. So each shell's edges
     by its sides, both ends that close to one of them, are picked out once and kept with
     the shell, and bandEdges takes the band's from those: 1 to 3 percent. */
  const bySides = new WeakMap();
  const sideEdges = (polys, box) => {
    let out = bySides.get(polys);
    if (out) return out;
    const w = 2 * BLOAT + 2e-3;
    const by = (v) => v[0] <= box[0] + w || v[0] >= box[2] - w || v[1] <= box[1] + w || v[1] >= box[3] - w;
    out = [];
    for (const p of polys) {
      const vs = p.verts;
      for (let i = 2; i < vs.length; i++) {
        const t = [vs[0], vs[i - 1], vs[i]];
        for (let e = 0; e < 3; e++) if (by(t[e]) && by(t[(e + 1) % 3])) out.push(t[e], t[(e + 1) % 3]);
      }
    }
    bySides.set(polys, out);
    return out;
  };
  // how many edges this shell shares with built shell c, in the band where the two overlap
  const sharedWith = (polys, own, c) => {
    const b = [Math.max(own[0], c.box[0]) - 1e-3, Math.max(own[1], c.box[1]) - 1e-3,
               Math.min(own[2], c.box[2]) + 1e-3, Math.min(own[3], c.box[3]) + 1e-3];
    const theirs = new Map();   // lower corner -> the higher corners it has an edge to
    const them = c.polys || shells[c.i];
    bandEdges(them, b, (lo, hi) => {
      const l = theirs.get(lo);
      if (l) l.push(hi); else theirs.set(lo, [hi]);
    }, sideEdges(them, c.box));
    if (!theirs.size) return 0;
    const both = new Set();
    bandEdges(polys, b, (lo, hi) => {
      const l = theirs.get(lo);
      if (l && l.includes(hi)) both.add(lo + ' ' + hi);
    }, sideEdges(polys, own));
    return both.size;
  };
  const sharedAll = (polys, own, near) => near.reduce((n, c) => n + sharedWith(polys, own, c), 0);
  const before = new Map();   // shell index -> that shell as it was before settle first cut it again
  const settle = (cell, polys) => {
    const beside = builtBeside(cell.box);
    const first = polys;
    // the edges shared with each shell beside it, and in all
    const shares = (p) => beside.map((c) => sharedWith(p, cell.box, c));
    let each = shares(polys), now = each.reduce((n, x) => n + x, 0);
    for (let k = 0; now && cell.recut && k < POCKET_TRIES; k++) {
      let again;
      try { again = cell.recut(cell.alt, k); } catch (e) { continue; }
      if (!again || worse(again, polys)) continue;
      const e = shares(again), n = e.reduce((s, x) => s + x, 0);
      if (n < now) { polys = again; cell.pocket = k; now = n; each = e; }
    }
    if (polys !== first) before.set(cell.i, first);
    const mine = { box: cell.box, polys };
    for (const [j, c] of beside.entries()) {
      if (!c.recut || !each[j]) continue;   // a margin or half cell has no pockets
      const near = builtBeside(c.box).filter((d) => d !== c).concat([mine]);
      let best = shells[c.i], most = sharedAll(best, c.box, near), pick = c.pocket;
      for (let k = -1; most && k < POCKET_TRIES; k++) {
        const pocket = k < 0 ? undefined : k;   // undefined: the pockets as first cut
        if (pocket === c.pocket) continue;
        let again;
        try { again = c.recut(c.alt, pocket); } catch (e) { continue; }
        if (!again || worse(again, shells[c.i])) continue;
        const n = sharedAll(again, c.box, near);
        if (n < most) { best = again; most = n; pick = pocket; }
      }
      if (best !== shells[c.i]) {
        if (!before.has(c.i)) before.set(c.i, shells[c.i]);
        shells[c.i] = best; c.pocket = pick;
      }
    }
    mountCells.push(cell);
    return polys;
  };
  let done = 0;
  for (let ix = 0; ix < xs.length-1; ix++) {
    for (let iy = 0; iy < ys.length-1; iy++) {
      let x0 = Math.max(0, xs[ix] - BLOAT), x1 = Math.min(W, xs[ix+1] + BLOAT);
      let y0 = Math.max(0, ys[iy] - BLOAT), y1 = Math.min(D, ys[iy+1] + BLOAT);
      /* A puzzle notch's lobe points straight in from a cell junction, so its far pole is
         a vertex on the line between two cells, inside the band where their regions
         overlap. Both regions cut the notch, so both carried the pole and the edge up
         through it: one edge used four times per notch, or two edges twice each wherever
         the two cuts happened to split it at different heights, which is the same defect
         reading clean. Any change to either region's outline could turn one into the
         other. So the region past the pole starts half a BLOAT beyond it rather than a
         BLOAT short, and the pole is in one region only. The overlap is still there, from
         the region's new edge to its neighbour's, and the notch is the same notch. */
      for (const pn of pnotches) {
        const reach = cfg.puzzle.neckL + cfg.puzzle.lobeR * 1.6 + 1;
        if (pn.edge === '-y' || pn.edge === '+y') {
          if (ix > 0 && Math.abs(pn.s - xs[ix]) < 1e-6 &&
              (pn.edge === '-y' ? y0 < reach : y1 > D - reach)) x0 = xs[ix] + BLOAT/2;
        } else if (iy > 0 && Math.abs(pn.s - ys[iy]) < 1e-6 &&
                   (pn.edge === '-x' ? x0 < reach : x1 > W - reach)) y0 = ys[iy] + BLOAT/2;
      }
      const clipped = clipToRect(outline, x0, y0, x1, y1);
      if (!clipped) continue;
      const ci = ix - cellXi, cj = iy - cellYi;
      const isCell = ci >= 0 && ci < piece.nx + hxR && cj >= 0 && cj < piece.ny + hyB;
      if (!isCell) {                                 // margin / corner: plain extrusion
        const slab = extrudePoly(clipped, 0, H);
        shells.push(cellFastener ? settle({ box: [x0, y0, x1, y1], i: shells.length }, slab) : slab);
        continue;
      }
      // in the half column, the half row, or both (the quarter cell at the back right)
      const halfX = ci === piece.nx, halfY = cj === piece.ny;
      const cx = gx0 + ci*pitch + (halfX ? half/2 : half);
      const cy = gy0 + cj*pitch + (halfY ? half/2 : half);
      /* Skeleton only where there is nothing that needs the material back.
       *
       * The shell removes the bulk below z 2.5 — which is exactly the wall band every
       * connector cuts into. Dovetail notches (depth 2.1, ceiling 2.4), wall-housed
       * keys and H-clip pockets all live there, so a skeletonised cell carrying one
       * would have nothing to cut into. Connectors only ever sit on a piece boundary,
       * so boundary cells stay solid whenever a joint is in use.
       *
       * Magnets and screws are excluded outright: their holes and bosses need the
       * material a skeleton removes, and a floor pad means they are housed in a floor
       * that skeleton mode does not build.
       */
      // cells are built bloated by BLOAT per side, so a whole one measures (pitch+0.1)^2;
      // anything the piece boundary has cut into measures less than pitch^2 — and so does
      // a half cell, which stays solid: skeletonCellRegion's rings are square
      const movedL = ci === 0 && wasL !== null && cutL !== wasL;
      const movedF = cj === 0 && wasF !== null && cutF !== wasF;
      const movedR = ci === piece.nx + hxR - 1 && wasR !== null && cutR !== wasR;
      const movedB = cj === piece.ny + hyB - 1 && wasB !== null && cutB !== wasB;
      const moved = movedL || movedF || movedR || movedB;
      const asWas = !moved ? clipped : clipToRect(outline,
        movedL ? Math.max(0, wasL - BLOAT) : x0, movedF ? Math.max(0, wasF - BLOAT) : y0,
        movedR ? Math.min(W, wasR + BLOAT) : x1, movedB ? Math.min(D, wasB + BLOAT) : y1);
      const fullCell = !!asWas && Math.abs(polyArea2D(asWas)) >= pitch * pitch - 0.5;
      const onEdge = ci === 0 || cj === 0 || ci === piece.nx - 1 || cj === piece.ny - 1;
      const jointed = cfg.connector && cfg.connector !== 'none';
      const skel = cfg.plateStyle === 'skeleton' && pad <= 0.01 && fullCell
                   && !cfg.magnets && !cfg.screws && !(jointed && onEdge);
      // hollow only where the margin's solid ended: a BLOAT past where it was cut
      const open = moved ? [movedL ? wasL + BLOAT : -Infinity, movedF ? wasF + BLOAT : -Infinity,
                            movedR ? wasR - BLOAT : Infinity, movedB ? wasB - BLOAT : Infinity]
                         : undefined;
      /* Small convex cutters local to this cell, batched by feature and subtracted one
       * batch at a time.
       *
       * All of them used to go into a single soup and a single subtraction. That is only
       * sound while no two shells in the soup overlap, and the mounting cutters always
       * overlap — see fastenerCutter, which is why they arrive here already unioned into
       * one solid per site. Everything else is safe to batch because instances of one
       * feature sit at distinct sites: notches are a pitch apart, mounting sites 26 mm.
       *
       * A subtraction per shell would be correct too, but it is both slower and worse:
       * each pass re-splits everything the previous pass cut, and neighbouring cylinders
       * share facet normals, so a later cutter's plane runs tangentially along an earlier
       * cutter's wall and shaves slivers off it. */
      const cuts = { notch: [], key: [], puzzle: [], fastener: [] };
      for (const nb of notches) {
        const near = (nb.edge === '+x' || nb.edge === '-x')
          ? (nb.s > y0 - nWt && nb.s < y1 + nWt &&
             (nb.edge === '+x' ? Math.abs(x1 - W) : Math.abs(x0)) < nDp + 0.2)
          : (nb.s > x0 - nWt && nb.s < x1 + nWt &&
             (nb.edge === '+y' ? Math.abs(y1 - D) : Math.abs(y0)) < nDp + 0.2);
        if (near) cuts.notch.push(...tabNotch(cfg, nb, pad));
      }
      for (const bo of keyed) {
        if (plan.junction && offJunction(bo, pitch, piece))
          continue;   // wall mode: keys need a wall junction, skip mid-cell seams
        const halfW = isHclip ? cfg.hclip.flangeW : keyDims.wEnd;
        const reach = isHclip ? hclipPrm(cfg.hclip).len/2 + 1 : keyDims.len/2 + 1;
        const near = (bo.edge === '+x' || bo.edge === '-x')
          ? (bo.s > y0 - halfW && bo.s < y1 + halfW &&
             (bo.edge === '+x' ? Math.abs(x1 - W) : Math.abs(x0)) < reach)
          : (bo.s > x0 - halfW && bo.s < x1 + halfW &&
             (bo.edge === '+y' ? Math.abs(y1 - D) : Math.abs(y0)) < reach);
        if (!near) continue;
        /* Anything not inserted from underneath is a post-pass (clip + cup). The test
           used to be `(isHclip || wallKeys) && topInsert`, which is not the same
           question the post-pass below asks — so a top-inserted snap housed in the
           FLOOR fell through here and had a bottom recess cut for it as well as the
           clip pocket built over it, for a key that configuration never ships. One
           predicate now, computed once, above. */
        if (keyKind !== 'recess') continue;
        cuts.key.push(...keySiteOps(keyKind, keyShape, keyPrm, keyClr,
                                    bo.edge, bo.e, bo.s, H).cut);
      }
      for (const pn of pnotches) {
        const reach = cfg.puzzle.neckL + cfg.puzzle.lobeR * 1.6 + 1;
        const near = (pn.edge === '+x' || pn.edge === '-x')
          ? (pn.s > y0 - cfg.puzzle.lobeR*2 && pn.s < y1 + cfg.puzzle.lobeR*2 &&
             (pn.edge === '+x' ? Math.abs(x1 - W) : Math.abs(x0)) < reach)
          : (pn.s > x0 - cfg.puzzle.lobeR*2 && pn.s < x1 + cfg.puzzle.lobeR*2 &&
             (pn.edge === '+y' ? Math.abs(y1 - D) : Math.abs(y0)) < reach);
        if (near) cuts.puzzle.push(...tabNotch(cfg, pn, pad));
      }
      /* None in a half cell. A half-size bin's quarter feet carry no holes (feetHolesOff
         in bins/bin.js), and where a half socket's would go is not settled: a whole
         cell's four sites are holeOffset (13 mm) from its centre each way, past the
         middle of a 21 mm cell, so they cannot simply be kept, and moving them is a
         choice for magnets in bins that do not have any. Checks on the page says so, so
         a plate with magnets does not look short of holes by mistake. The corner bosses
         below are laid out over the whole cells only, so half cells get none of those
         either. */
      const fasteners = (cutter) => {
        const out = [], off = cfg.holeOffset;
        for (const sx of [-1, 1]) for (const sy of [-1, 1])
          out.push(...movePolys(cutter, cx + sx*off, cy + sy*off));
        return out;
      };
      if (cellFastener && !halfX && !halfY) cuts.fastener = fasteners(cellFastener);
      // what the bottom cap's fan keeps its spokes clear of (fanCentre): the corners of
      // the mounting cutters' walls, and with more room, of the joint's
      const avoid = halfX || halfY ? [] : [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) =>
        fastenerFoot.map(([u, v]) => [cx + sx*cfg.holeOffset + u, cy + sy*cfg.holeOffset + v])));
      for (const p of [...cuts.notch, ...cuts.key, ...cuts.puzzle])
        p.verts.forEach((a, i) => {
          const b = p.verts[(i + 1) % p.verts.length];
          if ((a[2] < 0) === (b[2] < 0)) return;
          const t = a[2] / (a[2] - b[2]);
          avoid.push([a[0] + t*(b[0] - a[0]), a[1] + t*(b[1] - a[1]), FAN_JOINT]);
        });
      // and the socket floor's, of the mounting cutters' corners there
      const floorAvoid = halfX || halfY ? [] : [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) =>
        fastenerTop.map(([u, v]) => [cx + sx*cfg.holeOffset + u, cy + sy*cfg.holeOffset + v])));
      let region = skel
        ? skeletonCellRegion(clipped, prof, cx, cy, H, cfg.arcSegs || 6,
                             Math.max(0.4, cfg.skin || 0.8), open)
        : directCellRegion(clipped, prof, cx, cy, H, pad, cfg.arcSegs || 6,
                           halfX || halfY ? [halfX ? half/2 : half, halfY ? half/2 : half] : undefined,
                           avoid.length ? avoid : undefined);
      const fastenerCut = (region, cut) => {
        let next = csgSubtract(region, cut);
        /* The mounting pockets' last few open edges, cut again. Where two of the
           cutters' side planes, extended across the cell by the BSP, cross a bottom-cap
           spoke or the pocket's ceiling a couple of thousandths from where something
           else crosses it, the repair can lose the sliver between them: a few open
           edges by a pocket, on a few plates in a thousand (8 of 3,893 random
           mount designs before this, 30 on main), a lottery on the margins, the corner
           radius and the magnet size (fanCentre takes the commonest case, a spoke past
           a cutter's own corner, before it happens; none of the 3,893 is open now).
           healCsgSeams says when its result is still open, and then the same cut is
           taken again: the cutters in the other order, the cell's faces in the other
           order, the cutters turned a 28th of a turn about their axes, moved 1.7 microns
           one way along the diagonal and then the other (NUDGE, as cutAgain does for a
           joint), and last each site's cutter on its own. The reordered ones are the same
           solids handed to the BSP in another order, which builds other trees and so
           other splits; the turned one is the same pocket with the corners of its 14-sided
           bores where their flats were, the same circle inside each for the magnet or
           screw head to sit against; a nudge moves every plane off the crossing that lost
           the sliver. The first closed result is
           kept; a cell that comes out closed first time, which is nearly every one, is
           built exactly as before. A try that throws (healCsgSeams' T-junction pass limit,
           which the turned cutters reach on a few engine-only cells) is passed over and
           the first cut stands, open as it was rather than a failed build.

           Only a cell open by a sliver or a few is cut again, at most 24 edges: six at
           each of its four pockets. Cells cut again have been open by anything from 1 to
           24 edges, and cells open by 21 and by 24 have closed; none open by more than 24
           has. Over 2,163 random mount designs (page designs at 34 to 50 mm, engine-only
           ones at 20 to 34 mm with the sites moved in, and small ones), 99 cells were cut
           again, open by 1 to 23, and 51 of them closed; none of the 2,733 cells open by
           more than 24 closed on any try. The turned cutters close most (42); of those
           three they are the only one that closed cells nothing else did (26). The cell's
           faces and the cutters both reversed closed 25, but one of the first two had
           closed each of those already, so that try is not taken. The nudges and the one
           site at a time came after: of 687 random page designs with a solid floor, the
           three tries left 6 open and these leave 4, none worse; and from 50 to 60 mm,
           magnets and screws from 15 mm up, they closed six of the nine left open. */
        if (next.open && next.open <= 24) {
          const n4 = cut.length / 4;   // fasteners() lays the four sites' cutters one after another
          const tries = [() => csgSubtract(region, cut.slice().reverse()),
                         () => csgSubtract(region.slice().reverse(), cut),
                         () => csgSubtract(region, fasteners(turnedFastener())),
                         () => csgSubtract(region, movePolys(cut, NUDGE, NUDGE)),
                         () => csgSubtract(region, movePolys(cut, -NUDGE, -NUDGE)),
                         () => [0, 1, 2, 3].reduce((r, q) => csgSubtract(r, cut.slice(q * n4, (q + 1) * n4)), region)];
          for (const t of tries) {
            let again;
            try { again = t(); } catch (e) { continue; }   // the first cut stands
            if (!again.open) { next = again; break; }
          }
        }
        return next;
      };
      /* The cell's cuts in turn. `alt` takes the joint's another way, and a result that is
         open or has a face turned over fails the whole try (see touchesBuilt). The mounting
         pockets come last and are cut again when they come out open, as on the first cut,
         so a try can still end open there; one that ends more open or with more turned over
         than the cut it would replace is not taken (`worse`). `pocket` cuts the pockets
         one of the ways a shell that touches another's edge takes them (settle). */
      let base = region;
      const pocketTries = [(r, cut) => csgSubtract(r, movePolys(cut, NUDGE, NUDGE)),
                           (r, cut) => csgSubtract(r, movePolys(cut, -NUDGE, -NUDGE)),
                           (r) => csgSubtract(r, fasteners(turnedFastener())),
                           (r, cut) => csgSubtract(r, movePolys(cut, NUDGE, -NUDGE)),
                           (r, cut) => csgSubtract(r, movePolys(cut, -NUDGE, NUDGE)),
                           (r) => csgSubtract(r, movePolys(fasteners(turnedFastener()), NUDGE, NUDGE)),
                           (r) => csgSubtract(r, movePolys(fasteners(turnedFastener()), -NUDGE, -NUDGE))];
      const cutCell = (alt, pocket) => {
        let r = base;
        for (const [kind, cut] of Object.entries(cuts)) {
          if (!cut.length) continue;
          if (kind === 'fastener') r = pocket === undefined ? fastenerCut(r, cut) : pocketTries[pocket](r, cut);
          else if (!alt) r = cutAgain(r, cut, csgSubtract(r, cut));   // see cutAgain
          else if (!(r = alt(r, cut)) || r.open || r.turned) return null;
        }
        return r;
      };
      const own = [x0, y0, x1, y1];
      const cell = { box: own, i: shells.length, recut: cuts.fastener.length ? cutCell : null, alt: null };
      region = cutCell(null);
      /* Still open on the socket floor, with pockets standing on it: the floor fanned clear
         of their corners (fanCentre), and every cut taken again on it. Kept if it is less
         open and no more turned over, and then it is the cell every later cut starts from.
         Only here, not on every cell: a 6 mm magnet from above at 42 mm has a spoke 2.3
         microns from a corner in every cell and comes out closed, as most do. And only
         where the fan moves and the cell is open at the floor's height: a cell open
         somewhere else, as a pocket that meets a joint's housing is, would be cut again
         for the same result, and so would one whose fan stays where it was, either because
         its spokes are already clear or because fanCentre finds no point clear of every
         corner and keeps the centre. A bowtie plate at
         45.57 mm with screws, open in every piece on main as well, took twice as long
         with every open cell cut again. */
      if (region.open && floorAvoid.length && openAt(region, pad)) {
        const first = base;
        base = directCellRegion(clipped, prof, cx, cy, H, pad, cfg.arcSegs || 6,
                                undefined, avoid.length ? avoid : undefined, floorAvoid);
        let again = null;
        if (base.floorMoved)
          try { again = cutCell(null); } catch (e) { /* the first cut stands */ }
        if (again && again.open < region.open && !worse(again, region)) region = again;
        else base = first;
      }
      if (cuts.notch.length || cuts.key.length || cuts.puzzle.length) {
        const beside = jointCells.filter((c) => c.box[0] < x1 && x0 < c.box[2] &&
                                                c.box[1] < y1 && y0 < c.box[3]);
        let touching = beside.filter((c) => touchesBuilt(region, own, c));
        for (const alt of touching.length ? TOUCH_TRIES : []) {
          let again;
          try { again = cutCell(alt); } catch (e) { continue; }
          if (again && !worse(again, region) && !beside.some((c) => touchesBuilt(again, own, c))) {
            region = again; cell.alt = alt; touching = []; break;
          }
        }
        // or the cell it touches, cut again instead, if that touches nothing else
        const mine = { box: own, polys: region };
        for (const c of touching) {
          const others = jointCells.filter((d) => d !== c && d.box[0] < c.box[2] && c.box[0] < d.box[2] &&
                                                  d.box[1] < c.box[3] && c.box[1] < d.box[3]);
          for (const alt of TOUCH_TRIES) {
            let again;
            try { again = c.joint(alt, c.pocket); } catch (e) { continue; }
            if (again && !worse(again, shells[c.i]) && !touchesBuilt(again, c.box, mine) &&
                !others.some((d) => touchesBuilt(again, c.box, d))) { shells[c.i] = again; c.alt = alt; break; }
          }
        }
        cell.joint = cutCell;
        jointCells.push(cell);
      }
      if (cellFastener) region = settle(cell, region);
      shells.push(region);
      done++;
      if (onStatus && done % 8 === 0) onStatus(`cells ${done}`);
    }
  }
  /* settle's check (see above). An edge two unchanged shells share counts the same both
     ways, so the shells cut again and the ones beside them are all it needs to look at;
     it runs only where settle cut something, which few plates do: 3 of 6,406 mount
     designs from 50 to 60 mm. Shells made after it are not in it: the dovetail and
     puzzle tabs, and what the top-insert pass cuts again. None of the designs swept for
     this has gone wrong there. */
  if (before.size) {
    const at = new Map(mountCells.map((c) => [c.i, c]));
    const local = new Set(before.keys());
    for (const i of before.keys()) for (const c of builtBeside(at.get(i).box)) local.add(c.i);
    const now = (i) => shells[i], then = (i) => before.get(i) || shells[i];
    const bad = (pick) => checkManifold([].concat(...[...local].map(pick))).bad;
    const sum = (pick, f) => [...before.keys()].reduce((n, i) => n + (pick(i)[f] || 0), 0);
    if (bad(now) > bad(then) || sum(now, 'open') > sum(then, 'open') || sum(now, 'turned') > sum(then, 'turned'))
      for (const [i, s] of before) shells[i] = s;
  }

  // magnet 'top' pockets  // magnet 'top' pockets sit in the socket floor: they need pad and were cut
  // relative to pad above; screw counterbores cut from the bottom face.

  // ---- corner bosses (pocket-style mounting, saves filament) ----
  if ((cfg.magnets || cfg.screws) && !solidBase) {
    const off = cfg.holeOffset;
    const bossW = BOSS_W, rIn = BOSS_R;
    // never more than BOSS_H, so a pocket deeper than BOSS_H − MOUNT_SKIN would come out
    // through the top: mountLimits refuses one rather than this growing past it
    const bossH = Math.min(BOSS_H, Math.max(
      cfg.magnets ? cfg.magnetH + 0.8 : 0,
      cfg.screws ? cfg.screwHeadDepth + 1.0 : 0));
    const bossFastener = fastenerCutter(cfg, bossH - cfg.magnetH, bossH + 0.5, bossH + 0.5);
    // whole cells only: a half cell has no mounting sites (see the fastener cut above)
    for (let i = 0; i < piece.nx; i++) for (let j = 0; j < piece.ny; j++) {
      const ccx = gx0 + i*pitch + half, ccy = gy0 + j*pitch + half;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const cxr = ccx + sx*half, cyr = ccy + sy*half;    // cell corner
        // quarter boss with rounded inner corner, oriented into the cell
        const pts = [];
        pts.push([0, 0], [bossW, 0], [bossW, bossW - rIn]);
        for (let k = 1; k <= 6; k++) {
          const a = k * (Math.PI/2) / 6;
          pts.push([bossW - rIn + rIn*Math.cos(a), bossW - rIn + rIn*Math.sin(a)]);
        }
        pts.push([0, bossW]);
        const world = pts.map(([u, v]) => [cxr - sx*u, cyr - sy*v]);
        let boss = extrudePoly(world, 0, bossH);
        if (bossFastener)
          boss = csgSubtract(boss, movePolys(bossFastener, ccx + sx*off, ccy + sy*off));
        shells.push(boss);
      }
    }
  }

  // ---- puzzle male tabs (protrude at floor level) ----
  for (const pt of ptabs) {
    const fp = puzzleShape(pt.edge, pt.e, pt.s, cfg.puzzle, 0, false);
    shells.push(extrudePoly(fp, 0, Math.max(1.2, pad - 0.65)));
  }

  // ---- tabs (separate overlapping shells) ----
  for (const tb of tabs) {
    const fp = tabFootprint(tb.edge, tb.e, tb.s, t.wr, t.wt, t.dp, 0.8);
    shells.push(extrudePoly(fp, 0, t.h));
  }
  /* ---- top-insert keyed pockets ----
   *
   * The pocket is cut out of every shell that reaches it and the housing is then stood in
   * the cavity as further shells. It used to be a clip over the whole finished soup, and
   * the soup is the reason the clip looked like the only option: a subtraction needs one
   * closed solid on each side, and the piece at this point is a dozen overlapping ones.
   * Handing each shell its own subtraction is all it takes, and each one comes back closed.
   *
   * The cutters of all the sites a shell reaches go in as one batch. Sites sit on cell
   * junctions along a seam, so the closest two can be — one on each edge at a corner — is
   * a full pitch apart against a cutter that reaches about 14 mm, and no two overlap.
   * That is the same argument the notch and key batches upstairs rest on. */
  if (keyKind !== 'recess') {
    const box = (polys) => {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const p of polys) for (const v of p.verts)
        for (let k = 0; k < 3; k++) {
          if (v[k] < b[k]) b[k] = v[k];
          if (v[k] > b[k + 3]) b[k + 3] = v[k];
        }
      return b;
    };
    const hits = (a, b) => a[0] < b[3] && b[0] < a[3] && a[1] < b[4] && b[1] < a[4] &&
                           a[2] < b[5] && b[2] < a[5];
    const sites = [];
    for (const bo of keyed) {
      if (plan.junction && offJunction(bo, pitch, piece)) continue;
      const op = keySiteOps(keyKind, keyShape, keyPrm, keyClr, bo.edge, bo.e, bo.s, H);
      sites.push({ cut: op.cut, add: op.add, box: box(op.cut) });
    }
    const cutCells = [];   // the shells cut here, for touchesBuilt as jointCells above
    for (let i = 0; i < shells.length; i++) {
      const b = box(shells[i]), cut = [];
      for (const st of sites) if (hits(st.box, b)) cut.push(...st.cut);
      if (!cut.length) continue;
      const own = [b[0], b[1], b[3], b[4]];
      const beside = cutCells.filter((c) => c.box[0] < own[2] && own[0] < c.box[2] &&
                                            c.box[1] < own[3] && own[1] < c.box[3]);
      let r = cutAgain(shells[i], cut, csgSubtract(shells[i], cut));
      if (beside.some((c) => touchesBuilt(r, own, c)))
        for (const alt of TOUCH_TRIES) {
          let again;
          try { again = alt(shells[i], cut); } catch (e) { continue; }
          if (again && !again.open && !again.turned &&
              !beside.some((c) => touchesBuilt(again, own, c))) { r = again; break; }
        }
      shells[i] = r;
      cutCells.push({ box: own, i });
    }
    /* A key from each seam of a piece one cell deep, at a pitch twice a cup's reach: the
       two cups' outer skins meet face to face (14.44 mm for a bowtie or puzzle key in the
       wall), and every edge round the faces they share is used four times. Below that
       they overlap and above it they stand apart, both clean; there they are one solid,
       and are built as one: the walls of the two joined, and the slabs. */
    const flat = (polys) => { const b = box(polys); return [b[0], b[1], b[3], b[4]]; };
    const adds = sites.map((st) => st.add);
    for (let j = 1; j < adds.length; j++)
      for (let i = 0; i < j; i++) {
        if (!adds[i] || !adds[j]) continue;
        const a = flat(adds[i]), c = flat(adds[j]);
        if (!(a[0] <= c[2] + 1e-3 && c[0] <= a[2] + 1e-3 && a[1] <= c[3] + 1e-3 && c[1] <= a[3] + 1e-3) ||
            !touchesBuilt(adds[j], c, { box: a, polys: adds[i] })) continue;
        const pa = apart(adds[i]), pc = apart(adds[j]);
        if (pa.length !== pc.length) continue;
        let one = [];
        for (let k = 0; k < pa.length && one; k++) {
          const u = csgUnion(pa[k], pc[k]);
          if (u.open) one = null; else one.push(...u);
        }
        if (one) { adds[i] = one; adds[j] = null; }
      }
    for (const a of adds) if (a) shells.push(a);
  }
  if (onStatus) onStatus('done');
  const outPolys = unfoldFinished(clampZ([].concat(...shells), 0));
  const protr = { l: 0, r: 0, f: 0, b: 0 };
  for (const tb of tabs) {
    if (tb.edge === '+x') protr.r = t.dp; else if (tb.edge === '-x') protr.l = t.dp;
    else if (tb.edge === '+y') protr.b = t.dp; else protr.f = t.dp;
  }
  const pzOut = cfg.puzzle.neckL + cfg.puzzle.lobeR * 1.6;
  for (const tb of ptabs) {
    if (tb.edge === '+x') protr.r = pzOut; else if (tb.edge === '-x') protr.l = pzOut;
    else if (tb.edge === '+y') protr.b = pzOut; else protr.f = pzOut;
  }
  return { polys: outPolys, W, D, H, tabs: tabs.length, notches: notches.length,
           bowties: keyed.length, puzzles: ptabs.length + pnotches.length, protrusion: protr };
}

// 1x1 test tile: single-cell plate, no margins/connectors
function buildTestTile(cfg) {
  /* Shaped like anything computeLayout returns, because buildPiece reads the layout to
     work out which of the plate's outer corners this piece owns. The tile is the whole
     plate, so it owns all four. */
  const layout = { nx: 1, ny: 1, pieces: [], seams: [] };
  const piece = { id: 'TEST', band: 0, seg: 0, cellX0: 0, cellY0: 0, nx: 1, ny: 1, mL: 0, mR: 0, mF: 0, mB: 0 };
  const c2 = Object.assign({}, cfg, { connector: 'none' });
  return buildPiece(c2, layout, piece);
}

/* The finished piece, as the STL will have it. polysToTriangles fans each polygon from its
 * first corner, and a polygon that came out of the cuts with a sliver in it (a corner a
 * thousandth or two across the line of its neighbours, or run along a straight edge in
 * a row of seam vertices) can fan into a triangle standing well off its own plane. Where
 * that triangle lies back to back with the one across its edge, a slicer sees a coplanar
 * fold: the side of an H-clip pocket from above, at the top of its clearance, is where the
 * page reaches it. healCsgSeams lays out again the mended faces whose fan folds onto
 * itself, but a sliver standing on edge can fold against the face beside it instead, and
 * only shows once the piece is finished.
 *
 * So a polygon of the finished piece whose plain fan lays a triangle more than 60 degrees
 * off its plane, and has a triangle in a fold (two triangles on one edge, back to back, as
 * test/orientation.js counts them), is laid out again from the first of these that is
 * sound: each of its corners in turn, then ears in its own plane. Sound means every
 * triangle has area and lies within 60 degrees of the plane, no diagonal is an edge the
 * piece already has, and no triangle lies back to back with the one across its edge.
 * Positions are keyed to a thousandth, as checkManifold and the orientation test key
 * them. A polygon with nothing sound goes out as it was, and so does every other one.
 * Nothing it changes is cut again, so it can move no other polygon: an edge of the polygon
 * stays an edge, and a diagonal is new, used by the polygon's own two triangles only. */
function unfoldFinished(polys) {
  const fan = (vs) => {
    const t = [];
    for (let i = 2; i < vs.length; i++) t.push([vs[0], vs[i - 1], vs[i]]);
    return t;
  };
  const off = (vs, nn) => {
    for (let i = 2; i < vs.length; i++) {
      const x = V.cross(V.sub(vs[i - 1], vs[0]), V.sub(vs[i], vs[0])), l = Math.sqrt(V.dot(x, x));
      if (l > 1e-12 && V.dot(x, nn) < 0.5 * l) return true;
    }
    return false;
  };
  const todo = [];
  polys.forEach((p, i) => { if (p.verts.length > 3 && off(p.verts, p.plane.n)) todo.push(i); });
  if (!todo.length) return polys;
  /* Only a polygon near one of those can share an edge with it: keyed to a thousandth, a
     shared edge's ends are within a thousandth of the polygon's corners. So the edges are
     tabled for those alone, which on a piece of thousands of polygons is a handful. */
  const box = (vs, m) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const v of vs)
      for (let k = 0; k < 3; k++) {
        if (v[k] - m < b[k]) b[k] = v[k] - m;
        if (v[k] + m > b[k + 3]) b[k + 3] = v[k] + m;
      }
    return b;
  };
  const near = todo.map((i) => box(polys[i].verts, 2e-3));
  const close = (vs) => {
    const b = box(vs, 0);
    return near.some((a) => a[0] <= b[3] && b[0] <= a[3] && a[1] <= b[4] && b[1] <= a[4] &&
                            a[2] <= b[5] && b[2] <= a[5]);
  };
  // every triangle as written, by edge: its unit normal and the polygon it comes from
  const key = (v) => v.map(x => Math.round(x * 1000) / 1000).join(',');
  const ek = (a, b) => { const x = key(a), y = key(b); return x < y ? x + '|' + y : y + '|' + x; };
  const unit = (t) => {
    const x = V.cross(V.sub(t[1], t[0]), V.sub(t[2], t[0])), l = Math.sqrt(V.dot(x, x));
    return l < 1e-12 ? null : V.scale(x, 1 / l);
  };
  const back = (a, b) => a && b && V.dot(a, b) < -0.999999;
  const E = new Map();
  const put = (ts, pi) => {
    for (const t of ts) {
      const u = unit(t);
      for (let i = 0; i < 3; i++) {
        const k = ek(t[i], t[(i + 1) % 3]);
        let l = E.get(k);
        if (!l) E.set(k, l = []);
        l.push({ u, pi });
      }
    }
  };
  const drop = (ts, pi) => {
    for (const t of ts)
      for (let i = 0; i < 3; i++) {
        const k = ek(t[i], t[(i + 1) % 3]), l = E.get(k);
        if (l) E.set(k, l.filter((e) => e.pi !== pi));
      }
  };
  polys.forEach((p, pi) => { if (close(p.verts)) put(fan(p.verts), pi); });
  const out = polys.slice();
  for (const pi of todo) {
    const p = polys[pi], vs = p.verts, n = vs.length, nn = p.plane.n, plain = fan(vs);
    const folded = plain.some((t) => {
      for (let i = 0; i < 3; i++) {
        const l = E.get(ek(t[i], t[(i + 1) % 3]));
        if (l && l.length === 2 && back(l[0].u, l[1].u)) return true;
      }
      return false;
    });
    if (!folded) continue;
    drop(plain, pi);
    const at = new Map(vs.map((v, i) => [v, i]));
    const sound = (ts) => {
      for (const t of ts) {
        const x = V.cross(V.sub(t[1], t[0]), V.sub(t[2], t[0])), l = Math.sqrt(V.dot(x, x));
        if (l < 1e-9 || V.dot(x, nn) < 0.5 * l) return false;
        const u = V.scale(x, 1 / l);
        for (let i = 0; i < 3; i++) {
          const a = t[i], b = t[(i + 1) % 3], ia = at.get(a), ib = at.get(b);
          const l2 = E.get(ek(a, b)) || [];
          if ((ia + 1) % n === ib || (ib + 1) % n === ia) {
            if (l2.length === 1 && back(u, l2[0].u)) return false;   // folds across its edge
          } else if (key(a) === key(b) || l2.length) return false;     // a diagonal already there
        }
      }
      return true;
    };
    let got = null;
    for (let k = 0; k < n && !got; k++) {
      const r = k ? vs.slice(k).concat(vs.slice(0, k)) : vs;
      if (sound(fan(r))) got = [r];
    }
    if (!got) {
      const m = nn.map(Math.abs);
      const ax = m[0] > m[1] ? (m[0] > m[2] ? 0 : 2) : (m[1] > m[2] ? 1 : 2);
      const proj = vs.map((v, i) => [v[(ax + 1) % 3], v[(ax + 2) % 3], i]);
      const { pts, tris } = earTriangulate(proj);
      if (tris.length === n - 2) {
        // earTriangulate turns them anticlockwise in the projection; the polygon's own way round
        const rev = polyArea2D(proj) < 0;
        const ts = tris.map((e) => (rev ? [e[0], e[2], e[1]] : e).map((j) => vs[pts[j][2]]));
        if (sound(ts)) got = ts;
      }
    }
    if (!got) { put(plain, pi); continue; }
    put([].concat(...got.map(fan)), pi);
    out[pi] = got.map((g) => ({ verts: g, plane: p.plane }));
  }
  const flat = [];
  for (const o of out) if (Array.isArray(o)) flat.push(...o); else flat.push(o);
  return flat;
}

// ---------- STL ----------
function polysToTriangles(polys) {
  const tris = [];
  for (const p of polys) {
    for (let i = 2; i < p.verts.length; i++) tris.push([p.verts[0], p.verts[i-1], p.verts[i]]);
  }
  return tris;
}
function stlBinary(polys, name) {
  const tris = polysToTriangles(polys);
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = (name || 'gridfinity').slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    const n = V.unit(V.cross(V.sub(t[1], t[0]), V.sub(t[2], t[0])));
    dv.setFloat32(o, n[0], true); dv.setFloat32(o+4, n[1], true); dv.setFloat32(o+8, n[2], true); o += 12;
    for (const v of t) { dv.setFloat32(o, v[0], true); dv.setFloat32(o+4, v[1], true); dv.setFloat32(o+8, v[2], true); o += 12; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}

// manifold sanity: every edge shared by exactly 2 triangles (within rounding)
function checkManifold(polys) {
  const tris = polysToTriangles(polys);
  const key = (v) => v.map(x => Math.round(x * 1000) / 1000).join(',');
  const edges = new Map();
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a = key(t[i]), b = key(t[(i+1)%3]);
      const k = a < b ? a + '|' + b : b + '|' + a;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let bad = 0;
  for (const c of edges.values()) if (c !== 2) bad++;
  return { edges: edges.size, bad, tris: tris.length };
}

// ---------- connector fit sample ----------
/* Small test strip: N tile pairs with graduated clearance + one key (keyed types).
   Tiles are plain rounded slabs (fast print) with the joint on the mating edges.
 *
 * The whole value of this file is that you print it, press the joint together and
 * believe the answer, so it has to present the joint the design actually builds — the
 * same housing, the same clearance, the same loose part. `joint` carries that decision
 * in from src/ui.js activeJoint; it is not re-derived here, because re-deriving it is
 * exactly what went wrong. This function used to answer every top-inserted
 * configuration with the bottom recess: for an H-clip, and for a wall-housed bowtie or
 * puzzle key, the coupon offered a pocket open at the underside 2.3 mm deep taking a
 * 2.15 mm key, while the plate has a cup open at the top 1.4 mm deep taking a 1.85 mm
 * one. Nothing on the page said so, and the joint it tested was one you were not
 * building.
 *
 * `joint.kind` names the housing for every connector, `joint.part` is present only for
 * the ones that ship a loose part, and `joint.clrMax`, where there is one, is the
 * slackest this joint's clearance can be set to.
 */
/* Which housing a configuration uses. Pure, so it lives here rather than in the UI:
   the coupon, the plate and the audit all have to agree, and the last three bugs in
   this area were each two places answering this independently. src/ui.js reads it
   through activeJoint, which adds the parts the UI alone knows. */
function jointKind(connector, keyMount, keyInsert) {
  const KEYS = ['bowtie', 'puzzlekey', 'snap'];
  const inWall = connector === 'hclip' || (KEYS.includes(connector) && keyMount === 'wall');
  if (connector === 'snap' && keyInsert === 'top') return 'snaptop';
  if (inWall && keyInsert === 'top') return 'cup';
  return KEYS.includes(connector) || connector === 'hclip' ? 'recess' : connector;
}

function buildFitSample(cfg, H, joint) {
  H = H || 4.25;
  /* From 0.05 under the joint's clearance to 0.1 over, and no further than the joint is
     allowed to go. At the top of the range the two slack pairs were clearances the field
     refuses — a dovetail at 0.25 printed a 0.35 pair, which tells you to set a number the
     page will not take — so the four slide down until the slackest is the ceiling. Slid,
     not cut off: four pairs at four fits still answers the question; three at one does not. */
  const most = joint.clrMax ?? Infinity;
  const slide = Math.max(0, joint.clr + 0.1 - most);
  const clrs = [-0.05, 0, 0.05, 0.1].map(d => Math.min(most, Math.max(0.02, joint.clr + d - slide)));
  /* 10 deep, not 8. A top-inserted cup's outer wall stands 0.6 further into the tile than
     the key it houses, and the full-size key is 14 long, so on an 8 mm tile the wall
     landed 0.25 mm from the back edge — inside the tile's own corner arc. That printed a
     paper-thin back wall, and it left three boundary edges where the cutter grazed the
     arc. The coupon has to have room for the deepest housing it can be asked to present. */
  const tileW = 18, tileD = 10, gapX = 7, seamGap = 1.2;
  const polys = [];
  const rounded = (x0, y0, w, d) => {
    const r = 1.6, pts = [];
    const cs = [[x0+r, y0+r, 180], [x0+w-r, y0+r, 270], [x0+w-r, y0+d-r, 0], [x0+r, y0+d-r, 90]];
    for (const [ccx, ccy, a0] of cs)
      for (let k = 0; k <= 5; k++) {
        const a = (a0 + 90*k/5) * Math.PI/180;
        pts.push([ccx + r*Math.cos(a), ccy + r*Math.sin(a)]);
      }
    return pts;
  };
  clrs.forEach((clr, i) => {
    const x0 = i * (tileW + gapX);
    // pair: tile A below (y<0 side), tile B above; seam at y=0
    for (const side of [-1, 1]) {
      const y0 = side < 0 ? -seamGap/2 - tileD : seamGap/2;
      let tile = extrudePoly(rounded(x0, y0, tileW, tileD), 0, H);
      const edge = side < 0 ? '+y' : '-y';
      const e = side < 0 ? -seamGap/2 : seamGap/2;
      const s = x0 + tileW/2;
      let cuts = [], adds = [];
      if (joint.part) {
        const op = keySiteOps(joint.kind, joint.shape, joint.prm, clr, edge, e, s, H);
        /* Held back rather than pushed in here: the housing stands in the cavity the cut
           makes, so it must not be part of the solid the cut is taken out of. The clip it
           replaces did not care, because a clip took no solid as an argument. */
        cuts = op.cut; adds = op.add;
      } else if (joint.kind === 'puzzle') {
        /* Against the floor pad the plate actually built, not against the tile height.
           The cavity was cut to H - 1.2 and the tab raised to min(2.0, H - 1.4), which
           on a 6.85 mm plate is a 5.65 mm cavity over a 2.0 mm tab — a joint engaging
           over 1.95 mm on the plate and over whatever the tile happened to be here. */
        if (side > 0) cuts = cuts.concat(extrudePoly(
          puzzleShape(edge, e, s, cfg.puzzle, clr, true), -0.5, Math.max(1.2, joint.pad - 0.4)));
        else for (const p of extrudePoly(puzzleShape(edge, e, s, cfg.puzzle, 0, false),
                                         0, Math.max(1.2, joint.pad - 0.65))) tile.push(p);
      } else if (joint.kind === 'dovetail') {
        const t = cfg.tab;
        if (side > 0) {
          const nWr = t.wr + 2*clr, nWt = t.wt + 2*clr, nDp = t.dp + clr;
          const g = 1;
          cuts = cuts.concat(extrudePoly(
            [[s - nWr/2, e - 1], [s - nWt/2, e + nDp], [s + nWt/2, e + nDp], [s + nWr/2, e - 1]],
            -0.5, Math.min(t.h + 0.2, H - 0.8)));
        } else {
          /* The 0.6 mm root here is 0.8 on the plate's tabs. Left alone deliberately:
             the root runs backwards from the seam into the tile's own body, 8 mm of
             solid either way, so the two produce the same printed part and no
             measurement can tell them apart. Changing it would be an edit nothing can
             check. */
          for (const p of extrudePoly(tabFootprint('+y', e, s, t.wr, t.wt, t.dp, 0.6), 0, t.h))
            tile.push(p);
        }
      }
      if (cuts.length) tile = csgSubtract(tile, cuts);
      for (const p of adds) tile.push(p);
      for (const p of clampZ(tile, 0)) polys.push(p);
    }
  });
  /* One loose part alongside — the very part the download ships, not a second
     construction of it. It used to be built here from the key parameters, and for a
     top-inserted H-clip that came out 2.15 mm tall against the download's 1.85. */
  if (joint.part) {
    const kx = clrs.length * (tileW + gapX) + 4;
    for (const p of joint.part)
      polys.push({ verts: p.verts.map(v => [v[0] + kx, v[1], v[2]]), plane: p.plane });
  }
  return { polys, clrs };
}

// ---------- 3MF export ----------
/* A part's name goes into an attribute, so every character XML reads as markup is written
   as its entity. The names today are piece ids and type keys with none of these in them,
   but typed text may reach them later, and a quote in one would end the attribute early
   and hand the rest of the name to the slicer as markup. test/plate-files.js reads the
   names back out of the model.
   Tab, newline and return go as character references too: written raw, a parser reads
   each one in an attribute as a space. The other control characters, U+FFFE, U+FFFF and
   half a surrogate pair are not characters XML has at all, raw or as a reference, and
   one of them makes the whole file unreadable, so they are dropped first. */
const XML_ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
                     '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' };
const xmlAttr = (s) => String(s)
  .replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"'\t\n\r]/g, (c) => XML_ENTITY[c]);
/* items: [{name, polys, tx, ty, tz, rot}] rot in {0,90}. Returns {model, contentTypes, rels} XML strings.
   Each part is turned about its own origin and then moved by (tx, ty, tz), so (tx, ty) is
   where the origin goes, not where the part's corner goes: a caller with a rectangle to
   fill works out the offset from the part's box, as platePolysAndItems in src/ui.js does. */
function build3mfXML(items) {
  let objs = '', builds = '';
  items.forEach((it, idx) => {
    const id = idx + 1;
    const vmap = new Map(); const verts = []; const tris = [];
    const key = (v) => (Math.round(v[0]*1000)/1000) + ',' + (Math.round(v[1]*1000)/1000) + ',' + (Math.round(v[2]*1000)/1000);
    const vidx = (v) => {
      const k = key(v);
      let i = vmap.get(k);
      if (i === undefined) { i = verts.length; vmap.set(k, i); verts.push(v); }
      return i;
    };
    for (const p of it.polys)
      for (let i = 2; i < p.verts.length; i++)
        tris.push([vidx(p.verts[0]), vidx(p.verts[i-1]), vidx(p.verts[i])]);
    objs += `<object id="${id}" type="model" name="${xmlAttr(it.name)}"><mesh><vertices>` +
      verts.map(v => `<vertex x="${v[0].toFixed(3)}" y="${v[1].toFixed(3)}" z="${v[2].toFixed(3)}"/>`).join('') +
      `</vertices><triangles>` +
      tris.map(t => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('') +
      `</triangles></mesh></object>`;
    // row-major 4x3: rotation about z then translate
    const c = it.rot === 90 ? 0 : 1, s = it.rot === 90 ? 1 : 0;
    const T = `${c} ${s} 0 ${-s} ${c} 0 0 0 1 ${(it.tx||0).toFixed(3)} ${(it.ty||0).toFixed(3)} ${(it.tz||0).toFixed(3)}`;
    builds += `<item objectid="${id}" transform="${T}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${objs}</resources><build>${builds}</build></model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return { model, contentTypes, rels };
}

// ---------- print-plate packing ----------
/* items: [{id, w, d, h, qty, stackable}] -> plates: [{items:[{id, x, y, rot, z}], used}]
   Shelf packing with rotation; stackable identical footprints pile up with zGap. */
function packPlates(items, bedW, bedD, gap, opts) {
  opts = opts || {};
  // a gap below zero overlaps the parts it separates — they print fused — so neither is
  // allowed to be one, whoever is calling
  gap = Math.max(0, gap || 0);
  /* Nor is a stack gap under one layer. Side by side, 0 is two parts touching, and they
     come apart; one on another, 0 puts the upper piece's first layer straight onto the
     lower's top, and the slicer prints them as one part. A layer of air is the least
     that leaves a seam to snap them apart at. */
  const zGap = Math.max(PRINT_LAYER, opts.zGap ?? 0.24);
  const bedH = opts.bedH || 1e9;
  const stack = !!opts.stack;
  // expand qty into units
  const units = [];
  for (const it of items) {
    const q = it.qty || 1;
    for (let i = 0; i < q; i++)
      units.push({ id: it.id, w: it.w, d: it.d, h: it.h,
                   ids: it.ids ? [it.ids[Math.min(i, it.ids.length-1)]] : [it.id],
                   stackable: it.stackable !== false });
  }
  units.sort((a, b) => b.w * b.d - a.w * a.d);
  const plates = [];
  function tryShelf(pl, u) {
    for (const rot of [0, 90]) {
      const w = rot ? u.d : u.w, d = rot ? u.w : u.d;
      if (w > bedW || d > bedD || u.h > bedH) continue;
      for (const sh of pl.shelves) {
        if (d <= sh.h + 1e-6 && sh.x + w <= bedW + 1e-6) {
          const t = { id: u.ids[0], x: sh.x, y: sh.y, rot, w, d, z: 0, h: u.h, topW: w, topD: d, topZ: u.h };
          sh.x += w + gap;
          return t;
        }
      }
      const yTop = pl.shelves.length ? pl.shelves[pl.shelves.length-1].y + pl.shelves[pl.shelves.length-1].h + gap : 0;
      if (yTop + d <= bedD + 1e-6) {
        pl.shelves.push({ y: yTop, h: d, x: w + gap });
        return { id: u.ids[0], x: 0, y: yTop, rot, w, d, z: 0, h: u.h, topW: w, topD: d, topZ: u.h };
      }
    }
    return null;
  }
  function tryStack(pl, u) {
    if (!stack || !u.stackable) return null;
    // smallest tower top that still fits the piece (either rotation)
    let best = null;
    for (const base of pl.towers) {
      for (const rot of [0, 90]) {
        const w = rot ? u.d : u.w, d = rot ? u.w : u.d;
        if (w <= base.topW + 1e-6 && d <= base.topD + 1e-6 &&
            base.topZ + zGap + u.h <= bedH + 1e-6) {
          const waste = base.topW * base.topD - w * d;
          if (!best || waste < best.waste) best = { base, rot, w, d, waste };
        }
      }
    }
    if (!best) return null;
    const b = best.base;
    const t = { id: u.ids[0], x: b.x + (b.topW - best.w) / 2, y: b.y + (b.topD - best.d) / 2,
                rot: best.rot, w: best.w, d: best.d, z: b.topZ + zGap, h: u.h };
    b.topW = best.w; b.topD = best.d; b.topZ = t.z + u.h;
    return t;
  }
  /* A part too big for the bed is noted as a plate of its own, marked `overflow`, which
     nothing prints: the pages leave it out of the files. So nothing else may go on it.
     It used to look like an empty plate, and the parts after it were placed there and
     printed nowhere. */
  const printing = () => plates.filter((pl) => !pl.overflow);
  for (const u of units) {
    let placed = null, host = null;
    for (const pl of printing()) { placed = tryStack(pl, u); if (placed) { host = pl; break; } }
    if (!placed) for (const pl of printing()) { placed = tryShelf(pl, u); if (placed) { host = pl; pl.towers.push(placed); break; } }
    if (!placed) {
      const pl = { shelves: [], towers: [], placed: [] };
      placed = tryShelf(pl, u);
      if (placed) { pl.towers.push(placed); plates.push(pl); host = pl; }
      else { plates.push({ shelves: [], towers: [], placed: [], overflow: u.id }); continue; }
    }
    host.placed.push(placed);
  }
  return plates;
}

// ---- split optimizer: choose cuts minimizing print plates ----
/* Every way to write n as an ordered sum of at most maxParts parts of at most maxPart,
   largest parts first — up to `limit` of them.
 *
 * It used to walk the whole tree and keep what reached zero, which is fine for a drawer
 * and 24 million nodes for 200 cells into parts of 70: a branch whose remaining parts
 * could not carry what is left was walked to the bottom anyway. Pruning those changes
 * nothing about what comes out or in what order — they never produced anything — and
 * the limit is there for the cases that are genuinely that big, which a real drawer
 * never reaches: none of the plans test/plate-audit.js holds comes near it. */
const COMPOSITION_LIMIT = 5000;
function compositions(n, maxPart, maxParts, limit = COMPOSITION_LIMIT) {
  const out = [];
  function rec(rem, parts) {
    if (out.length >= limit) return;
    if (rem === 0) { if (parts.length) out.push(parts.slice()); return; }
    if (rem > (maxParts - parts.length) * maxPart) return;   // cannot finish from here
    for (let p = Math.min(rem, maxPart); p >= 1; p--) { parts.push(p); rec(rem - p, parts); parts.pop(); }
  }
  rec(n, []);
  return out;
}
function optimizeForPlates(p) {
  // enumerate banded splits, pack each, keep the best
  const probe = computeLayout(Object.assign({}, p, { splitMode: 'balanced' }));
  const { nx, ny, mL, mR, mF, mB } = probe;
  const pitch = p.pitch;
  const extra = p.connector === 'dovetail' ? 2.5 : 0;
  const maxRows = Math.max(1, Math.floor((p.bedD - extra) / pitch));
  const maxCols = Math.max(1, Math.floor((p.bedW - extra) / pitch));
  const kRowMin = Math.ceil(ny / maxRows), kColMin = Math.ceil(nx / maxCols);
  const rowComps = compositions(ny, maxRows, Math.min(kRowMin + 1, 4))
    .filter(c => c.every((v, i) => v*pitch + extra + (i === 0 ? mF : 0) + (i === c.length-1 ? mB : 0) <= p.bedD + 1e-6));
  const colComps = compositions(nx, maxCols, Math.min(kColMin + 1, 4))
    .filter(c => c.every((v, i) => v*pitch + extra + (i === 0 ? mL : 0) + (i === c.length-1 ? mR : 0) <= p.bedW + 1e-6));
  /* No way to cut the columns at all — every split that fits the count puts a full-width
     segment against a margin that tips it over the bed. The loop below indexed into the
     empty list and threw, so a 1000 × 600 drawer on a 256 mm bed took the page down when
     Fewest plates was picked. The balanced split the caller falls back to copes. */
  if (!rowComps.length || !colComps.length) return null;
  let best = null, tried = 0;
  for (const rc of rowComps) {
    if (tried > 4000) break;
    const rowCuts = []; let acc = 0;
    for (let i = 0; i < rc.length - 1; i++) { acc += rc[i]; rowCuts.push(acc); }
    // per-band col comps: cap combination count
    const perBand = Math.max(1, Math.floor(Math.pow(400, 1 / rc.length)));
    const colSubset = colComps.slice(0, Math.max(perBand, 6));
    const idx = new Array(rc.length).fill(0);
    while (true) {
      tried++;
      if (tried > 4000) break;
      const colCuts = idx.map(i => {
        const cc = colSubset[i]; const cuts = []; let a2 = 0;
        for (let k = 0; k < cc.length - 1; k++) { a2 += cc[k]; cuts.push(a2); }
        return cuts;
      });
      const trial = Object.assign({}, p, { splitMode: 'manual', rowCuts, colCuts });
      const L = computeLayout(trial);
      const items = L.pieces.map(pc => ({
        id: pc.id, w: pc.mL + pc.nx*pitch + pc.mR + extra, d: pc.mF + pc.ny*pitch + pc.mB + extra,
        h: 4.25, qty: 1, stackable: false }));
      const fitsAll = items.every(it =>
        (it.w <= p.bedW && it.d <= p.bedD) || (it.d <= p.bedW && it.w <= p.bedD));
      if (fitsAll) {
        const plates = packPlates(items, p.bedW, p.bedD, 4, {});
        const minDim = Math.min(...L.pieces.map(pc => Math.min(pc.nx, pc.ny)));
        const score = [plates.length, L.pieces.length, -minDim];
        if (!best || score[0] < best.score[0] ||
            (score[0] === best.score[0] && (score[1] < best.score[1] ||
             (score[1] === best.score[1] && score[2] < best.score[2])))) {
          best = { rowCuts: rowCuts.slice(), colCuts: colCuts.map(c => c.slice()), score, plates: plates.length };
        }
      }
      // advance mixed-radix index
      let d = idx.length - 1;
      while (d >= 0) { idx[d]++; if (idx[d] < colSubset.length) break; idx[d] = 0; d--; }
      if (d < 0) break;
    }
  }
  return best;   // {rowCuts, colCuts, plates} or null
}

// transform polys for merged plate export// transform polys for merged plate export
function transformPolys(polys, tx, ty, tz, rot) {
  const c = rot === 90 ? 0 : 1, s = rot === 90 ? 1 : 0;
  return polys.map(p => ({
    verts: p.verts.map(v => [c*v[0] - s*v[1] + tx, s*v[0] + c*v[1] + ty, v[2] + tz]),
    plane: p.plane,
  }));
}

const DEFAULTS = {
  drawerW: 306, drawerD: 380, pitch: 42,
  alignX: 'center', alignY: 'center', marginMode: 'auto',
  mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
  bedW: 256, bedD: 256,
  plateHeight: 4.25, topCutoff: 0.4, bottomPad: 0,
  socketRadius: 4.0, outerRadius: 4.0, tolerance: 'standard',
  connector: 'dovetail',
  splitMode: 'balanced', rowCuts: null, colCuts: null,
  key: { len: 14, wEnd: 8, wWaist: 5, wMid: 6.5, endLen: 4, waistW: 4.5, lobeR: 4.2, depth: 2.0, clr: 0.15 },
  keySlim: { len: 13, wEnd: 3.8, wWaist: 2.4, wMid: 3.0, endLen: 3.5, waistW: 2.0, lobeR: 1.85, depth: 2.0, clr: 0.12 },
  keyType: 'bowtie', keyMount: 'floor', keyInsert: 'bottom',
  hclip: { waistL: 1.3, waistW: 1.8, flangeT: 0.9, flangeW: 3.8, clr: 0.15 },
  puzzle: { neckW: 6, neckL: 1.6, lobeR: 4.6, clr: 0.2 },
  baseMode: 'solid', cornerRadii: null,
  magnetBase: 2.8,
  tab: { wr: 8, wt: 11, dp: 1.9, h: 2.2, clr: 0.2 },
  magnets: false, magnetD: 6, magnetH: 2, magnetSide: 'bottom',
  screws: false, screwHoleD: 3, screwHeadD: 6, screwHeadDepth: 2,
  holeOffset: 13, arcSegs: 6,
  plateStyle: 'solid', skin: 0.8,
};

if (typeof module !== 'undefined') {
  module.exports = { computeLayout, gridCells, halfStrips, pieceConnectors, keysMeet, jointsThatFit, buildPiece, buildTestTile, buildFitSample, jointKind, keyOutline, buildKey, puzzleShape, keyHalf, hclipPrm, snapTopClip, snapTopParts, snapTopPrm, keySiteOps, topPocketCup, snapTopPocket, build3mfXML, packPlates, optimizeForPlates, transformPolys, stlBinary, checkManifold, DEFAULTS, csgSubtract, csgUnion, extrudePoly, socketCutter, polysToTriangles,
    platePad, mountLimits, pieceColumn, compositions, PLATE_RANGES, PLATE_MAX_CELLS, MOUNT_SKIN,
    connClrCeiling, fitClearances, PRINT_LAYER,
    // shared mesh primitives — also used by the bins tool
    makePoly, triangulateRing, earTriangulate, roundedSquareRing, roundedRectRing, clampZ, profilePrism,
    skeletonCellRegion, directCellRegion, polyArea2D };
}

