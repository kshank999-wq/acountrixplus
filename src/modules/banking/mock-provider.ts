import { createHash } from 'node:crypto'
import type {
  BankProvider,
  ExchangeResult,
  FetchOptions,
  LinkSession,
  ProviderAccount,
  ProviderTransaction,
  TransactionPage,
} from './provider'

/**
 * In-memory bank provider used for development, demos, and tests (spec §21:
 * build the vertical slice on mocked bank data first).
 *
 * Generation is fully deterministic — the same `providerItemId` always yields
 * the same transactions with the same ids. That is what lets the dedup tests
 * assert that a re-import inserts nothing new, and it keeps demos stable.
 */

/**
 * Small deterministic PRNG (mulberry32). Seeded from a string so each
 * connection gets its own reproducible stream.
 */
function seededRandom(seed: string): () => number {
  const hash = createHash('sha256').update(seed).digest()
  let state = hash.readUInt32LE(0)

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Recurring merchants. These repeat every month so the rules engine and
 * vendor-memory features have realistic material to work with — a demo where
 * every transaction is unique would never exercise them.
 */
const RECURRING_MERCHANTS = [
  { name: 'Shell Oil', description: 'SHELL OIL 574839', cents: -6_240, category: 'Gas' },
  { name: 'Verizon Wireless', description: 'VERIZON WIRELESS PMT', cents: -18_500, category: 'Telecom' },
  { name: 'State Farm Insurance', description: 'STATE FARM INS PREM', cents: -42_700, category: 'Insurance' },
  { name: 'Adobe', description: 'ADOBE CREATIVE CLOUD', cents: -5_999, category: 'Software' },
  { name: 'Costco Wholesale', description: 'COSTCO WHSE #1042', cents: -21_450, category: 'Supplies' },
  { name: 'City Power & Light', description: 'CITY POWER LIGHT AUTOPAY', cents: -31_800, category: 'Utilities' },
  { name: 'Northgate Properties', description: 'NORTHGATE PROP RENT', cents: -185_000, category: 'Rent' },
]

/** One-off merchants, sampled randomly for variety. */
const OCCASIONAL_MERCHANTS = [
  { name: 'Home Depot', description: 'HOME DEPOT #6612', min: 2_100, max: 84_000, category: 'Materials' },
  { name: 'Amazon', description: 'AMZN MKTP US*2K4LM', min: 1_500, max: 32_000, category: 'Supplies' },
  { name: 'Starbucks', description: 'STARBUCKS STORE 08812', min: 450, max: 2_800, category: 'Meals' },
  { name: 'United Airlines', description: 'UNITED AIRLINES 0162', min: 18_000, max: 92_000, category: 'Travel' },
  { name: 'Staples', description: 'STAPLES 00114', min: 1_200, max: 14_500, category: 'Office' },
  { name: 'Uber', description: 'UBER TRIP 8H2K', min: 900, max: 6_400, category: 'Travel' },
  { name: "Luigi's Deli", description: 'LUIGIS DELI 4471', min: 1_100, max: 8_900, category: 'Meals' },
  { name: 'FedEx', description: 'FEDEX 771204558', min: 1_800, max: 22_000, category: 'Shipping' },
]

/** Customer deposits, so the feed is not all spending. */
const DEPOSIT_SOURCES = [
  { name: 'Harborview LLC', description: 'ACH DEPOSIT HARBORVIEW LLC', min: 120_000, max: 850_000 },
  { name: 'First Capital Group', description: 'ACH DEPOSIT FIRST CAPITAL', min: 95_000, max: 620_000 },
  { name: 'Stripe', description: 'STRIPE TRANSFER', min: 25_000, max: 310_000 },
]

const MOCK_ACCOUNTS: ProviderAccount[] = [
  {
    providerAccountId: 'mock-checking-001',
    name: 'Business Checking',
    mask: '4471',
    kind: 'checking',
    currency: 'USD',
    currentBalanceCents: 1_842_355,
    availableBalanceCents: 1_792_355,
  },
  {
    providerAccountId: 'mock-savings-002',
    name: 'Business Savings',
    mask: '9928',
    kind: 'savings',
    currency: 'USD',
    currentBalanceCents: 5_120_000,
    availableBalanceCents: 5_120_000,
  },
  {
    providerAccountId: 'mock-card-003',
    name: 'Business Credit Card',
    mask: '2210',
    kind: 'credit_card',
    currency: 'USD',
    currentBalanceCents: -428_190,
    availableBalanceCents: 1_571_810,
  },
]

export type MockProviderOptions = {
  /** How many months of history to generate. */
  months?: number
  /**
   * Anchor date for generation, so tests are not time-dependent.
   * Defaults to today.
   */
  referenceDate?: Date
}

export class MockBankProvider implements BankProvider {
  readonly key = 'mock'

  constructor(private readonly options: MockProviderOptions = {}) {}

  async createLinkSession(companyId: string): Promise<LinkSession> {
    return {
      linkToken: `mock-link-${companyId}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }
  }

  async exchangePublicToken(publicToken: string): Promise<ExchangeResult> {
    return {
      providerItemId: `mock-item-${publicToken}`,
      institutionName: 'First Community Bank (Sandbox)',
    }
  }

  async listAccounts(_providerItemId: string): Promise<ProviderAccount[]> {
    return MOCK_ACCOUNTS.map((account) => ({ ...account }))
  }

  async fetchTransactions(
    providerItemId: string,
    options: FetchOptions = {},
  ): Promise<TransactionPage> {
    const months = this.options.months ?? 3
    const reference = this.options.referenceDate ?? new Date()
    const transactions: ProviderTransaction[] = []

    for (const account of MOCK_ACCOUNTS) {
      // Savings sees very little activity; skip it to keep the demo realistic.
      if (account.kind === 'savings') continue
      transactions.push(
        ...this.generateForAccount(providerItemId, account, months, reference),
      )
    }

    const filtered = transactions.filter((t) => {
      if (options.startDate && t.postedDate < options.startDate) return false
      if (options.endDate && t.postedDate > options.endDate) return false
      return true
    })

    filtered.sort((a, b) =>
      a.postedDate === b.postedDate
        ? a.providerTransactionId.localeCompare(b.providerTransactionId)
        : b.postedDate.localeCompare(a.postedDate),
    )

    return {
      transactions: filtered,
      nextCursor: `mock-cursor-${filtered.length}`,
      hasMore: false,
    }
  }

  private generateForAccount(
    itemId: string,
    account: ProviderAccount,
    months: number,
    reference: Date,
  ): ProviderTransaction[] {
    const random = seededRandom(`${itemId}:${account.providerAccountId}`)
    const out: ProviderTransaction[] = []

    for (let monthOffset = months - 1; monthOffset >= 0; monthOffset--) {
      const monthStart = new Date(
        Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - monthOffset, 1),
      )
      const daysInMonth = new Date(
        Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
      ).getUTCDate()

      // Recurring charges land on a stable day each month, which is exactly
      // the pattern vendor memory is meant to detect.
      RECURRING_MERCHANTS.forEach((merchant, index) => {
        const day = Math.min(3 + index * 4, daysInMonth)
        const date = isoDate(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day)
        if (date > isoDateOf(reference)) return

        // Cards carry the subscriptions; checking carries the big bills.
        const onCard = account.kind === 'credit_card'
        const isBigBill = Math.abs(merchant.cents) > 100_000
        if (onCard === isBigBill) return

        out.push({
          providerTransactionId: stableId(itemId, account.providerAccountId, date, merchant.name),
          providerAccountId: account.providerAccountId,
          postedDate: date,
          // Small deterministic drift so amounts are not suspiciously identical.
          amountCents: merchant.cents - Math.floor(random() * 400),
          description: merchant.description,
          merchantName: merchant.name,
          category: merchant.category,
          pending: false,
          raw: { source: 'mock', recurring: true },
        })
      })

      const occasionalCount = 6 + Math.floor(random() * 6)
      for (let i = 0; i < occasionalCount; i++) {
        const merchant = OCCASIONAL_MERCHANTS[Math.floor(random() * OCCASIONAL_MERCHANTS.length)]
        const day = 1 + Math.floor(random() * daysInMonth)
        const date = isoDate(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day)
        if (date > isoDateOf(reference)) continue

        out.push({
          providerTransactionId: stableId(
            itemId,
            account.providerAccountId,
            date,
            `${merchant.name}-${i}`,
          ),
          providerAccountId: account.providerAccountId,
          postedDate: date,
          amountCents: -(merchant.min + Math.floor(random() * (merchant.max - merchant.min))),
          description: merchant.description,
          merchantName: merchant.name,
          category: merchant.category,
          // The most recent few days are still settling.
          pending: daysAgo(date, reference) <= 2,
          raw: { source: 'mock', recurring: false },
        })
      }

      // Deposits only land in checking.
      if (account.kind === 'checking') {
        const depositCount = 2 + Math.floor(random() * 3)
        for (let i = 0; i < depositCount; i++) {
          const source = DEPOSIT_SOURCES[Math.floor(random() * DEPOSIT_SOURCES.length)]
          const day = 1 + Math.floor(random() * daysInMonth)
          const date = isoDate(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day)
          if (date > isoDateOf(reference)) continue

          out.push({
            providerTransactionId: stableId(
              itemId,
              account.providerAccountId,
              date,
              `deposit-${source.name}-${i}`,
            ),
            providerAccountId: account.providerAccountId,
            postedDate: date,
            amountCents: source.min + Math.floor(random() * (source.max - source.min)),
            description: source.description,
            merchantName: source.name,
            category: 'Deposit',
            pending: false,
            raw: { source: 'mock', deposit: true },
          })
        }
      }
    }

    return out
  }
}

/**
 * Deterministic transaction id. Built from the connection, account, date, and
 * merchant so regenerating the same feed reproduces the same ids exactly —
 * which is what makes re-import a genuine no-op.
 */
function stableId(itemId: string, accountId: string, date: string, label: string): string {
  return createHash('sha1')
    .update(`${itemId}|${accountId}|${date}|${label}`)
    .digest('hex')
    .slice(0, 24)
}

function isoDate(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10)
}

function isoDateOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function daysAgo(isoDateString: string, reference: Date): number {
  const then = Date.parse(`${isoDateString}T00:00:00Z`)
  const now = Date.parse(`${isoDateOf(reference)}T00:00:00Z`)
  return Math.round((now - then) / 86_400_000)
}
