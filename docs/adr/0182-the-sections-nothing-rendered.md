# 0182 — The sections nothing rendered

**Status:** accepted
**Date:** 2026-11-04
**Phase:** 182

---

## The nomination held, and understated the problem

Third of ADR 0173's eight measured gaps. The audit said:

> **`deliverables` and `assumptions`** — 10 of the 12 components §7 names have a
> dedicated block or column; these two have neither and would be typed into a
> `text` or `list` block.

Correct, and generous. *"Has a column"* and *"reaches the client"* are different
claims, and the audit checked the first.

## What measuring the other ten found

`proposals` carries `executive_summary`, `scope`, `exclusions` and `terms`. All
four are written by `createProposal`, written by the **AI draft** since Phase 6,
and snapshotted into `proposal_versions` so a sent proposal's wording freezes
with its figures.

**None of the four reached any document.** Not `document-render.tsx`, not
`pdf/layout.ts`, not `render-email.ts`. The `Proposal` merge-field group held
`number`, `title`, `total`, `subtotal`, `date` and `expiresOn` — six figures and
no prose.

The templates made it look handled. They placed a `heading` and a `text` or
`list` block with the ids `scope` and `exclusions`, filled with placeholder
prose:

> Describe what is included, in the order the work will happen.

An instruction addressed to the author — and sent to the client if they skipped
it. So an author typed their scope into the proposal form, opened the designer,
found a block asking them to describe their scope, and typed it again. The column
kept the first copy and the client read the second.

Three consequences worth separating, because they are different failures:

- **The AI draft wrote into a void.** Phase 6 built an assistant that generates
  an executive summary, a scope and an exclusions section. All three went into
  columns no document read. The most expensive of the four orphans, because
  something was actively producing content for it.
- **Every proposal's terms rendered identically.** Both templates put
  `{{company.paymentInstructions}}` under a "Terms" heading and nothing else, so
  two proposals with different terms produced the same page.
- **Five of the six sections had no writer in the UI at all.** The form carried
  `scope`. `executiveSummary` was reachable only through the assistant;
  `exclusions` and `terms` were reachable only through the API.

Phase 49's rule at scale: a column with no reader is a field that does not exist.
Four of them, in the section of the specification with the most components.

## So not two more columns

Adding `deliverables` and `assumptions` as two more columns of the same kind
would have been the nominated work done in the shape that made the nomination
necessary — two more fields nothing renders.

The columns go in, matching the four exactly (`text`, nullable, no default,
because a fifth and sixth narrative section behaving differently from the first
four would be a difference with no reason behind it). And then the actual fix:

**All six become merge fields.** `{{proposal.scope}}`,
`{{proposal.deliverables}}`, `{{proposal.assumptions}}` and the rest — the
engine's own mechanism for putting record data into a document, which is what
the four orphans needed all along. The templates use them instead of placeholder
prose, so what the author typed is what the client reads.

Their own insert-menu group, *"Proposal sections"*, rather than six more entries
under *"Proposal"* — the menu is the one place an author discovers these exist,
and six paragraphs listed among six figures reads as six more figures.

### One detail that earns its place

`buildMergeContext`'s `set` skips an empty value, which lets
`findUnresolvedFields` tell *"no such field"* from *"the author left this
blank"*. Both render as nothing and only the first is worth warning about — which
is how a template can carry all six sections without nagging about the ones a
particular proposal does not use. That behaviour predates this phase and is
exactly what made carrying all six in a template viable.

## `PROPOSAL_COMPONENTS`, and the check the audit could not make

The register is §7's twelve, each saying three things: where the content is
**stored**, how it **reaches a rendered document**, and why it lives there. The
third is argued because *"it has a column"* was precisely what made four orphans
look finished.

The keys are §7's own words in §7's own order, and a test matches them against
the bullet in `docs/SPEC.md` — so *"10 of 12"* becomes something checkable rather
than a sentence in an audit, and a reworded bullet fails naming the difference.

`proposalComponentStands` carries the rule that would have caught the orphans:

> A component stored in a column reaches the page through a merge field and
> through nothing else, so an entry claiming a column with no field named is a
> column nobody can render.

And its mirror: an entry that reaches the page another way *and* names a merge
field is two mechanisms for one component, which is two places for it to
disagree with itself. Both are asserted against a deliberately broken entry,
because a rule only ever seen to agree is not a rule (Phase 121).

The register is also load-bearing rather than descriptive. The proposal form
renders one textarea per narrative component, derived from
`narrativeComponents()` and `narrativeColumn()`, so a seventh section added to
the register appears in the form without anybody remembering — which is the
failure this phase is about, one level up. The version-snapshot test walks the
same list, so a new section cannot quietly miss the freeze.

## What this does not do

**The AI draft still produces three sections, not five.** `ai/schemas.ts` asks
for an executive summary, a scope and an exclusions section; `deliverables` and
`assumptions` are not in the schema. All five now reach the page, so the gap is
narrower than it was — but the assistant is a separate register with its own
prompt and its own output contract, and widening it is a change to what the model
is asked for rather than to where its answer goes.

**Three templates of four were not rewritten.** `standard-services` carries all
six sections and is the reference; `construction-bid` and
`professional-engagement` got the `terms` fix and keep their own narrative
blocks, because those templates are trade-specific documents whose section order
is the point of them. Stated rather than implied.

## Nominated for Phase 183

**Team bios (§15)**, the last of ADR 0173's eight that is not §7's design
engine. `company_profiles.credentials` covers licences, certifications and
insurance; bios have no home — and §15 asks for them in the context of a
capability statement, which means the question to answer first is whether a bio
is a column, a table, or a block, and the answer is probably a table because a
firm has several people and a proposal names two of them.

Behind it: §7's four remaining design-engine pieces (crop/mask, SVG, artboard
affordances, vector primitives), and the conversion of `document_links` away
from twelve keyless polymorphic subject references.
