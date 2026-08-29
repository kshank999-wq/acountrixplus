# ADR 0061 — The statement that told the customer a made-up number

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §35. The customer statement added document amounts in
  different currencies and printed the result with the company's currency sign.
- **Builds on:**
  [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0043](0043-a-business-that-has-to-remember-to-chase-does-not-chase.md),
  [ADR 0054](0054-the-letter-that-asks-for-money-we-are-holding.md),
  [ADR 0055](0055-the-statement-you-could-not-send.md),
  [ADR 0060](0060-the-bill-in-euro-that-said-dollars.md)

## Context

ADR 0060 nominated the chase queue for this check. The chase queue was indeed
wrong, and it was not the serious one.

`openInvoices` selected `invoices.balance_cents` — the amount the customer was
invoiced in **their** currency — and `buildStatement` added those together into
one `closingBalanceCents`. Two hundred lines further down the same file:

> The company's own currency, because every figure on this statement is the
> home-currency one (Phase 35) — including the balance the sentence restates.

It was not. A customer invoiced €1,241.94 and $5,250.00 was told they owed
**$6,491.94** — a number in no currency at all, with a dollar sign on it. The
aging buckets added the same way, and Phase 54's net-position sentence restated
the same figure.

This is the worst place in the system for that to be true. It is not an internal
report: Phase 42 gives the customer a link to it, Phase 55 emails it, and Phase
57 sends it **every month with nobody looking**. It is the one document the
business puts in front of somebody else and asks them to pay against, and a
customer who can disprove it from their own purchase ledger stops believing
every figure the business sends them afterwards.

## Decision 1: a statement states a balance per currency

The same rule as Phase 60, pointed the other way: **a customer is owed a demand
in the currency they were invoiced in, and a total only means something when its
terms are in one currency.**

So the document shows one "Billed and open" row per currency. For the
overwhelming majority of customers there is exactly one and nothing changes.

Converting instead was the obvious alternative and it is wrong for a
customer-facing document. Telling a German customer they owe "$1,345.64" against
a €1,241.94 invoice gives them a figure they cannot send, at a rate they did not
agree, that will not match their own ledger.

## Decision 2: `closingBalanceCents` becomes a comparison figure, and says so

It is a sum across documents, so the company's currency is the only one it can
be in. That makes it useful for ranking one customer against another — which is
what the statements picker and the board use it for — and useless as a demand.
The type now says both, and `currencyBalances` carries what to actually pay.

For a single-currency company the two are the same number, which is why 60
phases went by without anybody noticing.

## Decision 3: held credit nets against the home-currency balance alone

Phase 54 stopped a statement asking for money the business was already holding.
`payments.unapplied_cents` is what a receipt had left over, and **nothing on the
payment records which currency that receipt was in** — a payment carries no
currency column (ADR 0058), so the only currency it can safely be read as is the
company's own.

Setting a dollar credit against a euro invoice would be this phase's own defect
committed one level up: it would tell a customer that money held in one currency
has discharged a demand in another. It has not.

So `netPosition` is given `homeCurrencyOwed` rather than the whole balance, and
a foreign balance gets its own sentence:

> €1,241.94 is outstanding separately, and payable in that currency. Any credit
> we are holding is in USD and has not been set against it.

Silence there would have been the worse failure — a customer reading "nothing is
due" over a euro invoice listed three lines above it.

## Decision 4: the frozen statement derives its currencies rather than storing them

`customerFacingStatement` computes the per-currency split from the **frozen
lines**, not from a new stored column.

A statement saved before this phase has no currency on its lines, and reading
those as the company's own is exactly what that statement claimed when it was
written — so old documents keep saying what they always said, which is the whole
point of freezing them (ADR 0055). Deriving also keeps every view of a statement
— the page, the email, the board — answering from one place, which is what that
module exists to enforce.

## Decision 5: the chase floor compares what an invoice is worth

`chaseVerdict` compared an invoice's document balance against
`minimumBalanceCents`, which is set in the company's currency — somebody typing
"don't chase under $500" means dollars. At 1.08 a €470 invoice is $507.60 and
should be chased; `47_000 < 50_000` said it should not.

Less dramatic than the statement, and the same mistake: comparing a number in
one currency against a number in another because they are both integers.

## Consequences

- The customer-facing statement is correct for a customer invoiced in more than
  one currency, and identical for everybody else.
- Aging buckets are in the company's currency, so the statement's own aging and
  the A/R aging report agree.
- The chase run spares and chases foreign invoices on what they are worth.

## What this does not do

- **Balance-forward statements are only partly addressed.** Their running
  balance comes from `customerActivity` — invoices, payments, credits and
  write-offs as *movements* — and a payment carries no currency, so that sum is
  still only correct for a single-currency customer. The per-currency balances
  and the foreign note are computed from open invoices and are right either way.
  Fixing the movement stream means giving a payment a currency, which is a
  schema change and its own phase.
- **It does not issue one statement per currency.** That is the more standard
  practice and a much larger change: the saved row, its share token, the send
  record and the monthly run would all become per-currency. Stating each balance
  on one document is honest and buildable now; splitting them is a phase.
- **No integrity check looks for this class of defect.** Three phases running
  have found the same mistake in a different module by reading code. Phase 33's
  check register is where a standing check belongs — something that reports any
  company holding documents in more than one currency, so the next place this is
  wrong is found by the system rather than by inspection.
