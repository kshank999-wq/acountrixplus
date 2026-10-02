# 0155 — Billing a contract in stages

**Status:** accepted
**Date:** 2026-10-02
**Phase:** 155

---

## What was asked for

Two things, in the user's words: *"the ability to create progress payments or
progress invoicing from a single contract"*, and *"the ability to instantly
create a retainer or deposit invoice after the contract proposal or estimate is
accepted. Digitally."*

Measured first, because one of them was half-built and the other was not built at
all.

## Progress invoicing: there were already two kinds, and one was missing

`jobs/billing.ts` is AIA-style progress billing — a schedule of values, percent
complete per line, retainage, numbered applications, `releaseRetainage`. It is
the right tool for a construction contract, it has a screen, and it stays exactly
as it is. Rebuilding it would have been the duplication this project keeps
refusing.

What was missing is the other kind, which is what most contracts outside
construction say: *"50% on signing, 25% at the frame, 25% on handover."* Phase 154
gave a proposal exactly that schedule and **nothing could bill it.** The
milestones were written onto the job's schedule of values, which requires the
`job_costing` module — so a company without it had stages on a contract and no
way to invoice any of them. A capability described and unreachable, which is
Phase 49's rule.

The two are told apart by what the contract says rather than by a setting, and
neither needs the other. Billing a stage is one invoice for an agreed share of
the contract: no percent complete to assess, no retainage, nothing to price.
Building it on the applications machinery would have meant inventing a schedule
of values for a two-stage plumbing job and asking somebody to declare it 100%
complete.

## The deposit on signing: acceptance marked the deal won and stopped

`acceptProposal` is the digital signature path. It writes the acceptance, marks
the proposal and the opportunity won, logs the activity, and records a
`proposal.accepted` event. Then it stops. The client had signed and the deposit
the contract asks for did not exist until somebody noticed, opened the pipeline
board and clicked Convert.

For a deposit that is the whole point. The reason a contract says "50% on
signing" is that the money arrives before the work does, and a deposit invoiced
on Monday because a human got round to it is a deposit that did not do its job
over the weekend.

### Why a job and not part of the acceptance

The acceptance is a client-facing request holding a signature, and it must not
fail because the chart of accounts is missing a revenue account or a period is
closed. `acceptProposal` already makes this argument about notifications — the
swallowed `announceAcceptance(...).catch(() => {})` it replaced — and it is
stronger here, because conversion writes to the ledger.

So `receivables.deposit_on_acceptance` subscribes to the event that is already
recorded inside the acceptance transaction: a rollback takes it with it, a commit
guarantees it happens, and a failure is a retried job with backoff and a dead
letter rather than a signature a client could not give.

`proposal.accepted` is the first event with **two** subscribers, and
`worker.test.ts` noticed — one event fanning out to several independent jobs is
what the relay is for, and the count moving is that table being read rather than
assumed. Telling the team and invoicing the deposit are different kinds of
failure: a push notification that does not land is a nuisance, and a deposit that
is never raised is the reason the contract asked for one.

Idempotent, and it has to be: the queue promises at least once (Phase 10).
`convertWonOpportunity` returns what it already created, and `billStage` refuses
a stage that already has an invoice — so a second run finds the work done and
says so.

## Recognising the deposit, which is the accounting in this phase

ADR 0154 nominated it and said plainly it was deliberately not half-done. Making
stages billable without it would have shipped a known-wrong ledger: bill every
stage of a contract with a 25% deposit and the revenue account holds 75% of a
finished contract with a quarter stranded in a liability for ever.

**It is a recognition, not a credit, and that distinction is the whole of it.**
A retainer drawdown in `timebilling` posts `Dr Unearned Revenue / Cr Accounts
Receivable`: money is held and later *applied* to reduce what a client owes.
Copying that here would be wrong. A deposit on this schedule is a **stage of the
contract**, so the stages already come to 100% — the client pays 25% on signing
and 75% across the rest, and the total invoiced is the contract. There is nothing
to apply against the later invoices, because the deposit invoice collected its
own share.

