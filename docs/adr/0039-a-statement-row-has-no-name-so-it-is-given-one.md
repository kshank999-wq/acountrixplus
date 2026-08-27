# ADR 0039 — A statement row has no name, so it is given one

- **Status:** Accepted
- **Date:** 2026-08-27
- **Context:** Spec §3, §17. Phase 1 built the transaction inbox and a
  `BankProvider` seam. Phase 17 built importing — for the chart of accounts,
  contacts and opening balances, and nothing else.
- **Builds on:** [ADR 0017](0017-nothing-is-imported-until-all-of-it-can-be.md),
  [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0001](0001-modular-monolith-and-tenancy.md)

## Context

Transactions could only arrive through a `BankProvider`, and the only adapter
is the mock. So a real business with real books could not get a single real
transaction into the system, and everything downstream — categorisation, the
rules engine, reconciliation, the whole of Phase 1 and 2 — was unreachable with
their own money.

Phase 17 already imports files, and stopped one table short of the one that
matters most. Every bank on earth exports CSV. This is the path that needs no
vendor, no credentials and nobody's integration to approve.

## Decision 1: it imports into the feed, not the ledger

Rows land in `bank_transactions` — the same table, the same inbox, the same
`review_state = 'new'` a connection would have produced. **Nothing posts.**

A statement is evidence of what happened, not a decision about which account it
belongs in, and the person who downloads the CSV is not thereby saying that
COFFEE HOUSE is entertainment. Categorisation, the rules engine and
reconciliation are all Phase 1's and are reached unchanged, because a statement
row is the same kind of fact whether a machine fetched it or somebody
downloaded it.

That is also what makes reversal safe, and it is why this import needed no new
posting code at all.

## Decision 2: the identity problem, which is the whole phase

`bank_transactions` dedups on
`(company_id, financial_account_id, provider_transaction_id)`, and the schema
comment says why that works:

> *"the provider's id is immutable, so re-importing the same window is a no-op
> at the database level rather than something application code has to remember
> to check."*

**A CSV statement has no such id.** A bank gives you a date, a description and
an amount, and nothing that survives being exported twice. So the row has to
identify itself by what it is — and the obvious way to do that is wrong.

### Why a content hash alone loses money

Hashing `(date, amount, description)` looks sufficient. Somebody who buys two
identical coffees on the same day has **two transactions and one hash**. The
second disappears — not with an error, but by being silently deduplicated
against the first, which is the worst way for bookkeeping software to be wrong:
the books are short by £4.50 and nothing anywhere says so.

So the fingerprint carries an **ordinal**: the position of this row among the
rows in the same statement that are otherwise identical to it. Two identical
coffees are `#1` and `#2` and stay two transactions. Re-importing the same file
produces the same two ordinals and imports nothing, which is the whole point.

Order is the file's own, which is what makes the ordinal stable: two exports of
the same day list that day's rows in the same order, so February's rows come
back with the identities they already have when the March export overlaps them.

### Two details that are not decoration

- **Prefixed `csv:`**, so it is obvious in the database where a transaction
  came from and it can never collide with a real provider's id namespace.
- **Length-prefixed canonical form** — `parts.map(p => `${p.length}:${p}`)`.
  Without it a description ending in the field separator can be arranged to
  look like the next field and forge a collision with a different row.

## Decision 3: the bank's debit is money leaving you

Banks disagree about how to say it, and getting this backwards inverts every
figure on the profit and loss:

- **One signed column.** `-4.50` is a spend. Taken as written.
- **Two columns**, `Debit`/`Withdrawal` and `Credit`/`Deposit`. A debit *on a
  bank statement* is money leaving your account — the opposite of a debit in
  your own ledger, because the statement is written from the bank's side of the
  relationship, where your balance is their liability.
- **The magnitude is used** in a labelled column. Some banks write `-4.50` in a
  column already headed Withdrawal, and negating it twice turns a spend into
  income.
