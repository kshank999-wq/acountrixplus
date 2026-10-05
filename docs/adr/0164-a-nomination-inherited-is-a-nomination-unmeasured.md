# 0164 — A nomination inherited is a nomination unmeasured

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 164

---

## Why this phase is an audit and not a feature

ADR 0163 recorded that **three consecutive nominations had been wrong** — 0161
guessed an `AsyncLocalStorage` scope would survive a React render, 0162 guessed a
role would map onto the worker, 0163 guessed the queue was the whole cross-tenant
problem — and that each was wrong in a way a short measurement would have caught.

The corrective to a run of bad hypotheses is not a better hypothesis. So this
phase produced no mechanism: it measured `docs/SPEC.md` against the code and
wrote `docs/SPEC-AUDIT.md`.

It also means this is the first phase since 104 whose deliverable is a document.
That is the right shape for it and it is worth being explicit that it is a
choice, not a slow week: four phases inside one arc, three corrected
nominations, and a backlog being inherited rather than checked is a situation
where the useful work is looking rather than building.

## The audit's own first mistake, kept

The first pass grepped the specification's vocabulary against the source and
reported §9's *"performance by … geography"* unimplemented: nothing matches
`geograph`.

**`breakdownBy(ctx, dimension)` takes `'owner' | 'source' | 'industry' |
'region'`.** `region` is geography, joined from `organizations.region`, labelled
`'Unspecified region'` when absent. `source` is likewise §9's "lead source".

So two of five apparent gaps in §9 were false negatives from one naive pass, and
the audit was redone by opening modules. Kept in the audit rather than tidied
away, because the method mattered more than the result: **grepping a
specification's words finds the specification's words, not the implementation.**

## The finding worth a rule

The geography claim is not new. It appears in **ADRs 0152, 0153, 0154 and
0157** — four consecutive nomination lists, each inheriting the previous one.

That is how a false sentence survives four phases of otherwise careful work.
Nobody asserted it carelessly the first time; the first assertion may even have
been true when it was written. Nobody asked again.

> **A nomination inherited is a nomination unmeasured.**

Phase 121's rule is that a check only ever seen to agree is not a check. This is
its sibling for prose: a claim only ever copied is not a claim. The arc from 160
to 163 produced three wrong nominations by *reasoning*; this phase found a fourth
produced by *copying*. Both are the same failure, and the second is harder to
see because the sentence reads as settled.

Each of the four ADRs now carries a correction pointing at the audit, rather than
being left to be inherited by a fifth.

## What the audit found

Measured by reading. §13 bullet by bullet because it is the accounting core; §9,
§11 and §19 because they contain enumerable lists; the rest at module level,
which is weaker and is said so.

**§9 — four real gaps**, after the two false ones were withdrawn: average
proposal size and average time to decision are not computed, and `breakdownBy`
has no service/product or time-period dimension. Only *time to decision* needs a
fact nothing records; the other three are re-groupings of data already present.

**§11 — five of seven AI capabilities.** `BUILT_IN_PROMPTS` holds eight prompts
covering bookkeeping, reconciliation, proposals, marketing and insights. **AI
Design Assistant** and **AI Strategic Account Assistant** appear nowhere —
`designAssistant`, `strategicAccount` and `layoutSuggest` match nothing in
`src/modules`. Both have the infrastructure they need already: the gateway,
metering, the versioned prompt registry, and the modules they would read from.

**§19 — nine of ten bullets done**, with tenant isolation partial in a precise
way: the application layer complete and measured, the database layer installed,
forced on 161 tables, proven against a restricted role, and not switched on.

**Everything else — done at module level.** §13 is complete bullet by bullet,
which is the one worth saying plainly, because it is the part a bookkeeping
product is judged on.

## What this does not claim

The audit is a floor, not a ceiling. §3–§8, §10 and §12–§18 were verified at
module level — the module exists, is exported, has tests behind it — which would
not notice a missing bullet inside a built section. That is exactly the kind of
gap the geography claim shows this project is capable of carrying for four
phases, so it is written into the audit as an unknown rather than left as an
implication.

## What is nominated next

From the audit rather than from reasoning:

1. **AI Design Assistant** (§11). The larger of the two missing capabilities, and
   first because §11 asks it to *"preserve user control and provenance"* —
   provenance is a data decision that should be made before a prompt is written,
   which is the sort of thing the last four phases kept discovering late.
2. **AI Strategic Account Assistant** (§11). `modules/marketing/segments` already
   has strategic-account segmentation to read from.
3. **§9's four analytics gaps.** One small phase: two derived figures, one new
   recorded fact, two more `breakdownBy` dimensions.
4. **A bullet-level pass** over the sections verified only at module level, which
   is where the honest unknowns are.

The row-level-security arc keeps ADR 0163's nominations — a principal per kind of
authority, then the ~397 web boundaries — and they are now behind the list above,
because four phases in one arc with three corrected nominations is enough to
suggest the arc had stopped being measured too.
