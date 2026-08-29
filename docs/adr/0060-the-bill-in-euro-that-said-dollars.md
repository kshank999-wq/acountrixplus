# ADR 0060 — The bill in euro that said dollars

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §19. The whole payables screen added document amounts
  together as though every supplier invoiced in the company's currency.
- **Builds on:**
  [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0049](0049-what-you-owe-and-choosing-what-to-pay.md),
  [ADR 0050](0050-the-payment-nobody-approved.md),
  [ADR 0056](0056-the-balance-that-added-currencies-together.md),
  [ADR 0059](0059-the-pay-run-that-half-happened.md)

## Context

ADR 0059 recorded this as a known limitation and nominated it:

> `unpaid_cents` comes from `planRun`, which sums document amounts, so a
> supplier owed €4,000 and $4,000 records $8,000 still owed. […] It is the
> defect ADR 0056 fixed on the customers screen and has not yet been fixed here.

Looking properly, it was not one figure. `payableQueue` never selected
`currency` or `functional_balance_cents` at all, so **every** number on "What we
owe" was computed from an amount whose currency nobody downstream knew:

- the four bucket cards (Overdue / Due today / Due this week / Later),
- "$10,400.00 outstanding in total",
- the per-supplier lines and the figure on the **Pay** button,
- the coverage comparison against the bank balance,
- Phase 50's approval threshold,
- Phase 59's `unpaid_cents`.

And the row itself. A €4,000 bill rendered as **`$4,000.00`** with no marker of
any kind — the screen did not merely add wrongly, it did not know there was
anything to add.

This is worse than the customers-screen version in one specific way. Phase 56's
defect produced a wrong number on a report. This one produced a wrong number on
a screen with a button that **spends money** underneath it.

## Decision 1: two amounts, because one cannot answer two questions

`PayableBill` now carries both:

- **`balanceCents`** is what the supplier is owed, in the currency they invoiced
  in. It is what will be paid, what the remittance advice shows (Phase 58), and
  what appears on their row. Converting it would be telling a German supplier
  they are owed dollars.
- **`functionalBalanceCents`** is what that is worth in the company's currency.
  It is the only figure that may be **added up or compared** — against the bank
  balance, against an approval threshold, against another supplier's bill.

The rule is short enough to state once: *a sum only means something when its
terms are in one currency; a supplier is only owed money in theirs.* Every
change in this phase falls out of it.

## Decision 2: a mixed-currency supplier has no total, rather than a wrong one

One payment per supplier is how the money leaves (ADR 0049), and a single
transfer cannot be €4,000 and $1,000 at once. So `SupplierRun.totalCents` is
**null** when the chosen bills disagree, and `currency` with it.

Null rather than a converted figure, deliberately. A converted total would be a
number the business could not actually send: the supplier's bank expects euro
for the euro invoice and dollars for the dollar one, and printing `$5,320` would
invite somebody to key exactly that and be wrong twice.

`payableAsOneTransfer` is a type guard, so `PayableSupplierRun` — the type
`planRun` hands on to the Pay button and to `recordPayment` — is the type that
provably has an amount in a currency.

## Decision 3: the refusal moves before the press

`planRun` returns `blocked` alongside `suppliers`, and the screen names them.

Phase 59 made a failure in the middle of a run survivable and honestly reported,
and that remains the right safety net for what cannot be predicted — a bill
voided between the tick and the press, a period closed underneath you. But this
one **can** be predicted from the selection, and Phase 47's rule is that a
refusal belongs on the row rather than behind a button that fails when pressed.

`executePayRun` seeds its failure list from `plan.blocked`, so a blocked
supplier reaches the outcome as a `BatchFailure` without ever being attempted.
The run still reads as partial and still says who was left out; the only
difference is that no payment was tried and the sentence is the earlier one.

## Decision 4: the approval threshold is compared in the company's currency

The most serious of the five, because it is not a wrong number — it is a control
that was quietly off.

Phase 50 lets a company say "bills of $1,000 and up need approving, and not by
the person who entered them." `approvalState` compared the bill's **document**
amount against that. At 1.08, a €950 bill is $1,026: over the line, and
`95_000 < 100_000` said it was not. So a foreign bill above the threshold could
be entered and paid by one person, which is the exact thing Phase 50 exists to
prevent.

`ApprovableBill` now carries `functionalTotalCents` and the comparison uses it.
Making the field required rather than optional was deliberate: an optional one
with a fallback to `totalCents` would have let a future call site silently
reintroduce the hole, and the compiler found all four call sites in a second.

## Consequences

- A euro bill reads `€4,000.00`, with what it is worth to us underneath it.
- Every total on the screen — buckets, headline, Pay button, coverage — is in
  the company's currency and says so.
- A foreign bill can no longer slip under the approval threshold.
- ADR 0059's recorded limitation is closed: `unpaid_cents` is a conversion now
  rather than a sum of unlike things, and the test that pinned the old figure
  says so in its comment.

## What this does not do

- **It does not convert at today's rate.** `functional_balance_cents` is what
  Phase 35 booked the document at, which is the right figure for comparing
  against the ledger and the wrong one for asking "what will this cost me on
  Friday?". The unrealised-gain report (Phase 35) is where that question is
  answered, and joining the two is its own phase.
- **It does not offer to split a mixed supplier into two runs.** It says to
  untick all but one currency and pay the rest in a second run, which is the
  honest instruction; doing it for them means deciding which currency goes
  first, and that is the business's call about which supplier can wait.
- **The receivables side of the same screen pair is done** (Phase 56), but
  Phase 43's chase queue has not been checked for this defect. It compares an
  invoice balance against a minimum-balance threshold in exactly the shape that
  was wrong here.
