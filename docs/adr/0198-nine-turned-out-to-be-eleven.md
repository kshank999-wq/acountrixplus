# 0198 — Nine turned out to be eleven

**Status:** accepted
**Date:** 2026-11-08
**Phase:** 198

---

## The nomination, done this time

ADR 0196 nominated raw SQL into the census and ADR 0197 displaced it for
something larger. This phase does it, and the first thing the measurement said
is that the nomination's own number was wrong.

> **nine** — seven writes and two reads in the party merge

Measured: **eleven**. Four selects, four updates, three deletes.

The nomination inherited its count from Phase 196, which had scanned raw
**writes** and asserted that each carried a tenant predicate. Nobody had
counted the raw selects, so the two it knew about were the two that happened to
name a table literally; the other two name theirs through `sql.raw` and were
invisible to the same pattern that found the writes.

Phase 164's rule, a fourth time in five phases: *a nomination inherited is a
nomination unmeasured* — including the numbers in it.

## The one that had no tenant predicate

`mergeParties` counts, before merging, how many rows of an exclusive table
already point at either record:

```ts
sql`select count(*)::int as n from ${sql.raw(`"${ref.table}"`)}
    where ${sql.raw(`"${ref.column}"`)} in (${winner.id}, ${loser.id})`
```

No `company_id`. Its sibling nine lines away in `mergePreview` has had
`and "company_id" = ${ctx.companyId}` all along.

**It was not a disclosure, and the reason matters more than the clause.**
`subcontractors.vendor_id` is a foreign key to `vendors.id`, so a row of
another company cannot name this company's vendor — that is exactly the
cross-tenant reference Phases 170–172 made the database refuse. The count was
right. It was right **because of a property of the data rather than because of
anything in the statement**, which is the kind of correctness this repository
keeps finding it cannot check.

So the clause is **defence in depth, not a repair**, and this document says so
rather than claiming a hole was closed.

### The test I wrote for it, and deleted

A second database test was written to prove the predicate mattered: another
company's subcontractor row, then a merge, then an assertion that the count was
unaffected. **It passed without the predicate**, because the foreign key makes
the bad row unconstructable — so it asserted something already true and was
deleted under Phase 121's rule.

No behavioural test can tell the two versions of that statement apart. The
check that can is the census, which reads the predicate out of the text:
removing the clause makes `scanRawQueries` report the statement as unguarded,
and that is verified rather than asserted.

What *is* worth a behavioural test is the collision query itself, which had
none — the pure core was covered by passing `collisions: ['subcontractors']`
in, so the query that produces that list was exercised by nothing. That is why
the missing predicate survived, and it is now driven in both directions.

## What changed

`scanRawQueries()` finds every `sql` template whose first word is a query,
takes the whole literal with `templateLiteralAt` (Phase 196), and classifies it
by the predicate in the text. Its results are appended to `scanReads()` and
`scanWrites()`, so §19 quotes **one denominator** instead of a number plus a
test somebody has to remember to add up.

The guard vocabulary needed **no new word**. A tenant filter written out in SQL
*is* an equality on the company column, which is what `explicit-company`
already means — and that is the argument for folding these in rather than
registering them beside the census.

| | 195 | 196 | 197 | 198 |
| --- | --- | --- | --- | --- |
| writes | 119 | 276 | 284 | **291** |
| reads | 935 | 935 | 950 | **954** |
| unguarded | 0 | 0 | 0 | **0** |

### The table, when the statement does not say

`isolation-scan` deliberately does **not** import `PARTY_REFERENCES` to resolve
`${sql.raw(ref.table)}`. A scan that knows about one domain module will be
wrong about the next one, and the nomination's suggestion to reach for that
registry is the one part of it this phase declines.

Such a statement is reported as `(dynamic)` and **counted**: it might reach a
company-scoped table, so it has to be guarded. Four of the eleven are dynamic
and all four classify.

Inserts are excluded, as builder inserts are — an insert has no `where` to
guard, and what goes wrong with one is a wrong `company_id` *value*, which is a
different check. There are none today either way.

## Four phases on one mechanism, and what they add up to

| phase | what the census recognised a query by | missed |
| --- | --- | --- |
| 196 | the key's value | 157 writes |
| 197 | the table's name | 5 writes, 15 reads |
| 197 | the key's predicate | 3 writes |
| 198 | being a builder call at all | 11 queries |

Every one of the 191 was already guarded. Not one was a disclosure, and the
§19 claim never had to be withdrawn — what had to be withdrawn, four times, was
the **denominator**, which had been quoted as though it were a total.

The through-line is one sentence: **a scan recognises a query by a name, and
every name it uses is a place something can hide.** The method that found all
four is the same — build the expected set from the schema and the source,
independently of the scan's own vocabulary, and compare — and Phase 197 added
the refinement that an independent derivation sharing one of the subject's
assumptions is only independent along one axis.

## What this does not do

**It does not count the four joins from an unscoped primary.** Still measured
and still outstanding: three `from(companies).leftJoin(companyProfiles)` under
`eq(companies.id, ctx.companyId)`, and the session resolution, which cannot
have an actor because it is what *makes* one. All guarded, none counted, and
`join-inherited` is the word for them. Next.

**It does not check what a raw statement's `where` is keyed by.** The builder
census narrows writes to the ones that can be *aimed*; the raw pass counts all
of them and asks only for a tenant predicate. That is stricter rather than
looser, so it understates nothing — but it means the two halves of the census
narrow differently, which is worth knowing before somebody compares them.

**It does not re-measure §20.** Four phases in the queue now, which is long
enough to say plainly: it is being deferred, not forgotten.

## Nominated for Phase 199

**§20's *"Phases 0–8 all have shipped work"*, measured.**

It is the last unmeasured sentence in `docs/SPEC-AUDIT.md`, it has been behind
something else in four consecutive nominations, and the something else has run
out: the census's reach is now measured along every axis I can name, and what
is left of it — four guarded joins — is a smaller finding than any of the four
above.

The sentence is also the one most likely to be wrong in an interesting way.
Phases 0–8 are the spec's own plan, written before any of this existed, and
"has shipped work" is the kind of claim that is true of the phases somebody
remembers and unexamined for the rest. The method is the one that worked here:
build the expected set from §20 itself, bullet by bullet, and compare against
the tree rather than against the audit's summary of it.

Behind that: the four joins, and the asymmetry between the raw pass and the
builder pass in how each narrows.
