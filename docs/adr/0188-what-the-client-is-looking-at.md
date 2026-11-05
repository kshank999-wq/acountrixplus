# 0188 — What the client is looking at

**Status:** accepted
**Date:** 2026-11-05
**Phase:** 188

---

## The nomination did not hold

ADR 0187 nominated §7's *"comments/questions"* on the client link, quoting ADR
0173's audit row: *"No table, column or module. The link tracks views and takes
an acceptance; a client cannot ask a question through it."*

**Phase 174 built it.** `src/app/p/[token]/question-panel.tsx`, 143 lines,
wired into the public page, storing the thread as `communications` entries, and
closing the box once the proposal is decided. Its docstring even opens *"The
client-facing question box (spec §7, Phase 174)"*.

The audit row was true when written and nobody struck it through. Three ADRs —
0185, 0186, 0187 — carried it forward in their nomination lists without
re-measuring. Phase 164's rule, in the file that records nominations: **a
nomination inherited is a nomination unmeasured.** The rule was stated about
other people's nominations; it applies to one's own.

## So the bullet was measured instead

§7 says: *"Client-facing link with view tracking, acceptance/e-signature
integration, comments/questions, version history, and PDF download."* Five
things, measured the way Phase 182 measured §7's twelve components.

| | on the client link |
| --- | --- |
| view tracking | `recordView` on every open (Phase 21) |
| acceptance | `AcceptancePanel`, `proposal_acceptances` |
| comments/questions | the question panel (Phase 174) |
| **version history** | **nothing** — the company sees versions in its own list; the client sees none |
| PDF download | `/p/<token>/pdf`, the issued bytes |

Four of five. And finding out why the fifth was missing turned up something
much larger, which is what this phase is actually about.

## ADR 0021's seventh decision was a heading, not a fact

> ### Decision 7: the public link serves the snapshot, never a live render

The paragraph under that heading says a client *"downloads what they were
sent"*, and that was true: `/p/<token>/pdf` serves the issued bytes. The
**heading** claims something larger. `README.md` copied the heading.

The page served live rows: live `proposal_items`, live `discountCents` and
`taxCents`, live `designDocuments.blocks`, live `brandKits`. And
`updateProposalItems` takes `proposals:manage` and checks no status — the
designer's `isEditable` is a property of that screen, not of the system.

Measured rather than reasoned about:

```
sent total (snapshot):      100000
live item after an edit:    120000
accepted total:             120000
filed against version 1, whose snapshot says 100000
```

Send at £1,000, edit the items to £1,200, and the client's page shows £1,200
while the PDF in their inbox says £1,000. `acceptProposal` recomputes
server-side — correctly refusing to trust the browser's total, and trusting a
server-side figure that had moved since the send — and files the acceptance
against the latest version, whose snapshot says something else.

**A signature on a figure the client was never sent, attached to a document
that says a different number.** That is the worst shape this CRM can have, and
Phase 21 had already made the argument against it about a different artifact:
*"restyling proposals in June silently restyled every proposal ever sent."* It
stayed true of the thing a client actually opens.

## One reader, because three is how this happened

The page, the acceptance and the PDF each assembled their own idea of "the
proposal" from whatever rows were nearest. That is the shape of the defect
rather than an accident of it: three readers of one question answer it three
ways eventually, and two of them already did.

`modules/crm/client-link.ts` is now the only answer. `acceptProposal` reads the
same function the page renders from, which is what makes the total it records
and the total on the page the same number **by construction** rather than by
agreement.

### The snapshot grew two things

**Item ids.** A client ticking an optional line sends its id back, and the
acceptance has to recognise it. Matching against live rows was the old answer
and is precisely why the wrong figure could be signed for: `updateProposalItems`
deletes and reinserts, so after an edit the live ids are different ids for
different prices.

**The document.** Blocks, page setup, and the brand kit's values as they were
at send. Not a reference to the kit — the kit is edited in the Design Center,
which is the whole failure mode.

Both go into the existing `jsonb` snapshot, so there is no migration.

### What stays live, deliberately

Three things, each a fact about *now* rather than about what was offered:
whether the proposal has since been decided, the question thread, and the
client's own name in a merge field. Freezing those would freeze the wrong
thing — a client should not be told a proposal is open after it was withdrawn.

## Versions written before today

They have figures and no ids, and no document. There is nothing to be done
about that, so they fall back to the live record — the behaviour this phase
exists to end — and the view **says which it is**: `itemsFromSnapshot` and
`documentFromSnapshot` are on the returned shape and are false for those rows.

A silent fallback to the defect would be worse than the defect, because it
would look fixed. Two tests hold that distinction.

## A finding stated rather than closed

`proposalByToken` does not filter by status, so **a draft proposal's public
token serves the full page** to anyone holding it. The token is 24 random bytes
and only reaches a client on send, so it is not a practical exposure — and the
designer's *"Preview client view"* link depends on exactly this behaviour.

`clientFacingProposal` returns `null` for an unsent proposal, because the
question it answers is "what was this client sent" and the answer is nothing;
the page falls back to the live render it has always had for that case. Closing
the exposure means giving the author preview its own route, which is a
different change. Asserted in a test so the next person meets the fact rather
than discovering it.

## The register reported its own drift, one phase later

Phase 187 moved the isolation scans into a module so `PINNED_CLAIMS` could
measure the sentence quoting their numbers, after five phases of correcting it
by hand.

This phase added five reads. The test failed with:

> `src/modules/tenancy/isolation.ts` says 567 where number 1 of this sentence
> should be 569.

First phase after the fix, exactly the case it was built for, naming which of
the four numbers moved. The sentence is now a sentence that reports itself.

## What this does not do

**Version history on the client link is still missing**, which is the fifth
item of §7's bullet and the thing this phase set out to measure. The
groundwork is here — `clientFacingProposal` already finds the version a client
is looking at, and `proposal_versions` holds every earlier one with its PDF —
so what remains is a list on the page and a decision about whether a client may
read a superseded version or only know that it existed. That decision is worth
its own phase rather than a guess at the end of this one.

**Nothing stops a sent proposal being edited.** It is now harmless to the
client, which is the half that mattered, but the company's own screens still
show the edited figures against a proposal whose client sees the old ones. The
honest fix is for an edit after sending to be a visible act — a revision that
must be re-sent — and that is a workflow decision, not a rendering one.

**The PDF path is unchanged.** It already served the issued bytes, which is the
one thing ADR 0021's decision 7 got right.

## Nominated for Phase 189

**Version history on the client link**, the fifth item, now that the other four
are measured and the plumbing exists.

The decision to make first is what a client may see of a superseded version.
Showing every earlier PDF is one answer and is probably wrong — a negotiation's
earlier prices are not obviously the client's to re-read at will — while
showing nothing is what the page does today and is what §7 asks to change. The
middle, and the likely answer, is that a client sees *that* there were earlier
versions and when, with the current one rendered: enough to know the document
was revised, which is what the bullet is for.

Behind it: SVG import/export, artboard affordances and vector primitives — the
last three of ADR 0173's eight, all §7's Illustrator-class work, which §7
itself defers.
