import { beforeEach, describe, expect, it } from 'vitest'
import { RegistryError } from '@/modules/errors/registry'
import { BankProviderError } from '@/modules/banking/provider'
import {
  PlaidBankProvider,
  accountKindFor,
  amountCentsFor,
  categoryFor,
  type PlaidTransaction,
} from '@/modules/banking/providers/plaid'
import { getBankProvider, registeredProviderKeys } from '@/modules/banking/registry'

/**
 * The first real bank adapter (Phase 176).
 *
 * `BankProvider` has had one implementation since Phase 2 — the mock — and the
 * comment on the interface says the point: *"Swapping Plaid for another
 * aggregator means writing one new adapter."* Nothing had tested that claim,
 * and writing the adapter found what the mock could not: there was nowhere to
 * put a credential.
 *
 * ## What these tests are and are not
 *
 * Every one drives a **stubbed `fetch`** with payloads shaped from Plaid's
 * documented API, because this network cannot reach Plaid. So the adapter's
 * *logic* is tested — the sign, the pagination, the mapping, the error
 * classification — and the *field names* are asserted against fixtures this
 * repository wrote rather than against a live response.
 *
 * That distinction is the honest one and it is why the adapter's own docstring
 * says to run it against Plaid's sandbox before it handles real money. A
 * fixture and an adapter written by the same person in the same hour agree with
 * each other whether or not either agrees with Plaid.
 *
 * The one thing a fixture cannot make true by agreement is the sign, which is
 * why it is asserted in both directions below: a test that only checked a
 * purchase would pass with the inversion backwards if the fixture were
 * backwards too.
 */

const CREDENTIALS = { clientId: 'test-client', secret: 'test-secret-value' }

/** A recorded call: where it went, what it carried. */
type Call = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

type Reply = { status?: number; body: unknown }

/**
 * A `fetch` that answers from a queue and records what it was asked.
 *
 * Replies are consumed in order; the last one repeats, so a test that drains
 * eight pages does not have to write eight fixtures. Deliberately a real
 * `Response`, not a hand-rolled object: `response.ok`, `response.statusText`
 * and a body that can only be read once are all behaviours the adapter depends
 * on, and a stub that got any of them wrong would prove nothing.
 */
function stubFetch(replies: Reply[]) {
  const calls: Call[] = []
  let index = 0

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1

    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })

    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { impl, calls }
}

function provider(replies: Reply[]) {
  const stub = stubFetch(replies)
  return {
    plaid: new PlaidBankProvider({ ...CREDENTIALS, environment: 'sandbox', fetchImpl: stub.impl }),
    calls: stub.calls,
  }
}

/** A connection with a credential, which is what every call needs. */
const CONNECTED = { providerItemId: 'item-1', credential: 'access-token-1' }

function plaidTransaction(overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: 'txn-1',
    account_id: 'acct-1',
    date: '2026-03-04',
    amount: 42.5,
    name: 'COFFEE SHOP',
    pending: false,
    ...overrides,
  }
}

function syncPage(transactions: PlaidTransaction[], over: Partial<Record<string, unknown>> = {}) {
  return {
    body: {
      added: transactions,
      modified: [],
      removed: [],
      next_cursor: 'cursor-1',
      has_more: false,
      ...over,
    },
  }
}

