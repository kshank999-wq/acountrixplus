# 0200 — A voice to adapt to

**Status:** accepted
**Date:** 2026-11-08
**Phase:** 200

---

## The nomination, and the two things in it that were wrong

ADR 0199 nominated §11's *"adapt content to company voice"* as the cheapest of
the eight functions Phase 195 found unbuilt, and said:

> it is a gap between two prompts in the same module where one does the right
> thing and the other does not […] `brand/voice.ts` already exists, which is
> the first thing to measure rather than assume.

Measuring found both halves of that wrong.

`brand/voice.ts` is about **whose name goes on a letter** — the module Phase 74
wrote after finding that a company's marketing went out from *"Accountrix
Plus"* when its profile was blank. Nothing to do with tone.

And the prompt that *"does the right thing"* does not. `proposal.draft` v1
says:

> Write in the company's voice, not a marketing voice.

and is handed the company's name, its industry and its **service catalogue**.
It was inferring voice from a price list, under an instruction that reads as
though the material had been supplied. The marketing prompt's absence of that
instruction was the honest half of the pair.

The nomination's own instruction to measure rather than assume is what caught
both, which is the only reason to write such an instruction down.

## Three links, each hiding the next

| | |
| --- | --- |
| **no editor** | `companyProfiles.description` had a column, a service that accepted it, and **no field in `PROFILE_FIELDS`**. Nobody could fill it in. |
| **not loaded** | `companyContext` selected the whole profile row, exposed `tagline` — which **no caller had ever read**, since Phase 6 — and never loaded `description`. |
| **not asked** | `draftCampaignCopy` loaded all four `CompanyContext` fields and passed **only the name**. `marketing.draft` said nothing about voice. |

Building from the nomination alone would have added `{{voice}}` to a prompt and
fed it an empty string: the Phase 160 shape, and the same near-miss as Phase
194's prompt-caching no-op. The order these had to be closed in is the finding,
because from any one of them the other two are invisible — the field looks
unused because nothing loads it, the loader looks harmless because nothing
reads it, and the prompt looks like it simply was not asked for.

There was also a sentence: `studio-workspace.tsx` describes the Studio as
covering *"imagery, **company description**, service catalog, team bios,
certifications"* — a field the form did not have. Prose describing a UI that
does not exist, which is **Phase 199's mobile comment one phase later in a
different file**.

## What changed

The editor first, because without it the rest is a no-op. Then `description` on
`CompanyContext`, then `renderVoice` — the tagline and the description as one
block — then both prompts at **version 2** with their v1s retained, since
`resolvePrompt` takes the highest and the gateway writes `promptVersion` into
every `ai_requests` row (Phase 195's rule).

`proposal.draft` v2 keeps v1's instruction unchanged and is given the material
it already assumed. That is the honest edit: the instruction was never wrong.

### Two decisions inside `renderVoice`

**The services catalogue is not in it.** Voice is what a business says about
itself, not what it sells; the catalogue has its own placeholder in the
proposal prompt. Conflating the two is how v1 came to claim an instruction it
had no input for.

**Nor is the industry**, and this one was found by a failing assertion rather
than decided up front. The block was supposed to be absent for a company that
has written nothing, and it was not — because every registered company has an
industry, picked from a list *by us* to choose a chart of accounts. A
classification is not something the business said, and including it made a
section that is meant to disappear never disappear.

## The tripwire named two more on its first run

The check written for this phase asserts `PROFILE_FIELDS` against the
profile's own columns, with exclusions declared. It immediately reported
**`addressLine2` and `country`**.

Both are worse than `description`, because both have a **reader**:
`letterhead.ts` puts them on the company's address on every document a client
sees. So a business with a second address line, or an address outside its own
country, could not put it on its own letterhead — and nothing anywhere said
so. A column with a reader and no writer is Phase 49's shape, and this is the
first time this project has found three at once.

Both have fields now. The register-shaped check is the whole reason: fixing the
column I had noticed would have left two I had not, and I would have reported
the phase as complete.

## What this does not do

**It does not build the Marketing row's other three.** Segment suggestion and
nurture sequences are §10 work wearing an §11 label, and follow-up timing needs
a figure chosen rather than a call made — Phase 195 sorted them and the sorting
holds. §11 goes **25 → 26 of 33**.

**It does not give the email a voice it can act on beyond prose.** The block is
two sentences a business wrote. A model asked to match formality from two
sentences will do it unevenly, and nothing here measures how well — what is
asserted is that the material reaches the prompt, which is what was false.

**It does not check that `description` is filled in.** A company that leaves it
blank gets the block omitted and an instruction to invent no character for
them, which is the right failure. Prompting a business to describe itself is a
Design Center question, not this one.

## What the registers reported

`PINNED_CLAIMS`' §11 prompt-key count did **not** move, and that is Phase 195's
decision paying off: it was pinned on distinct **keys** rather than entries
precisely because a new version of an existing prompt is not a new capability.
Two v2s, ten keys, number unchanged.

The §11 function count in `docs/SPEC-AUDIT.md` moved 25 → 26, and the
prompt-version contiguity assertion Phase 195 added — every key's versions
running from 1 with no gaps — now covers three keys with two versions each.

## Nominated for Phase 201

**The columns with a reader and no writer, measured as a class.**

This phase found three by accident of writing one check, and two of them reach
every document a client sees. That is no longer a coincidence worth closing
one at a time: `PROFILE_FIELDS` is one form of many, and the same question —
*which columns does something read that nothing lets a person fill in?* — can
be asked of the whole schema.

The method is Phases 196–198's, which worked four times: build the expected set
from the schema and the source independently of any one screen's vocabulary,
and compare. A column is **writable** if a form field, an importer, a service
input or a seed sets it; **read** if any module selects it. The interesting set
is read-and-not-writable, and the answer is a number nobody has.

Two cautions from this phase. Some columns are legitimately system-set —
`createdAt`, digests, `companyId` — so the scan needs a declared exclusion list
and the exclusions have to argue, or it will be a register that excuses rather
than one that misses. And `credentials` on this very profile is a structured
list with its own editor, so "has a field in a `*_FIELDS` array" is too narrow
a test of writable: the scan has to look for a writer, not for a text input.

Behind that: the four joins from an unscoped primary (ADR 0198), and §11's six
remaining functions.
