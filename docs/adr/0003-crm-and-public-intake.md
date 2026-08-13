# ADR 0003 — Unified party records, the pipeline, and a public write endpoint

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §6 (clients, leads, pipeline), §9 (proposal analytics), §10 (consent), §19 (security), §20 (Phase 3)
- **Builds on:** [ADR 0001](0001-modular-monolith-and-tenancy.md), [ADR 0002](0002-double-entry-ledger.md)

## Context

Phase 3 adds the client-facing half of the product: who you sell to, what you
have proposed, and whether you won. Two decisions carried real weight — how
CRM parties relate to the accounting customers and vendors built in Phase 2,
and how to expose a lead-capture endpoint to the open internet without
weakening the tenant isolation the first two phases were built on.

## Decisions

### 1. `organizations` is the party record; customer and vendor are roles

Spec §6 asks for "unified contact/company records with lead, prospect, active
client, former client, vendor, or strategic-target status", while spec §16
lists Customer and Vendor as their own entities. Those read as contradictory
until you separate *who someone is* from *what they are to you*:

- `organizations` — the one party record, carrying lifecycle stage, industry,
  region, source, and the strategic-account flag.
- `customers.organizationId` / `vendors.organizationId` — nullable links making
  each accounting record a **role** the organization plays.

A single merged table handles one common case badly: a firm you both buy from
and sell to. Under this model that is one organization with two accounting
roles, not two rows disagreeing about a status field. The links are nullable so
the accounting side still works standalone — a bookkeeper can add a vendor
without touching the CRM.

`isStrategicAccount` is a separate boolean rather than only a lifecycle value,
because spec §10 wants strategic accounts identified *alongside* ordinary
status, and an existing client can also be a strategic account.

### 2. The pipeline is permissive forwards and backwards, strict about closing

Deals stall and reopen. A pipeline that refuses to record that just gets worked
around, so moving between open stages is unrestricted in both directions.

What is restricted is leaving a *closed* stage: a won opportunity has created a
client and a job, and a lost one may already have been handed to marketing.
Changing the stage of a closed deal is refused; `reopenOpportunity` is the
explicit way out, and it clears the loss reason and the marketing flag.

Closing as lost or dormant requires a structured `lossReason`, because spec §9
reports on loss reasons and free text does not aggregate.

**Probability tracks the stage until someone overrides it.** The first
implementation only updated probability on close, so a deal moved to
Negotiation stayed at the 10% it was created with and the weighted forecast was
badly wrong. `probabilityOverridden` records whether a person set the figure by
hand: until they do, it follows the stage default; once they do, their
judgement wins. Closing overrides regardless — won and lost are certainties,
not estimates.

**Side effects only ever advance the stage.** Sending a proposal moves the
opportunity to `proposal_sent` *only* if it sits earlier than that; resending a
revised proposal to a deal in negotiation must not drag it backwards and reset
its forecast weight. The same guard applies when a client view advances it to
`viewed`.

### 3. Consent is recorded at capture and eligibility decided at close

Spec §10 and §19 want consent controls, but Phase 5 is what acts on them.
Phase 3 captures the data so it exists from the moment a lead arrives:
`emailConsent` defaults to `unknown`, never `subscribed` — consent is something
a person gives, not something the absence of information implies.

`opportunities.marketingEligible` is computed **when the deal closes**, not
when Phase 5 eventually reads it. At close the contact's consent is known;
deriving it later would test it against consent that may since have changed.
Suppression always beats consent.

### 4. Proposals version on send

Once a client has been shown a price, editing the proposal must not change what
they were quoted. `sendProposal` writes an immutable snapshot of the proposal
and its items to `proposal_versions`; editing afterwards and resending produces
version 2 rather than mutating version 1.

The client link is a per-proposal random token, so possessing one link reveals
nothing about any other. View tracking is deliberately coarse — a timestamp, a
truncated address prefix, a user agent — because spec §9 qualifies it with
"where technically and legally appropriate", and cross-site profiling is not
what an accounting product should be doing.

### 5. The public intake endpoint is write-only and defended in the service

`POST /api/intake/<public key>` is the only unauthenticated write path in the
system. The design rule is that the key **identifies a tenant and authorizes
creating a lead — nothing else**. It cannot read, update, or delete, and the
company is resolved from the key lookup rather than from anything the caller
sends.

Defences, in the service rather than the route so they are covered by tests:

| Concern | Response |
| --- | --- |
| Unbounded writes | Accepted submissions rate limited per key per hour, counted from the submission log so the limit survives restarts |
| Storage exhaustion via the log | Rejections stop being written past ten times the hourly allowance; the request is still refused |
| Junk locking out real visitors | Only *accepted* submissions count toward the limit |
| Oversized bodies | Content-length checked before parsing; every field length-capped by schema |
| Automated submission | Hidden honeypot field; a hit is reported as success so the submitter learns nothing |
| Key enumeration | Unknown and revoked keys return the identical response |
| Unwanted embedding | Optional per-key origin allowlist |
| Privacy | Addresses truncated to a network prefix, never stored whole |

Rejected attempts are logged on purpose — those are the ones worth
investigating — and surfaced in the UI so an operator can see abuse rather than
having to go looking for it.

### 6. A won opportunity becomes a client and a job in one step

Spec §6: "Won proposal can create a client, job/project, contract, invoice
schedule, and accounting dimensions without re-entry." `convertWonOpportunity`
creates the customer (reusing the organization's existing one for a repeat
client), creates the job, promotes the organization to `active_client`, and
optionally raises an invoice from the winning proposal's line items.

It is **idempotent**: converting twice returns what it created rather than
making a second client and a second job.

Invoicing runs in its own transaction, because it posts to the ledger and can
fail on its own terms — a closed period, a missing revenue account. The client
and job are correctly created either way.

### 7. `projects` closes the accounting-dimension gap from ADR 0002

ADR 0002 recorded that journal lines had no accounting dimensions. The job a
won proposal creates and the project dimension spec §13 asks for are the same
thing, so `projects` serves both and `journal_lines.projectId` now exists.
Reports do not yet filter by it — that is a query change, not a schema one.

## Consequences

- Three tables now carry a name for the same party (`organizations`,
  `customers`, `vendors`). The links keep them consistent on creation, but
  nothing yet propagates a *rename*. Worth a trigger or a service rule before
  the name appears on client-facing documents in Phase 4.
- The rate limiter costs one indexed count per submission. Fine at this scale;
  a shared cache would be better under real traffic.
- Proposal narrative sections are plain text. Phase 4 replaces them with
  designed content, attaching layout to these records rather than new ones.
- E-signature and acceptance (spec §7) are not built — the client link is
  read-only. Accepting in-page means a second public write endpoint, and it
  deserves the same scrutiny as intake rather than being tacked on.
- Communications and file attachments on opportunities (spec §6) are not built;
  `opportunity_activities` is the seam they will hang from.

## Follow-up

Phase 4 is the proposal designer and Company Studio. The brand kit it
introduces is what makes proposal output presentable, and the shared design
engine is reused by Phase 5 marketing — so the engine's boundaries matter more
than the first proposal template built on it.