describe('the sign, which is the highest-consequence line in the adapter', () => {
  it('inverts it, in both directions', () => {
    /**
     * Plaid reports **money leaving the account as positive**. This codebase's
     * convention, stated on `ProviderTransaction`, is the opposite: *"negative =
     * money out, positive = money in."*
     *
     * Both directions, because that is what makes this a check rather than a
     * restatement (Phase 121): a single assertion on a purchase passes just as
     * happily if the adapter and this fixture are both backwards.
     */
    // A purchase: Plaid positive, ours negative.
    expect(amountCentsFor(42.5)).toBe(-4250)
    // A deposit: Plaid negative, ours positive.
    expect(amountCentsFor(-1200)).toBe(120000)
    /**
     * And zero, which failed when this test was first written: `-Math.round(0)`
     * is `-0`, so a $0 pre-authorisation — what a petrol pump and a hotel
     * check-in both do — mapped to a negative zero. Nothing was *currently*
     * wrong, because `-0 === 0` and it serialises as `"0"`; it is normalised
     * because `Object.is`, `toBe` and `Math.sign` all tell them apart, and two
     * representations of one amount is a check downstream that is right by luck.
     */
    expect(amountCentsFor(0)).toBe(0)
    expect(Object.is(amountCentsFor(0), -0)).toBe(false)
    expect(Object.is(amountCentsFor(-0), -0)).toBe(false)
    // Still true the other way: a rounding that lands on zero from either side
    // comes back as one zero.
    expect(Object.is(amountCentsFor(0.001), -0)).toBe(false)
  })

  it('rounds rather than truncates, because binary floating point', () => {
    /**
     * `0.1 * 100` is `10.000000000000002` and `2.67 * 100` is
     * `266.99999999999994`. Truncation turns the second into 266 — a cent lost
     * per transaction, which in a bank feed is a reconciliation that will not
     * close and no obvious reason why.
     */
    expect(amountCentsFor(2.67)).toBe(-267)
    expect(amountCentsFor(-2.67)).toBe(267)
    expect(amountCentsFor(0.1)).toBe(-10)
    expect(amountCentsFor(1e6 + 0.07)).toBe(-100000007)
  })

  it('carries the inversion through a whole fetched transaction', () => {
    // The unit above proves the function; this proves the function is the one
    // actually on the path.
    const { plaid } = provider([syncPage([plaidTransaction({ amount: 42.5 })])])

    return plaid.fetchTransactions(CONNECTED).then((page) => {
      expect(page.transactions[0].amountCents).toBe(-4250)
    })
  })
})

describe('mapping Plaid’s account taxonomy onto ours', () => {
  it('maps the kinds, and files an unfamiliar one under other', () => {
    expect(accountKindFor('depository', 'checking')).toBe('checking')
    expect(accountKindFor('depository', 'savings')).toBe('savings')
    expect(accountKindFor('depository', 'money market')).toBe('savings')
    expect(accountKindFor('depository', 'cd')).toBe('savings')
    expect(accountKindFor('credit', 'credit card')).toBe('credit_card')
    expect(accountKindFor('loan', 'mortgage')).toBe('loan')
    expect(accountKindFor('investment', 'brokerage')).toBe('other')

    /**
     * The two that matter more than the table. A depository account with a
     * subtype nobody listed is a *bank account* — `other` would be the wrong
     * answer because it is the one that gets no bank treatment downstream.
     */
    expect(accountKindFor('depository', 'prepaid')).toBe('checking')
    expect(accountKindFor('depository', null)).toBe('checking')

    // And a type Plaid has not invented yet does not throw. A new Plaid product
    // is Plaid shipping, not this application breaking, and refusing to import
    // an account over an unfamiliar subtype would be the worse failure.
    expect(accountKindFor('crypto-whatever-comes-next')).toBe('other')
  })

  it('prefers the official name and keeps only the mask', () => {
    const { plaid } = provider([
      {
        body: {
          accounts: [
            {
              account_id: 'acct-1',
              name: 'Plaid Checking',
              official_name: 'Plaid Gold Standard 0% Interest Checking',
              mask: '0000',
              type: 'depository',
              subtype: 'checking',
              balances: {
                current: 110.0,
                available: 100.0,
                iso_currency_code: 'USD',
              },
            },
            {
              account_id: 'acct-2',
              name: 'Plaid Saving',
              official_name: null,
              mask: null,
              type: 'depository',
              subtype: 'savings',
              balances: { current: 210.0, available: null, iso_currency_code: null },
            },
          ],
        },
      },
    ])

    return plaid.listAccounts(CONNECTED).then((accounts) => {
      expect(accounts).toEqual([
        {
          providerAccountId: 'acct-1',
          name: 'Plaid Gold Standard 0% Interest Checking',
          mask: '0000',
          kind: 'checking',
          currency: 'USD',
          currentBalanceCents: 11000,
          availableBalanceCents: 10000,
        },
        {
          providerAccountId: 'acct-2',
          name: 'Plaid Saving',
          // Absent, not the string "null" and not an empty string: §19 wants the
          // last four digits or nothing, and `financialAccounts.mask` is
          // nullable so that nothing has somewhere to go.
          mask: undefined,
          kind: 'savings',
          // Plaid omits the currency on some accounts. USD is the assumption and
          // it is written down here rather than discovered.
          currency: 'USD',
          currentBalanceCents: 21000,
          // A null available balance is *unknown*, which is not zero — a credit
          // line showing 0 available and one that did not report are different
          // facts and only one of them means "do not spend".
          availableBalanceCents: undefined,
        },
      ])
    })
  })
})

