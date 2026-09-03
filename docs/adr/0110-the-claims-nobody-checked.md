# 0110 — The claims nobody checked

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 110

---

## The defect

Phase 109 shipped three claims and verified none of them.

The largest is in the register. Every check gained an `asAt` declaration saying
how far back it can see, and fifteen of the twenty-one were given the same one:

> Not verified to reach back.

Which was honest about the state of my knowledge and dishonest as a description
of the code, because `today_only` does not mean *unverified* — it means
**skipped**. A check declared `today_only` stops running the moment somebody
asks about a past date. Fifteen unverified declarations are fifteen checks
switched off for every historical question, on a guess.

Reading the fifteen queries took an afternoon. **Three of them already honoured
the date and had been switched off for nothing:**

| Check | What the query actually does |
| --- | --- |
| `properties.deposits` | `depositsHeld` filters `deposit_movements.occurred_on <= asOf` for received, refunded *and* applied alike |
| `pos.tips` | takings filtered on `pos_days.business_date <= asOf`, ledger on `entry_date` — both sides as at the same day |
| `funds.untagged_contributions` | `netAssets` threads the date through `fundBalances`, `totalNetAssets` and `contributionRevenue` |

Measured on the development books afterwards, `properties.deposits` walks back
on both sides together:

```
                               2026-09-03           2026-03-31           1900-01-01
properties.deposits            agrees 175000/175000 agrees 175000/175000 agrees 0/0
```

## Decision 1: every declaration says what the query does

`Not verified` is gone from the register. Each of the eleven that stay
`today_only` now names the specific thing that stops it, and two of those are
the reason this phase is not a rubber stamp — **both look promotable on a quick
read and are not**:

- **`assets.register`** — a half-measure rather than an absence.
  `depreciation_entries` *is* filtered by `period_end <= asOf`. The
  `fixed_assets` query has no date filter at all, so an asset bought in June
  still counts at cost in a March report.
- **`manufacturing.wip`** — subtly. The ledger side is filtered by `entry_date`,
  which is what makes it look fine. The subledger side is `work_orders where
  status = 'released'`, and *released* is present tense: a run released in
  February and finished in May is not released now, so a March report would
  miss it entirely.

I nearly promoted both. That is the argument for reading the query rather than
the table name, and it is the same argument Phase 108 made about its own false
premise.

`timebilling.retainers` is named in its declaration as the clearest candidate
for the treatment Phase 108 gave the control accounts, because
`retainer_applications.applied_on` dates every draw.

## Decision 2: the tripwire is a date before the books existed

ADR 0109 admitted its own tripwire was weak — it asserted a check *declares* a
reach, not that an `any_date` one varies with the date. The proof it wanted
turns out to be one line: a check whose subledger side honours the date must
report **nothing** for `1900-01-01`. There was no stock, no deposit and no
invoice in 1900; a check that ignores the date reports today's figure against an
empty ledger instead, and the gap between those is the whole defect.

Where the fixture has no activity in a subledger the test is **vacuous** — a
check that ignores the date also reports 0 when there is nothing to report — so
the fixture builds real activity for `ledger.receivables` and `inventory.lots`,
and the generic loop over the remaining ungated `any_date` checks is named in a
comment as the weak half rather than counted as evidence. `pos.tips` and
`funds.untagged_contributions` sit at `0/0` on the development books too: they
rest on the query, and this ADR says so rather than implying more.

## Decision 3: the stored run records *which* checks the date silenced

ADR 0109's second unchecked claim:

> Reading a **stored** run back cannot tell them apart: the row records a count,
> not which kind.

True of the row and false of what a row can hold. `integrity_runs` gains
`checks_out_of_reach jsonb`, holding the keys — a count cannot be turned back
into names, and the names are the part somebody can act on. `latestRun`
subtracts them out of `skipped` rather than guessing, and a run recorded before
the column existed reads as `[]`, which is what those runs were: the nightly run
asks about today, where nothing is out of reach.

## Decision 4: the page says which checks vanished, by name

The third gap ADR 0109 named. Eleven checks now disappear from a past-dated run,
and until this phase they disappeared silently.

`outOfReachNote` takes the labels rather than a count, because *eleven checks
vanished* is alarming and unactionable while the names are the difference
between "the one I came here for is missing" and "the one I came here for ran".
Asked for 2026-03-31 against Ridgeline's books, the page now reads:

> As at 2026-03-31, run 2026-09-03 09:56. 7 run, 7 skipped because their module
> is switched off — which is not the same as passing. 7 checks could not answer
> for 2026-03-31 and were skipped — they can only speak for today: What each
> bank account holds, against its feed; What the card processor is holding,
> against the clearing account; …

Semicolons rather than commas, and that is not a style preference: every label
is itself a clause with a comma in it, so the first version of this sentence
rendered seven checks as a fourteen-item list. Read in the browser before it was
believed.

## Decision 5: the schema comment repeating Phase 31 is corrected

Phase 108 disproved a claim about reconstructing a subledger at a past date, and
deleted it from `receivables-check.ts`. It was in `src/db/schema/integrity.ts`
as well, unchanged since Phase 33:

> The balances are as at a date; the *documents* are as they stand today. Phase
> 31 named that limitation and it has not gone away — reconstructing what the
> subledger said on an arbitrary past date would mean replaying every payment
> application.

Phase 108 did exactly that replay, in one query per settlement kind. Phase 109
did it again for inventory. This is the **third** place the same false premise
was found, and the reason it survived two phases is that each place stated it as
settled fact rather than as something to check.

The stored run is still right to be stored, for a reason that is about history
rather than reconstruction: a check that has since been fixed reports agreement
for every past date, including the ones it was failing on. That reason survives;
the impossibility claim does not.

## What this does not do

**It does not repair the eleven.** `assets.register` and `manufacturing.wip` in
particular are now understood well enough to fix — the first needs a date filter
on `fixed_assets`, the second needs a work order's status *as at* the date
rather than now. Stated as work not done, with the reason written down, which is
the difference between this and Phase 109's version of the same sentence.

**The generic 1900 loop proves less than it looks.** It runs the ungated
`any_date` checks against a fixture with no activity in most of their
subledgers, where 0 is the right answer either way. The two that carry real
weight are the two the fixture builds activity for.
