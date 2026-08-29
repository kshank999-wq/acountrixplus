# ADR 0064 — The euro invoice you could not raise

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §3, §13, §35. Five phases of foreign-currency work were
  reachable only by seeding, because the composer had no currency field.
- **Builds on:**
  [ADR 0035](0035-a-document-is-owed-in-its-own-currency.md),
  [ADR 0041](0041-the-document-you-raise-yourself.md),
  [ADR 0047](0047-the-supplier-reference-is-not-our-number.md),
  [ADR 0060](0060-the-bill-in-euro-that-said-dollars.md),
  [ADR 0063](0063-the-euro-invoice-you-could-not-credit.md)

## Context

ADR 0063 named this itself, at the top of what it did not do:

> **A foreign invoice still cannot be raised from the UI.** The invoice composer
> has no currency field, so euro documents arrive only through seeding or the
> API. Every screen downstream now handles them correctly, which makes this the
> next visible gap rather than a hidden one.

Phases 60 through 63 taught the payables queue, the statement, the chase
decision and the credit note to handle a foreign document properly. A business
that invoices in euro could not create one. That is the same shape as Phase 41,
which found `createInvoice` written, posted and tested since Phase 2 and
reachable from no screen at all — four phases of correct behaviour behind a door
nobody had cut.

## Decision 1: offer only what can actually be posted

`offerableCurrencies` returns the company's own currency always — a domestic
document is not a conversion and needs no rate — and a foreign one only where a
rate has been recorded at some point.

Offering EUR to a company that has never recorded a EUR rate would put a choice
in front of somebody that `rateFor` will refuse the moment they take it. That is
Phase 47's defect exactly: a refusal behind a button rather than on the row.

Home first, because it is what all but a handful of documents will be. The
selector is not rendered at all when there is only one currency to choose: a
select with a single option is a question with no answer.

## Decision 2: say what it books at, before the button

A document's rate is **fixed at issue and never recomputed** — Phase 35's rule,
restated by Phase 63 for credit notes. The consequence nobody had drawn: the
composer is the *last* moment the number can be questioned. After that, the only
place a wrong rate surfaces is a profit and loss a month later.

So the composer shows, live:

> €4,000.00 books as $4,334.00 at 1.083500, the rate of 2026-08-01. Fixed now
> and never recomputed, so the books keep saying what this was worth on the day.

It names the rate's **own date** because `rateFor` walks backwards to the most
recent rate on or before the issue date — so an invoice dated the 15th is
routinely raised at the 1st's rate, and this is the only place anybody is told
which rate it actually was.

Nothing is shown for a domestic document. A line reading "$4,000.00 books as
$4,000.00 at 1.000000" is noise that teaches people to stop reading the line
that matters.

## Decision 3: the preview is the posting's own arithmetic

`documentQuote` composes Phase 63's `functionalAmounts` rather than converting
the total. If the preview and the posting used different arithmetic they would
agree by luck and differ by a cent — and the whole point of the preview is to be
the number that lands.

A test pins this directly: it quotes a three-line euro document, then raises it,
and asserts the quoted functional total equals the invoice's stored one.

## Decision 4: a missing rate is an answer, not an exception

`rateFor` throws, and should — a posting that cannot honestly convert must stop.
But the composer is asking a *question* before anybody has committed, and "there
is no rate" is the answer to it.

So `quoteDocument` catches `RateError` and reports it, and the composer puts the
sentence on the row with a link to the rates screen and disables the button.

**The message is `rateFor`'s own, passed along.** Writing a second sentence about
a missing rate would give one question two answers that agree today and drift the
first time either is edited — and the refusal somebody sees when a posting fails
would stop matching the warning they saw when the composer told them it would.

`quoteDocumentAction` also deliberately does not go through `run`: that helper
revalidates every page path, and this is a read that fires while somebody types.

## Consequences

- A euro invoice and a euro bill can be raised from the screen, in the currency
  the customer is billed in, with the conversion visible before committing.
- The composer's running total, the success message and the document list all
  read in the document's own currency.
- The `currency` field on `documentSchema` is optional and blank means home, so
  every caller written before this phase keeps raising domestic documents
  unchanged rather than learning a field to say "as before".

## What this does not do

- **A rate must exist before the first foreign document.** By design — the
  alternative is asking somebody to type a rate into an invoice form, which is
  how a rate nobody checked ends up fixed onto a document forever. The refusal
  links to the rates screen instead.
- **The payment composer still has no currency of its own.** It infers one from
  the documents being settled (Phase 62's `settlementCurrency`), which is right
  for a receipt against invoices and has nothing to say for a payment on account.
  Its overpayment notice still prints the wrong symbol for a euro receipt — ADR
  0062 named it, ADR 0063 left it, and it is still open.
- **Three held-credit sums still add currencies.** Unchanged from ADR 0063: the
  customers screen, the statement run's floor and the statements picker need
  `payments.exchange_rate_millionths` before they can compare across currencies.
- **The retainer draw is still refused in a foreign currency**, per ADR 0063's
  Decision 4. It is a settlement decision, not arithmetic, and still needs one.
