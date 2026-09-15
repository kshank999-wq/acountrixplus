# 0149 — What a write stands on

**Status:** accepted
**Date:** 2026-09-15
**Phase:** 149

---

## How this was found

ADR 0148 nominated it, and the nomination came with a sentence rather than a
hunch. The README said, of tenant isolation:

> tenant isolation rests on `scoped()` at every query and on the tests that
> assert it

That is a claim about the most serious defect class this system can have — one
company writing to another company's books — and it can be held to a fact.

## What the measurement says

159 company-scoped tables. 1,330 queries naming one. **106** of those are the
shape that can be *aimed*: an `update` or `delete` whose `where` keys off an id
the function was handed, which is the only way a statement reaches a row chosen
by somebody else.

Every one of the 106 is guarded. Here is what by:

| guard | count |
| --- | --- |
| `explicit-company` — `eq(t.companyId, ctx.companyId)` written out | 58 |
| `scoped-write` — `scoped()` inside the statement | **27** |
| `read-then-refuse` — a filtered read above, a refusal, then a write by id | 9 |
| `owner-helper` — a helper that loads and refuses | 4 |
| `system-actor` — no tenant, by design | 4 |
| `caller-established` — module-private, or the caller had the check | 2 |
| `actor-scoped` — `eq(t.userId, ctx.userId)`, stricter than the company | 1 |
| `bearer-credential` — the id is the secret | 1 |

`scoped()` guards about a quarter of them. The most common guard is an explicit
`companyId` equality, at more than twice as many.

**The code is right and the sentence was wrong.** Nothing here is a leak. What
was missing is that isolation rested on eight different mechanisms and nothing
recorded which one any given write stood on — so the only way to know a write
was safe was to read it and work it out again.

That is ADR 0110's shape on the highest-stakes axis in the system, and it is why
this phase corrects prose rather than code.

## Declared guards, measured sites

ADR 0141's split, and the clearest case of it so far.

The **knowledge** is which kinds of guard are legitimate. That is a judgement,
it belongs in prose somebody can disagree with, and it is what
`ISOLATION_GUARDS` holds.

The **fact** is which guard a given write actually has, and that is readable
from the source. Declaring it per site would produce a register saying
`updateTime` is fine — a sentence that stops being true the moment somebody
deletes its `loadOwnEditable` call, and goes on reading exactly the same.

So every guard carries a `detect`, the scan measures each of the 106, and a
write matching **no** guard fails the test by name. Adding one is not a matter
of adding a row.

## Three guards are not tenant filters, and say so

`atLeastCompanyTight` is false for `bearer-credential`, `caller-established` and
`system-actor`, and a test asserts exactly those three.

That flag is the whole of ADR 0134 in a boolean. Flattening them into "guarded"
would let the weakest thing on the list wear the same word as the strongest, and
*"it is a system path"* is precisely what somebody would write to excuse a real
leak. So it is measured: a system-actor site must take no `ActorContext` and
must live under `/worker/`, and a separate test proves that being in a worker
file is not on its own a licence.

`caller-established` is the weakest and is named honestly. `recordPostedRate` is
module-private, so its callers are readable in one file. `touchDevice` is
exported and is safe only because its one caller passes `session.deviceId` — a
property of the call site rather than of the function, so the test asserts that
call site is the only one.

## What the scan caught in itself, twice

Both worth recording, because a scan's own reach is what this phase is about.

**It called the tightest guard in the codebase unguarded.** `revokeDevice` and
`renameDevice` filter `devices.userId = ctx.userId` — a colleague in the same
company cannot rename your phone. The scan reported both as bare, because it was
looking for `companyId`: a check shaped like the loosest rule could not see the
strictest one. That is the eleventh instance of this family, and it is why
`actor-scoped` is a declared guard rather than an exception.

**It collapsed one of my own distinctions.** I declared `parent-scoped` for
`voidDeposit`, which finds a deposit under a tenant filter and then deletes its
items by the deposit id. The test that asserts every declared guard is *used*
reported it as used by nothing: it is `read-then-refuse` with the refusal one
table up. A distinction the measurement collapses is not a distinction, so it is
gone — the same call ADR 0147 made about `reported`.

`read-then-refuse` itself only exists because the first run failed. It is the
real guard on nine sites and I had not named it, which is a reasonable summary
of why the phase was worth doing.

## What this does not do

**It does not add row-level security.** Spec §19 asks for RLS as a *second*
layer and this is a description of the first. RLS remains outstanding and is a
migration, which is the wiring pass's kind of work rather than this one's.

**It does not cover reads.** A `select` that leaks another tenant's rows is as
serious as a write, and the narrowing here — writes keyed by an id argument — is
chosen because it is the shape that can be aimed. `conditions-array` is declared
and exempted from the used-guard check for exactly this reason: it is a read
guard, and the exemption is named rather than silent.

**It does not claim the eight are all there are.** It claims that these eight
cover every id-keyed write today and that a ninth will announce itself by
failing, which is a weaker and checkable thing.

## What is nominated next

**Reads.** This phase measured the writes because they are the shape that can be
aimed, and 271 of the 1,330 queries have no `scoped()` and no `companyId` in the
statement. Most are joins that inherit scope from a parent and reporting queries
that assemble it into a list — both already declared guards — but nothing has
measured which, and a `select` that returns another company's rows is a breach
whether or not anything was written.

The wiring pass remains outstanding: seven `PENDING_WIRING` entries over eleven
targets, five blocked by nothing, and three `BLIND_FACE_SUMS`.
