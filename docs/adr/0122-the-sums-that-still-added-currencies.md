# 0122 — The sums that still added currencies

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 122

---

## How this was found

ADR 0121 nominated two things and left one question open. The question was
`banking.shared_ledger_accounts`, which no falsifier could reach; the second
strand of this phase settles it. The first strand came from measuring something
else.

Phase 65 closed *"the three sums that still add currencies"*. Phase 115 found
the integrity register doing the same thing and repaired it. Phase 116 gave
every face amount a functional twin and a constraint keeping the pair honest.
Three phases, spread over fifty, each closing instances of one defect — and
nothing had ever asked how many were left.

Asking it, across `src/modules`, over every `sum()` of a face-amount column,
classified by whether the query groups or filters by currency:

```
currency-aware   4
currency-blind   8   in six files
```

## Two of the eight decided money

The other six report. These two are arithmetic somebody acts on:

**`vendorCreditBalances`** totals what each supplier owes back, keyed by
supplier, and the pay run nets that total against what is owed to them. A €500
credit and a $500 credit made "1000" of nothing, and that number came off a
payment. It is now keyed by supplier **and currency** — `vendorCreditKey` —
because two credits in two currencies are two balances, and there is no third
number that is both.

**`assistants.ts`** computes revenue concentration, the largest client's share
of turnover, by summing invoice totals and dividing. Adding across currencies
and then taking a percentage is arithmetic on incomparable things, and the
percentage is advice a business acts on. It reads `functional_total_cents` now
— the twin Phase 116 built for exactly this.

The rest: two customer/supplier deactivation refusals reading face balances
(now functional), and one cash-basis sum that was **computed and never read**,
which is deleted rather than repaired.

## The rule, written down where the next one will trip over it

`src/modules/fx/comparable.ts` names the nine face columns and says, per column,
what it holds in the terms of the books. A sum of one has to do one of three
things:

1. **Group by currency**, so each total is one currency and says so.
2. **Convert first** — sum the functional twin, or `convert(amount, rate)` at
   read time where there is none.
3. **Be provably one currency already**, in which case it argues that here.

`tests/comparable-sums.test.ts` reads the source and enforces it. Two sums take
route 3, both in the cash drawer, and the entry for them was **verified in the
code rather than argued from what a till is like**: `takeCounterPayment` never
passes a currency to `recordPayment`, so every receipt reaching a drawer
defaults to the company's own.

### `payments.amount_cents` has no twin at all

`PAIRED_COLUMNS` pairs `unapplied_cents` with `functional_unapplied_cents` and
notes that a payment "stores its rate and `amount_cents` but no converted
total". So the whole amount of a payment can only be made comparable by
converting it at read time. That is the trap in four of the eight sites, and it
is why `FACE_COLUMNS` is written out rather than derived from `PAIRED_COLUMNS`.

## `banking.shared_ledger_accounts` is retired

Phase 121 could not write a falsifier for it and recorded the question rather
than guessing. The answer is in the migration.

The check and `financial_accounts_chart_account_unique` arrived in **the same
commit** (Phase 40), and that migration says what it does before adding the
constraint:

> The unique constraint at the bottom is the fix. It cannot be added to books
> that already have a sharing pair, so this repairs them first: each account
> after the first gets a ledger account of its own.

The check's own `meaning` said it was for *"books that were migrated with one
already in place"* — and those were repaired by the migration that installed
the check. Every book since has been refused a pair by the constraint. It has
been unable to find anything from the moment it was written, and it ran on every
company every night saying so.

Phase 116 put the general form of this: **a constraint beats a check.** Here the
constraint arrived first, in the same breath.

`sharedLedgerAccounts` goes with it. Its doc comment claimed it was "kept as a
query rather than only a constraint" for migrated books — the same false premise
— and this register was its **only caller in 82 phases**. Phase 49's rule read
backwards: a function whose one caller is retired is a feature that no longer
exists.

### What the tests said about it, and what replaced them

Three tests exercised it. The middle one is the argument in miniature: to give
the check something to find, it had to `ALTER TABLE ... DROP CONSTRAINT` inside
a transaction it then rolled back. A test that has to take the database apart to
construct the state is the check telling you the state cannot occur.

They are replaced by one test that asserts the constraint directly — the
insert is refused, naming `financial_accounts_chart_account_unique` — and by
`new Set(numbers).size === numbers.length` where the query's `=== []` used to
sit, which says the same thing about the data rather than about a second reading
of it.

**The register is nineteen checks, and `NOT_YET_PROVEN` is empty.**

## What this does not do

**It does not cover `src/app` or the worker.** The scan reads `src/modules`,
where the money logic lives. A sum written straight into a page would not be
caught, and the answer to that is the same as Phase 119's: the layer that holds
business logic is the layer that gets the tripwire, and `src/app` holding none
is a rule enforced elsewhere.

**It does not make the six reporting sums wrong-proof, only currency-aware.** A
deactivation refusal that now reads the functional balance is comparing like
with like; whether the threshold it compares against is the right one is a
different question nobody has asked.

**It does not settle whether a face sum should ever be shown.** Grouping by
currency produces several answers where a page has room for one. Phase 61 chose
face for statements and Phase 111 chose functional for aging, from opposite
arguments about audience — and each new report still has to make that choice
for itself. This file only stops the choice being made by accident.
