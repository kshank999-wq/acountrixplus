# ADR 0212 — The job that cannot be finished

**Status:** accepted · **Phase:** 212 · **Spec:** §5, §6, §13, §19

ADR 0211 nominated *the job that cannot be finished*: `projects.end_date` has no
writer, so a job can be created, billed, have its retainage held and its costs
coded, and there is no way to say it is over. It attached one instruction —
measure *"what else is a finished job supposed to mean?"* before building
anything — and noted that *"on this run's record the nomination is still the
least reliable part of a phase: three in a row have changed under
measurement."*

Four in a row now.

## The sentence the nomination was built on

The nomination argued the column was worth **writing** rather than dropping:

> The column is read — the register's entry for it names what reads it — so this
> is not Phase 49's shape and a migration is not the answer.

The register's entry said `jobs/reports.ts` *"reads the end date into every date
range it builds."* That file has exactly one `endDate`:

```ts
range: { startDate: string; endDate: string },
```

A function parameter. A caller-supplied window for a ledger query, named the
same as the column and related to nothing. Measured: **nothing in `src/` names
`projects.endDate` at all.** Four projectionless `select()`s fetch it —
`jobs/billing.ts`, `jobs/budgets.ts`, `timebilling/billing.ts` and the job
page — and no property access consults it. Same for `projects.notes`.

The conclusion held and the reason did not, and the way it failed is the part
worth keeping.

**Phase 210 taught the scan that a projectionless `select()` is a read.** That
was right: the SQL fetches the column, and the old rule had hidden seventy-two
columns, sixteen of them written by nothing. The *first register entry written
after that correction* then used "it is read" as the argument for keeping a
column — about a column no reader consults. A correction to what the scan can
see created a new way for an entry to be wrong, and nothing but prose can catch
that, because the scan agrees with the entry. The rule that replaces it is in
`jobs/lifecycle.ts`:

> A column is worth writing because **something is waiting for the answer**, not
> because a query happens to carry it back.

## What was waiting for the answer

`projects.status`.

```ts
status: text('status', { enum: ['active', 'on_hold', 'complete', 'cancelled'] })
  .notNull()
  .default('active'),
```

The only statement that has ever written it is the conversion that creates the
job, and it writes `status: 'active'` — the literal that is also its default. So
the column has four values and **one of them has ever been reachable.**

`writerCandidates` could not see it, because an insert that names a column
counts as a writer. `insertOnlyColumns` counted it among 1,169 and said nothing
about which. And the register's entry for that table was about two *other*
columns, with a reason that was false.

## The narrowing device, which has been owed since Phase 202

`insertOnlyColumns`' docstring has said for ten phases that narrowing its number
*"needs a way to say which columns are **state** rather than **record**, and this
phase does not have one."* Here is one, and it is measurable rather than
editorial:

> A column is **state** when its declared domain holds more than one value — an
> `enum` list, or a boolean. It is **painted on** when it is insert-only, every
> write of it is the same literal, and that literal is also its schema default:
> no statement anywhere can make the column differ from what the database would
> have put there by itself.

Measured over the whole schema on the day the phase opened:

```
insert-only                                      1169
  … with a domain of more than one value            28
  … of those, written only ever as literals          4
  … of those, whose one literal is its default       1
```

The three survivors each survive for a **different** reason, which is what makes
the one a finding rather than a quota:

| column | domain | written | why it is fine |
| --- | --- | --- | --- |
| `progress_billings.isRetainageRelease` | 2 | `true` | defaults to `false`, so both values occur — the write *is* the distinction |
| `accountant_exports.result` | 2 | `'generated'`, `'held'` | no default; both literals are written |
| `refunds.direction` | 2 | `'out'`, `'in'` | no default; both literals are written |
| `projects.status` | **4** | `'active'` | its one literal is its default |

`paintedStates()` is that measurement, returning the list rather than a count,
because a count would go green at 0 and say nothing about what it had ruled out.

It does not whittle 1,169 down — 1,168 columns are still written once and never
changed, nearly all of them rightly (ADR 0021, ADR 0042). It narrows the
*question*.

## The three readers, measured before anything was built

ADR 0211 named three candidates for what a finished job should mean. Each turned
out to be a different kind of answer, which is the argument for measuring rather
than assuming they were all gaps:

| | reader | state before this phase |
| --- | --- | --- |
| 1 | off the WIP schedule | **exists and is correct** — `workInProgress` filters `status === 'active' \|\| status === 'on_hold'`, and had never been able to fire |
| 2 | out of the timesheet picker | **does not exist** — `listProjects` selects `status` and `/time/page.tsx` maps it off the row on the way to the dropdown |
| 3 | refuses new costs | **does not exist** — `assertDimensionsInCompany`, the one chokepoint every posting passes, selects `projects.id` and looks at nothing else |

