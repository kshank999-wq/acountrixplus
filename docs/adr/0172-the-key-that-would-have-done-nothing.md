# 0172 — The key that would have done nothing

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 172

---

## The nomination was right to ask and wrong about the answer

ADR 0171 nominated measuring the ceiling:

> How many of the 255 are references from an unscoped table into a scoped one,
> and therefore cannot carry the tenant? [...] it means the programme has a
> ceiling below 271 and nobody has measured where.

Measured: **none of them.** All 271 run between scoped tables — that is how the
271 was defined in Phase 170, so every one already has a `company_id` to put in
the key. Only **two** references anywhere come from an unscoped table into a
scoped one, and neither is in the 271.

Seventh correction in this lineage and the fourth of mine. The error is a new
variety again: not an unchecked claim about the codebase, nor about PostgreSQL,
but an unchecked claim about **a number I had defined myself one phase earlier**.
The 271 was measured with `src IN scoped AND tgt IN scoped` written in my own
query, and the nomination then worried about a case that predicate had already
excluded.

Asking the question was still right. It had an answer, and the answer is worth
more than the guess was.

## The real ceiling: a nullable `company_id`

Nine scoped tables permit `company_id` to be NULL — `action_tokens`,
`ai_prompts`, `background_jobs`, `devices`, `document_templates`,
`job_schedules`, `notification_log`, `notification_preferences`,
`transactional_messages` — and three references touch one:

```
notification_log.message_id             -> transactional_messages   both ends
communications.transactional_message_id -> transactional_messages   target
push_subscriptions.device_id            -> devices                  target
```

**268 of 271 are cleanly convertible.** That turns an open-ended programme into
a bounded one, which is the whole value of having asked.

And the three are not blocked by anything about tenancy. They are blocked by
rows that genuinely belong to no company: a password-reset email sent before
anybody has logged in, a device nobody has claimed. The nullable column is
honest; it is the composite key that does not fit.

## Why a nullable source is dangerous and a nullable target is not

This is the finding, and it is a property of SQL rather than of this codebase.

A foreign key's default matching rule is **`MATCH SIMPLE`**, and under it a
multi-column key **is not checked at all when any of its columns is NULL.**

So a composite tenant key on a table whose `company_id` is nullable is enforced
for every row that has one and **silently skipped for every row that does not**.
It would appear in `pg_constraint`, count toward the conversion total this
programme tracks, and guarantee nothing for exactly the rows least likely to
have been thought about.

That is Phase 160's finding in a new place — *"the policies that would have done
nothing"* — and it is the specific way this programme could fail without anybody
noticing: **a number that goes up while the guarantee does not.** A conversion
count is a terrible safety metric on its own, and this phase exists because the
count was the only thing watching.

A nullable *target* is a different problem and not a dangerous one. A row with no
`company_id` has no `(company_id, id)` pair, so it cannot be referenced at all —
the key refuses rows that are currently legal, loudly, at the moment somebody
tries. Loud and wrong is recoverable; quiet and absent is not.

## The rule, and the assertion that enforces it

**Convert a reference only when the source's `company_id` is `NOT NULL`.**

`tests/the-id-a-caller-hands-in.test.ts` asserts that no converted key has a
nullable source. Zero today — verified rather than assumed, which matters because
the sixteen already converted were done before this hazard was understood and
could have included one. None does.

The assertion is for the slice somebody takes next, and it is the kind that earns
its place: nothing else in the repository would notice a composite key being
added to `notification_log`, and the conversion count would go up.

## What this does not do

**It does not convert anything.** A measurement phase, and the first in a while
that produced no migration. The temptation was to take another slice while the
pattern was fresh; the hazard above is the argument against, since the slice
would have been chosen by target table and `transactional_messages` is a target.

**It does not tighten the nine nullable columns.** Each is a data decision with
its own question — whether a transactional message with no company should exist
once the system has companies; whether a device should be enrollable before it is
claimed. `devices` is also one of Phase 160's six RLS exemptions, and that phase
recorded why it is the dangerous one: a revoked device reads as live when the
policy blinds it. A nullable `company_id` is the same looseness at the column
level, and tightening it belongs with device enrolment rather than with
references.

**It does not add `MATCH FULL`.** It would fix the source side — all-or-none NULL,
so a reference set without a company is refused — and it is the wrong tool here,
because on these three references the target side is the real obstacle and
`MATCH FULL` does nothing for it. Worth recording as the answer if a
source-nullable reference ever needs converting for a different reason.

## What is nominated next

**A full suite.** It has been nominated for three phases and has now been
interrupted twice at roughly 400 of ~4,200 tests. The case is no longer
theoretical: two tree-wide scans have gone red undetected since Phase 160, this
programme has added a third, and this phase has just added a fourth assertion
that only a full run exercises. Nothing else in the backlog is worth more than
knowing the suite is green.

Then **the next slice**, chosen by target table among the 268, avoiding
`transactional_messages` and `devices` until their columns are decided.

Then the **bullet-level spec pass**, which has now lost to a finding from
building in five consecutive phases — which is itself evidence about where the
value is, and worth saying rather than letting it keep losing silently.