describe('the provider’s category, which is advisory', () => {
  it('prefers the current field, falls back to the legacy array, and offers nothing rather than a guess', () => {
    expect(
      categoryFor(
        plaidTransaction({
          personal_finance_category: { primary: 'FOOD_AND_DRINK' },
          category: ['Travel', 'Airlines'],
        }),
      ),
    ).toBe('FOOD_AND_DRINK')

    expect(categoryFor(plaidTransaction({ category: ['Travel', 'Airlines'] }))).toBe('Travel')

    // `undefined` and not a default category. `ProviderTransaction.category`
    // says *"Provider's own category guess. Advisory only — never
    // auto-posted"*, and a made-up advisory is worse than none because the
    // rules engine reads it.
    expect(categoryFor(plaidTransaction())).toBeUndefined()
    expect(categoryFor(plaidTransaction({ category: [] }))).toBeUndefined()
    expect(
      categoryFor(plaidTransaction({ personal_finance_category: { primary: null } })),
    ).toBeUndefined()
  })
})

describe('how it talks to Plaid', () => {
  it('puts the credentials in the body and pins the API version', async () => {
    /**
     * Plaid authenticates with `client_id` and `secret` **in the JSON body**
     * rather than a header, which is the vendor's own convention and the kind of
     * thing that is silently wrong until a call 401s.
     *
     * `Plaid-Version` is pinned because an unpinned version means Plaid can
     * rename a field under a deployment nobody touched.
     */
    const { plaid, calls } = provider([
      { body: { link_token: 'link-sandbox-1', expiration: '2026-03-04T12:00:00Z' } },
    ])

    const session = await plaid.createLinkSession('company-1')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://sandbox.plaid.com/link/token/create')
    expect(calls[0].headers['Plaid-Version']).toBe('2020-09-14')
    expect(calls[0].body.client_id).toBe('test-client')
    expect(calls[0].body.secret).toBe('test-secret-value')

    // The company, not the user. Plaid keys duplicate-item detection on this,
    // and the thing that owns a bank connection here is the company — two owners
    // linking the same bank should look like one customer, which is what it is.
    expect(calls[0].body.user).toEqual({ client_user_id: 'company-1' })
    expect(calls[0].body.products).toEqual(['transactions'])

    expect(session.linkToken).toBe('link-sandbox-1')
    expect(session.expiresAt).toEqual(new Date('2026-03-04T12:00:00Z'))
  })

  it('refuses an environment Plaid has retired, by name', () => {
    /**
     * Plaid removed `development`. A config carrying it was written against an
     * older API, and the useful refusal says so rather than reporting a DNS
     * failure for `development.plaid.com` six months later.
     */
    expect(
      () => new PlaidBankProvider({ ...CREDENTIALS, environment: 'development' }),
    ).toThrow(BankProviderError)

    try {
      new PlaidBankProvider({ ...CREDENTIALS, environment: 'development' })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('retired "development"')
      expect((error as Error).message).toContain('sandbox')
    }

    expect(
      new PlaidBankProvider({ ...CREDENTIALS, environment: 'production' }),
    ).toBeInstanceOf(PlaidBankProvider)
  })

  it('refuses to exist without credentials, at selection rather than at the first sync', () => {
    /**
     * The mail adapters' argument, applied here: a deployment that names a
     * provider and has not configured it should fail where somebody is looking.
     * Thrown from the constructor, which `getBankProvider` calls the moment the
     * provider is *selected* — not on a sync at three in the morning.
     */
    const saved = { id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET }
    delete process.env.PLAID_CLIENT_ID
    delete process.env.PLAID_SECRET

    try {
      expect(() => new PlaidBankProvider()).toThrow(BankProviderError)
      expect(() => new PlaidBankProvider({ clientId: 'only-one' })).toThrow(/PLAID_SECRET/)
      expect(() => new PlaidBankProvider({ secret: 'only-one' })).toThrow(/PLAID_CLIENT_ID/)
    } finally {
      if (saved.id !== undefined) process.env.PLAID_CLIENT_ID = saved.id
      if (saved.secret !== undefined) process.env.PLAID_SECRET = saved.secret
    }
  })
})

