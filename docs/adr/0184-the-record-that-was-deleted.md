# 0184 — The record that was deleted

**Status:** accepted
**Date:** 2026-11-04
**Phase:** 184

---

## The nomination held, and was two tables

ADR 0183 nominated converting `document_links` away from twelve keyless
polymorphic subject references, having said for three phases running that the
argument was settled. The measurement found two things.

**It is two tables.** `record_notes` has the identical shape — a
`subject_type` enum and a bare `subject_id` — so it is twenty-four keyless
references, and the second one carries an accountant's own words.

**The weakness is not theoretical.** `modules/evidence/subjects.ts` argued the
missing key was acceptable because the check lives in code:

> It is the whole reason a missing foreign key is acceptable: the check that a
> constraint would do is done here, under the tenant filter, before anything is
> written.

That is true of *writing* a link. A foreign key is two guarantees and the
sentence accounts for one; the other is what happens when the referenced row is
**deleted**, and nothing did it.

## What was actually broken

`discardDraftEntry` deletes a draft journal entry. Its comment reads *"Lines
cascade"* — true, through a real foreign key, and incomplete. The working
paper's link and the accountant's question survived the entry.

The orphaned link was invisible: nothing queries evidence for a record that
does not exist. The orphaned **question** was not.

`openQuestions` is the company-wide work list — *"every unanswered question in
the company, newest first"* — and it reads `record_notes` with no join to the
subject. So an orphaned question sat on an accountant's list forever, about a
record that did not exist. And `resolveNote` marks the question answered and
then, if an answer was typed, calls `writeNote`, which calls `requireSubject`,
which throws — inside the same transaction. So:

- clearing the item **without** an answer worked, and
- clearing it **with** an answer always failed, with *"That journal entry does
  not exist"* about a record the person had not asked about.

Three more paths were latent in the schema rather than reachable from a screen:
`bank_transactions` and `reconciliations` cascade from `financial_accounts`, and
`proposal_versions` from `proposals`. Nothing deletes a financial account or a
proposal today, which is exactly why they were latent — and "remove this bank
connection" is an ordinary screen to want. They are fixed by the same change and
tested at the database, because a test cannot go through a screen that does not
exist.

## One identity table, not twenty-four columns

Phase 180's `asset_links` carries one nullable column per subject with a CHECK
that exactly one is set, and five composite foreign keys. Scaled directly to
twelve kinds across two consumers that is twenty-four columns and twenty-four
foreign keys, and the next consumer makes thirty-six.

So the exclusive arc lives in **one** table. `evidence_subjects` holds the
twelve columns and the CHECK; `document_links` and `record_notes` each hold a
single composite foreign key to its key. A third consumer costs one more, which
matters because `subjects.ts` already says attaching, detaching, reading and
noting all go through one register.

### `subject_type` and `subject_id` are generated

The obvious version carries the twelve columns *and* the pair the link tables
reference, and then there are two answers to one question and a CHECK per kind
to keep them agreeing. `GENERATED ALWAYS AS … STORED` settles it: the twelve
columns are the only place a subject's identity lives, the pair is the
database's own reading of them, and a stored generated column can carry a
primary key and be a foreign key's target.

Measured before it was written, because a generation expression must be
immutable and `'invoice'::evidence_subject` is a cast of a literal.

The primary key then does one more job for free: a generated column resolving to
NULL cannot sit in a primary key, so a row with **no** kind set is refused by the
key rather than needing a CHECK of its own.

### What the database refuses that it did not

1. A link or note whose subject does not exist.
2. A link or note whose subject belongs to another company.
3. A link or note naming the **wrong kind** for a real id. `subject_type =
   'bill'` beside a journal entry's uuid was storable and nothing noticed — the
   pair simply resolved to no record, so the link was invisible rather than
   wrong. This is new capability, not a constraint for an existing check.
4. A subject row claiming to be two kinds at once.
5. Evidence outliving the record it is evidence of.

## The enum had to be rebuilt, and that was found by deployment

The first draft applied cleanly to every database that exists and would have
failed on the first fresh deployment:

```
ERROR:  unsafe use of new value "proposal_version" of enum type evidence_subject
HINT:   New enum values must be committed before they can be used.
```

`db:migrate` wraps every migration in one transaction, deliberately, so a
failure anywhere rolls the whole deployment back. PostgreSQL refuses to *use* an
enum label added by `ALTER TYPE … ADD VALUE` in an uncommitted transaction — and
migration 0021 added `proposal_version` that way. The rule is per **label**, not
per type: a label from the original `CREATE TYPE` is safe in the same
transaction, one from a later ADD VALUE is not. Measuring that distinction is
what produced the fix rather than a workaround.

