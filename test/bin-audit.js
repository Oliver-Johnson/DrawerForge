#!/usr/bin/env node
/* Headless audit for bin geometry: manifold check, bounds, and STL output.
 * Usage: node test/bin-audit.js [outDir]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../src/core.js');
const { buildBin, SPEC, REQUIRED_CORE, BIN_DEFAULTS, outlineAt, wallSplits,
        lidPart: lidPartOf, lipHeight: lipHeightOf, LIP_TABLE } = require('../src/bins/bin.js');
const { checkOrientation, orientationNote } = require('./orientation.js');

// the browser hand-assembles its own G; make sure core still exports everything
{
  const missing = REQUIRED_CORE.filter((f) => typeof G[f] !== 'function');
  if (missing.length) {
    console.error('core.js is missing: ' + missing.join(', '));
    process.exit(1);
  }
}

const cellsExcept = (u, v, drop) => {
  const out = [];
  for (let x = 0; x < u; x++) for (let y = 0; y < v; y++)
    if (!drop.some((d) => d[0] === x && d[1] === y)) out.push([x, y]);
  return out;
};

const outDir = process.argv[2] || path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });

const CASES = [
  { name: '1x1x3', u: 1, v: 1, hUnits: 3 },
  { name: '1x1x6', u: 1, v: 1, hUnits: 6 },
  { name: '2x1x3', u: 2, v: 1, hUnits: 3 },
  { name: '2x2x3', u: 2, v: 2, hUnits: 3 },
  { name: '3x2x4', u: 3, v: 2, hUnits: 4 },
  { name: '1x1x3-solid', u: 1, v: 1, hUnits: 3, solid: true },
  { name: '2x1x3-div', u: 2, v: 1, hUnits: 3, divX: 1 },
  { name: '3x2x5-div', u: 3, v: 2, hUnits: 5, divX: 2, divY: 1 },
  /* Removable dividers build rails instead of a wall across the cavity — four small
     prisms per divider, which is four more chances to leave a shell open. */
  { name: '2x2x3-railed', u: 2, v: 2, hUnits: 3, divX: 1, divRemovable: true },
  { name: '3x2x5-railed', u: 3, v: 2, hUnits: 5, divX: 2, divY: 1, divRemovable: true },
  { name: '1x1x1', u: 1, v: 1, hUnits: 1 },
  { name: '2x1x3-scoop', u: 2, v: 1, hUnits: 3, scoop: 8 },
  { name: '2x1x3-label', u: 2, v: 1, hUnits: 3, label: 12 },
  /* A shelf deeper than the cavity is tall: its 45 degree underside used to run down
     through the floor and out among the feet, 4 open edges from 8 mm on a 1-unit bin. */
  { name: '1x1x1-label12', u: 1, v: 1, hUnits: 1, label: 12 },
  { name: '2x1x2-label20', u: 2, v: 1, hUnits: 2, label: 20 },
  { name: '2x1x3-openfront', u: 2, v: 1, hUnits: 3, edges: { f: 0 } },
  { name: '2x2x2-tray', u: 2, v: 2, hUnits: 2, edges: { f: 0, b: 0, l: 0, r: 0 } },
  { name: '6x4x5-everything', u: 6, v: 4, hUnits: 5, divX: 2, divY: 1, scoop: 6, label: 10 },
  // carved footprints — the concave outlines the per-cell builder exists for
  { name: 'L-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) },
  { name: 'U-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[1, 2]]) },
  { name: 'T-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[0, 0], [2, 0]]) },
  { name: 'staircase-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[1, 2], [2, 2], [2, 1]]) },
  { name: 'bigL-5x4', u: 5, v: 4, hUnits: 4, cells: cellsExcept(5, 4, [[3, 3], [4, 3], [4, 2]]) },
];

/* Every carved footprint builds one outer fillet per reflex corner, and every one of
 * them used to be inside out: a closed 212-triangle shell of -214.259 mm³. Watertight,
 * zero bad edges, and the total volume stayed positive because it was one shell among
 * forty in a pile of overlapping ones — which is exactly the gap the orientation check
 * exists to close. sweptSector traced the band as `outer` forward then `inner` reversed,
 * which is only anticlockwise while `outer` is the larger radius; the concave case
 * passes them the other way round. It now sorts them by radius before tracing. */
const orientQuarantine = (cs, r) => cs.orientQuarantine
  ? (r.ok ? '  ORIENTATION NOW CLEAN — take it out of quarantine' : `  known: ${cs.orientQuarantine}`)
  : '';

let bad = 0;
console.log('case            tris   W x D x H (mm)        zmin   zmax   mesh');
for (const cs of CASES) {
  let r;
  try {
    r = buildBin(G, cs);
  } catch (e) {
    console.log(`${cs.name.padEnd(14)} BUILD FAILED: ${e.message}`);
    bad++; continue;
  }
  const tris = G.polysToTriangles(r.polys);
  let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of r.polys) for (const v of p.verts) {
    zmin = Math.min(zmin, v[2]); zmax = Math.max(zmax, v[2]);
    xmin = Math.min(xmin, v[0]); xmax = Math.max(xmax, v[0]);
    ymin = Math.min(ymin, v[1]); ymax = Math.max(ymax, v[1]);
  }
  /* Bins ARE watertight and must stay so. An earlier build leaked 218 boundary
     edges because triangulateRing's ear clipper bailed out silently on a thin ring,
     and a slicer reported them as non-manifold. Every edge must now be shared by
     exactly two faces — boundary edges (used once) are holes, and anything used
     more than twice is two shells meeting on a plane instead of overlapping. */
  const man = G.checkManifold(r.polys);
  const pct = 100 * man.bad / man.edges;
  const ok = man.bad === 0;
  /* Watertight says nothing about which way a face points, and a bin is a pile of
     overlapping shells, so the sign of the total volume says nothing either. See
     orientation.js: per-shell volume, directed-edge balance and coplanar folds. */
  const ori = checkOrientation(r.polys);
  const dims = `${(xmax - xmin).toFixed(2)} x ${(ymax - ymin).toFixed(2)} x ${(zmax - zmin).toFixed(2)}`;

  // expected footprint straight from the spec, independent of the builder
  const expW = (cs.u - 1) * 42 + 41.5, expD = (cs.v - 1) * 42 + 41.5;
  /* A carved shape spans its bounding box to the same tolerance as a plain one now
     that its convex corners follow the spec arc. It used to need 0.2 mm of slack
     because square corners put it 1.55 mm outside the Gridfinity profile diagonally
     and 0.1 mm over on the flats. */
  const tol = 0.02;
  const wOk = Math.abs((xmax - xmin) - expW) < tol && Math.abs((ymax - ymin) - expD) < tol;
  /* The stacking PITCH is always hUnits*7 — that is what a bin occupies in a stack.
     The real height can be less: a tray with every wall open is just its floor, so
     compare zmax against meta.totalH and check the pitch separately. */
  const hOk = Math.abs(zmax - r.meta.totalH) < 0.02 &&
              Math.abs(r.meta.H - cs.hUnits * 7) < 0.001 &&
              zmin > -0.001;

  console.log(`${cs.name.padEnd(14)} ${String(tris.length).padStart(6)}  ${dims.padEnd(20)} ` +
              `${zmin.toFixed(3).padStart(6)} ${zmax.toFixed(3).padStart(6)}  ` +
              `${ok ? 'watertight' : man.bad + ' BAD EDGES'}`.padStart(12) +
              `${wOk ? '' : '  FOOTPRINT MISMATCH exp ' + expW + 'x' + expD}` +
              `${hOk ? '' : '  HEIGHT MISMATCH: zmax ' + zmax.toFixed(2) + ' vs totalH ' + r.meta.totalH.toFixed(2) + ', pitch ' + r.meta.H}`);
  /* A carved shape is still a bin: it takes a stacking lip like any other, so it
     must report one and stand the same height as the rectangle of the same units.
     Losing the lip silently would make anything carved unstackable. */
  let lipOk = true;
  if (cs.cells && !cs.solid && !cs.edges) {
    const expTotal = cs.hUnits * 7 + 3.95;
    lipOk = r.meta.hasLip === true && Math.abs(r.meta.totalH - expTotal) < 0.001;
    if (!lipOk) console.log(`${''.padEnd(14)}  LIP MISSING: hasLip ${r.meta.hasLip}, ` +
      `totalH ${r.meta.totalH.toFixed(2)} vs ${expTotal.toFixed(2)}`);
  }
  if (!ori.ok || cs.orientQuarantine)
    console.log(`${''.padEnd(14)}  ${ori.shells} shells, ${ori.volume.toFixed(1)} mm3   ` +
                `${orientationNote(ori)}${orientQuarantine(cs, ori)}`);
  if (!ok || !wOk || !hOk || !lipOk) bad++;
  if (cs.orientQuarantine ? ori.ok : !ori.ok) bad++;

  fs.writeFileSync(path.join(outDir, `bin-${cs.name}.stl`),
                   Buffer.from(G.stlBinary(r.polys, cs.name)));
}

/* cross-section audit: slice the real mesh and compare against the spec profile.
   maxAbs catches the flats; maxRad catches the corner arcs. Expected values come
   from the published spec, not from bin.js. */
function sectionExtents(polys, z) {
  const tris = G.polysToTriangles(polys);
  let maxAbs = 0, maxRad = 0, hits = 0;
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      if ((a[2] - z) * (b[2] - z) >= 0) continue;
      const s = (z - a[2]) / (b[2] - a[2]);
      const x = a[0] + s * (b[0] - a[0]), y = a[1] + s * (b[1] - a[1]);
      maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
      maxRad = Math.max(maxRad, Math.hypot(x, y));
      hits++;
    }
  }
  return { maxAbs, maxRad, hits };
}
console.log('\ncross-sections of the built 1x1x3 mesh vs the published spec:');
console.log('   z    half-width  (exp)    corner reach  (exp)');
{
  const r = buildBin(G, { u: 1, v: 1, hUnits: 3 });
  const C = SPEC.centre;
  for (const [z, expHalf] of [[0.4, 17.8 + 0.4], [1.5, 18.6], [2.5, 18.6],
                              [3.5, 18.6 + 0.9], [4.6, 18.6 + 2.0]]) {
    const s = sectionExtents(r.polys, z);
    const expRad = C * Math.SQRT2 + (expHalf - C);
    const flatOk = Math.abs(s.maxAbs - expHalf) < 0.03;
    const radOk = Math.abs(s.maxRad - expRad) < 0.06;   // faceting slack
    console.log(`  ${z.toFixed(2)}   ${s.maxAbs.toFixed(3)}   (${expHalf.toFixed(2)})   ` +
                `${s.maxRad.toFixed(3)}   (${expRad.toFixed(2)})  ` +
                `${flatOk && radOk ? 'ok' : 'MISMATCH'}`);
    if (!(flatOk && radOk)) bad++;
  }
}