Reader 2 is the sharpest of the three as a shape: the column reached the
component and the component did not ask. Not a missing query, not a missing
column — a value thrown away one line before the place it was needed.

## What reader 1 turns out to be about

The WIP filter is not cosmetic. `wipSummary` feeds `jobs.propose_wip_entry`,
which drafts the period-end adjusting entry against `1160 Costs in Excess of
Billings`, `2560 Billings in Excess of Costs` and `4200`. A job's over- or
under-billing is **in that draft**.

So "complete means off the schedule", taken literally, has a defect in it:

```
June     accountant posts the adjustment            2560 Cr 100,000
July     job marked complete, still over-billed
July     job leaves the WIP schedule
…        nothing ever proposes the reversal         2560 carries it for good
```

The answer is not a refusal on the act. It is that **completion does not take a
job off the schedule; being settled does** — which is what a real WIP schedule
does anyway, carrying closed-but-unbilled jobs until they clear. `reportsWip` in
the register means *on the schedule whether or not there is anything to report*,
and a state that is off it stays on it while the job's over/under-billing is
non-zero.

That is also why `JobFinancials` now carries `endDate`: *"closed on 2026-06-30,
still $12,000 underbilled"* is a line an accountant can act on, and without the
date the same row reads as an open job nobody is working.

Nothing about this changes a figure today, because today every job is `active`.
It changes what happens on the first day a job can be closed, which is this
phase.

## What was built

**`modules/jobs/lifecycle.ts`** — one register and one act.

`JOB_STATES` holds the four states, each arguing for itself, and each saying what
it means to the four things that read it: `terminal` (carries an end date),
`bookable`, `reportsWip`, `acceptsCosts`.

| | terminal | bookable | on the schedule | takes costs |
| --- | --- | --- | --- | --- |
| `active` | no | **yes** | yes | yes |
| `on_hold` | no | no | yes | yes |
| `complete` | **yes** | no | no | yes |
| `cancelled` | **yes** | no | no | **no** |

No two rows agree on all four, and the test asserts that: two states a reader
cannot tell apart are one state with two names, and the second is spare. The
pairs are close on purpose — `active` and `on_hold` differ only in whether you
may book time, `complete` and `cancelled` only in whether a cost may still
arrive — and those two distinctions are the entire reason the enum has four
members rather than two.

`complete` accepts costs because a subcontractor invoices in arrears and the
last delivery's bill arrives after the last day on site. Refusing it would push
a real cost onto a job that did not incur it, which is worse than a job
reappearing on the WIP schedule — and reappear it does, which is correct.
`cancelled` refuses, because the work it would pay for was never done.

`setJobStatus` is the act: `jobs:manage`, one statement, three columns. The end
date is **derived** from the state rather than typed beside it — a terminal state
carries the day it was reached and a live state has none, so reopening clears
it. `recordEmployment` (Phase 210) is the model and said why: *"a date and a flag
that each have their own control are two answers to `has this person left`."*

It refuses a future date, a date before the job started, a move the register does
not allow (naming the state to go through first — Phase 47), and a move to the
state the job is already in.

No module gate. A job is created by CRM conversion whether or not job costing is
switched on, so gating the act on `job_costing` would have reproduced this
phase's defect one level up: a company able to create jobs it could not close.

**The readers.** `workInProgress` reads `reportsWip` from the register instead of
holding the literal pair, and computes every job's figures before filtering,
because whether a closed job belongs on the schedule is a question about its
over/under-billing. `listProjects` gained `bookableOnly`, opt-in because the two
other callers want every job; `/time` passes it. `assertJobsAcceptCosts` is
called from `assertDimensionsInCompany`, so there is one answer to *may this cost
be coded here*, and the refusal names the date.

**The screen.** `/jobs/[id]` gained the state, its argument, the end date, the
note and the control. The options and their refusals are computed on the server
from `JOB_STATES` — a dropdown that knew which moves were legal would be a second
copy of the transition table, and the refusal would be written twice. So the
control offers every state and renders the refusal for the ones that cannot be
reached, which also means somebody reads *why* rather than finding an option
greyed out. `/jobs` shows the closing date on any closed job still on the
schedule.

The action's message is where the invariant surfaces to a person: closing an
over-billed job says so, with the figure and what to do about it, because *closed
and still on the schedule* is the outcome that would otherwise be found in a
report a month later.

## One audit action, and the type it had to be placed under

`job.status`, not `job.complete` / `job.cancel` / `job.hold` / `job.reopen`. The
interesting thing is always the pair of states and that is in `before`/`after`;
four actions would be four vocabularies for one correction (Phase 70).

