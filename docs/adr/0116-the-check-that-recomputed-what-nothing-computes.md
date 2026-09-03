# 0116 — The check that recomputed what nothing computes

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 116

---

## The defect

ADR 0115 nominated a new check: a payment's face and functional columns must
reach zero together. Verifying that before adopting it found two things, and
neither was what the nomination said.

### The invariant already existed, on one table out of five

```
retainers_functional_remaining_sane
  CHECK ((remaining_cents = 0) = (functional_remaining_cents = 0)
         AND functional_remaining_cents >= 0)
```

Added in a raw migration in Phase 66. The comment on
`retainers.functionalRemainingCents` has claimed it ever since — *"A database
check keeps the two reaching zero together"* — and the claim is true. But it was
**never declared in the schema file**, so `drizzle-kit` did not know it existed
and would have offered to drop it. It survived on luck for fifty phases.

`invoices`, `bills`, `credit_notes` and `payments` carry the same pair and had
nothing at all.

### And the check that was supposed to be watching this is built on a false premise

`fx.conversions` — **fault** severity, `module: null`, so every company ran it
nightly — compared each open foreign document's stored home amount against a
fresh conversion of its remaining balance:

```ts
const recomputed = Math.round((row.balanceCents * row.rate) / 1_000_000)
if (Math.abs(recomputed - row.carriedCents) > 1) offenders.push(...)
```

The premise is that a functional figure is a conversion of its face amount.
**It never has been, and deliberately so.** Every functional figure in this
system is a *sum of conversions*, never a conversion of a sum:

- A document's functional total is its **lines** converted and added, because
  the header must store what the journal entry posted. `service.ts` says why:
  *"Converting the total separately would leave `functionalBalanceCents` a cent
  away from the receivable it is supposed to equal — the precise drift Phase 31's
  control account check exists to find, manufactured by the code that should
  prevent it."*
- A document's functional balance comes down by `relieveFunctional`, which takes
  `convert(part, rate)` off each part payment and **the whole remainder** on the
  last one, so a settled document cannot strand a cent.

Both round per movement, and rounding accumulates.

### Measured

Against the ECB rate this repository's own seed data carries, €1 = $1.0835:

| | carried | recomputed | apart |
|---|---|---|---|
| A two-line €10.01 + €10.01 invoice | **$21.70** | $21.69 | 1¢ |
| A €1,000 invoice paid in three instalments of €250 | **$270.86** | $270.88 | 2¢ |

The second exceeds the check's tolerance, so `fx.conversions` reported a
**fault** on a euro invoice paid quarterly. Nothing is wrong with those books.

The `> 1` tolerance is the fingerprint. Its own doc comment admitted the drift —
*"expected to differ by rounding on a part-paid document, which is why the
tolerance is a cent per open document rather than zero"* — but the drift is not
bounded per document. It is bounded by the **number of movements**, and any
tolerance wide enough to cover them would be wide enough to hide the thing the
check was for.

## Decision: a constraint where something is exact, and nothing where nothing is

### One exact thing, enforced rather than reported

The four tables get the constraint `retainers` already had, in the same shape.
A constraint rather than a nightly check because **a check reports what has
already happened and this can be made not to happen** — and because the failure
it prevents is money sitting on a control account that no document can ever
clear, which is Phase 48's Goods Received Not Invoiced with the sign flipped.

`src/modules/fx/paired.ts` names all eight pairs across the five tables with
prose per entry, and `pairsFor` **throws** on an undeclared table — the Phase 101
device, so a new table carrying a functional amount has to answer the question.
Two tests hold it to that: one asks the database whether every constraint the
registry names is really there, and one asks whether the registry names every
constraint the database has. The retainer constraint failed the second direction
for fifty phases.

### `fx.conversions` is retired, not repaired

There is nothing to repair it into. Both pairs drift, so no recomputation of
either is assertable, and the check's target — a home amount or a rate edited by
hand — is already covered exactly:

- **`ledger.receivables` and `ledger.payables`** have compared Σ functional
  balances against the control accounts since Phase 31. A hand-edited home
  amount moves that sum, and those checks have **no tolerance**, because a
  control account either equals its subledger or does not.
- **The new constraints** catch the case those sums cannot see: a *settled*
  document still carrying functional money, which drops out of the open-document
  sum entirely. `fx.conversions` could not see it either — it read only
  `['open', 'partial', 'written_off']`, so the stranded cent that
  `relieveFunctional`'s own comment warns about was out of its scope.

The currencies page loses the section that asked *"Do the documents carry what
their own rates produce?"* — a question whose honest answer on correct books is
routinely no. Exposure, realised movement and the rate history remain.

A retirement note stays in `fx/reporting.ts` in the shape `refuseForeign` left in
`fx/documents.ts`, because the lesson is worth more than the code: **a check
whose premise is false is worse than no check, and a tolerance is where a false
premise hides.**

## What I got wrong on the way

My first draft of `paired.ts` said the *fixed* pair — `total_cents` against
`functional_total_cents` — was exactly recomputable, and proposed re-aiming
`fx.conversions` at it. That was wrong for the same reason the original was
wrong, and I found it by reading `createInvoice` rather than by reasoning: the
functional total is the sum of converted **lines**. A two-line invoice
disproves it. The core and its tests were rewritten before anything shipped;
the test now asserts both the one-line case (where the two coincide, which is
why this stayed hidden) and the two-line case (where they do not).

I also left the dev database inconsistent after Phase 115's browser probe — the
receipt's journal entry is memoed `Customer payment`, which my
`%P115 probe%` cleanup filter did not match, so it outlived its deleted payment
row and put $2,200 on `2520`. The nightly run found it, which is the register
doing its job on me. Cleaned up by finding every journal entry whose source
document no longer exists.

## What this does not do

**It does not add a check for the constraint.** The database refuses the write,
so a nightly check for it could never fire — and Phase 31's impossibility claim,
which this project has had to correct three times, is what that looks like when
somebody adds one anyway.

**It does not attempt a per-document ledger check.** A document's functional
figure equals what its own journal entry posted, exactly and by construction,
and `invoices.journal_entry_id` is right there. That would name the offending
document where `ledger.receivables` only moves a total. It is a real check and a
better nomination than the one this phase started from — but it is a phase, not
a clause.

**Twenty checks remain**, thirteen reaching any date and seven `today_only`.
