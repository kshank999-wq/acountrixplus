import type { AiProvider } from './provider'
import { MockAiProvider } from './mock-provider'
import { AnthropicProvider } from './anthropic-provider'

/**
 * Provider registry (spec §12: adapters "selected by capability, price,
 * latency, or customer plan").
 *
 * Same shape as the bank, asset, and email registries. The domain asks for
 * "the AI provider" and never names a vendor.
 */
const providers = new Map<string, AiProvider>()

export function registerAiProvider(provider: AiProvider): void {
  providers.set(provider.key, provider)
}

const mock = new MockAiProvider()
registerAiProvider(mock)
registerAiProvider(new AnthropicProvider())

/** The shared mock instance, so tests can inspect what would have been sent. */
export function mockAiProvider(): MockAiProvider {
  return mock
}

/**
 * Resolves an adapter.
 *
 * Falls back to the mock rather than throwing when a configured provider has
 * no credentials: a company that switched to a real provider and has not set
 * the key yet should get heuristic suggestions and a visible warning, not a
 * broken bookkeeping inbox.
 */
export function getAiProvider(key?: string): AiProvider {
  const resolved = key ?? process.env.AI_PROVIDER ?? 'mock'
  const provider = providers.get(resolved)

  if (!provider) {
    throw new Error(
      `Unknown AI provider "${resolved}". Registered: ${[...providers.keys()].join(', ')}`,
    )
  }

  return provider.isConfigured() ? provider : mock
}

/** Whether the named provider could actually run, for the admin page. */
export function providerStatus(): Array<{ key: string; configured: boolean }> {
  return [...providers.values()].map((provider) => ({
    key: provider.key,
    configured: provider.isConfigured(),
  }))
}
