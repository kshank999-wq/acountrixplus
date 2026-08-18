# ADR 0037 — A schedule is a promise to bill, not a bill

- **Status:** Accepted
- **Date:** 2026-08-18
- **Context:** Spec §13 — accounts receivable. Recurring *invoices* are not named
  in the spec's list; recurring journal entries were, and Phase 11 built them.
  This is the other half of the sentence, chosen because a business with
  retainer clients is one this system could not serve.
- **Builds on:** [ADR 0010](0010-at-least-once-and-who-decides.md),
  [ADR 0011](0011-the-same-books-read-two-ways.md),
  [ADR 0023](0023-somebody-elses-money.md),
  [ADR 0031](0031-what-is-owed-is-owed-by-somebody.md)

## Context

Phase 11 built recurring *journal entries*: a template plus a clock, posting an
entry every month. Phase 23 built rent invoicing, gated on the properties
module and keyed to a lease.

Neither covers the commonest arrangement a small business has: **bill this
customer this amount every month.** A retainer, a maintenance contract, a
subscription, a support agreement. Without it, somebody types the same invoice
twelve times a year and eventually forgets one.

Five claims, asserted in `tests/billing.test.ts` (32 tests):

1. **A schedule is a promise to bill, not a bill.** Setting one up owes nobody
   anything.
2. **A period is billed exactly once**, and the database is what says so.
3. **What it raises is a real invoice**, through the same door as one somebody
   typed.
4. **Stopping a schedule unbills nothing**, and restarting one does not replay
   the months nobody billed.
5. **What is coming is a forecast**, reported and posted nowhere.

## Decision 1: nothing is owed until a period arrives

No receivable, no revenue, nothing ageing, nothing on a statement. A business
that set up twelve monthly arrangements has not thereby been owed anything, and
a system that showed thirteen months of receivable because somebody filled in a
form would be lying about its own balance sheet.

This is Phase 29's argument for a booking — "a booking is a promise, and a
promise is not revenue" — applied to the other side of the year.

## Decision 2: through `createInvoice`, never a hand-rolled entry

Phase 31 cost a whole phase to learn this: a module that posts
`Dr AR / Cr Revenue` itself produces a receivable that no aging report knows
about, no statement mentions, and no payment can be applied to.

So `raiseInvoiceFor` calls Phase 2's `createInvoice` inside the occurrence's own
transaction. What a schedule bills ages, reaches a statement, gets a PDF and can
be paid, because it *is* an invoice rather than something shaped like one.

## Decision 3: the occurrence row is written first, and the database arbitrates

```sql
    INSERT INTO recurring_invoice_occurrences (recurring_invoice_id, occurred_on, …)
    ON CONFLICT (recurring_invoice_id, occurred_on) DO NOTHING
```

inside the same transaction as the invoice. The scheduler guarantees *at least*
once (Phase 10), so something has to make the second attempt harmless — and a
read-then-write would let a worker and a person both find nothing and both raise
an invoice. The customer gets billed twice for December.

This is Phase 23's rent lesson and Phase 34's drawer lesson, in the third place
they apply: where two people can act at once, the database arbitrates.

## Decision 4: the cadence is Phase 11's, and so is the date arithmetic

`recurring_cadence` already existed. Two enums with the same four values would
be two places to add "fortnightly", and one would get missed.

`nextOccurrence` and `firstOccurrence` are imported rather than reimplemented,
for the sharper version of the same reason: two answers to "what is the next
monthly date" drift apart on exactly the dates that are hard. `dayOfMonth` is
capped at 28 by the same CHECK, and the refusal says why — "the 31st" is not a
day every month has, and a schedule that silently skips February is worse than
one that bills on the 28th.

## Decision 5: automatic, or claimed and waiting

`autoRaise` is Phase 11's `autoPost` distinction, and it matters more here
because the output is a document that reaches a customer. A fixed retainer is
safe to raise; anything whose amount somebody checks first is not.

When it is off, the run still **claims** the period — writes the occurrence —
and leaves the invoice for a person. The claim is the point: without it, a
schedule somebody is reviewing would be offered again tomorrow, and the day
after.

## Decision 6: the forecast is reported, never posted

The largest number on the screen is not a receivable. Nobody has been invoiced
for any of it. This is the rule Phase 35 set for currency exposure and Phase 36
for a budget, and it matters most here because the figure looks so much like
money owed — so the screen says *"Forecast total — not owed by anybody"* in the
row where the total goes.

## Decision 7: pausing unbills nothing, and resuming does not replay

A schedule is switched off rather than deleted: the invoices it raised are why
last year's numbers look the way they do.

Resuming one that fell behind starts from **today**, not from where it stopped.
Catching up automatically would send a customer four invoices the morning
somebody flipped a switch — and unlike the catch-up on an active schedule,
nobody asked for those periods to be billed.

## Decision 8: no integrity check, for Phase 36's reason

A schedule posts nothing, and each occurrence's invoice is written in the same
transaction as the occurrence itself — so there is no pair of independently
derived figures that could drift. ADR 0033's argument is that a register stays
useful exactly as long as everything in it can fail.

## The two bugs browser verification caught

Both were visible only as an inconsistency **between two numbers on one screen**,
and neither test would have found them because both behaviours were what the
code said.

**The catch-up loop stopped at the first manual period.** `runDueSchedules`
broke out of its loop on any `skipped` result — correct for "already billed by a
concurrent worker", wrong for "waiting for somebody", which is a *successful*
claim. A quarterly arrangement nobody attended to therefore claimed April and
then silently stopped: July was never claimed, never billed, and appeared
nowhere. The symptom on screen was a schedule whose "Next" was a date in the
past. `RunResult` now carries `claimed`, and the loop stops only when nothing
was claimed.

**The forecast hid overdue periods.** The window opened at `from`, defaulting to
today, and occurrences before it were filtered out — so the same overdue quarter
was invisible in the one report meant to show what is coming. The walk starts at
`nextRunOn`, which is by definition unbilled, so there is no lower bound any
more: anything before `from` is *overdue* rather than out of scope, and it is
reported as its own figure and coloured on the row.

## Consequences

- **One line per schedule, through the screen.** The service takes many; the
  form takes one, because a multi-line editor is a different piece of work and
  one line covers a retainer.
- **No tax, no currency, no job on a schedule.** `createInvoice` supports all
  three; the schedule does not pass them, so a foreign-currency retainer or one
  with sales tax has to be raised by hand.
- **Editing a schedule means recreating it.** Lines are written once at
  creation. Changing an amount is a new arrangement, which at least makes the
  "changes the future, not the past" rule true by construction.
- **Nothing tells anybody a manual period is waiting.** It is on the screen, at
  the top; Phase 24's notifier could make it arrive and does not.
- **A voided invoice leaves its occurrence claimed**, deliberately — the period
  *was* billed, and forgetting that would let the next run bill it again — but
  nothing then re-offers the period, so a voided recurring invoice has to be
  reissued by hand.
- **The forecast walks up to 200 occurrences per schedule.** A weekly
  arrangement forecast four years out would truncate silently.

## Follow-up

1. **Notify when a manual period has been waiting too long**, through Phase 24's
   scheduler — the difference between a work list and a fact that finds somebody.
2. **Multi-line schedules and editing**, which together make this usable for
   anything but a flat fee.
3. **Tax, currency and job on a schedule**, all of which `createInvoice` already
   takes.
4. **Send the invoice**, since Phase 19 has the mail channel and Phase 21 the
   PDF. Raising it and emailing it are currently two acts.
5. **Price changes with a date**, so a retainer that goes up in April is one
   arrangement rather than two.
