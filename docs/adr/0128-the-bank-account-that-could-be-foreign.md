# 0128 — The bank account that could be foreign

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 128

---

## How this was found

ADR 0127 nominated a `RegistryError` subclass — eight registry lookups had
tripped Phase 119's bare-`Error` rule, and an allowlist entry per registry is the
wrong shape. That nomination is real, and it is not this phase: it is a change to
error plumbing, and nothing about it was measured except a count.

So the previous ADR's *other* claim was measured instead — the one it made in
passing, as a limit on its own reach:

> **It does not audit the other 108 posting sites.** The narrowing to files that
> read a currency-bearing table is principled — a payroll run cannot be foreign.

The narrowing is principled. The list it narrows by was not.

```ts
// tests/ledger-postings.test.ts, as Phase 127 committed it
const CURRENCY_TABLES = [
  'invoices', 'bills', 'creditNotes', 'payments', 'retainers',
  'recurringInvoices', 'recurringInvoiceOccurrences',
  'invoiceWriteOffs', 'deposits',
]
```

Nine names, typed by a person. `information_schema` says **fourteen** tables have
a `currency` column, thirteen once `companies` — the functional currency, the
thing the others are measured against — is set aside. The four missing were
`financial_accounts`, `checkouts`, `payouts` and `refunds`.

Widening the scan to the thirteen takes it from 81 sites to **103**: twenty-two
newly in reach, across eight functions that had never been asked what currency
their money was in. One of them is `ledger/posting.ts`, which is where money
**first enters the books**.

## The defect

```ts
// src/modules/ledger/posting.ts, buildLines
const magnitude = Math.abs(transaction.amountCents)
```

`bank_transactions` has no currency column. It inherits the account's, and
`financial_accounts.currency` has been there since the banking schema was first
written — `createFinancialAccount` genuinely stores it, so a business really can
hold a euro account.

**Every categorised transaction on a foreign account posted a face amount into
the functional ledger**, from the day the bank feed was built. A €500 charge
became $500 of expense instead of $550. Splits, the same. Transfers, the same,
and a transfer between accounts in *different* currencies was posted as though
one figure covered both legs.

## The check that agreed

`banking.cash_tie_out` exists to catch exactly this: the ledger against the feed,
per account, every night. It agreed to the cent.

It agreed because both sides were the same face amount. The ledger side was euros
because of the defect above; the feed side is `sum(bank_transactions.amount_cents)`,
which is euros because that is what the bank said. The check was comparing a
number with itself.

ADR 0121 built `FALSIFIERS` to stop precisely this, and this entry's own argument
had the words in it already — *"rather than one number being compared with
itself"* — as the thing it was guarding against. It was literally true, and the
falsifier could not see it, because the falsifier proves a check *can* move, not
that both sides are in the same units.

That makes the tie-out part of the fix rather than a consequence of it. Repairing
the posting alone would have turned a blind check into a nightly false alarm on
every foreign account. `cashTieOut` converts the feed side too now — a day at a
time, at the rate `buildLines` used for that day, since a transaction and its
splits are one movement on one day. It reports the account's own currency, the
face figure, the converted figure, and a difference computed between two numbers
of the same kind. A domestic account short-circuits before the query and its
numbers are byte-for-byte what they were.

This is still a check, not a tautology: a feed row that never posted, a row
posted then uncategorised, an invoice payment that moved the ledger without a
feed row, and a manual journal all still show up.

## A correction to ADR 0127

Four declarations committed one phase ago say, in these words:

> `financial_accounts` carries no currency column — Phase 40 gave each one a
> ledger account, not a denomination

Three in `LEDGER_POSTINGS`, one in `SCREEN_MONEY`. It is false, and it was
written into registries whose entire purpose is that they can be trusted without
re-checking. This is the Phase 110 failure exactly — a declaration argued from a
schema fact that is not a fact — and Phase 125's, and the reason ADR 0127's own
first section says a nomination is a claim rather than an instruction.

The four are corrected in place and marked as corrections rather than rewritten
silently, on Phase 70's rule for the books: a correction says what it is.

## The fix is that the list is not a list

A registry of tables typed by a person drifts the moment somebody adds a column,
and nothing tells anybody. `fx/carriers.ts` declares all thirteen with an
argument each for whose currency it is, and `tests/currency-carriers.test.ts`
compares the set against `information_schema.columns`. A fourteenth table cannot
be forgotten; it can only be declared or fail.

That is the shape `paired-money` has used since Phase 116 for its constraints,
for the same reason: **the only trustworthy source for what the schema contains
is the schema.** Phase 127's scan reads `carrierProperties()` now, so the
narrowing stays principled and stops being a memory.

## What refuses rather than guessing

- **No rate on the day money moved.** `rateFor` throws, `buildLines` does not
  post, and the transaction stays in the feed where a person can see it — Phase
  117's rule, Phase 64's precedent, and a sentence that already says what to do.
  Posting at *some* rate nobody chose would be this phase's own defect wearing a
  hat.
- **A transfer between accounts in different currencies.** The bank takes one
  amount out and puts a different one in; the difference is a realised gain
  nobody has decided to recognise. Categorise each side on its own. Phase 123's
  answer for a two-currency deposit, one layer down.
- **A tie-out it cannot convert** reports `null` and says how many transactions
  sit on a day with no rate, rather than reporting agreement it cannot support.

## What this closes

**Twenty-two posting sites**, in `funds/contributions.ts`, `ledger/posting.ts`,
`payroll/remittance.ts` and `properties/deposits.ts`. Eight new `LEDGER_POSTINGS`
declarations: two `converted` — the two this phase repaired — and six `domestic`,
each arguing from its own code why the money it posts cannot be foreign.

**A ninth allowlist entry** for a registry throw, which turns ADR 0127's
nomination from an argument into a measurement: nine entries now say the same
thing nine ways, and each new registry costs a tenth.

## What this does not do

**It does not repair books already affected.** Every foreign bank transaction
posted before this is still in the ledger at its face value. Correcting one is a
decision with a date and a reason through Phase 70's vocabulary, not something a
migration may do behind anybody's back — the same answer ADR 0127 gave for the
residue it recorded. What this guarantees is that no new posting adds to it.

**It does not record the rate a bank transaction posted at.** Every other moving
money column has carried its pair since Phase 116; this one derives the rate
twice, once to post and once to tie out. They agree unless somebody edits a rate
after the fact, and then the tie-out disagrees for a reason it cannot explain.
That is the next phase's shape, and it is the only thing the repaired check still
cannot catch.

**It does not make the feed multi-currency.** A `bank_transactions` row still has
no currency of its own and still takes the account's, which is right: money in a
bank is denominated by the bank.
