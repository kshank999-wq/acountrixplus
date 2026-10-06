# 0168 — Four figures, and the one that was a field

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 168

---

## The nomination, and the sentence under it

ADR 0167 nominated §9's four remaining gaps from ADR 0164's audit. The audit
also said how much work they were:

> The first two are small and the second two are the same shape as the four
> dimensions that exist. Worth noting that *"average time to decision"* is the
> only one needing a fact nothing currently records per proposal — the others
> are re-groupings of data already there.

Measured, that is **backwards on both halves**.

**Average time to decision needs no new fact.** `proposals.sent_at` is written
by `sendProposal`; `proposals.decided_at` is written by `decideProposal` *and*
by `crm/acceptance.ts` when a client accepts through the public link. Both ends
have been recorded since Phase 3. Nothing computed the interval, which is a
different problem from nothing recording it.

**Performance by service/product needed one, and a screen.** `proposal_items`
carried `description`, a price and an optional `chart_account_id`, and **no
reference to the service catalogue at all** — so the only thing to group a line
by was the prose somebody typed, and "Kitchen fit-out" and "Kitchen fit out" are
two products. `invoice_lines` is the same, so the question could not be answered
from realised revenue either.

That is Phase 136's `a field` blocker exactly: a column *and* the screen that
fills it, because the path cannot ask the question. The proposal line form takes
free text and never offered the catalogue, so the id was not discarded — it was
never known.

Third instance of this error in the audit's lineage, after ADR 0164's
"geography analytics" and ADR 0166's "segments has strategic-account
segmentation". The pattern is now specific enough to name: **the audit's claims
have been reliable and its reasons have not.** It was right that these four
figures were missing; it was wrong about why, twice, in opposite directions.

## The figure that was already there, under a name that meant something else

The sharpest finding, and it was live on a screen.

`WinLossSummary.averageDaysToDecision` measured `closed_at - created_at` — the
whole deal, from first inquiry to close — and `src/app/crm/dashboard/page.tsx`
labelled it **"Days to decision"**. A deal that sat as a lead for three months
and was answered in a day read as ninety-odd days of "decision".

So §9's *"average time to decision"* was not merely missing. A different
interval was being reported under its name, which is worse than absence: a
missing figure prompts somebody to ask for it, and a wrong one is acted on.
Phases 110 and 125's defect, in a field whose own docstring said *"creation to
close"* while the screen said otherwise — the comment was right and nobody
compared it to the label.

Renamed to `averageDaysToClose`, which is what it measures, and the dashboard
says "Days to close". The new figure takes the name `averageDaysToDecision` on
`ProposalStats`, where it means what §9 means. Renaming rather than adding
beside it, because two fields whose names could each mean the other is the
defect and not the remedy.

## Average proposal size is not average won value

`winLossSummary` already reported `averageWonValueCents`: the mean
`expected_value_cents` of a **won opportunity** — a number somebody typed when
the deal was created.

§9's *"average proposal size"* is the mean total of a **priced document with
line items behind it**. The two measure different things and can differ by a
lot, and the gap between them is itself informative: it says how well the
business estimates.

Drafts are included, because a draft is a proposal somebody has priced; the
`byStatus` map is there for anybody who wants it narrower. And `decidedCount` is
returned beside the decision interval rather than left implicit, because a mean
over three proposals and a mean over three hundred are different claims and the
figure alone cannot tell them apart. The dashboard shows it.

## The period dimension groups on arrival, not on outcome

`breakdownBy` gains `'month'` and `'quarter'`, and they group on **`created_at`**
like every other dimension there — a cohort, not a calendar of outcomes.

The other reading is tempting and wrong. Keyed on the close date, a period's win
rate mixes deals that arrived years apart, and an **open deal has no period at
all** — so the open column would be empty and the rate would look like a
complete picture of a period while describing only its decided half. Keyed on
creation, a row says *"of the deals that arrived in this period, this is how they
have turned out"*, which is a claim the open column belongs in. There is a test
for exactly that.

