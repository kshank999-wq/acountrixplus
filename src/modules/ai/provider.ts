/**
 * AI provider abstraction (spec §12: "Create an internal AI Gateway service
 * rather than calling a model provider directly from the client application").
 *
 * The fifth abstraction of this shape in the codebase, after the bank
 * provider, the asset store, and the email provider. The domain talks only to
 * this interface, so selecting a different model vendor by capability, price,
 * or plan — which §12 asks for explicitly — is a registry lookup, not a
 * rewrite.
 *
 * Two things are deliberately *not* the adapter's job:
 *
 *  - **Deciding whether a call is allowed.** Permission, quota, and the cost
 *    ceiling are enforced in the gateway before an adapter is reached, so a
 *    misconfigured adapter cannot spend money it should not have.
 *  - **Validating the output.** The gateway parses and schema-checks every
 *    response, so an adapter that returns nonsense produces a recorded
 *    failure rather than a bad suggestion.
 */

export type CompletionRequest = {
  /** Which capability is calling. Lets an adapter route by cost or model. */
  feature: string
  /** What the model is told about its role. From the prompt registry. */
  system: string
  /** The filled-in instruction. Also from the registry. */
  prompt: string
  /**
   * The structured data that was rendered into `prompt`.
   *
   * A real adapter ignores this — the prompt already says everything. The
   * mock adapter reads it to compute a deterministic answer without a model,
   * which is what lets the demo and the whole test suite run with no
   * credentials and no network.
   */
  input: Record<string, unknown>
  /**
   * JSON Schema the response must satisfy.
   *
   * Spec §12 requires structured outputs for suggestions and actions. An
   * adapter that cannot constrain output must still return JSON matching this
   * shape or report an error — the gateway validates either way.
   */
  schema: Record<string, unknown>
  /** Model id, or empty for the adapter's default. */
  model?: string
  maxOutputTokens?: number
  /**
   * How hard to think. The gateway maps a feature's needs onto this rather
   * than each caller picking a number.
   */
  effort?: 'low' | 'medium' | 'high'
}

export type CompletionUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export type CompletionResult =
  | {
      ok: true
      /** Parsed JSON, still to be schema-validated by the gateway. */
      output: unknown
      model: string
      usage: CompletionUsage
    }
  | {
      ok: false
      /** `refused` is a model declining; `error` is everything else. */
      kind: 'refused' | 'error' | 'invalid_output'
      message: string
      model: string
      usage: CompletionUsage
      retryable: boolean
    }

/** Per-million-token prices, in millionths of a dollar (see the ledger). */
export type ModelPricing = {
  inputPerMillionMicros: number
  outputPerMillionMicros: number
  /** Cached input is billed at a fraction of the input rate. */
  cachedInputPerMillionMicros: number
}

export interface AiProvider {
  readonly key: string
  /** The model used when a company has not chosen one. */
  readonly defaultModel: string
  /** Whether this adapter can actually run — credentials present, and so on. */
  isConfigured(): boolean
  pricing(model: string): ModelPricing
  complete(request: CompletionRequest): Promise<CompletionResult>
}

/**
 * Cost for one call, in millionths of a dollar.
 *
 * Integer arithmetic throughout: prices are quoted per million tokens, so
 * `tokens × pricePerMillion ÷ 1,000,000` is exact for whole-dollar prices and
 * rounds predictably for the rest. Same discipline as money elsewhere in the
 * codebase — no floats reach a stored figure.
 */
export function estimateCostMicros(usage: CompletionUsage, pricing: ModelPricing): number {
  const billableInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens)

  return (
    Math.round((billableInput * pricing.inputPerMillionMicros) / 1_000_000) +
    Math.round((usage.cachedInputTokens * pricing.cachedInputPerMillionMicros) / 1_000_000) +
    Math.round((usage.outputTokens * pricing.outputPerMillionMicros) / 1_000_000)
  )
}

/** Millionths of a dollar as something a person can read. */
export function formatMicros(micros: number): string {
  if (micros === 0) return '$0.00'
  const dollars = micros / 1_000_000
  if (dollars < 0.01) return '<$0.01'
  return `$${dollars.toFixed(2)}`
}
