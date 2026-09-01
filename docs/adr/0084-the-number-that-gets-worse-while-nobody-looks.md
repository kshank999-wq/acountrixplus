# 0084 — The number that gets worse while nobody looks

**Status:** accepted
**Date:** Phase 84
**Amends:** ADR 0024 (the failure digest), ADR 0083 (delivery outcomes).

## The defect

Phase 83 made a bounce a real thing for the first time — a hard bounce
suppresses the address, and the rate is measurable. Nothing watched it.

Phase 24 built a digest that tells somebody when a background job has given up,
under a rule worth restating: *one message a day, with a count, and nothing at
all when the count is zero. Silence has to mean something.* A rising bounce rate
is a fact of the same kind, and a worse one, because **it is the only failure in
this application that gets worse while nobody does anything about it.** A dead
job is still there tomorrow, unchanged, waiting. A sending domain is not:
mailbox providers score a sender over weeks, and by the time the symptom is
visible — campaigns quietly "not arriving" — the reputation that has to recover
has already been spent.

And it is invisible from this end. Nothing errors. Nothing fails. The mail is
accepted, delivered to a mailbox that rejects it, and filtered thereafter.

## Decision 1: a rate needs a denominator

The judgement this phase is really about, and the reason it is a core rather
than a query.

One bad address in a ten-recipient campaign is a **10% bounce rate** and means
nothing at all. A digest that woke somebody for that would teach them to ignore
the one that matters, which is precisely the failure mode ADR 0024 was written
to avoid. So below `MIN_VOLUME` — a hundred accepted messages —
`sendingHealth` returns **`null`**, not a reassuring `ok`.

Null rather than `ok` is deliberate. *"We have not sent enough to know"* and
*"we have sent plenty and it is fine"* are different answers, and a caller that
shows the second when it means the first is lying quietly.

## Decision 2: the thresholds are the ones the mailbox providers use

Not numbers chosen to look calm.

| | watch | urgent |
| --- | --- | --- |
| Bounces | 2% | 5% |
| Complaints | 0.1% | 0.3% |

The complaint numbers are Google's published sender guidance — stay under 0.1%,
never exceed 0.3%. The bounce numbers are the ordinary "something is wrong with
your list" and "this is where suspensions start" lines.

`watch` is deliberately set below the level where anything bad has happened yet.
The entire value of the number is the weeks of warning it gives; a threshold
that fires when the damage is done is a threshold that has thrown that away.

Rates are reported to one decimal place, because 0.1% and 0.3% are a meaningful
distance apart and rounding a complaint rate to whole per cent makes every value
zero.

## Decision 3: the window is a week, not the digest's day

A bounce arrives hours or days after the send. A rate measured over the last
twenty-four hours of *sends* misses the bounces those sends are about to
produce, and so flatters itself exactly when things are going wrong. Seven days
is what a mailbox provider is scoring over anyway.

So `health()` takes two windows: the failure window it always had, and a longer
one for reputation. Counted over recipients *sent* in the window rather than
events recorded in it — an event-window count would divide this week's bounces
by this week's sends and mix two different cohorts.

## Decision 4: the digest speaks for a reason that is not a count

`Health.total` is a count of things that failed, and `total === 0` is what buys
the silence ADR 0024 depends on. A sending reputation going bad is not a count
of anything — **nothing failed**, which is exactly what makes it easy to miss.

So `Health` gains `worthSaying`, and the handler asks that instead. The rule is
unchanged in spirit: still nothing on a quiet day, still one message, still a
count when there is one to give. An urgent sending problem takes the front of
the sentence, because a dead job is still there tomorrow and this is not.

## What this did not do

No schema change, no migration, no new notification topic. This is the same
digest, on the same daily schedule, to the same people, saying one more true
thing.

It does not act. A high bounce rate could pause a campaign or force a list
cleaning, and deliberately does not: a company's mailing list is its own, and an
application that stopped sending on a threshold it chose would be making a
commercial decision on somebody else's behalf. It says the number and links to
the page.

It repeats daily while the rate stays bad, which is a real cost and the right
trade — the fact is still true tomorrow, and a warning that fires once about a
condition that persists is a warning designed to be missed.

## What the next phase might take

The verdict is company-wide and the cause is usually one campaign. A single
badly-sourced list can put a whole domain's rate over the line, and this phase
tells you the domain is in trouble without telling you which send did it —
`campaignStats` already computes a per-campaign bounce rate and the operations
page is one join away from naming the culprit. That is the difference between
knowing to worry and knowing what to stop.