So migration 0102 rebuilds the type with all twelve labels from one
`CREATE TYPE`, converts the two columns that use it, drops the old type and
renames. That removes the ADD VALUE from the chain's effective history, so the
next phase that needs an enum label in an expression does not meet this at all.

**Caught by rebuilding the development database from the migrations, not by
running the tests.** Phase 179's lesson arriving through a different door: the
test database had the enum committed from a previous run, so every test passed.

## The party-merge tripwire, red for four phases

Registering `evidence_subjects.customer_id` made `tests/party-merge.test.ts`
fire, and it was already failing.

`asset_links` has had a composite `(company_id, customer_id) → customers` key
since **Phase 180** and was never added to `PARTY_REFERENCES`. Nobody ran that
file in Phases 180, 181, 182 or 183 — the last full-suite run was Phase 179's,
which predates the breakage. ADR 0178's prediction again: a scan that reads the
whole catalogue cannot be checked by running the tests near the code that
changed.

While it was red, the consequence was the one that module's own docstring
describes:

> A merge that repoints twenty-one of them leaves a document attached to a
> record the screens have hidden.

Merging two records of one business left the §8 collateral on the losing record,
so *"what have we sent this client"* answered wrong for the merged client.

The tripwire's catalogue query also could not read a composite key: it
`unnest`ed `conkey` alone, so `(company_id, customer_id)` arrived as two
references, one of them `company_id`, which is not a party reference and never
will be. Pairing `conkey` with `confkey` and keeping the column that points at
`customers.id` is the same question asked correctly.

## And the merge had never moved evidence at all

Worse than the four phases, and only visible once the conversion was done.

`document_links.subject_id` and `record_notes.subject_id` held a customer's uuid
with **no foreign key**, so they were invisible to the catalogue tripwire and to
`PARTY_REFERENCES`. **Every customer merge the application has ever performed
left the receipts and the notes on the losing record** — eighty-eight phases, as
long as the merge has existed — and no mechanism in the codebase could have
reported it, because every mechanism that answers "what refers to a customer"
reads the catalogue.

That is the clearest answer this programme has produced to *what is a missing
foreign key actually costing*. Not only the orphan: every tool that reads the
catalogue to find out what refers to what is blind to the reference, and the
tools are the point.

`ON UPDATE CASCADE` on the two link keys is what makes the fix small. In the
ordinary case the merge repoints **one** `evidence_subjects` row and the database
moves every link and every note with it, because the key they reference is
generated from the column that changed. `moveEvidence` exists for the collision —
both records carrying evidence — where the links and notes move by hand and the
loser's identity row is deleted *after* nothing references it. That order is
load-bearing: deleting it first would cascade the evidence away, which is this
phase's defect committed by the function fixing it.

`Reference.dedupeOn` is the third behaviour this register needed. `subcontractors`
collides and is **refused in words**, because that row carries insurance expiry
and licence numbers and choosing one to drop is choosing data to lose. An asset
link is an association and nothing else, so two identical ones collapse to one
and lose no fact. The distinction is in the type now rather than in a comment.

## What this does not do

**The drizzle schema does not mirror the two link keys.** `evidence_subjects`
imports `evidence.ts` for the enum, so declaring the reference on that side is a
circular import. The migration is the source of truth for DDL here either way;
what is lost is that a reader of `evidence.ts` alone does not see the reference,
and the test asserts it against the database's catalogue so the gap cannot
widen. Stated rather than quietly omitted.

**No screen deletes a financial account or a proposal.** The three latent
cascade paths are fixed and still latent. The fix is tested at the database
because there is no screen to test through.

**`document_links` keeps its `subject_type`/`subject_id` pair.** They are now a
real composite reference rather than a polymorphic one, but they are still a
pair rather than twelve columns — which is the whole point of the identity
table. A reader looking for "one column per kind" in those two tables will not
find it, and should not.

## Nominated for Phase 185

**§7's crop and mask on images.**

The five remaining ADR 0173 gaps are all §7's design engine, and this is the
one that is not Illustrator-class path editing. §7 defers *"advanced
Illustrator-class path editing"* and nothing else, and ADR 0182 already recorded
that reading it as deferring the whole of bullets 1 and 2 is the generous
reading. An image block places a whole asset; a capability statement with a
headshot that cannot be cropped to a square is the first thing anybody notices,
and Phase 183 just added a block whose headshots render at `object-fit: cover`
in CSS and not at all in the PDF — which is the same gap seen from the other
side.

Behind it: SVG import/export, artboard affordances, vector primitives, the
client-link comment thread, and moving the read and write scans into
`src/modules/source/` so the thirteenth pinned claim can stop being the
thirteenth pinned claim. That last one has now been nominated three times and
gone stale twice while unnominated work was done instead.
