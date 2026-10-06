# 0169 — One name, and two references that were not

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 169

---

## My own nomination was false

ADR 0168 nominated **`service_item_id` on `invoice_lines`**, *"which turns the
same question on realised revenue rather than on offers — and realised revenue
is the one a business acts on at year end."*

`invoice_lines.item_id` has referenced the service catalogue since **Phase 14**.
Its own docstring says so: *"The catalogue item sold (Phase 14). Set on a
stocked line, which is what tells the invoice to relieve inventory."*

Fourth false *reason* in this lineage, after §9's "geography analytics" (ADR
0164), §11's "segments has strategic-account segmentation" (ADR 0167), and §9's
"nothing measures sent→decided" (ADR 0168). The first one that is mine, written
by the phase that had just spent four paragraphs on the cost of a claim nobody
re-measured — which is the most useful thing about it. The rule is not "audits
go stale"; it is that **a nomination is a claim, and writing it down does not
check it**, including when the writer has just said so.

## And it widened a split it had not noticed

Phase 168 added `proposal_items.service_item_id` while believing the invoice
side had nothing. Measured across `src/db/schema`, references to
`service_items`:

```
item_id          invoice_lines, bill_lines, six inventory tables,
                 manufacturing, vehicles                            9
service_item_id  time_entries, appointments,
                 proposal_items (added by Phase 168)                3
```

Two names for one relationship, and the split predates Phase 168 by two tables —
but Phase 168 made it worse, so this phase closes it rather than recording it.
All three are renamed to `item_id`, which is what nine tables already said and
is the better name anyway: `service_items` is the single catalogue of **both**
services and stocked goods, so a line selling a stocked product through a column
called `service_item_id` was always reading oddly. A pure rename; the data moves
with the column.

The auto-named index came too. An index called `..._service_idx` on a column
called `item_id` is the kind of small untruth that costs somebody an afternoon.

## The column nothing had ever written

The worst of the three findings, and it is not a reporting gap.

`invoice_lines.item_id` has existed since Phase 14, and **no production path has
ever set it.** Measured: the only caller that passes `itemId` into
`createInvoice` is `tests/inventory.test.ts`. The invoice composer drops it, the
proposal conversion bills stages rather than lines, timebilling reads
`time_entries.item_id` and drops it when building the invoice line, and
appointments do the same.

So the inventory relief that column exists to trigger — `consumeStockForSale`,
behind `stockShortfalls`, all of it built and tested — **has never fired for a
stocked item sold through the application**. The machinery works; nothing calls
it with an id.

That is Phase 49's rule one level down: a function with no caller is a feature
that does not exist, and so is a **column with no writer**. It is also why ADR
0168 was right that the capability was missing while being wrong about why, and
the "why" was the part that mattered: the fix is not a migration, it is a select
element.

So this phase builds the screen. The invoice composer offers the catalogue on a
line, filling the description, the price and the income account and leaving all
three editable — a catalogue item sold at a negotiated price is still that item.
And `groupTimeIntoLines` carries `item_id` through to the invoice line, but
**only when every entry in the group names the same one**: grouped by person or
by day a single line can hold two services, and naming either would attribute
the whole line's revenue to one of them.

Offered on invoices only. `bill_lines.item_id` is the purchasing side's and
`inventory/purchasing` already sets it from a purchase order; a second way to
fill the same column from a different screen would be two answers to one
question.

## The two that were never foreign keys

Of the twelve places this codebase points at `service_items`,
`invoice_lines.item_id` and `bill_lines.item_id` were the **only two that were
not foreign keys** — declared as bare `uuid('item_id')`, and `pg_constraint`
confirmed it.

They are also the two that matter most. An id pointing at nothing would relieve
no stock and group revenue under a product that does not exist, and nothing
would say so: the stock path scopes its lookup by company, so a bad id simply
finds nothing and the line goes through. It **degrades silently**, which is the
shape Phase 160 found in `devices` and `security_policies`.

