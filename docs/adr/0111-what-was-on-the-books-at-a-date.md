# 0111 — What was on the books at a date

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 111

---

## The defect

ADR 0110 named this work and did not do it:

> **It does not repair the eleven.** `assets.register` and `manufacturing.wip`
> in particular are now understood well enough to fix.

Verified before adopting it, by reading both queries and then measuring all four
dates against the development books:

```
                   2026-09-03   2026-05-31   2026-03-31   2025-12-31
assets.register    agrees       agrees       agrees       DIFFERS cost 10125000/0
manufacturing.wip  agrees       agrees       agrees       DIFFERS 12600/0
```

The left figure never moves — the same signature Phase 109 found `inventory.lots`
by. Both are **faults**, the register's highest severity, so asking about last
December reported $101,250 of broken books and a broken factory floor on books
that were perfectly correct.

Both were `today_only` since Phase 109, so nothing was *lying* — they were
skipped. That is a stopgap, and eleven skipped checks is eleven questions
nobody can ask about a closed period.

## Decision 1: name the shared decision, not the shared arithmetic

This is the fourth subledger to be restored to a date, and each of the previous
three wrote its own arithmetic:

| | how it walks back |
| --- | --- |
| control accounts (108) | balance now **plus** the settlements dated after |
| inventory (109) | value now **minus** what moved after |
| assets (111) | a **filter**: bought by then, not yet sold |
| work in process (111) | a **sum** of what a run had absorbed by then |

Those are genuinely different operations, and collapsing them into one function
would be the wrong kind of tidying — it would need a flag argument to say which
of four things it was doing, which is four functions wearing a coat.

What they share is one decision each of them makes and each of them re-derived:
**was this thing on the books on that day at all**. So `src/modules/ledger/
lifespan.ts` names that and nothing else:

```ts
onBooksAt({ openedOn, closedOn }, asOf)   // was it there
heldAt(life, movements, asOf)             // and what did it hold
```

`openedOn` is nullable because *not yet on the books at all* is a real state
with real rows behind it: a work order raised as a draft and never released has
no start date because nothing has happened to it. Reading that as an opening
date of the beginning of time would put every draft run on every historical
report — asserted in both directions rather than assumed.

An incoherent lifespan — closed before it opened — **throws** rather than
answering. Both silent answers are wrong half the time on a report somebody
reconciles against, which is the argument the register already makes for
throwing on an undeclared key.

## Decision 2: opening is inclusive, closing is exclusive

The asymmetry looks like an off-by-one and is the opposite of one:

```
openedOn <= asOf && (closedOn === null || closedOn > asOf)
```

Both dates are the dates of *journal entries*. `registerAsset` posts with
`entryDate: acquiredDate` and `disposeAsset` with `entryDate: disposedOn`;
`issueMaterial` posts on `occurredOn` and `completeWorkOrder` on `completedOn`.
A report as at a date includes every entry dated on or before it. So on the day
a thing arrives the ledger already carries it, and on the day it leaves the
ledger has already let it go.

Anything else puts the subledger one day out of step with the ledger it is being
compared against — which is this phase's own defect, reintroduced at the
boundary. Both edges are tested from both sides, in the pure core and again
against the database.

## Decision 3: the two repairs

**The asset register** stops asking `status <> 'disposed'`, which is present
tense, and asks `onBooksAt` on `acquired_date` and `disposed_on`. Depreciation
was never the problem: `depreciation_entries` has been filtered by
`period_end <= asOf` all along, which is exactly why this check looked fine
until somebody read the other half.

**Work in process** stops asking two present-tense things at once. `status =
'released'` was the one Phase 110 spotted — a run released in February and
finished in May is not released *now*, so a March report missed it entirely —
but `wip_cents` is a running column and was wrong even for a run still open,
because it includes material issued after the date. Both halves are already
recorded: `work_order_entries.occurred_on` dates every absorption with the same
date its journal entry carries, and `completed_on` is set, with an entry dated
the same day, on cancellation as well as completion.

Measured on the same books afterwards, every date agrees and both register sides
walk back:

```
assets.register    2025-12-31: agrees cost 0/0
manufacturing.wip  2025-12-31: agrees 0/0
```

Twelve checks now reach any date; nine remain `today_only`.

## Decision 4: a shorter list says why it is shorter

A past-dated register shows fewer assets than today's, and without a word about
it the reader has to work out whether records went missing or were simply not
there yet. `excludedNote` writes that sentence, and it is carried on the
integrity check's `detail` — which is the field the operations page already
renders, so it reaches a reader rather than sitting in a service nobody calls
with a past date.

Verified in the browser against Ridgeline's books at 2026-02-28, where the
register agrees at $58,500 against today's $101,250:

> **The asset register, against the balance sheet** — agrees
> Σ register cost and depreciation against 1500 and 1590
> 1 asset is left out: it was not on the books on 2026-02-28.

Six checks were out of reach for that date rather than seven, and eight ran
rather than seven.

## What this does not do

**It does not add a date to the assets page.** The page asks for today, so its
own copy of the note would be unreachable and this phase did not write one. The
note reaches the operations page instead, through a stored run, which is a path
that genuinely carries past dates.

> **Retainers done by Phase 112.** The nomination was right about the date and
> wrong about the work: all three movements are dated, but a draw did not record
> the functional amount it took, and that amount is not derivable afterwards.
> `retainer_applications` gained `carried_cents`. Eight checks remain
> `today_only`.

**It does not repair the remaining nine.** `timebilling.retainers` is still the
clearest candidate — `retainer_applications.applied_on` dates every draw — and
its declaration still says so. The others are named in their own prose, and
`receivables.customer_credit` in particular cannot be repaired without a dated
record of a held credit being consumed, which does not exist.
