import { asc, eq, isNull } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  opportunities,
  progressBillings,
  proposalItems,
  proposalScheduleStages,
  proposals,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { createInvoice } from '@/modules/receivables/service'
import { createJournalEntry } from '@/modules/ledger/journal'
import { resolveRetainerAccount } from '@/modules/timebilling/billing'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import {
  billStageStands,
  nextBillable,
  recognisesDeposit,
  scheduleAmounts,
  type ScheduleStage,
  type StageState,
} from './billing-schedule'

/**
 * Billing a contract one stage at a time (spec §6, §7, Phase 155).
 *
 * ## What Phase 154 left
 *
 * It gave a proposal a billing schedule and made conversion raise the deposit.
 * Two things were missing and ADR 0154 named both:
 *
 * 1. **Nothing could bill a stage.** The milestones were written onto the job's
 *    schedule of values, which is the construction path behind the
 *    `job_costing` module. A company without that module had stages on a
 *    contract and no way to invoice any of them — a capability described and
 *    unreachable, which is Phase 49's rule.
 * 2. **The deposit was never recognised.** Credited to unearned revenue,
 *    correctly, and nothing turned it into revenue when the work was done.
 *
 * ## Two progress-billing paths, and why that is not duplication
 *
 * `jobs/billing.ts` is AIA-style progress billing: a schedule of values, percent
 * complete per line, retainage, and numbered applications. It is the right tool
 * for a construction contract and it stays exactly as it is.
 *
 * This is the other kind: *"50% on signing, 25% at the frame, 25% on handover"*,
 * which is what most contracts outside construction say and what a proposal's
 * own schedule already holds. Billing a stage is one invoice for an agreed share
 * of the contract — no percent complete to assess, no retainage, nothing to
 * price. Building that on top of the applications machinery would mean inventing
 * a schedule of values for a two-stage plumbing job and asking somebody to say
 * it is 100% complete.
 *
 * So the two are told apart by what the contract says rather than by a setting,
 * and neither needs the other to exist.
 */

/** The schedule with what has happened to each stage. */
export async function stageStates(
  ctx: ActorContext,
  proposalId: string,
  exec: Executor = db,
): Promise<StageState[]> {
  const [proposal] = await exec
    .select({ totalCents: proposals.totalCents })
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))
    .limit(1)

  if (!proposal) throw missing('proposal')

  const rows = await exec
    .select({
      label: proposalScheduleStages.label,
      kind: proposalScheduleStages.kind,
      percentBp: proposalScheduleStages.percentBp,
      invoiceId: proposalScheduleStages.invoiceId,
      billedCents: proposalScheduleStages.billedCents,
    })
    .from(proposalScheduleStages)
    .where(scoped(ctx, proposalScheduleStages, eq(proposalScheduleStages.proposalId, proposalId)))
    .orderBy(asc(proposalScheduleStages.sortOrder))

  if (rows.length === 0) return []

  /**
   * Derived for what is still to bill, stored for what has been (Phase 156).
   *
   * The derivation is right for an unbilled stage: a proposal whose total
   * changed cannot leave a schedule quietly adding up to something else, and
   * `splitExactly` makes the parts come back to the whole whatever the whole is.
   *
   * It was wrong for a billed one, which is the defect Phase 155 shipped. A won
   * proposal's items can still be edited — `loadProposal` carries no status
   * guard — so a $20,000 contract billed 25% and then edited to $40,000 reported
   * its first stage as $10,000 against a $5,000 invoice. `billedSoFar` lied, and
   * `recogniseDeposit` debited unearned revenue by more than had ever been
   * credited to it, driving the liability negative.
   *
   * So `amountCents` is what this stage *would* be billed for and `billedCents`
   * is what it *was*. The choice between them is made here, once, rather than at
   * each caller.
   */
  const priced = scheduleAmounts(
    proposal.totalCents,
    rows.map((row) => ({
      label: row.label,
      kind: row.kind as ScheduleStage['kind'],
      percentBp: row.percentBp,
    })),
  )

  return priced.map((stage, index) => ({
    ...stage,
    // A billed stage's amount is the figure it was billed at, so nothing
    // downstream has to know which of the two to read.
    amountCents: rows[index].billedCents ?? stage.amountCents,
    invoiceId: rows[index].invoiceId,
    billedCents: rows[index].billedCents,
  }))
}

export type StageBilling = {
  invoiceId: string
  amountCents: number
  label: string
  /** The entry that recognised the deposit, when this stage completed the contract. */
  recognitionEntryId: string | null
}

/**
 * Invoices one stage of the contract.
 *
 * The invoice and the stage's record of it commit together, so there is no state
 * where a client holds an invoice for a stage the contract still shows as
 * unbilled — the same rule `createProgressBilling` states for its own two
 * halves.
 */
