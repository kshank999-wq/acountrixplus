import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export * as schema from './schema'

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and set a PostgreSQL connection string.',
    )
  }
  return url
}

/**
 * The postgres-js client is cached on globalThis so Next.js hot reloads in
 * development reuse one pool instead of opening a new one on every edit.
 */
const globalForDb = globalThis as unknown as {
  __accountrixSql?: ReturnType<typeof postgres>
}

function client() {
  if (!globalForDb.__accountrixSql) {
    globalForDb.__accountrixSql = postgres(connectionString(), { max: 10 })
  }
  return globalForDb.__accountrixSql
}

/**
 * Application database handle.
 *
 * Prefer the tenant-scoped helpers in `modules/tenancy` over reaching for this
 * directly — every business-domain query must be filtered by company id
 * (spec §19), and those helpers make that structural rather than a thing each
 * call site has to remember.
 */
export const db = drizzle(client(), { schema })

export type Database = typeof db
/** A `db` handle or an open transaction — services accept either. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]
