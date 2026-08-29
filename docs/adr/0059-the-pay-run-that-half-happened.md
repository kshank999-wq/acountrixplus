# ADR 0059 — The pay run that half-happened

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §19. Phase 49 pays a batch of bills one supplier at a
  time. When one of them failed, the business was told the whole run failed.
- **Builds on:**
  [ADR 0049](0049-what-you-owe-and-choosing-what-to-pay.md),
  [ADR 0050](0050-the-payment-nobody-approved.md),
  [ADR 0052](0052-the-payment-you-cannot-take-back.md),
  [ADR 0058](0058-telling-a-supplier-what-a-payment-was-for.md)

## Context

`payRunAction` has looked like this since Phase 49:

```ts
for (const supplier of plan.suppliers) {
  await recordPayment(actor, { ... })
  paid.push(supplier.vendorName)
  paidCents += supplier.totalCents
}
...
} catch (error) {
  return { ok: false, error: messageFor(error, 'That pay run could not be completed.') }
}
```

The doc comment directly above it said:

> The ones already paid stay paid, and **the message says how far it got.**

The first half was true. The second half was never implemented: `paid` and
`paidCents` were accumulated inside the loop and **thrown away by the `catch`**.
A business ticking eight bills across four suppliers, where the third failed,
saw *"That pay run could not be completed"* while real money had already left
its bank for the first two — and had no way to find out which.

This is the worst shape a failure message can take. It was not wrong about the
ledger, which was correct throughout. It was wrong about **what the person now
has to do**: it reads as "nothing happened, try again", and the true state was
"two suppliers are paid, two are not."

## Decision 1: a partial run is a success with a warning

The phase turns on one sentence, and it belongs in `batch.ts` rather than in
prose: `batchSucceeded(status)` is true for `partial`.

Reporting a partial run as a failure is what invites the damage. Pressing the
button again is in fact **safe** — `payableQueue` only ever returns bills with a
balance, so a settled bill is no longer selectable and nothing doubles, and
there is a test pinning that. But a person told a payment failed does not only
press the button again. They ring the supplier, or key it into the bank by hand.
The screen has to say what went.

`nothing` remains an honest failure: no money moved, and the person may act on
that however they like.

## Decision 2: a run is a row, not a grouping

Grouping payments by `(payment_date, reference)` after the fact would be a
guess — two runs on the same day with no reference are indistinguishable — and a
run that paid **nobody** has no payments to group at all. That last case is the
one most worth keeping: *"somebody tried to send $40,000 on Friday and none of
it went"* is exactly the fact a business needs, and a row of its own is the only
place it can live.

The run is opened **before any money moves** and updated when the loop finishes,
for the reason Phase 42 records a message before sending it: a crash between the
first payment and the summary leaves a row saying somebody started a run, which
a person can act on. A run written only on success would leave the crash
invisible, which is the failure this phase exists to fix.

`payments.pay_run_id` is null for every payment made one at a time, and for all
58 phases of payments made before runs were recorded. There is no backfill —
inventing runs for historic payments would put a claim in the books nobody made.

## Decision 3: the loop moved out of the server action

It used to live in `payRunAction`, which put the one piece of behaviour this
phase is about inside `src/app`, where this project keeps no business logic and
where no test can reach it. `executePayRun` is in `src/modules/payables/`, and
the partial case is now proved rather than argued about.

There is still **no transaction around the run**, and that is unchanged and
deliberate: rolling back would undo payments a business may already have sent
from its bank. The ledger was always correct. What was missing was the honest
report.

## Decision 4: one core for two batches

A pay run and a remittance run are the same shape — a loop over suppliers where
some succeed and some do not — so `batchStatus` decides both. Writing the rule
twice would let the two drift into disagreeing about what "partly worked" means,
which is the two-answers defect this project keeps refusing.

That sharing pays for itself immediately. `adviseRun` discharges the follow-up
ADR 0058 nominated — telling a whole run's suppliers what their payment covered
— and its common failure is a supplier with no address on file, which Phase 58
refuses with an instruction rather than a rule. A loop that threw on the first
one would leave the rest of a run silently unadvised: the same failure as the
pay run, one level up, and it is prevented by the same code.

A payment somebody has taken back is **skipped rather than reported**. Phase 58
will not send a fresh advice for a voided payment and is right not to — the
advice would describe money the supplier does not have — but inside a batch that
is not a failure worth reporting to anybody, and the supplier's existing link
already says the payment was reversed.

## Consequences

- A partial run says what went, names every supplier that did not, and tells the
  person not to send it again.
- "What did we pay on Friday?" is answerable, including for the run that paid
  nothing.
- A run's suppliers can be advised in one act, which is the job nobody does
  forty times by hand.
- `listPayRuns` counts live and advised suppliers from the payments rather than
  storing them, because both change *after* the run finishes — Phase 52 can void
  one of its payments and Phase 58 can advise one on its own. A stored count
  would be a second answer that drifts.

## What this does not do

- **`unpaid_cents` adds currencies together.** It comes from `planRun`, which
  sums document amounts, so a supplier owed €4,000 and $4,000 records $8,000
  still owed. The browser check produced exactly that figure. It is the defect
  [ADR 0056](0056-the-balance-that-added-currencies-together.md) fixed on the
  customers screen and has not yet been fixed here — and there is a certain
  justice in it, because a mixed-currency supplier is precisely what the payment
  was refused for. Fixing it means converting through `functionalCurrency` in
  `planRun`, which changes the figure on the Pay button and deserves its own
  phase.
- **It does not retry a failed supplier.** The bills are still outstanding and
  still selectable, so the fix is to press Pay again for that supplier — but
  nothing offers to do it from the run.
- **It does not advise a run automatically when the run completes.** Deliberate,
  for the reason ADR 0055 gave about statement runs: something that emails every
  supplier without anybody deciding again should be a decision, not a side
  effect. **Advise all** is one press.
