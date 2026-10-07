# Geometry engine — rules before you touch anything

The geometry is a hand-rolled BSP CSG plus direct mesh construction. The CSG is
**numerically fragile in specific, well-mapped ways**. Several features were redesigned
around these constraints after catastrophic mesh corruption; the failure mode is not a
crash but silently broken output that only shows up as a bad print.

These rules were expensive to learn. Trust them.

---

## 1. What is safe

- **Direct mesh construction.** Build each region as an explicit watertight mesh: outline
  side quads, socket ring strips (triangles only), bridged annular faces via
  `triangulateRing`'s keyhole method, closed floors. This is the backbone. CSG never
  builds primary geometry.

- **CSG subtraction of small convex vertical prisms from a directly-built region** — the
  "box-minus-box class". Notch pockets, key recesses, magnet and screw cylinders, boss
  holes. This class is now genuinely safe rather than safe-by-reputation; see §2a for
  what was actually wrong with it and what the two standing rules are.

- **One cutter solid per subtraction.** A poly soup handed to `csgSubtract` must be a
  single non-self-overlapping solid. Two shells that overlap ask the tree whether a point
  inside both is in or out, and it has no answer.

  This has a degenerate form that is much harder to spot, because it hides inside a
  single shell: **a cutter outline that is not a simple polygon.** The puzzle notch's
  outline walked along the neck flank, overshot the point where the lobe circle crosses
  it, and came back along the same line — a spur of exactly zero area. Every measurement
  of the *shape* said it was fine: identical enclosed area to the last bit, identical
  bounding box. But `extrudePoly` gives that spur two side quads lying on top of each
  other facing opposite ways, so the extrusion is a shell that overlaps itself, and the
  tree has the same no-answer as before. It cost 30 edges used once and 40 used three
  times on a 9x9 plate for the life of the feature. If you write an outline that fuses a
  straight run into an arc, work out where they actually meet.

- **Overlapping closed shells instead of union.** Regions overlap by `BLOAT = 0.05`. Tabs,
  bosses, pocket cups, bin feet, lips and dividers are separate shells fused by the
  slicer. **Never CSG-union shells together.**

- ~~**`clipConvexPrismTop`**~~ — **deleted, and it is worth knowing why it was ever
  trusted.** It removed material inside a convex 2D polygon above a z-plane by sequential
  half-space splitting, with no BSP classification at all, and was therefore listed here
  as the escape hatch for a cut that must cross curved surfaces. It is safe in the sense
  that it cannot corrupt anything. It is also incapable of producing a closed mesh: it
  splits the surface by the prism's flanks and by the z-plane, throws away the fragments
  that are inside and above, and emits **nothing at all** in their place — no floor at the
  z-plane, no wall up the flanks. A plain box came back with 12 boundary edges, a cell
  region with 52, a 9x9 top-insert plate with between 1620 and 7308. Every top-insert
  configuration the tool ships was open for the life of the feature because of it, and the
  pocket cup was expected to close the hole while being a separate shell 0.05 mm away.
  A removal that does not close what it opens is not a cutting tool. Subtract a closed
  prism; see §2 for what that costs near the cones, which is nothing.

- **Coincidence-breaking jitter** (`J = 0.0017` on cutter positions), and keeping cutter
  faces off exactly-coplanar planes.

## 2a. What was actually wrong with the CSG

Read this before you believe anything in §2 about cones. For most of the project's life
`csgSubtract` was lossy for **every** cutter shape — a watertight box minus a watertight
prism came back with boundary edges for an interior hole, a blind pocket, an edge notch
and a corner bite alike. Four things were wrong. They are listed **in order of how much
they actually mattered**, which is not the order they were found in, and the ordering is
from ablation rather than from the story that felt right at the time: each fix was
reverted on its own and `test/plate-audit.js` re-run against it.

1. **T-junctions and micron slivers — the decisive one.** A split plane halves every
   polygon it crosses but passes a polygon it only grazes straight through, leaving a
   vertex in the middle of a neighbour's edge. Geometrically sealed, combinatorially
   open, and a slicer counts edges rather than area. Separately, where two cutter planes
   cross a face at a shallow angle they carve the same corner twice a couple of microns
   apart. `healCsgSeams` repairs both on the way out of every `csgSubtract` and
   `csgUnion`. **Disable it and everything else in this list stops mattering:** magnets
   3207 bad edges, screws 8389, dovetail 671, and all four minimum CSG cases fail. It is
   not optional decoration; a change that bypasses it puts the holes straight back.

