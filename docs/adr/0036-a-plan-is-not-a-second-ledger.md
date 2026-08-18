# ADR 0036 — A plan is not a second ledger, and a variance has a direction

- **Status:** Accepted
- **Date:** 2026-08-18
- **Context:** Spec §13 — the professional accounting workspace. Company budgets
  are not named in the spec's list; job budgets (Phase 7) were. This is a
  capability chosen beyond it, on the grounds that a QuickBooks alternative
  without a budget is a ledger.
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0011](0011-the-same-books-read-two-ways.md),
  [ADR 0031](0031-what-is-owed-is-owed-by-somebody.md),
  [ADR 0033](0033-a-check-nobody-runs-is-not-a-check.md)

## Context

Thirty-five phases in, this system can say precisely what a business earned and
spent. It cannot say whether that was what anybody expected.

Every report so far describes the past. A budget is the first thing in the
codebase that describes an *intention*, and the comparison between the two is
the number a small business actually runs on: not "revenue was $66,942" but
"revenue was $108,057 short of what we told the bank".

Five claims, asserted in `tests/budget.test.ts` (37 tests):

1. **A budget is a plan, not a second ledger.** Nothing here ever posts.
2. **Spreading has a remainder and the remainder is placed**, so the months
   always sum back to the year.
3. **A variance is signed by what the account is for.** Under on revenue is bad;
   under on expenses is good; a report showing both as "−$500" says nothing.
4. **An unbudgeted account is not an account budgeted at zero.**
5. **The actuals come from the Profit & Loss itself**, so the two cannot
   disagree.

## Decision 1: `budget_lines` is the first money the trial balance never sees

Every other table in this schema that holds an amount eventually becomes a
journal line. This one must not, and saying so is worth a decision record
because the pull is real — posting the budget would make it appear on every
existing report for free.

It would also make every business hit its plan exactly, because the actuals it
is compared against would contain it. A budget that posts is not a budget.

## Decision 2: a month is the grain

Not a quarter: a business that misses January and catches up in March has had a
problem a quarterly budget hides. Not a day: nobody plans a Tuesday.

The comparison is over **whole months only**. A range ending on the 14th has no
defensible share of February's plan, and pro-rating one would look precise and
be arbitrary — a business does not earn its February evenly. `monthsCovered`
drops the partial month and the screen says it did.

## Decision 3: the remainder is placed, not dropped

$10,000 across twelve months is $833.33 twelve times, which is $9,999.96. A
budget whose months do not sum to its own annual figure is one somebody will
try to reconcile at year end and cannot.

An even spread hands the leftover cents to the earliest months, the convention
`allocateCents` already uses. A **weighted** spread hands them to the periods
that lost the most to rounding instead — earliest-first would systematically
favour January in a seasonal business, which is the one thing a weighted spread
exists to avoid.

Weights are whole numbers. A weight is a *relative* size, so "1.5 against 1" is
always expressible as "3 against 2", and requiring integers keeps every
multiplication out of floating point (ADR 0002) at no cost to the caller.

## Decision 4: favourable is a judgement, and it is made once

```
    Revenue, other income      more than plan  → favourable
    Expense, cost of sales     less than plan  → favourable
```

This is the same lesson as `balanceForAccount` returning the *normal* balance:
the sign of a number about an account is meaningless without knowing which side
of the books it lives on, and the place to resolve that is once, in a pure
function, rather than at every call site and in every reader's head.

`varianceCents` stays what it says — actual less budget — and `favourable` is
carried beside it rather than folded in. A signed "good is positive" figure
would produce a report whose columns cannot be added up.

A section's verdict comes from the same function applied to the section's own
totals, **not** from counting how many rows were favourable. Nine rows a dollar
under and one row a fortune over is not a favourable section, and a majority
vote would say it was.

Exactly on plan is favourable rather than adverse. It is not news, and a screen
that paints a met budget red is one nobody trusts.

## Decision 5: the actuals come from the income statement, not a second query

`budgetVsActual` calls `profitAndLoss`. Not a query over `journal_lines` that
filters the same way — the same function.

This is a deliberate departure from the pattern [ADR 0026](0026-a-restriction-is-the-donors-not-the-charitys.md) and ADR 0031
established, where two genuinely independent derivations are compared and any
difference is the alarm. The difference is what the numbers are *for*: a control
account is a reconciliation, and reconciliation requires independence. This is a
presentation of one figure beside another, and a budget report that quietly
disagreed with the income statement would send somebody hunting for a variance
that was really a `WHERE` clause.

