/* The joint fit coupon, measured against the joint it claims to be a coupon for.
 *
 * The coupon is four tile pairs at graduated clearances plus the loose part. You print
 * it, press the joint together and believe what it tells you — so the only thing worth
 * asserting is that the cavity it hands you is the cavity the baseplate has. That is a
 * geometric claim, so it is checked geometrically: both meshes are built, and the pocket
 * at a real junction is measured off the plate's triangles and the pocket in the coupon
 * tile off the coupon's, by casting rays at them. Nothing here looks at which function
 * ran, or at whether the two calls shared an argument. buildFitSample re-derived the
 * housing from cfg and got it wrong for every top-inserted configuration bar the snap;
 * a test that checked the call would have passed against that for its whole life.
 *
 * Three measurements per site, all off the mesh:
 *   openFrom  which face the cavity is reachable from — the recess opens at the
 *             underside, the cup and the clip pocket open at the top. This is the one
 *             that was wrong: a coupon offering an underside recess where the plate has
 *             a top cup tests a joint you are not building.
 *   floor/ceil  the z the cavity is bounded by, so a pocket at the right end of the
 *             plate but the wrong depth still fails.
 *   throat/mouth  the cavity's width across the seam at two stations, which is where a
 *             clearance change would show up.
 *
 * Both seam orientations are driven, and `openFrom` must never be 'none'. The original
 * reason for that has since been engineered away: a keyed pocket used to be clipped open
 * by a convex prism whose winding came out of the world mapping, so it came back
 * clockwise on the y-edges for the snap and H-clip and on half the edges for the bowtie,
 * and a clockwise cv made the clipper keep what it had been told to remove. The cup was
 * left sealed under solid plate with no way in. clipConvexPrismTop is gone now and the
 * housings are cut by one closed prism per shell, so do not go looking for it.
 *
 * The assertion stays regardless, and not out of sentiment. A cavity you cannot reach is
 * a whole class of defect rather than one bug — the coupon reproduces the plate's
 * geometry faithfully, so a sealed pocket is sealed identically in both and every
 * equality check here still passes. Whatever cuts these pockets next, the question
 * "can the key actually get in" is not answered by any other measurement in this file.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

/* 2x2 cells cut once by hand: one seam, one junction, one loose part. Cut down the
   middle for a seam that runs in y (edge +x on the left piece), and across the middle
   for one that runs in x (edge +y), which is the orientation the winding bug lived on.
   Small on purpose — the run builds each of these designs from scratch. */
const VERTICAL = '#w=84&d=84&mm=auto&bw=256&bd=256&sp=manual&rc=&cc=1';
const HORIZONTAL = '#w=84&d=84&mm=auto&bw=256&bd=256&sp=manual&rc=1&cc=_';

// ---------- measurement, off triangles and nothing else ----------

/* Every z at which a vertical line through (x, y) meets the surface. Deduplicated,
   because overlapping shells put several coincident faces at one height and the
   question here is "where are the surfaces", not "how many". */
function zHits(T, x, y) {
  const zs = [];
  for (const t of T) {
    const [a, b, c] = t;
    const d = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1]);
    if (Math.abs(d) < 1e-12) continue;              // triangle edge-on to the ray
    const l1 = ((b[1]-c[1])*(x-c[0]) + (c[0]-b[0])*(y-c[1])) / d;
    const l2 = ((c[1]-a[1])*(x-c[0]) + (a[0]-c[0])*(y-c[1])) / d;
    if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue;
    zs.push(Math.round((l1*a[2] + l2*b[2] + (1-l1-l2)*c[2]) * 1000) / 1000);
  }
  return [...new Set(zs)].sort((p, q) => p - q);
}

