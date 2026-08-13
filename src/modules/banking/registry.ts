import type { BankProvider } from './provider'
import { MockBankProvider } from './mock-provider'

/**
 * Provider registry. The rest of the application asks for "the bank provider"
 * and never names a vendor, so adding a real aggregator is a matter of
 * registering an adapter here (spec §3).
 */
const providers = new Map<string, BankProvider>()

export function registerProvider(provider: BankProvider): void {
  providers.set(provider.key, provider)
}

registerProvider(new MockBankProvider())

/**
 * Resolves an adapter by key, defaulting to `BANK_PROVIDER` from the
 * environment and falling back to the mock provider.
 */
export function getBankProvider(key?: string): BankProvider {
  const resolved = key ?? process.env.BANK_PROVIDER ?? 'mock'
  const provider = providers.get(resolved)

  if (!provider) {
    throw new Error(
      `Unknown bank provider "${resolved}". Registered: ${[...providers.keys()].join(', ')}`,
    )
  }

  return provider
}

export function registeredProviderKeys(): string[] {
  return [...providers.keys()]
}
