# 0199 — The last unmeasured sentence

**Status:** accepted
**Date:** 2026-11-08
**Phase:** 199

---

## Thirty-five phases, four deferrals

`docs/SPEC-AUDIT.md` has said since Phase 164 that §20's state is *"Phases 0–8
all have shipped work"*. ADR 0194 named it as the file's **last unmeasured
sentence**, and ADRs 0195, 0196, 0197 and 0198 each put something ahead of it —
each time for a good reason, and four times is a habit rather than a sequence
of good reasons.

So it was measured this phase, and ADR 0198 said in as many words that it was
being deferred rather than forgotten. That sentence is what made it hard to
defer a fifth time, which is the whole use of writing a deferral down.

## The sentence was the weakest reading available

*"Has shipped work"* is true of a phase if **anything** in it shipped. §20 is a
table of nine cells, each listing several deliverables:

> Phase 0 — Foundation | Repository audit, architecture, auth/tenant model,
> permissions, database conventions, audit logging, CI/CD, design system.

Eight things, and the audit's claim is satisfied by any one of them. This is
exactly the shape Phase 195 found in §11 — seven of seven *rows* and
twenty-five of thirty-three *functions* — and the same correction applies: the
unit that matters is the deliverable, not the cell.

Counted that way, §20 asks for **fifty-one** things.

## All fifty-one are built

| phase | deliverables |
| --- | --- |
| 0 — Foundation | 8 |
| 1 — Bookkeeping MVP | 8 |
| 2 — Reconciliation + Accounting Core | 6 |
| 3 — CRM + Proposal Pipeline | 6 |
| 4 — Proposal Designer + Company Studio | 7 |
| 5 — Marketing | 6 |
| 6 — AI Add-on | 6 |
| 7 — Industry Modules | 2 |
| 8 — Payroll/Tax/Advanced Integrations | 2 |
| **total** | **51** |

So the sentence holds in its strong reading as well as its weak one. **A
confirming measurement is still a measurement** — Phase 194 had to say this
when its own hypothesis came out wrong, and the alternative here was to go on
deferring §20 on the strength of nobody having looked.

What changes is not the verdict but what the verdict rests on: a register of
fifty-one named places instead of a sentence.

## What replaced the sentence

`PHASE_DELIVERABLES` carries, per deliverable, §20's **own words**, the files
that ship it, and an argument for why those files are that deliverable. The
test holds everything around the judgement:

- the register's keys appear verbatim in their phase's §20 cell;
- **no word of any cell is unaccounted for** — strip every deliverable and
  every declared non-deliverable out of a cell and only punctuation and
  conjunctions may survive;
- all sixty-nine named paths exist;
- every `because` argues by what shipped rather than that it shipped.

The second is the one that makes this a measurement rather than a list.
Containment alone proves the register claims nothing §20 does not; the leftover
check proves the other direction, and without it the register could cover two
items of an eight-item cell and pass — which is the §11 defect, in the register
built to prevent it.

### ADR 0194 was right about integers and wrong about judgements

> **It does not make the audit self-measuring.** One number is pinned; the
> prose around it is not, and could not be — "all 12 have a module" is a
> judgement about what counts as a module, and `PINNED_CLAIMS` measures
> integers.

Right about integers. The way round it is that a judgement can be **written
down once and then checked**: what counts as a module goes in `because`, and
what a test holds is the wording, the coverage and the existence of the files.
Whether the named file *is* the deliverable stays a person's job, and saying so
is what keeps this register from becoming the thing it replaced.

`PROPOSAL_COMPONENTS` did this to §7 in Phase 182. §20 is the same device on
the largest table in the specification.

### Three entries ship no code and say so

*Repository audit*, *architecture* and *database conventions* are Phase 0 acts
whose product is a decision, and their evidence is the document that records
it. A convention nobody wrote down is a convention the next person cannot
follow, so the document is the honest answer — and an entry pointing at a
module would be the register dressing a judgement up as a measurement.

A test asserts that exactly one entry is document-only, and that the other two
name a document **and** the tree it describes, which is the stronger claim: the
convention is written down and followed.

## Two things the measurement found

Neither is a missing deliverable, and both are the register's own kind of
defect.

