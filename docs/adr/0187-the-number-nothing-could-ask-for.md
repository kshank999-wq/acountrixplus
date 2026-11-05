# 0187 — The number nothing could ask for

**Status:** accepted
**Date:** 2026-11-05
**Phase:** 187

---

## Nominated three times, and the cost was finally measured

ADR 0186 nominated moving the read and write scans into
`src/modules/source/`. So did 0185 and 0184, in their "behind it" lists, and
each time it lost to §7 work because it is small.

What changed is that the cost stopped being an argument and became a receipt.

`PINNED_CLAIMS` holds numbers stated in prose that a test checks against a
measurement. Twelve were measured. The thirteenth — the sentence in
`modules/tenancy/isolation.ts` reading *"N of the M reads, against P of the Q
writes"* — was declared with `measure: null`, because `guardedWrites()` lived
inside `tests/isolation-guards.test.ts` and the read scan inside
`tests/isolation-reads.test.ts`, and **nothing outside those two files could
ask for the numbers.**

That declaration was Phase 139's device and it was the right call: a register
that looked complete while covering twelve of thirteen would be worse than one
that names what is not wired. Phase 157 is why it was kept rather than deleted
— an unused declaration is kept when it **accuses**.

It accused for eight phases, and in the five that touched a read — 180, 183,
184, 185 and 186 — the sentence went stale and was corrected by hand. Five
corrections is the measurement. Small debt, paid in full every phase.

## What moved, and what deliberately did not

`modules/source/isolation-scan.ts` now holds `scanReads`, `scanWrites`, the
shared `sourceFiles`, `readableSource`, `statementAt` and
`companyScopedTables`. The two test files import and assert; the register
measures from the same functions.

**No measurement changed by being moved.** Every regex, detector and boundary
is the one the test files carried, because each is the subject of its own
correction: Phase 150's bracket counting instead of line counting, Phase 152's
`enclosingQuery`, Phase 183's replacement of a fixed character window with it.
Moving a scan is not the moment to re-derive it.

The test files keep the tests. `statementAt`'s own unit test stays where it is
— it exists because the first version cut a statement short and reported 113
false unguarded reads — and so do the named-site assertions that keep
`derives-tenant-from-row` and `caller-established` honest. What left is the
scanner, not the scrutiny.

## The two copies had drifted, and the wrong one was the writes

Each file had its own `readable()`. The reads copy blanked single-quoted
strings; the writes copy blanked **template literals** as well.

The first measurement of that divergence compared how many `.from(` sites each
version found: 924 either way, no file differing. That looked like a latent
difference and it was written up as one.

**That measurement was too narrow.** It counted the sites and not the
*verdicts*. Running the real classifier over both found one read that moves:

```
payables/remittance-send.ts  settledBills  from paymentApplications
  quotes only  →  explicit-company
  + templates  →  join-inherited
```

Its tenant filter is:

```ts
.where(sql`${paymentApplications.companyId} = ${companyId} and …`)
```

Real, explicit, and inside a template literal. **A `sql` template in drizzle is
the query, not a string** — blanking it deletes a genuine tenant filter from
the scan's view, and the read falls through to the weaker guard it also
happens to satisfy.

So the unified `readable` is the reads copy, and the writes copy's extra
blanking was the mistake. Measured in that direction too: keeping templates
changes no write's classification today, because no write expresses its tenant
filter in raw SQL — *yet*. It would have been wrong the first time one did.

This is `enclosing.ts`' finding one level up. That module exists because four
test files each had a copy of the same function and all four were wrong the
same way. Here there were two copies, they disagreed, and the disagreement was
only visible once something asked them the same question.

### The lesson about the first measurement

It was not wrong to measure before unifying — that is the rule. It was wrong to
measure the cheap proxy. Counting matches answers "do these find the same
sites"; the claim being made was "do these produce the same answer", and those
are different questions. The second one cost ten more lines to ask.

## One sentence, four numbers, four pins

The entry's pattern captured one number of the four. Pinning the first and
ignoring three is not a weaker version of pinning the sentence — it is the same
defect spread thinner, because three numbers then drift with nothing watching.

So `measure` may now return an array, compared against the pattern's capture
groups in order, and a mismatch names **which** number moved. The twelve
existing entries return a single number and are unchanged.

A measure and a pattern that disagree about how many numbers a sentence states
is itself a failure with its own sentence, because the alternative is checking
some and silently skipping the rest — which is exactly what the single-number
`measure` did to this entry for eight phases.

Proven in both directions rather than left to agree (Phase 121): breaking the
**third** number — the one the old pattern could never have seen — makes the
test say *"says 31 where number 3 of this sentence should be 29"*, and
restoring it makes it green.

## `measure: null` now has no occupant

Phase 139's device stays in the type and in the rule. What it has lost is its
one example, which is the outcome a `PENDING_WIRING` declaration is supposed to
reach: it is a way of being honest about unfinished work, not a parking space.

The next entry that cannot be measured will say so the same way. The difference
is that this register can now be read as "every number here is checked" without
a footnote.

## What this does not do

**It does not make the scans faster.** `scanReads` and `scanWrites` each walk
`src/modules` and `src/app`, so the tree is read twice — three times now that
the claims test calls `isolationCounts()`. That is a few hundred files of
regex on a suite that takes two hours, and merging the walks would couple two
scans that are better kept legible.

**It does not move the other scans.** `retention`, `rls-bites`,
`money-comparison`, `money-on-screen`, `the-id-a-caller-hands-in` and
`a-job-through-the-policies` still live in their test files. Most read the
database rather than the source and have no prose claim to feed, so the
argument that forced this one does not apply to them — stated rather than left
as an inconsistency somebody notices.

**The sentence still has to be edited when the numbers move.** What changed is
that a test now fails when it is not, naming the number. That is the whole
claim: not that prose maintains itself, but that stale prose is red.

## Nominated for Phase 188

**The client-link comment thread (§7).**

It is the last of ADR 0173's eight that is not vector authoring, and the audit
measured it plainly: *"No table, column or module. The link tracks views and
takes an acceptance; a client cannot ask a question through it."*

The shape to decide first is whether a client's question is a `record_notes`
row — the table already holds questions, carries an answer beside the question
rather than over it, and has a work list — or something separate because its
author is not a user of this system. Phase 184 gave `record_notes` a real
foreign key through `evidence_subjects`, and a `proposal` is not an evidence
subject, so that decision is now a schema question with a clear answer rather
than a preference.

Behind it: SVG import/export, artboard affordances and vector primitives — the
last three, all §7's Illustrator-class work, which §7 itself defers.
