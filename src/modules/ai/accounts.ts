/**
 * The AI Strategic Account Assistant (Phase 167, spec §11).
 *
 * ## The capability, split where it should be split
 *
 * §11 asks for four things:
 *
 * > Summarize relationship history, identify neglected high-value prospects,
 * > recommend next actions, and draft personalized outreach.
 *
 * **Three of those want a model and one does not.** Identifying a neglected
 * high-value account is `max(occurred_at)` against a cadence, a sum of
 * invoices and a weighted pipeline — arithmetic the database does exactly.
 * `crm/attention.ts` does it, has no database and no gateway in it, and works
 * with the AI module switched off, which §11 requires of the core product.
 *
 * This file is the other three. It reads the measured findings and the
 * timeline, and asks for a summary, next actions and an outreach draft.
 *
 * ## Which is why the prompt forbids re-deriving the findings
 *
 * The facts arrive already measured, and the one failure that would make this
 * assistant worse than nothing is hedging them — "it may have been some time
 * since contact" written over a fact that says nobody has ever called. The
 * model's job starts after the finding, not before it.
 *
 * ## Nothing here changes anything
 *
 * There is no `apply`. An outreach draft is text somebody edits and sends, a
 * recommendation is a sentence somebody acts on, and the only record is the
 * suggestion row and its ledger entry. Compare Phase 166, where accepting a
 * layout wrote to the document and therefore needed provenance: a draft that
 * is never stored on an artifact has nothing to disclose on one, and inventing
 * a provenance column for it would be a declaration with no artifact behind it.
 */

import { z } from 'zod'
import { type ActorContext, can } from '@/modules/tenancy/context'
import { factsForAccount } from '@/modules/crm/accounts'
import { assessAccount, type AccountAttention, type AccountFacts } from '@/modules/crm/attention'
import { organizationTimeline } from '@/modules/engagement/timeline'
import { formatCents } from '@/lib/money'
import { ask } from './gateway'
import { recordSuggestion } from './suggestions'

export const accountStrategySchema = z.object({
  /** Where the relationship stands, in a few sentences. */
  summary: z.string().max(1200),
  nextActions: z
    .array(
      z.object({
        action: z.string().max(300),
        /** The fact it follows from, so a person can disagree with the reason. */
        because: z.string().max(400),
        urgency: z.enum(['this_week', 'this_month', 'when_convenient']),
      }),
    )
    .max(5),
  outreach: z.object({
    subject: z.string().max(200),
    body: z.string().max(3000),
  }),
  confidence: z.number().int().min(0).max(10000),
})

export type AccountStrategy = z.infer<typeof accountStrategySchema>

export const accountStrategyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'nextActions', 'outreach', 'confidence'],
  properties: {
    summary: { type: 'string', maxLength: 1200 },
    nextActions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'because', 'urgency'],
        properties: {
          action: { type: 'string', maxLength: 300 },
          because: { type: 'string', maxLength: 400 },
          urgency: { type: 'string', enum: ['this_week', 'this_month', 'when_convenient'] },
        },
      },
    },
    outreach: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'body'],
      properties: {
        subject: { type: 'string', maxLength: 200 },
        body: { type: 'string', maxLength: 3000 },
      },
    },
    confidence: { type: 'integer', minimum: 0, maximum: 10000 },
  },
} as const

/** How much of the timeline the model is shown. */
const TIMELINE_ENTRIES = 12

/** One line per timeline entry, oldest of the shown window first. */
function timelineLines(entries: Awaited<ReturnType<typeof organizationTimeline>>): string {
  if (entries.length === 0) {
    // Said rather than left blank. An empty section reads as missing data; this
    // reads as the finding it is.
    return 'Nothing has been logged against this account.'
  }

  return [...entries]
    .reverse()
    .map((entry) => {
      const day = entry.at.toISOString().slice(0, 10)

      if (entry.kind === 'communication') {
        return `${day} ${entry.data.direction} ${entry.data.channel}: ${entry.data.summary}`
      }
      if (entry.kind === 'task') {
        return `${day} task (${entry.data.status}): ${entry.data.title}`
      }
      return `${day} ${entry.data.activityKind}: ${entry.data.summary}`
    })
    .join('\n')
}