### A comment excusing a hardcoded value by describing a UI that does not exist

`modules/mobile/operations.ts` passes `rememberVendor: false` when replaying a
queued categorization — correctly, since rule creation writes outside the
operation's transaction and `categorization_rules` has no uniqueness
constraint. It excused that with:

> The phone offers the checkbox only when online.

**False.** `m/review/deck.tsx` always goes through the outbox, online or not,
so the phone has never offered vendor memory at all. ADR 0134's rule — an
exclusion that *excuses* a site is worse than one that misses it — in a comment
rather than a register, and asserted by nothing.

Recorded as a decision rather than quietly corrected, because it is a
defensible one: a phone review deck is triage, one tap per card with the four
accounts just used to hand, and a second decision per transaction is what that
screen exists not to ask. The rule can be made on the desktop and
`applyToExisting` catches up whatever was categorized on the phone. Whoever
wants it there needs a unique index on a vendor-memory rule **first** — the
missing thing is the constraint, not the checkbox.

And the decision is now asserted: the queue is handed `rememberVendor: true`
deliberately and the test checks no rule appears. That distinguishes "the
schema drops it" from "the phone happens not to send it", which are
indistinguishable from the desktop and only one of which survives somebody
adding the checkbox. Verified by honouring the flag, which fails it.

### The register's first draft named four files that do not exist

`modules/tax`, `ai/layout.ts`, `brand/brand.ts`, `db/schema/bookkeeping.ts` —
every one written from what I expected the tree to look like rather than from
what it does. Sales tax lives under `payroll/`, which that entry now says out
loud so the next reader does not conclude it is missing.

The path check caught all four on its first run. That is the argument for naming
files rather than describing deliverables, and it is the second phase running
in which the register I was building found something in itself before it found
anything in the tree.

## What keeps it honest

`PINNED_CLAIMS` moved **17 → 18**, and the eighteenth is a *fourth* claim in
`docs/SPEC-AUDIT.md`: §20's deliverable count, pinned to the register's length.
Reword a §20 cell, and the register has to move; move the register, and the
audit's number has to follow.

Four of eighteen entries in one document is this register's own answer to which
file it most expects to go stale — and that document is the one this process
reads to decide what to do next.

## What this does not do

**It does not claim §20 is finished in any sense but its own.** Fifty-one
deliverables are built; the specification's other sections carry their own
measured gaps — §11's six remaining functions, §19's row-level security
installed and not switched on, §7's gradients and shadows refused by name. §20
is a plan, and a plan being delivered is not the product being complete.

**It does not measure depth.** *"AR/AP basics"* is one entry and Phases 122–145
are mostly its multi-currency arithmetic. The register says a deliverable
shipped, not how much of it, and the `because` fields are where that
distinction is made rather than hidden.

**It does not count the four joins from an unscoped primary**, still outstanding
from ADR 0198: three `from(companies).leftJoin(companyProfiles)` and the session
resolution, all guarded, none counted.

## Nominated for Phase 200

**The §11 functions §20 has now been measured against.**

§20 is done and §11 is the section with the largest measured shortfall left in
the audit: **25 of 33 functions**, recorded in Phase 195 and untouched since.
The eight are reusable proposal content, brand variations, logo ideation,
segment suggestion, follow-up timing, nurture sequences, campaign voice, and
Business Insights' *operational trends*.

Phase 195 sorted them and the sorting still holds: four are prompts with no
screen to put them on, two — segment suggestion and nurture sequences — are §10
work wearing an §11 label, one is campaign voice (`draftCampaignCopy` passes
the company name, the segment, the audience size and **no voice**, while the
proposal writer's prompt says *"write in the company's voice"* and is given the
catalogue to infer it from), and one needs a figure **chosen** rather than a
call made.

Campaign voice is the one to build: it is the cheapest of the eight, it is a
gap between two prompts in the same module where one does the right thing and
the other does not, and §11 asks for it in as many words — *"adapt content to
company voice"*. `brand/voice.ts` already exists, which is the first thing to
measure rather than assume.

Behind that: the four joins, and the asymmetry between the raw and builder
halves of the write census in how each narrows.
