# ADR 0049 — What you owe, and choosing what to pay

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §13, §19. A business could enter a bill and record a
  payment, and could not answer the question it asks itself every Friday.
- **Builds on:** [ADR 0041](0041-the-document-you-raise-yourself.md),
  [ADR 0043](0043-a-business-that-has-to-remember-to-chase-does-not-chase.md),
  [ADR 0047](0047-the-supplier-reference-is-not-our-number.md)

## Context

Two things were missing, and the second is the serious one.

**No work queue.** A/P aging has existed since Phase 2 as an as-of snapshot:
correct, printable, and inert — nothing on it is clickable and nothing can be
paid from it. The bill list on the invoices screen is ordered by issue date with
no totals and no overdue marking. Neither answers *what do I owe, what is late,
and can I cover it?*

**The selection was never sent.** `recordPaymentAction` has accepted
`documentIds` since Phase 41 and honours the order given. **No screen has ever
sent them.** Selection was per *vendor*, and `allocate` then consumed oldest
first — so a business paying a supplier's third invoice while disputing the
first two could not express it. The money landed on the disputed bills and
marked them settled.

That is not a missing feature; it is the application overriding a decision the
business made. The plumbing was already right. What was missing was a screen
that knew which bills a person had chosen.

## Decision 1: the choice is respected absolutely

A bill nobody ticked is never touched. Within what *was* ticked, the oldest is
settled first — that is what a supplier expects and what keeps an aging report
sensible — but the boundary of the selection is inviolable.

`applicationOrder` sorts inside the chosen set and nothing else. The pure
function makes the distinction visible: it takes the bills it was given and
returns them ordered, and cannot reach anything it was not given.

## Decision 2: one payment per supplier

Not one per bill. A business paying four of a supplier's invoices writes one
cheque and the bank statement shows one line — four ledger rows against one
statement row is a reconciliation nobody can do. The same correspondence Phase
44 needed between a card payout and the deposit it produces, for the same
reason.

If one supplier's payment fails mid-run, the ones already paid stay paid and
the message says how far it got. Rolling back would undo real payments a
business may already have sent from its bank; leaving it half done with an
honest report is the lesser failure, and both the aging report and the bank
tie-out show the truth either way.

## Decision 3: a shortfall is a warning, never a refusal

The balance compared against is what the *ledger* knows, which is not what the
bank knows — a deposit may have cleared this morning and a cheque written last
week may not have. Refusing on that figure would stop a business paying its
suppliers because of a timing difference, which is a far worse failure than
letting somebody go overdrawn knowingly.

## Decision 4: a credit is money, and it was stranded

`applyVendorCredit` and `applyVendorCreditAction` have been written, exported
and tested since Phase 12 with **no caller anywhere in `src/app`**. The
receivables screen displayed each credit's remaining balance beside no control
at all.

That is not hypothetical. Browser verification produced one in three clicks:
the credit form credits the *whole bill*, and the bill it was raised against was
part-paid — so `Math.min(total, balance)` applied £1,278 of a £1,420 credit and
**£142 had nowhere to go, for ever**. It is now offered against any other bill
from the same supplier, defaulting to what fits.

Applying a credit posts **no journal entry**, and the tests say so explicitly
rather than leaving it to be assumed. The ledger moved when the credit note was
raised; posting again here would take the same cost out of Accounts Payable
twice.

## Decision 5: a card owes, it does not hold — found in the browser

The account picker offers every active account, and paying a supplier by company
credit card is ordinary. But `balanceForAccount` signs in the account's *normal*
direction, so a card holding a credit balance comes back positive, and the
screen said:

> *Business Credit Card holds $1,404.79 on the ledger. $154.79 left afterwards.*

Exactly backwards. That $1,404.79 is what the business **owes**; paying $1,250
by card takes the debt to $2,654.79. Somebody reading "$154.79 left" would think
they had headroom.

A liability account now reports **no available figure at all**. Its headroom is
its credit limit less its balance, and this system does not know the limit —
inventing one would be worse than saying nothing. `planRun` already took
`availableCents: null` to mean "say nothing about coverage", which turned out to
be exactly the right seam. The account's kind decides it via `bandFor`, so a
loan account gets the same treatment without anybody remembering to add it.

## Consequences

- A business can hold a disputed bill back and pay the rest, which it could not
  do before.
- The Friday question has a screen, and the numbers on it are the same ones the
  aging report gives.
- Credit sitting with a supplier is shown next to what is owed them, because it
  is the same money seen from the other side — paying in full while holding an
  unused credit is paying twice for something already sent back.
- Nothing here decides *which* supplier waits. That is a judgement about
  relationships and cash, and no amount of arithmetic replaces it.
- Partial vendor credits are still impossible to *raise* — the credit form has
  no amount field and always credits the whole bill. That is what produced the
  stranded £142, and it is a separate gap this phase makes survivable rather
  than closes.
