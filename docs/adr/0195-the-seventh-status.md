# 0195 — The seventh status, and the figure nobody supplied

**Status:** accepted
**Date:** 2026-11-07
**Phase:** 195

---

## The nomination, and what was being tested

ADR 0194 nominated **§9's and §11's gap rows**, re-measured. Both were written
in Phase 173, both were patched once, neither had been checked since, and both
are the shape — a list in a cell, amended in place — that this process had
found wrong four times out of five in §7.

ADR 0194 picked §11 as the more interesting of the two, on a specific
hypothesis: it had been revised **upward**, five to seven, *"which is the one
direction a stale row has not yet been wrong in here"*.

Both rows are wrong, and both in that direction. They claim more than is
there — which is the opposite of what the §7 rows did, and it is why those were
cheap to close and these were not.

## §9: the status nobody wrote

§9's **first** bullet asks for *"proposal counts and value by Draft, Sent,
Viewed, Won, Lost, Expired, and No Decision"*. `proposalStatusEnum` has carried
all seven since Phase 3. Measured, **six were reachable**: nothing in this
application ever set `expired`.

Everything else was here.

| | |
| --- | --- |
| the date | `proposals.expires_on`, written since Phase 3 |
| the client's answer | `acceptance.ts` has refused a lapsed proposal by comparing it against today since Phase 3 |
| the reporting | `serviceBreakdown` already classified `expired` beside `lost` |
| the transition | **nothing** |

So the company's dashboard counted a lapsed proposal as *sent* — out with a
client, awaiting a reply — while the link it had been sent on told that client
it had expired. **Two documents disagreeing**, which is the defect this project
names more often than any other, and here it was disagreeing with the person
outside the company.

It is also the fourth consecutive phase to find one shape: a build nobody ran
(192), a function nobody called (193), a price nobody re-read (194), a status
nobody wrote (195).

### A sweep, and what it deliberately does not write

`lapseExpiredProposals` plus a daily `proposals.lapse_expired` schedule. The
precedent is this project's own: `payments.sweep_checkouts` writes
`status = 'expired'` on checkouts nobody came back from, and the payment
service re-checks on read anyway. `isAcceptable` is that re-check here, and it
stays, because a client can open the link in the hour before a sweep runs.

**`decided_at` is left alone**, and that is the decision rather than an
omission. §9's *"average time to decision"* counts every proposal carrying both
timestamps, so stamping it on a lapse would feed every expiry into that mean at
exactly whatever validity window the company happened to set — dragging a §9
figure toward a number nobody chose, in the direction that flatters it.

Which is why **`decideProposal` no longer accepts `expired` at all.** Two
writers of one status with different side effects is two answers to one
question. Expiry is the clock's doing and has no author; somebody closing a
lapsed proposal by hand has `no_decision`, which is what that is. The buttons on
the proposal list have always offered exactly the three it now accepts, so
nothing on screen changed.

The opportunity is not moved either. A proposal lapsing is not a deal lost — a
revised proposal on the same opportunity is the ordinary next step — and §9 has
`lossReasons` for the judgement.

No backfill and no migration. Phase 33's `ensureSchedules` tops every company
up from the worker's own tick, so existing companies acquire the schedule
without a migration that starts changing proposal statuses at deploy time. The
first run lapses whatever is already past its date, which is the intended
effect and is the one run where the number will be large.

### The ambiguity that let it hide

`proposalStats.byStatus` was built from the rows the query returned, so it held
only the statuses that happened to have a proposal, in whatever order they came
back. **A status missing from a table of counts is ambiguous between "none" and
"not reported"**, and that is the whole mechanism: a status with no writer looks
exactly like a status with no rows.

It is seeded from the enum now — all seven, in pipeline order, zeros included.
The dashboard's "Proposals by status" card also stops reading in query order,
which it had done since Phase 3.

## §11: seven of seven rows, and 25 of 33 functions

The seven are right. **The unit is not.** §11 is a table whose *Function* cell
lists several things per row, and counted that way it asks for thirty-three:

| §11 row | functions | behind them |
| --- | --- | --- |
| Bookkeeping | 5 | 5 |
| Reconciliation | 3 | 3 |
| Proposal Writer | 5 | 4 |
| Design Assistant | 5 | 3 |
| Marketing | 5 | 1 |
| Strategic Account | 4 | 4 |
| Business Insights | 6 | 3 → **5** |
| **total** | **33** | **23 → 25** |

Both numbers are worth keeping. A row with a prompt behind it is a capability a
company can switch on; a function with nothing behind it is something §11 asked
for. *"Seven of seven"* was true of the first and silent about the second.

