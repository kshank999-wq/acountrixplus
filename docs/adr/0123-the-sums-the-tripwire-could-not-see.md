# 0123 — The sums the tripwire could not see

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 123

---

## How this was found

ADR 0122 nominated `src/app` and the worker: *"A sum written straight into a
page would not be caught."* That checked out as a **directory** question and
came back empty — there is no `sum()` of a face column anywhere outside
`src/modules`.

The nomination was right about the gap and wrong about its shape. It is not the
directory. It is the **form**. Phase 122's file opens:

> No sum adds two currencies together (Phase 122). **It reads the source.**

It reads the source for one syntactic form — `sum(${table.column})`, the SQL
aggregate. This codebase adds money two ways, and the other one,
`rows.reduce((sum, row) => sum + row.amountCents, 0)`, was invisible to it from
the day it was written.

## Measuring the other form

A first pass with a loose regex matched **145 sites**, nearly all legitimate: an
invoice's own lines, a trial balance's ledger balances, a till's tenders.
Shipping that would have buried a real finding under 141 false ones, which is
how a tripwire gets switched off.

Narrowed to what is actually decidable from source — a reduce over a **face
column's own property name**, in a file that reads that column out of its own
currency-bearing table:

```
already declared safe (Phase 122)   1   drawer/service.ts shiftPosition
currency-blind                      3   in two files
```

The first is `shiftPosition`, whose `SAFE_FACE_SUMS` entry already covers it —
the two forms sit inside one function and the scanner saw one of them. The other
two are new, and both matter.

## `createDeposit` was banking a total in no currency

The severe one, because it is a **write**. `createDeposit` sums
`payments.amount_cents` across the receipts being banked and debits the bank
with the total:

```
Dr  <bank>              totalCents
Cr  Undeposited Funds   receiptsCents
```

`payments.amount_cents` is the face amount, and the one face column with **no
functional twin at all** — Phase 122 singled it out as *"the easiest to add up
by mistake"* and then could not see this one. Financial accounts carry no
currency column, so the debit lands as company currency whatever went in.

**The project's own seed has the defect sitting in it.** Ridgeline Construction
holds three undeposited receipts: a €4,000 SEPA transfer from Bremen Hafenbau
at 1.10, and two dollar cheques. Ticking all three and pressing the button
posted **$14,168** to the bank when the functional value is **$14,568** — a
$400 error, in the ledger, three clicks from the front page. `banking.cash_tie_out`
would have reported a difference the next morning with nothing to trace it to.

**A refusal, not a conversion** (Phase 117: a refusal beats a check). A
paying-in slip goes to one bank account and a bank credits one currency, so two
currencies in one deposit is not a rounding question — it is two deposits that
have not been separated yet. Converting would invent a figure the bank statement
will never show.

## `duplicateExposure` is a register check, and it was adding currencies

`payables.duplicate_bills` reconciles suspected duplicates against zero, and its
right-hand side sums `bills.total_cents` and `bills.balance_cents` **across
suppliers**. Two suppliers are two currencies, so a €4,000 pair and a $4,000
pair were reported as "8,000" on the integrity page under the company's own
symbol.

That is the Phase 115 defect exactly — a register check adding face amounts —
**one phase after a tripwire was built to stop it**, hiding behind the form the
tripwire cannot read. It now sums the functional twins.

## What the person reads

Two smaller repairs on the deposits screen, both the same defect one layer out:

- The waiting list rendered the €4,000 SEPA transfer as **"$4,000.00"** — the
  number right, the currency invented. Each row now names its own.
- The running total while ticking is a face sum in the browser. When the
  selection spans two currencies it now shows `—` and says which two, so the
  person finds out while choosing rather than after pressing the button. The
  server refusal remains the guarantee; this is courtesy.

## The scanner that found its own documentation

The first run reported `addition.ts:74` as a currency-blind sum over
`invoices.balance_cents`. That is the `looksLike` field — the example somebody
reads instead of the regex. A registry of patterns will always match itself, so
the declaring file is excluded **by name and by rule**. Tightening the regex
until the example slipped through would have been the dishonest fix.

## What this does not do

**It does not classify all 145 reduces.** The rule is narrow on purpose, and
narrowness has a cost: a reduce names a *property*, not a table, so a site is
attributed by which face columns its **file** reads. That is why one of the
three findings — `deposits.ts:169`, over the deposit's fee items rather than its
receipts — is attributed to `payments.amount_cents` when it is not that column
at all. It sits in the function that genuinely has the defect, so the repair
covers it, but the attribution is a heuristic and is written down as one.

**It does not reach a client component.** `board.tsx` sums receipts in the
browser and the scanner cannot see it, because a client component receives a
plain type rather than reading a drizzle table. The repair there was made by
hand, having been found by looking at the screen. A rule that caught it would
need to follow the prop across the server/client boundary, which nothing here
does.

**It does not prove the two forms are the only two.** `ADDITION_FORMS` is a
registry with a throwing lookup (Phase 101), so a third way of adding money has
somewhere to be declared — but nothing forces the declaration until somebody
notices. That is the same limit Phase 122 had, moved one form along.
