import type { PaymentProvider } from './provider'
import { mockPaymentProvider } from './mock-provider'

/**
 * Provider registry (spec §13, §19).
 *
 * The rest of the application asks for "the payment provider" and never names
 * a processor, so contracting one is a matter of registering an adapter here.
 */
const providers = new Map<string, PaymentProvider>()

export function registerPaymentProvider(provider: PaymentProvider): void {
  providers.set(provider.key, provider)
}

registerPaymentProvider(mockPaymentProvider)

/**
 * Resolves an adapter by key, defaulting to `PAYMENT_PROVIDER`.
 *
 * Falls back to the mock when the named adapter exists but has no
 * credentials, and says so through `fellBack` on `providerHealth` — the same
 * shape `modules/ai/settings.ts` uses. An unconfigured processor that silently
 * became a real one would be worse; an unconfigured one that throws at
 * checkout would show a customer an error page.
 */
export function getPaymentProvider(key?: string): PaymentProvider {
  const requested = key ?? process.env.PAYMENT_PROVIDER ?? 'mock'
  const provider = providers.get(requested)

  if (!provider) {
    throw new Error(
      `Unknown payment provider "${requested}". Registered: ${[...providers.keys()].join(', ')}`,
    )
  }

  if (!provider.configured) return mockPaymentProvider

  return provider
}

export function registeredPaymentProviderKeys(): string[] {
  return [...providers.keys()]
}

/** What will actually run, for the settings screen. */
export function paymentProviderHealth(key?: string): {
  selected: string
  effective: string
  fellBack: boolean
} {
  const selected = key ?? process.env.PAYMENT_PROVIDER ?? 'mock'
  const effective = getPaymentProvider(selected)

  return { selected, effective: effective.key, fellBack: effective.key !== selected }
}