describe('the exchange, and the credential that had nowhere to go', () => {
  it('returns the access token as the connection’s credential', async () => {
    /**
     * The reason Phase 176 exists. `ExchangeResult` was
     * `{ providerItemId, institutionName }`, so the durable secret every later
     * call needs had nowhere to go *even in memory* — invisible for 174 phases
     * because a mock has no secret.
     */
    const { plaid, calls } = provider([
      { body: { access_token: 'access-sandbox-1', item_id: 'item-9' } },
      { body: { item: { institution_id: 'ins_3' } } },
      { body: { institution: { name: 'First Platypus Bank' } } },
    ])

    const exchanged = await plaid.exchangePublicToken('public-sandbox-1')

    expect(exchanged).toEqual({
      providerItemId: 'item-9',
      institutionName: 'First Platypus Bank',
      credential: 'access-sandbox-1',
    })

    expect(calls.map((call) => call.url)).toEqual([
      'https://sandbox.plaid.com/item/public_token/exchange',
      'https://sandbox.plaid.com/item/get',
      'https://sandbox.plaid.com/institutions/get_by_id',
    ])
    expect(calls[0].body.public_token).toBe('public-sandbox-1')
    // The *access* token on the later two, never the public one — a public token
    // is single-use and spent by the exchange.
    expect(calls[1].body.access_token).toBe('access-sandbox-1')
  })

  it('keeps the credential when the institution lookup fails', async () => {
    /**
     * Two separate concerns, and only one of them is load-bearing. The
     * institution *name* is a label on a screen; the access token is the
     * connection. Failing the whole link because a cosmetic lookup 500'd would
     * trade the thing that matters for the thing that does not.
     */
    const { plaid } = provider([
      { body: { access_token: 'access-sandbox-1', item_id: 'item-9' } },
      { status: 500, body: { error_code: 'INTERNAL_SERVER_ERROR' } },
    ])

    const exchanged = await plaid.exchangePublicToken('public-sandbox-1')

    expect(exchanged.credential).toBe('access-sandbox-1')
    expect(exchanged.providerItemId).toBe('item-9')
    expect(exchanged.institutionName).toBe('Unknown institution')
  })

  it('says unknown rather than empty when the item names no institution', async () => {
    const { plaid } = provider([
      { body: { access_token: 'access-sandbox-1', item_id: 'item-9' } },
      { body: { item: { institution_id: null } } },
    ])

    const exchanged = await plaid.exchangePublicToken('public-sandbox-1')
    expect(exchanged.institutionName).toBe('Unknown institution')
  })
})

describe('a connection with no credential', () => {
  it('refuses, and says reconnect rather than reporting a transient fault', async () => {
    /**
     * Not retryable, and the flag is the finding. A row written before
     * `credential_cipher` existed — or by the mock — has no token, and no amount
     * of waiting produces one. Marked retryable it would be re-attempted every
     * worker tick forever, which is the shape Phase 160 calls the dangerous one:
     * busy, silent, and doing nothing.
     */
    const { plaid, calls } = provider([syncPage([])])

    for (const call of [
      () => plaid.fetchTransactions({ providerItemId: 'item-1' }),
      () => plaid.listAccounts({ providerItemId: 'item-1' }),
    ]) {
      await expect(call()).rejects.toThrow(BankProviderError)
      await call().catch((error: BankProviderError) => {
        expect(error.retryable).toBe(false)
        expect(error.message).toContain('Reconnect the institution')
      })
    }

    // And it refused before reaching the network, which is what makes it a
    // refusal rather than a failed request.
    expect(calls).toEqual([])
  })
})

