# 0115 — The check that compared euros with dollars

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 115

---

## The defect

ADR 0114 nominated a functional column on `payment_applications`, to promote
`receivables.customer_credit` to `any_date`. Verifying that before adopting it
found something in the way again — and this time in the check itself.

`heldCredits` selects the held amount in the **payment's own currency**:

```ts
availableCents: payments.unappliedCents,
```

and `receivables.customer_credit` adds those rows up and compares the total
against a ledger balance:

```ts
const heldTotal = rows.reduce((sum, row) => sum + row.availableCents, 0)
const ledgerCents = account ? await balanceForAccount(ctx, account.id) : 0
return { agrees: heldTotal === ledgerCents, ... }
```

`balanceForAccount` is functional — every journal line in this system is. So a
euro overpayment puts **€2,000 against $2,200** and the check reports broken
books on correct ones.

This is Phase 65's defect — *"the three sums that still add currencies"* — for a
fourth time, and `payments.functional_unapplied_cents` has existed since that
phase for exactly this. Phase 65 closed the three it found in
`parties/service.ts` and in the statement; this one was in the register, where
nobody was looking.

It is a **fault**, not a position, and the check is ungated: `module: null`, so
every company runs it nightly. A business that took one overpayment in a
currency other than its own got a red nightly report for ever, on books that
were right.

### Why Phase 114's tests did not catch it

They applied the held credit **in full**. Both sides came to zero, and zero is
zero in any currency. The measurement test for this phase therefore leaves the
credit unspent, which is the state the check exists to examine.

### Measured

€5,000 received in January against a €3,000 invoice at 1.10, leaving €2,000 held
and carried at $2,200. Against the code as it stood:

```
FAIL  says what that is worth in the company's own money as well
      expected undefined to be 'EUR'
FAIL  agrees on a euro credit nobody has spent
      expected 200000 to be 220000
FAIL  adds two currencies without adding two currencies
      expected 240000 to be 260000
```

## Decision: the row keeps the customer's money, the sum takes the company's

`heldCredits` now carries three figures instead of one:

```ts
availableCents: payments.unappliedCents,           // what the customer sent
currency:       payments.currency,                 // which money that is
functionalCents: payments.functionalUnappliedCents, // the company's own money
```

and the check sums `functionalCents`.

The split is the point. A person reading a list of held credits wants the figure
their customer would recognise on their own statement — €2,000, not "about
$2,200". A *total* cannot be that figure, because two rows may be in two
currencies and their sum would be a number in no currency at all. Both are
right; they answer different questions, and the repair is to have both rather
than to pick one.

The nearest precedent is in this codebase already. `parties/service.ts` sums
`functional_unapplied_cents` for the balance it nets, and runs a **second pass**
grouped by currency for what it displays — with prose saying why. This phase
does the same thing in one query, because `heldCredits` returns rows rather than
a roll-up.

## The same defect three more times, on the same screen

Verifying the repair in the browser showed the payments screen rendering a
€5,000 receipt as **$5,000.00**. `formatCents` has taken a currency argument
since Phase 35 and this screen passed it nowhere, so:

- **Each row's amount** now renders in `row.currency`.
- **The RECEIVED and PAID OUT tiles** summed `amountCents` across rows. They now
  sum `functionalAmountCents`, converted once in `listPayments` at the rate
  fixed when the money moved — not today's, which would restate what the
  business banked every time a currency moved. On the seeded books the received
  total moved from $37,668.00 to **$38,568.00**: two euro receipts, €5,000 and
  €4,000, that had been counted at their face value.
- **The void panel's restoration lines** say what a document goes back to. That
  is the **document's** currency, not the payment's — `payment_applications`
  records what the document was relieved by — so a dollar receipt settling a
  euro invoice puts euro back onto it.

The restoration currency rides *alongside* `restorationsFor` rather than through
it. What a document goes back to, and whether that leaves it open or partial, is
a decision about amounts; which currency they are denominated in changes none of
it. Widening the pure core to carry a field it only hands back would be carrying
data for a renderer.

## What this cost, and what it bought

`tests/overpayment.test.ts` had a test that tampered with `unapplied_cents`
alone to prove the check notices a subledger moved behind the ledger's back.
Since the check now reads the functional column, that tamper is invisible to it
— and correctly so: the functional column still agrees with the ledger, and the
books really are consistent. What is broken is the relationship between a
payment's **own two columns**, which is a different question.

The test was rewritten to move both columns, which is what a tamper on a
single-currency company looks like anyway. A second test was added recording the
gap explicitly, rather than leaving somebody to find it:

> `does not see a face amount moved on its own`

## What this does not do

**It still does not promote `receivables.customer_credit` to `any_date`.** Eight
checks remain `today_only`, thirteen reach any date. ADR 0113's nomination
stands: the functional amount an application took off the held credit, kept on
the `payment_applications` row.

**Nothing yet checks a payment's two columns against each other.** The exact
form it takes is not a conversion with a tolerance — `relieveFunctional`'s rule
that the last draw takes the whole remaining functional balance means the two
columns need not track a rate exactly in between. It is that **they must reach
zero together**: a receipt holding a face amount with no functional amount
behind it, or the reverse, is a stranded cent. One half of that is already
caught, because `heldCredits` filters on `unapplied_cents > 0` and a payment
with functional money and no face money drops out of the sum while its money
stays on `2520`. The other half is not, and it wants its own check key, its own
severity, and its own verified reach declaration — which is a phase, not a
clause bolted onto a check that already answers a different question.
