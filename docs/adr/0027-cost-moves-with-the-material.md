# ADR 0027 — Cost moves with the material

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §5 ("Manufacturing — **Raw materials, WIP, finished goods,
  BOM/costing**"), §13, §23
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0014](0014-one-inventory-five-industries.md),
  [ADR 0016](0016-the-parts-sum-to-the-whole.md)

## Context

`manufacturing` has been a declared industry module since Phase 0, switched on
by the manufacturing pack, doing nothing. So have the seven accounts that pack
installs. This is the sixth of §5's fourteen rows to get a real module, and the
last one with genuine accounting content behind it — the four that remain
(`pos_import`, `appointments`, `vehicles`, and one variant of `projects`) are
workflow surfaces.

Phase 14 built one perpetual inventory for five industry packs and left a seam
in it, with a comment: *"A business that keeps raw materials and finished goods
on separate balance sheet lines sets them on the items; everybody else never
thinks about it."* Thirteen phases later, this is the business that does.

Four claims, asserted in `tests/manufacturing.test.ts`:

1. **Cost moves with the material, and nothing is created or destroyed.**
2. **Material is costed from the lots it came out of**, never from a bill of
   materials or a price list.
3. **Scrap raises the unit cost**, because the run cost what it cost and made
   fewer good units.
4. **The three stages are three balance-sheet lines**, and the WIP register
   agrees with account 1450.

## Decision 1: there is no second costing engine, and no second inventory

A raw material and a finished good are ordinary `service_items` with
`tracks_inventory` set. Issuing material is Phase 14's `consumeStock` debiting
WIP instead of COGS; finishing a run is Phase 14's `receiveStock` crediting WIP
instead of a supplier. A work order's cost is whatever the lots it consumed were
worth, decided by FIFO or weighted average exactly as a sale's is.

The alternative — a standard cost held on the BOM, with variances against actual
— is what most manufacturing systems do and is a second source of truth about
what a thing cost. This application has spent twenty-seven phases refusing
second sources of truth, and a factory is not the place to start.

## Decision 2: the seam was widened, not duplicated

`consumeStockForSale` became a thin caller of a general `consumeStock` that
takes a debit account and a movement kind — the mirror of `receiveStock`, which
has taken its `creditAccountId` since Phase 14. Phase 14's own tests pass
unchanged, which is the point: the refactor is asserted to be behaviour-
preserving by tests written before it existed.

## Decision 3: a bill of materials is written per batch

A recipe for 100 loaves, not for one. A BOM written per unit forces every
component quantity through a rounding it never needed — a component used a third
of a time per unit accumulates a third of a thousandth of error on every unit of
the run. `explodeBom` scales in one step from the batch to the run.

Expected wastage lives on the component in basis points, because it is a
property of the material rather than of the day: 2.5% of that steel ends up on
the floor whichever Tuesday you cut it.

## Decision 4: a BOM says how much, never how much it cost

The quantity variance is against the BOM; the price variance is not computed at
all. A run that cost more than expected did so either because it used more
material or because the material had gone up, and one number covering both tells
a production manager nothing they can act on. This answers the half they
control; Phase 14's lot history already holds the other half, and it is a
purchasing question.

## Decision 5: scrap is absorbed into the good units

A run that consumed the material for 100 and yielded 95 cost the same money and
produced less, so the 95 carry all of it and the unit cost rises by about 5%.
That is the number a production manager needs and the number a "cost per unit
from the BOM" would never show them.

This is *normal* scrap. Abnormal scrap — a batch ruined by a machine fault —
should be expensed rather than capitalised into the survivors, and this module
does not distinguish the two. Named here rather than pretended away.

## Decision 6: yield and scrap rate have different denominators

