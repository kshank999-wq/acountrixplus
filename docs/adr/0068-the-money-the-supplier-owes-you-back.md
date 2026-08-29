# 0068 — The money the supplier owes you back

- **Status:** accepted
- **Date:** 2026-08-29
- **Supersedes:** part of ADR 0067 (`retainer_refunds` is folded into `refunds`).
- **Extends:** ADR 0066 (`settleHeld`), ADR 0053 (overpayments), ADR 0047 (refusals).

## Context

ADR 0067 named this as the last of the no-way-out balances:

> **A vendor's overpayment cannot be recovered.** Paying a supplier more than
> was owed leaves *them* owing *us*, which `splitReceipt` has refused since
> Phase 53 on the grounds that vendor credits already cover it. They do — but a
> vendor credit that will never be spent, because the relationship ended, has
> the same no-way-out shape this phase just fixed for retainers.

A vendor credit posts `Dr Accounts Payable / Cr Expense` when it is issued, and
applying it to a bill posts nothing — it only decides which bill the reduction
belongs to. So an unapplied credit is a **debit sitting in payables**: money the
supplier owes back, netted against everything else the business owes them.

While more bills are coming, that is exactly right. When the relationship ends,
no bill ever arrives, the remedy `splitReceipt` offers is advice nobody can
take, and the credit quietly understates what is owed to other suppliers for
ever. Phase 49's lesson, a third time: **a balance with no way out becomes a
wrong number and stays one.**

## Decision 1: the sign is decided by which side the balance is on

`settleHeld` was written in Phase 66 for held money — a liability, debited as it
leaves — and its parameter names said so. That hid the thing that actually
decides the sign.

Recovering a vendor credit debits the *bank* and credits the *payable*: the same
settlement with the sides swapped. Handing those amounts to `settleHeld` in
liability order returns the right magnitude with the wrong sign, **in an entry
that still balances** — which is what makes it dangerous rather than merely
wrong.

So the invariant is not about liabilities at all:

> `realised` is the debit side less the credit side. Positive credits the
> exchange account, because `Dr A = Cr B + Cr (A − B)` is the only way a
> three-line entry balances.

One private `realise(debit, credit)` holds that, and two exported functions
differ only in naming which of their amounts is the debit: `settleHeld` (held
money leaves) and `recoverHeld` (cash arrives). Given the same pair they return
opposite signs, and both are correct: **a euro that got dearer is a loss on
money you hold for somebody else and a gain on money somebody else holds for
you.** Phase 67's retainer refund realised a $16.50 loss on exactly the rate
movement that this phase realises an $8.25 gain on.

Two entry points rather than one function with a direction flag, for Phase 66's
reason: a flag is a thing a caller forgets to set, and the failure is silent.

## Decision 2: one `refunds` table, replacing `retainer_refunds`

Phase 67 was right that a refund is three facts rather than one, and wrong about
the scope of the noun. By the end of that phase there were three refunds and
three answers to "where is it written down": a table, a bare journal entry, and
nothing at all because the operation did not exist.

`vendor_credit_refunds` beside `retainer_refunds` would have made the split
permanent. The vendor-credits module has said since Phase 12 why that is wrong,
about this very shape: *"the first bug fixed in one would leave the other
wrong."* So one table with a `subject_type`/`subject_id`, the way
`journal_entries` has carried `source_type`/`source_id` since Phase 2.
`retainer_refunds` was one phase old with one caller — the cheapest this will
ever be to undo. `refundCredit`, which recorded nothing but a journal entry
since Phase 53, is wired to it too.

`direction` is stored rather than inferred, and `refunds_balances` makes the
database refuse a row whose three amounts do not add up the way its direction
claims. Nothing in the amounts themselves says which way round they go.

## Decision 3: a refusal nobody can read is not a refusal

Found in the browser, not by a test: recovering more than a credit holds
returned **"Something went wrong."**

`messageFor` surfaces only `DomainError`; everything else is logged and
replaced. `vendor-credits.ts` threw plain `Error` for all 25 of its refusals, so
every one of them — "Only €1,500.00 is held", "A credit can only be applied to
the same vendor's bill", "That bill belongs to a different vendor" — had been
invisible since Phase 12. Twenty-two are now `DomainError`. The three that
remain plain are `'Accounts Payable is missing from the chart.'` and its
siblings, which report a broken chart rather than refusing a person's action,
and should stay logged as unexpected.

This is ADR 0047's rule, which the payables path had already learned once: a
refusal belongs on the row and has to say what is wrong with *this* row. It is
worth noting that the integration tests all passed while this was broken —
they call the service directly, so they never crossed the boundary that ate the
message.

## Decision 4: `mayUse` is told whose money it is

Reusing Phase 53's verdict meant a supplier was told *"Only €1,500.00 is held
for this customer."* `holder` is optional and defaults to the sentence every
caller before this phase had.

## Consequences

- A vendor credit can be recovered in cash, and the payable it sat in can reach
  zero. This was the last of the no-way-out balances ADR 0067 listed.
- `7100 Foreign Exchange Gain or Loss` picks up the movement in the right
  direction for both kinds of balance, from one shared rule.
- Every vendor-credit refusal now reaches the screen, including twenty-one that
  predate this phase.
- `splitReceipt` still refuses an over-payment to a supplier — a vendor credit
  is the right home for it — but the remedy it offers is now finishable.

## What this does not do

- **The vendor credit form always applies in full.** It credits the whole bill
  and applies it immediately, so the leftover this phase exists for can only
  arise from a partly-paid bill. Issuing a credit for part of a bill, or for
  none of one, is not reachable from that screen.
- **A recovery cannot be voided**, the same gap ADR 0067 left for refunds.
  Phase 52 taught payments to unwind; none of the three refunds can.
- **`applyVendorCredit` and `createVendorCredit` are not otherwise revisited.**
  Their refusals are legible now, but the reachability question above is theirs.
- **Three screens still say "Take it back"** for three different operations —
  withdrawing an approval, voiding a payment, and (until this phase renamed it)
  recovering a credit. Only the new one was renamed.
