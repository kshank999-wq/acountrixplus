# 0147 — Which came first, the whole or the parts

**Status:** accepted
**Date:** 2026-09-15
**Phase:** 147

---

## How this was found

ADR 0146 nominated it, first of two, and the nomination was against my own work:

> `SPLIT_SITES` is still five declared entries with nothing measuring the
> extent, and that is still outstanding.

ADR 0145 had argued for declaring rather than scanning, on the grounds that a
wide regex over `Cents * x / y` matches thirty-five sites and nearly all are
rates. ADR 0134's rule is that a declaration which *excuses* a site is worse than
one that misses it, so the argument had to be tested rather than repeated.

What made a scan possible was finding the line ADR 0145 could not: **a constant
divisor converts units and a variable one is a total that something is a share
of.** Measured, that is thirteen rates and seven shares — and the noise the
previous phase was afraid of does not appear.

## Three forms, and the third is the one that matters

For the third time in this project. ADR 0123 learned it about addition, ADR 0144
about comparison, and here it is again:

| form | reaches |
| --- | --- |
| `proportional` | a share scaled by a weight — `prorate`, `scaleSigned`, `consume`, `recoveryFunctional` |
| `equal` | a whole cut into equal parts with no weight — `grossFor` |
| `handed_over` | the division done inside a helper, one item at a time, results summed — `priceDocumentTax`, `createDeposit` |

The first two cannot see `priceDocumentTax`, because there is no arithmetic at
the site at all: it calls `taxOn` in a `.map` and totals the results. That is the
**one live defect on the register**, so a scan built from the obvious forms would
have missed the thing it most needed to find — and the third form is what makes
this a scan rather than a demonstration.

Writing it produced the validation ADR 0144 used: the scan independently
rediscovers the defect already known and already registered, and announces
nothing nobody can check.

## What it found

### A split nobody had declared

`recoveryFunctional` divides a write-off's carried functional amount in
proportion to the face recovered. A write-off recovered in instalments is a whole
divided into parts like any other, and no registry had ever named it.

It is **sound**: the branch returning the whole outstanding functional amount
when the last of the face is recovered is the residue placement, and its own
comment says so — *"The last of it takes what is left, so nothing is stranded."*
Nothing was holding it to that, which is the reach failure this register existed
to stop and did not.

### The counter-example, which is the more useful finding

`createDeposit` converts each receipt at its own recorded rate and adds the
results up. That is the **same shape** as the tax defect — a helper handed one
item's money, inside a `.map`, results summed — and it is correct.

The reason is provenance. `recordPayment` already debited Undeposited Funds each
converted figure, so the parts are the record; summing them relieves exactly what
the receipts put there, and converting the total instead would strand the
difference in a clearing account nothing could clear. The file says so already.

So the question that decides a division is **not whether it rounds**:

```
priceDocumentTax   whole-first   a code's tax is round(base × rate), so rounding
                                 each line and adding them up is wrong
createDeposit      parts-first   each receipt was already posted at its own rate,
                                 so their sum is the whole by definition
```

`perItemRoundingStands` is that decision and nothing else. There is no third
answer where summing rounded parts is close enough.

### A split with no residue, which is not a defect

`grossFor` cuts an annual salary into equal periods and places no residue, so a
year of payslips comes to `periods × round(salary ÷ periods)` rather than to the
salary. Found by the `equal` form, which neither of the other two can see.

It is on `SPLIT_SITES` and deliberately **not** on `PENDING_WIRING`. It sits in
`IllustrativePayrollProvider`: invented rates, every run stamped
`isIllustrative`, and a refusal in the same file saying it *must not be used to
pay anybody*. A real calculating provider with this shape would be a defect.
Calling this one live would be the false sentence ADR 0135 is about.

## Two of my own declarations were wrong

### `splitFor` did not do what I said it did

Phase 145 declared it `reported` and wrote that it *"places no residue and is
right not to"*, letting the caller decide about money belonging to two different
people. Reading the code the scan pointed at:

```ts
practitionerCents = Math.round(exactScaled / 10_000)
businessCents: totalCents - practitionerCents
```

The business absorbs the residue like any other last part. `roundingCents` tells
somebody how much rather than asking them. The registry built to catch a
declaration argued from a fact that is not a fact held one for two phases, about
the function next door.

Correcting it left `reported` as a `ResiduePolicy` no site had, so that is gone
too: a union member with no instance reads like a case somebody handled.

### `wholeIsIndependent` carried two answers

It asked "was there a total before the parts were computed" and for
`priceDocumentTax` both answers are right — there is not, as the code stands, and
there is supposed to be. One field cannot hold that, and the verdict function
could not use it: reading `false` there would have cleared the defect.

`provenance` replaces it and is a statement about the **money** rather than the
code, so it can read `whole-first` while the site is wrong. That is precisely
what makes a site a defect rather than a design.

## What the scan caught in itself

Recorded because a scan's own reach is the thing this phase is about.

- **`Math.min(cashCents, …)` matched `handed_over`.** A comparison is not a
  division handed over; the capture was a method name and the dot was the tell.
- **A file-wide heuristic hid `grossFor`.** The `equal` form skipped any operand
  multiplied *anywhere in the same file*, and `provider.ts` multiplies
  `baseRateCents` forty lines up in its hourly branch. The check is local now.

Both are the same fault ADR 0146 recorded against its own scan and the ninth
instance of the family. A scan that has not been caught being wrong has not been
tested.

## What this does not do

**It repairs nothing.** `priceDocumentTax` still rounds per line; it is on
`PENDING_WIRING` with an acceptance test.

**It does not reach a split written as a subtraction.** `splitFor` rounds one
part and takes the rest, and no form sees that. `foundBy: null` is the honest
record of it, and the test makes the entry argue for itself rather than letting
`null` pass quietly.

**It does not claim the seven-versus-thirteen split is the last word.** The
constant-divisor rule is a good line and it is a line: a rate whose divisor
happens to be a variable would be miscounted as a share, and the `EXCLUDED` list
beside the scan is where those are argued, each one held to actually being
reached.

## What is nominated next

**The wiring pass.** Nothing new is outstanding that a scan can find: money is
now covered by registries for posting, banking, addition, screens, grounds,
comparison and division, and the last three phases of scanning have turned up no
defect that was not already registered.

`PENDING_WIRING` is seven entries over eleven targets, five blocked by nothing,
each naming a skipped acceptance test — and `BLIND_FACE_SUMS` holds three
registered sums. That is the work, and it is written down.
