# 0166 — The document a machine laid out

**Status:** accepted
**Date:** 2026-10-05
**Phase:** 166

---

## The nomination, and what reading §11 closely did to it

ADR 0165 nominated **the AI Design Assistant itself**: *"the `design` prompt,
the generation path writing `ai-generated` assets against their ledger rows,
and `deriveAsset` getting its caller."*

Two of those three turned out not to exist to be built. §11 asks for:

> generate layout suggestions, brand-consistent variations,
> background/graphic concepts, image prompts, and logo ideation; preserve user
> control and provenance

Every one of those is **advisory** — *suggestions*, *variations*, *concepts*,
*prompts*, *ideation* — and the bullet that sounds closest to pixels, *"image
prompts"*, is explicitly text for a person to take elsewhere. There is no image
model behind the gateway, and §11 does not ask for one.

So there is no generation path writing `ai-generated` assets, and `deriveAsset`
has no caller here either. ADR 0165 wrote those two down while reasoning about
what an assistant *would* do; measurement against the sentence found the
sentence asks for less. Phase 164's rule holds for the fifth phase running: a
nomination inherited is a nomination unmeasured.

## What it did find, which is a gap in Phase 165

What this assistant generates is the **layout** — which is the document. And
Phase 165 put provenance on `assets`.

Measured, not supposed: `disclosureForDocument` computed a document's
disclosure *only* from the assets its blocks referenced. So a document whose
entire layout came from an accepted AI suggestion, illustrated with the
client's own photographs, disclosed **nothing** — while being, in the sense a
reader cares about, a machine-laid-out document.

That is Phase 165's own rule turned on Phase 165. Provenance that does not
cover the thing that was generated is true about every part and false about the
whole.

`assets.provenance_origin` was not wrong. It is right for uploads, right for
derivation, and right for a future image model. It was one level short of where
this assistant writes.

## The same shape, one level up

`design_documents` gets `provenance_origin` and `ai_request_id`, the same four
origins, and the same **bidirectional** CHECK: a machine origin requires a
ledger row, a human origin forbids one. The second direction is the one that
matters, for Phase 165's reason — without it a document could carry an AI
request and be disclosed as hand-made.

The backfill asserts `'authored'` rather than `'uploaded'`, because a design
document is made in the application and never supplied as a file, and because
every existing one genuinely was laid out by a person — nothing else could lay
one out. A measured fact, as in Phase 165 and unlike Phase 157.

And the default goes, which is again the part that does the work: it made the
compiler refuse `duplicateDocument` until that function said where the layout
it was copying came from.

## `derivedProvenance` earned its caller after all — on documents

ADR 0165 admitted `derivedProvenance` was one Phase-49 argument from deletion:
used by a test and nothing in production, surviving only on Phase 157's rule
that an unused declaration is kept when it accuses.

`duplicateDocument` is the caller. A person pressing duplicate has *authored*
the act, and the copy contains the same machine-laid-out layout, so `authored`
would be true about the act and false about the artifact — exactly the join
`strongerOf` exists to take. The function was right; it was waiting for the
level the artifact lives at rather than for an image generator.

## It proposes an ordering, never a document

`layoutSuggestionSchema` permits an **ordering over ids the model was given**
plus a rationale. Deliberately not a block list.

A returned block list would have to be validated, repaired, merged with what is
already there, and reconciled against ids the model invented, and the first
thing to go wrong would be silent content loss in somebody's proposal. With an
ordering, ids the model names that are not in the document are dropped, and
blocks it omits are appended in their original order — so **the worst a bad
suggestion can do is rearrange**. A model cannot delete a client's scope section
by leaving it out of a list, and that needs no trust to guarantee.

The result is still validated through `validateBlocks` on the way in, as
`saveDocument` does, because a document a client may be reading must not be
corruptible by a provider response.

## The refusals, and where they sit

- **Too little content** is refused *before* the gateway. A suggestion saying
  there is nothing to rearrange still costs a provider call and a ledger row.
- **No ledger row behind the suggestion** is refused with a sentence rather
  than left to the CHECK. Phase 119: a refusal a person can act on. The
  alternative is a constraint violation surfacing as a 500, or — worse — the
  document being written as hand-made.
- **Permission** before everything, on `proposals:manage`.

`markAccepted` runs **last**, inside the same transaction, which is
`suggestions.ts`' own rule honoured rather than restated: a suggestion is never
marked accepted for an action that did not happen.

## The permission, which the first draft wrote out instead of looking up

