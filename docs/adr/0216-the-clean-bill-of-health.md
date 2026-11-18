# ADR 0216 — The clean bill of health nobody checked

**Status:** accepted · **Phase:** 216 · **Spec:** §11, §14

> **Written before its code**, like ADR 0215 and for the same reason: the full
> eight-shard run for Phases 214 and 215 was going, and writing to `src/` or
> `tests/` while it runs contaminates it. The measurement below was taken
> against `0bd2781`. The code landed afterwards and changed nothing in it.
>
> That run finished green on all eight shards — **277 files, 5,118 tests**,
> against Phase 213's 275 and 5,079, which is exactly the +2 files and +39 tests
> Phases 214 and 215 added. No stale counts, and no repeat of the shard-6
> failure Phase 213 closed out.
>
> One thing the code did move that the measurement had not predicted: the
> refusal `degradingRead` throws used to warn about "an absence standing in for
> a **refusal**", which is the same wrong half as the falsifier this phase
> replaces. It now says **data**, and names the remedy. Phase 215's test pinned
> the old phrase, so that assertion moved too, with the reason in it.

## The nomination, and this time it was there

ADR 0215 nominated **the absence that is not a refusal at all**. It had just
fixed `transactionContext` — the read that was the *subject* of its act and
could not say whether it was empty or withheld — and declared the other four
permission-gated reads in `ai/retrieval.ts` as legitimate degradations. Then it
asked the obvious next question:

> What does the assistant say when it degrades? A salesperson who may not see
> bookkeeping and asks for business insights gets an answer built from the four
> things they may see, and nothing tells them the fifth was withheld. That is
> either correct — the insight stands on its own — or it is a confident answer
> assembled from a third of the evidence, which is worse than a refusal.

It is worse than a refusal, and worse than the nomination guessed: the answer is
assembled from **none** of the evidence and reported as a success.

```
reviewAnomalies(salesperson)
  -> { ok: true, findings: [], message: 'Not enough activity yet for a useful review.' }
```

`ok: true`. A clean bill of health, on a company that may have ten thousand
transactions, given to somebody who was never permitted to see one. The sentence
is not a hedge; it is a false statement about the books.

`summarizeInbox` is worse still, because it does not even branch. `inboxShape`
hands back a **shaped** empty — zero uncategorised, no merchants — so there is no
falsy value to notice. It passed those zeroes to the model, which wrote a
confident summary of a tidy inbox, and metered a provider call to do it. A false
statement with an author, and an invoice.

Both are reachable. They are server actions, and Phase 214's own finding is that
a page guard does not protect an HTTP endpoint: `src/app` holds eleven permission
checks in three files because gates live in modules. The roles that can reach
them are exactly those holding `ai:use` without `bookkeeping:view` — **`sales`
and `marketing`**.

## The register said it was fine, one commit before it was false

Phase 215 placed `recentTransactions` in `DEGRADING_READS` with this reason:

> Recent activity for the anomaly review, and a genuine supplement: the review
> reports what it found in what it could see. No caller refuses on it, and none
> should — "nothing unusual" is an answer.

**Nothing unusual is an answer only if you looked.** That sentence was written by
the phase immediately before this one and was wrong when it was written. The
entry now records what it got wrong rather than being quietly rewritten, because
a register that edits its own history teaches nothing.

## The falsifier was the weaker half of the right idea

Phase 215 asserted:

> A read whose absence a caller turns into a **refusal** must be able to say why
> it is absent.

Both defects in this phase **passed** that assertion. `reviewAnomalies` does not
refuse on the absence — it answers on it. `summarizeInbox` does not branch on it
at all. The falsifier asked about the wrong caller.

The property that covers both:

> Every caller of a degrading read must already have **established** that read's
> permission.

Three ways, all checkable, and none of them needs a new field:

1. **the caller checks the permission itself** — the two acts this phase fixes;
2. **the caller checks a permission whose holders all hold it** — computed from
   `ROLE_PERMISSIONS`, not claimed. `draftCampaignCopy` never names `crm:view`,
   and the reason that is safe is that every holder of `marketing:manage` holds
   `crm:view`;
3. **the caller consults a discriminated subject read on the same permission
   first** — what `settledBy` already named, checked by source position.

This absorbs both of Phase 215's loose observations. `settledBy` was arm 3. The
note that `companyContext`'s branch "cannot fire today, because both callers
require `proposals:manage` or `marketing:manage` and every holder of either holds
`crm:view`" was arm 2 — Phase 215 pinned it as a premise in a test, where it was
true and inert. It is now the reason the property passes, which is where a
premise belongs: it fails when the role table changes, instead of sitting in a
comment that does not.

`absentRefusalDefects()` is **deleted** rather than kept beside the new one. Two
falsifiers for one question is the defect this codebase names most often, and
keeping the weaker one would mean keeping something that passes for exactly the
reason that makes it weak.

## The fix, and why it is a permission rather than a plumbing change

The tempting repair is to make `recentTransactions` and `inboxShape` report
withheld-ness, as `transactionContext` now does. That is the wrong layer. These
two acts are **bookkeeping acts**: a reader without `bookkeeping:view` should not
get an answer, a degraded answer, or a provider call. They should be refused, in
the module's own words.

And the count says the same thing. Every act in every other file of the AI module
gates itself — `adviseOnAccount` on `crm:manage`, `explainReconciliation` on
`reconciliation:view`, `draftProposalSections` on `proposals:manage`,
`draftCampaignCopy` on `marketing:manage`, `businessInsights` on `reports:view`,
`suggestLayout` on a permission computed from the document's kind.
**`bookkeeping.ts` was the only file whose acts had no gate of their own**, and
after Phase 215 two of its four get their answer out through
`transactionContext`'s discriminated read. These two had nothing at all. The fix
makes `bookkeeping.ts` stop being the module's exception.

## What moved

Two acts gated, in the module's existing vocabulary — *"Your role does not
include bookkeeping."* One falsifier replaced by the property it should have
been, with the implication arm computed from the role table. One register entry
corrected and the correction recorded. No schema change, no migration, no new
permission, no new audit action, and one fewer provider call charged for an
answer nobody was entitled to.

## Nominated for Phase 217

**The page guard that guards nothing.** This phase leaned on a fact Phase 214
established and neither phase measured: a `src/app` page checking
`if (!can(actor, 'x'))` does not protect the server actions that page calls,
because an action is an HTTP endpoint reachable without the page. There are
**70** such page-level guards in `src/app`, against eleven `requirePermission`
calls in three action files.

> **Both figures corrected by Phase 217**, which measured them: there are **71**
> guards — one is in `api/pdf/version/[id]/route.ts`, a route handler rather than
> a page, and `payroll/workpapers/page.tsx` has two — and **8**
> `requirePermission` calls, the eleven being occurrences of the word including
> three `import` lines. Phase 217 also found the relation this paragraph proposes
> to be the wrong one: a page guard says who may look at a screen, so gating
> `runChases` on the `accounting:view` its page guards would have satisfied the
> property and still let a read-only user send dunning letters.

Each of those 70 guards a screen. The question is what the screen's *actions*
require. Where the module function behind an action gates on the same permission,
the page guard is a courtesy and all is well. Where it does not, the page guard
is the only check — and it is not a check at all.

The measurement to do first: for each page guard, the actions that page invokes,
and whether the module function behind each establishes that page's permission —
reusing `establishedByImplication`, because a page gated on `accounting:view`
calling an act gated on `accounting:journal` is safe and the reverse is not. Only
the actions whose own gate is weaker than their page's are a finding, and the
count of those decides whether the fix is per-action or a shared wrapper.

Behind that: the twelve findings still in the column register; the CRM account
panel's missing payables side (ADR 0208); the four joins from an unscoped primary
(ADR 0198); and §11's six remaining functions.
