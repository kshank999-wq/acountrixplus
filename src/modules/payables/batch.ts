import { formatCents } from '@/lib/money'

/**
 * What a loop over suppliers actually did (spec §13, §19, Phase 59).
 *
 * ## The bug this exists to fix
 *
 * Phase 49's `payRunAction` pays one supplier at a time, in a plain `for`
 * loop with no transaction around it. Its own doc comment says:
 *
 * > The ones already paid stay paid, and the message says how far it got.
 *
 * The first half is true. **The second half was not implemented.** The loop
 * accumulated `paid` and `paidCents`, and the `catch` threw both away and
 * returned `'That pay run could not be completed.'` — so a business paying
 * eight bills across four suppliers, where the third failed, was told the run
 * failed while $18,000 had already left its bank for the first two.
 *
 * That is the worst shape a failure message can take: not wrong about the
 * ledger, which was correct throughout, but wrong about **what the person now
 * has to do**. It reads as "nothing happened, try again", and the true state is
 * "two suppliers are paid, two are not, and the two that are must not be paid
 * again".
 *
 * ## What this module decides
 *
 * Given what was attempted and what came back, it decides the *status* of the
 * batch and the sentence a person reads. Nothing here touches the database, the
 * clock or the network — which is the point, because the interesting cases are
 * exactly the ones that are painful to provoke against a real one.
 *
 * ## One core for two batches
 *
 * A pay run and a remittance run are the same shape: a loop over suppliers
 * where some succeed and some do not. Phase 58 sends the advice; this phase
 * sends them per run. Writing the status rule twice would let the two drift
 * into disagreeing about what "partly worked" means, which is the two-answers
 * defect this project keeps refusing.
 */

/** Every batch here is a list of suppliers, and every one of them has a name. */
export type BatchAttempt = {
  vendorId: string
  vendorName: string
}

export type BatchFailure = {
  vendorId: string
  vendorName: string
  /** A sentence written for a person, not an exception's `message`. */
  error: string
}

/**
 * How much of the batch worked.
 *
 * `partial` exists as its own value rather than being folded into either
 * neighbour, because it is the only one that needs a person to do something and
 * the only one the previous code could not express.
 */
export type BatchStatus = 'complete' | 'partial' | 'nothing'

export function batchStatus(doneCount: number, failedCount: number): BatchStatus {
  if (doneCount === 0) return 'nothing'
  return failedCount === 0 ? 'complete' : 'partial'
}

/**
 * Whether a batch counts as having succeeded.
 *
 * **A partial batch is a success with a warning.** This is the phase's central
 * decision and it is worth stating on its own.
 *
 * Reporting a partial run as a failure is what the old code did, and it is
 * wrong in the direction that costs money: it invites the person to press the
 * button again. It is *safe* to press again — `payableQueue` only ever returns
 * bills with a balance, so a settled bill is no longer selectable and nothing
 * doubles — but a person who has been told a payment failed will also ring the
 * supplier, re-key it into the bank, or both. The screen has to say what went.
 *
 * `nothing` is the honest failure: no money moved, and the person may act on
 * that however they like.
 */
export function batchSucceeded(status: BatchStatus): boolean {
  return status !== 'nothing'
}

/** Joins names the way a person writing the sentence would. */
export function nameList(names: string[], limit = 3): string {
  if (names.length === 0) return ''
  if (names.length <= limit) {
    if (names.length === 1) return names[0]
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`
}

export type PayRunOutcome = {
  status: BatchStatus
  paid: { vendorId: string; vendorName: string; amountCents: number; billCount: number }[]
  failed: BatchFailure[]
  paidCents: number
  /** What the failed suppliers would have been paid, and still are owed. */
  unpaidCents: number
  billsSettled: number
  message: string
}

/**
 * What a pay run did, and the sentence that says so.
 *
 * The message leads with the money that moved, in every status where any did.
 * A person reading a notice after pressing "Pay" is answering one question —
 * *did the money go?* — and burying that under an apology for the supplier that
 * failed is how the old message misled.
 */
export function payRunOutcome(input: {
  paid: { vendorId: string; vendorName: string; amountCents: number; billCount: number }[]
  failed: BatchFailure[]
  /** Present only so the message can say what the unpaid suppliers were owed. */
  attemptedCentsByVendor?: Record<string, number>
}): PayRunOutcome {
  const { paid, failed } = input
  const status = batchStatus(paid.length, failed.length)

  const paidCents = paid.reduce((sum, row) => sum + row.amountCents, 0)
  const billsSettled = paid.reduce((sum, row) => sum + row.billCount, 0)
  const unpaidCents = failed.reduce(
    (sum, row) => sum + (input.attemptedCentsByVendor?.[row.vendorId] ?? 0),
    0,
  )

  const paidClause =
    `${formatCents(paidCents)} paid — ${paid.length} payment${paid.length === 1 ? '' : 's'}, ` +
    `one per supplier, settling ${billsSettled} bill${billsSettled === 1 ? '' : 's'}.`

  let message: string
  if (status === 'complete') {
    message = paidClause
  } else if (status === 'partial') {
    // Named individually rather than counted, because the person's next act is
    // to deal with each one, and a count tells them nothing about which.
    const detail = failed.map((row) => `${row.vendorName} (${row.error})`).join('; ')
    message =
      `${paidClause} ${failed.length} supplier${failed.length === 1 ? '' : 's'} could not be ` +
      `paid${unpaidCents > 0 ? `, leaving ${formatCents(unpaidCents)} still owed` : ''}: ` +
      `${detail}. The money above has gone — do not send it again.`
  } else {
    const detail = failed.map((row) => `${row.vendorName} (${row.error})`).join('; ')
    message = failed.length
      ? `Nothing was paid. ${detail}.`
      : 'Nothing was paid, because nothing was selected.'
  }

  return { status, paid, failed, paidCents, unpaidCents, billsSettled, message }
}

export type AdviseOutcome = {
  status: BatchStatus
  sent: { vendorId: string; vendorName: string; to: string }[]
  failed: BatchFailure[]
  message: string
}

/**
 * What advising a run's suppliers did, and the sentence that says so.
 *
 * Same shape and the same status rule as a pay run, deliberately. The common
 * failure here is a supplier with no address on file, which Phase 58 refuses
 * with an instruction rather than a rule — and a batch that stopped at the
 * first such supplier would leave the rest of a run silently unadvised.
 */
export function adviseOutcome(input: {
  sent: { vendorId: string; vendorName: string; to: string }[]
  failed: BatchFailure[]
}): AdviseOutcome {
  const { sent, failed } = input
  const status = batchStatus(sent.length, failed.length)

  let message: string
  if (status === 'complete') {
    message =
      `Advice sent to ${sent.length} supplier${sent.length === 1 ? '' : 's'}: ` +
      `${nameList(sent.map((row) => row.vendorName))}.`
  } else if (status === 'partial') {
    message =
      `Advice sent to ${sent.length} of ${sent.length + failed.length} suppliers. ` +
      `${nameList(failed.map((row) => row.vendorName))} could not be told — ` +
      `${failed[0].error} Use Get link on the payment to send it yourself.`
  } else {
    message = failed.length
      ? `Nobody could be told. ${failed[0].error}`
      : 'There is nobody to tell: this run paid no suppliers.'
  }

  return { status, sent, failed, message }
}
