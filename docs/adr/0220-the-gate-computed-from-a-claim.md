# ADR 0220 — The gate computed from a claim

**Status:** accepted · **Phase:** 220 · **Spec:** §14

## The nomination, and the end it was asked from

ADR 0219 nominated **the option that changes the answer**: across the 329 acts,
how many take an argument that selects between gates — `createInvoice`, an import
`kind`, a document `kind`, a party `side` — and *"for how many of those does the
screen let one person choose an option the gate will refuse them?"*

Measured, the second half is the wrong question. A screen offering an option its
own user will be refused is a bad screen, and it is already a bounded problem:
the act refuses, and Phase 47 requires the refusal to name something actionable.
Nobody's books are wrong afterwards.

The dangerous shape is the mirror image — an argument the gate **believes**:

```ts
requirePermission(ctx, input.side === 'customer' ? 'crm:manage' : 'accounting:journal')
```

`sales` holds `crm:manage` and not `accounting:journal`. If `side` could say
`customer` while `winnerId` and `loserId` named two suppliers, a salesperson
would merge two payables records. Nothing in the check prevents that. What
prevents it is nine lines down:

```ts
const table = input.side === 'customer' ? customers : vendors
```

**The same argument picks the record.** A caller who lies about the side does not
get the wrong gate; they get a record that does not exist. That is a constraint
rather than a check (Phase 116) — there is no step anybody could forget, because
the lie removes the thing being acted on.

So the property this phase measures is:

> When a gate is computed from a caller-supplied value, that value must also
> select the record the act touches.

## What the tree computes its gates from

**29** sites compute a permission rather than naming one, across **17** distinct
expressions. By where the value comes from:

| | |
|---|---|
| **claim** — a parameter, whatever the caller said | **17** |
| **record** — read from the database inside the act | 9 |
| **laundered** — a local that a parameter fed | 2 |
| **register** — a module-level constant | 1 |
| **unresolved** | 0 |

The first row inverts the nomination. ADR 0219 wrote that *"a gate computed from
the record is a fact; a gate computed from a checkbox is a question the screen
asked and did not check the answer to"* — framing the record as the ordinary case
and the argument as the exception. It is the other way round: the **majority** of
computed gates read whatever the caller said.

And all 17 satisfy the property. `detachDocument` passes by naming
`input.subjectType` in its `where`; `writeNote` passes by handing the same ref to
`requireSubject`, which looks the id up in *that type's own table* and throws
`NoSuchSubjectError` if it is not there; `linkAsset` passes because
`subjectAssignment` writes the column belonging to the claimed kind and each
column carries its own foreign key, so a kind that does not match its id is
refused by the database.

**Zero defects.** That is the second phase running to measure zero, and it is the
reason this is a scan with a falsifier rather than a repair. An invariant holding
by accident at 17 sites is one careless 18th from not holding, and nothing before
this phase would have said so.

## Why no register of the 17

ADR 0219 refused a register of 236 entries because 230 would have said the same
thing. The same objection applies here: twelve of these seventeen would read
*"the where clause names it"*. Phase 101's device requires an entry to argue for
itself, so the seventeen are checked by the property and `OPAQUE_GATES` holds
only the two sites the property **cannot judge** — where the value reaches the
gate through a local, so the path the gate names is not the path the record
selection names, and searching for either would be a coincidence either way.

`linkAsset` is the case that makes the distinction necessary. Its gate is
`subject.manage`, from `const subject = assetSubjectFor(input.subject.kind)`, and
`subject` is named three more times in the function — once on `subject.label`,
inside a refusal message. A count of later uses would have called that "the value
selects the record" when what it selects is a noun in a sentence. So a laundered
claim is reported until it is argued for, and the two entries say how the claim
is tied to the record rather than that it is.

## The defect in the reader

`declarationOf` could not read this repository's standard way to load one row:

```ts
const [document] = await db.select({ kind: designDocuments.kind }).from(designDocuments)
requirePermission(ctx, permissionFor(document.kind, 'manage'))
```

Its local arm wants the identifier immediately after `const`, and here a `[` is
in the way, so the answer for `document` was `''` — *nothing declares it*. The
scan reads that as **unresolved** and says so, which is the only reason it was
found rather than believed: four computed gates that read a tenant-scoped record
came back indistinguishable from four that read a value out of nowhere. The gates
were right; the reader was blind. `suggestLayout`, `applyLayoutSuggestion`,
`resolveNote` and `revertImport` were the four, and `revertImport` chooses
between `bookkeeping:import` and `accounting:journal` on what it found.

This is ADR 0134's leak a third time, and in the same helper as the second: the
arm immediately below already knows that `for (const [table] of …)` destructures,
and the whole note on it is that recognising one shape of destructuring is not
recognising destructuring. Both bracket forms are read now.

## Four scan errors, all mine, none found by the property passing

Phase 218 reported nine defects and eight were the scan's own. The habit that
caught them — check a finding against the code; never trust a property that
agrees — caught four more here.