`suggestLayout` asked for `proposals:manage`. One `Designer` serves proposals
and marketing creative — spec §8 asks for *"the same design engine"* — and
`documents.ts` already had the single answer to which role may edit which kind,
in a private `permissionFor(kind, level)`. Writing the answer out again refused
a marketer the right to reorder the creative they had just written. Two answers
to one question is the defect, so `permissionFor` is exported and both paths ask
it.

Every document in the phase's test file is a *marketing* document, and every
test passed with the wrong permission anyway, because the fixture actor is an
owner and owners hold everything. Phase 121 again: a permission check only ever
asked of somebody who holds every permission is not a check. There are now two
tests with narrower roles.

The apply path checks too, and separately. `getSuggestion` reads by tenant and
asks nothing about role, so without a check there a reader holding a pending
suggestion's id could reorder somebody's proposal. Proposing and applying are
two requests, and what the first actor was allowed to do proves nothing about
the second.

## Two things writing the tests found

**The mock provider had no heuristic for `design`,** so every call returned
`ok: false` with *"the mock provider has no heuristic"*. The mock is not a stub
— it exists so the whole suite exercises schema validation, the suggestion
queue, the approval flow and metering with no key and no network — and a
feature it cannot answer leaves all of that untested. It now orders blocks by
type: cover, the written scope, the price, the terms and the signature.

Its rationale had to be corrected to match what it can actually justify. The
first draft claimed it put the terms after the price; the rank table ranks a
*heading* with other headings, and the fixture's "Terms" heading is a heading.
The heuristic sees two headings and has no opinion about which is which, and
reading the heading text to form one would be a guess dressed as a rule — so
the sentence says what the types support and the test asserts the order that
follows, "Terms" before "Scope of work" and all.

**Five tests used `if (!suggested.ok) return` as a type guard,** which is also a
way to pass without testing anything. They did: the gateway was switched off for
the fixture company — `settings.ts`' deliberate off-by-default, §23 — and two
tests failed loudly while five passed in silence. They now assert before they
narrow, and one more test asserts the blocks actually *moved*, because Phase 121
applies to a reorder that returns its input unchanged.

## What this does not do

**No image generation, and no `ai-generated` origin in production yet.** §11
does not ask for pixels, so nothing here produces them. `'ai-generated'` stays
in the registry because it accuses: it is the value an image model would have to
claim, and a lattice missing its top is a lattice that understates.

**It does not stop at the service.** The first draft of this ADR said the panel
was the next slice, which would have left `suggestLayout` and
`applyLayoutSuggestion` with no caller — Phase 49's defect, and the exact
situation Phase 139's `PENDING_WIRING` register exists to record rather than
tolerate. Re-opening that register for a core whose only blocker was a button
would have been using the device to excuse the thing it was built to accuse,
so the button exists instead: `suggestLayoutAction` and
`applyLayoutSuggestionAction` in `src/app/actions/ai.ts`, and a panel in
`Designer` that shows the proposed order with the moved blocks marked, the
rationale, the image prompts as text, and two buttons.

The button is **absent** rather than disabled when the AI module is off, which
is `aiAvailable`'s own argument: §23 makes AI additive, and an affordance that
is always greyed out is clutter rather than an addition. It is also disabled
while there are unsaved changes, because the assistant reads the saved document
and proposing an order for blocks the author has already moved would be
answering a stale question.

"No thanks" calls `rejectSuggestion` rather than just closing the panel. A
decision log that records only acceptances is not a decision log.

## What is nominated next

**AI Strategic Account Assistant** — §11's last missing capability, with
`modules/marketing/segments`' strategic-account segmentation to read from. It
needs `'strategic_account'` in `ai_feature` and in `AiFeature`, which Phase 165
deliberately left out on Phase 157's rule.

> **Corrected by Phase 167.** `segments.ts` has `isStrategicAccount` only as a
> *segment field* — a boolean a marketing audience can be filtered on. There is
> no relationship data in it and nothing to summarize. The data this capability
> needs is in `engagement/communications.ts`, `engagement/timeline.ts`,
> `opportunity_activities`, `proposals`, and invoices reached through
> `customers.organization_id` — none of which ADR 0165 or this ADR mentioned.
> Reading §11's sentence also moved half the capability out of the module
> entirely: identifying a neglected account is arithmetic, so it belongs in a
> pure core that works with AI switched off. Same shape of error as the
> nominations Phase 164 corrected — a claim about what the code contains,
> written while reasoning about what the feature would need.

Then **§9's four analytics gaps** from ADR 0164's measured audit: average
proposal size, average time to decision, and `breakdownBy` over the
service/product and time-period dimensions.

Both are measured findings rather than reasoning about what should come next —
and both, on this phase's evidence, should be read against the spec sentence
before being believed.
