# 0096 — The merge that has to move everything

**Status:** accepted
**Date:** Phase 96
**Amends:** ADR 0070 (the correction vocabulary), ADR 0094, ADR 0095.

## The defect

Phase 95 taught the customers screen to explain a shared address and say what
could be done about it. For two records that had both traded it said **merge** —
and the application had no merge.

That was honest and it was a dead end, on the case most worth fixing: two live
customers on one inbox, both being chased, neither letter saying which account
it is about. The screen had learned to describe the problem precisely and still
ended with a shrug.

## Decision 1: a merge that misses a table is worse than no merge

Twenty-two places refer to a party — fourteen to a customer, eight to a supplier
— and they arrived one phase at a time across ninety-five phases. A merge that
repoints twenty-one of them leaves a document attached to a record the screens
have hidden. That is not a visible failure somebody can act on; it is an invoice
that has quietly stopped existing, found months later by somebody reconciling a
balance that will not tie. And it is *irreversible*, because the record it came
from was archived by the same operation.

A merge that refuses to run is a nuisance. A merge that half-runs is data loss.

So `PARTY_REFERENCES` names every one, and a test reads `pg_constraint` and
fails when it finds a foreign key the list does not mention. Two further tests
check that every registered name exists and that every table it touches has a
`company_id` to scope the update by — the worst possible failure of this
function being one that crosses tenants, and the cheapest to rule out.

**The list is written by hand on purpose.** Deriving it from the catalogue would
never be wrong, and would also never involve a person: a new column would join
the merge without anybody deciding it should. The hand-written list plus the
tripwire gives both — the decision is explicit, and forgetting it is loud. The
tripwire was checked by deleting an entry and watching it fail with the column
named.

## Decision 2: a correction that cannot be undone must say why

Phase 70's `Reach` asks what a correction disturbs: money, somebody outside, or
only our own screens. A merge is the third — nothing leaves, no letter goes out
— so under the rule as written, no reason would be asked for.

That is the rule reaching its edge, not the merge being an exception. Every
other correction on that list can be taken back by the person who made it. This
one cannot, and the reason is the only surviving record of **why somebody
believed these two were one business**: afterwards there is one record, and the
question cannot be put again.

So `Reach` gains `cannot_be_undone` and the rule gains a clause. `mustSayWhy`
still reads `!== 'internal'` rather than listing the kinds that require one, so
a fifth reach added later has to be argued into silence rather than falling into
it. Phase 70's own words for why the field exists — *"so the next correction
somebody adds has to answer the question that matters rather than copy a flag
from the row above it"* — are exactly what happened here.

## Decision 3: the losing record is archived, not deleted

It stays, archived, pointing at the record that absorbed it. Deleting it would
destroy the only evidence the merge happened.

> **Corrected in Phase 97.** This section originally went on to claim that the
> pointer meant "a bookmark, an export or somebody's memory of the old name
> still lands somewhere that explains itself." That was false when written:
> `merged_into_id` was set by `mergeParties` and read by nothing at all, so what
> somebody found was an archived record with no documents and no explanation —
> worse than before the merge, when it at least had its invoices. The claim
> described an intention as though it were behaviour. Phase 97 made it true.
> The correction is left here rather than the sentence quietly edited away,
> because a wrong reason written down is more dangerous than none: the next
> person builds on it.

Two database constraints rather than service discipline: a merged record must
be archived, and cannot point at itself. A merged record still appearing in
pickers would be a live customer with no documents on it — precisely the
duplicate Phase 94 exists to report, manufactured by the thing meant to fix it.

The merge is recorded on **both** records. The surviving one needs it most:
without it, its history begins mid-story with documents that were never raised
against it.

## Decision 4: it shows its work first

`mergePreview` counts what would move, from the same registry the merge walks,
and the panel prints it: *"5 records (4 invoices, 1 recurring invoice) will move
to Bremen Hafenbau GmbH, and Meridian Facilities Ltd will be archived. This
cannot be undone."*

The preview is deliberately slightly stale — a colleague may raise an invoice
between reading it and pressing the button — which is why the merge recounts as
it goes rather than trusting those numbers. A preview that pretended to be a
guarantee would be worse than one that is honest about being a preview.

Browser verification produced *"1 recurring invoices"*, which is fixed, and the
fix is asserted rather than assumed: a test proves that dropping a trailing `s`
gives the right singular for all twenty-two names, so a table with an irregular
plural fails there instead of printing "1 people" at somebody.

## What this did not do

**It offers no three-way merge.** Three records on one address is a sequence of
decisions, and a control that merged all of them would be making two of those
decisions on somebody's behalf. The panel appears only for a pair.

**It does not decide which record survives.** Phase 95 refuses to say two
records are the same business, and so does this. A person picks, and the reason
they type is what says so.

**It does not merge contacts or organisations.** Two CRM contacts on one address
remains normal and unreported, as Phase 94 left it.

## What the next phase might take

A merge is now the one correction in the vocabulary with no way back, and the
audit trail records enough to *explain* it but not enough to *reverse* it: the
rows that moved are counted per table, not identified. Whether that is
acceptable is a real question — every other correction here can be undone, and
this one was given a reason box instead. Recording the moved ids would make an
unmerge possible; whether an unmerge is a feature a bookkeeping system should
have, given what may have been posted against the combined record in the
meantime, is the decision that phase would have to make first.
