# ADR 0012 — The statements an accountant asks for

- **Status:** Accepted
- **Date:** 2026-08-15
- **Context:** Spec §13 (Cash Flow, comparative periods, undeposited funds and
  deposits, vendor credits), §22 (definition of done)
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0011](0011-the-same-books-read-two-ways.md)

## Context

Phase 11 finished §13's *entry* list — recurring, adjusting, closing — and its
receivables list. What was left was the part of §13 that names specific
artefacts an accountant will ask for by name and notice the absence of:

> Financial statements: Balance Sheet, Profit & Loss/Income Statement,
> **Cash Flow**, Trial Balance, General Ledger, AR/AP aging, transaction
> detail, and **comparative periods**.
>
> Cash/bank, credit cards, transfers, **deposits**, **undeposited funds**, and
> reconciliation.
>
> Accounts payable: vendors, bills, **credits**, payments, aging…

Plus one defect. ADR 0011 shipped cash-basis reporting with a hole that was
found in the demo data rather than by a test: a manual accrual showed as an
expense on a cash-basis P&L, because the transformation only understood
invoices, bills, and payments. Fixing it is the largest decision here.

## Decision 1: classification is derived from `subtype`, not stored

The cash flow statement needs to know which accounts are cash and which
section each of the others belongs to. Cash-basis reporting needs to know which
accounts exist only to hold a timing difference. The obvious design is two more
columns on `chart_accounts`.

It was rejected. `subtype` already exists, every seeded and industry-pack
account carries one, and it is the field that answers "what kind of account is
this". A second field saying the same thing in different words can disagree
with it — and then a report and the chart of accounts tell different stories
about the same account, which is exactly what spec §23's "one source of truth"
rule is about.

The cost is real: an account with the wrong subtype lands in the wrong section,
and the fix is to correct the subtype rather than override the report. That is
the right place for the fix, because the subtype was already wrong for every
other reader.

Three existing accounts were re-tagged by data migration —
`1300 Prepaid Expenses` to `prepaid_expense`, and the two construction WIP
accounts to `unbilled_revenue` — and `2150 Accrued Liabilities` was added to
the standard chart and backfilled. Doing that migration is what stops accrual
handling working only for companies onboarded after this phase.

### Accumulated Depreciation is operating, and that is the point

It looks misfiled next to the asset it offsets. But its movement over a period
*is* the depreciation charge, and the indirect method's first adjustment is to
add that charge back. Classified beside Fixed Assets it would land in
investing, where it would read as a disposal.

The approximation: disposing of a depreciated asset moves accumulated
depreciation for a reason that genuinely is investing, and this reports it as
operating. Doing better needs a fixed-asset register, which §13 explicitly
allows as a later module.

## Decision 2: the cash flow statement is one identity, not a list of rules

The indirect method is usually taught as adjustments to net income, each with
its own justification, which makes it look like a pile of conventions to
memorise. It falls out of one fact instead. Every account has a net movement
over a period, and because every entry balances those movements sum to zero:

```
  Σ movement(all accounts) = 0
  ⇒  Σ movement(cash) = − Σ movement(everything else)
```

The change in cash *is* the negated movement of every other account. The three
sections are a grouping of those accounts, nothing more. "Add back
depreciation" is not a rule: Accumulated Depreciation moved by a credit, so its
negated movement is positive, and it lands in operating because that is where
the account is classified.

Written this way the statement cannot silently disagree with the balance
sheet — they are derived from the same movements. `reconciles` asserts it
anyway, for the same reason `trialBalance` reports `isBalanced` even though
every entry is validated on the way in: it can only be false if something wrote
around the journal service, and that is worth seeing.

**There is no basis switch.** The indirect method exists to explain the gap
between accrual profit and cash. On a cash basis there is no gap: every
adjustment line would be zero and the report would be a P&L with ceremony.

## Decision 3: cash basis learns about accruals

This is the fix for the ADR 0011 defect, and it took getting the framing right
before the code was short.

Every timing difference is written down twice — once when the cash moves and
once when the amount is recognized — and cash basis keeps the first and
discards the second. **Which entry is which is visible in what the entry's
*other* legs are**, not in its date or its direction:

```
  Accrued expense                     Prepayment
  ─────────────────────────────       ─────────────────────────────
  Dr  Rent          5000  ← recog.    Dr  Prepaid      12000  ← cash
      Cr  Accrued   5000                  Cr  Bank     12000

  Dr  Accrued       5000  ← cash      Dr  Rent          1000  ← recog.
      Cr  Bank      5000                  Cr  Prepaid   1000
```

A recognition entry's other legs are income-statement accounts; a cash entry's
include cash. So: **remove the recognition entry and keep what it said the
money was for; then, on the cash entry, put that back in place of the
accrual-only leg.**

Deferred revenue is the same machinery upside down — the deposit is the cash
entry, earning it is the recognition — and needs no special case, because the
basket of recognized legs carries its own direction.

Balance is preserved by construction: recognition entries are removed whole,
and a cash entry's accrual leg is replaced by legs scaled to net to exactly
what it was worth.

### Three things this decision is careful about

