# ADR 0026 — A restriction is the donor's, not the charity's

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §5 ("Nonprofit — **funds/restrictions, grants, donors,
  program reporting**"), §13, §23
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0016](0016-the-parts-sum-to-the-whole.md),
  [ADR 0023](0023-somebody-elses-money.md)

## Context

`funds` has been a declared industry module since Phase 0, switched on by the
nonprofit pack, doing nothing. So have the nine accounts that pack installs.
This is the fifth of §5's fourteen rows to get a real module, after
construction (Phase 7), retail and its four cousins (Phase 14), professional
services (Phase 15) and real estate (Phase 23).

Fund accounting is the row that is least like the others. A job, a stock item
and a tenancy are all *things the business does*; a restriction is a statement
about **what the business is allowed to do with money it already holds**. That
makes it the first industry module whose subject is a constraint rather than an
activity, and the constraint belongs to somebody who is not the user.

Four claims, asserted in `tests/funds.test.ts`:

1. **A restriction is the donor's, not the charity's.** A fund never releases
   more than it was given, whatever it spends.
2. **A promise is revenue when it is made**, and receiving it later is not
   revenue a second time.
3. **A release changes no total.** It moves money between two columns.
4. **Spending is whatever the ledger says**, including postings made through no
   part of this module.

## Decision 1: a fund is a dimension value, and there is no per-fund report

The same trick as a property. Creating a fund creates a value in a company-wide
Fund dimension, every posting this module makes carries it, and **programme
reporting is Phase 16's dimensional profit and loss**.

The absence is the design. It is what makes a bill coded to the roof appeal by
a bookkeeper who has never opened the funds screen count as spending against
the roof appeal — and therefore earn its release. A module that only counted
expenditure booked through its own API would silently under-release exactly the
charities with enough staff to have a bookkeeper.

## Decision 2: a fund is not a bank account

Restricted money sits in the same current account as everything else. The
restriction is a promise about what the charity may do, not a statement about
where the money is.

Modelling a fund as an account would force an internal transfer every time
somebody paid a supplier, and would report as solvent a charity that had spent
its endowment. Modelling it as a dimension costs nothing and says the true
thing: one bank balance, several claims on it.

## Decision 3: the release is a pair of accounts, not one signed number

`4590 Net Assets Released from Restriction` is debited and
`4595 Net Assets Released — Unrestricted` is credited. Both are revenue, so they
sum to zero and the total income for the year is identical either side of a
run.

One account with a signed amount would also net to zero, and would also be
invisible: a reader could not see that £400 left the restricted column
*because* £400 arrived in the unrestricted one. The two-line entry is the
sentence "this money stopped being restricted", written where an accountant
looks.

The debit carries the fund's dimension and the credit deliberately carries
none. The money is no longer any fund's — that is what release means — and
tagging it back to the appeal would leave the appeal's dimensional balance
unchanged by its own release.

## Decision 4: release the lesser of what was given and what was spent

`releaseFor(available, spent)` is one comparison and it is the whole phase.

The two directions are different mistakes and both are common. Releasing the
spend regardless of the balance drives a restricted fund negative, which on a
balance sheet reads as a donor owing the charity money. Releasing the balance
regardless of the spend releases restriction nobody satisfied — a charity
reporting that it has met a condition it has not met.

## Decision 5: the shortfall is recorded, not hidden and not blocked

A charity really can spend more on a programme than was given for it, out of
its general money. The run posts the release for what the fund *could* cover
and records the excess on the release row.

Refusing to post would leave the books wrong in order to protest about a
decision somebody had already taken. Silently inflating the release would be
worse. So the number survives, on the row, and it is recomputed from nothing —
recomputing it later from today's balances would quietly forgive an overspend
that a subsequent donation happened to cover, and that overspend is precisely
what an auditor is asking about.

## Decision 6: a promise is revenue on the day it is made

An unconditional promise to give is a receivable. A charity told in December
that it will receive £50,000 in March has £50,000 of revenue in December and
£50,000 it cannot spend yet.

Waiting for the cheque would report the year the appeal succeeded as the worse
year and the following one as a windfall — exactly backwards for a trustee
trying to work out whether the appeal worked.

The consequence lands on the other side, and it is the part that is easy to get
wrong: **receiving a pledge posts no revenue at all.** An entry there that
touched an income account would count the same gift twice in a way that
reconciles perfectly — the bank agrees, the fund agrees, and only the income
for the year is wrong, by the size of the appeal.

## Decision 7: an endowment's principal is never releasable

`isReleasable` is false for `perpetual`. A donor who gives money to be held
forever has not given money to be spent, and a charity that released endowment
principal as it spent would report a growing unrestricted balance made entirely
of money it is not allowed to touch. Endowments are filtered out of the run
rather than shown as funds with nothing to release.

## Decision 8: the restriction cannot be edited

`updateFund` takes a name, a purpose, a date and notes. It does not take a
restriction, and there is no other way to change one.

