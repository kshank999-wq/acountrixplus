import type { TransactionalProvider } from '../transactional'
import { PostmarkProvider } from './postmark'
import { ResendProvider } from './resend'

/**
 * Which adapters exist, and how one is chosen (spec §18).
 *
 * Built on demand rather than registered at import, unlike the bank registry.
 * The difference is that these constructors *refuse* when their key is
 * missing, and a registry that instantiates every adapter eagerly would make a
 * deployment using Postmark fail because it has no Resend key. Only the
 * selected one is ever constructed.
 */
const BUILDERS: Record<string, () => TransactionalProvider> = {
  resend: () => new ResendProvider(),
  postmark: () => new PostmarkProvider(),
}

/** The names `TRANSACTIONAL_EMAIL_PROVIDER` accepts, `mock` aside. */
export function transactionalProviderKeys(): string[] {
  return Object.keys(BUILDERS)
}

/**
 * Constructs the adapter for a key, or throws saying what was available.
 *
 * Throwing rather than falling back to the mock is the same decision Phase 19
 * made and for the same reason: a deployment that believes it configured a
 * real sender and is quietly dropping every password reset into memory is
 * discovered by a support ticket.
 */
export function buildTransactionalProvider(key: string): TransactionalProvider {
  const builder = BUILDERS[key]
  if (!builder) {
    throw new Error(
      `Unknown transactional email provider "${key}". ` +
        `Available: mock, ${transactionalProviderKeys().join(', ')}.`,
    )
  }
  return builder()
}

export { PostmarkProvider } from './postmark'
export { ResendProvider } from './resend'
