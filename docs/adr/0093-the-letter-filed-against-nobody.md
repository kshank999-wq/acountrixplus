# 0093 — The letter filed against nobody

**Status:** accepted
**Date:** Phase 93
**Amends:** ADR 0022 (the communications log), ADR 0092 (reading the letter the timeline points at).

## The defect

`recordOutboundMail` files a sent letter on a timeline by looking its address up
in **`contacts`**. That was right for Phase 22, whose letters were invitations
and password resets — mail to people somebody in the CRM had already met.

It is wrong for the letters this application mostly sends. An invoice goes to
whatever address is on the `customers` row, and a business that bills people it
never courted has no CRM contact for any of them. Measured on this repository's
own seed data:

```
customers with email                 5
customer emails matching a contact   0
```

So every invoice, every statement and every reminder was recorded in
`transactional_messages` and appeared on **nobody's timeline at all**. Phase 91
kept the words and Phase 92 taught the timeline to read them; neither helps a
letter that never gets an entry.

## Decision 1: an address is not an identity

One inbox can be three parties at once. `accounts@harborview.test` is plausibly
a contact somebody met at a trade show, a customer who owes money, *and* a
supplier who invoices for plant hire — a firm that both buys from you and sells
to you, with one shared address for all of it.

Resolving an address therefore yields a set of candidates rather than an answer,
and the queries deliberately carry **no `limit(1)`**: the core has to *see* a
duplicate in order to refuse it, and a query returning the first of two would
file on a coin flip instead.

## Decision 2: what the letter is says which party it is about

Picking by a fixed precedence would file a **remittance advice on a customer's
record** — evidence about a payables relationship stored against a receivables
one, where the next person to open that customer reads it as something we sent
them about their own debt.

`KIND_CONCERNS` writes the mapping down exhaustively over `TransactionalKind`,
so the next kind added has to choose rather than inherit somebody else's answer.
Money owed to us goes to the customer; money we paid goes to the supplier;
letters about a person go to the person.

## Decision 3: the fallback never crosses the divide

When the party a letter concerns is not among the matches it falls back to a
**contact**, and to nothing else. A contact is a person rather than a side of the
books, so filing there cannot put a payables letter on a receivables record.
Falling back from vendor to customer would do exactly the harm this module exists
to prevent, and is refused.

Filing nothing loses a timeline entry. That is the lesser harm, because it is not
*wrong* — and the same reasoning settles the ambiguous case: when two customers
share an address, `filingFor` returns nothing. An entry on the wrong customer is
evidence about the wrong party, and a timeline that is quietly wrong is worse
than one that is quietly short. The duplicate is a data problem to fix, not a tie
to break here.

## Decision 4: the database holds the shape too

`communications` gains `customer_id` and `vendor_id`, both `ON DELETE SET NULL`
like `contact_id` — deleting a customer must not delete the record of what we
sent them.

Two constraints came with them:

- **`communications_has_party` was widened, not dropped.** Phase 22's reasoning
  is untouched — *"a row naming no party at all belongs to no timeline and would
  be visible on no screen"* — there are simply two more ways to name one. A
  customer with no CRM organization, which is the ordinary case for somebody you
  bill but never courted, could not satisfy the old check at all; widening it is
  what makes this phase possible rather than a loosening.
- **`communications_one_trading_party`** refuses a row that is somehow both a
  customer's and a supplier's. `filingFor` decides which; this is the database
  refusing to hold the shape that decision exists to prevent.

## Decision 5: what we sent is not what changed

The customers and suppliers screen already had a **History** panel — Phase 71's
audit story, answering *what changed about this record*. The post gets its own
**Post** panel rather than more rows in that one, on exactly the distinction
Phase 22 drew when it refused to merge the audit log with the communications log:
merging them means the three sentences that matter scroll out of sight behind
forty automatic entries.

Both load when opened, for the reason `RecordHistory` gives: a history nobody
asks for is a query nobody needed, and every row on a busy screen would run one.

## What this did not do

**No backfill.** Letters sent before this phase have no communications row and
do not get one — the send is in `transactional_messages`, but which party it was
about was never decided and inventing it now would be a guess dressed as a
record.

**Marketing is still deliberately absent.** ADR 0022's reason stands:
`campaign_recipients` already records every marketing send per contact, and
mirroring those here would bury the hand-written entries under the newsletter.

**A customer with a duplicate address still gets nothing.** By design, and
visible: the letter is in `transactional_messages` and the timeline is short
rather than wrong.

## What the next phase might take

Nothing tells anybody that a letter went unfiled. `recordOutboundMail` returns
null for a stranger, for a duplicate address and for a letter with no honest
party, and all three look identical from outside — a quiet `return null`. The
duplicate case in particular is a data-quality problem this application can now
*detect* and does not report: Phase 33's integrity checks exist precisely to
surface "the books disagree with themselves", and two customers sharing an
address is exactly that shape.