describe('draining the pages', () => {
  it('follows the cursor to the end and reports no more', async () => {
    /**
     * `sync.ts` calls `fetchTransactions` **once** per worker tick and stores
     * the cursor, so an adapter that returned one page would import 500
     * transactions per tick. A first sync of a two-year account has to arrive in
     * one call, or close to it.
     */
    const { plaid, calls } = provider([
      syncPage([plaidTransaction({ transaction_id: 'txn-1' })], {
        next_cursor: 'cursor-a',
        has_more: true,
      }),
      syncPage([plaidTransaction({ transaction_id: 'txn-2' })], {
        next_cursor: 'cursor-b',
        has_more: true,
      }),
      syncPage([plaidTransaction({ transaction_id: 'txn-3' })], {
        next_cursor: 'cursor-c',
        has_more: false,
      }),
    ])

    const page = await plaid.fetchTransactions(CONNECTED)

    expect(page.transactions.map((t) => t.providerTransactionId)).toEqual([
      'txn-1',
      'txn-2',
      'txn-3',
    ])
    expect(page.nextCursor).toBe('cursor-c')
    expect(page.hasMore).toBe(false)

    // The first call carries no cursor at all — `/transactions/sync` reads an
    // absent cursor as "from the beginning" and an explicit null as an error.
    expect(calls[0].body).not.toHaveProperty('cursor')
    expect(calls[1].body.cursor).toBe('cursor-a')
    expect(calls[2].body.cursor).toBe('cursor-b')
    expect(calls[0].body.count).toBe(500)
  })

  it('resumes from a stored cursor', async () => {
    const { plaid, calls } = provider([syncPage([])])

    await plaid.fetchTransactions(CONNECTED, { cursor: 'cursor-from-last-tick' })

    expect(calls[0].body.cursor).toBe('cursor-from-last-tick')
  })

  it('stops at eight pages and says so truthfully', async () => {
    /**
     * The bound exists because the caller is a serverless invocation with a
     * 60-second cap. What makes the bound safe is the *honesty* of `hasMore`:
     * eight pages is up to 4,000 transactions, and a longer history resumes on
     * the next tick from the cursor rather than being lost.
     *
     * Asserted as a measured count (Phase 126) and not `toBeLessThan`, because
     * "it stopped somewhere" is not the claim.
     */
    const { plaid, calls } = provider([
      syncPage([plaidTransaction()], { has_more: true, next_cursor: 'cursor-forever' }),
    ])

    const page = await plaid.fetchTransactions(CONNECTED)

    expect(calls).toHaveLength(8)
    expect(page.transactions).toHaveLength(8)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('cursor-forever')
  })

  it('returns modified transactions alongside added ones', async () => {
    /**
     * Both become transactions carrying their own immutable ids, which is what
     * `ProviderTransaction` asks for. This test asserts the adapter hands them
     * over, which was the half Phase 176 could honestly claim — downstream,
     * `importTransactions` used `onConflictDoNothing` and dropped the universal
     * pending→posted transition on the floor.
     *
     * **Phase 177 fixed that half**, and not with `onConflictDoUpdate`:
     * `modules/banking/revisions.ts` applies a revision when nothing has been
     * derived from the stored row and holds it for a person when something has.
     * See `tests/the-transaction-that-changed.test.ts`.
     *
     * This test stays as it was, because what it asserts is the adapter's
     * contribution: the transactions reach the domain. Nothing here knows what
     * the domain does with them, which is the seam working.
     */
    const { plaid } = provider([
      {
        body: {
          added: [plaidTransaction({ transaction_id: 'txn-new' })],
          modified: [
            plaidTransaction({
              transaction_id: 'txn-was-pending',
              amount: 44.1,
              pending: false,
            }),
          ],
          removed: [{ transaction_id: 'txn-retracted' }],
          next_cursor: 'cursor-1',
          has_more: false,
        },
      },
    ])

    const page = await plaid.fetchTransactions(CONNECTED)

    expect(page.transactions.map((t) => t.providerTransactionId)).toEqual([
      'txn-new',
      'txn-was-pending',
    ])
    expect(page.transactions[1].amountCents).toBe(-4410)
    expect(page.transactions[1].pending).toBe(false)

    // `removed` has nowhere to go on `TransactionPage`, so a retracted
    // transaction is not reported. Asserted so the gap is a fact in a test
    // rather than a sentence in a comment.
    expect(page.transactions.map((t) => t.providerTransactionId)).not.toContain('txn-retracted')
  })

  it('ignores the date bounds, which is a promise this endpoint cannot keep', async () => {
    /**
     * `FetchOptions` offers *"inclusive ISO date bounds for a full
     * (non-incremental) pull"* and the mock honours them.
     * `/transactions/sync` is cursor-based and has no date parameters at all.
     *
     * Asserted rather than left implicit because a silently ignored argument is
     * the exact shape this codebase keeps calling dangerous — it reports success
     * and does something else. No caller passes either field today, which is
     * precisely when it is cheap to pin.
     */
    const { plaid, calls } = provider([
      syncPage([plaidTransaction({ date: '2020-01-01' })]),
    ])

    const page = await plaid.fetchTransactions(CONNECTED, {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })

    expect(calls[0].body).not.toHaveProperty('start_date')
    expect(calls[0].body).not.toHaveProperty('end_date')
    // The transaction from 2020 comes back, which is the whole point: the bounds
    // did nothing.
    expect(page.transactions[0].postedDate).toBe('2020-01-01')
  })

  it('keeps the raw payload for audit, and the mapped fields beside it', async () => {
    const { plaid } = provider([
      syncPage([
        plaidTransaction({
          transaction_id: 'txn-1',
          account_id: 'acct-7',
          merchant_name: 'Coffee Shop',
          personal_finance_category: { primary: 'FOOD_AND_DRINK' },
          pending: true,
        }),
      ]),
    ])

    const page = await plaid.fetchTransactions(CONNECTED)

    expect(page.transactions[0]).toMatchObject({
      providerTransactionId: 'txn-1',
      providerAccountId: 'acct-7',
      postedDate: '2026-03-04',
      amountCents: -4250,
      description: 'COFFEE SHOP',
      merchantName: 'Coffee Shop',
      category: 'FOOD_AND_DRINK',
      pending: true,
    })

    // `ProviderTransaction.raw` is *"untouched provider payload, stored for
    // audit and reprocessing"* — the one field that lets a mapping bug be fixed
    // retroactively instead of re-fetched.
    expect(page.transactions[0].raw).toMatchObject({ transaction_id: 'txn-1', amount: 42.5 })
  })
})

