# 0154 — The invoice schedule that billed everything

**Status:** accepted
**Date:** 2026-10-01
**Phase:** 154

---

## The nomination was wrong, and that is the first finding

ADR 0153 nominated **"spec §7's vector and layout design engine, now the largest
unbuilt piece."** Measured, that is false in a way that would have cost
something.

§7 is substantially built:

- **16 block types** in `design/blocks.ts`: cover, heading, text, list, columns,
  `keyValue`, `pricingTable`, `signature`, `clause`, image, video, button,
  `qrCode`, divider, spacer, `pageBreak`.
- `clauses` + `clause_versions` — the versioned, company-approved legal library
  §7 asks for.
- `proposals`, `proposal_items` with `is_optional`/`is_selected`,
  `proposal_versions`, `proposal_views`, `proposal_acceptances`, `expires_on`,
  `discount_cents`, `tax_cents`.
- `design_documents`, `document_templates`, the template gallery, merge fields,
  brand kits, QR rendering, and PDF output with running headers, footers and
  `N of M` page numbering.

The parts of §7 that are absent are absent **by decision**. ADR 0004 chose an
ordered block model over a free vector canvas, and `blocks.ts` quotes the spec's
own sentence licensing it: *"The first release should prioritize business-document
layout features; advanced Illustrator-class path editing can be phased in after
the core proposal workflow is stable."*

Calling that "the largest unbuilt piece" is Phase 110/125's defect — a
declaration argued from a fact that is not a fact — and the cost is specific: a
phase reading ADR 0153 and taking it as instruction would have built a canvas and
discarded ADR 0004's reasoning. The nomination is a claim to check, which is why
it is checked.

## What measurement found instead

Spec **§6**, not §7:

> Won proposal can create a client, job/project, contract, **invoice schedule**,
> and accounting dimensions without re-entry.

`crm/conversion.ts` quotes that exact sentence in its own doc comment. What it
had:

```ts
// invoiceFromProposal
const invoice = await createInvoice(ctx, {
  issueDate: new Date().toISOString().slice(0, 10),
  lines: billable.map(…),          // every selected item
})
```

One invoice, for every selected item, dated the day of conversion. A $500,000
contract invoiced the client the whole contract value on signing day — revenue
recognised for work not performed, a job overbilled by its entire value from the
moment it existed, and a client holding an invoice for work nobody has started.

`tests/proposals.test.ts` asserted that as correct:
`expect(invoice.totalCents).toBe(1_800_000)` — the whole proposal. The test and
the code were written from the same idea, so the check could not disagree, which
is Phase 121's rule.

**And no screen could reach it.** `pipeline-board.tsx` called
`convertAction(id, false)` with the flag hardcoded from the day it was written.
The only `createInvoice: true` in the repository was that one test.

So two faults in one seam, pointing opposite ways:

1. The capability spec §6 names **did not exist** — Phase 49's rule, since
   nothing in the product reached it.
2. The thing standing in for it **would have been wrong if it had** — and a test
   asserted it as right.

Phase 49's rule and its inversion in one function.

## A deposit is not a milestone

The design question, and the whole of it. It is tempting to treat "50% deposit,
then three milestones" as four stages of one kind. They are two kinds, and the
difference is whether the money has been earned:

- A **milestone** bills work. Revenue when billed, and a line on the job's
  schedule of values, where `setScheduleOfValues` already keeps the breakdown and
  progress billing already draws against it.
- A **deposit** is money taken *before* any work. A liability until the work is
  done — `2500 Unearned Revenue`, whose entry in the chart of accounts already
  says exactly this: *"money taken before the work is done. Subtype matters — it
  is what makes a deposit revenue on a cash-basis report and not on an accrual
  one."*

`SovLineInput` requires a `chartAccountId` and a schedule of values is a breakdown
of the contract into *billable work*, so a deposit cannot be a line on it. Putting
it there would make the contract value the work plus money that is not work, and
every WIP report would show the job overbilled by the deposit from the day it was
signed.

Which is Phase 153's question one module over: does this act create the balance it
posts against, or relieve one? A deposit creates a liability; billing a milestone
earns revenue.

## Which came first, the whole or the parts

ADR 0147's question with an unambiguous answer. The **contract** is the figure
both sides signed and the stages are carved out of it, so 50/25/25 of $100,000.01
has to come back to $100,000.01 — which is `splitExactly`'s largest-remainder rule
(Phase 145), not a per-stage rounding summed up. `scheduleAmounts` hands the
weights over in basis points and does no arithmetic of its own.

## Three things reused rather than invented

Measured before building, and all three already argued for themselves:

1. **`2500 Unearned Revenue`.** Its only caller was `timebilling` (retainers), so
   this is a second proper use of an account that already says what it is for.
   `2520 Customer Overpayments` even argues *against* being 2500 because an
   overpayment "carries no promise of future work" — a proposal deposit does, so
   2500 is right and the distinction was already written down.
