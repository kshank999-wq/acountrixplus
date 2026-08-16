# ADR 0020 — One file, stored once, reachable only through a record

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §13 ("period close/lock controls, audit trail, accountant
  notes, attachments, exports"), §18 ("object storage for receipts, proposal
  assets, PDFs, and marketing media"), §19 (tenant isolation at every query and
  storage boundary)
- **Builds on:** [ADR 0001](0001-modular-monolith-and-tenancy.md),
  [ADR 0004](0004-document-engine-and-brand.md),
  [ADR 0008](0008-offline-first-and-replay-safety.md)

## Context

§13's list of what a professional accounting workspace needs ends: *"period
close/lock controls, audit trail, accountant notes, attachments, exports."*
Four of those five have existed since Phase 12. The two that did not are
attachments and accountant notes, and they turn out to be one problem: a thing
that hangs off *any* accounting record and belongs to whoever may read that
record.

Before this phase, exactly one kind of record could carry evidence — a bank
transaction, through a `jsonb` array written in Phase 8 for the mobile app.
That was the right size then and wrong in three ways by now:

- **The wrong record.** A supplier invoice is evidence for the *bill*, not for
  the payment that happened to clear it three weeks later.
- **The wrong shape.** An array on a row cannot be queried, so "which of these
  has no paperwork?" — the question the attachments line exists to answer at
  year end — had no answer.
- **The wrong storage.** Phase 4's `AssetStore` keyed bytes as
  `companyId/digest-randomSuffix`, so the same PDF uploaded twice was stored
  twice. Invisible for logos. The whole storage bill for scanned evidence.

Two claims, and `tests/evidence.test.ts` asserts both:

1. **The same bytes are stored once, and removing one reference never breaks
   another.**
2. **A document is reachable only through a record you may read.**

## Part one: the bytes

### Decision 1: content addressing, and the sharp edge it creates

The storage key is the SHA-256 of the content. One supplier invoice attached to
the bill, the payment and the month's journal entry is one blob.

This has a consequence that has to be stated rather than buried: **the object
store is not partitioned by tenant.** Two companies holding byte-identical
files share a blob. That is safe here for one reason only — nothing is ever
reachable *through* the store. Every read begins at a `documents` row found
under a tenant filter, and `readDocument` is the sole caller of
`getObjectStore().get()` anywhere in the codebase. A route that accepted a
digest and fetched bytes would be a cross-tenant read.

The digest is 256 bits and therefore not guessable, but it is not treated as a
secret and the authorization is not "you knew the hash". It is the `documents`
row. A test asserts that knowing another company's document id gets you
nothing.

### Decision 2: three levels, and the separation is the design

**bytes** (shared, reference-counted) → **document** (one company's claim on
them, with its own filename) → **link** (that document on one record).

The filename lives on the document rather than the blob because two companies
can hold identical bytes under different names, and renaming must not touch
anybody else's. Deleting a document removes all of its links and only then
considers freeing the bytes.

### Decision 3: the rows decide what gets deleted, not the count

`document_blobs.reference_count` exists and is *not* what the delete path
consults. The first version trusted it, and the foreign key from
`documents.digest` caught it during the very test written to prove the sweep
worked.

The reasoning is worth keeping: a cached number that has drifted upwards leaks
storage for ever, and one that has drifted downwards deletes somebody's
evidence. The rows cannot drift. So `freeBlobIfUnused` asks `documents`
directly — indexed on `digest` for exactly this — the count survives because
"held by how many companies" is worth reporting, and the foreign key sits
underneath both as a third line of defence.

### Decision 4: bytes are freed after the transaction, never inside it

No object store can join a Postgres transaction; S3 certainly cannot. Freeing
bytes inside one means a rollback restores the row and leaves the file gone —
a broken link in somebody's evidence, with nothing to notice it.

So the row work commits, and the bytes are freed afterwards. The failure mode
of *that* order is boring: a process that dies in between leaves a blob nobody
points at, which costs storage and is collected by `sweepOrphanedBlobs`. The
failure mode of the other order is unrecoverable. Where the two orders are not
symmetric, take the recoverable one.

### Decision 5: a second adapter, because a seam with one implementation is a claim

`FilesystemObjectStore` exists alongside the Postgres one and is exercised by
the same tests. It also demonstrates the property the interface depends on:
`put` for a digest already present is a no-op, so a retry after a half-finished
upload costs nothing. Writes go to a temporary name and are renamed into place,
because a reader that finds a half-written file gets a corrupt receipt under a
correct-looking name.

Reads name their own store, from the blob row, so changing `OBJECT_STORE` does
not orphan everything uploaded before the change.

## Part two: what a document may hang on

### Decision 6: a registry, not a switch statement in each caller

A polymorphic reference has no foreign key, so nothing in the database stops a
link pointing at another company's uuid, or at nothing. The check must live in
code — and if it lives in the *caller*, every new screen that attaches a file is
a fresh chance to forget it.

`src/modules/evidence/subjects.ts` is one table saying, per kind: which table
proves the record exists, which permission is needed to see its evidence, and
which to change it. Attaching, detaching, reading and noting all go through it.
Adding a twelfth kind means adding a row there, and the schema enum will not
compile without it.

### Decision 7: seeing and changing are different permissions

A read-only auditor may see the receipt on a transaction and may not remove it.
A bookkeeper may attach a receipt to a bank transaction and has no business
near a payroll run, where the evidence is what individual people are paid. One
permission per kind would have forced the wrong answer in one direction or the
other; two columns cost nothing and both tests pass.

