import { beforeEach } from 'vitest'

/**
 * Points the application's database handle at the test database.
 *
 * This must happen before anything imports `@/db`, which reads DATABASE_URL at
 * module load. Vitest evaluates setup files first, so assigning here is
 * sufficient.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/accountrix_test'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { db } = await import('@/db')
const { sql } = await import('drizzle-orm')

/**
 * Truncates every domain table between tests so each one starts from a known
 * empty database. CASCADE handles the foreign-key ordering.
 */
beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      audit_events,
      transaction_splits,
      bank_transactions,
      categorization_rules,
      financial_accounts,
      bank_connections,
      chart_accounts,
      sessions,
      memberships,
      companies,
      users
    RESTART IDENTITY CASCADE
  `)
})
