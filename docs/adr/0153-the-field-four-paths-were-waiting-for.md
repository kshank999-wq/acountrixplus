# 0153 — The field four paths were waiting for

**Status:** accepted
**Date:** 2026-10-01
**Phase:** 153

---

## How this was found

ADR 0152 nominated it in a sentence:

> **`mayPostToBank`**, the last `PENDING_WIRING` entry, blocked since Phase 136
> by a column that does not exist.

Verified before it was acted on, which is the rule: `information_schema` says
`tax_remittances`, `deposit_movements` and `contributions` carry no currency
column and no rate column, and `BANK_POSTINGS` records exactly four paths as
`withheld: 'no-field'` — the same four the entry names. The blocker was real and
it was the one claimed.

## What was actually wrong

Not a figure. A capability.

All four paths refused a foreign bank account outright, so a business banking in
euros could not remit a payroll or sales tax liability, take a pledge, or hold
and return a tenancy deposit through that account **at all**. The refusal was
honest — nothing recorded what currency the money was in, so posting a
home-currency figure against a euro account would assert something nobody had
been asked — and ADR 0136 was right to decline to wire it.

## The core was already here, twice

Nothing in this phase does the arithmetic. `settleHeld` and `recoverHeld` have
decided it since Phase 68, and Phase 151 proved they fit a live path by routing
`recoverWriteOff` through the second of them. What was missing is the answer to a
question the four paths answer differently and none of them stated:

**Does this act create the balance it posts against, or relieve one?**

**Three relieve.** The liability a remittance clears was accrued when the payroll
ran. The receivable a pledge settles was raised when the promise was made. The
deposit a refund returns was credited when it was taken. Every one of those
balances is already in the books, in the company's own money, carried at whatever
rate applied when it was recorded. So the bank takes the rate on the day the
money moved, the balance keeps its own figure, and **the difference is a realised
gain or loss**.

**One creates.** `receiveDeposit` is the first time that tenancy's deposit
exists. There is no carried figure to disagree with, so the liability is credited
exactly what the bank was debited and a difference is not merely absent — it is
**impossible**.

This is ADR 0147's question, *which came first, the whole or the parts*, asked
about a balance rather than a division. It has the property that made it worth
naming there: the two cases look identical at the call site and only the
provenance separates them.

### Why getting it wrong is quiet

Both mistakes balance.

Omit a difference that should be there and the only way the entry still foots is
if the bank line was given the balance's figure instead of the converted one — so
the bank is understated by exactly the movement, and Phase 40's tie-out reports a
difference in the morning with nothing to name it. That is the defect ADRs 0136,
0137 and 0138 each nominated and Phase 151 fixed in `recoverWriteOff`. Post a
difference that cannot exist and the entry foots too, against a gain nobody
earned.

Neither shows up as an imbalance, which is why `BANK_MONEY_SITES` declares the
answer and a test measures it against the source: it checks that the three that
relieve reach `ensureFxAccount` and that the one that creates does **not**.

## `amount_cents` does not change meaning

Three columns per table rather than two, and the third is the reason.

The first attempt made `amount_cents` the face amount with a `currency` beside
it. That is wrong in a specific way: `recordRemittance` compares its amount
against what `liabilityPositions` says the ledger owes, so making it a euro
figure compares a euro face amount against a dollar balance — which is exactly
the `contractorPayments` defect Phase 152 repaired, reintroduced one phase later
in a new place. The first draft of the wiring did precisely that before the
comparison was looked at properly.

So `amount_cents` keeps its meaning — the figure the ledger balance moves by, in
the company's own money — and `bank_face_cents` + `currency` +
`exchange_rate_millionths` describe the other side. The rate is stored rather
than looked up again, which is Phase 129's rule: `rateFor` answers from a table
the company keeps adding to, and a movement reconciled six months later has to be
reconciled against the rate it was actually posted at.

The backfill writes the identity rate and, unlike Phase 134's, records no damage
— because there is none. Every existing row was posted through a gate that
refused any account not in the company's own money, so for all of them the bank
face amount *is* `amount_cents`. The absence of a defect in that data is itself a
consequence of the refusal this phase lifts.

## `receivePledge` is still blocked, with a sharper blocker

Three of four wired. The fourth needs a **row**, not a column.

A pledge is received in instalments — `received_cents` accumulates and the
function refuses more than is outstanding — so each receipt has its own day and
its own rate, and there is no row for a receipt to carry them on. A single
`exchange_rate_millionths` on `contributions` would be right for the first
instalment and quietly wrong for the second, which is worse than the refusal it
replaced.

`a row` was added to `Blocker` rather than stretching `a field`, which is Phase
130's rule. And the register now shows **partial** progress for the first time:
one entry, one target, where it was one entry over four. A register that can only
shrink by whole entries cannot say what this phase did.