- **Both columns filled is a refusal, not a sum.** Netting would post a
  transaction that appears nowhere on the statement.

## Decision 4: reversal deletes rather than voids, and refuses once anybody has spoken

ADR 0002's rule is that posted entries are never erased. A feed row is not a
posted entry — nothing has been posted — so an untouched row is deleted
outright, and re-importing the file puts it back identically. That is the
fingerprint earning its keep a second time.

It refuses once a row has been **categorised and posted**, or **cleared on a
reconciliation**. Both are somebody else's work built on top of the import, and
the same rule the other kinds follow for a different reason.

## Decision 5: importing a statement is a bookkeeper's job, and so is undoing it

`revertImport` required `accounting:journal`, which a bookkeeper does not have
— and the person who imports a statement into the wrong account is a
bookkeeper. Requiring an accountant to clean up after them is how the wrong
import stays there.

So reversal now asks for the permission that matches the run: `bookkeeping:import`
for a statement, `accounting:journal` for anything that voids a journal entry.
The wizard follows: it used to be gated as a whole on `accounting:journal`,
which hid the bank-statement form from exactly the person who needs it. The page
now names which kinds this person may import rather than gating on the stricter
of two different jobs.

## The bug browser verification caught

Re-importing last month's file showed **"Ready to import"** over **"To add:
0"**, with a live Import button.

`finishPlan` sets `canCommit = errors === 0 && total > 0`, which is right for
every kind that existed before: a file with rows and no errors has work in it.
A statement is the first kind where **every row can be a legitimate skip** —
re-importing an overlapping window is the normal way this gets used — so a
perfectly readable file of three rows you already have passed the check.

Committing it would have written an `import_runs` row of three rows and nought
created: a line in the history saying an import happened when none did, in the
one place that exists to answer *"where did these four hundred transactions come
from"*. The plan now reports `canCommit: false` in that case and the service
refuses with the true reason — *you already have all 3 of these* — rather than
Phase 17's "there is nothing in this file to import", which would be a lie about
a file full of perfectly good rows.

The screen says *"You already have all of this"* rather than "Not ready yet",
because sending somebody to hunt for a problem in a file that has none is its
own small bug.

## Consequences

- **Two identical coffees on one day are safe; three exports that disagree
  about their order are not.** The ordinal rests on the bank listing a day's
  rows the same way each time, which every export format observed does and none
  guarantees. A bank that re-orders a day would produce duplicates rather than
  losses — the safer failure, and the one somebody can see.
- **A corrected row is a new row.** If a bank restates a description or an
  amount, the fingerprint changes and the old row stays beside the new one.
  There is no way to tell that from a genuine second transaction using only
  what a CSV carries.
- **No OFX, QFX or CAMT.053.** Those formats *do* carry an immutable id, which
  would make all of the above unnecessary for the banks that offer them. CSV was
  built first because it is the format everybody has.
- **No PDF statements.** The commonest thing a person actually has to hand, and
  it is a different problem — extraction, not parsing.
- **The inbox is date-sorted**, so importing a statement from six months ago
  puts it on page two or three rather than in front of the person who just
  imported it. Correct for the inbox and mildly surprising here.
- **Nothing checks the closing balance.** The plan reports the net movement of
  the new rows so it can be compared against the statement by eye; it does not
  know what the statement said the balance was, so it cannot prove a row is
  missing. That is the check worth having next.

## Follow-up

1. **Read a closing balance**, so an import can prove it accounts for the whole
   movement rather than asking somebody to compare two numbers.
2. **OFX/QFX**, using the id the format already carries and skipping the
   fingerprint entirely.
3. **Remember the column mapping per account**, so the second month's import of
   the same bank's export is one click.
4. **A statement import is a reconciliation's other half.** Phase 4 clears
   transactions against a statement somebody reads; this is that statement.
   Wiring the two together is a phase.