// Möller-Trumbore, for the horizontal rays that measure the cavity across the seam
function rayTri(o, d, t) {
  const [a, b, c] = t;
  const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const h = [d[1]*e2[2]-d[2]*e2[1], d[2]*e2[0]-d[0]*e2[2], d[0]*e2[1]-d[1]*e2[0]];
  const det = e1[0]*h[0] + e1[1]*h[1] + e1[2]*h[2];
  if (Math.abs(det) < 1e-12) return null;
  const f = 1/det, s = [o[0]-a[0], o[1]-a[1], o[2]-a[2]];
  const u = f * (s[0]*h[0] + s[1]*h[1] + s[2]*h[2]);
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = [s[1]*e1[2]-s[2]*e1[1], s[2]*e1[0]-s[0]*e1[2], s[0]*e1[1]-s[1]*e1[0]];
  const v = f * (d[0]*q[0] + d[1]*q[1] + d[2]*q[2]);
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return f * (e2[0]*q[0] + e2[1]*q[1] + e2[2]*q[2]);
}
const MISS = 12;   // no wall within 12 mm of the pocket axis means there is no pocket
function nearestWall(T, o, d) {
  let best = MISS;
  for (const t of T) {
    const h = rayTri(o, d, t);
    if (h !== null && h > 1e-6 && h < best) best = h;
  }
  return best;
}

// site frame: dp counts into the piece from the seam, lt along the seam
function sitePt(edge, e, s, dp, lt) {
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;
  return (edge === '+x' || edge === '-x') ? [e + g*dp, s + lt] : [s + lt, e + g*dp];
}
const alongSeam = (edge) => (edge === '+x' || edge === '-x') ? [0, 1, 0] : [1, 0, 0];

/* The cavity at one junction, in five numbers. `reach` is how far into the piece the
   joint goes, so the two stations land in the same place on the coupon and on the
   plate whatever the connector's proportions are. */
function pocket(T, site, plateH, reach) {
  const { edge, e, s } = site;
  const dpMouth = station(reach), dpThroat = 0.35;
  const [cx, cy] = sitePt(edge, e, s, dpMouth, 0);
  const hits = zHits(T, cx, cy);
  if (!hits.length) return { openFrom: 'nothing' };
  const lo = hits[0], hi = hits[hits.length - 1];
  const openBelow = lo > 0.01, openAbove = hi < plateH - 0.01;
  const openFrom = openBelow && !openAbove ? 'bottom'
                 : openAbove && !openBelow ? 'top'
                 : openBelow && openAbove ? 'through' : 'none';
  const out = { openFrom,
                floor: openFrom === 'top' ? hi : 0,
                ceil: openFrom === 'top' ? plateH : lo };
  // a height clear of both bounding faces, inside the cavity
  const z = openFrom === 'top' ? hi + 0.35 : lo - 0.35;
  const dir = alongSeam(edge);
  for (const [name, dp] of [['throat', dpThroat], ['mouth', dpMouth]]) {
    const [qx, qy] = sitePt(edge, e, s, dp, 0);
    out[name] = 2 * nearestWall(T, [qx, qy, z], dir);
  }
  return out;
}

// ---------- driving the page ----------

const settle = async (page) => {
  await page.evaluate(() => { printPlan = null; recomputeLayout(); });
  await page.waitForFunction(
    'printPlan && layout && Object.keys(builds).length === layout.pieces.length',
    null, { timeout: 40000 });
};

/* Both meshes come out of the page as raw triangles, culled to a box around the joint
   so a megabyte of baseplate does not cross the bridge. The coupon is taken from
   fitSample(), which is the function the download button calls — there is no second
   route to a coupon for this test to measure instead of the real one. */
