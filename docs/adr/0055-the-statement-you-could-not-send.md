# ADR 0055 — The statement you could not send

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §19. `customer_statements.sent_at` had existed since
  Phase 11 with nothing writing to it, while `sent_to` was filled in at *save*
  time — so the screen showed a statement, a date, and an email address the
  document had never been sent to.
- **Builds on:** [ADR 0042](0042-what-the-customer-opens-is-the-ledger.md),
  [ADR 0053](0053-the-money-you-cannot-bank.md),
  [ADR 0054](0054-the-letter-that-asks-for-money-we-are-holding.md)

## Context

The module header on `statements.ts` has said since Phase 11:

> *"What did we send them, and when" is the first question in any collections
> conversation.*

It was the one question the data could not answer. `sent_at` was written by
nothing, anywhere, in fifty-four phases.

`sent_to` was worse than a null column. `saveStatement` filled it in from the
customer's record when the statement was **saved**, and the receivables board
rendered it under a heading reading "To". On the demo books that produced five
saved statements, four showing an email address, and **zero sends**. A business
reading that column would conclude the customer had been told.

That is the same class of defect as Phase 46's stranded payments and Phase 48's
clearing account that nothing could clear: not a missing feature, but a screen
asserting something untrue about money.

Phase 54 made it sharper. It computed the netted position, wrote a sentence for
the customer — *"$1,540.00 is due, after the $460.00 we are holding for you"* —
and froze it onto a document no customer could ever receive.

## Decision 1: the page is frozen, and the invoice page is not

This is the phase's one real design decision, and copying Phase 42 would have
quietly destroyed the document.

`/i/[token]` renders the **live** invoice. `sharing.ts` argues that well: a
customer chasing their own payables wants to know what is outstanding *now*, so
a part payment does not force a reissue, and there is one ledger rather than a
stored second answer.

A statement is the opposite kind of document. It is a claim about a **moment** —
"this is where we stood at 30 June" — and it exists so that two parties can
reconcile against a fixed thing. A page that silently restated itself every time
it was opened would mean the customer and the business could never be looking at
the same document, which is the only job a statement has.

So `/s/[token]` renders the figures frozen at save time and says so twice: in the
header, and in the footnote. The live view already exists for anybody who wants
it — it is the invoice link.

The email's footnote is inverted for the same reason. The invoice one promises
the figure keeps up with payments; this one promises it does not. Getting those
two sentences the same way round would make one of the pages a liar.

## Decision 2: the token is per statement

Not per customer. A link that opened "this customer's statements" would let
whoever holds June's letter read December's — a different document about a
different moment, and not the one they were given.

Minted on the first send or the first "Get link", never at creation and never
rotated: a live door onto a document nobody asked to share is a door open for no
reason, and a link filed in an inbox two years ago should still open.

## Decision 3: a link is not a letter

"Get link" mints the token and returns the URL, and deliberately does **not**
touch `sent_at` or `send_count`. Handing somebody a URL to paste into their own
email is not the same event as the system posting the letter, and recording it as
one would put back precisely the claim this phase removed.

It also has a job: it is what the refusal tells you to do when the customer has
no address on file.

## Decision 4: sending is gated on `accounting:view`

Lower than `sendInvoice`, which requires `accounting:journal`. Sending an invoice
asks somebody for money and can only follow raising one. A statement asserts
nothing new — every figure on it was frozen when it was saved, and saving already
required `accounting:view`. Requiring more to post the letter than to compose it
would put the gate in the wrong place.

## Decision 5: `sent_to` now belongs to the send

`saveStatement` no longer writes it, and the migration clears every address it
already wrote against an unsent row. That is not losing data: the customer it
would have gone to is still on the customer record, which is where
`saveStatement` read it from in the first place.

The board's column is renamed from "To" to "Sent", and reads **"Not sent"** until
it goes.

## What the browser found

Nothing broken — and unlike Phase 53, the defect here was not found in the
browser but by asking the database a question the screen could not: `select
count(*), count(sent_at), count(sent_to) from customer_statements` returned
`5, 0, 4`.

The walk-through afterwards: the Harborview statement went to
`ap@harborview.test`, the row changed from "Not sent" to the date and address,
the button became "Send again", and the customer's page rendered Billed
$2,000.00 / Held for you −$460.00 / Amount due $1,540.00 with Phase 54's
sentence above it.

Then the freeze was tested the only way that means anything: $1,540 was paid
against the invoice the statement lists, and the customer's page still read
**due $1,540.00, billed $2,000.00** — exactly what it said when it went. A wrong
token 404s rather than distinguishing "no such statement" from "wrong token",
which would tell somebody probing which statements exist.

## Consequences

- `customer_statements` gains `share_token` (uniquely indexed) and `send_count`.
- `statement` joins `TransactionalKind`, rate limited at 4 per address per hour
  against an invoice's 12 — a business sends thirty invoices in a minute to
  thirty addresses, but one customer gets one statement a month, so four an hour
  to the same address is already somebody clicking Send repeatedly.
- `statement.send` joins the audit actions, and the send is filed on the
  customer's CRM timeline when they have one.
- `saveStatement` no longer accepts a `sentTo` argument.

## What this does not do

It does not attach a **PDF**. The link renders a page that prints, which is what
Phase 42 concluded for invoices, and a stored PDF would be a second copy of
figures that are already frozen — two artefacts to keep in step for no gain.

It does not send statements **on a schedule**, the way Phase 43 chases invoices.
Month-end statement runs are a real thing a business wants, and the machinery is
now all here — but a scheduler that emails every customer without anybody
deciding again is the feature that most deserves its own phase, with its own
preview screen, rather than being tacked onto this one.