Yield is against the plan ("we asked for 100 and got 95") and decides whether
the order can be filled. Scrap rate is against total output ("of the 98 we made,
3 were bad") and says whether the process is in control. A run stopped early has
a terrible yield and perfect scrap; collapsing the two would hide which
happened.

## Decision 7: completing a run clears WIP to exactly zero

Enforced three ways: the service sets `wip_cents` to 0, a check constraint
refuses any settled row that holds anything, and a test reads the ledger balance
on 1450 after completion.

**The remainder is posted, and so is the lot.** £100.00 over 3 units is £33.33
each, and three of those is £99.99. Posting only the journal entry would clear
the ledger and leave the finished-goods *lot* carrying the extended figure — so
the inventory subledger and the inventory accounts would disagree by those
pennies for ever, on every run whose cost does not divide. Both sides are
corrected in the same transaction.

## Decision 8: a cancelled run is written off to overhead

Not back to raw materials. The material was cut, mixed or melted; crediting the
store would put back stock nobody can pick. A cancelled run is a cost of
manufacturing that produced nothing, which is what 5080 is for.

## Decision 9: absorbing labour credits the expense

Debit WIP, credit Direct Labor. That reads oddly to anybody expecting an expense
to be debited, and is right: the cost was incurred when the wages were paid
(Phase 9 posted that), and this is the moment it stops being an expense of the
period and becomes part of the value of something on a shelf.

What is left in 5070 at a period end is labour that was *not* absorbed — idle
time — which is a number a factory manager wants and which a model that expensed
everything directly could never show.

## Decision 10: `wip_cents` is stored, and that needs a defence

Every other figure in this application is derived. This one is stored because it
is the *subledger* side of a reconciliation rather than a cache of the ledger:
`wipPosition` compares the sum of open runs against the balance on 1450, and a
figure derived from the same journal lines it is being checked against would
reconcile perfectly and prove nothing. Same shape as Phase 14's inventory check
and Phase 23's deposits.

## Two defects this phase found, and how

Both were in code that looked right and had passing tests.

**A left join multiplied the shelf.** `finishedGoodsOnHand` joined
`work_orders` into an aggregate over lots, so an item made in three batches
reported three times the stock. Caught by reading the query while writing the
test for it, and pinned by a test that runs three batches of one item.

**A raw `OR` collapsed a filter.** `stageValues` filtered with
`sql\`entry IS NOT NULL OR line IS NULL\`` inside `and()`. Drizzle joins the
arguments of `and()` with AND and does not parenthesise a raw fragment, and SQL
binds AND tighter than OR — so the whole filter became
`(everything else) OR line IS NULL`, which every account with no activity
satisfies. The report returned the entire chart of accounts.

The existing test asserted the three stage figures and passed, because the three
figures were right and eighty more rows came with them. **It was found in a
browser**, in the ninth phase running where browser verification caught
something the suite did not. The condition now lives in the `SUM` rather than
the `WHERE`, and two tests pin it: one asserting the length and the exact
account numbers, one asserting a factory with no activity still lists three
stages at zero.

## An improvement to Phase 14 that this forced

`reconcileInventory` compared *all* lots against account 1400 alone. That was
correct while every item used the default, and this factory is the first company
where none does — raw materials on 1440, finished goods on 1460, nothing on
1400. The check reported a difference the size of the entire subledger on books
that were perfectly correct, which is worse than not checking: a reconciliation
that cries wolf is one people learn to ignore. It now sums every account an
inventoried item actually names, plus the default.

## Consequences

- **No standard costing, and therefore no price variance.** Everything is
  actual. A factory that quotes from a standard cost and wants to see drift
  against it has no report here.
- **No routings and no operations.** A work order is a single step. Labour is
  absorbed as a lump somebody types, not derived from times booked against
  stations, so "which operation is slow" is unanswerable.
- **Abnormal scrap is capitalised with the normal kind.** A ruined batch raises
  the unit cost of the survivors instead of being expensed.
- **No multi-level BOMs.** A recipe whose component is itself manufactured works
  — the sub-assembly is just an inventoried item — but nothing explodes two
  levels at once, so a run of the parent will not tell you it needs a run of the
  child first.
- **No back-flushing.** Material is issued explicitly. A high-volume line that
  wants stock relieved automatically on completion has to issue by hand.
- **WIP is per run, never per operation or per day.** A run open across a period
  end sits in WIP at whatever it has absorbed, which is right, but there is no
  percentage-of-completion view of it the way Phase 7 gives a construction job.
- **Overhead is absorbed by typing a number.** No rate, no driver, no
  under/over-absorption report beyond reading the balance left in 5080.
- **`work_order_issue` is a new stock movement kind**, so anything that
  enumerated the old five and assumed they were all of them will need updating.
  Nothing in the application did; a future export or report might.

## Follow-up

1. **Multi-level BOM explosion**, so a run of a parent can propose the child
   runs it needs.
2. **Routings**, so labour comes from time booked at a station rather than a
   typed lump — Phase 15's timesheets are the obvious source.
3. **Separate abnormal scrap**, expensed rather than capitalised.
4. **An overhead absorption rate** per driver, with an under/over-absorption
   report at period end.
5. **Standard costing as an option**, once there is a reason to want the
   variance that is stronger than the cost of a second source of truth.