It also matches `rangeConditions`, which already filters on `created_at`. A
filter and a grouping that disagreed about which date they meant would be two
answers to one question inside one function.

The key and the label differ on purpose: `2026-04` sorts and *"April 2026"*
reads, and one string cannot do both. The breakdown is sorted by won value, so a
caller wanting chronological order sorts on `key` — which works because the key
is zero-padded.

## Service is not a `breakdownBy` dimension, because the grain changes

§9 lists service/product next to salesperson and industry, and it is tempting to
add it as a fifth dimension. `breakdownBy` groups **opportunities**: its
`wonCount` is a number of deals. A service lives on a proposal **line**, and one
proposal can carry six products.

Returning a `BreakdownRow` from a service grouping would put line counts in a
field every other caller reads as deals — a false declaration of exactly the
kind this codebase keeps finding. So `serviceBreakdown` has its own row type
with `lineCount` in the name of every count.

**A line is attributed to its proposal's outcome**, not its opportunity's. A
proposal is the offer that named the product; if the deal was later won on a
second, different proposal, this product was in the one that lost.

**`expired` and `no_decision` count against the win rate**, which is deliberately
the opposite call from `winLossSummary` excluding dormant opportunities. The
reason differs with the grain: a dormant *deal* may still be alive, while an
expired *proposal* is an offer that ran out. Leaving them out would report the
win rate against only the proposals somebody chased to an answer, which flatters
it exactly where a business is weakest. Said in the code rather than left as an
inconsistency for somebody to find.

## The nullable column, and the group it forces

`service_item_id` is nullable because **a line typed by hand is a real line**. A
business quoting something it has never quoted before should not have to add a
catalogue entry first.

That has a consequence the report has to honour: uncatalogued lines are grouped
under *"Not from the catalogue"* and **shown**. A breakdown that quietly omitted
them would have a total that disagrees with `proposalStats.totalValueCents`, and
the person reading it would have no way to know which figure to trust. There is
a test asserting the two reconcile.

**No backfill.** Phase 165 backfilled `assets.provenance_origin` because every
existing row genuinely was uploaded by a person — a measured fact. This is Phase
157's case instead: matching an existing line to a catalogue entry by comparing
descriptions would be a guess asserted as a fact, and the rows it got wrong
would be indistinguishable from the rows it got right. A null says "nobody
recorded which product this was", which is true. Expect that group to hold
everything at first; the row labelled *"Not from the catalogue"* is the
measurement, not a gap in the report.

## The screen that fills it

A select on each proposal line, offered only when the company has a catalogue.
Choosing an item fills the description, the price and the revenue account, and
**all three stay editable** — a catalogue service quoted at a negotiated price is
still that service, and losing the link because the number moved would defeat
the point. Clearing the choice clears only the link, not the text, because
somebody who has edited a description into something else should not lose their
words.

Active items only, from `listServiceItems({ activeOnly: true })`: a deactivated
service should not be quotable, while the existing lines that point at one keep
their reference.

## What this does not do

**It does not add `service_item_id` to `invoice_lines`.** The same gap exists
there and the same column would close it, but the path is different — an invoice
line arrives from a proposal conversion, a time entry, a recurring template or
by hand — and threading it through four writers is a phase, not a postscript.
Recorded here rather than done quietly, because this ADR has just spent four
paragraphs on the cost of a claim nobody re-measured.

**It does not make the catalogue mandatory.** §9 asks to report by product, not
to force every line to be one.

## What is nominated next

**`service_item_id` on `invoice_lines`**, which turns the same question on
realised revenue rather than on offers — and realised revenue is the one a
business acts on at year end.

Then the **bullet-level pass** over the spec sections `docs/SPEC-AUDIT.md`
verified only at module level: §3–§8, §10, §12–§18. §9 and §11 were its two
enumerated sections and both have now been worked through; between them they
produced three false reasons and one figure reported under the wrong name, all
inside the parts of the audit that were *most* carefully done. The sections
checked at module level should be expected to be worse.