2. **Overlapping cutters in one soup.** The screw shank runs up the middle of its own
   counterbore and shares its bottom cap; the counterbore in turn sits inside the magnet
   pocket. Concatenated into one "solid" that was 14304 bad edges on a 3x3 plate — and,
   worse than an edge count, the shank wall stood *inside* the counterbore cavity as real
   material: 486 mm³ of it on a 3x3 plate, exactly 13.5 mm³ × 36 sites, 13.5 being the
   12-gon shank over the 2 mm counterbore depth. Union them into one solid first
   (`fastenerCutter`) or batch them so no two shells in a call overlap. Reverting just
   this leaves screws at 740 bad edges with the repair still in place. Unioning
   **cutters** is fine; the ban in §1 is on unioning parts of the model.

3. **The rim cap was inside out — real, but minor for watertightness.** `annulusStrip`
   pairs a 4-corner cell outline against a `4*arcSegs` socket ring by sweeping angle.
   With four outer vertices the sweep parks on one corner and fans across a quarter of
   the ring, and a fan from a point outside a convex loop only stays inside the annulus
   as far as that point's **tangent** to the loop. Past the tangent the triangle turns
   over. **21% of every cell rim faced downwards at the shipped arcSegs 6, rising to 33%
   at 24.** Watertightness cannot see it, and neither can enclosed volume, and neither
   can a directed-edge check. All three are measured against the reverted fix in §5a; the
   only thing that catches it is a fold test, and that is now in the audit.

   Be careful about what this cost. It is tempting — I did it — to call this the root
   cause on the grounds that `csgSubtract` builds its BSP from these very planes, so a
   wrong-facing plane makes the tree answer "outside" for solid material millimetres
   away. Measured, it is worth 6–17%: applying only this fix to the old code takes
   magnets 7480 → 6947, screws 14304 → 13483, dovetail 4338 → 3605. Reverting only this
   fix from the current code leaves dovetail at 118, hclip at 40 and magnets+screws at 8,
   everything else — the puzzle joint included — still watertight. (An earlier version of
   this paragraph said "everything else watertight" and put the puzzle at 62. The hclip
   40 was there all along and went unread; the puzzle number was real but is now moot,
   since that case no longer leaks under the ablation or without it.) Fix it because an
   inside-out triangle is wrong on its own terms, not because it was the bug.

4. **The result was read out of the solid's own tree — an optimisation, and untested.**
   Textbook csg.js returns `a.allPolygons()`, but `a`'s tree was built by splitting `a`'s
   polygons against each other. A cell region carries ~300 socket-surface triangles whose
   planes graze the top annulus at thousandths of a degree, and partitioning the annulus
   by all of them shreds it: `csgSubtract(region, [])` — subtracting *nothing* — took a
   region from 394 polygons to 1524 and opened 481 bad edges. `csgSubtract` now keeps the
   original `a` polygons and puts them through `b`'s tree only.

   **This buys no watertightness at all.** Restore the textbook version with
   `healCsgSeams` still in place and every case in the audit still passes; the only
   difference is polygon count, 45332 → 29242 on the 3x3 screws case, a 35% saving. Treat
   it as a performance change. **Nothing in the audit would catch its reversion**, so if
   you are debugging something and want the textbook form back, you may have it — but
   check the polygon count before you decide the change was free.

## 2. What destroys meshes

All empirically confirmed, all from real corruption:

- **Any BSP cut that intersects the conical socket surfaces** (bottom chamfer z 0–0.7, top
  rim cone z 2.5–4.25). Symptom: cells progressively lose walls and rims with height;
  slices come back with ~25% open paths. This killed full-height dovetail notches,
  through-slot H-clips (three attempts), and generic top pockets via CSG.

  **One of those three has now been retested, and the rule did not hold.** The generic top
  pocket is a convex prism from below the pocket floor up past the plate top — it spans
  the whole rim cone band — and a cell region minus that prism comes back watertight,
  correctly wound, fold-free and at the right volume at arcSegs 6, 12 and 24. It is the
  box-minus-box class of §1 and it behaves like it. Every top-inserted key housing is
  built that way now.

  What is left of the rule is a warning rather than a ban. The failures it was written
  from all happened while `csgSubtract` was leaving T-junctions in everything it touched
  and the rim above the cones carried inverted triangles (§2a), and neither is true any
  more. The cone facets are still near-tangent to one another, so a cutter with its own
  near-tangent facets — the puzzle key's lobe is the one in this file — still dices the
  crossing into micron slivers, and some of those come back as coplanar folds. If you take
  a cut through the cones, measure it; do not assume either that it will fail or that it
  will pass.
