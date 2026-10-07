/**
 * The Plaid adapter (Phase 176, spec §3).
 *
 * §3 asks for a *"secure bank and credit-card connection through an aggregation
 * provider; use a provider abstraction layer so Plaid or another vendor can be
 * replaced without rewriting the bookkeeping domain."* The abstraction has
 * existed since Phase 2 with one implementation — the mock — so this is the
 * first time anything has proved the seam works.
 *
 * It mostly did. What it did not account for is recorded in ADR 0176 and in the
 * two notes at the bottom of this file.
 *
 * ## No library
 *
 * `fetch` and JSON, like `notify/providers/http.ts`, and for its stated reason:
 * the runtime is short-lived serverless invocations and one request is what it
 * is good at. The `plaid` npm package is a generated client with its own
 * dependency tree, and this application has nine dependencies on purpose.
 *
 * Plaid authenticates with `client_id` and `secret` **in the JSON body** rather
 * than a header, which is unusual and is the vendor's own convention.
 *
 * ## The sign convention, which is inverted
 *
 * **Plaid reports a purchase as a positive amount.** Money leaving the account
 * is `+42.50`. This codebase's convention — stated on `ProviderTransaction` —
 * is the opposite: *"Signed minor units: negative = money out, positive = money
 * in."*
 *
 * So every amount is negated, and that single line is the highest-consequence
 * statement in this file. Get it wrong and every transaction imports backwards,
 * every category is inverted, and the first balance sheet is a mirror of the
 * truth. It has a test of its own, asserted in both directions, because a test
 * that only checks a purchase would pass with the sign the wrong way round if
 * the fixture were also wrong.
 *
 * ## What this has not been run against
 *
 * Plaid's own API. The network here cannot reach it, so every test drives a
 * stubbed `fetch` with payloads shaped from the documented API. That makes the
 * adapter's *logic* tested — pagination, sign, mapping, error classification —
 * and the *field names* unverified against a live response.
 *
 * Said plainly because it is the kind of thing that is easy to imply is
 * finished: before this handles real money, run it against Plaid's sandbox,
 * which is free, and compare one real payload against `PlaidTransaction` below.
 * The sandbox is also where the `Plaid-Version` header matters — this pins
 * `2020-09-14`, and a newer version can rename fields.
 */

import {
  BankProviderError,
  type BankProvider,
  type ExchangeResult,
  type FetchOptions,
  type LinkSession,
  type ProviderAccount,
  type ProviderAccountKind,
  type ProviderConnection,
  type ProviderTransaction,
  type TransactionPage,
} from '../provider'

/** Pinned, because a newer version can rename fields under us. */
const PLAID_VERSION = '2020-09-14'

/**
 * Short, for the reason `notify/providers/http.ts` gives about mail: a person
 * is waiting on a screen, and a provider that has not answered in fifteen
 * seconds is not about to. A sync is also retried by the worker on the next
 * tick, so failing fast costs a few minutes rather than the data.
 */
const TIMEOUT_MS = 15_000

/**
 * Pages drained inside one `fetchTransactions` call.
 *
 * `/transactions/sync` with no cursor returns the whole history a page at a
 * time, and `sync.ts` calls `fetchTransactions` **once** per tick and stores
 * the cursor — so without draining here, a first sync of a two-year account
 * would import 500 transactions and then catch up at 500 per worker tick.
 *
 * Bounded rather than unbounded because the caller is a serverless invocation
 * with a 60-second cap: eight pages is up to 4,000 transactions, which covers
 * any realistic first sync, and `hasMore` is returned truthfully so a longer
 * history resumes on the next tick rather than being lost.
 */
const MAX_PAGES_PER_CALL = 8

/** Plaid's own page size cap for `/transactions/sync`. */
const PAGE_SIZE = 500

type PlaidBalances = {
  current: number | null
  available: number | null
  iso_currency_code: string | null
  unofficial_currency_code?: string | null
}

export type PlaidAccount = {
  account_id: string
  name: string
  official_name?: string | null
  mask?: string | null
  type: string
  subtype?: string | null
  balances: PlaidBalances
}

export type PlaidTransaction = {
  transaction_id: string
  account_id: string
  /** `YYYY-MM-DD`. The posted date; `authorized_date` is separate. */
  date: string
  /** **Positive for money leaving the account.** See the note above. */
  amount: number
  iso_currency_code?: string | null
  name: string
  merchant_name?: string | null
  pending: boolean
  personal_finance_category?: { primary?: string | null } | null
  category?: string[] | null
}

