# ADR 0010 — At least once, and who is allowed to decide

- **Status:** Accepted
- **Date:** 2026-08-14
- **Context:** Spec §18 (background worker/queue for bank sync, document generation, campaign sends, and AI jobs; event/outbox pattern for reliable cross-module handoffs), §19 (idempotency), §14 (tenant isolation), §22 (definition of done)
- **Builds on:** [ADR 0005](0005-marketing-consent-and-engagement.md), [ADR 0007](0007-industry-modules-without-forking-the-ledger.md), [ADR 0008](0008-offline-first-and-replay-safety.md), [ADR 0009](0009-payroll-the-entry-not-the-tax.md)

## Context

Spec §20's roadmap ends at Phase 8. This phase is past it, and the reason to
build it now is written in the previous four ADRs rather than in the spec:

| ADR | What it said was missing |
| --- | --- |
| 0005 | *"A background worker is the missing piece"* — campaign scheduling |
| 0007 | The WIP adjusting entry, deliberately not automated |
| 0008 | *"It is now blocking three things"* — nudge, key pruning, campaigns |
| 0009 | *"Now blocking four things… this should be built before the next feature"* |

Four consecutive phases each built a feature to the point where the only thing
left was something calling it on a clock, and each deferred that. Spec §18 asks
for it explicitly in two of its bullets. Continuing to add features on top
would have been the wrong call.

This ADR is about two decisions. One is a distributed-systems question with a
standard answer. The other looked like the same question and is not.

## Decision 1: at least once, and say so

A job runs **at least once, never exactly once.**

A worker can be killed in the window between finishing the work and recording
that it finished. No arrangement of tables closes that window — the work and
the record of it are on opposite sides of a commit however they are ordered.
Attempting exactly-once is a well-known way to build something that is neither.

So the promise is stated plainly and everything else follows from it:

- **`FOR UPDATE SKIP LOCKED` on the claim.** Two workers polling the same queue
  would otherwise block on each other (`FOR UPDATE` alone) or both take the
  same row (no lock at all). `SKIP LOCKED` is what makes "run a second worker
  and it goes faster" true.
- **Claims expire.** A worker killed holding a job leaves a `running` row that
  nothing would reclaim. After `CLAIM_TIMEOUT_MS` another worker may take it.
  That is a deliberate second execution, and it is acceptable *only* because
  handlers tolerate it.
- **Every handler is safe run twice.** This is not new discipline: Phase 8
  imposed it on the mobile client and Phase 1 made bank import idempotent on
  the provider's transaction id. `bank.sync_all` needed no changes to be
  queue-safe, which is the argument for putting idempotency in the *service*
  rather than in whatever calls it.
- **Backoff is exponential, capped, and jittered.** The jitter is not
  decoration. A provider outage fails every queued job at once; without jitter
  they retry in lockstep, hit the still-broken provider together, and
  synchronise harder each round. It only ever delays — retrying *earlier* than
  the policy is the one direction that cannot help.
- **Out of attempts means `dead`, not deleted and not retried forever.**
  Deleting destroys the evidence; retrying forever turns one broken job into a
  permanent load that hides the healthy queue behind it. `pruneFinishedJobs`
  sweeps `succeeded` and `cancelled` and never touches `dead` — a failure
  nobody looked at is not tidy-up material.
- **An unknown job kind goes straight to dead.** Usually a deploy that removed
  a handler while jobs of that kind were queued. Retrying cannot conjure it
  back, and burning five attempts and an hour of backoff to rediscover that
  hides the real problem behind a "retrying" status.

### The outbox

`modules/crm/acceptance.ts` used to carry this:

> Failures are swallowed by the caller. A notification is a courtesy; the
> acceptance is the record.

That was the right call against the only other option — blocking a signature on
a push service having a bad afternoon. But swallowing is losing: the client
signed, the phone stayed quiet, and nothing recorded that a notification was
even attempted.

The third option is an event row written **inside the acceptance's own
transaction**. If the acceptance commits the event exists; if it rolls back so
does the event. Delivery happens afterwards with the queue's retries, so
nothing external is on the critical path of a signature and nothing is silently
lost. `tests/worker.test.ts` asserts the rollback case directly.

Event types are a closed union, so a typo in a publisher is a compile error
rather than an event with no subscribers — which is indistinguishable from a
working system until somebody asks why nobody was told.

### Who a scheduled task is

Every service takes an `ActorContext` whose `userId` is a real row, and writes
it to `created_by`, `posted_by`, and the audit log. Background work has no
signed-in person. Three options:

1. **Widen `userId` to null.** Fifty-eight call sites, several writing into
   `NOT NULL` columns. The type that makes tenant isolation structural would
   get looser to serve the one caller that is not a person.
2. **Attribute it to the owner.** One line, and a lie. An owner who did not
   post that entry would find their name on it — precisely what an audit trail
   exists to prevent.
3. **Give scheduled work a real identity.** One row, honest in the log, every
   foreign key satisfied.

The third. Its stored password hash is a sentinel that is not in the format a
password could hash to, so `verifyPassword` returns false before comparing
anything; it is a member of no company, so `resolveSession` would resolve a
session for it to nothing. Both are asserted rather than assumed.