### Decision 8: the mobile receipt path became a front, not a fork

Phase 8's `uploadReceipt` / `attachReceipt` / `receiptsFor` survive as a thin
layer over the evidence service. What survives is the part that was genuinely
about phones — a 2 MB ceiling against the desk's 10 MB, a narrower list of
accepted types, and the split between uploading and attaching, because on a
phone those happen at different moments.

The 2 MB limit is kept deliberately: the desk limit protects the server, and
the phone limit protects somebody's data allowance. They are different numbers
because they answer different questions.

Idempotency moved from a read-then-write into a unique index on
`document_links`, which is stronger than what it replaced: two deliveries of
one queued action leave one link even if the client lost its idempotency key.

### Decision 9: the old column was dropped, and the data moved with it

The migration backfills every `jsonb` attachment into blobs, documents and
links — keeping each document's id equal to the old asset's id, so a phone
holding a queued `receipt.attach` from before the deploy still resolves it —
and then drops the column. Leaving a `jsonb` array that nothing writes is the
"two answers to one question" problem this codebase keeps refusing elsewhere:
eventually something reads the wrong one.

The links are resolved through the **digest**, not through `document.id = asset
id`, and the difference is not cosmetic. A company that uploaded the same
receipt twice has two assets and — correctly — one document, so matching on the
id alone silently drops the attachment belonging to whichever asset lost the
de-duplication. The first version of this migration did exactly that. It was
found by building a database at the Phase 19 schema, seeding it with two
byte-identical assets on two different transactions, and running the migration:
three attachments in, two links out. It now produces three, and the same
exercise caught a second defect — `SELECT DISTINCT` resolves a bare
`'bank_transaction'` literal to `text` before the target enum can be inferred,
so the insert needs an explicit cast.

## Part three: accountant notes

### Decision 10: a note is not an audit event

The audit log records what the software did: who changed what, when, from what
to what. It is complete, it is not editable, and it answers no question
beginning with *why*. A note records what a person concluded — "supplier
confirms this is a deposit, not a prepayment" — which is what a reviewer reads
first at year end, months after the person who knew has moved on.

Notes are never edited and never deleted. A note that can be quietly rewritten
is not evidence of anything.

### Decision 11: a question is a different thing from a remark

"What is this?" left on forty transactions is a work list; a remark is not. The
distinction earns its column because a work list nobody can filter for is forty
questions nobody answers — and it is exactly the list an accountant hands back
to a client, which is what practice mode exists for.

A CHECK constraint refuses to resolve a remark, so no path can quietly hide a
statement from a list it was never on. Answering adds a note beside the
question rather than overwriting it: the question is half of what makes the
exchange worth keeping.

`openQuestions` filters kind by kind rather than gating once, so somebody
without `payroll:view` does not learn what was asked about the payroll run.

## Consequences

- **Bytes are shared across tenants.** Two companies with the same file share a
  blob, so storage cost is not attributable per company, and a deployment that
  wants physical separation between tenants cannot have it with this store. The
  tenancy guarantee is at the `documents` row and nowhere else.
- **`sweepOrphanedBlobs` is not scheduled.** It exists, it is safe to run at any
  time, and the Phase 10 queue is right there. Nothing calls it — the same gap
  `login_attempts` and `action_tokens` have.
- **No virus scanning.** Files are accepted, stored and served back to browsers
  with `nosniff` and a restrictive CSP, which stops a text file becoming a
  script and does nothing about a malicious PDF.
- **No thumbnails or previews.** A receipt is a link that opens in a new tab.
  On a phone that is worse than an inline image, which is what the mobile
  screen deserves and does not have.
- **No full-text search inside documents.** The filter is on filenames. "Find
  the invoice with 88412 on it" needs OCR and an index, and has neither.
- **The panel is wired into fixed assets only.** The registry knows eleven kinds
  of record and the component is generic, but only the asset register renders
  it so far; bills, invoices and journal entries can carry evidence through the
  service and have no control that does it.
- **Deleting a document is silent about its links.** The button says how many
  records it will strip it from and then does it. There is no undo, and no
  interstitial for a file used on ten records.
- **Server-side PDF generation is still absent** (§18), so nothing in this
  phase *produces* a PDF; it only stores what somebody else made.
- **The backfill has been exercised, but only against a database this session
  built.** It was run at the Phase 19 schema with the duplicate-bytes case
  seeded by hand, and it is not covered by the automated suite — the suite
  starts from a schema where the old column no longer exists, so there is
  nothing for it to migrate.
- **The filesystem adapter is untested against a real deployment.** It works and
  is covered by tests; nothing has run it under concurrent writers on a network
  filesystem, where the rename-into-place assumption needs re-examining.

## Follow-up

1. **Schedule the sweep** on the Phase 10 queue, alongside the two other
   retention jobs already owed.
2. **Render the panel** on bills, invoices, journal entries and reconciliations
   — the service already allows it and only the screens are missing.
3. **An S3 adapter**, which is the reason the interface has three methods and
   the reason reads name their own store.
4. **Inline previews** for images and PDFs, first on the mobile review deck.
5. **"Show me everything with no receipt"** as a report, using `withoutEvidence`
   — the query exists and no screen calls it.
6. **Virus scanning** before a stored file is ever served back.
