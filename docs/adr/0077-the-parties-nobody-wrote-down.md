# 0077 — The parties nobody wrote down

**Status:** accepted
**Date:** Phase 77
**Amends:** ADR 0076 (naming both parties), ADR 0021 (the snapshot), ADR 0003 (the CRM model).

## The defect

A signed proposal is a contract, and this application froze everything about
one except the two parties to it.

| Question | Where the answer lives | Does it move? |
| --- | --- | --- |
| What was offered | `proposal_versions.snapshot` | no |
| What the client looked at | `pdf_document_id`, content-addressed | no |
| Who signed, their title, their typed signature | `proposal_acceptances` | no |
| Which version they signed, from which network | `proposal_acceptances` | no |
| **Which two businesses are bound** | a walk to live rows | **yes** |

The company side resolved through `company_id` to `companies` and
`company_profiles`. The client side through the opportunity to `organizations`.
Both are ordinary editable records — Phase 74 established that people do rename
a company in the Design Center, and ADR 0045 made correcting a client a
first-class action with its own audit trail. Do either, and every acceptance
already signed silently reports a contract with a party that did not exist when
it was signed.

It is the one unfrozen fact in an otherwise carefully frozen record, and it is
the fact a dispute is actually about.

**Phase 76 made it worse before making it visible.** That phase put both parties
into the rendered PDF, permanently. So the picture is now right forever while
the queryable record still resolves live — and the two can disagree about who
agreed with whom.

## The rule

> **A record of an agreement names the parties as they were, not as they are.**

The same rule Phase 55 applied to a statement and Phase 62 to a payment's
currency: a claim about a moment does not get to move afterwards.

## Decision 1: the parties are frozen onto the version

`proposal_versions.parties`, written in the same transaction that writes the
snapshot and renders the PDF. The version is the right home: it is already where
*what was offered* lives, an acceptance already points at the version it was
signed against, and freezing in two places would give the record two answers.

`modules/crm/parties` builds it, from Phase 75's letterhead for the company and
the organisation row for the client — so the names on the record are the same
names the document prints.

## Decision 2: a party is a list of names, not a name and a legal name

The two sides disagree about which name is which. A company is *registered* as
one thing and *trades* as another; `organizations` has a single `name` and no
registration column at all. Fields named for one side would leave the other
holding a column that is structurally always null — the defect Phase 75 caught
in its own first draft of `Letterhead.legalName`.

So `Party` is `{ names: string[], address: string[] }`, most formal first.

## Decision 3: nothing is backfilled

The obvious backfill is a join to `companies`, `company_profiles` and
`organizations` — which is precisely the live read this column exists to remove.
It would write today's names onto yesterday's agreements and make them look
authoritative: a confident answer that is wrong in exactly the case the column
is for.

So the column is nullable, old rows stay null, and every reader says
`NOT_RECORDED` rather than guessing. A version sent before this migration has no
record of its parties, and that is the truth about it.

## Decision 4: readers narrow rather than trust

The column is `jsonb` and will hold rows written by every version of
`modules/crm/parties` that ever runs. `isParties` is the guard, and both readers
use it — the same forgiveness `parseBlocks` applies on the document read path.
A stored value that is not a parties record reads as "not recorded", which is
the same honest answer as a missing one.

## What this did not do

Nothing in the ledger. No change to what `proposal_acceptances` stores: the
client's side was already complete, and adding a second copy of the parties
there would be the duplication Decision 1 avoids.

Snapshots still do not move, and this phase depends on that rather than
fighting it — the PDF and the frozen parties are now two records of the same
moment that cannot drift apart, because neither of them can change.

## What the next phase might take

Found while writing the fixture: **`createOrganization` takes a city and a
region and no street, postcode or country**, though `organizations` has all six
columns and the client-facing documents print them. A client's address can only
be set by writing to the row directly, which the application never does — so
`{{client.address}}` on a proposal, and the `offeredTo` address this phase
freezes, are as complete as the CRM lets them be, which is two lines out of
four.
