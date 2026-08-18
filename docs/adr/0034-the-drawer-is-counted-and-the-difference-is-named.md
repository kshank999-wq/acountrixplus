# ADR 0034 — The drawer is counted, and the difference is named

- **Status:** Accepted
- **Date:** 2026-08-18
- **Context:** Spec §5, §13
- **Builds on:** [ADR 0028](0028-a-day-is-a-fact-somebody-else-recorded.md),
  [ADR 0029](0029-a-booking-is-a-promise-and-part-of-the-money-was-never-yours.md),
  [ADR 0032](0032-change-is-not-a-transaction.md),
  [ADR 0033](0033-a-check-nobody-runs-is-not-a-check.md)

## Context

Phase 32 built taking money at a counter, and wrote its own limitation down:

> There is no cash drawer, shift or Z-reading. The change figure is shown and
> deliberately never posted, so a drawer counted against the ledger will show
> $50 in and $30 out where the ledger says $20 — correct, and a thing to know
> before reconciling one.

This is the reconciling. A note handed across a counter goes into a *drawer*,
and a drawer belongs to whoever is standing at it. Until somebody counts it and
says so, nobody knows whether what the till claims was taken is what is
actually there — and that gap is where most small-business cash goes missing,
by error far more often than by theft.

Five claims, asserted in `tests/drawer.test.ts` (36 tests):

1. **A float is not revenue.**
2. **Two people cannot open the same drawer at once**, and the database says so.
3. **Counting is a declaration, not a calculation**, and the difference is
   posted rather than absorbed.
4. **Cash taken at the counter goes into the open drawer**, and a card never
   does.
5. **A closed shift is a signed statement** and cannot be re-counted.

## Decision 1: a shift, not a day

Phase 28's `pos_import` already handles a day: a till system somewhere else
reports one and the summary is imported. This is the other case — **the
software is the till** — and there the unit is a shift.

Two people working a morning and an afternoon on the same drawer are two counts
and two accountabilities. A day would average them, which is precisely what
somebody investigating a short till does not want. The name on the shift is a
user reference rather than free text, because "who was on the till" is the first
question after a short drawer, and an answer that can be typed is an answer that
can be typed wrongly.

## Decision 2: the arithmetic works because Phase 32 posts only what was kept

A drawer should hold

```
    float + Σ cash applied − Σ paid out
```

and **change appears nowhere in it**. That falls straight out of Phase 32's
decision to post $20 rather than $50 in and $30 out: a system that had recorded
both would have to net them back off to count a till, and would be wrong the
first time somebody miscounted a single transaction.

Two details that look like details and are not:

- **The float stays on the expected side.** A tempting shortcut is to compare
  `counted − float` against takings; it gives the same answer when the float is
  right and hides the case that matters. Keeping the float in `expected` means
  a drawer opened with $80 instead of $100 reads as $20 short *on the day*,
  which is while somebody can still remember why.
- **What is banked comes from what was counted**, not from what was expected. A
  short drawer can only hand over the money it actually has.

`countFor` is the eleventh pure core in this codebase, for the reason the tender
core was the tenth: the sum is being done in front of somebody holding notes,
and they have to be able to say why it says what it says.

## Decision 3: a float moves money between the shop's own pockets

```
  Dr 1060 Cash Drawers      float
      Cr 1050 Petty Cash            float
```

Nothing is earned, nothing is owed, and the balance-sheet total does not move.
A system that booked a float as takings would report a shop as having sold $100
before it opened the door.

`1060 Cash Drawers` is a new account, installed on first use — the rule Phase 28
followed for `6870` and Phase 30 for `4620`. It is deliberately neither
`1050 Petty Cash` (a different pot, spent *from* rather than taken *into*) nor
`1200 Undeposited Funds` (money on its way to a bank, which drawer cash is not
until somebody counts it and takes it out).

`6870 Cash Over and Short` is Phase 28's, shared on purpose: an imported day and
a counted shift are two ways of discovering the same thing, and a business doing
both should read one number for how well its tills are run rather than two.

## Decision 4: the database refuses the second shift

A partial unique index — `WHERE status = 'open'` — makes two open shifts on one
drawer impossible.