describe('what a failure is, and whether to try again', () => {
  it('separates could not take it from understood and said no', async () => {
    /**
     * `notify/providers/http.ts`'s line, which this follows: retrying the first
     * costs seconds, retrying the second repeats a rejected request forever.
     *
     * 400 is the one worth naming. Plaid uses it for `ITEM_LOGIN_REQUIRED` — the
     * single failure a *person* has to fix, by re-authenticating — so retrying
     * it quietly would hide the one thing they need to be told.
     */
    const cases: { status: number; retryable: boolean }[] = [
      { status: 400, retryable: false },
      { status: 401, retryable: false },
      { status: 403, retryable: false },
      { status: 408, retryable: true },
      { status: 429, retryable: true },
      { status: 500, retryable: true },
      { status: 503, retryable: true },
    ]

    for (const { status, retryable } of cases) {
      const { plaid } = provider([{ status, body: { error_code: 'SOME_CODE' } }])

      await plaid
        .fetchTransactions(CONNECTED)
        .then(() => expect.unreachable(`${status} should have thrown`))
        .catch((error: BankProviderError) => {
          expect(error, String(status)).toBeInstanceOf(BankProviderError)
          expect(error.retryable, String(status)).toBe(retryable)
          expect(error.provider).toBe('plaid')
        })
    }
  })

  it('surfaces Plaid’s own error code, which is the actionable part', async () => {
    /**
     * `ITEM_LOGIN_REQUIRED` means re-link. `PRODUCT_NOT_READY` means wait.
     * `INVALID_ACCESS_TOKEN` means look at the configuration. A message that
     * said only "400" would send somebody to read logs for all three.
     */
    const { plaid } = provider([
      {
        status: 400,
        body: {
          error_code: 'ITEM_LOGIN_REQUIRED',
          error_message: 'the login details of this item have changed',
        },
      },
    ])

    await plaid.fetchTransactions(CONNECTED).catch((error: BankProviderError) => {
      expect(error.message).toContain('ITEM_LOGIN_REQUIRED')
      expect(error.message).toContain('the login details of this item have changed')
      expect(error.message).toContain('/transactions/sync')
    })
  })

  it('still classifies a failure whose body is not JSON', async () => {
    // `describeFailure` must not throw while handling a throw. An HTML error
    // page from a load balancer is the realistic case.
    const impl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch

    const plaid = new PlaidBankProvider({ ...CREDENTIALS, fetchImpl: impl })

    await plaid.fetchTransactions(CONNECTED).catch((error: BankProviderError) => {
      expect(error.retryable).toBe(true)
      expect(error.message).toContain('502')
    })
  })

  it('treats a dropped connection as the provider’s problem, not the request’s', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    const plaid = new PlaidBankProvider({ ...CREDENTIALS, fetchImpl: impl })

    await plaid.fetchTransactions(CONNECTED).catch((error: BankProviderError) => {
      expect(error.retryable).toBe(true)
      expect(error.message).toContain('fetch failed')
    })
  })

  it('never puts the secret in a message', async () => {
    /**
     * The credentials go in the request *body*, which means they are in a
     * variable one line away from every error string this adapter builds. A
     * message that echoed the request would put a long-lived bank credential
     * into an audit log, a Sentry event and a screen.
     *
     * Checked against every failure path at once rather than one at a time,
     * because the one that leaks will be the one nobody wrote a test for.
     */
    const secrets = ['test-secret-value', 'test-client', 'access-token-1']

    const paths: (() => Promise<unknown>)[] = [
      () =>
        provider([{ status: 400, body: { error_code: 'INVALID_API_KEYS' } }]).plaid.fetchTransactions(
          CONNECTED,
        ),
      () =>
        provider([{ status: 500, body: { error_code: 'INTERNAL' } }]).plaid.listAccounts(CONNECTED),
      () =>
        provider([{ status: 400, body: {} }]).plaid.createLinkSession('company-1'),
      () =>
        new PlaidBankProvider({
          ...CREDENTIALS,
          fetchImpl: (async () => {
            throw new Error('socket hang up')
          }) as unknown as typeof fetch,
        }).fetchTransactions(CONNECTED),
    ]

    for (const path of paths) {
      await path()
        .then(() => expect.unreachable('this path should have failed'))
        .catch((error: Error) => {
          for (const secret of secrets) {
            expect(error.message, secret).not.toContain(secret)
          }
        })
    }
  })
})