export async function billStage(
  ctx: ActorContext,
  input: { proposalId: string; stageIndex: number; issueDate?: string },
): Promise<StageBilling> {
  // The same permission `createInvoice` asks for, checked here so the refusal
  // arrives before any of the work below rather than from inside it.
  requirePermission(ctx, 'accounting:journal')

  const stages = await stageStates(ctx, input.proposalId)
  const verdict = billStageStands(stages, input.stageIndex)
  if (!verdict.ok) throw new Refusal(verdict.why)

  const stage = stages[input.stageIndex]
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.id, input.proposalId)))
    .limit(1)

  if (!proposal) throw missing('proposal')

  /**
   * One contract, one billing path.
   *
   * Conversion writes the earning stages onto the job's schedule of values for
   * companies that run job costing, and `createProgressBilling` bills against
   * that with percent-complete applications. Both paths bill the same work, so a
   * contract that has been billed through one must not be billed through the
   * other — and nothing said so until this check, which would have made this
   * phase's own change the way to bill a job twice.
   *
   * Refused rather than reconciled: making the two agree would mean deciding how
   * a 40%-complete application maps onto a stage that is either billed or not,
   * and there is no answer to that which is not somebody's policy. The schedule
   * of values stays — it is the job's breakdown of value for costing — and only
   * billing through it is exclusive with billing by stage.
   */
  const { projectId } = await jobForProposal(ctx, proposal.opportunityId)
  if (projectId) {
    const applications = await db
      .select({ id: progressBillings.id })
      .from(progressBillings)
      .where(scoped(ctx, progressBillings, eq(progressBillings.projectId, projectId)))
      .limit(1)

    if (applications.length > 0) {
      throw new Refusal(
        'This contract’s job is being billed by progress application, which bills against its ' +
          'schedule of values. Billing a stage as well would charge the client twice for the same ' +
          'work — carry on in the job’s billing panel, or void the applications first.',
      )
    }
  }

  const customerId = await customerForProposal(ctx, proposal.opportunityId)
  if (!customerId) {
    throw new Refusal(
      'This proposal has no client yet. Convert the won opportunity first, so the invoice has ' +
        'somebody to go to.',
    )
  }

  /**
   * Which account the stage credits, and it is the whole accounting question.
   *
   * A deposit is money before work, so it credits unearned revenue — the same
   * account and the same resolver `conversion.ts` uses, because a firm holding
   * retainers and deposits should put both in one place. Everything else is work
   * billed, so it credits revenue.
   */
  const revenueAccountId = await revenueForProposal(ctx, input.proposalId)
  const creditAccountId =
    stage.kind === 'deposit'
      ? (await resolveRetainerAccount(ctx.companyId)).account.id
      : revenueAccountId

  if (!creditAccountId) {
    throw new Refusal(
      'This proposal’s lines name no revenue account, so there is nothing to credit. Set one on ' +
        'the proposal and bill the stage again.',
    )
  }

  const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10)

  const invoice = await createInvoice(ctx, {
    customerId,
    issueDate,
    lines: [
      {
        chartAccountId: creditAccountId,
        description: `${proposal.number} — ${stage.label}`,
        unitPriceCents: stage.amountCents,
      },
    ],
  })

  const recognitionEntryId = await db.transaction(async (tx) => {
    const marked = await tx
      .update(proposalScheduleStages)
      // What it was billed for, beside the invoice that billed it (Phase 156).
      // The CHECK on the table requires both or neither.
      .set({ invoiceId: invoice.id, billedCents: stage.amountCents })
      .where(
        scoped(
          ctx,
          proposalScheduleStages,
          eq(proposalScheduleStages.proposalId, input.proposalId),
          eq(proposalScheduleStages.sortOrder, input.stageIndex),
          // Only if still unbilled. Two people clicking at the same moment would
          // both pass the check above; this is what makes the second one lose.
          // The unique index on `invoice_id` would catch it too, with a worse
          // message.
          isNull(proposalScheduleStages.invoiceId),
        ),
      )
      .returning({ id: proposalScheduleStages.id })

    if (marked.length === 0) {
      throw new Refusal(
        `“${stage.label}” was invoiced a moment ago by somebody else. Reload the contract to see ` +
          'what is left.',
      )
    }

    const entryId = recognisesDeposit(stages, input.stageIndex)
      ? await recogniseDeposit(ctx, proposal.id, stages, issueDate, tx)
      : null

    await recordAudit(
      ctx,
      {
        action: 'proposal.stage_billed',
        entityType: 'proposal',
        entityId: proposal.id,
        after: {
          stage: stage.label,
          kind: stage.kind,
          amountCents: stage.amountCents,
          invoiceId: invoice.id,
          depositRecognised: entryId !== null,
        },
      },
      tx,
    )

    return entryId
  })

  return {
    invoiceId: invoice.id,
    amountCents: stage.amountCents,
    label: stage.label,
    recognitionEntryId,
  }
}

