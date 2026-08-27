# ADR 0040 — A bank account is an account, not a label on somebody else's

- **Status:** Accepted
- **Date:** 2026-08-27
- **Context:** Spec §3, §5, §19. Phase 1 built the transaction inbox and a
  `BankProvider` seam. Phase 39 built statement import. Neither built the thing
  both of them point at.
- **Builds on:** [ADR 0039](0039-a-statement-row-has-no-name-so-it-is-given-one.md),
  [ADR 0033](0033-a-check-nobody-runs-is-not-a-check.md),
  [ADR 0002](0002-double-entry-ledger.md)

## Context

Two things were wrong, and the second was hiding behind the first.

**A business could not open a bank account.** `financial_accounts` rows were
only ever written by `connectInstitution` — that is, by an aggregator — and by
the seed. A company that signed up on the live site and banked somewhere the
aggregator does not reach had none, and without one there is no statement
import, no reconciliation, no deposit, no counter takings and no payroll
remittance. Every one of those features needs an account to point at, so all of
them were unreachable. Phase 39 shipped a statement importer whose account
picker, for a real new customer, was empty.

The only button that would make one connects the **mock** provider, which
generates transactions that never happened and files them in real books.

**And the accounts that did exist shared ledger accounts.**
`createFinancialAccounts` pointed everything that was not a credit card at
`1000 Checking Account`. The seeded demo had a current account and a deposit
account on one line:

```
Business Checking | 1000 Checking Account
Business Savings  | 1000 Checking Account
```

## Decision 1: one bank account, one ledger account

A balance sheet with one line for two real accounts can report what the two of
them hold together and cannot report what either holds. That is the only
question a bank statement asks, so the chart was unable to answer the question
it exists for — and Phase 39's importer would have piled two banks' statements
onto one line.

The pairing is now exclusive and the **database** enforces it, on
`(company_id, chart_account_id)`. Not an application check: two people
connecting institutions at once would both pass one, and this codebase's rule
is that where two people can act at once, the database arbitrates.

The service checks first anyway, because the message matters. *"Business
Savings already posts to that ledger account"* is something somebody can act
on; a unique-violation stack trace is not.

## Decision 2: opening an account mints its ledger account

Nobody should have to know what a chart account is to open a bank account. So
one is created in the same transaction, named after the bank account — mask and
all, because two accounts at one bank are told apart by their last four digits
and nothing else. A rename renames both, since one thing under two names is how
somebody reconciles the wrong one.

Numbering is banded by kind (`numbering.ts`): checking `1000–1009`, savings
`1010–1039`, cash `1050–1069`, cards `2100–2139`, loans `2400–2439`. Bounded
rather than "the next free number anywhere", because every report sorts by
number and a current account numbered 1150 would sit among the receivables for
ever. A full band is a refusal that names the range, not a spill into the next
one.

The first account of a kind lands on the number the standard chart already
names, reusing that account rather than leaving a new line beside an empty one
— but **only** `band.from`, and only when nothing posts to it. An account
somebody created themselves at 1015 is theirs, and renaming an account that
already carries a balance would relabel history: the figures under the old name
would silently become figures under the new one.

## Decision 3: closing, never deleting

The transactions are posted, the reconciliations happened, and a closed
account's history is exactly what somebody looks at a year later. Deactivating
takes it off every picker and leaves every figure — the same rule ADR 0002 set
for journal entries, for the same reason.

The ledger account goes inactive with it, because a closed bank account whose
ledger line is still offered for categorisation is a line somebody will post to
by accident and that will never reconcile against anything. Closing is refused
while a reconciliation is open, since a session on an account nobody can reach
is one nobody can finish or abandon.

## Decision 4: the check this makes possible

`banking.cash_tie_out` compares each account's ledger balance to its own posted
transactions. **It could not have existed before**: with two accounts on one
ledger account the ledger figure covers both, so the comparison is meaningless
in exactly the case where somebody needs it.

It is a **position, not a fault**. Money legitimately enters a bank account
from an invoice payment that never appeared in the feed, and rows still in the
inbox have not posted at all — so a difference is a figure worth knowing rather
than an accusation, and the uncategorised count is reported beside it. ADR 0033
says a register stays useful exactly as long as everything in it can fail;
alarming on ordinary trading is how it stops being read.

`banking.shared_ledger_accounts` **is** a fault, and exists for books migrated
from before the constraint. Nothing legitimately produces one.

## Decision 5: repairing existing books, and what cannot be repaired

The constraint cannot be added to books that already have a sharing pair, so
migration `0039` splits them first: each account after the first gets a ledger
account of its own, and the postings that provably belong to it move across.

*Provably* is doing real work. Only lines on entries derived from that
account's **own bank transactions** move. A payment recorded against an invoice
names a chart account and nothing else — nobody can now say which of the two
real accounts that money went into — so those lines stay where they are rather
than being guessed at. The split is honest about being partial.

The band mapping is duplicated into the migration in SQL. That is a real cost;
the alternative is a migration that cannot run without the application, which
is worse.

## The bug browser verification caught

Running the checks against the seeded books, the finding read:

> difference **$92,279.30** — *Business Checking **−$92,476.00**, Business
> Credit Card $196.70*

One finding, one word, two signs. The register computes
`differenceCents = leftCents - rightCents` and documents `left` as the
subledger side, so the headline was *feed less ledger*; `cashTieOut` computed
its per-account difference as *ledger less feed*. Both were internally
consistent and they contradicted each other on the same row of the same screen,
which is the reading somebody would act on.

Invisible to the tests, because the only per-account assertion was that a
balanced account differs by zero — and zero has no sign.

## Consequences

- **The mock feed is now labelled rather than gated.** `connectAndSyncAction`
  says the transactions came from a sample feed and points at statement import.
  Gating it outright was considered and rejected: the demo checklist depends on
  it, and a deployment with no aggregator contracted is every deployment today.
  A business that clicks it still gets invented transactions in its books, and
  the honest fix is a real adapter.
- **Nothing splits an already-shared account by hand.** The migration repairs
  what it can prove; a company that needs the rest moved has no screen for it.
  The integrity check names the pair, which is the first half of that work.
- **`currentBalanceCents` stays zero on a manual account.** Nothing tells us
  what a bank holds unless an aggregator does. The feed is what says what is in
  it, and the tie-out is where that shows.
- **No opening balance when an account is created.** A real business opening an
  account mid-year has a balance on day one, and today that arrives through the
  trial-balance import or a journal. Making it part of the create form would be
  friendlier and is a decision about which of two mechanisms owns opening
  balances, not a small addition.
- **Thirty deposit accounts is a refusal.** The bands are generous for a small
  business and finite. Widening one later is a migration, because the numbers
  are already on reports people have printed.
- **Multi-currency accounts are unchanged.** An account carries a currency and
  its ledger account does not; Phase 35 handles conversion at the document. An
  account in a second currency posts to a line denominated in the first, which
  was true before this and is still true.

## Follow-up

1. **Move postings between split accounts**, so the half the migration could
   not prove has a screen rather than a SQL prompt.
2. **An opening balance on the create form**, resolved against Phase 17's
   Opening Balance Equity rather than beside it.
3. **A real `BankProvider` adapter**, which is what actually retires the
   sample feed.
4. **Tie the reconciliation start screen to the tie-out**, so "your ledger and
   your feed differ by this much before you begin" is on the screen where it
   matters.