What was never done is recognising it. So the entry is `Dr Unearned Revenue / Cr
Revenue`, posted once, on the **last** stage — because that is when the work the
deposit was taken against is done. Recognising it earlier would call money earned
while the job is still running, which is what `deferred_revenue` exists to
prevent; recognising it in slices would need a rule about which slice, and every
such rule this project has met turned out to be a decision somebody should make
rather than one to bury in arithmetic.

Guarded by `proposals.deposit_recognised_entry_id` being null inside the same
transaction that marks the last stage billed, so a retry cannot post it twice.
On the proposal rather than on a stage, because it is a fact about the deposit
and the deposit is one stage however many milestones there are.

## Order is a decision

`billStageStands` refuses a stage whose predecessor is unbilled. That is a
decision rather than an oversight: a schedule reads "on signing, then at the
frame, then on handover", and billing the handover first is either a mistake or a
change to the contract. Refusing costs a company nothing it cannot undo by
editing the schedule; allowing it would let a job be billed to completion with
the work in between never appearing.

The refusal names the stage to bill instead, which is Phase 119's standard — "not
allowed" sends somebody back to the code.

## What the screens do

Only the next unbilled stage gets a button. `billStageStands` refuses the others,
and offering a button that is always refused is the preview-versus-commit split
Phase 151 spent a phase repairing. Billed stages are struck through, with
`$X of $Y invoiced` beside them, because the question somebody opens this to
answer is *what do I invoice next* and a list of percentages does not answer it.

## Two registers moved, and both were measured

- **`isolation-reads` 868 → 875**, all seven on `scoped-read`. Measured rather
  than assumed: the length assertion fails before the per-guard map is compared,
  so the figure came from running it and reading the diff.
- **`isolation-guards` 109 → 110**, `scoped-write` 27 → 28. Marking a stage
  billed is keyed by proposal *and* sort order *and* scoped to the company, which
  is what stops an id a caller hands in reaching another tenant's contract.

## One contract, one billing path — a hole this phase nearly opened

Worth recording, because it was almost nominated as future work instead of fixed.

Conversion writes the earning stages onto the job's schedule of values for
companies that run job costing, and `createProgressBilling` bills against that.
Before this phase the stages were unbillable, so a job-costing company billed
through applications and only applications. **Making stages billable without a
check would have made this phase the way to bill a job twice** — a regression
introduced by the change, not inherited by it.

`billStage` refuses a stage once the job has any progress application. Refused
rather than reconciled: making the two agree would mean deciding how a
40%-complete application maps onto a stage that is either billed or not, and
there is no answer to that which is not somebody's policy. The schedule of values
stays, because it is the job's breakdown of value for costing; only *billing*
through it is exclusive with billing by stage.

The draft of this ADR had this as "nothing yet stops somebody doing both, and
that is the next thing worth a look." That sentence was true and was the wrong
thing to write, which is why checking a nomination before publishing it is worth
the minute it costs.

## What this does not do

**It does not replace the construction path.** A job with a real schedule of
values and percent-complete applications still bills through
`createProgressBilling`, and conversion still writes the milestones onto the job
for companies that run job costing. The two are now exclusive per contract, as
above.

**It does not take payment.** The deposit invoice is raised digitally the moment a
client signs; collecting it is the payment link that already exists.

**It does not let a stage be part-billed.** A stage is an agreed share of the
contract and is billed in full. A client who wants half of stage two wants a
different schedule, and editing it is one click.

**It does not recognise a deposit in slices.** Argued above.

## What is nominated next

**Part-billing a stage.** A stage is billed in full today, and a client who pays
half of stage two has nowhere for that to live except a payment on account. The
question it raises is the one this phase declined to answer for the deposit: what
fraction of an agreed share has been earned, and who decides. It is a real
request before it is a defect, so it should wait for somebody to ask.

**Relating the two billing paths rather than excluding them.** The check above is
a refusal, which is the honest answer today and not the interesting one. A
contract whose stages *are* its schedule of values — one row each, billed when
the stage is reached — would make the exclusion unnecessary, and that is a
migration plus a decision about retainage.
