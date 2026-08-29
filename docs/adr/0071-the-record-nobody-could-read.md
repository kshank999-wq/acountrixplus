# 0071 — The record nobody could read

**Status:** accepted
**Date:** Phase 71
**Amends:** ADR 0003 (the audit core), ADR 0045 (party changes), ADR 0070 (corrections say why).

## The defect

The audit log has been written since Phase 3. Two hundred and twenty-four
distinct actions, each carrying an actor, a time, and a before-and-after
payload. `historyFor` and `recentActivity` have existed just as long.

**Every caller of either is in `tests/`.** No screen in this application has
ever shown one.

That is not an oversight about a nice-to-have. Two phases spent real design
effort on facts that land there and nowhere else:

- **Phase 45** records a party's before and after on every edit, and says so
  explicitly: *"that is the whole reason to prefer an update over a delete and
  recreate."* "Their email changed on the 3rd, and Dana did it" is the question
  that trail exists to answer, and nobody could ask it.
- **Phase 70** made five corrections insist on a reason *"so somebody reading
  the books later does not have to guess"* — and there was no screen for
  somebody reading the books later. The reason went into a JSONB column that
  only vitest had ever read.

Phase 70 was, in that light, half-built. This is the other half.

## Decision 1: `audit:view` is enforced, for the first time

The permission was declared in Phase 3 for exactly this. It is granted to an
owner and an accountant. It is *reasoned about in other modules' comments as
though it were the gate* — `payroll/vendor-reporting` deliberately keeps a tax
identifier out of the log because that table is "read by everyone with
`audit:view`".

Nothing had ever checked it. A precaution taken against a gate that was not
there.

`recentActivity` now requires it.

## Decision 2: you may read the history of a record you may read

The whole-company log and one record's history are different questions, and
fixing both at `audit:view` would have been wrong: a bookkeeper who can open a
bank transaction should be able to see what was done to it without holding the
key to everything.

So `READABLE_BY` maps entity type to the permission that opens that record —
named data, so adding a record type to the log is a deliberate decision about
who may read it. An entity type nobody has placed falls back to `audit:view`,
which is the strict end: a new record type appearing in the log is readable by
those who may read everything, rather than by anybody with a session.

## Decision 3: one answer to "what happened to this record"

There were two implementations. `historyFor` in the audit module: no
permission check, `select()` every column, unbounded. `transactionHistory` in
the bookkeeping module: gated on `bookkeeping:view`, explicit columns.

The careful one is why anybody noticed the careless one. Its rules moved into
`historyFor` — which is now gated, bounded, and column-explicit — and
`transactionHistory` became a one-line call to it.

`ipAddress` and `userAgent` are gone from what a caller gets; nothing
displaying a history needs them, and a query that hands back everything is one
somebody eventually renders.

`userId` **stays.** It is not the sensitive half — `actorName` already names
the person out loud — and it is the durable identity behind that name. Two
colleagues can share a display name; one who leaves keeps their id while old
rows keep whatever the name was at the time. The activity feed's actor filter
keys on the id and shows the name, because a log that quietly merges two people
is worse than one with no filter.

## Decision 4: words we have decided are used; words we have not are not invented

The tempting move is a conjugation rule: split `vendor.update` on the dot, past-tense the verb, print "Vendor updated". Over 224 actions that produces 224
English sentences nobody wrote and nobody checked — and it gets them wrong in
both directions (`write_off` is not "write offed"; `payments.settings_update`
and `journal.reclassify` want opposite treatments of their two halves). Getting
them wrong in the log somebody is reading *because something went wrong* is the
worst place to be approximately right.

So `audit/story.ts` draws the line at what has actually been decided:

- The **five corrections** read their phrases from `corrections/vocabulary`.
  Not copied — read. If somebody renames a verb on a button the history
  follows, and Phase 70's defect cannot come back as two answers to one
  question, one on the screen and one in the log.
- Every other action is handed back as **its own name**, flagged `named:
  false`, and the screen renders it as the code it is rather than as prose this
  system chose.

What was actually missing was never the prose. It was `changedFields` — the
before-and-after diff written for sixty-odd phases and displayed zero times —
and `reasonFrom`, which lifts Phase 70's reason out so it leads the entry
instead of sitting seventh in a field list where nobody reads it.

Money is handed back as the integer cents it is stored as, marked `kind:
'money'`, and formatted by the screen. Which currency a payload's amount is in
is not a fact the payload carries, and a core that guessed would be Phase 61's
defect — a made-up number in front of somebody — in a new place.

## What this did not do

Nothing in the ledger changed. No migration. No new audit action. What changed
is that what was already recorded can be read, and that reading it requires
being allowed to.

## What the next phase might take

`historyFor` is bounded at fifty and has no way to ask for the next page. For a
record edited weekly that is a year of history and fine; for a bank transaction
inside a bulk categorization it is not obviously enough. The honest fix is a
cursor, and it wants deciding rather than defaulting.

Separately: `updateVendor` records a `taxId` in the audit payload, while
`payroll/vendor-reporting` deliberately records only *whether one was set* on
the same vendor, for the stated reason that the log is widely read. That is one
question with two answers, and now that the log has a reader it is worth
settling.
