/**
 * Applies pending SQL migrations from ./drizzle.
 *
 * Run with `npm run db:migrate`. Uses a dedicated single connection that is
 * closed on completion so the process exits rather than hanging on the pool.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
    process.exit(1)
  }

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
