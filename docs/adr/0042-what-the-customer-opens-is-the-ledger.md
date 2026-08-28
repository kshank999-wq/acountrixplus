# ADR 0042 — What the customer opens is the ledger, not a copy of it

- **Status:** Accepted
- **Date:** 2026-08-27
- **Context:** Spec §13, §19. Phase 41 made a business able to raise an
  invoice. Nobody pays one they never received.
- **Builds on:** [ADR 0041](0041-the-document-you-raise-yourself.md),
  [ADR 0038](0038-two-adapters-or-it-is-a-guess.md),
  [ADR 0002](0002-double-entry-ledger.md)

## Context

Every piece existed and none were joined. Phase 21 renders an invoice as a
PDF — behind `requireActor()`, so only somebody signed in to the company can
fetch it. Phase 38 can put a letter on the internet. Phase 22 logs
communications on a customer's timeline. `TransactionalKind` had four values
and none of them was an invoice.

So the only way to get an invoice to the person who owed it was to sign in,
download the PDF, open your own email client and attach it.

## Decision 1: a link to the live record, not a copy

The obvious build is to snapshot the PDF at send time — it is what Phase 21
does for proposals, and the machinery is right there.

**An earlier phase argued against it, deliberately**, at the top of
`modules/pdf/invoice.ts`:

> *Unlike a proposal, an invoice is not snapshotted... Snapshotting one would
> create a second answer to "how much does this customer owe", which ADR 0002
> spent a whole phase refusing.*

That argument holds, and Phase 41 strengthened it: an invoice cannot be
edited, only voided and reissued, so a snapshot would differ from the record in
only one way — it would keep showing the original amount after a payment.

Which is the wrong behaviour. A customer part-pays in April and opens the link
in October; what they need is *what is still outstanding*, not what it was in
March. So the page renders the live record, the balance moves as they pay, and
a part payment needs no reissue. The header says so out loud.

What gets stored is the **communication**: who it went to, when, how many
times, whether they opened it. That is evidence of *asking*, which is a
different claim from evidence of *the amount* — and only the first one needed
storing, because the ledger is already the second.

## Decision 2: the projection is an allowlist

`/i/[token]` is unauthenticated. Whoever holds the link is looking at it, and
links travel by email, get forwarded, and sit in inboxes for years. So the
question is not *how do we display an invoice* but *which fields may leave the
building*, and those produce different code.

`customerFacingInvoice` is built field by field from named inputs rather than
by spreading a row and deleting the awkward parts. A subtraction leaks by
default: the next phase adds `internalNotes` or `marginBp` or a cost code, and
it appears on a stranger's screen because nobody remembered to remove it. An
allowlist stays silent, which is the failure that costs nothing. A test hands
it a row stuffed with exactly those fields and asserts none of them come out.

The customer's own email address is deliberately not reprinted either. The page
is reached by a link anybody may forward; putting the address back on it hands
one more thing to whoever has it.

## Decision 3: the token is the whole of the security

32 bytes, random per invoice, unique across every company — a collision would
show one company's invoice to another's customer. It is minted on the **first
send**, not at creation: a live door onto an invoice nobody asked to share is a
door open for no reason.

Never rotated afterwards, so a link filed in an inbox two years ago still
opens. Revoking is a separate act, and it kills the door without touching the
debt: the invoice is unchanged and sending it again mints a new one.

A wrong token, a revoked token and a voided invoice are all the same 404.
Distinguishing them tells somebody probing which invoices exist.

## Decision 4: the record moves before the send

`sendInvoice` writes the token, the address and the count, and *then* asks the
provider to deliver. The other order is worse: a message that leaves without
being recorded means a customer holds an invoice the business does not know it
sent. Recorded-but-not-sent shows up in the delivery log as a failure somebody
can act on, and the action says so rather than reporting success.

## Decision 5: rate limited, but not like a password reset

The limit is per address per hour. A password reset gets five because it is a
credential being handled; an invoice gets twelve, because a builder sending out
Friday's invoices legitimately sends thirty in a minute — all to *different*
addresses, which the per-address limit does not touch. What it stops is the
same customer being mailed the same invoice over and over.

## The two bugs browser verification caught

**The view counter never worked, and said nothing about it.** Written as

```ts
.set({ firstViewedAt: sql`coalesce(${invoices.firstViewedAt}, ${now})`, … })
.catch(() => {})
```

a raw `Date` inside a `sql` template loses its type and the driver refuses the
whole statement — and the bare catch swallowed it. The counter was collected
and discarded on every view. Best-effort was the right call for a page render;
*silent* was not. It logs now, and uses the database's own `now()`.

**A shared invoice read as "not sent", and hid the view count with it.** The
column had two states and there are three: emailed, link shared, neither. So a
business could share a link, watch the customer open it twice, and see a row
saying nobody had been sent anything — the one signal that matters, collected
and thrown away at the last step.

**And a third the browser found by refusing to cooperate:** the failure message
said *"Add one, or type one below"* and there was no "below" — the composer's
add-customer form never asked for an email, so a customer created there could
never be sent an invoice. The form asks now, and the message points somewhere
that exists.

## Consequences

- **No PDF for the customer.** They get a page with a print stylesheet and
  their browser's Save as PDF, which is what the public proposal page does.
  A real attachment needs the provider seam to carry one, on both adapters.
- **Nothing is emailed to a customer who has no address**, and there is no
  screen to add one to an existing customer — only to a new one. Editing a
  customer is a gap this phase brushed against and did not fill.
- **The timeline entry needs a CRM organization.** A customer created from the
  invoice screen has none, so most sends are recorded only as a transactional
  message. That row is what Phase 24 already watches for failures, so nothing
  is lost, but the client timeline is thinner than it looks.
- **No bounce handling.** ADR 0038 left provider webhooks unconsumed; an
  invoice accepted and then rejected an hour later still reads as sent.
- **Nothing chases.** An overdue invoice does not remind anybody by itself,
  though `isReminder` and the send count are now the shape that would need.
- **Bills are not sent.** They are received; the symmetry Phase 41 built on
  this screen stops here on purpose.
- **`sent_at` is not a status.** An invoice is `open` whether or not anybody
  has been asked for the money, which keeps the aging report honest and means
  "sent" is a column somebody reads rather than a state machine.

## Follow-up

1. **Edit a customer**, so an address can be added to one that already exists.
2. **Chase overdue invoices** on Phase 10's worker, reusing the reminder
   wording and the send count this phase established.
3. **Attach the PDF**, which means teaching `TransactionalMessage` and both
   adapters to carry one.
4. **Pay from the page.** The link is the natural place for it and the reason
   to want a payment provider at all.