Two of those twenty-five are counted generously, and the generosity is stated
in the audit rather than buried: the Design row's *"background/graphic
concepts"* and *"image prompts"* are **one feature answering two of §11's
words**. Counting both double-counts it; counting neither misreports it. The
Marketing row's single point is the drafting itself — `draftCampaignCopy`
passes the company name, the segment, the audience size and the goal, and **no
voice**, while the proposal writer's prompt says *"write in the company's
voice"* and is given the catalogue to infer it from.

### The two that were starved rather than absent

`insights.business`'s own first rule is *"every insight must be traceable to a
figure you were given"*. §11 asks that capability to explain **"expense
changes"** and **"cash-flow trends"**.

It had been given **no expense figure at all**, and for cash a single balance —
which is a position, not a trend. So it did the right thing with what it had: it
said nothing about either, and **the silence read as a quiet month rather than a
missing input.** That is the sharpest finding of the phase, because the prompt
was not broken and no test could have failed: a well-behaved model obeying a
good rule about facts it was never handed.

Nothing new had to be computed. `comparativeProfitAndLoss` has produced two
columns of a real profit and loss since §13's comparative periods were built;
`cashFlowStatement` has stated opening, closing and net movement since Phase 33.
The calls were never made.

So the change is two calls, one gate and a template value. `calendarMonth` went
into `ledger/comparative.ts` rather than the caller, because that module already
owns period arithmetic and a caller computing month boundaries by hand would be
the second answer that got February wrong. Read in UTC deliberately: every date
in the ledger is a zoneless `date`, and reading the clock locally would put a
transaction posted on the first into the previous month for half the world.

The figures are gated on `reports:financial`, as the win rate beside them is
gated on `crm:view`, and the gate renders an **absent section** rather than
zeroes. A prompt reading `Operating expenses: $0.00 (was $0.00)` is a prompt the
model would have had to explain, and the honest explanation — a company that
spent nothing in two months — is false.

### Version 2, and why version 1 stayed

`resolvePrompt` takes the highest built-in version, and the gateway writes
`promptVersion` into every `ai_requests` row. Editing version 1 in place would
have rewritten history under rows that already cite it, and §12 asks for a
registry with *"versioning, testing, and rollback"* — **a version that can be
rewritten is not a version**, and rollback would roll back to the new text.

### The one left as a gap, and named as one

Business Insights' sixth function is *"operational trends"*, and nothing
operational reaches that prompt: not the uncategorized backlog `inboxShape`
already counts, not unreconciled accounts, not overdue follow-ups. Unlike the
two above, it needs a figure **chosen** rather than a call made, which is a
different piece of work and a different kind of risk — picking the wrong
operational measure would be worse than the current silence.

Recorded in §11 rather than built, so the next phase to read that row finds the
measurement instead of the round number.

## What the registers reported, and the one blind spot they have

`PINNED_CLAIMS` moved **14 → 15**, and the fifteenth is a *third* claim in
`docs/SPEC-AUDIT.md`: its §11 prompt count. Pinned on **distinct keys** rather
than entries, because this phase is precisely what parts the two — eleven
entries for ten capabilities. A new version of an existing prompt must not move
that sentence and a new capability must.

Three entries in one file is the register reporting which document it most
expects to go stale, which is the right document for it to say that about.

The isolation census moved three of its four numbers — **570 of 935 reads, 29
of 119 writes**. Worth stating exactly how that was learned, because the
register did less than the last two phases' ADRs imply: `claimStands` reports
the *first* capture that disagrees, so it named number 1 and stopped. The other
two were found by asking `isolationCounts()` directly. That is still the
mechanism working — nobody had to notice — but "the register named which of the
four" is true of one of them per run, not all four.

**And it reported one it cannot report.** `scanWrites` recognises a keyed write
from `eq(x.y, input.z)` or `eq(x.y, zId)`. The expiry sweep's update was first
written as `eq(proposals.id, proposal.id)` — tenant-filtered, correctly guarded,
and **absent from the census entirely**, because the key is a local row's
property rather than a parameter. The write is destructured to `proposalId` now,
which reads better and is also what makes it visible; the number that census
states is a floor rather than a total, and §19's isolation claim is argued from
it.

That is nominated below. It is deliberately not fixed here: widening the regex
reclassifies writes tree-wide, and doing it in the same phase as two spec
findings would mean nobody could tell which change moved which number.

### And a register that moved because somebody wrote prose

The full suite found two more, and the second is the phase's best finding by
some distance.

