# 0097 — The pointer nobody followed

**Status:** accepted
**Date:** Phase 97
**Amends:** ADR 0071 (the audit story), ADR 0096 (the merge) — whose Decision 3
carries a correction pointing here.

## The defect

Phase 96 gave the losing record a `merged_into_id` and justified the column in
its ADR and in `merge.ts`:

> It stays, archived, pointing at the record that absorbed it, so a bookmark, an
> export or somebody's memory of the old name still lands somewhere that
> explains itself.

That was false when it was written. `grep` finds exactly one use of the column
in the whole application, and it is the `set` in `mergeParties`. Nothing read
it. What somebody actually found was an archived customer with no documents on
it and no explanation — strictly worse than before the merge, when it at least
had its invoices. The record did not explain itself; it sat there looking like
an abandoned duplicate, which is precisely what Phase 94 exists to report.

Two smaller instances of the same shape came with it. `party.merge` was added to
Phase 70's vocabulary and never added to the audit story's `CORRECTION_ACTIONS`,
so the one screen that would explain a merge rendered the raw string
`party.merge` as a code. And the merge event recorded *that* rows moved without
recording *which*, so the trail could answer "five invoices moved" and not "did
**this** invoice move" — the question somebody actually asks, months later, when
a customer says an invoice was never theirs.

The correction is written into ADR 0096 as well as here, on Phase 91's
reasoning: a wrong reason written down is more dangerous than none, because the
next person builds on it. The claim described an intention as though it were
behaviour, and leaving it standing while quietly fixing the code would teach
whoever reads it next that intentions count.

## Decision 1: an archive and a merge are different acts and say so

`describeArchived` returns `"merged into Cascade Joinery"` where there is a
pointer and `"archived"` where there is not. Naming the surviving record rather
than saying "merged" leaves nobody where the missing pointer left them: knowing
something happened and not where to look.

The name comes from a **correlated subquery**, not a self-join, for the reason
Phase 92 gave for the same shape: a join can multiply rows, and a list screen
that silently doubled a customer because of a pointer would be a worse defect
than the one this fixes. A test merges two records into one and asserts the list
still has three rows.

## Decision 2: evidence of what moved belongs on the act, not on each thing moved

The merge now takes its ids from `returning "id"` on the update itself — no
second query whose answer could differ from what was written — and records them
on the merge event.

The alternative was an audit row per document. That is rejected: a merge of two
long-standing customers would write hundreds of rows saying the same thing on
the same day, burying every other entry in both records' histories and in the
company feed. The act is one act; what it touched is a property of the act.

Because the event is a JSON column and not a table, the ids are **capped at
500** — and the cap is recorded as its own `truncated` field rather than left to
be inferred from `ids.length === MOVED_ID_LIMIT`, which is wrong for a merge of
exactly 500. A truncated list that does not say it is truncated is worse than a
count, because somebody reading it concludes an invoice did not move when it
did. The count stays exact either way; only the list stops.

## Decision 3: an event may write a sentence about itself

The history entry for a merge read "Records merged" and named nothing. Browser
verification also showed it printing `Role nothing → absorbed` and `Side nothing
→ customer` — the audit payload describing its own filing, above the sentence
somebody actually wanted.

So `Told` gains a `summary`, written **where the facts are known** rather than
reconstructed in the story core. Only the merge knows it absorbed *Meridian
Facilities Ltd* and brought five records with it; a switch in `story.ts` guessing
that from an action name would be a second answer to a question the writer had
already answered. `summary`, `role` and `side` join `reason` in `NOT_A_CHANGE`,
because a history that reports its own plumbing is a history somebody stops
reading.

This is a general mechanism with one user today. That is deliberate and worth
saying: the alternative was the merge entry naming nothing, and a mechanism
narrow enough to be honest is better than a screen that lies by omission.

## What this did not do

**It does not build an unmerge.** The ids now exist, which is what ADR 0096 said
was missing, but having them makes a reversal *possible*, not *correct*. What
should happen to an invoice raised against the combined record afterwards, or a
payment allocated across documents from both sides, is undecided — and deciding
it is the whole of that feature, not a detail of it.

**It does not link the archived record to the survivor.** The row says where it
went; it is not a link somebody can click. The people screen has no per-record
page to link to, and inventing one for this would be a bigger phase wearing this
one's clothes.

## What the next phase might take

The merge moved a customer's documents and said nothing to the customer. A
statement sent the following month covers invoices that were, until last week,
addressed to a differently-named account — and Phase 55's statement has no idea
that happened. Whether the customer should be told, and by what, is a real
question this application currently answers by not noticing it was asked.
