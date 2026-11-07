# 0196 — What a scan cannot see

**Status:** accepted
**Date:** 2026-11-07
**Phase:** 196

---

## The nomination, and the questions it set

ADR 0195 nominated **the source scans as a set**, on the grounds that two of
them had just reported holes in themselves and both were found the same way —
by a change moving a count the wrong amount, never by anybody reading the scan.
It named the write census as the cheapest honest start and set the questions in
order:

> how many writes are invisible to it today, are any of them unguarded, and
> does the same gap exist on the read side. The first is a regex; **the second
> is the only one that matters**.

All three are answered below, and the order was the right one: the first number
is alarming and the second is what decides whether it was a disclosure or a
measurement defect.

## How many: 157, against 119 counted

`scanWrites` recognised a key only as `input.something` or a name ending in
`Id`:

```
eq\(\s*\w+\.\w+\s*,\s*(input\.\w+|\w+Id)\s*\)
```

So `eq(proposals.id, proposal.id)`, `eq(financialAccounts.id, id)` and
`eq(chartAccounts.id, placeholder)` matched nothing. Those writes were **not
reported as unguarded** — a reader would have noticed that. They were absent
from the census, which is the failure mode with no symptom.

| | |
| --- | --- |
| writes the census counted | 119 |
| writes it could not see | 157 |
| **share of keyed writes it reported** | **43%** |

And the sentence built on it, in `isolation.ts`, reads as a total: *"570 of the
935 reads, against 29 of the 119 writes."* So did §19's *"strong tenant
isolation"* paragraph, which is the one somebody quotes into a security
questionnaire.

## Whether any was unguarded: none, and that was measured first

This is the part that had to be done before the scan was touched, because a
widened scan that comes out green proves nothing about the window in which it
was narrow.

All 157 classify under the existing write vocabulary. Six came out with no
guard, and those six were **read one at a time rather than counted**:

| | why it is sound |
| --- | --- |
| `mintChartAccount` | `placeholder` comes from `unusedPlaceholder`, which filters on `ctx.companyId` |
| `runDueSchedules` | `current` is a row from a `scoped()` select |
| `runOneOccurrence` | takes the whole row, and its only caller passes that same row |
| `runDueRecurringEntries` ×2 | `current` is a row from a `scoped()` select |
| `revokeAllOtherDevices` | `others` is filtered on `eq(devices.userId, ctx.userId)` |

Every one is an id taken from a row the function had already fetched under a
tenant or actor scope. **That guard has a name and the write classifier could
not say it.** `id-from-fetched-row` has existed since Phase 150, is what eight
reads stand on — and its own prose reads:

> this is the difference between a parameter and a property that makes the whole
> narrowing of **both scans** possible.

Declared `appliesTo: 'read'`. The registry-with-prose device failing in the
direction it is worst at: the prose was right, the field was wrong, and nothing
compared them.

## Whether the read side has it too: no, and the reason is the finding

`scanReads` matches every `.from(` on a company-scoped table and **never
filters by key at all**. Its denominator was always every read, so no drift in
a key pattern could have removed a read from it.

Which locates the defect precisely. It is not that somebody wrote a bad regex;
it is that **two copies of one idea drifted, and the narrower copy was the one
guarding writes.** `enclosing.ts` exists because two copies of "readable
source" had drifted and one was wrong; Phase 195 found a third in
`money-on-screen`; this is the fourth, in the pair whose asymmetry a whole
module is named for.

## What changed

The key pattern is the read side's, and the write classifier gained the
detector that can return the kind it already declared — computed the same way
`scanReads` computes it, with the same prefix list, because
`input.practiceId` is a bare argument wearing a dot and `proposal.id` is not.

`id-from-fetched-row` is `appliesTo: 'both'` now, which is what its own
sentence had been claiming.

**No application code was added**, with one exception. The widened census
reported exactly one write it could not justify: `mintChartAccount` took its id
from a company-filtered helper three lines above rather than from its own
statement. It got a `scoped()` rather than a guard entry, because the ordering
in `guardFor` exists to prefer the guard that cannot be separated from the
write — and until this phase that write's safety rested on `unusedPlaceholder`
keeping a filter nothing required it to keep.

| | before | after |
| --- | --- | --- |
| writes in the census | 119 | **276** |
| `scoped-write` | 29 | 48 |
| `explicit-company` | 69 | 187 |
| `id-from-fetched-row` | — | 8 |
| guard kinds in use | 8 | 9 |
| **unguarded** | 0 of 119 | **0 of 276** |

The honest reading is not that this codebase got safer. It is that 157 writes
which were always guarded can now be *seen* to be, and the claim §19 makes is
now about 276 writes instead of 119.

## Reach, not counts, is what the test asserts

`isolation-guards.test.ts` and `isolation-reads.test.ts` carry the counts and
`PINNED_CLAIMS` carries the sentences built on them. What
`tests/what-a-scan-cannot-see.test.ts` asserts is that **no keyed write and no
read on a scoped table can be in the tree and outside the census**, derived
from the schema and the source rather than from the scan's own pattern.