`money-comparison` caught `varianceBasisPoints(expenseCents,
priorExpenseCents)` as a new comparison site, undeclared. Registered as
`home-money`, argued from the schema: both operands are
`comparativeProfitAndLoss` column totals, which are sums over `journal_lines`,
and `journal_lines` has no currency column and never will. Same shape as
`heldRevisions`, which went two phases undeclared; the difference is that this
one was declared in the hour the comparison was written, which is all the
register is for.

`money-on-screen` caught something else. Its `documentsBehind` read each
module's **raw** source, so a sentence naming a table counted as a query
against it. `lapseExpiredProposals`' docstring cites the precedent it was built
on — the checkout sweep, written as a dotted job name — and `payments` is a
denominated carrier, so that sentence made `crm/proposals.ts` look like a
module reading the payments table. The public proposal page, whose only hit in
any module was that comment, acquired a document and pulled
`p/[token]/acceptance-panel.tsx` into the scan.

**A register moved because somebody wrote prose.** Every sibling scan already
strips comments — `money-comparison`'s `readable`, `isolation-scan`'s
`readableSource` — on `enclosing.ts`' own rule that prose about a query must
not be counted as one. This was the copy that did not, which is that module's
finding about copies drifting, one scan over. And the dangerous direction is
the other one: a scan whose answer depends on the comments can be *quieted* by
editing them, so deleting a sentence could drop a screen out of the scan while
the test went green.

Measured both ways, the remainder is **29 raw and 19 stripped**. Ten screens
were in that list only by accident of punctuation, and nothing is lost by their
going: every one is the company's own money on a screen that shows it — a
depreciation schedule, a budget, a dimension roll-up, a trial balance, a day's
till, a proposal, a catalogue price. `proposals` and `service_items` have no
currency column at all, so four of them cannot be foreign by construction, and
the rest are ledger figures. The file's own prose had said as much when they
arrived — *"a ledger balance is the ledger's money"* — which is why they were
counted rather than declared. Not being reached is the more honest version of
the same answer: this remainder is meant to be the screens somebody should
look at.

A tripwire goes with the fix, on a synthetic page rather than the real tree,
because a tree where no comment happens to mention a carrier would let the
real-tree version pass either way. Phase 121's rule, applied to the repair.

## What this does not do

**It does not expire an opportunity, or close one.** Only the proposal.

**It does not build §11's six remaining functions.** Four are prompts with no
screen to put them on, and two — segment suggestion and nurture sequences — are
§10 work wearing an §11 label. Counted and recorded, not started.

**It does not make a cash-flow comparison across periods.** The current month's
opening, closing and net movement is a trend; the prior month's movement would
be a second one and costs two more passes over the whole ledger for a sentence
the revenue and expense columns substantially already give.

**It does not make `claimStands` report every drifted number at once.** Its
loop returns on the first capture that disagrees, so a sentence stating four
numbers takes up to four runs to correct — which is what this phase hit. One
line to change, and deliberately not changed here: a register's own failure
message is the last thing to edit in a phase that is relying on it.

**It does not re-measure §20.** ADR 0194 named *"Phases 0–8 all have shipped
work"* as the last unmeasured sentence in the audit, and it still is.

## Nominated for Phase 196

**The source scans, audited as a set.**

Three of them reported this phase, and two reported a hole in themselves:
`money-on-screen` had been reading comments as code since Phase 124, and
`scanWrites` cannot see a write keyed by a fetched row's own id. Both were
found the same way — by a change moving a count the wrong amount — and neither
would have been found by reading the scan.

So the question for 196 is not either one of them, it is: **what else do the
scans not see?** There are five or six reading the same tree with five or six
private copies of "readable source", and `enclosing.ts` already exists because
two of those copies had drifted and one was wrong. This phase found a third.
The work is to measure each scan's reach against the thing it claims to cover,
and the cheapest honest start is the one below.

### Starting with the write census

**`scanWrites`' blind spot, and the census denominator.**

The write census is the measurement §19's *"strong tenant isolation"* paragraph
is argued from, and this phase found that it does not see a write keyed by a
fetched row's own id. One such write existed and was found by accident, because
it was mine and the count did not move when I expected it to.

The questions, in order: how many writes are invisible to it today, are any of
them unguarded, and does the same gap exist on the read side. The first is a
regex; the second is the only one that matters; the third is the one most likely
to be answered "no, for a reason worth writing down" — `scanReads` counts every
`.from(` rather than only keyed reads, so it may have no analogous hole at all.

Phase 187 moved these scans out of two test files precisely so a number like
this could be asked for from anywhere. This is the first phase to ask it
something the scan cannot answer, which is the right next question for it.

Behind that: §20's *"Phases 0–8 all have shipped work"*, still the last
unmeasured sentence in `docs/SPEC-AUDIT.md`.
