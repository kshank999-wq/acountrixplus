# ADR 0063 — The euro invoice you could not credit

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §35. A credit note carried no currency, so `refuseForeign`
  stopped every credit against a foreign document dead.
- **Builds on:**
  [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0053](0053-the-money-you-cannot-bank.md),
  [ADR 0060](0060-the-bill-in-euro-that-said-dollars.md),
  [ADR 0061](0061-the-statement-that-told-the-customer-a-made-up-number.md),
  [ADR 0062](0062-the-money-that-did-not-know-its-own-currency.md)

## Context

ADR 0062 named this as the next thing to fix, in its own words:

> **Credit notes still carry no currency.** `credit_notes.total_cents` and
> `remaining_cents` are bare numbers, so a vendor credit raised against a euro
> bill is spendable against a dollar one. It is the identical defect one table
> over and it deserves the same treatment.

The consequence was worse than a mislabelled figure. Since Phase 35,
`refuseForeign` has stopped four operations outright: crediting an invoice,
crediting a bill, applying a credit, and drawing a retainer. A business
invoicing in euro could not issue a credit note to a euro customer **at all** —
not wrongly, not approximately. The button raised an error.

The refusal was honest about why:

> for a multi-line document — a credit note, a vendor credit — that amount is the
> *sum of the converted lines*, not the conversion of the sum. The two differ by
> a cent often enough to matter, and picking either without deciding which is
> right is how a set of books acquires a drift nobody can explain.

## Decision 1: nobody had to decide — the document engine already had

`createInvoice` and `createBill` have converted documents the same way since
Phase 35: each line on its own, the total their sum, so the journal entry
balances by construction.

A credit note **reverses a document**. Reversing it by different arithmetic than
raised it *is* the drift the refusal was guarding against, so following the same
rule is not a choice between two answers — it is the only one that keeps the
reversal and the original agreeing.

Which means having one of the rule rather than a third copy of it.
`functionalAmounts` in `src/modules/fx/denomination.ts` is that rule, pure, with
a test that proves sum-of-converted and conversion-of-sum really do differ at a
four-decimal rate — the fact that made the question worth asking.

## Decision 2: a credit note is a document like any other

`credit_notes` gains `currency`, `exchange_rate_millionths`,
`functional_total_cents` and `functional_remaining_cents` — the shape Phase 35
gave invoices and bills.

The currency is **inherited, never chosen**: from the document being credited, or
the company's own for a standalone goodwill note. A €4,000 invoice is reduced by
€500, not by "$540 worth of euro"; the customer's ledger will show €500 against
that invoice and anything else is a query they raise.

The rate is fixed at issue and never recomputed, for the reason a document's rate
is: restating it from a later rate silently rewrites the revenue this credit
reversed, every time a currency moves.

The backfill is trivially correct for an unusual reason — **the refusal this
phase lifts guaranteed there was nothing to get wrong.** Every credit note that
exists was raised domestically. It still reads the currency from the company
rather than defaulting to USD, because a company whose own currency is not USD
had credit notes in *its* currency and the column default would have mislabelled
every one.

## Decision 3: applying a credit across currencies is still refused

`creditableAgainst` replaces `refuseForeign` at the application sites. This is
Phase 62's rule one document over: money held in one currency has not discharged
a demand in another, so a €500 credit does not reduce a $500 invoice.

The refusal names both currencies and both documents, because the fix is to raise
the credit against the right document and somebody has to know which — Phase 47's
rule that a refusal must say what is wrong with *this* row.

## Decision 4: the refusal that is still a real question keeps its caller

`refuseForeign` is not deleted. One caller remains — drawing down a retainer in
`timebilling/billing.ts` — and it is the one that was always different. Applying
a retainer is a **settlement**, not a reversal: it decides at what rate money
already held discharges a new demand, which has a profit-and-loss effect and is
an accounting decision, not arithmetic the document engine already made. Three
of the four refusals were held up by a question that was already answered. This
one is not, and lifting it by analogy would have been guessing.

## Decision 5: both halves of what is left move together

Found in the browser, not in a test: applying a credit took `remaining_cents` to
zero and left `functional_remaining_cents` untouched, so the receivables screen
offered **$4,334.00** of credit that had already been spent.

Both columns now move on every application, through `relieveFunctional` —
the invoice's rule, borrowed rather than rewritten, so the last application takes
whatever functional remainder is left and neither column can strand a cent while
the other reaches zero.

## Consequences

- A euro invoice can be credited. The credit note carries EUR, its ledger entry
  posts in the company's currency line by line, and it balances against the
  stored functional total exactly rather than to within a cent.
- The receivables screen shows each note in its own currency, and its
  "Credit available" total sums the functional amounts — a €500 note and a $500
  note are not $1,000 of anything.
- `listInvoices` and `listBills` carry `currency`, so the picker somebody chooses
  a document from no longer labels a euro invoice in dollars. This closes the
  first of the two wrong-symbol screens ADR 0062 recorded.

## What this does not do

- **A foreign invoice still cannot be raised from the UI.** The invoice composer
  has no currency field, so euro documents arrive only through seeding or the
  API. Every screen downstream now handles them correctly, which makes this the
  next visible gap rather than a hidden one.
- **The retainer draw is still refused in a foreign currency**, deliberately, per
  Decision 4. It needs a decision about which rate settles the draw and where the
  difference posts — a phase of its own, not a line in this one.
- **Three of the five held-credit sums still add currencies.** ADR 0062 named
  them: the customers screen, the statement run's minimum-balance floor and the
  statements picker. A credit note now has a rate, and a payment has a currency
  but no rate — so the missing piece is `payments.exchange_rate_millionths`, and
  half-doing it would put a converted number beside an unconverted one.
- **The payment composer's overpayment notice still prints the wrong symbol** for
  a euro receipt. The second of ADR 0062's pair; the first is closed above.