That distinction is the phase. A count is a fact about today, and every count
here was right — the defect was in the denominator, and a test written in the
scan's own vocabulary would have passed in every phase from 149 to 195. Checked
against the old pattern rather than assumed: narrowing it back fails three of
these seven assertions and names all 138 sites.

## Two sentences that had already gone stale

`PINNED_CLAIMS` pinned the isolation counts in `isolation.ts` and left the same
numbers unpinned in the two documents a person actually reads. Measured this
phase, both had drifted: `docs/SPEC-AUDIT.md` said **111 writes and 911 reads**
and `docs/RUNBOOK-FIRST-COMPANY.md` said **111 writes and 883 reads**, against
a measured 276 and 935 — the writes stale by four phases, the reads by two,
while the pinned copy stayed right the whole time.

That is what pinning one sentence of three gets you, and Phase 179 built this
register for exactly this sentence shape. Both are pinned now, which takes
`PINNED_CLAIMS` from **15 → 17**.

## What this does not do

**It does not audit the other scans.** The nomination asked for the set and
this phase did one, plus the two documents. `money-division`,
`money-addition`, `comparable-sums`, `public-writes`, `client-bundle` and the
rest each have a reach question of their own, and the one below is the next.

**It does not widen the write census to unkeyed writes.** A write whose `where`
is a business predicate — **seven** of them, measured — cannot be aimed at a
chosen row, and the census is about the shape that can. That narrowing is
stated and deliberate, unlike the one this phase removed.

**It does not add `established-above` to the write side.** The read classifier
accepts "a `companyId` or `scoped(` appears anywhere above" and the write
classifier does not, which is the right asymmetry: it would have excused
`mintChartAccount` instead of fixing it, and a write is the thing you cannot
take back.

**It does not look at raw SQL**, and I nearly wrote *"measured as none today"*
here without measuring it. There are **seven**, all in
`src/modules/parties/service.ts`: the party merge repoints records from a loser
to a winner across dynamically-named tables, so it is `tx.execute(sql\`update
${sql.raw(table)} …\`)` rather than a builder call, and no builder-based scan
can see it.

All seven carry `"company_id" = ${ctx.companyId}` — read individually, not
inferred — so none is a disclosure. Nothing checked that, which is the same
sentence as the 157 one syntax over, so it is checked now: the count is pinned
at seven, every one is required to carry the predicate, and an eighth anywhere
fails the test. Cheap, and leaving a write path I had already read unchecked
for a phase would have been the worse kind of tidiness.

Not folded into `scanWrites` itself, which is the part that waits: the census
counts builder calls and its guard vocabulary is about builder evidence, and
making it bilingual is a second change to what it recognises in the phase that
widened it.

## Nominated for Phase 197

**The seven writes no scan can see, and then the read census's reach.**

The party merge writes through `tx.execute(sql\`update ${sql.raw(table)} …\`)`
because the table is chosen at runtime from `PARTY_REFERENCES`. That is a
legitimate reason to leave the builder and it puts seven writes — on
`document_links`, `record_notes`, `evidence_subjects` and whatever
`PARTY_REFERENCES` names — outside every scan this repository has.

They are filtered, and that is now asserted rather than read — but asserted
*beside* the census rather than in it. The remaining work is to make
`scanWrites` bilingual, so those seven appear in the denominator §19 quotes and
classify under the same guard vocabulary as the other 276, instead of being
covered by a test of their own that nobody counting writes will think to add
up.

The extraction is already there. `templateLiteralAt` went into
`source/enclosing.ts` this phase because a regex could not read one of those
statements — ``/sql`[\s\S]*?`/`` ends at the backtick inside
`sql.raw(`"${ref.table}"`)`, which produced two false positives on correct code
before it was replaced. That is the fourth copy-of-a-copy this repository has
paid for, and putting the primitive in the shared module rather than in the
test is the only answer that has ever worked for it.

### And then the read census's reach, measured the way this phase measured the write census's

The write side turned out to be 43% of itself and the read side's denominator
is sound, which closes the question the nomination asked. But *sound
denominator* is not *sound reach*: `scanReads` counts `.from(` and nothing
else, so a read that reaches a company-scoped table by any other route is
invisible to it in the same way those 157 writes were.

The candidates are specific and countable: an `innerJoin` to a scoped table
whose primary table is unscoped, a `with`/relational query, a CTE, and raw
`sql` — plus `.from(subquery)`. The method is the one that worked here: build
the expected set from the schema and the source, independently of the scan's
own vocabulary, and compare. If the answer is "none", that is worth a sentence
and a test rather than an assumption, because it is currently neither.

Behind that: §20's *"Phases 0–8 all have shipped work"*, still the last
unmeasured sentence in `docs/SPEC-AUDIT.md`.
