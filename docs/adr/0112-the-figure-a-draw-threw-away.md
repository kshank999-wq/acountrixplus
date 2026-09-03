# 0112 — The figure a draw threw away

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 112

---

## The defect

ADR 0111 nominated this and I verified it before adopting it:

> `timebilling.retainers` is still the clearest candidate —
> `retainer_applications.applied_on` dates every draw.

Reading the code first turned out to matter, because the nomination was right
about the date and wrong about the work. All three ways a retainer's balance
moves *are* dated — taken on `received_on`, drawn on `applied_on`, given back on
a refund's `refunded_on` — but the draw does not record **what it took**.

A draw works out what actually left the liability, in the company's own money,
and posts it:

```ts
const release = relieveFunctional({ ... }, amountCents)
const settlement = settleHeld({ releasedCents: release.functionalCents, ... })
...
{ chartAccountId: heldAccount.id, debitCents: settlement.releasedCents }
```

and then wrote only `amount_cents` — the *client's* currency — onto the
application row.

**It is not derivable afterwards.** `relieveFunctional` has a rule that the
final relief takes the whole remaining functional balance, so nothing is left
holding a stranded cent. That makes a draw's functional amount depend on the
functional balance at that moment — which is exactly the history being
reconstructed. Circular.

`refunds.carried_cents` is the same fact about the other way a retainer goes
down, kept since Phase 68 in the same words: *"functional, off the balance being
cleared, at its carried rate."* One of the two settlements of this liability
kept its figure and the other did not. That is Phase 65's defect again — a
functional amount computed and dropped — for the sixth time.

### Measured

The development books held only a retainer I had inserted by raw SQL in Phase
105 for a browser demonstration, with no journal entry behind it. Measuring
against that would have measured my own contamination, so it was removed and
replaced with a retainer taken and drawn through the service:

```
  date          held     ledger   verdict
  2026-09-03    320000   320000   agrees
  2026-07-31    320000   320000   agrees
  2026-06-15    320000   500000   DIFFERS
  2026-05-31    320000   500000   DIFFERS
  2026-04-30    320000        0   DIFFERS
```

The held figure never moves — the signature Phases 109 and 111 found their
defects by. It is a **fault**, so $5,000 of client money read as broken books in
May, and $3,200 read as held a month before the client had sent anything.

## Decision 1: keep the figure rather than re-derive it

`retainer_applications` gains `carried_cents`, not null, positive — the same
shape and the same name `refunds` has carried since Phase 68. `applyRetainer`
writes the number it already worked out two statements earlier, so the row and
the ledger cannot say different things about what left the liability.

The backfill is exact rather than approximate. The draw posted `releasedCents`
to the retainer-held account, so the debit on that line *is* the figure the
column should always have held; the migration reads it back through
`journal_entry_id`. It joins on the account the entry itself touched rather than
on a chart number, because a company on a pack without 2550 holds retainers on
2500 and both are legitimate. Rows whose entry was voided or unlinked fall back
to the retainer's carried rate — named in the migration as a fallback precisely
because it cannot see the stranded-cent adjustment.

## Decision 2: rebuild the balance, do not read the running column

`functional_remaining_cents` is where a retainer stands *now*. The ledger side
of this check has always been filtered by `entry_date`, so a past date compared
a subledger as it stands today against a ledger as at that day.

`heldByAt` in `retainer-position.ts` assembles a retainer's whole dated life —
opening, draws, returns — and hands it to Phase 111's `heldAt`. That reuse is
the point: the boundary question *was this on the books, and what did it hold*
is the same question a fourth and fifth time, and Phase 111 named it once so
this phase did not have to decide it again.

A retainer has **no closing date**. It does not leave the books when it reaches
zero; it simply holds nothing. So the lifespan is open at the far end and running
down to zero is something the movements say rather than something the dates do.

`openCount` comes from the same walk as the total, because *how much are we
holding* and *on how many retainers* are one question asked two ways — and Phase
105 already shipped a sentence whose noun and verb disagreed about a count.

Undated means everything, which is what the ledger side already means:
`endDate: undefined` puts no filter on `entry_date`. A date beyond any movement
says that in the same words the dated path uses, rather than giving the function
a second code path or a clock it does not need.

Measured on the same books afterwards, every date agrees and the held figure
walks back:

```
  2026-06-20    320000   320000     1  agrees
  2026-06-19    500000   500000     1  agrees
  2026-04-30         0        0     0  agrees
```

The boundary is right in both directions: the draw counts on the day it happened,
because its journal entry is dated that day.

Thirteen checks now reach any date; eight remain `today_only`.

## Decision 3: the development books stop lying

The raw-SQL retainer removed here has been carried since Phase 105 and named in
every summary since as known contamination. It was a retainer the subledger had
and the ledger had never seen — which is precisely the fault this check exists to
find, sitting in the books as a permanent false positive. Replacing it with a
retainer taken and drawn through the service is what made an honest measurement
possible at all.

## What this does not do

**It does not repair the remaining eight.** `receivables.customer_credit` is the
one that cannot be: held credit is a running column on the payment with no dated
record of its consumption, which is the same defect this phase fixed — and fixing
it would mean the same remedy, a dated application row carrying what it took.
That is a bigger change than a column, because those rows do not exist at all.

**It does not add a date control to the retainers screen.** The page asks about
today, and a note there would be unreachable. The nightly run and the integrity
register are what carry past dates, and both were verified.
