'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  acceptCategorization,
  acceptRule,
  reviewAnomalies,
  suggestCategory,
  suggestRule,
  summarizeInbox,
} from '@/modules/ai/bookkeeping'
import {
  businessInsights,
  draftCampaignCopy,
  draftProposalSections,
  explainReconciliation,
} from '@/modules/ai/assistants'
import { adviseOnAccount } from '@/modules/ai/accounts'
import { applyLayoutSuggestion, suggestLayout } from '@/modules/ai/design'
import { rejectSuggestion } from '@/modules/ai/suggestions'
import { updateSettings } from '@/modules/ai/settings'
import { activatePromptVersion, savePromptVersion } from '@/modules/ai/prompts'
import { messageFor, Refusal } from '@/modules/errors'

/**
 * Server actions for the AI module.
 *
 * Thin, like every other action file: resolve the actor, call one service.
 * All the interesting rules — permission, quota, validation, approval — live
 * in `modules/ai`, so nothing here can bypass them by accident.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(
  path: string | string[],
  fn: () => Promise<string | void>,
): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const entry of Array.isArray(path) ? path : [path]) revalidatePath(entry)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Something went wrong.'),
    }
  }
}

// --- Bookkeeping assistant -------------------------------------------------

export type CategorySuggestionResult =
  | {
      ok: true
      suggestionId: string
      accountId: string
      accountName: string
      accountNumber: string
      confidenceBp: number
      rationale: string
    }
  | { ok: false; error: string }

export async function suggestCategoryAction(
  transactionId: string,
): Promise<CategorySuggestionResult> {
  try {
    const actor = await requireActor()
    const result = await suggestCategory(actor, transactionId)

    if (!result.ok) return { ok: false, error: result.message }

    return {
      ok: true,
      suggestionId: result.suggestionId,
      accountId: result.account.id,
      accountName: result.account.name,
      accountNumber: result.account.number,
      confidenceBp: result.confidenceBp,
      rationale: result.rationale,
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

export async function acceptCategorizationAction(suggestionId: string): Promise<ActionResult> {
  return run('/bookkeeping', async () => {
    const actor = await requireActor()
    await acceptCategorization(actor, suggestionId)
    return 'Categorized.'
  })
}

export async function rejectSuggestionAction(suggestionId: string): Promise<ActionResult> {
  return run(['/bookkeeping', '/ai'], async () => {
    const actor = await requireActor()
    await rejectSuggestion(actor, suggestionId)
    return 'Dismissed.'
  })
}

// --- Strategic account assistant (spec §11) --------------------------------

export type AccountAdviceResult =
  | {
      ok: true
      suggestionId: string
      summary: string
      nextActions: Array<{ action: string; because: string; urgency: string }>
      outreach: { subject: string; body: string }
      confidenceBp: number
      /** The measured findings the advice was given, so the panel can show both. */
      findings: Array<{ label: string; severity: string; detail: string }>
    }
  | { ok: false; error: string }

export async function adviseOnAccountAction(
  organizationId: string,
): Promise<AccountAdviceResult> {
  try {
    const actor = await requireActor()
    const result = await adviseOnAccount(actor, organizationId)

    if (!result.ok) return { ok: false, error: result.message }

    return {
      ok: true,
      suggestionId: result.suggestion.id,
      summary: result.strategy.summary,
      nextActions: result.strategy.nextActions,
      outreach: result.strategy.outreach,
      confidenceBp: result.strategy.confidence,
      findings: result.attention.findings.map((finding) => ({
        label: finding.label,
        severity: finding.severity,
        detail: finding.detail,
      })),
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The account assistant is unavailable.'),
    }
  }
}

// --- Design assistant (spec §11) -------------------------------------------

/**
 * The paths a document edit can have been reached from.
 *
 * Same list `studio.ts` keeps, and for the same reason it gives: one designer
 * serves proposals and marketing creative, and the action cannot tell which
 * list the author came from.
 */
const DESIGN_PATHS = ['/crm/proposals', '/marketing/creative']

export type LayoutSuggestionResult =
  | {
      ok: true
      suggestionId: string
      /** Block ids in the order proposed, so the panel can show the move. */
      order: string[]
      rationale: string
      /** §11's "image prompts": text for a person, never an image. */
      imagePrompts: string[]
      confidenceBp: number
    }
  | { ok: false; error: string }

