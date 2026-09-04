# 0121 — The checks that had only ever agreed

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 121

---

## How this was found

ADR 0120 nominated extending the tripwire to `src/lib` and `src/worker`. That
checked out and was not worth a phase: **two** person-facing bare throws in
those layers, both naming environment variables, both belonging in the allowlist
rather than being converted.

So the measurement moved. The books were clean — the register run across all
seven seeded companies reported **0 faults and 0 checks that threw** — so there
was no contradiction to chase. Instead, a question nobody had asked about the
register itself: **how many of its checks has anything ever seen fail?**

Searching every test for an assertion that a given check reports `agrees:
false`:

```
proven to disagree at least once    7
only ever seen to agree            13
```

A check that has only ever been seen to agree is not a check. It is a green
light with no wiring behind it, and this codebase has been bitten by exactly
that twice, both times by accident and phases apart:

- **Phase 115.** `receivables.customer_credit` summed held amounts in the
  currency each payment was taken in and compared the total against a
  functional-currency ledger balance. It had agreed for eighty phases, because
  every set of books it had ever run against was single-currency.
- **Phase 117.** `inventory.goods_received` reconciles `2050` against goods
  receipt rows, and the project's own seed had been crediting `2000` on four
  receipts since the seed was written.

## What the register already declared, and what it did not

The register is unusually well documented. Each check states what it
**compares**, what a difference **means**, and — since Phase 109, verified in
Phase 110 — how far back it **reaches** and why. It had never stated **what
would make it disagree**.

`src/modules/integrity/falsifiable.ts` now does, for all twenty, and
`tests/integrity-falsifiable.test.ts` applies each one: build books, assert the
check agrees, make the declared change, assert it disagrees.

The shape fell out of the measurement. **Seventeen of the twenty reconcile a
subledger against one named ledger account**, so their falsifier is the act the
check exists to catch — a hand-written entry straight at the control account,
which ADR 0033 already said nothing legitimately does.

## What it found

**Fifteen passed on the first run.** The other five each taught something, and
four of the five were the falsifier being wrong in a way that only writing it
could expose:

**`inventory.lots` — the register named the wrong account.** Its `compares` line
read *"Σ open lots against 1300"*. `1300` is **Prepaid Expenses**; the inventory
account is `1400`, which is what the code has always read. The check was right
and its description was wrong, and that description is what a business reads on
the integrity page to understand what it is being told. The falsifier trusted
the prose and failed, which is precisely what a falsifier is for: **it makes the
prose checkable.** Now corrected, and it names the item-specific accounts too.

**`parties.shared_addresses` — "address" means the email one.** The check selects
`id`, `name` and `email` and clashes on those. Nothing in it reads a postal
address. Discovered by writing a falsifier that set one and watching the check
stay green.

**`funds.untagged_contributions` — it reads two named accounts.** Contribution
and grant revenue, not revenue at large, so a gift posted to `4000` is invisible
to it. Correct behaviour; the falsifier had to learn it.

**`payables.duplicate_bills` — two of its three routes are closed by design.** A
repeated supplier reference is refused outright and cannot be overridden
(*"there is nothing for a person to know that the supplier's own numbering does
not already say"*), and two bills that **both** carry references are never warned
about, because the supplier has already said they are two documents. What is
left — and therefore what this check is actually for — is the *unreferenced*
resemblance somebody chose to proceed past. Establishing that took being turned
back twice.

**`banking.shared_ledger_accounts` cannot be falsified at all**, and that is the
finding rather than a scenario error.
`financial_accounts_chart_account_unique` refuses the second row — from the
application and from a migration alike — so the state this check looks for is
one the database will not hold. Either the constraint is newer than the check
and quietly made it moot, in which case it should be retired the way Phase 116
retired `fx.conversions`; or the check is for books that predate the constraint,
in which case it should say so. It stays in `NOT_YET_PROVEN` with that question
written down, because deciding it is a phase of its own.

**Nineteen of twenty proven. One recorded, with its reason.**

## Two corrections made along the way

Both were mine, both caught before they misled anything, and both are worth
recording because the first would have been a spectacular false alarm.

**The first integrity probe read the wrong field.** It treated `severity` as the
result and reported every check failing on every company. `severity` is each
check's *declared* level — what it would report at **if** it disagreed —
and `agrees` is the result. Re-read correctly, all seven companies are clean.

**The first falsification sweep said fifteen unproven.** A wider window over the
test files found two more genuine cases. The number is thirteen.

## What this does not do

**It does not settle `banking.shared_ledger_accounts`.** See above. The entry in
`NOT_YET_PROVEN` is what stops the question being forgotten, and the test asserts
the list never grows past one.

**It does not prove a check is *right*, only that it is *live*.** A falsifier
shows the two sides are really being read from different places. It says nothing
about whether the comparison is the correct one — Phase 115's check would have
passed a falsifier while still adding euros to dollars, because a
single-currency falsifier moves both readings the same way.

**It does not cover the reports outside the register.** Aging, statements, the
trial balance and the cash-flow statement all reconcile things, and none of them
declare a falsifier. The register was the place with twenty of them in one list.
