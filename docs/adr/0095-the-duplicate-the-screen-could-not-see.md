# 0095 — The duplicate the screen could not see

**Status:** accepted
**Date:** Phase 95
**Amends:** ADR 0056 (retiring a party), ADR 0094 (the address two customers share).

## The defect

Phase 94 taught the nightly register to report *"2 customers share
accounts@cascade.test: Cascade Joinery, Cascade Joinery Ltd."* — a real problem,
named, on a page somebody reads.

And then it stopped. The person reading it went to the customers screen, found
both records by hand, and had to decide which one the invoices should have gone
to with nothing in front of them but two names that look alike. The register
found the problem; the screen where it would be fixed did not know the problem
existed.

That is not a small gap. A finding nobody can act on decays into a finding
nobody reads, which is the same failure ADR 0033 was written to prevent one step
further along.

## Decision 1: a record with a document on it is history, and history is merged

This is the whole rule, and it is deliberately one rule rather than a ladder of
cases.

A customer nobody has ever invoiced is a **mistake** — somebody typed the
business in twice, or a lead arrived under a name that already existed. It
carries no evidence, so retiring it loses nothing and ends the ambiguity
outright.

A customer with even one settled invoice from four years ago is **evidence**.
Archiving it does not delete it, but it does not fix anything either: the
history stays attached to a separate identity, and *"what did this business buy
from us"* still has two answers. Putting those two answers together is a merge —
a real feature with real consequences for the ledger — and this application does
not have one. Phase 94's ADR said so, and this phase does not quietly walk it
back by dressing an archive up as a fix.

So `resolve` returns one of three answers: **retire the empty ones** when
exactly one record has traded, **merge** when two or more have, and **choose**
when none has. Under `merge`, nothing is offered for retirement — not even the
settled record that ADR 0056's `deactivationCheck` would happily deactivate.
Offering it would be the application recommending that somebody hide half of a
customer's history.

## Decision 2: it never says the two records are the same business

They share an inbox. That is all anybody knows, and it is exactly why Phase 94
made the finding a position rather than a fault: a parent and its subsidiary
genuinely may share an accounts inbox and genuinely are two customers.

So every sentence the screen shows is about what a record *carries* — invoiced
or never invoiced, open or settled — and the identity judgement is left to the
person, who is the only one who can make it. A test asserts the wording never
reaches for *duplicate* or *the same customer*, because that is a claim that
would be wrong exactly when getting it wrong matters most. An application that
guessed and archived the wrong one would be destroying somebody's customer
record on the strength of a matching email address.

## Decision 3: the evidence is shown, not just the conclusion

The panel prints each record's standing — *never invoiced*, *has documents,
nothing outstanding*, *open documents or money held* — above the advice.

"Never invoiced" is a fact somebody can check against the row two inches below
it. "Archive this one" is a conclusion they would otherwise have to take on
trust, from a screen that has just told them it cannot tell whether the two
records are the same business.

## Decision 4: no second query, and no second name

The page had already loaded everything the judgement needs. `PartySummary` has
carried the full footprint since Phase 56 — every document ever, what is open,
what is held — so the resolution is computed from the rows already on the page.
Asking the database again for facts already in hand would be a second answer to
one question, and the two would disagree the moment somebody raised an invoice
between the queries.

The same reasoning removed `name` from `Footprint` mid-build, when a test caught
the core silently preferring one of two names for the same party. The clash
names its parties; a footprint is what a record *carries*. Two sources for one
name is the same defect in miniature, and it was only visible because the test
supplied names that disagreed.

## What this did not do

**It still does not merge.** The check reports, the screen explains, a person
decides. Nothing here moves a document from one customer to another.

**It does not add an action.** Archiving already exists on the row, from Phase
56, with its own refusal when there is open business. Adding a second archive
button inside the panel would be a second path to one outcome — and the one in
the panel would be the one that had not been through Phase 56's check.

**It does not look at contacts.** Two CRM contacts on one address remains normal
and unreported, as Phase 94 left it.

## What the next phase might take

`resolve` says *merge* and the application has no merge. That is honest, and it
is also a dead end for the reader: two live customers on one inbox is the case
most worth fixing and the only one the screen answers with a shrug. What a merge
would actually mean — which documents move, what happens to the audit trail on
both records, whether the losing record survives as an alias — is unbuilt, and
undecided.