## Four registries caught the change, and one was wrong before it

The schema change made five separate declarations false, and every one was found
by its own test rather than by anybody remembering:

- **`CURRENCY_CARRIERS`** gained `deposit_movements` and `tax_remittances`.
- **`INHERITED_CURRENCY`** lost `tax_remittances`, which had taken its currency
  from the paying account. Its entry said *"the account is where it was paid
  from, not what it is denominated in — which is a real gap when that account is
  foreign"*. That is the gap this phase closed, so the entry is replaced by a note
  saying where it went — an ADR citation that vanishes with its entry takes the
  reason with it.
- **`DOMESTIC_GROUNDS`** had all three sites on `refuses-foreign`, which is now
  false: they convert. Argued as a new ground, `converts-here`, rather than
  squeezed into `converted-downstream` — no callee does it, and naming
  `bankMoneyLines` as a `via` would claim a pure core taking two numbers is where
  a currency is kept out. Its checkable half is that the site is declared in
  `BANK_MONEY_SITES` and that `BANK_POSTINGS` agrees it no longer refuses: two
  registers that would both have to be wrong together.
- **`MONEY_COLUMNS`** gained three columns, one of which —
  `deposit_movements.amount_cents` — has existed since Phase 23 and was invisible
  because the table had no currency of its own to be denominated in. Phase 143's
  finding one table over: a column nobody classified was not excused, it was
  unseen.

And one declaration was wrong before this phase touched it.
`tax_remittances.amount_cents` was declared `side: 'face'`. It is measured
against a ledger balance, so it is the books' money and always was; it read as a
face amount only because nothing else on the row could be one. A row with one
money column and a currency somewhere reads as denominated whatever the figure
means.

`FACE_COLUMNS` therefore **shrank** — two face columns added, both arriving with
a twin, and one reclassified away. The unpaired count went from 28 to 27. It is
the first time a register in this family has gone down.

## The convention could not spell this pair

`money-columns.test.ts` checked a named functional twin against columns matching
`functional%cents`, and that held for every pair in the codebase because in every
one of them the face amount came first and the functional twin was added later
with that prefix. These two are the other way round: the functional figure is the
one that already existed, under the plain name `amount_cents`.

The check now asks whether the named column exists, which is what its own comment
said it was for — *"a twin that does not exist is a claim the scans would act
on"* — plus a new assertion that a column is never its own twin, which the
widening would otherwise let through.

## Two runtime throws became a type

`bankMoneyLines` first threw `RegistryError` when a `created-here` site was handed
a carried figure, and again when an `already-carried` site had none. Both were the
right rule in the wrong place, twice over: **a constraint beats a check** (Phase
116), and `RegistryError` means *"no entry is declared for this key"* rather than
*"you called this wrongly"* — using it for argument validation is the kind of
bending Phase 130 names.

`origin` discriminates a union now, so both mistakes fail to compile.
`registry-error.test.ts` noticed: its count went to 22 and came back to 20. The
tests assert the constraint by assignability rather than with
`@ts-expect-error`, which asserts something stronger — not that one spelling
errors today, but that the shape is not assignable at all.

That test caught a fifth registry, too: `BANK_MONEY_SITES` was written against
the registries in `fx/` and not against it.

## One check was wrong in a way worth recording

`pending-wiring.test.ts` requires every `liveDefect` to contain a present-tense
verb from a list of six, and the list read `refuse\b` — which does not match
"refuses". Every entry that had used the word happened to have written the bare
stem, so a check for a present-tense verb was rejecting the most natural present
tense of one of its own words. Widened to `refuses?` rather than reworded around,
which is the direction Phase 145 settled: the sentence is the thing that has to
be true.

## What this does not do

**It does not wire `receivePledge`.** Named above, still on the register, with
`acceptance: null` for the same reason it had one in Phase 136.

**It does not ask the bank for its rate.** The gate's other branch is untouched: a
euro payment into a dollar account is still refused, because the bank converted
at its own rate on the day and these books do not have it. Both refusals are
tested.

**It does not convert a pledge, a deposit or a remittance already recorded.** The
backfill states what those rows posted, at the identity rate, and nothing
restates them.

**It does not add a currency to `leases` or to the payroll tables.** A deposit's
currency is the movement's, not the tenancy's, and a payroll run is computed in
the jurisdiction the company files in.

## What is nominated next

**Spec §7's vector and layout design engine**, now the largest unbuilt piece, and
the first thing in a long while that is neither a measurement nor a repair. After
it, §9's geography analytics and §19's row-level security.

The money registers are as empty as they go without that pledge table:
`BLIND_FACE_SUMS` at zero, `COMPARED_PAIRS` with no blind comparison,
`PENDING_WIRING` at one entry and one target.
