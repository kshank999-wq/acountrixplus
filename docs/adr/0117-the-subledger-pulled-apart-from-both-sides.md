# 0117 — The subledger pulled apart from both sides

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 117

---

## How this was found

Phase 116 added a constraint saying a document's face and functional balances
reach zero together. The combined full suite then failed — **four tests, one
cause** — and the cause was not the constraint:

```
FAIL  tests/importing.test.ts > opening balances > clears Opening Balance Equity to zero
      new row for relation "invoices" violates check constraint
      "invoices_functional_balance_sane"
      Failing row contains (…, 520000, 520000, …, USD, 1000000, 0, 0, …)
```

`total_cents` 520000, `balance_cents` 520000, **`functional_total_cents` 0,
`functional_balance_cents` 0.** A constraint written to expose a class of defect
exposed one on its first full run, in code nobody had suspected.

Separately, and while verifying ADR 0116's nomination, measuring which source
types post to a control account turned up a second live case. Both are the same
failure, and ADR 0031 already named it:

> The balance sheet says £365 is owed; the aging report says nothing is owed;
> both are internally consistent, and neither mentions the other.

Phase 31 found it coming from the **ledger** side. Two more were live, one from
each side.

## The subledger side: what the migration wizard brought across

`insertOpeningInvoice` and `insertOpeningBill` set `subtotal_cents`,
`tax_cents`, `total_cents` and `balance_cents` — and never touched the
functional columns, which default to zero.

The functional figure is what the rest of the system reads. The control-account
check sums it (Phase 35), the aging report ages it (Phase 107), statements and
chasing quote it. So a company that migrated in had:

- receivables on its balance sheet,
- an aging report showing **nothing**,
- a nightly **fault** it could do nothing about,
- and statements telling its customers they owed nothing.

Produced by the first screen a new customer ever uses. An opening balance
carries no currency of its own — it is what the old system said was owed, in the
money these books are kept in — so the rate is one and the functional figure
*is* the face figure. Both inserts now say so.

### The migration had to be amended, not followed

Migration `0074` would have **failed on any database that had used the wizard**,
because those rows are exactly what its constraint refuses. It did not fail here
only because neither local database happened to hold an imported document at the
time. Its own "if this migration fails" note was wrong for this case too: it
sent the reader to a bookkeeper, where the correct repair is arithmetic.

`0074` now backfills the four tables before adding the constraints, touching
only rows whose rate is one — where the two figures *are* each other — and its
note explains what a remaining failure means. Amended rather than followed by a
`0075` because on a fresh deployment migrations run in order: `0074` would fail
before any later fix could run.

## The ledger side: the account nothing refused

`receiveStock` takes the credit account from its caller, and says why:

> The shared path for a goods receipt, an opening balance, and a customer return
> — they differ only in what gets credited, which is why that is a parameter
> rather than three near-copies of this function.

A good reason for a parameter and a bad reason to leave it unconstrained.
**Naming three legitimate values without naming what is illegitimate is how the
fourth gets in**, and it did — in this repository's own seed, four times:

| Company | Balance sheet | Payables report |
|---|---|---|
| Kestrel Fabrication | **$3,030.00** owed | $0.00 — "Nothing is owed" |
| Ashgrove Motors | **$180.00** owed | $0.00 — "Nothing is owed" |

No supplier, no due date, no bill number. Nobody could pay it, because the
report a person would pay from did not know about it.

`receipt-credit.ts` holds the one class that is refused and why, and
`receiveStock` refuses it — a refusal rather than a check, on Phase 116's
argument: a check reports what has already happened, and this can be made not to
happen. It is a **deny-list on purpose**: the legitimate credits are genuinely
varied (goods received not invoiced, work in process, opening balance equity, a
bank account for stock bought outright) and enumerating them would refuse the
next honest one. What is excluded is a single, statable class.

The seed now credits the bank — a workshop and a garage buying materials over
the counter. Crediting `2050` instead would have moved the fault rather than
fixed it: `inventory.goods_received` reconciles `2050` against `goods_receipts`
rows, and a bare `receiveStock` creates none.

### It caught nineteen more

Turning the refusal on failed 18 tests in `tests/manufacturing.test.ts` and one
in `tests/vehicles.test.ts`. Their fixtures credited `2000` too — so every set
of books those tests built had a payable with no bill behind it, and then
asserted reconciliations on it. That is the refusal doing its job, loudly, where
the defect had been quiet.

## What this says about how the checks were verified

The nightly check runs **per company**. Every browser verification this project
has ever done signed in as Ridgeline Construction, and Ridgeline was fine. Two
of the seven demo companies had been reporting a fault-severity difference every
night since the seed was written, and nobody had looked.

Measured after the repair, across all seven:

```
Ridgeline Construction       AR ok  AP ok   faults: none
Kestrel Joinery              AR ok  AP ok   faults: none
Riverside Community Trust    AR ok  AP ok   faults: none
Kestrel Fabrication          AR ok  AP ok   faults: none
Marlowe Street Coffee        AR ok  AP ok   faults: none
Fenwick Row Studio           AR ok  AP ok   faults: none
Ashgrove Motors              AR ok  AP ok   faults: none
```

## What this does not do

**It does not give the demo a Goods Received Not Invoiced position.** Phase 48
built the screen for billing goods already received and the demo exercises none
of it, because no seeded receipt goes through the purchase-order path.
`receiveGoods` takes an optional `purchaseOrderId`, so this is a vendor and a
call away — worth doing, and not this phase.

**It does not check that every company reconciles.** The obvious tripwire would
run the register across all seven seeded companies, but the seed takes minutes
and the test database is truncated between tests. The refusal and the constraint
make both of these defects unwritable instead, which is the stronger guarantee —
but it leaves "verify on more than one company" as a habit rather than a rule.
