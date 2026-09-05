# 0129 — The rate that was not written down

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 129

---

## How this was found

ADR 0128 nominated its own last gap:

> **It does not record the rate a bank transaction posted at.** Every other
> moving money column has carried its pair since Phase 116; this one derives the
> rate twice, once to post and once to tie out. They agree unless somebody edits
> a rate after the fact, and then the tie-out disagrees for a reason it cannot
> explain.

Verified before adopting, on the rule since Phase 110. The column really is
absent — `bank_transactions` has no rate and no functional amount, and it is the
only money reaching the ledger without them. But measuring *how* the two answers
come apart showed the nomination had understated its own case twice over.

## A correction to ADR 0128

**"unless somebody edits a rate after the fact" is wrong.** Nobody has to edit
anything.

`rateFor` walks **backwards** to the most recent rate on or before the date
asked for — deliberately, so that a rate published later never restates a past
transaction. But that means *adding* a rate for a day that had none changes what
an **older** question resolves to. Entering rates as they are published is not a
correction; it is the ordinary way a rate table is kept. Measured on the
database before a line was changed:

```
rate on 2026-09-10 before: 1100000        (resolved from a rate dated 2026-03-01)
after posting    feed -50000  books -55000  ledger -55000  diff     0

... somebody enters the rate for 2026-09-01, which nothing had ...

rate on 2026-09-10 after:  1150000
after new rate   feed -50000  books -57500  ledger -55000  diff -2500
```

So the drift is not an edge case reachable by an unusual act. It is reachable by
the *expected* act, and the only reason it has not been seen is that nobody has
held a foreign bank account for longer than one phase.

## The half the nomination missed entirely

ADR 0128 framed this as a check that "disagrees for a reason it cannot explain" —
a reporting problem. It is not. `syncLedgerForTransaction` is idempotent by
**voiding and re-posting**, and `buildLines` fetches the rate fresh each time.
So the re-derivation does not merely mislead a check; it rewrites the books:

```
posted at 1.10:              55000
after an unrelated recateg:  57500
CHANGED by 2500 with no correction record
```

Moving a transaction to a different expense account, or putting a job code on
it, silently restates what it was worth. Phase 70 settled that a change to the
books says what it is and why. This says nothing, because nobody decided it —
the money did not move again, only the rate table grew.

That reframing is what makes this a phase about the ledger rather than about a
report.

## The rule

**A rate is resolved once, on the day it is first needed, and then it is a fact
about that posting.**

`rateFor` answers *"what is on file for that day"* — a question about the rate
table as it stands now. A posting needs *"what did this money go into the books
at"* — a question about the past, with exactly one right answer once it has been
answered. Conflating them is the same shape as Phase 116's `fx.conversions`
recomputing a pair that had already moved.

Re-categorising is not a revaluation. Revaluing a past posting deliberately is a
correction with a date and a reason, through the vocabulary Phase 70 built —
never a side effect of somebody tidying a category.

A rate entered later is still the right answer for anything not yet answered, so
a transaction posting for the first time after it lands uses it. Only a posting
already made is fixed.

## What the backfill records

**What the ledger contains, not what it should have contained** — Phase 127's
rule, and the only honest source here. Asking the rate table what it would say
today gives exactly the answer this phase exists to stop using, and it would
overwrite the evidence of Phase 128's defect.

So the functional amount is read off the journal entry the transaction actually
produced — the line on the bank account's own ledger account — and the rate is
implied by dividing it by the face amount. Verified on seeded data:

```
 currency | description                              | amount | functional |    rate | at face
 EUR      | Hardware Handel (posted before Phase 128 | -80000 |     -80000 | 1000000 | t
 EUR      | Werkzeug GmbH                            | -50000 |     -55000 | 1100000 | f
```

## What this closes that two ADRs left open

ADR 0127 and ADR 0128 both ended with the same caveat: *it does not repair the
books of anybody who already hit this*. Both were right that repair is a dated
correction rather than something a migration may do. But both left the damage
**undetectable** — with no rate on the row, a foreign transaction posted at its
face value was indistinguishable from one posted correctly.

Writing the rate down makes it visible, and `banking.posted_at_face` reports it.
That is the honest half of the repair: a person cannot correct what nothing can
show them.

**It is a `position`, not a `fault`.** A currency really can sit at parity on the
day money moved, and then a correct row looks exactly like a damaged one. No
fact separates them — the rate table can no longer be asked, because the answer
it gives today is not the answer that was used. So the check reports what to look
at and a person decides, the same honesty `banking.cash_tie_out` has carried
since Phase 40.

## What this does not do

**It does not make the tie-out able to catch a mis-posted rate.** Both sides now
read the same stored fact, so a wrong rate agrees with itself. That was already
true before this phase in the only case that mattered — Phase 128 found the
check comparing a number with itself — and the replacement for that power is
`banking.posted_at_face`, which asks a question the ledger can actually answer.
The tie-out keeps the power it should have: a feed row that never posted, a row
posted then uncategorised, a payment that moved the ledger without a feed row,
and a manual journal all still show.

**It does not repair the rows the backfill exposes.** It counts them and names
them. Correcting one is a decision with a date and a reason, and belongs to
whoever owns those books.

**It does not give `bank_transactions` a currency column.** It still inherits the
account's, which is right: money in a bank is denominated by the bank. The pair
recorded here is the conversion, not the denomination.