A gift given for the roof does not become a gift for anything else because
somebody changed a dropdown. A fund whose class could be edited would let a
charity move money between the two columns of its balance sheet without posting
an entry anybody could see — which is the one thing this module exists to
prevent. Closing the fund and opening another is the honest way, and it leaves
the donations where they were given.

## Decision 9: once per fund per period, and the claim row goes in first

`unique(fund_id, period_start)` on `fund_releases`, and the row is inserted
before the journal entry.

The same rule and the same ordering as Phase 23's rent charge: where two people
can act at once, the database arbitrates, and an entry posted before the claim
would survive the claim being refused. A test runs two releases concurrently
and asserts exactly one posted.

## Decision 10: what has been released is counted for all time, not up to a date

Months get run out of order — somebody runs March, then notices February was
never run. An earlier month that counted only the releases *dated before it*
would be blind to March's, and a fund given £1,000 that spent £1,000 in each of
two months would release £2,000: money it was never given, which is the one
thing this module exists to prevent.

This was a real defect, found by checking the query rather than the screen, and
the regression test fails without the fix. The cost of the fix is that a late
February release, run after March, sees the money as already gone and posts a
shortfall instead. That is the safe direction — the total released stays capped
at the total given — and the shortfall says plainly that February's spending was
covered by something other than February's restricted money.

The as-at-a-date reporting query keeps its date filter, and correctly: a
historical balance should not be moved by a release posted after the date being
asked about.

## Decision 11: `asOf` and `month` are parameters

Fifth phase running. A run that read the clock could not be asked what it would
have released last March, and could not be asserted on. A balance that read the
clock could not answer what the roof appeal held at the year end, which is the
only date a trustee actually cares about.

## Decision 12: the check is for money this page cannot see

`netAssets` reports contribution revenue that carries **no fund at all**.

Comparing the fund balances to a total derived from the same fund balances
would reconcile perfectly and prove nothing — the trap the property module's
deposit check was written to avoid, and one this phase walked into and out of
during the writing. The two sides here are genuinely different: the total is
every line posted to the contribution accounts, and the tagged figure is the
subset joined through `journal_line_dimensions`.

A non-zero difference is a donation nobody can state the purpose of. It is not
necessarily an error, but it is money outside every figure on the page, and a
page that did not say so would be understating what it was asked to report on.

## Decision 13: net assets comes from assets less liabilities

Not from the two equity accounts. Those only carry what a year-end close put
there (Phase 11), so mid-year they are last year's figures — and a charity's
restricted balance in August is the question somebody asks in August.

Assets less liabilities *is* net assets, by the accounting equation, so the
figure cannot disagree with the balance sheet.

## Consequences

- **Releases are monthly, for everybody.** A charity that wants to release
  weekly, or on the day of each transaction, cannot. The period is the unit of
  the unique index, so changing it is a migration rather than a setting.
- **Nothing releases a time restriction.** `expires_on` is recorded and
  advisory: a gift restricted until 2027 does not release itself on 1 January
  2027. That is deliberate — a release satisfied by the calendar rather than by
  spending is a judgement somebody should make and post — but it means the one
  restriction that *could* be automated is the one that is not.
- **A release cannot be undone from this module.** The journal entry can be
  reversed like any other, but the `fund_releases` row stays and the unique
  index then refuses to re-run that month. Correcting a wrong release is a
  manual job for an accountant.
- **Conditional promises are not modelled.** Everything recorded as a pledge is
  treated as unconditional and therefore as revenue. A grant contingent on
  matched funding is not revenue under any standard, and this module offers no
  way to say so — the honest workaround is not to record it until the condition
  is met.
- **Programme, fundraising and management are three expense accounts, not an
  allocation.** Spec §5 asks for programme reporting and this delivers it by
  fund. A functional-expense matrix — the grid a charity's annual report
  actually prints, splitting every cost across the three — would need a second
  dimension and an allocation basis, and neither is here.
- **The fund dimension is `expected`, not required.** A posting with no fund is
  flagged on Phase 16's coverage report and refused nowhere. A general
  running-costs invoice legitimately belongs to no appeal, and refusing to post
  it would teach people to invent a fund to get past the error.
- **Restricted money is not ring-fenced against being spent.** Nothing stops a
  charity paying a supplier out of a bank account whose balance is mostly
  restricted. The books say what happened; they do not prevent it. That is the
  correct division — an accounting system is not a bank — but it means the
  overspend report is a rear-view mirror.
- **Grants and donors share the CRM's `customers` table.** The nonprofit pack
  renames Customer to Donor and the record is the same row, which is what lets
  a pledge use the receivables ledger. A charity wanting donor-specific fields
  — gift aid status, communication preferences by appeal — has nowhere to put
  them.

## Follow-up

1. **A functional expense matrix**, once there is a second dimension to
   allocate across.
2. **Release on a time restriction lapsing**, proposed as a draft entry rather
   than posted, so the judgement stays with a person.
3. **Conditional promises**, held off the ledger until the condition is met.
4. **Schedule the release run** the way Phase 24 scheduled the rent run — the
   safety is already in the database, so this is small.
5. **Gift aid**, which is the largest thing a UK charity would expect and is
   entirely absent.