async function meshes(page) {
  return page.evaluate(() => {
    const tri = (polys) => {
      const out = [];
      for (const p of polys)
        for (let i = 2; i < p.verts.length; i++) out.push([p.verts[0], p.verts[i-1], p.verts[i]]);
      return out;
    };
    const near = (T, cx, cy, r) => T.filter((t) => t.some(
      (v) => Math.abs(v[0] - cx) < r && Math.abs(v[1] - cy) < r));

    const joint = activeJoint();
    const reach = joint.prm ? joint.prm.len / 2
                : state.connector === 'puzzle' ? state.puzzle.neckL + state.puzzle.lobeR
                : state.tab.dp;
    const R = reach + 8;
    /* Whichever piece carries the feature. A tabbed seam puts the male part on one
       piece and the cavity on the other, so piece 0 is the wrong one half the time and
       silently has no site at all. */
    const find = (pick) => {
      for (const p of layout.pieces) {
        const st = pick(pieceConnectors(state, layout, p));
        if (st) {
          const g = (st.edge === '+x' || st.edge === '+y') ? -1 : 1;
          const mid = (st.edge === '+x' || st.edge === '-x')
            ? [st.e + g*reach/2, st.s] : [st.s, st.e + g*reach/2];
          return { site: { edge: st.edge, e: st.e, s: st.s },
                   tris: near(tri(builds[p.id].polys), mid[0], mid[1], R),
                   H: builds[p.id].meta.H };
        }
      }
      return null;
    };
    const cavity = find((c) => c.keyed[0] || c.pnotches[0] || c.notches[0]);
    if (!cavity) return { cavity: null };
    const male = joint.part ? null : find((c) => c.ptabs[0] || c.tabs[0]);

    const fs = fitSample();
    // tile pair 1 carries the configured clearance (the offsets are -0.05, 0, +.05, +.1)
    const tiles = fs.clrs.map((c, i) => ({
      clr: c, seam: { edge: '-y', e: 1.2/2, s: i*(18 + 7) + 18/2 },
      tris: near(tri(fs.polys), i*(18 + 7) + 18/2, 1.2/2 + reach/2, R),
    }));
    const kx = fs.clrs.length * (18 + 7) + 4;

    return {
      kind: joint.kind, reach, clrs: fs.clrs, plateH: cavity.H,
      cavity, male,
      coupon: tiles[1].tris, couponSeam: tiles[1].seam, tiles,
      part: joint.part ? tri(joint.part) : null,
      couponPart: joint.part
        ? tri(fs.polys.filter((p) => p.verts.every((v) => v[0] > kx - 8))) : null,
    };
  });
}

/* A tabbed joint engages over two heights, and both are read straight off a column.
   The cavity's ceiling is the highest surface below the plate top, looking into the
   piece; the male part's top is the highest surface anywhere just outside the piece it
   grows from, where nothing else can be. */
const station = (reach) => Math.min(1.2, Math.max(0.5, reach - 0.4));
function ceilingOf(T, site, plateH, reach) {
  const [x, y] = sitePt(site.edge, site.e, site.s, station(reach), 0);
  const hits = zHits(T, x, y).filter((z) => z < plateH - 0.01);
  return hits.length ? hits[hits.length - 1] : null;
}
function maleTopOf(T, site, reach) {
  const [x, y] = sitePt(site.edge, site.e, site.s, -Math.min(0.9, station(reach)), 0);
  const hits = zHits(T, x, y);
  return hits.length ? hits[hits.length - 1] : null;
}

const box = (T) => {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const t of T) for (const v of t) for (let k = 0; k < 3; k++) {
    if (v[k] < lo[k]) lo[k] = v[k];
    if (v[k] > hi[k]) hi[k] = v[k];
  }
  return [hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]];
};

/* connector, key housing, insert side. Every keyed combination the page offers, plus
   the two tabbed joints, which have no loose part but do have a cavity. */
const CASES = [
  ['dovetail', 'floor', 'bottom'],
  ['puzzle', 'floor', 'bottom'],
  ['bowtie', 'floor', 'bottom'],
  ['bowtie', 'wall', 'bottom'],
  ['bowtie', 'wall', 'top'],
  ['puzzlekey', 'floor', 'bottom'],
  ['puzzlekey', 'wall', 'top'],
  ['snap', 'floor', 'bottom'],
  ['snap', 'wall', 'top'],
  ['snap', 'floor', 'top'],
  ['hclip', 'floor', 'bottom'],
  ['hclip', 'floor', 'top'],
];
// which face keySiteOps' three housings put the opening on
const OPENS = { recess: 'bottom', cup: 'top', snaptop: 'top',
                dovetail: 'bottom', puzzle: 'bottom' };

