# 0085 — The culprit the digest could not name

**Status:** accepted
**Date:** Phase 85
**Amends:** ADR 0084 (sending reputation), ADR 0083 (delivery outcomes).

## The defect

Phase 84 watches a company's bounce and complaint rates and says something when
they cross the line mailbox providers care about. Its verdict is **company-wide**
and the cause almost never is: one badly-sourced list, one import from a
conference badge scanner, one campaign to a segment nobody had mailed in three
years. The digest said the domain was in trouble and left the reader to work
out which send did it — from a per-campaign bounce rate that has existed since
Phase 5 and that nobody has a reason to open until they already know something
is wrong.

Knowing to worry and knowing what to stop are different facts, and only the
second one can be acted on.

## Decision 1: a culprit is a counterfactual, not a maximum

The obvious implementation is "name the campaign with the worst rate". It is
wrong, and wrong in the way that matters: **the worst rate in any window will
usually belong to the smallest campaign in it.** Three bounces out of eight is a
37% bounce rate and moves a company sending four thousand messages a week by
four hundredths of a per cent. Naming it sends somebody to audit a list that is
not the problem while the real cause keeps sending.

So the question asked is the one a person actually has: **would we still be over
the line if this campaign had not gone out?** Rank by how much removing a
campaign improves the company's rate, and the materiality test comes free — a
campaign too small to matter cannot move the number, so it is never named. No
arbitrary volume floor is needed, which is why there is not one.

`explainsIt` then reports whether the counterfactual actually clears it. A
campaign can be the largest single contributor and still not be the whole story,
and telling somebody to stop one send when the list is broadly rotten would be
worse than telling them nothing.

## Decision 2: naming somebody has to be worth acting on

The first version of the rule was "worse than the company's own rate", and the
**browser check found it insufficient** — the unit tests had not, because they
were written with the campaigns exactly equal.

Two equally bad campaigns plus a little clean traffic makes *both* of them worse
than the average they are pulling up. So one was always named, and stopping it
would have moved the rate from 11.9% to 11.8%. Naming a campaign says *stop this
and it gets better*; that sentence was not true.

A culprit now also has to be **material**: removing it must move a rate by at
least one watch threshold's worth — two points of bounces, or a tenth of a point
of complaints, or a mix. Measured in threshold-widths rather than raw basis
points for the same reason the ranking is: 0.1% of complaints and 2% of bounces
are the same size of problem, and ranking on the raw numbers lets a small bounce
movement outvote a large complaint one every time.

Where no campaign clears that bar, the answer is **`null`**. A uniformly bad list
has no culprit, and the biggest campaign in it is the biggest campaign rather
than the cause. Saying a name is a claim, and there has to be an answer that
declines to make one.

## Decision 3: one definition of what a provider accepted

Found while writing the per-campaign query, and the reason it was hard to see:
all three answers lived in the same file.

| | denominator | verdict |
| --- | --- | --- |
| `campaignStats` | not `skipped`, `failed`, `pending` | right |
| `sendingCounts` | not `pending`, `skipped`, `failed` | right, said differently |
| `marketingOverview` | not `skipped`, `bounced`, `pending` | **wrong twice** |

`marketingOverview` was never revisited when Phase 83 introduced `failed`, so it
counted rows a provider had refused outright as *sent*, and it dropped the
bounced rows — which a provider **did** accept — out of the denominator. Every
rate on the marketing dashboard was computed against that. It is the same defect
this project keeps finding: two answers to one question, here with a third for
company.

There is now one list, `ACCEPTED_BY_PROVIDER`, applied as `wasAccepted` in
TypeScript and as the same fragment in SQL.

**An allow-list, not the `NOT IN` it replaces.** A status added to the enum and
forgotten here falls *out* of the denominator, which makes every rate look worse
than it is — a false alarm. The deny-list failed the other way, quietly
enlarging the denominator and hiding a real problem, and ADR 0084 exists because
the missed alarm is the expensive mistake.

## What this did not do

No schema change and no migration; this is a group-by over rows Phase 5 has been
writing since the beginning.

The breakdown query runs **only when there is something to attribute** — the
verdict is not `null` and not `ok`. A company whose sending is fine, which is
nearly all of them nearly always, pays for one query rather than two.

It still does not act. ADR 0084 declined to pause a campaign on a threshold this
application chose, and knowing *which* campaign does not change that argument:
it makes the sentence more useful, not the decision ours.

## What the next phase might take

The window is fixed at seven days and the verdict has no memory. A company that
looks at this page today cannot tell whether 3% is this week's accident or the
fourth week of a slide, and those call for different actions — the first is a
list to check, the second is a domain to worry about. Every run of the digest
computes the number and throws it away; nothing writes it down, so the one
question a reputation metric exists to answer — *is this getting better or
worse?* — is the one question the page cannot answer.
