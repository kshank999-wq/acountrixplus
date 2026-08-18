# ADR 0033 — A check nobody runs is not a check

- **Status:** Accepted
- **Date:** 2026-08-18
- **Context:** Spec §19, §18
- **Builds on:** [ADR 0010](0010-at-least-once-and-who-decides.md),
  [ADR 0024](0024-nothing-grows-for-ever-and-nothing-waits-for-somebody-to-look.md),
  [ADR 0031](0031-what-is-owed-is-owed-by-somebody.md),
  [ADR 0032](0032-change-is-not-a-transaction.md)

## Context

Eleven phases each wrote a reconciliation. Phase 14 proved the stock lots
against the Inventory account, Phase 16 the asset register against 1500 and
1590, Phase 23 the deposits register against 2580, Phase 26 the funds, Phase 27
work in process, Phase 28 the tips, Phases 29 and 30 the gift cards and the
authorisation cache, and Phase 31 the control accounts. Each was written
carefully, tested, and put on a page.

Measured before this phase: **nine reconciliation functions across nine
modules, and not one of the seventeen scheduled job kinds ran any of them.**

Every check in the books existed only in the moment somebody opened the page
that called it. That is the exact inversion of what a reconciliation is for: it
is meant to catch a drift *nobody is looking for*. A check that only runs when
somebody is already suspicious catches nothing they would not have found
anyway.

ADR 0031 and ADR 0032 both listed "run `controlAccounts` nightly" as a
follow-up, and Phase 31 taught what a follow-up repeated across consecutive
ADRs usually means. So this is the whole set rather than that one — the same
generalisation Phase 24 made when four phases had each left a retention job
owed.

Five claims, asserted in `tests/books-integrity.test.ts` (26 tests):

1. **Every reconciliation is in the register, and the register is what runs.**
2. **A check expected to differ is not a fault**, and is not alarmed on.
3. **A check that could not run is not a check that passed.**
4. **One drift is one alarm**, not one a night until somebody fixes it.
5. **What was wrong last night is on the record**, so *when did this start* has
   an answer.

## Decision 1: the checks become a register, and the register is the loop

`src/modules/integrity/register.ts` names all ten checks — key, label, what two
things it compares, which module has to be on, what a difference *means*, and
the function that runs it.

The value of writing them down is not tidiness. It is that a check which exists
only as a function called from one page is invisible to anything that wants to
run all of them, and the ten were invisible in exactly that way. A list is what
lets a scheduler, a page, and a notification all mean the same thing by "the
books agree".

Keys are stable and stored on every finding, because they are what a history is
joined on. `compares` and `meaning` deliberately live in the register rather
than on the stored row: they are the *current* explanation of a check, and a
finding from six months ago should be read with today's words for what the
check does.

## Decision 2: three of the ten are positions, not faults

This is the part that would have been easy to get wrong, and getting it wrong
would have made the whole thing worthless.

Seven checks compare two things that **must** agree — nothing legitimately
moves a control account except a document, nothing moves the stock ledger
except a stock movement. A difference there is always a defect.

Three do not:

| Check | Why it differs in ordinary trading |
| --- | --- |
| What practitioners have earned, against 2320 | Payroll draws on the account. That is payday. |
| Tips collected, against 2310 | The same, for the same reason. |
| Donations that name no fund | A charity really does receive unrestricted money. |

A register that treated all ten alike would raise an alarm every payday and
every time a donation arrived without an appeal attached. The predictable
result is that the alarm is switched off before the night it matters. That is
Phase 24's rule — *silence has to mean something* — applied to the books
instead of to the queue, and it is worth as much here.

So a `position` is run, recorded and shown, with its gap as a number somebody
actually wants: *"$50.00 paid out so far"* is the answer when a stylist asks
what they are owed this month. It is simply never an accusation. Verified on
the seeded demo: the salon's page reads **"1 check has stopped agreeing"** while
displaying two differences, because only one of them is a fault.

## Decision 3: three outcomes, kept apart

A check comes back one of three ways, and collapsing any two is how a
monitoring system stops being one:

- **Ran, and agrees.**
- **Ran, and disagrees.**
- **Did not run** — either *skipped*, because the module is off, or *errored*,
  because the check itself threw.

The last distinction is the one worth defending. A check that throws and is
swallowed looks exactly like a check that passed, and the failure mode is a
company told its books are fine for six months by a query that has been raising
a type error since somebody renamed a column. So an error is recorded as its
own finding, with the message kept, and shown as *"could not be checked"* — not
as a difference. **"These disagree" and "nobody knows whether these agree" are
different problems.**

A skip is not a pass either. It is counted separately and the page says so in
as many words: *"6 run, 5 skipped because their module is switched off — which
is not the same as passing."* A module switched off by accident must not read
as a module in good order.

Each check runs in its own `try`. One loop that threw would mean the first
broken check hides every check after it, which is the worst ordering dependency
to have in the thing that tells you what is wrong.

## Decision 4: the run is written down, and so is every finding

Two tables. `integrity_findings` is the obvious one; `integrity_runs` is the
one that earns its place.