/* stacking: does a spec foot fit the lip? The lip's inner surface is defined by an
   inset from the bin's outer outline; the foot comes from the published spec. Both
   share corner-arc centre 17.00, so one number covers flats and corners alike. */
console.log('\nstacking clearance — spec foot inside the lip above it:');
console.log("   z'    lip inner   foot half   clearance");
{
  const { LIP_TABLE } = require('../src/bins/bin.js');
  const steps = LIP_TABLE || [[0, 2.70], [0.8, 1.90], [2.6, 1.90]];
  let worst = Infinity;
  for (const [z, t] of steps) {
    const lipInner = SPEC.half - t;
    let fh = SPEC.prof[SPEC.prof.length - 1][1];
    for (let k = 0; k < SPEC.prof.length - 1; k++) {
      const [z0, h0] = SPEC.prof[k], [z1, h1] = SPEC.prof[k + 1];
      if (z >= z0 && z <= z1) { fh = h0 + (h1 - h0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
    }
    const clr = lipInner - fh;
    worst = Math.min(worst, clr);
    console.log(`  ${z.toFixed(2).padStart(4)}   ${lipInner.toFixed(2).padStart(9)}   ` +
                `${fh.toFixed(2).padStart(9)}   ${clr.toFixed(3).padStart(9)}` +
                `${Math.abs(clr - 0.25) < 0.001 ? '  ok' : '  OFF SPEC'}`);
    if (Math.abs(clr - 0.25) > 0.001) bad++;
  }
  console.log(`  uniform on flats and corners (both outlines share centre ${SPEC.centre.toFixed(2)})`);
}

/* independent check: the foot outline must share the spec corner-arc centre */
console.log('\nfoot corner-arc centre (must be 17.00 at every level):');
for (const [z, half] of SPEC.prof) {
  const r = half - SPEC.centre;
  console.log(`  z ${z.toFixed(2).padStart(5)}  half ${half.toFixed(2)}  r ${r.toFixed(2)}  centre ${(half - r).toFixed(2)}`);
}

/* Nothing was checking the OUTSIDE for overhangs, which is how the retired low-profile
   base shipped a 2.15 mm ledge starting in mid-air, and how the taper meant to fix it
   sat buried inside the body doing nothing across two commits. The styles that caused
   it are gone; the check stays, because it is the only thing here that reads the
   silhouette of the mesh that came out rather than the profile it was built from.
   Walk it and demand no sideways step wider than the height it rises over — that is
   45 degrees, the angle a printer holds without support. */
console.log('\nouter silhouette: no overhang steeper than 45 degrees');
{
  const STEP = 0.05;
  for (const hUnits of [1, 3]) {
    const r = buildBin(G, { u: 2, v: 1, hUnits });
    const tris = G.polysToTriangles(r.polys);
    const at = (z) => {
      let m = 0;
      for (const t of tris) {
        const lo = Math.min(t[0][2], t[1][2], t[2][2]);
        const hi = Math.max(t[0][2], t[1][2], t[2][2]);
        if (z < lo - 1e-9 || z > hi + 1e-9) continue;
        for (let i = 0; i < 3; i++) {
          const a = t[i], b = t[(i + 1) % 3];
          if ((a[2] - z) * (b[2] - z) > 0) continue;
          const s = Math.abs(b[2] - a[2]) < 1e-12 ? 0 : (z - a[2]) / (b[2] - a[2]);
          m = Math.max(m, Math.abs(a[1] + s * (b[1] - a[1])));
        }
      }
      return m;
    };
    let prev = null, worst = 0, where = 0;
    for (let z = STEP; z <= hUnits * 7; z += STEP) {
      const v = at(z);
      if (prev !== null && v - prev > worst) { worst = v - prev; where = z; }
      prev = v;
    }
    const ok = worst <= STEP + 1e-6;
    console.log(`  ${(hUnits + 'u').padEnd(13)} widest step ${worst.toFixed(3)} mm ` +
                `per ${STEP} mm of height, at z ${where.toFixed(2)}   ${ok ? 'ok' : 'OVERHANG'}`);
    if (!ok) bad++;
  }
}

/* Where a lowered wall meets a full-height one.
 *
 * A bin with a half-height front broke in the hand: the top of a side wall came away.
 * The lowered edge used to stop dead beside the full-height corner post, so the top edge
 * fell most of a centimetre across a tangent point — a square notch at the end of the
 * longest unsupported run of wall on the bin, and nearly all of a thin wall's stiffness
 * in bending comes from material at that edge. It now climbs over the first straight
 * segment instead.
 *
 * Measured off the mesh rather than off edgeHeights: the outline rule and the geometry
 * it produces are two different claims, and only the second one gets printed. The top of
 * the wall is read along the outer outline in order, and the steepest step between
 * neighbouring points has to stay clear of vertical. A cliff reads 90.
 */
console.log('\nwhere a lowered wall meets a full-height one');
{
  const seen = new Map();
  const LIMIT = 75;   // degrees from horizontal; the ramps measure 41-61, a step is 90
  const RAMP = [
    ['1x1 front at half', 1, 1, { f: 0.5 }],
    ['1x1 front open', 1, 1, { f: 0 }],
    ['3x1 front at half', 3, 1, { f: 0.5 }],
    ['2x2 front and left', 2, 2, { f: 0.5, l: 0.5 }],
    ['1x1 all full', 1, 1, null],
  ];
  for (const [label, u, v, edges] of RAMP) {
    const r = buildBin(G, Object.assign({}, BIN_DEFAULTS, { u, v, hUnits: 3, edges }));
    /* The same outline buildBin walls with, splits and all. Rebuilding it uniformly
       would sample straight over the ramp vertex and read the shallow average instead
       of the step that is actually there — a check that cannot see the defect. */
    const sp = wallSplits((u - 1) * SPEC.pitch / 2 + SPEC.half,
                          (v - 1) * SPEC.pitch / 2 + SPEC.half, SPEC.r);
    const prof = outlineAt(u, v, SPEC.half, 0, 6, sp).map(([x, y]) => {
      let z = -Infinity;
      for (const pl of r.polys) for (const w of pl.verts)
        if (Math.hypot(w[0] - x, w[1] - y) < 0.35 && w[2] > z) z = w[2];
      return [x, y, z];
    }).filter((q) => isFinite(q[2]));
    let worst = 0;
    for (let i = 0; i < prof.length; i++) {
      const a = prof[i], b = prof[(i + 1) % prof.length];
      const climb = Math.abs(a[2] - b[2]);
      if (climb < 0.2) continue;                       // flat runs carry no transition
      const run = Math.hypot(a[0] - b[0], a[1] - b[1]);
      worst = Math.max(worst, Math.atan2(climb, run) * 180 / Math.PI);
    }
    const ok = worst <= LIMIT;
    console.log(`  ${label.padEnd(20)}steepest top edge ${worst.toFixed(1).padStart(5)}°   ` +
                (ok ? 'ok' : 'CLIFF — a wall ending in a square notch is what broke'));
    if (!ok) bad++;
    seen.set(label, worst);
  }

  /* The angle must not depend on the footprint.
   *
   * The ramp was a quarter of the wall to begin with, which meant a wide bin got a long
   * shallow one — 26 degrees across a 3x5 against 60 across a 1x1 — and gave up a third
   * of an opening that had no strength problem to solve. It is a fixed 8.5 mm now, so
   * the same climb takes the same run whatever the bin's plan. The check above cannot
   * see that regression on its own: a shallower ramp passes a "not a cliff" test
   * comfortably. This is the assertion that fails if the rule goes back to a fraction.
   */
  const wide = [['1x1x5', 1, 1], ['3x1x5', 3, 1], ['3x5x5', 3, 5], ['5x5x5', 5, 5]];
  const angles = wide.map(([, u, v]) => {
    const r = buildBin(G, Object.assign({}, BIN_DEFAULTS, { u, v, hUnits: 5, edges: { f: 0.5 } }));
    const sp = wallSplits((u - 1) * SPEC.pitch / 2 + SPEC.half,
                          (v - 1) * SPEC.pitch / 2 + SPEC.half, SPEC.r);
    const prof = outlineAt(u, v, SPEC.half, 0, 6, sp).map(([x, y]) => {
      let z = -Infinity;
      for (const pl of r.polys) for (const w of pl.verts)
        if (Math.hypot(w[0] - x, w[1] - y) < 0.35 && w[2] > z) z = w[2];
      return [x, y, z];
    }).filter((q) => isFinite(q[2]));
    let worst = 0;
    for (let i = 0; i < prof.length; i++) {
      const a = prof[i], b = prof[(i + 1) % prof.length];
      const climb = Math.abs(a[2] - b[2]);
      if (climb < 0.2) continue;
      worst = Math.max(worst, Math.atan2(climb,
        Math.hypot(a[0] - b[0], a[1] - b[1])) * 180 / Math.PI);
    }
    return worst;
  });
  const spread = Math.max(...angles) - Math.min(...angles);
  console.log(`  ${'same angle at any width'.padEnd(24)}` +
    wide.map(([n], i) => `${n} ${angles[i].toFixed(1)}°`).join('  ') +
    `   ${spread <= 1 ? 'ok' : `SPREAD ${spread.toFixed(1)}° — the ramp is scaling with the bin again`}`);
  if (spread > 1) bad++;
}

/* Does a lid actually go into the lip it is made for?
 *
 * Nothing about the mesh can tell you. The first skirt was watertight, the right
 * footprint and the right height, and fouled the lip from 0.3 mm to 1.5 mm down by up
 * to 0.40 mm — it would have jammed near the top and never seated. It invented a taper
 * instead of following the lip's, which is the sort of mistake that only shows up in
 * the hand, on a print, after an hour.
 *
 * So this compares the two profiles directly: at every depth down the skirt, how much
 * narrower is the lid than the opening it goes into. Must be positive everywhere, and
 * should come out at the clearance, since the two surfaces are meant to be parallel.
 */
console.log('\na lid fits the lip it is made for');
{
  const lipMin = BIN_DEFAULTS.lipMin, lipH = lipHeightOf(lipMin), CLR = 0.2;
  // lip inner inset, as a function of depth below the rim
  const pts = LIP_TABLE.map(([h, i]) => [lipH - h, i]).concat([[0, lipMin]])
                       .sort((a, b) => a[0] - b[0]);
  const lipAt = (d) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [d0, i0] = pts[i], [d1, i1] = pts[i + 1];
      if (d >= d0 && d <= d1) return i0 + (i1 - i0) * ((d - d0) / ((d1 - d0) || 1));
    }
    return pts[pts.length - 1][1];
  };
  const RAMP = lipH - 2.6, IN_TOP = lipMin + CLR, IN_DEEP = 1.90 + CLR, SKIRT = 3.0;
  const lidAt = (d) => (d <= RAMP ? IN_TOP + (IN_DEEP - IN_TOP) * (d / RAMP) : IN_DEEP);
  let worst = Infinity, at = 0;
  for (let d = 0; d <= SKIRT + 1e-9; d += 0.05) {
    const gap = lidAt(d) - lipAt(d);
    if (gap < worst) { worst = gap; at = d; }
  }
  const ok = worst > 0.05;
  console.log(`  tightest clearance down the skirt      ` +
    (ok ? `${worst.toFixed(3)} mm at ${at.toFixed(2)} mm down`
        : `FOULS by ${(-worst).toFixed(3)} mm at ${at.toFixed(2)} mm down`));
  if (!ok) bad++;

  // and the skirt must stop before the lip's bottom taper, or it lands on the ramp
  const straightTo = lipH - 0.8;
  console.log(`  skirt stays in the lip's straight band  ` +
    (SKIRT <= straightTo ? `ok (${SKIRT} of ${straightTo.toFixed(2)} mm)`
                         : `TOO DEEP: ${SKIRT} past ${straightTo.toFixed(2)}`));
  if (SKIRT > straightTo) bad++;

  for (const [name, cfg] of [['every side', { u: 3, v: 5 }],
                             ['front left open', { u: 3, v: 5, lidSides: { f: false } }],
                             ['one cell', { u: 1, v: 1 }]]) {
    const L = lidPartOf(G, cfg);
    const m = G.checkManifold(L.polys);
    const expW = (cfg.u - 1) * 42 + 41.5;
    const wOk = Math.abs(L.meta.W - expW) < 0.02;
    console.log(`  lid, ${name.padEnd(32)}${m.bad === 0 && wOk ? 'watertight, right footprint' :
      (m.bad ? m.bad + ' BAD EDGES' : `FOOTPRINT ${L.meta.W} vs ${expW}`)}`);
    if (m.bad || !wOk) bad++;
  }

  /* A lid with every skirt unticked is the plate alone. It was reported as plate plus
     skirt, 4.2 mm, to the packer and to the download list, for a 1.2 mm part. */
  const flat = lidPartOf(G, { u: 1, v: 1, lidSides: { f: false, b: false, l: false, r: false } });
  const fm = G.checkManifold(flat.polys);
  let fz = 0;
  for (const p of flat.polys) for (const w of p.verts) fz = Math.max(fz, w[2]);
  const flatOk = fm.bad === 0 && Math.abs(flat.meta.totalH - fz) < 0.001;
  console.log(`  lid, ${'no skirt at all'.padEnd(32)}` + (flatOk
    ? `watertight, ${flat.meta.totalH.toFixed(1)} mm as built`
    : `says ${flat.meta.totalH.toFixed(1)} mm tall, built ${fz.toFixed(1)} mm` + (fm.bad ? `, ${fm.bad} BAD EDGES` : '')));
  if (!flatOk) bad++;
}

