# 0150 — What a read stands on

**Status:** accepted
**Date:** 2026-09-16
**Phase:** 150

---

## How this was found

ADR 0149 nominated it in one sentence:

> a `select` that returns another company's rows is a breach whether or not
> anything was written

That phase measured the writes because they are the shape that can be *aimed*,
and said plainly that it had not measured the other half.

## What the measurement says

**867 reads** from a company-scoped table. Every one is guarded. By eleven
mechanisms:

| guard | count |
| --- | --- |
| `scoped-read` | 531 |
| `explicit-company` | 247 |
| `established-above` | 28 |
| `id-from-fetched-row` | 17 |
| `join-inherited` | 13 |
| `derives-tenant-from-row` | 12 |
| `caller-established` | 7 |
| `conditions-array` | 4 |
| `actor-scoped` | 3 |
| `validated-above` | 3 |
| `system-actor` | 2 |

> **866 since Phase 151**, with `scoped-read` at 530. The wiring pass routed
> `recordContribution` through `bankGlAccountFor` instead of selecting the
> account itself, so one read left that file for a gate this scan had already
> counted. The figures above are what Phase 150 measured; the test carries the
> current ones.

**The reads and the writes are guarded differently, and nothing had counted
either half.** `scoped()` covers **61%** of reads and **25%** of writes. Both are
sound. The README described one system and there are two — which is the same
shape as the sentence ADR 0149 corrected, one level down.

The asymmetry is not an accident. A write can be guarded by something that
happened earlier — a load that refused, a helper that threw — because the write
has not happened yet when the refusal fires. A read that leaks has already
leaked by the time anything downstream could object, so its guard has to be in
the statement or in the id it was handed. `appliesTo` records which guards are
available to which side, and `owner-helper` and `read-then-refuse` are
write-only for exactly this reason.

## Two guards that only exist on the read side

**`derives-tenant-from-row`.** `settleCheckout` takes a payment processor's own
checkout id from a webhook and, in its own words, *"derives the company from the
row"*. There is no actor to filter against — the caller is a processor, not a
person — so the read **establishes** the tenant instead of confirming it. Marked
not company-tight, because it rests on an external id being unguessable, which
is a property of the processor rather than of this codebase.

**`id-from-fetched-row`.** The proposal design page reads a brand kit by
`document.brandKitId`, and the document came from a scoped load. An id that is a
field of a checked row cannot be aimed by whoever called the function. This is
the distinction that makes the narrowing of *both* scans possible — a parameter
can be chosen by a caller and a property of a checked row cannot — and it took
until here to name it.

## The correction to ADR 0149

Building this found a defect in the phase before it, and it is recorded in both
places rather than fixed quietly.

ADR 0149's scan matched `pgTable\(([\s\S]*?)\n\)` — non-greedy to the first
`\n)`. A table whose body ends `\n})` runs past its own closing brace into the
next declaration. So it:

- falsely counted **two** content-addressed tables as tenant-scoped —
  `documentBlobs` and `assetBlobs`, both of which say in the schema that they are
  deliberately not;
- **missed seven that are**: `aiRequests`, `documents`, `checkouts`,
  `statementSettings`, `payablesSettings`, `refunds`, `serviceItems`.

Seven company-scoped tables were invisible to the write scan. Re-run with the
corrected set: **164 tables, 109 id-keyed writes, `explicit-company` 61**, and
**still zero unguarded**. The conclusion survived; three of the numbers did not,
and ADR 0149 now carries a correction note saying so.

`companyScopedTablesIn` lives in the module and both scans call it. Two
implementations of one question is the defect this project keeps naming, and
this is the second time in six phases that the two copies had drifted (ADR 0140
found four copies of a symbol reader).

## The scan was wrong twice more before it was trustworthy

Both are recorded as cases in the test, because a scan's reach is the thing
these phases keep being about.

**It read statements by line.** A `.where(` whose argument begins on the next
line with `scoped(` ended the statement early, so the first run reported **113**
unguarded reads — including `recentActivity`, which `tenant-isolation.test.ts`
has proved isolates by behaviour since Phase 122. A scan that disagrees with a
test which actually creates two companies is the scan that is wrong. Counting
brackets cannot make that mistake, and a test now asserts the two agree.

**It could not see a refusing helper unless the name contained "Own".** That is
what ADR 0149's write scan looked for, and `getCampaign` calls `loadCampaign`.
Widening it to *a helper handed both the id and the actor* found three sites —
and then only found the third when the actor was allowed to be the **second**
argument, since `requirePracticeOwner(input.practiceId, actor.userId, tx)` puts
it there.

One smaller correction, made rather than accepted: `input.practiceId` was
matching `id-from-fetched-row` because it contains a dot. It is a bare argument
wearing a dot and the caller chooses it, so the prefixes that mean "handed in"
are excluded. That moved two sites and is the difference between a guard that
means something and one that matches punctuation.

## What this does not do

**It does not add row-level security.** Spec §19 asks for RLS as a *second*
layer. Phases 149 and 150 describe the first, on both sides. RLS is still
outstanding and is a migration.

**It does not prove the eleven are all there are.** It proves these eleven cover
every read today, and that a twelfth will announce itself by failing — which is
weaker and checkable.

**It does not cover raw SQL.** A `db.execute(sql\`…\`)` is not a `.from(table)`
and this scan does not see it. Declared rather than silently missed.

## What is nominated next

**The wiring pass**, which is now the only thing on the register that a scan has
not already covered: seven `PENDING_WIRING` entries over eleven targets, five
blocked by nothing, each naming a skipped acceptance test, plus three
`BLIND_FACE_SUMS`.

Isolation is now measured on both sides and both come back clean. Money is
covered by registries for posting, banking, addition, division, screens,
grounds and comparison. Six phases of scanning have produced no defect that was
not already on a register, and the two that turned up — the tax rounding and the
billing preview — are both waiting on wiring.
