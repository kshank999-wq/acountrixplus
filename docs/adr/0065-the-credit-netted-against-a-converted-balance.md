# ADR 0065 — The credit netted against a converted balance

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §35. Three screens subtracted a face-amount holding
  from a converted balance and printed the result with a dollar sign.
- **Builds on:**
  [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0053](0053-the-money-you-cannot-bank.md),
  [ADR 0054](0054-the-letter-that-asks-for-money-we-are-holding.md),
  [ADR 0062](0062-the-money-that-did-not-know-its-own-currency.md),
  [ADR 0063](0063-the-euro-invoice-you-could-not-credit.md)

## Context

ADR 0062 named three sums that "want one comparable figure across every currency
a party holds", and ADR 0063 and 0064 both left them open for want of the
payment's rate. Read properly, the defect is sharper than *these sums add
currencies*. The customers screen builds a party's standing out of two:

```sql
balanceCents:    coalesce(sum(invoices.functional_balance_cents), 0)
heldCreditCents: coalesce(max(held_credit.held_cents), 0)   -- sum(unapplied_cents)
```

The first is **converted**. The second is the **face amount**. Phase 54 then nets
one against the other to decide what the customer should pay.

Bremen Hafenbau, in the development database: a €4,000 invoice carried at
$4,334.00, and a €500 overpayment. The screen showed **$3,834.00** due —
`4334.00 - 500` — a figure that is not dollars, not euro, and not what anybody
owes. Two more queries did the same: the statement run's minimum-balance floor,
and the statements picker.

## Decision 1: keep the two facts the code already had

`recordPayment` has done this on every payment since Phase 35:

```ts
const paymentRateMillionths = (await rateFor(ctx, paymentCurrency, ...)).rateMillionths
...
const heldFunctionalCents = receivedCents - appliedFunctionalCents
```

The rate is fetched, used once, discarded. The functional value of the held
amount is **computed outright** and discarded. Phase 62 kept `paymentCurrency`
from the line above these and left both behind.

That is the **fourth** time this project has found the same shape — Phase 55's
`sent_at` written by nothing, Phase 59's `paid` list discarded by a `catch`,
Phase 62's `paymentCurrency`, and now this. It is worth naming as a class: *a
fact the code has and does not keep.* Nothing here is new arithmetic; the
columns hold answers `recordPayment` has always had.

`heldFunctionalCents` is `received - applied`, not a conversion of the
difference. The receipt's ledger entry splits the money that arrived into what
it settled and what is left, so the two halves have to add back to the amount
that hit the bank.

## Decision 2: one comparable figure, and the truth beside it

`comparableHoldings` returns the functional total, the per-currency holdings, and
a sentence.

Phase 61's `describeBalances` refuses to total two currencies, and is right to
for a statement: a customer is owed money in theirs, and a sum of two currencies
is payable in neither. But "which of my customers is holding the most of my
money" is a different question and it *has* an answer — what those receipts were
worth when they arrived, which is what the books carry them at. A screen that
ranks parties and applies a minimum-balance floor needs exactly that.

So the figure is converted, and the screen says so:

> €500.00 held. The $541.75 shown is what that was worth when it was received —
> it is repayable in the currency it came in.

Null for a party holding only home currency: the figure and the truth are the
same number, and a line explaining it would teach people to stop reading.

Each receipt's own conversion is summed rather than the total reconverted. A
holding built from two receipts a month apart has two rates behind it, and
re-deriving from either would restate money already banked.

## Decision 3: both halves move together

`applyCredit` and `refundCredit` now move `functional_unapplied_cents` alongside
`unapplied_cents`, through `relieveFunctional` — the rule the invoice and the
credit note already use, so the last movement takes whatever functional
remainder is left and neither column strands a cent behind the other.

This is the defect Phase 63's browser check found on credit notes, caught here
before it shipped rather than after.

## Decision 4: the vendor mirror, one table over

`listVendorSummaries` had the identical bug against `credit_notes.remaining_cents`
— a face amount netted against `sum(bills.functional_balance_cents)`. Phase 63
gave credit notes the functional column that makes it comparable, so it costs one
word to fix and would have been dishonest to leave.

## Consequences

- Bremen's standing reads **$4,334.00 billed − $541.75 held = $3,792.25 due**,
  every term in one currency, with the euro truth stated beneath.
- The statement run's floor and the statements picker compare like with like.
- The payment composer names amounts in the payment's own currency, closing the
  wrong-symbol notice ADR 0062 recorded and 0063 and 0064 left open.

## What this does not do

- **The backfill reconstructs, and says so.** It re-derives each payment's rate
  by walking backwards through `exchange_rates` — `rateFor`'s rule written a
  second time, in SQL. Accepted because a backfill must be SQL and runs once.
  Its first draft was worse and the data caught it: reconstructing the held
  amount from `amount - applications` claimed $200.00 was still held on a receipt
  that had been refunded, because a refund leaves no application behind.
  `unapplied_cents` is the only column that knows what is left *now*.
- **A historic foreign holding can be a cent from its running total.** The
  backfill converts the remainder; the going-forward code relieves each draw's
  own share. A cent on old rows is the price of not being $200.00 wrong on one.
- **The retainer draw is still refused in a foreign currency**, unchanged from
  ADR 0063's Decision 4. It is a settlement decision and still needs one.
- **A foreign invoice still cannot be paid from the payment composer's own
  currency field**, because it has none — it infers the currency from the
  documents being settled, which is right for a receipt against invoices and has
  nothing to say for a payment on account in a currency the party has no open
  documents in.
