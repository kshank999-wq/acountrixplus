# 0138 — The deposit spent in the invoice's currency

**Status:** proposed
**Date:** 2026-09-11
**Phase:** 138

> **The core is in place and deliberately not wired.** `applyDeposit` still does
> the wrong thing; `spends` exists beside it, tested, with no caller. That is a
> decision, not an oversight — the cores are being put in place first and hooked
> up in a later pass, so that banks, deposits and the rest are connected together
> rather than one at a time.
>
> What follows describes a defect that is **still live in the code**. Nothing
> here is fixed yet.

---

## How this was found

ADR 0137 nominated `recoverWriteOff`, and also claimed that the remaining four
functions relieving a carried balance without a realised line "were measured, not
assumed, and they are right as they are."

Given that the previous four ADRs each got an "only one" claim wrong, that
sentence was the first thing to check rather than the last.

**Two of the four hold up**, now measured rather than asserted:

- `redeemGiftCard` can only ever meet a **domestic** invoice.
  `completeAppointment` passes no currency to `createInvoice`, and
  `createInvoice` defaults to the company's own — so the gift card's bare
  `balanceCents`, on a table with no currency column and in no currency
  registry, is right.
- `reduceDocumentBalance` is right to have no realised line, because it does not
  keep the figure: it relieves the document at its own carried rate and
  **returns** `functionalCents` to its caller.

Following that returned figure is what found the defect.

## The defect

`applyDeposit` settles an invoice with a tenant's security deposit. The deposit
is held in the company's own money — `deposit_movements` has no currency column
— and the invoice may be in any currency at all, because `applyDeposit` takes an
`invoiceId` and asks it nothing.

One number, `input.amountCents`, did both jobs. Four things follow, and each is a
rule this project has already named:

**1. The permission compares two currencies.**

```ts
if (input.amountCents > position.heldCents) { … }
```

A euro face amount against a dollar holding — Phase 122's "no sum adds two
currencies", in the check that decides whether *somebody else's money* may be
spent. $1,050 held and €1,000 applied: `100000 > 105000` is false, so it goes
ahead, and spends $1,100 of a $1,050 deposit.

**2. The entry posts a face amount into a functional ledger.** Accounts
Receivable is credited with the euro figure while the subledger comes down by the
converted one. Phase 127's original defect, in a place its scan did not reach.

**3. The figure that fixes both was already computed.**
`reduceDocumentBalance` produces it, `settleInvoiceWithoutCash` passes it
through, and `applyDeposit` reads `.number` off the result for a memo and throws
the rest away.

**4. The sentence the person reads is in the wrong currency.**
`applyDepositAction` reports `formatCents(parsed.amountCents)`, and `formatCents`
defaults to `'USD'` — so applying €400 says "**$400.00** applied to the invoice".
Phase 60 and 61's rule, in the one line the user actually sees.

The refusal has the same problem in a smaller way: it prints raw cents rather
than money, so the old sentence reads "Only 105000 is held on this tenancy".

## A return value with no reader

The third is **Phase 49's rule inverted**. A function with no caller is a feature
that does not exist; a return value with no reader is an answer nobody asked for.

Measured rather than asserted — the same helper's other caller does read it:

| caller | reads the returned functional figure? |
| --- | --- |
| `recordPayment` → `applyToDocument` | **yes** — `carriedCents += applied.functionalCents` |
| `applyDeposit` → `settleInvoiceWithoutCash` | **no** — only `.number`, for a memo |

Two callers of the same helper, one reading the figure and one discarding it.

## Why it converts rather than refusing

Phase 133 made ten paths refuse a foreign account because they could not know a
rate, and Phase 136 found that refusing the *knowable* case was the error.

This one is knowable. The invoice carries the rate it was raised at,
`relieveFunctional` gives what the face amount is worth at that rate, and that
figure is what the deposit gives up. Nothing is guessed and no second rate is
invented — `spends` takes `functionalCents` as an input rather than converting,
which is Phase 116's rule: read the pair that moved, do not recompute it.

So the rule is not "refuse a foreign invoice" but **"say what it costs"**, and
the refusal that remains is the honest one: there is not enough held.

## Reachable, not theoretical

`applyDepositAction` parses `invoiceId: uuid.optional()` with **no currency
filter**, and `applyDeposit` asks the invoice nothing. A euro invoice reaches
this through a real screen.

## What it actually does

*Not yet measured.* Phase 137's defect was probed against the database before a
line was changed, and this one has not been — the probe belongs with the wiring
pass. **Every figure above is read off the source, not observed**, and if the
probe disagrees with this account then this account is what changes.

## Unwired on purpose, and what that costs

`spends` has no caller. By this project's own Phase 49 rule — *a function with no
caller is a feature that does not exist* — that means **the defect is not fixed**,
and calling this phase "done" would be the kind of claim the last five ADRs kept
getting wrong.

So it is stated plainly instead:

- `applyDeposit` still compares a euro face amount to a dollar holding.
- It still credits Accounts Receivable with a face amount.
- `applyDepositAction` still says "$400.00" when €400 was applied.
- `tests/deposit-against-foreign-invoice.test.ts` is **skipped**, and is the
  acceptance test for the wiring pass: unskip it, wire `applyDeposit`, and it
  says whether it worked.

The test is skipped rather than left red because a red suite nobody can fix
teaches people to ignore the suite — which is exactly what ADR 0137 said about
`ledger.receivables` reporting a fault with no document behind it. A staged
plan should not do to the test suite what the defect did to the nightly check.

## What this does not do

**It does not fix anything yet.** See above.

## What this does not do

**It does not give a deposit a currency of its own.** `deposit_movements` stays
in the company's money, which is what it has always been and what the tenancy is
actually held in. A deposit taken in euros is a different phase and needs a
column.

**It does not give `recoverWriteOff` its day rate.** ADR 0136's nomination stands
and is still open.
