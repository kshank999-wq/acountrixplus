import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '@/modules/ai/anthropic-provider'
import { estimateCostMicros, formatMicros } from '@/modules/ai/provider'
import { BUILT_IN_PROMPTS } from '@/modules/ai/prompts'

/**
 * The price that never rose (Phase 194, spec §12).
 *
 * ADR 0193 nominated the audit itself: `docs/SPEC-AUDIT.md` was written in
 * Phase 173, its bullet-level pass covered §1–§11 only, and §12–§19 had never
 * been measured below the section heading. The three §7 rows re-opened since
 * had each been wrong, so the question was whether the rest held.
 *
 * **It largely does.** §13's eleven bullets are built, fixed assets and
 * depreciation included although §13 made them optional; §16's thirty-four
 * entities all have a table or a recorded modelling choice; §18's outbox,
 * worker, object-store adapter and server-side PDF are real. What the pass
 * found was two things in §12 and one number.
 *
 * ## The number
 *
 * `claude-sonnet-5` was priced at $3 / $15 per million tokens with a $0.30
 * cache read. The published price is **$2 / $10 with a $0.20 cache read**,
 * and the pricing page says why the other figure exists:
 *
 * > The $2/$10 per million input/output token pricing for Claude Sonnet 5,
 * > announced at launch as introductory pricing through August 31, 2026, is
 * > now the standard price. The previously scheduled increase to $3/$15 per
 * > million input/output tokens on September 1, 2026 will not occur.
 *
 * So the table encoded **an increase that was cancelled**, and every Sonnet
 * request this application metered recorded a cost half again as large as the
 * real one — in the ledger §12 asks for *"for billing and monitoring"*, which
 * is the one number here whose only job is to be right.
 *
 * Nothing errored and nothing looked wrong. A price is a constant nobody
 * re-reads, which is the same sentence as Phase 192's about a build nobody
 * runs and Phase 193's about a function nobody calls.
 */

const provider = new AnthropicProvider()

describe('what a million tokens costs', () => {
  /*
    Checked against the published price list rather than against the table in
    the source, which would assert the code equals itself. The figures below
    were read from the pricing page during Phase 194; the footnote above says
    which of them had been got wrong and how.
  */
  it.each([
    ['claude-opus-5', 5_000_000, 25_000_000, 500_000],
    ['claude-sonnet-5', 2_000_000, 10_000_000, 200_000],
    ['claude-haiku-4-5', 1_000_000, 5_000_000, 100_000],
  ])('prices %s as published', (model, input, output, cached) => {
    const pricing = provider.pricing(model)

    expect(pricing.inputPerMillionMicros).toBe(input)
    expect(pricing.outputPerMillionMicros).toBe(output)
    expect(pricing.cachedInputPerMillionMicros).toBe(cached)
  })

  it('charges a cache read at a tenth of the base rate', () => {
    /*
      The relationship the price list states — "cache read (hit): 0.1x base
      input price" for this family — rather than three more literals. It is
      the property that was violated: $0.30 against a $3 base was consistent,
      and wrong because the base was wrong.
    */
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      const pricing = provider.pricing(model)
      expect(pricing.cachedInputPerMillionMicros * 10).toBe(pricing.inputPerMillionMicros)
    }
  })

  it('falls back to the default model rather than charging nothing', () => {
    // A model nobody priced must not meter as free: an unpriced request is a
    // request the usage ledger would under-report, which is the direction
    // that matters for a bill.
    const unknown = provider.pricing('claude-something-unreleased')
    expect(unknown.inputPerMillionMicros).toBeGreaterThan(0)
    expect(unknown).toEqual(provider.pricing('claude-opus-5'))
  })

  it('costs a Sonnet request what it now costs, not what it nearly did', () => {
    const sonnet = provider.pricing('claude-sonnet-5')
    const cost = estimateCostMicros(
      { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 0 },
      sonnet,
    )

    // $2.00 of input plus $1.00 of output. Under the cancelled increase this
    // same request metered at $4.50 — a figure somebody could have budgeted
    // against.
    expect(cost).toBe(3_000_000)
    expect(formatMicros(cost)).toBe('$3.00')
  })
})

describe('the cache that correctly reads zero', () => {
  /**
   * §12 asks for "caching where safe", `provider.ts` prices a cache read, and
   * `cache_read_input_tokens` has never been anything but zero because
   * nothing sets `cache_control`.
   *
   * That looks exactly like a capability installed and inert — Phase 160's
   * shape — and the fix looked like one line. It is not, and the measurement
   * is the whole reason: prompt caching needs a stable prefix of at least the
   * model's minimum, 1024 tokens on this family, and **below it the request
   * silently does not cache**.
   */
  it('has no system prompt long enough to cache', () => {
    const MINIMUM_CACHEABLE_TOKENS = 1024

    for (const prompt of BUILT_IN_PROMPTS) {
      /*
        Four characters to the token is the rough English ratio, and generous
        here: it over-estimates, so a prompt this says is too short really is.
        An exact count would need the token counter, a network call, and a
        key — for a check whose answer is "not close".
      */
      const roughTokens = prompt.systemPrompt.length / 4

      expect(
        roughTokens,
        `${prompt.key} is ${Math.round(roughTokens)} tokens. If a system prompt ever passes ` +
          `${MINIMUM_CACHEABLE_TOKENS}, caching becomes worth requesting and this test should ` +
          'fail so somebody adds `cache_control` — see `anthropic-provider.ts`.',
      ).toBeLessThan(MINIMUM_CACHEABLE_TOKENS)
    }
  })

  it('is a tripwire rather than a prohibition', () => {
    /*
      The test above fails when a prompt *grows*, which is the point: it is
      not asserting that short prompts are good, it is holding the reason
      `cache_control` is absent so the reason cannot outlive itself.

      This is Phase 185's lesson inverted. There, a limitation declared in a
      docstring survived sixty phases because a sentence cannot notice that it
      has stopped being true. This one is a sentence that can.
    */
    expect(BUILT_IN_PROMPTS.length).toBeGreaterThan(5)
  })
})