/**
 * Turns the held deposit into revenue, once.
 *
 * `Dr Unearned Revenue / Cr Revenue` — not an application against a receivable.
 * `recognisesDeposit` argues why: a deposit on this schedule is a stage of the
 * contract, so the stages already come to 100% and the deposit invoice collected
 * its own share. What was never done is recognising it.
 *
 * Guarded by `deposit_recognised_entry_id` being null, inside the same
 * transaction that marks the last stage billed, so a retry cannot post it twice.
 */
async function recogniseDeposit(
  ctx: ActorContext,
  proposalId: string,
  stages: readonly StageState[],
  entryDate: string,
  tx: Executor,
): Promise<string | null> {
  /**
   * What the deposit was actually invoiced for, not what it would be today.
   *
   * The figure that drove the liability negative. `2500` was credited by the
   * deposit invoice, so it has to be relieved by exactly that — and after an
   * edit to the contract the derived share is a different number.
   */
  const deposit = stages.find((stage) => stage.kind === 'deposit')
  const creditedCents = deposit?.billedCents ?? 0
  if (!deposit || creditedCents <= 0) return null

  const held = (await resolveRetainerAccount(ctx.companyId, tx)).account
  const revenueAccountId = await revenueForProposal(ctx, proposalId, tx)
  if (!revenueAccountId) return null

  const [proposal] = await tx
    .select({
      number: proposals.number,
      recognised: proposals.depositRecognisedEntryId,
    })
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))
    .limit(1)

  // Already recognised. Not an error: a voided-and-rebilled final stage reaches
  // here twice and the deposit is earned once.
  if (!proposal || proposal.recognised !== null) return null

  const entry = await createJournalEntry(
    ctx,
    {
      entryDate,
      memo: `${proposal.number} — deposit earned on completion`,
      source: 'manual',
      sourceType: 'proposal',
      sourceId: proposalId,
      lines: [
        { chartAccountId: held.id, debitCents: creditedCents },
        {
          chartAccountId: revenueAccountId,
          creditCents: creditedCents,
          memo: 'Held until the work was done',
        },
      ],
    },
    tx,
  )

  await tx
    .update(proposals)
    .set({ depositRecognisedEntryId: entry.id })
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))

  return entry.id
}

/** The job this proposal's opportunity was converted into, if it has been. */
async function jobForProposal(
  ctx: ActorContext,
  opportunityId: string,
  exec: Executor = db,
): Promise<{ projectId: string | null }> {
  const [row] = await exec
    .select({ projectId: opportunities.convertedProjectId })
    .from(opportunities)
    .where(scoped(ctx, opportunities, eq(opportunities.id, opportunityId)))
    .limit(1)

  return { projectId: row?.projectId ?? null }
}

/** The client this proposal's opportunity was converted into, if it has been. */
async function customerForProposal(
  ctx: ActorContext,
  opportunityId: string,
  exec: Executor = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ customerId: opportunities.convertedCustomerId })
    .from(opportunities)
    .where(scoped(ctx, opportunities, eq(opportunities.id, opportunityId)))
    .limit(1)

  return row?.customerId ?? null
}

/**
 * The revenue account the proposal's own lines name.
 *
 * The first one rather than a guess across several: a stage is a share of the
 * whole contract, not of one line item, so there is no per-stage account to read
 * and splitting a stage across the lines' accounts would be inventing an
 * allocation. `conversion.ts` takes the same first-named account for the schedule
 * of values, for the same reason.
 */
async function revenueForProposal(
  ctx: ActorContext,
  proposalId: string,
  exec: Executor = db,
): Promise<string | null> {
  const items = await exec
    .select({ chartAccountId: proposalItems.chartAccountId })
    .from(proposalItems)
    .where(scoped(ctx, proposalItems, eq(proposalItems.proposalId, proposalId)))
    .orderBy(asc(proposalItems.sortOrder))

  return items.find((item) => item.chartAccountId)?.chartAccountId ?? null
}

/** What is left to bill on a contract, for a screen to show. */
export async function stagesDue(ctx: ActorContext, proposalId: string) {
  requirePermission(ctx, 'proposals:view')

  const stages = await stageStates(ctx, proposalId)
  const next = nextBillable(stages)

  return {
    stages,
    next,
    nextIndex: next ? stages.indexOf(next) : null,
    billedCents: stages
      .filter((stage) => stage.invoiceId !== null)
      .reduce((sum, stage) => sum + stage.amountCents, 0),
    remainingCents: stages
      .filter((stage) => stage.invoiceId === null)
      .reduce((sum, stage) => sum + stage.amountCents, 0),
  }
}
