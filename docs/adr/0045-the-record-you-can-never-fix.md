# ADR 0045 — The record you can never fix

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §6, §13, §19. Five phases made a business able to raise,
  send, chase and collect an invoice. None of them made it able to correct a
  typo in the customer's email.
- **Builds on:** [ADR 0042](0042-what-the-customer-opens-is-the-ledger.md),
  [ADR 0002](0002-double-entry-ledger.md)

## Context

Customers and vendors have existed since Phase 2. There was no page that listed
them, no way to reach one, and **no update function of any kind** — not for a
name, an email, a phone number or payment terms.

The consequence was quietly severe and got worse with every phase built on top.
A typo in an email meant that customer could never be sent an invoice (Phase
42) and never be chased (Phase 43), for ever. The only escape was a second
customer record, which splits their aging, their statement and their balance in
two.

And a smaller find with the same shape: `modules/pdf/invoice.ts` has composed a
"Billed to" block from `addressLine1`, `city` and `postalCode` since Phase 21,
and **no code path has ever written any of the three**. Every invoice PDF this
application produced carried a billing address consisting of the customer's
name. The PDF needed no change; it needed somewhere to type.

## Decision 1: three kinds of field, not one

The fields on a party record look like one form and are three different things,
and what a change *means* depends on which:

- A **description** — name, email, address. It says how to refer to somebody
  and how to reach them. Correcting one corrects it everywhere it appears,
  including on an invoice already sent. That is right, and it is ADR 0042's
  live-record argument applied consistently: there is one customer, and a
  document showing a stale spelling of their name is showing something that was
  never true.

- A **default** — payment terms. It decides the due date of the *next* invoice
  and has no business touching one already raised, whose due date is a fact
  somebody was told. Nothing in `updateCustomer` reaches into `invoices`, and
  the form says so, because otherwise somebody changes the terms expecting the
  aging report to move.

- A **consequence** — a vendor's tax ID and whether they are reportable. Not
  descriptions of a party but positions taken for a filing, and changing one
  after a year has been reported restates something already sent to a tax
  authority. Allowed — corrections are exactly why it must be — but the notice
  says what it did.

`modules/parties/changes.ts` holds these as named data, so the screen, the
audit summary and the tests read the same list, and adding a column is a
deliberate decision about which of the three kinds it is.

## Decision 2: a partial update, so a form cannot destroy what it did not ask

`diffParty` considers only fields present in the submitted object. A form
carrying three of twelve columns cannot blank the other nine, which is the
commonest way an edit screen loses data. A field changed to the value it
already had is not a change, so saving an untouched form writes no audit entry
— otherwise the log fills with noise and the one real edit is buried in it.

## Decision 3: the audit trail here is not decoration

Changing a vendor's payment details is the commonest invoice-fraud vector a
small business meets: an email arrives saying *"our bank has changed"*,
somebody updates the record, and the next payment run goes to a stranger.

So every change carries **before and after** into the audit log, and that is
the whole reason to prefer an update over a delete-and-recreate. Editing a
vendor needs `accounting:journal` rather than the `accounting:view` that
*creating* one needs, because reading a supplier list and redirecting a payment
run are different powers.

## Decision 4: archive, never delete

Retiring somebody keeps every document that names them and changes nothing
about the books. What it stops is their appearing in a picker, which is the
actual thing somebody means by "we do not work with them any more".

Refused while there is open business, and not for tidiness: a customer hidden
from every picker while still owing money is a debt nobody will chase. The
books stay right and the business quietly stops collecting, which is the worst
kind of wrong.

## The two defects this turned up

**One client, two customer records.** Reseeding onto the new screen showed two
customers both called *Harborview Development LLC*.
`convertWonOpportunity` deduplicated only against a customer already linked to
the organization, so a client invoiced *before* they were won in the CRM — the
ordinary order of events for a repeat customer — got a second record. It now
adopts an unlinked, exact-name match in the same company instead, which is
narrow on purpose: one already linked elsewhere is a different client who
happens to share a name, and is left alone.

That the demo had been carrying this duplicate for many phases is the point of
the phase: until there was a screen listing customers, there was nowhere it
could have been seen.

**A refusal that followed you to the next record** (browser). Archiving a
customer who owed money was correctly refused, and the message stayed on screen
while the user switched to the Suppliers tab and opened a different party — so
*"there is still money outstanding"* sat above a supplier owing nothing. A
notice is about the record it was raised on, and is cleared when the subject
changes.

## Consequences

- **No merge.** Two records for one client can now be *seen*, and there is
  still no way to combine them; the escape is to archive one, which leaves its
  documents where they are. A real merge has to move invoices, payments and
  history, and is its own phase.
- **The quick-add stays minimal.** Creating a customer inside the invoice
  composer still asks only for a name, an email and terms; the address and tax
  details are filled in here afterwards, and the confirmation says so.
- **Renaming is retrospective and unversioned.** A customer renamed today reads
  as renamed on every document they have ever been on. The audit log holds what
  the name was, but no document shows the name it was raised under.
- **Contacts are not parties.** A customer has one email. The CRM's contact
  records exist and are not joined to this; sending an invoice to two people at
  the same client is not possible.
- **Organizations are still uneditable.** This covers the accounting side.
  `crm.organizations` has the same gap and the same fix is not applied.

## Follow-up

1. **Merge two records into one**, moving documents and history.
2. **Edit an organization**, so the CRM side matches.
3. **More than one contact per customer**, so an invoice can go to accounts
   payable and a copy to the project manager.
4. **Show a party's documents on their own record**, which is the obvious next
   thing to want from a page that lists them.
