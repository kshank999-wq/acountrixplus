# 0078 — The client nobody could correct

**Status:** accepted
**Date:** Phase 78
**Amends:** ADR 0045 (correcting a party), ADR 0072 (audit visibility), ADR 0003 (the CRM model).

## The defect

ADR 0077 nominated one line of it: `createOrganization` takes a city and a
region and no street, postcode or country, though `organizations` has all six
columns. Looking at the write paths found the larger shape.

**There were only ever three of them**, and none was an edit:

| Where | What it does |
| --- | --- |
| `intake.ts` | the public lead form creates one |
| `opportunities.ts` | `createOrganization` |
| `conversion.ts` | sets `lifecycleStage` to `active_client` on a win |

There was **no update path at all** — no service, no action, no form. An
organisation created with a typo at lead intake kept it for ever, and the only
escape was a second record, which splits its opportunities, its proposals and
its timeline in two. That is the exact sentence `modules/parties/changes` opens
with, written in Phase 45 about customers:

> A typo in an address means that customer can never be sent anything, for
> ever, and the only escape is a second customer record — which splits their
> history, their aging and their statement in two.

Phase 45 then built the whole vocabulary for fixing it — `PartyField`,
`diffParty`, `describeChanges`, a correction screen — and gave it to `customers`
and `vendors`. The CRM's own record of **who the client is** never got any of it.

**And the audit action was already there.** `'organization.update'` has been in
the action union since Phase 3. Nothing has ever written it. The vocabulary
anticipated this service and the service never arrived.

**Phase 77 raised the stakes.** An organisation's name and address are now
frozen into every agreement it signs. A typo no longer merely persists — it is
copied into the record of a contract and kept there deliberately.

## Decision 1: the third party kind joins the registry

`ORGANIZATION_FIELDS` sits beside `CUSTOMER_FIELDS` and `VENDOR_FIELDS`, and
`updateOrganization` mirrors `updateCustomer`: a partial input so a form showing
six of thirteen fields cannot blank the other seven, a diff against the stored
row, and no audit entry at all when nothing changed.

`lifecycleStage` is classified `default` rather than `description`, because
segments are built on it — changing it changes which campaigns reach that
client's contacts, which is a consequence rather than a spelling.

## Decision 2: `normaliseParty` and `auditable` move to where the vocabulary is

Both were private to `receivables/service`. A third party kind needed them, and
copying them would have been the defect `modules/parties/changes` exists to
describe. They now live beside `diffParty`, and receivables imports them.

## Decision 3: the CRM is placed in the audit visibility registry

Found while giving `organization.update` a writer, and worth more than the
writer: **six CRM entity types have written audit events since Phase 3 —
`organization`, `opportunity`, `proposal`, `design_document`,
`document_template`, `lead_intake_key` — and none of them was ever listed in
`READABLE_BY`.**

Absent means `audit:view`, which is the strict end and correct as a default. But
`sales` does not hold `audit:view`. So a salesperson could move an opportunity
through the pipeline, send a proposal, and correct a client, and then read the
history of none of it.

An audit entry the person who made the correction cannot see is not much of an
audit trail. All six are now `crm:view` — Phase 71's rule, that you may read the
history of a record you may read, finally applied to the workspace that was
missing from it.

## What this did not do

Nothing in the ledger, no migration, no schema — every column this phase writes
has existed since Phase 3.

The form is one component for adding and for correcting, because they are the
same thirteen fields and a second copy is how the two drift — which is this
defect one level up: the record had thirteen columns, the form offered five.

Lead intake still creates organisations with whatever the public form sends,
which is a name and an email. That is right: a stranger filling in a web form
is not being asked for a postcode, and the correction path this phase adds is
what fixes it afterwards.

## What the next phase might take

`contacts` has the same shape and was not touched here. `createContact` exists,
`updateContact` does not, and a contact holds the email address every proposal
and every campaign is actually sent to — so a typo there is not a cosmetic
problem but a letter that never arrives. The same registry, the same diff, the
same audit action would do it; `'contact.update'` is not yet even in the action
union, which is the one thing `organization.update` had going for it.
