# ADR 0017 — Nothing is imported until all of it can be

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §20 Phase 8 ("Payroll / Tax / **Advanced Integrations**"),
  §5 (chart of accounts), §13 (receivables and payables)
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0012](0012-the-statements-an-accountant-asks-for.md),
  [ADR 0016](0016-the-parts-sum-to-the-whole.md)

## Context

Every phase up to this one built something for a company that starts from
zero. No such company exists among the ones this product is for. A business
that adopts a new accounting system in August has seven months of the year
behind it, a customer list, a chart it recognises, and — the part that matters
— a set of balances that have to still be true on the other side.

Until now the only company that could use Accountrix Plus was one that had
never traded.

There is also an account that has been waiting the whole time. `3900 Opening
Balance Equity` has been in the standard chart since the first commit,
described as *"Offsets opening balances during setup. Should clear to zero."*
Nothing had ever written to it. This phase is what it was for, and the
description turns out to be the specification.

Two claims, and the second is the one that makes a migration trustworthy:

1. **Nothing is imported until all of it can be.**
2. **Opening Balance Equity clears to zero when the books are open, and names
   the gap when they are not.**

## Part one: reading somebody else's file

### Decision 1: a parser, not a dependency

A delimited-text parser is a hundred lines, and every failure mode is in the
*data* rather than the algorithm: a memo containing a comma, an address
containing a newline, a byte-order mark Excel writes on every save, a European
export using semicolons. Those are cases a dependency would also have to be
tested against before being trusted with somebody's books, so the tests are the
work either way and the hundred lines are cheaper than the audit.

### Decision 2: the delimiter is found by consistency, not frequency

A tab-separated file of addresses contains more commas than tabs — "Portland,
OR" in every row. Counting raw frequency picks the comma and shreds the file
into nonsense that still parses. What identifies a real separator is that every
row has the same number of them.

### Decision 3: refuse rather than guess

The whole coercion layer follows one rule, and each instance of it is a place
where guessing would produce books that are wrong in a way nobody finds:

- `1.234,56` is **rejected**. It is one thousand two hundred and thirty-four in
  Europe and one and a bit in the US, and nothing in the cell says which. A
  fifty-fifty guess about somebody's money is not a guess worth making.
- `1,23` is **rejected**. Reading the comma as a thousands separator turns
  $1.23 into $123.00.
- `1.2345` is **rejected**. More than two decimal places is a rate or a
  quantity, and rounding it discards precision the file thought mattered.
- `02/31/2026` is **rejected** rather than rolled into March.
- `03/04/2026` is read according to a setting the wizard asks for, **and the
  file-level warning says how many dates were ambiguous**. This is the single
  most damaging silent failure available to an importer: half a year of
  documents landing in the wrong month, every one of them plausible, nothing
  else that would ever flag it.

The exception is a malformed email address, which is a **warning**. Somebody
who owes money is still somebody who owes money, and dropping the row would
lose the balance with it.

### Decision 4: one header serves one field

Column mapping is proposed and never applied on its own — a confident wrong
guess about which column is the amount is worse than no guess. And the
assignment is exclusive: without it, an `amount` field scoring equally against
`Debit` and `Credit` claims both, and the second column silently disappears
from the import.

## Part two: the all-or-nothing rule

### Decision 5: plan first, and one error stops the file

Every importer builds a plan before it writes anything. The plan carries every
row's parsed value or its problems, and `canCommit` is false if a single row
has an error.

The alternative — write as you go, stop on the first bad row — leaves a company
with 137 of 400 customers and no way to tell which 137 without reading both
files side by side. On a trial balance it is worse: a half-posted opening
balance is an unbalanced ledger, and the tool that caused it is the tool they
would have to use to find it.

Repeated problems are grouped before display. Four hundred rows missing the
same column produce four hundred identical messages, and the one that says
something else has to be visible.

### Decision 6: the browser never posts a plan

`commitImportAction` re-derives the plan from the same text rather than
accepting the one the browser holds. A plan carries the amounts that will be
posted; taking one over the wire would let a client post any figures it liked.

## Part three: opening balances

### Decision 7: the trial balance does not post receivables or payables

This was wrong in the first version and the end-to-end test is what caught it.
Posting the control accounts from *both* the trial balance and the open-document
detail doubles the receivable — arithmetic that looks right in isolation and is
wrong the moment both files are imported.

