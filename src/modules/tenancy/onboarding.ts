import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies, memberships, users } from '@/db/schema'
import { hashPassword } from '@/modules/auth/password'
import { installChartOfAccounts } from '@/modules/coa/service'
import { industryPack, type Industry } from '@/modules/coa/industry'
import { recordAudit } from '@/modules/audit'
import type { ActorContext } from './context'
import type { Role } from '@/modules/permissions'

export type RegisterInput = {
  companyName: string
  industry: Industry
  userName: string
  email: string
  password: string
}

/**
 * Registers a company and its first user (spec §22: "a new company can
 * register/onboard and select an industry", and "a standard chart of accounts
 * is created automatically").
 *
 * The whole thing runs in one transaction, so a failure part-way cannot leave
 * a company without a chart of accounts or an owner.
 */
export async function registerCompany(input: RegisterInput) {
  const email = input.email.trim().toLowerCase()

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (existing) {
    throw new Error('An account with that email already exists.')
  }

  const passwordHash = await hashPassword(input.password)

  return db.transaction(async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({ name: input.companyName, industry: input.industry })
      .returning()

    const [user] = await tx
      .insert(users)
      .values({ email, name: input.userName, passwordHash })
      .returning()

    await tx.insert(memberships).values({
      companyId: company.id,
      userId: user.id,
      role: 'owner',
    })

    const accountsCreated = await installChartOfAccounts(company.id, input.industry, tx)

    // The founding actor, so the creation events are attributable like any
    // other change (spec §22: every change is attributable to a user).
    const ctx: ActorContext = {
      userId: user.id,
      userName: user.name,
      companyId: company.id,
      role: 'owner',
    }

    await recordAudit(
      ctx,
      {
        action: 'company.create',
        entityType: 'company',
        entityId: company.id,
        after: {
          name: company.name,
          industry: company.industry,
          accountsCreated,
          modules: industryPack(input.industry).modules,
        },
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'membership.create',
        entityType: 'membership',
        entityId: user.id,
        after: { email: user.email, role: 'owner' },
      },
      tx,
    )

    return { company, user, accountsCreated }
  })
}

/**
 * Adds an existing user to a company (spec §14: invite each professional with
 * their own account rather than sharing credentials).
 */
export async function addMember(
  ctx: ActorContext,
  input: { email: string; name: string; password: string; role: Role },
) {
  const email = input.email.trim().toLowerCase()

  return db.transaction(async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1)

    if (!user) {
      const passwordHash = await hashPassword(input.password)
      ;[user] = await tx
        .insert(users)
        .values({ email, name: input.name, passwordHash })
        .returning()
    }

    const [membership] = await tx
      .insert(memberships)
      .values({ companyId: ctx.companyId, userId: user.id, role: input.role })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'membership.create',
        entityType: 'membership',
        entityId: membership.id,
        after: { email, role: input.role },
      },
      tx,
    )

    return { user, membership }
  })
}

/** Companies a user can act within, for the company switcher. */
export async function companiesForUser(userId: string) {
  return db
    .select({
      companyId: companies.id,
      companyName: companies.name,
      industry: companies.industry,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(eq(memberships.userId, userId))
}
