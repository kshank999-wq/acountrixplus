# 0177 — The transaction that changed

**Status:** accepted
**Date:** 2026-10-07
**Phase:** 177

---

## The nomination held, and it was the right one

ADR 0176 nominated this and argued that it was not a one-line fix. Both halves
survived measurement, which after Phases 169–172 is worth saying out loud.

> `/transactions/sync` returns `modified`, and the universal case is the one
> every bank does — **a pending transaction posts.** The amount changes (a tip,
> an FX rate, a fuel hold settling) and so does the date. This adapter hands
> those transactions over correctly. `importTransactions` then does
> `.onConflictDoNothing(...)`, so the update is **dropped**, and the inbox keeps
> the pending figure forever.

The consequence, stated there and still true: *a reconciliation against the real
statement will not close, and the difference will be the tip.*

## Why `onConflictDoUpdate` is the wrong fix

It is the one-line change. It would silently rewrite the amount of a transaction
somebody has already categorized and **posted to the ledger** — possibly inside
a closed period, under a reconciliation they have already certified.

This codebase settled that question three ADRs running, and `ledger/restate.ts`
states the settlement in its own docstring:

> **A second entry, not a re-post.** The original stays where it is. Rewriting
> it is the defect Phase 129 stopped, and it would make a period somebody has
> already reported on change without saying so.

Idempotency was built as *"do nothing on conflict"* when the only conflict was a
repeated import of the same window, and it was right for that. `modified` makes
**"already present" stop meaning "already correct"**, and that is the whole
defect in one sentence.

## The division

A `bank_transactions` row is two things at once, and the fix is to stop treating
them as one:

| | |
| --- | --- |
| **A copy of the feed** | Nothing has been derived from it. Keeping the copy accurate is not editing history, because there is no history yet. **Apply.** |
| **The source of something** | A posted entry, splits that sum to it, a match against an invoice, a reconciliation that cleared it. **Hold, and name what to undo.** |

Note which way the default falls. A transaction with nothing built from it
applies *everything*, including a changed amount, because the row is a copy and
the feed is the authority on what the bank did. The holds are the exceptions, and
each exists because something else now depends on the stored figure.

### The second division, which carries more weight than expected

`BOOK_AFFECTING_FIELDS` is `amountCents` and `postedDate`. Everything else —
description, merchant name, provider category, **`pending`** — is descriptive and
applies in place *whatever* has been derived from the row.

That asymmetry is what keeps the hold list short enough to be read. A provider
settling `SQ *COFFEE` into `Coffee Shop`, or flipping `pending` with the amount
unchanged, has told us something harmless: no ledger figure moves. Holding it
would produce a queue of nothing for somebody to clear, and a queue of nothing is
how the entry that matters gets skimmed past — Phase 160's shape, arrived at from
the other direction.

A posted entry is deliberately **not** re-posted for a descriptive change. The
entry's memo records what it was posted with; rewriting it afterwards to match a
settled merchant name would be editing history to no purpose.

## Six grounds, ordered by what has to be undone first

`REVISION_HOLDS` is Phase 101's device with a second floor that Phase 119 adds:
every entry carries a **remedy**, and `revisionStands` refuses one that does not.
A held revision whose ground names no remedy is a transaction that is wrong
forever and says so.

```
reconciled → cleared → split → transfer → matched → posted-to-the-ledger
```

The order is load-bearing rather than cosmetic, and it is asserted exactly. A
transaction can be reconciled *and* posted *and* split; the ground reported is
the one whose remedy comes first, because telling somebody to re-split a
transaction that a completed reconciliation has locked sends them to a screen
that will refuse them.

Two of the six are worth their own sentence.

**`cleared`** is the one that would not have occurred to a reader of the review
state machine. A transaction ticked in a reconciliation that is *still open*
means somebody is sitting in front of a difference they are trying to close.
Changing a cleared amount underneath them moves the cleared balance and therefore
the difference — so the number they are chasing changes while they chase it, and
the bank feed is the last place they would look for the reason.

**`split`** is the one where doing something automatic would be worst. The extra
$4.20 on a split restaurant bill is the tip, and nothing in this module can know
which line it belongs on. Dividing the difference is the one behaviour that must
not happen.

### `DerivedState`, and why `reviewState` is not the input

The decision takes six facts, not a state name. A transaction can be
`categorized` with no live entry (it was voided), and `new` while cleared in an
open reconciliation. Asking the questions directly is what stops this table
encoding a second, slightly-wrong copy of the review state machine — which is the
"two answers to one question" defect in its most common clothing.

## A table, not two columns

The first shape tried was `provider_revision_amount_cents` and friends on
`bank_transactions`. It is wrong twice:

- A transaction is revised **more than once**. Pending at $40, pending at $42,
  posted at $44.20. Columns hold the last one and lose the path — and the path is
  what somebody reconciling actually wants to see.
