# 0103 — The column that added euros to dollars

**Status:** accepted
**Date:** Phase 103
**Amends:** ADR 0013 (the data export), and the run of currency phases 60–67
whose rule this file never learned.

## The defect

`export.ts` opens by saying what it is for:

> the test this has to pass is not "does it produce a file" but **could an
> accountant rebuild these books somewhere else from it**

And a few lines further down, about CSV quoting:

> That failure produces a file that looks fine and is wrong, which is the worst
> kind.

Both sentences are right, and the file does the thing the second one warns
about. `invoices.csv` has a `total` column. It is
`invoices.total_cents` — the amount **in the currency the invoice was issued
in** — rendered as a bare decimal with **no currency anywhere in the file**.
`bills.csv` and `payments.csv` do the same.

The development company is not a contrived case. Ridgeline has fifteen invoices
in USD totalling 80,719.94 and two in EUR totalling 6,500.00. The old export
wrote all seventeen into one column. Sum it and you get **87,219.94**, which is
not money in any currency. The company's actual receivable is 87,762.69 — the
euro invoices were booked at 4,334.00 and 2,708.75 — so the file was out by
542.75, silently, in the direction of understating what the business is owed.

Its `payments.csv` was doing the same thing with a EUR receipt among four USD
ones.

This is the sum Phase 65 was named for closing ("close the three sums that still
add currencies"). It was closed in the reports, the statements, the chase, the
approval threshold and the aging — everywhere a person looks at a screen. The
export was not on the list, because the export was written at Phase 13 and
nobody trading in one currency would ever see it.

## Decision 1: a money column may not be written without its currency

The mechanism is a type, not a rule in a comment. `units(cents)` took a number
and returned a string, so every call site was one keystroke from being wrong and
none of them could be checked. It is replaced by a function that takes an amount
**and** a currency and returns both columns, plus a `columnsFor(prefix)` helper
that generates the header names from the same place.

That last part matters more than it looks. The header and the row were two
separate hand-written lists — `['number', 'customer', … 'total', 'balance']` and
an object with those keys — so adding a column meant editing both, and getting
them out of step shifts every value in the file by one position. That is the
same failure mode as the unquoted comma the module already defends against,
reached from the other side.

## Decision 2: both the document amount and the functional amount

Invoices and bills already store both — `total_cents` and
`functional_total_cents` — because Phase 65 decided that the rate a document was
booked at is a fact to keep, not a number to recompute. The export carries both.

**Payments are the exception, and finding that out changed the design.** A
payment stores no functional amount for the whole receipt; only
`functional_unapplied_cents`, for the part not yet spent. So its functional
column is *derived* — with `convert`, the same function the rest of the system
uses, from the rate **the payment itself recorded**. That is not recomputing at
today's rate; the rate is a stored fact of that receipt, which is precisely why
Phase 35 stored it. The rate is exported in its own column beside the figure, so
the arithmetic is checkable rather than trusted.

The reason is reconciliation, and it is the first thing an accountant does with
these files: `journal.csv` is in the company's own currency, because the ledger
is. Without the functional column there is no way to tie a euro invoice to the
entry that booked it, and the two files look like they disagree.

Where a functional figure is stored it is **read, never recomputed**. Deriving
one at export time from *today's* rate would restate a document booked in March,
which is both wrong and the exact thing Phase 35 built stored rates to prevent —
a different act from using the rate the document itself carries.

**Both columns appear even when they are equal**, which is the common case and
looks redundant. A column that is present only sometimes breaks every formula
written against the file, and a file whose shape depends on whether the company
happens to have traded abroad is worse than one with a duplicated column.

## Decision 3: a manifest, because the answer to "can I add this up" is per file

The per-currency totals are computed once and written into `manifest.csv`: one
row per exported file, with the currencies it contains and what each one sums
to. It is the first file to open and the one that says, in the case above, that
`invoices.csv` holds two currencies and that no single total exists for it.

This is deliberately not a footer row inside each file — a totals row inside a
CSV is a row that every importer reads as data, which is how a trial balance
acquires a phantom customer called "TOTAL".

## Decision 4: "who took a copy" was showing the oldest ten

`listExports` ordered `asc(createdAt)` and the security page asks for ten. So the
panel headed by the question *who took a copy of everything* answered it with the
**first ten exports the company ever took**, and stopped changing after that. A
company past its tenth export has a panel that renders, looks correct, and can
never show the export that happened this morning.

Newest first, which is what every other listing in this codebase does and what
the question means.

## What this does not do

**It does not add the datasets that are still missing.** `credit_notes`,
`refunds` and `retainers` all carry a currency and none of them is exported at
all — and retainers are somebody else's money, which makes them the sharpest
omission. That is a real gap and a different phase: this one is about the files
that exist being true, not about which files exist.

**`bank_transactions` and `journal.csv` get a currency column naming the
company's own.** Neither `bank_accounts` nor `bank_transactions` has a currency
column, and the ledger is functional-currency by definition, so every row in
both files is in the company's currency **by construction**. That is a fact
worth stating rather than an answer worth inventing: naming it costs one column
and means no money column anywhere in the export is bare, which is the whole
rule. If foreign bank accounts are ever added, this is one of the places that
has to change, and a file that already has the column is easier to change than
one that does not.

**It does not change what the journal exports.** It is functional-currency
throughout, correctly, because that is what a ledger is.
