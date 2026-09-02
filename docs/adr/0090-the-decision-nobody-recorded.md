# 0090 — The decision nobody recorded

**Status:** accepted
**Date:** Phase 90
**Amends:** ADR 0008 (the notification log), ADR 0019 (transactional mail), ADR 0088 (the firm's morning brief), ADR 0089 (preference audiences).

## The defect

ADR 0008 built `notification_log` for one question: *"why did I not get told
about that" is a question a support conversation starts with, and it needs an
answer that is not a guess.* Every path through `notify` writes a row —
including the suppressed one, and the one where there was nothing to send to.
That is the whole point. Silence is a decision, and an unrecorded decision is
indistinguishable from a bug.

**Phase 88 broke the promise and Phase 89 widened the hole.** The firm's morning
brief is a notification by every meaning except the transport it uses, and it
does not go through `notify` — it goes through Phase 19's mail channel, for the
reasons ADR 0088 gives. So a *sent* brief left a row in
`transactional_messages` and a *suppressed* one left nothing at all: Phase 89's
handler incremented `quieted` and moved on.

The person this hurts is the one Phase 89 built the switch for. They turned the
brief off in March. In July they notice they hear nothing from their firm, and
there is no record anywhere that they were the cause. A counter in a job result
is not an answer to that question.

ADR 0089 nominated this itself.

## Decision 1: two tables, one boundary, written down

The tempting fix is to merge the logs. It is wrong, and the reason is worth
stating because the boundary had become load-bearing while being written down
nowhere:

- `transactional_messages` records a **transmission** — this address, this
  provider, this provider message id, did the hop succeed.
- `notification_log` records a **decision** — this person, this topic, we chose
  to tell them or chose not to, and here is why.

A suppression has no transmission at all. That is exactly why it fits in one
table and not the other, and it is why merging them would have meant inventing a
fake `transactional_messages` row for a letter that was never composed.

So the boundary stays and `mobile/decision` makes it explicit. The schema
comment on `notification_log` now says *decision* rather than *attempt*.

## Decision 2: a log row names an audience

The same shape Phase 89 gave `notification_preferences`, for the same reason and
enforced the same way: exactly one of `company_id` or `practice_id`, with a
check constraint saying so. A firm's brief is about no single client, and filing
it under one would put a firm's internal business on that client's record.

No unique index this time, because a log is an append-only history rather than a
keyed row — the `NULLS NOT DISTINCT` argument from ADR 0089 does not arise here.

The consequence is two readers over one table. `recentNotifications` keeps using
`scoped()`, which resolves a company and therefore cannot match a brief row;
`practiceNotifications` is scoped by the firm *and* the person. Neither can see
the other's rows, asserted in both directions.

## Decision 3: the body is stored only when nothing else stores it

A push notification's text exists nowhere but its log row, so the row keeps it.
A mail-backed notification's text is already in `transactional_messages`,
rendered, with the address it went to — and a second copy in a second table is
the two-answers-to-one-question defect this project has spent ninety phases
finding. An edit to the brief's wording would fix one copy and leave the other
lying.

So `body` is null for mail. A `channel` column is stored beside it, which is
what lets a reader tell *why* it is null rather than guessing there was nothing
to say. Stored rather than derived from the topic, because the topic determining
the channel is a coincidence of there being one mail topic today.

## Decision 4: the sentence lives in the core

`explain()` turns an outcome into the sentence a person reads. It belongs in the
pure core rather than in a template, because there are now two screens asking
the same question, and two templates is how they eventually disagree — which
would be this project's own recurring defect committed in the act of fixing it.

`decisionFor` refuses three shapes outright, each being a row worse than no row:
a topic against the wrong kind of audience (ADR 0089's rule, applied to the
record as well as the preference); `no_subscription` on the mail channel, which
cannot happen and would hide the real failure; and a blank title, which is the
only thing a person scanning their history reads.

## What this did not do

**The writer still swallows its own failures.** Phase 8's call, unchanged and
deliberately: losing a log row is a smaller failure than losing the notification
it describes — the same reasoning as `meter()` in the AI gateway. The new shape
checks run *inside* that try, so a programming error in a caller cannot take
down the send it was only describing.

**Nothing was migrated.** Every existing row names a company and passes the new
constraint unchanged; `channel` backfills to `push`, which every row that
predates this phase was.

**Silent mornings stay silent.** On a morning when the brief says nothing, there
is no decision about a person to record — the brief was never written. Which
client was seen on which morning is `practice_brief_state`'s job, and duplicating
it here would be the same defect in a new place.

**No history for `background_failures` and the rest.** Those already flow through
`notify` and are already logged; this phase widened who *can* be recorded, not
what gets recorded.

## What the next phase might take

The brief's letters are in `transactional_messages` with `reference` set to the
practice id, and nothing reads them back — `recordOutboundMail` files a letter on
a contact's timeline only `if (input.companyId)`, and a firm-wide letter has
none. So the firm can now see that a letter was *decided* on, and still cannot
open the one that was sent. The two halves of the record exist and nothing joins
them.
