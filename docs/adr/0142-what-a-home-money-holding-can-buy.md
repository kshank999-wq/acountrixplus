# 0142 — What a home-money holding can buy of a foreign document

**Status:** accepted
**Date:** 2026-09-11
**Phase:** 142

---

## How this was found

ADR 0141 nominated `redeemGiftCard` and said something unusual about it: that it
was the one finding `PENDING_WIRING` **could not hold**, because the register
requires a core that exists and none answered this question.

Verifying that claim before taking it, since Phase 139 found three consecutive
ADRs nominating `recoverWriteOff` as though something had to be built when the
piece was already there:

- `convert(faceCents, rateMillionths)` goes face → functional.
- `rateFrom(amountCents, functionalCents)` derives a **rate** from a pair.
- `relieveFunctional(document, faceCents)` takes a face amount and returns what
  the document's own column moves by.
- `spends(...)` takes a face amount and says whether a holding can afford it.

Every one of them starts from a face amount. Nothing in the codebase goes the
other way, so the nomination is right and this is the **first inverse of
`convert`** here.

## The defect

```ts
const dueCents = bill.balanceCents          // the invoice's FACE balance
const plan = redeemFor(card.balanceCents, dueCents)
```

`gift_cards` has no currency column and no functional twin. ADR 0029 argued that
a card cannot be foreign by construction, and that is true **of the card**. It is
not true of the invoice the card is spent against, which `redeemGiftCard` finds
by `appointment.invoiceId` and asks nothing about.

So the `min` inside `redeemFor` compares a dollar with a euro — Phase 122's rule,
in the decision that says how much of a debt is forgiven. Then
`plan.appliedCents` posts to **both** journal lines while the invoice's functional
twin comes down by `relieveFunctional(bill, plan.appliedCents)`, which converts.

Measured. A €1,000 invoice carried at 1.10 is $1,100 on the books. Redeem a $600
card against it today:

| | moves by |
| --- | --- |
| Accounts Receivable, in the ledger | **$600** |
| the invoice's functional balance | **$660** |
| the customer's debt | **€600**, which is $660 of it |

The control account and the subledger part company by $60, so
`ledger.receivables` raises a `fault` every night — the Phase 137 shape, in a
path Phase 137 did not reach — and the business has given away $660 of debt for a
$600 card.

It should buy **€545.45**, which costs exactly $600.

## Why a new core rather than a mode on `spends`

Measured rather than asserted: `gift_cards` and `deposit_movements` are the only
tables that hold the company's own money and settle a document with it.
Everything else that calls `relieveFunctional` — retainers, credit notes, held
customer credit, vendor credits — carries a currency and a rate of its own, which
is what Phases 62 through 68 were about.

Two holdings, and they ask different questions:

- **`spends`** (Phase 138, for `applyDeposit`) — *this much: can the holding
  afford it?* A person types how much of a tenant's deposit to keep, and the
  answer is yes or a refusal naming both figures.
- **`affords`** (this phase, for `redeemGiftCard`) — *as much as it can: how much
  is that?* Nobody types an amount when a card is redeemed. The card pays what it
  can and the rest stays owing.

Giving `spends` an "or as much as you can" mode would make one function answer
two questions, and its refusal — the thing it exists to produce — is meaningless
for a card: a card that cannot cover the bill is the ordinary case, not an error.
That is Phase 130's rule, argue a new value rather than bending the nearest.

## What it returns, and what it deliberately does not

`affords` returns a **face** amount and nothing else about money.

The functional figure is then `relieveFunctional(document, faceCents)`, which
already exists and already gets the hard part right: when the face balance lands
on zero it returns the carried `functionalBalanceCents` rather than a fresh
conversion, so a card that clears an invoice takes **both** columns to zero
exactly. Computing the functional figure inside `affords` as well would be two
answers to one question (Phase 116) — and the second answer would be wrong in
precisely the case that matters most, because a fresh conversion of the whole
balance need not equal what the document has been carrying.

## Why it floors

> `faceCents = floor(heldCents × RATE_ONE / rateMillionths)`

Flooring is what guarantees `convert(faceCents, rate) ≤ heldCents`. The face
amount is at most `held × 1e6 / rate`, so its product with the rate is at most
`held × 1e6`, and rounding a number no greater than `held` cannot exceed it.

Rounding to nearest would buy one cent more of the document than the card holds —
a gift-card liability going the wrong way for a penny, on a schedule, in a place
nobody would think to look. The property is asserted both directions across eight
rates and eight holdings: never over, and never obviously under, since flooring
could otherwise be satisfied by returning nothing.

## What this does not do

**It does not repair anything.** `redeemGiftCard` still compares a dollar with a
euro; the entry is on `PENDING_WIRING` with a skipped acceptance test, and
`DOMESTIC_GROUNDS` still fails it — correctly, because the defect is live.

**It does not touch the domestic case.** At a rate of one the face amount and the
functional amount are the same number, which is why `min` over two currencies has
given the right answer for the wrong reason for a hundred and forty-one phases.
Both the unit test and the acceptance test assert that explicitly, so the wiring
pass cannot quietly change what already works.

**It does not give gift cards a currency.** ADR 0029's claim stands: a card is
the company's own money. What was wrong was never the card — it was treating the
*invoice's* face balance as though it were too.

**It does not answer what a card should do against a document with no rate.** It
refuses, naming the document, because guessing a rate would put a figure on the
books nobody can trace. An invoice carrying a zero rate is a data defect, and a
refusal a person can act on beats a number nobody can (Phase 119).

## What is nominated next

Nothing new was found while building this, which is itself worth recording after
six phases of scan-reach failures.

The register now holds **five entries across eight targets**, four of them blocked
by nothing at all: `spends` → `applyDeposit`, `recoverHeld` → `recoverWriteOff`,
`bankGlAccountFor` → `recordContribution`, `affords` → `redeemGiftCard`. Each has
a skipped acceptance test that is the definition of done. The fifth,
`mayPostToBank` → four bank paths, is blocked by a field and names no test,
because one written against a column that does not exist would be fiction.

That is the shape the staging pass was set up to produce, and the next question
is a scheduling one rather than an investigative one: the cores are in place and
the wiring pass is what remains.
