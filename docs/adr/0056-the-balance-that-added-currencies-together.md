# ADR 0056 — The balance that added currencies together

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §6, §13, §16. The customers and suppliers screen showed a
  Balance column that summed **face amounts across currencies** and could not
  see held credit.
- **Builds on:** [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0045](0045-the-record-you-can-never-fix.md),
  [ADR 0053](0053-the-money-you-cannot-bank.md),
  [ADR 0054](0054-the-letter-that-asks-for-money-we-are-holding.md)

## Context

Two defects on one column, both live on the demo books.

**It added currencies together.** `listCustomerSummaries` summed
`invoices.balance_cents` — the *document* amount — and the board rendered it
with `formatCents`, which defaults to USD. Bremen Hafenbau GmbH owes **€2,500**,
worth $2,708.75 on these books, and the screen said **$2,500.00**. A customer
billed in both currencies would have been shown their $1,000 and their €2,500
added to "$3,500.00", which is what Phase 35 called *"3,500 of nothing with a
dollar sign in front of it"* when it fixed this identical bug in
`customersWithBalances`. It fixed that query and left these two alone.

**It could not see held credit.** Phase 53 gave an overpayment somewhere to live
and Phase 54 netted it off the statement and the chase, on the argument that a
gross figure addressed to *one party* is not merely unhelpful but untrue. This
screen — the one somebody opens when the customer rings — still showed the
gross. Both ADR 0053 and ADR 0054 named it as the follow-up.

## Decision 1: the figure is the functional balance

`functional_balance_cents`, not `balance_cents`. The document amount is what the
customer sees on their invoice; the functional amount is what it is worth on
these books, and a column that adds several parties' documents together can only
be the second.

The face amount is not thrown away — it is on the invoice, and on the customer's
own copy. What the row gains instead is a flag: **"includes documents in another
currency"**, said out loud rather than silently converted, so nobody quotes
$2,708.75 down a phone to somebody holding a euro invoice.

The home currency comes from `functionalCurrency`, the helper Phase 35 already
wrote, rather than a third inline copy of the same query.

## Decision 2: the number is the net, with the gross beneath it

The same shape Phase 54 chose for the statement, and for the same reason:
replacing the gross would leave somebody unable to tie the row to the invoices,
and showing only the gross asks for money the business is already holding. So
the column shows what is **due**, with `$460.00 billed` under it when the two
differ.

On the supplier side the mirror is an unspent **vendor credit** (Phase 12). It
reduces what the next pay run will send, so a gross figure there overstates what
is about to leave the bank — the same untruth pointing the other way.

## Decision 3: the band follows the net, not the age of the debt

A customer with a $900 invoice two hundred days old and $900 of *their own money*
sitting in `2520` is not somebody to chase. They are somebody whose credit needs
applying, and painting that row red sends a person to have the wrong
conversation. So `settled` wins over `long_overdue`, however old the debt is.

This is the same judgement Phase 54 made when it refused to chase a customer
whose money the business holds, applied to a colour instead of an email.

## Decision 4: it composes `netPosition` rather than answering again

"What does this party owe on net" already has an answer, decided in Phase 54 and
living in `receivables/net-position.ts`. A second implementation in
`parties/standing.ts` would be two answers to one question — the exact defect
Phase 51 refused to create for corrections and Phase 53 refused for refunds. So
this module adds only what is new: **how late it is, and how to say so.**

## Decision 5: `asOf` comes from the server

The board is a client component, so a `new Date()` inside it is the *reader's*
clock. Two people looking at the same account would see different ages, and one
of them would be wrong across a timezone boundary. The page passes today down as
a prop, which also keeps `partyStanding` a function of its arguments.

## What the browser found

Nothing broken. The defect was found by reading the query, and confirmed against
the books before any code changed: `select currency, balance_cents,
functional_balance_cents from invoices` showed Bremen at `EUR / 250000 / 270875`
while the screen said $2,500.00.

After the change the same row reads **$2,708.75** with *"includes documents in
another currency"* beside it; City Works Authority reads *"They owe $9,400.00,
oldest 106 days overdue"*; and Harborview — who owes $460 and whose $460
overpayment the business is holding — reads **nothing due**, with `$460.00
billed` underneath and *"Nothing due — the $460.00 held covers it."*

## Consequences

- `PartySummary` gains `heldCreditCents`, `oldestDueDate` and
  `hasForeignDocuments`; `balanceCents` changes meaning from face to functional.
- The board gains a **Standing** column, and `asOf` and `homeCurrency` props.
- `listVendorSummaries` gets the same treatment, against vendor credits.

## What this does not do

It does not net held credit into the **aging report**. Phase 54 drew that line
and it still holds: aging is a portfolio question — how collectable is the book,
by age — and held credit is a liability on the other side of the balance sheet.
Netting it there would hide it. A row addressed to *one party* is a different
question, and that is the one this screen asks.

It does not let somebody **apply or refund** the credit from this screen. That
lives on **Money in and out** (Phase 53), and a second place to do it would be a
second answer to where the credit went.