- **Extruding non-planar quads on cones.** Corner-arc faces are conical — a quad spanning
  one is non-planar. **Emit triangles.** The same applies anywhere a face's four corners
  do not share a plane, such as a wall top whose height varies along its length.
- **Complex concave outline extrusions** minus large curved cutters. An L-shaped plate
  outline is exactly this — see the note on reflex corners below.
- **Cutters poking below z = 0** leave inverted fragments. `clampZ(polys, 0)` on
  `buildPiece` output is mandatory and already in place.
- **Wrong outline winding into `extrudePoly`** produces inside-out shells. Normalise CCW.
- **A helper that emits faces in a frame the caller chose cannot assume the frame is
  right-handed.** `profilePrism` normalises its profile to CCW in (u, z) and then emits
  sides and caps as though (u, z, v) were right-handed. The bins' scoop and label pass
  `(u, v) => [v, u]`, which is, and are fine. `snapTopClip` passes the identity, which is
  its mirror — so every face of the printed U-clip came out reversed. Watertight, zero
  bad edges, −8.84 mm³ of enclosed volume, for the life of the feature.
  `snapTopPocket`'s barb wedge had the same fault from the other end: its `map` is
  right-handed on the `-x` and `+y` seams and mirrored on `+x` and `-y`, and the wedge's
  five faces were written out by hand for one of the two, so half the sites on every
  top-snap plate carried an inside-out lip. Both now measure the frame — the sign of
  `e_v × e_u` from three probes of the mapping — and reverse to suit. **Anything that
  hands vertices to `makePoly` in an order fixed at authoring time has this waiting in
  it**, and nothing in either audit could see it until `test/orientation.js`.
- **An outline that doubles back on itself**, even by a fraction of a millimetre with no
  area between the two passes. See the note under §1 on the puzzle notch. A *reflex*
  outline is fine — that one was blamed for years and it was never the problem — but a
  non-simple one is a self-overlapping cutter wearing a disguise.

Three related traps in the supporting code:

- `clipToRect` is textbook Sutherland–Hodgman with **no concave handling**.
- `earTriangulate` fails **silently** on malformed input — it breaks out of its loop and
  returns a partial triangulation rather than throwing.

  The version of this that is hard to spot is a call that fails silently for years and is
  then *rescued* by an input it can make progress on. `directCellRegion` kept a vestigial
  second underside — a `triangulateRing` keyhole cap over the annulus `annulusStrip`
  already covers — and on every plate the tool has ever shipped it returned **zero**
  triangles, because a four-corner outline keyholed against the socket ring is precisely
  what the ear clipper gives up on. Nothing was wrong, visibly. Hand it an outline with a
  rounded corner and it makes partial progress instead: 37 triangles where the annulus
  needs 68, laid on top of the cap that was already there. 47 boundary edges, and the only
  caller that passed a rounded outline was the test tile, which is a shipped download.
  **A call whose correctness depends on the ear clipper continuing to fail is not
  correct.**
- **A polygon whose vertices have drifted off its stored plane will hang `BspNode.build`.**
  The build takes its splitting plane from one of the polygons it is sorting; if that
  polygon's own vertices no longer classify as coplanar, nothing lands in the node, every
  polygon goes to the same child, and the child makes the same choice forever. It grows a
  tree until the heap dies.

  `splitPolygon` now treats a polygon carrying that exact plane as coplanar whatever its
  vertices say, which makes progress unconditional. That guard is not belt-and-braces:
  **`healCsgSeams` deliberately breaks the plane/vertex agreement**, because a repaired
  polygon keeps its parent's plane while its vertices may have moved by up to `VTOL`, and
  the sub-triangles of a centroid fan inherit that plane rather than deriving one from
  three nearly-collinear points. So drift is a normal condition here, not a bug, and the
  shortcut is what makes it survivable.

  Everywhere else, keep planes and vertices together. `transformPolys` does **not**: it
  is for export, where nothing reads a plane. Use `movePolys` for anything a BSP sees.

## 3. The derived design law

> **Every cut is shaped so it stays inside a safe zone.**

The safe zones are: the wall vertical band (lateral ±2.15 from the wall centreline,
z 0.7–2.5), a solid floor pad below all ring geometry, and z ≤ ~2.4 ceilings.

