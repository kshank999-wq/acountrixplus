# ADR 0002 — Double-entry ledger, derived postings, and closing controls

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §4 (reconciliation), §13 (accounting workspace), §16 (data model), §19 (integrity), §20 (Phase 2)
- **Builds on:** [ADR 0001](0001-modular-monolith-and-tenancy.md)

## Context

Phase 1 delivered a bank-feed inbox where transactions get categorized. That is
bookkeeping, not accounting: there was no general ledger, so no trial balance,
no financial statements, and no way to close a period.

ADR 0001 committed to one thing in advance — *"the ledger should post from bank
transactions rather than replacing them, keeping the feed as an immutable
source record."* This ADR records how that was carried out and the decisions
that followed from it.

## Decisions

### 1. Journal entries are derived from source documents, not typed

A business owner should never write a journal entry to keep their books
(spec §23: reduce duplicate entry). So every routine entry is *derived*:

| Source | Ledger effect |
| --- | --- |
| Categorized bank transaction | Dr category / Cr the account's GL account (reversed for inflows) |
| Split bank transaction | One line per split, plus one line for the bank side |
| Matched transfer pair | Dr destination GL / Cr source GL — **one** entry for both legs |
| Invoice | Dr Accounts Receivable / Cr revenue accounts (+ Cr sales tax payable) |
| Bill | Dr expense accounts / Cr Accounts Payable |
| Payment | Dr bank / Cr A/R, or Dr A/P / Cr bank |

Manual entries remain available for adjustments and accruals, gated behind
`accounting:journal` — a bookkeeper categorizes, an accountant writes journal
entries.

`syncLedgerForTransaction` is **idempotent**: it voids whatever entry the
transaction had, then posts a fresh one if the transaction is currently
postable. Recategorizing therefore replaces the entry rather than stacking a
second one; excluding withdraws the ledger effect entirely; undoing a
categorization withdraws it too. One function covers every path, so no caller
has to remember the bookkeeping.

It runs **inside the caller's database transaction**, which is what makes the
closed-period rule work end to end: a categorization that would post into a
closed period rolls back along with the rejected entry, rather than leaving the
transaction categorized but unposted.

### 2. The sign convention is uniform across asset and liability accounts

`bankTransactions.amountCents` is signed from the account holder's view:
negative is money out. The posting rule needs no special casing:

```
amount < 0  →  Dr category,            Cr the account's GL account
amount > 0  →  Dr the account's GL,    Cr category
```

Spending on a credit card credits the card's *liability* account, increasing
what is owed. Spending from checking credits the *asset* account, reducing
cash. Same entry shape, correct result in both cases — verified by a test that
asserts card spending lands in liabilities rather than as negative cash.

### 3. Debits and credits are separate non-negative columns

`journal_lines` has `debit_cents` and `credit_cents` rather than one signed
amount. This is the form accountants read, it makes the trial balance a direct
sum of two columns, and it removes any ambiguity about what a negative number
would mean on a credit-normal account.

A database CHECK constraint enforces that a line is a debit or a credit — never
both, never neither, never negative:

```sql
debit_cents >= 0 AND credit_cents >= 0
AND (debit_cents = 0) <> (credit_cents = 0)
```

The balance rule itself (debits = credits per entry) spans rows, so it is
validated in `normalizeLines` before any write and covered by tests.

### 4. Balances are always summed, never cached

There is no stored balance column anywhere. Every figure in every report comes
from summing `journal_lines` filtered to `status = 'posted'`. A cached balance
that drifts from the entries that produced it is the classic way an accounting
system quietly starts lying, and the chart of accounts is small enough that
summing costs nothing.

`trialBalance()` exposes `isBalanced` for the same reason: because entries are
validated on the way in, the two columns can only disagree if something wrote
around the journal service. Surfacing that makes it visible instead of letting
it hide inside a statement.

### 5. Corrections are voids and reversals, never deletes

A posted entry is never edited or deleted. `status = 'void'` removes it from
balances while leaving the row and its lines in the database. `reverseEntry`
posts a mirror entry with the sides swapped, which is the right tool when the
original fell in a period that has already been reported on — the correction
lands in the current period rather than silently changing a prior one.

### 6. Two independent locks: periods and reconciliations

They protect different things and are deliberately separate.

**Period close** (`accounting_periods`) blocks anything dated inside a closed
range — new entries, voids, and bookkeeping changes that would post there.
Requires `accounting:close`. Only closed periods get a row; reopening marks the
row `reopened` rather than deleting it, so the close and its reversal both stay
on the record.

**Reconciliation lock** moves cleared transactions to the `reconciled` review
state, which the bookkeeping service refuses to edit. Reopening requires
`reconciliation:reopen`, which bookkeepers do not hold — so the person who
reconciles is not automatically the person who can unwind it.

### 7. Reconciliation completes only at exactly zero

```
cleared balance = beginning balance + Σ(cleared transaction amounts)
difference      = statement ending balance − cleared balance
```

Completion is refused unless `difference === 0`. Because everything is integer
cents, "exactly zero" means exactly zero — there is no tolerance to tune and no
rounding drift to accommodate. A stored completed reconciliation is therefore
always a claim that the books agreed with the bank on that date.

The beginning balance chains from the previous completed reconciliation on the
same account, so consecutive statements need no re-entry and cannot be entered
inconsistently.

### 8. Document balances are maintained; aging reads them

Invoices and bills carry `balance_cents`, updated in the same transaction as
the payment application that changes it. Aging reads those balances rather than
the A/R control account, because aging needs per-customer, per-due-date detail
that a single ledger account does not carry.

Overpayment is rejected — a document cannot go below zero. Credits and refunds
are their own workflow (spec §13), not a negative balance smuggled in here.

## Consequences

- Bank sync now writes journal entries inline, making the import path heavier.
  This reinforces the Phase 1 note that sync belongs behind a job queue.
- Undo grew a third responsibility (withdrawing ledger entries) on top of
  restoring state and retiring vendor rules. It is still one function, but a
  fourth concern would justify an explicit reverse-operation registry.
- **Cash-basis reporting is not implemented.** All statements are accrual.
  Spec §13 asks for both "where supported by the underlying transaction model";
  doing cash basis correctly means looking through payment applications to the
  revenue and expense accounts on the documents they settle, which the
  `payment_applications` table was designed to make possible. It is deliberate
  scope left for Phase 2b rather than an approximation shipped as if it were
  the real thing.
- Fixed assets and depreciation, recurring and closing entries, customer
  statements, write-offs, and 1099 reporting remain open from spec §13. Vendor
  `taxId` and `is1099Vendor` columns exist so the data is captured now.
- Accounting dimensions (classes, departments, locations, projects) are not yet
  on journal lines. Adding them is a column plus a filter, but the industry
  packs that need job costing will want them before Phase 7.

## Follow-up

Phase 3 (spec §20) is CRM and the proposal pipeline. The `customers` table
introduced here is the natural anchor: a won proposal should create the client,
the job, and the invoice schedule without re-entry (spec §6).
