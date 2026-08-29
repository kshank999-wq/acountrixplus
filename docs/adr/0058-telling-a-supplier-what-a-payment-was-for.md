# ADR 0058 — Telling a supplier what a payment was for

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §19. Phase 49 pays a batch of bills with one payment.
  Nothing told the supplier which of their invoices it covered.
- **Builds on:**
  [ADR 0042](0042-what-the-customer-opens-is-the-ledger.md),
  [ADR 0049](0049-what-you-owe-and-choosing-what-to-pay.md),
  [ADR 0052](0052-the-payment-you-cannot-take-back.md),
  [ADR 0055](0055-the-statement-you-could-not-send.md)

## Context

Phase 57's ADR nominated this phase, in these words:

> The useful version is a **remittance advice** — what a pay run just paid and
> against which bills — which belongs with Phase 49's pay runs.

The gap is on the supplier's side of a transfer, and it is the ordinary cause of
a phone call. Phase 49 made one payment settle four bills. What arrives at the
supplier's bank is a single line — `BACS 88213`, $12,054.00 — against a ledger
carrying nine open invoices. They have to guess. Guessing wrong leaves invoices
showing as unpaid, which produces a statement chasing money already sent, which
produces the call.

Every figure needed to prevent that was already in `payment_applications`. It
had simply never been pointed at the person who needed it.

## Decision 1: the advice is not frozen, and that is the whole design

Phase 55 froze a statement's figures at save time, and ADR 0055 argued the case
at length: a statement is a claim about a **moment**, the books move underneath
it, and a customer holding a link must not watch the document rewrite itself.

A remittance is a claim about a **payment**, and a posted payment does not
change. Its applications are written once, and the amount is what left the bank.
Freezing it would add a snapshot table, a save step and a second copy of figures
that cannot drift — the second answer this project keeps refusing to create.
`/r/[token]` reads live, and is stable because the underlying fact is.

**With one exception, and it is the exception that decided the design.** Phase
52 made a payment voidable. A supplier holding an advice for a payment later
voided is holding a document about money they do not have, and their ledger will
be wrong in the direction that matters. Reading live is exactly what lets the
page say so:

> **This payment was reversed.** The money described below came back, so the
> invoices it covered are outstanding again.

A snapshot would have gone on describing a payment that had been unwound. The
argument for freezing a statement and the argument against freezing a remittance
are the same argument — *tell the reader what is true* — applied to two
documents with different relationships to time.

## Decision 2: sending is gated on `accounting:view`, not on paying

Sending an advice requires the permission to *see* the books, not the one that
moves money. This looks lax for a page about money leaving a bank account, so
the reasoning is worth recording.

Telling somebody what they were already paid **asserts nothing new**. The money
has gone; every figure on the advice is a fact already written. Requiring
`accounting:journal` — the permission that pays a supplier — in order to describe
a payment that already happened would put the gate in the wrong place, and the
practical effect would be that the person who does the chasing cannot answer
"which invoices was that?" without the person who signs the payments. That is
the same reasoning Phase 55 applied to statements.

## Decision 3: a link is not an advice

`remittanceLinkFor` mints the token and writes nothing else. `sendRemittance`
also stamps `remittance_sent_at`, `remittance_sent_to` and increments
`remittance_send_count`.

The two are deliberately different events. Handing somebody a URL to paste into
their own email is not the business asserting it sent the advice, and recording
it as one would put a date in a column that means "we told them" when nobody
was told. Phase 55 drew the same line, and Phase 55 exists because the previous
54 phases had `sent_at` written by nothing at all.

The token itself follows Phase 42: 32 bytes, minted once, never rotated. It is
the only thing protecting the page, and a token somebody could walk would be a
list of who a business pays and how much.

## Decision 4: the supplier's own reference goes first

The table leads with `vendor_reference` — Phase 47's separation of *their*
invoice number from *our* bill number — because that is the string the supplier
will search their own system for. `BILL-1005` means nothing on their side of the
transaction. Putting our number first would produce a document that is correct
and useless.

## Decision 5: the currency comes from the bills, not the payment

A payment carries no currency column, because the amount is in the currency of
the documents it settles (Phase 35, Phase 41 — allocation works in document
amounts, so one payment settles bills of one currency). The advice therefore
reads its currency off the first settled bill, which is also the currency the
supplier invoiced in and the one they need to see.

A payment on account settles nothing, so there is no bill to read: the fallback
is the company's own currency, which is the only answer available and the right
one for a business paying a domestic supplier in advance.

## Consequences

- A supplier can be told what a payment covered, from the payments board, in one
  click, and the send is recorded where Phase 24 already looks for failures.
- A voided payment tells its own supplier. This is the first public page in the
  system that **changes what it says** after the fact, and it does so because the
  underlying fact changed.
- Refusals name the fix rather than the rule: a supplier with no address on file
  is told to add one or use **Get link**, in Phase 47's style.

## What this does not do

- **It does not send an advice automatically when a pay run completes.** Phase
  49 pays a batch; nothing yet loops that batch through `sendRemittance`. That is
  the natural next phase and belongs with a preview screen of its own, for the
  reason ADR 0055 gave about statement runs: a scheduler that emails every
  supplier without anybody deciding again deserves more care than a tacked-on
  call.
- **It attaches no PDF.** The page prints, which is what Phase 21 established as
  sufficient for a document whose figures do not need signing.
- **It does not tell the supplier what is still outstanding.** That is a supplier
  statement — the mirror of Phase 55 — and it is a different document with a
  different claim.
