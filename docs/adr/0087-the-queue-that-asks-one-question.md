# 0087 — The queue that asks one question

**Status:** accepted
**Date:** Phase 87
**Amends:** ADR 0018 (practice mode), ADR 0033 (the integrity register), ADR 0084 to 0086 (sending reputation).

## The defect

Phase 18 built the firm's work queue — the one query in this application that
legitimately crosses tenants, written so it cannot be pointed anywhere but at
the caller's own live engagements. It reports **one signal**: `awaitingReview`,
the count of bank transactions waiting to be categorized.

That is the least urgent thing the application knows about a set of books.
Since then it has learned to notice, one client at a time, that the books
disagree with themselves (Phase 33), that background work has given up and
letters have bounced (Phase 24), and that a sending domain is going bad and
which way it is heading (Phases 84 to 86). Every one of those outranks a
categorization backlog, and none of them was on the page a firm actually opens.

An accountant with twelve clients would have to open twelve operations pages to
find out which one needs them this morning — which means they will open none.
Everything needed to answer *"which of my clients needs me today"* had been
built, and nothing had ever asked the question.

## Decision 1: a ladder, not a score

The tempting answer is a health score per client. It is the wrong one: it
compresses incomparable things into a number nobody can argue with, sorts by it,
and hides which thing is actually wrong. *"Northgate: 62"* tells you nothing you
can do.

So concerns are ranked by **what happens if you leave it until next week**,
which is a question each kind has a different answer to:

| rung | what it means | why it sits there |
| --- | --- | --- |
| `wrong` | the books disagree with themselves | leave it and something gets filed that is not true |
| `spending` | it is getting worse on its own | ADR 0084: the provider is scoring the sender the whole time |
| `stuck` | the machine gave up | not getting worse, but nothing moves without a person |
| `waiting` | work waiting for a human | the normal state of bookkeeping, and therefore not news |
| `unchecked` | nobody has looked | quiet, and deliberately not `clear` |
| `clear` | looked, and nothing wrong | |

The array of rungs **is** the ordering. There is no numeric severity anywhere,
and `weight` only ever compares two clients already on the same rung — so it
never has to make two different kinds of problem commensurable, which is the
thing a score gets wrong.

## Decision 2: two rules carried forward

**A count without an age is not a signal.** Forty transactions waiting is
Tuesday. Forty transactions whose oldest is from June is a client nobody is
serving, and the count alone cannot tell you which you have. So `waiting` orders
by age rather than size, and says the age once a backlog is past a month. The
browser check made the case better than the argument did: the seeded practice's
own client reads *"66 waiting, oldest 92 days"*, where the old page printed
`66` and `2026-06-01` in two columns and left the reader to subtract.

**"Never checked" is not "clean".** A company whose integrity checks have never
run gets `unchecked`, not `clear` — the same distinction `sendingHealth` draws
with `null` rather than `ok`, and `trendFor` draws between *"we do not know
yet"* and *"it is steady"*. A roster showing a green tick for a company nobody
has ever examined would be lying quietly, at scale. A check that **threw** is
treated the same way: an admission, never an assertion.

## Decision 3: one line per client

An accountant scanning twelve rows will not read four bullets each. The row
carries the worst concern and a count of the rest — *"2 checks disagree with the
ledger, and 1 more"* — so the page stays scannable and nothing is hidden.

Only two rungs are allowed to render loudly. A roster where every row shouts is
a roster nobody scans, which is the failure mode ADR 0024 named for the digest
and it applies here for the same reason.

## Decision 4: what made it affordable

The cross-tenant query keeps every rule ADR 0018 gave it: the company set is
derived inside the function from the caller's own live engagements, there is no
parameter that can widen it, and it returns counts rather than rows.

It now runs five counts per client rather than one, and that is affordable only
because of what the last few phases left behind. The integrity register writes
**one summary row per run**, and Phase 86 writes **one sending snapshot per
company per day** — so the two most valuable signals cost one indexed read each,
instead of the four-query `health()` the single-company operations page runs.
Phase 86 was built to answer "is it getting better or worse"; it is what makes a
forty-client roster possible at all.

## What this did not do

No schema change and no migration.

The roster is not a notification. Nothing is pushed, nothing is emailed, and a
firm that does not open the page is told nothing — the digest remains
per-company and goes to the client's own people, not to their accountant.

It does not act, and it does not enter anybody's books. Every row is still a
count, and the accountant is in nobody's ledger until they press the button that
was already there.

## What the next phase might take

The rungs are hard-coded and the same for every firm. A bookkeeping practice
that only does categorization and a tax firm that only does year-end have
genuinely different ideas of what "needs somebody" means, and neither can say
so. More sharply: the thresholds — a month for a stale backlog, a fortnight for
a stale check — are this application's opinion presented as arithmetic, and
Phase 43 already established the pattern for letting a company own that kind of
judgement, by making the chase policy named data a person can change.
