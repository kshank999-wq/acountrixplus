# 0152 — A number with no reader

**Status:** accepted
**Date:** 2026-09-24
**Phase:** 152

---

## How this was found

ADR 0151 left one sentence pointing here:

> `PENDING_WIRING` is one entry … and the blind comparisons are down from three
> to one.

The one left was `contractorPayments`, and it was on `BLIND_FACE_SUMS` — the
register of sums known to add two currencies, three entries deep since Phase
143, every one of them pointing at the same skipped acceptance test.

The staging constraint that kept them unrepaired was lifted in Phase 151. There
was nothing left holding them.

## The three were not one problem

That is the whole of this phase, and it was not visible from the register, which
described all three the same way — *"a figure that means nothing when the
invoices are in two currencies"*.

**Two of them needed a conversion.** `contractorPayments` sums
`payment_applications.amount_cents` per vendor and compares the total against a
statutory dollar threshold; `salesTaxReturn` sums `document_tax_lines` and files
the result with a tax authority. Both now convert each document at the rate it
carries, through `functionalSumSql`.

**The third needed the question asked one step earlier.** `cashBasisCaveats`
summed `invoices.tax_cents` across the period — and used the total **only** as
`> 0`. The caveat it raises prints no figure. So there was no rate to argue
about, because there was no reader: a presence test does not need money.

Its own sibling query, three lines above it in the same function, had already
met this and answered it:

> Deleted rather than converted: converting a number with no reader would only
> make it a correct number nobody wants.

That comment was written nine phases earlier and nobody carried it across. The
answer was sitting in the same `Promise.all`.

`faceSumStands` is where that distinction now lives, so the next blind sum gets
asked *who reads this* before it gets asked *at what rate*.

## The register named the wrong column

`BLIND_FACE_SUMS` said `salesTaxReturn` sums `invoices.subtotal_cents`. It does
— in its **second** query, the one reporting sales that carry no tax breakdown.
The figure that goes on the return comes from `document_tax_lines`, which has no
currency column at all.

The entry was not careless. `document_tax_lines` is on no face-column list,
because those lists are keyed to tables that carry a currency — so the scan
could only ever see the other query in that function, and the entry was written
from what the scan could reach. Both queries convert now, and both are tested.

## The repair blinded the check that found it

The sums moved behind `functionalSumSql`. The scan that had been watching them
matches ``sum(${table.column})`` in the source. So emptying the register would
have left two scans reporting all clear over nothing.

This is the scan-reach family again — Phases 128, 131, 133, 136, 140, 141, 143,
146, 147, 149, 150 — arriving for the first time as a **consequence of a fix**
rather than of a new feature. `converted_sum` is declared in `ADDITION_FORMS`
beside the other two, and both scans read it.

Unlike the other two forms it is not presumed guilty, and that is the part worth
getting right. A `functionalSumSql` call converts by construction, so a scan
that merely found it and shrugged would be Phase 121's *check only ever seen to
agree*. `convertedSumStands` judges it on its arguments:

1. **The second argument must be a rate.** It is multiplied by the amount and
   divided by a million, so anything else there is being treated as one.
2. **The rate's table must be joined.** `functionalSumSql` coalesces a null rate
   to `RATE_ONE`, because a left join to payments leaves it null for a vendor
   paid nothing and that row must add zero rather than vanish. The cost of that
   kindness is that a rate column from a table which is not in the query reads
   as `RATE_ONE` for **every** row — face amounts wearing a conversion, now with
   a helper's name on them saying they were handled.

`salesTaxReturn` needed a `leftJoin(invoices, …)` added for exactly the second
reason. Nothing would have said so.

Both rules were verified by disagreement: with the join deleted, the scan names
all three tax-line sums; with it restored, it passes.

## A third boundary, and two ways of getting it wrong

Rule 2 needs to know which tables a query joins, and the boundary for that is
neither the file nor the enclosing function.

**The function was tried first and it leaked.** `salesTaxReturn` holds two
queries, and the second reads `.from(invoices)`. Bounded by the function,
deleting the join the first query's rate depends on changed nothing the check
could see — it passed on the real file with the join gone. That is ADR 0134's
leak exactly, one level in: the phase that replaced a fixed-line window with a
function boundary, because the window excused a real defect.

`enclosingQuery` bounds it by the chained statement instead, backwards to the
executor and forwards by bracket depth — Phase 150's rule, for Phase 150's
reason: a `.where(` whose argument opens on the next line is still the same
statement.

**Then it cut the chain short.** Comments are blanked with their offsets kept
(Phase 141), so a comment between two links of a chain leaves a line of pure
whitespace — and a reader that stops at the first line not beginning with `.`
reads a blank line as the end of the statement. `salesTaxReturn` has a nine-line
comment directly above the join in question, so the chain ended one link before
the thing it was being asked about, and the check called a correctly joined site
unsound. Skipping to the next non-whitespace character is the same rule stated
correctly, and both cases are in `tests/enclosing-function.test.ts`.

Two boundary defects in one afternoon, in the fourth boundary reader this
project has written. It is in the shared module with the other three.

## The division scan found the new call, which is the register working

The full suite came back with one failure, and it was `money-division.test.ts`
saying *"declares every site a form reaches"* about
`functionalSumSql(invoices.subtotalCents, …)`.

It is not a split. `functionalSumSql` divides by a rate to convert, Postgres
does the adding, and nothing is handed anything one item at a time — the `.map`
and `.reduce` the `handed_over` form keyed on are over the return's own lines, a
different array in the same function. Recorded in that test's `EXCLUDED` list
with the reason, beside `payoutSettlement`, which is the same shape.

Worth saying plainly: a scan built in Phase 147 noticed a call written in Phase
152 and made somebody argue for it. That is what these registers are for, and it
is the first time one has caught a line from the phase that was emptying it.

## What this does not do

**It does not convert the ledger.** Journal lines are already the company's
money; nothing here touches them.

**It does not claim the third repair is observable.** `cashBasisCaveats` raising
its caveat from a count rather than a sum is the same behaviour for every input
anybody can construct — that is what "no reader" means. Its acceptance tests say
the caveat still appears and can still be absent; the repair itself is
structural, and what proves it is that no face sum is left at that site.

**It does not cover raw SQL.** A `db.execute(sql\`…\`)` is not a `.from(table)`
and no scan here sees it. Declared rather than silently missed, as in ADR 0150.

**It does not empty `COMPARED_PAIRS`' `blind` value out of existence.** Nothing
uses it now and it stays declared, against Phase 147's rule that a value with no
user is a value that does not exist. The exception is argued rather than
assumed: the four reasons beside it *excuse* a comparison, and if the next blind
one found has nowhere to be recorded it gets argued into one of the four. That
is ADR 0134's failure with a citation attached, and one unused enum value is
cheap insurance against it. Its emptiness is asserted rather than tolerated.

`BLIND_FACE_SUMS` is kept and empty for the same reason: the situation it was
built for — a sum found in one pass and repairable only in the next — produced
it once and will again.

## What is nominated next

**`mayPostToBank`**, the last `PENDING_WIRING` entry, blocked since Phase 136 by
a column that does not exist. It needs a migration, a form field and a screen,
which is the first thing in twenty phases that is ordinary feature work rather
than a measurement.

The registers that held known-wrong money figures are down to one entry between
them: `BLIND_FACE_SUMS` at zero, `COMPARED_PAIRS` at zero blind, `PENDING_WIRING`
at the one above. What remains from the spec audit is **§7's vector and layout
design engine**, the largest unbuilt piece, then §9's geography analytics and
§19's row-level security.
