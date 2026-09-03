# 0101 — The list that said "every table"

**Status:** accepted
**Date:** Phase 101
**Amends:** ADR 0024 (the retention policy), ADR 0100 (guard attempts), whose
"what the next phase might take" named this and got the shape of it wrong.

## The defect

`RETENTION_POLICIES` opens with a claim:

> Every table this application lets grow with traffic.

It names ten. `guard_attempts` — added last phase, by this codebase's own most
recent work — grows with traffic and is not among them. Nothing noticed, and
nothing could have: the retention test asserts the two lists do not *overlap*,
and never that either covers what it says it covers.

This is the third time in five phases that a claim in a docstring has been
found untrue (Phase 97 corrected ADR 0096, Phase 98 corrected two README
caveats), and the second time the thing missing was added by the phase
immediately before. That is not carelessness so much as a missing mechanism: a
list nothing checks is a list that drifts, and the drift is invisible precisely
because the list reads as authoritative.

## Decision 1: the claim is narrowed to what can be true

There are 178 tables. Ten are swept, sixteen are named as never-swept, and the
other 152 are the business — customers, invoices, chart accounts, leases — rows
a person deliberately created, bounded by the size of the company rather than by
traffic. They do not need a retention decision, and demanding one would turn
`NEVER_SWEPT` from a statement about the books into a dumping ground.

So the docstring stops claiming to enumerate a category it cannot see, and says
what is actually true: these are the tables **somebody has decided** grow with
traffic. The difference matters, because it makes the next sentence honest — the
list is only as complete as the last person to think about it, which is why the
tripwire below exists.

## Decision 2: a new table has to answer the question

This codebase already has two shapes of tripwire, and the choice between them is
the interesting part.

Phase 96's is the good one: `PARTY_REFERENCES` is checked against
`pg_constraint`, so adding a table with a `customer_id` on it fails the test
**with the column named**. That works because the question — *what points at
`customers`* — is a fact the catalogue holds. Nothing is written down twice.

That is not available here. "Grows with traffic" is a fact about *who writes the
rows*, and no column, constraint or type says it. `documents` and
`domain_events` look identical to the catalogue and belong on opposite sides of
this list. So the tripwire falls back to the other shape — the one
`filing.test.ts` uses for transactional kinds
(`expect(ALL_KINDS).toHaveLength(9)`): **the number of tables is written down,
and adding one fails the test.**

It is the cruder of the two and it is deliberately noisy. A test that fails on
every migration is a real cost, paid so that the moment of adding a table is
also a moment of deciding whether it needs a policy — which is the moment that
did not happen last phase. The failure message says exactly that, and says the
two ways to answer it: a policy, or a line in `NEVER_SWEPT`.

## Decision 3: `guard_attempts` keeps a year

Longer than `login_attempts`' ninety days, which reads backwards until you look
at why ninety is the number there. It is not that a sign-in failure matters
less; it is that **anybody on the internet can write one, at a rate they
choose**, and the policy says so in as many words — ninety days "throws away the
part that is only ever a bill for disk". Ninety is a compromise forced by
volume.

There is no such pressure here. A guard attempt needs a live session to reach,
so the ceiling on the table is how fast one signed-in person can type, and the
rows are three columns wide. What is left is only the question the rows answer:
*was somebody at my session in March* — asked late, by somebody who has just
found out something else is wrong, and often the only dated evidence that the
warning letter they half-remember was real.

That is the same argument `integrity_runs` makes for its year ("a difference
discovered at a year end can be dated"), and it lands in the same place. The
contrast with `login_attempts` is the point worth keeping: **the sign-in record
is short because it is loud, not because it is unimportant.**

## Decision 4: one answer to when an expired token goes

`pruneExpiredTokens(30)` in `tokens.ts` and the `action_tokens` policy
(`days: 30`) are the same rule written twice. The registry's version is the one
`sweepAll` runs; the other has **no production caller at all** and is kept
looking alive by a single test that calls it directly.

That is worse than dead code. A reader finding it reasonably concludes it is how
tokens are pruned, and would change the number there — where it does nothing —
while the sweep carried on at thirty days. It is deleted, and its test with it,
because the behaviour it claimed to provide is covered by the retention tests
that exercise the real path.

## What this did not do

**It does not categorise the other 152 tables.** They are the business, and a
retention list that included them would say nothing by saying everything.

**It does not make the count self-updating.** A tripwire that repairs itself is
not a tripwire.

## What the next phase might take

**`retentionReport()` is not scoped to a company, and the screen that shows it
is.** Every other query on the operations page takes `actor.companyId` —
`queueCounts`, `listJobs`, `listSchedules`, `listEvents`, `health`. That one
call takes nothing, and seven of the ten swept tables (`action_tokens`,
`proposal_views`, `lead_submissions`, `campaign_events`,
`transactional_messages`, `domain_events`, `integrity_runs`) carry a
`company_id`. So a `company:manage` holder at one company reads how many letters
every *other* company on the deployment is holding.

It is an aggregate rather than a record, which is why it has survived — but "how
many invoices did they send last year" is a business fact, and the tenancy rule
this codebase asserts everywhere else does not have an aggregate exemption. The
awkward part, and the actual decision that phase would make: the same function
answers a real operator question — *is this deployment holding too much* — which
is genuinely not per-company, and `login_attempts`, `sessions`, `guard_attempts`
and `document_blobs` cannot be scoped at all. So it is two questions wearing one
function, which is the shape this codebase keeps finding.