Where a feature must cross the rim, it is built as a clip plus directly-constructed
liners and boxes — never CSG. If you add a joint type, obey this or you will rediscover
the failure modes expensively.

**Corollary for non-rectangular plates:** force a split at every reflex corner so every
*piece* stays a convex rounded rectangle. The concave outline then never gets extruded as
a single shell, and the failure mode is structurally out of reach rather than merely
avoided by care.

## 4. The bins engine

`src/bins/bin.js` contains **no CSG at all**, deliberately. Everything is direct
construction plus overlapping shells, so none of §2 is reachable. Keep it that way:

- Features that look like subtractions can be **added** instead. A scoop is an added
  prism, not a curved cutter. A label tab is an added prism, not a cut.
- Magnet pockets and screw holes in the feet are **built, not cut**, which keeps the rule
  above without needing an exception to it. A holed foot is the plain foot made of pieces
  that leave the holes empty (`holedCell`): left and right bands, the foot's own rings
  clipped by a vertical line inside the 17.00 arc centre and swept up the spec profile
  exactly as a plain foot is, so they carry the cone faces triangle for triangle; front
  and back bands clipped the same way across y and held 2 BLOAT past the side bands' line
  so the two never share an arc face; two boxes crossing the middle; and one column per
  site, a stack of tubes from `wallRing` whose outer square and inner hole are sampled on
  the same rays from the site's centre, so they pair index for index and never reach
  `earTriangulate`'s keyhole path. A site with no hole is a plain box. Every hole sits
  inside the narrowest part of the foot, so no piece touches a cone, and the audit slices
  a holed foot against a plain one to four decimals to prove the outside did not move.
  A screw over a magnet is three openings stacked, each inside the one below — the pocket,
  a slot across its flats, a square across the slot, then the round hole — so where two
  tubes overlap by BLOAT the opening left is the smaller one and nothing fills. The screw
  runs up past the foot, so with screws the slab from 4.70 to 6.05 is split per cell the
  same way in all three bodies (rectangle, solid, carved) and the floor grows to 1.85.
  The audit probes every site of every holed build from the bed: the hole's roof has to be
  where it was asked for, and an unholed site has to be solid, because a foot with its
  holes left solid is just as watertight as one with them open.
- A **half-size bin** (0.5, 1.5, 2.5 cells on either axis) stands on **quarter feet** in
  both axes (`binFeet`): the same sweep as a whole foot on rings 10.5 mm in on every side,
  keeping each level's corner radius, so its corner arcs stay on the 17.00 centres and it
  seats in a corner of a standard socket with a whole foot's clearance (`fit-check.js`
  measures it from the spec). Nothing else changes: the body, lip, lid, dividers, scoop
  and label already came from an outline that takes any size. A whole bin keeps whole
  feet, built in the same order from the same numbers, so it is byte for byte what it
  was, and `bin-audit.js` holds a dozen links from before half sizes to their STL
  digests to keep it so. A half-size bin builds **no holes** (`feetHolesOff`): a plate's
  magnet is 2.5 mm off a quarter's centre towards that socket corner, so which way a
  hole would have to go depends on where the bin sits. The audit slices every quarter
  against the spec and probes the line between quarters from the bed, because a
  half-size bin on whole feet is just as watertight and the body sets its footprint.
- Every rounded square in a bin shares the corner-arc centre **17.00 mm**
  (`41.5/2 − 3.75`). That constant is what makes clearance uniform around the perimeter
  instead of binding at the corners. See [socket-clearance.md](socket-clearance.md) for
  what happens when two mating profiles disagree about it.
- All rings in one bin must share a vertex count so the skins stitch. `SSEG` is a
  constant, not a parameter, for exactly this reason.

## 5. Verifying a change

Manifold checks read **zero** for everything the audit does not name. The old advice here
— judge against a ~20% bad-edge baseline, because overlapping shells are the deliberate
construction — was wrong twice over. Overlapping shells do not produce bad edges: each
shell is closed on its own, so every edge is still used exactly twice. The 20% was holes,
and treating it as normal is what let them stay for the life of the project.

Three configurations still leak, all of them corner bosses that abut, and they are
**quarantined by name in `test/plate-audit.js` rather than excused here**, so the summary
line cannot say "watertight" over them. Do not generalise from them to a new tolerance
for nonzero counts; the whole point of naming them is that the number for everything else
is zero.

