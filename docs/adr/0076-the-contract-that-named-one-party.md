# 0076 — The contract that named one party

**Status:** accepted
**Date:** Phase 76
**Amends:** ADR 0075 (the letterhead), ADR 0004 (the design engine), ADR 0021 (the PDF layout).

## The defect

ADR 0075 nominated the proposal: its letterhead is whatever blocks its author
composed, so two proposals from the same company can carry different addresses.
Following that found the sharper version of it.

**A signed proposal names one of the two parties.**

`proposal_acceptances` records the client's side completely — signer name,
title, email, the typed signature, the exact version they were looking at, and
the network prefix they signed from. The agreement text names them too: *"By
signing below I accept this proposal, its scope, and its terms on behalf of
{{client.name}}."*

The company was never named. A document that becomes a binding agreement
identified the side that signed it and not the side that would be bound by it.
The only place the company appeared at all was the cover — *"Prepared by
{{company.name}}"* — which resolved to the trading name, and which an author is
free to delete.

**And a second address formatter.** `merge-fields` had its own:

```ts
function formatAddress(source) {
  const cityLine = [source.city, source.region].filter(Boolean).join(', ')
  return [source.addressLine1, [cityLine, source.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean).join('\n')
}
```

It reads four columns. Phase 75's `addressLines` reads six — it keeps
`addressLine2` and `country`. So a company with a suite number got it on their
invoice and not in `{{company.address}}` on their proposal: two documents from
one business, disagreeing about where the business is.

**And `company.legalName` was a second answer to `company.name`.** It resolved
as `profile.legalName ?? company.name` while `company.name` resolved by its own
route — two offered fields, differently derived, usually equal, with nothing
making them stay that way.

## The rule

Phase 75 said *a blank box is an unanswered question*. This one adds:

> **An agreement names everyone it binds.**

## Decision 1: one postal address formatter, for anybody's address

`formatAddress` is deleted. `addressLines` from the letterhead is the only one,
and it now lays out the **client's** address too — a client's address is a
postal address like anybody else's, and the two had no reason to be formatted by
different code. `MergeSources.client` takes the same six fields as a result,
rather than the four it used to admit.

## Decision 2: the merge context is built from the letterhead

`buildMergeContext` takes a `Letterhead` for the company rather than a
hand-picked set of profile columns. Every field the designer offers now comes
off the same object the invoice prints its masthead from, so `{{company.address}}`
in a proposal, in a marketing creative and on an invoice cannot drift apart.

`company.legalName` resolves to the letterhead's `name` — the same string as
`company.name`, because there is one answer. The name that was actually being
lost gets its own key: `company.tradingName`, along with `company.footer`.

## Decision 3: the signature block names the offering party

The renderer draws *Offered by <name>* and the company's address inside the
signature frame, opposite the client the agreement text already names.

It reads the **merge context**, not a new field on the block. That is the whole
point of the choice: a new field would appear on documents created from a
template after today and on nothing else, and the proposals most likely to be
signed are the ones already composed. Reading the context reaches every proposal
in the system, including one drafted a year ago.

When the context has no company — a marketing creative, a bare preview — the
lines are empty and the block draws exactly as it did before, rather than
growing a heading with nothing under it.

## What this did not do

Nothing in the ledger, no migration, no schema. **Snapshots do not move**: a
proposal that was sent has its bytes in the content-addressed store and this
phase cannot reach them, which is the property Phase 21 built and this change
depends on rather than fights. Only new renders name both parties.

The built-in templates were left alone. Their covers still say *"Prepared by
{{company.name}}"* and that is now the registered name, which is the fix; adding
a letterhead band to four templates would change what every new proposal looks
like without reaching a single existing one.

## What the next phase might take

`proposal_acceptances` records the signer's name, title and typed signature, and
nothing about the party they contracted with. The company's identity at the
moment of signing lives only in the snapshot PDF — readable by a person, not by
a query. A dispute about who agreed to what is answered today by opening a file
and reading it.

The same asymmetry: the client's side is captured as data, the company's side as
a picture.