function lastContactLine(facts: AccountFacts, asOf: Date): string {
  if (facts.lastContactedAt === null) return 'never — no exchange has ever been logged'

  const days = Math.floor((asOf.getTime() - facts.lastContactedAt.getTime()) / 86_400_000)
  return `${facts.lastContactedAt.toISOString().slice(0, 10)} (${days} days ago)`
}

export type StrategyRefusal =
  | 'permission'
  | 'not_found'
  | 'nothing_to_advise'
  | 'disabled'
  | 'feature_disabled'
  | 'ceiling'
  | 'rate_limit'
  | 'provider_error'
  | 'invalid_output'

/**
 * Summarizes a relationship, recommends next actions, and drafts outreach.
 *
 * Refuses before the gateway when the account is not flagged at all. An
 * assistant asked to write a strategy for a relationship with nothing wrong
 * with it has nothing to say that is worth a provider call, and the honest
 * answer — "this account is fine" — is one the attention list already gives
 * for free.
 */
export async function adviseOnAccount(
  ctx: ActorContext,
  organizationId: string,
  asOf: Date = new Date(),
) {
  if (!can(ctx, 'crm:manage')) {
    return {
      ok: false as const,
      message: 'Your role does not include managing client relationships.',
      reason: 'permission' as StrategyRefusal,
    }
  }

  const facts = await factsForAccount(ctx, organizationId, asOf)

  if (!facts) {
    return {
      ok: false as const,
      message: 'That account was not found.',
      reason: 'not_found' as StrategyRefusal,
    }
  }

  const attention: AccountAttention | null = assessAccount(facts, asOf)

  if (!attention) {
    return {
      ok: false as const,
      message:
        `Nothing is outstanding on ${facts.name} — it is not on the attention list, so there is ` +
        'no neglect to advise on. Asking anyway would spend a request to be told the same thing.',
      reason: 'nothing_to_advise' as StrategyRefusal,
    }
  }

  const timeline = await organizationTimeline(ctx, organizationId, TIMELINE_ENTRIES)

  const proposal = facts.oldestUndecidedProposal

  const result = await ask(ctx, {
    feature: 'strategic_account',
    promptKey: 'account.strategy',
    values: {
      accountName: facts.name,
      lifecycleStage: facts.lifecycleStage.replace('_', ' '),
      strategicNote: facts.isStrategicAccount ? ', strategic account' : '',
      ownerNote: facts.ownerId ? 'assigned' : 'nobody — this account has no owner',
      lastContact: lastContactLine(facts, asOf),
      invoiced: formatCents(facts.invoicedCents),
      pipeline:
        facts.openOpportunities === 0
          ? 'nothing open'
          : `${formatCents(facts.weightedPipelineCents)} across ${facts.openOpportunities}`,
      proposalNote: proposal
        ? `\nOutstanding proposal: sent ${proposal.sentAt.toISOString().slice(0, 10)}, ${proposal.viewed ? 'read' : 'never opened'}`
        : '',
      findings: attention.findings
        .map((finding) => `- ${finding.label} (${finding.severity}): ${finding.detail}`)
        .join('\n'),
      timeline: timelineLines(timeline),
    },
    input: {
      accountName: facts.name,
      lifecycleStage: facts.lifecycleStage,
      isStrategicAccount: facts.isStrategicAccount,
      hasOwner: facts.ownerId !== null,
      silentDays: attention.silentDays,
      invoicedCents: facts.invoicedCents,
      weightedPipelineCents: facts.weightedPipelineCents,
      openOpportunities: facts.openOpportunities,
      stakeCents: attention.stakeCents,
      findings: attention.findings,
      timelineEntries: timeline.length,
    },
    schema: accountStrategySchema,
    jsonSchema: accountStrategyJsonSchema,
    maxOutputTokens: 3000,
    effort: 'high',
  })

  if (!result.ok) {
    return { ok: false as const, message: result.message, reason: result.reason as StrategyRefusal }
  }

  const suggestion = await recordSuggestion(ctx, {
    feature: 'strategic_account',
    requestId: result.requestId,
    entityType: 'organization',
    entityId: organizationId,
    payload: result.data as unknown as Record<string, unknown>,
    confidenceBp: result.data.confidence,
    rationale: result.data.summary.slice(0, 1000),
  })

  return {
    ok: true as const,
    suggestion,
    attention,
    strategy: result.data,
    requestId: result.requestId,
  }
}