So the trial balance **reads** Accounts Receivable and Accounts Payable and
does not post them. Their balances come from the open documents, one row each,
because a receivable is not a number: it is a list of people who owe you, and a
migration that brings across the total without the list produces an aging report
that agrees with nothing. This is what every other product does, and now the
reason is written down.

### Decision 8: an open invoice recognises no revenue

Each imported document posts `Dr Accounts Receivable / Cr Opening Balance
Equity`. The sale happened in the old system and was reported there; recognising
it again here would double the company's lifetime revenue and put a year's
trading into whatever month the migration happened.

### Decision 9: zero is the whole answer

The migration reduces to one figure. Opening Balance Equity nets to zero when
the detail agrees with the balances, and its value is entirely in the failure
case — a non-zero balance is not a mystery, it is *exactly* the amount by which
the customer detail disagrees with the receivables the old system reported.

`openingReadiness` compares the detail against **what the trial balance said**,
not against the Accounts Receivable account. The account is built from the
detail, so comparing it to the detail would compare a figure to itself and
always agree — which is precisely the check somebody needs and the one it
would silently fail to perform.

It also distinguishes a company that migrated cleanly from one that never
migrated at all. Both have a zero here, and telling the second that its
"opening position is complete and consistent" is a reassurance it cannot rely
on.

## Part four: undoing it

### Decision 10: reversal is by name, not by timestamp

"Delete everything created between 14:32:01 and 14:32:09" catches whatever else
happened in those eight seconds — an invoice raised in another tab, a customer
added on a phone. Every row an import creates is named in `import_records`, and
only those rows come back out.

### Decision 11: reversal refuses rather than cascades

If anything the import created has since been *used* — a customer with an
invoice raised against them, an opening invoice that has been part-paid —
reversal stops and says which rows are in the way. Deleting them would either
fail on a foreign key or, worse, cascade and take the newer work with it. The
check runs before the button is offered, so "Undo" is never a button that
fails.

Journal entries are **voided rather than deleted**, because ADR 0002's rule has
held since Phase 2. An entry number that vanished would leave a gap an auditor
is entitled to ask about.

Rows an import *updated* are left alone. An account that already existed and
had its name corrected is not the import's to delete, and restoring the old
name would undo a correction somebody may have built on since.

## Consequences

- **No transaction history, only balances.** A company brings its opening
  position and its open documents, not five years of detail. Prior-period
  comparatives and any report before the opening date will be empty. This is
  the conventional cut and it is still a real limit — a business that wants
  last year's P&L in this system cannot have it.
- **Imported P&L balances land in the current period.** A mid-year trial
  balance carries year-to-date revenue and expense, and they sit in net income
  until the year is closed. Correct, conventional, and surprising the first
  time somebody sees a balance sheet with $31,800 of net income on day one.
- **No credit notes, no part-paid documents.** An open document is a number
  outstanding. A negative balance is refused rather than turned into a credit
  note, and a document that was originally $10,000 with $4,000 paid arrives as
  a $6,000 invoice — so the payment history is lost even though the balance is
  right.
- **No inventory or fixed-asset detail.** The trial balance carries the
  Inventory and Fixed Assets *totals*; the subledgers that Phases 14 and 16
  built are empty, so both reconciliations will report a disagreement until
  somebody enters the detail by hand. The readiness diagnosis names this case.
- **No multi-currency.** Amounts are read as the company's own currency, and a
  file of euro balances would import as dollars without complaint.
- **CSV only.** No `.xlsx`, no QuickBooks `.qbo`/`.iif`, no direct API pull
  from another product. A user has to export first, which every product can do
  and not every user knows how.
- **The whole file is held in memory.** Fine for the tens of thousands of rows
  a small business has; wrong for a file that arrives as a hundred megabytes.
- **Reversal is all-or-nothing per run.** There is no way to undo forty rows of
  a four-hundred-row import.
- **No dimension defaults on import.** Phase 16's `dimension_defaults` are not
  consulted, so imported documents carry no Location or Department.

## Follow-up

1. **Bank transaction history**, which is the one kind of detail people most
   often do want to bring across, and which the categorization engine already
   knows how to handle.
2. **Part-paid documents** — an original amount and a payment applied, so the
   history survives the move.
3. **Inventory and fixed-asset detail imports**, so the two subledgers Phases
   14 and 16 built reconcile on day one rather than after a week of typing.
4. **`.xlsx` directly**, since that is what most people actually have.
5. **Resolve dimension defaults during import**, sharing the work already
   listed as ADR 0016's first follow-up.