**A configuration with no case is worse than one with a quarantined case**, and this file
had four of them. `keyInsert: 'top'` had never been built by the audit in any of its
housings, and all four were open — 3536 bad edges on the H-clip, 7796 on the puzzle key,
overwhelmingly use-count 1. See §1 on `clipConvexPrismTop` for why. Worse, three cases
that *looked* like coverage were not: `9x9 bowtie`, `9x9 puzzlekey` and `9x9 snap` built
the same bowtie plate three times, because the key's shape comes from `cfg.keyType` and
only the page ever kept that in step with `cfg.connector`. The puzzle key had never been
built at all, and had been leaking 14 edges a plate throughout. When you add a case, check
what it builds, not whether it passes.

Read the edge-use histogram the audit prints before deciding what a leak is, because two
very different bugs both show up as "bad edges":

| use count | meaning |
|---|---|
| **1 or any odd** | open boundary — a hole, always a real defect |
| **4, 6, even** | two or three shells meeting face to face — no hole |

`baseMode: 'bosses'` is entirely the second kind: corner bosses of adjacent cells abut on
the cell boundary instead of overlapping by `BLOAT`, so every shared face is counted
twice, and no edge is ever used once. Bloating the bosses would fix it, at the cost of
changing their footprint. Far better than it was (2964 and 8332), still not fixed.

`connector: 'puzzle'` used to be listed here as the first kind, and it is **no longer
open anywhere**. It is worth reading how, because it needed two unrelated fixes and the
lesson generalises: **an even count and an odd count on the same case are two separate
bugs, and clearing one tells you nothing about the other.**

- The holes — 30 edges used once, 40 used three times — were the cutter's outline
  doubling back on itself; see §1. The reflex outline it had been blamed on for years was
  never the problem.
- What that left was 24 edges used four times: cancelling slivers on the notch's cavity
  ceiling where it runs under the socket's corner arc. Those were repaired in
  `healCsgSeams` rather than in the shape. The arc's facet planes are near-tangent to one
  another, so `a`'s tree dices the ceiling into micron slivers and the weld folds a
  couple of them into spurs — a face that is real surface everywhere except for one
  out-and-back excursion, which no single-face test could see.

What was quarantined after that was **`connector: 'puzzle'` at every smoothness**, and it
was the second kind: exactly one edge per notch, always used 4, never once. The lobe's far
pole points along the seam, the boundary between two cell regions runs along that same
line, and both regions cut the same notch — so both carried the apex vertex and the
vertical edge either side of it. Two closed shells sharing an edge, the bosses bug in
miniature.

**"12 and 24 carry none" was in this paragraph and it was wrong**, and the way it was wrong
is worth more than the number. At those smoothnesses the two regions happened to subdivide
their copies of the apex edge at different heights, so the four uses landed on two
different edges and the count read zero. Changing the floor cap of a padded cell from an
ear clip to a fan — a change with no connection to the joint at all — made the two agree,
and the defect appeared at 12 too, at exactly twice the size (the edge is split in half
there, so 14 rather than 7). It was called "deterministic, not luck" on the strength of a
sweep over four smoothnesses and six drawer sizes, and the sweep was measuring a
coincidence that held across all of them. **An edge count that depends on two shells
disagreeing about where to put a vertex is not evidence of anything.** Moving a margin's
cut, which has nothing to do with the joint either, later flipped three clean puzzle
pieces into leaking ones the same way.

It stayed quarantined for a while because every fix to the **notch** costs joint geometry.
Sliding the joint 0.09 mm along the seam gets the apex out of the overlap band and lands
the lobe on the socket's flat wall at x = 2.15 instead, opening five real boundary edges.
Reshaping the lobe so no vertex sits at the pole changes the notch's reach, and the audit
asserts that reach to 1e-9 against the tab it mates with. **The fix was to move the region,
not the notch**: `buildPiece` starts the region past the pole half a BLOAT beyond it rather
than a BLOAT short, so the pole is inside one region only. The two regions still overlap,
from that edge to the neighbour's, and the notch is the same notch. The three puzzle cases
are out of quarantine, and the audit has a puzzle plate with four different margins by a
4 mm corner as a case of its own.

