# ADR 0215 — The refusal that says the record does not exist

**Status:** accepted · **Phase:** 215 · **Spec:** §11, §14

> **Written before the code.** The measurement below is complete and was taken
> against the tree at `cc536b4`. The implementation it describes is staged and
> lands in the commit after this one: Phase 214's full eight-shard run was still
> going, and writing to `src/` or `tests/` while it runs contaminates it —
> `tests/setup.ts` truncates every table in `beforeEach`. Figures here are
> measured; the "What is built" section is the decision, not yet the diff.

## The nomination, and the first one in five phases that was not there

ADR 0214 nominated **the soft refusal that is not a permission**. Phase 214 had
taught the audit scan to read `if (!can(ctx, 'x')) return { ok: false, … }` as a
gate, and warned that a soft refusal and a thrown one are not interchangeable:
*"A soft refusal whose caller drops the result is a gate in name only… Only
callers that ignore it are a finding."*

Measured: **no caller ignores one.** All nine soft refusals in `src/modules` are
handled — seven return `{ ok: false }` and every caller checks `.ok`, two return
`null` and all four callers handle the null. The nominated finding set is empty.

That is worth stating plainly, because four phases running had replaced their
nomination with something larger, and the reflex that builds is to go on finding
things. The honest report here is that the specific fear was unfounded: the nine
soft gates do refuse, and their refusals are obeyed.

What measuring them found instead is about **what the refusal says**.

## Three acts tell the reader the record does not exist

`src/modules/ai/retrieval.ts` holds five permission-gated reads, and every one
returns an *absence* rather than a refusal:

| read | permission | absence | callers |
| --- | --- | --- | --- |
| `accountOptions` | `bookkeeping:view` | `[]` | 1 **refuses** — `no_accounts` |
| `recentTransactions` | `bookkeeping:view` | `[]` | tolerated |
| `inboxShape` | `bookkeeping:view` | empty shape | tolerated |
| `companyContext` | `crm:view` | `null` | tolerated ×2 |
| `transactionContext` | `bookkeeping:view` | `null` | 2 **refuse** — `not_found` |

The file states its own rule, and the rule is right:

> The checks return empty rather than throwing. A context builder assembling five
> kinds of data for an insight should produce an insight from the four the user
> may see, not fail entirely because of the fifth.

That is correct for a *supplement*. `renderVoice(null)` returns `''` and
`draftCampaignCopy` writes "our company" — the insight degrades and nobody is
misled. **`transactionContext` is not a supplement. It is the subject of the
act.** `suggestCategory(ctx, transactionId)` is *about* that transaction, so
when the reader may not see it there is nothing to degrade into, and both callers
say:

> That transaction was not found.

It was found. The reader may not see it. A salesperson holds `ai:use` and not
`bookkeeping:view`, so a salesperson asking for a category suggestion is sent
looking for a transaction that exists — and then `accountOptions` returns `[]`
for the same reason and the same act says *"No accounts are available to choose
from."*

## Why this is the oldest defect in the project, not a wording problem

Three rules land on it at once.

**Two answers to one question is the defect.** `null` from
`transactionContext` means *not on these books* and *not yours to see*. One value,
two facts, and no caller can tell them apart.

**Phase 47: a refusal must name something actionable.** "Not found" is
actionable — it tells you to go and look for the record, which is the wrong thing
to do and will not work.

**Phase 70: one vocabulary for a correction.** This is the sharpest of the three,
because the vocabulary already exists and these two acts are locked out of it.
Five other acts in the same module answer both questions separately:

```
message: 'Your role does not include reconciliation.',  reason: 'permission'
message: 'That reconciliation was not found.',          reason: 'not_found'
```

`explainReconciliation`, `draftProposalSections`, `draftCampaignCopy`,
`businessInsights` and `adviseOnAccount` all do this. `suggestCategory` and
`suggestRule` are **the only two acts in the module with a `not_found` and no
`permission`** — not because anybody decided they should be, but because their
permission check sits inside a helper whose return type cannot carry the
distinction. The shape of a type silently removed a sentence from two acts.

## What is built

`transactionContext` returns a discriminated read instead of a bare `null`, so
the caller can say which of the two happened, and the two acts join the
vocabulary the rest of the module already uses.

The device is `src/modules/source/degrading-reads.ts`, and the property it
asserts is **not** "no permission check returns an absence" — that would be
wrong, because four of the five should. It is:

> A read whose absence a caller turns into a refusal must be able to say *why* it
> is absent.

`DEGRADING_READS` declares the four reads that may legitimately return empty,
with the permission each is gated on and the reason the degradation is right.
`absentRefusalDefects()` must be empty, and it is computed per caller rather than
per read: an entry is a defect if a caller refuses on its absence, **unless** the
entry names a `settledBy` — a discriminated read, gated on the same permission,
that the caller consults first.

That exception is the one real subtlety and it is load-bearing.
`accountOptions` returning `[]` is still ambiguous in principle, but
`suggestCategory` reads `transactionContext` before it and on the same
permission, so by the time the account list is empty the permission question is
already answered and the emptiness genuinely means emptiness. **Ordering is the
argument**, so the register names the read that has to come first and the
falsifier checks that it really does.

## What the measurement also found

An **eleventh gate form**, two phases after a phase that found ten.
`ifPermitted(ctx, permission, read, fallback)` in `retrieval.ts` passes the
permission as an *argument to a wrapper*, which Phase 214's reader does not match
— it looks for `requirePermission(` and `can(`. Three call sites use it.

Phase 214's figures are unaffected and were checked rather than assumed:
`ifPermitted` is module-private, all three uses are read-only, and none of the
thirty-one functions in `OPEN_ACTS` calls it. It is recorded because exporting it
would open the hole Phase 214 spent a phase closing, and because the count of
"forms a permission check can take" has now gone up in three consecutive phases
measured by three different people-shaped questions.

## What moved

One read discriminated. Two acts given the refusal vocabulary the other five in
their module already had. One register of four degrading reads, with the
ordering argument made checkable. No schema change, no migration, no new
permission, no new audit action.

## Nominated for Phase 216

**The absence that is not a refusal at all.** This phase asserts that a read
whose absence becomes a refusal must say why, and `DEGRADING_READS` declares the
four that are consulted as supplements. Three of those four are gated on
`bookkeeping:view` and feed prompts; `inboxShape` returns a *shaped* empty — zero
totals and no merchants — and `recentTransactions` returns `[]`.

The question not asked: **what does the assistant say when it degrades?** A
salesperson who may not see bookkeeping and asks for business insights gets an
answer built from the four things they may see, and nothing tells them the fifth
was withheld. That is either correct — the insight stands on its own — or it is a
confident answer assembled from a third of the evidence, which is worse than a
refusal.

The measurement to do first: for each of the four, whether the prompt that
consumes it distinguishes "this was empty" from "this was withheld", and whether
the rendered output says so. Only the reads whose emptiness changes the *answer*
rather than its completeness are a finding, and the shape of that answer decides
whether the fix is in the prompt, in the renderer, or in a sentence appended to
the insight.

Behind that: the twelve findings still in the column register; the CRM account
panel's missing payables side (ADR 0208); the four joins from an unscoped primary
(ADR 0198); and §11's six remaining functions.