The runner builds a context scoped to the job's company and hands it to the
handler, so `scoped()` still applies and a job cannot see across tenants by
forgetting to filter. Global housekeeping gets **no actor at all** rather than
one for an arbitrary company — the type makes a handler that wants tenant data
deal with the null.

## Decision 2: a clock is not a licence to decide

This is the decision that mattered, and the one where having built the
machinery made it tempting to reach further than the machinery justified.

ADR 0007 refused to post the WIP adjusting entry automatically:

> Automating a period-end adjustment nobody reviewed is how a WIP schedule
> becomes a source of surprises.

Arriving at this phase with a worker in hand, the obvious move is to say that
objection was really "we had no scheduler" and post it. **It was not.** The
objection was never that the arithmetic was hard — it is a subtraction the
report already does. It was about *who decides*, and a scheduler deciding is
worse than a person deciding late.

So `jobs.propose_wip_entry` writes a **draft**: balanced, accounts checked,
dimensions checked, period checked, entry number allocated — everything a
posted entry gets except the posting. Every balance and statement query already
filtered on `status = 'posted'`, so a draft affects no figure until an
accountant opens it and posts it. The work is done; the decision is not taken.

The same line separates the two handlers added for Phase 9's follow-up. The
remittance reminder *is* just the missing clock, because a reminder is not an
action — so it is a plain scheduled job. The WIP entry is not, so it is a
proposal.

A related correction found during verification: the handler originally defaulted
to *today*. A period-end adjustment for a period that has not ended is an
adjustment against half a month of costs — wrong on the day it is proposed. It
now defaults to the end of the previous month, and the schedule fires on the 1st
precisely so it has a closed month to work from.

### Schedules are not cron

Four cadences and an hour, not a cron string. A cron expression is a small
language, and the failure mode of a small language nobody validates is that a
typo means *never* rather than an error. A schedule that silently never fires is
worse than one that cannot express every possible timing, because the second
kind is discovered on the day it is written.

`nextRunAt` is pure and returns a time **strictly after** the one given. A
function that can return "now" gives a scheduler that fires the same job
forever, because every tick computes a next-run that has already passed. It is
tested across cadences and boundary dates rather than trusted.

`dayOfMonth` is capped at 28 by a database CHECK rather than clamped in code.
"The 31st" in February has three defensible answers, and picking one silently is
how a monthly job runs eleven times a year without anybody noticing.

### The operations page exists because absence is invisible

"The queue is empty" and "nothing is draining the queue" look identical from
every other screen, and the second is an outage that presents as calm. A
campaign that never went out raises no error anywhere. So a worker writes a
heartbeat every tick, and the page leads with whether one is alive, then with
what failed, and puts the successful jobs last.

## Consequences

- **A deployment must run `npm run worker`.** Nothing schedules itself from the
  web process — one copy per web instance with no coordination would mean
  scaling the website scales the number of things sending campaigns. If no
  worker runs, the operations page says so in as many words, and offers a
  single tick from the browser for development.
- **The `tickWorkerAction` button is a development convenience.** It calls the
  same `runOnce` the loop calls, so there is no second behaviour, but it runs
  inside a web request and the page says it is not how this should work in
  production.
- **Jobs are polled, not pushed.** A five-second poll is five seconds of
  latency on a queued job, and `LISTEN/NOTIFY` would remove it. Not worth the
  complexity while the most urgent thing in the queue is an hourly campaign
  check.
- **Handler failures inside a batch are collected, not thrown.** One campaign
  missing a from-address must not stop the others, so `campaign.send_due` and
  `bank.sync_all` return partial results with a `failures` list. The cost is
  that a job can "succeed" having done part of its work; the failures are in
  the stored result and on the page.
- **The system actor is a single global row.** It is honest in the audit log
  and cannot sign in, but it does mean one identity across every tenant. It
  writes only through tenant-scoped services, so this grants no cross-tenant
  read — but it is a shared row and worth knowing about.
- **Nothing yet retries a dead job automatically.** Deliberate, but it means a
  dead job is only noticed by somebody opening the operations page. A digest
  would be better and needs the notification work below.
- **`opportunity.won` and `payroll.posted` are published by nothing.** They are
  declared event types with no publisher, kept because the two obvious
  subscribers (nurture-sequence exit, a payroll digest) are near-term. An event
  type with no publisher is dead code until then, and this is the honest label
  for it.
- **Campaign nurture steps are scheduled from when step 1 actually sent**, not
  from when it was meant to. A worker down for a day would otherwise fire steps
  two and three immediately on recovery, which reads to a recipient as being
  spammed.
- **`invoice.paid` fires only on full settlement.** A partial payment is a
  balance, not news. A company wanting every receipt notified would need a
  second event type rather than a change to this one.

## Follow-up

1. **A dead-job digest.** The operations page makes failures visible to
   somebody who opens it. The notification machinery to push them now exists —
   this is a handler and a schedule, and it is the obvious next thing.
2. **`LISTEN/NOTIFY` to cut poll latency**, if anything ever needs to run
   sooner than the poll interval. Not yet.
3. **Per-kind concurrency limits.** One slow kind can fill a batch and starve
   the others; priority mitigates it and does not solve it. The column to add
   is on a table that already exists.
4. ~~**The background worker.**~~ Done. Four ADRs of follow-up, closed.
