/**
 * What a won proposal asks to be paid, and when (Phase 154).
 *
 * ## What was wrong
 *
 * Spec §6 requires that a won proposal creates *"a client, job/project,
 * contract, **invoice schedule**, and accounting dimensions without re-entry"*,
 * and `conversion.ts` quotes that sentence in its own doc comment. What it had
 * was one invoice:
 *
 * ```ts
 * // invoiceFromProposal
 * const invoice = await createInvoice(ctx, {
 *   issueDate: new Date().toISOString().slice(0, 10),
 *   lines: billable.map(…),          // every selected item
 * })
 * ```
 *
 * So a $500,000 contract invoiced the client the whole contract value on the day
 * they signed it, before any work was done — revenue recognised for work not
 * performed, and a job showing itself overbilled by its entire value. A test
 * asserted that as correct: `expect(invoice.totalCents).toBe(1_800_000)`.
 *
 * And **no screen could reach it.** `pipeline-board.tsx` calls
 * `convertAction(id, false)` with the flag hardcoded, so the only
 * `createInvoice: true` in the repository was that one test. Two faults in one
 * seam, pointing opposite ways: the capability spec §6 names did not exist
 * (Phase 49's rule — a function with no caller is a feature that does not
 * exist), and the thing standing in for it would have been wrong if it had.
 *
 * ## A deposit is not a milestone, and that is the whole design
 *
 * It is tempting to treat "50% deposit, then three milestones" as four stages of
 * one kind. They are two kinds, and the difference is whether the money has been
 * earned:
 *
 * - A **milestone** bills work. It is revenue when billed, and it belongs on the
 *   job's schedule of values, where `setScheduleOfValues` already keeps the
 *   breakdown and progress billing already draws against it.
 * - A **deposit** is money taken *before* any work. It is a liability until the
 *   work is done — `2500 Unearned Revenue`, whose entry in the chart of accounts
 *   already says exactly this: *"money taken before the work is done. Subtype
 *   matters — it is what makes a deposit revenue on a cash-basis report and not
 *   on an accrual one."*
 *
 * `SovLineInput` requires a `chartAccountId` and a schedule of values is a
 * breakdown of the contract into *billable work*, so a deposit cannot be a line
 * on it. Which is the same shape Phase 153 drew one module over: does this act
 * create the balance it posts against, or relieve one? A deposit creates a
 * liability; billing a milestone earns revenue.
 *
 * ## Which came first, the whole or the parts
 *
 * ADR 0147's question, and here the answer is unambiguous: the **contract** is
 * the figure both sides signed, and the stages are carved out of it. So a
 * percentage schedule must reproduce the contract exactly — 50/25/25 of
 * $100,000.01 has to come to $100,000.01 and not a cent more — which is
 * `splitExactly`'s largest-remainder rule (Phase 145) and not a per-stage
 * rounding summed up.
 *
 * Phase 145 found that same mistake in tax lines and ADR 0147 named why it is
 * the same question. This file does not re-derive it; it hands the weights over.
 *
 * Nothing here touches the database or the clock.
 */

import { splitExactly } from '@/modules/money/splitting'

/** What a stage of a billing schedule is for. */
export type StageKind =
  /**
   * Money up front, before any work. A liability when it arrives, earned only as
   * the work is done — so it never posts to revenue, however it is invoiced.
   */
  | 'deposit'
  /**
   * Work at an agreed point in the contract. Revenue when billed, and a line on
   * the job's schedule of values.
   */
  | 'milestone'
  /**
   * Whatever is left, billed when the job finishes. Separated from `milestone`
   * because it is the stage that must absorb nothing: a retention or a final
   * payment that silently differs from the contract less what was billed is how
   * a job ends up permanently a few cents from square.
   */
  | 'on-completion'

/** One stage as a person writes it on a proposal. */
export type ScheduleStage = {
  label: string
  kind: StageKind
  /** Basis points of the contract. 5_000 is half. */
  percentBp: number
}

/** One stage with the money worked out. */
export type ScheduledStage = ScheduleStage & {
  amountCents: number
  /** True when this stage is money before work, and so a liability when paid. */
  earnsRevenue: boolean
}

