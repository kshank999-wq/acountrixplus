import type { opportunityStageEnum } from '@/db/schema'
import { DomainError } from '@/modules/errors'

/**
 * The opportunity pipeline (spec §6).
 *
 * Stage rules live here as pure functions so they can be reasoned about and
 * tested without a database, the same way rule matching works in bookkeeping.
 */

export type Stage = (typeof opportunityStageEnum.enumValues)[number]

/** Stages in the order spec §6 lists them, with display labels. */
export const PIPELINE_STAGES: Array<{ key: Stage; label: string; isTerminal: boolean }> = [
  { key: 'new_inquiry', label: 'New inquiry', isTerminal: false },
  { key: 'qualified', label: 'Qualified', isTerminal: false },
  { key: 'proposal_draft', label: 'Proposal draft', isTerminal: false },
  { key: 'proposal_sent', label: 'Proposal sent', isTerminal: false },
  { key: 'viewed', label: 'Viewed', isTerminal: false },
  { key: 'follow_up', label: 'Follow-up', isTerminal: false },
  { key: 'negotiation', label: 'Negotiation', isTerminal: false },
  { key: 'won', label: 'Won', isTerminal: true },
  { key: 'lost', label: 'Lost', isTerminal: true },
  { key: 'dormant', label: 'Dormant', isTerminal: true },
]

/** Stages that end the opportunity's active life. */
export const TERMINAL_STAGES: ReadonlySet<Stage> = new Set<Stage>(['won', 'lost', 'dormant'])

/** Stages still moving through the pipeline — what "open" means for forecasts. */
export const OPEN_STAGES: Stage[] = PIPELINE_STAGES.filter((s) => !s.isTerminal).map(
  (s) => s.key,
)

export function isTerminal(stage: Stage): boolean {
  return TERMINAL_STAGES.has(stage)
}

export function stageLabel(stage: Stage): string {
  return PIPELINE_STAGES.find((s) => s.key === stage)?.label ?? stage
}

/** Position in the pipeline, used to tell forward moves from backward ones. */
export function stageIndex(stage: Stage): number {
  return PIPELINE_STAGES.findIndex((s) => s.key === stage)
}

/**
 * Default probability for a stage, used when the user has not set one.
 *
 * These are starting points a salesperson overrides, not predictions. Won and
 * lost are certainties rather than estimates.
 */
export const STAGE_PROBABILITY: Record<Stage, number> = {
  new_inquiry: 10,
  qualified: 25,
  proposal_draft: 40,
  proposal_sent: 50,
  viewed: 60,
  follow_up: 65,
  negotiation: 80,
  won: 100,
  lost: 0,
  dormant: 0,
}

/** Raised when a stage change is not allowed. */
export class InvalidStageTransitionError extends DomainError {
  readonly status = 422
  constructor(
    readonly from: Stage,
    readonly to: Stage,
    reason: string,
  ) {
    super(`Cannot move from ${stageLabel(from)} to ${stageLabel(to)}: ${reason}`)
    this.name = 'InvalidStageTransitionError'
  }
}

/**
 * Whether a stage change is allowed.
 *
 * The pipeline is deliberately permissive about moving backwards — deals stall
 * and reopen, and a tool that refuses to record that just gets worked around.
 * What it does refuse is leaving a closed deal by changing its stage: a won
 * opportunity has created a client and a job, and a lost one may already have
 * been handed to marketing, so unwinding those is an explicit reopen rather
 * than a quiet edit.
 */
export function assertStageTransition(from: Stage, to: Stage): void {
  if (from === to) return

  if (isTerminal(from)) {
    throw new InvalidStageTransitionError(
      from,
      to,
      'this opportunity is already closed. Reopen it first.',
    )
  }
}

/** Whether closing into this stage requires a loss reason (spec §6). */
export function requiresLossReason(stage: Stage): boolean {
  return stage === 'lost' || stage === 'dormant'
}

/**
 * Weighted value of an open opportunity — expected value times probability.
 *
 * Rounded to whole cents so a forecast total is still an exact sum of integer
 * amounts rather than accumulating fractions.
 */
export function weightedValueCents(expectedValueCents: number, probability: number): number {
  return Math.round((expectedValueCents * probability) / 100)
}
