# 0075 — The letterhead that was never on the letter

**Status:** accepted
**Date:** Phase 75
**Amends:** ADR 0074 (whose letter), ADR 0004 (the Design Center profile), ADR 0021 (the PDF writer).

## The defect

ADR 0074 nominated the shape: the Design Center's profile boxes are
`z.string().trim().max(200).optional()` with no `.min(1)`, and the form is
controlled, so a cleared box saves `''` rather than null — and `''` does not
trip `??`. Thirteen fields shaped that way, feeding the invoice letterhead and
the proposal footer.

Following it into the documents found something worse than a blank-handling bug.

**The invoice has no letterhead.** `modules/pdf/invoice` put `companies.name`
on the cover band, the same string in the page footer, and read nothing else
from the profile except the payment instructions:

```ts
preparedFor: row.company.name,
// …
footerText: row.company.name,
```

No address. No telephone number. No email. No website. On the one document this
application produces that a **stranger receives, has to pay against, and in most
places has to keep**. The company had typed all of it into the Design Center
and nothing ever asked for it.

**`documentFooter` reached one thing, and it was the wrong one.** The schema
calls it *"default footer language for generated documents"*. It has existed
since Phase 4. Its only consumer was the footer of a **marketing email**. The
seeded value is `Ridgeline Construction LLC · WA contractor licence RIDGEC*781QK`
— a licence number, which is the kind of text a trade is required to publish on
the documents it bills with, and which appeared on none of them.

**And four spellings of one question.** "What is this company called, and how do
you reach it" was answered four ways:

| Where | What it said |
| --- | --- |
| `campaigns.ts` | `senderName({...})` — Phase 74 |
| `marketingRenderContext` | `profile?.legalName ?? company.name` |
| `proposalRenderContext` | `profile?.legalName \|\| company.name` |
| `pdf/invoice` | `company.name`, and nothing else |

The middle two are in the same file, thirty lines apart, and differ by one
character. `??` keeps `''` and `||` does not — so with a legal name cleared, the
proposal was right and the marketing preview showed a company with no name. The
Phase 74 defect, still live, one file over. The three send paths spelled a
fourth, partial version by hand — `addressLine1` only, dropping line 2, the
city, the region and the postcode.

## The rule

> **A blank box is an unanswered question, not an answer.**

`modules/brand/letterhead` holds it. `letterheadFor({ companyName, profile })`
returns the name, the trading name, the address lines, the three contact
channels and the footer; every one of them is dropped when it is missing, null,
or blank, and a line made only of blanks is not printed. A company that has
filled in nothing gets its name — which always exists — and nothing else.

It is pure, and `name` comes from Phase 74's `senderName`, so a document's
masthead and the `From:` line of the letter carrying it cannot disagree.

## Decision 1: the registered name heads it, the trading name sits under it

`senderName` already resolves to the registered name when there is one, because
that is the name a payment has to reach. But the customer knows them as
"Ridgeline", not "Ridgeline Construction LLC", and an invoice from a name they
do not recognise is one that gets queried instead of paid. So `tradingName`
carries `companies.name` when it differs, and prints as *trading as Ridgeline*.

Null when the two are the same — printing a name twice reads as a bug.

## Decision 2: the customer-facing views take the whole letterhead

`sharing.ts`, `statement-sharing.ts` and `remittance.ts` each declared an
identical `CompanyFacts` — `{ name, email, phone, addressLine }`, four fields,
written out three times — and the `addressLine` was `addressLine1` alone. So the
page a customer opens gave them the street and never the city.

All three are now `Letterhead`, and the three pages map over `address` instead
of printing one line. Doing this in the same phase rather than the next one is
the point: giving the PDF a full address and leaving the web page on line one
would have *created* the divergence this codebase keeps removing, in the same
change that removed four others.

## Decision 3: the three contact channels stay apart

A PDF prints telephone, email and website down the page; the customer-facing web
page wants the email as a `mailto:` and the phone as a `tel:`. A single
pre-joined string would serve the first and force the second to take it apart
again, which is how one answer becomes two. So the letterhead holds them
separately and `contactLines` is the joined view.

## Decision 4: the tax identifier is not printed

`companyProfiles.taxId` exists, and a registration number on an invoice is
ordinary — in VAT jurisdictions, required. It is deliberately **not** on the
letterhead.

Phase 72 put `taxId` in `NEVER_SHOWN` and redacted it out of the audit log. That
was about a *contact's* identifier in a trail read by staff, which is a different
thing from a company's own registration on its own invoice — the first is
incidentally recorded, the second exists to be published. The two do not actually
conflict.

But deciding to publish an identifier on a company's behalf is not ours to make
from a field labelled "Tax ID" with no indication of what they wanted it for.
The company that wants it on their documents already has the way to do that, and
the seed shows them doing it: they wrote their licence number into
`documentFooter`. The footer is the consent-shaped field. The tax ID stays where
they put it.

## What this did not do

Nothing in the ledger, no migration, no schema. The proposal PDF still renders
from the block model its author composed, because a proposal's letterhead is a
design decision the author is making; an invoice's is not.

The thirteen `.optional()` boxes are still `.optional()`. Tightening them to
`.min(1)` would refuse a company the right to leave their website blank. The
defect was never that `''` gets stored — it is that `''` was read as an answer.

## What the next phase might take

The **proposal** PDF is now the odd one out. Its letterhead is whatever blocks
its author composed, so two proposals from the same company can carry different
addresses, and one written before the company moved still carries the old one.
That is defensible for a document somebody designs — and indefensible for the
address on it, which is a fact about the business rather than a design choice.

`documentFooter` has the same shape one level up: it is now on the invoice, but
`renderDocumentPdf` still takes `footerText` as a free string that each caller
supplies, so the proposal and the invoice reach it by different routes.
