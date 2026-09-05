# 0134 — The account where three currencies met

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 134

---

## How this was found

ADR 0133 banked a nomination: `importPayouts` is "the one of the ten with the
shortest road out", because `payouts` carries a currency of its own and nothing
compares it to the account's.

Measuring it before adopting it — the rule since Phase 104 — showed the
nomination was **understated**, and the correction is recorded in ADR 0133
rather than here. `batch.currency` is written to `payouts.currency` and never
read again. The entry posted `batch.amountCents` unconverted, so a euro payout
into a *domestic* account posted €X as $X. Phase 133's guard does not catch
that: `mayPostToBank` asks about the account and never about the money.

## Three postings, one account, and not one money

Phase 44 built `1250 Payments in Transit` on a three-line story, written at the
top of `settlement.ts` and still true:

```
Payment captured:  Dr Payments in Transit / Cr Accounts Receivable (gross)
Fee taken:         Dr Merchant Fees       / Cr Payments in Transit
Payout arrives:    Dr Bank                / Cr Payments in Transit (net)
```

Measured, the three lines were not in the same money. `recordPayment` debits
`receivedCents` — **converted**, and declared so. `postFee` credited the face
fee; `importPayouts` credited the face payout.

A €100 card payment on a dollar-keeping business, at 1.10:

| Line | What the ledger took | What it should have been |
| --- | --- | --- |
| Capture | Dr 1250 **$110.00** | $110.00 |
| Fee (€5) | Cr 1250 **$5.00** | $5.50 |
| Payout (€95) | Cr 1250 **$95.00** | $104.50 |

**$10.00 stays in the account.** It is not a balance, not a fee and not a gain,
and no report names it. `checkouts.currency` is `invoice.currency`, so a euro
invoice paid by card produces this today.

## The two declarations that said so out loud

Both offenders were declared `domestic` in `LEDGER_POSTINGS`, and both arguments
end the same way:

> `postFee` — "domestic only while the account is, which is a fact about the
> data rather than about the schema."
>
> `importPayouts` — "domestic only while those agree with the company's own — a
> fact about the data, not a guarantee from the schema."

Both were **corrected in Phase 128**, and both corrections fixed the
*description* of where the currency lives while leaving the *posting*
unconverted. Phase 133 then enforced one half of the second hedge — that the
bank account agrees — and left the other standing.

That is Phase 110 and Phase 125's class, in its most legible form yet: not a
declaration argued from a fact that is not a fact, but one **arguing from a fact
it admits is not guaranteed**. The columns this phase adds are those two hedges
turned into facts about the schema.

## Why the clearing account is relieved of what it was charged

The rate the day the customer paid is not the rate three days later when the
processor settles. Both are real, and each belongs on exactly one line:

- The **bank** takes what actually arrived, at the arrival rate.
- The **clearing account** gives up exactly what was put into it, at the capture
  rate — because an account relieved at a different rate from the one it was
  charged at can never reach zero, and reaching zero is the only thing a
  clearing account is for.
- The **difference** is a realised exchange gain, posted as one.

That is Phase 67's rule for retainers, applied to money a processor holds
instead of money a client does.

`clearedCents` is summed from what the earlier entries *actually posted*, read
from `checkouts.functional_gross_cents` / `functional_fee_cents` rather than
recomputed. Phase 35's rule — convert the parts and total the conversions — and
here not a nicety: three €3.33 charges convert to 366 each, totalling 1098,
while their €9.99 total converts to 1099. Recomputing would leave a **correct**
batch a cent adrift, which reads exactly like a real discrepancy.

## A scan that was excusing a site

Adding the columns to `FACE_COLUMNS` should have made Phase 122's scan catch
`heldByProcessor`, which sums `gross_cents - fee_cents` with no currency in it
anywhere and is compared against a ledger balance the books keep in their own
money. It did not.

`currencyAware` read a fixed window — fifteen lines back, twenty-six forward —
and found `currency: checkouts.currency` on line 790, inside `recentCheckouts`,
a different function two boundaries and twenty-four lines below the sum.

**This is the fourth form of the same failure.** Phase 128 found it in the
posting scan, Phase 131 in the screen scan, Phase 133 in the bank-posting scan.
Those three *missed* sites. This one **excused** one, which is worse: a miss
leaves a site undeclared and visible as an absence, an excuse makes the scan
report all clear.

Bounded by the enclosing function it catches that site and only that site.

## What this retires

`payoutReconciliation` answered the same question as `payoutSettlement` in one
currency, and after the wiring its only callers were its own tests — Phase 49's
class, created by this phase's own change. Retired with its two orphaned types.

Its four cases are **ported** rather than deleted. Two assertions went with it,
about `grossCents` and `feeCents`: nothing read those, and `payouts` stores
`expected_cents` rather than the halves.

## What this does not do

**It does not settle a foreign payout into a foreign account.** Phase 133 still
refuses that, and rightly — a euro payout into a euro account should not be
converted at all, and nothing yet says so. This phase handles the case a
business actually hits first: a foreign charge settling into the account the
books are kept in.

**It has no test against the database yet.** The core is proved without one and
the six affected suites pass, but the pattern every recent phase has followed —
a second test that runs the same rule through Postgres — is not here. That is a
stated gap, not an oversight, and it is the first thing the next stretch owes.

**It leaves the dev database un-migratable.** Found in passing and unrelated to
this phase: `accountrix` has the columns from migrations 0075–0077 but its
`__drizzle_migrations` ledger does not record them, so `npm run db:migrate`
collides on a column that already exists. A `db:push` in an earlier phase is the
likely cause. The test database is unaffected and this phase's migration was
applied to dev by hand.
