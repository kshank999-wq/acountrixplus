# 0069 — The refund you could not take back

- **Status:** accepted
- **Date:** 2026-08-29
- **Extends:** ADR 0052 (voiding a payment), ADR 0051 (the ledger half), ADR 0068 (`refunds`).

## Context

ADR 0068 named it:

> **A recovery cannot be voided**, the same gap ADR 0067 left for refunds.
> Phase 52 taught payments to unwind; none of the three refunds can.

A refund is the easiest thing in this system to key wrongly. It is entered from
a bank line, in somebody else's currency, on a day somebody chooses. €500 typed
as €5,000, or the right amount against the wrong credit, was **permanent**: the
balance showed spent, the ledger showed the money gone, and the only move left
was a hand-posted journal that fixed the ledger and left `refunds` still
claiming it happened.

This is the sentence Phase 51 wrote and Phase 52 answered for payments, one
operation further along.

## Decision 1: a reversal looks nothing up

This is the decision the phase exists to make, and it is a **refusal**.

A reversal is not a new economic event. It does not say "the money came back
today at today's rate" — it says *the refund did not happen*. So `reversalOf`
puts back exactly the three amounts the row already carries, and takes no rate
argument at all.

That is only possible because Phase 68 **stored** `carried`, `cash` and
`realised` rather than deriving them. A reversal that had to re-derive would
need the rate on the original day, would round independently, and would leave a
few cents of permanent noise in `7100` every time somebody corrected a typo. The
column that looked like redundancy one phase ago is what makes the correction
exact.

Verified in the browser to the cent: the account stood at $132.00 credit before,
$123.75 after — the $8.25 that recovery realised, and nothing else.

## Decision 2: one function for three refunds

The payoff of Phase 68 collapsing three records into one table. A retainer given
back, a customer's overpayment returned and a supplier's credit recovered are
three operations to *record* and **one** to *undo*, because undoing means the
same thing in all three: put the balance back, put the functional half back,
void the entry, unwind the gap.

Written three times it would be three places for the sign to drift — which is
exactly the defect Phase 68 found in `settleHeld`, where the same two numbers
give opposite answers depending on which side the balance sits.

## Decision 3: the ledger half is a void, not a mirror

`voidJournalEntry` marks the original entry `status = 'void'` and every balance
query filters on posted — the ledger's way since Phase 2, and the path Phase 52
and `voidDocument` already use.

The first draft of this phase's schema had a `void_entry_id` column for a
reversing entry. That would have been a second mechanism for "did this refund
happen", and the books would have had two answers. The column is gone;
`journal_entry_id` already names the entry, and voiding it is the whole ledger
half.

`voidJournalEntry` also calls `assertPeriodOpen`, so the closed-period rule is
enforced twice: once in `refundVoidability` with a sentence naming the date, and
once in the ledger as the guard of last resort. The first is for the person, the
second is for the books.

## Decision 4: `refunds` keeps the currency it always knew

`refunds.amount_cents` was documented as "in the other party's currency" and the
currency was never stored. Every reader had to join back to the retainer,
payment or credit note to find out what money the number was in — noticed the
moment a reversal had to print the figure back to somebody.

That is Phase 65's defect a **fifth** time: *a fact the code has and does not
keep.* The service knew it at the moment it wrote the row and threw it away.
Backfilled from each subject, which is exactly the join it removes.

## What is deliberately not refused

There is **no ceiling check**. Putting back what a refund took can never
overfill the balance it came from, because `total = applied + refunded +
remaining` holds by construction — the face amount only goes down and
`relieveFunctional` keeps the functional half in step. A refusal for a case that
cannot arise is a refusal somebody has to read and reason about for ever.

Three refusals do exist, each naming a record that would otherwise be left
saying something untrue: already taken back, the subject voided since, and the
period closed.

## Consequences

- Any of the three refunds can be corrected, and the correction is exact.
- `refunds` is listed on the credits screen with what each one is against.
  Refunds were recorded from three screens and visible from none, so "did that
  €500 go back twice?" was a question with nothing behind it.
- A taken-back refund stays on the list, marked — Phase 52's rule that the row
  is the record of what somebody did.

## What this does not do

- **Nothing goes near the bank.** A reversal records that the refund did not
  happen; it does not recall a wire. If the money really moved, the correction
  is a new refund in the other direction, not this.
- **No reason is required.** `voidRefund` accepts one and audits it, but unlike
  `payment.void` it does not insist. A refund reversed with no reason is a hole
  somebody reconstructs from dates later, and Phase 52 already decided that is
  worth refusing — this phase did not follow it there.
- **The vendor credit form still applies in full**, unchanged from ADR 0068, so
  a partial credit is still only reachable via a partly-paid bill.
- **Three screens still say "Take it back"** for three different operations, and
  this phase adds a fourth use of the phrase on the confirm button. The label
  problem named in ADR 0068 is now slightly worse rather than better.
