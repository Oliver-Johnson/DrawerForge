
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
   * nearly-collinear points. */
  const out = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi], n = f.length, vs = f.map((i) => verts[i]);
    let flat = false;
    if (dirty[fi])
      for (let i = 0; i < n && !flat; i++) {
        const u = V.sub(vs[(i + 1) % n], vs[i]);
        const w = V.sub(vs[(i + 2) % n], vs[(i + 1) % n]);
        const c = V.cross(u, w);
        if (V.dot(c, c) < 1e-18) flat = true;
      }
    if (!flat) { out.push({ verts: vs, plane: planes[fi] }); continue; }
    const c = [0, 0, 0];
    for (const v of vs) { c[0] += v[0]/n; c[1] += v[1]/n; c[2] += v[2]/n; }
    for (let i = 0; i < n; i++)
      out.push({ verts: [c, vs[i], vs[(i + 1) % n]], plane: planes[fi] });
  }
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
  n = n || 6;
  r = Math.max(0.3, Math.min(r, half - 0.01));
  const pts = [];
  const cs = [[half-r, half-r, 0], [-half+r, half-r, 90], [-half+r, -half+r, 180], [half-r, -half+r, 270]];
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
  if (cfg.magnets)
    add(cfg.magnetSide === 'top'
      ? cylinder(0, 0, cfg.magnetD/2 + 0.1, magZ0, magZ1, 14)
      : cylinder(0, 0, cfg.magnetD/2 + 0.1, -0.5, cfg.magnetH, 14));
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
 *             a bowtie at 17 mm at 0.15 and under. */
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
   is not. */
function gridCells(p) {
  const pitch = p.pitch;
  let nx, ny, mL, mR, mF, mB;
  if (p.marginMode === 'custom') {
    mL = p.mLeft; mR = p.mRight; mF = p.mFront; mB = p.mBack;
    nx = Math.max(1, Math.floor((p.drawerW - mL - mR) / pitch + 1e-6));
    ny = Math.max(1, Math.floor((p.drawerD - mF - mB) / pitch + 1e-6));
    mR = p.drawerW - mL - nx*pitch;
    mB = p.drawerD - mF - ny*pitch;
  } else {
    nx = Math.max(1, Math.floor(p.drawerW / pitch + 1e-6));
    ny = Math.max(1, Math.floor(p.drawerD / pitch + 1e-6));
    const remX = p.drawerW - nx*pitch, remY = p.drawerD - ny*pitch;
    mL = p.alignX === 'start' ? remX : p.alignX === 'end' ? 0 : remX/2;
    mR = remX - mL;
    mF = p.alignY === 'start' ? remY : p.alignY === 'end' ? 0 : remY/2;
    mB = remY - mF;
  }
  return { nx, ny, mL, mR, mF, mB };
}
/* General layout: horizontal bands (rowCuts) and per-band column cuts (colCuts[b]).
   splitMode: 'balanced' | 'staggered' | 'manual' (manual uses provided cuts). */
