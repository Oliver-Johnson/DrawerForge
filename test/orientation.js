'use strict';
/* Face orientation, the thing neither audit could see.
 *
 * checkManifold counts how many triangles touch an edge. That number is blind to which
 * way any of them faces, so a mesh can be watertight, have zero bad edges, and still be
 * wrong in three different ways. Two of them shipped:
 *
 *   - snapTopClip — the U-clip a user prints and presses into a joint — was inside out
 *     for the life of the feature. Signed volume -8.84 mm³, watertight, zero bad edges.
 *   - annulusStrip capped every baseplate cell rim with 21% of its triangles facing
 *     downwards at the shipped smoothness, 33% at the finest, on every plate this
 *     project has ever produced. Found by accident while chasing something else.
 *
 * This lives in its own file rather than in either audit because both audits need it and
 * because the three tests below are worth stating once, in one place, with what each one
 * actually buys — which is not what I assumed before measuring:
 *
 * 1. SIGNED VOLUME, per closed shell. Catches a shell built entirely backwards, which is
 *    snapTopClip. It must be per shell: a plate is a pile of deliberately overlapping
 *    shells and the total sums, so one inverted 0.07 mm³ lip inside 150,000 mm³ of plate
 *    does not move the sign. Four of those were sitting in every top-snap plate.
 *
 * 2. DIRECTED-EDGE BALANCE. Every edge must be traversed as many times in one direction
 *    as in the other. Catches a patch whose winding disagrees with its neighbours', which
 *    global volume can miss when the patch is small. It is NOT what would have caught
 *    annulusStrip — see below — and it does not catch a wholly inverted shell either,
 *    because reversing every triangle in a mesh leaves every edge balanced. Volume and
 *    balance are genuinely independent; neither implies the other.
 *
 * 3. COPLANAR FOLDS. Two triangles sharing a two-manifold edge, lying in the same plane,
 *    facing opposite ways. This is the one that catches annulusStrip, and it is here
 *    because the first two demonstrably do not. Measured against the reverted fix, at
 *    arcSegs 6 and 24: signed volume 1340.010167086673 and 1317.283..., identical to
 *    fifteen digits with the fix in place, and directed-edge imbalance zero. That is not
 *    bad luck. The strip is a combinatorially valid triangulation — consecutive triangles
 *    share a spoke and traverse it in opposite directions — that folds back on itself in
 *    space, and the cap is planar, so by Green's theorem the signed areas telescope to
 *    outline-minus-ring whatever the orientations. Exactly the trap ENGINE.md records
 *    under the deleted rim-cap assertion. A check that cannot fail on the bug its own
 *    comment names is worse than no check, so this file says plainly which test bites.
 *
 * What must NOT be reported as an orientation defect:
 *
 *   - Overlapping closed shells. They are the construction, not a bug. Each is its own
 *     connected component, each is checked on its own.
 *   - Shells abutting face to face (baseMode 'bosses'), or sharing an edge as the puzzle
 *     lobe apex did before buildPiece kept its pole in one region. The bosses are
 *     quarantined in plate-audit.js as leaks and are correctly wound: their shared edges
 *     come out balanced 2 and 2, and the fold test skips them because it only looks at
 *     edges used by exactly two triangles. Measured clean on every quarantined case.
 *   - Volume on an OPEN shell. The divergence theorem needs a closed surface; on an open
 *     one the tetrahedra do not cancel and the number is arbitrary. A top-insert hclip
 *     pocket reads -359 mm³ inside a 27 mm³ bounding box for exactly this reason. So
 *     volume is asserted only where every edge of the shell is used an even number of
 *     times, and open shells are counted and reported instead.
 */
const G = require('../src/core.js');

/* Same rounding as checkManifold, deliberately: two vertices that it considers one had
   better be one here too, or the two checks disagree about what the mesh even is. */
const vkey = (v) => v.map((x) => Math.round(x * 1000) / 1000).join(',');

const tetVol = (t) => {
  const [a, b, c] = t;
  return (a[0]*(b[1]*c[2] - c[1]*b[2]) - a[1]*(b[0]*c[2] - c[0]*b[2]) +
          a[2]*(b[0]*c[1] - c[0]*b[1])) / 6;
};
const unitNormal = (t) => {
  const u = [t[1][0]-t[0][0], t[1][1]-t[0][1], t[1][2]-t[0][2]];
  const v = [t[2][0]-t[0][0], t[2][1]-t[0][1], t[2][2]-t[0][2]];
  const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return l < 1e-12 ? null : [n[0]/l, n[1]/l, n[2]/l];
};