for (const [name, hash] of [['a seam in y', VERTICAL], ['a seam in x', HORIZONTAL]]) {
  test(`the fit coupon presents the joint the plate has, across ${name}`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(H.PLATES_URL + hash);
    await page.waitForFunction(
      'printPlan && layout && Object.keys(builds).length === layout.pieces.length',
      null, { timeout: 40000 });

    const seenOpen = new Set();
    for (const [cn, km, ki] of CASES) {
      const at = `${cn}/${km}/${ki}`;
      await page.evaluate(({ cn, km, ki }) => {
        for (const [id, v] of [['connector', cn], ['keyMount', km], ['keyInsert', ki]])
          document.getElementById(id).value = v;
      }, { cn, km, ki });
      await settle(page);

      const m = await meshes(page);
      expect(m.cavity, `${at}: the fixture must produce one joint site`).not.toBeNull();

      if (!m.part) {
        /* A tabbed joint has no loose part and no pocket to climb into: what it has is
           an engagement, the male part's height against the cavity's ceiling. The
           coupon cut its cavity relative to the tile it happened to be printed at
           rather than to the floor the plate builds, which on a puzzle plate is a
           5.65 mm cavity over a 1.95 mm tab. */
        expect(ceilingOf(m.coupon, m.couponSeam, m.plateH, m.reach),
               `${at}: cavity ceiling`)
          .toBeCloseTo(ceilingOf(m.cavity.tris, m.cavity.site, m.plateH, m.reach), 2);
        expect(maleTopOf(m.coupon, { edge: '+y', e: -1.2/2, s: m.couponSeam.s }, m.reach),
               `${at}: height of the male part`)
          .toBeCloseTo(maleTopOf(m.male.tris, m.male.site, m.reach), 2);
        seenOpen.add(`${m.kind}:tabbed`);
        continue;
      }

      const plate = pocket(m.cavity.tris, m.cavity.site, m.plateH, m.reach);
      const coupon = pocket(m.coupon, m.couponSeam, m.plateH, m.reach);

      /* There has to be a way in. Equality below cannot see a pocket that is sealed on
         both faces, because the coupon builds it with the same code and seals it the
         same way — and a buried cup is not a tight joint, it is a plate the key cannot
         enter at all. */
      expect(plate.openFrom, `${at}: the plate's pocket must be reachable from a face`)
        .not.toBe('none');
      expect(plate.openFrom, `${at}: a ${m.kind} housing opens at the ${OPENS[m.kind]}`)
        .toBe(OPENS[m.kind]);

      expect(coupon.openFrom, `${at}: the coupon must open at the same face as the plate`)
        .toBe(plate.openFrom);
      expect(coupon.floor, `${at}: pocket floor`).toBeCloseTo(plate.floor, 2);
      expect(coupon.ceil, `${at}: pocket ceiling`).toBeCloseTo(plate.ceil, 2);
      expect(coupon.throat, `${at}: cavity width at the seam`).toBeCloseTo(plate.throat, 2);
      expect(coupon.mouth, `${at}: cavity width inside the joint`).toBeCloseTo(plate.mouth, 2);
      expect(plate.throat, `${at}: the probe must find a cavity wall, not empty space`)
        .toBeLessThan(MISS);

      /* The graduation, off the four tiles' own meshes. The coupon's entire purpose is
         that the four pairs differ by a known amount, and nothing else here would
         notice if they all came out at one clearance: every assertion above compares
         tile 1 against the plate, and tile 1 is the nominal one.
         A band rather than an equality, because only the dogbone profiles put parallel
         flanks at the probe station. Growing a bowtie's or a puzzle key's outline moves
         its far end as well as its flanks, so the width at a fixed depth moves by a bit
         less or a bit more than twice the clearance — measured, 0.98 and 1.18 times.
         Wide enough to hold those and narrow enough that a graduation half the size, or
         none at all, fails. */
      const widths = m.tiles.map((t) => pocket(t.tris, t.seam, m.plateH, m.reach).throat);
      for (let i = 1; i < widths.length; i++) {
        const nominal = 2 * (m.clrs[i] - m.clrs[0]);
        const why = `${at}: tile ${i} must sit about ${(m.clrs[i] - m.clrs[0]).toFixed(2)}` +
          ` mm/side slacker than tile 0, and measures ${(widths[i] - widths[0]).toFixed(3)}` +
          ` against ${nominal.toFixed(3)}`;
        expect(widths[i] - widths[0], why).toBeGreaterThan(0.7 * nominal);
        expect(widths[i] - widths[0], why).toBeLessThan(1.3 * nominal);
      }

      // and the loose part in the coupon is the part the download ships, not a rebuild
      expect(m.couponPart.length, `${at}: coupon part triangle count`).toBe(m.part.length);
      const a = box(m.couponPart), b = box(m.part);
      for (let k = 0; k < 3; k++)
        expect(a[k], `${at}: coupon part size on axis ${k}`).toBeCloseTo(b[k], 3);
      seenOpen.add(`${m.kind}:${plate.openFrom}`);
    }

    /* The precondition. Most assertions above are equalities, and equalities are free
       if every configuration builds the same pocket — so the matrix has to be shown to
       contain both openings and all three housings, or this file is comparing one thing
       against itself twelve times. */
    expect([...seenOpen].sort().join(' '),
      'fixture: the matrix must cover a pocket opening at each face, in every housing')
      .toBe('cup:top dovetail:tabbed puzzle:tabbed recess:bottom snaptop:top');
    expect(errors, 'the page threw while being driven').toEqual([]);
  });
}

