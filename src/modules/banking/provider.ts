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
  /**
   * The durable credential this connection will need, if the provider issues
   * one (Phase 176).
   *
   * Opaque to the domain on purpose: for Plaid it is an `access_token`, for
   * another aggregator it may be a refresh token or a signed handle, and
   * nothing outside the adapter should parse it. The *domain* stores it —
   * encrypted, in `bank_connections.credential_cipher` — rather than the
   * adapter keeping state, because an adapter that reads and writes the
   * database is exactly the provider-specific leak this file's own docstring
   * forbids.
   *
   * Absent for an adapter that needs none. The mock is the reason it is
   * optional, and the reason this gap went unnoticed for 174 phases: a mock has
   * no secret, so nothing ever had to carry one.
   */
  credential?: string
}

/**
 * What an adapter is handed to act on an existing connection (Phase 176).
 *
 * A bare `providerItemId` was enough while the only implementation was the
 * mock. A real aggregator needs the credential as well, and passing it as a
 * second positional argument would have made the two separable — a caller could
 * pass the id of one connection and the credential of another, which is a
 * cross-tenant mistake the type system can prevent by refusing to let them
 * travel apart.
 */
export type ProviderConnection = {
  providerItemId: string
  /** Decrypted at the call site, never stored in this shape. */
  credential?: string
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
  listAccounts(connection: ProviderConnection): Promise<ProviderAccount[]>

  /**
   * Fetches transactions. Implementations must return the provider's own
   * immutable ids so repeated calls over the same window deduplicate.
   */
  fetchTransactions(
    connection: ProviderConnection,
    options?: FetchOptions,
  ): Promise<TransactionPage>
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
