# 0114 — The credit spent at a rate it was never carried at

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 114

---

## The defect

ADR 0113 nominated adding a functional column to `payment_applications` so
`receivables.customer_credit` could be promoted to `any_date`. Verifying that
before adopting it found something worse in the way: **the check could not have
been promoted, because the settlement it checks is wrong.**

`customer-credit.ts` settles the same liability in two places and only one of
them is right.

`refundCredit` — giving held money back — uses Phase 68's `settleHeld`: it
relieves the held balance at the rate the money came in at, relieves the other
side at its own rate, and posts the difference as a realised gain or loss.

`applyCredit` — spending the credit against an invoice — did neither:

```ts
const functionalCents = convert(amountCents, invoice.exchangeRateMillionths)
...
{ chartAccountId: held.id, debitCents: functionalCents },
{ chartAccountId: control.id, creditCents: functionalCents },
```

while the subledger column beside it came down at the **payment's** rate:

```ts
functionalUnappliedCents: relieveFunctional(
  { ...payment, exchangeRateMillionths: payment.exchangeRateMillionths },
  amountCents,
).functionalBalanceCents,
```

Two rates, one movement. And the rates need not be different currencies to
differ: a euro receipt in January and a euro invoice in June are the same
currency at two rates, which is the ordinary case rather than an exotic one.

### Measured

€5,000 arrives in January against a €3,000 invoice at 1.10, leaving €2,000 held
and carried at **$2,200**. In June, at 1.25, it is applied to a €2,000 invoice
carried at **$2,500**. Before this phase:

```
FAIL  relieves the liability at what it was carried at
      expected -30000 to be +0
FAIL  leaves the subledger and the ledger saying the same thing
      expected +0 to be -30000
FAIL  recognises the rate movement as a realised gain or loss
      the FX account should have been created: expected null to be truthy
```

Three separate consequences of one substitution:

1. **`2520 Customer Overpayments` is left holding −$300** — a liability with a
   debit balance, because the entry took out $2,500 that was never put in.
2. **`receivables.customer_credit` fires**, and it is a **fault**: the subledger
   says nothing is held, the ledger says −$300.
3. **The $300 is never recognised at all.** There is no FX account, because
   nothing ever asked for one. The rate movement simply vanished.

## Decision: settle it the way the rest of the system already does

`applyCredit` now computes both sides with `relieveFunctional` and hands them to
`settleHeld`, exactly as `applyRetainer` has since Phase 66 and `refundCredit`
does a few hundred lines below it in the same file:

```ts
const relief  = relieveFunctional(invoice, amountCents)   // the receivable, at its rate
const release = relieveFunctional(heldCredit, amountCents) // the liability, at its rate
const settlement = settleHeld({
  releasedCents: release.functionalCents,
  relievedCents: relief.functionalCents,
})
```

and posts the difference where a difference belongs: `7100 Foreign Exchange Gain
or Loss`, which is `other_income` rather than revenue because nothing more was
sold — the rate moved underneath a sale that had already happened.

Two smaller things fell out of doing it properly, and both are the same defect
in miniature:

- The invoice's `functional_balance_cents` was recomputed with `convert(...)`
  rather than taken from `relief`. That is a second answer to *what does this
  invoice give up*, and it loses `relieveFunctional`'s rule that the final
  relief takes the whole remaining functional balance — the rule that stops a
  stranded cent.
- `functionalUnappliedCents` called `relieveFunctional` a second time with
  identical arguments. It now reuses `release`, which is the number the entry
  actually debits, so the column and the ledger cannot drift.

## What I got wrong on the way

My first draft of the test asserted the realised loss as **+$300** on the
grounds that a loss is a debit. `7100` is typed `other_income`, and
`balanceForAccount` signs in the account's normal direction — so a debit reads
as **−$300**. The implementation was right and my assertion was wrong; the test
now says so in a comment, because the next person will make the same assumption.

## What this does not do

**It still does not promote `receivables.customer_credit` to `any_date`.** That
remains what ADR 0113 said it needs — the functional amount an application took
off the held credit, kept on the row. This phase makes that promotion *possible*
by making the settlement correct; before it, a restored history would have been
reconstructing a wrong number carefully. Eight checks remain `today_only`.

**It does not sweep the books for damage already done.** Any company that
applied held credit across a rate movement has a residue on `2520` and a missing
gain or loss in a closed period. The nightly check now reports the residue,
which is how somebody finds it; correcting it is a journal entry with a reason,
which the system already supports and which is a bookkeeper's decision rather
than a migration's.
