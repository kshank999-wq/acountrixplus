/**
 * Applies pending SQL migrations from ./drizzle.
 *
 * Run with `npm run db:migrate`. Uses a dedicated single connection that is
 * closed on completion so the process exits rather than hanging on the pool.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/**
 * Migrations must not run through a *transaction*-mode pooler.
 *
 * The migrator wraps its work in a transaction and relies on the same backend
 * throughout. PgBouncer in transaction mode is free to hand each statement a
 * different backend, so a half-applied migration is a real outcome — and a
 * half-applied migration on an accounting database is about the worst thing in
 * this repository.
 *
 * Refused rather than worked around, because the fix is trivial and specific:
 * Supabase's *session* pooler is the same host on port **5432**, holds one
 * backend for the connection, and is correct for DDL. The transaction pooler on
 * 6543 is for the application, which is short-lived and does not do DDL.
 */
function refuseTransactionPooler(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }

  const transactionMode =
    parsed.port === '6543' || parsed.searchParams.get('pgbouncer') === 'true'

  if (!transactionMode) return

  const session = new URL(url)
  session.port = '5432'
  session.searchParams.delete('pgbouncer')

  console.error(
    [
      'Refusing to migrate through a transaction-mode connection pooler.',
      '',
      'The migrator needs one backend for the whole transaction, and a',
      'transaction pooler does not promise that — a half-applied migration is a',
      'possible outcome.',
      '',
      'Use the session pooler instead (same host, port 5432):',
      `  ${session.toString()}`,
      '',
      'Point DATABASE_URL at that for the migration, and leave your deployed',
      'application on 6543.',
    ].join('\n'),
  )
  process.exit(1)
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
    process.exit(1)
  }

  refuseTransactionPooler(url)

  const sql = postgres(url, { max: 1 })
  try {
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
    console.log('Migrations applied.')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