export type SyncResponse = {
  added: PlaidTransaction[]
  modified: PlaidTransaction[]
  removed: { transaction_id: string }[]
  next_cursor: string
  has_more: boolean
}

export type PlaidOptions = {
  clientId?: string
  secret?: string
  /** `sandbox` or `production`. Plaid retired `development`. */
  environment?: string
  /** Injected by tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** What Plaid shows the account holder in the link widget. */
  clientName?: string
  countryCodes?: string[]
}

function baseUrl(environment: string): string {
  if (environment === 'production') return 'https://production.plaid.com'
  if (environment === 'sandbox') return 'https://sandbox.plaid.com'

  throw new BankProviderError(
    `Unknown Plaid environment "${environment}". Use "sandbox" or "production" — ` +
      'Plaid retired "development", so a config carrying it was written against an older API.',
    'plaid',
  )
}

/**
 * Plaid's account taxonomy, mapped onto ours.
 *
 * `type` is the coarse one and `subtype` the fine one, and the mapping leans on
 * `type` because that is the field Plaid guarantees. An unrecognised pair
 * becomes `other` rather than throwing: a new subtype is Plaid adding a product,
 * not this application being broken, and refusing to import an account because
 * its subtype is unfamiliar would be the worse failure.
 */
export function accountKindFor(type: string, subtype?: string | null): ProviderAccountKind {
  if (type === 'credit') return 'credit_card'
  if (type === 'loan') return 'loan'

  if (type === 'depository') {
    if (subtype === 'savings' || subtype === 'money market' || subtype === 'cd') return 'savings'
    // `checking`, and anything else a bank files under depository.
    return 'checking'
  }

  return 'other'
}

/** Minor units, from Plaid's decimal, with the sign inverted. */
export function amountCentsFor(plaidAmount: number): number {
  /*
    The inversion, in one place so there is one place to be wrong.

    `Math.round` and not truncation: `-0.1 * 100` is `-10.000000000000002` in
    binary floating point, and truncating that is `-10` by luck rather than by
    rule. Rounding is the rule.
  */
  const cents = Math.round(plaidAmount * 100)

  /*
    `cents === 0 ? 0 : -cents`, because `-0` is a thing in JavaScript and
    `-Math.round(0 * 100)` produces it. A zero-amount transaction is not an edge
    case invented for a test — a $0 pre-authorisation is what a petrol pump and a
    hotel check-in both do.

    It compares equal to `0` under `===` and serialises as `"0"`, so nothing is
    *currently* wrong. It is normalised anyway on this project's own rule that
    two answers to one question is the defect: `Object.is`, `toBe` and
    `Math.sign` all tell `-0` and `0` apart, so leaving both in circulation
    leaves a check somewhere downstream that is right by luck. Found by this
    function's own test, which is the argument for asserting a sign in both
    directions rather than once.
  */
  return cents === 0 ? 0 : -cents
}

/**
 * Plaid's category, if it offered one.
 *
 * `personal_finance_category.primary` is the current field and `category[]` is
 * the legacy array. Advisory either way — `ProviderTransaction.category` says
 * *"Provider's own category guess. Advisory only — never auto-posted."*
 */
export function categoryFor(transaction: PlaidTransaction): string | undefined {
  const primary = transaction.personal_finance_category?.primary
  if (primary) return primary

  const legacy = transaction.category?.[0]
  return legacy ?? undefined
}

export class PlaidBankProvider implements BankProvider {
  readonly key = 'plaid'

  private readonly clientId: string
  private readonly secret: string
  private readonly base: string
  private readonly fetchImpl: typeof fetch
  private readonly clientName: string
  private readonly countryCodes: string[]

  constructor(options: PlaidOptions = {}) {
    const clientId = options.clientId ?? process.env.PLAID_CLIENT_ID
    const secret = options.secret ?? process.env.PLAID_SECRET

    /*
      Thrown in the constructor rather than at the first call, matching the mail
      adapters: a deployment that names a provider and has not configured it
      should fail where somebody is looking, not on the first sync at three in
      the morning. `getBankProvider` constructs lazily, so this surfaces the
      moment the provider is selected.
    */
    if (!clientId || !secret) {
      throw new BankProviderError(
        'PLAID_CLIENT_ID and PLAID_SECRET must both be set to use the Plaid provider. ' +
          'Without them the application falls back to no bank feed at all, so this refuses ' +
          'rather than appearing configured.',
        'plaid',
      )
    }

    this.clientId = clientId
    this.secret = secret
    this.base = baseUrl(options.environment ?? process.env.PLAID_ENV ?? 'sandbox')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.clientName = options.clientName ?? process.env.PLAID_CLIENT_NAME ?? 'Accountrix Plus'
    this.countryCodes = options.countryCodes ??
      (process.env.PLAID_COUNTRY_CODES?.split(',').map((code) => code.trim()).filter(Boolean) ?? [
        'US',
      ])
  }

