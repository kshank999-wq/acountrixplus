# ADR 0053 — The money you cannot bank

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §13, §16. A customer who sent more than they owed could not
  be recorded at all, and the application told the business to write down a
  figure its own bank statement disagrees with.
- **Builds on:** [ADR 0041](0041-the-document-you-raise-yourself.md),
  [ADR 0048](0048-the-bill-for-goods-you-already-have.md),
  [ADR 0049](0049-what-you-owe-and-choosing-what-to-pay.md),
  [ADR 0052](0052-the-payment-you-cannot-take-back.md)

## Context

A customer owed $7,400 and sent $8,000. The screen said:

> *"$8,000.00 is more than the $7,400.00 outstanding. **Reduce it to
> $7,400.00**, or raise the document the rest covers first."*

Both instructions are wrong, and the first is worse than the second.

**"Reduce it to $7,400"** puts a figure in the books that the bank statement
disagrees with. The reconciliation is $600 out and stays $600 out **for ever**,
because the difference was never recorded as anything — there is no later event
that resolves it and nothing anywhere to point at.

**"Raise the document the rest covers first"** means inventing an invoice for
money the customer does not owe, fabricating $600 of revenue so that a bank line
matches.

Two constraints produced this together: `recordPayment` insisted applications
sum to the payment exactly, and `reduceDocumentBalance` refused an application
larger than a document's balance. Meanwhile `allocate` had computed
`unappliedCents` correctly since Phase 41 and nothing had ever been done with it
except refuse.

This is not an exotic case. A customer rounding up, paying an old invoice twice,
paying the gross when a credit note reduced it, or sending a deposit before the
invoice exists — all of them hit it.

## Decision 1: the leftover is a liability

A customer who has paid more than they owe is a customer the business **owes
money to**, either as credit against their next invoice or as a refund. So the
difference credits `2520 Customer Overpayments`.

Three alternatives, each rejected for a reason:

- **Revenue.** Nothing more was sold.
- **A negative receivable.** Netting it against what other customers owe hides
  it inside the aging report and quietly overstates collectable cash.
- **`2500 Unearned Revenue`.** That is money taken for work that *will be done*.
  An overpayment carries no promise of future work — often it is a keying error
  whose honest end is a refund. Phase 15's retainers are the deliberate version
  and already have `2550 Client Retainers Held`; this is the accidental one, and
  it gets its own account for the same reason Phase 44 kept money at a processor
  apart from cash in hand.

## Decision 2: two refusals survive

- **A disbursement.** Paying a supplier more than is owed leaves *them* owing
  *us*, which is an asset, not this account. Vendor credits (Phase 12) already
  cover the ordinary case, and a second answer would give a business two places
  to look for the same money.
- **Nobody named.** You cannot owe money to no one. A leftover with no customer
  has nowhere for the liability to attach, and holding it against nothing is how
  Phase 46's stranded payments happened.

Both refusals now say what to do instead, which the old one did not.

## Decision 3: the exchange difference is on what was applied

`fxCents` compared the **whole** receipt against what the documents were
relieved by. On a domestic $600 overpayment that reads as a $600 exchange gain —
inventing profit out of a customer rounding up. What is held was never carried
at any document's rate, so there is no rate difference on it to realise, and the
comparison is now `convert(applied) - carried`.

Caught while writing the ledger lines, not by a test. Worth recording because
the wrong version would have balanced perfectly and quietly moved $600 into
profit.

## Decision 4: it has an end, built at the same time

Held credit is applied to a later invoice (Dr 2520, Cr Accounts Receivable) or
refunded (Dr 2520, Cr the bank). Both, now, not later — because Phase 49 found
`applyVendorCredit` exported and tested since Phase 12 with no caller anywhere,
stranding real money, and Phase 48 found a clearing account nothing could clear
that had grown to $28,700.

The application is written onto the **same payment** rather than invented as a
new one: the money arrived once, and what is happening later is that some of it
finally has a document to belong to — which is exactly what a
`payment_applications` row says. A second payment row would double the cash on
every report that sums receipts.

The refund is likewise **not** a `payments` row. Recording it as a negative
receipt would break the constraint keeping amounts positive and make every
receipts total wrong by twice the refund. It is also deliberately not a void,
for the reason Phase 52 gave when it declined to fold the two together: a void
says the payment never happened; a refund says it happened and then went back,
and the customer's own bank statement can tell them apart.

## Decision 5: a check, with the account

`receivables.customer_credit` compares the sum of unapplied receipts against
2520, as a **fault** rather than a position — nothing else posts there, so a
difference is not a timing artefact. Added in the same phase as the account
because Phase 48's lesson only needs learning once.

## What the browser found

Nothing broken, and that is worth saying plainly rather than dressed up. The
defect this phase fixes was itself found in the browser at the start — following
an $8,000 payment against $7,400 outstanding and reading what the application
said to do about it.

After the change the same path recorded *"$8,000.00 against INV-1014 … $600.00
more than was owed is held as credit for them"*, the credit appeared on **Money
in and out**, $400 of it settled a new INV-1018 and the remaining $200 was
refunded — and both control accounts still agreed to the cent afterwards: 2520
at zero against zero unapplied, and Accounts Receivable at 4,820,469 against the
same figure on the aging report.

Two exports were deleted before commit rather than shipped: `describeCredit` and
`creditFor` were written, tested, and called from nowhere in `src/app`. That is
precisely the pattern Phases 48, 49 and 51 each found as a live defect, and
shipping two more of them to be discovered later would have been worse than
leaving the customers screen without a credit column.

## Consequences

- `2520 Customer Overpayments` is a system account on every company's chart.
- `payments.unapplied_cents`, constrained between zero and the payment amount.
- `payment.credit_applied` and `payment.credit_refunded` join the audit actions.
- **Money in and out** gains a "Credit we are holding for customers" section.
- Two Phase 41 tests were rewritten. They asserted the refusal, and the refusal
  was the defect.

## What this does not do

It does not handle **overpaying a supplier**, which leaves them owing us — an
asset, and a different account with a different report. The refusal names vendor
credits, which cover the ordinary case.

It does not show held credit on the **customers screen** or on a **customer
statement**, both of which are where somebody would look for it when the
customer rings. That is the follow-up the deleted `creditFor` was reaching for,
and it wants a real surface rather than an unused export waiting for one.