export async function suggestLayoutAction(documentId: string): Promise<LayoutSuggestionResult> {
  try {
    const actor = await requireActor()
    const result = await suggestLayout(actor, documentId)

    if (!result.ok) return { ok: false, error: result.message }

    return {
      ok: true,
      suggestionId: result.suggestion.id,
      order: result.data.order,
      rationale: result.data.rationale,
      /*
        `?? []` rather than trusting the Zod default: `ask` is generic over
        `z.ZodType<T>`, which in Zod 3 pins input and output to the same `T`,
        so a defaulted field reads as possibly-undefined on the way out even
        though parsing has already filled it. The coalesce is the honest
        reading of the type the gateway hands back, not a second default.
      */
      imagePrompts: result.data.imagePrompts ?? [],
      confidenceBp: result.data.confidence,
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The design assistant is unavailable.'),
    }
  }
}

export async function applyLayoutSuggestionAction(suggestionId: string): Promise<ActionResult> {
  return run(DESIGN_PATHS, async () => {
    const actor = await requireActor()
    const result = await applyLayoutSuggestion(actor, suggestionId)

    /*
      `applyLayoutSuggestion` returns a refusal rather than throwing, because
      the two it can give — no ledger row behind the suggestion, and a result
      that would not validate — are sentences a person can act on (Phase 119)
      and not defects. `run` only turns thrown errors into messages, so the
      refusal is raised here to reach the same place.
    */
    if (!result.ok) throw new Refusal(result.message)

    return 'Layout applied. The document now records that it was laid out with AI assistance.'
  })
}

export type RuleSuggestionResult =
  | {
      ok: true
      suggestionId: string
      name: string
      field: string
      operator: string
      value: string
      action: string
      accountName: string
      rationale: string
    }
  | { ok: false; error: string }

