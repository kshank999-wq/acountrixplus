# 0143 — The money columns nobody declared

**Status:** accepted
**Date:** 2026-09-14
**Phase:** 143

---

## How this was found

ADR 0142 ended by saying *"nothing new was found while building this"*. This
project treats a sentence like that as a claim to verify, not a place to stop.

The verification started somewhere else. Two of the last five defects were
**money compared with money**, not summed:

- Phase 138 — `input.amountCents > position.heldCents`, a euro face amount
  against a dollar holding, in the check deciding whether somebody else's money
  may be spent.
- Phase 142 — `min(card.balanceCents, bill.balanceCents)`, a dollar against a
  euro, in the decision saying how much of a debt is forgiven.

Both found by hand, four phases apart. `ADDITION_FORMS` covers the two ways
money is **added** and nothing covers the ways it is **compared**, so a
comparison scan looked like the phase.

Building one meant asking what it would key on, and that is where the real
finding was.

## The defect

`FACE_COLUMNS` is the list of columns holding an amount in a document's own
currency. Both sum scans key on it. It was **seventeen column names typed by
hand**.

Asked of `information_schema`, the carrier tables have **fifty-four** money
columns.

So thirty-seven money columns on currency-carrying tables had no classification
at all. They were not excused by the tripwire that says *"no sum adds two
currencies together"* — they were **invisible** to it, which is worse. An excused
site carries an argument somebody can read and disagree with; an unseen one
carries nothing, and the scan reports all clear.

## This is Phase 128's shape, seven phases of reach failures later

Phase 128 found `CURRENCY_CARRIERS` was nine table names typed by hand when the
schema had thirteen, and that the four missing took twenty-two posting sites out
of reach — including the bank feed. Its fix was to make the registry answerable
to `information_schema`, and its prose said why:

> A list a person maintains drifts the moment somebody adds a column. The only
> trustworthy source for what the schema contains is the schema.

`FACE_COLUMNS` sat beside it, in the same module, with the same failure mode,
and never got the same treatment. That is the seventh instance of this
codebase's recurring reach failure, after Phases 128, 131, 133, 136, 140 and
141.

## What the completed list found

Five sites. Measuring each — rather than counting the flags — found **three real
and two the scan's own narrowing got wrong**.

### The three

| | |
| --- | --- |
| **`contractorPayments`** | Sums `payment_applications.amount_cents` per vendor and compares the total against a statutory threshold in the company's own money. A contractor paid €600 contributes 60,000 to a figure measured against $600, so **a 1099 is filed — or not filed — on arithmetic over incomparable things.** The function mentions no currency anywhere. |
| **`salesTaxReturn`** | Sums `invoices.subtotal_cents` to report taxable sales for a jurisdiction. The result goes on **a return filed with a tax authority.** |
| **`cashBasisCaveats`** | Sums `invoices.tax_cents` to caveat the cash-basis report. It describes rather than decides, which makes it the least severe of the three and still a figure that means nothing across two currencies. |

Two of the three feed a statutory filing. All three sum a column the hand-typed
list did not contain.

### The two that are not defects

- **`openCreditsAsAt`** sums `credit_applications.amount_cents` **grouped by
  `credit_note_id`**, and a credit note has one currency (Phase 63). Every row in
  a group is that currency and the total is in it. `currencyAware` missed it
  because a `groupBy` on a foreign key says nothing about currency *in words*,
  only in fact. Argued into `SAFE_FACE_SUMS`.
- **`previewBilling`** reduces over `time_entries`, which has **no currency
  column**. The scan attributes it to `retainers.amount_cents` only because
  `billing.ts` reads that column elsewhere in the file. That is the known cost of
  ADR 0123's narrowing — *"a reduce over a face column's own property name, in a
  file that reads that column out of its own table"* — and a wider face list
  makes a property-name heuristic guess more often. Argued into
  `SAFE_FACE_SUMS`, with the cost recorded rather than hidden.

## Three sides, not one

A complete list of money columns would have made the scans **noisier** rather
than wider, because not every money column holds a document's currency. So each
column says which money it is:

- **`face`** — the document's own currency. Forty-four of the fifty-four, and the
  only ones the scans ask about.
- **`functional`** — already the company's own money. Five: `refunds.carried_cents`
  is *"functional, off the balance being cleared, at its carried rate"* in the
  schema's own words, and summing it across refunds is sound.
- **`account`** — the account's own currency, not any document's. Five: a bank
  balance and a reconciliation are one account's arithmetic from end to end,
  which is the argument `cashTieOut` already makes in `SAFE_FACE_SUMS`.

The taxonomy was not invented here. Most of these columns already stated their
side in a schema comment; nothing had ever collected the statements into
something a scan could read.

## Indicting rather than excusing

The three live defects are registered in **`BLIND_FACE_SUMS`**, which is the
opposite of `SAFE_FACE_SUMS`. One says *"this sum is provably one currency"*; the
other says *"this sum adds two, and here is what is wrong with it"*. A test
asserts no site is in both.

Putting them in `SAFE_FACE_SUMS` would have been ADR 0134's failure exactly — a
declaration that *excuses* a site is worse than one that misses it, because a gap
invites a look and an excuse ends one.

Each entry names its live defect and points at
`tests/sums-that-add-currencies.test.ts`, skipped and labelled, which is the
definition of done. That is Phase 139's device applied to work needing **no core
at all**: every one of these is a query change, grouping by currency or summing a
functional twin.

## Why they are registered rather than repaired

The staging pass is holding live service paths until the wiring pass. These are
reports rather than banks or deposits, so the instruction does not obviously
cover them — which is exactly why the choice is made visible here rather than
taken quietly. **Repairing all three is small and available on request.**

Leaving them undeclared was the only unacceptable option.

## What this does not do

**It does not repair anything.** A 1099 and a sales tax return are still computed
from sums that add currencies.

**It does not make the sum scans complete.** It makes them *reach* every money
column on a currency-bearing table. Their narrowings are unchanged, and one of
those narrowings produced a false attribution in this very phase.

**It does not cover money that is compared rather than added** — which is where
this phase started.

## What is nominated next

The comparison scan, now that it has something honest to key on.

Measured: **63 money-versus-money comparisons in `src/modules`, 30 of them in
files that read a currency-bearing table, across 23 functions** — relational
(`>`, `<`, `>=`, `<=`), `Math.min`/`Math.max`, and equality. Nothing scans any of
them, and the two defects that opened this ADR were both in that set.

`contractorPayments` is in it twice over: the sum registered here, and the
comparison of that sum against a statutory threshold. The sum is declared now;
the comparison still is not.
