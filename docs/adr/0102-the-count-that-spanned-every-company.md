# 0102 — The count that spanned every company

**Status:** accepted
**Date:** Phase 102
**Amends:** ADR 0024 (the retention policy), ADR 0101, whose "what the next
phase might take" named this and got the shape of it roughly right.

## The defect

The operations page builds its data in one `Promise.all`. Every call in it
takes the actor's company:

```ts
queueCounts(actor.companyId)
listJobs({ companyId: actor.companyId, limit: 60 })
listSchedules(actor.companyId)
listEvents(actor.companyId, 25)
health(actor, { … })            // scoped inside, and tested for it
canAdminister ? retentionReport() : …
```

One of them takes nothing. `retentionReport(asOf, exec)` has no `companyId`
parameter at all, and seven of the eleven swept tables carry a `company_id`.
So a `company:manage` holder at one company reads how many letters, campaign
events, lead submissions, relayed events and nightly check runs **every other
company on the deployment** is holding.

The comment above the gate shows how it happened, and it is not carelessness:

> Retention counts read every table this application lets grow, which is a
> question only somebody who administers the company may ask

That is true, and it is answering the wrong question. It reasons about *which
role* may see the numbers and never about *whose rows they are*. Permission and
tenancy are different checks, and a permission check reads like a complete one.

It has survived because an aggregate does not look like data. But "how many
invoices did they send last year" is a business fact, and the tenancy rule this
codebase asserts on every other query does not have an aggregate exemption.

## Decision 1: the report takes an audience, and the sweep does not

`retentionReport` gains a caller-supplied audience — a company, or the
deployment. The **sweep keeps no audience at all.**

That asymmetry is the whole safety of this change and is worth stating plainly,
because "scope it like everything else" applied to `sweepAll` would be a serious
bug: retention would then only delete rows belonging to whoever last loaded a
page. Deleting is a housekeeping job that runs nightly as nobody; *reporting* is
a screen somebody is looking at. Only the second has a viewer.

## Decision 2: three kinds of table, because the schema actually has three

The obvious model is "has a `company_id` or does not". The database disagrees,
and checking it before writing the code is what turned this ADR up:

| | tables |
| --- | --- |
| **no `company_id` at all** | `login_attempts`, `sessions`, `guard_attempts`, `document_blobs` |
| **`company_id NOT NULL`** | `campaign_events`, `domain_events`, `integrity_runs`, `lead_submissions`, `proposal_views` |
| **`company_id` nullable** | `action_tokens`, `transactional_messages` |

The third row is the one that matters, and it is not a modelling accident. A
`password_reset` token carries a `userId` and no company, because at the moment
it is issued nobody knows which company the address belongs to. A
`practice_invitation` carries a `practiceId` — a firm is not a company. And the
Phase 88 morning brief writes a `transactional_messages` row whose audience is a
practice; the development database has one sitting there right now, which is why
its eleven letters attribute to ten.

So a naive `where company_id = $1` would close the leak and open a quieter
hole: those rows would become invisible to **everybody**, dropping out of the
one screen that answers "what do you hold and for how long". Rows nobody can
see are rows nobody decides about — the exact failure Phase 101 just spent a
phase on.

Hence the third case is named rather than rounded off, and a company's count of
those tables is **its own share**, with the screen saying so. The remainder is
not other companies' rows; it is letters to firms and links for people.

## Decision 3: the policy is published, the count is tenant data

The fix is not to hide the rows a company cannot be told about. It is to notice
that a policy entry is two different things stapled together:

- **how long, and why** — a published statement about the product. Nothing
  about `login_attempts` keeping ninety days is anybody's private business, and
  the retention list exists precisely so somebody can be shown it.
- **how many rows there are right now** — tenant data, and the half that leaks.

So every viewer still sees every policy and every reason. What changes is that
a count appears only where it can honestly be attributed, and where it cannot
the screen says which of the two reasons applies rather than showing a blank.

## Decision 4: this tripwire can be derived, and Phase 101's could not

Phase 101 had to write a table count down by hand and said why: *grows with
traffic* is a fact about who writes the rows, and no column, constraint or type
says it.

This one is different. **Whether a table has a `company_id`, and whether it is
nullable, is a fact `information_schema.columns` holds.** So the attribution
each policy declares is checked against the catalogue, the way Phase 96 checks
`PARTY_REFERENCES` against `pg_constraint` — a policy claiming `per_company` on
a table with no such column fails with the table named, and one claiming a
column is `NOT NULL` when the schema has since made it nullable fails too.

That second direction is the valuable one. Making a column nullable is a
migration nobody would think to connect to a retention screen, and it silently
turns a complete count into a partial one.

## What this does not do

**It does not add a deployment-operator screen.** The deployment audience
exists in the module and has no page — this application has no operator role,
which is Phase 24's standing observation. The audience is a parameter with one
caller today, and it is here because the alternative is a function that cannot
express the question it is actually being asked.

**It does not scope `guard_attempts`, `sessions` or `login_attempts` by person.**
Those rows are about a user, and a per-user retention view is a different
screen with a different reader — the person themselves, not an administrator.

**It does not touch what the sweep deletes.** Same rows, same cutoffs, same
nightly job. Only the reading is narrowed.