function checkOrientation(polys) {
  const tris = G.polysToTriangles(polys);

  // edge table: how many triangles traverse each edge each way, and which ones
  const E = new Map();
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    for (let i = 0; i < 3; i++) {
      const a = vkey(t[i]), b = vkey(t[(i + 1) % 3]);
      const fwd = a < b, k = fwd ? a + '|' + b : b + '|' + a;
      let e = E.get(k);
      if (!e) { e = { f: 0, r: 0, tris: [] }; E.set(k, e); }
      e[fwd ? 'f' : 'r']++;
      e.tris.push(ti);
    }
  }

  /* Shells are the connected components of the edge graph. Shells that overlap in space
     share no vertices, so they come out separate — which is what makes a per-shell volume
     test possible at all on a plate. Shells that ABUT do share vertices and land in one
     component; that is fine, because both halves are correctly wound and their volumes
     add rather than cancel. */
  const adj = tris.map(() => []);
  for (const e of E.values())
    for (const a of e.tris) for (const b of e.tris) if (a !== b) adj[a].push(b);
  const comp = new Int32Array(tris.length).fill(-1);
  let nShells = 0;
  for (let i = 0; i < tris.length; i++) {
    if (comp[i] >= 0) continue;
    const stack = [i];
    comp[i] = nShells;
    while (stack.length) {
      const c = stack.pop();
      for (const d of adj[c]) if (comp[d] < 0) { comp[d] = nShells; stack.push(d); }
    }
    nShells++;
  }
  const shells = Array.from({ length: nShells }, () => ({ tris: 0, volume: 0, closed: true }));
  for (let i = 0; i < tris.length; i++) {
    const s = shells[comp[i]];
    s.tris++;
    s.volume += tetVol(tris[i]);
  }
  for (const e of E.values())
    if ((e.f + e.r) % 2 === 1) shells[comp[e.tris[0]]].closed = false;

  // 1. every closed shell encloses positive volume
  const inverted = [];
  for (const s of shells) if (s.closed && s.volume <= 0) inverted.push(s);
  const open = shells.filter((s) => !s.closed).length;

  /* 2. every edge traversed as often one way as the other. Odd totals are holes and
     belong to checkManifold; counting them here as winding failures would report one
     defect twice and put this check's number at the mercy of an unrelated one. */
  let wind = 0;
  for (const e of E.values())
    if ((e.f + e.r) % 2 === 0 && e.f !== e.r) wind++;   // 2 and 0 where it should be 1 and 1

  // 3. no two-manifold edge with its two faces coplanar and back to back
  const N = tris.map(unitNormal);
  let folds = 0;
  for (const e of E.values()) {
    if (e.tris.length !== 2) continue;
    const a = N[e.tris[0]], b = N[e.tris[1]];
    if (!a || !b) continue;
    /* Within 0.08 degrees of exactly antiparallel. Nothing legitimate lives here: two
       faces of a solid that meet along an edge and lie in one plane with opposite
       normals enclose nothing at all between them. */
    if (a[0]*b[0] + a[1]*b[1] + a[2]*b[2] < -0.999999) folds++;
  }

  return {
    tris: tris.length, shells: shells.length, open, inverted, wind, folds,
    volume: shells.reduce((t, s) => t + s.volume, 0),
    ok: inverted.length === 0 && wind === 0 && folds === 0,
  };
}

/* One line, and it names WHICH of the three failed — they need different fixes. An
   inverted shell is a whole part built backwards; a winding count is a patch disagreeing
   with its neighbours; a fold is a surface doubling back on itself. */
function orientationNote(r) {
  if (r.ok) return 'oriented';
  const bits = [];
  if (r.inverted.length)
    bits.push(`${r.inverted.length} SHELL${r.inverted.length > 1 ? 'S' : ''} INSIDE OUT (` +
              r.inverted.slice(0, 3).map((s) => `${s.tris} tris, ${s.volume.toFixed(3)} mm3`).join('; ') +
              (r.inverted.length > 3 ? '; ...' : '') + ')');
  if (r.wind) bits.push(`${r.wind} EDGES WOUND THE SAME WAY TWICE`);
  if (r.folds) bits.push(`${r.folds} COPLANAR FOLDS`);
  return bits.join(', ');
}

module.exports = { checkOrientation, orientationNote };