The puzzle **key** had the identical defect from the identical cause — 14 edges a plate on
every floor mount — and it is fixed rather than quarantined, which is the difference
between a cutter that shapes a pocket and one that shapes a mating face. `keyHalf` now
cuts the lobe into an **odd** number of segments so no vertex lands on the pole, and
inflates the arc by `1/cos(Δ/2)` so the facet that spans the pole still reaches the
nominal radius. The pocket comes out the same size to the micron and up to 26 µm looser
elsewhere, which is the harmless direction. A notch that a printed tab has to enter has no
such slack. If you take the notch on, the rule to aim at is the one the dovetail obeys by
accident, and that the notch now obeys by having the boundary moved:
**a cutter straddling a region boundary must cross it with a face, not a vertex.**

Run the headless audits:

```bash
node test/plate-audit.js
```

```bash
node test/bin-audit.js
```

```bash
node test/fit-check.js
```

`plate-audit.js` builds **every piece** of a split plate, not just the first — an earlier
version checked `pieces[0]` and passed while measuring a piece that had no notches at
all. It also asserts **enclosed volume** on the minimum CSG and union cases, and that
matters more than it looks: `healCsgSeams` optimises connectivity directly, so
"watertight" is a metric it can satisfy by construction. Volume is the independent one,
and it is what showed that the screw counterbore had never really been cut.

It also measures the **puzzle joint off the built mesh** — the throat, the reach and the
lobe of the cavity against the same three on the tab. That is there because the fix for
the notch's holes was a change to the notch's outline, and a change to a cutter's outline
is one edit away from a change to the fit. Nothing else in the file would notice: a joint
0.3 mm slacker is exactly as watertight and prints exactly as well, right up to the point
where the pieces will not hold together. If you touch `puzzleShape`, that section is what
tells you whether you touched the joint as well as the mesh.

Two of its sections exist to catch a defect that has no mesh symptom at all:

- **The housing has to be built, not merely closed.** A top-insert plate with the pocket
  never cut and the cup never added is watertight, correctly wound and passes everything
  else. So the audit drops a vertical probe down the middle of the first key site on each
  piece and requires the highest surface over that point to be the pocket floor rather than
  the plate's top face, and requires the piece to have gained shells against the same plate
  switched to bottom insert. Reading it as an area does not work: the clip pocket's walls
  come up flush with the plate top and hand back almost exactly the area its cavity took.
- **A parameter has to reach something.** Every cfg the cases hand to `core.js` goes in
  through a Proxy that records which keys were read, and the union has to cover `DEFAULTS`.
  `cfg.outerRadius` and `cfg.cornerRadii` were dead for the life of the project — tested
  against `piece.col` and `layout.cols`, which `computeLayout` has never produced, so every
  corner flag was `undefined === 0` and no exported plate ever had a rounded corner, while
  the page offered a control for each of the four. `DEFAULTS.bowtie` was dead too, copied
  into state on every clearance change and read by nothing. Neither could fail a test,
  because a dead parameter breaks nothing. This is the assertion that a dead one breaks.
  It proves less than it sounds — a key read and thrown away still counts — but it is
  precisely the failure that got past everything else.

## 5a. Orientation is a separate question, and it needs three checks

`checkManifold` counts how many triangles touch an edge. That number is blind to which
way any of them faces, so a mesh can be watertight, report zero bad edges, and still be
wrong. It let two defects ship. `annulusStrip` capped every cell rim with a fifth of its
triangles facing downwards for the life of the project (§2a.3). `snapTopClip` — a part a
user prints and presses into a joint — was inside out from the day it was written, at
−8.84 mm³ (§2).

`test/orientation.js` runs three tests, used by both audits. They are genuinely
independent; **none of them implies another**, and it is worth knowing which one bites,
because they call for different fixes.

| test | catches | misses |
|---|---|---|
| **signed volume, per closed shell** | a shell built entirely backwards — `snapTopClip`, the carved bins' reflex fillet | anything where the flipped area is a fraction of one shell; anything planar |
| **directed-edge balance** — every edge traversed as often one way as the other | a patch whose winding disagrees with its neighbours' | a *wholly* inverted shell (reverse every triangle and every edge is still balanced); `annulusStrip` |
| **coplanar folds** — two triangles on a two-manifold edge, same plane, opposite normals | a surface doubling back on itself — `annulusStrip`, CSG sliver spurs | nothing else; it is narrow on purpose |

