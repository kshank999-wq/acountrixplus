# 0119 — The refusals nobody could read

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 119

---

## How this was found

Phase 118 wrote four refusals for the new chart-of-accounts screen, backed them
with thirty-three passing tests, and then the first browser pass showed this:

```
add 1042 expense: Something went wrong.
add 621 expense:  Something went wrong.
add 1100 asset:   Something went wrong.
add 6100 expense: Something went wrong.
```

`ChartError extends Error`. `messageFor` (ADR 0074) shows a `DomainError` and
replaces everything else with the caller's fallback, so all four sentences were
discarded one layer above the screen. **No test could see it**, because every
test in this repository calls the service directly and asserts on the thrown
message — the exact place the sentence still exists.

That was one class. The question was how many others.

## The measurement

Across `src/modules`, counting `throw new Error(...)` and classifying each
message by whether it reads as prose written for a reader:

```
plain `throw new Error` in src/modules                     298
  ...carrying a sentence written for a person              206
exported functions among those                             103
  ...whose name appears anywhere in src/app                 80
```

Forty-three of the forty-four server actions call `messageFor`. So every one of
these arrived on a screen as "Something went wrong":

> That is a vendor credit. It cannot be applied to an invoice.
>
> That change order was rejected. Raise a new one instead.
>
> A cost code needs the job it belongs to. Choose a job as well.
>
> Say why it is being written off. An unexplained loss is worse than a loss.
>
> Say what the time was for. A line reading only "work" is what a client queries.

Somebody wrote each of those knowing exactly what the reader needed to do next.
Several took a whole phase to word. None of them had ever been read.

## Why a classifier, and not a rule about types

"No bare `throw new Error` in `src/modules`" is simple and wrong. Some of the
298 are for an operator and **must** stay hidden — a missing `OBJECT_STORE_PATH`,
an unregistered provider, an invariant meaning the code is broken rather than
the input. Hiding those is the whole point of ADR 0074.

So the question is not *what type was thrown* but **who the sentence was written
for**, which is decidable from the sentence itself. `src/modules/errors/audience.ts`
states three rules, each carrying its own argument:

| Rule | What it separates |
|---|---|
| opens like a sentence | `That invoice is voided.` from `invoices.balance_cents out of range` |
| closes like a sentence | prose from a log line — nobody punctuates a log line |
| says more than a name | an explanation from a label: `Not found` tells nobody anything |

All three must hold. They are *evidence somebody wrote prose*, and any one alone
is too easy to satisfy by accident.

## One class, not twenty-four

Sixty classes already extend `DomainError`, and every one exists so something
can **catch it by type**: `ClosedPeriodError` is caught, `PermissionError` is
caught, `IdempotencyConflictError` is caught. None of that applies here. These
192 had no type at all, so nothing could catch them and nothing ever wanted to.
Their entire job was to be read.

Inventing a `JobError`, `LedgerError`, `PayrollError` and twenty-one siblings
would add twenty-four things to import and nothing to catch — the ceremony of a
type system without the use of one. `Refusal extends DomainError` says the one
thing that was missing: **this sentence is for whoever hit it.**

## What changed

**192 sites in 46 files** became `throw new Refusal(...)`:

```
receivables 27   jobs 26   ledger 23   payroll 21   inventory 14
timebilling 12   crm 12    ai 12       mobile 9     bookkeeping 8
marketing 7      banking 7 reconciliation 6  auth 5  and nine more
```

**Fourteen stayed bare**, listed in `ALLOWED_BARE_REFUSALS` with the argument
for each. The heuristic got these wrong: they read as prose because somebody was
explaining something, but the explanation is for whoever maintains this. Two
name environment variables. Four are pure-core invariants whose own doc comments
already said so — `mobile/audience.ts` says in as many words, *"Both ids or
neither is a programming error rather than a user one."* Two are the Phase 101
registry throws, addressed to the developer adding a settlement kind.

**The allowlist is keyed by file and sentence, not by line number.** The first
draft used lines, and the conversion's own added `import` broke two entries
immediately. An allowlist that goes stale when somebody adds a line above it is
not an allowlist, it is a trap.

## The tripwire

`tests/refusal-audience.test.ts` reads the source rather than calling anything.
It fails if a person-facing sentence is thrown bare without an entry in the
allowlist, and it fails if an allowlist entry stops matching a real throw. It
also asserts it found more than fifty sites at all, so a broken scan cannot pass
green on an empty list.

This is the instrument the suite did not have. Every other test asserts on the
message at the point it is thrown, which is precisely where the defect is
invisible.

## Verified in the browser

`/time`, signed in to Kestrel Joinery, logging 30 hours in a day. The form
guards a blank description and an unparseable duration; it does not guard a
length longer than a day, so the server refusal is all that stands between this
and a nonsense timesheet:

```
SCREEN SAYS: That is more than a day. Check the units.
```

Before this phase, the same click produced "Something went wrong."

## What this does not do

**It does not touch the 92 operator-facing throws.** `Customer not found`,
`Deposit not found`, `Rule not found` and their kin stay bare and stay hidden.
Several of them arguably *should* be sentences a person reads — "That customer is
not on these books" is more useful than a fallback — but rewording ninety-two
messages is a different phase from making the ones already written arrive.

**It does not enforce anything on `src/app`.** The tripwire reads `src/modules`
only. A server action could still throw a bare `Error` with a good sentence in
it; none currently does, but nothing stops the next one.

**It does not check that a `Refusal` is worth reading.** A refusal can now reach
a person and still be useless to them. The Phase 47 rule — say what is wrong
*and* what would fix it — is a matter of wording, and no rule about types can
enforce it.
