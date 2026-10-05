# 0165 — What the client is told

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 165

---

## The nomination, which held

ADR 0164's audit found two of spec §11's seven AI capabilities missing and
nominated **AI Design Assistant** first, with a reason rather than a ranking:
§11 asks it to *"generate layout suggestions, brand-consistent variations,
background/graphic concepts, image prompts, and logo ideation; **preserve user
control and provenance**"*, and provenance is a data decision that should be
settled before a prompt is written.

First nomination in five phases that measurement did not have to correct. What
it did was sharpen it.

## What measuring found

**User control already exists and is well made.** `ai_suggestions` carries an
accept/reject decision, and `suggestions.ts` says why it records the person:

> the *person* who accepted, not the model, because the person is who decided

and a suggestion is never marked accepted until the ordinary service has
actually performed the action. §12's human-in-the-loop requirement is met.

**Provenance does not exist, and `ai_requests` is not it.** That table is §12's
*usage ledger* — tenant, user, feature, provider, model, tokens, cost, latency,
outcome. It records that a request happened and what it cost. It records nothing
about what was produced or where what was produced ended up.

Those are different questions, and conflating them is how a product ends up able
to bill for a generated image and unable to say which client proposal it is
sitting in.

## Two findings, and the rules they produce

### `assets.uploadedBy` encodes an assumption about to become false

Every asset today was uploaded by a person, so a nullable `uploaded_by` and no
provenance column together say *"a person put this here."* The first asset a
Design Assistant produces makes that a false declaration on every row carrying
it — Phases 110 and 125's defect, in the table whose contents get emailed to
clients.

It is also why the backfill can **assert** rather than guess. Every existing row
genuinely was uploaded by a person, so `'uploaded'` is a measured fact. Compare
Phase 157, which declined to backfill because what it would have asserted was
never recorded. Same question, opposite answer, and the difference is whether
the fact exists.

The migration then **drops the default**, which is the part that matters: keeping
it would mean a Design Assistant that forgot to set the origin got `'uploaded'`
silently — the false declaration reintroduced as a convenience. The compiler
caught `uploadAsset` the moment the column existed, which is the constraint
working before a test ran.

### Provenance that does not propagate is true once and false forever after

§11 asks for *"brand-consistent variations"*. A variation of an AI-generated
background is itself AI-derived; a flyer built from it contains AI-generated
material; the proposal embedding the flyer reaches a client. `assets` had no
derivation relationship at all — nothing was derived from anything — so the
moment the assistant existed, the chain it created would have had nowhere to be
recorded.

So `strongerOf` takes the join and `derivedProvenance` never uses the child's own
value alone. A person cropping an AI-generated background has authored a crop of
AI-generated material: `authored` would be true about what they did and false
about what the file contains, and the file is what is sent.

**The lattice ranks disclosure, not credit.** Someone who heavily edits a
generated image has done most of the work and the result still contains
generated material, which is what a client, a regulator or a stock licence cares
about.

## A disclosure the author can edit out is not a disclosure

The chain, measured: `assets` → a block's `assetId` → `design_documents` → the
rendered proposal → a client. A disclosure that stopped at the asset row would be
true and invisible.

So `disclosureForDocument` reads the blocks, joins the assets, and takes the join
of their origins — one generated background in a document of otherwise hand-made
work still discloses.

And it is **its own field** on `RenderInput`, not appended to `footerText`. The
footer is the author's to write; mixing a chosen string with a mandatory fact
would let somebody remove the second by editing the first. The layout draws it on
its own line above the footer, in the same muted grey, because a disclosure set
apart in bold reads as a disclaimer and one hidden in the footer text reads as
nothing.

## The constraint, deliberately bidirectional

A machine origin **requires** an `ai_request_id`; a human origin **forbids** one.

The first direction stops a claim nothing can check. The second is the one that
matters: without it, a row could carry an AI request and be disclosed as
human-made. A constraint beats a check (Phase 116), so the database refuses both
rather than `provenanceStands` being remembered.

Writing the test found that an **unknown** origin trips *both* constraints,
because `assets_provenance_matches_request` enumerates the four valid origins on
both branches and is therefore doing double duty as a whitelist. The test asserts
that one of the two refused it rather than which, because pinning the name would
assert an evaluation order nothing promises.

## The feature value the ledger had no room for

Also found by writing the test: `ai_feature` lists eight values — §11's five
implemented capabilities and no more. **There was no value for a design
generation.**

That mattered here rather than in the phase that builds the assistant, because
`assets.ai_request_id` is what makes a machine origin checkable. With no enum
value for design there was no honest way to write that ledger row at all, so the
provenance column could never have been populated — and the CHECK would have made
that loud rather than silent, which is the right outcome and not a usable one.

`'design'` only. `'strategic_account'` is §11's other missing capability and gets
its value in the phase that builds it, because Phase 157's rule is that an unused
declaration is kept when it accuses and deleted when it excuses — and that one
would do neither yet.

## What this does not do

**It does not build the assistant.** Nothing yet produces an asset with a machine
origin, so `disclosureText` is null on every proposal today. That is the point:
it will not be null *and silent* the day something does.

**It does not add a `deriveAsset` writer.** `derivedProvenance` is used by the
test and by nothing in production, because the thing that would derive an asset
is the assistant. Adding the writer now would be Phase 49's defect — a function
with no caller — and the register it would need is the assistant's to build.

Worth being honest that this leaves `derivedProvenance` one Phase-49 argument
away from being deleted. It survives on Phase 157's rule: it *accuses* — it is
the function that stops a derived artifact understating what it contains — and an
empty indictment is a form ready for use.

## What is nominated next

**The AI Design Assistant itself**, now that provenance is settled: the `design`
prompt, the generation path writing `ai-generated` assets against their ledger
rows, and `deriveAsset` getting its caller.

Then **AI Strategic Account Assistant**, which has
`modules/marketing/segments`' strategic-account segmentation to read from, and
then §9's four analytics gaps — both from ADR 0164's measured audit rather than
from reasoning about what should come next.