A run happens whether or not anything is wrong. Without the run row, a company
with no findings is indistinguishable from a company whose scheduled job
stopped firing three weeks ago — which is this phase's own argument reproduced
one level up. The operations page therefore has a distinct "never been checked"
state, and says: *"Nothing has run one yet — which is not the same as nothing
being wrong."*

The findings are stored rather than recomputed because they answer the question
no reconciliation can: **when did this start?** That decides whether somebody is
looking for a bad deploy on Tuesday or an import last March, and it cannot be
derived — Phase 31 already named why. The balances are as at a date; the
documents are as they stand today. Reconstructing what a subledger said on an
arbitrary past date means replaying every payment application. Writing down what
the check said each night is cheap and answers it exactly.

A year is kept, under a retention policy naming `integrity_runs`; findings go
with the run by foreign key, so the allowlist stays one policy per table and
remains the whole truth about what retention can reach.

## Decision 5: notify about what broke since last night

A drift is *persistent* by nature. A stock difference from a bad import in
March is still there in April, so a digest reporting everything currently wrong
would send the same message every night until somebody fixed it — and would
stop being read at about the point a second, different drift appeared.

So `newlyBroken` compares tonight's broken checks against the previous run's
and notifies only about the difference. Everything else is on the page for
anybody who wants it. What arrives on a phone is news.

Two details:

- A check that was *erroring* and now *disagrees* counts as new, because it is a
  different thing to know.
- On a first run there is nothing to compare against, so everything broken is
  news. A company whose books have never been checked should be told what is
  wrong with them.

`books_disagree` is its own notification topic rather than folded into
`background_failures`. Phase 24 wrote the reasoning when it added that one:
folding topics together means somebody switching off the noisy one also
switches off the one that matters. The machinery stopping and the numbers being
wrong are not the same interruption. Recipients are chosen by
`reports:financial` rather than `company:manage` — the person who needs to know
the stock ledger has drifted is whoever reads the balance sheet, not
necessarily whoever administers the account.

## The bug this phase found, which was worse than the one it set out to fix

While checking whether *"the books are checked nightly"* was actually true, the
schedule turned out never to be installed.

`installCompanySchedules` was called from `src/db/seed.ts` and from nowhere
else. `registerCompany` never touched schedules at all. The comment at the top
of `defaults.ts` has said since Phase 10 that schedules are *"installed on
demand rather than at registration, because a company that signed up before
this phase existed should get them too"* — and nothing ever demanded them.

So **no company created through the sign-up form had a single schedule.** No
bank sync, no campaign send, no rent run, no remittance reminder, no follow-up
chase, no failure digest — six phases of scheduled work that ran in the demo,
passed their tests, and did nothing whatever in production. Adding a seventh to
that list would have made this ADR's central claim false on the day it was
written.

The fix is `ensureSchedules()`, called at the top of every worker tick. It
reads what exists, writes only what is missing, and is safe to run every tick
because `upsertSchedule` is keyed on (company, kind). Registration alone would
have left every existing company without them, and a backfill migration that
installs schedules is a migration that starts sending email; topping up from
the tick fixes both and needs no bootstrap.

This is the same failure this phase exists to catch — work that is written,
tested, and silently never performed — occurring in the machinery that performs
the checks. It is a good argument for the phase and a poor advertisement for
the eleven that preceded it.

## Consequences

- **Ten checks now run nightly per company**, at 02:00 UTC, after the recurring
  entries have posted so the day being checked is complete.
- **The full run happens even when everything is fine**, which is the cost of
  being able to tell "clean" from "not running". Ten queries a night per
  company is not a load worth optimising against that.
- **`asOf` is today's date for the whole run**, so the receivables and the
  inventory describe the same moment. A run that measured one at 23:59 and the
  other at 00:01 would be comparing two nights and calling it one.
- **The register is code, and nothing enforces that a new reconciliation joins
  it.** A twelfth module could add a check and forget, and this phase would not
  notice — the same class of omission it exists to fix, one level up. The
  register's own doc comment is the record; a lint rule would be better.
- **Historic `asOf` remains approximate**, per ADR 0031. The stored findings
  make the *history of the check* exact, which is the part that was missing;
  they do not make a retrospective re-run exact.
- **Nothing is repaired automatically**, and deliberately. This tells somebody
  the books disagree; it does not decide which side is right. A tool that
  journalled a plug to make a control account agree would destroy the evidence
  of what actually went wrong.
- **A reader without `reports:financial` sees no books section at all**, rather
  than an empty one. A bookkeeper has `operations:view` and not
  `reports:financial`, so the first draft told them the books had never been
  checked — which was a false statement rather than a missing one. Absence of a
  claim is the only honest rendering when the claim is not visible to you.

## Follow-up

1. **A per-check history on screen.** `checkHistory` exists and answers "when
   did this start"; no page calls it yet.
2. **A lint or test that fails when a module gains a reconciliation the
   register does not name**, closing the gap named above.
3. **Run the checks as at a *closed period* end**, not only today, so a year-end
   review can ask whether the books agreed then.
4. **Reconcile the bank**, which is the one comparison a business does daily and
   this register does not contain — Phase 2 built the workflow, and it is a
   human matching exercise rather than a two-sided sum, which is why it is not
   here.