/* Every wall the page will let you type, not just the 1.2 everyone uses.
 *
 * From 2.70 mm up — the inset of the stacking lip's base — a rectangular bin leaked:
 * 256 edges used four times to 3 mm, 72 plus coplanar folds beyond. The lip's
 * underside chamfer runs from the wall thickness out to that base, and at a wall that
 * thick it had zero height, so the lip's bottom cap lay on the wall's top face. At
 * exactly 2.70 the wall's top inner edge is the lip's base corner as well, which is
 * why burying the cap alone did not close it.
 *
 * The range comes from the page's own field, so raising the cap there without the
 * geometry to back it fails here rather than in somebody's slicer. */
console.log('\nwalls across the whole range the page accepts');
{
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'src', 'bins', 'template.html'), 'utf8');
  const attr = (id, a) => {
    const m = tpl.match(new RegExp(`id="${id}"[^>]*\\b${a}="([^"]+)"`));
    return m ? Number(m[1]) : NaN;
  };
  const lo = attr('wall', 'min'), hi = attr('wall', 'max');
  if (!(lo > 0 && hi > lo)) {
    console.log(`  the wall field has no usable min/max (${lo}..${hi}) — the page would accept anything`);
    bad++;
  } else {
    const walls = [lo, 0.8, 1.2, 2, 2.6, 2.65, 2.69, 2.7, 2.71, 2.75, 3, 3.5, 4, 5, hi]
      .filter((w, i, a) => w >= lo && w <= hi && a.indexOf(w) === i);
    const SHAPES = [
      ['1x1x1', { u: 1, v: 1, hUnits: 1 }],
      ['1x1x3', { u: 1, v: 1, hUnits: 3 }],
      ['2x1x5', { u: 2, v: 1, hUnits: 5 }],
      ['3x2x4 everything', { u: 3, v: 2, hUnits: 4, divX: 2, divY: 1, scoop: 8, label: 12 }],
      ['2x2x3 railed', { u: 2, v: 2, hUnits: 3, divX: 1, divY: 1, divRemovable: true }],
      ['2x1x3 open front', { u: 2, v: 1, hUnits: 3, edges: { f: 0.5 } }],
      ['L-3x3', { u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) }],
    ];
    for (const [name, base] of SHAPES) {
      const fails = [];
      for (const wall of walls) {
        const r = buildBin(G, Object.assign({}, base, { wall }));
        const m = G.checkManifold(r.polys);
        const ori = checkOrientation(r.polys);
        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (const p of r.polys) for (const w of p.verts) {
          xmin = Math.min(xmin, w[0]); xmax = Math.max(xmax, w[0]);
          ymin = Math.min(ymin, w[1]); ymax = Math.max(ymax, w[1]);
        }
        const wOk = Math.abs(xmax - xmin - ((base.u - 1) * 42 + 41.5)) < 0.02 &&
                    Math.abs(ymax - ymin - ((base.v - 1) * 42 + 41.5)) < 0.02;
        if (m.bad || !ori.ok || !wOk)
          fails.push(`${wall}: ` + [m.bad ? `${m.bad} bad edges` : '', ori.ok ? '' : orientationNote(ori),
                                    wOk ? '' : `footprint ${(xmax - xmin).toFixed(2)}`].filter(Boolean).join(', '));
      }
      console.log(`  ${name.padEnd(18)} ${walls[0]}–${walls[walls.length - 1]} mm  ` +
                  (fails.length ? 'FAILED at ' + fails.join('; ') : `${walls.length} walls, all clean`));
      if (fails.length) bad++;
    }
  }
}

console.log(bad ? `\n${bad} case(s) FAILED` : '\nall cases clean');
process.exit(bad ? 1 : 0);
