# ADR 0024 — Nothing grows for ever, and nothing waits for somebody to look

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §19 ("Backups, point-in-time recovery strategy, **retention
  policy**, and tested restore procedure"), §18 (background worker/queue), §14
- **Builds on:** [ADR 0010](0010-at-least-once-and-who-decides.md),
  [ADR 0008](0008-offline-first-and-replay-safety.md),
  [ADR 0013](0013-a-stolen-password-is-not-enough.md)

## Context

Six phases each finished a feature, noticed the same missing thing, and wrote
it down instead of building it:

> **`login_attempts` is never pruned.** The table grows with every failed
> sign-in on the internet and an attacker controls that rate. (Phase 13)
>
> **`action_tokens` is pruned on demand, never on a schedule.** (Phase 19)
>
> **`sweepOrphanedBlobs` is not scheduled.** The Phase 10 queue is right there
> and nothing calls it. (Phase 20)
>
> **Nothing chases an overdue follow-up.** A task due Friday nudges nobody on
> Friday. (Phase 22)
>
> **Nothing schedules the rent run.** It is a button. (Phase 23)
>
> **Nothing retries a dead job automatically, and nothing tells you about
> one.** (Phase 10)

Each was correctly deferred and each was correctly named. What none of them
could do alone was decide *how long* anything is kept — that is one decision
about the whole application, and taking it six times in six files would have
produced six answers.

Three claims, asserted in `tests/retention.test.ts`:

1. **Nothing grows without bound, and retention never touches the books.**
2. **A promise is chased without somebody opening a page.**
3. **A failure is never silent** — and never noisy either.

## Part one: retention

### Decision 1: the policy is data, in one place

Nine policies in a list: the table, how many days, whether strangers can write
to it, and why. The sweeps are generated from it and the operations page reads
it.

Written as nine `DELETE` statements in nine modules, a tenth would have been a
tenth statement — and *"what do you hold about me, and for how long"*, which is
the question a data-protection request actually asks, would have had no answer
short of reading every module. Now it is a table on a page.

### Decision 2: the allowlist is the safety property

Every policy names exactly one table, and that list is the entire set of tables
anything in this module may delete from. Nothing here can reach the ledger, the
audit log, the documents, or any record of money.

`NEVER_SWEPT` writes down the other half — the tables that must stay
unreachable — and a test asserts the two lists do not intersect. Adding a
policy for `journal_lines` fails the suite rather than the year-end. A second
test posts a journal entry dated 2019, runs every sweep as at 2030, and asserts
the lines are still there.

The asymmetry is the point: these tables grow with **traffic**, much of it from
strangers and some of it at a rate an attacker chooses. None of them is
evidence of anything a business owes or is owed.

### Decision 3: two policies never name one table

Two answers to "how long do you keep this" is one answer and one lie, because
the shorter would silently win. Asserted.

### Decision 4: counting is a separate query from deleting

Every policy has a `count` beside its `remove`, and the operations page runs the
counts. Somebody is entitled to see what a policy would take before it takes
it — a number nobody can check beforehand is a number nobody can dispute after.

### Decision 5: `asOf` is a parameter

The same rule Phase 16 applied to depreciation, Phase 21 to the PDF timestamp
and Phase 23 to the rent run. A sweep that reads the clock cannot be asked what
it would have deleted last Tuesday, and cannot be asserted on.

### Decision 6: three policies are narrower than their table

- **`domain_events`** sweeps only rows with `relayed_at IS NOT NULL`. An event
  still waiting is work in progress, and an outbox that deletes work in
  progress is not an outbox.
- **`lead_submissions`** sweeps only rows that never became an opportunity.
  This is what lets the window be six months: the honeypot catches go, and the
  lead somebody is still working stays however old the row is.
- **`action_tokens`** measures from expiry rather than from issue. A week-long
  invitation issued 29 days ago has not been expired for 30 days.

### Decision 7: dead jobs are never swept

They are in `NEVER_SWEPT`, alongside the ledger, and Phase 10 already said why:
*a failure nobody looked at is not evidence to be tidied away.* A dead job
swept is a question deleted before it was asked.

## Part two: the work that was owed

### Decision 8: scheduling arrives last because it is the easy part

Four handlers, and not one of them needed the feature it drives to change.
`runRent` was already idempotent; `completeTask` was already a claim; the
sweeps were already ranged deletes.

That ordering is the whole reason this phase is small. A scheduled job that can
run twice is only safe because the precondition lives in the database — Phase
23's `unique(lease_id, period_start)`, Phase 22's `WHERE status = 'open'`,
Phase 19's `WHERE redeemed_at IS NULL`. Scheduling is easy *because* the safety
was built first, and a phase that had scheduled them earlier would have had to
build the safety anyway, under time pressure, with the schedule already firing.

### Decision 9: the rent run skips rather than throws

`runRent` calls `requireModule` and raises `ModuleDisabledError`, which is right
for somebody clicking a button and wrong for a schedule installed at every
company. A company that lets no property would dead-letter a job every month
for ever, and fill the operations page with a failure that is not one.

### Decision 10: one message per person, not one per task

Somebody with eleven late follow-ups gets one notification saying eleven. The
Phase 8 review nudge learned this — *a phone that buzzes on every imported
coffee is a phone with notifications switched off by the end of the week* — and
a chaser that becomes noise stops being a chaser. The `tag` replaces yesterday's
rather than stacking beside it.

Unclaimed overdue work is told to the people who could claim it, and told
*separately*: "three of yours are late" and "two are late and unclaimed" are
different sentences, and merging them produces a number nobody can act on.

### Decision 11: two new notification topics, not one reused

`follow_up_due` and `background_failures`, for the reason Phase 10 added
`remittance_due`: a topic is what somebody switches off, and folding a chaser
into the review nudge would mean silencing one silences the other.

## Part three: the failure digest

### Decision 12: a digest, and silence when there is nothing

One broken mail provider is forty bounces in an hour. A notification each would
mean the worst outage produces the loudest noise at the moment somebody most
needs to think.

So: one message a day, with a count, and **nothing at all when the count is
zero**. Silence has to mean something, or the digest becomes a daily
"everything is fine" that nobody reads — and therefore cannot notice the day it
says otherwise.

### Decision 13: the digest and the page run the same query

`health()` feeds both. A notification saying "two things failed" beside a page
showing three is worse than either alone, because after that nobody trusts the
page.

### Decision 14: the window is a parameter, so a bounce is news once

Without it the digest reports the same dead job every morning until somebody
deletes it, and a notification that repeats whatever you do is one people learn
to ignore. The page uses a week; the digest uses a day.

### Decision 15: per company, and honest that there is no operator

Dead jobs with no tenant reach every company's digest — Phase 10's choice for
the operations page, for its reason: *hiding them from every company means
nobody ever sees them fail*. What this does not do is page a deployment
operator, because there is no operator identity in this application and
inventing one to notify would be a feature pretending to be a notification.

## Consequences

- **Retention is not configurable per company.** The days are the
  application's, not a setting. A jurisdiction requiring seven years of
  sign-in history has no way to say so, and one requiring thirty days has no
  way either. The policy being data is what makes that a small change; it is
  still a change.
- **Nothing is anonymised, only deleted.** A row past its window goes entirely,
  so a count that used to include it silently drops. Aggregates computed before
  and after a sweep disagree, and nothing records that a sweep is why.
- **No retention on the audit log, deliberately, and it grows for ever.** Spec
  §19 asks for complete auditability and this application takes that literally.
  A busy company's `audit_events` will eventually be the largest table it has,
  and there is no plan for it beyond "that is the requirement".
- **A deleted row is not recoverable from the application.** The backup is the
  answer, and `db:verify-restore` is the tested half of it, but there is no
  undo on a sweep.
- **The digest reaches phones, not inboxes.** It goes through Phase 8's push
  channel, so somebody without a push subscription is told nothing — and the
  transactional mail channel is right there, unused for this.
- **Nothing watches the watcher.** The failure digest is itself a scheduled job.
  If the worker stops, the digest stops with it, and the only thing that says
  so is the operations page nobody is looking at. That is the same gap Phase 10
  named and it is not closed here.
- **The rent run is monthly on the 1st, for everybody.** A company whose
  tenancies run mid-month bills on the 1st anyway. The run takes a month
  parameter; the schedule does not offer one.
- **Retention counts scan whole tables.** Nine `count(*)` pairs on every load of
  the operations page. Fine at the scale this application is written for,
  wrong for a tenant with ten million rows of campaign events.

## Follow-up

1. **A retention setting per company**, now that the policy is data and the
   screen already explains it.
2. **Something outside the worker that notices the worker stopped** — the one
   failure this phase cannot report, because it would be reporting it.
3. **The digest by email as well as push**, through Phase 19's channel.
4. **Anonymise rather than delete** where an aggregate depends on the row, so
   last year's open rate survives its events.
5. **Archive the audit log** to the object store rather than keeping every row
   hot for ever.
