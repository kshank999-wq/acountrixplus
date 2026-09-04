# 0124 — The currency that stopped at the boundary

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 124

---

## How this was found

ADR 0123 nominated this and said plainly why it could not reach it:

> It does not reach a client component. `board.tsx` sums receipts in the browser
> and the scanner cannot see it, because a client component receives a plain
> type rather than reading a drizzle table. The repair there was made by hand,
> having been found by looking at the screen.

Looking at the screen is not a strategy. Measured instead: **92 client
components, 94 prop types carrying money, 17 carrying a currency beside it and
77 not.**

That raw count is not the finding, for the same reason Phase 123's 145 reduces
were not. Most of that money is the company's own — a trial balance, a budget, a
drawer count — and a currency prop on those would be noise.

## The rule that makes it decidable

Checked against the schema rather than assumed. Of every table these screens
read, **only five carry a `currency` column**: `invoices`, `bills`,
`credit_notes`, `payments`, `retainers`. Billing schedules, proposals, deposits,
contributions, purchase orders, time entries, assets and statement runs carry
none.

> **A currency travels with a document, and only a document has one.**

Money off one of the five is a document's: two rows of a list can differ, and it
must wear its own currency. Everything else is the company's, and
`formatCents(cents, currency = 'USD')` is right about it.

That default is where the damage happens. It is correct for the books and wrong
for a document, and the two are indistinguishable at the call site — which is
how the deposits list came to render a €4,000 SEPA transfer as "$4,000.00"
(Phase 123, found by looking, fixed by hand).

## Following the prop

The scan reads the **pair**: a client component and the server file that renders
it. A page never queries drizzle itself — `src/app` has held no business logic
since Phase 1 — so "does this screen serve document money" is a question about
the modules the page imports, and answering it takes one hop. Scanning the page
alone found four carriers and **none of the known defects**, which is how the
missing hop was noticed.

Two repairs, both traced to their query rather than assumed:

- **`invoices/board.tsx` — suspected duplicate bills.** Phase 123 gave
  `DuplicatePair` a `currency` and never passed it onward. The board already
  receives `homeCurrency`, so a €4,000 pair from a German supplier was rendered
  with the company's symbol beside a dollar pair — on the screen whose only job
  is telling somebody which two documents to compare.
- **`payables/board.tsx` — open vendor credit notes.** `credit_notes.currency`
  is a face column. Phase 122 made `vendorCreditBalances` group by it after a
  euro credit and a dollar credit were added into a number that came off a
  payment; the list those credits are *chosen from* still showed bare
  remainders.

Browser-verified by putting a €600 credit from a German supplier on Ridgeline's
books: the payables screen now shows **€600.00** on the credit row and
**$660.00** where the books' figure is wanted. Before, it read "$600.00" — the
number right, the currency invented, and $60 adrift from what it is worth.

## The one that looks like the defect and is not

`settings/chasing/board.tsx` has a `DueRow` carrying a currency.
`settings/statements/board.tsx` has a `DueRow` that does not. Same name,
adjacent screens, and it reads like one was forgotten.

They are different rows. Chasing lists individual overdue **invoices** —
documents. Statements lists a **customer**, and `statement-run.ts` builds that
balance by summing `invoices.functional_balance_cents` (Phase 56, refined in
Phase 65). It arrives already converted, so the company's symbol is the right
one and a currency prop would be a second answer to a settled question.

Recording *why* a suspicious asymmetry is correct is the point of the registry.
The next person to notice it will find the answer rather than repeating the
investigation — or, worse, "fixing" it.

## What this does not do

**It does not classify all the carriers.** `UNCLASSIFIED_CARRIERS` records
**19** that the scan cannot rule out and this phase did not trace to their
query. Every one was looked at and none lists a foreign document beside a
domestic one — they are roll-ups, job budgets, till counts and import plans
reached through a shared module. But *looked at* is not *traced*, which is what
the classified entries got, and the number is a tripwire that may shrink and must
not quietly grow. Phase 121's device, for the same reason: a list with reasons
beats a silence.

**It matches by property name, so two things in one file can collide.**
`plan.remainingCents` on the payables board is what would be left in the **bank
account** after a pay run — a ledger balance — and shares a name with the credit
notes three hundred lines away. `NAME_COLLISIONS` carries it with an argument.
This is the same limitation ADR 0123 confessed for the reduce scan, and it is
not fixed here; it is declared.

**It reads multi-line prop types only.** A single-line `type X = { ... }` makes
the non-greedy body run into the next declaration and file one type's fields
under another — which the first run did, attributing the duplicate-bill pair to
its one-line neighbour. Skipping them is honest; catching them would need a
parser rather than a regex.

**It does not touch the ninety-four.** The narrowing to face-named money on
document-serving screens is what turns a wall of make-work into a list somebody
can act on. Money on a screen that carries no face-column name — `earnedCents`,
`overShortCents`, `netDueCents` — is outside the rule, and if one of those ever
comes off a document, nothing here will say so.
