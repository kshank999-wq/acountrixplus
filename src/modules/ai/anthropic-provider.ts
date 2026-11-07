import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  ModelPricing,
} from './provider'

/**
 * Anthropic adapter (spec §12).
 *
 * The SDK is loaded through a dynamic import inside `complete`, so nothing
 * Anthropic-specific is evaluated unless a company has actually selected this
 * provider. Spec §23 requires the core product to work without AI; an
 * unconfigured deployment should not so much as parse a vendor SDK.
 *
 * The API key is read from the environment on the server and never leaves it
 * (spec §12, §19). It is not passed to a client component, not returned by any
 * route, and not written to the usage ledger.
 */

const DEFAULT_MODEL = 'claude-opus-5'

/**
 * Why `cachedInputTokens` is always zero, and why that is not a defect
 * (Phase 194).
 *
 * §12 asks for *"caching where safe"*. `provider.ts` prices a cache read, the
 * gateway records it and the usage ledger carries it — and
 * `response.usage.cache_read_input_tokens` has never been anything but zero,
 * because **nothing sets `cache_control`**. That looks exactly like Phase
 * 160's shape: a capability installed and inert, waiting for one line.
 *
 * It is not, and the measurement is the reason. Prompt caching needs a stable
 * prefix of at least the model's minimum — 1024 tokens on this family — and
 * **below it the request silently does not cache**. Measured:
 *
 * | | tokens |
 * | --- | --- |
 * | every system prompt in `prompts.ts` | 230–631 |
 * | the minimum for `claude-opus-5` | 1024 |
 *
 * So a `cache_control` on the system prompt would cache nothing and read
 * zero, which is what it reads now — the no-op would be indistinguishable
 * from the absence, and the next person to measure would find the same zero
 * with a line of code claiming otherwise. The retrieval context is no help
 * either: it is rendered into the *user* message and differs per request, so
 * there is no stable prefix to cache.
 *
 * The pricing path is therefore correct, correctly reads zero, and starts
 * paying the moment a prompt grows past the threshold. **The thing to measure
 * before adding `cache_control` is the prompt length, not the code.**
 */

/**
 * Published prices per million tokens, in millionths of a dollar.
 *
 * Cost is an *estimate* recorded for metering, not an invoice. If a price
 * changes, historic ledger rows keep the figure computed at the time, which is
 * the honest thing for a usage record to do.
 */
const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': {
    inputPerMillionMicros: 5_000_000,
    outputPerMillionMicros: 25_000_000,
    cachedInputPerMillionMicros: 500_000,
  },
  /*
    Corrected in Phase 194, against the published price list rather than
    against memory.

    These were $3 / $15 with a $0.30 cache read, which is **the increase that
    was cancelled**. The pricing page says it plainly: the $2 / $10 announced
    at launch as introductory pricing through 31 August 2026 *"is now the
    standard price. The previously scheduled increase to $3/$15 per million
    input/output tokens on September 1, 2026 will not occur."*

    So every Sonnet request this application metered recorded a cost estimate
    half again as large as the real one — in the ledger §12 asks for *"for
    billing and monitoring"*, which is the one number here whose only job is
    to be right. Nothing errored and nothing looked wrong, because a price is
    a constant nobody re-reads.
  */
  'claude-sonnet-5': {
    inputPerMillionMicros: 2_000_000,
    outputPerMillionMicros: 10_000_000,
    cachedInputPerMillionMicros: 200_000,
  },
  'claude-haiku-4-5': {
    inputPerMillionMicros: 1_000_000,
    outputPerMillionMicros: 5_000_000,
    cachedInputPerMillionMicros: 100_000,
  },
}

const EMPTY_USAGE: CompletionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }

export class AnthropicProvider implements AiProvider {
  readonly key = 'anthropic'
  readonly defaultModel = DEFAULT_MODEL

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY)
  }

  pricing(model: string): ModelPricing {
    return PRICING[model] ?? PRICING[DEFAULT_MODEL]
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model || DEFAULT_MODEL

    if (!this.isConfigured()) {
      return {
        ok: false,
        kind: 'error',
        message: 'ANTHROPIC_API_KEY is not set. The AI module cannot reach a provider.',
        model,
        usage: EMPTY_USAGE,
        retryable: false,
      }
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic()

      const response = await client.messages.create({
        model,
        max_tokens: request.maxOutputTokens ?? 4096,
        system: request.system,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: request.effort ?? 'medium',
          // Spec §12 requires structured outputs validated before use. The
          // schema is enforced by the API here *and* re-validated by the
          // gateway — a provider guarantee is not a reason to skip our own
          // check, because the next adapter may not offer one.
          format: { type: 'json_schema', schema: request.schema },
        },
        messages: [{ role: 'user', content: request.prompt }],
      })

      const usage: CompletionUsage = {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      }

      // A refusal is a successful HTTP response with an empty or partial
      // body, so `stop_reason` has to be checked before reading content.
      if (response.stop_reason === 'refusal') {
        return {
          ok: false,
          kind: 'refused',
          message: 'The model declined this request.',
          model: response.model ?? model,
          usage,
          retryable: false,
        }
      }

      // Narrowed by checking the discriminant rather than a predicate, so a
      // future block type the SDK adds is skipped instead of miscast.
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')

      if (!text.trim()) {
        return {
          ok: false,
          kind: 'invalid_output',
          message:
            response.stop_reason === 'max_tokens'
              ? 'The response was cut off before it was complete.'
              : 'The provider returned no content.',
          model: response.model ?? model,
          usage,
          retryable: response.stop_reason === 'max_tokens',
        }
      }

      try {
        return { ok: true, output: JSON.parse(text), model: response.model ?? model, usage }
      } catch {
        return {
          ok: false,
          kind: 'invalid_output',
          message: 'The provider returned something that was not valid JSON.',
          model: response.model ?? model,
          usage,
          retryable: true,
        }
      }
    } catch (error) {
      // Never let a provider message carry a key or a prompt into the ledger.
      const message = error instanceof Error ? error.message : 'Unknown provider error'
      const status = (error as { status?: number })?.status

      return {
        ok: false,
        kind: 'error',
        message: message.slice(0, 300),
        model,
        usage: EMPTY_USAGE,
        retryable: status === 429 || (typeof status === 'number' && status >= 500),
      }
    }
  }
}
