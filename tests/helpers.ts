import { db } from '@/db'
import { bankTransactions, financialAccounts, chartAccounts } from '@/db/schema'
import { registerCompany } from '@/modules/tenancy/onboarding'
import { addMember } from '@/modules/tenancy/onboarding'
import type { ActorContext } from '@/modules/tenancy/context'
import type { Industry } from '@/modules/coa/industry'
import type { Role } from '@/modules/permissions'
import { and, eq } from 'drizzle-orm'

let uniqueCounter = 0
/** Unique email per call, so parallel fixtures never collide. */
function nextEmail(prefix: string) {
  uniqueCounter += 1
  return `${prefix}-${uniqueCounter}@example.test`
}

/**
 * The modules whose list function takes `activeOnly` **opt-in** (Phase 207).
 *
 * One list with one home, read by both `a-retirement-with-no-way-back` and
 * `a-name-is-not-a-function`. Two phases counting one class in two files is
 * what sent the full run red twice in this run of phases — once on the switch
 * register in Phases 204/205 and once on this very count in 206/207 — and the
 * first attempt at fixing it imported one test file from the other, which
 * re-registered twelve suites and ran them twice.
 *
 * Here because it is test vocabulary rather than application vocabulary: the
 * application does not care which of its list functions has the unsafe
 * default, and a register in `src/modules/source` would be a throw site and a
 * count to maintain for a sentence only tests read.
 */
export const OPT_IN_CANDIDATES = [
  'src/modules/coa/service.ts',
  'src/modules/banking/accounts.ts',
  'src/modules/payroll/service.ts',
  'src/modules/payroll/sales-tax.ts',
  'src/modules/jobs/cost-codes.ts',
  'src/modules/jobs/compliance.ts',
] as const

export type Fixture = {
  ctx: ActorContext
  companyId: string
  userId: string
  financialAccountId: string
  /** Looks up one of the company's accounts by number. */
  account: (number: string) => Promise<{ id: string; name: string }>
}

/**
 * Creates a fully onboarded company: owner user, chart of accounts, and one
 * checking account ready to receive transactions.
 */
export async function createCompanyFixture(
  opts: { name?: string; industry?: Industry; role?: Role } = {},
): Promise<Fixture> {
  const { company, user } = await registerCompany({
    companyName: opts.name ?? 'Test Co',
    industry: opts.industry ?? 'general',
    userName: 'Owner User',
    email: nextEmail('owner'),
    password: 'correct-horse-battery',
  })

  const ctx: ActorContext = {
    userId: user.id,
    userName: user.name,
    companyId: company.id,
    role: opts.role ?? 'owner',
  }

  const [checking] = await db
    .select()
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, company.id), eq(chartAccounts.number, '1000')))
    .limit(1)

  const [financialAccount] = await db
    .insert(financialAccounts)
    .values({
      companyId: company.id,
      chartAccountId: checking.id,
      name: 'Business Checking',
      mask: '4471',
      kind: 'checking',
      providerAccountId: 'test-checking-001',
    })
    .returning()

  return {
    ctx,
    companyId: company.id,
    userId: user.id,
    financialAccountId: financialAccount.id,
    account: async (number: string) => {
      const [row] = await db
        .select()
        .from(chartAccounts)
        .where(and(eq(chartAccounts.companyId, company.id), eq(chartAccounts.number, number)))
        .limit(1)
      if (!row) throw new Error(`No account ${number} for this company`)
      return row
    },
  }
}

/** Adds a second user to an existing company with a given role. */
export async function addUserWithRole(fixture: Fixture, role: Role): Promise<ActorContext> {
  const { user } = await addMember(fixture.ctx, {
    email: nextEmail(role),
    name: `${role} user`,
    password: 'correct-horse-battery',
    role,
  })

  return {
    userId: user.id,
    userName: user.name,
    companyId: fixture.companyId,
    role,
  }
}

/** Inserts a bank transaction directly, bypassing the provider. */
export async function insertTransaction(
  fixture: Fixture,
  input: {
    providerTransactionId?: string
    amountCents: number
    description: string
    merchantName?: string
    postedDate?: string
  },
) {
  const [row] = await db
    .insert(bankTransactions)
    .values({
      companyId: fixture.companyId,
      financialAccountId: fixture.financialAccountId,
      providerTransactionId: input.providerTransactionId ?? `tx-${++uniqueCounter}`,
      postedDate: input.postedDate ?? '2026-08-01',
      amountCents: input.amountCents,
      description: input.description,
      merchantName: input.merchantName ?? null,
    })
    .returning()

  return row
}