The reason is Phase 29's, established with the double-booking constraint: where
two people can act at the same moment, the database is the only thing that
actually arbitrates. Two members of staff opening the same till at 9am would
each get a share of the same cash and neither an account of it. A read-then-write
check in the service loses that race by construction.

The refusal names who has it — *"Front counter is already open — Sam started a
shift on it at 09:02. Close that one first"* — because "try again" is not
information.

## Decision 5: only cash enters a drawer, and only when it is unambiguous

`takePayment` routes **cash** tenders to the open shift and leaves everything
else alone. A card settles into a batch somewhere else; putting it in a drawer
would make every count wrong by the day's card takings.

With exactly one shift open, that shift is used without asking — a counter with
one till should not make somebody name it on every sale. With **none open or
more than one**, cash falls back to Undeposited Funds rather than being guessed:
a note in the wrong till is a short drawer for one person and a long one for
another, which is two problems where there was none.

The shift is resolved once, before the loop over tenders, so a bill settled by
two cash tenders cannot land in two different drawers because a shift closed in
between.

## Decision 6: a count is a declaration, and a closed shift is signed

```
  Dr 1200 Undeposited Funds     counted − float retained
  Dr 6870 Cash Over and Short     (when short)
      Cr 1060 Cash Drawers          what the till says was in there
      Cr 6870 Cash Over and Short     (when over)
```

The credit to `1060` is what the *till* says should have come out; the debit to
`1200` is what was *actually* there. The difference is the whole point and it is
posted. A shop that is $2 short every Friday has a fact about Fridays, and it
only exists because the $2 was booked.

The count field on screen starts **empty**, not pre-filled with what was
expected. This is the one place in the application where showing the answer
first would be wrong: a pre-filled count is not a count. The expected figure is
shown beside it, and the difference appears as somebody types — so they can see
they are short *before* they commit, and go and look again.

Re-counting a closed shift is refused. A Z-reading whose number can be revised
afterwards proves nothing about the moment it was taken, and the moment is the
entire control — it is what lets a manager ask one person about one drawer.
Correcting a genuine mis-count is a journal entry with a memo saying so, by
somebody allowed to post one.

## The bug browser verification caught

The integrity check — this phase's contribution to Phase 33's register — summed
only the **open** shifts against `1060`.

Closing a shift that leaves $100 in the till for tomorrow leaves $100 in `1060`
and no open shift to account for it. That check would have reported every shop
keeping a float overnight as $100 adrift, **every night** — which is every shop,
and by ADR 0033's own argument an alarm that fires on ordinary trading is one
somebody switches off before the night it matters. The phase would have shipped
a check guaranteed to cry wolf, one phase after writing down why that is fatal.

The fix is that the unit is the **drawer**, not the shift: a drawer holds money
whether or not anybody is standing at it. The register side is now, per drawer,
the open shift's expected figure when one is running and the float its last
shift left in when none is. Two regression tests name the case.

## Consequences

- **`cash_drawer` is the eleventh module**, and the first added since the
  settings page's "Not built yet" section was deliberately kept empty against
  exactly this.
- **A drawer's cash is not in Undeposited Funds until it is counted**, so a
  business using tills will see `1200` move at close of shift rather than at the
  moment of sale. That is the truthful timing and it is a change in when the
  number appears.
- **Change still posts nothing**, and now the drawer count is what proves it was
  handled correctly. The two decisions are load-bearing for each other.
- **The eleventh check runs nightly**, so a till journalled into by hand is
  found by the machine rather than by a manager who happens to look.
- **There is no cash-in-transit account.** Counted takings go straight to
  Undeposited Funds, so a shop where the money sits in a safe for two days
  before banking has one account doing two jobs.
- **A shift has no end-of-shift report to print or sign.** The record exists and
  the screen shows it; a piece of paper somebody initials does not.
- **Nothing enforces that a drawer is counted.** A shift can stay open for a
  week, and the only thing that notices is the nightly check quietly agreeing
  with a very large expected figure.

## Follow-up

1. **Alert on a shift left open too long**, which is the ordinary way a till
   stops being counted.
2. **A printable Z-reading**, because a signature on paper is still how many
   businesses close a till.
3. **Cash in transit**, for money between the drawer and the bank.
4. **Over-and-short by person and by weekday**, which is the report that turns
   this data into an answer rather than a record.
