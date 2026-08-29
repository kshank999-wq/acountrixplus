# ADR 0062 — The money that did not know its own currency

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §35. `recordPayment` worked out what currency a payment
  was in, used it to fetch the rate, and never stored it.
- **Builds on:**
  [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0053](0053-the-money-you-cannot-bank.md),
  [ADR 0054](0054-the-letter-that-asks-for-money-we-are-holding.md),
  [ADR 0058](0058-telling-a-supplier-what-a-payment-was-for.md),
  [ADR 0061](0061-the-statement-that-told-the-customer-a-made-up-number.md)

## Context

ADR 0061 hit a wall it could not get past, and said so:

> `payments.unapplied_cents` is what a receipt had left over, and **nothing on
> the payment records which currency that receipt was in** […] so the only
> currency it can safely be read as is the company's own.

That was true, and it was not inevitable. `recordPayment` has done this on every
payment since Phase 35:

```ts
const paymentCurrency = await documentCurrency(ctx, input.kind, input.applications)
const paymentRateMillionths = (await rateFor(ctx, paymentCurrency, input.paymentDate)).rateMillionths
```

The answer was known at the moment the row was written, used once, and thrown
away. That is the third time this project has found the same shape: Phase 55's
`sent_at` written by nothing, Phase 59's `paid` list discarded by a `catch`, and
now this. **A fact the code has and does not keep.**

The cost lands on `unapplied_cents` — money a customer overpaid — which five
separate queries sum across a party's receipts and read as the company's own
money. A customer who overpaid a €4,000 invoice by €500 was recorded as holding
$500, and told so on a statement.

## Decision 1: store what was already computed

`payments.currency`, set from the value `documentCurrency` returns, backfilled
from each payment's applications. There is no new rule and no new derivation —
the column holds an answer the code has always had.

The backfill's fallback for a payment that settles nothing is the company's own
currency, which is both the only answer available and the right one: a customer
paying in advance pays in the currency they are billed in.

## Decision 2: one rule, where there were two

`documentCurrency` in `service.ts` decided this for a payment being **recorded**.
`remittance-send.ts` decided it again for a payment being **described**, as
`bills[0]?.currency ?? row.company.currency`. They agreed, and nothing made them
keep agreeing.

Both now go through `settlementCurrency`, and the remittance advice reads the
stored value rather than deriving it a second time. The refusal sentence for a
payment settling two currencies is kept word for word, so the message a person
already knows does not change under them.

## Decision 3: net each currency against its own balance

This is what the column buys. `netByCurrency` composes Phase 54's `netPosition`
once per currency — composed rather than reimplemented, so the single-currency
answer is byte-for-byte the one Phase 54 has given since it was written.

A euro credit now meets a euro invoice; a dollar credit does not. That is what
the customer will have done in their own ledger, and what they expect the
statement to have done.

A currency appears if the customer owes in it **or** the business holds in it.
Holding €500 for a customer who owes nothing in euro is exactly the case Phase
53 built the column for, and dropping it would hide money the business owes back.

## Decision 4: the frozen statement freezes the positions too

Phase 55's rule is that a saved statement keeps saying what it said. So
`positions` is frozen into `figures` alongside the held total — because the held
total alone cannot say which currency it was in, and the document's whole
purpose is to be the thing a customer reconciles against months later.

Absent on every statement frozen before this phase, which read as the company's
own currency and still does. No backfill: rewriting what an old statement
claimed is the one thing freezing exists to prevent.

## Decision 5: two of the five, and honestly so

Knowing the currency fixes the two places that net a credit against a
**particular** balance — the statement and the chase decision. The chase query
now joins held credit on the invoice's currency, because a credit that could not
settle this invoice is no reason to leave it unchased.

It does **not** fix the three that want one comparable figure across every
currency a party holds: the customers screen, the statement run's minimum-balance
floor, and the statements picker. Those need the payment's *rate* as well as its
currency — another column and another backfill — and half-doing it would have
put a converted-looking number next to an unconverted one.

## Consequences

- A €500 overpayment reads as €500 everywhere it is netted or shown to the
  customer, rather than $500.
- The remittance advice reads a stored fact instead of re-deriving one.
- ADR 0061's recorded limitation is closed for the statement.

## What this does not do

- **Three of the five held-credit sums still add currencies.** Named above.
- **Credit notes still carry no currency.** `credit_notes.total_cents` and
  `remaining_cents` are bare numbers, so a vendor credit raised against a euro
  bill is spendable against a dollar one. It is the identical defect one table
  over and it deserves the same treatment.
- **Balance-forward statements are still only right for one currency.** Their
  running balance is a sum of *movements*, and while a payment now has a
  currency, a credit note does not — so the fix waits on the point above.
- **Two more screens print the wrong symbol**, found while verifying this one:
  the invoices list shows Bremen's €2,500 invoice as `$2,500.00`, and the
  payment composer's notice said "$500.00 more than was owed is held as credit"
  for a euro receipt. Neither is a wrong decision — both are `formatCents` called
  without the document's currency — but both are the same class as Phase 61 and
  should be swept together rather than found one at a time.