describe('the registry, now that it has two adapters', () => {
  beforeEach(() => {
    delete process.env.BANK_PROVIDER
  })

  it('registers both and still defaults to the mock', () => {
    // Measured, not bounded (Phase 126).
    expect(registeredProviderKeys()).toEqual(['mock', 'plaid'])
    expect(getBankProvider().key).toBe('mock')
    expect(getBankProvider('mock').key).toBe('mock')
  })

  it('builds an adapter only when it is selected', () => {
    /**
     * The registry held `registerProvider(new MockBankProvider())` for 174
     * phases, which works for exactly as long as every adapter constructs with
     * no configuration. `PlaidBankProvider`'s constructor throws without its
     * secrets — on purpose — so eager construction would have thrown on
     * *import*, in every deployment and all 4,200 tests, because of an adapter
     * nobody selected.
     *
     * This test is the proof the import is clean: it ran, which means
     * `registry.ts` loaded without Plaid credentials in the environment.
     */
    const saved = { id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET }
    delete process.env.PLAID_CLIENT_ID
    delete process.env.PLAID_SECRET

    try {
      // Selecting it unconfigured refuses, where somebody is looking.
      expect(() => getBankProvider('plaid')).toThrow(BankProviderError)
      // And the mock is unaffected, which is the whole point of lazy building.
      expect(getBankProvider('mock').key).toBe('mock')
    } finally {
      if (saved.id !== undefined) process.env.PLAID_CLIENT_ID = saved.id
      if (saved.secret !== undefined) process.env.PLAID_SECRET = saved.secret
    }
  })

  it('refuses an unregistered key with a registry error, not a bare one', () => {
    /**
     * ADR 0074's half that does not move: an undeclared key is a defect in this
     * repository or a typo in a deployment variable, and the sentence names
     * files to go and edit. `RegistryError` does not extend `DomainError`, so it
     * is never shown to the person whose books are being synced.
     *
     * The path that makes this more than a typo check: `bank_connections.provider`
     * is a stored string, so a connection written by an adapter that was later
     * retired lands here too.
     */
    expect(() => getBankProvider('yodlee')).toThrow(RegistryError)

    try {
      getBankProvider('yodlee')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('BANK_PROVIDERS')
      expect((error as RegistryError).key).toBe('yodlee')
      expect((error as RegistryError).message).toContain('mock, plaid')
      expect((error as RegistryError).message).toContain('bank_connections.provider')
    }
  })
})
