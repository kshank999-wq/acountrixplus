# 0125 — Tracing what the last phase only looked at

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 125

---

## How this was found

ADR 0124 left a debt and named it as one:

> `UNCLASSIFIED_CARRIERS` records **19** that the scan cannot rule out and this
> phase did not trace to their query. Every one was looked at and none lists a
> foreign document beside a domestic one … But *looked at* is not *traced*,
> which is what the classified entries got, and the number is a tripwire that
> may shrink and must not quietly grow.

This phase traces them. The precedent is Phase 110, which verified the fifteen
reach declarations Phase 109 had guessed at and found real errors in them. The
same thing happened here.

## The number was wrong

There are **seventeen**, not nineteen.

The 19 was counted off the carrier list as it stood *before* the two repairs
landed and before the statements pair was classified — 21 bare, minus two that
were about to be given a currency, minus two about to be declared `books`. By
the time the phase was committed the answer was 17, and nothing recomputed it.

It is a small error and it is the same kind as the one Phase 121 owned up to
(the first falsification sweep said fifteen when the answer was thirteen): **a
count asserted from a list that had since moved.** Recorded here because a
tripwire whose starting number is wrong is a tripwire nobody can trust.

## Two of the seventeen were document money

"Looked at" missed both. Tracing found them.

**`billing/board.tsx` — the history of a recurring schedule.**
`billing/service.ts` joins the occurrences to the invoices they raised and
selects `balanceCents: invoices.balanceCents` — the face column, straight off
the table, into a row rendered as `formatCents(row.balanceCents)` with the
default. A schedule billing a customer in euros raises euro invoices, and the
screen showing what that schedule has billed puts the company's symbol on every
one of them.

**`receivables/board.tsx` — write-offs.** `invoice_write_offs.amount_cents`
carries no currency column, which is what made it look like the books' money.
The write path settles it: `writeOffInvoice` calls
`relieveFunctional(invoice, amountCents)` and posts `relief.functionalCents` to
bad debt. The stored amount is the **invoice's own**, converted only on its way
to the ledger — and the comment above that line says so, calling a write-off
"the one balance reduction that converts exactly". So a €4,000 write-off is
stored as 400000 EUR and was shown as "$4,000.00".

Neither is a sum, so Phases 122 and 123 could not have caught them; both are
across the boundary, so Phase 124's scan *did* flag them and the classification
waved them through. The scan was right and the reading was lazy.

## A hole in Phase 122's own regex

`opening-balances.ts` sums `invoices.balance_cents` and `bills.balance_cents`
across every open document, to compare against the one figure an import file
reported. Both are face columns, both were currency-blind, and both were written
inside a raw `sql` template as **`SUM(...)`**.

Phase 122's declared pattern is `sum\(`. It matches lowercase only, so uppercase
`SUM(` has been invisible to that tripwire since the day it was written.
Measured over face columns: **30 lowercase, 2 uppercase, and both uppercase ones
were defects.** The pattern is case-insensitive now and the two sums read their
functional twins.

Making the example in `looksLike` mention `SUM(` then made Phase 122's own
scanner report `addition.ts` — the self-matching problem Phase 123 had already
solved for its test and not for its sibling. One rule, now applied in both.

## A third answer the model did not have

Phase 124 offered two bases: `document` or `books`. Tracing turned up money that
is neither, in three tables:

- `invoice_write_offs.amount_cents`
- `deposits.total_cents` / `receipts_cents`
- `recurring_invoice_occurrences.total_cents`

Each stores one number, with **no currency column and no functional twin**. What
that number is denominated in is knowable only by reading the code that wrote
it, and in all three cases the answer differs: the write-off is the invoice's
currency (proved above); a deposit is the receipts' currency, which Phase 123
made single but never recorded; an occurrence total is whatever the schedule's
line prices were typed in as, and schedules carry no currency at all.

`unrecorded` is now the third basis. It is not a synonym for "probably fine" —
it means the denomination exists but is not written down, and the entry has to
say where the answer actually lives.

## A prop type is not always one kind of money

`billing/board.tsx`'s `Detail` carries the raised invoice's `balanceCents` — a
document's — beside the schedule's own `totalCents` and `perOccurrenceCents`,
which no table records a currency for. Classifying the type as a whole made the
check demand a currency on all three, which would have been a second wrong
answer rather than a fix. An entry now names **which fields** the basis covers,
and **which field carries the currency** when a nested row calls it something
else — the schedule history calls it `invoiceCurrency`, because the currency
belongs to the invoice the occurrence raised, not to the occurrence.

## What this does not do

**It does not give the three tables a currency column.** That is a migration
per table and a decision about backfilling rows already written, and each has a
different right answer — the write-off can take its invoice's, a deposit can
take its receipts', an occurrence has nothing to take. Declaring the gap is what
this phase does; closing it is at least one phase of its own, and the
`unrecorded` entries are where it would start.

**It does not fix the bad-debt roll-up it found.** `badDebtSummary` sums
`invoice_write_offs.recovered_cents` across every write-off, and those amounts
are each in their own invoice's currency — so the roll-up adds currencies.
Phase 122's scanner never saw it because `invoice_write_offs` is not a face
table. It is recorded in `NAME_COLLISIONS` with that said plainly rather than
excused, because it cannot be fixed without giving the table a currency column,
which is the migration above.

**It does not re-examine the seventy-seven.** The narrowing to face-named money
on document-serving screens still stands, and money on a screen with no
face-column name is still outside the rule. Phase 124 said so and this phase
does not widen it.

**It does not make "looked at" impossible again.** Nothing stops a future entry
being classified from the shape of a thing rather than from its query. What the
registry can do is make the claim visible and quotable, which is how both of
this phase's findings were caught — by reading what Phase 124 had written down
and going to check it.
