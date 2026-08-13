import { z } from 'zod'
import { db } from '@/db'
import { aiRequests } from '@/db/schema'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { estimateCostMicros, type CompletionResult } from './provider'
import { getAiProvider } from './registry'
import { renderTemplate, resolvePrompt } from './prompts'
import { checkGate } from './settings'

/**
 * The AI gateway (spec §12).
 *
 * Every AI call in the application goes through this one function. Nothing
 * else in the codebase imports a provider, and that is the point: permission,
 * quota, cost ceiling, prompt resolution, schema validation, and metering all
 * happen in one place, so none of them can be forgotten at a call site.
 *
 * The order below is the design, and it is deliberate:
 *
 *   1. Permission — does this *person* have the right to use AI at all?
 *   2. Gate — is the module on, the feature enabled, the ceiling unspent,
 *      the rate limit unbroken?
 *   3. Prompt — which version, from the registry.
 *   4. Provider — the only step that leaves the building.
 *   5. Validate — the output must satisfy the schema before anyone sees it.
 *   6. Meter — a ledger row, whatever happened.
 *
 * Steps 1 and 2 come before step 4 so a blocked call costs nothing. Step 6
 * happens on every path, including the blocked ones, because "why did nothing
 * happen" is a question the usage ledger should be able to answer.
 */

export type AiFeature =
  | 'bookkeeping_categorize'
  | 'bookkeeping_anomalies'
  | 'bookkeeping_rule'
  | 'bookkeeping_summary'
  | 'reconciliation_explain'
  | 'proposal_draft'
  | 'marketing_draft'
  | 'business_insights'

export type AskInput<T> = {
  feature: AiFeature
  /** Prompt registry key, e.g. 'bookkeeping.categorize'. */
  promptKey: string
  /** Values for the template's `{{placeholders}}`. */
  values: Record<string, string>
  /** The same data, structured, for adapters that can use it. */
  input: Record<string, unknown>
  /** Zod schema the output must satisfy — the contract with the model. */
  schema: z.ZodType<T>
  /** JSON Schema form of the same contract, sent to the provider. */
  jsonSchema: Record<string, unknown>
  maxOutputTokens?: number
  effort?: 'low' | 'medium' | 'high'
}

export type AskResult<T> =
  | { ok: true; data: T; requestId: string | null; costMicros: number; model: string }
  | { ok: false; requestId: string | null; message: string; reason: AskFailure }

export type AskFailure =
  | 'permission'
  | 'disabled'
  | 'feature_disabled'
  | 'ceiling'
  | 'rate_limit'
  | 'provider_error'
  | 'refused'
  | 'invalid_output'

export async function ask<T>(ctx: ActorContext, input: AskInput<T>): Promise<AskResult<T>> {
  // 1. Permission. A person who may not use AI never reaches a provider, and
  //    the attempt is not worth a ledger row either — nothing was spent and
  //    nothing was proposed.
  requirePermission(ctx, 'ai:use')

  // 2. Gate.
  const gate = await checkGate(ctx.companyId, input.feature)

  if (!gate.allowed) {
    const requestId = await meter(ctx, input, {
      provider: '-',
      model: '-',
      outcome: gate.reason === 'disabled' ? 'blocked_disabled' : 'blocked_quota',
      detail: gate.message,
      promptVersion: 0,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      costMicros: 0,
      latencyMs: 0,
    })

    return { ok: false, requestId, message: gate.message, reason: gate.reason }
  }

  // 3. Prompt.
  const prompt = await resolvePrompt(ctx.companyId, input.promptKey)
  const provider = getAiProvider(gate.settings.provider)
  const model = gate.settings.model || provider.defaultModel

  // 4. Provider.
  const startedAt = Date.now()
  let result: CompletionResult

  try {
    result = await provider.complete({
      feature: input.feature,
      system: prompt.systemPrompt,
      prompt: renderTemplate(prompt.template, input.values),
      input: input.input,
      schema: input.jsonSchema,
      model,
      maxOutputTokens: input.maxOutputTokens,
      effort: input.effort,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The provider failed.'
    const requestId = await meter(ctx, input, {
      provider: provider.key,
      model,
      outcome: 'provider_error',
      detail: message.slice(0, 300),
      promptVersion: prompt.version,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      costMicros: 0,
      latencyMs: Date.now() - startedAt,
    })

    return { ok: false, requestId, message, reason: 'provider_error' }
  }

  const latencyMs = Date.now() - startedAt
  const costMicros = estimateCostMicros(result.usage, provider.pricing(model))

  if (!result.ok) {
    const requestId = await meter(ctx, input, {
      provider: provider.key,
      model: result.model,
      outcome: result.kind === 'refused' ? 'refused' : result.kind === 'invalid_output' ? 'invalid_output' : 'provider_error',
      detail: result.message,
      promptVersion: prompt.version,
      usage: result.usage,
      costMicros,
      latencyMs,
    })

    return {
      ok: false,
      requestId,
      message: result.message,
      reason: result.kind === 'refused' ? 'refused' : result.kind === 'invalid_output' ? 'invalid_output' : 'provider_error',
    }
  }

  // 5. Validate. Spec §12: "Structured outputs (JSON schemas) ... validate
  //    before use." A provider that enforces the schema itself does not
  //    excuse us from checking — the next adapter may not, and a malformed
  //    suggestion reaching the approval queue looks to the reviewer like
  //    something the application meant to say.
  const parsed = input.schema.safeParse(result.output)

  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? 'Output did not match the expected shape.'
    const requestId = await meter(ctx, input, {
      provider: provider.key,
      model: result.model,
      outcome: 'invalid_output',
      detail: detail.slice(0, 300),
      promptVersion: prompt.version,
      usage: result.usage,
      costMicros,
      latencyMs,
    })

    return {
      ok: false,
      requestId,
      message: 'The assistant returned something unusable. Nothing has been changed.',
      reason: 'invalid_output',
    }
  }

  // 6. Meter.
  const requestId = await meter(ctx, input, {
    provider: provider.key,
    model: result.model,
    outcome: 'ok',
    detail: null,
    promptVersion: prompt.version,
    usage: result.usage,
    costMicros,
    latencyMs,
  })

  return { ok: true, data: parsed.data, requestId, costMicros, model: result.model }
}

type MeterInput = {
  provider: string
  model: string
  outcome: 'ok' | 'invalid_output' | 'provider_error' | 'refused' | 'blocked_quota' | 'blocked_disabled'
  detail: string | null
  promptVersion: number
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
  costMicros: number
  latencyMs: number
}

/**
 * Writes the usage ledger row (spec §12).
 *
 * Never throws. A metering failure must not turn a working suggestion into an
 * error the user sees — the ledger is for billing and monitoring, and losing
 * one row is a smaller problem than losing the answer.
 */
async function meter<T>(
  ctx: ActorContext,
  input: AskInput<T>,
  meta: MeterInput,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(aiRequests)
      .values({
        companyId: ctx.companyId,
        userId: ctx.userId,
        feature: input.feature,
        promptKey: input.promptKey,
        promptVersion: meta.promptVersion,
        provider: meta.provider,
        model: meta.model,
        inputTokens: meta.usage.inputTokens,
        outputTokens: meta.usage.outputTokens,
        cachedInputTokens: meta.usage.cachedInputTokens,
        costMicros: meta.costMicros,
        latencyMs: meta.latencyMs,
        outcome: meta.outcome,
        detail: meta.detail,
      })
      .returning({ id: aiRequests.id })

    return row?.id ?? null
  } catch {
    return null
  }
}