export async function suggestRuleAction(transactionId: string): Promise<RuleSuggestionResult> {
  try {
    const actor = await requireActor()
    const result = await suggestRule(actor, transactionId)

    if (!result.ok) return { ok: false, error: result.message }

    return {
      ok: true,
      suggestionId: result.suggestionId,
      name: result.rule.name,
      field: result.rule.field,
      operator: result.rule.operator,
      value: result.rule.value,
      action: result.rule.action,
      accountName: result.accountName,
      rationale: result.rule.rationale,
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

export async function acceptRuleAction(suggestionId: string): Promise<ActionResult> {
  return run('/bookkeeping', async () => {
    const actor = await requireActor()
    const created = await acceptRule(actor, suggestionId)
    // `createRule` also applies the new rule to the existing inbox, and how
    // many it caught is the number the user actually wants to see.
    const applied = created.applied.autoCategorized + created.applied.suggested
    return applied > 0
      ? `Rule "${created.rule.name}" created — it categorized ${applied} waiting transaction${applied === 1 ? '' : 's'}.`
      : `Rule "${created.rule.name}" created.`
  })
}

export type SummaryResult =
  | { ok: true; summary: string; suggestedNextStep: string }
  | { ok: false; error: string }

export async function summarizeInboxAction(): Promise<SummaryResult> {
  try {
    const actor = await requireActor()
    const result = await summarizeInbox(actor)

    return result.ok
      ? { ok: true, summary: result.summary, suggestedNextStep: result.suggestedNextStep }
      : { ok: false, error: result.message }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

export type AnomalyResult =
  | {
      ok: true
      findings: Array<{
        kind: string
        severity: string
        explanation: string
        transactions: Array<{ id: string; postedDate: string; description: string; amountCents: number }>
      }>
      message: string | null
    }
  | { ok: false; error: string }

export async function reviewAnomaliesAction(): Promise<AnomalyResult> {
  try {
    const actor = await requireActor()
    const result = await reviewAnomalies(actor)

    if (!result.ok) return { ok: false, error: result.message }

    return {
      ok: true,
      message: result.message,
      findings: result.findings.map((finding) => ({
        kind: finding.kind,
        severity: finding.severity,
        explanation: finding.explanation,
        transactions: finding.transactions.map((row) => ({
          id: row.id,
          postedDate: row.postedDate,
          description: row.merchantName ?? row.description,
          amountCents: row.amountCents,
        })),
      })),
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

// --- The other assistants --------------------------------------------------

export type ReconciliationHelpResult =
  | {
      ok: true
      explanation: string
      likelyCauses: string[]
      suggested: Array<{ id: string; postedDate: string; description: string; amountCents: number }>
    }
  | { ok: false; error: string }

export async function explainReconciliationAction(
  reconciliationId: string,
): Promise<ReconciliationHelpResult> {
  try {
    const actor = await requireActor()
    const result = await explainReconciliation(actor, reconciliationId)

    if (!result.ok) return { ok: false, error: result.message }

    return {
      ok: true,
      explanation: result.explanation,
      likelyCauses: result.likelyCauses,
      suggested: result.suggested.map((row) => ({
        id: row.id,
        postedDate: row.postedDate,
        description: row.merchantName ?? row.description,
        amountCents: row.amountCents,
      })),
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

export type ProposalDraftResult =
  | {
      ok: true
      suggestionId: string
      executiveSummary: string
      scope: string
      exclusions: string
      followUpMessage: string
    }
  | { ok: false; error: string }

export async function draftProposalAction(opportunityId: string): Promise<ProposalDraftResult> {
  try {
    const actor = await requireActor()
    const result = await draftProposalSections(actor, opportunityId)

    if (!result.ok) return { ok: false, error: result.message }

    return { ok: true, suggestionId: result.suggestionId, ...result.draft }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

export type CampaignDraftResult =
  | {
      ok: true
      suggestionId: string
      subject: string
      previewText: string
      headline: string
      body: string
      callToAction: string
      rationale: string
    }
  | { ok: false; error: string }

export async function draftCampaignAction(input: {
  segmentId?: string
  goal: string
}): Promise<CampaignDraftResult> {
  try {
    const actor = await requireActor()
    const result = await draftCampaignCopy(actor, {
      segmentId: input.segmentId || null,
      goal: input.goal.trim() || 'start a conversation',
    })

    if (!result.ok) return { ok: false, error: result.message }

    return { ok: true, suggestionId: result.suggestionId, ...result.draft }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

export type InsightsResult =
  | {
      ok: true
      insights: Array<{ title: string; detail: string; severity: string; metric: string }>
    }
  | { ok: false; error: string }

export async function businessInsightsAction(): Promise<InsightsResult> {
  try {
    const actor = await requireActor()
    const result = await businessInsights(actor)

    return result.ok
      ? { ok: true, insights: result.insights }
      : { ok: false, error: result.message }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The assistant is unavailable.'),
    }
  }
}

// --- Administration --------------------------------------------------------

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().trim().optional(),
  model: z.string().trim().optional(),
  /** Entered in dollars; stored in millionths of one. */
  monthlyCeilingDollars: z.coerce.number().min(0).max(100_000).optional(),
  hourlyRequestLimit: z.coerce.number().int().min(1).max(10_000).optional(),
  disabledFeatures: z.array(z.string()).optional(),
})

export async function updateAiSettingsAction(
  input: z.input<typeof settingsSchema>,
): Promise<ActionResult> {
  return run('/ai', async () => {
    const actor = await requireActor()
    const parsed = settingsSchema.parse(input)

    await updateSettings(actor, {
      enabled: parsed.enabled,
      provider: parsed.provider,
      model: parsed.model,
      monthlyCeilingMicros:
        parsed.monthlyCeilingDollars === undefined
          ? undefined
          : Math.round(parsed.monthlyCeilingDollars * 1_000_000),
      hourlyRequestLimit: parsed.hourlyRequestLimit,
      disabledFeatures: parsed.disabledFeatures,
    })

    return 'Settings saved.'
  })
}

export async function savePromptAction(input: {
  key: string
  systemPrompt: string
  template: string
  notes?: string
}): Promise<ActionResult> {
  return run('/ai/prompts', async () => {
    const actor = await requireActor()
    const saved = await savePromptVersion(actor, input)
    return `Version ${saved.version} saved and activated.`
  })
}

export async function activatePromptAction(
  key: string,
  version: number | null,
): Promise<ActionResult> {
  return run('/ai/prompts', async () => {
    const actor = await requireActor()
    await activatePromptVersion(actor, key, version)
    return version === null
      ? 'Rolled back to the built-in prompt.'
      : `Version ${version} is now active.`
  })
}