  /**
   * One request, with the credentials in the body as Plaid wants them.
   *
   * Classifies failures the way `notify/providers/http.ts` argues for: the line
   * is between "could not take it just now" and "understood and said no".
   * Retrying the first costs seconds; retrying the second repeats a rejected
   * request forever.
   */
  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Plaid-Version': PLAID_VERSION,
        },
        body: JSON.stringify({ client_id: this.clientId, secret: this.secret, ...body }),
        signal: controller.signal,
      })
    } catch (error) {
      // A timeout or a dropped connection is the provider's problem, not the
      // request's, so it is worth another tick.
      throw new BankProviderError(
        `Plaid did not respond to ${path}: ${error instanceof Error ? error.message : 'unknown error'}.`,
        'plaid',
        true,
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const detail = await this.describeFailure(response)

      /*
        429 and 5xx are worth retrying. 400 is not — and Plaid uses 400 for
        `ITEM_LOGIN_REQUIRED`, which is the one failure a person has to fix by
        re-authenticating, so retrying it forever would hide the thing they need
        to be told.
      */
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500

      throw new BankProviderError(
        `Plaid refused ${path} with ${response.status}: ${detail}`,
        'plaid',
        retryable,
      )
    }

    return (await response.json()) as T
  }

  /**
   * Plaid's error body, if it sent one.
   *
   * `error_code` is the field worth surfacing — `ITEM_LOGIN_REQUIRED`,
   * `PRODUCT_NOT_READY`, `INVALID_ACCESS_TOKEN` — because it is what tells
   * somebody whether to re-link, wait, or look at the configuration. Falls back
   * to the status text rather than throwing while handling a throw.
   */
  private async describeFailure(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as {
        error_code?: string
        error_message?: string
      }
      if (body.error_code) {
        return `${body.error_code}${body.error_message ? ` — ${body.error_message}` : ''}`
      }
    } catch {
      // Fall through to the status text.
    }
    return response.statusText || 'no detail'
  }

  async createLinkSession(companyId: string): Promise<LinkSession> {
    const result = await this.call<{ link_token: string; expiration: string }>(
      '/link/token/create',
      {
        client_name: this.clientName,
        language: 'en',
        country_codes: this.countryCodes,
        /*
          The company id, not a user id. Plaid keys its own rate limits and
          duplicate-item detection on this, and the thing that owns a bank
          connection here is the company — two owners linking the same bank
          should look like one customer to Plaid, which is what it is.
        */
        user: { client_user_id: companyId },
        products: ['transactions'],
      },
    )

    return {
      linkToken: result.link_token,
      expiresAt: new Date(result.expiration),
    }
  }

  async exchangePublicToken(publicToken: string): Promise<ExchangeResult> {
    const exchanged = await this.call<{ access_token: string; item_id: string }>(
      '/item/public_token/exchange',
      { public_token: publicToken },
    )

    return {
      providerItemId: exchanged.item_id,
      institutionName: await this.institutionName(exchanged.access_token),
      // The reason Phase 176 exists: this had nowhere to go before.
      credential: exchanged.access_token,
    }
  }

  /**
   * The institution's display name.
   *
   * Two calls, because Plaid does not return the name with the exchange: the
   * item carries an `institution_id` and the name is a second lookup. Failing
   * softly on purpose — a connection with an unknown institution name is
   * usable, and refusing the whole link because a cosmetic lookup failed would
   * be the wrong trade.
   */
  private async institutionName(accessToken: string): Promise<string> {
    try {
      const item = await this.call<{ item: { institution_id?: string | null } }>('/item/get', {
        access_token: accessToken,
      })

      const institutionId = item.item.institution_id
      if (!institutionId) return 'Unknown institution'

      const institution = await this.call<{ institution: { name: string } }>(
        '/institutions/get_by_id',
        { institution_id: institutionId, country_codes: this.countryCodes },
      )

      return institution.institution.name
    } catch {
      return 'Unknown institution'
    }
  }

  async listAccounts(connection: ProviderConnection): Promise<ProviderAccount[]> {
    const accessToken = this.requireCredential(connection)

    const result = await this.call<{ accounts: PlaidAccount[] }>('/accounts/get', {
      access_token: accessToken,
    })

    return result.accounts.map((account) => ({
      providerAccountId: account.account_id,
      name: account.official_name?.trim() || account.name,
      /*
        `mask ?? undefined`, and §19's reason: the last four digits only, never
        the full number. Plaid sends only the mask, so there is nothing here to
        accidentally widen — noted because the next adapter might.
      */
      mask: account.mask ?? undefined,
      kind: accountKindFor(account.type, account.subtype),
      currency: account.balances.iso_currency_code ?? 'USD',
      currentBalanceCents: Math.round((account.balances.current ?? 0) * 100),
      availableBalanceCents:
        account.balances.available === null || account.balances.available === undefined
          ? undefined
          : Math.round(account.balances.available * 100),
    }))
  }

  /**
   * Transactions, by cursor.
   *
   * **`options.startDate` and `options.endDate` are ignored here, and that is a
   * promise this adapter cannot keep.** `FetchOptions` offers *"inclusive ISO
   * date bounds for a full (non-incremental) pull"*, which the mock honours;
   * `/transactions/sync` is cursor-based and has no date parameters at all. The
   * date-ranged endpoint is `/transactions/get`, which returns no cursor, so
   * honouring the bounds would mean giving up incremental sync — the wrong trade
   * for the one caller that exists.
   *
   * Said here rather than silently dropped because a silently ignored argument
   * is the shape this codebase keeps calling the dangerous one: it reports
   * success and does something else. No caller passes either field today
   * (`syncConnection`'s `opts` reaches no UI), so nothing is currently wrong —
   * which is exactly when it is cheap to write down.
   */
  async fetchTransactions(
    connection: ProviderConnection,
    options: FetchOptions = {},
  ): Promise<TransactionPage> {
    const accessToken = this.requireCredential(connection)

    const transactions: ProviderTransaction[] = []
    let cursor = options.cursor
    let hasMore = true
    let pages = 0

    /*
      Drained here rather than left to the caller, because `sync.ts` calls this
      once per worker tick and stores the cursor — see MAX_PAGES_PER_CALL.
    */
    while (hasMore && pages < MAX_PAGES_PER_CALL) {
      const page = await this.call<SyncResponse>('/transactions/sync', {
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        count: PAGE_SIZE,
      })

      /*
        `added` and `modified` both become transactions with their own immutable
        ids, which is what `ProviderTransaction` asks for. What happens to a
        *modified* one downstream is the finding at the bottom of this file:
        `importTransactions` uses `onConflictDoNothing`, so today a pending
        transaction that posts keeps its pending amount. Reported here rather
        than silently dropped, so the fix has something to act on.
      */
      for (const raw of [...page.added, ...page.modified]) {
        transactions.push(this.toProviderTransaction(raw))
      }

      /*
        `page.removed` has nowhere to go. `TransactionPage` carries transactions
        and a cursor and has no way to say "this one was retracted", so a
        transaction Plaid removes — a disputed authorisation that never posted —
        stays in the inbox. Returning it as a transaction would be worse, and
        inventing a shape for it is the follow-up phase ADR 0176 nominates. It is
        in the type above so the reader can see it was read and not missed.
      */

      cursor = page.next_cursor
      hasMore = page.has_more
      pages += 1
    }

    return { transactions, nextCursor: cursor, hasMore }
  }

  private toProviderTransaction(raw: PlaidTransaction): ProviderTransaction {
    return {
      providerTransactionId: raw.transaction_id,
      providerAccountId: raw.account_id,
      postedDate: raw.date,
      amountCents: amountCentsFor(raw.amount),
      description: raw.name,
      merchantName: raw.merchant_name ?? undefined,
      category: categoryFor(raw),
      pending: raw.pending,
      raw: raw as unknown as Record<string, unknown>,
    }
  }

  /**
   * The credential, or a refusal naming what is wrong.
   *
   * A connection with no credential is not a transient failure and must not be
   * retried: it means the row predates Phase 176, or was written by a different
   * adapter, and no amount of waiting produces a token. Re-linking does.
   */
  private requireCredential(connection: ProviderConnection): string {
    if (!connection.credential) {
      throw new BankProviderError(
        `This connection has no stored Plaid credential, so it cannot be synced. ` +
          'Reconnect the institution — a connection created before the credential column ' +
          'existed, or by a different provider, has no token to use.',
        'plaid',
        false,
      )
    }
    return connection.credential
  }
}
