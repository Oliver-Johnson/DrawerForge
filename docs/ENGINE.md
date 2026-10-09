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
- **Holes across the floor** for what goes in a bin (AA, AAA and 18650 cells, hex bits)
  are built the same way, not cut. The block they are in is one convex **tile** per hole:
  the hole's share of the cavity, a BLOAT past halfway to each neighbour and a BLOAT into
  the wall, closed round its hole by `wallRing` from two loops sampled on the same rays
  from the hole's centre (`holeTiles`). The cavity outline a tile is clipped by carries
  points on its corner arcs only. With roundRect's straight-run points in it, a point
  fell in the strip two tiles share, both tiles carried it, and every case in the audit
  read 2 to 4 edges used four times. The audit probes every hole's centre down to the
  floor and the block beside the first one, so a block with its holes left solid, or no
  block, fails there however watertight it is.
- **Finger slots** in the top of a wall are not cut either: they are built the way a
  lowered wall is (`fingerSlots`). Each slot's profile points go into the shared split
  lists of the wall's straights, so the outer and inner rings still pair index for index,
  and the top of the wall is lowered at those points after `edgeHeights` has set it. The
  profile is the slot on the wall's inner face, where a finger goes: sides at 70 degrees,
  under the 75 the audit holds every wall's top edge to. Both rings take the same
  fractions of their straights, and past a 3.35 mm wall the outer straight is the longer,
  so on the outer face the slot is that much wider and less steep; up to 3.35 mm the
  rings share their corners' centres and the slot is worked out as it always was. A slot
  takes the lip as a lowered wall does. There is one per compartment, between the
  dividers as built (`dividersBuilt`, none on a bin with holes), clear of a removable
  one's rails and the gap between them. A slot on the back takes the label shelf's place.
  A slot on the front holds the scoop under its bottom. The slots stop over the block of
  holes across the floor. With a back slot those holes are laid out as with no shelf
  (`floorPlan` asked with no label) when that builds the back slot, a slot in every other
  wall the shelf's layout puts one in (wall by wall, not slot by slot: a wall left with
  fewer counts as kept), and no fewer holes (past `HOLES_MAX` it builds none). Otherwise
  they keep where they are with the shelf (`holesGaveWay`, which says why), and the slots
  are whatever builds over them, as before: if the block is too high for the back one
  even then, the shelf stays. Either way it is one more `floorPlan`, not a loop.
  With removable plates the front and back walls are settled first, on their own
  (`fingerWall`): only the dividers across meet them, and those are counted without the
  ones along. So `plateLayout` cuts the plates across to the scoop a front slot holds,
  the smaller of that and the plates' own cap, stands the plates along on it and counts
  them on it, and `railedLimit` keeps no plates along in front of a shelf a back slot
  takes away, notches and all. With holes across the floor there are no dividers, so the
  whole plan is settled at once, over the holes as built, and the wall is the one built
  over them, or none; `floorPlan` works out a bin without its dividers with none given,
  so that does not ask itself. Not quite always: with a back slot over a shelf, whether
  the holes take the shelf's room can turn on whether the dividers they would leave
  allow a slot in another wall, mostly a lowered front, which a plan settled without any
  does not know, so on a few such bins it finds the shelf kept and no holes where the
  bin is built with them. That only moves the field for plates along, on a bin built
  with none, and as it was before. Whether a bin has any slot at all is settled between
  the dividers it counts, and a slotted bin builds no lip, so no notches:
  `dividersBuilt` counts the plates with the lip's rule and without it, and takes the
  count without it where a slot is still built between those plates (settled with them,
  `fingerSlotPlan` given the count), and otherwise keeps the lip and its count. Counted
  so, the bin is marked `lipTaken`. In the engine only `lipNotched` reads it, which
  drops the lip's rule and its corners for that bin wherever they are asked: in the
  count, and in the reasons Checks gives, as `dividersWhy` asks `railedLimit` and
  `plateLayout` of the marked bin. On the page `setDividerLimit` reads it as well, and
  holds the field for the plates across to `dividersBuilt`'s count, as the one along
  always is, since more plates across can leave no slot and bring the lip back. The bin
  keeps its lip as asked for all else, and above all for its holes, which are laid out
  clear of the lip before the slots are settled over them. Asked as a bin with `lip`
  false, its holes had room it does not give them, and a row that is not built held its
  back wall too low for a slot. Checks and the fields go by the bin counted without its
  lip then (`countedAs`), so neither names a lip it does not have, and each field is
  held with the count the other asks for, as a plate along can close a side slot and a
  plate across a front one.
  The lip's rule only binds on plates packed a few millimetres apart, with no room for a
  slot between them, so the walls their ends meet have no slot either way, and the slots
  in the others stay where they were, as do the rails beside them. So a bin with a slot
  between the plates its lip allows has one between the plates without its lip as well,
  and is built with those: Checks never has a slot to blame for fewer plates.
  `fingerSlots` hands its answer to `buildBin` and `insertPlan` (`floor`), so the page
  counts the holes that are built, and to `binVolume`, which weighs the bin from it: no
  lip, the dips (`area`, the mean of the wall's two faces, times the wall) off the walls,
  the shelf left off with a back slot, and the holes where the plan has them. The scoop
  both build and weigh is `scoopBuilt`'s, which holds it under a front slot. A bin with
  no slots built gets the same split lists and holes it always had, so it is byte for
  byte what it was, and weighs what it did. The audit reads every slot's bottom and sides
  off both faces of the mesh, and weighs slotted bins against what their meshes enclose.
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

Four configurations still leak: three of them corner bosses that abut, and one that only
the engine can build, mounting sites moved in close at a small pitch, whose pockets come
out open by a few slivers as they do on main (it is there for the retry that throws; see
the mounting pockets below). They are
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

Corner bosses are built only on an open underside (`cornerBosses`). A floor under the
sockets, a key housed in the floor (2.8 mm), the puzzle's lobes (2.6) or Extra floor,
stood round the 2.6 mm bosses and sealed their pockets in it (#70); with one, the plate is
built as a solid floor builds it, pockets and the floor's growth included, and Checks says
so. A joint cut from beneath where four cells meet (a wall key's recess, an H-clip's, a
dovetail's or a puzzle's notch) is taken out of the bosses as well as the cells, after
their pockets; the bosses used to stand in the whole housing. Cut plainly, the housing's
outline went into the boss and into the cell it shares faces with, and into both of two
bosses meeting across a cell edge: an H-clip at 42 mm went from 40 edges used four times
a piece to 59 and 68. So a boss a housing reaches stops a `BLOAT` short of the piece's
edge, the two either side of one housing are built as one solid, and the cut is moved
two `NUDGE`s into its own boss, so its walls stand 3.4 microns from the cell's. (One
`NUDGE` is not enough: a cut that comes out open is taken again a `NUDGE` along a
diagonal, the cell's and the boss's alike, and that could put the boss's walls back on
the cell's: 52 more four-use edges in a piece, on a wall puzzle key at 36.13 mm.) That leaves
fewer four-use edges than before (31 a piece for that H-clip) and none used once. A boss
is its pocket's depth and 0.8 mm (a magnet) or 1.0 (a screw head) tall, up to 2.6, and
one whose top stood level with the ceiling of the cut that reaches it (a dovetail's notch
2.4 mm, an H-clip's recess 2.3, a wall key's 2.0) came out open there: a 1.6 mm magnet or
a 1.4 mm head beside a dovetail, 4 to 13 open edges a piece. 0.01 mm off the level either
way, none did. Such a boss stands `MOUNT_LEVEL` over the ceiling, with a pocket from above
cut from that top.

A boss's pocket is a lottery of its own: default screws in a one-cell piece left 3 to 6
open edges on a boss's underside at 22 of the 901 pitches from 34 to 60 mm that take
them, and a 9.1 mm magnet at 39.46 mm 12 a piece, with no joint at all. So every boss's
pockets are cut again (`cutAgain`) when they come out open. A boss no housing reaches is
cut again only then, and is otherwise built byte for byte as it was: a pocket that comes
out closed with a face turned over (13 more of those pitches) has the fold
`unfoldFinished` lays out again, and every one of those pieces was watertight and
oriented. A boss a housing reaches is new, and is cut again when a pocket comes out
turned over too, as the joint's cut is; the shorter boss draws the lottery at other
pitches (34.64 and 34.72 mm, in four one-cell pieces with dovetails).

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

Four orientation defects are quarantined by name rather than fixed, on the same terms as
the leaks. The plate audit holds its three to their size on file, piece by piece or plate
by plate, so a quarantine for a few folds cannot wave through more:

- **The carved bins' reflex fillet**, in `test/bin-audit.js`. One inside-out closed shell
  of 212 triangles per reflex corner, −214.259 mm³ (−282.322 on the taller `bigL-5x4`), so
  every L, U, T, staircase and notched footprint carries at least one. It is a sign error
  in `sweptSector`: that helper builds an annular sector as `outer` CCW then `inner`
  reversed, which only traces anticlockwise while `outer` is the larger radius. Convex
  corners pass `[CR, CR - t]` and are right; the reflex fillet passes `[CR, CR + t + OVER]`
  and reverses the loop, with nothing downstream renormalising it.
- **The H-clip put in from beneath, at pitches just past where keys meet**, in the joint
  section of `test/plate-audit.js`. Four coplanar folds on a piece, a sliver of the bed
  face by the clip's pocket turned over, no edge open; on main the same plates and the
  same counts. The section builds every joint Checks names in place of keys that meet,
  and finds it on 8 of the H-clips it builds, wherever the pitch is 14.1 mm more than the
  field.
- **Two plates only the engine can build**, mounting sites 2 or 3.5 mm from a cell's
  centre (`holeOffset`, which the page does not set) at small pitches, in
  `test/plate-audit.js`. A bowtie's cup in the wall at 14.5 mm keeps folds by the cup
  where main has them, fewer of them (6 and 3 on two pieces, against main's 10 and 5).
  Puzzle tabs at 20 mm keep three on each of two pieces, at a 3-corner sliver the weld
  turned right over, which faces the wrong way however it is laid out; main builds those
  two clean, and the sliver came with the puzzle notch's pole moving into one region.

  The top-inserted wall cup for the puzzle key used to be quarantined here too: 12 coplanar
  slivers of about 1e-4 mm² on 3 of the 4 pieces at arcSegs 12 (14 on main), none at the
  arcSegs 6 the tool ships. It is the only key housing whose cutter crosses the socket's
  *corner* cone, where a lobe arc and a cone arc cross at a shallow angle, both made of
  near-tangent facets (over segment counts 17/19/21/25/33 the same plate ranged from 0
  folds to 89, with no monotonicity: a sliver lottery). The slivers stand on edge, and
  laid out on the finished piece (`unfoldFinished`, below) they fold no more.

  The puzzle fit sample used to be quarantined here for six slivers of 5.2e-5 to 5.5e-4 mm²
  on two of its four tiles, and it is clean now. The honest account is that the coupon's
  tiles went from 8 mm deep to 10 — because a top-insert cup's wall needs the room — and
  the cutter's planes now graze the tile's corner arc somewhere else. Nothing in
  `csgSubtract` changed. If it comes back, that is what it is.

One kind of fold is fixed rather than quarantined. Where `healCsgSeams` welds a vertex
onto its group it can land a thousandth or two across the line of its neighbours, and the
face it mends comes out with a dent too small to see. Fanned from its first corner, or
from its average, one sliver of the fan can lie back to back with the face: three coplanar
folds by a puzzle notch, in the bottom face beside a mounting pocket, or in the side of a
puzzle tab. A mended face whose plain fan lays a triangle within 8 degrees of back to back
with it is laid out again from the first of these that is sound: each of its corners in
turn, then ears cut in its own plane. Sound means every triangle has area, is wound the
face's way and lies within 60 degrees of it, and no diagonal is already an edge of another
face. A face with nothing sound goes out as it was. The face's own average is not tried:
over the page's designs below it laid out nothing a corner did not, and through the engine
alone it traded folds for open edges on two pieces (3 and 14 edges), which no corner and no
ear did anywhere.

Nothing else is touched. The first version of this took any face whose fan turned a
triangle back by the sign of its normal alone, and a third of the faces it touched over
the random mount designs below (341 of 1,081) had no fold in them: slivers that lean or
stand on edge. Laying those out again made some pieces worse through the engine alone
(folds against an H-clip pocket's wall, edges used four times by a bowtie's cup, a
turned-over sliver re-wound against its neighbours; three rows of the plate audit hold
them), and dropping the ears instead let a page design fold again (the audit's dent
between two straight runs). Widening it again inside `healCsgSeams`, with the checks
above, does not pay either. Taking as well every face whose fan folds within itself, or
turns a triangle back, or stands one more than 60 degrees off the face, leaves fewer
engine-only pieces with any defect (316, 282 and 216 of 2,060 against 410, over the
designs named below), but each of the three puts the bowtie cup row's edges used four
times back, and the wider two open a hole in an engine-only piece that only folded. A
face laid out differently there is cut again by whatever comes next, and the next cut
goes differently: sound triangles do not make a sound cut.

Every face `healCsgSeams` lays out again on the page's designs had a fold in its plain
fan, by `test/orientation.js`'s own test: 740 over 3,893 random mount designs, 195 over
1,200 random puzzle designs, 188 over the 960 joint designs below. Through the engine
alone (595 designs at 14.3 to 17.5 mm pitches with the mounting sites moved in) it lays
out 5,944 faces, and 10 of them had no such fold: 3 laid a triangle within 3 degrees of
back to back with the face, 7 one between 3 and 8 degrees. The first version laid out
578 like that there. A face whose plain fan lies right is laid out exactly as before, and
so is every plate with no such face.

What does pay is the same care on the finished piece, where nothing cuts it again. A
sliver can stand on edge and fold against the face beside it, or against another sliver
of its own face, without lying back to back with its own plane: the side of an H-clip
pocket put in from above, with the clearance at the top of the field, at the pitches
Checks offers it. With only the faces above laid out again, 68 of 5,202 such plates
(14.3 to 15.95 mm every 0.05 mm, rows, columns and both, every 0.02 of the field) fold
more than they did under the first version, though less than on main, and the plate
audit holds one of them. So `unfoldFinished` takes each polygon of the finished piece
whose plain fan (from its first corner, as the STL is written) lays a triangle more than
60 degrees off its plane and has a triangle in a fold, by the orientation test's own
rule, and lays it out from the first of its corners, or failing those ears in its plane,
that is sound: every triangle has area and lies within 60 degrees of the plane, no
diagonal is an edge the piece already has, and no triangle lies back to back with the
one across its edge (positions keyed to a thousandth, as both checks key them). An edge
of the polygon stays an edge and a diagonal is new, used by the polygon's own two
triangles, so it cannot open a hole or use an edge four times, and it adds no fold.

Every polygon it lays out was in a fold, by that rule. It touches none on the 3,893
random mount designs, the 960 joint designs or the snap wall sweep; 2 over the 1,200
puzzle designs, the last two puzzle folds; 466 on 183 of the 5,202 H-clip plates from
above (folded plates 90, against main's 659 and the first version's 231) and 80 on 40 of
the 5,202 from beneath (27, against 86 and 67); and through the engine alone 592 on 128
of 595 designs, finding 13 more folded with nothing sound (pieces with any defect 207 of
2,060, against main's 1,132, the first version's 348, and 410 with only the faces above
laid out). It also clears the puzzle key's wall cup at arcSegs 12, which was quarantined
for its slivers (above). No piece it touched is worse in any of them. With nothing to lay
out it is a scan of the polygons, 2 ms of the 330 the page as it opens takes to build;
where it lays some out it tables only the edges near those, 3 to 8 ms on the H-clip
plates.

Over 960 designs of eight joints (five pitches, four clearances, rows and quads, three
corner radii) main has 528 folds on 134 pieces and this has none; over 1,200 random
puzzle designs none of the 4,686 pieces folds, where 144 of them fold on main.

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
  at full density, thick blocks as shell + infill × core. For a bin that is `binVolume`
  in bins/bin.js, from the numbers `buildBin` builds from, held to within 1.5% of what
  the mesh encloses (test/enclosed-volume.js), and a carved shape to within 0.3%, by
  estimate.spec and by the bin audit: its own cases and 40 bins drawn at random from a
  fixed seed, walls 0.4 to 10 mm. Over 3157 bins swept, whole, half and carved, walls to
  10 mm, edges lowered and open, it came to 0.995 to 1.005 of it, and the carved ones
  to 1.000. Over 1100 bins with finger slots, every combination of walls, lowered and
  thick walls, scoops, shelves and notes, holes, removable plates and half sizes, it
  came to 0.998 to 1.001, the lowest those whose shelf has a note raised on it, whose
  letters it leaves out.
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
  the cutters turned a 28th of a turn, moved 1.7 microns along the diagonal one way and
  then the other, and last one site at a time. A cell that closes first time,
  nearly every one, is built exactly as before. Over 3,893 random mount designs (magnets,
  screws or both, from below or above, 42 or 50 mm, one to three cells each way, random
  margins and corners) none is left open, where main leaves 30; 8 cells were cut again,
  for a second in 25 minutes of building. Only a cell open by at most 24 edges is cut
  again (six at each of four pockets). Cells cut again have been open by 1 to 24 edges,
  and cells open by 21 and 24 have closed; none open by more than 24 has. Over a broader
  2,163 random mount designs, 99 cells were cut again (open by 1 to 23) and 51 closed,
  and none of 2,733 cells open by more than 24 closed on any try. Of those tries only
  the turned cutters closed cells nothing else did (26 of the 51). Both orders reversed
  at once, once a fourth try, closed none that one of the first two had not, and is no
  longer taken. The nudges and the one site at a time came later: of 687 random page
  designs with a solid floor, the first three tries left 6 open and all of them leave
  4, none worse. A try that throws (the turned cutters there reach `healCsgSeams`'
  T-junction pass limit) is passed over and the first cut stands, where it used to fail
  the whole build. The socket floor is a fan too, from the cell's centre, and a pocket
  from above or a screw's shank stands on it: an 11.1 mm magnet from above at 48.55 mm has
  a pocket corner 4.7 microns from one of its spokes, by `fanCentre`'s measure, and loses
  the sliver there, six open edges in every cell that no try closed. How near is not what
  decides it: main's pocket for that magnet has a corner 1.0 micron from the same spoke
  and is closed. A cell still open after its tries, with an open edge at the floor's
  height, has that floor fanned again by `fanCentre`, clear of those corners, and where
  the fan moves, every cut is taken again on it. Only then: a 6 mm magnet from above at
  42 mm has a spoke 2.3 microns from a corner in every cell and is closed, and a cell open
  somewhere else (a pocket meeting a joint's housing) gains nothing from a new floor.
  Corners, not every point a wall stands on: where a counterbore and its shank were
  unioned, the BSP split each flat of the shank along the head's planes, and with those
  split points counted as well (24 on the socket floor, against the shank's 12 corners)
  a 2.4 mm shank under a 4.8 mm head at 44.08 mm, loose, had a point within `FAN_CLEAR`
  of every centre `fanCentre` tried. The fan stayed put and the cell shipped six edges
  open. From the corners alone it moves 0.2 mm and the floor closes.
- **A pocket that reaches a joint's cut goes bad where the two ceilings are level.** A
  key's recess, an H-clip's and a tab's notch are all cut up from under the plate, as a
  magnet pocket from beneath and a counterbore are. Run into one, the pocket comes out
  closed at nearly any depth but one: the recess's 2 mm (a 2 mm magnet, the default counterbore)
  or the notch's 2.4 (the spec's 6.5 × 2.4 magnet), where the two ceilings share a face
  that two subtractions each split their own way. A bowtie in the floor at 42 mm left 12
  edges open at 7.9 mm and 19 at 10; puzzle tabs at 36 to 40 mm left 26 to 86 with the
  spec's magnet. All 86 pockets tried level with a cut went bad; 0.001 mm off it, 3 did,
  and 0.003 mm or more off it, none. Off the level it depends on the cut, and `mountLimits`
  measures every mounting site of a whole cell against each cut on the layout, by the
  pocket's own polygon (`boreReach`), not the circle through its corners:
  - **A key's recess, an H-clip's or a puzzle tab's notch takes no pocket.** A sliver in
    can go bad off the level too: 0.019 mm into a snap key's recess at 36.52 mm, with a
    0.5 mm fit clearance, on main at four depths. Let in wherever the magnet or screw stays
    clear of the key or tab, 7 of 2,519 such pockets at the default fit or tighter went bad
    (0.02 to 0.14 mm in), and 8 of 1,151 at looser fits (0.2 to 0.65 mm in).
  - **A dovetail's notch takes a pocket from beneath**, a sliver or deep, unless it is
    level with the notch (within 0.05 mm either way, `MOUNT_LEVEL`, measured to the
    micron) or the magnet or screw in it would reach the other piece's tab,
    which stands the fit clearance inside the notch. None of 3,699 such designs went bad,
    1,086 of them on the page's design at 40.5 to 44.5 mm. A 12.7 mm magnet at 42 mm, 2 or
    3 mm thick, is taken: its pocket is 0.04 to 0.09 mm into the notch and the magnet
    0.24 mm clear of the tab. 2.4 mm thick it is level, built 96 bad edges, and is refused.
  - **A pocket from above** meets any of them unless its floor stands a layer over the
    cut's ceiling. The housings a key is dropped into from above start 1.3 mm over the
    socket floor and nothing reaches them.
  - **A pocket in a corner boss counts the same way**, since the joint is cut from the
    boss too (#70), and from above its floor is measured from the boss's top: wall keys
    and the dovetail reach a boss's pocket up to about 39 mm, the H-clip up to about 34.5,
    and nothing at 42.

  A pocket that stops short of a cut stops 0.01 mm short (`MOUNT_SEAM`): the weld in
  `healCsgSeams` takes points `VTOL` apart for one, and a thinner wall can come out welded
  through. 4 of 715 pockets less than 0.005 mm short went bad, and none of 1,941 from 0.005
  to 0.03 mm. Under a dovetail's notch that leaves a few hundredths of a millimetre of
  refused sizes below the largest, between the pocket that stops 0.01 mm short and the one
  that breaks in, about 0.02 mm wide and rounded out to the hundredth either side, as the
  field takes them: at 36 mm on the page's design 5.59, 5.6, 5.73 and 5.74 mm are refused,
  and 5.58, 5.61, 5.72 and 5.75 are taken. The page says so at the field and names the
  sizes taken either side. Past the weld's reach there is still the
  lottery the room cannot see, about one design in a thousand, single sizes with clean
  ones on either side, and it needs the pocket and the cut together: a 14.1 mm
  counterbore 2.4 to 3 mm deep, 0.09 mm short of a dovetail's notch at 43.17 mm, loose,
  folds an edge at the notch's corner, byte for byte as main does, and is clean at 2.35 mm
  deep, at 14.075 and 14.125 mm across, at every size from there into the notch, and with
  no counterbore. A guard out that far would refuse sizes that build clean on both sides
  of it and still miss the next, 0.1 mm off.
- **A joint's cut is the same lottery, and below 16 mm it comes up often.** The socket's
  straight walls run only 2.5 mm either side of a cell's middle at 13.5 mm, so every
  housing, notch and clip pocket crosses its corner arcs and cones, at points that move
  with the pitch. Two planes crossing a face a couple of thousandths apart lose a sliver
  (open edges) or leave it turned over (a fold: two triangles back to back across an edge,
  which an edge count cannot see). From 13.5 to 16 mm every 0.01, at the clearances as
  they come, main took 14,194 plates of the smallest-pitch audit's joints and layouts and
  45 had open edges, 115 folds; the H-clip put in from above was open at a field of 0.74
  at every pitch. `healCsgSeams` now also counts the faces it leaves turned over
  (`.turned`), and `cutAgain` in `buildPiece` takes a joint's cut again while the result is
  open or turned: the cutters reversed, the faces reversed, the faces started a third and
  two thirds of the way round, the cutters moved 1.7 microns two ways, and each cutter on
  its own. A cut that is right first time, nearly every one, is built as before. One
  sliver no order of the cut kept: a bottom-cap spoke 8.1 microns from the corner of a
  puzzle notch's lobe (columns beside rows, 14.71 mm, field 0.3). `fanCentre` keeps the
  spokes clear of the joint cutters' corners now as well as the mounting cutters', with
  `FAN_JOINT` more room; a plate with no joint fans where it did.
- **Two cells can share an edge without either being open.** Cells overlap by `BLOAT`, and
  a cutter on the line between two is cut out of both. The BSP splits one cutter's faces
  along another's planes the same way in both cells, so a split inside the band they share
  is the same edge in two shells, used four times (229 of those 14,194 plates on main).
  `touchesBuilt` compares the two shells' edges inside the band, and a jointed cell that
  shares one with a jointed cell built before it is cut again (`TOUCH_TRIES`: each cutter
  on its own, the cutters reversed, the faces reversed, the cutters one at a time from the
  last), or else the earlier cell is; the top-insert pass does the same. Mounting pockets
  do it with no joint at all: a pocket's wall, carried across its cell as a plane, splits
  the cell's side where it crosses it, and that side stands on the same plane as the
  neighbour's, so a split that lands on a corner of the neighbour's region is that
  corner's edge in both shells (a 21.7 mm magnet from beneath at 55 mm, 0.03 microns off;
  a 22.2 mm screw shank at 56.5 mm, on main too). With pockets on the piece, every cell
  and margin is checked against the shells built beside it (`settle`), and the pockets of
  one or the other are cut again moved 1.7 microns, turned a 28th of a turn, or both. The
  cut kept is the one that shares the fewest edges with every shell beside it: keeping one
  that touched fewer shells, as `settle` first did, left a cell built later sharing an edge
  nothing cleared (10.1 to 11.1 mm magnets at 47.91 to 50.05 mm, clean on main). And once
  the cells are built, if the shells `settle` cut again have more bad edges with those
  beside them than they started with, or more open or turned over, they all go back to
  their first cut. That check sees only those shells and their neighbours as the cells
  left them: the dovetail and puzzle tabs are made after it, and the top-insert pass cuts
  its housings out of shells after it, so neither is judged by it. Two cups put in
  from above from each side of a piece one cell deep meet face to face at 14.44 mm (twice a
  cup's reach), and there they are built as one solid with `csgUnion`.
- **A face that is nothing but a straight line has no middle.** A weld that closes a
  T-junction can leave three corners on one line. Fanned from its average, the spokes land
  a fraction of a micron from a corner and read, to `checkManifold`'s thousandths, as the
  face's own edges a second time (a puzzle key in the wall from beneath with magnets from
  above at 42 mm: four edges used four times). Such a face goes out as it is.
- **A weld that never settles is three points, not a loop.** Three cut lines that cross a
  face within a couple of microns of one point leave a triangle a couple of microns on a
  side there. Each corner is just over `VTOL` from the other two, so the collapse keeps all
  three, and each is within `VTOL` of the line through the other two, so the T-junction
  pass puts them into each other's edges in turn and never finishes: it threw at six
  passes, and forty do no better. When the passes run out, `healCsgSeams` makes one point
  of those the last pass was still putting in that lie within two `VTOL` of each other,
  and repairs once more from the start; a soup that settles inside the passes never comes
  that way. #76 was this: a dovetail plate at 39.07 mm with a 3 mm shank and a 2.34 mm
  counterbore, where two facets of the socket's sloped wall at the cell's corner cross the
  counterbore's ceiling 2 microns from an edge of its own. Every piece with a seam on its
  left failed to build, for heads from 7.3 mm to the cap; 2.339 and 2.341 mm built. The
  second run is kept only if it comes out closed: a jigsaw plate at 41.24 mm with magnets
  from above settles open after the merge, and fails to build as it did before rather
  than going out with holes.
