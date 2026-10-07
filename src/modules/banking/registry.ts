import { RegistryError } from '@/modules/errors/registry'
import type { BankProvider } from './provider'
import { MockBankProvider } from './mock-provider'
import { PlaidBankProvider } from './providers/plaid'

/**
 * Provider registry. The rest of the application asks for "the bank provider"
 * and never names a vendor, so adding a real aggregator is a matter of
 * registering an adapter here (spec §3).
 *
 * ## Why these are factories and not instances (Phase 176)
 *
 * This file used to hold `registerProvider(new MockBankProvider())` and read the
 * key off the instance. That works for exactly as long as every adapter can be
 * constructed with no configuration — which was true while the mock was the only
 * one.
 *
 * `PlaidBankProvider`'s constructor **throws** without `PLAID_CLIENT_ID` and
 * `PLAID_SECRET`, deliberately and for the reason the mail adapters give: a
 * deployment that names a provider and has not configured it should fail where
 * somebody is looking. Constructed at module load that refusal would fire on
 * *import*, in every deployment that has no Plaid credentials — which is every
 * deployment today, and all 4,200 tests. Importing the bookkeeping module would
 * throw because an adapter nobody selected is unconfigured.
 *
 * So registration stores a way to build an adapter, and `getBankProvider` builds
 * only the one that was asked for. The consequence worth stating: an adapter's
 * configuration refusal now surfaces at *selection*, not at import, which is
 * where it belongs — the deployment that set `BANK_PROVIDER=plaid` and forgot
 * the secret finds out, and the deployment that set neither is unaffected.
 */
type ProviderFactory = () => BankProvider

const BANK_PROVIDERS = new Map<string, ProviderFactory>()

/**
 * Built adapters, kept so selecting one twice does not construct it twice.
 *
 * Memoised rather than rebuilt because an adapter holds configuration, not
 * per-request state — and because a constructor that throws should throw once
 * per process, not once per sync.
 */
const built = new Map<string, BankProvider>()

export function registerProvider(key: string, create: ProviderFactory): void {
  BANK_PROVIDERS.set(key, create)
  // A re-registration replaces the adapter, so a cached instance from the
  // previous factory would outlive the thing that declared it.
  built.delete(key)
}

registerProvider('mock', () => new MockBankProvider())
registerProvider('plaid', () => new PlaidBankProvider())

/**
 * Resolves an adapter by key, defaulting to `BANK_PROVIDER` from the
 * environment and falling back to the mock provider.
 */
export function getBankProvider(key?: string): BankProvider {
  const resolved = key ?? process.env.BANK_PROVIDER ?? 'mock'

  const cached = built.get(resolved)
  if (cached) return cached

  const create = BANK_PROVIDERS.get(resolved)
  if (!create) {
    /*
      A `RegistryError` and not a bare `Error` (Phase 101's device, ADR 0074's
      half that does not move): an unregistered provider key is a defect in this
      repository or a typo in a deployment variable, named by this registry and
      this key, and never something to show the person whose books are being
      synced.
    */
    throw new RegistryError({
      registry: 'BANK_PROVIDERS',
      key: resolved,
      message:
        `No bank provider adapter is registered as "${resolved}". This is the key read from ` +
        '`BANK_PROVIDER` or stored on `bank_connections.provider`, so a stored connection naming ' +
        'a retired adapter lands here too. Registered: ' +
        `${[...BANK_PROVIDERS.keys()].join(', ')}.`,
    })
  }

  const provider = create()
  built.set(resolved, provider)
  return provider
}

export function registeredProviderKeys(): string[] {
  return [...BANK_PROVIDERS.keys()]
}
