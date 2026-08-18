# ADR 0032 — Change is not a transaction

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §13, §12
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0012](0012-the-statements-an-accountant-asks-for.md),
  [ADR 0031](0031-what-is-owed-is-owed-by-somebody.md)

## Context

ADRs 0029, 0030 and 0031 each closed with the same follow-up. Phase 31 closed
it at the ledger — a delivered service now raises a real invoice, which the
aging report can name and Phase 2's `recordPayment` can settle — and said so
explicitly:

> The gap the last three ADRs named is *closed at the ledger*, not yet at the
> till.

This phase closes it at the till. The accounting already existed; what was
missing was the gesture, and one piece of arithmetic that the accounting has no
opinion about.

That arithmetic is the reason this is an ADR rather than a form. A customer
hands over a $50 note for a $20 bill. The business has $50 in its hand and $20
of revenue settled. **The $30 that goes back across the counter is not a
transaction at all** — no account changes, nothing is owed, nothing is earned.
It is the same note travelling back. Software that models it as a $50 receipt
and a $30 disbursement produces two entries where there should be one, doubles
the day's apparent cash movement, and gives the bank reconciliation two rows to
match against a deposit that will only ever show $20.

Five claims, asserted in `tests/counter.test.ts` (18 tests):

1. **Change is not a transaction.** $50 against a $20 bill posts $20.
2. **You cannot give change on a card.** A card over the bill is refused, and
   nothing is taken.
3. **Cash at the counter is not in the bank.** It goes to Undeposited Funds.
4. **One bill, several tenders**, each recorded as its own payment.
5. **Taking the money leaves the control accounts agreeing** — Phase 31's check
   still passes on both sides afterwards.

## Decision 1: the settlement is a pure function, and non-cash is applied first

`tenderFor(dueCents, tenders)` in `src/modules/counter/tender.ts` decides what a
handful of tenders settles. No database, no clock — the eleventh pure core in
this codebase, and the pattern has not stopped paying.

The one rule that is not obvious: **non-cash tenders are applied before cash.**

```
  $80 bill, paid with a $50 card and a $50 note
  card applied first  → $50
  cash covers the rest → $30
  change              → $20
```

Applying cash first would settle $50 of the bill with notes, leave $30 for the
card, and hand back $20 the customer never overpaid in a form the business can
return. Only cash can give change, so cash has to be the tender that absorbs
the remainder. Getting this backwards is not a rounding difference; it charges
the card the wrong amount.

Over-tendering therefore splits by kind:

- **Cash over the bill is change.** It is handed back and posts nothing.
- **Anything else over the bill is an error**, refused with the amount and what
  to take instead:

  > That takes $30.00 more than is owed, and change cannot be given on a card.
  > Take $20.00 instead.

The rejected alternative was to accept the overpayment as a customer credit. It
is defensible for a bank transfer that arrives at the wrong amount, and wrong at
a counter: somebody typing $50 for a $20 card sale has mis-keyed, and the
software's job is to say so before the card is charged rather than to invent a
liability out of a typo. A genuine prepayment is a different transaction, taken
deliberately, and is not what a "take payment" button means.

Cash tenders collapse into **one** applied line — three notes are one payment —
while each non-cash tender stays separate, because each turns into a different
row on a different statement.

## Decision 2: each tender is its own payment

`takePayment` calls Phase 2's `recordPayment` once per applied tender rather
than once for the total.

They are genuinely different events. The card one appears on a merchant
statement in a batch three days later; the cash one appears in a deposit slip
when somebody walks to the bank. A bank reconciliation has to match each against
the thing it actually became, and one combined payment matches neither.

The cost is stated rather than hidden: `recordPayment` runs each in its own
transaction, so a failure part-way leaves the earlier tenders recorded. That is
the truthful outcome — the card really was charged — and the remaining balance
says what is still owed. Wrapping all of them in one transaction would be
tidier and would lie about a card that has already gone through.

## Decision 3: it lands in Undeposited Funds by default

Money taken at a counter is not money in a bank, and Phase 12 already built the
account that says so and the deposit slip that clears it. `takePayment` defaults
there for **every** tender kind, not only cash.

Card takings get the same treatment on purpose. A card sale at 10am is not in
the bank at 10am; it is in a batch that settles net of fees on a schedule the
acquirer decides. Posting it straight to the bank account makes the day it
actually arrives unreconcilable. Undeposited Funds is the honest holding place
for both, and the UI says so:

> Takings go to Undeposited Funds — a note in the drawer and a card batch not
> yet settled are both money at the counter, and neither is money in the bank
> until somebody banks it.

A caller that genuinely knows where the money went can pass
`financialAccountId` and skip the holding account.

## Decision 4: the control is one shared component

`src/components/take-payment.tsx` is used by both the appointments board and the
shop. Not for reuse — it is eighty lines — but because it mirrors `tenderFor`
client-side to show change *before* anything is submitted, and **that mirror has
to be identical in both places or one of them is wrong.**

Somebody counting notes out of a drawer needs the number in front of them at the
moment they are counting, not in a confirmation afterwards. So the amount
defaults to what is owed, cash is preselected, the change appears as the figure
is typed, and an overcharge disables the button rather than waiting for the
server to refuse it. The server still decides; the client is a preview.

## Consequences

- **A delivered visit and a billed repair order can now be paid in one press.**
  Both boards show what is owed on the row, `paid` when it is settled, and the
  control only where there is something to take.
- **The change figure is shown, not posted.** Anyone reconciling a till drawer
  against the ledger will find the ledger says $20 where the drawer saw $50 in
  and $30 out. That is correct and is the point, but it is a thing to know.
- **Partial payment is ordinary.** Under-tendering takes what was offered and
  leaves the rest owing; the row keeps its control.
- **There is no split-tender UI.** `takePayment` and `tenderFor` handle several
  tenders on one bill and the tests cover it, but the on-screen control takes
  one at a time — pressing it twice does the same thing, which is why this was
  not worth a second form.
- **No cash drawer, no shift, no Z-reading.** This settles a named invoice. A
  till that is opened, floated, counted and closed by a named person is Phase
  28's `pos_import` shape and a different piece of work.
- **Gift cards remain their own path.** `redeemGiftCard` already settles the
  invoice from Phase 31, so the `gift_card` tender kind exists in the core and
  is deliberately absent from the on-screen list — offering two ways to spend a
  card is how one gets spent twice.

## Follow-up

1. **A drawer and a shift** — float, count, over/short, and a named person
   closing it, so the change that never posts still has somewhere to be
   accounted for at the end of a day.
2. **Split tender on screen**, once a real counter asks for it.
3. **Run `controlAccounts` nightly** in Phase 24's health checks — still
   outstanding from ADR 0031, and now more useful, because there is a second
   way for a receivable to move.
4. **Card fees**, which are why a card batch settles net and why Undeposited
   Funds cannot simply be swept to the bank at face value.