- **Depreciation is not an accrual.** A depreciation entry has the identical
  shape — an expense against a balance-sheet account, no cash — but a
  cash-basis taxpayer still deducts it, because it is capital recovery rather
  than a timing difference. Any rule phrased as "entries that touch no cash"
  gets this wrong, which is why the list is by account and why
  `tests/statements.test.ts` asserts it directly.
- **Receivables and payables do not go through this path.** They have real
  payment applications recording which document each settlement covers, so cash
  basis handles them exactly rather than by inference. Widening the mechanism
  to cover them would replace an exact answer with a guess.
- **Dropping the accrual and stopping there would have been worse than the
  bug.** An accrual settled directly from the bank, with no reversing entry,
  would then show no expense at all — a permanent misstatement, where the
  original defect was only a misdated one. Putting the basket back is what
  makes the direct-settlement case right, and it is the case the second test
  in that block exists for.

## Decision 4: a deposit is a record, not a query

Reconciliation matches one statement line at a time. Three cheques banked
together are one line at the bank and, without this, three in the books.

"The receipts between these dates" would reproduce most deposits and be wrong
for the rest: a deposit is a decision about which cheques went in the envelope,
and two of Monday's three going on Thursday with the last held back is
ordinary. What happened has to be stored.

Two smaller decisions follow:

- **A fee is a negative line, not a positive one with a flag.** The sign is the
  whole of the distinction, and one place to get it wrong is better than two.
  The entry debits the bank for the net and Undeposited Funds is credited with
  the gross the customers actually paid, so the bank account carries the figure
  the bank processed.
- **A unique index on `payment_id`, not a check.** Two concurrent deposits both
  pass any read-then-check. Depositing the same cheque twice is the single
  worst thing this table could permit, so the database arbitrates.

Undeposited Funds counts as **cash** for the cash flow statement. A cheque in
the drawer is money the business has; if it were not cash, every deposit would
appear as an operating inflow.

## Decision 5: a vendor credit shares the customer credit's table

One `party` column, the same way `payments` holds receipts and disbursements.
Two tables would mean two copies of the remaining-balance arithmetic, the
application rules, and the aging treatment, and the first bug fixed in one
would leave the other wrong.

**There is deliberately no vendor write-off.** A customer write-off says money
owed to us will not arrive, which is a loss. The reflection would be a debt we
owe that the supplier stopped chasing — and treating that as income is a
judgement about whether the obligation is really extinguished, not a
bookkeeping operation. It stays a manual journal entry.

## Decision 6: a stale close is reported, not blocked

ADR 0011 left this as follow-up 1. Closing and locking are separate on purpose:
locking stops entries being written, closing writes one more. So posting into a
closed year stays possible — and it makes the number transferred to Retained
Earnings wrong, which was previously silent.

`staleCloses` counts the entries posted into a closed year *after* the close
and recomputes the year's profit to measure the actual drift. Reading the drift
rather than inferring it from the entries matters: two corrections in opposite
directions cancel, and saying so is more useful than raising an alarm about
them.

The recomputation cannot reuse `accountBalances`, because that would include
the closing entry, which zeroes every revenue and expense account by design and
would report the whole year's profit as drift every time.

## Consequences

- **Comparative statements cost one query set per column.** Nothing caches, so
  a five-year comparison is five times the work of one year. A comparative
  built from a stale column is worse than a slow one.
- **`prior_period` needed a calendar rule.** Shifting back by the window's own
  day count put Q2's comparison column on 31 December, straddling a year end.
  Whole calendar months, quarters, halves, and years now shift calendar-wise;
  anything else falls back to the day count, because a five-month window has no
  named predecessor.
- **Cash basis now reads a third slice of the ledger.** Recognition entries
  have to be assembled from all time, not just the report window, or a
  prepayment amortized outside the window silently disappears. Only entries
  touching an accrual-only account are read.
- **Accruals are pooled per account, not matched per item.** A company running
  two prepaid insurance policies through one account gets the pool, not the
  policy. Doing better needs the accrual linked to its settlement the way
  `payment_applications` links a payment to its invoice.
- **A prepayment that has never been amortized stays on a cash balance sheet.**
  Nothing has said what it was for, so nothing guesses. `cashBasisCaveats`
  computes and names the amount.
- **Credit-card balances are classified operating.** Defensible — the purchases
  are operating — but a business financing itself on cards would reasonably
  want them read as financing, and the subtype is the only lever.
- **There is still no classes/departments/locations dimension.** §13 asks for
  "classes/departments/locations/projects/jobs **or equivalent**", and projects
  and cost codes are the equivalent that exists. A restaurant with three
  locations and no projects is the case that is not served.
- **`createCreditNote` and `createVendorCredit` returned a stale
  `remainingCents`** when applying immediately — the row was read before the
  application ran. Fixed on both sides; it was a pre-existing bug on the
  customer side that the vendor mirror surfaced.

## Follow-up

1. **A class or location dimension**, for businesses whose segments are not
   projects.
2. **Link an accrual to its settlement**, so prepayments are matched per item
   rather than pooled per account.
3. **A fixed-asset register**, which would let an asset disposal be classified
   as investing rather than folded into the depreciation add-back.
4. **Comparative balance sheets in the UI.** The service exists and is tested;
   only the P&L has a screen.
