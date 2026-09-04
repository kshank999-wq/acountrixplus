# 0127 — The face amount that reached the ledger

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 127

---

## How this was found

ADR 0126 nominated the last two thirds of ADR 0125's `unrecorded` gap:

> **It does not give write-offs or deposits their currency column.** Each is a
> migration and a backfill decision of its own — the write-off takes its
> invoice's, a deposit takes its receipts' (single since Phase 123, recorded
> nowhere).

Verified before adopting, on the rule this project has kept since Phase 110: a
nomination is a claim, not an instruction. Both columns really were absent. But
reading *why* they mattered turned up something the nomination had framed as
tidiness and was not.

## The defect

The ledger is kept in one currency. Every balance, every report, every nightly
check reads it as the company's own money — that is what *functional* means. So
a face amount reaching `debitCents` or `creditCents` is not a rounding question.
It is a number in the wrong currency, posted, and it stays.

```
recoverWriteOff   Dr Bank / Cr Bad Debt  input.amountCents   ← the invoice's face
createDeposit     Dr Bank                totalCents          ← the receipts' face
                  Cr Undeposited Funds   receiptsCents       ← the receipts' face
```

Measured on the database before a line was changed:

**A €2,500 invoice written off and recovered in full leaves $250 of bad-debt
expense on the books forever.** `writeOffInvoice` converts correctly and posts
the functional **$2,750**. The recovery posts **$2,500** — the euros, as if they
were dollars. The bank is debited a figure that is neither what arrived nor what
it was worth, and `badDebtSummary` reports `netCents: 0` while the profit and
loss carries $250 of loss. Two answers to one question, which is this codebase's
oldest named defect.

**A €500 receipt leaves $50 in a clearing account nothing can clear.**
`recordPayment` debits Undeposited Funds the converted **$550**. Banking it
credits **$500**. `banking.cash_tie_out` disagrees every night afterwards with
no traceable cause — the exact symptom Phase 123's comment describes and half
fixed.

## Why the two are one defect

The missing column is not the defect. It is the reason the defect could not be
fixed locally: **neither write had a functional figure to post, because neither
table kept one.** `writeOffInvoice` computed the loss, posted it and threw it
away — Phase 65's shape and Phase 112's, a third time. That reframing is what
turns two migrations into one phase.

## The vocabulary was already there

Reading all **189** posting sites in `src/modules` and narrowing to the **81** in
files that read a currency-bearing table — Phase 123's narrowing, and what makes
this 28 functions rather than an audit of everything — the convention is
unmistakable. Money that reaches the ledger is called `functionalCents`,
`receivedCents`, `carriedCents`, `relievedCents`, `realisedCents`, `paidCents`,
`lossCents`: the vocabulary of a conversion that has happened.

The two defects were the only sites posting something still named after a
document's own amount. So the rule is checkable by reading the source, which is
what `tests/ledger-postings.test.ts` now does. `LEDGER_POSTINGS` declares each of
the 28 symbols as `converted`, `domestic` or `ledger` and argues it from where
the number comes from — Phase 122's device for sums, Phase 124's for screens,
now for the last hop, where a number becomes a journal line and stops being
anybody's opinion.

## The scanner earned its place on the first run

It found a third gap, in the function this phase was already repairing. A
deposit's non-receipt line — a bank charge, interest, a rounding adjustment —
is an amount typed against a chart account, and a chart account has no currency.
On a foreign batch that made `totalCents` a sum of euros and dollars: the very
thing Phase 123 refused for the receipts, left open on the line beside them.

`createDeposit` refuses the combination now, for Phase 123's reason exactly —
the bank statement shows one figure in one currency, and inventing the other
half from today's rate would put a number on the reconciliation that nothing at
the bank matches. The exemption that lets `item.amountCents` stay unconverted is
declared in `alsoDomestic` and has to name itself in its own argument, the shape
Phase 124 used for `fields`.

## What the backfill records

**What the ledger actually contains, not what it should have contained.** The
two differ for exactly the rows this phase is about, and rewriting them in a
migration would erase the evidence while leaving the journal entries untouched —
a second disagreement on top of the first.

So `functional_amount_cents` takes the invoice's rate (what `writeOffInvoice`
posted), `functional_recovered_cents` takes the *face* recovered amount (what
the recovery posted), and a deposit takes face = functional throughout. For
domestic rows these are the same number, which is why the defect survived 47
phases unnoticed. For a foreign one the residue is now written down where
somebody can see it. Repairing a historical posting is a correction with a
reason and a date, through the vocabulary Phase 70 built; it is not something a
migration may do behind anybody's back.

## What this closes

**`badDebtSummary`.** ADR 0125 recorded it in `NAME_COLLISIONS` as adding
currencies and unfixable without the column. It sums the functional twins now
and agrees with the profit and loss beside it — browser-verified on seeded data:
written off $7,900, recovered $5,500, net bad debt $2,400, matching the account
balance exactly.

**The `unrecorded` basis.** Phase 126 closed the first of ADR 0125's three
tables; this closes the other two, and **no entry carries that basis today**. It
stays in the vocabulary rather than being deleted — the gap it names will recur
the next time a table stores money without saying what it is in, and ADR 0125 is
the record of how much a phase can miss while calling such a figure probably
fine.

**Two `PAIRED_COLUMNS` tables and four pairs**, with the moving one carrying the
constraint Phase 116 established. Six moving constraints now, all verified
against `pg_constraint` by the test that has asked the database rather than the
registry since Phase 116.

## What this does not do

**It does not repair the books of anybody who already hit this.** The columns
record the residue; correcting it is a decision with a date and a reason, and
belongs to whoever owns those books. What this phase guarantees is that no new
posting adds to it.

**It does not audit the other 108 posting sites.** The narrowing to files that
read a currency-bearing table is principled — a payroll run cannot be foreign —
and it is the same narrowing Phase 123 argued for. If a domestic-only module
ever grows a foreign amount, its file will start touching one of those tables
and the scan will reach it.

**It does not make a deposit multi-currency.** Two currencies on one paying-in
slip is still a refusal, and now so is one currency plus a typed line in
another. Both are two deposits that have not been separated yet.