2. **`resolveRetainerAccount`.** Phase 105 built it to say *which* account
   retainers landed on, because the reconciliation differs: on a dedicated `2550`
   the subledger and the ledger must be equal, and on the shared `2500` only "not
   more than" can be claimed. A deposit arriving in the shared case is exactly
   what that distinction was written for, so this phase adds a liability to a
   shared control account and **cannot** break its reconciliation — by an earlier
   phase's design. `CONTROL_ACCOUNTS` is only AR and AP, so nothing else claims
   equality on 2500.
3. **`splitExactly`** and **`setScheduleOfValues`**, above.

## A billing schedule must not require job costing

Found by running the test rather than by reading the call, and it would have been
a bad bug. `setScheduleOfValues` calls `requireModule(ctx, 'job_costing')`, so
telling the job unconditionally threw the **whole conversion** for any company
that does not run that module — and a plumber taking 50% up front and the rest on
completion has a perfectly ordinary schedule and no use for a construction
schedule of values.

The schedule lives on the proposal; the SOV is an additional projection of it for
companies that bill progressively. So the stages are kept either way and the job
is told only when it can listen, with `sovStageCount` coming back zero.

## The register that could not see the new site

`scheduleAmounts` is registered in `SPLIT_SITES` with `foundBy: null`, and the
reason is the opposite of the other `null` entry's. `splitFor` is invisible to the
division forms because its split is a *subtraction*; `scheduleAmounts` is
invisible because it contains **no arithmetic at all** — it hands the whole
question to `splitExactly` and maps the answer onto its stages, so a scan looking
for a multiply over a divide finds nothing to look at.

That is the best shape a split site can have and the one the forms cannot see,
which is worth writing down rather than leaving as an absence. The test that holds
`null` entries to an argument now accepts either reason and names both.

## What was deleted

`invoiceFromProposal`. Its own doc comment argued for the dimension it carried —
*"a schedule that missed it would show every converted job as underbilled by its
own first invoice"* — which was true about the dimension and silent about the
amount.

Deleted rather than left unreferenced: a function with no caller is a feature that
does not exist, and one that *would* be wrong if it were called is worse than
absent. `conversion.ts` carries a note where it was, saying what it did.

## The test was settled, not deleted

`tests/proposals.test.ts` asserted the whole-contract invoice. It now asserts that
a proposal with no schedule raises **nothing** — no deposit invoice, no SOV, and
no invoice of any kind against that customer — with the old assertion quoted in
the test and the reason it was wrong. A proposal with no billing schedule has
agreed no payment terms, so inventing one at conversion would be inventing terms
nobody agreed to, and billing the lot is what this replaced.

## Four registers the full suite moved

Every one found by its own test, and one of them is a decision rather than a
count:

- **`RETENTION_POLICIES`' table tripwire** asked the question it exists to ask:
  `proposal_schedule_stages` either grows with traffic and needs a sweep, or it is
  the business and goes in `NEVER_SWEPT`. It is the business — a billing schedule
  is the payment terms a client agreed to, and a deposit stage is the difference
  between money held as a liability and money recognised as revenue. Sweeping it
  would delete the terms behind invoices that are themselves never swept, leaving
  a deposit invoice nobody can explain. It needs no age policy because it does not
  grow with traffic: a proposal has a handful of stages and they cascade away with
  it.
- **`SPLIT_SITES`** at nine, `whole-first` at eight, and `parts-first` still at one
  — `createDeposit`, the counter-example ADR 0147 was named for. The ratio moving
  is the register recording that the common case is common.
- **`SITE_REGISTRIES`** at seventy declarations, which is what holds
  `scheduleAmounts` to being a real function despite no form reaching it: a
  registry entry naming a function nothing scans for is the shape Phase 140 found
  two fictions in.
- **`isolation-reads`** at 868, both new reads on `scoped-read`. Measured rather
  than assumed — the length assertion fails before the per-guard map is compared,
  so "both go through `scoped()`" was checked by making the claim and watching it
  pass rather than by reading the code.

## What this does not do

**It does not bill the milestones.** They become the job's schedule of values, and
progress billing draws against them as work is done — which is the existing path
and deliberately unchanged.

**It does not relieve the deposit automatically.** A later invoice does not yet
draw the unearned revenue down; somebody has to apply it. The liability is
correctly raised and correctly visible, and the drawdown is the next piece of this
seam rather than something quietly half-done.

**It does not backfill.** Every proposal written before this phase has no
schedule, and giving them one would be inventing payment terms. A proposal with no
stages is billed the way it always was: by hand.

**It does not add a currency to a stage.** A stage is a percentage of the
contract, and the contract carries whatever currency the proposal does.

## What is nominated next

**Relieving the deposit.** A deposit sitting in unearned revenue has to come off
when the work it was taken for is billed, and nothing does that yet. It is the
other half of this seam and the half with the accounting in it: the drawdown
decides when a liability becomes revenue, which is the question `2500`'s subtype
exists to answer.

After that, §9's geography analytics and §19's row-level security. §7's vector
canvas remains declined on ADR 0004's reasoning, and should be argued against that
ADR rather than nominated as a gap.
