import { DomainError } from '@/modules/errors'
/**
 * Bank aggregation provider abstraction (spec §3).
 *
 * The bookkeeping domain talks only to this interface. Swapping Plaid for
 * another aggregator means writing one new adapter — no changes to import,
 * dedup, categorization, or the inbox. Nothing provider-specific may leak past
 * these types.
 */

export type ProviderAccountKind = 'checking' | 'savings' | 'credit_card' | 'loan' | 'other'

export type ProviderAccount = {
  /** Stable identifier at the provider. Persisted for reconnects. */
  providerAccountId: string
  name: string
  /** Last four digits only — never the full account number (spec §19). */
  mask?: string
  kind: ProviderAccountKind
  currency: string
  /** Balances in minor units. Providers reporting decimals convert here. */
  currentBalanceCents: number
  availableBalanceCents?: number
}

export type ProviderTransaction = {
  /**
   * The provider's immutable transaction id. This is the dedup key
   * (spec §3) — an adapter must never synthesize or renumber it.
   */
  providerTransactionId: string
  providerAccountId: string
  /** ISO date, YYYY-MM-DD. */
  postedDate: string
  /** Signed minor units: negative = money out, positive = money in. */
  amountCents: number
  description: string
  merchantName?: string
  /** Provider's own category guess. Advisory only — never auto-posted. */
  category?: string
  pending: boolean
  /** Untouched provider payload, stored for audit and reprocessing. */
  raw?: Record<string, unknown>
}

export type TransactionPage = {
  transactions: ProviderTransaction[]
  /** Opaque cursor for the next incremental sync. */
  nextCursor?: string
  hasMore: boolean
}

export type LinkSession = {
  /** Token the client widget needs to start the institution link flow. */
  linkToken: string
  expiresAt: Date
}

export type ExchangeResult = {
  providerItemId: string
  institutionName: string
}

export type FetchOptions = {
  /** Resume from a previous sync. */
  cursor?: string
  /** Inclusive ISO date bounds for a full (non-incremental) pull. */
  startDate?: string
  endDate?: string
}

export interface BankProvider {
  /** Adapter key stored on `bank_connections.provider`. */
  readonly key: string

  /** Starts an institution link flow. */
  createLinkSession(companyId: string): Promise<LinkSession>

  /** Exchanges the client's public token for a durable connection handle. */
  exchangePublicToken(publicToken: string): Promise<ExchangeResult>

  /** Lists the accounts available on a connection. */
  listAccounts(providerItemId: string): Promise<ProviderAccount[]>

  /**
   * Fetches transactions. Implementations must return the provider's own
   * immutable ids so repeated calls over the same window deduplicate.
   */
  fetchTransactions(providerItemId: string, options?: FetchOptions): Promise<TransactionPage>
}

/** Raised when a provider call fails in a way the caller should surface. */
export class BankProviderError extends DomainError {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'BankProviderError'
  }
}