/** A whole basis point, so a schedule reads in the units people quote. */
export const FULL_BP = 10_000

/**
 * Turns a contract and its stages into amounts that sum to the contract.
 *
 * The weights are basis points, which `splitExactly` accepts as-is because they
 * are whole non-negative integers. Their total need not be `FULL_BP` — a split
 * is by weight — but `scheduleStands` refuses a schedule whose stages do not add
 * up to the whole contract, because a proposal that bills 90% of itself is a
 * proposal with 10% nobody will ever invoice.
 */
export function scheduleAmounts(
  contractCents: number,
  stages: readonly ScheduleStage[],
): ScheduledStage[] {
  const amounts = splitExactly(
    contractCents,
    stages.map((stage) => stage.percentBp),
  )

  return stages.map((stage, index) => ({
    ...stage,
    amountCents: amounts[index],
    earnsRevenue: stage.kind !== 'deposit',
  }))
}

export type ScheduleVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a schedule is one somebody can be billed from.
 *
 * Pure, and every refusal is a sentence a person reading a proposal can act on
 * (Phase 119) rather than a code to look up.
 */
export function scheduleStands(stages: readonly ScheduleStage[]): ScheduleVerdict {
  if (stages.length === 0) {
    return {
      ok: false,
      why:
        'This proposal has no billing schedule, so winning it would say what the work is worth and ' +
        'nothing about when any of it is invoiced.',
    }
  }

  const unlabelled = stages.filter((stage) => stage.label.trim().length === 0)
  if (unlabelled.length > 0) {
    return {
      ok: false,
      why:
        'Every stage needs a name. The client sees these on the proposal and on each invoice, and ' +
        '"Stage 2" is what somebody writes when they have not decided what it is for.',
    }
  }

  const negative = stages.filter((stage) => !Number.isInteger(stage.percentBp) || stage.percentBp < 0)
  if (negative.length > 0) {
    return {
      ok: false,
      why:
        'A stage cannot be a negative share of the contract, and a share is a whole number of ' +
        'basis points. A credit belongs on a credit note, not in a billing schedule.',
    }
  }

  const total = stages.reduce((sum, stage) => sum + stage.percentBp, 0)
  if (total !== FULL_BP) {
    const shortfall = FULL_BP - total
    return {
      ok: false,
      why:
        `These stages come to ${(total / 100).toFixed(2)}% of the contract, not 100%. ` +
        (shortfall > 0
          ? `${(shortfall / 100).toFixed(2)}% of the work would be done and never invoiced.`
          : `The client would be billed ${(-shortfall / 100).toFixed(2)}% more than they agreed to.`),
    }
  }

  const deposits = stages.filter((stage) => stage.kind === 'deposit')
  if (deposits.length > 1) {
    return {
      ok: false,
      why:
        'Only one stage can be the deposit. Money taken before any work is held as a liability ' +
        'until it is earned, and two of them is two balances to relieve with nothing saying which ' +
        'of the two a later invoice draws down first.',
    }
  }

  if (stages.every((stage) => stage.kind === 'deposit')) {
    return {
      ok: false,
      why:
        'The whole contract cannot be a deposit. A deposit is money held against work that is ' +
        'still to come, so a schedule made only of one never earns any of it and the liability ' +
        'never clears.',
    }
  }

  const completion = stages.filter((stage) => stage.kind === 'on-completion')
  if (completion.length > 1) {
    return {
      ok: false,
      why:
        'Only one stage can be the final one. Two stages both billed "on completion" is two ' +
        'invoices raised on the same event, which is how a job gets billed twice for its last ' +
        'payment.',
    }
  }

  return { ok: true }
}

/**
 * The stages that belong on the job's schedule of values, in order.
 *
 * The deposit is deliberately **not** here, and that is the one thing this
 * function exists to say. A schedule of values is what the job will earn; a
 * deposit is money held before it earns anything. Putting the deposit on the
 * SOV would make the job's contract value the sum of its work *plus* money that
 * is not work, so every WIP report would show it overbilled by the deposit from
 * the day it was signed.
 */