function computeLayout(p) {
  const pitch = p.pitch;
  const { nx, ny, mL, mR, mF, mB } = gridCells(p);
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
  return { nx, ny, mL, mR, mF, mB, rowCuts, colCuts, pieces, seams,
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
     * defect ENGINE.md quarantines for the puzzle NOTCH at arcSegs 6, and the rule stated
     * there applies here too — a cutter straddling a region boundary must cross it with a
     * face, not a vertex.
     *
     * There it is quarantined because every fix costs joint geometry. Here it costs
     * nothing, because the arc is inflated to put the missing depth back (below). 19
     * segments rather than the smallest odd number that would do: the count decides where
     * this cutter's facets cross the socket's, and 17 leaves 56 sliver folds in the
     * top-inserted wall cup at the shipped smoothness where 19 leaves none. Measured over
     * 17/19/21/25/33 at arcSegs 6 and 12, on all four mount-and-insert combinations.
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
 */
function skeletonCellRegion(clipped, prof, cx, cy, H, arcSegs, skin) {
  const polys = [];
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
  annulus(clipped, shell[2], zs[2], false);             // underside of the solid band
  for (let i = 0; i < clipped.length; i++) {            // outer wall of the solid band
    const j = (i + 1) % clipped.length;
    const p = makePoly([[clipped[i][0], clipped[i][1], zs[2]], [clipped[j][0], clipped[j][1], zs[2]],
                        [clipped[j][0], clipped[j][1], H], [clipped[i][0], clipped[i][1], H]]);
    if (p) polys.push(p);
  }
  annulus(clipped, inner[3].map((v) => [v[0], v[1]]), H, true);   // the rim
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

function directCellRegion(clipped, prof, cx, cy, H, pad, arcSegs) {
  const polys = [];
  const { pts: oc } = earTriangulate(clipped);
  const n = oc.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = makePoly([[oc[i][0], oc[i][1], 0], [oc[j][0], oc[j][1], 0],
                        [oc[j][0], oc[j][1], H], [oc[i][0], oc[i][1], H]]);
    if (p) polys.push(p);
  }
  const zs = prof.zs.slice(1, 5), ds = prof.ds.slice(1, 5);
  const rings = zs.map((z, i) => {
    const d = ds[i];
    const r = prof.rTop - (d - ds[ds.length-1]);
    return roundedSquareRing(cx, cy, prof.pitchHalf - d, r, arcSegs).map(p => [p[0], p[1], z]);
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
    const cc = [0, 0];
    for (const p of oc) { cc[0] += p[0]/n; cc[1] += p[1]/n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = makePoly([[cc[0], cc[1], 0], [oc[j][0], oc[j][1], 0], [oc[i][0], oc[i][1], 0]]);
      if (p) polys.push(p);
    }
    const fl = rings[0];
    const c = [cx, cy, fl[0][2]];
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
 * These are measurements, not field ranges, and can come out below the field's minimum
 * or negative — a screw shank at a 34 mm pitch has −0.1 mm. That means no cut of any size
 * fits there; the page turns it into a check on the design rather than a range for the
 * field (src/ui.js readNumber), since no number typed into the field could fix it. */
function mountLimits(cfg) {
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
  return {
    // a magnet pocket is cut 0.1 mm over the magnet's radius
    magnetD: r10(2 * ((cfg.magnetSide === 'top' ? top : under) - 0.1)),
    screwHoleD: r10(2 * top),
    screwHeadD: r10(2 * under),
    // in the solid floor the pad grows to suit, so only a boss caps the depth
    depth: bosses ? r10(BOSS_H - MOUNT_SKIN) : Infinity,
  };
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
  const keyedConn = ['bowtie', 'snap', 'puzzlekey'].includes(cfg.connector);
  const wallKeys = (keyedConn && cfg.keyMount === 'wall');
  const keyDims = wallKeys ? cfg.keySlim : cfg.key;
  /* Which of keySiteOps' three housings this configuration builds — from jointKind,
     like everyone else. src/ui.js activeJoint asks it for the loose part and the fit
     coupon, and the audit asks it too; this was the fourth copy of the rule and the
     last one, written out longhand under a comment saying the decision lived elsewhere.

     It was never a live defect. jointKind falls back to the connector's own name where
     this expression said 'recess', so the two disagree for dovetail, puzzle and none —
     and every reader of keyKind is inside a loop over `keyed`, which pieceConnectors
     leaves empty for exactly those three (isTab, and the early return for 'none'). The
     one thing to keep true, then, is that emptiness: if `keyed` ever carries sites for
     a tabbed connector, this line starts answering a question it used to duck.
     Byte-identical output across the 112-config matrix either way.

     The snap's clip is one part at one size whatever the housing, so its fit comes from
     the full key's clearance; a flat key takes its own housing's. */
  const keyShape = isHclip ? 'snap' : cfg.keyType;
  const keyPrm = isHclip ? hclipPrm(cfg.hclip) : keyDims;
  const keyKind = jointKind(cfg.connector, cfg.keyMount, cfg.keyInsert);
  const keyClr = keyKind === 'snaptop' ? cfg.key.clr
               : isHclip ? cfg.hclip.clr : keyDims.clr;
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
  const rOf = (k) => Math.max(0, Math.min(rr[k] !== undefined ? rr[k] : cfg.outerRadius,
                                          rMax, half));
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
  const xs = [0]; if (piece.mL > 0.01) xs.push(piece.mL);
  for (let i = 1; i <= piece.nx; i++) xs.push(gx0 + i*pitch);
  if (piece.mR > 0.01) xs.push(W); else xs[xs.length-1] = W;
  const ys = [0]; if (piece.mF > 0.01) ys.push(piece.mF);
  for (let j = 1; j <= piece.ny; j++) ys.push(gy0 + j*pitch);
  if (piece.mB > 0.01) ys.push(D); else ys[ys.length-1] = D;
  const cellXi = piece.mL > 0.01 ? 1 : 0;         // index offset of first cell column
  const cellYi = piece.mF > 0.01 ? 1 : 0;
  const BLOAT = 0.05;

  /* Shells, kept apart rather than poured into one soup, because the top-insert pass
     below has to subtract from each one on its own — a subtraction is only defined
     against a single closed solid, and this piece is a dozen of them deliberately
     overlapping. They are concatenated at the end and nothing downstream can tell. */
  const shells = [];
  let done = 0;
  for (let ix = 0; ix < xs.length-1; ix++) {
    for (let iy = 0; iy < ys.length-1; iy++) {
      const x0 = Math.max(0, xs[ix] - BLOAT), x1 = Math.min(W, xs[ix+1] + BLOAT);
      const y0 = Math.max(0, ys[iy] - BLOAT), y1 = Math.min(D, ys[iy+1] + BLOAT);
      const clipped = clipToRect(outline, x0, y0, x1, y1);
      if (!clipped) continue;
      const ci = ix - cellXi, cj = iy - cellYi;
      const isCell = ci >= 0 && ci < piece.nx && cj >= 0 && cj < piece.ny;
      if (!isCell) {                                 // margin / corner: plain extrusion
        shells.push(extrudePoly(clipped, 0, H));
        continue;
      }
      const cx = gx0 + ci*pitch + half, cy = gy0 + cj*pitch + half;
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
      // anything the piece boundary has cut into measures less than pitch^2
      const fullCell = Math.abs(polyArea2D(clipped)) >= pitch * pitch - 0.5;
      const onEdge = ci === 0 || cj === 0 || ci === piece.nx - 1 || cj === piece.ny - 1;
      const jointed = cfg.connector && cfg.connector !== 'none';
      const skel = cfg.plateStyle === 'skeleton' && pad <= 0.01 && fullCell
                   && !cfg.magnets && !cfg.screws && !(jointed && onEdge);
      let region = skel
        ? skeletonCellRegion(clipped, prof, cx, cy, H, cfg.arcSegs || 6,
                             Math.max(0.4, cfg.skin || 0.8))
        : directCellRegion(clipped, prof, cx, cy, H, pad, cfg.arcSegs || 6);
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
        if (near) {
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
          cuts.notch.push(...extrudePoly(pts, -0.503, Math.min(t.h + 0.2, H - 0.8)));
        }
      }
      for (const bo of keyed) {
        if ((wallKeys || isHclip) && Math.abs(bo.s / pitch - Math.round(bo.s / pitch)) > 0.25 &&
            Math.abs((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch -
                     Math.round((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch)) > 0.25)
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
        if (near) cuts.puzzle.push(
          ...extrudePoly(puzzleShape(pn.edge, pn.e, pn.s, cfg.puzzle, cfg.puzzle.clr, true),
                         -0.5, pad - 0.4));
      }
      if (cellFastener) {
        const off = cfg.holeOffset;
        for (const sx of [-1, 1]) for (const sy of [-1, 1])
          cuts.fastener.push(...movePolys(cellFastener, cx + sx*off, cy + sy*off));
      }
      for (const cut of Object.values(cuts)) if (cut.length) region = csgSubtract(region, cut);
      shells.push(region);
      done++;
      if (onStatus && done % 8 === 0) onStatus(`cells ${done}`);
    }
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
      if (Math.abs(bo.s / pitch - Math.round(bo.s / pitch)) > 0.25 &&
          Math.abs((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch -
                   Math.round((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch)) > 0.25)
        continue;
      const op = keySiteOps(keyKind, keyShape, keyPrm, keyClr, bo.edge, bo.e, bo.s, H);
      sites.push({ cut: op.cut, add: op.add, box: box(op.cut) });
    }
    for (let i = 0; i < shells.length; i++) {
      const b = box(shells[i]), cut = [];
      for (const st of sites) if (hits(st.box, b)) cut.push(...st.cut);
      if (cut.length) shells[i] = csgSubtract(shells[i], cut);
    }
    for (const st of sites) shells.push(st.add);
  }
  if (onStatus) onStatus('done');
  const outPolys = clampZ([].concat(...shells), 0);
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
  module.exports = { computeLayout, gridCells, pieceConnectors, buildPiece, buildTestTile, buildFitSample, jointKind, keyOutline, buildKey, puzzleShape, keyHalf, hclipPrm, snapTopClip, snapTopParts, snapTopPrm, keySiteOps, topPocketCup, snapTopPocket, build3mfXML, packPlates, optimizeForPlates, transformPolys, stlBinary, checkManifold, DEFAULTS, csgSubtract, csgUnion, extrudePoly, socketCutter, polysToTriangles,
    platePad, mountLimits, pieceColumn, compositions, PLATE_RANGES, PLATE_MAX_CELLS, MOUNT_SKIN,
    connClrCeiling, fitClearances, PRINT_LAYER,
    // shared mesh primitives — also used by the bins tool
    makePoly, triangulateRing, earTriangulate, roundedSquareRing, clampZ, profilePrism,
    skeletonCellRegion, directCellRegion, polyArea2D };
}

