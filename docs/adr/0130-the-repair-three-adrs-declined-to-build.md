# 0130 — The repair three ADRs declined to build

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 130

---

## How this was found

ADR 0129 nominated nothing. Its "what this does not do" section names three
limits, and two are deliberate and permanent — the tie-out cannot catch a
mis-posted rate by design, and `bank_transactions` should not have a currency
column. The third is not a limit at all:

> **It does not repair the rows the backfill exposes.** It counts them and names
> them. Correcting one is a decision with a date and a reason, and belongs to
> whoever owns those books.

Which is the third consecutive ADR to end that way:

| ADR | The sentence |
| --- | --- |
| 0127 | *It does not repair the books of anybody who already hit this.* |
| 0128 | *It does not repair books already affected.* |
| 0129 | *It does not repair the rows the backfill exposes.* |

Each was right about **how** — a repair is a dated correction, never something a
migration does behind anybody's back. None of them provided one. Phase 31 taught
this and Phase 33 wrote it down:

> Phase 31 taught what a follow-up repeated across consecutive ADRs usually
> means.

Three is not a hint. The work was named, deferred, and deferred again, and
nothing else in the codebase now blocks it: Phase 129 put the rate on the row,
which is what a correction needs to know what it is correcting.

## What a restatement is

A **second entry**, dated the day the decision is made, carrying the difference
and a reason. The original stays exactly as it was.

That is not a stylistic choice. Repairing by re-posting would reintroduce Phase
129's defect wearing the clothes of a fix — the old figure would vanish and a
period somebody has already reported on would quietly change. Keeping the
original and posting the difference is what makes the books readable afterwards,
and it is what lets a closed period refuse the correction through the machinery
Phase 92 already built, rather than needing a second rule here.

The correcting entry's source is `adjusting`, which the journal has had since
Phase 12 and which no phase had a use for on the bank feed until now.

## The allocation rule

A transaction's entry is category lines against one bank line. Each category
line is scaled at the new rate and the bank line takes the sum of the scaled
parts — Phase 35's rule for converting a document, here for the same reason:
converting the total separately and spreading it leaves the entry a cent out
against itself.

So `restatement()` reports `toCents` as **what the ledger will actually hold**,
which can differ by a cent from the ideal figure when the parts round. The parts
are what gets posted, so the parts are what it reports.

## A new reach, argued rather than assumed

`CorrectionKind` gains a seventh entry and `Reach` a fifth. The fifth is the
interesting one, and Phase 96 set the precedent for adding it rather than
bending an existing one:

- It did not **move money** — no cash left or arrived; the bank statement is
  unchanged and always was right.
- It did not **reach somebody** — no letter went out.
- It is not **internal**, though it looks it. `internal` means *only our own
  records move, nothing outside changes*, and that is the reach for which
  `mustSayWhy` returns false. But a restatement moves a figure somebody may
  already have been told: a trial balance handed to a bank, a return already
  filed, management accounts already circulated. Nothing left the business at
  the time, and something may leave it afterwards carrying a different number.
- It **can** be undone — restate it back — so it is not `cannot_be_undone`.

Hence `restates_the_past`. And because `mustSayWhy` is written as
`reach !== 'internal'` rather than as a list of the reaches that require a
reason, the new one requires one **by default** — the comment on that function
says it was written that way precisely "so a fifth reach added later has to be
argued into silence rather than falling into it." It is the first time that
sentence has been tested, and it held.

## A restatement is subsumed by a re-post

The one interaction worth writing down. After a restatement the books hold the
original entry plus the correcting one, and the transaction's stored pair
carries the corrected figure. If somebody then re-categorises the transaction,
`syncLedgerForTransaction` voids the original and rebuilds it — **at the
corrected rate, because Phase 129 keeps the stored one.** The rebuilt entry
therefore already carries the corrected amount, and leaving the correcting entry
in place would count the difference twice.

So unposting voids everything derived from the transaction, the restatement
included. The reason is not lost: it is on the audit record and on the voided
entry, and the audit story reads *posted, restated because X, re-categorised,
re-posted at the restated rate*. What is not allowed is for the two to stand
together and overstate the account.

## Why the stored pair moves

`rate_millionths` and `functional_amount_cents` are updated to the restated
figures, which looks at first like a contradiction of Phase 129's rule that a
posted rate is fixed. It is not: that rule stops a rate changing as a *side
effect* of something nobody decided. A restatement is the decision itself, made
by a person, with a reason, recorded. Every other paired column in the schema
tracks what the books currently carry rather than what they first carried, and
this is now consistent with them.

It is also what makes the repair observable: `banking.posted_at_face` stops
reporting a row once its functional amount no longer equals its face, and
`banking.cash_tie_out` keeps agreeing because both the ledger and the stored
twin moved by the same delta.

## What this does not do

**It does not decide the rate.** A person supplies it. Phase 129 established
that the rate table cannot be asked after the fact — the answer it gives today
is not the answer that was used — so anything this chose automatically would be
a guess wearing a decision's clothes. The refusals exist for the same reason: a
restatement to the figure already held, or one too small to move a cent, is
declined rather than recorded as a correction that corrected nothing.

**It does not restate anything but a bank transaction.** The write-off and
deposit residues ADR 0127 recorded are the same class of damage and are not
covered here. They are a smaller surface — both have their functional twins
already — and each needs its own argument about what a correcting entry means
for a document rather than a movement.

**It does not find the damage.** `banking.posted_at_face` does that, and it
remains a `position` for the reason ADR 0129 gave: a currency can genuinely sit
at parity, so a correct row and a damaged one are indistinguishable to anything
but a person.