The middle row is the one to be careful about. It is the textbook orientation test and it
is easy to assume it covers the rim cap. **It does not.** Reverting the `annulusStrip`
fix and measuring: signed volume `1340.010167086673` at arcSegs 6, identical to fifteen
digits with the fix in place, and zero directed-edge imbalance, at every smoothness. Both
are blind for the same underlying reason — the strip is a *combinatorially valid*
triangulation that folds back on itself in space, and the cap is planar, so Green's
theorem telescopes the signed areas to outline-minus-ring whatever the orientations. This
is the same trap that killed the deleted rim-cap assertion further down this section.
Only the fold count moves: 12 at arcSegs 6, 12 at 24.

Two things the checks must **not** treat as defects, and do not:

- **Volume on an open shell is meaningless.** The divergence theorem needs a closed
  surface; on an open one the tetrahedra do not cancel and the number is arbitrary. A
  top-insert hclip pocket reads −359 mm³ inside a 27 mm³ bounding box. Volume is asserted
  only on shells every edge of which is used an even number of times.
- **Abutting shells are not inverted shells.** `baseMode: 'bosses'` puts two
  correctly-wound shells face to face, as the puzzle lobe apex used to put them edge to edge.
  Their shared edges come out balanced 2 and 2, and the fold test only looks at edges used
  by exactly two triangles, so it never sees them. Measured clean on every quarantined
  case.

Two orientation defects are quarantined by name rather than fixed, on the same terms as
the leaks. The plate audit holds its one to its size on file, piece by piece, so a
quarantine for a few folds cannot wave through more:

- **The carved bins' reflex fillet**, in `test/bin-audit.js`. One inside-out closed shell
  of 212 triangles per reflex corner, −214.259 mm³ (−282.322 on the taller `bigL-5x4`), so
  every L, U, T, staircase and notched footprint carries at least one. It is a sign error
  in `sweptSector`: that helper builds an annular sector as `outer` CCW then `inner`
  reversed, which only traces anticlockwise while `outer` is the larger radius. Convex
  corners pass `[CR, CR - t]` and are right; the reflex fillet passes `[CR, CR + t + OVER]`
  and reverses the loop, with nothing downstream renormalising it.
- **The top-inserted wall cup for the puzzle key**, in `test/plate-audit.js`. 12 coplanar
  slivers of about 1e-4 mm² on 3 of the 4 pieces at arcSegs 12 (14 before dented faces
  were fanned from a point that sees them, below), and **none at the arcSegs 6 the tool
  ships**. It is the only key housing whose cutter crosses the socket's *corner*
  cone: a key site is where four cells meet, the wall mount puts the pocket in the rim
  rather than in a floor pad, and top insert runs the cutter from below the pocket floor up
  past the plate top. A lobe arc and a cone arc then cross at a shallow angle, and both are
  made of near-tangent facets. Sensitive enough to be worth a warning: over segment counts
  17/19/21/25/33 the same plate ranges from 0 folds to 89, with no monotonicity, which is
  what a sliver lottery looks like from the outside.

  The puzzle fit sample used to be quarantined here for six slivers of 5.2e-5 to 5.5e-4 mm²
  on two of its four tiles, and it is clean now. The honest account is that the coupon's
  tiles went from 8 mm deep to 10 — because a top-insert cup's wall needs the room — and
  the cutter's planes now graze the tile's corner arc somewhere else. Nothing in
  `csgSubtract` changed. If it comes back, that is what it is.

One kind of fold is fixed rather than quarantined. Where `healCsgSeams` welds a vertex
onto its group it can land a thousandth or two across the line of its neighbours, and the
face it mends comes out with a dent too small to see. Fanned from its first corner, or
from its average, one sliver of the fan turns against the face: three coplanar folds by a
puzzle notch, in the bottom face beside a mounting pocket, or in the side of a puzzle
tab. Such a face is now fanned from the first point whose fan turns nothing back (its
average, then each of its corners, skipping a corner that would lay a triangle of no
area along a straight run), and failing all of them is cut into ears in its own plane.
Only a face whose fan would have folded is touched, so every plate without one is the
same bytes as before.
Over 960 designs of eight joints (five pitches, four clearances, rows and quads, three
corner radii) main has 528 folds on 134 pieces and this has none; over 1,200 random
puzzle designs, 2 pieces of 4,686 fold, one fold each, as they do on main.

A warning about writing checks for this file. The rim-cap check originally asserted two
things and claimed they were complementary: no triangle inverted, and the signed areas
summing to outline minus ring. The second cannot fail. For **any** complete pairing of
the two loops the interior spokes cancel and the sum telescopes to that value by Green's
theorem, whatever the orientations — it passed at 1e-13 on the fully broken code at every
smoothness. A check that cannot fail on the bug its own comment describes is worse than
none, because it stops anyone looking. It is now a triangle count instead. This project
has shipped three tests that passed while measuring nothing; do not make it four.