Independence where the point is to catch drift; one source where the point is to
be believed.

## Decision 6: unbudgeted is its own answer

$5,000 of legal fees nobody planned for is a real and interesting fact. Reported
as *budget $0, actual $5,000, 100% over* it becomes a percentage of nothing,
sorted among the rows that merely drifted.

So the rows are partitioned: accounts with a plan get a variance, accounts with
activity and no plan are listed separately with **no variance at all**. The
reverse case is not dropped either — a budgeted account with no activity reports
its whole budget as unspent, because silently omitting it would let somebody
close a month believing they had spent the rent.

`basisPoints` is `null` rather than a number when the budget is zero. Spending
$400 against a plan of nothing is infinitely over, which is not a figure anybody
can act on.

## Decision 7: several budgets per year, and approving one archives the last

"Approved" and "Revised" and "What if we hire two people" are all real. A system
holding one plan per year is one that overwrites the number a business agreed
with its bank, so uniqueness is on *name within a year* and a revision is a new
budget.

Approving one archives any other approved budget for that year in the same
transaction, so "the plan" is never ambiguous. Approval is deliberately **not** a
lock: a plan somebody keeps adjusting is still a plan, and refusing to let them
would send the adjusting into a spreadsheet where nothing can compare it to
anything. That is ADR 0011's distinction, reused — closing and locking are
different acts.

## Decision 8: no integrity check, and that is the decision

Phase 33 built a register of every reconciliation and made a nightly run of all
of them. Phase 34 and Phase 35 each added one. This phase adds **none**, and a
test asserts that no `budget.*` key exists.

A budget posts nothing, so there is no ledger side to compare it against. A
check could only ever agree, and ADR 0033's own argument is that a register is
useful exactly as long as everything in it can fail. Adding a check that cannot
is how a register becomes a list nobody reads.

## The two bugs browser verification caught

Both were the same bug, and both were **this phase's own thesis, violated in this
phase's own report**.

The variance screen showed *"NOT BUDGETED AT ALL — $37,906.35"*, a single figure
summing unbudgeted rental income with unbudgeted wages. It reads as an overspend
and was really $6,558 of unplanned income against $44,464 of unplanned cost. The
plan grid did it a second time, with a "Total" row adding planned revenue to
planned rent and calling twenty-five plus five thirty.

Both now report income and cost apart, with a net figure that means something —
`net effect on the result`, and `Planned result`. Two regression tests name the
case.

That an argument written down in `varianceFor`'s own doc comment was broken
twice, forty lines away, is the useful part: a principle in a comment is not a
principle in the code, and reading the screen is what found it.

## Consequences

- **Nothing about any existing report changes.** No posting path was touched,
  and the trial balance cannot know this phase happened.
- **The variance sections and net income do not add up when anything is
  unbudgeted**, deliberately: net income is the income statement's own figure
  and includes the unplanned accounts, while the sections cover only what was
  planned. The unbudgeted block is shown next to them so the difference is
  visible rather than mysterious.
- **A budget is per company and per account.** Not per dimension, not per job,
  not per customer — a budget by location is a real request and would need
  Phase 16's dimensions on `budget_lines`.
- **Fiscal years start in January.** `month` is 1–12 against a calendar year,
  and a business whose year starts in April has no way to say so.
- **Nothing warns when actuals drift past plan.** The report answers when
  somebody opens it; Phase 24's scheduler and Phase 33's notifier could make it
  arrive, and neither is wired up.
- **Approval does not freeze the figures**, so "the plan we agreed" is a name
  rather than a guarantee. The audit log records every change to it, which is
  the honest half of that trade.

## Follow-up

1. **Budget by dimension**, so a company with three sites can plan them apart.
   `budget_lines` would take a `dimensions` column exactly as journal lines did.
2. **A cash-flow budget**, which is the one a small business actually loses sleep
   over. This is profit and loss only.
3. **Alert on a variance past a threshold**, through the Phase 10 worker — the
   difference between a report somebody opens and a fact that finds them.
4. **Non-calendar fiscal years**, which needs a start month on the company and a
   rethink of `monthRange`.
5. **Import a budget from a spreadsheet**, since that is where most of them
   currently live. Phase 17's CSV machinery is most of it.
