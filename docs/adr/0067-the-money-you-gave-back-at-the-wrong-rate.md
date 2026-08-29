# 0067 — The money you gave back at the wrong rate

- **Status:** accepted
- **Date:** 2026-08-29
- **Supersedes:** nothing. Extends ADR 0053 (overpayments), ADR 0066 (`settleHeld`).

## Context

Two halves of one rule, and ADR 0066 named both of them.

**The operation that was missing.** "A retainer cannot be refunded in its own
currency, because it cannot be refunded at all — there has never been a way to
give one back." A retainer is somebody else's money sitting on
`2550 Client Retainers Held`. An engagement that ends with money unearned leaves
a liability nobody can clear and a client owed money the product cannot record
returning. That is Phase 49's lesson, which found `applyVendorCredit` written
since Phase 12 with no caller anywhere in `src/app`: a balance with no way out is
not merely inconvenient, it is a number that becomes wrong and stays wrong.

**The operation that was wrong.** `refundCredit`, built in Phase 53 for a
customer's overpayment, posted:

```
Dr Customer Overpayments   amountCents
Cr Bank                    amountCents
```

— the **face amount**, with no conversion. While every holding was in the
company's own money that was right. Phase 62 let a receipt arrive in euro and
Phase 65 taught the column to carry what it was worth, and this entry was left
behind. Refunding a €500 overpayment posted 50000 to a dollar ledger and released
50000 of a liability carried at 54175, leaving $41.75 of somebody else's money on
the balance sheet for ever.

The defect and the gap have the same shape, which is why they are one phase.

## Decision 1: a refund is a settlement, not a payment

Both refunds go through `settleHeld` from Phase 66, unchanged:

```
Dr  held liability     releasedCents   at the rate the money has been carried at
Cr  bank                                 paidCents at the rate on the day it left
    7100 FX                              realisedCents, the difference
```

Three amounts, three sources, none of them guessed:

- `releasedCents` comes from `relieveFunctional` on the holding — so the last
  refund takes the whole remaining functional balance and the liability lands
  exactly on zero.
- `paidCents` comes from `rateFor(currency, refundedOn)` — because that is what
  the bank statement will say, and the number the reconciliation needs.
- `realisedCents` is `released − relieved`, so `released === relieved + realised`
  by construction rather than by a rounding argument.

The euro that got dearer while the business held it is a real loss, and it is
realised on the day the money leaves. Nothing about this is new; Phase 66 already
decided it for a *draw*. Giving money back is a draw where the other side is the
bank rather than a receivable.

## Decision 2: a refund is a record, not just an entry

`retainer_refunds` stores all three amounts and the rate, alongside the date,
reference, bank account and journal entry. A refund that stored only its face
amount would be Phase 65's defect again — a fact the code has and does not keep —
and the reconciliation would have no way to tell $10,835.00 of liability from
$11,000.00 of cash.

The retainer's `remaining_cents` is taken down under a conditional update, so two
refunds racing cannot both succeed against the same balance. The check constraint
Phase 66 added — `(remaining_cents = 0) = (functional_remaining_cents = 0)` —
guards the pair from either side stranding a cent, exactly as it caught the first
draft of `settleHeld`.

## Decision 3: `mayUse` names the currency it is refusing in

`mayUse` has said "Only 8515.00 is held" since Phase 53. That was fine while
every holding was in the company's own currency and became an unlabelled number
the moment Phase 62 let a receipt arrive in euro — a client asking for €9,000 back
was told a bare figure that could have been either currency.

`currency` is **optional**, so every caller written before this phase keeps the
sentence it had, and the ones that know the answer say it. This is Phase 47's
rule again: a refusal belongs on the row, and it has to say what is actually
wrong with *this* row.

## Consequences

- A retainer can be given back, in the currency the client sent it in, and the
  liability it sat on can reach zero.
- A euro overpayment refunded now clears the whole liability instead of its face
  value. This was a live defect from Phase 62 until this phase, on any company
  that took a foreign receipt for more than it was owed.
- `7100 Foreign Exchange Gain or Loss` picks up the movement between the day the
  money arrived and the day it went back — for both kinds of holding, from one
  function.
- The time screen lists what is still held and offers to return it, so the
  operation is reachable rather than only callable.

## What this does not do

- **A vendor's overpayment cannot be recovered.** Paying a supplier more than was
  owed leaves *them* owing *us*, which `splitReceipt` has refused since Phase 53
  on the grounds that vendor credits already cover it. They do — but a vendor
  credit that will never be spent, because the relationship ended, has the same
  no-way-out shape this phase just fixed for retainers.
- **A refund cannot be voided.** Phase 52 taught payments to unwind and put back
  what they settled; a refund recorded against the wrong retainer, or for the
  wrong amount, has no correction but a manual journal.
- **Nothing here goes near the bank.** A refund records that money left; it does
  not move it. That seam is Phase 44's payment provider, which is inbound only.
- **The payment composer still has no currency of its own**, unchanged from ADR
  0065 and ADR 0066.
