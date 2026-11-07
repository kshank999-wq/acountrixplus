# 0197 — Three names for one thing

**Status:** accepted
**Date:** 2026-11-07
**Phase:** 197

---

## The nomination, and why its order was wrong

ADR 0196 nominated **the seven writes no scan can see** — raw SQL in the party
merge — and behind it the read census's reach. I measured both before building
either, and found something neither names, bigger than both.

So the order here is not the nomination's, and that is worth saying plainly
rather than quietly reordering: Phase 164's rule is that *a nomination
inherited is a nomination unmeasured*, and it cuts this way too. Measuring the
read census's reach turned up a defect that is not about reads, not about raw
SQL, and larger than the nine queries the nomination was about.

**The raw-SQL work is therefore still outstanding and still nominated.** It is
not done and this document does not pretend it is.

## What the measurement found

Both scans recognise a query by **three** separate names, and each one was
hiding some:

| the name | how it was recognised | what it hid |
| --- | --- | --- |
| the key's value | `input.x` or `xId` | **157 writes** (Phase 196) |
| the table | a name in the schema | **5 writes, 15 reads** |
| the key's predicate | `eq(…)` | **3 writes** |

`.from(invoices)` counted and `.from(table)` did not, because `table` is not in
the schema. So a query through a variable was not reported as unguarded — **it
was not a query**. And a `where` of `inArray(table.id, documentIds)` has no
`eq` in it, so a bulk write by a caller-supplied list of ids — the most aimable
shape there is — was not a keyed write.

Two of the variable-table writes are in `importing/reversal.ts`, which
**deletes** the rows an import created. The census had never looked at a
destructive generic helper.

### None of them was unguarded, measured before anything was widened

All twenty classify. `scoped(ctx, table, …)` or an explicit `companyId`
equality, in every case, including both of the reversal's deletes and all four
of the retention sweep's queries. The reading was done site by site rather than
inferred from a count, as in Phase 196, because that is the only order in which
the answer means anything.

### Why Phase 196 missed it

Phase 196 widened the key's *value* pattern and left the other two names alone,
and its own reach test shared both assumptions — it derived the expected set
using schema table names and `eq`. So the test written to be independent of the
scan was independent **along one axis**, and the two gaps behind the other two
axes were invisible to it exactly as the 157 had been invisible to the scan.

That is the finding worth keeping from this phase, and it is a finding about my
own work one phase earlier, not about the original scan: *an independent
derivation that shares one of the subject's assumptions is only independent
along one axis.* The reach test is broad on every axis now, and over-collects
on purpose.

## What changed

`declarationOf` in `source/enclosing.ts` resolves an identifier to the text
that declares it — a local `const`, a parameter annotation, one `type X = …`
alias hop, or a `for (const [table, …] of […])` whose iterated expression spans
lines. The scans read table names out of that text; the module stays
schema-agnostic, because it is shared by scans that each define "a table" their
own way.

`candidateTables` resolves a table expression to the company-scoped tables it
could be. A site counts if **any** candidate is scoped, because the scan cannot
know which branch runs and the guard has to hold for both, and is reported
under the candidates joined — one site, one entry, however many tables.

`inArray` joins `eq` in the key pattern, **on both sides and in the same
shape**, since the whole finding of 196 and 197 is that these patterns drift
when they are written twice.

| | 195 | 196 | 197 |
| --- | --- | --- | --- |
| writes in the census | 119 | 276 | **284** |
| reads in the census | 935 | 935 | **950** |
| unguarded | 0 | 0 | **0** |
| unresolved and declared | — | — | **2** |

No application code changed. Phase 196 had one line; this phase has none.

### The two it cannot resolve are declared, not skipped

`retention/sweep.ts` takes its table from `RETENTION_POLICIES` at runtime, and
no reading of the source resolves that. `scanUnresolvedTables()` names those
two sites and a test pins the count at exactly two, so a third means somebody
added a runtime-chosen table and has to either declare it or make it
resolvable.

Phase 139's device, and the alternative was the thing this phase is about: a
scan that skips what it cannot parse and reports a number that looks complete.

### A register that double-counted itself

The first version of the unresolved list was an array at module scope, pushed
to from inside the resolver. Calling `scanReads()` and `scanWrites()` in one
process reported every site twice — ten entries for five sites — and I saw it
only because the numbers did not divide.

It is a pure function with its own pass now, and a test calls both scans and
asserts the answer does not move. A register whose value depends on what ran
before it is worse than one that misses something, and this repository's entire
argument for these registers is that their numbers can be trusted.

### The unit test that paid for itself immediately

`declarationOf` had an off-by-a-prefix bug: for the `for … of` case it measured
the iterated expression's length from the expression and added it to the
*declaration's* start, so the slice stopped short. **The whole-tree scan passed
anyway** — the truncated text still reached `invoices`, and one candidate table
is enough for a site to count — so the two reversal deletes were in the census
for the wrong reason and nothing would have said so.

The synthetic unit test caught it on the first run. Worth recording because the
temptation in a phase like this is to test the primitive by what the scan does
with it, and this is the second time in two phases that a hand-made case found
what the real tree could not: Phase 196's comment tripwire is synthetic for the
same reason.

## What this does not do

**It does not fold raw SQL into the census.** The nomination's first item, still
outstanding: seven writes and two reads in `src/modules/parties/service.ts`,
covered by a test of their own since Phase 196 and not by the denominator §19
quotes. Two syntax widenings in one phase is already at the limit ADR 0196 set
for itself.

**It does not count joins from an unscoped primary.** Measured: four, three of
them `from(companies).leftJoin(companyProfiles)` reading a company's own
profile under `eq(companies.id, ctx.companyId)`, and one the session
resolution, which cannot have an actor because it is what *makes* one. All
guarded, none counted, and `join-inherited` is the word for them.

**It does not resolve a declaration that spans lines**, except the `for … of`
case that needed it. A multi-line `const` would resolve to its first line,
which yields fewer candidate tables rather than wrong ones — and a site with no
candidates goes to the unresolved register, where it is visible.

**It does not re-measure §20.** Still the last unmeasured sentence in the
audit, and now three phases deep in a queue.

## Nominated for Phase 198

**Raw SQL in the census — the nomination this phase displaced.**

Seven writes and two reads in the party merge, through
`tx.execute(sql\`update ${sql.raw(table)} …\`)` because the table comes from
`PARTY_REFERENCES` at runtime. They are asserted to carry a `company_id`
predicate and they are not in the denominator, so §19's number is still
understating itself by nine — a smaller lie than 157 and the same kind.

The extraction exists (`templateLiteralAt`, Phase 196) and the guard vocabulary
needs one word: a tenant filter written in SQL is an explicit company equality,
which `explicit-company` already means. What needs deciding is what the `table`
column says for a statement whose table is `${sql.raw(ref.table)}` — the
unresolved register is one answer and `PARTY_REFERENCES` is a better one, since
that registry knows every table it can name.

Behind that, in order: the four joins from an unscoped primary, and §20's
*"Phases 0–8 all have shipped work"*.