Placing `job` in `READABLE_BY` is not a tidy-up. This phase writes the first
audit event about a project, and **`bookkeeper` holds `jobs:manage` and does not
hold `audit:view`** — so unplaced, the history of closing a job would have been
hidden from exactly the role most likely to be closing jobs. That is Phase 78's
sentence arriving at a different module: *"an audit entry the person who made the
correction cannot see is not much of an audit trail."*

Measured in both directions, because placing a type can take access away as
easily as give it: every role holding `audit:view` (owner, manager, accountant)
also holds `jobs:view`, so no reader loses a record. `sales` gains the history of
the job it has been able to open since Phase 3. Both halves are asserted.

## What else was corrected in passing

**`writerCandidates` and `insertOnlyColumns` were two copies of one scan.** They
shared `readNames` and duplicated the twenty lines around it — resolving the
table through a variable, balancing the `.values(`/`.set(` argument, collecting
the keys — in both. This phase needed a third reading, and a third copy would
have made the mechanism three places to correct, when every correction to this
scan so far has been to the mechanism (Phases 196, 197, 198, 201, 210). Extracted
as `writeSites`, which also carries the right-hand sides `paintedStates` needs.

The key-matching patterns are **byte-identical** to Phase 201's, deliberately, and
the code says why. Widening them to capture the right-hand side in one pass looks
tidier and is not equivalent: `foo: bar ? x : y` lets the widened pattern consume
the ternary's colon, so `x` stops being matched as a key. That is a *better*
answer — `x` was never a column — but a scan whose census moves because somebody
made it read more neatly is a scan nobody can compare across phases. The literals
are read in a second pass.

One test assertion moved **down** as a result. `the-switch-the-census-could-not-see`
pinned `readNames(file, tables)` appearing twice, commented *"called by both,
rather than a third copy of the loop"*. It is one now. The property was never
"two callers"; it was that the two scans cannot drift apart, and one shared pass
is the stronger form of it, so the assertion is kept and says so.

## What this does not do

**It does not reopen a job automatically when a late cost arrives.** A cost
posted to a complete job makes it under-billed again and brings it back onto the
WIP schedule, which is the visible half. The job stays `complete`, because
somebody decided it was and a posting is not a decision about scope.

**It does not schedule a closure.** Same limitation as `recordEmployment`, for
the same reason: the status is stored, so a job dated complete next month would
need something to come along and change it, and nothing would. A job is closed on
or after the day it finished.

**It does not place the other six job-costing entity types.** `cost_code`,
`change_order`, `sov`, `progress_billing`, `subcontractor` and
`compliance_document` write audit events and fall through to `audit:view`. That
is the same finding as `job`'s and it is not one seventh of a fix dressed up as
an entry — it is nominated below.

**It does not give `notes` a screen of its own.** The note is written by the act
that changes the state, which is when somebody has something to say, and it
replaces what was there. The previous text is in the audit event, which is where
the history of a field belongs rather than in the field.

**It does not seed a closed job.** The demo data has no terminal job, so the
walkthrough does not show a closing date. Changing the seed would move figures
the runbook and the README pin, and that is a phase about the demo rather than
about the column.

## What moved

The column census is **93 candidates and 12 findings over 13 columns**, across
2,176 columns and 185 tables — two fewer candidates, because `projects.endDate`
and `projects.notes` have a writer. `insertOnlyColumns` is **1,168**, and
`paintedStates()` returns three, none of them painted.

The isolation census is **305 writes and 979 reads** — one `scoped-write` for the
act, and two `scoped-read`s, the job the act is about to change and the job a
posting is being refused against.

One audit action (259), one entity type placed, no new record kind, no migration:
every column this phase writes was already there.

## Nominated for Phase 213

**The history nobody can read.** Six job-costing entity types write audit events
and none is placed in `READABLE_BY`: `cost_code`, `change_order`, `sov`,
`progress_billing`, `subcontractor`, `compliance_document`. Phase 78 found this
shape in the CRM — six types, every event falling through to `audit:view`, which
the role that produced them did not hold — and placed them. This phase found the
seventh and placed it alone, on the argument that a measured one-line correction
beats a quiet sixth of a phase.

The measurement to do first is the one that made `job`'s case: which roles can
*produce* each of those events, and whether they can read them. `bookkeeper`
holds `jobs:manage` and not `audit:view`, so the answer is probably the same six
times — but `withheldEntityTypes` is a `NOT IN` handed to the feed, so placing a
type narrows what some readers see as well as widening it, and that half has to
be measured per type rather than assumed from `job`'s.

Behind that: the four `notes` columns and the two `journal_entry_id` columns, of
the twelve findings still in the register; the CRM account panel's missing
payables side (ADR 0208); the four joins from an unscoped primary (ADR 0198); and
§11's six remaining functions.
