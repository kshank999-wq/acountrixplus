# ADR 0015 — An hour is billed once, or not at all

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §5 (Professional Services: "Projects, retainers,
  reimbursable expenses, time/expense billing"), §13
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0012](0012-the-statements-an-accountant-asks-for.md),
  [ADR 0014](0014-one-inventory-five-industries.md)

## Context

Professional services is the largest small-business segment, and `time_billing`
was one of the modules declared in Phase 0 and left empty. Unlike inventory it
needs no new accounting concepts — a timesheet becomes an invoice line, and the
invoice is the one that already exists.

What it does need is a discipline about *when* things happen, because a
timesheet is the only place in a services firm where the product is
manufactured, and it leaks in both directions.

The claim: **an hour is billed once, or not at all.**

Both halves matter, and the second is the expensive one. Billing an hour twice
is a client dispute and a refund. Losing one is revenue that was earned,
recorded, and never charged for — and nobody notices, because nothing is
wrong on any report that exists.

## Decision 1: recording time posts nothing

The same decision as ADR 0014's "a purchase order posts nothing", for the same
reason: nothing has happened yet that the ledger has an opinion about.

Unbilled time is not revenue — nobody has agreed to pay it. For most small
firms it is not an asset either: booking profit on your own labour before
anybody is billed is precisely the accounting that flatters a business right up
to the point it runs out of cash.

The professional-services pack declares `1150 Unbilled Work in Progress` for
firms whose policy is to accrue it. Nothing posts there, and `unbilledWork`
reads the timesheet directly instead — so the report exists without the
accounting policy being imposed.

## Decision 2: the precondition is in the WHERE

This is the whole enforcement of the claim, and it is one clause:

```sql
UPDATE time_entries SET status = 'billed', invoice_id = $1
 WHERE id = ANY($2) AND status = 'approved' AND invoice_id IS NULL
```

Two partners billing the same engagement at the same moment both read the same
unbilled rows and both build an invoice. Only one update matches them. The
other affects fewer rows than it selected, throws `AlreadyBilledError`, and
**its whole invoice rolls back** — because the update runs inside the invoice's
own transaction.

A read-then-write would let both invoices commit, and the second would arrive
at a client who had already paid. `tests/timebilling.test.ts` runs the two
concurrently and asserts exactly one invoice exists afterwards.

This is the third time the same shape has been the right answer: the deposit
uniqueness index in Phase 12, stock relief inside the invoice transaction in
Phase 14, and now this. Where two people can act at once, the database
arbitrates.

## Decision 3: money comes from minutes, never from displayed hours

Time is recorded in whole minutes, because that is what people enter and it is
exact. Hours are derived for display — and the money is computed from the
minutes.

```
  ten minutes at $90/hour
    from minutes         round(10 × 9000 / 60)      = $15.00
    via 0.167 hours      round(167 × 9000 / 1000)   = $15.03
```

Three cents. Forty lines on one invoice and a client asks why the total does
not match the lines, which is a conversation that costs more than the invoice.

## Decision 4: rate resolution is a pure function that says where it looked

Five candidates, most specific first: typed on the entry, this person on this
engagement, the engagement's blended rate, the person's standard rate, the
catalogue list price. It returns the rate **and its source**, so "why was this
billed at $150 when her rate is $175" is answerable in the interface rather
than by reading code.

**Zero is a rate and `null` is the absence of one.** A pro-bono hour billed at
nothing is a decision somebody made; `||` would fall through and charge for it.

The same function prices the preview and the invoice. Two implementations of a
fallback chain is exactly how a preview and a document come to disagree.

## Decision 5: grouping is presentation, not accounting

Every entry is billed at its own resolved rate, and a line's amount is the sum
of its entries'. Grouping decides only how many lines the client sees — one per
person, one per day, one for the lot — and can never change the total, because
the total was computed before the grouping was. A test asserts all four
groupings foot to the same figure.

The unit price shown on a blended line is derived *from* the line's total, so
it always multiplies back out.

## Decision 6: a retainer is a liability

`Dr Bank / Cr Client Retainers Held`. Recognising a retainer as revenue on
arrival is the commonest error in professional-services bookkeeping, and it
flatters a quarter by exactly the value of the work still owed.

Drawing it down posts `Dr Client Retainers Held / Cr Accounts Receivable` —
unlike applying a credit note, which posts nothing. The difference is real: a
credit note already moved the receivable when it was raised, whereas a retainer
moved cash into a liability, and the drawdown is what converts it.

The drawdown is capped twice, at what is left of the retainer and at what the
invoice actually owes. Over-drawing invents money the client never paid;
over-applying leaves an invoice with a negative balance no report can show.

## Decision 7: written-off time is kept

An hour worked and decided not to be charged for is a fact about an
engagement's profitability. Deleting it makes every job look better than it
was, which is how a firm keeps taking work that loses money. It needs a
reason — "over-run" and "goodwill" are different facts — and it stays in the
utilization denominator, so a firm cannot improve its numbers by giving work
away.

## Consequences

- **A retainer is not modelled on a cash basis, and the report says so.** This
  is the sharpest instance of ADR 0012's known limitation. On a cash basis
  there is no such thing as unearned revenue: money received in April is
  April's revenue. What happens instead is that the receipt has no recognition
  entry to take accounts from, so it stays on the balance sheet and
  `cashBasisCaveats` names the amount. Guessing a revenue account would put
  income in a bucket nobody chose. A test asserts the limitation directly, so
  it stays a named shortcoming rather than quietly becoming the behaviour
  everyone assumes is right.
- **Retainer entries are `source: 'manual'`, not `'payment'`.** A payment in
  this codebase settles a document through `payment_applications`, and a
  retainer settles nothing — it arrives before there is anything to settle.
  Labelling it a payment made cash-basis reporting look for an application that
  does not exist and warn about it.
- **There is no timer.** Time is typed after the fact, which is how most
  professional work is actually recorded, but a running clock is what makes a
  timesheet accurate rather than remembered.
- **No approval routing.** Anybody with `accounting:journal` can approve
  anybody's time, including their own. A firm that wants a partner to sign off
  a manager's work has no way to say so.
- **Expenses are not created from bank transactions.** A cost has to be entered
  as recoverable by hand, when the natural moment is categorizing the
  transaction it arrived on. The `sourceType`/`sourceId` columns are there for
  that link and nothing populates them.
- **Cost rates are recorded and unused.** `personRates.costRateCents` exists so
  engagement profitability can be reported, and no report reads it yet.
- **Billing is per engagement.** A client with four active engagements gets
  four invoices, where one covering the lot is what a client usually wants.
- **A partial write-off is not possible.** An entry is billed whole or written
  off whole; "bill three of these four hours" means editing the entry first.

## Follow-up

1. **Create billable expenses from the transaction inbox**, at the moment
   somebody is already looking at the cost.
2. **Engagement profitability** — revenue billed against cost rates, which is
   the report the cost rate column was added for.
3. **One invoice across several engagements**, with the work still attributed
   per engagement underneath.
4. **A running timer**, and approval routing that names who signs off whose
   work.
5. **Resolve the cash-basis retainer**, which needs a designated recognition
   account per deferred-revenue account rather than a guess.