- "Applied" and "held" is a fact about a *revision*, not about the transaction. A
  row that had one applied in March and one held in April has no single answer to
  put in a column.

So `bank_transaction_revisions` is append-only and logs the **applied** revisions
too, which makes it the audit trail for the feed rather than a queue of
exceptions. §19's correction philosophy is append-only everywhere else and there
was no reason for this to be the exception.

`previous_amount_cents` is stored rather than derived, and the reason is a bug
that shape avoids: by the time somebody reads a held revision from last Tuesday,
a *later* revision may have been applied, and "from" would then be a lie.

## Three constraints doing work a check would have done worse

- **`UNIQUE (company_id, bank_transaction_id, amount_cents, posted_date, pending)`.**
  The worker runs every five minutes. A held revision the provider keeps
  re-sending would otherwise write 288 identical rows a day, which is how a log
  stops being readable and therefore stops being read. Asserted in both
  directions: five identical re-sends make one row, and a genuinely different
  revision makes a second.
- **Two CHECKs.** A row cannot say `held` with no ground, and cannot be resolved
  with no timestamp. The first is the important one — a held revision with no
  ground is a held revision with no remedy, which is precisely what
  `revisionStands` stops the register doing, and a constraint is what stops a
  future writer doing it anyway.
- **The composite tenant key.** `FOREIGN KEY (company_id, bank_transaction_id)
  REFERENCES bank_transactions (company_id, id)`, which needed a new
  `UNIQUE (company_id, id)` on `bank_transactions` to point at. Phase 170's
  device applied to a table on the day it was written rather than 170 phases
  later, and asserted in both directions because a key that refused everything
  would pass the first half.

## A row lock, because the alternative was a branch nothing could exercise

`importTransactions`'s guarantee has always been that the *database* arbitrates
duplicates, so two simultaneous syncs cannot both win. A revision breaks that
shape: deciding whether one is safe means **reading** derived state and then
writing, and between the read and the write somebody can categorize the
transaction — which is exactly the case this module exists to prevent.

An optimistic `WHERE amount_cents = <what we read>` would mostly work and would
leave a branch nothing can exercise. Phase 121's rule is that a check only ever
seen to agree is not a check, so the rows are locked `FOR UPDATE` and the
correctness argument is structural. A constraint beats a check (Phase 116).

## Re-decided at apply time, which is what makes a remedy a remedy

`applyHeldRevision` runs the same pure function again rather than trusting the
ground recorded at sync time. A revision held last week on `reconciled` applies
today because somebody did what the remedy said, and there is a test asserting
exactly that transition.

Without it the register would be a list of dead ends. It also means the apply
path cannot become a second, more permissive copy of the rule — there is one
decision function and both callers go through it.

Only `posted-to-the-ledger` can be resolved from the panel, because it is the
only ground whose remedy *is* "apply it": voiding and re-posting is what
`syncLedgerForTransaction` already does, at the rate already recorded (Phase
129's rule that a re-post must not restate its own FX). The other five need
something undone on a screen that already exists, and the panel shows the remedy
instead of a disabled button.

`ClosedPeriodError` refuses the re-post, inside the same database transaction as
the row update — so the amount rolls back with it. That assertion is the one in
this phase that would have caught a real defect: the update runs *before* the
re-post, and without one transaction the bank row would carry $44.20 while the
ledger carried $40.00 and nothing would have reported a failure that mattered.

## And a sentence that stopped being true

`connectAndSyncAction` said *"Already up to date — no new transactions"* whenever
`imported === 0`. A sync that imported nothing and revised three transactions now
says so. Phase 134's rule — a declaration that *excuses* is worse than one that
misses — and it was two lines from the code this phase changed.

## What this does not do

**`removed` still has nowhere to go.** `/transactions/sync` returns retracted
transactions — a disputed authorisation that never posted — and `TransactionPage`
has no way to carry one, so it stays in the inbox. The adapter reads the field
and drops it visibly. That is the remaining note from ADR 0176 and it needs a
shape on the interface before it needs a screen.

**`hasMore` is still read by nobody.** Self-correcting across worker ticks
because the cursor advances, so it costs latency rather than data: a first sync
of a long history takes an hour of ticks instead of one job.

**The reconciled and matched grounds are tested at the state rather than through
their own flows.** `reviewState` is set directly in those tests, because what the
decision reads is the state and those modules have their own suites. Worth
recording as a known seam: a change to how reconciliation marks a row would not
fail these tests.

## Nominated for Phase 178

**`removed`, and the shape `TransactionPage` needs to carry it.** It is the last
of Phase 176's three findings, it is the only one that leaves a wrong row in the
books rather than merely a slow sync, and the decision is genuinely interesting:
a retracted transaction that has already been categorized and posted is the same
problem this phase just solved, one step further on — except there is no new
figure to apply, only an entry that should not exist. `REVISION_HOLDS` is
probably the register it belongs in, with a seventh ground and a different
remedy.