Phase 116: a constraint beats a check. `set null` rather than `restrict`,
matching `vehicles.item_id` — deleting a catalogue entry must not be blocked by
an invoice raised three years ago, and must not delete the line either. The line
survives and says nothing about what it was, which is true.

The migration clears any already-dangling id before adding the constraint.
Measured zero in the test database, written anyway, because a migration that
only works on an empty table is not a migration.

## The leak the test caught, in this phase and the last one

`serviceRevenue`'s first draft joined the catalogue on `id` alone.
`scoped(ctx, …)` guards the driving table; a join needs its own company
predicate. So the cross-tenant test came back labelled **"Their framing"** —
another tenant's product name on this company's dashboard.

`serviceBreakdown`, written in Phase 168, had the identical unscoped join. Both
are scoped now. Phase 149/150's guarded-read rule reaches **every table in a
statement, not the first one**, and that is worth saying plainly because 110
writes and 883 reads were audited under it and a join predicate is not a read
those counts would have noticed.

The test asserts what actually happens rather than a protection that is not
there: the foreign key proves the row exists and says nothing about whose it is,
so a cross-tenant id is still **accepted on insert**. What stops it being
attributed is the scoped join, and the group is labelled *"Not in this company's
catalogue"* rather than "deleted" — with the foreign key in place a deleted item
nulls the column, so a non-null id that does not join can only be a foreign one.
A tenant predicate on the insert is the remaining gap and is nominated below
rather than claimed here.

## Functional currency, in a report that sums across invoices

`serviceRevenue` apportions each line's share of its invoice's
`functional_total_cents` rather than converting the line itself. Adding
`amount_cents` across invoices in three currencies produces a number that is not
money (Phase 129), and converting per line would round per line and could miss
the invoice's own functional total — a whole that existed before its parts
(Phase 145). An invoice already in the functional currency has the two totals
equal, so the arithmetic is the identity and costs nothing.

## What this does not do

**No tenant predicate on `item_id` at insert.** The foreign key cannot express
"and it must be yours", and `createInvoice` does not check. The scoped join
keeps it out of reports, and that is containment rather than prevention.

**No carry-through from appointments.** `appointments.item_id` is recorded and
dropped the same way time entries were, and the fix is the same shape. Left for
the phase that can test the appointment-to-invoice path properly rather than
bolted on here.

**No carry-through from a proposal to its invoice.** Both conversion paths bill
*stages*, not lines, and `conversion.ts` already argues why: a schedule of
values breaks the contract into stages of work, not into the proposal's line
items. There is no line-to-line correspondence to carry.

## What is nominated next

**A tenant predicate on `item_id` where it is written** — `createInvoice` and
`createBill` proving the item belongs to the caller's company, the way
`logCommunication` proves every party it names. That is the prevention this
phase only contained.

> **Corrected by Phase 170.** This ADR says above that *"the foreign key cannot
> express 'and it must be yours'"*. A single-column key cannot; a **composite**
> one can — `FOREIGN KEY (company_id, item_id) REFERENCES service_items
> (company_id, id)` — because the referencing row's own `company_id` becomes
> part of the reference. So the prevention was a constraint rather than a lookup
> in ten writers, and Phase 116's rule settles which to prefer.
>
> An unchecked claim about PostgreSQL rather than about this codebase, which is
> the new variety: the habit of measuring the repository had not extended to
> measuring the tool. Phase 170 also measured the scale — 271 references between
> tenant-scoped tables, none carrying the tenant — which makes it a class rather
> than the single hole this ADR described.

Then the **bullet-level pass** over the sections `docs/SPEC-AUDIT.md` verified
only at module level. §9 and §11 were its two enumerated sections; between them
they produced four false reasons, one figure reported under the wrong name, one
column nothing had ever written, and two unscoped joins — all inside the parts
of that audit that were *most* carefully done.
