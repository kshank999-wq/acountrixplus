# 0131 — The currency one join away

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 131

---

## How this was found

ADR 0130 nominated the write-off and deposit residues. That nomination was
measured before it was adopted, which is the rule this project has kept since
Phase 104, and something better turned up on the way: **`money-on-screen.test.ts`
declares a list of currency-carrying tables by hand, and the list is wrong.**

```ts
const DOCUMENT_TABLES = [
  'invoices', 'bills', 'creditNotes', 'payments', 'retainers',
  'recurringInvoices', 'recurringInvoiceOccurrences',
]
```

Seven. The schema has thirteen. This is Phase 128's defect, one file over — that
phase found a hand-typed list of *nine* in `ledger-postings.test.ts`, replaced it
with `CURRENCY_CARRIERS` asked of `information_schema`, and did not look at its
sibling.

Worse, the prose around it says something that is not true. `on-screen.ts`:

> of every table these screens read, **only five carry a `currency` column** …
> Billing schedules, proposals, **deposits**, contributions, purchase orders,
> time entries, assets and statement runs carry none.

and the test:

> Proposals, **deposits**, contributions, purchase orders, time entries, assets
> and statement runs still carry none.

`deposits` has carried a `currency` column since Phase 127 — added by the same
phase, in the same migration, as the write-offs the ADR above went looking at.
So does `invoice_write_offs`, and so do `financial_accounts`, `checkouts`,
`payouts` and `refunds`. This is Phase 110's failure exactly, the one Phase 128
named when it found the same sentence in three registry entries: **a declaration
argued from a schema fact that is not a fact.**

## The bigger half: a currency can live one join away

Fixing the list to thirteen finds four screens. It does not find the one that
matters, because `bank_transactions` **has no currency column and never will** —
it takes the account's. Phase 128 wrote that down:

> A `bank_transactions` row has no currency of its own and inherits this one,
> which is why the bank feed was posting face amounts into the ledger.

Prose, one phase old, never made into anything that checks. The consequence is
that the busiest screen in the application was outside the scan by construction:

**The transaction inbox has shown every row of a foreign account with a dollar
sign since Phase 1.** So has the reconciliation workspace, and so has the mobile
review deck. Four phases of FX work — 122, 123, 124, 128 — and none of them could
see it, because each asked whether the *row* had a currency.

## The rule

A **mandatory** foreign key to a currency carrier.

Not any foreign key. `time_entries.invoice_id` is nullable, because a time entry
exists long before anybody bills it and its rate is the company's own money
whether or not it is ever put on an invoice — that is a link, not a
denomination. A parent that *must* be there is a parent the row has no meaning
without, and that is what inheriting a currency is.

Asked of the schema, thirteen tables qualify. `INHERITED_CURRENCY` declares each
one, names every mandatory carrier parent it has, and splits its `%_cents`
columns into the parent's money and the books'. The test compares that split
against every such column the table actually has, so a column added later cannot
sit unclassified in whichever currency its reader assumed.

Three of the thirteen answer **the books'**, and those are the entries that make
it a registry rather than a list:

- `invoice_costings.cost_cents` is what the stock cost to buy, frozen off
  `consumeStockForSale`. The invoice says what it sold for; this says what it
  cost, and those are not the same money even when they are the same number.
- `tax_remittances.amount_cents` is refused unless it is no larger than what
  `liabilityPositions` says the ledger account owes, so it is measured against a
  ledger balance and is therefore in the ledger's money.
- `bank_transactions.functional_amount_cents` — the twin Phase 129 added — is the
  books' half of a row whose other half is the account's.

## What changed on the screen

Three screens now show a bank transaction wearing the account's currency: the
inbox, the reconciliation workspace, and the mobile review deck. The
reconciliation figures — statement balance, cleared balance, difference — move
with them, and `ReconciliationSummary` carries the currency rather than the page
guessing it from a lookup that can miss.

Nothing about the arithmetic changes. Every one of those figures was already
right: a reconciliation session is self-consistent in the bank's money, and
`summarize` adds and subtracts only transactions on the one account it is for.
They were correct and unlabelled, which is the failure Phase 124 exists to stop
and the one it could not reach.

## The scan sees through `Math.abs` now

The mobile deck writes `formatCents(Math.abs(current.amountCents))`, and the
check matched `formatCents(x.amountCents)` exactly — so widening the table list
alone would have put the deck in reach and still passed it. Thirteen call sites
in `src/app` wrap money that way. The scan unwraps one `Math.abs` before
matching, which is honest about what it can see: a sign is not a denomination,
and hiding a figure behind a call the checker cannot read is how a check becomes
decorative.

## What this does not do

**It does not give a reconciliation a currency column.** It does not need one:
the session cannot exist without an account, and the account has one. That is
the rule this phase is about, applied to itself.

**It does not fix remitting from a foreign account.** `recordRemittance` posts
its `amount_cents` — a ledger figure, in the books' money — against the bank
account it names, and nothing converts. Remit a payroll liability from a euro
account and the bank line carries a functional figure the statement will never
show. It is the Phase 127 shape again, in a corner none of the three FX scans
reaches because the money genuinely is the books' at the point it is written;
what is wrong is where it is posted. `INHERITED_CURRENCY`'s entry for
`tax_remittances` says so out loud, which is the first time it has been written
down anywhere.

**It does not classify the pages that came into reach without a defect.** Widening
the scan reaches budgets, proposals, dimensions, the asset register and the chart
of accounts, all of which show the company's own money and reach a carrier only
because a page imports a module that touches one somewhere else. They join the
measured remainder Phase 124 built for exactly this, and the number moves rather
than a pile of arguments nobody doubts being written to keep it still.

**It does not check that a prop type's currency belongs to the figure beside it.**
The existing check reads the whole file for a `currency` field rather than the
type's own body, so a currency declared on one type satisfies the check for
another in the same file. That is a real hole and it is older than this phase; it
is left alone here rather than fixed in passing, because closing it will find its
own list and deserves its own measurement.