/* The coupon waits on nothing: the export dialog offers it while the plate is still
   building, and the page rebuilds 260 ms after every change. Its height came off the
   first piece built, so a coupon taken in that time was cut for the plate before the
   change. Pick the puzzle joint on a dovetail plate and download at once, and the
   coupon came out 4.25 mm tall with its cavity cut against no floor, for a 6.85 mm
   plate on a 2.6 mm one. So the coupon taken at once is the coupon taken once the
   plate has built, to the byte. */
test('a coupon taken before a change has built is the coupon it builds', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(H.PLATES_URL + VERTICAL);
  await page.waitForFunction(
    'printPlan && layout && Object.keys(builds).length === layout.pieces.length',
    null, { timeout: 40000 });
  // the change and the coupon in one go, so the rebuild cannot land between them; `was`
  // is the height of the plate built when the coupon is taken
  const coupon = (cn) => page.evaluate((cn) => {
    if (cn) {
      const s = document.getElementById('connector');
      s.value = cn;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const built = builds[layout.pieces[0].id];
    const was = built ? built.meta.H : null;
    const polys = fitSample().polys;
    let top = 0;
    for (const p of polys) for (const v of p.verts) top = Math.max(top, v[2]);
    const b = new Uint8Array(stlBinary(polys, 'fit-sample'));
    let h = 2166136261;
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619);
    return { was, file: { top: Math.round(top * 1000) / 1000, bytes: b.length, fnv: h >>> 0 } };
  }, cn);
  const early = await coupon('puzzle');
  /* Built now, with no rebuild left waiting: settle() schedules one more, and a coupon
     slower than its 260 ms could be taken while that rebuild has emptied builds. */
  await page.evaluate(async () => { clearTimeout(buildTimer); await runBuild(); });
  const late = await coupon(null);
  expect(early.was, 'fixture: taken with the dovetail plate still built').not.toBeNull();
  expect(late.was, 'fixture: the puzzle plate is built').not.toBeNull();
  expect(early.was, 'fixture: the puzzle plate is a different height').not.toBe(late.was);
  expect(early.file, 'the coupon taken at once').toEqual(late.file);
  expect(late.file.top, 'the coupon is as tall as the plate built').toBe(late.was);
  expect(errors, 'the page threw while being driven').toEqual([]);
});
