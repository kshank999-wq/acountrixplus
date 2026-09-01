# 0086 — The number written down where nobody reads it

**Status:** accepted
**Date:** Phase 86
**Amends:** ADR 0084 (sending reputation), ADR 0085 (attribution).

## The defect

Phase 84 measures a sending reputation. Phase 85 attributes it. Both answer
*how bad is it now*. Neither answers the question a reputation metric exists
for, which is **is this getting better or worse** — and the two call for
opposite actions. 3% that was 1% last week is a domain sliding. 3% that was 6%
last week is a list somebody has already cleaned, and telling them to clean it
again is telling them to undo their own fix.

What makes this worth a phase rather than a feature is that **there is almost a
history already**, and it fails in three ways at once:

- The digest has recorded its verdict in `background_jobs.result` on every run
  since Phase 84, and that table is on the `NEVER_SWEPT` list, so nothing has
  ever deleted it.
- It records the **level**, not the rate. 2.1% and 4.9% are both the string
  `watch`, so no series can be drawn from it.
- The quiet-day early return omits sending entirely, so the record is blank on
  exactly the days that would be the **baseline**.
- And nothing reads it. Digging a trend out of that JSON would be archaeology,
  not a feature.

The number was written down every night, in a column nobody reads, without the
number in it.

## Decision 1: consecutive readings are not two measurements

The judgement this phase is really about.

The obvious comparison is today against yesterday, and it is close to
meaningless. The rate is measured over a **rolling seven-day window**, so
today's reading and yesterday's share six of their seven days. A day-on-day
difference is one day of new mail moving an average of seven — small by
construction, and saying nothing about direction.

So a reading is compared against one a **full window** old. Those two cohorts do
not overlap at all: one is the mail sent last week, the other the mail sent this
week, and the difference between them is a real difference between two
populations rather than an artefact of a sliding average.

Not the *oldest* available reading either — a company with a year of history
should be compared against last week, not last January. And when the worker
missed days, reaching *further* back is the safe direction to fail in: a
candidate older than a window is still two non-overlapping cohorts, while a
nearer one is not.

Below `MATERIAL_CHANGE` — half a watch threshold, so one point of bounces or
five hundredths of a point of complaints — the answer is `steady`. Two windows
of ordinary list churn differ by that much without anything having changed.

And `null` when there is no comparable reading. *"We do not know yet"* and
*"it is steady"* are different answers, the same distinction `sendingHealth`
draws for the rate itself.

## Decision 2: the counts, not the rates

`sending_snapshots` stores `accepted`, `bounced` and `complained`. A rate is
those numbers divided, and storing it alongside them would be a second answer to
a question that already has one — the defect this project keeps finding, most
recently in ADR 0085's three definitions of a send. Anything that wants a rate
divides.

`window_days` is stored per row rather than assumed. A later change to
`REPUTATION_WINDOW_DAYS` would otherwise make old readings quietly incomparable
with new ones, and a trend computed across that boundary would be a fact about
the constant rather than about the sending.

## Decision 3: written every day, including the good ones

The snapshot is taken **before** the digest decides whether to say anything.

Recording only the days something was wrong would build the exact hole that
makes the existing accidental history useless, into a table whose whole purpose
is to have none. The good days are the baseline; without them the only
comparison available is one bad week against another.

It is written even when there is no verdict at all. A week below the volume
floor is a real fact about a company's sending, and a gap that means *"we did
not look"* is worse than a row that means *"we looked, and there was not enough
to judge"*.

Idempotent on `(company, day)`: the digest is scheduled daily but a worker
restart can run it twice, and the second run must replace the first rather than
accumulate. The database arbitrates, not a read-then-write in the handler.

## Decision 4: the trend can raise the panel by itself

The operations page has shown the reputation panel only when a rate was over a
line. A trend that appears only beside an alarm arrives carrying the news it was
supposed to precede.

So the panel now also appears when every rate is **under** every threshold and
the direction is worsening — *"still fine, and heading the wrong way"*. ADR 0084
argued that the entire value of the number is the weeks of warning it gives; this
is the first phase where that is actually true, because until now the earliest
anything could be said was the watch threshold.

The digest's own rule is unchanged. It still says nothing on a quiet day; it
gains one word on a sentence it was already going to send.

## What this did not do

It does not draw a chart. A direction and two numbers answer the question; a
sparkline of a rolling average would mostly show the smoothing.

It does not backfill. The verdicts sitting in `background_jobs.result` could be
mined for levels, and are not: a level is not a rate, and a history half of
whose readings are guesses at what the number might have been is worse than one
that starts today and is true.

**No worker, no history.** The snapshot is written by the daily digest, so a
deployment that never runs the worker gets no trend at all — the same dependency
Phase 24 accepted for the digest itself, and worth stating plainly.

## What the next phase might take

The trend is per company and so is everything since Phase 84, but a **practice**
sees many companies and the operations page is per company. An accountant
managing a dozen clients has no screen that says which of them is in trouble
this morning; they would have to open twelve pages to find out, which means they
will open none. Phase 18 built company switching and Phase 25 built who-is-on-
which-client, so the data to answer *"which of my clients needs me today"*
exists and has never been asked the question.
