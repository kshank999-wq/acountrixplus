# 0109 — How far back a check can see

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 109

---

## The defect

Every check in the register takes an `asOf` date. Most walk their **ledger**
side back to it with `entry_date <= asOf`, and then read their **subledger**
side as it stands now. Phase 108 fixed that for the two control accounts and did
not reach the rest.

Found by running all twenty-one checks at three dates against the development
books and looking for the ones whose answer moves:

```
inventory.lots   2026-09-03: agrees  2855920/2855920
                 2026-05-31: DIFFERS 2855920/1668600
                 2026-03-31: DIFFERS 2855920/0
```

The left figure never moves; the right one walks back. `inventory.lots` is a
**fault** — the register's highest severity — so asking about March reported
$28,559.20 of broken books on books that were perfectly correct.
`reconcileInventory`'s own doc comment had already named the cost:

> a reconciliation that cries wolf is one people learn to ignore.

This is the fourth phase in five to find a fault firing on a legitimate state
(105, 106, 108). The pattern is the same each time and so is the conclusion.

## Decision 1: each check declares how far back it can see

Some subledgers can be restored to a date and some cannot, and which is which is
a fact about each one's tables — not something a reader of the register can
infer, and not something the register itself knew. So `IntegrityCheck` now
carries an `asAt: { reach, because }`, on the device Phases 70, 101, 105, 106 and
108 used: prose rather than a bare enum, because `today_only` looks identical
whether it is a considered limit or an oversight.

A check that cannot answer for a past date is **skipped** there rather than
answered wrongly. The register already separated a skip from a pass and said so:

> a skip is not a pass. It is counted separately and never contributes to

The nightly run asks about today, so nothing about it changes — asserted rather
than assumed.

## Decision 2: `today_only` means *not verified to reach back*

This is the part worth being careful about. I proved `inventory.lots` was wrong
and proved the two control accounts were right. For most of the other eighteen I
have **no evidence either way** — the development data leaves them at `0/0`, and
guessing would be the same failure as Phase 108's false premise, which claimed
an impossibility nobody had checked.

So `today_only` is worded as what it is: *"Not verified to reach back."* It errs
toward skipping rather than lying, and each one names what a future phase would
have to show. Two of them are stated positively instead, because their subledger
question is genuinely present-tense:

- **`cash_drawer.open_tills`** counts the drawers open *right now* — a shift that
  closed last week is not an open till, whatever date is asked about.
- **`banking.cash_tie_out`** compares the ledger against the feed, and neither
  side is date-filtered; it never took `asOf` at all.

Four are `any_date` for a different reason again: `banking.shared_ledger_accounts`,
`payables.duplicate_bills`, `parties.shared_addresses` and
`vehicles.authorisations` compare facts about records rather than balances, so
they read the same on any date.

## Decision 3: inventory is repaired rather than declared away

`stock_movements` dates every change with `moved_on` and carries an already
**signed** `cost_cents` — a receipt positive, an issue negative. So the lot value
at a date is `value now − Σ(cost of what moved since)`: one sum, no case analysis
over the six movement kinds.

Declaring `inventory.lots` as `today_only` would have been settling for less than
the data allows, on the check the phase was found through. Measured on the same
books afterwards:

```
inventory.lots   2026-09-03: agrees 2855920/2855920
                 2026-05-31: agrees 1668600/1668600
                 2026-03-31: agrees 0/0
```

## Decision 4: a date-gated skip is counted apart from a module-gated one

`IntegrityRun` gains `outOfReach` beside `skipped`. They mean different things —
a module switched off is a check that does not apply, and this is one that
applies but cannot answer the question asked. Reporting them as one number would
leave somebody thinking a check they rely on had been turned off.

Reading a **stored** run back cannot tell them apart: the row records a count,
not which kind. That path reports them as skipped, which is what they were, and
says so in a comment rather than guessing.

## What this does not do

**It does not restore the other seventeen subledgers.** Stated as a limit, not a
claim of impossibility: `timebilling.retainers` in particular has a dated
`retainer_applications` table and is an obvious candidate for the treatment Phase
108 gave the control accounts. Its declaration says so.

**It does not test each declaration against reality.** The tripwire this phase
has is weaker than Phase 102's: it asserts every check *declares* a reach with
prose, not that an `any_date` one actually varies with the date. Proving that
needs a fixture with dated movement in each of nineteen subledgers, which is a
bigger machine than this phase justifies — and unlike Phase 108's version of that
sentence, this one has been checked: the three `any_date` balance checks are each
covered by a test that runs them at two dates.

**It does not surface the skip on the operations page.** `outOfReachNote` writes
the sentence and the run carries the keys, but the page still renders only the
module-gated count. The nightly run asks about today, where the list is always
empty, so nothing on the page is currently wrong — but a person running the check
for a past date from the UI would see the checks vanish without being told why.
