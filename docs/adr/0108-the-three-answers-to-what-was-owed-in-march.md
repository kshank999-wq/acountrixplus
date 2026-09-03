# 0108 — The three answers to what was owed in March

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 108

---

## The defect

Every report that compares the ledger against the documents behind it takes an
`asOf` date, walks the **ledger** back to it, and then reads the **document**
balance as it stands now. `receivables-check.ts` has said so since Phase 31, and
given a reason:

> invoices do not keep a history of what they were owed on an arbitrary past
> date […] reconstructing historical document balances means replaying every
> payment application, which is a bigger machine than this check justifies.

Measured on the development books — three answers to "what was owed on 31
March", none of them right:

```
as at 2026-03-31:  aging=124194   ledger=364194   subledger=4940069  agrees=false
as at 2026-05-31:  aging=1870069  ledger=2543469  subledger=4940069  agrees=false
as at 2026-09-03:  aging=5000069  ledger=4940069  subledger=4940069  agrees=true
```

The control-account check reported a **$45,758.75 fault** on healthy books for
any date but today — the register's highest severity, reachable from a date
picker on the reports page. The aging report was wrong the other way: it showed
$1,241.94 outstanding in March, because everything settled since reads as
settled all along.

This is the third time in four phases that a *fault* fired on a legitimate
state (Phases 105, 106). Same conclusion each time: a check that cries wolf is a
check somebody turns off.

## The stated reason was false, and the schema says so

Every one of the four paths that reduces an invoice or bill balance writes a
**dated** row:

| path | table | date |
|---|---|---|
| payment | `payment_applications` | `payments.payment_date` |
| credit note | `credit_applications` | `applied_on` |
| write-off | `invoice_write_offs` | `written_off_on` |
| retainer draw | `retainer_applications` | `applied_on` |

It is not a replay. It is four sums. The claim survived seventy-seven phases
because nothing enumerated the paths — and I repeated it myself in ADR 0107,
that same morning, when listing what Phase 107 did not do. **Corrected there.**

`SETTLEMENT_PATHS` now declares them, each with the column that dates it and
prose arguing for itself, on the device Phases 70, 101, 105 and 106 used. A
fifth path has to answer the question rather than quietly make history wrong,
and `pathFor` throws rather than returning a silent zero.

**Recovering a write-off is deliberately absent.** `recoverWriteOff` records the
recovery and posts an entry but never touches the document's balance — the
invoice stays written off at zero. It is a ledger event, not a document one, and
listing it would restore a balance that never came back.

## Decision 1: one query, shared by both readers

`openDocumentsAsAt` is used by the aging report *and* the control-account check.
They each used to select their own open documents with their own status filter,
and this whole family of defects — Phases 106, 107 and this one — came from two
answers to one question. There is one answer now.

Its status filter is deliberately wide: everything except a draft (never an
obligation) and a void. A **paid** or **written-off** document is included,
because it was open before it was settled, and excluding it is exactly how a
historical aging came to read $1,241.94.

## Decision 2: the restored amounts convert at the *document's* rate

None of the four tables stores a functional amount. Converting the restored face
amount at the document's own rate is not an approximation — it is right, and the
reason is the shape of Phase 35's realised gain.

Before a foreign invoice is settled, both the ledger and the document carry it
at the rate it was raised at; the difference against the settlement-day rate is
booked as a realised gain **in a separate entry dated on the settlement**. A
report as at a date before that settlement excludes the entry from the ledger
side, so it must exclude it from the document side too — which converting at the
document's own rate does exactly.

## Decision 3: credits are restored on both sides, or neither

A credit note's `remaining_cents` falls as it is applied, and the invoice's
balance falls by the same amount. Restoring only the invoice would move the
subledger by the application amount and reintroduce the disagreement this phase
removes. `openCreditsAsAt` restores the credit side by the same rule, and
`unappliedCredits` in the aging report reads it — so Phase 107's reconciliation
line is right at a past date too.

## Decision 4: a settlement *on* the date has already happened

A payment dated 31 March is money received on 31 March, so a report as at 31
March shows the invoice already reduced by it. Strictly after, and only after,
is undone. The rule is applied in `balanceAsAt` and in the SQL, so the two
cannot disagree about the boundary.

## What this cannot recover, and says so

**A voided document.** Voiding marks the journal entry `void` rather than posting
a reversal, and zeroes the document's balance, keeping a date for neither. So an
invoice voided in July is absent from the March ledger *and* the March
subledger. The two still agree — this does not reintroduce a fault — but both
are wrong about March in the same way.

Fixing it means dating the void, which is a change to how correction works
(Phase 51's territory) rather than to how history is read, and would need a
migration. Stated here rather than left for somebody to find.

## The result, on real books

```
as at 2026-03-31:  aging=364194   ledger=364194   subledger=364194   agrees=true
as at 2026-05-31:  aging=2543469  ledger=2543469  subledger=2543469  agrees=true
as at 2026-09-03:  aging=5000069  ledger=4940069  subledger=4940069  agrees=true
```

March and May tie exactly, because Ridgeline had no unapplied credit then. Today
they differ by the $600 credit, and the aging report predicts `4940069` — which
is what the control account reports.

Verified in the browser at 31 March:

> **1100 Accounts Receivable — Agrees.**
> The ledger says **$3,641.94**. The documents say **$3,641.94**.

## What this does not do

**It does not add a check that the two reports agree.** ADR 0107 raised this and
the answer has not changed: the relationship is arithmetic over figures both
reports derive from the same shared query, so a check would mostly test its own
subtraction.

**It does not restore a statement or a chase to a past date.** Both are
addressed to a customer *now* and ask them to pay what they owe *now*; a
historical one would be a letter nobody should send. They read present balances
deliberately.

**It does not make `balanceForAccount` cheaper.** Restoring documents adds four
small indexed queries per report. Measured at Ridgeline's size the reports are
still sub-second, but this has not been profiled against a company with years of
applications, and a report over a very old date reads every settlement since.