export function sovStages(stages: readonly ScheduledStage[]): ScheduledStage[] {
  return stages.filter((stage) => stage.earnsRevenue)
}

/** The deposit stage, when the schedule has one. */
export function depositStage(stages: readonly ScheduledStage[]): ScheduledStage | null {
  return stages.find((stage) => stage.kind === 'deposit') ?? null
}

/** A stage with what has happened to it. */
export type StageState = ScheduledStage & {
  /** The invoice that billed this stage, when one has. */
  invoiceId: string | null
}

export type BillVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether this stage may be billed now (Phase 155).
 *
 * The stages are **in order** and billed in order, which is a decision rather
 * than an accident: a schedule reads "on signing, then at the frame, then on
 * handover", and billing the handover first is either a mistake or a change to
 * the contract. Refusing it costs a company nothing it cannot undo by editing
 * the schedule, and allowing it would let a job be billed to completion without
 * the work in between ever appearing.
 */
export function billStageStands(stages: readonly StageState[], index: number): BillVerdict {
  const stage = stages[index]
  if (!stage) {
    return { ok: false, why: 'That stage is not on this contract’s billing schedule.' }
  }

  if (stage.invoiceId !== null) {
    return {
      ok: false,
      why:
        `“${stage.label}” has already been invoiced. Billing it again would charge the client ` +
        'twice for the same stage of the contract.',
    }
  }

  const unbilledBefore = stages.slice(0, index).filter((earlier) => earlier.invoiceId === null)
  if (unbilledBefore.length > 0) {
    return {
      ok: false,
      why:
        `“${unbilledBefore[0].label}” comes before “${stage.label}” and has not been invoiced. ` +
        'A schedule is billed in the order it was agreed — bill that one first, or change the ' +
        'schedule if the work really did happen out of order.',
    }
  }

  return { ok: true }
}

/** The next stage due, or `null` when the contract is fully billed. */
export function nextBillable(stages: readonly StageState[]): StageState | null {
  return stages.find((stage) => stage.invoiceId === null) ?? null
}

/** What has been invoiced so far, in the company's own money. */
export function billedSoFar(stages: readonly StageState[]): number {
  return stages
    .filter((stage) => stage.invoiceId !== null)
    .reduce((sum, stage) => sum + stage.amountCents, 0)
}

/**
 * Whether billing this stage also turns the held deposit into revenue.
 *
 * ## Why recognition and not a credit
 *
 * A retainer drawdown in `timebilling` posts `Dr Unearned Revenue / Cr Accounts
 * Receivable`: the money is held and later *applied* to reduce what a client
 * owes. That is a different act from this one and copying it would be wrong
 * here.
 *
 * A deposit on this schedule is a **stage of the contract**, so the stages
 * already come to 100% — the client pays 25% on signing and 75% across the
 * rest, and the total invoiced is the contract. There is nothing to apply
 * against the later invoices, because the deposit invoice collected its own
 * share.
 *
 * What is left is that the deposit was credited to unearned revenue and has
 * never been recognised. Bill every other stage and the revenue account holds
 * 75% of a contract that is finished, with 25% sitting in a liability for ever.
 * So the entry is `Dr Unearned Revenue / Cr Revenue` — a recognition, posted
 * once.
 *
 * ## When
 *
 * On the **last** stage, because that is when the work the deposit was taken
 * against is done. Recognising it earlier would call money earned while the job
 * it belongs to is still running, which is the thing `deferred_revenue` exists
 * to prevent; recognising it in slices would need a rule about which slice, and
 * every such rule this project has met turned out to be a decision somebody
 * should make rather than one to bury in arithmetic.
 */
export function recognisesDeposit(stages: readonly StageState[], index: number): boolean {
  const deposit = stages.find((stage) => stage.kind === 'deposit')
  if (!deposit || deposit.invoiceId === null) return false

  // The last stage that is not the deposit itself: billing it completes the
  // contract, so whatever the deposit was held against has now been delivered.
  const earning = stages.filter((stage) => stage.kind !== 'deposit')
  if (earning.length === 0) return false

  return stages[index] === earning[earning.length - 1]
}