1. **The argument matched with `[^)]*`** and a hand-rolled nesting alternative
   truncated `permissionFor(document.kind, 'manage')` at its inner quote. 26 of
   30 sites reported their root identifier as `permissionFor`: the resolver's own
   *name* rather than the value it reads. The expression is taken by balancing
   parentheses now.

2. **A `withoutStrings` that shortened the text.** The obvious spelling,
   `replace(/'[^']*'/g, "''")`, is wrong in a way that is invisible until it is
   catastrophic: every offset after the first string points somewhere else. The
   scan matched calls in the blanked copy and sliced them out of the original,
   and reported whole function bodies as gate expressions — **162 sites where
   there are 29**. The counts were not slightly wrong; they were measuring a
   different file. It lives in `enclosing.ts` beside `withoutComments`, which has
   said "preserving every byte offset" in its first line since Phase 202.

3. **`elsewhere` counted the signature.** `enclosingSpan` begins at the
   declaration, so the parameter list was inside the text searched for the record
   selection. For a claim read through a property that is harmless —
   `input.subjectType` does not occur in `input: WriteNoteInput`. For a claim
   named directly it is not: `kind` occurred once more, in `kind: string`, and
   the property passed on the parameter's own declaration. **Caught by the
   falsifier and not by the tree** — the synthetic act that gates on `kind` and
   then ignores it was reported as clean. Four real sites were being counted that
   way; all four pass on their remaining uses, so the tree was right and the
   measurement was not.

4. **A register whose entries excused nothing.** Its first draft held three, and
   two of them named sites the scan never reported: `assemble`, because `can`
   sits inside `mayRead = (key: string) => …` and `parameterNames` answers for
   the declared function, so `key` was invisible and `section` read as a
   constant; and `openQuestions`, which is an iteration over `EVIDENCE_SUBJECTS`
   and never a claim at all. Both would have sat in the register reading like
   reasons somebody had checked. `staleOpaqueGates` now asks the strict version —
   not *does the site still exist* but **would the falsifier report it without
   this entry** — and shares one definition with the falsifier so the two cannot
   drift.

The third of those is the one worth keeping. `parametersInScope` counts an
arrow's parameters as well as the function's, because a check's classification
should not depend on where the author put a brace, and over-reading is the safe
direction (Phase 126): a name wrongly called a claim gets checked, and a claim
wrongly called a constant does not.

## What this leaves

`OPAQUE_GATES` is the eleventh throwing registry (49 → 50 in
`tests/registry-error.test.ts`). 27 tests in
`tests/the-gate-computed-from-a-claim.test.ts`, of which eight drive the scan on
source written to be wrong, because a scan whose only input is a tree it agrees
with has never been watched fail (Phase 121).

## Nominated for Phase 221

**The parameter a closure hides.** `parametersInScope` exists because
`parameterNames(src, symbol)` answers for the declared function and a check is
often not written there — `exporter/package.ts` decides a section's permission
inside `mayRead = (key: string) => …`, and `key` was invisible. That helper is
shared: `gate-forms.ts`, `action-gates.ts`, `column-writers.ts` and
`isolation-scan.ts` all ask it, and all four draw conclusions about what a
function does with its arguments. The measurement nobody has done: how many of
those scans' sites sit inside a closure, and for how many does attributing the
closure's parameters to the enclosing function change the answer? Phase 218's
`forwarded` classification turns on exactly this question, and it was measured
once, for one population, before `parametersInScope` existed.

Behind that, unchanged: the twelve findings still in the column register; the CRM
account panel's missing payables side (ADR 0208); the four joins from an unscoped
primary (ADR 0198); and §11's six remaining functions.

## Measured in production, and deferred by choice

Not part of this phase, and recorded because it is measured rather than suspected.
The deployed worker has not drained its queue since 2026-11-07. Vercel's cron
fires `/api/cron/worker` every five minutes and **every** invocation ends in
`Vercel Runtime Timeout Error: Task timed out after 60 seconds`; no application
error is logged. From `pg_stat_statements`, 24,481 ticks reached
`ensureSchedules`' two queries and 11,508 issued the next one, so about 53% stop
inside that function after the database has answered. The ones that get past it
finish: `claimJobs`, the outbox read and the heartbeat write all stand at 11,508,
which is why no job is ever stranded in `running`. No query of ours is slow — the
worst mean is 0.7ms. Arrivals run near 20 jobs a day against about 10 completions,
leaving 1,289 dead, 184 retrying and 206 queued that have **never been claimed**,
some since 2026-11-07. `ops.failure_digest` — the job whose purpose is to report
failing jobs — is itself among the dead.

The 68-migration repair of Phase 219 did fix what it should have: the two
integrity checks that had thrown nightly since 2026-08-29 now run, and the runs
of 2026-11-19 report `checks_run 10, faults 0, errors 0` — the first clean
integrity run this database has produced. The books have never once disagreed
with themselves. What stopped was the thing that asks them.
