# 0171 — Every reference into the catalogue

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 171

---

## The nomination held, measured

ADR 0170 nominated *"the next slice of the 269, taken by referenced table rather
than by referencing one: every reference into `service_items` first, since the
unique index is already there and the pattern is proved."*

First nomination in six phases that measurement did not have to correct. What it
did was supply the numbers the ADR had guessed at.

From `pg_constraint`, the references into `service_items` from tenant-scoped
tables: **sixteen**, two already converted by Phase 170, fourteen left — and all
fourteen have `company_id NOT NULL`, which is what makes every one of them
convertible. There is now no single-column reference into `service_items` at
all.

## Taking a slice by referenced table buys a sentence about the data

This is the part worth keeping. Sliced by *referencing* table, a phase ends with
*"fourteen more are done"* — a statement about the backlog. Sliced by
*referenced* table it ends with **"no row anywhere can name a catalogue item
belonging to another company"** — a statement about the data, which is the kind
somebody can rely on.

It is also cheaper per reference: the unique index on the target is added once
and every reference into it follows.

And it reaches the references nobody has examined. The two Phase 170 converted
were the two somebody had already found. `time_entries.item_id` was converted
because it points at the same table, and nothing about *it* had ever been
looked at — which is why the test that proves a cross-tenant reference is now
refused uses a time entry rather than an invoice line. The references nobody has
looked at are the ones most likely to be unguarded, and taking a whole target
catches them without having to guess which.

## Three shapes in sixteen, which is why the sweep was declined

ADR 0170 refused to convert all 271 mechanically and predicted they would not be
uniform. Measured:

```
set-null-nullable    6   ON DELETE SET NULL (col)   appointments, proposal_items,
                                                    repair_order_lines, time_entries,
                                                    + invoice_lines, bill_lines (Phase 170)
restrict-not-null    9   ON DELETE RESTRICT         nine inventory and manufacturing tables
restrict-nullable    1   ON DELETE RESTRICT         work_order_entries
```

The prediction was right and the *reason* is narrow enough to name:
`CONVERSION_SHAPES` records it, because a prediction that was right is only
useful if the shapes are written down rather than remembered.

**Only the six `SET NULL` ones need the column-list form.** A bare
`ON DELETE SET NULL` nulls every column of the reference, `company_id` is
`NOT NULL`, and the delete fails — so a mechanical pass would have made deleting
a catalogue item impossible wherever it is currently allowed, which is the
precise outcome the `SET NULL` was chosen to avoid. The ten `RESTRICT` ones need
nothing of the sort, because `RESTRICT` nulls nothing.

`restrict-nullable` is its own shape because the *pair* is unusual rather than
because the SQL differs: a column that may be null whose item may not be deleted
while it is set. `work_order_entries.item_id` is null for labour and set for a
part consumed, and a consumed part is not deletable.

## Existing mismatches are refused, not tidied away

A composite key cannot be added while a row points at an item in another
company, so the migration checks all fourteen first and raises with the count
and the table names.

It deliberately does **not** clean them up, and the distinction from Phase 169
is the argument. That phase cleared dangling ids before adding its foreign keys,
and that was right: an id pointing at nothing is already meaningless. A
cross-tenant id is different in kind — it points at real data belonging to
somebody else, which is evidence of a bug and possibly of a disclosure, and a
migration that quietly nulled it would destroy the only record that it happened.
A deployment that fails there has learned something it needed to know.

Stated in the migration and worth repeating: **the test database is truncated
between tests, so it holds no evidence either way about production data.** The
check passing here is not a finding.

## A side effect, named as one

Three of these constraints were still called `..._service_item_id_...`, from
before Phase 169 renamed the columns to `item_id`. Phase 169 renamed the index
it had created itself and left the constraints Postgres and Drizzle had named —
the same small untruth in the catalogue it had just argued against, one object
type over.

Dropping and recreating every reference as `..._item_tenant_fk` settles it, and
there is now a test asserting no constraint anywhere mentions `service_item_id`.
It is recorded as a side effect because that is what it was: the names were
found by reading `pg_constraint` to get the DROPs right, not by looking for
them. One of them — `proposal_items_service_item_id_fkey` — was also named
differently from the rest, because Phase 168 added that column with an inline
`references()` and let Postgres name it while the others were named by Drizzle.
Checked rather than guessed, which is the only reason the migration applied
first time.

## An arithmetic error, found by its own test

`CONVERSION_SHAPES` first recorded 4, 9 and 1 — the fourteen this phase
converted — while the test asserted they summed to sixteen. They sum to
fourteen.

The field is named `foundInCatalogueSlice`, so it has to count the slice: the
two Phase 170 converted are references into the same table with the same shape
as four of these, and they belong in it. Six, nine, one. Minor, and worth the
paragraph because the assertion that caught it was one I wrote in the same
commit — which is the only kind of check that catches a number nobody else will
ever recompute.

## What this does not do

**It does not convert the other 255.** The next target has to be chosen, and
`chart_accounts` is the obvious one by volume — but two shapes the catalogue
slice never met are still unmet: a **self-reference** (a table pointing at
itself, where the composite key's uniqueness and the row's own tenancy are the
same fact) and a reference **from an unscoped table** into a scoped one, which
has no `company_id` to put in the key and therefore cannot be converted at all.
The second is the interesting one, because it means the programme has a ceiling
below 271 and nobody has measured where.

**It does not touch `REFERENCE_PROOFS`.** The vocabulary held: nothing in this
slice needed a fifth proof, which is some evidence the four are the right four.

## What is nominated next

**Measuring the ceiling.** How many of the 255 are references from an unscoped
table into a scoped one, and therefore cannot carry the tenant? That number
turns "271 to convert" into "N convertible and M that need something else", and
the something else is worth knowing before another slice is taken on the
assumption it is all mechanical.

> **Corrected by Phase 172.** **None of them.** The 271 was defined in Phase 170
> as `src IN scoped AND tgt IN scoped`, so every one already has a `company_id`
> to put in the key — the predicate in my own query had excluded the case this
> nomination then worried about. Only two references anywhere come from an
> unscoped table, and neither is in the 271.
>
> The question was still worth asking, and it had an answer: the ceiling is a
> **nullable `company_id`**, on nine tables and three references, so 268 of 271
> are cleanly convertible. The sharp part is why — under `MATCH SIMPLE` a
> multi-column key is not checked at all when any column is NULL, so converting
> a reference whose source `company_id` is nullable produces a key that counts
> toward the total and enforces nothing.

Then **a full suite**, still nominated and now overdue by eleven phases — the
reference count added in Phase 170 is a third tree-wide scan of the kind that
has twice gone red undetected.
