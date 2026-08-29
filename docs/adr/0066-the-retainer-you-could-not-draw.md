# ADR 0066 — The retainer you could not draw

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §5, §35. The last operation `refuseForeign` blocked, deferred
  deliberately by ADR 0063 and again by ADR 0065.
- **Builds on:**
  [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0062](0062-the-money-that-did-not-know-its-own-currency.md),
  [ADR 0063](0063-the-euro-invoice-you-could-not-credit.md),
  [ADR 0064](0064-the-euro-invoice-you-could-not-raise.md),
  [ADR 0065](0065-the-credit-netted-against-a-converted-balance.md)

## Context

`refuseForeign` stopped four operations from Phase 35. Phase 63 lifted three of
them and kept this one on purpose:

> Applying a retainer is a **settlement**, not a reversal: it decides at what
> rate money already held discharges a new demand, which has a profit-and-loss
> effect and is an accounting decision, not arithmetic the document engine
> already made.

ADR 0065 left it standing for the same reason. Both were right: the question was
real, and answering it by whichever rate was easier to reach would have put a
made-up profit figure in the books.

## Decision 1: it is the receipt's rule

A retainer is cash received and held. Drawing it against an invoice is a receipt
that arrived early — and `recordPayment` has decided what happens then since
Phase 35:

```ts
const fxCents = appliedFunctionalCents - carriedCents
```

Neither rate needed choosing. The retainer has been carried at the rate the
money arrived at, and the invoice at the rate it was raised at, ever since each
was recorded. The gap between them is a realised gain or loss: a real
profit-and-loss event, not revenue, because nothing more was sold.

What this phase actually decides is that it *is* the same rule, and writes it
once — `settleHeld` in `fx/settlement.ts` — so a third hand-rolled subtraction
does not have to keep agreeing with two others.

## Decision 2: both sides come from `relieveFunctional`

The first draft of `settleHeld` took the held money's **rate** and converted each
draw. A database check written earlier in the same phase caught it: a €10,000
retainer drawn in three parts would take its face amount to zero while the sum of
three conversions missed the functional amount by a cent — a liability saying
money is held for a client who has spent all of it.

So both sides are `relieveFunctional`'s decision, applied to each. Its rule that
the final relief takes the whole remaining functional balance is what stops
either the liability or the invoice stranding a cent. What is left for
`settleHeld` is the part that is genuinely its own: the difference, and which way
round it posts.

## Decision 3: a retainer knows what currency it was received in

`retainers.currency`, `exchange_rate_millionths` and `functional_remaining_cents`
— the shape Phase 62 and 65 gave payments and Phase 63 gave credit notes.

The currency is **chosen** rather than inherited, unlike a credit note's: a
retainer arrives before there is any document to inherit from. It is cash on
account.

The backfill is trivially correct for the reason Phase 63's was: `receiveRetainer`
never accepted a currency, so every retainer on file is domestic.

## Decision 4: a draw across currencies is still refused

Phase 62's rule, now needed a third time: money held in one currency has not
discharged a demand in another. `creditableAgainst` and the new
`drawableAgainst` share one function for the comparison and for naming both
sides — Phase 47's discipline that a refusal says what is wrong with *this* row.

The remedy is deliberately not shared. A credit is raised against a document; a
retainer is taken from a client before any document exists. Telling somebody to
"raise the retainer against a document" would be advice they cannot follow.

## Decision 5: `refuseForeign` is gone

It has no callers left. A comment stays where it was, because the shape is worth
keeping: **a refusal is not a permanent verdict, it is a question nobody has
answered yet**, and the cost of removing one is a phase of work rather than a
wrong number for years. It stood for thirty-one phases and was right for all of
them.

## Consequences

- A euro retainer can be taken and drawn. The ledger posts the liability at the
  rate the money arrived at, the receivable at the rate the invoice was raised
  at, and the difference to `7100 Foreign Exchange Gain or Loss`.
- `receiveRetainer` posts the receipt in the company's own currency; it used to
  post the face amount, which would have put €10,000 on a dollar balance sheet.
- `billWork` takes a currency, so a euro client can be invoiced from time —
  without it a euro retainer had nothing it could ever be drawn against.
- The retainer picker names its currency; it showed a €10,000 retainer as
  $10,000.

## What this does not do

- **The billing form has no currency of its own.** It bills in the currency of
  the retainer being drawn, and in the company's own when none is. That is right
  for the case this phase is about and wrong for a euro client with no retainer,
  who still cannot be billed in euro from the time screen.
- **A retainer cannot be refunded in its own currency**, because it cannot be
  refunded at all — there has never been a way to give one back. That is a
  missing operation rather than a currency defect, and it predates all of this.
- **The payment composer still has no currency of its own**, unchanged from ADR
  0065. It infers one from the documents being settled, which has nothing to say
  for a payment on account.