`bin-audit.js` checks footprint and height against the published spec, `zmin ≥ 0`, and
slices the real mesh at five heights to compare flat half-width *and* corner reach.
`fit-check.js` measures bin-to-socket clearance, deriving the bin from the published spec
only — **never from `src/core.js`**. Keep that independence: deriving the reference from
our own geometry would make any shared error invisible.

Other standard audits, from the original development (they need `trimesh`, which is not
currently installed):

- **Socket count** — section at z = 3.5 (or ztop − 0.7 with pad), count closed loops with
  both spans in **36–41.5 mm**. Looser windows false-positive on 42.1 mm cell rectangles.
- **Open-path count** — `sec.to_2D()`, count `not e.closed` across ~10 z levels. Baselines:
  dovetail / puzzle / snap-floor / bowtie-floor **0**; hclip-bottom ~22; wall keys ~36;
  puzzlekey ~46; top-insert cup ~100.
- **Occupancy probes** — matplotlib `Path` even-odd on section loops. Known traps:
  parity **lies** wherever shells intentionally overlap, so probe only single-shell
  locations; `trimesh`'s `discrete` silently drops unclosed loops, so regions near
  intended openings render empty; and never slice exactly on a coincident plane — offset
  by 0.03–0.13.
- Every config: assert `zmin ≥ −0.001` and `zmax ≤ H + 0.05`.

## 6. Things that are not what they look like

- **`arcSegs` is a fit parameter, not a rendering knob.** At 6 segments the inscribed
  polygon's sagitta on r = 4 is ~0.034 mm. Raising it to smooth the preview loosens the
  physical fit against third-party bins. Measured contribution to corner clearance:
  0.014 mm.
- **Raw mesh volume is not filament.** The overlapping-shell construction double-counts,
  and slicers infill anything thick. Estimate analytically from parameters: thin features
  at full density, thick blocks as shell + infill × core.
- **The socket's corner clearance is not uniform.** Known, documented, deliberately not
  fixed — see [socket-clearance.md](socket-clearance.md).
- **The plate's outer corner radius has a ceiling, and it is the socket's.** Both the
  plate's corner and the socket's are rounded squares about the same corner, so the arc
  eats towards the rim as it grows: on the stock profile they meet at about 5.0 mm and
  `buildPiece` caps at **4.88**, leaving 0.2 mm of rim. It is not a safety margin invented
  for tidiness — at 6 mm a screwed plate opens 1168 boundary edges, which is the arc having
  cut away the very rim the mounting cutter still has to pass through. Past the cap the
  corner cell has nothing left to hold a bin down; a drawer with a rounder corner than that
  wants a margin, not a rounder plate. The old cap was half a cell, which is a number with
  nothing behind it.
- **`clipToRect` and `earTriangulate` never see the outer corner arc on a plain plate.**
  Everything they are handed there is a four-cornered rectangle, which is why two separate
  latent defects — the vestigial `triangulateRing` underside, and the ear clip's chords
  skimming the mounting cylinders — only surfaced once the radii were connected. If you
  change what the outline is made of, re-run the audit with magnets *and* screws on: they
  are the cases with cutters close enough to a cap's triangulation to feel it. The fan
  that replaced the ear clip felt it too, more rarely: a spoke a few thousandths from a
  corner of a cutter's wall is crossed by the two sides meeting there a couple of
  thousandths apart, `healCsgSeams` welds the two crossings, and the sliver of floor
  between them and the corner goes. One cell with magnets from below was quarantined for
  that until `fanCentre` moved the fan off any spoke so close. That is not the only way
  in: two of a cutter's sides, carried across the cell as planes by the BSP, can cross a
  spoke 0.031 mm apart, or a weld on the pocket's ceiling can land a hair past
  `healCsgSeams`' tolerance, and the same sliver goes. So `healCsgSeams` says when its
  result is still open (`.open` on what it returns), and `buildPiece` cuts that cell's
  pockets again: the cutters in the other order, the cell's faces in the other order,
  both, and then the cutters turned a 28th of a turn. A cell that closes first time,
  nearly every one, is built exactly as before. Over 3,893 random mount designs (magnets,
  screws or both, from below or above, 42 or 50 mm, one to three cells each way, random
  margins and corners) none is left open, where main leaves 30.
